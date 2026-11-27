"""Round 15 WP1: people's work survives a rebuild of the case (SPEC D6.10).

The case stores write the whole document, and three pipeline builders rebuild an open
case from a cluster: ``_assemble_case`` (an investigation, then ``apply()``),
``_fail_to_human_case`` (a failed run) and ``_register_candidate_locked`` (a candidate
re-registered below the risk floor). One helper, ``_carry_case_work``, carries in all
three exactly: ``assignee``, ``comments``, ``feedback``, ``status_history`` (appended
to), ``acknowledged_at``, ``status_reason``, ``notifications_sent``, and the disposition
only when an analyst explicitly classified it and the case still carries it. ``status``
is carried only as ``apply()``'s previous status, so the appended transition names the
real previous status; ``escalation_level`` is never carried. ``decide()`` is untouched.

The investigation re-reads the stored case just before it rebuilds (and again on the
failure path), so work a person does while the run is in flight is carried too, and a
failed run keeps the case's display number.

Offline: fake Elasticsearch, mock model.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from app.agents.pipeline import _carry_case_work, _fail_to_human_case
from app.config import Preferences
from app.constants import CaseStatus, DecisionBy, Disposition, EntityType, SourceSurface, Verdict
from app.engine.case_manager import CaseManager
from app.models import (
    Case,
    CaseComment,
    Cluster,
    Entity,
    EvidenceItem,
    FeedbackEntry,
    StatusHistoryEntry,
    VerdictResult,
)
from app.utils import now_utc
from tests.test_case_actions_reinvestigate import _create_case, _final_verdict, _route_to_investigator

CASE_MANAGER = Path(__file__).resolve().parent.parent / "app" / "engine" / "case_manager.py"
#: ``engine/case_manager.py`` as it stands; Round 15 changes nothing in it (#3).
CASE_MANAGER_MD5 = "212873cd13d822a7b64752635285ff1f"


def _cluster(sig: str = "sig-carry") -> Cluster:
    return Cluster(signature=sig, entity=Entity(type=EntityType.IP, value="192.0.2.77"),
                   group_by=EntityType.IP, rule_values=["linux_auth"], risk_score=55.0)


def _worked_case(*, status: CaseStatus = CaseStatus.ESCALATED, classified: bool = True) -> Case:
    """An open case a person has worked: acknowledged, owned, commented, graded,
    escalated and (when ``classified``) explicitly classified."""
    history = [{"ts": "2026-11-20T09:00:00+00:00", "event": "analyst_action", "action": "acknowledge",
                "analyst": "ann", "note": ""}]
    if classified:
        history.append({"ts": "2026-11-20T09:30:00+00:00", "event": "analyst_action",
                        "action": "set_disposition", "analyst": "ann", "note": "",
                        "classified_disposition": "true_positive"})
    return Case(
        case_id="case-carry", case_number="CASE-0100", cluster_signature="sig-carry",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="192.0.2.77"), verdict=Verdict.NEEDS_HUMAN,
        confidence=0.4, risk_score=55.0, status=status, decision_by=DecisionBy.ANALYST,
        disposition=Disposition.TRUE_POSITIVE, escalation_level=1,
        assignee="ann", comments=[CaseComment(author="ann", body="seen it")],
        feedback=[FeedbackEntry(ts="2026-11-20T09:40:00+00:00", analyst="ann", assessment="disagree",
                                actual_outcome="true_positive", ai_verdict="NEEDS_HUMAN")],
        status_history=[
            StatusHistoryEntry(from_status="open", to_status="needs_human", by="system",
                               at="2026-11-20T08:00:00+00:00"),
            StatusHistoryEntry(from_status="needs_human", to_status="investigating", by="ann",
                               at="2026-11-20T09:00:00+00:00"),
            StatusHistoryEntry(from_status="investigating", to_status=status.value, by="ann",
                               at="2026-11-20T09:50:00+00:00"),
        ],
        acknowledged_at=now_utc(), status_reason="waiting on the owner",
        notifications_sent=[{"channel": "email", "trigger": "escalated", "ts": "2026-11-20T09:51:00+00:00"}],
        history=history, created_at="2026-11-20T08:00:00+00:00", updated_at="2026-11-20T09:51:00+00:00",
    )


def _assert_work_carried(existing: Case, rebuilt: Case) -> None:
    assert rebuilt.assignee == "ann"
    assert [c.body for c in rebuilt.comments] == ["seen it"]
    assert rebuilt.feedback == existing.feedback
    assert rebuilt.acknowledged_at == existing.acknowledged_at
    assert rebuilt.status_reason == "waiting on the owner"
    assert rebuilt.notifications_sent == existing.notifications_sent
    assert rebuilt.status_history[: len(existing.status_history)] == existing.status_history


def test_case_manager_is_untouched() -> None:
    assert hashlib.md5(CASE_MANAGER.read_bytes()).hexdigest() == CASE_MANAGER_MD5  # noqa: S324


def test_nothing_is_carried_onto_a_new_case() -> None:
    fresh = Case(case_id="n1", cluster_signature="s", source_surface=SourceSurface.INVESTIGATE,
                 entity=Entity(type=EntityType.IP, value="192.0.2.1"))
    assert _carry_case_work(None, fresh) is fresh
    assert fresh.assignee == "" and fresh.feedback == [] and fresh.status_history == []


async def test_an_investigation_carries_the_work_and_names_the_real_previous_status(app_state) -> None:
    existing = _worked_case()
    verdict = VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3,
                            evidence=[EvidenceItem(summary="x")], recommended_action="look")
    prefs = Preferences()
    case = app_state.pipeline._assemble_case(  # noqa: SLF001
        existing.case_id, _cluster(), verdict, SourceSurface.AUTOMATED_SCAN, existing, 0.0, prefs,
    )
    # Before apply(): the stored status stands in only as apply()'s previous status.
    assert case.status == CaseStatus.ESCALATED
    assert case.escalation_level == 0  # never carried
    CaseManager(prefs).apply(case)
    assert case.status == CaseStatus.NEEDS_HUMAN and case.decision_by == DecisionBy.SYSTEM
    _assert_work_carried(existing, case)
    appended = case.status_history[-1]
    assert (appended.from_status, appended.to_status, appended.by) == ("escalated", "needs_human", "system")
    assert len(case.status_history) == len(existing.status_history) + 1
    # The analyst's explicit classification survives the re-verdict.
    assert case.disposition == Disposition.TRUE_POSITIVE


async def test_an_unclassified_disposition_follows_the_new_verdict(app_state) -> None:
    existing = _worked_case(classified=False)  # TRUE_POSITIVE but nobody declared it
    verdict = VerdictResult(verdict=Verdict.FALSE_POSITIVE, confidence=0.4)
    prefs = Preferences()
    case = app_state.pipeline._assemble_case(  # noqa: SLF001
        existing.case_id, _cluster(), verdict, SourceSurface.AUTOMATED_SCAN, existing, 0.0, prefs,
    )
    assert case.disposition is None
    CaseManager(prefs).apply(case)
    assert case.disposition == Disposition.FALSE_POSITIVE


def test_a_failed_run_carries_the_work_and_records_the_move() -> None:
    existing = _worked_case(status=CaseStatus.INVESTIGATING)
    case = _fail_to_human_case("case-carry", _cluster(), SourceSurface.AUTOMATED_SCAN, "provider down",
                               existing, Preferences())
    assert case.status == CaseStatus.NEEDS_HUMAN and case.decision_by == DecisionBy.SYSTEM
    assert case.escalation_level == 0
    _assert_work_carried(existing, case)
    appended = case.status_history[-1]
    assert (appended.from_status, appended.to_status, appended.by) == ("investigating", "needs_human", "system")
    assert case.disposition == Disposition.TRUE_POSITIVE  # classified, carried


def test_a_failed_run_on_a_case_already_needing_a_person_appends_nothing() -> None:
    existing = _worked_case(status=CaseStatus.NEEDS_HUMAN)
    case = _fail_to_human_case("case-carry", _cluster(), SourceSurface.AUTOMATED_SCAN, "x", existing,
                               Preferences())
    assert case.status_history == existing.status_history


def test_a_failed_run_of_a_new_case_is_unchanged() -> None:
    case = _fail_to_human_case("case-new", _cluster("sig-new"), SourceSurface.AUTOMATED_SCAN, "x", None,
                               Preferences())
    assert case.status_history == [] and case.feedback == [] and case.assignee == ""
    assert case.disposition is None


def _candidate_with_work() -> Case:
    """An un-investigated candidate the system registered (no verdict, never moved by a
    person) that people have still worked on: owned, commented and graded. Round 16
    B04: only such a case is rebuilt as a candidate; a decided case, or one a person
    moved, attaches its events and is returned as it is."""
    return _worked_case(status=CaseStatus.OPEN).model_copy(update={
        "verdict": None, "confidence": 0.0, "decision_by": None, "escalation_level": 0,
    })


async def test_a_re_registered_candidate_carries_the_work(app_state) -> None:
    existing = _candidate_with_work()
    await app_state.cases.save(existing)
    case = await app_state.pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, app_state.prefs,
                                                       awaiting_reason="risk 10 is below the floor 70")
    assert case.case_id == existing.case_id and case.status == CaseStatus.OPEN
    assert case.awaiting_reason == "risk 10 is below the floor 70"  # rebuilt
    _assert_work_carried(existing, case)
    assert case.status_history == existing.status_history  # open to open: no move
    assert case.escalation_level == 0
    stored = await app_state.cases.get(existing.case_id)
    assert stored.assignee == "ann" and len(stored.feedback) == 1


async def test_a_decided_or_person_moved_case_is_never_rebuilt_as_a_candidate(app_state) -> None:
    """Round 16 B04: registering a candidate on an open case that has a verdict, or
    that a person moved, attaches the events and keeps the case as it is."""
    existing = _worked_case(status=CaseStatus.INVESTIGATING)  # verdict, decision_by ANALYST
    await app_state.cases.save(existing)
    case = await app_state.pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, app_state.prefs,
                                                       awaiting_reason="risk 10 is below the floor 70")
    stored = await app_state.cases.get(existing.case_id)
    for c in (case, stored):
        assert c.status == CaseStatus.INVESTIGATING and c.verdict == Verdict.NEEDS_HUMAN
        assert c.decision_by == DecisionBy.ANALYST and c.escalation_level == 1
        assert c.status_history == existing.status_history and c.awaiting_reason == ""


def test_a_reinvestigation_keeps_the_analysts_work_end_to_end(client, mock_provider) -> None:
    """The close-flow probe: acknowledge, assign, comment and grade an open case, then
    reinvestigate it. Before Round 15 the rebuilt case lost all of it."""
    case_id = _create_case(client, mock_provider, "192.0.2.88", verdict="NEEDS_HUMAN", confidence=0.2)
    assert client.post(f"/api/cases/{case_id}/action", json={"action": "acknowledge"}).status_code == 200
    assert client.post(f"/api/cases/{case_id}/assign", json={"assignee": "ann"}).status_code == 200
    assert client.post(f"/api/cases/{case_id}/comment", json={"author": "ann", "body": "on it"}).status_code == 200
    graded = client.post(f"/api/cases/{case_id}/feedback",
                         json={"assessment": "disagree", "actual_outcome": "true_positive"})
    assert graded.status_code == 200
    before = client.get(f"/api/cases/{case_id}").json()
    assert before["status"] == "investigating"

    _route_to_investigator(mock_provider)
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.3))
    response = client.post(f"/api/cases/{case_id}/reinvestigate")
    assert response.status_code == 200, response.text
    after = response.json()
    assert after["case_id"] == case_id
    assert after["assignee"] == "ann"
    assert [c["body"] for c in after["comments"]] == ["on it"]
    assert [f["actual_outcome"] for f in after["feedback"]] == ["true_positive"]
    assert after["acknowledged_at"] == before["acknowledged_at"]
    assert after["status_history"][: len(before["status_history"])] == before["status_history"]
    last = after["status_history"][-1]
    assert (last["from_status"], last["to_status"]) == ("investigating", "needs_human")
    assert any(h.get("action") == "acknowledge" for h in after["history"] if h.get("event") == "analyst_action")


def test_a_failed_run_keeps_the_case_number() -> None:
    """A failed run must not empty the display number: the next run would mint a new one
    and the case would read under two numbers."""
    existing = _worked_case(status=CaseStatus.INVESTIGATING)
    case = _fail_to_human_case("case-carry", _cluster(), SourceSurface.AUTOMATED_SCAN, "provider down",
                               existing, Preferences())
    assert case.case_number == "CASE-0100"


# --------------------------------------------------------------------------- #
# Work a person does while the run is in flight (the rebuild re-reads the case)
# --------------------------------------------------------------------------- #
def _quiet_prefs(app_state) -> Preferences:
    """The suite's preferences without enrichment, so the run makes no lookup."""
    return app_state.prefs.model_copy(update={
        "enrichment": app_state.prefs.enrichment.model_copy(update={"enabled": False}),
    })


