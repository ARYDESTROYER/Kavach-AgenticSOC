"""Polling loop + durable cursor (Section 6.1) — the trigger mechanism.

Elasticsearch is a store, not a stream, so the agent POLLS for above-threshold,
in-scope events newer than a durable cursor. This is also the Surface 3 background
worker: clusters whose rule is on the auto-forward allowlist are auto-investigated;
all other clusters are registered as OPEN candidates (never dropped) for manual
Surface 2 investigation.

Correctness invariants (Non-negotiable #4), all restart-tested:
  * cursor uses an INCLUSIVE lower bound + boundary-id dedup → no event skipped,
    none re-processed;
  * clusters are keyed by signature → re-polling never creates duplicate cases.
"""

from __future__ import annotations

import asyncio
import collections
import logging
from typing import TYPE_CHECKING, Any, Callable

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..connectors.base import PullConnector
from ..connectors.elastic import ElasticConnector
from ..constants import ActionType, SourceSurface
from ..engine.cost_gate import passes_suppression
from ..engine.ingest import (
    InvestigationBudget,
    _is_ignored_cluster,
    attach_cluster,
    dedup_by_id,
    handle_clusters,
)
from ..engine.noise_counters import (
    count_clusters_by_band,
    count_events_by_band,
    events_per_min_from_ticks,
    severity_scale_for_source,
    zero_bands,
)
from ..es.base import BaseESClient
from ..es.querybuilder import (
    PULL_LATE_ARRIVAL_OVERLAP_MILLIS,
    PULL_RECENT_EVENT_LIMIT,
)
from ..models import Cursor, RawEvent
from ..stores.cursor_store import CursorStore
from ..utils import now_utc, to_millis
from ..agents.pipeline import InvestigationPipeline

if TYPE_CHECKING:
    from ..stores.base import CaseRepository

logger = logging.getLogger("tlsoc.engine.poller")


def _advance_cursor_state(
    cursor: Cursor,
    max_ts: int,
    boundary_ids: list[str],
    *,
    recent_event_millis: dict[str, int] | None = None,
    overlap_backfill_complete: bool | None = None,
) -> Cursor:
    """Advance the frontier and merge bounded late-arrival identity state."""
    target_ts = cursor.timestamp_millis
    target_boundary = list(cursor.boundary_ids)
    if max_ts > target_ts:
        target_ts = max_ts
        target_boundary = list(dict.fromkeys(boundary_ids))
    elif max_ts == target_ts and max_ts > 0:
        target_boundary = list(dict.fromkeys(boundary_ids + target_boundary))

    recent = dict(cursor.recent_event_millis)
    if recent_event_millis is not None:
        recent.update({str(k): int(v) for k, v in recent_event_millis.items() if int(v) > 0})
    if target_ts > 0:
        cutoff = max(0, target_ts - PULL_LATE_ARRIVAL_OVERLAP_MILLIS)
        recent = {key: ts for key, ts in recent.items() if cutoff <= ts <= target_ts}

    saturated = cursor.overlap_saturated
    if len(recent) > PULL_RECENT_EVENT_LIMIT:
        # Prefer duplicate safety to an unbounded cursor document.  Keep the newest
        # exact identities for diagnostics, but disable optional older-than-frontier
        # acceptance once the overlap cannot be represented completely.
        ordered = sorted(recent.items(), key=lambda item: (item[1], item[0]), reverse=True)
        recent = dict(ordered[:PULL_RECENT_EVENT_LIMIT])
        saturated = True

    initialized = cursor.overlap_initialized
    if overlap_backfill_complete is not None:
        initialized = initialized or bool(overlap_backfill_complete)

    values = (
        target_ts,
        tuple(target_boundary),
        recent,
        initialized,
        saturated,
        cursor.late_arrival_overlap_enabled,
    )
    current = (
        cursor.timestamp_millis,
        tuple(cursor.boundary_ids),
        cursor.recent_event_millis,
        cursor.overlap_initialized,
        cursor.overlap_saturated,
        cursor.late_arrival_overlap_enabled,
    )
    if values == current:
        return cursor
    return Cursor(
        timestamp_millis=target_ts,
        boundary_ids=target_boundary,
        recent_event_millis=recent,
        overlap_initialized=initialized,
        overlap_saturated=saturated,
        late_arrival_overlap_enabled=cursor.late_arrival_overlap_enabled,
    )


def advance_cursor(
    cursor: Cursor,
    fetched: list[RawEvent],
    *,
    recent_event_millis: dict[str, int] | None = None,
    overlap_backfill_complete: bool | None = None,
) -> Cursor:
    """Advance the cursor to cover EVERY fetched event without skipping ties."""
    if not fetched:
        return _advance_cursor_state(
            cursor,
            0,
            [],
            recent_event_millis=recent_event_millis,
            overlap_backfill_complete=overlap_backfill_complete,
        )
    max_ts = max(e.timestamp_millis for e in fetched)
    boundary = [e.cursor_key() for e in fetched if e.timestamp_millis == max_ts]
    observed = recent_event_millis or {
        e.cursor_key(): e.timestamp_millis for e in fetched if e.timestamp_millis > 0
    }
    return _advance_cursor_state(
        cursor,
        max_ts,
        boundary,
        recent_event_millis=observed,
        overlap_backfill_complete=overlap_backfill_complete,
    )


