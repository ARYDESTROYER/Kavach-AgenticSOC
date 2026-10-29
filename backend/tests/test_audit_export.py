"""Round 14 SPEC §4.5.6: the audit log export (job kind ``audit_export``).

Covers the shared CSV formula-defusal fixture, the CSV and JSON Lines writers, the
column set, the absolute-instant contract, the export reader over the fake
Elasticsearch and SQLite (oldest first, one snapshot, a checkpoint at every page
boundary, the cap, a store that cannot count exactly and a read that ends early), the
durable job (the count re-check, the audited attach, the failure row, a cancel at a
page boundary, the file removed on every failure) and the submit route (the acceptance
export of 1,284 rows that matches the page query exactly, SHA-256 equal to the file,
fresh sign-in, ``audit:export`` for the auditor and not for an analyst, ``429
job_busy``, idempotent retries, audit before visible, the coded refusals and Demo
Mode). Offline: fake Elasticsearch, SQLite, mock LLM.
"""

from __future__ import annotations

import csv
import errno
import hashlib
import io
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api import routes_audit
from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_audit import router as audit_router
from app.api.routes_jobs import AuditExportParams
from app.api.routes_jobs import router as jobs_router
from app.audit.query import AuditFilters, build_predicate, matches
from app.config import Secrets
from app.constants import JobKind, JobStatus
from app.engine import audit_export
from app.engine.audit_export import (
    CSV_COLUMNS,
    FORMULA_LEADS,
    AuditExportExpired,
    AuditExportIncomplete,
    AuditExportNoSpace,
    AuditExportTooLarge,
    AuditExportUnreadable,
    AuditExportUnverifiable,
    csv_field,
    csv_record,
    defuse_formula,
    export_file_name,
    export_filters,
    jsonl_line,
    parse_instant,
    submission_cap,
    write_export,
)
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import (
    AuditDoc,
    AuditRecord,
    Job,
    JobPermission,
    JobProgress,
    JobTransition,
)
from app.state import AppState
from app.stores.base import AuditCursorExpired, AuditHit, AuditSearchPage
from app.stores.jobs import idempotency_hash
from app.utils import iso_now

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "webui" / "src" / "lib" / "csv-formula.contract.json"
BASE = datetime(2026, 10, 18, 15, 10, tzinfo=timezone.utc)
FROM = "2026-10-18T15:10:00Z"
TO = "2026-10-25T15:10:00Z"
TERMINAL = {"succeeded", "failed", "cancelled", "partial"}


def _ts(seconds: int) -> str:
    return (BASE + timedelta(seconds=seconds)).isoformat()


def _params(**overrides: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "format": "csv",
        "scope": "all",
        "from": FROM,
        "to": TO,
        "order": "asc",
        "filters": {},
    }
    out.update(overrides)
    return out


def _corpus(n: int, *, needle_every: int = 0) -> list[dict[str, Any]]:
    """``n`` audit rows inside the export range. Every ``needle_every``-th row (when
    set) does NOT carry the search term ``needle``; the rest do. Hostile values ride
    along: formula leads, quotes, line breaks, non-ASCII and untrusted fences."""
    hostile = [
        '=HYPERLINK("http://evil.example","click")',
        "+cmd|' /C calc'!A0",
        "-2+3",
        "@SUM(A1:A9)",
        "\tlead tab",
        "  =spaces first",
        "＝full width",
        'quoted "value", with a comma',
        "line one\r\nline two",
        "École fermée <<<UNTRUSTED>>> 10.0.0.5 <<<END>>>",
    ]
    rows: list[dict[str, Any]] = []
    for i in range(n):
        skip = bool(needle_every) and i % needle_every == 0
        rows.append({
            "ts": _ts(i * 7),
            "action_type": "status" if i % 2 else "auth",
            "surface": "settings" if i % 3 == 0 else "r14",
            "actor": f"user{i % 5}",
            "result_summary": f"{'other' if skip else 'needle'} row {i}: {hostile[i % len(hostile)]}",
            "tool_input": {"mark": i, "text": hostile[(i + 3) % len(hostile)]},
            **({"action": "settings.updated", "outcome": "success", "actor_type": "human",
                "target": {"type": "setting", "id": "auto_close", "label": "=Auto-close"},
                "changes": [{"field": "auto_close.enabled", "before": "true", "after": "false"}]}
               if i % 4 == 0 else {}),
        })
    return rows


async def _write_rows(state: AppState, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        await state.control_audit.write_strict(AuditDoc.model_validate(row))


def _secrets(tmp_path: Path, backend: str, **extra: Any) -> Secrets:
    more: dict[str, Any] = {}
    if backend == "sql":
        more = {"state_backend": "sqlite", "state_db_url": f"sqlite+aiosqlite:///{tmp_path}/state.db"}
    return Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        jobs_artifact_dir=str(tmp_path / "artifacts"),
        **more,
        **extra,
    )


def _overrides() -> dict[str, Any]:
    mock = MockProvider()
    return {"anthropic": mock, "openai": mock, "mock": mock}


# --------------------------------------------------------------------------- #
# The shared formula-defusal fixture and the CSV writer
# --------------------------------------------------------------------------- #
def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_fixture_leads_are_the_writer_leads():
    data = _fixture()
    assert set(data["leads"]) == set(FORMULA_LEADS)
    # The extensions SPEC §4.5.6 names beyond the old client rule.
    assert {"\n", "＝", "＋", "－", "＠"} <= set(data["leads"])


@pytest.mark.parametrize("case", _fixture()["cases"], ids=lambda c: c["note"])
def test_the_writer_follows_every_fixture_case(case):
    value = case["value"]
    if isinstance(value, str):
        assert defuse_formula(value) == case["defused"]
    assert csv_field(value) == case["csv"]


def test_the_fixture_covers_every_lead_alone_and_after_spaces():
    texts = [c["value"] for c in _fixture()["cases"] if isinstance(c["value"], str)]
    for lead in FORMULA_LEADS:
        assert any(t.startswith(lead) for t in texts), repr(lead)
    assert any(t.startswith(" ") and defuse_formula(t) != t for t in texts)
    assert any(t.strip(" ") == "" for t in texts)  # spaces alone are never defused


def test_the_fixture_copy_has_no_em_dash():
    raw = FIXTURE.read_text(encoding="utf-8")
    assert "\u2014" not in raw and "\u2013" not in raw


def test_records_end_in_crlf_and_round_trip_through_a_csv_reader():
    hostile = ['=1+1', 'a "quoted", text', "two\r\nlines", None, 7, True]
    line = csv_record(hostile)
    assert line.endswith("\r\n")
    parsed = next(csv.reader(io.StringIO(line, newline="")))
    assert parsed == ["'=1+1", 'a "quoted", text', "two\r\nlines", "", "7", "true"]


def test_the_columns_cover_every_record_field():
    flattened: set[str] = set()
    for name in AuditRecord.model_fields:
        if name == "target":
            flattened |= {"target.type", "target.id", "target.label", "target.revision"}
        elif name == "client":
            flattened |= {"client.ip", "client.ip_source", "client.peer",
                          "client.forwarded_for", "client.user_agent"}
        else:
            flattened.add(name)
    assert set(CSV_COLUMNS) == flattened
    assert len(CSV_COLUMNS) == len(set(CSV_COLUMNS))


def test_json_lines_keep_the_stored_row_and_survive_a_lone_surrogate():
    doc = {"ts": _ts(0), "actor": "zoë", "tool_input": {"a": [1, None]}, "result_summary": "=x"}
    assert json.loads(jsonl_line(doc)) == doc
    assert jsonl_line(doc).endswith(b"\n")
    odd = {"actor": "bad \ud800 half"}
    line = jsonl_line(odd)
    line.decode("utf-8")  # valid UTF-8
    assert json.loads(line) == odd  # the same JSON value, carried by an escape


# --------------------------------------------------------------------------- #
# The question: absolute instants, filters, the file name
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("raw", ["2026-10-18T15:10:00Z", "2026-10-18T17:10:00+02:00",
                                 "2026-10-18T15:10Z", "2026-10-18T15:10:00.123456z"])
def test_absolute_instants_are_accepted(raw):
    assert parse_instant(raw, "from").tzinfo is not None


@pytest.mark.parametrize("raw", ["now-7d", "now", "2026-10-18", "2026-10-18T15:10:00",
                                 "1760800200000", "", None, "2026-13-40T99:99:99Z",
                                 # Parse, but have no UTC instant (the calendar's edges).
                                 "0001-01-01T00:00:00+01:00", "9999-12-31T23:59:59-01:00"])
def test_relative_or_zoneless_times_are_refused(raw):
    with pytest.raises(HTTPException) as caught:
        parse_instant(raw, "from")
    assert caught.value.status_code == 422
    assert caught.value.detail["code"] == "audit_invalid_time"


