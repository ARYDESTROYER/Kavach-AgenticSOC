"""Round 13 polish (PB4): fixes from the adversarial review of PB3.

1. The campaign card names its campaign by one of its cases (fenced like every case
   reference, live and on replay), so the answer is about the campaign that holds that
   case now, never about whichever campaign is newest when the question is sent; an
   earlier wording (by id, or "the most recently active campaign") is still read back.
2. The campaign family picks among campaigns that are new or grew since the baseline,
   preferring a new one, and the catch-up line keeps its "N new campaigns" clause.
3. Assigning a case to its current owner keeps the recorded assignment time.
4. A case number from a custom template ("INC/2026/0042", "SOC#0042", "IR 0042") named
   in the answer anchors a chip about it.
5. A chip that names a case the answer does not show is dropped, on an answer without
   data artifacts too.
6. The shift brief gives one starting point.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.agents import chat_starter_text as starter_text
from app.agents.chat_entity import prompt_question
from app.agents.chat_followups import ArtifactInfo, named_cases, select_follow_ups
from app.agents.chat_tools.cases import ListCampaignsTool
from app.engine import chat_starters as cs
from app.engine.case_id import number_pattern
from app.es.fake import InMemoryESClient
from app.models import Campaign, CampaignEntity
from app.stores.campaigns import CampaignStore
from app.stores.cases import CaseStore
from app.stores.memory import EsKVStore
from tests.test_chat_starters_engine import _build, _card, _case, _seed, _visited
from tests.test_chat_starters_engine import as_alice, established  # noqa: F401 -- fixtures
from tests.test_chat_tools_support import make_ctx
from tests.test_demo_chat_round12 import drive
from tests.test_demo_chat_round13 import _starter


def _assigned(case, at: datetime, who: str = "alice", event: str = "assigned"):
    case.history.append({"ts": at.isoformat(), "event": event, "assignee": who, "analyst": "lead"})
    return case


# --------------------------------------------------------------------------- #
# 3. Re-assigning to the current owner keeps the assignment time.
# --------------------------------------------------------------------------- #
async def test_assigning_a_case_to_its_current_owner_keeps_the_assignment_time(app_state, as_alice) -> None:
    """Assign clicked again, or a bulk assign over cases the caller already holds,
    records no new assignment: "Oldest assigned" does not reset to now."""
    from app.api.routes import AssignBody, case_assign

    now = datetime.now(UTC)
    await _seed(app_state,
                _assigned(_case("m1", created=now - timedelta(minutes=30), assignee="alice", number="CASE-1"),
                          now - timedelta(minutes=25)),
                _assigned(_case("m2", created=now - timedelta(minutes=28), assignee="alice", number="CASE-2"),
                          now - timedelta(minutes=20)))
    before = _card(await _build(app_state, now=now), "my_cases")
    assert before is not None and before.reason == "Oldest assigned 25 min ago", before and before.reason
    for case_id, owner in (("m1", "alice"), ("m2", " Alice ")):
        await case_assign(case_id, AssignBody(assignee=owner, analyst="lead"), app_state, request=None)
    for case_id in ("m1", "m2"):
        stored = await app_state.cases.get(case_id)
        assert [e["event"] for e in stored.history].count("assigned") == 1
        assert stored.assignee == "alice"  # the stored owner is kept as written
    after = _card(await _build(app_state, now=now), "my_cases")
    assert after is not None and after.reason == "Oldest assigned 25 min ago", after and after.reason


async def test_assigning_a_case_to_someone_else_records_the_new_owner(app_state) -> None:
    from app.api.routes import AssignBody, case_assign

    now = datetime.now(UTC)
    await _seed(app_state, _assigned(_case("r1", created=now - timedelta(hours=1), assignee="alice"),
                                     now - timedelta(minutes=40)))
    await case_assign("r1", AssignBody(assignee="bob", analyst="lead"), app_state, request=None)
    stored = await app_state.cases.get("r1")
    assert [e["assignee"] for e in stored.history if e.get("event") == "assigned"] == ["alice", "bob"]
    assert cs.assigned_at(stored) is not None and cs.assigned_at(stored) > now - timedelta(minutes=1)


async def test_an_action_naming_the_current_owner_in_capitals_records_no_assignment(app_state) -> None:
    from app.api.routes import CaseAction, _perform_case_action

    now = datetime.now(UTC)
    await _seed(app_state, _case("r2", created=now - timedelta(hours=1), assignee="alice"))
    await _perform_case_action("r2", CaseAction(action="hold", assignee="ALICE"), "lead", app_state)
    stored = await app_state.cases.get("r2")
    assert "assignee" not in stored.history[-1] and stored.assignee == "alice"


# --------------------------------------------------------------------------- #
# 4 and 5. Follow-ups name a case only when the answer shows it, whatever its form.
# --------------------------------------------------------------------------- #
_TOOLS = frozenset({"get_case", "shift_report", "search_cases", "case_stats"})


def _pick(chips, infos, answer, *, kind="data", pattern=None):
    return select_follow_ups(chips, infos, question="Which cases need attention?", earlier_questions=[],
                             allowed_tools=_TOOLS, answer_kind=kind, answer_text=answer,
                             case_number_pattern=pattern)


def _shift_chart(pairs):
    return ArtifactInfo(kind="categories", tool="shift_report",
                        data={"labels": ["dsingh"], "values": [3], "dimension": "analyst"}, case_numbers=pairs)


@pytest.mark.parametrize("number", ["INC/2026/0042", "SOC#0042", "IR 0042", "CASE-000042"])
def test_a_custom_case_number_the_answer_names_anchors_its_chip(number: str) -> None:
    """Numbers from any valid template ("INC/{year}/{seq:04d}", "SOC#{seq}", "IR {seq}")
    are read as whole references in the answer's words, not as fixed-pattern tokens."""
    chart = _shift_chart({"case-0042": number})
    named = f"Start with **`{number}`** (identity signin on user `dsingh`), escalated, risk 64."
    assert _pick([f"Investigate {number}"], [chart], named) == [f"Investigate {number}"]
    assert _pick([f"Investigate {number}"], [chart], "No case is close to its response target.") == []


