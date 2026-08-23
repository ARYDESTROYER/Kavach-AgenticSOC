"""Self-service prefs must NEVER change RBAC custom-role assignments.

Regression tests for a verified privilege escalation: ``PUT /api/account/me`` is
gated only on an authenticated session and used to persist ``body.prefs`` verbatim,
while ``deps._assigned_custom_roles`` reads ``User.prefs['custom_roles']`` and UNIONs
those roles' grants into every RBAC decision. Any authenticated user could therefore
grant themselves any EXISTING custom role's permissions by writing
``{"prefs": {"custom_roles": ["<role>"]}}`` to their own account — bypassing the
users:manage + fresh-auth-gated ``PUT /api/users/{u}/roles`` path entirely.

The fix treats ``prefs["custom_roles"]`` as a RESERVED key owned by the admin
surfaces: a self-service prefs write carries the CURRENTLY STORED value forward
verbatim (stored absent → stripped), while the rest of the bag stays a full
replacement (no 4xx — clients that round-trip ``public()``'s prefs keep working).

Offline (fake ES + mock LLM), auth-ON + RBAC-ON, mirroring the harness of
tests/test_rbac_users.py / tests/test_round3_wave2_roles.py (monolith router +
routes_roles for /api/roles, /api/account/permissions, /api/users/{u}/roles).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_roles import router as roles_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

T1 = UserRole.ANALYST_TIER1.value


# --------------------------------------------------------------------------- #
# Harness — auth ON + RBAC ON, monolith + roles routers mounted.
# --------------------------------------------------------------------------- #
def _client():
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="prefs-guard-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides
        )
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(
            update={"rbac": prefs.rbac.model_copy(update={"enabled": True})}
        )
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c, username="Admin", password="Admin@123"):
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def _mk_user(c, username, password, role=T1):
    r = c.post(
        "/api/users", json={"username": username, "password": password, "role": role}
    )
    assert r.status_code == 200, r.text
    return r


def _mk_role(c, name, grants):
    r = c.post("/api/roles", json={"name": name, "inherits": [T1], "grants": grants})
    assert r.status_code == 200, r.text
    return r


# --------------------------------------------------------------------------- #
# (a) A non-admin cannot self-assign an existing custom role via /account/me.
# --------------------------------------------------------------------------- #
def test_self_service_prefs_cannot_grant_custom_roles() -> None:
    with _client() as c:
        _login(c)
        # An existing custom role that adds users:manage (the juiciest grant).
        _mk_role(c, "elevated", {"users": ["manage"]})
        _mk_user(c, "mallory", "mallory-pass-1")

        c.cookies.clear()
        _login(c, "mallory", "mallory-pass-1")

        # Baseline: tier1 lacks users:manage — the gated endpoint 403s and the
        # resolved permissions carry no manage grant and no custom roles.
        assert c.get("/api/users").status_code == 403
        perms = c.get("/api/account/permissions").json()
        assert perms["custom_roles"] == []
        assert "manage" not in perms["permissions"].get("users", [])

        # The attack: write the reserved key through the self-service surface.
        r = c.put(
            "/api/account/me",
            json={"prefs": {"custom_roles": ["elevated"], "theme": "dark"}},
        )
        assert r.status_code == 200, r.text  # NOT rejected — silently sanitized
        # The stored bag kept the rest of the prefs but carries NO custom_roles.
        stored = r.json()["user"]["prefs"]
        assert "custom_roles" not in stored
        assert stored["theme"] == "dark"

        # Permissions are unchanged — the role's grants did NOT attach.
        perms2 = c.get("/api/account/permissions").json()
        assert perms2["custom_roles"] == []
        assert "manage" not in perms2["permissions"].get("users", [])

        # End-to-end: the actual RBAC gate still denies (same 403 as before).
        assert c.get("/api/users").status_code == 403

        # And a fresh read of /account/me confirms the persisted record is clean.
        me = c.get("/api/account/me").json()["user"]
        assert "custom_roles" not in me["prefs"]

        # Admin's view of the stored user agrees (nothing leaked into the store).
        c.cookies.clear()
        _login(c)
        users = {u["username"]: u for u in c.get("/api/users").json()["users"]}
        assert "custom_roles" not in users["mallory"]["prefs"]
        assert users["mallory"]["prefs"].get("theme") == "dark"


# --------------------------------------------------------------------------- #
# (b) Admin-assigned custom roles SURVIVE a legitimate self-service prefs write.
# --------------------------------------------------------------------------- #
def test_admin_assigned_roles_survive_self_service_prefs_update() -> None:
    with _client() as c:
        _login(c)
        _mk_role(c, "closer", {"cases": ["close"]})
        _mk_user(c, "alice", "alice-pass-1234")
        r = c.put("/api/users/alice/roles", json={"custom_roles": ["closer"]})
        assert r.status_code == 200, r.text
        assert r.json()["custom_roles"] == ["closer"]

        c.cookies.clear()
        _login(c, "alice", "alice-pass-1234")
        perms = c.get("/api/account/permissions").json()
        assert perms["custom_roles"] == ["closer"]
        assert "close" in perms["permissions"]["cases"]

        # A normal prefs update (no custom_roles key sent) keeps the assignment.
        r = c.put(
            "/api/account/me",
            json={"prefs": {"theme": "dark", "saved_views": ["mine"]}},
        )
        assert r.status_code == 200, r.text
        stored = r.json()["user"]["prefs"]
        assert stored["custom_roles"] == ["closer"]  # carried forward verbatim
        assert stored["theme"] == "dark"
        assert stored["saved_views"] == ["mine"]

        # Even an explicit attempt to CLEAR the key is ignored — the admin-assigned
        # value wins (self-service may never remove roles either).
        r = c.put("/api/account/me", json={"prefs": {"custom_roles": []}})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["prefs"]["custom_roles"] == ["closer"]

        # Permissions unchanged throughout.
        perms2 = c.get("/api/account/permissions").json()
        assert perms2["custom_roles"] == ["closer"]
        assert "close" in perms2["permissions"]["cases"]


# --------------------------------------------------------------------------- #
# (c) The legitimate admin path still assigns AND removes custom roles.
# --------------------------------------------------------------------------- #
def test_admin_roles_endpoint_still_assigns_and_removes() -> None:
    with _client() as c:
        _login(c)
        _mk_role(c, "closer", {"cases": ["close"]})
        _mk_user(c, "bob", "bob-pass-12345")

        # Assign.
        r = c.put("/api/users/bob/roles", json={"custom_roles": ["closer"]})
        assert r.status_code == 200, r.text
        assert r.json()["custom_roles"] == ["closer"]
        users = {u["username"]: u for u in c.get("/api/users").json()["users"]}
        assert users["bob"]["prefs"].get("custom_roles") == ["closer"]

        # Remove (explicit empty list through the ADMIN surface really clears).
        r = c.put("/api/users/bob/roles", json={"custom_roles": []})
        assert r.status_code == 200, r.text
        assert r.json()["custom_roles"] == []
        users = {u["username"]: u for u in c.get("/api/users").json()["users"]}
        assert users["bob"]["prefs"].get("custom_roles") == []
