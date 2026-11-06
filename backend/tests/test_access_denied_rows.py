"""Round 14 roles-02 (backend half): Access denied rows record real refusals only.

* ``has_permission`` asks without writing anything, so a response that answers 200
  (``GET /api/jobs`` probing ``users:manage`` for what it may list) never leaves an
  Access denied row behind.
* A refused READ is recorded once per user, permission and route template per five
  minutes (the audit-view coalescing rule applied to denials); the next row written
  for the same key says how many refusals were coalesced since the previous one. The
  count is held in memory until then, so refusals coalesced after a key's last row
  are not recorded if the key is never refused again, the process restarts or the key
  is evicted (the recorder counts the evicted ones).
* A refused WRITE is recorded on its own row every time.
* An in-body refusal that decided with ``has_permission`` records itself (a thread
  edit by someone who is neither the author nor a moderator).
* Every row names the refused route (its template, never the values in the path) and
  carries the request's audit context.
* Every row goes to the real control audit, with Demo Mode on and off (SPEC §3.5), so
  a refusal made during a Demo session outlives it.

Offline: fake Elasticsearch, mock LLM, the real dependency chain and stores.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api import deps
from app.api.deps import AccessDenialRecorder, denial_recorder, require_auth
from app.api.routes import router as monolith_router
from app.api.routes_audit import router as audit_router
from app.api.routes_cases_collab import router as collab_router
from app.api.routes_jobs import router as jobs_router
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface, UserRole, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.models import Case, Entity
from app.state import AppState

T1 = UserRole.ANALYST_TIER1.value
CASE_ID = "case-denials-1"


def _make_app(tmp_path) -> FastAPI:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="access-denied-rows-secret",
        auth_seed_admin=True, jobs_artifact_dir=str(tmp_path / "artifacts"),
    )
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
        await state.update_prefs(prefs)
        await state.cases.save(Case(
            case_id=CASE_ID, cluster_signature=f"sig:{CASE_ID}", case_number="CASE-0042",
            source_surface=SourceSurface.INVESTIGATE,
            entity=Entity(type=EntityType.IP, value="203.0.113.7"),
            verdict=Verdict.NEEDS_HUMAN, confidence=0.4, status=CaseStatus.NEEDS_HUMAN,
        ))
        api.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (monolith_router, jobs_router, audit_router, collab_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    api.add_middleware(RequestIdMiddleware)
    return api


@pytest.fixture
def client(tmp_path):
    with TestClient(_make_app(tmp_path)) as c:
        _login(c, "Admin", "Admin@123")
        created = c.post("/api/users", json={"username": "tina", "password": "tina-pass-12345", "role": T1})
        assert created.status_code == 200, created.text
        c.cookies.clear()
        _login(c, "tina", "tina-pass-12345")
        yield c


def _login(c: TestClient, username: str, password: str) -> None:
    response = c.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _state(c: TestClient) -> AppState:
    return c.app.state.tlsoc


def _denials(c: TestClient) -> list[dict[str, Any]]:
    """Every Access denied row, oldest first."""
    state = _state(c)
    rows = c.portal.call(lambda: state.control_audit.records(action_type="access_denied", limit=500))
    return sorted(rows, key=lambda row: str(row.get("ts") or ""))


# --------------------------------------------------------------------------- #
# Asking is not being refused
# --------------------------------------------------------------------------- #
def test_listing_jobs_writes_no_access_denied_row(client):
    """``GET /api/jobs`` asks for ``users:manage``, ``models:read`` and
    ``automation:read`` to decide what it may list. Tier 1 lacks ``users:manage``, the
    answer is 200, and nothing was refused, so no row is written (the global job
    monitor polls this every minute for every signed-in person)."""
    from app.api.deps import access_view_for

    state = _state(client)
    view = client.portal.call(access_view_for, state, state.auth.principal("tina"))
    assert not view.allows("users", "manage")
    for _ in range(3):
        listed = client.get("/api/jobs")
        assert listed.status_code == 200, listed.text
    assert _denials(client) == []


def test_has_permission_answers_without_writing(client, monkeypatch):
    calls: list[dict[str, Any]] = []
    state = _state(client)

    async def spy(**kwargs: Any) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(state.control_audit, "record", spy)
    monkeypatch.setattr(state.control_audit, "record_strict", spy)
    assert client.get("/api/jobs").status_code == 200
    assert calls == []


# --------------------------------------------------------------------------- #
# Refused reads: one row per user, permission and route per window
# --------------------------------------------------------------------------- #
def test_a_refused_read_is_recorded_once_per_window_with_its_context(client):
    for _ in range(3):
        refused = client.get("/api/users")
        assert refused.status_code == 403
        assert refused.json()["detail"] == "permission denied: users:manage"
    rows = _denials(client)
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["actor"] == "tina"
    assert (row["outcome"], row["actor_type"], row["surface"]) == ("denied", "human", "rbac")
    assert row["result_summary"] == "denied users:manage for role analyst_tier1 on GET /api/users"
    assert row["tool_input"] == {
        "permission": "users:manage", "method": "GET", "route": "/api/users",
        "coalesce_seconds": 300, "repeats_since_previous": 0,
    }
    # The request's audit context (SPEC §4.5.3), so the row is a usable record.
    assert row["actor_role"] == T1
    assert row["session_ref"] and row["request_id"]
    assert row["client"]["ip_source"] == "peer"
    recorder = denial_recorder(_state(client))
    assert (recorder.written, recorder.coalesced, recorder.dropped) == (1, 2, 0)


def test_each_permission_and_route_has_its_own_window_and_path_values_stay_out(client):
    assert client.get("/api/users").status_code == 403
    for record_id in ("secret-record-1", "secret-record-2"):
        assert client.get(f"/api/audit/records/{record_id}").status_code == 403
    rows = _denials(client)
    assert [row["tool_input"]["route"] for row in rows] == ["/api/users", "/api/audit/records/{record_id}"]
    assert rows[1]["result_summary"] == (
        "denied audit:view for role analyst_tier1 on GET /api/audit/records/{record_id}"
    )
    # The route TEMPLATE is the key: the two ids coalesce, and neither is in a row.
    assert "secret-record" not in json.dumps(rows)


def test_the_next_row_after_the_window_counts_the_coalesced_refusals(client):
    clock = [1_000.0]
    denial_recorder(_state(client)).clock = lambda: clock[0]
    for _ in range(3):
        assert client.get("/api/users").status_code == 403
    clock[0] += 299.0
    assert client.get("/api/users").status_code == 403  # still inside the window
    assert len(_denials(client)) == 1
    clock[0] += 2.0  # 301 s after the first row
    assert client.get("/api/users").status_code == 403
    rows = _denials(client)
    assert len(rows) == 2
    assert rows[1]["tool_input"]["repeats_since_previous"] == 3
    assert rows[1]["result_summary"] == (
        "denied users:manage for role analyst_tier1 on GET /api/users "
        "(refused 3 more times since the previous record)"
    )
    clock[0] += 301.0
    assert client.get("/api/users").status_code == 403
    rows = _denials(client)
    assert len(rows) == 3 and rows[2]["tool_input"]["repeats_since_previous"] == 0


def test_a_read_row_that_could_not_be_written_is_written_by_the_next_refusal(client, monkeypatch):
    state = _state(client)
    real = state.control_audit.record_strict
    failures = [1]

    async def flaky(**kwargs: Any) -> None:
        if failures:
            failures.pop()
            raise RuntimeError("audit store unavailable")
        await real(**kwargs)

    monkeypatch.setattr(state.control_audit, "record_strict", flaky)
    # The refusal stands whatever happens to its row.
    assert client.get("/api/users").status_code == 403
    assert _denials(client) == []
    assert denial_recorder(state).dropped == 1
    assert client.get("/api/users").status_code == 403
    rows = _denials(client)
    assert len(rows) == 1
    assert rows[0]["tool_input"]["repeats_since_previous"] == 1
    assert rows[0]["result_summary"].endswith("(refused 1 more time since the previous record)")


# --------------------------------------------------------------------------- #
# Refused writes: every one is recorded
# --------------------------------------------------------------------------- #
def test_every_refused_write_is_recorded(client):
    for index in range(3):
        refused = client.post("/api/users", json={
            "username": f"nobody{index}", "password": "nobody-pass-12345", "role": T1,
        })
        assert refused.status_code == 403
    rows = _denials(client)
    assert len(rows) == 3
    assert {row["result_summary"] for row in rows} == {
        "denied users:manage for role analyst_tier1 on POST /api/users"
    }
    assert all(row["tool_input"] == {"permission": "users:manage", "method": "POST", "route": "/api/users"}
               for row in rows)
    assert len({row["request_id"] for row in rows}) == 3


def test_a_thread_edit_refused_to_a_non_moderator_is_recorded_each_time(client):
    """Tier 1 may comment but is no moderator (``cases:close``): editing someone else's
    message is refused, and each refusal is its own row naming the case as its target.
    The row carries no ``case_id``, so the case's own timeline is unchanged."""
    client.cookies.clear()
    _login(client, "Admin", "Admin@123")
    admin_msg = client.post(f"/api/cases/{CASE_ID}/thread", json={"body": "admin note"})
    assert admin_msg.status_code == 200, admin_msg.text
    client.cookies.clear()
    _login(client, "tina", "tina-pass-12345")
    for _ in range(2):
        refused = client.patch(f"/api/cases/{CASE_ID}/thread/{admin_msg.json()['id']}", json={"body": "mine now"})
        assert refused.status_code == 403
    assert client.delete(f"/api/cases/{CASE_ID}/thread/{admin_msg.json()['id']}").status_code == 403
    rows = _denials(client)
    assert len(rows) == 3
    assert [row["tool_input"]["method"] for row in rows] == ["PATCH", "PATCH", "DELETE"]
    assert rows[0]["result_summary"] == (
        "denied cases:close for role analyst_tier1 on PATCH /api/cases/{case_id}/thread/{msg_id}"
    )
    assert all(row["target"] == {"type": "case", "id": CASE_ID, "label": "CASE-0042", "revision": None}
               for row in rows)
    assert all(not row.get("case_id") for row in rows)
    # Her own message is hers to edit, and the moderator may edit anyone's: no rows.
    own = client.post(f"/api/cases/{CASE_ID}/thread", json={"body": "tier one note"})
    assert client.patch(f"/api/cases/{CASE_ID}/thread/{own.json()['id']}", json={"body": "edited"}).status_code == 200
    client.cookies.clear()
    _login(client, "Admin", "Admin@123")
    assert client.patch(f"/api/cases/{CASE_ID}/thread/{own.json()['id']}", json={"body": "moderated"}).status_code == 200
    assert len(_denials(client)) == 3


