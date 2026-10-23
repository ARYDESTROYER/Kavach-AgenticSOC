"""Standup / shift-handoff routes (Round 3, Wave 2 — Feature 11).

NEW endpoints that sit ALONGSIDE the legacy ``GET /api/standup`` (left untouched in the
monolith router):

* ``GET  /api/standup/report``            — the forward-looking shift handoff payload
  (attention queue / SLA aging / per-analyst workload / period deltas / open action
  items + per-window ack state). Deep-link rows carry ``case_id`` so the webui can
  pre-seed a Cases filter.
* ``GET/POST/PUT/DELETE /api/standup/action-items`` — CRUD over the cross-shift living
  attention queue (``ShiftHandoffStore``).
* ``POST /api/standup/acknowledge``       — record one analyst's confirmation that they
  have read the handoff for a window (``ShiftAck``).
* ``GET  /api/standup/acknowledgements``  — the acknowledgement log (optionally
  filtered by window / user).

Every non-GET route declares ``require_permission`` (``cases:write`` — analysts /
responders manage their shift queue; auditors stay read-only). The GET routes inherit
the router-level ``require_auth`` mount. NOTHING here feeds ``case_manager.decide()``
(#3) and every operator-supplied ``title``/``note`` is plain data persisted via the
store (the webui renders it escaped — #9). The router NEVER lets a store glitch 500 a
read; it degrades to an empty, well-shaped payload.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..state import AppState
from ..utils import now_utc
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.standup")

router = APIRouter(prefix="/api")

# Managing the shift attention queue / acknowledging the handoff is analyst work —
# gate on the case write grant (tier1/tier2/responder/manager hold it; auditor is
# read-only, so they can VIEW the report but not mutate the queue).
_WRITE = ("cases", "write")


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #
class ActionItemCreate(BaseModel):
    title: str = ""
    owner: str | None = None
    note: str = ""
    status: str = "open"          # open | in_progress | done


class ActionItemUpdate(BaseModel):
    title: str | None = None
    owner: str | None = None
    note: str | None = None
    status: str | None = None     # open | in_progress | done


class AcknowledgeBody(BaseModel):
    # The handoff window being acknowledged (e.g. "2026-06-30/day"). Defaulted "" →
    # the route derives the current window so a bare ack still records sensibly.
    window: str = ""
    note: str = ""


class _DeleteBody(BaseModel):
    id: str = Field(default="")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _current_window(now: Any = None) -> str:
    """A deterministic default handoff window label, ``YYYY-MM-DD/<shift>``.

    Three coarse shift bands by UTC hour (day 06-14, swing 14-22, night otherwise) so a
    bare acknowledge / report request lands in a stable, comparable bucket."""
    ref = now or now_utc()
    hour = ref.hour
    if 6 <= hour < 14:
        shift = "day"
    elif 14 <= hour < 22:
        shift = "swing"
    else:
        shift = "night"
    return f"{ref.strftime('%Y-%m-%d')}/{shift}"


def _handoff(state: AppState):
    store = getattr(state, "shift_handoff", None)
    if store is None:
        raise HTTPException(status_code=503, detail="shift handoff store unavailable")
    return store


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
@router.get("/standup/report")
async def standup_report(
    window_hours: int | None = None,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The forward-looking shift handoff: attention queue + SLA aging + per-analyst
    workload + period-over-period deltas + open action items + ack state.

    ALWAYS HTTP 200 with a renderable payload (mirrors ``/api/standup``): a clear
    ``{enabled: false}`` shape when standup is disabled, else the deterministic shift
    snapshot. Never 500s — a degraded case/handoff store yields empty sections."""
    prefs = state.execution_prefs
    window = window_hours or prefs.standup.window_hours
    if not prefs.standup.enabled:
        return {
            "enabled": False,
            "window_hours": window,
            "window": _current_window(),
            "shift": {},
            "action_items": [],
            "acknowledgements": [],
            "degraded": False,
        }
    now = now_utc()
    win_label = _current_window(now)
    try:
        # ``needs_human_verdict``: the page's "Needs human" tile counts the open cases
        # whose verdict is Needs human, the same figure chat's shift report shows; the
        # legacy ``needs_human`` STATUS count is the "Awaiting analyst" tile (Round 13
        # close). The standup's model aggregate (``generate()``) is unchanged.
        snapshot = await state.standup_service.shift_snapshot(
            prefs, window_hours=window, now=now, needs_human_verdict=True
        )
    except Exception as exc:  # noqa: BLE001 — the handoff page must never 500
        logger.warning("shift report failed (%s); degrading", exc)
        snapshot = {}
    # Acknowledgements for THIS window (best-effort, newest first).
    acks: list[dict[str, Any]] = []
    store = getattr(state, "shift_handoff", None)
    if store is not None:
        try:
            acks = [a.model_dump(mode="json") for a in await store.list_acks(window=win_label)]
        except Exception as exc:  # noqa: BLE001
            logger.warning("ack list failed (%s); continuing", exc)
    return {
        "enabled": True,
        "window_hours": window,
        "window": win_label,
        "generated_at": now.isoformat(),
        "shift": snapshot,
        # Surfaced top-level too (the snapshot also carries these for the standup fold).
        "attention_queue": snapshot.get("attention_queue", []),
        "sla_aging": snapshot.get("sla_aging", {}),
        "workload": snapshot.get("workload", []),
        "deltas": snapshot.get("deltas", {}),
        "action_items": snapshot.get("action_items", []),
        "acknowledgements": acks,
        "degraded": not bool(snapshot),
    }


