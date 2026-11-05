"""Per-case ticket COLLABORATION API (Round 3 / Wave 2, Feature 4).

A full ticket-style collaboration surface for ONE case, built over the Wave-1 KV
stores (``CaseThreadStore`` / ``CaseActivityStore`` / ``CaseTaskStore`` / ``InboxStore``)
plus the authoritative ``AuditLogger`` trail. It gives a case three friendly,
human-facing layers beside the immutable audit log (#2):

* **Thread** — threaded discussion where the AI is a FIRST-CLASS author
  (``author_type`` human | ai | system; one-level ``parent_id`` replies; emoji
  reactions; in-place edit + soft-delete tombstone — never a hard delete, #2). Every
  per-case ChatEngine turn is also persisted here (the chat engine extension), so the
  investigation reasoning stops being ephemeral. Legacy ``Case.comments`` are
  migrated-on-read into root thread messages (no schema break).
* **Activity** — an append-only who-did-what timeline assembled from the existing
  audit store UNIONed with the ``CaseActivityStore`` friendly feed.
* **Tasks** — a per-case checklist with an append-only log trail.

@mentions in a message body are resolved against the user store and fanned into each
mentioned user's inbox as an ``InAppNotification`` (category=mention).

NON-NEGOTIABLES upheld here:

* **#3** — NOTHING in this module touches ``case_manager.decide()`` / the close /
  escalate truth table. An AI or system message can RECOMMEND but can NEVER set a
  case's ``status`` / ``verdict`` / ``disposition`` (asserted by a test). The thread
  is advisory display data only.
* **#9** — every operator/AI-influenceable value (``body`` / ``mentions`` / task
  ``title`` / log ``note`` / reaction ``emoji``) is returned as PLAIN data; the UI
  escapes it. We never feed a thread body into a prompt unfenced (the chat engine
  fences its own context).
* **#2** — soft-delete tombstones (never hard-delete a message); every collaboration
  mutation is also recorded on the append-only audit trail.
* **#5** — the ONE chat engine is reused verbatim; this module only PERSISTS its
  turns onto the thread (no fork).

Endpoints (mounted by the integrator under the ``/api`` router):

    GET    /api/cases/{case_id}/activity
    GET    /api/cases/{case_id}/thread
    POST   /api/cases/{case_id}/thread
    PATCH  /api/cases/{case_id}/thread/{msg_id}
    DELETE /api/cases/{case_id}/thread/{msg_id}
    POST   /api/cases/{case_id}/thread/{msg_id}/reactions
    GET    /api/cases/{case_id}/tasks
    POST   /api/cases/{case_id}/tasks
    PATCH  /api/cases/{case_id}/tasks/{tid}
    POST   /api/cases/{case_id}/tasks/{tid}/log

All non-GET routes are gated on ``cases:comment`` (post/react) or ``cases:write``
(tasks) — existing ``cases`` RBAC actions; GET routes inherit ``require_auth`` from
the mount.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..constants import ActionType, AuthorType, NotificationCategory
from ..models import CaseActivity, CaseMessage, InAppNotification
from ..state import AppState
from ..utils import truncate
from .deps import current_username, get_state, has_permission, require_permission

logger = logging.getLogger("tlsoc.api.cases_collab")

router = APIRouter(prefix="/api")

# Bounds — collaboration text is operator input, kept tidy (#9: we still return it
# as plain data; these caps just stop one paste from bloating the shared KV doc).
_BODY_MAX = 8000
_TITLE_MAX = 400
_NOTE_MAX = 2000
_EMOJI_MAX = 32
_MENTIONS_MAX = 25

# @mention token: @ followed by a username-ish run (letters/digits/._-). Case
# folding is applied at resolution time against the user store.
_MENTION_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})")


# --------------------------------------------------------------------------- #
# Request bodies (additive, defaulted — the proxy forwards arbitrary JSON).
# --------------------------------------------------------------------------- #
class ThreadPostBody(BaseModel):
    body: str = ""
    parent_id: str | None = None
    # author_type defaults to human for an operator-posted message. An AI/system
    # author is set explicitly (used by the chat-turn persistence + agent advisories).
    author_type: str = "human"
    kind: str = "comment"
    # Optional explicit mention list (in addition to @tokens parsed from the body).
    mentions: list[str] = Field(default_factory=list)
    # Optional AI provenance bag for an ai-authored message (model/cost/tokens).
    ai_meta: dict[str, Any] | None = None


class ThreadEditBody(BaseModel):
    body: str = ""


class ReactionBody(BaseModel):
    emoji: str = ""
    remove: bool = False


class TaskCreateBody(BaseModel):
    title: str = ""
    assignee: str | None = None
    status: str = "open"


class TaskPatchBody(BaseModel):
    title: str | None = None
    assignee: str | None = None
    status: str | None = None
    order: int | None = None


class TaskLogBody(BaseModel):
    note: str = ""


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def _require_case(state: AppState, case_id: str):
    case = await state.cases.get(case_id)
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


def _clip(value: str | None, limit: int) -> str:
    """Trim + hard-cap a free-text field. Returns plain data (#9) — never an
    instruction the model is told to obey; the UI escapes it on render."""
    return (value or "").strip()[:limit]


def _resolve_author(request: Request, body_author_type: str) -> tuple[str, str]:
    """Resolve (author_type, author_name) for a posted message.

    The author NAME is the authenticated username (best-effort ``""`` when auth is
    off — the no-auth profile). The author TYPE is normalised to a known
    :class:`AuthorType`; an unknown value falls back to ``human``. A non-human type
    is honoured (so an agent/automation can post an advisory message), but per #3 the
    handler NEVER lets that change a case's decision — it only labels the message."""
    at = (body_author_type or "human").strip().lower()
    if at not in (AuthorType.HUMAN.value, AuthorType.AI.value, AuthorType.SYSTEM.value):
        at = AuthorType.HUMAN.value
    author = current_username(request) or ""
    if at != AuthorType.HUMAN.value and not author:
        author = at  # label a system/ai post by its type when no human principal
    return at, author


def _post_actor_type(author_type: str, signed_in: bool) -> str:
    """The audit actor kind of a thread post. It is decided by the principal, never by
    a name: a signed-in person who posts is ``human`` whatever the message's label
    (and whatever their username, which is free text and may itself read ``ai``).
    With no principal an AI or system post is labelled by its type
    (:func:`_resolve_author`), and that label is the actor: ``agent`` for ``ai``,
    ``system`` for ``system``, ``human`` otherwise."""
    if signed_in:
        return "human"
    if author_type == AuthorType.AI.value:
        return "agent"
    if author_type == AuthorType.SYSTEM.value:
        return "system"
    return "human"


def _parse_mentions(body: str, extra: list[str] | None = None) -> list[str]:
    """Extract @mention usernames from a message body + an explicit list, de-duped
    (case-insensitive), bounded. Returns plain lowercased usernames (#9)."""
    found: list[str] = []
    seen: set[str] = set()
    for tok in _MENTION_RE.findall(body or ""):
        low = tok.strip().lower()
        if low and low not in seen:
            seen.add(low)
            found.append(low)
    for raw in extra or []:
        low = str(raw or "").strip().lstrip("@").lower()
        if low and low not in seen:
            seen.add(low)
            found.append(low)
        if len(found) >= _MENTIONS_MAX:
            break
    return found[:_MENTIONS_MAX]


async def _resolve_known_usernames(state: AppState, mentions: list[str]) -> list[str]:
    """Filter a candidate mention list down to usernames that actually EXIST in the
    user store (so we don't fan a notification at a typo). Best-effort: when the user
    store is unavailable (or auth is off and there are no users), returns the
    candidates unchanged so a mention is still recorded on the message."""
    if not mentions:
        return []
    store = getattr(state, "users", None)
    if store is None:
        return mentions
    try:
        users = await store.list()
    except Exception as exc:  # noqa: BLE001 — mention resolution is best-effort
        logger.info("Mention resolution: user store unavailable (%s)", exc)
        return mentions
    if not users:
        return mentions
    known = {u.username.strip().lower() for u in users if getattr(u, "username", "")}
    return [m for m in mentions if m in known]


async def _fanout_mentions(
    state: AppState, case_id: str, msg: CaseMessage, mentions: list[str], actor: str,
) -> None:
    """Fan each resolved @mention into the mentioned user's inbox as an
    ``InAppNotification`` (category=mention). FIRE-AND-FORGET + best-effort: a fan-out
    failure never breaks the post. The notification body is plain data (#9). Also
    publishes an in-app realtime event (per-user audience) when the bus is present."""
    if not mentions:
        return
    inbox = getattr(state, "inbox", None)
    if inbox is None:
        return
    # Don't notify the author about their own @self-mention.
    recipients = [m for m in mentions if m != (actor or "").strip().lower()]
    if not recipients:
        return
    excerpt = truncate(msg.body, 140)

    def _build(recipient: str) -> InAppNotification:
        return InAppNotification(
            recipient=recipient,
            category=NotificationCategory.MENTION.value,
            title=f"{actor or 'Someone'} mentioned you on case {case_id}",
            body=excerpt,
            case_id=case_id,
            url=f"/cases/{case_id}",
            ref={"message_id": msg.id, "actor": actor},
        )

    try:
        created = await inbox.fanout(recipients, _build)
    except Exception as exc:  # noqa: BLE001 — a mention fan-out must never break the post
        logger.warning("Mention fan-out failed (%s); continuing", exc)
        return
    # Append-only audit of each delivery (#2) + a per-user realtime nudge.
    for note in created:
        # The delivery is the system's, made for the poster (``actor``), as the
        # notification service's own sends are: the row stays in Agent activity.
        await _audit(
            state, ActionType.INAPP_NOTIFY, actor=actor, case_id=case_id,
            summary=f"mention -> {note.recipient}", actor_type="system",
        )
    bus = _event_bus(state)
    if bus is not None and created:
        # Align with the dispatch in-app live-badge path: publish to the allowlisted
        # ``notifications`` topic (event ``inapp``, per-user audience) so the Wave-4
        # NotificationBell EventSource actually receives a mention badge. (The old
        # ``inbox`` topic is NOT in the /events allowlist, so it never reached a
        # subscriber.) Frame carries plain identifiers only (#9); best-effort.
        try:
            bus.publish(
                "notifications", "inapp",
                {"category": NotificationCategory.MENTION.value,
                 "case_id": case_id, "message_id": msg.id},
                audience=[n.recipient for n in created],
            )
        except Exception:  # noqa: BLE001 — realtime is advisory
            pass


def _event_bus(state: AppState):
    try:
        return getattr(state, "event_bus", None)
    except Exception:  # noqa: BLE001
        return None


def _publish_case_activity(state: AppState, case_id: str, *, kind: str,
                           actor: str, summary: str = "",
                           ref: dict[str, Any] | None = None) -> None:
    """Publish a ``case.activity`` realtime frame to the per-case room so the Wave-4
    case-detail EventSource (subscribed to topic ``cases:{case_id}``) renders the
    collaboration event live.

    FIRE-AND-FORGET, AFTER the store write, BEST-EFFORT — wrapped so a bus error can
    never break a thread/task/reaction post (#11). DEFAULT-OFF preserved: when realtime
    is disabled nobody is subscribed and ``publish`` is a cheap history-only no-op. The
    payload carries only PLAIN, already-render-safe identifiers + a clipped summary —
    no unfenced log/AI text is fed anywhere (#9; the UI escapes ``summary`` on render).
    The topic is the exact-match ``cases:{case_id}`` room the ``/events`` endpoint
    allowlists for a case-detail view; this is a pure NUDGE — the client refetches the
    authoritative thread/activity/task state (#3 untouched: nothing here decides)."""
    bus = _event_bus(state)
    if bus is None or not case_id:
        return
    payload: dict[str, Any] = {"case_id": case_id, "kind": kind, "actor": actor or ""}
    if summary:
        payload["summary"] = truncate(summary, 200)
    if ref:
        payload["ref"] = ref
    try:
        bus.publish(f"cases:{case_id}", "case.activity", payload)
    except Exception:  # noqa: BLE001 — realtime is advisory; never break the post
        pass


async def _audit(state: AppState, action: ActionType, *, actor: str, case_id: str,
                 summary: str, actor_type: str = "human") -> None:
    """Append-only audit of a collaboration mutation (#2). Best-effort: never raises
    into the handler (a glitchy audit write must not fail a comment). Every row is
    written after its change was stored, so its outcome is ``success``; ``actor_type``
    is the kind of ``actor`` (a person by default, see :func:`_post_actor_type`)."""
    audit = getattr(state, "audit", None)
    if audit is None:
        return
    try:
        await audit.record(
            action_type=action, surface="case", actor=actor or "",
            case_id=case_id, result_summary=summary,
            outcome="success", actor_type=actor_type,
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("Collab audit write soft-failed (%s)", exc)


async def _activity(state: AppState, case_id: str, *, kind: str, actor: str,
                    summary: str, ref: dict[str, Any] | None = None) -> None:
    """Append one entry to the friendly activity timeline (best-effort)."""
    store = getattr(state, "case_activity", None)
    if store is None:
        return
    try:
        await store.append(CaseActivity(
            case_id=case_id, kind=kind, actor=actor or "", summary=summary,
            ref=ref or {},
        ))
    except Exception as exc:  # noqa: BLE001
        logger.info("Activity append soft-failed (%s)", exc)


def _msg_public(m: CaseMessage) -> dict[str, Any]:
    """Project a message for the API. A tombstoned (deleted) message is returned with
    an empty body + a ``deleted: true`` marker so the UI renders a placeholder while
    threaded replies keep their parent (#2 — the row stays)."""
    d = m.model_dump(mode="json")
    d["deleted"] = bool(m.deleted_at)
    return d


# --------------------------------------------------------------------------- #
# Legacy Case.comments → root thread messages (migrate-on-read)
# --------------------------------------------------------------------------- #
async def _ensure_legacy_comments_migrated(state: AppState, case_id: str) -> None:
    """Idempotently fold legacy ``Case.comments`` into root thread messages.

    On first read of a case's thread we copy any pre-existing ``Case.comments`` (the
    Wave-3-collab analyst comments) into the ``CaseThreadStore`` as human root
    messages, tagged ``ai_meta={"migrated_from":"case.comments"}`` so the migration
    runs ONCE (we skip a comment whose (author, body, ts) already exists as a
    migrated message). No schema break: ``Case.comments`` is left untouched."""
    case = await state.cases.get(case_id)
    if not case or not getattr(case, "comments", None):
        return
    threads = getattr(state, "case_threads", None)
    if threads is None:
        return
    try:
        existing = await threads.list_for_case(case_id)
    except Exception:  # noqa: BLE001
        return
    migrated_keys = {
        (m.author, m.body, m.created_at)
        for m in existing
        if isinstance(m.ai_meta, dict) and m.ai_meta.get("migrated_from") == "case.comments"
    }
    for c in case.comments:
        key = (c.author or "", c.body or "", c.ts)
        if key in migrated_keys:
            continue
        try:
            await threads.append(CaseMessage(
                case_id=case_id,
                author_type=AuthorType.HUMAN.value,
                author=c.author or "",
                body=c.body or "",
                kind="comment",
                created_at=c.ts,
                ai_meta={"migrated_from": "case.comments"},
            ))
            migrated_keys.add(key)
        except Exception:  # noqa: BLE001 — a single bad legacy comment must not break the read
            continue


# --------------------------------------------------------------------------- #
# ACTIVITY — audit trail UNION friendly timeline
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/activity")
async def get_case_activity(
    case_id: str,
    state: AppState = Depends(get_state),
    limit: int = 200,
) -> dict[str, Any]:
    """The case ACTIVITY timeline — the authoritative audit rows for the case UNIONed
    with the friendly ``CaseActivityStore`` feed, NEWEST first. The audit trail stays
    the source of truth (#2); the friendly feed adds human-readable collaboration
    events. All text is returned plain (#9)."""
    await _require_case(state, case_id)
    limit = max(1, min(int(limit or 200), 1000))
    items: list[dict[str, Any]] = []

    audit = getattr(state, "audit", None)
    if audit is not None:
        try:
            for row in await audit.records_for_case(case_id, limit=limit):
                items.append({
                    "source": "audit",
                    "ts": row.get("ts") or row.get("@timestamp") or "",
                    "kind": row.get("action_type") or "",
                    "actor": row.get("actor") or "",
                    "summary": row.get("result_summary")
                    or row.get("tool_output_summary")
                    or row.get("prompt_excerpt") or "",
                    "ref": {k: row.get(k) for k in ("tool_name", "model", "query_text")
                            if row.get(k)},
                })
        except Exception as exc:  # noqa: BLE001 — never 500 the timeline
            logger.info("Activity audit read soft-failed (%s)", exc)

    store = getattr(state, "case_activity", None)
    if store is not None:
        try:
            for a in await store.list_for_case(case_id, newest_first=True, limit=limit):
                d = a.model_dump(mode="json")
                d["source"] = "activity"
                items.append(d)
        except Exception as exc:  # noqa: BLE001
            logger.info("Activity feed read soft-failed (%s)", exc)

    # Merge NEWEST first by ts (string ISO sort is chronological for our timestamps).
    items.sort(key=lambda x: str(x.get("ts") or ""), reverse=True)
    return {"case_id": case_id, "activity": items[:limit], "count": len(items[:limit])}


# --------------------------------------------------------------------------- #
# THREAD
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/thread")
async def get_case_thread(
    case_id: str,
    state: AppState = Depends(get_state),
    include_deleted: bool = True,
) -> dict[str, Any]:
    """The case THREAD (chronological). Legacy ``Case.comments`` are migrated-on-read
    into root messages first. Tombstoned messages are included by default (the UI
    renders a 'deleted' placeholder so replies keep their parent); pass
    ``include_deleted=false`` to drop them. Bodies are plain data (#9)."""
    await _require_case(state, case_id)
    await _ensure_legacy_comments_migrated(state, case_id)
    threads = getattr(state, "case_threads", None)
    if threads is None:
        return {"case_id": case_id, "messages": [], "count": 0}
    msgs = await threads.list_for_case(case_id)
    if not include_deleted:
        msgs = [m for m in msgs if not m.deleted_at]
    return {
        "case_id": case_id,
        "messages": [_msg_public(m) for m in msgs],
        "count": len(msgs),
    }


@router.post("/cases/{case_id}/thread")
async def post_case_thread(
    case_id: str,
    body: ThreadPostBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "comment")),
) -> dict[str, Any]:
    """Post a message to a case's thread (human / ai / system author; optional
    one-level ``parent_id`` reply). @mentions in the body (+ explicit ``mentions``)
    are resolved against the user store and fanned into each mentioned user's inbox.

    #3 GUARANTEE: posting a message — of ANY author_type — NEVER reads, sets, or
    influences the case's ``status`` / ``verdict`` / ``disposition``. The case row is
    not modified at all here; the message is advisory display data only."""
    await _require_case(state, case_id)
    threads = getattr(state, "case_threads", None)
    if threads is None:
        raise HTTPException(status_code=503, detail="thread store unavailable")

    text = _clip(body.body, _BODY_MAX)
    if not text:
        raise HTTPException(status_code=400, detail="message body is required")

    author_type, author = _resolve_author(request, body.author_type)

    # Validate a parent reply (one level only): the parent must exist on THIS case and
    # itself be a root message (we don't thread replies-of-replies).
    parent_id = (body.parent_id or "").strip() or None
    if parent_id:
        parent = await threads.get(case_id, parent_id)
        if parent is None:
            raise HTTPException(status_code=400, detail="parent message not found")
        if parent.parent_id:
            # Collapse a reply-to-a-reply onto the root so the thread stays one level.
            parent_id = parent.parent_id

    raw_mentions = _parse_mentions(text, body.mentions)
    mentions = await _resolve_known_usernames(state, raw_mentions)

    kind = _clip(body.kind, 40) or "comment"
    ai_meta = body.ai_meta if isinstance(body.ai_meta, dict) else None

    msg = await threads.append(CaseMessage(
        case_id=case_id,
        parent_id=parent_id,
        author_type=author_type,
        author=author,
        body=text,
        mentions=mentions,
        kind=kind,
        ai_meta=ai_meta,
    ))

    await _audit(
        state, ActionType.THREAD_POST, actor=author, case_id=case_id,
        summary=f"thread post ({author_type})"
                + (f" reply->{parent_id}" if parent_id else "")
                + (f" mentions={len(mentions)}" if mentions else ""),
        actor_type=_post_actor_type(author_type, bool(current_username(request))),
    )
    await _activity(
        state, case_id, kind="commented", actor=author,
        summary=truncate(text, 200), ref={"message_id": msg.id, "author_type": author_type},
    )
    await _fanout_mentions(state, case_id, msg, mentions, author)

    # Realtime nudge to the per-case room (topic ``cases:{case_id}``) so the Wave-4
    # case-detail EventSource renders the new message live. AFTER the store write +
    # fan-out; best-effort; never alters the case decision (#3).
    _publish_case_activity(
        state, case_id, kind="commented", actor=author,
        summary=truncate(text, 200),
        ref={"message_id": msg.id, "author_type": author_type},
    )

    return _msg_public(msg)


