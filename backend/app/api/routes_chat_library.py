"""Chat library routes (Round 12, SPEC §3.2), auto-discovered by ``main.py``.

* ``POST /api/chat/feedback`` — rate one of the caller's own Workspace answers (204).
  Stored per user (``stores.chat_feedback``) and audited; NEVER used to train or tune
  a model, never a case decision (#3).
* ``GET  /api/chat/feedback?conversation_id=`` — the caller's own ratings (so a
  reopened conversation shows the thumbs it was given).
* ``GET  /api/chat/conversations/{id}/messages/{message_id}/steps/{index}`` — the step
  inspector: the stored observation the model saw for one lookup of one of the
  caller's answers (aggregates only, exactly as the model received them — never raw
  log rows, #7). Values are log- and model-derived: the response says ``untrusted``
  and the console renders them as text (#9). Observations are kept for the owner's
  :data:`~app.stores.chat_conversations.OBSERVATION_RING_SIZE` most recent answers;
  an older answer's inspector answers 404 ``step_observation_expired``.
* ``POST /api/chat/conversations/{id}/read`` — the owner opened the conversation:
  clear its ``unread`` mark (204). The history rail and the navigation indicator
  read ``ChatConversationSummary.unread`` (SPEC D13).
* ``GET  /api/chat/feedback/summary`` — the caller's own ratings as aggregates only
  (up/down, thumbs-down reasons; never comments): the P1-4 quality breakdown.
* ``GET  /api/chat/conversations/{id}/messages?before=<message id>&limit=`` — older
  messages of a long conversation, a page at a time, restored to full text
  (``GET /chat/conversations/{id}`` returns the newest window and says how many
  earlier messages there are, ``earlier_message_count``).
* ``GET  /api/chat/conversations/{id}/messages/{message_id}`` — one message, restored
  to its full text (reads only that answer's exchange document).

Every route is owner-scoped (the shared ``default`` profile when auth is off) and
requires ``cases:read``, like chat itself; another user's conversation, answer or
step is indistinguishable from an absent one (404).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, Field

from ..constants import ActionType
from ..models import ChatConversationMessage, ChatFeedbackRequest
from ..realtime import publish_chat_read
from ..state import AppState
from ..stores.chat_conversations import MAX_MESSAGE_PAGE, ChatHistoryUnavailable, ChatMessageMissing
from ..stores.chat_feedback import FEEDBACK_REASONS, ChatFeedbackStore, feedback_store_for
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.chat_library")

router = APIRouter(prefix="/api")

_SAFE_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,128}$"


class ChatFeedbackEntryOut(BaseModel):
    """One of the caller's own ratings."""

    conversation_id: str
    message_id: str
    rating: str
    reason: str | None = None
    comment: str = ""
    updated_at: str = ""


class ChatFeedbackList(BaseModel):
    """``GET /api/chat/feedback``: the caller's ratings, newest first."""

    feedback: list[ChatFeedbackEntryOut] = Field(default_factory=list)


class ChatFeedbackSummary(BaseModel):
    """``GET /api/chat/feedback/summary``: the caller's ratings as aggregates only
    (never a comment or which answer). ``down_by_reason`` holds every reason, zero
    included; ``since`` echoes the filter."""

    up: int = Field(default=0, ge=0)
    down: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)
    with_comment: int = Field(default=0, ge=0)
    down_by_reason: dict[str, int] = Field(default_factory=dict)
    down_without_reason: int = Field(default=0, ge=0)
    since: str | None = None


class ChatMessagePage(BaseModel):
    """``GET /api/chat/conversations/{id}/messages``: messages oldest first, each
    restored to its full text, and how many older ones remain
    (``earlier_message_count``; 0 = this page starts the conversation)."""

    conversation_id: str
    messages: list[ChatConversationMessage] = Field(default_factory=list)
    earlier_message_count: int = Field(default=0, ge=0)


class ChatStepObservation(BaseModel):
    """``GET …/steps/{index}``: what the model saw for one lookup. ``observation`` is
    the aggregate observation (never raw log rows); ``untrusted`` is always True —
    its values come from logs and tools and are rendered as text. ``truncated``: the
    stored copy was shortened structurally to fit its storage bound."""

    conversation_id: str
    message_id: str
    index: int
    tool: str | None = None
    ordinal: int | None = None
    status: str | None = None
    label: str | None = None
    # The engine's one-line result summary (a template of numbers and enums).
    summary: str | None = None
    observation: dict[str, Any] = Field(default_factory=dict)
    # Model- or log-derived input values the lookup used (untrusted, shown as text).
    params: dict[str, str] = Field(default_factory=dict)
    truncated: bool = False
    untrusted: bool = True
    stored_at: str | None = None


