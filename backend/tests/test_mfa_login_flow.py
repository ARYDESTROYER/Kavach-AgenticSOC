"""Wave 2 / F3 — the end-to-end MFA login flow through the real app (offline).

password → (requires_mfa + pending_token) → /auth/mfa/verify → full session.
Also: enrollment (setup→confirm), the recovery-code path, replay/pending-token
rejection, disable, and the crucial back-compat guarantee that a NON-MFA user logs
in EXACTLY as before (single-step, full token, no pending).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.auth import mfa as mfa_mod
from app.auth.passwords import hash_password
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

# A deterministic clock pinned to the MIDDLE of a TOTP step, so server-side
# verification (which reads ``mfa_mod.time.time()`` with no explicit ts) and the
# test's code generation share the SAME "now" — removing step-boundary flakiness.
_FROZEN_NOW = 1_782_700_000.0 + 15.0  # 15s into a step (well clear of both edges)


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _FROZEN_NOW)
    yield


def _totp_now(secret: str, *, step_offset: int = 0) -> str:
    """A TOTP code for the frozen "now" (optionally ``step_offset`` steps ahead)."""
    return mfa_mod.totp(secret, ts=_FROZEN_NOW + step_offset * 30)


@pytest_asyncio.fixture
async def auth_state():
    """An auth-ENABLED AppState with one ordinary (non-MFA) password user 'alice'."""
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        auth_enabled=True,
        auth_jwt_secret="test-secret",
        auth_seed_admin=False,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    await state.users.create(
        username="alice",
        password_hash=hash_password("alice-password"),
        role=UserRole.ANALYST_TIER1.value,
        active=True,
        must_change_password=False,
    )
    await state.refresh_users()
    yield state
    await state.shutdown()


@pytest.fixture
def client(auth_state):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.tlsoc = auth_state
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)
    with TestClient(app) as c:
        yield c


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


# --------------------------------------------------------------------------- #
# Back-compat: a non-MFA user is unchanged
# --------------------------------------------------------------------------- #
def test_non_mfa_user_login_unchanged(client):
    resp = _login(client, "alice", "alice-password")
    assert resp.status_code == 200
    body = resp.json()
    assert "requires_mfa" not in body
    assert body["token"]
    assert body["user"]["username"] == "alice"
    # /auth/me reports mfa_enabled=False for the session.
    me = client.get("/api/auth/me", headers=_bearer(body["token"]))
    assert me.json()["user"]["mfa_enabled"] is False


def test_bad_password_still_401(client):
    assert _login(client, "alice", "wrong").status_code == 401


# --------------------------------------------------------------------------- #
# Enrollment: setup → confirm
# --------------------------------------------------------------------------- #
def _enroll_mfa(client, token) -> tuple[str, list[str]]:
    """Run setup + confirm for the session ``token``; return (secret, recovery_codes)."""
    setup = client.post("/api/auth/mfa/setup", headers=_bearer(token))
    assert setup.status_code == 200
    data = setup.json()
    secret = data["secret"]
    assert data["otpauth_uri"].startswith("otpauth://totp/")
    assert len(data["recovery_codes"]) == 10
    code = _totp_now(secret)  # confirm consumes the CURRENT step
    confirm = client.post("/api/auth/mfa/confirm", json={"code": code}, headers=_bearer(token))
    assert confirm.status_code == 200 and confirm.json()["ok"] is True
    return secret, data["recovery_codes"]


def test_enroll_then_login_two_phase(client):
    login = _login(client, "alice", "alice-password").json()
    secret, _ = _enroll_mfa(client, login["token"])

    # /auth/me now reflects mfa_enabled=True.
    me = client.get("/api/auth/me", headers=_bearer(login["token"]))
    assert me.json()["user"]["mfa_enabled"] is True

    # Phase 1: password returns a pending token + requires_mfa, NO session token.
    # An ENROLLED user gets the code challenge — never the enrollment-required flag
    # (that flag is only for required-but-NOT-enrolled accounts).
    p1 = _login(client, "alice", "alice-password").json()
    assert p1["requires_mfa"] is True and p1["pending_token"]
    assert "token" not in p1
    assert "mfa_enrollment_required" not in p1

    # The pending token must NOT work as a session (deny-by-default). Clear the
    # cookie jar first so the earlier enroll session's cookie doesn't mask this.
    client.cookies.clear()
    denied = client.get("/api/auth/me", headers=_bearer(p1["pending_token"]))
    assert denied.json()["user"] is None

    # Phase 2: verify with a fresh TOTP (advance one step past the confirm step to
    # avoid replay-rejection of the step consumed during enrollment).
    code = _totp_now(secret, step_offset=1)
    p2 = client.post(
        "/api/auth/mfa/verify",
        json={"pending_token": p1["pending_token"], "code": code},
    )
    assert p2.status_code == 200
    body = p2.json()
    assert body["token"] and body["user"]["username"] == "alice"
    # The minted session works on a protected route.
    me2 = client.get("/api/auth/me", headers=_bearer(body["token"]))
    assert me2.json()["user"]["username"] == "alice"


def test_confirm_rejects_wrong_code(client):
    login = _login(client, "alice", "alice-password").json()
    client.post("/api/auth/mfa/setup", headers=_bearer(login["token"]))
    bad = client.post("/api/auth/mfa/confirm", json={"code": "000000"}, headers=_bearer(login["token"]))
    assert bad.status_code == 400
    # MFA must remain OFF after a failed confirm.
    me = client.get("/api/auth/me", headers=_bearer(login["token"]))
    assert me.json()["user"]["mfa_enabled"] is False


def test_verify_wrong_code_rejected(client):
    login = _login(client, "alice", "alice-password").json()
    _enroll_mfa(client, login["token"])
    p1 = _login(client, "alice", "alice-password").json()
    bad = client.post(
        "/api/auth/mfa/verify",
        json={"pending_token": p1["pending_token"], "code": "111111"},
    )
    assert bad.status_code == 401


# --------------------------------------------------------------------------- #
# Recovery-code path (single-use)
# --------------------------------------------------------------------------- #
def test_recovery_code_login_single_use(client):
    login = _login(client, "alice", "alice-password").json()
    _secret, recovery = _enroll_mfa(client, login["token"])
    code = recovery[0]

    p1 = _login(client, "alice", "alice-password").json()
    ok = client.post(
        "/api/auth/mfa/verify",
        json={"pending_token": p1["pending_token"], "code": code},
    )
    assert ok.status_code == 200 and ok.json()["token"]

    # The same recovery code cannot be reused.
    p1b = _login(client, "alice", "alice-password").json()
    reuse = client.post(
        "/api/auth/mfa/verify",
        json={"pending_token": p1b["pending_token"], "code": code},
    )
    assert reuse.status_code == 401


# --------------------------------------------------------------------------- #
# Replay: a consumed TOTP code at the same step is rejected
# --------------------------------------------------------------------------- #
def test_totp_replay_rejected_at_verify(client):
    login = _login(client, "alice", "alice-password").json()
    secret, _ = _enroll_mfa(client, login["token"])
    # Use a code one step ahead of the step the confirm consumed (still inside the
    # ±1 server window) so the FIRST verify succeeds.
    code = _totp_now(secret, step_offset=1)

    p1 = _login(client, "alice", "alice-password").json()
    first = client.post(
        "/api/auth/mfa/verify", json={"pending_token": p1["pending_token"], "code": code}
    )
    assert first.status_code == 200

    # Reusing the SAME code (same time step) must now fail — replay protection.
    p1b = _login(client, "alice", "alice-password").json()
    replay = client.post(
        "/api/auth/mfa/verify", json={"pending_token": p1b["pending_token"], "code": code}
    )
    assert replay.status_code == 401


# --------------------------------------------------------------------------- #
# Disable
# --------------------------------------------------------------------------- #
def test_disable_requires_valid_code(client):
    login = _login(client, "alice", "alice-password").json()
    secret, _ = _enroll_mfa(client, login["token"])
    # A bad code does not disable.
    bad = client.post("/api/auth/mfa/disable", json={"code": "000000"}, headers=_bearer(login["token"]))
    assert bad.status_code == 400
    # A valid (fresh) code disables (one step ahead of the confirm step, still in
    # the ±1 window, so it isn't rejected as a replay of the consumed confirm step).
    code = _totp_now(secret, step_offset=1)
    ok = client.post("/api/auth/mfa/disable", json={"code": code}, headers=_bearer(login["token"]))
    assert ok.status_code == 200
    # Login is single-step again.
    again = _login(client, "alice", "alice-password").json()
    assert "requires_mfa" not in again and again["token"]


def test_invalid_pending_token_rejected(client):
    bad = client.post(
        "/api/auth/mfa/verify", json={"pending_token": "not-a-token", "code": "123456"}
    )
    assert bad.status_code == 401


def test_super_admin_force_disable_via_user_update(client, auth_state):
    # Enroll alice; a super_admin force-disables her MFA via PUT /users (rbac off →
    # an authenticated session is treated as super_admin, so alice's own session
    # passes the users:manage gate here).
    login = _login(client, "alice", "alice-password").json()
    _enroll_mfa(client, login["token"])
    resp = client.put(
        "/api/users/alice", json={"mfa_enabled": False}, headers=_bearer(login["token"])
    )
    assert resp.status_code == 200
    assert resp.json()["user"]["mfa_enabled"] is False
    # Next login is single-step again.
    again = _login(client, "alice", "alice-password").json()
    assert "requires_mfa" not in again and again["token"]


def test_admin_cannot_enable_mfa_for_user(client, auth_state):
    login = _login(client, "alice", "alice-password").json()
    resp = client.put(
        "/api/users/alice", json={"mfa_enabled": True}, headers=_bearer(login["token"])
    )
    assert resp.status_code == 400


def test_admin_can_set_mfa_required_mandate(client, auth_state):
    # The MANDATE flag (required ≠ enrolled) is admin-settable and must NOT trip the
    # mfa_enabled=True guard above. It flips alice's next login into the
    # enrollment-required phase (covered end-to-end in
    # tests/test_mfa_mandate_and_user_fields.py).
    login = _login(client, "alice", "alice-password").json()
    resp = client.put(
        "/api/users/alice", json={"mfa_required": True}, headers=_bearer(login["token"])
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["user"]["mfa_required"] is True
    assert resp.json()["user"]["mfa_enabled"] is False
    p1 = _login(client, "alice", "alice-password").json()
    assert p1["requires_mfa"] is True
    assert p1["mfa_enrollment_required"] is True
    assert "token" not in p1


# --------------------------------------------------------------------------- #
# Pending-token hard guards on the login-phase enrollment surface
# --------------------------------------------------------------------------- #
def test_pending_token_cannot_reach_session_authed_mfa_setup(client):
    login = _login(client, "alice", "alice-password").json()
    _enroll_mfa(client, login["token"])
    p1 = _login(client, "alice", "alice-password").json()
    client.cookies.clear()
    # The pending half-session is NOT a full session: the session-authed setup and
    # confirm routes reject it outright.
    assert client.post(
        "/api/auth/mfa/setup", headers=_bearer(p1["pending_token"])
    ).status_code == 401
    assert client.post(
        "/api/auth/mfa/confirm", json={"code": "000000"},
        headers=_bearer(p1["pending_token"]),
    ).status_code == 401


def test_enrolled_user_pending_token_cannot_re_enroll(client):
    # Anti-factor-replacement: an enrolled user's challenge pending token must not
    # open the login-phase enrollment routes (that would let a password-only
    # attacker swap in their own authenticator).
    login = _login(client, "alice", "alice-password").json()
    _enroll_mfa(client, login["token"])
    p1 = _login(client, "alice", "alice-password").json()
    r = client.post(
        "/api/auth/mfa/enroll-setup", json={"pending_token": p1["pending_token"]}
    )
    assert r.status_code == 400
    assert "already enrolled" in r.json()["detail"]
    r = client.post(
        "/api/auth/mfa/enroll-confirm",
        json={"pending_token": p1["pending_token"], "code": "123456"},
    )
    assert r.status_code == 400
