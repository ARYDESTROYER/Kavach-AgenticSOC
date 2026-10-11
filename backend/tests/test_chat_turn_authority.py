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
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException, Request, Response

from app.api import routes_chat
from app.api.deps import require_auth
from app.api.routes import auth_logout, delete_user, revoke_other_sessions, update_user
from app.api.routes import RevokeOthersBody, UserUpdateBody
from app.api.routes_chat import (
    ChatTurnRegistry,
    _relay,
    recheck_chat_turns_for,
    run_chat_blocking,
    run_chat_turn,
    stop_chat_turns_for,
    turn_authority_lost,
)
from app.auth.passwords import hash_password
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.models import ChatRequest
from app.state import AppState
from tests.test_chat_routes_stream import FINAL, TOOL_STEP, GatedProvider, _drain

PASSWORD = "carol-pass-12345"


def _secrets() -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret="x" * 40, auth_seed_admin=True,
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
