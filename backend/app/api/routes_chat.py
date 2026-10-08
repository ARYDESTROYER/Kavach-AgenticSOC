"""Chat turn routes: streaming, Stop, the live token meter and "Ask about this".

Chat revamp SPEC §6 (streaming lifecycle, events, Stop and recovery), §4.2
(concurrency bounds), §4.5 (first-call failures), §4.6 (the case-scoped entry
point), §8 (``/chat/context``), §10.5 (starters) and §10.7 (topics).

ONE engine, two entry points (#5): ``POST /api/chat`` (blocking, in ``routes.py``)
and ``POST /api/chat/stream`` (NDJSON) both call :func:`run_chat_turn`, which

1. runs every check that can fail BEFORE a response starts — auth (the route
   dependency), the caller's grants (``resolve_grants``: no audit rows), the
   per-user and global concurrency admission (429 ``chat_busy``), body validation
   (model choice), the conversation lookup, the idempotency reservation (including
   the completed-key replay) and source resolution — so a stream never answers 200
   and then fails on something the blocking route reports as an HTTP error;
2. starts the turn as a task in the process-local :class:`ChatTurnRegistry`. The
   task owns the reservation, the per-request source client and persistence, and
   holds ``state.mutation_gate.admit()`` for its whole life; the HTTP response only
   relays its queue. A client that disconnects does not stop the turn: it completes,
   persists, and a retry with the same key replays it (409 + ``retry_after`` until
   then). Stop is server-side (``POST /api/chat/turns/{id}/cancel``). A factory reset
   cancels every registered turn before draining; such a turn persists nothing.

Persistence (SPEC §7.5) is the store's job; this module decides WHAT is saved: the
D1 rule (a first model call that failed before anything was billed is answered with
its notice and saves nothing), Stop (saved once a model call was billed, so a retry
replays it; aborted otherwise), the user message's ``origin`` (taint rules replay it)
and the conversation's last time window. Case-scoped turns never enter Workspace
history; their case-thread append is deduplicated by the idempotency key inside the
engine, and they are not auto-replayed by the client after a lost connection (a
replay would bill the model again; the client offers Retry instead).
"""

from __future__ import annotations

import asyncio
import functools
import logging
import math
import re
import time
from dataclasses import dataclass, field, is_dataclass, replace
from typing import Any, AsyncIterator, Iterable

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from ..agents.chat import TurnOutcome
from ..agents.chat_events import (
    NDJSON_CONTENT_TYPE,
    PING_INTERVAL_S,
    STREAM_HEADERS,
    ChatStreamEventModel,
    PingEvent,
    TurnDoneEvent,
    TurnErrorEvent,
    TurnStartEvent,
    encode_event,
)
from ..agents.chat_protocol import PriorExchange, render_replay, select_replay, turn_error_code
from ..config import ModelConfig, Preferences
from ..constants import OPEN_CASE_STATUSES, ActionType
from ..engine.mutation_gate import MutationAdmissionClosed
from ..models import (
    CHAT_TOPIC_MAX_CHARS,
    CONSOLE_TOPIC_ID_PATTERN,
    ChatBudgetInfo,
    ChatContextBounds,
    ChatContextInfo,
    ChatConversation,
    ChatRates,
    ChatRequest,
    ChatResponse,
    ChatStarter,
    ChatTopicQuestion,
    DiscoverLink,
    TextStreamingInfo,
)
from ..state import AppState, ChatSourceUnavailable
from ..stores.chat_conversations import (
    ChatConversationMissing,
    ChatExchangeReservation,
    ChatHistoryUnavailable,
    ChatIdempotencyConflict,
    ChatRequestCapacityBusy,
    ChatRequestInProgress,
    normalize_user_id,
)
from ..utils import new_id
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.chat")

router = APIRouter(prefix="/api")

# --------------------------------------------------------------------------- #
# Constants.
# --------------------------------------------------------------------------- #
# Seconds a client should wait before retrying a refused turn. Busy (429) waits for
# a running turn to finish; in-progress (409) polls for the replay to appear.
CHAT_BUSY_RETRY_AFTER_S = 5
IN_PROGRESS_RETRY_AFTER_S = 2
# The idle interval between ``ping`` lines (module-level so tests can shorten it).
STREAM_PING_INTERVAL_S: float = float(PING_INTERVAL_S)
# /chat/context is cached per principal (SPEC §8) and invalidated when a turn ends.
CONTEXT_CACHE_TTL_S = 30.0
CONTEXT_CACHE_MAX_ENTRIES = 512
# The meter's calibration is a ratio; one odd turn must not swing it wildly.
CALIBRATION_BOUNDS = (0.25, 4.0)
CHARS_PER_TOKEN = 4
STARTER_WINDOW = "last 24h"
# Response fields that are presentation-only metadata, kept with the stored answer
# so the meter can calibrate against this conversation's last turn.
ESTIMATE_KEY = "estimate_prompt_tokens"

_SAFE_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,128}$"
_SAFE_ID_RE = re.compile(_SAFE_ID_PATTERN)
_TOPIC_ID_PATTERN = CONSOLE_TOPIC_ID_PATTERN
_CASE_REF_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_PROVIDERS = frozenset({"anthropic", "openai", "mock", "azure", "bedrock", "vertex", "openai_compatible"})
_RESET_MESSAGE = "A maintenance reset stopped this answer before it was saved. Try again shortly."
_INTERNAL_MESSAGE = "The answer could not be completed. Try again."
_HISTORY_MESSAGE = "The answer was written but could not be saved to your history. Try again."
# A billed answer whose save failed keeps its reservation (SPEC §6.4: never aborted
# once billed), so the same key only waits; the honest next step is a new request.
_HISTORY_BILLED_MESSAGE = (
    "The answer was written but could not be saved to your history. "
    "Ask again to start a new request."
)
_BILLED_INTERNAL_MESSAGE = "The answer could not be completed. Ask again to start a new request."
_CONFLICT_MESSAGE = "The conversation changed while the response was being saved."

_END = object()  # queue sentinel: the turn task finished


# --------------------------------------------------------------------------- #
# The turn registry (process-local; SPEC §4.2, §6.1(b), §6.4).
# --------------------------------------------------------------------------- #
class ChatTurnBusy(RuntimeError):
    """A per-user or global concurrency bound is reached (HTTP 429 ``chat_busy``)."""

    def __init__(self, scope: str) -> None:
        super().__init__(scope)
        self.scope = scope