def test_denial_rows_go_to_the_real_log_with_demo_mode_on(client):
    """SPEC §3.5: an Access denied row is a control row. With Demo Mode on, a refused
    read and a refused thread edit on a Demo case are both written to the real control
    audit (never the Demo audit, which ends with the Demo session), the edit naming the
    Demo case it was refused on; they are still there once Demo Mode is off."""
    state = _state(client)
    client.cookies.clear()
    _login(client, "Admin", "Admin@123")
    client.portal.call(state.enable_demo)
    try:
        demo_cases, _total = client.portal.call(lambda: state.cases.list(limit=1))
        demo_case = demo_cases[0]
        assert demo_case.case_id != CASE_ID
        admin_msg = client.post(f"/api/cases/{demo_case.case_id}/thread", json={"body": "admin note"})
        assert admin_msg.status_code == 200, admin_msg.text
        client.cookies.clear()
        _login(client, "tina", "tina-pass-12345")
        assert client.get("/api/users").status_code == 403
        edited = client.patch(f"/api/cases/{demo_case.case_id}/thread/{admin_msg.json()['id']}",
                              json={"body": "mine now"})
        assert edited.status_code == 403
        during = _denials(client)
        demo_rows = client.portal.call(
            lambda: state.demo_audit.records(action_type="access_denied", limit=50))
    finally:
        client.portal.call(state.disable_demo)
    assert [row["tool_input"]["method"] for row in during] == ["GET", "PATCH"]
    assert during[1]["target"]["id"] == demo_case.case_id
    assert during[1]["target"]["label"] == (demo_case.case_number or demo_case.case_id)
    assert demo_rows == []
    after = _denials(client)
    assert [row["result_summary"] for row in after] == [row["result_summary"] for row in during]


