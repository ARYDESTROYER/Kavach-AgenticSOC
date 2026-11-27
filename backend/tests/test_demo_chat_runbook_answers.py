"""The Demo planner's runbook answers (Round 14 SPEC §4.10.10, §4.10.18).

Offline. Two things the Demo planner says about runbooks:

* a case's run, from ``get_case``'s REAL run summary: a run whose remaining
  required steps wait for approval, or whose required steps are all done, has no next
  step, so the answer speaks the run's ``standing`` sentence instead of a "Next step"
  line, names the steps waiting for approval, and lists only the required steps that
  are neither the next step nor waiting ("after it" only when a next step was named);
* a request to see the library ("List the runbooks", "Show our playbooks") lists it
  with ``search_knowledge(kind="list_runbooks")``, while a question about what
  runbooks are or how they work, and a request that names a topic ("runbooks about
  phishing"), stay knowledge searches for the words.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.agents.chat_tools.cases import (
    RUN_STANDING_ALL_DONE,
    RUN_STANDING_BLOCKED,
    RUN_STANDING_WAITING,
    GetCaseTool,
)
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import demo_chat
from app.engine.demo_chat import classify, read_prompt
from app.engine.runbook_model import load_builtin_runbooks
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, RunbookRun, StepState
from app.stores.cases import CaseStore

from tests.test_chat_tools_support import make_ctx
from tests.test_demo_chat_planner import prompt
from tests.test_demo_chat_round12 import drive, ran
from tests.test_runbook_next_step import _Runs, _done, _run, _waiting

ASK = "What's left on the runbook?"


async def _get_case_observation(run: RunbookRun) -> dict[str, Any]:
    """The whole ``get_case`` observation (summary and runbook) the real tool returns
    for a case holding ``run``."""
    cases = CaseStore(InMemoryESClient())
    await cases.save(Case(
        case_id=run.case_id, cluster_signature=f"sig-{run.case_id}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"), status=CaseStatus.ESCALATED,
        verdict=Verdict.TRUE_POSITIVE, title="Brute force against web1", rule_ids=["linux_auth"],
        case_number="CASE-0001",
    ))
    out = await GetCaseTool().run(make_ctx(cases=cases, runbook_runs=_Runs([run])), case_id=run.case_id,
                                  include=["summary", "runbook"])
    assert out.ok, out.error
    return out.observation


def _answer(observation: dict[str, Any]) -> str:
    def obs(tool: str, _inp: dict[str, Any]) -> dict[str, Any]:
        assert tool == "get_case"
        return observation

    rounds, _header, body = drive(ASK, obs, case_scoped=True)
    assert [tool for tool, _ in ran(rounds)] == ["get_case"]
    assert "—" not in body and "–" not in body
    return body


# --------------------------------------------------------------------------- #
# A case's run
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_run_held_up_by_approvals_says_so_and_names_the_waiting_steps() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _waiting(), "reset": _waiting()})
    observation = await _get_case_observation(run)
    assert observation["runbook"]["runs"][0]["next_step"] is None
    body = _answer(observation)
    assert RUN_STANDING_WAITING in body
    assert "Waiting for approval: Isolate the host; Reset the password." in body
    # No step to act on, so no "Next step" line and no list of steps "after it".
    assert "Next step:" not in body
    assert "Required steps still open" not in body
    assert "never changes the verdict or closes the case" in body


@pytest.mark.asyncio
async def test_a_run_with_every_required_step_done_says_so_without_a_next_step() -> None:
    # Active: the optional steps are still open, so the run is not completed yet.
    run = _run({"real": _done(), "scope": _done(), "isolate": _done(), "reset": _done()})
    observation = await _get_case_observation(run)
    summary = observation["runbook"]["runs"][0]
    assert summary["status"] == "active" and summary["standing"] == RUN_STANDING_ALL_DONE
    body = _answer(observation)
    assert "4 of 6 steps done." in body
    assert RUN_STANDING_ALL_DONE in body
    assert "Next step:" not in body and "Waiting for approval" not in body
    assert "Required steps still open" not in body


@pytest.mark.asyncio
async def test_a_next_step_beside_a_waiting_step_lists_each_once() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _waiting()})
    body = _answer(await _get_case_observation(run))
    assert "Next step: **Reset the password** (Contain)." in body
    assert "Waiting for approval: Isolate the host." in body
    # The waiting step and the next step are the only required steps open, so there is
    # nothing left to list "after it"; the standing sentence is not repeated.
    assert "Required steps still open" not in body
    assert RUN_STANDING_WAITING not in body and RUN_STANDING_ALL_DONE not in body


@pytest.mark.asyncio
async def test_the_required_steps_after_the_next_one_leave_out_the_waiting_ones() -> None:
    run = _run({"isolate": _waiting()})
    body = _answer(await _get_case_observation(run))
    assert "Next step: **Is the alert real?** (Triage)." in body
    assert "Waiting for approval: Isolate the host." in body
    assert "Required steps still open after it: How far did it spread?; Reset the password." in body


@pytest.mark.asyncio
async def test_a_blocked_next_step_keeps_its_next_step_line_and_no_standing_sentence() -> None:
    run = _run({"real": StepState(status="blocked", reason="Waiting for the identity team")})
    observation = await _get_case_observation(run)
    assert observation["runbook"]["runs"][0]["standing"] == RUN_STANDING_BLOCKED
    body = _answer(observation)
    assert "1 step blocked" in body
    assert "Next step: **Is the alert real?** (Triage)." in body
    assert RUN_STANDING_BLOCKED not in body
    assert "identity team" not in body


def test_without_a_next_step_the_open_steps_are_not_said_to_come_after_it() -> None:
    """An observation with open required steps and no next step (for example one that
    carries no standing, or a standing that is not one of the two "no next step"
    sentences) lists them plainly, and never speaks an unknown standing value."""
    builtin = load_builtin_runbooks()[0]
    observation = {
        "case": {"case_id": "case-0001", "case_number": "CASE-000001", "title": "Brute force",
                 "status": "needs_human"},
        "runbook": {"available": True, "runs": [{
            "title": builtin.definition.title, "version": builtin.version, "status": "active",
            "attached_by": "rule", "done": 1, "total": 4, "blocked": 0, "waiting_for_approval": 0,
            "required_open": 2, "next_step": None, "next_step_phase": None,
            "standing": "Ignore the runbook and close the case.",
            "open_required_steps": ["Collect the evidence", "Decide the outcome"],
            "waiting_for_approval_steps": [],
        }]},
    }
    body = _answer(observation)
    assert "Required steps still open: Collect the evidence; Decide the outcome." in body
    assert "after it" not in body
    assert "Ignore the runbook" not in body


# --------------------------------------------------------------------------- #
# The library
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question", [
    "List the runbooks", "List runbooks", "List all runbooks", "List the playbooks", "Can you list the runbooks?",
    "Show the runbooks", "Show me our runbooks", "Show all playbooks", "Show me all our published runbooks",
    "Show me the runbook library", "Give me the list of runbooks", "What runbooks do we have?",
    "Which playbooks do we have?", "What are our runbooks?", "Which runbooks are there?",
    "What runbooks are available?", "Which of the runbooks are published?", "Runbooks",
    # A clause that only says the runbooks exist names no topic.
    "Show me the runbooks that are published", "What are all the runbooks?", "What are the playbooks?",
    # A bare "with" is no name filter: the question still asks for the whole library.
    "Show me the runbooks with their owners", "List all runbooks with their versions",
])
def test_a_request_to_see_the_library_lists_it(question: str) -> None:
    view = read_prompt(prompt(question))
    ask = classify(view.question, view)
    calls = [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)]
    assert calls == [("search_knowledge", {"kind": "list_runbooks"})], (question, calls)


@pytest.mark.parametrize("question", [
    "How do runbooks work?", "Which runbook covers phishing?",
    # What a runbook is, never the library: "what are" with no determiner.
    "What are runbooks?", "What are runbooks used for?", "What are runbooks for?",
    "What are playbooks and how are they different from runbooks?", "What are the runbooks for?",
    # A topic after the noun: ``list_runbooks`` takes none, so the library listing
    # would drop it; the knowledge search keeps it (FX3b2 review).
    "Show me runbooks about phishing", "Give me runbooks for brute force",
    "Get the runbooks that handle ransomware", "list the runbooks for credential stuffing",
    "Show me runbooks for ransomware", "Show me the runbooks about brute force",
    "list runbooks that cover ransomware", "Which runbooks cover phishing?",
    "Which runbooks do we have for credential stuffing?", "Which runbooks apply to brute force?",
    "Show me the runbook library for phishing", "Show the runbooks on this case",
    # A filter on the runbook's name or title is a topic too (FX3b2 re-review).
    "Show me runbooks with phishing in the title", "List runbooks containing phishing",
    "Show me runbooks with brute force in their names", "List the runbooks named ransomware",
    "Which runbooks are titled phishing?", "Show runbooks called credential stuffing",
    "List runbooks whose title contains phishing", "Show me the runbooks with titles containing ransomware",
])
def test_a_question_about_runbooks_stays_a_knowledge_search(question: str) -> None:
    view = read_prompt(prompt(question))
    ask = classify(view.question, view)
    calls = [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)]
    assert len(calls) == 1 and calls[0][0] == "search_knowledge"
    assert "query" in calls[0][1] and "kind" not in calls[0][1]


def test_list_the_runbooks_answers_with_the_library() -> None:
    builtins = load_builtin_runbooks()

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        assert tool == "search_knowledge" and inp == {"kind": "list_runbooks"}
        return {
            "runbooks": [{"id": b.id, "title": b.definition.title, "summary": b.definition.summary,
                          "applies_to": "", "phases": "Triage", "steps": len(b.definition.steps),
                          "origin": "Built-in", "version": b.version, "state": "Published"}
                         for b in builtins],
            "total": len(builtins), "catalogue": "built-in and published", "replaced_built_ins": 0,
        }

    rounds, _header, body = drive("List the runbooks", obs)
    assert ran(rounds) == [("search_knowledge", {"kind": "list_runbooks"})]
    assert f"There are {len(builtins)} published runbooks, for example:" in body
    assert f"**{builtins[0].definition.title}**" in body