async def _require_author_or_moderator(
    state: AppState, request: Request, case_id: str, msg_id: str, actor: str
) -> None:
    """Author-scope a thread edit/delete (audit #12): only the message's own author OR a
    case moderator (``cases:close`` — senior analyst / super_admin) may mutate it. A
    plain ``cases:comment`` holder must NOT be able to rewrite or tombstone someone
    else's message. A no-op when auth is off (has_permission allows everything)."""
    threads = getattr(state, "case_threads", None)
    if threads is None:
        raise HTTPException(status_code=503, detail="thread store unavailable")
    msg = await threads.get(case_id, msg_id)
    if msg is None:
        raise HTTPException(status_code=404, detail="message not found or already deleted")
    if (msg.author or "") == actor:
        return
    if await has_permission(request, "cases", "close"):
        return
    raise HTTPException(
        status_code=403,
        detail="only the message author or a case moderator can modify this message",
    )


@router.patch("/cases/{case_id}/thread/{msg_id}")
async def edit_case_message(
    case_id: str,
    msg_id: str,
    body: ThreadEditBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "comment")),
) -> dict[str, Any]:
    """Edit a thread message body in place (stamps ``edited_at``). Editing a deleted
    message is rejected. The new body is plain data (#9); new @mentions in the edit
    are re-resolved + fanned out. #3: never touches the case decision."""
    await _require_case(state, case_id)
    threads = getattr(state, "case_threads", None)
    if threads is None:
        raise HTTPException(status_code=503, detail="thread store unavailable")
    text = _clip(body.body, _BODY_MAX)
    if not text:
        raise HTTPException(status_code=400, detail="message body is required")
    actor = current_username(request) or ""
    await _require_author_or_moderator(state, request, case_id, msg_id, actor)
    updated = await threads.edit(case_id, msg_id, text, editor=actor)
    if updated is None:
        raise HTTPException(status_code=404, detail="message not found or already deleted")
    # Re-resolve + fan out any NEW mentions introduced by the edit (the store keeps
    # the original mention list; we recompute against the new body for fan-out).
    raw_mentions = _parse_mentions(text)
    mentions = await _resolve_known_usernames(state, raw_mentions)
    await _audit(state, ActionType.THREAD_POST, actor=actor, case_id=case_id,
                 summary=f"thread edit msg={msg_id}")
    await _fanout_mentions(state, case_id, updated, mentions, actor)
    _publish_case_activity(state, case_id, kind="edited_comment", actor=actor,
                           ref={"message_id": msg_id})
    return _msg_public(updated)


