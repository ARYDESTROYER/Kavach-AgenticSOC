"""Round 12 (WP-AGG) review fixes: every finding the independent review raised against
the exact-aggregate core, the dashboards' case population and the stores, each pinned
by an offline test.

* Population (``api.metrics_shared``): a read that fails partway is never published as
  complete or cached; an all-time read costs at most ``limit`` rows; beyond the ceiling
  the all-time rollups are honest lower bounds with exact totals; the cache keeps a
  bounded number of Case objects and normalises span keys; an unreadable document is
  reported, not fatal; absurd windows never 500.
* Stores: a PIT opened by a failed call is always released; a partial Elasticsearch
  response (failed shard, timed-out search) is never exact; the push-downs read ONE
  snapshot (an ES point-in-time, one SQL snapshot transaction) so totals equal the sum
  of their groups under live ingest; the SQL guard catches legacy offsets and impossible
  timestamps that string order misplaces; the exact Elasticsearch request bodies.
* Engine: the analyst-confirmed FP count agrees with the dashboard; enum filters are
  validated; "last 12 months" by month is twelve buckets; the scan cursor wrapper is
  unwrapped on cancel; chat and the dashboards share one window-membership rule;
  ``open_now`` never widens a windowed scan; a misaligned push-down bucket folds
  instead of vanishing; SLA "not measured" names its real cause; the agent-improvement
  ledger read covers only its span.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import metrics_shared
from app.api.metrics_shared import fetch_case_population, fetch_ledger_span
from app.config import SlaPolicy
from app.constants import (
    CASES_WRITE_ALIAS,
    USAGE_WRITE_ALIAS,
    CaseStatus,
    DecisionBy,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import metrics as M
from app.engine.case_aggregate import (
    AggregateResult,
    AggregationCancelled,
    BucketMismatch,
    CaseAggregateSpec,
    RowSet,
    UsageAggregateSpec,
    aggregate_cases,
    aggregate_usage,
    build_case_result,
    fold_cases,
    scan_cases,
)
from app.engine.time_windows import resolve_window
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, FeedbackEntry, UsageDoc
from app.stores.base import CaseRepository
from app.stores.cases import CaseStore, PartialSearchError
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all
from app.stores.sql.models import CaseRow, UsageRow
from app.stores.sql.repositories import SqlUsageRepository
from app.stores.usage import UsageStore

UTC = timezone.utc


def _now() -> datetime:
    return datetime.now(UTC)


def _case(cid: str, *, hours_ago: float = 1.0, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": (_now() - timedelta(hours=hours_ago)).isoformat(),
    }
    base.update(kw)
    return Case(**base)


async def _seed_es(es: InMemoryESClient, cases: list[Case]) -> None:
    for case in cases:
        await es.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)


class FlakyScanStore(CaseStore):
    """A real (fake-ES) case store whose population scan fails on a chosen page."""

    def __init__(self, es: InMemoryESClient, *, fail_on_page: int | None = None) -> None:
        super().__init__(es)
        self.fail_on_page = fail_on_page
        self.pages = 0
        self.first_pages = 0
        self.rows_read = 0

    async def scan_page(self, **kw):
        if kw.get("cursor") is None:
            self.first_pages += 1
            self.pages = 0
        self.pages += 1
        if self.fail_on_page is not None and self.pages == self.fail_on_page:
            raise RuntimeError("shard failure")
        rows, nxt, total, consistency = await super().scan_page(**kw)
        self.rows_read += len(rows)
        return rows, nxt, total, consistency


def _client(app_state: Any, store: Any, monkeypatch: pytest.MonkeyPatch, *,
            limit: int | None = None) -> TestClient:
    """The metrics router over ``app_state`` whose case store is ``store``."""
    from app.api.deps import require_auth
    from app.api.routes_metrics import router

    if limit is not None:
        monkeypatch.setattr("app.api.routes_metrics._STORE_FETCH_LIMIT", limit)
    monkeypatch.setattr(app_state, "_real_cases", store)
    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


# =========================================================================== #
# Population: partial reads (findings 1 / 15)
# =========================================================================== #
async def test_a_read_that_fails_partway_is_incomplete_and_never_cached() -> None:
    es = InMemoryESClient()
    await _seed_es(es, [_case(f"c{i:05d}", hours_ago=i * 0.005 + 0.01) for i in range(2500)])
    store = FlakyScanStore(es, fail_on_page=2)
    pop = await fetch_case_population(store, span_hours=None, limit=20000)
    assert pop.load_ok and not pop.complete
    assert pop.fetched == 1000 and "shard failure" in pop.error
    assert pop.scope_total == 2500 and pop.store_total == 2500  # the exact count
    assert pop.fetched < pop.scope_total  # so every rollup's marker says truncated
    assert M.truncation_marker(pop.fetched, pop.scope_total)["truncated"] is True
    # Never cached: the next request reads again.
    store.fail_on_page = None
    again = await fetch_case_population(store, span_hours=None, limit=20000)
    assert store.first_pages == 2 and again.complete and again.fetched == 2500


async def test_every_rollup_reports_a_partial_read(app_state, monkeypatch) -> None:
    es = InMemoryESClient()
    cases = [_case(f"c{i:05d}", hours_ago=0.01 + i * 0.004, mitre=["T1110"]) for i in range(2500)]
    await _seed_es(es, cases)
    store = FlakyScanStore(es, fail_on_page=2)
    client = _client(app_state, store, monkeypatch)
    posture = client.get("/api/metrics/posture?window_hours=24").json()
    assert posture["truncated"] is True and posture["store_total"] == 2500
    assert posture["window_covered"] is False
    assert "stopped answering" in posture["window_coverage_reason"]
    assert posture["open_now"]["complete"] is True  # an exact store COUNT, unaffected
    metrics_shared.invalidate_case_page_cache()
    noise = client.get("/api/metrics/noise-reduction?window_hours=24").json()
    assert noise["cases_meta"]["truncated"] is True
    metrics_shared.invalidate_case_page_cache()
    trends = client.get("/api/metrics/trends?window_hours=24").json()
    assert trends["truncated"] is True
    metrics_shared.invalidate_case_page_cache()
    mitre = client.get("/api/mitre/coverage").json()
    assert mitre["truncated"] is True and mitre["store_total"] == 2500


# =========================================================================== #
# Population: bounded all-time reads (findings 4 / 17 / 18)
# =========================================================================== #
async def test_an_all_time_read_costs_at_most_limit_rows(monkeypatch) -> None:
    monkeypatch.setattr(metrics_shared, "_READ_PAGE", 50)
    es = InMemoryESClient()
    await _seed_es(es, [_case(f"c{i:05d}", hours_ago=i + 1) for i in range(600)])
    store = FlakyScanStore(es)
    pop = await fetch_case_population(store, span_hours=None, limit=120)
    # Newest-first, stopped after the page holding the ceiling: never the whole store.
    assert store.rows_read <= 120 + 50 and store.rows_read < 600
    assert [c.case_id for c in pop.cases][:3] == ["c00000", "c00001", "c00002"]
    assert pop.fetched == 120 and pop.scope_total == 600 and not pop.complete
    assert pop.newest_first and "600" in pop.error


async def test_all_time_rollups_beyond_the_ceiling_are_honest_lower_bounds(
    app_state, monkeypatch,
) -> None:
    es = InMemoryESClient()
    cases = [
        _case(f"c{i:03d}", hours_ago=i + 1, mitre=["T1110"], verdict=Verdict.FALSE_POSITIVE,
              status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT)
        for i in range(12)
    ]
    await _seed_es(es, cases)
    client = _client(app_state, CaseStore(es), monkeypatch, limit=5)
    mitre = client.get("/api/mitre/coverage").json()
    assert mitre["truncated"] is True and mitre["store_total"] == 12 and mitre["fetched"] == 5
    health = client.get("/api/metrics/auto-close-health?window_hours=24").json()
    assert health["truncated"] is True and health["store_total"] == 12 and health["fetched"] == 5
    # A window the newest five fully cover is complete, from the same read.
    posture = client.get("/api/metrics/posture?window_hours=3").json()
    assert posture["case_count"] == 2 and posture["window_covered"] is True


async def test_span_keys_are_normalised_and_the_cache_is_bounded(monkeypatch) -> None:
    es = InMemoryESClient()
    await _seed_es(es, [_case(f"c{i:03d}", hours_ago=i * 3 + 1) for i in range(40)])
    store = FlakyScanStore(es)
    a = await fetch_case_population(store, span_hours=26, limit=1000)
    b = await fetch_case_population(store, span_hours=30, limit=1000)
    assert store.first_pages == 1  # 26 h and 30 h share the 48 h key
    assert a.fetched == 9 and b.fetched == 10  # each narrowed EXACTLY to its own span
    assert a.complete and b.complete
    monkeypatch.setattr(metrics_shared, "POPULATION_CACHE_BUDGET", 15)
    await fetch_case_population(store, span_hours=24 * 30, limit=1000)  # 40 cases, evicts
    retained = sum(len(e.cases) for e in metrics_shared._population_cache.values())
    assert len(metrics_shared._population_cache) == 1 and retained == 40
    # The wide entry now serves every narrower window without another read.
    reads = store.first_pages
    narrow = await fetch_case_population(store, span_hours=6, limit=1000)
    assert store.first_pages == reads and narrow.fetched == 2 and narrow.complete


async def test_absurd_windows_never_overflow() -> None:
    es = InMemoryESClient()
    await _seed_es(es, [_case("c1")])
    store = CaseStore(es)
    for span in (2 * 10**9, 2 * 10**12, 10**40):
        pop = await fetch_case_population(store, span_hours=span, limit=10)
        assert pop.load_ok and pop.fetched == 1 and pop.span_hours is None  # all time


async def test_absurd_window_hours_never_500(app_state, monkeypatch) -> None:
    es = InMemoryESClient()
    await _seed_es(es, [_case("c1")])
    client = _client(app_state, CaseStore(es), monkeypatch)
    for path in ("/api/metrics/posture?window_hours=1000000000",
                 "/api/metrics/posture?window_hours=1000000000&compare=prev",
                 "/api/metrics/noise-reduction?window_hours=1000000000000",
                 "/api/metrics/noise-reduction/lineage?window_hours=1000000000",
                 "/api/mitre/coverage?window_hours=100000000000000000000000000000",
                 "/api/metrics/trends?window_hours=99999999999"):
        response = client.get(path)
        assert response.status_code == 200, path


async def test_an_unreadable_document_is_reported_not_fatal() -> None:
    es = InMemoryESClient()
    await _seed_es(es, [_case(f"c{i}", hours_ago=i + 1) for i in range(3)])
    bad = _case("bad", hours_ago=0.5).model_dump(mode="json")
    bad["status"] = "archived_v2"  # written by a newer (or rolled-back) version
    await es.index_doc(CASES_WRITE_ALIAS, bad, doc_id="bad")
    store = CaseStore(es)
    pop = await fetch_case_population(store, span_hours=None, limit=100)
    assert pop.load_ok and not pop.complete and pop.unreadable == 1
    assert [c.case_id for c in pop.cases] == ["c0", "c1", "c2"]
    assert pop.scope_total == 4 and "could not be read" in pop.error
    assert es._state_pits == {}


# =========================================================================== #
# Stores: PIT release (finding 16) and partial shard responses (findings 11 / 20)
# =========================================================================== #
class FailingSearchES(InMemoryESClient):
    """Fails every search after ``ok`` successful ones; optionally answers with a
    partial ``_shards`` block instead of raising."""

    def __init__(self, *, ok: int = 0, partial: bool = False, timed_out: bool = False) -> None:
        super().__init__()
        self.ok = ok
        self.partial = partial
        self.timed_out = timed_out
        self.armed = False
        self.calls = 0

    async def search(self, index, body):
        if self.armed:
            self.calls += 1
            if self.calls > self.ok:
                if self.partial or self.timed_out:
                    resp = await super().search(index, body)
                    if self.partial:
                        resp["_shards"] = {"total": 3, "successful": 2, "failed": 1}
                    if self.timed_out:
                        resp["timed_out"] = True
                    return resp
                raise RuntimeError("transport error")
        return await super().search(index, body)


async def test_a_failed_first_page_releases_the_pit_it_opened() -> None:
    es = FailingSearchES()
    await _seed_es(es, [_case(f"c{i}") for i in range(3)])
    store = CaseStore(es)
    es.armed = True
    for _ in range(3):
        with pytest.raises(RuntimeError):
            await store.scan_page(limit=10)
        with pytest.raises(RuntimeError):
            await store.export_page(limit=10)
        pop = await fetch_case_population(store, span_hours=None, limit=10)
        assert pop.load_ok is False
    assert es._state_pits == {}
    # A document that does not validate on the typed path also releases the snapshot.
    es.armed = False
    bad = _case("bad").model_dump(mode="json")
    bad["status"] = "archived_v2"
    await es.index_doc(CASES_WRITE_ALIAS, bad, doc_id="bad")
    with pytest.raises(Exception):
        await store.scan_page(limit=10)
    with pytest.raises(Exception):
        await store.export_page(limit=10)
    assert es._state_pits == {}
    # The usage ledger export and scan release theirs too.
    usage_es = FailingSearchES()
    usage = UsageStore(usage_es)
    await usage.write_strict(UsageDoc(role="chat", model="m", surface="chat", cost=0.1))
    usage_es.armed = True
    with pytest.raises(RuntimeError):
        await usage.export_page(limit=10)
    with pytest.raises(RuntimeError):
        await usage.scan_page(limit=10)
    assert usage_es._state_pits == {}


async def test_the_pushdown_always_closes_its_snapshot() -> None:
    es = FailingSearchES(ok=1)
    await _seed_es(es, [_case(f"c{i}", status=CaseStatus.OPEN) for i in range(4)])
    store = CaseStore(es)
    es.armed = True
    spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("status",))
    with pytest.raises(RuntimeError):
        await store.aggregate(spec)
    assert es._state_pits == {}


@pytest.mark.parametrize("partial, timed_out", [(True, False), (False, True)])
async def test_a_partial_search_response_is_never_exact(partial, timed_out) -> None:
    es = FailingSearchES(ok=0, partial=partial, timed_out=timed_out)
    await _seed_es(es, [_case(f"c{i:04d}", hours_ago=i * 0.01 + 0.01) for i in range(1500)])
    store = CaseStore(es)
    es.armed = True
    with pytest.raises(PartialSearchError):
        await store.scan_page(limit=10)
    spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("status",))
    with pytest.raises(PartialSearchError):
        await store.aggregate(spec)  # the engine would fold instead
    # A partial page after the first: the aggregate is partial, never exact.
    es2 = FailingSearchES(ok=1, partial=partial, timed_out=timed_out)
    await _seed_es(es2, [_case(f"c{i:04d}", hours_ago=i * 0.01 + 0.01) for i in range(1500)])
    es2.armed = True
    result = await fold_cases(CaseStore(es2), CaseAggregateSpec(window=resolve_window("all")))
    assert result.partial and not result.exact and result.total == 1000
    assert "partial" in (result.error or "")
    assert es2._state_pits == {}


# =========================================================================== #
# Push-downs read ONE snapshot (findings 2 / 20) and the exact ES bodies (finding 28)
# =========================================================================== #
class IngestingES(InMemoryESClient):
    """Indexes a NEW case before every search of the push-down — live ingest."""

    def __init__(self) -> None:
        super().__init__()
        self.ingest = False
        self.bodies: list[dict[str, Any]] = []
        self.responses: list[dict[str, Any]] = []
        self.opened = 0
        self.closed = 0
        self.n = 0

    async def open_state_pit(self, index, keep_alive="10m"):
        self.opened += 1
        return await super().open_state_pit(index, keep_alive)

    async def close_state_pit(self, pit_id):
        self.closed += 1
        return await super().close_state_pit(pit_id)

    async def search(self, index, body):
        self.bodies.append(body)
        if self.ingest:
            self.n += 1
            case = _case(f"late{self.n:03d}", status=CaseStatus.OPEN)
            await self.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"),
                                 doc_id=case.case_id)
        resp = await super().search(index, body)
        self.responses.append(resp)
        return resp


async def test_es_pushdown_reads_one_snapshot_under_live_ingest() -> None:
    es = IngestingES()
    await _seed_es(es, [_case(f"c{i}", status=CaseStatus.OPEN if i % 2 else CaseStatus.CLOSED)
                        for i in range(200)])
    es.ingest = True
    spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("status",),
                             metrics=("count", "open_now"))
    result = await CaseStore(es).aggregate(spec)
    assert isinstance(result, AggregateResult) and result.method == "pushdown"
    assert result.consistency == "point_in_time" and result.exact
    assert result.total == 200 == sum(g["metrics"]["count"] for g in result.groups)
    assert result.totals["open_now"] == 100
    pits = {body["pit"]["id"] for body in es.bodies}
    assert len(pits) == 1 and es.opened == 1 and es.closed == 1
    assert es.n >= 4  # cases really were ingested between the searches


async def test_es_pushdown_request_bodies_are_exact(monkeypatch) -> None:
    import app.stores.cases as cases_module

    monkeypatch.setattr(cases_module, "_COMPOSITE_PAGE", 2)
    es = IngestingES()
    await _seed_es(es, [
        _case(f"c{i}", hours_ago=24 * 40 * i + 1,
              status=[CaseStatus.OPEN, CaseStatus.CLOSED, CaseStatus.ESCALATED][i % 3])
        for i in range(6)
    ])
    window = resolve_window("all", tz="Europe/Berlin")
    spec = CaseAggregateSpec(window=window, group_by=("status",), bucket="month")
    await CaseStore(es).aggregate(spec)
    pairs = [(b, r) for b, r in zip(es.bodies, es.responses) if "aggs" in b]
    composites = [b for b, _r in pairs]
    expected_sources = [
        {"g0": {"terms": {"field": "status", "missing_bucket": True}}},
        {"cr": {"date_histogram": {"field": "created_at", "calendar_interval": "month",
                                   "time_zone": "Europe/Berlin", "missing_bucket": True}}},
    ]
    assert composites[0]["aggs"]["g"]["composite"]["sources"] == expected_sources
    assert composites[0]["aggs"]["g"]["composite"]["size"] == 2
    assert "after" not in composites[0]["aggs"]["g"]["composite"]
    # Paged with the previous page's ``after_key`` until a short page.
    assert len(composites) >= 3
    for (body, resp), (nxt, _r) in zip(pairs, pairs[1:]):
        assert nxt["aggs"]["g"]["composite"]["after"] == resp["aggregations"]["g"]["after_key"]
    assert all(b["size"] == 0 for b in composites)
    # A bounded window is a positive range on the date (no never-drop complement).
    bounded = CaseAggregateSpec(window=resolve_window("2026-09"), group_by=("status",))
    es.bodies.clear()
    await CaseStore(es).aggregate(bounded)
    first = es.bodies[0]["query"]["bool"]["filter"]
    assert {"range": {"created_at": {"gte": "2026-09-01T00:00:00+00:00",
                                      "lt": "2026-10-01T00:00:00+00:00"}}} in first


# Literal expected bucket starts across the 2026 spring-forward in Europe/Berlin
# (29 March: local midnight is 23:00Z before, 22:00Z after), written by hand so the
# fold, the push-downs and the truth are not all checked against one helper.
_BERLIN_DAYS = {
    "2026-03-27T23:00:00+00:00": 2,  # 28 Mar (CET, UTC+1)
    "2026-03-28T23:00:00+00:00": 3,  # 29 Mar: 23 hours long
    "2026-03-29T22:00:00+00:00": 1,  # 30 Mar (CEST, UTC+2)
}
_BERLIN_CREATED = [
    "2026-03-27T23:30:00+00:00", "2026-03-28T22:59:59+00:00",  # 28 Mar local
    "2026-03-28T23:00:00+00:00", "2026-03-29T01:30:00+00:00",
    "2026-03-29T21:59:59+00:00",  # 29 Mar local
    "2026-03-29T22:00:00+00:00",  # 30 Mar local
]


async def test_dst_day_buckets_match_literal_starts_on_every_path() -> None:
    cases = [_case(f"d{i}", created_at=ts) for i, ts in enumerate(_BERLIN_CREATED)]
    window = resolve_window({"from": "2026-03-28", "to": "2026-03-30"}, tz="Europe/Berlin")
    spec = CaseAggregateSpec(window=window, bucket="day")
    es = InMemoryESClient()
    await _seed_es(es, cases)
    sql = await _sql_case_repo(cases)

    def starts(result: AggregateResult) -> dict[str, int]:
        return {g["bucket_start"]: g["metrics"]["count"] for g in result.groups}

    for store in (CaseStore(es), sql):
        pushed = await store.aggregate(spec)
        assert pushed is not None and pushed.method == "pushdown"
        assert starts(pushed) == _BERLIN_DAYS
        folded = await fold_cases(store, spec)
        assert starts(folded) == _BERLIN_DAYS


_ENGINES: list[Any] = []


@pytest.fixture(autouse=True)
async def _dispose_engines():
    """Close every SQLite engine a test opened before its event loop closes."""
    yield
    while _ENGINES:
        await _ENGINES.pop().dispose()


def _engine(url: str = "sqlite+aiosqlite:///:memory:") -> Any:
    engine = build_async_engine(url)
    _ENGINES.append(engine)
    return engine


async def _sql_case_repo(cases: list[Case], url: str = "sqlite+aiosqlite:///:memory:") -> SqlCaseRepository:
    engine = _engine(url)
    await create_all(engine)
    repo = SqlCaseRepository(engine)
    for case in cases:
        await repo.save(case)
    return repo


async def test_sql_pushdown_reads_one_snapshot_under_live_ingest(tmp_path) -> None:
    import sqlite3

    from sqlalchemy import event

    db = tmp_path / "state.db"
    sqlite3.connect(db).execute("PRAGMA journal_mode=WAL").close()
    repo = await _sql_case_repo(
        [_case(f"c{i:03d}", status=CaseStatus.OPEN if i % 2 else CaseStatus.CLOSED)
         for i in range(50)],
        url=f"sqlite+aiosqlite:///{db}",
    )
    done = {"n": 0}
    template = _case("tmpl", status=CaseStatus.OPEN).model_dump(mode="json")

    def ingest(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        # Another writer commits after each of the push-down's first three reads.
        if done["n"] >= 3 or not statement.lstrip().upper().startswith("SELECT"):
            return
        done["n"] += 1
        writer = sqlite3.connect(db, timeout=5)
        cid = f"late{done['n']}"
        writer.execute(
            "INSERT INTO cases (case_id, cluster_signature, status, source_surface, "
            "entity_value, created_at, updated_at, doc) VALUES (?,?,?,?,?,?,?,?)",
            (cid, cid, "open", "investigate", "10.0.0.1", template["created_at"],
             template["created_at"], __import__("json").dumps({**template, "case_id": cid})),
        )
        writer.commit()
        writer.close()

    sync_engine = repo._sm.kw["bind"].sync_engine if hasattr(repo._sm, "kw") else None
    assert sync_engine is not None
    event.listen(sync_engine, "after_cursor_execute", ingest)
    try:
        spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("status",),
                                 metrics=("count", "open_now"))
        result = await repo.aggregate(spec)
    finally:
        event.remove(sync_engine, "after_cursor_execute", ingest)
    assert done["n"] == 3  # rows really were committed mid-aggregate
    assert result is not None and result.consistency == "point_in_time"
    assert result.total == 50 == sum(g["metrics"]["count"] for g in result.groups)
    assert result.totals["open_now"] == 25


async def _respell_created(repo: SqlCaseRepository, case_id: str, value: str) -> None:
    """Give one stored row a legacy ``created_at`` spelling (column AND document, as an
    older version would have written it)."""
    from sqlalchemy import select

    async with repo._sm() as session:
        row = (await session.execute(select(CaseRow).where(CaseRow.case_id == case_id))).scalar_one()
        row.created_at = value
        row.doc = {**dict(row.doc), "created_at": value}
        await session.commit()


async def test_sql_guard_catches_spellings_string_order_misplaces() -> None:
    # 22:00 at UTC-5 on 31 Aug is 03:00Z on 1 Sep: inside September, although the string
    # sorts before the window. An impossible ISO-shaped value cannot be placed at all.
    legacy = _case("legacy", created_at="2026-09-10T00:00:00+00:00")
    good = _case("good", created_at="2026-09-15T00:00:00+00:00")
    repo = await _sql_case_repo([legacy, good])
    await _respell_created(repo, "legacy", "2026-08-31T22:00:00-05:00")
    spec = CaseAggregateSpec(window=resolve_window("2026-09"))
    assert await repo.aggregate(spec) is None  # the push-down declines...
    result = await aggregate_cases(repo, spec)
    assert result.method == "fold" and result.total == 2  # ...and the fold places it
    impossible = _case("bad", created_at="2026-09-20T00:00:00+00:00")
    repo2 = await _sql_case_repo([impossible, good])
    await _respell_created(repo2, "bad", "2026-13-45T99:00:00+00:00")
    assert await repo2.aggregate(CaseAggregateSpec(window=resolve_window("all"))) is None
    lifetime = await aggregate_cases(repo2, CaseAggregateSpec(window=resolve_window("all")))
    assert lifetime.total == 2 and lifetime.missing_created == 1


async def test_sql_usage_guard_catches_a_legacy_offset() -> None:
    engine = _engine()
    await create_all(engine)
    repo = SqlUsageRepository(engine)
    async with repo._sm() as session:
        for ts in ("2026-08-31T22:00:00-05:00", "2026-09-15T00:00:00+00:00"):
            doc = UsageDoc(role="chat", model="m", surface="chat", cost=1.0,
                           ts=ts).model_dump(mode="json") | {"ts": ts}
            session.add(UsageRow(ts=ts, role="chat", model="m", surface="chat", cost=1.0,
                                 total_tokens=0, doc=doc))
        await session.commit()
    spec = UsageAggregateSpec(window=resolve_window("2026-09"))
    assert await repo.aggregate_usage(spec) is None
    result = await aggregate_usage(repo, spec)
    assert result.method == "fold" and result.total == 2


# =========================================================================== #
# Engine semantics
# =========================================================================== #
async def test_analyst_fp_agrees_with_the_dashboard() -> None:
    fp = [FeedbackEntry(actual_outcome="false_positive", ts=_now().isoformat())]
    cases = [
        _case("policy", status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST_POLICY,
              analyst_policy={"policy_id": "p"}, feedback=fp, verdict=None),
        _case("agent", status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
              verdict=Verdict.FALSE_POSITIVE, feedback=fp),
    ]
    es = InMemoryESClient()
    await _seed_es(es, cases)
    result = await aggregate_cases(CaseStore(es), CaseAggregateSpec(
        window=resolve_window("now-1d"), metrics=("count", "analyst_fp")))
    posture = M.posture_metrics(cases, window_hours=24)
    trends = M.trend_metrics(cases, window_hours=24)
    assert result.totals["analyst_fp"] == 1
    assert posture["quality"]["analyst_confirmed_fp"] == 1
    assert sum(b["analyst_confirmed_fp"] for b in trends["buckets"]) == 1


@pytest.mark.parametrize("filters", [
    {"disposition": "fp"}, {"surface": "investigation"}, {"mitre_technique": "T9999"},
    {"mitre_technique": "bogus"}, {"mitre_tactic": "nonsense"},
])
async def test_enum_filters_are_rejected_visibly(filters) -> None:
    with pytest.raises(ValueError):
        await aggregate_cases(CaseStore(InMemoryESClient()), CaseAggregateSpec(
            window=resolve_window("all"), filters=filters))


async def test_canonical_attack_and_enum_filters_match() -> None:
    case = _case("m", mitre=["T1110.001"], disposition=Disposition.FALSE_POSITIVE,
                 source_surface=SourceSurface.AUTOMATED_SCAN)
    es = InMemoryESClient()
    await _seed_es(es, [case, _case("other", mitre=["T1059"])])
    store = CaseStore(es)

    async def total(filters: dict[str, Any]) -> int:
        result = await aggregate_cases(store, CaseAggregateSpec(
            window=resolve_window("all"), filters=filters))
        return result.total

    assert await total({"mitre_technique": "t1110.001"}) == 1  # canonical spelling
    assert await total({"mitre_technique": "T1110"}) == 0  # the parent is a distinct id
    assert await total({"disposition": "False Positive"}) == 1
    assert await total({"surface": "automated-scan"}) == 1
    from app.engine import mitre as mitre_engine

    tactic = mitre_engine.technique("T1110.001")["tactics"][0]  # "Credential Access"
    assert await total({"mitre_tactic": tactic.lower().replace(" ", "_")}) == 1
    assert await total({"mitre_tactic": tactic.upper()}) == 1


async def test_last_12_months_by_month_aggregates_twelve_buckets() -> None:
    now = _now()
    cases = [_case(f"c{i}", created_at=(now - timedelta(days=15 * i + 1)).isoformat())
             for i in range(30)]
    es = InMemoryESClient()
    await _seed_es(es, cases)
    window = resolve_window("last 12 months", tz="America/New_York", now=now)
    for store in (CaseStore(es), await _sql_case_repo(cases)):
        result = await aggregate_cases(store, CaseAggregateSpec(window=window, bucket="month"))
        assert len(result.buckets) == 12 and result.buckets[-1][1] is True
        assert "since" in result.window_label and result.window_from > window.start.isoformat()
        assert sum(g["metrics"]["count"] for g in result.groups) == result.total


async def test_scan_cases_releases_the_wrapped_export_snapshot_on_cancel() -> None:
    closed: list[Any] = []

    class SnapshotRepo(CaseRepository):
        async def save(self, case): ...
        async def get(self, case_id): ...
        async def find_open_by_signature(self, signature): ...
        async def list(self, **kw): return [], 0
        async def list_scans(self, limit=50): return [], 0
        async def count_new_scans(self, since_iso): return 0

        async def export_page(self, *, limit=1000, cursor=None):
            offset = int((cursor or {}).get("offset", 0))
            rows = [_case(f"c{offset + i}") for i in range(limit)]
            return rows, {"snapshot": "S1", "offset": offset + limit}, 10 * limit, "point_in_time"

        async def close_export_cursor(self, cursor):
            closed.append(cursor)

    cancel = asyncio.Event()

    def consume(_page):
        cancel.set()

    with pytest.raises(AggregationCancelled):
        await scan_cases(SnapshotRepo(), consume, page_size=5, cancel=cancel)
    assert closed == [{"snapshot": "S1", "offset": 5}]


async def test_chat_and_dashboard_share_one_window_membership() -> None:
    now = _now()
    cases = [
        _case("recent", created_at=(now - timedelta(hours=1)).isoformat()),
        _case("undated", created_at=""),
        _case("future", created_at=(now + timedelta(hours=2)).isoformat()),
        _case("old", created_at=(now - timedelta(hours=30)).isoformat()),
    ]
    es = InMemoryESClient()
    await _seed_es(es, cases)
    sql = await _sql_case_repo(cases)
    posture = M.posture_metrics(cases, window_hours=24, now=now)
    for store in (CaseStore(es), sql):
        window = resolve_window("now-24h", now=now)
        counted = await aggregate_cases(store, CaseAggregateSpec(window=window))
        folded = await fold_cases(store, CaseAggregateSpec(window=window))
        assert counted.total == folded.total == posture["case_count"] == 1
        assert counted.missing_created == folded.missing_created == 1
        assert counted.missing_in_total is False
    lifetime = await aggregate_cases(CaseStore(es), CaseAggregateSpec(window=resolve_window("all")))
    assert lifetime.total == 4 and M.posture_metrics(cases, window_hours=0)["case_count"] == 4


async def test_open_now_does_not_widen_the_windowed_scan() -> None:
    now = _now()
    cases = [_case(f"old{i}", created_at=(now - timedelta(days=100 + i)).isoformat(),
                   status=CaseStatus.OPEN) for i in range(300)]
    cases += [_case(f"new{i}", created_at=(now - timedelta(hours=i + 1)).isoformat(),
                    status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE) for i in range(10)]
    es = InMemoryESClient()
    await _seed_es(es, cases)
    store = FlakyScanStore(es)
    spec = CaseAggregateSpec(window=resolve_window("now-1d", now=now),
                             metrics=("count", "fp_rate", "open_now"))
    result = await aggregate_cases(store, spec)  # fp_rate: the fold path
    assert result.method == "fold"
    assert store.rows_read == 10  # the window only; the stock is a COUNT push-down
    assert result.total == 10 and result.totals["fp_rate"] == 1.0
    assert result.totals["open_now"] == 300 and result.exact


async def test_an_unreadable_document_does_not_break_aggregates() -> None:
    es = InMemoryESClient()
    await _seed_es(es, [_case(f"c{i}", hours_ago=i + 1, severity_band=None) for i in range(50)])
    bad = _case("bad", hours_ago=2).model_dump(mode="json")
    bad["status"] = "archived_v2"
    bad["severity_band"] = None
    await es.index_doc(CASES_WRITE_ALIAS, bad, doc_id="bad")
    store = CaseStore(es)
    window = resolve_window("all")
    counted = await aggregate_cases(store, CaseAggregateSpec(window=window))
    assert counted.total == 51 and counted.exact and counted.method == "pushdown"
    timed = await aggregate_cases(store, CaseAggregateSpec(window=window,
                                                           metrics=("count", "mttr_p50")))
    assert timed.total == 51 and timed.unreadable == 1 and not timed.exact
    banded = await aggregate_cases(store, CaseAggregateSpec(window=window, group_by=("severity",)))
    assert banded.total == 51 and banded.unreadable == 1 and not banded.exact
    assert any(g["key"]["severity"] is None and g["metrics"]["count"] == 1 for g in banded.groups)


async def test_a_misaligned_pushdown_bucket_folds_instead_of_vanishing() -> None:
    window = resolve_window({"from": "2026-03-01", "to": "2026-03-04"}, tz="America/Mexico_City")
    spec = CaseAggregateSpec(window=window, bucket="day")
    state = RowSet()
    state.acc((), datetime(2026, 3, 2, 5, tzinfo=UTC)).add_counts(7)  # 05:00Z, not 06:00Z
    state.total = 7
    with pytest.raises(BucketMismatch):
        build_case_result(spec, state, exact=True, consistency="point_in_time", method="pushdown")
    cases = [_case(f"c{i}", created_at=f"2026-03-0{1 + i % 3}T12:00:00+00:00") for i in range(9)]
    es = InMemoryESClient()
    await _seed_es(es, cases)

    class MisalignedStore(CaseStore):
        async def aggregate(self, spec):
            bad = RowSet()
            bad.acc((), datetime(2026, 3, 2, 5, tzinfo=UTC)).add_counts(9)
            bad.total = 9
            return build_case_result(spec, bad, exact=True, consistency="point_in_time",
                                     method="pushdown")

    result = await aggregate_cases(MisalignedStore(es), spec)
    assert result.method == "fold" and result.total == 9
    assert sum(g["metrics"]["count"] for g in result.groups) == 9


def test_sla_not_measured_names_its_real_cause() -> None:
    now = _now()
    policy = SlaPolicy(enabled=True)
    assert "no cases in this window" in M.sla_metrics([], policy, now=now)["attainment_reason"]
    bad = _case("bad", priority_level="P1", created_at="garbage")
    out = M.sla_metrics([bad], policy, now=now)
    assert out["attainment_pct"] is None
    assert out["attainment_reason"].startswith("1 case has no readable creation time")
    unprioritised = _case("u", priority_level=None)
    out = M.sla_metrics([unprioritised, unprioritised], policy, now=now)
    assert out["attainment_reason"].startswith("2 cases have no priority with an SLA target")


async def test_agent_improvement_ledger_read_covers_only_its_span() -> None:
    end = datetime(2026, 10, 10, tzinfo=UTC)
    span_start = end - timedelta(days=35)
    engine = _engine()
    await create_all(engine)
    repo = SqlUsageRepository(engine)
    async with repo._sm() as session:
        for day in range(200):
            ts = (end - timedelta(days=day, hours=1)).isoformat()
            doc = UsageDoc(role="investigator", model="m", surface="investigate", cost=1.0,
                           case_id=f"case-{day}").model_dump(mode="json") | {"ts": ts}
            session.add(UsageRow(ts=ts, case_id=f"case-{day}", role="investigator", model="m",
                                 surface="investigate", cost=1.0, total_tokens=0, doc=doc))
        await session.commit()
    read = {"rows": 0}
    real = repo.scan_page

    async def counting(**kw):
        rows, nxt, total, consistency = await real(**kw)
        read["rows"] += len(rows)
        return rows, nxt, total, consistency

    repo.scan_page = counting  # type: ignore[method-assign]
    rows, truncated = await fetch_ledger_span(repo, span_start=span_start, end=end)
    assert len(rows) == 35 and not truncated
    assert read["rows"] == 35  # the span, not the 200-day ledger
    again, _ = await fetch_ledger_span(repo, span_start=span_start, end=end)
    assert again == rows and read["rows"] == 35  # memoised for the TTL
    # The Elasticsearch ledger pushes the range too.
    es = InMemoryESClient()
    usage = UsageStore(es)
    for day in range(60):
        ts = (end - timedelta(days=day, hours=1)).isoformat()
        await es.index_doc(USAGE_WRITE_ALIAS, UsageDoc(
            role="chat", model="m", surface="chat", cost=1.0).model_dump(mode="json") | {"ts": ts},
            doc_id=f"u{day}")
    metrics_shared.invalidate_case_page_cache()
    page, nxt, _total, consistency = await usage.scan_page(limit=1000, ts_from=span_start, ts_to=end)
    assert len(page) == 35 and nxt is None and consistency == "point_in_time"
    assert es._state_pits == {}
