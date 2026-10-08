"""Per-user chat REPORTS (chat revamp SPEC §9.1): strict-CAS KV documents.

Storage shape (same zero-migration KV pattern as every other store, no new index or
table):

* ONE document per report, ``(REPORTS_NS, "<user-hash>:<report-id>")`` — with the
  Elasticsearch backend that is the config-index doc ``reports:<user-hash>:<report-id>``
  the spec names. Items and the summary are stored as OPAQUE canonical-JSON strings
  (``items_json`` / ``summary_json``) so the ES KV index never sees block field names
  or types (log- and model-derived content must not grow the mapping, SPEC §7.5).
  A document is at most ``MAX_REPORT_DOC_BYTES`` (512 kB) serialised.
* ONE small index document per user, ``(REPORTS_NS, "<user-hash>:index")``, listing
  ids, titles, template, conversation id, item count and timestamps (at most
  ``MAX_REPORTS_PER_USER``). Listing reports never loads any report's items.

The user hash is the chat-history partition hash (``partition_key_for_user``), so a raw
username never appears in a key and one principal can never address another's report.

Durability contract (like Workspace chat history, unlike the best-effort auxiliary
stores): every write is a strict compare-and-set on the document's ``_rev`` followed by
a confirming read, and a storage failure raises :class:`ReportStoreUnavailable` instead
of pretending to succeed. ``Report.version`` is the CONTENT version the client sends
back as ``expected_version``; ``_rev`` is the storage revision. Writing a summary moves
``_rev`` but never ``version``, so a summary is stale exactly when the report content
changed after it was generated (``ReportSummary.based_on_version < Report.version``).

Delete is a strict TOMBSTONE put followed by index removal (the KV contract has no
delete). A tombstone holds no content. A delete interrupted between the two steps is
completed by the next delete of the same id. Reports are never evicted: at the cap a
new report is refused (:class:`ReportLimitReached`).

Report content is presentation data only; nothing here feeds ``case_manager.decide()``
(#3), and the store never calls a model.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Iterable, TypeVar

from ..constants import (
    MAX_REPORT_DOC_BYTES,
    MAX_REPORT_ITEMS,
    MAX_REPORTS_PER_USER,
    REPORT_ID_PREFIX,
    REPORT_ITEM_ID_PREFIX,
    REPORTS_INDEX_KEY,
    REPORTS_NS,
)
from ..models import Report, ReportItem, ReportListEntry, ReportSummary
from ..utils import iso_now, new_id
from .base import KVStore
from .chat_conversations import normalize_user_id, partition_key_for_user

logger = logging.getLogger("tlsoc.stores.reports")

_T = TypeVar("_T")

CAS_RETRIES = 8
_SCHEMA_VERSION = 1
_UNSET: Any = object()


# --------------------------------------------------------------------------- #
# Errors (the route maps each one to one HTTP status + detail code).
# --------------------------------------------------------------------------- #
class ReportStoreUnavailable(RuntimeError):
    """The KV backend could not prove that a read or write succeeded."""


class ReportNotFound(LookupError):
    """No live report with that id for this owner (absence and foreign ownership are
    indistinguishable on purpose)."""


class ReportVersionConflict(RuntimeError):
    """``expected_version`` no longer matches the stored content version."""

    def __init__(self, current_version: int) -> None:
        super().__init__("This report changed elsewhere.")
        self.current_version = current_version


class ReportLimitReached(RuntimeError):
    """The owner already has ``MAX_REPORTS_PER_USER`` reports (never evicted)."""


class ReportFull(RuntimeError):
    """An item cannot be added: 40 items (``reason="items"``) or the 512 kB document
    bound (``reason="size"``)."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"Report is full ({MAX_REPORT_ITEMS} items)." if reason == "items"
            else "Report is full (storage size limit)."
        )
        self.reason = reason


class ReportConversationDraftExists(RuntimeError):
    """A conversation already has its draft report (at most one per conversation)."""

    def __init__(self, report_id: str) -> None:
        super().__init__("This conversation already has a report.")
        self.report_id = report_id


