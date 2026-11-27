"""Reports saved from chat read as documents (Round 12 final review, L4 reports).

- A report saved from an answer (D11: the answer header, "Save as report") never opens
  with two "Summary" sections: the answer's own text is "Overview" when the expanded
  Brief already has a "Summary", and it never carries the chat-only closing sentence
  ("The full report is below, and it is being saved to your Reports.").
- Every report-row in ``GET /api/reports`` names the conversation it came from in
  ``source_conversation_id`` (the library's "Source conversation" column), while
  ``conversation_id`` keeps meaning "this conversation's draft": a report saved from an
  answer or a whole conversation is not that conversation's draft.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
import pytest_asyncio

from app.api.routes_reports import (
    _Answer,
    _chat_only_closings,
    _prose_title,
    _report_prose,
    items_for_answer,
)
from app.engine.demo_chat import _BRIEF_READY, _REPORT_READY, _REPORT_SAVING
from app.llm import providers
from app.llm.providers import MockProvider
from app.models import Report, ReportListEntry
from app.stores.reports import index_entry, source_conversation_of
from tests.test_chat_round12_api import REPORT_FINAL, TOOL_STEP, _auth_client, _login
from tests.test_chat_tools_support import build_demo_state
from tests.test_demo_chat_e2e import _turn

CHAT_ONLY = ("being saved to your Reports", "ready to add to your Reports", "ready to add to a report",
             "The full report is below", "The report below", "The brief below")


def _texts(item: Any) -> list[str]:
    block = item.block if isinstance(item.block, dict) else item.block.model_dump()
    leaves = block.get("blocks") if item.kind == "section" else [block]
    return [str(leaf.get("text") or "") for leaf in leaves or [] if isinstance(leaf, dict)]


def _title(item: Any) -> str:
    block = item.block if isinstance(item.block, dict) else item.block.model_dump()
    return str(block.get("title") or "")


# --------------------------------------------------------------------------- #
# The answer text a report keeps, and its section title (unit).
# --------------------------------------------------------------------------- #
def test_chat_only_closings_are_the_planner_sentences() -> None:
    assert _chat_only_closings() == {_BRIEF_READY, _REPORT_READY, _REPORT_SAVING}


@pytest.mark.parametrize("closing", [_REPORT_SAVING, _REPORT_READY, _BRIEF_READY])
def test_report_prose_drops_only_a_trailing_chat_only_paragraph(closing: str) -> None:
    lead = "Lifetime: 412 cases, 61% closed automatically."
    note = "False-positive rate is not measured where no case has a closing verdict."
    assert _report_prose(f"{lead}\n\n{note}\n\n{closing}") == f"{lead}\n\n{note}"
    assert _report_prose(f"{lead}\n\n{closing}\n") == lead
    assert _report_prose(closing) == ""
    # Only a whole trailing paragraph goes: the sentence inside other text stays.
    inline = f"{lead} {closing}"
    assert _report_prose(inline) == inline
    middle = f"{lead}\n\n{closing}\n\n{note}"
    assert _report_prose(middle) == middle
    assert _report_prose("") == ""


def test_prose_title_never_collides_with_a_brief_section() -> None:
    brief = {"type": "report", "sections": [{"heading": "Summary"}, {"heading": "Volume"}]}
    assert _prose_title([], expand_briefs=True) == "Summary"
    assert _prose_title([brief], expand_briefs=True) == "Overview"
    assert _prose_title([brief], expand_briefs=False) == "Summary"
    crowded = {"type": "report", "sections": [{"heading": h} for h in (" summary ", "OVERVIEW", "Answer")]}
    assert _prose_title([crowded], expand_briefs=True) == "Answer text"


# --------------------------------------------------------------------------- #
# The Demo "create a report" turns, saved the way the server saves them (D11).
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def demo_state(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    state = await build_demo_state()
    yield state
    await state.shutdown()


@pytest.mark.parametrize("question", [
    "Create a report of lifetime performance pls thanks",
    "Create a report for the last 90 days",
    "Create an infographic report of the last 30 days",
    "Give me a report on the SOC posture",
])
async def test_demo_report_saves_have_unique_titles_and_no_chat_sentence(demo_state: Any, question: str) -> None:
    response = await _turn(demo_state, question, origin="user")
    brief = next((b for b in response.blocks if b.get("type") == "report"), None)
    assert brief is not None, response.answer
    # The chat answer itself still says where the report is (accepted chat design) …
    assert response.answer.rstrip().endswith((_REPORT_SAVING, _REPORT_READY))
    answer = _Answer(message={}, question=question, response=response, stored_truncated=False)
    items = items_for_answer(answer, {}, conversation_id="conv-1", message_id="msg-2", demo=True)
    titles = [_title(item) for item in items]
    assert len(titles) == len(set(titles)), titles
    headings = [str(s.get("heading") or "") for s in brief.get("sections") or []]
    if "Summary" in headings:
        assert titles[0] == "Overview" and titles[1] == "Summary", titles
    # … but no saved section repeats a chat-only sentence.
    for item in items:
        for text in _texts(item):
            assert not any(phrase in text for phrase in CHAT_ONLY), (titles, text)
    # The lead and its notes survive.
    assert _texts(items[0]) and _texts(items[0])[0].strip()


# --------------------------------------------------------------------------- #
# The library row names the conversation a report came from.
# --------------------------------------------------------------------------- #
def _report(conversation_id: str | None, sources: list[str]) -> Report:
    return Report.model_validate({
        "id": "rpt-1", "owner": "admin", "title": "Weekly", "template": "custom",
        "conversation_id": conversation_id,
        "items": [{
            "id": f"it-{i}", "kind": "block",
            "block": {"id": f"b{i}", "type": "markdown", "provenance": "ai", "text": "x"},
            "source": {"conversation_id": cid, "message_id": f"m{i}", "block_id": f"b{i}"},
            "scope": {}, "added_at": "2026-10-10T10:00:00Z",
        } for i, cid in enumerate(sources)],
        "updated_at": "2026-10-10T10:00:00Z",
    })


def test_source_conversation_is_derived_from_the_items() -> None:
    assert source_conversation_of(_report(None, ["c1", "c1"])) == "c1"
    assert source_conversation_of(_report(None, ["c1", "c2"])) is None
    assert source_conversation_of(_report(None, [])) is None
    # A draft: its own conversation, unless every item names one other conversation.
    assert source_conversation_of(_report("c1", [])) == "c1"
    assert source_conversation_of(_report("c1", ["c1", "c2"])) == "c1"
    row = index_entry(_report(None, ["c1"]))
    assert row["conversation_id"] is None and row["source_conversation_id"] == "c1"
    # A row written before the field existed still reads (and shows no source).
    legacy = {k: v for k, v in row.items() if k != "source_conversation_id"}
    assert ReportListEntry.model_validate(legacy).source_conversation_id is None


REPORT_BRIEF_FINAL = (
    json.dumps({
        "action": "final", "answer_kind": "data",
        "blocks": [{"type": "report", "title": "Lifetime performance", "template": "executive",
                    "sections": [
                        {"heading": "Summary", "summary": "Brute force leads the alerts.",
                         "items": [{"ref": "t1.a1"}]},
                        {"heading": "Volume", "items": [{"type": "markdown", "text": "Volume held steady."}]},
                    ]}],
        "report": {"title": "Lifetime performance", "template": "executive"},
    })
    + "\n---ANSWER---\nBrute force is T1110 and leads the alerts."
)


def test_saved_reports_name_their_source_conversation_and_open_cleanly() -> None:
    provider = MockProvider()
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_BRIEF_FINAL)
    provider.push("chat", TOOL_STEP)
    provider.push("chat", REPORT_FINAL)
    with _auth_client(provider) as client:
        _login(client, "Admin", "Admin@123")
        first = client.post("/api/chat", json={
            "message": "Create a report of lifetime performance", "persist_conversation": True,
            "idempotency_key": "r12-brief-0001",
        })
        assert first.status_code == 200, first.text
        answer = first.json()
        cid = answer["conversation_id"]
        saved = answer["saved_report"]
        assert saved, answer
        # The answer's text and the Brief's own "Summary" are two differently named sections.
        report = client.get(f"/api/reports/{saved['id']}").json()
        titles = [i["block"]["title"] for i in report["items"]]
        assert titles[:3] == ["Overview", "Summary", "Volume"], titles
        assert len(titles) == len(set(titles))
        # A second answer in the same conversation, then the whole conversation as a report.
        second = client.post("/api/chat", json={
            "message": "Create a monthly SOC report for September", "persist_conversation": True,
            "conversation_id": cid, "idempotency_key": "r12-brief-0002",
        })
        assert second.status_code == 200, second.text
        whole = client.post("/api/reports/from-conversation", json={
            "conversation_id": cid, "idempotency_key": "r12-whole-0001",
        })
        assert whole.status_code == 200, whole.text
        rows = {r["id"]: r for r in client.get("/api/reports").json()["reports"]}
        assert len(rows) == 3
        for row in rows.values():
            # Never this conversation's draft, but always its source.
            assert row["conversation_id"] is None
            assert row["source_conversation_id"] == cid
        assert whole.json()["report"]["id"] in rows and saved["id"] in rows
