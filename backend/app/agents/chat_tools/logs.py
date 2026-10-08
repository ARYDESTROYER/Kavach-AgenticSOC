"""Log tools: ``search_logs`` and ``log_stats`` (chat revamp SPEC §5.3).

Both read the log surface through the connector layer only (read-only key, #1) and
hand a model AGGREGATES: counts, top-N values and at most five sample rows of nine
identity keys, with the basis and coverage stated (#7). The full row table, the
native query and the charts are deterministic artifacts the model never receives.

Source selection never widens the request (§4.8.4): a source the request selected
is the only one read (a different ``source_id`` from the model is ignored and the
observation says so); otherwise the model may name one source, or read every
browse-capable source at once (``all_sources``, the default when more than one
exists) through the shared scatter-gather in :mod:`app.engine.log_rows` with
per-source timeouts and partial success reported in ``coverage``.

``log_stats`` counts EXACTLY through ``PullConnector.aggregate`` where a source
supports it (Elasticsearch, OpenSearch, Wazuh) and otherwise falls back to the
newest 200 events per source, labelled ``basis: newest_n`` with its coverage. Push
sources' live-tail rings (mode ``buffer``) ignore query filters, so their rows are
filtered here and the coverage says the ring only holds recent events.

A search's match total is only exact when the backend says so: Elasticsearch and
OpenSearch stop counting at 10,000 by default (``hits.total.relation == "gte"``).
Such a total is presented as "at least 10,000" (G4) unless one ``size: 0`` count
through ``aggregate()`` (``track_total_hits: true``) can make it exact.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator

from ...connectors.base import StructuredQuery
from ...engine.log_rows import BrowseTarget, clamp_per_source_timeout, fan_out
from ...utils import dotted_get
from .base import Artifact, ChatTool, ChatToolContext, ToolOutcome
from .common import (
    ToolInput,
    Window,
    column,
    finite,
    fmt_int,
    kpi,
    millis_to_iso,
    none_if_blank,
    parse_input,
    resolve_window,
    text,
    visible_text,
)

logger = logging.getLogger("tlsoc.agents.chat_tools.logs")

GroupField = Literal["ip", "user", "host", "rule", "rule_name", "severity", "action"]
GROUP_FIELDS: tuple[str, ...] = ("ip", "user", "host", "rule", "rule_name", "severity", "action")
# Engine labels for the categories artifacts (fixed per field, so header-safe).
GROUP_TITLES: dict[str, str] = {
    "ip": "Top source IPs", "user": "Top users", "host": "Top hosts",
    "rule": "Top rules", "rule_name": "Top rule names", "severity": "Events by severity",
    "action": "Top actions",
}
DISTINCT_LABELS: dict[str, str] = {
    "ip": "Distinct source IPs", "user": "Distinct users", "host": "Distinct hosts",
    "rule": "Distinct rules", "rule_name": "Distinct rule names",
    "severity": "Distinct severities", "action": "Distinct actions",
}
INTERVAL_SECONDS: dict[str, int] = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3_600, "6h": 21_600, "1d": 86_400, "1w": 604_800,
}
_FILTER_KEYS = ("ip", "user", "host", "rule", "severity_gte", "contains")
_SAMPLE_KEYS = ("ts", "source", "ip", "user", "host", "rule", "rule_name", "severity", "action")
_SAMPLE_ROWS = 5
_TOP_FACETS = 5
_STATS_SAMPLE = 200
_MAX_SERIES_POINTS = 200
_MAX_HEATMAP_X = 48
_MAX_HEATMAP_Y = 10
_DEFAULT_SOURCE_TIMEOUT = 8.0
# Elasticsearch/OpenSearch count hits exactly only up to this many by default; past
# it ``hits.total`` is ``{"value": 10000, "relation": "gte"}``.
ES_TOTAL_CAP = 10_000


# --------------------------------------------------------------------------- #
# Inputs.
# --------------------------------------------------------------------------- #
class _LogFilters(ToolInput):
    ip: str | None = Field(default=None, max_length=128)
    user: str | None = Field(default=None, max_length=256)
    host: str | None = Field(default=None, max_length=256)
    rule: str | None = Field(default=None, max_length=256)
    severity_gte: float | None = Field(default=None, ge=0, le=1000)
    contains: str | None = Field(default=None, max_length=200)
    time_from: str | None = Field(default=None, max_length=40)
    time_to: str | None = Field(default=None, max_length=40)
    source_id: str | None = Field(default=None, max_length=128)
    all_sources: bool | None = None

    @field_validator("ip", "user", "host", "rule", "contains", "time_from", "time_to", "source_id", mode="before")
    @classmethod
    def _blank(cls, value: Any) -> Any:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        return none_if_blank(value)

    @field_validator("severity_gte", "all_sources", mode="before")
    @classmethod
    def _blank_scalar(cls, value: Any) -> Any:
        return none_if_blank(value)

    def filters(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in _FILTER_KEYS if getattr(self, k) is not None}


class SearchLogsInput(_LogFilters):
    ids: list[str] = Field(default_factory=list, max_length=50)
    size: int = Field(default=50, ge=1, le=200)

    @field_validator("ids", mode="before")
    @classmethod
    def _ids(cls, value: Any) -> Any:
        if value in (None, ""):
            return []
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            return [str(v)[:256] for v in value if isinstance(v, (str, int)) and str(v).strip()]
        return value


class LogStatsInput(_LogFilters):
    group_by: list[GroupField] = Field(default_factory=lambda: ["rule"], max_length=3)
    top_n: int = Field(default=10, ge=1, le=20)
    interval: Literal["auto", "5m", "15m", "1h", "6h", "1d"] = "auto"
    include_heatmap: bool = False

    @field_validator("group_by", mode="before")
    @classmethod
    def _group_by(cls, value: Any) -> Any:
        if value in (None, "", []):
            return ["rule"]
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            aliases = {"source_ip": "ip", "src_ip": "ip", "source.ip": "ip", "user.name": "user",
                       "host.name": "host", "rule_id": "rule", "event.action": "action"}
            out: list[str] = []
            for item in value:
                key = aliases.get(str(item).strip().lower(), str(item).strip().lower())
                if key not in out:
                    out.append(key)
            return out
        return value


# --------------------------------------------------------------------------- #
# Source planning.
# --------------------------------------------------------------------------- #
@dataclass
class _Plan:
    mode: Literal["single", "fanout"]
    name: str
    source_id: str | None = None
    connector: Any = None
    targets: list[BrowseTarget] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    close: Any = None


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def browse_targets(ctx: ChatToolContext) -> list[BrowseTarget]:
    """``ctx.browse_sources()`` (sync or async), ``[]`` when absent or failing."""
    if ctx.browse_sources is None:
        return []
    try:
        targets = await _maybe_await(ctx.browse_sources())
    except Exception as exc:  # noqa: BLE001 — no browse targets is a valid answer
        logger.warning("chat browse targets unavailable: %s", exc)
        return []
    return [t for t in (targets or []) if isinstance(t, BrowseTarget)]


async def resolve_source(ctx: ChatToolContext, source_id: str) -> tuple[Any, str | None, Any] | None:
    """Resolve one source id through ``ctx.source_resolver``.

    Accepted resolver results (sync or awaitable): a connector; ``(connector,
    name)``; or the chat route's ``(connector, owned_client, id, name)`` tuple, in
    which case the owned client is closed after use. Returns ``(connector, name,
    closer)`` or ``None`` (unknown, disabled, or the resolver raised)."""
    resolver = ctx.source_resolver
    if resolver is None:
        return None
    try:
        result = await _maybe_await(resolver(source_id))
    except Exception as exc:  # noqa: BLE001 — an unusable source is "unavailable"
        logger.info("chat source %s unavailable: %s", source_id, exc)
        return None
    closer = None
    name: str | None = None
    conn = result
    if isinstance(result, tuple):
        if len(result) == 4:
            conn, owned, _sid, name = result
            closer = getattr(owned, "close", None) if owned is not None else None
        elif len(result) == 2:
            conn, name = result
        else:
            return None
    if conn is None or not hasattr(conn, "search"):
        return None
    return conn, (str(name) if name else None), closer


def connector_name(conn: Any, fallback: str | None = None) -> str:
    """A display name: the connector's configured name, the caller's fallback, its
    connector id — unless that is only the default (the source type), which says
    nothing to an analyst — else "Primary source"."""
    config = getattr(conn, "config", None)
    if isinstance(config, dict) and config.get("display_name"):
        return str(config["display_name"])
    if fallback:
        return str(fallback)
    cid = str(getattr(conn, "connector_id", "") or "")
    source_type = getattr(getattr(conn, "source_type", None), "value", None)
    return cid if cid and cid != source_type else "Primary source"


def _primary_name(ctx: ChatToolContext) -> str | None:
    try:
        primary = ctx.prefs.primary_source()
    except Exception:  # noqa: BLE001
        return None
    return (primary.display_name or primary.id) if primary is not None else None


async def plan_sources(
    ctx: ChatToolContext, source_id: str | None, all_sources: bool | None,
) -> _Plan | ToolOutcome:
    """Which source(s) this call reads (module docstring). Never widens a request
    selection; returns a failure outcome when nothing is readable."""
    targets = await browse_targets(ctx)
    names = {t.source_id: t.source_name for t in targets}
    if ctx.source_id:
        notes = []
        if source_id and source_id != ctx.source_id:
            notes.append("source fixed by the request; the requested source_id was not used")
        if all_sources:
            notes.append("source fixed by the request; all_sources was not used")
        if ctx.log_source is not None:
            return _Plan("single", connector_name(ctx.log_source, names.get(ctx.source_id) or ctx.source_id),
                         ctx.source_id, ctx.log_source, notes=notes)
        selected = [t for t in targets if t.source_id == ctx.source_id]
        if selected:
            return _Plan("fanout", selected[0].source_name, ctx.source_id, targets=selected, notes=notes)
        return ToolOutcome.failure("The selected log source is not available")
    if source_id:
        resolved = await resolve_source(ctx, source_id)
        if resolved is not None:
            conn, name, closer = resolved
            return _Plan("single", name or names.get(source_id) or connector_name(conn, source_id),
                         source_id, conn, close=closer)
        selected = [t for t in targets if t.source_id == source_id]
        if selected:
            return _Plan("fanout", selected[0].source_name, source_id, targets=selected)
        return ToolOutcome.failure("Unknown or unavailable log source")
    if targets and (all_sources is True or (all_sources is None and len(targets) > 1)):
        return _Plan("fanout", f"{len(targets)} sources", None, targets=targets)
    if ctx.log_source is not None:
        sid = getattr(ctx.log_source, "connector_id", None)
        fallback = names.get(sid or "") or _primary_name(ctx)
        return _Plan("single", connector_name(ctx.log_source, fallback), None, ctx.log_source)
    if targets:
        return _Plan("fanout", f"{len(targets)} sources", None, targets=targets)
    return ToolOutcome.failure("No log source is configured")


async def _close(plan: _Plan) -> None:
    if plan.close is not None:
        try:
            await _maybe_await(plan.close())
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- #
# Row projections (the nine identity keys; never ``_raw`` / ``raw_data``).
# --------------------------------------------------------------------------- #
def _action_of(source: Any) -> str | None:
    if not isinstance(source, dict):
        return None
    value = dotted_get(source, "event.action")
    if value in (None, ""):
        value = source.get("action")
    return text(value, 120) or None if value not in (None, "") else None


def event_row(event: Any, source_name: str) -> dict[str, Any]:
    """A ``RawEvent`` as the identity row (model samples + table)."""
    return {
        "ts": millis_to_iso(getattr(event, "timestamp_millis", 0)),
        "source": text(source_name, 120),
        "ip": text(event.ip, 128) or None if event.ip else None,
        "user": text(event.user, 160) or None if event.user else None,
        "host": text(event.host, 160) or None if event.host else None,
        "rule": text(event.rule, 160) or None if event.rule else None,
        "rule_name": text(event.rule_name, 200) or None if event.rule_name else None,
        "severity": finite(event.severity),
        "action": _action_of(getattr(event, "source", None)),
    }


def browse_row(row: dict[str, Any]) -> dict[str, Any]:
    """A ``log_rows.log_row`` (+ provenance) as the identity row. ``_raw`` is read
    for ``event.action`` only and never copied."""
    raw = row.get("_raw")
    return {
        "ts": row.get("ts") or None,
        "source": text(row.get("source_name") or row.get("source_id") or "", 120),
        "ip": text(row.get("source_ip"), 128) or None if row.get("source_ip") else None,
        "user": text(row.get("user"), 160) or None if row.get("user") else None,
        "host": text(row.get("host"), 160) or None if row.get("host") else None,
        "rule": text(row.get("rule"), 160) or None if row.get("rule") else None,
        "rule_name": None,
        "severity": finite(row.get("severity")),
        "action": _action_of(raw),
        "_message": str(row.get("message") or "")[:2000],
    }


def _matches_buffer(row: dict[str, Any], args: _LogFilters, window: Window) -> bool:
    """Apply the filters a live-tail ring ignored (mode ``buffer``)."""
    ts = _parse_ts(row.get("ts"))
    if ts is not None and not (window.start <= ts <= window.end):
        return False
    for key in ("ip", "user", "host", "rule"):
        wanted = getattr(args, key)
        if wanted is not None and str(row.get(key) or "") != wanted:
            return False
    if args.severity_gte is not None and (finite(row.get("severity")) or 0.0) < args.severity_gte:
        return False
    if args.contains:
        needle = args.contains.lower()
        hay = " ".join(str(row.get(k) or "") for k in ("rule", "user", "host", "ip", "action", "_message"))
        if needle not in hay.lower():
            return False
    return True


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _public_row(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row.get(k) for k in _SAMPLE_KEYS}


def _cell(value: Any) -> Any:
    """A table cell for the analyst: log text with invisible characters written as
    visible escapes (two lookalike accounts never render as the same name)."""
    return visible_text(value, 300) if isinstance(value, str) else value


def _top(rows: list[dict[str, Any]], key: str, n: int = _TOP_FACETS) -> list[dict[str, Any]]:
    counter: Counter[str] = Counter(
        str(r.get(key)) for r in rows if r.get(key) not in (None, "")
    )
    ranked = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]
    return [{"value": value, "count": count} for value, count in ranked]


def _structured_query(args: _LogFilters, window: Window, *, size: int, ids: list[str] | None = None) -> StructuredQuery:
    return StructuredQuery(
        ip=args.ip, user=args.user, host=args.host, rule=args.rule,
        severity_gte=args.severity_gte, contains=args.contains, ids=list(ids or []),
        time_from=window.time_from, time_to=window.time_to, size=size, sort_desc=True,
    )


def _per_source_timeout(ctx: ChatToolContext) -> float:
    tool_timeout = float(getattr(getattr(ctx.prefs, "chat_agent", None), "tool_timeout_s", 15) or 15)
    # Leave the tool's own deadline a margin so a slow source degrades to a per-source
    # error instead of timing out the whole lookup.
    return clamp_per_source_timeout(min(_DEFAULT_SOURCE_TIMEOUT, max(0.5, tool_timeout - 2.0)))


def reported_total(result: Any) -> tuple[int, bool]:
    """``(total, exact)`` for a connector ``SearchResult``.

    The native response's ``hits.total.relation`` decides when present (``gte`` is a
    lower bound). Without it (an older backend, or a reader that passes on only the
    number) a total of exactly :data:`ES_TOTAL_CAP` is treated as a lower bound:
    "at least 10,000" is true either way, and the cap is never presented as a
    count."""
    total = int(getattr(result, "total", 0) or 0)
    raw = getattr(result, "raw", None)
    hits_total = (raw.get("hits") or {}).get("total") if isinstance(raw, dict) else None
    if isinstance(hits_total, dict) and hits_total.get("relation") in ("eq", "gte"):
        return total, hits_total.get("relation") == "eq"
    return total, total != ES_TOTAL_CAP


async def exact_total(ctx: ChatToolContext, conn: Any, args: _LogFilters, window: Window) -> int | None:
    """One ``size: 0`` count with ``track_total_hits`` through ``aggregate()`` (same
    filters as ``search``), or ``None`` when the connector cannot count."""
    aggregate = getattr(conn, "aggregate", None)
    if not callable(aggregate):
        return None
    try:
        agg = await aggregate(ctx.prefs, _structured_query(args, window, size=0), (), None, 1)
    except Exception as exc:  # noqa: BLE001 — the lower bound stands
        logger.info("exact count failed: %s", exc)
        return None
    total = getattr(agg, "total", None) if agg is not None else None
    return int(total) if isinstance(total, int) and not isinstance(total, bool) else None


async def _exact_source_total(
    ctx: ChatToolContext, source_id: str, args: _LogFilters, window: Window,
) -> int | None:
    """:func:`exact_total` for one fan-out source, resolved through the context."""
    if ctx.source_resolver is None:
        return None
    resolved = await resolve_source(ctx, source_id)
    if resolved is None:
        return None
    conn, _name, closer = resolved
    try:
        return await asyncio.wait_for(exact_total(ctx, conn, args, window), timeout=_per_source_timeout(ctx))
    except asyncio.TimeoutError:
        return None
    finally:
        if closer is not None:
            try:
                await _maybe_await(closer())
            except Exception:  # noqa: BLE001
                pass


def _query_language(language: str | None) -> str:
    lang = (language or "").lower()
    if lang in ("kuery", "kql"):
        return "kql"
    if lang in ("lucene", "esql", "sql", "dsl"):
        return lang
    return "dsl"


# --------------------------------------------------------------------------- #
# Interval + bucketing helpers.
# --------------------------------------------------------------------------- #
def auto_interval(window: Window) -> str:
    span_h = (window.end - window.start).total_seconds() / 3600
    if span_h <= 2:
        return "5m"
    if span_h <= 12:
        return "15m"
    if span_h <= 48:
        return "1h"
    if span_h <= 24 * 14:
        return "6h"
    return "1d"


def pick_interval(requested: str, window: Window) -> str:
    """The requested interval unless it would exceed the point limit."""
    if requested in INTERVAL_SECONDS:
        span = (window.end - window.start).total_seconds()
        if span / INTERVAL_SECONDS[requested] <= _MAX_SERIES_POINTS:
            return requested
    return auto_interval(window)


def bucket_start(ts: datetime, interval: str) -> datetime:
    step = INTERVAL_SECONDS[interval]
    epoch = int(ts.timestamp())
    return datetime.fromtimestamp(epoch - epoch % step, tz=timezone.utc)


def bucket_axis(window: Window, interval: str) -> list[str]:
    """Epoch-aligned bucket starts covering the window (zero-filled axis)."""
    step = timedelta(seconds=INTERVAL_SECONDS[interval])
    cursor = bucket_start(window.start, interval)
    out: list[str] = []
    while cursor <= window.end and len(out) < _MAX_SERIES_POINTS:
        out.append(cursor.isoformat())
        cursor += step
    return out


def _bucket_key(value: str, interval: str) -> str | None:
    ts = _parse_ts(value)
    return bucket_start(ts, interval).isoformat() if ts is not None else None


# --------------------------------------------------------------------------- #
# search_logs
# --------------------------------------------------------------------------- #
class SearchLogsTool(ChatTool):
    name: ClassVar[str] = "search_logs"
    label: ClassVar[str] = "Searched logs"
    scope: ClassVar[str] = "logs"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("sources", "read"),)
    data_source: ClassVar[str] = "Connected log sources"
    signature: ClassVar[str] = (
        "search_logs(ip?, user?, host?, rule?, severity_gte?, contains?, ids?, time_from?='now-24h', "
        "time_to?='now', source_id?, all_sources?, size?=50) -- find log events; returns the match "
        "count, top values and up to 5 sample rows (the full table is shown to the analyst)"
    )
    display_keys: ClassVar[tuple[str, ...]] = (
        "ip", "user", "host", "rule", "severity_gte", "contains", "time_from", "time_to",
        "source_id", "all_sources", "size",
    )

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(SearchLogsInput, inp)
        if error is not None:
            return error
        window = resolve_window(ctx, time_from=args.time_from, time_to=args.time_to)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        plan = await plan_sources(ctx, args.source_id, args.all_sources)
        if isinstance(plan, ToolOutcome):
            return plan
        try:
            if plan.mode == "single":
                return await self._single(ctx, args, window, plan)
            return await self._fanout(ctx, args, window, plan)
        finally:
            await _close(plan)

    async def _single(self, ctx: ChatToolContext, args: SearchLogsInput, window: Window, plan: _Plan) -> ToolOutcome:
        sq = _structured_query(args, window, size=args.size, ids=args.ids)
        try:
            result = await plan.connector.search(ctx.prefs, sq)
        except Exception as exc:  # noqa: BLE001 — engine template only (§5.2)
            logger.warning("search_logs failed on %s: %s", plan.name, exc)
            return ToolOutcome.failure("The log source did not answer the search")
        rows = [event_row(ev, plan.name) for ev in result.events]
        total, total_exact = reported_total(result)
        if not total_exact and not args.ids:
            counted = await exact_total(ctx, plan.connector, args, window)
            if counted is not None:
                total, total_exact = counted, True
        rendering = result.rendering
        status = [{
            "name": plan.name, "status": "ok", "mode": "search", "returned": len(rows),
            "total": total, "total_is_lower_bound": not total_exact, "truncated": total > len(rows),
        }]
        free_text = None
        if args.contains:
            free_text = {
                "contains": args.contains,
                "applied": not args.ids,
                "fields_searched": list(rendering.fields_searched) if rendering and not args.ids else [],
                "matching": "analysed term match (not a substring scan)" if not args.ids else "not applied",
            }
        return self._outcome(
            args, window, plan, rows, status, total=total, total_known=total_exact,
            query=rendering.query if rendering else None,
            language=rendering.language if rendering else None,
            free_text=free_text,
        )

    async def _fanout(self, ctx: ChatToolContext, args: SearchLogsInput, window: Window, plan: _Plan) -> ToolOutcome:
        totals: dict[str, int | None] = {}

        def wrap(target: BrowseTarget) -> BrowseTarget:
            async def read(sq: StructuredQuery) -> tuple[list[dict[str, Any]], int | None]:
                rows, total = await target.read(sq)
                if target.mode == "buffer":
                    # A live-tail ring ignores the query: filter its rows HERE, before
                    # the merge caps the result, so non-matching ring rows can never
                    # crowd matching rows of the other sources out of the page.
                    rows = [r for r in rows if _matches_buffer(browse_row(r), args, window)]
                totals[target.source_id] = total
                return rows, total
            return BrowseTarget(target.source_id, target.source_name, target.mode, read)

        sq = _structured_query(args, window, size=args.size, ids=args.ids)
        try:
            env = await fan_out(
                [wrap(t) for t in plan.targets], sq,
                per_source_timeout=_per_source_timeout(ctx), raw_errors=False,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("search_logs fan-out failed: %s", exc)
            return ToolOutcome.failure("The log sources did not answer the search")
        rows = [browse_row(raw_row) for raw_row in env.get("logs", [])]
        sources = list(env.get("sources", []))
        # A reader passes on only the number: a total at the 10,000 cap is a lower
        # bound unless one exact count can replace it (concurrently, each bounded by
        # the per-source timeout, so several capped sources cannot add up).
        capped = [
            s["source_id"] for s in sources
            if s.get("ok") and s.get("mode") == "search" and totals.get(s["source_id"]) == ES_TOTAL_CAP
        ]
        recounts = dict(zip(capped, await asyncio.gather(
            *(_exact_source_total(ctx, sid, args, window) for sid in capped)
        ))) if capped else {}
        status: list[dict[str, Any]] = []
        total_known = True
        total = 0
        for s in sources:
            src_total = totals.get(s["source_id"]) if s.get("ok") else None
            returned = int(s.get("count") or 0)
            src_exact = False
            if s.get("ok") and s.get("mode") == "search" and src_total is not None:
                src_total = int(src_total)
                src_exact = src_total != ES_TOTAL_CAP
                if recounts.get(s["source_id"]) is not None:
                    src_total, src_exact = int(recounts[s["source_id"]]), True
                total += max(src_total, returned)
            elif s.get("ok"):
                total += returned  # a live-tail ring has no total: its rows are a floor
            if s.get("ok") and not src_exact:
                total_known = False
            status.append({
                "name": s.get("source_name"),
                "status": "ok" if s.get("ok") else ("timeout" if s.get("error") == "timeout" else "error"),
                "mode": s.get("mode"),
                "returned": returned,
                "total": src_total if s.get("mode") == "search" else None,
                "total_is_lower_bound": bool(s.get("ok")) and not src_exact,
                "truncated": bool(s.get("truncated")),
            })
        notes = list(plan.notes)
        if any(s["mode"] == "buffer" for s in status):
            notes.append("live-tail sources hold only recent events; their rows were filtered here")
        plan.notes = notes
        for row in rows:
            row.pop("_message", None)
        return self._outcome(args, window, plan, rows, status, total=total, total_known=total_known)

    def _outcome(
        self,
        args: SearchLogsInput,
        window: Window,
        plan: _Plan,
        rows: list[dict[str, Any]],
        status: list[dict[str, Any]],
        *,
        total: int,
        total_known: bool,
        query: str | None = None,
        language: str | None = None,
        free_text: dict[str, Any] | None = None,
    ) -> ToolOutcome:
        for row in rows:
            row.pop("_message", None)
        answered = [s for s in status if s["status"] == "ok"]
        if status and not answered:
            return ToolOutcome.failure("No log source answered the search")
        returned = len(rows)
        # ``total`` is the exact match count when ``total_known``, else a lower bound
        # (the 10,000 cap, or the rows a ring returned); never below what was returned.
        total = max(int(total or 0), returned)
        complete = total_known and total == returned and not any(s["truncated"] for s in status)
        basis = "exact" if complete else "newest_n"
        coverage_parts = []
        if not complete:
            if total_known:
                coverage_parts.append(f"newest {fmt_int(returned)} of {fmt_int(total)}")
            elif total > returned:
                coverage_parts.append(f"newest {fmt_int(returned)} of at least {fmt_int(total)}")
            else:
                coverage_parts.append(f"newest {fmt_int(returned)} (total unknown)")
        if len(status) > 1 or (status and status[0]["status"] != "ok"):
            coverage_parts.append(f"{len(answered)} of {len(status)} sources answered")
        coverage = "; ".join(coverage_parts) or None
        timestamps = sorted(r["ts"] for r in rows if r.get("ts"))
        multi = plan.mode == "fanout" and len(status) > 1
        observation: dict[str, Any] = {
            "window": window.label,
            "window_clamped_to_request": window.clamped,
            "filters": args.filters() | ({"ids": len(args.ids)} if args.ids else {}),
            "total": total,
            "total_is_lower_bound": not total_known,
            "returned": returned,
            "basis": basis,
            "time_span": {"earliest": timestamps[0] if timestamps else None,
                          "latest": timestamps[-1] if timestamps else None},
            "top_values": {
                key: _top(rows, key) for key in ("rule", "user", "host", "ip")
            },
            "sample_rows": [_public_row(r) for r in rows[:_SAMPLE_ROWS]],
        }
        if multi or plan.mode == "fanout":
            observation["sources"] = [
                {k: s.get(k) for k in ("name", "status", "mode", "returned", "total", "total_is_lower_bound",
                                       "truncated")}
                for s in status
            ]
        else:
            observation["source"] = plan.name
        if free_text:
            observation["free_text"] = free_text
        if plan.notes:
            observation["notes"] = list(plan.notes)

        columns = [column("ts", "Time", "time")]
        if multi:
            columns.append(column("source", "Source", untrusted=True))
        columns += [
            column("ip", "Source IP", "entity", untrusted=True),
            column("user", "User", "entity", untrusted=True),
            column("host", "Host", "entity", untrusted=True),
            column("rule", "Rule", untrusted=True),
            column("severity", "Severity", "number", align="right"),
            column("action", "Action", untrusted=True),
        ]
        keys = [c["key"] for c in columns]
        artifacts = [Artifact(
            id="a1", kind="table", title="Matching events", title_trusted=True,
            data={"columns": columns, "rows": [[_cell(r.get(k)) for k in keys] for r in rows]},
            provenance="source", untrusted_labels=True, basis=basis,
            total=total if total_known else None, truncated=not complete, window=window.label,
        )]
        if query:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="query", title="Query", title_trusted=True,
                data={"language": _query_language(language), "query": text(query, 4000) or "*",
                      "source_name": text(plan.name, 120), "hits": total if total_known else None},
                provenance="source", untrusted_labels=True, window=window.label,
            ))
        if complete and returned >= 2:
            interval = auto_interval(window)
            axis = bucket_axis(window, interval)
            counts = Counter(_bucket_key(r["ts"], interval) for r in rows if r.get("ts"))
            if len(axis) >= 2:
                artifacts.append(Artifact(
                    id=f"a{len(artifacts) + 1}", kind="series", title="Events over time",
                    title_trusted=True,
                    data={"x": axis, "unit": "count", "bucket": interval,
                          "series": [{"key": "events", "label": "Events",
                                      "values": [counts.get(t, 0) for t in axis]}],
                          "last_in_progress": window.time_to == "now"},
                    provenance="source", basis="exact", total=total, window=window.label,
                ))

        if multi or plan.mode == "fanout":
            where = f"across {len(answered)} of {len(status)} sources"
        else:
            where = "in 1 source"
        count_text = fmt_int(total) if total_known else f"at least {fmt_int(total)}"
        summary = f"{count_text} events matched {where}"
        summary += f" ({window.label})"
        if not complete:
            summary += f"; showing the newest {fmt_int(returned)}"
        if window.clamped:
            summary += "; window limited to the selected range"
        untrusted = {k: str(v) for k, v in args.filters().items() if isinstance(v, (str, int, float))}
        return ToolOutcome(
            ok=True,
            summary=summary,
            untrusted_params=untrusted,
            observation=observation,
            artifacts=artifacts,
            query=query,
            rows=returned,
            basis=basis,
            coverage=coverage,
            sources=[str(s["name"]) for s in status if s.get("name")],
        )


# --------------------------------------------------------------------------- #
# log_stats
# --------------------------------------------------------------------------- #
@dataclass
class _SourceStats:
    name: str
    status: str = "ok"                   # ok | error | timeout
    mode: str = "search"
    exact: bool = False
    total: int | None = None
    # False when ``total`` is only a lower bound (the backend's 10,000 cap).
    total_exact: bool = True
    sampled: int = 0
    groups: dict[str, Counter] = field(default_factory=dict)
    other: dict[str, int] = field(default_factory=dict)
    distinct: dict[str, int] = field(default_factory=dict)
    over_time: Counter = field(default_factory=Counter)
    matrix: dict[str, Counter] = field(default_factory=dict)
    query: str | None = None


def _stats_from_aggregate(name: str, agg: Any, group_by: list[str]) -> _SourceStats:
    stats = _SourceStats(name=name, exact=True, total=int(agg.total or 0))
    for fld in group_by:
        stats.groups[fld] = Counter({b.key: int(b.count) for b in agg.groups.get(fld, [])})
        stats.other[fld] = int(agg.other.get(fld, 0) or 0)
        if fld in agg.distinct:
            stats.distinct[fld] = int(agg.distinct[fld])
    stats.over_time = Counter({b.key: int(b.count) for b in agg.over_time})
    if agg.matrix:
        stats.matrix = {k: Counter({b.key: int(b.count) for b in v}) for k, v in agg.matrix.items()}
    stats.query = agg.rendering.query if agg.rendering else None
    return stats


def _stats_from_rows(
    name: str, rows: list[dict[str, Any]], total: int | None, group_by: list[str], interval: str,
    *, mode: str = "search", top_n: int, total_exact: bool = True,
) -> _SourceStats:
    # A sample that holds every matching event (the source's exact match total) IS
    # the population, so its counts are exact.
    complete = total is not None and total_exact and len(rows) >= total
    stats = _SourceStats(name=name, mode=mode, exact=complete, total=total, total_exact=total_exact,
                         sampled=len(rows))
    first = group_by[0] if group_by else None
    for fld in group_by:
        counter: Counter[str] = Counter(
            str(r.get(fld)) for r in rows if r.get(fld) not in (None, "")
        )
        ranked = dict(sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:top_n])
        stats.groups[fld] = Counter(ranked)
        stats.other[fld] = max(0, sum(counter.values()) - sum(ranked.values()))
        stats.distinct[fld] = len(counter)
    for r in rows:
        key = _bucket_key(r.get("ts") or "", interval)
        if key is None:
            continue
        stats.over_time[key] += 1
        if first and r.get(first) not in (None, ""):
            stats.matrix.setdefault(str(r.get(first)), Counter())[key] += 1
    return stats


class LogStatsTool(ChatTool):
    name: ClassVar[str] = "log_stats"
    label: ClassVar[str] = "Counted log events"
    scope: ClassVar[str] = "logs"
    requires: ClassVar[tuple[tuple[str, str], ...]] = (("sources", "read"),)
    data_source: ClassVar[str] = "Connected log sources"
    signature: ClassVar[str] = (
        "log_stats(group_by?=[rule] (ip|user|host|rule|rule_name|severity|action, up to 3), top_n?=10, "
        "interval?=auto, ip?, user?, host?, rule?, severity_gte?, contains?, time_from?, time_to?, "
        "source_id?, all_sources?, include_heatmap?) -- counts, top values and events over time; exact "
        "where the source can count, else the newest 200 per source (basis says which)"
    )
    display_keys: ClassVar[tuple[str, ...]] = (
        "group_by", "top_n", "interval", "ip", "user", "host", "rule", "severity_gte",
        "contains", "time_from", "time_to", "source_id", "all_sources",
    )

    def display_params(self, inp: dict[str, Any]) -> dict[str, Any]:
        params = dict(inp) if isinstance(inp, dict) else {}
        group_by = params.get("group_by")
        if isinstance(group_by, list):
            params["group_by"] = ",".join(str(g) for g in group_by[:3])
        return super().display_params(params)

    async def run(self, ctx: ChatToolContext, **inp: Any) -> ToolOutcome:
        args, error = parse_input(LogStatsInput, inp)
        if error is not None:
            return error
        window = resolve_window(ctx, time_from=args.time_from, time_to=args.time_to)
        if isinstance(window, str):
            return ToolOutcome.failure(window)
        plan = await plan_sources(ctx, args.source_id, args.all_sources)
        if isinstance(plan, ToolOutcome):
            return plan
        interval = pick_interval(args.interval, window)
        group_by = list(args.group_by)
        try:
            if plan.mode == "single":
                per_source = [await self._single(ctx, args, window, plan, group_by, interval)]
            else:
                per_source = await self._fanout(ctx, args, window, plan, group_by, interval)
        finally:
            await _close(plan)
        return self._outcome(args, window, plan, per_source, group_by, interval)

    async def _single(
        self, ctx: ChatToolContext, args: LogStatsInput, window: Window, plan: _Plan,
        group_by: list[str], interval: str,
    ) -> _SourceStats:
        return await self._read_connector(ctx, plan.connector, plan.name, args, window, group_by, interval)

    async def _read_connector(
        self, ctx: ChatToolContext, conn: Any, name: str, args: LogStatsInput, window: Window,
        group_by: list[str], interval: str,
    ) -> _SourceStats:
        aggregate = getattr(conn, "aggregate", None)
        if callable(aggregate):
            try:
                agg = await aggregate(
                    ctx.prefs, _structured_query(args, window, size=0), group_by, interval, args.top_n,
                )
            except Exception as exc:  # noqa: BLE001 — degrade to the sample path
                logger.info("aggregate on %s failed: %s", name, exc)
                agg = None
            if agg is not None:
                return _stats_from_aggregate(name, agg, group_by)
        try:
            result = await conn.search(ctx.prefs, _structured_query(args, window, size=_STATS_SAMPLE))
        except Exception as exc:  # noqa: BLE001 — engine template only
            logger.warning("log_stats sample search failed on %s: %s", name, exc)
            return _SourceStats(name=name, status="error")
        rows = [event_row(ev, name) for ev in result.events]
        total, total_exact = reported_total(result)
        stats = _stats_from_rows(name, rows, total, group_by, interval, top_n=args.top_n, total_exact=total_exact)
        stats.query = result.rendering.query if result.rendering else None
        return stats

    async def _fanout(
        self, ctx: ChatToolContext, args: LogStatsInput, window: Window, plan: _Plan,
        group_by: list[str], interval: str,
    ) -> list[_SourceStats]:
        timeout = _per_source_timeout(ctx)

        async def one(target: BrowseTarget) -> _SourceStats:
            if target.mode == "search" and ctx.source_resolver is not None:
                resolved = await resolve_source(ctx, target.source_id)
                if resolved is not None:
                    conn, _name, closer = resolved
                    agg = None
                    try:
                        if callable(getattr(conn, "aggregate", None)):
                            agg = await conn.aggregate(
                                ctx.prefs, _structured_query(args, window, size=0), group_by,
                                interval, args.top_n,
                            )
                    except Exception:  # noqa: BLE001 — degrade to the sample read
                        agg = None
                    finally:
                        if closer is not None:
                            try:
                                await _maybe_await(closer())
                            except Exception:  # noqa: BLE001
                                pass
                    if agg is not None:
                        return _stats_from_aggregate(target.source_name, agg, group_by)
            raw_rows, total = await target.read(_structured_query(args, window, size=_STATS_SAMPLE))
            rows = [browse_row(r) for r in raw_rows]
            if target.mode == "buffer":
                rows = [r for r in rows if _matches_buffer(r, args, window)]
                total = None
            return _stats_from_rows(
                target.source_name, rows, total, group_by, interval, mode=target.mode, top_n=args.top_n,
                total_exact=total is None or int(total) != ES_TOTAL_CAP,
            )

        async def guarded(target: BrowseTarget) -> _SourceStats:
            try:
                return await asyncio.wait_for(one(target), timeout=timeout)
            except asyncio.TimeoutError:
                return _SourceStats(name=target.source_name, status="timeout", mode=target.mode)
            except Exception as exc:  # noqa: BLE001 — partial success (#11)
                logger.warning("log_stats read failed for %s: %s", target.source_id, exc)
                return _SourceStats(name=target.source_name, status="error", mode=target.mode)

        return list(await asyncio.gather(*(guarded(t) for t in plan.targets)))

    def _outcome(
        self, args: LogStatsInput, window: Window, plan: _Plan, per_source: list[_SourceStats],
        group_by: list[str], interval: str,
    ) -> ToolOutcome:
        answered = [s for s in per_source if s.status == "ok"]
        if not answered:
            return ToolOutcome.failure("No log source answered the count")
        all_exact = all(s.exact for s in answered)
        total_known = all(s.total is not None and s.total_exact for s in answered)
        # Exact when ``total_known``; otherwise a lower bound (a capped total, or the
        # rows a live-tail ring held).
        total = sum(max(int(s.total), s.sampled) if s.total is not None else s.sampled for s in answered)
        merged_remainder = len(answered) > 1 and any(
            any(v > 0 for v in s.other.values()) for s in answered
        )
        # Totals, the series and the KPIs stay exact when every source counted
        # exactly; only top values merged from per-source top-N lists are partial,
        # and those artifacts say so themselves (``basis: sample``, truncated).
        basis = "exact" if all_exact else "newest_n"
        coverage_parts: list[str] = []
        sampled = [s for s in answered if not s.exact]
        if sampled:
            if all(s.total is not None and s.total_exact for s in sampled):
                of = fmt_int(sum(int(s.total or 0) for s in sampled))
            elif all(s.total is not None for s in sampled):
                of = f"at least {fmt_int(sum(int(s.total or 0) for s in sampled))}"
            else:
                of = "an unknown total"
            coverage_parts.append(f"newest {fmt_int(sum(s.sampled for s in sampled))} sampled of {of}")
        if all_exact and merged_remainder:
            coverage_parts.append("per-source top values merged; counts are lower bounds")
        if len(per_source) > 1 or per_source[0].status != "ok":
            coverage_parts.append(f"{len(answered)} of {len(per_source)} sources answered")
        if any(s.mode == "buffer" for s in answered):
            coverage_parts.append("live-tail sources hold only recent events")
        coverage = "; ".join(coverage_parts) or None

        groups: dict[str, Counter] = {f: Counter() for f in group_by}
        other: dict[str, int] = {f: 0 for f in group_by}
        distinct: dict[str, int] = {}
        over_time: Counter = Counter()
        matrix: dict[str, Counter] = {}
        for s in answered:
            for f in group_by:
                groups[f].update(s.groups.get(f, Counter()))
                other[f] += int(s.other.get(f, 0))
            over_time.update(s.over_time)
            for k, v in s.matrix.items():
                matrix.setdefault(k, Counter()).update(v)
        single = len(answered) == 1
        for f in group_by:
            if single and f in answered[0].distinct:
                distinct[f] = answered[0].distinct[f]
        top: dict[str, list[tuple[str, int]]] = {}
        for f in group_by:
            ranked = sorted(groups[f].items(), key=lambda kv: (-kv[1], kv[0]))
            kept = ranked[: args.top_n]
            other[f] += sum(v for _k, v in ranked[args.top_n:])
            top[f] = kept

        axis = bucket_axis(window, interval)
        series_values = [int(over_time.get(t, 0)) for t in axis]
        observation: dict[str, Any] = {
            "window": window.label,
            "window_clamped_to_request": window.clamped,
            "filters": args.filters(),
            "group_by": group_by,
            "basis": basis,
            "total": total,
            "total_is_lower_bound": not total_known,
            "top_values_are_lower_bounds": merged_remainder or not all_exact,
            # Raw values (bounded, invisible characters kept for the fence to escape):
            # a lookalike value is its own bucket, never merged into the real one.
            "top": {f: [{"value": text(k, 200), "count": v} for k, v in top[f]] for f in group_by},
            "other": other,
            "over_time": {"interval": interval, "start": axis[0] if axis else None, "counts": series_values},
        }
        if distinct:
            observation["distinct_approx"] = distinct
        if plan.mode == "fanout":
            observation["sources"] = [
                {"name": s.name, "status": s.status, "mode": s.mode,
                 "basis": "exact" if s.exact else ("newest_n" if s.status == "ok" else None),
                 "total": s.total, "total_is_lower_bound": s.total is not None and not s.total_exact,
                 "sampled": s.sampled if not s.exact else None}
                for s in per_source
            ]
        else:
            observation["source"] = plan.name
        if plan.notes:
            observation["notes"] = list(plan.notes)

        artifacts: list[Artifact] = []
        for f in group_by:
            pairs = top[f]
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="categories", title=GROUP_TITLES[f], title_trusted=True,
                data={"labels": [visible_text(k, 200) or "—" for k, _v in pairs], "values": [v for _k, v in pairs],
                      "unit": "count", "dimension": f, "other": other[f]},
                provenance="source", untrusted_labels=True,
                basis="sample" if (all_exact and merged_remainder) else basis,
                total=total if total_known else None, truncated=other[f] > 0 or merged_remainder,
                window=window.label,
            ))
        if len(axis) >= 2:
            artifacts.append(Artifact(
                id=f"a{len(artifacts) + 1}", kind="series", title="Events over time", title_trusted=True,
                data={"x": axis, "unit": "count", "bucket": interval,
                      "series": [{"key": "events", "label": "Events", "values": series_values}],
                      "last_in_progress": window.time_to == "now"},
                provenance="source", basis=basis, total=total if total_known else None,
                truncated=not all_exact, window=window.label,
            ))
        # The match total is exact whenever every answering source reported one (a
        # sampled source still reports its exact match count); otherwise it is the
        # counted events, a lower bound (G4).
        items = [kpi("events", "Matching events", total, context=window.label, bound=not total_known)]
        for f in group_by[:3]:
            if f in distinct:
                items.append(kpi(f"distinct_{f}", DISTINCT_LABELS[f], distinct[f], context="approximate"))
        if plan.mode == "fanout":
            items.append(kpi("sources_answered", "Sources answered", len(answered), context=f"of {len(per_source)}"))
        artifacts.append(Artifact(
            id=f"a{len(artifacts) + 1}", kind="kpis", title="Key figures", title_trusted=True,
            data={"items": items[:6]}, provenance="source", basis=basis,
            total=total if total_known else None, window=window.label,
        ))
        if args.include_heatmap and group_by and matrix and 2 <= len(axis) <= _MAX_HEATMAP_X:
            first = group_by[0]
            ys = [k for k, _v in top[first][:_MAX_HEATMAP_Y] if k in matrix]
            if ys:
                artifacts.append(Artifact(
                    id=f"a{len(artifacts) + 1}", kind="heatmap", title="Top values over time",
                    title_trusted=True,
                    data={"x": axis, "y": [visible_text(y, 200) for y in ys], "unit": "count",
                          "cells": [[int(matrix[y].get(t, 0)) for t in axis] for y in ys],
                          "x_label": "Time", "y_label": first},
                    provenance="source", untrusted_labels=True, basis=basis, window=window.label,
                ))

        count_text = fmt_int(total) if total_known else f"at least {fmt_int(total)}"
        where = (f"across {len(answered)} of {len(per_source)} sources" if plan.mode == "fanout"
                 else "in 1 source")
        summary = f"{count_text} events {where} ({window.label}); "
        if basis != "exact":
            summary += "top values from the newest events"
        elif merged_remainder:
            summary += "exact counts; merged top values are lower bounds"
        else:
            summary += "exact counts"
        summary += f", grouped by {', '.join(group_by)}" if group_by else ""
        if window.clamped:
            summary += "; window limited to the selected range"
        queries = [s.query for s in answered if s.query]
        return ToolOutcome(
            ok=True,
            summary=summary,
            untrusted_params={k: str(v) for k, v in args.filters().items()},
            observation=observation,
            artifacts=artifacts,
            query=queries[0] if len(queries) == 1 else None,
            rows=total if total_known else None,
            basis=basis,
            coverage=coverage,
            sources=[s.name for s in per_source],
        )


__all__ = [
    "GROUP_FIELDS",
    "LogStatsInput",
    "LogStatsTool",
    "SearchLogsInput",
    "SearchLogsTool",
    "browse_row",
    "browse_targets",
    "event_row",
    "plan_sources",
    "resolve_source",
]
