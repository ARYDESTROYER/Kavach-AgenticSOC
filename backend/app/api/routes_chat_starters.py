"""Chat starter routes (Round 13, ``docs/research/2026-10-round13/SPEC-chat.md`` §3.2.2),
auto-discovered by ``main.py``.

* ``GET  /api/chat/starters?surface=home|thread|case&conversation_id=&case_id=`` — the
  caller's starter cards, catch-up line or Case Manager chips (``ChatStartersInfo``),
  computed by code from the suite's own state under the caller's grants
  (``engine.chat_starters.build_starters``). A pure read: it writes nothing, calls no
  model, writes no audit row and no UsageDoc (#2 presentation state, #6). Always 200
  for an authorised caller: a failing family is skipped and a total failure returns the
  evergreen set. ``surface=thread`` needs a conversation the caller owns and
  ``surface=case`` a case the caller can read; anything else is 404 (never another
  owner's existence). Cached per caller for ``CACHE_TTL_S`` seconds under a key that
  includes the caller's grants, the surface and ids, Demo Mode, the operator time zone,
  the organisation switch and the revision of the caller's starter state, so a
  dismissal is visible on the next read. A degraded build (a family raised or timed
  out, a shared read failed) is served but not cached.
* ``POST /api/chat/starters/events`` (``ChatStarterEvent``) — ``viewed``, ``used`` or
  ``dismissed`` with up to 6 opaque keys (204). It updates only the caller's own starter
  state (visit clock, per-key view counts, "hide for a day"); no audit row, like
  ``POST /api/chat/turns/{id}/seen``. Keys resolve to families from what this server
  served the caller (plus the fixed keys of cards without a reference); an unknown key
  is ignored. At most :data:`EVENTS_PER_MINUTE` events per caller per minute, then 429
  with ``Retry-After``.

Both require ``cases:read`` like every chat route; the POST is CSRF-checked like every
other state-changing request. Nothing here stores question text, a value or an answer
(D10): the state document holds family ids, opaque keys, counters and timestamps only.
"""

from __future__ import annotations

import logging
import math
import time
import weakref
from collections import OrderedDict, deque
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from ..agents import chat_starter_text as text
from ..engine.chat_starters import (
    CACHE_TTL_S,
    BuildStatus,
    EVERGREEN_FAMILIES,
    FAMILY_ORDER,
    ONBOARDING_FAMILIES,
    StarterUserState,
    build_starters,
    record_dismissed,
    record_used,
    record_viewed,
    starter_key,
)
from ..models import ChatStarterEvent, ChatStartersInfo, StarterSurface
from ..state import AppState
from ..stores.chat_conversations import ChatHistoryUnavailable, normalize_user_id
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.chat_starters")

router = APIRouter(prefix="/api")

_SAFE_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,128}$"
#: Events a caller may post per minute (§3.2.2); the next one is 429.
EVENTS_PER_MINUTE = 30
EVENT_WINDOW_S = 60.0
#: Bounds of the process-local caches (oldest evicted first).
MAX_CACHED_ANSWERS = 512
MAX_SERVED_KEYS_PER_OWNER = 64
MAX_TRACKED_OWNERS = 4096

#: The clock of the response cache and the rate bound (tests replace it).
_monotonic = time.monotonic


class _StarterRuntime:
    """Process-local, per-AppState bookkeeping: the response cache, the keys each
    owner was served (key → family, so an event never names a family itself) and
    the per-owner event rate. Bounded; nothing here is persisted."""

    def __init__(self) -> None:
        self.answers: OrderedDict[tuple[Any, ...], tuple[float, ChatStartersInfo]] = OrderedDict()
        self.served: OrderedDict[str, OrderedDict[str, str]] = OrderedDict()
        self.events: OrderedDict[str, deque[float]] = OrderedDict()

    # ---- the response cache --------------------------------------------------- #
    def cached(self, key: tuple[Any, ...]) -> ChatStartersInfo | None:
        hit = self.answers.get(key)
        if hit is None:
            return None
        expires, info = hit
        if _monotonic() >= expires:
            self.answers.pop(key, None)
            return None
        self.answers.move_to_end(key)
        return info

    def store(self, key: tuple[Any, ...], info: ChatStartersInfo) -> None:
        self.answers[key] = (_monotonic() + float(CACHE_TTL_S), info)
        self.answers.move_to_end(key)
        while len(self.answers) > MAX_CACHED_ANSWERS:
            self.answers.popitem(last=False)

    # ---- served keys ------------------------------------------------------------ #
    def remember(self, owner: str, info: ChatStartersInfo) -> None:
        starters = list(info.starters)
        if info.catch_up is not None:
            starters.extend(clause.starter for clause in info.catch_up.clauses)
        keys = self.served.get(owner)
        if keys is None:
            keys = self.served[owner] = OrderedDict()
        for starter in starters:
            if starter.key:
                keys[starter.key] = starter.id
                keys.move_to_end(starter.key)
        while len(keys) > MAX_SERVED_KEYS_PER_OWNER:
            keys.popitem(last=False)
        self.served.move_to_end(owner)
        while len(self.served) > MAX_TRACKED_OWNERS:
            self.served.popitem(last=False)

    def family_of(self, owner: str, key: str) -> str | None:
        family = (self.served.get(owner) or {}).get(key)
        return family or _FIXED_KEYS.get(key)

    # ---- the event rate ----------------------------------------------------------- #
    def admit(self, owner: str) -> float | None:
        """None when the event may run, else the seconds until the next one may."""
        now = _monotonic()
        window = self.events.get(owner)
        if window is None:
            window = self.events[owner] = deque()
        while window and now - window[0] >= EVENT_WINDOW_S:
            window.popleft()
        self.events.move_to_end(owner)
        while len(self.events) > MAX_TRACKED_OWNERS:
            self.events.popitem(last=False)
        if len(window) >= EVENTS_PER_MINUTE:
            return max(0.0, EVENT_WINDOW_S - (now - window[0]))
        window.append(now)
        return None


