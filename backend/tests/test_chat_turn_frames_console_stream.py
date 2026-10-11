"""Round 12 (SPEC D13, §3.2): the console reads its own ``chat.turn`` frames.

The web console carries topic ``chat`` on the shell's one job stream
(``GET /api/events?topics=chat,jobs``, see ``webui/src/soc/jobs/JobMonitor.tsx``), so the
working indicator hears about a turn started on another device or browser without a
second connection. These tests pin the server side of that contract: the route serves
the combined topic set as asked, and on it the owner receives its own chat turn frames
next to its job frames, while another user and an anonymous subscriber receive none.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.realtime import (
    CHAT_TOPIC,
    CHAT_TURN_EVENT,
    JOB_EVENT,
    EventBus,
    _Subscriber,
    get_event_bus,
    publish_chat_turn,
)
from app.state import AppState

# The console job observer's topics, as `useEventStream` sends them (sorted, joined).
CONSOLE_STREAM_TOPICS = "chat,jobs"


@pytest.fixture()
def client():
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        secrets = Secrets(
            _env_file=None, es_store_enabled=False, redis_url="",
            anthropic_api_key=None, openai_api_key=None,
        )
        mock = MockProvider()
        state = AppState.create(
            secrets=secrets, es=InMemoryESClient(),
            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
        )
        await state.startup(start_poller=False)
        realtime = state.prefs.realtime.model_copy(update={"enabled": True})
        await state.update_prefs(
            state.prefs.model_copy(update={"setup_complete": True, "realtime": realtime})
        )
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from app.api.routes import router as monolith_router

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    with TestClient(api) as test_client:
        yield test_client


def test_the_console_job_stream_is_served_with_the_chat_topic(client, monkeypatch) -> None:
    subscribed: list[list[str]] = []

    async def finite(topics, user, *, last_event_id=None):  # noqa: ANN001, ARG001
        subscribed.append(list(topics))
        yield b": connected\n\n"

    monkeypatch.setattr(get_event_bus(), "subscribe", finite)
    res = client.get("/api/events", params={"topics": CONSOLE_STREAM_TOPICS})
    assert res.status_code == 200
    # Neither topic is dropped (the chat topic needs no case permission: its frames are
    # addressed to their owner only).
    assert subscribed == [["chat", "jobs"]]


def test_the_owner_gets_its_chat_turns_next_to_its_jobs_and_nobody_else_does() -> None:
    bus = EventBus()
    topics = frozenset(CONSOLE_STREAM_TOPICS.split(","))
    alice, bob = (_Subscriber(name, topics, 16) for name in ("alice", "bob"))
    anonymous = _Subscriber(None, topics, 16)
    for sub in (alice, bob, anonymous):
        bus._register(sub)  # noqa: SLF001 -- the bus's own registry, as subscribe() does

    payload = {
        "turn_id": "turn-1", "conversation_id": "c1", "case_id": None, "phase": "started",
        "label": "Thinking", "lookups": 0, "tokens": 0,
    }
    assert publish_chat_turn(bus, "alice", payload) is not None
    bus.publish("jobs", JOB_EVENT, {"job_id": "job-1"}, audience=["alice"])

    delivered = [(event.topic, event.event_type) for event in alice._queue]  # noqa: SLF001
    assert delivered == [(CHAT_TOPIC, CHAT_TURN_EVENT), ("jobs", JOB_EVENT)]
    assert not bob._queue and not anonymous._queue  # noqa: SLF001
