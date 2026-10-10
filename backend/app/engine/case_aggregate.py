"""Exact, full-population case and usage aggregates (Round 12 SPEC §3.5, D8).

One engine answers every "how many / what share / by what / per month" question about
the suite's OWN state, exactly, over the whole population — never over a sampled page.

Strategy
========

1. **Push-down.** When the repository implements ``aggregate(spec)`` and returns an
   :class:`AggregateResult`, that answer is used. The bundled Elasticsearch and SQL
   repositories push COUNT-style specs (``count``/``open_now`` over mapped/columned
   fields and filters) into the backend; anything they cannot answer with the SAME
   semantics as the fold returns ``None``. A third-party repository inherits the
   non-abstract default (``None``) and keeps working.
2. **Fold.** Otherwise a streaming fold over the repository's pages (``scan_page`` when
   the repository has it — every :class:`~app.stores.base.CaseRepository` does, its
   default being ``export_page`` — or ``export_page`` on a duck-typed store) in pages of
   1,000. Only counters are kept: memory grows with the number of GROUPS (plus one float
   per case for a requested percentile), never with case documents.

Honesty
=======

* ``exact`` is True only when every page was read and every selected document could
  be evaluated. A store failure after at least one page returns ``partial=True`` with
  what was counted, ``scanned``, ``expected_total`` and the ``error`` — never a smaller
  number presented as exact. A failure on the very first page raises (nothing was
  measured). A push-down is used only when it answers with one consistent snapshot
  (an Elasticsearch point-in-time, a single SQL snapshot transaction) and complete
  shard results; otherwise the engine folds.
* ``consistency`` is the WEAKEST guarantee any page reported: ``point_in_time`` (one
  snapshot), ``bounded_at_start`` (rows that existed at the start were each read once,
  values may move) or ``unverified``.
* ``missing_created`` counts matching cases with no parseable ``created_at``. Window
  membership is the dashboards' rule (``metrics._window_filter``), so chat and the
  dashboards count the same cases: in an ALL-TIME window they are counted in ``total``
  and their group rows and carry the bucket :data:`MISSING_BUCKET`; a BOUNDED window
  cannot place them, so they are not in ``total`` and ``missing_created`` discloses them
  (``missing_in_total`` says which). Never silently dropped, never invented into a
  period. ``buckets`` lists only the calendar axis.
* A stored document that no longer validates is still counted from its raw fields;
  when a figure needed the full model (a derived band, a lifecycle clock, the analyst
  ground truth), the case is counted in ``unreadable`` and the result is not exact.
* A relative window broken down by a calendar unit is aligned to whole periods first
  (``time_windows.align_window``: "by month for the last 12 months" is twelve months,
  the last in progress); ``window_label`` / ``window_from`` report what was measured.
* ``open_now`` (the window-exempt stock) is its own aggregate over the active statuses
  (a COUNT push-down where the backend can), so it never widens the windowed scan.
* Cancel (``cancel.set()``) is honoured between pages and raises
  :class:`AggregationCancelled`; the scan cursor is always released.

Field mappings (``group_by`` and ``filters``), each verified against ``models.Case``:

==================  ==========================================================================
``verdict``         ``Case.verdict`` (``TRUE_POSITIVE``/``FALSE_POSITIVE``/``NEEDS_HUMAN``);
                    ``None`` = no verdict yet
``status``          ``Case.status`` value
``status_group``    ``active`` (``OPEN_CASE_STATUSES``) / ``terminal`` (``TERMINAL_CASE_STATUSES``)
``severity``        ``engine.priority.band_of_case(case, prefs)`` — the read-time advisory band
``priority``        ``Case.priority_level`` else ``engine.priority.advisory_bands`` (needs prefs)
``rule``            each distinct value of ``Case.rule_ids`` (MULTI-VALUED); ``None`` = no rule
``assignee``        ``Case.assignee`` stripped; ``None`` = unassigned (filter: case-insensitive,
                    "unassigned" matches none)
``source``          ``Case.source_id``; ``None`` = the legacy implicit source (filter matches
                    ``source_id`` exactly or ``source_name`` case-insensitively)
``surface``         ``Case.source_surface`` value
``disposition``     ``Case.disposition`` value; ``None`` = undetermined
``mitre_tactic``    tactics of the VALIDATED techniques (MULTI-VALUED, #9: ids that do not
                    resolve against the bundled ATT&CK corpus are dropped)
``mitre_technique`` validated technique ids of ``Case.mitre`` (MULTI-VALUED, #9)
``decided_by``      ``Case.decision_by`` value (``agent``/``analyst``/``system``/
                    ``analyst_policy``); LAST-WRITER, see ``metrics.quality_metrics``
``closed_by``       terminal cases only: ``analyst_policy`` (``precedent.is_policy_closed``),
                    ``agent``, ``analyst``, else ``system`` (deterministic routing and legacy
                    rows with no recorded decider); ``None`` = not closed
``entity``          filter only: ``Case.entity.value`` exactly
``text``            filter only: case-insensitive substring of id, number, title, entity,
                    source name, tags and rule ids (the ``search_cases`` haystack)
==================  ==========================================================================

A MULTI-VALUED field puts a case in one row per value, so its rows can sum to more than
``total``; ``AggregateResult.multi_valued`` names such fields and ``totals`` always
counts each case once.

Metric semantics reuse :mod:`app.engine.metrics` (the dashboards' definitions):

* ``count`` — every selected case (policy closes included, like posture ``case_count``);
* ``auto_closed`` / ``human_closed`` — terminal, NOT policy-closed, ``decision_by`` agent /
  analyst (``quality_metrics``' partition);
* ``fp_rate`` / ``tp_rate`` — AI-verdict FALSE/TRUE_POSITIVE ÷ verdicted, policy closes
  excluded (``quality_metrics.false_positive_rate``), 0..1 rounded to 4 places, ``None``
  when nothing was verdicted; the row also carries ``verdicted`` and the numerator;
* ``analyst_fp`` — cases whose INDEPENDENT ground truth is false positive
  (``analyst_outcomes.analyst_confirmed_outcome``: graded feedback or an explicit analyst
  classification), the same authority the tuner and precedent use, over the same
  population as the dashboards' ``analyst_confirmed_fp`` (analyst-rule-policy closes
  excluded: no model ran on them);
* ``mtta_*`` / ``mttr_*`` / ``mttd_*`` — minutes, p50/p90 by ``metrics.percentile`` over the
  ``lifecycle_intervals`` samples (MTTA is HUMAN acknowledgement only), ``None`` when no
  case made the transition;
* ``mean_risk`` — mean finite ``risk_score``, 1 decimal, ``None`` when none;
* ``open_now`` — still-open (active-status) cases. In ``totals`` and in un-bucketed rows it
  is the window-EXEMPT stock (every matching case open now, whenever created); in a
  bucketed row it is the open part of that bucket's cohort.

Aggregates only: nothing here returns case documents (#7). Nothing here is read by
``case_manager.decide()`` (#3).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import product
from typing import Any, Awaitable, Callable

from ..constants import OPEN_CASE_STATUSES, SEVERITY_BANDS, TERMINAL_CASE_STATUSES
from ..utils import parse_es_timestamp
from .time_windows import (
    BUCKET_UNITS,
    BucketUnit,
    ResolvedWindow,
    align_window,
    all_time_label,
    calendar_buckets,
    period_start,
    zone_for,
)

logger = logging.getLogger("tlsoc.engine.case_aggregate")

CASE_GROUP_FIELDS: tuple[str, ...] = (
    "verdict", "status", "status_group", "severity", "priority", "rule", "assignee", "source",
    "surface", "disposition", "mitre_tactic", "mitre_technique", "decided_by", "closed_by",
)
CASE_METRICS: tuple[str, ...] = (
    "count", "auto_closed", "human_closed", "fp_rate", "tp_rate", "analyst_fp",
    "mtta_p50", "mtta_p90", "mttr_p50", "mttr_p90", "mttd_p50", "mttd_p90", "mean_risk", "open_now",
)
USAGE_GROUP_FIELDS: tuple[str, ...] = ("role", "model", "surface", "provider", "service_tier")
USAGE_METRICS: tuple[str, ...] = ("calls", "input_tokens", "output_tokens", "total_tokens", "cost_usd")

# Filter keys accepted by ``CaseAggregateSpec.filters`` (the ``search_cases`` filters plus
# every group field). Anything else is REJECTED (ValueError), never silently ignored.
CASE_FILTER_FIELDS: tuple[str, ...] = (
    "text", "status", "status_group", "verdict", "entity", "severity", "priority",
    "assignee", "rule", "source", "surface", "disposition", "decided_by", "closed_by",
    "mitre_tactic", "mitre_technique",
)
USAGE_FILTER_FIELDS: tuple[str, ...] = ("role", "model", "surface", "provider", "service_tier",
                                        "case_id")
MULTI_VALUED_FIELDS: frozenset[str] = frozenset({"rule", "mitre_tactic", "mitre_technique"})

# The bucket label of rows for records without a parseable timestamp (never dropped, #4).
MISSING_BUCKET = "No creation date"
MISSING_USAGE_BUCKET = "No timestamp"
# The key value of the exact remainder row when ``top_n`` trims groups.
OTHER_KEY = "Other"
PAGE_SIZE = 1000
MAX_GROUP_BY = 2
# The most calendar buckets one aggregate will zero-fill. A finer request is REJECTED
# with a message naming a coarser unit (``time_windows.auto_bucket`` picks one that
# fits), never silently coarsened or cut.
MAX_RESULT_BUCKETS = 5000

ProgressFn = Callable[[int, "int | None"], Awaitable[None]]

_CONSISTENCY_RANK = {"point_in_time": 0, "bounded_at_start": 1, "unverified": 2}
_ACTIVE = frozenset(OPEN_CASE_STATUSES)
_TERMINAL = frozenset(TERMINAL_CASE_STATUSES)
_PERCENTILE_METRICS = {
    "mtta_p50": ("mtta", 50), "mtta_p90": ("mtta", 90),
    "mttr_p50": ("mttr", 50), "mttr_p90": ("mttr", 90),
    "mttd_p50": ("mttd", 50), "mttd_p90": ("mttd", 90),
}


class AggregationCancelled(RuntimeError):
    """Raised when the caller's ``cancel`` event was set between pages."""


