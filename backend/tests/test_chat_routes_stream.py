"""Chat turn routes: ``/chat/stream``, ``/chat``, Stop, concurrency and reset.

Chat revamp SPEC §6 (event order, completed-key replay, 409 in progress with
``retry_after``, the cancel endpoint, disconnect, reset cancellation), §4.2
(concurrency bounds → 429 ``chat_busy``), §4.5 (the D1 first-call failure), §3.1
(fingerprint compatibility, model choice) and §6 #6 (exactly one UsageDoc per model
call).

HTTP-level checks use a ``TestClient`` (it buffers a streamed body, which is fine for
ordering). Lifecycle checks that need a turn to be *running* drive
``run_chat_turn`` and the relay directly on the test's event loop, with a provider
that blocks on an ``asyncio.Event``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.agents.chat_events import parse_event
from app.api import routes_chat
from app.api.routes import _chat_request_fingerprint
from app.api.routes import router as base_router
from app.api.routes_chat import (
    ChatTurnRegistry,
    _relay,
    cancel_chat_turn,
    chat_request_fingerprint,
    run_chat_turn,
)
from app.api.routes_chat import router as chat_router
from app.config import Secrets
from app.constants import CHAT_CONVERSATIONS_NS
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import CaseMessage, ChatRequest
from app.state import AppState
from app.stores.chat_conversations import ChatHistoryUnavailable, partition_key_for_user

TOOL_STEP = json.dumps({"action": "tool", "tool": "mitre_lookup", "input": {"ids": ["T1110"]}})
FINAL = (
    json.dumps({"action": "final", "blocks": [{"ref": "t1.a1"}], "follow_ups": ["What next?"],
                "answer_kind": "data"})
    + "\n---ANSWER---\nBrute force is T1110."
)
DATA_QUESTION = "show failed logins from 10.0.0.1 in the last 24h"


class GatedProvider(MockProvider):
    """A MockProvider whose chat calls wait for ``gate`` while ``gated`` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.entered = asyncio.Event()
        self.gated = True

    async def complete(self, role, messages, model, temperature, max_tokens):  # noqa: ANN001
        if role == "chat" and self.gated:
            self.entered.set()
            await self.gate.wait()
        return await super().complete(role, messages, model, temperature, max_tokens)


class FailingProvider(MockProvider):
    """Every chat call fails before anything is billed (a D1 failure)."""

    async def complete(self, role, messages, model, temperature, max_tokens):  # noqa: ANN001
        if role == "chat":
            raise RuntimeError("upstream exploded with secret detail sk-123")
        return await super().complete(role, messages, model, temperature, max_tokens)


def _secrets() -> Secrets:
    return Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )


@contextmanager
def _client(provider: MockProvider) -> Iterator[TestClient]:
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=_secrets(), es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(base_router)
    api.include_router(chat_router)
    with TestClient(api) as client:
        yield client


