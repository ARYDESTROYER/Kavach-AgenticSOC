"""Demo chat answers "Any suspicious activity in last 3 days ?" from the logs by rule
(Round 14): the detection rules that fired, each row opening its rule sheet, and the
events over time, the shape a live model gives that question. It never falls back to a
case list. A question that names a host, user or IP is about that entity; one that
names an entity kind ("Which hosts had suspicious activity?") counts that kind; one that
names a breakdown gets that breakdown; one about cases, a case outcome or another
subject (campaigns, ATT&CK, sources, the audit trail, automation) keeps that answer.

The end-to-end blocks (table with rule drill refs, then "Events over time") are pinned
by the golden set (``test_chat_golden_set.py``); these tests pin the routing and plan.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.engine.demo_chat import classify
from tests.test_demo_chat_round12 import drive, ran


@pytest.mark.parametrize("question, window", [
    ("Any suspicious activity in last 3 days ?", "now-3d"),
    ("anything suspicious today?", "today"),
    ("Was there any suspicious behaviour in the last 7 days?", "now-7d"),
    ("suspicious events this week", "this_week"),
    ("Something suspicious going on?", None),
    ("Any suspicious traffic in the last 2 days?", "now-2d"),
    ("Check the logs for anything suspicious", None),
])
def test_suspicious_activity_is_a_survey_of_the_rules_that_fired(question: str, window: str | None) -> None:
    ask = classify(question)
    assert (ask.intent, ask.field, ask.log_filter) == ("suspicious", "rule", ()), question
    assert (ask.win.spec if ask.win is not None else None) == window


@pytest.mark.parametrize("question, intent", [
    ("Any suspicious cases?", "cases"),
    ("Any suspicious incidents this week?", "cases"),
    ("Any suspicious logins from 203.0.113.7?", "hunt"),
    ("Is 198.51.100.7 suspicious?", "hunt"),
    ("How do I find suspicious activity?", "help"),
    ("Any suspicious activity on host dc01 in the last 3 days?", "deep"),
    ("Show suspicious alerts by severity", "top"),
])
def test_other_suspicious_questions_keep_their_own_answer(question: str, intent: str) -> None:
    assert classify(question).intent == intent, question


@pytest.mark.parametrize("question, intent, field", [
    # A question that names its own subject keeps that subject's answer: the survey is
    # decided after every rule that names one (review FX2b).
    ("Anything suspicious in the audit trail?", "audit", None),
    ("Any suspicious activity in the audit trail?", "audit", None),
    ("Any suspicious changes in the audit log?", "audit", None),
    ("Any suspicious campaigns?", "campaigns", None),
    ("Any suspicious campaigns this week?", "campaigns", None),
    ("Any suspicious MITRE techniques this week?", "mitre", None),
    ("Any suspicious MITRE techniques in the last 3 days?", "mitre", None),
    ("Any suspicious ATT&CK techniques?", "mitre", None),
    ("anything suspicious in source health?", "sources", None),
    ("Show me anything suspicious from the firewall source", "sources", None),
    ("Any suspicious sources?", "sources", None),
    ("Any suspicious approvals?", "automation", None),
    ("Investigate anything suspicious", "case", None),
    # A case outcome is a case question, never a survey of the rules that fired.
    ("Any suspicious alerts closed as false positive?", "cases", None),
    ("Any suspicious alerts escalated today?", "cases", None),
    ("Any suspicious true positives?", "tp", None),
    # A question that names the entity kind it is about (hosts, users, IPs) counts that
    # entity, the top-N answer it had before the survey existed (review FX2b).
    ("Which hosts had suspicious activity this week?", "top", "host"),
    ("Which users had suspicious activity?", "top", "user"),
    ("Which IPs show suspicious activity?", "top", "ip"),
    ("Which servers show suspicious traffic?", "top", "host"),
    ("Top hosts with suspicious activity", "top", "host"),
    ("Most active users with suspicious events", "top", "user"),
    ("Which accounts had suspicious detections today?", "top", "user"),
    ("Which hosts generated suspicious alerts?", "top", "host"),
    ("Which endpoints had anything suspicious?", "top", "host"),
    ("Any suspicious hosts?", "top", "host"),
    ("Any suspicious users in the last 3 days?", "top", "user"),
    ("Any suspicious IPs?", "top", "ip"),
    # Naming the rules first keeps the survey of the rules that fired.
    ("Which rules flagged suspicious activity?", "suspicious", "rule"),
    ("Which rules flagged suspicious activity on hosts?", "suspicious", "rule"),
])
def test_a_question_that_names_another_subject_keeps_its_answer(question: str, intent: str,
                                                                field: str | None) -> None:
    ask = classify(question)
    assert ask.intent == intent, question
    if field is not None:
        assert ask.field == field, question


@pytest.mark.parametrize("question", [
    "Was anything suspicious auto-closed?",
    "Anything suspicious resolved yesterday?",
])
def test_a_case_outcome_question_is_never_the_survey(question: str) -> None:
    assert classify(question).intent != "suspicious", question


def test_all_sources_is_the_surveys_scope_not_the_source_health_subject() -> None:
    ask = classify("Any suspicious activity across all sources in the last 3 days?")
    assert (ask.intent, ask.field, ask.log_filter) == ("suspicious", "rule", ())
    assert ask.win is not None and ask.win.spec == "now-3d"
    # Without the survey the phrase keeps its earlier meaning.
    assert classify("Are any sources silent?").intent == "sources"


def test_a_named_breakdown_keeps_its_field() -> None:
    assert classify("Show suspicious alerts by severity").field == "severity"
    assert classify("Any suspicious activity on host dc01 in the last 3 days?").entity == ("host", "dc01")


def _rule_obs(total: int) -> Any:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        assert tool == "log_stats", tool
        top = [{"value": "Entra sign-in", "count": 12}, {"value": "SSHD-SESSION", "count": 9}] if total else []
        return {"total": total, "window": "last 3 days", "group_by": ["rule"], "top": {"rule": top},
                "other": {"rule": 0}, "basis": "exact", "sources": {"answered": 5, "queried": 5}}
    return obs


def test_the_plan_counts_events_by_rule_over_the_named_window() -> None:
    rounds, _header, body = drive("Any suspicious activity in last 3 days ?", _rule_obs(21))
    assert ran(rounds) == [("log_stats", {"group_by": ["rule"], "top_n": 10, "time_from": "now-3d"})]
    assert "**21 events**" in body and "by rule, " in body
    assert "not confirmed threats" in body and "I could not map that" not in body
    assert "\u2014" not in body


def test_no_window_named_reads_the_last_24_hours() -> None:
    rounds, _header, _body = drive("Anything suspicious?", _rule_obs(3))
    assert ran(rounds)[0][1]["time_from"] == "now-24h"


def test_a_quiet_window_says_so() -> None:
    _rounds, _header, body = drive("Any suspicious activity in last 3 days ?", _rule_obs(0))
    assert body.startswith("No log events") and "not confirmed threats" not in body


def test_the_new_copy_is_plain() -> None:
    from app.engine import demo_chat

    for text in (demo_chat._SUSPICIOUS_NOTE, demo_chat._INTENT_TITLES["suspicious"],
                 demo_chat._INTENT_SUBJECTS["suspicious"], *(t for t, _ in demo_chat._CHIPS["suspicious"])):
        assert "\u2014" not in text and "\u2013" not in text and "playbook" not in text.lower(), text
