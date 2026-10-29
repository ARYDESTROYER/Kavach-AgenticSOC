"""Demo Mode plays the model for the AI's help on runbooks (Round 14 SPEC §4.10.10,
§3.5): "Suggest a runbook" and "Draft note" are answered by the deterministic
``engine.runbook_runs.demo_runbook_ai_answer`` through the Demo provider, never by the
generic Demo chat answer.

The call is real: it goes through the one gateway (#6) and is ledgered on the
``runbook`` surface at $0 like every Demo call (``pricing_source: zero``). Nothing here patches the gateway or the
provider; only the lookups are stubbed so a run has results to draft from.

The provider route is also pinned on its own: only a runbook system marker routes to
the runbook answer, a marker text placed in a user message never does (only the system
prompt, which no user or log value can author, is read), and a failure of the runbook
answer degrades to a fixed answer that still fits the marker (a suggestion with no
runbook, a neutral Demo draft), never to the generic Demo answer and never to a failed
call. The wording of the builder's answers is pinned by its owner
(``tests/test_runbook_ai_calls.py``); these tests pin the route, so they compare with
the builder instead of repeating its copy.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

import pytest

from app.agents.prompts import RUNBOOK_DRAFT_SYSTEM_MARKER, RUNBOOK_SUGGEST_SYSTEM_MARKER
from app.constants import CaseStatus, EntityType, SourceSurface
from app.engine import runbook_runs as R
from app.llm import providers as P
from app.models import Case, Entity, LookupResult
from app.state import AppState

BRUTE = "brute-force-password-spray"


def _case(case_id: str) -> Case:
    return Case(
        case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=["mail_auth"], entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        status=CaseStatus.NEEDS_HUMAN, case_number=f"CASE-{case_id[-3:]}",
    )


@pytest.fixture(autouse=True)
def _lookups_find_seven(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):  # noqa: ANN001, ANN202
        return LookupResult(tool=template.tool, status="ok", count=7, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by, facts=[{"label": "Events", "value": "7"}])

    monkeypatch.setattr(R, "execute_lookup", fake_execute)


async def _runbook_usage(state: AppState, case_id: str) -> list[dict[str, Any]]:
    rows = await state.usage_store.records(limit=200)
    return [r for r in rows if r.get("surface") == "runbook" and r.get("case_id") == case_id]


@pytest.mark.asyncio
async def test_demo_mode_suggests_and_drafts_through_the_gateway_at_no_cost(app_state: AppState) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        case = _case("case-demo-ai")
        await app_state.cases.save(case)

        suggestion = await R.suggest_runbook(app_state, case, actor="asha", dry_run=False, can_see_cost=True)
        assert suggestion.candidate is not None
        assert suggestion.candidate.group == "suggested"
        assert (suggestion.candidate.reason or "").startswith("Demo suggestion:")
        # A suggestion is never attached.
        assert (await app_state.runbook_runs.get(case.case_id)).runs == ()

        attached = await R.attach_by_person(app_state, case, BRUTE, note=None, actor="asha", context=None)
        await R.wait_for_background_lookups(10)
        run = attached.run
        check = next(step for step in run.snapshot.steps if step.kind == "check")
        drafted = await R.draft_step(app_state, case, run.run_id, check.id, actor="asha", context=None,
                                     dry_run=False, can_see_cost=True, allows=lambda _r, _a: True)
        draft = drafted.update.run.steps[check.id].ai_draft
        assert draft is not None
        assert draft["text"].startswith("Demo draft:")
        assert "Demo chat response" not in draft["text"]
        # The draft is stored unconfirmed: it never becomes the note or finishes the step.
        step = drafted.update.run.steps[check.id]
        assert step.status != "done" and not step.note

        # One gateway call each, one ledger row each, on the runbook surface, priced
        # as a Demo run (``zero``: no provider was billed; the figure is synthetic).
        usage = await _runbook_usage(app_state, case.case_id)
        assert len(usage) == 2, usage
        assert {row.get("pricing_source") for row in usage} == {"zero"}
    finally:
        await app_state.disable_demo()


def _messages(system: str, user: str) -> list[dict[str, str]]:
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def test_the_demo_provider_routes_only_the_runbook_markers() -> None:
    provider = P.DemoMockProvider()
    suggest = _messages(f"{RUNBOOK_SUGGEST_SYSTEM_MARKER}\nPick one.",
                        '[{"id": "malware-endpoint"}, {"id": "generic-incident"}]')
    answer = provider._demo_chat_route("chat", suggest)
    assert answer is not None
    assert json.loads(answer)["runbook_id"] == "malware-endpoint"

    draft = _messages(f"{RUNBOOK_DRAFT_SYSTEM_MARKER}\nDraft the note.", '{"count": 4}, {"count": 3}')
    assert provider._demo_chat_route("chat", draft) == R.demo_runbook_ai_answer(draft)
    assert provider._demo_chat_route("chat", draft).startswith("Demo draft:")

    # The marker is read from the system prompt only: a user message that carries it
    # (log-derived or typed text) is not a runbook prompt.
    forged = _messages("Any other system prompt.", f"{RUNBOOK_DRAFT_SYSTEM_MARKER}\n" + '{"count": 9}')
    assert provider._demo_chat_route("chat", forged) is None
    assert provider._demo_chat_route("chat", [{"role": "user", "content": RUNBOOK_SUGGEST_SYSTEM_MARKER}]) is None


@pytest.mark.asyncio
async def test_a_runbook_prompt_is_answered_whatever_the_role(monkeypatch: pytest.MonkeyPatch) -> None:
    """The runbook calls use the chat role today; the route reads the marker, not the
    role, so a later role change keeps the Demo answer."""
    provider = P.DemoMockProvider()
    draft = _messages(f"{RUNBOOK_DRAFT_SYSTEM_MARKER}\nDraft the note.", "no lookup results")
    for role in ("chat", "router", "investigator"):
        result = await provider.complete(role, draft, "demo-model", 0.0, 400)
        assert result.text == R.demo_runbook_ai_answer(draft)
        assert result.text.startswith("Demo draft:")


def _boom(_messages: Any) -> str | None:
    raise RuntimeError("regression")


def _nothing(_messages: Any) -> str | None:
    return None


_SUGGEST = _messages(f"{RUNBOOK_SUGGEST_SYSTEM_MARKER}\nPick one.", '[{"id": "malware-endpoint"}]')
_DRAFT = _messages(f"{RUNBOOK_DRAFT_SYSTEM_MARKER}\nDraft the note.", '{"count": 4}')


@pytest.mark.asyncio
@pytest.mark.parametrize("builder", [_boom, _nothing], ids=["raises", "returns-nothing"])
async def test_a_failing_runbook_answer_still_fits_its_marker(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, builder: Any,
) -> None:
    """A regression in the run engine's Demo builder never lets the generic Demo chat
    text through as a runbook answer: the draft is a recognisable Demo draft that
    claims nothing about the lookups, and the suggestion names no runbook."""
    monkeypatch.setattr(R, "demo_runbook_ai_answer", builder)
    provider = P.DemoMockProvider()
    with caplog.at_level(logging.WARNING, logger="tlsoc.llm.providers"):
        draft = await provider.complete("chat", _DRAFT, "demo-model", 0.0, 400)
        suggest = await provider.complete("chat", _SUGGEST, "demo-model", 0.0, 400)

    assert draft.text == P._DEMO_RUNBOOK_DRAFT_FALLBACK
    assert draft.text.startswith("Demo draft:")
    assert "Demo chat response" not in draft.text
    assert "found" not in draft.text  # no count is claimed without the builder

    assert json.loads(suggest.text) == {"runbook_id": "", "reason": ""}

    warnings = [r for r in caplog.records if r.name == "tlsoc.llm.providers" and r.levelno == logging.WARNING]
    assert len(warnings) == 2, [r.getMessage() for r in warnings]


def test_a_missing_run_engine_still_fits_the_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the run engine itself cannot be imported, a marked prompt is still a runbook
    prompt: the fixed fallback answers it. An unmarked prompt keeps its own path."""
    monkeypatch.setitem(sys.modules, "app.engine.runbook_runs", None)
    provider = P.DemoMockProvider()
    assert provider._demo_chat_route("chat", _DRAFT) == P._DEMO_RUNBOOK_DRAFT_FALLBACK
    assert json.loads(provider._demo_chat_route("chat", _SUGGEST))["runbook_id"] == ""
    assert provider._demo_chat_route("chat", _messages("Any other system prompt.", "hello")) is None


