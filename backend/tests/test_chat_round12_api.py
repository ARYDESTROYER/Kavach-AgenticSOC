"""Round 12 chat routes (WP-API): active turns, re-attach, ``chat.turn`` frames, the
lease heartbeat, concurrency, conversation status/unread, reports saved from chat
(D11), "Save conversation as report", feedback and the step inspector.

Owner scoping is checked with auth ON (two principals: another user always gets 404)
and the routes are exercised with auth OFF (the shared ``default`` profile). RBAC: a
role whose matrix lacks ``cases:read`` gets 403 from every route.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.agents.chat_events import TextDeltaEvent, TextResetEvent, TurnDoneEvent, TurnStartEvent, UsageEvent
from app.api import routes_chat
from app.api.deps import require_auth
from app.api.routes import router as base_router
from app.api.routes_chat import (
    TurnEventRing,
    _reattach,
    _relay,
    active_chat_turns,
    router as chat_router,
)
from app.api.routes_chat_library import router as library_router
from app.api.routes_reports import router as reports_router
from app.config import Secrets
from app.constants import CHAT_CONVERSATIONS_NS
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import ChatResponse
from app.realtime import CHAT_TOPIC, CHAT_TURN_EVENT, EventBus, publish_chat_turn
from app.state import AppState
from app.stores.chat_conversations import (
    LIVE_STATE_FIELD,
    live_state_key,
    partition_key_for_user,
    stored_request_rows,
    with_stored_rows,
)
from tests.test_chat_routes_stream import (
    FINAL,
    TOOL_STEP,
    _chat_calls,
    _drain,
    _request,
    _start,
    gated_state,  # noqa: F401 -- pytest fixture
)

REPORT_FINAL = (
    json.dumps({"action": "final", "blocks": [{"ref": "t1.a1"}], "answer_kind": "data",
                "report": {"title": "September SOC report", "template": "monthly"}})
    + "\n---ANSWER---\n## Summary\n\nBrute force is T1110."
)


def _ndjson(text: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# --------------------------------------------------------------------------- #
# The per-turn event ring (unit).
# --------------------------------------------------------------------------- #
def test_ring_coalesces_text_and_resumes_mid_answer() -> None:
    ring = TurnEventRing()
    assert ring.append(TurnStartEvent(turn_id="turn-1")) == 1
    for part in ("Hel", "lo ", "wor", "ld"):
        ring.append(TextDeltaEvent(text=part))                       # seqs 2..5
    ring.append(UsageEvent(totals={"calls": 1, "total_tokens": 10}))  # 6
    ring.append(UsageEvent(totals={"calls": 2, "total_tokens": 20}))  # 7 replaces 6
    lines = ring.after(0)
    assert [type(e).__name__ for _s, e in lines] == ["TurnStartEvent", "TextDeltaEvent", "UsageEvent"]
    assert lines[1] == (5, TextDeltaEvent(text="Hello world")) and lines[2][0] == 7
    # A client that saw seq 3 ("Hel", "lo ") gets only the rest of the text.
    resumed = ring.after(3)
    assert resumed[0] == (5, TextDeltaEvent(text="world"))
    assert ring.after(7) == []
    # text.reset drops the earlier text; the terminal event is kept.
    ring.append(TextResetEvent())                                      # 8
    ring.append(TextDeltaEvent(text="Again"))                          # 9
    ring.append(TurnDoneEvent(response=ChatResponse(answer="Again")))  # 10
    assert ring.terminal_seq == 10
    kinds = [getattr(e, "type", "") for _s, e in ring.after(0)]
    assert kinds == ["turn.start", "usage", "text.reset", "text.delta", "turn.done"]
    assert ring.after(0)[3][1].text == "Again"


def test_ring_splits_long_text_and_stays_bounded() -> None:
    ring = TurnEventRing(max_entries=10)
    ring.append(TurnStartEvent(turn_id="turn-2"))
    ring.append(TextDeltaEvent(text="a" * 3_000))
    ring.append(TextDeltaEvent(text="b" * 3_000))
    chunks = [e.text for _s, e in ring.after(1)]
    assert "".join(chunks) == "a" * 3_000 + "b" * 3_000 and all(len(c) <= 4_000 for c in chunks)
    seqs = [s for s, _e in ring.after(1)]
    assert seqs == sorted(seqs) and seqs[-1] == 3
    from app.agents.chat_events import StepEndEvent, StepStartEvent

    for index in range(30):
        ring.append(StepStartEvent(step={"index": index, "kind": "tool", "tool": "log_stats", "label": "x"}))
    ring.append(TurnDoneEvent(response=ChatResponse(answer="x")))
    events = [e for _s, e in ring.after(0)]
    assert len(ring.entries) <= 10 and ring.gap is True
    assert events[0].type == "turn.start" and events[-1].type == "turn.done"
    assert StepEndEvent  # imported for symmetry; step.end entries are ordinary events


# --------------------------------------------------------------------------- #
# Live lifecycle (auth off: the default profile).
# --------------------------------------------------------------------------- #
async def test_active_turns_reattach_and_owner_only_frames(gated_state, monkeypatch) -> None:  # noqa: F811
    state, provider = gated_state
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    bus = EventBus(heartbeat_seconds=60)
    monkeypatch.setattr(AppState, "event_bus", property(lambda self: bus))
    owner_frames: list[str] = []
    other_frames: list[str] = []
    anonymous_frames: list[str] = []

    async def collect(user: str | None, sink: list[str]) -> None:
        async for frame in bus.subscribe([CHAT_TOPIC], user):
            sink.append(frame.decode())

    readers = [asyncio.ensure_future(collect("default", owner_frames)),
               asyncio.ensure_future(collect("bob", other_frames)),
               asyncio.ensure_future(collect(None, anonymous_frames))]
    await asyncio.sleep(0)
    try:
        start, _body = await _start(state, idempotency_key="r12-active-0001",
                                    message="Which hosts beaconed last week?")
        handle = start.handle
        relay = asyncio.ensure_future(_drain(_relay(handle)))
        await asyncio.wait_for(provider.entered.wait(), 5)

        active = await active_chat_turns(_request(state), state)
        assert [a.turn_id for a in active] == [handle.turn_id]
        view = active[0]
        assert view.status == "running" and view.conversation_id == handle.conversation_id
        assert view.label == "Thinking" and "beaconed" not in view.model_dump_json()
        assert state.chat_turns.find(handle.turn_id, "bob") is None          # another owner
        # The brand-new thread is listed as a temporary running row.
        page = await state.chat_conversations.list_page("")
        assert page.conversations[0].status == "running"
        assert page.conversations[0].title == "Which hosts beaconed last week?"

        # Re-attach while running: replay, then the live tail to the terminal event.
        reattached = asyncio.ensure_future(_collect_lines(_reattach(handle, 0)))
        await asyncio.sleep(0.05)
        provider.gated = False
        provider.gate.set()
        relayed = await asyncio.wait_for(relay, 10)
        lines = await asyncio.wait_for(reattached, 10)
        assert lines[0]["type"] == "turn.start" and lines[-1]["type"] == "turn.done"
        assert [line["seq"] for line in lines] == sorted(line["seq"] for line in lines)
        assert [e.type for e in relayed][-1] == "turn.done"
        assert lines[-1]["seq"] == handle.ring.terminal_seq == len(relayed)
        # Resume after a seq: only the later lines.
        middle = lines[len(lines) // 2]["seq"]
        later = await _collect_lines(_reattach(handle, middle))
        assert later and all(line["seq"] > middle for line in later)
        # Finished: no longer active, still re-attachable for its owner.
        assert await active_chat_turns(_request(state), state) == []
        assert state.chat_turns.find(handle.turn_id, "default") is handle
        await asyncio.sleep(0.05)
    finally:
        for reader in readers:
            reader.cancel()
    frames = [f for f in owner_frames if f.startswith("id:")]
    phases = [json.loads(f.split("data: ", 1)[1])["phase"] for f in frames]
    assert phases[0] == "started" and phases[-1] == "finished"
    assert all(f"event: {CHAT_TURN_EVENT}" in f for f in frames)
    payload = json.loads(frames[-1].split("data: ", 1)[1])
    assert set(payload) == {"turn_id", "conversation_id", "case_id", "phase", "label", "lookups", "tokens"}
    assert payload["lookups"] == 1 and payload["tokens"] > 0
    assert not [f for f in other_frames if f.startswith("id:")]
    assert not [f for f in anonymous_frames if f.startswith("id:")]


async def _collect_lines(gen) -> list[dict[str, Any]]:  # noqa: ANN001
    out: list[dict[str, Any]] = []
    async for raw in gen:
        payload = json.loads(raw)
        if payload.get("type") != "ping":
            out.append(payload)
    return out


def test_publish_chat_turn_is_never_broadcast() -> None:
    from app.realtime import _Subscriber

    bus = EventBus()
    assert publish_chat_turn(bus, "", {"phase": "started"}) is None
    alice, bob = (_Subscriber(name, frozenset({CHAT_TOPIC}), 16) for name in ("alice", "bob"))
    anonymous = _Subscriber(None, frozenset({CHAT_TOPIC}), 16)
    for sub in (alice, bob, anonymous):
        bus._register(sub)
    publish_chat_turn(bus, " Alice ", {"phase": "started"})
    assert len(alice._queue) == 1 and not bob._queue and not anonymous._queue
    # Never retained in the replay ring: a username can be deleted and created again,
    # and the new account must never replay its predecessor's frames.
    for user in ("alice", "bob", None):
        assert bus.replay(frozenset({CHAT_TOPIC}), user, "0") == []


async def test_the_lease_heartbeat_renews_a_running_turn(gated_state, monkeypatch) -> None:  # noqa: F811
    state, provider = gated_state
    monkeypatch.setattr(routes_chat, "TURN_HEARTBEAT_S", 0.05)
    start, _body = await _start(state, idempotency_key="r12-heartbeat-01")
    reader = asyncio.ensure_future(_drain(_relay(start.handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    key = partition_key_for_user("")
    doc = await state.kv.get(CHAT_CONVERSATIONS_NS, key)
    rows = stored_request_rows(doc)
    rows["r12-heartbeat-01"]["updated_at"] = "2000-01-01T00:00:00Z"
    await state.kv.put(CHAT_CONVERSATIONS_NS, key, with_stored_rows(doc, requests=rows))
    lease: dict[str, Any] = {}
    for _ in range(100):
        live = await state.kv.get(CHAT_CONVERSATIONS_NS, live_state_key(key)) or {}
        lease = json.loads(live.get(LIVE_STATE_FIELD) or "{}").get("leases", {}).get("r12-heartbeat-01", {})
        if str(lease.get("at") or "") > "2001":
            break
        await asyncio.sleep(0.02)
    assert str(lease.get("at") or "") > "2001"                        # renewed while running
    # The heartbeat never rewrites the transcript partition.
    rows = stored_request_rows(await state.kv.get(CHAT_CONVERSATIONS_NS, key))
    assert rows["r12-heartbeat-01"]["updated_at"] == "2000-01-01T00:00:00Z"
    # The renewed lease is still held: a same-key retry waits.
    assert (await state.chat_conversations.list_page("")).conversations[0].status == "running"
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert events[-1].type == "turn.done"


async def test_concurrency_defaults_and_429_retry_after(gated_state) -> None:  # noqa: F811
    state, provider = gated_state
    assert state.prefs.chat_agent.max_concurrent_turns_per_user == 4
    assert state.prefs.chat_agent.max_concurrent_turns_global == 16
    running = [await _start(state, idempotency_key=f"r12-conc-{n:04d}") for n in range(4)]
    await asyncio.wait_for(provider.entered.wait(), 5)
    with pytest.raises(HTTPException) as busy:
        await _start(state, idempotency_key="r12-conc-0099")
    assert busy.value.status_code == 429
    assert busy.value.detail["retry_after"] == routes_chat.CHAT_BUSY_RETRY_AFTER_S
    assert busy.value.detail["scope"] == "user" and busy.value.detail["limit"] == 4
    provider.gate.set()
    for start, _ in running:
        await asyncio.wait_for(start.handle.finished.wait(), 10)


# --------------------------------------------------------------------------- #
# HTTP, auth ON: owner scoping, RBAC, D11, feedback, step inspector, unread.
# --------------------------------------------------------------------------- #
@contextmanager
def _auth_client(provider: MockProvider) -> Iterator[TestClient]:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret="r12-api-test-secret",
        auth_seed_admin=True,
    )
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={
            "setup_complete": True, "rbac": state.prefs.rbac.model_copy(update={"enabled": True}),
        }))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, chat_router, library_router, reports_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        yield client


def _login(client: TestClient, username: str, password: str) -> None:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def test_owner_scoping_reports_feedback_inspector_and_unread() -> None:
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        body = {"message": "Create a monthly SOC report for September", "persist_conversation": True,
                "idempotency_key": "r12-report-0001"}
        first = client.post("/api/chat", json=body)
        assert first.status_code == 200, first.text
        answer = first.json()
        cid, mid = answer["conversation_id"], answer["message_id"]
        # D11: the server saved the persisted answer as a report.
        saved = answer["saved_report"]
        assert saved and saved["title"] == "September SOC report" and saved["items"] >= 2
        report = client.get(f"/api/reports/{saved['id']}").json()
        assert report["template"] == "monthly" and len(report["items"]) == saved["items"]
        assert report["items"][0]["kind"] == "section" and report["items"][0]["block"]["title"] == "Summary"
        assert all(i["source"]["conversation_id"] == cid and i["source"]["message_id"] == mid
                   for i in report["items"])
        # Idempotent: the same key replays the same answer and creates nothing new.
        calls = _chat_calls(provider)
        again = client.post("/api/chat", json=body).json()
        assert again["saved_report"] == saved and _chat_calls(provider) == calls
        assert len(client.get("/api/reports").json()["reports"]) == 1
        # The stored transcript carries the saved report line too.
        detail = client.get(f"/api/chat/conversations/{cid}").json()
        assert detail["messages"][1]["response"]["saved_report"] == saved
        # Unread until opened; the mark-read path clears it.
        row = client.get("/api/chat/conversations").json()["conversations"][0]
        assert row["unread"] is True and row["status"] == "idle"
        assert client.post(f"/api/chat/conversations/{cid}/read").status_code == 204
        assert client.get("/api/chat/conversations").json()["conversations"][0]["unread"] is False
        # Step inspector: the observation the model saw for the lookup.
        steps = detail["messages"][1]["response"]["steps"]
        tool = next(s for s in steps if s["kind"] == "tool")
        assert tool["observation_ref"]
        inspected = client.get(f"/api/chat/conversations/{cid}/messages/{mid}/steps/{tool['index']}")
        assert inspected.status_code == 200, inspected.text
        observation = inspected.json()
        assert observation["tool"] == "mitre_lookup" and observation["untrusted"] is True
        assert observation["observation"]
        model_step = next(s for s in steps if s["kind"] == "model")
        missing = client.get(f"/api/chat/conversations/{cid}/messages/{mid}/steps/{model_step['index']}")
        assert missing.status_code == 404 and missing.json()["detail"]["code"] == "step_not_found"
        # Feedback: stored per user, audited, 204.
        rated = client.post("/api/chat/feedback", json={
            "conversation_id": cid, "message_id": mid, "rating": "down", "reason": "incomplete",
            "comment": "Missing the weekly split.",
        })
        assert rated.status_code == 204 and rated.content == b""
        mine = client.get("/api/chat/feedback", params={"conversation_id": cid}).json()["feedback"]
        assert [(f["message_id"], f["rating"], f["reason"]) for f in mine] == [(mid, "down", "incomplete")]
        bad = client.post("/api/chat/feedback", json={"conversation_id": cid, "message_id": mid, "rating": "meh"})
        assert bad.status_code == 422
        # Save the whole conversation as a report (idempotent with a key).
        whole = client.post("/api/reports/from-conversation", json={
            "conversation_id": cid, "idempotency_key": "r12-whole-0001"}).json()
        assert whole["created"] is True and whole["items"] >= 1 and whole["report"]["template"] == "custom"
        whole_again = client.post("/api/reports/from-conversation", json={
            "conversation_id": cid, "idempotency_key": "r12-whole-0001"}).json()
        assert whole_again["created"] is False and whole_again["report"]["id"] == whole["report"]["id"]
        state = client.app.state.tlsoc
        audit = client.portal.call(_audit_rows, state)
        assert any("chat answer rated down" in r for r in audit)
        assert any("report created from chat" in r for r in audit)
        assert not any("Missing the weekly split" in r for r in audit)    # the comment is not audited

        # Another principal: every route answers 404 for the admin's records.
        created = client.post("/api/users", json={"username": "analyst", "password": "analyst-pass-12345",
                                                   "role": "analyst_tier1"})
        assert created.status_code == 200, created.text
        _login(client, "analyst", "analyst-pass-12345")
        assert client.get(f"/api/chat/conversations/{cid}/messages/{mid}/steps/{tool['index']}").status_code == 404
        assert client.post("/api/chat/feedback", json={
            "conversation_id": cid, "message_id": mid, "rating": "up"}).status_code == 404
        assert client.get("/api/chat/feedback").json()["feedback"] == []
        assert client.post(f"/api/chat/conversations/{cid}/read").status_code == 404
        assert client.post("/api/reports/from-conversation", json={"conversation_id": cid}).status_code == 404
        assert client.get(f"/api/chat/turns/{answer['turn_id']}/events").status_code == 404
        assert client.get("/api/chat/turns/active").json() == []
        assert client.get(f"/api/reports/{saved['id']}").status_code == 404


async def _audit_rows(state: AppState) -> list[str]:
    return [str(r.get("result_summary") or "") for r in await state.audit.records(limit=500)]


def test_routes_need_cases_read() -> None:
    provider = MockProvider()
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        state = client.app.state.tlsoc
        denies = {"auditor": {"cases": ["read"]}}                        # no cases:read
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={
            "rbac": state.prefs.rbac.model_copy(update={"denies": denies})}))
        assert client.post("/api/users", json={"username": "viewer", "password": "viewer-pass-12345",
                                               "role": "auditor"}).status_code == 200
        _login(client, "viewer", "viewer-pass-12345")
        for method, path, payload in (
            ("get", "/api/chat/turns/active", None),
            ("get", "/api/chat/turns/turn-x/events", None),
            ("post", "/api/chat/feedback", {"conversation_id": "c", "message_id": "m", "rating": "up"}),
            ("get", "/api/chat/feedback", None),
            ("get", "/api/chat/conversations/c/messages/m/steps/1", None),
            ("get", "/api/chat/feedback/summary", None),
            ("get", "/api/chat/conversations/c/messages", None),
            ("get", "/api/chat/conversations/c/messages/m", None),
            ("post", "/api/chat/conversations/c/read", None),
            ("post", "/api/reports/from-conversation", {"conversation_id": "c"}),
        ):
            response = getattr(client, method)(path, **({"json": payload} if payload is not None else {}))
            assert response.status_code == 403, (path, response.status_code, response.text)


# --------------------------------------------------------------------------- #
# HTTP, auth OFF (the default profile).
# --------------------------------------------------------------------------- #
@contextmanager
def _open_client(provider: MockProvider) -> Iterator[TestClient]:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    for router in (base_router, chat_router, library_router, reports_router):
        api.include_router(router)
    with TestClient(api) as client:
        yield client


def test_auth_off_routes_use_the_default_profile_and_case_turns_never_save_reports() -> None:
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _open_client(provider) as client:
        # A case-scoped turn asking for a report never creates one (D11).
        case_turn = client.post("/api/chat", json={"message": "Make this case a report", "case_id": "case-1"})
        assert case_turn.status_code == 200, case_turn.text
        assert case_turn.json().get("saved_report") is None
        assert client.get("/api/reports").json()["reports"] == []
        assert client.get("/api/chat/conversations").json()["total"] == 0
        # A Workspace turn does, and the library routes work for the default profile.
        answer = client.post("/api/chat/stream", json={
            "message": "Create the September report", "persist_conversation": True,
            "idempotency_key": "r12-open-0001"}).text
        done = _ndjson(answer)[-1]
        assert done["type"] == "turn.done" and done["response"]["saved_report"]
        cid, mid = done["response"]["conversation_id"], done["response"]["message_id"]
        events = client.get(f"/api/chat/turns/{done['response']['turn_id']}/events")
        assert events.status_code == 200
        lines = _ndjson(events.text)
        assert lines[0]["type"] == "turn.start" and lines[-1]["type"] == "turn.done"
        assert lines[-1]["response"]["saved_report"] == done["response"]["saved_report"]
        assert client.get(f"/api/chat/turns/{done['response']['turn_id']}/events",
                          params={"after": lines[-1]["seq"]}).text == ""
        assert client.get("/api/chat/turns/turn-unknown/events").status_code == 404
        assert client.get("/api/chat/turns/active").json() == []
        assert client.post("/api/chat/feedback", json={
            "conversation_id": cid, "message_id": mid, "rating": "up"}).status_code == 204
        assert client.post(f"/api/chat/conversations/{cid}/read").status_code == 204
        assert client.post("/api/chat/conversations/chat-nope/read").status_code == 404
