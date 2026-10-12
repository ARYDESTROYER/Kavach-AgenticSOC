"""Shared short-TTL case reads for the read-only dashboard rollups.

Round 12: the rollups read :func:`fetch_case_population` — the cases their windows
reach, newest first and at most ``limit`` of them, with the window's EXACT size and
exact store-wide counts (see the section at the end of this module) — so a dashboard
number is exact whenever its window holds no more than ``limit`` cases, honestly
flagged as a lower bound (with the exact total) when it holds more, and never costs
more than ``limit`` rows to read. :func:`fetch_case_breakdown` gives the legacy
metrics view its exact store-wide headline counts (status, verdict, disposition) from
aggregates, never from that bounded population. :func:`fetch_case_page` (the newest-N
page below) is kept for its remaining callers; it is a bounded page, and they label it
as such.

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
import threading
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
    """Drop every memoized page AND population + ledger read + in-flight marker (test
    isolation / hard reset)."""
    _page_cache.clear()
    _inflight.clear()
    invalidate_case_population_cache()
    _ledger_memo.clear()


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


# =========================================================================== #
# Round 12: the EXACT case population behind the dashboard rollups.
# =========================================================================== #
# ``fetch_case_page`` above (kept for its remaining callers) reads the NEWEST N cases of
# the whole store, so on a store larger than N every corpus summary built on it was a
# lower bound. ``fetch_case_population`` reads the cases a rollup's window reaches, as
# the NEWEST-FIRST prefix of that window (the store's ``scan_page(newest_first=True)``:
# a PIT ``search_after`` on Elasticsearch, a descending keyset on SQL), and stops after
# ``limit`` rows — so a read never costs more than ``limit`` rows, whatever the store
# size. The scope count, the store-wide total and the open-now stock are exact COUNT
# push-downs (``engine.case_aggregate``), so a window holding more than ``limit`` cases
# is reported honestly as truncated, with its exact size.
#
# Bounded work and memory:
#
# * A requested span rounds UP to a small fixed ladder of cache keys, so arbitrary
#   ``window_hours`` values reuse a handful of entries.
# * A newest-first entry serves EVERY narrower request exactly (the newest N cases of a
#   narrower window are a prefix of the wider window's newest N), so the dashboard's
#   all-time read typically serves all of its tiles.
# * Loads are serialised per event loop and per kind — all-time loads on one lock,
#   bounded-window loads on another, so a cheap windowed tile never queues behind an
#   expensive all-time read — and the cache holds at most ``POPULATION_CACHE_BUDGET``
#   Case objects across all entries (oldest evicted first).
# * The per-row work of a read (window checks, ordering, ``Case`` validation of the
#   kept rows) runs in a worker thread one page at a time, so a 20,000-case read never
#   stalls the event loop that also streams chat answers, SSE heartbeats and ingest.
#   Only the rows that are kept are validated (raw documents are read); a document
#   that no longer validates is skipped and REPORTED (the population is then
#   incomplete), never allowed to take the rollups down.
# * A bounded window is ``[now - span, now)`` everywhere — the read, its narrowing and
#   its exact count share that upper bound, so a case stamped in the future (clock
#   skew) never uses up a read slot or makes an incomplete window look complete. All
#   time stays open-ended.
# * A read that fails partway is reported as incomplete (``fetched < scope_total``, the
#   error named) and is never cached.

POPULATION_TTL_SECONDS = CASE_PAGE_TTL_SECONDS
# The most Case objects the population cache retains across ALL its entries.
POPULATION_CACHE_BUDGET = 25_000
# A span longer than this (about a century) reaches before any case: it is all time.
MAX_SPAN_HOURS = 876_000
# Requested spans round UP to one of these cache keys (1d, 2d, 7d, 14d, 31d, 62d, 93d,
# 186d, 366d, 2y, 3y, 5y, 10y); anything longer is all time.
_SPAN_LADDER: tuple[int, ...] = (
    24, 48, 168, 336, 744, 1488, 2232, 4464, 8784, 17568, 26352, 43920, 87840,
)
_READ_PAGE = 1000


class CasePopulation:
    """The cases created in the last ``span_hours`` (all cases when ``span_hours`` is
    None), NEWEST FIRST, plus exact counts.

    * ``cases`` — the retained Case objects (shared; treat as read-only), the newest
      ``limit`` of the span at most.
    * ``in_scope`` — how many cases the span holds (exact when ``complete``; otherwise
      the exact store COUNT, or a lower bound when even that failed).
    * ``complete`` — every in-scope case is in ``cases`` (no read failure, no
      unreadable document, no retention ceiling hit).
    * ``newest_first`` — ``cases`` is the newest-first PREFIX of the span (every case
      newer than the oldest one kept was read), which is what lets a rollup prove a
      narrower window complete from a truncated read.
    * ``store_total`` / ``open_now`` — exact counts over the WHOLE store (every case /
      every active case), or ``None`` when they could not be counted.
    * ``load_ok`` — the store answered at all. ``False`` means nothing was measured.
    * ``error`` — why the population is incomplete ("" when complete).
    * ``read_error`` — the store failure that stopped the read partway, if any.

    ``fetched``/``scope_total`` feed the rollups' ``truncation_marker``: equal when the
    population is complete (``truncated: false``), ``fetched < scope_total`` whenever a
    retention ceiling, an unreadable document or a read failure cut it."""

    __slots__ = ("cases", "span_hours", "since", "in_scope", "complete", "load_ok",
                 "store_total", "open_now", "consistency", "error", "store", "limit",
                 "expires_at", "newest_first", "floor", "read_error", "unreadable",
                 "key", "read_at", "count_failed")

    def __init__(
        self,
        *,
        cases: list,
        span_hours: int | None,
        since: Any,
        in_scope: int,
        complete: bool,
        load_ok: bool,
        store_total: int | None,
        open_now: int | None,
        consistency: str,
        error: str,
        store: Any,
        limit: int,
        expires_at: float,
        newest_first: bool = True,
        floor: Any = None,
        read_error: str = "",
        unreadable: int = 0,
        key: int | None = None,
        read_at: Any = None,
        count_failed: bool = False,
    ) -> None:
        self.cases = cases
        self.span_hours = span_hours
        self.since = since
        self.in_scope = in_scope
        self.complete = complete
        self.load_ok = load_ok
        self.store_total = store_total
        self.open_now = open_now
        self.consistency = consistency
        self.error = error
        self.store = store
        self.limit = limit
        self.expires_at = expires_at
        self.newest_first = newest_first
        self.floor = floor
        self.read_error = read_error
        self.unreadable = unreadable
        self.key = key
        self.read_at = read_at
        self.count_failed = count_failed

    @property
    def fetched(self) -> int:
        return len(self.cases)

    @property
    def scope_total(self) -> int:
        """The rollups' ``store_total``: the span's case count. Never equal to
        ``fetched`` for an incomplete population (``fetched + 1`` is the honest lower
        bound when the exact count itself could not be read). ``0`` when nothing was
        measured (``load_ok`` False): an outage carries its own flags, not a count."""
        if not self.load_ok:
            return 0
        total = max(int(self.in_scope), len(self.cases))
        if not self.complete and total <= len(self.cases):
            total = len(self.cases) + 1
        return total

    @property
    def truncated(self) -> bool:
        return not self.complete

    def covers(self, since: Any) -> bool:
        """Can this population answer a request whose window starts at ``since`` (None
        = all time) EXACTLY as a fresh read would? True when its own window reaches at
        least that far back and it is complete, or newest-first (a narrower window's
        newest cases are a prefix of these)."""
        if not self.load_ok or self.read_error or self.unreadable:
            return False
        if self.since is not None and (since is None or self.since > since):
            return False
        return bool(self.complete or self.newest_first)

    def _copy(self, **changes: Any) -> "CasePopulation":
        fields = {name: getattr(self, name) for name in self.__slots__}
        fields.update(changes)
        return CasePopulation(**fields)

    def view(self, span_hours: int | None = None) -> "CasePopulation":
        """A per-caller copy with its own list (callers may re-bind or slice it freely;
        the Case objects are shared and read-only). With ``span_hours`` the cases are
        narrowed to that window; the completeness of a narrowed view is decided by
        :func:`fetch_case_population`, which owns the exact counts."""
        return self._copy(cases=list(self.cases), span_hours=span_hours)


_population_cache: dict[tuple[int, int | None], CasePopulation] = {}
_population_inflight: dict[tuple[int, int | None], tuple[Any, "asyncio.Future[CasePopulation]"]] = {}
# One load lock per (event loop, all-time?) pair: see the module notes above.
_load_locks: dict[tuple[Any, bool], asyncio.Lock] = {}


def invalidate_case_population_cache() -> None:
    """Drop every memoized population + in-flight marker (test isolation / reset)."""
    _population_cache.clear()
    _population_inflight.clear()
    _load_locks.clear()
    _breakdown_memo.clear()
    _breakdown_inflight.clear()


def _prune_expired(now: float) -> None:
    for key in [k for k, v in _population_cache.items() if v.expires_at <= now]:
        _population_cache.pop(key, None)


def _requested_span(span_hours: Any) -> int | None:
    """The span a caller asked for, in whole hours (``None`` = all time). Zero,
    negative, unreadable and absurdly long spans (beyond ``MAX_SPAN_HOURS``, which no
    case predates) are all time — never an overflow."""
    if span_hours is None or isinstance(span_hours, bool):
        return None
    try:
        hours = int(span_hours)
    except (TypeError, ValueError, OverflowError):
        return None
    if hours <= 0 or hours > MAX_SPAN_HOURS:
        return None
    return hours


def _ladder_key(span: int | None) -> int | None:
    if span is None:
        return None
    for rung in _SPAN_LADDER:
        if span <= rung:
            return rung
    return None


def _since_of(now_dt: Any, span: int | None) -> Any:
    from datetime import timedelta

    if span is None:
        return None
    try:
        return now_dt - timedelta(hours=span)
    except (OverflowError, ValueError):
        return None


def _loop_lock(all_time: bool) -> asyncio.Lock | None:
    """The load lock for this event loop and kind of read. All-time and bounded loads
    are serialised separately: a bounded read is small and must never wait for an
    all-time read of the whole retention ceiling to finish first."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — callers are always async routes
        return None
    key = (loop, bool(all_time))
    lock = _load_locks.get(key)
    if lock is None:
        # One lock per running loop (tests run many loops; a lock is loop-bound).
        for stale in [k for k in _load_locks
                      if getattr(k[0], "is_closed", lambda: False)()]:
            _load_locks.pop(stale, None)
        lock = asyncio.Lock()
        _load_locks[key] = lock
    return lock