async def _work_on_the_stored_case(app_state, case_id: str) -> None:
    """What a person does to the open case while the agent is still working on it:
    assign, comment, grade, tag and act (one ``analyst_action`` history entry)."""
    stored = await app_state.cases.get(case_id)
    stored.assignee = "bob"
    stored.comments.append(CaseComment(author="bob", body="mid-run note"))
    stored.feedback.append(FeedbackEntry(ts="2026-11-20T10:05:00+00:00", analyst="bob",
                                         assessment="agree", ai_verdict="NEEDS_HUMAN"))
    stored.tags = ["mid-run"]
    stored.history.append({"ts": "2026-11-20T10:06:00+00:00", "event": "analyst_action",
                           "action": "set_disposition", "analyst": "bob", "note": "",
                           "classified_disposition": "true_positive"})
    await app_state.cases.save(stored)


def _assert_mid_run_work_kept(case: Case) -> None:
    assert case.assignee == "bob"
    assert [c.body for c in case.comments] == ["seen it", "mid-run note"]
    assert [f.analyst for f in case.feedback] == ["ann", "bob"]
    assert case.tags == ["mid-run"]
    assert any(h.get("analyst") == "bob" for h in case.history if h.get("event") == "analyst_action")
    assert case.case_number == "CASE-0100"


