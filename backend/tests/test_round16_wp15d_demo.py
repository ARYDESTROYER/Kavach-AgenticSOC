"""Round 16 WP15D: Demo Mode correctness (SPEC §4.5 WP15D, §3.2; bugs B34, B35 with B47
and B65, B41, B48 with B69, B61, and the Demo hunk of B13, B62).

The seeded Demo tells the truth: its numbers cross-check, its health is real and it
never touches live data. Each test names the bug it pins and fails on the code before
its fix. Fully offline (fake ES, mock LLM, the $0 Demo gateway)."""

from __future__ import annotations

import math
from collections.abc import Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import CaseStatus, DecisionBy, EntityType
from app.engine import demo_generator as gen
from app.engine.analyst_outcomes import CLASSIFIED_DISPOSITION_KEY, analyst_confirmed_outcome
from app.engine.priority import band_of_case, derive_triage, severity_band_from_events
from app.engine.risk import compute_risk
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Cluster
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event, mount_moved_routers

INDEX_A = "all-logs-2026.06.30"
SEED = 1337


def _app() -> FastAPI:
    from app.api.routes import router as monolith_router
    from app.api.routes_case_events import router as events_router
    from app.api.routes_case_usage import router as usage_router
    from app.api.routes_diagnostics import router as diagnostics_router
    from app.api.routes_rules import router as rules_router

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        base = to_millis(now_utc()) - 600_000
        # A real tenant source holding rows a Demo session must never see (B34).
        for i in range(6):
            es.add_log(INDEX_A, make_log_event(ip=f"10.0.0.{i}", rule="brute_force", user="root",
                                               ts_millis=base + i * 1000), doc_id=f"real-{i}")
        state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (monolith_router, rules_router, diagnostics_router, events_router, usage_router):
        api.include_router(router)
    mount_moved_routers(api)
    return api


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(_app()) as c:
        yield c


@pytest.fixture
def demo(client: TestClient) -> Iterator[TestClient]:
    """A fresh seeded Demo (the one-command demo's mode) over a tenant with a real
    Elasticsearch source."""
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": INDEX_A}}).status_code == 200
    state = _state(client)
    client.portal.call(lambda: state.enable_demo(mode="seeded", seed=SEED))
    try:
        yield client
    finally:
        client.portal.call(state.disable_demo)


def _seeded_cases(client: TestClient) -> list[Case]:
    state = _state(client)
    cases, _total = client.portal.call(lambda: state.cases.list(limit=1000))
    assert cases, "the seeded Demo holds cases"
    return cases


# --------------------------------------------------------------------------- #
# B34: rule Test and preview in Demo Mode reads the Demo sources, never the tenant.
# --------------------------------------------------------------------------- #
def test_b34_demo_rule_preview_reads_the_demo_sources_and_never_a_tenant_row(demo: TestClient) -> None:
    predicate = [{"field": "rule.name", "op": "equals", "value": "brute_force"}]
    body = demo.post("/api/rules/preview", json={"match": predicate, "limit": 200}).json()
    # The Demo sources are read (their rows are scanned) ...
    assert body["scanned"] > 0, body
    # ... and the tenant's rows never are: none matches, none is sampled.
    assert body["matched"] == 0, body
    assert not [row for row in body["sample"] if str(row.get("id", "")).startswith("real-")]
    # A scope to the tenant's own source reads nothing in Demo Mode.
    scoped = demo.post("/api/rules/preview", json={"match": predicate, "source_id": "elk-a"}).json()
    assert scoped["scanned"] == 0 and scoped["matched"] == 0, scoped


# --------------------------------------------------------------------------- #
# B35 (with B47, B65): a fresh seeded Demo raises no agent-health alert.
# --------------------------------------------------------------------------- #
def test_b35_fresh_seeded_demo_raises_no_agent_health_alert(demo: TestClient) -> None:
    health = demo.get("/api/diagnostics/health", params={"window_hours": 168}).json()
    assert health.get("demo_active") is True
    assert health["alerts"] == [], health["alerts"]
    corpus = health["precedent_corpus"]
    assert corpus["status"] == "ok", corpus
    # The first projection holds the analyst-confirmed seeded cases as precedent.
    stats = demo.get("/api/rag/stats").json()
    assert stats["by_source"].get("resolved_case", 0) > 0, stats["by_source"]


