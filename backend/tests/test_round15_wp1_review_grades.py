"""Round 15 WP1: what an auto-close review grade feeds, and unrated sub-scores
(SPEC D4.5, D6.7, D6.8).

* ``engine.review_origin.is_review_grade`` is true for an entry marked
  ``origin="auto_close_review"``, or one an ``auto_close_review`` history event with a
  NON-EMPTY ``review_id`` names by its time and analyst (a previous build drops the
  entry fields and keeps the history); an ordinary grade, a history event without a
  review id, or one naming another time or analyst, is not;
* ``feedback_stats`` leaves review grades out, averages each sub-score over the grades
  that rated it, counts them (``*_rated``) and keeps ``0.0`` when nothing rated it;
* the ``agent_improvement`` feedback selection leaves review grades out (and says so),
  and a reopen made from a review is not counted as a human reopen of an agent close,
  but only when the case carries a ledger-backed review recorded at or before the
  reopen (``review_via`` alone, a marker the caller sends, hides nothing);
* review grades still feed every ground-truth reader (``analyst_confirmed_outcome``,
  the threshold tuner, the precedent corpus and ``ground_truth_supply``);
* the chat feedback tool says "not rated" for a sub-score nobody rated;
* ``engine/review_origin.py`` never imports the case manager (a review never decides).
"""

from __future__ import annotations

import ast
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import agent_improvement as ai
from app.engine.metrics import feedback_stats
from app.engine.review_origin import is_review_grade, review_events
from app.models import Case, Entity, FeedbackEntry, StatusHistoryEntry

APP = Path(__file__).resolve().parent.parent / "app"
TS = "2026-11-20T10:00:00+00:00"


def _case(cid: str, *, feedback: list[FeedbackEntry] | None = None, history: list[dict] | None = None,
          status_history: list[StatusHistoryEntry] | None = None) -> Case:
    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"), verdict=Verdict.FALSE_POSITIVE,
        confidence=0.95, risk_score=10.0, status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
        created_at="2026-11-19T00:00:00+00:00", updated_at=TS,
        feedback=feedback or [], history=history or [], status_history=status_history or [],
    )


def _grade(**kwargs) -> FeedbackEntry:
    base = {"ts": TS, "analyst": "rev", "assessment": "agree", "ai_verdict": "FALSE_POSITIVE"}
    base.update(kwargs)
    return FeedbackEntry(**base)


def _event(**kwargs) -> dict:
    base = {"event": "auto_close_review", "review_id": "acr-1", "feedback_ts": TS, "analyst": "rev",
            "ts": TS, "agrees": True}
    base.update(kwargs)
    return base


# --------------------------------------------------------------------------- #
# is_review_grade (D6.7)
# --------------------------------------------------------------------------- #
def test_the_entry_marker_makes_a_review_grade() -> None:
    entry = _grade(origin="auto_close_review", review_id="acr-1")
    assert is_review_grade(_case("c1", feedback=[entry]), entry) is True


def test_without_the_entry_marker_the_history_event_names_it() -> None:
    """A previous build drops ``origin`` and ``review_id`` on its next save; the history
    event, which it keeps, still names the grade by its time and analyst."""
    entry = _grade()
    case = _case("c2", feedback=[entry], history=[_event()])
    assert is_review_grade(case, entry) is True
    rolled_back = Case.model_validate(case.model_dump(mode="json"))  # what a full save keeps
    assert is_review_grade(rolled_back, rolled_back.feedback[0]) is True


@pytest.mark.parametrize("event", [
    _event(review_id=""),
    _event(review_id=None),
    _event(review_id="   "),
    _event(analyst="someone-else"),
    _event(feedback_ts="2026-11-20T10:00:01+00:00"),
    _event(event="analyst_action"),
])
def test_a_history_event_that_does_not_match_names_nothing(event: dict) -> None:
    entry = _grade()
    assert is_review_grade(_case("c3", feedback=[entry], history=[event]), entry) is False


