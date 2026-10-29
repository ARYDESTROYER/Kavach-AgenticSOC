"""The runbook LIBRARY store (Round 14 SPEC §4.10.5, §4.10.6): every operator runbook,
every version, and the one-shot migration marker, in the shared KV store.

Storage shape (KV only: no new index, table or migration, #12). Namespace
``runbook_library`` (:data:`app.constants.RUNBOOK_LIBRARY_NS`):

* ``index``: the bounded list of runbook summaries (:class:`RunbookIndexRow`, at most
  :data:`app.models.MAX_OPERATOR_RUNBOOKS`), one opaque canonical-JSON string under
  ``runbook_index_json``. Listing the library reads only this document.
* ``rb:<id>``: every version of one operator runbook (:class:`StoredRunbook`: the
  definitions, their Markdown sources and metadata), one opaque string under
  ``runbook_doc_json``, at most :data:`RUNBOOK_DOC_MAX_BYTES` (2 MiB) and
  :data:`app.models.MAX_RUNBOOK_VERSIONS` versions.
* ``migration``: the migration marker (:class:`RunbookMigrationMarker`, §4.10.17)
  under ``runbook_migration_json``.

On Elasticsearch every KV namespace shares the config index and one dynamic mapping,
so every top-level field is ``runbook_``-prefixed and the content is one opaque string
(the reports-store rule): runbook text never grows the shared mapping. No top-level
field holds the runbook id (the KV key and the opaque JSON carry it): the config index
maps new fields with date detection on, and an operator id such as ``2026-10-28`` fits
the id grammar, so a raw id field could be mapped as a date by the first write and
refuse every later one. Built-in runbooks are package data
(``engine.runbook_model.load_builtin_runbooks``) and are never stored here.

Durability (like reports, unlike the best-effort auxiliary stores): every write is a
strict compare-and-set on the document's ``_rev`` followed by a confirming read, and
a storage failure raises :class:`RunbookStoreUnavailable` instead of pretending to
succeed. ``RunbookDetail.revision`` is the runbook document's ``_rev``; a caller that
read revision ``n`` writes with ``expected_revision=n`` and a stale one is refused
with :class:`RunbookConflict` (``409 runbook_conflict``), never retried. A write that
does not depend on what changed (``expected_revision=None``) is retried on a lost
race, up to :data:`CAS_RETRIES` times.

The runbook document is the source of truth; the index is a projection of each
document (:func:`index_row_for`). A create writes the document, then the index (the
index decides existence and the 200-runbook bound); an update writes the document,
then refreshes its index row; a discard tombstones the document (the KV contract has
no delete), then removes the row. A projection write that fails after its document
write is retried, then logged; the next write or read of that runbook repairs the row
(:meth:`RunbookLibraryStore.get` and :meth:`published_catalog` compare each row's
``doc_rev`` with the document). A repair takes the same per-runbook lock as create,
update and discard and re-reads the document and the row under it, so a reader that
saw a document before a concurrent write never removes or rewinds the row that write
projected. A document that is not in the index (a create interrupted between its two
writes) is an orphan that the next create of that id overwrites. A row whose document
is absent (an index write that committed but reported a failure, after which the
create tombstoned its document) is a dangling row: the create rolls it back too, a
read repairs it, a create of that id treats it as absent, and
:meth:`RunbookLibraryStore.verified_rows` reads every row through its document so the
migration never counts one as converted. In-process asyncio locks serialise
writers; the application is not multi-replica safe (AGENTS.md), and across processes
``_rev`` is the arbiter.

Demo Mode (SPEC §3.5): the library is the REAL store, read by the Demo pipeline, and
read-only while Demo Mode is on: every write raises :class:`RunbookDemoReadOnly`
(``409 runbook_demo_readonly``). The one-shot migration writes with ``system=True``.

Transitions (draft, in review, published, superseded, retired), governance and
validation are the catalog's (``engine.runbook_catalog``); this module stores what it
is given and enforces only the storage invariants (:func:`check_stored_runbook`).
Nothing here feeds ``case_manager.decide()`` (#3) or calls a model (#6).
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import uuid
import weakref
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..constants import (
    RUNBOOK_LIBRARY_DOC_KEY_PREFIX,
    RUNBOOK_LIBRARY_INDEX_KEY,
    RUNBOOK_LIBRARY_MIGRATION_KEY,
    RUNBOOK_LIBRARY_NS,
)
from ..models import (
    MAX_OPERATOR_RUNBOOKS,
    MAX_RUNBOOK_VERSIONS,
    RUNBOOK_OPERATOR_ID_PATTERN,
    RUNBOOK_RESERVED_IDS,
    RunbookAppliesTo,
    RunbookMigratedFrom,
    RunbookMigrationNotice,
    RunbookRef,
    RunbookVersionDoc,
)
from ..engine.runbook_model import applies_to
from ..utils import iso_now

logger = logging.getLogger("tlsoc.stores.runbook_library")

#: The bound of one runbook document (every version, definitions and sources).
RUNBOOK_DOC_MAX_BYTES = 2 * 1024 * 1024
#: How often a write that does not depend on what changed is retried on a lost race.
CAS_RETRIES = 3
_SCHEMA_VERSION = 1

# Fixed, ``runbook_``-prefixed field names (the only names that reach the shared
# Elasticsearch mapping).
SCHEMA_FIELD = "runbook_schema"
STORE_FIELD = "runbook_store"
DELETED_FIELD = "runbook_deleted"
INDEX_FIELD = "runbook_index_json"
DOC_FIELD = "runbook_doc_json"
MIGRATION_FIELD = "runbook_migration_json"
#: A random token written when the index document is first created (and kept by
#: every later write): a factory reset that removes the index gives the next one a
#: new token, so an in-process cache can never mistake the new library for the old.
EPOCH_FIELD = "runbook_index_epoch"
REV_FIELD = "_rev"

_OPERATOR_ID_RE = re.compile(RUNBOOK_OPERATOR_ID_PATTERN)

StoredOrigin = Literal["operator", "imported"]


# --------------------------------------------------------------------------- #
# Errors (the routes map each to one status and code, SPEC §4.10.15).
# --------------------------------------------------------------------------- #
class RunbookStoreError(RuntimeError):
    """Base class of the library store's refusals."""


