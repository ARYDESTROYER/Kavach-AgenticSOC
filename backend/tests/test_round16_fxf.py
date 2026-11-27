"""Round 16 package FXF: the fix-package leftovers, backend side.

* The trace shows runbook AI help (a PROMPT row on the ``runbook`` surface, which names
  the person who asked) as its own ``runbook_ai`` span with the cost of its own ledger
  row, never as an Agent step, and case chat's steps no longer carry its spend.
* A waiting case's ``awaiting_reason`` stores the routing score with two decimals, as
  the forwarding explainer prints it; the gate itself is unchanged.
* A manual case's trigger sentence and the "no events remain" refusal name the window in
  plain words ("in the last 24 hours"), never the raw token ("now-24h").
* ``GET /api/tuning/recommendations`` returns the Wilson z in force (additive).
* The posture comparison of a rate carries the counts behind both windows (additive).

Each test fails on the code before its fix. Fully offline (fake ES, mock LLM).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import ActionType, CaseStatus, EntityType, Role, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import AuditDoc, Case, Cluster, Entity, UsageDoc
from app.state import AppState
from app.utils import iso_now
from tests.conftest import mount_moved_routers

CASE_ID = "case-fxf-1"


@pytest.fixture
def client() -> Iterator[TestClient]:
    """The base router, the trace and tuning routers and the moved routers, over a fake
    ES and the mock LLM (auth off, as the offline suite runs)."""
    from app.api.routes import router as monolith_router
    from app.api.routes_triage import router as triage_router
    from app.api.routes_tuning import router as tuning_router

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
    for router in (monolith_router, triage_router, tuning_router):
        api.include_router(router)
    mount_moved_routers(api)
    with TestClient(api) as test_client:
        yield test_client


def _at(seconds: int) -> str:
    base = datetime(2026, 11, 26, 10, 0, 0, tzinfo=timezone.utc)
    return (base + timedelta(seconds=seconds)).isoformat()


def _seed_runbook_help(client) -> None:
    state = client.app.state.tlsoc
    client.portal.call(state.cases.save, Case(
        case_id=CASE_ID, cluster_signature="sig-fxf", case_number="CASE-0901",
        source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=EntityType.IP, value="198.51.100.4"),
        verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN, created_at=iso_now(), updated_at=iso_now(),
    ))
    usage = (
        # The investigator's call, then case chat's, then runbook AI help's (chat role).
        UsageDoc(ts=_at(0), case_id=CASE_ID, role=Role.INVESTIGATOR.value, surface="investigation",
                 model="m", total_tokens=1000, cost=0.02),
        UsageDoc(ts=_at(60), case_id=CASE_ID, role=Role.CHAT.value, surface="chat",
                 model="m", total_tokens=300, cost=0.0021),
        UsageDoc(ts=_at(120), case_id=CASE_ID, role=Role.CHAT.value, surface="runbook",
                 model="m", total_tokens=420, cost=0.003447),
    )
    for doc in usage:
        client.portal.call(state.usage_store.write_strict, doc)
    rows = (
        AuditDoc(ts=_at(1), case_id=CASE_ID, actor="investigator", action_type=ActionType.PROMPT,
                 surface="investigation", actor_type="agent", result_summary="investigator prompt"),
        AuditDoc(ts=_at(61), case_id=CASE_ID, actor="chat", action_type=ActionType.PROMPT,
                 surface="chat", actor_type="agent", result_summary="case chat answer"),
        # engine.runbook_runs._ai_call: the row is written after its call, names the
        # person who asked, and is Agent activity on the runbook surface.
        AuditDoc(ts=_at(121), case_id=CASE_ID, actor="Admin", action_type=ActionType.PROMPT,
                 surface="runbook", actor_type="agent", model="m",
                 result_summary="runbook step draft model call tokens=420 cost=0.003447"),
    )
    for row in rows:
        client.portal.call(state.audit.write, row)


def test_runbook_ai_help_is_its_own_span_with_its_ledger_cost(client) -> None:
    _seed_runbook_help(client)
    body = client.get(f"/api/cases/{CASE_ID}/timeline").json()
    spans = {s["summary"]: s for s in body["spans"]}
    help_span = spans["runbook step draft model call tokens=420 cost=0.003447"]
    assert help_span["kind"] == "runbook_ai"
    # The person who asked, never the agent's name.
    assert help_span["name"] == "Admin"
    assert help_span["payload_ref"]["actor"] == "Admin"
    # Its own call's cost, from the ledger row (#6), not a missing or shared figure.
    assert help_span["cost"] == 0.003447
    assert help_span["tokens"] == 420
    assert help_span["cost_basis"] == "exact"
    # Case chat no longer carries the runbook call's spend.
    chat_span = spans["case chat answer"]
    assert chat_span["kind"] == "chat"
    assert chat_span["cost"] == 0.0021
    # The totals still add up to the ledger.
    assert body["totals"]["cost"] == 0.025547


def test_a_runbook_row_without_a_ledger_row_has_no_invented_cost(client) -> None:
    state = client.app.state.tlsoc
    client.portal.call(state.audit.write, AuditDoc(
        ts=_at(5), case_id="case-fxf-2", actor="lee", action_type=ActionType.PROMPT,
        surface="runbook", actor_type="agent", result_summary="runbook suggest model call tokens=0 cost=0.000000",
    ))
    span = client.get("/api/cases/case-fxf-2/timeline").json()["spans"][0]
    assert span["kind"] == "runbook_ai"
    assert span["cost"] is None and span["cost_basis"] is None


def test_awaiting_reason_keeps_two_decimals() -> None:
    from app.config import Preferences
    from app.engine.ingest import _candidate_reason

    cluster = Cluster(signature="sig-a", entity=Entity(type=EntityType.IP, value="192.0.2.9"),
                      group_by=EntityType.IP, rule_values=["r"], risk_score=10.0,
                      member_event_ids=["e1"], auto_investigate_eligible=True)
    prefs = Preferences()
    reason = _candidate_reason(cluster, prefs, capped=False, floor=70, routing_score=69.5)
    # 69.5 is below 70; cut to "69" it reads as an integer the explainer never printed.
    assert reason == "available-signal routing score 69.5 is below the auto-investigate floor 70"
    reason = _candidate_reason(cluster, prefs, capped=False, floor=70, routing_score=32.6333)
    assert reason == "available-signal routing score 32.63 is below the auto-investigate floor 70"
    assert _candidate_reason(cluster, prefs, capped=False, floor=70, routing_score=45.0).endswith(
        "routing score 45 is below the auto-investigate floor 70"
    )


def test_a_manual_trigger_sentence_names_the_window_in_words() -> None:
    from app.engine import case_cluster

    cluster = Cluster(signature="sig-m", entity=Entity(type=EntityType.IP, value="198.51.100.9"),
                      group_by=EntityType.IP, rule_values=["r1"], risk_score=10.0, member_event_ids=["e1"])
    sentence = case_cluster.manual_trigger_reason(cluster, "now-24h").sentence
    assert "in the last 24 hours" in sentence
    assert "now-24h" not in sentence
    assert case_cluster.window_words("now-7d") == "in the last 7 days"
    assert case_cluster.window_words("this_week") == "in this week"
    assert case_cluster.window_words("all") == "at any time"
    # A window the grammar does not read is named as configured.
    assert case_cluster.window_words("weird!") == "in the last weird!"


def test_the_no_events_refusal_names_the_window_in_words(client, monkeypatch) -> None:
    import app.api.routes as routes

    _seed_runbook_help(client)

    async def no_cluster(*_a, **_k):
        return None

    monkeypatch.setattr(routes, "_cluster_for_case", no_cluster)
    r = client.post(f"/api/cases/{CASE_ID}/investigate")
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert "in the last 24 hours" in detail
    assert "now-24h" not in detail


def test_tuning_recommendations_return_the_wilson_z(client) -> None:
    state = client.app.state.tlsoc
    prefs = state.prefs
    tuned = prefs.model_copy(update={
        "threshold_tuning": prefs.threshold_tuning.model_copy(update={"wilson_z": 2.576}),
    })
    client.portal.call(state.update_prefs, tuned)
    body = client.get("/api/tuning/recommendations").json()
    assert body["wilson_z"] == 2.576


def test_posture_rate_comparisons_carry_both_windows_counts() -> None:
    from app.engine.metrics import posture_metrics

    now = datetime(2026, 11, 26, 12, 0, tzinfo=timezone.utc)

    def case(i: int, hours_ago: float, verdict: Verdict) -> Case:
        at = (now - timedelta(hours=hours_ago)).isoformat()
        return Case(case_id=f"c{i}", cluster_signature=f"s{i}", source_surface=SourceSurface.AUTOMATED_SCAN,
                    entity=Entity(type=EntityType.IP, value=f"192.0.2.{i}"), verdict=verdict,
                    status=CaseStatus.OPEN, created_at=at, updated_at=at)

    current = [case(i, 1, Verdict.FALSE_POSITIVE if i < 3 else Verdict.TRUE_POSITIVE) for i in range(4)]
    before = [case(10 + i, 30, Verdict.FALSE_POSITIVE if i < 1 else Verdict.TRUE_POSITIVE) for i in range(5)]
    rollup = posture_metrics(current + before, window_hours=24, compare="prev", now=now)
    fp = rollup["compare"]["false_positive_rate"]
    assert (fp["numerator"], fp["denominator"]) == (3, 4)
    assert (fp["prev_numerator"], fp["prev_denominator"]) == (1, 5)
    # Every earlier key keeps its meaning (additive).
    assert fp["value"] == 0.75 and fp["prev"] == 0.2
    yield_ = rollup["compare"]["alert_to_incident_ratio"]
    assert (yield_["numerator"], yield_["denominator"], yield_["prev_numerator"], yield_["prev_denominator"]) == (1, 4, 4, 5)
    assert set(rollup["compare"]["case_count"]) == {"value", "prev", "delta_pct"}