def _covering_entry(store: Any, limit: int, since: Any, now: float) -> CasePopulation | None:
    best: CasePopulation | None = None
    for entry in _population_cache.values():
        if entry.store is not store or entry.limit != limit or entry.expires_at <= now:
            continue
        if not entry.covers(since):
            continue
        # Prefer the narrowest covering entry (fewest cases to filter).
        if best is None or len(entry.cases) < len(best.cases):
            best = entry
    return best


async def fetch_case_population(
    store: Any, *, span_hours: int | None, limit: int
) -> CasePopulation:
    """The :class:`CasePopulation` for ``span_hours`` (``None``/``0`` = all time).

    Served from the shared 5 s cache when a fresh population of the same store and
    limit covers the span (see :meth:`CasePopulation.covers`), narrowed exactly to the
    requested span. Otherwise ONE read (single-flight, serialised per event loop) of the
    span's newest ``limit`` cases. Never raises for a store failure: the population then
    reports ``load_ok=False`` (nothing measured) or ``complete=False`` with the error (a
    partial read), and the rollups carry that into their honesty flags."""
    from datetime import datetime, timezone

    span = _requested_span(span_hours)
    key = _ladder_key(span)
    limit = max(1, int(limit))
    now_mono = time.monotonic()
    _prune_expired(now_mono)
    now_dt = datetime.now(timezone.utc)
    since = _since_of(now_dt, span)
    # A bounded window ends NOW (a future-dated case is in no trailing window); all
    # time is open-ended.
    until = now_dt if since is not None else None

    cache_key = (limit, key)
    entry = _population_cache.get(cache_key)
    if entry is None or entry.store is not store or entry.expires_at <= now_mono:
        entry = _covering_entry(store, limit, since, now_mono)
    if entry is not None:
        return await _narrow(entry, span, since, until)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — callers are always async routes
        loop = None
    pending = _population_inflight.get(cache_key)
    if (
        loop is not None
        and pending is not None
        and pending[0] is store
        and not pending[1].done()
        and pending[1].get_loop() is loop
    ):
        population = await asyncio.shield(pending[1])
        return await _narrow(population, span, since, until)
    fut: "asyncio.Future[CasePopulation] | None" = (
        loop.create_future() if loop is not None else None
    )
    if fut is not None:
        _population_inflight[cache_key] = (store, fut)
    try:
        lock = _loop_lock(key is None)
        if lock is not None:
            async with lock:
                population = await _load_after_lock(store, key=key, limit=limit, since=since)
        else:  # pragma: no cover
            population = await _load_after_lock(store, key=key, limit=limit, since=since)
    except BaseException as exc:
        if fut is not None and not fut.done():
            fut.set_exception(exc)
            fut.exception()
        raise
    else:
        if fut is not None and not fut.done():
            fut.set_result(population)
        return await _narrow(population, span, since, until)
    finally:
        current = _population_inflight.get(cache_key)
        if fut is not None and current is not None and current[1] is fut:
            del _population_inflight[cache_key]


