"""Per-user INBOX store — in-app notification fan-out (Round 3).

An inbox item (:class:`app.models.InAppNotification`) is one notification fanned out
to ONE recipient (a case event / mention / assignment / approval / system / digest).
It is advisory only — it NEVER feeds ``case_manager.decide()`` (#3) — and every
``title``/``body`` is plain, render-escaped data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory` / :mod:`app.stores.user_prefs`): the WHOLE inbox set is ONE
KV document (``ns=INBOX_NS``, ``key=INBOX_KEY``) whose value is
``{"items": {"<user_id>": [<InAppNotification json>, ...], ...}}`` — so it needs NO
new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES
backend uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Per-user fan-out: a notification is appended to the recipient's bucket (keyed by a
NORMALISED user id, ``'default'`` when auth is off). The bucket is a BOUNDED ring
(~200 items/user) — the OLDEST are trimmed so a busy operator's inbox can't grow
without bound. Reads + writes are read-modify-write. The store NEVER raises: a
failure degrades to an empty inbox / best-effort write and is logged.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, TypeVar

from ..constants import INBOX_KEY, INBOX_NS, USER_PREFS_DEFAULT_BUCKET
from ..models import InAppNotification
from ..utils import iso_now
from .base import KVStore, kv_mutate, kv_mutate_strict

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.inbox")

# Bounded ring: keep at most this many items per user (trim the OLDEST). A read /
# unread inbox is a UI affordance, not an audit trail — the authoritative record is
# the audit log / case feed.
_MAX_PER_USER = 200

# Lifecycle states (mirrors InAppNotification.state); a dismissed item is dropped.
_READ_STATES = {"read", "archived"}


def _is_active_job(note: InAppNotification) -> bool:
    status = str(getattr(getattr(note, "job_status", None), "value", note.job_status) or "")
    return bool(note.job_id) and status in {"queued", "running"}


def _trim_preserving_active(notes: list[InAppNotification]) -> list[InAppNotification]:
    """Trim oldest terminal/general items first; active jobs are never evicted.

    If every item is active, temporary overflow is intentional: losing the only
    durable progress entry would be worse than exceeding the advisory ring cap.
    """
    if len(notes) <= _MAX_PER_USER:
        return notes
    excess = len(notes) - _MAX_PER_USER
    kept: list[InAppNotification] = []
    for note in notes:
        if excess > 0 and not _is_active_job(note):
            excess -= 1
            continue
        kept.append(note)
    return kept


def normalize_user_id(user_id: str | None) -> str:
    """Resolve a recipient to a bucket key (mirrors user_prefs.normalize_user_id).
    Empty / None → the shared ``default`` bucket (the no-auth profile)."""
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


class InboxStore:
    """Per-user in-app notification inbox, persisted as one KV document.

    The KV value is ``{"items": {"<user_id>": [<InAppNotification json>, ...]}}``.
    Methods are read-modify-write; none raises. Each user's list is a bounded ring
    (newest appended; oldest trimmed) and is surfaced NEWEST first."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # Per-store lock serialising the read-modify-write of the shared inbox doc
        # (lost-update safe; see :func:`app.stores.base.kv_mutate`).
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict | None) -> dict[str, list[InAppNotification]]:
        raw = doc.get("items", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[InAppNotification]] = {}
        for uid, items in (raw or {}).items():
            notes: list[InAppNotification] = []
            for item in items or []:
                try:
                    notes.append(InAppNotification.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt item, keep the rest
                    continue
            out[str(uid)] = notes
        return out

    @staticmethod
    def _decode_pending(doc: dict | None) -> dict[str, list[InAppNotification]]:
        """The per-user DEFERRED-digest buffer (items held back by quiet-hours /
        digest cadence rather than silently dropped). Stored under the ``pending``
        subkey of the same inbox doc so it needs no extra KV namespace."""
        raw = doc.get("pending", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[InAppNotification]] = {}
        for uid, items in (raw or {}).items():
            notes: list[InAppNotification] = []
            for item in items or []:
                try:
                    notes.append(InAppNotification.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt item, keep the rest
                    continue
            out[str(uid)] = notes
        return out

    @classmethod
    def _encode(cls, inboxes: dict[str, list[InAppNotification]],
                pending: dict[str, list[InAppNotification]] | None = None) -> dict:
        out: dict = {"items": {uid: [n.model_dump(mode="json") for n in notes]
                               for uid, notes in inboxes.items()}}
        if pending is not None:
            out["pending"] = {uid: [n.model_dump(mode="json") for n in notes]
                              for uid, notes in pending.items() if notes}
        return out

    async def _load_all(self) -> dict[str, list[InAppNotification]]:
        try:
            doc = await self._kv.get(INBOX_NS, INBOX_KEY)
        except Exception as exc:  # noqa: BLE001 — inbox is best-effort
            logger.warning("Loading inbox failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, list[InAppNotification]]], _T]) -> _T:
        """Atomic read-modify-write over the shared inbox doc (lost-update safe).

        ``change`` is applied to a FRESH decode of the current value (it may run
        more than once on a CAS retry) and may both mutate the dict AND stash a
        result; the result is returned. The sibling ``pending`` deferral buffer is
        preserved verbatim. Never raises (degrades + logs)."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            box["r"] = change(inboxes)
            return self._encode(inboxes, pending)

        await kv_mutate(self._kv, INBOX_NS, INBOX_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    async def _mutate_pending(
        self, change: Callable[[dict[str, list[InAppNotification]], dict[str, list[InAppNotification]]], _T]
    ) -> _T:
        """Atomic read-modify-write that may touch BOTH the live ``items`` map and the
        ``pending`` deferral buffer (e.g. a flush moves pending → items). Lost-update
        safe; never raises."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            box["r"] = change(inboxes, pending)
            return self._encode(inboxes, pending)

        await kv_mutate(self._kv, INBOX_NS, INBOX_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    async def append(self, notification: InAppNotification) -> InAppNotification:
        """Fan ONE notification out to ``notification.recipient`` (keyed by a
        normalised user id). Trims the recipient's ring to the cap (oldest dropped).
        Returns the stored notification."""
        uid = normalize_user_id(notification.recipient)

        def _change(inboxes: dict[str, list[InAppNotification]]) -> None:
            notes = list(inboxes.get(uid, []))
            notes.append(notification)
            inboxes[uid] = _trim_preserving_active(notes)

        await self._mutate(_change)
        return notification

    async def fanout(self, recipients: list[str], build) -> list[InAppNotification]:
        """Convenience multi-recipient fan-out: for each recipient call
        ``build(recipient) -> InAppNotification`` and append it. One read-modify-write
        for the whole batch. Returns the appended notifications."""
        # Build the notifications ONCE (outside the CAS retry) so a per-recipient
        # ``build`` side effect (e.g. a generated id) is stable across retries and
        # the returned list matches what's persisted.
        built: list[tuple[str, InAppNotification]] = []
        for r in recipients:
            try:
                note = build(r)
            except Exception:  # noqa: BLE001 — one bad recipient must not drop the batch
                continue
            built.append((normalize_user_id(note.recipient or r), note))
        if not built:
            return []

        def _change(inboxes: dict[str, list[InAppNotification]]) -> None:
            for uid, note in built:
                notes = list(inboxes.get(uid, []))
                notes.append(note)
                inboxes[uid] = _trim_preserving_active(notes)

        await self._mutate(_change)
        return [note for _, note in built]

    async def list_for_user(self, user_id: str | None, *, unread_only: bool = False,
                            limit: int = 50, offset: int = 0) -> tuple[list[InAppNotification], int]:
        """A user's inbox NEWEST first, paginated → ``(items, total_matching)``.

        ``unread_only`` filters to ``state in {unseen, seen}`` (i.e. not yet read /
        archived). ``archived`` items are excluded from the default view."""
        uid = normalize_user_id(user_id)
        notes = list((await self._load_all()).get(uid, []))
        notes = list(reversed(notes))  # newest first
        if unread_only:
            notes = [n for n in notes if n.state in ("unseen", "seen")]
        else:
            notes = [n for n in notes if n.state != "archived"]
        total = len(notes)
        if offset:
            notes = notes[offset:]
        if limit and limit > 0:
            notes = notes[:limit]
        return notes, total

    async def upsert_job(self, notification: InAppNotification) -> InAppNotification:
        """Insert or update one stable job notification in-place by ``job_id``."""
        uid = normalize_user_id(notification.recipient)

        def _change(inboxes: dict[str, list[InAppNotification]]) -> InAppNotification:
            notes = list(inboxes.get(uid, []))
            for index, existing in enumerate(notes):
                if existing.job_id and existing.job_id == notification.job_id:
                    was_active = _is_active_job(existing)
                    now_active = _is_active_job(notification)
                    # Preserve identity. A terminal update becomes newly unread so
                    # an operator who read progress before leaving still sees the
                    # eventual completion/failure badge on return.
                    notification.id = existing.id
                    notification.created_at = existing.created_at
                    if was_active and not now_active:
                        notification.state = "unseen"
                        notification.read_at = None
                    else:
                        notification.state = existing.state
                        notification.read_at = existing.read_at
                    notes[index] = notification
                    inboxes[uid] = _trim_preserving_active(notes)
                    return notification
            notes.append(notification)
            inboxes[uid] = _trim_preserving_active(notes)
            return notification

        return await self._mutate(_change)

    async def upsert_job_strict(
        self, notification: InAppNotification
    ) -> InAppNotification:
        """Confirmed stable job projection; raises rather than losing terminal state."""
        uid = normalize_user_id(notification.recipient)
        box: dict[str, InAppNotification] = {}

        def mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            notes = list(inboxes.get(uid, []))
            for index, existing in enumerate(notes):
                if existing.job_id and existing.job_id == notification.job_id:
                    was_active = _is_active_job(existing)
                    now_active = _is_active_job(notification)
                    notification.id = existing.id
                    notification.created_at = existing.created_at
                    if was_active and not now_active:
                        notification.state = "unseen"
                        notification.read_at = None
                    else:
                        notification.state = existing.state
                        notification.read_at = existing.read_at
                    notes[index] = notification
                    break
            else:
                notes.append(notification)
            inboxes[uid] = _trim_preserving_active(notes)
            box["value"] = notification
            return self._encode(inboxes, pending)

        await kv_mutate_strict(
            self._kv, INBOX_NS, INBOX_KEY, mutator, lock=self._lock
        )
        return box["value"]

    async def purge_job_entries(self) -> int:
        """Strictly remove personal/system job notes at a factory boundary."""
        box = {"count": 0}

        def mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            for uid, notes in list(inboxes.items()):
                kept = [note for note in notes if not note.job_id]
                box["count"] += len(notes) - len(kept)
                if kept:
                    inboxes[uid] = kept
                else:
                    inboxes.pop(uid, None)
            return self._encode(inboxes, pending)

        await kv_mutate_strict(
            self._kv, INBOX_NS, INBOX_KEY, mutator, lock=self._lock
        )
        return box["count"]

    async def purge_batch_entries_strict(self) -> int:
        """Remove LLM Batch projections when the Batch registry is reset."""
        box = {"count": 0}

        def mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            for uid, notes in list(inboxes.items()):
                kept = [note for note in notes if note.ref.get("kind") != "llm_batch"]
                box["count"] += len(notes) - len(kept)
                if kept:
                    inboxes[uid] = kept
                else:
                    inboxes.pop(uid, None)
            return self._encode(inboxes, pending)

        await kv_mutate_strict(
            self._kv, INBOX_NS, INBOX_KEY, mutator, lock=self._lock
        )
        return box["count"]

    async def remove_job_projection_strict(
        self,
        recipient: str,
        job_id: str,
        *,
        audience_generation: str | None = None,
    ) -> bool:
        """Strictly remove one stable application/LLM-Batch Inbox projection."""
        uid = normalize_user_id(recipient)
        removed = {"value": False}

        def mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            notes = list(inboxes.get(uid, []))
            kept = [
                note
                for note in notes
                if not (
                    note.job_id == job_id
                    and (
                        audience_generation is None
                        or note.audience_generation == audience_generation
                    )
                )
            ]
            removed["value"] = len(kept) != len(notes)
            if kept:
                inboxes[uid] = kept
            else:
                inboxes.pop(uid, None)
            return self._encode(inboxes, pending)

        await kv_mutate_strict(
            self._kv, INBOX_NS, INBOX_KEY, mutator, lock=self._lock
        )
        return removed["value"]

    async def clear_all_strict(self) -> int:
        """Confirmed factory-boundary purge of live and deferred Inbox state."""
        box = {"count": 0}

        def mutator(current: dict | None) -> dict:
            inboxes = self._decode(current)
            pending = self._decode_pending(current)
            box["count"] = sum(len(v) for v in inboxes.values()) + sum(
                len(v) for v in pending.values()
            )
            return self._encode({}, {})

        await kv_mutate_strict(
            self._kv, INBOX_NS, INBOX_KEY, mutator, lock=self._lock
        )
        return box["count"]

    async def unread_count(self, user_id: str | None) -> int:
        """Count of not-yet-read items (``state in {unseen, seen}``) — the badge."""
        uid = normalize_user_id(user_id)
        notes = (await self._load_all()).get(uid, [])
        return sum(1 for n in notes if n.state in ("unseen", "seen"))

    async def mark_read(self, user_id: str | None, notification_id: str) -> InAppNotification | None:
        """Mark one item read (stamps ``read_at``). Returns the updated item, or None."""
        uid = normalize_user_id(user_id)

        def _change(inboxes: dict[str, list[InAppNotification]]) -> InAppNotification | None:
            notes = list(inboxes.get(uid, []))
            for idx, n in enumerate(notes):
                if n.id != notification_id:
                    continue
                upd = n.model_copy(update={"state": "read", "read_at": iso_now()})
                notes[idx] = upd
                inboxes[uid] = notes
                return upd
            return None

        return await self._mutate(_change)

    async def mark_all_read(self, user_id: str | None) -> int:
        """Mark every not-yet-read item read. Returns the count marked."""
        uid = normalize_user_id(user_id)

        def _change(inboxes: dict[str, list[InAppNotification]]) -> int:
            notes = list(inboxes.get(uid, []))
            now = iso_now()
            count = 0
            for idx, n in enumerate(notes):
                if n.state in ("unseen", "seen"):
                    notes[idx] = n.model_copy(update={"state": "read", "read_at": now})
                    count += 1
            if count:
                inboxes[uid] = notes
            return count

        return await self._mutate(_change)

    async def archive(self, user_id: str | None, notification_id: str) -> InAppNotification | None:
        """Archive one item (hidden from the default inbox view; kept in the ring).
        Returns the updated item, or None."""
        uid = normalize_user_id(user_id)

        def _change(inboxes: dict[str, list[InAppNotification]]) -> InAppNotification | None:
            notes = list(inboxes.get(uid, []))
            for idx, n in enumerate(notes):
                if n.id != notification_id:
                    continue
                # An active job entry is the operator's only stable progress anchor.
                # It may be read, but cannot be hidden until the terminal update.
                if _is_active_job(n):
                    return None
                patch = {"state": "archived"}
                if not n.read_at:
                    patch["read_at"] = iso_now()
                upd = n.model_copy(update=patch)
                notes[idx] = upd
                inboxes[uid] = notes
                return upd
            return None

        return await self._mutate(_change)

    async def dismiss(self, user_id: str | None, notification_id: str) -> bool:
        """Permanently DROP one item from a user's inbox. Returns True if it existed."""
        uid = normalize_user_id(user_id)

        def _change(inboxes: dict[str, list[InAppNotification]]) -> bool:
            notes = list(inboxes.get(uid, []))
            if any(n.id == notification_id and _is_active_job(n) for n in notes):
                return False
            remaining = [n for n in notes if n.id != notification_id]
            if len(remaining) == len(notes):
                return False
            inboxes[uid] = remaining
            return True

        return await self._mutate(_change)

    async def clear(self, user_id: str | None) -> int:
        """Drop a user's whole inbox (e.g. on user delete). Returns the count removed."""
        uid = normalize_user_id(user_id)

        def _change(inboxes: dict[str, list[InAppNotification]],
                    pending: dict[str, list[InAppNotification]]) -> int:
            n = len(inboxes.get(uid, [])) + len(pending.get(uid, []))
            inboxes.pop(uid, None)
            pending.pop(uid, None)  # also drop any deferred-digest items on delete
            return n

        return await self._mutate_pending(_change)

    async def clear_non_job(self) -> int:
        """Clear ordinary case notifications while preserving every job anchor."""

        def _change(
            inboxes: dict[str, list[InAppNotification]],
            pending: dict[str, list[InAppNotification]],
        ) -> int:
            removed = 0
            for uid, notes in list(inboxes.items()):
                kept = [note for note in notes if note.job_id]
                removed += len(notes) - len(kept)
                if kept:
                    inboxes[uid] = kept
                else:
                    inboxes.pop(uid, None)
            # Deferred digests never contain authoritative job progress.
            removed += sum(len(notes) for notes in pending.values())
            pending.clear()
            return removed

        return await self._mutate_pending(_change)

    # -- deferred-digest buffer (quiet-hours / digest cadence) -------------- #
    async def defer(self, notification: InAppNotification) -> InAppNotification:
        """RECORD a notification the dispatcher would otherwise DROP because the
        recipient is in quiet-hours / on a digest cadence — held in a per-user
        ``pending`` buffer (bounded ring) instead of being silently lost, so it can
        be surfaced when the quiet window ends / the digest fires (see
        :meth:`flush_pending_digest`). Returns the deferred notification."""
        uid = normalize_user_id(notification.recipient)

        def _change(inboxes: dict[str, list[InAppNotification]],
                    pending: dict[str, list[InAppNotification]]) -> None:
            notes = list(pending.get(uid, []))
            notes.append(notification)
            if len(notes) > _MAX_PER_USER:
                notes = notes[-_MAX_PER_USER:]
            pending[uid] = notes

        await self._mutate_pending(_change)
        return notification

    async def list_pending(self, user_id: str | None) -> list[InAppNotification]:
        """A user's deferred-digest buffer (oldest first), or []. Read-only."""
        uid = normalize_user_id(user_id)
        try:
            doc = await self._kv.get(INBOX_NS, INBOX_KEY)
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.warning("Loading pending inbox failed (%s); using empty set", exc)
            return []
        return list(self._decode_pending(doc).get(uid, []))

    async def flush_pending_digest(
        self, user_id: str | None, *, build_summary: Callable[[list[InAppNotification]], InAppNotification] | None = None
    ) -> InAppNotification | None:
        """Collapse a user's deferred buffer into the live inbox (called when the
        quiet window ends / a digest cadence fires). With ``build_summary`` the held
        items are folded into ONE digest item; without it each held item is delivered
        individually. Clears the buffer. Returns the delivered digest item (or None
        when nothing was pending)."""
        uid = normalize_user_id(user_id)

        def _change(inboxes: dict[str, list[InAppNotification]],
                    pending: dict[str, list[InAppNotification]]) -> InAppNotification | None:
            held = list(pending.get(uid, []))
            if not held:
                return None
            pending.pop(uid, None)
            notes = list(inboxes.get(uid, []))
            delivered: InAppNotification | None = None
            if build_summary is not None:
                try:
                    delivered = build_summary(held)
                except Exception:  # noqa: BLE001 — degrade to per-item delivery
                    delivered = None
            if delivered is not None:
                notes.append(delivered)
            else:
                notes.extend(held)
                delivered = held[-1]
            inboxes[uid] = _trim_preserving_active(notes)
            return delivered

        return await self._mutate_pending(_change)
