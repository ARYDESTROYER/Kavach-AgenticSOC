"""P3 — the POPULATIONS the five headline KPI tiles are computed over.

Offline (no ES/LLM), pure ``engine/metrics`` plus the additive
``api/routes_metrics`` posture route. Two of the five tiles used to be fed from
populations that could not express what they claimed:

* "Total Critical" had no server-side per-severity count at all, so a client could
  only band whatever bounded page of cases it happened to hold and present that
  sample as a total. :func:`engine.metrics.severity_band_counts` is the fix, and it
  must PARTITION the same windowed population ``case_count`` reports.
* "Open Cases" is present-tense and deliberately window-EXEMPT.
  ``aging.queue_depth`` is the cohort-scoped "arrived in-window and still open"
  figure and is a different number; ``metrics.needs_human_cases`` is narrower still.
  :func:`engine.metrics.open_case_count` measures the real stock, and the payload
  says so structurally.

It also locks the honest-coverage flag: ``truncated`` is permanent for any deployment
holding more cases than the route's fetch bound, which would make every posture-fed
tile withhold forever. ``window_covered`` is the narrower claim — the SELECTED window
is fully answerable from the rows actually read — and it is emitted ALONGSIDE the
truncation marker, whose exact three-key shape stays byte-identical (four rollups
share it).

Finally it pins the three-way close breakdown: ``auto_closed_cases`` +
``human_closed_cases`` + ``system_closed_cases`` == ``terminal_cases``, so the UI can
render three rows with the residual visible even at zero, and never compute human work
as ``terminal - auto``.

Everything here is advisory and read-time: none of it is read by
``case_manager.decide()`` (#3), and no band is ever persisted onto a case.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.config import Preferences, SourceInstance
from app.constants import (
    SEVERITY_BANDS,
    TERMINAL_CASE_STATUSES,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import metrics as M
from app.models import Case, Entity, TriggerReason

NOW = datetime(2026, 6, 30, 12, 0, 0, tzinfo=timezone.utc)


def _ago(hours: float) -> str:
    """An ISO-8601 UTC creation time ``hours`` before the REAL now. The posture route
    has no injectable clock, so route-level fixtures must be anchored relative to it."""
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


def _case(
    cid: str,
    *,
    created: str,
    status: CaseStatus = CaseStatus.OPEN,
    decision_by: DecisionBy | None = None,
    verdict: Verdict | None = None,
    risk: float = 50.0,
    severity_max: float | None = None,
    source_id: str = "",
) -> Case:
    return Case(
        case_id=cid,
        cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        source_id=source_id,
        entity=Entity(type=EntityType.IP, value="198.51.100.7"),
        created_at=created,
        updated_at=created,
        status=status,
        decision_by=decision_by,
        verdict=verdict,
        confidence=0.9,
        risk_score=risk,
        trigger_reason=(
            TriggerReason(severity_max=severity_max) if severity_max is not None else None
        ),
    )


# --------------------------------------------------------------------------- #
# (a) per-severity counts — a server-side partition of the windowed population
# --------------------------------------------------------------------------- #
def test_severity_band_counts_always_carries_every_band_in_ladder_order() -> None:
    """A consumer never has to tell "band absent" from "band zero"."""
    counts = M.severity_band_counts([])
    assert list(counts.keys()) == list(SEVERITY_BANDS)
    assert set(counts.values()) == {0}


def test_severity_band_counts_partition_the_population() -> None:
    cases = [
        _case("c-crit", created="2026-06-30T11:00:00+00:00", risk=95.0),
        _case("c-high", created="2026-06-30T11:00:00+00:00", risk=60.0),
        _case("c-med", created="2026-06-30T11:00:00+00:00", risk=30.0),
        _case("c-low", created="2026-06-30T11:00:00+00:00", risk=10.0),
        _case("c-info", created="2026-06-30T11:00:00+00:00", risk=1.0),
    ]
    counts = M.severity_band_counts(cases)
    assert counts == {"critical": 1, "high": 1, "medium": 1, "low": 1, "info": 1}
    # The defining invariant: it is a PARTITION, never a filtered subset.
    assert sum(counts.values()) == len(cases)


def test_posture_severity_counts_sum_to_case_count_and_honour_the_window() -> None:
    inside = [
        _case("in-crit", created="2026-06-30T11:00:00+00:00", risk=95.0),
        _case("in-high", created="2026-06-30T10:00:00+00:00", risk=60.0),
        _case("in-info", created="2026-06-30T09:00:00+00:00", risk=0.0),
    ]
    # Outside a 24h window (created 3 days ago) — must not be counted in either tile.
    outside = [_case("out-crit", created="2026-06-27T11:00:00+00:00", risk=99.0)]

    roll = M.posture_metrics(inside + outside, window_hours=24, now=NOW)
    assert roll["case_count"] == 3
    assert sum(roll["severity_counts"].values()) == roll["case_count"]
    assert roll["severity_counts"]["critical"] == 1  # NOT 2 — the old case is out of window

    # Widening the window pulls the older case (and only it) back in, on both tiles.
    wide = M.posture_metrics(inside + outside, window_hours=720, now=NOW)
    assert wide["case_count"] == 4
    assert sum(wide["severity_counts"].values()) == 4
    assert wide["severity_counts"]["critical"] == 2

    # And the unbounded window keeps the invariant too.
    allc = M.posture_metrics(inside + outside, window_hours=0, now=NOW)
    assert sum(allc["severity_counts"].values()) == allc["case_count"] == 4


def test_severity_band_counts_use_the_declared_ceiling_not_a_magnitude_guess() -> None:
    """The band is READ-TIME, so ``prefs`` must be threaded through — that is the whole
    reason ``posture_metrics`` grew the parameter. One raw number, two declarations,
    two honest answers; no vendor branch anywhere."""
    # A source-asserted severity of 12. On a declared 0-16 ladder that is 75/100
    # (critical); on the undeclared identity ladder it is 12/100 (low).
    case = _case(
        "sev", created="2026-06-30T11:00:00+00:00", severity_max=12.0, source_id="src-a", risk=0.0
    )
    prefs = Preferences(
        sources=[
            SourceInstance(
                id="src-a", source_type=SourceType.GENERIC, severity_scale_max=16.0
            )
        ]
    )
    assert M.severity_band_counts([case], prefs=prefs)["critical"] == 1
    assert M.severity_band_counts([case])["low"] == 1

    # Through the rollup, same story — and still a partition either way.
    declared = M.posture_metrics([case], window_hours=24, now=NOW, prefs=prefs)
    assert declared["severity_counts"]["critical"] == 1
    assert sum(declared["severity_counts"].values()) == declared["case_count"] == 1
    undeclared = M.posture_metrics([case], window_hours=24, now=NOW)
    assert undeclared["severity_counts"]["low"] == 1


# --------------------------------------------------------------------------- #
# (b) "open now" — a STOCK, deliberately exempt from the window
# --------------------------------------------------------------------------- #
def test_open_case_count_matches_a_hand_built_non_terminal_set() -> None:
    non_terminal = [
        _case("o-new", created="2026-06-30T11:00:00+00:00", status=CaseStatus.NEW),
        _case("o-open", created="2026-06-30T11:00:00+00:00", status=CaseStatus.OPEN),
        _case("o-nh", created="2026-06-30T11:00:00+00:00", status=CaseStatus.NEEDS_HUMAN),
        _case("o-inv", created="2026-06-30T11:00:00+00:00", status=CaseStatus.INVESTIGATING),
        _case("o-esc", created="2026-06-30T11:00:00+00:00", status=CaseStatus.ESCALATED),
        _case("o-hold", created="2026-06-30T11:00:00+00:00", status=CaseStatus.ON_HOLD),
    ]
    terminal = [
        _case("t-res", created="2026-06-30T11:00:00+00:00", status=CaseStatus.RESOLVED),
        _case("t-clo", created="2026-06-30T11:00:00+00:00", status=CaseStatus.CLOSED),
    ]
    # The two sets together are the whole CaseStatus vocabulary — if a status is ever
    # added and not classified, this catches it rather than silently mis-counting.
    assert {c.status.value for c in non_terminal} | {c.status.value for c in terminal} == {
        s.value for s in CaseStatus
    }
    assert {c.status.value for c in terminal} == set(TERMINAL_CASE_STATUSES)

    assert M.open_case_count(non_terminal + terminal) == len(non_terminal) == 6
    assert M.open_case_count(terminal) == 0


def test_open_now_ignores_the_window_and_says_so_on_the_wire() -> None:
    recent_open = _case("now-open", created="2026-06-30T11:00:00+00:00", status=CaseStatus.OPEN)
    # Arrived a month ago and STILL open: not in a 24h arrival cohort, but very much
    # on the queue right now.
    stale_open = _case("old-open", created="2026-05-30T11:00:00+00:00", status=CaseStatus.OPEN)
    recent_closed = _case(
        "now-closed", created="2026-06-30T11:00:00+00:00", status=CaseStatus.CLOSED
    )
    cases = [recent_open, stale_open, recent_closed]

    tight = M.posture_metrics(cases, window_hours=24, now=NOW)
    wide = M.posture_metrics(cases, window_hours=720, now=NOW)
    unbounded = M.posture_metrics(cases, window_hours=0, now=NOW)

    # The stock is identical at every window width — that is the contract.
    assert tight["open_now"]["count"] == wide["open_now"]["count"] == 2
    assert unbounded["open_now"]["count"] == 2
    # ...and it is a DIFFERENT number from the cohort-scoped queue depth, which the
    # window does bound. (2 open now vs 1 that arrived in the last 24h.)
    assert tight["aging"]["queue_depth"] == 1
    assert tight["case_count"] == 2

    # The window-exemption is structural on the wire, so a consumer cannot render this
    # as a fifth summand of the windowed tiles.
    assert tight["open_now"]["window_exempt"] is True
    assert tight["open_now"]["as_of"] == NOW.isoformat()
    assert tight["open_now"]["complete"] is True and tight["open_now"]["reason"] == ""


def test_open_now_is_a_labelled_lower_bound_when_the_fetch_was_truncated() -> None:
    """``window_covered`` does NOT rescue ``open_now`` — its population is the fetch,
    not the window — so it carries its own completeness flag."""
    cases = [
        _case("k-new", created="2026-06-30T11:00:00+00:00", status=CaseStatus.OPEN),
        # The fetched rows reach back well before a 24h cutoff, so the WINDOW is
        # complete even though the fetch is not.
        _case("k-old", created="2026-06-20T11:00:00+00:00", status=CaseStatus.OPEN),
    ]
    roll = M.posture_metrics(cases, window_hours=24, now=NOW, store_total=9000)
    assert roll["window_covered"] is True        # the 24h window IS fully read...
    assert roll["open_now"]["complete"] is False  # ...but the stock still is not.
    assert "lower bound" in roll["open_now"]["reason"]


# --------------------------------------------------------------------------- #
# (c) window_covered — the honest-coverage flag
# --------------------------------------------------------------------------- #
def test_window_covered_true_for_a_fully_covered_window_on_a_truncated_fetch() -> None:
    """The case this flag exists for: the store holds far more than the fetch bound
    (so ``truncated`` is permanently True), yet every case that could satisfy the
    selected window was read. The tile must be able to publish a real number."""
    cases = [
        _case("cov-1", created="2026-06-30T11:00:00+00:00"),
        # The oldest fetched row reaches back 5 days — well before a 24h cutoff.
        _case("cov-2", created="2026-06-25T11:00:00+00:00"),
    ]
    roll = M.posture_metrics(cases, window_hours=24, now=NOW, store_total=50000)
    assert roll["truncated"] is True and roll["store_total"] == 50000
    assert roll["window_covered"] is True
    assert roll["window_coverage_reason"] == ""
    assert roll["oldest_fetched_at"] == "2026-06-25T11:00:00+00:00"


def test_window_covered_false_when_the_cutoff_predates_the_oldest_fetched_row() -> None:
    cases = [
        _case("nc-1", created="2026-06-30T11:00:00+00:00"),
        _case("nc-2", created="2026-06-30T06:00:00+00:00"),
    ]
    # A 720h window reaches back a month; the fetched rows only reach back 6 hours, and
    # the store held more — so cases inside the window were NOT read.
    roll = M.posture_metrics(cases, window_hours=720, now=NOW, store_total=50000)
    assert roll["truncated"] is True
    assert roll["window_covered"] is False
    assert "starts before the oldest fetched case" in roll["window_coverage_reason"]
    assert roll["oldest_fetched_at"] == "2026-06-30T06:00:00+00:00"


def test_window_covered_true_whenever_the_fetch_was_complete() -> None:
    cases = [_case("full-1", created="2026-06-30T11:00:00+00:00")]
    for window in (0, 1, 24, 720):
        roll = M.posture_metrics(cases, window_hours=window, now=NOW, store_total=1)
        assert roll["truncated"] is False
        assert roll["window_covered"] is True
        assert roll["window_coverage_reason"] == ""
    # A caller that omits store_total gets the same conservative "we have it all".
    legacy = M.posture_metrics(cases, window_hours=24, now=NOW)
    assert legacy["window_covered"] is True


def test_unbounded_window_can_never_be_proven_covered_by_a_partial_fetch() -> None:
    cases = [_case("unb", created="2026-06-30T11:00:00+00:00")]
    roll = M.posture_metrics(cases, window_hours=0, now=NOW, store_total=50000)
    assert roll["window_covered"] is False
    assert "unbounded" in roll["window_coverage_reason"]


def test_window_coverage_needs_a_parseable_floor_to_claim_anything() -> None:
    # A truncated fetch whose only rows carry unusable creation times proves nothing
    # about how far back the read reached.
    roll = M.posture_metrics(
        [_case("bad", created="not-a-timestamp")], window_hours=24, now=NOW, store_total=9000
    )
    assert roll["window_covered"] is False
    assert roll["oldest_fetched_at"] is None
    assert "no fetched case carries a parseable creation time" in roll["window_coverage_reason"]

    # An empty truncated fetch is the same story, not a silent "covered".
    empty = M.posture_metrics([], window_hours=24, now=NOW, store_total=9000)
    assert empty["window_covered"] is False and empty["oldest_fetched_at"] is None


def test_window_coverage_boundary_is_inclusive() -> None:
    """``cutoff >= floor`` — a window whose cutoff lands exactly on the oldest fetched
    row is covered; one second earlier is not."""
    cases = [_case("edge", created="2026-06-29T12:00:00+00:00")]
    exact = M.posture_metrics(cases, window_hours=24, now=NOW, store_total=9000)
    assert exact["window_covered"] is True
    wider = M.posture_metrics(cases, window_hours=25, now=NOW, store_total=9000)
    assert wider["window_covered"] is False


def test_a_failed_case_load_is_never_published_as_a_complete_measurement() -> None:
    """REGRESSION. The route soft-fails a store error to ``([], 0)`` so a dashboard
    never 500s — and that is indistinguishable from an empty store: zero rows AND
    ``store_total=0`` make ``truncation_marker`` report "not truncated", after which
    the rollup published ``open_now: {count: 0, complete: true, reason: ""}`` and
    ``window_covered: true``. An outage was rendered as a proven-complete "0 open
    cases", on exactly the two flags whose job is to license a tile to publish."""
    roll = M.posture_metrics([], window_hours=24, now=NOW, store_total=0, load_ok=False)
    assert roll["open_now"]["count"] == 0
    assert roll["open_now"]["complete"] is False
    assert "could not be read" in roll["open_now"]["reason"]
    assert roll["window_covered"] is False
    assert "could not be read" in roll["window_coverage_reason"]
    # An unbounded window, and a non-empty carried-over set, are no different.
    for kw in ({"window_hours": 0}, {"window_hours": 24}):
        assert M.posture_metrics(
            [], now=NOW, store_total=0, load_ok=False, **kw
        )["window_covered"] is False

    # A genuinely empty store still reports honestly — the flag is about the FETCH.
    healthy = M.posture_metrics([], window_hours=24, now=NOW, store_total=0)
    assert healthy["open_now"]["complete"] is True and healthy["open_now"]["reason"] == ""
    assert healthy["window_covered"] is True and healthy["window_coverage_reason"] == ""

    # ``truncation_marker`` is shared by four rollups and stays a pure function of
    # (fetched, store_total): the outage is carried by the completeness flags only.
    assert roll["truncated"] is False
    assert roll["store_total"] == 0 and roll["fetched"] == 0


