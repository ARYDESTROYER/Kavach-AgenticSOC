"""Screenshots on a case (Round 15 SPEC D5.1 to D5.3, D5.9): the KV store.

Storage shape (KV only: no new index, table or migration, #12). Namespace
``case_files`` (:data:`app.constants.CASE_FILES_NS`):

* ``case:<case_id>`` (keyed on the SHA-256 of the id when the key would pass 128
  characters, as ``stores.runbook_runs`` does): the per-case **index**, strict
  compare-and-set on ``_rev``. Its entries are one opaque canonical-JSON string
  (``case_file_index_json``): at most :attr:`CaseFileLimits.max_files_per_case` live
  entries and :data:`MAX_TOMBSTONES` deleted ones, whose metadata is kept (the bytes are
  not).
* ``blob:<file_id>`` and ``thumb:<file_id>``: **write-once content**, the stripped image
  (or its thumbnail) as base64 in ``case_file_data``. Created with ``_rev: 1`` through
  ``put_if_strict(..., expected_rev=0)``, so a second create of the same key fails
  instead of replacing it; removed with ``delete_strict`` (SPEC D5.2).
* ``usage``: the organisation's totals (bytes and count), strict compare-and-set, so the
  storage bound (:attr:`CaseFileLimits.max_total_bytes`) holds across cases.

Every document carries ``case_file_store: "case_files"`` so a cases-tier reset can find
each one on Elasticsearch (``engine.reset``), and every top-level field is
``case_file_``-prefixed: at most six of them (``_rev`` included), so the shared
Elasticsearch config mapping never grows with content. No top-level field holds a raw
case id (``case_file_case`` is ``case:<case_id>``; the config index maps new fields
with date detection on). The content field ``case_file_data`` is mapped ``binary`` on
Elasticsearch (``es.indices``), so its base64 is stored but never indexed.

Write order of an upload (the route runs it audit-first): reserve the bytes in
``usage``, create the content documents, then append the entry to the index, which
re-checks the per-case bounds and the duplicate rule atomically. A failure after the
reservation releases it and removes the content documents it created, best-effort. A
content document that its case's index does not list is never served, and the
cases-tier reset removes it with the rest of the namespace.

A deletion removes the content documents first, then marks the index entry deleted,
then releases the bytes; a deletion that failed half-way is completed by retrying it.

Screenshots are case evidence, not personal state: deleting an account keeps them
(their ``uploaded_by`` stays). They are never on the ``Case`` document, never a
``CaseActivity`` entry and never read by a model (#7, #9), and nothing here reads or
changes a case's status, verdict or disposition (#3).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import re
import zlib
from dataclasses import dataclass
from typing import Any, Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..constants import CASE_FILES_NS, INVISIBLE_TEXT_RANGES
from ..engine.case_images import MAX_IMAGE_BYTES, MAX_THUMBNAIL_BYTES, ValidatedImage
from .base import kv_mutate_strict

logger = logging.getLogger("tlsoc.stores.case_files")

STORE_FIELD = "case_file_store"
SCHEMA_FIELD = "case_file_schema"
CASE_FIELD = "case_file_case"
INDEX_FIELD = "case_file_index_json"
META_FIELD = "case_file_meta_json"
DATA_FIELD = "case_file_data"
USAGE_FIELD = "case_file_usage_json"
REV_FIELD = "_rev"
#: Every top-level field a document of this namespace may carry (the six-field budget
#: of SPEC §3.4 is per document; content documents use six, the index five).
STORE_FIELDS: frozenset[str] = frozenset({
    STORE_FIELD, SCHEMA_FIELD, CASE_FIELD, INDEX_FIELD, META_FIELD, DATA_FIELD,
    USAGE_FIELD, REV_FIELD,
})
SCHEMA_VERSION = 1

CASE_KEY_PREFIX = "case:"
BLOB_KEY_PREFIX = "blob:"
THUMB_KEY_PREFIX = "thumb:"
USAGE_KEY = "usage"
#: The longest KV key every backend stores (the SQL ``kv.key`` column).
KV_KEY_MAX_CHARS = 128
CASE_ID_MAX_CHARS = 200

#: Live screenshots a case may hold, and their bytes (full images and thumbnails).
MAX_FILES_PER_CASE = 20
MAX_CASE_BYTES = 20 * 1024 * 1024
#: What the organisation may store in all.
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
#: Demo Mode and the in-memory store fallback keep screenshots in process memory, so
#: they are bounded far lower (SPEC D5.3).
MEMORY_MAX_FILES_PER_CASE = 5
MEMORY_MAX_TOTAL_BYTES = 64 * 1024 * 1024
#: Deleted entries kept in a case index (oldest dropped first); their bytes are gone.
MAX_TOMBSTONES = 100
CAPTION_MAX_CHARS = 200
FILENAME_MAX_CHARS = 120

_CASE_ID_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,%d}$" % CASE_ID_MAX_CHARS)
FILE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_INVISIBLE_RE = re.compile(
    "[" + "".join(f"\\U{lo:08x}-\\U{hi:08x}" for lo, hi in INVISIBLE_TEXT_RANGES) + "]"
)
_SPACES_RE = re.compile(r"\s+")

Variant = Literal["full", "thumb"]


@dataclass(frozen=True)
class CaseFileLimits:
    """The bounds one store enforces."""

    max_files_per_case: int = MAX_FILES_PER_CASE
    max_case_bytes: int = MAX_CASE_BYTES
    max_total_bytes: int = MAX_TOTAL_BYTES
    max_file_bytes: int = MAX_IMAGE_BYTES
    max_thumbnail_bytes: int = MAX_THUMBNAIL_BYTES


STANDARD_LIMITS = CaseFileLimits()
#: Demo Mode and the in-memory store fallback (SPEC D5.3, [rs] 14).
MEMORY_LIMITS = CaseFileLimits(
    max_files_per_case=MEMORY_MAX_FILES_PER_CASE, max_total_bytes=MEMORY_MAX_TOTAL_BYTES,
)


# --------------------------------------------------------------------------- #
# Errors (each names its API code and status; none quotes a filename or caption).
# --------------------------------------------------------------------------- #
class CaseFilesError(RuntimeError):
    code = "case_files_error"
    status = 500

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code


class CaseFilesUnavailable(CaseFilesError):
    code = "case_files_unavailable"
    status = 503

    def __init__(self, message: str = "Screenshots are temporarily unavailable.") -> None:
        super().__init__(message)


class CaseFilesFull(CaseFilesError):
    """A bound refused the upload: ``case_files_case_full`` (this case) or
    ``case_files_storage_full`` (the organisation)."""

    status = 409


class CaseFilesTooLarge(CaseFilesError):
    code = "case_files_too_large"
    status = 413


class CaseFileNotFound(CaseFilesError):
    code = "case_file_not_found"
    status = 404

    def __init__(self, message: str = "That screenshot was not found.") -> None:
        super().__init__(message)


class CaseFilesConflict(CaseFilesError):
    code = "case_files_conflict"
    status = 409


# --------------------------------------------------------------------------- #
# The stored entry.
# --------------------------------------------------------------------------- #
class StoredThumbnail(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    bytes: int = Field(ge=0)
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    sha256: str


class CaseFileRecord(BaseModel):
    """One index entry: what the Console lists, never the bytes."""

    model_config = ConfigDict(extra="ignore")

    id: str
    case_id: str
    type: str
    bytes: int = Field(ge=0)
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    sha256: str
    caption: str = ""
    filename: str = ""
    uploaded_by: str = ""
    uploaded_at: str = ""
    thumb: StoredThumbnail | None = None
    deleted_at: str | None = None
    deleted_by: str | None = None

    @property
    def live(self) -> bool:
        return not self.deleted_at

    @property
    def stored_bytes(self) -> int:
        return int(self.bytes) + (int(self.thumb.bytes) if self.thumb is not None else 0)


@dataclass(frozen=True)
class CaseFileIndex:
    """One case's index as read: every entry (live and deleted, upload order) and the
    document revision."""

    case_id: str
    entries: tuple[CaseFileRecord, ...]
    revision: int

    @property
    def live(self) -> tuple[CaseFileRecord, ...]:
        return tuple(e for e in self.entries if e.live)

    @property
    def deleted(self) -> tuple[CaseFileRecord, ...]:
        return tuple(e for e in self.entries if not e.live)

    @property
    def live_bytes(self) -> int:
        return sum(e.stored_bytes for e in self.live)


@dataclass(frozen=True)
class CaseFileUsage:
    bytes: int = 0
    count: int = 0


# --------------------------------------------------------------------------- #
# Plain-text rules for what a person typed.
# --------------------------------------------------------------------------- #
def clean_caption(value: Any) -> str:
    """A caption as stored: plain text on one line, invisible and control characters
    removed, spaces collapsed, at most :data:`CAPTION_MAX_CHARS` characters."""
    if not isinstance(value, str):
        return ""
    text = _INVISIBLE_RE.sub("", value.replace("\t", " ").replace("\r", " ").replace("\n", " "))
    return _SPACES_RE.sub(" ", text).strip()[:CAPTION_MAX_CHARS].strip()


def clean_filename(value: Any) -> str:
    """A filename as stored: its last path part only, plain text, at most
    :data:`FILENAME_MAX_CHARS` characters (the end kept, so the extension stays)."""
    if not isinstance(value, str):
        return ""
    base = re.split(r"[\\/]", value)[-1]
    text = _SPACES_RE.sub(" ", _INVISIBLE_RE.sub("", base.replace("\t", " "))).strip()
    if text in {".", ".."}:
        return ""
    if len(text) > FILENAME_MAX_CHARS:
        text = text[-FILENAME_MAX_CHARS:].lstrip()
    return text


# --------------------------------------------------------------------------- #
# Codec helpers.
# --------------------------------------------------------------------------- #
def valid_case_id(case_id: Any) -> bool:
    return isinstance(case_id, str) and bool(_CASE_ID_RE.fullmatch(case_id)) and case_id.strip() == case_id


def valid_file_id(file_id: Any) -> bool:
    return isinstance(file_id, str) and bool(FILE_ID_RE.fullmatch(file_id))


def case_key(case_id: str) -> str:
    """The KV key of one case's index: ``case:<case_id>``, or ``case:~<sha256>`` when
    that would pass :data:`KV_KEY_MAX_CHARS` (the document still names the case)."""
    key = f"{CASE_KEY_PREFIX}{case_id}"
    if len(key) <= KV_KEY_MAX_CHARS:
        return key
    digest = hashlib.sha256(case_id.encode("utf-8", "surrogatepass")).hexdigest()
    return f"{CASE_KEY_PREFIX}~{digest}"


def content_key(file_id: str, variant: Variant) -> str:
    return f"{THUMB_KEY_PREFIX if variant == 'thumb' else BLOB_KEY_PREFIX}{file_id}"


def stored_case_label(case_id: str) -> str:
    """The value of the top-level ``case_file_case`` field: ``case:<case_id>``."""
    return f"{CASE_KEY_PREFIX}{case_id}"


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _load_json(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _rev(doc: Any) -> int:
    if not isinstance(doc, dict):
        return 0
    try:
        return max(0, int(doc.get(REV_FIELD, 0) or 0))
    except (TypeError, ValueError):
        return 0


def encode_index(case_id: str, entries: Iterable[CaseFileRecord]) -> dict[str, Any]:
    return {
        STORE_FIELD: CASE_FILES_NS,
        SCHEMA_FIELD: SCHEMA_VERSION,
        CASE_FIELD: stored_case_label(case_id),
        INDEX_FIELD: _canonical({"files": [e.model_dump(mode="json") for e in entries]}),
    }


def decode_index(case_id: str, doc: Any) -> CaseFileIndex:
    """The entries of a stored index (empty when absent or cleared). A document that
    cannot be read raises :class:`CaseFilesUnavailable`: it is never read as "no
    screenshots", which would let a write past the case bounds replace it."""
    revision = _rev(doc)
    if not isinstance(doc, dict) or doc.get(INDEX_FIELD) in (None, ""):
        return CaseFileIndex(case_id, (), revision)
    if doc.get(CASE_FIELD) not in (None, stored_case_label(case_id)):
        raise CaseFilesUnavailable("A case's screenshot list could not be read.")
    data = _load_json(doc.get(INDEX_FIELD))
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        raise CaseFilesUnavailable("A case's screenshot list could not be read.")
    try:
        entries = tuple(CaseFileRecord.model_validate(item) for item in data["files"])
    except Exception as exc:  # noqa: BLE001 - damaged, never silently empty
        raise CaseFilesUnavailable("A case's screenshot list could not be read.") from exc
    return CaseFileIndex(case_id, entries, revision)


