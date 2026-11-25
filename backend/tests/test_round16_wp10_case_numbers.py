"""Round 16 WP10: case numbers explained (SPEC §4.5 WP10, B13, B63).

* B13: the risk score records what it was computed from (``RiskBreakdown.inputs``) at
  every ``compute_risk`` call site, so a case that attached more events after it was
  scored still explains its score from the count it used, and the Timeline arithmetic
  uses the weights in force at scoring.
* B63: the Decision stage and the trace's decision span report the RECORDED decision
  (its time, status, decider and rationale, and the gate recorded on the run's
  ``case_manager`` DECISION row), never a read-time re-run of ``decide()`` with today's
  policy dated by ``updated_at``.
* The read-time triage additions (``auto_close_policy``, ``sla``, ``asset_cidr``), the
  per-case SLA reading, the one Wilson interval, the trace's span kinds, bounded detail,
  exact cost basis and truncation flags, and the forwarding routing total.

Offline: fake ES + mock LLM via ``app_state``. ``decide()`` and ``engine/risk.py`` are
untouched (the §3.6 guards pin them).
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.api import routes_triage
from app.api.routes_triage import (
    _risk_calculation,
    case_stages,
    case_timeline,
    case_triage,
)
from app.config import AssetNetwork, Preferences, RiskWeights, SlaPolicy, SlaTarget
from app.constants import (
    ActionType,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import stats
from app.engine.case_manager import CaseManager
from app.engine.correlation import cluster_from_events
from app.engine.forwarding import explain_forwarding
from app.engine.ingest import attach_cluster
from app.engine.metrics import sla_metrics
from app.engine.risk import compute_risk
from app.engine.risk_explain import explain_risk
from app.engine.sla_reading import case_sla_reading
from app.models import (
    AuditDoc,
    Case,
    Cluster,
    Entity,
    RiskBreakdown,
    StatusHistoryEntry,
    UsageDoc,
)

from tests.conftest import make_raw_event

BASE = 1_700_000_000_000


def _request(state):
    """A minimal request bound to ``state``. Sign-in is off, so the caller holds every
    grant (the timeline's cost included)."""
    from fastapi import FastAPI
    from starlette.requests import Request

    app = FastAPI()
    app.state.tlsoc = state
    return Request({"type": "http", "method": "GET", "path": "/api/cases/x/triage", "headers": [],
                    "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _case(**fields) -> Case:
    """A case with the required identity fields defaulted."""
    case_id = fields.setdefault("case_id", "case-x")
    fields.setdefault("cluster_signature", f"sig:{case_id}")
    fields.setdefault("source_surface", SourceSurface.AUTOMATED_SCAN)
    fields.setdefault("entity", Entity(type=EntityType.IP, value="203.0.113.50"))
    return Case(**fields)


def _events_cluster(n: int, *, start: int = 0, ip: str = "203.0.113.50", rule: str = "linux_auth"):
    events = [
        make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=BASE + i * 1000)
        for i in range(start, start + n)
    ]
    return cluster_from_events(EntityType.IP, ip, events)


def _worked_example_cluster() -> Cluster:
    """The research worked example: 40 events over 120 s, 3 rule types, IP 10.0.4.12."""
    return Cluster(
        signature="sig-81",
        entity=Entity(type=EntityType.IP, value="10.0.4.12"),
        group_by=EntityType.IP,
        rule_values=["r1", "r2", "r3"],
        count=40,
        first_seen_millis=BASE,
        last_seen_millis=BASE + 120_000,
    )


def _final(verdict: str = "FALSE_POSITIVE", confidence: float = 0.97) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "Scheduled scanner from the internal range.",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scan", "event_ids": ["e0"], "query": 'source.ip:"x"'}],
            "mitre": [], "recommended_action": "none", "reproduce_query": "",
        },
    })


async def _investigate(state, mock_provider, cluster, *, verdict="FALSE_POSITIVE", confidence=0.97):
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "check"}))
    mock_provider.push("investigator", _final(verdict, confidence))
    return await state.pipeline.investigate_cluster(cluster, SourceSurface.INVESTIGATE, state.prefs)


def _decided_case(prefs: Preferences, *, case_id: str, verdict=Verdict.FALSE_POSITIVE,
                  confidence: float = 0.97, risk: float = 20.0, run_id: str | None = "inv-1") -> Case:
    """A case decided by the real ``CaseManager.apply`` (decide() untouched), its history
    decision entry paired with ``run_id`` as the pipeline pairs it."""
    case = _case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.50"),
        member_event_ids=["e1", "e2"],
        risk_score=risk,
        risk_breakdown=RiskBreakdown(volume=20.0, total=risk),
        verdict=verdict,
        confidence=confidence,
        status=CaseStatus.OPEN,
    )
    CaseManager(prefs).apply(case)
    if run_id is not None:
        case.history[-1]["run_id"] = run_id
    return case


def _gate(prefs: Preferences, case: Case, *, outcome: str = "cleared") -> dict:
    entry = prefs.auto_close.false_positive
    return {
        "verdict": case.verdict.value, "confidence": case.confidence, "risk_score": case.risk_score,
        "class_enabled": entry.enabled, "min_confidence": entry.min_confidence,
        "max_risk_score": entry.max_risk_score,
        "objection_window_minutes": entry.objection_window_minutes,
        "escalation_confidence": prefs.escalation_confidence,
        "critical_severity": prefs.critical_severity, "outcome": outcome, "demo": False,
    }