class ReportItemUnknown(ValueError):
    """A patch names item ids the report does not hold."""

    def __init__(self, ids: Iterable[str]) -> None:
        self.ids = sorted(set(ids))
        super().__init__("Unknown report item.")


class ReportOrderInvalid(ValueError):
    """``item_order`` is not a permutation of the remaining item ids."""


# --------------------------------------------------------------------------- #
# Results.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ReportRecord:
    """A live report plus the storage-only metadata the summary route needs."""

    report: Report
    # The idempotency key of the request that produced the current summary.
    summary_key: str | None = None


@dataclass(frozen=True)
class ReportAddOutcome:
    """What :meth:`ReportStore.add_item` did. ``added`` is False when the same source
    (conversation, message, block) was already in the report: adding is idempotent and
    returns the existing item instead of a duplicate."""

    report: Report
    item_id: str
    added: bool
    created_report: bool = False


@dataclass(frozen=True)
class ReportPatch:
    """The mutable fields of ``PATCH /api/reports/{id}`` (``None`` = unchanged)."""

    title: str | None = None
    template: str | None = None
    item_order: list[str] | None = None
    notes: dict[str, str | None] | None = None
    remove_items: list[str] | None = None


# --------------------------------------------------------------------------- #
# Codec helpers.
# --------------------------------------------------------------------------- #
def report_key(owner: str | None, report_id: str) -> str:
    """The KV key of one report: ``<user-hash>:<report-id>``."""
    return f"{partition_key_for_user(owner)}:{report_id}"


def index_key(owner: str | None) -> str:
    """The KV key of the owner's report index: ``<user-hash>:index``."""
    return f"{partition_key_for_user(owner)}:{REPORTS_INDEX_KEY}"


def new_report_id() -> str:
    return new_id(REPORT_ID_PREFIX)


def new_item_id() -> str:
    return new_id(REPORT_ITEM_ID_PREFIX)