class BucketMismatch(RuntimeError):
    """A push-down returned a bucket key that is not one of the calendar starts the
    engine computed (for example a backend whose zone rules differ from Python's tz
    database). The engine folds instead of silently dropping those rows."""


@dataclass(frozen=True)
class CaseAggregateSpec:
    window: ResolvedWindow
    filters: dict[str, Any] = field(default_factory=dict)  # search_cases filters incl. status_group
    group_by: tuple[str, ...] = ()  # <= 2 of CASE_GROUP_FIELDS
    bucket: BucketUnit | None = None  # calendar bucket over created_at
    metrics: tuple[str, ...] = ("count",)  # subset of CASE_METRICS
    top_n: int | None = None  # keep the top N groups by count, plus an exact "Other" remainder
    # --- additive (WP-AGG) ---
    # Preferences for the read-time severity/priority projection (declared source
    # ceilings, the priority matrix). Optional: without it severity bands on the
    # identity ceiling and a priority that was never persisted reads as None.
    prefs: Any = field(default=None, compare=False, hash=False, repr=False)


@dataclass
class AggregateResult:
    total: int
    groups: list[dict[str, Any]]  # {"key": {field: value}, "bucket": label | None, "metrics": {...}}
    buckets: list[tuple[str, bool]]  # (label, in_progress), ordered and zero-filled
    exact: bool
    consistency: str  # "point_in_time" | "bounded_at_start" | "unverified"
    scanned: int
    missing_created: int = 0
    other: dict[str, Any] | None = None  # the exact remainder when top_n trimmed groups
    totals: dict[str, Any] = field(default_factory=dict)  # metrics over the whole selection
    # --- additive (WP-AGG) ---
    partial: bool = False  # a store failure stopped the scan; counts cover ``scanned`` only
    error: str | None = None  # why the scan stopped (partial only)
    expected_total: int | None = None  # rows the store reported for the scan, when known
    earliest: str | None = None  # ISO UTC of the oldest dated record in the selection
    latest: str | None = None  # ISO UTC of the newest dated record in the selection
    window_label: str = ""  # the window's label, refined ("all time (since 3 Nov 2025)")
    multi_valued: tuple[str, ...] = ()  # group fields whose rows may sum past ``total``
    method: str = "fold"  # "pushdown" | "fold"
    bucket_unit: str | None = None
    # Whether ``missing_created`` is INSIDE ``total``. All time: yes (own bucket). A
    # bounded window cannot place an undatable record, so it is disclosed, not counted.
    missing_in_total: bool = True
    # Selected records whose stored document no longer validates (a status from a newer
    # version, a corrupted field) although a figure needed the full model. They are in
    # ``total`` and their raw-field group rows; their derived figures are not, so the
    # result is not exact.
    unreadable: int = 0
    # The window actually measured (aware ISO UTC; ``None`` = unbounded on that side).
    # A relative window broken down by a calendar unit is aligned to whole periods
    # (``time_windows.align_window``), so this can start later than the request.
    window_from: str | None = None
    window_to: str | None = None


@dataclass(frozen=True)
class UsageAggregateSpec:
    window: ResolvedWindow
    filters: dict[str, Any] = field(default_factory=dict)
    group_by: tuple[str, ...] = ()  # <= 2 of USAGE_GROUP_FIELDS
    bucket: BucketUnit | None = None
    metrics: tuple[str, ...] = ("calls", "total_tokens", "cost_usd")
    # --- additive (WP-AGG) ---
    top_n: int | None = None


# =========================================================================== #
# Validation
# =========================================================================== #
def validate_case_spec(spec: CaseAggregateSpec) -> None:
    """Reject an invalid spec VISIBLY (``ValueError`` naming the problem)."""
    _validate_common(spec.group_by, spec.bucket, spec.metrics, getattr(spec, "top_n", None),
                     CASE_GROUP_FIELDS, CASE_METRICS)
    _compile_case_filters(spec.filters or {}, spec.prefs)  # raises on unknown keys/values
    _check_bucket_budget(spec.window, spec.bucket)


def validate_usage_spec(spec: UsageAggregateSpec) -> None:
    _validate_common(spec.group_by, spec.bucket, spec.metrics, spec.top_n,
                     USAGE_GROUP_FIELDS, USAGE_METRICS)
    _compile_usage_filters(spec.filters or {})
    _check_bucket_budget(spec.window, spec.bucket)


def _check_bucket_budget(window: ResolvedWindow, unit: Any, *, earliest: Any = None,
                         latest: Any = None) -> None:
    """Refuse a bucket unit that would zero-fill more than :data:`MAX_RESULT_BUCKETS`
    periods (checked up front for a bounded window, after the scan for all time)."""
    if not unit or (window.start is None and earliest is None):
        return
    from .time_windows import auto_bucket, bucket_count

    count = bucket_count(window, unit, earliest=earliest, latest=latest)
    if count > MAX_RESULT_BUCKETS:
        suggestion = auto_bucket(window, earliest=earliest, latest=latest)
        raise ValueError(
            f"{count} {unit} buckets is too many for {window.label}; use {suggestion} "
            f"buckets (at most {MAX_RESULT_BUCKETS} per answer)"
        )


def _validate_common(group_by: tuple[str, ...], bucket: Any, metrics: tuple[str, ...],
                     top_n: Any, groups_allowed: tuple[str, ...],
                     metrics_allowed: tuple[str, ...]) -> None:
    if len(group_by) > MAX_GROUP_BY:
        raise ValueError(f"group_by takes at most {MAX_GROUP_BY} fields, got {len(group_by)}")
    if len(set(group_by)) != len(group_by):
        raise ValueError("group_by fields must be distinct")
    unknown = [g for g in group_by if g not in groups_allowed]
    if unknown:
        raise ValueError(
            f"Unknown group_by field(s) {unknown}; use {', '.join(groups_allowed)}"
        )
    if bucket is not None and bucket not in BUCKET_UNITS:
        raise ValueError(f"Unknown bucket {bucket!r}; use {', '.join(BUCKET_UNITS)}")
    if not metrics:
        raise ValueError("Ask for at least one metric")
    bad = [m for m in metrics if m not in metrics_allowed]
    if bad:
        raise ValueError(f"Unknown metric(s) {bad}; use {', '.join(metrics_allowed)}")
    if top_n is not None and (isinstance(top_n, bool) or int(top_n) < 1):
        raise ValueError("top_n must be a positive whole number")


# =========================================================================== #
# Per-case field values
# =========================================================================== #
def _enum(value: Any) -> str | None:
    raw = getattr(value, "value", value)
    if raw is None:
        return None
    text = str(raw)
    return text if text else None


def _validated_techniques_of(raw_ids: Any) -> list[tuple[str, list[str]]]:
    """``[(technique id, [tactics])]`` for VALIDATED ATT&CK ids (#9): an id that does not
    resolve against the bundled corpus is dropped, never echoed."""
    try:
        from . import mitre as mitre_engine
    except Exception:  # noqa: BLE001 — the corpus must never break an aggregate
        return []
    seen: dict[str, list[str]] = {}
    for raw in raw_ids or []:
        try:
            meta = mitre_engine.technique(str(raw))
        except Exception:  # noqa: BLE001
            meta = None
        if not isinstance(meta, dict):
            continue
        tid = str(meta.get("id") or "").strip().upper()
        if not tid or tid in seen:
            continue
        seen[tid] = [str(t).strip() for t in meta.get("tactics") or [] if isinstance(t, str) and t.strip()]
    return list(seen.items())


def _severity(case: Any, prefs: Any) -> str:
    try:
        from .priority import band_of_case

        band = band_of_case(case, prefs)
    except Exception:  # noqa: BLE001 — presentation only
        band = getattr(case, "severity_band", None)
    return band if band in SEVERITY_BANDS else SEVERITY_BANDS[-1]


def _priority(case: Any, prefs: Any) -> str | None:
    level = getattr(case, "priority_level", None)
    if level:
        return str(level)
    if prefs is None:
        return None
    try:
        from .priority import advisory_bands

        level = advisory_bands(case, prefs).get("priority_level")
    except Exception:  # noqa: BLE001 — presentation only
        level = None
    return str(level) if level else None


def _is_policy_closed(case: Any) -> bool:
    try:
        from .precedent import is_policy_closed

        return bool(is_policy_closed(case))
    except Exception:  # noqa: BLE001
        return False


# Model defaults for the fields the fold reads straight from a stored document (the
# raw read path). They mirror ``models.Case`` so a document and its validated model
# read the same; everything else is read from the lazily validated ``Case``.
_RAW_DEFAULTS: dict[str, Any] = {
    "status": "open", "rule_ids": [], "mitre": [], "assignee": "", "tags": [],
    "title": "", "case_number": "", "risk_score": 0.0, "case_id": "",
}


