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
* ``GET /api/metrics/breakdown`` (Round 14, SPEC §4.4.2): exact case (or usage) counts by
  one or two fields over a window, from the SAME ``engine.case_aggregate`` engine as the
  chat's ``case_stats`` tool, so the dashboards and chat agree on every number.
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
import dataclasses
import logging
import math
import re
from datetime import date, datetime, time, timedelta, timezone
from time import monotonic as _monotonic
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request

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
from ..models import (
    BREAKDOWN_CASE_FIELDS,
    BREAKDOWN_DEFAULT_TOP,
    BREAKDOWN_DEFAULT_WINDOW,
    BREAKDOWN_FILTER_RULE_MAX_CHARS,
    BREAKDOWN_MAX_TOP,
    BREAKDOWN_USAGE_FIELDS,
    MetricsBreakdown,
    MetricsBreakdownBucket,
    MetricsBreakdownGroup,
    MetricsBreakdownOther,
)
from ..state import AppState
from ..utils import iso_now, now_utc, parse_es_timestamp
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


# --------------------------------------------------------------------------- #
# GET /api/metrics/breakdown (Round 14, SPEC §4.4.2)
# --------------------------------------------------------------------------- #
#: The case metrics every ``kind=cases`` group carries: the counts, the window-exempt
#: open stock, and the two named families (AI verdict; analyst outcome). Exactly the
#: ``CaseAggregateSpec`` metrics the spec fixes, so a row means what the chat's
#: ``case_stats`` says for the same window and grouping.
BREAKDOWN_SPEC_METRICS: tuple[str, ...] = (
    "count", "open_now", "verdicted", "verdict_tp", "verdict_fp", "verdict_needs_human",
    "analyst_tp", "analyst_fp", "analyst_ungraded",
)
_BREAKDOWN_USAGE_SPEC_METRICS: tuple[str, ...] = ("calls", "cost_usd")
_BREAKDOWN_KINDS: tuple[str, ...] = ("cases", "usage")
#: The bucket units the endpoint offers, finest first.
_BREAKDOWN_BUCKETS: tuple[str, ...] = ("hour", "day", "week")
#: ``status_group`` (the wire words) → the engine's status-group filter value.
_BREAKDOWN_STATUS_GROUPS: dict[str, str] = {"open": "active", "closed": "terminal"}
#: The longest ``window`` text the endpoint parses (every documented form is far shorter).
_BREAKDOWN_WINDOW_MAX_CHARS = 200
_PARTIAL_CASES = "The case store stopped answering partway, so these figures are lower bounds."
_PARTIAL_UNREADABLE = (
    "Some stored cases could not be read in full, so the figures that need them are lower bounds."
)
_PARTIAL_USAGE = "The usage ledger stopped answering partway, so these figures are lower bounds."
_PARTIAL_USAGE_UNVERIFIED = (
    "The usage ledger could not be read in one consistent pass, so these figures may be incomplete."
)
_UNAVAILABLE = "The store could not be read, so this breakdown is not available right now."
_TIMED_OUT = (
    "This breakdown took too long to read, so it is not available right now. "
    "Try a shorter window."
)

# Resource bounds. Every breakdown needs the analyst outcome family, which reads the
# full case model, so neither store push-down (COUNT and the open stock only) answers it
# and each read is a fold over every case in the window: about 50 microseconds a case.
# A board asks for several keys and refreshes them every minute for every viewer, so:
#
# * one answer per question is shared for ``BREAKDOWN_CACHE_TTL_SECONDS``, and a
#   question already being read is joined rather than read again (single flight). The
#   response carries nothing caller-specific (the grant and the row-scope refusal are
#   checked before the cache), so sharing it across callers is safe. The key holds the
#   store's identity and the Demo run, so a Demo switch never serves the other store's
#   answer, and the operator time zone, which places calendar windows and buckets;
# * at most ``BREAKDOWN_MAX_CONCURRENT_READS`` distinct reads run at once on an event
#   loop (the rest queue), so dashboards cannot crowd out the rest of the API;
# * a read, queueing included, gets ``BREAKDOWN_READ_TIMEOUT_SECONDS``; past it the
#   caller gets ``503 breakdown_unavailable`` (nothing measured, never a zero);
# * one answer holds at most ``BREAKDOWN_MAX_ROWS`` group rows. A bucketed answer
#   zero-fills every kept group across every bucket, so ``top`` times the bucket count
#   is checked before the read and a larger request is refused with advice (``400
#   breakdown_bad_param``); an answer that still came out larger is returned but never
#   kept. The widest built-in board query (severity by day over 90 days at the default
#   ``top``) is 910 rows;
# * the shared answers hold at most ``BREAKDOWN_CACHE_MAX_ROWS`` group rows in all,
#   not only ``BREAKDOWN_CACHE_MAX_ENTRIES`` answers: one large answer is several
#   megabytes, so a caller who varies the window text cannot fill the process with
#   them. The oldest answers go first; a refreshed answer counts as the newest. Four
#   answers of the largest size fit, and every built-in board question is far smaller;
# * the shared answers hold a reference to the store they were read from, so every
#   request first drops the expired ones and any read from a store this process no
#   longer serves (the Demo stack after Demo Mode ends, the real stores while it runs).
#
# The fold reads only the stored fields its metrics and groups need
# (``case_aggregate._raw_projection``) and validates them into the case model in a
# worker thread (``case_aggregate.fold_cases``), so the event loop keeps serving other
# requests between pages.
BREAKDOWN_CACHE_TTL_SECONDS = 5.0
BREAKDOWN_CACHE_MAX_ENTRIES = 64
BREAKDOWN_CACHE_MAX_ROWS = 20_000
BREAKDOWN_MAX_CONCURRENT_READS = 2
BREAKDOWN_READ_TIMEOUT_SECONDS = 60.0
BREAKDOWN_MAX_ROWS = 5_000


