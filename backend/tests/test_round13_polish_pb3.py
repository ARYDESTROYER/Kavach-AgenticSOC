"""Round 13 polish (PB3): follow-ups, campaign cards, reasons, shift counts, rule
names and the cold Case Manager starter read.

Offline and pure where it can be (the planner is driven round by round over synthetic
lookups, exactly as the engine builds its prompts), and through the real selector and
starter engine where the defect lived.

1. A follow-up names a case only when the answer shows it: an empty answer whose
   lookups merely OBSERVED cases (the shift snapshot's attention queue behind an "Open
   cases by analyst" chart) offers no "Investigate CASE-…" chip, for every starter
   template (the planner) and in the engine's selector (``chat_followups``).
2. The campaign card names no internal id (tests in ``test_chat_starter_text``,
   ``test_chat_starters_engine``, ``test_demo_chat_round13`` and the golden set).
3. "Oldest assigned" is the recorded assignment time, else the reason says "opened".
4. Shift and SLA answers state the total once, then exactly the cases they name.
5. A rule has one display form in an answer: its id, as every block shows it.
6. The first chat request of a process builds nothing on the event loop.
"""

from __future__ import annotations

import re
import threading
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.agents import chat_starter_text as starter_text
from app.agents.chat_followups import ArtifactInfo, answer_anchors, named_cases, select_follow_ups
from app.engine import chat_starters as cs
from app.engine import demo_chat
from tests.test_chat_starters_engine import _build, _card, _case, _request, _seed
from tests.test_chat_starters_engine import as_alice  # noqa: F401 -- the signed-in caller fixture
from tests.test_demo_chat_round12 import drive
from tests.test_demo_chat_round13 import _starter

#: A case the lookups observe but no empty answer shows.
_DECOY_ID, _DECOY_NUMBER = "decoy-0005", "CASE-000005"
_CASE_REF_RE = re.compile(r"\b(?:CASE-\d+|decoy-\d+|case-\d+|demo-[\w-]+)\b")


# --------------------------------------------------------------------------- #
# 1. Follow-ups name only the cases an answer shows.
# --------------------------------------------------------------------------- #
def _empty_obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
    """An empty result for every lookup, where the lookups that can still OBSERVE a
    case do: the shift snapshot's attention queue lists the decoy, as Demo's does when
    no case is near its response target."""
    decoy = {"case_id": _DECOY_ID, "case_number": _DECOY_NUMBER, "status": "open", "assignee": "dsingh",
             "risk_score": 80, "title": "user:dsingh · identity_signin", "verdict": "NEEDS_HUMAN",
             "age_minutes": 30}
    if tool == "shift_report":
        return {"window_hours": 24, "totals": {"open": 1, "new": 0, "escalated": 0, "closed": 0},
                "attention": [decoy], "workload": [{"analyst": "dsingh", "open": 1}],
                "sla": {"enabled": True, "totals": {"open": 1, "breached": 0, "about_to_breach": 0},
                        "breached": [], "about_to_breach": []},
                "deltas": {}, "window": "last 24 hours"}
    if tool == "search_cases":
        return {"filters": {k: v for k, v in inp.items() if k not in ("limit", "sort_field", "sort_order")},
                "window": "last 7 days", "count": 0, "returned": 0, "open": 0, "exact": True, "cases": []}
    if tool == "case_stats":
        return {"total": 0, "totals": {"count": 0}, "exact": True, "window": "last 24 hours", "filters": {},
                "group_by": list(inp.get("group_by") or []), "groups": []}
    if tool == "list_campaigns":
        return {"status_filter": inp.get("status"), "total": 0, "returned": 0, "campaigns": []}
    if tool in ("log_stats", "search_logs"):
        return {"total": 0, "window": "last 7 days", "sources": {"answered": 1, "queried": 1}}
    if tool == "soc_metrics":
        return {"kind": inp.get("kind", "posture"), "window": "last 24 hours", "case_count": 0}
    if tool == "automation_status":
        return {"kind": inp.get("kind", "approvals"), "pending": [], "count": 0}
    if tool == "source_health":
        return {"sources": [], "total": 0}
    if tool == "cost_usage":
        return {"total_cost_usd": 0.0, "calls": 0, "tokens": 0, "window": "today"}
    if tool == "mitre_lookup":
        return {"techniques": []}
    return None   # get_case, explain_decision, …: not found


