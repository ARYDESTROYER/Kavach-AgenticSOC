"""Round 14 runbook storage (SPEC §4.10.5, §4.10.6): the library store, the per-case
run store and the run ledger, on the Elasticsearch KV and the SQL KV (SQLite).

Pins the storage contract the catalog, the run engine and the routes build on:
strict compare-and-set with a confirming read, a stale revision refused and never
retried, a lost race retried a bounded number of times, every bound (200 runbooks,
100 versions, 2 MiB, 5 runs, 10 evidence items, 512 KiB evidence, 1 MiB case
document, 512 KiB ledger month, 13 months), Demo Mode read-only for the library and
swapped for runs, the index as a repairable projection of each document, the
``runbook_``-prefixed opaque storage form, and the cases reset clearing runs while
the library survives.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
import pytest_asyncio

from app.config import Secrets
from app.constants import CONFIG_INDEX, RUNBOOK_LIBRARY_NS, RUNBOOK_RUNS_NS
from app.engine.reset import reset_service
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import (
    LookupResult,
    RunbookDefinition,
    RunbookMigratedFrom,
    RunbookRun,
    RunbookStep,
    RunbookVersionDoc,
    StepEvidence,
    StepState,
)
from app.state import AppState
from app.stores import runbook_library as library_mod
from app.stores import runbook_runs as runs_mod
from app.stores.memory import EsKVStore
from app.stores.runbook_library import (
    CAS_RETRIES,
    RunbookConflict,
    RunbookDemoReadOnly,
    RunbookDocumentInvalid,
    RunbookExists,
    RunbookLibraryStore,
    RunbookLimitReached,
    RunbookMigrationCounts,
    RunbookMigrationMarker,
    RunbookNotFound,
    RunbookStoreUnavailable,
    StoredRunbook,
    check_stored_runbook,
    doc_key,
)
from app.stores.runbook_runs import (
    EVIDENCE_LIMIT_NOTE,
    KV_KEY_MAX_CHARS,
    RunbookLedgerRow,
    RunbookRunStore,
    RunConflict,
    RunDocumentFull,
    RunLimitReached,
    RunNotFound,
    StepNotFound,
    case_key,
    ledger_key,
    month_of,
    retained_months,
    shift_month,
)


# --------------------------------------------------------------------------- #
# Fixtures and builders.
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture(params=["es", "sqlite"])
async def kv(request):
    """The shared KV on both own-state backends."""
    if request.param == "es":
        yield EsKVStore(InMemoryESClient())
        return
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        yield SqlKVStore(engine)
    finally:
        await engine.dispose()


def _definition(runbook_id: str, *, title: str = "Suspicious sign-in", steps: int = 2) -> RunbookDefinition:
    return RunbookDefinition(
        id=runbook_id,
        title=title,
        summary="Work a suspicious sign-in.",
        phases=["triage"],
        steps=[
            RunbookStep(id=f"step-{i}", phase="triage", kind="check", title=f"Is sign-in {i} expected?")
            for i in range(1, steps + 1)
        ],
    )


def _version(runbook_id: str, number: int, state: str, **defn: Any) -> RunbookVersionDoc:
    return RunbookVersionDoc(
        version=number, state=state, definition=_definition(runbook_id, **defn),
        author="alice", created_at="2026-10-01T00:00:00+00:00",
        published_at="2026-10-02T00:00:00+00:00" if state == "published" else None,
    )


def _runbook(runbook_id: str, *states: str, **extra: Any) -> StoredRunbook:
    states = states or ("draft",)
    return StoredRunbook(
        id=runbook_id,
        versions=[_version(runbook_id, i + 1, s) for i, s in enumerate(states)],
        created_by="alice",
        **extra,
    )


def _publish(doc: StoredRunbook) -> StoredRunbook:
    """The catalog's publish, reduced to what the store sees: the draft becomes live."""
    versions = []
    for item in doc.versions:
        if item.state == "published":
            item = item.model_copy(update={"state": "superseded"})
        if item.state == "draft":
            item = item.model_copy(update={"state": "published", "published_at": "2026-10-03T00:00:00+00:00"})
        versions.append(item)
    return doc.model_copy(update={"versions": versions})


