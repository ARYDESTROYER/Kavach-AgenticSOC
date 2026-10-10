"""Round 12 WP-AGG final fixes.

* ``GET /api/metrics`` headline counts are exact store-wide aggregates (status,
  verdict, disposition), and the figures still computed over the retained cases carry
  the ``truncated``/``store_total``/``fetched`` marker.
* A population read does its per-row work (window checks, ordering, ``Case``
  validation, SQL JSON decoding) off the event loop; large rollups run in a worker
  thread; a bounded-window read never queues behind an all-time read.
* A bounded window is ``[now - span, now)`` in the read, its narrowing and its exact
  count alike, so a future-dated case never uses up a read slot or makes an incomplete
  window look complete.
* An Elasticsearch count-style fold reads only the stored fields it needs.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import metrics_shared, routes_metrics
from app.api.metrics_shared import fetch_case_breakdown, fetch_case_population
from app.constants import (
    CASES_WRITE_ALIAS,
    CaseStatus,
    Disposition,
    EntityType,
    SourceSurface,
    Verdict,
)
from app.engine import case_aggregate as CA
from app.engine.case_aggregate import CaseAggregateSpec, aggregate_cases, fold_cases
from app.engine.metrics import posture_metrics
from app.engine.time_windows import resolve_window
from app.es.fake import InMemoryESClient, _project_source
from app.models import Case, Entity
from app.stores.cases import CaseStore

UTC = timezone.utc


def _now() -> datetime:
    return datetime.now(UTC)


def _case(cid: str, *, hours_ago: float = 1.0, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid, "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": (_now() - timedelta(hours=hours_ago)).isoformat(),
    }
    base.update(kw)
    return Case(**base)


async def _es_store(cases: list[Case]) -> tuple[CaseStore, InMemoryESClient]:
    es = InMemoryESClient()
    for case in cases:
        await es.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)
    return CaseStore(es), es


_ENGINES: list[Any] = []


@pytest.fixture(autouse=True)
async def _dispose_engines():
    yield
    while _ENGINES:
        await _ENGINES.pop().dispose()


async def _sql_store(cases: list[Case]) -> Any:
    from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    _ENGINES.append(engine)
    await create_all(engine)
    repo = SqlCaseRepository(engine)
    for case in cases:
        await repo.save(case)
    return repo


def _mixed_store_cases() -> list[Case]:
    """15 cases: the 10 newest closed (verdicts and dispositions vary), the 5 oldest
    open — so a newest-10 sample misses every open case."""
    out: list[Case] = []
    for i in range(15):
        closed = i < 10
        out.append(_case(
            f"c{i:03d}", hours_ago=i + 1,
            status=CaseStatus.CLOSED if closed else CaseStatus.OPEN,
            verdict=(Verdict.FALSE_POSITIVE if i % 2 else Verdict.TRUE_POSITIVE) if closed
            else Verdict.NEEDS_HUMAN,
            disposition=(Disposition.FALSE_POSITIVE if i % 2 else Disposition.TRUE_POSITIVE)
            if closed else None,
        ))
    return out


class _Usage:
    async def summary(self, window_hours: int) -> dict[str, Any]:
        return {"window_hours": window_hours}


# =========================================================================== #
# F1 — /api/metrics headline counts are exact
# =========================================================================== #
def _metrics_client(app_state: Any) -> TestClient:
    from app.api.routes import router

    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(router)
    return TestClient(api)


async def test_api_metrics_headline_counts_are_exact_beyond_the_ceiling(
    app_state, monkeypatch,
) -> None:
    monkeypatch.setattr(routes_metrics, "_STORE_FETCH_LIMIT", 10)
    for case in _mixed_store_cases():
        await app_state.cases.save(case)
    exact = await aggregate_cases(
        app_state.cases, CaseAggregateSpec(window=resolve_window("all"), group_by=("status",)),
    )
    exact_status = {g["key"]["status"]: g["metrics"]["count"] for g in exact.groups}

    body = _metrics_client(app_state).get("/api/metrics").json()
    assert body["total_cases"] == exact.total == 15
    assert body["open_cases"] == exact_status["open"] == 5
    assert body["closed_cases"] == exact_status["closed"] == 10
    assert body["needs_human_cases"] == 0
    assert body["by_status"] == {"open": 5, "closed": 10}
    assert body["by_verdict"] == {
        "TRUE_POSITIVE": 5, "FALSE_POSITIVE": 5, "NEEDS_HUMAN": 5, "none": 0,
    }
    assert body["by_disposition"] == {
        "true_positive": 5, "false_positive": 5, "undetermined": 5,
    }
    assert body["counts_exact"] is True and body["counts_note"] == ""
    # The figures still computed over the retained cases say they are a sample.
    assert body["truncated"] is True
    assert body["store_total"] == 15 and body["fetched"] == 10


async def test_api_metrics_complete_store_is_not_truncated(app_state) -> None:
    for case in _mixed_store_cases()[:4]:
        await app_state.cases.save(case)
    body = _metrics_client(app_state).get("/api/metrics").json()
    assert body["total_cases"] == 4 and body["counts_exact"] is True
    assert body["truncated"] is False
    assert body["store_total"] == 4 and body["fetched"] == 4


async def test_legacy_metrics_counts_are_exact_on_sql(monkeypatch) -> None:
    monkeypatch.setattr(routes_metrics, "_STORE_FETCH_LIMIT", 10)
    repo = await _sql_store(_mixed_store_cases())
    state = SimpleNamespace(cases=repo, usage_store=_Usage())
    body = await routes_metrics.legacy_metrics_payload(state, 24)
    assert body["total_cases"] == 15 and body["open_cases"] == 5
    assert body["by_disposition"] == {
        "true_positive": 5, "false_positive": 5, "undetermined": 5,
    }
    assert body["counts_exact"] is True
    assert body["truncated"] is True and body["fetched"] == 10
    assert body["cost"] == {"window_hours": 24}


async def test_a_count_that_cannot_be_read_falls_back_and_says_so(monkeypatch) -> None:
    monkeypatch.setattr(routes_metrics, "_STORE_FETCH_LIMIT", 10)
    store, _es = await _es_store(_mixed_store_cases())
    real = CA.aggregate_cases

    async def flaky(store_arg: Any, spec: CaseAggregateSpec, **kw: Any):
        if spec.group_by == ("disposition",):
            raise RuntimeError("disposition scan failed")
        return await real(store_arg, spec, **kw)

    monkeypatch.setattr(CA, "aggregate_cases", flaky)
    state = SimpleNamespace(cases=store, usage_store=_Usage())
    body = await routes_metrics.legacy_metrics_payload(state, 24)
    # Status/verdict are still exact; disposition falls back to the analysed cases and
    # the response says the counts are not all exact, and why.
    assert body["total_cases"] == 15 and body["open_cases"] == 5
    assert sum(body["by_disposition"].values()) == 10
    assert body["counts_exact"] is False
    assert "disposition" in body["counts_note"]
    # A partial breakdown is never memoised: the next read tries again.
    monkeypatch.setattr(CA, "aggregate_cases", real)
    again = await fetch_case_breakdown(store)
    assert again.exact and again.by_disposition == {
        "true_positive": 5, "false_positive": 5, "undetermined": 5,
    }


async def test_the_breakdown_is_shared_for_its_ttl_and_keyed_by_store() -> None:
    store, _es = await _es_store(_mixed_store_cases()[:3])
    calls = {"n": 0}
    real = store.aggregate

    async def counting(spec: Any) -> Any:
        calls["n"] += 1
        return await real(spec)

    store.aggregate = counting  # type: ignore[method-assign]
    first, second = await asyncio.gather(fetch_case_breakdown(store), fetch_case_breakdown(store))
    assert first is second  # single flight
    before = calls["n"]
    await fetch_case_breakdown(store)
    assert calls["n"] == before  # served from the short-TTL memo
    other, _ = await _es_store(_mixed_store_cases()[:2])
    assert (await fetch_case_breakdown(other)).total == 2  # another store is never aliased


# =========================================================================== #
# Elasticsearch: a count-style fold reads only the fields it needs
# =========================================================================== #
class _RecordingES(InMemoryESClient):
    def __init__(self) -> None:
        super().__init__()
        self.bodies: list[dict[str, Any]] = []

    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        self.bodies.append(body)
        return await super().search(index, body)


async def test_es_disposition_fold_projects_the_stored_fields() -> None:
    es = _RecordingES()
    cases = _mixed_store_cases()
    for case in cases:
        await es.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)
    store = CaseStore(es)
    spec = CaseAggregateSpec(window=resolve_window("all"), group_by=("disposition",))
    result = await aggregate_cases(store, spec)
    scans = [b for b in es.bodies if b.get("size", 0) > 0 and "sort" in b]
    assert scans and all(
        b.get("_source") == {"includes": ["case_id", "created_at", "disposition", "status"]}
        for b in scans
    )
    counts = {g["key"]["disposition"]: g["metrics"]["count"] for g in result.groups}
    assert counts == {"true_positive": 5, "false_positive": 5, None: 5}
    assert result.exact and result.total == 15

    # The projected fold answers exactly what a whole-document fold answers.
    class _NoProjection(CaseStore):
        async def scan_page(self, *, limit=1000, cursor=None, created_from=None,
                            created_to=None, raw=False, statuses=None, newest_first=False):
            return await super().scan_page(
                limit=limit, cursor=cursor, created_from=created_from,
                created_to=created_to, raw=raw, statuses=statuses, newest_first=newest_first,
            )

    whole = await fold_cases(_NoProjection(es), spec)
    assert whole.groups == result.groups and whole.total == result.total


async def test_a_fold_that_needs_the_model_reads_whole_documents() -> None:
    es = _RecordingES()
    for case in _mixed_store_cases()[:3]:
        await es.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)
    store = CaseStore(es)
    for spec in (
        CaseAggregateSpec(window=resolve_window("all"), group_by=("severity",)),
        CaseAggregateSpec(window=resolve_window("all"), metrics=("count", "mean_risk")),
        CaseAggregateSpec(window=resolve_window("all"), filters={"text": "c00"}),
    ):
        es.bodies.clear()
        await fold_cases(store, spec)
        scans = [b for b in es.bodies if b.get("size", 0) > 0 and "sort" in b]
        assert scans and all("_source" not in b for b in scans)


def test_fake_es_source_filtering() -> None:
    doc = {"a": 1, "b": {"c": 2, "d": 3}, "e": [1, 2]}
    assert _project_source(doc, ["a"]) == {"a": 1}
    assert _project_source(doc, "b.c") == {"b": {"c": 2}}
    assert _project_source(doc, {"includes": ["a", "b"]}) == {"a": 1, "b": {"c": 2, "d": 3}}
    assert _project_source(doc, {"includes": ["b.*"]}) == {"b": {"c": 2, "d": 3}}
    assert _project_source(doc, {"excludes": ["b"]}) == {"a": 1, "e": [1, 2]}
    # Booleans and an absent spec leave the document as it was (unchanged behaviour).
    assert _project_source(doc, None) is doc and _project_source(doc, False) is doc
    projected = _project_source(doc, ["e"])
    projected["e"].append(3)
    assert doc["e"] == [1, 2]  # a projection is a copy


# =========================================================================== #
# F2 — the population read keeps the event loop free
# =========================================================================== #
async def test_population_validation_runs_in_a_worker_thread(monkeypatch) -> None:
    store, _es = await _es_store([_case(f"t{i}", hours_ago=i + 1) for i in range(5)])
    loop_thread = threading.get_ident()
    seen: list[int] = []
    real = metrics_shared._validate_case

    def spy(row: Any) -> Any:
        seen.append(threading.get_ident())
        return real(row)

    monkeypatch.setattr(metrics_shared, "_validate_case", spy)
    population = await fetch_case_population(store, span_hours=None, limit=100)
    assert population.fetched == 5 and population.complete
    assert len(seen) == 5 and loop_thread not in seen


async def test_a_slow_population_read_never_stalls_the_event_loop(monkeypatch) -> None:
    """Validation that takes 0.45 s in total must not hold the loop for that long."""
    store, _es = await _es_store([_case(f"s{i}", hours_ago=i + 1) for i in range(3)])
    real = metrics_shared._validate_case

    def slow(row: Any) -> Any:
        time.sleep(0.15)
        return real(row)

    monkeypatch.setattr(metrics_shared, "_validate_case", slow)
    stalls: list[float] = []
    done = asyncio.Event()

    async def ticker() -> None:
        last = time.perf_counter()
        while not done.is_set():
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            stalls.append(now - last - 0.01)
            last = now

    task = asyncio.create_task(ticker())
    population = await fetch_case_population(store, span_hours=None, limit=100)
    done.set()
    await task
    assert population.fetched == 3
    # On the loop, the three validations of the one page would be a single 0.45 s stall.
    assert max(stalls) < 0.3, f"the event loop stalled for {max(stalls):.3f}s"


class _BlockingAllTimeStore(CaseStore):
    """An all-time read (no window) waits for ``release``; a windowed read does not."""

    def __init__(self, es: InMemoryESClient) -> None:
        super().__init__(es)
        self.release = asyncio.Event()
        self.all_time_started = asyncio.Event()

    async def scan_page(self, **kw: Any):
        if kw.get("created_from") is None:
            self.all_time_started.set()
            await self.release.wait()
        return await super().scan_page(**kw)


async def test_a_windowed_read_never_queues_behind_an_all_time_read() -> None:
    es = InMemoryESClient()
    for case in [_case(f"w{i}", hours_ago=i + 1) for i in range(4)]:
        await es.index_doc(CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id)
    store = _BlockingAllTimeStore(es)
    all_time = asyncio.create_task(fetch_case_population(store, span_hours=None, limit=100))
    await asyncio.wait_for(store.all_time_started.wait(), 2)
    windowed = await asyncio.wait_for(
        fetch_case_population(store, span_hours=24, limit=100), 2,
    )
    assert windowed.fetched == 4 and windowed.complete
    assert not all_time.done()
    store.release.set()
    assert (await all_time).fetched == 4


async def test_large_rollups_run_in_a_worker_thread(app_state, monkeypatch) -> None:
    from fastapi import Depends

    from app.api.deps import require_auth

    monkeypatch.setattr(routes_metrics, "_OFFLOAD_AT", 1)
    await app_state.cases.save(_case("r1"))
    loop_thread = threading.get_ident()
    seen: list[int] = []
    real = routes_metrics.posture_metrics

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(threading.get_ident())
        return real(*args, **kwargs)

    monkeypatch.setattr(routes_metrics, "posture_metrics", spy)
    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(routes_metrics.router, dependencies=[Depends(require_auth)])
    body = TestClient(api).get("/api/metrics/posture?window_hours=24").json()
    assert body["case_count"] == 1
    assert seen and loop_thread not in seen


async def test_sql_raw_pages_decode_off_the_loop_and_match_the_documents() -> None:
    from app.stores.sql import repositories as R

    cases = [_case(f"q{i}", hours_ago=i + 1, tags=["t"]) for i in range(3)]
    repo = await _sql_store(cases)
    rows, _cursor, total, _consistency = await repo.scan_page(limit=10, raw=True)
    assert total == 3 and all(isinstance(r, dict) for r in rows)
    validated, _cursor, _total, _consistency = await repo.scan_page(limit=10, raw=False)
    # The raw page is the stored document: it validates to exactly the Case the
    # validated page returns.
    assert {r["case_id"]: Case.model_validate(r) for r in rows} == {
        c.case_id: c for c in validated
    }
    assert R._decode_docs(['{"a": 1}', b'{"b": 2}', {"c": 3}, None, "not json", "[1]"]) == [
        {"a": 1}, {"b": 2}, {"c": 3}, {}, {}, {},
    ]


# =========================================================================== #
# F3 — a bounded window ends now, everywhere
# =========================================================================== #
def _with_future(n: int = 10) -> list[Case]:
    cases = [_case(f"p{i}", hours_ago=i + 1) for i in range(n)]
    cases.append(_case("future", hours_ago=-2))  # stamped 2 h ahead (clock skew)
    return cases


@pytest.mark.parametrize("backend", ["es", "sql"])
async def test_a_future_dated_case_never_uses_a_read_slot(backend: str) -> None:
    cases = _with_future()
    store = (await _es_store(cases))[0] if backend == "es" else await _sql_store(cases)
    population = await fetch_case_population(store, span_hours=24, limit=10)
    assert population.complete and population.fetched == 10 and population.scope_total == 10
    assert "future" not in {c.case_id for c in population.cases}
    posture = posture_metrics(
        population.cases, sla_policy=None, window_hours=24, store_total=population.scope_total,
        load_ok=population.load_ok, open_now_count=population.open_now,
        newest_first=population.newest_first,
    )
    chat = await aggregate_cases(store, CaseAggregateSpec(window=resolve_window("now-24h")))
    assert posture["case_count"] == chat.total == 10
    assert posture["truncated"] is False


@pytest.mark.parametrize("backend", ["es", "sql"])
async def test_a_window_over_the_ceiling_is_flagged_even_with_future_cases(backend: str) -> None:
    cases = _with_future(12)
    store = (await _es_store(cases))[0] if backend == "es" else await _sql_store(cases)
    population = await fetch_case_population(store, span_hours=24, limit=10)
    assert not population.complete
    assert population.fetched == 10 and population.scope_total == 12


async def test_narrowing_all_time_drops_future_cases_and_counts_the_same_window() -> None:
    store, _es = await _es_store(_with_future())
    everything = await fetch_case_population(store, span_hours=None, limit=100)
    assert everything.fetched == 11  # all time is open-ended: the future case is in it
    narrowed = await fetch_case_population(store, span_hours=24, limit=100)
    assert narrowed.complete and narrowed.fetched == 10
    assert "future" not in {c.case_id for c in narrowed.cases}


async def test_the_scope_count_uses_the_reads_upper_bound() -> None:
    store, _es = await _es_store(_with_future())
    since = _now() - timedelta(hours=24)
    count, failed = await metrics_shared._scope_count(store, since, _now(), floor_at_least=0)
    assert (count, failed) == (10, False)
    everything, failed = await metrics_shared._scope_count(store, None, floor_at_least=0)
    assert (everything, failed) == (11, False)


# =========================================================================== #
# F2 — full garbage collections are deferred while a population is built
# =========================================================================== #
async def test_full_collections_are_deferred_during_a_read_and_restored_after(
    monkeypatch,
) -> None:
    import gc

    store, _es = await _es_store([_case(f"g{i}", hours_ago=i + 1) for i in range(3)])
    original = gc.get_threshold()
    during: list[tuple[int, int, int]] = []
    real = metrics_shared._validate_case

    def spy(row: Any) -> Any:
        during.append(gc.get_threshold())
        return real(row)

    monkeypatch.setattr(metrics_shared, "_validate_case", spy)
    await fetch_case_population(store, span_hours=None, limit=100)
    assert during and all(t[2] == metrics_shared._GC_HOLD_THRESHOLD2 for t in during)
    assert all(t[:2] == original[:2] for t in during)  # young collections untouched
    assert gc.get_threshold() == original
    assert metrics_shared._gc_hold["depth"] == 0


def test_gc_hold_is_reference_counted_and_never_clobbers_a_new_threshold() -> None:
    import gc

    original = gc.get_threshold()
    try:
        metrics_shared._gc_hold_enter()
        metrics_shared._gc_hold_enter()  # a second, overlapping read
        metrics_shared._gc_hold_exit()
        assert gc.get_threshold()[2] == metrics_shared._GC_HOLD_THRESHOLD2  # still held
        metrics_shared._gc_hold_exit()
        assert gc.get_threshold() == original

        metrics_shared._gc_hold_enter()
        gc.set_threshold(original[0], original[1], 7)  # someone else retunes meanwhile
        metrics_shared._gc_hold_exit()
        assert gc.get_threshold() == (original[0], original[1], 7)  # left as they set it
    finally:
        gc.set_threshold(*original)
        metrics_shared._gc_hold.update(depth=0, saved=None, held=None)


def test_a_stale_gc_hold_is_released(monkeypatch) -> None:
    import gc

    original = gc.get_threshold()
    monkeypatch.setattr(metrics_shared, "_GC_HOLD_MAX_SECONDS", 0.0)
    try:
        metrics_shared._gc_hold_enter()
        time.sleep(0.01)
        metrics_shared._gc_hold_check()
        assert gc.get_threshold() == original  # released while the read still runs
        metrics_shared._gc_hold_exit()
        assert gc.get_threshold() == original
        assert metrics_shared._gc_hold["depth"] == 0
    finally:
        gc.set_threshold(*original)
        metrics_shared._gc_hold.update(depth=0, saved=None, held=None)


def test_gc_hold_leaves_disabled_collection_alone() -> None:
    import gc

    original = gc.get_threshold()
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        metrics_shared._gc_hold_enter()
        assert gc.get_threshold() == original
        metrics_shared._gc_hold_exit()
        assert gc.get_threshold() == original
    finally:
        if was_enabled:
            gc.enable()
        gc.set_threshold(*original)
        metrics_shared._gc_hold.update(depth=0, saved=None, held=None)


async def test_a_failed_read_still_restores_collection(monkeypatch) -> None:
    import gc

    original = gc.get_threshold()

    class _Broken(CaseStore):
        async def scan_page(self, **kw: Any):
            raise RuntimeError("store down")

    population = await fetch_case_population(_Broken(InMemoryESClient()), span_hours=None,
                                             limit=10)
    assert population.load_ok is False
    assert gc.get_threshold() == original and metrics_shared._gc_hold["depth"] == 0