@router.delete("/cases/{case_id}/thread/{msg_id}")
async def delete_case_message(
    case_id: str,
    msg_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "comment")),
) -> dict[str, Any]:
    """SOFT-DELETE (tombstone) a thread message — never a hard delete (#2). The row
    stays (body cleared, ``deleted_at`` stamped) so threaded replies keep their parent
    and the audit/UI can render a 'deleted' placeholder. #3: never touches the case
    decision."""
    await _require_case(state, case_id)
    threads = getattr(state, "case_threads", None)
    if threads is None:
        raise HTTPException(status_code=503, detail="thread store unavailable")
    actor = current_username(request) or ""
    await _require_author_or_moderator(state, request, case_id, msg_id, actor)
    updated = await threads.delete(case_id, msg_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="message not found or already deleted")
    await _audit(state, ActionType.THREAD_POST, actor=actor, case_id=case_id,
                 summary=f"thread delete (tombstone) msg={msg_id}")
    await _activity(state, case_id, kind="deleted_comment", actor=actor,
                    summary="message deleted", ref={"message_id": msg_id})
    _publish_case_activity(state, case_id, kind="deleted_comment", actor=actor,
                           summary="message deleted", ref={"message_id": msg_id})
    return _msg_public(updated)


@router.post("/cases/{case_id}/thread/{msg_id}/reactions")
async def react_case_message(
    case_id: str,
    msg_id: str,
    body: ReactionBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "comment")),
) -> dict[str, Any]:
    """Toggle one ``{emoji, user}`` reaction on a thread message (idempotent add;
    ``remove=true`` removes). The emoji is plain data (#9). #3: never touches the case
    decision."""
    await _require_case(state, case_id)
    threads = getattr(state, "case_threads", None)
    if threads is None:
        raise HTTPException(status_code=503, detail="thread store unavailable")
    emoji = _clip(body.emoji, _EMOJI_MAX)
    if not emoji:
        raise HTTPException(status_code=400, detail="emoji is required")
    actor = current_username(request) or ""
    updated = await threads.react(case_id, msg_id, emoji, actor, remove=bool(body.remove))
    if updated is None:
        raise HTTPException(status_code=404, detail="message not found or deleted")
    await _audit(state, ActionType.REACTION, actor=actor, case_id=case_id,
                 summary=f"reaction {'-' if body.remove else '+'}{emoji} msg={msg_id}")
    _publish_case_activity(
        state, case_id, kind="reaction", actor=actor,
        ref={"message_id": msg_id, "emoji": emoji, "removed": bool(body.remove)},
    )
    return _msg_public(updated)


