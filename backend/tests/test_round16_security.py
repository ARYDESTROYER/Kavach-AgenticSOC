"""Round 16 WP15A: one regression per security and access fix (SPEC §4.3 WP15A).

Each test fails on the tree before its fix: B01 (with B70), B15 to B24, B51 and B55.
Offline: fake Elasticsearch, a mock model, the real routers.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import threading
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.api import routes as routes_mod
from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_cases_collab import router as collab_router
from app.api.routes_models import router as models_router
from app.api.routes_prefs import router as prefs_router
from app.api.routes_roles import router as roles_router
from app.api.routes_standup import router as standup_router
from app.audit import context as audit_context_mod
from app.auth import mfa as mfa_mod
from app.auth.oidc import OidcProvider
from app.auth.passwords import hash_password
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface, UserRole, Verdict
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState
from tests._auth_helpers import ready_user

CASE_ID = "case-r16-sec"
ADMIN = ("Admin", "Admin@123")
PW = "r16-account-pass-1"
T1 = UserRole.ANALYST_TIER1.value
MGR = UserRole.SOC_MANAGER.value

# A pinned clock in the middle of a TOTP step, so server and test agree on "now".
_NOW = 1_782_700_000.0 + 15.0
_ROUTERS = (monolith_router, collab_router, models_router, standup_router, roles_router,
            prefs_router)


def _secrets() -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="round16-security-secret",
        auth_seed_admin=True,
    )


async def _started_state(*, rbac: bool, denies: dict | None = None) -> AppState:
    mock = MockProvider()
    state = AppState.create(secrets=_secrets(), es=InMemoryESClient(),
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    await state.startup(start_poller=False)
    rbac_cfg = state.prefs.rbac.model_copy(update={"enabled": rbac, "denies": denies or {}})
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True, "rbac": rbac_cfg}))
    await state.cases.save(Case(
        case_id=CASE_ID, cluster_signature=f"sig:{CASE_ID}", case_number="CASE-0016",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.16"),
        verdict=Verdict.NEEDS_HUMAN, confidence=0.4, status=CaseStatus.NEEDS_HUMAN,
    ))
    return state


def _include(api: FastAPI) -> FastAPI:
    for r in _ROUTERS:
        api.include_router(r, dependencies=[Depends(require_auth)])
    return api


def _app(*, rbac: bool = True, denies: dict | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(api: FastAPI):
        state = await _started_state(rbac=rbac, denies=denies)
        api.state.tlsoc = state
        yield
        await state.shutdown()

    return _include(FastAPI(lifespan=lifespan))


def _state(c: TestClient) -> AppState:
    return c.app.state.tlsoc


def _login(c: TestClient, username: str, password: str) -> httpx.Response:
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _new_user(c: TestClient, username: str, role: str = T1, *, ready: bool = True) -> None:
    """Create ``username`` as the signed-in administrator (and clear its forced change)."""
    r = c.post("/api/users", json={"username": username, "password": PW, "role": role})
    assert r.status_code == 200, r.text
    if ready:
        ready_user(c, username, PW)


def _rows(c: TestClient, action: str) -> list[dict[str, Any]]:
    state = _state(c)
    rows = c.portal.call(lambda: state.control_audit.records(limit=1000))
    return [r for r in rows if r.get("action") == action]


def _denials(c: TestClient) -> list[dict[str, Any]]:
    state = _state(c)
    return c.portal.call(lambda: state.control_audit.records(action_type="access_denied", limit=500))


# --------------------------------------------------------------------------- #
# B01 (with B70): every read route checks its read grant
# --------------------------------------------------------------------------- #
CASE_READS = (
    f"/api/cases/{CASE_ID}/export?format=json",
    f"/api/cases/{CASE_ID}/trace",
    f"/api/cases/{CASE_ID}/rationale",
    f"/api/cases/{CASE_ID}/activity",
    f"/api/cases/{CASE_ID}/thread",
    f"/api/cases/{CASE_ID}/tasks",
    "/api/scans",
    "/api/scans/notifications",
)


def test_b01_a_role_denied_cases_read_gets_403_from_every_case_read() -> None:
    denies = {T1: {"cases": ["read"], "settings": ["read"]}}
    with TestClient(_app(denies=denies)) as c:
        _login(c, *ADMIN)
        for path in (*CASE_READS, "/api/settings"):
            assert c.get(path).status_code == 200, path  # the grant holder still reads
        _new_user(c, "tina")
        _login(c, "tina", PW)
        for path in CASE_READS:
            r = c.get(path)
            assert r.status_code == 403, path
            assert r.json()["detail"] == "permission denied: cases:read", path
        assert c.get("/api/settings").status_code == 403
        summaries = {row["result_summary"] for row in _denials(c)}
    assert any("cases:read" in s for s in summaries)
    assert any("settings:read" in s for s in summaries)


@pytest.mark.parametrize(("resource", "action", "paths"), [
    ("sources", "read", ("/api/sources/primary/feeds",)),
    ("metrics", "view", ("/api/standup", "/api/standup/report", "/api/standup/action-items",
                         "/api/standup/acknowledgements")),
    ("models", "read", ("/api/llm/models", "/api/models", "/api/llm/providers")),
    ("roles", "read", ("/api/roles",)),
])
def test_b01_each_read_checks_its_own_grant(resource: str, action: str, paths: tuple) -> None:
    with TestClient(_app(denies={T1: {resource: [action]}})) as c:
        _login(c, *ADMIN)
        for path in paths:
            assert c.get(path).status_code != 403, path
        _new_user(c, "rory")
        _login(c, "rory", PW)
        for path in paths:
            r = c.get(path)
            assert r.status_code == 403, (path, r.text)
            assert r.json()["detail"] == f"permission denied: {resource}:{action}", path


# --------------------------------------------------------------------------- #
# B20: the forced password change is enforced by the server
# --------------------------------------------------------------------------- #
def test_b20_a_flagged_account_is_held_until_it_changes_its_password() -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        _new_user(c, "fresh", ready=False)
        c.cookies.clear()
        signed_in = c.post("/api/auth/login", json={"username": "fresh", "password": PW})
        assert signed_in.json()["user"]["must_change_password"] is True
        h = _bearer(signed_in.json()["token"])
        held = c.get("/api/cases", headers=h)
        assert held.status_code == 403
        assert held.json()["detail"] == {
            "code": "password_change_required",
            "message": "Change your temporary password to continue.",
        }
        made = c.post("/api/users", headers=h, json={"username": "x1", "password": PW, "role": T1})
        assert made.status_code == 403
        assert made.json()["detail"]["code"] == "password_change_required"
        # The reads the sign-in screen needs still answer.
        for path in ("/api/prefs/effective", "/api/prefs/user", "/api/account/permissions",
                     "/api/account/me", "/api/auth/me"):
            assert c.get(path, headers=h).status_code == 200, path
        changed = c.post("/api/auth/change-password", headers=h, json={
            "current_password": PW, "new_password": "fresh-new-pass-1"})
        assert changed.status_code == 200, changed.text
        assert c.get("/api/cases", headers=h).status_code == 200
        made = c.post("/api/users", headers=h, json={"username": "x1", "password": PW, "role": T1})
        assert made.status_code == 200, made.text


def test_b20_the_seeded_demo_admin_is_not_flagged() -> None:
    with TestClient(_app(rbac=False)) as c:
        assert _login(c, *ADMIN).json()["user"]["must_change_password"] is False
        assert c.get("/api/cases").status_code == 200


# --------------------------------------------------------------------------- #
# B18: password hashing runs off the event loop
# --------------------------------------------------------------------------- #
def test_b18_a_request_is_answered_while_ten_logins_hash(monkeypatch) -> None:
    real = hashlib.pbkdf2_hmac
    entered, release, returned = threading.Event(), threading.Event(), threading.Event()
    slow_password = b"slow-login-password"

    def slow(name, password, salt, iterations, *args, **kwargs):
        if password == slow_password:
            entered.set()
            release.wait(2)
            returned.set()
        return real(name, password, salt, iterations, *args, **kwargs)

    with TestClient(_app(rbac=False)) as c:
        monkeypatch.setattr(hashlib, "pbkdf2_hmac", slow)
        statuses: list[int] = []

        def attempt() -> None:
            r = c.post("/api/auth/login", json={"username": "Admin", "password": slow_password.decode()})
            statuses.append(r.status_code)

        threads = [threading.Thread(target=attempt) for _ in range(10)]
        for t in threads:
            t.start()
        assert entered.wait(5)
        health = c.get("/api/health/live")
        answered_while_hashing = not returned.is_set()
        release.set()
        for t in threads:
            t.join(30)
    assert health.status_code == 200
    assert answered_while_hashing, "the health check waited for a login's PBKDF2"
    assert statuses == [401] * 10


# --------------------------------------------------------------------------- #
# MFA helpers
# --------------------------------------------------------------------------- #
@pytest.fixture
def frozen_clock(monkeypatch):
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _NOW)


def _code(secret: str, steps: int = 0) -> str:
    return mfa_mod.totp(secret, ts=_NOW + 30 * steps)


def _enrolled(c: TestClient, username: str) -> tuple[str, list[str], dict[str, str]]:
    """``username`` created, readied and enrolled in MFA from its own session.
    Returns (secret, recovery codes, that session's bearer header)."""
    _login(c, *ADMIN)
    _new_user(c, username)
    token = _login(c, username, PW).json()["token"]
    c.cookies.clear()
    h = _bearer(token)
    setup = c.post("/api/auth/mfa/setup", headers=h)
    assert setup.status_code == 200, setup.text
    secret = setup.json()["secret"]
    assert c.post("/api/auth/mfa/confirm", headers=h, json={"code": _code(secret)}).status_code == 200
    return secret, setup.json()["recovery_codes"], h


def _pending(c: TestClient, username: str) -> str:
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": PW})
    assert r.status_code == 200 and r.json()["requires_mfa"] is True, r.text
    return r.json()["pending_token"]


def _verify(c: TestClient, pending: str, code: str) -> httpx.Response:
    c.cookies.clear()
    return c.post("/api/auth/mfa/verify", json={"pending_token": pending, "code": code})


# --------------------------------------------------------------------------- #
# B17: an enrolled authenticator is never replaced from a bare session
# --------------------------------------------------------------------------- #
def test_b17_an_enrolled_account_cannot_replace_its_authenticator(frozen_clock) -> None:
    with TestClient(_app(rbac=False)) as c:
        secret, _codes, h = _enrolled(c, "mona")
        state = _state(c)
        before = c.portal.call(state.users.get, "mona").mfa_secret
        setup = c.post("/api/auth/mfa/setup", headers=h)
        assert setup.status_code == 409
        assert setup.json()["detail"] == {
            "code": "mfa_already_enabled",
            "message": "MFA is already enabled; turn it off with a current code before "
                       "enrolling a new authenticator.",
        }
        assert c.post("/api/auth/mfa/confirm", headers=h,
                      json={"code": _code(secret)}).status_code == 409
        assert c.portal.call(state.users.get, "mona").mfa_secret == before
        # The original authenticator still works.
        assert c.post("/api/auth/mfa/disable", headers=h,
                      json={"code": _code(secret, 1)}).status_code == 200


def test_b17_enrolment_needs_a_fresh_sign_in() -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        _new_user(c, "stale")
        token = _login(c, "stale", PW).json()["token"]
        c.cookies.clear()
        state = _state(c)
        sid = state.auth.claims_of(token)["sid"]

        async def _age() -> None:
            # The session last signed in long ago, outside the fresh sign-in window.
            await state.sessions._mutate(lambda entries: [
                row.update(last_authn_at="2000-01-01T00:00:00+00:00")
                for row in entries if row.get("sid") == sid
            ])

        c.portal.call(_age)
        for path in ("/api/auth/mfa/setup", "/api/auth/mfa/confirm", "/api/auth/mfa/disable"):
            r = c.post(path, headers=_bearer(token), json={"code": "123456"})
            assert r.status_code == 401, (path, r.text)
            assert r.json()["detail"]["code"] == "reauth_required", path


# --------------------------------------------------------------------------- #
# B19: a bound on second-factor attempts, and a single-use pending token
# --------------------------------------------------------------------------- #
def test_b19_ten_wrong_codes_lock_the_second_factor(frozen_clock) -> None:
    with TestClient(_app(rbac=False)) as c:
        secret, codes, _h = _enrolled(c, "mona")
        state = _state(c)
        wrong = _code(secret, 10)
        first = _pending(c, "mona")
        for _ in range(5):
            assert _verify(c, first, wrong).status_code == 401
        # After 5 failures the pending token is spent, even for a correct code.
        spent = _verify(c, first, _code(secret))
        assert spent.status_code == 401
        assert spent.json()["detail"] == "invalid or expired pending session"
        second = _pending(c, "mona")
        for _ in range(5):
            assert _verify(c, second, wrong).status_code == 401
        third = _pending(c, "mona")
        locked = _verify(c, third, _code(secret))
        assert locked.status_code == 429
        assert locked.json()["detail"]["code"] == "mfa_locked"
        assert int(locked.headers["Retry-After"]) > 0
        stored = c.portal.call(state.users.get, "mona")
        assert stored.mfa_failed_count == 10 and stored.mfa_locked_until
        assert len(_rows(c, "auth.mfa_locked")) == 1
        # The window passes: the correct code signs in and the counter resets.
        c.portal.call(lambda: state.users.update(
            "mona", mfa_locked_until="2000-01-01T00:00:00+00:00"))
        ok = _verify(c, third, _code(secret, 1))  # the enrolment used this step's code
        assert ok.status_code == 200, ok.text
        stored = c.portal.call(state.users.get, "mona")
        assert stored.mfa_failed_count == 0 and stored.mfa_locked_until == ""
        # A pending token that signed in is never accepted again.
        again = _verify(c, third, codes[0])
        assert again.status_code == 401
        assert again.json()["detail"] == "invalid or expired pending session"


def test_b19_wrong_codes_on_disable_lock_and_mfa_stays_on(frozen_clock) -> None:
    with TestClient(_app(rbac=False)) as c:
        secret, _codes, h = _enrolled(c, "mona")
        wrong = _code(secret, 10)
        for _ in range(10):
            assert c.post("/api/auth/mfa/disable", headers=h, json={"code": wrong}).status_code == 400
        refused = c.post("/api/auth/mfa/disable", headers=h, json={"code": _code(secret, 1)})
        assert refused.status_code == 429
        assert c.portal.call(_state(c).users.get, "mona").mfa_enabled is True


def test_b19_an_administrators_mfa_reset_clears_the_lock(frozen_clock) -> None:
    """An administrator turning a locked account's MFA off is the recovery path for a
    lost authenticator, so it clears the failure count and the lock too: the person
    can enrol again at once instead of waiting out the lock."""
    with TestClient(_app(rbac=False)) as c:
        secret, _codes, _h = _enrolled(c, "mona")
        wrong = _code(secret, 10)
        for _ in range(2):
            pending = _pending(c, "mona")
            for _ in range(5):
                assert _verify(c, pending, wrong).status_code == 401
        state = _state(c)
        assert c.portal.call(state.users.get, "mona").mfa_locked_until
        _login(c, *ADMIN)
        reset = c.put("/api/users/mona", json={"mfa_enabled": False})
        assert reset.status_code == 200, reset.text
        stored = c.portal.call(state.users.get, "mona")
        assert stored.mfa_enabled is False
        assert (stored.mfa_failed_count, stored.mfa_locked_until) == (0, "")
        # Enrolling again from a fresh session is not refused by the old lock.
        token = _login(c, "mona", PW).json()["token"]
        c.cookies.clear()
        setup = c.post("/api/auth/mfa/setup", headers=_bearer(token))
        assert setup.status_code == 200, setup.text
        confirm = c.post("/api/auth/mfa/confirm", headers=_bearer(token),
                         json={"code": _code(setup.json()["secret"])})
        assert confirm.status_code == 200, confirm.text


def test_b18_a_totp_shaped_code_never_runs_the_recovery_hash_loop(frozen_clock, monkeypatch) -> None:
    with TestClient(_app(rbac=False)) as c:
        secret, _codes, _h = _enrolled(c, "mona")
        pending = _pending(c, "mona")
        calls: list[int] = []
        real = hashlib.pbkdf2_hmac

        def counting(*args, **kwargs):
            calls.append(1)
            return real(*args, **kwargs)

        monkeypatch.setattr(hashlib, "pbkdf2_hmac", counting)
        assert _verify(c, pending, _code(secret, 10)).status_code == 401
    assert calls == []


# --------------------------------------------------------------------------- #
# B23: one code, one session, under concurrency
# --------------------------------------------------------------------------- #
_IN_MUTATOR: contextvars.ContextVar[bool] = contextvars.ContextVar("in_mutator", default=False)


@pytest.mark.parametrize("kind", ["recovery", "totp"])
async def test_b23_one_code_redeemed_twice_concurrently_signs_in_once(kind, monkeypatch) -> None:
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _NOW)
    state = await _started_state(rbac=False)
    try:
        secret = mfa_mod.generate_secret()
        code = "AB12-CD34"
        await state.users.create(username="rita", password_hash=hash_password(PW), role=T1)
        await state.users.update(
            "rita", mfa_enabled=True,
            mfa_secret=mfa_mod.obfuscate_secret(secret, state.secrets.mfa_server_key()),
            mfa_recovery_hashes=[mfa_mod.hash_recovery_code(code)],
        )
        await state.refresh_users()
        api = _include(FastAPI())
        api.state.tlsoc = state

        # PBKDF2 inside the user store's mutator would run on every CAS retry.
        import app.stores.users as users_mod

        real_mutate = users_mod.kv_mutate
        inside: list[bool] = []

        async def marked_mutate(*args, **kwargs):
            token = _IN_MUTATOR.set(True)
            try:
                return await real_mutate(*args, **kwargs)
            finally:
                _IN_MUTATOR.reset(token)

        real_pbkdf2 = hashlib.pbkdf2_hmac

        def watched(*args, **kwargs):
            inside.append(_IN_MUTATOR.get())
            return real_pbkdf2(*args, **kwargs)

        monkeypatch.setattr(users_mod, "kv_mutate", marked_mutate)
        monkeypatch.setattr(hashlib, "pbkdf2_hmac", watched)

        transport = httpx.ASGITransport(app=api)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            pendings = []
            for _ in range(2):
                r = await client.post("/api/auth/login", json={"username": "rita", "password": PW})
                pendings.append(r.json()["pending_token"])
                client.cookies.clear()
            # Both requests read the account before either consumes the code.
            real_get = state.users.get
            barrier = asyncio.Barrier(2)
            armed = {"left": 2}

            async def get_then_wait(name):
                user = await real_get(name)
                if armed["left"] > 0:
                    armed["left"] -= 1
                    await asyncio.wait_for(barrier.wait(), 5)
                return user

            monkeypatch.setattr(state.users, "get", get_then_wait)
            inside.clear()
            used = code if kind == "recovery" else mfa_mod.totp(secret, ts=_NOW)
            r1, r2 = await asyncio.gather(*(
                client.post("/api/auth/mfa/verify", json={"pending_token": p, "code": used})
                for p in pendings
            ))
        assert sorted([r1.status_code, r2.status_code]) == [200, 401]
        assert not any(inside), "PBKDF2 ran inside the user store's mutator"
        stored = await real_get("rita")
        if kind == "recovery":
            assert stored.mfa_recovery_hashes == []
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# B21: a password change ends the account's other sessions
# --------------------------------------------------------------------------- #
def test_b21_a_password_change_signs_out_the_other_sessions() -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        _new_user(c, "sam")
        first = _login(c, "sam", PW).json()["token"]
        second = _login(c, "sam", PW).json()["token"]
        c.cookies.clear()
        changed = c.post("/api/auth/change-password", headers=_bearer(first), json={
            "current_password": PW, "new_password": "sam-new-pass-1"})
        assert changed.status_code == 200, changed.text
        assert changed.json()["sessions_revoked"] == 1
        other = c.get("/api/account/me", headers=_bearer(second))
        assert other.status_code == 401
        assert other.json()["detail"]["reason"] == "revoked"
        assert c.get("/api/account/me", headers=_bearer(first)).status_code == 200
        revoked = [r for r in _rows(c, "session.revoked")
                   if (r.get("tool_input") or {}).get("reason") == "password_changed"]
        assert len(revoked) == 1