class _CaseView:
    """One case as the fold reads it — a ``Case`` or its stored JSON document.

    Plain fields (status, verdict, decider, rules, assignee, ...) are read directly;
    a validated :class:`~app.models.Case` is built LAZILY, only when a derived value
    needs the model (the severity projection, a derived priority, the analyst ground
    truth, the lifecycle clocks). Count-style folds therefore never pay for model
    validation, which dominates a full-population scan. Values are memoised per case."""

    __slots__ = ("row", "prefs", "_cache", "_case", "_invalid", "unreadable")

    def __init__(self, row: Any, prefs: Any) -> None:
        self.row = row
        self.prefs = prefs
        self._cache: dict[str, Any] = {}
        self._case = None if isinstance(row, dict) else row
        self._invalid = False
        # Set when a figure needed the validated model and the stored document did not
        # validate: the case still counts (its raw fields are readable), the figure does not.
        self.unreadable = False

    @property
    def case(self) -> Any:
        """The validated ``Case``, or ``None`` when the stored document no longer
        validates (a status written by a newer version, a corrupted field). One such
        document must never take a whole aggregate down; it is reported instead."""
        if self._case is None and not self._invalid:
            from ..models import Case

            try:
                self._case = Case.model_validate(self.row)
            except Exception:  # noqa: BLE001 — pydantic ValidationError and kin
                self._invalid = True
        if self._case is None:
            self.unreadable = True
        return self._case

    def get(self, name: str) -> Any:
        row = self.row
        if isinstance(row, dict):
            if name in row:
                return row[name]
            default = _RAW_DEFAULTS.get(name)
            return list(default) if isinstance(default, list) else default
        return getattr(row, name, None)

    def _memo(self, key: str, fn: Callable[[], Any]) -> Any:
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    @property
    def status(self) -> str:
        return self._memo("status", lambda: _enum(self.get("status")) or "")

    @property
    def terminal(self) -> bool:
        return self.status in _TERMINAL

    @property
    def active(self) -> bool:
        return self.status in _ACTIVE

    @property
    def policy_closed(self) -> bool:
        def compute() -> bool:
            if isinstance(self.row, dict):
                # ``precedent.is_policy_closed`` over the stored document: the erasable
                # decider OR the durable policy payload.
                return self.decided_by == "analyst_policy" or (
                    self.get("analyst_policy") is not None
                )
            return _is_policy_closed(self.row)

        return self._memo("policy", compute)

    @property
    def decided_by(self) -> str | None:
        return self._memo("decided_by", lambda: _enum(self.get("decision_by")))

    @property
    def verdict(self) -> str | None:
        return self._memo("verdict", lambda: _enum(self.get("verdict")))

    def techniques(self) -> list[tuple[str, list[str]]]:
        return self._memo("techniques", lambda: _validated_techniques_of(self.get("mitre")))

    def entity_value(self) -> str:
        entity = self.get("entity")
        if isinstance(entity, dict):
            return str(entity.get("value") or "")
        return str(getattr(entity, "value", "") or "")

    def severity(self) -> str | None:
        """The advisory band, or ``None`` when it needed the model and the document
        did not validate (counted as unreadable, shown as "unknown")."""
        def compute() -> str | None:
            persisted = self.get("severity_band")
            if persisted in SEVERITY_BANDS:  # band_of_case's first rule, no model needed
                return persisted
            case = self.case
            if case is None:
                return None
            return _severity(case, self.prefs)

        return self._memo("severity", compute)

    def priority(self) -> str | None:
        def compute() -> str | None:
            level = self.get("priority_level")
            if level:
                return str(level)
            if self.prefs is None:
                return None
            case = self.case
            if case is None:
                return None
            return _priority(case, self.prefs)

        return self._memo("priority", compute)

    def closed_by(self) -> str | None:
        if not self.terminal:
            return None
        if self.policy_closed:
            return "analyst_policy"
        if self.decided_by == "agent":
            return "agent"
        if self.decided_by == "analyst":
            return "analyst"
        return "system"

    def values(self, name: str) -> list[Any]:
        """The group key value(s) of ``name`` for this case (a list; ``[None]`` = none)."""
        if name == "verdict":
            return [self.verdict]
        if name == "status":
            return [self.status or None]
        if name == "status_group":
            return ["active" if self.active else "terminal" if self.terminal else None]
        if name == "severity":
            return [self.severity()]
        if name == "priority":
            return [self.priority()]
        if name == "rule":
            seen: list[str] = []
            for raw in self.get("rule_ids") or []:
                text = str(raw)
                if text not in seen:
                    seen.append(text)
            return seen or [None]
        if name == "assignee":
            return [str(self.get("assignee") or "").strip() or None]
        if name == "source":
            return [str(self.get("source_id") or "") or None]
        if name == "surface":
            return [_enum(self.get("source_surface"))]
        if name == "disposition":
            return [_enum(self.get("disposition"))]
        if name == "mitre_technique":
            return [tid for tid, _ in self.techniques()] or [None]
        if name == "mitre_tactic":
            tactics: list[str] = []
            for _tid, names in self.techniques():
                for tactic in names:
                    if tactic not in tactics:
                        tactics.append(tactic)
            return tactics or [None]
        if name == "decided_by":
            return [self.decided_by]
        if name == "closed_by":
            return [self.closed_by()]
        raise ValueError(f"Unknown group field {name!r}")


# =========================================================================== #
# Filters
# =========================================================================== #
_ASSIGNEE_NONE = frozenset({"unassigned", "none", "nobody", "(unassigned)", ""})
_STATUS_GROUP_ALIASES = {"active": "active", "open": "active", "terminal": "terminal",
                         "closed": "terminal"}


def _as_values(raw: Any) -> list[Any]:
    if isinstance(raw, (list, tuple, set, frozenset)):
        return [v for v in raw if v is not None and not (isinstance(v, str) and not v.strip())]
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return []
    return [raw]


def normalise_case_filters(filters: dict[str, Any]) -> dict[str, list[str]]:
    """Validate + normalise ``filters`` → ``{key: [allowed values]}`` (blank keys dropped).

    Raises ``ValueError`` for an unknown key or an invalid enum value."""
    out: dict[str, list[str]] = {}
    for key, raw in (filters or {}).items():
        if key not in CASE_FILTER_FIELDS:
            raise ValueError(
                f"Unknown case filter {key!r}; use {', '.join(CASE_FILTER_FIELDS)}"
            )
        values = _as_values(raw)
        if not values:
            continue
        normalised: list[str] = []
        for value in values:
            text = str(value).strip()
            if key == "status":
                from ..constants import CaseStatus

                text = text.lower().replace(" ", "_").replace("-", "_")
                if text not in {s.value for s in CaseStatus}:
                    raise ValueError(f"Unknown status {value!r}")
            elif key == "status_group":
                text = _STATUS_GROUP_ALIASES.get(text.lower(), "")
                if not text:
                    raise ValueError(f"Unknown status_group {value!r}; use active or terminal")
            elif key == "verdict":
                text = text.upper().replace(" ", "_").replace("-", "_")
                if text not in {"TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_HUMAN"}:
                    raise ValueError(f"Unknown verdict {value!r}")
            elif key == "severity":
                text = text.lower()
                if text not in SEVERITY_BANDS:
                    raise ValueError(f"Unknown severity {value!r}; use {', '.join(SEVERITY_BANDS)}")
            elif key == "priority":
                text = text.upper()
                if text not in {"P1", "P2", "P3", "P4"}:
                    raise ValueError(f"Unknown priority {value!r}; use P1, P2, P3 or P4")
            elif key in ("decided_by", "closed_by"):
                text = text.lower()
                allowed = {"agent", "analyst", "system", "analyst_policy"}
                if text not in allowed:
                    raise ValueError(f"Unknown {key} {value!r}; use {', '.join(sorted(allowed))}")
            elif key == "disposition":
                from ..constants import Disposition

                text = text.lower().replace(" ", "_").replace("-", "_")
                allowed_dispositions = [d.value for d in Disposition]
                if text not in allowed_dispositions:
                    raise ValueError(
                        f"Unknown disposition {value!r}; use {', '.join(allowed_dispositions)}"
                    )
            elif key == "surface":
                from ..constants import SourceSurface

                text = text.lower().replace(" ", "_").replace("-", "_")
                allowed_surfaces = [v.value for v in SourceSurface]
                if text not in allowed_surfaces:
                    raise ValueError(
                        f"Unknown surface {value!r}; use {', '.join(allowed_surfaces)}"
                    )
            elif key == "mitre_technique":
                text = _canonical_technique(value)
            elif key == "mitre_tactic":
                text = _canonical_tactic(value)
            normalised.append(text)
        out[key] = normalised
    if "status" in out and "status_group" in out:
        raise ValueError("Choose status or status_group, not both")
    return out


_TECHNIQUE_SHAPE = None  # compiled lazily (re)


def _canonical_technique(value: Any) -> str:
    """A filter's ATT&CK technique id as the fold reads it: the id it RESOLVES to in the
    bundled corpus (a sub-technique missing from the compact bundle resolves to its
    parent, exactly as ``Case.mitre`` values do). An id that is not shaped like one, or
    that the corpus does not know, is rejected visibly — a guess would be a confident 0."""
    import re

    global _TECHNIQUE_SHAPE
    if _TECHNIQUE_SHAPE is None:
        _TECHNIQUE_SHAPE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
    text = str(value).strip().upper()
    if not _TECHNIQUE_SHAPE.match(text):
        raise ValueError(
            f"Unknown ATT&CK technique {value!r}; use a technique id such as T1059 or T1110.001"
        )
    try:
        from . import mitre as mitre_engine

        loaded = bool(mitre_engine._load())
        meta = mitre_engine.technique(text)
    except Exception:  # noqa: BLE001 — a missing corpus must not block a valid-looking id
        return text
    if isinstance(meta, dict) and meta.get("id"):
        return str(meta["id"]).strip().upper()
    if not loaded:
        return text  # no corpus to check against: the shape is all that can be verified
    raise ValueError(
        f"Unknown ATT&CK technique {value!r}: it is not in the bundled ATT&CK corpus"
    )


