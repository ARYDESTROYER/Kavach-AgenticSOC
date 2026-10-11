"""Deleting a user purges the account's chat material (Round 12 final review, L1-0 F4).

Every per-user chat store is keyed by the USERNAME (``partition_key_for_user``): the
Workspace conversations with their exchange, archive, summary, step-observation and
live-state documents, the request receipts, the answer ratings (with free-text
comments) and the reports. Before this fix ``DELETE /api/users/{u}`` cleared only the
inbox, notification and display preferences, so a NEW account created later under the
same name inherited all of it. Now the account's running chat turns are stopped and
its whole chat partition, its ratings and its reports are purged with it.
"""

from __future__ import annotations

from app.constants import CHAT_CONVERSATIONS_NS
from app.llm.providers import MockProvider
from app.stores.chat_conversations import live_state_key, partition_key_for_user
from app.stores.chat_feedback import CHAT_FEEDBACK_NS
from tests.test_chat_round12_api import REPORT_FINAL, _auth_client, _login
from tests.test_chat_routes_stream import TOOL_STEP

COMMENT = "host FIN-SRV-02 is our payroll box, keep quiet"


def test_a_recreated_account_inherits_no_chat_material() -> None:
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _auth_client(provider) as client:
        state = client.app.state.tlsoc
        _login(client, "Admin", "Admin@123")
        created = client.post("/api/users", json={
            "username": "carol", "password": "carol-pass-12345", "role": "analyst_tier1",
        })
        assert created.status_code == 200, created.text
        _login(client, "carol", "carol-pass-12345")
        first = client.post("/api/chat", json={
            "message": "Create a monthly SOC report for September",
            "persist_conversation": True, "idempotency_key": "r12-carol-0001",
        })
        assert first.status_code == 200, first.text
        answer = first.json()
        cid, mid = answer["conversation_id"], answer["message_id"]
        assert answer["saved_report"]
        rated = client.post("/api/chat/feedback", json={
            "conversation_id": cid, "message_id": mid, "rating": "down", "reason": "other",
            "comment": COMMENT,
        })
        assert rated.status_code == 204, rated.text
        detail = client.get(f"/api/chat/conversations/{cid}").json()
        tool = next(s for s in detail["messages"][1]["response"]["steps"] if s["kind"] == "tool")
        step_url = f"/api/chat/conversations/{cid}/messages/{mid}/steps/{tool['index']}"
        assert client.get(step_url).status_code == 200
        assert len(client.get("/api/reports").json()["reports"]) == 1

        # The administrator deletes "carol" and creates the same name again.
        _login(client, "Admin", "Admin@123")
        assert client.delete("/api/users/carol").status_code == 200
        recreated = client.post("/api/users", json={
            "username": "carol", "password": "carol-new-pass-999", "role": "analyst_tier1",
        })
        assert recreated.status_code == 200, recreated.text
        _login(client, "carol", "carol-new-pass-999")

        assert client.get("/api/chat/feedback").json()["feedback"] == []
        summary = client.get("/api/chat/feedback/summary").json()
        assert summary["total"] == 0 and summary["down"] == 0 and summary["with_comment"] == 0
        assert client.get("/api/chat/conversations").json()["conversations"] == []
        assert client.get(f"/api/chat/conversations/{cid}").status_code == 404
        assert client.get(step_url).status_code == 404
        assert client.get("/api/reports").json()["reports"] == []

        # Nothing of the predecessor's text is left in the stores themselves either.
        key = partition_key_for_user("carol")

        async def leftovers() -> list[str]:
            texts: list[str] = []
            feedback = await state.kv.get(CHAT_FEEDBACK_NS, key)
            texts.append(str(feedback or ""))
            texts.append(str(await state.kv.get(CHAT_CONVERSATIONS_NS, key) or ""))
            texts.append(str(await state.kv.get(CHAT_CONVERSATIONS_NS, live_state_key(key)) or ""))
            return texts

        dumped = " ".join(client.portal.call(leftovers))
        assert COMMENT not in dumped and "September SOC report" not in dumped
        assert cid not in dumped


def test_deleting_an_account_without_chat_material_still_succeeds() -> None:
    with _auth_client(MockProvider()) as client:
        _login(client, "Admin", "Admin@123")
        assert client.post("/api/users", json={
            "username": "dave", "password": "dave-pass-12345", "role": "analyst_tier1",
        }).status_code == 200
        assert client.delete("/api/users/dave").status_code == 200
        assert client.post("/api/users", json={
            "username": "dave", "password": "dave-pass-12345", "role": "analyst_tier1",
        }).status_code == 200
