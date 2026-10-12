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

import re
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
    # The day, the hyphenated adjective, and a period that qualifies a report.
    ("cases for the whole day", "today"),
    ("the last full day", "yesterday"),
    ("what happened the whole day yesterday", "yesterday"),
    ("the whole week last week", "last_week"),
    ("make a full-year report", "this_year"),
    ("make a full year report", "this_year"),
    ("give me a whole month summary", "this_month"),
    ("a full quarter soc performance review", "this_quarter"),
])
def test_whole_periods_map_to_the_calendar_period(text: str, spec: str) -> None:
    win = demo_chat._window_from(text)
    assert win is not None and win.spec == spec, (text, win)


@pytest.mark.parametrize("text", [
    "open for a whole week",          # a duration, not a period
    "an entire year of logs",         # a duration, not a period
    "a whole day of logs",
    "open for a full day",
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
    ("cases for the day", "for the day"),
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
    # "Segregate ... <connector> <field>" in the other ways analysts say it.
    ("segregate open cases into severity", "severity", {"status_group": "active"}),
    ("segregate the cases according to severity", "severity", {}),
    ("segregate the closed cases as per verdict", "verdict", {"status_group": "terminal"}),
    ("segregate open cases in terms of priority", "priority", {"status_group": "active"}),
    ("segregate cases into statuses", "status", {}),
    ("segregate the cases based on their assignee", "assignee", {}),
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


@pytest.mark.parametrize("question", [
    "share the auto closed cases with me",
    "Can you share the auto-closed cases from this week?",
    "share auto closed cases",
])
def test_share_as_a_verb_still_lists_the_cases(question: str) -> None:
    """"Share" asks for a rate only as the noun; the verb wants the cases themselves."""
    assert classify(question).intent == "cases", (question, classify(question).intent)


@pytest.mark.parametrize("question", ["What's the AI share of closed cases", "share of auto closed cases"])
def test_share_as_a_noun_asks_for_the_rate(question: str) -> None:
    assert classify(question).intent == "breakdown", (question, classify(question).intent)


def test_a_count_of_auto_closed_cases_still_leads_with_the_count() -> None:
    _rounds, _header, body = drive("How many cases were auto-closed this month?", _closes_obs)
    assert body.startswith("**53 cases**"), body


def test_the_auto_close_rate_question_keeps_its_posture_answer() -> None:
    assert classify("auto close rate all time").intent == "posture"


# --------------------------------------------------------------------------- #
# Final review round 2 (L2): an implied period never overrides a named one
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("text, spec", [
    # A whole/full/entire phrase is the current period only when nothing else in the
    # question names one: the period named anywhere else wins.
    ("make a full-year report for last year", "last_year"),
    ("make a full year report for 2025", "2025"),
    ("make a whole week report for last week", "last_week"),
    ("full month report last month", "last_month"),
    ("full year 2025 report", "2025"),
    ("give me a full year report of last year", "last_year"),
    ("2025 full year report", "2025"),
    ("2025 year in review", "2025"),
    ("the full year to date", "ytd"),
    # Nothing else named: still the current period (and it beats a report cadence).
    ("make a full-year report", "this_year"),
    ("monthly report for the whole year", "this_year"),
    # A year named on its own, with no preposition, beats an implied period and a report
    # cadence (closing review): never this year or last year in its place.
    ("end of year report 2025", "2025"), ("year end report 2025", "2025"), ("year-end report 2025", "2025"),
    ("year in review 2025", "2025"), ("make a full year report 2025", "2025"), ("2024 annual report", "2024"),
    ("annual report 2024", "2024"), ("make a report 2025", "2025"),
    # "The year so far" is this year to date, never all time; a named year so far is that year.
    ("make a report for the year so far", "ytd"), ("report on the year so far", "ytd"),
    ("cases over the quarter so far", "this_quarter"), ("cases for the month so far", "this_month"),
    ("cases for the week so far", "this_week"), ("cases for the year 2026 so far", "2026"),
    ("2025 so far", "2025"),
])
def test_a_named_period_beats_an_implied_whole_period(text: str, spec: str) -> None:
    win = demo_chat._window_from(text)
    assert win is not None and win.spec == spec, (text, win)


@pytest.mark.parametrize("question, spec", [
    ("Make a full-year report for last year", "last_year"),
    ("Make a full year report for 2025", "2025"),
    ("Make a whole week report for last week", "last_week"),
    ("End of year report 2025", "2025"),
    ("Make a full year report 2025", "2025"),
    ("2024 annual report", "2024"),
    ("Make a report for the year so far", "ytd"),
])
def test_a_whole_period_report_for_a_named_period_covers_that_period(question: str, spec: str) -> None:
    rounds, header, _body = drive(question)
    windows = {inp.get("window") for tool, inp in ran(rounds) if tool in ("case_stats", "soc_metrics", "cost_usage")}
    assert windows == {spec}, ran(rounds)
    assert header.get("report"), header


@pytest.mark.parametrize("text, spec", [
    # A period after a determiner, the calendar period, a period-end or in-review report.
    ("make a report on the year", "this_year"),
    ("make a report on this calendar year", "this_year"),
    ("make a report on the calendar year", "this_year"),
    ("make a report covering the year", "this_year"),
    ("make a report of the year", "this_year"),
    ("make a report about the year", "this_year"),
    ("make a report for the year", "this_year"),
    ("make a report on the quarter", "this_quarter"),
    ("how many cases in the month", "this_month"),
    ("cases over the week", "this_week"),
    ("make a year end report", "this_year"),
    ("make an end of year report", "this_year"),
    ("make the year in review report", "this_year"),
    ("a quarter-end summary", "this_quarter"),
    ("cases for the previous calendar year", "last_year"),
    ("cases this calendar month", "this_month"),
])
def test_a_period_after_a_determiner_is_the_current_period(text: str, spec: str) -> None:
    win = demo_chat._window_from(text)
    assert win is not None and win.spec == spec, (text, win)


@pytest.mark.parametrize("text", [
    "busiest day in the week",           # a bucket, not a period
    "cases by day of the week",
    "what time of the day do attacks happen",
    "busiest week in the year",
    "cases for the year before",         # the period is named next (and not read)
    "cases in the year since the breach",
    "cases for the week we discussed",
    "for the week ending 5 oct",
    "before year end",                   # a bound, not a year-end report
])
def test_a_bucket_or_a_relative_phrase_is_not_the_current_period(text: str) -> None:
    win = demo_chat._window_from(text)
    assert win is None or win.spec not in ("this_week", "this_month", "this_quarter", "this_year"), (text, win)


@pytest.mark.parametrize("question", ["Make a report on the year", "Make a report on this calendar year",
                                      "Make a report on the calendar year", "Make a report for the year"])
def test_a_report_on_the_year_covers_this_year(question: str) -> None:
    rounds, _header, body = drive(question)
    windows = {inp.get("window") for tool, inp in ran(rounds) if tool in ("case_stats", "soc_metrics", "cost_usage")}
    assert windows == {"this_year"}, ran(rounds)
    assert "No period was named" not in body and "last 30 days" not in body


@pytest.mark.parametrize("text, phrase", [
    ("make a report on the fiscal year", "on the fiscal year"),
    ("make a report covering the fiscal quarter", "covering the fiscal quarter"),
])
def test_an_unread_period_after_on_or_covering_is_named(text: str, phrase: str) -> None:
    assert demo_chat._window_from(text) is None
    assert demo_chat._unread_window(text) == phrase


@pytest.mark.parametrize("text, phrase", [
    ("make a report on the weekend", "on the weekend"),
    ("cases last night", "last night"),
    ("make a report for tuesday", "for tuesday"),
    ("make a report covering fy26", "covering fy26"),
    ("make a report for the last few months", "for the last few months"),
])
def test_a_loose_period_word_is_found(text: str, phrase: str) -> None:
    assert demo_chat._loose_period(text, text) == phrase


@pytest.mark.parametrize("text", [
    "make a report", "top 10 rules", "cases per week", "how many cases for each month", "cases in a week",
    "how many days to close a case", "cases by day of the week", "busiest day in the month", "mttr in hours",
    "logs for host jan-laptop",
])
def test_a_bucket_duration_or_name_is_not_a_loose_period(text: str) -> None:
    assert demo_chat._loose_period(text, text) is None


@pytest.mark.parametrize("text", ["end of year report for fy2025", "make a year-end report for fy2025",
                                  "annual report covering fy26"])
def test_an_unread_fiscal_year_is_never_replaced_by_an_implied_period(text: str) -> None:
    """"End of year report for fy2025" used to cover this year: the implied period and
    the report cadence replaced a period the analyst named but no rule reads."""
    assert demo_chat._window_from(text) is None
    assert demo_chat._loose_period(text, text) is not None


def test_a_bare_number_that_is_not_a_year_names_no_period() -> None:
    """A port, an id or a host name is never read as a year, and never lets an implied
    period stand in for one either."""
    assert demo_chat._window_from("annual summary for port 2049") is None
    assert demo_chat._window_from("yearly review of event 2025") is None
    # A year inside a host name is part of the name: the report cadence still applies.
    assert demo_chat._window_from("annual report for host srv-2025").spec == "last_year"


def test_no_period_named_is_said_only_when_the_question_has_no_period_word() -> None:
    _rounds, _header, body = drive("Make a report on the weekend")
    assert "No period was named" not in body
    assert "I could not read “on the weekend” as a period, so the report covers the last 30 days." in body
    _rounds, _header, body = drive("Make a report")
    assert "No period was named, so the report covers the last 30 days." in body


@pytest.mark.parametrize("question, group, filters", [
    ("Segregate cases on the basis of severity", "severity", {}),
    ("segregate the open cases with respect to verdict", "verdict", {"status_group": "active"}),
    ("segregate closed cases on basis of assignee", "assignee", {"status_group": "terminal"}),
    ("segregate cases w.r.t. priority", "priority", {}),
])
def test_segregate_on_the_basis_of_groups_the_cases(question: str, group: str, filters: dict[str, Any]) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown" and ask.group == group, (question, ask.intent, ask.group)
    rounds, _header, _body = drive(question)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats and stats[0].get("group_by", [None])[0] == group, ran(rounds)
    for key, value in filters.items():
        assert stats[0].get(key) == value, (key, ran(rounds))


# --------------------------------------------------------------------------- #
# Final review round 2 (L2): an auto-close share names what it is a share of
# --------------------------------------------------------------------------- #
def _filtered_closes_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
    """case_stats echoing the filters it was sent: 16 closed critical cases, 0 by the AI."""
    obs = _generic_obs(tool, inp)
    if tool == "case_stats":
        filters = {k: inp[k] for k in ("status_group", "severity", "verdict", "entity", "rule") if k in inp}
        auto, human = (0, 16) if inp.get("severity") == "critical" else (53, 0)
        obs.update(total=auto + human, filters=filters,
                   totals={"count": auto + human, "auto_closed": auto, "human_closed": human})
    return obs


@pytest.mark.parametrize("question, filter_key, noun", [
    ("what percentage of critical cases were auto closed", "severity", "closed critical cases"),
    ("what percentage of false positive cases were auto closed", "verdict", "closed false positive cases"),
    ("what percentage of high severity cases did the AI close this month", "severity", "closed high cases"),
])
def test_a_filtered_auto_close_share_names_its_cases_and_is_not_the_automation_rate(
        question: str, filter_key: str, noun: str) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown", (question, ask.intent)
    rounds, _header, body = drive(question, _filtered_closes_obs)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats and stats[0].get(filter_key) and stats[0].get("status_group") == "terminal", ran(rounds)
    assert re.match(rf"\*\*\d+(?:\.\d)?%\*\* of the {noun}", body), body
    assert "automation rate" not in body.lower(), body


@pytest.mark.parametrize("question", [
    "how much of the cost went to auto closed cases",
    "what percentage of the budget did auto-close investigations use",
    "what share of the spend went to auto closed cases",
])
def test_a_share_of_the_cost_stays_a_cost_question(question: str) -> None:
    assert classify(question).intent == "cost", (question, classify(question).intent)


@pytest.mark.parametrize("question, bucket", [
    ("auto close percentage per month", "month"),
    ("auto close percentage trend over the last 6 months", None),
    ("what percentage of cases were auto closed each month", None),
])
def test_a_per_period_auto_close_share_is_the_automation_rate_trend(question: str, bucket: str | None) -> None:
    ask = classify(question)
    assert ask.intent == "trend" and ask.subject == "automation", (question, ask.intent, ask.subject)
    rounds, _header, body = drive(question)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats and stats[0].get("bucket") and {"auto_closed", "human_closed"} <= set(stats[0]["metrics"]), stats
    if bucket:
        assert stats[0]["bucket"] == bucket, stats
    assert body.startswith("**Automation rate "), body
    assert "Automation rate per " in body, body


def test_a_per_period_auto_close_share_keeps_its_filter() -> None:
    rounds, _header, body = drive("auto close percentage of critical cases per month", _filtered_closes_obs)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats and stats[0].get("severity") == "critical", stats
    assert "the share of closed critical cases the AI agent closed" in body, body


def _within_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
    """case_stats grouped by verdict: 53 closed by the AI (all false positives), 23 by analysts."""
    obs = _generic_obs(tool, inp)
    if tool == "case_stats":
        obs.update(total=76, filters={"status_group": "terminal"}, group_by=inp.get("group_by") or [],
                   totals={"count": 76, "auto_closed": 53, "human_closed": 23},
                   groups=[{"key": {"verdict": "False positive"}, "metrics": {"count": 53, "auto_closed": 53,
                                                                             "human_closed": 0}},
                           {"key": {"verdict": "True positive"}, "metrics": {"count": 23, "auto_closed": 0,
                                                                            "human_closed": 23}}])
    return obs


@pytest.mark.parametrize("question, pct, words", [
    ("what percentage of auto closed cases were false positives", "100%", "false positives"),
    ("What % of the auto-closed cases were true positives?", "0%", "true positives"),
    # Other word orders (closing review): the set before a comma, "the cases the AI closed".
    ("of the auto closed cases, what percentage were false positives", "100%", "false positives"),
    ("what percentage of the cases the AI closed were true positives", "0%", "true positives"),
])
def test_a_share_within_the_ai_closes_is_not_the_automation_rate(question: str, pct: str, words: str) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown" and ask.group == "verdict", (question, ask.intent, ask.group)
    rounds, _header, body = drive(question, _within_obs)
    stats = [inp for tool, inp in ran(rounds) if tool == "case_stats"]
    assert stats and stats[0].get("group_by") == ["verdict"] and "verdict" not in stats[0], stats
    assert body.startswith(f"**{pct}** of the 53 cases that the AI agent closed"), body
    assert f"were {words}: " in body and "automation rate" not in body.lower(), body


@pytest.mark.parametrize("question, part", [
    ("what percentage of auto closed cases this month were medium severity", ("severity", "medium", "medium severity")),
    ("what percentage of the cases the ai closed were medium severity", ("severity", "medium", "medium severity")),
    ("of the auto closed cases, what percentage were false positives",
     ("verdict", "FALSE_POSITIVE", "false positives")),
    ("what share of auto-closed cases last week were critical", ("severity", "critical", "critical")),
])
def test_a_share_within_the_ai_closes_reads_any_word_order(question: str, part: tuple[str, str, str]) -> None:
    """A window or a few words between the set and its verb, the set named first, or "the
    cases the AI closed" used to fall back to the automation rate WITHIN that filter (the
    reverse conditional, with a wrong figure)."""
    assert demo_chat._within_auto_closed(question) == part


def test_a_share_within_the_ai_closes_chat_cannot_count_says_so() -> None:
    _rounds, _header, body = drive("what percentage of auto closed cases were reopened", _within_obs)
    assert body.startswith("**53 cases** were closed automatically by the AI agent (of 76 closed cases)."), body
    assert "Chat can split the AI agent's closes by verdict or severity only." in body
    assert "automation rate" not in body.lower()
