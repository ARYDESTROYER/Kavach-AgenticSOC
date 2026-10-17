"""``case_stats``: exact counts and breakdowns over EVERY case (Round 12 SPEC D8,
§3.5, SYNTHESIS-chat P0-4/P0-5/P0-6).

The tool answers "how many", "by month", "by severity", "who closed the most",
"FP rate by rule", "this quarter versus last" over the whole case store, with no
sample and no 5,000-case page: it hands :func:`app.engine.case_aggregate.aggregate_cases`
a :class:`~app.engine.case_aggregate.CaseAggregateSpec` (store push-down where the
backend can, else a streaming fold that keeps only counters) and turns the
:class:`~app.engine.case_aggregate.AggregateResult` into

* an observation of AGGREGATES only (totals, group counts, bucket counts and the
  requested metrics; never a case document, #7);
* artifacts: ``kpis`` (the headline figures), ``series`` (calendar buckets, zero
  filled, the current period flagged in progress), ``categories`` (one grouping) or
  a ``table`` (two groupings, or every metric per group), and a ``comparison`` when
  ``compare`` is set. Every caption states the count and its basis
  ("6,438 cases · exact").

Windows (SPEC D7): no window means ALL TIME; ``window`` takes ``now-90d``, ``now-6M``,
calendar periods (``last_month``, ``this_quarter``, ``ytd``…) in the operator
timezone, and ISO ranges, of any length; ``window_hours`` stays as an alias. The
request's time chip still clamps (an "All time" chip never does). A relative window of
days, weeks, months or years is aligned to whole periods of its own unit BEFORE anything
is counted, broken down or not (:func:`common.whole_periods`): "the last 6 months" is
May to October, the last month in progress, "the last 90 days" today and the 89 days
before it, and the total, the series, the bucket labels, the groups and the compared
periods all cover that one window, the same one every other lookup of it in the answer
counts (Round 12 SPEC §7.2 decision 28).

A store failure mid-scan is a PARTIAL result (``exact: false``): the counted share is
stated, never a smaller number presented as exact. Group values from rules, assignees,
sources and ATT&CK ids are case/log-derived and stay untrusted (fenced for the model,
untrusted labels on artifacts, #9).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, ClassVar, Literal

from pydantic import Field, field_validator

from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .cases import _DECIDED_BY_LABELS, _STATUS_LABELS, _VERDICT_LABELS, CaseFilters
from .common import (
    Window,
    align_to_bucket,
    categories,
    column,
    finite,
    fmt_int,
    kpi,
    parse_input,
    resolve_window,
    text,
    visible_text,
    whole_periods,
)
from .periods import (
    Period,
    comparison_caption,
    comparison_data,
    comparison_observation,
    comparison_row,
    normalise_compare,
    resolve_periods,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.stats")

#: The long per-call budget of an aggregate tool (SPEC P0-4): a full-population scan
#: of a large store may take minutes; Stop still cancels it at once.
AGGREGATE_TOOL_TIMEOUT_S = 600

GROUP_FIELDS: tuple[str, ...] = (
    "verdict", "status", "status_group", "severity", "priority", "rule", "assignee", "source",
    "surface", "disposition", "mitre_tactic", "mitre_technique", "decided_by", "closed_by",
)
BUCKETS: tuple[str, ...] = ("hour", "day", "week", "month", "quarter", "year")
METRICS: tuple[str, ...] = (
    "count", "auto_closed", "human_closed", "fp_rate", "tp_rate", "analyst_fp",
    "mtta_p50", "mtta_p90", "mttr_p50", "mttr_p90", "mttd_p50", "mttd_p90", "mean_risk", "open_now",
)
MAX_GROUP_BY = 2
MAX_METRICS = 6
MAX_TOP_N = 50
# Grouped values a case/log/LLM wrote (never an engine enum): untrusted labels (#9).
UNTRUSTED_GROUPS = frozenset({"rule", "assignee", "source", "surface", "mitre_tactic", "mitre_technique", "closed_by"})

_GROUP_ALIASES = {
    # "user" is NOT an alias: in a SOC it means the affected user entity, which cases are
    # not grouped by; it is refused with the accepted groupings instead of silently
    # becoming the analyst assignment.
    "analyst": "assignee", "owner": "assignee", "assigned_to": "assignee",
    "rule_id": "rule", "rules": "rule", "rule_ids": "rule", "detection": "rule",
    "technique": "mitre_technique", "techniques": "mitre_technique", "mitre": "mitre_technique",
    "tactic": "mitre_tactic", "tactics": "mitre_tactic",
    "decision_by": "decided_by", "decider": "decided_by", "closer": "closed_by", "closed_by_user": "closed_by",
    "source_name": "source", "source_id": "source", "data_source": "source", "source_surface": "surface",
    "state": "status", "lifecycle": "status", "open_closed": "status_group", "outcome": "disposition",
    "classification": "disposition", "band": "severity",
}
# A grouping by creation time is a bucket, not a field.
_BUCKET_ALIASES = {
    "hourly": "hour", "1h": "hour", "hours": "hour", "created_hour": "hour",
    "daily": "day", "1d": "day", "days": "day", "date": "day", "created_day": "day", "by_day": "day",
    "weekly": "week", "1w": "week", "weeks": "week", "created_week": "week", "by_week": "week",
    "monthly": "month", "months": "month", "created_month": "month", "by_month": "month",
    "month_wise": "month", "monthwise": "month",
    "quarterly": "quarter", "1q": "quarter", "quarters": "quarter", "created_quarter": "quarter",
    "yearly": "year", "annual": "year", "annually": "year", "1y": "year", "years": "year", "created_year": "year",
}
_METRIC_ALIASES = {
    "total": "count", "cases": "count", "number": "count", "volume": "count",
    "fp": "fp_rate", "false_positive_rate": "fp_rate", "tp": "tp_rate", "true_positive_rate": "tp_rate",
    "auto_close": "auto_closed", "auto_closes": "auto_closed", "automation": "auto_closed",
    "human_close": "human_closed", "closed_by_human": "human_closed",
    "analyst_confirmed_fp": "analyst_fp", "confirmed_fp": "analyst_fp",
    "mtta": "mtta_p50", "mttr": "mttr_p50", "mttd": "mttd_p50",
    "avg_risk": "mean_risk", "risk": "mean_risk", "average_risk": "mean_risk",
    "open": "open_now", "still_open": "open_now",
}
_METRIC_LABELS = {
    "count": "Cases", "auto_closed": "Auto-closed", "human_closed": "Closed by an analyst",
    "fp_rate": "False-positive rate", "tp_rate": "True-positive rate",
    "analyst_fp": "Confirmed false positives", "mtta_p50": "MTTA (median)", "mtta_p90": "MTTA (p90)",
    "mttr_p50": "MTTR (median)", "mttr_p90": "MTTR (p90)", "mttd_p50": "MTTD (median)",
    "mttd_p90": "MTTD (p90)", "mean_risk": "Average risk", "open_now": "Still open",
}
# ``open_now`` is a STOCK in totals and in un-bucketed rows (every matching case open
# now, whenever it was created, not limited to the window) and a cohort figure in a
# bucketed row (the cases opened in that period that are still open).
OPEN_NOW_STOCK_LABEL = "Open now (any creation date)"
OPEN_NOW_COHORT_LABEL = "Still open (opened in period)"
OPEN_NOW_NOTE = (
    "open_now counts every matching case that is open now, whenever it was created: it is "
    "not limited to the window, so never present it as a share of the window's cases"
)
OPEN_NOW_BUCKET_NOTE = "in a bucketed row, open_now is the cases opened in that period that are still open"
#: A chart draws at most this many points (SPEC P0-5): a finer bucket is coarsened.
MAX_SERIES_POINTS = 200
_METRIC_UNITS = {
    "count": "count", "auto_closed": "count", "human_closed": "count", "analyst_fp": "count",
    "open_now": "count", "fp_rate": "percent", "tp_rate": "percent", "mean_risk": "score",
    "mtta_p50": "minutes", "mtta_p90": "minutes", "mttr_p50": "minutes", "mttr_p90": "minutes",
    "mttd_p50": "minutes", "mttd_p90": "minutes",
}
_GOOD = {"fp_rate": "down", "mtta_p50": "down", "mtta_p90": "down", "mttr_p50": "down",
         "mttr_p90": "down", "mttd_p50": "down", "mttd_p90": "down", "open_now": "down",
         "auto_closed": "up", "tp_rate": "none"}
_GROUP_TITLES = {
    "verdict": "Cases by verdict", "status": "Cases by status", "status_group": "Open and closed cases",
    "severity": "Cases by severity", "priority": "Cases by priority", "rule": "Cases by rule",
    "assignee": "Cases by assignee", "source": "Cases by source", "surface": "Cases by surface",
    "disposition": "Cases by disposition", "mitre_tactic": "Cases by ATT&CK tactic",
    "mitre_technique": "Cases by ATT&CK technique", "decided_by": "Cases by decision maker",
    "closed_by": "Cases by who closed them",
}
_GROUP_DIMENSIONS = {
    "verdict": "Verdict", "status": "Status", "status_group": "Open or closed", "severity": "Severity",
    "priority": "Priority", "rule": "Rule", "assignee": "Assignee", "source": "Source",
    "surface": "Surface", "disposition": "Disposition", "mitre_tactic": "Tactic",
    "mitre_technique": "Technique", "decided_by": "Decided by", "closed_by": "Closed by",
}
_BUCKET_TITLES = {
    "hour": "Cases by hour", "day": "Cases by day", "week": "Cases by week",
    "month": "Cases by month", "quarter": "Cases by quarter", "year": "Cases by year",
}
_BUCKET_ENUM = {"hour": "1h", "day": "1d", "week": "1w", "month": "1M", "quarter": "1q", "year": "1y"}
_MAX_SERIES = 7
_OBS_GROUPS = 400


def _key(value: Any) -> str:
    return str(value).strip().lower().replace("-", "_").replace(" ", "_") if isinstance(value, str) else ""


class CaseStatsInput(CaseFilters):
    # Up to two fields plus a creation-time bucket ("month"); split_buckets checks.
    group_by: list[str] = Field(default_factory=list, max_length=MAX_GROUP_BY + 1)
    bucket: Literal["none", "auto", "hour", "day", "week", "month", "quarter", "year"] = "none"
    metrics: list[Literal[METRICS]] = Field(default_factory=lambda: ["count"], max_length=MAX_METRICS)  # type: ignore[valid-type]
    top_n: int | None = Field(default=None, ge=1, le=MAX_TOP_N)
    compare: Any = None

    @field_validator("group_by", mode="before")
    @classmethod
    def _group_by(cls, value: Any) -> Any:
        if value in (None, "", []):
            return []
        if isinstance(value, str):
            value = [v for v in value.replace(";", ",").split(",")]
        if not isinstance(value, (list, tuple)):
            return value
        out: list[str] = []
        for item in value:
            # "1M" is a calendar month ("1m" would be a minute, which cases do not bucket by).
            key = "month" if isinstance(item, str) and item.strip() == "1M" else _key(item)
            key = _GROUP_ALIASES.get(key, key)
            if key and key not in out:
                out.append(key)
        return out

    @field_validator("bucket", mode="before")
    @classmethod
    def _bucket(cls, value: Any) -> Any:
        if value in (None, "", False):
            return "none"
        if isinstance(value, str):
            key = value.strip()
            if key == "1M":
                return "month"
            key = _key(key)
            return _BUCKET_ALIASES.get(key, key)
        return value

    @field_validator("metrics", mode="before")
    @classmethod
    def _metrics(cls, value: Any) -> Any:
        if value in (None, "", []):
            return ["count"]
        if isinstance(value, str):
            value = value.replace(";", ",").split(",")
        if not isinstance(value, (list, tuple)):
            return value
        out: list[str] = []
        for item in value:
            key = _key(item)
            key = _METRIC_ALIASES.get(key, key)
            if key and key not in out:
                out.append(key)
        return out

    @field_validator("compare", mode="before")
    @classmethod
    def _compare(cls, value: Any) -> Any:
        return normalise_compare(value)

    def split_buckets(self) -> tuple[list[str], str | None, list[str]]:
        """``(fields, bucket, invalid)``: a creation-time grouping in ``group_by``
        ("month", "created_week") is the bucket; unknown names are reported."""
        fields: list[str] = []
        invalid: list[str] = []
        bucket = None if self.bucket == "none" else self.bucket
        for name in self.group_by:
            if name in GROUP_FIELDS:
                fields.append(name)
            elif _BUCKET_ALIASES.get(name, name) in BUCKETS:
                bucket = bucket or _BUCKET_ALIASES.get(name, name)
            else:
                invalid.append(name)
        return fields, bucket, invalid


# --------------------------------------------------------------------------- #
# Shared helpers (soc_metrics reuses them).
# --------------------------------------------------------------------------- #
def progress_reporter(ctx: ChatToolContext, unit: str = "cases") -> Any:
    """The aggregator's ``progress(done, total)`` bridged to the turn's progress hook
    (``ChatToolContext.progress`` through :func:`base.report_progress`, SPEC §3.3
    ``step.progress``), or ``None`` when the engine gave none. Never raises."""
    from . import base

    if not callable(getattr(ctx, "progress", None)):
        return None
    reporter = getattr(base, "report_progress", None)

    async def report(done: int, total: int | None) -> None:
        if reporter is not None:
            await reporter(ctx, done, total, unit)

    return report


async def run_case_aggregate(
    ctx: ChatToolContext, window: Window, *, filters: dict[str, Any] | None = None,
    group_by: tuple[str, ...] = (), bucket: str | None = None, metrics: tuple[str, ...] = ("count",),
    top_n: int | None = None,
) -> Any:
    """One exact aggregate over the case store (raises on a store failure; the
    caller turns that into an engine-template error)."""
    from ...engine.case_aggregate import CaseAggregateSpec, aggregate_cases

    spec = CaseAggregateSpec(
        window=window.as_resolved(), filters=dict(filters or {}), group_by=tuple(group_by),
        bucket=bucket, metrics=tuple(metrics), top_n=top_n, prefs=ctx.prefs,  # type: ignore[arg-type]
    )
    return await aggregate_cases(ctx.cases, spec, progress=progress_reporter(ctx))


def metric_value(metric: str, raw: Any) -> float | None:
    """A metric in its display unit: rates become percent (the aggregator reports
    0..1 ratios, like ``engine.metrics``), everything else as reported; ``None`` when
    not measured (G3)."""
    number = finite(raw)
    if number is None:
        return None
    if _METRIC_UNITS.get(metric) == "percent":
        return round(number * 100, 2)
    return int(number) if float(number).is_integer() else round(number, 2)


def group_label(field: str, value: Any) -> str:
    """The display label of a group value: engine enums humanised, a missing value
    named, a case/log value kept (bounded, invisible characters made visible)."""
    if value in (None, ""):
        return {"assignee": "Unassigned", "closed_by": "Not closed", "verdict": "No verdict",
                "disposition": "Not classified", "severity": "No severity", "priority": "No priority",
                "rule": "No rule", "source": "Default source", "mitre_technique": "No technique",
                "mitre_tactic": "No tactic"}.get(field, "(none)")
    raw = str(getattr(value, "value", value))
    if field == "verdict":
        return _VERDICT_LABELS.get(raw.upper(), raw)
    if field == "status":
        return _STATUS_LABELS.get(raw.lower(), raw.replace("_", " ").capitalize())
    if field == "status_group":
        return {"active": "Open", "terminal": "Closed"}.get(raw.lower(), raw)
    if field in ("decided_by", "closed_by"):
        return _DECIDED_BY_LABELS.get(raw.lower(), visible_text(raw, 200))
    if field in ("severity", "disposition"):
        return raw.replace("_", " ").capitalize()
    return visible_text(raw, 200) or "(none)"


#: Group values with ONE canonical order (Round 12 SPEC §7.2 decision 27): the severity
#: ladder, the verdicts, the case lifecycle and the priority ladder read the same way in
#: every breakdown, chart legend, table, export and report ("Critical, High, Medium, Low,
#: Info"), whatever each value's volume, so a reader never has to hunt for "Critical".
#: A value outside the order (or a missing one) follows the known values.
CANONICAL_ORDER: dict[str, tuple[str, ...]] = {
    "severity": ("critical", "high", "medium", "low", "info"),
    "verdict": ("true_positive", "false_positive", "needs_human"),
    "status": ("new", "open", "needs_human", "investigating", "escalated", "on_hold", "resolved", "closed"),
    "priority": ("p1", "p2", "p3", "p4"),
}
_SEMANTIC_VERDICTS = ("true_positive", "false_positive", "needs_human")


def _raw_key(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw).strip().lower() if raw not in (None, "") else ""


def canonical_rank(field: str, value: Any) -> int | None:
    """``value``'s position in ``field``'s canonical order (after every known value when
    it is unknown or missing); ``None`` when ``field`` has no canonical order."""
    order = CANONICAL_ORDER.get(field)
    if order is None:
        return None
    key = _raw_key(value)
    return order.index(key) if key in order else len(order)


def series_semantic(field: str, value: Any) -> str | None:
    """The palette key a chart series of ``field`` = ``value`` is coloured by (webui
    ``palette.ts``): a severity in its severity colour (Critical is never green), a
    verdict in its verdict colour, a case with no verdict as ``undetermined`` (the
    neutral ink). ``None`` for every other field: the status axis shares one colour
    between states (resolved and closed, awaiting analyst and on hold), so a status chart
    keeps the categorical palette, in lifecycle order."""
    key = _raw_key(value)
    if field == "severity":
        return key if key in CANONICAL_ORDER["severity"] else None
    if field == "verdict":
        if not key:
            return "undetermined"
        return key if key in _SEMANTIC_VERDICTS else None
    return None


def canonical_rows(rows: list[dict[str, Any]], fields: list[str]) -> list[dict[str, Any]]:
    """``rows`` with every canonical grouping in its canonical order: grouped by the first
    field (its canonical order, else the order its values first appear in, which is by
    volume), then by the second field's canonical order; rows that tie keep the order
    they came in (by volume)."""
    if not any(f in CANONICAL_ORDER for f in fields):
        return list(rows)
    first_seen: dict[str, int] = {}
    for row in rows:
        first_seen.setdefault(_raw_key(_key_of(row, fields[0])), len(first_seen))

    def key(row: dict[str, Any]) -> tuple[int, ...]:
        out = []
        for i, f in enumerate(fields):
            rank = canonical_rank(f, _key_of(row, f))
            if rank is None:
                rank = first_seen[_raw_key(_key_of(row, f))] if i == 0 else 0
            out.append(rank)
        return tuple(out)

    return sorted(rows, key=key)


def window_caption_label(result: Any, window: Window) -> str:
    """The aggregate's own refined window label ("all time (since 3 Nov 2025)") when
    the window was not clamped, else the window's label."""
    refined = getattr(result, "window_label", None)
    if isinstance(refined, str) and refined.strip() and not window.clamped:
        return refined.strip()
    return window.label