@pytest.fixture
async def gated_state():
    provider = GatedProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    state = AppState.create(secrets=_secrets(), es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    try:
        yield state, provider
    finally:
        provider.gate.set()
        await state.shutdown()


def _request(state: AppState, path: str = "/api/chat/stream") -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    return Request({
        "type": "http", "method": "POST", "path": path, "headers": [], "query_string": b"",
        "app": app, "client": ("127.0.0.1", 9),
    })


def _events(text: str) -> list[Any]:
    return [parse_event(line) for line in text.splitlines() if line.strip()]


async def _drain(gen) -> list[Any]:  # noqa: ANN001
    return [parse_event(line) async for line in gen]


def _chat_calls(provider: MockProvider) -> int:
    return len([call for call in provider.calls if call["role"] == "chat"])


# --------------------------------------------------------------------------- #
# Event order, headers, replay (§6.1, §6.2).
# --------------------------------------------------------------------------- #
def test_stream_event_order_headers_and_persisted_turn_done() -> None:
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    with _client(provider) as client:
        response = client.post("/api/chat/stream", json={
            "message": "what is brute force", "persist_conversation": True,
            "idempotency_key": "stream-order-0001",
        })
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-accel-buffering"] == "no"
        events = _events(response.text)
        assert all(e is not None for e in events)
        types = [e.type for e in events]
        assert types == [
            "turn.start", "step.start", "step.end", "usage",            # model step 1 (tools)
            "step.start", "step.end",                                    # mitre_lookup
            "step.start", "step.end", "usage",                           # model step 2 (final)
            "turn.done",
        ]
        start, done = events[0], events[-1]
        assert start.replayed is False and start.conversation_id
        final = done.response
        assert final.answer == "Brute force is T1110."
        assert final.turn_id == start.turn_id
        assert final.conversation_id == start.conversation_id
        assert final.message_id and final.message_id.startswith("chatmsg-")
        assert final.usage is not None and final.usage.calls == 2
        assert [b["type"] for b in final.blocks] == ["mitre"]
        # The persisted transcript holds exactly that answer under that id.
        detail = client.get(f"/api/chat/conversations/{final.conversation_id}").json()
        assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
        assert detail["messages"][1]["id"] == final.message_id
        assert detail["messages"][1]["response"]["answer"] == final.answer


def test_completed_key_replay_streams_start_then_done_without_model_call() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        body = {"message": "summarise today", "persist_conversation": True,
                "idempotency_key": "stream-replay-0001"}
        first = _events(client.post("/api/chat/stream", json=body).text)
        before = _chat_calls(provider)
        again = client.post("/api/chat/stream", json=body)
        assert again.status_code == 200
        replayed = _events(again.text)
        assert [e.type for e in replayed] == ["turn.start", "turn.done"]
        assert replayed[0].replayed is True
        assert _chat_calls(provider) == before                     # no model call
        assert replayed[1].response.message_id == first[-1].response.message_id
        assert replayed[1].response.answer == first[-1].response.answer
        # One key is valid across /chat and /chat/stream (§3.1).
        blocking = client.post("/api/chat", json={**body, "stream_mode": "text"})
        assert blocking.status_code == 200
        assert blocking.json()["message_id"] == first[-1].response.message_id
        assert _chat_calls(provider) == before


def test_blocking_chat_response_carries_message_id_and_replays_identically() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        body = {"message": "posture please", "persist_conversation": True,
                "idempotency_key": "blocking-msgid-0001"}
        first = client.post("/api/chat", json=body)
        second = client.post("/api/chat", json=body)
        assert first.status_code == second.status_code == 200
        assert first.json()["message_id"] and first.json() == second.json()
        # A stateless call is never persisted and has no message id.
        stateless = client.post("/api/chat", json={"message": "hello"})
        assert stateless.json()["message_id"] is None and stateless.json()["conversation_id"] is None


def test_preflight_failures_are_http_errors_not_stream_errors() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        missing = client.post("/api/chat/stream", json={
            "message": "x", "persist_conversation": True, "conversation_id": "chat-missing",
        })
        assert missing.status_code == 404
        bad_source = client.post("/api/chat/stream", json={"message": "x", "source_id": "nope"})
        assert bad_source.status_code == 422
        assert bad_source.json()["detail"]["code"] == "chat_source_unavailable"
        bad_model = client.post("/api/chat/stream", json={"message": "x", "model": "no-such-model"})
        assert bad_model.status_code == 422
        assert bad_model.json()["detail"]["code"] == "chat_model_unavailable"
        bad_window = client.post("/api/chat/stream", json={
            "message": "x", "time_range": {"from": "now", "to": "now-1h"},
        })
        assert bad_window.status_code == 422
        assert _chat_calls(provider) == 0


def test_enabled_non_default_model_routes_by_the_registry() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        response = client.post("/api/chat", json={"message": "hi", "model": "claude-opus-4-8"})
        assert response.status_code == 200
        call = [c for c in provider.calls if c["role"] == "chat"][-1]
        assert call["model"] == "claude-opus-4-8"


def test_in_progress_key_is_409_with_retry_after_in_body_and_header() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        state = client.app.state.tlsoc
        body = ChatRequest(message="slow one", persist_conversation=True, idempotency_key="busy-key-0001")
        client.portal.call(_reserve, state, body)
        response = client.post("/api/chat/stream", json=body.model_dump(mode="json"))
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "chat_request_in_progress"
        assert detail["retry_after"] == routes_chat.IN_PROGRESS_RETRY_AFTER_S
        assert response.headers["retry-after"] == str(routes_chat.IN_PROGRESS_RETRY_AFTER_S)
        assert _chat_calls(provider) == 0


async def _reserve(state: AppState, body: ChatRequest) -> None:
    await state.chat_conversations.reserve_exchange(
        "", idempotency_key=body.idempotency_key or "",
        request_fingerprint=chat_request_fingerprint(body), conversation_id=None,
    )


# --------------------------------------------------------------------------- #
# D1 (§4.5): a first model call that fails is answered, never saved.
# --------------------------------------------------------------------------- #
def test_first_call_failure_returns_notice_and_persists_nothing() -> None:
    provider = FailingProvider()
    with _client(provider) as client:
        state = client.app.state.tlsoc
        blocking = client.post("/api/chat", json={
            "message": DATA_QUESTION, "persist_conversation": True,
            "idempotency_key": "d1-blocking-0001",
        })
        assert blocking.status_code == 200
        payload = blocking.json()
        assert payload["notice"]["kind"] in ("provider", "partial")
        assert payload["answer"] == payload["notice"]["message"]
        assert "sk-123" not in json.dumps(payload)                   # raw error text never leaks
        assert payload["conversation_id"] is None and payload["message_id"] is None
        assert payload["idempotency_key"] == "d1-blocking-0001"
        assert client.get("/api/chat/conversations").json()["total"] == 0

        streamed = _events(client.post("/api/chat/stream", json={
            "message": DATA_QUESTION, "persist_conversation": True,
            "idempotency_key": "d1-stream-0001",
        }).text)
        assert streamed[0].type == "turn.start"
        assert streamed[-1].type == "turn.error"
        assert streamed[-1].code in ("provider_unavailable", "internal")
        assert streamed[-1].notice is not None
        assert client.get("/api/chat/conversations").json()["total"] == 0
        # The reservation was aborted: the same key can run again, fresh.
        doc = client.portal.call(state.kv.get, CHAT_CONVERSATIONS_NS, partition_key_for_user(""))
        assert not (doc or {}).get("requests")


def test_save_failure_after_billing_keeps_the_reservation() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        store = client.app.state.tlsoc.chat_conversations

        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise ChatHistoryUnavailable("Chat history could not be saved.")

        store.complete_exchange = _broken          # the instance attribute shadows the method
        body = {"message": "posture?", "persist_conversation": True, "idempotency_key": "save-fail-0001"}
        blocking = client.post("/api/chat", json=body)
        assert blocking.status_code == 503
        assert blocking.json()["detail"]["code"] == "chat_history_unavailable"
        assert "Ask again" in blocking.json()["detail"]["message"]
        streamed = _events(client.post("/api/chat/stream", json={
            **body, "idempotency_key": "save-fail-0002",
        }).text)
        assert streamed[0].type == "turn.start" and streamed[-1].type == "turn.error"
        # Not retryable: the kept reservation would only answer "Retry same request"
        # with 409 in progress (the client would falsely say "still running"), so the
        # client offers Ask again, a new key.
        assert streamed[-1].code == "history_unavailable" and streamed[-1].retryable is False
        assert "Ask again" in streamed[-1].message
        # Billed, so never aborted: a retry with the same key waits instead of re-billing.
        again = client.post("/api/chat", json=body)
        assert again.status_code == 409
        assert again.json()["detail"]["code"] == "chat_request_in_progress"
        assert _chat_calls(provider) == 2


def test_unbilled_save_failure_aborts_and_stays_retryable() -> None:
    """A $0 answer (no model call billed) whose save fails is aborted, so Retry same
    request runs it fresh."""
    provider = MockProvider()
    with _client(provider) as client:
        state = client.app.state.tlsoc
        store = state.chat_conversations

        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise ChatHistoryUnavailable("Chat history could not be saved.")

        async def _unbilled_turn(message, prefs, *, outcome, turn_id, **_kwargs):  # noqa: ANN001
            from app.agents.chat_events import TurnStartEvent
            from app.models import ChatResponse

            yield TurnStartEvent(turn_id=turn_id)
            outcome.response = ChatResponse(answer="Open Settings.", turn_id=turn_id)
            outcome.persist = True
            outcome.billed = False

        store.complete_exchange = _broken
        state.chat_engine.run_turn = _unbilled_turn
        events = _events(client.post("/api/chat/stream", json={
            "message": "where are settings?", "persist_conversation": True,
            "idempotency_key": "save-fail-free-01",
        }).text)
        assert events[-1].type == "turn.error" and events[-1].retryable is True
        doc = client.portal.call(state.kv.get, CHAT_CONVERSATIONS_NS, partition_key_for_user(""))
        assert not (doc or {}).get("requests")                  # aborted: a retry runs fresh


# --------------------------------------------------------------------------- #
# Stop, disconnect, reset (§6.4, §6.1(b)).
# --------------------------------------------------------------------------- #
async def _start(state: AppState, **body: Any):
    request = ChatRequest(**{"message": "brute force?", "persist_conversation": True, **body})
    return await run_chat_turn(_request(state), request, state), request


async def test_cancel_endpoint_stops_the_turn_and_persists_the_billed_answer(gated_state) -> None:
    state, provider = gated_state
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    start, _body = await _start(state, idempotency_key="cancel-key-0001")
    handle = start.handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    # Unknown, or another principal's, turn: 404 / not stopped.
    with pytest.raises(HTTPException) as unknown:
        await cancel_chat_turn(_request(state), "turn-unknown", state)
    assert unknown.value.status_code == 404
    assert state.chat_turns.request_stop(handle.turn_id, "someone-else") is False
    stopped = await cancel_chat_turn(_request(state), handle.turn_id, state)
    assert stopped.model_dump() == {"ok": True, "turn_id": handle.turn_id}
    provider.gate.set()                                   # the in-flight call finishes
    events = await asyncio.wait_for(reader, 10)
    assert events[0].type == "turn.start" and events[-1].type == "turn.done"
    final = events[-1].response
    assert final.notice is not None and final.notice.kind == "cancelled"
    assert not [e for e in events if e.type == "step.start" and e.step.kind == "tool"]
    assert _chat_calls(provider) == 1                    # no new step after Stop
    chat_rows = [r for r in await state.usage_store.records(limit=50) if r.get("surface") == "chat"]
    assert len(chat_rows) == 1                           # the finished call, recorded once
    # A billed stop is COMPLETED, so a retry with the same key replays it.
    assert final.message_id
    replay, _ = await _start(state, idempotency_key="cancel-key-0001")
    assert replay.replay is not None and replay.replay.message_id == final.message_id


async def test_disconnect_does_not_stop_the_turn_and_retry_waits_then_replays(gated_state) -> None:
    state, provider = gated_state
    start, _body = await _start(state, idempotency_key="disconnect-key-0001")
    handle = start.handle
    relay = _relay(handle)
    first = parse_event(await relay.__anext__())
    assert first.type == "turn.start"
    await relay.aclose()                                  # the client went away
    assert handle.detached is True
    # While it runs, a reconnect with the same key is told to wait.
    with pytest.raises(HTTPException) as busy:
        await _start(state, idempotency_key="disconnect-key-0001")
    assert busy.value.status_code == 409
    assert busy.value.detail["retry_after"] == routes_chat.IN_PROGRESS_RETRY_AFTER_S
    provider.gate.set()
    await asyncio.wait_for(handle.finished.wait(), 10)
    conversation = await state.chat_conversations.get("", first.conversation_id)
    assert conversation is not None and len(conversation.messages) == 2
    replay, _ = await _start(state, idempotency_key="disconnect-key-0001")
    assert replay.replay is not None
    assert replay.replay.message_id == conversation.messages[1].id
    assert state.chat_turns.active == 0


async def test_factory_reset_cancels_running_turns_before_drain(gated_state) -> None:
    state, provider = gated_state
    start, _body = await _start(state, idempotency_key="reset-key-0001")
    handle = start.handle
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    await state.mutation_gate.close("reset-job-test")
    events = await asyncio.wait_for(reader, 10)
    assert events[-1].type == "turn.error" and events[-1].code == "internal"
    assert handle.task.cancelled() and handle.reset_cancelled
    # Drained: the turn released its admission, so the reset could proceed.
    await state.mutation_gate.wait_drained("reset-job-test", timeout=1.0)
    await state.mutation_gate.open("reset-job-test")
    # Nothing persisted, reservation aborted.
    page = await state.chat_conversations.list_page("")
    assert page.total == 0
    # The interrupted model call still has exactly ONE ledger row, never 0 input (#6).
    rows: list[dict] = []
    for _ in range(100):
        rows = [r for r in await state.usage_store.records(limit=50) if r.get("surface") == "chat"]
        if rows:
            break
        await asyncio.sleep(0.01)
    assert len(rows) == 1 and rows[0]["prompt_tokens"] > 0
    assert rows[0].get("failure_class") == "abandoned"
    doc = await state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user(""))
    assert not (doc or {}).get("requests")
    assert state.chat_turns.active == 0
    # A new turn is refused while a reset owns the gate.
    await state.mutation_gate.close("reset-job-2")
    with pytest.raises(HTTPException) as refused:
        await _start(state, idempotency_key="reset-key-0002")
    assert refused.value.status_code == 503
    await state.mutation_gate.open("reset-job-2")


