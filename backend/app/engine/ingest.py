"""Shared ingest path — correlate normalised events into cases.

Both the poller (PULL) and the push receivers (webhook/syslog/queues/…) produce
batches of normalised :class:`RawEvent`. From there the handling is IDENTICAL:
correlate into clusters, drop suppressed clusters, then for each cluster either
attach to an open case (idempotent), auto-investigate (if its rule is on the
allowlist), or register a candidate. Centralising it here guarantees push and
pull ingestion behave the same and never drop an event.
"""

from __future__ import annotations

import asyncio
import collections
import logging
from typing import TYPE_CHECKING, Any, Callable

from ..config import Preferences
from ..constants import OPEN_CASE_STATUSES, ActionType, IndexRole, SourceSurface
from ..engine.cost_gate import passes_suppression
from ..engine.signatures import find_open_case_for_cluster
from ..models import Cluster, RawEvent
from ..ocsf import source_scoped_event_uid
from ..utils import iso_now, now_utc, to_millis

if TYPE_CHECKING:  # avoid import cycles (these import connectors/agents)
    from ..audit.audit_log import AuditLogger
    from ..agents.pipeline import InvestigationPipeline
    from ..connectors.base import PullConnector
    from ..stores.cases import CaseStore

logger = logging.getLogger("tlsoc.engine.ingest")


class IngestBatchError(RuntimeError):
    """Retryable failure raised when a pushed batch was not safely processed.

    Receiver transports use this exception boundary to withhold their external
    acknowledgement/checkpoint.  That gives webhook senders and durable brokers an
    honest at-least-once contract: a failed case/candidate persistence operation is
    retried instead of being reported as accepted.  A durable local receipt/outbox is
    still required before the service can acknowledge independently of downstream
    processing; until then, callers must retry the complete batch.
    """


class InvestigationBudget:
    """One concurrency-safe automated-investigation allowance for a manager tick.

    A multi-source poll fans out concurrently, so a plain per-child integer cap lets N
    sources each spend the full allowance. This small in-process coordinator makes the
    configured ceiling global to the whole fan-out tick. It is routing-only and never
    changes risk scoring or deterministic case decisions.
    """

    def __init__(self, limit: int) -> None:
        self.limit = max(0, int(limit))
        self._claimed = 0
        self._lock = asyncio.Lock()

    @property
    def claimed(self) -> int:
        return self._claimed

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self._claimed)

    async def try_claim(self) -> bool:
        async with self._lock:
            if self._claimed >= self.limit:
                return False
            self._claimed += 1
            return True


def _push_source_role(src) -> str:
    """The role a PUSH source declares for its events ("alerts"/"events"/"ignore").

    A push source has no per-document index, so it is declared wholesale: either
    ``config["role"] = "alerts"|"ignore"`` or an ``index_patterns`` list whose entries
    are ALL one role. Anything else (incl. no source) is treated as ``events`` — full
    back-compat with today's correlate→allowlist behaviour. ``ignore`` mutes the source
    entirely (its events are dropped at ingest)."""
    if src is None:
        return "events"
    cfg = getattr(src, "config", None) or {}
    declared = str(cfg.get("role") or "").lower()
    if declared in ("alerts", "ignore"):
        return declared
    try:
        feeds = src.feeds()
    except Exception:  # noqa: BLE001
        feeds = []
    if feeds and all(f.role.value == "ignore" for f in feeds):
        return "ignore"
    if feeds and all(f.role.value == "alerts" for f in feeds):
        return "alerts"
    return "events"


def dedup_by_id(events: list[RawEvent]) -> list[RawEvent]:
    """De-dupe events by source-index-qualified identity. First wins."""
    seen: dict[str, RawEvent] = {}
    for ev in events:
        key = ev.event_key()
        if key not in seen:
            seen[key] = ev
    return list(seen.values())


def ensure_push_event_ids(
    events: list[RawEvent], source_id: str | None = None
) -> list[RawEvent]:
    """Enforce stable, source-scoped ids before push-batch de-duplication.

    Receivers already emit ids in this form.  The ingest boundary repeats the
    invariant for custom/third-party receivers and direct API integrations.  The
    helper is idempotent for an id already scoped to the same source.
    """
    for ordinal, event in enumerate(events):
        scope = event.source_id or source_id
        if scope:
            event.id = source_scoped_event_uid(
                scope,
                native_uid=event.id or None,
                record=event.source,
                ordinal=ordinal,
            )
        elif not event.id:
            # Back-compatible unconfigured receiver fallback: never collapse all
            # empty ids, while keeping retry identity deterministic for the same
            # batch order.
            event.id = source_scoped_event_uid(
                event.index or "unscoped-push",
                record=event.source,
                ordinal=ordinal,
            )
    return events


