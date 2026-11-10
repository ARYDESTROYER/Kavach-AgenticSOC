"""A ``\\u0000`` (or a lone surrogate) never reaches a stored audit row, a username or
a silent empty answer. Offline: SQLite, the fake Elasticsearch and the mock model.

A NUL stored in a PostgreSQL ``json`` audit document made every JSON-filtered read of
that row fail; the PostgreSQL proof is ``tests/test_postgres_json_nul.py``. This file
covers what does not need PostgreSQL:

* the one write sanitiser on the ``AuditDoc`` models (``app.stored_text``): faithful,
  bounded, never raising;
* the username rule at sign-in (characters only: still a ``401``, recorded cleaned; a
  longer name an older build allowed still signs in), at user creation (``422``, never
  echoing the value), in the user store and in the first-run setup;
* the account-activity feed and chat's ``audit_search`` reporting a failed read as
  unavailable, never as no rows;
* the ``readable_json`` accessor compiling to the unchanged SQL on SQLite.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import postgresql, sqlite

from app.agents.chat_tools.ops import AuditSearchTool
from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_setup import router as setup_router
from app.audit.audit_log import AuditLogger
from app.audit.events import truncated_fields
from app.config import Secrets
from app.constants import ActionType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.auth.passwords import hash_password
from app.models import AUDIT_ACTOR_MAX_CHARS, AuditDoc, User
from app.state import AppState
from app.stored_text import (
    USERNAME_MAX_CHARS,
    clean_tree,
    multi_line,
    shown,
    single_line,
    username_char_problem,
    username_problem,
)
from app.stores.base import build_audit_doc
from app.stores.sql import SqlAuditRepository, build_async_engine, create_all
from app.stores.sql.json_read import readable_json
from app.stores.sql.models import AuditRow, CaseRow, KVRow, UsageRow
from app.stores.sql.repositories import SqlKVStore, _audit_field
from app.stores.users import UserStore
from tests.conftest import mount_moved_routers
from tests.test_chat_tools_support import make_ctx

NUL = "\x00"
LONE = "\ud800"


def _payload(doc: AuditDoc) -> str:
    """The stored JSON text of a row, as the SQL backend serialises it."""
    return json.dumps(doc.model_dump(mode="json"))


# --------------------------------------------------------------------------- #
# The text policy
# --------------------------------------------------------------------------- #
def test_the_text_policy_removes_and_never_replaces() -> None:
    assert single_line(f"a{NUL}b\tc\nd\x7fe\x85f{LONE}g") == "abcdefg"
    assert single_line("x" * 300, 160) == "x" * 160
    assert multi_line(f"line{NUL} one\n\ttwo{LONE}") == "line one\n\ttwo"
    assert clean_tree({f"k{NUL}": [f"v{NUL}", (f"t{LONE}",), 7, None]}) == {"k": ["v", ("t",), 7, None]}
    # Not a string: passed through for validation to judge.
    assert single_line(42) == 42 and multi_line(None) is None
    # Display only: a lone surrogate is marked, a NUL is kept (JSON escapes it).
    assert shown({f"a{LONE}": [f"x{NUL}{LONE}"]}) == {"a�": [f"x{NUL}�"]}


@pytest.mark.parametrize("name, problem", [
    ("alice", None), (" alice\n", None), ("", None), ("a" * USERNAME_MAX_CHARS, None),
    (f"stg-nul{NUL}probe", "control"), ("tab\tin", "control"), (f"x{LONE}", "control"),
    ("a" * (USERNAME_MAX_CHARS + 1), "longer"),
])
def test_username_problem(name: str, problem: str | None) -> None:
    found = username_problem(name)
    assert (found is None) if problem is None else (problem in (found or ""))
    # Sign-in checks the characters only: length is bounded where accounts are created.
    chars = username_char_problem(name)
    assert (chars is None) if problem in (None, "longer") else (problem in (chars or ""))


# --------------------------------------------------------------------------- #
# The write sanitiser on the AuditDoc models
# --------------------------------------------------------------------------- #
def test_every_audit_string_is_cleaned_on_write_and_the_row_still_written() -> None:
    tool_input = {f"user{NUL}": [f"a{NUL}b", {"deep": f"d{LONE}"}], "n": 3}
    doc = AuditDoc(
        action_type=ActionType.AUTH_EVENT, event_id=f"ev{NUL}1", case_id=f"case{NUL}-1",
        source_id=f"src{NUL}", surface=f"auth{NUL}", actor=f"../../etc/passwd{NUL}alice",
        model=f"m{NUL}", tool_name=f"t{NUL}", run_id=f"run{NUL}-1", actor_role=f"ad{NUL}min",
        prompt_excerpt=f"p{NUL}\nq", query_text=f"select{NUL}\n1", tool_output_summary=f"o{LONE}",
        result_summary=f"login{NUL} failed\n", tool_input=tool_input,
        target={"type": "user", "id": f"u{NUL}", "label": f"La{NUL}bel"},
        changes=[{"field": f"f{NUL}", "before": f"b{NUL}\nc", "after": {"x": f"y{LONE}"}}],
        client={"peer": f"10.0.0.1{NUL}", "forwarded_for": f"1.1.1.1{NUL}", "user_agent": f"UA{NUL}"},
    )
    payload = _payload(doc)
    assert "\\u0000" not in payload and "\\ud800" not in payload
    # Faithful: what was attempted is still there, minus the characters.
    assert doc.actor == "../../etc/passwdalice"
    assert (doc.event_id, doc.case_id, doc.source_id, doc.surface) == ("ev1", "case-1", "src", "auth")
    assert (doc.model, doc.tool_name, doc.run_id, doc.actor_role) == ("m", "t", "run-1", "admin")
    # Multi-line text keeps its line breaks.
    assert (doc.prompt_excerpt, doc.query_text, doc.result_summary) == ("p\nq", "select\n1", "login failed\n")
    assert doc.tool_output_summary == "o"
    assert doc.tool_input == {"user": ["ab", {"deep": "d"}], "n": 3}
    assert tool_input == {f"user{NUL}": [f"a{NUL}b", {"deep": f"d{LONE}"}], "n": 3}  # not mutated
    assert (doc.target.id, doc.target.label) == ("u", "Label")
    assert (doc.changes[0].field, doc.changes[0].before, doc.changes[0].after) == ("f", "b\nc", '{"x": "y"}')
    assert (doc.client.peer, doc.client.forwarded_for, doc.client.user_agent) == ("10.0.0.1", "1.1.1.1", "UA")


def test_the_actor_is_bounded_like_a_username_and_never_blanked() -> None:
    long = AuditDoc(action_type=ActionType.AUTH_EVENT, actor="x" * 500)
    assert AUDIT_ACTOR_MAX_CHARS == USERNAME_MAX_CHARS == 160 and long.actor == "x" * 160
    # A name made only of removed characters still shows that a name was given.
    only_controls = AuditDoc(action_type=ActionType.AUTH_EVENT, actor=f"{NUL}\n{LONE}")
    assert only_controls.actor == "\ufffd" and "\\u0000" not in _payload(only_controls)
    # No actor stays no actor.
    assert AuditDoc(action_type=ActionType.AUTH_EVENT, actor="").actor == ""


def test_a_required_value_made_only_of_controls_keeps_the_row() -> None:
    """``target.id`` and ``changes[].field`` must not be empty: a value that cleaning
    would empty is kept as one U+FFFD, so an audit-first write never starts failing."""
    doc = AuditDoc(
        action_type=ActionType.USER_MGMT, actor="admin",
        target={"type": "user", "id": NUL}, changes=[{"field": f"{NUL}{LONE}", "after": "x"}],
    )
    assert doc.target.id == "�" and doc.changes[0].field == "�"
    assert "\\u0000" not in _payload(doc)


def test_the_write_cap_still_marks_a_truncated_field_after_cleaning() -> None:
    doc = build_audit_doc(action_type=ActionType.ERROR, actor="pipeline",
                          result_summary=(f"a{NUL}" * 1500), prompt_excerpt=f"short{NUL}")
    assert len(doc.result_summary) == 1000 and doc.result_summary.endswith("…")
    assert "result_summary" in truncated_fields(doc.model_dump(mode="json"))
    assert doc.prompt_excerpt == "short"


def test_a_keyed_retry_builds_the_same_row() -> None:
    """The keyed (``event_id``) retry compares the stored payload with the new one:
    cleaning is deterministic, so the same writer call builds the same row."""
    fields = dict(action_type=ActionType.PROPOSAL, event_id="proposal:1:approve", actor=f"a{NUL}b",
                  ts="2026-11-10T00:00:00+00:00", tool_input={"k": f"v{NUL}"})
    assert build_audit_doc(**fields).model_dump(mode="json") == build_audit_doc(**fields).model_dump(mode="json")


async def test_record_strict_on_sqlite_succeeds_and_stores_the_clean_row() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        repo = SqlAuditRepository(engine)
        await repo.record_strict(action_type=ActionType.AUTH_EVENT, actor=f"x{NUL}y",
                                 result_summary=f"r{NUL}", changes=[{"field": "f", "after": f"a{NUL}"}])
        (row,) = await repo.records_for_actor("xy")
        assert row["actor"] == "xy" and row["result_summary"] == "r" and row["changes"][0]["after"] == "a"
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# The NUL-safe JSON accessor
# --------------------------------------------------------------------------- #
def test_the_accessor_leaves_sqlite_sql_unchanged_and_cleans_on_postgresql() -> None:
    pairs = [
        (AuditRow.doc["actor"].as_string(), _audit_field("actor")),
        (AuditRow.doc[("client", "ip")].as_string(), _audit_field("client.ip")),
        (CaseRow.doc["risk_score"].as_float(), readable_json(CaseRow.doc)["risk_score"].as_float()),
        (UsageRow.doc["prompt_tokens"].as_integer(), readable_json(UsageRow.doc)["prompt_tokens"].as_integer()),
        (KVRow.value["_rev"].as_string(), readable_json(KVRow.value)["_rev"].as_string()),
    ]
    for plain, safe in pairs:
        assert str(select(plain).compile(dialect=sqlite.dialect())) == str(
            select(safe).compile(dialect=sqlite.dialect()))
        compiled = str(select(safe).compile(dialect=postgresql.asyncpg.dialect()))
        assert "regexp_replace" in compiled and "strpos" in compiled
        assert "->>" in compiled or "#>>" in compiled
    # The real columns are untouched.
    assert _audit_field("action_type") is AuditRow.action_type and _audit_field("case_id") is AuditRow.case_id


async def test_the_kv_compare_and_set_on_sqlite_is_unchanged() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        kv = SqlKVStore(engine)
        await kv.put("ns", "k", {"_rev": 1, "v": f"a{NUL}"})
        assert await kv.put_if("ns", "k", {"_rev": 2}, 0) is False
        assert await kv.put_if("ns", "k", {"_rev": 2}, 1) is True
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# The username rule in the stores
# --------------------------------------------------------------------------- #
class _MemoryKV:
    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict[str, Any]] = {}

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        doc = self.docs.get((namespace, key))
        return json.loads(json.dumps(doc)) if doc is not None else None

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self.docs[(namespace, key)] = json.loads(json.dumps(value))


async def test_the_user_store_refuses_a_nul_or_overlong_username() -> None:
    store = UserStore(_MemoryKV())
    for bad in (f"eve{NUL}x", f"eve{LONE}", "e" * (USERNAME_MAX_CHARS + 1), "  "):
        with pytest.raises(ValueError):
            await store.create(username=bad, password_hash="h")
        with pytest.raises(ValueError):
            await store.create_if_absent(username=bad, password_hash="h")
    assert await store.list() == []
    created = await store.create(username=" alice ", password_hash="h")
    assert created.username == "alice"


# --------------------------------------------------------------------------- #
# The routes
# --------------------------------------------------------------------------- #
def _app(tmp_path: Any, **extra: Any) -> FastAPI:
    setup_complete = extra.pop("setup_complete", True)
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{tmp_path}/s.db",
        auth_enabled=True, auth_jwt_secret="nul-hygiene-secret-0123456789abcdef", **extra,
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": setup_complete}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(setup_router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    return api


def _admin(client: TestClient) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _failed_logins(client: TestClient) -> list[dict[str, Any]]:
    state: AppState = client.app.state.tlsoc
    rows = client.portal.call(lambda: state.control_audit.records(limit=500))
    return [r for r in rows if r.get("action") == "auth.login_failed"]


def test_a_nul_login_is_a_401_recorded_clean_and_the_default_view_still_reads(tmp_path) -> None:
    with TestClient(_app(tmp_path, auth_seed_admin=True)) as client:
        auth = _admin(client)
        response = client.post("/api/auth/login", json={"username": "x\u0000y", "password": "no"})
        assert response.status_code == 401 and response.json()["detail"] == "invalid credentials"
        # The staging tool's exact bytes.
        staged = client.post(
            "/api/auth/login", content=b'{"username": "stg-nul\\u0000probe", "password": "nope"}',
            headers={"Content-Type": "application/json"},
        )
        assert staged.status_code == 401
        long_name = client.post("/api/auth/login", json={"username": "z" * 400, "password": "no"})
        assert long_name.status_code == 401
        only_nul = client.post("/api/auth/login", json={"username": "\u0000", "password": "no"})
        assert only_nul.status_code == 401
        rows = _failed_logins(client)
        by_actor = {r["actor"]: r for r in rows}
        assert set(by_actor) >= {"xy", "stg-nulprobe", "z" * 160, "\ufffd"}
        assert by_actor["xy"]["result_summary"] == (
            "login failed: the username contains control or invalid characters")
        assert by_actor["\ufffd"]["result_summary"] == by_actor["xy"]["result_summary"]
        # A long name is looked up like any other (no account has it), recorded bounded.
        assert by_actor["z" * 160]["result_summary"] == "login failed"
        assert all(NUL not in json.dumps(r) and "\\u0000" not in json.dumps(r) for r in rows)
        listed = client.get("/api/audit", params={"scope": "people", "from": "now-7d"}, headers=auth)
        assert listed.status_code == 200
        assert "stg-nulprobe" in [r.get("actor") for r in listed.json()["records"]]
        # An ordinary wrong password is unchanged.
        client.post("/api/auth/login", json={"username": "Admin", "password": "wrong"})
        assert any(r["actor"] == "Admin" and r["result_summary"] == "login failed" for r in _failed_logins(client))


def test_a_nul_or_overlong_username_cannot_be_created(tmp_path) -> None:
    with TestClient(_app(tmp_path, auth_seed_admin=True)) as client:
        auth = _admin(client)
        for bad in ("eve\u0000x", "eve\nx", "e" * 161):
            response = client.post("/api/users", json={"username": bad, "password": "long-enough-1"}, headers=auth)
            assert response.status_code == 422, (bad, response.text)
            # The answer says why, and never echoes the value.
            assert isinstance(response.json()["detail"], str) and "eve" not in response.text
        # A lone surrogate is a 422 too, not a 500 (an echoed one cannot be encoded).
        lone = client.post(
            "/api/users", content=b'{"username": "eve\\ud800", "password": "long-enough-1"}',
            headers={**auth, "Content-Type": "application/json"},
        )
        assert lone.status_code == 422, lone.text
        assert "control" in lone.json()["detail"]
        ok = client.post("/api/users", json={"username": "eve", "password": "long-enough-1"}, headers=auth)
        assert ok.status_code == 200, ok.text
        state: AppState = client.app.state.tlsoc
        names = [u.username for u in client.portal.call(state.users.list)]
        assert "eve" in names and not any(NUL in n or len(n) > 160 for n in names)


def test_a_longer_name_an_older_build_created_still_signs_in_and_sees_its_activity(tmp_path) -> None:
    """An older build created accounts with no length bound. Such an account still
    signs in, and its activity feed shows both its new rows (actor bounded to 160 on
    write) and the older rows that carry the whole name."""
    long_name = "svc." + "a" * 170 + "@example.com"
    assert len(long_name) > USERNAME_MAX_CHARS
    with TestClient(_app(tmp_path, auth_seed_admin=True)) as client:
        state: AppState = client.app.state.tlsoc

        async def seed() -> None:
            users = await state.users.list()
            legacy = User(username=long_name, password_hash=hash_password("Long-Pass-123!"),
                          role="analyst_tier1", active=True)
            await state.users._save([*users, legacy])  # noqa: SLF001 (as an older build stored it)
            await state.refresh_users()
            # A row an older build wrote, with the whole name as the actor.
            older = AuditDoc(action_type=ActionType.AUTH_EVENT, actor="placeholder",
                             ts="2026-01-01T00:00:00+00:00", result_summary="older row")
            raw = older.model_dump(mode="json") | {"actor": long_name}
            async with state.control_audit._sm() as session:  # noqa: SLF001
                session.add(AuditRow(ts=raw["ts"], action_type=raw["action_type"], doc=raw))
                await session.commit()

        client.portal.call(seed)
        response = client.post("/api/auth/login", json={"username": long_name, "password": "Long-Pass-123!"})
        assert response.status_code == 200, response.text
        auth = {"Authorization": f"Bearer {response.json()['token']}"}
        activity = client.get("/api/account/activity", headers=auth)
        assert activity.status_code == 200, activity.text
        rows = activity.json()["activity"]
        assert any(r.get("actor") == long_name[:USERNAME_MAX_CHARS] for r in rows)
        assert rows[-1]["result_summary"] == "older row" and rows[-1]["actor"] == long_name
        stamps = [str(r.get("ts") or "") for r in rows]
        assert stamps == sorted(stamps, reverse=True)
        assert len(client.get("/api/account/activity", params={"limit": 1}, headers=auth).json()["activity"]) == 1


def test_the_first_run_setup_refuses_a_nul_username(tmp_path) -> None:
    with TestClient(_app(tmp_path, auth_seed_admin=False, setup_complete=False)) as client:
        response = client.post("/api/setup/account",
                               json={"username": "ro\u0000ot", "password": "Str0ng-OOBE-Pass!"})
        assert response.status_code == 400 and "control" in response.json()["detail"]
        state: AppState = client.app.state.tlsoc
        assert client.portal.call(state.users.list) == []


def test_account_activity_reports_a_failed_read_as_unavailable(tmp_path, monkeypatch) -> None:
    with TestClient(_app(tmp_path, auth_seed_admin=True)) as client:
        auth = _admin(client)
        assert client.get("/api/account/activity", headers=auth).json()["activity"]
        state: AppState = client.app.state.tlsoc

        async def broken(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
            raise RuntimeError("the store is down")

        monkeypatch.setattr(state.control_audit, "records_for_actor", broken)
        response = client.get("/api/account/activity", headers=auth)
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "audit_unavailable"


# --------------------------------------------------------------------------- #
# A failed read is never "no rows"
# --------------------------------------------------------------------------- #
async def test_the_bundled_record_readers_raise_instead_of_answering_empty() -> None:
    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    repo = SqlAuditRepository(engine)

    class _Broken:
        def __call__(self) -> Any:
            raise RuntimeError("the database is gone")

    repo._sm = _Broken()  # noqa: SLF001 (simulate a store that cannot be read)
    with pytest.raises(RuntimeError):
        await repo.records_for_actor("alice")
    with pytest.raises(RuntimeError):
        await repo.records(actor="alice")
    await engine.dispose()

    class _BrokenES(InMemoryESClient):
        async def search(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("the cluster is gone")

    es_repo = AuditLogger(_BrokenES())
    with pytest.raises(RuntimeError):
        await es_repo.records_for_actor("alice")
    with pytest.raises(RuntimeError):
        await es_repo.records(actor="alice")


async def test_chat_audit_search_says_the_trail_did_not_answer() -> None:
    class _Down:
        async def records(self, **_kwargs: Any) -> list[dict[str, Any]]:
            raise RuntimeError("the store is down")

    out = await AuditSearchTool().run(make_ctx(audit=_Down()), actor="alice")
    assert not out.ok and "did not answer" in (out.error or out.summary or "")
