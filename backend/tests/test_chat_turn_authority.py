"""A running chat turn acts for its owner only while that authority lasts.

Round 12 final review (L1-0, F1). In the default unlimited mode a turn may run for up
to the hidden fuse (60 minutes, 200 model calls). Before this fix its grants were
resolved once, at admission, and nothing re-checked them: revoking the session,
disabling or deleting the account, or demoting its role left running turns making
lookups and model calls, streaming and saving for up to an hour.

Two mechanisms, both tested here:

* PUSH — the session and account routes stop the owner's running turns at once
  (``stop_chat_turns_for`` / ``recheck_chat_turns_for``): an in-flight model call is
  abandoned, nothing is saved and the stream ends with a non-retryable ``turn.error``.
* PULL — ``_drive`` re-checks before every model step and lookup batch (each is
  announced with ``step.start`` before any work), so a revocation no route reported
  (here: direct store writes, exactly the reviewer's reproduction) still ends the turn
  before its next lookup.
"""

from __future__ import annotations

import asyncio
import time
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException, Request, Response

import app.auth.tokens as tokens_mod
import app.stores.sessions as sessions_mod
from app.api import routes_chat
from app.api.deps import live_session_limits, require_auth
from app.api.routes import auth_logout, auth_refresh, delete_user, revoke_other_sessions, update_user
from app.api.routes import RefreshBody, RevokeOthersBody, UserUpdateBody
from app.api.routes_chat import (
    ChatTurnRegistry,
    _relay,
    rebind_chat_turns_for,
    recheck_chat_turns_for,
    run_chat_blocking,
    run_chat_turn,
    stop_chat_turns_for,
    turn_authority_lost,
)
from app.auth.passwords import hash_password
from app.stores.sessions import hash_refresh, new_refresh_token
from app.utils import now_utc
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.models import ChatRequest
from app.state import AppState
from tests.test_chat_routes_stream import FINAL, TOOL_STEP, GatedProvider, _drain

PASSWORD = "carol-pass-12345"


def _secrets(**overrides: Any) -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret="x" * 40, auth_seed_admin=True,
        **overrides,
    )


@pytest.fixture
async def auth_state():
    provider = GatedProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    state = AppState.create(secrets=_secrets(), es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={
        "setup_complete": True, "rbac": state.prefs.rbac.model_copy(update={"enabled": True}),
    }))
    try:
        yield state, provider
    finally:
        provider.gate.set()
        await state.shutdown()


def _request(state: AppState, token: str | None, path: str = "/api/chat/stream",
             method: str = "POST") -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
    return Request({
        "type": "http", "method": method, "path": path, "query_string": b"",
        "headers": headers, "app": app, "client": ("10.0.0.5", 9),
    })


async def _session(state: AppState, username: str, password: str) -> str:
    token = state.auth.authenticate(username, password)
    assert token
    await require_auth(_request(state, token, "/api/cases", "GET"))  # registers the sid
    return token


async def _user(state: AppState, username: str = "carol", role: str = "soc_manager") -> str:
    await state.users.create(
        username=username, password_hash=hash_password(PASSWORD), role=role, active=True,
    )
    await state.refresh_users()
    return await _session(state, username, PASSWORD)


async def _start(state: AppState, token: str, key: str):
    body = ChatRequest(message="brute force?", persist_conversation=True, idempotency_key=key)
    return await run_chat_turn(_request(state, token), body, state)


def _chat_calls(provider: GatedProvider) -> int:
    return len([c for c in provider.calls if c["role"] == "chat"])


def _tool_steps(events: list[Any]) -> list[Any]:
    return [e for e in events if e.type in ("step.start", "step.end") and e.step.kind == "tool"]


async def _conversations(state: AppState, user: str) -> list[Any]:
    conversations, _total = await state.chat_conversations.list_for_user(user)
    return list(conversations)


