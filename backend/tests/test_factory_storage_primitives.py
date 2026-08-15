"""Fail-closed storage primitives used by the factory-reset privacy boundary."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.constants import (
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    CONFIG_DOC_ID,
    CONFIG_INDEX,
    JOBS_KEY,
    JOBS_NS,
)
from app.es.client import RealESClient
from app.es.fake import InMemoryESClient
from app.stores.memory import EsKVStore
from app.stores.sql import SqlKVStore, build_async_engine, create_all
from app.stores.sql.models import KVRow
from app.stores.update_operations import UPDATE_OPERATIONS_NS


class _HTTPError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status_code = status


def _real_client(mgmt: object) -> RealESClient:
    client = object.__new__(RealESClient)
    client._mgmt = mgmt
    client._ro = SimpleNamespace(
        delete=AsyncMock(side_effect=AssertionError("read-only client was used")),
        indices=SimpleNamespace(
            delete=AsyncMock(side_effect=AssertionError("read-only client was used"))
        ),
    )
    return client


@pytest.mark.asyncio
async def test_real_es_strict_deletes_use_only_mgmt_and_mask_only_404() -> None:
    mgmt = SimpleNamespace(
        delete=AsyncMock(return_value={"result": "deleted"}),
        indices=SimpleNamespace(delete=AsyncMock(return_value={"acknowledged": True})),
    )
    client = _real_client(mgmt)

    assert await client.delete_doc_strict(CONFIG_INDEX, "tenant:one", refresh=True) is True
    mgmt.delete.assert_awaited_once_with(index=CONFIG_INDEX, id="tenant:one", refresh=True)
    assert await client.delete_index_strict("tlsoc-agent-rag") is True
    mgmt.indices.delete.assert_awaited_once_with(index="tlsoc-agent-rag")

    mgmt.delete.side_effect = _HTTPError(404)
    mgmt.indices.delete.side_effect = _HTTPError(404)
    assert await client.delete_doc_strict(CONFIG_INDEX, "missing") is False
    assert await client.delete_index_strict("missing-index") is False

    mgmt.delete.side_effect = _HTTPError(503)
    mgmt.indices.delete.side_effect = _HTTPError(403)
    with pytest.raises(_HTTPError, match="503"):
        await client.delete_doc_strict(CONFIG_INDEX, "ambiguous")
    with pytest.raises(_HTTPError, match="403"):
        await client.delete_index_strict("forbidden")


@pytest.mark.asyncio
async def test_fake_es_strict_delete_distinguishes_absence() -> None:
    es = InMemoryESClient()
    await es.create_index("owned")
    await es.index_doc("owned", {"value": 1}, doc_id="one")

    assert await es.delete_doc_strict("owned", "one") is True
    assert await es.delete_doc_strict("owned", "one") is False
    assert await es.delete_index_strict("owned") is True
    assert await es.delete_index_strict("owned") is False


async def _seed_protected(kv: EsKVStore | SqlKVStore) -> dict[str, dict]:
    jobs = {
        "_rev": 9,
        "factory_fence": "factory-job",
        "jobs": {"factory-job": {"status": "running"}},
    }
    batch = {
        "_rev": 4,
        "factory_fence": "factory-job",
        "reset_epoch": 7,
        "jobs": {},
    }
    update = {
        "_rev": 2,
        "operation": "start",
        "request_fingerprint": "a" * 64,
    }
    put = getattr(kv, "put_strict", None) or kv.put
    await put(JOBS_NS, JOBS_KEY, jobs)
    await put(BATCH_JOBS_NS, BATCH_JOBS_KEY, batch)
    await put(UPDATE_OPERATIONS_NS, "release-hash", update)
    return {"jobs": jobs, "batch": batch, "update": update}


@pytest.mark.asyncio
async def test_es_factory_purge_scans_past_one_page_and_preserves_exact_anchors() -> None:
    es = InMemoryESClient()
    kv = EsKVStore(es)
    expected = await _seed_protected(kv)
    await es.index_doc(CONFIG_INDEX, {"setup_complete": True}, doc_id=CONFIG_DOC_ID, refresh=True)
    for number in range(507):
        await kv.put_strict(f"tenant_{number:03d}", "row", {"value": number, "_rev": 1})
    await kv.put_strict("case_seq:acme", "next", {"value": 8})
    await kv.put_strict("oidc_state:browser", "nonce", {"value": "secret"})

    assert await kv.factory_purge_strict() == 510
    assert await kv.get_strict(JOBS_NS, JOBS_KEY) == expected["jobs"]
    assert await kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY) == expected["batch"]
    assert await kv.get_strict(UPDATE_OPERATIONS_NS, "release-hash") == expected["update"]
    assert await es.get_doc_strict(CONFIG_INDEX, CONFIG_DOC_ID) is None
    snapshot = await kv._config_snapshot_strict()
    assert set(snapshot) == {
        EsKVStore._doc_id(JOBS_NS, JOBS_KEY),
        EsKVStore._doc_id(BATCH_JOBS_NS, BATCH_JOBS_KEY),
        EsKVStore._doc_id(UPDATE_OPERATIONS_NS, "release-hash"),
    }


class _FailingDeleteES(InMemoryESClient):
    fail_id = "tenant:blocked"

    async def delete_doc_strict(self, index: str, doc_id: str, refresh: bool = False) -> bool:
        if doc_id == self.fail_id:
            raise RuntimeError("injected management delete failure")
        return await super().delete_doc_strict(index, doc_id, refresh=refresh)


@pytest.mark.asyncio
async def test_es_factory_purge_propagates_delete_failure_and_keeps_fences() -> None:
    es = _FailingDeleteES()
    kv = EsKVStore(es)
    expected = await _seed_protected(kv)
    await kv.put_strict("tenant", "blocked", {"sensitive": True})

    with pytest.raises(RuntimeError, match="injected management delete failure"):
        await kv.factory_purge_strict()
    assert await kv.get_strict(JOBS_NS, JOBS_KEY) == expected["jobs"]
    assert await kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY) == expected["batch"]

    es.fail_id = ""
    assert await kv.factory_purge_strict() == 1
    assert await kv.get_strict("tenant", "blocked") is None


@pytest.mark.asyncio
async def test_factory_purge_rejects_missing_control_anchor_on_both_backends() -> None:
    es_kv = EsKVStore(InMemoryESClient())
    await es_kv.put_strict(JOBS_NS, JOBS_KEY, {"factory_fence": "factory-job"})
    await es_kv.put_strict("tenant", "row", {"sensitive": True})
    with pytest.raises(RuntimeError, match="Jobs and Batch"):
        await es_kv.factory_purge_strict()
    assert await es_kv.get_strict("tenant", "row") == {"sensitive": True}

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await create_all(engine)
        sql_kv = SqlKVStore(engine)
        await sql_kv.put(JOBS_NS, JOBS_KEY, {"factory_fence": "factory-job"})
        await sql_kv.put("tenant", "row", {"sensitive": True})
        with pytest.raises(RuntimeError, match="Jobs and Batch"):
            await sql_kv.factory_purge_strict()
        assert await sql_kv.get("tenant", "row") == {"sensitive": True}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_sql_factory_purge_is_one_verified_transaction() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await create_all(engine)
        kv = SqlKVStore(engine)
        expected = await _seed_protected(kv)
        await kv.put("config", "preferences", {"setup_complete": True})
        await kv.put("tenant", "one", {"value": 1})
        await kv.put("tenant", "two", {"value": 2})

        assert await kv.factory_purge_strict() == 3
        assert await kv.get(JOBS_NS, JOBS_KEY) == expected["jobs"]
        assert await kv.get(BATCH_JOBS_NS, BATCH_JOBS_KEY) == expected["batch"]
        assert await kv.get(UPDATE_OPERATIONS_NS, "release-hash") == expected["update"]
        async with engine.connect() as connection:
            rows = (await connection.execute(select(KVRow))).scalars().all()
        assert len(rows) == 3
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_sql_factory_purge_rolls_back_when_any_delete_fails() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        await create_all(engine)
        kv = SqlKVStore(engine)
        expected = await _seed_protected(kv)
        await kv.put("tenant", "blocked", {"sensitive": True})
        await kv.put("tenant", "other", {"sensitive": "also"})
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "CREATE TRIGGER fail_factory_purge BEFORE DELETE ON kv "
                    "WHEN OLD.namespace = 'tenant' AND OLD.key = 'blocked' "
                    "BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END"
                )
            )

        with pytest.raises(DBAPIError, match="injected delete failure"):
            await kv.factory_purge_strict()
        assert await kv.get(JOBS_NS, JOBS_KEY) == expected["jobs"]
        assert await kv.get(BATCH_JOBS_NS, BATCH_JOBS_KEY) == expected["batch"]
        assert await kv.get("tenant", "blocked") == {"sensitive": True}
        assert await kv.get("tenant", "other") == {"sensitive": "also"}
    finally:
        await engine.dispose()