# --------------------------------------------------------------------------- #
# TASKS / checklist
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/tasks")
async def get_case_tasks(
    case_id: str,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """The case task checklist, sorted by manual ``order`` then creation. Titles +
    log notes are plain data (#9)."""
    await _require_case(state, case_id)
    store = getattr(state, "case_tasks", None)
    if store is None:
        return {"case_id": case_id, "tasks": [], "count": 0}
    tasks = await store.list_for_case(case_id)
    return {
        "case_id": case_id,
        "tasks": [t.model_dump(mode="json") for t in tasks],
        "count": len(tasks),
    }


@router.post("/cases/{case_id}/tasks")
async def add_case_task(
    case_id: str,
    body: TaskCreateBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "write")),
) -> dict[str, Any]:
    """Create a checklist task on a case (appended last). #3: a task is advisory work
    tracking — it never reads or sets the case decision."""
    await _require_case(state, case_id)
    store = getattr(state, "case_tasks", None)
    if store is None:
        raise HTTPException(status_code=503, detail="task store unavailable")
    title = _clip(body.title, _TITLE_MAX)
    if not title:
        raise HTTPException(status_code=400, detail="task title is required")
    actor = current_username(request) or ""
    assignee = _clip(body.assignee, 80) or None
    task = await store.add(case_id, title, assignee=assignee, status=body.status)
    await _audit(state, ActionType.TASK_UPDATE, actor=actor, case_id=case_id,
                 summary=f"task add: {truncate(title, 120)}")
    await _activity(state, case_id, kind="task_added", actor=actor,
                    summary=truncate(title, 200), ref={"task_id": task.id})
    _publish_case_activity(state, case_id, kind="task_added", actor=actor,
                           summary=truncate(title, 200), ref={"task_id": task.id})
    return task.model_dump(mode="json")


