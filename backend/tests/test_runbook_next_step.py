"""The Next step of a runbook run is one rule across the suite (Round 14 SPEC
§4.10.7, §4.10.10, §4.10.11).

``engine.runbook_runs.next_step`` names the step the Console's Next step card shows
(``webui/src/soc/runbooks/run/model.ts`` ``nextStep``): the first REQUIRED step in
reading order that is not Done or Not applicable and not waiting for approval; none
on an abandoned run and none when no required step is left to act on. Case chat's
``get_case`` reads it, so its run summary words a finished run, or one whose
remaining required steps wait for approval, truthfully: no next step, and a fixed
``standing`` sentence that matches the card's own words.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.agents.chat_tools.cases import (
    RUN_STANDING_ABANDONED,
    RUN_STANDING_ALL_DONE,
    RUN_STANDING_BLOCKED,
    RUN_STANDING_IN_PROGRESS,
    RUN_STANDING_TO_DO,
    RUN_STANDING_WAITING,
    GetCaseTool,
    run_standing,
)
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import runbook_runs as R
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, RunbookDefinition, RunbookRun, RunbookStep, StepState
from app.stores.cases import CaseStore

from tests.test_chat_tools_support import assert_observation_whitelisted, make_ctx

PENDING = {"required_role": "incident_lead", "status": "pending", "by": None, "at": None, "reason": None}
APPROVED = {"required_role": "incident_lead", "status": "approved", "by": "ben", "at": "2026-10-28T11:00:00Z",
            "reason": None}


def _definition() -> RunbookDefinition:
    """Steps written out of reading order on purpose: the phase order decides (Triage,
    Contain, Close), then the order as written. ``triage-note`` is optional and comes
    first, so an optional step is never mistaken for the next one."""
    return RunbookDefinition(
        id="next-step-rule", title="Next step rule runbook", summary="A runbook for tests.",
        phases=["triage", "contain", "close"],
        steps=[
            RunbookStep(id="isolate", phase="contain", kind="action", title="Isolate the host",
                        approval_role="incident_lead"),
            RunbookStep(id="triage-note", phase="triage", kind="record", title="Write a first note",
                        required=False),
            RunbookStep(id="real", phase="triage", kind="check", title="Is the alert real?"),
            RunbookStep(id="scope", phase="triage", kind="check", title="How far did it spread?"),
            RunbookStep(id="tell-owner", phase="close", kind="record", title="Tell the owner", required=False),
            RunbookStep(id="reset", phase="contain", kind="action", title="Reset the password",
                        approval_role="incident_lead"),
        ],
    )


def _run(steps: dict[str, StepState] | None = None, *, status: str = "active", case_id: str = "case-0001",
         run_id: str = "run-1") -> RunbookRun:
    definition = _definition()
    states = {step.id: StepState() for step in definition.steps}
    states.update(steps or {})
    return RunbookRun(
        run_id=run_id, case_id=case_id, runbook_id=definition.id, version=3, title=definition.title,
        snapshot=definition, attached_by="rule", status=status, steps=states,  # type: ignore[arg-type]
    )


def _done() -> StepState:
    return StepState(status="done", completed_by="asha", completed_at="2026-10-28T10:30:00Z")


def _waiting() -> StepState:
    """A recorded action whose approval is pending (stored as in progress)."""
    return StepState(status="in_progress", started_at="2026-10-28T10:40:00Z",
                     action_record={"performed_by": "asha", "performed_at": "2026-10-28T10:39:00Z",
                                    "where": "EDR console", "outcome": "Host isolated"},
                     approval=dict(PENDING))


def _next_id(run: RunbookRun) -> str | None:
    step = R.next_step(run)
    return step.id if step is not None else None


# --------------------------------------------------------------------------- #
# The shared rule
# --------------------------------------------------------------------------- #
def test_an_untouched_run_starts_at_the_first_required_step_in_reading_order() -> None:
    # "Write a first note" comes first in reading order, but it is optional.
    assert _next_id(_run()) == "real"


def test_finished_steps_are_passed_over_in_reading_order() -> None:
    run = _run({"real": _done(), "scope": StepState(status="not_applicable", reason="Single host")})
    # Contain is next in the runbook's phase order, and "isolate" is written first.
    assert _next_id(run) == "isolate"


def test_a_step_waiting_for_approval_is_never_next() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _waiting()})
    assert _next_id(run) == "reset"


def test_an_approved_step_is_finished_like_any_done_step() -> None:
    approved = _done().model_copy(update={"approval": dict(APPROVED)})
    run = _run({"real": _done(), "scope": _done(), "isolate": approved})
    assert _next_id(run) == "reset"


def test_no_next_step_when_the_remaining_required_steps_wait_for_approval() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _waiting(), "reset": _waiting()})
    assert R.run_progress(run).required_open == 2 and R.run_progress(run).waiting == 2
    assert R.next_step(run) is None


def test_no_next_step_when_every_required_step_is_done_even_with_optional_steps_left() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _done(), "reset": _done()}, status="completed")
    assert R.run_progress(run).required_open == 0
    # "Write a first note" and "Tell the owner" are still open, but optional.
    assert R.next_step(run) is None


def test_a_blocked_required_step_is_still_next() -> None:
    run = _run({"real": StepState(status="blocked", reason="Waiting for the identity team")})
    assert _next_id(run) == "real"


def test_an_abandoned_run_has_no_next_step() -> None:
    assert R.next_step(_run(status="abandoned")) is None


def test_the_run_summary_for_case_chat_reads_the_same_rule() -> None:
    waiting = _run({"real": _done(), "scope": _done(), "isolate": _waiting(), "reset": _waiting()}, run_id="run-w")
    complete = _run({"real": _done(), "scope": _done(), "isolate": _done(), "reset": _done()},
                    status="completed", run_id="run-c")
    started = _run({"real": _done()}, run_id="run-s")
    by_order = R.run_summary([waiting, complete, started])
    assert by_order[0]["next_step"] is None and by_order[0]["required_open"] == 2
    assert by_order[1]["next_step"] is None and by_order[1]["status"] == "completed"
    assert by_order[2]["next_step"] == "How far did it spread?"


# --------------------------------------------------------------------------- #
# Where a run stands, in Case chat's words
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("steps", "status", "expected"), [
    ({}, "active", RUN_STANDING_TO_DO),
    # A note starts a step (``started_at``) while its status stays To do: the sentence
    # still holds, and it never claims the step was not started.
    ({"real": StepState(status="todo", note="Checking", started_at="2026-10-28T10:05:00Z")}, "active",
     RUN_STANDING_TO_DO),
    ({"real": StepState(status="in_progress", note="Checking", started_at="2026-10-28T10:10:00Z")}, "active",
     RUN_STANDING_IN_PROGRESS),
    ({"real": StepState(status="blocked", reason="Waiting for the identity team")}, "active", RUN_STANDING_BLOCKED),
    ({"real": _done(), "scope": _done(), "isolate": _waiting(), "reset": _waiting()}, "active",
     RUN_STANDING_WAITING),
    ({"real": _done(), "scope": _done(), "isolate": _done(), "reset": _done()}, "completed", RUN_STANDING_ALL_DONE),
    ({}, "abandoned", RUN_STANDING_ABANDONED),
])
def test_run_standing_words_every_state_from_the_shared_rule(steps: dict[str, StepState], status: str,
                                                             expected: str) -> None:
    run = _run(steps, status=status)
    assert run_standing(run, R.next_step(run), R.run_progress(run).required_open) == expected


def test_the_standing_sentences_are_the_console_card_words() -> None:
    """The two sentences of a run with no step to act on are the Next step card's own
    (``NextStepCard`` ``NothingNext``): chat and the card never disagree."""
    assert RUN_STANDING_ALL_DONE == "All required steps are done."
    assert RUN_STANDING_WAITING == "The remaining required steps wait for approval."
    # "To do" is the card's status word; a To do step may already carry a note, so the
    # sentence never says it was not started.
    assert RUN_STANDING_TO_DO == "The next required step is still to do."
    for sentence in (RUN_STANDING_ALL_DONE, RUN_STANDING_WAITING, RUN_STANDING_BLOCKED,
                     RUN_STANDING_IN_PROGRESS, RUN_STANDING_TO_DO, RUN_STANDING_ABANDONED):
        assert "\u2014" not in sentence and sentence.endswith(".")


# --------------------------------------------------------------------------- #
# Case chat's get_case
# --------------------------------------------------------------------------- #
class _Runs:
    """The run store's ``get`` (``stores.runbook_runs.RunbookRunStore``)."""

    def __init__(self, runs: list[RunbookRun]) -> None:
        self.runs = runs

    async def get(self, case_id: str):
        from app.stores.runbook_runs import CaseRuns

        return CaseRuns(case_id=case_id, runs=tuple(r for r in self.runs if r.case_id == case_id), revision=1)


