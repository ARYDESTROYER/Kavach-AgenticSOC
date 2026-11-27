"""Per-source health rows for the configured (tenant) sources.

Moved from ``api/routes.py`` (chat revamp SPEC §5.3, "route-private helpers move
first") so ``GET /api/sources/health``, ``GET /api/sources/coverage`` and the chat
``source_health`` tool build their rows from ONE function, and the coverage tile's
source-derived numbers from ONE pure :func:`coverage_rollup`. The bodies are unchanged;
the only difference is the seam: what the route helpers read from the ``AppState``
(prefs, poller, silence clock, ingest ring, cursor store) is now passed in explicitly.
``api.routes`` keeps thin ``(state)`` wrappers with the historical names, because tests
and route code use them.

Demo Mode is NOT handled here: the callers swap in ``state.demo_source_health_overlay()``
while a demo is active, exactly as before. All output is advisory (#3); connector error
strings are source-controlled plain text (#9) and no secret is ever read.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from ..connectors.registry import get_registry
from ..utils import to_millis
from .log_rows import source_can_browse

__all__ = [
    "coverage_rollup",
    "cursor_millis",
    "sources_health_rows",
    "wallclock_last_event_millis",
]


async def cursor_millis(cursor_store: Any, src) -> int:
    """Newest processed timestamp across a source's feeds (0 = never polled).

    Mirrors the poller's durable cursor key ``f'{source.id}:{feed.id}'`` (falling back
    to the legacy single-source cursor). Read-only; a store hiccup fails soft to 0 rather
    than breaking the whole health view."""
    best = 0
    try:
        feeds = src.feeds()
        keys: list[str] = []
        if feeds:
            keys = [f"{src.id}:{f.id}" for f in feeds]
        else:
            # Un-fed source: the primary uses the legacy 'primary' key; a non-primary
            # un-fed source uses a distinct 'f{id}:primary' key (see PollerManager).
            keys = ["primary" if src.is_primary else f"{src.id}:primary"]
        for key in keys:
            try:
                cur = await cursor_store.load_keyed(key)
            except Exception:  # noqa: BLE001
                continue
            best = max(best, int(getattr(cur, "timestamp_millis", 0) or 0))
    except Exception:  # noqa: BLE001 — health is best-effort, never raises
        return best
    return best


def wallclock_last_event_millis(last_event_map: dict, source_id: str) -> int:
    """Epoch-millis of the last WALL-CLOCK event arrival for a source (0 when never seen).

    Reads ``state._source_last_event`` (the silence clock ``state.silent_sources`` uses,
    updated on any tick with events) so ``last_event_millis`` / ``worst_last_event_seconds``
    agree with the ``silent`` flag. Fails soft to 0 — advisory only (#3)."""
    last_ev = (last_event_map or {}).get(source_id)
    if last_ev is None:
        return 0
    try:
        return int(to_millis(last_ev))
    except Exception:  # noqa: BLE001
        return 0


async def sources_health_rows(
    prefs: Any,
    *,
    poller: Any,
    silent_sources: Callable[[Any], Iterable[str]] | None,
    cursor_store: Any,
    ingest_service: Any = None,
    last_event_map: dict | None = None,
) -> list[dict[str, Any]]:
    """Build the per-source health rows for the REAL configured sources (the demo overlay
    is added by the ``/sources/health`` caller). Each row carries the legacy shape PLUS the
    additive coverage-observability fields (A5.2): ``last_poll_at``/``last_poll_ok``/
    ``last_poll_error`` (from the poller's in-memory last-tick snapshot), ``events_per_min``
    (smoothed rate; pull from the poller, push from the ingest ring), ``last_event_millis``
    (a wall-clock/event watermark for the coverage rollup), and ``silent`` (the v0 flat
    silent-source flag from ``state.silent_sources``). All advisory (#3); connector error
    strings are plain text (#9); NO secrets. Never raises — every lookup fails soft.

    Explicit inputs (formerly read from the ``AppState``): ``prefs`` (``state.prefs``,
    whose ``sources`` are reported and which is handed to ``silent_sources``), ``poller``
    (its ``last_tick_by_source()`` snapshot), ``silent_sources`` (the
    ``state.silent_sources`` callable), ``cursor_store`` (durable poll cursors),
    ``ingest_service`` (push live-tail ring) and ``last_event_map`` (the wall-clock
    silence clock, ``state._source_last_event``). A missing collaborator degrades the
    fields it feeds to their zero values, exactly as an ``AppState`` failure did."""
    reg = get_registry()
    try:
        snaps = poller.last_tick_by_source()
    except Exception:  # noqa: BLE001 — the snapshot is advisory; degrade to none
        snaps = {}
    try:
        silent_set = set(silent_sources(prefs))
    except Exception:  # noqa: BLE001
        silent_set = set()
    last_event_map = last_event_map or {}

    out: list[dict[str, Any]] = []
    for src in prefs.sources:
        is_receiver = reg.is_receiver(src.source_type)
        is_pull = (not is_receiver) and reg.is_pull(src.source_type)
        row: dict[str, Any] = {
            "source_id": src.id,
            "source_name": src.display_name or src.id,
            "source_type": src.source_type.value,
            "enabled": src.enabled,
            "is_primary": src.is_primary,
            "ingest_mode": src.ingest_mode.value,
            "kind": "push" if is_receiver else ("pull" if is_pull else "unknown"),
            "can_browse": source_can_browse(reg, src),
            "buffer_depth": 0,
            "last_poll_millis": 0,
            # --- Coverage observability (A5.2), additive + advisory ---
            "last_poll_at": None,
            "last_poll_ok": None,
            "last_poll_error": None,
            "last_event_millis": 0,
            "events_per_min": 0.0,
            "silent": bool(src.id in silent_set),
        }
        if is_receiver:
            if ingest_service is not None:
                row["buffer_depth"] = len(
                    ingest_service.recent_events_for_source(src.id, 500)
                )
                try:
                    row["events_per_min"] = float(
                        ingest_service.events_per_min_for_source(src.id) or 0.0
                    )
                except Exception:  # noqa: BLE001
                    row["events_per_min"] = 0.0
            # PUSH last-event is a wall-clock (the arrival clock the silence check uses).
            row["last_event_millis"] = wallclock_last_event_millis(last_event_map, src.id)
        elif is_pull and src.enabled:
            lp = await cursor_millis(cursor_store, src)
            row["last_poll_millis"] = lp
            # last_event = the more-recent of the cursor's event watermark and the
            # wall-clock silence clock (state._source_last_event), so it agrees with the
            # ``silent`` flag + drives ``worst_last_event_seconds`` even before the cursor
            # advances (e.g. a source that reported once then went quiet).
            row["last_event_millis"] = max(lp, wallclock_last_event_millis(last_event_map, src.id))
            snap = snaps.get(src.id)
            if isinstance(snap, dict):
                row["last_poll_at"] = snap.get("ts")
                row["last_poll_ok"] = snap.get("ok")
                # Plain text — a connector error is source-controlled data (#9).
                row["last_poll_error"] = snap.get("error")
                try:
                    row["events_per_min"] = float(snap.get("events_per_min", 0.0) or 0.0)
                except (TypeError, ValueError):
                    row["events_per_min"] = 0.0
        out.append(row)
    return out


def coverage_rollup(rows: Iterable[dict[str, Any]], now_ms: int) -> dict[str, Any]:
    """The source-derived part of ``GET /api/sources/coverage`` (moved from the route,
    chat revamp SPEC §5.3), so the route and the chat ``source_health`` tool report the
    same "am I seeing everything?" numbers.

    ``rows`` are :func:`sources_health_rows` rows (or the demo overlay rows, which have
    the same shape); ``now_ms`` is the caller's wall clock in epoch millis. Returns
    ``sources_total``, ``sources_enabled``, ``sources_silent``, ``events_per_min`` (the
    summed rate over ENABLED sources, 2 dp) and ``worst_last_event_seconds`` (the oldest
    last-event age among enabled sources that have ever reported; 0 when none has).
    ``alerts_triaged_24h`` and the demo flag stay with the route: they read the case
    store and the AppState, not the rows. Pure; advisory only (#3)."""
    rows = list(rows)
    enabled_rows = [r for r in rows if r.get("enabled")]
    sources_silent = sum(1 for r in enabled_rows if r.get("silent"))
    events_per_min = round(
        sum(float(r.get("events_per_min") or 0.0) for r in enabled_rows), 2
    )
    worst = 0
    for r in enabled_rows:
        lev = int(r.get("last_event_millis") or 0)
        if lev > 0:
            worst = max(worst, (now_ms - lev) // 1000)
    return {
        "sources_total": len(rows),
        "sources_enabled": len(enabled_rows),
        "sources_silent": int(sources_silent),
        "events_per_min": events_per_min,
        "worst_last_event_seconds": int(max(0, worst)),
    }
