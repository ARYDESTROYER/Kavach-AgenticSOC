"""Round 12 — "Remember me" end to end (SPEC D14, research/remember-me.md §6).

Covers, over the REAL app router with the auth gate mounted exactly like main.py:

1-2   login without / with remember: the cookie shape (browser-session vs persistent
      Max-Age), the JWT lifetime and ``rm`` claim, the registry row, the audit text.
3-5   server-side eligibility: policy disabled, excluded role, insecure transport
      (non-loopback Host / X-Forwarded-Host, ``allow_insecure_http``, Secure cookie).
6-7   the MFA hop (signed ``rm`` in the pending token, tamper rejection, verify and
      enroll-confirm) and SSO (authorize stores the request, callback honours it).
8-11  remembered limits: ``is_active``, live policy shortening / disabling, the strict
      factory-boundary and deferred-job paths, and the call-site contract (grep).
12    ``/auth/me`` is registry-aware: reason + cookie cleared for revoked /
      idle / absolute / tv-mismatch / an expired token; a session summary when live.
13-16 lazy registration of an ``rm`` token, refresh rotation, step-up, logout.
17-19 the public ``/setup/status`` block, config repair + the prune invariant, and
      that no new public path was added.
"""

from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import PUBLIC_API_PATHS, require_auth
from app.api.routes import router
from app.auth import mfa as mfa_mod
from app.auth.passwords import hash_password
from app.auth.session_limits import (
    MAX_SESSION_TOKEN_SECONDS,
    REMEMBER_MAX_SECONDS,
    SessionLimits,
    effective_roles,
    limits_for_username,
    remember_window_seconds,
    session_limits,
)
from app.auth.tokens import decode, encode
from app.config import Preferences, RememberMePolicy, Secrets, SessionPolicyConfig
from app.constants import SESSIONS_KEY, SESSIONS_NS, UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.stores.sessions import (
    _PRUNE_GRACE_SECONDS,
    SessionStore,
    hash_refresh,
    new_refresh_token,
    new_sid,
)
from app.utils import now_utc