class _BreakdownEntry:
    """One shared answer. Holds a STRONG reference to the store it was read from, so the
    identity check can never match a recycled object id."""

    __slots__ = ("store", "value", "expires_at", "rows")

    def __init__(self, store: Any, value: MetricsBreakdown, expires_at: float) -> None:
        self.store = store
        self.value = value
        self.expires_at = expires_at
        # What the answer weighs against BREAKDOWN_CACHE_MAX_ROWS (an answer with no
        # group rows still holds its totals, so it weighs one).
        self.rows = max(1, len(value.groups))


_breakdown_cache: dict[tuple[Any, ...], _BreakdownEntry] = {}
_breakdown_inflight: dict[tuple[Any, ...], tuple[Any, "asyncio.Task[tuple[MetricsBreakdown, bool]]"]] = {}
# One semaphore per event loop (an asyncio primitive is bound to the loop that first
# uses it; tests run many loops).
_breakdown_slots: dict[Any, asyncio.Semaphore] = {}


def invalidate_breakdown_cache() -> None:
    """Drop every shared answer, in-flight marker and read slot (test isolation)."""
    _breakdown_cache.clear()
    _breakdown_inflight.clear()
    _breakdown_slots.clear()


def _read_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _breakdown_slots.get(loop)
    if slots is None:
        for stale in [known for known in _breakdown_slots if known.is_closed()]:
            _breakdown_slots.pop(stale, None)
        slots = asyncio.Semaphore(BREAKDOWN_MAX_CONCURRENT_READS)
        _breakdown_slots[loop] = slots
    return slots


def _prune_breakdown_cache(now: float) -> None:
    """Drop the expired answers, then the oldest ones (insertion order) until at most
    :data:`BREAKDOWN_CACHE_MAX_ENTRIES` answers holding at most
    :data:`BREAKDOWN_CACHE_MAX_ROWS` group rows in all remain."""
    for key in [k for k, entry in _breakdown_cache.items() if entry.expires_at <= now]:
        _breakdown_cache.pop(key, None)
    rows = sum(entry.rows for entry in _breakdown_cache.values())
    while _breakdown_cache and (
        len(_breakdown_cache) > BREAKDOWN_CACHE_MAX_ENTRIES or rows > BREAKDOWN_CACHE_MAX_ROWS
    ):
        oldest = _breakdown_cache.pop(next(iter(_breakdown_cache)))
        rows -= oldest.rows


def _forget_other_stores(live: tuple[Any, ...]) -> None:
    """Drop every shared answer read from a store that is not one of ``live`` (the case
    store and the usage ledger this process serves right now). Such an answer can never
    be served again (the key names the store and the Demo run), and keeping it would
    keep that store alive: after Demo Mode ends, the whole in-memory Demo stack."""
    for key in [k for k, entry in _breakdown_cache.items()
                if not any(entry.store is store for store in live)]:
        _breakdown_cache.pop(key, None)


async def _bounded_read(
    compute: Callable[[], Awaitable[tuple[MetricsBreakdown, bool]]],
) -> tuple[MetricsBreakdown, bool]:
    async def run() -> tuple[MetricsBreakdown, bool]:
        async with _read_slots():
            return await compute()

    return await asyncio.wait_for(run(), timeout=BREAKDOWN_READ_TIMEOUT_SECONDS)


async def _shared_breakdown(
    key: tuple[Any, ...],
    store: Any,
    compute: Callable[[], Awaitable[tuple[MetricsBreakdown, bool]]],
) -> MetricsBreakdown:
    """The answer to ``key`` read from ``store``: a fresh shared answer, the read already
    in flight for it, or a new bounded read. ``compute`` returns ``(answer,
    cacheable)``; only an answer read to the end is shared after it completes (a read a
    store failure cut short, and any error, are never kept).

    The read runs as its own task: a caller that goes away does not cancel it, so the
    callers that joined it, and the next refresh, still get its answer."""
    now = _monotonic()
    # Every request releases the expired answers (and the stores they hold), not only
    # the next one that completes a read.
    _prune_breakdown_cache(now)
    hit = _breakdown_cache.get(key)
    if hit is not None and hit.store is store and hit.expires_at > now:
        return hit.value
    loop = asyncio.get_running_loop()
    pending = _breakdown_inflight.get(key)
    if (
        pending is not None
        and pending[0] is store
        and not pending[1].done()
        and pending[1].get_loop() is loop
    ):
        task = pending[1]
    else:
        task = loop.create_task(_bounded_read(compute), name="metrics-breakdown")
        _breakdown_inflight[key] = (store, task)

        def settle(done: "asyncio.Task[tuple[MetricsBreakdown, bool]]") -> None:
            current = _breakdown_inflight.get(key)
            if current is not None and current[1] is done:
                del _breakdown_inflight[key]
            if done.cancelled() or done.exception() is not None:
                return  # reading the exception marks it retrieved; a failure is never kept
            value, cacheable = done.result()
            if cacheable:
                stamp = _monotonic()
                # Re-inserted, not overwritten in place, so a refreshed answer is the
                # newest and the size bound evicts the answers nobody asked for since.
                _breakdown_cache.pop(key, None)
                _breakdown_cache[key] = _BreakdownEntry(
                    store, value, stamp + float(BREAKDOWN_CACHE_TTL_SECONDS),
                )
                _prune_breakdown_cache(stamp)

        task.add_done_callback(settle)
    value, _cacheable = await asyncio.shield(task)
    return value


def _breakdown_error(code: str, message: str, status: int = 400) -> HTTPException:
    """A coded, plain-text refusal (``{code, message}``; the Console's error parser
    shows ``message``). Messages name what to use instead and never echo a stored value."""
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _bad_param(message: str) -> HTTPException:
    return _breakdown_error("breakdown_bad_param", message)


def _unavailable(message: str = _UNAVAILABLE) -> HTTPException:
    return _breakdown_error("breakdown_unavailable", message, status=503)


