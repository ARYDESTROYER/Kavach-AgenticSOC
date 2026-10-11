"""Per-user chat answer feedback (Round 12, SPEC §3.2 / SYNTHESIS-chat P1-4).

A thumbs-up or thumbs-down on one Workspace answer, with an optional reason
(``wrong``, ``incomplete``, ``slow``, ``other``) and a short comment. It is stored
per user and audited by the route; it is **never** used to train or tune a model and
never feeds a case decision (#3) — it exists for the analyst's own record and for
aggregate quality reporting.

Storage (same zero-migration KV pattern as every other store; no new index or
table): ONE document per user, ``(CHAT_FEEDBACK_NS, "user-<sha256>")`` — the chat
history partition hash, so a raw username never reaches a key — holding the entries
as ONE opaque canonical-JSON string (``chat_feedback_json``). On Elasticsearch every
KV namespace shares one dynamically mapped config index, so the document's field
paths are a fixed handful whatever it holds. One entry per answer (rating again
replaces it); at most :data:`MAX_FEEDBACK_PER_USER` entries, the oldest dropped first.
Writes are strict compare-and-set with a confirming read, like chat history.
"""

from __future__ import annotations

import asyncio
import copy
import json
import weakref
from dataclasses import dataclass
from typing import Any, Callable, TypeVar, get_args

from ..models import ChatFeedbackReason, ChatFeedbackRequest
from ..utils import iso_now
from .base import KVStore
from .chat_conversations import ChatHistoryUnavailable, normalize_user_id, partition_key_for_user

_T = TypeVar("_T")

CHAT_FEEDBACK_NS = "chat_feedback"
# The reasons a thumbs-down may carry (``ChatFeedbackRequest.reason``).
FEEDBACK_REASONS: tuple[str, ...] = tuple(get_args(ChatFeedbackReason))
FEEDBACK_FIELD = "chat_feedback_json"
FEEDBACK_SCHEMA = 1
MAX_FEEDBACK_PER_USER = 500
CAS_RETRIES = 8
_STORES: "weakref.WeakKeyDictionary[Any, ChatFeedbackStore]" = weakref.WeakKeyDictionary()


@dataclass(frozen=True)
class ChatFeedbackEntry:
    """One stored rating (plain data; the comment is the user's own text)."""

    conversation_id: str
    message_id: str
    rating: str
    reason: str | None
    comment: str
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id, "message_id": self.message_id,
            "rating": self.rating, "reason": self.reason, "comment": self.comment,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }


def _entry(raw: Any) -> ChatFeedbackEntry | None:
    if not isinstance(raw, dict):
        return None
    try:
        request = ChatFeedbackRequest.model_validate({
            "conversation_id": raw.get("conversation_id"), "message_id": raw.get("message_id"),
            "rating": raw.get("rating"), "reason": raw.get("reason"),
            "comment": raw.get("comment") or "",
        })
    except Exception:  # noqa: BLE001 -- one corrupt row never hides the others
        return None
    created = str(raw.get("created_at") or "")
    return ChatFeedbackEntry(
        conversation_id=request.conversation_id, message_id=request.message_id,
        rating=request.rating, reason=request.reason, comment=request.comment,
        created_at=created, updated_at=str(raw.get("updated_at") or created),
    )


def _entries(doc: dict[str, Any] | None) -> list[ChatFeedbackEntry]:
    raw = (doc or {}).get(FEEDBACK_FIELD)
    if not isinstance(raw, str) or not raw:
        return []
    try:
        rows = json.loads(raw)
    except (TypeError, ValueError):
        return []
    out: list[ChatFeedbackEntry] = []
    for row in rows if isinstance(rows, list) else []:
        entry = _entry(row)
        if entry is not None:
            out.append(entry)
    return out


def _encode(entries: list[ChatFeedbackEntry]) -> dict[str, Any]:
    rows = [entry.as_dict() for entry in entries]
    return {
        "schema": FEEDBACK_SCHEMA,
        FEEDBACK_FIELD: json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
    }


def _rev(doc: dict[str, Any] | None) -> int:
    try:
        return max(0, int((doc or {}).get("_rev", 0)))
    except (TypeError, ValueError):
        return 0


def feedback_store_for(kv: KVStore) -> "ChatFeedbackStore":
    """THE feedback store over ``kv`` (one per KV, so its per-user locks serialise
    every in-process write). Callers pass the ACTIVE chat KV — the chat history
    store's — so Demo Mode reads and writes the demo stack's throwaway KV."""
    store = _STORES.get(kv)
    if store is None:
        store = ChatFeedbackStore(kv)
        _STORES[kv] = store
    return store


