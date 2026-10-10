"""Round 12 WP-API review fixes: regression tests for each verified finding.

Storage (``stores/chat_conversations.py``):

* a running turn's conversation is never evicted (retention exempts it like a pin);
* a BILLED turn that failed ends its reservation: the key stays held, but the
  conversation reads ``failed`` and a new thread's temporary row disappears;
* ``update_message_response`` never rewrites an exchange-backed answer without its
  exchange record, and keeps a clipped question restorable;
* the lease heartbeat and ``mark_read`` write only the small live-state document;
* the inline row has a hard ceiling (older messages move to archive pages), the
  conversation read is windowed and paged, and the hot paths restore one answer, not
  the transcript;
* search reads concurrently and says when its budget cut it short.

Routes: the re-attach ring resumes exactly at every chunk it emitted; ``chat.turn``
frames are never retained and turns are bound to the account generation; a reset
forgets finished turns; D11 save failures are reported; the conversation-report
idempotency key is bound to its request; ``/chat/context`` mirrors the engine; a
same-key retry learns the running turn; the prompt library is audited; the chat
feedback breakdown is aggregate-only.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.agents.chat_events import MAX_TEXT_DELTA_CHARS, TextDeltaEvent, TurnDoneEvent, TurnStartEvent
from app.api import routes_chat
from app.api.deps import require_auth
from app.api.routes_chat import ChatTurnHandle, ChatTurnRegistry, TurnEventRing, _relay
from app.constants import CHAT_CONVERSATIONS_NS
from app.models import ChatFeedbackRequest, ChatResponse
from app.stores import chat_conversations as cc
from app.stores.base import _rev_of
from tests.test_chat_round12_api import REPORT_FINAL, _auth_client, _login, _ndjson, _open_client
from tests.test_chat_round12_storage import BACKENDS, MemoryKV, kv_backend, long_answer, turn
from tests.test_chat_routes_stream import (
    TOOL_STEP,
    _chat_calls,
    _client,
    _drain,
    _request,
    _start,
    gated_state,  # noqa: F401 -- pytest fixture
)


class CountingKV(MemoryKV):
    """A MemoryKV that counts reads and writes per key prefix."""

    def __init__(self) -> None:
        super().__init__()
        self.reads: list[str] = []
        self.writes: list[str] = []

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        self.reads.append(key)
        return await super().get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self.writes.append(key)
        await super().put(namespace, key, value)

    def reset(self) -> None:
        self.reads.clear()
        self.writes.clear()

    def count(self, prefix: str, *, writes: bool = False) -> int:
        return sum(1 for key in (self.writes if writes else self.reads) if key.startswith(prefix))


# --------------------------------------------------------------------------- #
# Retention never evicts a conversation a running turn is answering in.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("backend", BACKENDS)
async def test_a_running_turn_keeps_its_conversation_through_retention(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        ids = [(await turn(store, "ann", n)).conversation_id for n in range(cc.MAX_CONVERSATIONS_PER_USER)]
        oldest = ids[0]
        args = {"idempotency_key": "ann-long-0001", "request_fingerprint": "a" * 64}
        long_turn = await store.reserve_exchange("ann", conversation_id=oldest, lease_seconds=600, **args)
        # A new thread completes while the long turn runs: the 51st conversation.
        await turn(store, "ann", 1000)
        page = await store.list_page("ann", limit=cc.MAX_LIST_LIMIT)
        assert any(c.id == oldest and c.status == "running" for c in page.conversations)
        done = await store.complete_exchange(
            "ann", conversation_id=oldest, lease_token=long_turn.lease_token or "",
            requested_existing_conversation=True, user_content="investigate everything",
            assistant_content="The long answer.", response={"answer": "The long answer."},
            model=None, source_id=None, source_name=None, **args,
        )
        assert done.status == "completed" and done.assistant_message.content == "The long answer."
        # Once the turn has ended, the next write applies retention as usual.
        await turn(store, "ann", 1001)
        assert len((await store.list_page("ann", limit=cc.MAX_LIST_LIMIT)).conversations) == cc.MAX_CONVERSATIONS_PER_USER


# --------------------------------------------------------------------------- #
# A billed failure ends the reservation (held key, no "running" status).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("backend", BACKENDS)
async def test_an_ended_reservation_holds_its_key_but_no_longer_runs(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        first = await turn(store, "bea", 1)
        cid = first.conversation_id
        await store.mark_read("bea", cid)
        existing = {"idempotency_key": "bea-billed-0001", "request_fingerprint": "b" * 64}
        reserved = await store.reserve_exchange("bea", conversation_id=cid, **existing)
        brand_new = {"idempotency_key": "bea-billed-0002", "request_fingerprint": "c" * 64}
        new_thread = await store.reserve_exchange("bea", conversation_id=None, title_hint="new question", **brand_new)
        page = await store.list_page("bea")
        assert [c.status for c in page.conversations] == ["running", "running"]
        assert await store.end_reservation("bea", lease_token=reserved.lease_token or "", **existing) is True
        assert await store.end_reservation("bea", lease_token=new_thread.lease_token or "", **brand_new) is True
        assert await store.end_reservation("bea", lease_token="chatlease-other", **existing) is False
        page = await store.list_page("bea")
        # The existing conversation reads "failed"; the new thread's temporary row is gone.
        assert [(c.id, c.status) for c in page.conversations] == [(cid, "failed")]
        assert (await store.get("bea", cid)).status == "failed"
        # The key is still held: a same-key retry never bills again, and it learns the
        # request failed (nothing is running) rather than "in progress".
        for args, target in ((existing, cid), (brand_new, None)):
            with pytest.raises(cc.ChatRequestFailed) as failed:
                await store.reserve_exchange("bea", conversation_id=target, **args)
            assert isinstance(failed.value, cc.ChatRequestInProgress)  # older callers still refuse
            assert "could not be saved" in str(failed.value)
        # The heartbeat of an ended reservation stops.
        assert await store.renew_exchange("bea", lease_token=reserved.lease_token or "", **existing) is False
        # The next answer clears "failed".
        await turn(store, "bea", 2, conversation_id=cid)
        assert (await store.list_page("bea")).conversations[0].status == "idle"


def test_a_billed_save_failure_reads_failed_not_running() -> None:
    from tests.test_chat_routes_stream import MockProvider

    provider = MockProvider()
    with _client(provider) as client:
        state = client.app.state.tlsoc
        store = state.chat_conversations
        ok = client.post("/api/chat", json={"message": "first", "persist_conversation": True,
                                            "idempotency_key": "f-billed-0000"}).json()
        cid = ok["conversation_id"]

        async def _broken(*_args: Any, **_kwargs: Any) -> None:
            raise cc.ChatHistoryUnavailable("Chat history could not be saved.")

        store.complete_exchange = _broken
        for body in ({"message": "second", "persist_conversation": True, "conversation_id": cid,
                      "idempotency_key": "f-billed-0001"},
                     {"message": "brand new", "persist_conversation": True, "idempotency_key": "f-billed-0002"}):
            failed = client.post("/api/chat", json=body)
            assert failed.status_code == 503
        rows = client.get("/api/chat/conversations").json()["conversations"]
        # No temporary "running" row for the failed new thread; the existing one failed.
        assert [(r["id"], r["status"]) for r in rows] == [(cid, "failed")]
        assert client.get("/api/chat/turns/active").json() == []
        # Billed: a same-key retry never bills the same answer twice, and it is told
        # the request failed (not retryable), never that it is still running.
        again = client.post("/api/chat", json={"message": "brand new", "persist_conversation": True,
                                               "idempotency_key": "f-billed-0002"})
        assert again.status_code == 409 and again.json()["detail"]["code"] == "chat_request_failed"
        streamed = client.post("/api/chat/stream", json={
            "message": "brand new", "persist_conversation": True, "idempotency_key": "f-billed-0002",
        })
        assert streamed.status_code == 409 and streamed.json()["detail"]["code"] == "chat_request_failed"
        assert _chat_calls(provider) == 3


# --------------------------------------------------------------------------- #
# update_message_response keeps the full text restorable.
# --------------------------------------------------------------------------- #
class FlakyKV(MemoryKV):
    def __init__(self) -> None:
        super().__init__()
        self.fail_prefix: str | None = None

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        if self.fail_prefix and key.startswith(self.fail_prefix):
            self.fail_prefix = None
            raise ConnectionError("transient")
        return await super().get(namespace, key)


async def test_a_failed_exchange_read_never_strips_the_full_text() -> None:
    kv = FlakyKV()
    store = cc.ChatConversationStore(kv)
    answer = "Finding. " * 5_000                       # 45,000 characters: a partial inline copy
    done = await turn(store, "cal", 1, answer=answer, response={"answer": answer})
    cid, mid = done.conversation_id, done.assistant_message.id
    kv.fail_prefix = cc.EXCHANGE_KEY_PREFIX
    with pytest.raises(cc.ChatHistoryUnavailable):
        await store.update_message_response("cal", cid, mid, {"saved_report": {"id": "rpt-1", "title": "R", "items": 1}})
    assert (await store.get("cal", cid)).messages[1].content == answer
    # A retry once the store reads again records the report and keeps the text.
    assert await store.update_message_response("cal", cid, mid, {"saved_report": {"id": "rpt-1", "title": "R", "items": 1}})
    restored = (await store.get("cal", cid)).messages[1]
    assert restored.content == answer and restored.response["saved_report"]["id"] == "rpt-1"


async def test_a_report_snapshot_never_reads_a_preview_as_the_answer() -> None:
    """Report snapshots read strictly: an exchange document that cannot be read is
    ChatHistoryUnavailable (the routes answer a retryable 503), never the stored
    preview saved as the answer. Plain readers still fall back to the preview."""
    from app.api.routes_reports import _owned_exchange, _resolve_answer, items_for_answer

    kv = FlakyKV()
    store = cc.ChatConversationStore(kv)
    answer = "Finding. " * 5_000
    done = await turn(store, "fay", 1, answer=answer, response={"answer": answer})
    cid, mid = done.conversation_id, done.assistant_message.id
    state = type("S", (), {"chat_conversations": store})()

    kv.fail_prefix = cc.EXCHANGE_KEY_PREFIX
    with pytest.raises(cc.ChatHistoryUnavailable):
        await _owned_exchange(state, "fay", cid, mid)
    kv.fail_prefix = cc.EXCHANGE_KEY_PREFIX
    with pytest.raises(cc.ChatHistoryUnavailable):
        await store.get("fay", cid, window=None, strict=True)
    # A plain read (display) still shows the preview, flagged truncated.
    kv.fail_prefix = cc.EXCHANGE_KEY_PREFIX
    preview = await store.get_exchange("fay", cid, mid)
    assert len(preview.messages[-1].content) < len(answer)
    # Once the store reads again, the snapshot holds the whole answer.
    conversation = await _owned_exchange(state, "fay", cid, mid)
    resolved = _resolve_answer(conversation, mid)
    items = items_for_answer(resolved, conversation, conversation_id=cid, message_id=mid, demo=False)
    text = "".join(b["text"] for item in items for b in item.block["blocks"] if b["type"] == "markdown")
    assert text.split() == answer.split()


async def test_report_routes_answer_503_when_an_answer_cannot_be_read(monkeypatch) -> None:
    from tests.test_reports_routes import add, harness

    async with harness() as h:
        store = h.state.chat_conversations
        answer = "Finding. " * 5_000
        conversation = await store.append_exchange(
            "", conversation_id=None, user_content="q?", assistant_content=answer,
            response={"answer": answer, "blocks": []}, model="m",
        )
        cid = conversation.id
        mid = [m for m in conversation.messages if m.role == "assistant"][-1].id
        real = store._get_aux
        failing = {"on": True}

        async def flaky(key: str, field_name: str):  # noqa: ANN202
            if failing["on"] and key.startswith(cc.EXCHANGE_KEY_PREFIX):
                raise cc.ChatHistoryUnavailable("Chat history could not be read.")
            return await real(key, field_name)

        monkeypatch.setattr(store, "_get_aux", flaky)
        whole = await add(h.client, cid, mid)
        assert whole.status_code == 503 and whole.json()["detail"]["code"] == "chat_history_unavailable"
        saved = await h.client.post("/api/reports/from-conversation", json={"conversation_id": cid})
        assert saved.status_code == 503 and saved.json()["detail"]["code"] == "chat_history_unavailable"
        assert (await h.client.get("/api/reports")).json()["reports"] == []
        failing["on"] = False
        ok = await add(h.client, cid, mid)
        assert ok.status_code == 200
        text = "".join(b["text"] for item in ok.json()["report"]["items"]
                       for b in item["block"]["blocks"] if b["type"] == "markdown")
        assert text.split() == answer.split()


@pytest.mark.parametrize("backend", BACKENDS)
async def test_a_long_question_survives_a_saved_report_line(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        question = "Explain these log lines: " + "Oct 10 sshd[1]: Failed password for root\n" * 400
        assert len(question) > cc.MAX_USER_MESSAGE_CHARS
        done = await turn(store, "dan", 1, question=question, answer="Short answer.")
        cid, mid = done.conversation_id, done.assistant_message.id
        assert await store.update_message_response("dan", cid, mid, {"saved_report": {"id": "r", "title": "R", "items": 2}})
        conversation = await cc.ChatConversationStore(kv).get("dan", cid)
        assert conversation.messages[0].content == question
        assert conversation.messages[1].response["saved_report"]["items"] == 2
        # An answer whose exchange document is absent keeps its marker and flag too.
        await kv.put(CHAT_CONVERSATIONS_NS, cc.exchange_key(cc.partition_key_for_user("dan"), mid), {"schema": 1})
        assert await store.update_message_response("dan", cid, mid, {"saved_report": {"id": "s", "title": "S", "items": 1}})
        doc = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("dan"))
        inline = cc.stored_conversation_rows(doc)[cid]["messages"][1]["response"]
        assert inline[cc.EXCHANGE_MARKER] is True and inline["truncated"] is True


# --------------------------------------------------------------------------- #
# Periodic writers never rewrite the partition.
# --------------------------------------------------------------------------- #
async def test_mark_read_and_mark_failed_write_only_the_live_state() -> None:
    kv = CountingKV()
    store = cc.ChatConversationStore(kv)
    done = await turn(store, "eli", 1)
    key = cc.partition_key_for_user("eli")
    before = _rev_of(await kv.get(CHAT_CONVERSATIONS_NS, key))
    kv.reset()
    assert await store.mark_read("eli", done.conversation_id) is True
    assert await store.mark_read("eli", done.conversation_id) is True    # already read: no write
    assert await store.mark_failed("eli", done.conversation_id) is True
    assert kv.writes == [cc.live_state_key(key), cc.live_state_key(key)]
    assert _rev_of(await kv.get(CHAT_CONVERSATIONS_NS, key)) == before
    row = (await store.list_page("eli")).conversations[0]
    assert row.unread is False and row.status == "failed"
    assert await store.mark_read("someone-else", done.conversation_id) is False


# --------------------------------------------------------------------------- #
# The inline ceiling (archive pages), windowed reads and paging.
# --------------------------------------------------------------------------- #
@pytest.fixture
def small_archive(monkeypatch):
    monkeypatch.setattr(cc, "ARCHIVE_TRIGGER_MESSAGES", 12)
    monkeypatch.setattr(cc, "INLINE_KEEP_MESSAGES", 8)
    monkeypatch.setattr(cc, "ARCHIVE_PAGE_MESSAGES", 5)


def _answer(n: int) -> str:
    return f"answer {n} " + ("detail " * 4_000 if n % 3 == 0 else "short")


@pytest.mark.parametrize("backend", BACKENDS)
async def test_the_row_has_a_hard_ceiling_and_every_message_stays_readable(backend: str, small_archive) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        first = await turn(store, "fay", 0, answer=_answer(0), question="question 0 " + "q" * 13_000,
                           response={"answer": _answer(0), "query": "x" * 3_000})
        cid = first.conversation_id
        for n in range(1, 40):
            await turn(store, "fay", n, conversation_id=cid, answer=_answer(n),
                       response={"answer": _answer(n), "query": "x" * 3_000})
            doc = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("fay"))
            row = cc.stored_conversation_rows(doc)[cid]
            assert len(row["messages"]) <= cc.ARCHIVE_TRIGGER_MESSAGES      # the hard ceiling
        assert row[cc.ARCHIVE_ROW_KEY]["count"] + len(row["messages"]) == 80
        assert row["messages"][0]["role"] == "user"                          # never split a pair
        # The whole transcript reads back in order, every message whole.
        whole = await cc.ChatConversationStore(kv).get("fay", cid, window=None)
        assert [m.content for m in whole.messages[1::2]] == [_answer(n) for n in range(40)]
        assert whole.messages[0].content == "question 0 " + "q" * 13_000
        assert whole.message_count == whole.total_message_count == 80 and not cc.turns_removed(whole)
        assert all(m.response.get("query") == "x" * 3_000 for m in whole.messages[1::2])
        # The default read is the newest window; paging back walks every message once.
        window = await store.get("fay", cid, window=10)
        assert window.earlier_message_count == 70 and [m.id for m in window.messages] == [m.id for m in whole.messages[70:]]
        seen = list(window.messages)
        before, earlier = window.messages[0].id, window.earlier_message_count
        while earlier:
            page, earlier = await store.messages_page("fay", cid, before=before, limit=7)
            seen = [*page, *seen]
            before = page[0].id
        assert [m.id for m in seen] == [m.id for m in whole.messages]
        assert [m.content for m in seen] == [m.content for m in whole.messages]
        with pytest.raises(cc.ChatMessageMissing):
            await store.messages_page("fay", cid, before="chatmsg-nope")
        assert await store.messages_page("gil", cid) is None
        # One archived message, read on its own, with its full text.
        archived = whole.messages[7]
        assert (await store.message("fay", cid, archived.id)).content == archived.content
        exchange = await store.get_exchange("fay", cid, archived.id)
        assert [m.id for m in exchange.messages] == [whole.messages[6].id, archived.id]
        # Search finds text only the full copy of an archived answer holds.
        hits = await store.search("fay", "detail detail detail")
        assert hits.conversations and hits.conversations[0].match.message_id is not None
        # Delete blanks the archive pages and the exchange documents they reference.
        pk = cc.partition_key_for_user("fay")
        page_key = cc.archive_page_key(pk, cid, 0)
        assert cc.ARCHIVE_FIELD in (await kv.get(CHAT_CONVERSATIONS_NS, page_key))
        assert await store.delete("fay", cid) is True
        assert cc.ARCHIVE_FIELD not in (await kv.get(CHAT_CONVERSATIONS_NS, page_key))
        assert cc.EXCHANGE_FIELD not in (await kv.get(CHAT_CONVERSATIONS_NS, cc.exchange_key(pk, archived.id)))


async def test_archived_copies_are_previews_without_the_query(small_archive) -> None:
    kv = MemoryKV()
    store = cc.ChatConversationStore(kv)
    long_text = "w " * 20_000                                # a partial inline copy
    first = await turn(store, "hal", 0, answer=long_text, response={"answer": "a", "query": "q" * 3_000})
    for n in range(1, 10):
        await turn(store, "hal", n, conversation_id=first.conversation_id, answer=long_text,
                   response={"answer": "a", "query": "q" * 3_000})
    pk = cc.partition_key_for_user("hal")
    page = json.loads((await kv.get(CHAT_CONVERSATIONS_NS, cc.archive_page_key(pk, first.conversation_id, 0)))[cc.ARCHIVE_FIELD])
    answers = [m for m in page["messages"] if m["role"] == "assistant"]
    # Short previews: no query, the full copy is in the exchange document.
    assert answers and all("query" not in (m["response"] or {}) for m in answers)
    assert all(len(m["content"]) <= cc.REDUCED_PREVIEW_CHARS for m in answers)
    assert all(m["response"][cc.EXCHANGE_MARKER] is True and m["response"]["truncated"] for m in answers)
    whole = await store.get("hal", first.conversation_id, window=None)
    assert all(m.response["query"] == "q" * 3_000 and m.content == long_text for m in whole.messages[1::2])


async def test_the_hot_paths_restore_one_answer_not_the_transcript(small_archive) -> None:
    kv = CountingKV()
    store = cc.ChatConversationStore(kv)
    big = "z" * 30_000                                  # every answer's inline copy is partial
    first = await turn(store, "ida", 0, answer=big)
    cid = first.conversation_id
    for n in range(1, 30):
        await turn(store, "ida", n, conversation_id=cid, answer=big)
    kv.reset()
    done = await turn(store, "ida", 99, conversation_id=cid, answer=big)
    assert done.assistant_message.content == big
    assert kv.count(cc.EXCHANGE_KEY_PREFIX) <= 2         # never one read per earlier answer
    kv.reset()
    renamed = await store.update("ida", cid, title="Renamed", pinned=True)
    assert renamed.title == "Renamed" and renamed.messages == [] and renamed.earlier_message_count == 62
    assert kv.count(cc.EXCHANGE_KEY_PREFIX) == 0 and kv.count(cc.ARCHIVE_KEY_PREFIX) == 0
    kv.reset()
    exchange = await store.get_exchange("ida", cid, done.assistant_message.id)
    assert exchange.messages[-1].content == big and kv.count(cc.EXCHANGE_KEY_PREFIX) <= 2
    kv.reset()
    window = await store.get("ida", cid, window=6)
    assert len(window.messages) == 6 and kv.count(cc.EXCHANGE_KEY_PREFIX) <= 4
    kv.reset()
    assert await store.exists("ida", cid) and kv.count(cc.EXCHANGE_KEY_PREFIX) == 0


async def test_search_reads_concurrently_and_says_when_it_was_cut_short(monkeypatch) -> None:
    kv = MemoryKV()
    store = cc.ChatConversationStore(kv)
    first = await turn(store, "jo", 0, answer="preamble " * 4_000 + " the BEACONING host was web-7")
    for n in range(1, 6):
        await turn(store, "jo", n, conversation_id=first.conversation_id, answer="y" * 30_000)
    found = await store.search("jo", "beaconing host")
    assert found.conversations and found.search_incomplete is False
    monkeypatch.setattr(cc, "DEEP_SEARCH_MAX_LOADS", 2)
    cut = await store.search("jo", "beaconing host")
    assert cut.conversations == [] and cut.search_incomplete is True


class SlowBlankKV(MemoryKV):
    """Blanking an exchange document waits for ``release`` and records how many
    blanks were in flight at once."""

    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()
        self.release.set()
        self.in_flight = 0
        self.peak = 0

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        if key.startswith(cc.EXCHANGE_KEY_PREFIX) and cc.EXCHANGE_FIELD not in value:
            self.in_flight += 1
            self.peak = max(self.peak, self.in_flight)
            try:
                await asyncio.sleep(0.001)
                await self.release.wait()
            finally:
                self.in_flight -= 1
        await super().put(namespace, key, value)


async def test_an_evicted_conversation_is_cleaned_up_off_the_turn_path() -> None:
    """Retention cleanup of an evicted (long) conversation never delays the answer
    that evicted it: the new answer is saved and returned while the old documents
    are still being blanked, and they are all blanked afterwards."""
    kv = SlowBlankKV()
    store = cc.ChatConversationStore(kv)
    long = await turn(store, "kim", 0, answer="old secret " * 3_000)
    for n in range(1, 30):
        await turn(store, "kim", n, conversation_id=long.conversation_id, answer="old secret " * 3_000)
    for n in range(30, 30 + cc.MAX_CONVERSATIONS_PER_USER - 1):
        await turn(store, "kim", n)
    pk = cc.partition_key_for_user("kim")
    old_keys = [cc.exchange_key(pk, m.id) for m in (await store.get("kim", long.conversation_id, window=None)).messages
                if m.role == "assistant"]
    kv.release.clear()
    done = await asyncio.wait_for(turn(store, "kim", 999, answer="the new answer"), 5)
    assert done.status == "completed" and done.assistant_message.content == "the new answer"
    assert await store.get("kim", long.conversation_id) is None
    kv.release.set()
    await asyncio.wait_for(store.wait_for_cleanup(), 10)
    for key in old_keys:
        assert "old secret" not in json.dumps(await kv.get(CHAT_CONVERSATIONS_NS, key))
    assert kv.peak > 1  # blanked concurrently, not one document at a time


async def test_delete_blanks_a_long_conversation_concurrently() -> None:
    kv = SlowBlankKV()
    store = cc.ChatConversationStore(kv)
    first = await turn(store, "lou", 0, answer="secret " * 3_000)
    for n in range(1, 20):
        await turn(store, "lou", n, conversation_id=first.conversation_id, answer="secret " * 3_000)
    pk = cc.partition_key_for_user("lou")
    keys = [cc.exchange_key(pk, m.id) for m in (await store.get("lou", first.conversation_id, window=None)).messages
            if m.role == "assistant"]
    assert await store.delete("lou", first.conversation_id) is True
    # delete() awaits its cleanup: everything is blank when it returns.
    for key in keys:
        assert "secret" not in json.dumps(await kv.get(CHAT_CONVERSATIONS_NS, key))
    assert kv.peak > 1


async def test_the_previous_build_reads_an_archived_row() -> None:
    """SQL image rollback: the previous build reads the row's inline window and ignores
    the archive record; rolled forward, every message is there again."""
    from tests.test_chat_storage_rollback import sqlite_kv, stable_decode_partition

    async with sqlite_kv() as kv:
        store = cc.ChatConversationStore(kv)
        first = await turn(store, "kai", 0)
        cid = first.conversation_id
        for n in range(1, cc.ARCHIVE_TRIGGER_MESSAGES // 2 + 5):
            await turn(store, "kai", n, conversation_id=cid)
        seen = stable_decode_partition(await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("kai")))
        inline = seen["conversations"][cid].messages
        assert inline and len(inline) <= cc.ARCHIVE_TRIGGER_MESSAGES
        whole = await store.get("kai", cid, window=None)
        assert len(whole.messages) == whole.message_count == 2 * (cc.ARCHIVE_TRIGGER_MESSAGES // 2 + 5)


# --------------------------------------------------------------------------- #
# The re-attach ring: a resume at ANY emitted seq continues exactly.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("sizes", [
    [3_000, 3_000],
    [30] * 300,
    [4_000, 1, 3_999, 2_500, 2_500, 17, 4_000],
    [1_200] * 9,
])
def test_resuming_after_any_chunk_rebuilds_the_text_exactly(sizes: list[int]) -> None:
    ring = TurnEventRing()
    ring.append(TurnStartEvent(turn_id="turn-ring"))
    original = ""
    for index, size in enumerate(sizes):
        text = chr(ord("a") + index % 26) * size
        original += text
        ring.append(TextDeltaEvent(text=text))
    ring.append(TurnDoneEvent(response=ChatResponse(answer=original)))
    first = ring.after(0)
    assert "".join(e.text for _s, e in first if e.type == "text.delta") == original
    assert all(len(e.text) <= MAX_TEXT_DELTA_CHARS for _s, e in first if e.type == "text.delta")
    # A client that got ``prefix`` lines then resumed with after=<last seq seen>.
    for cut in range(1, len(first)):
        seen = first[:cut]
        resumed = ring.after(seen[-1][0])
        text = "".join(e.text for _s, e in [*seen, *resumed] if e.type == "text.delta")
        assert text == original, cut
        seqs = [s for s, _e in [*seen, *resumed]]
        assert seqs == sorted(seqs)


# --------------------------------------------------------------------------- #
# Turns, rings and frames are bound to the account, never just its name.
# --------------------------------------------------------------------------- #
async def test_a_recreated_account_never_sees_its_predecessors_turns() -> None:
    registry = ChatTurnRegistry()
    handle = ChatTurnHandle(turn_id="turn-old", owner="bob", generation="gen-1")
    registry.register(handle)
    assert registry.find("turn-old", "bob", "gen-1") is handle
    assert [h.turn_id for h in registry.running_for("bob", "gen-1")] == ["turn-old"]
    # Same name, new account (another creation time): nothing is visible or stoppable.
    assert registry.find("turn-old", "bob", "gen-2") is None
    assert registry.running_for("bob", "gen-2") == []
    assert registry.request_stop("turn-old", "bob", "gen-2") is False
    assert registry.running_with_key("bob", "k", "gen-2") is None
    # Finished turns stay readable only to their own account.
    handle.finish()
    registry.unregister(handle)
    assert registry.find("turn-old", "bob", "gen-1") is handle
    assert registry.find("turn-old", "bob", "gen-2") is None


async def test_a_reset_forgets_finished_turn_rings() -> None:
    registry = ChatTurnRegistry()
    done = ChatTurnHandle(turn_id="turn-done", owner="ann")
    registry.register(done)
    done.emit(TextDeltaEvent(text="partial answer"))
    done.finish()
    registry.unregister(done)
    assert registry.find("turn-done", "ann") is done
    await registry.cancel_all(timeout=0.1)
    assert registry.find("turn-done", "ann") is None
    # A turn a reset cancelled is never remembered, even when it settles later.
    late = ChatTurnHandle(turn_id="turn-late", owner="ann")
    late.reset_cancelled = True
    registry.register(late)
    registry.unregister(late)
    assert registry.find("turn-late", "ann") is None


async def test_account_generation_comes_from_the_account_record(gated_state) -> None:  # noqa: F811
    state, _provider = gated_state
    assert await routes_chat.account_generation_for(state, "") == ""
    assert await routes_chat.account_generation_for(state, "nobody") == ""
    from app.auth.passwords import hash_password

    await state.users.create(username="zoe", password_hash=hash_password("zoe-pass-123456"))
    first = await routes_chat.account_generation_for(state, "zoe")
    assert first and first == await routes_chat.account_generation_for(state, "ZOE")
    await state.users.delete("zoe")
    await asyncio.sleep(0.002)
    await state.users.create(username="zoe", password_hash=hash_password("zoe-pass-123456"))
    assert await routes_chat.account_generation_for(state, "zoe") not in ("", first)


async def test_an_unreadable_account_registry_is_503_never_an_unmatchable_turn(
    gated_state, monkeypatch,  # noqa: F811
) -> None:
    """A users-document read that fails is a retryable 503 BEFORE the turn is
    admitted (no slot is taken), and on Stop / turns/active / re-attach — never a
    turn bound to a generation its owner can no longer match."""
    from app.auth.passwords import hash_password
    from app.constants import USERS_NS

    state, provider = gated_state
    await state.users.create(username="zoe", password_hash=hash_password("zoe-pass-123456"))
    monkeypatch.setattr(routes_chat, "current_username", lambda request: "zoe")
    kv = state.users._kv
    failures = {"n": 0}
    for name in ("get", "get_strict"):
        real = getattr(kv, name, None)
        if real is None:
            continue

        async def flaky(ns, key, _real=real):  # noqa: ANN001
            if ns == USERS_NS and failures["n"] > 0:
                failures["n"] -= 1
                raise ConnectionError("transient users read failure")
            return await _real(ns, key)

        monkeypatch.setattr(kv, name, flaky)

    failures["n"] = 1
    with pytest.raises(HTTPException) as refused:
        await _start(state, idempotency_key="gen-flake-key-01")
    assert refused.value.status_code == 503
    assert refused.value.detail["code"] == "chat_account_unavailable"
    assert refused.value.detail["retry_after"] > 0
    assert state.chat_turns.active == 0  # no concurrency slot was taken

    # The store recovered: the retry starts a turn its owner can find and stop.
    start, _ = await _start(state, idempotency_key="gen-flake-key-01")
    handle = start.handle
    assert handle.generation
    reader = asyncio.ensure_future(_drain(_relay(handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    request = _request(state)
    for call in (
        lambda: routes_chat.active_chat_turns(request, state),
        lambda: routes_chat.cancel_chat_turn(request, handle.turn_id, state),
        lambda: routes_chat.chat_turn_events(request, handle.turn_id, 0, state),
    ):
        failures["n"] = 1
        with pytest.raises(HTTPException) as blip:
            await call()
        assert blip.value.status_code == 503
        assert blip.value.detail["code"] == "chat_account_unavailable"
    assert [t.turn_id for t in await routes_chat.active_chat_turns(request, state)] == [handle.turn_id]
    stopped = await routes_chat.cancel_chat_turn(request, handle.turn_id, state)
    assert stopped.ok
    provider.gate.set()
    await asyncio.wait_for(reader, 10)


# --------------------------------------------------------------------------- #
# Step observations never outlive an answer that was not saved.
# --------------------------------------------------------------------------- #
async def _ring(store: cc.ChatConversationStore, user: str = "") -> tuple[Any, list[Any]]:
    key = cc.partition_key_for_user(user)
    index = await store._get_aux(cc.observation_index_key(key), cc.OBSERVATION_INDEX_FIELD)
    slots = [await store._get_aux(cc.observation_slot_key(key, n), cc.OBSERVATION_FIELD) for n in range(3)]
    return index, slots


async def test_observations_of_a_turn_whose_conversation_was_deleted_are_discarded(
    gated_state,  # noqa: F811
) -> None:
    from tests.test_chat_routes_stream import FINAL

    state, provider = gated_state
    provider.gate.set()
    provider.push("chat", FINAL)
    first, _ = await _start(state, idempotency_key="obs-orphan-0001")
    await asyncio.wait_for(_drain(_relay(first.handle)), 10)
    cid = first.handle.conversation_id
    provider.gate.clear()
    provider.entered.clear()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", FINAL)
    store = state.chat_conversations
    saved_refs: list[Any] = []
    real_save = store.save_observations

    async def recording_save(*args: Any, **kwargs: Any) -> Any:
        saved_refs.append(await real_save(*args, **kwargs))
        return saved_refs[-1]

    store.save_observations = recording_save  # the instance attribute shadows the method
    second, _ = await _start(state, idempotency_key="obs-orphan-0002", conversation_id=cid)
    reader = asyncio.ensure_future(_drain(_relay(second.handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    assert await state.chat_conversations.delete("", cid)
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    await asyncio.wait_for(second.handle.finished.wait(), 5)
    # The user is told what happened (not the raw store wording).
    assert events[-1].type == "turn.error"
    assert events[-1].message == routes_chat._CONFLICT_MESSAGE
    assert saved_refs and saved_refs[0] is not None  # the lookup's observation WAS stored
    index, slots = await _ring(state.chat_conversations)
    assert not (index or {}).get("slots")
    assert not any(isinstance(slot, dict) and slot.get("steps") for slot in slots)


async def test_observations_of_a_saved_answer_are_kept_and_a_clear_removes_every_slot() -> None:
    store = cc.ChatConversationStore(MemoryKV())
    done = await turn(store, "ora", 1)
    obs = {1: {"tool": "log_stats", "observation": {"top": [["10.0.0.1", 5]]}, "truncated": False}}
    kept_ref, _ = await store.save_observations("ora", turn_id="turn-kept", conversation_id=done.conversation_id,
                                                steps=obs)
    # An orphan: its conversation never held the answer.
    orphan_ref, _ = await store.save_observations("ora", turn_id="turn-orphan", conversation_id="chat-gone",
                                                  steps=obs)
    assert await store.discard_observations("ora", orphan_ref) is True
    assert await store.get_observation("ora", orphan_ref, 1) is None
    assert await store.discard_observations("ora", orphan_ref) is False      # already gone
    assert await store.discard_observations("ora", "o0:turn-other") is False  # slot names another turn
    assert await store.get_observation("ora", kept_ref, 1) is not None
    # A slot whose index entry was lost (a blank that failed) is still cleared.
    stray_ref, _ = await store.save_observations("ora", turn_id="turn-stray", conversation_id="chat-gone",
                                                 steps=obs)
    await store._strict_mutate(cc.observation_index_key(cc.partition_key_for_user("ora")),
                               lambda cur: ({"schema": cc.AUX_SCHEMA, cc.OBSERVATION_INDEX_FIELD:
                                             cc.canonical_json({"next": 3, "slots": {}})}, None))
    await store.clear_all()
    index, slots = await _ring(store, "ora")
    assert not index and not any(isinstance(slot, dict) and slot.get("steps") for slot in slots)
    assert await store.get_observation("ora", kept_ref, 1) is None
    assert await store.get_observation("ora", stray_ref, 1) is None


# --------------------------------------------------------------------------- #
# A same-key retry learns which turn holds the key.
# --------------------------------------------------------------------------- #
async def test_a_same_key_retry_names_the_running_turn(gated_state) -> None:  # noqa: F811
    state, provider = gated_state
    start, _body = await _start(state, idempotency_key="r12-retry-key-01")
    reader = asyncio.ensure_future(_drain(_relay(start.handle)))
    await asyncio.wait_for(provider.entered.wait(), 5)
    with pytest.raises(HTTPException) as busy:
        await _start(state, idempotency_key="r12-retry-key-01")
    detail = busy.value.detail
    assert busy.value.status_code == 409 and detail["code"] == "chat_request_in_progress"
    assert detail["turn_id"] == start.handle.turn_id
    assert detail["conversation_id"] == start.handle.conversation_id and detail["retry_after"] >= 1
    provider.gate.set()
    events = await asyncio.wait_for(reader, 10)
    assert events[-1].type == "turn.done"


async def test_a_same_key_retry_at_the_concurrency_bound_still_names_its_turn(
    gated_state,  # noqa: F811
) -> None:
    """At the per-user bound, a same-key retry of the caller's own running turn is
    409 naming that turn (so the client re-attaches), not 429 ``chat_busy``; a new
    request at the bound is still 429."""
    state, provider = gated_state
    cfg = state.prefs.chat_agent.model_copy(update={"max_concurrent_turns_per_user": 2})
    await state.update_prefs(state.prefs.model_copy(update={"chat_agent": cfg}))
    a, _ = await _start(state, idempotency_key="busy-key-000A")
    b, _ = await _start(state, idempotency_key="busy-key-000B")
    readers = [asyncio.ensure_future(_drain(_relay(h.handle))) for h in (a, b)]
    await asyncio.wait_for(provider.entered.wait(), 5)
    assert state.chat_turns.active == 2
    with pytest.raises(HTTPException) as retry:
        await _start(state, idempotency_key="busy-key-000A")
    assert retry.value.status_code == 409
    assert retry.value.detail["code"] == "chat_request_in_progress"
    assert retry.value.detail["turn_id"] == a.handle.turn_id
    assert state.chat_turns.active == 2  # the retry took no slot
    with pytest.raises(HTTPException) as fresh:
        await _start(state, idempotency_key="busy-key-000C")
    assert fresh.value.status_code == 429 and fresh.value.detail["code"] == "chat_busy"
    provider.gate.set()
    for events in await asyncio.wait_for(asyncio.gather(*readers), 10):
        assert events[-1].type == "turn.done"


# --------------------------------------------------------------------------- #
# D11: a report that could not be saved is reported, never silent.
# --------------------------------------------------------------------------- #
def _report_turn(client, key: str) -> dict[str, Any]:  # noqa: ANN001
    response = client.post("/api/chat", json={
        "message": "Create a monthly SOC report for September", "persist_conversation": True,
        "idempotency_key": key,
    })
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("failure,code,retryable", [
    ("limit", "report_limit", False),
    ("unavailable", "report_unavailable", True),
    ("empty", "report_empty", False),
])
def test_a_report_the_answer_asked_for_that_could_not_be_saved_is_reported(
    failure: str, code: str, retryable: bool, monkeypatch,
) -> None:
    from app.api import routes_reports
    from app.stores.reports import ReportLimitReached, ReportStore, ReportStoreUnavailable

    async def _refuse(*_args: Any, **_kwargs: Any):
        raise ReportLimitReached("full") if failure == "limit" else ReportStoreUnavailable("down")

    if failure == "empty":
        monkeypatch.setattr(routes_reports, "items_for_answer", lambda *_a, **_k: [])
    else:
        monkeypatch.setattr(ReportStore, "create_with_items", _refuse)
    provider = routes_chat_mock()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _open_client(provider) as client:
        answer = _report_turn(client, f"r12-report-fail-{failure}")
        assert answer.get("saved_report") is None
        error = answer["saved_report_error"]
        assert error["code"] == code and error["retryable"] is retryable and error["message"]
        assert "Reports" in error["message"]
        # Recorded on the stored answer, so the transcript and a replay show it.
        detail = client.get(f"/api/chat/conversations/{answer['conversation_id']}").json()
        assert detail["messages"][1]["response"]["saved_report_error"]["code"] == code
        replay = _report_turn(client, f"r12-report-fail-{failure}")
        assert replay["saved_report_error"]["code"] == code
        assert client.get("/api/reports").json()["reports"] == []


def routes_chat_mock():
    from app.llm.providers import MockProvider

    return MockProvider()


# --------------------------------------------------------------------------- #
# "Save conversation as report": the key is bound to the request.
# --------------------------------------------------------------------------- #
def test_a_reused_key_never_returns_another_conversations_report() -> None:
    provider = routes_chat_mock()
    with _open_client(provider) as client:
        conversations = []
        for name in ("A", "B"):
            answer = client.post("/api/chat", json={"message": f"question {name}", "persist_conversation": True,
                                                    "idempotency_key": f"r12-conv-{name}-0001"}).json()
            conversations.append(answer["conversation_id"])
        a, b = conversations
        saved_a = client.post("/api/reports/from-conversation", json={
            "conversation_id": a, "idempotency_key": "save-key-0001"}).json()
        saved_b = client.post("/api/reports/from-conversation", json={
            "conversation_id": b, "title": "B report", "idempotency_key": "save-key-0001"}).json()
        assert saved_b["created"] is True and saved_b["report"]["id"] != saved_a["report"]["id"]
        assert saved_b["report"]["title"] == "B report"
        assert {i["source"]["conversation_id"] for i in saved_b["report"]["items"]} == {b}
        # The same request again is an idempotent replay.
        again = client.post("/api/reports/from-conversation", json={
            "conversation_id": b, "title": "B report", "idempotency_key": "save-key-0001"}).json()
        assert again["created"] is False and again["report"]["id"] == saved_b["report"]["id"]


# --------------------------------------------------------------------------- #
# /chat/context mirrors the engine: mode, timezone, replayed history, output.
# --------------------------------------------------------------------------- #
def test_chat_context_reports_the_mode_timezone_and_the_engines_history() -> None:
    from app.agents.chat import _max_output
    from app.agents.chat_protocol import HISTORY_MAX_EXCHANGES

    provider = routes_chat_mock()
    with _open_client(provider) as client:
        state = client.app.state.tlsoc
        store = state.chat_conversations
        conversation = None
        for n in range(20):
            conversation = client.portal.call(lambda n=n: store.append_exchange(
                None, conversation_id=conversation.id if conversation else None,
                user_content=f"question {n}", assistant_content=f"answer {n} " + "word " * 1_000,
                response={"answer": "x"},
            ))
        cid = conversation.id
        unlimited = client.get("/api/chat/context", params={"conversation_id": cid}).json()
        assert unlimited["limits_mode"] == "unlimited" and unlimited["timezone"] == "UTC"
        assert unlimited["history_exchanges"] == 20
        model = unlimited["model"]
        assert unlimited["max_output_tokens"] >= (_max_output(model) or 0)
        # A stored running summary covers the first 12 answers: only 8 are replayed.
        covers = client.portal.call(lambda: store.get(None, cid, window=None)).messages[23].id
        client.portal.call(lambda: store.set_summary(None, cid, "Earlier: twelve answers.", covers))
        state.chat_turns.context_cache.clear()          # (a turn's end clears it)
        summarised = client.get("/api/chat/context", params={"conversation_id": cid}).json()
        assert summarised["history_exchanges"] == 8
        assert summarised["history_tokens"] < unlimited["history_tokens"]
        # Bounded mode and another timezone: the bounded replay window, labelled zone.
        prefs = state.prefs
        client.portal.call(state.update_prefs, prefs.model_copy(update={
            "chat_agent": prefs.chat_agent.model_copy(update={"limits_mode": "bounded"}),
            "sla": prefs.sla.model_copy(update={"timezone": "Europe/Berlin"}),
        }))
        bounded = client.get("/api/chat/context", params={"conversation_id": cid}).json()
        assert bounded["limits_mode"] == "bounded" and bounded["timezone"] == "Europe/Berlin"
        assert bounded["history_exchanges"] <= HISTORY_MAX_EXCHANGES
        assert bounded["history_tokens"] < unlimited["history_tokens"]
        cfg = state.prefs.chat_agent
        assert bounded["max_output_tokens"] == max(int(state.prefs.chat_model.max_tokens), int(cfg.final_max_tokens))


# --------------------------------------------------------------------------- #
# The prompt library is audited (#2), with counts only.
# --------------------------------------------------------------------------- #
@contextmanager
def _auth_client_with_prefs(provider) -> Iterator[TestClient]:  # noqa: ANN001
    from app.api.routes import router as base_router
    from app.api.routes_prefs import router as prefs_router
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.state import AppState

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="", anthropic_api_key=None,
        openai_api_key=None, auth_enabled=True, auth_jwt_secret="r12-fixes-test-secret",
        auth_seed_admin=True,
    )
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
    for router in (base_router, prefs_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    with TestClient(api) as client:
        yield client


def test_prompt_library_changes_are_audited_without_their_text() -> None:
    provider = routes_chat_mock()
    with _auth_client_with_prefs(provider) as client:
        _login(client, "Admin", "Admin@123")
        state = client.app.state.tlsoc
        prompts = [{"id": "p1", "title": "Weekly", "text": "Weekly report for {team}",
                    "category": "reporting", "favorite": True}]
        assert client.put("/api/prefs/user", json={"chat_prompts": prompts}).status_code == 200
        assert client.put("/api/prefs/user", json={"chat_prompts": prompts}).status_code == 200   # no change
        edited = [{**prompts[0], "text": "Weekly report for {team} and {region}", "favorite": False},
                  {"id": "p2", "title": "Hunt", "text": "Hunt for {ip}", "category": "hunt"}]
        assert client.put("/api/prefs/user", json={"chat_prompts": edited}).status_code == 200
        assert client.put("/api/prefs/user", json={"chat_prompts": []}).status_code == 200
        assert client.put("/api/prefs/user", json={"theme_mode": "dark"}).status_code == 200      # not a prompt change
        rows = client.portal.call(_control_rows, state)
        library = [r for r in rows if r["result_summary"].startswith("chat prompt library updated")]
        assert [r["result_summary"] for r in library] == [
            "chat prompt library updated: added=1 edited=0 removed=0 favorites_changed=0 reordered=no total=1",
            "chat prompt library updated: added=1 edited=1 removed=0 favorites_changed=1 reordered=no total=2",
            "chat prompt library updated: added=0 edited=0 removed=2 favorites_changed=0 reordered=no total=0",
        ]
        assert all(r["actor"] == "Admin" and r["surface"] == "chat" for r in library)
        assert not any("Weekly" in json.dumps(r) or "{team}" in json.dumps(r) for r in rows)


async def _control_rows(state) -> list[dict[str, Any]]:  # noqa: ANN001
    rows = sorted(await state.control_audit.records(limit=500), key=lambda r: str(r.get("ts") or ""))
    return [
        {"result_summary": str(r.get("result_summary") or ""), "actor": r.get("actor"), "surface": r.get("surface")}
        for r in rows
    ]


# --------------------------------------------------------------------------- #
# The chat feedback breakdown (P1-4): aggregates only, owner-scoped.
# --------------------------------------------------------------------------- #
async def test_feedback_breakdown_is_aggregate_only() -> None:
    from app.stores.chat_feedback import ChatFeedbackStore

    store = ChatFeedbackStore(MemoryKV())
    for n, (rating, reason, comment) in enumerate([
        ("up", None, ""), ("down", "wrong", "secret words"), ("down", "slow", ""), ("down", None, "more"),
    ]):
        await store.record("lia", ChatFeedbackRequest(conversation_id="c", message_id=f"m{n}", rating=rating,
                                                       reason=reason, comment=comment))
    summary = await store.breakdown("lia")
    assert summary == {"up": 1, "down": 3, "total": 4, "with_comment": 2,
                       "down_by_reason": {"wrong": 1, "incomplete": 0, "slow": 1, "other": 0},
                       "down_without_reason": 1}
    assert "secret" not in json.dumps(summary)
    assert (await store.breakdown("someone-else"))["total"] == 0
    assert (await store.breakdown("lia", since="2999-01-01"))["total"] == 0


def test_feedback_summary_and_message_routes_are_owner_scoped() -> None:
    provider = routes_chat_mock()
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        answer = client.post("/api/chat", json={"message": "posture?", "persist_conversation": True,
                                                "idempotency_key": "r12-own-0001"}).json()
        cid, mid = answer["conversation_id"], answer["message_id"]
        assert client.post("/api/chat/feedback", json={
            "conversation_id": cid, "message_id": mid, "rating": "down", "reason": "wrong",
            "comment": "private remark"}).status_code == 204
        summary = client.get("/api/chat/feedback/summary").json()
        assert summary["down"] == 1 and summary["down_by_reason"]["wrong"] == 1
        assert "private remark" not in json.dumps(summary)
        one = client.get(f"/api/chat/conversations/{cid}/messages/{mid}")
        assert one.status_code == 200 and one.json()["id"] == mid
        page = client.get(f"/api/chat/conversations/{cid}/messages").json()
        assert [m["id"] for m in page["messages"]][-1] == mid and page["earlier_message_count"] == 0
        assert client.get(f"/api/chat/conversations/{cid}/messages",
                          params={"before": "chatmsg-nope"}).status_code == 404
        assert client.post("/api/users", json={"username": "other", "password": "other-pass-12345",
                                               "role": "analyst_tier1"}).status_code == 200
        _login(client, "other", "other-pass-12345")
        assert client.get("/api/chat/feedback/summary").json()["total"] == 0
        assert client.get(f"/api/chat/conversations/{cid}/messages/{mid}").status_code == 404
        assert client.get(f"/api/chat/conversations/{cid}/messages").status_code == 404


def test_a_conversation_read_is_windowed_with_an_earlier_count() -> None:
    provider = routes_chat_mock()
    with _open_client(provider) as client:
        store = client.app.state.tlsoc.chat_conversations
        conversation = None
        for n in range(cc.TRANSCRIPT_WINDOW // 2 + 3):
            conversation = client.portal.call(lambda n=n: store.append_exchange(
                None, conversation_id=conversation.id if conversation else None,
                user_content=f"q{n}", assistant_content=f"a{n}"))
        detail = client.get(f"/api/chat/conversations/{conversation.id}").json()
        assert len(detail["messages"]) == cc.TRANSCRIPT_WINDOW and detail["earlier_message_count"] == 6
        assert detail["message_count"] == cc.TRANSCRIPT_WINDOW + 6
        older = client.get(f"/api/chat/conversations/{conversation.id}/messages",
                           params={"before": detail["messages"][0]["id"], "limit": 100}).json()
        assert [m["content"] for m in older["messages"]] == ["q0", "a0", "q1", "a1", "q2", "a2"]
        assert older["earlier_message_count"] == 0
        # The listing's search says when it was cut short (only with ?q=).
        listing = client.get("/api/chat/conversations").json()
        assert "search_incomplete" not in listing
        assert client.get("/api/chat/conversations", params={"q": "a7"}).json()["search_incomplete"] is False


def test_a_stream_reattach_resumes_mid_answer(monkeypatch) -> None:
    """The NDJSON re-attach: each line carries its seq; resuming after any of them
    continues the answer without a gap or a repeat."""
    provider = routes_chat_mock()
    long_final = json.dumps({"action": "final", "answer_kind": "conversation"}) + "\n---ANSWER---\n" + long_answer(9_000)
    provider.push("chat", long_final)
    with _open_client(provider) as client:
        done = _ndjson(client.post("/api/chat/stream", json={
            "message": "write a long answer", "persist_conversation": True,
            "idempotency_key": "r12-reattach-0001", "stream_mode": "text"}).text)[-1]
        turn_id = done["response"]["turn_id"]
        lines = _ndjson(client.get(f"/api/chat/turns/{turn_id}/events").text)
        full = "".join(line.get("text", "") for line in lines if line["type"] == "text.delta")
        assert len(full) > MAX_TEXT_DELTA_CHARS
        for line in lines:
            if line["type"] != "text.delta":
                continue
            seen = [x for x in lines if x["seq"] <= line["seq"] and x["type"] == "text.delta"]
            rest = _ndjson(client.get(f"/api/chat/turns/{turn_id}/events", params={"after": line["seq"]}).text)
            text = "".join(x.get("text", "") for x in [*seen, *rest] if x["type"] == "text.delta")
            assert text == full
