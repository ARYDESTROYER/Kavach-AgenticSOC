"""Richer security-posture + MITRE ATT&CK coverage metrics (Round 3 / Feature 5).

ADDITIVE endpoints — the existing ``GET /api/metrics`` (in the monolith router) is
untouched. These serve the rich, server-side rollup the posture dashboards consume:

* ``GET /api/metrics/posture`` — lifecycle (MTTA/MTTR/dwell p50/p90/mean), quality
  rates (alert-to-incident / FP / escalation / containment / automation), aging
  (buckets + oldest-N + queue depth + closure-vs-arrival), SLA attainment vs
  ``Preferences.sla``, all with optional period-over-period deltas.
* ``GET /api/metrics/auto-close-health`` — the rolling auto-close rate as a
  first-class health signal, with enough context (decided volume in both windows +
  the configured policy) to tell "auto-close collapsed" from "no volume" or "the
  operator turned it off". See also ``GET /api/diagnostics/health``.
* ``GET /api/mitre/coverage`` — per-tactic technique coverage vs the bundled corpus.
* ``GET /api/mitre/coverage/navigator.layer.json`` — an ATT&CK Navigator v4.5 layer
  dict the UI can hand straight to the Navigator.

Every value is DETERMINISTIC + advisory: nothing here is read by
``case_manager.decide()`` (#3). Technique ids from case data are VALIDATED + dropped
when invalid (#9 — handled in ``engine/mitre_coverage``); we return plain framework
data (the UI renders escaped). All GETs inherit ``require_auth`` from the mount and
also assert the narrow ``metrics:view`` grant. No non-GET routes.
"""

from __future__ import annotations

import logging
import math
from datetime import date, datetime, time, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..engine.agent_improvement import agent_improvement_metrics
from ..engine.clustering_explain import build_case_lineage
from ..engine.metrics import (
    _window_filter,
    auto_close_health,
    posture_metrics,
    trend_metrics,
)
from ..engine.mitre_coverage import compute_mitre_coverage, navigator_layer
from ..engine.noise_counters import build_noise_reduction
from ..state import AppState
from ..utils import iso_now
from .deps import get_state, require_permission
from .metrics_shared import fetch_case_page

logger = logging.getLogger("tlsoc.api.metrics")
router = APIRouter(prefix="/api")

# How many cases we pull from the store before time-bounding in the pure functions.
# A generous server-side bound (not a 200 client sample) so the posture rollup is
# computed over up to the most-recent 5000 cases, then window-filtered
# deterministically. When the store holds MORE than this, the rollup is a partial
# (newest-N) view; the response carries a ``truncated``/``store_total``/``fetched``
# marker so a consumer can tell a lower-bound tally from a complete one rather than
# silently trusting a wrong number.
_STORE_FETCH_LIMIT = 5000
_USAGE_FETCH_LIMIT = 5000
_TUNING_FETCH_LIMIT = 1000


async def _load_cases(state: AppState) -> tuple[list, int]:
    """Fetch up to the most recent ``_STORE_FETCH_LIMIT`` cases (newest first) for the
    posture/coverage rollups, AND the store's reported total so the rollup can flag a
    truncated/partial result honestly instead of silently returning a number computed
    over only the newest N cases.

    Served through the SHARED short-TTL page cache (``api/metrics_shared``) so the
    dashboard's parallel endpoint fan-out and its LIVE poll cadence perform ONE store
    scan per TTL window instead of one per endpoint per refresh. The cache is keyed
    by the (store identity, fetch limit) pair, so a monkeypatched
    ``_STORE_FETCH_LIMIT`` or a Demo Mode store swap always bypasses stale pages.

    Defensive: a store error degrades to an empty list (total 0) rather than failing
    the request (a dashboard query must never 500 on a transient store hiccup).

    That degradation is INDISTINGUISHABLE from an empty store on its own — same rows,
    same total — so any rollup that publishes a completeness assertion must take the
    three-value :func:`_load_cases_ok` instead and thread ``load_ok`` through. This
    two-value form is kept for the rollups that only report counts."""
    cases, total, _ok = await _load_cases_ok(state)
    return cases, total


