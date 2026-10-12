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
* ``GET /api/metrics/auto-close-health/recorded`` — the SAME signal measured from the
  append-only decision trail (first-decision anchored, immune to later analyst
  re-tags, with recorded dependency outages excluded). Shipped BESIDE the legacy
  endpoint above, which is unchanged; the two are expected to differ.
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

import asyncio
import logging
import math
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ..constants import ActionType
from ..engine.agent_improvement import agent_improvement_metrics
from ..engine.clustering_explain import build_case_lineage
from ..engine.metrics import (
    _window_filter,
    auto_close_health,
    compute_metrics,
    posture_metrics,
    recorded_auto_close_health,
    trend_metrics,
    truncation_marker,
)
from ..engine.mitre_coverage import compute_mitre_coverage, navigator_layer
from ..engine.noise_counters import build_noise_reduction
from ..state import AppState
from ..utils import iso_now
from .deps import get_state, require_permission
from .metrics_shared import (
    CasePopulation,
    fetch_case_breakdown,
    fetch_case_population,
    fetch_ledger_span,
)

logger = logging.getLogger("tlsoc.api.metrics")
router = APIRouter(prefix="/api")

# The most cases ONE rollup reads and holds. Round 12: the rollups no longer read the
# newest N cases of the WHOLE store — each reads the newest cases of ITS window
# (``api.metrics_shared.fetch_case_population``: newest-first with the window pushed
# into the store, stopping after this many rows, so a read never costs more), and the
# window's size, the store total and the open-now stock are exact COUNT push-downs. A
# window holding no more cases than this is exact; a larger one is analysed over its
# newest cases and the response's ``truncated``/``store_total``/``fetched`` marker says
# so (``store_total`` = the exact number of cases in the rollup's scope, ``fetched`` =
# cases analysed), so a lower bound is never presented as a complete number.
_STORE_FETCH_LIMIT = 20000
_TUNING_FETCH_LIMIT = 1000
# The longest ``window_hours`` a rollup takes literally (about a century: no case is
# older). Anything longer is the same population, so it is clamped rather than turned
# into an out-of-range date (a dashboard query never 500s on a large number).
_MAX_WINDOW_HOURS = 876_000


def _window(window_hours: Any) -> int:
    """``window_hours`` as a safe non-negative int (0 = all time), clamped to
    ``_MAX_WINDOW_HOURS``."""
    try:
        hours = int(window_hours)
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, min(hours, _MAX_WINDOW_HOURS))


# A rollup over at least this many cases runs in a worker thread (they are pure
# functions over shared, read-only Case objects), so a 20,000-case rollup never holds
# the event loop that also streams chat answers, SSE heartbeats and ingest. Smaller
# rollups run inline (no thread hop for the common small deployment).
_OFFLOAD_AT = 2000


async def _rollup(fn: Any, cases: list, *args: Any, **kwargs: Any) -> Any:
    """``fn(cases, *args, **kwargs)`` — in a worker thread when ``cases`` is large."""
    if len(cases) >= _OFFLOAD_AT:
        return await asyncio.to_thread(fn, cases, *args, **kwargs)
    return fn(cases, *args, **kwargs)


async def _population(state: AppState, span_hours: int | None) -> CasePopulation:
    """The exact case population a rollup needs: every case created in the last
    ``span_hours`` (``None``/``0`` = all time), plus exact store-wide counts.

    Served through the SHARED 5 s single-flight cache (``api/metrics_shared``), keyed
    by store identity and ``_STORE_FETCH_LIMIT``, so the dashboard's parallel fan-out
    and LIVE cadence share one scan per window, a wider cached window serves a narrower
    one, and a Demo Mode store swap or a monkeypatched limit never reuses a stale
    population. A store outage never raises: ``load_ok`` goes False and the rollups
    carry it into their completeness flags (an outage is never "0 open cases")."""
    return await fetch_case_population(
        state.cases, span_hours=span_hours, limit=_STORE_FETCH_LIMIT
    )


async def _load_cases(state: AppState) -> tuple[list, int]:
    """``(cases, scope_total)`` over the ALL-TIME population (compatibility helper).

    A soft-failed load is indistinguishable from an empty store in this pair, so a
    rollup that publishes a completeness assertion takes :func:`_load_cases_ok`."""
    cases, total, _ok = await _load_cases_ok(state)
    return cases, total


