"""Round 13 unit tests for the deterministic Demo Mode chat planner (WP-DEMO13).

Offline and pure, like ``test_demo_chat_round12``: prompts are built exactly as the
engine builds them and the planner is driven round by round. Covered (SPEC-chat §3.4,
§3.8, §3.14, §4.1, §7.3; T4, T6, T15, T36, T37, A8):

* a starter turn is planned from its template and slots: the referenced value is
  read from its ``entity_ref`` fence only, never from the question text;
* the title of a conversation's first answer, and none later or in a case chat;
* a chip about "this answer" re-reads that answer's lookup this turn before using the
  value it returned; a zero-result chip's display words map back to input keys;
* case numbers instead of internal ids; Demo seed strings without em dashes;
* report next steps from the report's own figures; volume and false positives together.
"""

from __future__ import annotations

import json
import time
from typing import Any

import pytest

from app.agents.chat_protocol import PriorExchange, parse_reply
from app.agents.chat_starter_text import STARTER_REF_NOTE, render_question, render_starter_turn
from app.engine import demo_chat, demo_generator, demo_sources
from app.engine.demo_chat import classify, plan_turn, read_prompt
from tests.test_demo_chat_planner import (
    POSTURE_ARTS,
    POSTURE_OBS,
    TRENDS_ARTS,
    TRENDS_OBS,
    art,
    call,
    final_of,
    prompt,
    tools_of,
)
from tests.test_demo_chat_round12 import drive, ran


def _starter(template_id: str, slots: dict[str, Any] | None = None) -> str:
    """The prompt form of a starter, as the engine renders it for an origin-starter turn."""
    question = render_question(template_id, slots or {})
    # A question with no reference and no count is sent as it reads.
    return render_starter_turn(question) or question


def _header(reply: str) -> dict[str, Any]:
    header, _body = final_of(reply)
    return header


# --------------------------------------------------------------------------- #
# Starter turns (SPEC §3.8.4): the value lives only in its fence.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("template_id, slots, value", [
    ("needs_human", {"case": "demo-00000539-0004"}, "demo-00000539-0004"),
    ("noisy_rule", {"rule": "demo_noisy_scanner", "n": 30, "m": 36}, "demo_noisy_scanner"),
    ("silent_source", {"source": "demo-wazuh"}, "demo-wazuh"),
    ("hunt", {"technique": "T1078", "n": 3}, "T1078"),
])
def test_a_starter_turn_is_read_from_its_template_and_fence(template_id: str, slots: dict[str, Any],
                                                             value: str) -> None:
    turn = _starter(template_id, slots)
    assert STARTER_REF_NOTE in turn
    view = read_prompt(prompt(turn))
    assert view.starter == (template_id, slots)
    # What the planner treats as the question never holds the value.
    assert value not in view.question and "in the reference below" in view.question
    assert classify(view.question, view).starter == template_id


def test_a_starter_case_is_looked_up_by_its_fenced_id() -> None:
    turn = _starter("needs_human", {"case": "demo-00000539-0004"})
    assert tools_of(plan_turn(prompt(turn)))[0] == ("get_case", {"case_id": "demo-00000539-0004"})


def test_a_forged_note_in_a_typed_question_is_not_a_starter() -> None:
    """Only the engine's own rendering is a starter: a user typing the same words
    (origin user, so the engine never fences it) is classified like any question."""
    typed = render_question("needs_human", {"case": "demo-00000539-0004"})
    view = read_prompt(prompt(typed))
    assert view.starter is not None  # the exact card text from a console card
    edited = typed.replace("need a person", "need people")
    assert read_prompt(prompt(edited)).starter is None


def test_a_starter_count_that_moved_is_said_plainly() -> None:
    turn = _starter("hunt", {"technique": "T1078", "n": 3})

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "mitre_lookup":
            return {"techniques": [{"id": "T1078", "name": "Valid Accounts"}]}
        if tool == "case_stats" and inp.get("group_by") == ["mitre_technique"]:
            return {"window": "last 7 days", "total": 9, "groups": [
                {"key": {"mitre_technique": "T1078"}, "metrics": {"count": 5}}]}
        if tool == "case_stats":
            return {"window": "last 7 days", "total": 9, "groups": [
                {"key": {"mitre_technique": "T1078", "rule": "demo_impossible_travel"}, "metrics": {"count": 3}}]}
        if tool == "search_cases":
            return {"window": "last 7 days", "count": 3, "cases": [
                {"case_id": "demo-1", "entity": "user:pnair", "status": "investigating", "risk_score": 62}]}
        return {"total": 4, "window": "last 7 days"}

    rounds, header, body = drive(turn, obs)
    assert body.startswith("ATT&CK technique **T1078 Valid Accounts** appears in **5 cases** created in the last "
                           "7 days, from 1 rule.")
    assert "The suggestion counted 3 cases; there are 5 now." in body
    # The log hunt reads the entity a lookup of THIS turn returned (the riskiest case's).
    assert ("log_stats", {"user": "pnair", "group_by": ["host"], "time_from": "now-7d"}) in ran(rounds)
    # The title names the technique (a corpus-known id, Round 13 polish).
    assert header["title"] == "ATT&CK hunt for T1078"


def test_a_case_closed_since_the_card_is_said_to_be_closed() -> None:
    turn = _starter("needs_human", {"case": "demo-7"})

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        return {"case": {"case_id": "demo-7", "status": "closed", "verdict": "NEEDS_HUMAN", "risk_score": 60,
                         "title": "user:pnair · demo_impossible_travel #1", "entity": "user:pnair",
                         "decision_by": "analyst"}}

    _rounds, _header, body = drive(turn, obs)
    # A8: no number, so what the case is about leads and its id follows it.
    assert "(`demo-7`) was closed after this suggestion was made (decided by an analyst)" in body
    assert "no longer needs a person" in body


# --------------------------------------------------------------------------- #
# T6: the title of the first answer only.
# --------------------------------------------------------------------------- #
def _posture_round() -> list[dict[str, Any]]:
    return [call("soc_metrics", POSTURE_OBS, artifacts=POSTURE_ARTS), call("soc_metrics", TRENDS_OBS,
                                                                          artifacts=TRENDS_ARTS)]


def test_the_first_answer_has_a_title_and_later_answers_do_not() -> None:
    assert _header(plan_turn(prompt("How are we doing?", _posture_round())))["title"] == "Security posture"
    earlier = (PriorExchange(user="What did AI spend this week?", answer="**AI spend this week: $0.10**."),)
    assert "title" not in _header(plan_turn(prompt("How are we doing?", _posture_round(), history=earlier)))


def test_a_case_chat_answer_has_no_title() -> None:
    reply = plan_turn(prompt("Why was this closed?", [call("get_case", {"case": {
        "case_id": "demo-1", "status": "closed", "verdict": "FALSE_POSITIVE", "risk_score": 10}}),
        call("explain_decision", {"decision": "auto_close"})], case_scoped=True))
    assert "title" not in _header(reply)


# --------------------------------------------------------------------------- #
# T4: chips about this answer.
# --------------------------------------------------------------------------- #
def test_chips_name_what_the_answer_shows() -> None:
    chips = _header(plan_turn(prompt("How are we doing?", _posture_round())))["follow_ups"]
    assert chips and all("last 24h" in c or "Active Risk Index" in c for c in chips), chips


