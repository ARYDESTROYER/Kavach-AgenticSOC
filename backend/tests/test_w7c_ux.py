"""Round-2 Wave 7c — global search + bulk case actions + audit viewer.

Covers, over the real router:

* ``GET /api/search`` — typed results (cases matched on id/number/title/entity/
  tags/source_name + static nav targets); works against the ACTIVE store.
* ``POST /api/cases/bulk`` — applies a HUMAN lifecycle action to N cases via the
  EXACT single-case path, audits EACH case, is partial-failure tolerant (a bad id
  fails only that id), and is RBAC-gated (a non-permitted action → 403). A guard
  asserts bulk close goes through the analyst action path and NEVER invokes the
  deterministic ``case_manager.decide()`` (#3-safe).
* ``GET /api/audit`` — filtered, bounded, read-only; gated by ``audit:view``
  (401/403 without it).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState
from tests._auth_helpers import ready_user


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _make_case(case_id: str, **kw) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig-{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=kw.pop("entity", "203.0.113.10")),
        status=kw.pop("status", CaseStatus.OPEN),
        **kw,
    )


async def _seed_cases(state: AppState) -> None:
    await state.cases.save(_make_case(
        "case-aaa", case_number="CASE-000001", title="brute force on web01",
        entity="10.0.0.5", tags=["priority"], source_name="prod-elastic"))
    await state.cases.save(_make_case(
        "case-bbb", case_number="CASE-000002", title="malware beacon",
        entity="10.0.0.6", source_name="edr-fleet"))
    await state.cases.save(_make_case(
        "case-ccc", case_number="CASE-000003", title="recon scan",
        entity="10.0.0.7"))


# --------------------------------------------------------------------------- #
# clients
# --------------------------------------------------------------------------- #
@pytest.fixture
def seeded_client(secrets, mock_provider):
    """No-auth client (the default profile) with three pre-seeded cases."""
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await _seed_cases(state)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from tests.conftest import mount_moved_routers

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    with TestClient(api) as c:
        yield c


def _auth_client(**secret_overrides):
    """An auth-on (+ optional rbac-on) client with the auth gate, three seeded cases.
    Mirrors the main.py mount. Use as a context manager."""
    rbac_enabled = secret_overrides.pop("rbac_enabled", False)
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, **secret_overrides,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac_enabled
        await state.update_prefs(prefs)
        await _seed_cases(state)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from tests.conftest import mount_moved_routers

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c: TestClient, username: str, password: str):
    return c.post("/api/auth/login", json={"username": username, "password": password})


# --------------------------------------------------------------------------- #
# 1. global search
# --------------------------------------------------------------------------- #
def test_search_matches_cases_by_title_and_entity(seeded_client):
    r = seeded_client.get("/api/search", params={"q": "brute"})
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [c["id"] for c in body["cases"]]
    assert "case-aaa" in ids
    assert "case-bbb" not in ids
    # entity match
    r2 = seeded_client.get("/api/search", params={"q": "10.0.0.6"})
    assert "case-bbb" in [c["id"] for c in r2.json()["cases"]]
    # case_number match
    r3 = seeded_client.get("/api/search", params={"q": "CASE-000003"})
    assert "case-ccc" in [c["id"] for c in r3.json()["cases"]]


def test_search_matches_sources_and_source_name(seeded_client):
    r = seeded_client.get("/api/search", params={"q": "prod-elastic"})
    assert "case-aaa" in [c["id"] for c in r.json()["cases"]]


def test_search_returns_nav_targets(seeded_client):
    r = seeded_client.get("/api/search", params={"q": "cost"})
    assert r.status_code == 200
    nav = r.json()["nav"]
    assert any(t["id"] == "cost" for t in nav)
    # settings section is reachable too
    r2 = seeded_client.get("/api/search", params={"q": "users"})
    assert any(t["id"] == "users" and t["type"] == "settings" for t in r2.json()["nav"])


def test_search_empty_query_returns_bounded_everything(seeded_client):
    r = seeded_client.get("/api/search", params={"q": "", "limit": 2})
    body = r.json()
    assert len(body["cases"]) <= 2
    assert len(body["nav"]) <= 2


def test_search_works_against_active_store(seeded_client):
    # The seeded cases ARE the active store; a match proves the active-store read path.
    r = seeded_client.get("/api/search", params={"q": "malware"})
    assert "case-bbb" in [c["id"] for c in r.json()["cases"]]


# --------------------------------------------------------------------------- #
# 2. bulk case actions
# --------------------------------------------------------------------------- #
def test_bulk_action_applies_to_n_cases(seeded_client):
    r = seeded_client.post("/api/cases/bulk", json={
        "ids": ["case-aaa", "case-bbb"], "action": "acknowledge", "note": "triaged"})
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert {x["id"] for x in results} == {"case-aaa", "case-bbb"}
    assert all(x["ok"] for x in results)


def test_bulk_assign_and_tag(seeded_client):
    r = seeded_client.post("/api/cases/bulk", json={
        "ids": ["case-aaa", "case-bbb", "case-ccc"], "action": "acknowledge",
        "assignee": "alice", "tags": ["sweep"]})
    assert r.status_code == 200
    assert all(x["ok"] for x in r.json()["results"])
    # verify the side-effect went through the single-case path
    case = seeded_client.get("/api/cases/case-ccc").json()
    assert case["assignee"] == "alice"
    assert "sweep" in case["tags"]


def test_bulk_audits_each_case(seeded_client):
    seeded_client.post("/api/cases/bulk", json={
        "ids": ["case-aaa", "case-bbb"], "action": "hold", "reason": "vendor"})
    # The single-case action path records an ActionType.STATUS audit per case; the
    # audit endpoint (auth off → ungated) lists them.
    for cid in ("case-aaa", "case-bbb"):
        rows = seeded_client.get("/api/audit", params={"case_id": cid, "action": "status"}).json()
        assert rows["total"] >= 1
        assert any(row.get("case_id") == cid for row in rows["records"])


def test_bulk_partial_failure_on_bad_id(seeded_client):
    r = seeded_client.post("/api/cases/bulk", json={
        "ids": ["case-aaa", "does-not-exist"], "action": "acknowledge"})
    assert r.status_code == 200
    by_id = {x["id"]: x for x in r.json()["results"]}
    assert by_id["case-aaa"]["ok"] is True
    assert by_id["does-not-exist"]["ok"] is False
    assert by_id["does-not-exist"].get("error")
    # the good case still moved (acknowledge keeps status but is recorded)
    assert seeded_client.get("/api/cases/case-aaa").status_code == 200


def test_bulk_rejects_unknown_action_and_empty_ids(seeded_client):
    assert seeded_client.post("/api/cases/bulk", json={
        "ids": ["case-aaa"], "action": "nonsense"}).status_code == 400
    assert seeded_client.post("/api/cases/bulk", json={
        "ids": [], "action": "acknowledge"}).status_code == 400


def test_bulk_rbac_denies_non_permitted_action() -> None:
    # tier1 has cases:write but NOT cases:close → a bulk close is 403.
    with _auth_client(auth_enabled=True, auth_jwt_secret="bulk", rbac_enabled=True) as c:
        _login(c, "Admin", "Admin@123")
        c.post("/api/users", json={"username": "t1", "password": "t1password",
                                   "role": "analyst_tier1"})
        ready_user(c, "t1", "t1password")
        c.post("/api/auth/logout")
        assert _login(c, "t1", "t1password").status_code == 200
        # close-class action → needs cases:close → DENIED.
        r = c.post("/api/cases/bulk", json={"ids": ["case-aaa"], "action": "close"})
        assert r.status_code == 403
        # a write-class action (acknowledge) is permitted for tier1.
        r2 = c.post("/api/cases/bulk", json={"ids": ["case-aaa"], "action": "acknowledge"})
        assert r2.status_code == 200, r2.text


def test_bulk_close_uses_human_action_path_not_decide(seeded_client, monkeypatch):
    """#3 guard: a bulk CLOSE is the HUMAN analyst close — it must NEVER run the
    deterministic ``case_manager.decide()`` auto-close, and the status must be set
    via the analyst action path (decision_by == analyst, audited as STATUS)."""
    import app.engine.case_manager as cm

    calls = {"n": 0}
    real_decide = cm.decide

    def _spy(*a, **k):
        calls["n"] += 1
        return real_decide(*a, **k)

    monkeypatch.setattr(cm, "decide", _spy)

    r = seeded_client.post("/api/cases/bulk", json={
        "ids": ["case-aaa", "case-bbb"], "action": "close", "note": "benign"})
    assert r.status_code == 200, r.text
    assert all(x["ok"] for x in r.json()["results"])
    # decide() was NOT invoked by the bulk close path.
    assert calls["n"] == 0
    # status set via the analyst action path: CLOSED + decision_by == analyst.
    case = seeded_client.get("/api/cases/case-aaa").json()
    assert case["status"] == "closed"
    assert case["decision_by"] == "analyst"
    # audited as a STATUS transition (the human action path's audit), not a decide.
    rows = seeded_client.get("/api/audit", params={"case_id": "case-aaa", "action": "status"}).json()
    assert rows["total"] >= 1


# --------------------------------------------------------------------------- #
# 3. audit viewer
# --------------------------------------------------------------------------- #
def test_audit_list_filters_and_is_bounded(seeded_client):
    # generate some audit rows via single-case actions
    seeded_client.post("/api/cases/case-aaa/action", json={"action": "hold", "reason": "x"})
    seeded_client.post("/api/cases/case-bbb/action", json={"action": "acknowledge"})

    allrows = seeded_client.get("/api/audit").json()
    assert allrows["total"] >= 2

    # filter by case_id
    one = seeded_client.get("/api/audit", params={"case_id": "case-aaa"}).json()
    assert one["total"] >= 1
    assert all(r.get("case_id") == "case-aaa" for r in one["records"])

    # filter by action_type
    statuses = seeded_client.get("/api/audit", params={"action": "status"}).json()
    assert statuses["total"] >= 1
    assert all(r.get("action_type") == "status" for r in statuses["records"])

    # bounded by limit
    capped = seeded_client.get("/api/audit", params={"limit": 1}).json()
    assert len(capped["records"]) <= 1


def test_audit_gated_without_view_permission() -> None:
    with _auth_client(auth_enabled=True, auth_jwt_secret="aud", rbac_enabled=True) as c:
        # unauthenticated → 401
        assert c.get("/api/audit").status_code == 401
        # tier1 lacks audit:view → 403
        _login(c, "Admin", "Admin@123")
        c.post("/api/users", json={"username": "t1", "password": "t1password",
                                   "role": "analyst_tier1"})
        ready_user(c, "t1", "t1password")
        c.post("/api/auth/logout")
        _login(c, "t1", "t1password")
        assert c.get("/api/audit").status_code == 403
        # an auditor (audit:view) is allowed.
        c.post("/api/auth/logout")
        _login(c, "Admin", "Admin@123")
        c.post("/api/users", json={"username": "aud", "password": "audpassword",
                                   "role": "auditor"})
        ready_user(c, "aud", "audpassword")
        c.post("/api/auth/logout")
        _login(c, "aud", "audpassword")
        assert c.get("/api/audit").status_code == 200
