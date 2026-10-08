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
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

from ..connectors.base import StructuredQuery
from ..constants import SourceType

__all__ = [
    "BrowseReader",
    "BrowseTarget",
    "browse_query",
    "browse_truncated",
    "clamp_browse_limit",
    "clamp_per_source_timeout",
    "demo_browse_targets",
    "demo_reader",
    "fan_out",
    "log_message",
    "log_row",
    "pull_reader",
    "push_reader",
    "source_can_browse",
    "tenant_browse_targets",
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
    volatile live-tail ring (``"buffer"``, which IGNORES from/to/query) vs a real
    backing search (``"search"``) even when the read fails."""

    source_id: str
    source_name: str
    mode: Literal["search", "buffer"]
    read: BrowseReader


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
            targets.append(BrowseTarget(
                src.id, name, "buffer", push_reader(src, ingest_service=ingest_service),
            ))
        elif registry.is_pull(src.source_type):
            targets.append(BrowseTarget(
                src.id, name, "search",
                pull_reader(src, prefs=prefs, es_client_for_source=es_client_for_source),
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
        targets.append(BrowseTarget(
            sid, row.get("display_name") or sid, "search",
            demo_reader(sid, prefs=prefs, demo_source_connector=demo_source_connector),
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
    :func:`_source_error`): leave it True for the route, pass False from chat."""
    targets = list(targets)
    limit = clamp_browse_limit(sq.size)
    if sq.size != limit:
        sq = sq.model_copy(update={"size": limit})

    async def _guarded(target: BrowseTarget):
        return await asyncio.wait_for(
            target.read(sq.model_copy(deep=True)), timeout=per_source_timeout
        )

    results = await asyncio.gather(
        *[_guarded(target) for target in targets], return_exceptions=True
    )

    merged: list[dict[str, Any]] = []
    source_status: list[dict[str, Any]] = []
    any_source_truncated = False
    for target, outcome in zip(targets, results):
        if isinstance(outcome, Exception):
            source_status.append({
                "source_id": target.source_id, "source_name": target.source_name,
                "ok": False,
                "error": _source_error(target, outcome, raw_errors=raw_errors),
                "count": 0,
                "mode": target.mode,
                # A read that failed returned nothing; it cut nothing either. The
                # honest signal for "you are missing rows here" is `ok: False`.
                "truncated": False,
            })
            continue
        rows, total = outcome if isinstance(outcome, tuple) else (outcome or [], None)
        for row in rows:
            # MANDATORY provenance — overwrite (never trust a per-source row to self-label).
            row["source_id"] = target.source_id
            row["source_name"] = target.source_name
        merged.extend(rows)
        # The SAME rule the per-source sibling route applies to this identical read.
        src_truncated = browse_truncated(len(rows), limit, total)
        any_source_truncated = any_source_truncated or src_truncated
        source_status.append({
            "source_id": target.source_id, "source_name": target.source_name,
            "ok": True, "count": len(rows),
            # "search" = a real backing query (from/to/query applied); "buffer" = a
            # volatile process-local live-tail ring that IGNORES from/to/query.
            "mode": target.mode,
            # This source's own rows were demonstrably cut (its page saturated, or its
            # connector reported more matches than it returned).
            "truncated": src_truncated,
        })

    # Merge newest-first by ts (ISO strings sort lexicographically for UTC; empty ts
    # sorts last). Then hard-cap the merged view.
    merged.sort(key=lambda r: (r.get("ts") or ""), reverse=True)
    gathered = len(merged)
    merged = merged[:limit]
    return {
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