async def _requests(state: AppState) -> list[str]:
    doc = await state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user(""))
    return list((doc or {}).get("requests", {}))


async def test_cancel_all_right_after_start_settles_an_unstarted_turn(gated_state) -> None:
    """Regression: ``cancel_all`` in the same loop iteration as a turn start (before
    the task's first step) must not strand the slot, the registration, the
    reservation or the waiters (a cancel thrown into an unstarted coroutine skips its
    try/finally)."""
    state, provider = gated_state
    start, _body = await _start(state, idempotency_key="race-key-0001")
    handle = start.handle
    assert handle.running is False                       # the task has not stepped yet
    assert await state.chat_turns.cancel_all(timeout=2.0) == 1
    assert handle.finished.is_set() and handle.reset_cancelled
    assert state.chat_turns.active == 0 and state.chat_turns.get(handle.turn_id) is None
    assert state.mutation_gate.active == 0               # never admitted, nothing to drain
    assert await _requests(state) == []                  # the reservation was aborted
    assert _chat_calls(provider) == 0
    events = await asyncio.wait_for(_drain(_relay(handle)), 2)
    assert [e.type for e in events] == ["turn.start", "turn.error"]
    assert events[0].turn_id == handle.turn_id and events[0].conversation_id
    assert events[1].code == "internal" and events[1].retryable is True
    # A blocking /chat waiter is released with the reset error, not left hanging.
    assert handle.response is None and handle.http_error is not None
    assert handle.http_error.status_code == 503
    assert handle.http_error.detail["code"] == "factory_reset_in_progress"


