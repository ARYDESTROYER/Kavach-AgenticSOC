"""Multi-source poller fan-out (Round 4 #2/#3 root-cause fix).

Historically ``AppState`` wired ONE :class:`~app.engine.poller.Poller` to the single
``primary`` PULL source, so every other enabled PULL source was silently never
polled / correlated / triaged. :class:`PollerManager` fixes that by owning **N**
per-source :class:`Poller` children — one per enabled PULL source — while preserving
byte-identical single-source behaviour when 0 or 1 PULL source is configured.

Design (the fan-out + cursor-collision contract):
  * The PRIMARY child IS ``state.log_source`` (the connector ``state`` already built
    + owns, via ``_owned_log_client``). The manager never rebuilds it and never owns
    its client — so the sole-source path is byte-identical and the read/browse/chat
    surface (``state.log_source``) stays the primary connector.
  * NON-primary PULL sources get their OWN connector built exactly like
    ``state._build_log_source`` — ``state.es_client_for_source(src)`` (which forces the
    mgmt key to None, #1) + ``connector_id=src.id`` (so per-source
    auto_correlate/ignore/severity_floor gates work) — and every OWNED client is
    tracked + closed on rebuild/stop (no connection leak over N sources).
  * Each :class:`Poller` already fans out over its own feeds on
    ``f"{source.id}:{feed.id}"`` cursors. For an UN-FED source (only
    ``data_view_pattern``) the legacy union path keys the cursor ``"primary"`` — so
    the manager gives every NON-primary un-fed source a DISTINCT
    ``f"{source.id}:primary"`` key (via ``Poller._legacy_cursor_key``) while the true
    primary keeps ``"primary"`` (no migration, #4).
  * Children SHARE ``state``'s ONE pipeline/gateway/cases/audit/cursor_store (#6) —
    the manager never mints a per-source gateway or pipeline.
  * All children are gated on the SAME flags ``Poller._run`` checks
    (polling_enabled / setup_complete / not kill_switch / not demo_active); a burst of
    sources is bounded by ``caps.max_concurrent``; a per-cluster-signature in-flight
    guard stops the same signature being investigated twice in one tick.

The manager IS ``state.poller`` and proxies the external lifecycle contract
(``start()`` / ``stop()`` / ``poll_once(prefs)`` / ``_source`` / ``_attach``) to the
primary child (or, for ``poll_once``, aggregates across all children).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import Any, Callable, Protocol, runtime_checkable

from ..config import Preferences
from ..connectors.base import PullConnector
from ..constants import IngestMode
from ..engine.poller import Poller
from ..engine.ingest import InvestigationBudget
from ..utils import iso_now

logger = logging.getLogger("tlsoc.engine.poller_manager")


@runtime_checkable
class PollerHost(Protocol):
    """The NARROW slice of :class:`app.state.AppState` the multi-source poller needs.

    Round 5 (Coupling-F / G8): the manager used to take the WHOLE ``AppState`` and reach
    into its ``_real_*`` privates. It now depends only on this documented seam — the
    public REAL-collaborator accessors (``real_cases``/``real_audit``/``real_pipeline``),
    the shared ``es``/``cursor_store``/``get_prefs``, the primary ``log_source``, the
    per-source client builder, and ``schedule_close``. Structural typing means
    ``AppState`` satisfies it with ZERO changes at the call site, and a test can hand the
    manager a tiny fake host. Behaviour is byte-identical (same objects, narrower type).
    """

    es: Any
    cursor_store: Any
    log_source: Any

    def get_prefs(self) -> Preferences: ...
    def es_client_for_source(self, src: Any) -> tuple[Any, bool]: ...
    def schedule_close(self, client: Any) -> None: ...
    async def cluster_for_case(self, case: Any) -> Any: ...

    @property
    def real_cases(self) -> Any: ...
    @property
    def real_audit(self) -> Any: ...
    @property
    def real_pipeline(self) -> Any: ...

# Numeric stats keys aggregated (summed) across per-source pollers into one dict.
_SUM_KEYS = (
    "polled", "new", "clusters", "investigated", "candidates", "attached",
    "window_events", "cross_source_linked", "drained",
)


class PollerManager:
    """Owns N per-source :class:`Poller` children and drives them as one poller."""

    def __init__(self, state: PollerHost) -> None:
        self._state = state
        self._get_prefs: Callable[[], Preferences] = state.get_prefs
        # The primary child (built from state.log_source) + the non-primary children.
        # The primary is rebuilt implicitly by state.rebuild_log_source (which re-points
        # ``primary._source``); the non-primary set is rebuilt by ``rebuild()``.
        # Round-4 Wave-4 EVENT-feed funnel hook. State wires the MANAGER-level reference
        # here (``manager._event_funnel = state._route_event_feed``); ``rebuild()`` /
        # ``_build_child_for`` then PROPAGATE it to EVERY child (primary + non-primary) so
        # an events-role feed on ANY source routes to the funnel — not just the primary
        # (finding #7). Default None → no routing (byte-identical realtime path). Set
        # before ``rebuild()`` so the first build already fans it out. (H1 owns the
        # manager-level reference contract via state.py; we share the ``_event_funnel``
        # attribute name.)
        self._event_funnel: Callable | None = None
        # Round-7 Noise-Reduction counter sink. A SEPARATE hook from ``_event_funnel``
        # (P0 name-collision avoidance). State wires it via ``set_noise_sink`` after
        # construction; ``rebuild()`` / the child builders PROPAGATE it to EVERY child so
        # an events-only or quiet tick on ANY source records its raw-alert-by-severity
        # tally. Default None → no counters (byte-identical poll path); advisory only (#3).
        self._noise_sink: Callable | None = None
        self._primary: Poller = self._build_primary()
        self._children: list[Poller] = []
        # ES clients this manager OWNS (non-primary sources with per-source overrides).
        # Closed on rebuild()/stop(); the primary's owned client is owned by state.
        self._owned_clients: list = []
        self._task: asyncio.Task | None = None
        self._running = False
        # Serialize whole fan-out ticks per manager (finding #6/#15). The scheduler loop
        # and a manual ``POST /api/poll`` share this ONE lock so only one fan-out tick
        # runs at a time — a manual poll waits for the loop tick (single-poller sequential
        # semantics), which also closes the finding-#5 duplicate-case window between two
        # overlapping ticks. Per-signature locking (in the pipeline) still guards
        # concurrency WITHIN a tick across sources; this guards concurrency ACROSS ticks.
        self._poll_lock = asyncio.Lock()
        self.rebuild()

    # ------------------------------------------------------------------ #
    # External compatibility surface (mirrors the single Poller contract).
    # ------------------------------------------------------------------ #
    @property
    def _source(self):
        """The PRIMARY connector — kept for callers that read ``poller._source``."""
        return self._primary._source

    @_source.setter
    def _source(self, value) -> None:
        # state.rebuild_log_source assigns ``poller._source = self.log_source`` — route
        # that onto the primary child so the read/browse surface stays consistent.
        self._primary._source = value

    async def _attach(self, existing, cluster) -> None:
        """Proxy the attach helper (used by tests + adjacent code) to the primary."""
        await self._primary._attach(existing, cluster)

    # ------------------------------------------------------------------ #
    # Construction / rebuild.
    # ------------------------------------------------------------------ #
    def _build_primary(self) -> Poller:
        """The primary child wraps ``state.log_source`` (state owns its client)."""
        st = self._state
        child = Poller(
            st.es, st.real_cases, st.cursor_store, st.real_audit,
            st.real_pipeline, st.get_prefs, source=st.log_source,
        )
        # Propagate the manager-level EVENT-feed funnel hook (finding #7). ``__init__``
        # sets ``self._event_funnel`` before this runs; ``rebuild()`` re-propagates.
        child._event_funnel = getattr(self, "_event_funnel", None)
        # Round-7: propagate the Noise-Reduction counter sink too (SEPARATE hook).
        child._noise_sink = getattr(self, "_noise_sink", None)
        return child

    def _pull_sources(self, prefs: Preferences) -> list:
        """Every enabled PULL source (registry class check is authoritative; also honor
        the config-declared ``ingest_mode==PULL``). Receivers are SKIPPED — they stay
        handled by ``state._start_receivers`` (never double-handled)."""
        from ..connectors.registry import get_registry

        reg = get_registry()
        out: list = []
        for src in prefs.sources:
            if not src.enabled:
                continue
            if reg.is_receiver(src.source_type):
                continue  # PUSH — handled by _start_receivers, never here
            is_pull = reg.is_pull(src.source_type) or (src.ingest_mode == IngestMode.PULL)
            if is_pull:
                out.append(src)
        return out

    def _build_child_for(self, src) -> Poller | None:
        """Build a NON-primary per-source Poller exactly like ``state._build_log_source``
        (per-source client via ``es_client_for_source`` — forces mgmt key None, #1 — +
        ``connector_id=src.id``). Tracks any OWNED client for close. Returns None on a
        build failure (isolated + logged, mirroring ``_start_receivers``)."""
        from ..connectors.elastic import ElasticConnector
        from ..connectors.opensearch import OpenSearchConnector
        from ..connectors.wazuh import WazuhConnector
        from ..constants import SourceType

        st = self._state
        es_client, owned = st.es_client_for_source(src)
        if owned:
            self._owned_clients.append(es_client)
        cfg = {**(src.config or {})}
        if src.display_name:
            cfg.setdefault("display_name", src.display_name)
        cid = src.id
        if src.source_type == SourceType.OPENSEARCH:
            connector = OpenSearchConnector(es_client, config=cfg, connector_id=cid)
        elif src.source_type == SourceType.WAZUH:
            connector = WazuhConnector(es_client, config=cfg, connector_id=cid)
        else:
            connector = ElasticConnector(es_client, config=cfg, connector_id=cid)
        child = Poller(
            es_client, st.real_cases, st.cursor_store, st.real_audit,
            st.real_pipeline, st.get_prefs, source=connector,
        )
        # Propagate the manager-level EVENT-feed funnel hook to this NON-primary child
        # too (finding #7) so an events-role feed on a non-primary source also routes to
        # the funnel when routing is enabled — previously only the primary was wired.
        child._event_funnel = getattr(self, "_event_funnel", None)
        # Round-7: propagate the Noise-Reduction counter sink too (SEPARATE hook) so a
        # non-primary source records its raw-alert tally exactly like the primary.
        child._noise_sink = getattr(self, "_noise_sink", None)
        # Un-fed (no feeds) non-primary source → legacy union path would key the cursor
        # ``"primary"`` and stomp the shared doc. Give it a DISTINCT key (#4).
        if not _connector_has_feeds(connector):
            child._legacy_cursor_key = f"{src.id}:primary"
        return child

    def rebuild(self) -> None:
        """(Re)build the NON-primary children from the CURRENT prefs. Closes any
        previously-owned clients first (no leak). The primary child is left to
        ``state.rebuild_log_source`` (it re-points ``_source``); we rebuild it here too
        so ``self._state.log_source`` is always the live primary connector."""
        # FINDING #7 + H1 contract: the canonical EVENT-feed funnel reference is the one
        # STATE last assigned onto ``_primary._event_funnel`` (state._wire() sets it at
        # boot, before this method ever runs). Capture that LIVE hook off the current
        # primary BEFORE we mint a fresh one, mirror it to the manager-level
        # ``self._event_funnel``, then fan it out to every child below — so an events-role
        # feed on ANY source (not just the primary) routes to the funnel. If the manager
        # already has a non-None hook (set via ``set_event_funnel``), keep that.
        live = getattr(self, "_event_funnel", None)
        if live is None:
            live = getattr(getattr(self, "_primary", None), "_event_funnel", None)
        self._event_funnel = live
        # Close previously-owned non-primary clients.
        self._close_owned()
        self._primary = self._build_primary()
        self._children = []
        prefs = self._get_prefs()
        pull = self._pull_sources(prefs)
        # The primary source (if any) is already served by ``self._primary`` — skip it
        # in the non-primary fan-out so the same physical index is never double-polled.
        primary_src = prefs.primary_source()
        primary_id = getattr(primary_src, "id", None)
        for src in pull:
            if primary_id is not None and src.id == primary_id:
                continue
            try:
                child = self._build_child_for(src)
                if child is not None:
                    self._children.append(child)
            except Exception as exc:  # noqa: BLE001 — one bad source must not break fan-out
                logger.error("Could not build poller for source %s (%s): %s",
                             getattr(src, "id", "?"), getattr(src, "source_type", "?"), exc)
        # Re-propagate the manager-level EVENT-feed funnel hook onto EVERY child (#7).
        # The individual builders already set it, but ``_event_funnel`` may have been
        # (re)assigned on the manager after construction; this guarantees a rebuild leaves
        # every child carrying the current hook (or None when routing is off).
        self._propagate_funnel()
        # Round-7: re-propagate the Noise-Reduction counter sink onto every child too. The
        # manager-level ``_noise_sink`` survives a rebuild (state wires it once via
        # ``set_noise_sink``), so a source edit keeps counters wired on every child.
        self._propagate_noise_sink()

    def set_noise_sink(self, sink: Callable | None) -> None:
        """Set the manager-level Noise-Reduction counter sink + fan it out to every child.

        State calls this once after construction to wire the durable counter store's
        ``record``. Storing it on the manager — not only on the primary — is what lets an
        events-only / quiet tick on ANY source record its raw-alert-by-severity tally. A
        SEPARATE hook from ``set_event_funnel`` (P0 name-collision avoidance)."""
        self._noise_sink = sink
        self._propagate_noise_sink()

    def _propagate_noise_sink(self) -> None:
        """Copy the manager-level ``_noise_sink`` onto every child (primary + non-primary).
        Best-effort; a missing attribute only means counters stay off."""
        sink = getattr(self, "_noise_sink", None)
        for p in self._all_pollers():
            try:
                p._noise_sink = sink
            except Exception:  # noqa: BLE001 — never break a rebuild on this
                pass

    def set_event_funnel(self, funnel: Callable | None) -> None:
        """Set the manager-level EVENT-feed funnel hook + fan it out to every child (#7).

        State calls this (or assigns ``manager._event_funnel`` then ``rebuild()``s) to
        wire the detection funnel. Storing it here — not only on the primary — is what
        lets an events-role feed on ANY source route to the funnel."""
        self._event_funnel = funnel
        self._propagate_funnel()

    def _propagate_funnel(self) -> None:
        """Copy the manager-level ``_event_funnel`` onto every child (primary + non-
        primary). Best-effort; a missing attribute only means routing stays off."""
        funnel = getattr(self, "_event_funnel", None)
        for p in self._all_pollers():
            try:
                p._event_funnel = funnel
            except Exception:  # noqa: BLE001 — never break a rebuild on this
                pass

    def _all_pollers(self) -> list[Poller]:
        return [self._primary, *self._children]

    def source_for_id(self, source_id: str | None) -> PullConnector | None:
        """Return the live PULL connector for ``source_id`` (or ``None``).

        Manual/re-investigation paths use the same connector objects as the pollers,
        so their evidence reads and the investigator's ``es_query`` tool cannot fall
        back to a different tenant/source. Push-only sources intentionally return
        ``None`` because they have no upstream query surface.
        """
        if not source_id:
            return None
        from ..connectors.registry import get_registry

        configured = self._get_prefs().source_by_id(source_id)
        if configured is None or get_registry().is_receiver(configured.source_type):
            return None
        for poller in self._all_pollers():
            source = getattr(poller, "_source", None)
            if getattr(source, "connector_id", None) == source_id:
                return source
        return None

    @staticmethod
    def _safe_record_fail(p: Poller, exc: Exception) -> None:
        """Record a failed-tick snapshot on a child (A5.1); never raises on the error path."""
        try:
            p.record_tick(ok=False, error=str(exc), stats=None)
        except Exception:  # noqa: BLE001 — observability must never mask the real error
            pass

    def last_tick_by_source(self) -> dict[str, Any]:
        """Per-source IN-MEMORY "last tick" snapshot (coverage observability, A5.1).

        Keyed by each child's ``connector_id`` → ``{ts, ok, error, stats, events_per_min}``
        (or ``None`` when a source has not ticked yet this process). Read-only, in-memory
        (resets on restart); advisory presentation state only — never feeds ``decide()``
        (#3). Sources sharing no connector_id (the un-configured default) are skipped."""
        out: dict[str, Any] = {}
        for p in self._all_pollers():
            cid = getattr(getattr(p, "_source", None), "connector_id", None)
            if not cid:
                continue
            out[str(cid)] = getattr(p, "_last_tick", None)
        return out

    def _close_owned(self) -> None:
        for client in self._owned_clients:
            try:
                if client is not self._state.es:
                    self._state.schedule_close(client)
            except Exception:  # noqa: BLE001
                pass
        self._owned_clients = []

    # ------------------------------------------------------------------ #
    # Polling.
    # ------------------------------------------------------------------ #
    async def poll_once(self, prefs: Preferences | None = None) -> dict[str, Any]:
        """Fan out ONE poll cycle across every per-source poller and aggregate the
        stats into a single dict (same shape a single Poller returns). Each source is
        isolated (one failure is logged + skipped, never aborting the others). A
        fan-out semaphore bounds concurrency (``caps.max_concurrent``).

        The WHOLE tick is serialized by ``self._poll_lock`` (finding #6/#15): the
        scheduler loop and a manual ``POST /api/poll`` share this ONE lock, so only one
        fan-out tick runs at a time and a manual poll waits for the loop tick — the same
        sequential semantics the single Poller had. Duplicate-case safety WITHIN a tick
        (two sources, same signature) is enforced by the pipeline's per-signature locks,
        not by mutating the shared pipeline (the old monkeypatch guard was removed)."""
        prefs = prefs or self._get_prefs()
        async with self._poll_lock:
            return await self._poll_once_locked(prefs)

    async def _poll_once_locked(self, prefs: Preferences) -> dict[str, Any]:
        tick_started_at = iso_now()
        pollers = self._all_pollers()
        cap = max(1, int(getattr(prefs.caps, "max_auto_investigations_per_tick", 25)))
        budget = InvestigationBudget(cap)

        async def _poll_with_budget(p: Poller) -> dict[str, Any]:
            # Preserve compatibility with a third-party/test Poller implementation that
            # predates the additive shared-budget kwarg. Built-in Poller always accepts it.
            params = inspect.signature(p.poll_once).parameters
            if "investigation_budget" in params:
                return await p.poll_once(prefs, investigation_budget=budget)
            return await p.poll_once(prefs)
        # Single-poll fast path: 0/1 poller behaves BYTE-IDENTICALLY to the old single
        # Poller (no semaphore overhead, same return object). Coverage observability
        # (A5.1): on a raise, record the failed-tick snapshot (ok:False) BEFORE re-raising
        # so a broken single source is still visible on /api/sources/health — the success
        # path already records its snapshot inside ``poll_once``.
        if len(pollers) <= 1:
            try:
                result = await _poll_with_budget(self._primary)
                # Built-in Poller claims the shared allowance. Keep the result-count
                # fallback for compatible third-party implementations that ignore it.
                remaining = max(
                    0,
                    cap - max(budget.claimed, int(result.get("investigated", 0) or 0)),
                )
                result["drained"] = await self._drain_deferred(
                    prefs, older_than=tick_started_at, limit=remaining
                )
                return result
            except Exception as exc:  # noqa: BLE001 — capture then propagate (loop shields)
                self._safe_record_fail(self._primary, exc)
                raise

        limit = max(1, int(getattr(prefs.caps, "max_concurrent", 3)))
        sem = asyncio.Semaphore(limit)

        async def _run_one(p: Poller) -> dict[str, Any] | None:
            async with sem:
                try:
                    return await _poll_with_budget(p)
                except Exception as exc:  # noqa: BLE001 — isolate one source's failure
                    logger.exception(
                        "poll_once failed for source %s (fan-out continues): %s",
                        getattr(getattr(p, "_source", None), "connector_id", "?"), exc,
                    )
                    # Coverage observability (A5.1): a broken connector no longer fails
                    # SILENTLY — capture ok:False + the error on the child so its
                    # /api/sources/health row shows the failure (silent-vs-broken fix).
                    self._safe_record_fail(p, exc)
                    return None

        results = await asyncio.gather(*[_run_one(p) for p in pollers])

        agg: dict[str, Any] = {k: 0 for k in _SUM_KEYS}
        for res in results:
            if not res:
                continue
            for k in _SUM_KEYS:
                if k in res:
                    agg[k] = agg.get(k, 0) + res[k]
        # This is ONE global tick allowance, not one cap per source. Built-in pollers claim
        # it atomically; result totals retain a conservative fallback for extension pollers.
        reported = sum(int((res or {}).get("investigated", 0) or 0) for res in results)
        total_headroom = max(0, cap - max(budget.claimed, reported))
        agg["drained"] = await self._drain_deferred(
            prefs,
            older_than=tick_started_at,
            limit=total_headroom,
        )
        return agg

    async def _drain_deferred(
        self,
        prefs: Preferences,
        *,
        older_than: str,
        limit: int,
    ) -> int:
        """Investigate durable cap-deferred candidates even on a quiet next tick.

        The case document is the queue: no in-memory-only pending list is required,
        so restart does not strand overflow. Candidates deferred for policy/risk
        reasons are intentionally excluded. ``limit`` is the unused allowance from
        normal handling in this manager tick, never a second independent cap.
        """
        if not prefs.background_scan_enabled or prefs.caps.kill_switch or limit <= 0:
            return 0
        from ..constants import DecisionBy
        from ..stores.base import is_deferred_candidate

        # Round 16 B11: ask the store for the deferred queue itself (one query on the
        # bundled stores) instead of paging every OPEN case from offset 0 each tick,
        # which stopped at the first 10,000 on a real cluster and skipped rows that
        # shifted while it paged. Twice the allowance (at least 50) is read so a
        # candidate that cannot be rebuilt, or that a person owns, never blocks the
        # ones behind it.
        candidates = await self._state.real_cases.list_deferred_candidates(
            older_than=older_than, limit=max(50, 2 * limit),
        )
        drained = 0
        for case in candidates:
            if drained >= limit:
                break
            # The shared rule again, for a third-party store's answer: OPEN, no
            # verdict, cap-deferred, and not deferred in this tick (preserve the cap).
            if not is_deferred_candidate(case, older_than=older_than):
                continue
            # A candidate a person acted on is theirs (B05): never drained.
            if case.decision_by == DecisionBy.ANALYST:
                continue
            try:
                cluster = await self._state.cluster_for_case(case)
            except Exception as exc:  # noqa: BLE001 - skip; never block the rest
                logger.warning(
                    "Deferred candidate %s could not be rebuilt; skipped this tick: %s",
                    case.case_id, exc,
                )
                continue
            if cluster is None:
                continue
            query_source = self.source_for_id(case.source_id)
            await self._state.real_pipeline.investigate_cluster(
                cluster,
                case.source_surface,
                prefs,
                query_source=query_source,
            )
            drained += 1
        return drained

    # ------------------------------------------------------------------ #
    # Background loop (gated exactly like Poller._run).
    # ------------------------------------------------------------------ #
    async def _run(self) -> None:
        self._running = True
        logger.info("PollerManager loop started")
        while self._running:
            prefs = self._get_prefs()
            interval = max(5, prefs.poll_interval_seconds)
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
        self._close_owned()


def _connector_has_feeds(connector) -> bool:
    """True when the connector exposes any (enabled, non-ignore) feed — i.e. it takes
    the per-feed cursor path, not the legacy union path. Defensive: never raises."""
    getter = getattr(connector, "feeds", None)
    if getter is None:
        return False
    try:
        return bool(list(getter()))
    except Exception:  # noqa: BLE001
        return False
