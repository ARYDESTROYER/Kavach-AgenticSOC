"""Round 13 polish (PB6): the Demo planner's investigations after the final re-shoot.

Offline and pure (the Demo planner classified, or driven round by round over synthetic
lookups exactly as the engine builds its prompts). The end-to-end regression questions
live in ``test_chat_golden_set`` (``INVESTIGATION_ROUTES``).

1. A name of no stated kind is hunted only when no other rule reads the word: an ATT&CK
   id is the technique plan's, cost and spend the cost plan's, sources and ingestion
   source health's, tuning and approvals automation status's, and product words such
   as autopilot, enrichment or risk the Help Center's (as before PB5).
2. A full stop inside a name is part of it ("admin@corp.example", "T1059.001"), and an
   email address is investigated as a user, never as its domain.
3. "Investigate …" picks a case only when it picks one (by recency or status, or by
   pointing back at the conversation); a named detection rule, a named log source,
   an attack type and a request for records each get their own plan.
4. Ties are said as the answer writes the figure, and a rule tied for the most is never
   called "the rule with the most".
"""

from __future__ import annotations

from typing import Any

import pytest

from app.engine import demo_chat
from app.engine.demo_chat import classify, read_prompt
from tests.test_demo_chat_planner import prompt
from tests.test_demo_chat_round12 import drive, ran
from tests.test_demo_chat_round13 import _starter
from tests.test_round13_polish_pb5 import _unnamed_noisy_obs


# --------------------------------------------------------------------------- #
# 1. Words another rule reads are never hunted as names.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question, intent, extra", [
    # The re-shoot's questions (rev-18-t1059-1440l.png, rev-19-ingestion-1440l.png).
    ("Investigate T1059.001", "mitre", {"techniques": ("T1059.001",)}),
    ("Investigate T1110", "mitre", {"techniques": ("T1110",)}),
    ("What is ingestion doing?", "sources", {}),
    ("Investigate ingestion", "sources", {}),
    ("Investigate sources", "sources", {}),
    ("Investigate costs", "cost", {}),
    ("What did spend do this week?", "cost", {}),
    ("What did tuning do?", "automation", {"metric": "tuning"}),
    ("Investigate approvals", "automation", {"metric": "approvals"}),
    ("Investigate MTTR", "metric", {"metric": "timing"}),
    ("What has autopilot been doing?", "help", {}),
    ("What did enrichment do?", "help", {}),
    ("What is risk doing?", "help", {}),
])
def test_a_word_another_rule_reads_keeps_that_rule(question: str, intent: str, extra: dict[str, Any]) -> None:
    ask = classify(question)
    assert ask.intent == intent, (question, ask.intent, ask.indicator)
    assert ask.indicator is None, question
    for key, value in extra.items():
        assert getattr(ask, key) == value, (question, key, getattr(ask, key))


def test_activity_by_a_breakdown_field_is_not_a_hunt_for_the_field() -> None:
    ask = classify("Show activity by severity")
    assert ask.intent != "hunt" and ask.indicator is None, (ask.intent, ask.indicator)


@pytest.mark.parametrize("question, value", [
    ("Investigate pnair", "pnair"),
    ("Investigate mimikatz", "mimikatz"),
    ("What has svc_backup been up to?", "svc_backup"),
    # A name the planner cannot place among the console's people or the log's users is
    # still searched for: its log events and the cases that carry it.
    ("What did alice do today?", "alice"),
])
def test_a_plain_name_is_still_hunted_as_a_keyword(question: str, value: str) -> None:
    ask = classify(question)
    assert ask.intent == "hunt" and ask.indicator == (value, "keyword"), (question, ask.intent, ask.indicator)


def test_the_technique_question_reads_the_technique_not_a_log_keyword() -> None:
    rounds, _header, body = drive("Investigate T1059.001")
    calls = ran(rounds)
    assert not any(t == "search_logs" for t, _i in calls), calls
    assert "No log events match" not in body


# --------------------------------------------------------------------------- #
# 2. A full stop inside a name; an email address is a user.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question, intent, target", [
    ("Look into the activity of admin@corp.example", "deep", ("user", "admin@corp.example")),
    ("Investigate jdoe@corp.example", "deep", ("user", "jdoe@corp.example")),
    ("Investigate email jdoe@corp.example", "deep", ("user", "jdoe@corp.example")),
    ("Investigate jdoe@corp.example over the last week", "deep", ("user", "jdoe@corp.example")),
    ("Investigate user j.smith@corp.example", "deep", ("user", "j.smith@corp.example")),
    # A sentence's own full stop still ends the name.
    ("Investigate dc01.", "hunt", ("dc01", "keyword")),
    ("Look into the activity of j.smith.", "hunt", ("j.smith", "keyword")),
    ("The activity of svc.backup this week", "hunt", ("svc.backup", "keyword")),
])
def test_a_name_keeps_its_dots_and_an_email_is_a_user(question: str, intent: str, target: tuple[str, str]) -> None:
    ask = classify(question)
    assert ask.intent == intent, (question, ask.intent, ask.indicator, ask.entity)
    assert (ask.entity if intent == "deep" else ask.indicator) == target, question