async def test_reset_closing_the_gate_as_a_turn_starts_still_drains(gated_state) -> None:
    state, provider = gated_state
    start, _body = await _start(state, idempotency_key="race-key-0002")
    handle = start.handle
    await state.mutation_gate.close("reset-race")        # cancels turns before draining
    await state.mutation_gate.wait_drained("reset-race", timeout=1.0)
    assert handle.finished.is_set() and state.chat_turns.active == 0
    events = await asyncio.wait_for(_drain(_relay(handle)), 2)
    assert [e.type for e in events] == ["turn.start", "turn.error"]
    assert await _requests(state) == [] and _chat_calls(provider) == 0
    await state.mutation_gate.open("reset-race")


async def test_a_turn_cancelled_outside_cancel_all_before_its_first_step_is_settled(gated_state) -> None:
    """Belt and braces: a cancel that bypasses ``cancel_all`` (an event-loop shutdown
    cancelling every task) still releases capacity, aborts the reservation and ends
    the waiters through the task's done-callback."""
    state, provider = gated_state
    start, _body = await _start(state, idempotency_key="race-key-0003")
    handle = start.handle
    handle.task.cancel()                                  # before its first step
    await asyncio.wait_for(handle.finished.wait(), 2)
    assert handle.task.cancelled() and handle.running is False
    assert state.chat_turns.active == 0 and state.chat_turns.get(handle.turn_id) is None
    assert await _requests(state) == []
    assert handle.error is not None and handle.error.code == "internal"
    assert _chat_calls(provider) == 0


