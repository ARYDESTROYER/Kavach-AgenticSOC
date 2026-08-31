"""Round 7 — Noise-Reduction counters: store + banding engine + endpoint (offline).

Covers ★a's backend for the Noise-Reduction funnel ("total alerts by severity → what
the AI reduced it to"):

* the durable :class:`app.stores.noise_counters.NoiseCounterStore` — record/read_window/
  clear, CAS-concurrency (no lost update under ``asyncio.gather``), skip-empty, and the
  warming-up / ``incomplete`` honesty flags;
* the pure banding + rollup helpers in :mod:`app.engine.noise_counters` (importing the
  ONE 74/48/22/8 severity classifier in ``priority.py`` — never re-declared);
* the ``build_noise_reduction`` §D report contract (MECE outcomes that SUM to
  ``cases.total``; null ingested + DASH reduction when counters warm up);
* the ``GET /api/metrics/noise-reduction`` route's truncation honesty.

Fully offline (fake ES + no LLM). Advisory only — nothing here is read by
``case_manager.decide()`` (#3)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.config import SourceInstance
from app.constants import (
    DEFAULT_SEVERITY_SCALE_MAX,
    CaseStatus,
    DecisionBy,
    EntityType,
    IngestMode,
    SEVERITY_BANDS,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import noise_counters as EN
from app.engine.priority import severity_scale_for_source
from app.models import Case, Entity, RawEvent, TriggerReason
from app.state import AppState
from app.stores.noise_counters import NoiseCounterStore

asyncio_mark = pytest.mark.asyncio

NOW = datetime(2026, 7, 5, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# severity_scale_for_source — THE one resolver: a source's DECLARED ladder ceiling
# --------------------------------------------------------------------------- #
def test_severity_scale_for_source_none_is_the_identity_ceiling() -> None:
    """An unresolvable source resolves to the IDENTITY ceiling, not to a guess token.

    Both the ``priority`` home and the ``noise_counters`` re-export must be the SAME
    function object, so the funnel can never band on a different ladder from the case
    surfaces."""
    assert severity_scale_for_source(None) == DEFAULT_SEVERITY_SCALE_MAX
    assert EN.severity_scale_for_source(None) == DEFAULT_SEVERITY_SCALE_MAX
    # ONE function object under two names — not two implementations that agree today.
    assert EN.severity_scale_for_source is severity_scale_for_source


def test_severity_scale_for_source_reads_the_declaration_not_the_connector_type() -> None:
    """The ladder is ONE declared number; no read path branches on the connector type.

    Pinned as two independent equivalences, which a per-type lookup table cannot satisfy:
    the same type with different declarations must differ, and different types with the
    same declaration must agree."""
    kwargs = {"ingest_mode": IngestMode.PULL, "display_name": "x"}
    same_type_a = SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH,
                                 severity_scale_max=10.0, **kwargs)
    same_type_b = SourceInstance(id="b", source_type=SourceType.ELASTICSEARCH,
                                 severity_scale_max=1000.0, **kwargs)
    other_type = SourceInstance(id="c", source_type=SourceType.WEBHOOK,
                                ingest_mode=IngestMode.PUSH_HTTP, display_name="x",
                                severity_scale_max=10.0)
    assert severity_scale_for_source(same_type_a) == 10.0
    assert severity_scale_for_source(same_type_b) == 1000.0        # same type, differs
    assert severity_scale_for_source(other_type) == 10.0           # other type, agrees

    # UNDECLARED -> the identity ceiling, whatever the type/mode.
    undeclared = SourceInstance(id="d", source_type=SourceType.ELASTICSEARCH, **kwargs)
    assert severity_scale_for_source(undeclared) == DEFAULT_SEVERITY_SCALE_MAX

    # Total + fail-open: a duck-typed object with no ceiling attribute, and a garbage
    # declaration, both degrade to the identity rather than raising.
    assert severity_scale_for_source(SimpleNamespace()) == DEFAULT_SEVERITY_SCALE_MAX
    assert severity_scale_for_source(
        SimpleNamespace(severity_scale_max="not a number")
    ) == DEFAULT_SEVERITY_SCALE_MAX
    assert severity_scale_for_source(
        SimpleNamespace(severity_scale_max=0)
    ) == DEFAULT_SEVERITY_SCALE_MAX


# --------------------------------------------------------------------------- #
# Banding + rollup helpers (import the ONE priority classifier — no re-declared cuts)
# --------------------------------------------------------------------------- #
def test_band_for_severity_ocsf_identity_scale() -> None:
    # ocsf_0_100 is identity: the 74/48/22/8 cuts land exactly as in priority.py.
    assert EN.band_for_severity(90, "ocsf_0_100") == "critical"
    assert EN.band_for_severity(50, "ocsf_0_100") == "high"
    assert EN.band_for_severity(30, "ocsf_0_100") == "medium"
    assert EN.band_for_severity(10, "ocsf_0_100") == "low"
    assert EN.band_for_severity(5, "ocsf_0_100") == "info"
    assert EN.band_for_severity(None, "ocsf_0_100") == "info"


def test_count_events_by_band_uses_the_declared_ceiling() -> None:
    evs = [RawEvent(id=f"e{i}", index="ix", severity=s)
           for i, s in enumerate([8.0, 5.0, 2.0, 0.0])]
    # Against a DECLARED 0-10 ceiling: 80→critical, 50→high, 20→low, 0→info.
    counts = EN.count_events_by_band(evs, 10.0)
    assert counts == {"critical": 1, "high": 1, "medium": 0, "low": 1, "info": 1}
    assert EN.count_events_by_band([], 10.0) == EN.zero_bands()
    # The SAME raw events against the identity ceiling band completely differently —
    # the funnel's buckets are a function of the declared number, so a window that
    # cannot prove one ceiling throughout cannot be differenced (see the by_source
    # ``severity_scale_max`` stamp).
    assert EN.count_events_by_band(evs, DEFAULT_SEVERITY_SCALE_MAX) == {
        "critical": 0, "high": 0, "medium": 0, "low": 1, "info": 3,
    }
    # The deprecated string alias is still accepted and resolves to the same ceiling.
    assert EN.count_events_by_band(evs, "0_10") == counts


def test_count_clusters_by_band_prefers_trigger_reason() -> None:
    from app.models import Cluster, TriggerReason

    hot = Cluster(signature="s1", entity=Entity(type=EntityType.IP, value="1.1.1.1"),
                  group_by=EntityType.IP, trigger_reason=TriggerReason(severity_max=90.0))
    warm = Cluster(signature="s2", entity=Entity(type=EntityType.IP, value="2.2.2.2"),
                   group_by=EntityType.IP,
                   member_events=[RawEvent(id="m1", index="ix", severity=50.0)])
    counts = EN.count_clusters_by_band([hot, warm], "ocsf_0_100")
    assert counts["critical"] == 1 and counts["high"] == 1


def test_merge_bands_and_empty_delta() -> None:
    a = {"critical": 2, "high": 1}
    b = {"critical": 3, "low": 4}
    assert EN.merge_bands(a, b) == {"critical": 5, "high": 1, "medium": 0, "low": 4, "info": 0}
    assert EN.merge_bands(None, None) == EN.zero_bands()
    delta = EN.empty_noise_delta()
    assert delta["ingested"] == EN.zero_bands() and delta["suppressed"] == 0


# --------------------------------------------------------------------------- #
# NoiseCounterStore — record / read_window / clear / warming-up
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_store_record_and_read_window(app_state: AppState) -> None:
    store = NoiseCounterStore(app_state._kv)
    # Warming up: nothing recorded yet → not available, all-zero window.
    warm = await store.read_window(24, now=NOW)
    assert warm["available"] is False
    assert warm["since"] is None
    assert warm["ingested"] == EN.zero_bands()

    await store.record({"ingested": {"critical": 3, "high": 2}, "clustered": {"high": 1},
                        "suppressed": 4, "ignored": 2}, now=NOW)
    await store.record({"ingested": {"critical": 1}, "clustered": {"medium": 5}}, now=NOW)

    w = await store.read_window(24, now=NOW)
    assert w["available"] is True
    assert w["since"] is not None
    assert w["ingested"]["critical"] == 4 and w["ingested"]["high"] == 2
    assert w["clustered"] == {"critical": 0, "high": 1, "medium": 5, "low": 0, "info": 0}
    assert w["suppressed"] == 4 and w["ignored"] == 2


@asyncio_mark
async def test_store_record_skips_empty_delta(app_state: AppState) -> None:
    store = NoiseCounterStore(app_state._kv)
    await store.record({"ingested": EN.zero_bands(), "clustered": EN.zero_bands(),
                        "suppressed": 0, "ignored": 0}, now=NOW)
    await store.record({}, now=NOW)
    # An all-zero tick is a NO-OP: the store never leaves "warming up".
    w = await store.read_window(24, now=NOW)
    assert w["available"] is False


@asyncio_mark
async def test_store_window_scopes_by_hour(app_state: AppState) -> None:
    store = NoiseCounterStore(app_state._kv)
    old = NOW - timedelta(hours=48)
    await store.record({"ingested": {"low": 7}}, now=old)   # 48h ago
    await store.record({"ingested": {"low": 3}}, now=NOW)   # now
    # A 24h window sees ONLY the recent record...
    recent = await store.read_window(24, now=NOW)
    assert recent["ingested"]["low"] == 3
    # ...but a 72h window sees both.
    wide = await store.read_window(72, now=NOW)
    assert wide["ingested"]["low"] == 10
    # window_hours<=0 → the whole tally.
    allw = await store.read_window(0, now=NOW)
    assert allw["ingested"]["low"] == 10


@asyncio_mark
async def test_store_exact_upper_boundary_excludes_later_buckets(
    app_state: AppState,
) -> None:
    store = NoiseCounterStore(app_state._kv)
    await store.record({"ingested": {"high": 1}}, now=NOW - timedelta(hours=1))
    await store.record({"ingested": {"high": 2}}, now=NOW)
    await store.record({"ingested": {"high": 4}}, now=NOW + timedelta(hours=1))

    # Live reads include the current bucket but never future clock-skew buckets.
    live = await store.read_window(24, now=NOW)
    assert live["ingested"]["high"] == 3
    # Complete-period reports use NOW as an exclusive boundary: [NOW-24h, NOW).
    complete = await store.read_window_strict(
        24, now=NOW, end_exclusive=True
    )
    assert complete["ingested"]["high"] == 1


@asyncio_mark
async def test_store_strict_read_distinguishes_failure_from_empty(
    app_state: AppState,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = NoiseCounterStore(app_state._kv)

    async def fail_get(*_args, **_kwargs):
        raise RuntimeError("counter backend unavailable")

    monkeypatch.setattr(store._kv, "get", fail_get)
    soft = await store.read_window(24, now=NOW)
    assert soft["available"] is False
    with pytest.raises(RuntimeError, match="counter backend unavailable"):
        await store.read_window_strict(24, now=NOW, end_exclusive=True)


@asyncio_mark
async def test_store_incomplete_flag(app_state: AppState) -> None:
    store = NoiseCounterStore(app_state._kv)
    await store.record({"ingested": {"high": 1}}, now=NOW)
    # A window whose start reaches BEFORE ``since`` is only partially covered.
    partial = await store.read_window(24, now=NOW)  # since==NOW > NOW-24h
    assert partial["available"] is True and partial["incomplete"] is True
    # Read far in the future so the window fully post-dates ``since`` → complete.
    later = NOW + timedelta(hours=48)
    complete = await store.read_window(1, now=later)  # window_from = later-1h > since
    assert complete["incomplete"] is False


@asyncio_mark
async def test_store_retention_floor_marks_overlong_window_incomplete(
    app_state: AppState,
) -> None:
    store = NoiseCounterStore(app_state._kv)
    await store.record(
        {"ingested": {"high": 1}}, now=NOW - timedelta(days=120)
    )
    # A new write prunes the 120-day-old bucket but deliberately preserves the
    # first-ever ``since`` timestamp. Completeness must use the effective retained
    # floor rather than trusting that stale first-observation timestamp.
    await store.record({"ingested": {"high": 2}}, now=NOW)

    overlong = await store.read_window(121 * 24, now=NOW)
    retained = await store.read_window(56 * 24, now=NOW)
    assert overlong["available"] is True
    assert overlong["incomplete"] is True
    assert retained["incomplete"] is False


@asyncio_mark
async def test_store_clear(app_state: AppState) -> None:
    store = NoiseCounterStore(app_state._kv)
    await store.record({"ingested": {"critical": 5}}, now=NOW)
    assert (await store.read_window(24, now=NOW))["available"] is True
    await store.clear()
    after = await store.read_window(24, now=NOW)
    assert after["available"] is False and after["ingested"] == EN.zero_bands()


@asyncio_mark
async def test_store_cas_concurrency_no_lost_update(app_state: AppState) -> None:
    """Two store instances over the SAME KV, records fired concurrently via
    ``asyncio.gather`` — the ``_rev`` CAS retry means NOT ONE increment is lost."""
    store_a = NoiseCounterStore(app_state._kv)
    store_b = NoiseCounterStore(app_state._kv)
    n = 30

    async def _bump(store: NoiseCounterStore) -> None:
        await store.record({"ingested": {"critical": 1}}, now=NOW)

    await asyncio.gather(*[_bump(store_a) for _ in range(n)],
                         *[_bump(store_b) for _ in range(n)])
    w = await store_a.read_window(24, now=NOW)
    assert w["ingested"]["critical"] == 2 * n


# --------------------------------------------------------------------------- #
# build_noise_reduction — the §D report contract
# --------------------------------------------------------------------------- #
def _case(cid: str, *, status: CaseStatus, verdict: Verdict | None = None,
          decision_by: DecisionBy | None = None, severity_band: str = "high",
          escalation_level: int = 0) -> Case:
    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        created_at=NOW.isoformat(), updated_at=NOW.isoformat(),
        status=status, verdict=verdict, decision_by=decision_by,
        severity_band=severity_band, escalation_level=escalation_level,
        risk_score=50.0, confidence=0.9,
    )


def _mece_cases() -> list[Case]:
    return [
        _case("nh1", status=CaseStatus.CLOSED, verdict=Verdict.NEEDS_HUMAN),  # needs_human (verdict)
        _case("nh2", status=CaseStatus.OPEN),                                 # needs_human (non-terminal)
        _case("esc", status=CaseStatus.ESCALATED, verdict=Verdict.TRUE_POSITIVE),  # escalated
        _case("ac", status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
              decision_by=DecisionBy.AGENT),                                  # auto_cleared
        _case("tp", status=CaseStatus.RESOLVED, verdict=Verdict.TRUE_POSITIVE,
              decision_by=DecisionBy.ANALYST),                               # true_positive residual
    ]


_COUNTERS_AVAILABLE = {
    "available": True, "since": NOW.isoformat(), "incomplete": False,
    "ingested": {"critical": 100, "high": 50, "medium": 30, "low": 20, "info": 10},
    "clustered": {"critical": 5, "high": 3, "medium": 2, "low": 1, "info": 0},
    "suppressed": 12, "ignored": 4,
}


def test_build_noise_reduction_contract_shape() -> None:
    rep = EN.build_noise_reduction(
        _mece_cases(), _COUNTERS_AVAILABLE, window_hours=0, store_total=5,
        fetched_count=5, prefs=None, generated_at="2026-07-05T12:00:00+00:00", now=NOW,
    )
    assert rep["window_hours"] == 0
    assert rep["bands"] == list(SEVERITY_BANDS)
    assert [s["key"] for s in rep["stages"]] == [
        "ingested", "clustered", "cases", "auto_cleared", "escalated", "needs_human",
        "closed", "policy_closed",
    ]
    det = {s["key"]: s["deterministic"] for s in rep["stages"]}
    assert det["cases"] is False and det["ingested"] is True and det["needs_human"] is True
    assert det["closed"] is False  # a human close, not a deterministic auto-close
    src = {s["key"]: s["source"] for s in rep["stages"]}
    assert src["ingested"] == "counters" and src["cases"] == "cases"
    assert rep["drops"] == {"suppressed": 12, "ignored": 4}


def test_build_noise_reduction_outcomes_account_for_every_case() -> None:
    # The funnel's terminal "Escalated" node folds in the needs_human bucket (2) + the
    # escalated bucket (1) + the true_positive residual (1) → 4 == cases(5) −
    # auto_cleared(1). Otherwise the needs_human + residual cases would render in NO
    # terminal node the UI draws (auto_cleared / escalated / closed) and the visible
    # outcomes would fail to account for every windowed case.
    rep = EN.build_noise_reduction(
        _mece_cases(), _COUNTERS_AVAILABLE, window_hours=0, store_total=5,
        fetched_count=5, generated_at="g", now=NOW,
    )
    stage = {s["key"]: s["total"] for s in rep["stages"]}
    assert stage["cases"] == 5
    # The STANDALONE needs_human / auto_cleared stages are intact (kept for other consumers).
    assert stage["needs_human"] == 2
    assert stage["auto_cleared"] == 1
    # The escalated stage now carries every non-auto-cleared case (= cases − auto_cleared),
    # i.e. it folds the needs_human count + the true_positive residual in.
    assert stage["escalated"] == 4
    assert stage["escalated"] == stage["cases"] - stage["auto_cleared"]
    # Terminal outcomes account for EVERY windowed case: each case is either auto-cleared
    # by the AI or escalated for a human (the two disjoint covering terminal nodes).
    assert stage["auto_cleared"] + stage["escalated"] == stage["cases"]
    # ingested/clustered from the durable counters.
    assert stage["ingested"] == 210 and stage["clustered"] == 11
    # headline (0-100 percent) is unchanged — it uses needs_human, NOT the folded stage:
    # overall = (1 - needs_human/ingested)*100; human = (1 - needs_human/cases)*100.
    assert rep["reduction"]["overall_pct"] == round((1 - 2 / 210) * 100, 1)
    assert rep["reduction"]["human_reduction_pct"] == round((1 - 2 / 5) * 100, 1)


def test_build_noise_reduction_escalated_includes_a_needs_human_case() -> None:
    # A lone OPEN case with no verdict is a needs_human (non-terminal, not escalated). It
    # must appear in the funnel's terminal "Escalated" node — otherwise it renders in NO
    # terminal outcome (the regression this fix guards). The standalone needs_human stage
    # still reports it for any other consumer.
    cases = [_case("nh-open", status=CaseStatus.OPEN, severity_band="critical")]
    rep = EN.build_noise_reduction(
        cases, _COUNTERS_AVAILABLE, window_hours=0, store_total=1,
        fetched_count=1, generated_at="g", now=NOW,
    )
    stage = {s["key"]: s for s in rep["stages"]}
    assert stage["needs_human"]["total"] == 1
    assert stage["needs_human"]["by_severity"]["critical"] == 1
    # ...folded into the terminal escalated node the frontend renders (total + band).
    assert stage["escalated"]["total"] == 1
    assert stage["escalated"]["by_severity"]["critical"] == 1
    # No case is auto-cleared → every case is escalated: outcomes account for all cases.
    assert stage["auto_cleared"]["total"] == 0
    assert stage["auto_cleared"]["total"] + stage["escalated"]["total"] == stage["cases"]["total"]


def test_build_noise_reduction_by_severity_bands() -> None:
    rep = EN.build_noise_reduction(
        _mece_cases(), _COUNTERS_AVAILABLE, window_hours=0, store_total=5,
        fetched_count=5, generated_at="g", now=NOW,
    )
    by = {s["key"]: s["by_severity"] for s in rep["stages"]}
    # every _case defaults severity_band='high' → the 5 cases all land in the high band.
    assert by["cases"]["high"] == 5
    assert by["needs_human"]["high"] == 2
    # The escalated bands fold in needs_human + the residual: 4 == cases(5) − auto_cleared(1).
    assert by["escalated"]["high"] == 4
    assert by["ingested"] == _COUNTERS_AVAILABLE["ingested"]


def test_build_noise_reduction_closed_stage_counts_human_closed() -> None:
    # The §D "closed" stage = cases that reached a terminal state a HUMAN drove
    # (terminal AND decision_by is ANALYST). In _mece_cases(), only `tp` has explicit
    # ANALYST authority; legacy `nh1` has no authority and therefore is not attributed
    # to a human. The AGENT-auto-cleared FP (`ac`) and still-open cases are also excluded.
    rep = EN.build_noise_reduction(
        _mece_cases(), _COUNTERS_AVAILABLE, window_hours=0, store_total=5,
        fetched_count=5, generated_at="g", now=NOW,
    )
    stage = {s["key"]: s for s in rep["stages"]}
    assert "closed" in stage
    assert stage["closed"]["total"] == 1
    assert stage["closed"]["label"] == "Closed by human"
    assert stage["closed"]["source"] == "cases"
    # by_severity keeps the same shape as the other stages (all default band 'high').
    assert stage["closed"]["by_severity"]["high"] == 1
    # ...and it is NOT the auto-cleared (AI) bar.
    assert stage["auto_cleared"]["total"] == 1


def test_build_noise_reduction_closed_stage_requires_explicit_analyst_authority() -> None:
    # TRUE_POSITIVE auto-close is an explicit policy opt-in. Its verdict differs from
    # the default FP auto-close, but its decision authority is still AGENT and therefore
    # it must never inflate the human-closed outcome.
    cases = [
        _case(
            "fp-agent-close",
            status=CaseStatus.CLOSED,
            verdict=Verdict.FALSE_POSITIVE,
            decision_by=DecisionBy.AGENT,
            severity_band="high",
        ),
        _case(
            "tp-agent-close",
            status=CaseStatus.RESOLVED,
            verdict=Verdict.TRUE_POSITIVE,
            decision_by=DecisionBy.AGENT,
            severity_band="critical",
        ),
        _case(
            "tp-human-close",
            status=CaseStatus.RESOLVED,
            verdict=Verdict.TRUE_POSITIVE,
            decision_by=DecisionBy.ANALYST,
            severity_band="low",
        ),
        _case(
            "system-close",
            status=CaseStatus.CLOSED,
            verdict=Verdict.NEEDS_HUMAN,
            decision_by=DecisionBy.SYSTEM,
            severity_band="medium",
        ),
        _case(
            "legacy-close",
            status=CaseStatus.CLOSED,
            verdict=Verdict.NEEDS_HUMAN,
            decision_by=None,
            severity_band="info",
        ),
    ]
    rep = EN.build_noise_reduction(
        cases,
        _COUNTERS_AVAILABLE,
        window_hours=0,
        store_total=5,
        fetched_count=5,
        generated_at="g",
        now=NOW,
    )
    stage = {item["key"]: item for item in rep["stages"]}

    assert stage["closed"]["total"] == 1
    assert stage["closed"]["by_severity"] == {
        "critical": 0,
        "high": 0,
        "medium": 0,
        "low": 1,
        "info": 0,
    }
    # The default FP automation remains the only member of auto_cleared. Opt-in TP
    # automation, SYSTEM routing, and missing legacy provenance are all excluded from
    # human-closed because only ANALYST authority is affirmative evidence of that action.
    assert stage["auto_cleared"]["total"] == 1
    assert stage["escalated"]["total"] == 4


def test_build_noise_reduction_warming_up_degrades() -> None:
    rep = EN.build_noise_reduction(
        _mece_cases(), {"available": False}, window_hours=0, store_total=5,
        fetched_count=5, generated_at="g", now=NOW,
    )
    stage = {s["key"]: s for s in rep["stages"]}
    # Counters warming up → null ingested/clustered totals + DASH overall reduction.
    assert stage["ingested"]["total"] is None
    assert stage["ingested"]["by_severity"] is None
    assert stage["clustered"]["total"] is None
    assert rep["reduction"]["overall_pct"] == "—"
    # ...but the case-only funnel still works (human reduction from cases, 0-100 percent).
    assert stage["cases"]["total"] == 5
    assert rep["reduction"]["human_reduction_pct"] == round((1 - 2 / 5) * 100, 1)
    assert rep["counters"]["available"] is False


def test_build_noise_reduction_reports_truncation() -> None:
    # store held MORE than we fetched → the case-tally is a lower bound, flagged honestly.
    rep = EN.build_noise_reduction(
        _mece_cases(), _COUNTERS_AVAILABLE, window_hours=0, store_total=999,
        fetched_count=5, generated_at="g", now=NOW,
    )
    assert rep["cases_meta"] == {"truncated": True, "store_total": 999, "fetched": 5}


# --------------------------------------------------------------------------- #
# Route-level: GET /api/metrics/noise-reduction truncation + warming-up honesty
# --------------------------------------------------------------------------- #
@pytest.fixture
def metrics_client(app_state):
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


@asyncio_mark
async def test_noise_reduction_endpoint_truncation_and_warmup(metrics_client, app_state, monkeypatch):
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 2)
    for i in range(3):
        await app_state.cases.save(_case(f"n{i}", status=CaseStatus.OPEN))
    r = metrics_client.get("/api/metrics/noise-reduction?window_hours=24")
    assert r.status_code == 200
    body = r.json()
    # Truncation reported honestly (store had 3, fetch bound was 2).
    assert body["cases_meta"] == {"truncated": True, "store_total": 3, "fetched": 2}
    # No poll/ingest ran → counters are warming up → null ingested + DASH reduction.
    assert body["counters"]["available"] is False
    ingested = next(s for s in body["stages"] if s["key"] == "ingested")
    assert ingested["total"] is None
    assert body["reduction"]["overall_pct"] == "—"


@asyncio_mark
async def test_noise_reduction_lineage_is_windowed_bounded_and_redacted(
    metrics_client,
    app_state,
) -> None:
    now = datetime.now(timezone.utc)
    cases = [
        _case(
            "lineage-auto",
            status=CaseStatus.CLOSED,
            verdict=Verdict.FALSE_POSITIVE,
            decision_by=DecisionBy.AGENT,
        ),
        _case(
            "lineage-escalated",
            status=CaseStatus.ESCALATED,
            verdict=Verdict.TRUE_POSITIVE,
            escalation_level=1,
        ),
        _case("lineage-awaiting", status=CaseStatus.OPEN),
    ]
    native_ids = ["native-alert-alpha", "native-alert-bravo", "native-alert-charlie"]
    for index, case in enumerate(cases):
        created_at = (now - timedelta(minutes=index)).isoformat()
        case.created_at = created_at
        case.updated_at = created_at
        case.case_number = f"CASE-{index + 1:06d}"
        case.member_event_ids = [native_ids[index], f"{native_ids[index]}-second"]
        case.source_id = "entra-demo"
        case.source_breakdown = {"entra-demo": 2}
        case.trigger_reason = TriggerReason(
            rule_value="Impossible travel",
            mode="threshold",
            n=2,
            observed_count=2,
            window_seconds=300,
            group_by="user",
            sentence="Two sign-ins matched inside the configured window.",
        )
        await app_state.cases.save(case)

    # Outside the selected window: never appears in the drill-down.
    old = _case("lineage-old", status=CaseStatus.CLOSED)
    old.created_at = (now - timedelta(days=3)).isoformat()
    old.updated_at = old.created_at
    old.member_event_ids = ["native-alert-too-old"]
    await app_state.cases.save(old)

    response = metrics_client.get(
        "/api/metrics/noise-reduction/lineage?window_hours=24&limit=2"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["window_hours"] == 24
    assert body["meta"]["returned"] == 2
    assert body["meta"]["window_cases_in_fetched_page"] == 3
    assert body["meta"]["truncated"] is True
    assert [row["case_id"] for row in body["rows"]] == [
        "lineage-auto",
        "lineage-escalated",
    ]

    first = body["rows"][0]
    assert first["clustering"]["input_count"] == 2
    assert all(
        ref.startswith("alert-") for ref in first["clustering"]["input_refs"]
    )
    assert first["clustering"]["correlation"]["threshold"] == 2
    assert first["outcome"] == {
        "key": "auto_cleared",
        "label": "Auto-cleared by AI",
        "funnel_stage": "auto_cleared",
        "terminal": True,
        "status": "closed",
        "verdict": "FALSE_POSITIVE",
        "disposition": "",
        "decision_by": "agent",
    }
    encoded = json.dumps(body)
    for native_id in [*native_ids, "native-alert-too-old"]:
        assert native_id not in encoded


@asyncio_mark
async def test_noise_reduction_lineage_reports_open_case_as_non_terminal(
    metrics_client,
    app_state,
) -> None:
    case = _case("lineage-open", status=CaseStatus.OPEN)
    case.created_at = datetime.now(timezone.utc).isoformat()
    case.updated_at = case.created_at
    case.member_event_ids = ["private-native-id"]
    await app_state.cases.save(case)

    response = metrics_client.get(
        "/api/metrics/noise-reduction/lineage?window_hours=24&limit=12"
    )
    assert response.status_code == 200
    outcome = response.json()["rows"][0]["outcome"]
    assert outcome["key"] == "awaiting_analyst"
    assert outcome["label"] == "Awaiting analyst"
    assert outcome["funnel_stage"] == "escalated"
    assert outcome["terminal"] is False