def basis_caption(total: int, result: Any, window: Window, noun: str = "cases") -> str:
    """"6,438 cases · exact · last 90 days" (the honest caption of SPEC P0-4)."""
    word = noun if total != 1 else noun.rstrip("s")
    if getattr(result, "exact", True) and not getattr(result, "partial", False):
        head = f"{fmt_int(total)} {word} · exact"
    else:
        head = f"{fmt_int(total)} {word} counted · partial"
    return f"{head} · {window_caption_label(result, window)}"


def is_exact(result: Any) -> bool:
    return bool(getattr(result, "exact", True)) and not bool(getattr(result, "partial", False))


def result_rows(result: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """``(rows, other_rows)``: the aggregate's group rows, and the exact "Other"
    remainder rows a ``top_n`` cut produced (kept apart, never ranked as a group)."""
    rows = [g for g in (getattr(result, "groups", None) or []) if isinstance(g, dict)]
    return [g for g in rows if not g.get("other")], [g for g in rows if g.get("other")]


def bucket_axis(result: Any, window: Window, unit: str) -> tuple[list[str], list[str], list[bool]] | None:
    """``(ISO starts, labels, in_progress)`` of the aggregate's calendar buckets in
    order (from its rows' ``bucket_start``; recut with ``calendar_buckets`` when no
    row carries one), or ``None`` when they cannot be placed (then labels are categories)."""
    buckets = [b for b in (getattr(result, "buckets", None) or []) if isinstance(b, (list, tuple)) and len(b) == 2]
    labels = [str(b[0]) for b in buckets]
    flags = [bool(b[1]) for b in buckets]
    if not labels:
        return None
    starts: dict[str, str] = {}
    for row in getattr(result, "groups", None) or []:
        if isinstance(row, dict) and row.get("bucket_start") and row.get("bucket") is not None:
            starts.setdefault(str(row["bucket"]), str(row["bucket_start"]))
    if all(label in starts for label in labels):
        return [starts[label] for label in labels], labels, flags
    from ...engine.time_windows import calendar_buckets

    try:
        earliest = _parse(getattr(result, "earliest", None))
        latest = _parse(getattr(result, "latest", None))
        cut = calendar_buckets(window.as_resolved(), unit, earliest=earliest, latest=latest)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 — fall back to category labels
        logger.debug("calendar buckets unavailable", exc_info=True)
        return None
    if [b.label for b in cut] != labels:
        return None
    return [b.start.astimezone(timezone.utc).isoformat() for b in cut], labels, flags


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def zero_case_suggestions(args: CaseFilters, window: Window, tool: str) -> list[dict[str, Any]]:
    """Engine-built next lookups for a zero-match case question (SPEC D10): each is a
    VALID call of ``tool`` — widen to all time, then drop one filter at a time."""
    base = {k: v for k, v in args.filters().items()}
    out: list[dict[str, Any]] = []
    if not window.all_time and window.source == "tool":
        out.append({"label": "All time", "tool": tool, "input": {**base, "window": "all"}})
    for key in ("text", "rule", "assignee", "entity", "verdict", "severity", "priority", "status", "status_group"):
        if key in base:
            reduced = {k: v for k, v in base.items() if k != key}
            if args.window is not None:
                reduced["window"] = args.window
            elif args.window_hours is not None:
                reduced["window_hours"] = args.window_hours
            out.append({"label": ZERO_CASE_FILTER_LABELS[key], "tool": tool, "input": reduced})
    return out[:4]


#: The chip label that drops one case filter, in the field's display words (Round 13
#: T11), never a raw key.
ZERO_CASE_FILTER_LABELS: dict[str, str] = {
    "text": "Without the text filter", "rule": "Without the rule filter",
    "assignee": "Without the assignee filter", "entity": "Without the entity filter",
    "verdict": "Without the verdict filter", "severity": "Without the severity filter",
    "priority": "Without the priority filter", "status": "Without the status filter",
    # The open-or-closed filter, in the words its breakdown uses ("Open or closed"),
    # never the key "status group".
    "status_group": "Open and closed cases",
}


def invalid_aggregate_input(exc: Exception) -> ToolOutcome:
    """The aggregator's own ``ValueError`` (engine text: "9601 hour buckets is too many
    for all time; use week buckets") as a visible INPUT error the model can act on,
    never as a store outage. The detail goes in the fenced ``error`` (it may name a
    window label or a value); the trusted summary is a fixed template."""
    message = " ".join(str(exc).split())[:300] or "the request cannot be counted"
    return ToolOutcome.failure(
        f"Invalid input: {message}",
        summary="Invalid input: this cannot be counted as asked; the error names what to use instead",
    )


def _bucket_points(window: Window, unit: str, earliest: Any = None, latest: Any = None) -> int:
    from ...engine.time_windows import bucket_count

    return int(bucket_count(window.as_resolved(), unit, earliest=earliest, latest=latest))  # type: ignore[arg-type]


def _finest_fitting(window: Window, earliest: Any = None, latest: Any = None) -> str:
    from ...engine.time_windows import auto_bucket

    return str(auto_bucket(window.as_resolved(), earliest=earliest, latest=latest, max_points=MAX_SERIES_POINTS))


def plan_bucket(window: Window, bucket: str, *, explicit: bool = True) -> tuple[Window, str, dict[str, Any] | None]:
    """``(window, unit, coarsening)`` for a bucketed lookup, decided BEFORE anything is
    counted, so every figure of the answer covers the same span.

    The unit is ``bucket`` unless it would draw more than :data:`MAX_SERIES_POINTS`
    points over a bounded window (then the finest unit that fits, never a cut series).
    The window is aligned exactly as the aggregators align it
    (:func:`common.align_to_bucket`, the same start for every unit): "the last 6 months
    by month" is May to October, its label says "since May 2026", and the headline
    total, the series, the bucket labels and the compared periods all use that one
    window. An all-time window has no known span: :func:`run_bucketed` checks it after
    the scan."""
    if window.all_time:
        return window, bucket, None
    aligned = align_to_bucket(window, bucket)
    points = _bucket_points(aligned, bucket)
    if points <= MAX_SERIES_POINTS:
        return aligned, bucket, None
    unit = _finest_fitting(window)
    return (align_to_bucket(window, unit), unit,
            {"requested": bucket, "used": unit, "points": points, "explicit": explicit})


def counted_share(
    result: Any, noun: str = "cases", store: str = "case store",
) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """``(observation["counted"], coverage sentence, observation sentence)`` of a PARTIAL
    aggregate (SPEC D8: the counted share, never a smaller number presented as exact):
    how many rows were counted and of how many the store reported ("counted 1,000 of
    2,500 cases"), else ``(None, None, None)`` for an exact one."""
    if is_exact(result):
        return None, None, None
    scanned = finite(getattr(result, "scanned", None))
    expected = finite(getattr(result, "expected_total", None))
    counted = int(scanned) if scanned is not None else None
    of_total = int(expected) if expected is not None else None
    if counted is None:
        share = None
    elif of_total is not None:
        share = f"counted {fmt_int(counted)} of {fmt_int(of_total)} {noun}"
    else:
        share = f"counted {fmt_int(counted)} {noun} of an unknown total"
    if share is None:
        return (None, f"partial: the {store} stopped answering during the count",
                f"The {store} stopped answering during the count: these figures are not the full total.")
    return (
        {"scanned": counted, "expected_total": of_total},
        f"partial: {share} before the {store} stopped answering",
        f"The {store} stopped answering during the count: it {share}, so these figures cover only "
        "those, not the full total.",
    )


def first_partial(*results: Any) -> Any:
    """The first aggregate of ``results`` that is not exact, else ``None``."""
    return next((r for r in results if r is not None and not is_exact(r)), None)


def missing_created_note(result: Any) -> tuple[int, bool, str | None]:
    """``(count, in_total, sentence)`` for cases with no parseable creation date: in an
    all-time window they are counted (their own row when bucketed); a bounded window
    cannot place them, so they are not counted there and the sentence says so."""
    missing = int(finite(getattr(result, "missing_created", 0)) or 0)
    if missing <= 0:
        return 0, True, None
    in_total = bool(getattr(result, "missing_in_total", True))
    subject = f"{fmt_int(missing)} {'case has' if missing == 1 else 'cases have'} no creation date"
    if in_total:
        return missing, True, f"{subject} and {'is' if missing == 1 else 'are'} counted in the total"
    return missing, False, f"{subject} and {'is' if missing == 1 else 'are'} not counted in this window"


async def run_bucketed(
    window: Window, bucket: str, run: Callable[[str], Awaitable[Any]],
    probe: Callable[[], Awaitable[Any]] | None = None, *, explicit: bool = True,
) -> tuple[Any, str, dict[str, Any] | None]:
    """Run a bucketed aggregate at a unit that keeps the series at or under
    :data:`MAX_SERIES_POINTS` points (SPEC P0-5/P0-8): a finer unit is COARSENED to the
    finest one that fits, never cut to the latest 200 points.

    A bounded window is checked before the scan. An all-time window has no known
    span: its result is checked after the scan, and when the aggregator refuses the
    unit outright (``ValueError``: too many buckets) ``probe`` (a count-only run)
    finds the oldest record first. Returns ``(result, unit used, coarsening)`` where
    ``coarsening`` is ``{"requested", "used", "points"}`` (``points`` the requested
    unit's count when known) or ``None``."""
    requested = bucket
    points: int | None = None
    if not window.all_time:
        points = _bucket_points(window, bucket)
        if points > MAX_SERIES_POINTS:
            bucket = _finest_fitting(window)
        result = await run(bucket)
    else:
        try:
            result = await run(bucket)
        except ValueError:
            if probe is None:
                raise
            seen = await probe()
            earliest, latest = _parse(getattr(seen, "earliest", None)), _parse(getattr(seen, "latest", None))
            finer = _finest_fitting(window, earliest, latest)
            if finer == bucket:
                raise
            bucket = finer
            result = await run(bucket)
        else:
            count = len(getattr(result, "buckets", None) or [])
            if count > MAX_SERIES_POINTS:
                points = count
                earliest = _parse(getattr(result, "earliest", None))
                latest = _parse(getattr(result, "latest", None))
                finer = _finest_fitting(window, earliest, latest)
                if finer != bucket:
                    bucket = finer
                    result = await run(bucket)
    if bucket == requested:
        return result, bucket, None
    return result, bucket, {"requested": requested, "used": bucket, "points": points, "explicit": explicit}


def coarsened_note(coarsened: dict[str, Any] | None) -> str | None:
    """"bucketed by week: day buckets would give 401 points (at most 200 per chart)"."""
    if not coarsened or not coarsened.get("explicit", True):
        return None
    points = coarsened.get("points")
    many = f"{fmt_int(points)} points" if isinstance(points, int) else "too many points"
    return (f"bucketed by {coarsened['used']}: {coarsened['requested']} buckets would give {many} "
            f"(at most {MAX_SERIES_POINTS} per chart)")


def _edge_text(moment: datetime, unit: str, tz: str, *, end: bool = False) -> str:
    from ...engine.time_windows import zone_for

    local = moment.astimezone(zone_for(tz)[0])
    if unit == "day":
        return f"{local:%H:%M}"
    if end:
        local = (moment - timedelta(microseconds=1)).astimezone(zone_for(tz)[0])
    return f"{local.day} {local:%b}"


def bucket_edges(window: Window, unit: str) -> tuple[str | None, str | None]:
    """``(first, last)``: how much of the first / last calendar bucket the window covers
    when it cuts one ("from 12 Jul", "to 5 Oct"; "from 12:00" for days), else ``None``.
    A bucket still in progress is not "cut" (it says in progress instead); hours are
    too short to label."""
    if window.all_time or unit not in ("day", "week", "month", "quarter", "year"):
        return None, None
    from ...engine.time_windows import next_period_start, period_start

    first = None
    if period_start(window.start, unit, window.tz) < window.start:
        first = "from " + _edge_text(window.start, unit, window.tz)
    last = None
    if not window.trailing:
        start_last = period_start(window.end - timedelta(microseconds=1), unit, window.tz)
        if next_period_start(start_last, unit, window.tz) > window.end:
            last = "to " + _edge_text(window.end, unit, window.tz, end=True)
    return first, last


def display_bucket_labels(
    window: Window, unit: str, labels: list[str], flags: list[bool] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    """The labels a person reads: a bucket the window cuts says so ("Jul 2026 (from 12
    Jul)"), the period in progress says so; plus the observation's ``partial_buckets``
    (``{"first": "from 12 Jul", "last": None}``, empty when no bucket is cut)."""
    flags = list(flags or [False] * len(labels))
    out = list(labels)
    first, last = bucket_edges(window, unit)
    info: dict[str, Any] = {}
    if out and first:
        out[0] = f"{out[0]} ({first})"
        info["first"] = first
    if out and last and not (flags and flags[-1]):
        out[-1] = f"{out[-1]} ({last})"
        info["last"] = last
    for i, flag in enumerate(flags):
        if flag and i < len(out) and "(in progress)" not in out[i]:
            out[i] = f"{out[i]} (in progress)"
    return out, info


def partial_bucket_note(info: dict[str, Any]) -> str | None:
    """The observation sentence for a window that cuts its first or last bucket."""
    parts = []
    if info.get("first"):
        parts.append(f"the first bucket covers only part of its period ({info['first']})")
    if info.get("last"):
        parts.append(f"the last bucket covers only part of its period ({info['last']})")
    if not parts:
        return None
    return "; ".join(parts) + ": do not compare those buckets with whole periods"


def comparison_basis(compared: list[Any]) -> tuple[str, str | None]:
    """``(basis, note)`` of a comparison: exact only when EVERY compared figure was
    counted completely; otherwise the note names the period that was not."""
    if all(is_exact(r) for r in compared):
        return "exact", None
    return "sample", ("partial: the store stopped answering while one compared period was counted, "
                      "so its figures are the cases counted so far")


# --------------------------------------------------------------------------- #
# case_stats
# --------------------------------------------------------------------------- #
class CaseStatsTool(ChatTool):
    name: ClassVar[str] = "case_stats"
    label: ClassVar[str] = "Counted cases"
    scope: ClassVar[str] = "cases"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("cases", "read"),)
    data_source: ClassVar[str] = "Case store (exact counts over every case)"
    input_model: ClassVar[type] = CaseStatsInput
    timeout_s: ClassVar[float] = AGGREGATE_TOOL_TIMEOUT_S
    signature: ClassVar[str] = (
        "case_stats(group_by?=[<=2 of verdict|status|status_group|severity|priority|rule|assignee|source|"
        "surface|disposition|mitre_tactic|mitre_technique|decided_by|closed_by], bucket?=hour|day|week|month|"
        "quarter|year|auto (creation time), metrics?=[count] (<=6 of count,fp_rate,tp_rate,auto_closed,"
        "human_closed,analyst_fp,mtta_p50,mttr_p50,mttd_p50,..._p90,mean_risk,open_now), top_n?<=50, window? "
        "(default all time), compare?, and the search_cases filters) -- EXACT counts, breakdowns, trends and "
        "rates over every case"
    )
    display_keys: ClassVar[tuple[str, ...]] = (
        "group_by", "bucket", "metrics", "top_n", "window", "window_hours", "compare", "text", "status",
        "status_group", "verdict", "entity", "severity", "priority", "assignee", "rule",
    )

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        for key in ("group_by", "metrics"):
            if isinstance(params.get(key), list):
                params[key] = ",".join(str(v) for v in params[key][:6])
        for key in ("window", "compare"):
            if isinstance(params.get(key), (dict, list)):
                params[key] = _compact(params[key])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(CaseStatsInput, inp)
        if error is not None:
            return error
        if args.status and args.status_group:
            return ToolOutcome.failure("Invalid input: choose status or status_group, not both")
        fields, bucket, invalid = args.split_buckets()
        if invalid:
            return ToolOutcome.failure(
                "Invalid input: group_by takes up to two of " + ", ".join(GROUP_FIELDS)
                + ", or a creation-time bucket (day, week, month, quarter, year)",
            )
        if len(fields) > MAX_GROUP_BY:
            return ToolOutcome.failure("Invalid input: group_by takes at most two fields")
        if ctx.cases is None:
            return ToolOutcome.failure("The case store is not available")
        ref = datetime.now(timezone.utc)
        window = resolve_window(ctx, window=args.window, window_hours=args.window_hours, default="all", now=ref,
                                minutes_ok=False)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        # One start for every lookup of this window in the answer, broken down or not.
        window = whole_periods(window)
        requested_bucket = bucket
        if bucket == "auto":
            bucket = _auto_bucket(window)
        planned: dict[str, Any] | None = None
        if bucket:
            # One window for every figure: aligned to whole periods of the unit the
            # series is drawn in, before the totals, the series and the comparison.
            window, bucket, planned = plan_bucket(window, bucket, explicit=requested_bucket != "auto")
        metrics = tuple(dict.fromkeys(["count", *args.metrics]))
        periods = resolve_periods(ctx, window, args.compare, now=ref, minutes_ok=False)
        if isinstance(periods, str):
            return ToolOutcome.failure(periods)
        filters = args.filters()
        coarsened: dict[str, Any] | None = None
        series_result: Any = None
        try:
            if bucket:
                async def run_with(unit: str) -> Any:
                    return await run_case_aggregate(
                        ctx, window, filters=filters, group_by=tuple(fields), bucket=unit,
                        metrics=metrics, top_n=args.top_n,
                    )

                async def probe() -> Any:
                    return await run_case_aggregate(ctx, window, filters=filters)

                result, bucket, coarsened = await run_bucketed(
                    window, bucket, run_with, probe, explicit=requested_bucket != "auto")
                coarsened = coarsened or planned
                if len(fields) == 2 and fields[1] in (getattr(result, "multi_valued", ()) or ()):
                    # The series draws the first grouping per period: summing the second
                    # (multi-valued) grouping's rows would count a case once per value.
                    series_result = await run_case_aggregate(
                        ctx, window, filters=filters, group_by=tuple(fields[:1]), bucket=bucket,
                        metrics=("count",),
                    )
            else:
                result = await run_case_aggregate(
                    ctx, window, filters=filters, group_by=tuple(fields), bucket=None,
                    metrics=metrics, top_n=args.top_n,
                )
            compared: list[Any] = []
            if len(periods) > 1:
                # Every period is measured the same way (the first grouping, no
                # buckets), so each comparison number equals an independent call.
                for period in periods:
                    if period.window is window and not bucket and len(fields) <= 1 and args.top_n is None:
                        compared.append(result)
                        continue
                    compared.append(await run_case_aggregate(
                        ctx, period.window, filters=args.filters(), group_by=tuple(fields[:1]),
                        metrics=metrics, top_n=None,
                    ))
        except NotImplementedError:
            raise
        except ValueError as exc:
            # The aggregator refused the REQUEST (engine text naming what to use
            # instead), which is not a store outage.
            return invalid_aggregate_input(exc)
        except Exception as exc:  # noqa: BLE001 — engine template only
            logger.warning("case_stats aggregate failed: %s", exc)
            return ToolOutcome.failure("The case store did not answer")
        return _outcome(args, window, fields, bucket, metrics, result, periods, compared,
                        series_result=series_result, coarsened=coarsened)


def _auto_bucket(window: Window) -> str:
    from ...engine.time_windows import auto_bucket

    try:
        return str(auto_bucket(window.as_resolved()))
    except NotImplementedError:
        raise
    except Exception:  # noqa: BLE001 — a month is always a sensible default
        return "month"


def _compact(value: Any) -> str:
    import json

    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))[:120]
    except (TypeError, ValueError):
        return ""