def _canonical(value: Any) -> str:
    """Canonical JSON (sorted keys, compact) — the opaque storage form."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _doc_bytes(doc: dict[str, Any]) -> int:
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _rev(doc: dict[str, Any] | None) -> int:
    try:
        return max(0, int((doc or {}).get("_rev", 0)))
    except (TypeError, ValueError):
        return 0


def _is_tombstone(doc: dict[str, Any] | None) -> bool:
    return isinstance(doc, dict) and doc.get("deleted") is True


def _is_live(doc: dict[str, Any] | None) -> bool:
    """A live report document (absent, cleared ``{}`` and tombstones are not)."""
    return isinstance(doc, dict) and not _is_tombstone(doc) and isinstance(doc.get("id"), str)


def encode_report(report: Report, *, summary_key: str | None = None) -> dict[str, Any]:
    """The KV document for ``report`` (without ``_rev``; the CAS writer adds it).
    Scalars stay fields; items and summary become opaque canonical-JSON strings."""
    items = [item.model_dump(mode="json") for item in report.items]
    summary = report.summary.model_dump(mode="json") if report.summary is not None else None
    return {
        "schema": _SCHEMA_VERSION,
        "id": report.id,
        "owner": report.owner,
        "title": report.title,
        "template": report.template,
        "conversation_id": report.conversation_id,
        "created_at": report.created_at,
        "updated_at": report.updated_at,
        "version": report.version,
        "items_json": _canonical(items),
        "summary_json": _canonical(summary) if summary is not None else None,
        "summary_key": summary_key,
    }


def _load_json(raw: Any, fallback: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return fallback


def decode_report(doc: dict[str, Any] | None) -> ReportRecord | None:
    """A stored document back to a :class:`Report`, leniently (an invalid item is
    dropped by the model, never fatal). ``None`` for absent docs and tombstones."""
    if not _is_live(doc):
        return None
    assert doc is not None
    payload = {
        "id": doc.get("id"),
        "owner": doc.get("owner") if isinstance(doc.get("owner"), str) else "",
        "title": doc.get("title"),
        "template": doc.get("template"),
        "conversation_id": doc.get("conversation_id") if isinstance(doc.get("conversation_id"), str) else None,
        "items": _load_json(doc.get("items_json"), []),
        "summary": _load_json(doc.get("summary_json"), None),
        "version": doc.get("version") if isinstance(doc.get("version"), int) and doc.get("version") >= 0 else 1,
    }
    for name in ("created_at", "updated_at"):
        if isinstance(doc.get(name), str) and doc.get(name):
            payload[name] = doc[name]
    try:
        report = Report.model_validate(payload)
    except Exception:  # noqa: BLE001 -- a corrupt id/owner row is unreadable, not fatal
        logger.warning("report document %s could not be decoded", str(doc.get("id"))[:80])
        return None
    key = doc.get("summary_key")
    return ReportRecord(report=report, summary_key=key if isinstance(key, str) and key else None)


def index_entry(report: Report) -> dict[str, Any]:
    """The index row of ``report`` (fixed keys only; the title is plain text)."""
    return {
        "id": report.id,
        "title": report.title,
        "template": report.template,
        "conversation_id": report.conversation_id,
        "item_count": len(report.items),
        "created_at": report.created_at,
        "updated_at": report.updated_at,
        "version": report.version,
        "has_summary": report.summary is not None,
    }


def _index_rows(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    rows = (doc or {}).get("reports")
    if not isinstance(rows, list):
        return []
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"] not in seen:
            seen.add(row["id"])
            out.append(copy.deepcopy(row))
    return out


def _encode_index(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"schema": _SCHEMA_VERSION, "reports": rows}


def _source_identity(item: ReportItem) -> tuple[str, str, str | None]:
    return (item.source.conversation_id, item.source.message_id, item.source.block_id)


# --------------------------------------------------------------------------- #
# The store.
# --------------------------------------------------------------------------- #
class ReportStore:
    """Strict CRUD over per-user report documents (constructed as ``ReportStore(kv)``
    by ``AppState`` and by the Demo stack over its throwaway KV)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # One lock per owner partition: serialises every report + index mutation of
        # that owner in this process, so in-process CAS retries never fight. Across
        # processes the ``_rev`` compare-and-set is the arbiter.
        self._locks: dict[str, asyncio.Lock] = {}

    # ----- strict KV primitives ------------------------------------------- #
    def _lock_for(self, owner: str | None) -> asyncio.Lock:
        key = partition_key_for_user(owner)
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def _strict_get(self, key: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None)
        try:
            value = (
                await getter(REPORTS_NS, key) if callable(getter)
                else await self._kv.get(REPORTS_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise ReportStoreUnavailable("Reports could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise ReportStoreUnavailable("Reports storage returned an invalid document.")
        return copy.deepcopy(value)

    async def _strict_put_if(self, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        try:
            return bool(
                await writer(REPORTS_NS, key, value, expected_rev) if callable(writer)
                else await self._kv.put_if(REPORTS_NS, key, value, expected_rev)
            )
        except Exception as exc:  # noqa: BLE001
            raise ReportStoreUnavailable("Reports could not be saved.") from exc

    async def _strict_mutate(
        self,
        key: str,
        change: Callable[[dict[str, Any] | None], tuple[dict[str, Any] | None, _T]],
    ) -> _T:
        """Read → ``change`` → compare-and-set → confirming read, retried on a lost
        race. ``change`` may raise a domain error (nothing is written) or return
        ``(None, result)`` for a no-op. The caller holds the owner lock."""
        for _attempt in range(CAS_RETRIES):
            current = await self._strict_get(key)
            expected = _rev(current)
            proposed, result = change(copy.deepcopy(current))
            if proposed is None:
                return result
            saved = copy.deepcopy(proposed)
            saved["_rev"] = expected + 1
            if not await self._strict_put_if(key, saved, expected):
                continue
            confirmed = await self._strict_get(key)
            if _rev(confirmed) < expected + 1:
                raise ReportStoreUnavailable("Reports storage did not confirm the write.")
            return result
        raise ReportStoreUnavailable("The report changed too quickly; retry the request.")

    # ----- reads ------------------------------------------------------------ #
    async def list(self, owner: str | None) -> list[ReportListEntry]:
        """The owner's reports, newest first (index rows only; no items loaded)."""
        doc = await self._strict_get(index_key(owner))
        out: list[ReportListEntry] = []
        for row in _index_rows(doc):
            try:
                out.append(ReportListEntry.model_validate(row))
            except Exception:  # noqa: BLE001 -- one bad row must not hide the others
                continue
        out.sort(key=lambda e: (e.updated_at or "", e.id), reverse=True)
        return out

    async def count(self, owner: str | None) -> int:
        return len(_index_rows(await self._strict_get(index_key(owner))))

    async def get_record(self, owner: str | None, report_id: str) -> ReportRecord | None:
        record = decode_report(await self._strict_get(report_key(owner, report_id)))
        if record is None or record.report.owner != normalize_user_id(owner):
            return None
        return record

    async def get(self, owner: str | None, report_id: str) -> Report | None:
        record = await self.get_record(owner, report_id)
        return record.report if record is not None else None

    async def draft_for_conversation(self, owner: str | None, conversation_id: str) -> str | None:
        """The id of the conversation's draft report, if it has one."""
        for row in _index_rows(await self._strict_get(index_key(owner))):
            if row.get("conversation_id") == conversation_id:
                return str(row["id"])
        return None

    async def drafts_by_conversation(self, owner: str | None) -> dict[str, str]:
        """``{conversation_id: report_id}`` for the owner's drafts — ONE index read, so
        the conversation list can show ``report_id`` without a write per conversation."""
        out: dict[str, str] = {}
        for row in _index_rows(await self._strict_get(index_key(owner))):
            cid = row.get("conversation_id")
            if isinstance(cid, str) and cid and cid not in out:
                out[cid] = str(row["id"])
        return out

    # ----- index maintenance ------------------------------------------------ #
    async def _index_add_locked(self, owner: str | None, report: Report) -> None:
        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            rows = [r for r in _index_rows(current) if r["id"] != report.id]
            if len(rows) >= MAX_REPORTS_PER_USER:
                raise ReportLimitReached("Delete a report in Reports to start another.")
            if report.conversation_id:
                for row in rows:
                    if row.get("conversation_id") == report.conversation_id:
                        raise ReportConversationDraftExists(str(row["id"]))
            rows.append(index_entry(report))
            return _encode_index(rows), None

        await self._strict_mutate(index_key(owner), _change)

    async def _index_sync_locked(self, owner: str | None, report: Report) -> None:
        """Refresh the report's index row after a content/summary change. The report
        document is the truth and is already confirmed, so a failure here is logged
        rather than reported as a failed mutation; the next change re-syncs the row
        (and re-adds it when it was lost)."""
        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, None]:
            rows = _index_rows(current)
            entry = index_entry(report)
            for i, row in enumerate(rows):
                if row["id"] == report.id:
                    if row == entry:
                        return None, None
                    rows[i] = entry
                    break
            else:
                rows.append(entry)
            return _encode_index(rows), None

        try:
            await self._strict_mutate(index_key(owner), _change)
        except ReportStoreUnavailable as exc:
            logger.warning("report index sync failed for %s (%s)", report.id, exc)

    async def _index_remove_locked(self, owner: str | None, report_id: str) -> bool:
        def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
            rows = _index_rows(current)
            kept = [r for r in rows if r["id"] != report_id]
            if len(kept) == len(rows):
                return None, False
            return _encode_index(kept), True

        return await self._strict_mutate(index_key(owner), _change)

    # ----- create ------------------------------------------------------------ #
    async def _create_locked(
        self, owner: str | None, *, title: str, template: str, conversation_id: str | None,
    ) -> Report:
        uid = normalize_user_id(owner)
        index = await self._strict_get(index_key(owner))
        rows = _index_rows(index)
        if len(rows) >= MAX_REPORTS_PER_USER:
            raise ReportLimitReached("Delete a report in Reports to start another.")
        if conversation_id:
            for row in rows:
                if row.get("conversation_id") == conversation_id:
                    raise ReportConversationDraftExists(str(row["id"]))
        now = iso_now()
        report = Report(
            id=new_report_id(), owner=uid, title=title, template=template,  # type: ignore[arg-type]
            conversation_id=conversation_id, items=[], summary=None,
            created_at=now, updated_at=now, version=1,
        )

        def _write(current: dict[str, Any] | None) -> tuple[dict[str, Any], None]:
            if _is_live(current) or _is_tombstone(current):
                # A fresh random id never collides; refuse rather than overwrite.
                raise ReportStoreUnavailable("Report id collision; retry the request.")
            return encode_report(report), None

        key = report_key(owner, report.id)
        await self._strict_mutate(key, _write)
        try:
            await self._index_add_locked(owner, report)
        except BaseException:
            # The index refused (limit/draft raced in another process) or failed: do not
            # leave an invisible orphan behind.
            try:
                await self._strict_mutate(key, lambda cur: (self._tombstone(report.id, uid), None))
            except Exception:  # noqa: BLE001 -- the original error is the one to report
                logger.warning("could not tombstone orphaned report %s", report.id)
            raise
        return report

    async def create(
        self, owner: str | None, *, title: str, template: str = "custom",
        conversation_id: str | None = None,
    ) -> Report:
        """Create an empty report (refused at ``MAX_REPORTS_PER_USER``; at most one
        draft per conversation)."""
        async with self._lock_for(owner):
            return await self._create_locked(
                owner, title=title, template=template, conversation_id=conversation_id,
            )

    # ----- add -------------------------------------------------------------- #
    async def add_item(
        self,
        owner: str | None,
        item: ReportItem,
        *,
        report_id: str | None = None,
        draft_conversation_id: str | None = None,
        draft_title: str = "Untitled report",
    ) -> ReportAddOutcome:
        """Append ``item`` to ``report_id``, or — when it is None — to the draft of
        ``draft_conversation_id``, creating that draft first if it does not exist.

        Idempotent per source: an item with the same (conversation, message, block) is
        returned instead of duplicated. Raises :class:`ReportNotFound`,
        :class:`ReportFull` or :class:`ReportLimitReached` (draft creation)."""
        async with self._lock_for(owner):
            created = False
            target = report_id
            if target is None:
                if not draft_conversation_id:
                    raise ReportNotFound("No report to add to.")
                target = await self.draft_for_conversation(owner, draft_conversation_id)
                if target is None:
                    draft = await self._create_locked(
                        owner, title=draft_title, template="custom",
                        conversation_id=draft_conversation_id,
                    )
                    target, created = draft.id, True
            uid = normalize_user_id(owner)
            identity = _source_identity(item)

            def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, ReportAddOutcome]:
                record = decode_report(current)
                if record is None or record.report.owner != uid:
                    raise ReportNotFound("Report not found.")
                report = record.report
                for existing in report.items:
                    if _source_identity(existing) == identity:
                        return None, ReportAddOutcome(report, existing.id, False, created)
                if len(report.items) >= MAX_REPORT_ITEMS:
                    raise ReportFull("items")
                ids = {i.id for i in report.items}
                new_item = item if item.id not in ids else item.model_copy(update={"id": new_item_id()})
                updated = report.model_copy(update={
                    "items": [*report.items, new_item],
                    "version": report.version + 1,
                    "updated_at": iso_now(),
                })
                doc = encode_report(updated, summary_key=record.summary_key)
                if _doc_bytes(doc) + 32 > MAX_REPORT_DOC_BYTES:
                    raise ReportFull("size")
                return doc, ReportAddOutcome(updated, new_item.id, True, created)

            outcome = await self._strict_mutate(report_key(owner, target), _change)
            if outcome.added:
                await self._index_sync_locked(owner, outcome.report)
            return outcome

    # ----- update ------------------------------------------------------------ #
    async def update(
        self, owner: str | None, report_id: str, *, expected_version: int, patch: ReportPatch,
    ) -> Report:
        """Apply ``patch`` under ``expected_version``. The content version moves only
        when something actually changed (an autosave of an unchanged note is free)."""
        uid = normalize_user_id(owner)
        async with self._lock_for(owner):
            def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any] | None, Report]:
                record = decode_report(current)
                if record is None or record.report.owner != uid:
                    raise ReportNotFound("Report not found.")
                report = record.report
                if report.version != expected_version:
                    raise ReportVersionConflict(report.version)
                items = list(report.items)
                known = {i.id for i in items}
                if patch.remove_items:
                    unknown = [i for i in patch.remove_items if i not in known]
                    if unknown:
                        raise ReportItemUnknown(unknown)
                    drop = set(patch.remove_items)
                    items = [i for i in items if i.id not in drop]
                remaining = {i.id for i in items}
                if patch.notes:
                    unknown = [i for i in patch.notes if i not in remaining]
                    if unknown:
                        raise ReportItemUnknown(unknown)
                    items = [
                        i.model_copy(update={"note": patch.notes[i.id]}) if i.id in patch.notes else i
                        for i in items
                    ]
                if patch.item_order is not None:
                    if sorted(patch.item_order) != sorted(remaining):
                        raise ReportOrderInvalid("item_order must list every remaining item once.")
                    by_id = {i.id: i for i in items}
                    items = [by_id[i] for i in patch.item_order]
                updates: dict[str, Any] = {"items": items}
                if patch.title is not None:
                    updates["title"] = patch.title
                if patch.template is not None:
                    updates["template"] = patch.template
                candidate = report.model_copy(update=updates)
                if candidate.model_dump(mode="json") == report.model_dump(mode="json"):
                    return None, report
                updated = candidate.model_copy(update={
                    "version": report.version + 1, "updated_at": iso_now(),
                })
                return encode_report(updated, summary_key=record.summary_key), updated

            report = await self._strict_mutate(report_key(owner, report_id), _change)
            await self._index_sync_locked(owner, report)
            return report

    # ----- summary ------------------------------------------------------------ #
    async def set_summary(
        self, owner: str | None, report_id: str, summary: ReportSummary, *,
        idempotency_key: str | None = None,
    ) -> Report:
        """Store ``summary`` (its ``based_on_version`` is the version that was
        summarised). The content ``version`` does not move, so editing the report
        afterwards is what makes the summary stale."""
        uid = normalize_user_id(owner)
        async with self._lock_for(owner):
            def _change(current: dict[str, Any] | None) -> tuple[dict[str, Any], Report]:
                record = decode_report(current)
                if record is None or record.report.owner != uid:
                    raise ReportNotFound("Report not found.")
                updated = record.report.model_copy(update={"summary": summary})
                return encode_report(updated, summary_key=idempotency_key), updated

            report = await self._strict_mutate(report_key(owner, report_id), _change)
            await self._index_sync_locked(owner, report)
            return report

    # ----- delete ------------------------------------------------------------- #
    @staticmethod
    def _tombstone(report_id: str, owner: str) -> dict[str, Any]:
        return {
            "schema": _SCHEMA_VERSION, "id": report_id, "owner": owner,
            "deleted": True, "deleted_at": iso_now(),
        }

    async def delete(self, owner: str | None, report_id: str, *, expected_version: int) -> Report | None:
        """Strict tombstone, then index removal. Returns the deleted report, or
        ``None`` when this call only completed an earlier interrupted delete (the
        document was already a tombstone but the index still listed it)."""
        uid = normalize_user_id(owner)
        key = report_key(owner, report_id)
        async with self._lock_for(owner):
            current = await self._strict_get(key)
            if _is_tombstone(current) and current.get("owner") == uid:
                if await self._index_remove_locked(owner, report_id):
                    return None
                raise ReportNotFound("Report not found.")

            def _change(doc: dict[str, Any] | None) -> tuple[dict[str, Any], Report]:
                record = decode_report(doc)
                if record is None or record.report.owner != uid:
                    raise ReportNotFound("Report not found.")
                if record.report.version != expected_version:
                    raise ReportVersionConflict(record.report.version)
                return self._tombstone(report_id, uid), record.report

            deleted = await self._strict_mutate(key, _change)
            await self._index_remove_locked(owner, report_id)
            return deleted


__all__ = [
    "ReportAddOutcome",
    "ReportConversationDraftExists",
    "ReportFull",
    "ReportItemUnknown",
    "ReportLimitReached",
    "ReportNotFound",
    "ReportOrderInvalid",
    "ReportPatch",
    "ReportRecord",
    "ReportStore",
    "ReportStoreUnavailable",
    "ReportVersionConflict",
    "decode_report",
    "encode_report",
    "index_entry",
    "index_key",
    "new_item_id",
    "new_report_id",
    "report_key",
]
