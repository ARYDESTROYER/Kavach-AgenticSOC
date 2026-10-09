"""End-to-end Demo Mode chat (chat revamp SPEC §5.5, §10.5).

Runs the REAL ``ChatEngine`` agent loop over a seeded Demo stack: the demo gateway
(``DemoMockProvider`` delegating to ``engine.demo_chat``), the demo stores, the five
demo log sources and the demo RAG, with the tool context built by the one route
builder (``AppState.build_chat_tool_context``). For every empty-state starter it
checks that several lookups ran, that blocks were materialised from artifacts (and
agree with the numbers in the prose), that usage is metered as simulated at $0, and
that two runs produce byte-identical answers. It also covers Live text, a restricted
role, the replay-based follow-ups ("break that down by user", "as a table", "same for
the last 48 hours") and the report summary through the demo gateway.
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio

import app.llm.providers as providers
from app.agents.chat_events import TextDeltaEvent, TurnDoneEvent
from app.agents.chat_protocol import PriorExchange, parse_report_summary
from app.agents.chat_tools.registry import build_toolbox, catalogue_grant_pairs
from app.constants import Role
from app.engine.demo_chat import DEMO_STARTERS
from app.models import ChatRequest, ChatResponse
from tests.test_chat_tools_support import build_demo_state, demo_context

STARTERS = {s.id: s for s in DEMO_STARTERS}
EXPECTED_KIND = {"investigate": "data", "hunt": "data", "posture": "data", "shift_brief": "data",
                 "explain_metric": "mixed", "learn_app": "product_help"}


@pytest_asyncio.fixture
async def demo_state(monkeypatch: pytest.MonkeyPatch):
    # Live text types out in word groups with a small delay; tests run it at 0 ms.
    monkeypatch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    state = await build_demo_state()
    yield state
    await state.shutdown()


def _request(state: Any) -> Any:
    """The request surface ``build_chat_tool_context`` reads (auth is off here)."""
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(tlsoc=state)), cookies={}, headers={})


async def _context(state: Any, question: str, grants: frozenset[tuple[str, str]], **fields: Any) -> Any:
    builder = getattr(state, "build_chat_tool_context", None)
    if builder is None:  # the route builder is the contract; the helper mirrors it
        return demo_context(state, grants=grants)
    return await builder(_request(state), ChatRequest(message=question, **fields), grants=grants)


async def _turn(state: Any, question: str, *, grants: frozenset[tuple[str, str]] | None = None,
                origin: str = "starter", prior: list[PriorExchange] | None = None,
                **fields: Any) -> ChatResponse:
    """One turn; ``fields`` are extra ``ChatRequest`` fields (scopes, time_range, case_id)."""
    grants = catalogue_grant_pairs() if grants is None else grants
    ctx = await _context(state, question, grants, **fields)
    return await state.chat_engine.chat(question, state.execution_prefs, tool_context=ctx, origin=origin,
                                        prior_exchanges=prior, case_id=fields.get("case_id"))


def _tool_steps(response: ChatResponse) -> list[Any]:
    return [s for s in response.steps if s.kind == "tool"]


def _shape(response: ChatResponse) -> dict[str, Any]:
    """Everything deterministic about a response (block timestamps are not)."""
    return {
        "answer": response.answer,
        "steps": [(s.tool, s.params, s.status, s.summary) for s in _tool_steps(response)],
        "blocks": [(b.get("id"), b.get("type"), b.get("kind"), b.get("title"), b.get("artifact_kind"))
                   for b in response.blocks],
        "follow_ups": response.follow_ups,
        "citations": [c.id for c in response.citations],
        "links": [link.id for link in response.console_links],
        "answer_kind": response.answer_kind,
    }


def _prior(question: str, response: ChatResponse, index: int) -> PriorExchange:
    return PriorExchange(user=question, answer=response.answer, message_id=f"msg-{index}",
                         steps=tuple(s.model_dump(mode="json") for s in response.steps),
                         blocks=tuple(response.blocks))


def _block(response: ChatResponse, **match: Any) -> dict[str, Any]:
    for block in response.blocks:
        if all(block.get(k) == v for k, v in match.items()):
            return block
    raise AssertionError(f"no block matching {match}: {[(b.get('type'), b.get('title')) for b in response.blocks]}")


async def test_every_demo_starter_runs_a_multi_lookup_turn_deterministically(demo_state) -> None:
    for starter in DEMO_STARTERS:
        first = await _turn(demo_state, starter.prompt)
        second = await _turn(demo_state, starter.prompt)
        steps = _tool_steps(first)
        assert len(steps) >= 2, (starter.id, steps)
        assert all(s.status == "ok" for s in steps), (starter.id, [(s.tool, s.status, s.summary) for s in steps])
        assert {s.tool for s in steps} <= set(starter.tools), starter.id
        assert first.blocks, starter.id
        assert first.notice is None, (starter.id, first.notice)
        assert first.answer_kind == EXPECTED_KIND[starter.id]
        assert len(first.follow_ups) == 3 and starter.prompt not in first.follow_ups
        # Metered through the ONE gateway: simulated, $0 real pricing (#6, SPEC §1).
        assert first.usage is not None and first.usage.calls >= 2
        assert first.usage.simulated is True and first.usage.pricing_source == "zero"
        assert first.usage.total_tokens > 0
        # Deterministic: the same question over the same data gives the same bytes.
        assert _shape(first) == _shape(second), starter.id


async def test_starter_blocks_carry_the_numbers_the_answer_states(demo_state) -> None:
    posture = await _turn(demo_state, STARTERS["posture"].prompt)
    kpis = _block(posture, type="kpi_group")
    ari = next(i for i in kpis["items"] if i["key"] == "active_risk_index")
    assert ari.get("display") == "gauge" and kpis["provenance"] == "code"
    assert f"**Active Risk Index {int(round(ari['value']))}**" in posture.answer
    line = _block(posture, type="chart", kind="line")
    new_cases = int(round(sum(v for v in line["series"][0]["values"] if v is not None)))
    assert f"{new_cases:,} new and" in posture.answer

    explain = await _turn(demo_state, STARTERS["explain_metric"].prompt)
    funnel = _block(explain, type="chart", kind="funnel")
    ingested = int(round(funnel["series"][0]["values"][0]))
    assert f"{ingested:,} alerts ingested" in explain.answer
    assert explain.citations and all(c.kind == "doc" for c in explain.citations)

    hunt = await _turn(demo_state, STARTERS["hunt"].prompt)
    lookup = next(s for s in _tool_steps(hunt) if s.tool == "lookup_indicator")
    # The indicator came from the case entity (code evidence), so the taint rule let
    # a starter-origin turn look it up (SPEC §4.8.3).
    assert lookup.status == "ok"
    entity = _block(hunt, type="entity", title="Indicator reputation")
    assert f"scores {int(round(entity['risk']))}/100" in hunt.answer
    # The entity card holds the score gauge: no "Reputation figures" row repeats it (D4).
    assert not any(b.get("artifact_kind") == "kpis" for b in hunt.blocks), [b.get("title") for b in hunt.blocks]

    shift = await _turn(demo_state, STARTERS["shift_brief"].prompt)
    brief = _block(shift, type="report")
    assert brief["template"] == "shift"
    assert [s["heading"] for s in brief["sections"]] == ["Summary", "Open work", "Key metrics", "Next steps"]
    headline = next(b for s in brief["sections"] for b in s["blocks"] if b.get("type") == "kpi_group")
    open_cases = next(i for i in headline["items"] if i["key"] == "open")
    assert f"**{int(open_cases['value'])} open case" in shift.answer
    # The brief holds the detail; the prose is its short lead (D5).
    paragraphs = shift.answer.split("\n\n")
    assert len(paragraphs) == 3 and paragraphs[-1] == "The brief below is ready to add to a report."
    attention = next(b for s in brief["sections"] for b in s["blocks"] if b.get("type") == "case_list")
    assert paragraphs[1].startswith(f"Start with `{attention['items'][0]['case_id']}` (")
    assert "Needs attention first" not in shift.answer and "Posture:" not in shift.answer


async def test_live_text_streams_the_final_body_in_word_groups(demo_state) -> None:
    prompt = STARTERS["posture"].prompt
    ctx = await _context(demo_state, prompt, catalogue_grant_pairs())
    deltas: list[str] = []
    done: ChatResponse | None = None
    async for event in demo_state.chat_engine.run_turn(
            prompt, demo_state.execution_prefs, tool_context=ctx, origin="starter", stream_mode="text"):
        if isinstance(event, TextDeltaEvent):
            deltas.append(event.text)
        elif isinstance(event, TurnDoneEvent):
            done = event.response
    assert done is not None and done.stream_mode == "text"
    assert len(deltas) > 3 and "".join(deltas).strip() == done.answer
    assert "---ANSWER---" not in "".join(deltas) and '"action"' not in "".join(deltas)


async def test_a_restricted_role_gets_coherent_answers_from_granted_tools_only(demo_state) -> None:
    grants = frozenset({("cases", "read")})
    ctx = await _context(demo_state, "x", grants)
    granted = set(build_toolbox(ctx).names())
    assert "soc_metrics" not in granted and "log_stats" not in granted
    for starter_id, missing in (("posture", "SOC metrics (needs metrics:view)"),
                                ("investigate", "log statistics (needs sources:read)")):
        prompt = STARTERS[starter_id].prompt
        first = await _turn(demo_state, prompt, grants=grants)
        second = await _turn(demo_state, prompt, grants=grants)
        steps = _tool_steps(first)
        assert steps and {s.tool for s in steps} <= granted, (starter_id, [s.tool for s in steps])
        assert all(s.status == "ok" for s in steps), [(s.tool, s.status) for s in steps]
        assert f"Not available to you in chat: {missing}" in first.answer
        assert first.notice is None and first.blocks
        assert not any(re.search(r"posture|noise|hosts", f, re.I) for f in first.follow_ups)
        assert _shape(first) == _shape(second)


async def test_follow_ups_reuse_the_replayed_digest_and_stored_blocks(demo_state) -> None:
    questions = ["Which hosts generated the most events in the last 7 days?",
                 "Break that down by user instead",
                 "Show that as a table",
                 "Same for the last 48 hours"]
    prior: list[PriorExchange] = []
    responses: list[ChatResponse] = []
    for index, question in enumerate(questions):
        response = await _turn(demo_state, question, origin="user", prior=list(prior))
        responses.append(response)
        prior.append(_prior(question, response, index))
    hosts, by_user, as_table, rerun = responses
    assert [(s.tool, s.params["group_by"]) for s in _tool_steps(hosts)] == [("log_stats", "host")]
    (regroup,) = _tool_steps(by_user)
    assert regroup.params["group_by"] == "user" and regroup.params["time_from"] == "now-7d"
    assert "Re-ran the earlier lookup grouped by user (same filters)." in by_user.answer
    # "as a table" re-views a stored block: no lookup, no new number.
    assert _tool_steps(as_table) == []
    assert as_table.blocks and as_table.blocks[0]["type"] == "table"
    assert "No new lookup was needed" in as_table.answer
    (again,) = _tool_steps(rerun)
    assert again.tool == "log_stats" and again.params["time_from"] == "now-2d"
    assert again.params["group_by"] == "user"


async def test_report_summary_runs_through_the_demo_gateway_deterministically(demo_state) -> None:
    from app.engine.report_digest import report_summary_messages
    from app.models import Report

    posture = await _turn(demo_state, STARTERS["posture"].prompt)
    source = {"conversation_id": "conv-1", "message_id": "msg-1"}
    report = Report.model_validate({
        "id": "rep-1", "owner": "alice", "title": "Posture check", "template": "posture",
        "items": [{"id": f"it-{i}", "kind": "block", "block": block, "source": source,
                   "scope": {"window": "last 24h", "demo": True}}
                  for i, block in enumerate(posture.blocks, start=1)]})
    messages = report_summary_messages(report)
    gateway = demo_state.chat_engine._gateway
    first = await gateway.complete(Role.CHAT, messages, demo_state.execution_prefs.chat_model, surface="report")
    second = await gateway.complete(Role.CHAT, messages, demo_state.execution_prefs.chat_model, surface="report")
    assert first.text == second.text and first.pricing_source == "zero"
    summary, steps = parse_report_summary(first.text)
    assert summary.startswith("This posture report holds 3 items")
    assert "The items come from Demo Mode's synthetic data." in summary
    assert 1 <= len(steps) <= 5


SWEEP = (
    ("Any brute force or failed sign-ins today?", "brute"),
    ("Which users generated the most events in the last 7 days?", "top"),
    ("What did AI spend look like in the last 24 hours?", "cost"),
    ("Are any log sources silent?", "sources"),
    ("Which campaigns are open?", "campaigns"),
    ("Summarise today's true positives", "tp"),
    ("Show the noise reduction funnel", "noise"),
    ("What is ATT&CK technique T1110, and how often do we see it?", "mitre"),
    ("Hunt for 203.0.113.93 across logs, cases and threat intel.", "hunt"),
    ("Why was case demo-00000539-0001 closed?", "case"),
    ("Close case demo-00000539-0001", "change"),
    ("Tell me something interesting", "fallback"),
    ("Build a posture report with these sections: Summary, Key metrics, Trends, Noise reduction, Next steps.",
     "posture"),
    ("List the user accounts and their roles", "unsupported"),
    ("Remember that 10.20.0.0/16 is our corporate network", "remember"),
    ("What is our ATT&CK coverage?", "metric"),
    ("Are there pending approvals?", "automation"),
    ("Show the audit trail for the last day", "audit"),
    ("Which runbooks cover brute force?", "knowledge"),
    ("How many open critical cases are there?", "cases"),
    ("What are MTTA and MTTR, and what are ours?", "explain_metric"),
    ("What version is this deployment and is Demo Mode on?", "help"),
    ("What are the top source IPs?", "top"),
    ("What is a true positive?", "help"),
    ("Can we see brute force attempts?", "brute"),
    ("Build a hunt report on lateral movement", "pivot"),
    ("Search logs for zzqq-no-such-thing", "logs"),
    # The grouping named after the window is kept (user, not the default host).
    ("How many events mention sql in the last 7 days by user?", "log_count"),
)


_MACHINE_TITLE_CHIP = re.compile(r"`(?:user|ip|host|domain|url|hash|file_hash|process|email):[^`]* — [^`]*`")


async def test_answers_name_things_by_human_names_and_never_show_an_empty_block(demo_state) -> None:
    """Browser-QA D3/D6 over real demo data: no composite ``kind:value — rule`` title
    and no campaign content-hash id in the narration (both stay in blocks and
    links), and no block without rows, points or items."""
    from app.agents.blocks import is_empty_block, iter_leaf_blocks

    questions = [s.prompt for s in DEMO_STARTERS] + [q for q, _intent in SWEEP] + [
        "Hunt for 198.51.100.77 across logs, cases and threat intel."]
    for question in questions:
        response = await _turn(demo_state, question, origin="user")
        assert not _MACHINE_TITLE_CHIP.search(response.answer), (question, response.answer)
        assert not re.search(r"campaign-[0-9a-f]{16,}", response.answer), (question, response.answer)
        empty = [b.get("title") for b in iter_leaf_blocks(response.blocks) if is_empty_block(b)]
        assert not empty, (question, empty)
    camps = await _turn(demo_state, "Which campaigns are open?", origin="user")
    assert " sharing user `" in camps.answer or " sharing IP `" in camps.answer, camps.answer


async def test_report_answers_are_a_short_lead_with_the_detail_in_the_report(demo_state) -> None:
    """D5: a final that carries a report envelope keeps its prose to the lead (at
    most three paragraphs, closing with the ready sentence)."""
    for question in ("Build a posture report with these sections: Summary, Key metrics, Trends, Noise reduction, "
                     "Next steps.", "Give me a report on case demo-00000539-0004",
                     "Build a hunt report on lateral movement", STARTERS["shift_brief"].prompt):
        response = await _turn(demo_state, question, origin="user")
        assert any(b.get("type") == "report" for b in response.blocks), question
        paragraphs = [p for p in response.answer.split("\n\n") if p.strip()]
        assert 2 <= len(paragraphs) <= 3, (question, paragraphs)
        assert paragraphs[-1] in ("The report below is ready to add to your Reports.",
                                  "The brief below is ready to add to a report."), question
        assert not any(p.lstrip().startswith("- ") for p in paragraphs), question


async def test_report_leads_say_the_headline_and_name_the_case(demo_state) -> None:
    """D5/D6: a behaviour hunt report leads with what the hunt found (the reputation
    and what the sightings mean), and a case report names the case by what happened."""
    from app.agents.blocks import iter_leaf_blocks

    hunt = await _turn(demo_state, "Build a hunt report on lateral movement", origin="user")
    entity = next(b for b in iter_leaf_blocks(hunt.blocks) if b.get("type") == "entity")
    anchor, found = hunt.answer.split("\n\n")[:2]
    assert anchor.startswith("The question names no indicator") and "Name an indicator" in anchor
    assert f"scores {int(round(entity['risk']))}/100" in found and "It is quiet in the logs" in found
    case = await _turn(demo_state, "Give me a report on case demo-00000539-0004", origin="user")
    assert re.match(r"\*\*`demo-00000539-0004`\*\* \([a-z ]+ on user `[^`]+`\) has a needs-human verdict",
                    case.answer), case.answer


@pytest.mark.parametrize("question", ["Build a posture report", "Build a noise reduction report"])
async def test_a_report_under_a_restricted_role_keeps_its_disclosures(demo_state, question) -> None:
    """A report built from what a role CAN read still says what it lacks and how to
    get it (the blocker of the wave-5 review), and still ends with the ready sentence."""
    grants = frozenset(g for g in catalogue_grant_pairs() if g != ("metrics", "view"))
    response = await _turn(demo_state, question, grants=grants, origin="user")
    report = _block(response, type="report")
    paragraphs = response.answer.split("\n\n")
    assert paragraphs[0].startswith("Not available to you in chat: SOC metrics (needs metrics:view)")
    assert "Ask an administrator for access, or open the matching console page." in paragraphs
    assert paragraphs[-1] == "The report below is ready to add to your Reports."
    summary = next(b for s in report["sections"] for b in s["blocks"] if b.get("type") == "markdown")
    assert "needs metrics:view" in summary["text"]


async def test_the_ready_sentence_ends_a_report_after_the_window_note(demo_state) -> None:
    response = await _turn(demo_state, "Build a posture report", origin="user",
                           time_range={"from": "now-1h", "to": "now"})
    assert _block(response, type="report")
    paragraphs = response.answer.split("\n\n")
    assert paragraphs[-2] == "Window: the last 1h you selected applies to the windowed lookups above."
    assert paragraphs[-1] == "The report below is ready to add to your Reports."


async def test_every_intent_answers_over_demo_data_without_the_safe_fallback(demo_state) -> None:
    """``plan_turn`` turns any planner exception into a safe final; this sweep proves
    no intent hits it over real demo data (and that each answer is well formed)."""
    from app.engine.demo_chat import _SAFE_FINAL, classify

    safe_text = _SAFE_FINAL.split("---ANSWER---\n", 1)[1]
    for question, intent in SWEEP:
        assert classify(question).intent == intent, question
        response = await _turn(demo_state, question, origin="user")
        assert response.answer and safe_text not in response.answer, question
        assert all(s.status == "ok" for s in _tool_steps(response)), (question, [
            (s.tool, s.status, s.summary) for s in _tool_steps(response)])
        assert len(response.follow_ups) <= 3
        assert response.usage is not None and response.usage.simulated, question
        if intent == "remember":
            assert response.memory_proposal is not None and response.memory_proposal.op == "add"
        if intent in ("unsupported",):
            assert response.notice is not None and response.notice.kind == "unsupported"


async def test_case_manager_chat_answers_about_its_case(demo_state) -> None:
    case_id = "demo-00000539-0001"
    question = "Why was this closed, and what does the evidence say?"
    builder = demo_state.build_chat_tool_context
    ctx = await builder(_request(demo_state), ChatRequest(message=question, case_id=case_id),
                        grants=catalogue_grant_pairs())
    assert ctx.case_id == case_id
    response = await demo_state.chat_engine.chat(question, demo_state.execution_prefs, case_id=case_id,
                                                 tool_context=ctx, origin="user")
    tools = [(s.tool, s.status) for s in _tool_steps(response)]
    assert ("get_case", "ok") in tools and ("explain_decision", "ok") in tools
    # The id is the handle and the machine title reads as what happened to which entity (D6).
    assert re.match(rf"\*\*`{case_id}`\*\* \([a-z ]+ on [A-Za-z ]+ `[^`]+`\) is a true positive", response.answer), (
        response.answer)
    assert "How the policy sees it:" in response.answer
    assert response.case_id == case_id


# --------------------------------------------------------------------------- #
# Review fixes, end to end over the Demo stack.
# --------------------------------------------------------------------------- #
async def test_an_unknown_indicator_hunt_does_not_invent_a_case(demo_state) -> None:
    response = await _turn(demo_state, "Hunt for 198.51.100.77 across logs, cases and threat intel.", origin="user")
    assert "No case has it as its entity." in response.answer
    assert "single case" not in response.answer and "containment in place" not in response.answer
    assert ("Nothing in the logs or the case store links it to activity here, so the reputation result above is "
            "the only signal") in response.answer


async def test_an_explicit_log_search_runs_a_log_lookup_not_a_case_search(demo_state) -> None:
    """Browser-QA (wave 6, B5): "Search logs for X" was answered with a case search."""
    response = await _turn(demo_state, "Search logs for zzqq-no-such-thing", origin="user")
    assert [(s.tool, s.params, s.status) for s in _tool_steps(response)] == [
        ("search_logs", {"contains": "zzqq-no-such-thing"}, "ok")]
    assert response.answer.startswith("No log events match `zzqq-no-such-thing` in the last 24h")
    assert response.blocks == [] and "case" not in response.answer.lower()

    found = await _turn(demo_state, "Search logs for sql in the last 7 days", origin="user")
    assert [(s.tool, s.status) for s in _tool_steps(found)] == [("search_logs", "ok")]
    assert re.match(r"\*\*\d+ log events?\*\* match `sql` in the last 7d", found.answer), found.answer
    assert _block(found, type="table", title="Matching log events")
    # The breakdown follow-up regroups the same search (same text filter and window).
    question = "Break that down by user instead"
    assert question in found.follow_ups
    regrouped = await _turn(demo_state, question, origin="user",
                            prior=[_prior("Search logs for sql in the last 7 days", found, 1)])
    (step,) = _tool_steps(regrouped)
    assert step.tool == "log_stats" and step.status == "ok"
    assert step.params["contains"] == "sql" and step.params["group_by"] in ("user", ["user"])
    # The re-run names the searched text as written, never the raw filter key.
    assert re.search(r"\*\*\d+ events?\*\* matching `sql` in the last 7d", regrouped.answer), regrouped.answer
    assert "contains `" not in regrouped.answer
    # Nothing matched: the longer window is offered, and its re-run reads the same way.
    question = "Same for the last 7 days"
    assert response.follow_ups[0] == question
    wider = await _turn(demo_state, question, origin="user",
                        prior=[_prior("Search logs for zzqq-no-such-thing", response, 1)])
    assert [(s.tool, s.params.get("contains"), s.status) for s in _tool_steps(wider)] == [
        ("search_logs", "zzqq-no-such-thing", "ok")]
    assert "No log events match `zzqq-no-such-thing` in the last 7d" in wider.answer, wider.answer
    assert "contains `" not in wider.answer
    again = await _turn(demo_state, "Search logs for zzqq-no-such-thing", origin="user")
    assert _shape(again) == _shape(response)                         # deterministic


async def test_case_chat_references_to_its_entities_are_case_questions(demo_state) -> None:
    """Review (wave 6): "Show me the logs for this host" in the Case Manager chat is
    about the case's own host, never a text search for "this host"."""
    case_id = "demo-00000539-0004"
    for question in ("Show me the logs for this host", "Search logs for the attacker IP",
                     "Show me the events for that user"):
        response = await _turn(demo_state, question, origin="user", case_id=case_id)
        tools = [(s.tool, s.params.get("contains"), s.status) for s in _tool_steps(response)]
        assert ("get_case", None, "ok") in tools, (question, tools)
        assert not any(t == "search_logs" for t, _contains, _status in tools), (question, tools)
        assert "No log events match" not in response.answer, (question, response.answer)