# --------------------------------------------------------------------------- #
# PULL: the reviewer's reproduction (direct store writes, no route involved).
# --------------------------------------------------------------------------- #
async def test_revoked_and_disabled_account_runs_no_further_lookup_or_model_call(auth_state) -> None:
    state, provider = auth_state
    token = await _session(state, "Admin", "Admin@123")
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    start = await _start(state, token, "revoke-0001")
    handle = start.handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    # The administrator ends the account while the first model call is in flight.
    await state.sessions.revoke_all("Admin", by="security", reason="admin_revoke")
    await state.users.update("Admin", active=False)
    await state.refresh_users()
    with pytest.raises(HTTPException) as denied:
        await require_auth(_request(state, token, "/api/cases", "GET"))
    assert denied.value.status_code == 401
    provider.gated = False
    provider.gate.set()                                   # the in-flight call returns
    events = await asyncio.wait_for(reader, 10)
    # No lookup ran (not even announced), no further model call, nothing saved.
    assert _tool_steps(events) == []
    assert _chat_calls(provider) == 1
    final = events[-1]
    assert final.type == "turn.error" and final.retryable is False
    assert "session ended" in final.message.lower()
    assert not [e for e in events if e.type == "turn.done"]
    assert await _conversations(state, "Admin") == []
    assert state.chat_turns.active == 0