def encode_content(case_id: str, file_id: str, image: ValidatedImage, variant: Variant) -> dict[str, Any]:
    """A write-once content document (``_rev: 1``)."""
    return {
        STORE_FIELD: CASE_FILES_NS,
        SCHEMA_FIELD: SCHEMA_VERSION,
        CASE_FIELD: stored_case_label(case_id),
        META_FIELD: _canonical({
            "id": file_id, "variant": variant, "type": image.kind,
            "bytes": image.size, "sha256": image.sha256,
        }),
        DATA_FIELD: base64.b64encode(image.data).decode("ascii"),
        REV_FIELD: 1,
    }


def _decode_usage(doc: Any) -> CaseFileUsage:
    data = _load_json(doc.get(USAGE_FIELD)) if isinstance(doc, dict) else None
    if not isinstance(data, dict):
        return CaseFileUsage()
    try:
        return CaseFileUsage(bytes=max(0, int(data.get("bytes", 0))), count=max(0, int(data.get("count", 0))))
    except (TypeError, ValueError):
        return CaseFileUsage()


def _encode_usage(usage: CaseFileUsage) -> dict[str, Any]:
    return {
        STORE_FIELD: CASE_FILES_NS,
        SCHEMA_FIELD: SCHEMA_VERSION,
        USAGE_FIELD: _canonical({"bytes": usage.bytes, "count": usage.count}),
    }