def test_named_cases_match_whole_references_only() -> None:
    candidates = ["INC/2026/0042", "SOC#0042", "IR 0042", "CASE-000042", "0042"]
    text = "See INC/2026/00421, xSOC#0042, IR 0042. and CASE-000042-b, not 0042x."
    assert named_cases(text, candidates) == {"ir 0042"}
    assert named_cases("Start with `INC/2026/0042`.", candidates) == {"inc/2026/0042"}


@pytest.mark.parametrize("kind, answer", [
    ("product_help", "Open the case in Case Manager and choose Assign to me."),
    ("conversation", "You are welcome."),
])
def test_an_unchecked_answer_drops_a_chip_about_a_case_it_does_not_name(kind: str, answer: str) -> None:
    chips = ["Investigate CASE-000005", "How do I escalate a case?", "Why is case-0123456789abcdef0123456789abcdef open?"]
    assert _pick(chips, [], answer, kind=kind) == ["How do I escalate a case?"]
    # The configured template's numbers are case-shaped too.
    pattern = number_pattern("INC/{year}/{seq:04d}")
    assert _pick(["Investigate INC/2026/0005", "How do I escalate a case?"], [], answer, kind=kind,
                 pattern=pattern) == ["How do I escalate a case?"]


def test_an_unchecked_answer_keeps_a_chip_about_a_case_it_names() -> None:
    chips = ["Investigate CASE-000005", "How do I escalate a case?"]
    assert _pick(chips, [], "Open **CASE-000005** in Case Manager.", kind="product_help") == chips


def test_a_data_chip_anchored_elsewhere_still_may_not_name_an_unshown_case() -> None:
    """Anchored by the analyst it names, the chip also names a case the answer only
    observed: dropped. The same chip about the case the answer names stays."""
    chart = _shift_chart({"case-0005": "CASE-000005", "case-0006": "CASE-000006"})
    answer = "dsingh holds 3 open cases; start with CASE-000006."
    out = _pick(["Compare CASE-000005 with dsingh's other cases", "Compare CASE-000006 with dsingh's other cases"],
                [chart], answer)
    assert out[0] == "Compare CASE-000006 with dsingh's other cases", out
    assert all("CASE-000005" not in chip for chip in out), out


@pytest.mark.parametrize("template, prefix, number, other", [
    ("CASE-{seq:06d}", "CASE", "case-000042", "case-x42"),
    ("INC/{year}/{seq:04d}", "CASE", "INC/2026/0042", "INC/26/0042"),
    ("SOC#{seq}", "CASE", "soc#42", "soc#"),
    ("IR  {seq}", "CASE", "IR 0042", "IR0042"),
    ("{prefix}{sep}{yy}{mm}-{seq}", "Sec", "SEC-2610-7", "SEC-261-7"),
])
def test_number_pattern_matches_the_numbers_a_template_renders(template, prefix, number, other) -> None:
    pattern = number_pattern(template, prefix=prefix)
    assert pattern is not None
    assert re.fullmatch(pattern, number, re.IGNORECASE) and not re.fullmatch(pattern, other, re.IGNORECASE)


