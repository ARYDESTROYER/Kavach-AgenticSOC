"""``GET /api/account/permissions`` is the server's own effective-permission answer
(Round 14 FX7e, finding roles-01).

The Console's permission checks (``hasPermission``, ``<Can>``, ``ProtectedRoute``) read
this one map, so it must list exactly the ``resource:action`` pairs the API gate allows:
the base role UNIONed with the assigned custom roles, each role row carrying its own
denies and the operator's global per-role denies. These tests pin that parity through
the REAL gate: for every declared action, a probe route asks ``deps.has_permission``
(the ``_enforce`` core behind every ``require_permission``) and the answer must match
the map, for the custom-role shapes the acceptance pass used (a role that inherits
``soc_manager`` and denies ``audit:*``, one that inherits ``analyst_tier2`` and denies
``runbooks:run``, a delegated ``runbooks:publish``, a delegated ``audit:export``), a
global deny, a stored name with surrounding spaces, a deleted role, ``super_admin``,
RBAC off and auth off.

Offline (fake ES + mock LLM), mirroring ``tests/test_round3_wave2b_rbac.py``.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.testclient import TestClient

from app.api.deps import has_permission, require_auth
from app.api.routes import router as monolith_router
from app.api.routes_roles import router as roles_router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.rbac.policy import RESOURCES
from app.state import AppState

SA = UserRole.SUPER_ADMIN.value
MGR = UserRole.SOC_MANAGER.value
T1 = UserRole.ANALYST_TIER1.value
T2 = UserRole.ANALYST_TIER2.value
AUD = UserRole.AUDITOR.value

ALL_PAIRS = [(res, act) for res, acts in RESOURCES.items() for act in acts]


def _make_app(*, auth: bool = True, rbac: bool = True) -> FastAPI:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=auth, auth_jwt_secret="fx7e-effective-permissions",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": rbac})})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])

    probe = APIRouter(prefix="/api")

    # One probe for every declared pair: the REAL gate core (``_enforce``) decides.
    @probe.get("/_probe/{resource}/{action}")
    async def _probe(resource: str, action: str, request: Request) -> dict:
        return {"allowed": await has_permission(request, resource, action)}

    api.include_router(probe, dependencies=[Depends(require_auth)])
    return api


def _login(c: TestClient, username: str = "Admin", password: str = "Admin@123") -> None:
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text


def _role(c: TestClient, body: dict) -> None:
    r = c.post("/api/roles", json=body)
    assert r.status_code == 200, r.text


def _user(c: TestClient, username: str, role: str, custom_roles: list[str]) -> None:
    r = c.post("/api/users", json={"username": username, "password": f"{username}-pass-1234", "role": role})
    assert r.status_code == 200, r.text
    if custom_roles:
        r = c.put(f"/api/users/{username}/roles", json={"custom_roles": custom_roles})
        assert r.status_code == 200, r.text


def _perms(c: TestClient) -> dict:
    r = c.get("/api/account/permissions")
    assert r.status_code == 200, r.text
    return r.json()


def _gate(c: TestClient) -> dict[str, list[str]]:
    """What the server gate allows the signed-in caller, by resource (vocabulary order)."""
    out: dict[str, list[str]] = {}
    for res, act in ALL_PAIRS:
        r = c.get(f"/api/_probe/{res}/{act}")
        assert r.status_code == 200, r.text
        if r.json()["allowed"]:
            out.setdefault(res, []).append(act)
    return out


def _assert_parity(c: TestClient) -> dict:
    body = _perms(c)
    assert body["permissions"] == _gate(c)
    for res, acts in body["permissions"].items():
        assert acts, f"{res} is listed with no action"
        assert "*" not in acts, f"{res} carries a wildcard"
    return body


def _seed_acceptance_roles(c: TestClient) -> None:
    """The custom roles the second acceptance pass used (roles lane)."""
    _role(c, {"name": "cr_no_audit", "inherits": [MGR], "denies": {"audit": ["*"]}})
    _role(c, {"name": "cr_no_run", "inherits": [T2], "denies": {"runbooks": ["run"]}})
    _role(c, {"name": "cr_publish", "grants": {"runbooks": ["read", "manage", "publish"]}})
    _role(c, {"name": "cr_audit", "grants": {"audit": ["view", "export"]}})


def test_a_custom_role_that_inherits_soc_manager_and_denies_audit() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        _seed_acceptance_roles(c)
        _user(c, "noaudit", T1, ["cr_no_audit"])
        _login(c, "noaudit", "noaudit-pass-1234")
        body = _assert_parity(c)
        perms = body["permissions"]
        assert body["role"] == T1
        assert body["custom_roles"] == ["cr_no_audit"]
        # What the Console used to hide (it read only the analyst_tier1 row).
        assert perms["runbooks"] == ["read", "run", "manage", "publish"]
        assert perms["users"] == ["manage"]
        assert perms["settings"] == ["read", "manage"]
        assert perms["cases"] == list(RESOURCES["cases"])
        # The custom role's own deny removes audit; analyst_tier1 grants none of it.
        assert "audit" not in perms


def test_a_custom_role_deny_hides_what_its_parent_grants() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        _seed_acceptance_roles(c)
        _user(c, "norun", AUD, ["cr_no_run"])
        _login(c, "norun", "norun-pass-1234")
        perms = _assert_parity(c)["permissions"]
        # analyst_tier2's case writes come through the custom role ...
        for action in ("write", "close", "reinvestigate", "assign", "comment"):
            assert action in perms["cases"], action
        # ... while its deny keeps runbooks:run away (auditor holds only read).
        assert perms["runbooks"] == ["read"]


def test_delegated_runbook_publish_and_audit_export() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        _seed_acceptance_roles(c)
        _user(c, "pub", T1, ["cr_publish"])
        _user(c, "audx", T1, ["cr_audit"])
        _login(c, "pub", "pub-pass-1234")
        perms = _assert_parity(c)["permissions"]
        assert {"manage", "publish"} <= set(perms["runbooks"])
        _login(c, "audx", "audx-pass-1234")
        perms = _assert_parity(c)["permissions"]
        assert perms["audit"] == ["view", "export"]


def test_a_global_per_role_deny_is_applied_and_a_second_role_can_grant_it_back() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        state: AppState = c.app.state.tlsoc
        prefs = state.prefs
        rbac = prefs.rbac.model_copy(update={"denies": {T1: {"cases": ["comment"]}}})
        c.portal.call(state.update_prefs, prefs.model_copy(update={"rbac": rbac}))
        _role(c, {"name": "commenter", "grants": {"cases": ["comment"]}})
        _user(c, "plain", T1, [])
        _user(c, "talker", T1, ["commenter"])
        _login(c, "plain", "plain-pass-1234")
        assert "comment" not in _assert_parity(c)["permissions"]["cases"]
        # Role union is additive, on the server and in this map alike.
        _login(c, "talker", "talker-pass-1234")
        assert "comment" in _assert_parity(c)["permissions"]["cases"]


def test_stored_names_are_read_the_way_the_gate_reads_them() -> None:
    """A stored assignment with surrounding spaces counts (the gate strips it); a
    deleted role and a built-in name stored as a custom role contribute nothing."""
    with TestClient(_make_app()) as c:
        _login(c)
        _role(c, {"name": "closer", "grants": {"cases": ["close"]}})
        _role(c, {"name": "gone", "grants": {"users": ["manage"]}})
        _user(c, "spaced", T1, [])
        state: AppState = c.app.state.tlsoc

        async def store_names() -> None:
            user = await state.users.get("spaced")
            assert user is not None
            prefs = dict(user.prefs or {})
            prefs["custom_roles"] = [" closer ", "gone", MGR]
            await state.users.update("spaced", prefs=prefs)
            await state.refresh_users()

        c.portal.call(store_names)
        assert c.delete("/api/roles/gone").status_code == 200
        _login(c, "spaced", "spaced-pass-1234")
        body = _assert_parity(c)
        assert body["custom_roles"] == ["closer"]
        assert "close" in body["permissions"]["cases"]
        assert "users" not in body["permissions"]


def test_a_base_role_with_no_custom_role_matches_the_gate() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        for role in (T1, T2, AUD, MGR, UserRole.RESPONDER.value):
            name = f"base_{role}"
            _user(c, name, role, [])
        for role in (T1, T2, AUD, MGR, UserRole.RESPONDER.value):
            name = f"base_{role}"
            _login(c, name, f"{name}-pass-1234")
            body = _assert_parity(c)
            assert body["role"] == role
            assert body["custom_roles"] == []


def test_super_admin_holds_every_declared_action() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        body = _assert_parity(c)
        assert body["role"] == SA
        assert body["rbac_enabled"] is True
        assert body["permissions"] == {res: list(acts) for res, acts in RESOURCES.items()}


def test_rbac_off_reports_every_action_and_rbac_disabled() -> None:
    with TestClient(_make_app(rbac=False)) as c:
        _login(c)
        _user(c, "tier1", T1, [])
        _login(c, "tier1", "tier1-pass-1234")
        body = _assert_parity(c)
        assert body["rbac_enabled"] is False
        assert body["role"] == SA
        assert body["permissions"] == {res: list(acts) for res, acts in RESOURCES.items()}


def test_auth_off_reports_every_action_unauthenticated() -> None:
    with TestClient(_make_app(auth=False)) as c:
        body = _assert_parity(c)
        assert body["authenticated"] is False
        assert body["permissions"] == {res: list(acts) for res, acts in RESOURCES.items()}


def test_an_unauthenticated_caller_is_refused_when_auth_is_on() -> None:
    with TestClient(_make_app()) as c:
        assert c.get("/api/account/permissions").status_code == 401