async def _get_case_runbook(run: RunbookRun) -> dict[str, Any]:
    cases = CaseStore(InMemoryESClient())
    await cases.save(Case(
        case_id=run.case_id, cluster_signature=f"sig-{run.case_id}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"), status=CaseStatus.ESCALATED,
        verdict=Verdict.TRUE_POSITIVE, title="Brute force against web1", rule_ids=["linux_auth"],
        case_number="CASE-0001",
    ))
    out = await GetCaseTool().run(make_ctx(cases=cases, runbook_runs=_Runs([run])), case_id=run.case_id,
                                  include=["summary", "runbook"])
    assert out.ok
    assert_observation_whitelisted(out)
    section = out.observation["runbook"]
    assert section["available"] is True and len(section["runs"]) == 1
    return section["runs"][0]


async def test_get_case_words_a_completed_run_as_finished_with_no_next_step() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _done(), "reset": _done()}, status="completed")
    summary = await _get_case_runbook(run)
    assert summary["status"] == "completed"
    assert summary["next_step"] is None and summary["next_step_phase"] is None
    assert summary["standing"] == RUN_STANDING_ALL_DONE
    assert summary["required_open"] == 0 and summary["open_required_steps"] == []
    assert summary["waiting_for_approval_steps"] == []
    assert summary["progress"] == "4/6"