class RunbookStoreUnavailable(RunbookStoreError):
    """The KV backend could not prove a read or write (``503 runbook_store_unavailable``)."""


class RunbookNotFound(LookupError):
    """No live operator runbook with that id (``404 runbook_not_found``)."""


class RunbookExists(RunbookStoreError):
    """A create named an id the library already holds."""

    def __init__(self, runbook_id: str) -> None:
        super().__init__(f"A runbook with the id '{runbook_id}' already exists.")
        self.runbook_id = runbook_id


class RunbookConflict(RunbookStoreError):
    """``expected_revision`` no longer matches (``409 runbook_conflict``); carries the
    current revision so the caller can return the latest."""

    def __init__(self, runbook_id: str, current_revision: int) -> None:
        super().__init__("This runbook changed elsewhere. Reload it and try again.")
        self.runbook_id = runbook_id
        self.current_revision = current_revision


class RunbookLimitReached(RunbookStoreError):
    """A bound of SPEC §4.10.5 (``409 runbook_limit``): ``kind`` is ``"runbooks"``
    (200 operator runbooks), ``"versions"`` (100 per runbook) or ``"size"`` (2 MiB)."""

    _MESSAGES = {
        "runbooks": f"The library already holds {MAX_OPERATOR_RUNBOOKS} runbooks, the limit.",
        "versions": f"This runbook already has {MAX_RUNBOOK_VERSIONS} versions, the limit.",
        "size": "This runbook's history has reached the 2 MiB storage limit.",
    }

    def __init__(self, kind: str) -> None:
        super().__init__(self._MESSAGES.get(kind, "A runbook storage limit was reached."))
        self.kind = kind


class RunbookDemoReadOnly(RunbookStoreError):
    """A write while Demo Mode is on (``409 runbook_demo_readonly``)."""

    def __init__(self) -> None:
        super().__init__("Runbooks cannot be edited in Demo Mode.")


class RunbookDocumentInvalid(ValueError):
    """A document that breaks a storage invariant (a caller bug, never stored)."""


class RunbookDocumentDamaged(RunbookStoreUnavailable):
    """A stored runbook document that cannot be decoded. A
    :class:`RunbookStoreUnavailable` (``503``) for every route, so a damaged document
    is never read as absent; a separate type only so a reader that must tell a damaged
    document (it exists) from a storage outage can
    (:meth:`RunbookLibraryStore.verified_rows`)."""


# --------------------------------------------------------------------------- #
# Stored models.
# --------------------------------------------------------------------------- #
class StoredRunbook(BaseModel):
    """One operator runbook with every version (the ``rb:<id>`` document).

    ``versions`` are immutable once written apart from their state metadata
    (§4.10.5), ascending by ``version``. ``origin`` is ``imported`` for a migrated or
    imported runbook (the "Imported" badge). ``replaces`` names the built-in a
    "Duplicate to customise" copy replaces once Published; ``derived_from`` the
    version it was copied from. ``review_due_at`` is ``last_reviewed_at +
    review_every_days`` (imported content is due at once, D38). Unknown fields from a
    newer compatible writer are kept verbatim."""

    model_config = ConfigDict(extra="allow")

    id: str
    origin: StoredOrigin = "operator"
    versions: list[RunbookVersionDoc] = Field(default_factory=list)
    replaces: str | None = None
    derived_from: RunbookRef | None = None
    review_due_at: str | None = None
    last_reviewed_at: str | None = None
    last_reviewed_by: str | None = None
    migrated_from: RunbookMigratedFrom | None = None
    created_at: str = ""
    created_by: str = ""
    updated_at: str = ""
    updated_by: str = ""

    def version(self, number: int) -> RunbookVersionDoc | None:
        """The version numbered ``number``, or ``None``."""
        for item in self.versions:
            if item.version == number:
                return item
        return None

    def latest_in(self, state: str) -> RunbookVersionDoc | None:
        """The newest version in ``state`` (``draft``, ``in_review``, ``published``,
        ``superseded`` or ``retired``), or ``None``."""
        found = [v for v in self.versions if v.state == state]
        return max(found, key=lambda v: v.version) if found else None

    @property
    def live(self) -> RunbookVersionDoc | None:
        """The Published version (the one that matches and guides), if any."""
        return self.latest_in("published")

    @property
    def draft(self) -> RunbookVersionDoc | None:
        return self.latest_in("draft")

    @property
    def in_review(self) -> RunbookVersionDoc | None:
        return self.latest_in("in_review")

    @property
    def retired_version(self) -> RunbookVersionDoc | None:
        """The last live version, retired (restore republishes it)."""
        return self.latest_in("retired")

    @property
    def retired(self) -> bool:
        return self.live is None and self.retired_version is not None

    def next_version_number(self) -> int:
        return max((v.version for v in self.versions), default=0) + 1

    def display_version(self) -> RunbookVersionDoc | None:
        """The version a library row describes: the live one, else the last live
        (retired) one, else the one in review, else the draft, else the newest."""
        return (
            self.live or self.retired_version or self.in_review or self.draft
            or (max(self.versions, key=lambda v: v.version) if self.versions else None)
        )


