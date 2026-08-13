"""In-app notification inbox + per-user delivery prefs (Feature 8 / Round 3 Wave 2).

A SEPARATE ``/api`` router (mounted by the integrator) for the operator's IN-APP
notification inbox and their per-user notification preferences. Every route is
SELF-SCOPED: it reads/writes ONLY the requesting user's bucket (keyed by
``current_username``; ``''`` → the shared ``default`` bucket when auth is off). There
is no admin/other-user surface here — a user manages their OWN inbox — so the
non-GET routes gate on ``inapp:read`` (every role holds it) + self-scope rather than
an admin grant.

Non-negotiables: the inbox is advisory (#3 — never feeds ``decide()``); titles/bodies
are plain, render-escaped data (#9 — the dispatcher/renderer already escaped every
case/log value); no secrets are read or returned (#10).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..models import NotificationPref
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.inapp")


async def _visible_inbox_items(
    state: AppState,
    user: str,
    *,
    unread_only: bool = False,
) -> list:
    inbox = getattr(state, "inbox", None)
    if inbox is None:
        return []
    items, _ = await inbox.list_for_user(
        user, unread_only=unread_only, limit=0, offset=0
    )
    from ..engine.batch_inbox import filter_visible_batch_notes

    return await filter_visible_batch_notes(state, user, items)


def _public_item(item) -> dict[str, Any]:
    from ..engine.batch_inbox import public_inbox_item

    return public_inbox_item(item)

# Own router; the integrator mounts it with ``Depends(require_auth)`` like the
# monolith, so GET routes inherit the auth gate. Same prefix as the monolith so the
# paths read ``/api/notifications/inbox*`` (no collision with the existing
# /api/notifications/{providers,preview,test,channels/...} routes).

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Inbox (per-user, self-scoped).
# --------------------------------------------------------------------------- #
@router.get("/notifications/inbox")
async def get_inbox(
    request: Request,
    unread_only: bool = False,
    limit: int = 50,
    offset: int = 0,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The CURRENT user's inbox, NEWEST first, paginated. ``unread_only`` filters to
    not-yet-read items; archived items are excluded from the default view. Self-scoped
    by ``current_username`` — a user can only ever see their own inbox."""
    user = current_username(request)
    inbox = getattr(state, "inbox", None)
    if inbox is None:
        return {"items": [], "total": 0, "limit": _bound_limit(limit), "offset": max(0, offset)}
    lim = _bound_limit(limit)
    off = max(0, int(offset or 0))
    visible = await _visible_inbox_items(state, user, unread_only=unread_only)
    total = len(visible)
    items = visible[off : off + lim]
    return {
        "items": [_public_item(n) for n in items],
        "total": total,
        "limit": lim,
        "offset": off,
        "unread_only": bool(unread_only),
    }


@router.get("/notifications/inbox/unread-count")
async def get_unread_count(
    request: Request,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The CURRENT user's unread badge count (``state in {unseen, seen}``)."""
    user = current_username(request)
    inbox = getattr(state, "inbox", None)
    count = len(await _visible_inbox_items(state, user, unread_only=True)) if inbox is not None else 0
    return {"unread": int(count)}


@router.post("/notifications/inbox/{notification_id}/read")
async def mark_inbox_read(
    notification_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> dict[str, Any]:
    """Mark ONE of the current user's inbox items read (self-scoped). 404-style
    ``ok=False`` when the id isn't in the caller's inbox."""
    user = current_username(request)
    inbox = getattr(state, "inbox", None)
    if inbox is None:
        return {"ok": False, "detail": "inbox unavailable"}
    visible = await _visible_inbox_items(state, user)
    if not any(item.id == notification_id for item in visible):
        return {"ok": False, "detail": "not found"}
    updated = await inbox.mark_read(user, notification_id)
    if updated is None:
        return {"ok": False, "detail": "not found"}
    return {"ok": True, "item": _public_item(updated)}


@router.post("/notifications/inbox/read-all")
async def mark_inbox_read_all(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> dict[str, Any]:
    """Mark EVERY not-yet-read item in the current user's inbox read."""
    user = current_username(request)
    inbox = getattr(state, "inbox", None)
    count = 0
    if inbox is not None:
        for item in await _visible_inbox_items(state, user, unread_only=True):
            if await inbox.mark_read(user, item.id) is not None:
                count += 1
    return {"ok": True, "marked": int(count)}


@router.post("/notifications/inbox/{notification_id}/dismiss")
async def dismiss_inbox_item(
    notification_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> dict[str, Any]:
    """Permanently DROP one item from the current user's inbox (self-scoped)."""
    user = current_username(request)
    inbox = getattr(state, "inbox", None)
    if inbox is None:
        return {"ok": False, "detail": "inbox unavailable"}
    visible = await _visible_inbox_items(state, user)
    if not any(item.id == notification_id for item in visible):
        return {"ok": False, "dismissed": False}
    existed = await inbox.dismiss(user, notification_id)
    return {"ok": bool(existed), "dismissed": bool(existed)}


# --------------------------------------------------------------------------- #
# Per-user notification preferences (self-scoped).
# --------------------------------------------------------------------------- #
class NotificationPrefBody(BaseModel):
    """The PUT body for a user's own notification prefs (the ``user`` field is forced
    to the requester server-side — a caller can never write another user's bucket)."""

    model_config = {"protected_namespaces": ()}

    categories: dict[str, Any] = Field(default_factory=dict)
    quiet_hours: dict[str, Any] | None = None
    digest: str | None = None


@router.get("/notifications/prefs")
async def get_notif_prefs(
    request: Request,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The CURRENT user's notification prefs (a sane default when nothing is stored —
    every category in-app, no quiet-hours, digest off)."""
    user = current_username(request)
    store = getattr(state, "notif_prefs", None)
    if store is None:
        return NotificationPref(user=(user or "default")).model_dump(mode="json")
    pref = await store.get(user)
    return pref.model_dump(mode="json")


@router.put("/notifications/prefs")
async def put_notif_prefs(
    body: NotificationPrefBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> dict[str, Any]:
    """Replace the CURRENT user's notification prefs (self-scoped; ``user`` is forced
    to the requester so a caller can never write another bucket)."""
    user = current_username(request)
    store = getattr(state, "notif_prefs", None)
    pref = NotificationPref(
        user=(user or "default"),
        categories=body.categories or {},
        quiet_hours=body.quiet_hours,
        digest=body.digest,
    )
    if store is None:
        return pref.model_dump(mode="json")
    saved = await store.put(user, pref)
    return saved.model_dump(mode="json")


def _bound_limit(limit: int) -> int:
    """Clamp a page size to a sane, bounded window (the inbox ring caps at 200)."""
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 50
    if n <= 0:
        return 50
    return min(n, 200)
