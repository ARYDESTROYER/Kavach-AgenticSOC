"""Round 12 Workspace chat storage (WP-API): chat without limits.

Every test runs on the three KV backends the platform ships: a plain in-memory
``KVStore`` (no ``get_strict``/``put_if_strict``; the generic ``put_if``), the
Elasticsearch adapter over the in-memory ES fake (opaque rows) and SQLite (the keyed
form the SQL rollback contract pins).

* full answer text is persisted and replays byte for byte (60,000+ characters), with
  the full presentation (a 300-row table), and nothing is evicted by the old
  24k / 16 kB / 256 kB / 100-message limits;
* pins, report links, time ranges and usage totals survive;
* the conversation summary (D4), the step-observation ring (P1-1), live status and
  unread (D13), the lease heartbeat, update_message_response (D11) and deletion
  blanking the auxiliary documents;
* the SQL image-rollback notes: the previous build reads the inline copies and its
  writes keep the markers, so rolling forward restores the full text.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import pytest

from app.agents.blocks import validate_blocks
from app.constants import CHAT_CONVERSATIONS_NS
from app.es.fake import InMemoryESClient
from app.models import ChatResponse
from app.stores import chat_conversations as cc
from app.stores.base import KVStore, _rev_of
from app.stores.chat_feedback import CHAT_FEEDBACK_NS, ChatFeedbackStore
from app.stores.memory import EsKVStore


class MemoryKV(KVStore):
    """The simplest KVStore: a dict, the base (non-strict) ``put_if``."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict[str, Any]] = {}

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        value = self.docs.get((namespace, key))
        return json.loads(json.dumps(value)) if value is not None else None

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self.docs[(namespace, key)] = json.loads(json.dumps(value))


@asynccontextmanager
async def kv_backend(kind: str) -> AsyncIterator[Any]:
    if kind == "memory":
        yield MemoryKV()
    elif kind == "es":
        yield EsKVStore(InMemoryESClient())
    else:
        from app.stores.sql import SqlKVStore, build_async_engine, create_all

        engine = build_async_engine("sqlite+aiosqlite:///:memory:")
        await create_all(engine)
        try:
            yield SqlKVStore(engine)
        finally:
            await engine.dispose()


BACKENDS = ["memory", "es", "sqlite"]


def long_answer(chars: int = 61_000) -> str:
    """Markdown with headings, unicode, quotes and code: every byte must survive."""
    parts = ["# Quarterly investigation of 10.0.4.7\n\n"]
    index = 0
    while sum(len(p) for p in parts) < chars:
        parts.append(
            f"## Finding {index} — “quoted” ünïcödé\n\n"
            f"Host `web-{index}` contacted `198.51.100.{index % 250}` {index * 3} times; "
            'the "beacon" interval was 60 s.\n\n```text\nline\\with\\backslashes\n```\n\n'
        )
        index += 1
    return "".join(parts)


def big_table_response(answer: str, rows: int = 300) -> dict[str, Any]:
    raw = [{
        "id": "b1", "type": "table", "provenance": "source", "artifact_kind": "table",
        "title": "Every event", "untrusted": True,
        "columns": [{"key": f"c{c}", "label": f"Column {c}", "type": "text"} for c in range(8)],
        "rows": [[f"row-{r}-col-{c}" for c in range(8)] for r in range(rows)],
    }]
    blocks, dropped = validate_blocks(raw)
    assert not dropped, dropped
    response = ChatResponse(
        answer=answer, blocks=blocks, answer_kind="data", stream_mode="text", turn_id="turn-big",
        usage={"calls": 3, "input_tokens": 9000, "output_tokens": 16000, "total_tokens": 25000,
               "cost": 0.25, "model": "gpt-5.6-luna"},
        steps=[{"index": 1, "ordinal": 1, "kind": "tool", "tool": "log_stats", "label": "Counted events",
                "status": "ok", "summary": "300 rows", "query": "q" * 5_000}],
    )
    return response.model_dump(mode="json")


