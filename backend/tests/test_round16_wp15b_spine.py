"""Round 16 WP15B: pipeline, ingest and job spine fixes (SPEC §4.4 WP15B).

One regression per bug, each failing before its fix: no run wipes a decided case
(B04), overrides a person (B05), rebuilds a cluster with fabricated inputs (B06),
misses a configured window (B07), loses a person's concurrent work (B08), keeps a
one-sided cross-source link (B09, the fresh write), mints a duplicate on a failed
lookup (B10), stops draining past the first page (B11), erases spend (B12), reports a
failed run as a success (B14) or collapses distinct LEEF events (B33). Plus the cases
mapping for ``risk_breakdown.inputs`` and ``awaiting_reason`` (SPEC §3.4).

``decide()`` and ``engine/risk.py`` are untouched (their hashes are pinned by
``test_round16_spine_guards.py``). Offline: fake Elasticsearch, mock model, SQLite.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio

from app.config import CorrelationRule, Preferences, RuleDefinition, RuleMatch
from app.constants import (
    CaseStatus,
    CorrelationMode,
    DecisionBy,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine.case_cluster import cluster_for_case as engine_cluster_for_case
from app.engine.correlation import cluster_from_events, correlate
from app.engine.ingest import IngestService, handle_clusters, link_cross_source
from app.engine.risk import compute_risk
from app.es.fake import InMemoryESClient
from app.constants import CASES_INDEX
from app.es import indices as indices_mod
from app.es.indices import CASES_MAPPING, bootstrap_indices, index_template_body
from app.models import Case, CaseComment, Cluster, Entity, RawEvent, RiskBreakdown, RiskInputs, TriggerReason
from app.stores.cases import CaseStore
from app.utils import iso_now, now_utc, to_millis

BASE = 1_700_000_000_000


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _route_to_investigator(mock_provider) -> None:
    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}
    ))


def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": []}],
            "mitre": ["T1110"], "recommended_action": "nothing to do",
            "reproduce_query": 'source.ip : "x"',
        },
    })


def _events(ip: str, n: int, *, start: int = BASE, role: str = "events", prefix: str = "e",
            source_id: str = "s1", span_ms: int = 1000) -> list[RawEvent]:
    return [
        RawEvent(
            id=f"{prefix}-{ip}-{i}", index="logs", source={}, timestamp_millis=start + i * span_ms,
            ip=ip, user="u", host="h", rule="r", rule_name="r", severity=3.0,
            index_role=role, source_id=source_id, source_name=source_id,
        )
        for i in range(n)
    ]


def _quiet(prefs: Preferences) -> Preferences:
    p = prefs.model_copy(deep=True)
    p.enrichment.enabled = False
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=2, window_seconds=3600, group_by=EntityType.IP,
    )
    return p


def _decided_case(cluster: Cluster, *, status: CaseStatus = CaseStatus.ESCALATED) -> Case:
    return Case(
        case_id="case-decided", case_number="CASE-0001", cluster_signature=cluster.signature,
        source_surface=SourceSurface.AUTOMATED_SCAN, entity=cluster.entity,
        source_id=cluster.source_id, member_event_ids=list(cluster.member_event_ids),
        member_event_keys=list(cluster.member_event_keys),
        verdict=Verdict.TRUE_POSITIVE, confidence=0.9, risk_score=41.0, status=status,
        decision_by=DecisionBy.SYSTEM, escalation_level=2, mitre=["T1110"],
        recommended_action="block it", created_at=iso_now(), updated_at=iso_now(),
    )


# --------------------------------------------------------------------------- #
# B04: a decided case is never rebuilt as a candidate
# --------------------------------------------------------------------------- #
async def test_b04_register_candidate_on_a_decided_case_attaches_only(app_state, mock_provider) -> None:
    prefs = _quiet(app_state.prefs)
    (first,) = correlate(_events("192.0.2.40", 3), prefs)
    decided = _decided_case(first)
    await app_state.cases.save(decided)
    (again,) = correlate(_events("192.0.2.40", 3, prefix="late", start=BASE + 60_000), prefs)
    assert again.signature == first.signature

    case = await app_state.pipeline.register_candidate(again, SourceSurface.AUTOMATED_SCAN, prefs)

    stored = await app_state.cases.get(decided.case_id)
    for c in (case, stored):
        assert c.verdict == Verdict.TRUE_POSITIVE and c.confidence == 0.9
        assert c.status == CaseStatus.ESCALATED and c.escalation_level == 2
        assert c.mitre == ["T1110"] and c.decision_by == DecisionBy.SYSTEM
    assert set(again.member_event_ids) <= set(stored.member_event_ids)
    assert mock_provider.calls == []


async def test_b04_event_detection_reentry_never_re_runs_a_decided_case(
    app_state, mock_provider, monkeypatch,
) -> None:
    from app.config import BaselineConfig, BatchConfig
    from app.engine import event_detection as evdet

    prefs = _quiet(app_state.prefs)
    prefs.batch = BatchConfig(enabled=True)
    prefs.baseline = BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1)
    await app_state.update_prefs(prefs)
    (first,) = correlate(_events("192.0.2.41", 3), prefs)
    decided = _decided_case(first)
    await app_state.cases.save(decided)
    (again,) = correlate(_events("192.0.2.41", 3, prefix="b"), prefs)

    monkeypatch.setattr(evdet, "candidate_from_json", lambda raw: object())
    monkeypatch.setattr(evdet, "results_to_candidates", lambda cands, results: [(again, None)])
    job = SimpleNamespace(id="batch-1", candidates={"c": {}})

    assert await app_state._reenter_detections(job, []) == 0  # noqa: SLF001
    stored = await app_state.cases.get(decided.case_id)
    assert stored.verdict == Verdict.TRUE_POSITIVE and stored.status == CaseStatus.ESCALATED
    assert stored.escalation_level == 2
    assert mock_provider.calls == []


async def test_b04_demo_funnel_survivor_never_re_runs_a_decided_case(
    app_state, mock_provider, monkeypatch,
) -> None:
    from app.engine import event_detection as evdet
    from app.engine.demo_runtime import DemoStack

    prefs = _quiet(app_state.prefs)
    (first,) = correlate(_events("192.0.2.42", 3), prefs)
    decided = _decided_case(first)
    await app_state.cases.save(decided)
    (again,) = correlate(_events("192.0.2.42", 3, prefix="d"), prefs)

    async def _baseline():
        return object()

    async def _flush(_baseline, _summaries):
        return None

    monkeypatch.setattr(evdet, "pre_aggregate", lambda events, p: [])
    monkeypatch.setattr(evdet, "funnel", lambda events, p, baseline: [object()])
    monkeypatch.setattr(evdet, "shape_candidate_cluster", lambda cand: again)
    stack = SimpleNamespace(
        _demo_event_prefs=lambda: prefs, _ensure_funnel_baseline=_baseline,
        _flush_funnel_baseline=_flush, sources={}, pipeline=app_state.pipeline,
    )
    assert await DemoStack.route_event_batch(stack, [object()], "xdr") == 0
    stored = await app_state.cases.get(decided.case_id)
    assert stored.verdict == Verdict.TRUE_POSITIVE and stored.status == CaseStatus.ESCALATED
    assert mock_provider.calls == []


async def test_b04_reentry_of_a_declared_benign_cluster_mints_no_second_case(
    app_state, mock_provider, monkeypatch,
) -> None:
    """A cluster the candidate path closed by an analyst rule policy needs no run: a run
    would find no open case and close a second one."""
    from app.config import BaselineConfig, BatchConfig
    from app.engine import event_detection as evdet
    from app.config import AnalystRulePolicy

    prefs = _quiet(app_state.prefs)
    prefs.batch = BatchConfig(enabled=True)
    prefs.baseline = BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1)
    prefs.analyst_rule_policies = [AnalystRulePolicy(
        id="p1", rule_id="r", reason="lab scanner", created_by="ann",
    )]
    await app_state.update_prefs(prefs)
    (cluster,) = correlate(_events("192.0.2.43", 3), prefs)
    monkeypatch.setattr(evdet, "candidate_from_json", lambda raw: object())
    monkeypatch.setattr(evdet, "results_to_candidates", lambda cands, results: [(cluster, None)])

    await app_state._reenter_detections(SimpleNamespace(id="b", candidates={"c": {}}), [])  # noqa: SLF001
    cases, total = await app_state.cases.list()
    assert total == 1 and cases[0].status == CaseStatus.CLOSED
    assert mock_provider.calls == []


# --------------------------------------------------------------------------- #
# B05: a candidate a person acted on is attach-only
# --------------------------------------------------------------------------- #
async def _person_escalates(app_state, case_id: str) -> Case:
    """What ``_perform_case_action`` does for escalate and take: a status move stamped
    ``decision_by = ANALYST``, an escalation level and an owner."""
    stored = await app_state.cases.get(case_id)
    stored.status = CaseStatus.ESCALATED
    stored.decision_by = DecisionBy.ANALYST
    stored.escalation_level = 2
    stored.assignee = "ann"
    await app_state.cases.save(stored)
    return stored


async def test_b05_one_more_event_never_forwards_a_persons_candidate(app_state, mock_provider) -> None:
    prefs = _quiet(app_state.prefs)
    prefs.background_scan_enabled = False  # the first tick only registers a candidate
    clusters = correlate(_events("192.0.2.50", 3, role="alerts"), prefs)
    await handle_clusters(clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
                          source_surface=SourceSurface.AUTOMATED_SCAN)
    (candidate,) = (await app_state.cases.list())[0]
    assert candidate.verdict is None
    await _person_escalates(app_state, candidate.case_id)

    prefs.background_scan_enabled = True  # now eligible: an alerts cluster forwards
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("FALSE_POSITIVE", 0.95))
    more = correlate(_events("192.0.2.50", 4, role="alerts"), prefs)
    stats = await handle_clusters(more, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)

    stored = await app_state.cases.get(candidate.case_id)
    assert stats["investigated"] == 0 and stats["attached"] == 1
    assert stored.status == CaseStatus.ESCALATED and stored.decision_by == DecisionBy.ANALYST
    assert stored.escalation_level == 2 and stored.assignee == "ann"
    assert len(stored.member_event_ids) == 4  # the new event attached
    assert mock_provider.calls == []


async def test_b05_an_unforced_run_attaches_and_a_forced_run_still_runs(app_state, mock_provider) -> None:
    prefs = _quiet(app_state.prefs)
    (cluster,) = correlate(_events("192.0.2.51", 3), prefs)
    candidate = await app_state.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
    await _person_escalates(app_state, candidate.case_id)
    (more,) = correlate(_events("192.0.2.51", 4), prefs)

    case = await app_state.pipeline.investigate_cluster(more, SourceSurface.AUTOMATED_SCAN, prefs)
    assert case.case_id == candidate.case_id and case.status == CaseStatus.ESCALATED
    assert mock_provider.calls == []
    rows = await app_state.audit.records_for_case(candidate.case_id)
    assert any("a person owns this candidate" in str(r.get("result_summary")) for r in rows)

    forced = await app_state.pipeline.investigate_cluster(more, SourceSurface.AUTOMATED_SCAN, prefs, force=True)
    assert forced.case_id == candidate.case_id and forced.verdict is not None
    assert mock_provider.calls  # a person can always ask for the AI


async def test_b05_a_persons_own_investigate_request_still_runs(app_state, mock_provider) -> None:
    """Review fix: the Investigate page (``POST /api/investigate``) is a person asking
    for the AI. It runs without ``force``, so the attach-only rule must hold for an
    automated run only, never for that request."""
    prefs = _quiet(app_state.prefs)
    (cluster,) = correlate(_events("192.0.2.52", 3), prefs)
    candidate = await app_state.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
    await _person_escalates(app_state, candidate.case_id)
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.4))
    (more,) = correlate(_events("192.0.2.52", 4), prefs)

    case = await app_state.pipeline.investigate_cluster(more, SourceSurface.INVESTIGATE, prefs)

    assert case.case_id == candidate.case_id and case.verdict == Verdict.NEEDS_HUMAN
    assert mock_provider.calls
    rows = await app_state.audit.records_for_case(candidate.case_id)
    assert not any("a person owns this candidate" in str(r.get("result_summary")) for r in rows)


def test_b05_the_investigate_page_runs_over_the_route(client, mock_provider) -> None:
    """End to end: a person escalates a candidate, then asks the Investigate page about
    the same address. The run happens on the same case."""
    from functools import partial

    from app.api import routes
    from app.models import InvestigateRequest
    from tests.conftest import make_log_event

    state = client.app.state.tlsoc
    ip = "192.0.2.53"
    for n in range(3):
        state.es.add_log("all-logs-2026.06.16", make_log_event(ip=ip, ts_millis=to_millis(now_utc()) - n * 1000))
    request = InvestigateRequest(entity=Entity(type=EntityType.IP, value=ip))
    cluster, _widest = client.portal.call(partial(routes._cluster_for_request, state, request))  # noqa: SLF001
    candidate = client.portal.call(partial(
        state.pipeline.register_candidate, cluster, SourceSurface.AUTOMATED_SCAN, state.execution_prefs,
    ))
    escalated = client.post(f"/api/cases/{candidate.case_id}/action", json={"action": "escalate"})
    assert escalated.status_code == 200, escalated.text
    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.4))

    response = client.post("/api/investigate", json={"entity": {"type": "ip", "value": ip}})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["case_id"] == candidate.case_id and body["verdict"] == "NEEDS_HUMAN"
    assert mock_provider.calls


# --------------------------------------------------------------------------- #
# B06: the drain and the job rebuild the same cluster as the route
# --------------------------------------------------------------------------- #
def _push_case_over_an_hour() -> Case:
    start = BASE
    end = BASE + 3_600_000
    return Case(
        case_id="case-push-hour", cluster_signature="sig-push-hour",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="192.0.2.60"),
        source_id="webhook-1", source_name="Webhook",
        member_event_ids=[f"push-{i}" for i in range(5)],
        rule_ids=["rule-a", "rule-b", "rule-c"], first_seen_millis=start,
        trigger_reason=TriggerReason(rule_value="rule-a", mode="threshold", n=5, window_seconds=3600,
                                     window_start=start, window_end=end),
        created_at=iso_now(), updated_at=iso_now(),
    )


async def test_b06_state_cluster_for_case_matches_the_route_reconstruction(app_state) -> None:
    case = _push_case_over_an_hour()
    prefs = app_state.prefs
    drained = await app_state.cluster_for_case(case)
    route = await engine_cluster_for_case(
        case, es=app_state.es, log_source=app_state.log_source, prefs=app_state.execution_prefs,
        query_source=app_state.active_source_for_id(case.source_id), allow_stored_reconstruction=True,
    )
    assert drained is not None and route is not None
    drained_risk = compute_risk(drained, prefs, 0.0)
    route_risk = compute_risk(route, prefs, 0.0)
    assert drained_risk.total == route_risk.total
    # Five events over an hour are not a burst, and three rules are three rules.
    assert drained_risk.velocity < 100
    assert sorted(drained.rule_values) == ["rule-a", "rule-b", "rule-c"]
    assert drained.signature == case.cluster_signature


async def test_b06_an_aged_out_case_is_rebuilt_for_the_job_as_for_the_route(app_state) -> None:
    case = _push_case_over_an_hour().model_copy(update={
        "case_id": "case-aged", "source_id": None, "source_name": None,
        "member_event_ids": ["gone-1", "gone-2"], "cluster_signature": "sig-aged",
    })
    cluster = await app_state.cluster_for_case(case)
    assert cluster is not None and cluster.signature == "sig-aged"


# --------------------------------------------------------------------------- #
# B07: rule-catalog correlation windows reach the look-back
# --------------------------------------------------------------------------- #
def _slow_burn_catalog() -> list[RuleDefinition]:
    return [RuleDefinition(
        name="slow_burn", match=RuleMatch(field="event.module", op="equals", value="slow_burn"),
        correlation=CorrelationRule(mode=CorrelationMode.THRESHOLD, n=6, window_seconds=3600,
                                    group_by=EntityType.IP),
    )]


def test_b07_the_widest_window_includes_enabled_catalog_rules() -> None:
    prefs = Preferences()
    prefs.rule_catalog = _slow_burn_catalog()
    assert prefs.widest_correlation_window_seconds() == 3600
    prefs.rule_catalog[0].enabled = False
    assert prefs.widest_correlation_window_seconds() == prefs.default_correlation.window_seconds
    prefs.rule_catalog[0].enabled = True
    prefs.rule_catalog[0].correlation = CorrelationRule(mode=CorrelationMode.NEVER, window_seconds=7200)
    assert prefs.widest_correlation_window_seconds() == prefs.default_correlation.window_seconds


async def test_b07_a_slow_burn_catalog_rule_fires_across_polls(app_state) -> None:
    from tests.conftest import make_log_event, seed_logs

    p = app_state.prefs.model_copy(deep=True)
    p.rule_catalog = _slow_burn_catalog()
    p.poll_interval_seconds = 10
    p.enrichment.enabled = False
    await app_state.update_prefs(p)
    now = to_millis(now_utc())
    for i in range(6):  # one event every 5 minutes, one poll per event
        seed_logs(app_state.es, [make_log_event(ip="192.0.2.70", rule="slow_burn",
                                                ts_millis=now - (25 - 5 * i) * 60_000)])
        await app_state.poller.poll_once(app_state.prefs)
    cases, total = await app_state.cases.list()
    assert total == 1 and len(cases[0].member_event_ids) == 6


async def test_b07_a_slow_burn_catalog_rule_fires_across_push_deliveries(app_state) -> None:
    p = app_state.prefs.model_copy(deep=True)
    p.rule_catalog = _slow_burn_catalog()
    p.enrichment.enabled = False
    await app_state.update_prefs(p)
    service = IngestService(app_state.cases, app_state.audit, app_state.pipeline, lambda: app_state.prefs)
    now = to_millis(now_utc())
    for i in range(6):  # six deliveries, 5 minutes apart: far under the 500-event ring
        event = RawEvent(
            id=f"slow-{i}", source={"event": {"module": "slow_burn"}},
            timestamp_millis=now - (25 - 5 * i) * 60_000, ip="192.0.2.71", rule="slow_burn",
            rule_name="slow_burn", severity=3.0,
        )
        await service.ingest([event], app_state.prefs, source_id="push-slow")
    cases, total = await app_state.cases.list()
    assert total == 1 and len(cases[0].member_event_ids) == 6


# --------------------------------------------------------------------------- #
# B08: automation keeps a person's concurrent work
# --------------------------------------------------------------------------- #
async def test_b08_automation_merges_onto_the_case_as_stored(app_state) -> None:
    from app.config import AutomationRule, ThresholdAutomationConfig
    from app.engine.threshold_automation import ThresholdAutomation

    case = Case(case_id="case-auto", cluster_signature="sig-auto", source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="192.0.2.80"), verdict=Verdict.TRUE_POSITIVE,
                confidence=0.9, risk_score=80.0, status=CaseStatus.ESCALATED, tags=["seen"])
    await app_state.cases.save(case)

    async def _notify(_case, _trigger):
        # A person acknowledges, takes and comments on the case while the send is out.
        stored = await app_state.cases.get("case-auto")
        stored.status = CaseStatus.INVESTIGATING
        stored.decision_by = DecisionBy.ANALYST
        stored.assignee = "ann"
        stored.comments = [*stored.comments, CaseComment(author="ann", body="on it")]
        await app_state.cases.save(stored)
        return [{"ok": True}]

    prefs = Preferences()
    prefs.threshold_automation = ThresholdAutomationConfig(enabled=True, rules=[
        AutomationRule(id="t", action="tag", priority=1, payload={"tag": "auto"}),
        AutomationRule(id="n", action="notify", priority=2, payload={"trigger": "escalated"}),
        AutomationRule(id="r", action="recommend", priority=3, payload={"text": "isolate"}),
    ])
    automation = ThresholdAutomation(app_state.proposals, app_state.audit, notify=_notify)
    await automation.run(case, prefs, save=app_state.cases.save, fetch=app_state.cases.get)

    stored = await app_state.cases.get("case-auto")
    assert stored.status == CaseStatus.INVESTIGATING and stored.assignee == "ann"
    assert stored.decision_by == DecisionBy.ANALYST
    assert [c.body for c in stored.comments] == ["on it", "[automation recommendation] isolate"]
    assert stored.tags == ["seen", "auto"]
    assert [a["rule_id"] for a in stored.automation_actions] == ["t", "n", "r"]


async def test_b08_the_pipeline_passes_the_store_read(app_state, monkeypatch) -> None:
    seen: dict[str, Any] = {}

    class _Automation:
        async def run(self, case, prefs, *, save, fetch=None):
            seen["fetch"] = fetch
            return case

    monkeypatch.setattr(app_state.pipeline, "automation", _Automation(), raising=False)
    case = Case(case_id="c", cluster_signature="s", source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="192.0.2.81"))
    await app_state.pipeline._maybe_automate(case, Preferences())  # noqa: SLF001
    assert seen["fetch"] is not None


# --------------------------------------------------------------------------- #
# B09: cross-source links are written to the case as stored now
# --------------------------------------------------------------------------- #
async def test_b09_a_stale_pool_copy_never_overwrites_a_persons_work(app_state, monkeypatch) -> None:
    from app.engine import correlation as correlation_mod

    prefs = _quiet(app_state.prefs)
    prefs.cross_source_correlation.enabled = True
    (cluster_a,) = correlate(_events("192.0.2.90", 3, source_id="s1"), prefs)
    case_a = Case(case_id="case-a", cluster_signature=cluster_a.signature, source_surface=SourceSurface.AUTOMATED_SCAN,
                  entity=cluster_a.entity, source_id="s1", created_at=iso_now(), updated_at=iso_now())
    case_b = Case(case_id="case-b", cluster_signature="sig-b", source_surface=SourceSurface.AUTOMATED_SCAN,
                  entity=Entity(type=EntityType.IP, value="192.0.2.90"), source_id="s2",
                  created_at=iso_now(), updated_at=iso_now())
    await app_state.cases.save(case_a)
    await app_state.cases.save(case_b)
    stale_b = (await app_state.cases.get("case-b")).model_copy(deep=True)
    # A person works on B after the link pass read its pool.
    fresh_b = await app_state.cases.get("case-b")
    fresh_b.status = CaseStatus.ESCALATED
    fresh_b.decision_by = DecisionBy.ANALYST
    fresh_b.assignee = "ann"
    await app_state.cases.save(fresh_b)

    class _PoolStore:
        def __getattr__(self, name):
            return getattr(app_state.cases, name)

        async def list(self, *args, **kwargs):
            return [stale_b], 1

    monkeypatch.setattr(correlation_mod, "cross_source_correlate", lambda items, p, component_seeds=None: [
        {"cross_source_cluster_id": "a" * 16, "members": ["case-a", "case-b"]},
    ])
    linked = await link_cross_source([cluster_a], prefs, cases=_PoolStore(), pipeline=app_state.pipeline)
    assert linked == 2
    stored_b = await app_state.cases.get("case-b")
    assert stored_b.status == CaseStatus.ESCALATED and stored_b.assignee == "ann"
    assert stored_b.related_case_ids == ["case-a"] and stored_b.cross_source_cluster_id == "a" * 16
    stored_a = await app_state.cases.get("case-a")
    assert stored_a.related_case_ids == ["case-b"]


def test_b09_both_link_call_sites_pass_the_pipeline() -> None:
    import inspect

    from app.engine import ingest, poller

    for module in (ingest, poller):
        source = inspect.getsource(module)
        assert "link_cross_source(" in source
        for chunk in source.split("await link_cross_source(")[1:]:
            assert "pipeline=self._pipeline" in chunk.split(")")[0]


# --------------------------------------------------------------------------- #
# B10: a failed identity lookup mints no case
# --------------------------------------------------------------------------- #
async def test_b10_a_failed_lookup_raises_and_mints_no_second_case(app_state, monkeypatch) -> None:
    prefs = _quiet(app_state.prefs)
    (cluster,) = correlate(_events("192.0.2.100", 3), prefs)
    await app_state.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
    store = app_state.pipeline._cases  # noqa: SLF001
    real = store.find_open_by_signature
    calls = {"n": 0}

    async def _flaky(signature):
        calls["n"] += 1
        if calls["n"] == 1:
            raise TimeoutError("search timed out")
        return await real(signature)

    monkeypatch.setattr(store, "find_open_by_signature", _flaky)
    with pytest.raises(TimeoutError):
        await app_state.pipeline.investigate_cluster(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
    cases, total = await app_state.cases.list()
    assert total == 1 and cases[0].status == CaseStatus.OPEN


# --------------------------------------------------------------------------- #
# B11: the deferred drain reads the deferred queue itself
# --------------------------------------------------------------------------- #
class _RealisticES(InMemoryESClient):
    """Elasticsearch's paging limits: ``from + size`` past the result window is
    rejected and, without ``track_total_hits``, the total stops at the window."""

    window = 100

    def __init__(self) -> None:
        super().__init__()
        self.searches = 0

    async def search(self, index, body):
        self.searches += 1
        if int(body.get("from", 0) or 0) + int(body.get("size", 10) or 0) > self.window:
            raise RuntimeError("Result window is too large")
        resp = await super().search(index, body)
        if "track_total_hits" not in body:
            total = resp["hits"]["total"]
            if int(total.get("value", 0)) > self.window:
                resp["hits"]["total"] = {"value": self.window, "relation": "gte"}
        return resp


def _open_candidate(i: int, *, reason: str, created: str, updated: str, **extra) -> Case:
    return Case(
        case_id=f"case-{i:05d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=f"198.51.100.{i % 250}"), status=CaseStatus.OPEN,
        awaiting_reason=reason, created_at=created, updated_at=updated, **extra,
    )


@pytest_asyncio.fixture
async def drain_state(app_state, monkeypatch):
    es = _RealisticES()
    store = CaseStore(es)
    monkeypatch.setattr(app_state, "_real_cases", store)
    drained: list[str] = []

    async def _cluster_for(case):
        if case.case_id == "case-unrebuildable":
            return None
        return SimpleNamespace(signature=case.cluster_signature)

    async def _investigate(cluster, *_args, **_kwargs):
        drained.append(cluster.signature)

    monkeypatch.setattr(app_state, "cluster_for_case", _cluster_for)
    monkeypatch.setattr(app_state.real_pipeline, "investigate_cluster", _investigate)
    return SimpleNamespace(state=app_state, es=es, store=store, drained=drained)


async def test_b11_a_deferred_candidate_past_the_first_page_still_drains(drain_state) -> None:
    for i in range(150):  # older below-floor candidates: never drained
        await drain_state.store.save(_open_candidate(
            i, reason="available-signal routing score 20 is below the auto-investigate floor 70",
            created=f"2026-11-01T00:{i // 60:02d}:{i % 60:02d}+00:00", updated="2026-11-01T01:00:00+00:00",
        ))
    await drain_state.store.save(_open_candidate(
        999, reason="deferred: per-tick auto-investigation cap reached",
        created="2026-11-02T00:00:00+00:00", updated="2026-11-02T00:00:00+00:00",
    ))
    drain_state.es.searches = 0
    prefs = drain_state.state.prefs
    n = await drain_state.state.poller._drain_deferred(  # noqa: SLF001
        prefs, older_than="2026-11-03T00:00:00+00:00", limit=1,
    )
    assert n == 1 and drain_state.drained == ["sig-999"]
    assert drain_state.es.searches <= 2


async def test_b11_an_unrebuildable_oldest_candidate_never_blocks_the_next(drain_state) -> None:
    reason = "deferred: per-tick auto-investigation cap reached"
    await drain_state.store.save(_open_candidate(
        1, reason=reason, created="2026-11-01T00:00:00+00:00", updated="2026-11-01T00:00:00+00:00",
    ).model_copy(update={"case_id": "case-unrebuildable"}))
    await drain_state.store.save(_open_candidate(
        2, reason=reason, created="2026-11-01T00:00:01+00:00", updated="2026-11-01T00:00:01+00:00",
    ))
    # Not drainable: decided, deferred this tick, owned by a person, not deferred.
    await drain_state.store.save(_open_candidate(
        3, reason=reason, created="2026-11-01T00:00:02+00:00", updated="2026-11-01T00:00:02+00:00",
        verdict=Verdict.NEEDS_HUMAN,
    ))
    await drain_state.store.save(_open_candidate(
        4, reason=reason, created="2026-11-01T00:00:03+00:00", updated="2026-11-04T00:00:00+00:00",
    ))
    await drain_state.store.save(_open_candidate(
        5, reason=reason, created="2026-11-01T00:00:04+00:00", updated="2026-11-01T00:00:04+00:00",
        decision_by=DecisionBy.ANALYST,
    ))
    prefs = drain_state.state.prefs
    n = await drain_state.state.poller._drain_deferred(  # noqa: SLF001
        prefs, older_than="2026-11-03T00:00:00+00:00", limit=1,
    )
    assert n == 1 and drain_state.drained == ["sig-2"]
    n = await drain_state.state.poller._drain_deferred(  # noqa: SLF001
        prefs, older_than="2026-11-03T00:00:00+00:00", limit=5,
    )
    assert n == 1 and drain_state.drained == ["sig-2", "sig-2"]


async def test_b11_candidates_people_own_never_fill_the_drains_page(drain_state) -> None:
    """Review fix: the store leaves out a candidate a person acted on. A person can
    leave a deferred candidate OPEN (classify it, de-escalate it, resume it, reopen
    it); when more of those than one page sat at the front of the queue, the drain
    read only them each tick and never reached a candidate behind them."""
    from app.stores.base import CaseRepository

    reason = "deferred: per-tick auto-investigation cap reached"
    for i in range(60):
        await drain_state.store.save(_open_candidate(
            i, reason=reason, created=f"2026-11-01T00:00:{i:02d}+00:00",
            updated="2026-11-01T01:00:00+00:00", decision_by=DecisionBy.ANALYST,
        ))
    await drain_state.store.save(_open_candidate(
        500, reason=reason, created="2026-11-01T02:00:00+00:00", updated="2026-11-01T02:00:00+00:00",
    ))
    prefs = drain_state.state.prefs
    n = await drain_state.state.poller._drain_deferred(  # noqa: SLF001
        prefs, older_than="2026-11-03T00:00:00+00:00", limit=1,
    )
    assert n == 1 and drain_state.drained == ["sig-500"]
    # The paged scan a third-party store inherits applies the same rule.
    scanned = await CaseRepository.list_deferred_candidates(
        drain_state.store, older_than="2026-11-03T00:00:00+00:00", limit=5,
    )
    assert [c.case_id for c in scanned] == ["case-00500"]


async def test_b11_the_sql_store_answers_the_deferred_queue_in_one_query() -> None:
    from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        repo = SqlCaseRepository(engine)
        reason = "deferred: per-tick auto-investigation cap reached"
        await repo.save(_open_candidate(1, reason="below floor", created="2026-11-01T00:00:00+00:00",
                                        updated="2026-11-01T00:00:00+00:00"))
        await repo.save(_open_candidate(2, reason=reason, created="2026-11-01T00:00:02+00:00",
                                        updated="2026-11-01T00:00:02+00:00"))
        await repo.save(_open_candidate(3, reason=reason, created="2026-11-01T00:00:01+00:00",
                                        updated="2026-11-01T00:00:01+00:00"))
        await repo.save(_open_candidate(4, reason=reason, created="2026-11-01T00:00:00+00:00",
                                        updated="2026-11-01T00:00:00+00:00", verdict=Verdict.NEEDS_HUMAN))
        await repo.save(_open_candidate(5, reason=reason, created="2026-11-01T00:00:00+00:00",
                                        updated="2026-11-05T00:00:00+00:00"))
        # A candidate a person acted on is never drained, so the query leaves it out.
        await repo.save(_open_candidate(6, reason=reason, created="2026-11-01T00:00:00+00:00",
                                        updated="2026-11-01T00:00:00+00:00", decision_by=DecisionBy.ANALYST))
        found = await repo.list_deferred_candidates(older_than="2026-11-03T00:00:00+00:00", limit=10)
        assert [c.case_id for c in found] == ["case-00003", "case-00002"]
        one = await repo.list_deferred_candidates(older_than="2026-11-03T00:00:00+00:00", limit=1)
        assert [c.case_id for c in one] == ["case-00003"]
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# B12: a failed run keeps the case's spend
# --------------------------------------------------------------------------- #
async def test_b12_a_failed_run_keeps_the_stored_cost_and_adopts_the_ledger(app_state, monkeypatch) -> None:
    import app.agents.pipeline as pipeline_mod

    prefs = _quiet(app_state.prefs)
    (cluster,) = correlate(_events("192.0.2.120", 3), prefs)
    candidate = await app_state.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
    stored = await app_state.cases.get(candidate.case_id)
    stored.token_cost = 0.4321
    await app_state.cases.save(stored)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("formatter fell over")

    monkeypatch.setattr(pipeline_mod, "run_investigation", _boom)
    gateway = app_state.pipeline._gateway  # noqa: SLF001
    ledger = {"total": 0.61}

    async def _recorded(_case_id):
        return ledger["total"]

    monkeypatch.setattr(gateway, "recorded_case_pipeline_cost", _recorded)
    case = await app_state.pipeline.investigate_cluster(cluster, SourceSurface.AUTOMATED_SCAN, prefs, force=True)
    assert case.title.startswith("[FAILED]") and case.token_cost == pytest.approx(0.61)
    assert (await app_state.cases.get(case.case_id)).token_cost == pytest.approx(0.61)

    ledger["total"] = 0.01  # a stale ledger read never lowers the stored total
    case = await app_state.pipeline.investigate_cluster(cluster, SourceSurface.AUTOMATED_SCAN, prefs, force=True)
    assert case.token_cost == pytest.approx(0.61)


# --------------------------------------------------------------------------- #
# B14: a failed reinvestigation fails its job item
# --------------------------------------------------------------------------- #
async def test_b14_a_failed_reinvestigation_fails_the_item(app_state, monkeypatch) -> None:
    import app.agents.pipeline as pipeline_mod

    prefs = _quiet(app_state.prefs)
    (cluster,) = correlate(_events("192.0.2.140", 3), prefs)
    candidate = await app_state.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)

    async def _cluster_for(_case):
        return cluster

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("provider down: token sk-live-secret")

    monkeypatch.setattr(app_state, "cluster_for_case", _cluster_for)
    monkeypatch.setattr(pipeline_mod, "run_investigation", _boom)
    runner = app_state.job_runner
    outcomes: dict[str, str] = {}

    async def _items(job, _token, run, *, result_kind):
        for item in job.item_states:
            try:
                await run(item)
                outcomes[item] = "succeeded"
            except Exception as exc:  # noqa: BLE001 - the real loop isolates each item
                outcomes[item] = runner._reason(exc)  # noqa: SLF001

    monkeypatch.setattr(runner, "_item_loop", _items)
    job = SimpleNamespace(job_id="job-1", actor="ann", params={}, item_states={candidate.case_id: "pending"})
    await runner._case_reinvestigate(job, "token")  # noqa: SLF001
    reason = outcomes[candidate.case_id]
    assert reason.startswith("The automated investigation failed")
    assert "sk-live" not in reason


# --------------------------------------------------------------------------- #
# B33: distinct LEEF events of one event type keep distinct ids
# --------------------------------------------------------------------------- #
_LEEF = (
    "LEEF:1.0|IBM|QRadar|7.5|LoginFailed|src=192.0.2.{n}\tusrName=user{n}\tdevTime=Nov 24 2026 10:00:0{n}"
)


async def test_b33_same_type_leef_events_all_reach_correlation(app_state) -> None:
    from app.connectors.receivers.webhook import WebhookReceiver
    from app.engine.ingest import dedup_by_id, ensure_push_event_ids

    receiver = WebhookReceiver(connector_id="qradar-push", config={"format_hint": "leef"})
    payload = "\n".join(_LEEF.format(n=n) for n in (1, 2, 3))
    events = receiver.parse(payload, app_state.prefs)
    ids = {e.id for e in events}
    assert len(events) == 3 and len(ids) == 3
    assert all(e.source.get("event_id") == "LoginFailed" for e in events)  # the rule field stays
    assert len(dedup_by_id(ensure_push_event_ids(events, "qradar-push"))) == 3

    service = IngestService(app_state.cases, app_state.audit, app_state.pipeline, lambda: app_state.prefs)
    stats = await service.ingest(events, app_state.prefs, source_id="qradar-push")
    assert stats["received"] == 3
    # A second delivery of the same type inside the look-back is not a duplicate either.
    later = receiver.parse(_LEEF.format(n=4), app_state.prefs)
    assert later[0].id not in ids
    assert (await service.ingest(later, app_state.prefs, source_id="qradar-push"))["received"] == 1
    tail = service.recent_events_for_source("qradar-push", limit=10)
    assert len({e.id for e in tail}) == 4


def test_b33_a_leef_vendor_id_attribute_still_identifies_an_event() -> None:
    from app.ocsf.identity import native_event_uid

    assert native_event_uid({"leef_version": "1.0", "event_id": "LoginFailed"}) is None
    assert native_event_uid({"leef_version": "1.0", "event_id": "LoginFailed", "id": "q-77"}) == "q-77"
    assert native_event_uid({"event_id": "evt-1"}) == "evt-1"  # not LEEF: unchanged


# --------------------------------------------------------------------------- #
# The cases mapping (SPEC §3.4): inputs stored, never indexed
# --------------------------------------------------------------------------- #
def _inputs_case(case_id: str, rule_value: str) -> Case:
    return Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="192.0.2.150"),
        risk_breakdown=RiskBreakdown(total=10.0, inputs=RiskInputs(event_count=3, rule_values=[rule_value],
                                                                    rule_type_count=1)),
    )


class _DynamicMappingES(InMemoryESClient):
    """Elasticsearch's dynamic mapping on the cases indices, with date detection: a
    string that looks like a date maps its field as ``date``, and a later document
    with ordinary text there is rejected. An object mapped ``enabled: false`` is not
    parsed at all."""

    async def index_doc(self, index, doc, doc_id=None, refresh=False):
        if index.startswith(CASES_INDEX):
            target = self._resolve(index) if index in self.alias_to_index else f"{index}-000001"
            mapping = self.index_mappings.setdefault(target, {})
            self._map(mapping.setdefault("properties", {}), doc, prefix="")
        return await super().index_doc(index, doc, doc_id=doc_id, refresh=refresh)

    def _map(self, properties: dict, value: dict, *, prefix: str) -> None:
        for key, item in value.items():
            spec = properties.get(key)
            if isinstance(spec, dict) and spec.get("enabled") is False:
                continue
            if isinstance(item, dict):
                child = properties.setdefault(key, {"properties": {}})
                self._map(child.setdefault("properties", {}), item, prefix=f"{prefix}{key}.")
                continue
            values = item if isinstance(item, list) else [item]
            for one in values:
                if not isinstance(one, str):
                    continue
                looks_like_date = len(one) >= 10 and one[4:5] == "-" and one[:4].isdigit()
                if spec is None:
                    spec = properties[key] = {"type": "date" if looks_like_date else "text"}
                elif spec.get("type") == "date" and not looks_like_date:
                    raise RuntimeError(f"mapper_parsing_exception: failed to parse field [{prefix}{key}] of type [date]")


async def test_a_fresh_bootstrap_maps_inputs_stored_and_never_indexed() -> None:
    es = InMemoryESClient()
    await bootstrap_indices(es)
    template = await es.get_index_template(f"{CASES_INDEX}-template")
    props = template["template"]["mappings"]["properties"]
    assert props["risk_breakdown"]["properties"]["inputs"] == {"type": "object", "enabled": False}
    assert props["awaiting_reason"] == {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 256}}}
    live = await es.get_index_mapping(f"{CASES_INDEX}-000001")
    assert live[f"{CASES_INDEX}-000001"]["mappings"]["properties"]["risk_breakdown"]["properties"]["inputs"][
        "enabled"] is False
    assert indices_mod.cases_risk_inputs_storable(es) is True


async def test_an_upgraded_index_gains_the_inputs_mapping() -> None:
    es = InMemoryESClient()
    old = json.loads(json.dumps(CASES_MAPPING))
    old["properties"]["risk_breakdown"] = {"type": "object", "enabled": True}
    del old["properties"]["awaiting_reason"]
    await es.put_index_template(f"{CASES_INDEX}-template", index_template_body(CASES_INDEX, old))
    await es.create_index(f"{CASES_INDEX}-000001", {"aliases": {CASES_INDEX: {"is_write_index": True}}})

    await bootstrap_indices(es)
    live = (await es.get_index_mapping(f"{CASES_INDEX}-000001"))[f"{CASES_INDEX}-000001"]["mappings"]
    assert live["properties"]["risk_breakdown"]["properties"]["inputs"] == {"type": "object", "enabled": False}
    assert "awaiting_reason" in live["properties"]
    template = await es.get_index_template(f"{CASES_INDEX}-template")
    assert template["template"]["mappings"]["properties"]["risk_breakdown"]["properties"]["inputs"]["enabled"] is False
    assert indices_mod.cases_risk_inputs_storable(es) is True
    assert await indices_mod.extend_cases_mapping(es) == "present"  # idempotent


async def test_a_client_that_cannot_extend_leaves_inputs_out_and_the_save_lands() -> None:
    class _NoMappingES(InMemoryESClient):
        async def get_index_mapping(self, index):
            raise NotImplementedError("no mapping API")

    es = _NoMappingES()
    old = json.loads(json.dumps(CASES_MAPPING))
    old["properties"]["risk_breakdown"] = {"type": "object", "enabled": True}
    await es.put_index_template(f"{CASES_INDEX}-template", index_template_body(CASES_INDEX, old))
    await es.create_index(f"{CASES_INDEX}-000001", {"aliases": {CASES_INDEX: {"is_write_index": True}}})
    await bootstrap_indices(es)
    assert indices_mod.cases_risk_inputs_storable(es) is False

    store = CaseStore(es)
    await store.save(_inputs_case("case-no-inputs", "linux_auth"))
    back = await store.get("case-no-inputs")
    assert back is not None and back.risk_breakdown.total == 10.0
    assert back.risk_breakdown.inputs is None  # reads "not recorded"


async def test_a_date_like_rule_value_never_fails_a_later_case_save() -> None:
    es = _DynamicMappingES()
    await bootstrap_indices(es)
    store = CaseStore(es)
    await store.save(_inputs_case("case-date", "2026-01-01"))
    await store.save(_inputs_case("case-text", "linux_auth"))
    assert (await store.get("case-date")).risk_breakdown.inputs.rule_values == ["2026-01-01"]
    assert (await store.get("case-text")).risk_breakdown.inputs.rule_values == ["linux_auth"]


async def test_the_dynamic_mapping_stand_in_fails_without_the_explicit_mapping() -> None:
    """The stand-in is faithful: on an index that maps ``risk_breakdown`` dynamically
    the second save fails, which is what the explicit mapping prevents."""
    es = _DynamicMappingES()
    old = json.loads(json.dumps(CASES_MAPPING))
    old["properties"]["risk_breakdown"] = {"type": "object", "enabled": True}
    await es.put_index_template(f"{CASES_INDEX}-template", index_template_body(CASES_INDEX, old))
    store = CaseStore(es)
    await store.save(_inputs_case("case-date", "2026-01-01"))
    with pytest.raises(RuntimeError, match="mapper_parsing_exception"):
        await store.save(_inputs_case("case-text", "linux_auth"))


def _shipped_client(*, template_exists: bool, index_exists: bool, live: dict | None = None):
    """The shipped Elasticsearch client over a stand-in management connection. It can
    read and extend index mappings but has no ``get_index_template``."""
    from unittest.mock import AsyncMock

    from tests.test_factory_storage_primitives import _real_client

    mgmt = SimpleNamespace(indices=SimpleNamespace(
        exists_index_template=AsyncMock(return_value=template_exists),
        put_index_template=AsyncMock(return_value={"acknowledged": True}),
        exists=AsyncMock(return_value=index_exists),
        create=AsyncMock(return_value={"acknowledged": True}),
        get_mapping=AsyncMock(return_value=live or {}),
        put_mapping=AsyncMock(return_value={"acknowledged": True}),
    ))
    return _real_client(mgmt), mgmt


async def test_the_shipped_client_stores_inputs_on_a_fresh_install() -> None:
    client, _mgmt = _shipped_client(template_exists=False, index_exists=False)
    assert getattr(client, "get_index_template", None) is None
    await bootstrap_indices(client)
    assert indices_mod.cases_risk_inputs_storable(client) is True


async def test_the_shipped_client_on_an_upgrade_says_what_it_cannot_read(caplog) -> None:
    """Review fix: the shipped client reads and extends index mappings; what it cannot
    read is the cases template. The warning says so, and the case store leaves the
    recorded inputs out (SPEC §3.4)."""
    import logging

    live = {f"{CASES_INDEX}-000001": {"mappings": {"properties": {
        "risk_breakdown": {"properties": {"total": {"type": "float"}}},
    }}}}
    client, _mgmt = _shipped_client(template_exists=True, index_exists=True, live=live)
    with caplog.at_level(logging.WARNING, logger="tlsoc.es.indices"):
        assert await indices_mod.extend_cases_mapping(client) == "unsupported"
    assert indices_mod.cases_risk_inputs_storable(client) is False
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "cannot read the cases index template" in text
    assert "cannot read or extend index mappings" not in text


def test_cluster_helpers_are_shared() -> None:
    """The drain, the job and the route rebuild through one helper."""
    import inspect

    import app.state as state_mod

    source = inspect.getsource(state_mod.AppState._automation_cluster_for_case)  # noqa: SLF001
    assert "engine_cluster_for_case" in source and "allow_stored_reconstruction=True" in source
    assert "timestamp_millis=case.first_seen_millis" not in source
    assert cluster_from_events is not None  # kept importable for the other helpers