@dataclass(eq=False)
class ChatTurnHandle:
    """One running turn: its event queue, Stop flag and outcome.

    The task appends events; the stream response relays them. ``detached`` is set
    once the response stopped reading (client gone), after which events are dropped
    rather than queued for nobody. ``response`` is the final (persisted) response,
    ``error`` the terminal ``turn.error`` and ``http_error`` what the blocking route
    raises for it."""

    turn_id: str
    owner: str
    idempotency_key: str | None = None
    case_id: str | None = None
    # What a synthesised ``turn.start`` names when the turn fails before the engine
    # emitted its own (SPEC §6.2: ``turn.start`` is always the first line).
    conversation_id: str | None = None
    model: str | None = None
    stream_mode: str = "steps"
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    detached: bool = False
    reset_cancelled: bool = False
    # Set on the first line of the task body. A task cancelled BEFORE that never runs
    # its try/finally (CancelledError is thrown into an unstarted coroutine), so
    # ``cancel_all`` only hard-cancels running turns and flags the others.
    running: bool = False
    start_sent: bool = False
    response: ChatResponse | None = None
    error: TurnErrorEvent | None = None
    http_error: HTTPException | None = None
    started: float = field(default_factory=time.monotonic)

    def emit(self, event: BaseModel) -> None:
        if isinstance(event, TurnStartEvent):
            self.start_sent = True
        if not self.detached:
            self.queue.put_nowait(event)

    def done(self, response: ChatResponse) -> None:
        """The terminal ``turn.done`` (the persisted response is the truth)."""
        self.response = response
        self.emit(TurnDoneEvent(response=response))

    def fail(
        self, code: str, message: str, *, retryable: bool, http: HTTPException | None,
        notice: Any = None, response: ChatResponse | None = None,
    ) -> None:
        """The terminal ``turn.error``. ``response`` is what the blocking route still
        answers with (the D1 notice response); ``http`` what it raises otherwise."""
        if self.error is not None or (self.response is not None and response is None):
            return
        if not self.start_sent:
            # The turn failed before the engine's first event (a reset racing the
            # start, an unreadable stored history): the stream still opens with
            # ``turn.start`` so the client learns the turn id (Stop) and the contract
            # "turn.start first, turn.done/turn.error last" holds.
            self.emit(TurnStartEvent(
                turn_id=self.turn_id, conversation_id=self.conversation_id, model=self.model,
                stream_mode=self.stream_mode if self.stream_mode in ("steps", "text") else "steps",
            ))
        self.error = TurnErrorEvent(code=code, message=message, retryable=retryable, notice=notice)
        self.http_error = http
        if response is not None:
            self.response = response
        self.emit(self.error)

    def finish(self) -> None:
        if not self.finished.is_set():
            self.finished.set()
            self.queue.put_nowait(_END)


class _Slot:
    """One admitted concurrency slot, released exactly once."""

    def __init__(self, registry: "ChatTurnRegistry", owner: str) -> None:
        self._registry = registry
        self._owner = owner
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._registry.release(self._owner)


class ChatTurnRegistry:
    """Strong references to every running chat turn, plus admission and Stop.

    Process-local by design (SPEC §4.2: "process-local semaphore registry"): the
    supported runtime is one backend process. Counting is synchronous, so an admit
    check and its increment can never interleave with another request."""

    def __init__(self) -> None:
        self._turns: dict[str, ChatTurnHandle] = {}
        self._per_owner: dict[str, int] = {}
        self._active = 0
        # Strong references to the cleanup a turn task needs when it ended without
        # running its own ``finally`` (see ``_on_turn_task_done``).
        self._cleanups: set[asyncio.Task] = set()
        # /chat/context cache: key -> (expires monotonic, info). Lives here so it is
        # per AppState and is invalidated when one of the owner's turns ends.
        self.context_cache: dict[tuple[Any, ...], tuple[float, ChatContextInfo]] = {}

    # --- admission ---------------------------------------------------------- #
    def acquire(self, owner: str, *, per_user: int, global_limit: int) -> _Slot:
        if self._active >= max(1, int(global_limit)):
            raise ChatTurnBusy("global")
        if self._per_owner.get(owner, 0) >= max(1, int(per_user)):
            raise ChatTurnBusy("user")
        self._per_owner[owner] = self._per_owner.get(owner, 0) + 1
        self._active += 1
        return _Slot(self, owner)

    def release(self, owner: str) -> None:
        count = self._per_owner.get(owner, 0) - 1
        if count > 0:
            self._per_owner[owner] = count
        else:
            self._per_owner.pop(owner, None)
        self._active = max(0, self._active - 1)

    @property
    def active(self) -> int:
        return self._active

    def active_for(self, owner: str) -> int:
        return self._per_owner.get(owner, 0)

    # --- turns -------------------------------------------------------------- #
    def register(self, handle: ChatTurnHandle) -> None:
        self._turns[handle.turn_id] = handle

    def unregister(self, handle: ChatTurnHandle) -> None:
        if self._turns.get(handle.turn_id) is handle:
            self._turns.pop(handle.turn_id, None)

    def get(self, turn_id: str) -> ChatTurnHandle | None:
        return self._turns.get(turn_id)

    def running(self) -> list[ChatTurnHandle]:
        return list(self._turns.values())

    def request_stop(self, turn_id: str, owner: str) -> bool:
        """Set the Stop flag of the caller's own running turn (SPEC §6.4). The
        in-flight step finishes and is recorded; no new step starts."""
        handle = self._turns.get(turn_id)
        if handle is None or handle.owner != owner or handle.finished.is_set():
            return False
        handle.cancel_event.set()
        return True

    def track_cleanup(self, task: asyncio.Task) -> None:
        self._cleanups.add(task)
        task.add_done_callback(self._cleanups.discard)

    async def cancel_all(self, *, timeout: float = 10.0) -> int:
        """Stop every registered turn (factory reset, shutdown) and wait, bounded, for
        each to abort its reservation and release its resources.

        A RUNNING turn is hard-cancelled: CancelledError lands at its current await,
        inside its try, so it aborts and settles. A turn whose task has not taken its
        first step is only flagged: cancelling it would throw CancelledError into a
        coroutine that never entered its try/finally, leaving its slot, registration,
        reservation and waiting clients behind. On its first step it sees the flag and
        takes the same abort path a closed gate gives it."""
        handles = [h for h in self._turns.values() if h.task is not None and not h.task.done()]
        for handle in handles:
            handle.reset_cancelled = True
            if handle.running:
                handle.task.cancel()  # type: ignore[union-attr]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.1, timeout)
        if handles:
            await asyncio.wait([h.task for h in handles], timeout=max(0.1, deadline - loop.time()))  # type: ignore[misc]
        # Let the done-callback cleanup of any task that never ran its body finish too.
        cleanups = [task for task in self._cleanups if not task.done()]
        if cleanups:
            await asyncio.wait(cleanups, timeout=max(0.1, deadline - loop.time()))
        return len(handles)

    # --- /chat/context cache ------------------------------------------------ #
    def context_get(self, key: tuple[Any, ...]) -> ChatContextInfo | None:
        entry = self.context_cache.get(key)
        if entry is None:
            return None
        if entry[0] < time.monotonic():
            self.context_cache.pop(key, None)
            return None
        return entry[1]

    def context_put(self, key: tuple[Any, ...], info: ChatContextInfo) -> None:
        if len(self.context_cache) >= CONTEXT_CACHE_MAX_ENTRIES:
            oldest = min(self.context_cache, key=lambda k: self.context_cache[k][0])
            self.context_cache.pop(oldest, None)
        self.context_cache[key] = (time.monotonic() + CONTEXT_CACHE_TTL_S, info)

    def invalidate_context(self, owner: str) -> None:
        for key in [k for k in self.context_cache if k and k[0] == owner]:
            self.context_cache.pop(key, None)


# --------------------------------------------------------------------------- #
# HTTP error shapes.
# --------------------------------------------------------------------------- #
def _history_http(exc: Exception | None = None) -> HTTPException:
    return HTTPException(status_code=503, detail={
        "code": "chat_history_unavailable",
        "message": (str(exc) if exc else "") or "Chat history is temporarily unavailable.",
    })