# --------------------------------------------------------------------------- #
# B48 (with B69): a seeded case's cost is its Demo ledger rows.
# --------------------------------------------------------------------------- #
def test_b48_seeded_case_cost_equals_its_demo_ledger_rows(demo: TestClient) -> None:
    from app.llm.gateway import _DEMO_IN_RATE

    state = _state(demo)
    costed = [c for c in _seeded_cases(demo) if (c.token_cost or 0) > 0]
    assert costed, "seeded investigations carry a simulated cost"
    for case in costed:
        page = demo.get(f"/api/cases/{case.case_id}/usage").json()
        assert page["reconciles"] is True, (case.case_id, page)
        rows = page["rows"]
        assert sum(r["cost"] for r in rows) == pytest.approx(case.token_cost, abs=1e-9), case.case_id
        for row in rows:
            assert row["price_basis"] == "demo_simulated" and row["role"] == "investigator"
            # The cost re-derives from the row: its prompt tokens at the simulated rate.
            assert row["input_rate_per_million"] == pytest.approx(_DEMO_IN_RATE * 1_000_000)
            assert round(row["prompt_tokens"] * _DEMO_IN_RATE, 6) == pytest.approx(row["cost"], abs=1e-9)
    # The Cost page and Agent effectiveness read the same ledger.
    total = demo.portal.call(lambda: state.usage_store.summary(window_hours=24 * 60))
    assert total["call_count"] >= len(costed)


# --------------------------------------------------------------------------- #
# B61: an analyst's seeded close records the disposition the analyst chose.
# --------------------------------------------------------------------------- #
def test_b61_every_seeded_analyst_close_reads_as_analyst_confirmed() -> None:
    org = gen.build_org(SEED)
    now = to_millis(now_utc())
    recent, _hits = gen.generate_recent_preseed(SEED, org, run_id="r", now_millis=now)
    hitl, tuner = gen.generate_capability_seed_cases(SEED, org, run_id="r", now_millis=now)
    cases = [*gen.generate_historical_cases(SEED, org, history_days=14, run_id="r", now_millis=now),
             *recent, *hitl, *tuner]
    closes = [c for c in cases if c.decision_by == DecisionBy.ANALYST
              and getattr(c.status, "value", c.status) in (CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value)]
    assert closes, "the seed holds analyst closes"
    rows = gen.demo_team_activity_audit_rows(cases, now_millis=now)
    for case in closes:
        disposition = getattr(case.disposition, "value", case.disposition)
        outcome, _source = analyst_confirmed_outcome(case)
        assert outcome is not None, case.case_id
        entries = [h for h in case.history if isinstance(h, dict) and h.get("event") == "analyst_action"]
        assert entries and entries[-1][CLASSIFIED_DISPOSITION_KEY] == disposition, case.case_id
        # The seeded close row records the same disposition.
        mine = [r for r in rows if r.get("case_id") == case.case_id
                and r.get("action") in ("case.closed", "case.resolved")]
        assert mine, case.case_id
        changes = {c.field: c.after for row in mine for c in (row.get("changes") or [])}
        assert changes.get(CLASSIFIED_DISPOSITION_KEY) == disposition, (case.case_id, changes)


# --------------------------------------------------------------------------- #
# B62 (the Demo hunk of B13): every seeded risk reproduces from the case's own inputs.
# --------------------------------------------------------------------------- #
def _volume(count: int) -> float:
    return min(100.0, 100.0 * math.log1p(count) / math.log1p(50)) if count > 0 else 0.0


def test_b62_every_seeded_risk_reproduces_from_its_inputs(demo: TestClient) -> None:
    state = _state(demo)
    prefs = state.execution_prefs
    scoring = gen.seed_scoring_prefs(prefs)
    for case in _seeded_cases(demo):
        b = case.risk_breakdown
        count = len(case.member_event_ids)
        rules = list(dict.fromkeys(case.rule_ids))
        # The case's score is its breakdown's total.
        assert case.risk_score == b.total, case.case_id
        # Each factor re-derives from the case: volume from its member count, diversity
        # from its rules, velocity 0 below 3 events, reputation an IP's alone, and the
        # asset criticality its impact chip reads.
        assert b.volume == round(_volume(count), 2), (case.case_id, count, b.volume)
        assert b.diversity == round(min(100.0, 100.0 * len(rules) / 5), 2), case.case_id
        if count < 3:
            assert b.velocity == 0.0, case.case_id
        if case.entity.type != EntityType.IP:
            assert b.reputation == 0.0, case.case_id
        assert b.asset_criticality == derive_triage(case, prefs)["impact"]["value"], case.case_id
        inputs = b.inputs
        assert inputs is not None, case.case_id
        assert inputs.event_count == count and inputs.rule_type_count == len(rules), case.case_id
        if case.entity.type != EntityType.IP:
            assert inputs.reputation_source == "not_ip_entity", case.case_id
        # The recorded inputs give the same breakdown again.
        first = 1_000_000
        cluster = Cluster(
            signature="x", entity=case.entity, group_by=case.entity.type, rule_values=rules,
            member_event_ids=list(case.member_event_ids), count=count, first_seen_millis=first,
            last_seen_millis=first + round(inputs.span_seconds * 1000),
        )
        again = compute_risk(cluster, scoring, inputs.reputation_input)
        assert again.model_dump(exclude={"inputs"}) == b.model_dump(exclude={"inputs"}), case.case_id
        # The seeded decision agrees with the case: an automatic close only where
        # decide() closes, and every other case left for a person.
        decision = gen.seeded_decision(case)
        if case.decision_by == DecisionBy.AGENT:
            assert decision.status == CaseStatus.CLOSED, case.case_id
        else:
            assert decision.status != CaseStatus.CLOSED, case.case_id
        recorded = [h for h in case.history if isinstance(h, dict) and h.get("event") == "decision"]
        assert recorded and recorded[0]["status"] == decision.status.value, case.case_id