def test_failure_before_the_engine_starts_still_opens_with_turn_start(monkeypatch) -> None:
    """SPEC §6.2: ``turn.start`` is always the first line, even when the turn fails
    before the engine emitted its own (an unreadable stored history here)."""
    provider = MockProvider()
    with _client(provider) as client:
        first = client.post("/api/chat", json={"message": "hello", "persist_conversation": True})
        conversation_id = first.json()["conversation_id"]

        def _broken(_conversation):  # noqa: ANN001, ANN202
            raise RuntimeError("corrupt stored history")

        monkeypatch.setattr(routes_chat, "_replay_messages", _broken)
        events = _events(client.post("/api/chat/stream", json={
            "message": "and now?", "persist_conversation": True, "conversation_id": conversation_id,
            "idempotency_key": "start-first-0001",
        }).text)
        assert [e.type for e in events] == ["turn.start", "turn.error"]
        assert events[0].conversation_id == conversation_id and events[0].turn_id
        assert events[1].code == "internal" and "corrupt" not in events[1].message
        # Nothing billed, so the reservation was released and Retry stays available.
        assert events[1].retryable is True


async def test_ping_lines_while_a_step_is_slow(gated_state, monkeypatch) -> None:
    state, provider = gated_state
    monkeypatch.setattr(routes_chat, "STREAM_PING_INTERVAL_S", 0.02)
    start, _ = await _start(state, idempotency_key="ping-key-0001")
    relay = _relay(start.handle)
    seen = []
    async for line in relay:
        event = parse_event(line)
        seen.append(event.type)
        if seen.count("ping") >= 2:
            break
    await relay.aclose()
    provider.gate.set()
    await asyncio.wait_for(start.handle.finished.wait(), 10)
    assert seen[0] == "turn.start" and "ping" in seen