class _SpyKV:
    """Wraps a KV: records every key written and can lose CAS races or fail."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.writes: list[tuple[str, str]] = []
        self.reads: list[tuple[str, str]] = []
        self.lose_races = 0
        self.lose_on: str | None = None
        self.fail_reads = False
        self.fail_writes_on: str | None = None

    async def get(self, namespace: str, key: str):
        self.reads.append((namespace, key))
        if self.fail_reads:
            raise RuntimeError("store down")
        return await self.inner.get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self.writes.append((namespace, key))
        await self.inner.put(namespace, key, value)

    async def put_if(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        if self.fail_writes_on is not None and key.startswith(self.fail_writes_on):
            raise RuntimeError("store down")
        if self.lose_races and (self.lose_on is None or key.startswith(self.lose_on)):
            self.lose_races -= 1
            return False
        self.writes.append((namespace, key))
        return await self.inner.put_if(namespace, key, value, expected_rev)


def _only_runbook_fields(doc: dict[str, Any]) -> None:
    """The reports-store rule: every top-level field is ``runbook_``-prefixed (plus the
    KV revision), and the content is one opaque string."""
    for name in doc:
        assert name == "_rev" or name.startswith("runbook_"), name


# --------------------------------------------------------------------------- #
# Library: round trip, storage form and the index.
# --------------------------------------------------------------------------- #
async def test_library_create_get_list_round_trip(kv) -> None:
    store = RunbookLibraryStore(kv)
    record = await store.create(_runbook("brute_force_login", "published"))
    assert record.revision == 1
    got = await store.require("brute_force_login")
    assert got.revision == 1
    assert got.runbook.live is not None and got.runbook.live.version == 1
    assert got.runbook.created_at and got.runbook.updated_by == "alice"
    rows = await store.list_rows()
    assert [r.id for r in rows] == ["brute_force_login"]
    row = rows[0]
    assert row.title == "Suspicious sign-in" and row.live_version == 1 and row.step_count == 2
    assert row.doc_rev == 1 and row.phases == ["triage"]
    assert await store.count() == 1
    assert await store.get("missing") is None
    with pytest.raises(RunbookNotFound):
        await store.require("missing")


async def test_library_documents_use_only_prefixed_fields_and_opaque_strings(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("phish-triage", "published"))
    await store.write_marker(RunbookMigrationMarker(completed_at="2026-10-01T00:00:00+00:00"),
                             expected_revision=None)
    for key in ("index", doc_key("phish-triage"), "migration"):
        raw = await kv.get(RUNBOOK_LIBRARY_NS, key)
        assert raw is not None
        _only_runbook_fields(raw)
        opaque = [v for k, v in raw.items() if k.endswith("_json")]
        assert opaque and all(isinstance(v, str) for v in opaque)
    doc = await kv.get(RUNBOOK_LIBRARY_NS, doc_key("phish-triage"))
    assert json.loads(doc["runbook_doc_json"])["id"] == "phish-triage"


async def test_library_documents_never_hold_the_raw_id_at_the_top_level(kv) -> None:
    """The config index maps new fields with date detection on, and ``2026-10-28`` is a
    valid operator id: a raw id field written first by such a runbook would be mapped
    as a date and refuse every later write. The id lives only in the KV key and the
    opaque JSON."""
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("2026-10-28", "published"))
    await store.create(_runbook("ordinary-id", "draft"))
    await store.discard("ordinary-id")
    for key in (doc_key("2026-10-28"), doc_key("ordinary-id"), "index"):
        raw = await kv.get(RUNBOOK_LIBRARY_NS, key)
        assert "runbook_id" not in raw
        for name, value in raw.items():
            if isinstance(value, str) and not name.endswith("_json"):
                assert "2026-10-28" not in value and "ordinary-id" not in value, (key, name)
    assert (await store.require("2026-10-28")).runbook.id == "2026-10-28"


async def test_library_refuses_a_duplicate_create(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("dup"))
    with pytest.raises(RunbookExists):
        await store.create(_runbook("dup"))


async def test_library_update_is_strict_with_an_expected_revision(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("rb-a"))
    updated = await store.update("rb-a", _publish, expected_revision=1)
    assert updated.revision == 2 and updated.runbook.live is not None
    with pytest.raises(RunbookConflict) as caught:
        await store.update("rb-a", _publish, expected_revision=1)
    assert caught.value.current_revision == 2
    row = (await store.read_index()).row("rb-a")
    assert row is not None and row.doc_rev == 2 and row.live_version == 1
    # A change that returns None writes nothing.
    same = await store.update("rb-a", lambda doc: None)
    assert same.revision == 2
    with pytest.raises(RunbookNotFound):
        await store.update("nope", _publish)


async def test_library_update_retries_a_lost_race_and_gives_up_after_the_bound() -> None:
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(spy)
    await store.create(_runbook("rb-race"))
    spy.lose_on, spy.lose_races = doc_key("rb-race"), CAS_RETRIES
    record = await store.update("rb-race", _publish)
    assert record.revision == 2
    spy.lose_races = CAS_RETRIES + 1
    with pytest.raises(RunbookStoreUnavailable):
        await store.update("rb-race", lambda doc: doc.model_copy(update={"owner": "x"}))
    # A strict write that loses its race is a conflict, never retried.
    spy.lose_races = 1
    with pytest.raises(RunbookConflict):
        await store.update("rb-race", lambda doc: doc.model_copy(update={"owner": "y"}),
                           expected_revision=2)


async def test_library_bounds(monkeypatch) -> None:
    store = RunbookLibraryStore(EsKVStore(InMemoryESClient()))
    monkeypatch.setattr(library_mod, "MAX_OPERATOR_RUNBOOKS", 3)
    for i in range(3):
        await store.create(_runbook(f"rb-{i}"))
    with pytest.raises(RunbookLimitReached) as caught:
        await store.create(_runbook("rb-overflow"))
    assert caught.value.kind == "runbooks"
    assert await store.get("rb-overflow") is None
    monkeypatch.undo()

    too_many = StoredRunbook(id="many", versions=[
        _version("many", i, "superseded") for i in range(1, 102)
    ])
    with pytest.raises(RunbookLimitReached) as caught:
        await store.create(too_many)
    assert caught.value.kind == "versions"

    monkeypatch.setattr(library_mod, "RUNBOOK_DOC_MAX_BYTES", 600)
    with pytest.raises(RunbookLimitReached) as caught:
        await store.create(_runbook("big", steps=1))
    assert caught.value.kind == "size"


@pytest.mark.parametrize(
    "doc",
    [
        _runbook("two-drafts", "draft", "draft"),
        _runbook("live-and-retired", "published", "retired"),
        _runbook("reserved", "draft").model_copy(update={"id": "generic-incident"}),
        StoredRunbook(id="no-versions"),
        StoredRunbook(id="descending", versions=[
            _version("descending", 2, "superseded"), _version("descending", 1, "draft"),
        ]),
        StoredRunbook(id="duplicate-numbers", versions=[
            _version("duplicate-numbers", 1, "superseded"), _version("duplicate-numbers", 1, "draft"),
        ]),
        StoredRunbook(id="other-id", versions=[_version("someone-else", 1, "draft")]),
        StoredRunbook(id="Bad Id", versions=[_version("Bad Id", 1, "draft")]),
    ],
    ids=lambda d: d.id,
)
def test_library_storage_invariants(doc: StoredRunbook) -> None:
    with pytest.raises(RunbookDocumentInvalid):
        check_stored_runbook(doc)


async def test_library_update_cannot_change_the_id_or_break_an_invariant(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("fixed-id"))
    with pytest.raises(RunbookDocumentInvalid):
        await store.update("fixed-id", lambda d: d.model_copy(update={"id": "other"}))
    with pytest.raises(RunbookDocumentInvalid):
        await store.update("fixed-id", lambda d: d.model_copy(update={
            "versions": [*d.versions, _version("fixed-id", 2, "draft")],
        }))
    assert (await store.require("fixed-id")).revision == 1


async def test_library_is_read_only_in_demo_mode_except_for_system_writes() -> None:
    demo_on = {"value": False}
    store = RunbookLibraryStore(EsKVStore(InMemoryESClient()), read_only=lambda: demo_on["value"])
    await store.create(_runbook("before-demo"))
    demo_on["value"] = True
    with pytest.raises(RunbookDemoReadOnly):
        await store.create(_runbook("during-demo"))
    with pytest.raises(RunbookDemoReadOnly):
        await store.update("before-demo", _publish)
    with pytest.raises(RunbookDemoReadOnly):
        await store.discard("before-demo")
    # Reads keep working (the Demo pipeline reads the real library).
    assert (await store.require("before-demo")).revision == 1
    # The migration's system writes are never blocked.
    await store.create(_runbook("system-write"), system=True)
    assert await store.get("system-write") is not None


async def test_library_discard_tombstones_the_document_and_removes_the_row(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("throwaway"))
    with pytest.raises(RunbookConflict):
        await store.discard("throwaway", expected_revision=7)
    removed = await store.discard("throwaway", expected_revision=1)
    assert removed.id == "throwaway"
    assert await store.get("throwaway") is None
    assert await store.count() == 0
    raw = await kv.get(RUNBOOK_LIBRARY_NS, doc_key("throwaway"))
    assert raw["runbook_deleted"] is True and raw["runbook_doc_json"] is None
    with pytest.raises(RunbookNotFound):
        await store.discard("throwaway")
    # The id can be used again.
    again = await store.create(_runbook("throwaway"))
    assert again.revision == 3


async def test_library_index_rows_are_repaired_from_the_documents(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("drifted"))
    # Another writer moved the document on without refreshing the index.
    raw = await kv.get(RUNBOOK_LIBRARY_NS, doc_key("drifted"))
    published = library_mod.encode_runbook(_publish(_runbook("drifted")))
    published["_rev"] = raw["_rev"] + 1
    assert await kv.put_if(RUNBOOK_LIBRARY_NS, doc_key("drifted"), published, raw["_rev"])
    assert (await store.read_index()).row("drifted").live_version is None
    got = await store.require("drifted")
    assert got.revision == 2
    row = (await store.read_index()).row("drifted")
    assert row.doc_rev == 2 and row.live_version == 1

    # A row whose document was tombstoned is removed on read.
    tomb = library_mod._tombstone()
    tomb["_rev"] = 3
    assert await kv.put_if(RUNBOOK_LIBRARY_NS, doc_key("drifted"), tomb, 2)
    assert await store.get("drifted") is None
    assert await store.count() == 0


class _GatedKV:
    """Pauses the first strict read of one key until released, so a reader can be
    held between its document read and its index read while a writer runs."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.hold: str | None = None
        self.held = asyncio.Event()
        self.release = asyncio.Event()

    async def get_strict(self, namespace: str, key: str):
        value = await self.inner.get_strict(namespace, key)
        if self.hold == key:
            self.hold = None
            self.held.set()
            await self.release.wait()
        return value

    async def put_if_strict(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        return await self.inner.put_if_strict(namespace, key, value, expected_rev)


async def test_library_a_read_racing_a_create_never_removes_the_new_row() -> None:
    """A reader saw no document, then a create wrote the document and its row: the
    read repair re-reads under the runbook's lock and keeps the new runbook."""
    kv = _GatedKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(kv)
    kv.hold = doc_key("foo")
    reader = asyncio.create_task(store.get("foo"))
    await kv.held.wait()
    created = await store.create(_runbook("foo"))
    kv.release.set()
    got = await reader
    assert got is not None and got.revision == created.revision
    assert [r.id for r in await store.list_rows()] == ["foo"]
    assert (await store.require("foo")).revision == created.revision
    with pytest.raises(RunbookExists):  # the strict create contract still holds
        await store.create(_runbook("foo"))


async def test_library_a_stale_row_repair_racing_a_discard_never_brings_the_row_back() -> None:
    """A reader saw an older document and an older row, then a discard removed both:
    the repair re-reads under the lock and never puts the row back (which would
    block a later create of the id)."""
    kv = _GatedKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("gone"))
    raw = await kv.inner.get(RUNBOOK_LIBRARY_NS, doc_key("gone"))
    moved = library_mod.encode_runbook(_runbook("gone"))
    moved["_rev"] = raw["_rev"] + 1
    assert await kv.inner.put_if(RUNBOOK_LIBRARY_NS, doc_key("gone"), moved, raw["_rev"])
    kv.hold = doc_key("gone")
    reader = asyncio.create_task(store.get("gone"))
    await kv.held.wait()
    await store.discard("gone")
    kv.release.set()
    assert await reader is None
    assert await store.list_rows() == []
    again = await store.create(_runbook("gone"))
    assert again.runbook.id == "gone"


