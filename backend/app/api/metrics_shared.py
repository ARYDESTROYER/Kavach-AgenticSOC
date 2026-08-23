"""Shared short-TTL case-page cache for the read-only dashboard rollups.

The Overview dashboard fans out to several read-only endpoints per refresh
(posture, noise-reduction, auto-close-health, diagnostics/health, MITRE coverage,
agent-improvement, /api/metrics) and — under the Console's LIVE cadence — repeats
that fan-out every ~5 seconds. Before this module each of those endpoints
independently fetched the SAME newest-N page of full Case documents from the
state store (up to 5000 docs, Pydantic-validated per hit), multiplying one heavy
scan by the number of endpoints and again by the poll cadence.

This helper memoizes that ``(cases, total)`` page for a short TTL matching the
LIVE poll cadence, so one dashboard refresh performs ONE store scan and the
other endpoints (and the next few polls) serve the same page.

Design constraints (all load-bearing):

* **Keyed by fetch limit, guarded by store identity.** Entries are stored per
  ``limit`` and served only when the caller's store object IS (``is``) the one
  the page was fetched from. Demo Mode swaps ``state.cases`` to an isolated
  store while active (and back on disable), so the identity guard makes the
  cache self-invalidating across that swap — demo and real pages can never
  bleed into each other. The entry holds a strong reference to its store, so a
  recycled ``id()`` can never alias two different stores.
* **The limit is part of the key.** Tests (and operators) monkeypatch the
  routes' ``_STORE_FETCH_LIMIT`` seams; a page fetched under one limit is never
  served for another, so the truncated/store_total/fetched honesty contract
  stays exact.
* **Single-flight.** Concurrent misses for the same (store, limit) — the
  dashboard's parallel fan-out — share ONE in-flight fetch instead of racing
  duplicate scans. Waiter cancellation cannot poison the shared future
  (``asyncio.shield``), and a failed fetch is propagated to every waiter and
  NEVER cached.
* **Callers get their own list.** Every hit returns a fresh shallow copy of the
  page, so a caller re-binding/slicing its list cannot affect other endpoints.
  ``Case`` objects themselves are shared and must be treated as read-only
  (every consumer on this path is a pure aggregation).
* **Bounded staleness, read-only path.** The TTL (default 5s) is the explicit
  staleness bound for dashboard aggregates only; nothing on this path feeds
  ``decide()``/risk/signatures (#3) — it is read-time reporting.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger("tlsoc.api.metrics_shared")

# How long a fetched page may be served before it must be re-fetched. Matches the
# Console's LIVE auto-refresh cadence (5s), so the dashboard's own poll defines the
# maximum staleness a tile can observe. Module-level so tests can monkeypatch it.
CASE_PAGE_TTL_SECONDS = 5.0


class _CacheEntry:
    """One memoized (cases, total) page. Holds a STRONG reference to the store it
    was fetched from so the ``is`` identity guard can never alias a recycled id."""

    __slots__ = ("store", "expires_at", "cases", "total")

    def __init__(self, store: Any, expires_at: float, cases: list, total: int) -> None:
        self.store = store
        self.expires_at = expires_at
        self.cases = cases
        self.total = total


# One entry per fetch limit (there are only a handful of distinct limits in the
# codebase — 5000 for the rollups, 2000 for /api/metrics — so this stays tiny).
_page_cache: dict[int, _CacheEntry] = {}
# One in-flight fetch per limit: (store, future). The future is loop-bound and
# lives only for the duration of the producing request; waiters verify both the
# store identity AND the running loop before sharing it.
_inflight: dict[int, tuple[Any, "asyncio.Future[tuple[list, int]]"]] = {}


def invalidate_case_page_cache() -> None:
    """Drop every memoized page + in-flight marker (test isolation / hard reset)."""
    _page_cache.clear()
    _inflight.clear()


async def fetch_case_page(store: Any, limit: int) -> tuple[list, int]:
    """Return ``(cases, total)`` from ``store.list(limit=limit)`` via the shared
    short-TTL cache.

    The returned list is a fresh shallow copy per call. Errors from the store
    propagate to the caller (each route keeps its own degrade-to-empty handling)
    and are never cached.
    """
    limit = int(limit)
    now = time.monotonic()

    entry = _page_cache.get(limit)
    if entry is not None and entry.store is store and now < entry.expires_at:
        return list(entry.cases), entry.total

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — callers are always async routes
        loop = None

    pending = _inflight.get(limit)
    if (
        loop is not None
        and pending is not None
        and pending[0] is store
        and not pending[1].done()
        and pending[1].get_loop() is loop
    ):
        # Share the in-flight fetch. shield() so OUR cancellation cannot cancel
        # the shared future under the other waiters / the producer.
        cases, total = await asyncio.shield(pending[1])
        return list(cases), total

    fut: "asyncio.Future[tuple[list, int]] | None" = (
        loop.create_future() if loop is not None else None
    )
    if fut is not None:
        _inflight[limit] = (store, fut)
    try:
        cases, total = await store.list(limit=limit)
        cases = list(cases)
        total = int(total)
    except BaseException as exc:
        if fut is not None and not fut.done():
            fut.set_exception(exc)
            # Mark retrieved so an un-awaited shared future never logs a spurious
            # "exception was never retrieved" warning (waiters still receive it).
            fut.exception()
        raise
    else:
        if fut is not None and not fut.done():
            fut.set_result((cases, total))
        _page_cache[limit] = _CacheEntry(
            store, time.monotonic() + float(CASE_PAGE_TTL_SECONDS), cases, total
        )
        return list(cases), total
    finally:
        current = _inflight.get(limit)
        if fut is not None and current is not None and current[1] is fut:
            del _inflight[limit]
