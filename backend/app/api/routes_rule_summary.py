"""``GET /api/rules/summary``: one detection rule's picture (Round 14 SPEC §4.6.2).

The rule sheet opens from every place a rule appears (``RuleLink``). This endpoint
answers its figures in ONE read with SEVEN independent sections, each checking its own
grant and carrying its own status, so a missing grant or a failing store degrades one
section, never the sheet:

==================  =================  ==================================================
Section             Grant              What it holds
==================  =================  ==================================================
``alerts``          ``sources:read``   the rule's events in the window: count (exact or
                                       "at least"), first and last seen, a severity series
                                       by named level, the sources that answered
``top_source_ips``  ``sources:read``   the 10 source IPs with most events
``top_targets``     ``sources:read``   the 10 hosts and users with most events
``cases``           ``cases:read``     every case whose ``rule_ids`` hold the rule (ALL
                                       TIME whatever ``window`` is: the population "Show
                                       the N cases" opens): count, still open, the
                                       analyst-outcome family and the 5 newest, reused
                                       for 15 s
``definition``      ``rules:read``     a suite rule (``Preferences.rule_catalog``) or
                                       "Defined in the source SIEM"
``tuning``          ``automation:read`` the threshold tuner's view of the rule, with the
                                       gates the Tuning page reports for its proposal
``analyst_policy``  ``rules:read``     the live "declared benign" policy, if any
==================  =================  ==================================================

Statuses: ``ok``; ``forbidden`` (the grant is missing); ``unsupported`` (no source could
count natively, so the chart and top lists are a sample of each source's newest events,
said in ``reason``: the COUNT may still be exact, ``count_relation`` says which; or
row-level scope is on for the cases section, D16); ``unavailable`` (an error, with a
short plain ``reason``). A source whose whole answer held every match (a Demo ring, a
small result) is exact even though it cannot aggregate.

``window`` echoes the bounds the figures cover (an all-time window starts at the epoch),
so a Logs deep link built from it (``#/logs?rule=&from=&to=``) reads the same events.

How the alert figures are read, per source (the Logs filter of SPEC §4.6.1, so the
sheet and "Open all N in Logs" count the same events, ``GET /api/logs`` ``matched``):

* an Elastic-family PULL source (Elasticsearch, OpenSearch, Wazuh) counts natively: an
  exact composite aggregation of severity by time bucket (``aggregate_composite``; a
  source with too many distinct severity values for one read is counted per named
  level instead, ``aggregate_level_series``), top lists (``aggregate``), its newest
  events (the most rows ``GET /api/logs`` shows, each checked against the rule identity
  as Logs checks it) and its first event. A top list is exact when it listed every value
  or the store reports no count error for it; over more than one shard a list with a
  remainder is approximate (``doc_count_error_upper_bound`` above 0), and is said so.
  A row the native clause matched that the rule identity does not, an IGNORE carve-out
  that cannot be left out natively, or a read answered from part of the data (a failed
  shard, a timeout) leaves the figures a stated sample or "at least", never exact. A
  partial read whose rows all carry the rule keeps its native total as the floor, the
  "at least" count ``GET /api/logs`` gives the same read, and says that part of the
  log store did not answer;
* a Demo Mode source searches its ring: the count is exact, the chart and lists come
  from the newest events when the ring holds more than one read returns, and the first
  event is read on its own;
* a PUSH source reads its live-tail ring, a bounded, volatile window of recent events:
  "at least", and its first event is unknown.
Raw severities are projected to named levels through EACH source's own ceiling before
they are merged (:mod:`app.engine.severity_levels`), and every level appears, zeros
included. ``sources[].exact`` says the source's count is exact (the meaning
``GET /api/logs`` gives it); a sampled chart or list is said by ``status``, ``reason``
and the lists' own ``exact``.

Guarantees: no model call (#6); no raw rows in the answer (#7: the latest alerts come
from ``GET /api/logs?rule=``); no audit row (a read); read-only log access through the
per-source scoped client (#1). The rule value and every IP, host, user, title and
reason string are untrusted plain text (#9), returned as data only.
"""

from __future__ import annotations

import asyncio
import hashlib
import heapq
import logging
import math
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..connectors.registry import get_registry
from ..constants import DEFAULT_SEVERITY_SCALE_MAX
from ..engine.log_rows import (
    BUFFER_FILTER_SCAN,
    LogFilter,
    event_rule_identities,
    in_ring_window,
    open_pull_connector,
    search_kept_every_hit,
    search_total_relation,
    source_can_browse,
    source_counts_natively,
    valid_rule_value,
)
from ..engine.severity_levels import (
    LEVELS_DESCENDING,
    SeverityTally,
    level_ranges,
    scale_max_for_source,
)
from ..models import (
    RULE_SUMMARY_DEFAULT_WINDOW,
    RULE_SUMMARY_LATEST_CASES,
    RULE_SUMMARY_TOP_ROWS,
    RuleCaseOutcomes,
    RuleCaseRow,
    RuleSeverityPoint,
    RuleSeveritySeries,
    RuleSuiteDefinition,
    RuleSummary,
    RuleSummaryAlerts,
    RuleSummaryAnalystPolicy,
    RuleSummaryCases,
    RuleSummaryDefinition,
    RuleSummarySource,
    RuleSummaryTopList,
    RuleSummaryTuning,
    RuleSummaryWindow,
    RuleTopRow,
)
from ..state import AppState
from ..utils import now_utc
from .deps import get_state, resolve_access

logger = logging.getLogger("tlsoc.api.rule_summary")

router = APIRouter(prefix="/api", tags=["rules"])

#: The newest events read per source when a source cannot count natively (the chat
#: ``log_stats`` sample size, so the two state the same coverage).
SAMPLE_PER_SOURCE = 200
#: Per-source time budget for one phase of reads (a slow source degrades alone).
SOURCE_TIMEOUT_S = 15.0
#: Time budget of a section that scans the case store (cases, tuning): past it the
#: section answers ``unavailable`` and the sheet keeps every other section.
SECTION_TIMEOUT_S = 30.0
#: How long the tuner's per-rule view (built from every terminal case) is reused by
#: later sheets before it is read again (a read-only, advisory staleness bound).
TUNING_VIEW_TTL_S = 60.0
#: How long one rule's cases section (an exact fold over every case) is reused by later
#: sheets, and how many rules are kept (a read-only, advisory staleness bound).
CASES_VIEW_TTL_S = 15.0
CASES_VIEWS_MAX = 64
#: The most points the severity series aims for; the bucket is the narrowest width on
#: the ladder below that keeps the window within it (3 days -> 12 h, as approved).
SERIES_MAX_POINTS = 8
_SERIES_WIDTHS: tuple[tuple[str, int], ...] = (
    ("1m", 60), ("5m", 300), ("15m", 900), ("30m", 1800), ("1h", 3600), ("3h", 10_800),
    ("6h", 21_600), ("12h", 43_200), ("1d", 86_400), ("7d", 604_800), ("30d", 2_592_000),
    ("90d", 7_776_000), ("365d", 31_536_000),
)
# The most points a series ever carries (an all-time window over many years).
_SERIES_POINTS_CAP = 64
_WINDOW_MAX_CHARS = 120
_EPOCH_ISO = "1970-01-01T00:00:00+00:00"
_SCOPE_REASON = "Hidden while row-level scope is on."
# Why a source's chart is not exact (``_Figures.limit``).
_LIMIT_SAMPLE = "sample"   # the newest events of one read
_LIMIT_RING = "ring"       # a push source's live-tail ring
_LIMIT_CAP = "cap"         # more severity values than one native read pages
# Why a native top list is not exact although every source answered it natively.
_NOTE_APPROXIMATE_TOPS = (
    "The log store approximates top values across its shards, so a count may be low "
    "or a busier value missing."
)