def _metrics_of(group: Any) -> dict[str, Any]:
    metrics = group.get("metrics") if isinstance(group, dict) else None
    return metrics if isinstance(metrics, dict) else {}


def _count_of(group: Any) -> int:
    return int(finite(_metrics_of(group).get("count")) or 0)


def _key_of(group: Any, field: str) -> Any:
    key = group.get("key") if isinstance(group, dict) else None
    return key.get(field) if isinstance(key, dict) else None


def _other_metrics(result: Any) -> dict[str, Any] | None:
    other = getattr(result, "other", None)
    if isinstance(other, dict) and isinstance(other.get("metrics"), dict):
        return other["metrics"]
    return None


def _other_groups(result: Any) -> int:
    """How many groups a ``top_n`` cut folded into the "Other" remainder (exact)."""
    other = getattr(result, "other", None)
    groups = other.get("groups") if isinstance(other, dict) else None
    return groups if isinstance(groups, int) and not isinstance(groups, bool) and groups > 0 else 0


def _outcome(
    args: CaseStatsInput, window: Window, fields: list[str], bucket: str | None, metrics: tuple[str, ...],
    result: Any, periods: list[Period], compared: list[Any], *, series_result: Any = None,
    coarsened: dict[str, Any] | None = None,
) -> ToolOutcome:
    total = int(getattr(result, "total", 0) or 0)
    exact = is_exact(result)
    rows, other_rows = result_rows(result)
    totals = dict(getattr(result, "totals", None) or {})
    missing = int(getattr(result, "missing_created", 0) or 0)
    label = window_caption_label(result, window)
    caption = basis_caption(total, result, window)
    untrusted = any(f in UNTRUSTED_GROUPS for f in fields)
    basis = "exact" if exact else "sample"
    # A multi-valued grouping (rule, ATT&CK) is not a partition: a case counts once
    # per value, so its rows add up to more than the cases. No view may draw a total.
    multi = [f for f in getattr(result, "multi_valued", ()) or () if f in fields]
    overlap_note = (f"a case can count under several {', '.join(_GROUP_DIMENSIONS[f].lower() + 's' for f in multi)}"
                    if multi else None)
    artifacts: list[Artifact] = []
    ids = (f"a{n}" for n in range(1, 1000))

    def next_id() -> str:
        return next(ids)

    # -- headline figures -------------------------------------------------------
    items = [kpi("cases", "Cases", total, context="exact" if exact else "partial count", bound=not exact)]
    for metric in metrics:
        if metric == "open_now":
            items.append(kpi(metric, OPEN_NOW_STOCK_LABEL, metric_value(metric, totals.get(metric)), "count",
                             context="not windowed", bound=not exact))
        elif metric != "count":
            items.append(kpi(metric, _METRIC_LABELS[metric], metric_value(metric, totals.get(metric)),
                             _METRIC_UNITS[metric]))
    artifacts.append(Artifact(
        id=next_id(), kind="kpis", title="Case figures", title_trusted=True, data={"items": items[:6]},
        provenance="code", basis=basis, total=total, window=caption,
    ))
    partial_info: dict[str, Any] = {}
    if bucket:
        series_rows = result_rows(series_result) if series_result is not None else (rows, other_rows)
        series_fields = fields[:1] if series_result is not None else fields
        built, partial_info = _series_artifacts(
            next_id, result, window, bucket, series_rows[0], series_rows[1], series_fields, metrics,
            caption, basis, untrusted, missing, overlap_note=overlap_note, total=total,
            series_multi=bool(fields) and fields[0] in multi)
        artifacts.extend(built)
    elif fields:
        artifacts.extend(_group_artifacts(next_id, fields, metrics, rows, _other_metrics(result), total,
                                          caption, basis, untrusted, overlap_note=overlap_note,
                                          other_groups=_other_groups(result)))
    comparison = None
    comparison_partial = None
    if len(periods) > 1 and len(compared) == len(periods):
        comparison_rows = _comparison_rows(fields[:1], metrics, compared)
        compare_basis, comparison_partial = comparison_basis(compared)
        if comparison_rows:
            data = comparison_data(periods, comparison_rows,
                                   dimension=_GROUP_DIMENSIONS.get(fields[0]) if fields else None,
                                   unit="count" if fields else None)
            if fields and fields[0] in multi:
                data["overlapping"] = True
            artifacts.append(Artifact(
                id=next_id(), kind="comparison", title="Comparison", title_trusted=True, data=data,
                provenance="code", untrusted_labels=untrusted and bool(fields), basis=compare_basis,
                window=comparison_caption(periods),
            ))
            comparison = comparison_observation(periods, comparison_rows)
            if "open_now" in metrics:
                comparison["open_now"] = ("not compared: open_now is the open stock now, the same "
                                          "figure for every period")
            if comparison_partial:
                comparison["partial"] = comparison_partial

    observation: dict[str, Any] = {
        "window": label,
        "window_clamped_to_request": window.clamped,
        "timezone": window.tz,
        "filters": args.filters(),
        "total": total,
        "exact": exact,
        "consistency": getattr(result, "consistency", None),
        "group_by": fields,
        "bucket": bucket,
        "metrics": list(metrics),
        "units": {m: _METRIC_UNITS[m] for m in metrics},
        "totals": {m: metric_value(m, totals.get(m)) for m in metrics if m in totals},
    }
    if multi:
        observation["multi_valued"] = (
            f"a case can carry several values of {', '.join(multi)}, so group counts can add up "
            "to more than the total; never present them as shares of the total"
        )
    if "open_now" in metrics:
        observation["open_now_window_exempt"] = True
        observation["open_now_note"] = OPEN_NOW_NOTE + (f"; {OPEN_NOW_BUCKET_NOTE}" if bucket else "")
    missing, missing_in_total, missing_note = missing_created_note(result)
    if missing:
        observation["missing_created"] = missing
        observation["missing_created_in_total"] = missing_in_total
        observation["missing_created_note"] = missing_note
    if bucket:
        bucket_list = [b for b in getattr(result, "buckets", None) or [] if len(b) == 2]
        observation["buckets"] = [{"label": text(b[0], 40), "in_progress": bool(b[1])} for b in bucket_list]
        if partial_info.get("first") and observation["buckets"]:
            observation["buckets"][0]["partial"] = partial_info["first"]
        if partial_info.get("last") and observation["buckets"]:
            observation["buckets"][-1]["partial"] = partial_info["last"]
        note = partial_bucket_note(partial_info)
        if note:
            observation["partial_buckets"] = note
        note = coarsened_note(coarsened)
        if note:
            observation["bucket_note"] = note
    if rows:
        # Every group fits: list them in the order the chart and table show them
        # (Critical, High, Medium, Low, Info), so the answer names them that way too.
        listed = canonical_rows(rows, fields) if (fields and not bucket and len(rows) <= _OBS_GROUPS) else rows
        observation["groups"] = [
            {"key": {f: text(group_label(f, _key_of(g, f)), 200) for f in fields} if fields else {},
             "bucket": text(g.get("bucket"), 40) if g.get("bucket") is not None else None,
             "metrics": {m: metric_value(m, _metrics_of(g).get(m)) for m in metrics}}
            for g in listed[:_OBS_GROUPS] if not (bucket and _count_of(g) == 0 and fields)
        ]
        if len(rows) > _OBS_GROUPS:
            observation["groups_listed"] = _OBS_GROUPS
            observation["groups_total"] = len(rows)
    other_metrics = _other_metrics(result)
    if other_metrics:
        observation["other"] = {
            "groups": (getattr(result, "other", None) or {}).get("groups"),
            "metrics": {m: metric_value(m, other_metrics.get(m)) for m in metrics},
        }
    if comparison is not None:
        observation["comparison"] = comparison
    counted, share, partial_text = counted_share(result)
    if not exact:
        observation["partial"] = partial_text
        if counted is not None:
            observation["counted"] = counted
    if total == 0:
        observation["suggestions"] = zero_case_suggestions(args, window, "case_stats")

    noun = "case" if total == 1 else "cases"
    # The label carries its own parentheses ("all time (since 28 Mar 2026)"), so it is
    # never wrapped in another pair.
    summary = f"{fmt_int(total)} {noun}, {label}, {'exact' if exact else 'partial count'}"
    if fields:
        summary += f", grouped by {', '.join(fields)}"
    if bucket:
        summary += f"{' and' if fields else ','} by {bucket}"
    if coarsened_note(coarsened):
        summary += f" ({coarsened_note(coarsened)})"
    if comparison is not None:
        summary += f"; compared with {', '.join(p.label for p in periods if p.window is not window)}"
    if window.clamped:
        summary += "; window limited to the selected range"
    notes: list[str] = []
    if not exact:
        notes.append(share or "partial: the case store stopped answering during the count")
    if missing and missing_in_total and bucket:
        notes.append(f"{fmt_int(missing)} {'case has' if missing == 1 else 'cases have'} no creation date "
                     f"and {'sits' if missing == 1 else 'sit'} in their own row")
    elif missing and not missing_in_total:
        notes.append(missing_note)
    if comparison_partial:
        notes.append(comparison_partial)
    if overlap_note:
        notes.append(overlap_note)
    coverage = "; ".join(dict.fromkeys(notes)) or None
    return ToolOutcome(
        ok=True, summary=summary, observation=observation, artifacts=artifacts, rows=total,
        basis=basis, coverage=coverage,
        untrusted_params={k: str(v) for k, v in args.filters().items() if k in ("text", "entity", "assignee", "rule")},
    )