# --------------------------------------------------------------------------- #
# Concurrency (§4.2): 429 chat_busy with Retry-After, before any work.
# --------------------------------------------------------------------------- #
async def test_per_user_and_global_concurrency_bounds(gated_state) -> None:
    state, provider = gated_state
    cfg = state.prefs.chat_agent.model_copy(update={
        "max_concurrent_turns_per_user": 1, "max_concurrent_turns_global": 1,
    })
    await state.update_prefs(state.prefs.model_copy(update={"chat_agent": cfg}))
    first, _ = await _start(state, idempotency_key="conc-key-0001")
    await asyncio.wait_for(provider.entered.wait(), 5)
    calls = _chat_calls(provider)
    with pytest.raises(HTTPException) as busy:
        await _start(state, idempotency_key="conc-key-0002")
    assert busy.value.status_code == 429
    assert busy.value.detail["code"] == "chat_busy"
    assert busy.value.detail["retry_after"] == routes_chat.CHAT_BUSY_RETRY_AFTER_S
    assert busy.value.headers["Retry-After"] == str(routes_chat.CHAT_BUSY_RETRY_AFTER_S)
    # A case-scoped turn shares the same bound.
    with pytest.raises(HTTPException):
        await run_chat_turn(_request(state), ChatRequest(message="x", case_id="case-1"), state)
    assert _chat_calls(provider) == calls                 # refused before any work
    page = await state.chat_conversations.list_page("")
    doc = await state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user(""))
    assert page.total == 0 and list((doc or {}).get("requests", {})) == ["conc-key-0001"]
    provider.gate.set()
    await asyncio.wait_for(first.handle.finished.wait(), 10)
    third, _ = await _start(state, idempotency_key="conc-key-0003")
    await asyncio.wait_for(third.handle.finished.wait(), 10)
    assert third.handle.response is not None