SECRET = "remember-me-secret"
_STATE: dict[str, AppState] = {}
_DAY = 86_400


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _build(
    *,
    base_url: str = "http://localhost",
    remember: dict | None = None,
    session_policy: dict | None = None,
    rbac: bool = False,
    peer: str = "127.0.0.1",
    **secret_overrides,
) -> TestClient:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret=SECRET, **secret_overrides,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac
        for key, value in (session_policy or {}).items():
            setattr(prefs.session_policy, key, value)
        if remember is not None:
            prefs.session_policy.remember_me = RememberMePolicy(**remember)
        await state.update_prefs(prefs)
        await state.users.create(
            username="alice",
            password_hash=hash_password("alice-password"),
            role=UserRole.ANALYST_TIER1.value,
            active=True,
            must_change_password=False,
        )
        await state.refresh_users()
        app.state.tlsoc = state
        _STATE["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(_Peer(api, peer), base_url=base_url)


class _Peer:
    """Present every request as coming from ``peer`` (Starlette's TestClient always
    reports the non-address ``testclient``). The default is a loopback peer — a
    browser on the server itself — so tests opt into a network peer explicitly."""

    def __init__(self, app, peer: str) -> None:
        self.app = app
        self.peer = peer

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            scope = {**scope, "client": (self.peer, 50000)}
        await self.app(scope, receive, send)


def _login(c: TestClient, username: str = "Admin", password: str = "Admin@123", **extra):
    return c.post(
        "/api/auth/login", json={"username": username, "password": password, **extra}
    )


def _session_cookie(resp) -> str:
    for header in resp.headers.get_list("set-cookie"):
        if header.lower().startswith("tlsoc_token="):
            return header
    raise AssertionError(f"no session cookie in {resp.headers.get_list('set-cookie')}")


def _max_age(cookie: str) -> int | None:
    match = re.search(r"max-age=(-?\d+)", cookie, re.IGNORECASE)
    return int(match.group(1)) if match else None


def _is_persistent(cookie: str) -> bool:
    low = cookie.lower()
    return "max-age=" in low or "expires=" in low


def _cleared(resp) -> bool:
    for header in resp.headers.get_list("set-cookie"):
        low = header.lower()
        if low.startswith("tlsoc_token="):
            return (_max_age(header) == 0) or 'tlsoc_token=""' in low
    return False


def _rows():
    return run(_STATE["state"].sessions._load())


def _put_rows(rows) -> None:
    run(_STATE["state"].sessions._kv.put(SESSIONS_NS, SESSIONS_KEY, {"entries": rows}))


def _age_row(sid: str, *, created_hours: float | None = None,
             idle_hours: float | None = None) -> None:
    from datetime import timedelta

    rows = _rows()
    for row in rows:
        if row.get("sid") != sid:
            continue
        if created_hours is not None:
            row["created_at"] = (now_utc() - timedelta(hours=created_hours)).isoformat()
        if idle_hours is not None:
            row["last_active_at"] = (now_utc() - timedelta(hours=idle_hours)).isoformat()
    _put_rows(rows)


def _audit_text(actor: str) -> str:
    rows = run(_STATE["state"].audit.records_for_actor(actor, 100))
    return "\n".join(str(r.get("result_summary") or "") for r in rows)


# --------------------------------------------------------------------------- #
# 1-2  Login: browser-session cookie by default, persistent when remembered
# --------------------------------------------------------------------------- #
def test_1_login_without_remember_is_a_browser_session() -> None:
    with _build() as c:
        r = _login(c)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["remembered"] is False
        assert body["remember_reason"] == "not_requested"
        cookie = _session_cookie(r)
        assert not _is_persistent(cookie), cookie
        assert "httponly" in cookie.lower() and "path=/" in cookie.lower()
        claims = decode(body["token"], SECRET)
        assert claims["exp"] - claims["iat"] == 12 * 3600
        assert "rm" not in claims
        row = run(_STATE["state"].sessions.get(claims["sid"]))
        assert row is not None and row["remember"] is False
        assert row["remember_seconds"] == 0
        assert body["session_expires_at"]


def test_2_login_with_remember_is_persistent_and_bounded() -> None:
    with _build() as c:
        r = _login(c, remember=True)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["remembered"] is True and body["remember_reason"] == "ok"
        cookie = _session_cookie(r)
        assert _max_age(cookie) == _DAY, cookie
        claims = decode(body["token"], SECRET)
        assert claims["exp"] - claims["iat"] == _DAY
        assert claims["rm"] is True
        row = run(_STATE["state"].sessions.get(claims["sid"]))
        assert row["remember"] is True and row["remember_seconds"] == _DAY
        text = _audit_text("Admin")
        assert "login ok (remembered 24h)" in text
        assert "remembered 24h" in text.split("session_create", 1)[1]
        # The persistent cookie keeps the session usable on the next request.
        assert c.get("/api/auth/me").json()["authenticated"] is True


def test_2b_remember_duration_follows_the_policy_preset() -> None:
    with _build(remember={"duration_seconds": 6 * 3600}) as c:
        r = _login(c, remember=True)
        assert _max_age(_session_cookie(r)) == 6 * 3600
        claims = decode(r.json()["token"], SECRET)
        assert claims["exp"] - claims["iat"] == 6 * 3600
        assert "remembered 6h" in _audit_text("Admin")


# --------------------------------------------------------------------------- #
# 3-5  Eligibility is decided by the server
# --------------------------------------------------------------------------- #
def test_3_disabled_policy_refuses_remember() -> None:
    with _build(remember={"enabled": False}) as c:
        r = _login(c, remember=True)
        body = r.json()
        assert body["remembered"] is False and body["remember_reason"] == "disabled"
        assert not _is_persistent(_session_cookie(r))
        assert "rm" not in decode(body["token"], SECRET)


def test_4_excluded_role_refuses_remember() -> None:
    with _build(rbac=True, remember={"excluded_roles": ["analyst_tier1"]}) as c:
        r = _login(c, "alice", "alice-password", remember=True)
        body = r.json()
        assert body["remembered"] is False and body["remember_reason"] == "role_excluded"
        assert not _is_persistent(_session_cookie(r))
        # A role that is not excluded is still remembered.
        c.cookies.clear()
        ok = _login(c, remember=True).json()
        assert ok["remembered"] is True


def test_4b_excluding_super_admin_covers_everyone_while_rbac_is_off() -> None:
    # With RBAC off every principal is effectively super_admin (the server's own
    # back-compat rule), so excluding super_admin must exclude them all.
    with _build(rbac=False, remember={"excluded_roles": ["super_admin"]}) as c:
        body = _login(c, "alice", "alice-password", remember=True).json()
        assert body["remember_reason"] == "role_excluded"


def test_5_insecure_transport_refuses_then_admin_or_tls_allows() -> None:
    with _build(base_url="http://testserver") as c:
        r = _login(c, remember=True)
        body = r.json()
        assert body["remembered"] is False
        assert body["remember_reason"] == "insecure_transport"
        assert not _is_persistent(_session_cookie(r))
        # A forwarded non-loopback host also counts as a network origin.
        c.cookies.clear()
    with _build() as c:
        r = c.post(
            "/api/auth/login",
            json={"username": "Admin", "password": "Admin@123", "remember": True},
            headers={"X-Forwarded-Host": "soc.example.com"},
        )
        assert r.json()["remember_reason"] == "insecure_transport"
    with _build(base_url="http://testserver", remember={"allow_insecure_http": True}) as c:
        assert _login(c, remember=True).json()["remembered"] is True
    with _build(base_url="http://testserver", auth_cookie_secure=True) as c:
        r = _login(c, remember=True)
        assert r.json()["remembered"] is True
        cookie = _session_cookie(r)
        assert "secure" in cookie.lower() and _max_age(cookie) == _DAY


@pytest.mark.parametrize(
    "host,expected",
    [
        ("localhost:5173", True),
        ("127.0.0.1", True),
        ("[::1]:8080", True),
        ("app.localhost", True),
        ("10.0.0.5:8080", False),
        ("soc.example.com", False),
        ("", False),
    ],
)
def test_5b_loopback_host_classification(host: str, expected: bool) -> None:
    from app.api.routes import _host_is_loopback

    assert _host_is_loopback(host) is expected


def test_5c_a_proxied_request_is_never_treated_as_local() -> None:
    """Review finding: a same-host reverse proxy that rewrites ``Host`` to
    127.0.0.1 must not make a remote plain-HTTP browser look local."""
    proxied = {"Host": "127.0.0.1", "X-Forwarded-For": "198.51.100.7",
               "X-Real-IP": "198.51.100.7"}
    with _build(base_url="http://127.0.0.1") as c:
        status = c.get("/api/setup/status", headers=proxied).json()["remember_me"]
        assert status["insecure_blocked"] is True
        r = c.post("/api/auth/login", headers=proxied,
                   json={"username": "Admin", "password": "Admin@123", "remember": True})
        assert r.json()["remember_reason"] == "insecure_transport"
        assert not _is_persistent(_session_cookie(r))
        # Any single forwarding header is enough.
        for name, value in (("X-Real-IP", "127.0.0.1"), ("Forwarded", "for=127.0.0.1"),
                            ("X-Forwarded-Proto", "http")):
            c.cookies.clear()
            out = c.post("/api/auth/login", headers={name: value},
                         json={"username": "Admin", "password": "Admin@123", "remember": True})
            assert out.json()["remember_reason"] == "insecure_transport", name
        # A direct request from this machine keeps Remember me.
        c.cookies.clear()
        assert _login(c, remember=True).json()["remembered"] is True
    # A network peer that sends a loopback Host is still a network peer.
    with _build(base_url="http://localhost", peer="198.51.100.7") as c:
        assert _login(c, remember=True).json()["remember_reason"] == "insecure_transport"
    # Behind TLS with secure cookies, a proxied request is remembered (Secure cookie).
    with _build(base_url="http://127.0.0.1", peer="198.51.100.7",
                auth_cookie_secure=True) as c:
        r = c.post("/api/auth/login", headers=proxied,
                   json={"username": "Admin", "password": "Admin@123", "remember": True})
        assert r.json()["remembered"] is True
        assert "secure" in _session_cookie(r).lower()


# --------------------------------------------------------------------------- #
# 6  MFA: the request rides in the SIGNED pending token
# --------------------------------------------------------------------------- #
_FROZEN_NOW = 1_782_700_000.0 + 15.0


def _enrol_alice_mfa(c: TestClient) -> str:
    login = _login(c, "alice", "alice-password").json()
    hdr = {"Authorization": f"Bearer {login['token']}"}
    setup = c.post("/api/auth/mfa/setup", headers=hdr).json()
    secret = setup["secret"]
    ok = c.post("/api/auth/mfa/confirm", json={"code": mfa_mod.totp(secret, ts=_FROZEN_NOW)},
                headers=hdr)
    assert ok.status_code == 200, ok.text
    c.cookies.clear()
    return secret


def test_6_mfa_carries_signed_remember_and_rejects_tampering(monkeypatch) -> None:
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _FROZEN_NOW)
    with _build() as c:
        secret = _enrol_alice_mfa(c)
        p1_resp = _login(c, "alice", "alice-password", remember=True)
        p1 = p1_resp.json()
        assert p1["requires_mfa"] is True and "token" not in p1
        # Phase 1 never sets a session cookie, remembered or not.
        assert not [h for h in p1_resp.headers.get_list("set-cookie")
                    if h.lower().startswith("tlsoc_token=")]
        pending = p1["pending_token"]
        assert decode(pending, SECRET).get("rm") is True
        state = _STATE["state"]
        assert state.auth.pending_remember(pending) is True

        # A client cannot strip/flip ``rm``: a re-signed-with-the-wrong-key token or
        # a payload edit both fail the signature.
        header, payload, sig = pending.split(".")
        forged = encode({"sub": "alice", "mfa": "pending", "rm": True}, "attacker",
                        expires_in_s=300)
        assert state.auth.pending_remember(forged) is False
        assert state.auth.pending_remember(f"{header}.{payload}x.{sig}") is False
        bad = c.post("/api/auth/mfa/verify", json={"pending_token": forged, "code": "000000"})
        assert bad.status_code == 401

        code = mfa_mod.totp(secret, ts=_FROZEN_NOW + 30)
        p2 = c.post("/api/auth/mfa/verify", json={"pending_token": pending, "code": code})
        assert p2.status_code == 200, p2.text
        body = p2.json()
        assert body["remembered"] is True and body["remember_reason"] == "ok"
        assert _max_age(_session_cookie(p2)) == _DAY
        claims = decode(body["token"], SECRET)
        assert claims["rm"] is True and claims["exp"] - claims["iat"] == _DAY
        assert run(state.sessions.get(claims["sid"]))["remember"] is True

        # Without the box the MFA hop mints a browser-session cookie.
        c.cookies.clear()
        p1b = _login(c, "alice", "alice-password").json()
        assert state.auth.pending_remember(p1b["pending_token"]) is False
        code_b = mfa_mod.totp(secret, ts=_FROZEN_NOW + 60)
        monkeypatch.setattr(mfa_mod.time, "time", lambda: _FROZEN_NOW + 60)
        p2b = c.post("/api/auth/mfa/verify",
                     json={"pending_token": p1b["pending_token"], "code": code_b})
        assert p2b.status_code == 200, p2b.text
        assert p2b.json()["remembered"] is False
        assert not _is_persistent(_session_cookie(p2b))


def test_6b_mfa_enroll_confirm_honours_the_signed_request(monkeypatch) -> None:
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _FROZEN_NOW)
    with _build(rbac=True) as c:
        state = _STATE["state"]
        run(state.users.update("alice", mfa_required=True))
        run(state.refresh_users())
        p1 = _login(c, "alice", "alice-password", remember=True).json()
        assert p1.get("mfa_enrollment_required") is True
        pending = p1["pending_token"]
        setup = c.post("/api/auth/mfa/enroll-setup", json={"pending_token": pending}).json()
        code = mfa_mod.totp(setup["secret"], ts=_FROZEN_NOW)
        done = c.post("/api/auth/mfa/enroll-confirm",
                      json={"pending_token": pending, "code": code})
        assert done.status_code == 200, done.text
        assert done.json()["remembered"] is True
        assert _max_age(_session_cookie(done)) == _DAY