def _conflict_http(code: str, message: str, *, retry_after: int | None = None) -> HTTPException:
    detail: dict[str, Any] = {"code": code, "message": message}
    headers = None
    if retry_after is not None:
        # The client reads the body (ApiError exposes no headers), proxies the header.
        detail["retry_after"] = retry_after
        headers = {"Retry-After": str(retry_after)}
    return HTTPException(status_code=409, detail=detail, headers=headers)


def _busy_http(exc: ChatTurnBusy) -> HTTPException:
    message = (
        "You already have the maximum number of chat answers running; wait for one to finish."
        if exc.scope == "user"
        else "The assistant is busy with other answers; try again shortly."
    )
    return HTTPException(
        status_code=429,
        detail={"code": "chat_busy", "message": message, "retry_after": CHAT_BUSY_RETRY_AFTER_S},
        headers={"Retry-After": str(CHAT_BUSY_RETRY_AFTER_S)},
    )


def _reset_http() -> HTTPException:
    return HTTPException(status_code=503, detail={
        "code": "factory_reset_in_progress", "message": _RESET_MESSAGE,
    })


def _internal_http() -> HTTPException:
    return HTTPException(status_code=500, detail={
        "code": "chat_internal_error", "message": _INTERNAL_MESSAGE,
    })


class _TurnFailure(Exception):
    """A mapped persistence failure inside the turn task."""

    def __init__(self, code: str, message: str, *, retryable: bool, http: HTTPException) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.http = http


# --------------------------------------------------------------------------- #
# Request identity and model choice (SPEC §3.1).
# --------------------------------------------------------------------------- #
def chat_request_fingerprint(body: ChatRequest) -> str:
    """The idempotency identity: ``routes._chat_request_fingerprint`` (one definition)."""
    from .routes import _chat_request_fingerprint

    return _chat_request_fingerprint(body)


async def _chat_model_config(state: AppState, model_id: str, base: ModelConfig) -> ModelConfig | None:
    """``base`` switched to ``model_id`` when it is an enabled chat model: a bundled
    model the registry declares ``chat`` for (provider from the registry, so custom,
    Azure, Bedrock and Vertex ids route correctly) or an operator-registered custom
    model (its provider and endpoint). None otherwise."""
    from ..llm.pricing import capability_state, provider_for

    if capability_state(model_id, "chat") == "declared":
        provider = provider_for(model_id)
        if provider in _PROVIDERS:
            return base.model_copy(update={"model": model_id, "provider": provider, "base_url": None})
    try:
        row = await state.custom_models.get_model(model_id)
    except Exception:  # noqa: BLE001 -- an unreadable catalogue enables nothing
        row = None
    if isinstance(row, dict):
        provider = str(row.get("provider") or "openai_compatible")
        if provider in _PROVIDERS:
            return base.model_copy(update={
                "model": model_id, "provider": provider, "base_url": row.get("base_url") or None,
            })
    return None


async def _effective_prefs(
    state: AppState, request: Request, body: ChatRequest, grants: frozenset[tuple[str, str]],
) -> Preferences:
    """The execution prefs with this turn's chat model (SPEC §3.1): the configured
    default, or ``body.model`` when it is an enabled chat model (else 422
    ``chat_model_unavailable``) and the caller holds ``models:read`` (else 403)."""
    prefs = state.execution_prefs
    model_id = (body.model or "").strip()
    if not model_id or model_id == prefs.chat_model.model:
        return prefs
    if ("models", "read") not in grants:
        try:
            await state.control_audit.record(
                action_type=ActionType.ACCESS_DENIED, surface="chat",
                actor=current_username(request) or "default",
                result_summary="denied a non-default chat model (requires models:read)",
            )
        except Exception:  # noqa: BLE001 -- the refusal stands without its row
            pass
        raise HTTPException(status_code=403, detail={
            "code": "chat_model_forbidden",
            "message": "Choosing a chat model requires the models:read permission.",
        })
    resolved = await _chat_model_config(state, model_id, prefs.chat_model)
    if resolved is None:
        raise HTTPException(status_code=422, detail={
            "code": "chat_model_unavailable",
            "message": "The selected model is not an enabled chat model.",
        })
    return prefs.model_copy(update={"chat_model": resolved})


# --------------------------------------------------------------------------- #
# Preflight.
# --------------------------------------------------------------------------- #
@dataclass
class _TurnPlan:
    """Everything a turn task needs, resolved before any response starts."""

    body: ChatRequest
    author: str
    owner: str
    grants: frozenset[tuple[str, str]]
    prefs: Preferences
    engine: Any
    store: Any
    persist_workspace: bool
    request_key: str
    fingerprint: str
    existing: ChatConversation | None = None
    reservation: ChatExchangeReservation | None = None
    source_conn: Any = None
    owned_client: Any = None
    source_id: str | None = None
    source_name: str | None = None
    ctx: Any = None
    completed: bool = False
    replay: ChatResponse | None = None
    outcome: TurnOutcome | None = None

    @property
    def billed(self) -> bool:
        return bool(self.outcome is not None and self.outcome.billed)


@dataclass
class ChatTurnStart:
    """What :func:`run_chat_turn` started: a completed-key ``replay`` (no model call)
    or a running ``handle``."""

    replay: ChatResponse | None = None
    handle: ChatTurnHandle | None = None


def _replay_response(reservation: ChatExchangeReservation) -> ChatResponse:
    """A completed receipt as the response the original request returned, with its
    assistant ``message_id`` (SPEC §7.5)."""
    conversation = reservation.conversation
    assistant = reservation.assistant_message
    if assistant is None:
        raise _history_http(ChatHistoryUnavailable("The completed chat response could not be restored."))
    payload = dict(assistant.response or {})
    payload.update({
        "answer": assistant.content,
        "conversation_id": reservation.conversation_id,
        "conversation_title": reservation.conversation_title
        or (conversation.title if conversation else "Conversation"),
        "idempotency_key": reservation.idempotency_key,
        "effective_model": assistant.model or (conversation.model if conversation else None),
        "effective_source_id": assistant.source_id or (conversation.source_id if conversation else None),
        "effective_source_name": assistant.source_name or (conversation.source_name if conversation else None),
        "truncated": bool(payload.get("truncated")),
        "message_id": assistant.id,
    })
    try:
        return ChatResponse.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 -- a corrupt durable receipt is a store failure
        raise _history_http(ChatHistoryUnavailable("The completed chat response is invalid.")) from exc


async def _abort(plan: _TurnPlan) -> None:
    """Release the reservation (nothing saved) — never raises."""
    reservation = plan.reservation
    if reservation is None or plan.completed or reservation.status != "reserved":
        return
    try:
        await plan.store.abort_exchange(
            plan.author, idempotency_key=plan.request_key,
            request_fingerprint=plan.fingerprint, lease_token=reservation.lease_token or "",
        )
    except Exception as exc:  # noqa: BLE001 -- the lease still expires on its own
        logger.warning("chat reservation abort failed (%s)", type(exc).__name__)
    plan.completed = True  # never aborted twice


async def _close_owned(plan: _TurnPlan) -> None:
    client, plan.owned_client = plan.owned_client, None
    if client is None:
        return
    try:
        await client.close()
    except Exception:  # noqa: BLE001
        pass


