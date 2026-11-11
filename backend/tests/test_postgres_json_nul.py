"""PostgreSQL acceptance: a stored ``\\u0000`` (or lone surrogate) never breaks a read.

The SQL backend keeps its documents in PostgreSQL ``json`` columns. ``doc ->> 'x'``
de-escapes every string of the document, so ONE ``\\u0000`` anywhere in a row failed
every JSON-filtered read over it (``UntranslatableCharacterError``): the Audit log's
default People and settings view answered ``503``, the account-activity feed and chat's
``audit_search`` reported no rows, and a single unauthenticated failed sign-in with a
NUL in the username wrote such a row. SQLite never de-escapes that way, so only a real
PostgreSQL server can prove the fix:

* rows written now are cleaned on write (``app.stored_text`` through ``AuditDoc``);
* rows stored by an older build stay readable (``readable_json``), and are never
  rewritten (#2);
* the ``cases``, ``usage`` and ``kv`` JSON reads, the ``kv`` compare-and-set above all,
  share the same accessor.

Point ``POSTGRES_TEST_DB_URL`` (or a ``postgresql`` ``STATE_DB_URL``) at a server; the
URL is used only to create and drop one scratch database per test. Without it the whole
module skips. pgvector is not needed (the RAG store falls back to JSON vectors).
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app.audit.query import AuditFilters, Eq, build_predicate
from app.config import Secrets
from app.constants import ActionType, EntityType, SourceSurface
from app.engine.case_aggregate import (
    CaseAggregateSpec,
    UsageAggregateSpec,
    aggregate_cases,
    aggregate_usage,
)
from app.engine.time_windows import resolve_window
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, UsageDoc
from app.state import AppState
from app.stores.base import kv_mutate
from app.stores.sql import (
    SqlAuditRepository,
    SqlCaseRepository,
    build_async_engine,
    create_all,
)
from app.stores.sql.models import AuditRow, KVRow
from app.stores.sql.repositories import SqlKVStore, SqlUsageRepository, _audit_field


def _configured_postgres_url() -> str:
    for name in ("POSTGRES_TEST_DB_URL", "STATE_DB_URL"):
        candidate = (os.environ.get(name) or "").strip()
        if candidate.startswith("postgresql"):
            return candidate
    return ""


POSTGRES_URL = _configured_postgres_url()

pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason=(
        "no PostgreSQL configured; set POSTGRES_TEST_DB_URL (or a postgresql "
        "STATE_DB_URL) to run the real-PostgreSQL NUL-escape tests"
    ),
)

NOW = datetime.now(timezone.utc).replace(microsecond=0)
NUL = "\x00"
LONE = "\ud800"


def _ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------- #
# A scratch database per test
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def pg_url():
    admin = create_async_engine(POSTGRES_URL, isolation_level="AUTOCOMMIT")
    database = f"tlsoc_nul_{uuid.uuid4().hex[:16]}"
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{database}"'))
        try:
            yield make_url(POSTGRES_URL).set(database=database).render_as_string(hide_password=False)
        finally:
            async with admin.connect() as conn:
                await conn.execute(text(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)'))
    finally:
        await admin.dispose()


@pytest_asyncio.fixture
async def pg_engine(pg_url):
    engine = build_async_engine(pg_url)
    await create_all(engine)
    try:
        yield engine
    finally:
        await engine.dispose()


async def _insert_raw_audit(engine: Any, docs: list[dict[str, Any]]) -> None:
    """Rows exactly as an older build stored them: ``json.dumps`` (ASCII escapes, so a
    NUL is the six characters ``\\u0000``) straight into the ``json`` column, bypassing
    the write-side cleaning. Test setup only: no product path rewrites audit rows."""
    async with engine.begin() as conn:
        for doc in docs:
            await conn.execute(
                text("INSERT INTO audit (ts, case_id, action_type, doc) "
                     "VALUES (:ts, :case_id, :action_type, CAST(:doc AS JSON))"),
                {"ts": doc["ts"], "case_id": doc.get("case_id"),
                 "action_type": doc["action_type"], "doc": json.dumps(doc)},
            )


async def _stored_text(engine: Any, table: str = "audit", column: str = "doc") -> list[str]:
    async with engine.connect() as conn:
        rows = (await conn.execute(text(f"SELECT CAST({column} AS TEXT) FROM {table}"))).all()
    return [row[0] for row in rows]


#: Where a poisoned row of an older build carried the bad escape. The actor case is
#: the production shape (a traversal string, a NUL, then the real username).
POISONS: dict[str, dict[str, Any]] = {
    "actor": {"actor": f"../../etc/passwd{NUL}alice"},
    "result_summary": {"actor": "alice", "result_summary": f"login failed{NUL} for alice"},
    "changes": {"actor": "alice", "action_type": "status", "surface": "settings",
                "action": "settings.updated", "changes": [
                    {"field": "branding.name", "before": f"old{NUL}", "after": "new", "secret": False}]},
    "tool_input": {"actor": "alice", "tool_input": {"username": f"a{NUL}b", "nested": [f"x{NUL}"]}},
    "lone_surrogate": {"actor": f"alice{LONE}", "result_summary": f"bad {LONE} text"},
}


def _corpus(poison: dict[str, Any]) -> list[dict[str, Any]]:
    """One poisoned row inside every window, around clean people and agent rows."""
    poisoned = {"ts": _ago(2), "action_type": "auth", "surface": "auth", "action": "auth.login_failed",
                "outcome": "failure", "actor_type": "human", "result_summary": "login failed", **poison}
    return [
        poisoned,
        {"ts": _ago(1), "action_type": "auth", "surface": "auth", "actor": "alice",
         "action": "auth.login", "outcome": "success", "actor_type": "human", "result_summary": "login ok"},
        {"ts": _ago(20), "action_type": "status", "surface": "settings", "actor": "bob",
         "action": "settings.updated", "outcome": "success", "actor_type": "human"},
        {"ts": _ago(3), "action_type": "verdict", "surface": "investigate", "actor": "investigator",
         "case_id": "case-1", "run_id": "run-1", "actor_type": "agent", "result_summary": "verdict FP"},
        {"ts": _ago(60), "action_type": "tool_call", "surface": "investigate", "actor": "investigator",
         "case_id": "case-1", "run_id": "run-1", "actor_type": "agent", "tool_name": "es_query"},
        {"ts": _ago(200), "action_type": "decision", "surface": "investigate", "actor": "case_manager",
         "case_id": "case-2", "run_id": "run-2", "actor_type": "agent"},
    ]


async def _page_all(repo: SqlAuditRepository, predicate: Any) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []
    cursor = None
    for _ in range(20):
        page = await repo.search_page(predicate, limit=2, cursor=cursor)
        docs.extend(hit.doc for hit in page.hits)
        assert page.total >= len(docs)
        if page.exhausted:
            return docs
        cursor = page.hits[-1].position
    raise AssertionError("paging did not finish")


# --------------------------------------------------------------------------- #
# The accessor itself
# --------------------------------------------------------------------------- #
async def test_a_plain_json_read_fails_on_a_nul_row_and_the_accessor_does_not(pg_engine):
    """The precondition (the raw ``->>`` dies on a NUL in ANOTHER key) and the fix: the
    same field read through ``readable_json`` answers, the NUL and a lone surrogate are
    removed, and an escaped backslash before ``u0000`` (the TEXT ``\\u0000``) is kept."""
    await _insert_raw_audit(pg_engine, [
        {"ts": _ago(1), "action_type": "auth", "actor": f"x{NUL}y"},
        {"ts": _ago(2), "action_type": "auth", "actor": f"lone{LONE}low\udc00"},
        {"ts": _ago(3), "action_type": "auth", "actor": "literal \\u0000 text"},
        {"ts": _ago(4), "action_type": "auth", "actor": "pair \U0001F600 and \\" + NUL},
        {"ts": _ago(5), "action_type": "auth", "actor": "plain"},
        {"ts": _ago(6), "action_type": "auth", "actor": "caf\u00e9 \u2026"},
    ])
    async with pg_engine.connect() as conn:
        with pytest.raises(DBAPIError, match="cannot be converted to text"):
            await conn.execute(select(AuditRow.doc["action_type"].as_string()))
    async with pg_engine.connect() as conn:
        rows = (await conn.execute(
            select(_audit_field("actor"), _audit_field("action_type")).order_by(AuditRow.ts.desc())
        )).all()
    assert [r[0] for r in rows] == [
        "xy", "lonelow", "literal \\u0000 text", "pair \U0001F600 and \\", "plain", "caf\u00e9 \u2026"]
    assert {r[1] for r in rows} == {"auth"}
    # The stored rows are untouched (append-only, #2).
    assert sum("\\u0000" in raw for raw in await _stored_text(pg_engine)) >= 2


# --------------------------------------------------------------------------- #
# Every audit read over a table holding a poisoned row
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("where", sorted(POISONS))
async def test_every_audit_read_answers_over_a_poisoned_row(pg_engine, where):
    corpus = _corpus(POISONS[where])
    await _insert_raw_audit(pg_engine, corpus)
    repo = SqlAuditRepository(pg_engine)
    windows = {"7d": 7, "30d": 30, "90d": 90, "none": None}
    for scope in ("people", "agent", "all", None):
        for label, days in windows.items():
            filters = AuditFilters(scope=scope, ts_from=None if days is None else NOW - timedelta(days=days))
            predicate = build_predicate(filters)
            docs = await _page_all(repo, predicate)
            count, relation = await repo.count_matching(predicate, cap=1000)
            assert relation == "eq" and count == len(docs), (where, scope, label)
            in_window = [d for d in corpus if days is None or d["ts"] >= _ago(days)]
            if scope == "people":
                expected = [d for d in in_window if d["actor_type"] == "human"]
            elif scope == "agent":
                expected = [d for d in in_window if d["actor_type"] == "agent"]
            else:
                expected = in_window
            assert len(docs) == len(expected), (where, scope, label)
            # The poisoned row is read, not skipped, whenever it is in the window.
            if scope in ("people", "all", None):
                assert any(d["ts"] == corpus[0]["ts"] for d in docs), (where, scope, label)
    # Filters that read other JSON fields than the scope does.
    for filters in (
        AuditFilters(scope="people", q="login"),
        AuditFilters(scope="people", actor_contains="alice"),
        AuditFilters(scope="people", outcome="failure"),
        AuditFilters(scope="people", event="auth.login_failed"),
        AuditFilters(scope="people", actor="alice"),
    ):
        predicate = build_predicate(filters)
        assert await _page_all(repo, predicate) is not None
        await repo.count_matching(predicate, cap=50)
    # Per-run totals inside the page's snapshot.
    agent = build_predicate(AuditFilters(scope="agent"))
    page = await repo.search_page(agent, limit=10)
    assert await repo.run_totals(agent, ["run-1", "run-2"], snapshot=page.start) == {"run-1": 2, "run-2": 1}
    # The account-activity feed and chat's ``audit_search`` reader.
    assert [d["ts"] for d in await repo.records_for_actor("alice", limit=10)][:1] == [_ago(1)]
    rows = await repo.records(actor="alice", surface="auth", ts_from=_ago(90), limit=10)
    assert _ago(1) in [d["ts"] for d in rows]
    assert len(await repo.records(limit=100)) == len(corpus)


async def test_a_poisoned_actor_is_found_under_its_cleaned_name(pg_engine):
    """The production rows carried ``<payload>\\u0000<username>``: the cleaned read
    matches the name a person would search for, and the stored row is returned whole."""
    await _insert_raw_audit(pg_engine, _corpus(POISONS["actor"]))
    repo = SqlAuditRepository(pg_engine)
    hits = (await repo.search_page(build_predicate(AuditFilters(actor="../../etc/passwdalice")), limit=5)).hits
    assert len(hits) == 1 and hits[0].doc["actor"] == f"../../etc/passwd{NUL}alice"


# --------------------------------------------------------------------------- #
# The write side
# --------------------------------------------------------------------------- #
async def test_record_strict_never_stores_a_nul(pg_engine):
    """An audit-first write with NUL and lone surrogates in every kind of field
    succeeds, and the stored document holds neither (reads with a plain ``->>``)."""
    repo = SqlAuditRepository(pg_engine)
    await repo.record_strict(
        action_type=ActionType.AUTH_EVENT, actor=f"stg-nul{NUL}probe", surface="auth",
        action="auth.login_failed", outcome="failure", actor_type="human",
        result_summary=f"login{NUL} failed {LONE}", query_text=f"q{NUL}\nnext line",
        tool_input={f"k{NUL}": [f"v{NUL}", {"deep": f"d{LONE}"}]},
        target={"type": "user", "id": f"u{NUL}", "label": f"l{NUL}"},
        changes=[{"field": f"f{NUL}", "before": f"b{NUL}", "after": {"x": f"a{NUL}"}}],
        client={"peer": f"10.0.0.1{NUL}", "user_agent": f"ua{NUL}"},
    )
    (raw,) = await _stored_text(pg_engine)
    assert "\\u0000" not in raw.replace("\\\\u0000", "") and "\\ud800" not in raw
    async with pg_engine.connect() as conn:
        actor, summary, query = (await conn.execute(text(
            "SELECT doc->>'actor', doc->>'result_summary', doc->>'query_text' FROM audit"
        ))).one()
    assert (actor, summary, query) == ("stg-nulprobe", "login failed ", "q\nnext line")
    rows = await repo.records_for_actor("stg-nulprobe")
    assert rows[0]["tool_input"] == {"k": ["v", {"deep": "d"}]}
    assert rows[0]["target"]["id"] == "u" and rows[0]["changes"][0]["field"] == "f"


# --------------------------------------------------------------------------- #
# cases, usage and kv
# --------------------------------------------------------------------------- #
async def test_the_kv_compare_and_set_survives_a_nul_document(pg_engine):
    """A NUL anywhere in a KV document must not fail ``kv_mutate``'s revision predicate
    (``_rev`` is read with ``->>`` inside the UPDATE)."""
    kv = SqlKVStore(pg_engine)
    await kv.put("users", "entries", {"_rev": 3, "entries": [{"username": f"x{NUL}y"}], "note": LONE})
    async with pg_engine.connect() as conn:
        with pytest.raises(DBAPIError):
            await conn.execute(select(KVRow.value["_rev"].as_string()))
    assert await kv.put_if("users", "entries", {"_rev": 4, "entries": []}, 2) is False
    assert await kv.put_if("users", "entries", {"_rev": 4, "entries": [], "note": f"n{NUL}"}, 3) is True

    def bump(doc: dict[str, Any] | None) -> dict[str, Any]:
        out = dict(doc or {})
        out["count"] = int(out.get("count", 0)) + 1
        return out

    lock = asyncio.Lock()
    for _ in range(3):
        await kv_mutate(kv, "users", "entries", bump, lock=lock)
    stored = await kv.get("users", "entries")
    assert stored["count"] == 3 and stored["_rev"] == 7 and stored["note"] == f"n{NUL}"


def _case(cid: str, **kw: Any) -> Case:
    base: dict[str, Any] = {
        "case_id": cid, "cluster_signature": f"sig-{cid}", "source_surface": SourceSurface.INVESTIGATE,
        "entity": Entity(type=EntityType.IP, value="10.0.0.1"), "created_at": _ago(1),
    }
    base.update(kw)
    return Case(**base)


async def test_case_json_reads_survive_a_nul_document(pg_engine):
    """The ``risk_score`` sort and the aggregate push-down group-bys read ``cases.doc``
    with ``->>``; a NUL in another field of one case must not fail them."""
    repo = SqlCaseRepository(pg_engine)
    await repo.save(_case("case-a", risk_score=10, title=f"bad{NUL}title", verdict="FALSE_POSITIVE"))
    await repo.save(_case("case-b", risk_score=90, verdict="TRUE_POSITIVE"))
    await repo.save(_case("case-c", risk_score=2, assignee=f"al{NUL}ice"))
    # An older build's document, stored without any cleaning.
    async with pg_engine.begin() as conn:
        doc = (await repo.get("case-b")).model_dump(mode="json")
        doc["summary"] = f"poisoned{NUL}{LONE}"
        await conn.execute(text("UPDATE cases SET doc = CAST(:doc AS JSON) WHERE case_id = 'case-b'"),
                           {"doc": json.dumps(doc)})
    cases, total = await repo.list(sort_field="risk_score", sort_order="desc", limit=10)
    assert total == 3 and [c.case_id for c in cases] == ["case-b", "case-a", "case-c"]
    window = resolve_window("all", now=NOW)
    for field_name in ("verdict", "decided_by", "disposition", "assignee", "source"):
        result = await aggregate_cases(repo, CaseAggregateSpec(window=window, group_by=(field_name,)))
        assert result.total == 3, field_name
    result = await aggregate_cases(repo, CaseAggregateSpec(window=window, group_by=("verdict",)))
    assert result.method == "pushdown"
    by_verdict = {g["key"]["verdict"]: g["metrics"]["count"] for g in result.groups}
    assert by_verdict.get("FALSE_POSITIVE") == 1 and by_verdict.get("TRUE_POSITIVE") == 1
    assert sum(by_verdict.values()) == 3


async def test_usage_json_reads_survive_a_nul_document(pg_engine):
    """The usage push-down reads ``processing_tier`` and the token counts with ``->>``."""
    repo = SqlUsageRepository(pg_engine)
    for i, tier in enumerate(("standard", "flex", "batch")):
        await repo.write_strict(UsageDoc(ts=_ago(i + 1), role="investigator", model="mock-model",
                                         surface="investigate", prompt_tokens=10, completion_tokens=5,
                                         total_tokens=15, cost=0.01, processing_tier=tier))
    async with pg_engine.begin() as conn:
        await conn.execute(text(
            "UPDATE usage SET doc = CAST(:doc AS JSON) WHERE id = (SELECT min(id) FROM usage)"
        ), {"doc": json.dumps({**UsageDoc(ts=_ago(1), role="investigator", model="mock-model",
                                          surface="investigate", prompt_tokens=10, completion_tokens=5,
                                          total_tokens=15, cost=0.01).model_dump(mode="json"),
                               "error": f"boom{NUL}"})})
    spec = UsageAggregateSpec(window=resolve_window("all", now=NOW), group_by=("service_tier",),
                              metrics=("calls", "input_tokens", "output_tokens"))
    result = await aggregate_usage(repo, spec)
    assert result.method == "pushdown"
    assert sum(g["metrics"]["calls"] for g in result.groups) == 3
    assert sum(g["metrics"]["input_tokens"] for g in result.groups) == 30


# --------------------------------------------------------------------------- #
# The routes, on a real PostgreSQL state backend
# --------------------------------------------------------------------------- #
def _app(url: str) -> FastAPI:
    from app.api.deps import require_auth
    from app.api.routes import router as monolith_router
    from tests.conftest import mount_moved_routers

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, state_backend="postgres", state_db_url=url, auth_enabled=True,
        auth_jwt_secret="postgres-nul-acceptance-secret-0123456789", auth_seed_admin=True,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    return api


def _admin(client: TestClient) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def test_the_staging_nul_login_leaves_every_audit_read_working(pg_url, tmp_path: Path):
    """The exact staging vector, then every read the report lists, over a poisoned
    row an older build stored as well."""
    api = _app(pg_url)
    with TestClient(api) as client:
        auth = _admin(client)
        before = client.get("/api/audit", params={"scope": "people", "from": "now-7d"}, headers=auth)
        assert before.status_code == 200, before.text
        # The staging tool's bytes: a JSON ``\u0000`` escape inside the username.
        response = client.post(
            "/api/auth/login", content=b'{"username": "stg-nul\\u0000probe", "password": "wrong-password"}',
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 401 and response.json()["detail"] == "invalid credentials"
        state: AppState = client.app.state.tlsoc
        engine = state.control_audit._engine  # noqa: SLF001 (the test reads the stored text)
        # The rows an older build would have written as well: the scrubbed production
        # shape, and the same vector with a lone surrogate instead of the NUL.
        client.portal.call(_insert_raw_audit, engine, [
            _corpus(POISONS["actor"])[0] | {"ts": _ago(0.01)},
            _corpus(POISONS["lone_surrogate"])[0] | {"ts": _ago(0.02)},
        ])
        stored = client.portal.call(_stored_text, engine)
        assert sum("\\u0000" in raw for raw in stored) == 1  # only the raw-inserted one

        for scope in ("people", "agent", "all", None):
            for window in ("now-7d", "now-30d", "now-90d", None):
                params = {k: v for k, v in {"scope": scope, "from": window, "limit": 5}.items() if v}
                listed = client.get("/api/audit", params=params, headers=auth)
                assert listed.status_code == 200, (scope, window, listed.text)
                counted = client.get("/api/audit/count", params=params, headers=auth)
                assert counted.status_code == 200, (scope, window, counted.text)
        for params in ({"q": "login"}, {"actor": "stg-nulprobe"}, {"actor_contains": "nul"},
                       {"event": "auth.login_failed"}, {"outcome": "failure"}):
            listed = client.get("/api/audit", params={"scope": "people", "from": "now-7d", **params}, headers=auth)
            assert listed.status_code == 200, (params, listed.text)
        failed = client.get("/api/audit", params={"scope": "people", "from": "now-7d",
                                                  "event": "auth.login_failed"}, headers=auth).json()
        refused = [r for r in failed["records"] if r.get("actor") == "stg-nulprobe"]
        assert len(refused) == 1
        assert refused[0]["result_summary"] == "login failed: the username contains control or invalid characters"
        # The older lone-surrogate row is shown, its surrogate as U+FFFD.
        people = client.get("/api/audit", params={"scope": "people", "actor_contains": "alice"}, headers=auth)
        assert "alice\ufffd" in [r.get("actor") for r in people.json()["records"]]
        activity = client.get("/api/account/activity", headers=auth)
        assert activity.status_code == 200 and activity.json()["activity"], activity.text

        # A filtered export reads through the same store calls as the job.
        from app.engine.audit_export import count_events, write_export

        filters = AuditFilters(scope="people", ts_from=NOW - timedelta(days=7))
        count, relation = client.portal.call(count_events, state, filters)
        assert relation == "eq" and count >= 3
        out = tmp_path / "audit.jsonl"

        async def _no_stop(_rows: int) -> None:
            return None

        async def _export() -> Any:
            return await write_export(state, filters=filters, fmt="jsonl", path=out, checkpoint=_no_stop)

        client.portal.call(_export)
        assert len(out.read_bytes().splitlines()) == count


def test_a_nul_username_cannot_be_created_on_postgres(pg_url):
    api = _app(pg_url)
    with TestClient(api) as client:
        auth = _admin(client)
        response = client.post("/api/users", json={"username": "eve\u0000x", "password": "long-enough-1"},
                               headers=auth)
        assert response.status_code == 422, response.text
        state: AppState = client.app.state.tlsoc
        assert client.portal.call(state.users.get, "evex") is None
        users = client.get("/api/users", headers=auth).json()
        assert not any("eve" in str(u.get("username")) for u in users.get("users", users))


async def test_records_and_the_actor_feed_filter_through_the_cleaned_read(pg_engine):
    """``records`` and ``records_for_actor`` filter through the cleaned accessor too."""
    await _insert_raw_audit(pg_engine, [{"ts": _ago(1), "action_type": "auth", "surface": "auth",
                                         "actor": f"mal{NUL}lory"}])
    repo = SqlAuditRepository(pg_engine)
    assert len(await repo.records_for_actor("mallory")) == 1
    assert len(await repo.records(actor="mallory", surface="auth")) == 1
    assert await repo.count_matching(Eq("actor", "mallory"), cap=5) == (1, "eq")
