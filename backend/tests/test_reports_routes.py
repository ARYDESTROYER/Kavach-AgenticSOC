"""Chat reports routes (SPEC §9.2): add by reference, CAS, summary, RBAC, Demo, reset.

Offline: fake ES + MockProvider through an ASGI client, with real Workspace chat
history seeded through the chat conversation store (so "add" resolves exactly what a
finished turn persisted). Covers the client-facing response shapes, case-scope and
client-JSON refusal, 404/409 mapping (expired and trimmed blocks, full reports,
version conflicts), audit rows, the summary's single gateway call (one UsageDoc,
idempotency, single-flight, the token bucket and failure refunds), Demo determinism
and isolation, RBAC, and the factory-reset purge of the reports namespace."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, AsyncIterator

import httpx
from fastapi import Depends, FastAPI

from app import __version__
from app.agents.blocks import expire_block
from app.agents.chat_events import REPORT_SUMMARY_SYSTEM_MARKER
from app.api import routes_reports
from app.api.deps import require_auth
from app.api.routes import router as main_router
from app.api.routes_reports import TokenBucket, presentation_of, router as reports_router, summary_guard
from app.config import Secrets
from app.constants import MAX_REPORT_ITEMS, ActionType, ResetScope, UserRole
from app.engine.reset import reset_service
from app.es.fake import InMemoryESClient
from app.llm import gateway as gateway_module
from app.llm.gateway import BudgetBlocked
from app.llm.providers import MockProvider
from app.models import ChatConversation, ReportItem
from app.state import AppState
from app.stores import reports as reports_mod
from app.stores.chat_conversations import ChatHistoryUnavailable
from app.stores.reports import ReportStoreUnavailable, new_item_id

T1 = UserRole.ANALYST_TIER1.value


# --------------------------------------------------------------------------- #
# Harness.
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def harness(*, auth: bool = False, rbac: bool = False) -> AsyncIterator[SimpleNamespace]:
    extra: dict[str, Any] = (
        {"auth_enabled": True, "auth_jwt_secret": "reports-test-secret", "auth_seed_admin": True}
        if auth else {}
    )
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, **extra,
    )
    mock = MockProvider()
    state = AppState.create(
        secrets=secrets, es=InMemoryESClient(),
        provider_overrides={"anthropic": mock, "openai": mock, "mock": mock},
    )
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    if rbac:
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
    await state.update_prefs(prefs)
    api = FastAPI()
    api.state.tlsoc = state
    if auth:
        api.include_router(main_router, dependencies=[Depends(require_auth)])
    api.include_router(reports_router, dependencies=[Depends(require_auth)])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api), base_url="http://test") as client:
            yield SimpleNamespace(client=client, state=state, mock=mock)
    finally:
        await state.shutdown()


def chart_block(block_id: str = "b1") -> dict[str, Any]:
    return {
        "id": block_id, "type": "chart", "kind": "hbar", "unit": "count", "provenance": "source",
        "artifact_kind": "categories", "allowed_views": ["hbar", "bar", "table"], "from_step": 1,
        "title": "Top source IPs", "caption": "exact · last 24h",
        "x": {"kind": "category", "values": ["10.0.0.1", "10.0.0.2", "10.0.0.3"]},
        "series": [{"key": "count", "label": "Events", "values": [40, 25, 5]}],
    }


def table_block(block_id: str = "b2") -> dict[str, Any]:
    return {
        "id": block_id, "type": "table", "provenance": "source", "artifact_kind": "table",
        "allowed_views": ["table"], "title": "Failed logins",
        "columns": [{"key": "ip", "label": "IP", "type": "entity"},
                    {"key": "message", "label": "Message", "type": "text"}],
        "rows": [[f"10.0.0.{i}", f"RAW-LOG-LINE-{i}"] for i in range(8)],
    }


def report_envelope(block_id: str = "b3") -> dict[str, Any]:
    return {
        "id": block_id, "type": "report", "provenance": "ai", "title": "Shift brief", "template": "shift",
        "scope": {"generated_at": "2026-10-07T00:00:00Z"},
        "sections": [{"id": "s1", "heading": "Summary", "blocks": [
            {"id": "b4", "type": "callout", "provenance": "ai", "tone": "info", "text": "Quiet shift."},
        ]}],
    }


def tool_step() -> dict[str, Any]:
    return {
        "index": 1, "ordinal": 1, "kind": "tool", "tool": "log_stats", "label": "Counted events",
        "params": {"time_from": "now-24h", "group_by": "ip"}, "status": "ok", "duration_ms": 12,
        "summary": "1,284 events", "sources": ["wazuh-prod"], "rows": 1284, "basis": "exact",
    }


async def seed_answer(
    state: AppState, user: str = "", *, blocks: list[dict[str, Any]] | None = None,
    question: str = "Who is brute forcing us?", answer: str = "Three IPs account for most failures.",
    conversation_id: str | None = None, **response_extra: Any,
) -> tuple[str, str]:
    """Persist one Workspace exchange exactly as a finished turn would and return
    ``(conversation_id, assistant_message_id)``."""
    response = {
        "answer": answer,
        "blocks": blocks if blocks is not None else [chart_block(), table_block(), report_envelope()],
        "steps": [tool_step()],
        "usage": {"calls": 2, "input_tokens": 900, "output_tokens": 120, "total_tokens": 1020,
                  "cost": 0.002, "model": "claude-test"},
        "effective_model": "claude-test",
        "effective_source_name": "wazuh-prod",
        "answer_kind": "data",
        **response_extra,
    }
    conversation = await state.chat_conversations.append_exchange(
        user, conversation_id=conversation_id, user_content=question, assistant_content=answer,
        response=response, model="claude-test",
    )
    assert conversation is not None
    assistant = [m for m in conversation.messages if m.role == "assistant"][-1]
    return conversation.id, assistant.id


async def add(client: httpx.AsyncClient, conversation_id: str, message_id: str, **extra: Any) -> httpx.Response:
    return await client.post("/api/reports/add", json={
        "conversation_id": conversation_id, "message_id": message_id, **extra,
    })


async def audit_rows(state: AppState, action: str = "report") -> list[dict[str, Any]]:
    rows = await state.audit.records(limit=500)
    return [r for r in rows if r.get("action_type") == action]


async def report_usage_rows(state: AppState) -> list[dict[str, Any]]:
    return [r for r in await state.usage_store.records(limit=500) if r.get("surface") == "report"]


def summary_reply(text: str = "Brute force from three IPs; contained.") -> str:
    return json.dumps({"executive_summary": text, "next_steps": ["Block 10.0.0.1", "Review case-0001"]})


# --------------------------------------------------------------------------- #
# Add by reference.
# --------------------------------------------------------------------------- #
async def test_scope_never_credits_a_log_source_a_store_lookup_did_not_query():
    """A metrics/cases answer (steps without sources) is not attributed to the turn's
    resolved log source; a log tool step without recorded sources still is."""
    metrics_step = {
        "index": 1, "ordinal": 1, "kind": "tool", "tool": "soc_metrics", "label": "Read posture",
        "params": {}, "status": "ok", "duration_ms": 5, "summary": "Posture", "sources": [],
    }
    async with harness() as h:
        cid, mid = await seed_answer(h.state, steps=[metrics_step],
                                     effective_source_name="Splunk Enterprise Security — HEC")
        block = (await add(h.client, cid, mid, block_id="b1")).json()
        assert block["report"]["items"][0]["scope"]["sources"] == []
        whole = (await add(h.client, cid, mid)).json()
        assert all(item["scope"]["sources"] == [] for item in whole["report"]["items"])
    log_step = {**tool_step(), "sources": []}
    async with harness() as h:
        cid, mid = await seed_answer(h.state, steps=[log_step])
        block = (await add(h.client, cid, mid, block_id="b1")).json()
        assert block["report"]["items"][0]["scope"]["sources"] == ["wazuh-prod"]


async def test_add_block_creates_the_draft_and_returns_report_and_item_id():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        resp = await add(h.client, cid, mid, block_id="b1")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) >= {"report", "item_id"}
        assert body["added"] is True and body["created_report"] is True
        report = body["report"]
        assert report["conversation_id"] == cid and report["version"] == 2
        item = report["items"][0]
        assert item["id"] == body["item_id"] and item["kind"] == "block"
        assert item["block"]["id"] == "b1" and item["block"]["type"] == "chart"
        assert item["source"] == {"conversation_id": cid, "message_id": mid, "block_id": "b1"}
        # Scope is captured server-side at add time.
        # The tool's effective window comes from the engine-written caption.
        assert item["scope"] == {
            "window": "last 24h", "sources": ["wazuh-prod"], "generated_by": "claude-test",
            "app_version": __version__, "demo": False,
        }

        # Idempotent: the same block again returns the existing item, no new version.
        again = (await add(h.client, cid, mid, block_id="b1")).json()
        assert again["added"] is False and again["item_id"] == body["item_id"]
        assert again["report"]["version"] == 2

        # A report leaf is addable by its id too, into the same draft. With no caption
        # window, the producing step's window chip is the scope.
        leaf = (await add(h.client, cid, mid, block_id="b4")).json()
        assert leaf["report"]["id"] == report["id"] and leaf["report"]["items"][1]["block"]["type"] == "callout"
        assert leaf["report"]["items"][1]["scope"]["window"] == "now-24h → now"

        listed = (await h.client.get("/api/reports")).json()
        assert [r["id"] for r in listed["reports"]] == [report["id"]]
        assert listed["reports"][0]["item_count"] == 2 and listed["total"] == 1
        fetched = (await h.client.get(f"/api/reports/{report['id']}")).json()
        assert [i["block"]["id"] for i in fetched["items"]] == ["b1", "b4"]

        # The conversation summary learns its draft (when the chat store offers it).
        conversation = await h.state.chat_conversations.get("", cid)
        if hasattr(h.state.chat_conversations, "set_report_id"):
            assert conversation.report_id == report["id"]

        rows = await audit_rows(h.state)
        assert any("report created" in r["result_summary"] for r in rows)
        assert sum("report item added" in r["result_summary"] for r in rows) == 2
        assert all(r["surface"] == "report" and r["actor"] == "default" for r in rows)

        # Reports survive the conversation's deletion; only new adds from it are gone.
        assert await h.state.chat_conversations.delete("", cid)
        kept = await h.client.get(f"/api/reports/{report['id']}")
        assert kept.status_code == 200 and len(kept.json()["items"]) == 2
        gone = await add(h.client, cid, mid, block_id="b2")
        assert gone.status_code == 404 and gone.json()["detail"]["code"] == "conversation_not_found"


async def test_whole_answer_is_added_as_a_section():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        body = (await add(h.client, cid, mid)).json()
        item = body["report"]["items"][0]
        assert item["kind"] == "section" and item["source"]["block_id"] is None
        section = item["block"]
        assert section["title"] == "Who is brute forcing us?"
        assert section["blocks"][0] == {
            "id": "answer", "type": "markdown", "provenance": "ai",
            "text": "Three IPs account for most failures.",
        }
        assert [b["id"] for b in section["blocks"][1:]] == ["b1", "b2", "b3"]
        assert item["scope"]["window"] == "last 24h"


async def test_section_of_a_truncated_answer_says_truncated():
    """Saved history cut the answer for storage: the section discloses it (G4)."""
    async with harness() as h:
        cid, mid = await seed_answer(h.state, blocks=[table_block()], truncated=True)
        section = (await add(h.client, cid, mid)).json()["report"]["items"][0]["block"]
        assert section["truncated"] is True
        cid2, mid2 = await seed_answer(h.state, blocks=[table_block()])
        assert (await add(h.client, cid2, mid2)).json()["report"]["items"][0]["block"]["truncated"] is False


def test_an_unreadable_presentation_with_blocks_is_refused_not_degraded():
    """A stored presentation that no longer validates would degrade to its text and
    silently drop the blocks: an add refuses (409) instead. A text-only answer loses
    nothing, so it still degrades to its text."""
    def conversation(response: dict[str, Any]) -> ChatConversation:
        return ChatConversation.model_validate({
            "id": "chat-1", "title": "t", "created_at": "2026-10-07T00:00:00Z",
            "updated_at": "2026-10-07T00:00:00Z",
            "messages": [{"id": "u1", "role": "user", "content": "q"},
                         {"id": "a1", "role": "assistant", "content": "the answer", "response": response}],
        })

    drifted = conversation({"turn_id": {"not": "a string"}, "blocks": [chart_block()]})
    answer = routes_reports._resolve_answer(drifted, "a1")
    assert answer is not None and answer.presentation_lost
    for block_id in ("b1", None):
        try:
            routes_reports._build_item(answer, drifted, conversation_id="chat-1", message_id="a1",
                                       block_id=block_id, demo=False)
        except routes_reports.HTTPException as exc:
            assert exc.status_code == 409 and exc.detail["code"] == "block_unavailable"
        else:  # pragma: no cover - the assertion below explains the failure
            raise AssertionError("a lost presentation must not be added")

    text_only = conversation({"turn_id": {"not": "a string"}})
    answer = routes_reports._resolve_answer(text_only, "a1")
    assert answer is not None and not answer.presentation_lost
    item = routes_reports._build_item(answer, text_only, conversation_id="chat-1", message_id="a1",
                                      block_id=None, demo=False)
    assert [b["text"] for b in item.block["blocks"]] == ["the answer"]


async def test_client_block_json_and_case_scope_are_refused():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        forged = {"type": "kpi_group", "id": "x1", "provenance": "code",
                  "items": [{"key": "k", "label": "Fake", "value": 999, "unit": "count"}]}
        resp = await add(h.client, cid, mid, block=forged)
        assert resp.status_code == 422
        # A case-scoped request cannot create an item: the field is not accepted...
        assert (await add(h.client, cid, mid, case_id="case-0001")).status_code == 422
        # ...and case-scoped turns never enter Workspace history, so a case id is no
        # conversation the caller owns.
        resp = await add(h.client, "case-0001", mid)
        assert resp.status_code == 404 and resp.json()["detail"]["code"] == "conversation_not_found"
        assert (await h.client.get("/api/reports")).json()["reports"] == []


async def test_not_found_codes_for_message_block_and_report():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        conversation = await h.state.chat_conversations.get("", cid)
        user_message = [m for m in conversation.messages if m.role == "user"][0]
        cases = [
            (await add(h.client, cid, "chatmsg-missing"), "message_not_found"),
            (await add(h.client, cid, user_message.id), "message_not_found"),
            (await add(h.client, cid, mid, block_id="b99"), "block_not_found"),
            (await add(h.client, cid, mid, report_id="rpt-doesnotexist"), "report_not_found"),
            (await add(h.client, cid, mid, report_id="index"), "report_not_found"),
        ]
        for resp, code in cases:
            assert resp.status_code == 404, resp.text
            assert resp.json()["detail"]["code"] == code
        assert (await h.client.get("/api/reports/rpt-nothing")).status_code == 404
        assert (await h.client.get("/api/reports/index")).status_code == 404


async def test_expired_or_trimmed_blocks_are_409_block_unavailable():
    async with harness() as h:
        stub = expire_block(chart_block("b1"))
        cid, mid = await seed_answer(h.state, blocks=[stub, table_block()])
        for extra in ({"block_id": "b1"}, {}):
            resp = await add(h.client, cid, mid, **extra)
            assert resp.status_code == 409 and resp.json()["detail"]["code"] == "block_unavailable"
        # The table next to it is still addable.
        assert (await add(h.client, cid, mid, block_id="b2")).status_code == 200

        # A stored answer that was cut for storage: a missing block is "trimmed", not unknown.
        cid2, mid2 = await seed_answer(h.state, blocks=[table_block()], truncated=True)
        resp = await add(h.client, cid2, mid2, block_id="b1")
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "block_unavailable"


async def test_report_full_by_size_on_add_and_patch_is_409(monkeypatch):
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        report = (await add(h.client, cid, mid, block_id="b1")).json()["report"]
        doc = reports_mod.encode_report(await routes_reports._store(h.state).get("", report["id"]))
        bound = reports_mod._content_bytes(doc) + 32 + reports_mod.SUMMARY_RESERVE_BYTES + 100
        monkeypatch.setattr(reports_mod, "MAX_REPORT_DOC_BYTES", bound)
        resp = await add(h.client, cid, mid, block_id="b2")
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "report_full" and resp.json()["detail"]["reason"] == "size"
        item_id = report["items"][0]["id"]
        resp = await h.client.patch(f"/api/reports/{report['id']}", json={
            "expected_version": report["version"], "notes": {item_id: "n" * 500},
        })
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "report_full", "message": "Report is full (storage size limit).", "reason": "size",
        }


async def test_chat_history_outage_is_503_on_add_and_create(monkeypatch):
    async with harness() as h:
        cid, mid = await seed_answer(h.state)

        async def down(*_a: Any, **_k: Any):
            raise ChatHistoryUnavailable("kv down")

        monkeypatch.setattr(h.state.chat_conversations, "get", down)
        for resp in (await add(h.client, cid, mid, block_id="b1"),
                     await h.client.post("/api/reports", json={"conversation_id": cid})):
            assert resp.status_code == 503
            assert resp.json()["detail"]["code"] == "chat_history_unavailable"
        assert (await h.client.get("/api/reports")).json()["reports"] == []


async def test_report_full_at_forty_items_is_409():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        first = (await add(h.client, cid, mid, block_id="b1")).json()["report"]
        store = routes_reports._store(h.state)
        for i in range(MAX_REPORT_ITEMS - 1):
            await store.add_item("", ReportItem.model_validate({
                "id": new_item_id(), "kind": "block", "block": chart_block(),
                "source": {"conversation_id": cid, "message_id": f"m{i}", "block_id": "b1"},
            }), report_id=first["id"])
        resp = await add(h.client, cid, mid, block_id="b2")
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "code": "report_full", "message": "Report is full (40 items).", "reason": "items",
        }


# --------------------------------------------------------------------------- #
# Create / patch / delete.
# --------------------------------------------------------------------------- #
async def test_create_patch_delete_with_cas_and_audit():
    async with harness() as h:
        created = await h.client.post("/api/reports", json={"title": "Hunt", "template": "hunt"})
        assert created.status_code == 200, created.text
        report = created.json()
        assert report["version"] == 1 and report["owner"] == "default" and report["items"] == []
        rid = report["id"]

        # Create with an unknown conversation id → 404; an empty body works.
        assert (await h.client.post("/api/reports", json={"conversation_id": "chat-nope"})).status_code == 404
        assert (await h.client.post("/api/reports")).json()["title"] == "Untitled report"

        resp = await h.client.patch(f"/api/reports/{rid}", json={"expected_version": 1})
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == "report_patch_empty"
        resp = await h.client.patch(f"/api/reports/{rid}", json={"expected_version": 1, "title": "Renamed"})
        assert resp.status_code == 200 and resp.json()["version"] == 2
        stale = await h.client.patch(f"/api/reports/{rid}", json={"expected_version": 1, "title": "Again"})
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "report_version_conflict"
        assert stale.json()["detail"]["current_version"] == 2
        unknown = await h.client.patch(f"/api/reports/{rid}", json={"expected_version": 2, "remove_items": ["rpti-x"]})
        assert unknown.status_code == 422 and unknown.json()["detail"]["code"] == "report_item_unknown"

        assert (await h.client.request("DELETE", f"/api/reports/{rid}")).status_code == 422
        conflict = await h.client.request("DELETE", f"/api/reports/{rid}", json={"expected_version": 1})
        assert conflict.status_code == 409
        done = await h.client.request("DELETE", f"/api/reports/{rid}", json={"expected_version": 2})
        assert done.status_code == 200 and done.json() == {"ok": True, "id": rid}
        assert (await h.client.get(f"/api/reports/{rid}")).status_code == 404
        # The query-parameter form for clients whose DELETE cannot carry a body.
        other = (await h.client.post("/api/reports", json={"title": "Q"})).json()
        assert (await h.client.delete(f"/api/reports/{other['id']}?expected_version=1")).status_code == 200

        summaries = [r["result_summary"] for r in await audit_rows(h.state)]
        assert sum(s.startswith("report created") for s in summaries) == 3
        assert sum(s.startswith("report updated") for s in summaries) == 1
        assert sum(s.startswith("report deleted") for s in summaries) == 2
        # Reads and refused writes are not audited as report mutations.
        assert len(summaries) == 6


async def test_conversation_draft_conflict_and_delete_unlinks():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        draft = (await h.client.post("/api/reports", json={"conversation_id": cid})).json()
        dup = await h.client.post("/api/reports", json={"conversation_id": cid})
        assert dup.status_code == 409
        assert dup.json()["detail"] == {
            "code": "report_conversation_draft_exists",
            "message": "This conversation already has a report.", "report_id": draft["id"],
        }
        # The first add goes into that draft rather than creating a second one.
        added = (await add(h.client, cid, mid, block_id="b1")).json()
        assert added["report"]["id"] == draft["id"] and added["created_report"] is False
        await h.client.request("DELETE", f"/api/reports/{draft['id']}", json={"expected_version": 2})
        if hasattr(h.state.chat_conversations, "set_report_id"):
            assert (await h.state.chat_conversations.get("", cid)).report_id is None
        fresh = (await add(h.client, cid, mid, block_id="b1")).json()
        assert fresh["created_report"] is True and fresh["report"]["id"] != draft["id"]


async def test_interrupted_delete_is_finished_by_delete_or_add_and_unlinks():
    async with harness() as h:
        store = routes_reports._store(h.state)
        original = store._index_remove_locked

        async def crash(*_a: Any, **_k: Any):
            raise ReportStoreUnavailable("index write lost")

        async def interrupted_delete(rid: str, version: int) -> None:
            store._index_remove_locked = crash  # type: ignore[method-assign]
            try:
                resp = await h.client.request("DELETE", f"/api/reports/{rid}", json={"expected_version": version})
                assert resp.status_code == 503
            finally:
                store._index_remove_locked = original  # type: ignore[method-assign]

        # 1. The next DELETE completes it AND unlinks the conversation (the content was
        #    already tombstoned, so the conversation id comes from the index row).
        cid, mid = await seed_answer(h.state)
        draft = (await add(h.client, cid, mid, block_id="b1")).json()["report"]
        await interrupted_delete(draft["id"], draft["version"])
        assert (await h.state.chat_conversations.get("", cid)).report_id == draft["id"]
        done = await h.client.request("DELETE", f"/api/reports/{draft['id']}", json={"expected_version": draft["version"]})
        assert done.status_code == 200
        assert (await h.state.chat_conversations.get("", cid)).report_id is None
        assert (await h.client.get("/api/reports")).json()["reports"] == []

        # 2. An add from that conversation finishes it too, with a fresh draft.
        cid2, mid2 = await seed_answer(h.state)
        draft2 = (await add(h.client, cid2, mid2, block_id="b1")).json()["report"]
        await interrupted_delete(draft2["id"], draft2["version"])
        fresh = await add(h.client, cid2, mid2, block_id="b1")
        assert fresh.status_code == 200, fresh.text
        body = fresh.json()
        assert body["created_report"] is True and body["report"]["id"] != draft2["id"]
        assert [r["id"] for r in (await h.client.get("/api/reports")).json()["reports"]] == [body["report"]["id"]]
        assert (await h.state.chat_conversations.get("", cid2)).report_id == body["report"]["id"]


# --------------------------------------------------------------------------- #
# Summary.
# --------------------------------------------------------------------------- #
async def _report_with_item(h: SimpleNamespace) -> dict[str, Any]:
    cid, mid = await seed_answer(h.state)
    return (await add(h.client, cid, mid, block_id="b2")).json()["report"]


async def test_dry_run_estimates_without_a_model_call():
    async with harness() as h:
        report = await _report_with_item(h)
        calls = len(h.mock.calls)
        resp = await h.client.post(f"/api/reports/{report['id']}/summary?dry_run=1", json={})
        assert resp.status_code == 200, resp.text
        est = resp.json()
        assert set(est) == {"prompt_tokens", "max_output_tokens", "total_tokens", "cost", "simulated", "model"}
        assert est["prompt_tokens"] > 0 and est["total_tokens"] > est["prompt_tokens"]
        assert est["simulated"] is False and isinstance(est["cost"], float)  # auth off: models:read held
        assert len(h.mock.calls) == calls
        assert await report_usage_rows(h.state) == []


async def test_summary_is_one_gateway_call_one_usage_doc_and_idempotent():
    async with harness() as h:
        report = await _report_with_item(h)
        h.mock.push("chat", summary_reply())
        resp = await h.client.post(f"/api/reports/{report['id']}/summary",
                                   json={"idempotency_key": "sum-key-0001", "expected_version": report["version"]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        summary = body["summary"]
        assert summary["executive_summary"] == "Brute force from three IPs; contained."
        assert summary["next_steps"] == ["Block 10.0.0.1", "Review case-0001"]
        assert summary["based_on_version"] == body["version"] == report["version"]
        assert summary["usage"]["calls"] == 1 and summary["usage"]["total_tokens"] > 0

        # The prompt: fixed system prompt + the fenced digest, no raw table rows (#7).
        call = h.mock.calls[-1]
        assert call["role"] == "chat"
        system, user = call["messages"][0]["content"], call["messages"][1]["content"]
        assert system.startswith(REPORT_SUMMARY_SYSTEM_MARKER)
        assert "source=report" in user and "RAW-LOG-LINE" not in user

        usage = await report_usage_rows(h.state)
        assert len(usage) == 1  # exactly one UsageDoc for the one call (#6)

        # Same key → the stored result, no second call, no second row.
        calls = len(h.mock.calls)
        again = await h.client.post(f"/api/reports/{report['id']}/summary", json={"idempotency_key": "sum-key-0001"})
        assert again.status_code == 200 and again.json()["summary"] == summary
        assert len(h.mock.calls) == calls and len(await report_usage_rows(h.state)) == 1

        # Editing the report makes the summary stale (based_on_version lags).
        edited = (await h.client.patch(f"/api/reports/{report['id']}",
                                       json={"expected_version": body["version"], "title": "Edited"})).json()
        assert edited["version"] == body["version"] + 1
        assert edited["summary"]["based_on_version"] == body["version"]

        prompt_rows = await audit_rows(h.state, ActionType.PROMPT.value)
        assert len([r for r in prompt_rows if r.get("surface") == "report"]) == 1
        assert any("report summary generated" in r["result_summary"] for r in await audit_rows(h.state))

        stale = await h.client.post(f"/api/reports/{report['id']}/summary", json={"expected_version": 1})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "report_version_conflict"


async def test_summary_of_an_empty_report_is_refused():
    async with harness() as h:
        report = (await h.client.post("/api/reports", json={"title": "Empty"})).json()
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 409 and resp.json()["detail"]["code"] == "report_empty"
        assert await report_usage_rows(h.state) == []


async def test_summary_single_flight_second_request_is_409():
    async with harness() as h:
        report = await _report_with_item(h)
        gateway = h.state.chat_engine._gateway
        real_complete = gateway.complete
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow_complete(*args: Any, **kwargs: Any):
            entered.set()
            await release.wait()
            return await real_complete(*args, **kwargs)

        gateway.complete = slow_complete  # type: ignore[method-assign]
        h.mock.push("chat", summary_reply())
        first = asyncio.create_task(h.client.post(f"/api/reports/{report['id']}/summary", json={}))
        await asyncio.wait_for(entered.wait(), timeout=5)
        second = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert second.status_code == 409
        assert second.json()["detail"]["code"] == "report_summary_in_progress"
        release.set()
        assert (await first).status_code == 200
        assert len(await report_usage_rows(h.state)) == 1
        assert summary_guard(h.state).locks == {}  # released and dropped


async def test_summary_token_bucket_limits_and_refunds_unspent_failures():
    async with harness() as h:
        report = await _report_with_item(h)
        now = [1000.0]
        summary_guard(h.state).bucket = TokenBucket(capacity=2, window_s=3600, clock=lambda: now[0])
        gateway = h.state.chat_engine._gateway
        real_complete = gateway.complete

        async def blocked(*_a: Any, **_k: Any):
            raise BudgetBlocked("budget ceiling exceeded: daily")

        # A call refused before any spend does not use up the caller's allowance.
        gateway.complete = blocked  # type: ignore[method-assign]
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "budget_blocked"
        assert resp.json()["detail"]["retryable"] is False
        gateway.complete = real_complete  # type: ignore[method-assign]

        for _ in range(2):
            h.mock.push("chat", summary_reply())
            assert (await h.client.post(f"/api/reports/{report['id']}/summary", json={})).status_code == 200
        limited = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert limited.status_code == 429
        assert limited.json()["detail"]["code"] == "report_summary_rate_limited"
        assert int(limited.headers["Retry-After"]) > 0
        assert len(await report_usage_rows(h.state)) == 2

        now[0] += 1800  # half the window refills one token
        h.mock.push("chat", summary_reply())
        assert (await h.client.post(f"/api/reports/{report['id']}/summary", json={})).status_code == 200


async def test_summary_timeout_is_504_metered_as_abandoned_and_not_refunded(monkeypatch):
    async with harness() as h:
        report = await _report_with_item(h)
        bucket = TokenBucket(capacity=2, window_s=3600, clock=lambda: 0.0)
        summary_guard(h.state).bucket = bucket
        # The bound is SUMMARY_TIMEOUT_FACTOR × the step timeout (30 s): ~60 ms here.
        monkeypatch.setattr(routes_reports, "SUMMARY_TIMEOUT_FACTOR", 0.002)

        async def slow(*_a: Any, **_k: Any):
            await asyncio.sleep(5)
            raise AssertionError("not reached")

        h.mock.complete = slow  # type: ignore[method-assign]
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 504
        detail = resp.json()["detail"]
        assert detail["code"] == "report_summary_timeout"
        assert detail["message"] == routes_reports.SUMMARY_FAILURE_MESSAGES["report_summary_timeout"]
        assert "found so far" not in detail["message"]  # never the chat-turn wording
        rows = await report_usage_rows(h.state)
        assert len(rows) == 1 and rows[0]["failure_class"] == "abandoned"  # the in-flight spend (#6)
        # The provider may bill an abandoned request: the token is NOT given back.
        assert bucket.take("default") is None and bucket.take("default") is not None
        assert (await h.client.get(f"/api/reports/{report['id']}")).json()["summary"] is None


async def test_provider_failure_is_503_provider_unavailable_with_summary_wording():
    async with harness() as h:
        report = await _report_with_item(h)

        async def broken(*_a: Any, **_k: Any):
            raise RuntimeError("upstream exploded")

        h.mock.complete = broken  # type: ignore[method-assign]
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["code"] == "provider_unavailable" and detail["retryable"] is True
        assert detail["message"] == routes_reports.SUMMARY_FAILURE_MESSAGES["provider_unavailable"]
        assert "exploded" not in json.dumps(detail)
        assert len(await report_usage_rows(h.state)) == 1  # the failed request is ledgered once
        failed = [r for r in await audit_rows(h.state) if "report summary failed" in r["result_summary"]]
        assert len(failed) == 1 and "provider_unavailable" in failed[0]["result_summary"]


async def test_a_digest_that_keeps_no_item_is_refused_before_any_spend(monkeypatch):
    async with harness() as h:
        report = await _report_with_item(h)
        bucket = TokenBucket(capacity=1, window_s=3600, clock=lambda: 0.0)
        summary_guard(h.state).bucket = bucket
        real = routes_reports.bounded_digest
        monkeypatch.setattr(routes_reports, "bounded_digest", lambda r: real(r, max_chars=100))
        calls = len(h.mock.calls)
        for url in (f"/api/reports/{report['id']}/summary?dry_run=1", f"/api/reports/{report['id']}/summary"):
            resp = await h.client.post(url, json={})
            assert resp.status_code == 409 and resp.json()["detail"]["code"] == "report_too_large_to_summarise"
        assert len(h.mock.calls) == calls and await report_usage_rows(h.state) == []
        assert bucket.take("default") is None  # the refused call never used the allowance


async def test_summary_with_no_text_is_502_but_still_metered_once():
    async with harness() as h:
        report = await _report_with_item(h)
        h.mock.push("chat", json.dumps({"executive_summary": "", "next_steps": []}))
        resp = await h.client.post(f"/api/reports/{report['id']}/summary", json={})
        assert resp.status_code == 502 and resp.json()["detail"]["code"] == "report_summary_invalid"
        assert len(await report_usage_rows(h.state)) == 1
        assert (await h.client.get(f"/api/reports/{report['id']}")).json()["summary"] is None


# --------------------------------------------------------------------------- #
# Demo Mode: deterministic, $0, isolated, bucket-exempt.
# --------------------------------------------------------------------------- #
async def test_demo_summary_is_deterministic_simulated_and_isolated():
    async with harness() as h:
        real = (await h.client.post("/api/reports", json={"title": "Real report"})).json()
        real_usage_before = len(await report_usage_rows(h.state))
        await h.state.enable_demo(mode="seeded", seed=1337, history_days=1)
        try:
            assert (await h.client.get("/api/reports")).json()["reports"] == []
            summary_guard(h.state).bucket = TokenBucket(capacity=1, window_s=3600, clock=lambda: 0.0)
            cid, mid = await seed_answer(h.state, question="Posture now?")
            added = (await add(h.client, cid, mid, block_id="b1")).json()
            assert added["report"]["items"][0]["scope"]["demo"] is True
            rid = added["report"]["id"]
            # Determinism is a property of ONE digest: summarise the same report twice
            # (distinct idempotency keys, so the second is a real second call).
            texts = []
            for key in ("demo-key-0001", "demo-key-0002"):
                resp = await h.client.post(f"/api/reports/{rid}/summary", json={"idempotency_key": key})
                assert resp.status_code == 200, resp.text  # Demo is exempt from the bucket
                summary = resp.json()["summary"]
                assert summary["usage"]["simulated"] is True
                texts.append((summary["executive_summary"], summary["next_steps"]))
            assert texts[0] == texts[1] and texts[0][0]
            # Built from the digest: the block's title and its leading category.
            assert "Top source IPs" in texts[0][0] and "10.0.0.1" in texts[0][0]
            assert len(await report_usage_rows(h.state)) == 2  # the DEMO ledger, one row per call
        finally:
            await h.state.disable_demo()
        listed = (await h.client.get("/api/reports")).json()["reports"]
        assert [r["id"] for r in listed] == [real["id"]]
        assert len(await report_usage_rows(h.state)) == real_usage_before


async def test_demo_dry_run_prices_with_the_synthetic_rate():
    async with harness() as h:
        await h.state.enable_demo(mode="seeded", seed=1337, history_days=1)
        try:
            cid, mid = await seed_answer(h.state)
            rid = (await add(h.client, cid, mid, block_id="b1")).json()["report"]["id"]
            est = (await h.client.post(f"/api/reports/{rid}/summary?dry_run=1", json={})).json()
            assert est["simulated"] is True
            expected_out = est["total_tokens"] - est["prompt_tokens"]
            assert est["cost"] == gateway_module._demo_synthetic_cost(est["prompt_tokens"], expected_out)
            assert await report_usage_rows(h.state) == []
        finally:
            await h.state.disable_demo()


# --------------------------------------------------------------------------- #
# Auth, ownership and RBAC.
# --------------------------------------------------------------------------- #
async def _login(client: httpx.AsyncClient, username: str, password: str) -> None:
    client.cookies.clear()
    resp = await client.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text


async def test_owner_scoping_with_auth_on():
    async with harness(auth=True) as h:
        assert (await h.client.get("/api/reports")).status_code == 401
        await _login(h.client, "Admin", "Admin@123")
        assert (await h.client.post("/api/users", json={
            "username": "bob", "password": "bob-pass-12", "role": T1,
        })).status_code == 200
        cid, mid = await seed_answer(h.state, "Admin")
        admin_report = (await add(h.client, cid, mid, block_id="b1")).json()["report"]
        assert admin_report["owner"] == "admin"
        assert (await audit_rows(h.state))[-1]["actor"] == "Admin"

        await _login(h.client, "bob", "bob-pass-12")
        assert (await h.client.get("/api/reports")).json()["reports"] == []
        assert (await h.client.get(f"/api/reports/{admin_report['id']}")).status_code == 404
        # Bob cannot add from Admin's conversation, nor into Admin's report.
        assert (await add(h.client, cid, mid, block_id="b1")).status_code == 404
        bob_cid, bob_mid = await seed_answer(h.state, "bob")
        resp = await add(h.client, bob_cid, bob_mid, block_id="b1", report_id=admin_report["id"])
        assert resp.status_code == 404
        resp = await h.client.request("DELETE", f"/api/reports/{admin_report['id']}", json={"expected_version": 2})
        assert resp.status_code == 404


async def test_every_route_requires_cases_read():
    async with harness(auth=True, rbac=True) as h:
        await _login(h.client, "Admin", "Admin@123")
        roles = dict(h.state.prefs.rbac.roles)
        roles[T1] = {"cases": []}
        await h.state.update_prefs(h.state.prefs.model_copy(update={
            "rbac": h.state.prefs.rbac.model_copy(update={"roles": roles}),
        }))
        assert (await h.client.post("/api/users", json={
            "username": "carol", "password": "carol-pass-12", "role": T1,
        })).status_code == 200
        report = (await h.client.post("/api/reports", json={"title": "Admin"})).json()
        rid = report["id"]

        await _login(h.client, "carol", "carol-pass-12")
        calls = [
            h.client.get("/api/reports"),
            h.client.post("/api/reports", json={"title": "x"}),
            h.client.get(f"/api/reports/{rid}"),
            h.client.patch(f"/api/reports/{rid}", json={"expected_version": 1, "title": "x"}),
            h.client.request("DELETE", f"/api/reports/{rid}", json={"expected_version": 1}),
            h.client.post("/api/reports/add", json={"conversation_id": "c1", "message_id": "m1"}),
            h.client.post(f"/api/reports/{rid}/summary?dry_run=1", json={}),
            h.client.post(f"/api/reports/{rid}/summary", json={}),
        ]
        for call in calls:
            resp = await call
            assert resp.status_code == 403, resp.text


async def test_estimate_hides_money_without_models_read():
    async with harness(auth=True, rbac=True) as h:
        await _login(h.client, "Admin", "Admin@123")
        roles = dict(h.state.prefs.rbac.roles)
        roles[T1] = {"models": []}
        await h.state.update_prefs(h.state.prefs.model_copy(update={
            "rbac": h.state.prefs.rbac.model_copy(update={"roles": roles}),
        }))
        assert (await h.client.post("/api/users", json={
            "username": "dave", "password": "dave-pass-12", "role": T1,
        })).status_code == 200
        await _login(h.client, "dave", "dave-pass-12")
        cid, mid = await seed_answer(h.state, "dave")
        report = (await add(h.client, cid, mid, block_id="b1")).json()["report"]
        denied_before = len(await h.state.control_audit.records(limit=500))
        est = (await h.client.post(f"/api/reports/{report['id']}/summary?dry_run=1", json={})).json()
        assert est["cost"] is None and est["prompt_tokens"] > 0
        # Probing models:read for the estimate writes no ACCESS_DENIED row.
        assert len(await h.state.control_audit.records(limit=500)) == denied_before


# --------------------------------------------------------------------------- #
# Presentation adapter and reset.
# --------------------------------------------------------------------------- #
def test_presentation_adapter_reads_every_stored_form():
    blocks = [chart_block()]
    encoded = json.dumps({"blocks": blocks, "steps": [tool_step()], "truncated": True})
    forms = [
        {"role": "assistant", "content": "a", "response": {"blocks": blocks}},
        {"role": "assistant", "content": "a", "response": {"cost": 0.1, "presentation_json": encoded}},
        {"role": "assistant", "content": "a", "presentation_json": encoded},
    ]
    for form in forms:
        assert presentation_of(form)["blocks"][0]["id"] == "b1"
    # A top-level scalar wins over the same key in the presentation (like the store).
    mixed = {"response": {"truncated": False, "presentation_json": encoded}}
    assert presentation_of(mixed)["truncated"] is False
    assert presentation_of({"response": {"presentation_json": "{not json"}}) == {}
    conversation = ChatConversation.model_validate({
        "id": "chat-1", "title": "t", "created_at": "2026-10-07T00:00:00Z",
        "updated_at": "2026-10-07T00:00:00Z",
        "messages": [{"id": "u1", "role": "user", "content": "q"}, {"id": "a1", **forms[1]}],
    })
    answer = routes_reports._resolve_answer(conversation, "a1")
    assert answer is not None and answer.question == "q" and answer.response.blocks[0]["id"] == "b1"
    assert routes_reports._resolve_answer(conversation, "u1") is None


async def _seed_factory_anchors(state: AppState) -> None:
    await state.kv.put("jobs", "jobs", {"jobs": {}, "idempotency": {}, "factory_fence": ""})
    await state.kv.put("batch_jobs", "jobs", {"jobs": {}, "factory_fence": "", "reset_epoch": 0})


async def test_factory_reset_purges_reports_on_the_sql_backend(tmp_path):
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        state_backend="sqlite", state_db_url=f"sqlite+aiosqlite:///{tmp_path / 'state.db'}",
    )
    mock = MockProvider()
    state = AppState.create(secrets=secrets, es=InMemoryESClient(),
                            provider_overrides={"anthropic": mock, "openai": mock, "mock": mock})
    await state.startup(start_poller=False)
    try:
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        store = routes_reports._store(state)
        report = await store.create("alice", title="SQL report")
        assert [e.id for e in await store.list("alice")] == [report.id]
        await _seed_factory_anchors(state)
        receipt = await reset_service(state, ResetScope.FACTORY)
        assert receipt["failed"] == [], receipt
        assert await routes_reports._store(state).list("alice") == []
        assert await routes_reports._store(state).get("alice", report.id) is None
    finally:
        await state.shutdown()


async def test_factory_reset_purges_reports_and_case_reset_keeps_them():
    async with harness() as h:
        cid, mid = await seed_answer(h.state)
        report = (await add(h.client, cid, mid, block_id="b1")).json()["report"]
        await reset_service(h.state, ResetScope.CASES)
        assert [r["id"] for r in (await h.client.get("/api/reports")).json()["reports"]] == [report["id"]]
        await _seed_factory_anchors(h.state)
        receipt = await reset_service(h.state, ResetScope.FACTORY)
        assert receipt["failed"] == [], receipt
        assert (await h.client.get("/api/reports")).json()["reports"] == []
        assert (await h.client.get(f"/api/reports/{report['id']}")).status_code == 404
