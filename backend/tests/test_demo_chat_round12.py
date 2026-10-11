"""Round 12 unit tests for the deterministic Demo Mode chat planner (WP-DEMO).

Offline and pure: prompts are built exactly as the engine builds them (the helpers
of ``test_demo_chat_planner``) and the planner is driven round by round with
synthetic observations. Covered (SPEC D2-D4, D7-D11; diagnosis/routing.md):

* the window grammar: all time, calendar periods, rolling spans (90 days stays 90
  days), named months and quarters (dated by an anchor lookup), ISO dates, and
  comparisons;
* the new intents: exact case breakdowns, trends, comparisons, performance reports,
  investigation briefs, clarify and in-depth investigations;
* report requests set the header ``report`` and close with the saving sentence; a
  question ABOUT reports never builds an envelope;
* "unsupported" only when no data can be read; a missing case is a clear data answer;
* zero results offer one-click suggestions; byte-identical plans and finals.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from app.agents.chat_protocol import PriorExchange, parse_reply
from app.engine import demo_chat
from app.engine.demo_chat import classify, plan_turn
from tests.test_demo_chat_planner import POSTURE_OBS, call, final_of, prompt, tools_of

#: SPEC D11: the closing sentence of an answer whose report the server saves.
SAVED = "The full report is below, and it is being saved to your Reports."


# --------------------------------------------------------------------------- #
# A round-by-round driver with synthetic observations.
# --------------------------------------------------------------------------- #
_WINDOW_LABELS = {"all": "all time (since 11 Aug 2026)", "now-90d": "last 90 days", "now-30d": "last 30 days",
                  "now-12M": "last 12 months (since Nov 2025)", "this_month": "October 2026",
                  "2026-09": "September 2026", "2024": "2024"}


def _label(inp: dict[str, Any]) -> str:
    window = inp.get("window") or inp.get("time_from")
    return _WINDOW_LABELS.get(window if isinstance(window, str) else "", "all time")


def _generic_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
    """A plausible observation for any lookup (enough for the finals to narrate)."""
    if tool == "case_stats":
        obs: dict[str, Any] = {"total": 12, "exact": True, "window": _label(inp), "filters": {},
                               "group_by": [g for g in inp.get("group_by") or [] if g != "month"]}
        if inp.get("bucket"):
            obs.update(bucket=inp["bucket"], buckets=[{"label": "Sep 2026"}, {"label": "Oct 2026", "in_progress": True}],
                       groups=[{"bucket": "Sep 2026", "metrics": {"count": 5}},
                               {"bucket": "Oct 2026", "metrics": {"count": 7}}])
        return obs
    if tool == "soc_metrics":
        return {**POSTURE_OBS, "kind": inp.get("kind", "posture"), "window": _label(inp)}
    if tool == "search_cases":
        filters = {k: inp[k] for k in ("entity", "status_group", "severity", "verdict", "text") if k in inp}
        return {"filters": filters, "window": "all time", "count": 1, "total": 1, "exact": True,
                "cases": [{"case_id": "demo-1", "entity": "host:dc01", "title": "demo rule", "risk_score": 70,
                           "verdict": "NEEDS_HUMAN", "status": "escalated", "severity": "high"}]}
    if tool == "get_case":
        return {"case": {"case_id": inp.get("case_id"), "entity": "host:dc01", "title": "demo rule",
                         "verdict": "NEEDS_HUMAN", "status": "escalated", "risk_score": 70},
                "mitre": [{"id": "T1078", "name": "Valid Accounts"}]}
    if tool in ("log_stats", "search_logs"):
        return {"total": 4, "window": _label(inp), "sources": {"answered": 1, "queried": 1}}
    if tool == "cost_usage":
        return {"total_cost_usd": 0.5, "calls": 3, "tokens": 900, "window": _label(inp)}
    return {}


Obs = Callable[[str, dict[str, Any]], "dict[str, Any] | None"]


def drive(question: str, obs_for: Obs | None = None, *, history: tuple[PriorExchange, ...] = (),
          max_rounds: int = 16, **kw: Any) -> tuple[list[list[dict[str, Any]]], dict[str, Any], str]:
    """Plan → run (synthetic observations) → plan … until the planner answers.
    ``obs_for`` returning ``None`` makes that lookup fail."""
    rounds: list[list[dict[str, Any]]] = []
    for _ in range(max_rounds):
        reply = plan_turn(prompt(question, *rounds, history=history, **kw))
        if parse_reply(reply).kind == "final":
            header, body = final_of(reply)
            return rounds, header, body
        batch_calls = []
        for tool, inp in tools_of(reply):
            obs = (obs_for or _generic_obs)(tool, inp)
            if obs is None:
                batch_calls.append(call(tool, {}, status="error", summary="Not found", inp=inp))
            else:
                batch_calls.append(call(tool, obs, inp=inp))
        rounds.append(batch_calls)
    raise AssertionError(f"no final after {max_rounds} rounds for {question!r}")


def ran(rounds: list[list[dict[str, Any]]]) -> list[tuple[str, dict[str, Any]]]:
    return [(c["tool"], c["input"]) for r in rounds for c in r]


# --------------------------------------------------------------------------- #
# Windows (SPEC D7): every phrasing, never shortened, labels in words.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("text, spec, phrase", [
    ("create a report of lifetime performance", "all", "all time"),
    ("how many cases ever", "all", "all time"),
    ("over all time", "all", "all time"),
    ("this week", "this_week", "this week"),
    ("last week", "last_week", "last week"),
    ("this month", "this_month", "this month"),
    ("last month", "last_month", "last month"),
    ("this quarter", "this_quarter", "this quarter"),
    ("last quarter", "last_quarter", "last quarter"),
    ("year to date", "ytd", "this year to date"),
    ("ytd", "ytd", "this year to date"),
    ("this year", "this_year", "this year"),
    ("last year", "last_year", "last year"),
    ("today", "today", "today"),
    ("yesterday", "yesterday", "yesterday"),
    ("last 90 days", "now-90d", "the last 90 days"),
    ("90 days", "now-90d", "the last 90 days"),
    ("past 6 months", "now-6M", "the last 6 months"),
    ("last 2 weeks", "now-2w", "the last 2 weeks"),
    ("last 3 years", "now-3y", "the last 3 years"),
    ("the last week", "now-7d", "the last 7 days"),
    ("the past month", "now-30d", "the last 30 days"),
    ("last hour", "now-1h", "the last hour"),
    ("monthly soc report for september 2026", "2026-09", "September 2026"),
    ("q3 2026", "2026-Q3", "Q3 2026"),
    ("2026-q2", "2026-Q2", "Q2 2026"),
    ("cases in 2026-09", "2026-09", "September 2026"),
    ("in 2025", "2025", "2025"),
    ("on 2026-09-03", "2026-09-03", "3 Sep 2026"),
    ("from 2026-09-01 to 2026-09-15", {"from": "2026-09-01", "to": "2026-09-15"}, "1 Sep 2026 to 15 Sep 2026"),
    ("since 2026-03-01", {"from": "2026-03-01"}, "since 1 Mar 2026"),
])
def test_window_phrases_map_to_tool_windows_and_readable_labels(text: str, spec: Any, phrase: str) -> None:
    win = demo_chat._window_from(text)
    assert win is not None and win.spec == spec and win.phrase == phrase


@pytest.mark.parametrize("text", ["no window here", "may i see the cases", "march madness"])
def test_month_words_that_are_not_months_set_no_window(text: str) -> None:
    assert demo_chat._window_from(text) is None


@pytest.mark.parametrize("text, anchor, spec, phrase", [
    ("cases in september", (2026, 10), "2026-09", "September 2026"),
    # A month later than the anchor month is last year's.
    ("cases in december", (2026, 10), "2025-12", "December 2025"),
    ("since march", (2026, 10), {"from": "2026-03-01"}, "since Mar 2026"),
    ("q3", (2026, 10), "2026-Q3", "Q3 2026"),
])
def test_named_months_and_quarters_take_their_year_from_the_anchor(text: str, anchor: tuple[int, int], spec: Any,
                                                                  phrase: str) -> None:
    pending = demo_chat._window_from(text)
    assert pending is not None and pending.spec is None and pending.pending is not None
    win = demo_chat._anchored(pending, anchor)
    assert win is not None and win.spec == spec and win.phrase == phrase


@pytest.mark.parametrize("text, compare, spec", [
    ("compare this month with last month", "previous_period", "this_month"),
    # Only the compared period named: the subject is the current one.
    ("is our fp rate better or worse than last month?", "previous_period", "this_month"),
    ("month over month case volume", "previous_period", "this_month"),
    ("year over year cases", "same_period_last_year", "this_year"),
    ("this month vs the same month last year", "same_period_last_year", "this_month"),
])
def test_comparisons_name_the_subject_period_and_the_baseline(text: str, compare: str, spec: str) -> None:
    assert demo_chat._compare_from(text) == compare
    win = demo_chat._compare_window(text)
    assert win is not None and win.spec == spec


def test_two_named_periods_compare_explicitly() -> None:
    ask = classify("Q3 2026 vs Q2 2026")
    assert ask.intent == "compare" and ask.compare == "explicit"
    assert ask.win is not None and ask.win.spec == "2026-Q3"
    assert ask.compare_win is not None and ask.compare_win.spec == "2026-Q2"


# --------------------------------------------------------------------------- #
# Classification of the Round 12 intents (diagnosis/routing.md).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question, intent, extra", [
    ("Create a report of lifetime performance pls thanks", "perf_report",
     {"report": "executive", "save": True, "win": "all"}),
    ("Last 90 days or whatever reports you can", "perf_report", {"report": "executive", "save": True, "win": "now-90d"}),
    ("The amount of total cases right now that are open, when were they all opened ? Segregate month wise pls thanks",
     "breakdown", {"bucket": "month", "save": False}),
    ("Monthly SOC report for September 2026", "perf_report", {"report": "monthly", "save": True, "win": "2026-09"}),
    ("Create an executive summary for this quarter", "perf_report", {"report": "executive", "win": "this_quarter"}),
    ("Make an infographic of our posture this quarter", "perf_report", {"report": "infographic"}),
    ("Give me an investigation brief for case demo-00000539-0052", "brief",
     {"report": "investigation_brief", "save": True}),
    ("Create a chart of cases by month", "breakdown", {"bucket": "month"}),
    ("Make a table of open cases by severity", "breakdown", {"group": "severity"}),
    ("Cases by assignee", "breakdown", {"group": "assignee"}),
    ("Cases by rule this month", "breakdown", {"group": "rule", "win": "this_month"}),
    ("How many cases did we close this month?", "breakdown", {"win": "this_month"}),
    ("Show me the MTTR trend over the last 30 days", "trend", {"subject": "timing", "win": "now-30d"}),
    ("MTTA trend by week this quarter", "trend", {"subject": "timing", "bucket": "week"}),
    ("Compare this month vs last month: cases, FP rate, MTTR", "compare", {"compare": "previous_period"}),
    ("Year over year cases", "compare", {"compare": "same_period_last_year"}),
    ("How much did we spend on AI by month?", "cost", {"bucket": "month"}),
    ("show me the trend", "clarify", {"clarify": "trend", "save": False}),
    ("compare", "clarify", {"clarify": "compare"}),
    ("how many?", "clarify", {"clarify": "count"}),
    ("break it down", "clarify", {"clarify": "breakdown"}),
    ("Investigate everything about host dc01 over the last 30 days", "deep", {"entity": ("host", "dc01")}),
    ("Deep dive into user pnair this month", "deep", {"entity": ("user", "pnair"), "win": "this_month"}),
    ("Close case demo-00000539-0004", "change", {"save": False}),
    ("List the console users", "unsupported", {"save": False}),
    ("How do reports work?", "help", {"save": False}),
])
def test_round12_questions_classify_to_their_intent(question: str, intent: str, extra: dict[str, Any]) -> None:
    ask = classify(question)
    assert ask.intent == intent
    for key, value in extra.items():
        got = getattr(ask, key)
        if key == "win":
            got = got.spec if got is not None else None
        assert got == value, (key, got)


@pytest.mark.parametrize("question", ["Create a chart of cases by month", "Make a table of open cases by severity",
                                      "Build a report on this month", "Generate a weekly report",
                                      "Produce a quarterly report for last quarter"])
def test_making_an_answer_object_is_never_a_refused_change(question: str) -> None:
    assert classify(question).intent != "change"


def test_an_investigation_without_a_named_window_leaves_the_chip_in_charge() -> None:
    # The in-depth investigation defaults to 30 days in its PLAN, so the analyst's chip
    # (when set) still wins over that default.
    assert classify("Investigate everything about host dc01").win is None


# --------------------------------------------------------------------------- #
# Plans.
# --------------------------------------------------------------------------- #
def test_ninety_days_stays_ninety_days_in_every_lookup() -> None:
    first = tools_of(plan_turn(prompt("Show cases opened per month for the last 90 days")))
    assert first[0] == ("case_stats", {"bucket": "month", "window": "now-90d"})
    report = tools_of(plan_turn(prompt("Last 90 days or whatever reports you can")))
    assert all(inp.get("window") == "now-90d" for tool, inp in report if tool != "search_cases")
    logs = tools_of(plan_turn(prompt("Top rules in the last 90 days")))
    assert logs[0][0] == "log_stats" and logs[0][1].get("time_from") == "now-90d"


def test_open_cases_by_month_counts_exactly_and_lists_the_oldest() -> None:
    q = "The amount of total cases right now that are open, when were they all opened ? Segregate month wise pls thanks"
    assert tools_of(plan_turn(prompt(q))) == [
        ("case_stats", {"status_group": "active", "bucket": "month"}),
        ("search_cases", {"status_group": "active", "sort_field": "created_at", "sort_order": "asc", "limit": 5}),
    ]


def test_a_bucket_without_a_window_gets_a_matching_default_window() -> None:
    plan = tools_of(plan_turn(prompt("How much did we spend on AI by month?")))
    assert plan[0][0] == "cost_usage" and plan[0][1]["window"] == "now-12M" and plan[0][1]["bucket"] == "month"


def test_a_named_month_is_dated_by_an_anchor_lookup_first() -> None:
    question = "How many cases did we have in September?"
    first = tools_of(plan_turn(prompt(question)))
    assert first == [("case_stats", {"window": "now-12M", "bucket": "month"})]
    anchor = {"total": 30, "exact": True, "window": "last 12 months", "bucket": "month",
              "buckets": [{"label": "Sep 2026"}, {"label": "Oct 2026", "in_progress": True}], "groups": []}
    second = tools_of(plan_turn(prompt(question, [call("case_stats", anchor, inp=first[0][1])])))
    assert second[0][0] == "case_stats" and second[0][1]["window"] == "2026-09"


def test_a_comparison_plans_exact_counts_with_the_previous_period() -> None:
    plan = tools_of(plan_turn(prompt("Compare this month vs last month: cases, FP rate, MTTR")))
    stats = next(inp for tool, inp in plan if tool == "case_stats")
    assert stats["window"] == "this_month" and stats["compare"] == "previous_period"
    assert {"count", "fp_rate", "mttr_p50"} <= set(stats["metrics"])


def test_an_in_depth_investigation_runs_ten_or_more_lookups() -> None:
    rounds, header, body = drive("Investigate everything about host dc01")
    lookups = ran(rounds)
    assert len(lookups) >= 10 and len(rounds) >= 4
    assert {"log_stats", "search_logs", "search_cases", "case_stats", "get_case", "explain_decision",
            "list_campaigns"} <= {tool for tool, _ in lookups}
    # No window was named: the plan used 30 days and says so.
    assert all(inp.get("time_from", "now-30d") == "now-30d" for tool, inp in lookups if tool == "log_stats")
    assert body.startswith("**In-depth investigation of host `dc01`")
    assert "No period was named, so the logs and cases cover the last 30 days." in body
    assert header["answer_kind"] == "data"


# --------------------------------------------------------------------------- #
# Finals.
# --------------------------------------------------------------------------- #
def test_a_report_request_asks_the_server_to_save_it() -> None:
    _rounds, header, body = drive("Create a report of lifetime performance pls thanks")
    assert header["report"] == {"title": "Lifetime performance report", "template": "executive"}
    (envelope,) = header["blocks"]
    assert envelope["type"] == "report" and envelope["title"] == "Lifetime performance report"
    assert body.endswith(SAVED) and "unsupported" not in header


def test_report_titles_name_the_period_and_the_subtitle_keeps_its_dates() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        out = _generic_obs(tool, inp)
        if "window" in out and inp.get("window") == "now-30d":
            out["window"] = "last 30 days (since 11 Sep 2026)"
        return out

    _rounds, header, body = drive("Generate a SOC performance report for the last 30 days", obs)
    (envelope,) = header["blocks"]
    assert envelope["title"] == "SOC performance report, last 30 days"
    assert envelope["subtitle"] == "last 30 days (since 11 Sep 2026)"
    assert body.startswith("**SOC performance report, last 30 days** (since 11 Sep 2026):")


def test_a_question_about_reports_is_product_help_without_an_envelope() -> None:
    plan = tools_of(plan_turn(prompt("How do reports work?")))
    assert plan == [("app_help", {"query": "Workspace Chat reports"})]
    help_obs = {"kind": "app_help", "available": True, "results": [
        {"ref": "D1", "title": "Workspace Chat › Reports", "breadcrumb": "Workspace Chat",
         "href": "/docs/0.1/analyst/chat/", "text": "A report collects results from a conversation into one document.",
         "console": []}],
        "console_targets": [{"id": "page:chat", "label": "Triage › Workspace › Chat", "requires": None,
                             "allowed": True}]}
    header, body = final_of(plan_turn(prompt("How do reports work?", [call("app_help", help_obs, inp=plan[0][1])])))
    assert header["answer_kind"] == "product_help" and "report" not in header
    assert not any(b.get("type") == "report" for b in header["blocks"])
    assert "ready to add to your Reports" not in body and SAVED not in body


def test_report_export_questions_search_the_export_section() -> None:
    assert tools_of(plan_turn(prompt("How do I export a report as PDF?"))) == [
        ("app_help", {"query": "Workspace Chat Export report"})]


def test_clarify_is_a_final_with_options_and_no_lookup() -> None:
    header, body = final_of(plan_turn(prompt("show me the trend")))
    assert header["clarify"] == {"question": "Trend of what?", "options": ["Alerts", "Cases", "AI cost", "FP rate"],
                                 "allow_custom": True}
    assert header["blocks"] == [] and header["answer_kind"] == "conversation"
    assert body == "Which trend do you want: alerts, cases, AI cost or the false-positive rate?"


def test_picking_a_clarify_option_answers_the_original_question() -> None:
    prior = PriorExchange(user="show me the trend", answer="Which trend do you want?", message_id="msg-1",
                          steps=(), blocks=())
    plan = tools_of(plan_turn(prompt("Cases", history=[prior])))
    assert plan and plan[0][0] in ("case_stats", "soc_metrics")
    assert classify("Cases").intent != "trend"


def test_a_missing_case_is_a_clear_data_answer_not_unsupported() -> None:
    _rounds, header, body = drive("Explain case case-0001", lambda tool, inp: None)
    assert body.startswith("No case with the id `case-0001` was found: it does not exist, or it is outside what "
                           "you can see.")
    assert "unsupported" not in header and "Chat cannot read that data" not in body


def test_unsupported_only_when_no_lookup_can_read_the_data() -> None:
    help_obs = {"kind": "app_help", "available": True, "results": [], "console_targets": []}
    header, body = final_of(plan_turn(prompt("List the console users", [call("app_help", help_obs)])))
    assert header["unsupported"] is True and body.startswith("Chat cannot read that data")
    # An unmapped question with data lookups granted is answered from what can be read.
    _rounds, header, body = drive("Tell me something interesting")
    assert "unsupported" not in header and not body.startswith("Chat cannot read that data")


def test_a_better_or_worse_question_gets_a_direct_answer() -> None:
    comparison = {"periods": ["Sep 2026 to date", "Oct 2026 to date"], "subject": "Oct 2026 to date",
                  "baseline": "Sep 2026 to date", "rows": [
                      {"label": "Cases", "unit": "count", "values": [10, 45], "change": 35, "change_pct": 350.0,
                       "new": False, "small_sample": False},
                      {"label": "False-positive rate", "unit": "percent", "values": [40.0, 75.6], "change": 35.6,
                       "change_pct": 89.0, "new": False, "small_sample": True}]}

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        out = _generic_obs(tool, inp)
        if tool == "case_stats" and inp.get("compare") and not inp.get("group_by"):
            out["comparison"] = comparison
        return out

    _rounds, _header, body = drive("Is our FP rate better or worse than last month?", obs)
    assert body.startswith("**Worse**: the false-positive rate went from 40% to 75.6% (+35.6 points). The sample "
                           "is small, so read the change with care.")


def test_a_zero_result_offers_suggestions_that_rerun_the_lookup() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        return {"total": 0, "exact": True, "window": "2024", "filters": {}, "bucket": "month", "buckets": [],
                "groups": [], "suggestions": [{"label": "All time", "args": {"window": "all"}}]}

    _rounds, header, body = drive("How many cases were created each month in 2024?", obs)
    assert body.startswith("No case matched in 2024. To widen it, look over all time.")
    assert "Show the same for all time" in header["follow_ups"]


def test_comparison_notes_read_as_statements() -> None:
    note = ("The latest period is still in progress and shorter than the one it is compared with, so the change "
            "compares a partial period; say so.")
    assert demo_chat._note_text(note) == ("The latest period is still in progress and shorter than the one it is "
                                          "compared with, so the change compares a partial period.")


def test_titles_use_proper_plurals() -> None:
    assert [demo_chat._plural_noun(n) for n in ("severity", "source IP", "host", "rule", "ATT&CK tactic")] == [
        "severities", "source IPs", "hosts", "rules", "ATT&CK tactics"]


@pytest.mark.parametrize("question", [
    "Create a report of lifetime performance pls thanks",
    "The amount of total cases right now that are open, when were they all opened ? Segregate month wise pls thanks",
    "Compare this month vs last month: cases, FP rate, MTTR",
    "Investigate everything about host dc01",
    "show me the trend",
])
def test_plans_and_finals_are_byte_identical(question: str) -> None:
    assert plan_turn(prompt(question)) == plan_turn(prompt(question))
    first, second = drive(question), drive(question)
    assert first == second