def _read_api_filters(from_: str, to: str, **extra: Any) -> AuditFilters:
    """What ``GET /api/audit`` and ``GET /api/audit/count`` build for the same query."""
    names = ("scope", "q", "action", "event", "actor", "actor_contains", "actor_kind",
             "outcome", "surface", "case_id", "source_id", "target", "ip")
    return routes_audit._filters(  # noqa: SLF001 (the read API's own resolution)
        **{name: extra.get(name) for name in names}, from_=from_, to=to,
    )


def test_filters_match_the_read_api_and_never_read_past_submission():
    params = _params(scope="people", q="needle", filters={"actor": "user1", "outcome": "failure"})
    built = export_filters(params)
    assert (built.scope, built.q, built.actor, built.outcome) == ("people", "needle", "user1", "failure")
    # The read API's own reading of the two instants: a ``to`` given to the second
    # covers that whole second (at the millisecond, as the store keeps time).
    page = _read_api_filters(FROM, TO, scope="people", q="needle", actor="user1", outcome="failure")
    assert built == page
    assert built.ts_from == BASE
    assert built.ts_to == datetime(2026, 10, 25, 15, 10, 0, 999_999, tzinfo=timezone.utc)
    # Submitted inside the range: the read ends before the submission's millisecond.
    submitted = datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc)
    assert export_filters(params, read_until=submitted).ts_to == submitted - timedelta(microseconds=1)
    later = datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert export_filters(params, read_until=later).ts_to == built.ts_to


@pytest.mark.parametrize(("submitted", "cap"), [
    # Microseconds into a millisecond: the end of the millisecond before it.
    (datetime(2026, 10, 20, 0, 0, 0, 123_456, tzinfo=timezone.utc),
     datetime(2026, 10, 20, 0, 0, 0, 122_999, tzinfo=timezone.utc)),
    # Exactly on a millisecond: that millisecond is left out too.
    (datetime(2026, 10, 20, 0, 0, 0, 123_000, tzinfo=timezone.utc),
     datetime(2026, 10, 20, 0, 0, 0, 122_999, tzinfo=timezone.utc)),
    # The first millisecond of a second: the last microsecond of the second before.
    (datetime(2026, 10, 20, 0, 0, 1, 456, tzinfo=timezone.utc),
     datetime(2026, 10, 20, 0, 0, 0, 999_999, tzinfo=timezone.utc)),
    # Another zone: the same instant in UTC.
    (datetime(2026, 10, 20, 2, 0, 0, 123_456, tzinfo=timezone(timedelta(hours=2))),
     datetime(2026, 10, 20, 0, 0, 0, 122_999, tzinfo=timezone.utc)),
])
def test_the_submission_cap_leaves_out_the_whole_submission_millisecond(submitted, cap):
    # Elasticsearch keeps a ``date`` to the millisecond and cuts an ``lte`` bound to
    # its millisecond, so a cap inside the submission millisecond would still read
    # rows written after Export there (SQL would not). Ending before it agrees on both.
    assert submission_cap(submitted) == cap
    assert submission_cap(submitted).tzinfo == timezone.utc
    params = _params(**{"from": "2026-10-19T00:00:00Z", "to": "2026-10-21T00:00:00Z"})
    assert export_filters(params, read_until=submitted).ts_to == cap


@pytest.mark.parametrize(("from_", "to", "end"), [
    # To the minute: the whole minute.
    ("2026-10-18T15:10Z", "2026-10-25T15:10Z", datetime(2026, 10, 25, 15, 10, 59, 999_999)),
    # A fraction is a millisecond unit: the end of that millisecond.
    ("2026-10-18T15:10:00Z", "2026-10-25T15:10:00.5Z", datetime(2026, 10, 25, 15, 10, 0, 500_999)),
    # Another zone: the same instant in UTC, its whole second.
    ("2026-10-18T17:10:00+02:00", "2026-10-25T17:10:00+02:00",
     datetime(2026, 10, 25, 15, 10, 0, 999_999)),
])
def test_every_instant_precision_reads_as_the_read_api_reads_it(from_, to, end):
    built = export_filters(_params(**{"from": from_, "to": to}))
    assert built == _read_api_filters(from_, to, scope="all")
    assert built.ts_from == BASE
    assert built.ts_to == end.replace(tzinfo=timezone.utc)


def test_a_sub_millisecond_from_starts_where_the_read_api_starts():
    # Elasticsearch keeps milliseconds: a row at .000 is before .0005, so the range
    # starts at the next whole millisecond, on every store.
    built = export_filters(_params(**{"from": "2026-10-18T15:10:00.0005Z"}))
    assert built.ts_from == BASE + timedelta(milliseconds=1)
    assert built == _read_api_filters("2026-10-18T15:10:00.0005Z", TO, scope="all")


def test_the_last_instant_of_the_calendar_is_a_coded_refusal():
    with pytest.raises(HTTPException) as caught:
        export_filters(_params(**{"to": "9999-12-31T23:59:59Z"}))
    assert caught.value.status_code == 422
    assert caught.value.detail["code"] == "audit_invalid_time"


def test_a_reversed_range_and_bad_filters_are_coded_refusals():
    with pytest.raises(HTTPException) as caught:
        export_filters(_params(**{"from": TO, "to": FROM}))
    assert caught.value.detail["code"] == "audit_invalid_time"
    with pytest.raises(HTTPException) as caught:
        export_filters(_params(filters={"event": "NOT AN EVENT"}))
    assert caught.value.detail["code"] == "audit_invalid_filter"
    with pytest.raises(HTTPException) as caught:
        export_filters(_params(filters={"ip": "10.0.0.0/8"}))
    assert caught.value.detail["code"] == "audit_invalid_filter"


def test_the_file_name_names_the_dialog_instants():
    ts_from = parse_instant(FROM, "from")
    ts_to = parse_instant("2026-10-25T17:10:00.999+02:00", "to")
    assert export_file_name("csv", ts_from, ts_to) == (
        "agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv"
    )
    assert export_file_name("jsonl", ts_from, ts_to).endswith(".ndjson")


@pytest.mark.parametrize("bad", [
    {"order": "desc"},
    {"format": "xlsx"},
    {"scope": "everyone"},
    {"extra": 1},
    {"filters": {"unknown": "x"}},
])
def test_the_param_model_is_strict(bad):
    with pytest.raises(Exception):
        AuditExportParams.model_validate({**_params(), **bad})


def test_vocabulary_filters_are_the_read_apis_to_refuse():
    """``actor_kind`` and ``outcome`` are text in the model, as in the read API, so the
    read API's own validation refuses a bad value with its coded 422."""
    model = AuditExportParams.model_validate(_params(filters={"actor_kind": "robot", "outcome": "bogus"}))
    params = model.model_dump(mode="json", exclude_none=True, by_alias=True)
    with pytest.raises(HTTPException) as caught:
        export_filters(params)
    assert caught.value.status_code == 422
    assert caught.value.detail["code"] == "audit_invalid_filter"
    assert caught.value.detail["message"].startswith("'actor_kind' must be ")


def test_closed_values_ignore_surrounding_spaces_like_the_read_api():
    model = AuditExportParams.model_validate(_params(scope="people ", format=" csv", order="asc "))
    assert (model.scope, model.format, model.order) == ("people", "csv", "asc")


def test_blank_filters_are_the_same_as_none():
    a = AuditExportParams.model_validate(_params(q="  ", filters={"actor": " ", "outcome": ""}))
    b = AuditExportParams.model_validate(_params())
    dump = dict(mode="json", exclude_none=True, by_alias=True)
    assert a.model_dump(**dump) == b.model_dump(**dump)
    assert "from" in a.model_dump(**dump)


# --------------------------------------------------------------------------- #
# The reader over the real stores
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture(params=["es", "sql"])
async def store_state(request, tmp_path):
    state = AppState.create(secrets=_secrets(tmp_path, request.param), es=InMemoryESClient(),
                            provider_overrides=_overrides())
    await state.startup(start_poller=False)
    await state.job_runner.stop()
    state.job_runner.notify = lambda: None
    yield state
    await state.shutdown()


def _reference(rows: list[dict[str, Any]], filters: AuditFilters) -> list[int]:
    pred = build_predicate(filters)
    kept = [r for r in rows if matches(pred, r)]
    kept.sort(key=lambda r: r["ts"])
    return [r["tool_input"]["mark"] for r in kept]


