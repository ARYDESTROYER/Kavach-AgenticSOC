"""Demo runbook runs show the lookup evidence a live run collects, and only that
(Round 14 SPEC §3.5, §4.10.8, §4.10.18).

The Demo seed (``engine.demo_generator.plan_demo_runbook_runs``) is pure: it never
reads a log source, the case store or the member events a lookup binds from, so it
writes no lookup result. A figure it wrote would be made up, and "Run lookup" on the
same step would contradict it. Once Demo Mode is active,
``collect_demo_runbook_lookups`` runs each seeded lookup with the live engine
(``runbook_runs.execute_lookup``) against the Demo stores, at the moment
``demo_lookup_schedule`` gives: an ``on_attach`` lookup right after the attachment, by
the system; an ``on_demand`` one on a step a person finished, by that person, when
they started it.

Pins: the plan holds no lookup figure; every collected result equals what the live
engine returns for the same step at the moment it says it ran (every Demo source
searched, a value found only in the case's member events bound as live); the Demo
audit dates each row when its lookup ran; a result a person got stands and a second
collection writes nothing; nothing is read while Demo Mode is off and a Demo switch
drops the work; an enrichment lookup in Demo Mode says Demo Mode never calls
providers, not that a Settings switch the operator never touched is off.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.agents.pipeline import builtin_runbook_catalog
from app.config import Preferences
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import runbook_lookup as lookups
from app.engine import runbook_runs as R
from app.engine.demo_generator import (
    collect_demo_runbook_lookups,
    demo_evidence_audit_row,
    demo_lookup_schedule,
    demo_runbook_audit_rows,
    demo_runbook_run_id,
    plan_demo_runbook_runs,
    schedule_demo_runbook_lookups,
)
from app.models import RUNBOOK_SYSTEM_RUNNER, Case, Entity, LookupResult, LookupTemplate, RunbookRun, StepEvidence
from app.state import AppState
from app.utils import now_utc, to_millis

IP = "203.0.113.7"
NOW = now_utc()
NOW_MS = to_millis(NOW)
SEED = 1337
LOG_TOOLS = ("log_stats", "log_search")


def _iso(delta: timedelta) -> str:
    return (NOW - delta).isoformat()


def _moment(value: str) -> datetime:
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _case(case_id: str, *, created_ago: timedelta, entity: Entity | None = None, rule: str = "sshd",
          closed_by_person: bool = False, closed_by_agent: bool = False, verdict: Verdict = Verdict.TRUE_POSITIVE,
          members: int = 5, **extra: Any) -> Case:
    created = _iso(created_ago)
    fields: dict[str, Any] = {
        "case_id": case_id, "cluster_signature": f"sig-{case_id}", "source_surface": SourceSurface.INVESTIGATE,
        "entity": entity or Entity(type=EntityType.IP, value=IP), "status": CaseStatus.NEEDS_HUMAN,
        "verdict": verdict, "confidence": 0.8, "risk_score": 70.0, "title": f"Case {case_id}",
        "rule_ids": [rule], "created_at": created, "updated_at": created, "case_number": f"CASE-{case_id[-4:]}",
        "member_event_ids": [f"{case_id}-evt-{i}" for i in range(members)],
    }
    if closed_by_person:
        fields.update(status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST,
                      updated_at=_iso(created_ago - timedelta(hours=2)))
    if closed_by_agent:
        fields.update(status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT, verdict=Verdict.FALSE_POSITIVE)
    fields.update(extra)
    return Case(**fields)


def _plan(cases: list[Case], prefs: Preferences | None = None) -> dict[str, RunbookRun]:
    runs = plan_demo_runbook_runs(cases, builtin_runbook_catalog(), prefs=prefs or Preferences(), seed=SEED,
                                  now_millis=NOW_MS)
    return {r.case_id: r for r in runs}


def _lookup_steps(run: RunbookRun) -> list[Any]:
    return [s for s in run.snapshot.steps if s.kind == "lookup" and s.lookup is not None]


def _result(run: RunbookRun, step_id: str) -> LookupResult | None:
    evidence = [e for e in run.steps[step_id].evidence if e.kind == "lookup_result"]
    assert len(evidence) <= 1
    return evidence[0].lookup if evidence else None


@pytest.fixture
def brute_force_world() -> list[Case]:
    """An analyst-closed brute-force case on one IP, two earlier cases on that IP in
    the last 30 days, one older than that, and one on another IP (auto-closed, so
    nobody works them and they get no run)."""
    return [
        _case("case-0001", created_ago=timedelta(hours=6), closed_by_person=True,
              trigger_reason=None, first_seen_millis=0),
        _case("case-0002", created_ago=timedelta(days=2), closed_by_agent=True),
        _case("case-0003", created_ago=timedelta(days=10), closed_by_agent=True),
        _case("case-0004", created_ago=timedelta(days=40), closed_by_agent=True),
        _case("case-0005", created_ago=timedelta(days=3), closed_by_agent=True,
              entity=Entity(type=EntityType.IP, value="198.51.100.9")),
    ]


# --------------------------------------------------------------------------- #
# The plan and the schedule (pure)
# --------------------------------------------------------------------------- #
def test_the_plan_holds_no_lookup_figure(brute_force_world: list[Case]) -> None:
    """The planner reads no log, store or member event, so it writes no result: a
    seeded step shows what the live engine collects for it, or "Run lookup"."""
    plan = _plan(brute_force_world)
    assert plan
    for run in plan.values():
        for state in run.steps.values():
            assert not [e for e in state.evidence if e.kind == "lookup_result"]


def test_automatic_lookups_run_by_the_system_after_the_attachment_and_before_any_work(
        brute_force_world: list[Case]) -> None:
    run = _plan(brute_force_world)["case-0001"]
    assert run.runbook_id == "brute-force-password-spray" and run.status == "completed"
    assert run.run_id == demo_runbook_run_id(SEED, "case-0001", run.runbook_id)
    schedule = demo_lookup_schedule(run, seed=SEED, now=NOW)
    # Every lookup of this runbook runs on attach: each is collected, whatever later
    # happened to its step.
    assert [item.step.id for item in schedule] == [s.id for s in R.ordered_steps(run.snapshot)
                                                   if s.kind == "lookup" and s.lookup is not None]
    attached = _moment(run.attached_at).replace(microsecond=0)
    first_start = min(_moment(st.started_at) for st in run.steps.values() if st.started_at)
    for item in schedule:
        assert item.step.lookup.run == "on_attach"
        assert item.ran_by == RUNBOOK_SYSTEM_RUNNER
        assert attached <= item.ran_at <= first_start and item.ran_at.microsecond == 0


def test_an_on_demand_lookup_is_run_by_the_person_who_worked_the_step() -> None:
    host = Entity(type=EntityType.HOST, value="lap-0042")
    case = _case("case-0010", created_ago=timedelta(hours=8), closed_by_person=True, entity=host, rule="defender")
    run = _plan([case])["case-0010"]
    assert run.runbook_id == "malware-endpoint"
    items = {item.step.id: item for item in demo_lookup_schedule(run, seed=SEED, now=NOW)}
    item = items["process-activity"]
    assert item.step.lookup.run == "on_demand" and item.step.lookup.tool == "log_search"
    state = run.steps["process-activity"]
    assert state.status == "done"
    assert item.ran_by == state.completed_by and item.ran_by != RUNBOOK_SYSTEM_RUNNER
    assert item.ran_at == _moment(state.started_at).replace(microsecond=0)


def test_an_open_run_leaves_an_unworked_on_demand_lookup_to_a_person() -> None:
    host = Entity(type=EntityType.HOST, value="lap-0043")
    case = _case("case-0011", created_ago=timedelta(hours=8), entity=host, rule="defender",
                 status=CaseStatus.NEEDS_HUMAN, verdict=Verdict.NEEDS_HUMAN)
    run = _plan([case])["case-0011"]
    assert run.status == "active"
    scheduled = {item.step.id for item in demo_lookup_schedule(run, seed=SEED, now=NOW)}
    for step in _lookup_steps(run):
        if step.lookup.run == "on_attach":
            assert step.id in scheduled
        elif run.steps[step.id].status != "done":
            assert step.id not in scheduled  # nobody ran it yet: the step offers "Run lookup"
    assert any(s.lookup.run == "on_demand" and s.id not in scheduled for s in _lookup_steps(run))


def test_a_run_worked_within_seconds_still_collects_before_the_work() -> None:
    """A run whose first step started two seconds after the attachment: its automatic
    lookups are collected in between, never after the person started."""
    run = _plan([_case("case-0012", created_ago=timedelta(hours=6), closed_by_person=True)])["case-0012"]
    attached = _moment(run.attached_at).replace(microsecond=0)
    steps = {sid: st.model_copy() for sid, st in run.steps.items()}
    first = next(sid for sid, st in steps.items() if st.started_at)
    for sid, st in steps.items():
        if st.started_at:
            st.started_at = (attached + timedelta(seconds=2 if sid == first else 600)).isoformat()
    tight = run.model_copy(update={"steps": steps})
    for item in demo_lookup_schedule(tight, seed=SEED, now=NOW):
        if item.ran_by == RUNBOOK_SYSTEM_RUNNER:
            assert attached <= item.ran_at <= attached + timedelta(seconds=2)


def test_the_plan_and_the_schedule_are_deterministic(brute_force_world: list[Case]) -> None:
    first = _plan(brute_force_world)
    again = _plan(brute_force_world)
    assert {k: v.model_dump() for k, v in first.items()} == {k: v.model_dump() for k, v in again.items()}
    for case_id, run in first.items():
        assert demo_lookup_schedule(run, seed=SEED, now=NOW) == demo_lookup_schedule(again[case_id], seed=SEED, now=NOW)


def test_the_planned_rows_hold_no_lookup_row_and_a_collected_row_is_the_live_one(
        brute_force_world: list[Case]) -> None:
    run = _plan(brute_force_world)["case-0001"]
    rows = demo_runbook_audit_rows(run, brute_force_world[0])
    assert "step.evidence_collected" not in {r["action"] for r in rows}
    collected = LookupResult(tool="log_stats", status="ok", count=4, ran_at="2026-10-28T10:00:05Z",
                             ran_by=RUNBOOK_SYSTEM_RUNNER, facts=[{"label": "Events", "value": "4"}])
    row = demo_evidence_audit_row(run, brute_force_world[0], "accounts-tried", collected)
    assert row["ts"] == collected.ran_at and row["action"] == "step.evidence_collected"
    assert row["actor"] == RUNBOOK_SYSTEM_RUNNER and row["actor_type"] == "system"
    assert row["case_id"] == "case-0001" and row["target"].label == "CASE-0001"
    # The live engine's own per-status wording (``runbook_runs.lookup_evidence_summary``).
    assert row["result_summary"] == "Log statistics lookup collected evidence."
    assert row["tool_input"] == {"run_id": run.run_id, "step_id": "accounts-tried", "tool": "log_stats",
                                 "status": "ok", "count": 4, "count_relation": "eq"}
    by_person = demo_evidence_audit_row(run, brute_force_world[0], "accounts-tried",
                                        collected.model_copy(update={"ran_by": "asha"}))
    assert by_person["actor"] == "asha" and by_person["actor_type"] == "human"
    # A run that holds a result lists its row with the others, in time order.
    steps = dict(run.steps)
    steps["accounts-tried"] = steps["accounts-tried"].model_copy(update={"evidence": [
        StepEvidence(kind="lookup_result", lookup=collected.model_copy(update={"ran_at": run.attached_at}))]})
    with_result = run.model_copy(update={"steps": steps})
    rows = demo_runbook_audit_rows(with_result, brute_force_world[0])
    assert [r["action"] for r in rows].count("step.evidence_collected") == 1


# --------------------------------------------------------------------------- #
# The collection, through the live engine against the Demo stores
# --------------------------------------------------------------------------- #
async def _demo(state: AppState) -> list[Case]:
    await state.enable_demo(mode="seeded", seed=SEED, history_days=1)
    await R.wait_for_background_lookups(30)
    cases, _total, _exact = await state.cases.list_window(limit=1000)
    assert cases
    return cases


async def _seeded_runs(state: AppState, cases: list[Case]) -> list[tuple[Case, RunbookRun]]:
    by_id = {c.case_id: c for c in cases}
    stored = await state.runbook_runs.get_many(list(by_id))
    return [(by_id[case_id], run) for case_id, case_runs in stored.items() for run in case_runs.runs
            if run.run_id == demo_runbook_run_id(SEED, case_id, run.runbook_id)]


@pytest.mark.asyncio
async def test_every_collected_result_is_what_the_live_engine_returns(app_state: AppState) -> None:
    cases = await _demo(app_state)
    try:
        await collect_demo_runbook_lookups(app_state, cases, seed=SEED)
        # Every result is in place: a second collection writes nothing.
        assert await collect_demo_runbook_lookups(app_state, cases, seed=SEED) == 0
        sources = len(app_state._chat_browse_targets(app_state.execution_prefs))  # noqa: SLF001
        assert sources > 1
        tools: Counter[str] = Counter()
        event_only: list[tuple[str, str]] = []
        rows_checked = 0
        for case, run in await _seeded_runs(app_state, cases):
            schedule = demo_lookup_schedule(run, seed=SEED, now=now_utc())
            stored_rows = [r for r in await app_state.audit.records_for_case(case.case_id)
                           if r.get("action") == "step.evidence_collected"]
            for item in schedule:
                result = _result(run, item.step.id)
                assert result is not None, (case.case_id, item.step.id)
                assert result.ran_by == item.ran_by and result.tool == item.step.lookup.tool
                tools[result.tool] += 1
                # The same lookup, run live at the moment the result says it ran.
                again = await R.execute_lookup(app_state, case, item.step.lookup, ran_by=result.ran_by,
                                               now=_moment(result.ran_at))
                assert result.model_dump() == again.model_dump(), (case.case_id, item.step.id)
                if result.tool in LOG_TOOLS:
                    facts = {f["label"]: f["value"] for f in result.facts}
                    # Every Demo source is searched, as "Run lookup" searches them.
                    assert facts["Sources searched"] == str(sources)
                    assert result.status in ("ok", "empty", "partial")
                bare = lookups.case_values_from_case(case)
                event_only += [(case.case_id, kind) for kind in ("ip", "host", "user", "domain")
                               if result.params.get(kind) and not bare.entities.get(kind)]
                # One Demo audit row per result, dated when the lookup ran.
                mine = [r for r in stored_rows if r["tool_input"]["step_id"] == item.step.id
                        and r["tool_input"]["run_id"] == run.run_id]
                assert len(mine) == 1
                assert _moment(mine[0]["ts"]) == _moment(result.ran_at) and mine[0]["actor"] == result.ran_by
                assert mine[0]["actor_type"] == ("system" if result.ran_by == RUNBOOK_SYSTEM_RUNNER else "human")
                rows_checked += 1
        assert rows_checked and tools["log_stats"] and tools["enrich"]
        # A value only the member events carry binds as it does live (a stored case
        # keeps one entity), so no seeded step reads "This case has no ..." wrongly.
        assert event_only, "expected a seeded lookup bound from the case's member events"
    finally:
        await app_state.disable_demo()


@pytest.mark.asyncio
async def test_enrichment_in_demo_mode_names_demo_mode_not_a_settings_switch(app_state: AppState) -> None:
    case = Case(case_id="case-real-enrich", cluster_signature="sig-real-enrich",
                source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=EntityType.IP, value=IP),
                status=CaseStatus.NEEDS_HUMAN, rule_ids=["sshd"])
    template = LookupTemplate(tool="enrich", indicator="{{entity.ip}}")
    # Outside Demo Mode with enrichment turned off, the Settings switch is the reason.
    off = app_state.prefs.model_copy(deep=True)
    off.enrichment.enabled = False
    await app_state.update_prefs(off)
    real = await R.execute_lookup(app_state, case, template, ran_by="asha", load_events=False)
    assert real.status == "not_applicable" and real.reason == "Enrichment is turned off in Settings."
    on = app_state.prefs.model_copy(deep=True)
    on.enrichment.enabled = True
    await app_state.update_prefs(on)
    cases = await _demo(app_state)
    try:
        assert app_state.prefs.enrichment.enabled  # the page the person can open says on
        demo = await R.execute_lookup(app_state, case, template, ran_by="asha", load_events=False)
        assert demo.status == "not_applicable" and demo.reason == R.DEMO_ENRICHMENT_REASON
        await collect_demo_runbook_lookups(app_state, cases, seed=SEED)
        reasons = Counter(
            result.reason for _case_, run in await _seeded_runs(app_state, cases)
            for step in _lookup_steps(run) if step.lookup.tool == "enrich"
            for result in [_result(run, step.id)] if result is not None
        )
        assert reasons[R.DEMO_ENRICHMENT_REASON]
        assert "Enrichment is turned off in Settings." not in reasons
        # A case without the indicator says so first, as live.
        assert all(r == R.DEMO_ENRICHMENT_REASON or (r or "").startswith("This case has no") for r in reasons)
    finally:
        await app_state.disable_demo()


@pytest.mark.asyncio
async def test_a_persons_result_stands_and_a_demo_switch_drops_the_work(
        app_state: AppState, monkeypatch: pytest.MonkeyPatch) -> None:
    cases = await _demo(app_state)
    try:
        await collect_demo_runbook_lookups(app_state, cases, seed=SEED)
        seeded = [(case, run) for case, run in await _seeded_runs(app_state, cases)
                  if demo_lookup_schedule(run, seed=SEED, now=now_utc())]
        assert len(seeded) >= 2
        store = app_state.runbook_runs
        # A result a person got with "Run lookup" is never replaced by the seed.
        (case, run), (other_case, other_run) = seeded[0], seeded[1]
        step_id = demo_lookup_schedule(run, seed=SEED, now=now_utc())[0].step.id
        mine = LookupResult(tool=_result(run, step_id).tool, status="ok", count=999, ran_at="2026-10-28T10:00:00Z",
                            ran_by="asha", facts=[{"label": "Events", "value": "999"}])
        await store.record_lookup_result(case.case_id, run.run_id, step_id, mine)
        assert await collect_demo_runbook_lookups(app_state, cases, seed=SEED) == 0
        assert _result((await store.get(case.case_id)).run(run.run_id), step_id).count == 999

        # A run whose results are gone, collected while Demo Mode switches: nothing
        # is stored for the stack that is no longer active.
        def strip(runs: list[RunbookRun]) -> tuple[list[RunbookRun], None]:
            for r in runs:
                for sid, st in list(r.steps.items()):
                    r.steps[sid] = st.model_copy(update={"evidence": [e for e in st.evidence
                                                                      if e.kind != "lookup_result"]})
            return runs, None

        await store.mutate(other_case.case_id, strip)
        calls: list[str] = []

        async def switching(state: Any, case: Any, template: Any, **kw: Any) -> LookupResult:
            calls.append(template.tool)
            state._demo_generation += 1  # noqa: SLF001 - Demo Mode switched while it ran
            return LookupResult(tool=template.tool, status="ok", count=1, ran_at=kw["now"].isoformat(),
                                ran_by=kw["ran_by"])

        monkeypatch.setattr(R, "execute_lookup", switching)
        assert await collect_demo_runbook_lookups(app_state, [other_case], seed=SEED) == 0
        assert calls
        after = (await store.get(other_case.case_id)).run(other_run.run_id)
        assert all(_result(after, item.step.id) is None
                   for item in demo_lookup_schedule(after, seed=SEED, now=now_utc()))
    finally:
        await app_state.disable_demo()


@pytest.mark.asyncio
async def test_nothing_is_read_while_demo_mode_is_off(app_state: AppState, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def spy(*_a: Any, **_k: Any) -> LookupResult:  # pragma: no cover - must not run
        calls.append("execute")
        raise AssertionError("no lookup runs outside Demo Mode")

    monkeypatch.setattr(R, "execute_lookup", spy)
    case = _case("case-0099", created_ago=timedelta(hours=1))
    assert await collect_demo_runbook_lookups(app_state, [case], seed=SEED) == 0
    assert schedule_demo_runbook_lookups(app_state, [case], seed=SEED) is None
    assert calls == []


@pytest.mark.asyncio
async def test_the_background_start_is_tracked_with_the_other_background_lookups(app_state: AppState) -> None:
    cases = await _demo(app_state)
    try:
        task = schedule_demo_runbook_lookups(app_state, cases, seed=SEED)
        assert task is not None and task in R._BACKGROUND  # noqa: SLF001
        await R.wait_for_background_lookups(30)
        assert task.done() and isinstance(task.result(), int)
        seeded = await _seeded_runs(app_state, cases)
        assert all(_result(run, item.step.id) is not None
                   for _case_, run in seeded for item in demo_lookup_schedule(run, seed=SEED, now=now_utc()))
    finally:
        await app_state.disable_demo()


@pytest.mark.asyncio
async def test_enabling_demo_mode_collects_the_seeded_lookups_by_itself(app_state: AppState) -> None:
    # Demo Mode's enable starts the collection: with no explicit collect call, every
    # scheduled lookup of a seeded run carries its result once the background work ends.
    cases = await _demo(app_state)
    try:
        seeded = await _seeded_runs(app_state, cases)
        scheduled = [(case, run, item) for case, run in seeded
                     for item in demo_lookup_schedule(run, seed=SEED, now=now_utc())]
        assert scheduled
        assert all(_result(run, item.step.id) is not None for _case, run, item in scheduled)
        assert await collect_demo_runbook_lookups(app_state, cases, seed=SEED) == 0
    finally:
        await app_state.disable_demo()