def test_investigate_the_top_value_rereads_the_ranking_first() -> None:
    """"Investigate the top host in this answer": the earlier ranking runs again THIS
    turn, and only then is its top value used (never a value read from the history)."""
    view = demo_chat.PromptView(question="Investigate the top host in this answer", granted=("log_stats",),
                                prior_calls=[demo_chat.PriorCall("m1", "log_stats",
                                                                 (("group_by", "host"), ("time_from", "now-24h")))])
    ask = classify(view.question, view)
    assert ask.intent == "top_entity" and ask.field == "host"
    calls = demo_chat._plan_top_entity(view, ask, 0)
    assert [(c.tool, c.input) for c in calls] == [("log_stats", {"group_by": ["host"], "time_from": "now-24h"})]


@pytest.mark.parametrize("question, keys", [
    ("Show the same without the source IP filter", ("ip",)),
    ("Show the same without the text filter", ("text", "contains")),
    ("Show the same for open and closed cases", ("status_group",)),
    ("Show the same for any severity", ("severity", "severity_gte")),
    ("Show the same across all sources", ("source_id",)),
    ("Show the same without the verdict filter", ("verdict",)),
])
def test_a_zero_result_label_maps_back_to_its_keys(question: str, keys: tuple[str, ...]) -> None:
    assert demo_chat._drop_keys(question.lower()) == keys


def test_a_zero_result_rerun_drops_the_source_ip_filter() -> None:
    view = demo_chat.PromptView(
        question="Show the same without the source IP filter", granted=("search_logs",),
        prior_calls=[demo_chat.PriorCall("m1", "search_logs", (("ip", "203.0.113.9"), ("time_from", "now-24h")))])
    ask = classify(view.question, view)
    assert ask.intent == "rerun"
    (only,) = demo_chat._plan_rerun(view, ask, 0)
    assert only.tool == "search_logs" and "ip" not in only.input and only.input["time_from"] == "now-24h"


def test_a_range_window_survives_a_rerun() -> None:
    prior = demo_chat.PriorCall("m1", "case_stats", (("bucket", "week"), ("group_by", "severity"),
                                                    ("window", '{"from":"2026-08-01","to":"2026-09-30"}')))
    view = demo_chat.PromptView(question="Break this down by rule instead", granted=("case_stats",),
                                prior_calls=[prior])
    ask = classify(view.question, view)
    assert ask.intent == "regroup_cases"
    (only,) = demo_chat._plan_regroup_cases(view, ask, 0)
    assert only.input == {"window": {"from": "2026-08-01", "to": "2026-09-30"}, "group_by": ["rule"], "top_n": 10}


# --------------------------------------------------------------------------- #
# A8: case numbers before internal ids.
# --------------------------------------------------------------------------- #
def test_a_case_with_a_number_is_named_by_its_number() -> None:
    line = demo_chat._case_line({"case_id": "case-5f1c", "case_number": "CASE-0042", "title": "x",
                                 "status": "escalated"})
    assert line.startswith("`CASE-0042`") and "case-5f1c" not in line
    # Without a number, what the case is about leads and the internal id follows it.
    assert demo_chat._case_line({"case_id": "demo-1", "title": "x"}).startswith("`x` · `demo-1`")
    assert demo_chat._case_line({"case_id": "demo-2", "title": "user:pnair · identity_signin"}).startswith(
        "`identity_signin` on user `pnair` · `demo-2`")


# --------------------------------------------------------------------------- #
# T36: Demo seed strings without em dashes.
# --------------------------------------------------------------------------- #
def test_demo_source_names_and_case_titles_have_no_em_dash() -> None:
    names = list(demo_generator.DEMO_SOURCE_NAMES.values())
    names += [getattr(spec, "display_name", "") for spec in vars(demo_sources).values()
              if hasattr(spec, "display_name") and isinstance(getattr(spec, "display_name"), str)]
    assert names and all("—" not in n for n in names), names
    org = demo_generator.build_org(1337)
    now = int(time.time() * 1000)
    cases = demo_generator.generate_historical_cases(1337, org, history_days=30, run_id="r", now_millis=now)
    cases += demo_generator.generate_recent_preseed(1337, org, run_id="r", now_millis=now)[0]
    hitl, tuner = demo_generator.generate_capability_seed_cases(1337, org, run_id="r", now_millis=now)
    cases += hitl + tuner
    assert cases and all("—" not in (c.title or "") for c in cases), [c.title for c in cases if "—" in
                                                                           (c.title or "")]


def test_a_machine_title_reads_the_same_with_either_separator() -> None:
    dash = demo_chat._case_name({"title": "ip:203.0.113.9 — demo_sqli_webshell, web_shell"})
    dot = demo_chat._case_name({"title": "ip:203.0.113.9 · demo_sqli_webshell, web_shell"})
    assert dash == dot and "203.0.113.9" in dot and "·" not in dot


# --------------------------------------------------------------------------- #
# T37: report next steps from the report's own figures.
# --------------------------------------------------------------------------- #
def test_a_volume_and_false_positives_report_counts_every_case_and_steps_from_its_figures() -> None:
    question = "Create a report on case volume and false positives for the last 7 days"
    calls = tools_of(plan_turn(prompt(question)))
    # The verdict split is the share (its counts); the rate is per RULE, never per
    # verdict (a false-positive rate per verdict is 0% or 100%).
    assert calls == [("case_stats", {"group_by": ["verdict"], "window": "now-7d"}),
                     ("case_stats", {"group_by": ["rule"], "metrics": ["count", "fp_rate"], "top_n": 10,
                                     "window": "now-7d"}),
                     ("case_stats", {"bucket": "day", "window": "now-7d"})]
    by_verdict = {"window": "last 7 days (since 11 Oct 2026)", "total": 42, "group_by": ["verdict"],
                  "metrics": ["count"], "totals": {"count": 42}, "groups": [
                      {"key": {"verdict": "True positive"}, "bucket": None, "metrics": {"count": 4}},
                      {"key": {"verdict": "False positive"}, "bucket": None, "metrics": {"count": 33}},
                      {"key": {"verdict": "Needs human"}, "bucket": None, "metrics": {"count": 5}}]}
    by_day = {"window": "last 7 days (since 11 Oct 2026)", "total": 42, "group_by": [], "bucket": "day",
              "buckets": [{"label": "16 Oct 2026"}, {"label": "17 Oct 2026"}],
              "groups": [{"key": {}, "bucket": "16 Oct 2026", "metrics": {"count": 6}},
                         {"key": {}, "bucket": "17 Oct 2026", "metrics": {"count": 36}}]}
    by_rule = {"window": "last 7 days (since 11 Oct 2026)", "total": 42, "group_by": ["rule"],
               "metrics": ["count", "fp_rate"], "totals": {"count": 42, "fp_rate": 78.57}, "groups": [
                   {"key": {"rule": "web_scanner"}, "bucket": None, "metrics": {"count": 30, "fp_rate": 96.7}}]}
    reply = plan_turn(prompt(question, [
        call("case_stats", by_verdict, inp=dict(calls[0][1]), artifacts=[
            art("a2", "categories", {"labels": ["True positive", "False positive", "Needs human"],
                                     "values": [4, 33, 5], "unit": "count"}, "Cases by verdict")]),
        call("case_stats", by_rule, inp=dict(calls[1][1]), artifacts=[
            art("a3", "table", {"columns": [{"key": "rule", "label": "Rule"}, {"key": "count", "label": "Cases"},
                                            {"key": "fp_rate", "label": "False-positive rate"}],
                                "rows": [["web_scanner", 30, 96.7]]}, "Cases by rule")]),
        call("case_stats", by_day, inp=dict(calls[2][1]), artifacts=[
            art("a2", "series", {"x": ["16 Oct 2026", "17 Oct 2026"], "series": [{"key": "count", "label": "Cases",
                                                                               "values": [6, 36]}],
                                 "unit": "count"}, "Cases by day")]),
    ]))
    header, body = final_of(reply)
    assert body.startswith("**42 cases** in the last 7 days (since 11 Oct 2026), 33 of them false positives (78.6%).")
    (envelope,) = header["blocks"]
    assert envelope["title"].startswith("Case volume and false positives report")
    steps = next(i["text"] for s in envelope["sections"] if s["heading"] == "Next steps" for i in s["items"]
                 if i.get("type") == "markdown")
    assert steps.splitlines() == [
        "1. Decide the 5 cases still waiting for a person (Needs human).",
        "2. Review the rules behind the 33 false positives (78.6% of 42 cases) for tuning.",
        "3. Confirm containment for the 4 true positives.",
        "4. Check what drove 17 Oct 2026, the busiest day with 36 cases.",
    ]
    assert header["title"] == "Case volume and false positives report"