async def _load_cases_ok(state: AppState) -> tuple[list, int, bool]:
    """:func:`_load_cases`, plus whether the fetch actually SUCCEEDED.

    A soft-failed fetch returns ``([], 0, False)``. Both of the first two values are
    also what a genuinely empty store returns, which is why the third exists: with only
    the pair, ``truncation_marker(0, 0)`` reads "not truncated", and the posture rollup
    went on to publish ``open_now.complete=true`` / ``window_covered=true`` with empty
    reasons — a store outage rendered as a proven-complete "0 open cases"."""
    try:
        cases, total = await fetch_case_page(state.cases, _STORE_FETCH_LIMIT)
        return cases, int(total), True
    except Exception as exc:  # noqa: BLE001 — dashboards degrade, never fail hard
        logger.warning("posture/coverage case load soft-failed: %s", exc)
        return [], 0, False


def _subtract_counter_bands(
    combined: dict[str, Any] | None, current: dict[str, Any] | None
) -> dict[str, int]:
    """Return the non-negative preceding-window remainder of two band tallies.

    Only sound when both windows banded on the SAME severity ladder — see
    :func:`_severity_band_comparison`, which gates every call. The per-band
    ``max(0, ...)`` clamp silently discards a negative remainder, so across a ladder
    change it would both invent a vanished band and inflate the surviving ones."""
    combined = combined if isinstance(combined, dict) else {}
    current = current if isinstance(current, dict) else {}
    out: dict[str, int] = {}
    for key in set(combined) | set(current):
        try:
            total = max(0, int(combined.get(key) or 0))
            recent = max(0, int(current.get(key) or 0))
        except (TypeError, ValueError):
            continue
        out[str(key)] = max(0, total - recent)
    return out


def _counter_band_total(counts: Any) -> int:
    """Band-INDEPENDENT sum of one ``{band: int}`` tally (unusable entries count 0).

    A total does not depend on which severity ladder produced the split, so it stays
    comparable across a ladder change while the per-band breakdown does not."""
    if not isinstance(counts, dict):
        return 0
    total = 0
    for value in counts.values():
        try:
            total += max(0, int(value or 0))
        except (TypeError, ValueError):
            continue
    return total


def _window_band_evidence(window: Any) -> tuple[dict[str, float | None], int, int]:
    """What one counter window can PROVE about the ladder behind its band split.

    Returns ``(recorded ceiling per source, volume attributed to those sources, pooled
    volume)``. The durable counters are bucketed by band AT WRITE TIME, so a stored split
    can never be re-projected; the per-source ``severity_scale_max`` the store records is
    the only evidence of which ladder produced it. ``None`` for a source means the ceiling
    was never recorded, or the window sums hours that recorded different ones."""
    window = window if isinstance(window, dict) else {}
    pooled = _counter_band_total(window.get("ingested")) + _counter_band_total(
        window.get("clustered")
    )
    ceilings: dict[str, float | None] = {}
    attributed = 0
    by_source = window.get("by_source")
    if isinstance(by_source, dict):
        for sid, sub in by_source.items():
            if not isinstance(sub, dict):
                continue
            raw = sub.get("severity_scale_max")
            try:
                ceiling = float(raw) if raw is not None and not isinstance(raw, bool) else None
            except (TypeError, ValueError):
                ceiling = None
            # A non-positive or NON-FINITE recorded ceiling is not evidence of a ladder
            # (``inf`` passes ``> 0`` yet could only have banded everything informational).
            if ceiling is not None and (not math.isfinite(ceiling) or ceiling <= 0):
                ceiling = None
            ceilings[str(sid)] = ceiling
            attributed += _counter_band_total(sub.get("ingested")) + _counter_band_total(
                sub.get("clustered")
            )
    return ceilings, attributed, pooled


