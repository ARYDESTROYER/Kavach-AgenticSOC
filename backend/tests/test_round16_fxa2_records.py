"""Round 16 acceptance fixes (FXA2): trace, usage and step records tell the truth.

* The decision span names no cost basis: code made the decision, so there is no model
  call and no ledger row behind it.
* The case usage totals split runbook AI help (the chat role on the ``runbook`` surface)
  from case chat, in an additive ``runbook`` total.
* The seeded Demo writes the AI's own audit rows (the investigator's prompt, one
  read-only ``es_query`` and the verdict) behind each seeded ledger row, so a seeded
  case's AI investigation tab shows the AI's work and its trace adds up to the ledger.
* A seeded notification record names its channel type as ``type``, as the live
  dispatcher writes it.

Each test fails on the code before its fix. Fully offline (fake ES, mock LLM, the $0
Demo gateway)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import ActionType, Role
from app.engine import demo_generator as gen
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import UsageDoc
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import mount_moved_routers

SEED = 1337


def _app() -> FastAPI:
    from app.api.routes import router as monolith_router
    from app.api.routes_case_usage import router as usage_router
    from app.api.routes_triage import router as triage_router

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (monolith_router, usage_router, triage_router):
        api.include_router(router)
    mount_moved_routers(api)
    return api


@pytest.fixture
def demo() -> Iterator[TestClient]:
    """A fresh seeded Demo, the one-command demo's mode."""
    with TestClient(_app()) as client:
        state: AppState = client.app.state.tlsoc
        client.portal.call(lambda: state.enable_demo(mode="seeded", seed=SEED))
        try:
            yield client
        finally:
            client.portal.call(state.disable_demo)


def _cases(client: TestClient) -> list:
    state: AppState = client.app.state.tlsoc
    cases, _total = client.portal.call(lambda: state.cases.list(limit=1000))
    assert cases
    return cases


def _seed_cases() -> list:
    org = gen.build_org(SEED)
    now = to_millis(now_utc())
    recent, _hits = gen.generate_recent_preseed(SEED, org, run_id="r", now_millis=now)
    hitl, tuner = gen.generate_capability_seed_cases(SEED, org, run_id="r", now_millis=now)
    return [*gen.generate_historical_cases(SEED, org, history_days=14, run_id="r", now_millis=now),
            *recent, *hitl, *tuner]


# --------------------------------------------------------------------------- #
# decision-span-cost-basis: the decision names no ledger row.
# --------------------------------------------------------------------------- #
def test_the_decision_span_names_no_cost_basis(demo: TestClient) -> None:
    case = _cases(demo)[0]
    spans = demo.get(f"/api/cases/{case.case_id}/timeline").json()["spans"]
    decision = spans[-1]
    assert decision["kind"] == "decision"
    # Code made it: no model call, no ledger row, so no basis to name.
    assert decision["cost_basis"] is None
    assert decision["cost"] == 0.0


# --------------------------------------------------------------------------- #
# runbook-ai-shown-as-case-chat: runbook AI help has its own total.
# --------------------------------------------------------------------------- #
def test_runbook_ai_help_is_totalled_apart_from_case_chat(demo: TestClient) -> None:
    state: AppState = demo.app.state.tlsoc
    case = next(c for c in _cases(demo) if not (c.token_cost or 0))
    for row in (
        UsageDoc(case_id=case.case_id, role=Role.CHAT.value, surface="runbook", model="m", cost=0.003447),
        UsageDoc(case_id=case.case_id, role=Role.CHAT.value, surface="chat", model="m", cost=0.0021),
    ):
        demo.portal.call(lambda row=row: state.usage_store.write_strict(row))
    page = demo.get(f"/api/cases/{case.case_id}/usage").json()
    assert page["totals"]["runbook"] == pytest.approx(0.003447)
    assert page["totals"]["chat"] == pytest.approx(0.0021)
    # Every earlier field is kept (additive): neither call is an investigation call.
    assert page["totals"]["pipeline"] == 0.0 and page["totals"]["other"] == 0.0
    assert page["reconciles"] is True