# =========================================================================== #
# B13: the risk inputs are recorded at scoring and survive an attach
# =========================================================================== #
async def test_b13_the_recorded_inputs_still_say_the_scoring_count_after_an_attach(
    app_state, mock_provider,
):
    """Score a cluster, attach 47 more events: the stored inputs still say the count the
    score used, and the Timeline arithmetic uses the recorded weights (B13)."""
    state = app_state
    case = await _investigate(state, mock_provider, _events_cluster(3))
    stored = await state.cases.get(case.case_id)
    inputs = stored.risk_breakdown.inputs
    assert inputs is not None, "the score must record what it was computed from"
    assert inputs.event_count == 3
    assert inputs.rule_type_count == 1 and inputs.rule_values == ["linux_auth"]
    assert inputs.reputation_source in {"enrichment", "enrichment_off"}

    more = _events_cluster(47, start=3)
    assert more.signature == stored.cluster_signature
    await attach_cluster(state.cases, stored, more, pipeline=state.pipeline)
    after = await state.cases.get(case.case_id)
    assert len(after.member_event_keys or after.member_event_ids) == 50
    assert after.risk_breakdown.inputs.event_count == 3  # never the post-attach 50
    assert after.risk_score == stored.risk_score

    calc = _risk_calculation(after, state.prefs)
    assert calc.weight_basis == "recorded_at_scoring"
    assert calc.matches_displayed_score is True


async def test_b13_every_compute_risk_site_records_inputs(app_state, mock_provider):
    """The candidate path records its inputs too, with the reputation it did not look
    up named as such."""
    state = app_state
    candidate = await state.pipeline.register_candidate(
        _events_cluster(4, ip="203.0.113.77"), SourceSurface.AUTOMATED_SCAN, state.prefs,
    )
    inputs = candidate.risk_breakdown.inputs
    assert inputs is not None
    assert inputs.event_count == 4 and inputs.reputation_source == "not_looked_up"
    assert inputs.scored_at


def test_the_worked_example_reproduces_from_stored_inputs() -> None:
    """[expl] §3: risk 81.11 from 40 events over 120 s, 3 rules, reputation 75 and an
    exact asset entry of 60, re-derived from the record alone with its weights."""
    prefs = Preferences()
    prefs.asset_criticality = {"10.0.4.12": 60.0}
    cluster = _worked_example_cluster()
    breakdown = compute_risk(cluster, prefs, 75.0)
    breakdown.inputs = explain_risk(cluster, prefs, 75.0, reputation_source="enrichment",
                                    scored_at="2026-11-25T00:00:00+00:00")
    assert breakdown.total == 81.11
    case = _case(case_id="case-81", risk_score=breakdown.total, risk_breakdown=breakdown,
                entity=cluster.entity)
    # Today's weights change; the recorded ones still explain the stored score.
    today = Preferences()
    today.risk_weights = RiskWeights(volume=1.0, velocity=0.0, reputation=0.0, diversity=0.0,
                                     asset_criticality=0.0)
    calc = _risk_calculation(case, today)
    assert calc.weight_basis == "recorded_at_scoring"
    assert abs(calc.calculated_score - 81.11) <= 0.01
    assert calc.displayed_score == 81 and calc.matches_displayed_score is True
    assert [f.weight for f in calc.factors] == [0.25, 0.2, 0.3, 0.15, 0.1]


def test_a_legacy_case_reads_not_recorded_with_todays_weights() -> None:
    prefs = Preferences()
    case = _case(case_id="case-old", risk_score=7.0,
                risk_breakdown=RiskBreakdown(volume=20.0, velocity=10.0, total=7.0))
    assert _risk_calculation(case, prefs).weight_basis == "current_preferences"
    from app.engine.priority import derive_triage

    chip = derive_triage(case, prefs)["risk"]
    assert chip["inputs_status"] == "not_recorded"
    assert chip["inputs"]["weights_basis"] == "current_preferences"


async def test_the_prompt_is_unchanged_by_recorded_inputs() -> None:
    """The investigator renders named risk attributes only: recording the inputs never
    changes what a model sees (#7, #9)."""
    from app.agents.prompts import render_cluster

    prefs = Preferences()
    cluster = _worked_example_cluster()
    cluster.risk_breakdown = compute_risk(cluster, prefs, 75.0)
    cluster.risk_score = cluster.risk_breakdown.total
    without = render_cluster(cluster, None, None)
    cluster.risk_breakdown.inputs = explain_risk(
        cluster, prefs, 75.0, reputation_source="enrichment", scored_at="2026-11-25T00:00:00+00:00",
    )
    assert render_cluster(cluster, None, None) == without


# =========================================================================== #
# The DECISION gate, recorded after apply(), paired by run id
# =========================================================================== #
async def test_the_pipeline_records_the_gate_and_pairs_it_with_the_history_entry(
    app_state, mock_provider,
):
    state = app_state
    case = await _investigate(state, mock_provider, _events_cluster(3, ip="203.0.113.60"))
    stored = await state.cases.get(case.case_id)
    entry = [h for h in stored.history if h.get("event") == "decision"][-1]
    assert str(entry.get("run_id") or "").startswith("inv-")
    rows = await state.audit.records_for_case(case.case_id)
    gate_rows = [r for r in rows if r.get("actor") == "case_manager"
                 and r.get("action_type") == ActionType.DECISION.value]
    assert len(gate_rows) == 1
    row = gate_rows[0]
    assert row["run_id"] == entry["run_id"]
    gate = row["tool_input"]["gate"]
    assert tuple(gate) == routes_triage.GATE_KEYS
    assert gate["verdict"] == stored.verdict.value
    assert gate["confidence"] == stored.confidence and gate["risk_score"] == stored.risk_score
    assert gate["min_confidence"] == state.prefs.auto_close.false_positive.min_confidence
    assert gate["demo"] is False
    # The result summary keeps its exact tokens (append-only history string).
    assert row["result_summary"].startswith(f"verdict={stored.verdict.value} status=")
    assert "auto_close_gate=" in row["result_summary"]

    span = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]
    assert span["kind"] == "decision"
    assert span["payload_ref"]["source"] == "recorded"
    assert span["payload_ref"]["gate_source"] == "recorded"
    assert span["payload_ref"]["gate"] == gate
    assert span["detail"]["run_id"] == entry["run_id"]
    assert span["detail"]["result_summary"] is None  # the row's cost stays out


