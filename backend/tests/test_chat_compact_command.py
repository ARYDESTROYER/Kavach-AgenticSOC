"""Round 12 final review (L4): a ``/compact`` reply is a quiet note, not an answer.

``/compact`` folds the earlier exchanges into the running conversation summary. Its
reply is housekeeping, so it:

* is marked ``command="compact"`` on ``ChatResponse``;
* always carries usage: a zero ``TurnUsage`` when no model call ran (Demo Mode, the
  bounded and unavailable replies, nothing to summarise, the chat cap reached), so the
  console reads "No model call · $0" instead of the legacy "Usage not recorded", and
  the summary call's real totals when one ran (#6: one gateway call, one UsageDoc);
* names no source (the route stamps no ``effective_source_*`` on it, live, stored or on
  a completed-key replay, and the conversation keeps the source its answers ran on);
* is never replayed, folded into a later summary, or saved as a report section.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents.chat_protocol import SUMMARY_SYSTEM, PriorExchange, conversation_exchanges
from app.api.routes import router as base_router
from app.api.routes_chat import router as chat_router
from app.api.routes_chat_library import router as library_router
from app.api.routes_reports import router as reports_router
from app.config import ModelConfig, Secrets
from app.es.fake import InMemoryESClient
from app.llm import providers
from app.llm.providers import MockProvider
from app.models import ChatResponse
from app.state import AppState
from tests.test_chat_engine_loop import FakeGateway, final, make_ctx, make_engine
from tests.test_chat_engine_unlimited import (  # noqa: F401 -- the autouse catalogue fixture
    ScriptedProvider,
    _exchanges,
    _real_engine,
    _usage_docs,
    run,
    unlimited_catalogue,
    uprefs,
)


def _zero(usage: Any) -> bool:
    return usage is not None and usage.calls == 0 and usage.total_tokens == 0 and usage.cost == 0


def _compact_exchange(message_id: str, answer: str = "Summarised 2 earlier exchanges.") -> PriorExchange:
    return PriorExchange(user="/compact", answer=answer, message_id=message_id, command="compact")


# --------------------------------------------------------------------------- #
# The engine.
# --------------------------------------------------------------------------- #
async def test_a_demo_compact_reply_is_a_zero_usage_command_note() -> None:
    gateway = FakeGateway([])
    prefs = uprefs()
    _, resp, outcome = await run(make_engine(gateway), "/compact", prefs, make_ctx(prefs, demo_active=True),
                                 prior_exchanges=_exchanges(2, size=50), conversation_id="conv-1")
    assert gateway.calls == []
    assert resp.command == "compact" and resp.compacted and outcome.summary_text
    assert _zero(resp.usage) and resp.usage.simulated is True and resp.cost == 0
    assert resp.answer == "Summarised 2 earlier exchanges. The conversation continues from the summary."
    assert resp.effective_source_id is None and resp.effective_source_name is None


@pytest.mark.parametrize("case", ["bounded", "unavailable", "nothing"])
async def test_every_reply_without_a_model_call_reads_no_model_call(case: str) -> None:
    gateway = FakeGateway([])
    prefs = uprefs(limits_mode="bounded") if case == "bounded" else uprefs()
    kwargs: dict[str, Any] = {"conversation_id": "conv-1"}
    ctx = make_ctx(prefs)
    if case == "unavailable":
        ctx = make_ctx(prefs, case_id="case-1")
    if case != "nothing":
        kwargs["prior_exchanges"] = _exchanges(3, size=50)
    _, resp, _ = await run(make_engine(gateway), "/compact", prefs, ctx, **kwargs)
    assert gateway.calls == []
    assert resp.command == "compact" and not resp.compacted
    assert _zero(resp.usage) and resp.usage.simulated is False
    assert resp.answer and "Usage not recorded" not in resp.answer


async def test_a_real_summary_call_is_ledgered_once_and_reported() -> None:
    """#6: the summary call goes through the one gateway and writes one UsageDoc; the
    reply's usage shows that call (never a zero that would hide spend)."""
    provider = ScriptedProvider([("Summary: three questions about logins.", "stop")])
    engine, es = _real_engine(provider)
    prefs = uprefs().model_copy(update={"chat_model": ModelConfig(provider="openai", model="gpt-4o")})
    _, resp, outcome = await run(engine, "/compact", prefs, make_ctx(prefs),
                                 prior_exchanges=_exchanges(3, size=50), conversation_id="conv-1")
    docs = await _usage_docs(es)
    assert len(docs) == 1 and docs[0]["surface"] == "chat"
    assert resp.command == "compact" and resp.compacted
    assert resp.usage is not None and resp.usage.calls == 1 and resp.usage.total_tokens > 0
    assert outcome.summary_text == "Summary: three questions about logins."