def _too_many_buckets(exc: Any) -> str:
    """The advice for a :class:`~app.engine.case_aggregate.BucketBudgetError`, in the
    endpoint's own units (the engine may name month, quarter or year, which this
    endpoint does not offer)."""
    from ..engine.case_aggregate import MAX_RESULT_BUCKETS

    unit = str(getattr(exc, "unit", "") or "")
    coarser = _BREAKDOWN_BUCKETS[_BREAKDOWN_BUCKETS.index(unit) + 1:] if unit in _BREAKDOWN_BUCKETS else ()
    suggestion = str(getattr(exc, "suggestion", "") or "")
    if suggestion in coarser:
        advice = f"use bucket={suggestion} or a shorter window"
    elif coarser:
        advice = f"use bucket={coarser[-1]} or a shorter window"
    else:
        advice = "use a shorter window"
    count = getattr(exc, "count", None)
    head = f"{count} {unit} buckets" if isinstance(count, int) and unit else "That many buckets"
    return f"{head} is too many for this window (at most {MAX_RESULT_BUCKETS}); {advice}"


def _operator_tz(prefs: Any) -> str:
    """The operator timezone exactly as the chat's case lookups resolve it
    (``chat_tools.common.operator_tz``: ``SlaPolicy.timezone`` when it is a valid IANA
    name, else UTC), so a calendar window or bucket starts on the same instant in both."""
    from types import SimpleNamespace

    from ..agents.chat_tools.common import operator_tz

    return operator_tz(SimpleNamespace(prefs=prefs))


def _resolve_breakdown_window(window: str, *, tz: str) -> Any:
    """``window`` (the Round 12 grammar) resolved in the operator zone and counted the
    way every case lookup in chat counts it: a relative window of whole days, weeks,
    months or years spans whole periods of its unit, the last in progress
    (``time_windows.align_whole_periods``, Round 12 SPEC §7.2 decision 28), so "last 7
    days" here and in ``case_stats`` start on the same instant and hold the same cases.
    The response's ``window_label`` and ``window_from`` say what was measured; a rolling
    hours window is labelled by :func:`_rolling_hours_label`."""
    from ..engine.time_windows import align_whole_periods, resolve_window

    text = (window or "").strip() or BREAKDOWN_DEFAULT_WINDOW
    if len(text) > _BREAKDOWN_WINDOW_MAX_CHARS:
        raise _bad_param(f"window is too long (at most {_BREAKDOWN_WINDOW_MAX_CHARS} characters)")
    try:
        resolved = resolve_window(text, tz=tz, now=now_utc(), default=BREAKDOWN_DEFAULT_WINDOW)
    except ValueError:
        raise _bad_param(
            "window is not a time window this endpoint understands; use all, a relative "
            "window such as now-24h or now-7d, a calendar period such as this_month, or a "
            "range such as 2026-10-01..2026-10-26"
        ) from None
    return _rolling_hours_label(align_whole_periods(resolved))


_ROLLING_HOURS = re.compile(r"now-([0-9]+)h")


def _rolling_hours_label(window: Any) -> Any:
    """A rolling hours window (``now-Nh``) labelled the way a board names it, with the
    instant it starts: ``now-168h`` is "last 7 days (since 21 Oct 2026, 12:00)" rather
    than the engine's "last 168 hours". A board sends its 7, 30 and 90 day windows as
    hours tokens so its breakdowns count the rolling span its posture figures count
    (SPEC §4.4.3), and a caption begins with this label, so it must read like the board
    window next to it. A whole number of days is named in days (24 hours keeps "last 24
    hours", the picker's own name), any other count in hours with a thousands
    separator; the start is in the operator zone, named when it is not UTC. Only the
    label changes: the span, and so every number, is exactly as resolved."""
    from ..engine.time_windows import period_label, zone_for

    match = _ROLLING_HOURS.fullmatch(str(getattr(window, "token", "") or ""))
    if match is None or getattr(window, "kind", "") != "relative" or window.start is None:
        return window
    hours = int(match.group(1))
    if hours > 24 and hours % 24 == 0:
        name = f"last {hours // 24:,} days"
    else:
        name = f"last {hours:,} hour{'' if hours == 1 else 's'}"
    zone, zone_name = zone_for(window.tz)
    local = window.start.astimezone(zone)
    since = f"{period_label(window.start, 'day', zone)}, {local.hour:02d}:{local.minute:02d}"
    if zone_name != "UTC":
        since = f"{since}, {zone_name}"
    return dataclasses.replace(window, label=f"{name} (since {since})")


class _RowBudgetError(ValueError):
    """A bucketed request whose zero-filled answer could hold more than
    :data:`BREAKDOWN_MAX_ROWS` group rows (``top`` groups times the buckets). The
    message names a request that fits; it echoes only the caller's own parameters."""


def _too_many_rows(*, top_n: int, buckets: int, unit: str, fits_unit: str) -> str:
    rows = top_n * buckets
    advice: list[str] = []
    if fits_unit:
        advice.append(f"bucket={fits_unit}")
    advice.append("a shorter window")
    smaller_top = BREAKDOWN_MAX_ROWS // max(1, buckets)
    if 1 <= smaller_top < top_n:
        advice.append(f"a top of {smaller_top} or fewer")
    joined = ", ".join(advice[:-1]) + f" or {advice[-1]}" if len(advice) > 1 else advice[0]
    return (
        f"This breakdown could return {rows} rows ({top_n} groups in each of {buckets} "
        f"{unit} buckets), more than the {BREAKDOWN_MAX_ROWS} one answer holds; use {joined}"
    )