def _auto_correlate_allowed(cluster: Cluster, prefs: Preferences) -> bool:
    """The per-source + per-FEED "Auto-Correlate" gate (Wave 5 / F6 + Wave 6).

    A cluster may auto-forward to investigation ONLY when BOTH its SOURCE and EVERY
    matched FEED allow it. All toggles default TRUE so, out of the box, this returns
    True for every cluster and the auto-forward decision is byte-identical to before.

    Resolution:
      * Source level — ``SourceInstance.auto_correlate()`` (config["auto_correlate"]).
      * Feed level — for each configured feed an in-scope member event belongs to, the
        feed's ``effective_auto_investigate()`` must be True. That derives from the
        feed's role + ``correlate`` + the explicit ``auto_investigate`` override
        (None → ``role=='alerts' or legacy auto_correlate``), so a legacy
        ``{pattern, role, auto_correlate}`` config yields the SAME decision and a feed
        with ``auto_investigate=False`` is routed to a candidate (manual triage).
        Matched by ``feed_id`` (the connector tags it) with a fallback to a
        longest-pattern ``_index`` match for un-tagged events.

    When the source declares no feeds (legacy / push sources without patterns) the
    feed check is a no-op (True). A cluster with no resolvable source (the legacy
    implicit single source) always returns True — nothing changes by default."""
    source_id = cluster.source_id
    if not source_id:
        return True
    src = next((s for s in prefs.sources if s.id == source_id), None)
    if src is None:
        return True
    if not src.auto_correlate():
        return False
    feeds = src.feeds()
    if not feeds:
        return True
    import fnmatch

    by_id = {f.id: f for f in feeds}
    for ev in cluster.member_events:
        feed = by_id.get(ev.feed_id) if ev.feed_id else None
        if feed is None:
            # Un-tagged event (e.g. push/legacy): longest-pattern ``_index`` match.
            idx = ev.index or ""
            best = None
            best_len = -1
            for f in feeds:
                if f.pattern and idx and fnmatch.fnmatch(idx, f.pattern) and len(f.pattern) > best_len:
                    best, best_len = f, len(f.pattern)
            feed = best
        if feed is not None and not feed.effective_auto_investigate():
            return False
    return True


def _is_ignored_cluster(cluster: Cluster, prefs: Preferences) -> bool:
    """True when EVERY in-scope member event belongs to an IGNORE feed (Wave 6).

    An IGNORE feed is a per-feed MUTE: its events are dropped entirely at ingest (the
    PULL connector never reads them; this is the defence-in-depth drop for any event
    that still arrives — e.g. via a PUSH source declaring an ignore feed). It is the
    ONLY role that drops; a below-``severity_floor`` event on an events/alerts feed is
    NEVER dropped here (it registers a candidate + live-tail, #4). Returns False when
    the source has no IGNORE feed (the default) so behaviour is byte-identical."""
    source_id = cluster.source_id
    if not source_id:
        return False
    src = next((s for s in prefs.sources if s.id == source_id), None)
    if src is None:
        return False
    feeds = src.feeds()
    ignore_feeds = [f for f in feeds if f.role == IndexRole.IGNORE]
    if not ignore_feeds:
        return False
    import fnmatch

    by_id = {f.id: f for f in feeds}
    members = cluster.member_events or []
    if not members:
        return False
    for ev in members:
        feed = by_id.get(ev.feed_id) if ev.feed_id else None
        if feed is None:
            idx = ev.index or ""
            best = None
            best_len = -1
            for f in feeds:
                if f.pattern and idx and fnmatch.fnmatch(idx, f.pattern) and len(f.pattern) > best_len:
                    best, best_len = f, len(f.pattern)
            feed = best
        # Any non-ignore member means the cluster is NOT fully muted (never dropped).
        if feed is None or feed.role != IndexRole.IGNORE:
            return False
    return True


async def attach_cluster(cases: "CaseStore", existing, cluster: Cluster) -> bool:
    """Merge a cluster's new events into an open case. Idempotent; returns True iff
    something new was attached."""
    prior_keys = list(existing.member_event_keys or existing.member_event_ids)
    incoming_keys = list(cluster.member_event_keys or cluster.member_event_ids)
    if existing.member_event_keys:
        prior_key_set = set(prior_keys)
        new_keys = [key for key in incoming_keys if key not in prior_key_set]
    else:
        # Upgrade compatibility: a pre-key case only knows native ids. Do not
        # replay those members merely because the new representation is qualified.
        prior_ids = set(existing.member_event_ids)
        new_keys = [
            key
            for key, event_id in zip(incoming_keys, cluster.member_event_ids)
            if event_id not in prior_ids
        ]
    merged_keys = list(dict.fromkeys(prior_keys + new_keys))
    before = len(prior_keys)
    if len(merged_keys) == before:
        return False  # nothing new
    existing.member_event_keys = merged_keys
    existing.member_event_ids = list(dict.fromkeys(
        existing.member_event_ids + cluster.member_event_ids
    ))
    # An open pre-source-scoping case migrates in place on its first new event.
    existing.cluster_signature = cluster.signature
    existing.source_id = cluster.source_id or existing.source_id
    existing.source_name = cluster.source_name or existing.source_name
    existing.updated_at = iso_now()
    existing.rule_ids = sorted(set(existing.rule_ids) | set(cluster.rule_values))
    existing.history.append({"ts": existing.updated_at, "event": "attach",
                             "added_events": len(merged_keys) - before})
    # Carry a deterministic "why this fired" reason onto a case that lacks one
    # (e.g. a manually-opened case an automated burst now attaches to) — without
    # overwriting a reason it already has.
    if existing.trigger_reason is None and cluster.trigger_reason is not None:
        existing.trigger_reason = cluster.trigger_reason
    await cases.save(existing)
    return True