# =========================================================================== #
# B63: the Decision stage reports the recorded decision
# =========================================================================== #
async def test_b63_the_decision_stage_keeps_the_recorded_decision(app_state):
    """Auto-close a case, bump ``updated_at`` (a comment), tighten the policy: the
    Decision stage keeps the recorded time, the auto-close headline and the recorded
    rationale, and says today's policy would decide differently."""
    state = app_state
    prefs = state.prefs
    case = _decided_case(prefs, case_id="case-b63")
    decided_at = case.history[-1]["ts"]
    rationale = case.history[-1]["rationale"]
    assert case.status == CaseStatus.CLOSED and case.decision_by == DecisionBy.AGENT
    case.updated_at = _iso(datetime.now(timezone.utc) + timedelta(hours=1))
    await state.cases.save(case)
    await state.audit.write(AuditDoc(
        ts=decided_at, case_id=case.case_id, actor="case_manager",
        action_type=ActionType.DECISION, run_id="inv-1",
        result_summary="verdict=FALSE_POSITIVE status=closed", tool_input={"gate": _gate(prefs, case)},
    ))
    prefs.auto_close.false_positive.min_confidence = 0.99

    res = await case_stages(case.case_id, state)
    decide_stage = next(s for s in res["stages"] if s["kind"] == "decide")
    assert decide_stage["ts"] == decided_at
    assert decide_stage["headline"] == "Auto-closed by policy"
    assert decide_stage["steps"][0]["body"] == rationale
    assert any(s["label"] == "policy changed" for s in decide_stage["steps"])

    span = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]
    pr = span["payload_ref"]
    assert span["ts"] == decided_at
    assert pr["decision_status"] == "closed" and pr["decision_by"] == "agent"
    assert pr["objection_window_expires_at"] == case.objection_window_expires_at
    assert pr["gate"]["min_confidence"] == 0.85  # the bar recorded at the time
    assert pr["current_policy"]["min_confidence"] == 0.99
    assert pr["current_policy"]["decision_status"] == "needs_human"
    assert pr["policy_changed"] is True


async def test_b63_d1_an_analyst_close_is_not_reported_as_an_auto_close(app_state):
    """[expl] D1: a legacy case with no recorded decision, closed by an analyst, is
    re-derived with today's policy and SAID so: no time, and the stored objection
    window (none), never "now plus the window"."""
    state = app_state
    case = _case(
        case_id="case-d1", cluster_signature="sig:d1",
        entity=Entity(type=EntityType.IP, value="203.0.113.9"),
        risk_score=20.0, risk_breakdown=RiskBreakdown(total=20.0),
        verdict=Verdict.FALSE_POSITIVE, confidence=0.97,
        status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST,
        objection_window_expires_at=None,
        updated_at=_iso(datetime.now(timezone.utc)),
    )
    await state.cases.save(case)
    span = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]
    pr = span["payload_ref"]
    assert pr["source"] == "rederived_current_policy"
    assert pr["objection_window_expires_at"] is None
    assert span["ts"] == ""  # never dated by updated_at
    stage = next(s for s in (await case_stages(case.case_id, state))["stages"] if s["kind"] == "decide")
    assert stage["ts"] is None
    assert any(s["label"] == "decision source" for s in stage["steps"])


async def test_b63_dv3_disabling_auto_close_keeps_the_recorded_auto_close(app_state):
    """[dv] DV-3: after FP auto-close is turned off, the span still reports the closed
    case closed by the agent, with the recorded clause, and flags the change."""
    state = app_state
    prefs = state.prefs
    case = _decided_case(prefs, case_id="case-dv3", risk=10.0)
    await state.cases.save(case)
    await state.audit.write(AuditDoc(
        ts=case.history[-1]["ts"], case_id=case.case_id, actor="case_manager",
        action_type=ActionType.DECISION, run_id="inv-1", tool_input={"gate": _gate(prefs, case)},
    ))
    prefs.auto_close.false_positive.enabled = False
    pr = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]["payload_ref"]
    assert pr["decision_status"] == "closed" and pr["decision_by"] == "agent"
    assert pr["gate"]["class_enabled"] is True
    assert pr["current_policy"]["enabled"] is False
    assert pr["policy_changed"] is True


async def test_the_gate_pairs_the_run_among_several_decision_rows(app_state):
    """C18: a reinvestigate request row and a no-change row of the same run, and an
    older run's case_manager row, precede the run's own gate row: the span reads only
    the case_manager row whose run id matches the history entry."""
    state = app_state
    prefs = state.prefs
    case = _decided_case(prefs, case_id="case-pair", run_id="inv-2")
    await state.cases.save(case)
    old_gate = {**_gate(prefs, case), "min_confidence": 0.5}
    new_gate = _gate(prefs, case)
    for ts, actor, run_id, tool_input in (
        ("2026-11-01T10:00:00+00:00", "case_manager", "inv-1", {"gate": old_gate}),
        ("2026-11-02T10:00:00+00:00", "reinvestigate", "inv-2", None),
        ("2026-11-02T10:00:01+00:00", "pipeline", "inv-2", None),
        ("2026-11-02T10:00:05+00:00", "case_manager", "inv-2", {"gate": new_gate}),
    ):
        await state.audit.write(AuditDoc(ts=ts, case_id=case.case_id, actor=actor,
                                         action_type=ActionType.DECISION, run_id=run_id,
                                         tool_input=tool_input))
    pr = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]["payload_ref"]
    assert pr["gate"] == new_gate and pr["gate_source"] == "recorded"

    # No row of the entry's run: the thresholds are re-derived with today's policy.
    lonely = _decided_case(prefs, case_id="case-lonely", run_id="inv-9")
    await state.cases.save(lonely)
    pr = (await case_timeline(lonely.case_id, _request(state), state))["spans"][-1]["payload_ref"]
    assert pr["gate"] is None and pr["gate_source"] == "rederived_current_policy"
    assert pr["source"] == "recorded"