def test_an_email_investigation_reads_the_user_never_the_domain() -> None:
    rounds, _header, body = drive("Investigate jdoe@corp.example")
    calls = ran(rounds)
    assert any(t == "search_logs" and i.get("user") == "jdoe@corp.example" for t, i in calls), calls
    assert not any(i.get("indicator") == "corp.example" or i.get("contains") == "corp.example" for _t, i in calls)
    assert body.startswith("**In-depth investigation of user `jdoe@corp.example`"), body[:200]


def _deep_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
    """Log rankings whose window label carries its dates (and so its own "; ")."""
    if tool == "log_stats" and (inp.get("group_by") or [None])[0] in ("host", "rule", "ip"):
        field = inp["group_by"][0]
        return {"total": 5, "window": "last 30 days (since 24 Sep 2026)", "group_by": [field],
                "top": {field: [{"value": f"{field}-a", "count": 3}, {"value": f"{field}-b", "count": 2}]},
                "sources": [{"status": "ok"}, {"status": "ok"}]}
    return {}


def test_an_in_depth_ranking_after_a_dated_window_starts_at_its_field() -> None:
    _rounds, _header, body = drive("Investigate user pnair", _deep_obs)
    assert ("- **5 events** for `pnair` in the last 30 days (since 24 Sep 2026; 2 of 2 sources answered); by host, "
            "`host-a` leads") in body, body[:600]
    assert "- By rule, `rule-a` leads with 3 events" in body, body[:900]
    assert "\n- 2 of 2 sources answered)" not in body and "- 2 of 2 sources" not in body


# --------------------------------------------------------------------------- #
# 3. "Investigate …" picks a case only when the question picks one.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("question", [
    "Investigate the newest escalated case",
    "Investigate the latest escalated case",
    "Investigate the escalations",
    "Investigate it",
    "Investigate further",
    "Can you investigate this?",
])
def test_an_investigation_that_picks_a_case_investigates_one(question: str) -> None:
    ask = classify(question)
    assert ask.intent == "case" and ask.case_status == "escalated", (question, ask.intent)


@pytest.mark.parametrize("question, rule, window", [
    ("Investigate rule LP-ES-RISK-1001", "LP-ES-RISK-1001", None),
    ("Investigate the noisy rule LP-ES-RISK-1001", "LP-ES-RISK-1001", None),
    ("Investigate detection rule demo_impossible_travel this week", "demo_impossible_travel", "this_week"),
    ("Investigate rule `web_portal_auth`", "web_portal_auth", None),
])
def test_an_investigation_of_a_named_rule_reads_that_rules_cases(question: str, rule: str, window: Any) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown" and ask.rule == rule and ask.group == "verdict", (question, ask.intent)
    assert (ask.win.spec if ask.win else None) == window
    rounds, header, body = drive(question)
    calls = ran(rounds)
    assert any(t == "case_stats" and i.get("rule") == rule and i.get("group_by") == ["verdict"] for t, i in calls)
    assert not any(t == "search_cases" and i.get("status") == "escalated" for t, i in calls), calls
    assert "escalated case" not in body
    # The conversation is named by the rule, as the title rules allow a rule id.
    assert header["title"] == f"Rule {rule} cases", header


def test_rule_words_that_name_no_rule_are_not_a_rule() -> None:
    assert classify("Investigate rule versions").rule is None
    assert classify("Investigate the rule that fired most").rule is None


@pytest.mark.parametrize("question, rule", [
    # A word inside the id asks for nothing: "cost" is no cost question, "risk" no
    # average risk, "brute" no failed sign-ins.
    ("Investigate rule LP-COST-7", "LP-COST-7"),
    ("Investigate rule LP-ES-RISK-1001", "LP-ES-RISK-1001"),
    ("Investigate rule WIN-BRUTE-FORCE-4625", "WIN-BRUTE-FORCE-4625"),
    ("Look into rule demo_impossible_travel this week", "demo_impossible_travel"),
])
def test_a_rule_ids_own_words_ask_for_nothing(question: str, rule: str) -> None:
    ask = classify(question)
    assert ask.intent == "breakdown" and ask.rule == rule, (question, ask.intent)
    rounds, _header, _body = drive(question)
    stats = [i for t, i in ran(rounds) if t == "case_stats"]
    assert stats and all(i.get("rule") == rule and "metrics" not in i for i in stats), stats