def _known_tactics() -> set[str]:
    try:
        from . import mitre as mitre_engine

        corpus = mitre_engine._load()
    except Exception:  # noqa: BLE001
        return set()
    names: set[str] = set()
    for meta in corpus.values():
        for tactic in (meta.get("tactics") or []) if isinstance(meta, dict) else []:
            if isinstance(tactic, str) and tactic.strip():
                names.add(tactic.strip().lower())
    return names


def _canonical_tactic(value: Any) -> str:
    """A filter's ATT&CK tactic as the fold compares it (lower case, words separated by
    one space: "privilege_escalation" → "privilege escalation"), checked against the
    tactics of the bundled corpus."""
    text = " ".join(str(value).strip().lower().replace("_", " ").replace("-", " ").split())
    known = _known_tactics()
    if known and text not in known:
        raise ValueError(
            f"Unknown ATT&CK tactic {value!r}; use one of {', '.join(sorted(known))}"
        )
    return text


def _compile_case_filters(filters: dict[str, Any], prefs: Any) -> Callable[[_CaseView], bool]:
    """One predicate over a :class:`_CaseView` implementing the filters (no window)."""
    norm = normalise_case_filters(filters)
    del prefs
    checks: list[Callable[[_CaseView], bool]] = []
    for key, values in norm.items():
        wanted = set(values)
        if key == "status":
            checks.append(lambda v, w=wanted: v.status in w)
        elif key == "status_group":
            checks.append(lambda v, w=wanted: v.values("status_group")[0] in w)
        elif key == "verdict":
            checks.append(lambda v, w=wanted: v.verdict in w)
        elif key == "entity":
            checks.append(lambda v, w=wanted: v.entity_value() in w)
        elif key == "severity":
            checks.append(lambda v, w=wanted: v.severity() in w)
        elif key == "priority":
            checks.append(lambda v, w=wanted: v.priority() in w)
        elif key == "assignee":
            lowered = {x.lower() for x in values}
            want_none = bool(lowered & _ASSIGNEE_NONE)
            names = lowered - _ASSIGNEE_NONE

            def _assignee(v: _CaseView, names: set[str] = names, want_none: bool = want_none) -> bool:
                actual = str(v.get("assignee") or "").strip().lower()
                return (want_none and not actual) or (bool(actual) and actual in names)

            checks.append(_assignee)
        elif key == "rule":
            lowered = {x.lower() for x in values}
            checks.append(lambda v, w=lowered: bool(
                {str(r).lower() for r in v.get("rule_ids") or []} & w
            ))
        elif key == "source":
            lowered = {x.lower() for x in values}

            def _source(v: _CaseView, w: set[str] = wanted, low: set[str] = lowered) -> bool:
                sid = str(v.get("source_id") or "")
                name = str(v.get("source_name") or "").strip().lower()
                return sid in w or (bool(name) and name in low)

            checks.append(_source)
        elif key == "surface":
            checks.append(lambda v, w=wanted: _enum(v.get("source_surface")) in w)
        elif key == "disposition":
            checks.append(lambda v, w=wanted: (_enum(v.get("disposition")) or "") in w)
        elif key == "decided_by":
            checks.append(lambda v, w=wanted: v.decided_by in w)
        elif key == "closed_by":
            checks.append(lambda v, w=wanted: v.closed_by() in w)
        elif key == "mitre_technique":
            checks.append(lambda v, w=wanted: bool({t for t, _ in v.techniques()} & w))
        elif key == "mitre_tactic":
            lowered = {x.lower() for x in values}
            checks.append(lambda v, w=lowered: bool(
                {t.lower() for _, names in v.techniques() for t in names} & w
            ))
        elif key == "text":
            needles = [x.lower() for x in values]

            def _text(v: _CaseView, needles: list[str] = needles) -> bool:
                hay = " ".join(str(x) for x in (
                    v.get("case_id"), v.get("case_number"), v.get("title"), v.entity_value(),
                    v.get("source_name"), " ".join(str(t) for t in v.get("tags") or []),
                    " ".join(str(r) for r in v.get("rule_ids") or []),
                ) if x).lower()
                return any(n in hay for n in needles)

            checks.append(_text)

    def predicate(view: _CaseView) -> bool:
        return all(check(view) for check in checks)

    return predicate


# =========================================================================== #
# Accumulators
# =========================================================================== #
class _Acc:
    """The counters for one result row (or the totals). Merges exactly."""

    __slots__ = ("count", "auto_closed", "human_closed", "verdicted", "fp", "tp",
                 "analyst_fp", "risk_sum", "risk_n", "open", "mtta", "mttr", "mttd")

    def __init__(self) -> None:
        self.count = 0
        self.auto_closed = 0
        self.human_closed = 0
        self.verdicted = 0
        self.fp = 0
        self.tp = 0
        self.analyst_fp = 0
        self.risk_sum = 0.0
        self.risk_n = 0
        self.open = 0
        self.mtta: list[float] = []
        self.mttr: list[float] = []
        self.mttd: list[float] = []

    def add(self, facts: "_Facts") -> None:
        self.count += 1
        self.auto_closed += facts.auto_closed
        self.human_closed += facts.human_closed
        self.verdicted += facts.verdicted
        self.fp += facts.fp
        self.tp += facts.tp
        self.analyst_fp += facts.analyst_fp
        if facts.risk is not None:
            self.risk_sum += facts.risk
            self.risk_n += 1
        self.open += facts.open
        if facts.mtta is not None:
            self.mtta.append(facts.mtta)
        if facts.mttr is not None:
            self.mttr.append(facts.mttr)
        if facts.mttd is not None:
            self.mttd.append(facts.mttd)

    def add_counts(self, count: int, open_count: int = 0) -> None:
        """Push-down entry point: ``count`` cases of which ``open_count`` are active."""
        self.count += int(count)
        self.open += int(open_count)

    def merge(self, other: "_Acc") -> None:
        for name in ("count", "auto_closed", "human_closed", "verdicted", "fp", "tp",
                     "analyst_fp", "risk_n", "open"):
            setattr(self, name, getattr(self, name) + getattr(other, name))
        self.risk_sum += other.risk_sum
        self.mtta.extend(other.mtta)
        self.mttr.extend(other.mttr)
        self.mttd.extend(other.mttd)

    def result(self, metrics: tuple[str, ...], *, open_now: int | None = None) -> dict[str, Any]:
        from .metrics import percentile

        out: dict[str, Any] = {}
        for name in metrics:
            if name == "count":
                out["count"] = self.count
            elif name == "auto_closed":
                out["auto_closed"] = self.auto_closed
            elif name == "human_closed":
                out["human_closed"] = self.human_closed
            elif name == "fp_rate":
                out["fp_rate"] = round(self.fp / self.verdicted, 4) if self.verdicted else None
                out["false_positives"] = self.fp
                out["verdicted"] = self.verdicted
            elif name == "tp_rate":
                out["tp_rate"] = round(self.tp / self.verdicted, 4) if self.verdicted else None
                out["true_positives"] = self.tp
                out["verdicted"] = self.verdicted
            elif name == "analyst_fp":
                out["analyst_fp"] = self.analyst_fp
            elif name in _PERCENTILE_METRICS:
                series, pct = _PERCENTILE_METRICS[name]
                samples = getattr(self, series)
                value = percentile(samples, pct) if samples else None
                out[name] = round(value, 1) if value is not None else None
                out[f"{series}_samples"] = len(samples)
            elif name == "mean_risk":
                out["mean_risk"] = round(self.risk_sum / self.risk_n, 1) if self.risk_n else None
            elif name == "open_now":
                out["open_now"] = int(open_now if open_now is not None else self.open)
        return out


@dataclass
class _Facts:
    auto_closed: int = 0
    human_closed: int = 0
    verdicted: int = 0
    fp: int = 0
    tp: int = 0
    analyst_fp: int = 0
    risk: float | None = None
    open: int = 0
    mtta: float | None = None
    mttr: float | None = None
    mttd: float | None = None


def _facts(view: _CaseView, metrics: frozenset[str]) -> _Facts:
    """Everything one case contributes, computed once, only for requested metrics."""
    facts = _Facts()
    facts.open = 1 if view.active else 0
    if metrics & {"auto_closed", "human_closed"} and view.terminal and not view.policy_closed:
        facts.auto_closed = 1 if view.decided_by == "agent" else 0
        facts.human_closed = 1 if view.decided_by == "analyst" else 0
    if metrics & {"fp_rate", "tp_rate"} and not view.policy_closed:
        verdict = view.verdict
        if verdict is not None:
            facts.verdicted = 1
            facts.fp = 1 if verdict == "FALSE_POSITIVE" else 0
            facts.tp = 1 if verdict == "TRUE_POSITIVE" else 0
    # The dashboards' population (``quality_metrics.analyst_confirmed_fp`` and every
    # trend bucket): analyst-rule-policy closes are outside the agent's measured work
    # and are excluded here too, so chat and the dashboard report the same number.
    if "analyst_fp" in metrics and not view.policy_closed:
        case = view.case
        outcome = None
        if case is not None:
            try:
                from .analyst_outcomes import analyst_confirmed_outcome

                outcome, _source = analyst_confirmed_outcome(case)
            except Exception:  # noqa: BLE001 — a malformed case is not ground truth
                outcome = None
        facts.analyst_fp = 1 if outcome == "false_positive" else 0
    if "mean_risk" in metrics:
        risk = view.get("risk_score")
        if isinstance(risk, (int, float)) and not isinstance(risk, bool) and math.isfinite(risk):
            facts.risk = float(risk)
    if metrics & set(_PERCENTILE_METRICS):
        case = view.case
        if case is not None:
            facts.mtta, facts.mttr, facts.mttd = _intervals(case)
    return facts