def test_truncation_marker_output_is_byte_identical() -> None:
    """PINNED. Four rollups share this marker; ``window_covered`` is emitted ALONGSIDE
    it and must never widen or reshape it."""
    assert M.truncation_marker(2, store_total=3) == {
        "truncated": True, "store_total": 3, "fetched": 2,
    }
    assert M.truncation_marker(3, store_total=3) == {
        "truncated": False, "store_total": 3, "fetched": 3,
    }
    assert M.truncation_marker(3) == {"truncated": False, "store_total": 3, "fetched": 3}
    # Exact key set, in exact order — no new key leaked in.
    assert list(M.truncation_marker(1, store_total=9).keys()) == [
        "truncated", "store_total", "fetched",
    ]


# --------------------------------------------------------------------------- #
# (d) the three-way close breakdown stays a visible partition of terminal_cases
# --------------------------------------------------------------------------- #
def test_close_breakdown_sums_to_terminal_cases_on_a_mixed_fixture() -> None:
    cases = [
        # AI-closed
        _case("q-a1", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT),
        _case("q-a2", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.RESOLVED, decision_by=DecisionBy.AGENT),
        # human-closed
        _case("q-h1", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST),
        # deterministic system routing
        _case("q-s1", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.RESOLVED, decision_by=DecisionBy.SYSTEM),
        # legacy record carrying NO provenance at all
        _case("q-legacy", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.CLOSED, decision_by=None),
        # still open — not in the terminal population at all
        _case("q-open", created="2026-06-30T11:00:00+00:00", status=CaseStatus.OPEN),
    ]
    q = M.quality_metrics(cases)
    assert q["terminal_cases"] == 5
    assert q["auto_closed_cases"] == 2
    assert q["human_closed_cases"] == 1
    # The honest residual: SYSTEM routing + the legacy null, reported on its own rather
    # than folded into "human work".
    assert q["system_closed_cases"] == 2
    assert (
        q["auto_closed_cases"] + q["human_closed_cases"] + q["system_closed_cases"]
        == q["terminal_cases"]
    )
    # Human work is NOT terminal - auto_closed (that would over-state it by 1 here).
    assert q["human_closed_cases"] != q["terminal_cases"] - q["auto_closed_cases"]


