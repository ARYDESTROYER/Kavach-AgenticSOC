"""A data request that says "explain" is a data request (Round 12 final review, L3 held).

The operator's "Product help on data questions" glitch: the Demo planner read a bare
"explain" (and "what are") as a definition, so "Show the top 10 open cases by risk with
a table and explain each" ran only ``app_help`` and answered with the KPI glossary entry
for the Active Risk Index, with no case list. The same flaw sent "List the open
critical cases and explain why each one is critical" and "Which cases had the highest
risk this week? Explain the top 3" to the Help Center, and "List false positives this
week and explain each" to the false-positive-rate definition.

Root cause and fix: a request for records (a list verb, "which <records>", "what are the
<records>", "top N", "explain each / them / the top 3") now wins over the weak defining
words; only a definitional ask ("explain the false positive rate", "what does X mean",
"how is X calculated") goes to the Help Center. The case list then honours what was
asked: ranked by risk, as long as the ranking, explained case by case, and in a table
when one is asked for. The same flaw is closed in the $0 product-help routing used while
the AI is unavailable (``knowledge.answer.classify_intent``) and the real-model prompt
says how to answer "explain" about records.

Offline and pure; the end-to-end checks over the seeded demo stores are the
``EXPLAIN_RECORDS`` entries of ``tests/test_chat_golden_set.py``.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from app.engine import demo_chat
from app.engine.demo_chat import classify, plan_turn
from tests.test_demo_chat_planner import POSTURE_OBS, art, call, final_of, prompt, tools_of
from tests.test_demo_chat_round12 import drive, ran

#: The operator's questions and near variants: each is a data request.
DATA_ASKS = [
    ("Show the top 10 open cases by risk with a table and explain each", "cases"),
    ("List the open critical cases and explain why each one is critical", "cases"),
    ("Which cases had the highest risk this week? Explain the top 3", "cases"),
    ("List false positives this week and explain each", "cases"),
    ("List false positives this week and explain why each was closed", "cases"),
    ("Show the open cases and explain them", "cases"),
    ("Top 5 critical cases, explain each", "cases"),
    ("Explain the top 3 cases by risk", "cases"),
    ("Explain each of the open critical cases", "cases"),
    ("Which incidents are open? explain them", "cases"),
    ("List escalated cases and explain the decision for each", "cases"),
    ("What are the top 5 open cases?", "cases"),
    ("What are the open critical cases?", "cases"),
    ("What are the highest risk cases this week?", "cases"),
    ("What is the riskiest open case?", "cases"),
    ("What are the escalated cases? Explain each", "cases"),
    ("What does each open critical case involve?", "cases"),
    ("Give me the false positives from this week", "cases"),
    ("Show false positives this week", "cases"),
    ("Show me the open incidents and explain them", "cases"),
    ("Explain the open cases", "cases"),
    ("Explain the highest risk cases", "cases"),
    ("explain each escalated case", "cases"),
    ("Explain why each open case is critical", "cases"),
    ("Can you show me the open cases and explain them?", "cases"),
    ("List the open critical cases with an explanation for each", "cases"),
    ("List true positives this month and explain each", "tp"),
    # A record after "each of", "the first 3" or a ranking still names records.
    ("Explain the first 3 cases by risk", "cases"),
    ("Show me the 5 riskiest cases and explain each", "cases"),
    ("Explain each of today's escalated cases", "cases"),
    ("explain each critical case, briefly", "cases"),
    ("Show the open cases and explain each with a table", "cases"),
    # A window beside the records never turns the list into a count: "each" and
    # "every" name the records here, not a count spread over something.
    ("Show the top 10 open cases this week by risk with a table and explain each", "cases"),
    ("Which cases were escalated this week? Explain each", "cases"),
    ("List the open critical cases this week and explain why each one is critical", "cases"),
    ("Show the escalated cases from today and explain each", "cases"),
    ("List cases opened yesterday and explain each", "cases"),
    ("Show the critical cases this month and explain each of them", "cases"),
    ("Show me every open case from the last 24 hours", "cases"),
    ("List each critical case this week", "cases"),
    # A defining word that points back at the listed records ("what each one means",
    # "what they mean") asks what each record means for us, never what a term means
    # (closing review).
    ("Show the escalated cases and explain what each one means", "cases"),
    ("Show today's critical alerts and explain what they mean", "cases"),
    ("List the open critical cases and explain what each means for us", "cases"),
    ("List the escalated cases and tell me what each one means", "cases"),
]

#: A record noun qualifying a console part ("each case action", "every incident badge").
CONSOLE_PART_QUESTIONS = (
    "Explain each case action", "Explain each of the case actions", "Explain each case chip",
    "Explain each case badge", "Explain each case permission", "Explain each case shortcut",
    "Explain each case icon", "Explain each case color", "Explain each case option", "Explain each case section",
    "Explain each case screen", "Explain each alert action", "Explain every incident badge",
    "Explain each alert icon", "Explain each of the case options",
)

#: Definitional asks keep their Help Center answer (with our own figure for a KPI).
DEFINITIONS = [
    ("Explain the false positive rate", "explain_metric"),
    ("Explain the Active Risk Index", "explain_metric"),
    ("explain MTTR", "explain_metric"),
    ("explain the auto-close rate", "explain_metric"),
    ("Explain what the noise reduction funnel is", "explain_metric"),
    ("Explain the false positive rate for each month", "explain_metric"),
    ("What does the false positive rate mean?", "explain_metric"),
    ("How is the false positive rate calculated?", "explain_metric"),
    ("What are false positives?", "explain_metric"),
    ("What is a true positive?", "help"),
    ("explain how the risk score is calculated", "help"),
    ("Explain what each severity level means", "help"),
    ("What are escalated cases?", "help"),
    ("What is the case decision policy?", "help"),
    ("Explain the cases view", "help"),
    # A record noun followed by a console term ("each case status") names the term,
    # and "each of / the first 3" with no record after it names none: these ask what
    # the console's terms mean (final review, L3 held), never for a case list.
    ("Explain each case status", "help"),
    ("Explain every case status", "help"),
    ("Explain each alert severity", "help"),
    ("Explain each incident severity", "help"),
    ("Explain each case verdict", "help"),
    ("Explain each case priority", "help"),
    ("Explain each case outcome", "help"),
    ("Explain every alert field", "help"),
    ("Explain each incident lifecycle state", "help"),
    ("Explain each of the case statuses", "help"),
    ("Explain the top 3 tabs in case detail", "help"),
    ("Explain each of the verdicts", "help"),
    ("Explain each one of the verdicts", "help"),
    ("Explain each of the roles", "help"),
    ("Explain each of the permissions", "help"),
    ("Explain each ticket state", "help"),
    ("Explain each detection rule type", "help"),
    ("Explain the first 3 steps of onboarding", "help"),
    ("Explain the first 2 steps of the setup wizard", "help"),
    ("Explain what each case status means", "help"),
    ("Explain each and every severity level", "help"),
    ("Explain each of these statuses", "help"),
    ("Explain the findings tab", "help"),
    # Console parts a record noun qualifies (closing review): a question about the
    # console, never a case list.
    *((q, "help") for q in CONSOLE_PART_QUESTIONS),
]


@pytest.mark.parametrize("question, intent", DATA_ASKS)
def test_a_data_request_that_says_explain_is_never_product_help(question: str, intent: str) -> None:
    ask = classify(question)
    assert ask.intent == intent, (question, ask.intent)
    tools = {tool for tool, _ in tools_of(plan_turn(prompt(question)))}
    assert "search_cases" in tools and "app_help" not in tools, (question, tools)


@pytest.mark.parametrize("question, intent", DEFINITIONS)
def test_a_definitional_explain_still_answers_from_the_help_center(question: str, intent: str) -> None:
    ask = classify(question)
    assert ask.intent == intent, (question, ask.intent)
    tools = [tool for tool, _ in tools_of(plan_turn(prompt(question)))]
    assert tools[0] == "app_help" and "search_cases" not in tools, (question, tools)


def test_the_explain_metric_starter_is_unchanged() -> None:
    starter = next(s for s in demo_chat.DEMO_STARTERS if s.id == "explain_metric")
    assert classify(starter.prompt).intent == "explain_metric"


@pytest.mark.parametrize("question, expected, absent", [
    # "top 10 … by risk": the ten highest-risk open cases, never the newest ten.
    ("Show the top 10 open cases by risk with a table and explain each",
     {"status_group": "active", "sort_field": "risk_score", "sort_order": "desc", "limit": 10}, ("severity",)),
    # "the highest risk" names no high severity; "the top 3" is three cases.
    ("Which cases had the highest risk this week? Explain the top 3",
     {"window": "this_week", "sort_field": "risk_score", "sort_order": "desc", "limit": 3}, ("severity",)),
    ("List the open critical cases and explain why each one is critical",
     {"status_group": "active", "severity": "critical", "limit": 10}, ("sort_field",)),
    # A verdict noun names the cases to list (hyphenated or not), never the FP rate.
    ("List false positives this week and explain each",
     {"verdict": "FALSE_POSITIVE", "window": "this_week"}, ("severity",)),
    ("Show false-positives this week", {"verdict": "FALSE_POSITIVE", "window": "this_week"}, ()),
    ("Show the lowest risk open cases", {"status_group": "active", "sort_field": "risk_score", "sort_order": "asc"},
     ("severity",)),
    # The oldest-first list keeps its own order.
    ("Show the oldest open cases by risk", {"status_group": "active", "sort_field": "created_at",
                                            "sort_order": "asc"}, ()),
    # A window beside the records lists them over that window, ranked as asked.
    ("Show the top 10 open cases this week by risk with a table and explain each",
     {"status_group": "active", "window": "this_week", "sort_field": "risk_score", "sort_order": "desc",
      "limit": 10}, ("severity",)),
    ("Which cases were escalated this week? Explain each", {"status": "escalated", "window": "this_week"}, ()),
    ("List the open critical cases this week and explain why each one is critical",
     {"status_group": "active", "severity": "critical", "window": "this_week"}, ()),
    ("Show the escalated cases from today and explain each", {"status": "escalated", "window": "today"}, ()),
    ("List cases opened yesterday and explain each", {"window": "yesterday"}, ()),
    ("Show the critical cases this month and explain each of them",
     {"severity": "critical", "window": "this_month"}, ()),
    ("Show me every open case from the last 24 hours", {"status_group": "active", "window": "now-24h"}, ()),
    ("List each critical case this week", {"severity": "critical", "window": "this_week"}, ()),
    # "The first 3" and "the 5 riskiest" are the list's length.
    ("Explain the first 3 cases by risk", {"sort_field": "risk_score", "sort_order": "desc", "limit": 3}, ()),
    ("Show me the 5 riskiest cases and explain each",
     {"sort_field": "risk_score", "sort_order": "desc", "limit": 5}, ()),
])
def test_the_case_list_asks_what_the_question_asked(question: str, expected: dict[str, Any],
                                                    absent: tuple[str, ...]) -> None:
    rounds, _header, _body = drive(question)
    calls = [inp for tool, inp in ran(rounds) if tool == "search_cases"]
    assert calls, ran(rounds)
    inp = calls[0]
    for key, value in expected.items():
        assert inp.get(key) == value, (question, key, inp)
    for key in absent:
        assert key not in inp, (question, key, inp)
    assert all(tool not in ("app_help", "case_stats") for tool, _ in ran(rounds)), ran(rounds)


def _cases_obs(n: int) -> dict[str, Any]:
    rows = [{"case_id": f"demo-{i:04d}", "title": f"user:u{i} — identity_signin", "status": "escalated",
             "verdict": "NEEDS_HUMAN" if i else "TRUE_POSITIVE", "confidence": 0.9 - i / 100,
             "risk_score": 90 - i, "severity": "critical" if i == 0 else "high", "entity": f"user:u{i}",
             "rules": ["identity_signin"]} for i in range(n)]
    return {"filters": {"status_group": "active"}, "window": "all time", "count": 19, "returned": n,
            "exact": True, "by_status": {"escalated": 19}, "cases": rows}


def test_explain_each_explains_every_listed_case_in_a_table() -> None:
    question = "Show the top 10 open cases by risk with a table and explain each"
    inp = {"limit": 10, "status_group": "active", "sort_field": "risk_score", "sort_order": "desc"}
    arts = [art("a1", "case_list", {"items": []}, "Matching cases"), art("a2", "kpis", {"items": []}, "Key figures")]
    header, body = final_of(plan_turn(prompt(question, [call("search_cases", _cases_obs(10), inp=inp,
                                                                artifacts=arts)])))
    assert header["answer_kind"] == "data"
    assert body.startswith("**19 open cases**: 19 escalated.")
    assert "Highest risk first." in body and "Case by case:" in body
    # Every listed case is explained (not three bare lines), from the list's own facts.
    # Round 13 A8: an unnumbered case leads with what it is about, its id after it.
    lines = [line for line in body.splitlines() if re.match(r"^- .+ \(`demo-\d{4}`\)", line)]
    assert len(lines) == 10, body
    assert lines[0] == ("- Identity signin on user `u0` (`demo-0000`) is a true positive at 90% confidence, "
                        "risk 90/100, severity critical, status escalated.")
    assert "ask to explain that case" in body and "From the Help Center" not in body
    # "… with a table": the case list in its table view, titled for the ranking.
    listed = next(b for b in header["blocks"] if b["ref"].endswith(".a1"))
    assert listed["view"] == "table" and listed["title"] == "Highest-risk cases"
    assert header["follow_ups"][0] == "Explain case demo-0000"


def test_explain_the_top_3_explains_three_cases() -> None:
    question = "Which cases had the highest risk this week? Explain the top 3"
    inp = {"limit": 3, "sort_field": "risk_score", "sort_order": "desc", "window": "this_week"}
    _header, body = final_of(plan_turn(prompt(question, [call("search_cases", _cases_obs(3), inp=inp)])))
    assert len([line for line in body.splitlines() if re.match(r"^- .+ \(`demo-\d{4}`\)", line)]) == 3
    assert "Case by case:" in body


def test_a_plain_case_list_keeps_its_short_form() -> None:
    _header, body = final_of(plan_turn(prompt("Show the open cases", [
        call("search_cases", _cases_obs(10), inp={"status_group": "active", "limit": 10})])))
    assert "Case by case:" not in body
    assert len([line for line in body.splitlines() if re.match(r"^- .+ · `demo-\d{4}`", line)]) == 3


def test_explain_each_true_positive_explains_every_listed_case() -> None:
    question = "List true positives this month and explain each"
    tps = {**_cases_obs(4), "filters": {"verdict": "TRUE_POSITIVE"}, "count": 4}
    mix = {**POSTURE_OBS, "kind": "case_mix", "window": "this month"}
    _header, body = final_of(plan_turn(prompt(question, [
        call("search_cases", tps, inp={"verdict": "TRUE_POSITIVE", "limit": 10, "window": "this_month"}),
        call("soc_metrics", mix, inp={"kind": "case_mix", "window": "this_month"})])))
    assert "Case by case:" in body
    assert len([line for line in body.splitlines() if re.match(r"^- .+ \(`demo-\d{4}`\)", line)]) == 4


def test_records_and_definitions_are_told_apart_by_their_object() -> None:
    assert demo_chat._asks_for_records("list the open critical cases and explain why each one is critical")
    assert demo_chat._asks_for_records("which cases had the highest risk this week? explain the top 3")
    assert not demo_chat._asks_for_records("explain the false positive rate")
    assert not demo_chat._asks_for_records("explain what each severity level means")
    assert not demo_chat._asks_for_records("show me the cases page")
    assert not demo_chat._asks_for_records("what is the case decision policy?")
    # A strong defining word still wins beside a record request, unless it points back
    # at the listed records.
    assert demo_chat._defines("list the escalated cases; what does escalated mean?", records=True)
    assert demo_chat._defines("list the escalated cases and explain what each case status means", records=True)
    assert not demo_chat._defines("show the escalated cases and explain what each one means", records=True)
    assert not demo_chat._defines("show today's critical alerts and explain what they mean", records=True)
    assert not demo_chat._defines("show the top 10 open cases by risk and explain each", records=True)
    assert demo_chat._defines("explain the false positive rate", records=False)


@pytest.mark.parametrize("question", [
    "Explain each case status", "Explain each of the verdicts", "Explain each one of the verdicts",
    "Explain each of the case statuses", "Explain the top 3 tabs in case detail",
    "Explain the first 3 steps of onboarding", "Explain each detection rule type", "Explain each case outcome",
    "Explain each of these statuses", "Explain the findings tab", "Explain what they mean",
])
def test_a_console_term_after_explain_names_no_records(question: str) -> None:
    assert not demo_chat._asks_for_records(question.lower()), question


@pytest.mark.parametrize("question", [
    "Explain each of the open critical cases", "Explain each of them", "Explain the first 3 cases by risk",
    "Explain the top 3 by risk", "Explain each escalated case", "Explain each case's risk",
    "Explain each of today's escalated cases", "Explain these cases", "Explain the verdict of each case",
])
def test_records_after_explain_still_name_records(question: str) -> None:
    assert demo_chat._asks_for_records(question.lower()), question


@pytest.mark.parametrize("question", [
    # A real counting cue keeps the count over a window, records or not.
    "How many open cases this week?",
    "Show the number of escalated cases this week",
    "Show the open cases this week by severity",
    "List the case volume per day this week",
    # Without records, "each" and "every" still spread a count over the window.
    "Cases this week for each severity",
])
def test_a_real_count_over_a_window_stays_a_breakdown(question: str) -> None:
    assert classify(question).intent == "breakdown", question
    tools = {tool for tool, _ in tools_of(plan_turn(prompt(question)))}
    assert "case_stats" in tools and "search_cases" not in tools, (question, tools)


@pytest.mark.parametrize("question, n", [
    ("top 5 rules", 5), ("which 3 hosts had the most alerts", 3),
    ("explain the first 3 cases by risk", 3), ("explain the first 3", 3), ("explain the first 4 by risk", 4),
    ("show me the 5 riskiest cases and explain each", 5), ("the 4 highest-risk open incidents", 4),
    ("show me the 3 most recent cases", 3), ("list the 5 newest escalated cases", 5),
    ("the 2 oldest open cases", 2), ("list the 7 latest alerts", 7),
    # Spans of time are never a length.
    ("list the cases from the first 3 days of the month", 10),
    ("show the cases from the 7 most recent days", 10),
    ("the 3 latest weeks of cases", 10),
    ("show the open cases", 10),
    ("top 500 hosts", 50),
])
def test_the_list_length_is_the_ranking_asked_for(question: str, n: int) -> None:
    assert demo_chat._top_n(question) == n


# --------------------------------------------------------------------------- #
# The same flaw outside the Demo planner.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question", [
    "Show the top 10 open cases by risk with a table and explain each",
    "List the open critical cases and explain why each one is critical",
    "Which cases had the highest risk this week? Explain the top 3",
    "List false positives this week and explain each",
    "Which incidents are open? explain them",
    "Which cases are escalated? Explain each one",
    "Explain the highest risk cases",
    "explain each escalated case",
    "Explain why each open case is critical",
    "Explain the escalated cases",
    "Explain each of the open critical cases",
    "Explain the first 3 cases by risk",
    "Which cases were escalated this week? Explain each",
    "Explain each one",
    "Explain each of them",
    "Show the escalated cases and explain what each one means",
    "List the escalated cases and tell me what each one means",
    "Explain each of the escalated cases and what each one means",
])
def test_the_ai_unavailable_help_route_never_takes_an_explain_data_request(question: str) -> None:
    """While the AI is unavailable, a product question gets a $0 Help Center answer and
    a data question the plain notice; "explain" about records is a data question."""
    from app.knowledge.answer import answer_app_question, classify_intent, routes_to_app_help

    assert classify_intent(question) == "data"
    assert routes_to_app_help(question) is False
    assert answer_app_question(question, reason="budget") is None


@pytest.mark.parametrize("question", [
    "Explain the Active Risk Index", "explain MTTD", "Explain what each severity level means",
    "Explain the false positive rate", "Explain the cases view",
    # A console term after the record, no record at all, or a defining word: these ask
    # what something means and keep the $0 Help Center answer (final review, L3 held).
    "Explain what each case status means", "Explain what each alert severity means", "Explain each case status",
    "Explain each of the verdicts", "Explain each of the KPIs", "Explain each of the KPIs on the overview",
    "Explain each of the roles", "Explain each of the permissions", "Explain each case priority",
    "Explain the first 3 steps of onboarding", "Explain what they mean", "Explain every case status",
    "Explain each one of the verdicts", "Explain each of the case statuses", "Explain each detection rule type",
    *CONSOLE_PART_QUESTIONS,
])
def test_the_ai_unavailable_help_route_keeps_definitional_explains(question: str) -> None:
    from app.knowledge.answer import classify_intent, routes_to_app_help

    assert classify_intent(question) != "data", question
    assert routes_to_app_help(question) is True


def test_the_real_model_prompt_says_how_to_answer_explain_about_records() -> None:
    from app.agents.chat_tools.base import render_tool_signatures
    from app.agents.chat_tools.registry import catalogue
    from app.agents.prompts import render_chat_agent_system

    system = render_chat_agent_system(render_tool_signatures(catalogue()))
    assert ('"Explain" about records ("list the open critical cases and explain each", "which cases had the '
            'highest risk? Explain the top 3") asks for those records and a reason for each from their data: '
            "search_cases (sort_field risk_score for the highest risk, limit for the top N), then get_case or "
            "explain_decision for a few. app_help is only for what a term, KPI or setting means and how to use "
            "the console.") in system
    assert len(system) < 16_500