async def handle_clusters(
    clusters: list[Cluster],
    prefs: Preferences,
    *,
    cases: "CaseStore",
    pipeline: "InvestigationPipeline",
    source_surface: SourceSurface,
    query_source: "PullConnector | None" = None,
    investigation_budget: InvestigationBudget | None = None,
) -> dict[str, int]:
    """Attach / investigate / register each cluster. Returns count stats.

    The per-cluster ``find_open_by_signature → (attach | investigate | register)``
    critical section is serialized PER SIGNATURE via the shared pipeline lock
    (``pipeline.signature_lock``) so two concurrent per-source pollers (the Round-4
    fan-out) correlating the SAME signature can never both mint a case (#4). Because
    that lock is non-reentrant, this path calls the pipeline's ``_locked`` internals
    (which skip re-acquiring) INSIDE the lock. A signature with no configured lock
    registry (e.g. a bare pipeline in a test) degrades to a no-op nullcontext, so
    single-source behaviour is byte-identical."""
    from ..engine.risk import (  # local import avoids an import cycle
        compute_risk,
        compute_routing_risk,
    )

    stats = {"clusters": len(clusters), "investigated": 0, "candidates": 0,
             "attached": 0, "suppressed": 0, "ignored": 0, "deferred": 0}
    allow = set(prefs.auto_forward_allowlist)
    wildcard = "*" in allow
    floor = prefs.auto_investigate_risk_floor
    # Per-tick auto-investigation ceiling (cost bound): how many clusters may be forwarded
    # to the strong LLM investigator in THIS call. Once reached, remaining ELIGIBLE clusters
    # stay $0 CANDIDATES (never dropped, #4) and drain over later ticks — bounding per-tick
    # spend + the cold-start herd. Investigations stay SEQUENTIAL (this loop awaits each,
    # never asyncio.gather) so peak $ / provider load is predictable (no 429 storm).
    cap = max(1, int(getattr(prefs.caps, "max_auto_investigations_per_tick", 25)))
    investigated_this_tick = 0
    for cluster in clusters:
        # IGNORE feed (Wave 6): the only role that DROPS. A cluster every member of
        # which belongs to an ignore feed is muted entirely — skip ingest (no case,
        # no candidate). A below-severity_floor event is NOT dropped here (#4).
        if _is_ignored_cluster(cluster, prefs):
            stats["ignored"] += 1
            continue
        # Defence-in-depth suppression (cost-gate layer 2): an entirely-suppressed
        # cluster is the intended drop mechanism.
        if not passes_suppression(cluster, prefs):
            stats["suppressed"] += 1
            continue
        # Serialize the find→create/attach critical section PER SIGNATURE (#4). The
        # lock is shared across the whole fan-out (poller children + push-ingest) via
        # the ONE pipeline, so a signature is only ever created/attached once at a time.
        async with _sig_lock(pipeline, cluster.signature):
            existing = await find_open_case_for_cluster(cases, cluster)
            # An already-DECIDED open case (``existing.verdict is not None``) is
            # ATTACH-ONLY: merge the new events (idempotent, #4) and never re-investigate
            # here. That preserves P1 verdict stability — a poll/attach burst can never
            # re-bill or drift a case that already has a verdict.
            #
            # An un-investigated CANDIDATE (``existing.verdict is None``) is NOT
            # short-circuited: it FALLS THROUGH to the SAME eligibility → risk-gate → cap
            # ladder as a brand-new signature, so a cluster that was DEFERRED on an earlier
            # tick (below-floor, auto-correlate-off, or per-tick capped) actually DRAINS to
            # investigation the instant it is eligible and cap headroom is free — instead of
            # being stuck attach-only forever. Draining IS a real state transition now, not
            # a promised-but-never-kept "will drain next tick" label. The two downstream
            # branches both attach the new events first (the pipeline's locked internals
            # merge ``existing.member_event_ids + cluster.member_event_ids``), so a
            # still-ineligible/over-cap candidate keeps its events and simply refreshes its
            # honest stage label — nothing is ever dropped (#4). A drained-candidate
            # investigation counts against the per-tick cap exactly like a fresh one.
            if existing is not None and existing.verdict is not None:
                await attach_cluster(cases, existing, cluster)
                stats["attached"] += 1
                continue
            # Alerts-role index patterns carry SIEM-generated detections the operator
            # wants EVERY one of triaged: an alerts-role cluster is auto-forwarded to
            # investigation regardless of the auto-forward allowlist (still gated by
            # background_scan_enabled, the global automated-investigation switch).
            # Events-role clusters now auto-forward on the DETERMINISTIC RISK GATE below
            # (allowlist still honored) instead of an empty-allowlist no-op.
            #
            # The per-source + per-feed "Auto-Correlate" toggle (Wave 5 / F6 + Wave 6) is
            # an ADDITIONAL gate on top of all of the above: a cluster auto-forwards only
            # when its source AND every matched feed allow it. All toggles default TRUE so
            # this is byte-identical out of the box; a disabled toggle routes the cluster
            # to a candidate (manual triage) instead — still correlated + never dropped.
            #
            # The per-feed ``severity_floor`` (Wave 6, #4) is the final gate:
            # ``cluster.auto_investigate_eligible`` is False only when EVERY member is
            # below its feed floor — such a cluster is registered as a CANDIDATE (+ live-
            # tail), never dropped, never auto-forwarded.
            # Deterministic pre-forward RISK (reputation 0.0 — the honest, enrichment-free
            # score the events-role risk gate reads). ``compute_risk`` is pure + cheap; the
            # pipeline recomputes it downstream (candidate: same 0.0; investigation: with
            # enrichment reputation) so this never diverges the persisted case risk. Routing
            # input only — NEVER feeds ``decide()`` (#3).
            cluster.risk_score = compute_risk(cluster, prefs, 0.0).total
            routing_score = compute_routing_risk(cluster, prefs, reputation=None).total
            # Comprehensive-ingestion gate (Autopilot overhaul, #1/#2). An events-role
            # cluster now auto-forwards on the DETERMINISTIC RISK GATE
            # (``risk_score >= auto_investigate_risk_floor``) — not an empty allowlist — so a
            # zero-config install reasons over high-risk events out of the box. Alerts-role
            # clusters (``is_alert``) bypass the gate: every SIEM detection is triaged. The
            # ``auto_forward_allowlist`` is still honored (a listed rule forwards regardless
            # of risk — explicit operator control, back-compat). Below-floor events-role
            # clusters stay $0 CANDIDATES (risk-scored + visible, never dropped, #4). All of
            # it is bounded by the per-tick ``cap`` + the default budget backstop, so "read
            # everything" can never become "spend everything".
            eligible = (
                prefs.background_scan_enabled
                and cluster.auto_investigate_eligible
                and _auto_correlate_allowed(cluster, prefs)
                and (
                    cluster.is_alert
                    or wildcard
                    or any(r in allow for r in cluster.rule_values)
                    or routing_score >= floor
                )
            )
            # Per-tick cap: a direct/single-source caller keeps the historical local
            # allowance. PollerManager supplies ONE shared budget to every concurrent child,
            # making the configured cap global across the fan-out instead of N × cap.
            # An over-cap eligible cluster remains a durable candidate and drains later.
            if not eligible:
                forwarded = False
            elif investigation_budget is not None:
                forwarded = await investigation_budget.try_claim()
            else:
                forwarded = investigated_this_tick < cap
            capped = eligible and not forwarded
            # The non-reentrant per-signature lock is already held → call the ``_locked``
            # pipeline internals (they perform the find→save WITHOUT re-acquiring, so no
            # self-deadlock). Falls back to the public method for a pipeline that predates
            # the split ONLY when the lock is a no-op (``_sig_lock`` returned nullcontext),
            # so the fallback can never re-enter a held lock.
            if forwarded:
                investigated_this_tick += 1
                fn = getattr(pipeline, "_investigate_cluster_locked", None) or pipeline.investigate_cluster
                # Real InvestigationPipeline accepts the additive source kwarg,
                # including explicit None for push-only sources (which removes the
                # query tool rather than inheriting the primary connector). Bare
                # test/extension pipelines may predate it; inspect before passing.
                import inspect

                params = inspect.signature(fn).parameters
                if "query_source" in params:
                    await fn(cluster, source_surface, prefs, query_source=query_source)
                else:
                    await fn(cluster, source_surface, prefs)
                stats["investigated"] += 1
            elif existing is not None:
                # An un-investigated CANDIDATE that stays a candidate this tick (still below
                # the risk floor, or cap-deferred): merge the new events into the SAME case
                # and count it as an ATTACH — never a second ``candidates`` create. Counting
                # it as a new candidate would double-count the noise counters and, under a
                # concurrent same-signature run (Round-4 poller-concurrency, #4), report two
                # candidates for one signature. It stays a candidate, so it can still drain to
                # investigation on a later tick once it becomes eligible + uncapped.
                if capped:
                    stats["deferred"] += 1
                new_reason = _candidate_reason(
                    cluster, prefs, capped=capped, floor=floor,
                    routing_score=routing_score,
                )
                reason_changed = existing.awaiting_reason != new_reason
                existing.awaiting_reason = new_reason
                attached = await attach_cluster(cases, existing, cluster)
                if reason_changed and not attached:
                    await cases.save(existing)
                stats["attached"] += 1
            else:
                if capped:
                    stats["deferred"] += 1
                # A brand-new candidate: register it (+ live-tail) with an honest stage label
                # of WHY it is not (yet) LLM-reasoned (advisory, #3-safe).
                reason = _candidate_reason(
                    cluster, prefs, capped=capped, floor=floor,
                    routing_score=routing_score,
                )
                fn = getattr(pipeline, "_register_candidate_locked", None) or pipeline.register_candidate
                await _register_candidate(fn, cluster, source_surface, prefs, reason)
                stats["candidates"] += 1
    return stats


