"""Round-3 Wave-5 — RBAC custom-role + authZ-coverage remediations.

Two CONFIRMED adversarial-audit findings are locked here:

* **rbac-custom-roles (HIGH)** — ``PUT /api/users/{username}/roles`` could orphan
  the LAST active super_admin (it carried only the generic ``users:manage``
  last-holder guard, not the super_admin-specific orphan guard that
  ``PUT/DELETE /api/users/{u}`` already enforce). The fix imports the shared
  ``_would_orphan_super_admin`` helper and blocks the demotion with 409. We assert:
    - demoting the lone super_admin via ``/roles`` → 409 (even with a SECOND
      ``users:manage`` holder present, so the generic guard would NOT have caught it);
    - the matrix still shows exactly one active super_admin afterwards;
    - with TWO super_admins, demoting one of them → 200 and one remains (positive).

* **authz-coverage (MEDIUM)** — the real read endpoints (``GET /api/cases``,
  ``/api/cases/{id}``, ``/api/search``, ``/api/sources``, ``/api/sources/{id}/logs``)
  enforced only authN, so a ``Preferences.rbac.denies`` revocation of
  ``cases:read`` / ``sources:read`` was silently bypassed. The fix adds the
  matching ``require_permission`` read gate. Because every built-in role holds
  ``cases:read`` / ``sources:read`` by default — and the gate is a strict no-op
  when auth or RBAC is off — this is behavior-neutral EXCEPT when a deny is
  configured, which is exactly the intent. We assert a tier1 user with those reads
  denied gets 403 on every one of those real GETs.

Offline (fake ES + mock LLM), auth-ON + RBAC-ON, mirroring
``tests/test_round3_wave2_roles.py``'s harness. Both the monolith router and the
roles feature router are mounted under the ``require_auth`` gate.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_roles import router as roles_router
from app.api.routes_triage import router as triage_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

SA = UserRole.SUPER_ADMIN.value
MGR = UserRole.SOC_MANAGER.value
T1 = UserRole.ANALYST_TIER1.value
T2 = UserRole.ANALYST_TIER2.value


# --------------------------------------------------------------------------- #
# Harness — auth ON + RBAC ON, both routers mounted. Optional per-role denies.
# --------------------------------------------------------------------------- #
def _client(*, denies: dict[str, dict[str, list[str]]] | None = None):
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="wave5-rbac-secret",
        auth_seed_admin=True,
        auth_admin_username="envadmin",
        auth_admin_password=None,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        rbac_update: dict[str, Any] = {"enabled": True}
        if denies is not None:
            rbac_update["denies"] = denies
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update=rbac_update)})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from tests.conftest import mount_moved_routers

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])
    api.include_router(triage_router, dependencies=[Depends(require_auth)])
    mount_moved_routers(api, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c, username="Admin", password="Admin@123"):
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def _mk_user(c, username, password, role=T1):
    r = c.post("/api/users", json={"username": username, "password": password, "role": role})
    assert r.status_code == 200, r.text
    return r


def _active_super_admins(c) -> list[str]:
    users = c.get("/api/users").json()["users"]
    return [u["username"] for u in users if u.get("role") == SA and u.get("active", False)]


# --------------------------------------------------------------------------- #
# FIX 1 (HIGH) — /roles assignment cannot orphan the last super_admin.
# --------------------------------------------------------------------------- #
def test_roles_route_cannot_orphan_last_super_admin() -> None:
    """``PUT /api/users/Admin/roles`` demoting the LONE super_admin → 409, even with a
    SECOND users:manage holder present (so the generic last-holder guard would have let
    it through). The super_admin count must stay at exactly one."""
    with _client() as c:
        _login(c)  # seeded Admin = the only super_admin
        # A second users:manage holder so the GENERIC lockout guard is satisfied —
        # this isolates the NEW super_admin-orphan guard as the thing doing the work.
        _mk_user(c, "mgr", "mgr-pass-12345", role=MGR)
        assert _active_super_admins(c) == ["Admin"]

        blocked = c.put("/api/users/Admin/roles", json={"role": MGR})
        assert blocked.status_code == 409, blocked.text
        assert "super_admin" in blocked.json()["detail"].lower()
        # Unchanged — Admin is still the (one) active super_admin.
        assert _active_super_admins(c) == ["Admin"]


def test_roles_route_allows_demoting_one_of_two_super_admins() -> None:
    """Positive companion: with TWO super_admins, demoting ONE via /roles → 200 and
    exactly one super_admin remains (the guard only bites the LAST one)."""
    with _client() as c:
        _login(c)
        _mk_user(c, "sa2", "sa2-pass-12345", role=SA)
        assert set(_active_super_admins(c)) == {"Admin", "sa2"}

        ok = c.put("/api/users/sa2/roles", json={"role": MGR})
        assert ok.status_code == 200, ok.text
        assert ok.json()["user"]["role"] == MGR
        assert _active_super_admins(c) == ["Admin"]

        # And NOW the lone remaining super_admin is itself protected.
        blocked = c.put("/api/users/Admin/roles", json={"role": MGR})
        assert blocked.status_code == 409, blocked.text


def test_roles_route_super_admin_orphan_guard_is_orthogonal_to_users_manage_guard() -> None:
    """Demoting the last super_admin to soc_manager (which STILL holds users:manage)
    must be blocked by the super_admin guard — proving the two guards protect distinct
    invariants. A pre-fix run returns 200 here because soc_manager keeps users:manage,
    so the generic lockout guard does not fire."""
    with _client() as c:
        _login(c)
        # MGR (soc_manager) holds users:manage, so the generic guard would PASS this.
        blocked = c.put("/api/users/Admin/roles", json={"role": MGR})
        assert blocked.status_code == 409, blocked.text
        assert _active_super_admins(c) == ["Admin"]


# --------------------------------------------------------------------------- #
# FIX 2 (MEDIUM) — real read routes honor a cases:read / sources:read deny.
# --------------------------------------------------------------------------- #
def test_read_routes_honor_cases_and_sources_read_deny() -> None:
    """A tier1 user whose ``cases:read`` + ``sources:read`` are revoked via
    ``Preferences.rbac.denies`` must be 403'd on the REAL read endpoints — not just
    the Round-3 triage read that already gated. Before the fix these returned 200 with
    full bodies / raw-log access; after it they 403."""
    denies = {T1: {"cases": ["read"], "sources": ["read"]}}
    with _client(denies=denies) as c:
        _login(c)
        # Create the restricted tier1 user.
        _mk_user(c, "lowread", "lowread-pass-1", role=T1)

        # Sanity: the deny is in the effective matrix (Admin can introspect it).
        sim = c.get("/api/roles/simulate", params={
            "role": T1, "resource": "cases", "action": "read"}).json()
        assert sim["allowed"] is False, sim
        sim_src = c.get("/api/roles/simulate", params={
            "role": T1, "resource": "sources", "action": "read"}).json()
        assert sim_src["allowed"] is False, sim_src

        # Log in AS the restricted user (cookie switches to lowread). Login mints a
        # working token even with must_change_password set (it returns the flag only).
        _login(c, username="lowread", password="lowread-pass-1")

        # The pre-existing Round-3 triage read (already gated) — the control.
        assert c.get("/api/cases/any-id/triage").status_code == 403
        # The NEWLY-gated real reads must now all 403 for the denied user.
        assert c.get("/api/cases").status_code == 403
        assert c.get("/api/cases/any-id").status_code == 403
        assert c.get("/api/search", params={"q": "x"}).status_code == 403
        assert c.get("/api/sources").status_code == 403
        assert c.get("/api/sources/some-src/logs").status_code == 403
        # The unified browse route (and its optional single-source scope) is gated on
        # the SAME sources:read grant — the scope must never become a way around it.
        assert c.get("/api/logs").status_code == 403
        assert c.get("/api/logs", params={"source_id": "some-src"}).status_code == 403


def test_read_routes_open_for_default_role_without_deny() -> None:
    """Behavior-neutrality: WITHOUT a deny, a tier1 user keeps full read access to the
    same real routes (cases:read / sources:read are default grants for every role)."""
    with _client() as c:
        _login(c)
        _mk_user(c, "reader", "reader-pass-12", role=T1)
        _login(c, username="reader", password="reader-pass-12")

        assert c.get("/api/cases").status_code == 200
        # Unknown id → 404 (the gate passed; the route ran and found nothing).
        assert c.get("/api/cases/missing-id").status_code == 404
        assert c.get("/api/search", params={"q": "x"}).status_code == 200
        assert c.get("/api/sources").status_code == 200
        # Unknown source → 404 (gate passed; route ran).
        assert c.get("/api/sources/nope/logs").status_code == 404
        assert c.get("/api/logs").status_code == 200
        # The scoped form runs too, and reports the unknown id the sibling's way.
        assert c.get("/api/logs", params={"source_id": "nope"}).status_code == 404


def test_read_routes_unaffected_when_rbac_off() -> None:
    """When RBAC is enabled but a deny targets a DIFFERENT role, the seeded Admin
    (super_admin — lockout-proof) keeps full read access: the super_admin row is never
    deny-stripped, so the new gates never bite the owner."""
    denies = {T1: {"cases": ["read"], "sources": ["read"]}}
    with _client(denies=denies) as c:
        _login(c)  # super_admin
        assert c.get("/api/cases").status_code == 200
        assert c.get("/api/sources").status_code == 200
        assert c.get("/api/search", params={"q": "x"}).status_code == 200