async def _prepare(
    request: Request, body: ChatRequest, state: AppState, *,
    author: str, owner: str, grants: frozenset[tuple[str, str]],
) -> _TurnPlan:
    """The synchronous preflight (SPEC §6.1(a)); raises the HTTP error the blocking
    route has always returned. Aborts its own reservation when a later step fails."""
    effective_case_id = body.case_id or (body.context.case_id if body.context else None)
    persist_workspace = bool(body.persist_conversation and not effective_case_id)
    prefs = await _effective_prefs(state, request, body, grants)
    plan = _TurnPlan(
        body=body, author=author, owner=owner, grants=grants, prefs=prefs,
        engine=state.chat_engine, store=state.chat_conversations,
        persist_workspace=persist_workspace,
        request_key=body.idempotency_key or new_id("chatreq-"),
        fingerprint=chat_request_fingerprint(body),
    )
    if persist_workspace and body.conversation_id:
        try:
            plan.existing = await plan.store.get(author, body.conversation_id)
        except ChatHistoryUnavailable as exc:
            raise _history_http(exc) from exc
        if plan.existing is None:
            raise HTTPException(status_code=404, detail="conversation not found")
    if persist_workspace:
        try:
            plan.reservation = await plan.store.reserve_exchange(
                author, idempotency_key=plan.request_key,
                request_fingerprint=plan.fingerprint, conversation_id=body.conversation_id,
            )
        except ChatHistoryUnavailable as exc:
            raise _history_http(exc) from exc
        except ChatRequestInProgress as exc:
            raise _conflict_http(
                "chat_request_in_progress", str(exc), retry_after=IN_PROGRESS_RETRY_AFTER_S,
            ) from exc
        except ChatRequestCapacityBusy as exc:
            raise _conflict_http("chat_request_capacity_busy", str(exc)) from exc
        except ChatIdempotencyConflict as exc:
            raise _conflict_http("chat_idempotency_conflict", str(exc)) from exc
        except ChatConversationMissing as exc:
            raise HTTPException(status_code=404, detail="conversation not found") from exc
        if plan.reservation.status == "completed":
            # A historical receipt replays even if its source was later disabled.
            plan.replay = _replay_response(plan.reservation)
            return plan
    try:
        # Resolved after the replay chance: a new execution rejects an unusable
        # explicit source, a completed one never needs it.
        try:
            conn, owned, sid, name = state.chat_source_connector(body.source_id)
        except ChatSourceUnavailable as exc:
            raise HTTPException(status_code=422, detail={
                "code": "chat_source_unavailable", "message": str(exc),
            }) from exc
        plan.source_conn, plan.owned_client, plan.source_id, plan.source_name = conn, owned, sid, name
        plan.ctx = await state.build_chat_tool_context(
            request, body, grants=grants, prefs=prefs, log_source=conn,
            source_id=body.source_id or None, case_id=effective_case_id,
        )
        if body.topic and is_dataclass(plan.ctx) and getattr(plan.ctx, "topic", None) != body.topic:
            # "Ask about this" (SPEC A7): the validated topic id reaches app_help and
            # the $0 Help Center answer for THIS turn only (never prompt text).
            plan.ctx = replace(plan.ctx, topic=body.topic)
    except BaseException:
        await _close_owned(plan)
        await _abort(plan)
        raise
    return plan


async def run_chat_turn(request: Request, body: ChatRequest, state: AppState) -> ChatTurnStart:
    """Shared by ``/chat`` and ``/chat/stream``: preflight, then start the turn task
    (or return the completed-key replay). Every failure here is an HTTP error."""
    author = current_username(request)
    owner = normalize_user_id(author)
    grants = await state.chat_grants(request)
    cfg = state.execution_prefs.chat_agent
    registry = state.chat_turns
    try:
        slot = registry.acquire(
            owner, per_user=cfg.max_concurrent_turns_per_user,
            global_limit=cfg.max_concurrent_turns_global,
        )
    except ChatTurnBusy as exc:
        raise _busy_http(exc) from exc
    started = False
    try:
        plan = await _prepare(request, body, state, author=author, owner=owner, grants=grants)
        if plan.replay is not None:
            return ChatTurnStart(replay=plan.replay)
        if state.mutation_gate.closed:
            await _close_owned(plan)
            await _abort(plan)
            raise _reset_http()
        handle = ChatTurnHandle(
            turn_id=new_id("turn-"), owner=owner,
            idempotency_key=plan.request_key if plan.persist_workspace else body.idempotency_key,
            case_id=plan.ctx.case_id if plan.ctx is not None else None,
            conversation_id=plan.reservation.conversation_id if plan.reservation is not None else None,
            model=plan.prefs.chat_model.model, stream_mode=body.stream_mode or "steps",
        )
        registry.register(handle)
        handle.task = asyncio.create_task(
            _turn_main(state, handle, plan, slot), name=f"chat-turn:{handle.turn_id}",
        )
        handle.task.add_done_callback(
            functools.partial(_on_turn_task_done, state, handle, plan, slot),
        )
        started = True
        return ChatTurnStart(handle=handle)
    finally:
        if not started:
            slot.release()


# --------------------------------------------------------------------------- #
# The turn task.
# --------------------------------------------------------------------------- #
def _replay_messages(conversation: ChatConversation | None) -> list[dict[str, Any]]:
    """Persisted messages as ``PriorExchange.from_messages`` input: decoded
    presentation on answers, the stored ``origin`` on user messages (§4.8)."""
    out: list[dict[str, Any]] = []
    for message in (conversation.messages if conversation else []):
        item: dict[str, Any] = {"role": message.role, "content": message.content, "id": message.id}
        if message.role == "assistant":
            item["response"] = message.response or {}
        else:
            origin = (message.response or {}).get("origin") if isinstance(message.response, dict) else None
            item["origin"] = origin if isinstance(origin, str) else "user"
        out.append(item)
    return out


def _with_legacy_discover(response: ChatResponse, body: ChatRequest, prefs: Preferences) -> ChatResponse:
    """``discover`` keeps its pre-revamp meaning (SPEC §3.2): the first successful
    log search of the turn as a Discover link over its effective window."""
    if response.discover is not None or not response.query:
        return response
    step = next(
        (s for s in response.steps if s.kind == "tool" and s.tool == "search_logs" and s.status == "ok"),
        None,
    )
    if step is None:
        return response
    params = step.params
    context_range = body.context.time_range if body.context and isinstance(body.context.time_range, dict) else {}
    default_from = body.time_range.from_ if body.time_range else (context_range.get("from") or "now-24h")
    default_to = body.time_range.to if body.time_range else (context_range.get("to") or "now")
    time_from = params.get("time_from") if isinstance(params.get("time_from"), str) else default_from
    time_to = params.get("time_to") if isinstance(params.get("time_to"), str) else default_to
    data_view = body.context.data_view if body.context and body.context.data_view else prefs.data_view_pattern
    try:
        link = DiscoverLink(
            query=response.query or "*", language="kuery", data_view_pattern=str(data_view),
            time_from=str(time_from or "now-24h"), time_to=str(time_to or "now"),
        )
    except Exception:  # noqa: BLE001 -- a convenience link, never a failed turn
        return response
    return response.model_copy(update={"discover": link})