def _intervals(case: Any) -> tuple[float | None, float | None, float | None]:
    """``(mtta, mttr, mttd)`` minutes for one case — ``metrics.lifecycle_intervals``'
    per-case rules, verbatim (MTTA = human acknowledgement only)."""
    from .metrics import _CaseTimings, _resolved_dt

    try:
        timings = _CaseTimings(case)
    except Exception:  # noqa: BLE001 — a malformed case contributes nothing
        return None, None, None
    mttd = None
    fs = getattr(case, "first_seen_millis", 0) or 0
    if isinstance(fs, (int, float)) and not isinstance(fs, bool) and fs > 0:
        created = timings.created_iso
        if created is not None:
            created_ms = created.timestamp() * 1000.0
            if created_ms >= fs:
                mttd = (created_ms - fs) / 60000.0
    start = timings.created
    if start is None:
        return None, None, mttd
    mtta = mttr = None
    ack = timings.ack_anchor or timings.ack_human
    if ack and ack >= start:
        mtta = (ack - start).total_seconds() / 60.0
    end = _resolved_dt(case, timings)
    if end and end >= start:
        mttr = (end - start).total_seconds() / 60.0
    return mtta, mttr, mttd


# =========================================================================== #
# Shared result assembly (fold and push-downs)
# =========================================================================== #
@dataclass
class RowSet:
    """Raw aggregation state handed to :func:`build_case_result` by the fold and by a
    repository push-down. ``rows`` keys are ``(group key tuple, bucket key)`` where the
    bucket key is a bucket START (aware UTC datetime), :data:`MISSING_BUCKET`, or
    ``None`` (no bucketing)."""

    rows: dict[tuple[tuple[Any, ...], Any], _Acc] = field(default_factory=dict)
    open_by_group: dict[tuple[Any, ...], int] = field(default_factory=dict)
    totals: _Acc = field(default_factory=_Acc)
    total: int = 0
    open_total: int = 0
    missing: int = 0
    earliest: datetime | None = None
    latest: datetime | None = None
    scanned: int = 0
    unreadable: int = 0

    def acc(self, gkey: tuple[Any, ...], bkey: Any) -> _Acc:
        found = self.rows.get((gkey, bkey))
        if found is None:
            found = _Acc()
            self.rows[(gkey, bkey)] = found
        return found

    def note_created(self, created: datetime) -> None:
        if self.earliest is None or created < self.earliest:
            self.earliest = created
        if self.latest is None or created > self.latest:
            self.latest = created


def _key_sort(gkey: tuple[Any, ...]) -> tuple:
    return tuple((value is None, str(value) if value is not None else "") for value in gkey)


def build_case_result(
    spec: CaseAggregateSpec,
    state: RowSet,
    *,
    exact: bool,
    consistency: str,
    method: str,
    partial: bool = False,
    error: str | None = None,
    expected_total: int | None = None,
    missing_label: str = MISSING_BUCKET,
    metrics_allowed: tuple[str, ...] | None = None,
) -> AggregateResult:
    """Turn raw aggregation state into the public :class:`AggregateResult` (zero-filled
    buckets, ranked groups, the exact ``Other`` remainder, totals).

    Raises :class:`BucketMismatch` when a row's bucket key is neither one of the
    calendar starts nor the missing-date bucket: a push-down then declines (the engine
    folds) instead of silently losing those rows from the chart."""
    metrics = tuple(dict.fromkeys(spec.metrics))
    window = spec.window
    unit = spec.bucket
    group_by = tuple(spec.group_by)
    want_open = "open_now" in metrics
    _check_bucket_budget(window, unit, earliest=state.earliest, latest=state.latest)
    calendar = (
        calendar_buckets(window, unit, earliest=state.earliest, latest=state.latest)
        if unit else []
    )
    bucket_keys: list[Any] = [b.start for b in calendar]
    missing_in_total = _missing_in_total(window)
    if unit and state.missing and missing_in_total:
        bucket_keys.append(missing_label)
    if unit:
        _check_aligned(state.rows, bucket_keys)

    # Rank group keys by count (then open stock), deterministically.
    count_by: dict[tuple[Any, ...], int] = {}
    for (gkey, _bkey), acc in state.rows.items():
        count_by[gkey] = count_by.get(gkey, 0) + acc.count
    if not unit and want_open:
        for gkey in state.open_by_group:
            count_by.setdefault(gkey, 0)
    if not group_by:
        count_by.setdefault((), state.total)
    ranked = sorted(
        count_by,
        key=lambda g: (-count_by[g], -state.open_by_group.get(g, 0), _key_sort(g)),
    )
    top_n = getattr(spec, "top_n", None)
    kept = ranked[: int(top_n)] if group_by and top_n else ranked
    trimmed = ranked[len(kept):] if group_by and top_n else []

    def row_open(gkey: tuple[Any, ...], acc: _Acc) -> int | None:
        if not want_open:
            return None
        if unit:
            return acc.open
        return state.open_by_group.get(gkey, 0) if group_by else state.open_total

    labels = {b.start: (b.label, b.in_progress, b.clipped) for b in calendar}
    groups: list[dict[str, Any]] = []

    def emit(gkey: tuple[Any, ...], bkey: Any, acc: _Acc, *, other: bool = False,
             open_override: int | None = None) -> None:
        key = {f: (OTHER_KEY if other else value) for f, value in zip(group_by, gkey)}
        row: dict[str, Any] = {"key": key}
        if unit:
            if bkey == missing_label:
                row.update(bucket=missing_label, bucket_start=None, in_progress=False)
            else:
                label, in_progress, clipped = labels.get(bkey, ("", False, False))
                row.update(bucket=label, bucket_start=bkey.isoformat(),
                           in_progress=in_progress, clipped=clipped)
        else:
            row["bucket"] = None
        open_value = open_override if open_override is not None else row_open(gkey, acc)
        row["metrics"] = acc.result(metrics, open_now=open_value)
        if other:
            row["other"] = True
        groups.append(row)

    if not group_by and not unit:
        emit((), None, state.totals, open_override=state.open_total if want_open else None)
    else:
        for gkey in kept:
            if unit:
                for bkey in bucket_keys:
                    emit(gkey, bkey, state.rows.get((gkey, bkey)) or _Acc())
            else:
                emit(gkey, None, state.rows.get((gkey, None)) or _Acc())

    other: dict[str, Any] | None = None
    if trimmed:
        merged_all = _Acc()
        trimmed_open = sum(state.open_by_group.get(g, 0) for g in trimmed)
        filler = tuple(OTHER_KEY for _ in group_by)
        if unit:
            for bkey in bucket_keys:
                merged = _Acc()
                for gkey in trimmed:
                    acc = state.rows.get((gkey, bkey))
                    if acc is not None:
                        merged.merge(acc)
                merged_all.merge(merged)
                emit(filler, bkey, merged, other=True)
        else:
            for gkey in trimmed:
                acc = state.rows.get((gkey, None))
                if acc is not None:
                    merged_all.merge(acc)
            emit(filler, None, merged_all, other=True,
                 open_override=trimmed_open if want_open else None)
        other = {
            "groups": len(trimmed),
            "metrics": merged_all.result(
                metrics,
                open_now=(trimmed_open if not unit else merged_all.open) if want_open else None,
            ),
        }

    totals = state.totals.result(metrics, open_now=state.open_total if want_open else None)
    totals["count"] = state.total
    label = window.label
    if window.is_all_time and window.token == "all":
        label = all_time_label(state.earliest, window.tz)
    multi = tuple(f for f in group_by if f in MULTI_VALUED_FIELDS)
    del metrics_allowed
    return AggregateResult(
        total=state.total,
        groups=groups,
        buckets=[(b.label, b.in_progress) for b in calendar],
        exact=bool(exact and not partial and not state.unreadable),
        consistency=consistency,
        scanned=state.scanned,
        missing_created=state.missing,
        other=other,
        totals=totals,
        partial=partial,
        error=error,
        expected_total=expected_total,
        earliest=state.earliest.isoformat() if state.earliest else None,
        latest=state.latest.isoformat() if state.latest else None,
        window_label=label,
        multi_valued=multi,
        method=method,
        bucket_unit=unit,
        missing_in_total=missing_in_total,
        unreadable=state.unreadable,
        window_from=window.iso_from(),
        window_to=window.iso_to(),
    )


def _missing_in_total(window: ResolvedWindow) -> bool:
    """Does an undatable record belong to ``window``? Only to an unbounded one (all
    time). A bounded window cannot place it, so — exactly like the dashboards' window
    filter — it is not counted there; ``missing_created`` discloses it instead (never
    silently dropped, never invented into a period)."""
    return window.start is None and window.open_end


def _check_aligned(rows: dict[tuple[tuple[Any, ...], Any], Any], bucket_keys: list[Any]) -> None:
    allowed = set(bucket_keys)
    for (_gkey, bkey) in rows:
        if bkey not in allowed:
            raise BucketMismatch(
                f"a bucket key {bkey!r} is not one of the calendar periods of this window"
            )


# =========================================================================== #
# Paged scanning (shared by the fold and the dashboards)
# =========================================================================== #
@dataclass
class ScanOutcome:
    scanned: int = 0
    expected_total: int | None = None
    consistency: str = "point_in_time"
    complete: bool = True
    error: str | None = None
    pages: int = 0
    # The repository honoured ``newest_first`` (rows arrived newest-first by created_at).
    newest_first: bool = False
    # The caller's ``stop()`` ended the scan before the repository was exhausted.
    stopped: bool = False