async def _load_after_lock(store: Any, *, key: int | None, limit: int, since: Any) -> CasePopulation:
    """Re-check the cache once the load lock is held (a load that just finished may
    cover this request), else read and cache. A failed or partial read is never cached."""
    now_mono = time.monotonic()
    _prune_expired(now_mono)
    entry = _population_cache.get((limit, key))
    if entry is None or entry.store is not store or entry.expires_at <= now_mono:
        entry = _covering_entry(store, limit, since, now_mono)
    if entry is not None:
        return entry
    population = await _load_population(store, span_hours=key, limit=limit)
    if population.load_ok and not population.read_error:
        _population_cache[(limit, key)] = population
        _enforce_budget(keep=population)
    return population


def _enforce_budget(*, keep: CasePopulation) -> None:
    """Evict the oldest entries until the cache holds at most
    ``POPULATION_CACHE_BUDGET`` Case objects (the entry just stored always stays)."""
    def retained() -> int:
        return sum(len(entry.cases) for entry in _population_cache.values())

    while retained() > int(POPULATION_CACHE_BUDGET):
        victims = [k for k, v in _population_cache.items() if v is not keep]
        if not victims:
            return
        oldest = min(victims, key=lambda k: _population_cache[k].expires_at)
        _population_cache.pop(oldest, None)