def test_report_summary_steps_come_from_the_digest() -> None:
    digest = {"report": {"template": "custom", "items": 1}, "items": [{"title": "Cases by rule", "blocks": [
        {"categories": [{"label": "web scanner", "value": 30}], "title": "Cases by rule", "unit": "count"},
        {"series": [{"series": "Cases", "trend": "up", "last": 36}], "title": "Cases per day", "unit": "count"},
    ]}]}
    from app.agents.prompts import fence_block

    messages = [{"role": "system", "content": "summary"},
                {"role": "user", "content": "Report template: custom.\n" + fence_block(digest, source="report")}]
    payload = json.loads(demo_chat.summarise_report(messages))
    assert payload["next_steps"][:2] == ["Look into why Cases by rule is led by web scanner (30).",
                                         "Find out why Cases is trending up (last 36)."]
    assert not any(s.startswith(("Verify the figures", "Regenerate this summary")) for s in payload["next_steps"])


# --------------------------------------------------------------------------- #
# T15 on the planner's own finals.
# --------------------------------------------------------------------------- #
def test_the_shift_brief_lead_names_two_figures() -> None:
    shift_obs = {"window": "last 24h", "headline": {"open": 5, "escalated": 2, "needs_human": 1,
                                                    "unassigned": 3, "sla_breached": 1},
                 "attention": [{"case_id": "case-0042", "case_number": "CASE-0042", "title": "x",
                                "status": "escalated"}],
                 "sla": {"breached": [{"case_id": "case-0042", "case_number": "CASE-0042"}]}}
    shift_arts = [art("a1", "kpis", {"items": []}, "Shift headline"),
                  art("a2", "case_list", {"items": []}, "Needs attention")]
    msgs = prompt("/shift-brief", [call("shift_report", shift_obs, artifacts=shift_arts),
                                   call("soc_metrics", POSTURE_OBS, artifacts=POSTURE_ARTS),
                                   call("list_campaigns", {"total": 0, "campaigns": []},
                                        artifacts=[art("a1", "table", {"columns": [], "rows": []}, "Campaigns")])])
    header, body = final_of(plan_turn(msgs))
    lead = body.split("\n\n")[0]
    assert lead == "**Shift brief, last 24h.** **5 open cases**, 1 of them past SLA."
    # A8: the case to start with by its number; the next step names it the same way.
    assert body.split("\n\n")[1].startswith("Start with `CASE-0042`")
    steps = header["blocks"][0]["sections"][-1]["items"][0]["text"]
    assert steps.startswith("1. Work the 1 case past SLA first: `CASE-0042` (`x`).")


def test_parse_reply_accepts_every_starter_final() -> None:
    """Every final the planner writes for a starter is a valid protocol reply."""
    for template_id, slots in (("posture", {}), ("triage", {}), ("approvals_one", {}), ("platform", {})):
        _rounds, header, _body = drive(_starter(template_id, slots))
        assert header["answer_kind"] == "data", template_id
        assert parse_reply(json.dumps(header) + "\n---ANSWER---\nok").kind == "final"


# --------------------------------------------------------------------------- #
# Round 13 review fixes (WP-DEMO13 fixer): one regression test per finding.
# --------------------------------------------------------------------------- #
def _plan_of(question: str, **kw: Any) -> tuple[Any, list[tuple[str, dict[str, Any]]]]:
    view = read_prompt(prompt(question, **kw))
    ask = classify(view.question, view)
    return ask, [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)]


@pytest.mark.parametrize("question", [
    "How many cases breached SLA last month?", "Show SLA breaches by severity over the last 30 days",
    "Did any case breach its SLA yesterday?", "Which cases were overdue on their SLA in September?",
])
def test_an_sla_question_that_names_a_period_is_not_the_current_snapshot(question: str) -> None:
    ask, _calls = _plan_of(question)
    assert ask.intent != "sla", (question, ask.intent)


def test_the_sla_chip_and_a_case_chat_sla_question() -> None:
    ask, calls = _plan_of("Which SLA breached cases are oldest?")
    assert ask.intent == "sla" and calls == [("shift_report", {"attention_limit": 25})]
    ask, calls = _plan_of("Is this case past its SLA?", case_scoped=True)
    # The chat's own case (no id: the engine reads the scoped case) against the targets.
    assert ask.intent == "sla_case" and calls == [("get_case", {}), ("shift_report", {"attention_limit": 25})]


@pytest.mark.parametrize("decided_by, words", [
    ("system", "decided by deterministic routing"), ("agent", "decided by the AI agent, under the auto-close policy"),
])
def test_the_closed_since_answer_names_the_real_decider(decided_by: str, words: str) -> None:
    turn = _starter("needs_human", {"case": "demo-7"})
    case = {"case_id": "demo-7", "status": "closed", "verdict": "NEEDS_HUMAN", "risk_score": 60,
            "title": "user:pnair · identity_signin", "entity": "user:pnair", "decision_by": decided_by}
    _rounds, _header, body = drive(turn, lambda tool, inp: {"case": case})
    assert words in body
    if decided_by == "system":
        assert "auto-close policy" not in body.split("\n\n")[0]