async def test_session_revoked_by_store_ends_the_turn_before_its_next_step(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    handle = (await _start(state, token, "revoke-0002")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await state.sessions.revoke(handle.sid, by="carol", reason="logout")   # no route, no push
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert _tool_steps(events) == [] and _chat_calls(provider) == 1
    assert events[-1].type == "turn.error" and "session ended" in events[-1].message.lower()


async def test_demoted_role_ends_the_turn_with_access_changed(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state, role="soc_manager")
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    handle = (await _start(state, token, "demote-0001")).handle
    assert ("users", "manage") in handle.grants       # responder does not hold it
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await state.users.update("carol", role="responder")    # fewer grants than soc_manager
    await state.refresh_users()
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_ACCESS_CHANGED
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert _tool_steps(events) == [] and _chat_calls(provider) == 1
    final = events[-1]
    assert final.type == "turn.error" and final.retryable is False
    assert "access changed" in final.message.lower()


async def test_a_change_that_keeps_every_grant_never_stops_the_turn(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state, role="analyst_tier1")
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    handle = (await _start(state, token, "promote-0001")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await state.users.update("carol", role="super_admin")   # a promotion only adds grants
    await state.refresh_users()
    assert await recheck_chat_turns_for(state, "carol") == 0
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert events[-1].type == "turn.done" and events[-1].response.message_id
    assert [e.step.tool for e in events if e.type == "step.end" and e.step.kind == "tool"] == ["mitre_lookup"]


async def test_a_new_account_of_the_same_name_does_not_inherit_the_turn(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    handle = (await _start(state, token, "recreate-0001")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    # Delete and re-create "carol" behind the routes' back (a new account generation).
    await state.users.delete("carol")
    await state.users.create(
        username="carol", password_hash=hash_password(PASSWORD), role="soc_manager", active=True,
    )
    await state.refresh_users()
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert _tool_steps(events) == [] and events[-1].type == "turn.error"


# --------------------------------------------------------------------------- #
# PUSH: the routes stop running turns at once (an in-flight call is abandoned).
# --------------------------------------------------------------------------- #
async def test_admin_revoke_all_stops_the_turn_mid_call_and_forgets_its_ring(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    handle = (await _start(state, token, "push-0001")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await state.sessions.revoke_all("carol", by="admin", reason="admin_revoke_all")
    assert await stop_chat_turns_for(state, "carol") == 1
    # The gate was never opened: the turn ended while its model call was in flight.
    events = await asyncio.wait_for(reader, 5)
    assert not provider.gate.is_set()
    assert events[-1].type == "turn.error" and events[-1].retryable is False
    assert _tool_steps(events) == []
    assert state.chat_turns.active == 0
    assert state.chat_turns.find(handle.turn_id, handle.owner, handle.generation) is None
    assert await _conversations(state, "carol") == []
    # The same key is released: nothing was saved and nothing holds it.
    assert handle.response is None
    # The abandoned model call is still in the usage ledger (#6), exactly once.
    rows: list[dict] = []
    for _ in range(50):
        rows = [r for r in await state.usage_store.records(limit=50) if r.get("surface") == "chat"]
        if rows:
            break
        await asyncio.sleep(0.02)
    assert len(rows) == 1 and rows[0].get("failure_class") == "abandoned"


async def test_logout_stops_only_the_turns_that_session_started(auth_state) -> None:
    state, provider = auth_state
    token_a = await _user(state)
    token_b = await _session(state, "carol", PASSWORD)
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    turn_a = (await _start(state, token_a, "device-a-0001")).handle
    reader_a = asyncio.ensure_future(_drain(_relay(turn_a)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    turn_b = (await _start(state, token_b, "device-b-0001")).handle
    reader_b = asyncio.ensure_future(_drain(_relay(turn_b)))
    assert turn_a.sid and turn_b.sid and turn_a.sid != turn_b.sid
    await auth_logout(_request(state, token_a, "/api/auth/logout"), Response(), state)
    events_a = await asyncio.wait_for(reader_a, 5)
    assert events_a[-1].type == "turn.error" and "session ended" in events_a[-1].message.lower()
    assert not turn_b.finished.is_set()
    provider.gated = False
    provider.gate.set()
    events_b = await asyncio.wait_for(reader_b, 10)
    assert events_b[-1].type == "turn.done"


async def test_sign_out_other_devices_keeps_this_devices_turn(auth_state) -> None:
    state, provider = auth_state
    token_keep = await _user(state)
    token_other = await _session(state, "carol", PASSWORD)
    provider.push("chat", FINAL)
    other = (await _start(state, token_other, "other-0001")).handle
    other_reader = asyncio.ensure_future(_drain(_relay(other)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    kept = (await _start(state, token_keep, "keep-0001")).handle
    kept_reader = asyncio.ensure_future(_drain(_relay(kept)))
    await revoke_other_sessions(
        RevokeOthersBody(), _request(state, token_keep, "/api/sessions/revoke-others"), state,
    )
    assert (await asyncio.wait_for(other_reader, 5))[-1].type == "turn.error"
    assert not kept.finished.is_set()
    provider.push("chat", FINAL)
    provider.gated = False
    provider.gate.set()
    assert (await asyncio.wait_for(kept_reader, 10))[-1].type == "turn.done"


async def test_disabling_or_deleting_the_account_through_the_routes_stops_its_turns(auth_state) -> None:
    state, provider = auth_state
    admin = await _session(state, "Admin", "Admin@123")
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    handle = (await _start(state, token, "disable-0001")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await update_user("carol", UserUpdateBody(active=False), _request(state, admin, "/api/users/carol", "PUT"), state)
    events = await asyncio.wait_for(reader, 5)
    assert events[-1].type == "turn.error" and not provider.gate.is_set()
    # Re-enabled, the account starts a new turn; deleting the account stops it too.
    await update_user("carol", UserUpdateBody(active=True), _request(state, admin, "/api/users/carol", "PUT"), state)
    token = await _session(state, "carol", PASSWORD)
    second = (await _start(state, token, "delete-0001")).handle
    second_reader = asyncio.ensure_future(_drain(_relay(second)))
    await asyncio.sleep(0)
    await delete_user("carol", _request(state, admin, "/api/users/carol", "DELETE"), state)
    assert (await asyncio.wait_for(second_reader, 5))[-1].type == "turn.error"
    assert state.chat_turns.active == 0


async def test_blocking_chat_answers_401_when_the_session_ends(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    body = ChatRequest(message="brute force?", persist_conversation=True, idempotency_key="block-0001")
    waiter = asyncio.ensure_future(run_chat_blocking(_request(state, token, "/api/chat"), body, state))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await stop_chat_turns_for(state, "carol")
    with pytest.raises(HTTPException) as exc:
        await asyncio.wait_for(waiter, 5)
    assert exc.value.status_code == 401
    assert exc.value.detail["reason"] == "session_ended"


async def test_a_turn_stopped_before_its_first_step_still_ends_cleanly(auth_state) -> None:
    state, provider = auth_state
    token = await _user(state)
    handle = (await _start(state, token, "early-0001")).handle
    # Stopped before the task took its first step: flagged, never hard-cancelled.
    assert not handle.running
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    assert await stop_chat_turns_for(state, "carol") == 1
    events = await asyncio.wait_for(reader, 5)
    assert events[0].type == "turn.start" and events[-1].type == "turn.error"
    assert _chat_calls(provider) == 0 and state.chat_turns.active == 0


# --------------------------------------------------------------------------- #
# The check itself.
# --------------------------------------------------------------------------- #
async def test_the_check_needs_no_io_with_auth_off_and_is_fail_soft() -> None:
    state = AppState.create(
        secrets=Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                        anthropic_api_key=None, openai_api_key=None),
        es=InMemoryESClient(),
    )
    handle = routes_chat.ChatTurnHandle(turn_id="turn-x", owner="default")
    assert await turn_authority_lost(state, handle) is None
    assert await stop_chat_turns_for(state, "") == 0
    assert await recheck_chat_turns_for(state, "anyone") == 0


async def test_registry_stop_owner_selects_by_session_and_generation() -> None:
    registry = ChatTurnRegistry()
    a = routes_chat.ChatTurnHandle(turn_id="t-a", owner="carol", sid="s1", generation="g1")
    b = routes_chat.ChatTurnHandle(turn_id="t-b", owner="carol", sid="s2", generation="g1")
    c = routes_chat.ChatTurnHandle(turn_id="t-c", owner="dave", sid="s3")
    for handle in (a, b, c):
        registry.register(handle)
    assert await registry.stop_owner("carol", sid="s1") == 1
    assert a.stop_reason == routes_chat.STOP_SESSION_ENDED and a.cancel_event.is_set()
    assert b.stop_reason is None and not a.forget
    assert await registry.stop_owner("carol", except_sid="s2", generation="g1") == 1  # a again
    assert b.stop_reason is None
    assert await registry.stop_owner("carol", generation="other") == 0
    assert await registry.stop_owner("carol") == 2
    assert b.forget and b.stop_reason == routes_chat.STOP_SESSION_ENDED
    assert c.stop_reason is None


# --------------------------------------------------------------------------- #
# PULL: the end of the sign-in itself (final review, L1). A standard sign-in ends
# when its access token expires (``AUTH_TOKEN_HOURS``, 12 h by default), long before
# the registry row's own idle (12 h) or absolute (30 d) limit. The check used to
# judge only the row's limits, so a turn kept making lookups and model calls and
# saved its answer, outside the AI budget, for up to the hour-long fuse after the
# console had been signed out.
# --------------------------------------------------------------------------- #
_REAL_TIME = time.time


@pytest.fixture
async def short_auth_state():
    """Auth on with one-hour access tokens."""
    provider = GatedProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    state = AppState.create(
        secrets=_secrets(auth_token_hours=1), es=InMemoryESClient(), provider_overrides=overrides,
    )
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    try:
        yield state, provider
    finally:
        provider.gate.set()
        await state.shutdown()


def _clock(monkeypatch: pytest.MonkeyPatch, minutes: float) -> None:
    """Move every clock a sign-in is judged by ``minutes`` past real time: access
    token minting and verification, the session registry, and the turn check."""
    shift = minutes * 60

    def later():
        return now_utc() + timedelta(seconds=shift)

    monkeypatch.setattr(tokens_mod, "time", SimpleNamespace(time=lambda: _REAL_TIME() + shift))
    monkeypatch.setattr(sessions_mod, "now_utc", later)
    monkeypatch.setattr(routes_chat, "now_utc", later)


async def _row_alone_allows(state: AppState, sid: str) -> bool:
    """Whether the registry row's own idle and absolute limits still allow ``sid``."""
    row = await state.sessions.get(sid)
    principal = state.auth.principal("carol")
    return row is not None and state.sessions.is_active(
        row, **live_session_limits(state, principal).kwargs(),
    ) is None


async def test_a_turn_stops_once_the_access_token_that_started_it_expires(
    short_auth_state, monkeypatch,
) -> None:
    state, provider = short_auth_state
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    handle = (await _start(state, token, "expiry-0001")).handle
    assert handle.token_expires_at == state.auth.claims_of(token)["exp"]
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    _clock(monkeypatch, 50)                     # inside the one-hour token: still running
    assert await turn_authority_lost(state, handle) is None
    _clock(monkeypatch, 70)                     # the token expired at 60 minutes
    with pytest.raises(HTTPException) as denied:
        await require_auth(_request(state, token, "/api/cases", "GET"))
    assert denied.value.status_code == 401
    assert await _row_alone_allows(state, handle.sid)   # what the check used to judge
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    provider.gated = False
    provider.gate.set()                                  # the in-flight call returns
    events = await asyncio.wait_for(reader, 10)
    # The lookup it planned never ran, no further model call, nothing saved.
    assert _tool_steps(events) == [] and _chat_calls(provider) == 1
    final = events[-1]
    assert final.type == "turn.error" and final.retryable is False
    assert "session ended" in final.message.lower()
    assert not [e for e in events if e.type == "turn.done"]
    assert await _conversations(state, "carol") == []
    assert state.chat_turns.active == 0


async def test_a_token_expiring_during_admission_keeps_the_turn_bound_to_its_sign_in(
    short_auth_state, monkeypatch,
) -> None:
    """The turn reads the sign-in it acts for before it awaits anything. Admission
    (grants, account generation, the transcript read and the reservation) can take
    seconds on a long conversation; a token that was valid when the request was
    authenticated and expired during that work used to leave the turn bound to no
    session at all (sid, token version and expiry all ``None``): no expiry stop, no
    session-row check, and a sign-out push that found nothing to stop."""
    state, provider = short_auth_state
    token = await _user(state)
    claims = state.auth.claims_of(token)
    real_prepare = routes_chat._prepare

    async def slow_prepare(*args: Any, **kwargs: Any) -> Any:
        _clock(monkeypatch, 61)                 # the token expires mid-admission
        return await real_prepare(*args, **kwargs)

    _clock(monkeypatch, 59.95)                  # authenticated 3 s before ``exp``
    await require_auth(_request(state, token, "/api/cases", "GET"))
    monkeypatch.setattr(routes_chat, "_prepare", slow_prepare)
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    handle = (await _start(state, token, "expiry-admit-1")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    assert handle.sid == claims["sid"]
    assert handle.token_version == int(claims.get("tv", 0) or 0)
    assert handle.token_expires_at == claims["exp"]
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    # The sign-out push for that session finds the turn too.
    assert await stop_chat_turns_for(state, "carol", sid=claims["sid"]) == 1
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert _tool_steps(events) == [] and events[-1].type == "turn.error"
    assert not [e for e in events if e.type == "turn.done"]
    assert await _conversations(state, "carol") == []


async def test_session_identity_reads_an_expired_token_but_never_a_forged_one(
    short_auth_state, monkeypatch,
) -> None:
    """``_session_identity`` skips only the expiry comparison: the signature still
    decides, so a token signed with another secret binds nothing."""
    state, _provider = short_auth_state
    token = await _user(state)
    claims = state.auth.claims_of(token)
    _clock(monkeypatch, 120)
    assert state.auth.claims_of(token) is None          # expired for every request
    sid, tv, exp = routes_chat._session_identity(_request(state, token), state)
    assert (sid, tv, exp) == (claims["sid"], int(claims.get("tv", 0) or 0), claims["exp"])
    body = {k: v for k, v in claims.items() if k not in ("iat", "exp")}
    forged = tokens_mod.encode(body, "y" * 40, expires_in_s=3600)
    assert routes_chat._session_identity(_request(state, forged), state) == (None, None, None)


async def test_the_session_row_records_the_end_of_the_sign_in(short_auth_state, monkeypatch) -> None:
    """The row's hard limit (absolute lifetime, or the access token's ``exp`` it
    records) ends the turn even when the turn has no token expiry of its own."""
    state, provider = short_auth_state
    token = await _user(state)
    provider.push("chat", TOOL_STEP)
    handle = (await _start(state, token, "expiry-0002")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    handle.token_expires_at = None             # judged by the registry row alone
    row = await state.sessions.get(handle.sid)
    assert row and row["token_expires_at"]
    _clock(monkeypatch, 50)
    assert await turn_authority_lost(state, handle) is None
    _clock(monkeypatch, 70)
    assert await _row_alone_allows(state, handle.sid)
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert _tool_steps(events) == [] and events[-1].type == "turn.error"


async def test_a_row_without_the_token_expiry_falls_back_to_the_admission_token(
    short_auth_state, monkeypatch,
) -> None:
    """A row that does not record the token's ``exp`` (registered by an older build)
    leaves the admission token's own ``exp`` in charge, and that check needs no I/O:
    a session registry that cannot be read never extends the turn past it."""
    state, provider = short_auth_state
    await state.users.create(
        username="carol", password_hash=hash_password(PASSWORD), role="soc_manager", active=True,
    )
    await state.refresh_users()
    token = state.auth.authenticate("carol", PASSWORD)
    claims = state.auth.claims_of(token)
    await state.sessions.create(
        sid=claims["sid"], username="carol", token_version=int(claims.get("tv", 0) or 0),
        idle_timeout=12 * 3600, absolute_lifetime=30 * 86400,
    )
    await require_auth(_request(state, token, "/api/cases", "GET"))
    assert (await state.sessions.get(claims["sid"]))["token_expires_at"] == ""
    provider.push("chat", TOOL_STEP)
    handle = (await _start(state, token, "expiry-0003")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    _clock(monkeypatch, 70)
    assert await _row_alone_allows(state, handle.sid)

    async def unreadable(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("registry down")

    monkeypatch.setattr(state.sessions, "get", unreadable)
    monkeypatch.setattr(state.sessions, "token_version_for", unreadable)
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    provider.gated = False
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert _tool_steps(events) == [] and events[-1].type == "turn.error"


async def test_a_refreshed_session_keeps_its_turn_until_the_refreshed_sign_in_ends(
    short_auth_state, monkeypatch,
) -> None:
    """``/auth/refresh`` re-keys the session row to a new sid and issues a new token.
    The turn follows: it outlives the token it was admitted with, and ending the
    refreshed session stops it (the pull check and the push both find it)."""
    state, provider = short_auth_state
    token = await _user(state)
    old_sid = state.auth.claims_of(token)["sid"]
    refresh = new_refresh_token()
    await state.sessions.rotate_refresh(old_sid, hash_refresh(refresh))
    provider.push("chat", TOOL_STEP)
    handle = (await _start(state, token, "refresh-0001")).handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    admitted_exp = handle.token_expires_at
    _clock(monkeypatch, 30)
    out = await auth_refresh(
        RefreshBody(refresh_token=refresh), _request(state, None, "/api/auth/refresh"),
        Response(), state,
    )
    assert out["sid"] != old_sid and handle.sid == out["sid"]
    assert handle.token_expires_at == state.auth.claims_of(out["token"])["exp"] > admitted_exp
    _clock(monkeypatch, 70)                     # past the first token, inside the new one
    assert await turn_authority_lost(state, handle) is None
    _clock(monkeypatch, 95)                     # past the refreshed token too
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    _clock(monkeypatch, 70)
    await state.sessions.revoke(out["sid"], by="carol", reason="logout")   # no push
    assert await turn_authority_lost(state, handle) == routes_chat.STOP_SESSION_ENDED
    assert await stop_chat_turns_for(state, "carol", sid=out["sid"]) == 1  # the push
    events = await asyncio.wait_for(reader, 5)
    assert events[-1].type == "turn.error" and _tool_steps(events) == []


def test_rebind_moves_only_the_refreshed_sessions_turns() -> None:
    state = SimpleNamespace(chat_turns=ChatTurnRegistry())
    a = routes_chat.ChatTurnHandle(turn_id="t-a", owner="carol", sid="s1", token_expires_at=100.0)
    b = routes_chat.ChatTurnHandle(turn_id="t-b", owner="carol", sid="s2", token_expires_at=100.0)
    c = routes_chat.ChatTurnHandle(turn_id="t-c", owner="dave", sid="s1", token_expires_at=100.0)
    for handle in (a, b, c):
        state.chat_turns.register(handle)
    assert rebind_chat_turns_for(state, "Carol", "s1", "s9", token_expires_at=200.0) == 1
    assert (a.sid, a.token_expires_at) == ("s9", 200.0)
    assert (b.sid, b.token_expires_at) == ("s2", 100.0)
    assert (c.sid, c.token_expires_at) == ("s1", 100.0)
    assert rebind_chat_turns_for(state, "carol", "", "s9") == 0
    assert rebind_chat_turns_for(state, "", "s1", "s9") == 0