def test_an_ordinary_grade_is_not_a_review_grade() -> None:
    ordinary = _grade(ts="2026-11-20T11:00:00+00:00", analyst="ann")
    review = _grade(origin="auto_close_review", review_id="acr-1")
    case = _case("c4", feedback=[review, ordinary], history=[_event()])
    assert is_review_grade(case, review) is True
    assert is_review_grade(case, ordinary) is False
    assert is_review_grade(case, None) is False
    assert [e["review_id"] for e in review_events(case)] == ["acr-1"]


def test_plain_mappings_are_read_too() -> None:
    case = {"history": [_event()]}
    assert is_review_grade(case, {"ts": TS, "analyst": "rev"}) is True
    assert is_review_grade(case, {"ts": TS, "analyst": "ann"}) is False
    assert is_review_grade({}, {"origin": "auto_close_review"}) is True
    assert is_review_grade({"history": "corrupt"}, {"ts": TS, "analyst": "rev"}) is False


def test_review_origin_never_imports_the_case_manager() -> None:
    tree = ast.parse((APP / "engine" / "review_origin.py").read_text(encoding="utf-8"))
    imported = [
        (node.module or "") if isinstance(node, ast.ImportFrom) else alias.name
        for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    ]
    assert not any("case_manager" in name for name in imported), imported


# --------------------------------------------------------------------------- #
# feedback_stats (D4.5, D6.8)
# --------------------------------------------------------------------------- #
def test_feedback_stats_leaves_review_grades_out() -> None:
    # The review grades carry stars (a review may rate the AI, D6.6): they must stay out
    # of the averages and the ``*_rated`` counts as well as out of the agreement.
    reviewed_only = _case("c5", feedback=[_grade(origin="auto_close_review", review_id="acr-5",
                                                  assessment="disagree", actual_outcome="true_positive",
                                                  accuracy=0.2, reasoning_quality=0.4,
                                                  action_appropriateness=0.6, time_saved_minutes=9)])
    rolled_back = _case("c6", feedback=[_grade(assessment="disagree", accuracy=0.2, reasoning_quality=0.4)],
                        history=[_event()])
    ordinary = _case("c7", feedback=[_grade(analyst="ann", assessment="agree", accuracy=0.8,
                                            time_saved_minutes=4, actual_outcome="false_positive")])
    stats = feedback_stats([reviewed_only, rolled_back, ordinary])
    assert stats["graded_cases"] == 1 and stats["feedback_count"] == 1
    assert stats["agreement_rate"] == 1.0 and stats["agreement_signals"] == 1
    assert stats["outcome_distribution"] == {"false_positive": 1}
    assert stats["time_saved_minutes"] == 4
    assert stats["avg_accuracy"] == 0.8 and stats["accuracy_rated"] == 1
    assert stats["reasoning_quality_rated"] == 0 and stats["avg_reasoning_quality"] == 0.0
    assert stats["action_appropriateness_rated"] == 0 and stats["avg_action_appropriateness"] == 0.0
    # Only review grades: nothing graded here.
    only = feedback_stats([reviewed_only, rolled_back])
    assert only["graded_cases"] == 0 and only["feedback_count"] == 0


def test_feedback_stats_averages_only_the_rated_sub_scores() -> None:
    cases = [
        _case("r1", feedback=[_grade(analyst="a", accuracy=1.0, reasoning_quality=0.6)]),
        _case("r2", feedback=[_grade(analyst="b", accuracy=0.6)]),
        _case("r3", feedback=[_grade(analyst="c")]),  # no stars: rates nothing
    ]
    stats = feedback_stats(cases)
    assert stats["feedback_count"] == 3
    assert stats["accuracy_rated"] == 2 and stats["avg_accuracy"] == 0.8
    assert stats["reasoning_quality_rated"] == 1 and stats["avg_reasoning_quality"] == 0.6
    # Nothing rated it: the average stays 0.0 and its count says why.
    assert stats["action_appropriateness_rated"] == 0 and stats["avg_action_appropriateness"] == 0.0


def test_feedback_stats_with_no_grades_reports_zero_rated() -> None:
    stats = feedback_stats([_case("e1")])
    assert stats["accuracy_rated"] == 0 and stats["reasoning_quality_rated"] == 0
    assert stats["action_appropriateness_rated"] == 0 and stats["avg_accuracy"] == 0.0


