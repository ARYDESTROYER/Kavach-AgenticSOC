"""Epoch A — SQL StateStore tests (offline, SQLite-only).

Asserts the SQL-backed OWN-state repositories reproduce the SAME behaviours as
the Elasticsearch stores: Case round-trip + filtered/paged listing +
find_open_by_signature + count_new_scans; append-only audit + ordered search;
usage record + windowed summary; KV config/cursor round-trip; and the
SqlVectorStore cosine ordering + dim-mismatch guard.

Everything runs on ``sqlite+aiosqlite`` — no postgres/asyncpg required.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from app import __version__
from app.config import Preferences
from app.constants import ActionType, CaseStatus, EntityType, SourceSurface, Verdict
from app.models import AuditDoc, BatchJob, Case, Cursor, Entity, EvidenceItem, UsageDoc
from app.stores.batch_jobs import BatchJobStore
from app.stores.sql import (
    SqlAuditRepository,
    SqlCaseRepository,
    SqlConfigStore,
    SqlCursorStore,
    SqlKVStore,
    SqlUsageRepository,
    SqlVectorStore,
    build_async_engine,
    create_all,
)
from app.stores.sql.models import AuditRow, CaseRow
from app.tools.vectorstore import EmbeddingSpaceMismatch, StoredChunk
from app.utils import iso_now, now_utc, to_millis


@pytest_asyncio.fixture
async def engine():
    """A fresh in-memory SQLite engine with the state schema created."""
    # A file-less shared in-memory DB scoped to this engine instance.
    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    yield eng
    await eng.dispose()


def _case(
    *,
    case_id: str,
    signature: str,
    status: CaseStatus = CaseStatus.OPEN,
    surface: SourceSurface = SourceSurface.INVESTIGATE,
    ip: str = "203.0.113.10",
    created_at: str | None = None,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=signature,
        source_surface=surface,
        status=status,
        entity=Entity(type=EntityType.IP, value=ip),
        created_at=created_at or iso_now(),
        updated_at=created_at or iso_now(),
    )


# --------------------------------------------------------------------------- #
# Cases
# --------------------------------------------------------------------------- #
async def test_case_round_trip(engine) -> None:
    repo = SqlCaseRepository(engine)
    c = _case(case_id="c1", signature="sig-1")
    c.verdict = Verdict.TRUE_POSITIVE
    c.evidence = [EvidenceItem(summary="brute force", event_ids=["e1", "e2"])]
    await repo.save(c)

    got = await repo.get("c1")
    assert got is not None
    assert got.case_id == "c1"
    assert got.cluster_signature == "sig-1"
    assert got.verdict == Verdict.TRUE_POSITIVE
    assert got.evidence[0].summary == "brute force"
    assert await repo.get("missing") is None


async def test_case_insert_fallback_stamps_new_but_not_legacy_updates(
    engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Repository fallback stamps inserts without inventing history on updates."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    repo = SqlCaseRepository(engine)
    monkeypatch.setenv("TLSOC_BUILD_SHA", "sql-create-build")

    fresh = _case(case_id="fresh-direct", signature="fresh-direct-signature")
    assert fresh.app_version is None and fresh.build_sha is None
    await repo.save(fresh)
    stored_fresh = await repo.get(fresh.case_id)
    assert stored_fresh is not None
    assert stored_fresh.app_version == __version__
    assert stored_fresh.build_sha == "sql-create-build"
    # The fallback works on an immutable copy; it does not silently rewrite callers.
    assert fresh.app_version is None and fresh.build_sha is None
    monkeypatch.setenv("TLSOC_BUILD_SHA", "later-update-build")
    await repo.save(fresh.model_copy(update={"status": CaseStatus.CLOSED}))
    updated_fresh = await repo.get(fresh.case_id)
    assert updated_fresh is not None
    assert updated_fresh.status == CaseStatus.CLOSED
    assert updated_fresh.app_version == __version__
    assert updated_fresh.build_sha == "sql-create-build"

    await repo.save(
        updated_fresh.model_copy(
            update={"app_version": "forged", "build_sha": "forged"}
        )
    )
    protected_fresh = await repo.get(fresh.case_id)
    assert protected_fresh is not None
    assert protected_fresh.app_version == __version__
    assert protected_fresh.build_sha == "sql-create-build"

    legacy = _case(case_id="legacy-direct", signature="legacy-direct-signature")
    legacy_doc = legacy.model_dump(mode="json")
    legacy_doc.pop("app_version", None)
    legacy_doc.pop("build_sha", None)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session:
        session.add(
            CaseRow(
                case_id=legacy.case_id,
                cluster_signature=legacy.cluster_signature,
                status=legacy.status.value,
                source_surface=legacy.source_surface.value,
                entity_value=legacy.entity.value,
                created_at=legacy.created_at,
                updated_at=legacy.updated_at,
                doc=legacy_doc,
            )
        )
        await session.commit()

    loaded_legacy = await repo.get(legacy.case_id)
    assert loaded_legacy is not None
    assert loaded_legacy.app_version is None and loaded_legacy.build_sha is None
    await repo.save(loaded_legacy.model_copy(update={"status": CaseStatus.CLOSED}))

    updated_legacy = await repo.get(legacy.case_id)
    assert updated_legacy is not None
    assert updated_legacy.status == CaseStatus.CLOSED
    assert updated_legacy.app_version is None
    assert updated_legacy.build_sha is None


async def test_case_save_is_idempotent_overwrite(engine) -> None:
    repo = SqlCaseRepository(engine)
    await repo.save(_case(case_id="c1", signature="sig-1", status=CaseStatus.OPEN))
    await repo.save(_case(case_id="c1", signature="sig-1", status=CaseStatus.CLOSED))
    got = await repo.get("c1")
    assert got is not None and got.status == CaseStatus.CLOSED
    _cases, total = await repo.list()
    assert total == 1  # overwrite, not duplicate


async def test_case_list_filters_and_total(engine) -> None:
    repo = SqlCaseRepository(engine)
    await repo.save(_case(case_id="c1", signature="s1", status=CaseStatus.OPEN, ip="1.1.1.1"))
    await repo.save(_case(case_id="c2", signature="s2", status=CaseStatus.CLOSED, ip="2.2.2.2"))
    await repo.save(
        _case(case_id="c3", signature="s3", status=CaseStatus.OPEN,
              surface=SourceSurface.AUTOMATED_SCAN, ip="1.1.1.1")
    )

    open_cases, total_open = await repo.list(status=CaseStatus.OPEN.value)
    assert total_open == 2
    assert {c.case_id for c in open_cases} == {"c1", "c3"}

    scans, total_scans = await repo.list(source_surface=SourceSurface.AUTOMATED_SCAN.value)
    assert total_scans == 1 and scans[0].case_id == "c3"

    by_entity, total_entity = await repo.list(entity_value="1.1.1.1")
    assert total_entity == 2 and {c.case_id for c in by_entity} == {"c1", "c3"}

    # Pagination: limit/offset shrink the page but total reflects the full match.
    page, total = await repo.list(status=CaseStatus.OPEN.value, limit=1, offset=0)
    assert total == 2 and len(page) == 1


async def test_case_list_sort_order(engine) -> None:
    repo = SqlCaseRepository(engine)
    await repo.save(_case(case_id="old", signature="s1", created_at="2026-01-01T00:00:00+00:00"))
    await repo.save(_case(case_id="new", signature="s2", created_at="2026-06-01T00:00:00+00:00"))
    desc, _ = await repo.list(sort_field="created_at", sort_order="desc")
    assert [c.case_id for c in desc] == ["new", "old"]
    asc, _ = await repo.list(sort_field="created_at", sort_order="asc")
    assert [c.case_id for c in asc] == ["old", "new"]


async def test_case_list_sort_by_risk_score(engine) -> None:
    # BUG #13 regression: risk_score is NOT a materialised column (it lives in the JSON
    # doc), so the old getattr(CaseRow, 'risk_score') returned None and the sort
    # SILENTLY fell back to created_at. Prove the SQL repo now orders by the numeric
    # risk value — and that ordering is NUMERIC (10 > 2), not lexicographic.
    repo = SqlCaseRepository(engine)

    def _risk_case(cid: str, risk: float, created: str) -> Case:
        c = _case(case_id=cid, signature=f"sig-{cid}", created_at=created)
        return c.model_copy(update={"risk_score": risk})

    # created_at order (low..high): b (oldest) → a → c (newest). risk order differs, and
    # a lexicographic "2" vs "10" would wrongly rank "2" above "10".
    await repo.save(_risk_case("a", 2.0, "2026-02-01T00:00:00+00:00"))
    await repo.save(_risk_case("b", 10.0, "2026-01-01T00:00:00+00:00"))
    await repo.save(_risk_case("c", 5.0, "2026-03-01T00:00:00+00:00"))

    desc, _ = await repo.list(sort_field="risk_score", sort_order="desc")
    assert [c.case_id for c in desc] == ["b", "c", "a"]  # 10 > 5 > 2 (NUMERIC, not by date)
    # It must NOT be the created_at fallback order (which would be c, b, a).
    assert [c.case_id for c in desc] != ["c", "b", "a"]

    asc, _ = await repo.list(sort_field="risk_score", sort_order="asc")
    assert [c.case_id for c in asc] == ["a", "c", "b"]

    # An unknown sort field still falls back to created_at safely (no error).
    fb, _ = await repo.list(sort_field="not_a_field", sort_order="desc")
    assert [c.case_id for c in fb] == ["c", "a", "b"]  # newest created_at first


async def test_find_open_by_signature(engine) -> None:
    repo = SqlCaseRepository(engine)
    # A CLOSED case with this signature must NOT match.
    await repo.save(_case(case_id="closed", signature="sig-x", status=CaseStatus.CLOSED))
    assert await repo.find_open_by_signature("sig-x") is None

    await repo.save(_case(case_id="open1", signature="sig-x", status=CaseStatus.OPEN))
    await repo.save(_case(case_id="nh1", signature="sig-x", status=CaseStatus.NEEDS_HUMAN))
    found = await repo.find_open_by_signature("sig-x")
    assert found is not None and found.case_id in {"open1", "nh1"}
    assert await repo.find_open_by_signature("nope") is None


async def test_count_new_scans(engine) -> None:
    repo = SqlCaseRepository(engine)
    await repo.save(
        _case(case_id="s_old", signature="s1", surface=SourceSurface.AUTOMATED_SCAN,
              created_at="2026-01-01T00:00:00+00:00")
    )
    await repo.save(
        _case(case_id="s_new", signature="s2", surface=SourceSurface.AUTOMATED_SCAN,
              created_at="2026-06-01T00:00:00+00:00")
    )
    # A non-scan case after the boundary must not be counted.
    await repo.save(
        _case(case_id="inv", signature="s3", surface=SourceSurface.INVESTIGATE,
              created_at="2026-06-02T00:00:00+00:00")
    )
    n = await repo.count_new_scans("2026-03-01T00:00:00+00:00")
    assert n == 1


# --------------------------------------------------------------------------- #
# Audit — append-only
# --------------------------------------------------------------------------- #
async def test_audit_append_and_ordered_search(engine) -> None:
    audit = SqlAuditRepository(engine)
    await audit.record(action_type=ActionType.POLL, case_id="c1", actor="poller",
                       result_summary="first", surface="scan")
    await audit.record(action_type=ActionType.VERDICT, case_id="c1", actor="investigator",
                       result_summary="second")
    await audit.record(action_type=ActionType.DECISION, case_id="other", actor="system")

    rows = await audit.records_for_case("c1")
    assert len(rows) == 2
    # OLDEST first.
    assert rows[0]["result_summary"] == "first"
    assert rows[1]["result_summary"] == "second"
    assert [r["case_id"] for r in rows] == ["c1", "c1"]
    # An unknown case never raises — returns [].
    assert await audit.records_for_case("ghost") == []


async def test_audit_records_json_filter_pages_beyond_scan_window(engine) -> None:
    # audit #40: a JSON-only filter (actor) whose matches fall OUTSIDE a single scan
    # window must still be returned — records() pages until limit matches or exhaustion.
    audit = SqlAuditRepository(engine)
    # 5 OLDEST rows for 'alice' (written first → lowest ids / earliest ts), then 510
    # NEWER 'bob' rows that fill and exceed the 500-row first-scan window.
    for i in range(5):
        await audit.record(action_type=ActionType.POLL, actor="alice", result_summary=f"a{i}")
    for i in range(510):
        await audit.record(action_type=ActionType.POLL, actor="bob", result_summary=f"b{i}")
    got = await audit.records(actor="alice", limit=5)
    assert len(got) == 5, "sparse actor rows beyond the scan window must not be dropped"
    assert all(d.get("actor") == "alice" for d in got)


async def test_audit_is_append_only(engine) -> None:
    """Non-negotiable #2: the audit repository exposes NO mutation path, and a new
    record never rewrites a prior row."""
    audit = SqlAuditRepository(engine)
    # The interface has no update/delete.
    assert not hasattr(audit, "update")
    assert not hasattr(audit, "delete")

    await audit.write(AuditDoc(action_type=ActionType.PROMPT, case_id="c1", result_summary="r1"))
    await audit.write(AuditDoc(action_type=ActionType.PROMPT, case_id="c1", result_summary="r2"))

    # Two distinct immutable rows persisted (insert-only).
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    sm = async_sessionmaker(engine, expire_on_commit=False)
    async with sm() as session:
        all_rows = (await session.execute(select(AuditRow))).scalars().all()
    assert len(all_rows) == 2
    summaries = sorted(r.doc["result_summary"] for r in all_rows)
    assert summaries == ["r1", "r2"]


async def test_strict_audit_event_id_is_retry_idempotent(engine) -> None:
    """A retried privileged decision converges on one immutable SQL audit row."""
    audit = SqlAuditRepository(engine)
    doc = AuditDoc(
        event_id="proposal-decision:prop-1:approve",
        ts="2026-08-02T19:45:00+00:00",
        action_type=ActionType.PROPOSAL,
        case_id="prop-1",
        result_summary="proposal_id=prop-1 action=approve",
    )
    await audit.write_strict(doc)
    await audit.write_strict(doc)
    rows = await audit.records_for_case("prop-1")
    assert len(rows) == 1
    assert rows[0]["event_id"] == doc.event_id

    conflicting = doc.model_copy(update={"result_summary": "different"})
    with pytest.raises(RuntimeError, match="audit event id collision"):
        await audit.write_strict(conflicting)


async def test_sql_audit_and_usage_stamp_and_retain_first_build_on_retry(
    engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    audit = SqlAuditRepository(engine)
    usage = SqlUsageRepository(engine)
    monkeypatch.setenv("TLSOC_BUILD_SHA", "sql-first-build")

    await audit.record(
        action_type=ActionType.POLL,
        case_id="normal-provenance",
        actor="poller",
    )
    await usage.write(
        UsageDoc(surface="chat", role="chat", model="model-normal", total_tokens=2)
    )

    strict_audit = AuditDoc(
        event_id="proposal-decision:provenance:approve",
        action_type=ActionType.PROPOSAL,
        case_id="strict-provenance",
        result_summary="approved",
    )
    strict_usage = UsageDoc(
        surface="batch",
        role="investigator",
        model="model-batch",
        total_tokens=5,
        batch=True,
        processing_tier="batch",
        idempotency_key="batch:provenance:result",
    )
    await audit.write_strict(strict_audit)
    await usage.write_strict(strict_usage)

    monkeypatch.setenv("TLSOC_BUILD_SHA", "sql-retry-build")
    await audit.write_strict(
        AuditDoc(
            event_id=strict_audit.event_id,
            action_type=ActionType.PROPOSAL,
            case_id="strict-provenance",
            result_summary="approved",
        )
    )
    await usage.write_strict(strict_usage.model_copy(update={"ts": iso_now()}))

    normal_audit = await audit.records_for_case("normal-provenance")
    strict_audit_rows = await audit.records_for_case("strict-provenance")
    usage_rows = await usage.records_strict(limit=10)
    assert len(normal_audit) == 1
    assert len(strict_audit_rows) == 1
    assert normal_audit[0]["app_version"] == __version__
    assert normal_audit[0]["build_sha"] == "sql-first-build"
    assert strict_audit_rows[0]["app_version"] == __version__
    assert strict_audit_rows[0]["build_sha"] == "sql-first-build"

    normal_usage = next(row for row in usage_rows if row["model"] == "model-normal")
    batch_usage = next(row for row in usage_rows if row["model"] == "model-batch")
    assert normal_usage["app_version"] == __version__
    assert normal_usage["build_sha"] == "sql-first-build"
    assert batch_usage["app_version"] == __version__
    assert batch_usage["build_sha"] == "sql-first-build"


async def test_audit_write_truncates_via_record(engine) -> None:
    audit = SqlAuditRepository(engine)
    long_text = "x" * 5000
    await audit.record(action_type=ActionType.TOOL_CALL, case_id="c1",
                       tool_output_summary=long_text, prompt_excerpt=long_text)
    rows = await audit.records_for_case("c1")
    assert len(rows[0]["tool_output_summary"]) <= 1001
    assert len(rows[0]["prompt_excerpt"]) <= 1001


# --------------------------------------------------------------------------- #
# Usage — record + windowed summary (Python aggregation)
# --------------------------------------------------------------------------- #
async def test_usage_record_and_summary(engine) -> None:
    usage = SqlUsageRepository(engine)
    now = now_utc()
    ts = now.isoformat()
    await usage.write(UsageDoc(ts=ts, surface="investigate", role="investigator",
                              model="claude", cost=0.10, total_tokens=100, case_id="c1"))
    await usage.write(UsageDoc(ts=ts, surface="chat", role="chat",
                              model="gpt", cost=0.05, total_tokens=50, case_id="c1"))
    await usage.write(UsageDoc(ts=ts, surface="investigate", role="router",
                              model="claude", cost=0.02, total_tokens=20, case_id="c2"))

    s = await usage.summary(window_hours=24)
    assert s["call_count"] == 3
    assert round(s["total_cost"], 2) == 0.17
    assert s["total_tokens"] == 170
    assert s["currency"] == "USD"
    # Top model by cost is claude (0.12 > 0.05).
    assert s["by_model"][0]["key"] == "claude"
    assert round(s["by_model"][0]["cost"], 2) == 0.12

    # case_id filter narrows the aggregation.
    s_c1 = await usage.summary(window_hours=24, case_id="c1")
    assert s_c1["call_count"] == 2
    assert round(s_c1["total_cost"], 2) == 0.15
    # Case presentation is pipeline spend only: the case-scoped Chat row remains in
    # the global ledger/summary but is excluded from Case.token_cost reconciliation.
    assert await usage.total_pipeline_cost_for_case("c1") == pytest.approx(0.10)
    assert await usage.total_pipeline_cost_for_case("c2") == pytest.approx(0.02)
    assert await usage.total_pipeline_cost_for_case("missing") == 0.0


async def test_usage_strict_write_is_retry_idempotent_in_sql(engine) -> None:
    usage = SqlUsageRepository(engine)
    doc = UsageDoc(
        ts=now_utc().isoformat(),
        surface="batch",
        role="investigator",
        model="claude-haiku-4-5-20251001",
        cost=0.01,
        total_tokens=10,
        batch=True,
        processing_tier="batch",
        idempotency_key="batch:job-1:cid-1",
    )
    await usage.write_strict(doc)
    await usage.write_strict(doc)
    assert (await usage.summary(window_hours=24))["call_count"] == 1


async def test_usage_strict_write_is_concurrently_idempotent_in_sql(engine) -> None:
    usage = SqlUsageRepository(engine)
    doc = UsageDoc(
        ts=now_utc().isoformat(),
        surface="batch",
        role="investigator",
        model="claude-haiku-4-5-20251001",
        cost=0.01,
        total_tokens=10,
        batch=True,
        processing_tier="batch",
        idempotency_key="batch:job-concurrent:cid-1",
    )
    await asyncio.gather(usage.write_strict(doc), usage.write_strict(doc))
    assert (await usage.summary(window_hours=24))["call_count"] == 1


async def test_usage_summary_window_excludes_old(engine) -> None:
    usage = SqlUsageRepository(engine)
    old = now_utc().replace(year=2020).isoformat()
    fresh = now_utc().isoformat()
    await usage.write(UsageDoc(ts=old, role="router", model="m", cost=9.0, total_tokens=9))
    await usage.write(UsageDoc(ts=fresh, role="router", model="m", cost=1.0, total_tokens=1))
    s = await usage.summary(window_hours=24)
    assert s["call_count"] == 1
    assert round(s["total_cost"], 2) == 1.0


async def test_usage_summary_window_boundary_precision(engine) -> None:
    # audit #10: the window bound is now pushed into SQL (ts >= iso_from) instead of
    # loading the whole ledger. Verify the boundary is still exact: a row just INSIDE
    # the 24h window is counted, one just OUTSIDE is not.
    from datetime import timedelta

    usage = SqlUsageRepository(engine)
    now = now_utc()
    inside = (now - timedelta(hours=23)).isoformat()
    outside = (now - timedelta(hours=25)).isoformat()
    await usage.write(UsageDoc(ts=inside, role="router", model="m", cost=2.0, total_tokens=2))
    await usage.write(UsageDoc(ts=outside, role="router", model="m", cost=7.0, total_tokens=7))
    s = await usage.summary(window_hours=24)
    assert s["call_count"] == 1
    assert round(s["total_cost"], 2) == 2.0


async def test_usage_summary_empty(engine) -> None:
    usage = SqlUsageRepository(engine)
    s = await usage.summary(window_hours=12)
    assert s["call_count"] == 0
    assert s["total_cost"] == 0.0
    assert s["window_hours"] == 12
    assert s["by_model"] == []


async def test_usage_summary_processing_tiers_match_actual_sql_ledger_rows(engine) -> None:
    usage = SqlUsageRepository(engine)
    ts = now_utc().isoformat()
    for tier, cost, tokens in (
        ("standard", 0.4, 40),
        ("flex", 0.2, 20),
        ("batch", 0.1, 10),
        ("future-priority", 0.3, 30),
    ):
        await usage.write(UsageDoc(
            ts=ts,
            role="investigator",
            model="gpt-5",
            processing_tier=tier,
            batch=tier in {"flex", "batch"},
            cost=cost,
            total_tokens=tokens,
        ))

    summary = await usage.summary(window_hours=24)
    assert summary["by_processing_tier"] == [
        {"key": "standard", "cost": 0.4, "tokens": 40, "calls": 1},
        {"key": "flex", "cost": 0.2, "tokens": 20, "calls": 1},
        {"key": "batch", "cost": 0.1, "tokens": 10, "calls": 1},
        {"key": "unconfirmed", "cost": 0.3, "tokens": 30, "calls": 1},
    ]
    assert summary["discounted_tier_coverage"]["call_ratio"] == 0.5
    assert summary["discounted_tier_coverage"]["token_ratio"] == 0.3
    assert summary["processing_tier_attribution"]["confirmed_calls"] == 3
    assert summary["processing_tier_attribution"]["unconfirmed_calls"] == 1
    assert summary["processing_tier_attribution"]["fallback_calls"] is None


# --------------------------------------------------------------------------- #
# KV / config / cursor
# --------------------------------------------------------------------------- #
async def test_kv_put_if_is_a_real_compare_and_set(engine) -> None:
    # audit #27: put_if writes ONLY when the stored _rev matches, so concurrent writers
    # can't both "succeed" and lose one. SqlKVStore uses an atomic revision-predicate
    # UPDATE (plus a primary-key-arbitrated insert for an absent row).
    kv = SqlKVStore(engine)
    # First write into an absent key: expected_rev 0 succeeds and stamps rev 1.
    assert await kv.put_if("ns", "k", {"v": 1, "_rev": 1}, expected_rev=0) is True
    assert (await kv.get("ns", "k"))["v"] == 1
    # A stale writer (still thinks rev is 0) is REJECTED — no clobber.
    assert await kv.put_if("ns", "k", {"v": 999, "_rev": 1}, expected_rev=0) is False
    assert (await kv.get("ns", "k"))["v"] == 1  # unchanged
    # The up-to-date writer (expected_rev 1) succeeds.
    assert await kv.put_if("ns", "k", {"v": 2, "_rev": 2}, expected_rev=1) is True
    assert (await kv.get("ns", "k"))["v"] == 2


async def test_batch_submission_lease_converges_across_independent_sql_stores(
    engine,
) -> None:
    """Two service/store instances may race, but SQL grants one durable claimant."""
    first = BatchJobStore(SqlKVStore(engine))
    second = BatchJobStore(SqlKVStore(engine))
    job = BatchJob(
        id="sql-submission-lease",
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        requests=[{"custom_id": "sql-cid", "params": {"messages": []}}],
    )
    await first.save(job)

    claims = await asyncio.gather(
        first.claim_submission(job.id), second.claim_submission(job.id)
    )
    tokens = [token for _stored, token in claims if token]
    assert len(tokens) == 1
    durable = await second.get_strict(job.id)
    assert durable is not None
    assert durable.submission_lease_token == tokens[0]
    assert durable.submit_attempts == 1


async def test_kv_round_trip_and_upsert(engine) -> None:
    kv = SqlKVStore(engine)
    assert await kv.get("ns", "k") is None
    await kv.put("ns", "k", {"a": 1})
    assert await kv.get("ns", "k") == {"a": 1}
    await kv.put("ns", "k", {"a": 2, "b": 3})
    assert await kv.get("ns", "k") == {"a": 2, "b": 3}  # replaced, not merged


async def test_config_store_load_save(engine) -> None:
    store = SqlConfigStore(SqlKVStore(engine))
    # Cold load → defaults.
    prefs = await store.load()
    assert isinstance(prefs, Preferences)

    prefs.polling_enabled = not prefs.polling_enabled
    prefs.setup_complete = True
    await store.save(prefs)

    loaded = await store.load()
    assert loaded.polling_enabled == prefs.polling_enabled
    assert loaded.setup_complete is True


async def test_config_store_seed_rule_catalog(engine) -> None:
    store = SqlConfigStore(SqlKVStore(engine))
    prefs = Preferences()
    assert not prefs.rule_catalog
    seeded = await store.seed_rule_catalog(prefs)
    assert seeded.rule_catalog, "expected built-in rules seeded"
    # Persisted.
    reloaded = await store.load()
    assert reloaded.rule_catalog


async def test_cursor_store_load_save(engine) -> None:
    store = SqlCursorStore(SqlKVStore(engine))
    cold = await store.load()
    assert isinstance(cold, Cursor) and not cold.is_set()

    await store.save(Cursor(timestamp_millis=1234567890123, boundary_ids=["e1", "e2"]))
    loaded = await store.load()
    assert loaded.timestamp_millis == 1234567890123
    assert loaded.boundary_ids == ["e1", "e2"]


async def test_cursor_store_per_feed_keyed_isolation(engine) -> None:
    """Wave 6 — a fast and a slow feed each get their OWN durable cursor on the SQL
    backend; neither shares/skips with the other nor with the primary cursor (#4)."""
    store = SqlCursorStore(SqlKVStore(engine))
    await store.save_keyed("elk:alerts", Cursor(timestamp_millis=2000, boundary_ids=["a"]))
    await store.save_keyed("elk:events", Cursor(timestamp_millis=1000, boundary_ids=["b"]))
    await store.save(Cursor(timestamp_millis=50))  # primary is a DISTINCT slot
    assert (await store.load_keyed("elk:alerts")).timestamp_millis == 2000
    assert (await store.load_keyed("elk:events")).timestamp_millis == 1000
    assert (await store.load()).timestamp_millis == 50
    # An unknown feed cold-starts; advancing one feed never moves another.
    assert not (await store.load_keyed("elk:never-seen")).is_set()
    await store.save_keyed("elk:events", Cursor(timestamp_millis=9999))
    assert (await store.load_keyed("elk:alerts")).timestamp_millis == 2000  # unaffected


# --------------------------------------------------------------------------- #
# SqlVectorStore
# --------------------------------------------------------------------------- #
async def test_vectorstore_add_query_cosine_order(engine) -> None:
    vs = SqlVectorStore(engine)
    assert await vs.count() == 0
    await vs.add([
        StoredChunk(text="cat", source="s", embedding=[1.0, 0.0], embedding_model="m", dim=2),
        StoredChunk(text="dog", source="s", embedding=[0.0, 1.0], embedding_model="m", dim=2),
        StoredChunk(text="mid", source="s", embedding=[0.7, 0.7], embedding_model="m", dim=2),
    ])
    assert await vs.count() == 3

    results = await vs.search([1.0, 0.0], top_k=3)
    assert [c.text for c, _ in results] == ["cat", "mid", "dog"]
    # Cosine: identical vector scores ~1.0; orthogonal ~0.0.
    assert results[0][1] == pytest.approx(1.0, abs=1e-6)
    assert results[-1][1] == pytest.approx(0.0, abs=1e-6)

    assert await vs.embedding_space() == ("m", 2)


async def test_vectorstore_upsert_by_doc_id(engine) -> None:
    vs = SqlVectorStore(engine)
    await vs.add([StoredChunk(text="v1", source="s", embedding=[1.0, 0.0],
                              embedding_model="m", dim=2, doc_id="d1")])
    await vs.add([StoredChunk(text="v2", source="s", embedding=[0.0, 1.0],
                              embedding_model="m", dim=2, doc_id="d1")])
    assert await vs.count() == 1
    results = await vs.search([0.0, 1.0], top_k=1)
    assert results[0][0].text == "v2"


async def test_vectorstore_dim_mismatch_guard(engine) -> None:
    vs = SqlVectorStore(engine)
    await vs.add([StoredChunk(text="x", source="s", embedding=[1.0, 0.0, 0.0],
                              embedding_model="m", dim=3)])
    with pytest.raises(EmbeddingSpaceMismatch):
        await vs.search([1.0, 0.0], top_k=1)  # query dim 2 != stored dim 3


async def test_vectorstore_clear(engine) -> None:
    vs = SqlVectorStore(engine)
    await vs.add([StoredChunk(text="x", source="s", embedding=[1.0], embedding_model="m", dim=1)])
    assert await vs.count() == 1
    await vs.clear()
    assert await vs.count() == 0
    assert await vs.embedding_space() is None