# --------------------------------------------------------------------------- #
# Action items (the cross-shift living attention queue)
# --------------------------------------------------------------------------- #
@router.get("/standup/action-items")
async def list_action_items(
    open_only: bool = False,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """List shift action items (newest-tracked first by creation order). Read inherits
    the router auth mount. Never 500s — a degraded store yields an empty list."""
    store = getattr(state, "shift_handoff", None)
    if store is None:
        return {"items": []}
    try:
        items = await store.list_action_items(open_only=open_only)
    except Exception as exc:  # noqa: BLE001
        logger.warning("list action items failed (%s)", exc)
        return {"items": []}
    return {"items": [i.model_dump(mode="json") for i in items]}


@router.post("/standup/action-items")
async def create_action_item(
    body: ActionItemCreate,
    state: AppState = Depends(get_state),
    _=Depends(require_permission(*_WRITE)),
) -> dict[str, Any]:
    """Add a follow-up to the cross-shift attention queue. ``title``/``note`` are plain
    data (#9). Returns the stored item."""
    store = _handoff(state)
    item = await store.add_action_item(
        body.title, owner=body.owner, note=body.note, status=body.status
    )
    return {"item": item.model_dump(mode="json")}


@router.put("/standup/action-items/{item_id}")
async def update_action_item(
    item_id: str,
    body: ActionItemUpdate,
    state: AppState = Depends(get_state),
    _=Depends(require_permission(*_WRITE)),
) -> dict[str, Any]:
    """Patch an action item (title/owner/status/note). 404 if it does not exist."""
    store = _handoff(state)
    patch = body.model_dump(exclude_none=True)
    updated = await store.update_action_item(item_id, **patch)
    if updated is None:
        raise HTTPException(status_code=404, detail="action item not found")
    return {"item": updated.model_dump(mode="json")}


@router.delete("/standup/action-items/{item_id}")
async def delete_action_item(
    item_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission(*_WRITE)),
) -> dict[str, Any]:
    """Delete an action item. ``{ok: true}`` if it existed, else 404."""
    store = _handoff(state)
    ok = await store.delete_action_item(item_id)
    if not ok:
        raise HTTPException(status_code=404, detail="action item not found")
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Shift acknowledgements (append-only)
# --------------------------------------------------------------------------- #
@router.post("/standup/acknowledge")
async def acknowledge_handoff(
    body: AcknowledgeBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission(*_WRITE)),
) -> dict[str, Any]:
    """Record one analyst's acknowledgement of a handoff ``window`` (append-only). The
    acking user is the authenticated principal (``"operator"`` when auth is off).
    ``note`` is plain data (#9). Returns the stored ack."""
    store = _handoff(state)
    user = current_username(request) or "operator"
    window = body.window.strip() or _current_window()
    ack = await store.acknowledge(user, window, note=body.note)
    return {"ack": ack.model_dump(mode="json")}


@router.get("/standup/acknowledgements")
async def list_acknowledgements(
    window: str | None = None,
    user: str | None = None,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The acknowledgement log (newest first), optionally filtered by ``window`` /
    ``user``. Read inherits the router auth mount. Never 500s."""
    store = getattr(state, "shift_handoff", None)
    if store is None:
        return {"acknowledgements": [], "window": window or ""}
    try:
        acks = await store.list_acks(window=window, user=user)
    except Exception as exc:  # noqa: BLE001
        logger.warning("list acknowledgements failed (%s)", exc)
        return {"acknowledgements": [], "window": window or ""}
    return {
        "acknowledgements": [a.model_dump(mode="json") for a in acks],
        "window": window or "",
    }
