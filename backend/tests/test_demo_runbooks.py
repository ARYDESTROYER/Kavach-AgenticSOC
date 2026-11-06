"""Round 14 closing acceptance (FX5m): the seeded Demo history, as the pipeline would
have left it (SPEC §3.5, §4.4.4, §4.10.9, §4.10.18, D45).

Offline: the fake Elasticsearch store, the mock LLM, the deterministic generator. Pins:

* every seeded case carries exactly one ``{"event": "decision"}`` history entry, the one
  ``case_manager.apply()`` writes, and it is what ``decide()`` returns for the case; an
  automatic close is recorded as one, every other case as routed to a person, so the
  recorded-decision figures (the Executive summary's Closed by the AI agent) agree
  with the Human vs AI split (integ-02);
* a case an analyst closed was routed to a person when it was opened, acknowledged by
  its analyst minutes later (inside the response target) and resolved by the same
  analyst later still, so its response and resolution times and the seeded run worked
  on it take real time, and the Demo SLA attainment is what the routing alone gave; a
  completed seeded run has a positive duration, its steps lie between the
  acknowledgement and the close, and ``GET /api/runbooks/metrics`` reports positive
  durations (qa3-06);
* every person the seeded history names (an assignee, a comment author, the analyst
  who acknowledged and closed a case, whoever worked a run) is on the Demo SOC team or
  is the triage automation, never a member of the Demo organisation's staff and never
  the account a case is about, and a run is worked by its case's analyst (qa3-05);
* every investigated seeded case carries the runbook the investigator read, from the
  same match as the seeded run, under the operator's switches (runbooks, investigator
  guidance, the fallback) and the guidance character budget, so ``GET /api/metrics``
  "Runbook usage" agrees with the Runbooks library and the case's Runbook tab
  (composites-02, integ-05).
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.deps import require_auth
from app.api.routes import router as main_router
from app.api.routes_metrics import router as metrics_router
from app.api.routes_runbooks import router as runbooks_router
from app.config import Preferences
from app.constants import CaseStatus, DecisionBy, EntityType, Verdict
from app.engine import demo_generator as gen
from app.engine import runbook_model
from app.engine.case_manager import decide
from app.engine.demo_runtime import demo_builtin_catalog
from app.engine.metrics import decision_record, lifecycle_intervals, sla_metrics
from app.engine.precedent import is_policy_closed
from app.models import Case, Entity
from app.utils import now_utc, to_millis

SEEDS = (1337, 7, 42, 20261104)
#: The Demo organisation's staff (the same list for every seed).
_STAFF = frozenset(employee.user.lower() for employee in gen.build_org(SEEDS[0]).employees)
_TERMINAL = frozenset({CaseStatus.RESOLVED.value, CaseStatus.CLOSED.value})


def _seeded(seed: int, *, now_ms: int | None = None, history_days: int = 30) -> list[Case]:
    """Every case the Demo seed builds for ``seed`` (history, the recent trio and the
    capability cases), in enable order."""
    now_ms = now_ms if now_ms is not None else to_millis(now_utc())
    org = gen.build_org(seed)
    history = gen.generate_historical_cases(seed, org, history_days=history_days, run_id="r", now_millis=now_ms)
    recent, _hits = gen.generate_recent_preseed(seed, org, run_id="r", now_millis=now_ms)
    hitl, tuner = gen.generate_capability_seed_cases(seed, org, run_id="r", now_millis=now_ms)
    return [*history, *recent, *hitl, *tuner]


def _moment(value: Any) -> datetime:
    moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _value(member: Any) -> str:
    return str(getattr(member, "value", member) or "")


# --------------------------------------------------------------------------- #
# Decision records (integ-02)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("seed", SEEDS)
def test_every_seeded_case_carries_the_decision_record_the_pipeline_writes(seed: int) -> None:
    defaults = Preferences()
    for case in _seeded(seed):
        entries = [e for e in case.history if isinstance(e, dict) and e.get("event") == "decision"]
        assert len(entries) == 1, case.case_id
        entry = entries[0]
        assert set(entry) == {"ts", "event", "status", "decision_by", "escalate", "rationale"}
        # Exactly what decide() returns for the case under the shipped default policy.
        decision = decide(case.verdict, case.confidence, case.risk_score, gen.SEED_AUTO_CLOSE_POLICY,
                          escalation_confidence=defaults.escalation_confidence,
                          critical_severity=defaults.critical_severity)
        assert entry == {"ts": case.created_at, "event": "decision", "status": decision.status.value,
                         "decision_by": decision.decision_by.value, "escalate": decision.escalate,
                         "rationale": decision.rationale}
        # decide() only ever returns agent or system (an analyst never decides here).
        assert entry["decision_by"] in (DecisionBy.AGENT.value, DecisionBy.SYSTEM.value)
        # The record agrees with the case: an automatic close was recorded as one,
        # every other case as routed to a person.
        agent_close = case.decision_by == DecisionBy.AGENT and _value(case.status) == CaseStatus.CLOSED.value
        assert (entry["decision_by"] == DecisionBy.AGENT.value and entry["status"] == "closed") == agent_close
        record = decision_record(case)
        assert record is not None and record.auto_closed == agent_close


def test_the_seeded_confidence_clears_the_bar_only_for_an_automatic_close() -> None:
    bar = gen.SEED_AUTO_CLOSE_POLICY.false_positive.min_confidence
    for case in _seeded(1337):
        if case.decision_by == DecisionBy.AGENT:
            assert case.confidence >= bar, case.case_id
        elif case.verdict == Verdict.FALSE_POSITIVE:
            assert case.confidence < bar, case.case_id


def test_the_seeded_facts_depend_on_the_seed_only() -> None:
    """The confidence is one draw for every case, whatever the outcome, and the
    resolution delay is drawn per case id, so the facts the seed's stream fixes
    (entities, members, personas, costs) do not depend on when the seed runs."""
    cases = _seeded(1337)
    assert len({c.case_id for c in cases}) == len(cases)
    again = _seeded(1337, now_ms=to_millis(_moment(cases[0].created_at)) + 10 ** 9)
    assert [(c.case_id, c.entity.value, c.member_event_ids, c.agent_persona, c.token_cost) for c in cases] == [
        (c.case_id, c.entity.value, c.member_event_ids, c.agent_persona, c.token_cost) for c in again]


# --------------------------------------------------------------------------- #
# Analyst-closed cases take time (qa3-06)
# --------------------------------------------------------------------------- #
def _analyst_closed(cases: list[Case]) -> list[Case]:
    return [c for c in cases if c.decision_by == DecisionBy.ANALYST and _value(c.status) in _TERMINAL]


@pytest.mark.parametrize("seed", SEEDS)
def test_an_analyst_closed_case_is_routed_acknowledged_then_resolved(seed: int) -> None:
    now_ms = to_millis(now_utc())
    now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    closed = _analyst_closed(_seeded(seed, now_ms=now_ms))
    assert closed
    for case in closed:
        opened, resolved = _moment(case.created_at), _moment(case.updated_at)
        routed, acknowledged, finished = case.status_history
        assert (routed.from_status, routed.by, routed.at) == ("new", DecisionBy.SYSTEM.value, case.created_at)
        assert routed.to_status in (CaseStatus.ESCALATED.value, CaseStatus.NEEDS_HUMAN.value)
        # The analyst acknowledged it (the Acknowledge action: investigating, with
        # acknowledged_at), then closed it; the history names them, as live moves do.
        analyst = acknowledged.by
        assert analyst in gen.DEMO_SOC_ANALYSTS and analyst != gen.demo_case_subject(case)
        assert (acknowledged.from_status, acknowledged.to_status) == (
            routed.to_status, CaseStatus.INVESTIGATING.value)
        assert (finished.from_status, finished.to_status, finished.by) == (
            CaseStatus.INVESTIGATING.value, _value(case.status), analyst)
        assert case.acknowledged_at is not None and _moment(acknowledged.at) == case.acknowledged_at
        ack_minutes = (case.acknowledged_at - opened).total_seconds() / 60
        assert opened <= case.acknowledged_at <= resolved
        assert 2 <= ack_minutes <= 12 or case.acknowledged_at == resolved, (case.case_id, ack_minutes)
        assert finished.at == case.updated_at
        minutes = (resolved - opened).total_seconds() / 60
        # 30 to 240 minutes after it was opened, never after the seed ran.
        assert resolved <= now
        assert 30 <= minutes <= 240 or resolved == now, (case.case_id, minutes)
        if routed.to_status == CaseStatus.ESCALATED.value:
            assert case.escalation_level >= 1
    # Most analyst-closed cases are older than four hours: they take the full delay.
    assert sum(1 for c in closed if (_moment(c.updated_at) - _moment(c.created_at)).total_seconds() >= 1800) >= (
        len(closed) // 2)


@pytest.mark.parametrize("seed", SEEDS)
def test_an_analyst_closed_case_meets_its_response_target(seed: int) -> None:
    """The acknowledgement is the first response a person makes, within the tightest
    target of the default SLA policy, so the close (minutes or hours later) never
    reads as a late first response, and MTTA is measured on the Demo history."""
    prefs = Preferences()
    now = now_utc()
    cases = _seeded(seed, now_ms=to_millis(now))
    closed = _analyst_closed(cases)
    sla = sla_metrics(closed, prefs.sla, now=now, prefs=prefs)
    assert sla["evaluated"] == len(closed) > 0
    assert sla["response_breached"] == 0 and sla["response_at_risk"] == 0
    mtta = lifecycle_intervals(cases)["mtta_minutes"]
    assert mtta["count"] >= len(closed) and 2 <= mtta["p50"] <= 12


def test_other_seeded_cases_keep_their_single_status_entry() -> None:
    for case in _seeded(1337):
        if case.decision_by == DecisionBy.ANALYST:
            continue
        assert len(case.status_history) == 1 and case.updated_at == case.created_at, case.case_id
        assert case.acknowledged_at is None, case.case_id


@pytest.mark.parametrize("seed", SEEDS)
def test_every_person_the_seed_names_is_on_the_demo_soc_team(seed: int) -> None:
    """Assignees and comment authors are the Demo SOC team or the triage automation,
    never a member of the Demo organisation's staff and never the case's subject."""
    allowed = {*gen.DEMO_SOC_ANALYSTS, "auto-triage"}
    named = 0
    for case in _seeded(seed):
        subject = gen.demo_case_subject(case)
        people = {p for p in (case.assignee, *(c.author for c in case.comments)) if p}
        people |= {e.by for e in case.status_history if e.by not in ("system", "agent")}
        named += bool(people)
        assert people <= allowed, (case.case_id, people)
        assert not {p.lower() for p in people} & _STAFF, case.case_id
        assert subject not in {p.lower() for p in people}, case.case_id
    assert named


def _timing(**medians: float | None) -> Any:
    from app.engine import demo_chat

    lifecycle = {f"{key}_minutes": ({"measured": True, "p50": value, "count": 5} if value is not None
                                    else {"measured": False}) for key, value in medians.items()}
    return demo_chat.Result(1, "soc_metrics", "ok", "", (),
                            {"kind": "timing", "window": "last 30 days", "lifecycle_minutes": lifecycle})


def test_the_response_times_takeaway_states_two_medians_once_mtta_is_measured() -> None:
    """With the acknowledgement seeded, every response clock is measured on the Demo
    history: the answer states the two the question names (else acknowledgement and
    resolution) and points to the rest, never every figure of the block (T15)."""
    from app.engine import demo_chat

    timing = _timing(mttd=9.8, mtta=6, mttr=0, dwell=6)
    said = demo_chat._say_timing(timing)  # noqa: SLF001
    assert "MTTA p50 6 min" in said and "MTTR p50 0 min" in said
    assert "MTTD p50" not in said and "MTTD is in the figures below" in said and "dwell" not in said
    focused = demo_chat._say_timing(timing, demo_chat._timing_focus("how has mttd changed?"))  # noqa: SLF001
    assert focused.index("MTTD p50 9.8 min") < focused.index("MTTA p50 6 min") and "MTTR is in the figures" in focused
    one = demo_chat._say_timing(timing, ("mttr_minutes",), most=1)  # noqa: SLF001
    assert "MTTR p50 0 min" in one and "MTTA and MTTD are in the figures below" in one
    # A clock not measured yet is said so, and states no figure.
    partly = demo_chat._say_timing(_timing(mttd=9.8, mtta=None, mttr=0))  # noqa: SLF001
    assert "MTTA not measured yet" in partly and "MTTR p50 0 min" in partly and "MTTD p50 9.8 min" in partly
    assert demo_chat._timing_focus("show the cases contributing to the acknowledgement delay") == (  # noqa: SLF001
        "mtta_minutes",)
    assert demo_chat._timing_focus("what are our response times?") == ()  # noqa: SLF001


def test_a_question_that_names_dwell_always_gets_its_median() -> None:
    """Dwell is no figure of the Response times block, so it never takes one of the two
    places the takeaway rule (T15) gives the block's clocks: a question that names it
    with other clocks gets its median beside theirs, and the block clocks still number
    at most two."""
    from app.engine import demo_chat

    timing = _timing(mttd=9.8, mtta=6, mttr=101, dwell=6)
    focus = demo_chat._timing_focus("what are our mtta, mttr and dwell?")  # noqa: SLF001
    assert focus == ("mtta_minutes", "mttr_minutes", "dwell_minutes")
    said = demo_chat._say_timing(timing, focus)  # noqa: SLF001
    assert said == ("Response times in the last 30 days: MTTA p50 6 min over 5 cases, MTTR p50 101 min over 5 "
                    "cases and dwell p50 6 min over 5 cases; MTTD is in the figures below.")
    assert sum(f"{name} p50" in said for name in ("MTTA", "MTTR", "MTTD")) == 2
    # The trend answer gives the block one place per clock it follows (MTTA here):
    # dwell is still stated, and the block clocks the question left out are pointed to.
    trend = demo_chat._say_timing(timing, demo_chat._timing_focus("how have mtta and dwell changed?"),  # noqa: SLF001
                                  most=1)
    assert trend == ("Response times in the last 30 days: MTTA p50 6 min over 5 cases and dwell p50 6 min over 5 "
                     "cases; MTTR and MTTD are in the figures below.")
    # Named first, dwell leads, and the two block places still go to the clocks asked
    # for, then acknowledgement and resolution.
    first = demo_chat._say_timing(timing, demo_chat._timing_focus("dwell and mttd"))  # noqa: SLF001
    assert first.index("dwell p50 6 min") < first.index("MTTD p50 9.8 min") < first.index("MTTA p50 6 min")
    assert "MTTR is in the figures below" in first
    # Unasked, dwell takes only a place the block clocks left free, and is never
    # pointed to (the block does not show it).
    spare = demo_chat._say_timing(_timing(mttd=None, mtta=6, mttr=None, dwell=6))  # noqa: SLF001
    assert "MTTA p50 6 min" in spare and "dwell p50 6 min" in spare
    full = demo_chat._say_timing(timing)  # noqa: SLF001
    assert "dwell" not in full and "MTTD is in the figures below" in full
    # Asked but not measured yet: said so, with no figure.
    unmeasured = demo_chat._say_timing(_timing(mttd=9.8, mtta=6, mttr=101, dwell=None),  # noqa: SLF001
                                       demo_chat._timing_focus("mtta and dwell?"))
    assert "dwell not measured yet" in unmeasured and "dwell p50" not in unmeasured


def test_a_question_that_names_dwell_is_told_where_it_is_when_the_lookup_has_none() -> None:
    """The chat's response-time lookup reports MTTD, MTTA and MTTR only, so a question
    that names dwell gets the asked clocks it has and is told where the console shows
    dwell; one that does not name it gets no such sentence."""
    from app.engine import demo_chat

    timing = _timing(mttd=9.8, mtta=6, mttr=101)  # no dwell entry, as the live lookup returns
    asked = demo_chat._say_timing(timing, demo_chat._timing_focus("what are our mtta, mttr and dwell?"))  # noqa: SLF001
    assert asked == ("Response times in the last 30 days: MTTA p50 6 min over 5 cases and MTTR p50 101 min over 5 "
                     "cases; MTTD is in the figures below. Dwell (time to first response) is not one of these "
                     "figures; Analytics › Metrics shows it on the Performance tab.")
    only = demo_chat._say_timing(timing, demo_chat._timing_focus("what is our dwell time?"))  # noqa: SLF001
    assert only.startswith("Response times in the last 30 days: MTTA p50 6 min over 5 cases and MTTR p50 101 min")
    assert only.endswith("Analytics › Metrics shows it on the Performance tab.")
    unasked = demo_chat._say_timing(timing, demo_chat._timing_focus("what is our mttr?"))  # noqa: SLF001
    assert "Dwell" not in unasked and "Performance tab" not in unasked
    # Nothing to say about the asked clocks: no sentence at all, as before.
    assert demo_chat._say_timing(_timing(), ("dwell_minutes",)) == ""  # noqa: SLF001


def test_a_drawn_analyst_who_is_the_subject_hands_the_case_to_the_next_teammate() -> None:
    first, second, third = gen.DEMO_SOC_ANALYSTS
    assert gen._not_the_subject(first, first) == second  # noqa: SLF001
    assert gen._not_the_subject(third, third) == first  # noqa: SLF001
    assert gen._not_the_subject(first, "pnair") == first  # noqa: SLF001
    assert gen._not_the_subject("auto-triage", "") == "auto-triage"  # noqa: SLF001


# --------------------------------------------------------------------------- #
# Seeded runs: who and how long (qa3-05, qa3-06)
# --------------------------------------------------------------------------- #
def test_the_demo_soc_team_is_not_on_the_demo_organisations_staff_list() -> None:
    assert gen.DEMO_SOC_ANALYSTS
    assert not {a.lower() for a in gen.DEMO_SOC_ANALYSTS} & _STAFF
    assert "auto-triage" not in gen.DEMO_SOC_ANALYSTS


def test_a_case_subject_is_read_from_every_form_a_source_names_a_person_by() -> None:
    def user(value: str) -> Case:
        return Case(case_id="c", cluster_signature="s", source_surface="investigate",
                    entity=Entity(type=EntityType.USER, value=value))

    assert gen.demo_case_subject(user("pnair")) == "pnair"
    assert gen.demo_case_subject(user("PNair@lumenpay.example")) == "pnair"
    assert gen.demo_case_subject(user("LUMENPAY\\pnair")) == "pnair"
    host = Case(case_id="h", cluster_signature="s", source_surface="investigate",
                entity=Entity(type=EntityType.HOST, value="asha.iyer"))
    assert gen.demo_case_subject(host) == ""
    # A Demo analyst is never given a case about their own account.
    assert "asha.iyer" not in gen._demo_run_people(user("asha.iyer@lumenpay.example"))  # noqa: SLF001


def _people(run: Any) -> set[str]:
    out: set[str] = set()
    for state in run.steps.values():
        out.update(p for p in (state.completed_by, (state.decision or {}).get("by"),
                               (state.action_record or {}).get("performed_by")) if p)
    return out


@pytest.mark.parametrize("seed", SEEDS)
def test_seeded_run_work_is_done_by_the_demo_soc_team(seed: int) -> None:
    now_ms = to_millis(now_utc())
    cases = _seeded(seed, now_ms=now_ms)
    runs = gen.plan_demo_runbook_runs(cases, demo_builtin_catalog(), prefs=Preferences(), seed=seed,
                                      now_millis=now_ms)
    assert runs
    by_id = {c.case_id: c for c in cases}
    worked = 0
    for run in runs:
        people = _people(run)
        worked += bool(people)
        assert people <= set(gen.DEMO_SOC_ANALYSTS), (run.case_id, people)
        assert not {p.lower() for p in people} & _STAFF
        case = by_id[run.case_id]
        subject = gen.demo_case_subject(case)
        assert subject not in {p.lower() for p in people}
        # The case's analyst works its run: the assignee, or the analyst who
        # acknowledged and closed it, so the header and every step agree.
        analyst = case.assignee if case.assignee in gen.DEMO_SOC_ANALYSTS else next(
            (e.by for e in reversed(case.status_history) if e.by in gen.DEMO_SOC_ANALYSTS), "")
        if analyst and people:
            assert people == {analyst}, (run.case_id, analyst, people)
    assert worked


@pytest.mark.parametrize("seed", SEEDS)
def test_a_completed_seeded_run_takes_real_time(seed: int) -> None:
    now_ms = to_millis(now_utc())
    cases = _seeded(seed, now_ms=now_ms)
    by_id = {c.case_id: c for c in cases}
    runs = gen.plan_demo_runbook_runs(cases, demo_builtin_catalog(), prefs=Preferences(), seed=seed,
                                      now_millis=now_ms)
    completed = [r for r in runs if r.status == "completed"]
    assert completed
    for run in completed:
        case = by_id[run.case_id]
        attached, finished = _moment(run.attached_at), _moment(run.completed_at)
        closed = _moment(case.updated_at)
        assert _moment(case.created_at) < attached < finished <= closed, run.case_id
        assert (finished - attached).total_seconds() >= 60, run.case_id
        moments = sorted((_moment(st.started_at), _moment(st.completed_at)) for st in run.steps.values()
                         if st.status == "done" and st.started_at)
        # A person works the steps once they have taken the case.
        taken = max(attached, case.acknowledged_at) if case.acknowledged_at else attached
        assert moments and all(taken <= start <= end <= finished for start, end in moments)
        # The steps are minutes apart, not one instant.
        assert len({end for _start, end in moments}) == len(moments)


# --------------------------------------------------------------------------- #
# Investigator guidance (composites-02, integ-05)
# --------------------------------------------------------------------------- #
def test_guidance_follows_the_runbook_switches_and_the_match() -> None:
    catalog = demo_builtin_catalog()
    cases = _seeded(1337)
    assert gen.seed_demo_runbook_guidance(cases, catalog, prefs=Preferences()) == len(cases)
    assert all(c.runbook_id and c.runbook_version for c in cases)
    assert {c.runbook_id for c in cases} <= {m.id for m in catalog}

    for switch in ("enabled", "investigator_guidance"):
        prefs = Preferences()
        setattr(prefs.runbooks, switch, False)
        fresh = _seeded(1337)
        assert gen.seed_demo_runbook_guidance(fresh, catalog, prefs=prefs) == 0
        assert not any(c.runbook_id for c in fresh)

    # A case closed by an analyst rule never reached the investigator.
    policy = _seeded(1337)[0].model_copy(update={"verdict": None, "decision_by": DecisionBy.ANALYST_POLICY,
                                                 "analyst_policy": {"policy_id": "p"}})
    assert is_policy_closed(policy)
    assert gen.demo_investigator_guidance(policy, catalog, prefs=Preferences()) is None


def _with_a_case_no_runbook_covers(cases: list[Case]) -> list[Case]:
    """``cases`` plus a copy of the first investigated one raised by a rule no runbook's
    Applies when names, so only the fallback would give it a runbook."""
    first = next(c for c in cases if c.verdict is not None and _value(c.status) not in _TERMINAL)
    stray = first.model_copy(deep=True, update={"case_id": "demo-stray-0000", "cluster_signature": "demo-stray",
                                                "rule_ids": ["demo_rule_no_runbook_covers"]})
    return [*cases, stray]


def test_guidance_without_the_fallback_never_names_generic_incident() -> None:
    """With the fallback off a case no runbook's Applies when matches gets no guidance
    (as the live pipeline gives none), every other case keeps its match, and every
    seeded run still names its case's runbook."""
    catalog = demo_builtin_catalog()
    on = _with_a_case_no_runbook_covers(_seeded(1337))
    assert gen.seed_demo_runbook_guidance(on, catalog, prefs=Preferences()) == len(on)
    assert on[-1].runbook_id == "generic-incident"   # the fallback is what covers it
    prefs = Preferences()
    prefs.runbooks.fallback = False
    now_ms = to_millis(now_utc())
    cases = _with_a_case_no_runbook_covers(_seeded(1337, now_ms=now_ms))
    assert gen.seed_demo_runbook_guidance(cases, catalog, prefs=prefs) == len(cases) - 1
    assert cases[-1].runbook_id is None and cases[-1].runbook_version is None
    assert not any(c.runbook_id == "generic-incident" for c in cases)
    assert [c.runbook_id for c in cases[:-1]] == [c.runbook_id for c in on[:-1]]
    by_id = {c.case_id: c for c in cases}
    runs = gen.plan_demo_runbook_runs(cases, catalog, prefs=prefs, seed=1337, now_millis=now_ms)
    assert runs and not any(r.runbook_id == "generic-incident" for r in runs)
    assert "demo-stray-0000" not in {r.case_id for r in runs}
    for run in runs:
        case = by_id[run.case_id]
        assert (case.runbook_id, case.runbook_version) == (run.runbook_id, run.version)


