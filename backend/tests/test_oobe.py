"""OOBE first-user + multi-user + RBAC integration tests (F1/F2).

Covers, over the REAL app router (auth gate mirrored from main.py):

* Seeding: demo ``Admin``/``Admin@123`` seeds ONLY when auth is enabled AND the
  store is empty AND no env-admin is configured; never with auth off.
* ``/api/setup/status`` (PUBLIC) reports auth/rbac/user_count/needs_user/seeded.
* ``/api/setup/account`` (PUBLIC, routes_setup.py) creates the first super_admin,
  409s once a user exists, and is rejected when auth is off. (The legacy weaker
  ``/api/setup/init-admin`` was REMOVED — H4 / FINDING #11.)
* ``/api/auth/login`` returns ``token`` + ``user{role, must_change_password}``.
* ``/api/auth/me`` surfaces the principal; ``/api/auth/change-password`` works.
* RBAC enforcement: with rbac on, a low-privilege role is 403'd on ``users:manage``
  and on case close; with rbac off, an authenticated user is treated as super_admin.
* The DEFAULT no-auth path is byte-unchanged (no users, everything open).
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
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from tests._auth_helpers import ready_user


def _build_client(**secret_overrides):
    """A TestClient over the real router with the auth gate (mirrors main.py).

    ``rbac_enabled`` may be passed to flip ``Preferences.rbac.enabled`` after
    startup. Returns the TestClient (use as a context manager)."""
    rbac_enabled = secret_overrides.pop("rbac_enabled", False)
    setup_complete = secret_overrides.pop("setup_complete", True)
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
        prefs.setup_complete = setup_complete
        prefs.rbac.enabled = rbac_enabled
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


def _login(c: TestClient, username: str, password: str):
    return c.post("/api/auth/login", json={"username": username, "password": password})


# --------------------------------------------------------------------------- #
# Auth OFF (the default) — unchanged behaviour
# --------------------------------------------------------------------------- #
def test_auth_off_status_and_open_access() -> None:
    with _build_client(auth_enabled=False) as c:
        st = c.get("/api/setup/status").json()
        assert st["auth_enabled"] is False
        assert st["needs_user"] is False
        assert st["user_count"] == 0
        assert st["rbac_enabled"] is False
        # Everything open: a protected route is reachable with no session.
        assert c.get("/api/cases").status_code == 200
        # The OOBE account writer is rejected when auth is off.
        r = c.post("/api/setup/account", json={"username": "x", "password": _STRONG})
        assert r.status_code == 400


# --------------------------------------------------------------------------- #
# Seeding (auth ON, no env admin) — Admin/Admin@123 is live
# --------------------------------------------------------------------------- #
def test_seeded_default_admin_when_empty() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="seed-secret") as c:
        st = c.get("/api/setup/status").json()
        assert st["auth_enabled"] is True
        assert st["user_count"] == 1            # the seeded Admin
        assert st["needs_user"] is False        # a user exists → no OOBE form
        assert st["seeded_default"] is True     # demo creds are live
        # The demo credentials log in directly (must_change_password False).
        r = _login(c, "Admin", "Admin@123")
        assert r.status_code == 200
        body = r.json()
        assert body["token"]
        assert body["user"]["role"] == "super_admin"
        assert body["user"]["must_change_password"] is False


def test_no_seed_when_auth_disabled() -> None:
    with _build_client(auth_enabled=False, auth_seed_admin=True) as c:
        assert c.get("/api/setup/status").json()["user_count"] == 0


def test_env_admin_suppresses_demo_seed() -> None:
    with _build_client(
        auth_enabled=True, auth_jwt_secret="s", auth_seed_admin=True,
        auth_admin_username="admin", auth_admin_password="env-admin-pw",
    ) as c:
        st = c.get("/api/setup/status").json()
        # No persisted demo user (env admin IS the bootstrap admin).
        assert st["user_count"] == 0
        assert st["needs_user"] is True
        assert st["seeded_default"] is False
        # The env admin still logs in (super_admin from the base layer).
        r = _login(c, "admin", "env-admin-pw")
        assert r.status_code == 200 and r.json()["user"]["role"] == "super_admin"


# --------------------------------------------------------------------------- #
# setup/account OOBE (auth ON, seeding OFF → empty store)
# --------------------------------------------------------------------------- #
def test_account_creates_first_then_409() -> None:
    with _build_client(
        auth_enabled=True, auth_jwt_secret="oobe", auth_seed_admin=False,
        setup_complete=False,
    ) as c:
        st = c.get("/api/setup/status").json()
        assert st["user_count"] == 0 and st["needs_user"] is True
        # Weak password rejected by the strong-password policy (too short).
        assert c.post("/api/setup/account", json={"username": "root", "password": "short"}).status_code == 400
        # Create the first super_admin.
        r = c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        assert r.status_code == 200 and r.json()["username"] == "root"
        # Now a user exists → account is 409 (cannot add/escalate accounts via OOBE).
        r2 = c.post("/api/setup/account", json={"username": "evil", "password": _STRONG + "z"})
        assert r2.status_code == 409
        assert c.get("/api/setup/status").json()["needs_user"] is False
        # The created admin can log in.
        assert _login(c, "root", _STRONG).status_code == 200


# --------------------------------------------------------------------------- #
# auth/me + change-password
# --------------------------------------------------------------------------- #
def test_me_and_change_password() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="cp") as c:
        me0 = c.get("/api/auth/me").json()
        assert me0["auth_enabled"] is True and me0["authenticated"] is False
        _login(c, "Admin", "Admin@123")
        me1 = c.get("/api/auth/me").json()
        assert me1["authenticated"] is True
        assert me1["user"]["role"] == "super_admin"
        # Wrong current password → 400.
        assert c.post("/api/auth/change-password",
                      json={"current_password": "wrong", "new_password": "BrandNewPw1"}).status_code == 400
        # Correct change → 200, then the new password logs in.
        assert c.post("/api/auth/change-password",
                      json={"current_password": "Admin@123", "new_password": "BrandNewPw1"}).status_code == 200
        c.post("/api/auth/logout")
        assert _login(c, "Admin", "Admin@123").status_code == 401
        assert _login(c, "Admin", "BrandNewPw1").status_code == 200


# --------------------------------------------------------------------------- #
# RBAC enforcement
# --------------------------------------------------------------------------- #
def test_rbac_off_treats_authenticated_as_super_admin() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="rbacoff", rbac_enabled=False) as c:
        _login(c, "Admin", "Admin@123")
        # users:manage is reachable (super_admin equivalent when rbac off).
        assert c.get("/api/users").status_code == 200
        assert c.get("/api/roles").json()["rbac_enabled"] is False


def test_rbac_on_enforces_user_management_and_close() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="rbacon", rbac_enabled=True) as c:
        # Admin (super_admin) creates a tier1 analyst.
        _login(c, "Admin", "Admin@123")
        r = c.post("/api/users", json={"username": "tier1", "password": "tier1password",
                                       "role": "analyst_tier1"})
        assert r.status_code == 200
        # The tier1 analyst logs in (must change password on creation, but can still
        # authenticate).
        c.post("/api/auth/logout")
        login = _login(c, "tier1", "tier1password")
        assert login.status_code == 200
        assert login.json()["user"]["role"] == "analyst_tier1"
        assert login.json()["user"]["must_change_password"] is True
        # Round 16 (B20): the server holds every other route until the temporary
        # password is changed; then the RBAC gate is what answers.
        held = c.get("/api/cases")
        assert held.status_code == 403
        assert held.json()["detail"]["code"] == "password_change_required"
        changed = c.post("/api/auth/change-password", json={
            "current_password": "tier1password", "new_password": "tier1password"})
        assert changed.status_code == 200, changed.text
        # tier1 is DENIED users:manage (403).
        assert c.get("/api/users").status_code == 403
        # tier1 may LIST cases (cases:read) ...
        assert c.get("/api/cases").status_code == 200


def test_rbac_roles_matrix_endpoint() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="roles", rbac_enabled=True) as c:
        _login(c, "Admin", "Admin@123")
        body = c.get("/api/roles").json()
        assert set(body["roles"]) == {
            "super_admin", "soc_manager", "analyst_tier2",
            "analyst_tier1", "responder", "auditor",
        }
        assert body["default_role"] == "analyst_tier1"
        assert body["rbac_enabled"] is True
        assert "close" in body["matrix"]["analyst_tier2"]["cases"]
        assert "close" not in body["matrix"]["analyst_tier1"]["cases"]


# --------------------------------------------------------------------------- #
# Last-super-admin lockout guard
# --------------------------------------------------------------------------- #
def test_cannot_delete_or_demote_last_super_admin() -> None:
    with _build_client(
        auth_enabled=True, auth_jwt_secret="guard", auth_seed_admin=False,
        setup_complete=False,
    ) as c:
        c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        _login(c, "root", _STRONG)
        # Demoting the only super_admin → 409.
        assert c.put("/api/users/root", json={"role": "analyst_tier1"}).status_code == 409
        # Disabling the only super_admin → 409.
        assert c.put("/api/users/root", json={"active": False}).status_code == 409
        # Deleting the only super_admin → 409.
        assert c.delete("/api/users/root").status_code == 409
        # Add a second super_admin, then the first can be demoted.
        assert c.post("/api/users", json={"username": "root2", "password": "root2password",
                                          "role": "super_admin"}).status_code == 200
        ready_user(c, "root2", "root2password")
        assert c.put("/api/users/root", json={"role": "soc_manager"}).status_code == 200
