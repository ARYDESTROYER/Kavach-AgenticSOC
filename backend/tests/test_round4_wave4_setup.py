"""Round 4 / Wave 4 — OOBE first-admin account setup (PROPOSAL §6.7).

Covers the NEW ``POST /api/setup/account`` writer (``app.api.routes_setup``) + the
``GET /api/setup/status`` contract the wizard reads (served by the monolith router,
superset of ``{setup_complete, has_admin, auth_enabled}``):

* status shape — ``setup_complete`` / ``auth_enabled`` present; ``has_admin`` derivable
  from ``user_count`` (0 before, 1 after).
* account creates a ``super_admin`` with a HASHED (never plaintext) password, and the
  created credential logs in.
* the strong-password policy REJECTS a too-short / == username / common password (400),
  and the pure ``password_policy_error`` helper matches.
* the endpoint SELF-LOCKS: a second call after the first success 409s (an admin exists);
  and it 403s once ``setup_complete`` is flipped.
* with auth OFF the account step is a no-op/blocked (400) and no user is created.
* the password is NEVER echoed (response is booleans + username only).

The app under test mirrors ``main.py``: the monolith router + the Wave-4 setup router,
both under the ``require_auth`` gate. ``test_route_auth_coverage.py`` separately proves
the public-allowlist entries are correct.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.api.routes_setup import (
    _COMMON_PASSWORDS,
    _MIN_PASSWORD_LEN,
    SetupAccountBody,
    password_policy_error,
    setup_account,
)
from app.api.routes_setup import router as setup_router
from app.auth.passwords import hash_password, verify_password
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.stores.memory import EsKVStore
from app.stores.users import UserStore

# A strong password that clears the whole server policy (>=12, != username, not common).
_STRONG = "Str0ng-OOBE-Pass!"


def _build_client(**secret_overrides):
    """A TestClient over the REAL monolith + setup routers with the auth gate
    (mirrors main.py). ``setup_complete`` defaults to False (the OOBE state)."""
    setup_complete = secret_overrides.pop("setup_complete", False)
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, **secret_overrides,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                                provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = setup_complete
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    api.include_router(setup_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c: TestClient, username: str, password: str):
    c.cookies.clear()
    return c.post("/api/auth/login", json={"username": username, "password": password})


# --------------------------------------------------------------------------- #
# Pure policy helper
# --------------------------------------------------------------------------- #
def test_password_policy_helper() -> None:
    # PASSES → None.
    assert password_policy_error(_STRONG, "root") is None
    # Too short.
    assert password_policy_error("Short1!", "root") is not None
    assert password_policy_error("x" * (_MIN_PASSWORD_LEN - 1), "root") is not None
    # Exactly the minimum length (and not common / not == username) passes.
    assert password_policy_error("aZ9$" + "q" * (_MIN_PASSWORD_LEN - 4), "root") is None
    # Equal to the username (case-insensitive, trimmed).
    assert password_policy_error("RootRootRoot", "rootrootroot") is not None
    assert password_policy_error("  RootRootRoot  ", "rootrootroot") is not None
    # A trivially-common password (case-insensitive) — even if long enough.
    assert "administrator" in _COMMON_PASSWORDS
    assert password_policy_error("Administrator", "someone") is not None
    assert password_policy_error("changeme123", "someone") is not None


# --------------------------------------------------------------------------- #
# GET /api/setup/status shape
# --------------------------------------------------------------------------- #
def test_status_shape_before_and_after() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="stat", auth_seed_admin=False) as c:
        st = c.get("/api/setup/status").json()
        # The Wave-4 contract fields are present.
        assert st["setup_complete"] is False
        assert st["auth_enabled"] is True
        # has_admin is derivable from user_count (superset shape from the monolith).
        assert st["user_count"] == 0            # → has_admin False
        # Create the first admin, then user_count flips → has_admin True.
        r = c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        assert r.status_code == 200, r.text
        st2 = c.get("/api/setup/status").json()
        assert st2["user_count"] == 1           # → has_admin True


# --------------------------------------------------------------------------- #
# POST /api/setup/account — happy path (hashed, logs in, self-locks)
# --------------------------------------------------------------------------- #
def test_account_creates_super_admin_hashed_and_login() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="acct", auth_seed_admin=False) as c:
        r = c.post("/api/setup/account", json={
            "username": "root", "password": _STRONG, "display_name": "Root Operator",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        # #9 — the password is NEVER echoed; only booleans + the username/role.
        assert body["ok"] is True
        assert body["username"] == "root"
        assert body["role"] == "super_admin"
        assert _STRONG not in r.text
        assert "password" not in r.text.lower()

        # The created admin logs in with the CHOSEN password → proves the stored hash
        # verifies against the plaintext (and it was stored as super_admin).
        assert _login(c, "root", _STRONG).status_code == 200
        me = c.get("/api/auth/me").json()
        assert me["authenticated"] is True
        assert me["user"]["role"] == "super_admin"

        # The optional display_name was persisted onto the account.
        state = c.app.state.tlsoc
        user = c.portal.call(state.users.get, "root")
        assert user is not None
        assert user.display_name == "Root Operator"


def test_account_stored_password_is_hashed_not_plaintext() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="hash", auth_seed_admin=False) as c:
        r = c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        assert r.status_code == 200, r.text
        # Read the stored user record straight off the app's store (async, on the
        # TestClient's own event loop via the anyio portal).
        state = c.app.state.tlsoc
        user = c.portal.call(state.users.get, "root")
        assert user is not None
        assert user.role == "super_admin"
        assert user.password_hash != _STRONG          # NEVER the plaintext
        assert user.password_hash.startswith("pbkdf2_sha256$")
        assert verify_password(_STRONG, user.password_hash) is True
        assert verify_password("wrong-password-xx", user.password_hash) is False


# --------------------------------------------------------------------------- #
# Weak-password rejection (400)
# --------------------------------------------------------------------------- #
def test_account_rejects_weak_passwords() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="weak", auth_seed_admin=False) as c:
        # Too short.
        r = c.post("/api/setup/account", json={"username": "root", "password": "Short1!"})
        assert r.status_code == 400, r.text
        # == username.
        r = c.post("/api/setup/account", json={"username": "rootoperator", "password": "rootoperator"})
        assert r.status_code == 400, r.text
        # Trivially common.
        r = c.post("/api/setup/account", json={"username": "root", "password": "changeme123"})
        assert r.status_code == 400, r.text
        # No user was created by any rejected attempt → the OOBE state is intact.
        assert c.get("/api/setup/status").json()["user_count"] == 0


# --------------------------------------------------------------------------- #
# Self-lock: second call 409s; setup_complete → 403
# --------------------------------------------------------------------------- #
def test_account_self_locks_after_first_success() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="lock", auth_seed_admin=False) as c:
        r = c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        assert r.status_code == 200, r.text
        # A SECOND call cannot add/escalate an account — an admin already exists → 409.
        r2 = c.post("/api/setup/account", json={"username": "evil", "password": _STRONG + "z"})
        assert r2.status_code == 409, r2.text
        # The original admin still exists / logs in; the evil account was NOT created.
        assert c.get("/api/setup/status").json()["user_count"] == 1
        assert _login(c, "root", _STRONG).status_code == 200
        assert _login(c, "evil", _STRONG + "z").status_code == 401


def test_account_blocked_once_setup_complete() -> None:
    # setup_complete flipped True (a bootstrapped platform) → the account step is locked.
    with _build_client(
        auth_enabled=True, auth_jwt_secret="done", auth_seed_admin=False,
        setup_complete=True,
    ) as c:
        r = c.post("/api/setup/account", json={"username": "late", "password": _STRONG})
        assert r.status_code == 403, r.text
        assert c.get("/api/setup/status").json()["user_count"] == 0


def test_account_409_when_seeded_admin_exists() -> None:
    # The demo seed (Admin/Admin@123) means an admin already exists → account 409s even
    # at first-run, so the OOBE writer never shadows/escalates the seeded credential.
    with _build_client(auth_enabled=True, auth_jwt_secret="seed") as c:
        assert c.get("/api/setup/status").json()["user_count"] == 1   # seeded Admin
        r = c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        assert r.status_code == 409, r.text


# --------------------------------------------------------------------------- #
# Auth OFF — the account step is blocked (no-op) and byte-identical default
# --------------------------------------------------------------------------- #
def test_account_blocked_when_auth_disabled() -> None:
    with _build_client(auth_enabled=False) as c:
        r = c.post("/api/setup/account", json={"username": "root", "password": _STRONG})
        assert r.status_code == 400, r.text
        # No user created; the default no-auth profile is unchanged.
        assert c.get("/api/setup/status").json()["user_count"] == 0
        assert c.get("/api/setup/status").json()["auth_enabled"] is False


# --------------------------------------------------------------------------- #
# Missing / empty username rejected
# --------------------------------------------------------------------------- #
def test_account_rejects_empty_username() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="empty", auth_seed_admin=False) as c:
        r = c.post("/api/setup/account", json={"username": "   ", "password": _STRONG})
        assert r.status_code == 400, r.text


# --------------------------------------------------------------------------- #
# H4 / FINDING #13 — concurrent first-run setup creates EXACTLY ONE admin
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def _live_state(**secret_overrides):
    """A started AppState (auth ON, seeding OFF, setup_complete False) for driving the
    setup_account coroutine directly under asyncio concurrency."""
    setup_complete = secret_overrides.pop("setup_complete", False)
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="conc", auth_seed_admin=False,
        **secret_overrides,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(deep=True)
    prefs.setup_complete = setup_complete
    await state.update_prefs(prefs)
    try:
        yield state
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_store_create_if_absent_is_serialized_under_concurrency() -> None:
    # Two concurrent create_if_absent seeds on ONE store → exactly one user, no
    # last-writer-wins clobber (the asyncio.Lock serializes the read-check-write).
    store = UserStore(EsKVStore(InMemoryESClient()))
    results = await asyncio.gather(
        store.create_if_absent(username="alpha", password_hash=hash_password(_STRONG)),
        store.create_if_absent(username="beta", password_hash=hash_password(_STRONG)),
    )
    created = [u for u in results if u is not None]
    assert len(created) == 1                 # exactly ONE winner
    assert await store.count() == 1          # store holds a single admin
    # The other call observed the non-empty store and returned None (no clobber).
    assert sum(1 for u in results if u is None) == 1


def _route_request(state: AppState) -> Request:
    """A minimal request for driving the route coroutine directly: the route reads it
    only for its audit context (Round 14 SPEC §4.5.4), never for a credential."""
    app = SimpleNamespace(state=SimpleNamespace(tlsoc=state))
    return Request({"type": "http", "method": "POST", "path": "/api/setup/account",
                    "headers": [], "client": ("203.0.113.5", 41000), "app": app})


@pytest.mark.asyncio
async def test_two_concurrent_setup_account_calls_create_one_admin() -> None:
    # Drive the setup_account coroutine directly (bypassing the sync TestClient portal
    # so the two calls genuinely interleave on the event loop). Exactly ONE admin is
    # created; the loser 409s — no duplicate/last-writer-wins bootstrap (FINDING #13).
    async with _live_state() as state:
        body_a = SetupAccountBody(username="alpha", password=_STRONG)
        body_b = SetupAccountBody(username="beta", password=_STRONG)
        results = await asyncio.gather(
            setup_account(body_a, _route_request(state), state=state),
            setup_account(body_b, _route_request(state), state=state),
            return_exceptions=True,
        )
        oks = [r for r in results if isinstance(r, dict) and r.get("ok")]
        conflicts = [r for r in results if isinstance(r, HTTPException) and r.status_code == 409]
        assert len(oks) == 1, results          # exactly ONE admin created
        assert len(conflicts) == 1, results    # the other lost the race → 409
        assert await state.users.count() == 1  # store holds a single admin
        # Audit before visible (Round 14 SPEC §3.6): both attempts were recorded before
        # the store write; the one that lost the race is paired with its failure row.
        rows = await state.control_audit.records(limit=50)
        created = [r for r in rows if r.get("action") == "user.created"]
        failed = [r for r in rows if r.get("action") == "user.create_failed"]
        assert len(created) == 2 and len(failed) == 1
        assert failed[0]["outcome"] == "failure"
        assert failed[0]["request_id"] in {r["request_id"] for r in created}


# --------------------------------------------------------------------------- #
# H4 / FINDING #12 — a store-read glitch FAILS SAFE (503), never fails open
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_account_fails_safe_on_store_read_glitch() -> None:
    # If the user-store probe RAISES (a real read glitch), the OOBE gate must refuse
    # (503) rather than silently proceed to a 2nd bootstrap. The raising has_any()
    # probe surfaces the error (count()/_load() would swallow it → fail OPEN).
    async with _live_state() as state:
        async def _boom() -> bool:
            raise RuntimeError("simulated store read failure")

        state.users.has_any = _boom  # type: ignore[method-assign]
        body = SetupAccountBody(username="root", password=_STRONG)
        with pytest.raises(HTTPException) as ei:
            await setup_account(body, _route_request(state), state=state)
        assert ei.value.status_code == 503
        # No user was created — the glitch blocked the bootstrap (fail-safe).
        assert await state.users.count() == 0


@pytest.mark.asyncio
async def test_has_any_raises_on_kv_read_error() -> None:
    # The raising probe itself: has_any() propagates a KV load error (unlike count(),
    # which swallows it and returns 0). This is the primitive that makes the gate safe.
    class _BoomKV:
        async def get(self, ns: str, key: str):
            raise RuntimeError("kv down")

        async def put(self, ns: str, key: str, value):  # pragma: no cover - unused
            return None

    store = UserStore(_BoomKV())  # type: ignore[arg-type]
    with pytest.raises(RuntimeError):
        await store.has_any()
    # count() stays swallowing (degrades to 0) — proving has_any() is the safe probe.
    assert await store.count() == 0