def test_guidance_over_the_character_budget_is_not_given(monkeypatch: pytest.MonkeyPatch) -> None:
    """A runbook whose rendering is over the guidance budget is not read by the
    investigator, so no seeded case says it was."""
    catalog = demo_builtin_catalog()
    case = next(c for c in _seeded(1337) if c.verdict is not None)
    assert gen.demo_investigator_guidance(case, catalog, prefs=Preferences()) is not None
    monkeypatch.setattr(runbook_model, "MAX_RUNBOOK_PROMPT_CHARS", 10)
    assert gen.demo_investigator_guidance(case, catalog, prefs=Preferences()) is None
    cases = _seeded(1337)
    assert gen.seed_demo_runbook_guidance(cases, catalog, prefs=Preferences()) == 0
    assert not any(c.runbook_id for c in cases)


def test_a_seeded_run_and_its_case_guidance_name_the_same_runbook() -> None:
    catalog = demo_builtin_catalog()
    now_ms = to_millis(now_utc())
    cases = _seeded(1337, now_ms=now_ms)
    gen.seed_demo_runbook_guidance(cases, catalog, prefs=Preferences())
    by_id = {c.case_id: c for c in cases}
    runs = gen.plan_demo_runbook_runs(cases, catalog, prefs=Preferences(), seed=1337, now_millis=now_ms)
    assert runs
    for run in runs:
        case = by_id[run.case_id]
        assert (case.runbook_id, case.runbook_version) == (run.runbook_id, run.version)