def pick_bucket(span_seconds: float | None) -> tuple[str, int]:
    """The series bucket for a window ``span_seconds`` long: the narrowest width on the
    ladder that yields at most :data:`SERIES_MAX_POINTS` buckets (the widest one past
    that). An empty or unknown span gets one hour."""
    if span_seconds is None or not math.isfinite(span_seconds) or span_seconds <= 0:
        return "1h", 3600
    for label, seconds in _SERIES_WIDTHS:
        if span_seconds / seconds <= SERIES_MAX_POINTS:
            return label, seconds
    return _SERIES_WIDTHS[-1]


def _iso_millis(millis: int) -> str:
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat()


def _parse_millis(value: Any) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _window_label(raw: str) -> str:
    """The resolved window's label for a screen: sentence case, and a range written
    "22 Oct to 24 Oct 2026" (the shared resolver joins ranges with a dash)."""
    text = (raw or "").replace(" \u2013 ", " to ").replace("\u2013", " to ").replace("\u2014", " to ")
    return text[:1].upper() + text[1:] if text else text


# --------------------------------------------------------------------------- #
# Per-source alert reads
# --------------------------------------------------------------------------- #
@dataclass
class _Plan:
    """One source the alert sections read."""

    source_id: str
    name: str
    kind: str  # "pull" | "push" | "demo"
    scale_max: float
    src: Any = None


@dataclass
class _Figures:
    """What one source answered."""

    plan: _Plan
    ok: bool = True
    error: str | None = None
    aggregated: bool = False          # counted through an exact native aggregation
    sampled_only: bool = False        # a pull source whose rule clause was refused
    count: int = 0
    count_exact: bool = False         # ``count`` is the source's exact match count
    # ``count`` is the native search total kept as a floor ("at least"), as
    # ``GET /api/logs`` keeps it, rather than the number of events a sample held.
    count_bound: bool = False
    partial: bool = False             # a search answered from part of the data (a failed
                                      # shard, a timeout), so no figure of it is exact
    limit: str | None = None          # why the chart is not exact (``_LIMIT_*``), or None
    tops_sampled: bool = False        # the top lists come from an incomplete sample
    first_ms: int | None = None
    last_ms: int | None = None
    first_exact: bool = False         # ``first_ms`` is the source's first match (None: none)
    last_exact: bool = False          # ``last_ms`` is the source's last match (None: none)
    # (raw severity, events, bucket start millis or None)
    severity: list[tuple[Any, int, int | None]] = field(default_factory=list)
    # (named level, events, bucket start millis or None): a native count per level
    levels: list[tuple[str, int, int | None]] = field(default_factory=list)
    events: list[Any] = field(default_factory=list)  # a sample, bucketed after phase 1
    tops: dict[str, Counter] = field(default_factory=dict)
    tops_complete: dict[str, bool] = field(default_factory=dict)  # listed every value it has
    # Listed counts are exact and nothing left off outranks the last row (a native top
    # list over one shard, or one the store reports no count error for). Missing: False.
    tops_ranked_exact: dict[str, bool] = field(default_factory=dict)

    @property
    def figures_exact(self) -> bool:
        return self.limit is None


def _plans(state: AppState, source_id: str | None) -> tuple[list[_Plan], str | None]:
    """The sources the alert sections read, or a reason none can be read."""
    if state.demo_active:
        rows = [row for row in state.demo_sources_overlay() if str(row.get("id") or "")]
        plans = [
            _Plan(str(row.get("id")), str(row.get("display_name") or row.get("id")), "demo",
                  scale_max_for_source(None))
            for row in rows
        ]
    else:
        reg = get_registry()
        plans = []
        for src in state.prefs.sources:
            if not src.enabled or not source_can_browse(reg, src) or reg.get(src.source_type) is None:
                continue
            kind = "push" if reg.is_receiver(src.source_type) else "pull" if reg.is_pull(src.source_type) else ""
            if not kind:
                continue
            # A pull event carries its NATIVE severity (the source's own ceiling); a push
            # ring holds events normalised on ingest onto the canonical 0 to 100 score,
            # read on the default ceiling as ``GET /api/logs`` reads the same ring.
            scale = DEFAULT_SEVERITY_SCALE_MAX if kind == "push" else scale_max_for_source(src)
            plans.append(_Plan(src.id, src.display_name or src.id, kind, scale, src))
    if source_id is not None:
        plans = [p for p in plans if p.source_id == source_id]
        if not plans:
            return [], "That source is not available for browsing."
    if not plans:
        return [], "No log source can be browsed."
    return plans, None


def _stamp(ev: Any) -> int:
    return int(getattr(ev, "timestamp_millis", 0) or 0)


def _answered_in_part(*results: Any) -> bool:
    """Did any of these native searches answer from only part of its data (a failed
    shard, a timeout: ``connectors.elastic.response_is_complete``)?"""
    from ..connectors.elastic import response_is_complete

    return any(not response_is_complete(getattr(result, "raw", None)) for result in results)


def _sample_figures(fig: _Figures, events: list[Any], *, total: int | None, total_exact: bool,
                    limit: str) -> None:
    """Fill ``fig`` from a sample of matching events (already filtered).

    Every sample read here is the source's NEWEST matching events (a newest-first read,
    or a live-tail ring), so its newest stamp is the source's last match whenever it
    holds one; its oldest stamp is the source's first match only when the sample held
    every match. ``limit`` names the kind of sample for the reason a sheet shows."""
    fig.events = list(events)
    stamps = [s for s in (_stamp(ev) for ev in events) if s > 0]
    complete = total is not None and total_exact and int(total) <= len(events)
    fig.count = int(total) if total is not None and total_exact else len(events)
    fig.count_exact = bool(total is not None and total_exact)
    fig.limit = None if complete else limit
    fig.tops_sampled = not complete
    fig.first_ms = min(stamps) if stamps else None
    fig.last_ms = max(stamps) if stamps else None
    fig.first_exact = complete
    fig.last_exact = complete or bool(stamps)
    for name, attr in (("ip", "ip"), ("host", "host"), ("user", "user")):
        counter: Counter = Counter()
        for ev in events:
            value = getattr(ev, attr, None)
            if value not in (None, ""):
                counter[str(value)] += 1
        fig.tops[name] = counter
        fig.tops_complete[name] = complete
        fig.tops_ranked_exact[name] = complete


