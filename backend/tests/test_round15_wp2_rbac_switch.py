"""Round 15 SPEC D1.2 and D1.3: the role-based access switch.

``GET /api/rbac`` reports the state and why the caller may not change it; ``PUT
/api/rbac`` applies the seven rules in order (sign-in off, a strict fresh sign-in, a
verified Super admin with an Access denied row otherwise, read-only settings, an active
Super admin before turning on, no change without an audit row, then the audited write).
``PUT /api/settings`` refuses a changed ``rbac.enabled`` and asks ``roles:manage`` plus
a fresh sign-in for any other ``rbac`` change. Offline: fake Elasticsearch, mock LLM.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_rbac import router as rbac_router
from app.api.routes_roles import router as roles_router
from app.config import Secrets
from app.constants import ActionType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.middleware.request_id import RequestIdMiddleware
from app.state import AppState

PASSWORD = "rbac-switch-pass-1"
STALE = "2000-01-01T00:00:00+00:00"


def _secrets(*, auth: bool = True, **extra: Any) -> Secrets:
    more: dict[str, Any] = {}
    if auth:
        more = {"auth_enabled": True, "auth_jwt_secret": "rbac-switch-test-secret",
                "auth_seed_admin": True}
    more.update(extra)
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                   anthropic_api_key=None, openai_api_key=None, **more)


def _app(secrets: Secrets, *, rbac: bool = False) -> FastAPI:
    mock = MockProvider()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
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
    api.include_router(rbac_router, dependencies=deps)
    api.include_router(roles_router, dependencies=deps)
    api.add_middleware(RequestIdMiddleware)
    return api


def _state(client: TestClient) -> AppState:
    return client.app.state.tlsoc


def _admin(client: TestClient) -> None:
    client.cookies.clear()
    signed_in = client.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
    assert signed_in.status_code == 200, signed_in.text


def _as(client: TestClient, role: str, username: str | None = None) -> str:
    """Create an account with ``role`` (as the seeded Super admin) and sign in as it."""
    _admin(client)
    username = username or f"{role.replace('_', '-')}-person"
    created = client.post("/api/users", json={"username": username, "password": PASSWORD, "role": role})
    assert created.status_code == 200, created.text
    client.cookies.clear()
    signed_in = client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert signed_in.status_code == 200, signed_in.text
    return username


def _rows(client: TestClient) -> list[dict[str, Any]]:
    state = _state(client)
    return client.portal.call(lambda: state.control_audit.records(limit=1000))


def _settings_rows(client: TestClient) -> list[dict[str, Any]]:
    return [r for r in _rows(client) if r.get("action") == "settings.updated"
            and (r.get("target") or {}).get("id") == "rbac"]


def _denials(client: TestClient) -> list[dict[str, Any]]:
    return [r for r in _rows(client) if r.get("action_type") == ActionType.ACCESS_DENIED.value]


def _set_prefs(client: TestClient, **changes: Any) -> None:
    state = _state(client)

    async def apply() -> None:
        prefs = state.prefs.model_copy(deep=True)
        for dotted, value in changes.items():
            target: Any = prefs
            parts = dotted.split("__")
            for part in parts[:-1]:
                target = getattr(target, part)
            setattr(target, parts[-1], value)
        await state.update_prefs(prefs)

    client.portal.call(apply)


def _backdate_sessions(client: TestClient, username: str) -> None:
    state = _state(client)

    def backdate(entries: list[dict[str, Any]]) -> bool:
        for row in entries:
            if row.get("username") == username and not str(row.get("sid", "")).startswith("__tv__:"):
                row["last_authn_at"] = STALE
        return True

    client.portal.call(state.sessions._mutate, backdate)


# --------------------------------------------------------------------------- #
# GET /api/rbac
# --------------------------------------------------------------------------- #
def test_status_with_sign_in_off_names_the_auth_blocker():
    with TestClient(_app(_secrets(auth=False))) as client:
        body = client.get("/api/rbac").json()
        assert body == {
            "enabled": False, "auth_enabled": False, "can_change": False,
            "blockers": ["auth_off"], "caller_role": "", "super_admin_count": 0,
            "role_counts": {},
        }


def test_status_for_a_super_admin_can_change_and_counts_accounts():
    with TestClient(_app(_secrets())) as client:
        _as(client, "analyst_tier1", "ana")
        _admin(client)
        body = client.get("/api/rbac").json()
        assert body["enabled"] is False
        assert body["auth_enabled"] is True
        assert body["can_change"] is True
        assert body["blockers"] == []
        assert body["caller_role"] == "super_admin"
        assert body["super_admin_count"] == 1
        assert body["role_counts"] == {"super_admin": 1, "analyst_tier1": 1}


def test_status_reports_the_stored_role_while_rbac_is_off():
    """With RBAC off every account is treated as Super admin elsewhere; the switch still
    knows the real role, so a SOC manager sees why they cannot change it."""
    with TestClient(_app(_secrets())) as client:
        _as(client, "soc_manager")
        body = client.get("/api/rbac").json()
        assert body["caller_role"] == "soc_manager"
        assert body["can_change"] is False
        assert body["blockers"] == ["not_super_admin"]
        # RBAC off: every grant is held, users:manage included.
        assert body["role_counts"] == {"super_admin": 1, "soc_manager": 1}


def test_role_counts_need_users_manage_while_rbac_is_on():
    with TestClient(_app(_secrets(), rbac=True)) as client:
        _as(client, "analyst_tier2")
        body = client.get("/api/rbac").json()
        assert body["enabled"] is True
        assert body["role_counts"] is None
        assert body["super_admin_count"] == 1
        assert body["blockers"] == ["not_super_admin"]


def test_status_names_read_only_settings():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        _set_prefs(client, read_only_settings_mode=True)
        body = client.get("/api/rbac").json()
        assert body["blockers"] == ["read_only_settings"]
        assert body["can_change"] is False


def test_the_environment_administrator_counts_as_a_super_admin():
    secrets = _secrets(auth_seed_admin=False, auth_admin_username="envadmin",
                       auth_admin_password="Env-Admin-Pass-1")
    with TestClient(_app(secrets)) as client:
        signed_in = client.post("/api/auth/login", json={"username": "envadmin", "password": "Env-Admin-Pass-1"})
        assert signed_in.status_code == 200, signed_in.text
        body = client.get("/api/rbac").json()
        assert body["caller_role"] == "super_admin"
        assert body["super_admin_count"] == 1
        assert body["role_counts"] == {"super_admin": 1}
        # And it may turn role-based access on (rule 5 is met by the environment account).
        turned = client.put("/api/rbac", json={"enabled": True})
        assert turned.status_code == 200, turned.text
        assert turned.json()["changed"] is True


def test_a_deactivated_super_admin_is_not_counted():
    """``super_admin_count`` and ``role_counts`` count active accounts only."""
    with TestClient(_app(_secrets())) as client:
        _as(client, "super_admin", "second-admin")
        state = _state(client)
        assert client.get("/api/rbac").json()["super_admin_count"] == 2
        assert client.portal.call(lambda: state.users.update("Admin", active=False)) is not None
        body = client.get("/api/rbac").json()
        assert body["super_admin_count"] == 1
        assert body["role_counts"] == {"super_admin": 1}


def test_rule_5_refuses_when_the_only_super_admin_is_deactivated(monkeypatch):
    """Rule 5 asks for an ACTIVE Super admin: a deactivated one does not meet it."""
    from app.models import User

    with TestClient(_app(_secrets())) as client:
        _admin(client)
        state = _state(client)

        async def inactive_only() -> list[Any]:
            return [User(username="Admin", role="super_admin", active=False)]

        monkeypatch.setattr(state.users, "list", inactive_only)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"]["code"] == "rbac_no_super_admin"
        assert state.prefs.rbac.enabled is False
        assert client.get("/api/rbac").json()["super_admin_count"] == 0


def test_a_persisted_namesake_overrides_the_environment_administrator(monkeypatch):
    """The environment administrator counts only while no persisted account has its
    name (the user store overrides the environment layer, case-insensitively)."""
    from app.models import User

    secrets = _secrets(auth_seed_admin=False, auth_admin_username="envadmin",
                       auth_admin_password="Env-Admin-Pass-1")
    with TestClient(_app(secrets)) as client:
        signed_in = client.post("/api/auth/login", json={"username": "envadmin", "password": "Env-Admin-Pass-1"})
        assert signed_in.status_code == 200, signed_in.text
        state = _state(client)

        async def namesake() -> list[Any]:
            return [User(username="EnvAdmin", role="analyst_tier1", active=True)]

        monkeypatch.setattr(state.users, "list", namesake)
        body = client.get("/api/rbac").json()
        assert body["super_admin_count"] == 0
        assert body["role_counts"] == {"analyst_tier1": 1}


def test_the_status_needs_roles_read():
    with TestClient(_app(_secrets(), rbac=True)) as client:
        username = _as(client, "auditor")
        state = _state(client)

        async def deny() -> None:
            prefs = state.prefs.model_copy(deep=True)
            prefs.rbac.denies["auditor"] = {"roles": ["read"]}
            await state.update_prefs(prefs)

        client.portal.call(deny)
        refused = client.get("/api/rbac")
        assert refused.status_code == 403
        assert refused.json()["detail"] == "permission denied: roles:read"
        assert any(r.get("actor") == username for r in _denials(client))


# --------------------------------------------------------------------------- #
# PUT /api/rbac, rules 1 to 7 in order
# --------------------------------------------------------------------------- #
def test_rule_1_sign_in_off_answers_409():
    with TestClient(_app(_secrets(auth=False))) as client:
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 409
        assert refused.json()["detail"] == {
            "code": "rbac_auth_required",
            "message": "Turn on sign-in first. Role-based access has no effect while sign-in is off.",
        }
        assert _state(client).prefs.rbac.enabled is False


def test_rule_1_comes_first_even_in_read_only_mode():
    with TestClient(_app(_secrets(auth=False))) as client:
        _set_prefs(client, read_only_settings_mode=True)
        assert client.put("/api/rbac", json={"enabled": True}).status_code == 409


def test_rule_2_a_stale_sign_in_answers_reauth_required():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        _backdate_sessions(client, "Admin")
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "reauth_required"
        assert _state(client).prefs.rbac.enabled is False
        assert _settings_rows(client) == []
        # A re-authentication unlocks the retry.
        assert client.post("/api/auth/reauth", json={"password": "Admin@123"}).status_code == 200
        assert client.put("/api/rbac", json={"enabled": True}).status_code == 200


def test_rule_2_comes_before_the_role_check():
    with TestClient(_app(_secrets())) as client:
        username = _as(client, "soc_manager")
        _backdate_sessions(client, username)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "reauth_required"


def test_rule_2_an_unknown_session_is_not_fresh():
    """A validly signed token whose session no sign-in route created is lazily
    registered by the auth gate; that registration is not a sign-in."""
    with TestClient(_app(_secrets())) as client:
        token = _state(client).auth.authenticate("Admin", "Admin@123")
        assert token
        client.cookies.clear()
        client.cookies.set("tlsoc_token", token)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "reauth_required"
        assert refused.json()["detail"]["reason"] == "authn_time_unknown"
        # Re-authenticating on that session proves who is there; the retry passes.
        assert client.post("/api/auth/reauth", json={"password": "Admin@123"}).status_code == 200
        assert client.put("/api/rbac", json={"enabled": True}).status_code == 200


def test_rule_2_a_session_store_failure_is_not_fresh(monkeypatch):
    with TestClient(_app(_secrets())) as client:
        _admin(client)

        async def broken(**_kwargs: Any) -> Any:
            raise RuntimeError("registry down")

        monkeypatch.setattr(_state(client).sessions, "strict_deferred_authority_expires_at", broken)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "reauth_required"
        assert refused.json()["detail"]["reason"] == "session_store_unavailable"
        assert _state(client).prefs.rbac.enabled is False


def test_rule_2_a_token_without_a_session_id_is_not_fresh():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        state = _state(client)
        from app.auth.tokens import decode, encode

        claims = decode(client.cookies.get("tlsoc_token"), "rbac-switch-test-secret")
        claims.pop("sid", None)
        token = encode(claims, "rbac-switch-test-secret", expires_in_s=3600)
        client.cookies.clear()
        client.cookies.set("tlsoc_token", token)
        assert state.auth.verify(token) is not None
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "reauth_required"


def test_rule_3_only_a_verified_super_admin_and_an_access_denied_row():
    with TestClient(_app(_secrets())) as client:
        username = _as(client, "soc_manager")
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 403
        assert refused.json()["detail"] == {
            "code": "rbac_super_admin_only",
            "message": "Only a Super admin can turn role-based access on or off.",
        }
        denials = [r for r in _denials(client) if r.get("actor") == username]
        assert len(denials) == 1
        row = denials[0]
        assert row["outcome"] == "denied"
        assert row["surface"] == "rbac"
        assert row["tool_input"]["route"] == "/api/rbac"
        assert row["tool_input"]["permission"] == "role:super_admin"
        assert "soc_manager" in row["result_summary"]
        assert _state(client).prefs.rbac.enabled is False


def test_rule_3_holds_while_rbac_is_on():
    with TestClient(_app(_secrets(), rbac=True)) as client:
        _as(client, "soc_manager")
        refused = client.put("/api/rbac", json={"enabled": False})
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "rbac_super_admin_only"
        assert _state(client).prefs.rbac.enabled is True


def test_rule_3_a_custom_role_with_every_grant_never_stands_in_for_super_admin():
    """Only the stored role counts: an analyst whose custom role grants every permission
    (users:manage and roles:manage among them) still may not turn role-based access off."""
    from app.rbac.policy import RESOURCES

    with TestClient(_app(_secrets(), rbac=True)) as client:
        username = _as(client, "analyst_tier1", "power-analyst")
        _admin(client)
        grants = {resource: list(actions) for resource, actions in RESOURCES.items()}
        created = client.post("/api/roles", json={"name": "everything", "grants": grants})
        assert created.status_code in (200, 201), created.text
        assigned = client.put(f"/api/users/{username}/roles", json={"custom_roles": ["everything"]})
        assert assigned.status_code == 200, assigned.text
        client.cookies.clear()
        signed_in = client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert signed_in.status_code == 200, signed_in.text
        # The custom role really holds every grant ...
        assert client.get("/api/users").status_code == 200
        status = client.get("/api/rbac").json()
        assert status["caller_role"] == "analyst_tier1"
        assert status["blockers"] == ["not_super_admin"]
        assert status["can_change"] is False
        # ... and still is not a Super admin for the switch.
        refused = client.put("/api/rbac", json={"enabled": False})
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "rbac_super_admin_only"
        assert any(r.get("actor") == username and r["tool_input"]["route"] == "/api/rbac"
                   and r["tool_input"]["permission"] == "role:super_admin" for r in _denials(client))
        assert _state(client).prefs.rbac.enabled is True


def test_rule_4_read_only_settings_answer_403():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        _set_prefs(client, read_only_settings_mode=True)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 403
        assert refused.json()["detail"] == "Settings are in read-only mode"
        # There is no unlock body.
        assert client.put("/api/rbac", json={"enabled": True, "read_only_settings_mode": False}).status_code == 422
        assert _state(client).prefs.rbac.enabled is False


def test_rule_5_turning_on_needs_an_active_super_admin(monkeypatch):
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        state = _state(client)

        async def nobody() -> list[Any]:
            return []

        monkeypatch.setattr(state.users, "list", nobody)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "rbac_no_super_admin"
        assert state.prefs.rbac.enabled is False


def test_rule_5_does_not_stop_turning_off(monkeypatch):
    with TestClient(_app(_secrets(), rbac=True)) as client:
        _admin(client)
        state = _state(client)

        async def nobody() -> list[Any]:
            return []

        monkeypatch.setattr(state.users, "list", nobody)
        turned = client.put("/api/rbac", json={"enabled": False})
        assert turned.status_code == 200, turned.text
        assert state.prefs.rbac.enabled is False


def test_rule_6_no_change_writes_no_audit_row():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        same = client.put("/api/rbac", json={"enabled": False})
        assert same.status_code == 200
        body = same.json()
        assert body["changed"] is False
        assert body["enabled"] is False
        assert body["caller_role"] == "super_admin"
        assert _settings_rows(client) == []


def test_rule_7_turning_on_and_off_is_audited_before_it_is_visible():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        state = _state(client)
        on = client.put("/api/rbac", json={"enabled": True})
        assert on.status_code == 200, on.text
        assert on.json()["changed"] is True
        assert on.json()["enabled"] is True
        assert state.prefs.rbac.enabled is True
        rows = _settings_rows(client)
        assert len(rows) == 1
        row = rows[0]
        assert row["actor"] == "Admin"
        assert row["outcome"] == "success"
        assert row["actor_type"] == "human"
        target = {k: row["target"][k] for k in ("type", "id", "label")}
        assert target == {"type": "setting", "id": "rbac", "label": "RBAC"}
        assert row["changes"] == [{"field": "rbac.enabled", "before": "false", "after": "true", "secret": False}]
        assert row["result_summary"] == "role-based access turned on"
        assert row["request_id"]

        off = client.put("/api/rbac", json={"enabled": False})
        assert off.status_code == 200
        assert state.prefs.rbac.enabled is False
        rows = _settings_rows(client)
        assert len(rows) == 2
        assert {r["result_summary"] for r in rows} == {
            "role-based access turned on", "role-based access turned off",
        }


def test_rule_7_an_audit_failure_answers_503_and_saves_nothing(monkeypatch):
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        state = _state(client)

        async def broken(**_kwargs: Any) -> None:
            raise RuntimeError("audit store down")

        monkeypatch.setattr(state.control_audit, "record_strict", broken)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 503
        assert state.prefs.rbac.enabled is False


def test_rule_7_a_save_that_keeps_racing_answers_settings_conflict(monkeypatch):
    from app.api import routes_rbac
    from app.audit.prefs_write import settings_conflict

    async def racing(*_args: Any, **_kwargs: Any) -> Any:
        raise settings_conflict()

    with TestClient(_app(_secrets())) as client:
        _admin(client)
        monkeypatch.setattr(routes_rbac, "audited_prefs_write", racing)
        refused = client.put("/api/rbac", json={"enabled": True})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "settings_conflict"


def test_the_body_takes_a_json_boolean_only():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        for body in ({"enabled": "true"}, {"enabled": 1}, {}, {"enabled": True, "extra": 1}):
            assert client.put("/api/rbac", json=body).status_code == 422, body
        assert _state(client).prefs.rbac.enabled is False


def test_demo_mode_writes_the_real_settings_and_the_control_audit():
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        enabled = client.post("/api/demo/enable", json={"mode": "seeded", "seed": 1337, "history_days": 2})
        assert enabled.status_code == 200, enabled.text
        state = _state(client)
        assert state.demo_active
        turned = client.put("/api/rbac", json={"enabled": True})
        assert turned.status_code == 200, turned.text
        assert state.prefs.rbac.enabled is True
        assert len(_settings_rows(client)) == 1
        demo_rows = client.portal.call(lambda: state.audit.records(limit=1000))
        assert not [r for r in demo_rows if r.get("action") == "settings.updated"
                    and (r.get("target") or {}).get("id") == "rbac"]
        assert client.post("/api/demo/disable").status_code == 200
        assert state.prefs.rbac.enabled is True


def test_the_session_reads_the_new_state_right_after_the_switch():
    """What the Console's ``auth.refresh()`` re-reads after the switch: the same session's
    permissions report the new state at once, without signing in again."""
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        assert client.get("/api/account/permissions").json()["rbac_enabled"] is False
        assert client.put("/api/rbac", json={"enabled": True}).status_code == 200
        after = client.get("/api/account/permissions").json()
        assert after["rbac_enabled"] is True
        assert after["role"] == "super_admin"
        assert client.get("/api/auth/me").json()["user"]["role"] == "super_admin"
        assert client.put("/api/rbac", json={"enabled": False}).status_code == 200
        assert client.get("/api/account/permissions").json()["rbac_enabled"] is False


def test_turning_rbac_on_enforces_the_roles_at_once():
    with TestClient(_app(_secrets())) as client:
        username = _as(client, "analyst_tier1")
        # RBAC off: the analyst can read the users list (every grant is held).
        assert client.get("/api/users").status_code == 200
        _admin(client)
        assert client.put("/api/rbac", json={"enabled": True}).status_code == 200
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": username, "password": PASSWORD}).status_code == 200
        assert client.get("/api/users").status_code == 403


# --------------------------------------------------------------------------- #
# D1.3: PUT /api/settings
# --------------------------------------------------------------------------- #
def test_settings_refuse_a_changed_rbac_switch():
    with TestClient(_app(_secrets(auth=False))) as client:
        refused = client.put("/api/settings", json={"rbac": {"enabled": True}})
        assert refused.status_code == 409
        assert refused.json()["detail"] == {
            "code": "rbac_switch_moved",
            "message": "Turn role-based access on or off in Roles & permissions, or with PUT /api/rbac.",
        }
        assert _state(client).prefs.rbac.enabled is False
        assert not [r for r in _rows(client) if r.get("action") == "settings.updated"]


def test_settings_compare_the_validated_value():
    """``1`` for a stored ``true`` is no change, so the save goes through."""
    with TestClient(_app(_secrets(auth=False), rbac=True)) as client:
        saved = client.put("/api/settings", json={"rbac": {"enabled": 1}, "poll_interval_seconds": 45})
        assert saved.status_code == 200, saved.text
        assert _state(client).prefs.rbac.enabled is True
        refused = client.put("/api/settings", json={"rbac": {"enabled": 0}})
        assert refused.status_code == 409


def test_settings_read_only_mode_answers_before_the_switch_guard():
    with TestClient(_app(_secrets(auth=False))) as client:
        _set_prefs(client, read_only_settings_mode=True)
        refused = client.put("/api/settings", json={"rbac": {"enabled": True}})
        assert refused.status_code == 403
        assert refused.json()["detail"] == "Settings are in read-only mode"


def test_settings_matrix_edits_with_sign_in_off_are_unchanged():
    with TestClient(_app(_secrets(auth=False))) as client:
        saved = client.put("/api/settings", json={"rbac": {"default_role": "auditor"}})
        assert saved.status_code == 200, saved.text
        assert _state(client).prefs.rbac.default_role == "auditor"


#: One changed value for every field of the role matrix (SPEC D1.3), each a valid edit,
#: so the guard and not validation is what answers.
_MATRIX_EDITS: dict[str, Any] = {
    "roles": {"auditor": {"cases": ["read"]}},
    "resources": {"auditor": {"cases": ["read", "update"]}},
    "custom_roles": [{"name": "everything", "grants": {"cases": ["read"]}}],
    "denies": {"auditor": {"cases": ["read"]}},
    "default_role": "auditor",
}


def test_every_rbac_field_but_the_switch_and_the_stamp_is_guarded():
    """A field added to the rbac block later is guarded by default: the matrix set is
    every field but ``enabled`` (its own route) and ``rbac_grants_version`` (a stamp)."""
    from app.api.routes import _RBAC_MATRIX_FIELDS
    from app.config import RBACConfig

    assert set(_RBAC_MATRIX_FIELDS) == set(RBACConfig.model_fields) - {"enabled", "rbac_grants_version"}
    assert set(_MATRIX_EDITS) == set(_RBAC_MATRIX_FIELDS)


@pytest.mark.parametrize("field", sorted(_MATRIX_EDITS))
def test_settings_matrix_edits_need_roles_manage(field: str):
    with TestClient(_app(_secrets(), rbac=True)) as client:
        username = _as(client, "soc_manager")
        state = _state(client)

        async def deny() -> None:
            prefs = state.prefs.model_copy(deep=True)
            prefs.rbac.denies["soc_manager"] = {"roles": ["manage"]}
            await state.update_prefs(prefs)

        client.portal.call(deny)
        stored = state.prefs.rbac.model_dump(mode="json")
        before = len([r for r in _rows(client) if r.get("action") == "settings.updated"])
        refused = client.put("/api/settings", json={"rbac": {field: _MATRIX_EDITS[field]}})
        assert refused.status_code == 403, refused.text
        assert refused.json()["detail"] == "permission denied: roles:manage"
        assert state.prefs.rbac.model_dump(mode="json") == stored
        assert any(r.get("actor") == username and "roles:manage" in r.get("result_summary", "")
                   for r in _denials(client))
        after = len([r for r in _rows(client) if r.get("action") == "settings.updated"])
        assert after == before
        # The same person still saves settings that leave the role matrix alone.
        assert client.put("/api/settings", json={"poll_interval_seconds": 45}).status_code == 200


@pytest.mark.parametrize("field", sorted(_MATRIX_EDITS))
def test_settings_matrix_edits_need_a_fresh_sign_in(field: str):
    with TestClient(_app(_secrets())) as client:
        username = _as(client, "soc_manager")
        _backdate_sessions(client, username)
        state = _state(client)
        stored = state.prefs.rbac.model_dump(mode="json")
        body = {"rbac": {field: _MATRIX_EDITS[field]}}
        refused = client.put("/api/settings", json=body)
        assert refused.status_code == 401, refused.text
        assert refused.json()["detail"]["code"] == "reauth_required"
        assert state.prefs.rbac.model_dump(mode="json") == stored
        # A save without an rbac change needs no fresh sign-in.
        assert client.put("/api/settings", json={"poll_interval_seconds": 45}).status_code == 200
        # After re-authenticating the matrix edit goes through and is audited once.
        assert client.post("/api/auth/reauth", json={"password": PASSWORD}).status_code == 200
        saved = client.put("/api/settings", json=body)
        assert saved.status_code == 200, saved.text
        assert state.prefs.rbac.model_dump(mode="json")[field] != stored[field]
        if field == "roles":
            assert state.prefs.rbac.roles == {"auditor": {"cases": ["read"]}}
        rbac_rows = [r for r in _rows(client) if r.get("action") == "settings.updated"
                     and "rbac" in str((r.get("target") or {}).get("id"))]
        assert len(rbac_rows) == 1


def test_settings_an_equal_rbac_block_is_no_change():
    """The full settings round trip sends the stored ``rbac`` block back unchanged."""
    with TestClient(_app(_secrets())) as client:
        _as(client, "soc_manager")
        state = _state(client)
        _backdate_sessions(client, "soc-manager-person")
        body = {"rbac": state.prefs.rbac.model_dump(mode="json"), "poll_interval_seconds": 50}
        saved = client.put("/api/settings", json=body)
        assert saved.status_code == 200, saved.text


# --------------------------------------------------------------------------- #
# Super admin accounts (Round 15 review, security): users:manage alone never mints or
# edits a Super admin, so rule 3 of the switch cannot be bypassed through user management
# --------------------------------------------------------------------------- #
def _super_admin_denials(client: TestClient, username: str) -> list[dict[str, Any]]:
    return [r for r in _denials(client) if r.get("actor") == username
            and r["tool_input"]["permission"] == "role:super_admin"]


def _user_rows(client: TestClient, username: str) -> list[dict[str, Any]]:
    return [r for r in _rows(client) if r.get("actor") == username
            and str(r.get("action") or "").startswith("user.")]


def _stored(client: TestClient, username: str) -> Any:
    state = _state(client)
    return client.portal.call(state.users.get, username)


def _role_text_of(user: Any) -> str:
    role = getattr(user, "role", "")
    return str(getattr(role, "value", role) or "")


def _refused_as_super_admin_only(response: Any) -> None:
    assert response.status_code == 403, response.text
    assert response.json()["detail"] == {
        "code": "super_admin_only",
        "message": "Only a Super admin can give an account the Super admin role or change a "
                   "Super admin account.",
    }


def test_a_users_manage_holder_cannot_make_itself_super_admin():
    """A SOC manager holds users:manage by default. One call used to promote it to Super
    admin (no fresh sign-in either), after which the Super-admin-only switch let it turn
    role-based access off. Every path that can give the role now refuses, with RBAC on
    or off, and writes an Access denied row; the switch still refuses after signing in
    again."""
    for rbac in (False, True):
        with TestClient(_app(_secrets(), rbac=rbac)) as client:
            username = _as(client, "soc_manager", "mgr")
            _refused_as_super_admin_only(client.put(f"/api/users/{username}", json={"role": "super_admin"}))
            _refused_as_super_admin_only(
                client.put(f"/api/users/{username}/roles", json={"role": "super_admin"}))
            _refused_as_super_admin_only(client.post(
                "/api/users", json={"username": "mgr-made", "password": PASSWORD, "role": "super_admin"}))
            assert _role_text_of(_stored(client, username)) == "soc_manager"
            assert _stored(client, "mgr-made") is None
            assert len(_super_admin_denials(client, username)) == 3
            assert _user_rows(client, username) == []
            client.cookies.clear()
            signed_in = client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
            assert signed_in.status_code == 200, signed_in.text
            refused = client.put("/api/rbac", json={"enabled": not rbac})
            assert refused.status_code == 403
            assert refused.json()["detail"]["code"] == "rbac_super_admin_only"
            assert _state(client).prefs.rbac.enabled is rbac
            # Other accounts stay the SOC manager's to manage.
            made = client.post("/api/users", json={"username": "new-analyst", "password": PASSWORD,
                                                   "role": "analyst_tier1"})
            assert made.status_code == 200, made.text
            moved = client.put("/api/users/new-analyst", json={"role": "analyst_tier2"})
            assert moved.status_code == 200, moved.text


def test_a_users_manage_holder_cannot_change_or_delete_a_super_admin_account():
    """Resetting a Super admin's password would hand the account over, so a change of
    any kind to a Super admin account, and its deletion, is a Super admin's alone."""
    with TestClient(_app(_secrets())) as client:
        _admin(client)
        made = client.post("/api/users", json={"username": "second-admin", "password": PASSWORD,
                                               "role": "super_admin"})
        assert made.status_code == 200, made.text
        before = _stored(client, "second-admin")
        username = _as(client, "soc_manager", "mgr")
        for patch in ({"password": "taken-over-pass-1"}, {"active": False}, {"role": "analyst_tier1"},
                      {"mfa_required": True}, {"display_name": "Not me"}):
            _refused_as_super_admin_only(client.put("/api/users/second-admin", json=patch))
        _refused_as_super_admin_only(client.put("/api/users/second-admin/roles", json={"role": "auditor"}))
        _refused_as_super_admin_only(client.delete("/api/users/second-admin"))
        after = _stored(client, "second-admin")
        assert after is not None
        assert (after.password_hash, after.active, _role_text_of(after), after.mfa_required,
                after.display_name) == (before.password_hash, True, "super_admin", before.mfa_required,
                                        before.display_name)
        assert len(_super_admin_denials(client, username)) == 7
        assert _user_rows(client, username) == []
        client.cookies.clear()
        signed_in = client.post("/api/auth/login", json={"username": "second-admin", "password": PASSWORD})
        assert signed_in.status_code == 200, signed_in.text