async def test_a_failed_run_after_the_decision_is_reported_as_routed_to_a_person(app_state):
    """A run that failed after the recorded decision rebuilt the case for a person with
    no decision entry: the span reports that routing, not the earlier auto-close."""
    state = app_state
    case = _decided_case(state.prefs, case_id="case-failed")
    later = _iso(datetime.now(timezone.utc) + timedelta(minutes=5))
    case = case.model_copy(update={
        "verdict": Verdict.NEEDS_HUMAN, "confidence": 0.0,
        "status": CaseStatus.NEEDS_HUMAN, "decision_by": DecisionBy.SYSTEM,
        "objection_window_expires_at": None, "error": "boom",
    })
    await state.cases.save(case)
    await state.audit.write(AuditDoc(ts=later, case_id=case.case_id, actor="pipeline",
                                     action_type=ActionType.ERROR,
                                     result_summary="pipeline error: boom"))
    span = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]
    assert span["payload_ref"]["run_failed"] is True
    assert span["payload_ref"]["decision_status"] == "needs_human"
    assert span["ts"] == later
    stage = next(s for s in (await case_stages(case.case_id, state))["stages"] if s["kind"] == "decide")
    assert stage["headline"] == "Held for human review"


async def test_a_first_run_that_failed_is_reported_as_routed_to_a_person(app_state):
    """Review fix: a case whose first run failed has no decision entry at all (the
    failure path keeps the empty history). Its span reports the failure that routed it,
    never a decision re-derived with today's policy."""
    state = app_state
    failed_at = "2026-11-01T10:00:00+00:00"
    case = _case(
        case_id="case-first-failed", verdict=Verdict.NEEDS_HUMAN, confidence=0.0,
        status=CaseStatus.NEEDS_HUMAN, decision_by=DecisionBy.SYSTEM, risk_score=40.0,
        risk_breakdown=RiskBreakdown(total=40.0), error="boom",
    )
    assert not [h for h in case.history if h.get("event") == "decision"]
    await state.cases.save(case)
    await state.audit.write(AuditDoc(ts=failed_at, case_id=case.case_id, actor="pipeline",
                                     action_type=ActionType.ERROR,
                                     result_summary="pipeline error: boom"))
    span = (await case_timeline(case.case_id, _request(state), state))["spans"][-1]
    pr = span["payload_ref"]
    assert pr["run_failed"] is True and pr["source"] == "recorded"
    assert span["ts"] == failed_at
    assert span["summary"] == routes_triage._FAILED_RUN_SUMMARY
    stage = next(s for s in (await case_stages(case.case_id, state))["stages"] if s["kind"] == "decide")
    assert stage["ts"] == failed_at
    assert not any(s["label"] == "decision source" for s in stage["steps"])

    # Without a failure row, the same case is still re-derived and said so.
    quiet = _case(case_id="case-no-failure", verdict=Verdict.NEEDS_HUMAN, confidence=0.0,
                  status=CaseStatus.NEEDS_HUMAN, risk_score=40.0)
    await state.cases.save(quiet)
    pr = (await case_timeline(quiet.case_id, _request(state), state))["spans"][-1]["payload_ref"]
    assert pr["source"] == "rederived_current_policy" and pr["run_failed"] is False


# =========================================================================== #
# The triage read: auto-close entry, SLA, asset range, risk chip
# =========================================================================== #
async def test_auto_close_policy_for_each_verdict_class(app_state):
    state = app_state
    prefs = state.prefs
    for verdict, cls, entry in (
        (Verdict.FALSE_POSITIVE, "false_positive", prefs.auto_close.false_positive),
        (Verdict.TRUE_POSITIVE, "true_positive", prefs.auto_close.true_positive),
    ):
        case = _case(case_id=f"case-acp-{cls}", verdict=verdict, risk_score=10.0)
        await state.cases.save(case)
        policy = (await case_triage(case.case_id, state))["auto_close_policy"]
        assert policy["verdict_class"] == cls
        assert policy["enabled"] is entry.enabled
        assert policy["min_confidence"] == entry.min_confidence
        assert policy["max_risk_score"] == entry.max_risk_score
        assert policy["objection_window_minutes"] == entry.objection_window_minutes
    for verdict in (Verdict.NEEDS_HUMAN, None):
        case = _case(case_id=f"case-acp-nh-{verdict}", verdict=verdict)
        await state.cases.save(case)
        policy = (await case_triage(case.case_id, state))["auto_close_policy"]
        assert policy["verdict_class"] == "needs_human" and policy["enabled"] is False


async def test_asset_cidr_is_only_for_a_settings_reader(app_state, monkeypatch):
    state = app_state
    state.prefs.asset_networks = [AssetNetwork(cidr="10.0.0.0/8", criticality=60.0)]
    cluster = _worked_example_cluster()
    breakdown = compute_risk(cluster, state.prefs, 0.0)
    breakdown.inputs = explain_risk(cluster, state.prefs, 0.0, reputation_source="not_looked_up",
                                    scored_at="2026-11-25T00:00:00+00:00")
    case = _case(case_id="case-cidr", entity=cluster.entity, risk_score=breakdown.total,
                risk_breakdown=breakdown)
    await state.cases.save(case)
    # The range is never stored with the case.
    assert "10.0.0.0/8" not in json.dumps(case.model_dump(mode="json"))

    res = await case_triage(case.case_id, state, None, _request(state))
    assert res["asset_cidr"] == {"cidr": "10.0.0.0/8", "criticality": 60.0,
                                 "label": "current configuration", "matches_recorded": True}

    async def _no_settings(request, resource, action):
        return not (resource == "settings" and action == "read")

    monkeypatch.setattr(routes_triage, "has_permission", _no_settings)
    res = await case_triage(case.case_id, state, None, _request(state))
    assert "asset_cidr" not in res
    assert res["found"] is True and res["chips"]