async def test_library_an_orphan_document_is_invisible_and_overwritten_by_create(kv) -> None:
    store = RunbookLibraryStore(kv)
    orphan = library_mod.encode_runbook(_runbook("orphan", "published"))
    orphan["_rev"] = 1
    assert await kv.put_if(RUNBOOK_LIBRARY_NS, doc_key("orphan"), orphan, 0)
    assert await store.get("orphan") is None
    assert await store.published_catalog() == ()
    record = await store.create(_runbook("orphan"))
    assert record.revision == 2 and record.runbook.live is None


async def test_library_create_is_rolled_back_when_the_index_cannot_be_written() -> None:
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(spy)
    spy.fail_writes_on = "index"
    with pytest.raises(RunbookStoreUnavailable):
        await store.create(_runbook("half-made"))
    spy.fail_writes_on = None
    raw = await spy.inner.get(RUNBOOK_LIBRARY_NS, doc_key("half-made"))
    assert raw["runbook_deleted"] is True
    assert await store.get("half-made") is None


class _CommitThenRaiseKV:
    """Wraps a KV: the chosen write of the index COMMITS and then raises (an
    Elasticsearch timeout after the write landed), once."""

    def __init__(self, inner: Any, *, nth: int) -> None:
        self.inner = inner
        self.nth = nth
        self.index_writes = 0

    async def get(self, namespace: str, key: str):
        return await self.inner.get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        await self.inner.put(namespace, key, value)

    async def put_if(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        ok = await self.inner.put_if(namespace, key, value, expected_rev)
        if namespace == RUNBOOK_LIBRARY_NS and key == "index":
            self.index_writes += 1
            if self.index_writes == self.nth:
                raise TimeoutError("request timed out after the write committed")
        return ok


async def _dangle(kv: Any, store: RunbookLibraryStore, runbook_id: str) -> None:
    """Leave a row whose document is absent: tombstone the document behind the
    store's back (what a failed create's rollback leaves when its row committed)."""
    raw = await kv.get(RUNBOOK_LIBRARY_NS, doc_key(runbook_id))
    tomb = library_mod._tombstone()
    tomb["_rev"] = raw["_rev"] + 1
    assert await kv.put_if(RUNBOOK_LIBRARY_NS, doc_key(runbook_id), tomb, raw["_rev"])
    assert (await store.read_index()).row(runbook_id) is not None


async def test_library_a_create_whose_index_write_committed_then_failed_leaves_no_row() -> None:
    """The index write's outcome is unknown, so the rollback removes the row as well
    as the document: nothing dangles, and the id can be created again."""
    kv = _CommitThenRaiseKV(EsKVStore(InMemoryESClient()), nth=1)
    store = RunbookLibraryStore(kv)
    with pytest.raises(RunbookStoreUnavailable):
        await store.create(_runbook("unsure", "published"))
    assert await store.list_rows() == [] and await store.count() == 0
    assert await store.get("unsure") is None
    record = await store.create(_runbook("unsure", "published"))
    assert (await store.require("unsure")).revision == record.revision
    assert [p.runbook.id for p in await store.published_catalog()] == ["unsure"]


async def test_library_a_dangling_row_never_counts_as_a_runbook(kv) -> None:
    """A row whose document is absent names nothing: a create of that id replaces it,
    :meth:`verified_rows` and the migrated ids leave it out (and remove it), and it
    never takes a slot of the 200-runbook bound."""
    store = RunbookLibraryStore(kv)
    origin = RunbookMigratedFrom(namespace="playbooks", id="acme-vpn", revision=3)
    await store.create(_runbook("ghost", "published", migrated_from=origin, origin="imported"), system=True)
    await store.create(_runbook("kept", "published"))
    await _dangle(kv, store, "ghost")
    # A create of the same id is not refused by the dangling row.
    fresh = RunbookLibraryStore(kv)
    record = await fresh.create(_runbook("ghost", "draft"))
    assert record.runbook.live is None
    assert (await fresh.read_index()).row("ghost").doc_rev == record.revision

    await _dangle(kv, fresh, "ghost")
    reader = RunbookLibraryStore(kv)
    assert [r.id for r in await reader.verified_rows()] == ["kept"]
    assert await reader.migrated_ids() == {}
    assert [r.id for r in await reader.list_rows()] == ["kept"]  # repaired on the way


async def test_library_a_dangling_row_never_takes_a_slot_of_the_bound(monkeypatch) -> None:
    monkeypatch.setattr(library_mod, "MAX_OPERATOR_RUNBOOKS", 2)
    kv = EsKVStore(InMemoryESClient())
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("one"))
    await store.create(_runbook("two"))
    with pytest.raises(RunbookLimitReached):
        await store.create(_runbook("three"))
    await _dangle(kv, store, "two")
    record = await RunbookLibraryStore(kv).create(_runbook("three"))
    assert record.runbook.id == "three"
    assert [r.id for r in await store.list_rows()] == ["one", "three"]