# --------------------------------------------------------------------------- #
# demo-seeded-cases-no-ai-steps / seeded-demo-trace-no-ai-steps
# --------------------------------------------------------------------------- #
def test_seeded_investigation_rows_follow_each_seeded_ledger_row() -> None:
    cases = _seed_cases()
    docs = gen.demo_seeded_usage_docs(cases, model="gpt-demo")
    rows = gen.demo_investigation_audit_rows(cases, docs)
    by_case: dict[str, list[dict]] = {}
    for row in rows:
        by_case.setdefault(row["case_id"], []).append(row)
    # One investigation per seeded ledger row, never for a case with no recorded call.
    assert set(by_case) == {d.case_id for d in docs}
    assert {c.case_id for c in cases if not (c.token_cost or 0)}.isdisjoint(by_case)
    for doc in docs:
        mine = by_case[doc.case_id]
        assert [r["action_type"] for r in mine] == [ActionType.PROMPT, ActionType.TOOL_CALL, ActionType.VERDICT]
        assert {r["run_id"] for r in mine} == {gen.demo_investigation_run_id(doc.case_id)}
        assert all(r["actor"] == Role.INVESTIGATOR.value and r["actor_type"] == "agent" for r in mine)
        assert all(r["surface"] == doc.surface for r in mine)
        assert mine[0]["model"] == mine[2]["model"] == doc.model
        assert mine[1]["tool_name"] == "es_query"
        # The verdict row is written as the ledger call ends; the prompt and query before it.
        assert gen._demo_moment(mine[2]["ts"], 0) == gen._demo_moment(doc.ts, 0)
        assert gen._demo_moment(mine[0]["ts"], 0) < gen._demo_moment(mine[1]["ts"], 0) < gen._demo_moment(doc.ts, 0)
        # The entity in the prompt excerpt is fenced as untrusted log data (#9).
        assert "<<<UNTRUSTED_LOG_DATA>>>" in mine[0]["prompt_excerpt"]
    # Deterministic: the same seed plans the same rows.
    assert gen.demo_investigation_audit_rows(cases, docs) == rows


def test_a_seeded_case_trace_shows_the_ai_work_behind_its_ledger_row(demo: TestClient) -> None:
    costed = [c for c in _cases(demo) if (c.token_cost or 0) > 0]
    assert costed
    for case in costed:
        body = demo.get(f"/api/cases/{case.case_id}/timeline").json()
        ai = [s for s in body["spans"] if s["kind"] in ("invoke_agent", "execute_tool")]
        assert [s["kind"] for s in ai] == ["invoke_agent", "execute_tool", "invoke_agent"], case.case_id
        usage = demo.get(f"/api/cases/{case.case_id}/usage").json()
        (call,) = usage["rows"]
        assert {s["payload_ref"]["model"] for s in ai if s["kind"] == "invoke_agent"} == {call["model"]}
        assert len({s["detail"]["run_id"] for s in ai}) == 1
        # The trace's cost is the ledger's: one call split across its prompt and verdict
        # rows, each share rounded to the micro-dollar.
        assert body["totals"]["cost"] == pytest.approx(usage["totals"]["pipeline"], abs=2e-6), case.case_id
        assert body["totals"]["tokens"] == pytest.approx(call["total_tokens"], abs=1), case.case_id


# --------------------------------------------------------------------------- #
# demo-notification-type: the seeded record names its channel type as ``type``.
# --------------------------------------------------------------------------- #
def test_seeded_notifications_name_their_channel_type_as_the_dispatcher_does() -> None:
    records = [n for c in _seed_cases() for n in (c.notifications_sent or [])]
    assert records, "the seed holds notification records"
    for record in records:
        assert record["type"] == "email"
        assert "channel_type" not in record