def _weaker(current: str, observed: Any) -> str:
    observed = str(observed or "unverified")
    if observed not in _CONSISTENCY_RANK:
        observed = "unverified"
    return observed if _CONSISTENCY_RANK[observed] > _CONSISTENCY_RANK[current] else current


def _accepted_kwargs(fn: Any, wanted: dict[str, Any]) -> dict[str, Any]:
    """The subset of ``wanted`` keyword arguments ``fn`` declares (optional scan
    features a repository may or may not implement)."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):  # pragma: no cover — uninspectable callable
        return {}
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(wanted)
    return {k: v for k, v in wanted.items() if k in params}


async def _close_cursor(store: Any, cursor: Any) -> None:
    """Release an unfinished scan cursor. ``close_scan_cursor`` when the repository has
    it (it knows its own cursor shape); otherwise ``close_export_cursor``, unwrapping the
    base ``scan_page``'s ``{"inner": export cursor}`` wrapper so a repository-owned
    snapshot is released, not leaked."""
    closer = getattr(store, "close_scan_cursor", None)
    if not callable(closer):
        closer = getattr(store, "close_export_cursor", None)
        if isinstance(cursor, dict) and set(cursor) == {"inner"}:
            cursor = cursor["inner"]
            if cursor is None:
                return
    if callable(closer):
        try:
            await closer(cursor)
        except Exception:  # noqa: BLE001 — snapshots also expire on their own
            pass


async def scan_cases(
    store: Any,
    consume: Callable[[list[Any]], Any],
    *,
    page_size: int = PAGE_SIZE,
    created_from: datetime | None = None,
    created_to: datetime | None = None,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
    raw: bool = False,
    statuses: Any = None,
    newest_first: bool = False,
    stop: Callable[[], bool] | None = None,
) -> ScanOutcome:
    """Feed every case page of ``store`` to ``consume`` (sync or async).

    ``raw=True`` asks a repository whose ``scan_page`` accepts ``raw`` for the stored
    JSON documents instead of validated ``Case`` objects (the fold's fast path; rows
    may then be either). ``statuses`` (an iterable of status values) and
    ``newest_first`` are passed on to a ``scan_page`` that declares them — a status
    pre-filter and a newest-first order; a repository without them over-keeps and
    keeps its own order, so the CONSUMER must still apply its own exact predicate and
    must not rely on the order unless ``ScanOutcome.newest_first`` says it held.
    ``stop()`` is checked after every page: True ends the scan early (complete=False is
    NOT set — the caller asked to stop; ``stopped`` says so).

    Uses the repository's ``scan_page`` (half-open ``[created_from, created_to)`` window
    pre-filter, never-drop for unparseable timestamps) when it exists, else
    ``export_page`` over the whole store; either way the CONSUMER must still apply its
    own exact predicate (a pre-filter may over-keep, never under-keep). Raises the
    store's exception when the FIRST page fails; a later failure ends the scan with
    ``complete=False`` and the error. ``cancel`` is checked before every page and raises
    :class:`AggregationCancelled`; the repository cursor is always released."""
    outcome = ScanOutcome()
    scan_page = getattr(store, "scan_page", None)
    use_scan = callable(scan_page)
    scan_kwargs: dict[str, Any] = {}
    if use_scan:
        optional: dict[str, Any] = {}
        if raw:
            optional["raw"] = True
        if statuses is not None:
            optional["statuses"] = sorted({str(s) for s in statuses})
        if newest_first:
            optional["newest_first"] = True
        scan_kwargs = _accepted_kwargs(scan_page, optional)
    outcome.newest_first = bool(scan_kwargs.get("newest_first"))
    cursor: Any = None
    open_cursor: Any = None
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise AggregationCancelled("the aggregation was cancelled")
            try:
                if use_scan:
                    rows, nxt, total, consistency = await scan_page(
                        limit=page_size, cursor=cursor,
                        created_from=created_from, created_to=created_to, **scan_kwargs,
                    )
                elif callable(getattr(store, "export_page", None)):
                    rows, nxt, total, consistency = await store.export_page(
                        limit=page_size, cursor=cursor,
                    )
                else:
                    rows, nxt, total, consistency = await _list_page(store, page_size, cursor)
            except AggregationCancelled:
                raise
            except Exception as exc:  # noqa: BLE001 — classified below
                if outcome.pages == 0:
                    raise
                logger.warning("case scan stopped after %d rows: %s", outcome.scanned, exc)
                outcome.complete = False
                outcome.error = str(exc) or exc.__class__.__name__
                break
            open_cursor = nxt
            outcome.pages += 1
            rows = list(rows or [])
            outcome.scanned += len(rows)
            if total is not None:
                outcome.expected_total = int(total)
            outcome.consistency = _weaker(outcome.consistency, consistency)
            if rows:
                result = consume(rows)
                if inspect.isawaitable(result):
                    await result
            if progress is not None:
                await progress(outcome.scanned, outcome.expected_total)
            if nxt is None:
                break
            if not use_scan and not rows:
                break
            if nxt == cursor:  # a repository that cannot advance: never spin
                break
            if stop is not None and stop():
                outcome.stopped = True
                break
            cursor = nxt
    finally:
        if open_cursor is not None:
            await _close_cursor(store, open_cursor)
    return outcome


async def _list_page(store: Any, limit: int, cursor: Any) -> tuple[list[Any], Any, int, str]:
    """The base ``export_page`` contract over a duck-typed store that only has ``list``
    (oldest first by ``created_at``, offset-paged; values may move between pages)."""
    try:
        offset = max(0, int(cursor or 0))
    except (TypeError, ValueError):
        offset = 0
    rows, total = await store.list(
        limit=max(1, int(limit)), offset=offset, sort_field="created_at", sort_order="asc",
    )
    rows = list(rows or [])
    nxt = offset + len(rows) if rows and offset + len(rows) < int(total) else None
    return rows, nxt, int(total), "bounded_at_start"


def iso_bound(value: Any) -> str | None:
    """A window bound as one ISO-8601 UTC spelling (``None`` passes through).

    The bundled stores compare ``created_at`` against this string (SQL lexicographic on
    the canonical column, Elasticsearch as a date), so every bound is normalised to the
    exact form ``datetime.isoformat()`` writes for an aware UTC instant."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    parsed = parse_es_timestamp(value)
    if parsed is None:
        raise ValueError(f"Unreadable time bound {value!r}")
    return parsed.astimezone(timezone.utc).isoformat()


def _created_of(row: Any) -> datetime | None:
    """The creation instant of a ``Case`` or stored document (``None`` = unreadable or
    absent — counted in ``missing_created``, never placed in time by guesswork)."""
    raw = row.get("created_at") if isinstance(row, dict) else getattr(row, "created_at", None)
    try:
        return parse_es_timestamp(raw)
    except (ValueError, OverflowError, OSError, TypeError):
        return None


# =========================================================================== #
# aggregate_cases
# =========================================================================== #
def _aligned_spec(spec: Any) -> Any:
    """``spec`` with its window aligned to whole calendar periods of its bucket
    (``time_windows.align_window``: "by month for the last 12 months" is 12 months)."""
    unit = getattr(spec, "bucket", None)
    if not unit:
        return spec
    aligned = align_window(spec.window, unit)
    if aligned is spec.window:
        return spec
    from dataclasses import replace

    return replace(spec, window=aligned)


async def aggregate_cases(
    store: Any,
    spec: CaseAggregateSpec,
    *,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
) -> AggregateResult:
    """Exact aggregate over every case matching ``spec`` (see the module docstring).

    A relative window broken down by a calendar ``bucket`` is first aligned to whole
    periods (``time_windows.align_window``); the result's ``window_label`` /
    ``window_from`` say what was measured.

    Raises ``ValueError`` for an invalid spec, :class:`AggregationCancelled` on cancel,
    and the store's error when not even the first page could be read."""
    spec = _aligned_spec(spec)
    validate_case_spec(spec)
    if cancel is not None and cancel.is_set():
        raise AggregationCancelled("the aggregation was cancelled")
    pushdown = getattr(store, "aggregate", None)
    if callable(pushdown):
        try:
            pushed = await pushdown(spec)
        except NotImplementedError:
            pushed = None
        except BucketMismatch as exc:
            logger.warning("case aggregate push-down buckets did not align; folding: %s", exc)
            pushed = None
        except ValueError:
            raise  # an invalid request (e.g. too many buckets): the fold would say the same
        except Exception as exc:  # noqa: BLE001 — a push-down glitch falls back to the fold
            logger.warning("case aggregate push-down failed; folding instead: %s", exc)
            pushed = None
        if isinstance(pushed, AggregateResult):
            if progress is not None:
                await progress(pushed.scanned, pushed.scanned)
            return pushed
    return await fold_cases(store, spec, progress=progress, cancel=cancel)


def _scan_statuses(filters: dict[str, list[str]]) -> set[str] | None:
    """The status values a case must have to match ``filters`` (normalised), or
    ``None`` when every status can match — the scan's status pre-filter."""
    if "status" in filters:
        return set(filters["status"])
    if "status_group" in filters:
        out: set[str] = set()
        for group in filters["status_group"]:
            out |= _ACTIVE if group == "active" else _TERMINAL if group == "terminal" else set()
        return out
    return None