class ChatFeedbackStore:
    """Strict per-user feedback documents over the shared KV."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def _strict_get(self, key: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None)
        try:
            value = (
                await getter(CHAT_FEEDBACK_NS, key) if callable(getter)
                else await self._kv.get(CHAT_FEEDBACK_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat feedback could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise ChatHistoryUnavailable("Chat feedback returned an invalid document.")
        return copy.deepcopy(value)

    async def _strict_put_if(self, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        try:
            return bool(
                await writer(CHAT_FEEDBACK_NS, key, value, expected_rev) if callable(writer)
                else await self._kv.put_if(CHAT_FEEDBACK_NS, key, value, expected_rev)
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat feedback could not be saved.") from exc

    async def _mutate(self, key: str, change: Callable[[dict[str, Any] | None], tuple[dict[str, Any], _T]]) -> _T:
        async with self._lock_for(key):
            for _attempt in range(CAS_RETRIES):
                current = await self._strict_get(key)
                expected = _rev(current)
                proposed, result = change(copy.deepcopy(current))
                saved = copy.deepcopy(proposed)
                saved["_rev"] = expected + 1
                if not await self._strict_put_if(key, saved, expected):
                    continue
                confirmed = await self._strict_get(key)
                if _rev(confirmed) < expected + 1:
                    raise ChatHistoryUnavailable("Chat feedback storage did not confirm the write.")
                return result
        raise ChatHistoryUnavailable("Chat feedback changed too quickly; retry.")

    async def record(self, owner: str | None, request: ChatFeedbackRequest) -> tuple[ChatFeedbackEntry, bool]:
        """Store (or replace) the caller's rating of one answer. Returns ``(entry,
        replaced)``. The oldest entries are dropped past :data:`MAX_FEEDBACK_PER_USER`."""
        key = partition_key_for_user(owner)
        now = iso_now()

        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], tuple[ChatFeedbackEntry, bool]]:
            entries = _entries(current)
            previous = next(
                (e for e in entries
                 if e.conversation_id == request.conversation_id and e.message_id == request.message_id),
                None,
            )
            entry = ChatFeedbackEntry(
                conversation_id=request.conversation_id, message_id=request.message_id,
                rating=request.rating, reason=request.reason, comment=request.comment,
                created_at=previous.created_at if previous else now, updated_at=now,
            )
            kept = [e for e in entries if e is not previous]
            kept.append(entry)
            kept = kept[-MAX_FEEDBACK_PER_USER:]
            return _encode(kept), (entry, previous is not None)

        return await self._mutate(key, _change)

    async def list(self, owner: str | None, *, conversation_id: str | None = None) -> list[ChatFeedbackEntry]:
        """The caller's ratings, newest first (optionally for one conversation)."""
        entries = _entries(await self._strict_get(partition_key_for_user(owner)))
        if conversation_id is not None:
            entries = [e for e in entries if e.conversation_id == conversation_id]
        return sorted(entries, key=lambda e: (e.updated_at, e.message_id), reverse=True)

    async def counts(self, owner: str | None) -> dict[str, int]:
        """``{"up": n, "down": m}`` over the caller's stored ratings."""
        out = {"up": 0, "down": 0}
        for entry in await self.list(owner):
            out[entry.rating] = out.get(entry.rating, 0) + 1
        return out

    async def breakdown(
        self, owner: str | None, *, since: str | None = None, until: str | None = None,
    ) -> dict[str, Any]:
        """The owner's ratings as AGGREGATES only (SYNTHESIS-chat P1-4): totals, the
        thumbs-down reasons and how many came with a comment — never a comment, a
        conversation or a message id. ``since``/``until`` (ISO): only ratings given or
        changed in ``[since, until]``. Never used to train or tune a model (#3)."""
        reasons = {reason: 0 for reason in FEEDBACK_REASONS}
        out: dict[str, Any] = {"up": 0, "down": 0, "total": 0, "with_comment": 0,
                               "down_by_reason": reasons, "down_without_reason": 0}
        for entry in await self.list(owner):
            if since and entry.updated_at < since:
                continue
            if until and entry.updated_at > until:
                continue
            out["total"] += 1
            out[entry.rating] = out.get(entry.rating, 0) + 1
            if entry.comment.strip():
                out["with_comment"] += 1
            if entry.rating == "down":
                if entry.reason in reasons:
                    reasons[entry.reason] += 1
                else:
                    out["down_without_reason"] += 1
        return out

    async def forget_conversation(self, owner: str | None, conversation_id: str) -> int:
        """Drop the caller's ratings of one deleted conversation (their comments are
        the user's own text). Returns how many were removed."""
        return await self.forget_partition_conversations(partition_key_for_user(owner), {conversation_id})

    async def forget_partition_conversations(self, partition_key: str, conversation_ids: set[str]) -> int:
        """The same by the owner's partition key (the chat store's delete, eviction and
        clear paths, which know only the key)."""
        if not conversation_ids:
            return 0
        current = await self._strict_get(partition_key)
        if not any(e.conversation_id in conversation_ids for e in _entries(current)):
            return 0

        def _change(doc: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
            entries = _entries(doc)
            kept = [e for e in entries if e.conversation_id not in conversation_ids]
            return _encode(kept), len(entries) - len(kept)

        return await self._mutate(partition_key, _change)

    async def clear(self, owner: str | None) -> int:
        """Drop ALL of the owner's ratings (a deleted account, Round 12 final review
        L1): the document is keyed by the username, so a new account of the same
        name must not inherit them. Returns how many were removed."""
        key = partition_key_for_user(owner)
        current = await self._strict_get(key)
        if current is None or (not _entries(current) and not current.get(FEEDBACK_FIELD)):
            return 0

        def _change(doc: dict[str, Any] | None) -> tuple[dict[str, Any], int]:
            return _encode([]), len(_entries(doc))

        return await self._mutate(key, _change)


__all__ = [
    "CHAT_FEEDBACK_NS",
    "FEEDBACK_REASONS",
    "FEEDBACK_FIELD",
    "MAX_FEEDBACK_PER_USER",
    "ChatFeedbackEntry",
    "ChatFeedbackStore",
    "normalize_user_id",
]