# --------------------------------------------------------------------------- #
# The recorder itself
# --------------------------------------------------------------------------- #
async def test_the_recorder_map_is_bounded_and_a_pending_key_coalesces():
    written: list[int] = []

    async def row(repeats: int) -> None:
        written.append(repeats)

    recorder = AccessDenialRecorder(clock=lambda: 0.0, max_keys=2)

    async def refuse(route: str) -> bool:
        return await recorder.record(read=True, actor="tina", permission="users:manage",
                                     method="GET", route=route, write_row=row)

    assert [await refuse("/a"), await refuse("/b"), await refuse("/a")] == [True, True, False]
    assert await refuse("/b") is False  # coalesced: /b now holds one unwritten refusal
    assert await refuse("/c") is True   # evicts the least recently seen key, /a
    assert recorder.unrecorded == 1     # /a's coalesced refusal had no later row
    assert await refuse("/a") is True   # forgotten, so written again
    assert written == [0, 0, 0, 0]
    assert recorder.unrecorded == 2     # /b was evicted in turn, its count with it
    recorder.reset()
    assert (recorder.written, recorder.coalesced, recorder.dropped, recorder.unrecorded) == (0, 0, 0, 0)
    # A refusal that arrives while the same key's row is being written adds no row and
    # is counted toward the next one.
    gate: list[bool] = []

    async def slow(repeats: int) -> None:
        gate.append(await refuse("/slow"))
        written.append(repeats)

    assert await recorder.record(read=True, actor="tina", permission="users:manage", method="GET",
                                 route="/slow", write_row=slow) is True
    assert gate == [False]
    assert recorder._seen[recorder.key("tina", "users:manage", "GET", "/slow")].repeats == 1  # noqa: SLF001