def test_number_pattern_refuses_a_template_without_digits_or_an_invalid_one() -> None:
    assert number_pattern("{prefix}-{source}") is None
    assert number_pattern("{nope}") is None


def test_the_engine_passes_the_configured_numbering_pattern() -> None:
    from app.agents.chat import _case_number_pattern
    from app.config import Preferences

    prefs = Preferences()
    prefs.case_id_format.template = "INC/{year}/{seq:04d}"
    assert _case_number_pattern(prefs) == number_pattern("INC/{year}/{seq:04d}")
    assert _case_number_pattern(object()) is None


# --------------------------------------------------------------------------- #
# 1 and 2. The campaign card names a campaign by one of its cases.
# --------------------------------------------------------------------------- #
async def test_a_new_campaign_behind_a_newer_but_unchanged_one_gets_the_card_and_clause(
        app_state, as_alice, established) -> None:
    """rev-b's repro: an older campaign whose last activity is newest (no new member)
    lists first; the campaign first seen after the baseline still gets the card, named
    by its newest case, and the catch-up line still says "1 new campaign"."""
    now = datetime.now(UTC)
    old_first, recent, new_first = (now - timedelta(days=3)).isoformat(), (now - timedelta(minutes=5)).isoformat(), \
        (now - timedelta(minutes=20)).isoformat()
    await _seed(app_state, *[_case(c, created=now - timedelta(days=3), number=f"CASE-0000{i}")
                             for i, c in enumerate(("o1", "o2"), start=1)])
    await _seed(app_state, *[_case(c, created=now - timedelta(minutes=m), number=f"CASE-0001{i}")
                             for i, (c, m) in enumerate((("n1", 20), ("n2", 15), ("n3", 12)), start=1)])
    await app_state.campaign_store.upsert_many([
        Campaign(id="camp-old", case_ids=["o1", "o2"], first_seen=old_first, last_seen=recent, created_at=old_first),
        Campaign(id="camp-new", case_ids=["n1", "n2", "n3"], first_seen=new_first, last_seen=new_first,
                 created_at=new_first),
    ])
    info = await _build(app_state, now=now, user_state=_visited(now, gap=timedelta(hours=1)))
    card = _card(info, "campaign")
    assert card is not None and card.prompt == "What links the 3 cases in the campaign that includes CASE-00013?"
    assert card.key == cs.starter_key("campaign", cs.ChatStarterRef(kind="campaign", value="camp-new"))
    assert info.catch_up is not None and "1 new campaign" in [c.text for c in info.catch_up.clauses]


async def test_a_campaign_that_grew_is_named_by_a_case_that_joined_it(app_state, as_alice, established) -> None:
    now = datetime.now(UTC)
    first = (now - timedelta(days=2)).isoformat()
    await _seed(app_state, _case("g1", created=now - timedelta(days=2), number="CASE-00021"),
                _case("g2", created=now - timedelta(days=2), number="CASE-00022"),
                _case("g3", created=now - timedelta(minutes=10), number="CASE-00023"))
    await app_state.campaign_store.upsert_many([Campaign(
        id="camp-grown", case_ids=["g1", "g2", "g3"], first_seen=first,
        last_seen=(now - timedelta(minutes=10)).isoformat(), created_at=first)])
    info = await _build(app_state, now=now, user_state=_visited(now, gap=timedelta(hours=1)))
    card = _card(info, "campaign")
    assert card is not None and card.prompt == "What links the 3 cases in the campaign that includes CASE-00023?"
    assert card.reason.startswith("1 more case since ")
    assert info.catch_up is None or all("campaign" not in c.text for c in info.catch_up.clauses)


async def test_a_campaign_whose_cases_cannot_be_named_gets_no_card(app_state, as_alice, established) -> None:
    """No member case in the store: no reference to name it by, so no card (the clause
    alone has no question to send, so the line leaves it out)."""
    now = datetime.now(UTC)
    first = (now - timedelta(minutes=20)).isoformat()
    await app_state.campaign_store.upsert_many([Campaign(id="camp-x", case_ids=["gone-1", "gone-2"],
                                                         first_seen=first, last_seen=first, created_at=first)])
    info = await _build(app_state, now=now, user_state=_visited(now, gap=timedelta(hours=1)))
    assert _card(info, "campaign") is None