def _volume_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
    if inp == {"window": "now-24h", "compare": "previous_period"}:
        return {"window": "last 24 hours", "total": 36, "totals": {"count": 36}, "group_by": [],
                "comparison": {"rows": [{"label": "Cases", "values": [5, 36]}]}}
    if inp.get("group_by") == ["rule"]:
        # Four cases carry two rules each: the per-rule rows of the 24 hours before sum
        # to 9, while only 5 cases were created then.
        return {"window": "last 24 hours", "total": 36, "totals": {"count": 36}, "group_by": ["rule"],
                "groups": [{"key": {"rule": "rule_alpha"}, "bucket": None, "metrics": {"count": 20}},
                           {"key": {"rule": "rule_beta"}, "bucket": None, "metrics": {"count": 16}}],
                "comparison": {"rows": [{"label": "rule_alpha", "values": [5, 20]},
                                        {"label": "rule_beta", "values": [4, 16]}]}}
    if inp == {"window": "now-193h", "bucket": "hour"}:
        labels = [f"h{i}" for i in range(194)]
        counts = [0] * 194
        for day in range(7):  # the seven baseline windows hold 3, 3, 4, 4, 5, 6, 30 cases
            counts[1 + 24 * day] = (3, 3, 4, 4, 5, 6, 30)[day]
        return {"window": "last 193 hours", "exact": True, "bucket": "hour",
                "buckets": [{"label": label} for label in labels],
                "groups": [{"key": {}, "bucket": label, "metrics": {"count": n}} for label, n in zip(labels, counts)]}
    return {"window": "last 7 days", "total": 60, "totals": {"count": 60}, "bucket": "day", "buckets": [],
            "groups": []}


def test_the_volume_answer_counts_the_day_before_once_per_case_and_names_the_usual_level() -> None:
    turn = _starter("volume_spike", {"n": 36, "m": 9})
    rounds, _header, body = drive(turn, _volume_obs)
    assert ("case_stats", {"window": "now-24h", "compare": "previous_period"}) in ran(rounds)
    assert body.startswith("**36 new cases** in the last 24 hours, against 5 in the 24 hours before. The usual "
                           "daily level is 4, the median of the seven days before.")
    assert "The suggestion said a usual 9; it is 4 now." in body


def test_a_drop_answer_names_the_rules_that_fell() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if inp.get("group_by") == ["rule"]:
            return {"window": "last 24 hours", "total": 3, "totals": {"count": 3}, "group_by": ["rule"],
                    "groups": [{"key": {"rule": "rule_alpha"}, "bucket": None, "metrics": {"count": 3}}],
                    "comparison": {"rows": [{"label": "rule_alpha", "values": [12, 3]}]}}
        return _volume_obs(tool, inp)

    _rounds, _header, body = drive(_starter("volume_drop", {"n": 3, "m": 12}), obs)
    assert "Why: these rules created fewer cases than in the 24 hours before: `rule_alpha` 12 to 3." in body


def _cost_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
    return {"window": "today", "today_cost_usd": 0.6768, "simulated": True,
            "by_surface": [{"key": "chat", "cost": 0.674}, {"key": "triage", "cost": 0.0028}],
            "budget": {"enabled": True, "daily": {"spent": 0.0028, "cap": 10.0, "fraction": 0.00028}}}


def test_the_ai_budget_answer_reads_the_budget_that_excludes_chat() -> None:
    _rounds, _header, body = drive(_starter("budget_ai", {"pct": 85}), _cost_obs)
    assert body.startswith("**$0.0028 of today's $10.00 AI budget is spent (0%) (simulated).** Chat is not counted")
    assert "The suggestion said 85% spent; it is 0% now." in body
    assert "`chat`" not in body and "percents" not in body


def test_the_chat_limit_answer_reads_chat_spend_only() -> None:
    _rounds, _header, body = drive(_starter("budget_chat", {"pct": 90}), _cost_obs)
    assert body.startswith("**Chat answers have used $0.6740 today (simulated).**")
    assert "$0.6768" not in body


def test_posture_names_the_two_figures_asked_in_their_order() -> None:
    focus = demo_chat._posture_focus("what's our false-positive rate and automation rate and escalation rate?")
    assert focus == ["fp", "automation"]
    lines = demo_chat._say_posture(demo_chat.Result(ordinal=1, tool="soc_metrics", status="ok", summary="",
                                                    observation=POSTURE_OBS, input={"kind": "posture"}),
                                   focus=focus)
    assert lines[0].startswith("False-positive rate **79.1%**") and lines[1].startswith("Automation rate **90%**")


def test_an_earlier_starters_value_never_reaches_the_question_words() -> None:
    # The console sent the server-worded question; the replay renders its fenced form.
    first = render_question("noisy_rule", {"rule": "demo_noisy_scanner", "n": 30, "m": 36})
    earlier = (PriorExchange(user=first, answer="**30 cases** came from the rule.", origin="starter"),)
    view = read_prompt(prompt("Show the same for the last 7 days", history=earlier))
    assert view.prior_questions and "demo_noisy_scanner" not in view.prior_questions[0]
    assert view.prior_starters == [("noisy_rule", {"rule": "demo_noisy_scanner", "n": 30, "m": 36})]
    origin = demo_chat._rerun_origin(view, classify(view.question, view))
    assert origin is not None and origin.starter == "noisy_rule"


def test_the_clock_time_chip_windows_keep_the_time_of_day() -> None:
    ask, calls = _plan_of("Which of the cases since 17 Oct 2026 12:23 are critical?")
    assert calls == [("search_cases", {"limit": 10, "severity": "critical", "window": {"from": "2026-10-17T12:23"}})]
    ask, calls = _plan_of("Show the cases since 14:10 today by rule")
    # A clock time today is dated by the clock anchor (today's one-day bucket) first.
    assert calls == [("case_stats", {"window": "today", "bucket": "day"})]
    clock = call("case_stats", {"window": "today", "buckets": [{"label": "17 Oct 2026"}], "groups": []},
                 inp={"window": "today", "bucket": "day"})
    view = read_prompt(prompt("Show the cases since 14:10 today by rule", [clock]))
    ask = classify(view.question, view)
    assert [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)] == [
        ("case_stats", {"group_by": ["rule"], "top_n": 10, "window": {"from": "2026-10-17T14:10"}})]


def _prior(key: str, tool: str, args: tuple[tuple[str, str], ...]) -> demo_chat.PriorCall:
    return demo_chat.PriorCall(key=key, tool=tool, args=args)


@pytest.mark.parametrize("chip, tool, expect", [
    ("Who closed the cases in the last 24 hours?", "case_stats", {"group_by": ["closed_by"]}),
    ("Which open cases need human review?", "search_cases", {"status_group": "active", "verdict": "NEEDS_HUMAN"}),
    ("Show the case status changes today", "audit_search", {"action_type": "status"}),
    ("Show the failed sign-ins by user in the last 24 hours", "log_stats", {"group_by": ["user"]}),
    ("How many cases came from Splunk Enterprise Security (HEC)?", "case_stats", {"group_by": ["source"]}),
])
def test_a_planner_chip_is_planned_with_the_filter_it_names(chip: str, tool: str, expect: dict[str, Any]) -> None:
    _ask, calls = _plan_of(chip)
    match = [inp for name, inp in calls if name == tool]
    assert match and all(match[0].get(k) == v for k, v in expect.items()), calls


def test_no_chip_promises_a_filter_chat_cannot_apply() -> None:
    texts = [text for rows in demo_chat._CHIPS.values() for text, _tools in rows]
    for gone in ("auto-cleared by AI", "closed by a human", "routed to a human", "Why did the auto-close rate change",
                 "match these events", "involve this entity", "Who changed the most", "used the most tokens",
                 "Which cases came from", "need a person now", "the new cases by severity"):
        assert not [t for t in texts if gone in t], gone