def _slots(template_id: str) -> dict[str, Any]:
    spec = starter_text.TEMPLATES[template_id]
    values: dict[str, Any] = {"case": "CASE-000041", "rule": "demo_noisy_scanner", "source": "demo-wazuh",
                              "campaign": "campaign-1e57287ac9b19e21", "technique": "T1110", "h": 24,
                              "since": "09:12", "month": "September 2026"}
    out: dict[str, Any] = {}
    for name in spec.slots:
        out[name] = values[name] if name in values else max(spec.minimums.get(name, 0), 5)
    return out


_SENDABLE = [t.id for t in starter_text.TEMPLATES.values() if t.sendable]


@pytest.mark.parametrize("template_id", _SENDABLE)
def test_an_empty_starter_answer_offers_no_chip_about_a_case_it_does_not_show(template_id: str) -> None:
    """Every starter template, answered over empty lookups that still observe a case:
    a follow-up names a case only when the answer's own words name it."""
    question = (starter_text.render_question(template_id, _slots(template_id))
                if starter_text.TEMPLATES[template_id].surface == "home" else
                starter_text.TEMPLATES[template_id].question)
    _rounds, header, body = drive(_starter(template_id, _slots(template_id)) if starter_text.TEMPLATES[
        template_id].surface == "home" else question, _empty_obs)
    for chip in header.get("follow_ups") or []:
        for ref in _CASE_REF_RE.findall(chip):
            assert ref in body, (template_id, chip, body[:400])
    assert _DECOY_NUMBER not in " ".join(header.get("follow_ups") or []) or _DECOY_NUMBER in body


def test_the_sla_close_answer_with_none_near_target_names_no_case() -> None:
    """The re-shoot's defect: "Which 2 cases are close to their response target…" over
    a snapshot with none near its target answered "No open case is close…" and then
    offered "Investigate CASE-000005" (the attention queue's first row)."""
    _rounds, header, body = drive(_starter("sla_close", {"n": 2}), _empty_obs)
    assert body.startswith("No open case is close to its response target right now."), body[:200]
    assert _DECOY_NUMBER not in body
    assert not any(_DECOY_NUMBER in chip or _DECOY_ID in chip for chip in header.get("follow_ups") or []), header


def _shift_chart(pairs: dict[str, str]) -> ArtifactInfo:
    """The "Open cases by analyst" chart of a shift snapshot, as the engine reads it:
    analyst labels only, with the attention queue's case pairs from the observation."""
    return ArtifactInfo(kind="categories", tool="shift_report",
                        data={"labels": ["dsingh", "pnair"], "values": [3, 2], "dimension": "analyst"},
                        case_numbers=pairs)


def _pick(chips: list[str], infos: list[ArtifactInfo], answer: str) -> list[str]:
    return select_follow_ups(chips, infos, question="Which 2 cases are close to their response target?",
                             earlier_questions=[], allowed_tools=frozenset({"get_case", "shift_report"}),
                             answer_kind="data", answer_text=answer)


def test_the_selector_drops_a_chip_about_a_case_the_answer_only_observed() -> None:
    pairs = {_DECOY_ID: _DECOY_NUMBER, "decoy-0006": "CASE-000006"}
    chart = _shift_chart(pairs)
    chips = [f"Investigate {_DECOY_NUMBER}", f"Summarise {_DECOY_NUMBER} for a handoff note",
             f"Why is {_DECOY_ID} open?"]
    assert _pick(chips, [chart], "No open case is close to its response target right now.") == []
    assert not {_DECOY_ID, _DECOY_NUMBER.casefold()} & set(answer_anchors([chart]))


def test_the_selector_keeps_a_chip_about_a_case_the_answer_names() -> None:
    """The same chip is anchored once the answer's words name the case, by number or by
    id; both forms then anchor (the number shown, the id a chip may use)."""
    chart = _shift_chart({_DECOY_ID: _DECOY_NUMBER, "decoy-0006": "CASE-000006"})
    answer = f"- **`{_DECOY_NUMBER}`** (identity signin on user `dsingh`), 10 min left."
    out = _pick([f"Investigate {_DECOY_NUMBER}", "Investigate CASE-000006", f"Why is {_DECOY_ID} open?"],
                [chart], answer)
    assert out[:2] == [f"Investigate {_DECOY_NUMBER}", f"Why is {_DECOY_ID} open?"], out
    assert "Investigate CASE-000006" not in out
    anchors = answer_anchors([chart], answer_text=answer)
    assert {_DECOY_ID, _DECOY_NUMBER.casefold()} <= set(anchors)
    assert "case-000006" not in anchors and "decoy-0006" not in anchors


