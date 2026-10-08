"""An image-only rollback keeps chat history and case threads (WP-L1 fix round).

The PostgreSQL Compose profile's supervised update rolls back APPLICATION IMAGES and
never rewrites state, so on the SQL backend the previous (Stable) build must keep
reading AND writing whatever this build stored. Both chat KV stores therefore write
the released keyed form on SQL and the mapping-safe opaque rows only on the
Elasticsearch KV adapter (where the keyed form grows the shared dynamic mapping).

The ``stable_*`` codecs and ``Stable*`` chat models below are frozen copies of the
released (``main``) code, not imports: a later edit of the live store or models must
not be able to move the contract they pin. ``CaseMessage`` is unchanged since its
release, so the thread codec uses the live model. The released chat models ignore
fields they do not know, so a rolled-back build keeps every transcript, receipt and
stored presentation string, while its next write of a partition drops the
conversation-level fields the revamp added (pin, report link, window, usage totals);
the tests pin both facts.
"""

from __future__ import annotations

import asyncio
import copy
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Literal

from pydantic import BaseModel, Field

from app.constants import CASE_THREAD_KEY, CASE_THREAD_NS, CHAT_CONVERSATIONS_NS
from app.es.fake import InMemoryESClient
from app.models import CaseMessage
from app.stores import chat_conversations as cc
from app.stores.base import kv_mutate
from app.stores.case_thread import THREAD_ROWS_KEY, CaseThreadStore, opaque_rows_for
from app.stores.memory import EsKVStore


@asynccontextmanager
async def sqlite_kv() -> AsyncIterator[Any]:
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        yield SqlKVStore(engine)
    finally:
        await engine.dispose()


# --------------------------------------------------------------------------- #
# Frozen Stable codecs (released ``main``; chat partition schema 2).
# --------------------------------------------------------------------------- #
def stable_thread_decode(doc: dict | None) -> dict[str, list[CaseMessage]]:
    raw = doc.get("threads", {}) if isinstance(doc, dict) else {}
    out: dict[str, list[CaseMessage]] = {}
    for cid, items in (raw or {}).items():
        msgs: list[CaseMessage] = []
        for item in items or []:
            try:
                msgs.append(CaseMessage.model_validate(item))
            except Exception:  # noqa: BLE001
                continue
        out[str(cid)] = msgs
    return out


def stable_thread_encode(threads: dict[str, list[CaseMessage]]) -> dict:
    return {"threads": {cid: [m.model_dump(mode="json") for m in msgs]
                        for cid, msgs in threads.items()}}


class StableChatMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: str = "2026-10-08T00:00:00Z"
    response: dict[str, Any] | None = None
    model: str | None = None
    source_id: str | None = None
    source_name: str | None = None
    idempotency_key: str | None = None


class StableChatConversation(BaseModel):
    id: str
    title: str
    preview: str = ""
    created_at: str
    updated_at: str
    message_count: int = 0
    total_message_count: int = 0
    history_truncated: bool = False
    oldest_retained_at: str | None = None
    model: str | None = None
    source_id: str | None = None
    source_name: str | None = None
    messages: list[StableChatMessage] = Field(default_factory=list)


def stable_normalize_conversation(raw: Any, cid: str) -> StableChatConversation | None:
    try:
        conversation = StableChatConversation.model_validate(raw)
    except Exception:  # noqa: BLE001
        return None
    messages = list(conversation.messages)
    retained = len(messages)
    total = max(int(conversation.total_message_count or 0), retained)
    return conversation.model_copy(update={
        "id": str(cid),
        "message_count": retained,
        "total_message_count": total,
        "history_truncated": bool(conversation.history_truncated or total > retained),
        "oldest_retained_at": messages[0].created_at if messages else None,
    })


def stable_decode_partition(doc: dict[str, Any] | None) -> dict[str, Any]:
    decoded: dict[str, Any] = {"schema": 2, "conversations": {}, "requests": {},
                               "history_truncated": False, "total_conversation_count": 0}
    if not isinstance(doc, dict):
        return decoded
    rows: dict[str, StableChatConversation] = {}
    for cid, raw in (doc.get("conversations") or {}).items():
        conversation = stable_normalize_conversation(raw, str(cid))
        if conversation is not None:
            rows[str(cid)] = conversation
    requests = {
        str(key): copy.deepcopy(value)
        for key, value in (doc.get("requests") or {}).items()
        if isinstance(value, dict)
    }
    retained = len(rows)
    decoded.update({
        "conversations": rows,
        "requests": requests,
        "history_truncated": bool(doc.get("history_truncated", False)),
        "total_conversation_count": max(
            retained, int(doc.get("total_conversation_count", retained) or retained),
        ),
    })
    return decoded