# Narrowing a list this long happens in a worker thread (one ``created_at`` parse per
# case), so a narrowed view of the all-time population never stalls the event loop.
_NARROW_OFFLOAD_AT = 2000


def _in_window(cases: list, since: Any, until: Any) -> list:
    """The cases created in ``[since, until)`` by the rollups' window clock (an
    undatable case belongs to no bounded window). Pure; runs in a worker thread for a
    long list."""
    from ..engine.metrics import _created_dt

    out = []
    for case in cases:
        dt = _created_dt(case)
        if dt is not None and dt >= since and (until is None or dt < until):
            out.append(case)
    return out


async def _narrow(
    entry: CasePopulation, span: int | None, since: Any, until: Any = None,
) -> CasePopulation:
    """The view of ``entry`` for the requested ``span`` (exactly ``[since, until)``),
    with an honest ``in_scope``/``complete`` for it: complete when proven by the read
    itself (a complete read, or a newest-first read that reached past the window's
    start), otherwise decided by an exact COUNT of the same window."""
    cases = list(entry.cases)
    if since is not None:
        if len(cases) > _NARROW_OFFLOAD_AT:
            cases = await asyncio.to_thread(_in_window, cases, since, until)
        else:
            cases = _in_window(cases, since, until)
    if not entry.load_ok:
        return entry._copy(cases=[], span_hours=span, since=since, in_scope=0, complete=False)
    proven = not entry.unreadable and (
        (entry.complete and not entry.read_error)
        or (entry.newest_first and entry.floor is not None and since is not None
            and entry.floor < since)
    )
    if proven:
        return entry._copy(cases=cases, span_hours=span, since=since, in_scope=len(cases),
                           complete=True, error="", read_error="")
    if since is None and entry.store_total is not None:
        in_scope, count_failed = max(int(entry.store_total), len(cases)), False
    else:
        in_scope, count_failed = await _scope_count(
            entry.store, since, until, floor_at_least=len(cases)
        )
    complete = (not count_failed) and in_scope <= len(cases)
    if complete:
        error = ""
    elif entry.read_error:
        error = (
            f"the case store stopped answering after {len(entry.cases)} cases were read "
            f"({entry.read_error}); the figures are a lower bound"
        )
    elif entry.unreadable:
        error = entry.error
    else:
        error = _ceiling_error(in_scope, len(cases), count_failed)
    return entry._copy(
        cases=cases, span_hours=span, since=since, in_scope=in_scope, complete=complete,
        count_failed=count_failed, error=error,
        read_error="" if complete else entry.read_error,
    )


def _ceiling_error(in_scope: int, kept: int, count_failed: bool) -> str:
    if count_failed:
        return (
            f"the window holds more than the newest {kept} cases that were analysed, and "
            "its exact size could not be counted"
        )
    return f"the window holds {in_scope} cases; the newest {kept} were analysed"


async def _scope_count(
    store: Any, since: Any, until: Any = None, *, floor_at_least: int,
) -> tuple[int, bool]:
    """The exact number of cases created in ``[since, until)`` (all cases when ``since``
    is None; ``until`` None = up to now), and whether that count FAILED (then
    ``floor_at_least + 1`` — an honest lower bound). The window is the one the read
    and its narrowing used, so the count and the cases read describe the same set."""
    from ..engine.case_aggregate import CaseAggregateSpec, aggregate_cases
    from ..engine.time_windows import resolve_window

    try:
        if since is None:
            window = resolve_window("all")
        elif until is not None:
            window = resolve_window({"from": since.isoformat(), "to": until.isoformat()})
        else:
            window = resolve_window({"from": since.isoformat()})
        counted = await aggregate_cases(store, CaseAggregateSpec(window=window))
        if counted.exact:
            return max(int(counted.total), floor_at_least), False
    except Exception as exc:  # noqa: BLE001 — the count degrades to a lower bound
        logger.warning("case scope count soft-failed: %s", exc)
    return floor_at_least + 1, True


_CANONICAL_CREATED = None  # compiled lazily (re)


def _canonical_created(raw: Any) -> bool:
    """Is ``raw`` a ``created_at`` the stores ORDER by its string (the canonical
    ``YYYY-MM-DDTHH:MM:SS…+00:00`` spelling)? Only those set the read's floor: a legacy
    spelling's position in a store's order says nothing about how far the read reached."""
    import re

    global _CANONICAL_CREATED
    if _CANONICAL_CREATED is None:
        _CANONICAL_CREATED = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\+00:00$")
    return isinstance(raw, str) and bool(_CANONICAL_CREATED.match(raw))