def _prune_tombstones(entries: list[CaseFileRecord]) -> list[CaseFileRecord]:
    deleted = [e for e in entries if not e.live]
    if len(deleted) <= MAX_TOMBSTONES:
        return entries
    drop = {id(e) for e in sorted(deleted, key=lambda e: str(e.deleted_at or ""))[: len(deleted) - MAX_TOMBSTONES]}
    return [e for e in entries if id(e) not in drop]


def _size_label(n: int) -> str:
    if n >= 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024 * 1024):,.0f} GiB"
    return f"{n / (1024 * 1024):,.0f} MiB"


# --------------------------------------------------------------------------- #
# The store.
# --------------------------------------------------------------------------- #
class CaseFileStore:
    """Screenshots per case over the shared KV (see the module docstring)."""

    _LOCK_STRIPES = 64

    def __init__(self, kv: Any, *, limits: CaseFileLimits = STANDARD_LIMITS) -> None:
        self._kv = kv
        self._limits = limits
        self._locks = [asyncio.Lock() for _ in range(self._LOCK_STRIPES)]

    @property
    def kv(self) -> Any:
        return self._kv

    @property
    def limits(self) -> CaseFileLimits:
        return self._limits

    # -- backend seams ------------------------------------------------------ #
    def _lock(self, key: str) -> asyncio.Lock:
        return self._locks[zlib.crc32(key.encode("utf-8", "surrogatepass")) % self._LOCK_STRIPES]

    async def _get(self, key: str) -> dict[str, Any] | None:
        reader = getattr(self._kv, "get_strict", None) or self._kv.get
        return await reader(CASE_FILES_NS, key)

    async def _create_once(self, key: str, value: dict[str, Any]) -> None:
        put_if = getattr(self._kv, "put_if_strict", None) or getattr(self._kv, "put_if", None)
        if put_if is None:
            raise CaseFilesUnavailable()
        if not await put_if(CASE_FILES_NS, key, value, 0):
            raise CaseFilesConflict("That screenshot already exists. Try the upload again.")

    async def _delete(self, key: str) -> None:
        remove = getattr(self._kv, "delete_strict", None)
        if remove is not None:
            await remove(CASE_FILES_NS, key)
            return
        # A KV backend without a delete: overwrite with an empty tagged document.
        put = getattr(self._kv, "put_strict", None) or self._kv.put
        await put(CASE_FILES_NS, key, {STORE_FIELD: CASE_FILES_NS, SCHEMA_FIELD: SCHEMA_VERSION})

    async def _mutate(self, key: str, mutator: Any) -> dict[str, Any]:
        return await kv_mutate_strict(self._kv, CASE_FILES_NS, key, mutator, lock=self._lock(key))

    # -- reads -------------------------------------------------------------- #
    async def index(self, case_id: str) -> CaseFileIndex:
        """Every entry of one case (live and deleted). A storage failure raises
        :class:`CaseFilesUnavailable`."""
        if not valid_case_id(case_id):
            raise CaseFileNotFound("That case was not found.")
        try:
            doc = await self._get(case_key(case_id))
        except CaseFilesError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CaseFilesUnavailable() from exc
        return decode_index(case_id, doc)

    async def get_many(self, case_ids: Iterable[str], *, concurrency: int = 8) -> dict[str, CaseFileIndex]:
        """:meth:`index` for several cases (at most ``concurrency`` reads at once);
        cases without screenshots are absent. A storage failure raises."""
        ids = [c for c in dict.fromkeys(case_ids) if valid_case_id(c)]
        gate = asyncio.Semaphore(max(1, int(concurrency)))

        async def one(case_id: str) -> CaseFileIndex:
            async with gate:
                return await self.index(case_id)

        found = await asyncio.gather(*(one(c) for c in ids))
        return {i.case_id: i for i in found if i.entries}

    async def entry(self, case_id: str, file_id: str) -> CaseFileRecord:
        """One live entry, else :class:`CaseFileNotFound`."""
        if not valid_file_id(file_id):
            raise CaseFileNotFound()
        for item in (await self.index(case_id)).live:
            if item.id == file_id:
                return item
        raise CaseFileNotFound()

    async def usage(self) -> CaseFileUsage:
        try:
            return _decode_usage(await self._get(USAGE_KEY))
        except Exception as exc:  # noqa: BLE001
            raise CaseFilesUnavailable() from exc

    async def read_content(self, case_id: str, file_id: str, variant: Variant = "full") -> tuple[CaseFileRecord, bytes, str]:
        """``(entry, bytes, kind)`` of a live screenshot: its thumbnail when asked for
        one and it has one, else the full image. Only content its case's index lists
        is served, and only when the stored document names that case and its bytes
        hash to the recorded SHA-256."""
        record = await self.entry(case_id, file_id)
        use_thumb = variant == "thumb" and record.thumb is not None
        key = content_key(file_id, "thumb" if use_thumb else "full")
        want_sha = record.thumb.sha256 if use_thumb and record.thumb else record.sha256
        kind = record.thumb.type if use_thumb and record.thumb else record.type
        try:
            doc = await self._get(key)
        except Exception as exc:  # noqa: BLE001
            raise CaseFilesUnavailable() from exc
        if not isinstance(doc, dict) or doc.get(CASE_FIELD) != stored_case_label(case_id):
            raise CaseFileNotFound("That screenshot's content is missing.")
        raw = doc.get(DATA_FIELD)
        try:
            data = base64.b64decode(raw, validate=True) if isinstance(raw, str) else b""
        except (binascii.Error, ValueError):
            data = b""
        if not data or hashlib.sha256(data).hexdigest() != want_sha:
            raise CaseFileNotFound("That screenshot's content is missing.")
        return record, data, kind

    # -- writes ------------------------------------------------------------- #
    def check_room(self, index: CaseFileIndex, usage: CaseFileUsage, new_bytes: int) -> None:
        """Raise :class:`CaseFilesFull` when ``new_bytes`` more would pass a bound."""
        limits = self._limits
        if len(index.live) >= limits.max_files_per_case:
            raise CaseFilesFull(
                f"This case already has {limits.max_files_per_case:,} screenshots. Delete one to add another.",
                code="case_files_case_full",
            )
        if index.live_bytes + new_bytes > limits.max_case_bytes:
            raise CaseFilesFull(
                f"This case's screenshots would pass {_size_label(limits.max_case_bytes)}. Delete one to add another.",
                code="case_files_case_full",
            )
        if usage.bytes + new_bytes > limits.max_total_bytes:
            raise CaseFilesFull(
                f"Screenshot storage is full ({_size_label(limits.max_total_bytes)}). Delete older screenshots first.",
                code="case_files_storage_full",
            )

    async def add(
        self,
        case_id: str,
        image: ValidatedImage,
        thumb: ValidatedImage | None,
        *,
        file_id: str,
        filename: str = "",
        caption: str = "",
        uploaded_by: str = "",
        uploaded_at: str,
    ) -> CaseFileRecord:
        """Store one screenshot (see the module docstring for the write order).
        Raises :class:`CaseFilesFull`, :class:`CaseFilesConflict` (a duplicate that
        landed meanwhile, or a content key that already exists) or
        :class:`CaseFilesUnavailable`."""
        if not valid_case_id(case_id) or not valid_file_id(file_id):
            raise CaseFileNotFound("That case was not found.")
        if image.size > self._limits.max_file_bytes:
            raise CaseFilesTooLarge("The image is too large.")
        if thumb is not None and thumb.size > self._limits.max_thumbnail_bytes:
            raise CaseFilesTooLarge("The thumbnail is too large.")
        record = CaseFileRecord(
            id=file_id, case_id=case_id, type=image.kind, bytes=image.size,
            width=image.width, height=image.height, sha256=image.sha256,
            caption=clean_caption(caption), filename=clean_filename(filename),
            uploaded_by=uploaded_by or "", uploaded_at=uploaded_at,
            thumb=(StoredThumbnail(type=thumb.kind, bytes=thumb.size, width=thumb.width,
                                   height=thumb.height, sha256=thumb.sha256)
                   if thumb is not None else None),
        )
        total = record.stored_bytes
        reserved = False
        created: list[str] = []
        try:
            await self._reserve(total)
            reserved = True
            blob = content_key(file_id, "full")
            await self._create_once(blob, encode_content(case_id, file_id, image, "full"))
            created.append(blob)
            if thumb is not None:
                small = content_key(file_id, "thumb")
                await self._create_once(small, encode_content(case_id, file_id, thumb, "thumb"))
                created.append(small)
            await self._append(case_id, record)
            return record
        except BaseException as exc:
            await self._undo(created, total if reserved else 0)
            if isinstance(exc, (CaseFilesError, asyncio.CancelledError)):
                raise
            if isinstance(exc, Exception):
                raise CaseFilesUnavailable() from exc
            raise

    async def _reserve(self, total: int) -> None:
        limit = self._limits.max_total_bytes

        def change(current: dict[str, Any] | None) -> dict[str, Any]:
            usage = _decode_usage(current)
            if usage.bytes + total > limit:
                raise CaseFilesFull(
                    f"Screenshot storage is full ({_size_label(limit)}). Delete older screenshots first.",
                    code="case_files_storage_full",
                )
            return _encode_usage(CaseFileUsage(bytes=usage.bytes + total, count=usage.count + 1))

        await self._mutate(USAGE_KEY, change)

    async def _release(self, total: int) -> None:
        def change(current: dict[str, Any] | None) -> dict[str, Any]:
            usage = _decode_usage(current)
            return _encode_usage(CaseFileUsage(
                bytes=max(0, usage.bytes - total), count=max(0, usage.count - 1),
            ))

        await self._mutate(USAGE_KEY, change)

    async def _append(self, case_id: str, record: CaseFileRecord) -> None:
        limits = self._limits

        def change(current: dict[str, Any] | None) -> dict[str, Any]:
            index = decode_index(case_id, current)
            if any(e.sha256 == record.sha256 for e in index.live):
                raise CaseFilesConflict(
                    "The same screenshot was added to this case meanwhile.", code="case_files_duplicate",
                )
            if any(e.id == record.id for e in index.entries):
                raise CaseFilesConflict("That screenshot already exists. Try the upload again.")
            # The usage bound was reserved already; only the case bounds are rechecked.
            if len(index.live) >= limits.max_files_per_case:
                raise CaseFilesFull(
                    f"This case already has {limits.max_files_per_case:,} screenshots. Delete one to add another.",
                    code="case_files_case_full",
                )
            if index.live_bytes + record.stored_bytes > limits.max_case_bytes:
                raise CaseFilesFull(
                    f"This case's screenshots would pass {_size_label(limits.max_case_bytes)}. Delete one to add another.",
                    code="case_files_case_full",
                )
            return encode_index(case_id, [*index.entries, record])

        await self._mutate(case_key(case_id), change)

    async def _undo(self, created: list[str], reserved: int) -> None:
        """Best-effort compensation of a failed upload: remove the content documents
        it created and release its reservation. A failure here is only logged: an
        unlisted content document is never served, and a reservation that stays
        only makes the storage bound stricter until the next cases reset."""
        for key in created:
            try:
                await self._delete(key)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Screenshot content %s could not be removed after a failed upload: %s", key, exc)
        if reserved:
            try:
                await self._release(reserved)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Screenshot storage reservation could not be released: %s", exc)

    async def delete(self, case_id: str, file_id: str, *, deleted_by: str, deleted_at: str) -> CaseFileRecord:
        """Remove one screenshot's bytes and mark its entry deleted (the metadata stays
        as a tombstone). Raises :class:`CaseFileNotFound` when it is not live."""
        record = await self.entry(case_id, file_id)
        try:
            await self._delete(content_key(file_id, "full"))
            if record.thumb is not None:
                await self._delete(content_key(file_id, "thumb"))
        except Exception as exc:  # noqa: BLE001
            raise CaseFilesUnavailable() from exc
        transitioned: list[CaseFileRecord] = []

        def change(current: dict[str, Any] | None) -> dict[str, Any]:
            transitioned.clear()
            index = decode_index(case_id, current)
            entries: list[CaseFileRecord] = []
            for item in index.entries:
                if item.id == file_id and item.live:
                    item = item.model_copy(update={"deleted_at": deleted_at, "deleted_by": deleted_by or ""})
                    transitioned.append(item)
                entries.append(item)
            return encode_index(case_id, _prune_tombstones(entries))

        try:
            await self._mutate(case_key(case_id), change)
        except CaseFilesError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CaseFilesUnavailable() from exc
        if not transitioned:
            raise CaseFileNotFound()
        try:
            await self._release(record.stored_bytes)
        except Exception as exc:  # noqa: BLE001 - the deletion stands; the bound only tightens
            logger.warning("Screenshot storage total could not be lowered after a deletion: %s", exc)
        return transitioned[0]
