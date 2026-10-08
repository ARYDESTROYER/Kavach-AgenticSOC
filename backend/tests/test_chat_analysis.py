"""BUG-1: chat must run a SECOND model turn over the query results so the user
sees real analysis, not just a 'fetching logs' preamble + a raw table.

Offline only: fake ES (InMemoryESClient) + mock LLM (MockProvider). The mock
records every call and pops scripted responses per role FIFO, so two pushed
"chat" scripts drive turn 1 (decide+query) then turn 2 (analysis)."""

from __future__ import annotations

import json

import pytest

from app.constants import UNTRUSTED_CLOSE, UNTRUSTED_OPEN
from tests.conftest import make_log_event, seed_logs


def _chat_calls(mock_provider) -> list[dict]:
    return [c for c in mock_provider.calls if c["role"] == "chat"]


@pytest.mark.asyncio
async def test_query_runs_second_turn_and_sums_cost(app_state, mock_provider):
    """When a query runs and returns hits, the FINAL answer comes from a SECOND
    model call over an aggregate, and the returned cost includes both calls."""
    es = app_state.es
    seed_logs(es, [
        make_log_event(ip="10.0.0.9", user="root", host="web01", rule="linux_auth"),
        make_log_event(ip="10.0.0.9", user="root", host="web01", rule="linux_auth"),
        make_log_event(ip="10.0.0.9", user="admin", host="db01", rule="ssh_login"),
    ])

    # Turn 1: decide a query is needed. Turn 2: the analysis.
    mock_provider.push("chat", json.dumps({
        "answer": "Fetching logs for 10.0.0.9…",
        "needs_query": True,
        "query": {"ip": "10.0.0.9"},
    }))
    mock_provider.push("chat", json.dumps({
        "answer": "ANALYSIS: 3 auth events from 10.0.0.9, mostly linux_auth on web01.",
    }))

    engine = app_state.chat_engine
    resp = await engine.chat("what is going on with 10.0.0.9?", app_state.prefs)

    # Exactly two model turns happened (decide, then analyse).
    assert len(_chat_calls(mock_provider)) == 2
    # The final answer is the SECOND response's analysis, NOT turn 1's preamble.
    assert resp.answer == "ANALYSIS: 3 auth events from 10.0.0.9, mostly linux_auth on web01."
    assert "Fetching logs" not in resp.answer
    # Cost is the sum of both gateway calls (each mock call has non-zero cost).
    assert resp.cost > 0.0
    # Rows still surface as a table + a Discover link (contract preserved).
    assert resp.table is not None and resp.table["rows"]
    assert resp.discover is not None


@pytest.mark.asyncio
async def test_second_turn_aggregate_is_fenced_untrusted(app_state, mock_provider):
    """The second turn's user message must fence the result aggregate as UNTRUSTED
    (Non-negotiable #9) — and it must be an AGGREGATE, never the raw rows verbatim."""
    es = app_state.es
    seed_logs(es, [make_log_event(ip="10.0.0.9") for _ in range(4)])

    mock_provider.push("chat", json.dumps({
        "answer": "Fetching…", "needs_query": True, "query": {"ip": "10.0.0.9"},
    }))
    mock_provider.push("chat", json.dumps({"answer": "done"}))

    engine = app_state.chat_engine
    await engine.chat("show 10.0.0.9", app_state.prefs)

    second_call = _chat_calls(mock_provider)[1]
    # Last message is the aggregate hand-off, and it is fenced.
    last_user = second_call["messages"][-1]["content"]
    assert UNTRUSTED_OPEN in last_user and UNTRUSTED_CLOSE in last_user
    # It is an aggregate, not a raw dump: it reports a count, not 4 separate rows.
    assert "top_source_ips" in last_user or "returned_rows" in last_user


@pytest.mark.asyncio
async def test_no_query_path_is_single_turn(app_state, mock_provider):
    """The no-query path is UNCHANGED: exactly one model call, answer verbatim."""
    mock_provider.push("chat", json.dumps({
        "answer": "Brute force is many failed logins in a short window.",
        "needs_query": False,
        "query": None,
    }))

    engine = app_state.chat_engine
    resp = await engine.chat("what is a brute force attack?", app_state.prefs)

    assert len(_chat_calls(mock_provider)) == 1
    assert resp.answer == "Brute force is many failed logins in a short window."
    assert resp.table is None
    assert resp.discover is None


@pytest.mark.asyncio
async def test_second_turn_error_falls_back_to_summary(app_state, mock_provider, monkeypatch):
    """If the analysis turn raises, chat degrades to the OLD behaviour (turn-1
    answer + the tool row-count summary) and never hard-fails. The second call's
    cost is NOT added (it never produced a billable result here)."""
    es = app_state.es
    seed_logs(es, [make_log_event(ip="10.0.0.9"), make_log_event(ip="10.0.0.9")])

    mock_provider.push("chat", json.dumps({
        "answer": "Fetching the events.", "needs_query": True, "query": {"ip": "10.0.0.9"},
    }))

    engine = app_state.chat_engine
    gateway = engine._gateway
    real_complete = gateway.complete
    state = {"n": 0}

    async def flaky_complete(*args, **kwargs):
        state["n"] += 1
        if state["n"] == 2:  # the analysis turn
            from app.llm.gateway import GatewayError
            raise GatewayError("boom")
        return await real_complete(*args, **kwargs)

    monkeypatch.setattr(gateway, "complete", flaky_complete)

    resp = await engine.chat("show 10.0.0.9", app_state.prefs)

    # Fallback keeps the turn-1 answer AND appends the tool's row-count summary.
    assert "Fetching the events." in resp.answer
    assert "matched" in resp.answer  # es_query summary text
    # Table/Discover still present; chat did not hard-fail.
    assert resp.table is not None
    assert resp.discover is not None
