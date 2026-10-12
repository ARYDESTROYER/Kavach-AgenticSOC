"""Round 12 (SPEC D13, §7.2 decision 17): a turn's outcome seen on one console is news on no other.

Case Manager chat and failed turns keep no stored "unread" state, so the console that has
a turn's outcome on screen posts ``POST /api/chat/turns/{turn_id}/seen``. The route stores
nothing: it publishes an owner-only, unretained ``chat.read`` frame naming the turn and
where it ran, and the owner's other consoles drop the mark (and the notice) they hold for
it. These tests pin the server side of that contract: ids only, owner only, the turn's
conversation or case named only from the caller's own live record, a look after the
server forgot the turn still heard (the turn id alone), ``cases:read`` like every chat
route, and a frame that cannot go out is not an error.
"""
from __future__ import annotations

import json

from app.llm.providers import MockProvider
from app.realtime import (
    CHAT_READ_EVENT,
    CHAT_TOPIC,
    EventBus,
    _Subscriber,
    publish_chat_read,
)
from tests.test_chat_round12_api import _auth_client, _login
from tests.test_chat_routes_stream import FINAL

TOPICS = frozenset({"chat", "jobs"})


def _read_frames(sub: _Subscriber) -> list[dict]:
    return [json.loads(e.payload) for e in sub._queue if e.event_type == CHAT_READ_EVENT]  # noqa: SLF001


def _subscribers(client) -> tuple[_Subscriber, _Subscriber, _Subscriber]:  # noqa: ANN001
    bus = client.app.state.tlsoc.event_bus
    owner, other = _Subscriber("admin", TOPICS, 16), _Subscriber("analyst", TOPICS, 16)
    anonymous = _Subscriber(None, TOPICS, 16)
    for sub in (owner, other, anonymous):
        bus._register(sub)  # noqa: SLF001 -- the bus's own registry, as subscribe() does
    return owner, other, anonymous


def test_a_turn_frame_names_the_turn_and_where_it_ran_with_ids_only() -> None:
    bus = EventBus()
    alice, bob = _Subscriber("alice", TOPICS, 16), _Subscriber("bob", TOPICS, 16)
    for sub in (alice, bob):
        bus._register(sub)  # noqa: SLF001
    assert publish_chat_read(bus, "Alice", None, turn_id="turn-1", case_id="case-4") is not None
    assert publish_chat_read(bus, "alice", "chat-1", turn_id="turn-2") is not None
    # Nothing to name, or nobody to address: nothing is published.
    assert publish_chat_read(bus, "alice", None) is None
    assert publish_chat_read(bus, None, None, turn_id="turn-3") is None
    assert _read_frames(alice) == [
        {"turn_id": "turn-1", "case_id": "case-4"},
        {"turn_id": "turn-2", "conversation_id": "chat-1"},
    ]
    assert not bob._queue  # noqa: SLF001
    assert CHAT_TOPIC not in bus._history  # noqa: SLF001 -- never retained