def _series_artifacts(
    next_id: Any, result: Any, window: Window, bucket: str, rows: list[dict[str, Any]],
    other_rows: list[dict[str, Any]], fields: list[str], metrics: tuple[str, ...], caption: str, basis: str,
    untrusted: bool, missing: int, *, overlap_note: str | None = None, total: int = 0,
    series_multi: bool = False,
) -> tuple[list[Artifact], dict[str, Any]]:
    from ...engine.case_aggregate import MISSING_BUCKET

    axis = bucket_axis(result, window, bucket)
    bucket_list = [b for b in getattr(result, "buckets", None) or [] if len(b) == 2]
    if axis is None:
        labels = [str(b[0]) for b in bucket_list]
        flags = [bool(b[1]) for b in bucket_list]
        shown, partial_info = display_bucket_labels(window, bucket, labels, flags)
        base: dict[str, Any] = {"x": list(shown), "x_kind": "category", "unit": "count"}
        in_progress = False
    else:
        starts, labels, flags = axis
        in_progress = bool(flags and flags[-1])
        # The in-progress flag rides on ``last_in_progress``; the labels name a cut edge.
        shown, partial_info = display_bucket_labels(window, bucket, labels)
        base = {"x": starts, "x_labels": shown, "bucket": _BUCKET_ENUM[bucket], "tz": window.tz,
                "unit": "count", "last_in_progress": in_progress}
    if not labels:
        return [], partial_info
    index = {label: i for i, label in enumerate(labels)}
    out: list[Artifact] = []
    canonical = False
    if fields:
        field = fields[0]
        per: dict[str, list[float]] = {}
        totals: dict[str, float] = {}
        raw_of: dict[str, Any] = {}
        for g in rows:
            slot = index.get(str(g.get("bucket")))
            if slot is None:
                continue
            name = group_label(field, _key_of(g, field))
            raw_of.setdefault(name, _key_of(g, field))
            per.setdefault(name, [0] * len(labels))[slot] += _count_of(g)
            totals[name] = totals.get(name, 0) + _count_of(g)
        rest = [0] * len(labels)
        for g in other_rows:
            slot = index.get(str(g.get("bucket")))
            if slot is not None:
                rest[slot] += _count_of(g)
        ranked = sorted((k for k in totals if totals[k] > 0), key=lambda k: (-totals[k], k))
        # The busiest values are drawn (the rest fold into "Other"); a severity, verdict,
        # status or priority breakdown then reads in its canonical order and a severity
        # or verdict wears its palette colour (Critical is never a categorical green).
        kept = ranked[:_MAX_SERIES]
        canonical = field in CANONICAL_ORDER
        if canonical:
            kept.sort(key=lambda k: (canonical_rank(field, raw_of.get(k)), ranked.index(k)))
        series = []
        for i, name in enumerate(kept):
            entry: dict[str, Any] = {"key": f"s{i + 1}", "label": name, "values": per[name]}
            semantic = series_semantic(field, raw_of.get(name))
            if semantic:
                entry["semantic"] = semantic
            series.append(entry)
        for name in ranked[_MAX_SERIES:]:
            rest = [a + b for a, b in zip(rest, per[name])]
        if any(rest):
            series.append({"key": "other", "label": "Other", "values": rest})
        title = f"{_GROUP_TITLES[field]} and {bucket}"
        if not series:
            series = [{"key": "cases", "label": "Cases", "values": [0] * len(labels)}]
    else:
        counts = [0] * len(labels)
        for g in rows:
            slot = index.get(str(g.get("bucket")))
            if slot is not None:
                counts[slot] += _count_of(g)
        series = [{"key": "cases", "label": "Cases", "values": counts}]
        title = _BUCKET_TITLES[bucket]
    data = {**base, "series": series}
    if canonical:
        # Keep this order when the block is materialised (never re-ranked by volume).
        data["ordered"] = True
    series_total = sum(sum(s["values"]) for s in series)
    if series_multi:
        # One line per rule (or technique): a case under two rules is on two lines, so
        # a stack or a summed total would count it twice.
        data["overlapping"] = True
        series_total = total
    out.append(Artifact(
        id=next_id(), kind="series", title=title, title_trusted=True, data=data,
        provenance="code", untrusted_labels=untrusted, basis=basis,
        total=series_total, window=f"{caption} · {overlap_note}" if series_multi and overlap_note else caption,
    ))
    if fields:
        return out, partial_info
    # Each requested rate or duration per bucket, one unit per chart (G6).
    by_unit: dict[str, list[dict[str, Any]]] = {}
    for metric in metrics:
        if metric == "count":
            continue
        values: list[float | None] = [None] * len(labels)
        for g in rows:
            slot = index.get(str(g.get("bucket")))
            if slot is not None:
                values[slot] = metric_value(metric, _metrics_of(g).get(metric))
        by_unit.setdefault(_METRIC_UNITS[metric], []).append(
            {"key": metric, "label": OPEN_NOW_COHORT_LABEL if metric == "open_now" else _METRIC_LABELS[metric],
             "values": values})
    for unit, series_list in by_unit.items():
        out.append(Artifact(
            id=next_id(), kind="series", title=f"{_UNIT_TITLES.get(unit, 'Figures')} by {bucket}",
            title_trusted=True, data={**base, "unit": unit, "series": series_list[:_MAX_SERIES]},
            provenance="code", basis=basis, window=caption,
        ))
    # The per-bucket table (every metric, the in-progress period marked) for reading and export.
    cols = [column("period", "Period")] + [
        column(m, OPEN_NOW_COHORT_LABEL if m == "open_now" else _METRIC_LABELS[m], "number",
               unit=_METRIC_UNITS[m], align="right") for m in metrics]
    by_label = {str(g.get("bucket")): g for g in rows}
    row_labels, _info = display_bucket_labels(window, bucket, labels, flags)
    table_rows = []
    for position, name in enumerate(labels):
        group = by_label.get(name)
        table_rows.append([row_labels[position], *[metric_value(m, _metrics_of(group).get(m)) if group
                                                    else (0 if m == "count" else None) for m in metrics]])
    missing_row = by_label.get(MISSING_BUCKET)
    if missing and missing_row is not None:
        table_rows.append(["No creation date", *[metric_value(m, _metrics_of(missing_row).get(m)) for m in metrics]])
    out.append(Artifact(
        id=next_id(), kind="table", title=f"Cases per {bucket}", title_trusted=True,
        data={"columns": cols, "rows": table_rows}, provenance="code", basis=basis, window=caption,
    ))
    return out, partial_info