def test_the_rebucket_chip_keeps_the_window_and_the_filters() -> None:
    prior = _prior("m1", "case_stats", (("group_by", "verdict"), ("severity", "critical"), ("window", "now-7d")))
    view = demo_chat.PromptView(question="Show these cases in the last 7 days by day", granted=("case_stats",),
                                prior_calls=[prior])
    ask = classify(view.question, view)
    assert ask.intent == "regroup_cases"
    assert [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)] == [
        ("case_stats", {"severity": "critical", "window": "now-7d", "bucket": "day"})]


def test_a_data_answer_never_offers_the_static_chips() -> None:
    final = demo_chat.Final(body=["x"], follow_ups=["Hunt the source IP behind the newest SQL injection case"],
                            answer_kind="data")
    view = read_prompt(prompt("Investigate case demo-1"))
    ask = classify(view.question, view)
    assert "Hunt the source IP behind the newest SQL injection case" not in demo_chat._anchored_follow_ups(
        view, ask, final)


def test_a_case_chat_share_entity_chip_lists_the_cases_on_its_entity() -> None:
    # A Case Manager chat replays no lookup digest, so the chip is planned without one.
    ask, calls = _plan_of("Which other cases share an entity with demo-00000539-0020?", case_scoped=True)
    assert ask.intent == "case_related" and calls == [("get_case", {"case_id": "demo-00000539-0020"})]
    ask, _calls = _plan_of("Which other cases share entities with this one?", case_scoped=True)
    assert ask.intent == "case_related" and ask.case_id is None


def test_case_chat_chips_name_only_the_chats_own_case() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "get_case":
            return {"case": {"case_id": "case-501dd", "status": "escalated", "entity": "user:pnair",
                             "title": "user:pnair · identity_signin"}}
        if tool == "search_cases":
            return {"count": 2, "by_status": {"open": 1, "escalated": 1},
                    "cases": [{"case_id": "case-e709", "status": "open", "risk_score": 90},
                              {"case_id": "case-501dd", "status": "escalated"}]}
        return {"total": 0, "window": "last 24 hours"}

    _rounds, header, body = drive(render_question("case_entity", {}), obs, case_scoped=True)
    assert all("case-e709" not in chip for chip in header.get("follow_ups") or []), header.get("follow_ups")
    assert "The main entity of this case is user `pnair`." in body
    assert "No other case involves it." not in body and "**1 other case** involves it, open." in body


def test_which_cases_show_a_technique_lists_the_cases_of_its_top_rules() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "mitre_lookup":
            return {"techniques": [{"id": "T1078", "name": "Valid Accounts"}]}
        if tool == "case_stats" and inp.get("group_by") == ["mitre_technique"]:
            return {"window": "all time", "groups": [{"key": {"mitre_technique": "T1078"}, "metrics": {"count": 14}}]}
        if tool == "case_stats":
            return {"window": "all time", "groups": [
                {"key": {"mitre_technique": "T1078", "rule": r}, "metrics": {"count": n}}
                for r, n in (("identity_signin", 5), ("impossible_travel", 4), ("vpn_login", 3), ("mfa_fatigue", 2))]}
        if tool != "search_cases":
            return {}
        rule = inp["rule"]
        return {"count": 1, "cases": [{"case_id": f"demo-{rule}", "status": "open", "risk_score": len(rule)}]}

    rounds: list[list[dict[str, Any]]] = []
    while True:
        reply = plan_turn(prompt("Which cases show T1078?", *rounds))
        if parse_reply(reply).kind == "final":
            header, body = final_of(reply)
            break
        rounds.append([call(t, obs(t, i), inp=i, artifacts=[art("a1", "case_list", {"items": []})]
                            if t == "search_cases" else None) for t, i in tools_of(reply)])
    assert [i["rule"] for t, i in ran(rounds) if t == "search_cases"] == [
        "identity_signin", "impossible_travel", "vpn_login"]
    assert "**14 cases**" in body and "from 4 rules" in body
    assert "By rule: `identity_signin` 5, `impossible_travel` 4, `vpn_login` 3 and `mfa_fatigue` 2." in body
    # The list says which part of the count it is, and the blocks hold every case it
    # lists (one per rule searched, in the order of the "By rule" line).
    assert "The 3 highest-risk cases from its top 3 rules, which hold 12 of the 14:" in body
    titles = [b.get("title") for b in header["blocks"] if b.get("view") == "case_list"]
    assert titles == ["Cases with T1078 from its top rule", "Cases with T1078 from its second rule",
                      "Cases with T1078 from its third rule"], header["blocks"]


def test_entity_case_counts_are_one_sentence() -> None:
    result = demo_chat.Result(ordinal=1, tool="search_cases", status="ok", summary="", input={"entity": "x"},
                              observation={"count": 5, "by_status": {"escalated": 5}, "cases": []})
    assert demo_chat._say_entity_cases(result, "IP `192.0.2.90`") == \
        "**5 cases** involve IP `192.0.2.90`, all escalated."
    own = demo_chat.Result(ordinal=1, tool="search_cases", status="ok", summary="", input={"entity": "x"},
                           observation={"count": 1, "by_status": {"closed": 1},
                                        "cases": [{"case_id": "demo-1", "status": "closed"}]})
    assert demo_chat._say_entity_cases(own, "it", exclude="demo-1") == "No other case involves it."


def test_a_handoff_note_chip_is_the_investigation_brief_without_a_report_pointer() -> None:
    ask, _calls = _plan_of("Summarise demo-00000539-0004 for a handoff note")
    assert ask.intent == "brief" and not ask.save
    case = {"case_id": "demo-1", "status": "escalated", "title": "user:pnair · identity_signin",
            "entity": "user:pnair"}
    _rounds, _header, body = drive(render_question("case_handoff", {}), lambda t, i: {"case": case},
                                   case_scoped=True)
    assert "Case conversations cannot be added to Reports" not in body


def test_the_shift_handoff_card_is_framed_as_a_handoff() -> None:
    shift = {"window": "last 24 hours", "headline": {"open": 5}, "attention": [], "sla": {"breached": []}}
    _rounds, header, body = drive(_starter("shift_handoff"), lambda t, i: shift if t == "shift_report" else {})
    assert body.startswith("**Handoff for the next shift, last 24 hours.**")
    (envelope,) = header["blocks"]
    assert envelope["title"] == "Shift handoff" and envelope["subtitle"].startswith("Handoff")


def test_the_sla_answer_shows_the_most_overdue_case_not_the_attention_queue() -> None:
    shift = {"window": "last 24 hours", "sla": {"enabled": True, "totals": {"breached": 2},
                                                "breached": [{"case_id": "demo-9", "overdue_minutes": 300},
                                                             {"case_id": "demo-8", "overdue_minutes": 60}]},
             "attention": [{"case_id": "demo-1"}], "workload": []}

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "get_case":
            return {"case": {"case_id": inp["case_id"], "status": "open"}}
        return shift

    rounds, header, body = drive(_starter("sla_breached", {"n": 2}), obs)
    assert ("get_case", {"case_id": "demo-9"}) in ran(rounds)
    assert not [b for b in header["blocks"] if b.get("view") == "case_list"], header["blocks"]
    assert "The most overdue case is shown below." in body