# --------------------------------------------------------------------------- #
# The seeded cases' own events: the Evidence tab reads them, never "aged out", and the
# case's severity is the one its rows assert.
# --------------------------------------------------------------------------- #
def test_every_seeded_case_reads_its_own_events_and_their_severity(demo: TestClient) -> None:
    prefs = _state(demo).execution_prefs
    for case in _seeded_cases(demo):
        page = demo.get(f"/api/cases/{case.case_id}/events").json()
        assert page.get("status") != "aged_out", (case.case_id, page.get("status"))
        rows = page.get("rows") or page.get("events") or []
        assert len(rows) == len(case.member_event_ids), (case.case_id, len(rows))
        if gen.DEMO_TUNER_RULE in case.rule_ids:
            continue
        # The trigger reason correlation records from the rows: the source's severity.
        reason = case.trigger_reason
        assert reason is not None and reason.observed_count == len(case.member_event_ids), case.case_id
        severity = severity_band_from_events(case, prefs)
        assert severity["source"] == "source_asserted", case.case_id
        assert band_of_case(case, prefs) == severity["band"], case.case_id


# --------------------------------------------------------------------------- #
# B41: the Demo planner ranks open cases by risk for "need attention first".
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("question", "window"), [
    ("Which of the cases opened in the last 24 hours need attention first?", "now-24h"),
    ("Which case should I look at first?", None),
    ("Which cases need my attention?", None),
])
def test_b41_attention_questions_rank_open_cases_by_risk(question: str, window: str | None) -> None:
    from app.engine.demo_chat import plan_turn
    from tests.test_demo_chat_planner import prompt, tools_of

    plan = tools_of(plan_turn(prompt(question)))
    (_tool, inp), = [step for step in plan if step[0] == "search_cases"]
    assert inp["status_group"] == "active", inp
    assert (inp.get("sort_field"), inp.get("sort_order")) == ("risk_score", "desc"), inp
    assert inp.get("window") == window, inp


def test_b41_a_named_status_or_order_still_wins() -> None:
    from app.engine.demo_chat import plan_turn
    from tests.test_demo_chat_planner import prompt, tools_of

    (_tool, closed), = tools_of(plan_turn(prompt("Which closed cases need attention?")))
    assert closed["status_group"] == "terminal", closed
    (_tool, newest), = tools_of(plan_turn(prompt("Which newest cases need attention?")))
    assert newest.get("sort_field") is None, newest


# --------------------------------------------------------------------------- #
# Carry-forward of B08: the Demo's seeded automation reads the case again before it
# saves, so a stale copy never overwrites work saved meanwhile.
# --------------------------------------------------------------------------- #
def test_demo_seeded_automation_never_overwrites_a_newer_case(demo: TestClient) -> None:
    state = _state(demo)
    stack = state._demo  # the active Demo stack
    hitl = [c for c in _seeded_cases(demo) if c.case_id.startswith("demo-hitl-")]
    assert hitl
    stale = hitl[0].model_copy(deep=True)
    fresh = hitl[0].model_copy(deep=True)
    fresh.tags = [*fresh.tags, "saved-meanwhile"]
    demo.portal.call(lambda: stack.cases.save(fresh))
    demo.portal.call(lambda: stack.seed_hitl_proposals([stale]))
    stored = demo.portal.call(lambda: stack.cases.get(stale.case_id))
    assert "saved-meanwhile" in stored.tags
