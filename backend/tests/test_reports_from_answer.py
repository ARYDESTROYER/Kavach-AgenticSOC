"""``POST /api/reports/from-answer`` (Round 12 D11, WP-FEAT-A review fix).

When the report a chat answer's header asked for could not be saved with a retryable
error, the console offers "Save as report". That retry must:

* save the SAME report the answer asked for (its title and template, recorded on the
  stored ``saved_report_error`` server-side, never sent by the client);
* be idempotent per answer (a second click, another tab, a click after a reload return
  the same report; the library never holds a duplicate);
* record ``saved_report`` on the stored answer and drop ``saved_report_error``, so a
  reopened thread shows the saved line instead of offering the save again;
* stay owner-scoped and map store failures to the usual report codes.
"""

from __future__ import annotations

from typing import Any

from app.llm.providers import MockProvider
from app.models import ChatReportSaveError
from tests.test_chat_round12_api import REPORT_FINAL, _auth_client, _login, _open_client
from tests.test_chat_routes_stream import TOOL_STEP


def _report_turn(client, key: str) -> dict[str, Any]:  # noqa: ANN001
    response = client.post("/api/chat", json={
        "message": "Create a monthly SOC report for September", "persist_conversation": True,
        "idempotency_key": key,
    })
    assert response.status_code == 200, response.text
    return response.json()


def _failing_once(monkeypatch) -> list[int]:  # noqa: ANN001
    """The report store is down for the turn's own save, then recovers."""
    from app.stores.reports import ReportStore, ReportStoreUnavailable

    original = ReportStore.create_with_items
    calls = [0]

    async def _flaky(self, *args: Any, **kwargs: Any):  # noqa: ANN001
        calls[0] += 1
        if calls[0] == 1:
            raise ReportStoreUnavailable("down")
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(ReportStore, "create_with_items", _flaky)
    return calls


def test_the_save_error_records_the_requested_title_and_template() -> None:
    error = ChatReportSaveError.model_validate({
        "code": "report_unavailable", "title": "Sept\u202e report\u200b", "template": "nonsense",
    })
    assert error.title == "Sept report" and error.template is None
    assert ChatReportSaveError(code="report_limit").title is None


def test_save_as_report_saves_the_requested_report_once_and_records_it(monkeypatch) -> None:  # noqa: ANN001
    _failing_once(monkeypatch)
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _open_client(provider) as client:
        answer = _report_turn(client, "r12-from-answer-0001")
        error = answer["saved_report_error"]
        assert error["code"] == "report_unavailable" and error["retryable"] is True
        # What the header asked for travels on the error (server-side truth for the retry).
        assert error["title"] == "September SOC report" and error["template"] == "monthly"
        cid, mid = answer["conversation_id"], answer["message_id"]

        first = client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": mid})
        assert first.status_code == 200, first.text
        saved = first.json()
        assert saved["title"] == "September SOC report" and saved["items"] >= 1
        report = client.get(f"/api/reports/{saved['id']}").json()
        assert report["template"] == "monthly"

        # Idempotent per answer: a second click returns the same report, no duplicate.
        again = client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": mid})
        assert again.status_code == 200 and again.json()["id"] == saved["id"]
        assert [r["id"] for r in client.get("/api/reports").json()["reports"]] == [saved["id"]]

        # Recorded on the stored answer: a reopened thread shows the saved line, not the offer.
        detail = client.get(f"/api/chat/conversations/{cid}").json()
        stored = detail["messages"][1]["response"]
        assert stored["saved_report"]["id"] == saved["id"]
        assert not stored.get("saved_report_error")


def test_save_as_report_is_idempotent_even_when_the_answer_could_not_record_it(monkeypatch) -> None:  # noqa: ANN001
    from app.stores.chat_conversations import ChatConversationStore

    _failing_once(monkeypatch)

    async def _no_record(*_args: Any, **_kwargs: Any) -> bool:
        raise RuntimeError("store glitch")

    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _open_client(provider) as client:
        answer = _report_turn(client, "r12-from-answer-0002")
        cid, mid = answer["conversation_id"], answer["message_id"]
        monkeypatch.setattr(ChatConversationStore, "update_message_response", _no_record)
        ids = {
            client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": mid}).json()["id"]
            for _ in range(3)
        }
        # The derived id still dedupes: one report however often it is clicked.
        assert len(ids) == 1
        assert len(client.get("/api/reports").json()["reports"]) == 1


def test_save_as_report_maps_unknown_answers_full_libraries_and_extra_fields(monkeypatch) -> None:  # noqa: ANN001
    from app.stores.reports import ReportLimitReached, ReportStore

    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _open_client(provider) as client:
        answer = _report_turn(client, "r12-from-answer-0003")
        cid, mid = answer["conversation_id"], answer["message_id"]
        missing = client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": "chatmsg-nope"})
        assert missing.status_code == 404 and missing.json()["detail"]["code"] == "message_not_found"
        # The client never supplies the title or content.
        extra = client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": mid, "title": "x"})
        assert extra.status_code == 422
        # The turn's own save succeeded: the recorded report is returned, nothing is written.
        recorded = client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": mid})
        assert recorded.status_code == 200 and recorded.json()["id"] == answer["saved_report"]["id"]

    async def _full(*_args: Any, **_kwargs: Any):
        raise ReportLimitReached("full")

    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    monkeypatch.setattr(ReportStore, "create_with_items", _full)
    with _open_client(provider) as client:
        answer = _report_turn(client, "r12-from-answer-0004")
        full = client.post("/api/reports/from-answer", json={
            "conversation_id": answer["conversation_id"], "message_id": answer["message_id"],
        })
        assert full.status_code == 409 and full.json()["detail"]["code"] == "report_limit"


def test_save_as_report_is_owner_scoped(monkeypatch) -> None:  # noqa: ANN001
    _failing_once(monkeypatch)
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        answer = _report_turn(client, "r12-from-answer-0005")
        cid, mid = answer["conversation_id"], answer["message_id"]
        created = client.post("/api/users", json={
            "username": "other-analyst", "password": "Other-Analyst-1!", "role": "analyst_tier1",
        })
        assert created.status_code in (200, 201), created.text
        _login(client, "other-analyst", "Other-Analyst-1!")
        refused = client.post("/api/reports/from-answer", json={"conversation_id": cid, "message_id": mid})
        assert refused.status_code == 404
        assert client.get("/api/reports").json()["reports"] == []