async def test_the_csv_holds_every_matching_row_oldest_first(store_state, tmp_path, monkeypatch):
    monkeypatch.setattr(audit_export, "EXPORT_PAGE_SIZE", 7)
    rows = _corpus(40, needle_every=3)
    await _write_rows(store_state, rows)
    filters = export_filters(_params(q="needle"))
    boundaries: list[int] = []

    async def checkpoint(done: int) -> None:
        boundaries.append(done)

    path = tmp_path / "out.csv"
    path.touch()
    written = await write_export(store_state, filters=filters, fmt="csv", path=path, checkpoint=checkpoint)
    expected = _reference(rows, filters)
    assert written.rows == written.snapshot_total == len(expected) == 26
    raw = path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    table = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    assert tuple(table[0]) == CSV_COLUMNS
    body = [dict(zip(CSV_COLUMNS, line)) for line in table[1:]]
    assert [json.loads(r["tool_input"])["mark"] for r in body] == expected
    times = [r["ts"] for r in body]
    assert times == sorted(times) and all(t.endswith("Z") for t in times)
    # A page boundary before every store page: ceil(26 / 7) pages plus the end check.
    assert boundaries[0] == 0 and len(boundaries) >= 4
    assert boundaries == sorted(boundaries)
    # Formula leads are defused, the text is otherwise as stored.
    for record in body:
        for column, value in record.items():
            if value[:1] in FORMULA_LEADS or value.lstrip(" ")[:1] in FORMULA_LEADS:
                pytest.fail(f"{column} was not defused: {value!r}")
    summaries = {r["result_summary"] for r in body}
    assert any("'" not in s and "line one\r\nline two" in s for s in summaries)
    target_labels = {r["target.label"] for r in body if r["target.label"]}
    assert target_labels == {"'=Auto-close"}
    changed = [json.loads(r["changes"]) for r in body if r["changes"]]
    assert changed and changed[0][0]["field"] == "auto_close.enabled"


async def test_json_lines_write_each_stored_row_unmodified(store_state, tmp_path):
    rows = _corpus(12)
    await _write_rows(store_state, rows)
    filters = export_filters(_params(scope="all"))
    path = tmp_path / "out.ndjson"
    path.touch()

    async def checkpoint(_done: int) -> None:
        return None

    written = await write_export(store_state, filters=filters, fmt="jsonl", path=path, checkpoint=checkpoint)
    assert written.rows == 12
    lines = path.read_bytes().split(b"\n")
    assert lines[-1] == b""
    exported = [json.loads(line) for line in lines[:-1]]
    page = await store_state.control_audit.search_page(build_predicate(filters), order="asc", limit=100)
    assert exported == [hit.doc for hit in page.hits]
    assert [d["tool_input"]["mark"] for d in exported] == list(range(12))


async def test_a_cap_breach_inside_the_snapshot_stops_before_any_row(store_state, tmp_path, monkeypatch):
    monkeypatch.setattr(audit_export, "AUDIT_EXPORT_MAX_ROWS", 5)
    await _write_rows(store_state, _corpus(8))
    path = tmp_path / "out.csv"
    path.touch()

    async def checkpoint(_done: int) -> None:
        return None

    with pytest.raises(AuditExportTooLarge) as caught:
        await write_export(store_state, filters=export_filters(_params()), fmt="csv", path=path,
                           checkpoint=checkpoint)
    assert str(caught.value).startswith("audit_export_too_large: More than 5 events")


class _StubRepo:
    """An audit repository whose pages and counts the test dictates."""

    def __init__(self, docs: list[dict[str, Any]], *, total: int, relation: str = "eq",
                 stop_after: int | None = None) -> None:
        self.docs, self.total, self.relation, self.stop_after = docs, total, relation, stop_after
        self.closed: list[Any] = []

    async def search_page(self, predicate, *, order="desc", limit=50, cursor=None, track_total=10_000):
        offset = int((cursor or {}).get("offset", 0))
        end = len(self.docs) if self.stop_after is None else min(len(self.docs), self.stop_after)
        window = self.docs[offset: min(offset + limit, end)]
        hits = [AuditHit("mem", offset + i, None, doc, {"offset": offset + i + 1})
                for i, doc in enumerate(window)]
        return AuditSearchPage(hits=hits, total=self.total, relation=self.relation,
                               exhausted=offset + len(window) >= end, start={"offset": offset})

    async def count_matching(self, predicate, *, cap):
        return min(self.total, cap), self.relation

    async def close_search_cursor(self, cursor):
        self.closed.append(cursor)


async def _write_with(repo: _StubRepo, tmp_path: Path) -> Any:
    state = SimpleNamespace(control_audit=repo, demo_audit=None)
    path = tmp_path / "stub.csv"
    path.touch()

    async def checkpoint(_done: int) -> None:
        return None

    return await write_export(state, filters=export_filters(_params()), fmt="csv", path=path,
                              checkpoint=checkpoint)


async def test_a_store_that_cannot_count_exactly_is_refused(tmp_path):
    docs = [{"ts": _ts(i), "actor": "a", "action_type": "status"} for i in range(3)]
    repo = _StubRepo(docs, total=3, relation="gte")
    with pytest.raises(AuditExportUnverifiable):
        await _write_with(repo, tmp_path)
    assert repo.closed  # the snapshot is released


async def test_a_read_that_ends_before_its_total_is_refused(tmp_path):
    docs = [{"ts": _ts(i), "actor": "a", "action_type": "status"} for i in range(30)]
    repo = _StubRepo(docs, total=30, stop_after=20)
    with pytest.raises(AuditExportIncomplete) as caught:
        await _write_with(repo, tmp_path)
    assert "Only 20 of the 30 matching events" in str(caught.value)


class _ExpiringRepo(_StubRepo):
    """Its snapshot expires after the first page."""

    async def search_page(self, predicate, *, cursor=None, **kwargs):
        if cursor:
            raise AuditCursorExpired("the point-in-time snapshot has expired")
        return await super().search_page(predicate, cursor=cursor, **kwargs)


class _BrokenRepo(_StubRepo):
    async def search_page(self, predicate, **kwargs):
        raise ConnectionError("store down")


async def test_an_expired_snapshot_and_an_unreadable_store_are_named(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_export, "EXPORT_PAGE_SIZE", 5)
    docs = [{"ts": _ts(i), "actor": "a", "action_type": "status"} for i in range(10)]
    with pytest.raises(AuditExportExpired) as expired:
        await _write_with(_ExpiringRepo(docs, total=10), tmp_path)
    assert str(expired.value).startswith("audit_export_expired: ")
    with pytest.raises(AuditExportUnreadable) as unreadable:
        await _write_with(_BrokenRepo(docs, total=10), tmp_path)
    assert unreadable.value.code == "audit_unavailable"


async def test_more_rows_than_the_cap_while_reading_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_export, "AUDIT_EXPORT_MAX_ROWS", 4)
    docs = [{"ts": _ts(i), "actor": "a", "action_type": "status"} for i in range(9)]
    # The store claims 3 in its snapshot but keeps returning rows: never partial.
    repo = _StubRepo(docs, total=3)
    with pytest.raises(AuditExportTooLarge):
        await _write_with(repo, tmp_path)


async def test_a_cancel_at_a_page_boundary_stops_the_read(tmp_path, monkeypatch):
    monkeypatch.setattr(audit_export, "EXPORT_PAGE_SIZE", 5)
    docs = [{"ts": _ts(i), "actor": "a", "action_type": "status"} for i in range(30)]
    repo = _StubRepo(docs, total=30)
    state = SimpleNamespace(control_audit=repo, demo_audit=None)
    path = tmp_path / "cancel.csv"
    path.touch()
    calls: list[int] = []

    class Stop(Exception):
        pass

    async def checkpoint(done: int) -> None:
        calls.append(done)
        if len(calls) == 3:
            raise Stop()

    with pytest.raises(Stop):
        await write_export(state, filters=export_filters(_params()), fmt="csv", path=path,
                           checkpoint=checkpoint)
    assert calls == [0, 5, 10]
    assert repo.closed


# --------------------------------------------------------------------------- #
# The durable job (driven directly, no HTTP)
# --------------------------------------------------------------------------- #
def _job(params: dict[str, Any], *, key: str = "export-key-1", created_at: str | None = None,
         count: int = 0) -> Job:
    raw = json.dumps(params, sort_keys=True).encode()
    return Job(
        kind=JobKind.AUDIT_EXPORT,
        actor="",
        created_at=created_at or iso_now(),
        progress=JobProgress(total=count, unit="events"),
        request_fingerprint=hashlib.sha256(raw).hexdigest(),
        idempotency_key_hash=idempotency_hash("", key, ""),
        params=params,
        required_permissions=[JobPermission(resource="audit", action="export")],
        item_states={},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )


async def _run(state: AppState, job: Job) -> Job:
    stored, _created, _pruned = await state.jobs.create(job)
    claimed = await state.jobs.claim_next("worker-test", lease_millis=60_000)
    assert claimed is not None
    running, token = claimed
    assert running.job_id == stored.job_id
    await state.job_runner._execute(running, token)  # noqa: SLF001
    final = await state.jobs.get(stored.job_id)
    assert final is not None
    return final


async def _export_rows(state: AppState) -> list[dict[str, Any]]:
    """Every audit row an export wrote (newest last)."""
    filters = AuditFilters(event="audit")
    page = await state.control_audit.search_page(build_predicate(filters), order="asc", limit=200)
    return [hit.doc for hit in page.hits]


def _artifact_files(state: AppState) -> list[Path]:
    root = Path(state.secrets.jobs_artifact_dir)
    return sorted(p for p in root.glob("*") if p.is_file()) if root.exists() else []