async def turn(
    store: cc.ChatConversationStore, user: str, n: int, *, conversation_id: str | None = None,
    answer: str | None = None, response: dict[str, Any] | None = None, question: str | None = None,
    time_range: Any = False,
) -> cc.ChatExchangeReservation:
    key = f"{user}-r12-{n:06d}"
    reserved = await store.reserve_exchange(
        user, idempotency_key=key, request_fingerprint=f"{n:064x}", conversation_id=conversation_id,
        title_hint=question or f"question {n}",
    )
    text = answer if answer is not None else f"answer {n}"
    return await store.complete_exchange(
        user, idempotency_key=key, request_fingerprint=f"{n:064x}",
        conversation_id=reserved.conversation_id, lease_token=reserved.lease_token or "",
        requested_existing_conversation=conversation_id is not None,
        user_content=question or f"question {n}", assistant_content=text,
        response=response if response is not None else {"answer": text, "cost": 0.0},
        model="gpt-5.6-luna", source_id=None, source_name="Primary", time_range=time_range,
    )


# --------------------------------------------------------------------------- #
# Unbounded answers.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("backend", BACKENDS)
async def test_a_60k_answer_with_a_300_row_table_replays_byte_for_byte(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        answer = long_answer()
        assert len(answer) > 60_000
        question = "Investigate 10.0.4.7 over the last quarter. " + "Context " * 3_000
        response = big_table_response(answer)
        done = await turn(store, "alice", 1, answer=answer, response=response, question=question)
        assert done.assistant_message.content == answer
        assert done.assistant_message.response["blocks"] == response["blocks"]
        # A fresh store (nothing cached) reads it back whole.
        again = await cc.ChatConversationStore(kv).get("alice", done.conversation_id)
        user, assistant = again.messages
        assert user.content == question and assistant.content == answer
        assert assistant.response["blocks"] == response["blocks"]
        assert len(assistant.response["blocks"][0]["rows"]) == len(response["blocks"][0]["rows"]) >= 200
        assert assistant.response["steps"] == response["steps"]
        assert "truncated" not in assistant.response and cc.EXCHANGE_MARKER not in assistant.response
        assert again.history_truncated is False
        # A same-key replay restores it byte for byte too.
        replay = await store.reserve_exchange(
            "alice", idempotency_key="alice-r12-000001", request_fingerprint=f"{1:064x}",
            conversation_id=None,
        )
        assert replay.status == "completed" and replay.assistant_message.content == answer
        assert replay.assistant_message.response["blocks"] == response["blocks"]
        # The inline copy in the partition stays bounded (the full text is elsewhere).
        doc = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("alice"))
        row = cc.stored_conversation_rows(doc)[done.conversation_id]
        inline = row["messages"][1]
        assert len(inline["content"]) <= cc.MAX_ASSISTANT_MESSAGE_CHARS
        assert inline["response"]["truncated"] is True and inline["response"][cc.EXCHANGE_MARKER] is True


@pytest.mark.parametrize("backend", BACKENDS)
async def test_long_threads_keep_every_message_and_totals(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        first = await turn(store, "bob", 0, answer="x" * 30_000, time_range={"from": "now-7d"},
                           response={"answer": "x" * 30_000, "cost": 0.01,
                                     "usage": {"total_tokens": 10, "cost": 0.01}})
        cid = first.conversation_id
        await store.update("bob", cid, pinned=True)
        await store.set_report_id("bob", cid, "rpt-abc")
        for n in range(1, 70):
            await turn(store, "bob", n, conversation_id=cid, answer=f"answer {n} " + "y" * 9_000,
                       response={"answer": "a", "cost": 0.01, "usage": {"total_tokens": 10, "cost": 0.01}})
        conversation = await cc.ChatConversationStore(kv).get("bob", cid, window=None)
        assert len(conversation.messages) == 140 and conversation.total_message_count == 140
        # The default read is the newest window; the rest is counted, never dropped.
        windowed = await store.get("bob", cid)
        assert len(windowed.messages) == cc.TRANSCRIPT_WINDOW and windowed.earlier_message_count == 40
        assert windowed.message_count == 140
        assert [m.content for m in windowed.messages] == [m.content for m in conversation.messages[40:]]
        assert conversation.messages[1].content == "x" * 30_000
        assert [m.content for m in conversation.messages[3::2]] == [
            f"answer {n} " + "y" * 9_000 for n in range(1, 70)]
        assert conversation.pinned is True and conversation.report_id == "rpt-abc"
        assert conversation.usage_turns == 70 and conversation.total_tokens == 700
        assert conversation.time_range is not None
        assert not cc.turns_removed(conversation) and conversation.history_truncated is False
        doc = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("bob"))
        stored = cc.stored_conversation_rows(doc)[cid]["messages"]
        # The partition row stays near the inline budget: old messages are previews.
        assert len(json.dumps(stored, ensure_ascii=False).encode()) <= cc.MAX_CONVERSATION_BYTES + 140 * 700
        assert len(stored[1]["content"]) <= cc.REDUCED_PREVIEW_CHARS