#: Every card that names no reference has a fixed key (``starter_key(family)``), so a
#: key the server cannot have forgotten still resolves (the evergreen set, the count
#: forms, the case chips).
_FIXED_KEYS: dict[str, str] = {
    starter_key(family): family
    for family in (*FAMILY_ORDER, *EVERGREEN_FAMILIES, *ONBOARDING_FAMILIES, *text.CASE_CHIP_TEMPLATES)
}
_RUNTIMES: "weakref.WeakKeyDictionary[Any, _StarterRuntime]" = weakref.WeakKeyDictionary()


def starter_runtime(state: AppState) -> _StarterRuntime:
    runtime = _RUNTIMES.get(state)
    if runtime is None:
        runtime = _RUNTIMES[state] = _StarterRuntime()
    return runtime


def _not_found(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"code": code, "message": message})


def _unavailable() -> HTTPException:
    return HTTPException(status_code=503, detail={
        "code": "chat_suggestions_unavailable", "message": "Chat suggestions are temporarily unavailable.",
    })


@router.get("/chat/starters", response_model=ChatStartersInfo)
async def chat_starters(
    request: Request,
    surface: StarterSurface = Query(default="home"),
    conversation_id: str | None = Query(default=None, max_length=128, pattern=_SAFE_ID_PATTERN),
    case_id: str | None = Query(default=None, min_length=1, max_length=128),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatStartersInfo:
    """The caller's starters for ``surface`` (see the module docstring)."""
    username = current_username(request)
    owner = normalize_user_id(username)
    if surface == "thread":
        if not conversation_id:
            raise _not_found("conversation_not_found", "That conversation was not found.")
        try:
            owned = await state.chat_conversations.exists(username, conversation_id)
        except ChatHistoryUnavailable as exc:
            raise _unavailable() from exc
        if not owned:
            raise _not_found("conversation_not_found", "That conversation was not found.")
    else:
        conversation_id = None
    if surface == "case":
        if not case_id:
            raise _not_found("case_not_found", "That case was not found.")
        try:
            case = await state.cases.get(case_id)
        except Exception as exc:  # noqa: BLE001 -- the case store did not answer
            raise _unavailable() from exc
        if case is None:
            raise _not_found("case_not_found", "That case was not found.")
    else:
        case_id = None

    try:
        user_state = await state.chat_starters.load(username)
    except Exception as exc:  # noqa: BLE001 -- unreadable state: the first-visit view
        logger.warning("chat starters: state not read (%s)", type(exc).__name__)
        user_state = StarterUserState()
    grants = await state.chat_grants(request)
    prefs = state.execution_prefs
    key = (
        owner, grants, surface, conversation_id, case_id, bool(state.demo_active),
        getattr(getattr(prefs, "sla", None), "timezone", None),
        bool(getattr(getattr(prefs, "chat_agent", None), "dynamic_starters", True)),
        user_state.rev,
    )
    runtime = starter_runtime(state)
    cached = runtime.cached(key)
    if cached is not None:
        return cached
    status = BuildStatus()
    info = await build_starters(
        state, request, surface=surface, conversation_id=conversation_id, case_id=case_id,
        user_state=user_state, status=status,
    )
    if not status.degraded:  # a transient overrun is never pinned for CACHE_TTL_S
        runtime.store(key, info)
    runtime.remember(owner, info)
    return info


@router.post("/chat/starters/events", status_code=204, response_class=Response)
async def chat_starter_event(
    body: ChatStarterEvent,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Response:
    """Record that the caller saw, used or hid starters (see the module docstring)."""
    username = current_username(request)
    owner = normalize_user_id(username)
    runtime = starter_runtime(state)
    wait = runtime.admit(owner)
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail={"code": "chat_suggestions_busy", "message": "Too many suggestion updates; try again shortly."},
            headers={"Retry-After": str(max(1, math.ceil(wait)))},
        )
    mapped: list[tuple[str, str]] = []
    for key in dict.fromkeys(body.keys):
        family = runtime.family_of(owner, key)
        if family is not None:
            mapped.append((key, family))
    now = datetime.now(timezone.utc)
    if body.type == "viewed":
        def change(current: StarterUserState) -> StarterUserState:
            return record_viewed(current, now, mapped)
    elif body.type == "used":
        if not mapped:
            return Response(status_code=204)

        def change(current: StarterUserState) -> StarterUserState:
            return record_used(current, now, mapped)
    else:
        if not mapped:
            return Response(status_code=204)
        families = list(dict.fromkeys(family for _key, family in mapped))

        def change(current: StarterUserState) -> StarterUserState:
            return record_dismissed(current, now, families)
    try:
        await state.chat_starters.update(username, change)
    except ChatHistoryUnavailable as exc:
        raise _unavailable() from exc
    return Response(status_code=204)


__all__ = [
    "EVENTS_PER_MINUTE",
    "MAX_CACHED_ANSWERS",
    "router",
    "starter_runtime",
]
