"""Per-user chat starter state (Round 13, ``docs/research/2026-10-round13/SPEC-chat.md``
§3.2.3, §3.6, §3.12).

What it holds, and only that (D10): the caller's visit clock (``last_seen_at``,
``visit_started_at``, ``catchup_since``, ``shift_started_at``), a least-recently-viewed
list of at most 64 opaque starter KEYS with their FAMILY id, view count, last view and
last use, and the families the caller hid for a day. Never a question, a value, an
answer or a conversation id. It is presentation state: never sent to a model, never
used to train or tune anything, never shown in an admin view, never exported, never
aggregated across users, and cleared with the user (``AuthService.purge_user_side_state``)
and by a factory reset (the wholesale KV purge).

Storage (the zero-migration KV pattern of ``stores/chat_feedback.py``; no new index or
table): ONE document per user, ``(CHAT_STARTERS_NS, "user-<sha256>")`` (the chat history
partition hash, so a raw username never reaches a key), holding the schema 1 document of
:class:`app.engine.chat_starters.StarterUserState` as ONE opaque canonical-JSON string
(``chat_starters_json``), so on Elasticsearch the document's field paths are a fixed
handful whatever it holds. At most :data:`~app.engine.chat_starters.STATE_MAX_BYTES`
(8 KB): the oldest viewed keys are dropped first until it fits. Writes are strict
compare-and-set with a confirming read (``CAS_RETRIES``), like chat history; the store
is built over the ACTIVE chat KV, so Demo state stays in the Demo sandbox.
"""

from __future__ import annotations

import asyncio
import copy
import json
import weakref
from datetime import datetime, timezone
from typing import Any, Callable

from ..engine.chat_starters import (
    STATE_MAX_BYTES,
    STATE_SCHEMA,
    StarterUserState,
    state_size,
)
from .base import KVStore
from .chat_conversations import ChatHistoryUnavailable, partition_key_for_user

CHAT_STARTERS_NS = "chat_starters"
STARTERS_FIELD = "chat_starters_json"
CAS_RETRIES = 8
_STORES: "weakref.WeakKeyDictionary[Any, ChatStartersStore]" = weakref.WeakKeyDictionary()


def _rev(doc: dict[str, Any] | None) -> int:
    try:
        return max(0, int((doc or {}).get("_rev", 0)))
    except (TypeError, ValueError):
        return 0


def _decode(doc: dict[str, Any] | None) -> StarterUserState:
    """The stored state (lenient: anything unreadable is an empty state, never an
    error). ``rev`` is the document revision as a string ("0" when absent)."""
    rev = str(_rev(doc))
    raw = (doc or {}).get(STARTERS_FIELD)
    if not isinstance(raw, str) or not raw:
        return StarterUserState(rev=rev)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return StarterUserState(rev=rev)
    return StarterUserState.from_doc(parsed, rev=rev)


def canonical(state: StarterUserState) -> str:
    """The canonical stored form of ``state`` (sorted keys, no spaces)."""
    return json.dumps(state.to_doc(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fit(state: StarterUserState) -> StarterUserState:
    """``state`` within :data:`STATE_MAX_BYTES`: the least recently viewed keys go first,
    then (only if still too large) the dismissals that end soonest. Never raises."""
    if state_size(state) <= STATE_MAX_BYTES:
        return state
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    state.keys.sort(key=lambda s: (s.last_view_at or epoch, s.key))
    while state.keys and state_size(state) > STATE_MAX_BYTES:
        del state.keys[0]
    if state_size(state) > STATE_MAX_BYTES:
        ordered = sorted(state.dismissed.items(), key=lambda item: item[1])
        while ordered and state_size(state) > STATE_MAX_BYTES:
            ordered.pop(0)
            state.dismissed = dict(ordered)
    return state


def _encode(state: StarterUserState) -> dict[str, Any]:
    return {"schema": STATE_SCHEMA, STARTERS_FIELD: canonical(fit(state))}


def starters_store_for(kv: KVStore) -> "ChatStartersStore":
    """THE starter state store over ``kv`` (one per KV, so its per-user locks serialise
    every in-process write). Callers pass the ACTIVE chat KV (the chat history store's),
    so Demo Mode reads and writes the demo stack's throwaway KV."""
    store = _STORES.get(kv)
    if store is None:
        store = ChatStartersStore(kv)
        _STORES[kv] = store
    return store


class ChatStartersStore:
    """Strict per-user starter state documents over the shared KV."""

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
                await getter(CHAT_STARTERS_NS, key) if callable(getter)
                else await self._kv.get(CHAT_STARTERS_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat suggestions could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise ChatHistoryUnavailable("Chat suggestions returned an invalid document.")
        return copy.deepcopy(value)

    async def _strict_put_if(self, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        try:
            return bool(
                await writer(CHAT_STARTERS_NS, key, value, expected_rev) if callable(writer)
                else await self._kv.put_if(CHAT_STARTERS_NS, key, value, expected_rev)
            )
        except Exception as exc:  # noqa: BLE001
            raise ChatHistoryUnavailable("Chat suggestions could not be saved.") from exc

    async def load(self, owner: str | None) -> StarterUserState:
        """The owner's state (an empty state when there is none). ``state.rev`` is the
        document revision (the response cache key's ``state_rev``). Raises
        :class:`ChatHistoryUnavailable` when the store cannot be read."""
        return _decode(await self._strict_get(partition_key_for_user(owner)))

    async def update(
        self, owner: str | None, change: Callable[[StarterUserState], StarterUserState],
    ) -> StarterUserState:
        """Apply ``change`` (a pure transition of ``engine.chat_starters``) to the owner's
        state with strict compare-and-set and a confirming read; the result is trimmed to
        8 KB before it is written. Returns the saved state (with its new ``rev``)."""
        key = partition_key_for_user(owner)
        async with self._lock_for(key):
            for _attempt in range(CAS_RETRIES):
                current = await self._strict_get(key)
                expected = _rev(current)
                proposed = _encode(change(_decode(current)))
                saved = copy.deepcopy(proposed)
                saved["_rev"] = expected + 1
                if not await self._strict_put_if(key, saved, expected):
                    continue
                confirmed = await self._strict_get(key)
                if _rev(confirmed) < expected + 1:
                    raise ChatHistoryUnavailable("Chat suggestions storage did not confirm the write.")
                return _decode(saved)
        raise ChatHistoryUnavailable("Chat suggestions changed too quickly; retry.")

    async def clear(self, owner: str | None) -> int:
        """Drop the owner's whole state (a deleted account: the document is keyed by the
        username, so a new account of the same name must not inherit it). Returns 1 when
        there was state to clear, else 0."""
        key = partition_key_for_user(owner)
        current = await self._strict_get(key)
        if current is None or not current.get(STARTERS_FIELD):
            return 0
        async with self._lock_for(key):
            for _attempt in range(CAS_RETRIES):
                current = await self._strict_get(key)
                if current is None or not current.get(STARTERS_FIELD):
                    return 0
                expected = _rev(current)
                if await self._strict_put_if(key, {"schema": STATE_SCHEMA, "_rev": expected + 1}, expected):
                    return 1
        raise ChatHistoryUnavailable("Chat suggestions changed too quickly; retry.")


__all__ = [
    "CAS_RETRIES",
    "CHAT_STARTERS_NS",
    "STARTERS_FIELD",
    "ChatStartersStore",
    "canonical",
    "fit",
    "starters_store_for",
]
