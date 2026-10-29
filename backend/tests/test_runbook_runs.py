"""Runbook runs on cases (Round 14 SPEC §4.10.4, §4.10.7, §4.10.15): attachment and
its re-evaluation hooks, steps, decisions, approvals, version switches, abandoning,
progress, conflicts, per-viewer redaction and the ``case.runbook`` SSE channel.

Offline (fake ES, mock LLM). Lookups that would reach a log source or a provider are
stubbed: these tests pin the run engine, not the read paths
(``test_runbook_lookups_exec.py`` pins those). Nothing here reaches
``case_manager.decide()`` or ``AutoClosePolicy`` (#3).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes_case_runbooks as case_routes
from app.api.deps import AccessView
from app.api.routes import gate_realtime_topics
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface
from app.engine import runbook_runs as R
from app.engine.runbook_match import MatchableRunbook
from app.es.fake import InMemoryESClient
from app.models import (
    Case,
    DecisionOption,
    Entity,
    LookupResult,
    RunbookDefinition,
    RunbookStep,
    RunbookStepUpdate,
    StepEvidence,
)
from app.realtime import CASE_RUNBOOK_EVENT, RUNBOOKS_TOPIC, SSE_EVENT_TYPES
from app.state import AppState
from app.utils import now_utc

from tests.conftest import mount_moved_routers

BRUTE = "brute-force-password-spray"
GENERIC = "generic-incident"


# --------------------------------------------------------------------------- #
# Builders
# --------------------------------------------------------------------------- #
def _case(case_id: str = "case-1", *, rule: str = "mail_auth", status: CaseStatus = CaseStatus.NEEDS_HUMAN,
          **kw: Any) -> Case:
    base: dict[str, Any] = dict(
        case_id=case_id, cluster_signature=f"sig-{case_id}", source_surface=SourceSurface.INVESTIGATE,
        rule_ids=[rule], entity=Entity(type=EntityType.IP, value="203.0.113.7"), status=status,
        case_number=f"CASE-{case_id[-3:]}",
    )
    base.update(kw)
    return Case(**base)


async def _saved(state: AppState, case: Case) -> Case:
    await state.cases.save(case)
    return case


@pytest.fixture(autouse=True)
def _no_lookups(monkeypatch: pytest.MonkeyPatch) -> None:
    """On-attach lookups are recorded as a fixed result (no source, no provider)."""

    async def fake_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by, facts=[{"label": "Events", "value": "0"}])

    monkeypatch.setattr(R, "execute_lookup", fake_execute)


def _custom_runbook(
    rid: str = "custom-approval", version: int = 1, *, approval_role: str | None = "senior_analyst",
    extra_step: bool = True,
) -> MatchableRunbook:
    steps = [
        RunbookStep(id="look", phase="triage", kind="check", title="Is the alert real?", evidence="note"),
        RunbookStep(id="pick", phase="investigate", kind="decision", title="What is it?", options=[
            DecisionOption(id="real", label="Real"),
            DecisionOption(id="noise", label="Noise", marks_not_applicable=["contain-host", "tell-owner"]),
        ]),
        RunbookStep(id="contain-host", phase="contain", kind="action", title="Isolate the host",
                    approval_role=approval_role),
        RunbookStep(id="tell-owner", phase="close", kind="record", title="Tell the owner", required=False),
    ]
    if extra_step:
        steps.append(RunbookStep(id="old-only", phase="close", kind="record", title="Old step"))
    defn = RunbookDefinition(
        id=rid, title="Custom approval runbook", summary="A runbook for tests.",
        phases=["triage", "investigate", "contain", "close"], steps=steps,
    )
    return MatchableRunbook(id=rid, version=version, definition=defn, origin="operator")


def _catalog(*entries: MatchableRunbook) -> R.RunbookCatalog:
    return R.RunbookCatalog(builtins=(), operator=tuple(entries), replaced=frozenset(), matchable=tuple(entries))


async def _rows(state: AppState, case_id: str) -> list[dict[str, Any]]:
    return [r for r in await state.audit.records_for_case(case_id) if isinstance(r, dict)]


def _actions(rows: list[dict[str, Any]]) -> list[str]:
    return [str(r.get("action") or "") for r in rows]


# --------------------------------------------------------------------------- #
# Attachment (§4.10.4)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_matching_runbook_attaches_once_per_case_and_runbook(app_state: AppState) -> None:
    case = await _saved(app_state, _case())
    run = await R.reevaluate_case(app_state, case, trigger="test")
    assert run is not None and run.runbook_id == BRUTE
    assert run.attached_by == "rule" and run.attached_reason["tier"] == 3
    assert run.attached_actor == "runbook_selector"
    # Every re-evaluation after that changes nothing (#4).
    for _ in range(3):
        assert await R.reevaluate_case(app_state, case, trigger="again") is None
    stored = await app_state.runbook_runs.get(case.case_id)
    assert [r.runbook_id for r in stored.runs] == [BRUTE]
    await R.wait_for_background_lookups(10)
    assert _actions(await _rows(app_state, case.case_id)).count("run.attached") == 1


@pytest.mark.asyncio
async def test_concurrent_reevaluations_attach_one_run(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-par"))
    results = await asyncio.gather(*(R.reevaluate_case(app_state, case, trigger="race") for _ in range(4)))
    assert sum(1 for r in results if r is not None) >= 1
    stored = await app_state.runbook_runs.get(case.case_id)
    assert [r.runbook_id for r in stored.runs] == [BRUTE]


@pytest.mark.asyncio
async def test_fallback_only_without_a_match_and_a_more_specific_runbook_still_attaches(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-fb", rule="nothing_matches_this"))
    run = await R.reevaluate_case(app_state, case, trigger="test")
    assert run is not None and run.runbook_id == GENERIC and run.attached_by == "fallback"
    # The case changes and now matches a rule: a higher tier attaches beside it.
    case.rule_ids = ["mail_auth"]
    await app_state.cases.save(case)
    second = await R.reevaluate_case(app_state, case, trigger="severity")
    assert second is not None and second.runbook_id == BRUTE
    assert await R.reevaluate_case(app_state, case, trigger="again") is None
    stored = await app_state.runbook_runs.get(case.case_id)
    assert sorted(r.runbook_id for r in stored.runs) == sorted([GENERIC, BRUTE])


@pytest.mark.asyncio
async def test_fallback_never_stacks_on_an_existing_run(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-fb2", rule="nothing_matches_this"))
    await R.attach_by_person(app_state, case, "malware-endpoint", note=None, actor="asha", context=None)
    assert await R.reevaluate_case(app_state, case, trigger="test") is None


@pytest.mark.asyncio
async def test_a_persons_choice_is_never_stacked_on_by_automation(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-person"))
    result = await R.attach_by_person(app_state, case, GENERIC, note="start here", actor="asha", context=None)
    assert result.run is not None and result.run.attached_by == "person"
    assert await R.reevaluate_case(app_state, case, trigger="test") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [CaseStatus.NEW, CaseStatus.CLOSED, CaseStatus.RESOLVED])
async def test_no_run_for_candidates_and_terminal_cases(app_state: AppState, status: CaseStatus) -> None:
    case = await _saved(app_state, _case(f"case-{status.value}", status=status))
    assert R.attachment_blocked(case) is not None
    assert await R.reevaluate_case(app_state, case, trigger="test") is None
    assert (await app_state.runbook_runs.get(case.case_id)).runs == ()


@pytest.mark.asyncio
async def test_an_automatic_close_in_its_objection_window_gets_no_run(app_state: AppState) -> None:
    expires = (now_utc() + timedelta(hours=2)).isoformat()
    case = await _saved(app_state, _case("case-auto", status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
                                         objection_window_expires_at=expires))
    assert R.attachment_blocked(case) == "pending_auto_close"
    assert await R.reevaluate_case(app_state, case, trigger="pipeline") is None


@pytest.mark.asyncio
async def test_auto_attach_off_attaches_nothing(app_state: AppState) -> None:
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"auto_attach": False}),
    }))
    case = await _saved(app_state, _case("case-off"))
    assert await R.reevaluate_case(app_state, case, trigger="test") is None


@pytest.mark.asyncio
async def test_fallback_off_leaves_an_unmatched_case_without_a_run(app_state: AppState) -> None:
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"fallback": False}),
    }))
    case = await _saved(app_state, _case("case-nofb", rule="nothing_matches_this"))
    assert await R.reevaluate_case(app_state, case, trigger="test") is None


def _builtin_catalog() -> R.RunbookCatalog:
    from app.engine.runbook_match import matchable_catalog
    from app.engine.runbook_model import load_builtin_runbooks

    builtins = tuple(MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
                     for b in load_builtin_runbooks())
    return R.RunbookCatalog(builtins=builtins, operator=(), replaced=frozenset(),
                            matchable=matchable_catalog(builtins, [], replaced_builtin_ids=set()))


def test_plan_attachment_is_pure_and_never_repeats_a_runbook() -> None:
    catalog = _builtin_catalog()
    facts = R.case_facts(_case(), None)
    plan = R.plan_attachment(facts, catalog, [], fallback=True)
    assert plan is not None and plan.entry.id == BRUTE and plan.tier == 3
    brute = R._new_run("c", plan.entry, attached_by="rule", attached_reason={"tier": 3}, actor="x",
                       now="2026-10-28T10:00:00Z")
    # The same runbook never attaches twice, abandoned or not (#4).
    assert R.plan_attachment(facts, catalog, [brute], fallback=True) is None
    gone = brute.model_copy(update={"status": "abandoned"})
    assert R.plan_attachment(facts, catalog, [gone], fallback=True) is None
    # Nothing matched: the fallback only for a case without a run.
    other = R.case_facts(_case(rule="nothing_matches_this"), None)
    fallback = R.plan_attachment(other, catalog, [], fallback=True)
    assert fallback is not None and fallback.entry.id == GENERIC and fallback.tier == 0
    assert R.plan_attachment(other, catalog, [brute], fallback=True) is None
    assert R.plan_attachment(other, catalog, [], fallback=False) is None


@pytest.mark.asyncio
async def test_run_limit_is_five_runs_per_case(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-limit"))
    ids = ["malware-endpoint", "ransomware-destructive", BRUTE, "compromised-account", "data-exfiltration"]
    for rid in ids:
        await R.attach_by_person(app_state, case, rid, note=None, actor="asha", context=None)
    with pytest.raises(R.RunbookRunError) as err:
        await R.attach_by_person(app_state, case, GENERIC, note=None, actor="asha", context=None)
    assert err.value.status_code == 409 and err.value.code == "run_limit"


@pytest.mark.asyncio
async def test_attach_unknown_runbook_is_404(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-404"))
    with pytest.raises(R.RunbookRunError) as err:
        await R.attach_by_person(app_state, case, "no-such-runbook", note=None, actor="asha", context=None)
    assert err.value.status_code == 404 and err.value.code == "runbook_not_found"


@pytest.mark.asyncio
async def test_automation_attach_and_skip_rows(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-auto-rule"))
    run = await R.attach_by_automation(app_state, case, GENERIC, rule_id="rule-7")
    assert run is not None and run.attached_by == "rule"
    assert await R.attach_by_automation(app_state, case, "gone-runbook", rule_id="rule-8") is None
    assert await R.attach_by_automation(app_state, case, None, rule_id="rule-9") is None
    rows = await _rows(app_state, case.case_id)
    skipped = [r for r in rows if r.get("action") == "run.attach_skipped"]
    assert len(skipped) == 2
    assert {"The runbook does not exist.", "The rule names no runbook."} <= {
        (r.get("tool_input") or {}).get("reason") for r in skipped
    }


@pytest.mark.asyncio
async def test_concurrent_attaches_by_hand_write_one_run_one_row_and_one_set_of_lookups(app_state, monkeypatch) -> None:
    calls: list[str] = []

    async def counting_execute(state, case, template, *, ran_by, now=None, events=None, load_events=True):
        calls.append(template.tool)
        return LookupResult(tool=template.tool, status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                            ran_by=ran_by)

    async def no_events(_state: Any, _case: Any) -> None:
        return None

    monkeypatch.setattr(R, "execute_lookup", counting_execute)
    monkeypatch.setattr(R, "_case_events", no_events)
    case = await _saved(app_state, _case("case-race"))
    results = await asyncio.gather(*(R.attach_by_person(app_state, case, BRUTE, note=None, actor="asha",
                                                        context=None) for _ in range(3)))
    await R.wait_for_background_lookups(10)
    assert sorted(r.already_attached for r in results) == [False, True, True]
    assert len({r.run.run_id for r in results}) == 1
    stored = await app_state.runbook_runs.get(case.case_id)
    assert [r.run_id for r in stored.runs] == [results[0].run.run_id]
    rows = await _rows(app_state, case.case_id)
    attached = [r for r in rows if r.get("action") == "run.attached"]
    assert len(attached) == 1 and attached[0]["tool_input"]["run_id"] == stored.runs[0].run_id
    on_attach = [s for s in stored.runs[0].snapshot.steps
                 if s.kind == "lookup" and s.lookup is not None and s.lookup.run == "on_attach"]
    assert on_attach and len(calls) == len(on_attach)
    assert _actions(rows).count("step.evidence_collected") == len(on_attach)


@pytest.mark.asyncio
async def test_concurrent_reevaluations_write_one_attached_row(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-par-fb", rule="nothing_matches_this"))
    await asyncio.gather(*(R.reevaluate_case(app_state, case, trigger="race") for _ in range(4)))
    stored = await app_state.runbook_runs.get(case.case_id)
    assert [r.runbook_id for r in stored.runs] == [GENERIC]
    await R.wait_for_background_lookups(10)
    assert _actions(await _rows(app_state, case.case_id)).count("run.attached") == 1


def _other_writer_first(store: Any, monkeypatch: pytest.MonkeyPatch, extra: Any) -> None:
    """Stand in for another process: just before this process's write, another
    writer stores ``extra`` (a run) on the same case."""
    original = store.mutate
    done = {"first": False}

    async def mutate(case_id: str, change: Any, **kw: Any) -> Any:
        if not done["first"]:
            done["first"] = True
            await original(case_id, lambda runs: ([*runs, extra], None))
        return await original(case_id, change, **kw)

    monkeypatch.setattr(store, "mutate", mutate)


@pytest.mark.asyncio
async def test_an_attach_that_lost_a_race_at_write_time_is_answered_already_attached(app_state, monkeypatch) -> None:
    case = await _saved(app_state, _case("case-lost"))
    catalog = await R.load_catalog(app_state)
    theirs = R._new_run(case.case_id, catalog.published(BRUTE), attached_by="person",
                        attached_reason={"by": "ben"}, actor="ben", now="2026-10-28T10:00:00Z")
    _other_writer_first(app_state.runbook_runs, monkeypatch, theirs)
    result = await R.attach_by_person(app_state, case, BRUTE, note=None, actor="asha", context=None)
    await R.wait_for_background_lookups(10)
    assert result.already_attached and result.run.run_id == theirs.run_id
    stored = await app_state.runbook_runs.get(case.case_id)
    assert [r.run_id for r in stored.runs] == [theirs.run_id]
    rows = await _rows(app_state, case.case_id)
    # The action row this process appended is followed by its failure row, so the
    # trail never shows an attachment that did not happen; no lookup ran for it.
    assert _actions(rows).count("run.attached") == 1
    failed = [r for r in rows if r.get("action") == "run.attach_failed"]
    assert len(failed) == 1 and failed[0]["outcome"] == "failure"
    assert "no_change" in failed[0]["result_summary"]
    assert "step.evidence_collected" not in _actions(rows)


@pytest.mark.asyncio
async def test_an_automatic_attach_rechecks_the_tier_rule_at_write_time(app_state, monkeypatch) -> None:
    case = await _saved(app_state, _case("case-tier-race", rule="nothing_matches_this"))
    catalog = await R.load_catalog(app_state)
    persons = R._new_run(case.case_id, catalog.published(BRUTE), attached_by="person",
                         attached_reason={"by": "ben"}, actor="ben", now="2026-10-28T10:00:00Z")
    _other_writer_first(app_state.runbook_runs, monkeypatch, persons)
    # The plan (the fallback, for a case without a run) no longer holds once a person's
    # runbook is on the case: nothing is stacked on it.
    assert await R.reevaluate_case(app_state, case, trigger="race") is None
    stored = await app_state.runbook_runs.get(case.case_id)
    assert [r.runbook_id for r in stored.runs] == [BRUTE]
    assert "run.attach_failed" in _actions(await _rows(app_state, case.case_id))


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expires,reason", [
    (CaseStatus.CLOSED, None, R.AUTOMATION_SKIP_REASONS["status"]),
    (CaseStatus.NEW, None, R.AUTOMATION_SKIP_REASONS["status"]),
    (CaseStatus.CLOSED, "future", R.AUTOMATION_SKIP_REASONS["pending_auto_close"]),
])
async def test_automation_never_attaches_to_a_case_that_does_not_need_a_person(
    app_state: AppState, status: CaseStatus, expires: str | None, reason: str,
) -> None:
    extra: dict[str, Any] = {}
    if expires:
        extra = {"decision_by": DecisionBy.AGENT,
                 "objection_window_expires_at": (now_utc() + timedelta(hours=1)).isoformat()}
    case = await _saved(app_state, _case(f"case-auto-{status.value}-{bool(expires)}", status=status, **extra))
    assert await R.attach_by_automation(app_state, case, GENERIC, rule_id="rule-1") is None
    assert (await app_state.runbook_runs.get(case.case_id)).runs == ()
    skipped = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "run.attach_skipped"]
    assert [r["tool_input"]["reason"] for r in skipped] == [reason]


@pytest.mark.asyncio
async def test_automation_skips_while_runbooks_are_off(app_state: AppState) -> None:
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"enabled": False}),
    }))
    case = await _saved(app_state, _case("case-auto-off"))
    assert await R.attach_by_automation(app_state, case, GENERIC, rule_id="rule-1") is None
    skipped = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "run.attach_skipped"]
    assert [r["tool_input"]["reason"] for r in skipped] == ["Runbooks are turned off in Settings."]


@pytest.mark.asyncio
async def test_automation_attach_is_idempotent(app_state: AppState) -> None:
    case = await _saved(app_state, _case("case-auto-twice"))
    assert await R.attach_by_automation(app_state, case, GENERIC, rule_id="rule-1") is not None
    assert await R.attach_by_automation(app_state, case, GENERIC, rule_id="rule-1") is None
    await R.wait_for_background_lookups(10)
    assert _actions(await _rows(app_state, case.case_id)).count("run.attached") == 1


@pytest.mark.asyncio
async def test_the_picker_leaves_out_runbooks_on_the_case_and_replaced_built_ins(app_state, monkeypatch) -> None:
    from app.engine.runbook_match import matchable_catalog
    from app.engine.runbook_model import load_builtin_runbooks

    builtins = tuple(MatchableRunbook(id=b.id, version=b.version, definition=b.definition, origin="builtin")
                     for b in load_builtin_runbooks())
    brute = next(b for b in builtins if b.id == BRUTE)
    copy = MatchableRunbook(id=f"{BRUTE}-custom", version=1,
                            definition=brute.definition.model_copy(update={"id": f"{BRUTE}-custom",
                                                                           "title": "Password spray (ours)"}),
                            origin="operator")
    catalog = R.RunbookCatalog(builtins=builtins, operator=(copy,), replaced=frozenset({BRUTE}),
                               matchable=matchable_catalog(builtins, [copy], replaced_builtin_ids={BRUTE}))

    async def fake_catalog(_state: Any) -> R.RunbookCatalog:
        return catalog

    monkeypatch.setattr(R, "load_catalog", fake_catalog)
    case = await _saved(app_state, _case("case-picker"))
    await R.attach_by_person(app_state, case, GENERIC, note=None, actor="asha", context=None)
    ids = [c.id for c in await R.candidates_for_case(app_state, case, actor="asha")]
    assert BRUTE not in ids and GENERIC not in ids
    assert ids[0] == f"{BRUTE}-custom"


# --------------------------------------------------------------------------- #
# Steps (§4.10.7)
# --------------------------------------------------------------------------- #
async def _custom_run(app_state: AppState, monkeypatch: pytest.MonkeyPatch, case_id: str = "case-steps",
                      **kw: Any) -> tuple[Case, Any]:
    entry = _custom_runbook(**kw)

    async def fake_catalog(_state: Any) -> R.RunbookCatalog:
        return _catalog(entry)

    monkeypatch.setattr(R, "load_catalog", fake_catalog)
    case = await _saved(app_state, _case(case_id))
    result = await R.attach_by_person(app_state, case, entry.id, note=None, actor="asha", context=None)
    assert result.run is not None
    return case, result.run


async def _step(app_state: AppState, case_id: str, run_id: str, step_id: str):
    return (await app_state.runbook_runs.get(case_id)).run(run_id).steps[step_id]


@pytest.mark.asyncio
async def test_check_step_needs_its_note_and_reasons_are_required(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch)
    st = await _step(app_state, case.case_id, run.run_id, "look")
    with pytest.raises(R.RunbookRunError) as err:
        await R.update_step(app_state, case, run.run_id, "look",
                            RunbookStepUpdate(expected_revision=st.revision, status="done"), actor="asha", context=None)
    assert err.value.code == "step_state" and "note" in err.value.message
    upd = await R.update_step(app_state, case, run.run_id, "look",
                              RunbookStepUpdate(expected_revision=st.revision, note="Two hosts, same user.",
                                                status="done"), actor="asha", context=None)
    look = upd.run.steps["look"]
    assert look.status == "done" and look.completed_by == "asha" and look.revision == st.revision + 1
    with pytest.raises(R.RunbookRunError) as err:
        await R.update_step(app_state, case, run.run_id, "tell-owner",
                            RunbookStepUpdate(expected_revision=0, status="blocked"), actor="asha", context=None)
    assert err.value.message == "Give a reason."
    rows = await _rows(app_state, case.case_id)
    assert "step.updated" in _actions(rows) and "run.started" in _actions(rows)


@pytest.mark.asyncio
async def test_stale_step_revision_is_a_conflict_never_retried(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-stale")
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=0, note="first"), actor="asha", context=None)
    with pytest.raises(R.RunbookRunError) as err:
        await R.update_step(app_state, case, run.run_id, "look",
                            RunbookStepUpdate(expected_revision=0, note="second"), actor="ben", context=None)
    assert err.value.status_code == 409 and err.value.code == "runbook_conflict"
    assert (await _step(app_state, case.case_id, run.run_id, "look")).note == "first"
    # A change to another step never conflicts with this one.
    await R.update_step(app_state, case, run.run_id, "tell-owner",
                        RunbookStepUpdate(expected_revision=0, assignee="ben"), actor="ben", context=None)


@pytest.mark.asyncio
async def test_a_decision_marks_only_later_todo_steps_not_applicable(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-decide")
    # The record step after the decision was already started: it is left alone.
    await R.update_step(app_state, case, run.run_id, "tell-owner",
                        RunbookStepUpdate(expected_revision=0, status="in_progress"), actor="asha", context=None)
    upd = await R.update_step(app_state, case, run.run_id, "pick",
                              RunbookStepUpdate.model_validate({"expected_revision": 0,
                                                                "decision": {"option_id": "noise"}}),
                              actor="asha", context=None)
    steps = upd.run.steps
    assert steps["pick"].status == "done" and steps["pick"].decision["label"] == "Noise"
    assert steps["contain-host"].status == "not_applicable"
    assert steps["contain-host"].reason == "Skipped by the decision 'Noise'"
    assert steps["tell-owner"].status == "in_progress"
    with pytest.raises(R.RunbookRunError) as err:
        await R.update_step(app_state, case, run.run_id, "look",
                            RunbookStepUpdate.model_validate({"expected_revision": 0,
                                                              "decision": {"option_id": "noise"}}),
                            actor="asha", context=None)
    assert err.value.code == "step_state"
    assert "step.decision_recorded" in _actions(await _rows(app_state, case.case_id))


@pytest.mark.asyncio
async def test_run_completes_when_required_steps_are_finished(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-done", extra_step=False)
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=0, note="checked", status="done"), actor="asha",
                        context=None)
    upd = await R.update_step(app_state, case, run.run_id, "pick",
                              RunbookStepUpdate.model_validate({"expected_revision": 0,
                                                                "decision": {"option_id": "noise"}}),
                              actor="asha", context=None)
    assert upd.run.status == "completed" and upd.progress.required_open == 0
    assert "run.completed" in _actions(await _rows(app_state, case.case_id))
    # Reopening a step reopens the run; the case never changes (#3).
    upd = await R.update_step(app_state, case, run.run_id, "look",
                              RunbookStepUpdate(expected_revision=1, status="todo"), actor="asha", context=None)
    assert upd.run.status == "active"
    assert (await app_state.cases.get(case.case_id)).status == CaseStatus.NEEDS_HUMAN


@pytest.mark.asyncio
async def test_recorded_action_waits_for_a_second_person(app_state, monkeypatch) -> None:
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"step_approvals": True}),
    }))
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-approve")
    upd = await R.update_step(app_state, case, run.run_id, "contain-host",
                              RunbookStepUpdate.model_validate({
                                  "expected_revision": 0,
                                  "action_record": {"where": "EDR console", "outcome": "Isolated"}}),
                              actor="asha", context=None)
    st = upd.run.steps["contain-host"]
    assert st.status == "in_progress" and st.approval["status"] == "pending"
    assert upd.progress.waiting == 1
    with pytest.raises(R.RunbookRunError) as err:
        await R.decide_approval(app_state, case, run.run_id, "contain-host", decision="approve", reason=None,
                                actor="asha", context=None)
    assert err.value.status_code == 403 and err.value.code == "runbook_distinct_approver"
    assert err.value.message == "Only a senior_analyst other than asha can approve."
    upd = await R.decide_approval(app_state, case, run.run_id, "contain-host", decision="reject",
                                  reason="Wrong host", actor="ben", context=None)
    assert upd.run.steps["contain-host"].status == "in_progress"
    assert upd.run.steps["contain-host"].approval["status"] == "rejected"
    rows = _actions(await _rows(app_state, case.case_id))
    assert {"step.action_recorded", "step.approval_requested", "step.rejected"} <= set(rows)


@pytest.mark.asyncio
async def test_approve_marks_the_step_done_by_the_approver(app_state, monkeypatch) -> None:
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"step_approvals": True}),
    }))
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-approve2")
    await R.update_step(app_state, case, run.run_id, "contain-host",
                        RunbookStepUpdate.model_validate({
                            "expected_revision": 0, "action_record": {"where": "EDR", "outcome": "done"}}),
                        actor="asha", context=None)
    upd = await R.decide_approval(app_state, case, run.run_id, "contain-host", decision="approve", reason=None,
                                  actor="ben", context=None)
    st = upd.run.steps["contain-host"]
    assert st.status == "done" and st.completed_by == "ben" and st.approval["status"] == "approved"


@pytest.mark.asyncio
async def test_without_step_approvals_a_recorded_action_is_done(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-noapprove")
    upd = await R.update_step(app_state, case, run.run_id, "contain-host",
                              RunbookStepUpdate.model_validate({
                                  "expected_revision": 0, "action_record": {"where": "EDR", "outcome": "ok"}}),
                              actor="asha", context=None)
    assert upd.run.steps["contain-host"].status == "done"
    assert upd.run.steps["contain-host"].approval is None


async def _approvals_on(app_state: AppState) -> None:
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"step_approvals": True}),
    }))


async def _record(app_state: AppState, case: Case, run_id: str, step_id: str, actor: str, revision: int = 0,
                  **record: Any):
    return await R.update_step(app_state, case, run_id, step_id, RunbookStepUpdate.model_validate({
        "expected_revision": revision,
        "action_record": {"where": "EDR console", "outcome": "Isolated", **record}}), actor=actor, context=None)


@pytest.mark.asyncio
async def test_a_step_waiting_for_approval_cannot_be_marked_not_applicable(app_state, monkeypatch) -> None:
    """D35: the second-person approval is never bypassed. The recorder (or anyone)
    marking a waiting step Not applicable would finish it without the approval."""
    await _approvals_on(app_state)
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-na-wait")
    upd = await _record(app_state, case, run.run_id, "contain-host", "asha")
    revision = upd.run.steps["contain-host"].revision
    for actor in ("asha", "ben"):
        with pytest.raises(R.RunbookRunError) as err:
            await R.update_step(app_state, case, run.run_id, "contain-host",
                                RunbookStepUpdate(expected_revision=revision, status="not_applicable", reason="x"),
                                actor=actor, context=None)
        assert err.value.status_code == 409 and err.value.code == "step_state"
        assert err.value.message == "This step waits for approval. An approver approves or rejects it first."
    st = await _step(app_state, case.case_id, run.run_id, "contain-host")
    assert st.status == "in_progress" and st.approval["status"] == "pending" and st.action_record
    progress = R.run_progress((await app_state.runbook_runs.get(case.case_id)).run(run.run_id))
    assert progress.waiting == 1
    # Withdrawing the record (a reopen to To do) is allowed and the row names the
    # pending approval and the record it drops.
    await R.update_step(app_state, case, run.run_id, "contain-host",
                        RunbookStepUpdate(expected_revision=revision, status="todo"), actor="asha", context=None)
    row = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "step.updated"][-1]
    changes = {c["field"]: (c.get("before"), c.get("after")) for c in row["changes"]}
    assert changes["steps.contain-host.status"] == ("in_progress", "todo")
    assert changes["steps.contain-host.approval"] == ("pending", None)
    assert changes["steps.contain-host.action_record"] == ("EDR console", None)


@pytest.mark.asyncio
async def test_not_applicable_names_a_decided_approval_it_drops(app_state, monkeypatch) -> None:
    await _approvals_on(app_state)
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-na-rejected")
    await _record(app_state, case, run.run_id, "contain-host", "asha")
    upd = await R.decide_approval(app_state, case, run.run_id, "contain-host", decision="reject",
                                  reason="Wrong host", actor="ben", context=None)
    revision = upd.run.steps["contain-host"].revision
    upd = await R.update_step(app_state, case, run.run_id, "contain-host",
                              RunbookStepUpdate(expected_revision=revision, status="not_applicable",
                                                reason="Host already rebuilt"), actor="asha", context=None)
    assert upd.run.steps["contain-host"].status == "not_applicable"
    assert upd.run.steps["contain-host"].approval is None
    row = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "step.updated"][-1]
    changes = {c["field"]: (c.get("before"), c.get("after")) for c in row["changes"]}
    assert changes["steps.contain-host.approval"] == ("rejected", None)
    assert changes["steps.contain-host.status"] == ("in_progress", "not_applicable")


def _optional_approval_runbook() -> MatchableRunbook:
    defn = RunbookDefinition(
        id="custom-optional-approval", title="Optional approval runbook", summary="A runbook for tests.",
        phases=["triage", "close"],
        steps=[
            RunbookStep(id="look", phase="triage", kind="check", title="Is the alert real?"),
            RunbookStep(id="tell-owner", phase="close", kind="record", title="Tell the owner", required=False,
                        approval_role="senior_analyst"),
        ],
    )
    return MatchableRunbook(id=defn.id, version=1, definition=defn, origin="operator")


@pytest.mark.asyncio
async def test_an_optional_step_waiting_for_approval_never_keeps_the_run_active(app_state, monkeypatch) -> None:
    """§4.10.7: a run completes when every REQUIRED step is Done or Not applicable."""
    await _approvals_on(app_state)
    entry = _optional_approval_runbook()

    async def fake_catalog(_state: Any) -> R.RunbookCatalog:
        return _catalog(entry)

    monkeypatch.setattr(R, "load_catalog", fake_catalog)
    case = await _saved(app_state, _case("case-opt-wait"))
    run = (await R.attach_by_person(app_state, case, entry.id, note=None, actor="asha", context=None)).run
    await _record(app_state, case, run.run_id, "tell-owner", "asha")
    upd = await R.update_step(app_state, case, run.run_id, "look",
                              RunbookStepUpdate(expected_revision=0, status="done"), actor="asha", context=None)
    assert upd.progress.required_open == 0 and upd.progress.waiting == 1
    assert upd.run.status == "completed"
    assert R.required_open_in((await app_state.runbook_runs.get(case.case_id)).runs) == []
    assert "run.completed" in _actions(await _rows(app_state, case.case_id))
    # The approver still decides the optional step afterwards; the run stays completed.
    upd = await R.decide_approval(app_state, case, run.run_id, "tell-owner", decision="approve", reason=None,
                                  actor="ben", context=None)
    assert upd.run.status == "completed" and upd.run.steps["tell-owner"].status == "done"


@pytest.mark.asyncio
async def test_a_recorded_actions_time_is_a_past_date_and_time_in_utc(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-performed")
    future = (now_utc() + timedelta(days=1)).isoformat()
    # The last one parses, and is in the past, but has no UTC form (it lies before the
    # first representable instant): refused, never an unhandled OverflowError.
    for bad in ("yesterday", "x" * 40, future, "0001-01-01T00:00:00+05:00"):
        with pytest.raises(R.RunbookRunError) as err:
            await _record(app_state, case, run.run_id, "contain-host", "asha", performed_at=bad)
        assert err.value.code == "step_state"
        assert err.value.message == ("Give the time the action was performed as a date and time, "
                                     "not in the future.")
    assert (await _step(app_state, case.case_id, run.run_id, "contain-host")).action_record is None
    upd = await _record(app_state, case, run.run_id, "contain-host", "asha",
                        performed_at="2026-10-28T10:00:00+02:00")
    assert upd.run.steps["contain-host"].action_record["performed_at"] == "2026-10-28T08:00:00Z"
    # Absent means now.
    upd = await _record(app_state, case, run.run_id, "tell-owner", "asha")
    stamped = upd.run.steps["tell-owner"].action_record["performed_at"]
    assert R._parse_iso(stamped) is not None
    # An early time that does have a UTC form is kept as given, normalised to UTC.
    early_case, early_run = await _custom_run(app_state, monkeypatch, case_id="case-performed-early")
    upd = await _record(app_state, early_case, early_run.run_id, "contain-host", "asha",
                        performed_at="0001-01-01T00:00:00-05:00")
    assert upd.run.steps["contain-host"].action_record["performed_at"] == "0001-01-01T05:00:00Z"


@pytest.mark.asyncio
async def test_run_started_is_written_once_when_the_first_activity_is_a_note(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-started")
    # An assignment alone is not work on the step.
    await R.update_step(app_state, case, run.run_id, "tell-owner",
                        RunbookStepUpdate(expected_revision=0, assignee="ben"), actor="asha", context=None)
    assert "run.started" not in _actions(await _rows(app_state, case.case_id))
    # The step row saves its note on blur before the person marks it done.
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=0, note="Two hosts."), actor="asha", context=None)
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=1, status="done"), actor="asha", context=None)
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=2, status="todo"), actor="asha", context=None)
    actions = _actions(await _rows(app_state, case.case_id))
    assert actions.count("run.started") == 1
    started = actions.index("run.started")
    assert actions[started - 1] == "step.updated"
    assert len([a for a in actions[:started] if a == "step.updated"]) == 2


@pytest.mark.asyncio
async def test_approval_rows_name_the_status_change_with_before_and_after(app_state, monkeypatch) -> None:
    await _approvals_on(app_state)
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-approval-rows")
    await _record(app_state, case, run.run_id, "contain-host", "asha")
    await R.decide_approval(app_state, case, run.run_id, "contain-host", decision="reject", reason="Wrong host",
                            actor="ben", context=None)
    upd = await R.update_step(app_state, case, run.run_id, "contain-host",
                              RunbookStepUpdate(expected_revision=2, status="todo"), actor="asha", context=None)
    await _record(app_state, case, run.run_id, "contain-host", "asha",
                  revision=upd.run.steps["contain-host"].revision)
    await R.decide_approval(app_state, case, run.run_id, "contain-host", decision="approve", reason=None,
                            actor="ben", context=None)
    rows = await _rows(app_state, case.case_id)

    def changes(action: str) -> dict[str, tuple[Any, Any]]:
        row = [r for r in rows if r.get("action") == action][-1]
        return {c["field"]: (c.get("before"), c.get("after")) for c in row["changes"]}

    # A recorded action that needs a second person names the approval it requests.
    assert changes("step.action_recorded") == {
        "steps.contain-host.action_record": (None, "EDR console"),
        "steps.contain-host.status": ("todo", "in_progress"),
        "steps.contain-host.approval": (None, "pending"),
    }
    # A rejection leaves the status as it was (in progress); only the approval moves.
    assert changes("step.rejected") == {"steps.contain-host.approval": ("pending", "rejected")}
    assert changes("step.approved") == {"steps.contain-host.approval": ("pending", "approved"),
                                        "steps.contain-host.status": ("in_progress", "done")}


def test_approval_role_check() -> None:
    open_view = AccessView(user=None, role="", unrestricted=True)
    assert case_routes.holds_approval_role(open_view, "senior_analyst")
    analyst = AccessView(user=None, role="analyst", unrestricted=False, matrix={}, assigned=("Senior Analyst",))
    assert case_routes.holds_approval_role(analyst, "senior_analyst")
    assert not case_routes.holds_approval_role(analyst, "soc_manager")
    admin = AccessView(user=None, role="super_admin", unrestricted=False, matrix={})
    assert case_routes.holds_approval_role(admin, "soc_manager")
    assert case_routes.holds_approval_role(analyst, None)


@pytest.mark.asyncio
async def test_switch_version_carries_over_steps_with_the_same_id(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-switch")
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=0, note="kept", status="done"), actor="asha",
                        context=None)
    v2 = _custom_runbook(version=2, extra_step=False)

    async def v2_catalog(_state: Any) -> R.RunbookCatalog:
        return _catalog(v2)

    monkeypatch.setattr(R, "load_catalog", v2_catalog)
    view = await R.case_runbooks_view(app_state, case, lambda *_: True)
    assert view["newer_versions"] == {run.run_id: 2}
    with pytest.raises(R.RunbookRunError) as err:
        await R.switch_version(app_state, case, run.run_id, 3, actor="asha", context=None)
    assert err.value.code == "runbook_state"
    upd = await R.switch_version(app_state, case, run.run_id, 2, actor="asha", context=None)
    assert upd.run.version == 2
    assert upd.run.steps["look"].note == "kept" and upd.run.steps["look"].status == "done"
    assert "old-only" not in upd.run.steps
    assert "run.version_switched" in _actions(await _rows(app_state, case.case_id))


@pytest.mark.asyncio
async def test_step_rows_name_every_change_with_before_and_after(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-changes")
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=0, note="Two hosts.", assignee="asha"),
                        actor="asha", context=None)
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=1, status="done", note="Two hosts, one user."),
                        actor="asha", context=None)
    await R.update_step(app_state, case, run.run_id, "tell-owner",
                        RunbookStepUpdate(expected_revision=0, status="blocked", reason="2026-10-28"),
                        actor="ben", context=None)
    rows = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "step.updated"]
    changes = [{c["field"]: (c.get("before"), c.get("after")) for c in r["changes"]} for r in rows]
    assert changes[0] == {"steps.look.assignee": (None, "asha"), "steps.look.note": (None, "Two hosts.")}
    assert changes[1] == {"steps.look.note": ("Two hosts.", "Two hosts, one user."),
                          "steps.look.status": ("todo", "done")}
    # A date-like value is quoted, so an audit index that still detects dates keeps
    # these fields as text.
    assert changes[2] == {"steps.tell-owner.status": ("todo", "blocked"),
                          "steps.tell-owner.reason": (None, '"2026-10-28"')}
    decision = await R.update_step(app_state, case, run.run_id, "pick",
                                   RunbookStepUpdate.model_validate({"expected_revision": 0,
                                                                     "decision": {"option_id": "real"}}),
                                   actor="asha", context=None)
    assert decision.run.steps["pick"].status == "done"
    recorded = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "step.decision_recorded"]
    assert recorded and {c["field"]: (c.get("before"), c.get("after")) for c in recorded[0]["changes"]} == {
        "steps.pick.decision": (None, "Real"), "steps.pick.status": ("todo", "done")}
    # A recorded action names the record and the status it moved the step to.
    await R.update_step(app_state, case, run.run_id, "contain-host",
                        RunbookStepUpdate.model_validate({"expected_revision": 0, "action_record": {
                            "where": "EDR console", "outcome": "Isolated"}}), actor="asha", context=None)
    action_rows = [r for r in await _rows(app_state, case.case_id) if r.get("action") == "step.action_recorded"]
    assert {c["field"]: (c.get("before"), c.get("after")) for c in action_rows[0]["changes"]} == {
        "steps.contain-host.action_record": (None, "EDR console"), "steps.contain-host.status": ("todo", "done")}


@pytest.mark.asyncio
async def test_a_version_switch_that_finishes_the_run_records_the_completion(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-switch-done")
    await R.update_step(app_state, case, run.run_id, "look",
                        RunbookStepUpdate(expected_revision=0, note="checked", status="done"), actor="asha",
                        context=None)
    await R.update_step(app_state, case, run.run_id, "pick",
                        RunbookStepUpdate.model_validate({"expected_revision": 0,
                                                          "decision": {"option_id": "noise"}}),
                        actor="asha", context=None)
    # Only the v1 step "old-only" is still open; v2 does not have it.
    assert (await app_state.runbook_runs.get(case.case_id)).run(run.run_id).status == "active"
    v2 = _custom_runbook(version=2, extra_step=False)

    async def v2_catalog(_state: Any) -> R.RunbookCatalog:
        return _catalog(v2)

    monkeypatch.setattr(R, "load_catalog", v2_catalog)
    upd = await R.switch_version(app_state, case, run.run_id, 2, actor="asha", context=None)
    assert upd.run.status == "completed"
    actions = _actions(await _rows(app_state, case.case_id))
    assert actions.index("run.version_switched") < actions.index("run.completed")
    ledger = await app_state.runbook_runs.read_ledger_window(now_utc() - timedelta(days=1), now_utc())
    rows = [row for month in ledger for row in month.rows if row.run_id == run.run_id]
    assert rows and rows[0].status == "completed" and rows[0].version == 2


@pytest.mark.asyncio
async def test_abandon_needs_a_reason_and_leaves_the_case(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-abandon")
    with pytest.raises(R.RunbookRunError):
        await R.abandon_run(app_state, case, run.run_id, "   ", actor="asha", context=None)
    upd = await R.abandon_run(app_state, case, run.run_id, "Wrong runbook", actor="asha", context=None)
    assert upd.run.status == "abandoned" and upd.run.abandoned_reason == "Wrong runbook"
    with pytest.raises(R.RunbookRunError) as err:
        await R.update_step(app_state, case, run.run_id, "look",
                            RunbookStepUpdate(expected_revision=0, note="x"), actor="asha", context=None)
    assert err.value.code == "runbook_state"
    assert R.case_progress((await app_state.runbook_runs.get(case.case_id)).runs) is None
    assert (await app_state.cases.get(case.case_id)).status == CaseStatus.NEEDS_HUMAN


@pytest.mark.asyncio
async def test_abandon_is_refused_while_runbooks_are_off(app_state, monkeypatch) -> None:
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-abandon-off")
    prefs = app_state.prefs
    await app_state.update_prefs(prefs.model_copy(update={
        "runbooks": prefs.runbooks.model_copy(update={"enabled": False}),
    }))
    with pytest.raises(R.RunbookRunError) as err:
        await R.abandon_run(app_state, case, run.run_id, "Wrong runbook", actor="asha", context=None)
    assert err.value.status_code == 409 and err.value.code == "runbook_state"
    assert (await app_state.runbook_runs.get(case.case_id)).run(run.run_id).status == "active"
    assert "run.abandoned" not in _actions(await _rows(app_state, case.case_id))


# --------------------------------------------------------------------------- #
# Reading: progress and redaction
# --------------------------------------------------------------------------- #
def test_case_progress_sums_runs_that_are_not_abandoned() -> None:
    entry = _custom_runbook()
    one = R._new_run("c", entry, attached_by="person", attached_reason={}, actor="a", now="2026-10-28T10:00:00Z")
    two = one.model_copy(update={"run_id": "run-two"})
    gone = one.model_copy(update={"run_id": "run-gone", "status": "abandoned"})
    total = R.case_progress([one, two, gone])
    assert total is not None and total.total == 10 and total.required_open == 8


def _with_lookup(run: Any, step_id: str, result: LookupResult) -> Any:
    st = run.steps[step_id].model_copy(update={"evidence": [StepEvidence(kind="lookup_result", lookup=result)]})
    return run.model_copy(update={"steps": {**run.steps, step_id: st}})


def test_redaction_follows_each_tools_grant() -> None:
    entry = _custom_runbook()
    run = R._new_run("c", entry, attached_by="person", attached_reason={}, actor="a", now="2026-10-28T10:00:00Z")
    logs = LookupResult(tool="log_stats", status="ok", count=12, ran_at="2026-10-28T10:00:00Z",
                        params={"ip": "203.0.113.7"}, facts=[{"label": "Events", "value": "12"}],
                        table={"columns": ["Field", "Value", "Events"], "rows": [["user", "root", "12"]]},
                        table_kind="aggregate")
    run = _with_lookup(run, "look", logs)
    run = _with_lookup(run, "tell-owner", logs.model_copy(update={"tool": "mitre"}))
    shown = R.redact_run(run, lambda resource, action: resource != "sources")
    hidden = shown.steps["look"].evidence[0].lookup
    assert hidden.reason == "You do not have access to log data."
    assert hidden.facts == [] and hidden.table is None and hidden.params == {} and hidden.count is None
    assert shown.steps["tell-owner"].evidence[0].lookup.count == 12
    # The stored run is never changed by redaction.
    assert run.steps["look"].evidence[0].lookup.count == 12
    assert R.redact_run(run, lambda *_: True) is run
    # A redacted result never tells whether matching data exists, or whether the
    # lookup failed or was clamped: ok, partial, empty and error results read the same.
    deny = lambda resource, action: resource != "sources"  # noqa: E731
    variants = [
        logs,
        logs.model_copy(update={"status": "partial", "count_relation": "gte", "window_clamped": True}),
        LookupResult(tool="log_stats", status="empty", count=0, ran_at="2026-10-28T10:00:00Z",
                     params={"ip": "203.0.113.7"}, facts=[{"label": "Events", "value": "0"}]),
        LookupResult(tool="log_stats", status="error", ran_at="2026-10-28T10:00:00Z",
                     reason="The log source could not be read."),
    ]
    redacted = [R.redact_lookup(v, deny) for v in variants]
    assert all(r == redacted[0] for r in redacted)
    assert redacted[0].status == "not_applicable" and redacted[0].window_clamped is False


def test_run_summary_for_case_chat_has_no_lookup_results() -> None:
    entry = _custom_runbook()
    run = R._new_run("c", entry, attached_by="person", attached_reason={}, actor="a", now="2026-10-28T10:00:00Z")
    summary = R.run_summary([run])
    assert summary == [{
        "title": "Custom approval runbook", "version": 1, "status": "active",
        "progress": R.run_progress(run).model_dump(), "next_step": "Is the alert real?", "required_open": 4,
    }]


# --------------------------------------------------------------------------- #
# The case.runbook channel
# --------------------------------------------------------------------------- #
def test_case_runbook_channel_is_registered() -> None:
    assert CASE_RUNBOOK_EVENT == "case.runbook" and CASE_RUNBOOK_EVENT in SSE_EVENT_TYPES
    assert RUNBOOKS_TOPIC == "runbooks"


def test_runbooks_topic_needs_both_grants() -> None:
    topics = ["runbooks", "cases", "cases:case-1", "jobs"]
    assert gate_realtime_topics(topics, lambda *_: True) == topics
    no_runbooks = gate_realtime_topics(topics, lambda r, a: r != "runbooks")
    assert no_runbooks == ["cases", "cases:case-1", "jobs"]
    no_cases = gate_realtime_topics(topics, lambda r, a: r != "cases")
    assert no_cases == ["jobs"]


@pytest.mark.asyncio
async def test_a_run_write_publishes_progress_only_after_save(app_state, monkeypatch) -> None:
    bus = app_state.event_bus
    seen: list[tuple[str, str, Any]] = []
    original = bus.publish

    def spy(topic, event_type, data, **kw):
        seen.append((topic, event_type, data))
        return original(topic, event_type, data, **kw)

    monkeypatch.setattr(bus, "publish", spy)
    case, run = await _custom_run(app_state, monkeypatch, case_id="case-sse")
    frames = [d for t, e, d in seen if e == CASE_RUNBOOK_EVENT]
    assert frames and all(t == RUNBOOKS_TOPIC for t, e, _ in seen if e == CASE_RUNBOOK_EVENT)
    frame = frames[-1]
    assert set(frame) == {"case_id", "run_id", "progress", "revision"}
    assert frame["case_id"] == case.case_id and frame["run_id"] == run.run_id
    assert frame["progress"]["total"] == 5
    stored = await app_state.runbook_runs.get(case.case_id)
    assert frame["revision"] == stored.revision


# --------------------------------------------------------------------------- #
# Demo Mode: runs and their rows stay in the Demo stack (§3.5)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_demo_runs_are_audited_in_the_demo_audit(app_state: AppState) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    try:
        case = await _saved(app_state, _case("case-demo-1"))
        result = await R.attach_by_person(app_state, case, GENERIC, note=None, actor="asha", context=None)
        assert result.run is not None
        demo_rows = await app_state.execution_audit.records_for_case(case.case_id)
        assert any(r.get("action") == "run.attached" for r in demo_rows)
        real_rows = await app_state.control_audit.records_for_case(case.case_id)
        assert not any(r.get("action") == "run.attached" for r in real_rows)
    finally:
        await app_state.disable_demo()
    assert (await app_state.runbook_runs.get("case-demo-1")).runs == ()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
@pytest.fixture
def runs_client(secrets, mock_provider):
    from app.api.routes import router

    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    api.include_router(case_routes.router)
    mount_moved_routers(api)
    with TestClient(api) as client:
        yield client


def _seed(client: TestClient, case: Case) -> AppState:
    state: AppState = client.app.state.tlsoc
    client.portal.call(state.cases.save, case)
    return state


def test_routes_attach_read_update_and_conflict(runs_client: TestClient) -> None:
    state = _seed(runs_client, _case("case-http"))
    created = runs_client.post("/api/cases/case-http/runbooks", json={"runbook_id": GENERIC, "note": "start"})
    assert created.status_code == 201, created.text
    run = created.json()["run"]
    again = runs_client.post("/api/cases/case-http/runbooks", json={"runbook_id": GENERIC})
    assert again.status_code == 200 and again.json()["already_attached"] is True
    view = runs_client.get("/api/cases/case-http/runbooks")
    assert view.status_code == 200
    assert [r["runbook_id"] for r in view.json()["runs"]] == [GENERIC]
    assert run["run_id"] in view.json()["progress"]
    path = f"/api/cases/case-http/runbooks/{run['run_id']}/steps/what-happened"
    ok = runs_client.patch(path, json={"expected_revision": 0, "note": "Seen on two hosts."})
    assert ok.status_code == 200, ok.text
    stale = runs_client.patch(path, json={"expected_revision": 0, "note": "again"})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["code"] == "runbook_conflict"
    assert detail["latest"]["run"]["steps"]["what-happened"]["note"] == "Seen on two hosts."
    assert runs_client.get("/api/cases/nope/runbooks").status_code == 404
    missing = runs_client.patch(f"/api/cases/case-http/runbooks/{run['run_id']}/steps/nope",
                                json={"expected_revision": 0, "note": "x"})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "step_not_found"
    assert runs_client.post("/api/cases/case-http/runbooks/run-nope/abandon",
                            json={"reason": "x"}).json()["detail"]["code"] == "run_not_found"
    assert state is not None


def test_route_refuses_a_performed_at_with_no_utc_form_as_step_state(runs_client: TestClient) -> None:
    """A time before the first representable UTC instant parses, but cannot be stored:
    the PATCH answers ``409 step_state`` (never an unhandled 500) and changes nothing."""
    _seed(runs_client, _case("case-early"))
    run = runs_client.post("/api/cases/case-early/runbooks", json={"runbook_id": BRUTE}).json()["run"]
    path = f"/api/cases/case-early/runbooks/{run['run_id']}/steps/block-source"
    early = runs_client.patch(path, json={"expected_revision": 0, "action_record": {
        "where": "Firewall", "outcome": "Blocked", "performed_at": "0001-01-01T00:00:00+05:00"}})
    assert early.status_code == 409, early.text
    assert early.json()["detail"] == {
        "code": "step_state",
        "message": "Give the time the action was performed as a date and time, not in the future."}
    view = runs_client.get("/api/cases/case-early/runbooks").json()
    assert view["runs"][0]["steps"]["block-source"]["action_record"] is None
    ok = runs_client.patch(path, json={"expected_revision": 0, "action_record": {
        "where": "Firewall", "outcome": "Blocked", "performed_at": "2026-10-28T10:00:00+05:30"}})
    assert ok.status_code == 200, ok.text
    assert ok.json()["run"]["steps"]["block-source"]["action_record"]["performed_at"] == "2026-10-28T04:30:00Z"


def test_routes_candidates_and_progress(runs_client: TestClient) -> None:
    _seed(runs_client, _case("case-cand"))
    _seed(runs_client, _case("case-empty", rule="nothing_matches_this"))
    cands = runs_client.get("/api/cases/case-cand/runbooks/candidates").json()["candidates"]
    assert cands[0]["id"] == BRUTE and cands[0]["group"] == "best"
    assert any(c["group"] == "fallback" and c["id"] == GENERIC for c in cands)
    assert any(c["group"] == "all" for c in cands)
    filtered = runs_client.get("/api/cases/case-cand/runbooks/candidates", params={"q": "ransom"}).json()
    assert [c["id"] for c in filtered["candidates"]] == ["ransomware-destructive"]
    runs_client.post("/api/cases/case-cand/runbooks", json={"runbook_id": BRUTE})
    after = runs_client.get("/api/cases/case-cand/runbooks/candidates").json()["candidates"]
    assert BRUTE not in [c["id"] for c in after]
    progress = runs_client.post("/api/runbooks/progress", json={"case_ids": ["case-cand", "case-empty", "x"]})
    assert progress.status_code == 200
    body = progress.json()
    assert list(body) == ["case-cand"] and body["case-cand"]["total"] == 11
    too_many = runs_client.post("/api/runbooks/progress", json={"case_ids": [f"c{i}" for i in range(101)]})
    assert too_many.status_code == 422


def test_routes_decision_switch_abandon(runs_client: TestClient) -> None:
    _seed(runs_client, _case("case-flow"))
    run = runs_client.post("/api/cases/case-flow/runbooks", json={"runbook_id": BRUTE}).json()["run"]
    base = f"/api/cases/case-flow/runbooks/{run['run_id']}"
    decided = runs_client.patch(f"{base}/steps/decide",
                                json={"expected_revision": 0, "decision": {"option_id": "benign"}})
    assert decided.status_code == 200, decided.text
    steps = decided.json()["run"]["steps"]
    assert steps["block-source"]["status"] == "not_applicable"
    assert steps["reset-accounts"]["status"] == "not_applicable"
    same = runs_client.post(f"{base}/switch-version", json={"version": 1})
    assert same.status_code == 200 and same.json()["run"]["version"] == 1
    gone = runs_client.post(f"{base}/abandon", json={"reason": "Duplicate work"})
    assert gone.status_code == 200 and gone.json()["run"]["status"] == "abandoned"
    again = runs_client.post(f"{base}/abandon", json={"reason": "again"})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "runbook_state"