def test_close_breakdown_residual_stays_visible_at_zero() -> None:
    """Render THREE rows or none: a 0 residual must still be present on the wire so a
    surface cannot quietly drop it and imply the split is exhaustive when it is not."""
    cases = [
        _case("z-a", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT),
        _case("z-h", created="2026-06-30T11:00:00+00:00",
              status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST),
    ]
    roll = M.posture_metrics(cases, window_hours=24, now=NOW)
    q = roll["quality"]
    for key in ("terminal_cases", "auto_closed_cases", "human_closed_cases", "system_closed_cases"):
        assert key in q
    assert q["system_closed_cases"] == 0
    assert q["auto_closed_cases"] + q["human_closed_cases"] + q["system_closed_cases"] == 2


# --------------------------------------------------------------------------- #
# Route level — the tiles get the populations, and prefs really are threaded in
# --------------------------------------------------------------------------- #
@pytest.fixture
def metrics_client(app_state):
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


async def test_posture_endpoint_exposes_the_five_tile_populations(
    metrics_client, app_state
) -> None:
    await app_state.cases.save(
        _case("r-open", created=_ago(2), status=CaseStatus.OPEN, risk=95.0)
    )
    await app_state.cases.save(
        _case(
            "r-closed", created=_ago(3),
            status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT, risk=10.0,
        )
    )
    body = metrics_client.get("/api/metrics/posture?window_hours=24").json()

    assert body["case_count"] == 2
    assert sum(body["severity_counts"].values()) == body["case_count"]
    assert list(body["severity_counts"].keys()) == list(SEVERITY_BANDS)
    assert body["severity_counts"]["critical"] == 1
    assert body["open_now"]["count"] == 1
    assert body["open_now"]["window_exempt"] is True
    assert body["window_covered"] is True and body["window_coverage_reason"] == ""
    q = body["quality"]
    assert q["terminal_cases"] == 1
    assert (
        q["auto_closed_cases"] + q["human_closed_cases"] + q["system_closed_cases"]
        == q["terminal_cases"]
    )
    # The truncation marker is untouched by the new keys.
    assert body["truncated"] is False and body["fetched"] == body["store_total"] == 2