# --------------------------------------------------------------------------- #
# Full garbage collections are deferred while a population is being built.
# --------------------------------------------------------------------------- #
# Building 20,000 ``Case`` objects allocates several hundred thousand long-lived
# objects. CPython runs a FULL (generation 2) collection each time the long-lived set
# grows by a quarter, so one read triggered about seven of them, each walking the whole
# heap while holding the GIL (90-220 ms apiece, measured on a 100,000-case store) — the
# event loop froze for ~1.2 s per read even with all the per-row work in a worker
# thread. While at least one read is in progress, the generation-2 threshold is raised
# so those collections are skipped (young collections still run, so short-lived
# garbage is still reclaimed); the original threshold is restored when the last read
# ends, or after ``_GC_HOLD_MAX_SECONDS`` whatever happens, and never over a threshold
# someone else set meanwhile. Measured: no loop stall above 10 ms during a read, and
# the read itself ~40% faster.
_GC_HOLD_THRESHOLD2 = 1_000_000
_GC_HOLD_MAX_SECONDS = 60.0
_gc_hold: dict[str, Any] = {"depth": 0, "saved": None, "held": None, "since": 0.0}
_gc_hold_lock = threading.Lock()


def _gc_release_locked() -> None:
    import gc

    held, saved = _gc_hold["held"], _gc_hold["saved"]
    if held is not None and saved is not None and gc.get_threshold() == held:
        gc.set_threshold(*saved)
    _gc_hold["held"] = None
    _gc_hold["saved"] = None


def _gc_hold_enter() -> None:
    import gc

    with _gc_hold_lock:
        _gc_hold["depth"] += 1
        if _gc_hold["depth"] != 1:
            return
        saved = gc.get_threshold()
        if not gc.isenabled() or saved[0] <= 0:
            return  # automatic collection is off: nothing to defer
        held = (saved[0], saved[1], max(int(saved[2]), _GC_HOLD_THRESHOLD2))
        gc.set_threshold(*held)
        _gc_hold.update(saved=saved, held=held, since=time.monotonic())


def _gc_hold_exit() -> None:
    with _gc_hold_lock:
        _gc_hold["depth"] = max(0, int(_gc_hold["depth"]) - 1)
        if _gc_hold["depth"] == 0:
            _gc_release_locked()


def _gc_hold_check() -> None:
    """Release a hold that has lasted longer than ``_GC_HOLD_MAX_SECONDS`` (a stalled
    read must never keep full collections off indefinitely)."""
    with _gc_hold_lock:
        if (_gc_hold["held"] is not None
                and time.monotonic() - float(_gc_hold["since"]) > _GC_HOLD_MAX_SECONDS):
            _gc_release_locked()


def _validate_case(row: Any) -> Any:
    """One stored document as a ``Case`` (raises when it no longer validates). Called
    from the population reader's worker thread, never on the event loop."""
    from ..models import Case

    return Case.model_validate(row)


def _order_key(row: Any) -> tuple[float, str]:
    """Newest-first sort key of a stored document or ``Case``: creation instant (an
    unreadable one sorts oldest), then case id."""
    from ..utils import parse_millis_strict

    raw = row.get("created_at") if isinstance(row, dict) else getattr(row, "created_at", None)
    cid = row.get("case_id") if isinstance(row, dict) else getattr(row, "case_id", "")
    millis = parse_millis_strict(raw)
    return (float(millis) if millis is not None else float("-inf"), str(cid or ""))


class _PopulationReader:
    """The CPU side of one population read: window checks, the retention ceiling,
    ordering and ``Case`` validation of the kept rows.

    Every method runs in a worker thread (one page at a time, never two at once — each
    page is awaited before the next is read), so the event loop only waits on I/O.

    * ``newest`` mode (the store reads newest first): keep in-window rows in read order
      until ``limit`` rows have been taken, then ask the scan to stop (``overflow``).
    * heap mode (any other store): keep the newest ``limit`` in-window raw rows in a
      heap while every row streams past; validate them at :meth:`finish`.

    Window membership is ``[since, until)`` by ``created_at`` (``since`` None = all
    time, no upper bound); a case with no usable creation time belongs to no bounded
    window."""

    def __init__(self, *, since: Any, until: Any, limit: int, newest: bool) -> None:
        self.since = since
        self.until = until
        self.limit = limit
        self.newest = newest
        self.kept: list[Any] = []  # newest mode: validated Cases in read order
        self.heap: list[tuple[tuple[float, str], int, Any]] = []  # heap mode: raw rows
        self.seq = 0
        self.unreadable = 0
        self.floor: Any = None
        self.in_span_read = 0
        self.overflow = False

    def in_span(self, row: Any) -> bool:
        if self.since is None:
            return True
        from ..engine.case_aggregate import _created_of

        created = _created_of(row)
        return created is not None and created >= self.since and (
            self.until is None or created < self.until
        )

    def note_floor(self, row: Any) -> None:
        from ..engine.case_aggregate import _created_of

        raw = row.get("created_at") if isinstance(row, dict) else getattr(row, "created_at", None)
        if not _canonical_created(raw):
            return
        created = _created_of(row)
        if created is not None and (self.floor is None or created < self.floor):
            self.floor = created

    def validate(self, row: Any) -> Any | None:
        if not isinstance(row, dict):
            return row
        try:
            return _validate_case(row)
        except Exception:  # noqa: BLE001 — one bad document must not fail the rollups
            self.unreadable += 1
            return None

    def consume(self, page: list[Any]) -> None:
        (self._consume_newest if self.newest else self._consume_heap)(page)

    def _consume_newest(self, page: list[Any]) -> None:
        for row in page:
            if not self.in_span(row):
                continue
            if len(self.kept) + self.unreadable >= self.limit:
                # The span holds more than the ceiling: stop keeping (and reading).
                self.overflow = True
                return
            self.in_span_read += 1
            self.note_floor(row)
            case = self.validate(row)
            if case is not None:
                self.kept.append(case)

    def _consume_heap(self, page: list[Any]) -> None:
        import heapq

        for row in page:
            if not self.in_span(row):
                continue
            self.in_span_read += 1
            self.seq += 1
            if self.in_span_read > self.limit:
                self.overflow = True
            item = (_order_key(row), self.seq, row)
            if len(self.heap) < self.limit:
                heapq.heappush(self.heap, item)
            elif item[0] > self.heap[0][0]:
                heapq.heapreplace(self.heap, item)

    def finish(self) -> list[Any]:
        """The kept cases, validated, newest first by creation."""
        if self.newest:
            cases = self.kept
        else:
            ordered = [row for _k, _s, row in
                       sorted(self.heap, key=lambda t: (t[0], t[1]), reverse=True)]
            cases = [c for c in (self.validate(row) for row in ordered) if c is not None]
            for case in cases:
                self.note_floor(case)
        # Newest first by creation (the bundled stores already read in this order; the
        # sort keeps the guarantee for any other repository).
        cases.sort(key=_order_key, reverse=True)
        return cases


