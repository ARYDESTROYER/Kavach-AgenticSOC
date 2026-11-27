"""SQL ``scan_page(newest_first=True)`` is newest first by REAL creation time.

PR #131 review (Codex P2): the SQL case repository used to read every row whose
``created_at`` COLUMN is not in the one canonical spelling (empty, or a legacy
``...Z`` / non-UTC-offset value written before the column was normalised) BEFORE any
canonical row, ordered by case id. The dashboards' population reader keeps rows in
read order and stops at its retention ceiling, so on a store holding more cases than
the ceiling it analysed arbitrary legacy rows and left out the genuinely newest cases,
while reporting "the newest N were analysed". Elasticsearch never did this: it sorts the
``created_at`` date newest first with a missing or unreadable date last.

The repository now merges the legacy rows into the canonical descending stream at
their real instant (parsed in Python by the same parser the column normaliser and the
engine use), with an unplaceable timestamp last, behind a small resumable keyset. These
tests pin that on SQLite, with many legacy rows, a reader limit smaller than the store,
pages smaller than the store, a row re-saved mid-scan, and Elasticsearch parity.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.api import metrics_shared
from app.api.metrics_shared import fetch_case_population
from app.constants import CASES_WRITE_ALIAS, CaseStatus, EntityType, SourceSurface
from app.engine.case_aggregate import scan_cases
from app.es.fake import InMemoryESClient
from app.models import Case, Entity
from app.stores.cases import CaseStore
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all
from app.stores.sql.models import CaseRow
from app.utils import parse_es_timestamp

UTC = timezone.utc
NOW = datetime.now(UTC).replace(microsecond=0)

_ENGINES: list[Any] = []


@pytest.fixture(autouse=True)
async def _dispose_engines():
    metrics_shared.invalidate_case_page_cache()
    yield
    metrics_shared.invalidate_case_page_cache()
    while _ENGINES:
        await _ENGINES.pop().dispose()


def _case(cid: str, created_at: str, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid,
        "cluster_signature": f"sig-{cid}",
        "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"),
        "created_at": created_at,
    }
    base.update(kw)
    return Case(**base)


def _ago(**delta: float) -> datetime:
    return NOW - timedelta(**delta)


def _z(dt: datetime) -> str:
    """The ``...Z`` spelling an older writer could have stored."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _minus5(dt: datetime) -> str:
    """The same instant at UTC-5 (string order places it hours wrong)."""
    return dt.astimezone(timezone(timedelta(hours=-5))).isoformat()


async def _repo() -> SqlCaseRepository:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    _ENGINES.append(engine)
    await create_all(engine)
    return SqlCaseRepository(engine)


async def _store_legacy(repo: SqlCaseRepository, case: Case, spelling: str) -> None:
    """Write ``case`` with a legacy ``created_at`` in the column AND the document, as a
    version before the column normalisation stored it (no re-save has healed it)."""
    from sqlalchemy import select

    await repo.save(case)
    async with repo._sm() as session:
        row = (await session.execute(
            select(CaseRow).where(CaseRow.case_id == case.case_id)
        )).scalar_one()
        row.created_at = spelling
        row.doc = {**dict(row.doc), "created_at": spelling}
        await session.commit()


async def _drain(repo: Any, *, page: int, **kw: Any) -> list[str]:
    """Every case id of a ``newest_first`` scan, page by page."""
    ids: list[str] = []
    cursor: Any = None
    while True:
        rows, cursor, _total, _consistency = await repo.scan_page(
            limit=page, cursor=cursor, newest_first=True, **kw,
        )
        ids.extend(r["case_id"] if isinstance(r, dict) else r.case_id for r in rows)
        if cursor is None:
            return ids


def _true_order(spec: list[tuple[str, str]]) -> list[str]:
    """(case_id, created_at) → ids newest first by real instant, then case id
    descending; an unplaceable timestamp last (Elasticsearch's ``missing: _last``)."""
    def key(item: tuple[str, str]) -> tuple[float, str]:
        dt = parse_es_timestamp(item[1])
        return (dt.timestamp() if dt is not None else float("-inf"), item[0])

    return [cid for cid, _ in sorted(spec, key=key, reverse=True)]


