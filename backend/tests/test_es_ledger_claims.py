"""Lifetime idempotency regressions for rolling ES audit/usage ledgers."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.audit.audit_log import AuditLogger
from app.constants import (
    AUDIT_INDEX,
    AUDIT_READ_PATTERN,
    AUDIT_WRITE_ALIAS,
    CONFIG_INDEX,
    USAGE_INDEX,
    USAGE_READ_PATTERN,
    USAGE_WRITE_ALIAS,
    ActionType,
)
from app.engine.reset import _reset_audit
from app.es.fake import InMemoryESClient
from app.models import AuditDoc, UsageDoc
from app.stores.ledger_claims import ledger_claim_doc_id
from app.stores.sql import SqlAuditRepository, build_async_engine, create_all
from app.stores.sql.models import AuditRow
from app.stores.usage import UsageStore


class _FailProjectionOnceES(InMemoryESClient):
    """Leave a durable pending claim on the first rolling-ledger append."""

    def __init__(self, target_alias: str) -> None:
        super().__init__()
        self._target_alias = target_alias
        self.failed = False

    async def create_doc_strict(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> bool:
        if index == self._target_alias and not self.failed:
            self.failed = True
            raise RuntimeError("injected projection interruption")
        return await super().create_doc_strict(index, doc_id, doc, refresh)


class _ClaimBarrierES(InMemoryESClient):
    """Release two first writers only after both reached atomic claim creation."""

    def __init__(self) -> None:
        super().__init__()
        self._arrivals = 0
        self._release = asyncio.Event()

    async def create_doc_strict(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> bool:
        if index == CONFIG_INDEX and doc.get("ledger_claim_kind") == "ledger_claim":
            self._arrivals += 1
            if self._arrivals >= 2:
                self._release.set()
            await asyncio.wait_for(self._release.wait(), timeout=2)
        return await super().create_doc_strict(index, doc_id, doc, refresh)


class _BlockClaimFinaliseES(InMemoryESClient):
    """Model a row append that succeeds before claim finalisation is interrupted."""

    def __init__(self) -> None:
        super().__init__()
        self.block_finalise = True

    async def compare_and_set_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        expected_rev: int,
        refresh: bool = False,
    ) -> bool:
        if (
            index == CONFIG_INDEX
            and self.block_finalise
            and doc.get("ledger_claim_state") == "committed"
        ):
            return False
        return await super().compare_and_set_doc(
            index, doc_id, doc, expected_rev, refresh
        )


class _PausedRolloverProjectionES(InMemoryESClient):
    """Pause the owner, then roll again immediately after its single projection."""

    def __init__(self) -> None:
        super().__init__()
        self.projection_entered = asyncio.Event()
        self.release_projection = asyncio.Event()
        self.projection_calls = 0

    async def create_doc_strict(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> bool:
        if index == USAGE_WRITE_ALIAS:
            self.projection_calls += 1
            if self.projection_calls == 1:
                self.projection_entered.set()
                await asyncio.wait_for(self.release_projection.wait(), timeout=2)
                created = await super().create_doc_strict(
                    index, doc_id, doc, refresh
                )
                _rollover(self, USAGE_INDEX, generation=3)
                return created
        return await super().create_doc_strict(index, doc_id, doc, refresh)


def _rollover(es: InMemoryESClient, base: str, generation: int = 2) -> str:
    backing = f"{base}-{generation:06d}"
    es.docs.setdefault(backing, {})
    es.alias_to_index[base] = backing
    return backing


async def _hits_for_id(
    es: InMemoryESClient, pattern: str, logical_id: str
) -> list[dict[str, Any]]:
    response = await es.search(
        pattern,
        {"size": 10, "query": {"ids": {"values": [logical_id]}}, "track_total_hits": True},
    )
    return response["hits"]["hits"]


async def test_pending_audit_claim_recovers_projection_and_first_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    es = _FailProjectionOnceES(AUDIT_WRITE_ALIAS)
    audit = AuditLogger(es)
    logical_id = "proposal-decision:pending:approve"
    first = AuditDoc(
        event_id=logical_id,
        ts="2026-08-11T01:00:00+00:00",
        action_type=ActionType.PROPOSAL,
        case_id="case-pending",
        result_summary="approved",
    )

    monkeypatch.setenv("TLSOC_BUILD_SHA", "first-build")
    with pytest.raises(RuntimeError, match="injected projection interruption"):
        await audit.write_strict(first)

    claim_id = ledger_claim_doc_id("audit", logical_id)
    pending = await es.get_doc(CONFIG_INDEX, claim_id)
    assert pending is not None and pending["ledger_claim_state"] == "pending"
    assert pending["ledger_projection_owner"] is None
    assert pending["ledger_projection_lease_until"] == 0.0
    assert await _hits_for_id(es, AUDIT_READ_PATTERN, logical_id) == []

    monkeypatch.setenv("TLSOC_BUILD_SHA", "retry-build")
    await audit.write_strict(
        first.model_copy(update={"ts": "2026-08-11T01:00:09+00:00"})
    )

    hits = await _hits_for_id(es, AUDIT_READ_PATTERN, logical_id)
    assert len(hits) == 1
    assert hits[0]["_source"]["ts"] == "2026-08-11T01:00:00+00:00"
    assert hits[0]["_source"]["build_sha"] == "first-build"
    committed = await es.get_doc(CONFIG_INDEX, claim_id)
    assert committed is not None
    assert committed["ledger_claim_state"] == "committed"
    assert committed["ledger_projection_index"] == hits[0]["_index"]
    assert committed["_rev"] >= 1


async def test_pending_claim_with_existing_projection_finalises_without_duplicate() -> None:
    es = _BlockClaimFinaliseES()
    usage = UsageStore(es)
    key = "batch:pending-finalise:result"
    first = UsageDoc(
        idempotency_key=key,
        app_version="0.1.13",
        build_sha="first-build",
        ts="2026-08-11T01:30:00+00:00",
        role="investigator",
        model="model-first",
        total_tokens=7,
    )

    with pytest.raises(RuntimeError, match="claim could not be finalised"):
        await usage.write_strict(first)
    assert len(await _hits_for_id(es, USAGE_READ_PATTERN, key)) == 1
    claim_id = ledger_claim_doc_id("usage", key)
    pending = await es.get_doc(CONFIG_INDEX, claim_id)
    assert pending is not None and pending["ledger_claim_state"] == "pending"

    es.block_finalise = False
    await usage.write_strict(
        first.model_copy(
            update={
                "build_sha": "retry-build",
                "ts": "2026-08-11T01:30:09+00:00",
                "model": "model-retry",
                "total_tokens": 999,
            }
        )
    )

    hits = await _hits_for_id(es, USAGE_READ_PATTERN, key)
    assert len(hits) == 1
    assert hits[0]["_source"] == first.model_dump(mode="json")
    committed = await es.get_doc(CONFIG_INDEX, claim_id)
    assert committed is not None and committed["ledger_claim_state"] == "committed"


async def test_usage_retry_adopts_legacy_row_across_rollover_without_backfill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    es = InMemoryESClient()
    key = "batch:legacy-model:result"
    legacy = UsageDoc(
        idempotency_key=key,
        ts="2026-08-10T00:00:00+00:00",
        surface="batch",
        role="investigator",
        model="model-before-rollover",
        total_tokens=11,
        cost=0.11,
    ).model_dump(mode="json", exclude={"app_version", "build_sha"})
    await es.index_doc(USAGE_WRITE_ALIAS, legacy, doc_id=key, refresh=True)
    old_backing = es.alias_to_index[USAGE_WRITE_ALIAS]
    new_backing = _rollover(es, USAGE_INDEX)

    monkeypatch.setenv("TLSOC_BUILD_SHA", "new-build")
    await UsageStore(es).write_strict(
        UsageDoc(
            idempotency_key=key,
            ts="2026-08-11T00:00:00+00:00",
            surface="batch",
            role="investigator",
            model="model-after-rollover",
            total_tokens=999,
            cost=99.0,
        )
    )

    hits = await _hits_for_id(es, USAGE_READ_PATTERN, key)
    assert len(hits) == 1
    assert hits[0]["_index"] == old_backing
    assert hits[0]["_source"] == legacy
    assert key not in es.docs[new_backing]
    claim = await es.get_doc(CONFIG_INDEX, ledger_claim_doc_id("usage", key))
    assert claim is not None and claim["ledger_claim_state"] == "committed"


async def test_committed_claim_rebuilds_missing_projection_and_clears_recovery_lease() -> None:
    es = _FailProjectionOnceES(USAGE_WRITE_ALIAS)
    es.failed = True
    store = UsageStore(es)
    key = "batch:committed-rebuild:result"
    first = UsageDoc(
        idempotency_key=key,
        app_version="0.1.13",
        build_sha="origin-build",
        model="origin-model",
        total_tokens=12,
    )
    await store.write_strict(first)
    old_backing = es.alias_to_index[USAGE_WRITE_ALIAS]
    claim_id = ledger_claim_doc_id("usage", key)
    original_claim = await es.get_doc(CONFIG_INDEX, claim_id)
    assert original_claim is not None
    assert original_claim["ledger_claim_state"] == "committed"
    assert original_claim["ledger_projection_index"] == old_backing

    await es.delete_index(old_backing)
    current_backing = _rollover(es, USAGE_INDEX, generation=2)
    assert await _hits_for_id(es, USAGE_READ_PATTERN, key) == []

    es.failed = False
    with pytest.raises(RuntimeError, match="injected projection interruption"):
        await store.write_strict(
            first.model_copy(
                update={"build_sha": "failed-recovery", "model": "failed-model"}
            )
        )
    released_claim = await es.get_doc(CONFIG_INDEX, claim_id)
    assert released_claim is not None
    assert released_claim["ledger_claim_state"] == "committed"
    assert released_claim["ledger_projection_owner"] is None
    assert released_claim["ledger_projection_lease_until"] == 0.0

    await store.write_strict(
        first.model_copy(update={"build_sha": "recovery-build", "model": "retry-model"})
    )

    hits = await _hits_for_id(es, USAGE_READ_PATTERN, key)
    assert len(hits) == 1
    assert hits[0]["_index"] == current_backing
    assert hits[0]["_source"] == first.model_dump(mode="json")
    rebuilt_claim = await es.get_doc(CONFIG_INDEX, claim_id)
    assert rebuilt_claim is not None
    assert rebuilt_claim["ledger_claim_state"] == "committed"
    assert rebuilt_claim["ledger_projection_index"] == current_backing
    assert rebuilt_claim["ledger_projection_owner"] is None
    assert rebuilt_claim["ledger_projection_lease_until"] == 0.0


async def test_concurrent_usage_writers_keep_one_complete_first_payload() -> None:
    es = _ClaimBarrierES()
    store = UsageStore(es)
    key = "batch:concurrent:result"
    candidates = [
        UsageDoc(
            idempotency_key=key,
            app_version="0.1.13",
            build_sha="build-a",
            ts="2026-08-11T02:00:00+00:00",
            surface="batch",
            role="investigator",
            model="model-a",
            total_tokens=10,
            cost=0.1,
        ),
        UsageDoc(
            idempotency_key=key,
            app_version="0.1.13",
            build_sha="build-b",
            ts="2026-08-11T02:00:01+00:00",
            surface="batch",
            role="investigator",
            model="model-b",
            total_tokens=20,
            cost=0.2,
        ),
    ]

    await asyncio.gather(*(store.write_strict(doc) for doc in candidates))

    hits = await _hits_for_id(es, USAGE_READ_PATTERN, key)
    assert len(hits) == 1
    row = hits[0]["_source"]
    assert row in [doc.model_dump(mode="json") for doc in candidates]
    assert (row["model"], row["build_sha"], row["total_tokens"], row["cost"]) in {
        ("model-a", "build-a", 10, 0.1),
        ("model-b", "build-b", 20, 0.2),
    }


async def test_projection_lease_prevents_rollover_between_concurrent_creates() -> None:
    es = _PausedRolloverProjectionES()
    store = UsageStore(es)
    key = "batch:lease-rollover:result"
    first = UsageDoc(
        idempotency_key=key,
        app_version="0.1.13",
        build_sha="owner-build",
        model="owner-model",
        total_tokens=10,
    )
    retry = first.model_copy(
        update={"build_sha": "retry-build", "model": "retry-model", "total_tokens": 99}
    )

    owner = asyncio.create_task(store.write_strict(first))
    await asyncio.wait_for(es.projection_entered.wait(), timeout=2)
    # Move the write alias while the sole owner is paused. Its append lands in 000002;
    # the fake rolls immediately to 000003 after that append. A second unfenced create
    # would therefore produce the exact cross-backing duplicate this claim lease bars.
    second_backing = _rollover(es, USAGE_INDEX, generation=2)
    follower = asyncio.create_task(store.write_strict(retry))
    await asyncio.sleep(0.03)
    assert not follower.done()

    es.release_projection.set()
    await asyncio.gather(owner, follower)

    hits = await _hits_for_id(es, USAGE_READ_PATTERN, key)
    assert es.projection_calls == 1
    assert len(hits) == 1
    assert hits[0]["_index"] == second_backing
    assert hits[0]["_source"]["build_sha"] == "owner-build"
    assert key not in es.docs[f"{USAGE_INDEX}-000003"]


async def test_expired_hard_crash_lease_is_recovered() -> None:
    es = _PausedRolloverProjectionES()
    store = UsageStore(es)
    key = "batch:expired-lease:result"
    first = UsageDoc(
        idempotency_key=key,
        app_version="0.1.13",
        build_sha="crashed-build",
        model="model-first",
        total_tokens=10,
    )

    crashed = asyncio.create_task(store.write_strict(first))
    await asyncio.wait_for(es.projection_entered.wait(), timeout=2)
    crashed.cancel()
    with pytest.raises(asyncio.CancelledError):
        await crashed

    claim_id = ledger_claim_doc_id("usage", key)
    pending = await es.get_doc(CONFIG_INDEX, claim_id)
    assert pending is not None
    assert pending["ledger_claim_state"] == "pending"
    assert pending["ledger_projection_owner"]
    # Model passage of the bounded crash lease without making the test sleep.
    pending["ledger_projection_lease_until"] = 0.0

    await store.write_strict(
        first.model_copy(update={"build_sha": "recovery-build", "model": "retry-model"})
    )

    hits = await _hits_for_id(es, USAGE_READ_PATTERN, key)
    assert len(hits) == 1
    assert hits[0]["_source"]["build_sha"] == "crashed-build"
    committed = await es.get_doc(CONFIG_INDEX, claim_id)
    assert committed is not None
    assert committed["ledger_claim_state"] == "committed"


async def test_concurrent_conflicting_audit_ids_fail_closed() -> None:
    es = _ClaimBarrierES()
    audit = AuditLogger(es)
    logical_id = "proposal-decision:concurrent:approve"
    candidates = [
        AuditDoc(
            event_id=logical_id,
            app_version="0.1.13",
            build_sha="build-a",
            ts="2026-08-11T03:00:00+00:00",
            action_type=ActionType.PROPOSAL,
            case_id="case-concurrent",
            result_summary="approved-a",
        ),
        AuditDoc(
            event_id=logical_id,
            app_version="0.1.13",
            build_sha="build-b",
            ts="2026-08-11T03:00:01+00:00",
            action_type=ActionType.PROPOSAL,
            case_id="case-concurrent",
            result_summary="approved-b",
        ),
    ]

    results = await asyncio.gather(
        *(audit.write_strict(doc) for doc in candidates), return_exceptions=True
    )

    failures = [result for result in results if isinstance(result, Exception)]
    assert len(failures) == 1
    assert "audit event id collision" in str(failures[0])
    hits = await _hits_for_id(es, AUDIT_READ_PATTERN, logical_id)
    assert len(hits) == 1
    assert hits[0]["_source"]["result_summary"] in {"approved-a", "approved-b"}


async def test_duplicate_id_across_rollover_indices_fails_closed() -> None:
    es = InMemoryESClient()
    key = "batch:already-duplicated:result"
    first = UsageDoc(idempotency_key=key, model="first").model_dump(mode="json")
    second = UsageDoc(idempotency_key=key, model="second").model_dump(mode="json")
    await es.index_doc(USAGE_WRITE_ALIAS, first, doc_id=key, refresh=True)
    new_backing = _rollover(es, USAGE_INDEX)
    es.docs[new_backing][key] = second

    with pytest.raises(RuntimeError, match="multiple rollover indices"):
        await UsageStore(es).write_strict(UsageDoc(idempotency_key=key, model="third"))


async def test_factory_audit_reset_clears_rollovers_and_stable_claims() -> None:
    es = InMemoryESClient()
    audit = AuditLogger(es)
    logical_id = "proposal-decision:factory-reset:approve"
    first = AuditDoc(
        event_id=logical_id,
        action_type=ActionType.PROPOSAL,
        case_id="case-reset",
        result_summary="before-reset",
    )
    await audit.write_strict(first)
    old_backing = es.alias_to_index[AUDIT_WRITE_ALIAS]
    _rollover(es, AUDIT_INDEX)
    await audit.write_strict(
        AuditDoc(action_type=ActionType.POLL, case_id="case-reset", actor="poller")
    )
    assert old_backing in es.docs
    claim_id = ledger_claim_doc_id("audit", logical_id)
    assert await es.get_doc(CONFIG_INDEX, claim_id) is not None

    assert await _reset_audit(SimpleNamespace(es=es)) is True

    assert await es.get_doc(CONFIG_INDEX, claim_id) is None
    assert await es.search(AUDIT_READ_PATTERN, {"query": {"match_all": {}}, "size": 10}) == {
        "hits": {"total": {"value": 0, "relation": "eq"}, "hits": []}
    }

    # The same deterministic id now belongs to a genuinely new post-reset event;
    # stale claim payload must not resurrect or reject it.
    await audit.write_strict(
        first.model_copy(update={"result_summary": "after-reset"})
    )
    hits = await _hits_for_id(es, AUDIT_READ_PATTERN, logical_id)
    assert len(hits) == 1
    assert hits[0]["_source"]["result_summary"] == "after-reset"


async def test_es_records_for_case_keeps_latest_500_in_oldest_first_order() -> None:
    es = InMemoryESClient()
    base = datetime(2026, 8, 11, tzinfo=UTC)
    for position in range(510):
        ts = (base + timedelta(seconds=position)).isoformat()
        await es.index_doc(
            AUDIT_WRITE_ALIAS,
            {
                "ts": ts,
                "case_id": "case-history",
                "action_type": ActionType.POLL.value,
                "result_summary": f"row-{position}",
            },
        )

    rows = await AuditLogger(es).records_for_case("case-history", limit=999)

    assert len(rows) == 500
    assert rows[0]["result_summary"] == "row-10"
    assert rows[-1]["result_summary"] == "row-509"


async def test_sql_records_for_case_keeps_latest_500_in_oldest_first_order() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        base = datetime(2026, 8, 11, tzinfo=UTC)
        rows = []
        for position in range(510):
            ts = (base + timedelta(seconds=position)).isoformat()
            payload = {
                "ts": ts,
                "case_id": "case-history",
                "action_type": ActionType.POLL.value,
                "result_summary": f"row-{position}",
            }
            rows.append(
                AuditRow(
                    ts=ts,
                    case_id="case-history",
                    action_type=ActionType.POLL.value,
                    doc=payload,
                )
            )
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        async with sessionmaker() as session, session.begin():
            session.add_all(rows)

        history = await SqlAuditRepository(engine).records_for_case(
            "case-history", limit=999
        )
        assert len(history) == 500
        assert history[0]["result_summary"] == "row-10"
        assert history[-1]["result_summary"] == "row-509"
    finally:
        await engine.dispose()
