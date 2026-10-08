"""The chat KV documents cannot grow the shared Elasticsearch mapping (WP-L1).

On the Elasticsearch state backend every KV namespace is a document in ONE config
index with ONE dynamic mapping (default limit: 1,000 fields). A document whose
object KEYS are data (conversation ids, idempotency keys, case ids) mints new mapped
fields with every new record until every KV write in the index fails. These tests
flatten each stored document the way a dynamic mapping sees it (object keys become
dotted paths; arrays are transparent) and assert that the set of paths is small and
does not depend on how much data the document holds.
"""

from __future__ import annotations

import json
from typing import Any

from app.constants import CASE_THREAD_KEY, CASE_THREAD_NS, CHAT_CONVERSATIONS_NS
from app.es.fake import InMemoryESClient
from app.models import CaseMessage, ChatConversation, ChatConversationMessage, ReportItem
from app.stores import chat_conversations as cc
from app.stores.case_thread import THREAD_ROWS_KEY, CaseThreadStore, stored_threads
from app.stores.memory import EsKVStore
from app.stores.reports import ReportStore, new_item_id

# A handful of top-level fields: _rev, schema, the two row arrays, two scalars.
MAX_PARTITION_PATHS = 8


def field_paths(value: Any, prefix: str = "") -> set[str]:
    """Every mapped field path of ``value`` as a dynamic mapping sees it: object
    keys become dotted paths (objects count too), arrays are transparent."""
    paths: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            paths.add(path)
            paths |= field_paths(item, path)
    elif isinstance(value, list):
        for item in value:
            paths |= field_paths(item, prefix)
    return paths