def test_6c_mfa_remember_is_redecided_against_the_live_policy(monkeypatch) -> None:
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _FROZEN_NOW)
    with _build() as c:
        secret = _enrol_alice_mfa(c)
        pending = _login(c, "alice", "alice-password", remember=True).json()["pending_token"]
        # The admin turns Remember me off between the two factors.
        _STATE["state"].prefs.session_policy.remember_me.enabled = False
        code = mfa_mod.totp(secret, ts=_FROZEN_NOW + 30)
        p2 = c.post("/api/auth/mfa/verify", json={"pending_token": pending, "code": code})
        assert p2.status_code == 200
        assert p2.json()["remember_reason"] == "disabled"
        assert not _is_persistent(_session_cookie(p2))


# --------------------------------------------------------------------------- #
# 7  SSO: the request is bound to the single-use state
# --------------------------------------------------------------------------- #
def test_7_sso_authorize_stores_remember_and_callback_honours_it(monkeypatch) -> None:
    from app.auth import oidc
    from app.config import SSOConfig, SSOProvider

    discovery = {
        "issuer": "https://idp.example.com",
        "authorization_endpoint": "https://idp.example.com/authorize",
        "token_endpoint": "https://idp.example.com/token",
        "userinfo_endpoint": "https://idp.example.com/userinfo",
    }
    claims = {"sub": "s-1", "email": "bob@corp.com", "email_verified": True}

    async def fake_get_json(url, *, headers=None):
        return dict(discovery) if "well-known" in url else dict(claims)

    async def fake_post_form(url, form):
        return {"access_token": "at", "token_type": "Bearer"}

    monkeypatch.setattr(oidc, "_http_get_json", fake_get_json)
    monkeypatch.setattr(oidc, "_http_post_form", fake_post_form)
    oidc._DISCOVERY_CACHE.clear()
    with _build() as c:
        state = _STATE["state"]
        state.secrets.set_sso_client_secret("corp", "client-secret")
        state.prefs.sso = SSOConfig(enabled=True, providers=[SSOProvider(
            id="corp", type="generic", client_id="cid",
            discovery_url="https://idp.example.com/.well-known/openid-configuration",
            auto_create_users=True, default_role="analyst_tier1",
        )])
        for remember, persistent in ((True, True), (False, False)):
            c.cookies.clear()
            out = c.get("/api/auth/sso/authorize", params={
                "provider": "corp", **({"remember": "1"} if remember else {}),
            })
            assert out.status_code == 200, out.text
            st = re.search(r"state=([^&]+)", out.json()["auth_url"]).group(1)
            rec = run(state.oidc_state.consume(st))
            assert rec is not None and rec["remember"] is remember
            run(state.oidc_state.stash(st, rec))  # put it back for the callback
            resp = c.get(f"/api/auth/sso/callback?code=abc&state={st}", follow_redirects=False)
            assert resp.status_code == 302, resp.text
            assert resp.headers["location"] == "/"
            assert _is_persistent(_session_cookie(resp)) is persistent
        oidc._DISCOVERY_CACHE.clear()


def test_7b_sso_refusal_is_reported_on_the_landing_url(monkeypatch) -> None:
    from app.auth import oidc
    from app.config import SSOConfig, SSOProvider

    discovery = {
        "issuer": "https://idp.example.com",
        "authorization_endpoint": "https://idp.example.com/authorize",
        "token_endpoint": "https://idp.example.com/token",
        "userinfo_endpoint": "https://idp.example.com/userinfo",
    }

    async def fake_get_json(url, *, headers=None):
        if "well-known" in url:
            return dict(discovery)
        return {"sub": "s-2", "email": "eve@corp.com", "email_verified": True}

    async def fake_post_form(url, form):
        return {"access_token": "at"}

    monkeypatch.setattr(oidc, "_http_get_json", fake_get_json)
    monkeypatch.setattr(oidc, "_http_post_form", fake_post_form)
    oidc._DISCOVERY_CACHE.clear()
    with _build(base_url="http://testserver") as c:
        state = _STATE["state"]
        state.secrets.set_sso_client_secret("corp", "client-secret")
        state.prefs.sso = SSOConfig(enabled=True, providers=[SSOProvider(
            id="corp", type="generic", client_id="cid",
            discovery_url="https://idp.example.com/.well-known/openid-configuration",
            auto_create_users=True, default_role="analyst_tier1",
        )])
        out = c.get("/api/auth/sso/authorize", params={"provider": "corp", "remember": "1"})
        st = re.search(r"state=([^&]+)", out.json()["auth_url"]).group(1)
        resp = c.get(f"/api/auth/sso/callback?code=abc&state={st}", follow_redirects=False)
        assert resp.status_code == 302
        assert resp.headers["location"] == "/?remember_refused=insecure_transport"
        assert not _is_persistent(_session_cookie(resp))
        oidc._DISCOVERY_CACHE.clear()


# --------------------------------------------------------------------------- #
# 8-11  Remembered limits everywhere
# --------------------------------------------------------------------------- #
def _row(*, remember: bool, created_hours: float, idle_hours: float = 0.0) -> dict:
    from datetime import timedelta

    now = now_utc()
    return {
        "sid": "s",
        "remember": remember,
        "created_at": (now - timedelta(hours=created_hours)).isoformat(),
        "last_active_at": (now - timedelta(hours=idle_hours)).isoformat(),
    }


def test_8_is_active_uses_the_remembered_pair_for_remembered_rows() -> None:
    limits = SessionLimits(idle=3600, absolute=12 * 3600,
                           remember_idle=_DAY, remember_absolute=_DAY)
    # 13 h old: past the standard absolute, inside the remembered one.
    assert SessionStore.is_active(_row(remember=True, created_hours=13, idle_hours=5),
                                  **limits.kwargs()) is None
    assert SessionStore.is_active(_row(remember=False, created_hours=13),
                                  **limits.kwargs()) == "absolute_expired"
    # 25 h old remembered → absolute.
    assert SessionStore.is_active(_row(remember=True, created_hours=25),
                                  **limits.kwargs()) == "absolute_expired"
    # Remembered idle applies when set.
    idle_limits = SessionLimits(idle=3600, absolute=12 * 3600,
                                remember_idle=2 * 3600, remember_absolute=_DAY)
    assert SessionStore.is_active(_row(remember=True, created_hours=4, idle_hours=3),
                                  **idle_limits.kwargs()) == "idle_expired"
    # A caller without remembered limits judges every row by the standard pair.
    assert SessionStore.is_active(_row(remember=True, created_hours=13),
                                  idle_timeout=3600,
                                  absolute_lifetime=12 * 3600) == "absolute_expired"


def test_8b_session_limits_builder() -> None:
    policy = SessionPolicyConfig()
    lim = session_limits(policy, roles=None)
    # Defaults: 24 h remembered window; no separate remembered inactivity limit, so
    # the STANDARD idle timeout (12 h) applies to remembered sessions too.
    assert (lim.remember_absolute, lim.remember_idle) == (_DAY, 12 * 3600)
    policy.remember_me.idle_seconds = 3600
    assert session_limits(policy, roles=None).remember_idle == 3600
    # An explicit remembered inactivity limit is the admin's own choice and may be
    # longer than the standard one (bounded by the remembered window).
    policy.remember_me.idle_seconds = 20 * 3600
    assert session_limits(policy, roles=None).remember_idle == 20 * 3600
    policy.remember_me.enabled = False
    lim_off = session_limits(policy, roles=None)
    assert lim_off.remember_absolute == 0 and not lim_off.remember_enabled
    assert session_limits(None, roles=None) == SessionLimits()


def test_8c_remembered_limits_are_never_looser_than_the_standard_policy() -> None:
    # A hardened deployment: 15-minute inactivity, 8-hour absolute lifetime. The
    # default Remember me policy (24 h, no separate idle) must not loosen either.
    policy = SessionPolicyConfig(idle_timeout=900, absolute_lifetime=8 * 3600)
    lim = session_limits(policy, roles=None)
    assert lim.remember_absolute == 8 * 3600
    assert lim.remember_idle == 900
    assert remember_window_seconds(policy) == 8 * 3600
    # Exclusion is applied per principal.
    policy.remember_me.excluded_roles = ["super_admin"]
    assert session_limits(policy, roles=["SUPER_ADMIN"]).remember_enabled is False
    assert session_limits(policy, roles=["analyst_tier1"]).remember_enabled is True
    prefs = Preferences.model_validate({})
    prefs.rbac.enabled = False
    # RBAC off: every principal is effectively super_admin.
    assert "super_admin" in effective_roles(prefs, "analyst_tier1")
    prefs.rbac.enabled = True
    assert effective_roles(prefs, "analyst_tier1") == frozenset({"analyst_tier1"})