def test_a_case_shown_by_a_block_or_asked_for_still_anchors() -> None:
    """A case list or case card shows its cases, and a get_case answer is about the
    case it was asked for, whatever the prose says."""
    listed = ArtifactInfo(kind="case_list", tool="search_cases",
                          data={"items": [{"case_id": "c-1", "status": "open"}]},
                          case_numbers={"c-1": "CASE-000001", "c-2": "CASE-000002"})
    anchors = set(answer_anchors([listed]))
    assert {"c-1", "case-000001"} <= anchors and not {"c-2", "case-000002"} & anchors
    figures = ArtifactInfo(kind="kpis", tool="get_case", data={"items": []}, params={"case_id": "c-7"},
                           case_numbers={"c-7": "CASE-000007", "c-8": "CASE-000008"})
    anchors = set(answer_anchors([figures]))
    assert {"c-7", "case-000007"} <= anchors and not {"c-8", "case-000008"} & anchors


def test_named_cases_reads_case_tokens_out_of_markdown() -> None:
    # The candidates are the observed pairs (PB4: matched as whole tokens, not tokenised).
    observed = ["CASE-000046", "demo-00000539-0004", "CASE-000043", "CASE-000044", "demo-00000539-000"]
    names = named_cases("Start with **`CASE-000046`** (`demo-00000539-0004`, x), then CASE-000043.", observed)
    assert names == {"case-000046", "demo-00000539-0004", "case-000043"}
    assert named_cases(None, observed) == frozenset() and named_cases("", observed) == frozenset()


# --------------------------------------------------------------------------- #
# 3. "Oldest assigned" is the assignment time, or the reason says "opened".
# --------------------------------------------------------------------------- #



def _assigned(case: Any, at: datetime, who: str = "alice", event: str = "assigned") -> Any:
    case.history.append({"ts": at.isoformat(), "event": event, "assignee": who, "analyst": "lead"})
    return case


async def test_my_cases_reason_without_an_assignment_record_says_opened(app_state, as_alice) -> None:
    """The re-shoot's defect: "Oldest assigned 8 min ago" seconds after the assignment
    (the case's age). With no assignment record the reason names what it measures."""
    now = datetime.now(UTC)
    await _seed(app_state,
                _case("m1", created=now - timedelta(minutes=30), assignee="alice", number="CASE-1"),
                _case("m2", created=now - timedelta(minutes=20), assignee="alice", number="CASE-2"))
    card = _card(await _build(app_state, now=now), "my_cases")
    assert card is not None and card.template == "my_cases"
    assert card.reason == "Oldest opened 30 min ago", card.reason


async def test_my_cases_reason_uses_the_recorded_assignment_time(app_state, as_alice) -> None:
    now = datetime.now(UTC)
    await _seed(app_state,
                _assigned(_case("m1", created=now - timedelta(minutes=30), assignee="alice", number="CASE-1"),
                          now - timedelta(minutes=10)),
                _assigned(_case("m2", created=now - timedelta(minutes=20), assignee="alice", number="CASE-2"),
                          now - timedelta(minutes=5), event="analyst_action"))
    card = _card(await _build(app_state, now=now), "my_cases")
    assert card is not None and card.reason == "Oldest assigned 10 min ago", card.reason


async def test_one_unrecorded_assignment_falls_back_to_opened(app_state, as_alice) -> None:
    """Every case needs its record (the oldest assignment is otherwise unknown); an
    assignment recorded to someone else does not count for the current owner."""
    now = datetime.now(UTC)
    await _seed(app_state,
                _assigned(_case("m1", created=now - timedelta(minutes=30), assignee="alice", number="CASE-1"),
                          now - timedelta(minutes=10)),
                _assigned(_case("m2", created=now - timedelta(minutes=20), assignee="alice", number="CASE-2"),
                          now - timedelta(minutes=5), who="bob"))
    card = _card(await _build(app_state, now=now), "my_cases")
    assert card is not None and card.reason == "Oldest opened 30 min ago", card.reason


def test_assigned_at_reads_the_latest_record_for_the_current_owner() -> None:
    now = datetime.now(UTC)
    case = _case("m1", created=now - timedelta(hours=2), assignee="Alice")
    assert cs.assigned_at(case) is None
    _assigned(case, now - timedelta(hours=1), who="bob")
    assert cs.assigned_at(case) is None                      # recorded for someone else
    _assigned(case, now - timedelta(minutes=30), who=" alice ")
    assert cs.assigned_at(case) == now - timedelta(minutes=30)
    case.history.append({"ts": now.isoformat(), "event": "analyst_action", "action": "hold"})
    assert cs.assigned_at(case) == now - timedelta(minutes=30)  # an action without an owner