async def test_a_stored_compact_exchange_is_never_folded_again() -> None:
    """The verifier's oddity: a second ``/compact`` summarised the first one ("Summarised
    1 earlier exchange"). A command exchange is housekeeping: it is not counted."""
    gateway = FakeGateway([])
    prefs = uprefs()
    history = [*_exchanges(2, size=50), _compact_exchange("msg-c")]
    _, resp, outcome = await run(make_engine(gateway), "/compact", prefs, make_ctx(prefs, demo_active=True),
                                 prior_exchanges=history, conversation_id="conv-1",
                                 summary_text="Asked: question 1. Asked: question 2.",
                                 summary_covers_through="msg-2")
    assert resp.answer == "Everything earlier in this conversation is already summarised."
    assert not resp.compacted and outcome.summary_text is None and _zero(resp.usage)


async def test_a_compact_exchange_is_not_replayed_to_the_model() -> None:
    gateway = FakeGateway([final("ok")])
    prefs = uprefs()
    history = [*_exchanges(1, size=50), _compact_exchange("msg-c", "COMPACT-CONFIRMATION-TEXT")]
    await run(make_engine(gateway), "and now?", prefs, make_ctx(prefs), prior_exchanges=history,
              conversation_id="conv-1")
    prompt = "\n".join(m["content"] for call in gateway.calls for m in call["messages"])
    assert "question 1" in prompt
    assert "COMPACT-CONFIRMATION-TEXT" not in prompt and "/compact" not in prompt
    bounded = FakeGateway([final("ok")])
    bprefs = uprefs(limits_mode="bounded")
    await run(make_engine(bounded), "and now?", bprefs, make_ctx(bprefs), prior_exchanges=history)
    assert "COMPACT-CONFIRMATION-TEXT" not in "\n".join(
        m["content"] for call in bounded.calls for m in call["messages"])


async def test_a_summary_covering_a_command_reply_still_drops_what_it_covers() -> None:
    """Command exchanges are left out AFTER the summary's ``covers_through`` is found,
    so a summary written before this fix (covering through a /compact reply) still
    drops everything it covers instead of replaying it all again."""
    gateway = FakeGateway([final("ok")])
    prefs = uprefs()
    history = [*_exchanges(2, size=50), _compact_exchange("msg-c"),
               PriorExchange(user="question 3", answer="Answer 3.", message_id="msg-3")]
    await run(make_engine(gateway), "and now?", prefs, make_ctx(prefs), prior_exchanges=history,
              conversation_id="conv-1", summary_text="Asked: question 1.", summary_covers_through="msg-c")
    prompt = "\n".join(m["content"] for m in gateway.calls[-1]["messages"])
    assert "question 3" in prompt and "question 2" not in prompt and "Answer 2." not in prompt
    assert gateway.calls[0]["messages"][0]["content"] != SUMMARY_SYSTEM


def test_stored_command_replies_are_recognised_and_dropped() -> None:
    messages = [
        {"role": "user", "content": "question 1", "id": "u1"},
        {"role": "assistant", "content": "Answer 1.", "id": "a1", "response": {}},
        {"role": "user", "content": "/compact", "id": "u2", "origin": "command"},
        {"role": "assistant", "content": "Summarised 1 earlier exchange.", "id": "a2",
         "response": {"command": "compact"}},
        {"role": "user", "content": "q", "id": "u3"},
        {"role": "assistant", "content": "A.", "id": "a3", "response": {"command": "not-a-command"}},
    ]
    exchanges = PriorExchange.from_messages(messages)
    assert [e.command for e in exchanges] == [None, "compact", None]
    assert [e.message_id for e in conversation_exchanges(exchanges)] == ["a1", "a3"]