async def test_the_http_route_receives_the_request_for_the_range(app_state):
    """Over HTTP the route gets its request, so a settings reader sees the range."""
    import httpx
    from fastapi import FastAPI

    state = app_state
    state.prefs.asset_networks = [AssetNetwork(cidr="10.0.0.0/8", criticality=60.0)]
    await state.cases.save(_case(case_id="case-http", entity=Entity(type=EntityType.IP, value="10.1.2.3")))
    app = FastAPI()
    app.state.tlsoc = state
    app.include_router(routes_triage.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        res = await client.get("/api/cases/case-http/triage")
    assert res.status_code == 200
    body = res.json()
    assert body["asset_cidr"]["cidr"] == "10.0.0.0/8"
    assert body["asset_cidr"]["matches_recorded"] is None  # no recorded inputs
    assert body["auto_close_policy"]["verdict_class"] == "needs_human"


async def test_the_risk_chip_bands_the_shown_integer_on_the_four_band_ladder(app_state):
    state = app_state
    for score, display, band in ((81.11, 81, "critical"), (73.5, 74, "critical"),
                                 (47.5, 48, "high"), (21.4, 21, "low")):
        case = _case(case_id=f"case-chip-{display}", risk_score=score,
                    risk_breakdown=RiskBreakdown(total=score))
        await state.cases.save(case)
        chip = (await case_triage(case.case_id, state))["chips"]["risk"]
        assert (chip["display"], chip["band"]) == (display, band)


async def test_the_risk_definition_states_the_weights_in_force(app_state):
    state = app_state
    state.prefs.risk_weights = RiskWeights(volume=0.5, velocity=0.5, reputation=0.0,
                                           diversity=0.0, asset_criticality=0.0)
    case = _case(case_id="case-def", risk_score=10.0, risk_breakdown=RiskBreakdown(total=10.0))
    await state.cases.save(case)
    text = (await case_triage(case.case_id, state))["chips"]["risk"]["inputs"]["definition"]
    assert "Volume (50%)" in text and "Reputation (0%)" in text
    assert "today's settings" in text


async def test_the_triage_read_uses_the_execution_prefs(app_state):
    """Demo Mode reads its sandbox: the triage route answers from
    ``state.execution_prefs``, never the stored preferences."""
    from types import SimpleNamespace

    state = app_state
    case = _case(case_id="case-exec", verdict=Verdict.FALSE_POSITIVE, risk_score=10.0)
    await state.cases.save(case)
    sandbox = state.prefs.model_copy(deep=True)
    sandbox.auto_close.false_positive.enabled = not state.prefs.auto_close.false_positive.enabled
    view = SimpleNamespace(cases=state.cases, prefs=state.prefs, execution_prefs=sandbox)
    policy = (await case_triage(case.case_id, view))["auto_close_policy"]
    assert policy["enabled"] is sandbox.auto_close.false_positive.enabled


async def test_an_unknown_case_keeps_its_renderable_shell(app_state):
    res = await case_triage("nope", app_state)
    assert res["found"] is False and res["sla"] is None and res["auto_close_policy"] is None


# =========================================================================== #
# The per-case SLA reading agrees with the SLA metrics
# =========================================================================== #
NOW = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)


def _sla_prefs(**targets: SlaTarget) -> Preferences:
    prefs = Preferences()
    prefs.sla = SlaPolicy(enabled=True, targets=targets or {
        "P1": SlaTarget(response_minutes=15, resolve_minutes=240),
    })
    return prefs


def _sla_case(case_id: str, *, minutes_ago: float, status: CaseStatus = CaseStatus.OPEN,
              history: list[tuple[str, str, float]] = (), priority: str = "P1") -> Case:
    created = NOW - timedelta(minutes=minutes_ago)
    return _case(
        case_id=case_id, priority_level=priority, status=status, created_at=_iso(created),
        updated_at=_iso(NOW),
        status_history=[
            StatusHistoryEntry(from_status="open", to_status=to, by=by,
                               at=_iso(created + timedelta(minutes=after)))
            for to, by, after in history
        ],
    )


#: The shared explain contract (``webui/src/lib/explain/explain.contract.json``): the SLA
#: vectors are read from it, so the case reading and the Console cannot drift apart.
_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "webui" / "src" / "lib" / "explain"
     / "explain.contract.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize(
    "vector", _CONTRACT["sla"]["vectors"],
    ids=lambda v: f"{v['elapsed_minutes']}-{v['responded']}",
)
def test_the_sla_contract_vectors(vector: dict) -> None:
    """The explain contract's SLA vectors, through the per-case reading."""
    assert vector["clock"] == "response"
    prefs = _sla_prefs(**{vector["priority"]: SlaTarget(
        response_minutes=vector["target_minutes"], resolve_minutes=240,
    )})
    elapsed = vector["elapsed_minutes"]
    if vector["responded"]:
        case = _sla_case("c", minutes_ago=30, history=[("investigating", "alice", elapsed)],
                         priority=vector["priority"])
    else:
        case = _sla_case("c", minutes_ago=elapsed, priority=vector["priority"])
    reading = case_sla_reading(case, prefs, now=NOW)
    response = reading["clocks"]["response"]
    assert response["state"] == vector["state"]
    assert abs(response["elapsed_minutes"] - elapsed) < 1e-6
    if vector["responded"]:
        assert reading["clock"] == "resolution" and reading["anchor"] == "status_history"
    else:
        assert reading["clock"] == "response" and reading["state"] == vector["state"]
        assert reading["anchor"] == "created" and reading["responded_at"] is None