def _register_candidate(fn, cluster, source_surface, prefs, reason: str):
    """Call the pipeline's candidate registration, threading the honest ``awaiting_reason``
    when the target supports it. Falls back to the 3-arg call for a stub pipeline that
    predates the kwarg, so ``handle_clusters`` stays robust against a bare test pipeline."""
    try:
        return fn(cluster, source_surface, prefs, awaiting_reason=reason)
    except TypeError:
        return fn(cluster, source_surface, prefs)


def _candidate_reason(
    cluster: Cluster,
    prefs: Preferences,
    *,
    capped: bool,
    floor: int,
    routing_score: float,
) -> str:
    """A short, honest label for WHY a cluster became a $0 candidate rather than being
    auto-investigated — surfaced on the candidate case so the UI never implies reasoning
    that has not happened. Advisory presentation only; never feeds ``decide()`` (#3)."""
    if capped:
        return ("deferred: per-tick auto-investigation cap reached; drains to investigation "
                "on a later tick once cap headroom frees")
    if not prefs.background_scan_enabled:
        return "automated background investigation is disabled"
    if not cluster.auto_investigate_eligible:
        return "every event is below its feed's severity floor"
    if not _auto_correlate_allowed(cluster, prefs):
        return "auto-correlate is off for this source or feed"
    return (
        f"available-signal routing score {int(routing_score)} is below the "
        f"auto-investigate floor {floor}"
    )


