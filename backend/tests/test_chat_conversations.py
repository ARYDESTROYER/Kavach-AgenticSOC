"""Durable Workspace chat-history contract tests.

The global Workspace opts into this history explicitly. Case-scoped chat keeps
using CaseThreadStore, and callers that omit ``persist_conversation`` remain
stateless. The same store is exercised over fake ES and SQLite KV backends.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import ChatConversation
from app.state import AppState
from app.stores.chat_conversations import (
    MAX_CONVERSATIONS_PER_USER,
    MAX_IDEMPOTENCY_RECORDS,
    MAX_MESSAGES_PER_CONVERSATION,
    ChatHistoryUnavailable,
    ChatRequestCapacityBusy,
    ChatRequestInProgress,
    ChatConversationStore,
    normalize_user_id,
    partition_key_for_user,
    stored_conversation_rows,
    stored_request_rows,
    with_stored_rows,
)
from app.stores.base import KVStore


async def _append(
    store: ChatConversationStore,
    user: str | None,
    text: str,
    *,
    conversation_id: str | None = None,
) -> ChatConversation:
    saved = await store.append_exchange(
        user,
        conversation_id=conversation_id,
        user_content=text,
        assistant_content=f"answer to {text}",
        response={"answer": f"answer to {text}", "cost": 0.01},
        model="mock-chat",
        source_id="primary",
    )
    assert saved is not None
    return saved


async def test_chat_conversation_store_crud_and_user_isolation(app_state: AppState) -> None:
    store = app_state.chat_conversations
    assert normalize_user_id(None) == "default"
    assert normalize_user_id("  Alice ") == "alice"
    assert await store.get("alice", "missing") is None

    alice = await _append(store, "Alice", "Investigate failed logins on web01")
    bob = await _append(store, "bob", "Summarize endpoint alerts")
    default = await _append(store, None, "What happened today?")

    alice_rows, alice_total = await store.list_for_user("alice")
    assert alice_total == 1
    assert [item.id for item in alice_rows] == [alice.id]
    assert alice_rows[0].title == "Investigate failed logins on web01"
    assert alice_rows[0].preview == "answer to Investigate failed logins on web01"
    assert alice_rows[0].message_count == 2
    assert alice_rows[0].model == "mock-chat"
    assert alice_rows[0].source_id == "primary"
    assert await store.get("alice", bob.id) is None
    assert (await store.get("default", default.id)) is not None

    resumed = await _append(store, "alice", "Show the source IPs", conversation_id=alice.id)
    assert resumed.id == alice.id
    assert resumed.title == alice.title
    assert [message.role for message in resumed.messages] == [
        "user", "assistant", "user", "assistant",
    ]
    assert resumed.messages[-1].response == {
        "answer": "answer to Show the source IPs",
        "cost": 0.01,
    }

    renamed = await store.rename("alice", alice.id, "  Failed login review  ")
    assert renamed is not None and renamed.title == "Failed login review"
    assert await store.rename("bob", alice.id, "Cannot see it") is None
    assert await store.delete("bob", alice.id) is False
    assert await store.delete("alice", alice.id) is True
    assert await store.get("alice", alice.id) is None


async def test_store_pagination_concurrency_and_bounds(app_state: AppState) -> None:
    store = app_state.chat_conversations
    # Same-user concurrent first writes share one KV document and must all survive.
    created = await asyncio.gather(*(
        _append(store, "carol", f"thread {index}") for index in range(4)
    ))
    rows, total = await store.list_for_user("carol", limit=2, offset=1)
    assert total == 4 and len(rows) == 2
    assert {item.id for item in rows}.issubset({item.id for item in created})

    # Transcript cap keeps complete exchanges.
    current = await _append(store, "dave", "turn 0")
    for index in range(1, MAX_MESSAGES_PER_CONVERSATION // 2 + 8):
        current = await _append(store, "dave", f"turn {index}", conversation_id=current.id)
    assert len(current.messages) == MAX_MESSAGES_PER_CONVERSATION
    assert current.messages[0].role == "user" and current.messages[-1].role == "assistant"

    # Per-user conversation cap trims old rows but always keeps the newest write.
    newest = None
    for index in range(MAX_CONVERSATIONS_PER_USER + 3):
        newest = await _append(store, "erin", f"conversation {index}")
    page = await store.list_page("erin", limit=MAX_CONVERSATIONS_PER_USER)
    rows, total = page.conversations, page.total
    assert total == MAX_CONVERSATIONS_PER_USER
    assert newest is not None and newest.id in {item.id for item in rows}
    assert page.history_truncated is True
    assert page.total_conversation_count == MAX_CONVERSATIONS_PER_USER + 3

    # Explicit deletion is not misreported as retention loss: both available and
    # logical totals fall by one, preserving only the pre-existing eviction gap.
    assert await store.delete("erin", newest.id) is True
    after_delete = await store.list_page("erin", limit=MAX_CONVERSATIONS_PER_USER)
    assert after_delete.total == MAX_CONVERSATIONS_PER_USER - 1
    assert after_delete.total_conversation_count == MAX_CONVERSATIONS_PER_USER + 2


async def test_store_skips_corrupt_rows_and_persists_on_sqlite(app_state: AppState) -> None:
    from app.constants import CHAT_CONVERSATIONS_NS
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    store = app_state.chat_conversations
    good = await _append(store, "frank", "good")
    partition_key = partition_key_for_user("frank")
    doc = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key)
    assert doc is not None
    rows = stored_conversation_rows(doc)
    rows["broken"] = {"messages": "not-a-list"}
    doc = with_stored_rows(doc, conversations=rows)
    doc["chat_conversation_rows"].append("{not json")                # an unreadable row
    await app_state.kv.put(CHAT_CONVERSATIONS_NS, partition_key, doc)
    rows, total = await store.list_for_user("frank")
    assert total == 1 and [item.id for item in rows] == [good.id]

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        sql_store = ChatConversationStore(SqlKVStore(engine))
        saved = await _append(sql_store, "grace", "persistent sqlite history")
        reloaded = await ChatConversationStore(SqlKVStore(engine)).get("grace", saved.id)
        assert reloaded is not None
        assert reloaded.messages[-1].content == "answer to persistent sqlite history"
    finally:
        await engine.dispose()


async def test_legacy_shared_document_migrates_one_hashed_user_partition(
    app_state: AppState,
) -> None:
    from app.constants import CHAT_CONVERSATIONS_KEY, CHAT_CONVERSATIONS_NS

    now = "2026-07-27T00:00:00Z"
    legacy = ChatConversation(
        id="chat-legacy",
        title="Legacy thread",
        preview="Legacy answer",
        created_at=now,
        updated_at=now,
        message_count=2,
        messages=[],
    )
    await app_state.kv.put(CHAT_CONVERSATIONS_NS, CHAT_CONVERSATIONS_KEY, {
        "conversations": {"legacy-user": {legacy.id: legacy.model_dump(mode="json")}},
    })
    reloaded = ChatConversationStore(app_state.kv)
    migrated = await reloaded.get("legacy-user", legacy.id)
    assert migrated is not None and migrated.title == "Legacy thread"
    partition = await app_state.kv.get(
        CHAT_CONVERSATIONS_NS, partition_key_for_user("legacy-user")
    )
    assert partition is not None and legacy.id in stored_conversation_rows(partition)
    root = await app_state.kv.get(CHAT_CONVERSATIONS_NS, CHAT_CONVERSATIONS_KEY)
    assert "legacy-user" not in (root or {}).get("conversations", {})


def test_chat_history_api_is_opt_in_and_restorable(client, mock_provider) -> None:
    # Existing callers remain stateless.
    stateless = client.post("/api/chat", json={"message": "stateless question"})
    assert stateless.status_code == 200
    assert stateless.json()["conversation_id"] is None
    assert client.get("/api/chat/conversations").json()["total"] == 0

    first = client.post("/api/chat", json={
        "message": "Show failed logins on web01",
        "persist_conversation": True,
        "idempotency_key": "chat-test-first-001",
    })
    assert first.status_code == 200
    cid = first.json()["conversation_id"]
    assert cid.startswith("chat-")
    assert first.json()["conversation_title"] == "Show failed logins on web01"
    assert first.json()["idempotency_key"] == "chat-test-first-001"
    assert first.json()["effective_source_name"] == "Primary source"

    listed = client.get("/api/chat/conversations?limit=10&offset=0")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["total_conversation_count"] == 1
    assert listed.json()["history_truncated"] is False
    assert listed.json()["conversations"][0]["id"] == cid
    assert listed.json()["conversations"][0]["message_count"] == 2

    detail = client.get(f"/api/chat/conversations/{cid}")
    assert detail.status_code == 200
    assert [item["role"] for item in detail.json()["messages"]] == ["user", "assistant"]
    assert detail.json()["messages"][1]["response"]["answer"]

    # A resumed durable conversation uses its server transcript, not the caller's
    # spoofed history array.
    resumed = client.post("/api/chat", json={
        "message": "Which IPs were involved?",
        "conversation_id": cid,
        "persist_conversation": True,
        "idempotency_key": "chat-test-resume-001",
        "history": [{"role": "user", "content": "SPOOFED PRIOR TURN"}],
    })
    assert resumed.status_code == 200
    chat_calls = [call for call in mock_provider.calls if call["role"] == "chat"]
    resumed_messages = chat_calls[-1]["messages"]
    contents = [message["content"] for message in resumed_messages]
    assert "Show failed logins on web01" in contents
    assert "SPOOFED PRIOR TURN" not in contents
    assert client.get(f"/api/chat/conversations/{cid}").json()["message_count"] == 4

    renamed = client.patch(
        f"/api/chat/conversations/{cid}", json={"title": "Web01 failed logins"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Web01 failed logins"

    deleted = client.delete(f"/api/chat/conversations/{cid}")
    assert deleted.status_code == 200 and deleted.json() == {"ok": True, "id": cid}
    assert client.get(f"/api/chat/conversations/{cid}").status_code == 404


def test_case_scoped_chat_never_duplicates_workspace_history(client) -> None:
    response = client.post("/api/chat", json={
        "message": "Summarize this case",
        "case_id": "case-history-boundary",
        "persist_conversation": True,
    })
    assert response.status_code == 200
    assert response.json()["conversation_id"] is None
    assert client.get("/api/chat/conversations").json()["total"] == 0


async def test_demo_history_is_isolated_and_purged(app_state: AppState) -> None:
    real = await _append(app_state.chat_conversations, None, "real conversation")
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        demo_rows, demo_total = await app_state.chat_conversations.list_for_user(None)
        assert demo_rows == [] and demo_total == 0
        demo = await _append(app_state.chat_conversations, None, "demo conversation")
        assert demo.id != real.id
    finally:
        await app_state.disable_demo()
    real_rows, real_total = await app_state.chat_conversations.list_for_user(None)
    assert real_total == 1 and [item.id for item in real_rows] == [real.id]


def test_history_routes_are_isolated_by_authenticated_principal() -> None:
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        auth_enabled=True,
        auth_jwt_secret="chat-history-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides=overrides,
        )
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={
            "setup_complete": True,
            "rbac": state.prefs.rbac.model_copy(update={"enabled": True}),
        })
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])

    with TestClient(api) as client:
        admin = client.post(
            "/api/auth/login", json={"username": "Admin", "password": "Admin@123"},
        )
        assert admin.status_code == 200
        created = client.post("/api/chat", json={
            "message": "admin-only conversation",
            "persist_conversation": True,
        })
        assert created.status_code == 200
        admin_conversation_id = created.json()["conversation_id"]

        analyst = client.post("/api/users", json={
            "username": "analyst",
            "password": "analyst-pass-12345",
            "role": "analyst_tier1",
        })
        assert analyst.status_code == 200, analyst.text
        client.cookies.clear()
        login = client.post(
            "/api/auth/login",
            json={"username": "analyst", "password": "analyst-pass-12345"},
        )
        assert login.status_code == 200

        assert client.get("/api/chat/conversations").json()["total"] == 0
        assert client.get(
            f"/api/chat/conversations/{admin_conversation_id}",
        ).status_code == 404
        assert client.patch(
            f"/api/chat/conversations/{admin_conversation_id}",
            json={"title": "not mine"},
        ).status_code == 404
        assert client.delete(
            f"/api/chat/conversations/{admin_conversation_id}",
        ).status_code == 404


def test_workspace_send_replays_same_idempotency_key_without_second_model_call(
    client, mock_provider,
) -> None:
    payload = {
        "message": "Summarize today's posture",
        "persist_conversation": True,
        "idempotency_key": "chat-replay-contract-001",
    }
    before = len([call for call in mock_provider.calls if call["role"] == "chat"])
    first = client.post("/api/chat", json=payload)
    second = client.post("/api/chat", json=payload)
    after = len([call for call in mock_provider.calls if call["role"] == "chat"])

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert after - before == 1

    conflict = client.post("/api/chat", json={**payload, "message": "Different request"})
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "chat_idempotency_conflict"


async def test_concurrent_reservation_and_stale_recovery(app_state: AppState) -> None:
    store = app_state.chat_conversations
    kwargs = {
        "idempotency_key": "chat-concurrent-reservation-001",
        "request_fingerprint": "a" * 64,
        "conversation_id": None,
    }
    results = await asyncio.gather(
        store.reserve_exchange("race-user", **kwargs),
        store.reserve_exchange("race-user", **kwargs),
        return_exceptions=True,
    )
    assert sum(not isinstance(item, Exception) for item in results) == 1
    assert sum(isinstance(item, ChatRequestInProgress) for item in results) == 1
    reserved = next(item for item in results if not isinstance(item, Exception))

    from app.constants import CHAT_CONVERSATIONS_NS

    key = partition_key_for_user("race-user")
    doc = await app_state.kv.get(CHAT_CONVERSATIONS_NS, key)
    assert doc is not None
    requests = stored_request_rows(doc)
    requests[kwargs["idempotency_key"]]["updated_at"] = "2000-01-01T00:00:00Z"
    await app_state.kv.put(CHAT_CONVERSATIONS_NS, key, with_stored_rows(doc, requests=requests))
    reclaimed = await store.reserve_exchange("race-user", **kwargs)
    assert reclaimed.status == "reserved"
    assert reclaimed.conversation_id == reserved.conversation_id
    assert reclaimed.lease_token != reserved.lease_token
    await store.abort_exchange(
        "race-user",
        idempotency_key=kwargs["idempotency_key"],
        request_fingerprint=kwargs["request_fingerprint"],
        lease_token=reserved.lease_token or "",
    )
    with pytest.raises(ChatRequestInProgress):
        await store.reserve_exchange("race-user", **kwargs)


async def test_a_reservation_keeps_its_requested_lease(app_state: AppState) -> None:
    """A turn configured to run longer than the default lease asks for a longer one;
    a same-key retry inside it is still told the request is in progress."""
    from datetime import datetime, timedelta, timezone

    from app.constants import CHAT_CONVERSATIONS_NS

    store = app_state.chat_conversations
    kwargs = {
        "idempotency_key": "chat-long-lease-0001",
        "request_fingerprint": "c" * 64,
        "conversation_id": None,
    }
    await store.reserve_exchange("lease-user", lease_seconds=1_320, **kwargs)
    key = partition_key_for_user("lease-user")

    async def age(seconds: int) -> None:
        doc = await app_state.kv.get(CHAT_CONVERSATIONS_NS, key)
        rows = stored_request_rows(doc)
        stamp = datetime.now(timezone.utc) - timedelta(seconds=seconds)
        rows[kwargs["idempotency_key"]]["updated_at"] = stamp.isoformat().replace("+00:00", "Z")
        await app_state.kv.put(CHAT_CONVERSATIONS_NS, key, with_stored_rows(doc, requests=rows))

    await age(700)                              # past the 10-minute default, inside 22 min
    with pytest.raises(ChatRequestInProgress):
        await store.reserve_exchange("lease-user", **kwargs)
    await age(1_400)                            # past the requested lease: reclaimable
    reclaimed = await store.reserve_exchange("lease-user", **kwargs)
    assert reclaimed.status == "reserved"


async def test_completed_receipt_survives_transcript_retention(app_state: AppState) -> None:
    store = app_state.chat_conversations
    key = "chat-old-completed-replay-001"
    fingerprint = "b" * 64
    reserved = await store.reserve_exchange(
        "retention-user",
        idempotency_key=key,
        request_fingerprint=fingerprint,
        conversation_id=None,
    )
    completed = await store.complete_exchange(
        "retention-user",
        idempotency_key=key,
        request_fingerprint=fingerprint,
        conversation_id=reserved.conversation_id,
        lease_token=reserved.lease_token or "",
        requested_existing_conversation=False,
        user_content="first question",
        assistant_content="first durable answer",
        response={"answer": "first durable answer", "cost": 0.01},
        model="mock-chat",
        source_id=None,
        source_name="Primary source",
    )
    first_assistant_id = completed.assistant_message.id
    current = completed.conversation
    assert current is not None
    for index in range(MAX_MESSAGES_PER_CONVERSATION // 2 + 2):
        current = await _append(
            store, "retention-user", f"later turn {index}", conversation_id=current.id
        )
    assert first_assistant_id not in {item.id for item in current.messages}

    replay = await store.reserve_exchange(
        "retention-user",
        idempotency_key=key,
        request_fingerprint=fingerprint,
        conversation_id=None,
    )
    assert replay.status == "completed"
    assert replay.assistant_message is not None
    assert replay.assistant_message.content == "first durable answer"


async def test_stale_in_progress_receipts_are_bounded(app_state: AppState) -> None:
    from app.constants import CHAT_CONVERSATIONS_NS

    store = app_state.chat_conversations
    user = "abandoned-workers"
    partition_key = partition_key_for_user(user)
    stale_count = MAX_IDEMPOTENCY_RECORDS + 17
    stale_at = "2000-01-01T00:00:00Z"
    requests = {
        f"chat-stale-{index:04d}": {
            "status": "in_progress",
            "fingerprint": f"{index:064x}"[-64:],
            "conversation_id": f"chat-{index:04d}",
            "created_at": stale_at,
            "updated_at": stale_at,
            "lease_token": f"lease-{index:04d}",
        }
        for index in range(stale_count)
    }
    await app_state.kv.put(
        CHAT_CONVERSATIONS_NS,
        partition_key,
        {
            "schema": 2,
            "conversations": {},
            "requests": requests,
            "history_truncated": False,
            "total_conversation_count": 0,
        },
    )

    await store.reserve_exchange(
        user,
        idempotency_key="chat-current-live-request-001",
        request_fingerprint="f" * 64,
        conversation_id=None,
    )
    stored = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key)
    assert stored is not None
    assert len(stored_request_rows(stored)) == MAX_IDEMPOTENCY_RECORDS
    assert "chat-current-live-request-001" in stored_request_rows(stored)


async def test_live_request_limit_rejects_without_persisting_overflow(
    app_state: AppState,
) -> None:
    from app.constants import CHAT_CONVERSATIONS_NS

    store = app_state.chat_conversations
    user = "busy-workers"
    partition_key = partition_key_for_user(user)
    live_at = "2999-01-01T00:00:00Z"
    requests = {
        f"chat-live-{index:04d}": {
            "status": "in_progress",
            "fingerprint": f"{index:064x}"[-64:],
            "conversation_id": f"chat-{index:04d}",
            "created_at": live_at,
            "updated_at": live_at,
            "lease_token": f"lease-{index:04d}",
        }
        for index in range(MAX_IDEMPOTENCY_RECORDS)
    }
    await app_state.kv.put(
        CHAT_CONVERSATIONS_NS,
        partition_key,
        {
            "schema": 2,
            "conversations": {},
            "requests": requests,
            "history_truncated": False,
            "total_conversation_count": 0,
        },
    )

    with pytest.raises(ChatRequestCapacityBusy, match="Too many chat requests"):
        await store.reserve_exchange(
            user,
            idempotency_key="chat-overflow-request-001",
            request_fingerprint="e" * 64,
            conversation_id=None,
        )
    stored = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key)
    assert stored is not None
    assert len(stored_request_rows(stored)) == MAX_IDEMPOTENCY_RECORDS
    assert "chat-overflow-request-001" not in stored_request_rows(stored)

    # Completing one live lease makes one receipt safely evictable, so a new request
    # can reserve capacity without touching any of the other live lease tokens.
    completed_key = "chat-live-0000"
    completed_request = requests[completed_key]
    await store.complete_exchange(
        user,
        idempotency_key=completed_key,
        request_fingerprint=completed_request["fingerprint"],
        conversation_id=completed_request["conversation_id"],
        lease_token=completed_request["lease_token"],
        requested_existing_conversation=False,
        user_content="completed request",
        assistant_content="completed response",
        response={"answer": "completed response"},
        model="mock-chat",
        source_id=None,
        source_name="Primary source",
    )
    after_completion = await store.reserve_exchange(
        user,
        idempotency_key="chat-after-completion-001",
        request_fingerprint="d" * 64,
        conversation_id=None,
    )
    assert after_completion.status == "reserved"
    stored = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key)
    assert stored is not None
    assert len(stored_request_rows(stored)) == MAX_IDEMPOTENCY_RECORDS
    assert completed_key not in stored_request_rows(stored)
    assert "chat-after-completion-001" in stored_request_rows(stored)

    # An expired lease is likewise evictable. The other still-live leases remain and
    # the next reservation succeeds at, never above, the documented bound.
    expired_key = "chat-live-0001"
    requests_now = stored_request_rows(stored)
    requests_now[expired_key]["updated_at"] = "2000-01-01T00:00:00Z"
    await app_state.kv.put(CHAT_CONVERSATIONS_NS, partition_key, with_stored_rows(stored, requests=requests_now))
    after_expiry = await store.reserve_exchange(
        user,
        idempotency_key="chat-after-expiry-001",
        request_fingerprint="c" * 64,
        conversation_id=None,
    )
    assert after_expiry.status == "reserved"
    stored = await app_state.kv.get(CHAT_CONVERSATIONS_NS, partition_key)
    assert stored is not None
    assert len(stored_request_rows(stored)) == MAX_IDEMPOTENCY_RECORDS
    assert expired_key not in stored_request_rows(stored)
    assert "chat-after-expiry-001" in stored_request_rows(stored)


class _CapacityBusyChatStore:
    async def reserve_exchange(self, *args, **kwargs):
        raise ChatRequestCapacityBusy(
            "Too many chat requests are in progress; retry shortly."
        )


def test_live_request_limit_returns_typed_busy_without_model_call(
    client, mock_provider,
) -> None:
    state = client.app.state.tlsoc
    original = state._real_chat_conversations
    state._real_chat_conversations = _CapacityBusyChatStore()
    before = len([call for call in mock_provider.calls if call["role"] == "chat"])
    try:
        response = client.post("/api/chat", json={
            "message": "Do not start another live request",
            "persist_conversation": True,
            "idempotency_key": "chat-capacity-busy-001",
        })
    finally:
        state._real_chat_conversations = original
    after = len([call for call in mock_provider.calls if call["role"] == "chat"])
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "chat_request_capacity_busy"
    assert after == before


class _BrokenChatKV(KVStore):
    async def get(self, namespace: str, key: str):
        raise OSError("state backend offline")

    async def put(self, namespace: str, key: str, value: dict) -> None:
        raise OSError("state backend offline")


async def test_strict_store_surfaces_backend_failure_before_optimistic_success() -> None:
    store = ChatConversationStore(_BrokenChatKV())
    with pytest.raises(ChatHistoryUnavailable):
        await store.reserve_exchange(
            "operator",
            idempotency_key="chat-backend-failure-001",
            request_fingerprint="c" * 64,
            conversation_id=None,
        )


def test_history_backend_failure_returns_503_before_model_is_billed(
    client, mock_provider,
) -> None:
    state = client.app.state.tlsoc
    original = state._real_chat_conversations
    state._real_chat_conversations = ChatConversationStore(_BrokenChatKV())
    before = len([call for call in mock_provider.calls if call["role"] == "chat"])
    try:
        response = client.post("/api/chat", json={
            "message": "Do not bill this request",
            "persist_conversation": True,
            "idempotency_key": "chat-no-bill-on-store-failure-001",
        })
    finally:
        state._real_chat_conversations = original
    after = len([call for call in mock_provider.calls if call["role"] == "chat"])
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "chat_history_unavailable"
    assert after == before