async def test_a_report_on_a_case_materialises_and_case_manager_reports_do_not(demo_state) -> None:
    case_id = "demo-00000539-0004"
    workspace = await _turn(demo_state, f"Give me a report on case {case_id}", origin="user")
    report = _block(workspace, type="report")
    assert report["template"] == "investigation" and report["sections"]
    assert not any(b.get("type") == "callout" for b in workspace.blocks)
    assert workspace.answer.endswith("The report below is ready to add to your Reports.")

    case_chat = await _turn(demo_state, "Write a report for this case", origin="user", case_id=case_id)
    assert case_chat.blocks and not any(b.get("type") == "report" for b in case_chat.blocks)
    assert "ready to add" not in case_chat.answer
    assert "Case conversations cannot be added to Reports." in case_chat.answer


async def test_the_users_window_wins_over_the_chip_and_the_answer_says_so(demo_state) -> None:
    response = await _turn(demo_state, "Which hosts generated the most events in the last 24 hours?",
                           origin="user", time_range={"from": "now-7d"})
    (step,) = _tool_steps(response)
    assert step.params["time_from"] == "now-24h"
    assert "in the last 24h" in response.answer
    assert response.answer.endswith("Window: your question named the last 24 hours, so the lookups used that "
                                    "window instead of the last 7d you selected.")
    narrower = await _turn(demo_state, "Which hosts generated the most events in the last 7 days?",
                           origin="user", time_range={"from": "now-6h"})
    assert "so it was limited to the last 6h" in narrower.answer