async def test_a_write_refusal_never_coalesces_and_a_failed_row_never_raises():
    async def boom(_repeats: int) -> None:
        raise RuntimeError("down")

    recorder = AccessDenialRecorder(clock=lambda: 0.0)
    kwargs = {"actor": "tina", "permission": "users:manage", "method": "POST", "route": "/api/users"}
    assert await recorder.record(read=False, write_row=boom, **kwargs) is False
    assert recorder.dropped == 1

    async def ok(_repeats: int) -> None:
        return None

    assert [await recorder.record(read=False, write_row=ok, **kwargs) for _ in range(3)] == [True] * 3
    assert recorder.coalesced == 0


def test_each_state_has_its_own_recorder():
    first, second = object.__new__(AppState), object.__new__(AppState)
    assert denial_recorder(first) is denial_recorder(first)
    assert denial_recorder(first) is not denial_recorder(second)
    # A state that cannot be weakly referenced still gets a recorder.
    assert isinstance(denial_recorder({"not": "hashable"}), AccessDenialRecorder)


def test_the_route_text_is_the_template_and_bounded():
    class _Route:
        path_format = "/api/users/{username}"

    method, route = deps._request_route(  # noqa: SLF001
        type("R", (), {"scope": {"method": "get", "path": "/api/users/alice", "route": _Route()}})()
    )
    assert (method, route) == ("GET", "/api/users/{username}")
    method, route = deps._request_route(  # noqa: SLF001
        type("R", (), {"scope": {"method": "GET", "path": "/api/" + "x" * 500 + "\n<b>"}})()
    )
    assert len(route) == 200 and "\n" not in route and "<" not in route
