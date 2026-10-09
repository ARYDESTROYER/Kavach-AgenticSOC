"""Metric tools: ``soc_metrics`` and ``cost_usage`` (chat revamp SPEC §5.3).

``soc_metrics`` reuses the SAME pure engine functions the Overview and Analytics
pages call (``engine.metrics``, ``engine.noise_counters``, ``engine.mitre_coverage``,
``engine.agent_improvement``) over the SAME shared newest-5,000 case page
(``api.metrics_shared.fetch_case_page``), so a chat answer and a dashboard tile can
never disagree. Every honesty flag those functions publish (``truncated``,
``window_covered``, ``open_now.complete``, ``counters.available``, insufficient
evidence) is passed through to the observation, and a value they mark "—" (not
measured) stays ``null`` — never a 0 (G3).

``cost_usage`` reads the usage ledger summary (exact aggregation) and, only for a
caller who also holds ``models:read`` (the meter rule of SPEC §8), the budget
status. Demo Mode costs are synthetic and labelled so.

Every number is labelled with the window it was COMPUTED over (§3.1, §4.3; G4):
:func:`metric_window` turns the effective window into the whole-hour span and end
instant the engine functions count back from, and the engine is called with that
end (``now=end``), so an absolute past chip is answered for that range rather than
for the trailing hours before now. Where a range cannot be honoured (longer than 30
days; ``cost_usage``, whose ledger summary only counts back from now) the label says
what was computed and the coverage says why. A case-store outage is reported as
"not measured", never as zero cases (G3).

Metrics are engine numbers and framework enums (#3-safe, advisory); the only
log-derived strings here are none, so the observation is mostly trusted data that
the engine still fences uniformly.
"""

from __future__ import annotations

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
    MAX_WINDOW_HOURS,
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
    window_label,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.metrics")

METRIC_KINDS: tuple[str, ...] = (
    "posture", "trends", "noise_funnel", "case_mix", "timing", "mitre_coverage",
    "auto_close_health", "agent_improvement", "feedback",
)
_KIND_ALIASES = {
    "noise": "noise_funnel", "noise_reduction": "noise_funnel", "funnel": "noise_funnel",
    "mix": "case_mix", "mttr": "timing", "mtta": "timing", "lifecycle": "timing",
    "mitre": "mitre_coverage", "coverage": "mitre_coverage", "auto_close": "auto_close_health",
    "improvement": "agent_improvement",
}
_BUCKET_ENUM = {60: "1h", 360: "6h", 1440: "1d"}
_SEVERITIES = ("critical", "high", "medium", "low", "info")
# Kinds computed ONLY from the case store: an outage fails them rather than
# publishing figures over zero rows (G3). ``noise_funnel`` keeps its counter stages
# and nulls its case stages instead.
_CASE_ONLY_KINDS = frozenset({
    "posture", "trends", "case_mix", "timing", "mitre_coverage", "auto_close_health",
    "agent_improvement", "feedback",
})
CASE_STORE_DOWN = "The case store did not answer, so case figures were not measured"
# An end this close to now is "now" (a chip whose ``to`` was resolved a moment ago).
_TRAILING_TOLERANCE = timedelta(seconds=60)


# --------------------------------------------------------------------------- #
# The window a metric is actually computed over.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class MetricWindow:
    """What the engine functions are asked for, and its honest caption.

    ``hours`` is the whole-hour span counted back from ``end`` (the instant passed
    as the engine's ``now``); ``now`` is the real measurement instant (open cases,
    SLA clocks). ``label`` describes exactly ``[end - hours, end]``; ``requested``
    is the effective window's own label, which differs when the span was capped at
    30 days (``capped``) or narrowed to whole hours."""

    hours: int
    end: datetime
    now: datetime
    trailing: bool
    label: str
    requested: str
    capped: bool
    clamped: bool

    @property
    def start(self) -> datetime:
        return self.end - timedelta(hours=self.hours)

    @property
    def relabelled(self) -> bool:
        return self.label != self.requested

    def notes(self) -> list[str]:
        """Engine-template coverage notes for a window that differs from the ask."""
        notes: list[str] = []
        if self.capped:
            notes.append(f"the selected range is longer than {MAX_WINDOW_HOURS // 24} days; "
                         f"figures cover the {MAX_WINDOW_HOURS // 24} days ending at its end")
        elif self.relabelled:
            notes.append("the range was narrowed to whole hours")
        if self.clamped:
            notes.append("window limited to the selected range")
        return notes