def _severity_band_comparison(current: Any, combined: Any) -> dict[str, Any]:
    """Whether two counter windows' SEVERITY-BAND splits may be compared to each other.

    Comparing per-band tallies only means something when both windows projected raw source
    severities onto the SAME declared ladder. When a source's declared severity ceiling
    changes — including the one-off change that gave every undeclared source an honest
    identity projection — the historical split cannot be recomputed, because the counters
    store bands, not raw severities, and retain them for months. A band-level delta across
    that boundary would report a band collapsing to zero and the tool would be crediting
    itself with a measurement change.

    Returns ``{"available": bool, "reason": str}``. Available ONLY when every source that
    contributed volume to both windows recorded one and the same ceiling, and no counted
    volume is unattributed. Band-INDEPENDENT totals stay comparable either way and are
    reported separately. Never raises."""
    cur_ceilings, cur_attributed, cur_pooled = _window_band_evidence(current)
    comb_ceilings, comb_attributed, comb_pooled = _window_band_evidence(combined)
    if comb_pooled <= 0 and cur_pooled <= 0:
        # Nothing was counted in either window: there is no band split to mis-compare.
        return {"available": True, "reason": ""}
    if cur_attributed < cur_pooled or comb_attributed < comb_pooled:
        return {
            "available": False,
            "reason": (
                "part of the counted alert volume is not attributed to a source that "
                "recorded the severity ceiling used to band it, so the two windows' band "
                "splits cannot be shown to describe one ladder"
            ),
        }
    if any(v is None for v in cur_ceilings.values()) or any(
        v is None for v in comb_ceilings.values()
    ):
        return {
            "available": False,
            "reason": (
                "a counted source did not record one single severity ceiling for the whole "
                "window, so its stored per-band split cannot be shown to describe one "
                "ladder; band totals recorded before the ceiling was captured cannot be "
                "re-projected"
            ),
        }
    for sid, ceiling in cur_ceilings.items():
        other = comb_ceilings.get(sid)
        if other is not None and other != ceiling:
            return {
                "available": False,
                "reason": (
                    "a counted source recorded a different severity ceiling in each "
                    "window, so their per-band splits describe different ladders"
                ),
            }
    return {"available": True, "reason": ""}


async def _load_agent_outcome_inputs(
    state: AppState,
    *,
    current_days: int,
    baseline_days: int,
    end: datetime,
) -> dict[str, Any]:
    """Bounded read-only projections for the additive outcome report.

    Failures remain explicit availability flags. No row identifiers, usage rows,
    source ids, or tuning rule ids leave the pure aggregation layer.
    """
    usage_available = True
    try:
        raw_usage = await state.usage_store.records_strict(limit=_USAGE_FETCH_LIMIT)
        usage_records = [row for row in raw_usage if isinstance(row, dict)]
    except Exception as exc:  # noqa: BLE001 — evidence degrades, route stays available
        logger.warning("agent-improvement usage read soft-failed: %s", exc)
        usage_available = False
        usage_records = []

    tuning_available = True
    try:
        raw_tuning = await state.tuning_store.list_strict()
        tuning_records = [record.to_json() for record in raw_tuning]
    except Exception as exc:  # noqa: BLE001 — evidence degrades, route stays available
        logger.warning("agent-improvement tuning read soft-failed: %s", exc)
        tuning_available = False
        tuning_records = []
    tuning_truncated = len(tuning_records) > _TUNING_FETCH_LIMIT
    tuning_records = tuning_records[:_TUNING_FETCH_LIMIT]

    required_days = {
        max(1, current_days),
        max(1, current_days + baseline_days),
        7,
        14,
        28,
        56,
    }
    try:
        noise_windows = {
            days: await state.noise_counters.read_window_strict(
                days * 24,
                now=end,
                end_exclusive=True,
            )
            for days in sorted(required_days)
        }
    except Exception as exc:  # noqa: BLE001 — evidence degrades, route stays available
        logger.warning("agent-improvement noise read soft-failed: %s", exc)
        noise_comparison = {
            "available": False,
            "reason": "durable alert counters could not be read",
            "window_basis": "complete_utc_days",
            "severity_band_comparison": {
                "available": False,
                "reason": "durable alert counters could not be read",
            },
        }
        period_noise_comparisons = {
            "week_over_week": dict(noise_comparison),
            "month_over_month": dict(noise_comparison),
        }
    else:
        def comparison(recent_days: int, preceding_days: int) -> dict[str, Any]:
            current_noise = noise_windows[recent_days]
            combined_noise = noise_windows[recent_days + preceding_days]
            available = bool(current_noise.get("available")) and bool(
                combined_noise.get("available")
            )
            # Band-INDEPENDENT totals. These stay valid across a severity-ladder change
            # (a total does not depend on how the volume was split), and they are also
            # the only correct preceding-window total: subtracting BAND BY BAND clamps
            # each band at zero, so a band that moved would leave its whole count in the
            # remainder and inflate the baseline total.
            band_comparison = _severity_band_comparison(current_noise, combined_noise)
            comparable = bool(band_comparison["available"])
            totals: dict[str, dict[str, int]] = {"current": {}, "baseline": {}}
            for key in ("ingested", "clustered"):
                recent_total = _counter_band_total(current_noise.get(key))
                combined_total = _counter_band_total(combined_noise.get(key))
                totals["current"][f"{key}_total"] = recent_total
                totals["baseline"][f"{key}_total"] = max(0, combined_total - recent_total)
            return {
                "available": available,
                "reason": "" if available else "durable alert counters are still warming up",
                "incomplete": bool(current_noise.get("incomplete"))
                or bool(combined_noise.get("incomplete")),
                "window_basis": "complete_utc_days",
                "end_exclusive": end.date().isoformat(),
                # Whether the two windows' per-band splits may be compared at all, and
                # (when not) the measured reason. Band-independent totals above remain
                # reported either way, so volume reporting never degrades because of this.
                "severity_band_comparison": band_comparison,
                "current": {
                    "ingested": current_noise.get("ingested") if comparable else None,
                    "clustered": current_noise.get("clustered") if comparable else None,
                    **totals["current"],
                },
                "baseline": {
                    "ingested": (
                        _subtract_counter_bands(
                            combined_noise.get("ingested"), current_noise.get("ingested")
                        )
                        if comparable
                        else None
                    ),
                    "clustered": (
                        _subtract_counter_bands(
                            combined_noise.get("clustered"), current_noise.get("clustered")
                        )
                        if comparable
                        else None
                    ),
                    **totals["baseline"],
                },
            }

        noise_comparison = comparison(current_days, baseline_days)
        period_noise_comparisons = {
            "week_over_week": comparison(7, 7),
            "month_over_month": comparison(28, 28),
        }

    return {
        "usage_records": usage_records,
        "usage_available": usage_available,
        # The strict projection has no total count, so cap saturation is partial.
        "usage_records_truncated": len(usage_records) >= _USAGE_FETCH_LIMIT,
        "noise_comparison": noise_comparison,
        "period_noise_comparisons": period_noise_comparisons,
        "tuning_records": tuning_records,
        "tuning_available": tuning_available,
        "tuning_records_truncated": tuning_truncated,
    }


