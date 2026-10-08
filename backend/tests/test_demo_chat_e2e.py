"""End-to-end Demo Mode chat (chat revamp SPEC §5.5, §10.5).

Runs the REAL ``ChatEngine`` agent loop over a seeded Demo stack: the demo gateway
(``DemoMockProvider`` delegating to ``engine.demo_chat``), the demo stores, the five
demo log sources and the demo RAG, with the tool context built by the one route
builder (``AppState.build_chat_tool_context``). For every empty-state starter it
checks that several lookups ran, that blocks were materialised from artifacts (and
agree with the numbers in the prose), that usage is metered as simulated at $0, and
that two runs produce byte-identical answers. It also covers Live text, a restricted
role, the replay-based follow-ups ("break that down by user", "as a table", "same for
the last 48 hours") and the report summary through the demo gateway.
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio

import app.llm.providers as providers
from app.agents.chat_events import TextDeltaEvent, TurnDoneEvent
from app.agents.chat_protocol import PriorExchange, parse_report_summary
from app.agents.chat_tools.registry import build_toolbox, catalogue_grant_pairs
from app.constants import Role
from app.engine.demo_chat import DEMO_STARTERS
from app.models import ChatRequest, ChatResponse
from tests.test_chat_tools_support import build_demo_state, demo_context

STARTERS = {s.id: s for s in DEMO_STARTERS}
EXPECTED_KIND = {"investigate": "data", "hunt": "data", "posture": "data", "shift_brief": "data",
                 "explain_metric": "mixed", "learn_app": "product_help"}


@pytest_asyncio.fixture
async def demo_state(monkeypatch: pytest.MonkeyPatch):
    # Live text types out in word groups with a small delay; tests run it at 0 ms.
    monkeypatch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    state = await build_demo_state()
    yield state
    await state.shutdown()


def _request(state: Any) -> Any:
    """The request surface ``build_chat_tool_context`` reads (auth is off here)."""
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(tlsoc=state)), cookies={}, headers={})


async def _context(state: Any, question: str, grants: frozenset[tuple[str, str]]) -> Any:
    builder = getattr(state, "build_chat_tool_context", None)
    if builder is None:  # the route builder is the contract; the helper mirrors it
        return demo_context(state, grants=grants)
    return await builder(_request(state), ChatRequest(message=question), grants=grants)


async def _turn(state: Any, question: str, *, grants: frozenset[tuple[str, str]] | None = None,
                origin: str = "starter", prior: list[PriorExchange] | None = None) -> ChatResponse:
    grants = catalogue_grant_pairs() if grants is None else grants
    ctx = await _context(state, question, grants)
    return await state.chat_engine.chat(question, state.execution_prefs, tool_context=ctx, origin=origin,
                                        prior_exchanges=prior)


def _tool_steps(response: ChatResponse) -> list[Any]:
    return [s for s in response.steps if s.kind == "tool"]


def _shape(response: ChatResponse) -> dict[str, Any]:
    """Everything deterministic about a response (block timestamps are not)."""
    return {
        "answer": response.answer,
        "steps": [(s.tool, s.params, s.status, s.summary) for s in _tool_steps(response)],
        "blocks": [(b.get("id"), b.get("type"), b.get("kind"), b.get("title"), b.get("artifact_kind"))
                   for b in response.blocks],
        "follow_ups": response.follow_ups,
        "citations": [c.id for c in response.citations],
        "links": [link.id for link in response.console_links],
        "answer_kind": response.answer_kind,
    }


def _prior(question: str, response: ChatResponse, index: int) -> PriorExchange:
    return PriorExchange(user=question, answer=response.answer, message_id=f"msg-{index}",
                         steps=tuple(s.model_dump(mode="json") for s in response.steps),
                         blocks=tuple(response.blocks))


def _block(response: ChatResponse, **match: Any) -> dict[str, Any]:
    for block in response.blocks:
        if all(block.get(k) == v for k, v in match.items()):
            return block
    raise AssertionError(f"no block matching {match}: {[(b.get('type'), b.get('title')) for b in response.blocks]}")


async def test_every_demo_starter_runs_a_multi_lookup_turn_deterministically(demo_state) -> None:
    for starter in DEMO_STARTERS:
        first = await _turn(demo_state, starter.prompt)
        second = await _turn(demo_state, starter.prompt)
        steps = _tool_steps(first)
        assert len(steps) >= 2, (starter.id, steps)
        assert all(s.status == "ok" for s in steps), (starter.id, [(s.tool, s.status, s.summary) for s in steps])
        assert {s.tool for s in steps} <= set(starter.tools), starter.id
        assert first.blocks, starter.id
        assert first.notice is None, (starter.id, first.notice)
        assert first.answer_kind == EXPECTED_KIND[starter.id]
        assert len(first.follow_ups) == 3 and starter.prompt not in first.follow_ups
        # Metered through the ONE gateway: simulated, $0 real pricing (#6, SPEC §1).
        assert first.usage is not None and first.usage.calls >= 2
        assert first.usage.simulated is True and first.usage.pricing_source == "zero"
        assert first.usage.total_tokens > 0
        # Deterministic: the same question over the same data gives the same bytes.
        assert _shape(first) == _shape(second), starter.id


async def test_starter_blocks_carry_the_numbers_the_answer_states(demo_state) -> None:
    posture = await _turn(demo_state, STARTERS["posture"].prompt)
    kpis = _block(posture, type="kpi_group")
    ari = next(i for i in kpis["items"] if i["key"] == "active_risk_index")
    assert ari.get("display") == "gauge" and kpis["provenance"] == "code"
    assert f"**Active Risk Index {int(round(ari['value']))}**" in posture.answer
    line = _block(posture, type="chart", kind="line")
    new_cases = int(round(sum(v for v in line["series"][0]["values"] if v is not None)))
    assert f"{new_cases:,} new and" in posture.answer

    explain = await _turn(demo_state, STARTERS["explain_metric"].prompt)
    funnel = _block(explain, type="chart", kind="funnel")
    ingested = int(round(funnel["series"][0]["values"][0]))
    assert f"{ingested:,} alerts ingested" in explain.answer
    assert explain.citations and all(c.kind == "doc" for c in explain.citations)

    hunt = await _turn(demo_state, STARTERS["hunt"].prompt)
    lookup = next(s for s in _tool_steps(hunt) if s.tool == "lookup_indicator")
    # The indicator came from the case entity (code evidence), so the taint rule let
    # a starter-origin turn look it up (SPEC §4.8.3).
    assert lookup.status == "ok"
    entity = _block(hunt, type="entity", title="Indicator reputation")
    assert f"scores {int(round(entity['risk']))}/100" in hunt.answer

    shift = await _turn(demo_state, STARTERS["shift_brief"].prompt)
    brief = _block(shift, type="report")
    assert brief["template"] == "shift"
    assert [s["heading"] for s in brief["sections"]] == ["Summary", "Open work", "Key metrics", "Next steps"]
    headline = next(b for s in brief["sections"] for b in s["blocks"] if b.get("type") == "kpi_group")
    open_cases = next(i for i in headline["items"] if i["key"] == "open")
    assert f"**{int(open_cases['value'])} open case" in shift.answer


async def test_live_text_streams_the_final_body_in_word_groups(demo_state) -> None:
    prompt = STARTERS["posture"].prompt
    ctx = await _context(demo_state, prompt, catalogue_grant_pairs())
    deltas: list[str] = []
    done: ChatResponse | None = None
    async for event in demo_state.chat_engine.run_turn(
            prompt, demo_state.execution_prefs, tool_context=ctx, origin="starter", stream_mode="text"):
        if isinstance(event, TextDeltaEvent):
            deltas.append(event.text)
        elif isinstance(event, TurnDoneEvent):
            done = event.response
    assert done is not None and done.stream_mode == "text"
    assert len(deltas) > 3 and "".join(deltas).strip() == done.answer
    assert "---ANSWER---" not in "".join(deltas) and '"action"' not in "".join(deltas)


async def test_a_restricted_role_gets_coherent_answers_from_granted_tools_only(demo_state) -> None:
    grants = frozenset({("cases", "read")})
    ctx = await _context(demo_state, "x", grants)
    granted = set(build_toolbox(ctx).names())
    assert "soc_metrics" not in granted and "log_stats" not in granted
    for starter_id, missing in (("posture", "SOC metrics (needs metrics:view)"),
                                ("investigate", "log statistics (needs sources:read)")):
        prompt = STARTERS[starter_id].prompt
        first = await _turn(demo_state, prompt, grants=grants)
        second = await _turn(demo_state, prompt, grants=grants)
        steps = _tool_steps(first)
        assert steps and {s.tool for s in steps} <= granted, (starter_id, [s.tool for s in steps])
        assert all(s.status == "ok" for s in steps), [(s.tool, s.status) for s in steps]
        assert f"Not available to you in chat: {missing}" in first.answer
        assert first.notice is None and first.blocks
        assert not any(re.search(r"posture|noise|hosts", f, re.I) for f in first.follow_ups)
        assert _shape(first) == _shape(second)


async def test_follow_ups_reuse_the_replayed_digest_and_stored_blocks(demo_state) -> None:
    questions = ["Which hosts generated the most events in the last 7 days?",
                 "Break that down by user instead",
                 "Show that as a table",
                 "Same for the last 48 hours"]
    prior: list[PriorExchange] = []
    responses: list[ChatResponse] = []
    for index, question in enumerate(questions):
        response = await _turn(demo_state, question, origin="user", prior=list(prior))
        responses.append(response)
        prior.append(_prior(question, response, index))
    hosts, by_user, as_table, rerun = responses
    assert [(s.tool, s.params["group_by"]) for s in _tool_steps(hosts)] == [("log_stats", "host")]
    (regroup,) = _tool_steps(by_user)
    assert regroup.params["group_by"] == "user" and regroup.params["time_from"] == "now-7d"
    assert "Re-ran the earlier lookup grouped by user (same filters)." in by_user.answer
    # "as a table" re-views a stored block: no lookup, no new number.
    assert _tool_steps(as_table) == []
    assert as_table.blocks and as_table.blocks[0]["type"] == "table"
    assert "No new lookup was needed" in as_table.answer
    (again,) = _tool_steps(rerun)
    assert again.tool == "log_stats" and again.params["time_from"] == "now-2d"
    assert again.params["group_by"] == "user"


async def test_report_summary_runs_through_the_demo_gateway_deterministically(demo_state) -> None:
    from app.engine.report_digest import report_summary_messages
    from app.models import Report

    posture = await _turn(demo_state, STARTERS["posture"].prompt)
    source = {"conversation_id": "conv-1", "message_id": "msg-1"}
    report = Report.model_validate({
        "id": "rep-1", "owner": "alice", "title": "Posture check", "template": "posture",
        "items": [{"id": f"it-{i}", "kind": "block", "block": block, "source": source,
                   "scope": {"window": "last 24h", "demo": True}}
                  for i, block in enumerate(posture.blocks, start=1)]})
    messages = report_summary_messages(report)
    gateway = demo_state.chat_engine._gateway
    first = await gateway.complete(Role.CHAT, messages, demo_state.execution_prefs.chat_model, surface="report")
    second = await gateway.complete(Role.CHAT, messages, demo_state.execution_prefs.chat_model, surface="report")
    assert first.text == second.text and first.pricing_source == "zero"
    summary, steps = parse_report_summary(first.text)
    assert summary.startswith("This posture report holds 3 items")
    assert "The items come from Demo Mode's synthetic data." in summary
    assert 1 <= len(steps) <= 5


SWEEP = (
    ("Any brute force or failed sign-ins today?", "brute"),
    ("Which users generated the most events in the last 7 days?", "top"),
    ("What did AI spend look like in the last 24 hours?", "cost"),
    ("Are any log sources silent?", "sources"),
    ("Which campaigns are open?", "campaigns"),
    ("Summarise today's true positives", "tp"),
    ("Show the noise reduction funnel", "noise"),
    ("What is ATT&CK technique T1110, and how often do we see it?", "mitre"),
    ("Hunt for 203.0.113.93 across logs, cases and threat intel.", "hunt"),
    ("Why was case demo-00000539-0001 closed?", "case"),
    ("Close case demo-00000539-0001", "change"),
    ("Tell me something interesting", "fallback"),
    ("Build a posture report with these sections: Summary, Key metrics, Trends, Noise reduction, Next steps.",
     "posture"),
    ("List the user accounts and their roles", "unsupported"),
    ("Remember that 10.20.0.0/16 is our corporate network", "remember"),
    ("What is our ATT&CK coverage?", "metric"),
    ("Are there pending approvals?", "automation"),
    ("Show the audit trail for the last day", "audit"),
    ("Which runbooks cover brute force?", "knowledge"),
    ("How many open critical cases are there?", "cases"),
    ("What are MTTA and MTTR, and what are ours?", "explain_metric"),
    ("What version is this deployment and is Demo Mode on?", "help"),
)


async def test_every_intent_answers_over_demo_data_without_the_safe_fallback(demo_state) -> None:
    """``plan_turn`` turns any planner exception into a safe final; this sweep proves
    no intent hits it over real demo data (and that each answer is well formed)."""
    from app.engine.demo_chat import _SAFE_FINAL, classify

    safe_text = _SAFE_FINAL.split("---ANSWER---\n", 1)[1]
    for question, intent in SWEEP:
        assert classify(question).intent == intent, question
        response = await _turn(demo_state, question, origin="user")
        assert response.answer and safe_text not in response.answer, question
        assert all(s.status == "ok" for s in _tool_steps(response)), (question, [
            (s.tool, s.status, s.summary) for s in _tool_steps(response)])
        assert len(response.follow_ups) <= 3
        assert response.usage is not None and response.usage.simulated, question
        if intent == "remember":
            assert response.memory_proposal is not None and response.memory_proposal.op == "add"
        if intent in ("unsupported",):
            assert response.notice is not None and response.notice.kind == "unsupported"


async def test_case_manager_chat_answers_about_its_case(demo_state) -> None:
    case_id = "demo-00000539-0001"
    question = "Why was this closed, and what does the evidence say?"
    builder = demo_state.build_chat_tool_context
    ctx = await builder(_request(demo_state), ChatRequest(message=question, case_id=case_id),
                        grants=catalogue_grant_pairs())
    assert ctx.case_id == case_id
    response = await demo_state.chat_engine.chat(question, demo_state.execution_prefs, case_id=case_id,
                                                 tool_context=ctx, origin="user")
    tools = [(s.tool, s.status) for s in _tool_steps(response)]
    assert ("get_case", "ok") in tools and ("explain_decision", "ok") in tools
    assert response.answer.startswith(f"**`{case_id}`** is a true positive")
    assert "How the policy sees it:" in response.answer
    assert response.case_id == case_id
