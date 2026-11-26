"""Round 16 CDX1: one source outage never blocks the rest of the deferred queue.

Review finding on PR #144 (Codex, P2). Round 16 B11 made the deferred drain ask the
store for the deferred queue itself, but it read ONE oldest-first page of
``max(50, 2 * limit)`` candidates per tick. When every candidate on that page came
from a pull source whose cluster could not be rebuilt (the source was down, so
``cluster_for_case`` raised, or it returned ``None``), each later tick read the same
page and skipped the same candidates, so the healthy candidates behind them were
never drained even with capacity free.

The fix: ``list_deferred_candidates`` takes an additive ``after`` keyset marker
(created_at, then case_id) in every bundled store and in the base default, and returns
the marker for the next page on the page itself. The drain reads further pages in a
tick (at most four), and when it reads all four without filling the allowance, the
next tick resumes after the last row it read. A productive tick, or the end of the
queue, sends the next tick back to the head, so healthy candidates still drain oldest
first. A store without the parameter returns a plain list and keeps the old single
page. Offline: fake Elasticsearch with its paging limits, SQLite.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest_asyncio

from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.models import Case, Entity
from app.stores.base import CaseRepository
from app.stores.cases import CaseStore

REASON = "deferred: per-tick auto-investigation cap reached"
TICK = "2026-11-03T00:00:00+00:00"


class _RealisticES(InMemoryESClient):
    """Elasticsearch's paging limit: ``from + size`` past the result window is
    rejected, so no read can page its way to a deep offset."""

    window = 100

    def __init__(self) -> None:
        super().__init__()
        self.searches = 0

    async def search(self, index, body):
        self.searches += 1
        if int(body.get("from", 0) or 0) + int(body.get("size", 10) or 0) > self.window:
            raise RuntimeError("Result window is too large")
        return await super().search(index, body)


def _candidate(i: int, *, source: str, created: str, **extra) -> Case:
    return Case(
        case_id=f"case-{i:05d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=f"198.51.100.{i % 250}"), status=CaseStatus.OPEN,
        awaiting_reason=REASON, created_at=created, updated_at="2026-11-01T00:00:00+00:00",
        source_id=source, **extra,
    )


def _created(i: int) -> str:
    """Distinct, ordered creation times: one second apart from 2026-11-01."""
    return f"2026-11-01T{i // 3600:02d}:{(i // 60) % 60:02d}:{i % 60:02d}+00:00"


async def _seed(store, *, failing: int, healthy: int) -> None:
    """``failing`` oldest candidates from the source that is down, then ``healthy``
    newer candidates from a source that works."""
    for i in range(failing):
        await store.save(_candidate(i, source="src-down", created=_created(i)))
    for i in range(failing, failing + healthy):
        await store.save(_candidate(i, source="src-up", created=_created(i)))


def _wire(app_state, monkeypatch, store, *, unrebuildable: str = "raise") -> list[str]:
    """Point the real stack at ``store``; candidates from ``src-down`` cannot be
    rebuilt (the source raises, or answers ``None``). Returns the drained signatures
    in order. The run is a stub, so a drained candidate stays in the queue."""
    monkeypatch.setattr(app_state, "_real_cases", store)
    drained: list[str] = []

    async def _cluster_for(case):
        if case.source_id == "src-down":
            if unrebuildable == "raise":
                raise ConnectionError("source is down")
            return None
        return SimpleNamespace(signature=case.cluster_signature)

    async def _investigate(cluster, *_args, **_kwargs):
        drained.append(cluster.signature)

    monkeypatch.setattr(app_state, "cluster_for_case", _cluster_for)
    monkeypatch.setattr(app_state.real_pipeline, "investigate_cluster", _investigate)
    return drained


async def _tick(app_state, limit: int) -> int:
    return await app_state.poller._drain_deferred(  # noqa: SLF001
        app_state.prefs, older_than=TICK, limit=limit,
    )


async def _all(store):
    cases, _total = await store.list(limit=100, sort_field="created_at", sort_order="asc")
    for case in cases:
        yield case


@pytest_asyncio.fixture
async def es_store():
    es = _RealisticES()
    store = CaseStore(es)
    return SimpleNamespace(es=es, store=store)


@pytest_asyncio.fixture
async def sql_store():
    from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        yield SqlCaseRepository(engine)
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# The finding: a full page of unrebuildable candidates blocks the healthy ones
# --------------------------------------------------------------------------- #
async def test_a_failing_sources_full_page_never_blocks_healthy_candidates(app_state, monkeypatch, es_store) -> None:
    await _seed(es_store.store, failing=60, healthy=5)
    drained = _wire(app_state, monkeypatch, es_store.store)
    n = await _tick(app_state, limit=3)
    # Drained within the tick, oldest healthy candidates first, never past the allowance.
    assert n == 3 and drained == ["sig-60", "sig-61", "sig-62"]
    assert es_store.es.searches <= 4


async def test_a_page_of_candidates_that_rebuild_to_nothing_never_blocks_either(
    app_state, monkeypatch, es_store,
) -> None:
    await _seed(es_store.store, failing=60, healthy=2)
    drained = _wire(app_state, monkeypatch, es_store.store, unrebuildable="none")
    assert await _tick(app_state, limit=5) == 2 and drained == ["sig-60", "sig-61"]


async def test_the_sql_store_reads_past_a_failing_sources_page(app_state, monkeypatch, sql_store) -> None:
    await _seed(sql_store, failing=60, healthy=5)
    drained = _wire(app_state, monkeypatch, sql_store)
    assert await _tick(app_state, limit=3) == 3 and drained == ["sig-60", "sig-61", "sig-62"]


async def test_a_large_outage_drains_within_a_bounded_number_of_ticks(app_state, monkeypatch, es_store) -> None:
    """More unrebuildable candidates than one tick reads (four pages of 50): each
    stalled tick resumes after the last row the one before it read, so the healthy
    candidates are reached in ceil(500 / 200) ticks; the productive tick then sends
    the next one back to the head of the queue."""
    await _seed(es_store.store, failing=500, healthy=3)
    drained = _wire(app_state, monkeypatch, es_store.store)
    mgr = app_state.poller
    counts = []
    for _ in range(3):
        es_store.es.searches = 0
        counts.append(await _tick(app_state, limit=2))
        assert es_store.es.searches <= 4  # bounded reads every tick
    assert counts == [0, 0, 2] and drained == ["sig-500", "sig-501"]
    assert mgr._drain_resume_after is None  # noqa: SLF001
    # Back at the head: the next tick walks the outage again from the oldest row.
    assert await _tick(app_state, limit=2) == 0
    assert mgr._drain_resume_after is not None  # noqa: SLF001


async def test_a_source_that_recovers_drains_its_oldest_candidates_first(app_state, monkeypatch, es_store) -> None:
    await _seed(es_store.store, failing=60, healthy=5)
    drained = _wire(app_state, monkeypatch, es_store.store)
    assert await _tick(app_state, limit=2) == 2 and drained == ["sig-60", "sig-61"]

    async def _recovered(case):
        return SimpleNamespace(signature=case.cluster_signature)

    monkeypatch.setattr(app_state, "cluster_for_case", _recovered)
    drained.clear()
    assert await _tick(app_state, limit=2) == 2 and drained == ["sig-0", "sig-1"]


async def test_the_drain_never_takes_the_same_candidate_twice_in_a_tick(app_state, monkeypatch, es_store) -> None:
    """A store that answers a continuation with rows it already returned (a quirk of a
    third-party keyset) can never hand one candidate to two runs in one tick."""
    await _seed(es_store.store, failing=0, healthy=3)
    drained = _wire(app_state, monkeypatch, es_store.store)
    from app.stores.base import DeferredCandidates

    rows = [c async for c in _all(es_store.store)]

    async def _repeating(*, older_than, limit, after=None):
        return DeferredCandidates(rows, next_after=["again"])

    monkeypatch.setattr(es_store.store, "list_deferred_candidates", _repeating)
    assert await _tick(app_state, limit=10) == 3 and drained == ["sig-0", "sig-1", "sig-2"]


async def test_an_unreadable_resume_marker_never_wedges_the_drain(app_state, monkeypatch, es_store) -> None:
    await _seed(es_store.store, failing=0, healthy=2)
    drained = _wire(app_state, monkeypatch, es_store.store)
    real = es_store.store.list_deferred_candidates

    async def _rejects_markers(*, older_than, limit, after=None):
        if after is not None:
            raise ValueError("unreadable marker")
        return await real(older_than=older_than, limit=limit)

    monkeypatch.setattr(es_store.store, "list_deferred_candidates", _rejects_markers)
    app_state.poller._drain_resume_after = ["stale"]  # noqa: SLF001
    assert await _tick(app_state, limit=2) == 0
    assert app_state.poller._drain_resume_after is None  # noqa: SLF001
    assert await _tick(app_state, limit=2) == 2 and drained == ["sig-0", "sig-1"]


# --------------------------------------------------------------------------- #
# Stores: the additive keyset, and the old single page for a store without it
# --------------------------------------------------------------------------- #
async def test_a_store_without_the_parameter_keeps_the_old_single_page(app_state, monkeypatch, es_store) -> None:
    await _seed(es_store.store, failing=60, healthy=5)
    drained = _wire(app_state, monkeypatch, es_store.store)
    real = es_store.store.list_deferred_candidates
    asked: list[int] = []

    async def _third_party(*, older_than, limit):  # no ``after``: a plain list
        asked.append(limit)
        return list(await real(older_than=older_than, limit=limit))

    monkeypatch.setattr(es_store.store, "list_deferred_candidates", _third_party)
    assert await _tick(app_state, limit=3) == 0 and drained == []
    assert asked == [50]
    assert app_state.poller._drain_resume_after is None  # noqa: SLF001


async def test_the_elasticsearch_keyset_walks_the_queue_without_offsets(es_store) -> None:
    await _seed(es_store.store, failing=0, healthy=7)
    from app.stores.base import DeferredCandidates

    first = await es_store.store.list_deferred_candidates(older_than=TICK, limit=3)
    assert isinstance(first, DeferredCandidates) and first.next_after is not None
    second = await es_store.store.list_deferred_candidates(older_than=TICK, limit=3, after=first.next_after)
    third = await es_store.store.list_deferred_candidates(older_than=TICK, limit=3, after=second.next_after)
    ids = [c.case_id for c in [*first, *second, *third]]
    assert ids == [f"case-{i:05d}" for i in range(7)]
    assert third.next_after is None  # a short page is the end of the queue


async def test_the_sql_keyset_breaks_creation_ties_on_the_case_id(sql_store) -> None:
    for i in (4, 1, 3, 0, 2):  # one creation instant for every row
        await sql_store.save(_candidate(i, source="src-up", created="2026-11-01T00:00:00+00:00"))
    # Not drainable: a person's candidate and one deferred in this tick.
    await sql_store.save(_candidate(9, source="src-up", created="2026-11-01T00:00:00+00:00",
                                    decision_by=DecisionBy.ANALYST))
    first = await sql_store.list_deferred_candidates(older_than=TICK, limit=2)
    second = await sql_store.list_deferred_candidates(older_than=TICK, limit=2, after=first.next_after)
    third = await sql_store.list_deferred_candidates(older_than=TICK, limit=2, after=second.next_after)
    assert [c.case_id for c in [*first, *second, *third]] == [f"case-{i:05d}" for i in range(5)]
    assert third.next_after is None
    # An unreadable marker reads from the head, never an error.
    head = await sql_store.list_deferred_candidates(older_than=TICK, limit=2, after={"x": 1})
    assert [c.case_id for c in head] == ["case-00000", "case-00001"]


async def test_the_base_default_continues_its_open_scan(es_store) -> None:
    """A third-party store that inherits the base default gets the same continuation:
    its marker is the offset in the OPEN listing after the last row it examined."""
    await _seed(es_store.store, failing=0, healthy=5)
    # A person's candidate, created with case-00002: examined, never returned.
    await es_store.store.save(_candidate(50, source="src-up", created=_created(2),
                                         decision_by=DecisionBy.ANALYST).model_copy(update={"case_id": "case-person"}))
    store = es_store.store
    first = await CaseRepository.list_deferred_candidates(store, older_than=TICK, limit=2)
    assert [c.case_id for c in first] == ["case-00000", "case-00001"]
    rest = await CaseRepository.list_deferred_candidates(store, older_than=TICK, limit=10, after=first.next_after)
    assert [c.case_id for c in rest] == ["case-00002", "case-00003", "case-00004"]
    assert rest.next_after is None