async def _turn_main(state: AppState, handle: ChatTurnHandle, plan: _TurnPlan, slot: _Slot) -> None:
    handle.running = True  # from here on, a cancel lands inside the try below
    try:
        if handle.reset_cancelled:
            # ``cancel_all`` reached this turn before its first step (a reset or
            # shutdown racing the start): abort exactly like a closed gate would.
            raise MutationAdmissionClosed("chat turn stopped before it started")
        async with state.mutation_gate.admit():
            await _drive(state, handle, plan)
    except MutationAdmissionClosed:
        await _abort(plan)
        handle.fail("internal", _RESET_MESSAGE, retryable=True, http=_reset_http())
    except asyncio.CancelledError:
        # Reset or shutdown: nothing is persisted and the reservation is released so
        # a retry with the same key runs fresh.
        await _abort(plan)
        handle.fail("internal", _RESET_MESSAGE, retryable=True, http=_reset_http())
        raise
    except _TurnFailure as exc:
        # Saving failed after the turn ran. A billed turn keeps its reservation (it is
        # never aborted, SPEC §6.4): a retry waits for the lease instead of paying for
        # the same answer twice, so ``_drive`` marked such a failure not retryable.
        if not plan.billed:
            await _abort(plan)
        handle.fail(exc.code, exc.message, retryable=exc.retryable, http=exc.http)
    except Exception as exc:  # noqa: BLE001 -- the stream always ends with one terminal line
        logger.exception("chat turn %s failed (%s)", handle.turn_id, type(exc).__name__)
        if not plan.billed:
            await _abort(plan)
        # Billed but unsaved: the kept reservation would answer the same key with 409
        # until its lease expires, so only a new request (Ask again) helps.
        stuck = plan.billed and not plan.completed
        handle.fail(
            "internal", _BILLED_INTERNAL_MESSAGE if stuck else _INTERNAL_MESSAGE,
            retryable=not stuck, http=_internal_http(),
        )
    finally:
        try:
            await _close_owned(plan)
        finally:
            # Synchronous, so a cancel landing on the await above cannot skip it.
            _settle(state, handle, plan, slot)


def _settle(
    state: AppState, handle: ChatTurnHandle, plan: _TurnPlan, slot: _Slot, *, reset: bool = False,
) -> None:
    """Release the turn's capacity and registration and end its waiters. Idempotent
    and synchronous (it runs from ``finally`` and from a task done-callback)."""
    slot.release()
    registry = state.chat_turns
    registry.unregister(handle)
    registry.invalidate_context(plan.owner)
    if handle.response is None and handle.error is None:
        if reset or handle.reset_cancelled:
            handle.fail("internal", _RESET_MESSAGE, retryable=True, http=_reset_http())
        else:
            handle.fail("internal", _INTERNAL_MESSAGE, retryable=True, http=_internal_http())
    handle.finish()


def _on_turn_task_done(
    state: AppState, handle: ChatTurnHandle, plan: _TurnPlan, slot: _Slot, task: asyncio.Task,
) -> None:
    """Belt and braces for a turn task that ended WITHOUT running its own body — it
    was cancelled before its first step by something other than ``cancel_all`` (an
    event-loop shutdown cancelling every task, say). Its ``finally`` never ran, so
    capacity is released here at once and the reservation abort and client close run
    in a tracked cleanup task before the stream and blocking waiters are released."""
    if handle.finished.is_set():
        return
    slot.release()
    registry = state.chat_turns
    registry.unregister(handle)

    async def _cleanup() -> None:
        try:
            await _abort(plan)
            await _close_owned(plan)
        finally:
            _settle(state, handle, plan, slot, reset=True)

    try:
        cleanup = task.get_loop().create_task(_cleanup(), name=f"chat-turn-cleanup:{handle.turn_id}")
    except RuntimeError:  # the loop is closing: end the waiters; the lease expires on its own
        _settle(state, handle, plan, slot, reset=True)
        return
    registry.track_cleanup(cleanup)


async def _drive(state: AppState, handle: ChatTurnHandle, plan: _TurnPlan) -> None:
    body = plan.body
    reservation = plan.reservation
    prior = PriorExchange.from_messages(_replay_messages(plan.existing)) if plan.existing is not None else None
    outcome = plan.outcome = TurnOutcome(turn_id=handle.turn_id)
    estimate = 0
    agen = plan.engine.run_turn(
        body.message, plan.prefs,
        case_id=body.case_id, history=None if prior is not None else body.history,
        context=body.context, author=plan.author, source=plan.source_conn,
        can_manage_memory=("memory", "manage") in plan.grants, tool_context=plan.ctx,
        can_comment_case=("cases", "comment") in plan.grants, prior_exchanges=prior,
        turn_id=handle.turn_id, stream_mode=body.stream_mode, cancel=handle.cancel_event,
        origin=body.origin, idempotency_key=handle.idempotency_key, outcome=outcome,
        conversation_id=reservation.conversation_id if reservation is not None else None,
        continue_of=body.continue_of,
    )
    try:
        async for event in agen:
            if isinstance(event, TurnDoneEvent):
                continue  # re-emitted below as the persisted response
            if isinstance(event, TurnStartEvent):
                estimate = event.estimate.prompt_tokens
            handle.emit(event)
    finally:
        await agen.aclose()
    response = outcome.response
    if response is None:
        raise RuntimeError("the chat engine ended without a response")
    response = _with_legacy_discover(response, body, plan.prefs)
    provenance = {
        "effective_source_id": plan.source_id,
        "effective_source_name": plan.source_name,
    }
    first_call_failed = not outcome.persist
    if not plan.persist_workspace:
        final = response.model_copy(update={"idempotency_key": body.idempotency_key, **provenance})
        if first_call_failed:
            _fail_first_call(handle, final)
        else:
            handle.done(final)
        return
    if first_call_failed or (outcome.cancelled and not outcome.billed):
        # D1 (§4.5) or a Stop before anything was billed: save nothing; a retry with
        # the same key runs fresh. The answer names only an EXISTING conversation.
        await _abort(plan)
        final = response.model_copy(update={
            "conversation_id": plan.existing.id if plan.existing else None,
            "conversation_title": plan.existing.title if plan.existing else None,
            "idempotency_key": plan.request_key, "message_id": None, **provenance,
        })
        if first_call_failed:
            _fail_first_call(handle, final)
        else:
            handle.done(final)
        return
    assert reservation is not None
    with_provenance = response.model_copy(update={"idempotency_key": plan.request_key, **provenance})
    stored = with_provenance.model_dump(mode="json")
    if estimate:
        stored[ESTIMATE_KEY] = int(estimate)
    try:
        completed = await plan.store.complete_exchange(
            plan.author,
            idempotency_key=plan.request_key,
            request_fingerprint=plan.fingerprint,
            conversation_id=reservation.conversation_id,
            lease_token=reservation.lease_token or "",
            requested_existing_conversation=body.conversation_id is not None,
            user_content=body.message,
            assistant_content=response.answer,
            response=stored,
            model=response.effective_model,
            source_id=plan.source_id,
            source_name=plan.source_name,
            user_origin=body.origin,
            time_range=body.time_range,
        )
    except ChatHistoryUnavailable as exc:
        if plan.billed:
            # The reservation is kept, so "Retry same request" would only meet 409
            # chat_request_in_progress until the lease expires: offer Ask again.
            raise _TurnFailure(
                "history_unavailable", _HISTORY_BILLED_MESSAGE, retryable=False,
                http=_history_http(ChatHistoryUnavailable(_HISTORY_BILLED_MESSAGE)),
            ) from exc
        raise _TurnFailure("history_unavailable", _HISTORY_MESSAGE, retryable=True,
                           http=_history_http(exc)) from exc
    except (ChatConversationMissing, ChatIdempotencyConflict) as exc:
        message = _CONFLICT_MESSAGE if isinstance(exc, ChatConversationMissing) else str(exc)
        raise _TurnFailure("history_unavailable", message, retryable=False,
                           http=_conflict_http("chat_idempotency_conflict", message)) from exc
    except ChatRequestInProgress as exc:
        raise _TurnFailure("history_unavailable", str(exc), retryable=True,
                           http=_conflict_http("chat_request_in_progress", str(exc),
                                               retry_after=IN_PROGRESS_RETRY_AFTER_S)) from exc
    plan.completed = True
    conversation = completed.conversation
    assistant = completed.assistant_message
    if conversation is None or assistant is None:
        raise _TurnFailure("history_unavailable", _HISTORY_MESSAGE, retryable=True, http=_history_http(
            ChatHistoryUnavailable("The saved conversation could not be restored.")))
    handle.done(with_provenance.model_copy(update={
        "conversation_id": conversation.id,
        "conversation_title": conversation.title,
        "truncated": bool((assistant.response or {}).get("truncated")),
        "message_id": assistant.id,
    }))