async def _check_bucket_budget(
    kind: str, store: Any, window: Any, unit: str, *, top_n: int, filters: dict[str, Any],
    prefs: Any,
) -> None:
    """Refuse, before the read, a bucket unit that would zero-fill more calendar buckets
    than one answer holds, or more group rows (``top_n`` times the buckets) than
    :data:`BREAKDOWN_MAX_ROWS`, with advice in the endpoint's own units. A bounded window
    is measured directly; all time first asks for the dated span of the selection (one
    COUNT the bundled stores push down, else a count-only fold), so an over-fine request
    is refused without folding every case first."""
    from ..engine.case_aggregate import (
        MAX_RESULT_BUCKETS,
        BucketBudgetError,
        CaseAggregateSpec,
        UsageAggregateSpec,
        aggregate_cases,
        aggregate_usage,
    )
    from ..engine.time_windows import align_window, bucket_count

    earliest = latest = None
    if window.start is None:
        if kind == "usage":
            probe = await aggregate_usage(store, UsageAggregateSpec(
                window=window, metrics=("calls",),
            ))
        else:
            probe = await aggregate_cases(store, CaseAggregateSpec(
                window=window, filters=filters, metrics=("count",), prefs=prefs,
            ))
        earliest = parse_es_timestamp(probe.earliest) if probe.earliest else None
        latest = parse_es_timestamp(probe.latest) if probe.latest else None
        if earliest is None:
            return  # nothing dated: no calendar axis to fill

    def count(candidate: str) -> int:
        return int(bucket_count(align_window(window, candidate), candidate,
                                earliest=earliest, latest=latest))

    # All time may add the "no date" bucket for undatable cases: count it, so the row
    # bound holds whatever the read finds.
    undated_bucket = 1 if window.start is None else 0
    wanted = count(unit)
    coarser = _BREAKDOWN_BUCKETS[_BREAKDOWN_BUCKETS.index(unit) + 1:]
    if wanted > MAX_RESULT_BUCKETS:
        fits = next((candidate for candidate in coarser if count(candidate) <= MAX_RESULT_BUCKETS), "")
        raise BucketBudgetError(
            f"{wanted} {unit} buckets is too many for this window", count=wanted, unit=unit,
            suggestion=fits,
        )
    if top_n * (wanted + undated_bucket) <= BREAKDOWN_MAX_ROWS:
        return
    fits_rows = next(
        (candidate for candidate in coarser
         if top_n * (count(candidate) + undated_bucket) <= BREAKDOWN_MAX_ROWS),
        "",
    )
    raise _RowBudgetError(_too_many_rows(
        top_n=top_n, buckets=wanted + undated_bucket, unit=unit, fits_unit=fits_rows,
    ))


def _caller_role(request: Request) -> str:
    """The signed-in caller's base role ("" when auth is off)."""
    from .deps import current_user

    try:
        user = current_user(request)
    except Exception:  # noqa: BLE001 -- the no-auth profile
        user = None
    role = getattr(user, "role", "") if user is not None else ""
    return str(getattr(role, "value", role) or "")


def _object_scoped(state: AppState, request: Request) -> bool:
    """Row-level (object) data scope applies to this caller's case reads: the SAME
    rule the chat starters and ``GET /api/auth/me`` use (``chat_starters.object_scoped``,
    fail closed). Aggregates do not respect row scope yet (SPEC D16), so a scoped
    caller gets no case-derived breakdown at all rather than counts over cases it may
    not read."""
    from ..engine.chat_starters import object_scoped

    return bool(object_scoped(state, _caller_role(request)))


def _key_text(value: Any) -> str | None:
    """A group value as the plain string the wire carries (``None`` = the empty group).
    Rule ids, source ids and technique names are untrusted: returned as data only (#9)."""
    if value is None:
        return None
    raw = getattr(value, "value", value)
    return str(raw)


def _other_per_bucket(result: Any, metric: str) -> dict[str, int]:
    """``{bucket label: records past top}``: the engine's per-bucket ``Other`` rows, so a
    stacked chart can reach each bucket's total although only ``top`` groups are listed."""
    out: dict[str, int] = {}
    for row in getattr(result, "groups", None) or []:
        label = row.get("bucket")
        if row.get("other") and label is not None:
            value = (row.get("metrics") or {}).get(metric) or 0
            out[str(label)] = out.get(str(label), 0) + int(value)
    return out


def _breakdown_buckets(result: Any, *, metric: str = "count") -> list[MetricsBreakdownBucket]:
    """The zero-filled calendar axis, in order, plus the "no date" bucket when an
    all-time breakdown placed undatable records in it (never dropped, #4).

    When ``top`` cut groups, each bucket also carries ``other_count``, the records of
    that bucket in the groups past ``top`` (``count``, or ``calls`` for usage), so a
    bucket's listed groups plus ``other_count`` are its total."""
    from ..engine.case_aggregate import MISSING_BUCKET, MISSING_USAGE_BUCKET

    trimmed = bool(getattr(result, "other", None))
    other = _other_per_bucket(result, metric) if trimmed else {}

    def bucket(label: str, in_progress: bool) -> MetricsBreakdownBucket:
        extra: dict[str, Any] = {"other_count": other.get(label, 0)} if trimmed else {}
        return MetricsBreakdownBucket(label=label, in_progress=in_progress, **extra)

    buckets = [
        bucket(str(label), bool(in_progress))
        for label, in_progress in (getattr(result, "buckets", None) or [])
    ]
    labels = {b.label for b in buckets}
    for row in getattr(result, "groups", None) or []:
        label = row.get("bucket")
        if label in (MISSING_BUCKET, MISSING_USAGE_BUCKET) and label not in labels:
            buckets.append(bucket(str(label), False))
            labels.add(label)
    return buckets


def _undated(result: Any) -> dict[str, Any]:
    """The records with no readable creation time (cases) or timestamp (usage), never
    silently dropped (Round 12): ``missing_created`` is how many matched, and
    ``missing_in_total`` says whether they are inside ``total`` (all time: yes, in the
    "no date" bucket) or outside it (a bounded window cannot place them). The chat's
    ``case_stats`` states the same figure, so the two never disagree in silence."""
    return {
        "missing_created": int(getattr(result, "missing_created", 0) or 0),
        "missing_in_total": bool(getattr(result, "missing_in_total", True)),
    }