def test_b21_an_admin_reset_signs_the_account_out_everywhere() -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        _new_user(c, "sam")
        token = _login(c, "sam", PW).json()["token"]
        _login(c, *ADMIN)
        reset = c.put("/api/users/sam", json={"password": "sam-reset-pass-1"})
        assert reset.status_code == 200, reset.text
        assert reset.json()["sessions_revoked"] >= 1
        c.cookies.clear()
        after = c.get("/api/account/me", headers=_bearer(token))
        assert after.status_code == 401
        assert after.json()["detail"]["reason"] == "tv_mismatch"


# --------------------------------------------------------------------------- #
# B22: the session IP is never the caller's choice
# --------------------------------------------------------------------------- #
class _Peer:
    """Serve the app as if every request came from ``host``."""

    def __init__(self, app: FastAPI, host: str) -> None:
        self.app, self.host = app, host

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            scope = dict(scope, client=(self.host, 50000))
        await self.app(scope, receive, send)


def _session_ips(c: TestClient) -> list[str]:
    return [s.get("ip") for s in c.get("/api/sessions").json()["sessions"]]


def test_b22_a_forged_forwarded_for_never_names_the_session() -> None:
    saved = audit_context_mod._TRUSTED
    audit_context_mod.configure_trusted_proxies("")
    try:
        with TestClient(_Peer(_app(rbac=False), "198.51.100.9")) as c:
            c.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"},
                   headers={"X-Forwarded-For": "203.0.113.77"})
            ips = _session_ips(c)
    finally:
        audit_context_mod._TRUSTED = saved
    assert ips and "203.0.113.77" not in ips
    assert ips == ["198.51.100.9"]