def test_the_command_field_is_lenient() -> None:
    assert ChatResponse(answer="x", command="COMPACT ").command == "compact"
    assert ChatResponse(answer="x", command="reboot").command is None
    assert ChatResponse(answer="x").command is None


# --------------------------------------------------------------------------- #
# The routes (Demo Mode, the console's real path).
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def client() -> Iterator[TestClient]:
    patch = pytest.MonkeyPatch()
    patch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        await state.enable_demo(mode="seeded", seed=1337, history_days=7)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, chat_router, library_router, reports_router):
        api.include_router(router)
    try:
        with TestClient(api) as test_client:
            yield test_client
    finally:
        patch.undo()


def _key(*parts: str) -> str:
    return "compact-" + hashlib.sha256("|".join(parts).encode()).hexdigest()[:24]


def _stream(client: TestClient, question: str, **fields: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"message": question, "origin": "user", **fields}
    response = client.post("/api/chat/stream", json=payload)
    assert response.status_code == 200, (question, response.status_code, response.text[:400])
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    assert not [e for e in events if e.get("type") == "turn.error"], events
    done = [e for e in events if e.get("type") == "turn.done"]
    assert done, [e.get("type") for e in events]
    return done[-1]["response"]


def test_the_compact_reply_names_no_source_and_is_left_out_of_reports(client: TestClient) -> None:
    first = _stream(client, "How is our security posture right now?", persist_conversation=True,
                    idempotency_key=_key("route", "1"))
    cid = first["conversation_id"]
    source = first["effective_source_name"]
    assert source  # the Demo source answers ran on
    _stream(client, "Which campaigns are open?", persist_conversation=True, conversation_id=cid,
            idempotency_key=_key("route", "2"))
    compact_key = _key("route", "3")
    compact = _stream(client, "/compact", origin="command", persist_conversation=True, conversation_id=cid,
                      idempotency_key=compact_key)
    assert compact["command"] == "compact" and compact["compacted"] is True and compact["message_id"]
    assert compact["usage"]["calls"] == 0 and compact["usage"]["total_tokens"] == 0
    assert compact["effective_source_id"] is None and compact["effective_source_name"] is None
    assert compact["answer"].startswith("Summarised 2 earlier exchanges")

    # A completed-key replay returns the same note: it never borrows the conversation's source.
    replay = _stream(client, "/compact", origin="command", persist_conversation=True, conversation_id=cid,
                     idempotency_key=compact_key)
    assert replay["message_id"] == compact["message_id"] and replay["command"] == "compact"
    assert replay["effective_source_id"] is None and replay["effective_source_name"] is None

    # Stored: the note keeps its marker and no source; the conversation keeps its source.
    detail = client.get(f"/api/chat/conversations/{cid}")
    assert detail.status_code == 200, detail.text[:300]
    body = detail.json()
    stored = next(m for m in body["messages"] if m["id"] == compact["message_id"])
    assert stored["response"]["command"] == "compact"
    assert not stored["response"].get("effective_source_name") and not stored.get("source_name")
    assert body["source_name"] == source

    # Asked again with nothing new: the stored note is not "1 earlier exchange".
    again = _stream(client, "/compact", origin="command", persist_conversation=True, conversation_id=cid,
                    idempotency_key=_key("route", "4"))
    assert again["answer"] == "Everything earlier in this conversation is already summarised."
    assert again["usage"]["calls"] == 0

    # "Save conversation as report": the two answers, never the notes.
    saved = client.post("/api/reports/from-conversation",
                        json={"conversation_id": cid, "idempotency_key": _key("route", "report")})
    assert saved.status_code == 200, saved.text[:300]
    report = saved.json()["report"]
    titles = [item.get("title") for item in report["items"] if item.get("kind") == "section"]
    assert titles and "/compact" not in titles
    assert all("Summarised" not in json.dumps(item) for item in report["items"])