async def test_work_done_while_the_run_is_in_flight_survives_the_rebuild(app_state, monkeypatch) -> None:
    import app.agents.pipeline as pipeline_mod

    existing = _worked_case()
    await app_state.cases.save(existing)

    async def _run(*_args, **_kwargs):
        await _work_on_the_stored_case(app_state, existing.case_id)
        return VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3, recommended_action="look"), 0.0

    monkeypatch.setattr(pipeline_mod, "run_investigation", _run)
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet_prefs(app_state), force=True,
    )
    assert case.case_id == existing.case_id
    _assert_mid_run_work_kept(case)
    _assert_mid_run_work_kept(await app_state.cases.get(existing.case_id))
    assert case.status == CaseStatus.NEEDS_HUMAN


async def test_work_done_while_a_failing_run_is_in_flight_survives_too(app_state, monkeypatch) -> None:
    import app.agents.pipeline as pipeline_mod

    existing = _worked_case(status=CaseStatus.INVESTIGATING)
    await app_state.cases.save(existing)

    async def _run(*_args, **_kwargs):
        await _work_on_the_stored_case(app_state, existing.case_id)
        raise RuntimeError("provider fell over")

    monkeypatch.setattr(pipeline_mod, "run_investigation", _run)
    case = await app_state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.AUTOMATED_SCAN, _quiet_prefs(app_state), force=True,
    )
    assert case.status == CaseStatus.NEEDS_HUMAN and case.error
    _assert_mid_run_work_kept(case)
    _assert_mid_run_work_kept(await app_state.cases.get(existing.case_id))