def _api(state: Any) -> FastAPI:
    api = FastAPI()
    for router in (main_router, metrics_router, runbooks_router):
        api.include_router(router, dependencies=[Depends(require_auth)])
    api.state.tlsoc = state
    return api


async def test_demo_metrics_runbook_usage_agrees_with_the_seeded_runs(app_state: Any) -> None:
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=30)
    try:
        cases, total = await app_state.cases.list(limit=2000, offset=0)
        assert total == len(cases) > 0
        async with AsyncClient(transport=ASGITransport(app=_api(app_state)), base_url="http://test") as client:
            response = await client.get("/api/metrics", params={"window_hours": 24})
            assert response.status_code == 200, response.text
            usage = response.json()["runbook_usage"]
            recorded = (await client.get("/api/metrics/auto-close-health/recorded",
                                         params={"window_hours": 8760, "anchor": "first"})).json()["current"]
        # Before the fix the panel read {"none": <every case>}.
        assert set(usage) != {"none"}
        assert usage == dict(Counter(c.runbook_id or "none" for c in cases))
        investigated = [c for c in cases if c.verdict is not None and not is_policy_closed(c)]
        assert sum(n for key, n in usage.items() if key != "none") == len(investigated)
        selector_runs = 0
        for case in cases:
            doc = await app_state.runbook_runs.get(case.case_id)
            for run in (doc.runs if doc is not None else []):
                if run.attached_actor == "runbook_selector":
                    selector_runs += 1
                    assert case.runbook_id == run.runbook_id, case.case_id
        assert selector_runs > 0
        # The recorded first decisions are measured and agree with Human vs AI.
        agent_closed = sum(1 for c in cases if c.decision_by == DecisionBy.AGENT
                           and _value(c.status) == CaseStatus.CLOSED.value)
        assert recorded["available"] is True and recorded["no_decision_record"] == 0
        assert recorded["decided"] == len(investigated) and recorded["auto_closed"] == agent_closed > 0
    finally:
        await app_state.disable_demo()


async def test_demo_runbook_metrics_report_the_time_seeded_work_took(app_state: Any) -> None:
    """``GET /api/runbooks/metrics`` on the seeded Demo: every completed run took real
    time, so the per-runbook medians and the completed-run cohort's time to resolve
    are positive (they read 0 when every step was done at one instant, qa3-06)."""
    await app_state.enable_demo(mode="seeded", seed=1337, history_days=30)
    try:
        async with AsyncClient(transport=ASGITransport(app=_api(app_state)), base_url="http://test") as client:
            response = await client.get("/api/runbooks/metrics")
        assert response.status_code == 200, response.text
        body = response.json()
        recent = [r for r in body.get("recent_runs") or [] if r.get("status") == "completed"]
        assert recent and all((r.get("duration_minutes") or 0) > 0 for r in recent), recent
        completed = [row for row in body.get("per_runbook") or [] if (row.get("completed") or 0) > 0]
        assert completed and all((row.get("median_minutes_to_complete") or 0) > 0 for row in completed), completed
        cohort = (body.get("cohorts") or {}).get("with_completed_run") or {}
        assert (cohort.get("mttr_p50_minutes") or 0) > 0, cohort
    finally:
        await app_state.disable_demo()