async def _load_population(store: Any, *, span_hours: int | None, limit: int) -> CasePopulation:
    """Read the newest ``limit`` cases of the last ``span_hours`` (all time when None).

    Reads raw documents newest-first when the store can (and stops after ``limit``),
    else scans every row keeping the newest ``limit`` in a heap; validates only the
    kept rows, off the event loop (:class:`_PopulationReader`). A bounded span is
    ``[now - span, now)`` in the store pre-filter, the reader and the exact count
    alike. Pairs the read with exact counts (the span's size, the store total, the open
    stock)."""
    from datetime import datetime, timezone

    from ..engine.case_aggregate import (
        CaseAggregateSpec,
        _accepted_kwargs,
        aggregate_cases,
        scan_cases,
    )
    from ..engine.time_windows import resolve_window

    now_dt = datetime.now(timezone.utc)
    since = _since_of(now_dt, span_hours)
    until = now_dt if since is not None else None
    scan_page = getattr(store, "scan_page", None)
    newest = bool(callable(scan_page)
                  and _accepted_kwargs(scan_page, {"newest_first": True}))
    reader = _PopulationReader(since=since, until=until, limit=limit, newest=newest)

    async def consume(page: list[Any]) -> None:
        _gc_hold_check()
        await asyncio.to_thread(reader.consume, list(page))

    load_ok = True
    read_error = ""
    consistency = "unverified"
    exhausted = False
    newest_first = False
    _gc_hold_enter()
    try:
        try:
            outcome = await scan_cases(
                store, consume, page_size=_READ_PAGE, created_from=since, created_to=until,
                raw=True, newest_first=newest,
                stop=(lambda: bool(reader.overflow)) if newest else None,
            )
            consistency = outcome.consistency
            newest_first = bool(outcome.newest_first) or (outcome.complete and not newest)
            if not outcome.complete:
                read_error = outcome.error or "the case store stopped answering"
            # Every in-span row was read AND kept (no ceiling overflow, no early stop).
            exhausted = outcome.complete and not outcome.stopped and not reader.overflow
        except Exception as exc:  # noqa: BLE001 — dashboards degrade, never fail hard
            logger.warning("case population load soft-failed: %s", exc)
            load_ok = False
            read_error = str(exc) or exc.__class__.__name__
        cases = await asyncio.to_thread(reader.finish) if load_ok else []
    finally:
        _gc_hold_exit()
    unreadable = int(reader.unreadable)
    floor = reader.floor

    store_total: int | None = None
    open_now: int | None = None
    in_scope = len(cases)
    count_failed = False
    if load_ok:
        try:
            counts = await aggregate_cases(store, CaseAggregateSpec(
                window=resolve_window("all", now=now_dt), metrics=("count", "open_now"),
            ))
            if counts.exact:
                store_total = int(counts.total)
                open_now = int(counts.totals.get("open_now", 0))
        except Exception as exc:  # noqa: BLE001 — counts degrade to "unknown"
            logger.warning("case store counts soft-failed: %s", exc)
        complete_read = exhausted and not read_error and not unreadable
        if not complete_read:
            if since is None and store_total is not None:
                in_scope = max(store_total, len(cases))
                count_failed = False
            else:
                in_scope, count_failed = await _scope_count(
                    store, since, until, floor_at_least=len(cases)
                )
    else:
        in_scope = 0
    complete = bool(load_ok and exhausted and not read_error and not unreadable)
    if load_ok and not complete and not read_error and not unreadable and not count_failed:
        # Stopped at the ceiling, but the span may hold no more than was read.
        complete = in_scope <= len(cases)
    error = ""
    if not load_ok:
        error = read_error
    elif read_error:
        error = (
            f"the case store stopped answering after {len(cases)} cases were read "
            f"({read_error}); the figures are a lower bound"
        )
    elif unreadable:
        error = (
            f"{unreadable} stored case{'s' if unreadable != 1 else ''} could not be read "
            "(the document no longer matches the case format), so "
            f"{'they are' if unreadable != 1 else 'it is'} not in these figures"
        )
    elif not complete:
        error = _ceiling_error(in_scope, len(cases), count_failed)
    return CasePopulation(
        cases=cases,
        span_hours=span_hours,
        since=since,
        in_scope=in_scope,
        complete=complete,
        load_ok=load_ok,
        store_total=store_total,
        open_now=open_now,
        consistency=consistency,
        error=error,
        store=store,
        limit=limit,
        expires_at=time.monotonic() + float(POPULATION_TTL_SECONDS),
        newest_first=newest_first,
        floor=floor,
        read_error=read_error,
        unreadable=unreadable,
        key=span_hours,
        read_at=now_dt,
        count_failed=count_failed,
    )