async def test_posture_endpoint_bands_against_the_configured_source_ceiling(
    metrics_client, app_state
) -> None:
    """Proof the route threads ``Preferences`` into the read-time projection: the same
    stored case bands differently once the operator declares the source's ladder."""
    await app_state.cases.save(
        _case("r-sev", created=_ago(2), severity_max=12.0, source_id="src-x", risk=0.0)
    )
    undeclared = metrics_client.get("/api/metrics/posture?window_hours=24").json()
    assert undeclared["severity_counts"]["low"] == 1
    assert undeclared["severity_counts"]["critical"] == 0

    await app_state.update_prefs(
        app_state.prefs.model_copy(
            update={
                "sources": [
                    SourceInstance(
                        id="src-x",
                        source_type=SourceType.GENERIC,
                        severity_scale_max=16.0,
                    )
                ]
            }
        )
    )
    declared = metrics_client.get("/api/metrics/posture?window_hours=24").json()
    assert declared["severity_counts"]["critical"] == 1
    assert declared["severity_counts"]["low"] == 0


async def test_posture_endpoint_publishes_coverage_on_a_truncated_fetch(
    metrics_client, app_state, monkeypatch
) -> None:
    """A store above the fetch bound is permanently ``truncated`` — the flag that made
    every posture-fed tile withhold. ``window_covered`` is what lets them publish."""
    monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", 2)
    # Newest-first, the two fetched rows reach back 10 days — past a 24h cutoff — so the
    # selected window is fully answerable even though the fetch is not complete.
    for cid, hours in (("cvg-new", 2), ("cvg-mid", 240), ("cvg-old", 500)):
        await app_state.cases.save(_case(cid, created=_ago(hours), status=CaseStatus.OPEN))
    body = metrics_client.get("/api/metrics/posture?window_hours=24").json()
    assert body["truncated"] is True and body["store_total"] == 3 and body["fetched"] == 2
    assert body["window_covered"] is True and body["window_coverage_reason"] == ""
    assert body["case_count"] == 1
    # ...but the window-exempt stock is still only a lower bound.
    assert body["open_now"]["complete"] is False
    assert "lower bound" in body["open_now"]["reason"]

    # Widen past the oldest FETCHED row and the honest answer flips back to withholding.
    wide = metrics_client.get("/api/metrics/posture?window_hours=720").json()
    assert wide["window_covered"] is False
    assert "starts before the oldest fetched case" in wide["window_coverage_reason"]


async def test_posture_endpoint_reports_a_store_outage_as_not_measured(
    metrics_client, app_state, monkeypatch
) -> None:
    """End to end: the route still answers 200 with zeros (a dashboard must not 500),
    but it no longer certifies those zeros."""
    async def boom(*_a, **_kw):
        raise RuntimeError("elasticsearch unavailable")

    monkeypatch.setattr("app.api.routes_metrics.fetch_case_page", boom)
    body = metrics_client.get("/api/metrics/posture?window_hours=24").json()
    assert body["case_count"] == 0 and body["open_now"]["count"] == 0
    assert body["open_now"]["complete"] is False
    assert body["window_covered"] is False
    assert "could not be read" in body["window_coverage_reason"]