async def test_library_verified_rows_keep_a_damaged_document_and_raise_on_an_outage() -> None:
    """A damaged document still exists (its row is kept, never read as absent); a
    storage outage is an outage, never an empty library."""
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(spy)
    await store.create(_runbook("healthy"))
    await store.create(_runbook("damaged"))
    raw = await spy.inner.get(RUNBOOK_LIBRARY_NS, doc_key("damaged"))
    await spy.inner.put(RUNBOOK_LIBRARY_NS, doc_key("damaged"), dict(raw, runbook_doc_json="{not json"))
    assert [r.id for r in await store.verified_rows()] == ["damaged", "healthy"]
    with pytest.raises(RunbookExists):  # it exists, only damaged
        await store.create(_runbook("damaged"))
    spy.fail_reads = True
    with pytest.raises(RunbookStoreUnavailable):
        await store.verified_rows()


async def test_library_storage_failures_are_never_read_as_absent() -> None:
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(spy)
    await store.create(_runbook("present"))
    spy.fail_reads = True
    with pytest.raises(RunbookStoreUnavailable):
        await store.get("present")
    with pytest.raises(RunbookStoreUnavailable):
        await store.list_rows()
    spy.fail_reads = False
    spy.fail_writes_on = doc_key("present")
    with pytest.raises(RunbookStoreUnavailable):
        await store.update("present", _publish)
    spy.fail_writes_on = None
    damaged = {"runbook_id": "present", "runbook_deleted": False, "runbook_doc_json": "{not json", "_rev": 9}
    await spy.inner.put(RUNBOOK_LIBRARY_NS, doc_key("present"), damaged)
    with pytest.raises(RunbookStoreUnavailable):
        await store.get("present")
    with pytest.raises(RunbookExists):  # the index still names it
        await store.create(_runbook("present"))
    # An unindexed damaged document is never overwritten as if it were absent.
    await spy.inner.put(RUNBOOK_LIBRARY_NS, doc_key("damaged-orphan"), dict(damaged, runbook_id="damaged-orphan"))
    with pytest.raises(RunbookStoreUnavailable):
        await store.create(_runbook("damaged-orphan"))


async def test_published_catalog_lists_only_live_versions_and_caches_per_index_revision() -> None:
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(spy)
    await store.create(_runbook("live-one", "published"))
    await store.create(_runbook("draft-only", "draft"))
    await store.create(_runbook("in-review", "superseded", "in_review"))
    await store.create(_runbook("retired-one", "superseded", "retired"))
    await store.create(_runbook("live-with-draft", "published", "draft"))
    catalog = await store.published_catalog()
    assert [p.runbook.id for p in catalog] == ["live-one", "live-with-draft"]
    assert all(p.live.state == "published" for p in catalog)
    spy.reads.clear()
    again = await store.published_catalog()
    assert again is catalog
    assert spy.reads == [(RUNBOOK_LIBRARY_NS, "index")]
    await store.update("draft-only", _publish)
    assert [p.runbook.id for p in await store.published_catalog()] == [
        "draft-only", "live-one", "live-with-draft",
    ]