async def _read_sample(state: AppState, plan: _Plan, rule: str, time_from: str, time_to: str,
                       window_start_ms: int | None, window_end_ms: int | None) -> _Figures:
    """Phase 1 for a source: its newest matching events, checked against the rule
    identity, and its first one (pull), or the sample (others)."""
    from ..connectors.base import StructuredQuery
    from ..connectors.elastic import LogFilterQuery, _http_status

    fig = _Figures(plan)
    flt = LogFilter(rule=rule)
    if plan.kind == "pull":
        query = LogFilterQuery(rule_any=rule, time_from=time_from, time_to=time_to,
                               size=SAMPLE_PER_SOURCE, sort_desc=True)
        async with open_pull_connector(plan.src, state.es_client_for_source) as conn:
            effective = conn._effective_prefs(state.prefs)
            native = source_counts_natively(conn)
            if native:
                try:
                    newest = await conn.search(state.prefs, query)
                    oldest = await conn.search(state.prefs, query.model_copy(update={"size": 1, "sort_desc": False}))
                except Exception as exc:  # noqa: BLE001 (classified below)
                    if _http_status(exc) != 400:
                        raise
                    # The cluster refused a suite rule's clause (a prefix match on a
                    # numeric field): the newest events of the window, filtered here, a
                    # stated sample.
                    logger.warning("rule summary on %s: the rule clause was refused (%r); sampling",
                                   plan.source_id, exc)
                    result = await conn.search(state.prefs, LogFilterQuery(
                        time_from=time_from, time_to=time_to, size=SAMPLE_PER_SOURCE, sort_desc=True,
                    ))
                    kept = [ev for ev in result.events if rule in event_rule_identities(ev, effective)]
                    complete = (search_kept_every_hit(result)
                                and result.total is not None and int(result.total) <= len(result.events)
                                and search_total_relation(result) == "eq")
                    _sample_figures(fig, kept, total=len(kept) if complete else None, total_exact=complete,
                                    limit=_LIMIT_SAMPLE)
                    fig.sampled_only = True
                    fig.partial = _answered_in_part(result)
                    return fig
                # The rows ``GET /api/logs?rule=`` would show (its newest, up to the
                # browse cap) are checked against the Python identity as Logs checks
                # them: the native figures are this rule's only when every one agrees.
                agrees = all(
                    search_kept_every_hit(read)
                    and all(rule in event_rule_identities(ev, effective) for ev in read.events)
                    for read in (newest, oldest)
                )
                if agrees:
                    whole = search_total_relation(newest) == "eq" and search_total_relation(oldest) == "eq"
                    stamps = [s for s in (_stamp(ev) for ev in [*newest.events, *oldest.events]) if s > 0]
                    fig.first_ms = min(stamps) if stamps else None
                    fig.last_ms = max(stamps) if stamps else None
                    fig.first_exact = fig.last_exact = whole
                    fig.count = int(newest.total or 0)
                    fig.count_exact = whole
                    fig.count_bound = not whole
                    fig.partial = _answered_in_part(newest, oldest)
                    return fig
                logger.warning("rule summary on %s: a native read and its rows disagree (the rule "
                               "identity, or a muted feed's events); sampling", plan.source_id)
                result = newest
            else:
                # An IGNORE carve-out that cannot be left out natively: a native count
                # would include muted events, so the newest events are read and kept here.
                result = await conn.search(state.prefs, query)
        kept = [ev for ev in result.events if rule in event_rule_identities(ev, effective)]
        _sample_figures(fig, kept, total=None, total_exact=False, limit=_LIMIT_SAMPLE)
        fig.sampled_only = True
        fig.partial = _answered_in_part(result)
        return fig
    if plan.kind == "demo":
        conn = state.demo_source_connector(plan.source_id)
        if conn is None:
            fig.ok, fig.error = False, "This Demo source is not running."
            return fig
        query = StructuredQuery(rule=rule, time_from=time_from, time_to=time_to, size=SAMPLE_PER_SOURCE,
                                sort_desc=True)
        result = await conn.search(state.prefs, query)
        kept = [ev for ev in result.events if flt.matches_event(ev, scale_max=plan.scale_max)]
        agrees = len(kept) == len(result.events)
        _sample_figures(fig, kept, total=result.total if agrees else None, total_exact=agrees,
                        limit=_LIMIT_SAMPLE)
        if agrees and not fig.first_exact:
            # The ring holds more matches than one read returns: its first match is read
            # on its own (oldest first), as a pull source's is.
            oldest = await conn.search(state.prefs, query.model_copy(update={"size": 1, "sort_desc": False}))
            firsts = [_stamp(ev) for ev in oldest.events
                      if flt.matches_event(ev, scale_max=plan.scale_max) and _stamp(ev) > 0]
            if firsts:
                fig.first_ms, fig.first_exact = firsts[0], True
        return fig
    # A push source: its whole live-tail ring, filtered by rule and window here, the
    # same read ``GET /api/logs?rule=`` makes of it (``push_filtered_reader``). The ring
    # holds only recent events, so the count is "at least" and the first match unknown.
    ring = state.ingest_service.recent_events_for_source(plan.source_id, BUFFER_FILTER_SCAN)
    kept = [
        ev for ev in ring
        if in_ring_window(ev, window_start_ms, window_end_ms)
        and flt.matches_event(ev, scale_max=plan.scale_max)
    ]
    _sample_figures(fig, kept, total=None, total_exact=False, limit=_LIMIT_RING)
    return fig


def _numeric_severities(composite: Any) -> bool:
    """Every severity value a ``(time, severity)`` composite saw is a number (a numeric
    field), so a native ``range`` per level compares what the projection compares."""
    for keys, _count in getattr(composite, "rows", None) or []:
        value = keys[1] if len(keys) > 1 else None
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
    return True


async def _read_aggregates(state: AppState, fig: _Figures, rule: str, time_from: str, time_to: str,
                           bucket: str) -> None:
    """Phase 2 for a pull source: exact severity by bucket and exact top lists, or the
    newest-events sample when the source cannot count."""
    from ..connectors.elastic import LogFilterQuery

    plan = fig.plan
    query = LogFilterQuery(rule_any=rule, time_from=time_from, time_to=time_to, size=0, sort_desc=True)
    # Phase 1's native total (exact or a floor): it stays a floor below whatever the
    # fallback read finds, as long as that read's rows still agree with the rule.
    phase1_count = int(fig.count)
    async with open_pull_connector(plan.src, state.es_client_for_source) as conn:
        composite = None
        levels = None
        tops = None
        if callable(getattr(conn, "aggregate_composite", None)):
            composite = await conn.aggregate_composite(state.prefs, query, ["severity"], interval=bucket)
        if (composite is not None and not composite.complete and _numeric_severities(composite)
                and callable(getattr(conn, "aggregate_level_series", None))):
            # More distinct raw values than one composite read pages (a continuous
            # score): count each named level natively instead, one bucket per time bucket.
            levels = await conn.aggregate_level_series(
                state.prefs, query, level_ranges(plan.scale_max), interval=bucket,
            )
            if levels is not None and not levels.complete:
                levels = None
        if composite is not None and callable(getattr(conn, "aggregate", None)):
            tops = await conn.aggregate(state.prefs, query, ["ip", "host", "user"], None, RULE_SUMMARY_TOP_ROWS)
        if composite is None or tops is None:
            result = await conn.search(state.prefs, query.model_copy(update={"size": SAMPLE_PER_SOURCE}))
            effective = conn._effective_prefs(state.prefs)
            kept = [ev for ev in result.events if rule in event_rule_identities(ev, effective)]
            # Every row carries the rule and every hit became a row (no muted event in
            # the native count): the native total counts this rule's events, exactly
            # when the search answered from all of its data, else as a floor.
            agrees = (len(kept) == len(result.events) and search_kept_every_hit(result)
                      and source_counts_natively(conn))
            total_exact = agrees and search_total_relation(result) == "eq"
            first, last = fig.first_ms, fig.last_ms
            first_exact, last_exact = fig.first_exact, fig.last_exact
            _sample_figures(fig, kept, total=result.total if total_exact else None, total_exact=total_exact,
                            limit=_LIMIT_SAMPLE)
            fig.partial = _answered_in_part(result)
            if agrees and not total_exact:
                # A partial answer (a failed shard, a timeout) or a total the store
                # stopped counting still bounds the count from below: "at least" the
                # native total, the number ``GET /api/logs`` gives the same read, never
                # just the rows one read returns.
                fig.count = max(len(kept), int(result.total or 0), phase1_count)
                fig.count_exact = False
                fig.count_bound = True
            # Phase 1 read the first and last match natively (the newest events and the
            # oldest one); they stay proven only when that read was whole too.
            fig.first_ms, fig.last_ms = first, last
            fig.first_exact = first_exact and total_exact
            fig.last_exact = last_exact and total_exact
            return
    fig.aggregated = True
    # Exact: every page of the composite (or level series) answered from all of the
    # data (a partial page returns ``None`` and the sample path above runs instead), and
    # phase 1 found the native clause and the rule identity in agreement.
    fig.count_exact = True
    fig.count_bound = False
    fig.partial = False
    if levels is not None:
        fig.count = int(levels.total)
        for (when, level), count in levels.rows:
            fig.levels.append((str(level), int(count), _parse_millis(when)))
        fig.limit = None
    else:
        fig.count = int(composite.total)
        for keys, count in composite.rows:
            fig.severity.append((keys[1], int(count), _parse_millis(keys[0])))
        fig.limit = None if composite.complete else _LIMIT_CAP
    fig.tops_sampled = False
    # A connector that does not report a count error bound leaves it unknown (None).
    bounds = getattr(tops, "error_bound", None) or {}
    for name in ("ip", "host", "user"):
        buckets = tops.groups.get(name, [])
        other = int(tops.other.get(name, 0) or 0)
        fig.tops[name] = Counter({b.key: int(b.count) for b in buckets})
        fig.tops_complete[name] = other == 0
        fig.tops_ranked_exact[name] = _ranked_exact(other, bounds.get(name))