def test_b22_behind_a_trusted_proxy_the_forwarded_client_is_recorded() -> None:
    saved = audit_context_mod._TRUSTED
    audit_context_mod.configure_trusted_proxies("10.9.8.7")
    try:
        with TestClient(_Peer(_app(rbac=False), "10.9.8.7")) as c:
            c.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"},
                   headers={"X-Forwarded-For": "203.0.113.77, 192.0.2.44"})
            ips = _session_ips(c)
    finally:
        audit_context_mod._TRUSTED = saved
    assert ips == ["192.0.2.44"]


# --------------------------------------------------------------------------- #
# B24: no refresh token, and the route says it is deprecated
# --------------------------------------------------------------------------- #
def test_b24_no_sign_in_issues_a_refresh_token_and_the_route_is_deprecated() -> None:
    api = _app(rbac=False)
    with TestClient(api) as c:
        signed_in = _login(c, *ADMIN).json()
        assert "refresh_token" not in signed_in
        rows = c.portal.call(_state(c).sessions.list_for, "Admin")
        assert rows and all(not r.get("refresh_hash") for r in rows)
        r = c.post("/api/auth/refresh", json={"refresh_token": "anything"})
        assert r.status_code == 401
        assert r.json()["detail"] == {"code": "session_invalid", "reason": "unknown_refresh"}
    assert api.openapi()["paths"]["/api/auth/refresh"]["post"].get("deprecated") is True