def _int_or_none(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _window_caption(label: Any) -> str:
    """The engine's window label as a caption start in sentence case ("Last 7 days
    (since 20 Oct 2026)"): a widget caption begins with it (SPEC §4.4.3). Only the first
    character changes; chat keeps the engine's own lowercase form inside its sentences,
    and the window itself (``window_from``, ``window_to``) is the same in both. A rolling
    hours window already carries the board's name for it (:func:`_rolling_hours_label`),
    where chat says "last 168 hours"; the span is the same."""
    text = str(label or "")
    return text[:1].upper() + text[1:]


def _case_breakdown(
    result: Any, *, by: str, then: str | None, bucket: str | None, status_group: str | None,
) -> MetricsBreakdown:
    """An ``AggregateResult`` of a case spec as the wire :class:`MetricsBreakdown`.

    The exact ``Other`` remainder past ``top`` is reported once in ``other`` (its rows are
    not repeated in ``groups``: a group value could itself read "Other"); with buckets,
    each bucket's share of it is that bucket's ``other_count``."""
    groups: list[MetricsBreakdownGroup] = []
    for row in result.groups:
        if row.get("other"):
            continue
        key = row.get("key") or {}
        metrics = row.get("metrics") or {}
        groups.append(MetricsBreakdownGroup(
            key=_key_text(key.get(by)),
            then_key=_key_text(key.get(then)) if then else None,
            bucket=row.get("bucket"),
            count=int(metrics.get("count") or 0),
            open_now=_int_or_none(metrics.get("open_now")),
            verdicted=_int_or_none(metrics.get("verdicted")),
            verdict_tp=_int_or_none(metrics.get("verdict_tp")),
            verdict_fp=_int_or_none(metrics.get("verdict_fp")),
            verdict_needs_human=_int_or_none(metrics.get("verdict_needs_human")),
            analyst_tp=_int_or_none(metrics.get("analyst_tp")),
            analyst_fp=_int_or_none(metrics.get("analyst_fp")),
            analyst_ungraded=_int_or_none(metrics.get("analyst_ungraded")),
        ))
    other = None
    if result.other:
        other = MetricsBreakdownOther(
            count=int((result.other.get("metrics") or {}).get("count") or 0),
            groups=int(result.other.get("groups") or 0),
        )
    exact = bool(result.exact)
    reason = None
    if result.partial:
        reason = _PARTIAL_CASES
    elif not exact:
        reason = _PARTIAL_UNREADABLE
    return MetricsBreakdown(
        kind="cases", by=by, then=then, bucket=bucket, status_group=status_group,
        window_label=_window_caption(result.window_label), window_from=result.window_from,
        window_to=result.window_to, total=int(result.total), exact=exact,
        partial=not exact, partial_reason=reason,
        multi_valued=bool(getattr(result, "multi_valued", ()) or ()),
        groups=groups, buckets=_breakdown_buckets(result, metric="count"), other=other,
        **_undated(result),
    )


def _usage_breakdown(result: Any, *, by: str, then: str | None, bucket: str | None) -> MetricsBreakdown:
    """An ``AggregateResult`` of a usage spec as the wire :class:`MetricsBreakdown`
    (``count`` is the number of ledger rows, one per model call, #6)."""
    groups: list[MetricsBreakdownGroup] = []
    for row in result.groups:
        if row.get("other"):
            continue
        key = row.get("key") or {}
        metrics = row.get("metrics") or {}
        calls = int(metrics.get("calls") or 0)
        groups.append(MetricsBreakdownGroup(
            key=_key_text(key.get(by)),
            then_key=_key_text(key.get(then)) if then else None,
            bucket=row.get("bucket"),
            count=calls, calls=calls, cost_usd=float(metrics.get("cost_usd") or 0.0),
        ))
    other = None
    if result.other:
        metrics = result.other.get("metrics") or {}
        calls = int(metrics.get("calls") or 0)
        other = MetricsBreakdownOther(
            count=calls, groups=int(result.other.get("groups") or 0), calls=calls,
            cost_usd=float(metrics.get("cost_usd") or 0.0),
        )
    exact = bool(result.exact)
    reason = None
    if result.partial:
        reason = _PARTIAL_USAGE
    elif not exact:
        reason = _PARTIAL_USAGE_UNVERIFIED
    return MetricsBreakdown(
        kind="usage", by=by, then=then, bucket=bucket, status_group=None,
        window_label=_window_caption(result.window_label), window_from=result.window_from,
        window_to=result.window_to, total=int(result.total), exact=exact,
        partial=not exact, partial_reason=reason, multi_valued=False,
        groups=groups, buckets=_breakdown_buckets(result, metric="calls"), other=other,
        **_undated(result),
    )


_TOP_TEXT = re.compile(r"[0-9]{1,3}")


def _parse_top(raw: Any) -> int:
    """``top`` as a whole number from 1 to :data:`BREAKDOWN_MAX_TOP`, written in ASCII
    digits (absent or blank is the default), else the coded ``400``."""
    if isinstance(raw, bool):
        raise _bad_param(f"top must be a whole number from 1 to {BREAKDOWN_MAX_TOP}")
    text = str(raw if raw is not None else "").strip()
    if not text:
        return BREAKDOWN_DEFAULT_TOP
    if _TOP_TEXT.fullmatch(text) and 1 <= int(text) <= BREAKDOWN_MAX_TOP:
        return int(text)
    raise _bad_param(f"top must be a whole number from 1 to {BREAKDOWN_MAX_TOP}")


def _enum_query(description: str, values: tuple[str, ...], default: Any = None) -> Any:
    """A query parameter typed as an enum in the OpenAPI contract but validated by the
    route itself, so a value outside it is the endpoint's coded ``400
    breakdown_bad_param`` rather than the framework's generic 422."""
    return Query(default=default, description=description, json_schema_extra={"enum": list(values)})


@router.get("/metrics/breakdown", response_model=MetricsBreakdown)
async def metrics_breakdown(
    request: Request,
    by: str = _enum_query(
        "The grouping. kind=cases: rule, source, severity, status, verdict, closed_by, "
        "assignee, mitre_tactic, mitre_technique. kind=usage: surface, role, model, "
        "provider, service_tier.",
        tuple(dict.fromkeys(BREAKDOWN_CASE_FIELDS + BREAKDOWN_USAGE_FIELDS)),
        default=...,
    ),
    kind: str = _enum_query("cases (gate metrics:view) or usage (gate cost:view).",
                            _BREAKDOWN_KINDS, default="cases"),
    then: str | None = _enum_query(
        "An optional second grouping from the same set, not equal to by (an exact cross-tab).",
        tuple(dict.fromkeys(BREAKDOWN_CASE_FIELDS + BREAKDOWN_USAGE_FIELDS)),
    ),
    window: str = Query(
        default=BREAKDOWN_DEFAULT_WINDOW,
        description=(
            "The Round 12 window grammar: all, now-24h, now-7d, now-30d, calendar tokens "
            "(this_month, last_week, ...), period literals or ranges (A..B), resolved in "
            "the operator timezone. A relative window of days, weeks, months or years "
            "spans whole periods, the last in progress, exactly as chat counts it."
        ),
    ),
    bucket: str | None = _enum_query("Optional zero-filled time buckets over the window.",
                                     _BREAKDOWN_BUCKETS),
    # Typed as an integer in the OpenAPI contract but taken as sent and validated by the
    # route (``_parse_top``), so a value that is not a whole number is the coded 400 like
    # every other bad parameter, never the framework's generic 422.
    top: Any = Query(
        default=BREAKDOWN_DEFAULT_TOP,
        description=f"Groups kept, 1 to {BREAKDOWN_MAX_TOP}; the rest is one exact other row.",
        json_schema_extra={"type": "integer", "minimum": 1, "maximum": BREAKDOWN_MAX_TOP},
    ),
    filter_rule: str | None = Query(
        default=None,
        description=(
            "kind=cases only: count only cases carrying this exact rule value, matched as "
            "stored (1 to "
            f"{BREAKDOWN_FILTER_RULE_MAX_CHARS} printable characters, case sensitive, "
            "spaces included)."
        ),
    ),
    status_group: str | None = _enum_query(
        "kind=cases only: open (the open stock; with window=all for open-now figures) or "
        "closed (closed or resolved cases).",
        tuple(_BREAKDOWN_STATUS_GROUPS),
    ),
    state: AppState = Depends(get_state),
) -> MetricsBreakdown:
    """Exact case or usage counts by one field (``by``) or two (``by`` then ``then``) over
    a window, optionally bucketed by time (SPEC §4.4.2).

    ``kind=cases`` hands one ``CaseAggregateSpec`` (window, group_by, bucket, top_n,
    filters; metrics ``count``, ``open_now`` and the two named families) to
    ``engine.case_aggregate.aggregate_cases``, the engine the chat's ``case_stats`` uses,
    over the case store this caller reads (the Demo store while Demo Mode is on), with
    the same prefs and operator timezone, so the dashboards and chat agree on every
    number. The two families are never mixed: AI verdicts (``verdicted = verdict_tp +
    verdict_fp + verdict_needs_human``) and the analyst outcome (``count = analyst_tp +
    analyst_fp + analyst_ungraded``; analyst-policy closes are never graded). In an
    un-bucketed row ``open_now`` is the window-exempt open stock: the open cases matching
    the row whenever they were created, so it can exceed the row's windowed ``count``; in
    a bucketed row it is the open part of that bucket's cohort. ``window_label`` is the
    window as a caption start in sentence case ("Last 7 days (since 20 Oct 2026)"); a
    relative window of days, weeks, months or years counts whole local periods exactly
    as chat does, and an hours window (``now-168h``) is the rolling span the other
    ``window_hours`` metrics count, labelled as a board names it ("Last 7 days (since 21
    Oct 2026, 12:00)"). ``multi_valued`` is true for ``rule``, ``mitre_tactic``
    and ``mitre_technique``: a case counts once in each of its values, so rows never sum
    to ``total``. ``exact`` false (``partial`` true, with ``partial_reason``) marks lower
    bounds; a zero is never invented for a figure that was not measured. Cases with no
    readable creation date are disclosed in ``missing_created`` (``missing_in_total``
    says whether ``total`` holds them), and with buckets cut by ``top`` each bucket's
    ``other_count`` holds its share of ``other``.

    ``kind=usage`` aggregates the usage ledger (``engine.case_aggregate.aggregate_usage``,
    metrics ``calls`` and ``cost_usd``, ranked by spend) and is gated on ``cost:view``.

    One answer per question is shared for a few seconds and a question being read is
    joined, never read twice; at most two reads run at once, a read gets a bounded time,
    an answer holds at most 5,000 group rows and the shared answers 20,000 in all. Every read
    folds the cases of the window, because the analyst outcome family needs the case
    model; the fold reads only the stored fields its metrics and groups need.

    Errors: ``400 breakdown_bad_param`` (an unknown value, ``then`` equal to ``by``, a
    case-only parameter with ``kind=usage``, an empty ``filter_rule``, a ``top`` that is
    not a whole number from 1 to 50, a window it cannot read, too many buckets, or
    ``top`` times the buckets over 5,000 rows); ``403`` without the grant; ``409
    breakdown_scope_unsupported`` for a case breakdown while row-level data scope applies
    to the caller (aggregates do not honour row scope yet, SPEC D16); ``503
    breakdown_unavailable`` when the store could not be read at all or the read ran past
    its time (nothing was measured, so no figure is returned). A read: no audit row, no
    model call (#6), aggregates only (#7); nothing here is read by
    ``case_manager.decide()`` (#3)."""
    from ..engine.case_aggregate import (
        AggregateRequestError,
        BucketBudgetError,
        CaseAggregateSpec,
        UsageAggregateSpec,
        aggregate_cases,
        aggregate_usage,
    )

    kind_value = (kind or "").strip() or "cases"
    # The grant first, so an unauthorised caller learns nothing from parameter checks.
    if kind_value == "usage":
        await require_permission("cost", "view")(request)
    else:
        await require_permission("metrics", "view")(request)
    if kind_value not in _BREAKDOWN_KINDS:
        raise _bad_param("kind must be cases or usage")
    allowed = BREAKDOWN_USAGE_FIELDS if kind_value == "usage" else BREAKDOWN_CASE_FIELDS
    by_value = (by or "").strip()
    if by_value not in allowed:
        raise _bad_param(f"by must be one of {', '.join(allowed)} for kind={kind_value}")
    then_value = (then or "").strip() or None
    if then_value is not None:
        if then_value not in allowed:
            raise _bad_param(f"then must be one of {', '.join(allowed)} for kind={kind_value}")
        if then_value == by_value:
            raise _bad_param("then must differ from by")
    bucket_value = (bucket or "").strip() or None
    if bucket_value is not None and bucket_value not in _BREAKDOWN_BUCKETS:
        raise _bad_param(f"bucket must be one of {', '.join(_BREAKDOWN_BUCKETS)}")
    top_n = _parse_top(top)
    group_value = (status_group or "").strip() or None
    # ``filter_rule`` is matched exactly as stored, never trimmed: a rule id of spaces is
    # a real (log-derived, #9) value and filters to the cases that carry it. Present but
    # empty is refused rather than read as "no filter".
    rule_value = filter_rule
    if kind_value == "usage":
        if group_value is not None or rule_value is not None:
            raise _bad_param("status_group and filter_rule apply to kind=cases only")
    else:
        if group_value is not None and group_value not in _BREAKDOWN_STATUS_GROUPS:
            raise _bad_param("status_group must be open or closed")
        if rule_value is not None and not (
            1 <= len(rule_value) <= BREAKDOWN_FILTER_RULE_MAX_CHARS and rule_value.isprintable()
        ):
            raise _bad_param(
                f"filter_rule must be 1 to {BREAKDOWN_FILTER_RULE_MAX_CHARS} printable characters"
            )
        if _object_scoped(state, request):
            raise _breakdown_error(
                "breakdown_scope_unsupported",
                "Case breakdowns are hidden while row-level data scope is on.",
                status=409,
            )

    prefs = state.execution_prefs
    tz = _operator_tz(prefs)
    window_text = (window or "").strip() or BREAKDOWN_DEFAULT_WINDOW
    resolved = _resolve_breakdown_window(window_text, tz=tz)
    group_by = (by_value, then_value) if then_value else (by_value,)
    filters: dict[str, Any] = {}
    if group_value is not None:
        filters["status_group"] = _BREAKDOWN_STATUS_GROUPS[group_value]
    if rule_value is not None:
        filters["rule_exact"] = rule_value
    store = state.usage_store if kind_value == "usage" else state.cases

    async def compute() -> tuple[MetricsBreakdown, bool]:
        if bucket_value is not None:
            await _check_bucket_budget(kind_value, store, resolved, bucket_value,
                                       top_n=top_n, filters=filters, prefs=prefs)
        if kind_value == "usage":
            usage_result = await aggregate_usage(store, UsageAggregateSpec(
                window=resolved, group_by=group_by, bucket=bucket_value,  # type: ignore[arg-type]
                metrics=_BREAKDOWN_USAGE_SPEC_METRICS, top_n=top_n,
            ))
            body = _usage_breakdown(usage_result, by=by_value, then=then_value, bucket=bucket_value)
            return body, not usage_result.partial and len(body.groups) <= BREAKDOWN_MAX_ROWS
        case_result = await aggregate_cases(store, CaseAggregateSpec(
            window=resolved, filters=filters, group_by=group_by,
            bucket=bucket_value,  # type: ignore[arg-type]
            metrics=BREAKDOWN_SPEC_METRICS, top_n=top_n, prefs=prefs,
        ))
        body = _case_breakdown(
            case_result, by=by_value, then=then_value, bucket=bucket_value,
            status_group=group_value,
        )
        # A read cut short is never shared, and neither is an answer over the row bound
        # (the pre-check makes that unreachable; this keeps the cache bounded anyway).
        return body, not case_result.partial and len(body.groups) <= BREAKDOWN_MAX_ROWS

    key = (
        kind_value, id(store), getattr(state, "demo_run_id", None), by_value, then_value,
        bucket_value, top_n, rule_value, group_value, window_text, tz,
    )
    _forget_other_stores((state.cases, state.usage_store))
    try:
        return await _shared_breakdown(key, store, compute)
    except HTTPException:
        raise
    except BucketBudgetError as exc:
        raise _bad_param(_too_many_buckets(exc)) from None
    except _RowBudgetError as exc:
        raise _bad_param(str(exc)) from None
    except AggregateRequestError as exc:
        # The engine refused the request itself; its message names what to ask for
        # instead and echoes only the caller's own value.
        raise _bad_param(str(exc)[:300]) from None
    except TimeoutError:
        logger.warning("metrics breakdown read ran past %ss (%s by %s)",
                       BREAKDOWN_READ_TIMEOUT_SECONDS, kind_value, by_value)
        raise _unavailable(_TIMED_OUT) from None
    except Exception as exc:  # noqa: BLE001 -- nothing could be read: say so, never a zero
        # A store failure, including a ``ValueError`` it raised while reading (a corrupt
        # document's JSON error, a model validation error): logged here, never echoed.
        logger.warning("metrics breakdown read failed (%s by %s): %s: %s",
                       kind_value, by_value, type(exc).__name__, exc)
        raise _unavailable() from None


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

    ``events_per_min`` (Round 14, SPEC §4.4.3, the detection board's "Events per minute")
    is the mean raw alerts per minute over the whole hours the counters summed
    (:func:`_events_per_min`), rounded to 0.01. When the counters began inside the
    window (``counters.incomplete``, a fresh install, a Demo) the hour they began in is
    left out, because it can hold a backfilled burst (a cold-start lookback, the Demo's
    history written at once): the rate then covers the hours after it. ``null`` while
    ``counters.available`` is false or less than five minutes are measured, never a
    made-up 0 and never a burst read as a rate. ``events_per_min_since`` is the ISO
    start of the span the rate covers (``null`` with no rate) and
    ``events_per_min_reason`` a plain sentence saying why the rate is not measured or,
    when the counters began inside the window, that it covers only the time since the
    end of the hour they began in (``null`` when the rate covers the whole window).

    DETERMINISTIC + advisory: nothing here is read by ``case_manager.decide()`` (#3); every
    band name is plain framework data the UI renders escaped."""
    wh = _window(window_hours)
    population = await _population(state, wh or None)
    # One instant for the counter read, the case window and the rate's covered span.
    now = now_utc()
    try:
        counters = await state.noise_counters.read_window(wh, now=now)
    except Exception as exc:  # noqa: BLE001 — a counter glitch degrades to case-only funnel
        logger.warning("noise-reduction counter read soft-failed: %s", exc)
        counters = {"available": False}
    payload = await _rollup(
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
        now=now,
    )
    rate = await _events_per_min(state, payload, counters, window_hours=wh, now=now)
    payload["events_per_min"] = rate.per_min
    payload["events_per_min_since"] = rate.since
    payload["events_per_min_reason"] = rate.reason
    return payload


def _ingested_total(payload: dict[str, Any]) -> int | None:
    """The funnel's ``ingested`` stage total (``None`` while the counters warm up)."""
    for stage in payload.get("stages") or []:
        if isinstance(stage, dict) and stage.get("key") == "ingested":
            total = stage.get("total")
            return total if isinstance(total, int) and not isinstance(total, bool) else None
    return None


#: The shortest span a mean rate is stated over. Below it a handful of events would read
#: as a rate of many per minute, so the rate is not measured.
_EVENTS_PER_MIN_MIN_SPAN_MINUTES = 5.0
# The reasons a reader shows beside the rate (plain sentences, no stored value in them).
_EPM_NOT_AVAILABLE = "The alert counters are not available yet, so the rate is not measured."
_EPM_NO_START = "The alert counters do not say when they started, so the rate is not measured."
_EPM_TOO_RECENT = (
    "The alert counters started recently: the hour they started in is left out, and fewer "
    "than five minutes have been measured since."
)
_EPM_TOO_SHORT = "Fewer than five minutes of this window have been measured, so the rate is not measured."
_EPM_HOURLY_FAILED = "The hourly alert counters could not be read, so the rate is not measured."
_EPM_PARTIAL_SPAN = (
    "The alert counters started inside this window, so the rate covers only the time "
    "since the end of the hour they started in."
)


class _EventsPerMin:
    """The detection board's "Events per minute": ``per_min`` (``None`` = not measured),
    ``since`` (ISO start of the span the rate covers, ``None`` when there is no rate) and
    ``reason`` (why it is not measured, or why it covers less than the window)."""

    __slots__ = ("per_min", "since", "reason")

    def __init__(self, per_min: float | None, since: str | None, reason: str | None) -> None:
        self.per_min = per_min
        self.since = since
        self.reason = reason


def _not_measured(reason: str) -> _EventsPerMin:
    return _EventsPerMin(None, None, reason)


async def _events_per_min(
    state: AppState, payload: dict[str, Any], counters: dict[str, Any], *,
    window_hours: int, now: datetime,
) -> _EventsPerMin:
    """Mean raw alerts per minute over the whole hours the durable counters measured.

    The counters are hourly: ``read_window`` sums every hour from the hour the window
    starts in up to the current, partly elapsed hour, and nothing before the counters'
    ``coverage_start`` (their first observation, bounded by retention) exists.

    * The counters reach back past the window's first hour: every summed hour was
      measured as it happened, so the rate is the ingested total over ``[start of the
      window's first hour, now]`` and ``since`` is that start, with no reason.
    * The counters began inside the window (a fresh install, a Demo, all time): the
      hour they began in can hold a burst recorded at once, the cold-start lookback of
      a first poll or the history a Demo writes when it is turned on, so that hour is
      left out and the rate is the hours after it over ``[the next hour boundary,
      now]``. ``since`` is that boundary and ``reason`` says the rate covers only part
      of the window, so a reader never sets it beside the whole-window "Alerts
      ingested" as if both measured the same span.

    Rounded to 0.01. Not measured (``per_min`` ``None`` with a reason) while the
    counters are unavailable or fewer than :data:`_EVENTS_PER_MIN_MIN_SPAN_MINUTES`
    minutes are measured, so a reader shows "Not measured" rather than 0 or a burst read
    as a rate."""
    if not bool((payload.get("counters") or {}).get("available")):
        return _not_measured(_EPM_NOT_AVAILABLE)
    total = _ingested_total(payload)
    if total is None:
        return _not_measured(_EPM_NOT_AVAILABLE)
    coverage = parse_es_timestamp(counters.get("coverage_start") or counters.get("since"))
    if coverage is None:
        return _not_measured(_EPM_NO_START)
    now_ts = now.timestamp()
    coverage_ts = coverage.timestamp()
    first_hour_ts = (
        math.floor((now_ts - window_hours * 3600.0) / 3600.0) * 3600.0 if window_hours > 0 else None
    )
    reason: str | None = None
    if first_hour_ts is not None and coverage_ts <= first_hour_ts:
        start_ts = first_hour_ts
        ingested = total
        too_short = _EPM_TOO_SHORT
    else:
        burst_hour = math.floor(coverage_ts / 3600.0)
        start_ts = (burst_hour + 1) * 3600.0
        too_short = _EPM_TOO_RECENT
        if (now_ts - start_ts) / 60.0 < _EVENTS_PER_MIN_MIN_SPAN_MINUTES:
            return _not_measured(too_short)  # no whole measured stretch yet: no second read
        try:
            hourly = await state.noise_counters.read_hourly_ingested(window_hours, now=now)
        except Exception as exc:  # noqa: BLE001 -- the rate degrades to "Not measured"
            logger.warning("noise-reduction hourly counter read soft-failed: %s", exc)
            return _not_measured(_EPM_HOURLY_FAILED)
        if not hourly.get("available"):
            return _not_measured(_EPM_HOURLY_FAILED)
        ingested = sum(
            int(count) for hour, count in (hourly.get("hours") or {}).items()
            if isinstance(hour, int) and hour > burst_hour and isinstance(count, int)
        )
        reason = _EPM_PARTIAL_SPAN
    minutes = (now_ts - start_ts) / 60.0
    if not math.isfinite(minutes) or minutes < _EVENTS_PER_MIN_MIN_SPAN_MINUTES:
        return _not_measured(too_short)
    since = datetime.fromtimestamp(start_ts, tz=timezone.utc).isoformat()
    return _EventsPerMin(round(ingested / minutes, 2), since, reason)


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
