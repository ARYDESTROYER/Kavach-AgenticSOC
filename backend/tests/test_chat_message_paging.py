"""Older messages of a long Workspace conversation (Round 12, WP-FIX1).

``GET /api/chat/conversations/{id}`` keeps its default response (the newest
:data:`~app.stores.chat_conversations.TRANSCRIPT_WINDOW` messages, each restored to
its full text, plus ``earlier_message_count``); the console's "Show earlier
messages" reads the rest through ``GET /api/chat/conversations/{id}/messages?before=
<message id>&limit=<n>``. Every store test runs on the three shipped KV backends
(plain memory, the Elasticsearch adapter over the in-memory fake, SQLite):

* order and boundaries: oldest first, ``limit`` exactly, the message just before
  ``before``, the conversation's first message (an empty page with 0 earlier), the
  server maximum, and a walk back that sees every message exactly once — inline and
  across archive pages;
* full text: an answer far over the 24,000-character inline copy comes back whole,
  from its exchange document, in an older page as in the window;
* owner scoping: another user's conversation is indistinguishable from an absent one
  (None / 404), an unknown ``before`` is ``ChatMessageMissing`` / 404;
* the route: bounds on ``limit`` and the ``before`` grammar (422), the default read's
  shape unchanged, and the auth-on owner check.
"""

from __future__ import annotations

import pytest

from app.stores import chat_conversations as cc
from tests.test_chat_round12_api import _auth_client, _login, _open_client
from tests.test_chat_round12_storage import BACKENDS, kv_backend, long_answer, turn
from tests.test_chat_round12_fixes import routes_chat_mock

LONG_EVERY = 9  # every ninth answer is far over the inline limit


def _answer(n: int) -> str:
    return long_answer(30_000) + f"\n\nEnd of answer {n}." if n % LONG_EVERY == 0 else f"answer {n}"


async def _build(store: cc.ChatConversationStore, user: str, turns: int, *, start: int = 0) -> str:
    """A conversation of ``turns`` exchanges (``start`` keeps request keys distinct)."""
    first = await turn(store, user, start, answer=_answer(0))
    for n in range(1, turns):
        await turn(store, user, start + n, conversation_id=first.conversation_id, answer=_answer(n))
    return first.conversation_id


@pytest.fixture
def small_archive(monkeypatch):
    """Archive pages from 12 inline messages, so a 130-message thread crosses several."""
    monkeypatch.setattr(cc, "ARCHIVE_TRIGGER_MESSAGES", 12)
    monkeypatch.setattr(cc, "INLINE_KEEP_MESSAGES", 8)
    monkeypatch.setattr(cc, "ARCHIVE_PAGE_MESSAGES", 5)


@pytest.mark.parametrize("archived", [False, True], ids=["inline", "archived"])
@pytest.mark.parametrize("backend", BACKENDS)
async def test_paging_order_boundaries_and_full_text(backend: str, archived: bool, request) -> None:
    if archived:
        request.getfixturevalue("small_archive")
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        cid = await _build(store, "ana", 65)                       # 130 messages
        whole = await store.get("ana", cid, window=None)
        assert len(whole.messages) == 130 and whole.earlier_message_count == 0
        ids = [m.id for m in whole.messages]
        assert [m.role for m in whole.messages[:4]] == ["user", "assistant", "user", "assistant"]

        # The default read: the newest window, with how many came before it.
        window = await store.get("ana", cid)
        assert len(window.messages) == cc.TRANSCRIPT_WINDOW == 100
        assert window.earlier_message_count == 30
        assert [m.id for m in window.messages] == ids[30:]

        # The message just before ``before``, oldest first, and what remains.
        page, earlier = await store.messages_page("ana", cid, before=ids[30], limit=1)
        assert [m.id for m in page] == [ids[29]] and earlier == 29
        page, earlier = await store.messages_page("ana", cid, before=ids[30], limit=10)
        assert [m.id for m in page] == ids[20:30] and earlier == 20
        # More than remain: the page starts the conversation.
        page, earlier = await store.messages_page("ana", cid, before=ids[30], limit=50)
        assert [m.id for m in page] == ids[:30] and earlier == 0
        # Before the very first message: nothing older.
        page, earlier = await store.messages_page("ana", cid, before=ids[0], limit=50)
        assert page == [] and earlier == 0
        # Without ``before``: the newest messages; ``limit`` is bounded by the server maximum.
        page, earlier = await store.messages_page("ana", cid, limit=5)
        assert [m.id for m in page] == ids[-5:] and earlier == 125
        page, earlier = await store.messages_page("ana", cid, limit=10_000)
        assert len(page) == cc.MAX_MESSAGE_PAGE and earlier == 30

        # Walking back from the window sees every message exactly once, in order.
        seen = list(window.messages)
        before, remaining = window.messages[0].id, window.earlier_message_count
        while remaining:
            page, remaining = await store.messages_page("ana", cid, before=before, limit=7)
            assert page, "a page with messages remaining is never empty"
            seen = [*page, *seen]
            before = page[0].id
        assert [m.id for m in seen] == ids

        # Full text, restored from the exchange documents: an answer far over the inline
        # copy comes back byte for byte in an older page.
        older, _ = await store.messages_page("ana", cid, before=ids[30], limit=30)
        long_one = next(m for m in older if m.role == "assistant" and m.content.endswith("End of answer 9."))
        assert long_one.content == _answer(9) and len(long_one.content) > cc.MAX_ASSISTANT_MESSAGE_CHARS
        assert not (long_one.response or {}).get("truncated")
        assert [m.content for m in seen] == [m.content for m in whole.messages]