# --------------------------------------------------------------------------- #
# B15: single sign-on settings are for a stored Super admin only
# --------------------------------------------------------------------------- #
def _provider(**over: Any) -> dict[str, Any]:
    cfg = {
        "id": "corp", "type": "generic", "display_name": "Corp",
        "client_id": "corp-client",
        "discovery_url": "https://idp.corp.test/.well-known/openid-configuration",
        "default_role": T1,
    }
    cfg.update(over)
    return cfg


def _sso_with_a_linked_super_admin(c: TestClient) -> None:
    _login(c, *ADMIN)
    r = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [_provider()]}})
    assert r.status_code == 200, r.text
    state = _state(c)
    c.portal.call(lambda: state.users.update("Admin", oauth_provider="corp", oauth_sub="admin-sub"))


def test_b15_a_soc_manager_cannot_repoint_a_provider_a_super_admin_uses() -> None:
    with TestClient(_app(rbac=True)) as c:
        _sso_with_a_linked_super_admin(c)
        before = _state(c).prefs.sso.model_dump(mode="json")
        _new_user(c, "max", MGR)
        _login(c, "max", PW)
        evil = _provider(discovery_url="https://idp.evil.test/.well-known/openid-configuration")
        r = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [evil]}})
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["code"] == "super_admin_only"
        assert _state(c).prefs.sso.model_dump(mode="json") == before
        secret = c.post("/api/auth/sso/providers/corp/secret", json={"client_secret": "x"})
        assert secret.status_code == 403
        assert secret.json()["detail"]["code"] == "super_admin_only"
        assert not _state(c).secrets.sso_client_secret("corp")