def test_escalate_then_read_shows_the_resolution_clock() -> None:
    prefs = _sla_prefs()
    case = _sla_case("c-esc", minutes_ago=60, status=CaseStatus.ESCALATED,
                     history=[("escalated", "alice", 5)])
    reading = case_sla_reading(case, prefs, now=NOW)
    assert reading["clock"] == "resolution"
    assert reading["anchor"] == "status_history"
    assert reading["responded_at"] == _iso(NOW - timedelta(minutes=55))
    assert reading["target_minutes"] == 240 and reading["state"] == "ok"
    assert reading["priority"] == "P1" and reading["priority_source"] == "case_record"


def test_the_case_reading_and_the_sla_metrics_agree_on_breach() -> None:
    prefs = _sla_prefs()
    cases = [
        _sla_case("open-ok", minutes_ago=5),
        _sla_case("open-breached", minutes_ago=40),
        _sla_case("late-response", minutes_ago=120, status=CaseStatus.INVESTIGATING,
                  history=[("investigating", "alice", 30)]),
        _sla_case("closed-by-agent-late", minutes_ago=600, status=CaseStatus.CLOSED,
                  history=[("closed", "agent", 300)]),
        _sla_case("closed-in-time", minutes_ago=600, status=CaseStatus.CLOSED,
                  history=[("investigating", "alice", 2), ("closed", "alice", 60)]),
    ]
    metrics = sla_metrics(cases, prefs.sla, now=NOW, prefs=prefs)
    breached = {row["case_id"] for row in metrics["breaching"] if row["state"] == "breached"}
    for case in cases:
        reading = case_sla_reading(case, prefs, now=NOW)
        assert reading["breached"] is (case.case_id in breached), case.case_id
    closed = case_sla_reading(cases[-1], prefs, now=NOW)
    assert closed["clock"] == "resolution" and closed["state"] == "met"


def test_a_target_past_the_last_date_is_never_due() -> None:
    prefs = _sla_prefs(P1=SlaTarget(response_minutes=10**12, resolve_minutes=10**12))
    reading = case_sla_reading(_sla_case("c-far", minutes_ago=1), prefs, now=NOW)
    assert reading["due_at"] is None and reading["state"] == "ok"


def test_no_reading_without_a_policy_or_a_target() -> None:
    off = Preferences()
    off.sla = SlaPolicy(enabled=False)
    assert case_sla_reading(_sla_case("c", minutes_ago=1), off, now=NOW) is None
    assert case_sla_reading(_sla_case("c", minutes_ago=1, priority="P9"), _sla_prefs(), now=NOW) is None


async def test_the_triage_read_serves_the_sla_reading(app_state):
    state = app_state
    case = _sla_case("case-sla", minutes_ago=5)
    await state.cases.save(case)
    sla = (await case_triage(case.case_id, state))["sla"]
    assert sla is not None and sla["clock"] == "response" and sla["priority"] == "P1"


# =========================================================================== #
# One Wilson interval: each old call site's output, exactly
# =========================================================================== #
def _old_tuner(successes, n, z=1.96):
    if n <= 0:
        return 0.0
    phat = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    centre = phat + z2 / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
    return max(0.0, min(1.0, (centre - margin) / denom))


def _old_rounded(successes, total):
    if total <= 0:
        return None
    z = 1.96
    p = successes / total
    denom = 1.0 + z * z / total
    centre = (p + z * z / (2.0 * total)) / denom
    margin = z * ((p * (1.0 - p) / total + z * z / (4.0 * total * total)) ** 0.5) / denom
    return {"low": round(max(0.0, centre - margin), 4), "high": round(min(1.0, centre + margin), 4)}


def test_wilson_golden_vectors_pin_every_call_site() -> None:
    from app.engine.agent_improvement import _wilson
    from app.engine.auto_close_review import wilson_interval
    from app.engine.threshold_tuner import wilson_lower_bound

    for n in range(0, 301):
        for s in range(0, n + 1):
            assert wilson_lower_bound(s, n) == _old_tuner(s, n)
            assert wilson_lower_bound(s, n, z=2.576) == _old_tuner(s, n, z=2.576)
            assert wilson_interval(s, n) == _old_rounded(s, n)
            assert _wilson(float(s), n) == _old_rounded(s, n)
    assert stats.wilson_interval(0, 0) is None
    low, high = stats.wilson_interval(27, 30)
    assert (round(low, 4), round(high, 4)) == (0.7438, 0.9654)