def test_a_merged_ranking_count_is_not_stated_as_exact() -> None:
    prior = _prior("m1", "log_stats", (("group_by", "host"), ("time_from", "now-24h")))
    view = demo_chat.PromptView(question="Which cases involve the top host in the last 24 hours?",
                                granted=("log_stats", "search_logs", "search_cases"), prior_calls=[prior])
    ask = classify(view.question, view)
    ranking = demo_chat.Result(ordinal=1, tool="log_stats", status="ok", summary="", input={"group_by": ["host"]},
                               observation={"window": "last 24 hours", "top_values_are_lower_bounds": True,
                                            "top": {"host": [{"value": "dc01", "count": 64}]}})
    logs = demo_chat.Result(ordinal=1, tool="search_logs", status="ok", summary="", input={"host": "dc01"},
                            observation={"total": 140, "window": "last 24 hours"})
    view.rounds = [[ranking], [logs]]
    final = demo_chat._final_top_entity(view, ask)
    assert final is not None and "with 64 events" not in final.body[0] and "`dc01`" in final.body[0]


def test_the_my_cases_answer_lists_the_signed_in_analysts_own_cases() -> None:
    # Round 13 polish: search_cases takes assignee "me" (the signed-in analyst).
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "search_cases":
            return {"count": 2, "assignee_me": "the signed-in analyst's own cases",
                    "filters": {"status_group": "active", "assignee": "Admin"},
                    "cases": [{"case_id": "demo-1", "case_number": "CASE-000041", "assignee": "Admin",
                               "risk_score": 90, "title": "user:dsingh · identity_signin"},
                              {"case_id": "demo-2", "case_number": "CASE-000042", "assignee": "Admin",
                               "risk_score": 40, "title": "host:ws-12 · edr_alert"}]}
        raise AssertionError(f"unexpected lookup {tool}")

    rounds, _header, body = drive(_starter("my_cases", {"n": 2}), obs)
    assert ("search_cases", {"status_group": "active", "assignee": "me", "sort_field": "risk_score",
                             "limit": 10}) in ran(rounds)
    assert body.startswith("**2 open cases** are assigned to you.")
    assert "Start with **`CASE-000041`**" in body and "cannot filter" not in body
    assert "The suggestion counted" not in body  # the card's count stands


def test_the_my_cases_answer_says_so_when_nobody_is_signed_in() -> None:
    # Auth off: "me" names no one, so the lookup matches no case; the answer says why and
    # shows the open queue by assignee instead, never as the analyst's own cases.
    from app.agents.chat_tools.cases import ASSIGNEE_ME_NOBODY

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "search_cases":
            return {"count": 0, "assignee_me": ASSIGNEE_ME_NOBODY, "cases": []}
        assert tool == "case_stats" and inp.get("group_by") == ["assignee"], (tool, inp)
        return {"totals": {"count": 25}, "groups": [{"key": {"assignee": "Admin"}, "metrics": {"count": 2}}]}

    rounds, _header, body = drive(_starter("my_cases", {"n": 2}), obs)
    assert [tool for tool, _inp in ran(rounds)] == ["search_cases", "case_stats"]
    assert body.startswith("No analyst is signed in (sign-in is off), so chat cannot tell which open cases are "
                           "yours.")
    assert "The open queue (**25 cases**) by assignee: `Admin` 2." in body


def test_a_demo_help_answer_leads_with_the_help_center_and_hides_deployment_figures() -> None:
    view = read_prompt(prompt(render_question("demo", {})))
    assert view.starter == ("demo", {})
    assert demo_chat._ORIENTATION_STARTERS >= {"demo", "learn_app"}


def test_titles_name_the_classified_starter_and_the_case_rule() -> None:
    view = read_prompt(prompt(render_question("weekly", {})))
    ask = classify(view.question, view)
    assert demo_chat._conversation_title(view, ask, demo_chat.Final(body=[])) == "Last week compared"
    view = read_prompt(prompt("Investigate case demo-1"))
    got = demo_chat.Result(ordinal=1, tool="get_case", status="ok", summary="", input={"case_id": "demo-1"},
                           observation={"case": {"case_id": "demo-1", "case_number": "CASE-000041",
                                                 "title": "user:pnair · identity_signin",
                                                 "rules": ["identity_signin"]}})
    view.rounds = [[got]]
    ask = classify(view.question, view)
    # Round 13 polish: the case's display number first, then its first detection rule
    # id as written (its rule ids, never its title).
    assert demo_chat._conversation_title(view, ask, demo_chat.Final(body=[])) == "CASE-000041 identity_signin case"
    # The title is case text and never names the conversation; the rule ids do.
    got.observation["case"] = {"case_id": "demo-1", "title": "ip · demo_noisy_scanner #1",
                               "rules": ["demo_noisy_scanner"]}
    assert demo_chat._conversation_title(view, ask, demo_chat.Final(body=[])) == "Rule demo_noisy_scanner case"
    got.observation["case"] = {"case_id": "demo-1", "title": "user:pnair · identity_signin"}
    assert demo_chat._conversation_title(view, ask, demo_chat.Final(body=[])) == "Case investigation"


def test_the_decision_reason_does_not_restate_the_policy_bars() -> None:
    # T15: the decision inputs block shows the policy's bars; the prose names the
    # case's own confidence and risk and says which side of each bar they are on.
    policy = [{"verdict": "FALSE_POSITIVE", "auto_close_enabled": True, "min_confidence": 0.85,
               "max_risk_score": 30}]

    def said(confidence: float, risk: int) -> str:
        return demo_chat._say_decision(demo_chat.Result(
            ordinal=1, tool="explain_decision", status="ok", summary="", input={"case_id": "demo-1"},
            observation={"what_if": {"verdict": "FALSE_POSITIVE", "confidence": confidence, "risk_score": risk,
                                     "status": "closed"}, "policy": policy}))

    met = said(0.86, 16)
    assert "86%" in met and "risk 16" in met, met
    assert "85" not in met and "30" not in met, met
    assert "meets the policy's false-positive bar for both confidence and risk" in met
    missed = said(0.6, 70)
    assert "60" in missed and "70" in missed and "85" not in missed and "30" not in missed, missed
    assert "its confidence is below the policy's minimum and its risk is above the policy's ceiling" in missed


def test_a_zero_case_search_on_an_entity_never_suggests_dropping_the_entity() -> None:
    result = demo_chat.Result(ordinal=1, tool="search_cases", status="ok", summary="", input={"entity": "dc01"},
                              observation={"count": 0, "window": "last 24 hours", "filters": {"entity": "dc01"},
                                           "suggestions": [{"label": "Without the entity filter"},
                                                           {"label": "All time"}]})
    text = demo_chat._say_entity_cases(result, "host `dc01`")
    assert "entity filter" not in text and "look over all time" in text, text
    # Elsewhere the entity filter is still a way to widen a zero search.
    assert "drop the entity filter" in demo_chat._say_search_cases(result)