# --------------------------------------------------------------------------- #
# agent_improvement (D6.8)
# --------------------------------------------------------------------------- #
_START = datetime(2026, 11, 1, tzinfo=timezone.utc)
_END = datetime(2026, 11, 30, tzinfo=timezone.utc)


def test_the_agent_feedback_selection_leaves_review_grades_out() -> None:
    review = _grade(origin="auto_close_review", review_id="acr-9", assessment="disagree")
    later_ordinary = _grade(ts="2026-11-21T10:00:00+00:00", analyst="ann", assessment="agree")
    mixed = _case("m1", feedback=[review, later_ordinary])
    rolled_back = _case("m2", feedback=[_grade(assessment="disagree")], history=[_event(review_id="acr-2")])
    selected, excluded = ai._select_feedback([mixed, rolled_back], start=_START, end=_END)  # noqa: SLF001
    assert [(s.case.case_id, s.feedback.analyst) for s in selected] == [("m1", "ann")]
    assert excluded["auto_close_review_grade"] == 2


_CLOSE_AT, _REVIEW_AT, _REOPEN_AT = (
    "2026-11-10T10:00:00+00:00", "2026-11-10T11:00:00+00:00", "2026-11-10T12:00:00+00:00",
)
_OBSERVED = datetime(2026, 11, 20, tzinfo=timezone.utc)


def _reopen_case(cid: str, *, review_reopen: bool, review: dict | None = None) -> Case:
    """An agent close, then a person's reopen two hours later. ``review_reopen`` puts the
    ``review_via`` marker on the reopen's history entry; ``review`` is the case's
    ``auto_close_review`` history event (the ledger-backed review), if any."""
    history = [{"ts": _REOPEN_AT, "event": "analyst_action", "action": "reopen", "analyst": "rev", "note": ""}]
    if review_reopen:
        history[0]["review_via"] = "auto_close_review"
    if review is not None:
        history.insert(0, review)
    return _case(cid, history=history, status_history=[
        StatusHistoryEntry(from_status="open", to_status="closed", by="agent", at=_CLOSE_AT),
        StatusHistoryEntry(from_status="closed", to_status="open", by="rev", at=_REOPEN_AT),
    ])


def _reopens(*cases: Case) -> dict:
    return ai._agent_reopen_summary(  # noqa: SLF001
        list(cases), start=_START, end=_END, observed_through=_OBSERVED,
    )


def test_a_reopen_from_a_review_is_not_a_human_reopen_of_an_agent_close() -> None:
    reviewed = _event(review_id="acr-ro", ts=_REVIEW_AT)
    summary = _reopens(
        _reopen_case("ro1", review_reopen=True, review=reviewed),
        # A reviewed case reopened the ordinary way (no marker) still counts.
        _reopen_case("ro2", review_reopen=False, review=reviewed),
    )
    assert summary["eligible_agent_terminal_decisions"] == 2
    assert summary["human_reopens"] == 1  # only the ordinary reopen
    assert summary["rate"] == 0.5


@pytest.mark.parametrize("review", [
    None,  # no ledger review at all: an unsampled case, or a marker sent on an ordinary reopen
    _event(review_id="", ts=_REVIEW_AT),  # a history event that names no review
    _event(review_id="acr-late", ts="2026-11-10T13:00:00+00:00"),  # recorded after the reopen
    _event(review_id="acr-bad", ts="not a time"),
])
def test_a_review_via_marker_without_a_ledger_review_before_it_still_counts(review: dict | None) -> None:
    """``review_via`` is a marker the caller sends: on its own it never hides a reopen
    from the agent reopen statistic."""
    summary = _reopens(_reopen_case("forged", review_reopen=True, review=review))
    assert summary["eligible_agent_terminal_decisions"] == 1
    assert summary["human_reopens"] == 1 and summary["rate"] == 1.0


