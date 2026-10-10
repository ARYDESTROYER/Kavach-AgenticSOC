"""Metric tools: ``soc_metrics`` and ``cost_usage`` (chat revamp SPEC §5.3; Round 12
SPEC D7/D8).

``soc_metrics`` answers the dashboard questions over ANY window (Round 12, D7): all
time, ``now-90d``, ``now-6M``, calendar periods (``last_month``, ``this_quarter``,
``ytd``…) in the operator timezone, and ISO ranges, with no 30-day cap.

* ``posture``, ``trends``, ``case_mix`` and ``timing`` are EXACT over every case:
  they run :func:`app.engine.case_aggregate.aggregate_cases` (the same aggregator the
  dashboards read, so a chat answer and a tile agree), never the newest 5,000-case
  page. ``trends`` and ``timing`` take a calendar ``bucket`` (hour … year; ``auto``
  keeps a series at or under 200 points). The two stock figures that are not case
  counts — the Active Risk Index and SLA attainment — still come from the shared case
  page and say how much of the store it covered.
* ``noise_funnel`` counts its case stages over the SAME exact case population the
  Noise Reduction dashboard reads (``api.metrics_shared.fetch_case_population``: every
  case its window reaches, not the newest 5,000; ``basis: sample`` only when one window
  alone holds more than the population bound).
* ``mitre_coverage``, ``auto_close_health``, ``agent_improvement`` and ``feedback``
  reuse the dashboard engine functions over the shared case page and pass every
  honesty flag they publish (``truncated``, ``window_covered``, counters
  availability, insufficient evidence) through to the observation; a value they mark
  "—" stays ``null`` (G3).
* ``compare`` (``previous_period`` | ``same_period_last_year`` | a window | up to four
  windows; the legacy ``compare_previous`` is ``previous_period``) runs the SAME
  measurement for each period and adds a ``comparison`` artifact whose deltas are
  computed in code (a zero baseline is "new").

``cost_usage`` reads the usage ledger through
:func:`app.engine.case_aggregate.aggregate_usage` (exact sums over every ledger row,
any window, by role/model/surface and by calendar bucket), and, only for a caller who
also holds ``models:read`` (the meter rule of SPEC §8), the budget status. Demo Mode
costs are synthetic and labelled so.

Every number is labelled with the window it was COMPUTED over (G4); a case-store
outage is reported as "not measured", never as zero cases (G3). Metrics are engine
numbers and framework enums (#3-safe, advisory).
"""

from __future__ import annotations

import bisect
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator

from ...utils import iso_now
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .cases import load_case_page
from .common import (
    PREVIOUS_WINDOW_LABEL,
    ToolInput,
    Window,
    categories,
    finite,
    fmt_int,
    fmt_pct,
    kpi,
    millis_to_iso,
    none_if_blank,
    parse_input,
    ratio_to_pct,
    resolve_window,
    text,
    window_input,
    window_label,
)
from .periods import (
    Period,
    comparison_data,
    comparison_observation,
    comparison_row,
    normalise_compare,
    resolve_periods,
)
from ..blocks import compare_values
from .stats import (
    AGGREGATE_TOOL_TIMEOUT_S,
    bucket_axis,
    coarsened_note,
    comparison_basis,
    counted_share,
    display_bucket_labels,
    first_partial,
    group_label,
    invalid_aggregate_input,
    is_exact,
    metric_value,
    partial_bucket_note,
    plan_bucket,
    progress_reporter,
    result_rows,
    run_bucketed,
    run_case_aggregate,
    window_caption_label,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.metrics")

METRIC_KINDS: tuple[str, ...] = (
    "posture", "trends", "noise_funnel", "case_mix", "timing", "mitre_coverage",
    "auto_close_health", "agent_improvement", "feedback",
)
_KIND_ALIASES = {
    "noise": "noise_funnel", "noise_reduction": "noise_funnel", "funnel": "noise_funnel",
    "mix": "case_mix", "mttr": "timing", "mtta": "timing", "mttd": "timing", "lifecycle": "timing",
    "response_times": "timing", "trend": "trends", "over_time": "trends",
    "mitre": "mitre_coverage", "coverage": "mitre_coverage", "auto_close": "auto_close_health",
    "improvement": "agent_improvement", "performance": "posture", "kpis": "posture",
}
BUCKET_CHOICES = ("auto", "hour", "day", "week", "month", "quarter", "year")
_BUCKET_ALIASES = {
    "hourly": "hour", "1h": "hour", "daily": "day", "1d": "day", "weekly": "week", "1w": "week",
    "monthly": "month", "quarterly": "quarter", "1q": "quarter", "yearly": "year",
    "annual": "year", "1y": "year", "none": "auto", "": "auto",
}
_BUCKET_ENUM = {"hour": "1h", "day": "1d", "week": "1w", "month": "1M", "quarter": "1q", "year": "1y"}
_SEVERITIES = ("critical", "high", "medium", "low", "info")
# Kinds measured over every case by the exact aggregator (and the ones ``compare`` and
# ``bucket`` apply to). The others read the shared case page.
AGGREGATE_KINDS = frozenset({"posture", "trends", "case_mix", "timing"})
# Aggregate kinds drawn as a calendar series (their window is aligned to the unit).
_BUCKETED_KINDS = frozenset({"trends", "timing"})
# Kinds computed ONLY from the case store: an outage fails them rather than
# publishing figures over zero rows (G3). ``noise_funnel`` keeps its counter stages
# and nulls its case stages instead.
_CASE_ONLY_KINDS = frozenset({
    "posture", "trends", "case_mix", "timing", "mitre_coverage", "auto_close_health",
    "agent_improvement", "feedback",
})
CASE_STORE_DOWN = "The case store did not answer, so case figures were not measured"
COMPARE_KINDS_NOTE = "Invalid input: compare works with kind posture, trends, case_mix or timing"
# An end this close to now is "now" (a chip whose ``to`` was resolved a moment ago).
_TRAILING_TOLERANCE = timedelta(seconds=60)
_POSTURE_METRICS = ("count", "auto_closed", "human_closed", "fp_rate", "mttr_p50", "mttr_p90", "mtta_p50",
                    "mtta_p90", "mttd_p50", "mttd_p90", "open_now")
_BUCKET_MINUTES = {"hour": 60, "day": 1440}
_TIMING_METRICS = ("count", "mttd_p50", "mttd_p90", "mtta_p50", "mtta_p90", "mttr_p50", "mttr_p90")
_TREND_METRICS = ("count", "auto_closed", "human_closed", "fp_rate")
# The exact case population a noise funnel reads (the Noise Reduction dashboard's own
# bound, ``api.routes_metrics._STORE_FETCH_LIMIT``, so both share one cached scan).
_POPULATION_LIMIT = 20_000
# ``closed_by`` values that are a terminal decision the AGENT's automation rate counts:
# every close except an operator's analyst-policy close (``quality_metrics``' rule).
_RATE_CLOSERS = frozenset({"agent", "analyst", "system"})


# --------------------------------------------------------------------------- #
# The window a page-based metric is computed over.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class MetricWindow:
    """What the page-based engine functions are asked for, and its honest caption.

    ``hours`` is the whole-hour span counted back from ``end`` (the instant passed as
    the engine's ``now``; ``0`` = all time, the engine's unbounded window); ``now`` is
    the real measurement instant (open cases, SLA clocks). Round 12: no 30-day cap,
    so ``capped`` is always False (kept for readers)."""

    hours: int
    end: datetime
    now: datetime
    trailing: bool
    label: str
    requested: str
    capped: bool
    clamped: bool
    all_time: bool = False
    window: Window | None = None

    @property
    def start(self) -> datetime:
        return self.end - timedelta(hours=self.hours)

    @property
    def relabelled(self) -> bool:
        return self.label != self.requested

    def notes(self) -> list[str]:
        """Engine-template coverage notes for a window that differs from the ask."""
        notes: list[str] = []
        if self.relabelled:
            notes.append("the range was narrowed to whole hours")
        if self.clamped:
            notes.append("window limited to the selected range")
        return notes


def metric_window(window: Window, now: datetime) -> MetricWindow:
    """The window an engine function that counts ``window_hours`` back from an instant
    really covers: the span narrowed to whole hours (never widened beyond what was
    selected, §4.8.4, except a sub-hour range, which reads one hour), ending where the
    effective window ends; all time is ``hours=0``. The label is the effective
    window's own label only when the two coincide."""
    trailing = window.trailing or abs(now - window.end) <= _TRAILING_TOLERANCE
    if window.all_time:
        return MetricWindow(hours=0, end=window.end, now=now, trailing=trailing, label=window.label,
                            requested=window.label, capped=False, clamped=window.clamped, all_time=True,
                            window=window)
    span = (window.end - window.start).total_seconds() / 3600
    hours = max(1, math.floor(span + 1e-6))
    end = window.end
    start = end - timedelta(hours=hours)
    if abs((start - window.start).total_seconds()) < 1:
        label = window.label
    elif trailing:
        label = window_label(f"now-{hours}h", "now", start, end)
    else:
        label = window_label("", "", start, end)
    return MetricWindow(
        hours=hours, end=end, now=now, trailing=trailing, label=label,
        requested=window.label, capped=False, clamped=window.clamped, window=window,
    )


def _bounded(cases: list[Any], mw: MetricWindow) -> tuple[list[Any], int]:
    """``(cases created before the window end, how many later ones were dropped)``.

    The engine window filters only bound the START (``>= end - hours``), which is
    the whole story when the window ends now; a past range ``[start, end)`` must
    also drop the cases created at or after its end. A trailing window keeps the
    page untouched (dashboard parity). Cases without a parseable creation time stay:
    every window filter excludes them anyway."""
    if mw.trailing:
        return cases, 0
    from ...engine.metrics import _created_dt

    kept = [c for c in cases if (created := _created_dt(c)) is None or created < mw.end]
    return kept, len(cases) - len(kept)


def _page_note(cases: list[Any], store_total: int) -> str | None:
    if store_total > len(cases):
        return f"from the newest {fmt_int(len(cases))} of {fmt_int(store_total)} cases"
    return None


def normalise_bucket(value: Any) -> Any:
    """A bucket as a model may spell it ("monthly", "1M", "1w") → the calendar unit."""
    if value is None:
        return "auto"
    if isinstance(value, str):
        if value.strip() == "1M":
            return "month"
        key = value.strip().lower()
        return _BUCKET_ALIASES.get(key, key)
    return value


class SocMetricsInput(ToolInput):
    kind: Literal[METRIC_KINDS]  # type: ignore[valid-type]
    window: str | dict[str, Any] | None = None
    window_hours: int | None = Field(default=None, ge=1)
    bucket: Literal[BUCKET_CHOICES] = "auto"  # type: ignore[valid-type]
    compare: Any = None
    compare_previous: bool = False

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value: Any) -> Any:
        if isinstance(value, str):
            key = value.strip().lower().replace("-", "_").replace(" ", "_")
            return _KIND_ALIASES.get(key, key)
        return value

    @field_validator("window_hours", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("window", mode="before")
    @classmethod
    def _window(cls, value: Any) -> Any:
        return window_input(value)

    @field_validator("bucket", mode="before")
    @classmethod
    def _bucket(cls, value: Any) -> Any:
        return normalise_bucket(value)

    @field_validator("compare", mode="before")
    @classmethod
    def _compare(cls, value: Any) -> Any:
        return normalise_compare(value)

    def compare_spec(self) -> Any:
        return self.compare if self.compare is not None else ("previous_period" if self.compare_previous else None)


def _before(value: Any, end: datetime) -> bool:
    try:
        return datetime.fromisoformat(str(value)) < end
    except ValueError:
        return False


def _minutes(stat: Any, key: str = "p50") -> float | None:
    """A lifecycle percentile in minutes; ``None`` when not measured ("—")."""
    if not isinstance(stat, dict) or not stat.get("available"):
        return None
    return finite(stat.get(key))


def _lifecycle(totals: dict[str, Any]) -> dict[str, Any]:
    """``{"mttd_minutes": {p50, p90, measured, count}, …}`` (the dashboard's shape) from
    an aggregate's totals: minutes end to end, ``None`` when no case made the move."""
    out: dict[str, Any] = {}
    for name in ("mttd", "mtta", "mttr"):
        p50 = metric_value(f"{name}_p50", totals.get(f"{name}_p50"))
        out[f"{name}_minutes"] = {
            "p50": p50, "p90": metric_value(f"{name}_p90", totals.get(f"{name}_p90")),
            "measured": p50 is not None, "count": totals.get(f"{name}_samples"),
        }
    return out


def _ratio_of(numerator: Any, denominator: Any) -> float | None:
    """A 0..1 ratio (the dashboard's ``quality`` convention), ``None`` without a base."""
    num, den = finite(numerator), finite(denominator)
    if num is None or not den:
        return None
    return round(num / den, 4)


def _ratio(numerator: Any, denominator: Any) -> float | None:
    num, den = finite(numerator), finite(denominator)
    if num is None or not den:
        return None
    return round(num / den * 100, 2)


def _auto_bucket(window: Window) -> str:
    """The smallest calendar unit that keeps the series at or under 200 points (a
    month for all time, whose first case is not known before the count)."""
    if window.all_time:
        return "month"
    from ...engine.time_windows import auto_bucket

    try:
        return str(auto_bucket(window.as_resolved()))
    except Exception:  # noqa: BLE001 — a day is always a sensible default
        return "day"


def subject_index(periods: list[Period], window: Window) -> int:
    """Where the call's own window sits among the (chronological) periods."""
    for index, period in enumerate(periods):
        if period.window is window:
            return index
    return len(periods) - 1


def _kpi_delta(row: dict[str, Any] | None, periods: list[Period], subject: int | None = None) -> dict[str, Any] | None:
    """A tile's change: the tile shows the SUBJECT window's value, so its delta is the
    subject against the period immediately before it (none when the subject is the
    earliest period, e.g. an explicit compare window later than the window)."""
    if not row or len(periods) < 2:
        return None
    index = len(periods) - 1 if subject is None else subject
    values = row.get("values") if isinstance(row.get("values"), list) else []
    if index < 1 or index >= len(values):
        return None
    change = compare_values(values[index], values[index - 1])
    if finite(change.get("delta")) is None:
        return None
    return {"value": finite(change["delta"]), "period_label": f"vs {periods[index - 1].label}"[:60],
            "good_direction": row.get("good_direction") or "none"}


def _terminal_for_rates(result: Any) -> int:
    """Terminal cases the automation rate divides by: every close EXCEPT an operator's
    analyst-policy close (``engine.metrics.quality_metrics`` excludes those from every
    agent rate), from a ``closed_by`` grouping."""
    rows, _other = result_rows(result)
    return sum(int(finite((g.get("metrics") or {}).get("count")) or 0) for g in rows
               if str((g.get("key") or {}).get("closed_by") or "") in _RATE_CLOSERS)


def _policy_closed(result: Any) -> int:
    rows, _other = result_rows(result)
    return sum(int(finite((g.get("metrics") or {}).get("count")) or 0) for g in rows
               if str((g.get("key") or {}).get("closed_by") or "") == "analyst_policy")


def _series_base(
    window: Window, bucket: str, axis: Any, names: list[str], flags: list[bool],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """A series payload's x axis (calendar starts plus display labels that name a
    bucket the window cuts, or category labels) and the cut-edge info."""
    if axis is not None:
        shown, info = display_bucket_labels(window, bucket, axis[1])
        return ({"x": axis[0], "x_labels": shown, "bucket": _BUCKET_ENUM[bucket], "tz": window.tz,
                 "unit": "count", "last_in_progress": bool(axis[2] and axis[2][-1])}, info)
    shown, info = display_bucket_labels(window, bucket, names, flags)
    return {"x": shown, "x_kind": "category", "unit": "count"}, info


def _bucket_notes(observation: dict[str, Any], info: dict[str, Any], coarsened: dict[str, Any] | None) -> None:
    """The observation's notes on a bucketed series: a cut first/last bucket, and a
    unit coarsened to keep the series at or under 200 points."""
    buckets = observation.get("buckets")
    if isinstance(buckets, list) and buckets:
        if info.get("first") and isinstance(buckets[0], dict):
            buckets[0]["partial"] = info["first"]
        if info.get("last") and isinstance(buckets[-1], dict):
            buckets[-1]["partial"] = info["last"]
    note = partial_bucket_note(info)
    if note:
        observation["partial_buckets"] = note
    note = coarsened_note(coarsened)
    if note:
        observation["bucket_note"] = note


def _partial_share(observation: dict[str, Any], coverage: str | None, *results: Any,
                   noun: str = "cases", store: str = "case store") -> str | None:
    """The counted share of the first PARTIAL aggregate (SPEC D8: "counted 1,000 of
    2,500 cases before the case store stopped answering") in the observation
    (``partial``, ``counted``) and prepended to ``coverage``; ``coverage`` unchanged
    when every aggregate was exact."""
    partial = first_partial(*results)
    if partial is None:
        return coverage
    counted, sentence, observed = counted_share(partial, noun=noun, store=store)
    observation["partial"] = observed
    if counted is not None:
        observation["counted"] = counted
    return "; ".join(x for x in (sentence, coverage) if x) or None


class SocMetricsTool(ChatTool):
    name: ClassVar[str] = "soc_metrics"
    label: ClassVar[str] = "Read SOC metrics"
    scope: ClassVar[str] = "metrics"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("metrics", "view"),)
    data_source: ClassVar[str] = "Dashboard metrics (deterministic)"
    input_model: ClassVar[type] = SocMetricsInput
    timeout_s: ClassVar[float] = AGGREGATE_TOOL_TIMEOUT_S
    signature: ClassVar[str] = (
        "soc_metrics(kind=posture|trends|noise_funnel|case_mix|timing|mitre_coverage|auto_close_health|"
        "agent_improvement|feedback, window? (default last 24 hours), bucket?=auto|hour|day|week|month|quarter|"
        "year (trends, timing), compare? (posture, trends, case_mix, timing)) -- SOC analytics; posture, "
        "trends, case_mix and timing are exact over every case"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("kind", "window", "window_hours", "bucket", "compare",
                                               "compare_previous")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        for key in ("window", "compare"):
            if isinstance(params.get(key), (dict, list)):
                params[key] = str(params[key])[:80]
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(SocMetricsInput, inp)
        if error is not None:
            return error
        ref = datetime.now(timezone.utc)
        window = resolve_window(ctx, window=args.window, window_hours=args.window_hours, default_hours=24, now=ref,
                                minutes_ok=False)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        compare = args.compare_spec()
        if compare is not None and args.kind not in AGGREGATE_KINDS:
            return ToolOutcome.failure(COMPARE_KINDS_NOTE)
        plan: tuple[str, dict[str, Any] | None] | None = None
        if args.kind in _BUCKETED_KINDS:
            # The headline totals, the series, its labels and the compared periods all
            # cover ONE window, aligned to whole periods of the series' unit.
            requested = args.bucket if args.bucket != "auto" else _auto_bucket(window)
            window, unit, planned = plan_bucket(window, requested, explicit=args.bucket != "auto")
            plan = (unit, planned)
        periods = resolve_periods(ctx, window, compare, now=ref, minutes_ok=False)
        if isinstance(periods, str):
            return ToolOutcome.failure(periods)
        mw = metric_window(window, ref)
        if ctx.cases is None and args.kind in _CASE_ONLY_KINDS:
            outcome = ToolOutcome.failure(CASE_STORE_DOWN)
            outcome.observation = {"kind": args.kind, "case_store_unavailable": True}
            return outcome
        handler = getattr(self, f"_{args.kind}")
        try:
            if args.kind in _BUCKETED_KINDS:
                outcome: ToolOutcome = await handler(ctx, args, window, mw, periods, plan=plan)
            elif args.kind in AGGREGATE_KINDS:
                outcome = await handler(ctx, args, window, mw, periods)
            elif args.kind == "noise_funnel":
                outcome = await self._noise_funnel(ctx, args, mw)
            else:
                cases, store_total, load_ok = await load_case_page(ctx)
                if not load_ok and args.kind in _CASE_ONLY_KINDS:
                    raise _StoreDown()
                outcome = await handler(ctx, args, mw, cases, store_total, load_ok)
        except _StoreDown:
            outcome = ToolOutcome.failure(CASE_STORE_DOWN)
            outcome.observation = {"kind": args.kind, "case_store_unavailable": True}
            return outcome
        except ValueError as exc:
            if args.kind not in AGGREGATE_KINDS:
                raise
            # The aggregator refused the REQUEST (engine text naming what to use
            # instead): an input error, never a store outage.
            return invalid_aggregate_input(exc)
        except Exception as exc:  # noqa: BLE001 — an aggregate store failure is "not measured"
            if args.kind not in AGGREGATE_KINDS:
                raise
            logger.warning("soc_metrics %s aggregate failed: %s", args.kind, exc)
            outcome = ToolOutcome.failure(CASE_STORE_DOWN)
            outcome.observation = {"kind": args.kind, "case_store_unavailable": True}
            return outcome
        if outcome.ok:
            label = outcome.observation.get("window") or mw.label
            outcome.observation = {"kind": args.kind, "window": label, **outcome.observation}
            notes: list[str] = []
            if outcome.observation.pop("_window_applies", True):
                # The request's time chip narrowed the window the model asked for: a
                # structured flag, so nobody has to compare labels.
                outcome.observation["window_clamped_to_request"] = window.clamped
                outcome.observation.setdefault("timezone", window.tz)
                if args.kind not in AGGREGATE_KINDS and mw.relabelled:
                    outcome.observation["requested_window"] = mw.requested
                    notes.extend(mw.notes())
                elif window.clamped:
                    notes.append("window limited to the selected range")
            if outcome.observation.get("case_store_unavailable"):
                notes.append("case store did not answer; case-based figures are not measured")
            if outcome.coverage:
                notes.insert(0, outcome.coverage)
            outcome.coverage = "; ".join(dict.fromkeys(notes)) or None
            for artifact in outcome.artifacts:
                artifact.window = artifact.window or label
        return outcome

    # -- the shared case page (Active Risk Index, SLA) ----------------------- #
    async def _page_extras(self, ctx: ChatToolContext, window: Window, mw: MetricWindow) -> dict[str, Any]:
        """The two stock figures that are not case counts, from the shared case page:
        the Active Risk Index (active cases now) and SLA attainment of the window's
        cohort, with how much of the store the page covered."""
        from ...engine.metrics import _window_filter, compute_metrics, quality_metrics, sla_metrics

        cases, store_total, load_ok = await load_case_page(ctx)
        if not load_ok:
            return {"available": False}
        overall = compute_metrics(cases, total_cases=store_total)
        bounded, _dropped = _bounded(cases, mw)
        cohort = _window_filter(bounded, window_hours=mw.hours, now=mw.end)
        # ``prefs`` so SLA scores the derived priority, exactly like the posture route.
        sla = sla_metrics(cohort, getattr(ctx.prefs, "sla", None), now=mw.now, prefs=ctx.prefs)
        return {
            "available": True,
            "active_risk_index": finite(overall.get("active_risk_index")),
            "active_cases": overall.get("active_risk_case_count"),
            "escalation_rate": finite(quality_metrics(cohort).get("escalation_rate")),
            "sla": {k: sla.get(k) for k in ("enabled", "evaluated", "response_breached", "resolve_breached",
                                            "attainment_pct")},
            "page_note": _page_note(cases, store_total),
        }

    # -- posture ----------------------------------------------------------- #
    async def _posture(self, ctx, args, window: Window, mw: MetricWindow, periods: list[Period]) -> ToolOutcome:
        main = await run_case_aggregate(ctx, window, group_by=("closed_by",), metrics=_POSTURE_METRICS)
        severity = await run_case_aggregate(ctx, window, group_by=("severity",))
        compared = await self._compared(ctx, window, periods, main, group_by=("closed_by",),
                                        metrics=_POSTURE_METRICS)
        extras = await self._page_extras(ctx, window, mw)
        totals = dict(main.totals or {})
        # The automation rate's base excludes analyst-policy closes, exactly like the
        # dashboard's ``quality_metrics`` (no model ran on those cases).
        terminal = _terminal_for_rates(main)
        policy_closed = _policy_closed(main)
        exact = is_exact(main) and is_exact(severity)
        me = subject_index(periods, window)
        label = window_caption_label(main, window)
        fp = metric_value("fp_rate", totals.get("fp_rate"))
        automation = _ratio(totals.get("auto_closed"), terminal)
        mttr = metric_value("mttr_p50", totals.get("mttr_p50"))
        comparison_rows = self._posture_rows(compared) if len(periods) > 1 else []
        by_key = {r["key"]: r for r in comparison_rows}
        sev_rows, _ = result_rows(severity)
        sev = {str((g.get("key") or {}).get("severity") or "info"): int(finite((g.get("metrics") or {}).get("count")) or 0)
               for g in sev_rows}
        risk_index = extras.get("active_risk_index")
        items = [
            kpi("active_risk_index", "Active Risk Index", risk_index, "score", display="gauge",
                context=(f"{fmt_int(extras.get('active_cases'))} active cases now"
                         if extras.get("available") else "not measured")),
            kpi("cases", "Cases", main.total, delta=_kpi_delta(by_key.get("count"), periods, me), bound=not exact),
            kpi("open_now", "Open now", totals.get("open_now"), context="not windowed", bound=not exact),
            kpi("fp_rate", "False-positive rate", fp, "percent", delta=_kpi_delta(by_key.get("fp_rate"), periods, me)),
            kpi("automation_rate", "Automation rate", automation, "percent",
                delta=_kpi_delta(by_key.get("automation_rate"), periods, me)),
            # Lifecycle percentiles are minutes end to end; a 0-minute median is 0 min.
            kpi("mttr_p50", "MTTR (median)", mttr, "minutes", delta=_kpi_delta(by_key.get("mttr_p50"), periods, me)),
        ]
        caption = f"{fmt_int(main.total)} cases · {'exact' if exact else 'partial'} · {label}"
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Security posture", title_trusted=True,
                     data={"items": items}, provenance="code", basis="exact" if exact else "sample",
                     total=main.total, window=caption),
            Artifact(id="a2", kind="categories", title="Cases by severity", title_trusted=True,
                     data=categories([(group_label("severity", b), sev.get(b, 0)) for b in _SEVERITIES],
                                     dimension="severity"),
                     provenance="code", total=main.total, window=caption),
        ]
        observation: dict[str, Any] = {
            "window": label,
            "case_count": main.total,
            "exact": exact,
            "severity_counts": {b: sev.get(b, 0) for b in _SEVERITIES},
            "open_now": {"count": totals.get("open_now"), "window_exempt": True, "exact": exact},
            # Rates are 0..1 ratios, as on the dashboard (the tiles show them in percent).
            "quality": {
                "false_positive_rate": finite(totals.get("fp_rate")), "verdicted_cases": totals.get("verdicted"),
                "auto_closed_cases": totals.get("auto_closed"), "human_closed_cases": totals.get("human_closed"),
                "terminal_cases": terminal, "automation_rate": _ratio_of(totals.get("auto_closed"), terminal),
                "policy_closed_cases": policy_closed,
                "escalation_rate": extras.get("escalation_rate"),
                "note": "terminal_cases and every rate exclude analyst-policy closes (no model ran on them)",
            },
            "lifecycle_minutes": _lifecycle(totals),
            "active_risk_index": risk_index,
            "active_risk_index_scope": "active cases now (not windowed)",
            "sla": extras.get("sla"),
        }
        if extras.get("page_note"):
            observation["risk_index_and_sla_coverage"] = extras["page_note"]
        coverage = None
        if extras.get("page_note"):
            coverage = f"Active Risk Index and SLA {extras['page_note']}"
        coverage = _partial_share(observation, coverage, main, severity)
        self._add_comparison(artifacts, observation, periods, comparison_rows, None, compared)
        if len(periods) > 1 and me != len(periods) - 1:
            observation["subject_window_is_not_latest"] = (
                "the window asked about is not the latest period; the comparison's change is the latest "
                "period against the one before it, and each tile's change is the window against the period "
                "before it"
            )
        summary = (
            f"Posture ({label}): {fmt_int(main.total)} cases, {fmt_int(totals.get('open_now'))} open now, "
            f"FP rate {fmt_pct(fp)}, Active Risk Index {fmt_int(risk_index)}"
        )
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if exact else "sample", coverage=coverage)

    async def _compared(
        self, ctx: ChatToolContext, window: Window, periods: list[Period], subject: Any, *,
        group_by: tuple[str, ...] = (), metrics: tuple[str, ...] = ("count",),
    ) -> list[Any]:
        """The same aggregate for every compared period (the subject's own result
        reused), in the periods' chronological order."""
        if len(periods) < 2:
            return []
        out = []
        for period in periods:
            if period.window is window:
                out.append(subject)
            else:
                out.append(await run_case_aggregate(ctx, period.window, group_by=group_by, metrics=metrics))
        return out

    @staticmethod
    def _posture_rows(compared: list[Any]) -> list[dict[str, Any]]:
        totals = [dict(r.totals or {}) for r in compared]
        terminal = [_terminal_for_rates(r) for r in compared]
        return [
            comparison_row("count", "Cases", [r.total for r in compared], unit="count"),
            comparison_row("fp_rate", "False-positive rate", [metric_value("fp_rate", t.get("fp_rate")) for t in totals],
                           unit="percent", good="down", samples=[t.get("verdicted") for t in totals]),
            comparison_row("automation_rate", "Automation rate",
                           [_ratio(t.get("auto_closed"), n) for t, n in zip(totals, terminal)],
                           unit="percent", good="up", samples=terminal),
            comparison_row("mttr_p50", "MTTR (median)", [metric_value("mttr_p50", t.get("mttr_p50")) for t in totals],
                           unit="minutes", good="down", samples=[t.get("mttr_samples") for t in totals]),
            comparison_row("mtta_p50", "MTTA (median)", [metric_value("mtta_p50", t.get("mtta_p50")) for t in totals],
                           unit="minutes", good="down", samples=[t.get("mtta_samples") for t in totals]),
        ]

    @staticmethod
    def _add_comparison(
        artifacts: list[Artifact], observation: dict[str, Any], periods: list[Period],
        rows: list[dict[str, Any]], dimension: str | None, compared: list[Any] | None = None,
    ) -> None:
        """The ``comparison`` artifact, ``exact`` only when EVERY compared aggregate
        was counted completely (a partial period says so, never a confident delta)."""
        if len(periods) < 2 or not rows:
            return
        basis, partial = comparison_basis(list(compared or []))
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="comparison", title="Comparison", title_trusted=True,
            data=comparison_data(periods, rows, dimension=dimension, unit="count" if dimension else None),
            provenance="code", basis=basis, window=" vs ".join(p.label for p in reversed(periods)),
        ))
        observation["comparison"] = comparison_observation(periods, rows)
        if partial:
            observation["comparison"]["partial"] = partial

    # -- trends ------------------------------------------------------------ #
    async def _trends(
        self, ctx, args, window: Window, mw: MetricWindow, periods: list[Period],
        plan: tuple[str, dict[str, Any] | None] | None = None,
    ) -> ToolOutcome:
        bucket, planned = plan if plan else (args.bucket if args.bucket != "auto" else _auto_bucket(window), None)

        async def run(unit: str) -> Any:
            return await run_case_aggregate(ctx, window, bucket=unit, metrics=_TREND_METRICS)

        async def probe() -> Any:
            return await run_case_aggregate(ctx, window)

        agg, bucket, coarsened = await run_bucketed(window, bucket, run, probe, explicit=args.bucket != "auto")
        coarsened = coarsened or planned
        compared = await self._compared(ctx, window, periods, None, metrics=_TREND_METRICS) if len(periods) > 1 else []
        if compared:
            # The subject's own totals come from its bucketed run (identical totals).
            compared = [agg if c is None else c for c in compared]
        exact = is_exact(agg)
        label = window_caption_label(agg, window)
        axis = bucket_axis(agg, window, bucket)
        rows, _ = result_rows(agg)
        buckets = [b for b in agg.buckets or [] if len(b) == 2]
        names = [str(b[0]) for b in buckets]
        index = {name: i for i, name in enumerate(names)}

        def series(metric: str) -> list[Any]:
            values: list[Any] = [None if metric == "fp_rate" else 0] * len(names)
            for g in rows:
                slot = index.get(str(g.get("bucket")))
                if slot is not None:
                    values[slot] = metric_value(metric, (g.get("metrics") or {}).get(metric))
            return values

        new_cases, auto_closed, human_closed, fp = (series(m) for m in ("count", "auto_closed", "human_closed", "fp_rate"))
        base, partial_info = _series_base(window, bucket, axis, names, [bool(b[1]) for b in buckets])
        caption = f"{fmt_int(agg.total)} cases · {'exact' if exact else 'partial'} · {label}"
        artifacts = [Artifact(
            id="a1", kind="series", title=f"Cases opened per {bucket} and how they were closed", title_trusted=True,
            data={**base, "series": [
                {"key": "new_cases", "label": "Opened", "values": new_cases},
                {"key": "auto_closed", "label": "Auto-closed", "values": auto_closed},
                {"key": "human_closed", "label": "Closed by an analyst", "values": human_closed},
            ]},
            provenance="code", basis="exact" if exact else "sample", total=agg.total, window=caption,
        )]
        alerts = await self._alerts(ctx, window, mw, axis)
        if alerts is not None and any(v for v in alerts):
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="series", title="Alerts ingested over time", title_trusted=True,
                data={**base, "series": [{"key": "alerts", "label": "Alerts", "values": alerts}]},
                provenance="code", window=label,
            ))
        if any(v is not None for v in fp):
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="series", title=f"False-positive rate per {bucket}",
                title_trusted=True,
                data={**base, "unit": "percent", "series": [{"key": "fp_rate", "label": "FP rate", "values": fp}]},
                provenance="code", window=caption,
            ))
        observation: dict[str, Any] = {
            "window": label,
            "bucket": bucket,
            "bucket_minutes": _BUCKET_MINUTES.get(bucket),
            "buckets": [{"label": text(b[0], 40), "in_progress": bool(b[1])} for b in buckets],
            "new_cases": new_cases,
            "closed": [(a or 0) + (h or 0) for a, h in zip(auto_closed, human_closed)],
            "opened": new_cases,
            "auto_closed_of_opened": auto_closed,
            "closed_by_analyst_of_opened": human_closed,
            "fp_rate_percent": fp,
            "alerts": alerts,
            "total_cases": agg.total,
            "exact": exact,
            "note": "auto-closed and analyst-closed count the cases opened in each period",
        }
        _bucket_notes(observation, partial_info, coarsened)
        if agg.missing_created:
            observation["missing_created"] = agg.missing_created
            observation["missing_created_in_total"] = bool(getattr(agg, "missing_in_total", True))
        if len(periods) > 1:
            totals = [dict(r.totals or {}) for r in compared]
            rows_cmp = [
                comparison_row("count", "Cases opened", [r.total for r in compared], unit="count"),
                comparison_row("auto_closed", "Auto-closed", [t.get("auto_closed") for t in totals], unit="count",
                               good="up"),
                comparison_row("fp_rate", "False-positive rate", [metric_value("fp_rate", t.get("fp_rate")) for t in totals],
                               unit="percent", good="down", samples=[t.get("verdicted") for t in totals]),
            ]
            self._add_comparison(artifacts, observation, periods, rows_cmp, None, compared)
        summary = (f"Trends ({label}, {fmt_int(len(names))} {bucket}s): {fmt_int(agg.total)} cases opened, "
                   f"{fmt_int(sum(v or 0 for v in auto_closed))} auto-closed")
        if coarsened_note(coarsened):
            summary += f" ({coarsened_note(coarsened)})"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if exact else "sample", coverage=_partial_share(observation, None, agg))

    async def _alerts(self, ctx: ChatToolContext, window: Window, mw: MetricWindow, axis: Any) -> list[int] | None:
        """Ingested alerts per bucket from the hourly noise counters, or ``None``."""
        if ctx.noise is None or axis is None or not hasattr(ctx.noise, "read_hourly_ingested"):
            return None
        try:
            counters = await ctx.noise.read_hourly_ingested(mw.hours, now=mw.end)
        except Exception as exc:  # noqa: BLE001 — degrade to no alert series
            logger.info("trend counters unavailable: %s", exc)
            return None
        hours = (counters or {}).get("hours") if isinstance(counters, dict) else None
        if not isinstance(hours, dict) or not (counters or {}).get("available", True):
            return None
        starts = [datetime.fromisoformat(x).timestamp() for x in axis[0]]
        end = window.end.timestamp()
        out = [0] * len(starts)
        for hour, count in hours.items():
            try:
                ts = int(hour) * 3600
            except (TypeError, ValueError):
                continue
            if ts >= end or not starts or ts < starts[0]:
                continue
            slot = bisect.bisect_right(starts, ts) - 1
            if 0 <= slot < len(out):
                out[slot] += int(finite(count) or 0)
        return out

    # -- case mix ---------------------------------------------------------- #
    async def _case_mix(self, ctx, args, window: Window, mw: MetricWindow, periods: list[Period]) -> ToolOutcome:
        mix = await run_case_aggregate(ctx, window, group_by=("verdict", "status"), metrics=("count", "mean_risk"))
        disp = await run_case_aggregate(ctx, window, group_by=("disposition",))
        exact = is_exact(mix) and is_exact(disp)
        label = window_caption_label(mix, window)
        rows, _ = result_rows(mix)
        by_verdict: dict[str, int] = {}
        by_status: dict[str, int] = {}
        for g in rows:
            n = int(finite((g.get("metrics") or {}).get("count")) or 0)
            key = g.get("key") or {}
            by_verdict[str(key.get("verdict") or "none")] = by_verdict.get(str(key.get("verdict") or "none"), 0) + n
            by_status[str(key.get("status") or "unknown")] = by_status.get(str(key.get("status") or "unknown"), 0) + n
        by_verdict = {k: v for k, v in by_verdict.items() if v}
        by_status = {k: v for k, v in by_status.items() if v}
        disp_rows, _ = result_rows(disp)
        by_disp = {str((g.get("key") or {}).get("disposition") or "none"): int(finite((g.get("metrics") or {}).get("count")) or 0)
                   for g in disp_rows}
        by_disp = {k: v for k, v in by_disp.items() if v}
        from ...constants import TERMINAL_CASE_STATUSES

        closed = sum(v for k, v in by_status.items() if k in TERMINAL_CASE_STATUSES)
        avg_risk = finite((mix.totals or {}).get("mean_risk"))
        extras = await self._page_extras(ctx, window, mw)
        caption = f"{fmt_int(mix.total)} cases · {'exact' if exact else 'partial'} · {label}"
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Case mix", title_trusted=True, data={"items": [
                kpi("cases", "Cases", mix.total, bound=not exact),
                kpi("closed", "Closed", closed),
                kpi("avg_risk", "Average risk", avg_risk, "score"),
                kpi("active_risk_index", "Active Risk Index", extras.get("active_risk_index"), "score", display="gauge"),
            ]}, provenance="code", window=caption),
            Artifact(id="a2", kind="categories", title="Cases by verdict", title_trusted=True,
                     data=categories([(group_label("verdict", None if k == "none" else k), v) for k, v in by_verdict.items()],
                                     dimension="verdict"), provenance="code", window=caption),
            Artifact(id="a3", kind="categories", title="Cases by status", title_trusted=True,
                     data=categories([(group_label("status", k), v) for k, v in by_status.items()], dimension="status"),
                     provenance="code", window=caption),
            Artifact(id="a4", kind="categories", title="Cases by disposition", title_trusted=True,
                     data=categories([(group_label("disposition", None if k == "none" else k), v) for k, v in by_disp.items()],
                                     dimension="disposition"), provenance="code", window=caption),
        ]
        observation: dict[str, Any] = {
            "window": label, "cases": mix.total, "exact": exact, "by_verdict": by_verdict, "by_status": by_status,
            "by_disposition": by_disp, "closed": closed, "avg_risk_score": avg_risk,
            "active_risk_index": extras.get("active_risk_index"),
        }
        if len(periods) > 1:
            compared = await self._compared(ctx, window, periods, mix, group_by=("verdict", "status"),
                                            metrics=("count", "mean_risk"))
            rows_cmp = [comparison_row("count", "Cases", [r.total for r in compared], unit="count")]
            verdicts = sorted({str((g.get("key") or {}).get("verdict") or "none")
                               for r in compared for g in result_rows(r)[0]})
            for verdict in verdicts:
                values = [sum(int(finite((g.get("metrics") or {}).get("count")) or 0) for g in result_rows(r)[0]
                              if str((g.get("key") or {}).get("verdict") or "none") == verdict) for r in compared]
                rows_cmp.append(comparison_row(f"v_{verdict.lower()}"[:60],
                                               group_label("verdict", None if verdict == "none" else verdict),
                                               values, unit="count"))
            self._add_comparison(artifacts, observation, periods, rows_cmp, None, compared)
        summary = f"Case mix ({label}): {fmt_int(mix.total)} cases across {len(by_verdict)} verdicts"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if exact else "sample", coverage=_partial_share(observation, None, mix, disp))

    # -- timing ------------------------------------------------------------ #
    async def _timing(
        self, ctx, args, window: Window, mw: MetricWindow, periods: list[Period],
        plan: tuple[str, dict[str, Any] | None] | None = None,
    ) -> ToolOutcome:
        # The headline figures and the per-period series cover the SAME (aligned) window.
        agg = await run_case_aggregate(ctx, window, metrics=_TIMING_METRICS)
        bucket, planned = plan if plan else (args.bucket if args.bucket != "auto" else _auto_bucket(window), None)

        async def run(unit: str) -> Any:
            return await run_case_aggregate(ctx, window, bucket=unit,
                                            metrics=("count", "mttd_p50", "mtta_p50", "mttr_p50"))

        async def probe() -> Any:
            return agg

        trend, bucket, coarsened = await run_bucketed(window, bucket, run, probe, explicit=args.bucket != "auto")
        coarsened = coarsened or planned
        exact = is_exact(agg) and is_exact(trend)
        label = window_caption_label(agg, window)
        totals = dict(agg.totals or {})

        def minutes(metric: str) -> float | None:
            return metric_value(metric, totals.get(metric))

        items = [
            kpi("mttd_p50", "MTTD (median)", minutes("mttd_p50"), "minutes"),
            kpi("mtta_p50", "MTTA (median)", minutes("mtta_p50"), "minutes"),
            kpi("mttr_p50", "MTTR (median)", minutes("mttr_p50"), "minutes"),
            kpi("mtta_p90", "MTTA (p90)", minutes("mtta_p90"), "minutes"),
            kpi("mttr_p90", "MTTR (p90)", minutes("mttr_p90"), "minutes"),
            kpi("mttd_p90", "MTTD (p90)", minutes("mttd_p90"), "minutes"),
        ]
        caption = f"{fmt_int(agg.total)} cases · {'exact' if exact else 'partial'} · {label}"
        artifacts = [Artifact(id="a1", kind="kpis", title="Response times", title_trusted=True,
                              data={"items": items}, provenance="code", window=caption)]
        axis = bucket_axis(trend, window, bucket)
        rows, _ = result_rows(trend)
        names = [str(b[0]) for b in trend.buckets or [] if len(b) == 2]
        index = {name: i for i, name in enumerate(names)}

        def series(metric: str) -> list[Any]:
            values: list[Any] = [None] * len(names)
            for g in rows:
                slot = index.get(str(g.get("bucket")))
                if slot is not None:
                    values[slot] = metric_value(metric, (g.get("metrics") or {}).get(metric))
            return values

        trend_series = {m: series(m) for m in ("mttd_p50", "mtta_p50", "mttr_p50")}
        measured = sum(1 for i in range(len(names)) if any(trend_series[m][i] is not None for m in trend_series))
        base, partial_info = _series_base(window, bucket, axis, names,
                                          [bool(b[1]) for b in trend.buckets or [] if len(b) == 2])
        base.pop("unit", None)
        if measured >= 2:
            artifacts.append(Artifact(
                id="a2", kind="series", title=f"Response times per {bucket}", title_trusted=True,
                data={**base, "unit": "minutes", "series": [
                    {"key": "mttd", "label": "Detect (median)", "values": trend_series["mttd_p50"]},
                    {"key": "respond", "label": "Respond (median)", "values": trend_series["mtta_p50"]},
                    {"key": "resolve", "label": "Resolve (median)", "values": trend_series["mttr_p50"]},
                ]},
                provenance="code", window=caption,
            ))
        observation: dict[str, Any] = {
            "window": label,
            "cases": agg.total,
            "exact": exact,
            "lifecycle_minutes": _lifecycle(totals),
            "bucket": bucket,
            "per_bucket_minutes": {
                "buckets": names,
                "mttd_p50": trend_series["mttd_p50"], "mtta_p50": trend_series["mtta_p50"],
                "mttr_p50": trend_series["mttr_p50"],
            },
            "note": "MTTA counts human acknowledgement only; each period covers the cases opened in it",
        }
        _bucket_notes(observation, partial_info, coarsened)
        if len(periods) > 1:
            compared = await self._compared(ctx, window, periods, agg, metrics=_TIMING_METRICS)
            ctotals = [dict(r.totals or {}) for r in compared]
            rows_cmp = [
                comparison_row(f"{m}_p50", f"{m.upper()} (median)",
                               [metric_value(f"{m}_p50", t.get(f"{m}_p50")) for t in ctotals], unit="minutes",
                               good="down", samples=[t.get(f"{m}_samples") for t in ctotals])
                for m in ("mttd", "mtta", "mttr")
            ]
            self._add_comparison(artifacts, observation, periods, rows_cmp, None, compared)
        summary = (f"Response times ({label}): MTTA median {fmt_int(minutes('mtta_p50'))} min, MTTR median "
                   f"{fmt_int(minutes('mttr_p50'))} min")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if exact else "sample", coverage=_partial_share(observation, None, agg, trend))

    # -- noise funnel (exact case population + counters) ------------------- #
    async def _noise_population(self, ctx: ChatToolContext, mw: MetricWindow) -> tuple[list[Any], int, bool, bool]:
        """``(cases, scope_total, load_ok, complete)``: every case the window reaches,
        from the SAME exact population (and cache) the Noise Reduction dashboard reads."""
        from ...api.metrics_shared import fetch_case_population

        if ctx.cases is None:
            return [], 0, False, False
        span = None if mw.all_time else max(1, math.ceil((mw.now - mw.start).total_seconds() / 3600))
        try:
            population = await fetch_case_population(ctx.cases, span_hours=span, limit=_POPULATION_LIMIT)
        except Exception as exc:  # noqa: BLE001 — degrade to "not measured"
            logger.warning("noise funnel population read failed: %s", exc)
            return [], 0, False, False
        if not population.load_ok:
            return [], 0, False, False
        return list(population.cases), int(population.scope_total), True, bool(population.complete)

    async def _noise_funnel(self, ctx, args, mw: MetricWindow) -> ToolOutcome:
        from ...engine.noise_counters import build_noise_reduction

        cases, store_total, load_ok, complete = await self._noise_population(ctx, mw)
        hours = mw.hours
        counters: dict[str, Any] = {"available": False}
        if ctx.noise is not None:
            try:
                # A past range is the exact ``[end - hours, end)``; a trailing one keeps
                # the dashboard's "include the current hour" read; all time is 0.
                counters = await ctx.noise.read_window(hours, now=mw.end, end_exclusive=not mw.trailing)
            except Exception as exc:  # noqa: BLE001 — case-only funnel
                logger.info("noise counters unavailable: %s", exc)
        bounded, dropped = _bounded(cases, mw)
        n = build_noise_reduction(
            bounded, counters, window_hours=hours, store_total=max(len(bounded), store_total - dropped),
            fetched_count=len(bounded), prefs=ctx.prefs, generated_at=iso_now(), now=mw.end,
        )
        stages = {s.get("key"): s for s in (n.get("stages") or []) if isinstance(s, dict)}
        if not load_ok:
            # The counter stages are real; every stage counted from cases (and both
            # reduction figures, which divide by them) is NOT MEASURED, never 0 (G3).
            for stage in stages.values():
                if stage.get("source") == "cases":
                    stage["total"] = None
            n["reduction"] = {"overall_pct": None, "human_reduction_pct": None}

        def total(key: str) -> float | None:
            stage = stages.get(key) or {}
            return finite(stage.get("total")) if stage.get("total") is not None else None

        order = [("ingested", "Alerts ingested"), ("clustered", "After clustering"),
                 ("cases", "Cases opened"), ("needs_human", "Needs a human")]
        reduction = n.get("reduction") or {}
        artifacts = [
            Artifact(id="a1", kind="funnel", title="Noise reduction", title_trusted=True,
                     data={"stages": [label for _k, label in order],
                           "values": [total(k) for k, _l in order], "unit": "count"},
                     provenance="code", truncated=bool((n.get("cases_meta") or {}).get("truncated"))),
            Artifact(id="a2", kind="kpis", title="Reduction figures", title_trusted=True,
                     data={"items": [
                         kpi("overall_reduction", "Overall reduction", finite(reduction.get("overall_pct")), "percent"),
                         kpi("human_reduction", "Reduction before a human", finite(reduction.get("human_reduction_pct")), "percent"),
                         kpi("auto_cleared", "Auto-cleared by AI", total("auto_cleared")),
                         kpi("escalated", "Escalated", total("escalated")),
                         kpi("closed_by_human", "Closed by a human", total("closed")),
                     ]}, provenance="code"),
        ]
        observation = {
            "stages": [{"key": k, "label": text((stages.get(k) or {}).get("label"), 60), "total": total(k)}
                       for k in stages],
            "reduction_pct": {"overall": finite(reduction.get("overall_pct")),
                              "before_human": finite(reduction.get("human_reduction_pct"))},
            "counters": {k: (n.get("counters") or {}).get(k) for k in ("available", "incomplete", "since")},
            "drops": n.get("drops"),
            "completeness": n.get("cases_meta"),
        }
        if not load_ok:
            observation["case_store_unavailable"] = True
        page_note = _page_note(cases, store_total) if load_ok and not complete else None
        if page_note:
            observation["case_stages_scope"] = page_note
        if load_ok:
            summary = (f"Noise funnel ({mw.label}): {fmt_int(total('ingested'))} alerts ingested -> "
                       f"{fmt_int(total('cases'))} cases -> {fmt_int(total('needs_human'))} needing a human")
            if page_note:
                summary += f" (case stages {page_note})"
        else:
            summary = (f"Noise funnel ({mw.label}): {fmt_int(total('ingested'))} alerts ingested; "
                       "case stages not measured (the case store did not answer)")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if (complete or not load_ok) else "sample",
                           coverage=f"case stages {page_note}" if page_note else None)

    # -- MITRE coverage (page) --------------------------------------------- #
    async def _mitre_coverage(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import _window_filter
        from ...engine.mitre_coverage import compute_mitre_coverage

        all_time = mw.all_time or (args.window is None and args.window_hours is None and ctx.default_range is None)
        if all_time:
            scoped = cases
        else:
            bounded, _dropped = _bounded(cases, mw)
            scoped = _window_filter(bounded, window_hours=mw.hours, now=mw.end)
        cov = compute_mitre_coverage(scoped, store_total=store_total, fetched_count=len(cases))
        by_tactic = cov.get("by_tactic") or {}
        techniques: dict[str, dict[str, Any]] = {}
        for tactic, row in by_tactic.items():
            for tech in (row or {}).get("techniques") or []:
                tid = str(tech.get("id") or "")
                if tid and tid not in techniques:
                    techniques[tid] = {"id": tid, "name": str(tech.get("name") or "")[:120],
                                       "tactic": str(tactic), "count": finite(tech.get("case_count"))}
        ranked = sorted(techniques.values(), key=lambda t: (-(t["count"] or 0), t["id"]))
        label = ("all cases" if store_total <= len(cases) else f"the newest {fmt_int(len(cases))} cases") \
            if all_time else mw.label
        artifacts = [
            Artifact(id="a1", kind="kpis", title="ATT&CK coverage", title_trusted=True, data={"items": [
                kpi("covered", "Techniques seen", cov.get("covered_techniques")),
                kpi("total", "Techniques in corpus", cov.get("total_techniques")),
                kpi("coverage", "Coverage", finite(cov.get("coverage_pct")), "percent"),
            ]}, provenance="code", window=label),
            Artifact(id="a2", kind="categories", title="Coverage by tactic", title_trusted=True,
                     data=categories([(t, (r or {}).get("coverage_pct")) for t, r in by_tactic.items()],
                                     unit="percent", dimension="tactic"),
                     provenance="code", window=label),
        ]
        if ranked:
            artifacts.append(Artifact(id="a3", kind="mitre", title="Techniques seen in cases", title_trusted=True,
                                      data={"techniques": ranked[:60]}, provenance="code", window=label,
                                      total=len(ranked), truncated=len(ranked) > 60))
        observation = {
            "window": label,
            "_window_applies": not all_time,
            "covered_techniques": cov.get("covered_techniques"),
            "total_techniques": cov.get("total_techniques"),
            "coverage_pct": cov.get("coverage_pct"),
            "by_tactic": {t: {"covered": (r or {}).get("covered"), "total": (r or {}).get("total"),
                              "pct": (r or {}).get("coverage_pct")} for t, r in by_tactic.items()},
            "top_techniques": [{"id": t["id"], "name": t["name"], "cases": t["count"]} for t in ranked[:15]],
            "completeness": {k: cov.get(k) for k in ("truncated", "store_total", "fetched", "invalid_dropped")},
        }
        summary = (f"ATT&CK coverage ({label}): {fmt_int(cov.get('covered_techniques'))} of "
                   f"{fmt_int(cov.get('total_techniques'))} techniques seen")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="sample" if cov.get("truncated") else "exact",
                           coverage=_page_note(cases, store_total))

    # -- auto-close health (page) ------------------------------------------ #
    async def _auto_close_health(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import auto_close_health

        hours = mw.hours or max(1, math.ceil((mw.end - datetime(1970, 1, 1, tzinfo=timezone.utc)).total_seconds() / 3600))
        # Decisions are tallied on ``[end - hours, end)`` (both sides bounded).
        a = auto_close_health(cases, window_hours=hours, now=mw.end,
                              policy=getattr(ctx.prefs, "auto_close", None), store_total=store_total)
        cur = a.get("current") or {}
        base = a.get("baseline") or {}
        artifacts = [Artifact(id="a1", kind="kpis", title="Auto-close health", title_trusted=True, data={"items": [
            kpi("rate", "Auto-close rate", ratio_to_pct(cur.get("rate")), "percent",
                context=None if cur.get("available") else "not enough decided cases"),
            kpi("baseline_rate", "Previous window", ratio_to_pct(base.get("rate")), "percent",
                context=None if base.get("available") else "not enough decided cases"),
            kpi("decided", "Decided cases", cur.get("decided")),
            kpi("auto_closed", "Auto-closed", cur.get("auto_closed")),
            kpi("to_human", "Routed to a human", cur.get("routed_to_human")),
        ]}, provenance="code")]
        observation = {
            "status": a.get("status"), "reason": a.get("reason") or None,
            "needs_attention": a.get("needs_attention"), "collapsed": a.get("collapsed"),
            "current": {k: cur.get(k) for k in ("decided", "auto_closed", "routed_to_human", "analyst_decided", "rate", "available", "reason")},
            "previous": {k: base.get(k) for k in ("decided", "auto_closed", "routed_to_human", "rate", "available", "reason")},
            "policy": a.get("policy"),
            "completeness": {k: a.get(k) for k in ("truncated", "store_total", "fetched")},
        }
        for part in ("current", "previous"):
            if observation[part].get("rate") == "—":
                observation[part]["rate"] = None
        summary = f"Auto-close health ({mw.label}): status {text(a.get('status'), 40)}, rate {fmt_pct(cur.get('rate'), ratio=True)}"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact",
                           coverage=_page_note(cases, store_total))

    # -- agent improvement ------------------------------------------------- #
    async def _agent_improvement(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.agent_improvement import agent_improvement_metrics

        usage_records: list[dict[str, Any]] = []
        usage_ok = False
        if ctx.usage is not None and hasattr(ctx.usage, "records_strict"):
            try:
                usage_records = [r for r in await ctx.usage.records_strict(limit=5000) if isinstance(r, dict)]
                usage_ok = True
            except Exception as exc:  # noqa: BLE001 — evidence degrades explicitly
                logger.info("agent-improvement usage read failed: %s", exc)
        tuning_records: list[dict[str, Any]] = []
        tuning_ok = False
        if ctx.tuning is not None and hasattr(ctx.tuning, "list_strict"):
            try:
                tuning_records = [r.to_json() for r in await ctx.tuning.list_strict()][:1000]
                tuning_ok = True
            except Exception as exc:  # noqa: BLE001
                logger.info("agent-improvement tuning read failed: %s", exc)
        ai = agent_improvement_metrics(
            cases, store_total=store_total, synthetic=ctx.demo_active, prefs=ctx.prefs,
            usage_records=usage_records, usage_available=usage_ok,
            usage_records_truncated=len(usage_records) >= 5000,
            tuning_records=tuning_records, tuning_available=tuning_ok,
        )
        headline = ai.get("headline") or {}
        metrics = ai.get("metrics") or {}
        compact: dict[str, Any] = {}
        items = []
        for key, row in metrics.items():
            if not isinstance(row, dict):
                continue
            current = row.get("current") or {}
            value = finite(current.get("value"))
            unit = str(row.get("unit") or "")
            compact[key] = {"label": text(row.get("label"), 80), "unit": unit, "value": value,
                            "status": current.get("status"), "reason": current.get("reason") or None,
                            "samples": current.get("sample_count")}
            if len(items) < 6:
                kpi_unit, kpi_value = "count", value
                if unit == "ratio":
                    kpi_unit, kpi_value = "percent", (None if value is None else round(value * 100, 1))
                elif unit in ("minutes", "hours", "seconds"):
                    kpi_unit = unit
                elif unit.upper() == "USD":
                    kpi_unit = "usd"
                items.append(kpi(key[:64], text(row.get("label"), 60) or key, kpi_value, kpi_unit,
                                 context=None if value is not None else "insufficient evidence"))
        artifacts = []
        if items:
            artifacts.append(Artifact(id="a1", kind="kpis", title="Agent improvement", title_trusted=True,
                                      data={"items": items}, provenance="code"))
        # Fixed comparison windows (the Effectiveness page's): the selected range and
        # window do not apply, and the label says so instead of borrowing theirs.
        label = "last 7 complete UTC days vs the 28 before"
        for artifact in artifacts:
            artifact.window = label
        observation = {
            "window": label,
            "_window_applies": False,
            "headline": {k: headline.get(k) for k in ("state", "reason", "improving_signals", "regressing_signals", "signal_domains")},
            "windows": ai.get("windows"),
            "metrics": compact,
            "provenance": ai.get("provenance"),
            "synthetic": ai.get("synthetic"),
        }
        summary = f"Agent improvement ({label}): {text(headline.get('state'), 40) or 'unknown'}"
        coverage = None
        if args.window is not None or args.window_hours is not None or ctx.default_range is not None:
            coverage = "fixed comparison windows; the selected range does not apply"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact", coverage=coverage)

    # -- feedback (page) --------------------------------------------------- #
    async def _feedback(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import _window_filter, feedback_stats

        bounded, _dropped = _bounded(cases, mw)
        windowed = _window_filter(bounded, window_hours=mw.hours, now=mw.end)
        fb = feedback_stats(windowed)
        dist = fb.get("outcome_distribution") or {}
        graded = int(fb.get("graded_cases") or 0)
        artifacts = [Artifact(id="a1", kind="kpis", title="Analyst feedback", title_trusted=True, data={"items": [
            kpi("graded", "Graded cases", graded),
            kpi("agreement", "Agreement with the AI", ratio_to_pct(fb.get("agreement_rate")) if graded else None, "percent"),
            kpi("accuracy", "Average accuracy", ratio_to_pct(fb.get("avg_accuracy")) if graded else None, "percent"),
            kpi("time_saved", "Time saved", fb.get("time_saved_minutes"), "minutes"),
        ]}, provenance="code")]
        if dist:
            artifacts.append(Artifact(id="a2", kind="categories", title="Confirmed outcomes", title_trusted=True,
                                      data=categories(list(dist.items()), dimension="outcome"), provenance="code"))
        observation = {k: fb.get(k) for k in (
            "graded_cases", "feedback_count", "agreement_rate", "avg_accuracy", "avg_reasoning_quality",
            "avg_action_appropriateness", "time_saved_minutes", "outcome_distribution")}
        summary = f"Analyst feedback ({mw.label}): {fmt_int(graded)} graded cases"
        if graded:
            summary += f", agreement {fmt_pct(fb.get('agreement_rate'), ratio=True)}"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact",
                           coverage=_page_note(cases, store_total))


class _StoreDown(Exception):
    """The case page could not be read (a case-only kind fails as not measured)."""


# --------------------------------------------------------------------------- #
# cost_usage
# --------------------------------------------------------------------------- #
_USAGE_GROUPS = ("role", "model", "surface", "provider", "service_tier")
_USAGE_TITLES = {"role": ("Spend by AI role", "role"), "model": ("Spend by model", "model"),
                 "surface": ("Spend by surface", "surface"), "provider": ("Spend by provider", "provider"),
                 "service_tier": ("Spend by service tier", "service tier")}
_USAGE_METRICS = ("calls", "input_tokens", "output_tokens", "total_tokens", "cost_usd")


class CostUsageInput(ToolInput):
    window: str | dict[str, Any] | None = None
    window_hours: int | None = Field(default=None, ge=1)
    case_id: str | None = Field(default=None, max_length=128)
    group_by: list[Literal[_USAGE_GROUPS]] = Field(  # type: ignore[valid-type]
        default_factory=lambda: ["role", "model", "surface"], max_length=5,
    )
    bucket: Literal[BUCKET_CHOICES] = "auto"  # type: ignore[valid-type]
    compare: Any = None

    @field_validator("window_hours", "case_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)

    @field_validator("window", mode="before")
    @classmethod
    def _window(cls, value: Any) -> Any:
        return window_input(value)

    @field_validator("group_by", mode="before")
    @classmethod
    def _group_by(cls, value: Any) -> Any:
        if value in (None, "", []):
            return ["role", "model", "surface"]
        if isinstance(value, str):
            value = value.replace(";", ",").split(",")
        if isinstance(value, (list, tuple)):
            aliases = {"tier": "service_tier", "roles": "role", "models": "model", "surfaces": "surface",
                       "providers": "provider"}
            out: list[str] = []
            for item in value:
                key = str(item).strip().lower().replace(" ", "_")
                key = aliases.get(key, key)
                if key not in out:
                    out.append(key)
            return out
        return value

    @field_validator("bucket", mode="before")
    @classmethod
    def _bucket(cls, value: Any) -> Any:
        return normalise_bucket(value)

    @field_validator("compare", mode="before")
    @classmethod
    def _compare(cls, value: Any) -> Any:
        return normalise_compare(value)


def _top_rows(rows: Any, n: int | None = None) -> list[dict[str, Any]]:
    out = []
    for row in (rows or [])[:n] if n else (rows or []):
        if isinstance(row, dict):
            out.append({"key": text(row.get("key"), 80), "cost": finite(row.get("cost")),
                        "tokens": row.get("tokens"), "calls": row.get("calls")})
    return out


class CostUsageTool(ChatTool):
    name: ClassVar[str] = "cost_usage"
    label: ClassVar[str] = "Read AI cost and usage"
    scope: ClassVar[str] = "platform"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cost", "view"),)
    optional_grants: ClassVar[tuple[tuple[str, str], ...]] = (("models", "read"),)
    data_source: ClassVar[str] = "AI usage and cost ledger"
    input_model: ClassVar[type] = CostUsageInput
    timeout_s: ClassVar[float] = AGGREGATE_TOOL_TIMEOUT_S
    signature: ClassVar[str] = (
        "cost_usage(window? (default last 24 hours), case_id?, group_by?=[role,model,surface] (+provider, "
        "service_tier), bucket?=auto|hour|day|week|month|quarter|year, compare?) -- EXACT AI spend, tokens and "
        "calls by role, model and surface and over time, plus today's budget"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("window", "window_hours", "case_id", "group_by", "bucket", "compare")

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        if isinstance(params.get("group_by"), list):
            params["group_by"] = ",".join(str(g) for g in params["group_by"][:5])
        for key in ("window", "compare"):
            if isinstance(params.get(key), (dict, list)):
                params[key] = str(params[key])[:80]
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(CostUsageInput, inp)
        if error is not None:
            return error
        if ctx.usage is None:
            return ToolOutcome.failure("The usage ledger is not available")
        ref = datetime.now(timezone.utc)
        window = resolve_window(ctx, window=args.window, window_hours=args.window_hours, default_hours=24, now=ref,
                                minutes_ok=False)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        if not (hasattr(ctx.usage, "export_page") or hasattr(ctx.usage, "aggregate_usage")):
            periods = resolve_periods(ctx, window, args.compare, now=ref, minutes_ok=False)
            if isinstance(periods, str):
                return ToolOutcome.failure(periods)
            if len(periods) > 1:
                return ToolOutcome.failure("Comparisons need the full usage ledger, which is not available here")
            return await self._legacy(ctx, args, window, ref)
        # The spend total, the series per period and the compared periods cover ONE
        # window, aligned to whole periods of the series' unit (so they add up).
        bucket = args.bucket if args.bucket != "auto" else _auto_bucket(window)
        window, bucket, planned = plan_bucket(window, bucket, explicit=args.bucket != "auto")
        periods = resolve_periods(ctx, window, args.compare, now=ref, minutes_ok=False)
        if isinstance(periods, str):
            return ToolOutcome.failure(periods)
        budget = await self._budget(ctx)
        try:
            outcome = await self._aggregated(ctx, args, window, periods, budget, plan=(bucket, planned))
        except ValueError as exc:
            # The aggregator refused the REQUEST (engine text): an input error, never
            # a ledger outage.
            return invalid_aggregate_input(exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("cost_usage aggregate failed: %s", exc)
            return ToolOutcome.failure("The usage ledger did not answer")
        return outcome

    async def _budget(self, ctx: ChatToolContext) -> dict[str, Any] | None:
        if not (ctx.has("models", "read") and ctx.budget_gate is not None):
            return None
        try:
            budget = await ctx.budget_gate.status()
        except Exception as exc:  # noqa: BLE001 — budget is an optional extra
            logger.info("budget status unavailable: %s", exc)
            return None
        return budget if isinstance(budget, dict) else None

    async def _usage(self, ctx: ChatToolContext, window: Any, args: CostUsageInput, *,
                     group_by: tuple[str, ...] = (), bucket: str | None = None) -> Any:
        """One exact usage aggregate; ``window`` is a chat :class:`Window` or an engine
        ``ResolvedWindow`` (today's spend, which no request chip narrows)."""
        from ...engine.case_aggregate import UsageAggregateSpec, aggregate_usage

        filters = {"case_id": args.case_id} if args.case_id else {}
        resolved = window.as_resolved() if isinstance(window, Window) else window
        spec = UsageAggregateSpec(window=resolved, filters=filters, group_by=group_by,
                                  bucket=bucket, metrics=_USAGE_METRICS)  # type: ignore[arg-type]
        return await aggregate_usage(ctx.usage, spec, progress=progress_reporter(ctx, "ledger rows"))

    async def _today_cost(self, ctx: ChatToolContext, window: Window, args: CostUsageInput) -> float | None:
        """Spend so far today in the operator timezone: a STOCK figure like the budget,
        so the request's time chip never narrows it ("Spend today" is always today)."""
        from ...engine.time_windows import resolve_window as engine_window

        try:
            today = await self._usage(ctx, engine_window("today", tz=window.tz, now=window.ref or window.end), args)
        except Exception as exc:  # noqa: BLE001 — today's figure is an extra
            logger.info("today's spend unavailable: %s", exc)
            return None
        return finite((today.totals or {}).get("cost_usd")) if is_exact(today) else None

    async def _aggregated(
        self, ctx: ChatToolContext, args: CostUsageInput, window: Window, periods: list[Period],
        budget: dict[str, Any] | None, *, plan: tuple[str, dict[str, Any] | None] | None = None,
    ) -> ToolOutcome:
        totals_result = await self._usage(ctx, window, args)
        totals = dict(totals_result.totals or {})
        exact = is_exact(totals_result)
        label = window_caption_label(totals_result, window)
        simulated = bool(ctx.demo_active)
        caption = f"{fmt_int(totals_result.total)} model calls · {'exact' if exact else 'partial'} · {label}"
        today_cost = await self._today_cost(ctx, window, args)
        items = [
            kpi("cost", "AI spend", finite(totals.get("cost_usd")), "usd", context="simulated" if simulated else None),
            kpi("tokens", "Tokens", totals.get("total_tokens"), "tokens"),
            kpi("calls", "Model calls", totals.get("calls")),
            kpi("today", "Spend today", today_cost, "usd", context="not windowed"),
        ]
        daily = (budget or {}).get("daily") if isinstance(budget, dict) else None
        if isinstance(daily, dict) and finite(daily.get("fraction")) is not None:
            items.append(kpi("budget_used", "Daily budget used", round(finite(daily["fraction"]) * 100, 1),
                             "percent", context=f"of ${finite(daily.get('cap')) or 0:,.2f}"))
        artifacts = [Artifact(id="a1", kind="kpis", title="AI cost", title_trusted=True,
                              data={"items": items}, provenance="code", window=caption)]
        bucket, planned = plan if plan else (args.bucket if args.bucket != "auto" else _auto_bucket(window), None)

        async def run(unit: str) -> Any:
            return await self._usage(ctx, window, args, bucket=unit)

        async def probe() -> Any:
            return totals_result

        over_time, bucket, coarsened = await run_bucketed(window, bucket, run, probe, explicit=args.bucket != "auto")
        coarsened = coarsened or planned
        axis = bucket_axis(over_time, window, bucket)
        rows, _ = result_rows(over_time)
        names = [str(b[0]) for b in over_time.buckets or [] if len(b) == 2]
        index = {name: i for i, name in enumerate(names)}
        spend = [0.0] * len(names)
        for g in rows:
            slot = index.get(str(g.get("bucket")))
            if slot is not None:
                spend[slot] = round(finite((g.get("metrics") or {}).get("cost_usd")) or 0.0, 6)
        base, partial_info = _series_base(window, bucket, axis, names,
                                          [bool(b[1]) for b in over_time.buckets or [] if len(b) == 2])
        if len(names) >= 2:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="series", title=f"AI spend per {bucket}", title_trusted=True,
                data={**base, "unit": "usd", "series": [{"key": "cost", "label": "Spend", "values": spend}]},
                provenance="code", window=caption,
            ))
        breakdowns: dict[str, list[dict[str, Any]]] = {}
        for field in args.group_by:
            grouped = await self._usage(ctx, window, args, group_by=(field,))
            group_rows, _ = result_rows(grouped)
            ranked = [{"key": str((g.get("key") or {}).get(field) or "unknown"),
                       "cost": finite((g.get("metrics") or {}).get("cost_usd")),
                       "tokens": (g.get("metrics") or {}).get("total_tokens"),
                       "calls": (g.get("metrics") or {}).get("calls")} for g in group_rows]
            breakdowns[field] = ranked
            if ranked:
                title, dim = _USAGE_TITLES[field]
                artifacts.append(Artifact(
                    id=f"a{len(artifacts) + 1}", kind="categories", title=title, title_trusted=True,
                    data=categories([(r["key"], r["cost"]) for r in ranked], unit="usd", dimension=dim),
                    provenance="code", window=caption,
                ))
        observation: dict[str, Any] = {
            "window": label,
            "window_clamped_to_request": window.clamped,
            "timezone": window.tz,
            "exact": exact,
            "case_id": args.case_id,
            "total_cost_usd": finite(totals.get("cost_usd")),
            "total_tokens": totals.get("total_tokens"),
            "input_tokens": totals.get("input_tokens"),
            "output_tokens": totals.get("output_tokens"),
            "calls": totals.get("calls"),
            "today_cost_usd": today_cost,
            "today_note": "spend so far today in the operator timezone, whatever the window",
            "bucket": bucket,
            "spend_per_bucket": {"buckets": names, "cost_usd": spend},
            **{f"by_{field}": _top_rows(rows) for field, rows in breakdowns.items()},
            "simulated": simulated,
        }
        _bucket_notes(observation, partial_info, coarsened)
        if budget is not None:
            observation["budget"] = {k: budget.get(k) for k in ("enabled", "on_exceed", "soft_warn_pct", "daily", "monthly")}
        compare_partial = None
        if len(periods) > 1:
            compared = []
            for period in periods:
                compared.append(totals_result if period.window is window else await self._usage(ctx, period.window, args))
            compare_basis, compare_partial = comparison_basis(compared)
            ctotals = [dict(r.totals or {}) for r in compared]
            rows_cmp = [
                comparison_row("cost", "AI spend", [finite(t.get("cost_usd")) for t in ctotals], unit="usd", good="down"),
                comparison_row("calls", "Model calls", [t.get("calls") for t in ctotals], unit="count"),
                comparison_row("tokens", "Tokens", [t.get("total_tokens") for t in ctotals], unit="tokens"),
            ]
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="comparison", title="Comparison", title_trusted=True,
                data=comparison_data(periods, rows_cmp), provenance="code", basis=compare_basis,
                window=" vs ".join(p.label for p in reversed(periods)),
            ))
            observation["comparison"] = comparison_observation(periods, rows_cmp)
            if compare_partial:
                observation["comparison"]["partial"] = compare_partial.replace("cases counted", "ledger rows counted")
        summary = (f"AI spend ({label}): ${finite(totals.get('cost_usd')) or 0:,.4f} over "
                   f"{fmt_int(totals.get('calls'))} calls, {fmt_int(totals.get('total_tokens'))} tokens")
        if simulated:
            summary += " (simulated)"
        if window.clamped:
            summary += "; window limited to the selected range"
        if coarsened_note(coarsened):
            summary += f" ({coarsened_note(coarsened)})"
        notes = []
        partial = first_partial(totals_result, over_time)
        if partial is not None:
            counted, sentence, observed = counted_share(partial, noun="ledger rows", store="usage ledger")
            observation["partial"] = observed
            if counted is not None:
                observation["counted"] = counted
            notes.append(sentence)
        if compare_partial:
            notes.append("partial: the usage ledger stopped answering while one compared period was counted")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if exact else "sample",
                           coverage="; ".join(notes) or None,
                           untrusted_params={"case_id": args.case_id} if args.case_id else {})

    async def _legacy(self, ctx: ChatToolContext, args: CostUsageInput, window: Window, ref: datetime) -> ToolOutcome:
        """A usage reader with only a trailing ``summary()`` (a third-party ledger)."""
        mw = metric_window(window, ref)
        if not mw.trailing or mw.all_time:
            return ToolOutcome.failure(
                "AI spend can only be read for a window that ends now on this ledger"
            )
        try:
            s = await ctx.usage.summary(window_hours=mw.hours, case_id=args.case_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("cost_usage summary failed: %s", exc)
            return ToolOutcome.failure("The usage ledger did not answer")
        budget = await self._budget(ctx)
        simulated = bool(ctx.demo_active)
        items = [
            kpi("cost", "AI spend", finite(s.get("total_cost")), "usd", context="simulated" if simulated else None),
            kpi("tokens", "Tokens", s.get("total_tokens"), "tokens"),
            kpi("calls", "Model calls", s.get("call_count")),
            kpi("today", "Spend today", finite(s.get("today_cost")), "usd"),
        ]
        daily = (budget or {}).get("daily") if isinstance(budget, dict) else None
        if isinstance(daily, dict) and finite(daily.get("fraction")) is not None:
            items.append(kpi("budget_used", "Daily budget used", round(finite(daily["fraction"]) * 100, 1),
                             "percent", context=f"of ${finite(daily.get('cap')) or 0:,.2f}"))
        artifacts = [Artifact(id="a1", kind="kpis", title="AI cost", title_trusted=True,
                              data={"items": items}, provenance="code", window=mw.label)]
        points = [p for p in (s.get("cost_over_time") or []) if isinstance(p, dict) and millis_to_iso(p.get("ts"))]
        if len(points) >= 2:
            artifacts.append(Artifact(
                id="a2", kind="series", title="AI spend over time", title_trusted=True,
                data={"x": [millis_to_iso(p["ts"]) for p in points], "unit": "usd", "bucket": "1h",
                      "series": [{"key": "cost", "label": "Spend", "values": [finite(p.get("cost")) for p in points]}]},
                provenance="code", window=mw.label,
            ))
        for key, title, dim in (("by_role", "Spend by AI role", "role"), ("by_model", "Spend by model", "model"),
                                ("by_surface", "Spend by surface", "surface")):
            rows = [r for r in (s.get(key) or []) if isinstance(r, dict)]
            if rows:
                artifacts.append(Artifact(
                    id=f"a{len(artifacts) + 1}", kind="categories", title=title, title_trusted=True,
                    data=categories([(r.get("key"), r.get("cost")) for r in rows], unit="usd", dimension=dim),
                    provenance="code", window=mw.label,
                ))
        observation: dict[str, Any] = {
            "case_id": args.case_id,
            "total_cost_usd": finite(s.get("total_cost")),
            "total_tokens": s.get("total_tokens"),
            "calls": s.get("call_count"),
            "today_cost_usd": finite(s.get("today_cost")),
            "by_role": _top_rows(s.get("by_role")),
            "by_model": _top_rows(s.get("by_model")),
            "by_surface": _top_rows(s.get("by_surface")),
            "simulated": simulated,
        }
        if budget is not None:
            observation["budget"] = {k: budget.get(k) for k in ("enabled", "on_exceed", "soft_warn_pct", "daily", "monthly")}
        observation["window"] = mw.label
        observation["window_clamped_to_request"] = mw.clamped
        if mw.relabelled:
            observation["requested_window"] = mw.requested
        summary = (f"AI spend ({mw.label}): ${finite(s.get('total_cost')) or 0:,.4f} over "
                   f"{fmt_int(s.get('call_count'))} calls, {fmt_int(s.get('total_tokens'))} tokens")
        if simulated:
            summary += " (simulated)"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact", coverage="; ".join(mw.notes()) or None,
                           untrusted_params={"case_id": args.case_id} if args.case_id else {})


__all__ = [
    "AGGREGATE_KINDS",
    "CASE_STORE_DOWN",
    "METRIC_KINDS",
    "CostUsageTool",
    "MetricWindow",
    "PREVIOUS_WINDOW_LABEL",
    "SocMetricsTool",
    "metric_window",
]