def test_b15_the_refusal_says_single_sign_on_is_for_a_super_admin() -> None:
    """The Console shows the refusal's message as it is, so it names what was refused
    (single sign-on), not the account rule a role change gets."""
    with TestClient(_app(rbac=True)) as c:
        _sso_with_a_linked_super_admin(c)
        _new_user(c, "max", MGR)
        _login(c, "max", PW)
        r = c.put("/api/settings", json={"sso": {"enabled": False}})
        assert r.status_code == 403, r.text
        assert r.json()["detail"] == {
            "code": "super_admin_only",
            "message": "Only a Super admin can change single sign-on.",
        }
        secret = c.post("/api/auth/sso/providers/corp/secret", json={"client_secret": "x"})
        assert secret.json()["detail"]["message"] == "Only a Super admin can change single sign-on."
        # A Super admin account change keeps its own message.
        made = c.post("/api/users", json={"username": "boss", "password": PW,
                                          "role": UserRole.SUPER_ADMIN.value})
        assert made.status_code == 403
        assert made.json()["detail"]["message"] == routes_mod.SUPER_ADMIN_ACCOUNT_MESSAGE


def test_b15_a_settings_manage_custom_role_cannot_set_a_default_role() -> None:
    with TestClient(_app(rbac=True)) as c:
        _sso_with_a_linked_super_admin(c)
        made = c.post("/api/roles", json={
            "name": "settings-editor", "grants": {"settings": ["read", "manage"]}})
        assert made.status_code == 200, made.text
        _new_user(c, "eve")
        assert c.put("/api/users/eve/roles", json={"custom_roles": ["settings-editor"]}).status_code == 200
        _login(c, "eve", PW)
        r = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [
            _provider(default_role=MGR)]}})
        assert r.status_code == 403, r.text
        assert _state(c).prefs.sso.providers[0].default_role == T1