class RecordingKV(EsKVStore):
    """The real Elasticsearch KV adapter (over the in-memory client) that records
    every document written, so a test can flatten exactly what reached the index."""

    def __init__(self) -> None:
        super().__init__(InMemoryESClient())
        self.written: list[tuple[str, str, dict[str, Any]]] = []

    def _record(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self.written.append((namespace, key, json.loads(json.dumps(value, default=str))))

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self._record(namespace, key, value)
        await super().put(namespace, key, value)

    async def put_strict(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        self._record(namespace, key, value)
        await super().put_strict(namespace, key, value)

    async def put_if(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        self._record(namespace, key, value)
        return await super().put_if(namespace, key, value, expected_rev)

    async def put_if_strict(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        self._record(namespace, key, value)
        return await super().put_if_strict(namespace, key, value, expected_rev)

    def paths(self, namespace: str) -> set[str]:
        out: set[str] = set()
        for ns, _key, value in self.written:
            if ns == namespace:
                out |= field_paths(value)
        return out


# --------------------------------------------------------------------------- #
# Chat conversations.
# --------------------------------------------------------------------------- #
def _rich_response(seed: int) -> dict[str, Any]:
    """An answer with blocks, steps, usage and a legacy table: every nested shape a
    stored presentation can hold, plus data-valued keys (cells, labels)."""
    return {
        "answer": f"Answer {seed}",
        "cost": 0.0012 * seed,
        "query": f"source.ip:10.0.0.{seed}",
        "effective_model": "gpt-x",
        "turn_id": f"turn-{seed}",
        "blocks_version": 1,
        "blocks": [
            {"id": "b1", "type": "chart", "kind": "hbar", "unit": "count", "provenance": "source",
             "artifact_kind": "categories", "allowed_views": ["hbar", "table"], "title": f"Top {seed}",
             "x": {"kind": "category", "values": [f"10.0.{seed}.{i}" for i in range(5)]},
             "series": [{"key": f"k{seed}", "label": "Events", "values": [5, 4, 3, 2, 1]}]},
            {"id": "b2", "type": "table", "provenance": "source", "artifact_kind": "table",
             "allowed_views": ["table"], "title": "Rows",
             "columns": [{"key": f"col{seed}", "label": "Host", "type": "entity"}],
             "rows": [[f"host-{seed}-{i}"] for i in range(5)]},
        ],
        "steps": [{"index": 1, "kind": "tool", "tool": "log_stats", "label": "Counted", "status": "ok",
                   "duration_ms": 3, "summary": "5 rows", "params": {f"group_{seed}": "source.ip"},
                   "untrusted_params": {f"value_{seed}": "x"}}],
        "usage": {"calls": 1, "embedding_calls": 0, "input_tokens": 100, "cache_read_tokens": 0,
                  "cache_write_tokens": 0, "output_tokens": 20, "total_tokens": 120, "cost": 0.001,
                  "latency_ms": 5, "model": "gpt-x", "pricing_source": "exact", "simulated": False,
                  "estimated": False, "context_window": 128000, "peak_prompt_tokens": 100},
        "table": {"columns": ["Host"], "rows": [[f"host-{seed}-{i}"] for i in range(5)]},
    }


def _partition(conversations: int, exchanges: int) -> dict[str, Any]:
    """A DECODED partition built with the store's own encoders (every write path
    ends in ``_encode_partition``), including an idempotency receipt per exchange."""
    data = cc._empty_partition()
    for c in range(conversations):
        cid = f"chat-{c:04d}"
        messages: list[ChatConversationMessage] = []
        for e in range(exchanges):
            seed = c * 100 + e
            stored, _ = cc.encode_assistant_response(_rich_response(seed))
            messages.append(ChatConversationMessage(
                id=f"chatmsg-u{seed}", role="user", content=f"2026-10-0{1 + e % 8}",   # date-like text
                response=cc.encode_user_response("starter" if e % 2 else "user")))
            messages.append(ChatConversationMessage(
                id=f"chatmsg-a{seed}", role="assistant", content=f"Answer {seed}", response=stored,
                model="gpt-x", source_id=f"src-{seed}", source_name=f"Source {seed}",
                idempotency_key=f"key-{seed:08d}"))
            data["requests"][f"key-{seed:08d}"] = {
                "status": "completed", "fingerprint": f"{seed:064x}", "conversation_id": cid,
                "created_at": "2026-10-08T00:00:00Z", "updated_at": "2026-10-08T00:00:00Z",
                "lease_token": f"lease-{seed}", "assistant_message_id": f"chatmsg-a{seed}",
                "assistant_content": f"Answer {seed}",
                "assistant_response": cc._receipt_response(stored, False),
            }
        data["conversations"][cid] = ChatConversation(
            id=cid, title=f"2026-10-0{1 + c % 8}", created_at="2026-10-08T00:00:00Z",
            updated_at="2026-10-08T00:00:00Z", messages=messages, message_count=len(messages),
            total_message_count=len(messages), pinned=c % 7 == 0,
            time_range={"from": "now-7d", "to": "now"}, total_tokens=120, total_cost=0.001, usage_turns=1,
        )
    return {**cc._encode_partition(data), "_rev": 7}


def test_conversation_partition_paths_are_few_and_independent_of_the_data() -> None:
    small = field_paths(_partition(1, 1))
    large_doc = _partition(50, 10)                                  # 50 conversations × 20 messages
    large = field_paths(large_doc)
    assert large == small
    assert len(large) <= MAX_PARTITION_PATHS
    assert large == {"_rev", "schema", cc.CONVERSATION_ROWS_KEY, cc.REQUEST_ROWS_KEY,
                     "history_truncated", "total_conversation_count"}
    # Every row is ONE opaque string, and the document still decodes in full.
    assert all(isinstance(r, str) for r in large_doc[cc.CONVERSATION_ROWS_KEY])
    decoded = cc._decode_partition(large_doc)
    assert len(decoded["conversations"]) == 50 and len(decoded["requests"]) == 500
    assert sum(len(c.messages) for c in decoded["conversations"].values()) == 1000


def test_the_earlier_keyed_form_grew_per_record_and_still_decodes() -> None:
    """What the fix prevents (form 2 keyed rows by id), and the lenient read of it."""
    def legacy(n: int) -> dict[str, Any]:
        encoded = _partition(n, 1)
        return {"schema": 2,
                "conversations": cc.stored_conversation_rows(encoded),
                "requests": cc.stored_request_rows(encoded),
                "history_truncated": False, "total_conversation_count": n}

    assert len(field_paths(legacy(50))) > 20 * len(field_paths(legacy(1))) > 1_000
    decoded = cc._decode_partition(legacy(3))
    assert sorted(decoded["conversations"]) == ["chat-0000", "chat-0001", "chat-0002"]
    assert len(decoded["requests"]) == 3
    # Re-encoding converts it to the bounded form.
    assert field_paths(cc._encode_partition(decoded)) <= field_paths(_partition(1, 1))


async def test_every_conversation_store_write_keeps_the_bounded_shape() -> None:
    """Through the real store API on the Elasticsearch KV adapter: reservations,
    completions, pins, renames, report ids and deletes all write the same paths."""
    kv = RecordingKV()
    store = cc.ChatConversationStore(kv)
    for user in ("alice", "bob"):
        for n in range(6):
            key = f"{user}-key-{n:04d}"
            reserved = await store.reserve_exchange(user, idempotency_key=key, request_fingerprint="f" * 64,
                                                    conversation_id=None)
            done = await store.complete_exchange(
                user, idempotency_key=key, request_fingerprint="f" * 64,
                conversation_id=reserved.conversation_id, lease_token=reserved.lease_token or "",
                requested_existing_conversation=False, user_content=f"question {n}",
                assistant_content=f"answer {n}", response=_rich_response(n), model="gpt-x",
                source_id=None, source_name="Primary", user_origin="starter",
                time_range={"from": "now-24h", "to": "now"},
            )
            await store.update(user, done.conversation_id, title=f"Renamed {n}", pinned=n == 0)
            await store.set_report_id(user, done.conversation_id, f"rpt-{n}")
        await store.delete(user, done.conversation_id)
    partitions = {key for ns, key, _ in kv.written if ns == CHAT_CONVERSATIONS_NS and key.startswith("user-")}
    assert len(partitions) == 2
    paths = set()
    for ns, key, value in kv.written:
        if ns == CHAT_CONVERSATIONS_NS and key in partitions:
            paths |= field_paths(value)
    assert paths == {"_rev", "schema", cc.CONVERSATION_ROWS_KEY, cc.REQUEST_ROWS_KEY,
                     "history_truncated", "total_conversation_count"}
    # The partition registry is a list of opaque keys, not a keyed object.
    index_paths = {p for ns, key, value in kv.written
                   if ns == CHAT_CONVERSATIONS_NS and key not in partitions for p in field_paths(value)}
    assert index_paths <= {"_rev", "schema", "partitions"}
    page = await store.list_page("alice")
    assert page.total == 5 and page.conversations[0].pinned


# --------------------------------------------------------------------------- #
# Case threads (chat writes case-scoped turns into them).
# --------------------------------------------------------------------------- #
async def test_case_thread_document_paths_do_not_grow_with_cases() -> None:
    kv = RecordingKV()
    store = CaseThreadStore(kv)
    for i in range(60):
        message = CaseMessage(case_id=f"case-{i:04d}", author_type="ai", author="gpt-x", body=f"note {i}",
                              kind="chat", ai_meta={"channel": "chat", f"extra_{i}": i})
        await store.append_if_absent(message)
        await store.react(f"case-{i:04d}", message.id, "+1", "alice")
    paths = kv.paths(CASE_THREAD_NS)
    assert paths <= {"_rev", THREAD_ROWS_KEY}
    assert len(await store.list_for_case("case-0042")) == 1


async def test_case_thread_reads_the_earlier_keyed_form_and_converts_on_write() -> None:
    kv = RecordingKV()
    legacy = CaseMessage(case_id="case-1", author_type="human", author="alice", body="old", kind="chat")
    await kv.put(CASE_THREAD_NS, CASE_THREAD_KEY, {"threads": {
        "case-1": [legacy.model_dump(mode="json"), "not a message"]}})
    store = CaseThreadStore(kv)
    assert [m.body for m in await store.list_for_case("case-1")] == ["old"]
    fresh = CaseMessage(case_id="case-2", author_type="human", author="bob", body="new", kind="chat")
    await store.append(fresh)
    doc = await kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)
    assert "threads" not in doc and set(stored_threads(doc)) == {"case-1", "case-2"}
    assert [m.body for m in await store.list_for_case("case-1")] == ["old"]


# --------------------------------------------------------------------------- #
# Reports (checked the same way; already opaque JSON strings).
# --------------------------------------------------------------------------- #
def _block(i: int) -> dict[str, Any]:
    return {"id": "b1", "type": "chart", "kind": "hbar", "unit": "count", "provenance": "source",
            "artifact_kind": "categories", "allowed_views": ["hbar", "table"], "title": f"Top {i}",
            "x": {"kind": "category", "values": [f"10.0.{i}.{j}" for j in range(4)]},
            "series": [{"key": f"s{i}", "label": "Events", "values": [4, 3, 2, 1]}]}


async def test_report_documents_paths_do_not_grow_with_reports_or_items() -> None:
    kv = RecordingKV()
    store = ReportStore(kv)
    for owner in ("alice", "bob"):
        for r in range(4):
            report = await store.create(owner, title=f"Report {r}")
            for i in range(8):
                item = ReportItem.model_validate({
                    "id": new_item_id(), "kind": "block", "block": _block(i), "note": f"note {i}",
                    "source": {"conversation_id": f"chat-{r}", "message_id": f"chatmsg-{i}", "block_id": "b1"},
                    "scope": {"window": "last 24h", "sources": [f"src-{i}"], "app_version": "0.1.13"},
                })
                await store.add_item(owner, item, report_id=report.id)
        await store.delete(owner, report.id, expected_version=(await store.get(owner, report.id)).version)
    namespaces = {ns for ns, _, _ in kv.written}
    paths = set().union(*(kv.paths(ns) for ns in namespaces))
    # Fixed scalar fields plus opaque *_json strings; nothing keyed by an id.
    assert len(paths) <= 16, sorted(paths)
    assert not any(p.count(".") for p in paths), sorted(paths)
