"""Round 13 polish (PB5): entity investigations, tie wording and the reference length
rule of the start cards.

Offline and pure where it can be (the Demo planner driven round by round over
synthetic lookups, exactly as the engine builds its prompts), and through the real
starter engine where the card is built. The end-to-end golden questions live in
``test_chat_golden_set`` (``ENTITY_INVESTIGATIONS`` and the two new starter templates).

1. An investigation that names an entity (user, host, IP, domain, hash, or a name of no
   stated kind) investigates that entity over the window it names; a case is chosen
   only when the question names one.
2. An answer calls one item the highest, the most, the oldest or the top only when no
   other item shares its figure as the answer shows it; a tie names the others and
   says how one was picked.
3. One length rule for a reference in a card's question, for every reference kind: a
   word longer than 27 characters keeps the reference out of the question (the rule
   card's and the source card's wordings without it), never truncated, and the two new
   wordings parse back uniquely.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.agents import chat_starter_text as text
from app.agents.chat_tools.cases import ASSIGNEE_ME_OWN
from app.constants import UNTRUSTED_OPEN
from app.engine import demo_chat
from app.engine.demo_chat import Result, classify, read_prompt
from app.models import CaseStatus
from tests.test_chat_starters_engine import _build, _card, _case, _seed
from tests.test_chat_starters_engine import as_alice  # noqa: F401 -- the signed-in caller fixture
from tests.test_demo_chat_planner import prompt
from tests.test_demo_chat_round12 import drive, ran
from tests.test_demo_chat_round13 import _starter


def _win(ask: Any) -> Any:
    return ask.win.spec if ask.win is not None else None


# --------------------------------------------------------------------------- #
# 1. Entity investigations.
# --------------------------------------------------------------------------- #
_HASH = "44d88612fea8a8f36de82e1278abb02f"


@pytest.mark.parametrize("question, intent, target, window", [
    # The re-shoot's misrouted question (06-misrouted-user-question-390l.png).
    ("Investigate the activity of user pnair in the last 3 days and the cases it appears in",
     "deep", ("user", "pnair"), "now-3d"),
    ("Investigate host srv-db-01 yesterday", "deep", ("host", "srv-db-01"), "yesterday"),
    ("Investigate account svc_backup this week", "deep", ("user", "svc_backup"), "this_week"),
    ("Look into workstation WS-042 today", "deep", ("host", "WS-042"), "today"),
    ("What did user jdoe do over the last week?", "deep", ("user", "jdoe"), "now-7d"),
    ("Dig into host dc01 this month", "deep", ("host", "dc01"), "this_month"),
    ("Show the activity of user pnair over the past 2 weeks", "deep", ("user", "pnair"), "now-2w"),
    ("Investigate the user pnair", "deep", ("user", "pnair"), None),
    ("Investigate user j.smith@corp.example", "deep", ("user", "j.smith@corp.example"), None),
    ("Investigate host web01.corp.example", "deep", ("host", "web01.corp.example"), None),
    # The same question with an IP (it routed correctly before and still does).
    ("Investigate the activity of IP 192.0.2.90 in the last 3 days and the cases it appears in",
     "hunt", ("192.0.2.90", "ip"), "now-3d"),
    ("Investigate IP 10.0.0.5 yesterday", "hunt", ("10.0.0.5", "ip"), "yesterday"),
    ("Investigate domain bad.example.com this week", "hunt", ("bad.example.com", "domain"), "this_week"),
    ("Show the activity of domain bad.example.com today", "hunt", ("bad.example.com", "domain"), "today"),
    (f"Investigate file hash {_HASH} over the past 2 weeks", "hunt", (_HASH, "hash"), "now-2w"),
    # A name of no stated kind: its log events and the cases that carry it.
    ("Investigate pnair's activity in the last 24 hours", "hunt", ("pnair", "keyword"), "now-24h"),
    ("Investigate the activity of pnair", "hunt", ("pnair", "keyword"), None),
    ("Investigate pnair", "hunt", ("pnair", "keyword"), None),
])
def test_an_investigation_that_names_an_entity_investigates_it(question: str, intent: str, target: tuple[str, str],
                                                               window: Any) -> None:
    ask = classify(question)
    assert ask.intent == intent, (question, ask.intent)
    assert (ask.entity if intent == "deep" else ask.indicator) == target, question
    assert _win(ask) == window, (question, _win(ask))
    # Never a case the question did not name.
    assert ask.case_id is None and ask.case_status is None, question


@pytest.mark.parametrize("question, case_id, status", [
    ("Investigate CASE-000089", "CASE-000089", None),
    ("Investigate the newest escalated case", None, "escalated"),
])
def test_a_case_is_chosen_only_when_the_question_names_one(question: str, case_id: str | None,
                                                           status: str | None) -> None:
    ask = classify(question)
    assert ask.intent == "case" and ask.case_id == case_id and ask.case_status == status


@pytest.mark.parametrize("question, intent", [
    ("What did the agents do today?", "audit"),
    ("What did analysts do this week?", "audit"),
    ("Investigate failed logins for user pnair", "brute"),
    ("Investigate everything about host dc01", "deep"),
])
def test_other_questions_keep_their_plans(question: str, intent: str) -> None:
    assert classify(question).intent == intent


def test_a_case_manager_chat_stays_about_its_case() -> None:
    view = read_prompt(prompt("x", case_scoped=True))
    assert classify("Investigate user pnair", view).intent == "case"


def test_the_reshoot_question_looks_up_the_user_over_its_window_and_no_escalated_case() -> None:
    rounds, header, body = drive(
        "Investigate the activity of user pnair in the last 3 days and the cases it appears in")
    calls = ran(rounds)
    assert ("search_logs", {"user": "pnair", "time_from": "now-3d"}) in calls
    assert any(t == "search_cases" and i.get("entity") == "pnair" and i.get("window") == "now-3d" for t, i in calls)
    assert not any(t == "search_cases" and i.get("status") == "escalated" for t, i in calls)
    # (The window words come from the lookup's own label; these synthetic lookups label none.)
    assert body.startswith("**In-depth investigation of user `pnair`"), body[:200]


def test_a_name_of_no_stated_kind_is_searched_as_a_keyword_without_a_reputation_lookup() -> None:
    rounds, header, body = drive("Investigate pnair's activity in the last 24 hours")
    calls = ran(rounds)
    assert ("search_logs", {"contains": "pnair", "time_from": "now-24h"}) in calls
    assert ("search_cases", {"entity": "pnair", "limit": 10}) in calls
    assert not any(t == "lookup_indicator" for t, _i in calls)
    assert header["title"].startswith("Keyword hunt"), header


# --------------------------------------------------------------------------- #
# 2. Ties.
# --------------------------------------------------------------------------- #
def _mine(*rows: dict[str, Any]):
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "search_cases":
            return {"count": len(rows), "assignee_me": ASSIGNEE_ME_OWN, "filters": {"assignee": "me"},
                    "cases": list(rows)}
        return {"total": len(rows), "groups": []}
    return obs


def _row(number: str, risk: float, created: str | None = None, **kw: Any) -> dict[str, Any]:
    row = {"case_id": f"id-{number}", "case_number": number, "title": "user:pnair · demo_impossible_travel",
           "status": "investigating", "risk_score": risk, "severity": "high"}
    if created:
        row["created_at"] = created
    row.update(kw)
    return row


_MY_QUESTION = "Which of my open cases should I work on first?"


def test_my_cases_says_a_tie_for_the_highest_risk_truthfully() -> None:
    """The re-shoot: CASE-000046 and CASE-000043 both at risk 62 (61.6 is shown as 62).
    The lead never says "it has the highest risk"; it starts with the first listed (the
    list, its block and its follow-ups lead with it), names the other and says what sets
    it apart."""
    _r, _h, body = drive(_MY_QUESTION, _mine(
        _row("CASE-000046", 62, "2026-10-23T10:00:00Z"), _row("CASE-000043", 61.6, "2026-10-22T09:00:00Z"),
        _row("CASE-000045", 40, "2026-10-21T08:00:00Z")))
    assert "it has the highest risk" not in body
    assert ("Start with **`CASE-000046`** (`demo_impossible_travel` on user `pnair`): it is tied with "
            "`CASE-000043` for the highest risk of your open cases (62); it was opened more recently.") in body, body
    _r, _h, body = drive(_MY_QUESTION, _mine(
        _row("CASE-000043", 62, "2026-10-22T09:00:00Z"), _row("CASE-000046", 62, "2026-10-23T10:00:00Z")))
    assert "it is tied with `CASE-000046` for the highest risk of your open cases (62); it has been open longer." \
        in body, body


def test_my_cases_without_a_tie_keeps_the_plain_lead() -> None:
    _r, _h, body = drive(_MY_QUESTION, _mine(_row("CASE-000046", 70), _row("CASE-000043", 62)))
    assert "Start with **`CASE-000046`** (`demo_impossible_travel` on user `pnair`): it has the highest risk of " \
           "your open cases." in body


def test_my_cases_tie_without_opening_times_names_both_and_gives_no_reason() -> None:
    _r, _h, body = drive(_MY_QUESTION, _mine(_row("CASE-000046", 62), _row("CASE-000043", 62),
                                             _row("CASE-000041", 62)))
    assert ("it is tied with `CASE-000043` and `CASE-000041` for the highest risk of your open cases (62).") in body


def _result(tool: str, obs: dict[str, Any], **inp: Any) -> Result:
    return Result(ordinal=1, tool=tool, status="ok", summary="ok", observation=obs, input=dict(inp))


def test_a_trend_peak_reached_twice_is_not_one_peak() -> None:
    r = _result("soc_metrics", {"new_cases": [1, 4, 2, 4, 0], "closed": [0, 1, 1, 0, 0], "bucket": "day",
                                "window": "last 5 days"})
    sentence = demo_chat._say_trends(r)
    assert "the peak was" not in sentence
    assert "the peak, 4 new cases, came in 2 daily buckets, most recently 1 day before the latest" in sentence, sentence
    single = demo_chat._say_trends(_result("soc_metrics", {"new_cases": [1, 4, 2], "bucket": "day",
                                                           "window": "last 3 days"}))
    assert "the peak was 1 day before the latest, with 4 new cases" in single, single


def test_spend_timing_and_automation_ties_name_every_period() -> None:
    spend = demo_chat._say_spend_buckets({"bucket": "month", "spend_per_bucket": {
        "buckets": ["Aug 2026", "Sep 2026", "Oct 2026"], "cost_usd": [0.5, 0.5, 0.2]}})
    assert spend.startswith("By month: the most was spent in Aug 2026 and Sep 2026 ($0.5000 each);"), spend
    timing = demo_chat._say_bucket_metric({
        "bucket": "week", "units": {"mttr_median": "minutes"},
        "buckets": [{"label": "W39 2026"}, {"label": "W40 2026"}, {"label": "W41 2026"}],
        "groups": [{"bucket": "W39 2026", "metrics": {"mttr_median": 40}},
                   {"bucket": "W40 2026", "metrics": {"mttr_median": 40}},
                   {"bucket": "W41 2026", "metrics": {"mttr_median": 12}}]}, "mttr_median", "MTTR median")
    assert "highest 40 min in W39 2026 and W40 2026" in timing, timing
    automation = demo_chat._say_bucket_automation({
        "bucket": "month", "buckets": [{"label": "Aug 2026"}, {"label": "Sep 2026"}, {"label": "Oct 2026"}],
        "groups": [{"bucket": "Aug 2026", "metrics": {"auto_closed": 1, "human_closed": 1}},
                   {"bucket": "Sep 2026", "metrics": {"auto_closed": 2, "human_closed": 2}},
                   {"bucket": "Oct 2026", "metrics": {"auto_closed": 9, "human_closed": 1}}]})
    assert "lowest 50% in Aug 2026 and Sep 2026" in automation, automation


def _shift_obs(breached: list[dict[str, Any]], attention: list[dict[str, Any]]):
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "shift_report":
            return {"window_hours": 24, "window": "last 24 hours",
                    "headline": {"open": 12, "sla_breached": len(breached), "escalated": 2, "unassigned": 1},
                    "attention": attention,
                    "sla": {"enabled": True, "totals": {"open": 12, "breached": len(breached), "about_to_breach": 0},
                            "breached": breached, "about_to_breach": []},
                    "workload": [], "deltas": {}}
        if tool == "soc_metrics":
            return {"active_risk_index": 40, "window": "last 24 hours"}
        return {"total": 0, "campaigns": []}
    return obs


def test_the_shift_lead_names_cases_tied_as_the_most_overdue() -> None:
    breached = [{"case_id": "a", "case_number": "CASE-000004", "overdue_minutes": 600},
                {"case_id": "b", "case_number": "CASE-000005", "overdue_minutes": 600},
                {"case_id": "c", "case_number": "CASE-000014", "overdue_minutes": 30}]
    _r, _h, body = drive("Write my shift brief for the last 24 hours", _shift_obs(breached, []))
    assert "tied with `CASE-000005` as the most overdue of the 3 cases past SLA" in body, body[:600]
    assert "the most overdue of the 3 cases past SLA" not in body.replace("as the most overdue of", "")


def test_the_riskiest_related_case_of_a_deep_investigation_says_when_it_is_tied() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "search_cases":
            return {"count": 2, "filters": {"entity": "pnair"}, "window": "last 30 days",
                    "cases": [_row("CASE-000064", 62, entity="user:pnair"), _row("CASE-000065", 62,
                                                                                  entity="user:pnair")]}
        if tool == "get_case":
            return {"case": _row("CASE-000064", 62, entity="user:pnair")}
        return {"total": 0, "window": "last 30 days"}
    _r, _h, body = drive("Investigate user pnair", obs)
    assert "Riskiest related case:" not in body
    assert "One of the riskiest related cases (tied at risk 62 with `CASE-000065`):" in body, body[:800]


# --------------------------------------------------------------------------- #
# 3. The reference length rule (every kind) and the wordings without a reference.
# --------------------------------------------------------------------------- #
_UUID = "3b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"


def test_one_length_rule_for_every_reference_kind() -> None:
    assert text.QUESTION_REF_WORD_MAX == 27
    assert text.ref_fits_question("a" * 27) and not text.ref_fits_question("a" * 28)
    assert not text.ref_fits_question(_UUID) and text.ref_fits_question("demo_impossible_travel")
    # A display name is measured word by word (it wraps at its spaces).
    assert text.ref_fits_question("Splunk Enterprise Security (HEC)")
    assert not text.ref_fits_question("Network " + "x" * 28)
    assert not text.ref_fits_question("") and not text.ref_fits_question(None)


@pytest.mark.parametrize("template_id, slots, question", [
    ("noisy_rule_unnamed", {"n": 12, "m": 40},
     "Which detection rule created 12 of the 40 cases in the last 24 hours, and why?"),
    ("silent_source_unnamed", {}, "Which log source has gone quiet, and is ingestion working?"),
])
def test_the_wordings_without_a_reference_render_and_parse_back_uniquely(template_id: str, slots: dict[str, Any],
                                                                        question: str) -> None:
    assert text.render_question(template_id, slots) == question
    assert text.parse_starter_question(question) == (template_id, slots)
    spec = text.TEMPLATES[template_id]
    assert spec.ref_slot is None and spec.family in ("noisy_rule", "silent_source")
    turn = text.render_starter_turn(question)
    if spec.has_counts:
        # Counts only: the question, then the counts note; no fence, nothing to fence.
        assert turn == f"{question}\n{text.STARTER_COUNTS_NOTE}" and UNTRUSTED_OPEN not in turn
        assert text.parse_starter_turn(turn) == (template_id, slots)
    else:
        assert turn is None  # sent as written, like every slot-free question


@pytest.mark.usefixtures("as_alice")
async def test_a_long_rule_id_keeps_the_noisy_rule_card_without_the_id(app_state) -> None:
    now = datetime(2026, 10, 17, 10, 5, tzinfo=UTC)
    noisy = [_case(f"u{i}", created=now - timedelta(minutes=10 + i), status=CaseStatus.CLOSED, rules=[_UUID])
             for i in range(14)]
    other = [_case(f"o{i}", created=now - timedelta(minutes=80 + i), status=CaseStatus.CLOSED, rules=[f"r{i}"])
             for i in range(10)]
    await _seed(app_state, *noisy, *other)
    card = _card(await _build(app_state, now=now), "noisy_rule")
    assert card is not None and card.template == "noisy_rule_unnamed" and card.ref is None
    assert card.prompt == "Which detection rule created 14 of the 24 cases in the last 24 hours, and why?"
    assert _UUID not in card.prompt and card.reason == "58% of new cases"
    # Novelty and Hide for a day stay per rule (the id keys the card; it is never shown).
    from app.engine.chat_starters import starter_key
    from app.models import ChatStarterRef
    assert card.key == starter_key("noisy_rule", ChatStarterRef(kind="rule", value=_UUID))


@pytest.mark.usefixtures("as_alice")
@pytest.mark.parametrize("rule, template_id", [("r" * 27, "noisy_rule"), ("r" * 28, "noisy_rule_unnamed")])
async def test_the_rule_card_names_a_rule_up_to_the_bound(app_state, rule: str, template_id: str) -> None:
    now = datetime(2026, 10, 17, 10, 5, tzinfo=UTC)
    await _seed(app_state, *[_case(f"u{i}", created=now - timedelta(minutes=10 + i), status=CaseStatus.CLOSED,
                                   rules=[rule]) for i in range(12)],
                *[_case(f"o{i}", created=now - timedelta(minutes=80 + i), status=CaseStatus.CLOSED, rules=[f"x{i}"])
                  for i in range(8)])
    card = _card(await _build(app_state, now=now), "noisy_rule")
    assert card is not None and card.template == template_id
    assert (rule in card.prompt) == (template_id == "noisy_rule")


def test_starter_from_template_refuses_a_long_reference_except_a_case_id() -> None:
    from app.engine.chat_starters import starter_from_template
    with pytest.raises(ValueError):
        starter_from_template("noisy_rule", {"rule": _UUID, "n": 12, "m": 40})
    with pytest.raises(ValueError):
        starter_from_template("silent_source", {"source": "elastic-prod-cluster-security-logs"})
    # A case without a display number keeps its internal id (no wording without the
    # reference names one case among several; a deployment with numbering off).
    case_id = "case-062c11bc99b64c92853d96a798730094"
    card = starter_from_template("needs_human", {"case": case_id})
    assert case_id in card.prompt and card.ref is not None and card.ref.value == case_id


def _unnamed_noisy_obs(groups: list[tuple[str, int]], total: int):
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "case_stats" and inp.get("group_by") == ["rule"]:
            return {"window": "last 24 hours", "total": total, "totals": {"count": total},
                    "groups": [{"key": {"rule": r}, "metrics": {"count": n}} for r, n in groups]}
        if tool == "case_stats" and inp.get("group_by") == ["verdict"]:
            n = next(n for r, n in groups if r == inp.get("rule"))
            return {"window": "last 24 hours", "total": n, "totals": {"count": n},
                    "groups": [{"key": {"verdict": "FALSE_POSITIVE"}, "metrics": {"count": n}}]}
        if tool == "case_stats":
            return {"window": "last 24 hours", "total": total, "totals": {"count": total}, "groups": []}
        if tool == "search_cases":
            return {"count": 1, "window": "last 24 hours", "filters": {"rule": inp.get("rule")},
                    "cases": [_row("CASE-000070", 30)]}
        return {}
    return obs


def test_the_unnamed_rule_card_is_answered_about_the_rule_it_counted() -> None:
    turn = _starter("noisy_rule_unnamed", {"n": 12, "m": 40})
    rounds, header, body = drive(turn, _unnamed_noisy_obs([("demo_noisy_scanner", 14), (_UUID, 12),
                                                           ("demo_impossible_travel", 3)], 40))
    calls = ran(rounds)
    # Found by its count (12), not the largest (14), then looked at by its id.
    assert ("case_stats", {"window": "now-24h", "rule": _UUID, "group_by": ["verdict"]}) in calls
    assert body.startswith(f"Detection rule `{_UUID}` created **12 cases** of the 40 in the last 24 hours (30%)."), \
        body[:300]
    assert "The suggestion counted" not in body and "No rule has exactly" not in body


def test_the_unnamed_rule_card_names_every_rule_tied_at_its_count() -> None:
    turn = _starter("noisy_rule_unnamed", {"n": 12, "m": 40})
    _r, header, body = drive(turn, _unnamed_noisy_obs([("rule_b", 12), ("rule_a", 12), ("rule_c", 3)], 40))
    assert body.startswith("Detection rules `rule_b` and `rule_a` each created **12 cases** of the 40 in the last 24 "
                           "hours (30% each), tied at that count; the rest of this answer is about `rule_b`, listed "
                           "first."), body[:400]
    assert header["title"] == "Noisy detection rule"  # never one of the tied rules alone


def test_the_unnamed_rule_card_never_calls_another_rule_the_same_one_moved() -> None:
    turn = _starter("noisy_rule_unnamed", {"n": 12, "m": 40})
    _r, _h, body = drive(turn, _unnamed_noisy_obs([("rule_b", 15), ("rule_c", 3)], 40))
    assert "The suggestion counted" not in body
    assert ("No rule has exactly 12 cases in the last 24 hours now, the count the suggestion showed; `rule_b` is the "
            "rule with the most.") in body, body[:400]


def test_the_unnamed_source_card_is_answered_about_the_quiet_sources() -> None:
    question = text.render_question("silent_source_unnamed", {})
    view = read_prompt(prompt(question))
    assert view.starter == ("silent_source_unnamed", {})

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        return {"sources": [{"source_id": "s1", "name": "Wazuh", "enabled": True, "silent": True}],
                "coverage": {"sources_enabled": 1, "sources_total": 1, "sources_silent": 1}}
    _r, _h, body = drive(question, obs)
    assert body.startswith("**1 log source** is quiet now: `Wazuh`."), body[:300]