_UNIT_TITLES = {"percent": "Rates", "minutes": "Response times", "score": "Average risk", "count": "Counts"}


def _group_artifacts(
    next_id: Any, fields: list[str], metrics: tuple[str, ...], rows: list[dict[str, Any]],
    other: dict[str, Any] | None, total: int, caption: str, basis: str, untrusted: bool,
    *, overlap_note: str | None = None, other_groups: int = 0,
) -> list[Artifact]:
    out: list[Artifact] = []
    other_count = finite((other or {}).get("count")) if other else None
    # Severity, verdict, status and priority rows read in their canonical order.
    rows = canonical_rows(rows, fields)
    if len(fields) == 1:
        # The categories' own population ("Top 5 of 7" rules): the groups shown plus the
        # ones the top_n cut folded into "Other". ``total`` counts CASES, which the
        # caption already states ("95 cases · exact · …").
        cut = bool(other_groups or other_count)
        field = fields[0]
        pairs = [(group_label(field, _key_of(g, field)), _count_of(g)) for g in rows]
        data = categories(pairs, dimension=_GROUP_DIMENSIONS[field], other=other_count or None,
                          ordered=field in CANONICAL_ORDER)
        if overlap_note:
            # Not a partition: no donut, no share of a total.
            data["overlapping"] = True
        out.append(Artifact(
            id=next_id(), kind="categories", title=_GROUP_TITLES[field], title_trusted=True,
            data=data, provenance="code", untrusted_labels=field in UNTRUSTED_GROUPS, basis=basis,
            total=len(rows) + other_groups if cut else len(rows), truncated=cut,
            window=f"{caption} · {overlap_note}" if overlap_note else caption,
        ))
    # The full table: each grouping, then every metric (two groupings live here only).
    cols = [column(f, _GROUP_DIMENSIONS[f], untrusted=f in UNTRUSTED_GROUPS) for f in fields]
    cols += [column(m, OPEN_NOW_STOCK_LABEL if m == "open_now" else _METRIC_LABELS[m], "number",
                    unit=_METRIC_UNITS[m], align="right") for m in metrics]
    table_rows = [[*[group_label(f, _key_of(g, f)) for f in fields],
                   *[metric_value(m, _metrics_of(g).get(m)) for m in metrics]] for g in rows]
    if other:
        table_rows.append([*(["Other"] + [""] * (len(fields) - 1)),
                           *[metric_value(m, other.get(m)) for m in metrics]])
    if len(fields) > 1 or len(metrics) > 1:
        out.append(Artifact(
            id=next_id(), kind="table", title="Breakdown", title_trusted=True,
            data={"columns": cols, "rows": table_rows}, provenance="code", untrusted_labels=untrusted,
            basis=basis, total=len(table_rows), window=caption,
        ))
    return out