def _span_label(hours: int) -> str:
    return f"last {hours // 24}d" if hours % 24 == 0 else f"last {hours}h"


def metric_window(window: Window, now: datetime) -> MetricWindow:
    """The window an engine function that counts ``window_hours`` back from an
    instant really covers: the span narrowed to whole hours (never widened beyond
    what was selected, §4.8.4, except a sub-hour range, which reads one hour) and
    capped at 30 days, ending where the effective window ends. The label is the
    effective window's own label only when the two coincide."""
    span = (window.end - window.start).total_seconds() / 3600
    whole = max(1, math.floor(span + 1e-6))
    capped = whole > MAX_WINDOW_HOURS
    hours = min(whole, MAX_WINDOW_HOURS)
    trailing = window.trailing or abs(now - window.end) <= _TRAILING_TOLERANCE
    end = window.end
    start = end - timedelta(hours=hours)
    if abs((start - window.start).total_seconds()) < 1:
        label = window.label
    elif trailing:
        label = _span_label(hours)
    else:
        label = window_label("", "", start, end)
    return MetricWindow(
        hours=hours, end=end, now=now, trailing=trailing, label=label,
        requested=window.label, capped=capped, clamped=window.clamped,
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


class SocMetricsInput(ToolInput):
    kind: Literal[METRIC_KINDS]  # type: ignore[valid-type]
    window_hours: int | None = Field(default=None, ge=1, le=720)
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


#: Each period-over-period figure of the posture rollup (``engine.metrics``
#: ``compare``): the unit its KPI tile shows, and that unit's name for a change.
#: Rates are 0..1 ratios shown in percent, so they move by percentage points;
#: lifecycle percentiles are minutes end to end.
_COMPARE_UNITS: dict[str, tuple[str, str]] = {
    "case_count": ("count", "cases"),
    "false_positive_rate": ("percent", "percentage points"),
    "automation_rate": ("percent", "percentage points"),
    "escalation_rate": ("percent", "percentage points"),
    "alert_to_incident_ratio": ("percent", "percentage points"),
    "mttr_p50": ("minutes", "minutes"),
    "mtta_p50": ("minutes", "minutes"),
}


def _change(entry: Any, unit: str) -> float | None:
    """The change from the previous window to this one IN THE TILE'S UNIT (a count by
    a count, a ``percent`` rate by percentage points, a duration by minutes);
    ``None`` when either side is not measured (G3)."""
    if not isinstance(entry, dict):
        return None
    current, previous = finite(entry.get("value")), finite(entry.get("prev"))
    if current is None or previous is None:
        return None
    return round((current - previous) * (100 if unit == "percent" else 1), 2)


def _delta(compare: dict[str, Any], key: str, good: str) -> dict[str, Any] | None:
    """A KPI's change versus the previous window, IN THE ITEM'S OWN UNIT (the client
    formats a delta with the tile's unit, BLOCKS.md ``KpiItem.delta``). Never the
    relative ``delta_pct``: "+25" next to a count of cases must mean 25 cases, not
    25 %. The observation carries the same figure (:func:`_compare_observation`)."""
    entry = compare.get(key) if isinstance(compare, dict) else None
    change = _change(entry, _COMPARE_UNITS.get(key, ("count", ""))[0])
    if change is None:
        return None
    return {"value": change, "period_label": PREVIOUS_WINDOW_LABEL, "good_direction": good}


def _compare_observation(compare: dict[str, Any]) -> dict[str, Any]:
    """``compare_previous`` for the model, carrying the change each KPI tile shows.

    ``value``/``prev`` stay as the rollup holds them (rates as 0..1 ratios, like
    ``quality``); ``change`` is the tile's own delta in ``change_unit`` (cases,
    percentage points, minutes), so the prose can state exactly the figure the tile
    shows. The engine's relative ``delta_pct`` is renamed ``relative_change_pct``:
    it is a percent OF the previous value, never the tile's change."""
    out: dict[str, Any] = {"period_label": PREVIOUS_WINDOW_LABEL}
    for key, entry in compare.items():
        if not isinstance(entry, dict):
            continue
        unit, change_unit = _COMPARE_UNITS.get(key, ("count", ""))
        relative = finite(entry.get("delta_pct"))
        out[key] = {
            "value": finite(entry.get("value")), "prev": finite(entry.get("prev")),
            "change": _change(entry, unit), "change_unit": change_unit or None,
            "relative_change_pct": relative,
        }
    return out


class SocMetricsTool(ChatTool):
    name: ClassVar[str] = "soc_metrics"
    label: ClassVar[str] = "Read SOC metrics"
    scope: ClassVar[str] = "metrics"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("metrics", "view"),)
    data_source: ClassVar[str] = "Dashboard metrics (deterministic)"
    signature: ClassVar[str] = (
        "soc_metrics(kind=posture|trends|noise_funnel|case_mix|timing|mitre_coverage|auto_close_health|"
        "agent_improvement|feedback, window_hours?=24, compare_previous?) -- deterministic SOC analytics "
        "with their completeness flags"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("kind", "window_hours", "compare_previous")

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(SocMetricsInput, inp)
        if error is not None:
            return error
        ref = datetime.now(timezone.utc)
        window = resolve_window(ctx, window_hours=args.window_hours, default_hours=24, now=ref)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        mw = metric_window(window, ref)
        cases, store_total, load_ok = await load_case_page(ctx)
        if not load_ok and args.kind in _CASE_ONLY_KINDS:
            # An outage is not an empty store: no figure is published over zero rows.
            outcome = ToolOutcome.failure(CASE_STORE_DOWN)
            outcome.observation = {"kind": args.kind, "case_store_unavailable": True}
            return outcome
        handler = getattr(self, f"_{args.kind}")
        outcome: ToolOutcome = await handler(ctx, args, mw, cases, store_total, load_ok)
        if outcome.ok:
            label = outcome.observation.get("window") or mw.label
            outcome.observation = {"kind": args.kind, "window": label, **outcome.observation}
            notes: list[str] = []
            if outcome.observation.pop("_window_applies", True):
                # Like the log tools: the request's time chip narrowed the window the
                # model asked for. A structured flag, so nobody has to compare labels.
                outcome.observation["window_clamped_to_request"] = mw.clamped
                if mw.relabelled:
                    outcome.observation["requested_window"] = mw.requested
                if mw.capped:
                    outcome.observation["window_capped"] = True
                notes.extend(mw.notes())
            if not load_ok:
                outcome.observation["case_store_unavailable"] = True
                notes.append("case store did not answer; case-based figures are not measured")
            elif store_total > len(cases) and outcome.coverage is None:
                notes.append(f"newest {fmt_int(len(cases))} of {fmt_int(store_total)} cases read")
            if outcome.coverage:
                notes.insert(0, outcome.coverage)
            outcome.coverage = "; ".join(dict.fromkeys(notes)) or None
            for artifact in outcome.artifacts:
                artifact.window = artifact.window or label
        return outcome

    async def _posture_rollup(
        self, ctx: ChatToolContext, mw: MetricWindow, cases: list[Any], store_total: int, load_ok: bool,
        *, compare: bool = False,
    ) -> dict[str, Any]:
        """``posture_metrics`` over exactly the metric window.

        For a past range the cohort is ``[start, end)``, counted back from its end;
        the two STOCK figures are then re-measured at the real instant:
        ``open_now`` (every open case now, over the whole fetched page) and the SLA
        clocks of the cohort's still-open cases (which run until now, not until the
        window end)."""
        from ...engine.metrics import _window_filter, open_case_count, posture_metrics, sla_metrics

        bounded, dropped = _bounded(cases, mw)
        policy = getattr(ctx.prefs, "sla", None)
        p = posture_metrics(
            bounded, sla_policy=policy, window_hours=mw.hours, now=mw.end,
            compare="prev" if compare else "", store_total=max(len(bounded), store_total - dropped),
            prefs=ctx.prefs, load_ok=load_ok,
        )
        if not mw.trailing:
            truncated = store_total > len(cases)
            p["open_now"] = {
                "count": open_case_count(cases), "window_exempt": True, "as_of": mw.now.isoformat(),
                "complete": load_ok and not truncated,
                "reason": "" if load_ok and not truncated else (
                    "the store held more cases than were fetched, so open cases older than "
                    "the fetched rows are not counted; this is a lower bound"),
            }
            cohort = _window_filter(bounded, window_hours=mw.hours, now=mw.end)
            p["sla"] = sla_metrics(cohort, policy, now=mw.now)
        return p

    # -- posture ----------------------------------------------------------- #
    async def _posture(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import compute_metrics

        p = await self._posture_rollup(ctx, mw, cases, store_total, load_ok, compare=args.compare_previous)
        # A STOCK over every fetched case (active cases now), never windowed.
        overall = compute_metrics(cases, total_cases=store_total)
        quality = p.get("quality") or {}
        lifecycle = p.get("lifecycle") or {}
        open_now = p.get("open_now") or {}
        compare = p.get("compare") or {}
        risk_index = finite(overall.get("active_risk_index"))
        items = [
            kpi("active_risk_index", "Active Risk Index", risk_index, "score", display="gauge",
                context=f"{fmt_int(overall.get('active_risk_case_count'))} active cases now"),
            kpi("cases", "Cases", p.get("case_count"), delta=_delta(compare, "case_count", "none")),
            kpi("open_now", "Open now", open_now.get("count"), bound=not open_now.get("complete", True),
                context="not windowed"),
            kpi("fp_rate", "False-positive rate", ratio_to_pct(quality.get("false_positive_rate")), "percent",
                delta=_delta(compare, "false_positive_rate", "down")),
            kpi("automation_rate", "Automation rate", ratio_to_pct(quality.get("automation_rate")), "percent",
                delta=_delta(compare, "automation_rate", "up")),
            # Lifecycle percentiles are minutes end to end (engine.metrics
            # ``lifecycle_intervals``): the tile says so, and a 0-minute median is 0 min.
            kpi("mttr_p50", "MTTR (median)", _minutes(lifecycle.get("mttr_minutes")), "minutes",
                delta=_delta(compare, "mttr_p50", "down")),
        ]
        sev = p.get("severity_counts") or {}
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Security posture", title_trusted=True,
                     data={"items": items}, provenance="code",
                     truncated=not p.get("window_covered", True), total=p.get("case_count")),
            Artifact(id="a2", kind="categories", title="Cases by severity", title_trusted=True,
                     data=categories([(b, sev.get(b, 0)) for b in _SEVERITIES], dimension="severity"),
                     provenance="code", total=p.get("case_count")),
        ]
        observation = {
            "active_risk_index": risk_index,
            "active_risk_index_scope": "active cases now (not windowed)",
            "case_count": p.get("case_count"),
            "severity_counts": sev,
            "open_now": {k: open_now.get(k) for k in ("count", "complete", "reason", "as_of", "window_exempt")},
            "lifecycle_minutes": {
                name: {"p50": _minutes(stat), "p90": _minutes(stat, "p90"),
                       "measured": bool(isinstance(stat, dict) and stat.get("available")),
                       "reason": (stat or {}).get("reason") or None}
                for name, stat in lifecycle.items() if isinstance(stat, dict)
            },
            "quality": {k: quality.get(k) for k in (
                "total_cases", "terminal_cases", "auto_closed_cases", "human_closed_cases",
                "system_closed_cases", "policy_closed_cases", "false_positive_rate",
                "automation_rate", "escalation_rate", "alert_to_incident_ratio")},
            "sla": {k: (p.get("sla") or {}).get(k) for k in (
                "enabled", "evaluated", "response_breached", "resolve_breached", "attainment_pct")},
            "completeness": {k: p.get(k) for k in (
                "truncated", "store_total", "fetched", "window_covered", "window_coverage_reason")},
        }
        if compare:
            observation["compare_previous"] = _compare_observation(compare)
        summary = (
            f"Posture ({mw.label}): {fmt_int(p.get('case_count'))} cases, "
            f"{fmt_int(open_now.get('count'))} open now, FP rate {fmt_pct(quality.get('false_positive_rate'), ratio=True)}, "
            f"Active Risk Index {fmt_int(risk_index)}"
        )
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact" if p.get("window_covered") else "sample")

    # -- trends ------------------------------------------------------------ #
    async def _trends(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import trend_metrics

        hours = mw.hours
        counters = None
        if ctx.noise is not None:
            try:
                counters = await ctx.noise.read_hourly_ingested(hours + 24, now=mw.end)
            except Exception as exc:  # noqa: BLE001 — degrade to null alerts
                logger.info("trend counters unavailable: %s", exc)
        # The engine's newest bucket is the one that CONTAINS ``now`` (the partial
        # current hour of a trailing window). For a past range that bucket starts at
        # the range end, so it is dropped, and the page is bounded so a case created
        # after the end can never land in the last kept bucket.
        bounded, dropped = _bounded(cases, mw)
        t = trend_metrics(bounded, window_hours=hours, now=mw.end,
                          store_total=max(len(bounded), store_total - dropped), alert_counters=counters)
        buckets = [b for b in (t.get("buckets") or []) if isinstance(b, dict)]
        if not mw.trailing:
            buckets = [b for b in buckets if _before(b.get("t"), mw.end)]
        x = [str(b.get("t")) for b in buckets]
        bucket = _BUCKET_ENUM.get(int(t.get("bucket_minutes") or 0))

        def series(key: str) -> list[Any]:
            return [finite(b.get(key)) if b.get(key) is not None else None for b in buckets]

        base = {"x": x, "unit": "count", "last_in_progress": mw.trailing}
        if bucket:
            base["bucket"] = bucket
        artifacts = [Artifact(
            id="a1", kind="series", title="Cases over time", title_trusted=True,
            data={**base, "series": [
                {"key": "new_cases", "label": "New cases", "values": series("new_cases")},
                {"key": "closed", "label": "Closed", "values": series("closed")},
                {"key": "auto_closed", "label": "Auto-closed", "values": series("auto_closed")},
                {"key": "escalated", "label": "Escalated", "values": series("escalated")},
            ]},
            provenance="code", truncated=bool(t.get("truncated")),
        )]
        alerts = series("alerts")
        if any(v is not None for v in alerts):
            artifacts.append(Artifact(
                id="a2", kind="series", title="Alerts ingested over time", title_trusted=True,
                data={**base, "series": [{"key": "alerts", "label": "Alerts", "values": alerts}]},
                provenance="code",
            ))
        fp = series("fp_rate")
        if any(v is not None for v in fp):
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="series", title="False-positive rate over time",
                title_trusted=True,
                data={**base, "unit": "percent", "series": [{"key": "fp_rate", "label": "FP rate", "values": fp}]},
                provenance="code",
            ))
        observation = {
            "bucket_minutes": t.get("bucket_minutes"),
            "first_bucket": x[0] if x else None,
            "new_cases": series("new_cases"),
            "closed": series("closed"),
            "auto_closed": series("auto_closed"),
            "escalated": series("escalated"),
            "alerts": alerts,
            "fp_rate_percent": fp,
            "completeness": {k: t.get(k) for k in ("truncated", "store_total", "fetched")},
        }
        total_new = sum(v or 0 for v in series("new_cases"))
        summary = (f"Trends ({mw.label}, {fmt_int(len(x))} buckets): {fmt_int(total_new)} new cases, "
                   f"{fmt_int(sum(v or 0 for v in series('closed')))} closed")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="sample" if t.get("truncated") else "exact")

    # -- noise funnel ------------------------------------------------------ #
    async def _noise_funnel(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.noise_counters import build_noise_reduction

        hours = mw.hours
        counters: dict[str, Any] = {"available": False}
        if ctx.noise is not None:
            try:
                # A past range is the exact ``[end - hours, end)``; a trailing one keeps
                # the dashboard's "include the current hour" read.
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
        if load_ok:
            summary = (f"Noise funnel ({mw.label}): {fmt_int(total('ingested'))} alerts ingested -> "
                       f"{fmt_int(total('cases'))} cases -> {fmt_int(total('needs_human'))} needing a human")
        else:
            summary = (f"Noise funnel ({mw.label}): {fmt_int(total('ingested'))} alerts ingested; "
                       "case stages not measured (the case store did not answer)")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact")

    # -- case mix ---------------------------------------------------------- #
    async def _case_mix(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import _window_filter, compute_metrics

        bounded, _dropped = _bounded(cases, mw)
        windowed = _window_filter(bounded, window_hours=mw.hours, now=mw.end)
        m = compute_metrics(windowed, total_cases=len(windowed))
        by_verdict = {k: v for k, v in (m.get("by_verdict") or {}).items() if v}
        by_status = m.get("by_status") or {}
        by_disp = m.get("by_disposition") or {}
        artifacts = [
            Artifact(id="a1", kind="kpis", title="Case mix", title_trusted=True, data={"items": [
                kpi("cases", "Cases", m.get("total_cases")),
                kpi("closed", "Closed", m.get("closed_cases")),
                kpi("avg_risk", "Average risk", finite(m.get("avg_risk_score")), "score"),
                kpi("active_risk_index", "Active Risk Index", finite(m.get("active_risk_index")), "score", display="gauge"),
            ]}, provenance="code"),
            Artifact(id="a2", kind="categories", title="Cases by verdict", title_trusted=True,
                     data=categories(list(by_verdict.items()), dimension="verdict"), provenance="code"),
            Artifact(id="a3", kind="categories", title="Cases by status", title_trusted=True,
                     data=categories(list(by_status.items()), dimension="status"), provenance="code"),
            Artifact(id="a4", kind="categories", title="Cases by disposition", title_trusted=True,
                     data=categories(list(by_disp.items()), dimension="disposition"), provenance="code"),
        ]
        observation = {
            "cases": m.get("total_cases"), "by_verdict": by_verdict, "by_status": by_status,
            "by_disposition": by_disp, "avg_risk_score": m.get("avg_risk_score"),
            "active_risk_index": m.get("active_risk_index"),
            "completeness": {"store_total": store_total, "fetched": len(cases),
                             "truncated": store_total > len(cases)},
        }
        summary = f"Case mix ({mw.label}): {fmt_int(m.get('total_cases'))} cases across {len(by_verdict)} verdicts"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="sample" if store_total > len(cases) else "exact")

    # -- timing ------------------------------------------------------------ #
    async def _timing(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import _window_filter, timing_trend

        p = await self._posture_rollup(ctx, mw, cases, store_total, load_ok)
        life = p.get("lifecycle") or {}
        items = [
            kpi("mttd_p50", "MTTD (median)", _minutes(life.get("mttd_minutes")), "minutes"),
            kpi("mtta_p50", "MTTA (median)", _minutes(life.get("mtta_minutes")), "minutes"),
            kpi("mttr_p50", "MTTR (median)", _minutes(life.get("mttr_minutes")), "minutes"),
            kpi("dwell_p50", "Dwell (median)", _minutes(life.get("dwell_minutes")), "minutes"),
            kpi("mtta_p90", "MTTA (p90)", _minutes(life.get("mtta_minutes"), "p90"), "minutes"),
            kpi("mttr_p90", "MTTR (p90)", _minutes(life.get("mttr_minutes"), "p90"), "minutes"),
        ]
        # The per-day trend of the SAME cohort, kept to the days inside the window (an
        # interval is dated by the day it completed), so the chart and the tiles
        # describe one population and one range.
        bounded, _dropped = _bounded(cases, mw)
        cohort = _window_filter(bounded, window_hours=mw.hours, now=mw.end)
        first_day, last_day = mw.start.date().isoformat(), mw.end.date().isoformat()
        trend = [t for t in timing_trend(cohort, trend_days=31)
                 if isinstance(t, dict) and t.get("date") and first_day <= str(t["date"]) <= last_day]
        artifacts = [Artifact(id="a1", kind="kpis", title="Response times", title_trusted=True,
                              data={"items": items}, provenance="code")]
        if len(trend) >= 2:
            artifacts.append(Artifact(
                id="a2", kind="series", title="Response times by day", title_trusted=True,
                data={"x": [f"{t['date']}T00:00:00+00:00" for t in trend], "unit": "minutes", "bucket": "1d",
                      "series": [
                          {"key": "mttd", "label": "Detect", "values": [finite(t.get("mttd")) for t in trend]},
                          {"key": "respond", "label": "Respond", "values": [finite(t.get("respond")) for t in trend]},
                          {"key": "resolve", "label": "Resolve", "values": [finite(t.get("resolve")) for t in trend]},
                      ]},
                provenance="code",
            ))
        observation = {
            "lifecycle_minutes": {
                name: {"p50": _minutes(stat), "p90": _minutes(stat, "p90"), "count": stat.get("count"),
                       "measured": bool(stat.get("available")), "reason": stat.get("reason") or None}
                for name, stat in life.items() if isinstance(stat, dict)
            },
            "completeness": {k: p.get(k) for k in ("truncated", "window_covered", "window_coverage_reason")},
        }
        summary = (f"Response times ({mw.label}): MTTA median "
                   f"{fmt_int(_minutes(life.get('mtta_minutes')))} min, MTTR median "
                   f"{fmt_int(_minutes(life.get('mttr_minutes')))} min")
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact")

    # -- MITRE coverage ---------------------------------------------------- #
    async def _mitre_coverage(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import _window_filter
        from ...engine.mitre_coverage import compute_mitre_coverage

        all_time = args.window_hours is None and ctx.time_range is None
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
        label = "all fetched cases" if all_time else mw.label
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
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact")

    # -- auto-close health ------------------------------------------------- #
    async def _auto_close_health(self, ctx, args, mw: MetricWindow, cases, store_total, load_ok) -> ToolOutcome:
        from ...engine.metrics import auto_close_health

        # Decisions are tallied on ``[end - hours, end)`` (both sides bounded).
        a = auto_close_health(cases, window_hours=mw.hours, now=mw.end,
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
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact")

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
        for key, row in list(metrics.items())[:8]:
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
        # window_hours do not apply, and the label says so instead of borrowing theirs.
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
        if args.window_hours is not None or ctx.time_range is not None:
            coverage = "fixed comparison windows; the selected range does not apply"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact", coverage=coverage)

    # -- feedback ---------------------------------------------------------- #
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
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts, basis="exact")


# --------------------------------------------------------------------------- #
# cost_usage
# --------------------------------------------------------------------------- #
class CostUsageInput(ToolInput):
    window_hours: int | None = Field(default=None, ge=1, le=720)
    case_id: str | None = Field(default=None, max_length=128)

    @field_validator("window_hours", "case_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        return none_if_blank(value)


def _top_rows(rows: Any, n: int = 5) -> list[dict[str, Any]]:
    out = []
    for row in (rows or [])[:n]:
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
    signature: ClassVar[str] = (
        "cost_usage(window_hours?=24, case_id?) -- AI spend, tokens and calls by role, model and surface "
        "over time, plus today's budget"
    )
    display_keys: ClassVar[tuple[str, ...]] = ("window_hours", "case_id")

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(CostUsageInput, inp)
        if error is not None:
            return error
        if ctx.usage is None:
            return ToolOutcome.failure("The usage ledger is not available")
        ref = datetime.now(timezone.utc)
        resolved = resolve_window(ctx, window_hours=args.window_hours, default_hours=24, now=ref)
        if isinstance(resolved, str):
            return ToolOutcome.failure(resolved)
        window = metric_window(resolved, ref)
        if not window.trailing:
            # The ledger summary only counts back from now. Showing the trailing hours
            # under a past range's label would be wrong, and showing them under their
            # own label would read data outside the selected range (§4.8.4).
            return ToolOutcome.failure(
                "AI spend can only be read for a window that ends now; the selected range ends in the past"
            )
        try:
            s = await ctx.usage.summary(window_hours=window.hours, case_id=args.case_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("cost_usage summary failed: %s", exc)
            return ToolOutcome.failure("The usage ledger did not answer")
        budget = None
        if ctx.has("models", "read") and ctx.budget_gate is not None:
            try:
                budget = await ctx.budget_gate.status()
            except Exception as exc:  # noqa: BLE001 — budget is an optional extra
                logger.info("budget status unavailable: %s", exc)
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
                              data={"items": items}, provenance="code", window=window.label)]
        points = [p for p in (s.get("cost_over_time") or []) if isinstance(p, dict) and millis_to_iso(p.get("ts"))]
        if len(points) >= 2:
            artifacts.append(Artifact(
                id="a2", kind="series", title="AI spend over time", title_trusted=True,
                data={"x": [millis_to_iso(p["ts"]) for p in points], "unit": "usd", "bucket": "1h",
                      "series": [{"key": "cost", "label": "Spend", "values": [finite(p.get("cost")) for p in points]}]},
                provenance="code", window=window.label,
            ))
        for key, title, dim in (("by_role", "Spend by AI role", "role"), ("by_model", "Spend by model", "model"),
                                ("by_surface", "Spend by surface", "surface")):
            rows = [r for r in (s.get(key) or []) if isinstance(r, dict)]
            if rows:
                artifacts.append(Artifact(
                    id=f"a{len(artifacts) + 1}", kind="categories", title=title, title_trusted=True,
                    data=categories([(r.get("key"), r.get("cost")) for r in rows], unit="usd", dimension=dim),
                    provenance="code", window=window.label,
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
        observation["window"] = window.label
        observation["window_clamped_to_request"] = window.clamped
        if window.relabelled:
            observation["requested_window"] = window.requested
        summary = (f"AI spend ({window.label}): ${finite(s.get('total_cost')) or 0:,.4f} over "
                   f"{fmt_int(s.get('call_count'))} calls, {fmt_int(s.get('total_tokens'))} tokens")
        if simulated:
            summary += " (simulated)"
        return ToolOutcome(ok=True, summary=summary, observation=observation, artifacts=artifacts,
                           basis="exact", coverage="; ".join(window.notes()) or None,
                           untrusted_params={"case_id": args.case_id} if args.case_id else {})


__all__ = ["CASE_STORE_DOWN", "METRIC_KINDS", "CostUsageTool", "MetricWindow", "SocMetricsTool", "metric_window"]
