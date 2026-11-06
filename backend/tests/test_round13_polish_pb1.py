"""Round 13 polish, package PB1 (SPEC-chat §10 "As built"):

1. ``search_cases`` / ``case_stats`` take assignee ``me``: the signed-in analyst,
   resolved on the server; with nobody signed in it matches no case and says so.
2. ``shift_report`` lists the open cases close to their response target (bounded,
   nearest first, with who has each) and agrees with the ``sla_close`` card's count.
3. The shift-start card gets the §3.5 personal factor when it started after the
   catch-up baseline.
4. Every seeded Demo case carries a case number from the product's own nomenclature
   and sequence; the live Demo pipeline continues it; a reset gives the same numbers;
   case lists and related cases carry the number.
5. Case titles the pipeline writes separate entity and rules with " · ".
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from app.agents import prompts
from app.agents.blocks import validate_blocks
from app.agents.chat_tools.cases import (
    ASSIGNEE_ME_NOBODY,
    GetCaseTool,
    SearchCasesTool,
    ShiftReportTool,
)
from app.agents.chat_tools.common import case_list_item
from app.agents.chat_tools.stats import CaseStatsTool
from app.agents.pipeline import CASE_TITLE_SEPARATOR, machine_case_title
from app.agents import chat_starter_text as text
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import chat_starters as cs
from app.engine import demo_chat
from app.engine.case_id import SequenceStore, allocate_case_number
from app.engine.chat_starters import StarterUserState, build_starters
from app.es.fake import InMemoryESClient
from app.models import Case, Cluster, Entity
from app.stores.cases import CaseStore
from app.stores.memory import EsKVStore

from tests.test_chat_tools_support import (
    assert_artifacts_render,
    assert_observation_whitelisted,
    build_demo_state,
    make_ctx,
)
from tests.test_demo_chat_round12 import drive, ran
from tests.test_demo_chat_round13 import _starter

UTC = timezone.utc


def _case(cid: str, *, age: timedelta, status: CaseStatus = CaseStatus.OPEN, assignee: str = "",
          risk: float = 50.0, number: str = "", verdict: Verdict | None = Verdict.NEEDS_HUMAN,
          related: list[str] | None = None, title: str = "") -> Case:
    created = (datetime.now(UTC) - age).isoformat()
    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.7"), status=status, verdict=verdict,
        risk_score=risk, created_at=created, updated_at=created, assignee=assignee, case_number=number,
        related_case_ids=related or [], title=title or f"ip:203.0.113.7{CASE_TITLE_SEPARATOR}rule_{cid}",
    )


async def _store(*cases: Case) -> CaseStore:
    store = CaseStore(InMemoryESClient())
    for case in cases:
        await store.save(case)
    return store


def _request(state: Any) -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    return Request({"type": "http", "method": "GET", "path": "/api/chat/starters", "headers": [],
                    "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})


# --------------------------------------------------------------------------- #
# 1. Assignee "me"
# --------------------------------------------------------------------------- #
@pytest.fixture
async def assigned() -> CaseStore:
    return await _store(
        _case("c-1", age=timedelta(hours=1), assignee="Alice", risk=90),
        _case("c-2", age=timedelta(hours=2), assignee=" alice ", risk=20),
        _case("c-3", age=timedelta(hours=3), assignee="bob", risk=70),
        _case("c-4", age=timedelta(hours=4), risk=60),
        _case("c-5", age=timedelta(hours=5), assignee="alice", status=CaseStatus.CLOSED,
              verdict=Verdict.FALSE_POSITIVE),
    )


async def test_assignee_me_is_the_signed_in_analyst(assigned: CaseStore) -> None:
    ctx = make_ctx(cases=assigned, caller="alice")
    out = await SearchCasesTool().run(ctx, status_group="active", assignee="Me", sort_field="risk_score")
    assert out.ok and out.observation["count"] == 2 and out.observation["exact"] is True
    # Matched like every assignee (trimmed, case-insensitive), highest risk first.
    assert [c["case_id"] for c in out.observation["cases"]] == ["c-1", "c-2"]
    assert out.observation["filters"]["assignee"] == "alice"
    assert out.observation["assignee_me"] == "the signed-in analyst's own cases"
    assert_observation_whitelisted(out)
    assert_artifacts_render(out)
    # Every status counts too: the closed one joins without the open filter.
    every = await SearchCasesTool().run(ctx, assignee="me")
    assert every.observation["count"] == 3
    # An explicit other username still works, as before (rows show assignees anyway).
    bob = await SearchCasesTool().run(ctx, assignee="bob")
    assert bob.observation["count"] == 1 and "assignee_me" not in bob.observation


async def test_assignee_me_with_nobody_signed_in_matches_no_case_and_says_so(assigned: CaseStore) -> None:
    # Auth off: the context carries no caller (the default), so "me" names no one.
    ctx = make_ctx(cases=assigned)
    assert ctx.caller == ""
    out = await SearchCasesTool().run(ctx, status_group="active", assignee="me")
    assert out.ok and out.observation["count"] == 0 and out.observation["cases"] == []
    assert out.observation["assignee_me"] == ASSIGNEE_ME_NOBODY
    assert out.summary.startswith(ASSIGNEE_ME_NOBODY) and out.coverage == ASSIGNEE_ME_NOBODY
    assert out.observation["exact"] is True
    assert_artifacts_render(out)
    # A user literally named "me" is never matched by accident.
    named_me = await _store(_case("m-1", age=timedelta(hours=1), assignee="me"))
    nobody = await SearchCasesTool().run(make_ctx(cases=named_me), assignee="me")
    assert nobody.observation["count"] == 0


async def test_case_stats_resolves_me_the_same_way(assigned: CaseStore) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=assigned, caller="ALICE"), status_group="active",
                                    assignee="me")
    assert out.ok and out.observation["totals"]["count"] == 2, out.observation
    refused = await CaseStatsTool().run(make_ctx(cases=assigned), assignee="me")
    assert not refused.ok and refused.error == ASSIGNEE_ME_NOBODY


async def test_the_tool_context_carries_the_signed_in_username(app_state, monkeypatch) -> None:
    ctx = await app_state.build_chat_tool_context(_request(app_state), None)
    assert ctx.caller == "" and ctx.user == "default"  # auth off
    from app.api import deps

    monkeypatch.setattr(deps, "current_username", lambda request: "alice")
    ctx = await app_state.build_chat_tool_context(_request(app_state), None)
    assert ctx.caller == "alice" and ctx.user == "alice"


def test_the_model_is_told_how_to_ask_for_my_cases() -> None:
    from app.agents.chat_tools.base import render_tool_signatures
    from app.agents.chat_tools.registry import catalogue

    rendered = prompts.render_chat_agent_system(render_tool_signatures(catalogue()))
    assert 'never "open cases". "My cases": assignee "me".' in rendered
    assert "assignee? (me = signed-in analyst)" in SearchCasesTool.signature
    # case_stats takes "the search_cases filters", so "me" too; the all-time default is
    # stated once, in the prompt's windows section.
    assert "and the search_cases filters" in CaseStatsTool.signature
    assert "case_stats and search_cases cover all time" in rendered
    assert len(rendered) < 16_500


# --------------------------------------------------------------------------- #
# 2. Cases close to their response target
# --------------------------------------------------------------------------- #
async def _near_target(state: Any) -> None:
    """Seven open cases 91 to 110 minutes old (the default target of a case without
    a priority is 120 minutes, and three quarters of it is "close"), one past it."""
    ages = (91, 95, 98, 101, 104, 107, 110)
    for i, minutes in enumerate(ages):
        await state.cases.save(_case(f"n-{i}", age=timedelta(minutes=minutes),
                                     assignee=("dana" if i % 2 else ""), number=f"CASE-{100 + i}"))


async def test_shift_report_lists_the_nearest_close_cases_with_who_has_them(app_state) -> None:
    await _near_target(app_state)
    ctx = await app_state.build_chat_tool_context(_request(app_state), None)
    out = await ShiftReportTool().run(ctx, attention_limit=25)
    assert out.ok
    sla = out.observation["sla"]
    assert sla["totals"]["about_to_breach"] == 7 and sla["totals"]["breached"] == 0
    rows = sla["about_to_breach"]
    # Bounded like the overdue list, nearest to the target first.
    assert [r["case_id"] for r in rows] == ["n-6", "n-5", "n-4", "n-3", "n-2"]
    lefts = [r["minutes_left"] for r in rows]
    assert lefts == sorted(lefts) and all(0 < left <= 30 for left in lefts)
    assert [r["assignee"] for r in rows] == [None, "dana", None, "dana", None]
    assert rows[0]["case_number"] == "CASE-106" and rows[0]["target_minutes"] == 120
    assert_observation_whitelisted(out)
    assert_artifacts_render(out)


async def test_the_sla_close_card_and_the_tool_agree_on_the_count(app_state, monkeypatch) -> None:
    monkeypatch.setattr(cs, "_caller", lambda request: ("alice", "analyst_tier1", True))
    await _near_target(app_state)
    now = datetime.now(UTC)
    info = await build_starters(app_state, _request(app_state), surface="home", now=now,
                                user_state=StarterUserState())
    card = next(s for s in info.starters if s.id == "sla")
    assert card.template == "sla_close"
    parsed = text.parse_starter_question(card.prompt)
    assert parsed is not None
    ctx = await app_state.build_chat_tool_context(_request(app_state), None)
    out = await ShiftReportTool().run(ctx, attention_limit=25)
    assert parsed[1]["n"] == out.observation["sla"]["totals"]["about_to_breach"] == 7


def test_the_demo_sla_close_answer_names_the_nearest_cases_and_their_owners() -> None:
    shift = {"window": "last 24 hours", "workload": [],
             "attention": [{"case_id": "demo-1", "title": "user:dsingh · identity_signin"}],
             "sla": {"enabled": True, "totals": {"breached": 0, "about_to_breach": 7}, "breached": [],
                     "about_to_breach": [
                         {"case_id": "demo-1", "case_number": "CASE-000041", "minutes_left": 10,
                          "target_minutes": 120, "assignee": "dana"},
                         {"case_id": "demo-2", "case_number": "CASE-000042", "minutes_left": 25,
                          "target_minutes": 120, "assignee": None}]}}
    _rounds, _header, body = drive(_starter("sla_close", {"n": 7}), lambda t, i: shift)
    assert body.startswith("**7 cases** are close to their response target (most of the response time used).")
    assert "- `CASE-000041` · `identity_signin` on user `dsingh`, assigned to `dana`, 10 min left" in body
    assert "- `CASE-000042`, not assigned, 25 min left" in body
    assert "The shift snapshot names the 2 nearest; the other 5 are counted above." in body
    assert "without naming" not in body


def test_the_demo_sla_close_one_answer_says_how_long_is_left() -> None:
    shift = {"window": "last 24 hours", "workload": [], "attention": [],
             "sla": {"enabled": True, "totals": {"breached": 0, "about_to_breach": 1}, "breached": [],
                     "about_to_breach": [{"case_id": "demo-1", "minutes_left": 12, "target_minutes": 120,
                                          "assignee": "dana"}]}}

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "get_case":
            return {"case": {"case_id": "demo-1", "case_number": "CASE-000041", "status": "open",
                             "assignee": "dana"}}
        return shift

    _rounds, _header, body = drive(_starter("sla_close_one", {"case": "CASE-000041"}), obs)
    assert "It is close to its response target, with 12 min left." in body


# --------------------------------------------------------------------------- #
# 3. The shift card's personal factor
# --------------------------------------------------------------------------- #
async def _shift_candidate(state: Any, monkeypatch, user_state: StarterUserState, now: datetime):
    seen: list[cs.StarterCandidate] = []
    real = cs.rank

    def spy(candidates, **kw):
        candidates = list(candidates)
        seen.extend(candidates)
        return real(candidates, **kw)

    monkeypatch.setattr(cs, "rank", spy)
    await build_starters(state, _request(state), surface="home", now=now, user_state=user_state)
    return next(c for c in seen if c.family == "shift")


async def test_a_shift_that_starts_after_the_baseline_scores_the_personal_factor(app_state, monkeypatch) -> None:
    monkeypatch.setattr(cs, "_caller", lambda request: ("alice", "analyst_tier1", True))
    await app_state.cases.save(_case("old", age=timedelta(days=60), status=CaseStatus.CLOSED))
    now = datetime.now(UTC)
    # Last seen 9 hours ago: this visit starts a shift, after the baseline.
    last = now - timedelta(hours=9)
    state = StarterUserState(last_seen_at=last, visit_started_at=last - timedelta(minutes=5),
                             catchup_since=last - timedelta(days=1), shift_started_at=last - timedelta(hours=1))
    start = await _shift_candidate(app_state, monkeypatch, state, now)
    assert start.starter.template == "shift_start" and start.newer_than_baseline
    assert cs.score(start, user_state=state, now=now) == 180.0  # 80 x 1.5 urgency x 1.5 personal
    # A handoff 8 hours into a shift whose baseline (the last visit) came after it
    # started is not newer than the baseline.
    started = now - timedelta(hours=8)
    handoff_state = StarterUserState(last_seen_at=now - timedelta(minutes=5), visit_started_at=started,
                                     catchup_since=now - timedelta(hours=1), shift_started_at=started)
    handoff = await _shift_candidate(app_state, monkeypatch, handoff_state, now)
    assert handoff.starter.template == "shift_handoff" and not handoff.newer_than_baseline


async def test_the_first_demo_visit_serves_the_shift_card() -> None:
    state = await build_demo_state()
    try:
        info = await build_starters(state, _request(state), surface="home", now=datetime.now(UTC),
                                    user_state=StarterUserState())
        assert "shift" in [s.id for s in info.starters], [s.id for s in info.starters]
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# 4. Case numbers for seeded Demo cases
# --------------------------------------------------------------------------- #
async def _all_cases(state: Any) -> list[Case]:
    cases, _total = await state.cases.list(limit=1000)
    return list(cases)


def _created(case: Case) -> datetime:
    parsed = datetime.fromisoformat(str(case.created_at).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


async def test_every_seeded_demo_case_is_numbered_in_creation_order_and_a_reset_repeats_it() -> None:
    state = await build_demo_state()
    try:
        cases = await _all_cases(state)
        assert cases and all(re.fullmatch(r"CASE-\d{6}", c.case_number) for c in cases), \
            [c.case_number for c in cases]
        ordered = sorted(cases, key=lambda c: (_created(c), c.case_id))
        assert [c.case_number for c in ordered] == [f"CASE-{i:06d}" for i in range(1, len(cases) + 1)]
        first = {c.case_id: c.case_number for c in cases}
        await state.reset_demo()
        again = {c.case_id: c.case_number for c in await _all_cases(state)}
        assert again == first
    finally:
        await state.shutdown()


async def test_the_live_demo_pipeline_continues_the_sequence_without_collisions() -> None:
    from app.engine.demo_runtime import DemoSimulator

    state = await build_demo_state()
    try:
        seeded = {c.case_id: c.case_number for c in await _all_cases(state)}
        simulator = DemoSimulator(state._demo, state.get_prefs, seed=1337)
        result = await simulator.trigger_incident("phishing_chain")
        assert result["triggered"] is True
        fresh = [c for c in await _all_cases(state) if c.case_id not in seeded]
        assert fresh
        numbers = [int(c.case_number.split("-")[1]) for c in fresh]
        assert all(n > len(seeded) for n in numbers) and len(set(numbers)) == len(numbers)
        assert not set(c.case_number for c in fresh) & set(seeded.values())
        # Live titles separate entity and rules with " · " (no em dash on screen).
        assert all(CASE_TITLE_SEPARATOR in c.title and "—" not in c.title for c in fresh), \
            [c.title for c in fresh]
    finally:
        await state.shutdown()


async def test_demo_numbers_follow_the_operators_own_template() -> None:
    from app.config import Secrets
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    try:
        fmt = state.prefs.case_id_format.model_copy(update={"template": "SOC-{seq:04d}", "seq_start": 500})
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True, "case_id_format": fmt}))
        assert state.prefs.case_id_format.enabled is False  # the operator's switch is untouched
        await state.enable_demo(mode="seeded", seed=1337, history_days=1)
        numbers = sorted(int(c.case_number.split("-")[1]) for c in await _all_cases(state))
        assert numbers[0] == 500 and numbers == list(range(500, 500 + len(numbers)))
        assert state.prefs.case_id_format.enabled is False
    finally:
        await state.shutdown()


async def test_allocate_case_number_numbers_a_past_case_by_its_own_date() -> None:
    from app.config import CaseIdFormatConfig

    seq = SequenceStore(EsKVStore(InMemoryESClient()))
    fmt = CaseIdFormatConfig(enabled=True, template="{prefix}-{year}-{seq:03d}", reset_period="calendar_year")
    then = datetime(2025, 12, 31, 23, 0, tzinfo=UTC)
    assert await allocate_case_number(seq, fmt, at=then) == "CASE-2025-001"
    now_year = datetime.now(UTC).year
    assert await allocate_case_number(seq, fmt) == f"CASE-{now_year}-001"  # its own bucket
    assert await allocate_case_number(seq, fmt) == f"CASE-{now_year}-002"
    assert await allocate_case_number(seq, fmt.model_copy(update={"enabled": False})) == ""
    assert await allocate_case_number(None, fmt) == ""


async def test_case_lists_and_related_cases_carry_the_case_number() -> None:
    store = await _store(
        _case("r-1", age=timedelta(hours=1), number="CASE-000007", title="host:ws-1 · edr_alert"),
        _case("r-2", age=timedelta(hours=2)),
        _case("main", age=timedelta(hours=3), number="CASE-000009", related=["r-1", "r-2", "gone"]),
    )
    ctx = make_ctx(cases=store)
    listed = await SearchCasesTool().run(ctx, status_group="active")
    items = next(a for a in listed.artifacts if a.kind == "case_list").data["items"]
    assert {i["case_id"]: i["case_number"] for i in items} == {"r-1": "CASE-000007", "r-2": None,
                                                                "main": "CASE-000009"}
    # The strict block model takes the number (an unknown field would drop the item).
    assert_artifacts_render(listed)
    from tests.test_chat_tools_support import artifact_block

    block = artifact_block(next(a for a in listed.artifacts if a.kind == "case_list"))
    kept, dropped = validate_blocks([block])
    assert kept and not dropped
    assert {i["case_id"]: i.get("case_number") for i in kept[0]["items"]}["r-1"] == "CASE-000007"
    got = await GetCaseTool().run(ctx, case_id="CASE-000009")
    related = next(a for a in got.artifacts if a.kind == "entity").data["related_cases"]
    assert related == [
        {"case_id": "r-1", "case_number": "CASE-000007", "title": "host:ws-1 · edr_alert"},
        {"case_id": "r-2", "case_number": None, "title": f"ip:203.0.113.7{CASE_TITLE_SEPARATOR}rule_r-2"},
        # Round 14 (F7): the internal id is the link target, never the visible name.
        {"case_id": "gone", "case_number": None, "title": "Related case, not found"},
    ]
    assert_artifacts_render(got)
    assert case_list_item(_case("x", age=timedelta(hours=1), number="CASE-1"), ctx.prefs)["case_number"] == "CASE-1"


# --------------------------------------------------------------------------- #
# 5. Case titles
# --------------------------------------------------------------------------- #
def test_new_case_titles_use_a_middle_dot_and_parsers_read_both() -> None:
    cluster = Cluster(signature="sig", entity=Entity(type=EntityType.USER, value="dsingh"),
                      group_by=EntityType.USER, rule_values=["identity_signin"])
    title = machine_case_title(cluster)
    assert title == "user:dsingh · identity_signin" and "—" not in title
    for stored in (title, "user:dsingh — identity_signin"):
        assert demo_chat._case_name({"title": stored}) == "`identity_signin` on user `dsingh`"
    no_rules = Cluster(signature="s2", entity=Entity(type=EntityType.IP, value="10.0.0.1"),
                       group_by=EntityType.IP)
    assert machine_case_title(no_rules) == "ip:10.0.0.1 · activity"


def test_the_my_cases_plan_asks_for_me() -> None:
    rounds, _header, _body = drive(_starter("my_cases", {"n": 2}),
                                   lambda t, i: {"count": 2, "cases": [], "assignee_me": "the signed-in analyst's own cases"})
    assert ran(rounds)[0] == ("search_cases", {"status_group": "active", "assignee": "me",
                                               "sort_field": "risk_score", "limit": 10})


def test_free_text_my_cases_questions_ask_for_me_in_demo() -> None:
    for question in ("Which of my open cases should I work on first?", "List cases assigned to me",
                     "Show my cases"):
        view = demo_chat.PromptView(question=question, granted=("search_cases", "case_stats"))
        assert demo_chat.classify(question, view).intent == "my_cases", question
    # An SLA question about "my" cases stays an SLA question (its filter is said to be
    # not applied), and a how-to question stays help.
    for question, intent in (("Which of my cases are past their SLA?", "sla"), ("How do I see my cases?", "help")):
        view = demo_chat.PromptView(question=question, granted=("search_cases", "case_stats", "shift_report",
                                                                "app_help"))
        assert demo_chat.classify(question, view).intent == intent, question
    rounds, _header, body = drive("Which of my open cases should I work on first?",
                                  lambda t, i: {"count": 0, "cases": [],
                                                "assignee_me": "the signed-in analyst's own cases"})
    assert ran(rounds)[0][1]["assignee"] == "me"
    assert body.startswith("No open case is assigned to you right now.")