def test_registry_counts_per_owner_and_globally() -> None:
    registry = ChatTurnRegistry()
    a = registry.acquire("alice", per_user=2, global_limit=3)
    registry.acquire("alice", per_user=2, global_limit=3)
    with pytest.raises(routes_chat.ChatTurnBusy) as user_busy:
        registry.acquire("alice", per_user=2, global_limit=3)
    assert user_busy.value.scope == "user"
    registry.acquire("bob", per_user=2, global_limit=3)
    with pytest.raises(routes_chat.ChatTurnBusy) as global_busy:
        registry.acquire("carol", per_user=2, global_limit=3)
    assert global_busy.value.scope == "global"
    a.release()
    a.release()                                           # idempotent
    assert registry.active == 2 and registry.active_for("alice") == 1


# --------------------------------------------------------------------------- #
# #6: exactly one UsageDoc per model call; audit actor and turn ids (§5.2).
# --------------------------------------------------------------------------- #
def test_exactly_one_usage_doc_per_model_call_and_turn_ids_in_audit() -> None:
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    with _client(provider) as client:
        state = client.app.state.tlsoc
        events = _events(client.post("/api/chat/stream", json={"message": "brute force?"}).text)
        turn_id = events[0].turn_id
        rows = client.portal.call(_usage_rows, state)
        chat_rows = [r for r in rows if r.get("surface") == "chat"]
        assert len(chat_rows) == _chat_calls(provider) == 2
        audit = client.portal.call(_audit_rows, state)
        mine = [r for r in audit if f"turn={turn_id}" in str(r.get("result_summary") or "")]
        assert {r["action_type"] for r in mine} >= {"prompt", "tool_call"}
        assert all(r["actor"] == "default" for r in mine)      # auth off → "default"


async def _usage_rows(state: AppState) -> list[dict]:
    return await state.usage_store.records(limit=100)


async def _audit_rows(state: AppState) -> list[dict]:
    return await state.audit.records(limit=200)


# --------------------------------------------------------------------------- #
# Case-scoped entry point (§4.6).
# --------------------------------------------------------------------------- #
def test_case_scoped_turn_never_enters_workspace_history_and_dedupes_by_key() -> None:
    provider = MockProvider()
    with _client(provider) as client:
        state = client.app.state.tlsoc
        body = {"message": "what happened?", "case_id": "case-missing",
                "persist_conversation": True, "idempotency_key": "case-key-00001"}
        response = client.post("/api/chat", json=body)
        assert response.status_code == 200
        payload = response.json()
        assert payload["conversation_id"] is None and payload["message_id"] is None
        # The case does not exist: nothing is written, the notice says so.
        assert payload["notice"]["kind"] == "not_saved"
        assert client.get("/api/chat/conversations").json()["total"] == 0
        threads = client.portal.call(state.case_threads.list_for_case, "case-missing")
        assert threads == []


async def test_case_thread_append_if_absent_is_one_cas(app_state: AppState) -> None:
    store = app_state.case_threads
    message = CaseMessage(case_id="case-x", author_type="human", author="a", body="q", kind="chat")
    message.id = "msg-chat-fixed-q"
    results = await asyncio.gather(*(store.append_if_absent(message.model_copy()) for _ in range(5)))
    assert sum(1 for _stored, appended in results if appended) == 1
    assert [m.id for m in await store.list_for_case("case-x")] == ["msg-chat-fixed-q"]