def _camp_obs(held: list[dict[str, Any]], *, found: bool = True, newest: dict[str, Any] | None = None):
    def run(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "list_campaigns" and inp.get("case_id"):
            return {"case_filter": {"found": found, "case_id": "demo-2" if found else None,
                                    "case_number": "CASE-000002" if found else None},
                    "total": len(held), "returned": len(held), "campaigns": held}
        if tool == "list_campaigns":
            rows = [newest] if newest else []
            return {"status_filter": inp.get("status"), "total": len(rows), "returned": len(rows), "campaigns": rows}
        return {"count": 0, "cases": []}
    return run


_PNAIR = {"id": "campaign-1e57", "status": "open", "case_count": 3, "case_ids": ["demo-1", "demo-2", "demo-3"],
          "entities": ["user:pnair"], "mitre": []}
_NEWER = {"id": "campaign-4039", "status": "open", "case_count": 5, "case_ids": ["demo-7", "demo-8"],
          "entities": ["ip:192.0.2.90"], "mitre": []}


def test_the_answer_is_about_the_campaign_its_case_names_not_the_newest_one() -> None:
    """rev-b's live failure: the card counted pnair's campaign; a newer campaign
    appeared before the question was sent. The answer looks up the campaign that holds
    the card's case and says plainly that it grew, never counting another campaign."""
    question = _starter("campaign", {"n": 2, "case": "CASE-000002"})
    rounds, _header, body = drive(question, _camp_obs([_PNAIR], newest=_NEWER))
    assert [c["input"] for c in rounds[0]] == [{"case_id": "CASE-000002"}]
    assert body.startswith("The campaign that includes `CASE-000002` links **3 cases** through user `pnair`"), body
    assert "The suggestion counted 2 cases; there are 3 now." in body, body
    assert "192.0.2.90" not in body and "campaign-1e57" not in body and "campaign-4039" not in body


@pytest.mark.parametrize("found, lead", [
    (True, "No campaign holds `CASE-000002` now"),
    (False, "Case `CASE-000002` was not found"),
])
def test_the_answer_says_plainly_when_the_campaign_is_gone(found: bool, lead: str) -> None:
    rounds, _header, body = drive(_starter("campaign", {"n": 2, "case": "CASE-000002"}),
                                  _camp_obs([], found=found, newest=_NEWER))
    assert body.startswith(lead), body
    assert "The suggestion counted" not in body and "links **5 cases**" not in body, body


def test_the_legacy_latest_wording_never_calls_a_different_count_growth() -> None:
    rounds, _header, body = drive(_starter("campaign_latest", {"n": 2}), _camp_obs([], newest=_NEWER))
    assert rounds[0][0]["input"] == {"status": "open", "limit": 1}
    assert body.startswith("The most recently active open campaign links **5 cases**"), body
    assert "there are 5 now" not in body
    assert "a newer campaign may have taken its place since" in body, body


@pytest.mark.parametrize("question", [
    "What links the 5 cases in campaign-4039d3c5ab857211899383250c57b5dc?",
    "What links the 5 cases in the campaign that includes CASE-000046?",
])
def test_a_campaign_starter_turn_is_fenced_live_and_on_replay(question: str) -> None:
    """The live turn and every replay call ``prompt_question``: the old id-bearing
    wording (finding 8) and the current one render with their fence and both notes."""
    rendered = prompt_question(question, "starter")
    assert rendered is not None and "source=entity_ref" in rendered
    assert rendered.endswith(starter_text.STARTER_COUNTS_NOTE) and starter_text.STARTER_REF_NOTE in rendered
    assert rendered.split("\n")[0].endswith("in the reference below?")
    assert prompt_question(question, "user") is None


async def test_list_campaigns_finds_the_campaigns_that_hold_a_case() -> None:
    es = InMemoryESClient()
    cases = CaseStore(es)
    now = datetime.now(UTC)
    for cid, number in (("case-1", "CASE-000001"), ("case-2", "CASE-000002"), ("case-9", "CASE-000009")):
        await cases.save(_case(cid, created=now - timedelta(hours=1), number=number))
    camps = CampaignStore(EsKVStore(es))
    await camps.upsert(Campaign(id="campaign-a", case_ids=["case-1", "case-2"],
                                entities=[CampaignEntity(entity_type="user", value="pnair")],
                                last_seen=(now - timedelta(hours=2)).isoformat()))
    await camps.upsert(Campaign(id="campaign-b", case_ids=["case-7", "case-8"],
                                last_seen=now.isoformat()))
    ctx = make_ctx(campaigns=camps, cases=cases)
    for ref in ("CASE-000002", "case-2"):
        out = await ListCampaignsTool().run(ctx, case_id=ref)
        assert out.ok and [c["id"] for c in out.observation["campaigns"]] == ["campaign-a"], out.observation
        assert out.observation["case_filter"] == {"found": True, "case_id": "case-2", "case_number": "CASE-000002"}
        assert out.untrusted_params == {"case_id": ref}
    alone = await ListCampaignsTool().run(ctx, case_id="CASE-000009")
    assert alone.ok and alone.observation["total"] == 0 and alone.observation["case_filter"]["found"] is True
    missing = await ListCampaignsTool().run(ctx, case_id="CASE-999999")
    assert missing.ok and missing.observation["total"] == 0 and missing.observation["case_filter"]["found"] is False


# --------------------------------------------------------------------------- #
# 6. The shift brief has one starting point.
# --------------------------------------------------------------------------- #
def _shift_run(breached: list[str], attention: list[str], total: int):
    def row(n: str, **kw: Any) -> dict[str, Any]:
        return {"case_id": f"demo-{n}", "case_number": f"CASE-{n}", "title": "user:dsingh · identity_signin", **kw}

    obs = {"window": "last 24 hours",
           "headline": {"open": 25, "sla_breached": total, "escalated": 0, "needs_human": 0, "unassigned": 0},
           "sla": {"enabled": True, "totals": {"breached": total, "about_to_breach": 0},
                   "breached": [row(n, overdue_minutes=900 - i) for i, n in enumerate(breached)],
                   "about_to_breach": []},
           "attention": [row(n, status="escalated", risk_score=64) for n in attention], "workload": []}

    def run(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
        if tool == "shift_report":
            return obs
        if tool == "list_campaigns":
            return {"total": 0, "returned": 0, "campaigns": []}
        return None
    return run


def _section_text(blocks: list[dict[str, Any]], heading: str) -> str:
    """The Markdown text of the report section named ``heading``."""
    for block in blocks:
        for section in block.get("sections") or []:
            if section.get("heading") == heading:
                return "\n".join(str(i.get("text") or "") for i in section.get("items") or []
                                 if i.get("type") == "markdown")
    return ""


def _lead_and_steps(run):
    """``(answer, Next steps text)`` of the shift brief and the handoff."""
    for template_id in ("shift_start", "shift_handoff"):
        question = _starter(template_id, {"h": 24} if template_id == "shift_start" else {})
        _rounds, header, body = drive(question, run)
        yield body, _section_text(header["blocks"], "Next steps")


def test_the_shift_lead_starts_where_the_steps_start() -> None:
    """rev-b: the lead said "Start with CASE-000005" (top of the attention queue) while
    step 1 said to start with the 3 most overdue, CASE-000004 first."""
    run = _shift_run(["000004", "000005", "000014"], ["000005", "000004"], total=10)
    for body, steps in _lead_and_steps(run):
        assert "Start with `CASE-000004`" in body and "the most overdue of the 10 cases past SLA" in body, body
        assert steps.startswith("1. Work the 10 cases past SLA first, starting with the 3 most overdue: `CASE-000004`")
        assert "CASE-000005`" not in body.split("\n\n")[1], body


def test_with_no_named_overdue_case_the_lead_does_not_say_start() -> None:
    run = _shift_run([], ["000005"], total=6)
    for body, steps in _lead_and_steps(run):
        assert "Top of the attention queue: `CASE-000005`" in body and "Start with" not in body, body
        assert steps.startswith("1. Work the 6 cases past SLA first."), steps


def test_with_nothing_past_sla_the_lead_starts_with_the_attention_queue() -> None:
    run = _shift_run([], ["000005"], total=0)
    for body, steps in _lead_and_steps(run):
        assert "Start with `CASE-000005`" in body and "past SLA first" not in steps, (body, steps)


def test_a_bare_number_template_never_drops_a_chip_about_a_count() -> None:
    """With "{seq}" numbering a case number is a bare number, which a chip's words use
    for counts too: such a chip is never taken to name a case."""
    chart = _shift_chart({"case-0005": "5", "case-0030": "30"})
    chips = ["Show the top 5 rules in the last 30 days"]
    assert _pick(chips, [], "Open the case in Case Manager.", kind="product_help",
                 pattern=number_pattern("{seq}")) == chips
    assert _pick(["Compare dsingh with the top 5 analysts"], [chart], "dsingh holds 3 open cases.",
                 pattern=number_pattern("{seq}")) == ["Compare dsingh with the top 5 analysts"]
