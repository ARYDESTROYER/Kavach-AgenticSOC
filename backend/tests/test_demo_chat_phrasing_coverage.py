"""Demo planner phrase coverage from the Round 12 final review (WP-DEMO).

Analyst phrasings in the operator's own style that the deterministic Demo planner
missed, and one false sentence it produced:

* "Make a report for the whole year" covered the last 30 days and then said "No
  period was named", although one was. "Whole / full / entire" periods are now read,
  and a period phrase no rule reads is named as unread instead of denied.
* "Segregate the open cases severity wise" returned a plain case list. Every case
  grouping now has its "<field> wise" form ("month wise" stays a creation-time bucket).
* "What percentage of cases were auto closed" listed closed cases without a rate. A
  share question about the AI's closes now states the automation rate from exact counts.

Offline and pure: the planner is driven round by round with synthetic observations
(``tests.test_demo_chat_round12.drive``). The end-to-end checks against the seeded
demo stores live in ``tests/test_chat_golden_set.py``.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.engine import demo_chat
from app.engine.demo_chat import classify
from tests.test_demo_chat_round12 import _generic_obs, drive, ran


# --------------------------------------------------------------------------- #
# "Whole / full / entire" periods
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("text, spec", [
    ("make a report for the whole year", "this_year"),
    ("make a report for this whole year", "this_year"),
    ("cases for the entire year", "this_year"),
    ("full year figures", "this_year"),
    ("how many cases in the whole month", "this_month"),
    ("cases opened in the entire quarter", "this_quarter"),
    ("cases this whole week", "this_week"),
    ("cases for the last full quarter", "last_quarter"),
    ("the previous whole month", "last_month"),
    ("report for the last full year", "last_year"),
    # A period that names its own month or year is read by those rules.
    ("cases for the full year 2025", "2025"),
    ("cases in the whole month of september 2026", "2026-09"),
])
def test_whole_periods_map_to_the_calendar_period(text: str, spec: str) -> None:
    win = demo_chat._window_from(text)
    assert win is not None and win.spec == spec, (text, win)


@pytest.mark.parametrize("text", [
    "open for a whole week",          # a duration, not a period
    "an entire year of logs",         # a duration, not a period
])
def test_a_whole_duration_is_not_a_period(text: str) -> None:
    assert demo_chat._window_from(text) is None


def test_full_year_over_year_is_still_a_year_over_year_comparison() -> None:
    ask = classify("full year-over-year cases")
    assert ask.compare == "same_period_last_year"


@pytest.mark.parametrize("question", ["Make a report for the whole year", "make a report for this whole year"])
def test_a_whole_year_report_covers_this_year_and_never_says_no_period(question: str) -> None:
    rounds, header, body = drive(question)
    windows = {inp.get("window") for tool, inp in ran(rounds) if tool in ("case_stats", "soc_metrics", "cost_usage")}
    assert windows == {"this_year"}, ran(rounds)
    assert header.get("report") and "No period was named" not in body
    assert "last 30 days" not in body


# --------------------------------------------------------------------------- #
# A named period that no rule reads is said, never denied
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("text, phrase", [
    ("make a report for the fiscal year", "for the fiscal year"),
    ("what happened over the weekend", "over the weekend"),
    ("cases during the holiday season", "during the holiday season"),
])
def test_an_unread_period_phrase_is_named(text: str, phrase: str) -> None:
    assert demo_chat._window_from(text) is None
    assert demo_chat._unread_window(text) == phrase


@pytest.mark.parametrize("text", [
    "how many cases for each month",  # a breakdown
    "cases in a week",                # a duration or a bucket
    "cases per week",
    "show me the open cases",
])
def test_breakdowns_and_durations_are_not_unread_periods(text: str) -> None:
    assert demo_chat._unread_window(text) is None


def test_an_unreadable_report_period_says_so_instead_of_no_period_named() -> None:
    _rounds, _header, body = drive("Make a report for the fiscal year")
    assert "No period was named" not in body
    assert "I could not read “for the fiscal year” as a period, so the report covers the last 30 days." in body


# --------------------------------------------------------------------------- #
# "<field> wise" breakdowns
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question, group, filters", [
    ("segregate the open cases severity wise", "severity", {"status_group": "active"}),
    ("Segregate the open cases severity-wise pls", "severity", {"status_group": "active"}),
    ("segregate the open cases on severity", "severity", {"status_group": "active"}),
    ("severity wise breakdown of cases this month", "severity", {"window": "this_month"}),
    ("segregate cases status wise", "status", {}),
    ("closed cases verdict wise", "verdict", {"status_group": "terminal"}),
    ("open cases priority wise", "priority", {"status_group": "active"}),
    ("rule wise cases", "rule", {}),
    ("assignee wise open cases", "assignee", {"status_group": "active"}),
    ("analyst-wise closed cases", "assignee", {"status_group": "terminal"}),
    ("cases source wise", "source", {}),
    ("cases tactic wise", "mitre_tactic", {}),
])
def test_field_wise_breakdowns_group_the_cases(question: str, group: str, filters: dict[str, Any]) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown" and ask.group == group, (question, ask.intent, ask.group)
    rounds, _header, _body = drive(question)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats and stats[0].get("group_by", [None])[0] == group, ran(rounds)
    for key, value in filters.items():
        assert stats[0].get(key) == value, (key, ran(rounds))


def test_month_wise_stays_a_creation_time_bucket() -> None:
    ask = classify("segregate the open cases month wise")
    assert ask.intent == "breakdown" and ask.bucket == "month" and ask.group is None


@pytest.mark.parametrize("text", ["otherwise show the cases", "likewise for the closed ones", "clockwise"])
def test_words_ending_in_wise_name_no_grouping(text: str) -> None:
    assert demo_chat._case_group_from(text) is None
    assert demo_chat._group_field(text) is None


def test_alerts_field_wise_are_a_log_count_by_that_field() -> None:
    ask = classify("Give me the alerts severity wise")
    assert ask.intent == "top" and ask.field == "severity"


# --------------------------------------------------------------------------- #
# A share of the AI's closes states the rate
# --------------------------------------------------------------------------- #
def _closes_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
    obs = _generic_obs(tool, inp)
    if tool == "case_stats":
        obs.update(total=76, filters={"status_group": inp.get("status_group")} if inp.get("status_group") else {},
                   totals={"count": 76, "auto_closed": 53, "human_closed": 23})
    return obs


@pytest.mark.parametrize("question, window", [
    ("what percentage of cases were auto closed all time", "all"),
    ("what percentage of cases were auto closed", None),
    ("What share of cases did the AI close this month?", "this_month"),
    ("what % of cases were auto-closed in the last 90 days", "now-90d"),
    ("Percentage of auto closed cases", None),
])
def test_a_share_of_auto_closed_cases_states_the_automation_rate(question: str, window: str | None) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown", (question, ask.intent)
    rounds, _header, body = drive(question, _closes_obs)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats, ran(rounds)
    assert {"auto_closed", "human_closed"} <= set(stats[0].get("metrics") or []), stats[0]
    assert stats[0].get("window") == window, stats[0]
    assert "search_cases" not in [tool for tool, _ in ran(rounds)]
    # 53 of 76 closed cases: the rate leads, with the counts it is computed from.
    assert body.startswith("**69.7%** of the closed cases"), body
    assert "53 of 76 closed cases" in body and "This is the automation rate." in body


def test_a_count_of_auto_closed_cases_still_leads_with_the_count() -> None:
    _rounds, _header, body = drive("How many cases were auto-closed this month?", _closes_obs)
    assert body.startswith("**53 cases**"), body


def test_the_auto_close_rate_question_keeps_its_posture_answer() -> None:
    assert classify("auto close rate all time").intent == "posture"