async def test_the_job_writes_the_file_then_its_exported_row_then_attaches(store_state):
    await _write_rows(store_state, _corpus(9))
    final = await _run(store_state, _job(_params(), count=9))
    assert final.status == JobStatus.SUCCEEDED
    assert final.result is not None and final.result.counts == {"events": 9, "bytes": final.artifact.size}
    assert final.progress.model_dump() == {"done": 9, "total": 9, "unit": "events"}
    assert final.artifact is not None
    assert final.artifact.filename == "agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv"
    assert final.artifact.content_type == "text/csv; charset=utf-8"
    path = await store_state.job_runner.verify_artifact(final.artifact)
    body = path.read_bytes()
    assert hashlib.sha256(body).hexdigest() == final.artifact.sha256
    rows = await _export_rows(store_state)
    exported = [r for r in rows if r.get("action") == "audit.exported"]
    assert len(exported) == 1
    row = exported[0]
    assert row["outcome"] == "success" and row["actor_type"] == "human"
    assert row["target"]["type"] == "export" and row["target"]["id"] == final.job_id
    assert row["target"]["label"] == final.artifact.filename
    assert row["tool_input"]["sha256"] == final.artifact.sha256
    assert row["tool_input"]["bytes"] == len(body) == final.artifact.size
    assert row["tool_input"]["events"] == 9
    assert "SHA-256 " + final.artifact.sha256 in row["result_summary"]
    # A worker row: no request field, and never a request id that no request had.
    for name in _REQUEST_FIELDS:
        assert row.get(name) is None, name
    assert not [r for r in rows if r.get("action") == "audit.export_failed"]


async def test_the_job_recounts_and_refuses_growth_past_the_cap(store_state, monkeypatch):
    await _write_rows(store_state, _corpus(6))
    monkeypatch.setattr(audit_export, "AUDIT_EXPORT_MAX_ROWS", 5)
    final = await _run(store_state, _job(_params(), count=4))
    assert final.status == JobStatus.FAILED
    assert final.artifact is None
    assert final.failures[0].reason.startswith("audit_export_too_large:")
    assert _artifact_files(store_state) == []
    failed = [r for r in await _export_rows(store_state) if r.get("action") == "audit.export_failed"]
    assert len(failed) == 1 and failed[0]["outcome"] == "failure"
    assert failed[0]["tool_input"]["code"] == "audit_export_too_large"
    assert failed[0]["target"]["id"] == final.job_id


async def test_a_store_that_cannot_be_counted_fails_the_job_with_a_row(store_state, monkeypatch):
    await _write_rows(store_state, _corpus(3))

    async def down(*args, **kwargs):
        raise ConnectionError("store down")

    monkeypatch.setattr(store_state.control_audit, "count_matching", down)
    final = await _run(store_state, _job(_params(), count=3))
    assert final.status == JobStatus.FAILED
    assert final.failures[0].reason.startswith("audit_unavailable: The audit log could not be read")
    failed = [r for r in await _export_rows(store_state) if r.get("action") == "audit.export_failed"]
    assert len(failed) == 1 and failed[0]["tool_input"]["code"] == "audit_unavailable"
    assert _artifact_files(store_state) == []


async def test_a_cancel_at_a_page_boundary_keeps_nothing(store_state, monkeypatch):
    monkeypatch.setattr(audit_export, "EXPORT_PAGE_SIZE", 3)
    await _write_rows(store_state, _corpus(12))
    job = _job(_params(), count=12)
    runner = store_state.job_runner
    real_checkpoint = runner.checkpoint
    seen = {"pages": 0}

    async def checkpoint(job_id, token, **kwargs):
        if kwargs.get("emit") and kwargs.get("done"):
            seen["pages"] += 1
            if seen["pages"] == 2:
                await store_state.jobs.request_cancel(job_id, "", "")
        return await real_checkpoint(job_id, token, **kwargs)

    monkeypatch.setattr(runner, "checkpoint", checkpoint)
    final = await _run(store_state, job)
    assert final.status == JobStatus.CANCELLED
    assert final.artifact is None
    assert _artifact_files(store_state) == []
    actions = {r.get("action") for r in await _export_rows(store_state)}
    assert "audit.exported" not in actions and "audit.export_failed" not in actions


async def test_a_failed_exported_row_leaves_no_visible_file(store_state, monkeypatch):
    await _write_rows(store_state, _corpus(3))
    repo = store_state.control_audit
    real = repo.record_strict

    async def failing(**kwargs):
        if kwargs.get("action") == "audit.exported":
            raise RuntimeError("audit store down")
        return await real(**kwargs)

    monkeypatch.setattr(repo, "record_strict", failing)
    final = await _run(store_state, _job(_params(), count=3))
    assert final.status == JobStatus.FAILED
    assert final.artifact is None
    assert _artifact_files(store_state) == []
    # A coded reason, never a dict's repr, and one row that closes the request.
    assert final.failures[0].reason.startswith("audit_unavailable: The export could not be recorded")
    failed = [r for r in await _export_rows(store_state) if r.get("action") == "audit.export_failed"]
    assert len(failed) == 1
    assert failed[0]["outcome"] == "failure"
    assert failed[0]["tool_input"]["code"] == "audit_unavailable"
    assert failed[0]["target"]["id"] == final.job_id


#: The fields only a request has; a worker row never records them (no made-up value).
_REQUEST_FIELDS = ("request_id", "client", "session_ref", "actor_role")


async def test_a_failed_attach_after_its_row_has_exactly_one_failure_row(store_state, monkeypatch):
    """The attach fails after ``audit.exported`` was appended: exactly one
    ``audit.export_failed`` row closes it, paired by the shared ``export`` target. Both
    are worker rows, so neither carries a request id (none was ever made up)."""
    await _write_rows(store_state, _corpus(3))

    async def broken_attach(*args, **kwargs):
        raise RuntimeError("registry write failed")

    monkeypatch.setattr(store_state.jobs, "attach_artifact", broken_attach)
    final = await _run(store_state, _job(_params(), count=3))
    assert final.status == JobStatus.FAILED
    assert _artifact_files(store_state) == []
    rows = await _export_rows(store_state)
    exported = [r for r in rows if r.get("action") == "audit.exported"]
    failed = [r for r in rows if r.get("action") == "audit.export_failed"]
    assert len(exported) == 1 and len(failed) == 1
    assert failed[0]["target"] == exported[0]["target"]
    assert failed[0]["target"]["id"] == final.job_id
    assert failed[0]["outcome"] == "failure"
    assert "registry write failed" in failed[0]["result_summary"]
    for row in (exported[0], failed[0]):
        assert row["actor_type"] == "human"
        for name in _REQUEST_FIELDS:
            assert row.get(name) is None, (row["action"], name)


async def test_an_attach_that_finds_the_lease_moved_still_closes_its_exported_row(
    store_state, monkeypatch
):
    """The lease moves between the ``audit.exported`` row and the attach: the attach is
    refused, and the row (this attempt's claim of a file) is still closed by one
    failure row; the new owner's state is left alone."""
    await _write_rows(store_state, _corpus(3))
    real_attach = store_state.jobs.attach_artifact
    taken: dict[str, Any] = {}

    async def moved_attach(job_id, token, artifact):
        await store_state.jobs.release_claim(job_id, token)
        claimed = await store_state.jobs.claim_next("worker-other", lease_millis=60_000)
        assert claimed is not None
        taken["job"], taken["token"] = claimed
        return await real_attach(job_id, token, artifact)

    monkeypatch.setattr(store_state.jobs, "attach_artifact", moved_attach)
    stored, _created, _pruned = await store_state.jobs.create(_job(_params(), count=3))
    claimed = await store_state.jobs.claim_next("worker-test", lease_millis=60_000)
    assert claimed is not None
    await store_state.job_runner._execute(*claimed)  # noqa: SLF001
    moved = await store_state.jobs.get(stored.job_id)
    assert moved is not None and moved.status == JobStatus.RUNNING
    assert moved.lease_token == taken["token"] and moved.artifact is None
    assert _artifact_files(store_state) == []
    rows = await _export_rows(store_state)
    exported = [r for r in rows if r.get("action") == "audit.exported"]
    failed = [r for r in rows if r.get("action") == "audit.export_failed"]
    assert len(exported) == 1 and len(failed) == 1
    assert failed[0]["target"] == exported[0]["target"]