def _sources_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
    if tool == "source_health":
        return {"sources": [
            {"source_id": "s1", "name": "Wazuh Manager (endpoint telemetry)", "type": "wazuh", "enabled": True,
             "silent": True},
            {"source_id": "s2", "name": "IBM QRadar SIEM", "type": "qradar", "enabled": True}],
            "coverage": {"sources_enabled": 2, "sources_total": 2, "sources_silent": 1}}
    if tool == "search_logs":
        return {"total": 3, "window": "last 24 hours", "sources": [{"status": "ok"}], "filters": {}}
    return {}


def test_an_investigation_of_a_named_source_reads_its_health_and_events() -> None:
    ask = classify("Investigate source wazuh")
    assert ask.intent == "source_events" and ask.slot("source") == "wazuh"
    rounds, _header, body = drive("Investigate source wazuh", _sources_obs)
    calls = ran(rounds)
    assert ("source_health", {}) in calls
    assert any(t == "search_logs" and i.get("source_id") == "s1" for t, i in calls), calls
    assert body.startswith("`Wazuh Manager (endpoint telemetry)` is silent.\n"), body[:300]
    assert "Recent events from `Wazuh Manager (endpoint telemetry)`" in body


def test_a_source_that_is_not_configured_says_so_and_lists_the_configured_ones() -> None:
    _rounds, _header, body = drive("Investigate source wazuh-prod", _sources_obs)
    assert body == ("No log source named `wazuh-prod` is configured, so there are no events to show.\n\n"
                    "Configured sources: `Wazuh Manager (endpoint telemetry)` and `IBM QRadar SIEM`."), body


@pytest.mark.parametrize("question, intent, check", [
    ("Investigate ransomware", "pivot", {"keyword": "ransom"}),
    ("Investigate the false positives from yesterday", "cases", {}),
    ("Investigate today's alerts", "cases", {}),
    ("Investigate the last 3 days of alerts", "cases", {}),
    ("Investigate the source that went quiet", "sources", {}),
    ("Investigate the campaign", "campaigns", {}),
    # A ranking is a list, never the newest escalated case under another name.
    ("Investigate the riskiest case", "cases", {}),
    ("Investigate the top 5 cases by risk", "cases", {}),
    ("Investigate the oldest open case", "cases", {}),
])
def test_an_investigation_of_something_else_gets_its_own_plan(question: str, intent: str,
                                                              check: dict[str, Any]) -> None:
    ask = classify(question)
    assert ask.intent == intent, (question, ask.intent)
    for key, value in check.items():
        assert getattr(ask, key) == value


def test_the_false_positives_of_a_day_are_listed_not_the_newest_escalated_case() -> None:
    rounds, _header, _body = drive("Investigate the false positives from yesterday")
    calls = ran(rounds)
    assert any(t == "search_cases" and i.get("verdict") == "FALSE_POSITIVE" and i.get("window") == "yesterday"
               for t, i in calls), calls
    assert not any(i.get("status") == "escalated" for _t, i in calls), calls


def test_an_investigation_naming_nothing_the_planner_reads_starts_from_the_newest_escalated_case() -> None:
    ask = classify("Investigate lateral movement")
    assert ask.intent == "case" and ask.case_status == "escalated"
    _rounds, _header, body = drive("Investigate lateral movement")
    assert "the newest of" in body, body[:300]   # the answer says how the case was chosen


def test_a_case_manager_chat_still_investigates_its_case() -> None:
    view = read_prompt(prompt("x", case_scoped=True))
    for question in ("Investigate rule LP-ES-RISK-1001", "Investigate the false positives from yesterday"):
        assert classify(question, view).intent == "case", question


# --------------------------------------------------------------------------- #
# 4. Ties.
# --------------------------------------------------------------------------- #
def test_a_rule_tied_for_the_most_is_never_called_the_rule_with_the_most() -> None:
    turn = _starter("noisy_rule_unnamed", {"n": 12, "m": 40})
    _r, _h, body = drive(turn, _unnamed_noisy_obs([("rule_b", 15), ("rule_a", 15), ("rule_c", 3)], 40))
    assert body.startswith("Detection rules `rule_b` and `rule_a` each created **15 cases**"), body[:300]
    assert ("No rule has exactly 12 cases in the last 24 hours now, the count the suggestion showed; `rule_b`, listed "
            "first, is one of the rules tied for the most.") in body, body[:600]
    assert "is the rule with the most" not in body


def test_spend_periods_that_read_the_same_are_a_tie() -> None:
    spend = demo_chat._say_spend_buckets({"bucket": "month", "spend_per_bucket": {
        "buckets": ["Aug 2026", "Sep 2026", "Oct 2026"], "cost_usd": [0.00269, 0.00271, 0.001]}})
    assert spend.startswith("By month: the most was spent in Aug 2026 and Sep 2026 ($0.0027 each);"), spend
    single = demo_chat._say_spend_buckets({"bucket": "month", "spend_per_bucket": {
        "buckets": ["Aug 2026", "Sep 2026"], "cost_usd": [0.0024, 0.0027]}})
    assert single.startswith("By month: the most was spent in Sep 2026 ($0.0027);"), single