class _RacingKV:
    """Holds the strict read of one key until released and can fail the next write
    of another key once, to interleave a catalog read with an update."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.hold: str | None = None
        self.held = asyncio.Event()
        self.release = asyncio.Event()
        self.fail_once: str | None = None

    async def get_strict(self, namespace: str, key: str):
        value = await self.inner.get_strict(namespace, key)
        if self.hold == key:
            self.hold = None
            self.held.set()
            await self.release.wait()
        return value

    async def put_if_strict(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        if self.fail_once == key:
            self.fail_once = None
            raise RuntimeError("index write failed")
        return await self.inner.put_if_strict(namespace, key, value, expected_rev)


def _retire(doc: StoredRunbook) -> StoredRunbook:
    return doc.model_copy(update={"versions": [
        v.model_copy(update={"state": "retired"}) if v.state == "published" else v for v in doc.versions
    ]})


async def test_published_catalog_never_caches_a_read_that_overlapped_a_write() -> None:
    """A catalog read takes the index revision, reads a document, and meanwhile an
    update retires that runbook but its index projection fails (the revision stays
    put). The overlapping read may return the old answer once, but never caches it:
    the next call reads again, repairs the row and leaves the retired runbook out."""
    kv = _RacingKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(kv)
    await store.create(_runbook("acme", "published"))
    kv.hold = doc_key("acme")
    reader = asyncio.create_task(store.published_catalog())
    await kv.held.wait()
    kv.fail_once = "index"
    await store.update("acme", _retire)  # the projection failure is logged, not raised
    assert (await store.read_index()).row("acme").live_version == 1  # the row is stale
    kv.release.set()
    assert [p.runbook.id for p in await reader] == ["acme"]  # the overlapping read
    for _ in range(3):
        assert await store.published_catalog() == ()
    assert (await store.read_index()).row("acme").live_version is None  # repaired


async def test_published_catalog_leaves_out_a_damaged_runbook_and_retries_it() -> None:
    """One damaged runbook never takes the guidance of every other away: it is left
    out and logged, the result is not cached, and the writes stay strict."""
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookLibraryStore(spy)
    await store.create(_runbook("healthy", "published"))
    await store.create(_runbook("damaged", "published"))
    raw = await spy.inner.get(RUNBOOK_LIBRARY_NS, doc_key("damaged"))
    await spy.inner.put(RUNBOOK_LIBRARY_NS, doc_key("damaged"),
                        dict(raw, runbook_doc_json="{not json"))
    catalog = await store.published_catalog()
    assert [p.runbook.id for p in catalog] == ["healthy"]
    spy.reads.clear()
    await store.published_catalog()
    assert (RUNBOOK_LIBRARY_NS, doc_key("damaged")) in spy.reads  # not cached: read again
    with pytest.raises(RunbookStoreUnavailable):
        await store.update("damaged", _publish)
    with pytest.raises(RunbookStoreUnavailable):
        await store.get("damaged")
    # A storage outage is still an outage, never an empty catalog.
    spy.fail_reads = True
    with pytest.raises(RunbookStoreUnavailable):
        await store.published_catalog()


async def test_published_catalog_cache_never_survives_a_purged_library() -> None:
    es = InMemoryESClient()
    store = RunbookLibraryStore(EsKVStore(es))
    await store.create(_runbook("old-world", "published"))
    first = await store.published_catalog()
    assert [p.runbook.id for p in first] == ["old-world"]
    # A factory purge removes every library document; the next index starts at the
    # same revision but under a new epoch.
    for key in ("index", doc_key("old-world")):
        await es.delete_doc(CONFIG_INDEX, f"{RUNBOOK_LIBRARY_NS}:{key}", refresh=True)
    await store.create(_runbook("new-world", "published"))
    assert (await store.read_index()).revision == 1
    assert [p.runbook.id for p in await store.published_catalog()] == ["new-world"]


async def test_library_migration_marker_and_notice(kv) -> None:
    store = RunbookLibraryStore(kv)
    assert await store.read_marker() is None
    assert await store.migration_notice() is None
    empty = RunbookMigrationMarker(completed_at="2026-10-28T00:00:00+00:00")
    assert await store.write_marker(empty, expected_revision=None) == 1
    assert await store.migration_notice() is None  # nothing converted, no intro
    with pytest.raises(RunbookConflict):
        await store.write_marker(empty, expected_revision=None)
    counted = empty.model_copy(update={
        "counts": RunbookMigrationCounts(published=8, draft=2),
        "id_map": {"playbooks:brute_force_login": "brute_force_login"},
    })
    assert await store.write_marker(counted, expected_revision=1) == 2
    notice = await store.migration_notice()
    assert notice is not None and (notice.published, notice.draft, notice.skipped) == (8, 2, 0)
    record = await store.read_marker()
    assert record.revision == 2 and record.marker.id_map["playbooks:brute_force_login"] == "brute_force_login"
    with pytest.raises(RunbookConflict):
        await store.write_marker(counted, expected_revision=1)


async def test_library_migrated_ids_come_from_the_documents(kv) -> None:
    store = RunbookLibraryStore(kv)
    await store.create(_runbook(
        "brute_force_login-imported",
        migrated_from=RunbookMigratedFrom(namespace="playbooks", id="brute_force_login", revision=3),
        origin="imported",
    ), system=True)
    await store.create(_runbook("hand-made"))
    assert await store.migrated_ids() == {("playbooks", "brute_force_login"): "brute_force_login-imported"}
    row = (await store.read_index()).row("brute_force_login-imported")
    assert row.origin == "imported" and row.migrated_from.revision == 3


# --------------------------------------------------------------------------- #
# Runs: per-case documents.
# --------------------------------------------------------------------------- #
def _run(case_id: str, runbook_id: str, *, run_id: str | None = None, steps: int = 2) -> RunbookRun:
    return RunbookRun(
        run_id=run_id or f"run-{runbook_id}",
        case_id=case_id,
        runbook_id=runbook_id,
        version=1,
        title="Suspicious sign-in",
        snapshot=_definition(runbook_id, steps=steps),
        attached_by="rule",
        attached_at="2026-10-28T00:00:00+00:00",
    )


def _add(run: RunbookRun):
    def _change(runs: list[RunbookRun]):
        return [*runs, run], run.run_id
    return _change


def _lookup(rows: int = 2, cell: str = "x") -> LookupResult:
    return LookupResult(
        tool="log_search", status="ok", count=rows, ran_by="agentic_soc",
        facts=[{"label": "Rows", "value": str(rows)}],
        table={"columns": ["host"], "rows": [[cell] for _ in range(rows)]}, table_kind="rows",
    )


async def test_runs_round_trip_and_storage_form(kv) -> None:
    store = RunbookRunStore(kv)
    empty = await store.get("case-0001")
    assert empty.runs == () and empty.revision == 0
    result, case = await store.mutate("case-0001", _add(_run("case-0001", "rb-a")))
    assert result == "run-rb-a" and case.revision == 1
    got = await store.get("case-0001")
    assert [r.runbook_id for r in got.runs] == ["rb-a"] and got.revision == 1
    assert got.run("run-rb-a") is not None and got.run("nope") is None
    raw = await kv.get(RUNBOOK_RUNS_NS, case_key("case-0001"))
    _only_runbook_fields(raw)
    assert raw["runbook_store"] == RUNBOOK_RUNS_NS and isinstance(raw["runbook_runs_json"], str)
    # A no-op change writes nothing.
    _, same = await store.mutate("case-0001", lambda runs: (None, None))
    assert same.revision == 1
    with pytest.raises(ValueError):
        await store.get("")


async def test_runs_a_stale_revision_is_a_conflict_and_never_retried(kv) -> None:
    store = RunbookRunStore(kv)
    await store.mutate("case-0002", _add(_run("case-0002", "rb-a")))
    with pytest.raises(RunConflict) as caught:
        await store.mutate("case-0002", _add(_run("case-0002", "rb-b")), expected_revision=0)
    assert caught.value.current_revision == 1
    _, case = await store.mutate("case-0002", _add(_run("case-0002", "rb-b")), expected_revision=1)
    assert case.revision == 2 and len(case.runs) == 2


async def test_runs_bounds(monkeypatch) -> None:
    store = RunbookRunStore(EsKVStore(InMemoryESClient()))
    for i in range(5):
        await store.mutate("case-b", _add(_run("case-b", f"rb-{i}")))
    with pytest.raises(RunLimitReached):
        await store.mutate("case-b", _add(_run("case-b", "rb-6")))
    with pytest.raises(ValueError):  # one run per case and runbook (#4)
        await store.mutate("case-c", lambda runs: ([_run("case-c", "rb"), _run("case-c", "rb", run_id="other")], None))
    with pytest.raises(ValueError):
        await store.mutate("case-c", _add(_run("another-case", "rb")))

    crowded = _run("case-d", "rb")
    crowded.steps["step-1"] = StepState(evidence=[
        StepEvidence(kind="link", url=f"https://example.com/{i}", label="Ticket") for i in range(11)
    ])
    with pytest.raises(RunDocumentFull) as caught:
        await store.mutate("case-d", _add(crowded))
    assert caught.value.reason == "evidence_count"

    # The 512 KiB budget bounds the kept lookup TABLES: a table past it is refused, a
    # result without its table is not measured against it.
    monkeypatch.setattr(runs_mod, "RUNBOOK_CASE_EVIDENCE_MAX_BYTES", 200)
    heavy = _run("case-e", "rb")
    heavy.steps["step-1"] = StepState(evidence=[
        StepEvidence(kind="lookup_result", lookup=_lookup(rows=10, cell="y" * 30)),
    ])
    with pytest.raises(RunDocumentFull) as caught:
        await store.mutate("case-e", _add(heavy))
    assert caught.value.reason == "evidence"
    light = _run("case-e", "rb")
    light.steps["step-1"] = StepState(evidence=[StepEvidence(kind="lookup_result", lookup=_lookup(
        rows=10, cell="y" * 30).model_copy(update={"table": None, "table_kind": None}))])
    await store.mutate("case-e", _add(light))
    monkeypatch.undo()

    monkeypatch.setattr(runs_mod, "RUNBOOK_CASE_DOC_MAX_BYTES", 500)
    with pytest.raises(RunDocumentFull) as caught:
        await store.mutate("case-f", _add(_run("case-f", "rb", steps=5)))
    assert caught.value.reason == "size"
    assert (await store.get("case-f")).revision == 0


async def test_runs_lookup_results_replace_and_respect_the_evidence_budget(kv, monkeypatch) -> None:
    store = RunbookRunStore(kv)
    run = _run("case-l", "rb")
    run.steps["step-1"] = StepState(revision=4, status="in_progress", evidence=[
        StepEvidence(kind="link", url="https://tickets.example.com/1", label="Ticket"),
    ])
    await store.mutate("case-l", _add(run))
    first = await store.record_lookup_result("case-l", "run-rb", "step-1", _lookup(rows=2))
    assert first.replaced is False and first.table_dropped is False
    second = await store.record_lookup_result("case-l", "run-rb", "step-1", _lookup(rows=3))
    assert second.replaced is True
    state = (await store.get("case-l")).run("run-rb").steps["step-1"]
    kinds = [e.kind for e in state.evidence]
    assert kinds == ["link", "lookup_result"]
    assert state.evidence[1].lookup.count == 3
    # A lookup result never changes what a person wrote.
    assert state.revision == 4 and state.status == "in_progress"
    # A step without earlier state gets one.
    await store.record_lookup_result("case-l", "run-rb", "step-2", _lookup(rows=1))
    with pytest.raises(RunNotFound):
        await store.record_lookup_result("case-l", "missing-run", "step-1", _lookup())
    with pytest.raises(StepNotFound):
        await store.record_lookup_result("case-l", "run-rb", "step-99", _lookup())

    # Past the evidence budget the table is dropped and the note says so.
    monkeypatch.setattr(runs_mod, "RUNBOOK_CASE_EVIDENCE_MAX_BYTES", 1200)
    big = await store.record_lookup_result("case-l", "run-rb", "step-1", _lookup(rows=20, cell="y" * 150))
    assert big.table_dropped is True
    assert big.result.table is None and big.result.reason == EVIDENCE_LIMIT_NOTE
    assert big.result.count == 20 and big.result.facts == [{"label": "Rows", "value": "20"}]


def _wide_lookup(i: int) -> LookupResult:
    """A lookup with a full 20x6 table of 200-character cells (about 25 KiB)."""
    return LookupResult(
        tool="log_stats", params={"rule": f"rule-{i}"}, window_from="2026-10-01T00:00:00+00:00",
        window_to="2026-10-01T01:00:00+00:00", ran_at="2026-10-01T01:00:00+00:00",
        ran_by="agentic_soc", status="ok", count=20,
        facts=[{"label": "Rows", "value": "20"}],
        table={"columns": [f"c{c}" for c in range(6)], "rows": [["x" * 200] * 6 for _ in range(20)]},
        table_kind="aggregate",
    )


async def test_runs_a_case_at_the_evidence_cap_keeps_recording_every_lookup(kv) -> None:
    """SPEC §4.10.21: a case at the evidence cap stays under 1 MiB and drops the
    table with its note. Every later lookup is still stored with its count, facts and
    parameters (only a table is ever shed), at the real bounds."""
    store = RunbookRunStore(kv)
    await store.mutate("case-cap", _add(_run("case-cap", "rb", steps=40)))
    writes = [
        await store.record_lookup_result("case-cap", "run-rb", f"step-{i}", _wide_lookup(i))
        for i in range(1, 41)
    ]
    dropped = [w for w in writes if w.table_dropped]
    assert dropped, "the 512 KiB budget is reached within 40 full tables"
    first_drop = writes.index(dropped[0])
    assert all(w.table_dropped for w in writes[first_drop:])
    assert all(not w.table_dropped for w in writes[:first_drop])
    for write in dropped:
        assert write.result.table is None and write.result.table_kind is None
        assert write.result.reason == EVIDENCE_LIMIT_NOTE
        assert write.result.count == 20 and write.result.facts == [{"label": "Rows", "value": "20"}]
        assert write.result.params["rule"].startswith("rule-")
    case = await store.get("case-cap")
    assert runs_mod.lookup_table_bytes(case.runs) <= runs_mod.RUNBOOK_CASE_EVIDENCE_MAX_BYTES
    steps = case.run("run-rb").steps
    assert all(len([e for e in steps[f"step-{i}"].evidence if e.kind == "lookup_result"]) == 1
               for i in range(1, 41))
    raw = await kv.get(RUNBOOK_RUNS_NS, case_key("case-cap"))
    assert runs_mod._bytes(raw) < runs_mod.RUNBOOK_CASE_DOC_MAX_BYTES
    # A re-run of a step whose table was kept replaces it: the freed budget is reused.
    rerun = await store.record_lookup_result("case-cap", "run-rb", "step-1", _wide_lookup(1))
    assert rerun.replaced is True and rerun.table_dropped is False
    # A person's link still lands on a case at its evidence limit.
    def _link(runs: list[RunbookRun]):
        state = runs[0].steps["step-40"]
        runs[0].steps["step-40"] = state.model_copy(update={"evidence": [
            *state.evidence, StepEvidence(kind="link", url="https://tickets.example.com/9", label="Ticket"),
        ]})
        return runs, None
    await store.mutate("case-cap", _link)


async def test_runs_a_table_that_would_pass_one_mib_is_dropped_not_refused(monkeypatch) -> None:
    store = RunbookRunStore(EsKVStore(InMemoryESClient()))
    await store.mutate("case-doc", _add(_run("case-doc", "rb", steps=2)))
    base = runs_mod._bytes(await store.kv.get(RUNBOOK_RUNS_NS, case_key("case-doc")))
    monkeypatch.setattr(runs_mod, "RUNBOOK_CASE_DOC_MAX_BYTES", base + 2_000)
    write = await store.record_lookup_result("case-doc", "run-rb", "step-1", _wide_lookup(1))
    assert write.table_dropped is True and write.result.reason == EVIDENCE_LIMIT_NOTE
    assert write.result.count == 20
    # Only a document that would pass the bound even without the table is refused.
    monkeypatch.setattr(runs_mod, "RUNBOOK_CASE_DOC_MAX_BYTES", base)
    with pytest.raises(RunDocumentFull) as caught:
        await store.record_lookup_result("case-doc", "run-rb", "step-2", _wide_lookup(2))
    assert caught.value.reason == "size"


async def test_lock_registries_do_not_grow_with_every_case_and_runbook() -> None:
    import gc

    runs = RunbookRunStore(EsKVStore(InMemoryESClient()))
    for i in range(25):
        await runs.mutate(f"case-{i}", _add(_run(f"case-{i}", "rb")))
    library = RunbookLibraryStore(EsKVStore(InMemoryESClient()))
    for i in range(25):
        await library.create(_runbook(f"rb-{i}"))
        await library.get(f"rb-{i}")
    gc.collect()
    assert len(runs._case_locks) == 0
    assert len(library._doc_locks) == 0


async def test_runs_twenty_concurrent_cases_never_touch_the_ledger() -> None:
    spy = _SpyKV(EsKVStore(InMemoryESClient()))
    store = RunbookRunStore(spy)

    async def _one(i: int) -> None:
        case_id = f"case-{i:04d}"
        await store.mutate(case_id, _add(_run(case_id, "rb")))
        await store.record_lookup_result(case_id, "run-rb", "step-1", _lookup())

    await asyncio.gather(*(_one(i) for i in range(20)))
    assert len(spy.writes) == 40
    assert all(key.startswith("case:") for _ns, key in spy.writes)
    assert not any(key.startswith("ledger:") for _ns, key in spy.reads)


async def test_runs_two_processes_writing_one_case_both_land() -> None:
    """Two stores (two processes) on one KV: the per-process lock does not cover the
    race, the compare-and-set does, and the retry re-applies each change."""
    kv = EsKVStore(InMemoryESClient())
    first, second = RunbookRunStore(kv), RunbookRunStore(kv)
    await asyncio.gather(*(
        (first if i % 2 else second).mutate("case-shared", _add(_run("case-shared", f"rb-{i}")))
        for i in range(4)
    ))
    case = await first.get("case-shared")
    assert sorted(r.runbook_id for r in case.runs) == ["rb-0", "rb-1", "rb-2", "rb-3"]
    assert case.revision == 4


async def test_runs_get_many_bounds_concurrency_and_skips_invalid_ids() -> None:
    kv = EsKVStore(InMemoryESClient())
    store = RunbookRunStore(kv)
    for i in range(3):
        await store.mutate(f"case-{i}", _add(_run(f"case-{i}", "rb")))
    active = {"now": 0, "peak": 0}
    real_get = store.get

    async def _counting_get(case_id: str):
        active["now"] += 1
        active["peak"] = max(active["peak"], active["now"])
        await asyncio.sleep(0)
        try:
            return await real_get(case_id)
        finally:
            active["now"] -= 1

    store.get = _counting_get  # type: ignore[method-assign]
    ids = [f"case-{i}" for i in range(20)] + ["", "bad\x00id", "case-0"]
    result = await store.get_many(ids, concurrency=4)
    assert active["peak"] <= 4
    assert len(result) == 20
    assert [r.runbook_id for r in result["case-1"].runs] == ["rb"]
    assert result["case-19"].runs == ()


async def test_runs_delete_case_tombstones(kv) -> None:
    store = RunbookRunStore(kv)
    assert await store.delete_case("case-z") is False
    await store.mutate("case-z", _add(_run("case-z", "rb")))
    assert await store.delete_case("case-z") is True
    assert (await store.get("case-z")).runs == ()
    assert await store.delete_case("case-z") is False
    _, case = await store.mutate("case-z", _add(_run("case-z", "rb")))
    assert len(case.runs) == 1


async def test_runs_a_long_case_id_is_keyed_on_its_hash(kv) -> None:
    store = RunbookRunStore(kv)
    long_id = "case-" + "x" * 190
    key = case_key(long_id)
    assert len(key) <= KV_KEY_MAX_CHARS and key.startswith("case:~")
    assert case_key("case-0001") == "case:case-0001"
    await store.mutate(long_id, _add(_run(long_id, "rb")))
    got = await store.get(long_id)
    assert got.runs[0].case_id == long_id
    raw = await kv.get(RUNBOOK_RUNS_NS, key)
    assert raw["runbook_case_id"] == f"case:{long_id}"


async def test_runs_never_store_a_raw_case_id_at_the_top_level(kv) -> None:
    """A case id shaped like a date never reaches a top-level field as itself (the
    config index's date detection would map it as a date for every later case)."""
    store = RunbookRunStore(kv)
    await store.mutate("2026-10-28", _add(_run("2026-10-28", "rb")))
    raw = await kv.get(RUNBOOK_RUNS_NS, case_key("2026-10-28"))
    assert raw["runbook_case_id"] == "case:2026-10-28"
    await store.delete_case("2026-10-28")
    tomb = await kv.get(RUNBOOK_RUNS_NS, case_key("2026-10-28"))
    assert tomb["runbook_case_id"] == "case:2026-10-28" and tomb["runbook_deleted"] is True


async def test_runs_a_damaged_document_is_never_read_as_empty(kv) -> None:
    store = RunbookRunStore(kv)
    await kv.put(RUNBOOK_RUNS_NS, case_key("case-bad"),
                 {"runbook_case_id": "case-bad", "runbook_runs_json": "[{\"run_id\": 1}]", "_rev": 2})
    with pytest.raises(RunbookStoreUnavailable):
        await store.get("case-bad")
    with pytest.raises(RunbookStoreUnavailable):
        await store.mutate("case-bad", _add(_run("case-bad", "rb")))


# --------------------------------------------------------------------------- #
# The run ledger.
# --------------------------------------------------------------------------- #
NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)