class RunbookIndexRow(BaseModel):
    """One row of the library index (a projection of one :class:`StoredRunbook`).

    The listing fields of ``RunbookSummary`` the store can know (``runs_30d``,
    ``replaced_by`` and the visible ``state`` are the catalog's), plus ``doc_rev``:
    the runbook document's revision this row was projected from, so a reader can tell
    a stale row and repair it."""

    model_config = ConfigDict(extra="allow")

    id: str
    title: str = ""
    summary: str = ""
    origin: StoredOrigin = "operator"
    live_version: int | None = None
    draft_version: int | None = None
    in_review_version: int | None = None
    retired: bool = False
    retired_version: int | None = None
    replaces: str | None = None
    derived_from: RunbookRef | None = None
    owner: str | None = None
    phases: list[str] = Field(default_factory=list)
    step_count: int = 0
    applies_to: RunbookAppliesTo = Field(default_factory=RunbookAppliesTo)
    published_at: str | None = None
    review_due_at: str | None = None
    last_reviewed_at: str | None = None
    last_reviewed_by: str | None = None
    updated_at: str | None = None
    updated_by: str | None = None
    migrated_from: RunbookMigratedFrom | None = None
    doc_rev: int = 0


class RunbookMigrationCounts(BaseModel):
    published: int = 0
    draft: int = 0
    skipped: int = 0


class RunbookMigrationMarker(BaseModel):
    """The one-shot migration marker (SPEC §4.10.17 step 6).

    ``id_map`` maps ``<legacy namespace>:<legacy id>`` to the new runbook id (what an
    automation rule naming a legacy id resolves against at fire time, §4.10.16).
    ``projection_generation`` tags every RAG chunk of the reprojection (step 7);
    ``projection_completed_at`` is set once that projection finished. Until it is,
    the retriever excludes untagged legacy runbook chunks."""

    model_config = ConfigDict(extra="allow")

    version: int = 1
    completed_at: str | None = None
    counts: RunbookMigrationCounts = Field(default_factory=RunbookMigrationCounts)
    sources: list[dict[str, Any]] = Field(default_factory=list)
    id_map: dict[str, str] = Field(default_factory=dict)
    projection_generation: str = ""
    projection_completed_at: str | None = None


@dataclass(frozen=True)
class StoredRunbookRecord:
    """A live runbook document and its CAS revision (``RunbookDetail.revision``)."""

    runbook: StoredRunbook
    revision: int


@dataclass(frozen=True)
class LibraryIndex:
    """Every index row (by id) and the index document's revision."""

    rows: tuple[RunbookIndexRow, ...]
    revision: int
    epoch: str = ""

    def row(self, runbook_id: str) -> RunbookIndexRow | None:
        for row in self.rows:
            if row.id == runbook_id:
                return row
        return None


@dataclass(frozen=True)
class PublishedRunbook:
    """One matchable operator runbook: its document and its live version."""

    runbook: StoredRunbook
    live: RunbookVersionDoc
    revision: int


@dataclass(frozen=True)
class MarkerRecord:
    """The migration marker and its CAS revision."""

    marker: RunbookMigrationMarker
    revision: int


def migrated_map(rows: Any) -> dict[tuple[str, str], str]:
    """``(legacy namespace, legacy id) -> runbook id`` for each index row that carries
    ``migrated_from`` (pure; pass :meth:`RunbookLibraryStore.verified_rows`)."""
    out: dict[tuple[str, str], str] = {}
    for row in rows:
        origin = row.migrated_from
        if origin is not None:
            out[(origin.namespace, origin.id)] = row.id
    return out


# --------------------------------------------------------------------------- #
# Codec and invariants.
# --------------------------------------------------------------------------- #
def doc_key(runbook_id: str) -> str:
    """The KV key of one runbook document: ``rb:<id>``."""
    return f"{RUNBOOK_LIBRARY_DOC_KEY_PREFIX}{runbook_id}"


