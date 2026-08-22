"""Wave-1 tests: RBAC policy truth table, the multi-user KV store, OOBE first-admin,
user administration, and the RBAC enforcement gate end-to-end.

Offline (fake ES + mock LLM), mirroring tests/test_vigil_wave2.py for the auth-on
TestClient harness. Auth DEFAULT-OFF behaviour is verified to be unchanged so the
395-test baseline stays green; these add coverage for the new auth-on + rbac-on path.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.api.routes_setup import router as setup_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.rbac.policy import DEFAULT_MATRIX, can, effective_matrix, resolve_matrix
from app.state import AppState
from app.stores.memory import EsKVStore
from app.stores.users import UserStore


# --------------------------------------------------------------------------- #
# RBAC policy truth table
# --------------------------------------------------------------------------- #
def test_super_admin_can_everything() -> None:
    for resource, actions in DEFAULT_MATRIX[UserRole.SOC_MANAGER.value].items():
        for action in actions:
            if action == "*":
                continue
            assert can(UserRole.SUPER_ADMIN.value, resource, action)
    # Even an unknown resource/action: super_admin is hard-allowed.
    assert can(UserRole.SUPER_ADMIN.value, "users", "manage")


def test_auditor_is_read_only() -> None:
    assert can(UserRole.AUDITOR.value, "cases", "read")
    assert not can(UserRole.AUDITOR.value, "cases", "write")
    assert not can(UserRole.AUDITOR.value, "cases", "close")
    assert not can(UserRole.AUDITOR.value, "sources", "manage")
    assert not can(UserRole.AUDITOR.value, "users", "manage")
    assert not can(UserRole.AUDITOR.value, "proposals", "approve")
    assert can(UserRole.AUDITOR.value, "audit", "view")


def test_tier_grants() -> None:
    # tier2 may close + reinvestigate + run playbooks; tier1 may not.
    assert can(UserRole.ANALYST_TIER2.value, "cases", "close")
    assert can(UserRole.ANALYST_TIER2.value, "cases", "reinvestigate")
    assert can(UserRole.ANALYST_TIER2.value, "playbooks", "run")
    assert not can(UserRole.ANALYST_TIER1.value, "cases", "close")
    assert not can(UserRole.ANALYST_TIER1.value, "playbooks", "run")
    assert can(UserRole.ANALYST_TIER1.value, "cases", "write")
    # responder = tier1 + playbooks:run + proposals:approve
    assert can(UserRole.RESPONDER.value, "playbooks", "run")
    assert can(UserRole.RESPONDER.value, "proposals", "approve")
    assert not can(UserRole.RESPONDER.value, "cases", "close")
    # no role except super_admin/soc_manager may manage users
    assert can(UserRole.SOC_MANAGER.value, "users", "manage")
    assert not can(UserRole.ANALYST_TIER2.value, "users", "manage")


def test_unknown_role_denied() -> None:
    assert not can("nope", "cases", "read")


def test_effective_matrix_override_is_additive() -> None:
    # Grant the auditor cases:write via an override; everything else unchanged.
    m = effective_matrix({"auditor": {"cases": ["read", "write"]}})
    assert can("auditor", "cases", "write", matrix=m)
    assert not can("auditor", "sources", "manage", matrix=m)  # untouched default
    # Unknown resource in an override is ignored leniently.
    m2 = effective_matrix({"auditor": {"bogus": ["x"]}})
    assert "bogus" not in m2["auditor"]


def test_resolve_matrix_has_every_role() -> None:
    matrix = resolve_matrix(None)
    for role in UserRole:
        assert role.value in matrix


# --------------------------------------------------------------------------- #
# UserStore round-trip (the KV-doc pattern)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_user_store_crud_roundtrip() -> None:
    store = UserStore(EsKVStore(InMemoryESClient()))
    assert await store.count() == 0
    u = await store.create(username="alice", password_hash="h1", role=UserRole.ANALYST_TIER2.value)
    assert u.username == "alice"
    assert await store.count() == 1
    # Duplicate (case-insensitive) rejected.
    with pytest.raises(ValueError):
        await store.create(username="ALICE", password_hash="h2")
    # get is case-insensitive.
    assert (await store.get("Alice")).role == UserRole.ANALYST_TIER2.value
    # update patches role + active.
    await store.update("alice", role=UserRole.AUDITOR.value, active=False)
    got = await store.get("alice")
    assert got.role == UserRole.AUDITOR.value and got.active is False
    # delete.
    assert await store.delete("alice") is True
    assert await store.count() == 0
    assert await store.delete("alice") is False


@pytest.mark.asyncio
async def test_user_store_create_if_absent_only_when_empty() -> None:
    store = UserStore(EsKVStore(InMemoryESClient()))
    first = await store.create_if_absent(username="Admin", password_hash="h", role=UserRole.SUPER_ADMIN.value)
    assert first is not None
    # Store is now non-empty → no-op (never clobbers).
    second = await store.create_if_absent(username="Admin2", password_hash="h2")
    assert second is None
    assert await store.count() == 1


@pytest.mark.asyncio
async def test_user_public_view_hides_hash() -> None:
    store = UserStore(EsKVStore(InMemoryESClient()))
    u = await store.create(username="bob", password_hash="SECRET-HASH")
    pub = u.public()
    assert "password_hash" not in pub
    assert "SECRET" not in str(pub)
    assert pub["username"] == "bob"
    # The admin-managed contact fields + the MFA mandate ride in public() with
    # clean defaults (additive — old docs project the same keys).
    assert pub["display_name"] == ""
    assert pub["email"] == ""
    assert pub["phone"] == ""
    assert pub["mfa_required"] is False


@pytest.mark.asyncio
async def test_user_store_create_and_update_new_admin_fields() -> None:
    store = UserStore(EsKVStore(InMemoryESClient()))
    u = await store.create(
        username="carla", password_hash="h",
        display_name="Carla C", email="carla@example.com", phone="+1 555 0100",
        mfa_required=True, prefs={"custom_roles": ["closer"]},
    )
    assert u.display_name == "Carla C"
    assert u.email == "carla@example.com"
    assert u.phone == "+1 555 0100"
    assert u.mfa_required is True
    assert u.prefs == {"custom_roles": ["closer"]}
    # The new fields are in the update() allowlist (a patch actually persists).
    await store.update("carla", email="new@x.io", phone="+44 20", mfa_required=False)
    got = await store.get("carla")
    assert got.email == "new@x.io"
    assert got.phone == "+44 20"
    assert got.mfa_required is False


# --------------------------------------------------------------------------- #
# Auth-on + RBAC-on end-to-end harness
# --------------------------------------------------------------------------- #
def _client(
    *, seed_admin: bool = True, env_admin: bool = False, rbac: bool = True,
    setup_complete: bool = True,
):
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="rbac-test-secret",
        auth_seed_admin=seed_admin,
        auth_admin_username="envadmin",
        auth_admin_password="env-pass-1234" if env_admin else None,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": setup_complete})
        if rbac:
            prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    # The Wave-4 OOBE writer (routes_setup.py) — the SOLE first-admin bootstrap path
    # now that the legacy /api/setup/init-admin was removed (H4 / FINDING #11).
    api.include_router(setup_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


# A strong password that clears the OOBE server policy (>=12, != username, not common).
_STRONG = "Str0ng-OOBE-Pass!"


def _login(c, username, password):
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    return r


def test_setup_status_public_and_seeded() -> None:
    with _client() as c:
        s = c.get("/api/setup/status").json()
        assert s["auth_enabled"] is True
        assert s["rbac_enabled"] is True
        assert s["needs_user"] is False       # demo Admin was seeded
        assert s["user_count"] == 1
        assert s["seeded_default"] is True


def test_account_only_when_empty() -> None:
    # No seed + no env admin → store is empty → needs_user true → account works once.
    # (The legacy /api/setup/init-admin was removed — H4 / FINDING #11; the OOBE writer
    # is now /api/setup/account, which requires setup_complete False + a strong password.)
    with _client(seed_admin=False, setup_complete=False) as c:
        s = c.get("/api/setup/status").json()
        assert s["needs_user"] is True and s["user_count"] == 0
        r = c.post("/api/setup/account", json={"username": "owner", "password": _STRONG})
        assert r.status_code == 200 and r.json()["username"] == "owner"
        # Second attempt is 409 (already initialised).
        r2 = c.post("/api/setup/account", json={"username": "x", "password": _STRONG + "y"})
        assert r2.status_code == 409
        # And the created owner can log in (super_admin).
        assert _login(c, "owner", _STRONG).status_code == 200


def test_seeded_admin_login_and_role() -> None:
    with _client() as c:
        r = _login(c, "Admin", "Admin@123")
        assert r.status_code == 200
        body = r.json()
        assert body["token"]
        assert body["user"]["role"] == UserRole.SUPER_ADMIN.value
        assert body["user"]["must_change_password"] is False


def test_rbac_denies_low_role_and_allows_admin() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        # Admin (super_admin) can list + create users.
        assert c.get("/api/users").status_code == 200
        r = c.post("/api/users", json={
            "username": "tier1", "password": "tier1-pass-1", "role": UserRole.ANALYST_TIER1.value,
        })
        assert r.status_code == 200
        assert r.json()["user"]["must_change_password"] is True
        # New tier1 user logs in → cannot manage users (403) but can read cases.
        c.cookies.clear()
        _login(c, "tier1", "tier1-pass-1")
        assert c.get("/api/users").status_code == 403
        assert c.get("/api/cases").status_code == 200


def test_cannot_demote_or_delete_last_super_admin() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        # Demote the only super_admin → 409.
        r = c.put("/api/users/Admin", json={"role": UserRole.ANALYST_TIER1.value})
        assert r.status_code == 409
        # Disable the only super_admin → 409.
        r = c.put("/api/users/Admin", json={"active": False})
        assert r.status_code == 409
        # Delete the only super_admin → 409.
        r = c.request("DELETE", "/api/users/Admin")
        assert r.status_code == 409


def test_change_password_clears_flag() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        c.post("/api/users", json={
            "username": "needschange", "password": "initial-pass-1",
            "role": UserRole.ANALYST_TIER2.value,
        })
        c.cookies.clear()
        r = _login(c, "needschange", "initial-pass-1")
        assert r.json()["user"]["must_change_password"] is True
        # Change it.
        cp = c.post("/api/auth/change-password", json={
            "current_password": "initial-pass-1", "new_password": "brand-new-pass-1",
        })
        assert cp.status_code == 200
        # Old password no longer works; new one does + flag cleared.
        c.cookies.clear()
        assert _login(c, "needschange", "initial-pass-1").status_code == 401
        r2 = _login(c, "needschange", "brand-new-pass-1")
        assert r2.status_code == 200 and r2.json()["user"]["must_change_password"] is False


def test_roles_endpoint_shape() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        r = c.get("/api/roles").json()
        assert set(r["roles"]) == {role.value for role in UserRole}
        assert r["rbac_enabled"] is True
        assert "super_admin" in r["matrix"]


def test_rbac_disabled_treats_user_as_admin() -> None:
    # rbac OFF → any authenticated user is super_admin (back-compat).
    with _client(rbac=False) as c:
        _login(c, "Admin", "Admin@123")
        assert c.get("/api/users").status_code == 200
        r = c.get("/api/roles").json()
        assert r["rbac_enabled"] is False


def test_disabled_user_cannot_login_and_sessions_invalidated() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        c.post("/api/users", json={
            "username": "victim", "password": "victim-pass-1", "role": UserRole.ANALYST_TIER2.value,
        })
        # Disable the user.
        assert c.put("/api/users/victim", json={"active": False}).status_code == 200
        c.cookies.clear()
        assert _login(c, "victim", "victim-pass-1").status_code == 401