# =========================================================================== #
# Exact store-wide headline counts (GET /api/metrics).
# =========================================================================== #
# The legacy metrics view publishes headline COUNTS over the whole store (total, by
# status, by verdict, by disposition). Those come from exact aggregates — a COUNT/GROUP
# BY push-down where the backend has one (status and verdict on Elasticsearch; all three
# on SQL), else a streaming fold that reads only the few stored fields it needs — never
# from the newest-N case population, so a large store's counts are exact, not a sample.
# Shared for the same short TTL as the population, single-flight, keyed by store
# identity (Demo Mode's store swap self-invalidates).

BREAKDOWN_TTL_SECONDS = CASE_PAGE_TTL_SECONDS
_breakdown_memo: dict[str, Any] = {}
_breakdown_inflight: dict[str, tuple[Any, "asyncio.Future[CaseBreakdown]"]] = {}


class CaseBreakdown:
    """Exact store-wide case counts. Each part is ``None`` when it could not be
    counted exactly (the caller then falls back to its own, labelled, figures).

    * ``total`` — every stored case (cases with no creation date included);
    * ``by_status`` — ``{status: n}`` (``"unknown"`` for a document with no status);
    * ``by_verdict`` — ``{verdict: n}`` (``"none"`` = no verdict yet);
    * ``by_disposition`` — ``{disposition: n}`` (``"undetermined"`` = none recorded);
    * ``errors`` — why a part is missing (empty when every part is exact)."""

    __slots__ = ("total", "by_status", "by_verdict", "by_disposition", "errors")

    def __init__(
        self,
        *,
        total: int | None = None,
        by_status: dict[str, int] | None = None,
        by_verdict: dict[str, int] | None = None,
        by_disposition: dict[str, int] | None = None,
        errors: list[str] | None = None,
    ) -> None:
        self.total = total
        self.by_status = by_status
        self.by_verdict = by_verdict
        self.by_disposition = by_disposition
        self.errors = list(errors or [])

    @property
    def exact(self) -> bool:
        """Every part was counted exactly."""
        return None not in (self.total, self.by_status, self.by_verdict, self.by_disposition)

    def counts(self) -> dict[str, Any]:
        """The exact parts only, in ``engine.metrics.compute_metrics(counts=…)`` form."""
        out: dict[str, Any] = {}
        if self.total is not None:
            out["total"] = self.total
        if self.by_status is not None:
            out["by_status"] = dict(self.by_status)
        if self.by_verdict is not None:
            out["by_verdict"] = dict(self.by_verdict)
        if self.by_disposition is not None:
            out["by_disposition"] = dict(self.by_disposition)
        return out


async def _count_breakdown(store: Any) -> CaseBreakdown:
    """Two exact aggregates over all time, run together: status × verdict (one composite
    on Elasticsearch, one ``GROUP BY`` on SQL) and disposition. A part that fails or is
    not exact is left out and named in ``errors`` (never a sample presented as exact)."""
    from ..engine.case_aggregate import CaseAggregateSpec, aggregate_cases
    from ..engine.time_windows import resolve_window

    window = resolve_window("all")
    pair, disposition = await asyncio.gather(
        aggregate_cases(store, CaseAggregateSpec(window=window, group_by=("status", "verdict"))),
        aggregate_cases(store, CaseAggregateSpec(window=window, group_by=("disposition",))),
        return_exceptions=True,
    )
    out = CaseBreakdown()
    if isinstance(pair, BaseException):
        logger.warning("case status/verdict counts soft-failed: %s", pair)
        out.errors.append("the case counts by status and verdict could not be read")
    elif not pair.exact:
        out.errors.append(
            "the case counts by status and verdict are incomplete"
            + (f" ({pair.error})" if pair.error else "")
        )
    else:
        by_status: dict[str, int] = {}
        by_verdict: dict[str, int] = {}
        for row in pair.groups:
            key = row.get("key") or {}
            n = int((row.get("metrics") or {}).get("count", 0) or 0)
            status = key.get("status") or "unknown"
            verdict = key.get("verdict") or "none"
            by_status[status] = by_status.get(status, 0) + n
            by_verdict[verdict] = by_verdict.get(verdict, 0) + n
        out.total = int(pair.total)
        out.by_status = by_status
        out.by_verdict = by_verdict
    if isinstance(disposition, BaseException):
        logger.warning("case disposition counts soft-failed: %s", disposition)
        out.errors.append("the case counts by disposition could not be read")
    elif not disposition.exact:
        out.errors.append(
            "the case counts by disposition are incomplete"
            + (f" ({disposition.error})" if disposition.error else "")
        )
    else:
        by_disposition: dict[str, int] = {}
        for row in disposition.groups:
            key = (row.get("key") or {}).get("disposition") or "undetermined"
            n = int((row.get("metrics") or {}).get("count", 0) or 0)
            by_disposition[key] = by_disposition.get(key, 0) + n
        out.by_disposition = by_disposition
    return out