async def test_a_failed_re_read_keeps_the_copy_read_when_the_run_began(app_state, monkeypatch) -> None:
    existing = _worked_case()
    pipeline = app_state.pipeline

    async def _boom(_case_id):
        raise ConnectionError("store unreachable")

    monkeypatch.setattr(pipeline._cases, "get", _boom)  # noqa: SLF001
    assert await pipeline._latest_stored_case(existing.case_id, existing) is existing  # noqa: SLF001
    assert await pipeline._latest_stored_case("case-new", None) is None  # noqa: SLF001


# --------------------------------------------------------------------------- #
# Round 16 B09: the automation record and the cross-source links survive too
# --------------------------------------------------------------------------- #
_AUTOMATION_RECORD = {"ts": "2026-11-20T09:52:00+00:00", "rule_id": "tag-high", "action": "tag",
                      "detail": "tag=high"}


def _linked(case: Case) -> Case:
    return case.model_copy(update={
        "automation_actions": [dict(_AUTOMATION_RECORD)],
        "related_case_ids": ["case-other"],
        "cross_source_cluster_id": "0123456789abcdef",
        "source_breakdown": {"src-1": 1, "src-2": 1},
    })


def _assert_links_carried(rebuilt: Case) -> None:
    assert rebuilt.automation_actions == [_AUTOMATION_RECORD]
    assert rebuilt.related_case_ids == ["case-other"]
    assert rebuilt.cross_source_cluster_id == "0123456789abcdef"
    assert rebuilt.source_breakdown == {"src-1": 1, "src-2": 1}


