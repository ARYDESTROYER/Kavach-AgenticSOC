"""The raw records behind a case (Round 16 SPEC §4.5 WP13, [dv] R2).

    GET /api/cases/{case_id}/events?limit=50&cursor=    cases:read and sources:read

A case keeps only references to the events it was built from (``member_event_keys``,
source-index-qualified, and the native ``member_event_ids``). This route reads those
events again, on demand, from the case's own source:

* the source is resolved exactly as re-investigation and the forwarding explainer
  resolve it (``state.active_source_for_id(case.source_id)``, which is Demo-switchable),
  and the read is that connector's ``fetch_by_ids`` over its read-only log client (#1);
* only rows whose source-qualified key is one of the case's member keys are kept: an
  Elasticsearch ``_id`` is unique only within one index, so an ``ids`` query can also
  answer an unrelated event of another index. A legacy member entry that is a bare id
  (written before keys existed) keeps the event with that id;
* pages walk the case's member list in its stored order, ``limit`` 1 to 200 members a
  page, ``cursor`` the opaque offset the previous page returned as ``next_cursor``.

The envelope says what it could do (:class:`app.models.CaseEventsPage`):
``available`` is false with a ``reason`` when nothing could be shown:
``push_source_not_retrievable`` (a push source has no search surface to read back),
``source_unavailable`` (the source was deleted, disabled, or failed or timed out) or
``aged_out`` (the source answered but none of the page's events exist any more).
``expected`` is the case's member count, ``returned`` the rows on this page, and
``truncated`` true when more members follow (``next_cursor``).

Every row is the ``/api/logs`` row contract (``engine.log_rows.log_row``) plus
``index``, ``source_id`` and ``in_evidence`` (the indexes of the findings that cite the
event). Every value is source-controlled UNTRUSTED data, returned as JSON strings and
rendered as text by the Console (#9); nothing here reaches a model (#7) or changes a
case (#3).

Reading writes one ``case.events_viewed`` audit row per viewer per case per ten minutes,
best-effort, to the execution audit (the Demo audit in Demo Mode, SPEC §3.2). A read that
returned no row writes none.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Mapping

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..audit.context import audit_context
from ..audit.views import ViewRecorder
from ..connectors.registry import get_registry
from ..engine.log_rows import log_row
from ..models import (
    CASE_EVENTS_MAX_LIMIT,
    AuditTarget,
    Case,
    CaseEventsPage,
    RawEvent,
    split_cursor_event_key,
)
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.case_events")

router = APIRouter(prefix="/api")

_READ_CASES = require_permission("cases", "read")
_READ_SOURCES = require_permission("sources", "read")

#: The default page size, in member events.
DEFAULT_LIMIT = 50
#: How long one source read may take before the page answers ``source_unavailable``
#: (the ``GET /api/logs`` per-source default).
READ_TIMEOUT_S = 8.0
#: An opaque cursor is a decimal offset into the case's member list: one to nine ASCII
#: digits. Anything else (another script's digits, a sign, a longer value) is a cursor
#: this route never returned and answers 400, never 422 or 500.
_CURSOR_MAX_CHARS = 9
_CURSOR_RE = re.compile(rf"[0-9]{{1,{_CURSOR_MAX_CHARS}}}")
#: The longest cursor the query accepts before the route reads it (input bound only).
_CURSOR_INPUT_MAX_CHARS = 64

#: The structured action of a view row (category Case work).
EVENTS_VIEW_ACTION = "case.events_viewed"
EVENTS_VIEW_SURFACE = "case"
EVENTS_COALESCE_SECONDS = 600.0


class CaseEventsViewRecorder(ViewRecorder):
    """One ``case.events_viewed`` row per viewer and case per ten minutes.

    The audit log's coalescing map (bounded, process-local, best-effort; see
    :mod:`app.audit.views`), with the row naming its case: ``case_id`` and a ``case``
    target, so the case's own audit trail lists who read its raw events."""

    def __init__(self) -> None:
        super().__init__(window=EVENTS_COALESCE_SECONDS, action=EVENTS_VIEW_ACTION,
                         surface=EVENTS_VIEW_SURFACE)

    async def note_case(self, audit: Any, *, actor: str, case: Case, returned: int,
                        context: Any = None) -> bool:
        """Write the view row unless this viewer wrote one for this case inside the
        window. Returns whether a row was written. Never raises."""
        view: Mapping[str, Any] = {"case_id": case.case_id}
        key = self.key(actor, view)
        now = self._clock()
        if not self._due(key, now):
            return False
        label = case.case_number or case.case_id
        self._pending.add(key)
        try:
            await audit.record_strict(
                action_type=self.action_type,
                surface=self.surface,
                actor=actor,
                actor_type="human",
                action=self.action,
                outcome="success",
                case_id=case.case_id,
                source_id=case.source_id,
                target=AuditTarget(type="case", id=case.case_id, label=label),
                result_summary=f"Viewed the raw events of case {label}.",
                tool_input={"case_id": case.case_id, "returned": int(returned)},
                actor_role=getattr(context, "actor_role", None),
                client=getattr(context, "client", None),
                session_ref=getattr(context, "session_ref", None),
                request_id=getattr(context, "request_id", None),
            )
        except Exception as exc:  # noqa: BLE001 (viewing is a read; never fail it)
            self.dropped += 1
            logger.warning("%s row dropped (%d so far): %s", self.action, self.dropped, exc)
            return False
        finally:
            self._pending.discard(key)
        self.written += 1
        self._remember(key, now)
        return True


#: The process's recorder (tests reset it).
RECORDER = CaseEventsViewRecorder()