# =========================================================================== #
# The trace: span kinds, bounded detail, exact cost, truncation
# =========================================================================== #
async def test_people_chat_and_system_rows_get_their_own_kinds(app_state):
    state = app_state
    cid = "case-kinds"
    await state.cases.save(_case(case_id=cid))
    for doc in (
        AuditDoc(ts="2026-11-01T10:00:00+00:00", case_id=cid, actor="alice", actor_type="human",
                 action_type=ActionType.STATUS, result_summary="action=acknowledge"),
        AuditDoc(ts="2026-11-01T10:00:01+00:00", case_id=cid, actor="alice", actor_type="human",
                 action="case.events_viewed", action_type=ActionType.AUDIT_VIEW, surface="case",
                 result_summary="Viewed the raw events of case CASE-1."),
        AuditDoc(ts="2026-11-01T10:00:02+00:00", case_id=cid, actor="chat", actor_type="agent",
                 action_type=ActionType.PROMPT, surface="chat", prompt_excerpt="why?"),
        AuditDoc(ts="2026-11-01T10:00:03+00:00", case_id=cid, actor="automation",
                 actor_type="system", action_type=ActionType.CONTEXT, result_summary="tagged"),
        AuditDoc(ts="2026-11-01T10:00:04+00:00", case_id=cid, actor="investigator",
                 action_type=ActionType.ES_QUERY, query_text="host:web01"),
    ):
        await state.audit.write(doc)
    spans = (await case_timeline(cid, _request(state), state))["spans"]
    kinds = [s["kind"] for s in spans]
    assert kinds == ["person", "person", "chat", "system", "execute_tool"]
    assert spans[1]["summary"] == "A person viewed the case events."
    assert spans[1]["payload_ref"]["action"] == "case.events_viewed"
    # A person viewing events is never a step of the investigation narrative.
    stages = (await case_stages(cid, state))["stages"]
    investigate = next(s for s in stages if s["kind"] == "investigate")
    assert all("viewed" not in step["body"].lower() for step in investigate["steps"])


async def test_a_large_tool_input_comes_back_truncated(app_state):
    state = app_state
    cid = "case-big"
    await state.cases.save(_case(case_id=cid))
    await state.audit.write(AuditDoc(
        ts="2026-11-01T10:00:00+00:00", case_id=cid, actor="investigator",
        action_type=ActionType.TOOL_CALL, tool_name="es_query",
        tool_input={"query": "x" * 40_000}, query_text="<b>not markup</b>",
    ))
    span = (await case_timeline(cid, _request(state), state))["spans"][0]
    detail = span["detail"]
    assert detail["truncated"] is True
    assert isinstance(detail["tool_input"], str)
    assert len(detail["tool_input"].encode("utf-8")) <= 16 * 1024
    assert detail["query_text"] == "<b>not markup</b>"  # data, returned as text
    assert span["trusted"] is False


async def test_include_prompts_off_hides_the_excerpt(app_state):
    state = app_state
    cid = "case-prompts"
    await state.cases.save(_case(case_id=cid))
    await state.audit.write(AuditDoc(ts="2026-11-01T10:00:00+00:00", case_id=cid, actor="router",
                                     action_type=ActionType.PROMPT, prompt_excerpt="SECRET LOG"))
    state.prefs.trace.include_prompts = False
    span = (await case_timeline(cid, _request(state), state))["spans"][0]
    assert span["detail"]["prompt_excerpt"] is None
    assert "SECRET LOG" not in json.dumps(span)
    state.prefs.trace.include_prompts = True
    span = (await case_timeline(cid, _request(state), state))["spans"][0]
    assert span["detail"]["prompt_excerpt"] == "SECRET LOG"


async def test_501_audit_rows_say_the_trace_is_truncated(app_state):
    state = app_state
    cid = "case-501"
    await state.cases.save(_case(case_id=cid))
    start = datetime(2026, 11, 1, tzinfo=timezone.utc)
    for i in range(501):
        await state.audit.write(AuditDoc(ts=_iso(start + timedelta(seconds=i)), case_id=cid,
                                         actor="poller", action_type=ActionType.CONTEXT))
    res = await case_timeline(cid, _request(state), state)
    assert res["returned"] == 500 and res["rows_total"] == 501 and res["truncated"] is True
    stages = await case_stages(cid, state)
    assert stages["rows_total"] == 501 and stages["truncated"] is True

    small = "case-few"
    await state.cases.save(_case(case_id=small))
    await state.audit.write(AuditDoc(ts=_iso(start), case_id=small, actor="poller",
                                     action_type=ActionType.CONTEXT))
    res = await case_timeline(small, _request(state), state)
    assert res["rows_total"] == 1 and res["truncated"] is False


async def test_one_call_per_row_carries_its_own_cost_and_latency(app_state):
    state = app_state
    cid = "case-exact"
    await state.cases.save(_case(case_id=cid))
    await state.usage_store.write(UsageDoc(
        ts="2026-11-01T10:00:00.500000+00:00", case_id=cid, role="router", model="mock",
        total_tokens=25, cost=0.001, latency_ms=420))
    await state.usage_store.write(UsageDoc(
        ts="2026-11-01T10:00:03+00:00", case_id=cid, role="investigator", model="mock",
        total_tokens=150, cost=0.04, latency_ms=900))
    for ts, actor, at in (
        ("2026-11-01T10:00:00+00:00", "router", ActionType.PROMPT),
        ("2026-11-01T10:00:02+00:00", "investigator", ActionType.PROMPT),
        ("2026-11-01T10:00:05+00:00", "investigator", ActionType.VERDICT),
    ):
        await state.audit.write(AuditDoc(ts=ts, case_id=cid, actor=actor, action_type=at))
    res = await case_timeline(cid, _request(state), state)
    router = next(s for s in res["spans"] if s["name"] == "router")
    assert (router["cost"], router["latency_ms"], router["cost_basis"]) == (0.001, 420, "exact")
    inv = [s for s in res["spans"] if s["name"] == "investigator"]
    assert [s["cost_basis"] for s in inv] == ["split", "split"]
    assert all(s["latency_ms"] is None for s in inv)
    assert res["totals"]["cost"] == pytest.approx(0.041)