@router.patch("/cases/{case_id}/tasks/{tid}")
async def patch_case_task(
    case_id: str,
    tid: str,
    body: TaskPatchBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "write")),
) -> dict[str, Any]:
    """Patch a task (title / assignee / status / order). Only provided fields change.
    #3: a task status (open/in_progress/done/blocked) is NOT a case status — it never
    touches the case decision."""
    await _require_case(state, case_id)
    store = getattr(state, "case_tasks", None)
    if store is None:
        raise HTTPException(status_code=503, detail="task store unavailable")
    actor = current_username(request) or ""
    fields: dict[str, Any] = {}
    if body.title is not None:
        fields["title"] = _clip(body.title, _TITLE_MAX)
    if body.assignee is not None:
        fields["assignee"] = _clip(body.assignee, 80)
    if body.status is not None:
        fields["status"] = (body.status or "").strip().lower()
    if body.order is not None:
        fields["order"] = int(body.order)
    updated = await store.update(case_id, tid, **fields)
    if updated is None:
        raise HTTPException(status_code=404, detail="task not found")
    await _audit(state, ActionType.TASK_UPDATE, actor=actor, case_id=case_id,
                 summary=f"task update {tid}: {', '.join(sorted(fields)) or 'no-op'}")
    await _activity(state, case_id, kind="task_updated", actor=actor,
                    summary=f"task {updated.status}: {truncate(updated.title, 160)}",
                    ref={"task_id": tid})
    _publish_case_activity(
        state, case_id, kind="task_updated", actor=actor,
        summary=f"task {updated.status}: {truncate(updated.title, 160)}",
        ref={"task_id": tid},
    )
    return updated.model_dump(mode="json")


@router.post("/cases/{case_id}/tasks/{tid}/log")
async def log_case_task(
    case_id: str,
    tid: str,
    body: TaskLogBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "write")),
) -> dict[str, Any]:
    """Append a note to a task's append-only log trail. The note is plain data (#9)."""
    await _require_case(state, case_id)
    store = getattr(state, "case_tasks", None)
    if store is None:
        raise HTTPException(status_code=503, detail="task store unavailable")
    note = _clip(body.note, _NOTE_MAX)
    if not note:
        raise HTTPException(status_code=400, detail="log note is required")
    actor = current_username(request) or ""
    updated = await store.log(case_id, tid, note, by=actor)
    if updated is None:
        raise HTTPException(status_code=404, detail="task not found")
    await _audit(state, ActionType.TASK_UPDATE, actor=actor, case_id=case_id,
                 summary=f"task log {tid}: {truncate(note, 120)}")
    _publish_case_activity(state, case_id, kind="task_logged", actor=actor,
                           summary=truncate(note, 200), ref={"task_id": tid})
    return updated.model_dump(mode="json")