def _members(case: Case) -> list[str]:
    """The case's member list in stored order, without repeats: its source-qualified
    keys, or the native ids of a case written before keys existed."""
    return list(dict.fromkeys(str(m) for m in (case.member_event_keys or case.member_event_ids) if m))


def _offset(cursor: str | None) -> int:
    if cursor in (None, ""):
        return 0
    text = str(cursor)
    if _CURSOR_RE.fullmatch(text) is None:
        raise HTTPException(status_code=400, detail={
            "code": "case_events_bad_cursor",
            "message": "The cursor is not one this route returned.",
        })
    return int(text)


def _resolve_source(state: AppState, case: Case) -> tuple[Any | None, str | None]:
    """The case's read-only query source, or ``None`` with the reason it cannot be read.

    The same resolution as re-investigation (``engine.case_cluster.cluster_for_case``):
    ``state.active_source_for_id`` (a Demo adapter while Demo Mode is on, the live
    pull connector of a configured source, or the implicit legacy source of a case
    written without source provenance)."""
    source = state.active_source_for_id(case.source_id)
    if source is not None:
        return source, None
    if state.demo_active or not case.source_id:
        return None, "source_unavailable"
    prefs = state.prefs
    configured = prefs.source_by_id(case.source_id)
    if configured is None:
        # A single-source deployment configured only through the environment: the
        # case names the implicit legacy connector, which has no configured row.
        legacy = getattr(state, "log_source", None)
        if not prefs.sources and getattr(legacy, "connector_id", None) == case.source_id:
            return legacy, None
        return None, "source_unavailable"
    try:
        if get_registry().is_receiver(configured.source_type):
            return None, "push_source_not_retrievable"
    except Exception:  # noqa: BLE001 (an unknown type reads as unavailable)
        pass
    return None, "source_unavailable"


def _evidence_index(case: Case) -> dict[str, list[int]]:
    """Each cited event id (or key) mapped to the indexes of the findings citing it."""
    cited: dict[str, list[int]] = {}
    for i, item in enumerate(case.evidence or []):
        for ref in dict.fromkeys(str(r) for r in (item.event_ids or []) if r):
            cited.setdefault(ref, []).append(i)
    return cited


def _row(ev: RawEvent, case: Case, cited: Mapping[str, list[int]]) -> dict[str, Any]:
    row = log_row(ev)
    row["index"] = ev.index or None
    row["source_id"] = ev.source_id or case.source_id
    findings = set(cited.get(ev.id, [])) | set(cited.get(ev.event_key(), []))
    row["in_evidence"] = sorted(findings)
    return row


def _match(page: list[str], events: list[RawEvent]) -> list[RawEvent]:
    """The page's member events, in member order, each at most once. A qualified key
    matches its index and id exactly; a bare legacy id matches the first event with
    that id."""
    by_key: dict[str, RawEvent] = {}
    by_id: dict[str, RawEvent] = {}
    for ev in events:
        by_key.setdefault(ev.event_key(), ev)
        by_id.setdefault(str(ev.id), ev)
    kept: list[RawEvent] = []
    seen: set[int] = set()
    for member in page:
        index, event_id = split_cursor_event_key(member)
        ev = by_key.get(member) if index is not None else by_id.get(event_id)
        if ev is not None and id(ev) not in seen:
            seen.add(id(ev))
            kept.append(ev)
    return kept


@router.get("/cases/{case_id}/events", response_model=CaseEventsPage)
async def case_events(
    case_id: str,
    request: Request,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=CASE_EVENTS_MAX_LIMIT,
                       description="Member events per page, 1 to 200."),
    cursor: str | None = Query(default=None, max_length=_CURSOR_INPUT_MAX_CHARS,
                               description="The previous page's next_cursor."),
    state: AppState = Depends(get_state),
    _cases=Depends(_READ_CASES),
    _sources=Depends(_READ_SOURCES),
) -> CaseEventsPage:
    """The raw events behind a case, read again from its source (see the module
    docstring). 404 for an unknown case; 400 for a cursor this route never returned."""
    offset = _offset(cursor)
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    members = _members(case)
    page = members[offset: offset + limit]
    more = offset + limit < len(members)
    envelope: dict[str, Any] = {
        "case_id": case_id, "expected": len(members), "limit": limit,
        "truncated": more, "next_cursor": str(offset + limit) if more else None,
    }
    if not page:
        return CaseEventsPage(**envelope, available=True)

    source, reason = _resolve_source(state, case)
    if source is None:
        return CaseEventsPage(**envelope, available=False, reason=reason)

    ids = list(dict.fromkeys(split_cursor_event_key(m)[1] for m in page))
    # An id may name an event in more than one index: leave room for the other copies
    # so a foreign copy never pushes a member out of the read.
    size = min(2 * len(page), 2 * CASE_EVENTS_MAX_LIMIT)
    try:
        result = await asyncio.wait_for(
            source.fetch_by_ids(state.execution_prefs, ids, size=size), timeout=READ_TIMEOUT_S,
        )
        events = [ev for ev in (getattr(result, "events", None) or []) if isinstance(ev, RawEvent)]
    except Exception as exc:  # noqa: BLE001 (a failed or slow source is reported, not raised)
        logger.warning("case events read failed for %s: %s", case_id, exc)
        return CaseEventsPage(**envelope, available=False, reason="source_unavailable")

    kept = _match(page, events)
    if not kept:
        return CaseEventsPage(**envelope, available=False, reason="aged_out")
    cited = _evidence_index(case)
    rows = [_row(ev, case, cited) for ev in kept]
    await RECORDER.note_case(
        state.audit, actor=current_username(request) or "analyst", case=case,
        returned=len(rows), context=audit_context(request),
    )
    return CaseEventsPage(**envelope, available=True, returned=len(rows), rows=rows)