def _fail_first_call(handle: ChatTurnHandle, response: ChatResponse) -> None:
    """D1 (§4.5): the stream ends with ``turn.error`` (no response to keep); the
    blocking route answers 200 with the notice response, which clients do not append
    to history."""
    notice = response.notice
    handle.fail(
        turn_error_code(notice), (notice.message if notice else "") or _INTERNAL_MESSAGE,
        retryable=bool(notice.retryable) if notice else True, http=None, notice=notice,
        response=response,
    )


# --------------------------------------------------------------------------- #
# POST /api/chat/stream (SPEC §6.1).
# --------------------------------------------------------------------------- #
class NDJSONStreamingResponse(StreamingResponse):
    """``application/x-ndjson``: one :class:`ChatStreamEventModel` per line."""

    media_type = NDJSON_CONTENT_TYPE


class _NDJSONSchemaDoc(JSONResponse):
    """Documentation-only ``response_class`` for ``/chat/stream``.

    The handler always RETURNS an :class:`NDJSONStreamingResponse` instance, which
    FastAPI passes through untouched; ``response_class`` only shapes ``openapi.json``.
    For a non-JSON class FastAPI seeds the 200 schema with ``{"type": "string"}`` and
    then merges the documented model into it, producing the unsatisfiable
    ``{"$ref": ..., "type": "string"}`` (OpenAPI 3.1 applies sibling keywords
    jointly). A JSON-family class seeds ``{}``, so each NDJSON line is documented as
    exactly ``ChatStreamEventModel``."""

    media_type = NDJSON_CONTENT_TYPE


class ChatTurnCancelResult(BaseModel):
    """``POST /api/chat/turns/{turn_id}/cancel``: the Stop was accepted."""

    ok: bool = True
    turn_id: str


async def _relay(handle: ChatTurnHandle) -> AsyncIterator[bytes]:
    """Relay the turn's queue, with a ``ping`` after every idle interval. One getter
    task outlives each timeout, so an event is never lost to a timed-out wait."""
    getter: asyncio.Future | None = None
    try:
        while True:
            if getter is None:
                getter = asyncio.ensure_future(handle.queue.get())
            done, _pending = await asyncio.wait({getter}, timeout=STREAM_PING_INTERVAL_S)
            if not done:
                yield encode_event(PingEvent())
                continue
            item, getter = getter.result(), None
            if item is _END:
                return
            yield encode_event(item)
    finally:
        # The client stopped reading (or the turn ended): the turn itself goes on and
        # persists; only the relay stops.
        handle.detached = True
        if getter is not None and not getter.done():
            getter.cancel()


async def _replay_lines(response: ChatResponse) -> AsyncIterator[bytes]:
    """A completed-key replay: ``turn.start {replayed: true}`` then ``turn.done``."""
    yield encode_event(TurnStartEvent(
        turn_id=response.turn_id or new_id("turn-"), conversation_id=response.conversation_id,
        model=response.effective_model, stream_mode=response.stream_mode or "steps", replayed=True,
    ))
    yield encode_event(TurnDoneEvent(response=response))