def test_what_else_an_entity_did_counts_its_other_cases_without_the_case_asked_about() -> None:
    prior = (_prior("m1", "get_case", (("case_id", "demo-7"),)),
             _prior("m1", "search_logs", (("ip", "203.0.113.93"),)))
    view = demo_chat.PromptView(question="What else did this IP address do in the last 7 days?",
                                granted=("search_logs", "log_stats", "search_cases", "get_case"),
                                prior_calls=list(prior))
    ask = classify(view.question, view)
    assert ask.intent == "entity_more" and ask.slot("own_case") == "demo-7"
    logs = demo_chat.Result(ordinal=1, tool="search_logs", status="ok", summary="", input={"ip": "203.0.113.93"},
                            observation={"total": 4, "window": "last 7 days"})
    cases = demo_chat.Result(ordinal=1, tool="search_cases", status="ok", summary="",
                             input={"entity": "203.0.113.93"},
                             observation={"count": 1, "by_status": {"closed": 1},
                                          "cases": [{"case_id": "demo-7", "status": "closed"}]})
    view.rounds = [[logs, cases]]
    final = demo_chat._final_entity_more(view, ask)
    assert final is not None
    assert "No other case involves IP `203.0.113.93`." in final.body, final.body
    assert not any(":" in line and "**1 case**" in line for line in final.body), final.body
    assert not [b for b in final.blocks if getattr(b, "view", None) == "case_list"
                or (isinstance(b, dict) and b.get("view") == "case_list")]


