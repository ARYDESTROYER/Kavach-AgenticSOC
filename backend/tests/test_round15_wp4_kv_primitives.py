"""Round 15 WP4 (SPEC D5.2, D5.8): ``delete_strict`` on both KV backends, and a
factory purge that never loads a tenant document's value into memory.

The purge fakes below FAIL on a full-source read of any document that is not one of
the protected control anchors (the Jobs and Batch fences and update operations), so
a census that materialised every value (the pre-Round-15 behaviour, which would hold
every screenshot in memory twice) cannot pass.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from app.constants import BATCH_JOBS_KEY, BATCH_JOBS_NS, CONFIG_INDEX, JOBS_KEY, JOBS_NS
from app.es.fake import InMemoryESClient
from app.stores.memory import EsKVStore
from app.stores.sql import SqlKVStore, build_async_engine, create_all
from app.stores.update_operations import UPDATE_OPERATIONS_NS
from tests.test_factory_storage_primitives import _HTTPError, _real_client, _seed_protected

BIG = "x" * 200_000
MARKER = "never-load-this-value"


@pytest.mark.asyncio
async def test_es_delete_strict_distinguishes_absence_and_propagates_failures() -> None:
    kv = EsKVStore(InMemoryESClient())
    await kv.put_strict("case_files", "blob:1", {"case_file_data": "AAAA", "_rev": 1})
    assert await kv.delete_strict("case_files", "blob:1") is True
    assert await kv.get_strict("case_files", "blob:1") is None
    assert await kv.delete_strict("case_files", "blob:1") is False

    mgmt = type("Mgmt", (), {})()
    mgmt.delete = AsyncMock(side_effect=_HTTPError(503))
    real = EsKVStore(_real_client(mgmt))
    with pytest.raises(_HTTPError, match="503"):
        await real.delete_strict("case_files", "blob:1")
    mgmt.delete.assert_awaited_once_with(index=CONFIG_INDEX, id="case_files:blob:1", refresh=True)


@pytest.mark.asyncio
async def test_sql_delete_strict_distinguishes_absence() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await create_all(engine)
        kv = SqlKVStore(engine)
        await kv.put("case_files", "blob:1", {"_rev": 1})
        await kv.put("case_files", "blob:2", {"_rev": 1})
        assert await kv.delete_strict("case_files", "blob:1") is True
        assert await kv.get("case_files", "blob:1") is None
        assert await kv.get("case_files", "blob:2") == {"_rev": 1}
        assert await kv.delete_strict("case_files", "blob:1") is False
    finally:
        await engine.dispose()


class _NoFullReadES(InMemoryESClient):
    """Fails on any search that returns sources and on any strict read of a document
    that is not a protected control anchor."""

    protected_prefixes = (f"{JOBS_NS}:", f"{BATCH_JOBS_NS}:", f"{UPDATE_OPERATIONS_NS}:")
    full_reads: list[str]

    def __init__(self) -> None:
        super().__init__()
        self.full_reads = []

    def _protected(self, doc_id: str) -> bool:
        return doc_id.startswith(self.protected_prefixes) or doc_id in {
            EsKVStore._doc_id(JOBS_NS, JOBS_KEY), EsKVStore._doc_id(BATCH_JOBS_NS, BATCH_JOBS_KEY),
        }

    async def search(self, index, body):
        if index == CONFIG_INDEX and body.get("_source") is not False:
            raise AssertionError("factory purge read every config document's source")
        return await super().search(index, body)

    async def get_doc_strict(self, index, doc_id):
        if index == CONFIG_INDEX and not self._protected(doc_id):
            self.full_reads.append(doc_id)
            raise AssertionError(f"factory purge read {doc_id!r}")
        return await super().get_doc_strict(index, doc_id)

    async def get_doc(self, index, doc_id):
        if index == CONFIG_INDEX and not self._protected(doc_id):
            raise AssertionError(f"factory purge read {doc_id!r}")
        return await super().get_doc(index, doc_id)


@pytest.mark.asyncio
async def test_es_factory_purge_reads_ids_and_protected_documents_only() -> None:
    es = _NoFullReadES()
    kv = EsKVStore(es)
    expected = await _seed_protected(kv)
    for n in range(3):
        await kv.put_strict("case_files", f"blob:{n:032x}",
                            {"case_file_store": "case_files", "case_file_data": BIG, "_rev": 1})
    await kv.put_strict("tenant", "row", {"value": MARKER})

    assert await kv.factory_purge_strict() == 4
    assert es.full_reads == []
    assert await kv.get_strict(JOBS_NS, JOBS_KEY) == expected["jobs"]
    assert await kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY) == expected["batch"]
    assert await kv.get_strict(UPDATE_OPERATIONS_NS, "release-hash") == expected["update"]
    assert await kv._config_ids_strict() == {
        EsKVStore._doc_id(JOBS_NS, JOBS_KEY),
        EsKVStore._doc_id(BATCH_JOBS_NS, BATCH_JOBS_KEY),
        EsKVStore._doc_id(UPDATE_OPERATIONS_NS, "release-hash"),
    }


@pytest.mark.asyncio
async def test_es_purge_fake_really_fails_on_a_full_scan() -> None:
    """Sanity of the guard above: a full-source scan of the config index fails."""
    es = _NoFullReadES()
    with pytest.raises(AssertionError, match="source"):
        await es.search(CONFIG_INDEX, {"query": {"match_all": {}}})


@pytest.mark.asyncio
async def test_es_factory_purge_detects_a_changed_protected_document() -> None:
    class _Changing(InMemoryESClient):
        async def delete_doc_strict(self, index, doc_id, refresh=False):
            jobs = EsKVStore._doc_id(JOBS_NS, JOBS_KEY)
            bucket = self.docs[self._resolve(index)]
            bucket[jobs] = {**bucket[jobs], "tampered": True}
            return await super().delete_doc_strict(index, doc_id, refresh=refresh)

    kv = EsKVStore(_Changing())
    await _seed_protected(kv)
    await kv.put_strict("tenant", "row", {"value": 1})
    with pytest.raises(RuntimeError, match="changed=1"):
        await kv.factory_purge_strict()


@pytest.mark.asyncio
async def test_sql_factory_purge_never_loads_a_tenant_value() -> None:
    loaded: list[str] = []

    def deserialize(text: str):
        if MARKER in text:
            loaded.append(text[:40])
            raise AssertionError("factory purge loaded a tenant value")
        return json.loads(text)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", json_deserializer=deserialize)
    try:
        await create_all(engine)
        kv = SqlKVStore(engine)
        expected = await _seed_protected(kv)
        await kv.put("case_files", "blob:1", {"case_file_data": MARKER + BIG, "_rev": 1})
        await kv.put("tenant", "row", {"value": MARKER})
        assert await kv.factory_purge_strict() == 2
        assert loaded == []
        assert await kv.get(JOBS_NS, JOBS_KEY) == expected["jobs"]
        assert await kv.get(BATCH_JOBS_NS, BATCH_JOBS_KEY) == expected["batch"]
        assert await kv.get(UPDATE_OPERATIONS_NS, "release-hash") == expected["update"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_sql_purge_guard_really_fails_on_a_value_read() -> None:
    def deserialize(text: str):
        if MARKER in text:
            raise AssertionError("loaded")
        return json.loads(text)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", json_deserializer=deserialize)
    try:
        await create_all(engine)
        kv = SqlKVStore(engine)
        await kv.put("tenant", "row", {"value": MARKER})
        with pytest.raises(AssertionError, match="loaded"):
            await kv.get("tenant", "row")
    finally:
        await engine.dispose()