def test_b15_a_super_admin_with_a_fresh_sign_in_changes_sso_and_roles_are_checked() -> None:
    with TestClient(_app(rbac=True)) as c:
        _sso_with_a_linked_super_admin(c)
        r = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [
            _provider(default_role=MGR, group_role_map={"soc": "analyst_tier2"})]}})
        assert r.status_code == 200, r.text
        bad = c.put("/api/settings", json={"sso": {"enabled": True, "providers": [
            _provider(default_role="wizard")]}})
        assert bad.status_code == 422
        assert "default_role" in bad.json()["detail"]
        secret = c.post("/api/auth/sso/providers/corp/secret", json={"client_secret": "s"})
        assert secret.status_code == 200, secret.text


# --------------------------------------------------------------------------- #
# B16: single sign-on never links across providers or re-binds a subject
# --------------------------------------------------------------------------- #
def _request(state: AppState) -> Request:
    api = FastAPI()
    api.state.tlsoc = state
    return Request({"type": "http", "method": "GET", "path": "/api/auth/sso/callback",
                    "headers": [], "client": ("192.0.2.10", 443), "query_string": b"",
                    "app": api})


async def _sso_state() -> AppState:
    from app.config import SSOConfig, SSOProvider

    state = await _started_state(rbac=False)
    sso = SSOConfig(enabled=True, providers=[
        SSOProvider(id="corp", type="generic", client_id="a", auto_create_users=True,
                    discovery_url="https://idp.corp.test/.well-known/openid-configuration"),
        SSOProvider(id="other", type="generic", client_id="b", auto_create_users=False,
                    discovery_url="https://idp.other.test/.well-known/openid-configuration"),
    ])
    await state.update_prefs(state.prefs.model_copy(update={"sso": sso}))
    return state