async def test_a_full_volume_mid_export_keeps_nothing_and_is_coded(store_state, monkeypatch):
    """Free space is checked before every write (not once at the start): the check
    that fails on a later chunk stops the export with ``audit_export_no_space``."""
    from app.api import routes_export

    monkeypatch.setattr(audit_export, "EXPORT_PAGE_SIZE", 3)
    await _write_rows(store_state, _corpus(12))
    calls: list[int] = []
    real = routes_export._ensure_archive_capacity

    def capacity(path: str, required: int) -> None:
        calls.append(required)
        if len(calls) == 4:  # the start, the CSV header, one chunk, then full
            raise HTTPException(status_code=507, detail="insufficient temporary disk space")
        real(path, required)

    monkeypatch.setattr(routes_export, "_ensure_archive_capacity", capacity)
    final = await _run(store_state, _job(_params(), count=12))
    assert final.status == JobStatus.FAILED
    assert final.artifact is None
    assert final.failures[0].reason.startswith("audit_export_no_space: There is not enough free disk space")
    assert _artifact_files(store_state) == []
    assert len(calls) == 4 and all(required >= 1024 * 1024 for required in calls)
    failed = [r for r in await _export_rows(store_state) if r.get("action") == "audit.export_failed"]
    assert len(failed) == 1 and failed[0]["tool_input"]["code"] == "audit_export_no_space"


async def test_every_write_is_capacity_checked_and_a_full_disk_is_named(tmp_path):
    docs = [{"ts": _ts(i), "actor": "a", "action_type": "status"} for i in range(4)]
    state = SimpleNamespace(control_audit=_StubRepo(docs, total=4), demo_audit=None)
    asked: list[int] = []

    async def checkpoint(_done: int) -> None:
        return None

    async def ensure_capacity(nbytes: int) -> None:
        asked.append(nbytes)

    path = tmp_path / "sized.csv"
    path.touch()
    await write_export(state, filters=export_filters(_params()), fmt="csv", path=path,
                       checkpoint=checkpoint, ensure_capacity=ensure_capacity)
    assert sum(asked) == path.stat().st_size  # every byte was announced before it was written

    class FullHandle:
        def write(self, _data: bytes) -> int:
            raise OSError(errno.ENOSPC, "No space left on device")

        def flush(self) -> None:
            return None

        def fileno(self) -> int:
            return 0

        def close(self) -> None:
            return None

    full = SimpleNamespace(open=lambda _mode: FullHandle())
    with pytest.raises(AuditExportNoSpace) as caught:
        await write_export(SimpleNamespace(control_audit=_StubRepo(docs, total=4), demo_audit=None),
                           filters=export_filters(_params()), fmt="jsonl", path=full,
                           checkpoint=checkpoint)
    assert caught.value.code == "audit_export_no_space"


async def test_a_lease_lost_to_another_worker_writes_no_failure_row(store_state, monkeypatch):
    """A page boundary finds that another worker owns the lease: the old worker removes
    only its own file and writes no row; the new owner then exports once."""
    monkeypatch.setattr(audit_export, "EXPORT_PAGE_SIZE", 3)
    await _write_rows(store_state, _corpus(12))
    runner = store_state.job_runner
    real_checkpoint = runner.checkpoint
    taken: dict[str, Any] = {}

    async def checkpoint(job_id, token, **kwargs):
        if kwargs.get("emit") and kwargs.get("done") and "token" not in taken:
            # The lease moves: this worker stalled, another one claimed the job.
            await store_state.jobs.release_claim(job_id, token)
            claimed = await store_state.jobs.claim_next("worker-other", lease_millis=60_000)
            assert claimed is not None
            taken["job"], taken["token"] = claimed
        return await real_checkpoint(job_id, token, **kwargs)

    monkeypatch.setattr(runner, "checkpoint", checkpoint)
    stored, _created, _pruned = await store_state.jobs.create(_job(_params(), count=12))
    claimed = await store_state.jobs.claim_next("worker-test", lease_millis=60_000)
    assert claimed is not None
    await runner._execute(*claimed)  # noqa: SLF001
    moved = await store_state.jobs.get(stored.job_id)
    assert moved is not None and moved.status == JobStatus.RUNNING
    assert moved.lease_token == taken["token"]
    assert moved.pending_artifact_id  # the new owner's state was left alone
    assert _artifact_files(store_state) == []  # the old worker removed its own file
    assert not [r for r in await _export_rows(store_state) if r.get("action") == "audit.export_failed"]

    monkeypatch.setattr(runner, "checkpoint", real_checkpoint)
    await runner._execute(taken["job"], taken["token"])  # noqa: SLF001
    final = await store_state.jobs.get(stored.job_id)
    assert final is not None and final.status == JobStatus.SUCCEEDED
    assert final.artifact is not None and final.artifact.artifact_id != moved.pending_artifact_id
    await runner.verify_artifact(final.artifact)
    assert len(_artifact_files(store_state)) == 1
    rows = await _export_rows(store_state)
    assert len([r for r in rows if r.get("action") == "audit.exported"]) == 1
    assert not [r for r in rows if r.get("action") == "audit.export_failed"]


async def test_pruning_old_files_never_undoes_a_committed_export(store_state, monkeypatch):
    await _write_rows(store_state, _corpus(4))
    runner = store_state.job_runner

    async def broken_delete(_artifacts):
        raise PermissionError("cannot remove an old file")

    monkeypatch.setattr(runner, "delete_artifacts", broken_delete)
    final = await _run(store_state, _job(_params(), count=4))
    assert final.status == JobStatus.SUCCEEDED
    assert final.artifact is not None
    await runner.verify_artifact(final.artifact)
    rows = await _export_rows(store_state)
    assert len([r for r in rows if r.get("action") == "audit.exported"]) == 1
    assert not [r for r in rows if r.get("action") == "audit.export_failed"]


@pytest.mark.parametrize("cause", ["demo", "permission", "reauth"])
async def test_an_export_that_loses_authority_while_queued_is_closed_as_denied(store_state, monkeypatch, cause):
    """Demo Mode turned on, a grant removed or the fresh sign-in expired before the
    job's first checkpoint: one ``audit.export_failed`` row, outcome ``denied``."""
    await _write_rows(store_state, _corpus(3))
    job = _job(_params(), count=3)
    if cause == "reauth":
        job = job.model_copy(update={"fresh_authorized_until_millis": 1})
    if cause == "permission":
        async def revoked(_job) -> bool:
            return False

        monkeypatch.setattr(store_state.job_runner, "_permission_alive", revoked)
    stored, _created, _pruned = await store_state.jobs.create(job)
    claimed = await store_state.jobs.claim_next("worker-test", lease_millis=60_000)
    assert claimed is not None
    if cause == "demo":
        store_state._demo = SimpleNamespace(audit=store_state.control_audit, run_id="demo-test")  # noqa: SLF001
    try:
        await store_state.job_runner._execute(*claimed)  # noqa: SLF001
    finally:
        store_state._demo = None  # noqa: SLF001
    final = await store_state.jobs.get(stored.job_id)
    assert final is not None and final.status == JobStatus.FAILED
    expected = {
        "demo": "audit_export_denied: Demo Mode was turned on",
        "permission": "audit_export_denied: You no longer have permission to export the audit log",
        "reauth": "audit_export_denied: The sign-in for this export expired",
    }[cause]
    assert final.failures[0].reason.startswith(expected)
    failed = [r for r in await _export_rows(store_state) if r.get("action") == "audit.export_failed"]
    assert len(failed) == 1
    assert failed[0]["outcome"] == "denied"
    assert failed[0]["tool_input"]["code"] == "audit_export_denied"
    target = failed[0]["target"]
    assert (target["type"], target["id"], target["label"]) == (
        "export", final.job_id, "agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv",
    )
    assert _artifact_files(store_state) == []


async def test_the_read_never_goes_past_submission(store_state):
    rows = _corpus(10)
    await _write_rows(store_state, rows)
    # Submitted a millisecond after the 5th row: the later rows were written after Export.
    submitted = (datetime.fromisoformat(rows[4]["ts"]) + timedelta(milliseconds=1)).isoformat()
    final = await _run(store_state, _job(_params(format="jsonl"), created_at=submitted, count=5))
    assert final.status == JobStatus.SUCCEEDED
    path = await store_state.job_runner.verify_artifact(final.artifact)
    marks = [json.loads(line)["tool_input"]["mark"] for line in path.read_bytes().splitlines()]
    assert marks == [0, 1, 2, 3, 4]
    assert final.artifact.content_type == "application/x-ndjson"


async def test_no_row_of_the_submission_millisecond_is_read_on_any_store(store_state):
    # The job's ``created_at`` keeps microseconds; the store may keep milliseconds
    # (Elasticsearch). Every row of the submission millisecond is left out, before or
    # after the submission's microsecond (this export's own ``export_requested`` row
    # can land there), so every store reads the same rows and the recount agrees.
    submitted = BASE + timedelta(seconds=100, microseconds=123_456)
    offsets = [
        (0, -1_456),  # the previous millisecond's first microsecond: read
        (1, -457),    # the previous millisecond's last microsecond: read
        (2, -456),    # the submission millisecond, before the submission: left out
        (3, 0),       # the submission's own microsecond: left out
        (4, 333),     # after the submission, in its millisecond: left out
        (5, 544),     # the next millisecond: left out
    ]
    rows = [
        {"ts": (submitted + timedelta(microseconds=delta)).isoformat(), "action_type": "status",
         "actor": "user1", "result_summary": f"row {mark}", "tool_input": {"mark": mark}}
        for mark, delta in offsets
    ]
    await _write_rows(store_state, rows)
    filters = export_filters(_params(), read_until=submitted)
    assert filters.ts_to == BASE + timedelta(seconds=100, microseconds=122_999)
    assert (await audit_export.count_events(store_state, filters))[0] == 2
    final = await _run(store_state, _job(_params(format="jsonl"), created_at=submitted.isoformat(),
                                         count=2))
    assert final.status == JobStatus.SUCCEEDED
    assert final.progress.total == 2
    path = await store_state.job_runner.verify_artifact(final.artifact)
    marks = [json.loads(line)["tool_input"]["mark"] for line in path.read_bytes().splitlines()]
    assert marks == [0, 1]