def _row(run_id: str, started: datetime, **extra: Any) -> RunbookLedgerRow:
    return RunbookLedgerRow(
        run_id=run_id, case_id=f"case-{run_id}", runbook_id="rb", version=1,
        attached_by="rule", started_at=started.isoformat(), **extra,
    )


def test_ledger_months() -> None:
    assert month_of("2026-10-28T23:30:00-05:00") == "2026-10"  # UTC: 2026-10-29
    assert month_of("2026-10-31T23:30:00-05:00") == "2026-11"
    assert month_of("not a time", default=NOW) == "2026-10"
    assert shift_month("2026-01", -1) == "2025-12" and shift_month("2025-12", 1) == "2026-01"
    kept = retained_months(NOW)
    assert len(kept) == 13 and kept[0] == "2026-10" and kept[-1] == "2025-10"


async def test_ledger_rows_upsert_by_run_and_file_by_start_month(kv) -> None:
    store = RunbookRunStore(kv)
    write = await store.upsert_ledger_row(_row("r1", NOW - timedelta(days=40)), now=NOW)
    assert (write.month, write.stored, write.evicted) == ("2026-09", True, False)
    await store.upsert_ledger_row(_row("r1", NOW - timedelta(days=40), status="completed",
                                       completed_at=NOW.isoformat(), total=4), now=NOW)
    await store.upsert_ledger_row(_row("r2", NOW), now=NOW)
    months = await store.read_ledger(["2026-09", "2026-10", "garbage"])
    assert [m.month for m in months] == ["2026-09", "2026-10"]
    september = months[0]
    assert [(r.run_id, r.status, r.total) for r in september.rows] == [("r1", "completed", 4)]
    assert not september.partial
    raw = await kv.get(RUNBOOK_RUNS_NS, ledger_key("2026-09"))
    _only_runbook_fields(raw)
    # A start in the future is filed this month; one past retention is not written.
    future = await store.upsert_ledger_row(_row("r3", NOW + timedelta(days=90)), now=NOW)
    assert future.month == "2026-10" and future.stored
    old = await store.upsert_ledger_row(_row("r4", NOW - timedelta(days=500)), now=NOW)
    assert old.stored is False and old.evicted is False
    assert await kv.get(RUNBOOK_RUNS_NS, ledger_key(old.month)) is None