async def test_scopes_are_reported_as_scopes_not_as_missing_permissions(demo_state) -> None:
    posture = await _turn(demo_state, STARTERS["posture"].prompt, scopes=["cases"])
    assert {s.tool for s in _tool_steps(posture)} <= {"search_cases", "get_case", "shift_report", "list_campaigns",
                                                       "explain_decision"}
    assert posture.answer.startswith("Outside the scopes you selected (Cases): SOC metrics")
    assert "Not available to you" not in posture.answer and "administrator" not in posture.answer
    brief = await _turn(demo_state, "/shift-brief", origin="user", scopes=["metrics"])
    envelope = _block(brief, type="report")
    steps = next(b for s in envelope["sections"] if s["heading"] == "Next steps" for b in s["blocks"])
    assert "No open work needs attention" not in str(steps)
    assert "The shift snapshot was not read for this question" in str(steps)


@pytest.mark.parametrize("topic_id", ["kpi:total_cases", "kpi:human_vs_ai", "kpi:llm_spend", "settings:sessions",
                                      "settings:keys", "settings:standup", "settings:notifications"])
async def test_ask_about_this_topic_questions_are_answered_from_the_help_center(demo_state, topic_id) -> None:
    from app.knowledge import get_app_knowledge

    question = get_app_knowledge().topics[topic_id].question
    response = await _turn(demo_state, question)          # topic questions are sent with origin "starter"
    tools = [s.tool for s in _tool_steps(response)]
    assert tools and tools[0] == "app_help", (topic_id, tools)
    assert not {"shift_report", "search_cases"} & set(tools), (topic_id, tools)
    assert response.notice is None, (topic_id, response.notice)
    assert response.answer_kind in ("product_help", "mixed"), topic_id
    assert response.citations, topic_id