def _http(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _history_unavailable(exc: Exception | None = None) -> HTTPException:
    return _http(503, "chat_history_unavailable", "Chat history is temporarily unavailable.")


def feedback_store(state: AppState) -> ChatFeedbackStore:
    """The feedback store over the ACTIVE chat KV: the same boundary as Workspace
    history (Demo Mode writes to the demo stack's throwaway KV, never the tenant's)."""
    return feedback_store_for(getattr(state.chat_conversations, "_kv", None) or state.kv)


async def _owned_answer(state: AppState, user: str, conversation_id: str, message_id: str) -> Any:
    try:
        message = await state.chat_conversations.message(user, conversation_id, message_id)
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    if message is None or message.role != "assistant":
        raise _http(404, "message_not_found", "That answer is not in this conversation.")
    return message


@router.post("/chat/feedback", status_code=204, response_class=Response)
async def chat_feedback(
    body: ChatFeedbackRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Response:
    """Rate one of the caller's own Workspace answers (up/down, an optional reason
    and comment). Rating the same answer again replaces the earlier rating. Audited
    without the comment; never used to train a model."""
    user = current_username(request)
    await _owned_answer(state, user, body.conversation_id, body.message_id)
    try:
        _entry, replaced = await feedback_store(state).record(user, body)
    except ChatHistoryUnavailable as exc:
        raise _http(503, "chat_feedback_unavailable", "Feedback could not be saved. Try again.") from exc
    try:
        await state.audit.record(
            action_type=ActionType.FEEDBACK, surface="chat", actor=user or "default",
            result_summary=(
                f"chat answer rated {body.rating}{' (changed)' if replaced else ''}: "
                f"conversation={body.conversation_id[:100]} message={body.message_id[:100]} "
                f"reason={body.reason or '-'}"
            )[:500],
        )
    except Exception as exc:  # noqa: BLE001 -- the rating is saved; the row is best effort
        logger.warning("chat feedback audit failed (%s)", type(exc).__name__)
    return Response(status_code=204)


@router.get("/chat/feedback", response_model=ChatFeedbackList)
async def list_chat_feedback(
    request: Request,
    conversation_id: str | None = Query(default=None, max_length=128, pattern=_SAFE_ID_PATTERN),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatFeedbackList:
    """The caller's own ratings (optionally of one conversation), newest first."""
    try:
        entries = await feedback_store(state).list(current_username(request), conversation_id=conversation_id)
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    return ChatFeedbackList(feedback=[
        ChatFeedbackEntryOut(
            conversation_id=e.conversation_id, message_id=e.message_id, rating=e.rating,
            reason=e.reason, comment=e.comment, updated_at=e.updated_at,
        ) for e in entries
    ])


@router.get("/chat/feedback/summary", response_model=ChatFeedbackSummary)
async def chat_feedback_summary(
    request: Request,
    since: str | None = Query(default=None, max_length=40, pattern=r"^\d{4}-\d{2}-\d{2}[T0-9:.+\-Z]*$"),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatFeedbackSummary:
    """The caller's own answer ratings as aggregates (P1-4): thumbs up and down, the
    thumbs-down reasons and how many carried a comment — never a comment or which
    answer it was. Owner-scoped; never used to train a model."""
    try:
        counts = await feedback_store(state).breakdown(current_username(request), since=since)
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    reasons = counts.get("down_by_reason") or {}
    return ChatFeedbackSummary(
        up=counts.get("up", 0), down=counts.get("down", 0), total=counts.get("total", 0),
        with_comment=counts.get("with_comment", 0),
        down_by_reason={reason: int(reasons.get(reason, 0)) for reason in FEEDBACK_REASONS},
        down_without_reason=counts.get("down_without_reason", 0), since=since,
    )


@router.get("/chat/conversations/{conversation_id}/messages", response_model=ChatMessagePage)
async def chat_conversation_messages(
    request: Request,
    conversation_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    before: str | None = Query(default=None, max_length=128, pattern=_SAFE_ID_PATTERN),
    limit: int = Query(default=50, ge=1, le=MAX_MESSAGE_PAGE),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatMessagePage:
    """Up to ``limit`` messages immediately before message ``before`` (the newest
    ones without it), oldest first, each restored to its full text — how a client
    reads a long conversation beyond the window ``GET /chat/conversations/{id}``
    returns. 404 for a conversation the caller does not own or an unknown ``before``."""
    try:
        page = await state.chat_conversations.messages_page(
            current_username(request), conversation_id, before=before, limit=limit,
        )
    except ChatMessageMissing as exc:
        raise _http(404, "message_not_found", "That message is not in this conversation.") from exc
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    if page is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    messages, earlier = page
    return ChatMessagePage(conversation_id=conversation_id, messages=messages, earlier_message_count=earlier)


@router.get(
    "/chat/conversations/{conversation_id}/messages/{message_id}",
    response_model=ChatConversationMessage,
)
async def chat_conversation_message(
    request: Request,
    conversation_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    message_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatConversationMessage:
    """One message of one of the caller's conversations, restored to its full text
    (only that answer's exchange document is read). 404 when not found or not the
    caller's."""
    try:
        message = await state.chat_conversations.message(current_username(request), conversation_id, message_id)
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    if message is None:
        raise _http(404, "message_not_found", "That message is not in this conversation.")
    return message


@router.get(
    "/chat/conversations/{conversation_id}/messages/{message_id}/steps/{index}",
    response_model=ChatStepObservation,
)
async def chat_step_observation(
    request: Request,
    conversation_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    message_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    index: int = Path(..., ge=0, le=100_000),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> ChatStepObservation:
    """The stored observation the model saw for step ``index`` of one of the
    caller's answers (P1-1 step inspector). 404 ``step_not_found`` when the answer
    has no such lookup, ``step_observation_unavailable`` when no observation was
    stored for it (a model step, a refused or failed lookup), and
    ``step_observation_expired`` once the owner's ring holds newer answers."""
    user = current_username(request)
    message = await _owned_answer(state, user, conversation_id, message_id)
    steps = (message.response or {}).get("steps") if isinstance(message.response, dict) else None
    step = next(
        (s for s in steps or [] if isinstance(s, dict) and s.get("index") == index and s.get("kind") == "tool"),
        None,
    )
    if step is None:
        raise _http(404, "step_not_found", "That lookup is not part of this answer.")
    ref = step.get("observation_ref")
    if not isinstance(ref, str) or not ref:
        raise _http(404, "step_observation_unavailable", "No result was stored for this lookup.")
    try:
        stored = await state.chat_conversations.get_observation(user, ref, index)
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    if stored is None or stored.get("conversation_id") not in (None, conversation_id):
        raise _http(404, "step_observation_expired", "This lookup's result is no longer stored.")
    observation = stored.get("observation")
    return ChatStepObservation(
        conversation_id=conversation_id, message_id=message_id, index=index,
        tool=stored.get("tool") if isinstance(stored.get("tool"), str) else step.get("tool"),
        ordinal=stored.get("ordinal") if isinstance(stored.get("ordinal"), int) else None,
        status=stored.get("status") if isinstance(stored.get("status"), str) else step.get("status"),
        label=stored.get("label") if isinstance(stored.get("label"), str) else step.get("label"),
        summary=stored.get("summary") if isinstance(stored.get("summary"), str) else None,
        observation=observation if isinstance(observation, dict) else {},
        params={str(k): str(v) for k, v in (stored.get("params") or {}).items()}
        if isinstance(stored.get("params"), dict) else {},
        truncated=stored.get("truncated") is True,
        stored_at=stored.get("stored_at") if isinstance(stored.get("stored_at"), str) else None,
    )


@router.post("/chat/conversations/{conversation_id}/read", status_code=204, response_class=Response)
async def mark_chat_conversation_read(
    request: Request,
    conversation_id: str = Path(..., max_length=128, pattern=_SAFE_ID_PATTERN),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> Response:
    """The owner has seen the conversation's newest answer: clear ``unread``
    (SPEC D13). Idempotent; ``needs_input`` and ``failed`` stay until the next answer."""
    # The owner's other consoles hear it at once: an owner-only ``chat.read`` frame
    # (topic ``chat``) tells them to drop the "new answer" mark they may hold, so an
    # answer read on one device is not news on another. Best effort: the read is saved
    # whether or not the frame goes out. (A comment, not the docstring: the docstring is
    # the published OpenAPI description.)
    username = current_username(request)
    try:
        found = await state.chat_conversations.mark_read(username, conversation_id)
    except ChatHistoryUnavailable as exc:
        raise _history_unavailable(exc) from exc
    if not found:
        raise HTTPException(status_code=404, detail="conversation not found")
    try:
        publish_chat_read(state.event_bus, username, conversation_id)
    except Exception:  # noqa: BLE001 -- a nudge; the read itself is already saved
        logger.debug("chat.read frame not published", exc_info=True)
    return Response(status_code=204)


__all__ = [
    "ChatFeedbackEntryOut",
    "ChatFeedbackList",
    "ChatFeedbackSummary",
    "ChatMessagePage",
    "ChatStepObservation",
    "feedback_store",
    "router",
]