def test_8d_upgrade_with_a_stricter_stored_policy_keeps_it() -> None:
    """Review finding: a remembered session must never outlast the admin's idle
    timeout or absolute lifetime unless the admin chose remember-specific values."""
    with _build(session_policy={"idle_timeout": 900, "absolute_lifetime": 8 * 3600}) as c:
        r = _login(c, remember=True)
        body = r.json()
        assert body["remembered"] is True
        # The cookie and token never outlive the 8-hour absolute lifetime.
        assert _max_age(_session_cookie(r)) == 8 * 3600
        claims = decode(body["token"], SECRET)
        assert claims["exp"] - claims["iat"] == 8 * 3600
        assert c.get("/api/setup/status").json()["remember_me"]["duration_seconds"] == 8 * 3600
        hdr = {"Authorization": f"Bearer {body['token']}"}
        # Idle for 2 hours: past the 15-minute inactivity limit → ended.
        _age_row(claims["sid"], created_hours=2, idle_hours=2)
        out = c.get("/api/cases", headers=hdr)
        assert out.status_code == 401
        assert out.json()["detail"]["reason"] == "idle_expired"
        me = c.get("/api/auth/me")
        assert me.json()["reason"] == "idle_expired" and _cleared(me)


def test_9_shortening_and_disabling_the_policy_applies_to_live_sessions() -> None:
    with _build(session_policy={"idle_timeout": 3600},
                remember={"idle_seconds": 3 * 3600}) as c:
        state = _STATE["state"]
        token = _login(c, remember=True).json()["token"]
        sid = decode(token, SECRET)["sid"]
        hdr = {"Authorization": f"Bearer {token}"}
        _age_row(sid, created_hours=8, idle_hours=2)
        # 8 h old, idle 2 h: fine under the 24 h remembered policy (with its own 3 h
        # inactivity limit) even though the standard idle limit (1 h) has passed.
        assert c.get("/api/cases", headers=hdr).status_code == 200
        _age_row(sid, created_hours=8, idle_hours=2)
        # Shorten 24 h → 6 h: the 8 h-old remembered session ends on its next request.
        state.prefs.session_policy.remember_me.duration_seconds = 6 * 3600
        out = c.get("/api/cases", headers=hdr)
        assert out.status_code == 401
        assert out.json()["detail"] == {"code": "session_expired", "reason": "absolute_expired"}
        # Disable remember: a remembered row falls back to the STANDARD limits.
        state.prefs.session_policy.remember_me.duration_seconds = _DAY
        token2 = _login(c, remember=True).json()["token"]
        sid2 = decode(token2, SECRET)["sid"]
        hdr2 = {"Authorization": f"Bearer {token2}"}
        _age_row(sid2, idle_hours=2)
        state.prefs.session_policy.remember_me.enabled = False
        out2 = c.get("/api/cases", headers=hdr2)
        assert out2.status_code == 401
        assert out2.json()["detail"]["reason"] == "idle_expired"


def test_9c_excluding_a_role_applies_to_live_remembered_sessions() -> None:
    """Review finding: ``excluded_roles`` is re-checked on every evaluation."""
    with _build(rbac=True, session_policy={"idle_timeout": 3600},
                remember={"idle_seconds": 6 * 3600}) as c:
        state = _STATE["state"]
        r = _login(c, "alice", "alice-password", remember=True)
        assert r.json()["remembered"] is True
        sid = decode(r.json()["token"], SECRET)["sid"]
        _age_row(sid, idle_hours=2)
        # Remembered (6 h inactivity): still signed in after 2 idle hours.
        assert c.get("/api/auth/me").json()["authenticated"] is True
        _age_row(sid, idle_hours=2)
        # The admin now excludes the role: the session is judged by the standard
        # 1-hour inactivity limit on its very next request.
        state.prefs.session_policy.remember_me.excluded_roles = ["analyst_tier1"]
        ended = c.get("/api/auth/me")
        assert ended.json()["reason"] == "idle_expired" and _cleared(ended)

    # Promotion INTO an excluded role.
    with _build(rbac=True, session_policy={"idle_timeout": 3600},
                remember={"idle_seconds": 6 * 3600, "excluded_roles": ["super_admin"]}) as c:
        state = _STATE["state"]
        r = _login(c, "alice", "alice-password", remember=True)
        assert r.json()["remembered"] is True
        sid = decode(r.json()["token"], SECRET)["sid"]
        _age_row(sid, idle_hours=2)
        assert c.get("/api/auth/me").json()["authenticated"] is True
        _age_row(sid, idle_hours=2)
        run(state.users.update("alice", role=UserRole.SUPER_ADMIN.value))
        run(state.refresh_users())
        ended = c.get("/api/auth/me").json()
        assert ended["authenticated"] is False and ended["reason"] == "idle_expired"


def test_9d_an_excluded_session_loses_its_persistent_cookie() -> None:
    with _build(rbac=True) as c:
        state = _STATE["state"]
        r = _login(c, "alice", "alice-password", remember=True)
        assert _max_age(_session_cookie(r)) == _DAY
        state.prefs.session_policy.remember_me.excluded_roles = ["analyst_tier1"]
        me = c.get("/api/auth/me")
        body = me.json()
        assert body["authenticated"] is True and body["session"]["remember"] is False
        # The console's next load turns the cookie into a browser-session cookie.
        cookie = _session_cookie(me)
        assert not _is_persistent(cookie) and "httponly" in cookie.lower()
        rows = c.get("/api/sessions").json()["sessions"]
        assert rows[0]["remember"] is False and rows[0]["remember_seconds"] == 0
        # Turning Remember me off behaves the same way.
        state.prefs.session_policy.remember_me.excluded_roles = []
        assert c.get("/api/sessions").json()["sessions"][0]["remember"] is True
        state.prefs.session_policy.remember_me.enabled = False
        assert c.get("/api/auth/me").json()["session"]["remember"] is False
        # A session that is still remembered gets no cookie rewrite.
        state.prefs.session_policy.remember_me.enabled = True
        again = c.get("/api/auth/me")
        assert again.json()["session"]["remember"] is True
        assert not [h for h in again.headers.get_list("set-cookie")
                    if h.lower().startswith("tlsoc_token=")]


def test_9e_deferred_and_refresh_paths_resolve_the_live_role() -> None:
    with _build(rbac=True, remember={"excluded_roles": ["super_admin"]}) as c:
        state = _STATE["state"]
        assert limits_for_username(state, "alice").remember_enabled is True
        assert limits_for_username(state, "Admin").remember_enabled is False
        # An unknown principal is never remembered (fail closed).
        assert limits_for_username(state, "nobody").remember_enabled is False
        # Refresh on a remembered row of a now-excluded user mints a standard
        # (browser-session) token.
        sid, rtok = new_sid(), new_refresh_token()
        run(state.sessions.create(sid=sid, username="Admin", refresh_hash=hash_refresh(rtok),
                                  remember=True, remember_seconds=_DAY,
                                  idle_timeout=_DAY, absolute_lifetime=_DAY))
        out = c.post("/api/auth/refresh", json={"refresh_token": rtok})
        assert out.status_code == 200, out.text
        assert "rm" not in decode(out.json()["token"], SECRET)
        assert not _is_persistent(_session_cookie(out))