@router.get("/metrics/posture")
async def metrics_posture(
    window_hours: int = 24,
    compare: str = "",
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The rich security-posture rollup over the last ``window_hours``, computed over
    up to the most-recent 5000 cases (the response's ``truncated`` flag is True when
    the store held more).

    ``compare=prev`` adds period-over-period deltas vs the immediately-preceding
    equal-length window. SLA targets come from ``Preferences.sla`` (advisory; #3).

    The headline populations, and which of them ``window_hours`` bounds — the five
    Console tiles are built on exactly these and they are NOT interchangeable::

        {"case_count": int,                     # arrival cohort in-window, policy-closed INCLUDED
         "severity_counts": {"critical": int, "high": int, "medium": int,
                             "low": int, "info": int},   # partitions case_count exactly
         "open_now": {"count": int, "window_exempt": true, "as_of": iso8601,
                      "complete": bool, "reason": str},  # STOCK, measured now, NOT windowed
         "quality": {"terminal_cases": int, "auto_closed_cases": int,
                     "human_closed_cases": int, "system_closed_cases": int,
                     "false_positive_rate": float, ...},
         "truncated": bool, "store_total": int, "fetched": int,
         "window_covered": bool, "window_coverage_reason": str,
         "oldest_fetched_at": iso8601 | null}

    * ``severity_counts`` is server-side and covers the FULL windowed population; it
      exists so no client has to infer a band total from whatever bounded page of
      cases it happens to hold. Bands are the read-time advisory ladder
      (``engine.priority.band_of_case``), resolved against each source's DECLARED
      severity ceiling — hence ``Preferences`` is threaded in. Nothing is persisted.
    * ``open_now`` is deliberately window-EXEMPT and carries ``window_exempt: true``
      so it can never be rendered as summing with the windowed tiles.
      ``aging.queue_depth`` is the cohort-scoped "arrived in-window and still open"
      number and is a different figure.
    * ``auto_closed_cases`` + ``human_closed_cases`` + ``system_closed_cases`` sum
      EXACTLY to ``terminal_cases``. Render all three or none: the residual (SYSTEM
      routing + legacy records with no recorded decider) must stay visible even at 0,
      and human work is NEVER ``terminal_cases - auto_closed_cases``. These report the
      LAST recorded decider — see ``engine.metrics.quality_metrics`` for the caveat a
      "human vs AI" surface must disclose.
    * ``window_covered`` is the honest-coverage flag. ``truncated`` alone is permanent
      for any deployment above the 5000-case fetch bound; ``window_covered`` says
      whether the SELECTED window is nonetheless fully answerable from the rows that
      were read (cutoff at or after ``oldest_fetched_at``), which is what lets a tile
      publish a real number instead of withholding forever. It does not apply to
      ``open_now``, which carries its own ``complete`` flag.
    * A case-store OUTAGE soft-fails to an empty fetch so the dashboard never 500s.
      Both completeness flags then go False with a reason naming the failure: the
      counts are still zeros, but zero-because-unreadable is not a measurement and must
      never be published as one. ``truncated`` is unchanged (it compares fetched with
      store-reported total, and both are 0)."""
    cases, store_total, load_ok = await _load_cases_ok(state)
    sla_policy = getattr(state.prefs, "sla", None)
    return posture_metrics(
        cases,
        sla_policy=sla_policy,
        window_hours=max(0, int(window_hours)),
        compare=(compare or "").strip().lower(),
        store_total=store_total,
        prefs=state.prefs,
        load_ok=load_ok,
    )


@router.get("/metrics/trends")
async def metrics_trends(
    window_hours: int = 24,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Bucketed case-cohort + raw-alert trends over the trailing ``window_hours``
    (clamped to 1..720) — the Overview hover-trendline feed.

    FROZEN response contract::

        {"window_hours": int, "bucket_minutes": int, "generated_at": iso8601,
         "buckets": [{"t": iso8601 bucket-start UTC, "new_cases": int, "closed": int,
                      "auto_closed": int, "false_positives": int, "needs_human": int,
                      "escalated": int, "fp_rate": float 0-100 | null,
                      "alerts": int | null}],
         "truncated": bool, "store_total": int, "fetched": int}

    ``bucket_minutes`` follows the frozen ladder (<=24h → 60, <=72h → 180,
    <=168h → 360, else 1440); buckets are UTC-aligned, zero-filled across the whole
    window, newest bucket partial. Cohort counts reuse the exact
    ``engine.metrics.quality_metrics`` field/verdict/decision_by semantics so they
    reconcile with the posture tiles; ``fp_rate`` mirrors posture's
    ``false_positive_rate`` numerator/denominator within the bucket (null when no
    verdicted case). ``alerts`` comes from the durable noise counters' per-hour
    ingested tallies (null when the counters are warming up / unreadable, and for
    buckets predating their first observation).

    Served from the SAME shared short-TTL case page as the other posture rollups
    (one store scan per TTL window), computed over up to the most-recent
    ``_STORE_FETCH_LIMIT`` cases — the ``truncated``/``store_total``/``fetched``
    marker keeps a partial (newest-N) tally honest. DETERMINISTIC + advisory:
    nothing here is read by ``case_manager.decide()`` (#3)."""
    cases, store_total = await _load_cases(state)
    wh = max(1, min(720, int(window_hours)))
    alert_counters: dict[str, Any] | None = None
    try:
        # +24h of hourly slack so the aligned FIRST bucket (which can start up to one
        # full bucket — max 24h — before the window edge) is fully covered.
        alert_counters = await state.noise_counters.read_hourly_ingested(wh + 24)
    except Exception as exc:  # noqa: BLE001 — a counter glitch degrades to null alerts
        logger.warning("trends counter read soft-failed: %s", exc)
        alert_counters = None
    return trend_metrics(
        cases,
        window_hours=wh,
        store_total=store_total,
        alert_counters=alert_counters,
    )


@router.get("/metrics/auto-close-health")
async def metrics_auto_close_health(
    window_hours: int = Query(default=24, ge=1, le=8760),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The rolling auto-close rate as a FIRST-CLASS health signal.

    Auto-close silently ceasing is the failure this endpoint exists for: an unrelated
    configuration change starved the precedent corpus, auto-close stopped forever, and
    nothing surfaced it. A rate that falls to ~0 **while decided volume holds steady**
    is that outage; a rate of 0 because nobody sent any work, or because the operator
    turned auto-close off, is not. The response reports both windows' raw counts plus
    an explicit ``status`` so those are distinguishable rather than conflated.

    Insufficient evidence stays explicit: a window without enough decided cases returns
    a DASH rate and ``available: false`` with a reason, never a reassuring number. There
    is no composite score.

    READ-ONLY derivation over already-persisted cases, computed over up to the most
    recent 5000 (``truncated`` says when the store held more). The auto-close policy is
    read for DISPLAY only — nothing here is ever an input to ``decide()`` (#3)."""
    cases, store_total = await _load_cases(state)
    return auto_close_health(
        cases,
        window_hours=int(window_hours),
        policy=getattr(getattr(state, "prefs", None), "auto_close", None),
        store_total=store_total,
    )


@router.get("/metrics/agent-improvement")
async def metrics_agent_improvement(
    as_of: date | None = Query(
        default=None,
        description=(
            "Exclusive UTC date boundary. Omit to compare the last seven complete "
            "UTC days with the preceding 28 complete days."
        ),
    ),
    current_days: int = Query(default=7, ge=1, le=31),
    baseline_days: int = Query(default=28, ge=7, le=90),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Aggregate-only evidence of agent-assisted triage effectiveness.

    The response reports analyst-reported verdict agreement, material correction
    rate, human review turnaround, recorded case-associated cost, observed elapsed-
    closure differences, confirmed-positive case mix, alert volume, and non-causal
    threshold-tuning context. Unsupported true-positive-alert yield and source-gap
    guidance remain explicitly unavailable. It never emits a synthetic score, row or
    case identifiers, raw evidence, model calls, or writes; a truncated, mix-shifted,
    guardrail-unevaluable, or undersized cohort is explicitly classified as
    insufficient evidence. Reporting remains advisory and is never read by the
    deterministic case decision (#3).
    """
    request_now = datetime.now(timezone.utc)
    if as_of is not None and as_of > request_now.date():
        raise HTTPException(
            status_code=422,
            detail="as_of is an exclusive UTC boundary and cannot be in the future",
        )
    cases, store_total = await _load_cases(state)
    end_date = as_of or request_now.date()
    report_end = datetime.combine(end_date, time.min, tzinfo=timezone.utc)
    outcome_inputs = await _load_agent_outcome_inputs(
        state,
        current_days=current_days,
        baseline_days=baseline_days,
        end=report_end,
    )
    return agent_improvement_metrics(
        cases,
        as_of=as_of,
        current_days=current_days,
        baseline_days=baseline_days,
        now=request_now,
        store_total=store_total,
        synthetic=state.demo_active,
        # Resolve each case's advisory severity band for the mix strata (the persisted
        # attribute is never written by a production path). Advisory only (#3).
        prefs=state.execution_prefs,
        **outcome_inputs,
    )


@router.get("/metrics/noise-reduction")
async def metrics_noise_reduction(
    window_hours: int = 24,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The Noise-Reduction funnel over the last ``window_hours`` (default 24) — "total
    alerts by severity → what the AI reduced it to".

    ``ingested``/``clustered`` come from the DURABLE ``noise_counters`` store (raw-alert-by-
    severity, so they reflect the TRUE inbound volume even after low-value events are
    dropped at ingest); ``cases`` + the MECE outcomes (needs_human > escalated >
    auto_cleared > true_positive residual) come from a case tally computed over up to the
    most-recent 5000 cases (the ``cases_meta.truncated`` flag is True when the store held
    more — the outcome tallies are then a lower bound). When the counters are still warming
    up (``counters.available: false``) the ingested/clustered totals are ``null`` and the
    headline ``reduction.overall_pct`` is a DASH, so the UI degrades to a case-only funnel.

    DETERMINISTIC + advisory: nothing here is read by ``case_manager.decide()`` (#3); every
    band name is plain framework data the UI renders escaped."""
    cases, store_total = await _load_cases(state)
    wh = max(0, int(window_hours))
    try:
        counters = await state.noise_counters.read_window(wh)
    except Exception as exc:  # noqa: BLE001 — a counter glitch degrades to case-only funnel
        logger.warning("noise-reduction counter read soft-failed: %s", exc)
        counters = {"available": False}
    return build_noise_reduction(
        cases,
        counters,
        window_hours=wh,
        store_total=store_total,
        fetched_count=len(cases),
        # ``execution_prefs`` so the funnel bands the SAME cases the same way as its own
        # ``/lineage`` rows and the case surfaces (under an active demo sandbox the cases
        # come from the demo stack, so the real tenant prefs are the wrong authority).
        prefs=getattr(state, "execution_prefs", None),
        generated_at=iso_now(),
    )


@router.get("/metrics/noise-reduction/lineage")
async def metrics_noise_reduction_lineage(
    window_hours: int = 24,
    limit: int = Query(default=12, ge=1, le=25),
    state: AppState = Depends(get_state),
    _metrics_permission=Depends(require_permission("metrics", "view")),
    _cases_permission=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Bounded redacted alert → cluster → case → outcome lineages.

    This lazy drill-down complements the aggregate Noise Reduction endpoint.  It
    reuses the persisted Threat Context clustering projection, returns only the
    newest ``limit`` cases in the selected window, and never returns raw alert ids
    or payloads.  A store-page cap is reported explicitly so the Console cannot
    imply that a bounded sample represents every historical case.

    Read-only/advisory: no correlation is re-run and no value here participates in
    risk scoring or the deterministic close/escalate decision (#3).
    """
    cases, store_total = await _load_cases(state)
    wh = max(0, int(window_hours))
    window_cases = _window_filter(cases, window_hours=wh)
    prefs = state.execution_prefs
    rows = [build_case_lineage(case, prefs) for case in window_cases[:limit]]
    store_truncated = store_total > len(cases)
    return {
        "window_hours": wh,
        "generated_at": iso_now(),
        "rows": rows,
        "meta": {
            "returned": len(rows),
            # This is deliberately named as a count inside the fetched store page:
            # when the store itself was truncated, it is only a lower bound.
            "window_cases_in_fetched_page": len(window_cases),
            "fetched_cases": len(cases),
            "store_total": store_total,
            "limit": limit,
            "truncated": len(window_cases) > limit or store_truncated,
            "store_truncated": store_truncated,
        },
        "limitations": (
            "Rows are a bounded newest-case sample. Alert references are stable one-way "
            "identifiers for persisted case inputs; raw alerts and alerts that never formed "
            "a case are represented only by the aggregate counters."
        ),
    }


@router.get("/mitre/coverage")
async def mitre_coverage(
    window_hours: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Per-tactic MITRE ATT&CK technique coverage tallied from our case load against
    the bundled corpus, over up to the most-recent 5000 cases (the response's
    ``truncated`` flag is True when the store held more — the covered tally is then a
    lower bound). ``window_hours=0`` (default) covers ALL fetched cases; a positive
    value time-bounds to created-within. Invalid/forged technique ids are dropped (#9).
    """
    cases, store_total = await _load_cases(state)
    fetched_count = len(cases)  # rows pulled from the store, BEFORE window-filtering
    if window_hours and window_hours > 0:
        from ..engine.metrics import _window_filter

        cases = _window_filter(cases, window_hours=int(window_hours))
    out = compute_mitre_coverage(cases, store_total=store_total, fetched_count=fetched_count)
    out["window_hours"] = int(window_hours) if window_hours and window_hours > 0 else 0
    return out


@router.get("/mitre/coverage/navigator.layer.json")
async def mitre_coverage_navigator(
    window_hours: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Return an ATT&CK **Navigator v4.5** layer dict for the case coverage. Pure
    JSON the UI hands straight to the Navigator; invalid ids never appear (#9)."""
    cases, store_total = await _load_cases(state)
    fetched_count = len(cases)  # rows pulled from the store, BEFORE window-filtering
    wh = int(window_hours) if window_hours and window_hours > 0 else 0
    if wh > 0:
        from ..engine.metrics import _window_filter

        cases = _window_filter(cases, window_hours=wh)
    return navigator_layer(
        cases, window_hours=wh or None, store_total=store_total, fetched_count=fetched_count
    )
