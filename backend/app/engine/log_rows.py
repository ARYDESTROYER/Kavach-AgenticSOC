"""Browse-logs row projection and the multi-source scatter-gather read.

Moved from ``api/routes.py`` (chat revamp SPEC §5.3, "route-private helpers move
first"): the ``_log_row`` projection, the ``_browse_truncated`` rule, the
``_source_can_browse`` predicate, and the core of ``GET /api/logs`` (the per-source
readers plus the timeout-guarded ``gather``). The route keeps its HTTP-only work
(parameter clamping is shared from here, the 404/501 scope checks stay in the route)
and then calls :func:`fan_out`; the chat ``search_logs`` tool calls the same code for
its all-sources mode, so the two can never disagree about rows, truncation or partial
success. ``api.routes`` re-exports the historical underscore names because tests and
``routes_rules`` import them from there.

Read-only (#1/#12): pull sources use the per-source client from
``es_client_for_source`` (per-source TLS, management key dropped), push sources read the
process-local live-tail ring, demo sources read their own in-memory adapters, and no
secret ever appears in a row. Rows carry the FULL log document in ``_raw`` for the UI;
that field is log data and UNTRUSTED (#9) and must never reach a model (#7).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

from ..connectors.base import StructuredQuery
from ..constants import DEFAULT_SEVERITY_SCALE_MAX, SourceType
from .severity_levels import (
    LEVELS_ASCENDING,
    RawSeverityRange,
    level_at_least,
    level_of_raw,
    normalise_level,
    raw_range,
    scale_max_for_source,
)

logger = logging.getLogger("tlsoc.engine.log_rows")

__all__ = [
    "BUFFER_FILTER_SCAN",
    "BrowseReader",
    "BrowseTarget",
    "FilteredRead",
    "FilteredReader",
    "LOG_FILTER_LEVELS",
    "LogFilter",
    "RULE_FILTER_MAX_CHARS",
    "browse_query",
    "browse_truncated",
    "clamp_browse_limit",
    "clamp_per_source_timeout",
    "demo_browse_targets",
    "demo_filtered_reader",
    "demo_reader",
    "event_rule_identities",
    "fan_out",
    "in_ring_window",
    "log_message",
    "log_row",
    "open_pull_connector",
    "pull_filtered_reader",
    "pull_reader",
    "push_filtered_reader",
    "push_reader",
    "ring_window_millis",
    "search_kept_every_hit",
    "search_total_relation",
    "source_can_browse",
    "source_counts_natively",
    "tenant_browse_targets",
    "valid_rule_value",
]


# --------------------------------------------------------------------------- #
# Row projection (moved unchanged)
# --------------------------------------------------------------------------- #
def log_message(src: dict[str, Any]) -> str:
    from ..utils import dotted_get
    for f in (
        "message", "description", "full_log", "event.original", "log.message",
        "event.action", "rule.description",
    ):
        v = dotted_get(src, f)
        if v:
            return str(v) if not isinstance(v, list) else str(v[0])
    return ""


def log_row(ev) -> dict[str, Any]:
    """Project a RawEvent → the browse-logs row contract. _raw is the full log
    document (log data, never secrets)."""
    import datetime as _dt
    ts_iso = ""
    if getattr(ev, "timestamp_millis", 0):
        ts_iso = _dt.datetime.fromtimestamp(ev.timestamp_millis / 1000, tz=_dt.timezone.utc).isoformat()
    return {
        "id": ev.id,
        "ts": ts_iso,
        "source_ip": ev.ip,
        "user": ev.user,
        "host": ev.host,
        "rule": ev.rule or ev.rule_name,
        "severity": ev.severity,
        "message": log_message(ev.source or {}),
        "_raw": ev.source or {},
    }


def browse_truncated(returned: int, limit: int, total: int | None) -> bool:
    """Honest "there is more than this" flag for a bounded browse read.

    Browse has NO pagination: every read is "the most recent ``limit`` rows". When a
    connector reports a coherent match ``total`` we answer EXACTLY from it and stop —
    a known total equal to the returned row count means nothing was cut, even when the
    page is exactly saturated (``total == returned == limit`` is complete, not "more
    exist"). Only when the total is absent or incoherent (push live-tail buffers,
    connectors that omit or under-report ``total``) is a full page the sole evidence
    available, and a saturated page is then reported as truncated. ``False`` never
    means "complete" for a caller that wants completeness — it only means nothing was
    demonstrably cut."""
    if total is not None and total >= returned:
        return total > returned
    return returned >= limit


# --------------------------------------------------------------------------- #
# Round 14 (SPEC §4.6.1): the exact rule and severity filters
# --------------------------------------------------------------------------- #
#: The longest rule value a filter accepts (``models.RULE_VALUE_MAX_CHARS``).
RULE_FILTER_MAX_CHARS = 256
#: The named levels a ``severity``/``severity_gte`` filter accepts, lowest first.
LOG_FILTER_LEVELS: tuple[str, ...] = LEVELS_ASCENDING
#: How many buffered events a filtered read of a push source's live-tail ring scans:
#: the whole ring (``IngestService._recent_max``), so a filter is applied to every
#: event the ring holds, not to the newest ``limit`` of them.
BUFFER_FILTER_SCAN = 500


def valid_rule_value(value: Any) -> bool:
    """A rule filter value: 1 to 256 code points on one line, none of them in Unicode
    category C (control, format, surrogate, private use, unassigned) or a line or
    paragraph separator. Never trimmed: the value is the exact text to match. The same
    character rule as ``agents.blocks.is_safe_log_query`` and the Console router's
    ``rule`` deep-link validator (``^[^\\p{C}\\u2028\\u2029]{1,256}$``)."""
    if not isinstance(value, str) or not 1 <= len(value) <= RULE_FILTER_MAX_CHARS:
        return False
    return not any(ch in "\u2028\u2029" or unicodedata.category(ch).startswith("C") for ch in value)


def _str_values(value: Any) -> list[str]:
    """Every non-null value of a document field as text (a list field gives each item)."""
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else [value]
    return [str(item) for item in items if item is not None and not isinstance(item, (dict, list, tuple))]


def event_rule_identities(ev: Any, prefs: Any = None) -> set[str]:
    """Every rule identity an event carries: its classified rule (``RawEvent.rule``: the
    suite rule it matched, else the rule field), its rule name, and, when the source's
    effective ``prefs`` are given, every raw value of the rule field and the rule name
    field. A ``rule`` filter matches an event when the value equals any of them, which
    is what the Elastic-family connectors compile natively
    (``connectors.elastic.rule_identity_clause``)."""
    from ..utils import dotted_get

    identities: set[str] = set()
    for value in (getattr(ev, "rule", None), getattr(ev, "rule_name", None)):
        if value is not None:
            identities.add(str(value))
    source = getattr(ev, "source", None)
    if prefs is not None and isinstance(source, dict):
        for path in (getattr(prefs, "rule_field", None), getattr(prefs, "rule_name_field", None)):
            if path:
                identities.update(_str_values(dotted_get(source, path)))
    return identities


@dataclass(frozen=True)
class LogFilter:
    """The exact filters ``GET /api/logs`` (and the rule summary) apply to every
    source: a rule value and a named severity level (exact, or "this level or above").

    A level means the same thing on every source because it is projected through each
    source's own severity ceiling (:mod:`app.engine.severity_levels`); a rule matches any
    rule identity of an event (:func:`event_rule_identities`). The values are untrusted
    (#9) and only ever bound as filter values."""

    rule: str | None = None
    severity: str | None = None
    severity_gte: str | None = None

    @property
    def active(self) -> bool:
        return self.rule is not None or self.severity is not None or self.severity_gte is not None

    def echo(self) -> dict[str, Any]:
        """The ``filters`` object of the response: what the server applied."""
        return {"rule": self.rule, "severity": self.severity, "severity_gte": self.severity_gte}

    def severity_range(self, scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX) -> RawSeverityRange:
        """This filter's level bounds as one source's raw range."""
        return raw_range(level=self.severity, at_least=self.severity_gte, scale_max=scale_max)

    def level_ok(self, raw: Any, scale_max: Any) -> bool:
        if self.severity is None and self.severity_gte is None:
            return True
        level = level_of_raw(raw, scale_max)
        if self.severity is not None and level != self.severity:
            return False
        if self.severity_gte is not None and not level_at_least(level, self.severity_gte):
            return False
        return True

    def matches_event(self, ev: Any, *, scale_max: Any, prefs: Any = None) -> bool:
        """Does one ``RawEvent`` pass every filter (the Python form of the native one)?"""
        if self.rule is not None and self.rule not in event_rule_identities(ev, prefs):
            return False
        return self.level_ok(getattr(ev, "severity", None), scale_max)

    def matches_row(self, row: dict[str, Any], *, scale_max: Any) -> bool:
        """The same test over a projected browse row (its shown rule and severity)."""
        if self.rule is not None and str(row.get("rule")) != self.rule:
            return False
        return self.level_ok(row.get("severity"), scale_max)

    @classmethod
    def parse(
        cls, *, rule: Any = None, severity: Any = None, severity_gte: Any = None,
    ) -> "LogFilter":
        """Validate request parameters; raises ``ValueError`` naming the bad one. An
        empty parameter means "not filtered" (``?rule=`` is no filter), the way the
        route already treats an empty ``source_id``."""
        rule_value = None if rule is None or rule == "" else rule
        if rule_value is not None and not valid_rule_value(rule_value):
            raise ValueError(
                f"rule must be 1 to {RULE_FILTER_MAX_CHARS} characters on one line, "
                "without control characters"
            )
        levels: dict[str, str | None] = {}
        for name, raw in (("severity", severity), ("severity_gte", severity_gte)):
            if raw is None or (isinstance(raw, str) and raw.strip() == ""):
                levels[name] = None
                continue
            level = normalise_level(raw)
            if level is None:
                raise ValueError(f"{name} must be one of {', '.join(LOG_FILTER_LEVELS)}")
            levels[name] = level
        return cls(rule=rule_value, severity=levels["severity"], severity_gte=levels["severity_gte"])


@dataclass(frozen=True)
class FilteredRead:
    """One source's filtered read: rows that pass every filter, the source's match
    total when it is known (``None`` otherwise), whether the filter was applied to the
    whole population (``exact``) rather than after a bounded read, and the total's
    ``relation``: ``eq`` when it is the exact number of matching events, ``gte`` when it
    is a lower bound (a live-tail ring holds only recent events; a backend reported a
    capped total)."""

    rows: list[dict[str, Any]]
    total: int | None
    exact: bool
    relation: Literal["eq", "gte"] = "eq"


def search_total_relation(result: Any) -> Literal["eq", "gte"]:
    """The relation an Elastic-family response's hit total has to the matching events:
    ``gte`` when the backend stopped counting at its tracking bound, and when it
    answered from part of its data (a failed shard, a timeout:
    ``connectors.elastic.response_is_complete``), whose hits and total miss that part."""
    from ..connectors.elastic import response_is_complete

    raw = getattr(result, "raw", None)
    if not response_is_complete(raw):
        return "gte"
    hits = raw.get("hits") if isinstance(raw, dict) else None
    total = hits.get("total") if isinstance(hits, dict) else None
    if isinstance(total, dict) and str(total.get("relation") or "eq") == "gte":
        return "gte"
    return "eq"


def search_kept_every_hit(result: Any) -> bool:
    """Did every hit of an Elastic-family response become an event? ``False`` when the
    connector dropped some after the search (an IGNORE carve-out the native query did
    not leave out, ``ElasticConnector._tag_events``): the native total then counts
    events no row can show, so it is not the filtered total. A result without a native
    response says nothing and passes."""
    raw = getattr(result, "raw", None)
    hits = raw.get("hits") if isinstance(raw, dict) else None
    listed = hits.get("hits") if isinstance(hits, dict) else None
    if not isinstance(listed, list):
        return True
    return len(listed) <= len(getattr(result, "events", None) or [])


def source_counts_natively(conn: Any) -> bool:
    """Can a pull connector's native totals be the filtered totals? Not when one of its
    IGNORE carve-outs cannot be left out natively (``ElasticConnector.carve_outs_native``):
    its native count would include events the union search drops. A connector without
    carve-outs (or without the method) can."""
    check = getattr(conn, "carve_outs_native", None)
    if not callable(check):
        return True
    try:
        return bool(check())
    except Exception:  # noqa: BLE001 (an unreadable feed list proves nothing exact)
        return False


FilteredReader = Callable[[StructuredQuery, LogFilter], Awaitable[FilteredRead]]


def _combined_floor(*bounds: Any) -> float | None:
    values = [float(b) for b in bounds if b not in (None, "")]
    return max(values) if values else None


def source_can_browse(reg, src) -> bool:
    """True when a source advertises the ``browse`` capability (registry augments every
    push receiver with it; pull manifests declare it explicitly). Defensive — a missing
    manifest / odd capabilities list is treated as NOT browsable rather than raising."""
    try:
        manifest = reg.manifest(src.source_type)
    except Exception:  # noqa: BLE001 — one bad manifest never breaks the scan
        return False
    return bool(manifest) and "browse" in (manifest.capabilities or [])


# --------------------------------------------------------------------------- #
# Scatter-gather (the core of GET /api/logs)
# --------------------------------------------------------------------------- #
# A reader runs ONE source's bounded read and returns (rows, total): ``total`` is the
# connector's match count when it supplies one and None when it cannot (live-tail
# rings). The pair is what lets the merged envelope apply the SAME
# ``browse_truncated`` rule per source that ``GET /sources/{id}/logs`` applies, instead
# of only asking whether the merge itself overflowed (which one source can never do,
# since each is read at ``limit``).
BrowseReader = Callable[[StructuredQuery], Awaitable[tuple[list[dict[str, Any]], int | None]]]


@dataclass(frozen=True)
class BrowseTarget:
    """One source in a fan-out: its provenance plus the reader that browses it.

    ``mode`` is carried alongside the reader so the per-source status can report a
    volatile live-tail ring (``"buffer"``, which IGNORES from/to/query, except that a
    filtered read keeps to an explicit from/to: :func:`push_filtered_reader`) vs a real
    backing search (``"search"``) even when the read fails.

    Round 14 (SPEC §4.6.1): ``scale_max`` is the ceiling the level filters project the
    severity values of THIS reader's events through, and ``filtered`` the reader that
    applies a :class:`LogFilter` as exactly as the source allows. A pull source's events
    carry their NATIVE value, so it is the source's declared ceiling; a push source's
    ring and a Demo adapter hold events already normalised onto the canonical 0 to 100
    score, so theirs is the default ceiling (the identity). A target built without a
    filtered reader (a third-party caller) is filtered after its ordinary bounded read."""

    source_id: str
    source_name: str
    mode: Literal["search", "buffer"]
    read: BrowseReader
    scale_max: float = DEFAULT_SEVERITY_SCALE_MAX
    filtered: FilteredReader | None = None


def clamp_browse_limit(limit: Any) -> int:
    """The browse hard cap: 1..200 (applied per source AND on the merge)."""
    return max(1, min(int(limit or 100), 200))


def clamp_per_source_timeout(per_source_timeout: Any) -> float:
    """The per-source read timeout: 0.5..30 s (default 8 s)."""
    return max(0.5, min(float(per_source_timeout or 8.0), 30.0))


def browse_query(
    *,
    limit: int,
    query: str | None = None,
    time_from: str | None = None,
    time_to: str | None = None,
) -> StructuredQuery:
    """The bounded newest-first browse query every source receives.

    Callers that need narrower filters (the chat ``search_logs`` tool) may pass any
    other :class:`StructuredQuery` to :func:`fan_out`; ``size`` is the per-source and
    merge bound either way."""
    return StructuredQuery(
        contains=(query or None), time_from=time_from, time_to=time_to,
        size=limit, sort_desc=True,
    )


def _pull_connector(src, es_client):
    from ..connectors.elastic import ElasticConnector
    from ..connectors.opensearch import OpenSearchConnector
    from ..connectors.wazuh import WazuhConnector
    if src.source_type == SourceType.OPENSEARCH:
        return OpenSearchConnector(es_client, config=src.config, connector_id=src.id)
    if src.source_type == SourceType.WAZUH:
        return WazuhConnector(es_client, config=src.config, connector_id=src.id)
    return ElasticConnector(es_client, config=src.config, connector_id=src.id)


@contextlib.asynccontextmanager
async def open_pull_connector(
    src, es_client_for_source: Callable[[Any], tuple[Any, bool]],
) -> AsyncIterator[Any]:
    """The browse connector of one PULL source over its own scoped read-only client
    (``es_client_for_source``: per-source TLS, management key dropped, #1). An owned
    client is always closed on exit, even when the body raised."""
    es_client, owned = es_client_for_source(src)
    try:
        yield _pull_connector(src, es_client)
    finally:
        if owned:
            try:
                await es_client.close()
            except Exception:  # noqa: BLE001
                pass


def _log_filter_query(sq: StructuredQuery, log_filter: LogFilter, scale_max: float):
    """``sq`` plus ``log_filter`` as the Elastic-family connectors compile it."""
    from ..connectors.elastic import LogFilterQuery

    bounds = log_filter.severity_range(scale_max)
    data = sq.model_dump()
    data.update(
        rule_any=log_filter.rule,
        severity_gte=_combined_floor(sq.severity_gte, bounds.gte),
        severity_lt=bounds.lt,
        severity_missing=bounds.include_missing and bounds.lt is not None,
    )
    return LogFilterQuery.model_validate(data)


def pull_filtered_reader(
    src,
    *,
    prefs: Any,
    es_client_for_source: Callable[[Any], tuple[Any, bool]],
    scale_max: float,
) -> FilteredReader:
    """A pull source's filtered read: the rule and level filters are compiled into the
    connector's own query (``LogFilterQuery``, which also leaves out the source's IGNORE
    carve-outs natively), so the read is exact and its match total is the filtered
    total. The total is stated as exact only when nothing contradicts it:

    * every returned event is re-checked with the Python form of the same filter; should
      one ever disagree (a field mapped in a way the native query reads differently),
      that row is dropped and the source is reported as not exact with no total;
    * every hit became an event (:func:`search_kept_every_hit`) and every carve-out was
      left out natively (:func:`source_counts_natively`); otherwise the native total
      counts muted events no row shows, so there is no total either;
    * the search answered from all of its data (:func:`search_total_relation`): a failed
      shard or a timeout leaves the total a lower bound, stated as ``gte``.

    A cluster can refuse a suite rule's clause (a ``prefix`` match on a numeric field is
    a 400). The read is then retried ONCE with the rule left to the Python filter: the
    newest events of the window, kept when they carry the rule, exact only when that
    read held every event the window has."""

    async def _read(sq: StructuredQuery, log_filter: LogFilter) -> FilteredRead:
        from ..connectors.elastic import _http_status

        async with open_pull_connector(src, es_client_for_source) as conn:
            effective = conn._effective_prefs(prefs)
            native = source_counts_natively(conn)
            try:
                result = await conn.search(prefs, _log_filter_query(sq, log_filter, scale_max))
            except Exception as exc:  # noqa: BLE001 (classified below)
                if log_filter.rule is None or _http_status(exc) != 400:
                    raise
                logger.warning("filtered browse on %s: the rule clause was refused (%s); "
                               "filtering the newest events instead", src.id, exc)
                unruled = LogFilter(severity=log_filter.severity, severity_gte=log_filter.severity_gte)
                result = await conn.search(prefs, _log_filter_query(sq, unruled, scale_max))
                kept = [ev for ev in result.events
                        if log_filter.matches_event(ev, scale_max=scale_max, prefs=effective)]
                complete = (native and search_kept_every_hit(result)
                            and result.total is not None and int(result.total) <= len(result.events)
                            and search_total_relation(result) == "eq")
                return FilteredRead(
                    [log_row(ev) for ev in kept], len(kept) if complete else None, complete,
                    "eq" if complete else "gte",
                )
        kept = [ev for ev in result.events
                if log_filter.matches_event(ev, scale_max=scale_max, prefs=effective)]
        rows = [log_row(ev) for ev in kept]
        if len(kept) != len(result.events):
            logger.warning(
                "filtered browse on %s: %d of %d rows failed the exact re-check",
                src.id, len(result.events) - len(kept), len(result.events),
            )
            return FilteredRead(rows, None, False, "gte")
        if not native or not search_kept_every_hit(result):
            logger.warning("filtered browse on %s: a muted feed's events reached the native "
                           "count; no exact total", src.id)
            return FilteredRead(rows, None, False, "gte")
        relation = search_total_relation(result)
        # A partial answer (a failed shard, a timeout) still bounds the total from below.
        return FilteredRead(rows, result.total, relation == "eq", relation)

    return _read


def pull_reader(
    src,
    *,
    prefs: Any,
    es_client_for_source: Callable[[Any], tuple[Any, bool]],
) -> BrowseReader:
    """A bounded scoped read-only search for one PULL source. The client comes from
    ``es_client_for_source`` (per-source TLS, management key dropped, #1) and an owned
    client is always closed, even when the search raises."""

    async def _read(sq: StructuredQuery) -> tuple[list[dict[str, Any]], int | None]:
        es_client, owned = es_client_for_source(src)
        try:
            conn = _pull_connector(src, es_client)
            result = await conn.search(prefs, sq)
            return [log_row(ev) for ev in result.events], result.total
        finally:
            if owned:
                try:
                    await es_client.close()
                except Exception:  # noqa: BLE001
                    pass

    return _read


def ring_window_millis(sq: StructuredQuery) -> tuple[int | None, int | None]:
    """The explicit ``from`` and ``to`` of a read as epoch millis, each ``None`` when it
    is absent or does not parse. The grammar is the one a pull search resolves its own
    bounds with (``now``, ``now-3d``, an ISO-8601 instant, epoch millis), read against
    one clock so ``now-1h`` and ``now`` describe one window."""
    from ..utils import now_utc, relative_to_millis_strict

    now = now_utc()
    return (
        relative_to_millis_strict(sq.time_from, now=now),
        relative_to_millis_strict(sq.time_to, now=now),
    )


def in_ring_window(ev: Any, start_ms: int | None, end_ms: int | None) -> bool:
    """``ev`` falls inside ``[start_ms, end_ms]`` (both inclusive, as a pull search's
    ``gte``/``lte`` range). An event with no timestamp reads as the epoch, so a real
    lower bound leaves it out. A ``None`` bound does not apply."""
    ts = int(getattr(ev, "timestamp_millis", 0) or 0)
    if start_ms is not None and ts < start_ms:
        return False
    return not (end_ms is not None and ts > end_ms)


def push_filtered_reader(
    src, *, ingest_service: Any, scale_max: float = DEFAULT_SEVERITY_SCALE_MAX,
) -> FilteredReader:
    """A push source's filtered read over its whole live-tail ring
    (:data:`BUFFER_FILTER_SCAN` events): the newest ``size`` that pass. The ring is a
    bounded, volatile window of the source's recent events, so the read is never
    exact; ``total`` is how many events the ring holds that pass. The ring's events are
    already on the canonical 0 to 100 score (normalised on ingest through the source's
    declared ceiling), so ``scale_max`` is the default ceiling.

    The read's explicit ``from`` and ``to`` apply here (:func:`ring_window_millis`), as
    they do to a pull search and to the rule summary's read of the same ring, so the
    rows and ``total`` describe the window the page names. A bound that is absent or
    does not parse leaves that side open; the total is "at least" either way. Free
    text (``query``) still does not apply to a ring."""

    async def _read(sq: StructuredQuery, log_filter: LogFilter) -> FilteredRead:
        start_ms, end_ms = ring_window_millis(sq)
        events = ingest_service.recent_events_for_source(src.id, BUFFER_FILTER_SCAN)
        kept = [
            ev for ev in events
            if in_ring_window(ev, start_ms, end_ms) and log_filter.matches_event(ev, scale_max=scale_max)
        ]
        return FilteredRead(
            [log_row(ev) for ev in kept[: max(1, int(sq.size or 1))]], len(kept), False, "gte",
        )

    return _read


def push_reader(src, *, ingest_service: Any) -> BrowseReader:
    """The live-tail ring for one PUSH source. Filters other than the size bound do not
    apply (mode ``"buffer"``)."""

    async def _read(sq: StructuredQuery) -> tuple[list[dict[str, Any]], int | None]:
        # A live-tail ring has no match total to report — None keeps the saturated-page
        # heuristic in `browse_truncated`.
        rows = [log_row(ev)
                for ev in ingest_service.recent_events_for_source(src.id, sq.size)]
        return rows, None

    return _read


def demo_reader(
    source_id: str,
    *,
    prefs: Any,
    demo_source_connector: Callable[[str], Any],
) -> BrowseReader:
    """A Demo Mode adapter's filtered search over its own in-memory ring. A demo
    session never reaches a tenant connector."""

    async def _read(sq: StructuredQuery) -> tuple[list[dict[str, Any]], int | None]:
        conn = demo_source_connector(source_id)
        if conn is None:
            return [], None
        result = await conn.search(prefs, sq)
        return [log_row(ev) for ev in result.events], result.total

    return _read


def demo_filtered_reader(
    source_id: str,
    *,
    prefs: Any,
    demo_source_connector: Callable[[str], Any],
    scale_max: float = DEFAULT_SEVERITY_SCALE_MAX,
) -> FilteredReader:
    """A Demo Mode adapter's filtered read. The adapter matches a rule against the
    event's rule and rule name and applies a severity floor over its whole ring, so
    those filters are exact; an upper level bound (an exact level below Critical) is
    applied afterwards, which stays exact only while the adapter returned every match."""

    async def _read(sq: StructuredQuery, log_filter: LogFilter) -> FilteredRead:
        conn = demo_source_connector(source_id)
        if conn is None:
            return FilteredRead([], None, True)
        bounds = log_filter.severity_range(scale_max)
        native = sq.model_copy(update={
            "rule": log_filter.rule if log_filter.rule is not None else sq.rule,
            "severity_gte": _combined_floor(sq.severity_gte, bounds.gte),
        })
        result = await conn.search(prefs, native)
        kept = [ev for ev in result.events if log_filter.matches_event(ev, scale_max=scale_max)]
        rows = [log_row(ev) for ev in kept]
        if len(kept) == len(result.events) and bounds.lt is None:
            return FilteredRead(rows, result.total, True)
        complete = result.total is not None and int(result.total) <= len(result.events)
        return FilteredRead(rows, len(kept) if complete else None, complete, "eq" if complete else "gte")

    return _read


def tenant_browse_targets(
    sources: Iterable[Any],
    *,
    prefs: Any,
    registry: Any,
    es_client_for_source: Callable[[Any], tuple[Any, bool]],
    ingest_service: Any,
    source_id: str | None = None,
) -> list[BrowseTarget]:
    """Every enabled, browse-capable configured source (optionally just ``source_id``).

    Sources without a registered connector, or that are neither push nor pull, are
    skipped silently: the route has already turned an explicitly scoped ineligible id
    into a 501 before it gets here."""
    targets: list[BrowseTarget] = []
    for src in sources:
        if not src.enabled or not source_can_browse(registry, src):
            continue
        if source_id is not None and src.id != source_id:
            continue
        cls = registry.get(src.source_type)
        if cls is None:
            continue
        name = src.display_name or src.id
        if registry.is_receiver(src.source_type):
            # A pushed record is normalised on ingest: the source's declared ceiling
            # already projected its native severity onto the canonical 0 to 100 score
            # the ring holds (``generic_to_ocsf`` then ``RawEvent.from_ocsf``), so the
            # ring is read on the default ceiling. Projecting it again would move it.
            targets.append(BrowseTarget(
                src.id, name, "buffer", push_reader(src, ingest_service=ingest_service),
                scale_max=DEFAULT_SEVERITY_SCALE_MAX,
                filtered=push_filtered_reader(
                    src, ingest_service=ingest_service, scale_max=DEFAULT_SEVERITY_SCALE_MAX,
                ),
            ))
        elif registry.is_pull(src.source_type):
            # A pull event carries the source's NATIVE severity value: its own ceiling.
            scale = scale_max_for_source(src)
            targets.append(BrowseTarget(
                src.id, name, "search",
                pull_reader(src, prefs=prefs, es_client_for_source=es_client_for_source),
                scale_max=scale,
                filtered=pull_filtered_reader(
                    src, prefs=prefs, es_client_for_source=es_client_for_source, scale_max=scale,
                ),
            ))
    return targets


def demo_browse_targets(
    demo_sources: Iterable[dict[str, Any]],
    *,
    prefs: Any,
    demo_source_connector: Callable[[str], Any],
    source_id: str | None = None,
) -> list[BrowseTarget]:
    """The isolated Demo Mode sources (``state.demo_sources_overlay()`` rows)."""
    targets: list[BrowseTarget] = []
    for row in demo_sources:
        sid = str(row.get("id"))
        if not sid:
            continue
        if source_id is not None and sid != source_id:
            continue
        # "search", not "buffer": the demo adapter's read is a real filtered search
        # over its ring (from/to/query all apply, and it reports a match total).
        # A Demo source never enters ``Preferences.sources``: its events are already on
        # the canonical 0 to 100 score, the default ceiling.
        targets.append(BrowseTarget(
            sid, row.get("display_name") or sid, "search",
            demo_reader(sid, prefs=prefs, demo_source_connector=demo_source_connector),
            filtered=demo_filtered_reader(
                sid, prefs=prefs, demo_source_connector=demo_source_connector,
            ),
        ))
    return targets


def _source_error(target: BrowseTarget, exc: BaseException, *, raw_errors: bool) -> str:
    """The per-source ``error`` text of a failed read.

    ``raw_errors=True`` is the historical ``GET /api/logs`` value (``"timeout"`` or
    ``str(exception)``), kept so that envelope does not change. ``raw_errors=False``
    returns only the kind (``"timeout"`` or ``"error"``) for callers whose output can
    reach a prompt or the chat UI, where raw exception text is not allowed (SPEC §5.2);
    the detail is logged server-side instead so it is not lost."""
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout"
    if raw_errors:
        return str(exc)
    import logging

    logging.getLogger("tlsoc.engine.log_rows").warning(
        "browse read failed for source %s: %s", target.source_id, exc
    )
    return "error"


async def fan_out(
    targets: Iterable[BrowseTarget],
    sq: StructuredQuery,
    *,
    per_source_timeout: float,
    raw_errors: bool = True,
    log_filter: LogFilter | None = None,
) -> dict[str, Any]:
    """Read every target concurrently and merge newest-first: the ``GET /api/logs``
    envelope, byte-for-byte.

    Resilient by design: each source runs under ``asyncio.wait_for`` and the whole set
    under ``gather(return_exceptions=True)``, so one slow or failing source degrades to
    a per-source error entry and NEVER blocks the rest (partial success, #11).
    ``sq.size``, clamped here to the 1..200 browse cap, is the bound applied per source
    AND on the merge. The route clamps before calling, so for it this is a no-op; it is
    enforced here as well because the chat ``search_logs`` tool passes a size the model
    influenced, and a shared helper must not rely on every caller remembering the cap.
    Every row is stamped with a MANDATORY ``source_id``/``source_name`` provenance
    column (overwritten, never trusted from the row). Each target gets its own copy of
    the (clamped) ``sq`` so a connector can never leak a mutation into another source's
    read. ``raw_errors`` selects the per-source ``error`` text (see
    :func:`_source_error`): leave it True for the route, pass False from chat.

    Round 14 (SPEC §4.6.1, §4.6.6): an active ``log_filter`` (rule, exact level, level
    or above) is applied to every source as exactly as that source allows
    (:attr:`BrowseTarget.filtered`), and each per-source status then also carries
    ``exact`` (``False`` when the source could only be filtered after a bounded read: a
    push source's live-tail ring, an adapter that returned only part of its matches; or
    when a pull search answered from part of its data or its native total could count
    muted events: so its rows are "at least" these), ``total`` (the source's number of
    matching events
    in the window, or ``None`` when unknown) and ``total_relation`` (``eq`` for an exact
    total, ``gte`` for a lower bound). The envelope adds ``matched: {count, relation}``:
    the events the filter matched over every source, beyond the ``limit`` rows shown
    (the figure the Logs page states, and the one the rule summary counts). Its
    relation is ``eq`` only when every source answered with an exact total; otherwise
    ``count`` is a lower bound (a source with an unknown total adds the rows it
    returned, a failed source adds nothing). Without a filter the envelope is
    unchanged, key for key."""
    targets = list(targets)
    limit = clamp_browse_limit(sq.size)
    if sq.size != limit:
        sq = sq.model_copy(update={"size": limit})
    active = log_filter if log_filter is not None and log_filter.active else None
    filtering = active is not None

    async def _filtered(
        target: BrowseTarget, query: StructuredQuery, flt: LogFilter,
    ) -> FilteredRead:
        if target.filtered is not None:
            return await target.filtered(query, flt)
        # A target without a filtered reader: its ordinary bounded read, filtered here,
        # exact only when that read returned every match of the source.
        rows, total = await target.read(query)
        kept = [row for row in rows if flt.matches_row(row, scale_max=target.scale_max)]
        complete = target.mode == "search" and total is not None and int(total) <= len(rows)
        return FilteredRead(kept, len(kept) if complete else None, complete, "eq" if complete else "gte")

    async def _guarded(target: BrowseTarget):
        query = sq.model_copy(deep=True)
        if active is not None:
            return await asyncio.wait_for(_filtered(target, query, active), timeout=per_source_timeout)
        return await asyncio.wait_for(target.read(query), timeout=per_source_timeout)

    results = await asyncio.gather(
        *[_guarded(target) for target in targets], return_exceptions=True
    )

    merged: list[dict[str, Any]] = []
    source_status: list[dict[str, Any]] = []
    any_source_truncated = False
    matched_count = 0
    matched_exact = True
    for target, outcome in zip(targets, results):
        if isinstance(outcome, Exception):
            failed = {
                "source_id": target.source_id, "source_name": target.source_name,
                "ok": False,
                "error": _source_error(target, outcome, raw_errors=raw_errors),
                "count": 0,
                "mode": target.mode,
                # A read that failed returned nothing; it cut nothing either. The
                # honest signal for "you are missing rows here" is `ok: False`.
                "truncated": False,
            }
            if filtering:
                failed.update(exact=False, total=None, total_relation="gte")
                matched_exact = False
            source_status.append(failed)
            continue
        read: FilteredRead | None = outcome if isinstance(outcome, FilteredRead) else None
        if read is not None:
            rows, total = read.rows, read.total
        else:
            rows, total = outcome if isinstance(outcome, tuple) else (outcome or [], None)
        for row in rows:
            # MANDATORY provenance — overwrite (never trust a per-source row to self-label).
            row["source_id"] = target.source_id
            row["source_name"] = target.source_name
        merged.extend(rows)
        # The SAME rule the per-source sibling route applies to this identical read.
        src_truncated = browse_truncated(len(rows), limit, total)
        any_source_truncated = any_source_truncated or src_truncated
        status = {
            "source_id": target.source_id, "source_name": target.source_name,
            "ok": True, "count": len(rows),
            # "search" = a real backing query (from/to/query applied); "buffer" = a
            # volatile process-local live-tail ring that IGNORES from/to/query.
            "mode": target.mode,
            # This source's own rows were demonstrably cut (its page saturated, or its
            # connector reported more matches than it returned).
            "truncated": src_truncated,
        }
        if filtering:
            # Round 14: was the rule/severity filter applied to the source's whole
            # population (True) or only after a bounded read (False, "at least")? And
            # how many events matched it, beyond the rows returned?
            exact = bool(read is not None and read.exact)
            relation = read.relation if read is not None and total is not None else "gte"
            status.update(exact=exact, total=None if total is None else int(total), total_relation=relation)
            matched_count += int(total) if total is not None else len(rows)
            matched_exact = matched_exact and exact and total is not None and relation == "eq"
        source_status.append(status)

    # Merge newest-first by ts (ISO strings sort lexicographically for UTC; empty ts
    # sorts last). Then hard-cap the merged view.
    merged.sort(key=lambda r: (r.get("ts") or ""), reverse=True)
    gathered = len(merged)
    merged = merged[:limit]
    envelope: dict[str, Any] = {
        "logs": merged,
        "count": len(merged),
        "sources": source_status,
        "partial": any(not s["ok"] for s in source_status),
        # The bound is part of the contract: this is the most recent `count` rows, not
        # a complete result.
        "limit": limit,
        # True when the MERGE was cut, OR when any single source's own read was cut —
        # each source is itself read at `limit`, so with one target the merge can never
        # overflow and only the per-source signal is honest. Without the OR this route
        # reported `false` for the very same read the per-source sibling reports as
        # truncated. `false` still does not mean "complete" for a caller that wants
        # completeness (there is no pagination) — it means nothing was demonstrably cut.
        "truncated": gathered > limit or any_source_truncated,
    }
    if filtering:
        envelope["matched"] = {"count": matched_count, "relation": "eq" if matched_exact else "gte"}
    return envelope