async def test_b16_a_second_provider_cannot_take_over_an_account_by_email() -> None:
    state = await _sso_state()
    try:
        await state.users.create(username="chief@corp.test", password_hash=hash_password(PW),
                                 role=UserRole.SUPER_ADMIN.value)
        await state.users.update("chief@corp.test", oauth_provider="corp", oauth_sub="victim-sub")
        name, refusal = await routes_mod._provision_sso_user(
            state, _request(state), "other",
            {"sub": "attacker-sub", "email": "chief@corp.test", "email_verified": True}, T1)
        assert name is None and refusal and "another provider" in refusal
        stored = await state.users.get("chief@corp.test")
        assert (stored.oauth_provider, stored.oauth_sub) == ("corp", "victim-sub")
    finally:
        await state.shutdown()


async def test_b16_an_existing_subject_is_never_rebound_by_email() -> None:
    state = await _sso_state()
    try:
        await state.users.create(username="ana@corp.test", password_hash=hash_password(PW), role=T1)
        await state.users.update("ana@corp.test", oauth_provider="corp", oauth_sub="ana-sub")
        name, refusal = await routes_mod._provision_sso_user(
            state, _request(state), "corp",
            {"sub": "other-sub", "email": "ana@corp.test", "email_verified": True}, T1)
        assert name is None and refusal and "different subject" in refusal
        assert (await state.users.get("ana@corp.test")).oauth_sub == "ana-sub"
        # The same provider with no subject yet links (an administrator pre-provisioned it).
        await state.users.create(username="bo@corp.test", password_hash=hash_password(PW), role=T1)
        await state.users.update("bo@corp.test", oauth_provider="corp")
        name, refusal = await routes_mod._provision_sso_user(
            state, _request(state), "corp",
            {"sub": "bo-sub", "email": "bo@corp.test", "email_verified": True}, T1)
        assert (name, refusal) == ("bo@corp.test", None)
        assert (await state.users.get("bo@corp.test")).oauth_sub == "bo-sub"
    finally:
        await state.shutdown()


async def test_b15_a_group_map_never_changes_a_super_admins_role() -> None:
    from app.config import SSOConfig, SSOProvider

    state = await _started_state(rbac=False)
    try:
        sso = SSOConfig(enabled=True, providers=[SSOProvider(
            id="corp", type="generic", client_id="a", group_claim="groups",
            group_role_map={"analysts": T1},
            discovery_url="https://idp.corp.test/.well-known/openid-configuration")])
        await state.update_prefs(state.prefs.model_copy(update={"sso": sso}))
        await state.users.create(username="root@corp.test", password_hash=hash_password(PW),
                                 role=UserRole.SUPER_ADMIN.value)
        await state.users.update("root@corp.test", oauth_provider="corp", oauth_sub="root-sub")
        name, _ = await routes_mod._provision_sso_user(
            state, _request(state), "corp",
            {"sub": "root-sub", "email": "root@corp.test", "email_verified": True}, T1)
        assert name == "root@corp.test"
        role = (await state.users.get("root@corp.test")).role
        assert getattr(role, "value", role) == UserRole.SUPER_ADMIN.value
    finally:
        await state.shutdown()