async def _load_cases_ok(state: AppState) -> tuple[list, int, bool]:
    """:func:`_load_cases`, plus whether the load actually SUCCEEDED (``([], 0, False)``
    on an outage — the third value is what keeps an outage from being published as a
    proven-complete empty store)."""
    population = await _population(state, None)
    return population.cases, population.scope_total, population.load_ok


async def legacy_metrics_payload(state: AppState, window_hours: int) -> dict[str, Any]:
    """The body of ``GET /api/metrics`` (the Metrics page tiles and the custom-dashboard
    KPI widgets; the route itself lives in the base router).

    * The headline COUNTS — ``total_cases``, ``open_cases``, ``needs_human_cases``,
      ``closed_cases``, ``by_status``, ``by_verdict``, ``by_disposition`` — are exact
      store-wide aggregates (``metrics_shared.fetch_case_breakdown``: COUNT/GROUP BY
      push-downs where the backend has them, else a fold that keeps only counters), so
      they agree with chat's ``case_stats`` at any store size. ``counts_exact`` is True
      when every one of them was counted exactly; a part that could not be counted falls
      back to the tally over the analysed cases and ``counts_exact`` goes False, with the
      reason in ``counts_note``.
    * Every OTHER figure (average risk, the active risk index, MTTR, cases per day, the
      burndown, timing trend, persona/playbook usage, feedback, retrieval history) is
      computed over the shared all-time case population: every case when the store holds
      no more than ``_STORE_FETCH_LIMIT``, else its newest cases. ``truncated`` /
      ``store_total`` / ``fetched`` say which (``store_total`` = the exact case count,
      ``fetched`` = cases analysed), so a lower bound is never presented as complete.

    An unreadable store is a 503, never a page of zeros."""
    population = await _population(state, None)
    if not population.load_ok:
        raise HTTPException(status_code=503, detail="The case store could not be read")
    breakdown = await fetch_case_breakdown(state.cases)
    counts = breakdown.counts()
    if "total" not in counts and population.store_total is not None:
        counts["total"] = int(population.store_total)  # the population's own exact COUNT
    out = await _rollup(
        compute_metrics, population.cases, total_cases=population.scope_total, counts=counts,
    )
    out.update(truncation_marker(population.fetched, population.scope_total))
    out["counts_exact"] = breakdown.exact
    out["counts_note"] = "; ".join(breakdown.errors)
    try:
        out["cost"] = await state.usage_store.summary(window_hours=max(1, int(window_hours)))
    except Exception:  # noqa: BLE001 — cost is best-effort on the metrics view
        out["cost"] = {}
    return out


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
    # EVERY ledger row in the reporting span (Round 12: no newest-5,000 cap), read with
    # the span pushed into the scan (the bundled stores range-filter ``ts`` under one
    # snapshot), so the cost follows the span, never the ledger's whole history. Only
    # the three fields the cost evidence reads are kept, and the read is shared for a
    # few seconds like the case population.
    usage_available = True
    span_start = end - timedelta(days=max(1, current_days) + max(1, baseline_days))
    try:
        usage_records, usage_truncated = await fetch_ledger_span(
            state.usage_store, span_start=span_start, end=end
        )
    except Exception as exc:  # noqa: BLE001 — evidence degrades, route stays available
        logger.warning("agent-improvement usage read soft-failed: %s", exc)
        usage_available = False
        usage_truncated = False
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
        # Exact unless the ledger scan stopped early or the repository could only
        # return one unverified page.
        "usage_records_truncated": usage_truncated,
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
    every case the window (and, for ``compare=prev``, the preceding window) reaches
    (Round 12). ``truncated`` is True when that span holds more cases than
    ``_STORE_FETCH_LIMIT`` or the read failed partway; ``store_total`` is then the exact
    number of in-scope cases and ``fetched`` the newest analysed, and
    ``window_covered`` says whether the SELECTED window is still complete.

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
    * ``window_covered`` is the honest-coverage flag: whether the SELECTED window is
      fully answerable from the cases that were read (cutoff at or after
      ``oldest_fetched_at``). With the exact population it is True unless a single
      window outgrew the in-memory bound. ``open_now`` is an exact store COUNT (window
      exempt) and carries its own ``complete`` flag.
    * A case-store OUTAGE soft-fails to an empty fetch so the dashboard never 500s.
      Both completeness flags then go False with a reason naming the failure: the
      counts are still zeros, but zero-because-unreadable is not a measurement and must
      never be published as one. ``truncated`` is unchanged (it compares fetched with
      store-reported total, and both are 0)."""
    wh = _window(window_hours)
    mode = (compare or "").strip().lower()
    # Every case the windows can reach: the current window, plus the preceding one
    # for ``compare=prev``; all time when unbounded.
    span = (wh * 2 if mode == "prev" else wh) if wh > 0 else None
    population = await _population(state, span)
    sla_policy = getattr(state.prefs, "sla", None)
    return await _rollup(
        posture_metrics,
        population.cases,
        sla_policy=sla_policy,
        window_hours=wh,
        compare=mode,
        store_total=population.scope_total,
        prefs=state.prefs,
        load_ok=population.load_ok,
        open_now_count=population.open_now,
        open_now_unavailable=(
            None if population.open_now is not None or span is None else
            "the store could not count its open cases, so only open cases created in "
            "the selected window were counted; this is a lower bound"
        ),
        # A read that failed partway is never certified as covering the window.
        read_error=(population.read_error or None) if not population.complete else None,
        newest_first=population.newest_first,
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

    Served from the SAME shared short-TTL exact population as the other posture
    rollups (every case the window reaches; one store scan per TTL window). The
    ``truncated``/``store_total``/``fetched`` marker is True only when the window alone
    outgrew ``_STORE_FETCH_LIMIT``. DETERMINISTIC + advisory: nothing here is read by
    ``case_manager.decide()`` (#3)."""
    wh = max(1, min(720, _window(window_hours) or 1))
    # +24h: the aligned FIRST bucket can start up to one bucket (max 24h) before the
    # window edge.
    population = await _population(state, wh + 24)
    alert_counters: dict[str, Any] | None = None
    try:
        # +24h of hourly slack so the aligned FIRST bucket (which can start up to one
        # full bucket — max 24h — before the window edge) is fully covered.
        alert_counters = await state.noise_counters.read_hourly_ingested(wh + 24)
    except Exception as exc:  # noqa: BLE001 — a counter glitch degrades to null alerts
        logger.warning("trends counter read soft-failed: %s", exc)
        alert_counters = None
    return await _rollup(
        trend_metrics,
        population.cases,
        window_hours=wh,
        store_total=population.scope_total,
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

    READ-ONLY derivation over already-persisted cases — the ALL-TIME population (a case
    created long ago can be decided today), exact up to ``_STORE_FETCH_LIMIT`` cases and
    honestly ``truncated`` beyond. The auto-close policy is read for DISPLAY only —
    nothing here is ever an input to ``decide()`` (#3)."""
    # Decision-time windows plus a "lifetime" tally: a case created long ago can be
    # decided today, so this rollup reads the ALL-TIME population.
    population = await _population(state, None)
    return await _rollup(
        auto_close_health,
        population.cases,
        window_hours=int(window_hours),
        policy=getattr(getattr(state, "prefs", None), "auto_close", None),
        store_total=population.scope_total,
    )


# How many ``case_manager`` DECISION audit rows the recorded rollup reads. Bounded for
# the same reason the case fetch is: a busy deployment's append-only audit is unbounded,
# and one dashboard query must not scan it. Rows only add the GATE EXPLANATION, never
# the rate itself, so a bound that clips the oldest rows degrades ``gate_coverage``
# (visibly, per bucket) instead of moving a number. That guarantee is enforced on the
# other side of the seam: the rollup pairs an audit row with the anchored decision by
# INSTANT, so a case whose anchoring row fell off this page reads back as
# ``unrecorded`` rather than borrowing a later run's gate outcome.
_DECISION_AUDIT_FETCH_LIMIT = 5000


def _decision_audit_span_hours(window_hours: int) -> int:
    """How far back the DECISION audit page is read: the reported window plus its
    baseline, plus an hour of slack so a decision anchored at the baseline edge still
    has its own row available. Published in the response beside ``gate_coverage``."""
    return max(1, int(window_hours)) * 2 + 1


async def _load_decision_audit(state: AppState, *, window_hours: int) -> list[dict[str, Any]]:
    """The append-only ``case_manager`` DECISION rows for the reporting span.

    Read back TWICE the reported window (current + preceding baseline) plus slack, so
    a decision anchored in the baseline window still has its own audit row available.

    Filtered on ``action_type`` + ``ts_from`` ONLY, both of which the bundled stores push
    into the query. ``actor`` deliberately is NOT passed: it lives inside the JSON
    document, so the SQL repository satisfies it by over-scanning twenty pages' worth of
    rows per requested row — a five-figure scan for one dashboard tile. The rows this
    widens the read by (the router, chat and analyst-policy DECISION rows) are dropped
    for free by ``parse_decision_audit_row``, which already returns None for any actor
    but ``case_manager``.

    Fail-soft: an audit read error yields no rows, which downgrades the gate breakdown
    to ``unrecorded`` rather than failing a dashboard query. An audit repository that
    does not implement filtered listing returns [] by contract — same outcome."""
    since = datetime.now(timezone.utc) - timedelta(
        hours=_decision_audit_span_hours(window_hours)
    )
    try:
        rows = await state.audit.records(
            action_type=ActionType.DECISION.value,
            ts_from=since.isoformat(),
            limit=_DECISION_AUDIT_FETCH_LIMIT,
        )
    except Exception as exc:  # noqa: BLE001 — observability degrades, never 500s
        logger.warning("decision-audit read soft-failed: %s", exc)
        return []
    return list(rows or [])


def _provider_health_snapshot(state: AppState) -> dict[str, Any] | None:
    """The in-process provider-health snapshot, or None when it cannot be read.

    None means "the tracker could not be read". It is NOT the only way this deployment
    reports "no evidence": ``AppState`` always constructs the tracker and
    ``snapshot()`` always answers, so a deployment that has never made a model call
    returns a well-formed snapshot whose ``providers`` map is EMPTY. The rollup keys
    its ``outage.evidence_available`` off that map — the actual observations — rather
    than off this object, so an empty tracker can never read as proof of health."""
    tracker = getattr(state, "_provider_health", None)
    if tracker is None:
        return None
    try:
        return tracker.snapshot()
    except Exception as exc:  # noqa: BLE001
        logger.warning("provider-health snapshot soft-failed: %s", exc)
        return None


async def _rag_health_record(state: AppState) -> dict[str, Any] | None:
    """The durable RAG corpus-health record, or None when it cannot be read."""
    store = getattr(state, "_rag_health", None)
    if store is None:
        return None
    try:
        doc = await store.load()
    except Exception as exc:  # noqa: BLE001
        logger.warning("rag-health read soft-failed: %s", exc)
        return None
    return dict(doc or {}) or None


@router.get("/metrics/auto-close-health/recorded")
async def metrics_auto_close_health_recorded(
    window_hours: int = Query(default=24, ge=1, le=8760),
    anchor: str = Query(
        default="first",
        pattern="^(first|last)$",
        description=(
            "Which decision in a case's append-only trail anchors it to a window. "
            "`first` (default) is stable under reinvestigation; `last` reproduces the "
            "legacy endpoint's rolling clock."
        ),
    ),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """The auto-close rate measured from the APPEND-ONLY decision trail.

    A SEPARATE series from ``GET /api/metrics/auto-close-health``, which is unchanged
    and still served. The two are expected to differ, and the response carries a
    ``legacy_series.note`` saying why, because silently redefining a shipped metric
    moves every historical number an operator has been tracking.

    What this one does differently:

    * anchors each case on its FIRST recorded ``{"event": "decision"}`` entry, so a
      reopen plus a re-investigation never moves, duplicates or re-labels the count;
    * reads the ``status``/``decision_by`` RECORDED in that entry rather than today's
      mutable ``case.decision_by``/``case.status`` — merely acknowledging an agent
      auto-close can no longer migrate it into "a human closed this";
    * excludes decisions taken during a dependency outage, derived from the
      deployment's own provider-health records (never a calendar date, which would be
      correct in one deployment and wrong in every other) and ONLY for a failing
      COMPLETION channel — the one that gates verdict production. A degraded embedding
      channel and a stale knowledge corpus both fail soft, so verdicts (and
      ``decide()``) still ran; those are published under ``outage.context`` and never
      remove a decision from the denominator;
    * reports a bucketed ``gate_series``: how much of the trail can still EXPLAIN why
      auto-close did or did not fire, and for the explained ones, whether the verdict
      class was closable at all and what blocked the bar (confidence / risk /
      class-disabled). That series is an EVIDENCE-QUALITY signal and is explicitly
      NOT a threshold-tuning target — see its ``disclaimer``.

    Every input beyond the cases is optional and fails soft: a missing audit page
    downgrades the gate breakdown to ``unrecorded``, and a missing health record is
    reported as "no evidence", never as proof that there was no outage.

    READ-ONLY. The auto-close policy is read for DISPLAY-ONLY classification of
    decisions that have already been made — nothing here is ever an input to
    ``decide()`` (#3)."""
    population = await _population(state, None)
    decision_audit_rows = await _load_decision_audit(state, window_hours=int(window_hours))
    rag_health = await _rag_health_record(state)
    return await _rollup(
        recorded_auto_close_health,
        population.cases,
        window_hours=int(window_hours),
        policy=getattr(getattr(state, "prefs", None), "auto_close", None),
        store_total=population.scope_total,
        anchor=anchor,
        decision_audit_rows=decision_audit_rows,
        decision_audit_span_hours=_decision_audit_span_hours(int(window_hours)),
        provider_health=_provider_health_snapshot(state),
        rag_health=rag_health,
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
    # Feedback and turnaround EVENTS are windowed, and a case created long ago can carry
    # one inside the window, so this reads the ALL-TIME population.
    population = await _population(state, None)
    end_date = as_of or request_now.date()
    report_end = datetime.combine(end_date, time.min, tzinfo=timezone.utc)
    outcome_inputs = await _load_agent_outcome_inputs(
        state,
        current_days=current_days,
        baseline_days=baseline_days,
        end=report_end,
    )
    return await _rollup(
        agent_improvement_metrics,
        population.cases,
        as_of=as_of,
        current_days=current_days,
        baseline_days=baseline_days,
        now=request_now,
        store_total=population.scope_total,
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
    auto_cleared > true_positive residual) come from a tally over every case in the window
    (``cases_meta.truncated`` is True when the window holds more cases than
    ``_STORE_FETCH_LIMIT`` or the read failed partway — the outcome tallies are then a
    lower bound and ``store_total``/``fetched`` say by how much). When the counters are still warming
    up (``counters.available: false``) the ingested/clustered totals are ``null`` and the
    headline ``reduction.overall_pct`` is a DASH, so the UI degrades to a case-only funnel.

    DETERMINISTIC + advisory: nothing here is read by ``case_manager.decide()`` (#3); every
    band name is plain framework data the UI renders escaped."""
    wh = _window(window_hours)
    population = await _population(state, wh or None)
    try:
        counters = await state.noise_counters.read_window(wh)
    except Exception as exc:  # noqa: BLE001 — a counter glitch degrades to case-only funnel
        logger.warning("noise-reduction counter read soft-failed: %s", exc)
        counters = {"available": False}
    return await _rollup(
        build_noise_reduction,
        population.cases,
        counters,
        window_hours=wh,
        store_total=population.scope_total,
        fetched_count=population.fetched,
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
    wh = _window(window_hours)
    population = await _population(state, wh or None)
    cases = population.cases
    store_total = population.scope_total
    window_cases = _window_filter(cases, window_hours=wh)
    prefs = state.execution_prefs
    rows = [build_case_lineage(case, prefs) for case in window_cases[:limit]]
    store_truncated = not population.complete
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
    the bundled corpus, over every case in the window (``window_hours=0``, the default,
    is all time; a positive value bounds to created-within). ``truncated`` is True when
    that population outgrew ``_STORE_FETCH_LIMIT`` (or the read failed partway) — the
    covered tally is then a lower bound over the newest cases, beside the exact
    ``store_total``. Invalid/forged technique ids are dropped (#9).
    """
    wh = _window(window_hours)
    population = await _population(state, wh or None)
    cases = population.cases
    if wh > 0:
        cases = _window_filter(cases, window_hours=wh)
    out = compute_mitre_coverage(
        cases, store_total=population.scope_total, fetched_count=population.fetched
    )
    out["window_hours"] = wh
    return out


@router.get("/mitre/coverage/navigator.layer.json")
async def mitre_coverage_navigator(
    window_hours: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> dict[str, Any]:
    """Return an ATT&CK **Navigator v4.5** layer dict for the case coverage. Pure
    JSON the UI hands straight to the Navigator; invalid ids never appear (#9)."""
    wh = _window(window_hours)
    population = await _population(state, wh or None)
    cases = population.cases
    if wh > 0:
        cases = _window_filter(cases, window_hours=wh)
    return navigator_layer(
        cases, window_hours=wh or None, store_total=population.scope_total,
        fetched_count=population.fetched,
    )