async def _open_stock(
    store: Any, spec: CaseAggregateSpec, *, cancel: asyncio.Event | None,
) -> AggregateResult | None:
    """The window-EXEMPT open stock behind ``open_now``: every case matching the
    filters that is in an active status NOW, whenever it was created — grouped like
    ``spec`` when ``spec`` is not bucketed. ``None`` when the filters exclude every
    active status (the stock is then exactly 0).

    It is its own aggregate (a COUNT push-down on the bundled backends; otherwise a
    fold whose scan is pre-filtered to the active statuses), so asking for ``open_now``
    never turns a windowed question into a whole-store scan."""
    norm = normalise_case_filters(spec.filters or {})
    wanted = _scan_statuses(norm)
    statuses = sorted(_ACTIVE if wanted is None else (wanted & _ACTIVE))
    if not statuses:
        return None
    filters = {k: v for k, v in (spec.filters or {}).items() if k not in ("status", "status_group")}
    filters["status"] = statuses
    from .time_windows import resolve_window

    stock_spec = CaseAggregateSpec(
        window=resolve_window("all", tz=spec.window.tz, now=spec.window.now),
        filters=filters,
        group_by=tuple(spec.group_by) if not spec.bucket else (),
        metrics=("count",),
        prefs=spec.prefs,
    )
    return await aggregate_cases(store, stock_spec, cancel=cancel)


async def fold_cases(
    store: Any,
    spec: CaseAggregateSpec,
    *,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
) -> AggregateResult:
    """The streaming fold (always available; also the push-downs' reference).

    Window membership is the dashboards' rule: a dated case is inside when its
    ``created_at`` is in ``[start, end)``; an undatable one only in an unbounded (all
    time) window, and otherwise disclosed in ``missing_created``. The window and any
    status filter are pushed into the scan; the ``open_now`` stock is a separate
    aggregate (:func:`_open_stock`)."""
    spec = _aligned_spec(spec)
    validate_case_spec(spec)
    window = spec.window
    zone, _ = zone_for(window.tz)
    metrics = frozenset(spec.metrics)
    want_open = "open_now" in metrics
    norm = normalise_case_filters(spec.filters or {})
    predicate = _compile_case_filters(spec.filters or {}, spec.prefs)
    group_by = tuple(spec.group_by)
    unit = spec.bucket
    missing_counts = _missing_in_total(window)
    state = RowSet()

    def consume(page: list[Any]) -> None:
        for case in page:
            created = _created_of(case)
            inside = missing_counts if created is None else window.contains(created)
            if created is not None and not inside:
                continue  # the scan pre-filter may over-keep; this is the exact rule
            view = _CaseView(case, spec.prefs)
            if not predicate(view):
                if view.unreadable and inside:
                    state.unreadable += 1  # it may have matched: the figures are not exact
                continue
            if not inside:  # undatable, bounded window: disclosed, not counted
                state.missing += 1
                continue
            facts = _facts(view, metrics)
            gkeys = list(product(*(view.values(f) for f in group_by))) if group_by else [()]
            if view.unreadable:
                state.unreadable += 1
            state.total += 1
            state.totals.add(facts)
            if created is None:
                state.missing += 1
                bkey: Any = MISSING_BUCKET if unit else None
            else:
                state.note_created(created)
                bkey = period_start(created, unit, zone) if unit else None
            for gkey in dict.fromkeys(gkeys):
                state.acc(gkey, bkey).add(facts)

    outcome = await scan_cases(
        store, consume,
        created_from=window.start,
        created_to=None if window.open_end else window.end,
        progress=progress, cancel=cancel, raw=True, statuses=_scan_statuses(norm),
    )
    state.scanned = outcome.scanned
    exact = outcome.complete
    consistency = outcome.consistency
    partial = not outcome.complete
    error = outcome.error
    if want_open:
        stock = await _open_stock(store, spec, cancel=cancel)
        if stock is not None:
            state.open_total = int(stock.total)
            if not unit and group_by:
                for row in stock.groups:
                    key = row.get("key") or {}
                    gkey = tuple(key.get(f) for f in group_by)
                    state.open_by_group[gkey] = (
                        state.open_by_group.get(gkey, 0) + int((row.get("metrics") or {}).get("count", 0))
                    )
            exact = exact and stock.exact
            consistency = _weaker(consistency, stock.consistency)
            state.unreadable += int(stock.unreadable)
            if stock.partial:
                partial = True
                error = error or stock.error
    return build_case_result(
        spec, state,
        exact=exact,
        consistency=consistency,
        method="fold",
        partial=partial,
        error=error,
        expected_total=outcome.expected_total,
    )


# =========================================================================== #
# Usage
# =========================================================================== #
def _usage_tier(value: Any) -> str:
    tier = str(value or "").strip().lower()
    return tier if tier in ("standard", "flex", "batch") else "unconfirmed"


def _usage_provider(model: Any) -> str:
    try:
        from ..llm.pricing import provider_for

        return provider_for(str(model or ""))
    except Exception:  # noqa: BLE001
        return "other"


def usage_values(row: dict[str, Any], name: str) -> Any:
    """The group value of ``name`` for one ledger row (``None`` = not recorded)."""
    if name == "provider":
        return _usage_provider(row.get("model"))
    if name == "service_tier":
        return _usage_tier(row.get("processing_tier"))
    value = row.get(name)
    text = str(value) if value is not None else ""
    return text if text else None


def _compile_usage_filters(filters: dict[str, Any]) -> Callable[[dict[str, Any]], bool]:
    checks: list[Callable[[dict[str, Any]], bool]] = []
    for key, raw in (filters or {}).items():
        if key not in USAGE_FILTER_FIELDS:
            raise ValueError(
                f"Unknown usage filter {key!r}; use {', '.join(USAGE_FILTER_FIELDS)}"
            )
        values = {str(v).strip() for v in _as_values(raw)}
        if not values:
            continue
        if key == "service_tier":
            values = {v.lower() for v in values}
        if key == "case_id":
            checks.append(lambda r, w=values: str(r.get("case_id") or "") in w)
        else:
            checks.append(lambda r, k=key, w=values: (usage_values(r, k) or "") in w)
    return lambda row: all(check(row) for check in checks)


