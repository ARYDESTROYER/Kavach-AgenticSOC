"""The Case Manager queue scan is exact AND bounded (Round 12 final review, L1-0 F3).

``GET /api/cases`` with ``q`` / ``assignee`` / ``severity`` / ``verdict`` (or the Title
order) answers from one exact scan of the whole store. Before this fix that scan read
WHOLE case documents (evidence included), kept every matching document in memory
until the scan ended, and validated rows on the event loop — a broad search on a large
store held hundreds of MB and stalled chat streams, SSE and ingest on every keystroke.

Now it reads a projection (``CASE_QUEUE_SCAN_FIELDS``), keeps only the ``offset +
limit`` best ``(sort key, case id)`` pairs while counting every match, runs large
pages' predicate work in a worker thread, and reads only the requested page's full
cases by id. These tests pin that the answers did not change and that the bounds hold.
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.api import routes
from app.api.routes import CASE_QUEUE_OFFLOAD_AT, CASE_QUEUE_SCAN_FIELDS
from app.constants import CaseStatus, Verdict
from app.models import TriggerReason
from app.stores.cases import CaseStore
from app.stores.sql import SqlCaseRepository, build_async_engine, create_all
from app.es.fake import InMemoryESClient
from tests.test_round12_case_manager import _case, _queue, _seed, client, now  # noqa: F401


def _expected(cases: list[Any], *, field: str, order: str, keep) -> list[str]:  # noqa: ANN001
    rows = [c for c in cases if keep(c)]
    rows.sort(key=lambda c: routes._queue_sort_key(c.model_dump(mode="json"), field),
              reverse=order == "desc")
    return [c.case_id for c in rows]


def test_pages_and_totals_match_a_full_sort_in_every_order(client, now) -> None:  # noqa: F811
    cases = [
        _case(i, now, title=f"T{(37 * i) % 97:02d}", risk=float((13 * i) % 100),
              status=CaseStatus.CLOSED if i % 5 == 0 else CaseStatus.OPEN)
        for i in range(260)
    ]
    _seed(client, cases)
    for field, order in (("title", "asc"), ("title", "desc"), ("risk_score", "asc"),
                         ("risk_score", "desc"), ("updated_at", "desc"), ("created_at", "asc")):
        expected = _expected(cases, field=field, order=order, keep=lambda c: True)
        got: list[str] = []
        for offset in (0, 50, 100, 150, 200, 250):
            body = _queue(client, q="case", sort_field=field, sort_order=order,
                          limit=50, offset=offset)
            assert body["total"] == 260, (field, order)
            got += [c["case_id"] for c in body["cases"]]
        assert got == expected, (field, order)
    # A filtered order: the open cases only, newest update first, a deep page.
    expected_open = _expected(cases, field="updated_at", order="desc",
                              keep=lambda c: c.status == CaseStatus.OPEN)
    body = _queue(client, q="splunk", status_group="active", sort_field="updated_at",
                  sort_order="desc", limit=20, offset=180)
    assert body["total"] == len(expected_open) == 208
    assert [c["case_id"] for c in body["cases"]] == expected_open[180:200]
    # Every returned case is the FULL document (advisory bands added), not the projection.
    first = body["cases"][0]
    assert first["cluster_signature"] and first["entity"]["value"] and "severity_band" in first


def test_the_scan_reads_a_projection_and_only_the_page_in_full(client, now, monkeypatch) -> None:  # noqa: F811
    _seed(client, [_case(i, now) for i in range(120)])
    state = client.app.state.tlsoc
    store = state._real_cases
    scans: list[dict[str, Any]] = []
    batches: list[list[str]] = []
    original_scan, original_many = store.scan_page, store.get_many

    async def recording_scan(**kw):  # noqa: ANN003
        scans.append(kw)
        rows, cursor, total, consistency = await original_scan(**kw)
        # The in-memory store honours the projection like Elasticsearch does.
        assert all(set(row) <= set(CASE_QUEUE_SCAN_FIELDS) for row in rows)
        return rows, cursor, total, consistency

    async def recording_many(ids):  # noqa: ANN001
        batches.append(list(ids))
        return await original_many(ids)

    monkeypatch.setattr(store, "scan_page", recording_scan)
    monkeypatch.setattr(store, "get_many", recording_many)
    body = _queue(client, q="case", limit=25, offset=10)
    assert body["total"] == 120 and len(body["cases"]) == 25
    assert scans and all(kw["fields"] == list(CASE_QUEUE_SCAN_FIELDS) and kw["raw"] for kw in scans)
    # Only the requested page is read in full, in one batch.
    assert len(batches) == 1 and len(batches[0]) == 25
    assert batches[0] == [c["case_id"] for c in body["cases"]]


def test_severity_from_the_source_survives_the_projection(client, now) -> None:  # noqa: F811
    """The displayed band comes from ``trigger_reason.severity_max`` (source asserted),
    not from the low risk score: the projection must carry it."""
    asserted = _case(1, now, risk=5.0)
    asserted.trigger_reason = TriggerReason(severity_max=95.0)
    _seed(client, [asserted, _case(2, now, risk=5.0), _case(3, now, risk=90.0)])
    critical = _queue(client, severity="critical")
    assert sorted(c["case_id"] for c in critical["cases"]) == ["case-0001", "case-0003"]
    assert critical["total"] == 2
    info = _queue(client, severity="info")
    assert [c["case_id"] for c in info["cases"]] == ["case-0002"]


def test_large_pages_are_matched_off_the_event_loop(client, now, monkeypatch) -> None:  # noqa: F811
    _seed(client, [_case(i, now, verdict=Verdict.FALSE_POSITIVE if i % 2 else Verdict.NEEDS_HUMAN)
                   for i in range(CASE_QUEUE_OFFLOAD_AT + 40)])
    offloaded: list[str] = []
    real = asyncio.to_thread

    async def recording(fn, *args, **kwargs):  # noqa: ANN001, ANN003
        offloaded.append(getattr(getattr(fn, "func", fn), "__name__", ""))
        return await real(fn, *args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", recording)
    body = _queue(client, verdict="NEEDS_HUMAN", limit=10)
    assert body["total"] == (CASE_QUEUE_OFFLOAD_AT + 40 + 1) // 2
    assert "_queue_page_matches" in offloaded


def test_a_case_removed_after_the_scan_is_left_out_of_the_page(client, now, monkeypatch) -> None:  # noqa: F811
    _seed(client, [_case(i, now) for i in range(5)])
    store = client.app.state.tlsoc._real_cases
    original = store.get_many

    async def without_one(ids):  # noqa: ANN001
        found = await original(ids)
        found.pop("case-0002", None)
        return found

    async def gone(case_id):  # noqa: ANN001
        return None

    monkeypatch.setattr(store, "get_many", without_one)
    monkeypatch.setattr(store, "get", gone)
    body = _queue(client, q="case", limit=10)
    assert "case-0002" not in [c["case_id"] for c in body["cases"]]
    assert len(body["cases"]) == 4


def test_get_many_on_both_bundled_stores(now) -> None:  # noqa: F811
    async def go() -> tuple[set[str], set[str]]:
        es_store = CaseStore(InMemoryESClient())
        engine = build_async_engine("sqlite+aiosqlite:///:memory:")
        await create_all(engine)
        sql_store = SqlCaseRepository(engine)
        for i in range(4):
            await es_store.save(_case(i, now))
            await sql_store.save(_case(i, now))
        wanted = ["case-0001", "case-0003", "case-9999"]
        es_found = await es_store.get_many(wanted)
        sql_found = await sql_store.get_many(wanted)
        assert await es_store.get_many([]) == {} and await sql_store.get_many([]) == {}
        await engine.dispose()
        return set(es_found), set(sql_found)

    es_ids, sql_ids = asyncio.run(go())
    assert es_ids == sql_ids == {"case-0001", "case-0003"}