def _ranked_exact(other: int, error_bound: int | None) -> bool:
    """A native top list's counts are exact and nothing it left off can outrank its
    last row when it listed every value (``other == 0``), or when the store reports no
    count error (``doc_count_error_upper_bound == 0``). Over more than one shard a
    ``terms`` list with a remainder is only approximate: a value outside one shard's own
    top list misses that shard's share, so its count may be low and a value left off
    may be larger than the last row. An unknown bound (``None``) proves nothing."""
    return int(other) == 0 or error_bound == 0


def _unranked(figs: list[_Figures], names: tuple[str, ...]) -> bool:
    """Some source's native top list of ``names`` is approximate (:func:`_ranked_exact`)."""
    return any(
        not fig.tops_sampled
        and not fig.tops_complete.get(name, False)
        and not fig.tops_ranked_exact.get(name, False)
        for fig in figs
        for name in names
    )


def _merge_top(figs: list[_Figures], names: tuple[str, ...]) -> tuple[list[RuleTopRow], bool]:
    """Merge per-source top lists of ``names`` (one kind each) into one top 10, and say
    whether that top 10 is exact (:func:`_top_is_exact`)."""
    combined: Counter = Counter()
    for fig in figs:
        for name in names:
            for value, count in fig.tops.get(name, Counter()).items():
                combined[(name, value)] += int(count)
    ranked = sorted(combined.items(), key=lambda kv: (-kv[1], kv[0][1], kv[0][0]))[:RULE_SUMMARY_TOP_ROWS]
    rows = [
        RuleTopRow(value=value, kind=(name if len(names) > 1 else None), count=int(count))
        for (name, value), count in ranked
    ]
    return rows, _top_is_exact(figs, names, combined, ranked)


def _top_is_exact(
    figs: list[_Figures],
    names: tuple[str, ...],
    combined: Counter,
    ranked: list[tuple[tuple[str, str], int]],
) -> bool:
    """Is the merged top list exactly the true top list?

    Every incomplete source's own list must be RANKED exactly (:func:`_ranked_exact`):
    over more than one shard, a ``terms`` list with a remainder can carry low counts and
    leave off a value larger than its last row, and nothing here can bound that. Then two
    things must hold. Every LISTED count includes every source's share: each source
    either listed the value or listed every value it has. And no value LEFT OFF can
    outrank the last listed row: a source whose ranked list is incomplete holds, for any
    value it did not list, at most its smallest listed count (its floor). So a value no
    source listed is bounded by the sum of those floors, and a listed value that missed
    the cut by its merged count plus the floors of the incomplete sources that did not
    list it. A single incomplete source whose list is ranked exactly stays exact,
    because its tenth count is its floor."""
    if any(fig.tops_sampled for fig in figs) or _unranked(figs, names):
        return False
    for (name, value), _count in ranked:
        for fig in figs:
            if value not in fig.tops.get(name, Counter()) and not fig.tops_complete.get(name, False):
                return False
    floors: dict[str, list[tuple[_Figures, int]]] = {name: [] for name in names}
    for fig in figs:
        for name in names:
            if fig.tops_complete.get(name, False):
                continue
            listed = fig.tops.get(name, Counter())
            if not listed:
                return False  # something is left off, and nothing bounds it
            floors[name].append((fig, min(int(c) for c in listed.values())))
    last = int(ranked[-1][1]) if len(ranked) >= RULE_SUMMARY_TOP_ROWS else 0
    for name in names:
        if sum(floor for _fig, floor in floors[name]) > last:
            return False
    shown = {key for key, _count in ranked}
    for (name, value), count in combined.items():
        if (name, value) in shown:
            continue
        bound = int(count) + sum(
            floor for fig, floor in floors[name] if value not in fig.tops.get(name, Counter())
        )
        if bound > last:
            return False
    return True


def _which(subset: list[_Figures], figs: list[_Figures]) -> str:
    if len(subset) == len(figs):
        return "each source" if len(figs) > 1 else "the source"
    return "1 source" if len(subset) == 1 else f"{len(subset)} sources"


def _figure_notes(figs: list[_Figures], answered: list[_Figures], *, count_exact: bool,
                  chart: bool) -> list[str]:
    """The plain sentences that say what the alert figures (``chart``) or the top lists
    rest on, one per cause and never a sampling sentence for an exact count."""
    notes: list[str] = []
    failed = [f for f in figs if not f.ok]
    if failed:
        notes.append(f"{len(failed)} of {len(figs)} sources did not answer.")
    partial = [f for f in answered if f.partial]
    if partial:
        outcome = "so these are at least the alerts" if chart else "so a count may be low or a value missing"
        notes.append(f"Part of the log store did not answer for {_which(partial, figs)}, {outcome}.")
    if any(f.limit == _LIMIT_RING for f in answered):
        notes.append("Live-tail sources count only the events they still hold.")
    counted = [f for f in answered if f.limit == _LIMIT_SAMPLE and not f.count_exact and not f.count_bound]
    if counted:
        notes.append(f"Counted from the newest {SAMPLE_PER_SOURCE} events of {_which(counted, figs)}.")
    # A sampled chart beside a count that is not a sample (exact, or a native floor).
    drawn = [f for f in answered if f.limit == _LIMIT_SAMPLE and (f.count_exact or f.count_bound)]
    if drawn:
        which = _which(drawn, figs)
        if chart:
            lead = "The count is exact. " if count_exact else ""
            notes.append(f"{lead}The chart and top lists use the newest {SAMPLE_PER_SOURCE} events of {which}.")
        else:
            notes.append(f"The top lists use the newest {SAMPLE_PER_SOURCE} events of {which}.")
    capped = [f for f in answered if f.limit == _LIMIT_CAP]
    if chart and capped:
        notes.append(f"The chart for {_which(capped, figs)} shows at least these alerts: "
                     "there are too many distinct severity values to count in one read.")
    return notes