# --------------------------------------------------------------------------- #
# The routes
# --------------------------------------------------------------------------- #
def _app(secrets: Secrets, *, rbac: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=_overrides())
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    deps = [Depends(require_auth)] if secrets.auth_enabled else []
    api.include_router(base_router, dependencies=deps)
    api.include_router(jobs_router, dependencies=deps)
    api.include_router(audit_router, dependencies=deps)
    api.add_middleware(RequestIdMiddleware)
    return api


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _seed(client: TestClient, rows: list[dict[str, Any]]) -> None:
    client.portal.call(_write_rows, _state(client), rows)


def _submit(client: TestClient, params: dict[str, Any], key: str = "export-0001") -> Any:
    return client.post("/api/jobs", json={"kind": "audit_export", "idempotency_key": key, "params": params})


def _wait(client: TestClient, job_id: str, timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in TERMINAL:
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def _rows_with(client: TestClient, action: str) -> list[dict[str, Any]]:
    state = _state(client)
    page = client.portal.call(lambda: state.control_audit.search_page(
        build_predicate(AuditFilters(event=action)), order="asc", limit=200))
    return [hit.doc for hit in page.hits]


@pytest.fixture(params=["es", "sql"])
def api(request, tmp_path):
    with TestClient(_app(_secrets(tmp_path, request.param))) as client:
        yield client


def _page_ids(client: TestClient, query: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    cursor = None
    for _ in range(100):
        params = {**query, "limit": 200, "order": "asc", **({"cursor": cursor} if cursor else {})}
        page = client.get("/api/audit", params=params)
        assert page.status_code == 200, page.text
        body = page.json()
        ids.extend(r["record_id"] for r in body["records"])
        cursor = body["next_cursor"]
        if not cursor:
            return ids
    raise AssertionError("the page query did not end")


def test_a_1284_row_export_with_a_search_term_matches_the_page_query(api):
    # 1,712 rows in range; every 4th lacks the search term, so 1,284 match.
    rows = _corpus(1712, needle_every=4)
    assert sum(1 for r in rows if "needle" in r["result_summary"]) == 1284
    _seed(api, rows)
    params = _params(scope="all", q="needle")
    count = api.get("/api/audit/count", params={"scope": "all", "q": "needle", "from": FROM, "to": TO})
    assert count.json() == {"count": 1284, "relation": "eq"}

    accepted = _submit(api, params)
    assert accepted.status_code == 202, accepted.text
    job = accepted.json()
    assert job["kind"] == "audit_export"
    assert job["progress"] == {"done": 0, "total": 1284, "unit": "events"}
    assert job["params"]["q"] == "needle" and job["params"]["from"] == FROM
    final = _wait(api, job["job_id"])
    assert final["status"] == "succeeded", final
    assert final["result"]["counts"]["events"] == 1284

    download = api.get(f"/api/jobs/{job['job_id']}/artifact")
    assert download.status_code == 200
    assert download.headers["content-type"].startswith("text/csv")
    assert "agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv" in download.headers["content-disposition"]
    table = list(csv.reader(io.StringIO(download.content.decode("utf-8-sig"), newline="")))
    exported_ids = [line[0] for line in table[1:]]
    assert exported_ids == _page_ids(api, {"scope": "all", "q": "needle", "from": FROM, "to": TO})
    assert len(exported_ids) == 1284
    times = [line[1] for line in table[1:]]
    assert times == sorted(times)  # oldest first

    exported = _rows_with(api, "audit.exported")
    assert len(exported) == 1
    assert exported[0]["tool_input"]["sha256"] == hashlib.sha256(download.content).hexdigest()
    assert exported[0]["tool_input"]["bytes"] == len(download.content)
    requested = _rows_with(api, "audit.export_requested")
    assert len(requested) == 1
    assert requested[0]["tool_input"]["events"] == 1284
    assert requested[0]["tool_input"]["filters"] == {}
    assert requested[0]["tool_input"]["q"] == "needle"
    assert requested[0]["request_id"] == accepted.headers["x-request-id"]
    assert requested[0]["target"] == exported[0]["target"]
    assert "1,284 events as CSV" in requested[0]["result_summary"]
    downloaded = _rows_with(api, "audit.export_downloaded")
    assert len(downloaded) == 1 and downloaded[0]["request_id"] == download.headers["x-request-id"]


def test_json_lines_round_trip_through_the_route(api):
    rows = _corpus(25)
    _seed(api, rows)
    accepted = _submit(api, _params(format="jsonl", scope="all", filters={"actor": "user2"}))
    assert accepted.status_code == 202, accepted.text
    final = _wait(api, accepted.json()["job_id"])
    assert final["status"] == "succeeded"
    download = api.get(f"/api/jobs/{final['job_id']}/artifact")
    assert download.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in download.content.splitlines()]
    assert [d["tool_input"]["mark"] for d in lines] == [r["tool_input"]["mark"] for r in rows if r["actor"] == "user2"]
    for doc in lines:
        stored = next(r for r in rows if r["tool_input"]["mark"] == doc["tool_input"]["mark"])
        assert doc["result_summary"] == stored["result_summary"]  # no defusal in JSON Lines


@pytest.mark.parametrize(("to", "inside"), [
    # To the second: a row half a second after ``to`` is inside that second.
    (TO, ["before", "last second"]),
    # To the minute: the whole minute, so a row 40 seconds in is inside too.
    ("2026-10-25T15:10Z", ["before", "last second", "last minute"]),
])
def test_the_count_the_page_and_the_file_agree_at_the_range_end(api, to, inside):
    """``GET /api/audit/count`` (the dialog's "Export N events?"), ``GET /api/audit``
    and the job read the same range: the read API's own reading of the instants."""
    end = datetime(2026, 10, 25, 15, 10, tzinfo=timezone.utc)
    rows = [
        {"ts": (end - timedelta(seconds=1)).isoformat(), "result_summary": "before"},
        {"ts": (end + timedelta(milliseconds=500)).isoformat(), "result_summary": "last second"},
        {"ts": (end + timedelta(seconds=40)).isoformat(), "result_summary": "last minute"},
        {"ts": (end + timedelta(minutes=1)).isoformat(), "result_summary": "after"},
    ]
    _seed(api, [{"action_type": "auth", "surface": "r14", "actor": "erin", **row} for row in rows])
    query = {"scope": "all", "from": FROM, "to": to}
    count = api.get("/api/audit/count", params=query)
    assert count.json() == {"count": len(inside), "relation": "eq"}
    page = api.get("/api/audit", params={**query, "order": "asc", "limit": 50})
    assert [r["result_summary"] for r in page.json()["records"]] == inside

    accepted = _submit(api, _params(to=to))
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["progress"]["total"] == len(inside)
    final = _wait(api, accepted.json()["job_id"])
    assert final["status"] == "succeeded", final
    assert final["result"]["counts"]["events"] == len(inside)
    download = api.get(f"/api/jobs/{final['job_id']}/artifact")
    table = list(csv.DictReader(io.StringIO(download.content.decode("utf-8-sig"), newline="")))
    assert [line["result_summary"] for line in table] == inside
    # The file is still named after the instants the dialog showed.
    assert "agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv" in (
        download.headers["content-disposition"]
    )
    [requested] = _rows_with(api, "audit.export_requested")
    assert requested["tool_input"]["events"] == len(inside)
    assert requested["tool_input"]["to"] == to


def test_the_coded_refusals_write_no_row(api, monkeypatch):
    _seed(api, _corpus(12))
    bad_time = _submit(api, _params(**{"from": "now-7d"}))
    assert bad_time.status_code == 422
    assert bad_time.json()["detail"]["code"] == "audit_invalid_time"
    bad_filter = _submit(api, _params(filters={"event": "Bad.Event!"}), key="export-0002")
    assert bad_filter.json()["detail"]["code"] == "audit_invalid_filter"
    newest_first = _submit(api, _params(order="desc"), key="export-0003")
    assert newest_first.status_code == 422
    assert newest_first.json()["detail"] == {
        "code": "audit_invalid_filter",
        "message": "Exports are always oldest first, so 'order' must be asc.",
    }
    monkeypatch.setattr(audit_export, "AUDIT_EXPORT_MAX_ROWS", 10)
    too_large = _submit(api, _params(), key="export-0004")
    assert too_large.status_code == 422
    assert too_large.json()["detail"]["code"] == "audit_export_too_large"
    assert "More than 10 events" in too_large.json()["detail"]["message"]
    assert _rows_with(api, "audit.export_requested") == []
    assert api.get("/api/jobs").json()["jobs"] == []


@pytest.mark.parametrize(("change", "code", "message"), [
    ({"order": "desc"}, "audit_invalid_filter", "Exports are always oldest first, so 'order' must be asc."),
    ({"format": "xlsx"}, "audit_invalid_filter", "'format' must be csv or jsonl."),
    ({"scope": "everyone"}, "audit_invalid_filter", "'scope' must be people, agent or all."),
    ({"extra": 1}, "audit_invalid_filter", "'extra' is not an audit export setting."),
    ({"filters": {"unknown": "x"}}, "audit_invalid_filter", "'unknown' is not an audit log filter."),
    ({"filters": {"outcome": "bogus"}}, "audit_invalid_filter", None),
    ({"filters": {"actor_kind": "robot"}}, "audit_invalid_filter", None),
    ({"to": None}, "audit_invalid_time", None),
    ({"from": "0001-01-01T00:00:00+01:00"}, "audit_invalid_time", "'from' is not a valid time."),
    ({"to": "9999-12-31T23:59:59-01:00"}, "audit_invalid_time", "'to' is not a valid time."),
])
def test_bad_params_get_the_read_apis_coded_refusals(api, change, code, message):
    """Every audit export refusal is the read API's coded 422 in plain words: never
    the validator's own text, never a 500."""
    params = {**_params(), **change}
    params = {k: v for k, v in params.items() if v is not None}
    refused = _submit(api, params)
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert isinstance(detail, dict) and detail["code"] == code
    assert "pydantic" not in detail["message"] and "validation error" not in detail["message"]
    if message is not None:
        assert detail["message"] == message
    assert _rows_with(api, "audit.export_requested") == []
    assert api.get("/api/jobs").json()["jobs"] == []


def test_a_closed_value_with_spaces_is_read_as_the_read_api_reads_it(api):
    _seed(api, _corpus(4))
    accepted = _submit(api, _params(scope="people "))
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["params"]["scope"] == "people"


def test_a_store_that_cannot_be_counted_answers_503(api, monkeypatch):
    state = _state(api)

    async def down(*args, **kwargs):
        raise ConnectionError("store down")

    monkeypatch.setattr(state.control_audit, "count_matching", down)
    refused = _submit(api, _params())
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "audit_unavailable"
    assert api.get("/api/jobs").json()["jobs"] == []


def test_one_export_at_a_time_per_person_and_retries_are_idempotent(api):
    _seed(api, _corpus(5))
    state = _state(api)
    api.portal.call(state.job_runner.stop)
    first = _submit(api, _params(), key="export-busy-1")
    assert first.status_code == 202
    retry = _submit(api, _params(), key="export-busy-1")
    assert retry.status_code == 202 and retry.json()["job_id"] == first.json()["job_id"]
    other = _submit(api, _params(format="jsonl"), key="export-busy-2")
    assert other.status_code == 429
    assert other.json()["detail"]["code"] == "job_busy"
    conflict = _submit(api, _params(format="jsonl"), key="export-busy-1")
    assert conflict.status_code == 409
    assert len(_rows_with(api, "audit.export_requested")) == 1
    assert len(api.get("/api/jobs").json()["jobs"]) == 1


def test_a_racing_duplicate_closes_its_requested_row(api):
    """A double click: two submits with one key both pass the pre-checks before the
    first create commits. The second gets the first job (202), and its requested row,
    which names a job that was never made, is closed by a request-failed row."""
    _seed(api, _corpus(3))
    state = _state(api)
    api.portal.call(state.job_runner.stop)
    first = _submit(api, _params(), key="dup-key-0001")
    assert first.status_code == 202
    real_find, real_active = state.jobs.find_by_idempotency, state.jobs.active_for_actor

    async def none(*args, **kwargs):
        return None

    state.jobs.find_by_idempotency = none  # type: ignore[method-assign]
    state.jobs.active_for_actor = none  # type: ignore[method-assign]
    try:
        second = _submit(api, _params(), key="dup-key-0001")
    finally:
        state.jobs.find_by_idempotency = real_find  # type: ignore[method-assign]
        state.jobs.active_for_actor = real_active  # type: ignore[method-assign]
    assert second.status_code == 202, second.text
    job_id = first.json()["job_id"]
    assert second.json()["job_id"] == job_id
    assert [j["job_id"] for j in api.get("/api/jobs").json()["jobs"]] == [job_id]
    requested = _rows_with(api, "audit.export_requested")
    failed = _rows_with(api, "audit.export_request_failed")
    assert len(requested) == 2 and len(failed) == 1
    phantom = next(r for r in requested if r["target"]["id"] != job_id)
    assert failed[0]["request_id"] == phantom["request_id"]
    assert failed[0]["outcome"] == "failure"
    assert f"already accepted as job {job_id}" in failed[0]["result_summary"]
    assert failed[0]["result_summary"].startswith("job_already_accepted: ")


def test_a_retry_never_creates_a_job(api):
    """A retry of an accepted request answers with that job and never reaches the
    create, so it can never make a job without its requested row (even if the
    accepted job were pruned between the lookup and the create)."""
    _seed(api, _corpus(3))
    state = _state(api)
    api.portal.call(state.job_runner.stop)
    first = _submit(api, _params(), key="retry-key-0001")
    assert first.status_code == 202
    real_create = state.jobs.create

    async def no_create(*args, **kwargs):
        raise AssertionError("a retry must not create a job")

    state.jobs.create = no_create  # type: ignore[method-assign]
    try:
        retry = _submit(api, _params(), key="retry-key-0001")
    finally:
        state.jobs.create = real_create  # type: ignore[method-assign]
    assert retry.status_code == 202, retry.text
    assert retry.json()["job_id"] == first.json()["job_id"]
    assert len(_rows_with(api, "audit.export_requested")) == 1
    assert _rows_with(api, "audit.export_request_failed") == []


def test_the_busy_rule_holds_inside_the_create(api):
    """Two submissions that both pass the pre-check: the create CAS refuses the
    second, which gets its failure row (it was attempted) and a 429."""
    _seed(api, _corpus(5))
    state = _state(api)
    api.portal.call(state.job_runner.stop)
    real = state.jobs.active_for_actor

    async def never_busy(*args, **kwargs):
        return None

    state.jobs.active_for_actor = never_busy  # type: ignore[method-assign]
    try:
        assert _submit(api, _params(), key="race-0001").status_code == 202
        raced = _submit(api, _params(), key="race-0002")
    finally:
        state.jobs.active_for_actor = real  # type: ignore[method-assign]
    assert raced.status_code == 429
    failed = _rows_with(api, "audit.export_request_failed")
    assert len(failed) == 1 and failed[0]["outcome"] == "failure"
    assert len(_rows_with(api, "audit.export_requested")) == 2


def test_the_request_is_audited_before_the_job_exists(api, monkeypatch):
    _seed(api, _corpus(5))
    state = _state(api)
    real = state.control_audit.record_strict

    async def failing(**kwargs):
        if kwargs.get("action") == "audit.export_requested":
            raise RuntimeError("audit store down")
        return await real(**kwargs)

    monkeypatch.setattr(state.control_audit, "record_strict", failing)
    refused = _submit(api, _params())
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "audit_unavailable"
    assert api.get("/api/jobs").json()["jobs"] == []


def test_exports_are_refused_in_demo_mode(api):
    state = _state(api)
    state._demo = SimpleNamespace(audit=state.control_audit, run_id="demo-test")  # noqa: SLF001
    try:
        refused = _submit(api, _params())
    finally:
        state._demo = None  # noqa: SLF001
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "audit_export_demo_mode"
    assert "Demo Mode" in refused.json()["detail"]["message"]
    assert _rows_with(api, "audit.export_requested") == []


# --------------------------------------------------------------------------- #
# Sign-in, grants and fresh authentication
# --------------------------------------------------------------------------- #
def _auth_client(tmp_path: Path) -> TestClient:
    secrets = _secrets(tmp_path, "es", auth_enabled=True, auth_jwt_secret="audit-export-test-secret",
                       auth_seed_admin=True)
    return TestClient(_app(secrets, rbac=True))


def _as(client: TestClient, role: str) -> str:
    admin = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
    assert admin.status_code == 200, admin.text
    username = f"{role.replace('_', '-')}-exporter"
    created = client.post("/api/users", json={"username": username, "password": "audit-export-pass-1",
                                              "role": role})
    assert created.status_code == 200, created.text
    client.cookies.clear()
    login = client.post("/api/auth/login", json={"username": username, "password": "audit-export-pass-1"})
    assert login.status_code == 200, login.text
    return username


def test_an_auditor_can_export_and_download(tmp_path):
    with _auth_client(tmp_path) as client:
        _seed(client, _corpus(20))
        username = _as(client, "auditor")
        accepted = _submit(client, _params())
        assert accepted.status_code == 202, accepted.text
        final = _wait(client, accepted.json()["job_id"])
        assert final["status"] == "succeeded", final
        download = client.get(f"/api/jobs/{final['job_id']}/artifact")
        assert download.status_code == 200
        requested = _rows_with(client, "audit.export_requested")
        assert requested[0]["actor"] == username
        assert requested[0]["actor_role"] == "auditor"
        assert requested[0]["session_ref"] and requested[0]["client"]["ip_source"] == "peer"
        downloaded = _rows_with(client, "audit.export_downloaded")
        assert downloaded[0]["actor"] == username
        assert downloaded[0]["tool_input"]["sha256"] == hashlib.sha256(download.content).hexdigest()


def test_an_analyst_without_audit_export_is_refused(tmp_path):
    with _auth_client(tmp_path) as client:
        _seed(client, _corpus(3))
        _as(client, "analyst_tier1")
        refused = _submit(client, _params())
        assert refused.status_code == 403
        assert "audit:export" in refused.json()["detail"]
        assert _rows_with(client, "audit.export_requested") == []


def test_an_export_also_needs_audit_view(tmp_path):
    """A role that may export but not read the audit log exports nothing."""
    with _auth_client(tmp_path) as client:
        _seed(client, _corpus(3))
        _as(client, "soc_manager")
        state = _state(client)

        async def deny_view() -> None:
            prefs = state.prefs.model_copy(deep=True)
            prefs.rbac.denies.setdefault("soc_manager", {})["audit"] = ["view"]
            await state.update_prefs(prefs)

        client.portal.call(deny_view)
        refused = _submit(client, _params())
        assert refused.status_code == 403
        assert refused.json()["detail"] == "permission denied: audit:view"
        assert _rows_with(client, "audit.export_requested") == []


def test_an_export_needs_a_fresh_sign_in(tmp_path):
    with _auth_client(tmp_path) as client:
        _seed(client, _corpus(3))
        username = _as(client, "soc_manager")
        state = _state(client)

        def backdate(entries: list[dict[str, Any]]) -> bool:
            changed = False
            for row in entries:
                if row.get("username") == username and not str(row.get("sid", "")).startswith("__tv__:"):
                    row["last_authn_at"] = "2000-01-01T00:00:00+00:00"
                    changed = True
            return changed

        client.portal.call(state.sessions._mutate, backdate)  # noqa: SLF001
        refused = _submit(client, _params())
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "reauth_required"
        assert _rows_with(client, "audit.export_requested") == []


# --------------------------------------------------------------------------- #
# The artifact root, the Jobs projection and the Inbox line
# --------------------------------------------------------------------------- #
async def test_plain_export_files_are_artifacts_the_root_manages(store_state):
    runner = store_state.job_runner
    root = runner._artifact_root()  # noqa: SLF001
    csv_id, ndjson_id, zip_id = "a" * 32, "b" * 32, "c" * 32
    for name in (f"{csv_id}.csv", f"{ndjson_id}.ndjson", f"{zip_id}.zip", "notes.txt"):
        (root / name).write_bytes(b"x")
    assert runner.artifact_path(csv_id, "agentic-soc-audit_x.csv").name == f"{csv_id}.csv"
    assert runner.artifact_path(ndjson_id, "agentic-soc-audit_x.ndjson").name == f"{ndjson_id}.ndjson"
    with pytest.raises(FileNotFoundError):
        runner.artifact_path(csv_id, "export.exe")
    stored, _created, _pruned = await store_state.jobs.create(_job(_params()))
    claimed = await store_state.jobs.claim_next("worker-test", lease_millis=60_000)
    assert claimed is not None
    with pytest.raises(ValueError):
        await store_state.jobs.reserve_artifact(stored.job_id, claimed[1], suffix=".exe")
    _row, reserved = await store_state.jobs.reserve_artifact(stored.job_id, claimed[1], suffix=".ndjson")
    assert len(reserved) == 32
    # A factory reset purges every artifact type, never anything else.
    await runner._purge_artifact_root()  # noqa: SLF001
    assert sorted(p.name for p in root.iterdir()) == ["notes.txt"]


async def test_the_jobs_projection_keeps_the_question_and_the_inbox_line_counts_events(store_state):
    from app.engine.jobs import _summary, job_url
    from app.stores.jobs import public_job

    await _write_rows(store_state, _corpus(3))
    params = _params(scope="people", q="needle", filters={"actor": "user1"})
    final = await _run(store_state, _job(params, count=0))
    assert final.status == JobStatus.SUCCEEDED
    projected = public_job(final).params
    assert projected == {"format": "csv", "scope": "people", "from": FROM, "to": TO, "order": "asc",
                         "filters": {"actor": "user1"}, "q": "needle"}
    # The audit log in the exported view: scope, both instants, the search and filters.
    assert job_url(final) == (
        "#/audit?scope=people&from=2026-10-18T15%3A10%3A00Z&to=2026-10-25T15%3A10%3A00Z"
        "&q=needle&actor=user1"
    )
    events = final.result.counts["events"]
    assert _summary(final) == f"{events:,} {'event' if events == 1 else 'events'} exported"
    one = final.model_copy(update={"result": final.result.model_copy(update={"counts": {"events": 1284}})})
    assert _summary(one) == "1,284 events exported"


def test_an_audit_export_links_to_the_view_it_holds():
    """SPEC §4.5.8: "Open audit log" shows the exported view, not the default week.
    Values are URL-encoded, empty keys left out, the instants written in UTC to the
    second, and filters the route has no key for stay out."""
    from app.engine.jobs import job_url

    def url(**overrides: Any) -> str:
        return job_url(_job(_params(**overrides)))

    assert url(scope="agent", q="role & admin/ops", filters={
        "event": "user.role_changed", "actor_contains": "adm", "outcome": "denied",
        "case_id": "case-1", "target": "user-7", "ip": "10.0.0.5",
        "actor_kind": "human", "surface": "api", "source_id": "src-1", "actor": "  ",
    }) == (
        "#/audit?scope=agent&from=2026-10-18T15%3A10%3A00Z&to=2026-10-25T15%3A10%3A00Z"
        "&q=role%20%26%20admin%2Fops&event=user.role_changed&actor_contains=adm&outcome=denied"
        "&case=case-1&target=user-7&ip=10.0.0.5"
    )
    # Another zone and a fraction: UTC to the second, so the link covers the export.
    assert url(**{"from": "2026-10-18T20:40:00.750+05:30", "to": "2026-10-25T15:10:00.250Z"}) == (
        "#/audit?scope=all&from=2026-10-18T15%3A10%3A00Z&to=2026-10-25T15%3A10%3A00Z"
    )
    # An early year keeps its four digits, as the Console's own reading writes it.
    assert url(**{"from": "0999-01-01T00:00:00Z"}) == (
        "#/audit?scope=all&from=0999-01-01T00%3A00%3A00Z&to=2026-10-25T15%3A10%3A00Z"
    )
    # A scope the route does not know, or a range that cannot be read, is left out.
    assert url(scope="admin", **{"from": "now-7d"}) == "#/audit"
    assert url(scope="people", q="  ", filters=None) == (
        "#/audit?scope=people&from=2026-10-18T15%3A10%3A00Z&to=2026-10-25T15%3A10%3A00Z"
    )


def test_the_inbox_line_speaks_in_events_in_every_state():
    """Queued, running, failed and cancelled exports never read "0 of 1284
    completed": the line counts events, with thousands separators."""
    from app.engine.jobs import _summary
    from app.models import JobFailure

    base = _job(_params(), count=1284)
    queued = base.model_copy(update={"status": JobStatus.QUEUED})
    assert _summary(queued) == "Waiting to export 1,284 events"
    running = base.model_copy(update={
        "status": JobStatus.RUNNING, "progress": JobProgress(done=600, total=1284, unit="events")})
    assert _summary(running) == "600 of 1,284 events exported"
    single = base.model_copy(update={
        "status": JobStatus.RUNNING, "progress": JobProgress(done=0, total=1, unit="events")})
    assert _summary(single) == "0 of 1 event exported"
    too_large = base.model_copy(update={"status": JobStatus.FAILED, "failures": [JobFailure(
        item_ref="job", reason=str(AuditExportTooLarge()))]})
    assert _summary(too_large) == (
        "More than 100,000 events match these filters, so nothing was exported. Narrow the "
        "filters or the time range and export again."
    )
    uncoded = base.model_copy(update={"status": JobStatus.FAILED, "failures": [JobFailure(
        item_ref="job", reason="internal error")]})
    assert _summary(uncoded) == "Audit export failed. No file was kept."
    cancelled = base.model_copy(update={"status": JobStatus.CANCELLED})
    assert _summary(cancelled) == "Export cancelled. No file was kept."
    for job in (queued, running, too_large, uncoded, cancelled):
        assert "completed" not in _summary(job)