def stable_encode_partition(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": 2,
        "conversations": {
            cid: conversation.model_dump(mode="json")
            for cid, conversation in data["conversations"].items()
        },
        "requests": copy.deepcopy(data.get("requests", {})),
        "history_truncated": bool(data.get("history_truncated", False)),
        "total_conversation_count": max(
            len(data["conversations"]),
            int(data.get("total_conversation_count", 0) or 0),
        ),
    }


async def stable_chat_turn(kv: Any, user: str, cid: str, text: str) -> None:
    """The released build's write of one new conversation: read-modify-write of the
    whole partition through its revision-checked compare-and-set."""
    key = cc.partition_key_for_user(user)
    current = await kv.get(CHAT_CONVERSATIONS_NS, key)
    expected = int((current or {}).get("_rev", 0))
    data = stable_decode_partition(current)
    data["conversations"][cid] = StableChatConversation(
        id=cid, title=text, created_at="2026-10-08T01:00:00Z", updated_at="2026-10-08T01:00:00Z",
        messages=[StableChatMessage(id=f"{cid}-u", role="user", content=text),
                  StableChatMessage(id=f"{cid}-a", role="assistant", content=f"answer to {text}")],
    )
    data["requests"][f"{cid}-key"] = {"status": "completed", "fingerprint": "0" * 64, "conversation_id": cid,
                                      "created_at": "2026-10-08T01:00:00Z", "updated_at": "2026-10-08T01:00:00Z",
                                      "assistant_message_id": f"{cid}-a"}
    saved = stable_encode_partition(data)
    saved["_rev"] = expected + 1
    assert await kv.put_if(CHAT_CONVERSATIONS_NS, key, saved, expected)


# --------------------------------------------------------------------------- #
# Helpers over the live stores.
# --------------------------------------------------------------------------- #
async def live_turn(store: cc.ChatConversationStore, user: str, n: int) -> str:
    key = f"{user}-key-{n:04d}"
    reserved = await store.reserve_exchange(user, idempotency_key=key, request_fingerprint="f" * 64,
                                            conversation_id=None)
    done = await store.complete_exchange(
        user, idempotency_key=key, request_fingerprint="f" * 64, conversation_id=reserved.conversation_id,
        lease_token=reserved.lease_token or "", requested_existing_conversation=False,
        user_content=f"question {n}", assistant_content=f"answer {n}",
        response={"answer": f"answer {n}", "cost": 0.0, "turn_id": f"turn-{n}"}, model="gpt-x",
        source_id=None, source_name="Primary", user_origin="starter", time_range={"from": "now-24h", "to": "now"},
    )
    return done.conversation_id


async def live_threads(store: CaseThreadStore) -> dict[str, CaseMessage]:
    ids: dict[str, CaseMessage] = {}
    for i in range(3):
        human = CaseMessage(case_id=f"case-{i}", author_type="human", author="alice", body=f"note {i}", kind="chat")
        ai, appended = await store.append_if_absent(
            CaseMessage(case_id=f"case-{i}", author_type="ai", author="gpt-x", body=f"ai {i}", kind="chat",
                        ai_meta={"channel": "chat"}))
        assert appended
        await store.append(human)
        await store.react(f"case-{i}", human.id, "+1", "bob")
        ids[f"case-{i}"] = ai
    return ids


# --------------------------------------------------------------------------- #
# Which backend gets which form.
# --------------------------------------------------------------------------- #
async def test_only_the_sql_kv_store_gets_the_keyed_form() -> None:
    async with sqlite_kv() as sql_kv:
        assert opaque_rows_for(sql_kv) is False
        assert CaseThreadStore(sql_kv)._opaque_rows is False
        assert cc.ChatConversationStore(sql_kv)._opaque_rows is False
    es_kv = EsKVStore(InMemoryESClient())
    assert opaque_rows_for(es_kv) is True
    assert CaseThreadStore(es_kv)._opaque_rows is True
    # An unrecognised backend errs on the side that cannot break the shared ES mapping.
    assert opaque_rows_for(object()) is True
    # Tests can pin a form explicitly.
    assert CaseThreadStore(es_kv, opaque_rows=False)._opaque_rows is False