def test_seeing_a_case_chat_answer_tells_the_owner_s_other_consoles() -> None:
    provider = MockProvider()
    provider.push("chat", FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        answer = client.post("/api/chat", json={"message": "Summarize this case", "case_id": "case-4"})
        assert answer.status_code == 200, answer.text
        turn_id = answer.json()["turn_id"]
        assert turn_id
        owner, other, anonymous = _subscribers(client)

        seen = client.post(f"/api/chat/turns/{turn_id}/seen")
        assert seen.status_code == 204 and seen.content == b""
        # The turn and its case, from the server's own record (never from the client).
        assert _read_frames(owner) == [{"turn_id": turn_id, "case_id": "case-4"}]
        assert not other._queue and not anonymous._queue  # noqa: SLF001
        # Stores nothing: no conversation appears, nothing is marked.
        assert client.get("/api/chat/conversations").json()["total"] == 0


def test_seeing_a_workspace_turn_names_its_conversation() -> None:
    provider = MockProvider()
    provider.push("chat", FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        answer = client.post("/api/chat", json={
            "message": "How many cases closed this week?", "persist_conversation": True,
            "idempotency_key": "r12-seen-0001",
        }).json()
        owner, _other, _anonymous = _subscribers(client)
        assert client.post(f"/api/chat/turns/{answer['turn_id']}/seen").status_code == 204
        assert _read_frames(owner) == [{"turn_id": answer["turn_id"], "conversation_id": answer["conversation_id"]}]
        # The stored unread mark is the read route's business, not this one's.
        assert client.get("/api/chat/conversations").json()["conversations"][0]["unread"] is True


def test_an_unknown_turn_or_another_user_s_names_nothing_but_the_id_to_the_caller() -> None:
    """Every well-formed id is answered alike (204), so the route is no oracle for
    someone else's turns; the frame goes to the caller alone and names only the id, so
    it can never reveal or clear anything of another user's."""
    provider = MockProvider()
    provider.push("chat", FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        turn_id = client.post("/api/chat", json={"message": "Summarize this case", "case_id": "case-9"}).json()["turn_id"]
        owner, other, _anonymous = _subscribers(client)
        assert client.post("/api/chat/turns/turn-missing/seen").status_code == 204
        assert _read_frames(owner) == [{"turn_id": "turn-missing"}]
        assert client.post("/api/chat/turns/..%2Fturn/seen").status_code in (404, 422)
        created = client.post("/api/users", json={
            "username": "analyst", "password": "analyst-pass-12345", "role": "analyst_tier1",
        })
        assert created.status_code == 200, created.text
        _login(client, "analyst", "analyst-pass-12345")
        owner._queue.clear()  # noqa: SLF001
        assert client.post(f"/api/chat/turns/{turn_id}/seen").status_code == 204
        # The analyst hears the id they sent, never the admin's case; the admin hears nothing.
        assert _read_frames(other) == [{"turn_id": turn_id}]
        assert not owner._queue  # noqa: SLF001


def test_a_look_after_the_server_forgot_the_turn_still_reaches_the_other_consoles(
    monkeypatch,
) -> None:
    """Finished turns are kept for 5 minutes (and 256 across all users). An analyst who
    comes back to a case answer after a meeting still clears it on their other
    consoles: the frame names the turn, which is what a console matches on."""
    import app.api.routes_chat as routes_chat_mod

    provider = MockProvider()
    provider.push("chat", FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        turn_id = client.post("/api/chat", json={"message": "Summarize this case", "case_id": "case-4"}).json()["turn_id"]
        owner, other, anonymous = _subscribers(client)
        later = routes_chat_mod.time.monotonic() + routes_chat_mod.RECENT_TURN_TTL_S + 60
        monkeypatch.setattr(routes_chat_mod.time, "monotonic", lambda: later)
        assert client.app.state.tlsoc.chat_turns.find(turn_id, "admin") is None
        assert client.post(f"/api/chat/turns/{turn_id}/seen").status_code == 204
        assert _read_frames(owner) == [{"turn_id": turn_id}]
        assert not other._queue and not anonymous._queue  # noqa: SLF001


def test_seen_needs_cases_read() -> None:
    with _auth_client(MockProvider()) as client:
        _login(client, "Admin", "Admin@123")
        state = client.app.state.tlsoc
        denies = {"auditor": {"cases": ["read"]}}
        client.portal.call(state.update_prefs, state.prefs.model_copy(update={
            "rbac": state.prefs.rbac.model_copy(update={"denies": denies})}))
        assert client.post("/api/users", json={
            "username": "viewer", "password": "viewer-pass-12345", "role": "auditor",
        }).status_code == 200
        _login(client, "viewer", "viewer-pass-12345")
        assert client.post("/api/chat/turns/turn-x/seen").status_code == 403


def test_a_frame_that_cannot_go_out_is_not_an_error(monkeypatch) -> None:
    provider = MockProvider()
    provider.push("chat", FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        turn_id = client.post("/api/chat", json={"message": "Summarize this case", "case_id": "case-4"}).json()["turn_id"]

        def broken(*_args, **_kwargs):  # noqa: ANN002, ANN003
            raise RuntimeError("bus unavailable")

        monkeypatch.setattr(client.app.state.tlsoc.event_bus, "publish", broken)
        assert client.post(f"/api/chat/turns/{turn_id}/seen").status_code == 204