def _canonical(value: Any) -> str:
    """Canonical JSON (sorted keys, compact): the opaque storage form."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _doc_bytes(doc: dict[str, Any]) -> int:
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "surrogatepass"))


def _rev(doc: Any) -> int:
    if not isinstance(doc, dict):
        return 0
    try:
        return max(0, int(doc.get(REV_FIELD, 0) or 0))
    except (TypeError, ValueError):
        return 0


def _load_json(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def valid_stored_id(runbook_id: Any) -> bool:
    """An operator runbook id the store accepts: the operator grammar (the legacy
    procedure grammar, so ``brute_force_login`` stays valid) and never reserved."""
    return (
        isinstance(runbook_id, str)
        and runbook_id not in RUNBOOK_RESERVED_IDS
        and bool(_OPERATOR_ID_RE.fullmatch(runbook_id))
    )


def check_stored_runbook(doc: StoredRunbook) -> None:
    """Raise :class:`RunbookDocumentInvalid` when ``doc`` breaks a storage invariant:

    * the id fits the operator grammar and is not reserved (a built-in id is the
      catalog's to refuse: ``validate_runbook`` reports it);
    * 1 to :data:`MAX_RUNBOOK_VERSIONS` versions (more is :class:`RunbookLimitReached`),
      unique numbers, ascending, each definition carrying the runbook's id;
    * at most one draft, one version in review and one Published version, and never a
      Published and a retired version at once (one live version at a time, §4.10.5).
    """
    if not valid_stored_id(doc.id):
        raise RunbookDocumentInvalid(f"'{doc.id}' is not a valid runbook id.")
    if not doc.versions:
        raise RunbookDocumentInvalid("A runbook needs at least one version.")
    if len(doc.versions) > MAX_RUNBOOK_VERSIONS:
        raise RunbookLimitReached("versions")
    numbers = [v.version for v in doc.versions]
    if len(set(numbers)) != len(numbers):
        raise RunbookDocumentInvalid("Two versions share one number.")
    if numbers != sorted(numbers):
        raise RunbookDocumentInvalid("Versions must be stored in ascending order.")
    for item in doc.versions:
        if item.definition.id != doc.id:
            raise RunbookDocumentInvalid(
                f"Version {item.version} belongs to '{item.definition.id}', not '{doc.id}'."
            )
    states = Counter(v.state for v in doc.versions)
    for state in ("draft", "in_review", "published", "retired"):
        if states.get(state, 0) > 1:
            raise RunbookDocumentInvalid(f"A runbook holds at most one version in state {state}.")
    if states.get("published") and states.get("retired"):
        raise RunbookDocumentInvalid("A runbook cannot be live and retired at once.")


def index_row_for(doc: StoredRunbook, revision: int) -> RunbookIndexRow:
    """The library row of ``doc`` (pure). Title, summary, phases, steps and the
    "Applies to" chips describe :meth:`StoredRunbook.display_version`."""
    shown = doc.display_version()
    defn = shown.definition if shown is not None else None
    live = doc.live
    retired_version = doc.retired_version
    return RunbookIndexRow(
        id=doc.id,
        title=defn.title if defn is not None else "",
        summary=defn.summary if defn is not None else "",
        origin=doc.origin,
        live_version=live.version if live is not None else None,
        draft_version=doc.draft.version if doc.draft is not None else None,
        in_review_version=doc.in_review.version if doc.in_review is not None else None,
        retired=doc.retired,
        retired_version=retired_version.version if retired_version is not None else None,
        replaces=doc.replaces,
        derived_from=doc.derived_from,
        owner=defn.owner if defn is not None else None,
        phases=list(defn.phases) if defn is not None else [],
        step_count=len(defn.steps) if defn is not None else 0,
        applies_to=applies_to(defn) if defn is not None else RunbookAppliesTo(),
        published_at=live.published_at if live is not None else None,
        review_due_at=doc.review_due_at,
        last_reviewed_at=doc.last_reviewed_at,
        last_reviewed_by=doc.last_reviewed_by,
        updated_at=doc.updated_at or None,
        updated_by=doc.updated_by or None,
        migrated_from=doc.migrated_from,
        doc_rev=revision,
    )


def encode_runbook(doc: StoredRunbook) -> dict[str, Any]:
    """The KV document of ``doc`` (without ``_rev``; the CAS writer adds it)."""
    return {
        SCHEMA_FIELD: _SCHEMA_VERSION,
        STORE_FIELD: RUNBOOK_LIBRARY_NS,
        DELETED_FIELD: False,
        DOC_FIELD: _canonical(doc.model_dump(mode="json")),
    }


def _tombstone() -> dict[str, Any]:
    return {
        SCHEMA_FIELD: _SCHEMA_VERSION,
        STORE_FIELD: RUNBOOK_LIBRARY_NS,
        DELETED_FIELD: True,
        DOC_FIELD: None,
    }


def decode_runbook(doc: Any) -> StoredRunbook | None:
    """A stored document back to :class:`StoredRunbook`; ``None`` for an absent,
    cleared or tombstoned document. A document that cannot be decoded raises
    :class:`RunbookStoreUnavailable` (a damaged row is never read as "absent", which
    would let a create overwrite it)."""
    if not isinstance(doc, dict) or doc.get(DELETED_FIELD) is True:
        return None
    raw = doc.get(DOC_FIELD)
    if raw is None:
        return None  # cleared ``{}`` (a reset placeholder)
    data = _load_json(raw)
    if not isinstance(data, dict):
        raise RunbookDocumentDamaged("A stored runbook could not be read.")
    try:
        return StoredRunbook.model_validate(data)
    except Exception as exc:  # noqa: BLE001 - damaged, never silently absent
        raise RunbookDocumentDamaged("A stored runbook could not be read.") from exc


def _decode_index(doc: Any) -> list[RunbookIndexRow]:
    if not isinstance(doc, dict):
        return []
    raw = doc.get(INDEX_FIELD)
    if raw is None:
        return []
    rows = _load_json(raw)
    if not isinstance(rows, list):
        raise RunbookStoreUnavailable("The runbook library index could not be read.")
    out: list[RunbookIndexRow] = []
    seen: set[str] = set()
    for row in rows:
        try:
            parsed = RunbookIndexRow.model_validate(row)
        except Exception as exc:  # noqa: BLE001 - a damaged index fails the write path
            raise RunbookStoreUnavailable("The runbook library index could not be read.") from exc
        if parsed.id not in seen:
            seen.add(parsed.id)
            out.append(parsed)
    return out


def _encode_index(rows: list[RunbookIndexRow], epoch: str) -> dict[str, Any]:
    ordered = sorted(rows, key=lambda r: r.id)
    return {
        SCHEMA_FIELD: _SCHEMA_VERSION,
        STORE_FIELD: RUNBOOK_LIBRARY_NS,
        EPOCH_FIELD: epoch,
        INDEX_FIELD: _canonical([r.model_dump(mode="json") for r in ordered]),
    }


def _epoch(doc: Any) -> str:
    value = doc.get(EPOCH_FIELD) if isinstance(doc, dict) else None
    return value if isinstance(value, str) else ""


# --------------------------------------------------------------------------- #
# The store.
# --------------------------------------------------------------------------- #
class RunbookLibraryStore:
    """Strict CRUD over the operator runbook library (constructed by ``AppState`` as
    ``RunbookLibraryStore(kv, read_only=lambda: <Demo Mode is on>)``)."""

    def __init__(self, kv: Any, *, read_only: Callable[[], bool] | None = None) -> None:
        self._kv = kv
        self._read_only = read_only
        # One lock per runbook document and one for the index and structural changes
        # (create, discard), so in-process writers never fight; across processes the
        # ``_rev`` compare-and-set is the arbiter. Weak values bound the per-runbook
        # registry: a lock exists only while a writer or a repair holds or awaits it.
        self._doc_locks: "weakref.WeakValueDictionary[str, asyncio.Lock]" = weakref.WeakValueDictionary()
        self._index_lock = asyncio.Lock()
        self._marker_lock = asyncio.Lock()
        self._catalog_cache: tuple[tuple[str, int], tuple[PublishedRunbook, ...]] | None = None
        # Bumped before and after every KV write this store makes: a catalog read that
        # overlapped any write (even one whose index projection then failed, leaving
        # the index revision where it was) never caches its result.
        self._write_gen = 0

    @property
    def kv(self) -> Any:
        return self._kv

    # ----- strict KV primitives ------------------------------------------- #
    def _lock_for(self, runbook_id: str) -> asyncio.Lock:
        lock = self._doc_locks.get(runbook_id)
        if lock is None:
            lock = self._doc_locks[runbook_id] = asyncio.Lock()
        return lock

    def _guard(self, system: bool) -> None:
        if system:
            return
        check = self._read_only
        if check is not None and check():
            raise RunbookDemoReadOnly()

    async def _get(self, key: str) -> dict[str, Any] | None:
        getter = getattr(self._kv, "get_strict", None)
        try:
            value = (
                await getter(RUNBOOK_LIBRARY_NS, key) if callable(getter)
                else await self._kv.get(RUNBOOK_LIBRARY_NS, key)
            )
        except Exception as exc:  # noqa: BLE001
            raise RunbookStoreUnavailable("The runbook library could not be read.") from exc
        if value is not None and not isinstance(value, dict):
            raise RunbookStoreUnavailable("The runbook library returned an invalid document.")
        return copy.deepcopy(value)

    async def _put_if(self, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        writer = getattr(self._kv, "put_if_strict", None)
        self._write_gen += 1
        try:
            ok = bool(
                await writer(RUNBOOK_LIBRARY_NS, key, value, expected_rev) if callable(writer)
                else await self._kv.put_if(RUNBOOK_LIBRARY_NS, key, value, expected_rev)
            )
        except Exception as exc:  # noqa: BLE001
            raise RunbookStoreUnavailable("The runbook library could not be saved.") from exc
        finally:
            self._write_gen += 1
        if not ok:
            return False
        confirmed = await self._get(key)
        if _rev(confirmed) < int(value.get(REV_FIELD, 0)):
            raise RunbookStoreUnavailable("The runbook library did not confirm the write.")
        return True

    # ----- the index ------------------------------------------------------ #
    async def read_index(self) -> LibraryIndex:
        """Every index row (sorted by id) and the index revision."""
        doc = await self._get(RUNBOOK_LIBRARY_INDEX_KEY)
        return LibraryIndex(rows=tuple(_decode_index(doc)), revision=_rev(doc), epoch=_epoch(doc))

    async def list_rows(self) -> list[RunbookIndexRow]:
        """The library rows (operator and imported runbooks), sorted by id."""
        return list((await self.read_index()).rows)

    async def count(self) -> int:
        return len((await self.read_index()).rows)

    async def _index_mutate(
        self, change: Callable[[list[RunbookIndexRow]], list[RunbookIndexRow] | None]
    ) -> list[RunbookIndexRow]:
        """Read, ``change``, compare-and-set the index; retried on a lost race (an
        index change never depends on another runbook's row). ``change`` may raise to
        refuse (nothing is written) or return ``None`` for no change."""
        async with self._index_lock:
            for _attempt in range(CAS_RETRIES + 1):
                current = await self._get(RUNBOOK_LIBRARY_INDEX_KEY)
                rows = _decode_index(current)
                updated = change([r.model_copy(deep=True) for r in rows])
                if updated is None:
                    return rows
                proposed = _encode_index(updated, _epoch(current) or uuid.uuid4().hex)
                proposed[REV_FIELD] = _rev(current) + 1
                if await self._put_if(RUNBOOK_LIBRARY_INDEX_KEY, proposed, _rev(current)):
                    self._catalog_cache = None
                    return updated
            raise RunbookStoreUnavailable("The runbook library changed too quickly; try again.")

    async def _upsert_row(self, row: RunbookIndexRow, *, enforce_limit: bool) -> None:
        def _change(rows: list[RunbookIndexRow]) -> list[RunbookIndexRow] | None:
            others = [r for r in rows if r.id != row.id]
            existing = next((r for r in rows if r.id == row.id), None)
            if existing is not None and existing.doc_rev > row.doc_rev:
                return None  # a newer write already projected this runbook
            if existing is None and enforce_limit and len(others) >= MAX_OPERATOR_RUNBOOKS:
                raise RunbookLimitReached("runbooks")
            return [*others, row]

        await self._index_mutate(_change)

    async def _remove_row(self, runbook_id: str) -> None:
        def _change(rows: list[RunbookIndexRow]) -> list[RunbookIndexRow] | None:
            if not any(r.id == runbook_id for r in rows):
                return None
            return [r for r in rows if r.id != runbook_id]

        await self._index_mutate(_change)

    async def _project(self, doc: StoredRunbook | None, runbook_id: str, revision: int) -> None:
        """Refresh one index row after its document was written; a failure is logged
        and repaired by the next write or read of that runbook (the document is the
        truth and is already saved)."""
        try:
            if doc is None:
                await self._remove_row(runbook_id)
            else:
                await self._upsert_row(index_row_for(doc, revision), enforce_limit=False)
        except RunbookStoreError as exc:
            logger.warning(
                "runbook library index not refreshed for %s (%s); repaired on the next read",
                runbook_id[:80], exc,
            )

    # ----- reads ---------------------------------------------------------- #
    async def _read_pair(self, runbook_id: str) -> tuple[dict[str, Any] | None, StoredRunbook | None, RunbookIndexRow | None]:
        """The raw document, its decoded runbook and its index row (document first)."""
        raw = await self._get(doc_key(runbook_id))
        doc = decode_runbook(raw)
        row = (await self.read_index()).row(runbook_id)
        return raw, doc, row

    @staticmethod
    def _row_is_stale(raw: Any, doc: StoredRunbook | None, row: RunbookIndexRow | None) -> bool:
        """True when ``row`` does not describe the document read: a row left behind by
        a removed document, or a row projected from another revision. An unindexed
        document (an orphan) is not a stale row: only its own create indexes it."""
        if row is None:
            return False
        if doc is None:
            return True
        return row.doc_rev != _rev(raw)

    async def _repair_row(
        self, runbook_id: str,
    ) -> tuple[dict[str, Any] | None, StoredRunbook | None, RunbookIndexRow | None]:
        """Bring one index row in line with its document and return the fresh read.

        Runs under the runbook's lock (the one create, update and discard hold) and
        re-reads the document and the row under it, so a reader whose first read
        raced a write never removes the row of a runbook created meanwhile, nor puts
        back a row a discard just removed, nor rewinds a newer projection. A failure
        to write the repair is logged (:meth:`_project`); the next read retries."""
        async with self._lock_for(runbook_id):
            raw, doc, row = await self._read_pair(runbook_id)
            if not self._row_is_stale(raw, doc, row):
                return raw, doc, row
            if doc is None:
                await self._project(None, runbook_id, 0)
                return raw, None, None
            revision = _rev(raw)
            await self._project(doc, runbook_id, revision)
            return raw, doc, index_row_for(doc, revision)

    async def get(self, runbook_id: str) -> StoredRunbookRecord | None:
        """The live document of ``runbook_id`` and its revision, or ``None`` (absent,
        discarded, or never indexed). A stale or missing index row is repaired under
        the runbook's lock (:meth:`_repair_row`), and the answer is the state read
        under it."""
        if not isinstance(runbook_id, str) or not runbook_id:
            return None
        raw, doc, row = await self._read_pair(runbook_id)
        if self._row_is_stale(raw, doc, row) and not self._read_only_now():
            raw, doc, row = await self._repair_row(runbook_id)
        if doc is None or row is None:
            return None  # absent, discarded, or an orphan of an interrupted create
        return StoredRunbookRecord(runbook=doc, revision=_rev(raw))

    def _read_only_now(self) -> bool:
        check = self._read_only
        try:
            return bool(check()) if check is not None else False
        except Exception:  # noqa: BLE001
            return True

    async def require(self, runbook_id: str) -> StoredRunbookRecord:
        """:meth:`get`, or :class:`RunbookNotFound`."""
        record = await self.get(runbook_id)
        if record is None:
            raise RunbookNotFound(runbook_id)
        return record

    async def published_catalog(self) -> tuple[PublishedRunbook, ...]:
        """Every operator runbook with a Published version (the matcher's operator
        half, the RAG projection's operator corpus, the Demo pipeline and the replay
        freeze). Drafts, versions in review and retired runbooks are never listed.
        Cached per index revision: an unchanged library costs one read. A result is
        cached only when no write of this store overlapped the read (the write
        generation is unchanged), so a write whose index projection failed (the index
        revision stays where it was) cannot pin a stale catalog: the next call reads
        again and repairs the row.

        A runbook document that cannot be decoded is left out and logged (fail safe:
        one damaged runbook never disables the guidance of every other), and a result
        that left one out is not cached, so the next call reads it again. A storage
        failure still raises :class:`RunbookStoreUnavailable`. Writes stay strict: a
        damaged document is never read as absent by create, update or discard."""
        generation = self._write_gen
        index = await self.read_index()
        key = (index.epoch, index.revision)
        cached = self._catalog_cache
        if cached is not None and cached[0] == key:
            return cached[1]
        out: list[PublishedRunbook] = []
        complete = True
        for row in index.rows:
            raw = await self._get(doc_key(row.id))
            try:
                doc = decode_runbook(raw)
            except RunbookStoreUnavailable as exc:
                logger.warning("runbook %s left out of the catalog: %s", row.id[:80], exc)
                complete = False
                continue
            if self._row_is_stale(raw, doc, row) and not self._read_only_now():
                raw, doc, _row = await self._repair_row(row.id)
            if doc is None:
                continue
            live = doc.live
            if live is not None:
                out.append(PublishedRunbook(runbook=doc, live=live, revision=_rev(raw)))
        result = tuple(sorted(out, key=lambda p: p.runbook.id))
        current = await self.read_index()
        if complete and (current.epoch, current.revision) == key and self._write_gen == generation:
            self._catalog_cache = (key, result)
        return result

    async def verified_rows(self) -> list[RunbookIndexRow]:
        """Every runbook the index lists, each read through its document
        (:meth:`get`, which repairs a stale or dangling row under the runbook's lock),
        sorted by id, as the row of the document read. A row whose document is absent
        is left out (and removed), so a create whose index write committed but
        reported a failure is never counted. A document that cannot be decoded still
        exists: its row is kept as listed (the catalog leaves it out). A storage
        failure raises :class:`RunbookStoreUnavailable`. Costs one document read per
        runbook (at most :data:`MAX_OPERATOR_RUNBOOKS`): for the one-shot migration
        and a create at the bound, never a hot path."""
        out: list[RunbookIndexRow] = []
        for row in await self.list_rows():
            try:
                record = await self.get(row.id)
            except RunbookDocumentDamaged:
                out.append(row)
                continue
            if record is not None:
                out.append(index_row_for(record.runbook, record.revision))
        return out

    async def migrated_ids(self) -> dict[tuple[str, str], str]:
        """``(legacy namespace, legacy id) -> runbook id`` for every migrated runbook
        that exists (:meth:`verified_rows`: a row whose document is absent is never
        counted): what makes the migration idempotent across an interrupted run."""
        return migrated_map(await self.verified_rows())

    # ----- writes --------------------------------------------------------- #
    def _encode_checked(self, doc: StoredRunbook) -> dict[str, Any]:
        check_stored_runbook(doc)
        encoded = encode_runbook(doc)
        if _doc_bytes(encoded) + 32 > RUNBOOK_DOC_MAX_BYTES:
            raise RunbookLimitReached("size")
        return encoded

    async def create(self, doc: StoredRunbook, *, system: bool = False) -> StoredRunbookRecord:
        """Store a NEW runbook. Raises :class:`RunbookExists` when the library already
        holds that id, :class:`RunbookLimitReached` at 200 runbooks (or a version or
        size bound), :class:`RunbookDocumentInvalid` for a broken document,
        :class:`RunbookDemoReadOnly` in Demo Mode and :class:`RunbookStoreUnavailable`
        on a storage failure. The document is written first, then its index row; if
        the index cannot be updated the document is tombstoned again and the create
        fails (the index decides what exists)."""
        self._guard(system)
        stamp = iso_now()
        doc = doc.model_copy(update={
            "created_at": doc.created_at or stamp,
            "updated_at": doc.updated_at or stamp,
            "updated_by": doc.updated_by or doc.created_by,
        })
        encoded = self._encode_checked(doc)
        async with self._lock_for(doc.id):
            index = await self.read_index()
            current = await self._get(doc_key(doc.id))
            if index.row(doc.id) is not None:
                try:
                    listed = decode_runbook(current)
                except RunbookDocumentDamaged:
                    raise RunbookExists(doc.id) from None  # it exists, only damaged
                if listed is not None:
                    raise RunbookExists(doc.id)
                # A row whose document is absent (a create whose index write committed
                # but reported a failure, then tombstoned its document) names nothing:
                # the id is free. The row is removed first (strict), so it never
                # counts toward the bound nor outranks the new projection.
                await self._remove_row(doc.id)
                index = await self.read_index()
                existing = None
            else:
                # An unindexed document that cannot be decoded is never overwritten as
                # if it were absent (raises); a readable one is an orphan.
                existing = decode_runbook(current)
            if len(index.rows) >= MAX_OPERATOR_RUNBOOKS:
                # At the bound, a dangling row of another id must not take a slot:
                # read every row through its document once (each read repairs its
                # row), then count again.
                await self.verified_rows()
                index = await self.read_index()
                if len(index.rows) >= MAX_OPERATOR_RUNBOOKS:
                    raise RunbookLimitReached("runbooks")
            if existing is not None:
                logger.info("runbook %s: overwriting an unindexed document", doc.id[:80])
            proposed = dict(encoded)
            proposed[REV_FIELD] = _rev(current) + 1
            if not await self._put_if(doc_key(doc.id), proposed, _rev(current)):
                raise RunbookExists(doc.id)
            revision = proposed[REV_FIELD]
            try:
                await self._upsert_row(index_row_for(doc, revision), enforce_limit=True)
            except RunbookStoreError as exc:
                await self._rollback_create(doc.id, revision, index_unknown=not isinstance(exc, RunbookLimitReached))
                raise
            self._catalog_cache = None
            return StoredRunbookRecord(runbook=doc, revision=revision)

    async def _rollback_create(self, runbook_id: str, revision: int, *, index_unknown: bool = False) -> None:
        """Undo a create whose index write failed: tombstone the document, then, when
        the index write's outcome is unknown (it may have committed before the error),
        remove its row too. Both are best effort and logged; what is left is repaired
        on read (an orphan document stays invisible, a dangling row is removed by the
        next :meth:`get` and ignored by :meth:`create` and :meth:`verified_rows`)."""
        tomb = _tombstone()
        tomb[REV_FIELD] = revision + 1
        try:
            await self._put_if(doc_key(runbook_id), tomb, revision)
        except RunbookStoreError as exc:  # an orphan stays invisible; logged
            logger.warning("runbook %s: create not rolled back (%s)", runbook_id[:80], exc)
        if not index_unknown:
            return  # the index refused before writing (the bound): nothing to remove
        try:
            await self._remove_row(runbook_id)
        except RunbookStoreError as exc:
            logger.warning(
                "runbook %s: index row of a failed create not removed (%s); repaired on read",
                runbook_id[:80], exc,
            )

    async def update(
        self,
        runbook_id: str,
        change: Callable[[StoredRunbook], StoredRunbook | None],
        *,
        expected_revision: int | None = None,
        system: bool = False,
    ) -> StoredRunbookRecord:
        """Read-modify-write one runbook. ``change`` receives a deep copy of the stored
        document and returns the new one (``None``: no change). It may raise a domain
        error, and nothing is written.

        With ``expected_revision`` the write is strict: a document at another revision
        is :class:`RunbookConflict` (never retried; the caller returns the latest).
        Without it a lost race is retried on a fresh read up to :data:`CAS_RETRIES`
        times, then :class:`RunbookStoreUnavailable`. A missing runbook is
        :class:`RunbookNotFound`. ``updated_at`` is stamped by the store."""
        self._guard(system)
        async with self._lock_for(runbook_id):
            for _attempt in range(CAS_RETRIES + 1):
                current = await self._get(doc_key(runbook_id))
                doc = decode_runbook(current)
                index = await self.read_index()
                if doc is None or index.row(runbook_id) is None:
                    raise RunbookNotFound(runbook_id)
                revision = _rev(current)
                if expected_revision is not None and int(expected_revision) != revision:
                    raise RunbookConflict(runbook_id, revision)
                updated = change(doc.model_copy(deep=True))
                if updated is None:
                    return StoredRunbookRecord(runbook=doc, revision=revision)
                if updated.id != runbook_id:
                    raise RunbookDocumentInvalid("A runbook's id cannot change.")
                updated = updated.model_copy(update={"updated_at": iso_now()})
                proposed = self._encode_checked(updated)
                proposed[REV_FIELD] = revision + 1
                if await self._put_if(doc_key(runbook_id), proposed, revision):
                    self._catalog_cache = None
                    await self._project(updated, runbook_id, revision + 1)
                    return StoredRunbookRecord(runbook=updated, revision=revision + 1)
                if expected_revision is not None:
                    latest = await self._get(doc_key(runbook_id))
                    raise RunbookConflict(runbook_id, _rev(latest))
            raise RunbookStoreUnavailable("The runbook changed too quickly; try again.")

    async def discard(
        self,
        runbook_id: str,
        *,
        expected_revision: int | None = None,
        system: bool = False,
    ) -> StoredRunbook:
        """Remove a runbook that was never published (the catalog checks that): its
        document is tombstoned, then its index row removed. Returns what was removed.
        Raises :class:`RunbookNotFound`, :class:`RunbookConflict` (stale
        ``expected_revision``) or :class:`RunbookStoreUnavailable`."""
        self._guard(system)
        async with self._lock_for(runbook_id):
            current = await self._get(doc_key(runbook_id))
            doc = decode_runbook(current)
            if doc is None:
                raise RunbookNotFound(runbook_id)
            revision = _rev(current)
            if expected_revision is not None and int(expected_revision) != revision:
                raise RunbookConflict(runbook_id, revision)
            tomb = _tombstone()
            tomb[REV_FIELD] = revision + 1
            if not await self._put_if(doc_key(runbook_id), tomb, revision):
                latest = await self._get(doc_key(runbook_id))
                raise RunbookConflict(runbook_id, _rev(latest))
            self._catalog_cache = None
            await self._project(None, runbook_id, revision + 1)
            return doc

    # ----- the migration marker ------------------------------------------ #
    async def read_marker(self) -> MarkerRecord | None:
        """The migration marker, or ``None`` before the migration finished. A marker
        that cannot be decoded raises :class:`RunbookStoreUnavailable` (it is never
        read as "not migrated", which would run the migration twice)."""
        doc = await self._get(RUNBOOK_LIBRARY_MIGRATION_KEY)
        if not isinstance(doc, dict) or doc.get(MIGRATION_FIELD) is None:
            return None
        data = _load_json(doc.get(MIGRATION_FIELD))
        if not isinstance(data, dict):
            raise RunbookStoreUnavailable("The runbook migration marker could not be read.")
        try:
            marker = RunbookMigrationMarker.model_validate(data)
        except Exception as exc:  # noqa: BLE001
            raise RunbookStoreUnavailable("The runbook migration marker could not be read.") from exc
        return MarkerRecord(marker=marker, revision=_rev(doc))

    async def write_marker(
        self, marker: RunbookMigrationMarker, *, expected_revision: int | None
    ) -> int:
        """Write the migration marker (system write; Demo Mode never blocks it).
        ``expected_revision`` is the revision read (``None``: the marker is absent).
        Returns the new revision; a lost race is :class:`RunbookConflict`."""
        async with self._marker_lock:
            current = await self._get(RUNBOOK_LIBRARY_MIGRATION_KEY)
            revision = _rev(current)
            if expected_revision is not None and revision != int(expected_revision):
                raise RunbookConflict("migration", revision)
            if expected_revision is None and isinstance(current, dict) and current.get(MIGRATION_FIELD):
                raise RunbookConflict("migration", revision)
            proposed = {
                SCHEMA_FIELD: _SCHEMA_VERSION,
                STORE_FIELD: RUNBOOK_LIBRARY_NS,
                MIGRATION_FIELD: _canonical(marker.model_dump(mode="json")),
                REV_FIELD: revision + 1,
            }
            if not await self._put_if(RUNBOOK_LIBRARY_MIGRATION_KEY, proposed, revision):
                latest = await self._get(RUNBOOK_LIBRARY_MIGRATION_KEY)
                raise RunbookConflict("migration", _rev(latest))
            return revision + 1

    async def migration_notice(self) -> RunbookMigrationNotice | None:
        """The counts for the Runbooks page's one-time intro (§4.10.17 step 8), or
        ``None`` when the migration converted nothing (or has not finished)."""
        record = await self.read_marker()
        if record is None or not record.marker.completed_at:
            return None
        counts = record.marker.counts
        if counts.published + counts.draft + counts.skipped == 0:
            return None
        return RunbookMigrationNotice(
            completed_at=record.marker.completed_at,
            published=counts.published,
            draft=counts.draft,
            skipped=counts.skipped,
        )