@router.post(
    "/chat/stream",
    response_class=_NDJSONSchemaDoc,
    responses={200: {
        "model": ChatStreamEventModel,
        "description": (
            "NDJSON: one ChatStreamEvent per line. turn.start first; turn.done (the "
            "persisted response) or turn.error last; ping every idle 10 s."
        ),
    }},
)
async def chat_stream(
    body: ChatRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> NDJSONStreamingResponse:
    """The streaming twin of ``POST /api/chat`` (same body, same preflight errors)."""
    start = await run_chat_turn(request, body, state)
    if start.replay is not None:
        return NDJSONStreamingResponse(_replay_lines(start.replay), headers=dict(STREAM_HEADERS))
    assert start.handle is not None
    return NDJSONStreamingResponse(_relay(start.handle), headers=dict(STREAM_HEADERS))


async def run_chat_blocking(request: Request, body: ChatRequest, state: AppState) -> ChatResponse:
    """``POST /api/chat``: the same turn, awaited. A first-call failure (§4.5) is a
    200 with the notice; persistence failures keep their historical HTTP codes. The
    turn runs as a task, so a dropped client connection never interrupts it."""
    start = await run_chat_turn(request, body, state)
    if start.replay is not None:
        return start.replay
    handle = start.handle
    assert handle is not None
    await handle.finished.wait()
    if handle.response is not None:
        return handle.response
    raise handle.http_error or _internal_http()


# --------------------------------------------------------------------------- #
# POST /api/chat/turns/{turn_id}/cancel (SPEC §6.4).
# --------------------------------------------------------------------------- #
@router.post("/chat/turns/{turn_id}/cancel", response_model=ChatTurnCancelResult)
async def cancel_chat_turn(
    request: Request,
    turn_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatTurnCancelResult:
    """Stop the caller's own running turn. The in-flight step finishes and is
    recorded, no new step starts, and the stream ends with ``turn.done`` carrying a
    ``cancelled`` notice. 404 when unknown, finished or not the caller's (ownership
    is indistinguishable from absence)."""
    author = current_username(request)
    if not state.chat_turns.request_stop(turn_id, normalize_user_id(author)):
        raise HTTPException(status_code=404, detail="turn not found")
    try:
        await state.execution_audit.record(
            action_type=ActionType.CONTEXT, surface="chat", actor=author or "default",
            result_summary=f"turn={turn_id} stop requested",
        )
    except Exception:  # noqa: BLE001 -- Stop never fails on its audit row
        pass
    return ChatTurnCancelResult(ok=True, turn_id=turn_id)


# --------------------------------------------------------------------------- #
# GET /api/chat/context (SPEC §8).
# --------------------------------------------------------------------------- #
def _context_window(model: str, custom: dict[str, Any] | None) -> int | None:
    if isinstance(custom, dict):
        window = custom.get("context_window")
        if isinstance(window, int) and not isinstance(window, bool) and window > 0:
            return window
    try:
        from ..llm.pricing import load_registry

        value = int((load_registry().get(model) or {}).get("context_window") or 0)
    except Exception:  # noqa: BLE001
        return None
    return value or None


async def _rates(state: AppState, model: str, custom: dict[str, Any] | None) -> ChatRates:
    """Effective per-million rates for ``model``, priced exactly as the ledger prices
    it (operator overlay, then $0 for a registered custom model, then the tables).
    Demo Mode reports its synthetic rates."""
    from ..llm.gateway import _DEMO_IN_RATE, _DEMO_OUT_RATE
    from ..llm.pricing import cache_rates, resolve_price

    if state.demo_active:
        rate_in = _DEMO_IN_RATE * 1_000_000
        return ChatRates(
            input_per_million=round(rate_in, 6),
            output_per_million=round(_DEMO_OUT_RATE * 1_000_000, 6),
            cache_read_per_million=round(0.1 * rate_in, 6),
        )
    overlay = None
    try:
        overlay = await state.price_overlay.as_price_tuple(model)
    except Exception:  # noqa: BLE001
        overlay = None
    if overlay is None and custom is not None:
        overlay = (0.0, 0.0)
    rate_in, rate_out = resolve_price(model, overlay)
    return ChatRates(
        input_per_million=max(0.0, float(rate_in)),
        output_per_million=max(0.0, float(rate_out)),
        cache_read_per_million=max(0.0, float(cache_rates(model, float(rate_in))[0])),
    )


def _budget_state(status: dict[str, Any] | None) -> str:
    """ok | approaching | reached from the budget gate's status bands."""
    if not isinstance(status, dict) or not status.get("enabled"):
        return "ok"
    state = "ok"
    for window in ("daily", "monthly"):
        band = status.get(window) if isinstance(status.get(window), dict) else {}
        fraction = band.get("fraction")
        if band.get("band") == "over" or (isinstance(fraction, (int, float)) and fraction >= 1.0):
            return "reached"
        if band.get("band") == "warn":
            state = "approaching"
    return state


def _calibration(conversation: ChatConversation | None) -> float | None:
    """actual ÷ estimate of the conversation's last measured turn: the first model
    call's real prompt tokens over the engine's chars/4 estimate of that prompt."""
    for message in reversed(conversation.messages if conversation else []):
        if message.role != "assistant" or not isinstance(message.response, dict):
            continue
        estimate = message.response.get(ESTIMATE_KEY)
        steps = message.response.get("steps")
        if not isinstance(estimate, int) or isinstance(estimate, bool) or estimate <= 0 or not isinstance(steps, list):
            return None
        first = next((s for s in steps if isinstance(s, dict) and s.get("kind") == "model"), None)
        usage = first.get("usage") if isinstance(first, dict) else None
        if not isinstance(usage, dict) or usage.get("estimated"):
            return None
        actual = sum(
            int(usage.get(k) or 0) for k in ("input_tokens", "cache_read_tokens", "cache_write_tokens")
            if isinstance(usage.get(k), int)
        )
        if actual <= 0:
            return None
        ratio = actual / estimate
        if not math.isfinite(ratio):
            return None
        return round(min(max(ratio, CALIBRATION_BOUNDS[0]), CALIBRATION_BOUNDS[1]), 3)
    return None


def _clean_starters(raw: Iterable[Any]) -> list[ChatStarter]:
    out: list[ChatStarter] = []
    for item in raw or ():
        try:
            out.append(item if isinstance(item, ChatStarter) else ChatStarter.model_validate(
                item.model_dump() if isinstance(item, BaseModel) else item))
        except Exception:  # noqa: BLE001 -- one bad starter never hides the rest
            continue
    return out


def _demo_starters() -> list[ChatStarter]:
    """§5.5: the Demo planner's starters (``engine.demo_chat.DEMO_STARTERS``)."""
    try:
        from ..engine.demo_chat import DEMO_STARTERS  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 -- the planner is optional at this layer
        return []
    return _clean_starters(DEMO_STARTERS)


async def _newest_open_case_ref(state: AppState) -> str | None:
    """The newest open case's display reference (number, else id), or None."""
    try:
        cases, _total = await state.cases.list(limit=25, sort_field="created_at", sort_order="desc")
    except Exception:  # noqa: BLE001 -- the starter falls back to "which cases"
        return None
    for case in cases:
        status = getattr(getattr(case, "status", None), "value", getattr(case, "status", None))
        if str(status) not in OPEN_CASE_STATUSES:
            continue
        for ref in (getattr(case, "case_number", None), getattr(case, "case_id", None)):
            if isinstance(ref, str) and _CASE_REF_RE.match(ref):
                return ref
    return None


def _primary_source_label(prefs: Preferences) -> str:
    from ..agents.blocks import display_text

    try:
        primary = prefs.primary_source()
    except Exception:  # noqa: BLE001
        primary = None
    name = (primary.display_name or primary.id) if primary is not None else ""
    return display_text(name, 60) or "all connected sources"


async def production_starters(state: AppState, prefs: Preferences) -> list[ChatStarter]:
    """§10.5 starters filled from live context: the newest open case, the primary
    source's name and the last 24 h — never a literal indicator. Each lists the tools
    its plan needs; the page shows a card only when all are allowed."""
    case_ref = await _newest_open_case_ref(state)
    source = _primary_source_label(prefs)
    window = STARTER_WINDOW
    if case_ref:
        investigate = ChatStarter(
            id="investigate", label="Investigate", description=f"Walk through case {case_ref}",
            prompt=(f"Investigate case {case_ref}: what happened, what evidence supports the "
                    "verdict, and why was it routed this way?"),
            tools=["get_case", "explain_decision"],
        )
    else:
        investigate = ChatStarter(
            id="investigate", label="Investigate", description="Find the open cases that need attention",
            prompt="Which open cases need attention first, and why?", tools=["search_cases"],
        )
    return [
        investigate,
        ChatStarter(
            id="hunt", label="Hunt an indicator", description=f"Unusual activity in {source}, {window}",
            prompt=(f"Hunt across {source} for the {window}: which source IPs, users and hosts "
                    "stand out, and do any of them appear in open cases?"),
            tools=["log_stats", "search_cases"],
        ),
        ChatStarter(
            id="posture", label="Posture now", description="Key metrics and the trend",
            prompt=f"How is our security posture right now? Show the key metrics and the trend for the {window}.",
            tools=["soc_metrics"],
        ),
        ChatStarter(
            id="shift_brief", label="Shift brief", description="Summary, open work and next steps",
            prompt=f"Write a shift brief for the {window}: summary, open work, key metrics and next steps.",
            tools=["shift_report", "soc_metrics"],
        ),
        ChatStarter(
            id="explain_metric", label="Explain a metric", description="What the Active Risk Index means",
            prompt="What is the Active Risk Index, how is it calculated, and what moves it?",
            tools=["app_help"],
        ),
        ChatStarter(
            id="learn_app", label="Learn the app", description="What this console can do",
            prompt="What can I do in this console, and where should I start?",
            tools=["app_help", "app_status"],
        ),
    ]


async def _history_estimate(
    state: AppState, owner_name: str, conversation_id: str | None,
) -> tuple[int, int, ChatConversation | None]:
    """``(tokens, exchanges, conversation)`` for the replayed history of an owned
    conversation (the same §4.3 selection the engine replays)."""
    from ..llm.gateway import estimate_message_tokens

    if not conversation_id:
        return 0, 0, None
    try:
        conversation = await state.chat_conversations.get(owner_name, conversation_id)
    except ChatHistoryUnavailable:
        return 0, 0, None
    if conversation is None:
        return 0, 0, None
    kept = select_replay(PriorExchange.from_messages(_replay_messages(conversation)))
    if not kept:
        return 0, 0, conversation
    replay = render_replay(kept)
    return estimate_message_tokens(replay.messages), len(kept), conversation


@router.get("/chat/context", response_model=ChatContextInfo)
async def chat_context(
    request: Request,
    conversation_id: str | None = Query(default=None, max_length=128, pattern=_SAFE_ID_PATTERN),
    model: str | None = Query(default=None, max_length=200),
    case_id: str | None = Query(default=None, max_length=128),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatContextInfo:
    """Everything the composer meter needs (SPEC §8): the effective model and its
    limits, the static prompt and history estimates, the caller's tool catalogue,
    the live-text availability, the §4.2 bounds, calibration and the starters.
    Money and budget fields need ``models:read``; ``spent_today``/``remaining`` also
    ``cost:view``. Cached per principal for 30 s (dropped when one of the caller's
    turns ends) and resolved without audit rows."""
    from ..agents.chat_tools.registry import build_toolbox, catalogue_infos
    from ..agents.prompts import render_chat_agent_system
    from ..llm.gateway import estimate_message_tokens

    author = current_username(request)
    owner = normalize_user_id(author)
    grants = await state.chat_grants(request)
    registry = state.chat_turns
    key = (owner, state.demo_active, conversation_id, (model or "").strip(), case_id, grants)
    cached = registry.context_get(key)
    if cached is not None:
        return cached

    prefs = state.execution_prefs
    cfg = prefs.chat_agent
    chat_model = prefs.chat_model
    requested = (model or "").strip()
    if requested and requested != chat_model.model and ("models", "read") in grants:
        chat_model = await _chat_model_config(state, requested, chat_model) or chat_model
    custom = None
    try:
        custom = await state.custom_models.get_model(chat_model.model)
    except Exception:  # noqa: BLE001
        custom = None
    custom = custom if isinstance(custom, dict) else None

    effective_prefs = prefs.model_copy(update={"chat_model": chat_model})
    ctx = await state.build_chat_tool_context(
        request, None, grants=grants, prefs=effective_prefs, case_id=case_id or None,
    )
    toolbox = build_toolbox(ctx, ())
    system = render_chat_agent_system(
        toolbox.signatures(), max_parallel=cfg.max_parallel, case_scoped=bool(case_id),
        # The same configuration-disabled line a turn's prompt carries (estimate parity).
        disabled_tools=toolbox.disabled if cfg.max_model_calls > 1 else (),
    )
    history_tokens, history_exchanges, conversation = (0, 0, None)
    if not case_id:
        history_tokens, history_exchanges, conversation = await _history_estimate(
            state, author, conversation_id,
        )

    gateway = getattr(state.chat_engine, "_gateway", None) or state.gateway
    streams = bool(gateway.text_streaming_supported(chat_model.provider))
    if not cfg.allow_text_streaming:
        text_streaming = TextStreamingInfo(available=False, reason="disabled_by_admin")
    elif not streams:
        text_streaming = TextStreamingInfo(available=False, reason="model_does_not_stream")
    else:
        text_streaming = TextStreamingInfo(available=True, reason=None)

    budget_status: dict[str, Any] | None = None
    if not state.demo_active:
        try:
            budget_status = await state.budget_gate.status()
        except Exception:  # noqa: BLE001 -- the meter degrades to tokens only
            budget_status = None
    info: dict[str, Any] = {
        "model": chat_model.model,
        "context_window": _context_window(chat_model.model, custom),
        "max_output_tokens": max(int(chat_model.max_tokens), int(cfg.final_max_tokens)),
        "chars_per_token": CHARS_PER_TOKEN,
        "static_prompt_tokens": estimate_message_tokens([{"role": "system", "content": system}]),
        "history_tokens": history_tokens,
        "history_exchanges": history_exchanges,
        "tools": catalogue_infos(grants, ctx),
        "text_streaming": text_streaming,
        "bounds": ChatContextBounds.from_config(cfg),
        "calibration": _calibration(conversation),
        "budget_state": _budget_state(budget_status),
        "starters": _demo_starters() if state.demo_active else await production_starters(state, prefs),
    }
    if ("models", "read") in grants:
        budget = prefs.budget
        info["rates"] = await _rates(state, chat_model.model, custom)
        info["simulated"] = bool(state.demo_active)
        if state.demo_active:
            # Demo spend is simulated and never meets the tenant's budget gate.
            info["budget"] = ChatBudgetInfo(enabled=False)
        else:
            daily = budget.daily_usd if budget.daily_usd is not None and budget.daily_usd > 0 else None
            info["budget"] = ChatBudgetInfo(
                enabled=bool(budget.enabled), daily_limit=daily,
                soft_warn_pct=float(budget.soft_warn_pct), on_exceed=budget.on_exceed,
            )
            if ("cost", "view") in grants and budget_status is not None:
                spent = (budget_status.get("daily") or {}).get("spent")
                if isinstance(spent, (int, float)) and not isinstance(spent, bool) and math.isfinite(spent):
                    info["spent_today"] = max(0.0, float(spent))
                    info["remaining"] = (round(daily - float(spent), 6) if daily is not None else None)
    result = ChatContextInfo.model_validate(info)
    registry.context_put(key, result)
    return result


# --------------------------------------------------------------------------- #
# GET /api/chat/topics/{topic_id} (SPEC §10.7 "Ask about this").
# --------------------------------------------------------------------------- #
@router.get("/chat/topics/{topic_id}", response_model=ChatTopicQuestion)
async def chat_topic(
    topic_id: str = Path(..., max_length=CHAT_TOPIC_MAX_CHARS, pattern=_TOPIC_ID_PATTERN),
    _=Depends(require_permission("cases", "read")),
) -> ChatTopicQuestion:
    """The server's templated question for a console-map topic (``kpi:mtta``,
    ``settings:models``). The page sends it with ``origin: "starter"``; client text
    never stands in for it. 404 for an unknown topic."""
    from ..knowledge import AppKnowledgeUnavailable, load_app_knowledge, topic_question

    try:
        knowledge = await load_app_knowledge()
    except AppKnowledgeUnavailable as exc:
        raise HTTPException(status_code=404, detail="topic not found") from exc
    question = topic_question(topic_id, knowledge=knowledge)
    if not question:
        raise HTTPException(status_code=404, detail="topic not found")
    return ChatTopicQuestion(topic=topic_id, question=question)


__all__ = [
    "CHAT_BUSY_RETRY_AFTER_S",
    "ChatTurnBusy",
    "ChatTurnCancelResult",
    "ChatTurnHandle",
    "ChatTurnRegistry",
    "ChatTurnStart",
    "IN_PROGRESS_RETRY_AFTER_S",
    "NDJSONStreamingResponse",
    "chat_request_fingerprint",
    "production_starters",
    "router",
    "run_chat_blocking",
    "run_chat_turn",
]