def _sig_lock(pipeline, signature: str):
    """The shared per-signature lock context for ``handle_clusters`` (#4).

    Returns ``pipeline.signature_lock(signature)`` when the pipeline exposes it (the
    real :class:`InvestigationPipeline`), else a no-op ``nullcontext`` so a bare/stub
    pipeline in a test keeps working byte-identically. When the fallback nullcontext is
    used the pipeline also lacks the ``_locked`` internals, so the public
    investigate/register methods are safe to call (no lock is held)."""
    import contextlib

    getter = getattr(pipeline, "signature_lock", None)
    if getter is None:
        return contextlib.nullcontext()
    try:
        return getter(signature)
    except Exception:  # noqa: BLE001 — never let lock acquisition break ingest
        return contextlib.nullcontext()


async def link_cross_source(
    clusters: list[Cluster],
    prefs: Preferences,
    *,
    cases: "CaseStore",
) -> int:
    """Run the OPT-IN cross-source correlation pass and apply RELATED links.

    This runs AFTER per-source correlation + handling, and ONLY when
    ``prefs.cross_source_correlation.enabled``. It NEVER force-merges: the per-cluster
    1:1 signature is untouched (#4). For each cross-source group it sets, on every
    member case, ``cross_source_cluster_id`` (the stable group id) +
    ``related_case_ids`` (the OTHER members) + ``source_breakdown`` (source_id→count),
    then re-saves the cases. Best-effort: any error is swallowed (it must never break
    ingestion). Returns the number of cases linked.

    The cross-source candidate pool is: the OPEN cases behind THIS batch's clusters
    (rich entity sets from member events) PLUS the recent OPEN cases in the store
    (contributing their primary entity), so a cluster from one source links to an
    already-open case from another source."""
    from .correlation import (
        CrossSourceComponentSeed,
        CrossSourceItem,
        _valid_cross_source_cluster_id,
        _entity_keys,
        cluster_cross_source_entities,
        cross_source_correlate,
    )

    cfg = prefs.cross_source_correlation
    if not cfg.enabled or not clusters:
        return 0
    entity_keys = _entity_keys(prefs)
    if not entity_keys:
        return 0

    items: list[CrossSourceItem] = []
    case_by_id: dict[str, object] = {}
    seen_ids: set[str] = set()
    # 1) Items from THIS batch's clusters (full cross-source entity sets from members).
    for cluster in clusters:
        existing = await find_open_case_for_cluster(cases, cluster)
        if existing is None:
            continue
        ents = cluster_cross_source_entities(cluster, entity_keys)
        if not ents:
            continue
        case_by_id[existing.case_id] = existing
        seen_ids.add(existing.case_id)
        items.append(CrossSourceItem(
            id=existing.case_id,
            source_id=existing.source_id or (cluster.source_id or ""),
            ts=cluster.last_seen_millis or cluster.first_seen_millis or 0,
            entities=ents,
        ))
    if not items:
        return 0

    # 2) Recent non-terminal cases in the store (their PRIMARY entity) as cross-source
    #    candidates from OTHER sources. Bounded; best-effort. We pull a recent page and
    #    keep the still-open (non-terminal) ones so an investigated case can still link.
    try:
        recent_cases, _ = await cases.list(limit=200, sort_field="updated_at")
    except Exception:  # noqa: BLE001 — candidate pooling is best-effort
        recent_cases = []
    open_statuses = set(OPEN_CASE_STATUSES)
    for oc in recent_cases:
        if oc.case_id in seen_ids:
            continue
        status_val = getattr(oc.status, "value", oc.status)
        if str(status_val) not in open_statuses:
            continue
        try:
            et = oc.entity.type
        except Exception:  # noqa: BLE001
            continue
        if et not in entity_keys or not oc.entity.value:
            continue
        case_by_id[oc.case_id] = oc
        seen_ids.add(oc.case_id)
        ts = _case_millis(oc)
        items.append(CrossSourceItem(
            id=oc.case_id, source_id=oc.source_id or "",
            ts=ts, entities=frozenset({(et, oc.entity.value)}),
        ))

    # Persisted, resolved component metadata is a continuity edge for a NEW
    # overlapping match.  Keep this strictly inside the already-bounded candidate
    # pool: dangling ids are ignored, related-id edges must be reciprocal, and a
    # shared component id must have the locally generated hex shape.
    known_ids = set(case_by_id)
    component_seeds: list[CrossSourceComponentSeed] = []
    by_component_id: dict[str, set[str]] = collections.defaultdict(set)
    for cid, case in case_by_id.items():
        prior_id = str(getattr(case, "cross_source_cluster_id", "") or "")
        if _valid_cross_source_cluster_id(prior_id):
            by_component_id[prior_id].add(cid)
    for prior_id, member_ids in by_component_id.items():
        if len(member_ids) >= 2:
            component_seeds.append(CrossSourceComponentSeed(
                prior_id, frozenset(member_ids)
            ))

    seen_prior_edges: set[tuple[str, str]] = set()
    for cid, case in case_by_id.items():
        related = set(getattr(case, "related_case_ids", []) or []) & known_ids
        for other_id in related:
            edge = tuple(sorted((cid, other_id)))
            if cid == other_id or edge in seen_prior_edges:
                continue
            other = case_by_id[other_id]
            reciprocal = set(getattr(other, "related_case_ids", []) or [])
            if cid not in reciprocal:
                continue
            seen_prior_edges.add(edge)
            prior_ids = [
                str(getattr(member, "cross_source_cluster_id", "") or "")
                for member in (case, other)
            ]
            valid_prior_ids = [
                prior_id for prior_id in prior_ids
                if _valid_cross_source_cluster_id(prior_id)
            ]
            component_seeds.append(CrossSourceComponentSeed(
                min(valid_prior_ids) if valid_prior_ids else "",
                frozenset(edge),
            ))

    groups = cross_source_correlate(
        items, prefs, component_seeds=component_seeds
    )
    if not groups:
        return 0

    linked = 0
    for grp in groups:
        member_ids = grp["members"]
        for cid in member_ids:
            case = case_by_id.get(cid)
            if case is None:
                continue
            related = sorted(set(member_ids) - {cid})
            breakdown: dict[str, int] = {}
            for other_id in member_ids:
                other = case_by_id.get(other_id)
                if other is not None and other.source_id:
                    breakdown[other.source_id] = breakdown.get(other.source_id, 0) + 1
            changed = False
            if case.cross_source_cluster_id != grp["cross_source_cluster_id"]:
                case.cross_source_cluster_id = grp["cross_source_cluster_id"]
                changed = True
            if set(case.related_case_ids) != set(related):
                case.related_case_ids = related
                changed = True
            if case.source_breakdown != breakdown:
                case.source_breakdown = breakdown
                changed = True
            if changed:
                case.updated_at = iso_now()
                try:
                    await cases.save(case)
                    linked += 1
                except Exception:  # noqa: BLE001 — never break ingestion
                    pass
    return linked