async def test_equal_counts_out_of_order_keep_the_even_split(app_state):
    """Review fix: as many calls as rows does not prove one call per row. Run 1 made
    three investigator calls and run 2 one, so four calls meet four rows (two prompts,
    two verdicts), but run 2's prompt would be given run 1's third call. A call that is
    not made after its own row and before the role's next row keeps the even split."""
    state = app_state
    cid = "case-mispair"
    await state.cases.save(_case(case_id=cid))
    for ts, cost in (("10:00:01", 0.01), ("10:00:02", 0.02), ("10:00:03", 0.03), ("11:00:01", 0.5)):
        await state.usage_store.write(UsageDoc(
            ts=f"2026-11-01T{ts}+00:00", case_id=cid, role="investigator", model="mock",
            total_tokens=10, cost=cost, latency_ms=100))
    for ts, at in (("10:00:00", ActionType.PROMPT), ("10:00:04", ActionType.VERDICT),
                   ("11:00:00", ActionType.PROMPT), ("11:00:02", ActionType.VERDICT)):
        await state.audit.write(AuditDoc(ts=f"2026-11-01T{ts}+00:00", case_id=cid,
                                         actor="investigator", action_type=at))
    res = await case_timeline(cid, _request(state), state)
    spans = [s for s in res["spans"] if s["name"] == "investigator"]
    assert [s["cost_basis"] for s in spans] == ["split"] * 4
    assert all(s["latency_ms"] is None for s in spans)
    assert res["totals"]["cost"] == pytest.approx(0.56)

    # Calls that follow their own rows in order still pair exactly.
    two = "case-two-runs"
    await state.cases.save(_case(case_id=two))
    for ts, cost in (("10:00:01", 0.001), ("11:00:01", 0.002)):
        await state.usage_store.write(UsageDoc(ts=f"2026-11-01T{ts}+00:00", case_id=two,
                                               role="router", model="mock", total_tokens=5,
                                               cost=cost, latency_ms=50))
    for ts in ("10:00:00", "11:00:00"):
        await state.audit.write(AuditDoc(ts=f"2026-11-01T{ts}+00:00", case_id=two,
                                         actor="router", action_type=ActionType.PROMPT))
    res = await case_timeline(two, _request(state), state)
    routers = [s for s in res["spans"] if s["name"] == "router"]
    assert [(s["cost"], s["cost_basis"]) for s in routers] == [(0.001, "exact"), (0.002, "exact")]

    # A formatter row is written just after its call: that pairs exactly too.
    after = "case-row-after-call"
    await state.cases.save(_case(case_id=after))
    for ts, cost in (("10:00:00", 0.003), ("11:00:00", 0.004)):
        await state.usage_store.write(UsageDoc(ts=f"2026-11-01T{ts}+00:00", case_id=after,
                                               role="formatter", model="mock", total_tokens=5,
                                               cost=cost, latency_ms=70))
    for ts in ("10:00:01", "11:00:01"):
        await state.audit.write(AuditDoc(ts=f"2026-11-01T{ts}+00:00", case_id=after,
                                         actor="formatter", action_type=ActionType.PROMPT))
    res = await case_timeline(after, _request(state), state)
    formatters = [s for s in res["spans"] if s["name"] == "formatter"]
    assert [(s["cost"], s["cost_basis"]) for s in formatters] == [(0.003, "exact"), (0.004, "exact")]


async def test_spend_older_than_a_year_still_counts(app_state):
    state = app_state
    cid = "case-old-spend"
    await state.cases.save(_case(case_id=cid))
    old = _iso(datetime.now(timezone.utc) - timedelta(days=400))
    await state.usage_store.write(UsageDoc(ts=old, case_id=cid, role="investigator", model="mock",
                                           total_tokens=10, cost=0.5))
    await state.audit.write(AuditDoc(ts=old, case_id=cid, actor="investigator",
                                     action_type=ActionType.VERDICT))
    res = await case_timeline(cid, _request(state), state)
    assert res["totals"]["cost"] == pytest.approx(0.5)


# =========================================================================== #
# Forwarding: the routing total behind "Why was this investigated?"
# =========================================================================== #
def test_the_forwarding_explanation_carries_the_routing_total() -> None:
    from app.engine.risk import compute_routing_risk

    prefs = Preferences(background_scan_enabled=True)
    cluster = _events_cluster(3, ip="203.0.113.90")
    cluster.is_alert = False
    out = explain_forwarding(cluster, prefs).to_dict()
    assert out["risk_floor"] == float(prefs.auto_investigate_risk_floor)
    assert out["routing_total"] == compute_routing_risk(cluster, prefs, reputation=None).total
    assert out["routing_gate_applied"] is True

    alert = _events_cluster(3, ip="203.0.113.91")
    alert.is_alert = True
    out = explain_forwarding(alert, prefs).to_dict()
    assert out["gate"] == "forwarded" and out["routing_gate_applied"] is False

    off = Preferences(background_scan_enabled=False)
    out = explain_forwarding(cluster, off).to_dict()
    assert out["gate"] == "background_scan" and out["routing_total"] is None


# =========================================================================== #
# The real Elasticsearch client reads a template (orchestrator decision 1)
# =========================================================================== #
async def test_the_real_client_reads_a_template_and_says_when_it_cannot() -> None:
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from tests.test_factory_storage_primitives import _HTTPError, _real_client

    body = {"index_patterns": ["x-*"], "template": {"mappings": {}}}
    mgmt = SimpleNamespace(indices=SimpleNamespace(get_index_template=AsyncMock(return_value={
        "index_templates": [{"name": "other", "index_template": {}}, {"name": "x", "index_template": body}],
    })))
    client = _real_client(mgmt)
    assert await client.get_index_template("x") == body
    mgmt.indices.get_index_template.assert_awaited_once_with(name="x")
    mgmt.indices.get_index_template.return_value = {"index_templates": []}
    assert await client.get_index_template("x") is None
    for status in (403, 404):
        mgmt.indices.get_index_template.side_effect = _HTTPError(status)
        with pytest.raises(NotImplementedError):
            await client.get_index_template("x")
    mgmt.indices.get_index_template.side_effect = _HTTPError(503)
    with pytest.raises(_HTTPError):
        await client.get_index_template("x")
