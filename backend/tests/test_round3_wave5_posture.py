"""Round-3 Wave-5 — posture / MITRE-coverage honesty fixes (3 LOW audit findings).

Offline (no ES/LLM): exercises the pure ``engine/metrics`` + ``engine/mitre_coverage``
functions and the additive ``api/routes_metrics`` router. Locks three correctness
fixes so they cannot silently regress:

1. **Truncation is reported, not hidden.** When the store holds MORE cases than the
   route's fetch bound (``_STORE_FETCH_LIMIT``), the posture / coverage / navigator
   payloads carry an honest ``truncated`` / ``store_total`` / ``fetched`` marker so a
   consumer can tell a lower-bound tally from a complete one — the number is never
   silently wrong.

2. **SLA attainment is not skewed by a corrupted created_at.** ``sla_metrics`` only
   counts a case toward the attainment denominator AFTER it has a parseable start, so
   an unparseable ``created_at`` can neither inflate ``evaluated`` nor be silently
   scored as SLA-met.

3. **Period-over-period is symmetric.** A null-date case is excluded from EVERY
   time-bounded window (current AND prev), so it can never create a one-sided delta.

All assertions are deterministic; advisory only — none of this is read by
``case_manager.decide()`` (#3), and the MITRE technique-id validation (#9) is intact.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.config import SlaPolicy
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import metrics as M
from app.engine import mitre_coverage as MC
from app.models import Case, Entity, StatusHistoryEntry

NOW = datetime(2026, 6, 30, 12, 0, 0, tzinfo=timezone.utc)


def _case(
    cid: str,
    *,
    created: str,
    updated: str | None = None,
    verdict: Verdict | None = None,
    status: CaseStatus = CaseStatus.OPEN,
    decision_by: DecisionBy | None = None,
    priority: str | None = None,
    mitre: list[str] | None = None,
    history: list[tuple[str, str, str]] | None = None,
    escalation_level: int = 0,
) -> Case:
    sh = [
        # history tuples are (from, to, at) or (from, to, at, by) — default author human.
        StatusHistoryEntry(
            from_status=h[0], to_status=h[1], at=h[2],
            by=(h[3] if len(h) > 3 else "alice"),
        )
        for h in (history or [])
    ]
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        created_at=created,
        updated_at=updated or created,
        verdict=verdict,
        status=status,
        decision_by=decision_by,
        priority_level=priority,
        mitre=mitre or [],
        status_history=sh,
        escalation_level=escalation_level,
        confidence=0.9,
        risk_score=50.0,
    )


def test_mtta_ignores_system_auto_escalation_at_creation() -> None:
    # audit #9: an autopilot risk-gate auto-escalation (by="system") at case creation
    # must NOT be counted as a human acknowledgment (a fabricated ~0-minute MTTA).
    created = "2026-06-30T06:00:00+00:00"
    # Case A: system auto-escalates immediately, then a HUMAN acks 30 min later.
    sysA = _case(
        "sys", created=created, status=CaseStatus.ESCALATED,
        history=[
            ("open", "escalated", created, "system"),                       # NOT a human ack
            ("escalated", "investigating", "2026-06-30T06:30:00+00:00", "alice"),  # human ack
        ],
    )
    block = M.lifecycle_intervals([sysA])
    # MTTA is measured from the HUMAN transition (30 min), not the system one (0 min).
    assert block["mtta_minutes"]["p50"] == pytest.approx(30.0, abs=0.1)

    # A case acknowledged ONLY by system/agent contributes NO human-ack sample.
    only_sys = _case(
        "onlysys", created=created, status=CaseStatus.ESCALATED,
        history=[("open", "escalated", created, "system")],
    )
    block2 = M.lifecycle_intervals([only_sys])
    assert block2["mtta_minutes"]["count"] == 0


# --------------------------------------------------------------------------- #
# Finding 1 — truncation is surfaced, never silently swallowed
# --------------------------------------------------------------------------- #
def test_truncation_marker_engine_level() -> None:
    """The pure ``truncation_marker`` flags a partial result only when the store held
    more rows than were fetched — an in-window narrowing is NOT truncation."""
    # store had more than we fetched → truncated.
    assert M.truncation_marker(2, store_total=3) == {
        "truncated": True, "store_total": 3, "fetched": 2,
    }
    # fetched the whole population → not truncated.
    assert M.truncation_marker(3, store_total=3) == {
        "truncated": False, "store_total": 3, "fetched": 3,
    }
    # caller omits the total → conservatively assume we have it all.
    assert M.truncation_marker(3) == {"truncated": False, "store_total": 3, "fetched": 3}


def test_posture_metrics_carries_truncation_flag() -> None:
    cases = [
        _case("p1", created="2026-06-30T06:00:00+00:00"),
        _case("p2", created="2026-06-30T07:00:00+00:00"),
    ]
    # store held 50 cases but we only fetched these 2 → truncated lower bound.
    roll = M.posture_metrics(cases, window_hours=720, now=NOW, store_total=50)
    assert roll["truncated"] is True
    assert roll["store_total"] == 50
    assert roll["fetched"] == 2
    # complete fetch → not truncated.
    full = M.posture_metrics(cases, window_hours=720, now=NOW, store_total=2)
    assert full["truncated"] is False and full["store_total"] == 2 and full["fetched"] == 2
    # legacy callers (no store_total) get an honest, non-truncated marker.
    legacy = M.posture_metrics(cases, window_hours=720, now=NOW)
    assert legacy["truncated"] is False and legacy["store_total"] == 2


def test_mitre_coverage_carries_truncation_flag() -> None:
    cases = [_case("m1", created="2026-06-30T06:00:00+00:00", mitre=["T1110"])]
    cov = MC.compute_mitre_coverage(cases, store_total=9000)
    assert cov["truncated"] is True and cov["store_total"] == 9000 and cov["fetched"] == 1
    # the covered tally is still computed, just labelled a lower bound.
    assert cov["covered_techniques"] >= 1
    full = MC.compute_mitre_coverage(cases, store_total=1)
    assert full["truncated"] is False and full["store_total"] == 1
    # an in-window narrowing is NOT truncation: fetched_count overrides len(cases).
    narrowed = MC.compute_mitre_coverage(cases, store_total=1, fetched_count=1)
    assert narrowed["truncated"] is False


def test_navigator_layer_records_truncation_in_metadata() -> None:
    cases = [_case("n1", created="2026-06-30T06:00:00+00:00", mitre=["T1110"])]
    layer = MC.navigator_layer(cases, store_total=9000)
    meta = {m["name"]: m["value"] for m in layer["metadata"]}
    assert meta["truncated"] == "true" and meta["store_total"] == "9000"
    layer_full = MC.navigator_layer(cases, store_total=1)
    meta_full = {m["name"]: m["value"] for m in layer_full["metadata"]}
    assert meta_full["truncated"] == "false"


# --------------------------------------------------------------------------- #
# MTTD is now a REAL detection-latency metric (we store the first-event instant on
# the case as ``first_seen_millis``). The lifecycle rollup exposes MTTA / MTTR / dwell
# AND ``mttd_minutes`` — but HONESTLY: mttd only counts cases that carry a first-event
# instant, and is a labelled DASH (never a fake 0) when none does. dwell remains the
# distinct time-to-first-response metric. Copy lives in webui posture.format.ts.
# --------------------------------------------------------------------------- #
def test_posture_exposes_real_mttd() -> None:
    # A case whose first cluster event fired 30 min before the case was opened.
    detected = _case(
        "life-1",
        created="2026-06-30T06:00:00+00:00",
        updated="2026-06-30T08:00:00+00:00",
        status=CaseStatus.CLOSED,
        history=[
            ("open", "investigating", "2026-06-30T06:30:00+00:00"),
            ("investigating", "closed", "2026-06-30T08:00:00+00:00"),
        ],
    ).model_copy(
        update={
            # 2026-06-30T05:30:00Z in epoch millis → 30 min before created_at.
            "first_seen_millis": int(
                datetime(2026, 6, 30, 5, 30, 0, tzinfo=timezone.utc).timestamp() * 1000
            )
        }
    )
    intervals = M.lifecycle_intervals([detected])
    # The lifecycle rollup now carries all FOUR interval keys.
    assert set(intervals.keys()) == {
        "mtta_minutes", "mttr_minutes", "dwell_minutes", "mttd_minutes",
    }
    # Real detection latency: 30 minutes.
    assert intervals["mttd_minutes"]["available"] is True
    assert intervals["mttd_minutes"]["mean"] == 30.0
    assert intervals["mttd_minutes"]["count"] == 1


def test_posture_mttd_honest_dash_when_no_first_seen() -> None:
    # A case with NO first-event instant (first_seen_millis defaults to 0) contributes
    # no MTTD sample → an honest labelled DASH, never a fabricated 0.
    plain = _case("no-fs", created="2026-06-30T06:00:00+00:00", status=CaseStatus.OPEN)
    block = M.lifecycle_intervals([plain])["mttd_minutes"]
    assert block["available"] is False
    assert block["count"] == 0
    assert block["p50"] == M.DASH
    assert "detection latency not available" in block["reason"]


# --------------------------------------------------------------------------- #
# Finding 2 — SLA evaluated++ runs AFTER the start-None guard
# --------------------------------------------------------------------------- #
def test_sla_unparseable_created_at_excluded_from_attainment() -> None:
    # A genuinely-breached P1 (created long ago) + a P1 with a corrupted created_at.
    breached = _case(
        "s-breach", created="2000-01-01T00:00:00+00:00", priority="P1", status=CaseStatus.OPEN
    )
    corrupt = _case("s-bad", created="garbage", priority="P1", status=CaseStatus.OPEN)
    out = M.sla_metrics([breached, corrupt], SlaPolicy(enabled=True), now=NOW)
    # The corrupted case has no parseable start, so it must NOT inflate the
    # denominator nor be silently scored as MET.
    assert out["evaluated"] == 1            # only the evaluable case is scored
    assert out["response_breached"] == 1
    assert out["resolve_breached"] == 1
    assert out["attainment_pct"] == 0.0     # was 50.0 before the fix (skew)

    # And a lone corrupted P1 yields a truthful empty result, not a fake 100%.
    only_bad = M.sla_metrics([corrupt], SlaPolicy(enabled=True), now=NOW)
    assert only_bad["evaluated"] == 0
    # Round 12: nothing was scored, so attainment is NOT MEASURED (None, rendered as a
    # dash) — neither the old fake 100% nor a fake 0%.
    assert only_bad["attainment_pct"] is None
    assert only_bad["attainment_reason"]


def test_sla_clean_set_attainment_unchanged() -> None:
    """A regression guard that the reorder did not change scoring for clean inputs:
    a met P3 case (well within target) reports 100% attainment over one evaluable case."""
    ok = _case("s-ok", created="2026-06-30T11:30:00+00:00", priority="P3", status=CaseStatus.OPEN)
    out = M.sla_metrics([ok], SlaPolicy(enabled=True), now=NOW)
    assert out["evaluated"] == 1 and out["attainment_pct"] == 100.0
    assert out["response_breached"] == 0 and out["resolve_breached"] == 0


# --------------------------------------------------------------------------- #
# Finding 3 — period-over-period symmetry for null-date cases
# --------------------------------------------------------------------------- #
def test_window_filter_excludes_null_date_cases() -> None:
    inside = _case("w-in", created="2026-06-30T06:00:00+00:00")
    null = _case("w-null", created="corrupt-date")
    got = M._window_filter([inside, null], window_hours=24, now=NOW)
    # The null-date case cannot be attributed to a time bucket → excluded.
    assert [c.case_id for c in got] == ["w-in"]
    # The no-window escape still returns EVERYTHING (incl. the null-date case).
    allc = M._window_filter([inside, null], window_hours=0, now=NOW)
    assert {c.case_id for c in allc} == {"w-in", "w-null"}


def test_null_date_case_symmetric_across_windows() -> None:
    # One real prev-window case (created 30h ago, inside [NOW-48h, NOW-24h]) and one
    # null-date FALSE_POSITIVE that must land in NEITHER window.
    good_prev = _case(
        "good-prev", created="2026-06-29T06:00:00+00:00", verdict=Verdict.TRUE_POSITIVE
    )
    bad = _case("bad", created="corrupt-date", verdict=Verdict.FALSE_POSITIVE)
    roll = M.posture_metrics(
        [good_prev, bad], window_hours=24, compare="prev", now=NOW
    )
    # The null-date case is in NEITHER the current nor the prev window.
    assert roll["case_count"] == 0
    cc = roll["compare"]["case_count"]
    assert cc["value"] == 0 and cc["prev"] == 1  # only the dated prev case counts
    # The null-date FALSE_POSITIVE must NOT create a one-sided FP-rate delta: it is
    # absent from BOTH sides, so current FP rate stays 0.0 (not a spurious 1.0).
    fpr = roll["compare"]["false_positive_rate"]
    assert fpr["value"] == 0.0


def test_null_date_case_excluded_from_every_window_lock() -> None:
    """Minimal locking assertion: a lone null-date case yields 0 in BOTH the current
    and the prev window — the moment the two filters drift, this fails."""
    bad = _case("bad", created="corrupt-date", verdict=Verdict.FALSE_POSITIVE)
    roll = M.posture_metrics([bad], window_hours=24, compare="prev", now=NOW)
    assert roll["case_count"] == 0
    assert roll["compare"]["case_count"] == {"value": 0, "prev": 0, "delta_pct": M.DASH}


# --------------------------------------------------------------------------- #
# Route-level: a >fetch-limit store exposes truncation honestly
# --------------------------------------------------------------------------- #
@pytest.fixture
def metrics_client(app_state):
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _recent(minutes: int = 30) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


async def test_posture_endpoint_flags_truncation(metrics_client, app_state, monkeypatch) -> None:
    # Round 12: the rollup reads every case its window can reach, so truncation now
    # means ONE WINDOW holds more cases than the in-memory bound. Shrink the bound so
    # three in-window cases already exceed it.
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 2)
    for i in range(3):  # all created within the last hour
        await app_state.cases.save(
            _case(f"trunc-{i}", created=_recent(10 + i), status=CaseStatus.OPEN)
        )
    r = metrics_client.get("/api/metrics/posture?window_hours=24")
    assert r.status_code == 200
    body = r.json()
    assert body["truncated"] is True
    assert body["store_total"] == 3  # cases in the rollup's scope
    assert body["fetched"] == 2  # the newest two were analysed
    # The open-now stock is an exact store COUNT, so it is complete regardless.
    assert body["open_now"]["count"] == 3 and body["open_now"]["complete"] is True


async def test_posture_endpoint_no_truncation_when_under_limit(
    metrics_client, app_state, monkeypatch
) -> None:
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 50)
    for i in range(3):
        await app_state.cases.save(
            _case(f"small-{i}", created=_recent(10 + i), status=CaseStatus.OPEN)
        )
    r = metrics_client.get("/api/metrics/posture?window_hours=24")
    body = r.json()
    assert body["truncated"] is False and body["store_total"] == 3 and body["fetched"] == 3


async def test_posture_endpoint_old_cases_beyond_the_bound_no_longer_truncate(
    metrics_client, app_state, monkeypatch
) -> None:
    """The Round 12 new truth: a store far larger than the bound is NOT a truncated
    24-hour rollup when the window itself fits — only in-window cases are read, and the
    open-now stock is still counted across the whole store."""
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 2)
    for i in range(6):  # old open cases, outside every 24h/48h window
        await app_state.cases.save(
            _case(f"old-{i}", created="2026-01-0%dT10:00:00+00:00" % (i + 1),
                  status=CaseStatus.OPEN)
        )
    await app_state.cases.save(_case("fresh", created=_recent(5), status=CaseStatus.OPEN))
    body = metrics_client.get("/api/metrics/posture?window_hours=24&compare=prev").json()
    assert body["truncated"] is False
    assert body["case_count"] == 1
    assert body["open_now"]["count"] == 7 and body["open_now"]["complete"] is True
    assert body["window_covered"] is True


async def test_mitre_coverage_endpoint_flags_truncation(
    metrics_client, app_state, monkeypatch
) -> None:
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 2)
    for i in range(3):
        await app_state.cases.save(
            _case(f"cov-{i}", created="2026-06-30T11:30:00+00:00", mitre=["T1110"])
        )
    # window_hours=0 → ALL fetched cases; truncated must still be reported.
    r = metrics_client.get("/api/mitre/coverage?window_hours=0")
    assert r.status_code == 200
    body = r.json()
    assert body["truncated"] is True and body["store_total"] == 3 and body["fetched"] == 2