def test_9f_a_no_longer_remembered_session_ends_where_a_standard_sign_in_would() -> None:
    """Round 12 final review (L1): turning Remember me off, or excluding the role,
    judges a live remembered session as a STANDARD sign-in — which ends with its 12 h
    access token — instead of letting its 24 h token run on under the looser 30-day
    registry pair."""
    from datetime import datetime

    with _build(rbac=True) as c:
        state = _STATE["state"]
        assert state.auth.token_seconds == 12 * 3600
        for change in ("disable", "exclude"):
            state.prefs.session_policy.remember_me.enabled = True
            state.prefs.session_policy.remember_me.excluded_roles = []
            r = _login(c, "alice", "alice-password", remember=True)
            assert r.json()["remembered"] is True
            token = r.json()["token"]
            claims = decode(token, SECRET)
            assert claims["exp"] - claims["iat"] == _DAY
            hdr = {"Authorization": f"Bearer {token}"}
            _age_row(claims["sid"], created_hours=13, idle_hours=0)
            # Still remembered: 13 h into a 24 h session is fine.
            assert c.get("/api/cases", headers=hdr).status_code == 200
            if change == "disable":
                state.prefs.session_policy.remember_me.enabled = False
            else:
                state.prefs.session_policy.remember_me.excluded_roles = ["analyst_tier1"]
            out = c.get("/api/cases", headers=hdr)
            assert out.status_code == 401, change
            assert out.json()["detail"] == {"code": "session_expired", "reason": "absolute_expired"}
            me = c.get("/api/auth/me", headers=hdr).json()
            assert me["authenticated"] is False and me["reason"] == "absolute_expired"
        # Younger than the standard token lifetime: it keeps working, as a standard
        # session (its listing shows it ends at the 12 h mark, not the 24 h one).
        state.prefs.session_policy.remember_me.enabled = True
        state.prefs.session_policy.remember_me.excluded_roles = []
        r = _login(c, "alice", "alice-password", remember=True)
        assert r.json()["remembered"] is True
        token = r.json()["token"]
        sid = decode(token, SECRET)["sid"]
        _age_row(sid, created_hours=2, idle_hours=0)
        state.prefs.session_policy.remember_me.enabled = False
        hdr = {"Authorization": f"Bearer {token}"}
        assert c.get("/api/cases", headers=hdr).status_code == 200
        row = next(r for r in c.get("/api/sessions", headers=hdr).json()["sessions"] if r["sid"] == sid)
        created = datetime.fromisoformat(row["created_at"])
        hard = datetime.fromisoformat(row["effective_absolute_expires_at"])
        assert abs((hard - created).total_seconds() - 12 * 3600) < 5
        assert row["remember"] is False


def test_9g_turning_remember_me_off_never_loosens_its_own_inactivity_limit() -> None:
    """The administrator's explicit remembered inactivity limit (1 h, stricter than
    the 12 h standard one) still ends an idle session after the feature is turned
    off, and for an excluded role."""
    for change in ("disable", "exclude"):
        with _build(rbac=True, remember={"idle_seconds": 3600}) as c:
            state = _STATE["state"]
            r = _login(c, "alice", "alice-password", remember=True)
            token = r.json()["token"]
            sid = decode(token, SECRET)["sid"]
            hdr = {"Authorization": f"Bearer {token}"}
            _age_row(sid, created_hours=3, idle_hours=2)
            assert c.get("/api/cases", headers=hdr).json()["detail"]["reason"] == "idle_expired"
            r = _login(c, "alice", "alice-password", remember=True)
            token = r.json()["token"]
            sid = decode(token, SECRET)["sid"]
            hdr = {"Authorization": f"Bearer {token}"}
            _age_row(sid, created_hours=3, idle_hours=2)
            if change == "disable":
                state.prefs.session_policy.remember_me.enabled = False
            else:
                state.prefs.session_policy.remember_me.excluded_roles = ["analyst_tier1"]
            out = c.get("/api/cases", headers=hdr)
            assert out.status_code == 401, change
            assert out.json()["detail"]["reason"] == "idle_expired"


def test_9h_the_fallback_rule_is_the_same_in_the_builder_and_the_store() -> None:
    from datetime import datetime, timedelta

    policy = SessionPolicyConfig()                         # 12 h idle, 30-day absolute
    policy.remember_me.idle_seconds = 3600
    policy.remember_me.enabled = False
    lim = session_limits(policy, roles=None, token_seconds=12 * 3600)
    assert (lim.fallback_idle, lim.fallback_absolute) == (3600, 12 * 3600)
    remembered = {"remember": True}
    standard = {"remember": False}
    assert lim.for_row(remembered) == (3600, 12 * 3600)
    assert lim.for_row(standard) == (12 * 3600, 30 * _DAY)
    assert SessionStore.limits_for_row(remembered, **lim.kwargs()) == lim.for_row(remembered)
    assert SessionStore.limits_for_row(standard, **lim.kwargs()) == lim.for_row(standard)
    # A stricter standard limit still wins; an unset one never loosens the other.
    tight = SessionPolicyConfig(idle_timeout=900, absolute_lifetime=8 * 3600)
    tight.remember_me.enabled = False
    lim_tight = session_limits(tight, roles=None, token_seconds=12 * 3600)
    assert lim_tight.for_row(remembered) == (900, 8 * 3600)
    # Excluded by role: the same fallback (the remembered pair is dropped).
    policy.remember_me.enabled = True
    policy.remember_me.excluded_roles = ["analyst_tier1"]
    excluded = session_limits(policy, roles=["analyst_tier1"], token_seconds=12 * 3600)
    assert not excluded.remember_enabled and excluded.for_row(remembered) == (3600, 12 * 3600)
    # Still remembered: the fallback never applies.
    kept = session_limits(policy, roles=["responder"], token_seconds=12 * 3600)
    assert kept.for_row(remembered) == (3600, _DAY)
    now = now_utc()
    row = {"sid": "s", "remember": True, "created_at": (now - timedelta(hours=13)).isoformat(),
           "last_active_at": now.isoformat()}
    assert SessionStore.is_active(row, **kept.kwargs()) is None
    assert SessionStore.is_active(row, **excluded.kwargs()) == "absolute_expired"
    assert SessionStore.effective_expiry(row, **excluded.kwargs())[0] == (
        datetime.fromisoformat(row["created_at"]) + timedelta(hours=12)
    ).isoformat()


def test_10_strict_paths_honour_the_remembered_limits() -> None:
    from datetime import timedelta

    store = SessionStore(_KV())
    sid = new_sid()
    created = (now_utc() - timedelta(hours=13)).isoformat()
    row = {**SessionStore._blank_row(sid, "Admin"), "remember": True,
           "remember_seconds": _DAY, "created_at": created,
           "last_authn_at": now_utc().isoformat()}
    run(store._kv.put(SESSIONS_NS, SESSIONS_KEY, {"entries": [row]}))
    std = dict(idle_timeout=43_200, absolute_lifetime=12 * 3600)
    rem = dict(std, remember_idle=_DAY, remember_absolute=_DAY)
    assert run(store.strict_request_authority(sid=sid, username="Admin", token_version=0,
                                              **std)) == "absolute_expired"
    assert run(store.strict_request_authority(sid=sid, username="Admin", token_version=0,
                                              **rem)) is None
    assert run(store.strict_deferred_authority_expires_at(
        sid=sid, username="Admin", token_version=0, sudo_window=600, **std)) is None
    assert run(store.strict_deferred_authority_expires_at(
        sid=sid, username="Admin", token_version=0, sudo_window=600, **rem)) is not None
    assert run(store.strict_deferred_authority(
        sid=sid, username="Admin", token_version=0, sudo_window=600, **rem)) is True