async def test_sql_documents_are_written_in_the_released_keyed_form() -> None:
    async with sqlite_kv() as kv:
        await live_threads(CaseThreadStore(kv))
        thread_doc = await kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)
        assert THREAD_ROWS_KEY not in thread_doc
        assert sorted(thread_doc["threads"]) == ["case-0", "case-1", "case-2"]

        store = cc.ChatConversationStore(kv)
        await live_turn(store, "alice", 1)
        partition = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("alice"))
        assert partition["schema"] == cc.KEYED_STORAGE_FORM
        assert cc.CONVERSATION_ROWS_KEY not in partition and cc.REQUEST_ROWS_KEY not in partition
        assert isinstance(partition["conversations"], dict) and isinstance(partition["requests"], dict)


# --------------------------------------------------------------------------- #
# The rollback round trip on SQL: this build → Stable build → this build.
# --------------------------------------------------------------------------- #
async def test_stable_build_reads_and_extends_case_threads_this_build_wrote_on_sql() -> None:
    async with sqlite_kv() as kv:
        store = CaseThreadStore(kv)
        ai = await live_threads(store)
        await store.edit("case-1", ai["case-1"].id, "edited")

        # Rolled back: the Stable build sees every thread, reactions and edits included.
        seen = stable_thread_decode(await kv.get(CASE_THREAD_NS, CASE_THREAD_KEY))
        assert {cid: [m.body for m in msgs] for cid, msgs in seen.items()} == {
            "case-0": ["ai 0", "note 0"], "case-1": ["edited", "note 1"], "case-2": ["ai 2", "note 2"]}
        assert seen["case-0"][1].reactions == [{"emoji": "+1", "user": "bob"}]

        # ... and writes a comment the way it does (whole-document replace).
        stable_comment = CaseMessage(case_id="case-0", author_type="human", author="carol", body="during rollback")

        def _stable_append(current: dict | None) -> dict:
            threads = stable_thread_decode(current)
            threads["case-0"] = [*threads.get("case-0", []), stable_comment]
            return stable_thread_encode(threads)

        await kv_mutate(kv, CASE_THREAD_NS, CASE_THREAD_KEY, _stable_append, lock=asyncio.Lock())

        # Rolled forward: nothing this build or the Stable build wrote is lost.
        again = CaseThreadStore(kv)
        assert [m.body for m in await again.list_for_case("case-0")] == ["ai 0", "note 0", "during rollback"]
        assert [m.body for m in await again.list_for_case("case-1")] == ["edited", "note 1"]
        assert [m.body for m in await again.list_for_case("case-2")] == ["ai 2", "note 2"]
        # A keyed chat retry still deduplicates against what survived the round trip.
        _, appended = await again.append_if_absent(ai["case-2"])
        assert appended is False


async def test_stable_build_reads_and_extends_chat_history_this_build_wrote_on_sql() -> None:
    async with sqlite_kv() as kv:
        store = cc.ChatConversationStore(kv)
        first = await live_turn(store, "alice", 1)
        second = await live_turn(store, "alice", 2)
        await store.update("alice", first, title="Pinned thread", pinned=True)

        # Rolled back: the Stable build lists both conversations and both receipts.
        seen = stable_decode_partition(await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("alice")))
        assert set(seen["conversations"]) == {first, second}
        assert [m.content for m in seen["conversations"][second].messages] == ["question 2", "answer 2"]
        assert {r["status"] for r in seen["requests"].values()} == {"completed"}
        assert len(seen["requests"]) == 2

        # ... and runs a turn of its own.
        await stable_chat_turn(kv, "alice", "chat-stable", "asked during rollback")

        # Rolled forward: all three conversations, their transcripts, the stored
        # presentation and the receipts survive.
        page = await cc.ChatConversationStore(kv).list_page("alice")
        assert {c.id for c in page.conversations} == {first, second, "chat-stable"}
        restored = await store.get("alice", "chat-stable")
        assert restored is not None and restored.messages[-1].content == "answer to asked during rollback"
        mine = await store.get("alice", second)
        assert [m.content for m in mine.messages] == ["question 2", "answer 2"]
        assert mine.messages[-1].response and mine.messages[-1].response.get("turn_id") == "turn-2"
        # Known, accepted degradation: the released model has no pin, so its write
        # of the partition dropped it (the conversation itself is intact).
        assert not (await store.get("alice", first)).pinned
        # The live build's own receipt still replays (no duplicate turn on a retry).
        replay = await store.reserve_exchange("alice", idempotency_key="alice-key-0002",
                                              request_fingerprint="f" * 64, conversation_id=None)
        assert replay.status == "completed" and replay.conversation_id == second