async def test_ledger_month_cap_evicts_and_marks_the_month_partial(monkeypatch) -> None:
    store = RunbookRunStore(EsKVStore(InMemoryESClient()))
    monkeypatch.setattr(runs_mod, "RUNBOOK_LEDGER_MONTH_MAX_BYTES", 900)
    results = [await store.upsert_ledger_row(_row(f"r{i}", NOW), now=NOW) for i in range(6)]
    assert results[0].stored and not results[0].evicted
    assert any(r.evicted for r in results)
    (month,) = await store.read_ledger(["2026-10"])
    assert month.partial and month.evicted == sum(1 for r in results if r.evicted)
    assert len(month.rows) == sum(1 for r in results if r.stored)


async def test_ledger_months_past_retention_are_swept_once_per_month() -> None:
    kv = EsKVStore(InMemoryESClient())
    store = RunbookRunStore(kv)
    stale = runs_mod._encode_ledger("2025-08", [_row("old", datetime(2025, 8, 3, tzinfo=timezone.utc))], 0)
    stale["_rev"] = 1
    await kv.put(RUNBOOK_RUNS_NS, ledger_key("2025-08"), stale)
    kept = runs_mod._encode_ledger("2025-10", [_row("kept", datetime(2025, 10, 3, tzinfo=timezone.utc))], 0)
    kept["_rev"] = 1
    await kv.put(RUNBOOK_RUNS_NS, ledger_key("2025-10"), kept)
    await store.upsert_ledger_row(_row("new", NOW), now=NOW)
    swept = await kv.get(RUNBOOK_RUNS_NS, ledger_key("2025-08"))
    assert swept["runbook_deleted"] is True
    (oldest,) = await store.read_ledger(["2025-10"])
    assert [r.run_id for r in oldest.rows] == ["kept"]
    window = await store.read_ledger_window(datetime(2026, 9, 1, tzinfo=timezone.utc), NOW)
    assert [m.month for m in window] == ["2026-09", "2026-10"]


