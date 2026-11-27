"""Mandated MFA enrollment at login + richer user-admin fields (2026-08).

Covers, end-to-end through the real routers (offline: fake ES + mock LLM):

* the per-user ``mfa_required`` mandate: an admin sets it (PUT /api/users/{u}),
  the target's NEXT login returns ``mfa_enrollment_required`` + a pending token,
  enrollment completes at /auth/mfa/enroll-setup + /auth/mfa/enroll-confirm which
  mints a FULL session, and subsequent logins go through the normal MFA challenge;
* the role-level ``Preferences.mfa.enforce_for_roles`` path drives the SAME
  enrollment flow for an unenrolled user (previously a hard lockout);
* the pending half-session token is REJECTED by every normal surface (only the two
  enroll endpoints + /auth/mfa/verify accept it); expired/garbage pending → 401;
* an already-ENROLLED user can never re-enroll via a pending token (a password-only
  attacker must not be able to REPLACE the existing factor);
* the env-seeded single admin (no persisted User record) is never locked out by a
  role mandate it cannot complete;
* the new admin-set user fields (display_name/email/phone/mfa_required) + creating
  a user with existing CUSTOM roles (validated exactly like the assign path),
  with old stored KV docs still loading unchanged.

The routers are mounted WITH the real ``require_auth`` dependency so the public
allowlist + deny-by-default are genuinely exercised (unlike the lighter
test_mfa_login_flow harness).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router as monolith_router
from app.api.routes_roles import router as roles_router
from app.auth import mfa as mfa_mod
from app.auth import tokens as tokens_mod
from app.auth.passwords import hash_password
from app.auth.service import AuthService
from app.config import Secrets
from app.constants import ActionType, UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import User
from app.state import AppState

T1 = UserRole.ANALYST_TIER1.value
T2 = UserRole.ANALYST_TIER2.value
SA = UserRole.SUPER_ADMIN.value

_JWT_SECRET = "mandate-test-secret"

# Deterministic clock pinned to the middle of a TOTP step (same trick as
# tests/test_mfa_login_flow.py) so server verification and the test's code
# generation share one "now".
_FROZEN_NOW = 1_782_700_000.0 + 15.0


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr(mfa_mod.time, "time", lambda: _FROZEN_NOW)
    yield


@pytest.fixture(autouse=True)
def clean_pending_enroll():
    # The module-level pending-enrollment park (in-memory secret tier) is keyed by
    # username and would otherwise leak between tests in one process.
    from app.api.routes import _MFA_PENDING_ENROLL

    _MFA_PENDING_ENROLL.clear()
    yield
    _MFA_PENDING_ENROLL.clear()


def _totp_now(secret: str, *, step_offset: int = 0) -> str:
    return mfa_mod.totp(secret, ts=_FROZEN_NOW + step_offset * 30)


# --------------------------------------------------------------------------- #
# Harness — auth ON, require_auth-mounted (deny-by-default is real here).
# --------------------------------------------------------------------------- #
def _client(
    *,
    seed_admin: bool = True,
    env_admin: bool = False,
    rbac: bool = False,
    mfa_enforce_roles: list[str] | None = None,
):
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret=_JWT_SECRET,
        auth_seed_admin=seed_admin,
        auth_admin_username="envadmin",
        auth_admin_password="env-pass-1234" if env_admin else None,
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
        if rbac:
            prefs = prefs.model_copy(
                update={"rbac": prefs.rbac.model_copy(update={"enabled": True})}
            )
        if mfa_enforce_roles is not None:
            prefs = prefs.model_copy(update={
                "mfa": prefs.mfa.model_copy(
                    update={"enforce_for_roles": list(mfa_enforce_roles)}
                ),
            })
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(c, username, password):
    c.cookies.clear()
    return c.post("/api/auth/login", json={"username": username, "password": password})


def _admin_login(c):
    r = _login(c, "Admin", "Admin@123")
    assert r.status_code == 200, r.text
    return r


def _mk_user(c, username, password, role=T1, **extra):
    r = c.post("/api/users", json={
        "username": username, "password": password, "role": role, **extra,
    })
    assert r.status_code == 200, r.text
    return r.json()["user"]


def _auth_audit_rows(c) -> list[dict]:
    state = c.app.state.tlsoc
    return asyncio.run(
        state.control_audit.records(
            action_type=ActionType.AUTH_EVENT.value, limit=300
        )
    )


def _audit_summaries(c) -> list[str]:
    return [str(r.get("result_summary", "")) for r in _auth_audit_rows(c)]


def _pending_for(c, username: str) -> str:
    """Mint a pending half-session token directly (bypassing login) for guard tests."""
    return c.app.state.tlsoc.auth.begin_mfa(username)


# --------------------------------------------------------------------------- #
# The mandate flow, end to end
# --------------------------------------------------------------------------- #
def test_mandate_flow_end_to_end() -> None:
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "carol", "carol-pass-123")
        # Admin sets the mandate via PUT (NOT mfa_enabled — no secret is minted).
        r = c.put("/api/users/carol", json={"mfa_required": True})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["mfa_required"] is True
        assert r.json()["user"]["mfa_enabled"] is False

        # Carol's next login: password ok → enrollment-required phase 1.
        p1 = _login(c, "carol", "carol-pass-123")
        assert p1.status_code == 200, p1.text
        body = p1.json()
        assert body["requires_mfa"] is True
        assert body["mfa_enrollment_required"] is True
        assert body["pending_token"]
        assert "token" not in body
        assert any("mfa enrollment required" in s for s in _audit_summaries(c))

        # Phase 2a: enroll-setup returns the secret + otpauth URI + recovery codes
        # (the same shape as the session-authed /auth/mfa/setup).
        setup = c.post(
            "/api/auth/mfa/enroll-setup", json={"pending_token": body["pending_token"]}
        )
        assert setup.status_code == 200, setup.text
        data = setup.json()
        secret = data["secret"]
        assert data["otpauth_uri"].startswith("otpauth://totp/")
        assert len(data["recovery_codes"]) == 10
        assert any("login-mandated" in s for s in _audit_summaries(c))

        # Phase 2b: enroll-confirm with a computed TOTP → FULL session + cookie.
        confirm = c.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": body["pending_token"], "code": _totp_now(secret),
        })
        assert confirm.status_code == 200, confirm.text
        done = confirm.json()
        assert done["token"]
        assert done["user"]["username"] == "carol"
        assert done["user"]["mfa_enabled"] is True
        # The minted session works on protected routes (bearer + cookie).
        me = c.get("/api/auth/me", headers=_bearer(done["token"]))
        assert me.json()["user"]["username"] == "carol"
        assert any(
            "mfa enabled (login-mandated enrollment)" in s for s in _audit_summaries(c)
        )

        # Subsequent login: NORMAL challenge path (enrolled now — no enrollment flag).
        p2 = _login(c, "carol", "carol-pass-123")
        again = p2.json()
        assert again["requires_mfa"] is True
        assert "mfa_enrollment_required" not in again
        v = c.post("/api/auth/mfa/verify", json={
            "pending_token": again["pending_token"],
            "code": _totp_now(secret, step_offset=1),
        })
        assert v.status_code == 200, v.text
        assert v.json()["user"]["mfa_enabled"] is True


def test_role_enforce_unenrolled_user_gets_enrollment_flow() -> None:
    # Role-level enforce_for_roles for an UNENROLLED user drives the same flow
    # (this used to be a hard lockout: pending token → verify 400 → dead end).
    with _client(mfa_enforce_roles=[T1]) as c:
        _admin_login(c)
        _mk_user(c, "erin", "erin-pass-1234", role=T1)
        p1 = _login(c, "erin", "erin-pass-1234").json()
        assert p1["requires_mfa"] is True
        assert p1["mfa_enrollment_required"] is True
        setup = c.post(
            "/api/auth/mfa/enroll-setup", json={"pending_token": p1["pending_token"]}
        )
        assert setup.status_code == 200, setup.text
        confirm = c.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": p1["pending_token"],
            "code": _totp_now(setup.json()["secret"]),
        })
        assert confirm.status_code == 200, confirm.text
        assert confirm.json()["user"]["mfa_enabled"] is True


# --------------------------------------------------------------------------- #
# Hard guards on the pending token
# --------------------------------------------------------------------------- #
def test_pending_token_rejected_on_every_normal_surface() -> None:
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "carol", "carol-pass-123", mfa_required=True)
        p1 = _login(c, "carol", "carol-pass-123").json()
        pending = p1["pending_token"]
        c.cookies.clear()
        # The session-authed MFA routes reject it (401 — not a full session).
        assert c.post(
            "/api/auth/mfa/setup", headers=_bearer(pending)
        ).status_code == 401
        assert c.post(
            "/api/auth/mfa/confirm", json={"code": "000000"}, headers=_bearer(pending)
        ).status_code == 401
        # Ordinary authed routes reject it (deny-by-default via require_auth).
        assert c.get("/api/users", headers=_bearer(pending)).status_code == 401
        assert c.get("/api/cases", headers=_bearer(pending)).status_code == 401
        assert c.get("/api/account/me", headers=_bearer(pending)).status_code == 401
        # The public /auth/me treats it as no session.
        me = c.get("/api/auth/me", headers=_bearer(pending))
        assert me.json()["user"] is None


def test_expired_and_garbage_pending_tokens_are_401() -> None:
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "carol", "carol-pass-123", mfa_required=True)
        expired = tokens_mod.encode(
            {"sub": "carol", "mfa": "pending"}, _JWT_SECRET, expires_in_s=-30
        )
        for tok in (expired, "not-a-token", ""):
            r = c.post("/api/auth/mfa/enroll-setup", json={"pending_token": tok})
            assert r.status_code == 401, (tok, r.text)
            r = c.post(
                "/api/auth/mfa/enroll-confirm",
                json={"pending_token": tok, "code": "123456"},
            )
            assert r.status_code == 401, (tok, r.text)


def test_enroll_confirm_wrong_code_is_401_no_session_and_audited() -> None:
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "carol", "carol-pass-123", mfa_required=True)
        p1 = _login(c, "carol", "carol-pass-123").json()
        setup = c.post(
            "/api/auth/mfa/enroll-setup", json={"pending_token": p1["pending_token"]}
        )
        assert setup.status_code == 200
        c.cookies.clear()
        bad = c.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": p1["pending_token"], "code": "000000",
        })
        assert bad.status_code == 401
        # No session was minted (no cookie, nothing signed in).
        assert c.get("/api/auth/me").json()["user"] is None
        # MFA stayed OFF (a later login still demands enrollment, not a challenge).
        p2 = _login(c, "carol", "carol-pass-123").json()
        assert p2.get("mfa_enrollment_required") is True
        # The failure is audited (#2).
        assert any(
            "mfa enrollment confirm failed" in s for s in _audit_summaries(c)
        )


def test_enroll_confirm_without_setup_is_400() -> None:
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "carol", "carol-pass-123", mfa_required=True)
        p1 = _login(c, "carol", "carol-pass-123").json()
        r = c.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": p1["pending_token"], "code": "123456",
        })
        assert r.status_code == 400
        assert "enroll-setup" in r.json()["detail"]


def test_enrolled_user_cannot_re_enroll_via_pending_token() -> None:
    # Factor-replacement guard: an ALREADY-ENROLLED user's challenge pending token
    # must not open the enrollment surface (password-only attacker would otherwise
    # swap in their own authenticator).
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "carol", "carol-pass-123", mfa_required=True)
        p1 = _login(c, "carol", "carol-pass-123").json()
        setup = c.post(
            "/api/auth/mfa/enroll-setup", json={"pending_token": p1["pending_token"]}
        ).json()
        ok = c.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": p1["pending_token"], "code": _totp_now(setup["secret"]),
        })
        assert ok.status_code == 200
        # Now enrolled: a fresh challenge pending token is refused by BOTH enroll routes.
        p2 = _login(c, "carol", "carol-pass-123").json()
        assert "mfa_enrollment_required" not in p2
        r = c.post(
            "/api/auth/mfa/enroll-setup", json={"pending_token": p2["pending_token"]}
        )
        assert r.status_code == 400
        assert "already enrolled" in r.json()["detail"]
        r = c.post("/api/auth/mfa/enroll-confirm", json={
            "pending_token": p2["pending_token"], "code": "123456",
        })
        assert r.status_code == 400


def test_unmandated_user_cannot_use_enroll_surface() -> None:
    # A pending token for a user who is NOT required to use MFA (e.g. minted
    # directly) must not open enrollment either — the mandate is the gate.
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "plain", "plain-pass-123")
        pending = _pending_for(c, "plain")
        r = c.post("/api/auth/mfa/enroll-setup", json={"pending_token": pending})
        assert r.status_code == 400
        assert "not required" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# Env-seeded single admin — the mandate can never lock it out
# --------------------------------------------------------------------------- #
def test_env_admin_never_locked_out_by_role_mandate() -> None:
    # enforce_for_roles covers super_admin, but the env admin has NO persisted User
    # record and cannot enroll — requires_mfa must not demand it: login stays
    # single-step (full token, no pending).
    with _client(
        seed_admin=False, env_admin=True, mfa_enforce_roles=[SA]
    ) as c:
        r = _login(c, "envadmin", "env-pass-1234")
        assert r.status_code == 200, r.text
        body = r.json()
        assert "requires_mfa" not in body
        assert body["token"]
        # And the enrollment surface is closed for it even with a forged pending
        # token (no persisted record → 400 env-managed).
        pending = _pending_for(c, "envadmin")
        resp = c.post("/api/auth/mfa/enroll-setup", json={"pending_token": pending})
        assert resp.status_code == 400
        assert "environment configuration" in resp.json()["detail"]


def test_requires_mfa_unit_env_base_vs_store_overlay() -> None:
    # Unit-level: the env base-layer record is exempt from mandates; a persisted
    # store record overlaying the SAME username is not (it can actually enroll).
    svc = AuthService(
        enabled=True, jwt_secret="s", token_hours=1,
        users={"envadmin": hash_password("pw")},
        admin_username="envadmin",
        mfa_enforce_roles=[SA],
    )
    assert svc.requires_mfa("envadmin") is False
    # A persisted store user under the same role IS mandated…
    svc.set_users([User(username="stored", password_hash="h", role=SA)])
    assert svc.requires_mfa("stored") is True
    # …and the per-user mandate composes the same way.
    svc.set_mfa_enforce_roles([])
    svc.set_users([User(username="stored", password_hash="h", role=T1,
                        mfa_required=True)])
    assert svc.requires_mfa("stored") is True
    svc.set_users([User(username="stored", password_hash="h", role=T1)])
    assert svc.requires_mfa("stored") is False
    # A store overlay of the env username clears the exemption.
    svc.set_users([User(username="envadmin", password_hash="h", role=SA,
                        mfa_required=True)])
    assert svc.requires_mfa("envadmin") is True


# --------------------------------------------------------------------------- #
# Richer user creation / update fields
# --------------------------------------------------------------------------- #
def test_create_user_with_profile_contact_and_mandate() -> None:
    with _client() as c:
        _admin_login(c)
        user = _mk_user(
            c, "dave", "dave-pass-1234", role=T2,
            display_name="Dave Q. Example",
            email="dave@example.com",
            phone="+1 (555) 010-2030",
            mfa_required=True,
        )
        assert user["display_name"] == "Dave Q. Example"
        assert user["email"] == "dave@example.com"
        assert user["phone"] == "+1 (555) 010-2030"
        assert user["mfa_required"] is True
        assert user["mfa_enabled"] is False
        # Secrets never leak from the public projection.
        assert "password_hash" not in user
        assert "mfa_secret" not in user
        assert "mfa_recovery_hashes" not in user
        # The list surface shows the same projection.
        listed = {u["username"]: u for u in c.get("/api/users").json()["users"]}
        assert listed["dave"]["email"] == "dave@example.com"
        assert listed["dave"]["mfa_required"] is True
        # And the mandate is LIVE: dave's first login demands enrollment.
        p1 = _login(c, "dave", "dave-pass-1234").json()
        assert p1["mfa_enrollment_required"] is True


def test_create_user_invalid_email_phone_rejected() -> None:
    with _client() as c:
        _admin_login(c)
        base = {"username": "x1", "password": "x1-pass-12345", "role": T1}
        r = c.post("/api/users", json={**base, "email": "no-at-sign"})
        assert r.status_code == 400
        r = c.post("/api/users", json={**base, "email": "sp ace@example.com"})
        assert r.status_code == 400
        r = c.post("/api/users", json={**base, "phone": "call-me-maybe"})
        assert r.status_code == 400
        r = c.post("/api/users", json={**base, "email": ("a" * 200) + "@x.io"})
        assert r.status_code == 400
        r = c.post("/api/users", json={**base, "phone": "9" * 201})
        assert r.status_code == 400
        r = c.post("/api/users", json={**base, "display_name": "d" * 201})
        assert r.status_code == 400
        # None of the failed creates actually landed.
        listed = {u["username"] for u in c.get("/api/users").json()["users"]}
        assert "x1" not in listed


def test_update_user_patches_contact_and_mandate() -> None:
    with _client() as c:
        _admin_login(c)
        _mk_user(c, "dave", "dave-pass-1234")
        r = c.put("/api/users/dave", json={
            "display_name": "David", "email": "new@x.io", "phone": "+44 20 1234",
            "mfa_required": True,
        })
        assert r.status_code == 200, r.text
        u = r.json()["user"]
        assert u["display_name"] == "David"
        assert u["email"] == "new@x.io"
        assert u["phone"] == "+44 20 1234"
        assert u["mfa_required"] is True
        # mfa_required alone is a valid patch and is NOT caught by the
        # admin-cannot-enable-mfa guard (required ≠ enrolled).
        r = c.put("/api/users/dave", json={"mfa_required": False})
        assert r.status_code == 200, r.text
        assert r.json()["user"]["mfa_required"] is False
        assert r.json()["user"]["mfa_enabled"] is False
        # The mfa_enabled=True guard is untouched.
        r = c.put("/api/users/dave", json={"mfa_enabled": True})
        assert r.status_code == 400
        # Invalid contact patches are rejected.
        assert c.put("/api/users/dave", json={"email": "nope"}).status_code == 400
        assert c.put("/api/users/dave", json={"phone": "abc"}).status_code == 400
        # Clearing a contact field is an explicit empty string.
        r = c.put("/api/users/dave", json={"email": ""})
        assert r.status_code == 200 and r.json()["user"]["email"] == ""


def test_old_stored_user_doc_loads_with_new_field_defaults() -> None:
    # The additive-compat proof (extends the test_account_profile.py pattern): a
    # pre-existing minimal KV doc gains the new fields as defaults on load.
    u = User.model_validate({"username": "legacy", "password_hash": "h", "role": "auditor"})
    assert u.email == ""
    assert u.phone == ""
    assert u.mfa_required is False
    pub = u.public()
    assert pub["email"] == "" and pub["phone"] == "" and pub["mfa_required"] is False


# --------------------------------------------------------------------------- #
# Custom roles at creation time
# --------------------------------------------------------------------------- #
def test_create_user_with_custom_roles_matches_assign_path() -> None:
    with _client(rbac=True) as c:
        _admin_login(c)
        # An existing custom role granting cases:close on top of tier1.
        r = c.post("/api/roles", json={
            "name": "closer", "inherits": [T1], "grants": {"cases": ["close"]},
        })
        assert r.status_code == 200, r.text
        # Create WITH the custom role.
        created = _mk_user(
            c, "erin", "erin-pass-1234", role=T1, custom_roles=["closer"]
        )
        assert created["prefs"].get("custom_roles") == ["closer"]
        # Post-hoc assignment writes the identical shape.
        _mk_user(c, "fred", "fred-pass-1234", role=T1)
        r = c.put("/api/users/fred/roles", json={"custom_roles": ["closer"]})
        assert r.status_code == 200, r.text
        listed = {u["username"]: u for u in c.get("/api/users").json()["users"]}
        assert (
            listed["erin"]["prefs"].get("custom_roles")
            == listed["fred"]["prefs"].get("custom_roles")
            == ["closer"]
        )
        # And the grant is ENFORCED identically: erin resolves cases:close.
        _login(c, "erin", "erin-pass-1234")
        perms = c.get("/api/account/permissions").json()
        assert perms["custom_roles"] == ["closer"]
        assert "close" in perms["permissions"]["cases"]


def test_create_user_custom_roles_validation_matches_assign_path() -> None:
    with _client(rbac=True) as c:
        _admin_login(c)
        base = {"username": "x2", "password": "x2-pass-12345", "role": T1}
        # A built-in name is not a custom role (same 400 as the assign path).
        r = c.post("/api/users", json={**base, "custom_roles": [T2]})
        assert r.status_code == 400
        assert "built-in" in r.json()["detail"]
        # An unknown name is rejected (same 400 as the assign path).
        r = c.post("/api/users", json={**base, "custom_roles": ["ghost-role"]})
        assert r.status_code == 400
        assert "unknown custom role" in r.json()["detail"]
        # The base role must remain a BUILT-IN UserRole even when custom roles exist.
        c.post("/api/roles", json={"name": "shadow", "inherits": [T1]})
        r = c.post("/api/users", json={
            "username": "x3", "password": "x3-pass-12345", "role": "shadow",
        })
        assert r.status_code == 400
        assert "unknown role" in r.json()["detail"]
        # An empty custom_roles list is fine (no prefs bag seeded).
        u = _mk_user(c, "x4", "x4-pass-12345", custom_roles=[])
        assert u["prefs"].get("custom_roles") in (None, [])