async def _seed_mixed(repo: SqlCaseRepository) -> list[tuple[str, str]]:
    """A store whose legacy rows OUTNUMBER the reader limits used below.

    * 40 legacy rows, 10 to 50 days old, in ``Z`` and UTC-5 spellings;
    * 3 legacy rows that are NEWER than most canonical rows (an upgraded deployment's
      recent pre-normalisation writes), in the UTC-5 spelling string order misplaces;
    * 2 rows whose ``created_at`` cannot be placed in time at all;
    * 12 canonical rows, 1 to 12 hours old.
    """
    spec: list[tuple[str, str]] = []
    for i in range(40):
        dt = _ago(days=10 + i, minutes=i)
        spelling = _z(dt) if i % 2 else _minus5(dt)
        cid = f"legacy-old-{i:02d}"
        await _store_legacy(repo, _case(cid, dt.isoformat()), spelling)
        spec.append((cid, spelling))
    for i, hours in enumerate((1.5, 4.5, 7.5)):
        dt = _ago(hours=hours)
        cid = f"legacy-new-{i}"
        await _store_legacy(repo, _case(cid, dt.isoformat()), _minus5(dt))
        spec.append((cid, _minus5(dt)))
    for cid, bad in (("undated-a", ""), ("undated-b", "not a timestamp")):
        await _store_legacy(repo, _case(cid, NOW.isoformat()), bad)
        spec.append((cid, bad))
    for i in range(12):
        dt = _ago(hours=1 + i)
        cid = f"canon-{i:02d}"
        await repo.save(_case(cid, dt.isoformat()))
        spec.append((cid, dt.isoformat()))
    return spec


# --------------------------------------------------------------------------- #
# The scan itself
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("page", [1, 3, 7, 1000])
async def test_newest_first_is_real_time_order_across_legacy_and_canonical(page) -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    ids = await _drain(repo, page=page)
    # Every row exactly once (never-drop, no duplicate), in the true newest-first order:
    # the recent legacy rows interleave with the canonical ones at their real instant,
    # the old legacy rows follow, the unplaceable ones come last.
    assert ids == _true_order(spec)
    assert ids[-2:] == ["undated-b", "undated-a"]
    assert ids[:4] == ["canon-00", "legacy-new-0", "canon-01", "canon-02"]


async def test_raw_pages_and_status_prefilter_keep_the_order() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    closed = {"canon-03", "legacy-new-1", "legacy-old-07", "undated-a"}
    for cid in closed:
        case = await repo.get(cid)
        assert case is not None
        # ``save`` heals the column (canonical spelling, or "" when unreadable); the
        # order must not care which side of the healing a row is on.
        await repo.save(case.model_copy(update={"status": CaseStatus.CLOSED}))
    ids = await _drain(repo, page=2, raw=True, statuses=[CaseStatus.CLOSED.value])
    assert ids == _true_order([s for s in spec if s[0] in closed])


async def test_window_prefilter_still_never_drops_an_unplaceable_row() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    ids = await _drain(repo, page=4, created_from=_ago(hours=24), created_to=NOW)
    # The pre-filter may over-keep (the caller re-checks every row); it never under-keeps:
    # every in-window row is there, newest first, and an unplaceable row is kept, last.
    in_window = [cid for cid, raw in spec
                 if (dt := parse_es_timestamp(raw)) is not None and _ago(hours=24) <= dt < NOW]
    assert [i for i in ids if i in in_window] == _true_order(
        [s for s in spec if s[0] in in_window])
    assert ids[-2:] == ["undated-b", "undated-a"]


async def test_a_row_healed_mid_scan_is_read_exactly_once() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    seen: list[str] = []
    cursor: Any = None
    healed = False
    while True:
        rows, cursor, _total, _c = await repo.scan_page(limit=5, cursor=cursor, newest_first=True)
        seen.extend(r.case_id for r in rows)
        if not healed:
            # Re-save legacy rows both AHEAD of and BEHIND the cursor: the column moves
            # from the legacy spelling to the canonical one at the SAME stream position.
            for cid in ("legacy-new-2", "legacy-old-30", "legacy-new-0"):
                case = await repo.get(cid)
                assert case is not None
                await repo.save(case)
            healed = True
        if cursor is None:
            break
    assert seen == _true_order(spec)


async def test_a_store_without_legacy_rows_stops_looking_for_them() -> None:
    repo = await _repo()
    for i in range(6):
        await repo.save(_case(f"c{i}", _ago(hours=i + 1).isoformat()))
    rows, cursor, total, _c = await repo.scan_page(limit=2, newest_first=True)
    assert [r.case_id for r in rows] == ["c0", "c1"] and total == 6
    # The keyset stays two scalars; no legacy row means later pages skip that read.
    assert cursor["after"] == [_ago(hours=2).isoformat(), "c1"]
    assert cursor["legacy_next"] is None
    assert await _drain(repo, page=2) == [f"c{i}" for i in range(6)]