def _case_millis(case) -> int:
    """Best-effort epoch-millis for a case's time (updated_at, else created_at)."""
    from ..utils import parse_es_timestamp, to_millis

    for attr in ("updated_at", "created_at"):
        ts = getattr(case, attr, None)
        if ts:
            parsed = parse_es_timestamp(ts)
            if parsed:
                return to_millis(parsed)
    return 0


class IngestService:
    """The entrypoint push receivers feed: normalised events → correlated cases.

    Unlike the poller (which owns a durable cursor over a pollable store), push
    sources hand us events as they arrive, so there is no cursor here — just the
    shared correlate→handle_clusters path. Processing failures propagate as
    :class:`IngestBatchError` so transports do not acknowledge work that was not
    persisted. Individual long-running receiver supervisors may restart/retry the
    transport; swallowing the failure here would silently lose the alert."""

    def __init__(
        self,
        cases: "CaseStore",
        audit: "AuditLogger",
        pipeline: "InvestigationPipeline",
        get_prefs,
    ) -> None:
        self._cases = cases
        self._audit = audit
        self._pipeline = pipeline
        self._get_prefs = get_prefs
        # Bounded per-source recent-events ring buffer so PUSH sources (which flow
        # straight to correlate→cases with no retained copy) can be browsed (live
        # tail). Keyed by source_id; capped per source so memory stays bounded.
        self._recent: dict[str, collections.deque] = {}
        self._recent_max = 500
        # Coverage observability (A5.2): a parallel tiny per-source ring of
        # ``(epoch_seconds, count)`` tick samples (the PUSH analogue of the poller's
        # ``_recent_ticks``) so a push source reports an ``events_per_min`` rate on
        # GET /api/sources/health, symmetric with pull. In-memory, advisory, fail-open;
        # never feeds ``decide()`` (#3).
        self._recent_ticks: dict[str, collections.deque] = {}
        self._recent_ticks_max = 6
        # Round-7 Noise-Reduction counters: an OPTIONAL fail-open sink recording each PUSH
        # batch's raw-alert-by-severity tally into the durable NoiseCounterStore. Wired by
        # AppState (``ingest_service._noise_sink = state.noise_counters.record``). None (the
        # default) → no counters recorded (byte-identical ingest path); advisory only (#3).
        self._noise_sink: Callable | None = None

    async def record_noise(self, delta: dict[str, Any]) -> None:
        """Record one Noise-Reduction counter ``delta`` (fail-open). No-op when unwired —
        a counter glitch can NEVER crash a receiver or drop an event (#3-safe, advisory)."""
        sink = self._noise_sink
        if sink is None:
            return
        try:
            await sink(delta)
        except Exception as exc:  # noqa: BLE001 — counters never break a receiver
            logger.debug("noise-counter record failed (ingest): %s", exc)

    async def _record_ingest_noise(self, events, clusters, stats, src) -> None:
        """Assemble + record the Noise-Reduction counter delta for a PUSH batch (fail-open).

        Bands the raw events + the correlated clusters by the source's declared severity
        scale (the SAME classifier the poller + the case severity chip use) and folds in the
        suppressed/ignored drops. Never raises — a banding/persist glitch degrades to no
        counter recorded, never a dropped event."""
        if self._noise_sink is None:
            return
        try:
            from .noise_counters import (
                count_clusters_by_band,
                count_events_by_band,
                severity_scale_for_source,
            )

            scale = severity_scale_for_source(src)
            await self.record_noise({
                "ingested": count_events_by_band(events, scale),
                "clustered": count_clusters_by_band(clusters or [], scale),
                "suppressed": int((stats or {}).get("suppressed", 0) or 0),
                "ignored": int((stats or {}).get("ignored", 0) or 0),
                # Aggregate-only input for the long-lived per-cluster baseline.
                # NoiseCounterStore ignores this additive key.
                "cluster_volumes": {
                    str(cluster.signature): int(cluster.count)
                    for cluster in (clusters or [])
                    if getattr(cluster, "signature", None)
                },
                # Coverage observability (A5.4): thread the push source's identity so the
                # durable counters keep a per-source ``by_source`` breakdown AND the
                # baseline/silent-source clock (state._observe_tick_volume) attributes the
                # volume — symmetric with the pull poller. Additive/None-safe.
                "source_id": getattr(src, "id", None),
                # The severity CEILING these bands were projected against — stamped on the
                # per-source sub-block only, so a later reader can tell whether two
                # windows' band splits describe one ladder (band tallies are bucketed at
                # write time and can never be re-projected). Symmetric with the poller.
                "severity_scale_max": scale,
            })
        except Exception as exc:  # noqa: BLE001 — counters never break ingest
            logger.debug("ingest noise-counter assembly failed: %s", exc)

    async def ingest(
        self,
        events: list[RawEvent],
        prefs: Preferences | None = None,
        source_surface: SourceSurface = SourceSurface.AUTOMATED_SCAN,
        source_id: str | None = None,
        *,
        query_source: "PullConnector | None" = None,
    ) -> dict[str, int]:
        """Ingest one delivery through the shared correlation/investigation spine.

        ``query_source`` is the optional, read-only browse adapter for the source that
        produced the delivery.  Real push transports leave it ``None``; bounded demo
        adapters pass themselves so the investigator can exercise the exact same
        structured-query tool path as a pull connector without inheriting an unrelated
        primary source.
        """
        prefs = prefs or self._get_prefs()
        base = {"received": 0, "clusters": 0, "investigated": 0,
                "candidates": 0, "attached": 0, "suppressed": 0, "ignored": 0}
        if not events:
            return base
        from ..engine.correlation import correlate  # local import avoids a cycle

        events = dedup_by_id(ensure_push_event_ids(events, source_id))
        if source_id:
            # Tag PUSH events with source provenance + role (the ElasticConnector
            # does this for PULL). A push source can be declared an ALL-alerts source
            # via config (``role: alerts`` / ``index_patterns`` all-alerts) so every
            # one of its clusters auto-forwards, or an ALL-ignore source (``role:
            # ignore``) which is MUTED — its events drop at ingest. Never overwrites a
            # role/source the event already carries (e.g. set by a connector).
            src = next((s for s in prefs.sources if s.id == source_id), None)
            push_role = _push_source_role(src)
            name = (src.display_name or source_id) if src else source_id
            for ev in events:
                if not ev.source_id:
                    ev.source_id = source_id
                if not ev.source_name:
                    ev.source_name = name
                if push_role == "alerts":
                    ev.index_role = "alerts"
            buf = self._recent.get(source_id)
            if buf is None:
                buf = collections.deque(maxlen=self._recent_max)
                self._recent[source_id] = buf
            buf.extend(events)
            # Coverage observability (A5.2): sample this batch's arrival for the per-source
            # events/min rate (the PUSH analogue of the poller's per-tick rate). In-memory,
            # advisory, fail-open — counts ALL received events (incl. an ignore batch, which
            # is still inbound volume) before any ignore short-circuit below.
            self._record_tick_rate(source_id, len(events))
            # IGNORE feed (Wave 6): a wholesale-ignore PUSH source is muted — its
            # events are still BUFFERED for browse/live-tail but skip ingest entirely
            # (no correlate, no case). This is the ONLY drop; a below-floor event is
            # never dropped (#4).
            if push_role == "ignore":
                # Round-7: a wholesale-ignore batch still counts as INGESTED volume the AI
                # dropped — record it as ingested + ignored (fail-open) before returning.
                await self._record_ingest_noise(events, [], {"ignored": len(events)}, src)
                return {**base, "received": len(events), "ignored": len(events)}
        try:
            # Honour the originating source's per-source entity strategy (entity-
            # agnostic correlation; default auto preserves today's behaviour).
            src = next((s for s in prefs.sources if s.id == source_id), None) if source_id else None
            strategy = prefs.entity_strategy_for(src)
            # Push = pull symmetry (#1, A6): threshold correlation must span
            # successive deliveries, not merely one transport callback. Queue and
            # syslog receivers commonly emit one record at a time, so correlate the
            # bounded, source-local look-back ring for events-role sources. Alerts
            # remain batch-local/EVERY because each native detection is independent.
            correlation_events = events
            batch_role = _push_source_role(src) if src is not None else None
            if source_id and batch_role != "alerts":
                windows = [prefs.default_correlation.window_seconds]
                windows.extend(r.window_seconds for r in prefs.correlation_rules.values())
                widest = max(windows) if windows else prefs.default_correlation.window_seconds
                interval = max(1, prefs.poll_interval_seconds)
                lookback_ms = (max(widest, interval) + 2 * interval) * 1000
                cutoff = to_millis(now_utc()) - lookback_ms
                buffered = self._recent.get(source_id) or ()
                correlation_events = dedup_by_id([
                    *(
                        event
                        for event in buffered
                        if event.timestamp_millis <= 0 or event.timestamp_millis >= cutoff
                    ),
                    # Always retain the delivery being processed even when a source
                    # sends old event-time data/backfill outside the live look-back.
                    *events,
                ])

            # Push = pull symmetry (#1, A6): a PUSH source declared WHOLESALE ``alerts``
            # correlates with mode EVERY so every pushed detection becomes exactly one case,
            # exactly like an alerts-role PULL feed. ``role`` is the whole-batch hint (the
            # push events are also individually tagged ``index_role='alerts'`` above, so this
            # is belt-and-suspenders); an ``events`` role is a no-op (byte-identical). The
            # clusters then hit the SAME ``handle_clusters`` risk-gate ladder as pull.
            clusters = correlate(
                correlation_events, prefs, entity_strategy=strategy, role=batch_role
            )
            # Only process clusters touched by this delivery. The surrounding
            # look-back supplies threshold context; it must not re-handle an unrelated
            # old cluster whenever another entity sends an event.
            new_ids = {event.event_key() for event in events}
            clusters = [
                cluster
                for cluster in clusters
                if new_ids.intersection(cluster.member_event_keys or cluster.member_event_ids)
            ]
            stats = await handle_clusters(
                clusters, prefs, cases=self._cases, pipeline=self._pipeline,
                source_surface=source_surface,
                query_source=query_source,
            )
            # Opt-in cross-source correlation (Wave 5 / F6): AFTER per-source handling,
            # link open cases sharing an entity across sources as RELATED (never merged).
            # No-op (returns 0) when disabled — the default — so single-source is unchanged.
            if prefs.cross_source_correlation.enabled:
                try:
                    stats["cross_source_linked"] = await link_cross_source(
                        clusters, prefs, cases=self._cases
                    )
                except Exception as exc:  # noqa: BLE001 — never break ingestion
                    logger.warning("cross-source correlation failed: %s", exc)
        except Exception as exc:  # noqa: BLE001 — convert to the receiver retry boundary
            logger.exception("ingest failed for a %d-event batch: %s", len(events), exc)
            try:
                await self._audit.record(
                    action_type=ActionType.ERROR, surface="ingest", actor="ingest",
                    source_id=source_id,
                    result_summary=f"ingest error on {len(events)} events: {exc}",
                )
            except Exception as audit_exc:  # noqa: BLE001 — preserve the processing failure
                logger.warning("could not audit ingest failure: %s", audit_exc)
            raise IngestBatchError(
                f"batch of {len(events)} events was not processed; retry the batch"
            ) from exc
        stats["received"] = len(events)
        # Round-7: record this batch's raw-alert-by-severity tally (fail-open; never blocks
        # or breaks the receiver). ``clusters``/``src`` are in scope from the try above.
        await self._record_ingest_noise(events, clusters, stats, src)
        await self._audit.record(
            action_type=ActionType.POLL, surface="ingest", actor="ingest",
            source_id=source_id,
            result_summary=(f"received={len(events)} clusters={stats['clusters']} "
                            f"investigated={stats['investigated']} candidates={stats['candidates']} "
                            f"attached={stats['attached']}"),
        )
        return stats

    def recent_events_for_source(self, source_id: str, limit: int = 100) -> list[RawEvent]:
        """Most-recent-first buffered events for a push source (live-tail browse)."""
        buf = self._recent.get(source_id)
        if not buf:
            return []
        return list(buf)[-max(1, limit):][::-1]

    def _record_tick_rate(self, source_id: str, count: int) -> None:
        """Sample one push batch's ``(arrival_ts, count)`` for the per-source events/min
        rate (coverage observability, A5.2). In-memory, advisory, fail-open — never raises,
        never feeds ``decide()`` (#3)."""
        try:
            if not source_id:
                return
            buf = self._recent_ticks.get(source_id)
            if buf is None:
                buf = collections.deque(maxlen=self._recent_ticks_max)
                self._recent_ticks[source_id] = buf
            buf.append((now_utc().timestamp(), int(count)))
        except Exception:  # noqa: BLE001 — a rate sample must never break a receiver
            pass

    def events_per_min_for_source(self, source_id: str) -> float:
        """Smoothed events/min for a PUSH source over its recent batches (A5.2)."""
        from .noise_counters import events_per_min_from_ticks

        return events_per_min_from_ticks(self._recent_ticks.get(source_id))