# --------------------------------------------------------------------------- #
# AppState: accessors, the Demo boundary and the cases reset.
# --------------------------------------------------------------------------- #
def _state(**secret_overrides: Any) -> AppState:
    mock = MockProvider()
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, **secret_overrides,
    )
    return AppState.create(secrets=secrets, es=InMemoryESClient(),
                           provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})


async def test_state_runbook_accessors_and_the_demo_boundary() -> None:
    state = _state()
    await state.startup(start_poller=False)
    try:
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        library = state.runbook_library
        assert library is state.runbook_library
        assert state.runbook_runs is state.real_runbook_runs
        await library.create(_runbook("real-runbook"))
        await state.runbook_runs.mutate("case-real", _add(_run("case-real", "real-runbook")))

        await state.enable_demo(mode="seeded", seed=1337, history_days=1)
        assert state.runbook_library is library
        demo_runs = state.runbook_runs
        assert demo_runs is not state.real_runbook_runs
        assert state.runbook_runs is demo_runs
        assert (await demo_runs.get("case-real")).runs == ()
        await demo_runs.mutate("case-demo", _add(_run("case-demo", "real-runbook")))
        with pytest.raises(RunbookDemoReadOnly):
            await state.runbook_library.create(_runbook("demo-write"))
        assert (await state.runbook_library.require("real-runbook")).revision == 1

        await state.disable_demo()
        assert state.runbook_runs is state.real_runbook_runs
        assert (await state.runbook_runs.get("case-demo")).runs == ()
        assert len((await state.runbook_runs.get("case-real")).runs) == 1
        await state.runbook_library.create(_runbook("after-demo"))
    finally:
        await state.shutdown()


async def _seed_runs_and_library(state: AppState) -> None:
    await state.runbook_library.create(_runbook("kept-runbook", "published"))
    runs = state.runbook_runs
    await runs.mutate("case-1", _add(_run("case-1", "kept-runbook")))
    await runs.mutate("case-2", _add(_run("case-2", "kept-runbook")))
    await runs.upsert_ledger_row(_row("r1", datetime.now(timezone.utc)))


async def _assert_runs_cleared_library_kept(state: AppState, receipt: dict[str, Any]) -> None:
    assert "kv:runbook_runs:3" in receipt["cleared"], receipt
    assert not any(f.startswith("kv:runbook_runs") for f in receipt.get("failed", []))
    fresh = RunbookRunStore(state.kv)
    assert (await fresh.get("case-1")).runs == () and (await fresh.get("case-2")).runs == ()
    month = month_of(datetime.now(timezone.utc).isoformat())
    assert (await fresh.read_ledger([month]))[0].rows == ()
    record = await RunbookLibraryStore(state.kv).require("kept-runbook")
    assert record.runbook.live is not None


async def test_cases_reset_clears_runs_and_keeps_the_library_on_elasticsearch() -> None:
    state = _state()
    await state.startup(start_poller=False)
    try:
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await _seed_runs_and_library(state)
        receipt = await reset_service(state, "cases")
        await _assert_runs_cleared_library_kept(state, receipt)
    finally:
        await state.shutdown()


async def test_cases_reset_clears_runs_and_keeps_the_library_on_sql(tmp_path) -> None:
    state = _state(state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{tmp_path / 'state.db'}")
    await state.startup(start_poller=False)
    try:
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await _seed_runs_and_library(state)
        receipt = await reset_service(state, "cases")
        await _assert_runs_cleared_library_kept(state, receipt)
    finally:
        await state.shutdown()