async def test_get_case_skips_a_step_waiting_for_approval() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _waiting()})
    summary = await _get_case_runbook(run)
    assert summary["next_step"] == "Reset the password" and summary["next_step_phase"] == "Contain"
    assert summary["standing"] == RUN_STANDING_TO_DO
    assert summary["waiting_for_approval"] == 1
    assert summary["waiting_for_approval_steps"] == ["Isolate the host"]
    # Still open and required, so it is listed with the open steps too.
    assert summary["open_required_steps"] == ["Isolate the host", "Reset the password"]
    assert summary["progress"] == "2/6 · 1 waiting"


async def test_get_case_words_a_run_held_up_by_approvals_with_no_next_step() -> None:
    run = _run({"real": _done(), "scope": _done(), "isolate": _waiting(), "reset": _waiting()})
    summary = await _get_case_runbook(run)
    assert summary["status"] == "active"
    assert summary["next_step"] is None and summary["next_step_phase"] is None
    assert summary["standing"] == RUN_STANDING_WAITING
    assert summary["required_open"] == 2
    assert summary["waiting_for_approval_steps"] == ["Isolate the host", "Reset the password"]


async def test_get_case_says_when_the_next_step_is_blocked() -> None:
    run = _run({"real": StepState(status="blocked", reason="Waiting for the identity team")})
    summary = await _get_case_runbook(run)
    assert summary["next_step"] == "Is the alert real?" and summary["next_step_phase"] == "Triage"
    assert summary["standing"] == RUN_STANDING_BLOCKED
    assert summary["blocked"] == 1
    # The reason is a person's text: it stays out of the summary.
    assert "identity team" not in str(summary)