# --------------------------------------------------------------------------- #
# Review grades are still ground truth (D6.8 "Included as ground truth")
# --------------------------------------------------------------------------- #
def test_review_grades_still_feed_every_ground_truth_consumer() -> None:
    """A review grade stays out of the agreement views and IN every ground-truth reader:
    ``analyst_confirmed_outcome``, the threshold tuner, the precedent corpus (its note
    and ``precedent_ground_truth``) and ``ground_truth_supply``. Both markers count: the
    entry fields, and the history event a previous build keeps."""
    from app.engine import threshold_tuner
    from app.engine.analyst_outcomes import analyst_confirmed_outcome, ground_truth_supply
    from app.engine.metrics import precedent_ground_truth
    from app.tools.rag import RagService

    marked = _case("gt1", feedback=[_grade(origin="auto_close_review", review_id="acr-g1",
                                           actual_outcome="false_positive", comment="benign scanner")])
    rolled_back = _case("gt2", feedback=[_grade(actual_outcome="false_positive", comment="benign scanner")],
                        history=[_event(review_id="acr-g2")])
    cases = [c.model_copy(update={"rule_ids": ["rule-gt"]}) for c in (marked, rolled_back)]
    for case in cases:
        assert is_review_grade(case, case.feedback[0]) is True
        assert analyst_confirmed_outcome(case) == ("false_positive", "analyst_feedback")
        assert RagService._case_analyst_note(case, "analyst_feedback") == "benign scanner"  # noqa: SLF001

    stats = threshold_tuner._accumulate_rule_stats(cases, ewma_alpha=0.3, z=1.96)  # noqa: SLF001
    (rule,) = stats.values()
    assert (rule.total, rule.fp, rule.feedback_labels, rule.unconfirmed) == (2, 2, 2, 0)

    corpus = precedent_ground_truth(cases)
    assert corpus["analyst_confirmed_cases"] == 2
    assert corpus["by_evidence_source"] == {"analyst_feedback": 2}
    assert ground_truth_supply(cases)["qualifying_precedents"] == 2

    # ... and the agreement view leaves both out.
    assert feedback_stats(cases)["graded_cases"] == 0


# --------------------------------------------------------------------------- #
# The chat feedback tool (D4.5)
# --------------------------------------------------------------------------- #
async def test_the_chat_feedback_tool_says_not_rated(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.agents.chat_tools import metrics as tool_mod
    from app.api.metrics_shared import invalidate_case_page_cache
    from app.es.fake import InMemoryESClient
    from app.stores.cases import CaseStore
    from tests.test_chat_tools_support import make_ctx

    invalidate_case_page_cache()
    store = CaseStore(InMemoryESClient())
    await store.save(_case("chat-1", feedback=[_grade()]).model_copy(
        update={"created_at": datetime.now(timezone.utc).isoformat()}))

    unrated = {
        "graded_cases": 3, "feedback_count": 3, "agreement_rate": 1.0, "agreement_signals": 3,
        "avg_accuracy": 0.0, "avg_reasoning_quality": 0.0, "avg_action_appropriateness": 0.0,
        "time_saved_minutes": 0, "outcome_distribution": {},
        "accuracy_rated": 0, "reasoning_quality_rated": 0, "action_appropriateness_rated": 0,
    }
    monkeypatch.setattr("app.engine.metrics.feedback_stats", lambda _cases: dict(unrated))
    out = await tool_mod.SocMetricsTool().run(make_ctx(cases=store), kind="feedback")
    assert out.ok, out.summary
    items = {i["key"]: i for i in out.artifacts[0].data["items"]}
    assert items["accuracy"]["value"] is None and items["accuracy"]["context"] == "not rated"
    for name in ("accuracy", "reasoning_quality", "action_appropriateness"):
        assert out.observation[f"avg_{name}"] == "not rated"
        assert out.observation[f"{name}_rated"] == 0

    rated = dict(unrated, avg_accuracy=0.8, accuracy_rated=2)
    monkeypatch.setattr("app.engine.metrics.feedback_stats", lambda _cases: dict(rated))
    out = await tool_mod.SocMetricsTool().run(make_ctx(cases=store), kind="feedback")
    items = {i["key"]: i for i in out.artifacts[0].data["items"]}
    assert items["accuracy"]["value"] == 80.0 and "context" not in items["accuracy"]
    assert out.observation["avg_accuracy"] == 0.8
    assert out.observation["avg_reasoning_quality"] == "not rated"
    invalidate_case_page_cache()