class _UnwritableKV:
    """A KV whose reads work but whose compare-and-set never lands (or errors)."""

    def __init__(self, *, error: bool) -> None:
        self.error = error

    async def get(self, _ns: str, _key: str) -> dict | None:
        return None

    async def put_if(self, _ns: str, _key: str, _value: dict, _rev: int) -> bool:
        if self.error:
            raise ConnectionError("backend down")
        return False

    async def put(self, _ns: str, _key: str, _value: dict) -> None:  # pragma: no cover - put_if wins
        raise AssertionError("unconfirmed put must not be used")


@pytest.mark.parametrize("error", [True, False])
async def test_case_thread_append_if_absent_reports_an_unconfirmed_write(error: bool) -> None:
    """The best-effort store would report ``appended=True`` for a lost write; the
    keyed append raises instead, so the engine can say ``not_saved``."""
    from app.stores.case_thread import CaseThreadStore, CaseThreadWriteFailed

    store = CaseThreadStore(_UnwritableKV(error=error))
    message = CaseMessage(case_id="case-y", author_type="human", author="a", body="q", kind="chat")
    with pytest.raises(CaseThreadWriteFailed):
        await store.append_if_absent(message)


# --------------------------------------------------------------------------- #
# Fingerprint compatibility (§3.1).
# --------------------------------------------------------------------------- #
def _pre_revamp_fingerprint(body: ChatRequest) -> str:
    """The exact pre-revamp route formula over the pre-revamp fields."""
    payload = body.model_dump(mode="json", include={
        "message", "case_id", "history", "context", "model", "source_id", "conversation_id",
    })
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def test_openapi_documents_each_ndjson_line_and_typed_chat_responses() -> None:
    """The stream's 200 is exactly the event component (no ``type: string`` sibling,
    which OpenAPI 3.1 would AND with the ``$ref``), and the conversation and cancel
    routes declare their response models so the drift gate sees them."""
    api = FastAPI(separate_input_output_schemas=False)
    api.include_router(base_router)
    api.include_router(chat_router)
    spec = api.openapi()
    stream = spec["paths"]["/api/chat/stream"]["post"]["responses"]["200"]["content"]
    assert stream == {"application/x-ndjson": {"schema": {"$ref": "#/components/schemas/ChatStreamEventModel"}}}
    assert "ChatStreamEventModel" in spec["components"]["schemas"]

    def ref(path: str, method: str) -> str:
        return spec["paths"][path][method]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]

    assert ref("/api/chat/conversations", "get").endswith("/ChatConversationPage")
    assert ref("/api/chat/conversations/{conversation_id}", "get").endswith("/ChatConversation")
    assert ref("/api/chat/conversations/{conversation_id}", "patch").endswith("/ChatConversation")
    assert ref("/api/chat/turns/{turn_id}/cancel", "post").endswith("/ChatTurnCancelResult")
    page = spec["components"]["schemas"]["ChatConversationPage"]["properties"]["conversations"]
    assert page["items"]["$ref"].endswith("/ChatConversationSearchHit")


def test_fingerprint_of_pre_revamp_bodies_is_unchanged() -> None:
    bodies = [
        ChatRequest(message="top hosts"),
        ChatRequest(message="x", history=[{"role": "user", "content": "hi"}], source_id="s1",
                    conversation_id="chat-1", idempotency_key="key-12345678", persist_conversation=True,
                    context={"app": "logs", "time_range": {"from": "now-7d", "to": "now"}}, model="gpt-4o"),
    ]
    for body in bodies:
        assert _chat_request_fingerprint(body) == _pre_revamp_fingerprint(body)
        # stream_mode is presentation only; the revamp inputs are identity.
        assert _chat_request_fingerprint(body.model_copy(update={"stream_mode": "text"})) == \
            _chat_request_fingerprint(body)
        assert _chat_request_fingerprint(body.model_copy(update={"origin": "starter"})) != \
            _chat_request_fingerprint(body)
    assert chat_request_fingerprint(bodies[0]) == _chat_request_fingerprint(bodies[0])