async def test_sql_store_reads_an_opaque_document_and_rewrites_it_keyed() -> None:
    """A SQL document written in the opaque form (a pre-release build of this change)
    is read in full and returned to the released form by the next write."""
    async with sqlite_kv() as kv:
        es_like = cc.ChatConversationStore(kv, opaque_rows=True)
        cid = await live_turn(es_like, "bob", 1)
        key = cc.partition_key_for_user("bob")
        assert cc.is_opaque_form(await kv.get(CHAT_CONVERSATIONS_NS, key))
        store = cc.ChatConversationStore(kv)
        await store.update("bob", cid, title="Renamed")
        doc = await kv.get(CHAT_CONVERSATIONS_NS, key)
        assert not cc.is_opaque_form(doc) and stable_decode_partition(doc)["conversations"][cid].title == "Renamed"

        await CaseThreadStore(kv, opaque_rows=True).append(
            CaseMessage(case_id="case-9", author_type="human", author="bob", body="opaque"))
        assert THREAD_ROWS_KEY in await kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)
        await CaseThreadStore(kv).append(CaseMessage(case_id="case-9", author_type="human", author="bob", body="keyed"))
        thread_doc = await kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)
        assert [m.body for m in stable_thread_decode(thread_doc)["case-9"]] == ["opaque", "keyed"]


async def test_clearing_history_on_sql_writes_the_keyed_form() -> None:
    async with sqlite_kv() as kv:
        store = cc.ChatConversationStore(kv)
        await live_turn(store, "erin", 1)
        assert await store.clear_all() == 1
        partition = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("erin"))
        assert partition["schema"] == cc.KEYED_STORAGE_FORM and partition["conversations"] == {}
        assert stable_decode_partition(partition)["conversations"] == {}


# --------------------------------------------------------------------------- #
# The Elasticsearch adapter: mapping-safe, and one-way by design.
# --------------------------------------------------------------------------- #
async def test_elasticsearch_form_is_one_way_by_design() -> None:
    """Pins the documented trade on the Elasticsearch backend (no supervised rollback
    there): the opaque rows keep the shared mapping bounded, and a build released
    before them does not read them. If this ever changes, the rollback notes in the
    store docstrings and the release notes must change with it."""
    kv = EsKVStore(InMemoryESClient())
    await live_threads(CaseThreadStore(kv))
    assert stable_thread_decode(await kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)) == {}
    store = cc.ChatConversationStore(kv)
    await live_turn(store, "alice", 1)
    doc = await kv.get(CHAT_CONVERSATIONS_NS, cc.partition_key_for_user("alice"))
    assert doc["schema"] == cc.OPAQUE_STORAGE_FORM
    assert stable_decode_partition(doc)["conversations"] == {}


def test_with_stored_rows_keeps_the_documents_own_form() -> None:
    row = {"id": "chat-1", "title": "t", "messages": []}
    keyed = cc.with_stored_rows({"schema": 2, "conversations": {}, "requests": {}}, conversations={"chat-1": row})
    assert keyed["schema"] == cc.KEYED_STORAGE_FORM and keyed["conversations"] == {"chat-1": row}
    opaque = cc.with_stored_rows(cc._encode_partition(cc._empty_partition()), conversations={"chat-1": row})
    assert cc.is_opaque_form(opaque) and "conversations" not in opaque
    assert cc.stored_conversation_rows(keyed) == cc.stored_conversation_rows(opaque) == {"chat-1": row}
    forced = cc.with_stored_rows(keyed, opaque=True)
    assert cc.is_opaque_form(forced) and "conversations" not in forced and "requests" not in forced
    assert cc.with_stored_rows({})["schema"] == cc.OPAQUE_STORAGE_FORM