class _KV:
    """A tiny in-memory KV with the strict getter the factory paths use."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict] = {}

    async def get(self, ns, key):
        return self.docs.get((ns, key))

    async def get_strict(self, ns, key):
        return self.docs.get((ns, key))

    async def put(self, ns, key, value):
        self.docs[(ns, key)] = value


_EVALUATOR = re.compile(
    r"\.(is_active|strict_request_authority|strict_deferred_authority"
    r"|strict_deferred_authority_expires_at)\("
)


def test_11_every_registry_evaluator_call_passes_the_remembered_limits() -> None:
    """Contract: a call site that evaluates a session row must pass the remembered
    limits (``remember_absolute=`` or a ``**...kwargs()`` built by session_limits),
    or a remembered session would be judged by the wrong pair there."""
    app_dir = Path(__file__).resolve().parents[1] / "app"
    offenders: list[str] = []
    for path in app_dir.rglob("*.py"):
        if path.name == "sessions.py" and path.parent.name == "stores":
            continue  # the evaluator itself (its internal delegation is unit-tested)
        text = path.read_text(encoding="utf-8")
        for match in _EVALUATOR.finditer(text):
            # Read the call's argument list up to the balancing parenthesis.
            depth, i = 1, match.end()
            while i < len(text) and depth:
                depth += {"(": 1, ")": -1}.get(text[i], 0)
                i += 1
            args = text[match.end(): i]
            if "remember_absolute" not in args and ".kwargs()" not in args:
                line = text.count("\n", 0, match.start()) + 1
                offenders.append(f"{path.relative_to(app_dir)}:{line}")
    assert not offenders, f"call sites without remembered limits: {offenders}"


def test_11b_row_evaluators_resolve_the_principal_role() -> None:
    """Contract: limits that judge a row are built for a principal (so an excluded
    role is honoured everywhere). Only the policy module itself may call the
    role-agnostic builder, and ``live_session_limits`` always gets a principal."""
    app_dir = Path(__file__).resolve().parents[1] / "app"
    bare: list[str] = []
    no_principal: list[str] = []
    for path in app_dir.rglob("*.py"):
        if path.name == "session_limits.py" and path.parent.name == "auth":
            continue
        text = path.read_text(encoding="utf-8")
        rel = str(path.relative_to(app_dir))
        for match in re.finditer(r"(?<![\w.])session_limits\(", text):
            bare.append(f"{rel}:{text.count(chr(10), 0, match.start()) + 1}")
        for match in re.finditer(r"live_session_limits\(([^)]*)\)", text):
            if text[max(0, match.start() - 4):match.start()] == "def ":
                continue
            if "," not in match.group(1):
                no_principal.append(f"{rel}:{text.count(chr(10), 0, match.start()) + 1}")
    assert not bare, f"role-agnostic session_limits() used to judge rows: {bare}"
    assert not no_principal, f"live_session_limits() without a principal: {no_principal}"


# --------------------------------------------------------------------------- #
# 12  /auth/me is registry-aware
# --------------------------------------------------------------------------- #
def test_12_auth_me_reports_why_a_session_ended_and_clears_the_cookie() -> None:
    with _build() as c:
        state = _STATE["state"]
        r = _login(c, remember=True)
        sid = decode(r.json()["token"], SECRET)["sid"]
        me = c.get("/api/auth/me").json()
        assert me["authenticated"] is True
        assert me["session"]["remember"] is True and me["session"]["expires_at"]
        # revoked
        run(state.sessions.revoke(sid, by="test", reason="t"))
        assert c.get("/api/cases").status_code == 401
        ended = c.get("/api/auth/me")
        body = ended.json()
        assert body["authenticated"] is False and body["reason"] == "revoked"
        assert body["user"] is None and _cleared(ended)

    # idle_expired
    with _build(remember={"idle_seconds": 3600}) as c:
        sid = decode(_login(c, remember=True).json()["token"], SECRET)["sid"]
        _age_row(sid, idle_hours=2)
        ended = c.get("/api/auth/me")
        assert ended.json()["reason"] == "idle_expired" and _cleared(ended)
        assert ended.json()["lifetime_seconds"] == 3600

    # absolute_expired (registry) — the remembered duration was shortened
    with _build() as c:
        state = _STATE["state"]
        sid = decode(_login(c, remember=True).json()["token"], SECRET)["sid"]
        _age_row(sid, created_hours=7)
        state.prefs.session_policy.remember_me.duration_seconds = 6 * 3600
        ended = c.get("/api/auth/me").json()
        assert ended["reason"] == "absolute_expired"
        assert ended["lifetime_seconds"] == 6 * 3600 and ended["remembered"] is True

    # tv_mismatch (revoke-all)
    with _build() as c:
        state = _STATE["state"]
        _login(c)
        run(state.sessions.revoke_all("Admin", by="test"))
        ended = c.get("/api/auth/me")
        assert ended.json()["reason"] == "tv_mismatch" and _cleared(ended)


def test_12d_signing_out_this_device_is_not_reported_as_ended_elsewhere() -> None:
    with _build() as c:
        state = _STATE["state"]
        sid = decode(_login(c).json()["token"], SECRET)["sid"]
        assert c.post(f"/api/sessions/{sid}/revoke").status_code == 200
        out = c.get("/api/auth/me")
        body = out.json()
        assert body["authenticated"] is False and "reason" not in body and _cleared(out)
        assert run(state.sessions.get(sid))["revoke_reason"] == "self_signout"
        # Revoking ANOTHER of my sessions from here is reported to that device.
        c.cookies.clear()
        other = decode(_login(c).json()["token"], SECRET)["sid"]
        c.cookies.clear()
        here = _login(c).json()["token"]
        assert c.post(f"/api/sessions/{other}/revoke").status_code == 200
        assert run(state.sessions.get(other))["revoke_reason"] == "user_revoke"
        c.cookies.clear()
        token_other = encode(
            {k: v for k, v in run(_other_claims(state, other)).items()}, SECRET,
            expires_in_s=3600,
        )
        ended = c.get("/api/auth/me", cookies={"tlsoc_token": token_other}).json()
        assert ended["reason"] == "revoked"
        assert c.get("/api/auth/me", headers={"Authorization": f"Bearer {here}"}).json()[
            "authenticated"
        ] is True


async def _other_claims(state, sid: str) -> dict:
    row = await state.sessions.get(sid)
    return {"sub": row["username"], "role": "super_admin", "mc": False, "sid": sid,
            "tv": int(row.get("token_version", 0))}


def test_12b_auth_me_explains_an_expired_token() -> None:
    with _build() as c:
        state = _STATE["state"]
        claims = decode(_login(c, remember=True).json()["token"], SECRET)
        # Re-sign the same session with an exp in the past (what the browser holds
        # when the tab outlived the remembered window).
        expired = encode({k: v for k, v in claims.items() if k not in ("iat", "exp")},
                         SECRET, expires_in_s=-1)
        c.cookies.clear()
        c.cookies.set("tlsoc_token", expired)
        ended = c.get("/api/auth/me")
        body = ended.json()
        assert body["authenticated"] is False and body["reason"] == "absolute_expired"
        assert body["remembered"] is True and _cleared(ended)
        # A garbage cookie is cleared without a reason; auth-off is unchanged.
        c.cookies.clear()
        c.cookies.set("tlsoc_token", "not-a-token")
        junk = c.get("/api/auth/me")
        assert "reason" not in junk.json() and _cleared(junk)
        assert state.auth.expired_session_claims("not-a-token") is None


def test_12c_auth_me_auth_off_is_unchanged() -> None:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None, auth_enabled=False)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides={"mock": MockProvider()})
        await state.startup(start_poller=False)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    with TestClient(api, base_url="http://localhost") as c:
        assert c.get("/api/auth/me").json() == {
            "authenticated": True, "auth_enabled": False, "user": None,
        }
        status = c.get("/api/setup/status").json()
        assert set(status["remember_me"]) == _STATUS_KEYS


# --------------------------------------------------------------------------- #
# 13-16  Lazy registration, refresh, step-up, logout
# --------------------------------------------------------------------------- #
def test_13_lazy_registration_keeps_the_remember_claim() -> None:
    with _build() as c:
        state = _STATE["state"]
        token, principal = state.auth.mint_session("Admin", remember_seconds=_DAY)
        assert principal.remember is True
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {token}"}).status_code == 200
        row = run(state.sessions.get(principal.sid))
        assert row["remember"] is True and row["remember_seconds"] == _DAY
        assert "(remembered)" in _audit_text("Admin")
        # The remember lifetime is capped at 24 h whatever a caller asks for.
        long_token, _ = state.auth.mint_session("Admin", remember_seconds=30 * _DAY)
        cl = decode(long_token, SECRET)
        assert cl["exp"] - cl["iat"] == REMEMBER_MAX_SECONDS


def test_14_refresh_rotation_preserves_remember_and_never_extends_it() -> None:
    with _build() as c:
        state = _STATE["state"]
        sid = new_sid()
        rtok = new_refresh_token()
        run(state.sessions.create(sid=sid, username="Admin", refresh_hash=hash_refresh(rtok),
                                  remember=True, remember_seconds=_DAY,
                                  idle_timeout=_DAY, absolute_lifetime=_DAY))
        _age_row(sid, created_hours=10)
        r = c.post("/api/auth/refresh", json={"refresh_token": rtok})
        assert r.status_code == 200, r.text
        claims = decode(r.json()["token"], SECRET)
        assert claims["rm"] is True
        lifetime = claims["exp"] - claims["iat"]
        assert 13 * 3600 <= lifetime <= 14 * 3600 + 5  # the remaining ~14 h, not 24 h
        assert _max_age(_session_cookie(r)) == lifetime
        row = run(state.sessions.get(claims["sid"]))
        assert row["remember"] is True
        # A standard (not remembered) row refreshes into a browser-session cookie.
        sid2, rtok2 = new_sid(), new_refresh_token()
        run(state.sessions.create(sid=sid2, username="Admin", refresh_hash=hash_refresh(rtok2)))
        r2 = c.post("/api/auth/refresh", json={"refresh_token": rtok2})
        assert r2.status_code == 200
        assert not _is_persistent(_session_cookie(r2))
        assert "rm" not in decode(r2.json()["token"], SECRET)


def test_15_step_up_still_applies_inside_a_remembered_session() -> None:
    with _build() as c:
        state = _STATE["state"]
        token = _login(c, remember=True).json()["token"]
        sid = decode(token, SECRET)["sid"]
        rows = _rows()
        for row in rows:
            if row.get("sid") == sid:
                row["last_authn_at"] = "2000-01-01T00:00:00+00:00"
        _put_rows(rows)
        other = new_sid()
        run(state.sessions.create(sid=other, username="alice"))
        out = c.post(f"/api/admin/sessions/{other}/revoke")
        assert out.status_code == 401
        assert out.json()["detail"]["code"] == "reauth_required"


def test_16_logout_revokes_and_clears_the_cookie_with_matching_attributes() -> None:
    with _build() as c:
        state = _STATE["state"]
        sid = decode(_login(c, remember=True).json()["token"], SECRET)["sid"]
        out = c.post("/api/auth/logout")
        assert out.status_code == 200
        header = next(h for h in out.headers.get_list("set-cookie")
                      if h.lower().startswith("tlsoc_token="))
        assert _max_age(header) == 0 and "path=/" in header.lower()
        assert "httponly" in header.lower() and "samesite=lax" in header.lower()
        assert run(state.sessions.get(sid))["revoked"] is True


def test_16b_session_listing_projects_remember_and_the_effective_expiry() -> None:
    with _build() as c:
        _login(c, remember=True)
        rows = c.get("/api/sessions").json()["sessions"]
        assert rows and rows[0]["remember"] is True and rows[0]["remember_seconds"] == _DAY
        assert rows[0]["expires_at"]
        assert "refresh_hash" not in rows[0]
        admin_rows = c.get("/api/admin/sessions").json()["sessions"]
        assert all("expires_at" in r for r in admin_rows)


def _when(iso: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(iso).timestamp()


def test_16c_an_ended_session_is_never_listed_as_live() -> None:
    """Re-review finding: a remembered session on another device that ended for
    inactivity was listed as "Remembered, expires in 10h" while its token got 401."""
    with _build() as c:  # default policy: 12 h idle timeout applies to remembered rows
        other = _login(c, remember=True).json()["token"]
        sid_other = decode(other, SECRET)["sid"]
        c.cookies.clear()
        current = _login(c, remember=True).json()["token"]
        sid_current = decode(current, SECRET)["sid"]
        _age_row(sid_other, created_hours=14, idle_hours=13)
        now = now_utc().timestamp()

        rows = {r["sid"]: r for r in c.get("/api/sessions").json()["sessions"]}
        ended = rows[sid_other]
        assert ended["active"] is False and ended["ended_reason"] == "idle_expired"
        assert ended["remember"] is False and ended["remember_seconds"] == 0
        # The listed end time is when it actually ended, never a future one.
        assert _when(ended["expires_at"]) < now
        assert ended["expires_at"] == ended["effective_idle_expires_at"]
        assert _when(ended["effective_absolute_expires_at"]) > now  # the unreached hard limit

        live = rows[sid_current]
        assert live["active"] is True and live["ended_reason"] == ""
        assert live["remember"] is True and live["remember_seconds"] == _DAY
        # Live: the earlier of the inactivity deadline (12 h) and the hard limit (24 h).
        assert live["expires_at"] == live["effective_idle_expires_at"]
        assert _when(live["expires_at"]) < _when(live["effective_absolute_expires_at"])
        assert abs(_when(live["expires_at"]) - (now + 12 * 3600)) < 120

        # The admin console projects the same truth with each owner's limits.
        admin = {r["sid"]: r for r in c.get("/api/admin/sessions").json()["sessions"]}
        assert admin[sid_other]["active"] is False and admin[sid_other]["remember"] is False
        assert admin[sid_current]["active"] is True

        # ...and it matches what the server does with that device's token.
        c.cookies.clear()
        dead = c.get("/api/cases", headers={"Authorization": f"Bearer {other}"})
        assert dead.status_code == 401


def test_16d_listing_reports_every_way_a_session_ends() -> None:
    with _build() as c:
        old = _login(c, remember=True).json()["token"]
        sid_old = decode(old, SECRET)["sid"]
        c.cookies.clear()
        gone = _login(c).json()["token"]
        sid_gone = decode(gone, SECRET)["sid"]
        c.cookies.clear()
        _login(c, remember=True)
        # Past the 24 h remembered lifetime, though used an hour ago.
        _age_row(sid_old, created_hours=25, idle_hours=1)
        run(_STATE["state"].sessions.revoke(sid_gone, by="Admin", reason="admin"))
        rows = {r["sid"]: r for r in c.get("/api/sessions").json()["sessions"]}
        assert (rows[sid_old]["active"], rows[sid_old]["ended_reason"]) == (False, "absolute_expired")
        assert rows[sid_old]["remember"] is False
        assert _when(rows[sid_old]["expires_at"]) < now_utc().timestamp()
        assert (rows[sid_gone]["active"], rows[sid_gone]["ended_reason"]) == (False, "revoked")


def test_16e_public_projection_unit_cases() -> None:
    from datetime import timedelta

    limits = session_limits(SessionPolicyConfig(), roles=None)
    now = now_utc()
    row = {
        "sid": "s1", "username": "alice", "remember": True, "remember_seconds": _DAY,
        "created_at": (now - timedelta(hours=1)).isoformat(),
        "last_active_at": now.isoformat(),
        # The access token itself ran out (a stale token_expires_at stamp).
        "token_expires_at": (now - timedelta(minutes=1)).isoformat(),
    }
    out = SessionStore.public(row, limits)
    assert (out["active"], out["ended_reason"], out["remember"]) == (False, "absolute_expired", False)
    # Without limits the projection is unchanged (no live-policy claims at all).
    bare = SessionStore.public(row)
    assert "active" not in bare and "expires_at" not in bare and bare["remember"] is True
    # A live row whose hard limit comes first lists the hard limit.
    row2 = {**row, "token_expires_at": "", "created_at": (now - timedelta(hours=20)).isoformat()}
    out2 = SessionStore.public(row2, limits)
    assert out2["active"] is True
    assert out2["expires_at"] == out2["effective_absolute_expires_at"]
    assert _when(out2["expires_at"]) < _when(out2["effective_idle_expires_at"])


# --------------------------------------------------------------------------- #
# 17-19  Public status, config, coverage
# --------------------------------------------------------------------------- #
_STATUS_KEYS = {
    "enabled", "duration_seconds", "idle_seconds", "insecure_blocked", "secure_cookies",
    "standard_session_seconds",
}


def test_17_setup_status_exposes_only_the_public_remember_block() -> None:
    with _build() as c:
        c.cookies.clear()
        block = c.get("/api/setup/status").json()["remember_me"]
        assert block == {
            "enabled": True, "duration_seconds": _DAY, "idle_seconds": 12 * 3600,
            "insecure_blocked": False, "secure_cookies": False,
            "standard_session_seconds": 12 * 3600,
        }
    with _build(base_url="http://testserver") as c:
        block = c.get("/api/setup/status").json()["remember_me"]
        assert block["insecure_blocked"] is True and block["secure_cookies"] is False
    with _build(base_url="http://testserver", remember={"enabled": False}) as c:
        block = c.get("/api/setup/status").json()["remember_me"]
        assert set(block) == _STATUS_KEYS
        assert (block["enabled"], block["insecure_blocked"]) == (False, False)
    # HTTPS without AUTH_COOKIE_SECURE: refused, and the page can tell why.
    with _build(base_url="https://soc.example.com", peer="198.51.100.7") as c:
        block = c.get("/api/setup/status").json()["remember_me"]
        assert block["insecure_blocked"] is True and block["secure_cookies"] is False
    with _build(base_url="https://soc.example.com", peer="198.51.100.7",
                auth_cookie_secure=True) as c:
        block = c.get("/api/setup/status").json()["remember_me"]
        assert block["insecure_blocked"] is False and block["secure_cookies"] is True


def test_17b_setup_status_states_the_remembered_inactivity_limit() -> None:
    """Re-review finding: the sign-in page promised a flat 24 hours while a remembered
    device that went unused for the idle timeout was signed out."""
    # Default: the 12 h idle timeout applies to remembered devices too.
    with _build() as c:
        block = c.get("/api/setup/status").json()["remember_me"]
        assert (block["duration_seconds"], block["idle_seconds"]) == (_DAY, 12 * 3600)
        # The promise matches the enforcement: unused for 13 h, inside the 24 h.
        sid = decode(_login(c, remember=True).json()["token"], SECRET)["sid"]
        _age_row(sid, created_hours=13, idle_hours=13)
        assert c.get("/api/auth/me").json()["reason"] == "idle_expired"
    # A separate remembered inactivity limit wins.
    with _build(remember={"idle_seconds": 3600}) as c:
        assert c.get("/api/setup/status").json()["remember_me"]["idle_seconds"] == 3600
    # No inactivity limit shorter than the lifetime: activity never matters → 0.
    with _build(session_policy={"idle_timeout": 2 * _DAY}) as c:
        assert c.get("/api/setup/status").json()["remember_me"]["idle_seconds"] == 0
    with _build(remember={"enabled": False}) as c:
        assert c.get("/api/setup/status").json()["remember_me"]["idle_seconds"] == 0


def test_17c_remember_idle_window_helper() -> None:
    from app.auth.session_limits import remember_idle_window_seconds

    assert remember_idle_window_seconds(SessionPolicyConfig()) == 12 * 3600
    assert remember_idle_window_seconds(
        SessionPolicyConfig(remember_me=RememberMePolicy(duration_seconds=6 * 3600))
    ) == 0  # the 12 h idle timeout is longer than a 6 h remembered lifetime
    assert remember_idle_window_seconds(
        SessionPolicyConfig(idle_timeout=1800,
                            remember_me=RememberMePolicy(idle_seconds=7200))
    ) == 7200  # an explicit remembered limit is the administrator's choice
    assert remember_idle_window_seconds(
        SessionPolicyConfig(absolute_lifetime=7200)
    ) == 0  # capped lifetime (2 h) is shorter than the 12 h idle timeout
    assert remember_idle_window_seconds(None) == 0
    # It is exactly the inactivity limit the evaluator applies to a remembered row.
    policy = SessionPolicyConfig(idle_timeout=5 * 3600)
    limits = session_limits(policy, roles=None)
    assert remember_idle_window_seconds(policy) == limits.for_row({"remember": True})[0]


def test_18_config_bounds_are_repaired_and_the_prune_invariant_holds() -> None:
    prefs = Preferences.model_validate({"session_policy": {"remember_me": {
        "duration_seconds": 10 * _DAY, "idle_seconds": 0,
        "excluded_roles": ["super_admin", " super_admin ", 7, ""], "enabled": "no",
    }}})
    rm = prefs.session_policy.remember_me
    assert rm.duration_seconds == _DAY and rm.idle_seconds is None
    assert rm.excluded_roles == ["super_admin"] and rm.enabled is False
    assert RememberMePolicy.model_validate({"duration_seconds": 60}).duration_seconds == 3600
    assert RememberMePolicy.model_validate({"duration_seconds": "junk"}).duration_seconds == _DAY
    assert SessionPolicyConfig.model_validate({"remember_me": "junk"}).remember_me == RememberMePolicy()
    # Older stored preferences (no block) load with the defaults.
    assert Preferences.model_validate({"session_policy": {"idle_timeout": 600}}).session_policy \
        .remember_me == RememberMePolicy()
    # Prune invariant (ASVS 7.4.1): every token lifetime is shorter than the grace
    # after which a revoked row is pruned, or a revoked token could be lazily
    # re-registered after its row disappeared.
    upper = None
    for meta in RememberMePolicy.model_fields["duration_seconds"].metadata:
        upper = getattr(meta, "le", None) or upper
    assert upper == REMEMBER_MAX_SECONDS < _PRUNE_GRACE_SECONDS
    assert Secrets(_env_file=None).auth_token_hours * 3600 < _PRUNE_GRACE_SECONDS


def test_18b_settings_writes_reject_out_of_range_remember_values() -> None:
    """Review finding: repair-on-LOAD must not turn a live write into a looser
    policy than the one the administrator asked for."""
    with _build() as c:
        state = _STATE["state"]
        assert _login(c).status_code == 200
        bad = [
            {"duration_seconds": 1800},
            {"duration_seconds": 2 * _DAY},
            {"duration_seconds": "24h"},
            {"idle_seconds": 60},
            {"idle_seconds": 2 * _DAY},
            {"enabled": "no"},
            {"excluded_roles": "super_admin"},
        ]
        for remember in bad:
            out = c.put("/api/settings", json={"session_policy": {"remember_me": remember}})
            assert out.status_code == 422, (remember, out.text)
            assert "remember_me" in out.json()["detail"]
        # Nothing was stored.
        assert state.prefs.session_policy.remember_me == RememberMePolicy()
        ok = c.put("/api/settings", json={"session_policy": {"remember_me": {
            "duration_seconds": 6 * 3600, "idle_seconds": 1800,
            "excluded_roles": ["super_admin"],
        }}})
        assert ok.status_code == 200, ok.text
        rm = state.prefs.session_policy.remember_me
        assert (rm.duration_seconds, rm.idle_seconds, rm.excluded_roles) == (
            6 * 3600, 1800, ["super_admin"])
        # 0 / null both mean "no separate inactivity limit".
        for off in (0, None):
            assert c.put("/api/settings", json={"session_policy": {"remember_me": {
                "idle_seconds": off}}}).status_code == 200
            assert state.prefs.session_policy.remember_me.idle_seconds is None


def test_18c_token_lifetime_stays_below_the_prune_grace() -> None:
    """Review finding: AUTH_TOKEN_HOURS above the prune grace must not let a revoked
    session's token come back once its registry row is pruned."""
    assert MAX_SESSION_TOKEN_SECONDS < _PRUNE_GRACE_SECONDS
    with _build(auth_token_hours=720) as c:
        state = _STATE["state"]
        assert state.auth.token_seconds == MAX_SESSION_TOKEN_SECONDS
        claims = decode(_login(c).json()["token"], SECRET)
        assert claims["exp"] - claims["iat"] == MAX_SESSION_TOKEN_SECONDS

    # Defence in depth: a token minted by an older build (30-day lifetime, issued
    # 8 days ago) whose row was revoked and then pruned is never re-registered.
    import base64
    import json as _json
    import time as _time

    from app.auth.tokens import _sign

    def _b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    with _build() as c:
        state = _STATE["state"]
        now = int(_time.time())
        sid = new_sid()
        payload = {"sub": "Admin", "role": "super_admin", "mc": False, "sid": sid,
                   "tv": 0, "iat": now - 8 * _DAY, "exp": now + 22 * _DAY}
        head = _b64(_json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        body = _b64(_json.dumps(payload).encode())
        token = f"{head}.{body}.{_sign(f'{head}.{body}'.encode('ascii'), SECRET)}"
        hdr = {"Authorization": f"Bearer {token}"}
        out = c.get("/api/cases", headers=hdr)
        assert out.status_code == 401
        assert out.json()["detail"] == {"code": "session_invalid", "reason": "unknown"}
        assert run(state.sessions.get(sid)) is None  # not re-registered
        assert c.get("/api/auth/me", headers=hdr).json()["authenticated"] is False


def test_19_no_new_public_path() -> None:
    assert "/api/setup/status" in PUBLIC_API_PATHS
    assert not any("remember" in p for p in PUBLIC_API_PATHS)
