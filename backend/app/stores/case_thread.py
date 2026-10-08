"""Per-case THREAD store — threaded case discussion (Round 3 collaboration).

A case THREAD is the ordered list of :class:`app.models.CaseMessage` for one case
(human + AI + system authors, threaded replies, @mentions, emoji reactions,
edit/delete tombstones). It is the friendly collaboration surface beside the
authoritative ``AuditDoc`` trail — advisory only, it NEVER feeds the deterministic
``case_manager.decide()`` (#3), and every ``body``/``mentions`` value is plain,
render-escaped user input (never an unfenced prompt instruction, #9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory` / :mod:`app.stores.user_prefs`): the WHOLE thread set is
ONE KV document (``ns=CASE_THREAD_NS``, ``key=CASE_THREAD_KEY``) whose value is
``{"threads": {"<case_id>": [<CaseMessage json>, ...], ...}}`` — so it needs NO new
ES index / SQL table / migration. The SQL backend uses ``SqlKVStore`` (the shared
KV table); the ES backend uses the thin :class:`app.stores.memory.EsKVStore`
adapter (a doc in the existing config index).

Reads + writes are read-modify-write over the single dict — fine at our scale
(operator collaboration, not log volume). The store NEVER raises: a load/save
failure degrades to an empty thread / best-effort write and is logged, so a thread
glitch can never drop an alert or break a case page. The one exception is
:meth:`CaseThreadStore.append_if_absent`, which exists to REPORT whether a keyed
chat turn was written, so it confirms its write and raises
:class:`CaseThreadWriteFailed` instead of returning an optimistic result.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, TypeVar

from ..constants import CASE_THREAD_KEY, CASE_THREAD_NS
from ..models import CaseMessage
from ..utils import iso_now
from .base import KVStore, kv_mutate, kv_mutate_strict

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.case_thread")


def _norm_case_id(case_id: str | None) -> str:
    return (case_id or "").strip()


class CaseThreadWriteFailed(RuntimeError):
    """A confirmed thread write could not be proven durable (backend error or
    exhausted compare-and-set retries); nothing can be assumed written."""


class CaseThreadStore:
    """CRUD over per-case message threads, persisted as one KV document.

    The KV value is ``{"threads": {"<case_id>": [<CaseMessage json>, ...]}}``.
    Methods are read-modify-write; none raises (a failure logs + returns a safe
    default). Messages within a case keep insertion order (chronological)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict | None) -> dict[str, list[CaseMessage]]:
        raw = doc.get("threads", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[CaseMessage]] = {}
        for cid, items in (raw or {}).items():
            msgs: list[CaseMessage] = []
            for item in items or []:
                try:
                    msgs.append(CaseMessage.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt message, keep the rest
                    continue
            out[str(cid)] = msgs
        return out

    @staticmethod
    def _encode(threads: dict[str, list[CaseMessage]]) -> dict:
        return {"threads": {cid: [m.model_dump(mode="json") for m in msgs]
                            for cid, msgs in threads.items()}}

    async def _load_all(self) -> dict[str, list[CaseMessage]]:
        try:
            doc = await self._kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)
        except Exception as exc:  # noqa: BLE001 — threads are best-effort
            logger.warning("Loading case threads failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, list[CaseMessage]]], _T]) -> _T:
        """Atomic read-modify-write over the shared thread doc (lost-update safe)."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            threads = self._decode(current)
            box["r"] = change(threads)
            return self._encode(threads)

        await kv_mutate(self._kv, CASE_THREAD_NS, CASE_THREAD_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    async def list_for_case(self, case_id: str | None) -> list[CaseMessage]:
        """Every message for a case in insertion (chronological) order — including
        tombstoned (deleted) messages so the UI can render a 'message deleted'
        placeholder; the caller filters if it wants only live messages."""
        cid = _norm_case_id(case_id)
        if not cid:
            return []
        return list((await self._load_all()).get(cid, []))

    async def get(self, case_id: str | None, message_id: str) -> CaseMessage | None:
        for m in await self.list_for_case(case_id):
            if m.id == message_id:
                return m
        return None

    async def append(self, message: CaseMessage) -> CaseMessage:
        """Append a message to its case's thread (keyed by ``message.case_id``).

        The caller builds + validates the :class:`CaseMessage` (body already plain
        data, #9). Returns the stored message."""
        cid = _norm_case_id(message.case_id)
        if not cid:
            raise ValueError("message.case_id is required")

        def _change(threads: dict[str, list[CaseMessage]]) -> None:
            msgs = list(threads.get(cid, []))
            msgs.append(message)
            threads[cid] = msgs

        await self._mutate(_change)
        return message

    async def append_if_absent(self, message: CaseMessage) -> tuple[CaseMessage, bool]:
        """Append ``message`` unless its case thread already holds a message with the
        same id, as ONE confirmed compare-and-set mutation. Returns ``(stored,
        appended)``: the existing message and False when the id was already there.

        A retried case-scoped chat turn derives deterministic message ids from its
        idempotency key (chat revamp SPEC §4.6); a check-then-append outside the CAS
        would let two simultaneous retries both see "absent" and duplicate the turn.

        Unlike the other methods this one is STRICT: the best-effort ``kv_mutate``
        returns its computed value even when nothing was stored, which would report
        ``appended=True`` for a lost write and leave the caller unable to tell
        "already appended" from "never written". A write that cannot be confirmed
        raises :class:`CaseThreadWriteFailed` (the engine maps it to a retryable
        ``not_saved`` notice)."""
        cid = _norm_case_id(message.case_id)
        if not cid:
            raise ValueError("message.case_id is required")
        box: dict[str, tuple[CaseMessage, bool]] = {}

        def _mutator(current: dict | None) -> dict:
            # Pure in its snapshot: a CAS retry re-runs it on the fresh document.
            threads = self._decode(current)
            msgs = list(threads.get(cid, []))
            existing = next((m for m in msgs if m.id == message.id), None)
            if existing is not None:
                box["r"] = (existing, False)
            else:
                threads[cid] = [*msgs, message]
                box["r"] = (message, True)
            return self._encode(threads)

        try:
            await kv_mutate_strict(self._kv, CASE_THREAD_NS, CASE_THREAD_KEY, _mutator, lock=self._lock)
        except Exception as exc:  # noqa: BLE001 -- any failure means "not proven written"
            logger.warning("Confirmed case-thread append failed (%s)", type(exc).__name__)
            raise CaseThreadWriteFailed("The case thread could not be saved.") from exc
        return box["r"]

    async def edit(self, case_id: str | None, message_id: str, body: str,
                   *, editor: str = "") -> CaseMessage | None:
        """Edit a message body in place (stamps ``edited_at``). Editing a tombstoned
        (deleted) message is a no-op (returns None). ``body`` is plain data (#9)."""
        cid = _norm_case_id(case_id)

        def _change(threads: dict[str, list[CaseMessage]]) -> CaseMessage | None:
            msgs = list(threads.get(cid, []))
            for idx, m in enumerate(msgs):
                if m.id != message_id or m.deleted_at:
                    continue
                upd = m.model_copy(update={"body": body or "", "edited_at": iso_now()})
                msgs[idx] = upd
                threads[cid] = msgs
                return upd
            return None

        return await self._mutate(_change)

    async def delete(self, case_id: str | None, message_id: str) -> CaseMessage | None:
        """Tombstone a message (sets ``deleted_at`` — the row STAYS so threaded
        replies keep their parent and the audit/UI can render 'deleted'). Returns
        the tombstoned message, or None if not found / already deleted."""
        cid = _norm_case_id(case_id)

        def _change(threads: dict[str, list[CaseMessage]]) -> CaseMessage | None:
            msgs = list(threads.get(cid, []))
            for idx, m in enumerate(msgs):
                if m.id != message_id or m.deleted_at:
                    continue
                upd = m.model_copy(update={"deleted_at": iso_now(), "body": ""})
                msgs[idx] = upd
                threads[cid] = msgs
                return upd
            return None

        return await self._mutate(_change)

    async def react(self, case_id: str | None, message_id: str, emoji: str,
                    user: str, *, remove: bool = False) -> CaseMessage | None:
        """Toggle (add unless ``remove``) one ``{emoji, user}`` reaction on a message.

        Adding is idempotent (the same user can't double-react with the same emoji).
        ``emoji``/``user`` are plain data. Returns the updated message, or None."""
        cid = _norm_case_id(case_id)
        emoji = (emoji or "").strip()
        user = (user or "").strip()
        if not emoji:
            return await self.get(case_id, message_id)

        def _change(threads: dict[str, list[CaseMessage]]) -> CaseMessage | None:
            msgs = list(threads.get(cid, []))
            for idx, m in enumerate(msgs):
                if m.id != message_id or m.deleted_at:
                    continue
                reactions = [
                    r for r in m.reactions
                    if not (isinstance(r, dict) and r.get("emoji") == emoji and r.get("user") == user)
                ]
                if not remove:
                    reactions.append({"emoji": emoji, "user": user})
                upd = m.model_copy(update={"reactions": reactions})
                msgs[idx] = upd
                threads[cid] = msgs
                return upd
            return None

        return await self._mutate(_change)

    async def delete_case(self, case_id: str | None) -> bool:
        """Drop an entire case's thread (e.g. on case purge). Returns True if it
        existed."""
        cid = _norm_case_id(case_id)

        def _change(threads: dict[str, list[CaseMessage]]) -> bool:
            if cid not in threads:
                return False
            del threads[cid]
            return True

        return await self._mutate(_change)