async def fetch_case_breakdown(store: Any) -> CaseBreakdown:
    """The exact store-wide :class:`CaseBreakdown`, shared for
    ``BREAKDOWN_TTL_SECONDS`` per store (single-flight). Never raises for a store
    failure: the missing parts are ``None`` with a reason. Only a fully exact breakdown
    is memoised."""
    hit = _breakdown_memo.get("entry")
    if hit is not None and hit["store"] is store and hit["expires"] > time.monotonic():
        return hit["value"]
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — callers are always async routes
        loop = None
    pending = _breakdown_inflight.get("entry")
    if (
        loop is not None
        and pending is not None
        and pending[0] is store
        and not pending[1].done()
        and pending[1].get_loop() is loop
    ):
        return await asyncio.shield(pending[1])
    fut: "asyncio.Future[CaseBreakdown] | None" = (
        loop.create_future() if loop is not None else None
    )
    if fut is not None:
        _breakdown_inflight["entry"] = (store, fut)
    try:
        value = await _count_breakdown(store)
    except BaseException as exc:
        if fut is not None and not fut.done():
            fut.set_exception(exc)
            fut.exception()
        raise
    else:
        if fut is not None and not fut.done():
            fut.set_result(value)
        if value.exact:
            _breakdown_memo["entry"] = {
                "store": store, "value": value,
                "expires": time.monotonic() + float(BREAKDOWN_TTL_SECONDS),
            }
        return value
    finally:
        current = _breakdown_inflight.get("entry")
        if fut is not None and current is not None and current[1] is fut:
            del _breakdown_inflight["entry"]


# =========================================================================== #
# The agent-improvement ledger span (usage ledger rows of one reporting span).
# =========================================================================== #
LEDGER_TTL_SECONDS = CASE_PAGE_TTL_SECONDS
_ledger_memo: dict[str, Any] = {}


async def fetch_ledger_span(
    store: Any, *, span_start: Any, end: Any,
) -> tuple[list[dict[str, Any]], bool]:
    """``(rows, truncated)``: the ``{ts, case_id, cost}`` projection of every usage-ledger
    row in ``[span_start, end)`` — plus rows whose ``ts`` cannot be placed in time (the
    caller decides those) — memoised for ``LEDGER_TTL_SECONDS`` per store and span.

    The span is pushed into the scan (``engine.case_aggregate.scan_ledger``: the
    bundled stores range-filter ``ts`` under one snapshot / on the indexed column), so
    the cost follows the span, never the ledger's whole history. ``truncated`` is True
    when the scan stopped early or the repository could only return one unverified
    page. A failed read raises and is never memoised."""
    from ..engine.case_aggregate import scan_ledger
    from ..utils import parse_es_timestamp

    key = (span_start.isoformat(), end.isoformat())
    hit = _ledger_memo.get("entry")
    if (hit is not None and hit["store"] is store and hit["key"] == key
            and hit["expires"] > time.monotonic()):
        return list(hit["rows"]), bool(hit["truncated"])
    rows: list[dict[str, Any]] = []

    def keep(page: list[Any]) -> None:
        for row in page:
            if not isinstance(row, dict):
                continue
            stamp = parse_es_timestamp(row.get("ts"))
            # An unreadable stamp is kept (the pure layer decides); a readable one only
            # inside the reporting span (the scan's pre-filter may over-keep).
            if stamp is not None and not (span_start <= stamp < end):
                continue
            rows.append({
                "ts": row.get("ts"), "case_id": row.get("case_id"), "cost": row.get("cost"),
            })

    outcome = await scan_ledger(store, keep, ts_from=span_start, ts_to=end)
    truncated = (not outcome.complete) or outcome.consistency == "unverified"
    if outcome.complete:
        _ledger_memo["entry"] = {
            "store": store, "key": key, "rows": rows, "truncated": truncated,
            "expires": time.monotonic() + float(LEDGER_TTL_SECONDS),
        }
    return list(rows), truncated
