"""Rebuild a case's cluster from the log surface (read-only), for re-investigation and
the forwarding explainer.

Moved unchanged from ``api/routes.py`` (chat revamp SPEC §5.3, "route-private helpers
move first"). The only change is the seam: where the route helpers read ``state.es`` /
``state.log_source`` / ``state.execution_prefs`` they now take those as explicit
keyword arguments, so the chat ``explain_decision`` tool can reuse the exact same
reconstruction without importing the HTTP layer or the ``AppState``. ``api.routes``
keeps thin wrappers with the historical names and ``(state, ...)`` signatures, so route
code and tests are unchanged.

Read-only on the log surface (#1/#12). Nothing here calls ``decide()`` (#3), a model
(#6), or recomputes a cluster signature for an existing case (#4): every rebuilt
cluster is pinned to the case's stored ``cluster_signature``.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from ..config import Preferences
from ..constants import EntityType
from ..es.querybuilder import entity_query, ids_query, scope_filters, scope_must_not
from ..models import Case, Cluster, RawEvent, TriggerReason
from ..utils import relative_to_millis
from .correlation import cluster_from_events

__all__ = [
    "WIDEN_LADDER",
    "bind_cluster_for_case",
    "cluster_for_case",
    "entity_events_widening",
    "entity_field",
    "manual_trigger_reason",
    "reconstruct_cluster_from_case",
    "scoped_entity_body",
    "widen_windows",
]


# Auto-widen ladder (BUG-2): increasing windows tried IN ORDER on 0 hits. The
# configured/requested start window is always tried first; ladder rungs narrower
# than the start are skipped so we never shrink the search below what was asked.
# ``now-365d`` is the ~1-year widest rung (the relative-time parser supports
# s/m/h/d/w, not a ``y`` unit, so a year is expressed in days).
WIDEN_LADDER = ("now-7d", "now-30d", "now-365d")


def entity_field(prefs: Preferences, entity_type: EntityType) -> str:
    return {
        EntityType.IP: prefs.source_ip_field,
        EntityType.USER: prefs.user_field,
        EntityType.HOST: prefs.host_field,
    }[entity_type]


def scoped_entity_body(prefs: Preferences, field: str, value: str, from_millis: int) -> dict[str, Any]:
    """Entity query with the SAME scope + suppression filters the poller uses, so a
    manual investigation never pulls out-of-scope or suppressed events."""
    body = entity_query(
        prefs, field, value, from_millis=from_millis, size=200,
        extra_filters=scope_filters(prefs),
    )
    must_not = scope_must_not(prefs)
    if must_not:
        body["query"]["bool"]["must_not"] = must_not
    return body


def widen_windows(start_window: str) -> list[str]:
    """Ordered windows to try: the configured/requested start, then each ladder
    rung that is WIDER than (i.e. reaches further back than) the start."""
    windows = [start_window]
    start_ms = relative_to_millis(start_window)
    for rung in WIDEN_LADDER:
        # A wider window resolves to an EARLIER epoch (further in the past).
        if relative_to_millis(rung) < start_ms:
            windows.append(rung)
    return windows


async def entity_events_widening(
    entity_type: EntityType,
    value: str,
    start_window: str,
    *,
    es: Any,
    prefs: Preferences,
    query_source=None,
) -> tuple[list[RawEvent], str]:
    """Fetch an entity's in-scope events, auto-widening the lookback on 0 hits.

    Returns (events, widest_window_tried). Stops at the first window that yields
    events; if all are empty the events list is empty and widest_window_tried is
    the broadest window attempted.

    ``prefs`` are the EXECUTION prefs of the active stack (the route wrapper passes
    ``state.execution_prefs``) and ``es`` is the shared log client; ``es`` is only
    touched on the legacy path where no ``query_source`` connector is given."""
    windows = widen_windows(start_window)
    widest = windows[-1]
    for window in windows:
        if query_source is not None:
            from ..connectors.base import StructuredQuery

            filters: dict[str, Any] = {
                "time_from": window,
                "time_to": "now",
                "size": 200,
                "sort_desc": True,
            }
            if entity_type == EntityType.IP:
                filters["ip"] = value
            elif entity_type == EntityType.USER:
                filters["user"] = value
            elif entity_type == EntityType.HOST:
                filters["host"] = value
            elif entity_type == EntityType.RULE:
                filters["rule"] = value
            else:
                # The current source-neutral query IR has no hash/domain field;
                # do not silently query a different source as a fallback.
                return [], widest
            result = await query_source.search(prefs, StructuredQuery(**filters))
            events = result.events
        else:
            field = entity_field(prefs, entity_type)
            body = scoped_entity_body(prefs, field, value, relative_to_millis(window))
            resp = await es.search_logs(prefs.data_view_pattern, body)
            hits = resp.get("hits", {}).get("hits", [])
            events = [RawEvent.from_hit(h, prefs) for h in hits]
        if events:
            return events, window
    return [], widest


async def cluster_for_case(
    case,
    *,
    es: Any,
    log_source: Any,
    prefs: Preferences,
    allow_stored_reconstruction: bool = False,
    query_source=None,
) -> Cluster | None:
    """Rebuild a cluster from a stored case for a human-triggered re-investigation.

    Prefers an exact id-based re-query of the case's member events; falls back to a
    config-windowed (``prefs.investigate_lookback``) entity re-query using the same
    scope filters as the manual investigate path. Read-only on the log surface.

    When both live re-queries come back empty (the originating events aged out of the
    retained log window) AND ``allow_stored_reconstruction`` is set, a MINIMAL cluster
    is rebuilt from the case's STORED fields (see :func:`reconstruct_cluster_from_case`)
    so an operator-triggered re-investigation can still run the LLM over the retained
    evidence instead of dead-ending on a 400. Callers that must NOT fabricate a cluster
    from stale state (e.g. the read-only forwarding explainer) leave the flag off and
    still get ``None``.

    The original deterministic trigger reason (if the case has one) is PRESERVED so
    a re-investigate never overwrites a scan-derived "Why this fired"; only a case
    lacking one gets a synthesized MANUAL trigger reason. Nothing here touches the
    deterministic close/escalate decision (#3).

    Explicit dependencies (formerly read from the ``AppState``): ``es`` is the shared
    log client (``state.es``), ``log_source`` the implicit legacy connector
    (``state.log_source``), ``prefs`` the execution prefs (``state.execution_prefs``),
    and ``query_source`` the case's own source connector as resolved by the caller
    (``state.active_source_for_id(case.source_id)``; ``None`` means "no upstream
    search surface")."""
    entity_type, value = case.entity.type, case.entity.value
    has_trigger = case.trigger_reason is not None
    # ``query_source=None`` is intentional for push/deleted sources: they have no
    # upstream search surface. Only legacy cases without source provenance may use
    # the implicit global ES client as a compatibility fallback.
    implicit_legacy_source = (
        not prefs.sources
        and case.source_id == getattr(log_source, "connector_id", None)
    )
    can_query_live = query_source is not None or not case.source_id or implicit_legacy_source

    def _finalize(cluster: Cluster, window: str) -> Cluster:
        # Re-investigation is an update of this exact stored case, not a fresh
        # correlation pass. Pin identity and provenance even when live events were
        # found; otherwise a legacy/manual case (or a source-scoping change) can
        # compute a new signature and mint a duplicate case.
        cluster.signature = case.cluster_signature
        cluster.source_id = case.source_id
        cluster.source_name = case.source_name
        # Only synthesize a manual reason when the case lacks one; otherwise leave
        # the cluster's reason None so the pipeline's _trigger() keeps the existing.
        if not has_trigger:
            cluster.trigger_reason = manual_trigger_reason(cluster, window)
        else:
            cluster.trigger_reason = None
        return cluster

    # Preferred: re-fetch the exact member events by id (read-only).
    if case.member_event_ids and can_query_live:
        fetch_size = max(len(case.member_event_ids), len(case.member_event_keys or []))
        if query_source is not None:
            result = await query_source.fetch_by_ids(
                prefs, case.member_event_ids, size=fetch_size
            )
            events = result.events
        else:
            resp = await es.search_logs(
                prefs.data_view_pattern,
                ids_query(case.member_event_ids, size=fetch_size),
            )
            hits = resp.get("hits", {}).get("hits", [])
            events = [RawEvent.from_hit(h, prefs) for h in hits]
        members = [e for e in events if e.entity_value(entity_type) == value] or events
        if members:
            cluster = cluster_from_events(entity_type, value, members)
            return _finalize(cluster, prefs.investigate_lookback)

    # Fallback: re-query the entity over the configured window (with auto-widen).
    if can_query_live:
        events, window = await entity_events_widening(
            entity_type, value, prefs.investigate_lookback,
            es=es, prefs=prefs,
            query_source=query_source,
        )
        if events:
            members = [e for e in events if e.entity_value(entity_type) == value] or events
            cluster = cluster_from_events(entity_type, value, members)
            return _finalize(cluster, window)

    # Last resort: the live logs aged out of the retained window. For an operator-
    # triggered re-investigation (reinvestigate / run-playbook), optionally rebuild a
    # MINIMAL cluster from the case's STORED evidence so the LLM can still re-reason
    # over what we retained. Read-only + fail-open; ``None`` only when the case carries
    # NO stored evidence at all. #3 untouched — this only reassembles evidence.
    if allow_stored_reconstruction:
        reconstructed = reconstruct_cluster_from_case(case)
        if reconstructed is not None:
            return _finalize(reconstructed, prefs.investigate_lookback)
    return None


def bind_cluster_for_case(
    *,
    es: Any,
    log_source: Any,
    prefs: Preferences,
    query_source_for: Callable[[str | None], Any],
) -> Callable[[Case], Awaitable[Cluster | None]]:
    """Pre-bind :func:`cluster_for_case` for read-only callers (the chat tool context's
    ``cluster_for_case(case)``), resolving each case's query source exactly the way the
    ``GET /api/cases/{id}/forwarding`` route does:
    ``query_source_for(case.source_id)`` (``state.active_source_for_id`` in the app,
    which is already demo-switchable).

    Stored reconstruction stays OFF: an explainer must report "unknown" rather than
    narrate a cluster fabricated from stale case fields."""

    async def _bound(case: Case) -> Cluster | None:
        return await cluster_for_case(
            case,
            es=es,
            log_source=log_source,
            prefs=prefs,
            query_source=query_source_for(case.source_id),
        )

    return _bound


def reconstruct_cluster_from_case(case: Case) -> Cluster | None:
    """Rebuild a MINIMAL cluster from a case's STORED fields when the live log
    re-query is empty (the originating events aged out of the retained window).

    Lets an operator-triggered re-investigation still run the investigator over the
    case's retained evidence rather than dead-ending. Synthetic member events are
    reconstructed (capped at 200) from the stored ``member_event_ids`` (falling back
    to the ``evidence[].event_ids``), each carrying the case entity + a stored rule so
    the investigator prompt and the deterministic risk model see faithful inputs. The
    cluster SIGNATURE is PINNED to the case's stored ``cluster_signature`` so the
    re-investigation updates THIS case in place and never mints a duplicate (#4).

    Read-only + fail-open: returns ``None`` only when the case carries no stored
    evidence at all. Nothing here touches the deterministic decision (#3)."""
    entity_type = case.entity.type
    value = case.entity.value

    # Stored evidence ids: prefer the member events, else the verdict evidence ids.
    raw_ids: list[str] = list(case.member_event_ids or [])
    if not raw_ids:
        for item in case.evidence:
            raw_ids.extend(item.event_ids or [])
    ordered_ids: list[str] = []
    seen: set[str] = set()
    for eid in raw_ids:
        if eid and eid not in seen:
            seen.add(eid)
            ordered_ids.append(eid)
        if len(ordered_ids) >= 200:
            break
    if not ordered_ids:
        return None  # truly-empty case — nothing to reconstruct.

    # Window from the stored trigger reason (else collapse to a point-in-time window).
    tr = case.trigger_reason
    win_start = int(tr.window_start) if (tr and tr.window_start) else 0
    win_end = int(tr.window_end) if (tr and tr.window_end) else 0
    if win_end < win_start:
        win_start, win_end = win_end, win_start

    rules = [r for r in (case.rule_ids or []) if r]
    n = len(ordered_ids)
    members: list[RawEvent] = []
    for i, eid in enumerate(ordered_ids):
        if win_start and win_end and n > 1:
            ts = win_start + (win_end - win_start) * i // (n - 1)
        else:
            ts = win_start or win_end or 0
        ev = RawEvent(
            id=eid,
            timestamp_millis=ts,
            rule=(rules[i % len(rules)] if rules else None),
            source={"reconstructed": True},
        )
        # Carry the case entity onto its projection field so the investigator prompt
        # + reproduce query render the concrete entity (UNTRUSTED log data downstream).
        if entity_type == EntityType.IP:
            ev.ip = value
        elif entity_type == EntityType.USER:
            ev.user = value
        elif entity_type == EntityType.HOST:
            ev.host = value
        members.append(ev)

    cluster = cluster_from_events(entity_type, value, members)
    # Preserve stored provenance + counts the synthetic events cannot carry, and PIN
    # the signature so the re-investigation updates THIS case in place (#4).
    cluster.signature = case.cluster_signature
    if case.rule_ids:
        cluster.rule_values = list(case.rule_ids)
    cluster.source_id = case.source_id
    cluster.source_name = case.source_name
    cluster.member_event_keys = list(case.member_event_keys or cluster.member_event_keys)
    # The stored member id list may exceed the 200-event synthetic cap — keep the
    # faithful volume for the deterministic risk model (recomputed by the pipeline).
    cluster.count = max(
        len(members), len(case.member_event_keys or case.member_event_ids)
    )
    if case.risk_score:
        cluster.risk_score = case.risk_score
        cluster.risk_breakdown = case.risk_breakdown
    return cluster


def manual_trigger_reason(cluster: Cluster, window: str) -> TriggerReason:
    """Synthesize a MANUAL TriggerReason so "Why this fired" renders for manually
    investigated cases (Feature 3 / IMPROVEMENT). Mode is ``manual``; structured
    fields are filled from the resolved cluster."""
    entity_type = cluster.entity.type.value
    entity_value = cluster.entity.value
    n = cluster.count
    rules = ", ".join(cluster.rule_values) or "no specific rule"
    sentence = (
        f"Manually investigated: {n} event{'s' if n != 1 else ''} for "
        f"{entity_type} {entity_value} in the last {window} across rules [{rules}]"
    )
    return TriggerReason(
        rule_value=(cluster.rule_values[0] if cluster.rule_values else ""),
        mode="manual",
        n=n,
        window_seconds=0,
        group_by=entity_type,
        observed_count=n,
        window_start=cluster.first_seen_millis,
        window_end=cluster.last_seen_millis,
        entity=f"{entity_type}:{entity_value}",
        rule_values=list(cluster.rule_values),
        sentence=sentence,
    )