def _is_legacy_key_read(statement: str) -> bool:
    """The legacy ``(created_at, case_id)`` read: the one newest-first statement that
    cannot use the ``created_at`` index (it selects no document)."""
    return " ".join(statement.split()).startswith(
        "SELECT cases.created_at, cases.case_id FROM cases WHERE")


async def _statements_per_page(
    repo: SqlCaseRepository, page: int,
) -> tuple[list[int], list[int], list[int]]:
    """(SQL statements, rows returned, legacy key reads) for every page of a
    newest-first scan."""
    from sqlalchemy import event

    engine = _ENGINES[-1].sync_engine
    executed: list[str] = []

    def after_execute(conn, cursor, statement, parameters, context, executemany):
        executed.append(statement)

    event.listen(engine, "after_cursor_execute", after_execute)
    statements: list[int] = []
    rows_per_page: list[int] = []
    legacy_reads: list[int] = []
    try:
        cursor: Any = None
        while True:
            before = len(executed)
            rows, cursor, _t, _c = await repo.scan_page(limit=page, cursor=cursor,
                                                        newest_first=True)
            statements.append(len(executed) - before)
            rows_per_page.append(len(rows))
            legacy_reads.append(sum(map(_is_legacy_key_read, executed[before:])))
            if cursor is None:
                return statements, rows_per_page, legacy_reads
    finally:
        event.remove(engine, "after_cursor_execute", after_execute)


async def test_a_store_without_legacy_rows_reads_one_keyset_page_per_call() -> None:
    repo = await _repo()
    for i in range(10):
        await repo.save(_case(f"c{i}", _ago(hours=i + 1).isoformat()))
    statements, rows, legacy_reads = await _statements_per_page(repo, 3)
    assert rows == [3, 3, 3, 1]
    # Page 1: the (empty) legacy key read, the canonical keyset page, the total COUNT.
    # Middle pages: the canonical keyset page alone. Last page: plus the undated keys.
    assert statements == [3, 1, 1, 2]
    assert legacy_reads == [1, 0, 0, 0]


async def test_a_mixed_store_reads_a_bounded_number_of_statements_per_page() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    statements, rows, _legacy_reads = await _statements_per_page(repo, 4)
    assert sum(rows) == len(spec) and max(rows) <= 4
    # First page: legacy keys, canonical page, undated keys, chosen documents, COUNT.
    # A page that reaches a legacy row: the index-only head, then the same four.
    assert max(statements) <= 5

    # PR #131 review: ONE old legacy row behind a large canonical store must not make
    # every page re-read the legacy keys (that read cannot use the index: a full table
    # scan per page). The cursor carries the newest legacy key left behind the keyset,
    # so the legacy keys are read on the first page and on the page that reaches that
    # row, and every page between them is a single index-range read.
    repo = await _repo()
    for i in range(30):
        await repo.save(_case(f"c{i:02d}", _ago(hours=i + 1).isoformat()))
    old = _ago(days=3650)
    await _store_legacy(repo, _case("old-legacy", old.isoformat()), _z(old))
    statements, rows, legacy_reads = await _statements_per_page(repo, 4)
    assert rows == [4, 4, 4, 4, 4, 4, 4, 3]
    assert legacy_reads == [1, 0, 0, 0, 0, 0, 0, 1]
    # Last page: the head (c28, c29), the legacy keys, the (empty) canonical and
    # undated remainders, then the legacy row's document by id.
    assert statements == [3, 1, 1, 1, 1, 1, 1, 5]
    assert await _drain(repo, page=4) == [f"c{i:02d}" for i in range(30)] + ["old-legacy"]