class _UsageAcc:
    __slots__ = ("calls", "input_tokens", "output_tokens", "total_tokens", "cost")

    def __init__(self) -> None:
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.total_tokens = 0
        self.cost = 0.0

    def add_row(self, row: dict[str, Any]) -> None:
        self.calls += 1
        self.input_tokens += _int(row.get("prompt_tokens"))
        self.output_tokens += _int(row.get("completion_tokens"))
        self.total_tokens += _int(row.get("total_tokens"))
        self.cost += _float(row.get("cost"))

    def add_sums(self, calls: int, input_tokens: int, output_tokens: int, total_tokens: int,
                 cost: float) -> None:
        self.calls += int(calls)
        self.input_tokens += int(input_tokens)
        self.output_tokens += int(output_tokens)
        self.total_tokens += int(total_tokens)
        self.cost += float(cost)

    def merge(self, other: "_UsageAcc") -> None:
        self.add_sums(other.calls, other.input_tokens, other.output_tokens,
                      other.total_tokens, other.cost)

    def result(self, metrics: tuple[str, ...]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name in metrics:
            if name == "calls":
                out["calls"] = self.calls
            elif name == "input_tokens":
                out["input_tokens"] = self.input_tokens
            elif name == "output_tokens":
                out["output_tokens"] = self.output_tokens
            elif name == "total_tokens":
                out["total_tokens"] = self.total_tokens
            elif name == "cost_usd":
                out["cost_usd"] = round(self.cost, 6)
        return out


def _int(value: Any) -> int:
    try:
        if isinstance(value, bool):
            return 0
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        number = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


@dataclass
class UsageRowSet:
    rows: dict[tuple[tuple[Any, ...], Any], _UsageAcc] = field(default_factory=dict)
    totals: _UsageAcc = field(default_factory=_UsageAcc)
    missing: int = 0
    earliest: datetime | None = None
    latest: datetime | None = None
    scanned: int = 0

    def acc(self, gkey: tuple[Any, ...], bkey: Any) -> _UsageAcc:
        found = self.rows.get((gkey, bkey))
        if found is None:
            found = _UsageAcc()
            self.rows[(gkey, bkey)] = found
        return found

    def note_ts(self, ts: datetime) -> None:
        if self.earliest is None or ts < self.earliest:
            self.earliest = ts
        if self.latest is None or ts > self.latest:
            self.latest = ts


def build_usage_result(
    spec: UsageAggregateSpec,
    state: UsageRowSet,
    *,
    exact: bool,
    consistency: str,
    method: str,
    partial: bool = False,
    error: str | None = None,
    expected_total: int | None = None,
) -> AggregateResult:
    metrics = tuple(dict.fromkeys(spec.metrics))
    window = spec.window
    unit = spec.bucket
    group_by = tuple(spec.group_by)
    _check_bucket_budget(window, unit, earliest=state.earliest, latest=state.latest)
    calendar = (
        calendar_buckets(window, unit, earliest=state.earliest, latest=state.latest)
        if unit else []
    )
    bucket_keys: list[Any] = [b.start for b in calendar]
    missing_in_total = _missing_in_total(window)
    if unit and state.missing and missing_in_total:
        bucket_keys.append(MISSING_USAGE_BUCKET)
    if unit:
        _check_aligned(state.rows, bucket_keys)
    weight: dict[tuple[Any, ...], tuple[float, int]] = {}
    for (gkey, _bkey), acc in state.rows.items():
        cost, calls = weight.get(gkey, (0.0, 0))
        weight[gkey] = (cost + acc.cost, calls + acc.calls)
    if not group_by:
        weight.setdefault((), (state.totals.cost, state.totals.calls))
    # Usage groups rank by spend first (the question cost surfaces answer), then calls.
    ranked = sorted(weight, key=lambda g: (-round(weight[g][0], 9), -weight[g][1], _key_sort(g)))
    top_n = spec.top_n
    kept = ranked[: int(top_n)] if group_by and top_n else ranked
    trimmed = ranked[len(kept):] if group_by and top_n else []
    labels = {b.start: (b.label, b.in_progress, b.clipped) for b in calendar}
    groups: list[dict[str, Any]] = []

    def emit(gkey: tuple[Any, ...], bkey: Any, acc: _UsageAcc, *, other: bool = False) -> None:
        row: dict[str, Any] = {
            "key": {f: (OTHER_KEY if other else v) for f, v in zip(group_by, gkey)},
        }
        if unit:
            if bkey == MISSING_USAGE_BUCKET:
                row.update(bucket=MISSING_USAGE_BUCKET, bucket_start=None, in_progress=False)
            else:
                label, in_progress, clipped = labels.get(bkey, ("", False, False))
                row.update(bucket=label, bucket_start=bkey.isoformat(),
                           in_progress=in_progress, clipped=clipped)
        else:
            row["bucket"] = None
        row["metrics"] = acc.result(metrics)
        if other:
            row["other"] = True
        groups.append(row)

    if not group_by and not unit:
        emit((), None, state.totals)
    else:
        for gkey in kept:
            for bkey in (bucket_keys if unit else [None]):
                emit(gkey, bkey, state.rows.get((gkey, bkey)) or _UsageAcc())
    other: dict[str, Any] | None = None
    if trimmed:
        merged_all = _UsageAcc()
        filler = tuple(OTHER_KEY for _ in group_by)
        for bkey in (bucket_keys if unit else [None]):
            merged = _UsageAcc()
            for gkey in trimmed:
                acc = state.rows.get((gkey, bkey))
                if acc is not None:
                    merged.merge(acc)
            merged_all.merge(merged)
            emit(filler, bkey, merged, other=True)
        other = {"groups": len(trimmed), "metrics": merged_all.result(metrics)}
    totals = state.totals.result(metrics)
    totals["calls"] = state.totals.calls
    label = window.label
    if window.is_all_time and window.token == "all":
        label = all_time_label(state.earliest, window.tz)
    return AggregateResult(
        total=state.totals.calls,
        groups=groups,
        buckets=[(b.label, b.in_progress) for b in calendar],
        exact=bool(exact and not partial),
        consistency=consistency,
        scanned=state.scanned,
        missing_created=state.missing,
        other=other,
        totals=totals,
        partial=partial,
        error=error,
        expected_total=expected_total,
        earliest=state.earliest.isoformat() if state.earliest else None,
        latest=state.latest.isoformat() if state.latest else None,
        window_label=label,
        multi_valued=(),
        method=method,
        bucket_unit=unit,
        missing_in_total=missing_in_total,
        window_from=window.iso_from(),
        window_to=window.iso_to(),
    )


async def scan_ledger(
    store: Any,
    consume: Callable[[list[Any]], Any],
    *,
    page_size: int = PAGE_SIZE,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
    ts_from: datetime | None = None,
    ts_to: datetime | None = None,
) -> ScanOutcome:
    """Feed every page of an append-only ledger repository to ``consume`` (usage or
    audit). ``ts_from`` (inclusive) / ``ts_to`` (exclusive) pre-filter the scan on the
    row's ``ts`` when the repository has a ``scan_page`` that declares them (the bundled
    usage stores push the range into the backend); otherwise every row is read through
    ``export_page``. Either way the CONSUMER applies its own exact predicate, and a row
    whose ``ts`` cannot be placed in time is always passed on (never dropped).

    Same failure/cancel/cursor rules as :func:`scan_cases`; a legacy repository that
    can only return one ``unverified`` page reports that consistency, which callers
    must not present as exact."""
    outcome = ScanOutcome()
    scan_page = getattr(store, "scan_page", None)
    bounds = {"ts_from": ts_from, "ts_to": ts_to}
    use_scan = callable(scan_page) and bool(_accepted_kwargs(scan_page, bounds))
    cursor: Any = None
    open_cursor: Any = None
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise AggregationCancelled("the aggregation was cancelled")
            try:
                if use_scan:
                    rows, nxt, total, consistency = await scan_page(
                        limit=page_size, cursor=cursor, ts_from=ts_from, ts_to=ts_to,
                    )
                else:
                    rows, nxt, total, consistency = await store.export_page(
                        limit=page_size, cursor=cursor,
                    )
            except AggregationCancelled:
                raise
            except Exception as exc:  # noqa: BLE001
                if outcome.pages == 0:
                    raise
                logger.warning("ledger scan stopped after %d rows: %s", outcome.scanned, exc)
                outcome.complete = False
                outcome.error = str(exc) or exc.__class__.__name__
                break
            open_cursor = nxt
            outcome.pages += 1
            rows = list(rows or [])
            outcome.scanned += len(rows)
            if total is not None:
                outcome.expected_total = int(total)
            outcome.consistency = _weaker(outcome.consistency, consistency)
            if rows:
                result = consume(rows)
                if inspect.isawaitable(result):
                    await result
            if progress is not None:
                await progress(outcome.scanned, outcome.expected_total)
            if nxt is None or nxt == cursor:
                break
            if not use_scan and not rows:
                break
            if (not use_scan and outcome.expected_total is not None
                    and outcome.scanned >= outcome.expected_total):
                break
            cursor = nxt
    finally:
        if open_cursor is not None:
            await _close_cursor(store, open_cursor)
    return outcome


async def aggregate_usage(
    store: Any,
    spec: UsageAggregateSpec,
    *,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
) -> AggregateResult:
    """Exact aggregate over the usage/cost ledger (#6: the ledger is the ONE record of
    every model call). ``total`` is the number of ledger rows (calls) selected.

    Push-down via ``store.aggregate_usage(spec)`` when the repository has it and can
    answer; else a fold over ``export_page``. A ledger row without a parseable ``ts`` is
    counted in an all-time window (bucketed under :data:`MISSING_USAGE_BUCKET`) and
    disclosed in ``missing_created`` for a bounded one — the same rule as cases."""
    spec = _aligned_spec(spec)
    validate_usage_spec(spec)
    if cancel is not None and cancel.is_set():
        raise AggregationCancelled("the aggregation was cancelled")
    pushdown = getattr(store, "aggregate_usage", None)
    if callable(pushdown):
        try:
            pushed = await pushdown(spec)
        except NotImplementedError:
            pushed = None
        except BucketMismatch as exc:
            logger.warning("usage aggregate push-down buckets did not align; folding: %s", exc)
            pushed = None
        except ValueError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage aggregate push-down failed; folding instead: %s", exc)
            pushed = None
        if isinstance(pushed, AggregateResult):
            if progress is not None:
                await progress(pushed.scanned, pushed.scanned)
            return pushed
    return await fold_usage(store, spec, progress=progress, cancel=cancel)


async def fold_usage(
    store: Any,
    spec: UsageAggregateSpec,
    *,
    progress: ProgressFn | None = None,
    cancel: asyncio.Event | None = None,
) -> AggregateResult:
    spec = _aligned_spec(spec)
    validate_usage_spec(spec)
    window = spec.window
    zone, _ = zone_for(window.tz)
    predicate = _compile_usage_filters(spec.filters or {})
    group_by = tuple(spec.group_by)
    unit = spec.bucket
    missing_counts = _missing_in_total(window)
    state = UsageRowSet()

    def consume(rows: list[Any]) -> None:
        for row in rows:
            if not isinstance(row, dict) or not predicate(row):
                continue
            try:
                ts = parse_es_timestamp(row.get("ts"))
            except (ValueError, OverflowError, OSError, TypeError):
                ts = None
            if ts is not None and not window.contains(ts):
                continue
            if ts is None:
                state.missing += 1
                if not missing_counts:
                    continue  # bounded window: disclosed, not counted
            state.totals.add_row(row)
            if ts is None:
                bkey: Any = MISSING_USAGE_BUCKET if unit else None
            else:
                state.note_ts(ts)
                bkey = period_start(ts, unit, zone) if unit else None
            gkey = tuple(usage_values(row, f) for f in group_by)
            state.acc(gkey, bkey).add_row(row)

    outcome = await scan_ledger(
        store, consume, progress=progress, cancel=cancel,
        ts_from=window.start, ts_to=None if window.open_end else window.end,
    )
    state.scanned = outcome.scanned
    # A legacy repository's export_page reports ``unverified`` and can only return ONE
    # page: that answer is honest about itself and must not be presented as exact.
    exact = outcome.complete and outcome.consistency != "unverified"
    return build_usage_result(
        spec, state, exact=exact, consistency=outcome.consistency, method="fold",
        partial=not outcome.complete, error=outcome.error,
        expected_total=outcome.expected_total,
    )


__all__ = [
    "AggregateResult",
    "AggregationCancelled",
    "BucketMismatch",
    "CASE_FILTER_FIELDS",
    "CASE_GROUP_FIELDS",
    "CASE_METRICS",
    "CaseAggregateSpec",
    "MISSING_BUCKET",
    "MAX_RESULT_BUCKETS",
    "MISSING_USAGE_BUCKET",
    "MULTI_VALUED_FIELDS",
    "OTHER_KEY",
    "RowSet",
    "ScanOutcome",
    "USAGE_FILTER_FIELDS",
    "USAGE_GROUP_FIELDS",
    "USAGE_METRICS",
    "UsageAggregateSpec",
    "UsageRowSet",
    "aggregate_cases",
    "aggregate_usage",
    "build_case_result",
    "build_usage_result",
    "fold_cases",
    "fold_usage",
    "iso_bound",
    "normalise_case_filters",
    "scan_cases",
    "scan_ledger",
    "usage_values",
    "validate_case_spec",
    "validate_usage_spec",
]