def _comparison_rows(fields: list[str], metrics: tuple[str, ...], compared: list[Any]) -> list[dict[str, Any]]:
    """One row per category (a grouping) or per metric (no grouping), values per
    period in the periods' order."""
    if fields:
        field = fields[0]
        per: dict[str, list[float]] = {}
        raw_of: dict[str, Any] = {}
        for index, result in enumerate(compared):
            rows, _other = result_rows(result)
            for g in rows:
                name = group_label(field, _key_of(g, field))
                raw_of.setdefault(name, _key_of(g, field))
                per.setdefault(name, [0.0] * len(compared))[index] += _count_of(g)
        ranked = sorted(per, key=lambda k: (-per[k][-1], -sum(per[k]), k))
        kept = ranked[:MAX_TOP_N]
        if field in CANONICAL_ORDER:
            # The busiest values, in their canonical order (Critical, High, Medium…).
            kept.sort(key=lambda k: (canonical_rank(field, raw_of.get(k)), ranked.index(k)))
        return [comparison_row(f"r{i + 1}", name, per[name], unit="count")
                for i, name in enumerate(kept)]
    rows = [comparison_row("count", "Cases", [int(getattr(r, "total", 0) or 0) for r in compared], unit="count",
                           good="none")]
    for metric in metrics:
        if metric in ("count", "open_now"):
            # open_now is the open stock NOW: the same figure in every period, never a change.
            continue
        totals = [getattr(r, "totals", None) or {} for r in compared]
        values = [metric_value(metric, t.get(metric)) for t in totals]
        # The sample behind a rate is its verdicted cases; behind a duration its samples.
        sample_key = "verdicted" if metric in ("fp_rate", "tp_rate") else (
            f"{metric.split('_')[0]}_samples" if metric.endswith(("_p50", "_p90")) else None)
        samples = [t.get(sample_key) for t in totals] if sample_key else None
        rows.append(comparison_row(metric, _METRIC_LABELS[metric], values, unit=_METRIC_UNITS[metric],
                                   good=_GOOD.get(metric, "none"), samples=samples))  # type: ignore[arg-type]
    return rows


__all__ = [
    "AGGREGATE_TOOL_TIMEOUT_S",
    "CANONICAL_ORDER",
    "CaseStatsInput",
    "CaseStatsTool",
    "GROUP_FIELDS",
    "METRICS",
    "basis_caption",
    "bucket_axis",
    "bucket_edges",
    "canonical_rank",
    "canonical_rows",
    "comparison_basis",
    "coarsened_note",
    "display_bucket_labels",
    "invalid_aggregate_input",
    "is_exact",
    "partial_bucket_note",
    "plan_bucket",
    "counted_share",
    "first_partial",
    "missing_created_note",
    "run_bucketed",
    "result_rows",
    "window_caption_label",
    "group_label",
    "metric_value",
    "progress_reporter",
    "run_case_aggregate",
    "series_semantic",
    "zero_case_suggestions",
]
