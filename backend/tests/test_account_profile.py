"""Wave-2 (W2) tests: self-service account profile.

Covers the additive ``User`` profile fields + ``public()`` projection (secrets never
leak), the tight avatar validator, and the ``/api/account/me`` + ``/api/me/avatar``
routes (round-trip, env-managed rejection, auth-off stub). Offline (fake ES + mock
LLM), reusing the auth-on TestClient harness shape from tests/test_rbac_users.py.
"""

from __future__ import annotations

import base64
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import MAX_AVATAR_LEN, User, validate_avatar
from app.state import AppState


# --------------------------------------------------------------------------- #
# Tiny valid raster bodies (magic-byte-correct), as data-URLs.
# --------------------------------------------------------------------------- #
def _data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


_PNG = _data_url("image/png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
_JPEG = _data_url("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 16)
_WEBP = _data_url("image/webp", b"RIFF" + b"\x10\x00\x00\x00" + b"WEBP" + b"\x00" * 8)
_SVG = _data_url("image/svg+xml", b"<svg></svg>")


# --------------------------------------------------------------------------- #
# Avatar validator (pure)
# --------------------------------------------------------------------------- #
def test_avatar_validator_accepts_empty_and_small_rasters() -> None:
    assert validate_avatar("") == ""
    assert validate_avatar(_PNG) == _PNG
    assert validate_avatar(_JPEG) == _JPEG
    assert validate_avatar(_WEBP) == _WEBP


def test_avatar_validator_rejects_svg() -> None:
    with pytest.raises(ValueError):
        validate_avatar(_SVG)
    # Even smuggling an svg body behind a png mime fails the magic sniff.
    with pytest.raises(ValueError):
        validate_avatar(_data_url("image/png", b"<svg>nope</svg>"))


def test_avatar_validator_rejects_oversize() -> None:
    big = "data:image/png;base64," + "A" * (MAX_AVATAR_LEN + 10)
    with pytest.raises(ValueError):
        validate_avatar(big)


def test_avatar_validator_rejects_malformed_base64() -> None:
    with pytest.raises(ValueError):
        validate_avatar("data:image/png;base64,not!!base64!!")
    # Wrong magic bytes for the declared type.
    with pytest.raises(ValueError):
        validate_avatar(_data_url("image/png", b"JUSTTEXTHERE000000"))
    # Bad webp container.
    with pytest.raises(ValueError):
        validate_avatar(_data_url("image/webp", b"RIFFxxxxNOTWEBP00"))


def test_user_model_rejects_bad_avatar() -> None:
    with pytest.raises(Exception):
        User(username="x", avatar=_SVG)
    # A valid one round-trips through the model.
    u = User(username="x", avatar=_PNG)
    assert u.avatar == _PNG


# --------------------------------------------------------------------------- #
# public() projection — secrets never leak, new fields present
# --------------------------------------------------------------------------- #
def test_public_excludes_secrets_includes_profile() -> None:
    u = User(
        username="bob",
        password_hash="SECRET-PBKDF2",
        mfa_secret="SECRET-TOTP",
        mfa_recovery_hashes=["h1", "h2"],
        display_name="Bob Q",
        alias="bobby",
        avatar=_PNG,
        alt_email="bob@alt.example",
        timezone="UTC",
        locale="en-US",
        prefs={"density": "compact"},
    )
    pub = u.public()
    # Secrets absent (#10).
    assert "password_hash" not in pub
    assert "mfa_secret" not in pub
    assert "mfa_recovery_hashes" not in pub
    assert "SECRET" not in str(pub)
    # Non-secret profile fields present.
    assert pub["display_name"] == "Bob Q"
    assert pub["alias"] == "bobby"
    assert pub["avatar"] == _PNG
    assert pub["alt_email"] == "bob@alt.example"
    assert pub["timezone"] == "UTC"
    assert pub["locale"] == "en-US"
    assert pub["prefs"] == {"density": "compact"}
    # And the mfa_enabled boolean is still surfaced.
    assert "mfa_enabled" in pub
    # The admin-managed contact fields + the MFA mandate are surfaced too (with
    # clean defaults here — none were set on this user).
    assert pub["email"] == ""
    assert pub["phone"] == ""
    assert pub["mfa_required"] is False


def test_old_user_doc_loads_unchanged() -> None:
    # A pre-W2 stored doc (no profile keys) loads with defaulted empties — and the
    # newer admin-managed contact/mandate fields default the same way (additive,
    # zero-migration).
    u = User.model_validate({"username": "legacy", "password_hash": "h", "role": "auditor"})
    assert u.display_name == "" and u.avatar == "" and u.prefs == {}
    assert u.email == "" and u.phone == "" and u.mfa_required is False


# --------------------------------------------------------------------------- #
# Auth-on TestClient harness (mirrors tests/test_rbac_users.py)
# --------------------------------------------------------------------------- #
def _client(*, seed_admin: bool = True, env_admin: bool = False, auth: bool = True):
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=auth, auth_jwt_secret="acct-test-secret",
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
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c, username, password):
    return c.post("/api/auth/login", json={"username": username, "password": password})


# --------------------------------------------------------------------------- #
# /api/account/me round-trip
# --------------------------------------------------------------------------- #
def test_profile_put_get_roundtrip() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        # Initially empty profile.
        me = c.get("/api/account/me")
        assert me.status_code == 200
        body = me.json()
        assert body["env_managed"] is False
        assert body["user"]["display_name"] == ""
        # PUT a profile patch.
        r = c.put("/api/account/me", json={
            "display_name": "Admin User",
            "alias": "adm",
            "alt_email": "admin@alt.example",
            "timezone": "Europe/London",
            "locale": "en-GB",
            "avatar": _WEBP,
            "prefs": {"theme": "dark", "density": "comfortable"},
        })
        assert r.status_code == 200, r.text
        u = r.json()["user"]
        assert u["display_name"] == "Admin User"
        assert u["avatar"] == _WEBP
        assert u["prefs"] == {"theme": "dark", "density": "comfortable"}
        # GET reflects the persisted change.
        again = c.get("/api/account/me").json()["user"]
        assert again["display_name"] == "Admin User"
        assert again["alias"] == "adm"
        assert again["timezone"] == "Europe/London"
        assert again["locale"] == "en-GB"
        assert again["avatar"] == _WEBP
        # Secrets never present in the account view.
        assert "password_hash" not in again
        assert "mfa_secret" not in again


def test_profile_partial_patch_leaves_others() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        c.put("/api/account/me", json={"display_name": "Keep Me", "alias": "k"})
        # Patch only the locale — display_name/alias must survive.
        c.put("/api/account/me", json={"locale": "fr-FR"})
        u = c.get("/api/account/me").json()["user"]
        assert u["display_name"] == "Keep Me"
        assert u["alias"] == "k"
        assert u["locale"] == "fr-FR"


def test_profile_empty_patch_is_400() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        r = c.put("/api/account/me", json={})
        assert r.status_code == 400


def test_profile_rejects_bad_avatar() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        r = c.put("/api/account/me", json={"avatar": _SVG})
        assert r.status_code == 400


def test_profile_rejects_oversize_prefs() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        r = c.put("/api/account/me", json={"prefs": {"blob": "x" * 9000}})
        assert r.status_code == 400


# --------------------------------------------------------------------------- #
# /api/me/avatar set + clear
# --------------------------------------------------------------------------- #
def test_avatar_route_set_and_clear() -> None:
    with _client() as c:
        _login(c, "Admin", "Admin@123")
        r = c.put("/api/me/avatar", json={"avatar": _PNG})
        assert r.status_code == 200
        assert r.json()["user"]["avatar"] == _PNG
        # Clear.
        r2 = c.put("/api/me/avatar", json={"avatar": ""})
        assert r2.status_code == 200
        assert r2.json()["user"]["avatar"] == ""
        # Bad avatar via the thin route is rejected.
        r3 = c.put("/api/me/avatar", json={"avatar": _SVG})
        assert r3.status_code == 400


# --------------------------------------------------------------------------- #
# Env-managed account (no persisted record) — 400 on write, stub-ish on read
# --------------------------------------------------------------------------- #
def test_env_managed_get_marks_env_managed() -> None:
    with _client(seed_admin=False, env_admin=True) as c:
        _login(c, "envadmin", "env-pass-1234")
        me = c.get("/api/account/me").json()
        assert me["env_managed"] is True
        assert me["user"]["username"] == "envadmin"
        assert me["user"]["display_name"] == ""


def test_env_managed_put_is_400() -> None:
    with _client(seed_admin=False, env_admin=True) as c:
        _login(c, "envadmin", "env-pass-1234")
        r = c.put("/api/account/me", json={"display_name": "Nope"})
        assert r.status_code == 400
        r2 = c.put("/api/me/avatar", json={"avatar": _PNG})
        assert r2.status_code == 400


# --------------------------------------------------------------------------- #
# Auth-disabled stub path
# --------------------------------------------------------------------------- #
def test_auth_off_returns_stub() -> None:
    with _client(auth=False, seed_admin=False) as c:
        me = c.get("/api/account/me")
        assert me.status_code == 200
        body = me.json()
        assert body["auth_enabled"] is False
        assert body["env_managed"] is False
        assert body["user"]["role"] == UserRole.SUPER_ADMIN.value
        assert body["user"]["display_name"] == ""


def test_unauthenticated_put_is_401() -> None:
    with _client() as c:
        # No login → require_auth gate 401s the write.
        r = c.put("/api/account/me", json={"display_name": "x"})
        assert r.status_code == 401