async def test_an_investigation_carries_the_automation_record_and_links(app_state) -> None:
    existing = _linked(_worked_case())
    verdict = VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3, recommended_action="look")
    case = app_state.pipeline._assemble_case(  # noqa: SLF001
        existing.case_id, _cluster(), verdict, SourceSurface.AUTOMATED_SCAN, existing, 0.0, Preferences(),
    )
    _assert_links_carried(case)


def test_a_failed_run_carries_the_automation_record_and_links() -> None:
    existing = _linked(_worked_case())
    case = _fail_to_human_case("case-carry", _cluster(), SourceSurface.AUTOMATED_SCAN, "x", existing,
                               Preferences())
    _assert_links_carried(case)


async def test_a_re_registered_candidate_carries_the_automation_record_and_links(app_state) -> None:
    existing = _linked(_candidate_with_work())
    await app_state.cases.save(existing)
    case = await app_state.pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, app_state.prefs,
                                                       awaiting_reason="risk 10 is below the floor 70")
    _assert_links_carried(case)
    _assert_links_carried(await app_state.cases.get(existing.case_id))


async def test_a_policy_close_keeps_the_automation_record(app_state) -> None:
    from app.config import AnalystRulePolicy

    existing = _linked(_candidate_with_work())
    await app_state.cases.save(existing)
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.analyst_rule_policies = [AnalystRulePolicy(rule_id="linux_auth", reason="lab", created_by="ann")]
    case = await app_state.pipeline.register_candidate(_cluster(), SourceSurface.AUTOMATED_SCAN, prefs)
    assert case.status == CaseStatus.CLOSED and case.decision_by == DecisionBy.ANALYST_POLICY
    assert case.automation_actions == [_AUTOMATION_RECORD]
    # Round 16 cross-cutting review: the close keeps the cross-source links and the
    # sent-notification record too, so a linked candidate never leaves the link one-sided.
    stored = await app_state.cases.get(existing.case_id)
    assert existing.notifications_sent  # the record the close must keep is not empty
    for closed in (case, stored):
        _assert_links_carried(closed)
        assert closed.notifications_sent == existing.notifications_sent
        assert closed.status_history[-1].to_status == "closed"
        assert closed.status_history[-1].by == DecisionBy.ANALYST_POLICY.value


async def test_a_later_automation_run_appends_after_the_carried_record(app_state) -> None:
    from app.config import AutomationRule, ThresholdAutomationConfig
    from app.engine.threshold_automation import ThresholdAutomation

    existing = _linked(_worked_case())
    verdict = VerdictResult(verdict=Verdict.NEEDS_HUMAN, confidence=0.3, recommended_action="look")
    prefs = Preferences()
    case = app_state.pipeline._assemble_case(  # noqa: SLF001
        existing.case_id, _cluster(), verdict, SourceSurface.AUTOMATED_SCAN, existing, 0.0, prefs,
    )
    CaseManager(prefs).apply(case)
    await app_state.cases.save(case)
    prefs.threshold_automation = ThresholdAutomationConfig(enabled=True, rules=[
        AutomationRule(id="tag-again", action="tag", payload={"tag": "again"}),
    ])
    await ThresholdAutomation(app_state.proposals, app_state.audit).run(
        case, prefs, save=app_state.cases.save, fetch=app_state.cases.get,
    )
    stored = await app_state.cases.get(existing.case_id)
    assert [a["rule_id"] for a in stored.automation_actions] == ["tag-high", "tag-again"]