def test_b16_a_generic_idp_cannot_pass_allowed_domains_with_hd() -> None:
    cfg = {"id": "g", "type": "generic", "client_id": "c", "allowed_domains": ["corp.test"],
           "discovery_url": "https://idp.example.test/.well-known/openid-configuration"}
    generic = OidcProvider(cfg)
    asserted = generic.identity_from({"sub": "s", "email": "x@evil.test", "email_verified": True,
                                      "hd": "corp.test"})
    assert asserted["domain"] == "evil.test"
    assert generic.check_allowed(asserted) is not None
    unverified = generic.identity_from({"sub": "s", "email": "x@corp.test"})
    assert generic.check_allowed(unverified) is not None
    google = OidcProvider({**cfg, "type": "google"})
    hosted = google.identity_from({"sub": "s", "email": "x@gmail.com", "hd": "corp.test"})
    assert google.check_allowed(hosted) is None


def test_b16_a_google_account_with_an_unverified_email_has_no_domain() -> None:
    """Without ``hd``, a Google account's domain comes only from a VERIFIED email, as for
    every other provider: a Google account can carry an address it has not proved, and
    that must not pass ``allowed_domains``."""
    google = OidcProvider({
        "id": "g", "type": "google", "client_id": "c", "allowed_domains": ["corp.test"]})
    unverified = google.identity_from({"sub": "s", "email": "x@corp.test"})
    assert unverified["domain"] == ""
    assert google.check_allowed(unverified) is not None
    verified = google.identity_from({"sub": "s", "email": "x@corp.test", "email_verified": True})
    assert verified["domain"] == "corp.test"
    assert google.check_allowed(verified) is None


# --------------------------------------------------------------------------- #
# B51: settings that would save but cannot work answer 422
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("body", "field"), [
    ({"sla": {"timezone": "Mars/Olympus"}}, "sla.timezone"),
    ({"sla": {"timezone": "+99:00"}}, "sla.timezone"),
    ({"sla": {"targets": {"P1": {"response_minutes": 600}}}}, "sla.targets.P1"),
    ({"sla": {"targets": {"P2": {"response_minutes": 90, "resolve_minutes": 60}}}}, "sla.targets.P2"),
    ({"investigate_lookback": "yesterday"}, "investigate_lookback"),
    ({"investigate_lookback": "now"}, "investigate_lookback"),
    ({"investigate_lookback": "now+1d"}, "investigate_lookback"),
])
def test_b51_incoherent_settings_answer_422(body: dict, field: str) -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        before = _state(c).prefs.model_dump(mode="json")
        r = c.put("/api/settings", json=body)
        assert r.status_code == 422, r.text
        assert field in r.json()["detail"]
        after = _state(c).prefs.model_dump(mode="json")
    assert after["sla"] == before["sla"]
    assert after["investigate_lookback"] == before["investigate_lookback"]


@pytest.mark.parametrize("body", [
    {"sla": {"timezone": "Asia/Kolkata"}},
    {"sla": {"timezone": "+05:30"}},
    {"sla": {"timezone": "UTC"}},
    {"sla": {"targets": {"P1": {"response_minutes": 30, "resolve_minutes": 240}}}},
    {"investigate_lookback": "now-7d"},
])
def test_b51_coherent_settings_save(body: dict) -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        assert c.put("/api/settings", json=body).status_code == 200


def test_b51_a_stored_bad_value_still_loads_and_other_saves_work() -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        state = _state(c)
        bad_sla = state.prefs.sla.model_copy(update={"timezone": "Mars/Olympus"})
        c.portal.call(state.update_prefs, state.prefs.model_copy(update={
            "sla": bad_sla, "investigate_lookback": "yesterday"}))
        got = c.get("/api/settings").json()["prefs"]
        assert got["sla"]["timezone"] == "Mars/Olympus"
        assert c.put("/api/settings", json={"rag": {"top_k": 7}}).status_code == 200


# --------------------------------------------------------------------------- #
# B55: personal activity rows carry the friendly event name
# --------------------------------------------------------------------------- #
def test_b55_account_activity_rows_carry_the_event_label() -> None:
    with TestClient(_app(rbac=False)) as c:
        _login(c, *ADMIN)
        rows = c.get("/api/account/activity").json()["activity"]
    login = next(r for r in rows if r.get("action") == "auth.login")
    assert login["event_label"] == "Signed in"