async def test_the_carried_legacy_key_stays_exact_when_rows_change_mid_scan() -> None:
    repo = await _repo()
    spec: list[tuple[str, str]] = []
    for i in range(12):
        dt = _ago(hours=i + 1)
        await repo.save(_case(f"c{i:02d}", dt.isoformat()))
        spec.append((f"c{i:02d}", dt.isoformat()))
    # Two legacy rows inside the canonical run and one far behind it.
    for cid, dt in (("legacy-a", _ago(hours=6.5)), ("legacy-b", _ago(hours=9.5)),
                    ("legacy-z", _ago(days=400))):
        await _store_legacy(repo, _case(cid, dt.isoformat()), _minus5(dt))
        spec.append((cid, _minus5(dt)))
    rows, cursor, _t, _c = await repo.scan_page(limit=3, newest_first=True)
    seen = [r.case_id for r in rows]
    assert seen == ["c00", "c01", "c02"]
    # The newest legacy row behind the keyset, at its REAL instant.
    assert cursor["legacy_next"] == [_ago(hours=6.5).isoformat(), "legacy-a"]
    # While the cursor still sits ahead of it: that very row is healed (its column
    # moves to the canonical spelling at the SAME position), another legacy row is
    # deleted, and a new canonical row lands between the keyset and the carried key.
    healed = await repo.get("legacy-a")
    assert healed is not None
    await repo.save(healed)
    from sqlalchemy import delete

    async with repo._sm() as session:
        await session.execute(delete(CaseRow).where(CaseRow.case_id == "legacy-b"))
        await session.commit()
    late = _ago(hours=5.25)
    await repo.save(_case("c-late", late.isoformat()))
    spec = [s for s in spec if s[0] != "legacy-b"] + [("c-late", late.isoformat())]
    while cursor is not None:
        rows, cursor, _t, _c = await repo.scan_page(limit=3, cursor=cursor,
                                                    newest_first=True)
        seen.extend(r.case_id for r in rows)
    # Every row once, in the true order: the healed row at its old position, the new
    # row at its own, the deleted one gone, the old legacy row last.
    assert seen == _true_order(spec)
    assert seen.count("legacy-a") == 1 and seen[-1] == "legacy-z"


async def test_ascending_scan_is_unchanged_and_still_complete() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    ids: list[str] = []
    cursor: Any = None
    while True:
        rows, cursor, _t, _c = await repo.scan_page(limit=6, cursor=cursor)
        ids.extend(r.case_id for r in rows)
        if cursor is None:
            break
    assert sorted(ids) == sorted(cid for cid, _ in spec) and len(ids) == len(set(ids))


async def test_sql_matches_elasticsearch_newest_first_order() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    es = InMemoryESClient()
    for cid, raw in spec:
        case = await repo.get(cid)
        assert case is not None
        doc = case.model_dump(mode="json") | {"created_at": raw}
        await es.index_doc(CASES_WRITE_ALIAS, doc, doc_id=cid)
    es_ids = await _drain(CaseStore(es), page=4)
    assert await _drain(repo, page=4) == es_ids == _true_order(spec)


# --------------------------------------------------------------------------- #
# The dashboards' population reader (the caller that stops early)
# --------------------------------------------------------------------------- #
async def test_population_ceiling_keeps_the_true_newest_cases_on_sql() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    # 57 cases, 45 of them legacy, a ceiling of 5: the five genuinely newest are read,
    # and the population is honestly a truncated newest-first prefix of the store.
    pop = await fetch_case_population(repo, span_hours=None, limit=5)
    assert [c.case_id for c in pop.cases] == _true_order(spec)[:5]
    assert not any(c.case_id.startswith(("legacy-old", "undated")) for c in pop.cases)
    assert pop.newest_first and not pop.complete
    assert pop.fetched == 5 and pop.scope_total == len(spec)
    assert "newest 5" in pop.error


async def test_bounded_window_population_reads_legacy_rows_at_their_instant() -> None:
    repo = await _repo()
    spec = await _seed_mixed(repo)
    pop = await fetch_case_population(repo, span_hours=24, limit=8)
    in_day = [s for s in spec
              if (dt := parse_es_timestamp(s[1])) is not None and dt >= _ago(hours=24)]
    assert len(in_day) == 15
    assert [c.case_id for c in pop.cases] == _true_order(in_day)[:8]
    assert not pop.complete and pop.scope_total == 15


async def test_scan_cases_stop_after_the_ceiling_never_reads_old_legacy_rows() -> None:
    repo = await _repo()
    await _seed_mixed(repo)
    seen: list[str] = []

    def consume(rows: list[Any]) -> None:
        seen.extend(r["case_id"] if isinstance(r, dict) else r.case_id for r in rows)

    outcome = await scan_cases(repo, consume, page_size=4, raw=True, newest_first=True,
                               stop=lambda: len(seen) >= 8)
    assert outcome.newest_first and outcome.stopped
    assert len(seen) == 8 and not any(s.startswith("legacy-old") for s in seen)