async def test_the_assign_route_records_the_assignment_on_the_case_history(app_state) -> None:
    from app.api.routes import AssignBody, case_assign

    now = datetime.now(UTC)
    await _seed(app_state, _case("a1", created=now - timedelta(hours=1)))
    await case_assign("a1", AssignBody(assignee="alice", analyst="lead"), app_state, request=None)
    stored = await app_state.cases.get("a1")
    (entry,) = [e for e in stored.history if e.get("event") == "assigned"]
    assert entry["assignee"] == "alice" and entry["analyst"] == "lead" and entry["ts"] == stored.updated_at
    assert cs.assigned_at(stored) is not None


async def test_an_action_that_sets_a_new_owner_records_it(app_state) -> None:
    from app.api.routes import CaseAction, _perform_case_action

    now = datetime.now(UTC)
    await _seed(app_state, _case("a2", created=now - timedelta(hours=1), assignee="bob"))
    await _perform_case_action("a2", CaseAction(action="acknowledge", assignee="alice"), "lead", app_state)
    stored = await app_state.cases.get("a2")
    assert stored.history[-1]["event"] == "analyst_action" and stored.history[-1]["assignee"] == "alice"
    assert cs.assigned_at(stored) is not None
    # The same owner again is no new assignment: the entry carries no owner.
    await _perform_case_action("a2", CaseAction(action="hold", assignee="alice"), "lead", app_state)
    assert "assignee" not in (await app_state.cases.get("a2")).history[-1]


# --------------------------------------------------------------------------- #
# 4. Shift and SLA counts: the total once, then exactly the cases named.
# --------------------------------------------------------------------------- #


def _overdue(n: int) -> list[dict[str, Any]]:
    return [{"case_id": f"demo-{i}", "case_number": f"CASE-00000{i}", "overdue_minutes": 900 - i * 60,
             "assignee": "dsingh"} for i in range(1, n + 1)]


def _shift_obs(total: int, listed: int, described: int | None = None) -> dict[str, Any]:
    rows = _overdue(listed)
    attention = [{**r, "status": "on_hold", "verdict": "NEEDS_HUMAN", "risk_score": 60,
                  "title": "user:dsingh · identity_signin"} for r in rows[:listed if described is None else described]]
    return {"window": "last 24 hours", "headline": {"open": 25, "sla_breached": total, "escalated": 0,
                                                     "needs_human": 0, "unassigned": 0},
            "sla": {"enabled": True, "totals": {"breached": total, "about_to_breach": 0}, "breached": rows,
                    "about_to_breach": []},
            "attention": attention, "workload": []}


def _shift_result(obs: dict[str, Any]) -> Any:
    return demo_chat.Result(ordinal=1, tool="shift_report", status="ok", summary="", input={}, observation=obs)


@pytest.mark.parametrize("total, listed, step", [
    (10, 5, "Work the 10 cases past SLA first, starting with the 3 most overdue: "),
    (2, 2, "Work the 2 cases past SLA first: "),
    (1, 1, "Work the 1 case past SLA first: "),
    (4, 1, "Work the 4 cases past SLA first, starting with the most overdue: "),
    (6, 0, "Work the 6 cases past SLA first."),
])
def test_the_shift_step_states_the_total_then_exactly_the_cases_it_names(total: int, listed: int,
                                                                          step: str) -> None:
    (first, *_rest) = demo_chat._shift_steps(_shift_result(_shift_obs(total, listed)), None, None)
    assert first.startswith(step), first
    named = re.findall(r"CASE-\d+", first)
    expected = min(listed, 3)
    assert len(named) == expected, first
    words = re.search(r"the (\d+) most overdue", first)
    assert words is None or int(words.group(1)) == len(named)


def _sla_answer(obs: dict[str, Any], n: int) -> str:
    _rounds, _header, body = drive(_starter("sla_breached", {"n": n}),
                                   lambda tool, inp: obs if tool == "shift_report" else None)
    return body


def test_the_sla_answer_says_how_many_it_lists() -> None:
    body = _sla_answer(_shift_obs(10, 5), 10)
    assert body.startswith("**10 cases** are past their response target right now."), body[:200]
    assert "The 5 most overdue:" in body
    assert len(re.findall(r"^- `CASE-\d+`", body, re.MULTILINE)) == 5
    assert "What is holding them up, among these 5:" in body, body
    # All of them listed: no "most overdue" count to disagree with the total.
    body = _sla_answer(_shift_obs(3, 3), 3)
    assert "Most overdue first:" in body and len(re.findall(r"^- `CASE-\d+`", body, re.MULTILINE)) == 3