def test_a_super_admin_grants_the_role_with_a_strict_fresh_sign_in():
    with TestClient(_app(_secrets())) as client:
        _as(client, "analyst_tier1", "promoted")
        _admin(client)
        _backdate_sessions(client, "Admin")
        for refused in (
            client.put("/api/users/promoted", json={"role": "super_admin"}),
            client.post("/api/users", json={"username": "fresh-admin", "password": PASSWORD,
                                            "role": "super_admin"}),
        ):
            assert refused.status_code == 401
            assert refused.json()["detail"]["code"] == "reauth_required"
        assert _role_text_of(_stored(client, "promoted")) == "analyst_tier1"
        assert _stored(client, "fresh-admin") is None
        # An ordinary change needs no fresh sign-in.
        assert client.put("/api/users/promoted", json={"display_name": "Promoted"}).status_code == 200
        assert client.post("/api/auth/reauth", json={"password": "Admin@123"}).status_code == 200
        granted = client.put("/api/users/promoted", json={"role": "super_admin"})
        assert granted.status_code == 200, granted.text
        assert _role_text_of(_stored(client, "promoted")) == "super_admin"
        assert [r["action"] for r in _user_rows(client, "Admin")].count("user.role_changed") == 1
        made = client.post("/api/users", json={"username": "fresh-admin", "password": PASSWORD,
                                               "role": "super_admin"})
        assert made.status_code == 200, made.text
        assert client.delete("/api/users/fresh-admin").status_code == 200
        assert _stored(client, "fresh-admin") is None


def test_super_admin_accounts_with_sign_in_off_are_unchanged():
    with TestClient(_app(_secrets(auth=False))) as client:
        made = client.post("/api/users", json={"username": "open-admin", "password": PASSWORD,
                                               "role": "super_admin"})
        assert made.status_code == 200, made.text
        assert client.put("/api/users/open-admin", json={"display_name": "Open"}).status_code == 200
        assert client.delete("/api/users/open-admin").status_code == 409  # the last one
