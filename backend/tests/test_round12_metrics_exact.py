"""Round 12 (WP-AGG): dashboards read exact populations, not the newest 5,000 cases.

* ``api.metrics_shared.fetch_case_population`` — every case a rollup's window can
  reach (the window pushed into the store) plus exact store-wide counts, behind the
  same 5 s single-flight cache; bounded memory with an honest ceiling.
* ``engine.metrics`` — SLA attainment is ``None`` (not 0%) when nothing was scored; an
  additive ``analyst_confirmed_fp`` count sits beside the AI-verdict FP rate in the
  posture quality block, its period comparison and every trend bucket; posture's
  ``open_now`` takes the exact store count.
* ``routes_metrics`` — agent-improvement cost evidence reads every ledger row in its
  span (no newest-5,000 cap).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.api import metrics_shared
from app.api.metrics_shared import fetch_case_population
from app.config import SlaPolicy
from app.constants import CaseStatus, DecisionBy, Disposition, EntityType, SourceSurface, Verdict
from app.engine import metrics as M
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, FeedbackEntry, UsageDoc
from app.stores.cases import CaseStore

UTC = timezone.utc


def _now() -> datetime:
    return datetime.now(UTC)


def _case(cid: str, *, hours_ago: float = 1.0, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid, "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": (_now() - timedelta(hours=hours_ago)).isoformat(),
    }
    base.update(kw)
    return Case(**base)


class CountingStore(CaseStore):
    """A real Elasticsearch-shaped store that counts scans and count push-downs."""

    def __init__(self) -> None:
        super().__init__(InMemoryESClient())
        self.scans = 0
        self.aggregates = 0

    async def scan_page(self, **kw):
        if kw.get("cursor") is None:
            self.scans += 1
        return await super().scan_page(**kw)

    async def aggregate(self, spec):
        self.aggregates += 1
        return await super().aggregate(spec)


# --------------------------------------------------------------------------- #
# fetch_case_population
# --------------------------------------------------------------------------- #
async def test_population_is_the_exact_window_plus_exact_store_counts() -> None:
    store = CountingStore()
    for i, hours in enumerate((1, 5, 23, 30, 200, 900)):
        await store.save(_case(f"c{i}", hours_ago=hours,
                               status=CaseStatus.OPEN if i % 2 == 0 else CaseStatus.CLOSED))
    await store.save(_case("junk", created_at="not-a-date", status=CaseStatus.OPEN))
    pop = await fetch_case_population(store, span_hours=24, limit=100)
    assert [c.case_id for c in pop.cases] == ["c0", "c1", "c2"]  # newest first
    assert pop.in_scope == 3 and pop.complete and pop.load_ok
    assert pop.store_total == 7 and pop.open_now == 4  # junk is open: counted, never dropped
    assert pop.fetched == pop.scope_total == 3 and not pop.truncated
    everything = await fetch_case_population(store, span_hours=None, limit=100)
    assert everything.in_scope == 7 and len(everything.cases) == 7


async def test_population_retention_ceiling_keeps_the_newest_and_says_so() -> None:
    store = CountingStore()
    for i in range(5):
        await store.save(_case(f"c{i}", hours_ago=i + 1))
    pop = await fetch_case_population(store, span_hours=24, limit=3)
    assert [c.case_id for c in pop.cases] == ["c0", "c1", "c2"]
    assert pop.in_scope == 5 and not pop.complete and pop.truncated
    assert pop.fetched == 3 and pop.scope_total == 5
    assert "newest 3" in pop.error
    # The store-wide counts stay exact regardless of the ceiling.
    assert pop.store_total == 5 and pop.open_now == 5


async def test_population_cache_single_flight_and_covering_reuse() -> None:
    store = CountingStore()
    for i in range(4):
        await store.save(_case(f"c{i}", hours_ago=i * 10 + 1))
    first, second = await asyncio.gather(
        fetch_case_population(store, span_hours=48, limit=100),
        fetch_case_population(store, span_hours=48, limit=100),
    )
    assert store.scans == 1  # concurrent misses shared one scan
    assert first.cases == second.cases and first.cases is not second.cases  # own lists
    # Created 1h, 11h, 21h and 31h ago: all four are inside 48 hours.
    assert [c.case_id for c in first.cases] == ["c0", "c1", "c2", "c3"]
    narrower = await fetch_case_population(store, span_hours=24, limit=100)
    assert store.scans == 1  # a wider fresh population covers it...
    # ...narrowed EXACTLY, so the marker never depends on what happened to be cached.
    assert [c.case_id for c in narrower.cases] == ["c0", "c1", "c2"]
    assert narrower.in_scope == 3 and narrower.span_hours == 24 and narrower.complete
    tight = await fetch_case_population(store, span_hours=12, limit=100)
    assert [c.case_id for c in tight.cases] == ["c0", "c1"] and tight.in_scope == 2
    assert store.scans == 1
    wider = await fetch_case_population(store, span_hours=72, limit=100)
    assert wider.in_scope == 4 and store.scans == 2
    other_limit = await fetch_case_population(store, span_hours=24, limit=50)
    assert other_limit.in_scope == 3 and store.scans == 3  # the limit is part of the key
    other_store = CountingStore()
    assert (await fetch_case_population(other_store, span_hours=24, limit=100)).store is other_store
    metrics_shared.invalidate_case_page_cache()  # the conftest reset clears populations too
    await fetch_case_population(store, span_hours=24, limit=100)
    assert store.scans == 4


async def test_population_store_outage_is_not_measured_and_not_cached() -> None:
    store = CountingStore()
    await store.save(_case("c0"))

    async def boom(**_kw):
        raise RuntimeError("store down")

    original = store.scan_page
    store.scan_page = boom  # type: ignore[method-assign]
    pop = await fetch_case_population(store, span_hours=24, limit=10)
    assert pop.load_ok is False and pop.cases == [] and not pop.complete
    assert pop.store_total is None and pop.open_now is None and "store down" in pop.error
    store.scan_page = original  # type: ignore[method-assign]
    recovered = await fetch_case_population(store, span_hours=24, limit=10)
    assert recovered.load_ok and len(recovered.cases) == 1  # the failure was not cached


async def test_population_counts_failure_degrades_to_unknown() -> None:
    store = CountingStore()
    await store.save(_case("c0"))

    async def broken_aggregate(spec):
        raise RuntimeError("count failed")

    store.aggregate = broken_aggregate  # type: ignore[method-assign]
    store.export_page = broken_aggregate  # type: ignore[method-assign,assignment]
    real_scan = CaseStore.scan_page

    calls = {"n": 0}

    async def scan_once(**kw):
        calls["n"] += 1
        if calls["n"] > 1:  # the population scan works; the fold behind the counts fails
            raise RuntimeError("count failed")
        return await real_scan(store, **kw)

    store.scan_page = scan_once  # type: ignore[method-assign]
    pop = await fetch_case_population(store, span_hours=24, limit=10)
    assert pop.load_ok and len(pop.cases) == 1
    assert pop.store_total is None and pop.open_now is None


# --------------------------------------------------------------------------- #
# engine.metrics changes
# --------------------------------------------------------------------------- #
NOW = datetime(2026, 10, 10, 12, tzinfo=UTC)


def test_sla_attainment_is_none_when_nothing_was_scored() -> None:
    unscored = M.sla_metrics([_case("a", priority_level=None)], SlaPolicy(enabled=True), now=NOW)
    assert unscored["evaluated"] == 0
    assert unscored["attainment_pct"] is None and "not measured" in unscored["attainment_reason"]
    scored = M.sla_metrics(
        [_case("b", priority_level="P4", created_at=(NOW - timedelta(minutes=5)).isoformat())],
        SlaPolicy(enabled=True), now=NOW,
    )
    assert scored["evaluated"] == 1 and scored["attainment_pct"] == 100.0
    assert scored["attainment_reason"] == ""


def test_sla_scores_the_derived_priority_an_analyst_sees_when_prefs_are_given() -> None:
    """No production path persists ``priority_level``; with ``prefs`` the SLA uses the
    same read-time ITIL projection as the case list, so real cases are actually scored."""
    from app.config import Preferences
    from app.engine.priority import advisory_bands

    prefs = Preferences()
    cases = [_case(f"p{i}", created_at=(NOW - timedelta(hours=i + 1)).isoformat(),
                   risk_score=float(30 * i)) for i in range(4)]
    derived = {advisory_bands(c, prefs).get("priority_level") for c in cases}
    assert derived and None not in derived
    without = M.sla_metrics(cases, prefs.sla, now=NOW)
    assert without["evaluated"] == 0 and without["attainment_pct"] is None
    scored = M.sla_metrics(cases, prefs.sla, now=NOW, prefs=prefs)
    assert scored["evaluated"] == 4 and isinstance(scored["attainment_pct"], float)
    assert all(row["priority"] in derived for row in scored["breaching"])
    roll = M.posture_metrics(cases, sla_policy=prefs.sla, window_hours=24, now=NOW, prefs=prefs)
    assert roll["sla"]["evaluated"] == 4


def _fp_population() -> list[Case]:
    t = (NOW - timedelta(hours=2)).isoformat()
    return [
        # Model said FP, nobody confirmed: an AI-verdict FP, NOT analyst-confirmed.
        _case("model-fp", created_at=t, verdict=Verdict.FALSE_POSITIVE),
        # Graded feedback says FP: analyst-confirmed even though the model said TP.
        _case("graded-fp", created_at=t, verdict=Verdict.TRUE_POSITIVE,
              feedback=[FeedbackEntry(actual_outcome="false_positive", ts=t)]),
        # Explicit classification by an analyst.
        _case("classified", created_at=t, verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST, disposition=Disposition.BENIGN,
              history=[{"event": "analyst_action", "action": "set_disposition", "ts": t}]),
        # A bare close carrying a model-derived disposition is not ground truth.
        _case("bare-close", created_at=t, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST, disposition=Disposition.FALSE_POSITIVE),
        # A policy close is excluded from the agent-quality population entirely.
        _case("policy", created_at=t, status=CaseStatus.CLOSED,
              decision_by=DecisionBy.ANALYST_POLICY, analyst_policy={"p": 1},
              feedback=[FeedbackEntry(actual_outcome="false_positive", ts=t)]),
    ]


def test_analyst_confirmed_fp_sits_beside_the_ai_fp_rate() -> None:
    quality = M.quality_metrics(_fp_population())
    assert quality["false_positive_cases"] == 1  # the AI verdict
    assert quality["analyst_confirmed_fp"] == 2  # graded + classified; never the policy close
    roll = M.posture_metrics(_fp_population(), window_hours=24, compare="prev", now=NOW)
    assert roll["quality"]["analyst_confirmed_fp"] == 2
    assert roll["compare"]["analyst_confirmed_fp"] == {"value": 2, "prev": 0, "delta_pct": None}
    trends = M.trend_metrics(_fp_population(), window_hours=24, now=NOW)
    assert sum(b["analyst_confirmed_fp"] for b in trends["buckets"]) == 2
    assert sum(b["false_positives"] for b in trends["buckets"]) == 1


def test_posture_open_now_takes_the_exact_store_count() -> None:
    cases = [_case("w", created_at=(NOW - timedelta(hours=1)).isoformat())]
    exact = M.posture_metrics(cases, window_hours=24, now=NOW, store_total=1, open_now_count=42)
    assert exact["open_now"]["count"] == 42 and exact["open_now"]["complete"] is True
    # Even a truncated population cannot make an exact count a lower bound...
    truncated = M.posture_metrics(cases, window_hours=24, now=NOW, store_total=9,
                                  open_now_count=42)
    assert truncated["truncated"] is True and truncated["open_now"]["complete"] is True
    # ...but an outage still wins: nothing was measured.
    outage = M.posture_metrics([], window_hours=24, now=NOW, load_ok=False, open_now_count=42)
    assert outage["open_now"]["complete"] is False
    unknown = M.posture_metrics(cases, window_hours=24, now=NOW, store_total=1,
                                open_now_unavailable="the store could not count")
    assert unknown["open_now"] == {**unknown["open_now"], "count": 1, "complete": False,
                                   "reason": "the store could not count"}


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
async def test_agent_improvement_reads_every_ledger_row_in_its_span(app_state) -> None:
    from app.api.routes_metrics import _load_agent_outcome_inputs

    end = datetime.combine(_now().date(), datetime.min.time(), tzinfo=UTC)
    inside = 2600  # more than two export pages
    for i in range(inside):
        await app_state.usage_store.write(UsageDoc(
            ts=(end - timedelta(minutes=10 + i)).isoformat(), case_id=f"case-{i % 50}",
            role="investigator", model="mock", cost=0.01,
        ))
    for i in range(30):  # outside the 35-day span
        await app_state.usage_store.write(UsageDoc(
            ts=(end - timedelta(days=60, minutes=i)).isoformat(), case_id="old", cost=1.0,
        ))
    inputs = await _load_agent_outcome_inputs(app_state, current_days=7, baseline_days=28, end=end)
    assert inputs["usage_available"] is True
    assert inputs["usage_records_truncated"] is False
    assert len(inputs["usage_records"]) == inside
    assert set(inputs["usage_records"][0]) == {"ts", "case_id", "cost"}


@pytest.fixture
def metrics_client(app_state):
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


async def test_dashboards_and_counts_agree_beyond_the_old_page(metrics_client, app_state,
                                                              monkeypatch) -> None:
    """A store bigger than the bound, a window that fits: every route reports the exact,
    untruncated window and the exact open stock."""
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 5)
    for i in range(12):  # old, open, outside every 24h window
        await app_state.cases.save(_case(f"old-{i}", hours_ago=24 * 40 + i,
                                         status=CaseStatus.OPEN))
    for i in range(3):
        await app_state.cases.save(_case(f"new-{i}", hours_ago=i + 1, mitre=["T1110"],
                                         status=CaseStatus.OPEN))
    posture = metrics_client.get("/api/metrics/posture?window_hours=24").json()
    assert posture["truncated"] is False and posture["case_count"] == 3
    assert posture["open_now"]["count"] == 15 and posture["open_now"]["complete"] is True
    noise = metrics_client.get("/api/metrics/noise-reduction?window_hours=24").json()
    assert noise["cases_meta"] == {"truncated": False, "store_total": 3, "fetched": 3}
    trends = metrics_client.get("/api/metrics/trends?window_hours=24").json()
    assert trends["truncated"] is False
    assert sum(b["new_cases"] for b in trends["buckets"]) == 3
    mitre = metrics_client.get("/api/mitre/coverage?window_hours=24").json()
    assert mitre["truncated"] is False
    # All time: 15 cases over a bound of 5 — the newest five, honestly flagged.
    all_time = metrics_client.get("/api/mitre/coverage?window_hours=0").json()
    assert all_time["truncated"] is True and all_time["store_total"] == 15
    assert all_time["fetched"] == 5
