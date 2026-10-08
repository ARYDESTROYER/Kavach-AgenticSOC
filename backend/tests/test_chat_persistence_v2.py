"""Workspace chat persistence v2 (chat revamp SPEC §7.5).

The storage form (one opaque ``presentation_json`` per answer, scalar receipts),
compact storage (≤ 16 kB per answer), downgrade-before-drop retention with the
12-rich-exchange guarantee (the 15-turn acceptance runs on SQLite and the fake
Elasticsearch KV; PostgreSQL runs in CI's real-Postgres lane), cumulative totals,
pins (≤ 10, exempt from eviction, listed first), server-side search, the user
message ``origin`` and lenient decoding of legacy rows.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agents.blocks import EXPIRED_TEXT, is_expired_block, validate_blocks
from app.api.routes import router as base_router
from app.api.routes_chat import _replay_messages
from app.api.routes_chat import router as chat_router
from app.agents.chat_protocol import PriorExchange
from app.config import Secrets
from app.constants import CHAT_CONVERSATIONS_NS
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import ChatResponse
from app.state import AppState
from app.stores.chat_conversations import (
    MAX_CONVERSATION_BYTES,
    MAX_CONVERSATIONS_PER_USER,
    MAX_PINNED_CONVERSATIONS,
    MAX_PRESENTATION_BYTES,
    MAX_RECEIPT_CONTENT_CHARS,
    PRESENTATION_KEY,
    ChatConversationStore,
    ChatPinLimitReached,
    compact_presentation,
    decode_response,
    encode_assistant_response,
    partition_key_for_user,
    stored_presentation_size,
    turns_removed,
)
from app.stores.memory import EsKVStore

NESTED_KEYS = {"blocks", "rows", "series", "steps"}


# --------------------------------------------------------------------------- #
# Fixtures: a realistic "posture + top hosts" answer.
# --------------------------------------------------------------------------- #
def _rich_blocks(seed: int, *, rows: int = 50, cols: int = 6, points: int = 168) -> list[dict[str, Any]]:
    hours = [f"2026-10-0{1 + h // 24}T{h % 24:02d}:00:00Z" for h in range(points)]
    raw = [
        {"id": "b1", "type": "kpi_group", "provenance": "code", "artifact_kind": "kpis",
         "title": "Posture now", "items": [
             {"key": f"k{i}", "label": f"Metric {i}", "value": seed * 10 + i, "unit": "count"}
             for i in range(6)]},
        {"id": "b2", "type": "chart", "kind": "line", "unit": "count", "provenance": "code",
         "artifact_kind": "series", "title": "Events over time",
         "x": {"kind": "time", "values": hours, "bucket": "1h"},
         "series": [{"key": "events", "label": "Events", "values": [(seed + h) % 97 for h in range(points)]}]},
        {"id": "b3", "type": "chart", "kind": "hbar", "unit": "count", "provenance": "source",
         "artifact_kind": "categories", "title": "Top hosts", "untrusted": True,
         "x": {"kind": "category", "values": [f"host-{seed}-{i}" for i in range(10)]},
         "series": [{"key": "events", "label": "Events", "values": [100 - i for i in range(10)]}]},
        {"id": "b4", "type": "table", "provenance": "source", "artifact_kind": "table",
         "title": "Matching events", "untrusted": True,
         "columns": [{"key": f"c{c}", "label": f"Column {c}", "type": "text"} for c in range(cols)],
         "rows": [[f"r{seed}-{r}-c{c}-value" for c in range(cols)] for r in range(rows)]},
    ]
    blocks, dropped = validate_blocks(raw)
    assert not dropped, dropped
    return blocks


def _rich_response(seed: int, **block_kwargs: Any) -> dict[str, Any]:
    steps = [
        {"index": 1, "kind": "model", "label": "Planned lookups", "status": "ok", "duration_ms": 900,
         "usage": {"input_tokens": 2100, "output_tokens": 80, "cost": 0.002, "latency_ms": 900}},
        {"index": 2, "ordinal": 1, "kind": "tool", "tool": "soc_metrics", "label": "Read metrics",
         "params": {"kind": "posture"}, "status": "ok", "summary": "posture computed"},
        {"index": 3, "ordinal": 2, "kind": "tool", "tool": "log_stats", "label": "Counted events",
         "params": {"group_by": "host.name", "time_from": "now-7d"}, "status": "ok",
         "summary": "1,284 events", "query": "q" * 3_000, "basis": "exact", "rows": 1284},
        {"index": 4, "kind": "model", "label": "Wrote the answer", "status": "ok", "duration_ms": 1200,
         "usage": {"input_tokens": 5200, "output_tokens": 420, "cost": 0.004, "latency_ms": 1200}},
    ]
    response = ChatResponse(
        answer=f"Posture answer {seed}: risk is moderate and web hosts lead the volume.",
        blocks=_rich_blocks(seed, **block_kwargs), steps=steps,
        usage={"calls": 2, "embedding_calls": 0, "input_tokens": 7300, "cache_read_tokens": 0,
               "cache_write_tokens": 0, "output_tokens": 500, "total_tokens": 7800, "cost": 0.006,
               "latency_ms": 2100, "model": "gpt-5.6-luna", "simulated": False, "estimated": False},
        citations=[{"id": "D1", "kind": "doc", "title": "Metrics", "doc": "/docs/0.1/analyst/metrics/",
                    "snippet": "s" * 200}],
        follow_ups=["Show it by source", "Compare with last week"], answer_kind="data",
        stream_mode="steps", turn_id=f"turn-{seed}", effective_model="gpt-5.6-luna",
        table={"columns": [f"Column {c}" for c in range(6)],
               "rows": [[f"r{seed}-{r}-c{c}-value" for c in range(6)] for r in range(50)],
               "truncated": False},
        query="host.name:*",
    )
    return response.model_dump(mode="json")


async def _exchange(store: ChatConversationStore, user: str, seed: int, *, conversation_id: str | None,
                    origin: str = "user", time_range: Any = False, **block_kwargs: Any):
    key = f"persist-key-{seed:06d}"
    reserved = await store.reserve_exchange(
        user, idempotency_key=key, request_fingerprint=f"{seed:064x}", conversation_id=conversation_id,
    )
    response = _rich_response(seed, **block_kwargs)
    return await store.complete_exchange(
        user, idempotency_key=key, request_fingerprint=f"{seed:064x}",
        conversation_id=reserved.conversation_id, lease_token=reserved.lease_token or "",
        requested_existing_conversation=conversation_id is not None,
        user_content=f"Question {seed}: how is our posture and which hosts are busiest?",
        assistant_content=response["answer"], response=response, model="gpt-5.6-luna",
        source_id=None, source_name="Primary source", user_origin=origin, time_range=time_range,
    )


def _walk_keys(value: Any, path: str = "") -> Iterator[tuple[str, str]]:
    if isinstance(value, dict):
        for key, item in value.items():
            yield path, key
            yield from _walk_keys(item, f"{path}.{key}")
    elif isinstance(value, list):
        for item in value:
            yield from _walk_keys(item, path)


async def _sqlite_store():
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    return ChatConversationStore(SqlKVStore(engine)), engine


# --------------------------------------------------------------------------- #
# Storage form (presentation_json, scalar receipts, lenient decode).
# --------------------------------------------------------------------------- #
async def test_stored_partition_holds_no_nested_presentation_objects(app_state: AppState) -> None:
    store = app_state.chat_conversations
    done = await _exchange(store, "alice", 1, conversation_id=None)
    raw = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user("alice"))
    offenders = [(p, k) for p, k in _walk_keys(raw) if k in NESTED_KEYS]
    assert offenders == []
    message = raw["conversations"][done.conversation_id]["messages"][1]
    assert isinstance(message["response"][PRESENTATION_KEY], str)
    assert set(message["response"]) <= {
        PRESENTATION_KEY, "cost", "query", "effective_model", "effective_source_name",
        "truncated", "turn_id", "blocks_version", "idempotency_key",
    }
    receipt = raw["requests"]["persist-key-000001"]
    assert PRESENTATION_KEY not in json.dumps(receipt)
    assert all(not isinstance(v, (dict, list)) for v in receipt["assistant_response"].values())
    # Decoded on read: the presentation, the re-injected answer.
    conversation = await store.get("alice", done.conversation_id)
    decoded = conversation.messages[1].response
    assert decoded["answer"] == conversation.messages[1].content
    assert [b["id"] for b in decoded["blocks"]] == ["b1", "b2", "b3", "b4"]
    assert ChatResponse.model_validate(decoded).usage.total_tokens == 7800


async def test_compact_storage_limits_and_legacy_table_round_trip(app_state: AppState) -> None:
    store = app_state.chat_conversations
    done = await _exchange(store, "bob", 2, conversation_id=None)
    stored = (await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user("bob")))[
        "conversations"][done.conversation_id]["messages"][1]["response"]
    assert len(stored[PRESENTATION_KEY].encode("utf-8")) <= MAX_PRESENTATION_BYTES
    presentation = json.loads(stored[PRESENTATION_KEY])
    blocks = {b["id"]: b for b in presentation["blocks"]}
    assert len(blocks["b4"]["rows"]) == 25 and blocks["b4"]["truncated"] and blocks["b4"]["total"] == 50
    assert len(blocks["b2"]["x"]["values"]) == 100 and blocks["b2"]["downsampled_for_storage"]
    assert len(blocks["b2"]["series"][0]["values"]) == 100
    assert blocks["b2"]["x"]["values"][-1].endswith("23:00:00Z")          # the newest points kept
    assert all(len(s.get("query") or "") <= 1_000 for s in presentation["steps"])
    # The legacy table duplicated block b4, so it is not stored twice...
    assert "table" not in presentation and presentation["table_block"] == "b4"
    # ...and still decodes for legacy clients.
    decoded = (await store.get("bob", done.conversation_id)).messages[1].response
    assert decoded["table"]["columns"] == [f"Column {c}" for c in range(6)]
    assert len(decoded["table"]["rows"]) == 25 and decoded["table"]["truncated"] is True
    # Live responses keep full limits (only storage is compact).
    assert len(_rich_response(2)["blocks"][3]["rows"]) == 50


def test_compaction_tightens_then_expires_and_flags_truncation() -> None:
    huge = _rich_response(3, rows=120, cols=10, points=200)
    huge["blocks"] = huge["blocks"] * 3                    # 12 data-heavy blocks
    for index, block in enumerate(huge["blocks"], start=1):
        block["id"] = f"b{index}"
    compact, reduced = compact_presentation({k: v for k, v in huge.items() if k != "answer"})
    assert reduced is True
    size = len(json.dumps(compact, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode())
    assert size <= MAX_PRESENTATION_BYTES
    assert any(is_expired_block(b) for b in compact["blocks"])
    stored, truncated = encode_assistant_response(huge)
    assert truncated is True and stored["truncated"] is True


def test_lenient_decode_of_legacy_and_corrupt_rows() -> None:
    legacy = {"answer": "old", "cost": 0.01, "table": {"columns": ["a"], "rows": [[1]]}, "query": "x"}
    decoded = decode_response(legacy, role="assistant", content="old answer")
    assert decoded["answer"] == "old answer" and decoded["table"]["rows"] == [[1]]
    corrupt = {"cost": 0.02, PRESENTATION_KEY: "{not json"}
    assert decode_response(corrupt, role="assistant", content="x") == {"cost": 0.02, "answer": "x"}
    assert ChatResponse.model_validate(decode_response(corrupt, role="assistant", content="x")).answer == "x"
    assert decode_response({"origin": "starter"}, role="user", content="q") == {"origin": "starter"}


async def test_legacy_dict_rows_keep_replaying(app_state: AppState) -> None:
    store = app_state.chat_conversations
    saved = await store.append_exchange(
        "legacy", conversation_id=None, user_content="q", assistant_content="a",
        response={"answer": "a", "cost": 0.01},
    )
    assert saved.messages[1].response == {"answer": "a", "cost": 0.01}
    assert saved.total_tokens == 0 and saved.usage_turns == 0          # no usage recorded


# --------------------------------------------------------------------------- #
# Retention: downgrade before drop; ≥ 12 rich exchanges (15-turn acceptance).
# --------------------------------------------------------------------------- #
async def _fifteen_turns(store: ChatConversationStore) -> None:
    conversation_id = None
    for seed in range(15):
        done = await _exchange(store, "analyst", 100 + seed, conversation_id=conversation_id,
                               rows=25, cols=12)
        conversation_id = done.conversation_id
    conversation = await store.get("analyst", conversation_id)
    assert conversation is not None
    assert len(conversation.messages) == 30                         # all 15 exchanges kept
    # No turn was removed. (``history_truncated`` keeps its pre-revamp meaning,
    # "something in this thread was shortened": these near-cap answers are tightened
    # at storage, so it is set; the storage-limit note keys off removed turns.)
    assert conversation.total_message_count == conversation.message_count == 30
    assert turns_removed(conversation) is False
    size = len(json.dumps([m.model_dump(mode="json") for m in conversation.messages]).encode())
    assert size <= MAX_CONVERSATION_BYTES * 2                        # decoded form, sanity only
    answers = [m for m in conversation.messages if m.role == "assistant"]
    assert [a.content for a in answers] == [
        f"Posture answer {100 + s}: risk is moderate and web hosts lead the volume." for s in range(15)
    ]
    rich = [a for a in answers if not any(is_expired_block(b) for b in a.response.get("blocks", []))]
    assert len(rich) >= 12 and answers[-12:] == rich[-12:]            # the newest stay rich
    assert conversation.usage_turns == 15 and conversation.total_tokens == 15 * 7800


def _quote_dense_response(seed: int, *, tables: int = 8) -> dict[str, Any]:
    """Many tiny string cells: the stored (string-escaped) presentation is ~40 %
    larger than its canonical JSON, which is what the 16 kB cap must account for."""
    raw = [
        {"id": f"b{t + 1}", "type": "table", "provenance": "source", "artifact_kind": "table",
         "title": f"T{t}", "untrusted": True,
         "columns": [{"key": f"c{c}", "label": f"C{c}", "type": "text"} for c in range(12)],
         "rows": [[f"{(seed + r + c) % 10}" for c in range(12)] for r in range(25)]}
        for t in range(tables)
    ]
    blocks, dropped = validate_blocks(raw)
    assert not dropped, dropped
    return ChatResponse(
        answer=f"Dense answer {seed}.", blocks=blocks, answer_kind="data", stream_mode="steps",
        turn_id=f"turn-dense-{seed}",
    ).model_dump(mode="json")


async def _fifteen_quote_dense_turns(store: ChatConversationStore) -> None:
    conversation_id = None
    for seed in range(15):
        response = _quote_dense_response(seed)
        saved = await store.append_exchange(
            "dense", conversation_id=conversation_id, user_content=f"Dense question {seed}?",
            assistant_content=response["answer"], response=response,
        )
        conversation_id = saved.id
        # Every answer's presentation fits the cap AS STORED (escaped once more).
        raw = encode_assistant_response(response)[0][PRESENTATION_KEY]
        assert stored_presentation_size(json.loads(raw)) <= MAX_PRESENTATION_BYTES
        assert len(json.dumps(raw, ensure_ascii=False).encode()) <= MAX_PRESENTATION_BYTES
    conversation = await store.get("dense", conversation_id)
    answers = [m for m in conversation.messages if m.role == "assistant"]
    assert len(answers) == 15
    rich = [a for a in answers if not any(is_expired_block(b) for b in a.response.get("blocks", []))]
    assert len(rich) >= 12 and answers[-12:] == rich[-12:]


async def test_fifteen_rich_turns_kept_on_fake_elasticsearch() -> None:
    await _fifteen_turns(ChatConversationStore(EsKVStore(InMemoryESClient())))
    await _fifteen_quote_dense_turns(ChatConversationStore(EsKVStore(InMemoryESClient())))


async def test_fifteen_rich_turns_kept_on_sqlite() -> None:
    store, engine = await _sqlite_store()
    try:
        await _fifteen_turns(store)
        await _fifteen_quote_dense_turns(store)
    finally:
        await engine.dispose()


def test_presentation_cap_is_measured_on_the_stored_escaped_size() -> None:
    """Regression: a quote-dense answer whose canonical JSON was under 16 kB but whose
    stored, escaped form was ~21 kB is now tightened (and flagged) instead."""
    response = _quote_dense_response(0)
    presentation = {k: v for k, v in response.items() if k != "answer"}
    canonical = len(json.dumps({k: v for k, v in presentation.items() if v not in (None, [], {})},
                               ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode())
    assert canonical <= MAX_PRESENTATION_BYTES < stored_presentation_size(presentation)
    compact, reduced = compact_presentation(presentation)
    assert reduced is True and stored_presentation_size(compact) <= MAX_PRESENTATION_BYTES
    assert not any(is_expired_block(b) for b in compact["blocks"])   # tightened, not expired


async def test_downgrade_before_drop_keeps_text_and_strips_old_details(app_state: AppState) -> None:
    store = app_state.chat_conversations
    conversation_id = None
    # Enough near-cap answers to pass 256 kB, so the oldest must be downgraded.
    for seed in range(32):
        done = await _exchange(store, "carol", 300 + seed, conversation_id=conversation_id, rows=25, cols=12)
        conversation_id = done.conversation_id
    conversation = await store.get("carol", conversation_id)
    assert len(conversation.messages) == 64 and not turns_removed(conversation)   # downgraded, none dropped
    oldest = conversation.messages[1].response
    assert all(is_expired_block(b) for b in oldest["blocks"])
    assert all(b.get("text") == EXPIRED_TEXT for b in oldest["blocks"])
    assert oldest["blocks"][0]["expired"] == {"type": "kpi_group", "artifact_kind": "kpis"}
    assert all("params" not in s and "query" not in s for s in oldest["steps"])
    assert oldest["usage"]["total_tokens"] == 7800                   # facts outlive the charts
    newest = conversation.messages[-1].response
    assert not any(is_expired_block(b) for b in newest["blocks"])
    raw = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user("carol"))
    stored_messages = raw["conversations"][conversation_id]["messages"]
    assert len(json.dumps(stored_messages, separators=(",", ":"), ensure_ascii=False).encode()) <= MAX_CONVERSATION_BYTES


async def test_whole_exchanges_drop_only_when_text_alone_overflows(app_state: AppState) -> None:
    store = app_state.chat_conversations
    conversation_id = None
    for index in range(20):
        saved = await store.append_exchange(
            "dave", conversation_id=conversation_id, user_content=f"u{index} " + "x" * 11_000,
            assistant_content=f"a{index} " + "y" * 11_000, response=_rich_response(index),
        )
        conversation_id = saved.id
    conversation = await store.get("dave", conversation_id)
    assert conversation.history_truncated is True
    assert len(conversation.messages) < 40 and len(conversation.messages) % 2 == 0
    assert conversation.messages[0].role == "user" and conversation.messages[-1].role == "assistant"
    assert conversation.messages[-1].content.startswith("a19 ")
    assert conversation.total_message_count == 40
    assert turns_removed(conversation) is True                       # the storage-limit note applies
    assert conversation.usage_turns == 20                            # totals survive trimming


async def test_one_large_answer_is_shortened_but_no_turn_is_removed(app_state: AppState) -> None:
    """``history_truncated`` (something was shortened) is not the storage-limit signal:
    a one-exchange thread with an oversized answer removed no turn."""
    store = app_state.chat_conversations
    huge = _rich_response(7, rows=120, cols=10, points=200)
    huge["blocks"] = huge["blocks"] * 3
    for index, block in enumerate(huge["blocks"], start=1):
        block["id"] = f"b{index}"
    saved = await store.append_exchange(
        "frank", conversation_id=None, user_content="q", assistant_content=huge["answer"], response=huge,
    )
    assert saved.history_truncated is True and saved.messages[1].response["truncated"] is True
    assert turns_removed(saved) is False
    summary = (await store.list_page("frank")).conversations[0]
    assert summary.history_truncated is True and turns_removed(summary) is False


# --------------------------------------------------------------------------- #
# Receipts, origin, time range, totals.
# --------------------------------------------------------------------------- #
async def test_receipt_replay_after_retention_is_compact_and_flagged(app_state: AppState) -> None:
    store = app_state.chat_conversations
    first = await _exchange(store, "erin", 1, conversation_id=None)
    conversation_id = first.conversation_id
    for index in range(60):
        await store.append_exchange(
            "erin", conversation_id=conversation_id, user_content=f"later {index}",
            assistant_content="z" * 3_000, response={"answer": "z", "cost": 0.0},
        )
    replay = await store.reserve_exchange(
        "erin", idempotency_key="persist-key-000001", request_fingerprint=f"{1:064x}",
        conversation_id=None,
    )
    assert replay.status == "completed"
    assert replay.assistant_message.id == first.assistant_message.id
    assert len(replay.assistant_message.content) <= MAX_RECEIPT_CONTENT_CHARS
    assert replay.assistant_message.response["truncated"] is True
    assert "blocks" not in replay.assistant_message.response


async def test_origin_time_range_and_totals_on_the_summary(app_state: AppState) -> None:
    store = app_state.chat_conversations
    first = await _exchange(store, "fay", 1, conversation_id=None, origin="starter",
                            time_range={"from": "now-7d"})
    second = await _exchange(store, "fay", 2, conversation_id=first.conversation_id, origin="follow_up",
                             time_range=None)
    conversation = second.conversation
    assert conversation.time_range is None                          # the chip was cleared
    assert first.conversation.time_range.model_dump() == {"from": "now-7d", "to": "now"}
    assert conversation.total_tokens == 15_600 and conversation.usage_turns == 2
    assert conversation.total_cost == pytest.approx(0.012)
    users = [m for m in conversation.messages if m.role == "user"]
    assert [m.response for m in users] == [{"origin": "starter"}, {"origin": "follow_up"}]
    exchanges = PriorExchange.from_messages(_replay_messages(conversation))
    assert [e.origin for e in exchanges] == ["starter", "follow_up"]
    assert exchanges[0].steps and exchanges[0].blocks and exchanges[0].message_id == conversation.messages[1].id
    # A plain user turn stores nothing extra.
    third = await _exchange(store, "fay", 3, conversation_id=first.conversation_id)
    assert third.conversation.messages[-2].response is None


async def test_pre_revamp_conversation_keeps_unknown_totals(app_state: AppState) -> None:
    store = app_state.chat_conversations
    saved = await store.append_exchange("gus", conversation_id=None, user_content="q", assistant_content="a")
    raw = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key_for_user("gus"))
    for key in ("total_tokens", "total_cost", "usage_turns"):
        raw["conversations"][saved.id].pop(key, None)              # a pre-revamp row
    await app_state.kv.put(CHAT_CONVERSATIONS_NS, partition_key_for_user("gus"), raw)
    later = await _exchange(store, "gus", 9, conversation_id=saved.id)
    assert later.conversation.total_tokens is None and later.conversation.usage_turns is None


# --------------------------------------------------------------------------- #
# Pins and search.
# --------------------------------------------------------------------------- #
async def test_pins_limit_order_updated_at_and_eviction_exemption(app_state: AppState) -> None:
    store = app_state.chat_conversations
    ids = []
    for index in range(MAX_PINNED_CONVERSATIONS + 1):
        saved = await store.append_exchange("hal", conversation_id=None, user_content=f"pin me {index}",
                                            assistant_content="a")
        ids.append(saved.id)
    before = (await store.get("hal", ids[0])).updated_at
    for cid in ids[:MAX_PINNED_CONVERSATIONS]:
        pinned = await store.update("hal", cid, pinned=True)
        assert pinned.pinned is True
    assert (await store.get("hal", ids[0])).updated_at == before   # pinning is not activity
    with pytest.raises(ChatPinLimitReached):
        await store.set_pinned("hal", ids[-1], True)
    assert (await store.get("hal", ids[-1])).pinned is False
    # 55 newer unpinned conversations: the 10 old pinned ones survive eviction.
    for index in range(MAX_CONVERSATIONS_PER_USER + 5):
        await store.append_exchange("hal", conversation_id=None, user_content=f"later {index}",
                                    assistant_content="a")
    page = await store.list_page("hal", limit=60)
    assert page.total == MAX_CONVERSATIONS_PER_USER + MAX_PINNED_CONVERSATIONS
    assert [c.pinned for c in page.conversations[:10]] == [True] * 10
    assert {c.id for c in page.conversations[:10]} == set(ids[:MAX_PINNED_CONVERSATIONS])
    assert page.history_truncated is True
    unpinned = await store.update("hal", ids[0], pinned=False, title="Renamed")
    assert unpinned.pinned is False and unpinned.title == "Renamed"
    linked_before = (await store.get("hal", ids[1])).updated_at
    assert await store.set_report_id("hal", ids[1], "rpt-1") is True
    linked = await store.get("hal", ids[1])
    assert linked.report_id == "rpt-1" and linked.updated_at == linked_before
    assert await store.set_report_id("hal", "chat-not-mine", "rpt-2") is False


async def test_search_matches_titles_text_and_block_titles(app_state: AppState) -> None:
    store = app_state.chat_conversations
    by_title = await store.append_exchange("ivy", conversation_id=None,
                                           user_content="Ransomware triage plan", assistant_content="ok")
    by_text = await store.append_exchange(
        "ivy", conversation_id=None, user_content="question",
        assistant_content="Long preamble " + "word " * 80 + "the BEACONING host was web-7 " + "tail " * 80,
    )
    by_block = (await _exchange(store, "ivy", 42, conversation_id=None)).conversation
    await store.append_exchange("ivy", conversation_id=None, user_content="nothing here", assistant_content="x")
    title_hits = await store.search("ivy", "RANSOMWARE")
    assert [h.id for h in title_hits.conversations] == [by_title.id]
    assert title_hits.conversations[0].match.message_id is None
    text_hits = await store.search("ivy", "beaconing")
    hit = text_hits.conversations[0]
    assert hit.id == by_text.id and hit.match.message_id == by_text.messages[1].id
    assert "beaconing" in hit.match.snippet.lower() and len(hit.match.snippet) <= 160
    block_hits = await store.search("ivy", "matching events")
    assert [h.id for h in block_hits.conversations] == [by_block.id]
    assert block_hits.conversations[0].match.message_id == by_block.messages[1].id
    assert (await store.search("ivy", "zzz-nothing")).total == 0
    assert (await store.search("someone-else", "ransomware")).total == 0


async def test_search_phrases_cross_line_breaks_and_double_spaces(app_state: AppState) -> None:
    """Markdown answers wrap and double-space; a phrase that spans either still matches
    (the needle and the searched text are folded the same way)."""
    store = app_state.chat_conversations
    wrapped = await store.append_exchange(
        "jay", conversation_id=None, user_content="question",
        assistant_content="## Findings\n\nThe lateral\nmovement  started on web-7.",
    )
    hits = await store.search("jay", "lateral movement started")
    assert [h.id for h in hits.conversations] == [wrapped.id]
    assert hits.conversations[0].match.snippet == "## Findings The lateral movement started on web-7."
    blocks, dropped = validate_blocks([{
        "id": "b1", "type": "table", "provenance": "source", "artifact_kind": "table",
        "title": "Hosts  by\nvolume", "untrusted": True,
        "columns": [{"key": "h", "label": "Host", "type": "text"}], "rows": [["web-7"]],
    }])
    assert not dropped
    titled = await store.append_exchange(
        "jay", conversation_id=None, user_content="another", assistant_content="see the table",
        response=ChatResponse(answer="see the table", blocks=blocks).model_dump(mode="json"),
    )
    assert "  " in blocks[0]["title"]                       # validation keeps the double space
    block_hits = await store.search("jay", "hosts by volume")
    assert [h.id for h in block_hits.conversations] == [titled.id]
    assert block_hits.conversations[0].match.message_id == titled.messages[1].id


# --------------------------------------------------------------------------- #
# Routes: PATCH {title?, pinned?}, list ?q= / pinned first / limit 60.
# --------------------------------------------------------------------------- #
@contextmanager
def _client() -> Iterator[TestClient]:
    provider = MockProvider()
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    from app.api.routes_prefs import router as prefs_router

    api = FastAPI(lifespan=lifespan)
    api.include_router(base_router)
    api.include_router(chat_router)
    api.include_router(prefs_router)
    with TestClient(api) as client:
        yield client


def test_conversation_routes_pin_search_and_list_contract() -> None:
    with _client() as client:
        ids = []
        for index in range(3):
            response = client.post("/api/chat", json={
                "message": f"Thread number {index} about lateral movement",
                "persist_conversation": True, "idempotency_key": f"route-key-{index:04d}",
            })
            ids.append(response.json()["conversation_id"])
        oldest = ids[0]
        before = client.get(f"/api/chat/conversations/{oldest}").json()["updated_at"]
        pinned = client.patch(f"/api/chat/conversations/{oldest}", json={"pinned": True})
        assert pinned.status_code == 200 and pinned.json()["pinned"] is True
        assert pinned.json()["updated_at"] == before
        listing = client.get("/api/chat/conversations?limit=60").json()
        assert listing["conversations"][0]["id"] == oldest and listing["limit"] == 60
        # The typed page keeps the pre-revamp wire shape: a plain listing row has no
        # ``match`` key (only search hits carry one), and every page key is present.
        assert all("match" not in row for row in listing["conversations"])
        assert set(listing) == {"conversations", "total", "history_truncated",
                                "total_conversation_count", "oldest_retained_at", "limit", "offset"}
        assert listing["conversations"][0]["total_tokens"] is not None      # summary fields typed
        assert client.get("/api/chat/conversations?limit=61").status_code == 422
        both = client.patch(f"/api/chat/conversations/{ids[1]}", json={"title": "Renamed", "pinned": True})
        assert both.json()["title"] == "Renamed" and both.json()["pinned"] is True
        assert client.patch(f"/api/chat/conversations/{ids[1]}", json={}).status_code == 422
        assert client.patch("/api/chat/conversations/chat-nope", json={"pinned": True}).status_code == 404
        hits = client.get("/api/chat/conversations", params={"q": "NUMBER 2"}).json()
        assert [h["id"] for h in hits["conversations"]] == [ids[2]] and hits["total"] == 1
        assert hits["conversations"][0]["match"]["snippet"]
        assert client.get("/api/chat/conversations", params={"q": "x" * 201}).status_code == 422
        # Pin limit: the 11th pin is a typed 409.
        state = client.app.state.tlsoc
        for index in range(MAX_PINNED_CONVERSATIONS):
            client.portal.call(_append_pinned, state, index)
        limit = client.patch(f"/api/chat/conversations/{ids[2]}", json={"pinned": True})
        assert limit.status_code == 409 and limit.json()["detail"]["code"] == "chat_pin_limit"


async def _append_pinned(state: AppState, index: int) -> None:
    store = state.chat_conversations
    saved = await store.append_exchange("", conversation_id=None, user_content=f"p{index}", assistant_content="a")
    try:
        await store.set_pinned("", saved.id, True)
    except ChatPinLimitReached:
        pass


def test_stream_turn_persists_origin_time_range_and_totals() -> None:
    with _client() as client:
        response = client.post("/api/chat", json={
            "message": "posture?", "persist_conversation": True, "idempotency_key": "origin-key-0001",
            "origin": "starter", "time_range": {"from": "now-24h"},
        })
        cid = response.json()["conversation_id"]
        detail = client.get(f"/api/chat/conversations/{cid}").json()
        assert detail["messages"][0]["response"] == {"origin": "starter"}
        assert detail["time_range"] == {"from": "now-24h", "to": "now"}
        assert detail["usage_turns"] == 1 and detail["total_tokens"] == response.json()["usage"]["total_tokens"]
        summary = client.get("/api/chat/conversations").json()["conversations"][0]
        assert summary["usage_turns"] == 1 and summary["pinned"] is False and summary["report_id"] is None


def test_saved_chat_prompts_round_trip_through_personal_prefs() -> None:
    with _client() as client:
        prompts = [{"id": "p1", "title": "Morning", "text": "Write the shift brief for the last 24h."}]
        saved = client.put("/api/prefs/user", json={"chat_prompts": prompts})
        assert saved.status_code == 200, saved.text
        assert saved.json()["chat_prompts"] == prompts
        assert client.get("/api/prefs/user").json()["chat_prompts"] == prompts
        # Other personal prefs are untouched by a prompts-only patch.
        client.put("/api/prefs/user", json={"theme_mode": "dark"})
        assert client.get("/api/prefs/user").json()["chat_prompts"] == prompts
        too_many = [{"id": f"p{i}", "title": "t", "text": "x"} for i in range(51)]
        assert client.put("/api/prefs/user", json={"chat_prompts": too_many}).status_code == 422
        bad_id = [{"id": "bad id!", "title": "t", "text": "x"}]
        assert client.put("/api/prefs/user", json={"chat_prompts": bad_id}).status_code == 422