@pytest.mark.asyncio
async def test_a_failing_demo_builder_never_stores_the_generic_answer(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End to end in Demo Mode: with the builder broken, "Suggest a runbook" answers that
    there is no candidate, and "Draft note" stores the neutral Demo draft, unconfirmed.
    Both calls still go through the gateway and are ledgered at $0."""
    monkeypatch.setattr(R, "demo_runbook_ai_answer", _boom)
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        case = _case("case-demo-broken")
        await app_state.cases.save(case)

        suggestion = await R.suggest_runbook(app_state, case, actor="asha", dry_run=False, can_see_cost=True)
        assert suggestion.candidate is None

        attached = await R.attach_by_person(app_state, case, BRUTE, note=None, actor="asha", context=None)
        await R.wait_for_background_lookups(10)
        run = attached.run
        check = next(step for step in run.snapshot.steps if step.kind == "check")
        drafted = await R.draft_step(app_state, case, run.run_id, check.id, actor="asha", context=None,
                                     dry_run=False, can_see_cost=True, allows=lambda _r, _a: True)
        step = drafted.update.run.steps[check.id]
        assert step.ai_draft is not None
        assert step.ai_draft["text"] == P._DEMO_RUNBOOK_DRAFT_FALLBACK
        assert step.status != "done" and not step.note

        usage = await _runbook_usage(app_state, case.case_id)
        assert len(usage) == 2, usage
        assert {row.get("pricing_source") for row in usage} == {"zero"}
    finally:
        await app_state.disable_demo()