@pytest.mark.parametrize("backend", BACKENDS)
async def test_paging_is_owner_scoped(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        cid = await _build(store, "ana", 3)
        mine = await store.get("ana", cid, window=None)
        # Another user's conversation is indistinguishable from an absent one.
        assert await store.messages_page("bob", cid) is None
        assert await store.messages_page("bob", cid, before=mine.messages[-1].id) is None
        assert await store.messages_page("ana", "chat-nope") is None
        # A message that is not in this conversation is "missing", never another page.
        with pytest.raises(cc.ChatMessageMissing):
            await store.messages_page("ana", cid, before="chatmsg-nope")
        other = await _build(store, "ana", 2, start=100)
        assert other != cid
        foreign = (await store.get("ana", other, window=None)).messages[-1].id
        with pytest.raises(cc.ChatMessageMissing):
            await store.messages_page("ana", cid, before=foreign)


def test_the_route_pages_older_messages_and_keeps_the_default_read() -> None:
    provider = routes_chat_mock()
    with _open_client(provider) as client:
        store = client.app.state.tlsoc.chat_conversations
        conversation = None
        for n in range(cc.TRANSCRIPT_WINDOW // 2 + 10):          # 120 messages
            answer = _answer(n)
            conversation = client.portal.call(lambda n=n, answer=answer: store.append_exchange(
                None, conversation_id=conversation.id if conversation else None,
                user_content=f"q{n}", assistant_content=answer, response={"answer": answer}))
        cid = conversation.id
        detail = client.get(f"/api/chat/conversations/{cid}").json()
        # The default read is unchanged: the newest window and how many came before it.
        assert len(detail["messages"]) == cc.TRANSCRIPT_WINDOW and detail["earlier_message_count"] == 20
        assert detail["message_count"] == detail["total_message_count"] == 120
        first = detail["messages"][0]["id"]

        page = client.get(f"/api/chat/conversations/{cid}/messages", params={"before": first, "limit": 8})
        assert page.status_code == 200, page.text
        body = page.json()
        assert body["conversation_id"] == cid and body["earlier_message_count"] == 12
        assert [m["content"] for m in body["messages"]][:2] == ["q6", _answer(6)]
        # Full text of an answer over the inline copy, restored in an older page.
        rest = client.get(f"/api/chat/conversations/{cid}/messages",
                          params={"before": body["messages"][0]["id"], "limit": 100}).json()
        assert rest["earlier_message_count"] == 0 and len(rest["messages"]) == 12
        assert rest["messages"][1]["content"] == _answer(0)
        assert len(rest["messages"][1]["content"]) > cc.MAX_ASSISTANT_MESSAGE_CHARS

        # Bounds and grammar.
        url = f"/api/chat/conversations/{cid}/messages"
        assert client.get(url, params={"limit": 0}).status_code == 422
        assert client.get(url, params={"limit": cc.MAX_MESSAGE_PAGE + 1}).status_code == 422
        assert client.get(url, params={"before": "../etc"}).status_code == 422
        assert client.get(url, params={"before": "chatmsg-nope"}).status_code == 404
        assert client.get("/api/chat/conversations/chat-nope/messages").status_code == 404


def test_the_route_is_owner_scoped_with_auth_on() -> None:
    provider = routes_chat_mock()
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        store = client.app.state.tlsoc.chat_conversations
        conversation = None
        for n in range(4):
            conversation = client.portal.call(lambda n=n: store.append_exchange(
                "Admin", conversation_id=conversation.id if conversation else None,
                user_content=f"q{n}", assistant_content=f"a{n}"))
        cid = conversation.id
        assert client.get(f"/api/chat/conversations/{cid}/messages", params={"limit": 2}).json()["earlier_message_count"] == 6
        assert client.post("/api/users", json={"username": "other", "password": "other-pass-12345",
                                               "role": "analyst_tier1"}).status_code == 200
        _login(client, "other", "other-pass-12345")
        assert client.get(f"/api/chat/conversations/{cid}/messages").status_code == 404
        assert client.get(f"/api/chat/conversations/{cid}").status_code == 404