@pytest.mark.parametrize("backend", BACKENDS)
async def test_search_finds_text_beyond_the_inline_preview(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        first = await turn(store, "cy", 0, answer="preamble " * 4_000 + " the BEACONING host was web-7")
        for n in range(1, 40):
            await turn(store, "cy", n, conversation_id=first.conversation_id, answer="z" * 9_000)
        hits = await store.search("cy", "beaconing host")
        assert [h.id for h in hits.conversations] == [first.conversation_id]
        assert hits.conversations[0].match.message_id == first.assistant_message.id
        assert "beaconing" in hits.conversations[0].match.snippet.lower()


# --------------------------------------------------------------------------- #
# Live status, unread, the temporary row, heartbeat.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("backend", BACKENDS)
async def test_status_running_needs_input_failed_and_unread(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        # A brand-new thread is listed as a temporary running row while it answers.
        reserved = await store.reserve_exchange(
            "dee", idempotency_key="dee-new-0001", request_fingerprint="a" * 64,
            conversation_id=None, title_hint="  Which hosts beaconed\nlast week?  ",
        )
        page = await store.list_page("dee")
        assert page.total == 1 and page.total_conversation_count == 0
        row = page.conversations[0]
        assert row.id == reserved.conversation_id and row.status == "running"
        assert row.title == "Which hosts beaconed last week?" and row.message_count == 0
        assert await store.get("dee", reserved.conversation_id) is None   # not a conversation yet
        done = await store.complete_exchange(
            "dee", idempotency_key="dee-new-0001", request_fingerprint="a" * 64,
            conversation_id=reserved.conversation_id, lease_token=reserved.lease_token or "",
            requested_existing_conversation=False, user_content="Which hosts beaconed last week?",
            assistant_content="Two.", response={"answer": "Two.", "cost": 0.0}, model=None,
            source_id=None, source_name=None,
        )
        row = (await store.list_page("dee")).conversations[0]
        assert row.status == "idle" and row.unread is True and row.message_count == 2
        assert await store.mark_read("dee", done.conversation_id) is True
        assert (await store.list_page("dee")).conversations[0].unread is False
        assert await store.mark_read("dee", "chat-not-mine") is False
        assert await store.mark_read("someone-else", done.conversation_id) is False

        # An existing thread with a question in flight reads "running".
        again = await store.reserve_exchange(
            "dee", idempotency_key="dee-next-0001", request_fingerprint="b" * 64,
            conversation_id=done.conversation_id,
        )
        assert (await store.get("dee", done.conversation_id)).status == "running"
        # A failed turn leaves "failed" until the next answer.
        await store.abort_exchange("dee", idempotency_key="dee-next-0001", request_fingerprint="b" * 64,
                                   lease_token=again.lease_token or "", mark_failed=True)
        assert (await store.list_page("dee")).conversations[0].status == "failed"
        # A clarifying question waits for a pick; the next plain answer clears it.
        await turn(store, "dee", 3, conversation_id=done.conversation_id,
                   response={"answer": "Which week?", "clarify": {"question": "Which week?", "options": ["Last"]}})
        assert (await store.list_page("dee")).conversations[0].status == "needs_input"
        await turn(store, "dee", 4, conversation_id=done.conversation_id)
        assert (await store.list_page("dee")).conversations[0].status == "idle"
        # A stopped turn (no failure) leaves the stored status alone.
        stop = await store.reserve_exchange("dee", idempotency_key="dee-stop-0001",
                                            request_fingerprint="c" * 64, conversation_id=done.conversation_id)
        await store.abort_exchange("dee", idempotency_key="dee-stop-0001", request_fingerprint="c" * 64,
                                   lease_token=stop.lease_token or "")
        assert (await store.list_page("dee")).conversations[0].status == "idle"


@pytest.mark.parametrize("backend", BACKENDS)
async def test_a_stale_reservation_is_no_longer_running(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        await store.reserve_exchange("eve", idempotency_key="eve-0001-key", request_fingerprint="d" * 64,
                                     conversation_id=None, title_hint="q")
        key = cc.partition_key_for_user("eve")
        doc = await kv.get(CHAT_CONVERSATIONS_NS, key)
        rows = cc.stored_request_rows(doc)
        rows["eve-0001-key"]["updated_at"] = "2000-01-01T00:00:00Z"     # the process died
        await kv.put(CHAT_CONVERSATIONS_NS, key, {**cc.with_stored_rows(doc, requests=rows), "_rev": _rev_of(doc)})
        assert (await store.list_page("eve")).total == 0


@pytest.mark.parametrize("backend", BACKENDS)
async def test_the_lease_heartbeat_renews_only_its_own_live_lease(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        args = {"idempotency_key": "fay-0001-key", "request_fingerprint": "e" * 64}
        reserved = await store.reserve_exchange("fay", conversation_id=None, **args)
        key = cc.partition_key_for_user("fay")
        doc = await kv.get(CHAT_CONVERSATIONS_NS, key)
        rows = cc.stored_request_rows(doc)
        rows["fay-0001-key"]["updated_at"] = "2000-01-01T00:00:00Z"
        await kv.put(CHAT_CONVERSATIONS_NS, key, {**cc.with_stored_rows(doc, requests=rows), "_rev": _rev_of(doc)})
        before = await kv.get(CHAT_CONVERSATIONS_NS, key)
        assert await store.renew_exchange("fay", lease_token=reserved.lease_token or "", **args) is True
        assert await store.renew_exchange("fay", lease_token=reserved.lease_token or "", **args) is True
        # The heartbeat writes only the small live-state document, never the partition.
        assert _rev_of(await kv.get(CHAT_CONVERSATIONS_NS, key)) == _rev_of(before)
        live = json.loads((await kv.get(CHAT_CONVERSATIONS_NS, cc.live_state_key(key)))[cc.LIVE_STATE_FIELD])
        assert live["leases"]["fay-0001-key"]["token"] == reserved.lease_token
        assert live["leases"]["fay-0001-key"]["at"] > "2001"
        # A renewed lease is not reclaimable by a same-key retry.
        with pytest.raises(cc.ChatRequestInProgress):
            await store.reserve_exchange("fay", conversation_id=None, **args)
        assert await store.renew_exchange("fay", lease_token="chatlease-other", **args) is False
        await store.complete_exchange(
            "fay", conversation_id=reserved.conversation_id, lease_token=reserved.lease_token or "",
            requested_existing_conversation=False, user_content="q", assistant_content="a",
            response=None, model=None, source_id=None, source_name=None, **args,
        )
        assert await store.renew_exchange("fay", lease_token=reserved.lease_token or "", **args) is False


# --------------------------------------------------------------------------- #
# Summary, observations, presentation updates, deletion.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("backend", BACKENDS)
async def test_conversation_summary_round_trip(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        first = await turn(store, "gus", 1)
        second = await turn(store, "gus", 2, conversation_id=first.conversation_id)
        cid = first.conversation_id
        assert await store.get_summary("gus", cid) is None
        covers = first.assistant_message.id
        assert await store.set_summary("gus", cid, "Earlier: host web-7 beaconed.", covers) is True
        summary = await store.get_summary("gus", cid)
        assert summary.text == "Earlier: host web-7 beaconed." and summary.covers_through == covers
        # Both engine conventions read it.
        assert summary["summary_text"] == summary.summary_text == summary.text
        assert dict(summary)["summary_covers_through"] == covers
        assert (await store.get("gus", cid)).summary_covers_through == covers
        # Only the messages after the summary are restored when asked.
        partial = await store.get("gus", cid, hydrate_after=covers)
        assert partial.messages[-1].id == second.assistant_message.id
        # Another user, an unknown message id and another conversation are refused.
        assert await store.get_summary("hal", cid) is None
        assert await store.set_summary("gus", cid, "x", "chatmsg-nope") is False
        assert await store.set_summary("hal", cid, "x", covers) is False
        # Deleting the conversation blanks the summary document.
        assert await store.delete("gus", cid) is True
        assert await store.get_summary("gus", cid) is None


@pytest.mark.parametrize("backend", BACKENDS)
async def test_step_observation_ring_is_owner_scoped_and_bounded(backend: str, monkeypatch) -> None:
    monkeypatch.setattr(cc, "OBSERVATION_RING_SIZE", 3)
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        done = await turn(store, "ida", 1)
        cid = done.conversation_id
        obs = {2: {"tool": "log_stats", "observation": {"top": [["10.0.0.1", 5]]}, "truncated": False}}
        ref, stored = await store.save_observations("ida", turn_id="turn-1", conversation_id=cid, steps=obs)
        assert stored == {2} and ref.startswith("o0:")
        assert (await store.get_observation("ida", ref, 2))["observation"] == {"top": [["10.0.0.1", 5]]}
        assert await store.get_observation("ida", ref, 3) is None
        assert await store.get_observation("joe", ref, 2) is None        # another owner
        assert await store.get_observation("ida", "o0:turn-other", 2) is None
        assert await store.get_observation("ida", "garbage", 2) is None
        # The ring keeps the newest 3 answers: the 4th write reuses slot 0.
        for n in range(2, 5):
            await store.save_observations("ida", turn_id=f"turn-{n}", conversation_id=cid, steps=obs)
        assert await store.get_observation("ida", ref, 2) is None        # expired
        latest_ref = "o0:turn-4"
        assert await store.get_observation("ida", latest_ref, 2) is not None
        # Deleting the conversation scrubs its slots.
        assert await store.delete("ida", cid) is True
        assert await store.get_observation("ida", latest_ref, 2) is None


@pytest.mark.parametrize("backend", BACKENDS)
async def test_update_message_response_reaches_the_inline_copy_and_the_exchange(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        small = await turn(store, "kim", 1)
        big = await turn(store, "kim", 2, conversation_id=small.conversation_id,
                         answer=long_answer(30_000), response=big_table_response(long_answer(30_000)))
        saved = {"id": "rpt-123", "title": "Monthly", "items": 4}
        for done in (small, big):
            assert await store.update_message_response(
                "kim", done.conversation_id, done.assistant_message.id, {"saved_report": saved}) is True
        conversation = await cc.ChatConversationStore(kv).get("kim", small.conversation_id)
        assert [m.response.get("saved_report") for m in conversation.messages[1::2]] == [saved, saved]
        assert conversation.messages[3].content == long_answer(30_000)
        assert len(conversation.messages[3].response["blocks"][0]["rows"]) >= 200
        assert await store.update_message_response("kim", small.conversation_id, "chatmsg-nope", {}) is False
        assert await store.update_message_response("lee", small.conversation_id,
                                                   small.assistant_message.id, {}) is False


@pytest.mark.parametrize("backend", BACKENDS)
async def test_delete_and_eviction_blank_the_full_text(backend: str) -> None:
    async with kv_backend(backend) as kv:
        store = cc.ChatConversationStore(kv)
        done = await turn(store, "mia", 1, answer="secret finding " * 10)
        pk = cc.partition_key_for_user("mia")
        xkey = cc.exchange_key(pk, done.assistant_message.id)
        assert cc.EXCHANGE_FIELD in (await kv.get(CHAT_CONVERSATIONS_NS, xkey))
        feedback = ChatFeedbackStore(kv)
        from app.models import ChatFeedbackRequest

        await feedback.record("mia", ChatFeedbackRequest(conversation_id=done.conversation_id,
                                                         message_id=done.assistant_message.id,
                                                         rating="down", comment="my words"))
        assert await store.delete("mia", done.conversation_id) is True
        blank = await kv.get(CHAT_CONVERSATIONS_NS, xkey)
        assert cc.EXCHANGE_FIELD not in blank and "secret" not in json.dumps(blank)
        assert await feedback.list("mia") == []
        # Retention eviction (the 51st unpinned conversation) blanks the oldest too.
        oldest = await turn(store, "mia", 100, answer="old secret")
        old_key = cc.exchange_key(pk, oldest.assistant_message.id)
        for n in range(cc.MAX_CONVERSATIONS_PER_USER):
            await store.append_exchange("mia", conversation_id=None, user_content=f"q{n}", assistant_content="a")
        assert await store.get("mia", oldest.conversation_id) is None
        assert "old secret" not in json.dumps(await kv.get(CHAT_CONVERSATIONS_NS, old_key))
        # clear_all (tiered reset) blanks every remaining exchange.
        survivor = (await store.list_page("mia")).conversations[0]
        conv = await store.get("mia", survivor.id)
        survivor_key = cc.exchange_key(pk, conv.messages[1].id)
        await store.clear_all()
        assert cc.EXCHANGE_FIELD not in (await kv.get(CHAT_CONVERSATIONS_NS, survivor_key))


# --------------------------------------------------------------------------- #
# Mapping safety and the SQL rollback notes.
# --------------------------------------------------------------------------- #
async def test_auxiliary_documents_keep_the_elasticsearch_mapping_bounded() -> None:
    from tests.test_chat_storage_mapping import RecordingKV, field_paths

    kv = RecordingKV()
    store = cc.ChatConversationStore(kv)
    for n in range(4):
        done = await turn(store, "nia", n, answer=long_answer(5_000),
                          response={**big_table_response(long_answer(5_000), rows=20),
                                    f"weird_{n}": {"nested": [{"2026-10-01": n}]}})
        await store.set_summary("nia", done.conversation_id, f"summary {n}", done.assistant_message.id)
        await store.save_observations("nia", turn_id=f"turn-{n}", conversation_id=done.conversation_id,
                                      steps={1: {"observation": {f"key_{n}": {"2026": [1, 2]}}}})
    paths = set()
    for ns, key, value in kv.written:
        if ns == CHAT_CONVERSATIONS_NS and not key.startswith("user-") and key != "conversations":
            paths |= field_paths(value)
    assert paths == {"_rev", "schema", cc.EXCHANGE_FIELD, cc.SUMMARY_FIELD, cc.OBSERVATION_FIELD,
                     cc.OBSERVATION_INDEX_FIELD, cc.LIVE_STATE_FIELD}
    # Keys are short opaque digests (SQL kv.key is 128 characters; no raw ids).
    keys = {key for ns, key, _ in kv.written if ns == CHAT_CONVERSATIONS_NS}
    assert all(len(k) <= 128 for k in keys) and not any("nia" in k for k in keys)


async def test_feedback_document_keeps_the_mapping_bounded() -> None:
    from tests.test_chat_storage_mapping import RecordingKV

    kv = RecordingKV()
    feedback = ChatFeedbackStore(kv)
    from app.models import ChatFeedbackRequest

    for n in range(20):
        await feedback.record("ola", ChatFeedbackRequest(conversation_id=f"chat-{n}", message_id=f"m-{n}",
                                                         rating="up" if n % 2 else "down",
                                                         reason="wrong" if n % 3 == 0 else None,
                                                         comment=f"2026-10-0{n % 9 + 1}"))
    assert kv.paths(CHAT_FEEDBACK_NS) == {"_rev", "schema", "chat_feedback_json"}
    assert await feedback.counts("ola") == {"up": 10, "down": 10}


async def test_sql_rollback_reads_inline_copies_and_roll_forward_restores_full_text() -> None:
    from tests.test_chat_storage_rollback import (
        sqlite_kv,
        stable_chat_turn,
        stable_decode_partition,
    )

    async with sqlite_kv() as kv:
        store = cc.ChatConversationStore(kv)
        answer = long_answer()
        done = await turn(store, "pat", 1, answer=answer, response=big_table_response(answer))
        cid = done.conversation_id
        # Rolled back: the previous build reads the conversation and its inline copy.
        seen = stable_decode_partition(await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("pat")))
        inline = seen["conversations"][cid].messages[1]
        assert answer.startswith(inline.content.split("\n… [truncated in saved history]")[0])
        assert len(inline.content) <= cc.MAX_ASSISTANT_MESSAGE_CHARS
        assert inline.response["truncated"] is True and inline.response[cc.EXCHANGE_MARKER] is True
        # ...and writes a turn of its own (whole-partition rewrite).
        await stable_chat_turn(kv, "pat", "chat-stable", "asked during rollback")
        # Rolled forward: the full text is restored and the rollback turn kept.
        conversation = await cc.ChatConversationStore(kv).get("pat", cid)
        assert conversation.messages[1].content == answer
        assert len(conversation.messages[1].response["blocks"][0]["rows"]) >= 200
        assert (await store.get("pat", "chat-stable")).messages[-1].content == "answer to asked during rollback"