def _seen_bounds(figs: list[_Figures], answered: list[_Figures]) -> tuple[str | None, str | None]:
    """The rule's first and last event, each only when it is proven: every source
    answered and knows its own (a live-tail ring, or a sample that did not hold every
    match, does not know its first event)."""
    if any(not f.ok for f in figs):
        return None, None
    first = last = None
    if all(f.first_exact for f in answered):
        firsts = [f.first_ms for f in answered if f.first_ms is not None]
        first = _iso_millis(min(firsts)) if firsts else None
    if all(f.last_exact for f in answered):
        lasts = [f.last_ms for f in answered if f.last_ms is not None]
        last = _iso_millis(max(lasts)) if lasts else None
    return first, last


async def _alert_sections(
    state: AppState, rule: str, window: Any, source_id: str | None,
) -> tuple[RuleSummaryAlerts, RuleSummaryTopList, RuleSummaryTopList]:
    plans, reason = _plans(state, source_id)
    if not plans:
        return (
            RuleSummaryAlerts(status="unsupported", reason=reason, count=None, count_relation="gte"),
            RuleSummaryTopList(status="unsupported", reason=reason, exact=False),
            RuleSummaryTopList(status="unsupported", reason=reason, exact=False),
        )
    end = window.end
    start = window.start
    time_from = start.isoformat() if start is not None else _EPOCH_ISO
    time_to = end.isoformat()
    start_ms = int(start.timestamp() * 1000) if start is not None else None
    end_ms = int(end.timestamp() * 1000)

    async def phase1(plan: _Plan) -> _Figures:
        try:
            return await asyncio.wait_for(
                _read_sample(state, plan, rule, time_from, time_to, start_ms, None if window.open_end else end_ms),
                timeout=SOURCE_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            return _Figures(plan, ok=False, error="timeout")
        except Exception as exc:  # noqa: BLE001 (one source degrades alone, #11)
            logger.warning("rule summary read failed for %s: %s", plan.source_id, exc)
            return _Figures(plan, ok=False, error="error")

    def unanswered(figs: list[_Figures]) -> tuple[RuleSummaryAlerts, RuleSummaryTopList, RuleSummaryTopList]:
        text = "No log source answered."
        return (
            RuleSummaryAlerts(status="unavailable", reason=text, count=None, count_relation="gte",
                              sources=[RuleSummarySource(id=f.plan.source_id, name=f.plan.name, exact=False)
                                       for f in figs]),
            RuleSummaryTopList(status="unavailable", reason=text, exact=False),
            RuleSummaryTopList(status="unavailable", reason=text, exact=False),
        )

    figs = list(await asyncio.gather(*(phase1(p) for p in plans)))
    answered = [f for f in figs if f.ok]
    if not answered:
        return unanswered(figs)

    # The series spans the window, or from the first event when the window is all time.
    firsts = [f.first_ms for f in answered if f.first_ms is not None]
    series_start_ms = start_ms if start_ms is not None else (min(firsts) if firsts else end_ms)
    bucket_label, bucket_seconds = pick_bucket((end_ms - series_start_ms) / 1000.0)
    bucket_ms = bucket_seconds * 1000

    async def phase2(fig: _Figures) -> _Figures:
        if not fig.ok or fig.plan.kind != "pull" or fig.sampled_only:
            return fig
        try:
            await asyncio.wait_for(
                _read_aggregates(state, fig, rule, time_from, time_to, bucket_label),
                timeout=SOURCE_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            fig.ok, fig.error = False, "timeout"
        except Exception as exc:  # noqa: BLE001 (one source degrades alone, #11)
            logger.warning("rule summary aggregate failed for %s: %s", fig.plan.source_id, exc)
            fig.ok, fig.error = False, "error"
        return fig

    figs = list(await asyncio.gather(*(phase2(f) for f in figs)))
    answered = [f for f in figs if f.ok]
    if not answered:
        return unanswered(figs)

    def bucket_of(stamp: int | None) -> str | None:
        return None if stamp is None else str((stamp // bucket_ms) * bucket_ms)

    tally = SeverityTally()
    for fig in answered:
        observations = list(fig.severity)
        for ev in fig.events:
            ts = _stamp(ev)
            observations.append((getattr(ev, "severity", None), 1, ts if ts > 0 else None))
        for raw, count, stamp in observations:
            tally.add(raw, scale_max=fig.plan.scale_max, count=count, source=fig.plan.source_id,
                      bucket=bucket_of(stamp))
        for level, count, stamp in fig.levels:
            tally.add_level(level, count=count, source=fig.plan.source_id, bucket=bucket_of(stamp))

    # Zero-filled from the bucket holding the window start to the one holding its end.
    # The ladder keeps this at most SERIES_MAX_POINTS + 1 (alignment); the guard only
    # bounds a window wider than the widest bucket allows, keeping the newest points.
    last_bucket = (max(end_ms - 1, series_start_ms) // bucket_ms) * bucket_ms
    first_bucket = max(
        (series_start_ms // bucket_ms) * bucket_ms,
        last_bucket - (_SERIES_POINTS_CAP - 1) * bucket_ms,
    )
    per_bucket = tally.bucket_counts()
    points: list[RuleSeverityPoint] = []
    for cursor in range(first_bucket, last_bucket + 1, bucket_ms):
        counts = per_bucket.get(str(cursor), {})
        points.append(RuleSeverityPoint(
            t=_iso_millis(cursor), **{lv: int(counts.get(lv, 0)) for lv in LEVELS_DESCENDING},
        ))

    failed = [f for f in figs if not f.ok]
    count_exact = not failed and all(f.count_exact for f in answered)
    aggregated_any = any(f.aggregated for f in answered)
    # ``unsupported`` only when no source could count natively AND the chart is drawn
    # from a sample: a ring or Demo answer that held every match is exact, so ``ok``.
    # The COUNT may be exact either way; ``count_relation`` says which.
    limited = [f for f in answered if f.limit is not None]
    status = "unsupported" if (limited and not aggregated_any) else "ok"
    chart_notes = _figure_notes(figs, answered, count_exact=count_exact, chart=True)
    first_seen, last_seen = _seen_bounds(figs, answered)
    alerts = RuleSummaryAlerts(
        status=status,
        reason=" ".join(chart_notes) or None,
        count=sum(int(f.count) for f in answered),
        count_relation="eq" if count_exact else "gte",
        first_seen=first_seen,
        last_seen=last_seen,
        series=RuleSeveritySeries(bucket=bucket_label, points=points),
        sources=[
            # ``exact``: this source's COUNT is exact (``GET /api/logs`` gives the word
            # the same meaning), so "Open all N in Logs" names N only when Logs can.
            RuleSummarySource(id=f.plan.source_id, name=f.plan.name, exact=bool(f.ok and f.count_exact))
            for f in figs
        ],
    )

    def top_list(names: tuple[str, ...]) -> RuleSummaryTopList:
        rows, exact = _merge_top(answered, names)
        notes = _figure_notes(figs, answered, count_exact=count_exact, chart=False)
        exact = exact and not failed
        if not exact and _unranked(answered, names):
            notes.append(_NOTE_APPROXIMATE_TOPS)
        if not exact and not notes:
            notes = ["Each source lists only its top 10, so a busier value may be missing."]
        return RuleSummaryTopList(status=status, reason=" ".join(notes) or None, rows=rows, exact=exact)

    return alerts, top_list(("ip",)), top_list(("host", "user"))


# --------------------------------------------------------------------------- #
# Cases, definition, tuning, analyst policy
# --------------------------------------------------------------------------- #
async def _newest_cases(state: AppState, rule: str, limit: int) -> list[RuleCaseRow]:
    """The ``limit`` newest cases from the rule, in the order ``GET /api/cases?rule=``
    sorted by ``created_at`` descending gives them, read from projected rows.

    The scan asks the store for its newest cases first; once it holds ``limit`` matches
    and the page it just read ends older than the oldest of them, no later case can
    enter the list and the scan stops, so the common case reads a page or two rather
    than the whole store. A store that cannot read newest first (or does not keep that
    order) is scanned to the end. A scan that ended early on its own (a later page
    failed) raises rather than return a list that may miss newer cases. The scan's read
    snapshot is released on every exit, a cancellation included (``scan_cases``)."""
    from ..engine.case_aggregate import _accepted_kwargs, scan_cases
    from .routes import CASE_QUEUE_SCAN_FIELDS, _queue_rule_closed_by_check, _queue_sort_key, _queue_value

    if limit <= 0:
        return []
    store = state.cases
    matches = _queue_rule_closed_by_check(rule, None, state.execution_prefs)
    ordered = bool(_accepted_kwargs(getattr(store, "scan_page", None), {"newest_first": True}))
    kept: list[tuple[tuple[Any, str], int, Any]] = []  # a min-heap: the oldest kept on top
    seen = {"previous": None, "stop": False, "rows": 0}

    def consume(rows: list[Any]) -> None:
        nonlocal ordered
        for row in rows:
            key = _queue_sort_key(row, "created_at")
            previous = seen["previous"]
            if previous is not None and key[0] > previous:
                ordered = False  # the store did not keep newest-first: scan everything
            seen["previous"] = key[0]
            seen["rows"] += 1
            if matches is not None and not matches(row):
                continue
            item = (key, seen["rows"], row)
            if len(kept) < limit:
                heapq.heappush(kept, item)
            elif key > kept[0][0]:
                heapq.heapreplace(kept, item)
        if ordered and len(kept) >= limit and rows:
            if _queue_sort_key(rows[-1], "created_at")[0] < kept[0][0][0]:
                seen["stop"] = True

    outcome = await scan_cases(
        store, consume, raw=True, newest_first=True, fields=tuple(CASE_QUEUE_SCAN_FIELDS),
        stop=lambda: bool(seen["stop"]),
    )
    if not outcome.complete and not outcome.stopped:
        # A page after the first failed: the scan ended early on its own, so a newer
        # match may be missing. Never a partial list presented as the newest.
        raise RuntimeError(f"the case scan stopped after {outcome.scanned} rows: {outcome.error}")
    newest = sorted(kept, key=lambda item: item[0], reverse=True)
    return [
        RuleCaseRow(
            case_id=str(_queue_value(row, "case_id") or ""),
            case_number=str(_queue_value(row, "case_number") or ""),
            title=str(_queue_value(row, "title") or ""),
            status=str(_queue_value(row, "status") or ""),
            verdict=(str(_queue_value(row, "verdict")) if _queue_value(row, "verdict") else None),
        )
        for _key, _seq, row in newest
    ]


async def _cases_section(state: AppState, rule: str, *, scoped: bool) -> RuleSummaryCases:
    """The cases section: every case from the rule, ALL TIME whatever the sheet's window
    (the population "Show the N cases" opens, ``GET /api/cases?rule=`` with no window).
    Reused for :data:`CASES_VIEW_TTL_S` and read once for concurrent sheets."""
    if scoped:
        return RuleSummaryCases(status="unsupported", reason=_SCOPE_REASON)
    return await _shared_cases_section(state, rule)


async def _read_cases_section(state: AppState, rule: str) -> RuleSummaryCases:
    """One read of the cases section (an exact fold, then the newest few)."""
    from ..engine.case_aggregate import CaseAggregateSpec, aggregate_cases
    from ..engine.time_windows import resolve_window

    prefs = state.execution_prefs
    spec = CaseAggregateSpec(
        window=resolve_window("all", now=now_utc()),
        filters={"rule_exact": [rule]},
        metrics=("count", "open_now", "analyst_tp", "analyst_fp", "analyst_ungraded"),
        prefs=prefs,
    )
    result = await aggregate_cases(state.cases, spec)
    if result.partial:
        return RuleSummaryCases(status="unavailable", reason="Could not read every case right now.")
    totals = result.totals or {}
    # The newest few are read only when the rule has cases, and the read stops early.
    latest = await _newest_cases(state, rule, RULE_SUMMARY_LATEST_CASES) if int(result.total) > 0 else []

    def _num(name: str) -> int:
        value = totals.get(name)
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0

    return RuleSummaryCases(
        status="ok",
        count=int(result.total),
        open_now=_num("open_now"),
        outcomes=RuleCaseOutcomes(
            analyst_tp=_num("analyst_tp"), analyst_fp=_num("analyst_fp"),
            analyst_ungraded=_num("analyst_ungraded"),
        ),
        latest=latest,
    )


# One rule's cases section, reused for :data:`CASES_VIEW_TTL_S` and built once for
# concurrent sheets (the tuning view's pattern below): without it every sheet open folds
# the whole case store twice (the exact counts and the newest few), and opening sheets
# in quick succession stacks those scans, each holding its own read snapshot.
@dataclass
class _CasesView:
    store: Any                 # the case store it was read from (an ``is`` guard)
    expires_at: float
    section: RuleSummaryCases


_cases_views: dict[tuple[Any, ...], _CasesView] = {}
_cases_inflight: dict[tuple[Any, ...], tuple[Any, "asyncio.Future[RuleSummaryCases]"]] = {}


def invalidate_cases_views() -> None:
    """Forget every reused cases section (test isolation, a hard reset)."""
    _cases_views.clear()
    _cases_inflight.clear()


def _keep_cases_view(key: tuple[Any, ...], view: _CasesView) -> None:
    now = time.monotonic()
    for stale in [k for k, v in _cases_views.items() if v.expires_at <= now]:
        del _cases_views[stale]
    while len(_cases_views) >= CASES_VIEWS_MAX:
        del _cases_views[min(_cases_views, key=lambda k: _cases_views[k].expires_at)]
    _cases_views[key] = view


async def _shared_cases_section(state: AppState, rule: str) -> RuleSummaryCases:
    """The reused section for ``rule``, or a fresh read shared by concurrent callers.
    Keyed by the store, the Demo run, the effective preferences and the rule; a read
    made while Demo Mode switched is never stored; a failed read is never stored."""
    store = state.cases
    key = (id(store), getattr(state, "demo_run_id", None), _prefs_fingerprint(state.execution_prefs), rule)
    view = _cases_views.get(key)
    if view is not None and view.store is store and time.monotonic() < view.expires_at:
        return view.section.model_copy(deep=True)
    loop = asyncio.get_running_loop()
    pending = _cases_inflight.get(key)
    if pending is not None and pending[0] is store and not pending[1].done() and pending[1].get_loop() is loop:
        # shield(): this caller's cancellation never cancels the shared read.
        section = await asyncio.shield(pending[1])
        return section.model_copy(deep=True)
    fut: asyncio.Future[RuleSummaryCases] = loop.create_future()
    _cases_inflight[key] = (store, fut)
    generation = getattr(state, "demo_generation", None)
    try:
        section = await _read_cases_section(state, rule)
    except BaseException as exc:
        if not fut.done():
            shared = exc if isinstance(exc, Exception) else RuntimeError("the shared cases read stopped")
            fut.set_exception(shared)
            fut.exception()  # retrieved: an unshared failure never logs a warning
        raise
    else:
        if not fut.done():
            fut.set_result(section)
        if section.status == "ok" and getattr(state, "demo_generation", None) == generation:
            _keep_cases_view(key, _CasesView(store, time.monotonic() + float(CASES_VIEW_TTL_S), section))
        return section.model_copy(deep=True)
    finally:
        current = _cases_inflight.get(key)
        if current is not None and current[1] is fut:
            del _cases_inflight[key]


def _definition_section(state: AppState, rule: str) -> RuleSummaryDefinition:
    catalog = list(getattr(state.execution_prefs, "rule_catalog", None) or [])
    match = next((rd for rd in catalog if getattr(rd, "name", None) == rule), None)
    if match is None:
        return RuleSummaryDefinition(status="ok", kind="source")
    return RuleSummaryDefinition(
        status="ok",
        kind="suite",
        suite_rule=RuleSuiteDefinition(
            name=str(match.name),
            enabled=bool(getattr(match, "enabled", True)),
            description=str(getattr(match, "description", "") or ""),
            mitre=[str(t) for t in (getattr(match, "mitre", None) or [])],
            priority=int(getattr(match, "priority", 0)) if getattr(match, "priority", None) is not None else None,
        ),
    )


def _policy_section(state: AppState, rule: str) -> RuleSummaryAnalystPolicy:
    from ..engine.precedent import normalize_rule_id

    wanted = normalize_rule_id(rule)
    live = [
        p for p in (getattr(state.execution_prefs, "analyst_rule_policies", None) or [])
        if normalize_rule_id(getattr(p, "rule_id", "")) == wanted and p.is_live()
    ]
    if not live:
        return RuleSummaryAnalystPolicy(status="ok", policy=None)
    # An estate-wide declaration before a source-scoped one.
    chosen = sorted(live, key=lambda p: (bool(getattr(p, "source_id", None)), str(p.id)))[0]
    return RuleSummaryAnalystPolicy(status="ok", policy={
        "id": chosen.id,
        "rule_id": chosen.rule_id,
        "reason": chosen.reason,
        "source_id": chosen.source_id,
        "enabled": chosen.enabled,
        "max_risk_score": chosen.max_risk_score,
        "created_by": chosen.created_by,
        "created_at": chosen.created_at,
        "expires_at": chosen.expires_at.isoformat() if chosen.expires_at else None,
        "live": True,
    })


# The tuner's per-rule view (statistics and the proposal the Tuning page would show),
# built from every terminal case: reused for :data:`TUNING_VIEW_TTL_S` by later sheets
# and built once for concurrent ones (the ``metrics_shared`` single-flight pattern).
@dataclass
class _TuningView:
    store: Any                 # the case store it was read from (an ``is`` guard)
    key: tuple[Any, ...]
    expires_at: float
    rules: dict[str, tuple[Any, dict[str, Any] | None]]  # rule -> (statistics, proposal)


_tuning_view: _TuningView | None = None
_tuning_inflight: dict[tuple[Any, ...], tuple[Any, "asyncio.Future[dict[str, Any]]"]] = {}


def invalidate_tuning_view() -> None:
    """Forget the reused tuner view (test isolation, a hard reset)."""
    global _tuning_view
    _tuning_view = None
    _tuning_inflight.clear()


def invalidate_summary_views() -> None:
    """Forget every reused section view: the tuner's and the cases sections."""
    invalidate_tuning_view()
    invalidate_cases_views()


def _prefs_fingerprint(prefs: Any) -> str:
    try:
        text = prefs.model_dump_json()
    except Exception:  # noqa: BLE001 (an unhashable prefs object is never reused)
        text = f"unhashable-{id(prefs)}-{time.monotonic()}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _build_tuning_rules(state: AppState, cfg: Any, prefs: Any, guards: tuple[Any, Any]) -> dict[str, Any]:
    """Every rule's statistics and proposal, exactly as ``GET /api/tuning/recommendations``
    derives them: the same terminal-case window, the same ledger guards, and the same
    gates on each proposal (shadow evaluation, the auto-apply policy)."""
    from ..engine import threshold_tuner as tuner
    from .routes_tuning import _proposal_json, _window_cases

    cases = await _window_cases(state)
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z)
    already_tuned, already_tuned_floors = guards
    proposals = tuner.derive_proposals(
        prefs, stats, already_tuned=already_tuned, already_tuned_floors=already_tuned_floors,
    )
    rules: dict[str, Any] = {rid: (stat, None) for rid, stat in stats.items()}
    for prop in proposals:
        rid = tuner.normalize_rule_id(prop.rule_id)
        if rid not in rules or rules[rid][1] is not None:
            continue
        blocked = bool(
            cfg.shadow_eval and prop.kind != "suppression"
            and tuner.shadow_eval_hides_true_positive(prop, cases)
        )
        body = _proposal_json(prop, shadow_blocked=blocked, policy_allows=bool(cfg.auto_apply_confirmed))
        body["requires_approval"] = not bool(body.get("auto_apply"))
        rules[rid] = (rules[rid][0], body)
    return rules


async def _tuning_rules(state: AppState, cfg: Any, prefs: Any, ledger: list[Any],
                        guards: tuple[Any, Any]) -> dict[str, Any]:
    """The reused tuner view, or a fresh build (shared by concurrent callers)."""
    global _tuning_view
    store = state.cases
    key = (
        id(store), state.demo_run_id, _prefs_fingerprint(prefs),
        tuple((str(getattr(r, "id", "")), str(getattr(r, "applied_at", "")), bool(getattr(r, "rolled_back", False)))
              for r in ledger),
    )
    view = _tuning_view
    if view is not None and view.store is store and view.key == key and time.monotonic() < view.expires_at:
        return view.rules
    loop = asyncio.get_running_loop()
    pending = _tuning_inflight.get(key)
    if pending is not None and pending[0] is store and not pending[1].done() and pending[1].get_loop() is loop:
        # shield(): this caller's cancellation never cancels the shared build.
        return await asyncio.shield(pending[1])
    fut: asyncio.Future[dict[str, Any]] = loop.create_future()
    _tuning_inflight[key] = (store, fut)
    generation = state.demo_generation
    try:
        rules = await _build_tuning_rules(state, cfg, prefs, guards)
    except BaseException as exc:
        if not fut.done():
            # A waiter degrades its own section on an ordinary error; the producer's
            # cancellation (its time budget) must not cancel the requests that shared it.
            shared = exc if isinstance(exc, Exception) else RuntimeError("the shared tuning read stopped")
            fut.set_exception(shared)
            fut.exception()  # retrieved: an unshared failure never logs a warning
        raise
    else:
        if not fut.done():
            fut.set_result(rules)
        # A Demo switch while it was built: the answer is not stored for anyone else.
        if state.demo_generation == generation:
            _tuning_view = _TuningView(store, key, time.monotonic() + float(TUNING_VIEW_TTL_S), rules)
        return rules
    finally:
        current = _tuning_inflight.get(key)
        if current is not None and current[1] is fut:
            del _tuning_inflight[key]


async def _tuning_section(state: AppState, rule: str) -> RuleSummaryTuning:
    """The tuner's dry-run view of the rule, the one ``GET /api/tuning/recommendations``
    gives the Tuning page: the Wilson lower bound of its false-positive rate, the
    analyst-confirmed samples, the proposed change with the same gates the page shows
    (``shadow_blocked``, ``auto_apply``, ``reason``, plus ``requires_approval``), and the
    last change applied to it that was not rolled back. Writes nothing."""
    from ..config import ThresholdTuningConfig
    from ..engine import threshold_tuner as tuner
    from .routes_tuning import _confirmed_ledger_and_guards

    prefs = state.execution_prefs
    cfg = getattr(prefs, "threshold_tuning", None) or ThresholdTuningConfig()
    ledger, already_tuned, already_tuned_floors = await _confirmed_ledger_and_guards(state, cfg)
    rules = await _tuning_rules(state, cfg, prefs, ledger, (already_tuned, already_tuned_floors))
    wanted = tuner.normalize_rule_id(rule)
    stat, proposed = rules.get(wanted, (None, None))
    live_changes = [
        r for r in ledger
        if tuner.normalize_rule_id(getattr(r, "rule_id", "")) == wanted and not getattr(r, "rolled_back", False)
    ]
    applied = sorted((str(getattr(r, "applied_at", "") or "") for r in live_changes), reverse=True)
    return RuleSummaryTuning(
        status="ok",
        wilson_lower_bound=round(stat.fp_lower_bound, 4) if stat is not None else None,
        samples=int(stat.total) if stat is not None else 0,
        proposed_change=dict(proposed) if proposed is not None else None,
        last_tuned=applied[0] if applied and applied[0] else None,
    )


def _caller_role(view: Any) -> str:
    role = getattr(view, "role", "") or ""
    return str(getattr(role, "value", role) or "")


# --------------------------------------------------------------------------- #
# The route
# --------------------------------------------------------------------------- #
@router.get("/rules/summary", response_model=RuleSummary)
async def rule_summary(
    request: Request,
    rule: str = Query(..., description="The exact rule value as shown (rule id or name), 1 to 256 characters."),
    window: str | None = Query(default=None, description="Round 12 window grammar; default now-3d."),
    source_id: str | None = Query(default=None, description="Restrict the alert sections to one source."),
    state: AppState = Depends(get_state),
) -> RuleSummary:
    """One detection rule's picture for the rule sheet (see the module docstring)."""
    if not valid_rule_value(rule):
        raise HTTPException(
            status_code=400,
            detail="rule must be 1 to 256 characters on one line, without control characters",
        )
    from ..agents.chat_tools.common import operator_tz
    from ..engine.chat_starters import object_scoped
    from ..engine.time_windows import resolve_window
    from types import SimpleNamespace

    view = await resolve_access(request)
    window_text = (window or "").strip() or RULE_SUMMARY_DEFAULT_WINDOW
    if len(window_text) > _WINDOW_MAX_CHARS:
        raise HTTPException(status_code=400, detail=f"window is too long (at most {_WINDOW_MAX_CHARS} characters)")
    try:
        resolved = resolve_window(
            window_text, tz=operator_tz(SimpleNamespace(prefs=state.execution_prefs)),
            now=now_utc(), default=RULE_SUMMARY_DEFAULT_WINDOW,
        )
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=(
                "window is not a time window this endpoint understands; use all, a relative "
                "window such as now-24h or now-3d, a calendar period such as this_month, or a "
                "range such as 2026-10-01..2026-10-26"
            ),
        ) from None
    scope = (source_id or "").strip() or None

    summary = RuleSummary(
        rule=rule,
        window=RuleSummaryWindow(
            label=_window_label(resolved.label),
            # The bounds the figures cover, exactly: an all-time window is counted from
            # the epoch, and a Logs link built from ``from``/``to`` must read the same
            # events (a missing ``from`` there means the last 24 hours).
            **{"from": resolved.iso_from() or _EPOCH_ISO},
            to=resolved.end.isoformat(),
        ),
    )

    async def alerts_part() -> None:
        if not view.allows("sources", "read"):
            summary.alerts = RuleSummaryAlerts(status="forbidden", count=None, count_relation="gte")
            summary.top_source_ips = RuleSummaryTopList(status="forbidden", exact=False)
            summary.top_targets = RuleSummaryTopList(status="forbidden", exact=False)
            return
        try:
            alerts, ips, targets = await _alert_sections(state, rule, resolved, scope)
        except Exception as exc:  # noqa: BLE001 (the section degrades alone)
            logger.warning("rule summary alerts failed: %r", exc)
            reason = "The alert figures could not be read right now."
            alerts = RuleSummaryAlerts(status="unavailable", reason=reason, count=None, count_relation="gte")
            ips = RuleSummaryTopList(status="unavailable", reason=reason, exact=False)
            targets = RuleSummaryTopList(status="unavailable", reason=reason, exact=False)
        summary.alerts, summary.top_source_ips, summary.top_targets = alerts, ips, targets

    async def cases_part() -> None:
        if not view.allows("cases", "read"):
            summary.cases = RuleSummaryCases(status="forbidden")
            return
        try:
            # The chat starters' and ``GET /api/auth/me``'s rule (fail closed): a case
            # aggregate does not respect row scope yet, so a scoped caller gets none (D16).
            scoped = bool(object_scoped(state, _caller_role(view)))
            summary.cases = await asyncio.wait_for(
                _cases_section(state, rule, scoped=scoped), timeout=SECTION_TIMEOUT_S,
            )
        except Exception as exc:  # noqa: BLE001 (a timeout included)
            logger.warning("rule summary cases failed: %r", exc)
            summary.cases = RuleSummaryCases(status="unavailable", reason="The cases could not be read right now.")

    async def tuning_part() -> None:
        if not view.allows("automation", "read"):
            summary.tuning = RuleSummaryTuning(status="forbidden")
            return
        try:
            summary.tuning = await asyncio.wait_for(_tuning_section(state, rule), timeout=SECTION_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001 (a timeout included)
            logger.warning("rule summary tuning failed: %r", exc)
            summary.tuning = RuleSummaryTuning(status="unavailable", reason="Tuning history could not be read right now.")

    def rules_part() -> None:
        if not view.allows("rules", "read"):
            summary.definition = RuleSummaryDefinition(status="forbidden")
            summary.analyst_policy = RuleSummaryAnalystPolicy(status="forbidden")
            return
        try:
            summary.definition = _definition_section(state, rule)
        except Exception as exc:  # noqa: BLE001
            logger.warning("rule summary definition failed: %r", exc)
            summary.definition = RuleSummaryDefinition(status="unavailable", reason="The rule settings could not be read.")
        try:
            summary.analyst_policy = _policy_section(state, rule)
        except Exception as exc:  # noqa: BLE001
            logger.warning("rule summary analyst policy failed: %r", exc)
            summary.analyst_policy = RuleSummaryAnalystPolicy(
                status="unavailable", reason="The analyst policies could not be read.",
            )

    rules_part()
    await asyncio.gather(alerts_part(), cases_part(), tuning_part())
    return summary