def test_a_campaign_answer_counts_the_cases_on_its_entity_outside_the_campaign() -> None:
    members = ["demo-1", "demo-2"]

    def obs(extra: list[str]):
        def run(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
            if tool == "list_campaigns":
                return {"campaigns": [{"id": "campaign-1", "case_count": 2, "case_ids": members,
                                       "entities": ["ip:203.0.113.77"], "mitre": []}]}
            ids = members + extra
            return {"count": len(ids), "by_status": {"escalated": len(ids)},
                    "cases": [{"case_id": c, "status": "escalated", "title": "ip:203.0.113.77 · AUTH-ANOMALY"}
                              for c in ids]}
        return run

    rounds, _header, body = drive(_starter("campaign", {"n": 2, "case": "demo-2"}), obs([]))
    # The card names the campaign by one of its cases, never by its id (Round 13 polish
    # PB3, PB4): the campaign that holds that case is looked up.
    assert rounds[0][0]["tool"] == "list_campaigns" and rounds[0][0]["input"] == {"case_id": "demo-2"}
    assert body.startswith("The campaign that includes `demo-2` links **2 cases**"), body
    assert "campaign-1" not in body
    assert "No case outside the campaign involves IP `203.0.113.77`." in body, body
    assert "**2 cases** involve" not in body
    _rounds, _header, body = drive(_starter("campaign", {"n": 2, "case": "demo-2"}), obs(["demo-9"]))
    assert "**1 case** outside the campaign involves IP `203.0.113.77`." in body, body
    # Polish round PB3's wording, sent again from an older conversation: the newest open
    # campaign is looked up and named as such.
    rounds, _header, body = drive(_starter("campaign_latest", {"n": 2}), obs([]))
    assert rounds[0][0]["input"] == {"status": "open", "limit": 1}
    assert body.startswith("The most recently active open campaign links **2 cases**"), body


# --------------------------------------------------------------------------- #
# Round 13 final review (WP-DEMO13 final fixer).
# --------------------------------------------------------------------------- #
_SHIFT_OBS = {"window": "last 24 hours", "sla": {"enabled": True, "totals": {"breached": 2},
                                                 "breached": [{"case_id": "demo-9", "overdue_minutes": 300}]},
              "attention": [], "workload": []}


@pytest.mark.parametrize("question, said", [
    ("Show the SLA breaches for critical cases", "cannot filter by severity, so this counts every open case past "
                                                 "its response target, not only critical ones."),
    ("Which high severity cases are overdue on SLA?", "not only high ones"),
    ("Which of my cases are past their SLA?", "cannot tell which cases are yours"),
    ("Which unassigned cases are past their SLA?", "cannot filter by assignee"),
    ("Which escalated cases are past their response target?", "cannot filter by status"),
])
def test_an_sla_question_that_names_a_filter_says_the_snapshot_cannot_apply_it(question: str, said: str) -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        return {"case": {"case_id": inp.get("case_id"), "status": "open"}} if tool == "get_case" else _SHIFT_OBS

    rounds, _header, body = drive(question, obs)
    assert [t for t, _i in ran(rounds)][0] == "shift_report"
    assert "The shift snapshot " + said.split(", so")[0] in body or said in body, body


def test_an_sla_question_without_a_filter_has_no_unapplied_filter_note() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        return {"case": {"case_id": inp.get("case_id"), "status": "open"}} if tool == "get_case" else _SHIFT_OBS

    for question in ("Which SLA breached cases are oldest?", "Which cases are past their SLA?"):
        _rounds, _header, body = drive(question, obs)
        assert "The shift snapshot cannot" not in body, body


def _decision(what: dict[str, Any], recorded: dict[str, Any]) -> str:
    policy = [{"verdict": "FALSE_POSITIVE", "auto_close_enabled": True, "min_confidence": 0.85,
               "max_risk_score": 30}]
    return demo_chat._say_decision(demo_chat.Result(
        ordinal=1, tool="explain_decision", status="ok", summary="", input={},
        observation={"what_if": what, "policy": policy, "recorded": recorded}))


def test_a_closed_case_today_policy_would_route_otherwise_is_reconciled() -> None:
    text = _decision({"verdict": "FALSE_POSITIVE", "confidence": 0.83, "risk_score": 16, "status": "needs_human",
                      "decision_by": "system"}, {"status": "closed", "decision_by": "agent"})
    assert text.startswith("It was closed by the AI agent; under today's policy a case like it (a false-positive "
                           "verdict at 83% confidence and risk 16) would go to a human, because its confidence is "
                           "below the policy's minimum."), text
    assert "recorded by" not in text
    # An open case whose status a person set says so in words, never "recorded by agent".
    other = _decision({"verdict": "FALSE_POSITIVE", "confidence": 0.9, "risk_score": 16, "status": "closed",
                       "decision_by": "agent"}, {"status": "on_hold", "decision_by": "analyst"})
    assert other.endswith("Its current status was set by an analyst."), other


def test_the_closed_why_chip_names_the_decider_once() -> None:
    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "get_case":
            return {"case": {"case_id": "demo-3", "status": "closed", "verdict": "FALSE_POSITIVE",
                             "decision_by": "agent", "confidence": 0.83, "risk_score": 16}}
        return {"what_if": {"verdict": "FALSE_POSITIVE", "confidence": 0.83, "risk_score": 16,
                            "status": "needs_human", "decision_by": "system"},
                "policy": [{"verdict": "FALSE_POSITIVE", "auto_close_enabled": True, "min_confidence": 0.85,
                            "max_risk_score": 30}],
                "recorded": {"status": "closed", "decision_by": "agent"}}

    _rounds, _header, body = drive(render_question("case_closed_why", {}), obs, case_scoped=True)
    assert "it was closed by the AI agent; under today's policy" in body, body
    assert "Who decided" not in body and body.count("the AI agent") == 1, body


def test_every_intent_with_a_final_has_a_title_or_only_follows_an_earlier_answer() -> None:
    from app.agents.chat_protocol import parse_title

    untitled = set(demo_chat._FINALS) - set(demo_chat._INTENT_TITLES)
    assert untitled <= demo_chat._UNTITLED_INTENTS, sorted(untitled - demo_chat._UNTITLED_INTENTS)
    for title in [*demo_chat._INTENT_TITLES.values(), *demo_chat._GROUP_TITLES.values()]:
        assert parse_title({"title": title}) == title, title


@pytest.mark.parametrize("question, title", [
    ("Which cases show T1078?", "Cases with T1078"),
    ("How many cases came from Splunk Enterprise Security (HEC)?", "Cases from a log source"),
    ("Which other cases share an entity with demo-00000539-0004?", "Related cases"),
    ("Who closed the cases in the last 24 hours?", "Who closed the cases"),
])
def test_a_first_question_is_titled_in_engine_words(question: str, title: str) -> None:
    view = read_prompt(prompt(question))
    ask = classify(view.question, view)
    assert demo_chat._conversation_title(view, ask, demo_chat.Final(body=[])) == title


def test_the_rebucket_chip_under_a_clock_window_is_never_by_month() -> None:
    view = read_prompt(prompt("Show the cases since 16 Oct 2026 22:19 by rule"))
    ask = classify(view.question, view)
    obs = {"window": "since 16 Oct 2026 22:19"}
    assert demo_chat._rebucket_chip(ask, obs, view) == "Show these cases since 16 Oct 2026 22:19 by day"
    # With the clock anchor of this turn dating today, a window that began yesterday is by hour.
    clock = demo_chat.Result(ordinal=1, tool="case_stats", status="ok", summary="", input=dict(demo_chat._CLOCK_INPUT),
                             observation={"buckets": [{"label": "17 Oct 2026"}]})
    view.rounds = [[clock]]
    assert demo_chat._rebucket_chip(ask, obs, view).endswith("by hour")
    # A rolling window keeps its length rule.
    rolling = classify("Cases by rule in the last 30 days", read_prompt(prompt("Cases by rule in the last 30 days")))
    assert demo_chat._rebucket_chip(rolling, {"window": "last 30 days"}).endswith("by day")


def test_the_still_open_chip_is_offered_only_under_open_and_closed_cases() -> None:
    def view_with(obs: dict[str, Any]) -> demo_chat.PromptView:
        view = read_prompt(prompt("List the cases from the last 7 days"))
        view.rounds = [[demo_chat.Result(ordinal=1, tool="search_cases", status="ok", summary="",
                                         input={"window": "now-7d"}, observation=obs)]]
        return view

    assert demo_chat._lists_open_and_closed(view_with({"count": 41, "open": 7}))
    assert not demo_chat._lists_open_and_closed(view_with({"count": 8, "open": 8}))
    assert not demo_chat._lists_open_and_closed(view_with({"count": 52, "open": 0}))
    assert not demo_chat._lists_open_and_closed(view_with({"count": 52}))


def test_the_still_open_chip_keeps_an_open_status_and_needs_no_lookup_under_closed_cases() -> None:
    escalated = demo_chat.PromptView(question="Which of these cases are still open?",
                                     granted=("search_cases", "case_stats"),
                                     prior_calls=[_prior("m1", "search_cases", (("status", "escalated"),))])
    ask = classify(escalated.question, escalated)
    calls = [(c.tool, c.input) for c in demo_chat._next_calls(escalated, ask)]
    assert calls[0] == ("search_cases", {"status": "escalated", "sort_field": "risk_score", "limit": 10}), calls
    assert all("status_group" not in inp for _t, inp in calls), calls
    closed = demo_chat.PromptView(question="Which of these cases are still open?", granted=("search_cases",),
                                  prior_calls=[_prior("m1", "search_cases", (("status_group", "terminal"),))])
    ask = classify(closed.question, closed)
    assert demo_chat._next_calls(closed, ask) == []
    final = demo_chat._final_these_open(closed, ask)
    assert final is not None and final.body == ["None of those cases is still open: the list above holds closed "
                                                "cases only."]


@pytest.mark.parametrize("prior, kept", [
    ((("group_by", "verdict"), ("status", "escalated"), ("window", "this_month")),
     {"status": "escalated", "window": "this_month"}),
    ((("verdict", "FALSE_POSITIVE"), ("window", "now-30d"), ("limit", "10")),
     {"verdict": "FALSE_POSITIVE", "window": "now-30d"}),
])
def test_a_compare_chip_under_case_figures_keeps_their_filters(prior: tuple[tuple[str, str], ...],
                                                               kept: dict[str, Any]) -> None:
    tool = "case_stats" if dict(prior).get("group_by") else "search_cases"
    view = demo_chat.PromptView(question="Compare this with the previous month", granted=("case_stats",),
                                prior_calls=[_prior("m1", tool, prior)])
    ask = classify(view.question, view)
    assert ask.intent == "compare_cases"
    calls = [(c.tool, c.input) for c in demo_chat._next_calls(view, ask)]
    assert calls and all(t == "case_stats" and inp.get("compare") == "previous_period"
                         and all(inp.get(k) == v for k, v in kept.items()) for t, inp in calls), calls


def test_case_chat_engine_chips_are_answered_for_the_case_entity() -> None:
    for chip, slot in (("Compare this with the previous 24 hours", "compare"),
                       ("Break this down by source IP instead", "group")):
        ask, calls = _plan_of(chip, case_scoped=True)
        assert ask.intent == "case_entity" and ask.slot(slot), (chip, ask.intent)
        assert calls == [("get_case", {})], calls
    # "Show the same for …" keeps a comparison only when the answer it sits under compared.
    compared = (PriorExchange(user="Compare this with the previous 24 hours", answer="x", origin="follow_up"),)
    view = read_prompt(prompt("Show the same for the last 7 days", case_scoped=True, history=compared))
    assert classify(view.question, view).slot("compare")
    view = read_prompt(prompt("Show the same for the last 7 days", case_scoped=True))
    ask = classify(view.question, view)
    assert ask.intent == "case_entity" and not ask.slot("compare")
    ask, _calls = _plan_of("Investigate the top host in this answer", case_scoped=True)
    assert ask.intent == "top_entity" and ask.slot("case_scope")
    ask, _calls = _plan_of("Which of these cases are still open, and who has them?", case_scoped=True)
    assert ask.intent == "these_open" and ask.slot("case_scope")


@pytest.mark.parametrize("question, labels", [
    ("Compare this month vs last month: cases, FP rate, MTTR", ["Cases", "False-positive rate"]),
    ("Compare this month vs last month: MTTD and cases", ["Cases"]),
    ("Compare cases this month with last month", ["Cases", "True-positive rate"]),
    ("Compare MTTR this month vs last month", ["MTTR (median)"]),
])
def test_a_comparison_states_the_asked_figures_and_never_an_unasked_one_instead(question: str,
                                                                                labels: list[str]) -> None:
    comp = {"rows": [{"key": "count", "label": "Cases"}, {"key": "tp_rate", "label": "True-positive rate"},
                     {"key": "fp_rate", "label": "False-positive rate"}, {"key": "mttr", "label": "MTTR (median)"}]}
    view = read_prompt(prompt(question))
    ask = classify(view.question, view)
    assert [r["label"] for r in demo_chat._top_rows(comp, ask)["rows"]] == labels


def test_demo_figures_round_half_up_like_the_gauge() -> None:
    # Round 13 T1: the Demo answer's whole figures (case risk among them) round half up,
    # like the gauge, fmt_int and the cards; never Python's half-to-even.
    assert demo_chat._count(98.5) == "99"
    assert demo_chat._count(48.5) == "49"
    assert demo_chat._count(47.4) == "47"
    assert demo_chat._count(1234.5) == "1,235"
    assert demo_chat._count(None) == "0"
    assert demo_chat._plural(0.5, "case") == "1 case"
    assert demo_chat._plural(2.5, "case") == "3 cases"