def test_the_sla_answer_says_which_of_the_listed_cases_it_describes() -> None:
    body = _sla_answer(_shift_obs(10, 5, described=3), 10)
    assert "The 5 most overdue:" in body
    assert "What is holding them up, among the 3 of these the shift snapshot describes:" in body, body
    assert "among these 3" not in body


# --------------------------------------------------------------------------- #
# 5. One display form per rule in an answer: the id, as every block shows it.
# --------------------------------------------------------------------------- #
def test_the_my_cases_answer_spells_each_rule_one_way() -> None:
    """The re-shoot's defect: "demo_impossible_travel #1" in one row and "demo impossible
    travel" in the next. Every row names the rule as its id (the case list block and
    the title show it so); a seeded title's " #1" is not part of the rule."""
    mine = {"count": 3, "assignee_me": "the signed-in analyst's own cases", "cases": [
        {"case_id": "demo-46", "case_number": "CASE-000046", "status": "investigating", "risk_score": 62,
         "title": "user:pnair · demo_impossible_travel #1", "verdict": "NEEDS_HUMAN", "severity": "high"},
        {"case_id": "demo-43", "case_number": "CASE-000043", "status": "investigating", "risk_score": 62,
         "title": "user:vpatel · demo_impossible_travel", "verdict": "NEEDS_HUMAN", "severity": "high"},
        {"case_id": "demo-45", "case_number": "CASE-000045", "status": "new", "risk_score": 20,
         "title": "ip:192.0.2.62 · web_apache_access", "verdict": "FALSE_POSITIVE", "severity": "low"}]}
    _rounds, _header, body = drive(_starter("my_cases", {"n": 3}),
                                   lambda tool, inp: mine if tool == "search_cases" else None)
    assert body.count("`demo_impossible_travel` on user") == 3, body   # the lead and both rows
    assert "demo impossible travel" not in body and "#1" not in body, body
    assert "`web_apache_access` on IP `192.0.2.62`" in body


@pytest.mark.parametrize("title, name", [
    ("user:pnair · demo_impossible_travel #2", "`demo_impossible_travel` on user `pnair`"),
    ("ip:203.0.113.9 · demo_sqli_webshell, web_shell", "`demo_sqli_webshell`, `web_shell` on IP `203.0.113.9`"),
    ("user:bob — identity_signin", "`identity_signin` on user `bob`"),
])
def test_a_machine_title_names_its_rules_by_id(title: str, name: str) -> None:
    assert demo_chat._case_name({"title": title}) == name


# --------------------------------------------------------------------------- #
# 6. The cold Case Manager chip read: no one-time build on the event loop.
# --------------------------------------------------------------------------- #



async def test_the_first_grant_resolution_builds_the_tool_catalogue_off_the_loop(app_state, monkeypatch) -> None:
    """A process's first chat request (the first Case Manager chip read, measured at
    about 0.35 s) imported every chat tool module on the event loop. It now builds the
    catalogue in a worker thread, and warms the Help Center index the same way."""
    from app import knowledge
    from app.agents.chat_tools import registry

    loop_thread = threading.get_ident()
    built_on: list[int] = []
    real = registry._discover

    def spy() -> Any:
        built_on.append(threading.get_ident())
        return real()

    warmed: list[bool] = []
    real_warm = knowledge.warm_app_knowledge

    async def warm_spy() -> bool:
        warmed.append(True)
        return await real_warm()

    monkeypatch.setattr(registry, "_CATALOGUE", None)
    monkeypatch.setattr(registry, "_discover", spy)
    monkeypatch.setattr(knowledge, "warm_app_knowledge", warm_spy)
    grants = await app_state.chat_grants(_request(app_state))
    assert grants and built_on and all(ident != loop_thread for ident in built_on)
    assert warmed
    # Built once: the next resolution reuses it.
    await app_state.chat_grants(_request(app_state))
    assert len(built_on) == 1


def test_the_app_warms_the_tool_catalogue_at_startup() -> None:
    """The lifespan builds the catalogue (and the Help Center index) before serving."""
    import inspect

    from app import main

    source = inspect.getsource(main.lifespan)
    assert "await warm_app_knowledge()" in source and "await warm_catalogue()" in source