def advance_cursor_to(
    cursor: Cursor,
    max_ts: int,
    boundary_ids: list[str],
    *,
    recent_event_millis: dict[str, int] | None = None,
    overlap_backfill_complete: bool | None = None,
) -> Cursor:
    """Advance ``cursor`` to an explicit watermark ``(max_ts, boundary_ids)``.

    The watermark-driven variant of :func:`advance_cursor` (#4). A per-feed poll
    advances over the watermark of EVERY hit it SCANNED — kept AND dropped — not just
    the kept events, so a broad feed that drops hits owned by a narrower overlapping
    feed still advances its OWN cursor over the whole window it scanned and never
    skips its own newer events beyond that window. Same no-skip-ties tiebreaker as
    ``advance_cursor``: same-millisecond ids are unioned with the existing boundary so
    a tie is never re-processed nor skipped. A watermark at/behind the cursor (or an
    empty/zero watermark — the feed read nothing) leaves the cursor unchanged."""
    if max_ts <= 0 and recent_event_millis is None and overlap_backfill_complete is None:
        return cursor
    return _advance_cursor_state(
        cursor,
        max_ts,
        list(boundary_ids),
        recent_event_millis=recent_event_millis,
        overlap_backfill_complete=overlap_backfill_complete,
    )


class Poller:
    def __init__(
        self,
        es: BaseESClient,
        cases: "CaseRepository",
        cursor_store: CursorStore,
        audit: AuditLogger,
        pipeline: InvestigationPipeline,
        get_prefs: Callable[[], Preferences],
        source: PullConnector | None = None,
    ) -> None:
        self._es = es
        # The read-only log surface the poller reads from. Defaults to wrapping
        # ``es`` in an ElasticConnector (behaviour identical to the legacy direct
        # ES read); state wiring injects the configured primary connector.
        self._source = source or ElasticConnector(es)
        self._cases = cases
        self._cursor_store = cursor_store
        self._audit = audit
        self._pipeline = pipeline
        self._get_prefs = get_prefs
        self._task: asyncio.Task | None = None
        self._running = False
        # Round-4 Wave-4: OPTIONAL EVENT-feed routing hook. When set (by AppState) AND
        # batch+event-detection are enabled, a ``role=events`` feed's fetched events are
        # routed to this async funnel (aggregate→rules→anomaly→batched detection) INSTEAD
        # OF the realtime correlation-window read — keeping high-volume EVENT feeds out
        # of the realtime path (per the 01 ingestion map). The hook is
        # ``async (events, prefs) -> None`` and NEVER raises into the poll cycle. When the
        # hook is None (the default) or the toggle is OFF, the EXISTING realtime path is
        # byte-identical (the critical safety property: default OFF = no change). The
        # feed's durable cursor still advances over the full scanned window (#4 no-skip)
        # regardless of which path handles the events.
        self._event_funnel: Callable | None = None
        # Round-7 Noise-Reduction counters: an OPTIONAL fail-open sink that records this
        # poll tick's raw-alert-by-severity tally (ingested/clustered/suppressed/ignored)
        # into the durable NoiseCounterStore. Wired by AppState (fanned out via
        # PollerManager.set_noise_sink) as a SEPARATE hook from ``_event_funnel`` (P0 name
        # collision avoidance). ``async (delta: dict) -> None`` and NEVER raises into the
        # poll cycle. None (the default) → no counters recorded (byte-identical poll path);
        # advisory presentation state only, never feeds ``decide()`` (#3).
        self._noise_sink: Callable | None = None
        # Coverage observability (A5.1): an IN-MEMORY per-source "last tick" snapshot,
        # populated at the END of every ``poll_once`` (and, on a failed tick, by
        # ``PollerManager._run_one``'s except path via ``record_tick``). Shape:
        # ``{ts, ok, error, stats, events_per_min}``. This gives a genuine wall-clock
        # "last poll attempt" + ``ok``/``error`` per source — independent of whether any
        # event arrived — so a broken connector (``ok:False``) is no longer indistinguishable
        # from a legitimately-quiet one (frozen cursor). In-memory only (resets on restart;
        # the durable cursor stays the source of truth for "has this ever polled"), zero
        # schema change. Advisory presentation state; NEVER feeds ``decide()`` (#3). The
        # rolling ``_recent_ticks`` deque of ``(epoch_seconds, polled)`` samples smooths the
        # ``events_per_min`` rate over the last few ticks (same pattern as
        # ``IngestService._recent``).
        self._last_tick: dict[str, Any] | None = None
        self._recent_ticks: collections.deque = collections.deque(maxlen=6)
        # The durable cursor key used by the LEGACY / un-fed union path (a source with
        # no ``index_patterns`` feeds). Defaults to ``"primary"`` so a single-source
        # deployment reads the legacy ``CURSOR_DOC_ID`` doc unchanged (#4 — no
        # migration). The Round-4 :class:`PollerManager` overrides this to a DISTINCT
        # ``f"{source.id}:primary"`` for every NON-primary un-fed source so two un-fed
        # sources under fan-out never stomp the single shared ``primary`` cursor doc.
        self._legacy_cursor_key = "primary"

    def _correlation_lookback_seconds(self, prefs: Preferences) -> int:
        """The sliding look-back (seconds) correlation must see each poll.

        Correlation triggers require N events within ``window_seconds`` of the SAME
        entity. The durable cursor only yields the incremental batch since the last
        poll (~one poll interval of events in steady state), so a real burst spread
        across its full window would arrive a few events at a time and never reach
        the threshold in any single batch (BUG-5). We therefore correlate over the
        WIDEST configured rule window (never less than one poll interval) plus a
        small safety margin, so a slow-burn burst is seen whole. The cursor still
        governs what is "new" for de-dup of investigation/attach (Non-negotiable #4).
        """
        windows = [prefs.default_correlation.window_seconds]
        windows += [r.window_seconds for r in prefs.correlation_rules.values()]
        widest = max(windows) if windows else prefs.default_correlation.window_seconds
        interval = max(1, prefs.poll_interval_seconds)
        # +2 poll intervals of slack absorbs poll jitter / a late-arriving event at
        # the trailing edge of the window without re-scanning unboundedly.
        return max(widest, interval) + 2 * interval

    def _cursor_key(self, prefs: Preferences, feed_id: str) -> str:
        """The durable cursor key for one feed: ``f'{source.id}:{feed.id}'`` so a fast
        alerts feed and a slow events feed never share/skip a cursor (#4). Falls back
        to the legacy ``primary`` key when the source/feed has no stable id (so an
        existing single-source cursor is read unchanged — no migration)."""
        source_id = getattr(self._source, "connector_id", "") or ""
        if not source_id or not feed_id:
            return "primary"
        return f"{source_id}:{feed_id}"

    def _event_routing_active(self, prefs: Preferences) -> bool:
        """Whether high-volume EVENT-feed routing to the detection funnel is engaged.

        Active only when a funnel hook is wired AND batch inference AND the anomaly
        baseline (the event-detection toggle) are BOTH enabled. Default OFF on every
        count, so the EXISTING realtime path is byte-identical out of the box (the
        critical safety property). Demo mode is gated in the run loop before we ever
        reach here, so a demo tick never routes to the real funnel."""
        if self._event_funnel is None:
            return False
        batch = getattr(prefs, "batch", None)
        baseline = getattr(prefs, "baseline", None)
        return bool(getattr(batch, "enabled", False)) and bool(getattr(baseline, "enabled", False))

    @staticmethod
    def _feed_is_events_role(feed) -> bool:
        """True when a feed carries the ``events`` role (the high-volume, correlate→
        allowlist role). ALERTS feeds are unchanged (they stay on the realtime path);
        an IGNORE feed never reaches the poll loop (``feeds()`` excludes it)."""
        role = getattr(feed, "role", None)
        return str(getattr(role, "value", role)) == "events"

    def _routed_events_feed_ids(self, feeds) -> set[str]:
        """The ids of the ``events``-role feeds whose events are routed to the funnel.

        Used to keep those events OUT of the wider correlation-window read too — the
        window re-reads ALL feeds via ``source.poll``, so without this filter a routed
        events feed's events would sneak back into the realtime correlate. Matching is by
        ``feed_id`` (the connector tags every kept event with it)."""
        out: set[str] = set()
        for feed in feeds:
            if not self._feed_is_events_role(feed):
                continue
            fid = getattr(feed, "id", "") or ""
            if fid:
                out.add(str(fid))
        return out

    def _source_feeds(self):
        """The connector's per-feed list (Wave 6) — empty for a connector that does
        not expose feeds (legacy single-cursor union path)."""
        getter = getattr(self._source, "feeds", None)
        if getter is None:
            return []
        try:
            return list(getter())
        except Exception:  # noqa: BLE001
            return []

    async def _poll_feed_scan(self, prefs: Preferences, feed, cursor: Cursor, cold_from: int):
        """Fetch one feed's batch + its full-scan watermark (#4).

        Prefers the connector's ``poll_feed_scan`` (which reports the watermark of
        EVERY hit it read, kept AND dropped) so a broad feed's cursor advances over the
        whole window it scanned and never skips its own newer events past a window owned
        by a narrower overlapping feed. Falls back to ``poll_feed`` for a connector that
        only exposes the events list — there the watermark is synthesised from the kept
        events (back-compat: a connector with no overlapping-feed drop has identical
        kept/scanned sets, so this is byte-equivalent to advancing over the batch)."""
        from ..connectors.elastic import FeedScan

        scan_fn = getattr(self._source, "poll_feed_scan", None)
        if scan_fn is not None:
            return await scan_fn(prefs, feed, cursor, cold_from)
        events = await self._source.poll_feed(prefs, feed, cursor, cold_from)
        max_ts = max((e.timestamp_millis for e in events), default=0)
        boundary = [
            e.cursor_key() for e in events if e.timestamp_millis == max_ts
        ] if max_ts > 0 else []
        recent = {
            e.cursor_key(): e.timestamp_millis for e in events if e.timestamp_millis > 0
        }
        return FeedScan(
            events=events,
            scan_max_ts=max_ts,
            scan_boundary_ids=boundary,
            scan_recent_event_millis=recent,
        )

    async def _poll_source_scan(
        self, prefs: Preferences, cursor: Cursor, cold_from: int
    ):
        """Fetch an un-fed source plus optional cursor bookkeeping metadata."""
        from ..connectors.elastic import FeedScan

        scan_fn = getattr(self._source, "poll_scan", None)
        # Preserve the long-standing PullConnector override contract (and failure
        # instrumentation): an instance-level ``poll`` override must not be silently
        # bypassed merely because its concrete Elastic connector also offers richer
        # scan metadata.
        if "poll" in getattr(self._source, "__dict__", {}):
            scan_fn = None
        if scan_fn is not None:
            return await scan_fn(prefs, cursor, cold_from)
        events = await self._source.poll(prefs, cursor, cold_from)
        max_ts = max((e.timestamp_millis for e in events), default=0)
        boundary = [
            e.cursor_key() for e in events if max_ts > 0 and e.timestamp_millis == max_ts
        ]
        recent = {
            e.cursor_key(): e.timestamp_millis for e in events if e.timestamp_millis > 0
        }
        return FeedScan(
            events=events,
            scan_max_ts=max_ts,
            scan_boundary_ids=boundary,
            scan_recent_event_millis=recent,
        )

    def record_tick(self, *, ok: bool, error: str | None = None,
                    stats: dict[str, Any] | None = None) -> None:
        """Capture this poll cycle's IN-MEMORY "last tick" snapshot (coverage observability,
        A5.1). Called at the END of a successful ``poll_once`` (``ok=True``) AND by
        ``PollerManager._run_one``'s except path on a failed tick (``ok=False`` + the error
        string). Fail-open — a snapshot glitch must never break a poll. Advisory only,
        never feeds ``decide()`` (#3). The error string is source-controlled connector text
        and is rendered as PLAIN text by the health surface (#9)."""
        try:
            moment = now_utc()
            polled = int((stats or {}).get("polled", 0) or 0) if isinstance(stats, dict) else 0
            self._recent_ticks.append((moment.timestamp(), polled))
            self._last_tick = {
                "ts": moment.isoformat(),
                "ok": bool(ok),
                "error": (str(error) if error else None),
                "stats": dict(stats) if isinstance(stats, dict) else {},
                "events_per_min": self.events_per_min(),
            }
        except Exception:  # noqa: BLE001 — observability must never break a poll
            pass

    def events_per_min(self) -> float:
        """Smoothed events/min over the last few ticks (A5.1). ``0.0`` until ≥2 ticks."""
        return events_per_min_from_ticks(self._recent_ticks)

    async def poll_once(
        self,
        prefs: Preferences | None = None,
        *,
        investigation_budget: InvestigationBudget | None = None,
    ) -> dict[str, Any]:
        prefs = prefs or self._get_prefs()
        cold_from = to_millis(now_utc()) - prefs.cold_start_lookback_minutes * 60 * 1000

        # Wave 6: read each FEED on its OWN durable cursor (so a fast alerts feed and a
        # slow events feed never share/skip a cursor, #4). A legacy/un-fed source has
        # no feeds → the single-cursor union path below, byte-identical to before. Each
        # per-feed cursor still governs what is "new" for THAT feed; dedup/advance is
        # unchanged, just applied per feed.
        feeds = self._source_feeds()
        # Round-4 Wave-4: when EVENT-feed routing is engaged (batch + baseline enabled +
        # a funnel hook wired), a ``role=events`` feed's NEW events are collected here and
        # handed to the detection funnel INSTEAD OF the realtime correlation window read —
        # so the high-volume EVENT path never hits the realtime correlate. Default OFF →
        # this list stays empty and every event flows the byte-identical realtime path.
        event_routing = feeds and self._event_routing_active(prefs)
        funnel_events: list[RawEvent] = []
        # Feed keys whose low/medium events are handed to async Batch.  Their cursors
        # are committed only after the funnel durably accepts the outcome (a local
        # Batch outbox row, or an explicit no-candidate result).
        funnel_feed_keys: set[str] = set()
        event_feed_sync_event_ids: set[int] = set()
        fetched: list[RawEvent] = []
        new_events: list[RawEvent] = []
        # Track each feed's (key, loaded cursor, advanced cursor) so we persist each
        # cursor independently after handling. The advanced cursor is computed from the
        # FULL SCANNED watermark (kept + dropped hits), NOT only the kept batch (#4) —
        # a broad feed that drops hits owned by a narrower overlapping feed must still
        # advance its own cursor over the whole window it scanned or it skips its own
        # newer events forever (the dropped hits are owned + processed by the narrower
        # feed via that feed's own cursor; no skip, no dup).
        feed_state: list[tuple[str, Cursor, Cursor]] = []
        # Coverage observability (B3 silent-vs-broken fix): a MULTI-FEED source isolates
        # each feed's failure (the per-feed try/except below logs + continues). Before this
        # fix, ``poll_once`` then recorded ``ok=True`` at the end regardless — so a source
        # whose EVERY feed raised reported ``last_poll_ok=True`` and showed as HEALTHY on
        # GET /api/sources/health (only the legacy un-fed path, where the exception escapes,
        # detected failure). Accumulate each failed feed's ``(feed_id, error)`` here and fold
        # it into ``record_tick`` at the end: any failed feed → ``ok=False`` + the error
        # list, while partial success still records the events that DID arrive. Advisory
        # only; never feeds ``decide()`` (#3). The un-fed path leaves this empty → byte-
        # identical ``ok=True``.
        feed_failures: list[tuple[str, str]] = []
        if feeds:
            for feed in feeds:
                # Per-feed exception isolation (#4): a single feed whose operator
                # query_string / read fails must NOT abort the whole poll cycle and
                # freeze every other feed's cursor. On failure we log + skip THIS feed
                # only — it gets no feed_state entry, so its cursor is left untouched
                # while healthy feeds proceed and advance their own cursors. Mirrors the
                # whole-loop shield around poll_once in the run loop below.
                try:
                    key = self._cursor_key(prefs, feed.id)
                    fcursor = await self._cursor_store.load_keyed(key)
                    scan = await self._poll_feed_scan(prefs, feed, fcursor, cold_from)
                except Exception as exc:  # noqa: BLE001 — isolate one feed's failure
                    logger.exception(
                        "poll_feed failed for feed %s; skipping it this tick (cursor untouched)",
                        getattr(feed, "id", "?"),
                    )
                    # Record this feed's failure so the tick is reported ok=False below
                    # (silent-vs-broken fix) — the cursor stays untouched, healthy feeds
                    # proceed, and the events that DID arrive are still processed.
                    feed_failures.append((str(getattr(feed, "id", "?")), str(exc)))
                    continue
                fbatch = scan.events
                # Advance over the full scanned watermark, not just the kept batch (#4).
                # This happens for EVERY feed regardless of which path handles its events,
                # so an EVENT feed routed to the funnel still advances its own cursor and
                # never re-reads / skips (the never-skip invariant is path-independent).
                advanced = advance_cursor_to(
                    fcursor,
                    scan.scan_max_ts,
                    scan.scan_boundary_ids,
                    recent_event_millis=scan.scan_recent_event_millis,
                    overlap_backfill_complete=scan.overlap_backfill_complete,
                )
                feed_state.append((key, fcursor, advanced))
                fetched.extend(fbatch)
                feed_new = [e for e in fbatch if not fcursor.should_skip(e)]
                # EVENT-feed routing: a ``role=events`` feed's new events go to the
                # detection funnel only at/below ``batch.severity_floor``.  Higher
                # severity records stay synchronous; no event is dropped. ALERTS feeds
                # remain unchanged on the realtime path.
                if event_routing and self._feed_is_events_role(feed):
                    from ..engine.event_detection import split_batch_eligible_events

                    own_source = prefs.source_by_id(
                        getattr(self._source, "connector_id", None)
                    )
                    batch_new, sync_new = split_batch_eligible_events(
                        feed_new,
                        prefs,
                        severity_scale=severity_scale_for_source(own_source),
                    )
                    if batch_new:
                        funnel_feed_keys.add(key)
                        funnel_events.extend(batch_new)
                    if sync_new:
                        new_events.extend(sync_new)
                        if batch_new:
                            event_feed_sync_event_ids.update(id(ev) for ev in sync_new)
                else:
                    new_events.extend(feed_new)
        else:
            # Legacy / un-fed union path. The primary (or sole) source uses the legacy
            # ``"primary"`` cursor doc (byte-identical, no migration); a NON-primary
            # un-fed source under fan-out uses its OWN ``f"{source.id}:primary"`` key
            # (set by the PollerManager) so two un-fed sources never collide (#4).
            lkey = self._legacy_cursor_key
            cursor = (
                await self._cursor_store.load()
                if lkey == "primary"
                else await self._cursor_store.load_keyed(lkey)
            )
            scan = await self._poll_source_scan(prefs, cursor, cold_from)
            fetched = scan.events
            new_events = [e for e in fetched if not cursor.should_skip(e)]
            feed_state.append(
                (
                    lkey,
                    cursor,
                    advance_cursor_to(
                        cursor,
                        scan.scan_max_ts,
                        scan.scan_boundary_ids,
                        recent_event_millis=scan.scan_recent_event_millis,
                        overlap_backfill_complete=scan.overlap_backfill_complete,
                    ),
                )
            )

        stats = {"polled": len(fetched), "new": len(new_events),
                 "clusters": 0, "investigated": 0, "candidates": 0, "attached": 0,
                 "window_events": 0, "funnel_routed": 0}

        # Hand routed EVENT-feed events to the detection funnel.  ``None`` remains an
        # accepted return for backwards-compatible hooks; the production hook returns
        # True only after a durable local outbox write (or an explicit no-candidate
        # outcome).  A rejection/failure leaves every contributing feed cursor untouched
        # and suppresses same-feed synchronous work this tick so the whole feed retries
        # coherently without double-counting side effects.
        accepted_funnel_events: list[RawEvent] = []
        if funnel_events and self._event_funnel is not None:
            stats["funnel_routed"] = len(funnel_events)
            funnel_accepted = True
            try:
                outcome = await self._event_funnel(funnel_events, prefs)
                funnel_accepted = outcome is not False
            except Exception as exc:  # noqa: BLE001 — retry on the next poll
                funnel_accepted = False
                logger.warning("event-detection funnel routing failed: %s", exc)
                feed_failures.append(("event_funnel", str(exc)))
            if funnel_accepted:
                accepted_funnel_events = list(funnel_events)
            else:
                # Do not commit cursors for any feed whose async work was rejected.
                feed_state = [row for row in feed_state if row[0] not in funnel_feed_keys]
                # Higher-severity siblings from the same EVENT feed must retry with the
                # rejected low/medium work rather than create/count a partial tick.
                new_events = [
                    ev for ev in new_events if id(ev) not in event_feed_sync_event_ids
                ]
                stats["new"] = len(new_events)

        # Correlate over the FULL sliding look-back window (not just the incremental
        # batch) so real-time bursts spread across >1 poll interval still trigger.
        # The cursor read above is what advances the cursor & defines "new"; this is
        # a second, read-only window over the SAME in-scope log surface (#1, #12).
        # We only do the wider read when there is genuinely new activity, so a quiet
        # poll stays cheap and we never re-correlate an unchanged window.
        #
        # Round-7 Noise-Reduction counters (fail-open; never slows the poll path, #H W0.8):
        # the clustered/suppressed/ignored bands are computed INSIDE the ``if new_events:``
        # block below (where ``clusters``/``cluster_stats``/``own_source`` are in scope);
        # the ingested band + the sink invocation are ALWAYS-in-scope after it, so an
        # events-only / quiet tick can never UnboundLocalError on those block-locals.
        noise_clustered = zero_bands()
        noise_suppressed = 0
        noise_ignored = 0
        cluster_volumes: dict[str, int] = {}
        if new_events:
            from ..engine.correlation import correlate  # local import avoids cycle at import time

            lookback_ms = self._correlation_lookback_seconds(prefs) * 1000
            window_from = to_millis(now_utc()) - lookback_ms
            # Never look back further than a cold start would; the cursor still bounds
            # what is treated as new, so this only widens the correlation input.
            window_from = max(window_from, cold_from)
            window_cursor = Cursor(
                timestamp_millis=window_from,
                late_arrival_overlap_enabled=False,
            )
            window_fetched = await self._source.poll(prefs, window_cursor, window_from)
            window_events = dedup_by_id(window_fetched + new_events)
            # Round-4 Wave-4: the wider window read unions ALL feeds via ``source.poll`` —
            # so when EVENT-feed routing is active, drop the routed events-role feeds'
            # events from the realtime correlation input too (they were already handed to
            # the funnel above). ALERTS feed events are kept (they stay realtime). No-op
            # when routing is off → byte-identical window (the safety property).
            if event_routing:
                routed_ids = self._routed_events_feed_ids(feeds)
                if routed_ids:
                    from ..engine.event_detection import event_is_batch_eligible

                    window_events = [
                        e for e in window_events
                        if (
                            (getattr(e, "feed_id", "") or "") not in routed_ids
                            or not event_is_batch_eligible(e, prefs)
                        )
                    ]
            stats["window_events"] = len(window_events)

            # Honour THIS source's per-source entity strategy (entity-agnostic
            # correlation; default ``auto`` keeps today's behaviour byte-for-byte).
            # Round 4 fan-out: each per-source Poller resolves ITS OWN SourceInstance
            # from its connector_id (falling back to the primary/global strategy when
            # the connector has no matching configured source — the legacy single-poll
            # / implicit-source case, byte-identical to before).
            own_source = prefs.source_by_id(getattr(self._source, "connector_id", None))
            strategy = prefs.entity_strategy_for(own_source or prefs.primary_source())
            # Comprehensive ingestion (#1): the FEED ROLE is threaded into ``correlate``
            # PER EVENT — the connector stamps ``ev.index_role`` from each feed's role, so
            # this mixed multi-feed window keeps events-role events on the THRESHOLD path
            # while ALERTS-role events each form EXACTLY one cluster (mode EVERY). We pass no
            # single ``role`` here precisely because the window unions feeds of DIFFERENT
            # roles; correlate reads the per-event role. Same-signature bursts still coalesce
            # onto ONE open case downstream (#4).
            clusters = correlate(window_events, prefs, entity_strategy=strategy)
            # Only ACT ON clusters that contain at least one event that ARRIVED THIS
            # TICK. The wider look-back window supplies threshold CONTEXT (so a burst
            # spanning the window is still counted), but ``correlate`` also re-forms
            # clusters made ENTIRELY of old events whose case was already closed —
            # re-handling those creates a DUPLICATE case and re-spends the LLM on every
            # tick (audit #8). Mirror IngestService: filter to clusters intersecting this
            # tick's new-event keys. A cluster with a NEW event on a previously-closed
            # signature is kept (legitimately new activity). No-op when the window is
            # exactly this tick's new_events (byte-identical to before).
            _new_ids = {e.event_key() for e in new_events}
            tick_clusters = [
                cl for cl in clusters
                if _new_ids.intersection(cl.member_event_keys or cl.member_event_ids)
            ]
            # Attach/investigate/register is the SHARED ingest path (identical for
            # push receivers): see app/engine/ingest.handle_clusters.
            cluster_stats = await handle_clusters(
                tick_clusters, prefs, cases=self._cases, pipeline=self._pipeline,
                source_surface=SourceSurface.AUTOMATED_SCAN,
                query_source=self._source,
                investigation_budget=investigation_budget,
            )
            stats.update(cluster_stats)
            # Round-7: band THIS tick's clusters + record the drops, INSIDE the block where
            # ``clusters``/``cluster_stats``/``own_source`` are in scope. Only when a counter
            # sink is wired (byte-identical poll path otherwise); best-effort, never raises.
            if self._noise_sink is not None:
                try:
                    _sink_scale = severity_scale_for_source(own_source)
                    # Round-7 over-count fix (now also the audit-#8 handle filter): the noise
                    # bands are scoped to ``tick_clusters`` — the clusters containing at least
                    # one JUST-ARRIVED event (this tick's ``new_events``) — the SAME set handed
                    # to ``handle_clusters`` above, so clustered/suppressed/ignored stay per-tick
                    # deltas and never re-tally a straggler burst on later ticks. suppressed/
                    # ignored use the SAME predicates ``handle_clusters`` uses (ignored first).
                    cluster_volumes = {
                        str(cl.signature): int(cl.count)
                        for cl in tick_clusters
                        if getattr(cl, "signature", None)
                    }
                    noise_clustered = count_clusters_by_band(tick_clusters, _sink_scale)
                    _tick_ignored = 0
                    _tick_suppressed = 0
                    for _cl in tick_clusters:
                        if _is_ignored_cluster(_cl, prefs):
                            _tick_ignored += 1
                        elif not passes_suppression(_cl, prefs):
                            _tick_suppressed += 1
                    noise_suppressed = _tick_suppressed
                    noise_ignored = _tick_ignored
                except Exception:  # noqa: BLE001 — counters are advisory, never break a poll
                    pass
            # Opt-in cross-source correlation (Wave 5 / F6): link open cases sharing an
            # entity across sources as RELATED (never merged). No-op when disabled.
            if prefs.cross_source_correlation.enabled:
                from ..engine.ingest import link_cross_source

                try:
                    stats["cross_source_linked"] = await link_cross_source(
                        clusters, prefs, cases=self._cases
                    )
                except Exception as exc:  # noqa: BLE001 — never break the poll loop
                    logger.warning("cross-source correlation failed: %s", exc)

        # Round-7: ingested = ALL accepted new alerts this tick (new_events + durably
        # accepted funnel events),
        # banded by the source's declared severity scale. The source instance is re-resolved
        # SEPARATELY here (NOT the if-block-local ``own_source``) so this path is always in
        # scope — an events-only feed (new_events empty, funnel_events non-empty) still tallies
        # its ingested volume. Then fan the assembled delta to the noise sink UNCONDITIONALLY:
        # fail-open, using ONLY the pre-computed dict (never the if-block locals).
        if self._noise_sink is not None:
            noise_ingested = zero_bands()
            noise_scale_max = None
            try:
                _ns_source = prefs.source_by_id(getattr(self._source, "connector_id", None))
                noise_scale_max = severity_scale_for_source(_ns_source)
                noise_ingested = count_events_by_band(
                    new_events + accepted_funnel_events,
                    noise_scale_max,
                )
            except Exception:  # noqa: BLE001 — counters are advisory, never break a poll
                pass
            try:
                await self._noise_sink({
                    "ingested": noise_ingested,
                    "clustered": noise_clustered,
                    "suppressed": noise_suppressed,
                    "ignored": noise_ignored,
                    "cluster_volumes": cluster_volumes,
                    # Coverage observability (A5.4): thread THIS source's already-resolved
                    # identity onto the delta so the durable counters keep a per-source
                    # ``by_source`` breakdown AND the realtime baseline/silent-source clock
                    # (state._observe_tick_volume) can attribute the volume. Additive — a
                    # None source_id folds into the pooled totals only (byte-identical).
                    "source_id": getattr(self._source, "connector_id", None),
                    # The severity CEILING these bands were projected against. Stamped on
                    # the per-source sub-block ONLY, so a later reader can tell whether two
                    # windows' band splits describe one ladder — the tallies are bucketed
                    # by band at write time and can never be re-projected. None when it
                    # could not be resolved (the store then records "not provable").
                    "severity_scale_max": noise_scale_max,
                })
            except Exception as exc:  # noqa: BLE001 — the sink must never break a poll cycle
                logger.debug("noise-counter sink failed: %s", exc)

        # Persist EACH feed's advanced cursor durably + independently (#4 — a slow
        # feed's cursor is never dragged forward by a fast feed's events). The advanced
        # cursor was computed above from the FULL SCANNED watermark (kept + dropped),
        # so a broad feed never skips its own window when it drops a narrower feed's hits.
        for key, fcursor, new_cursor in feed_state:
            # Late arrivals can update only the bounded recent-id ledger while the
            # frontier timestamp/boundary stays unchanged.  Compare the full additive
            # cursor contract so that dedup state is durable across the next tick and
            # across restarts.
            if new_cursor != fcursor:
                await self._cursor_store.save_keyed(key, new_cursor)

        await self._audit.record(
            action_type=ActionType.POLL, surface="poller", actor="poller",
            source_id=(getattr(self._source, "connector_id", None) or None),
            result_summary=(f"polled={stats['polled']} new={stats['new']} "
                            f"clusters={stats['clusters']} investigated={stats['investigated']} "
                            f"candidates={stats['candidates']} attached={stats['attached']}"),
        )
        # Coverage observability (A5.1): record this tick's in-memory snapshot AFTER the
        # durable audit write, so the "last poll attempt" wall-clock + ok/error + events/min
        # rate are available to GET /api/sources/health without a schema change.
        #
        # B3 silent-vs-broken fix: if ANY feed failed this tick (a multi-feed source), record
        # ``ok=False`` + the accumulated per-feed error list — even though per-feed isolation
        # let healthy feeds proceed (partial success still recorded the events that arrived).
        # A multi-feed source where EVERY feed raised is now visibly ``ok=False`` instead of a
        # misleading ``ok=True``. The un-fed / single-cursor path never populates
        # ``feed_failures`` → byte-identical ``ok=True``. The error string is source-controlled
        # connector text, rendered PLAIN by the health surface (#9).
        if feed_failures:
            tick_error = "; ".join(f"{fid}: {err}" for fid, err in feed_failures)
            self.record_tick(ok=False, error=tick_error, stats=stats)
        else:
            self.record_tick(ok=True, error=None, stats=stats)
        return stats

    async def _attach(self, existing, cluster) -> None:
        """Merge a cluster's new events into an open case (shared ingest logic)."""
        await attach_cluster(self._cases, existing, cluster)

    # --- background loop ---
    async def _run(self) -> None:
        self._running = True
        logger.info("Poller loop started")
        while self._running:
            prefs = self._get_prefs()
            interval = max(5, prefs.poll_interval_seconds)
            # Demo Mode (Wave 5): while demo is engaged the REAL poll is GATED here —
            # BEFORE source.poll — so the durable cursor (#4) is never advanced while
            # synthetic data is being showcased. The demo telemetry flows through the
            # SEPARATE DemoSimulator into the demo store instead.
            demo_active = bool(getattr(getattr(prefs, "demo", None), "active", False))
            if (
                prefs.polling_enabled and prefs.setup_complete
                and not prefs.caps.kill_switch and not demo_active
            ):
                try:
                    await self.poll_once(prefs)
                except Exception as exc:  # noqa: BLE001 — the loop must never die
                    logger.exception("poll_once failed (loop continues): %s", exc)
            await asyncio.sleep(interval)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
