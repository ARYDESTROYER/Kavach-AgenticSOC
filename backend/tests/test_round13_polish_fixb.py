"""Round 13 polish, review fixes (SPEC-chat §10 "As built"):

1. A "my cases" question keeps what it names: the Demo planner carries assignee "me"
   into the case filters of the plan the question gets (status, verdict, severity,
   breakdown, window, comparison), and says so where a snapshot cannot filter.
2. Case and brief conversation titles lead with the case number.
3. The report summary digest names cases by number beside the id.
4. Demo numbering is duplicate-free under every reset period.
5. Follow-up chips, planned case reads and campaign rows name cases by number.
6. The signed-in analyst's username is matched exactly, even "nobody" or "none".
7. Conversation titles carry a rule id only when the rule grammar accepts it, verbatim.
8. The shift card leads the first Demo visit; the weekly card is newer than the baseline.
9. Assignee "me" with nobody signed in shows no figure or list, and offers no lookup
   that still carries "me".
10. New candidate summaries carry no em dash.
11. Help titles name the console page they answer about.
12. A case asked for by its internal id is answered with that id beside its number.
"""

from __future__ import annotations

import asyncio
import collections
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from app.agents.chat_protocol import parse_title
from app.agents.chat_tools.cases import ASSIGNEE_ME_NOBODY, SearchCasesTool
from app.agents.chat_tools.stats import CaseStatsTool
from app.constants import EntityType, SourceSurface
from app.engine.case_aggregate import CaseAggregateSpec, aggregate_cases
from app.engine import demo_chat
from app.engine.correlation import cluster_from_events
from app.engine.time_windows import resolve_window

from tests.conftest import make_raw_event
from tests.test_chat_tools_support import assert_artifacts_render, assert_observation_whitelisted, make_ctx
from tests.test_demo_chat_round12 import drive, ran
from tests.test_round13_polish_pb1 import _case, _store


# --------------------------------------------------------------------------- #
# 10. Candidate summaries
# --------------------------------------------------------------------------- #
async def test_a_new_candidate_summary_has_no_em_dash(app_state) -> None:
    events = [make_raw_event(id=f"e{i}", ip="10.9.9.9", rule="port_scan", ts_millis=1_700_000_000_000 + i)
              for i in range(3)]
    cluster = cluster_from_events(EntityType.IP, "10.9.9.9", events)
    case = await app_state.pipeline.register_candidate(
        cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs,
        awaiting_reason="risk below the auto-investigate floor",
    )
    assert case.summary == "Candidate awaiting analysis: risk below the auto-investigate floor."
    assert "—" not in case.summary and "—" not in case.title


# --------------------------------------------------------------------------- #
# 6. A username that is also an assignee keyword
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("caller", ["nobody", "none", "unassigned", "NoBody"])
async def test_assignee_me_is_an_exact_username_even_a_keyword(caller: str) -> None:
    store = await _store(
        _case("u-1", age=timedelta(hours=1)), _case("u-2", age=timedelta(hours=2)),
        _case("mine", age=timedelta(hours=3), assignee=caller.lower()),
        _case("other", age=timedelta(hours=4), assignee="bob"),
    )
    ctx = make_ctx(cases=store, caller=caller)
    out = await SearchCasesTool().run(ctx, status_group="active", assignee="me")
    assert out.ok and out.observation["count"] == 1 and out.observation["exact"] is True
    assert [c["case_id"] for c in out.observation["cases"]] == ["mine"]
    # The streaming list path (a filter the store page alone cannot answer) agrees.
    risky = await SearchCasesTool().run(ctx, status_group="active", assignee="me", text="rule_mine")
    assert [c["case_id"] for c in risky.observation["cases"]] == ["mine"]
    stats = await CaseStatsTool().run(ctx, status_group="active", assignee="me")
    assert stats.ok and stats.observation["totals"]["count"] == 1, stats.observation
    # An explicit keyword typed by the model still means the unassigned queue.
    queue = await SearchCasesTool().run(ctx, status_group="active", assignee="unassigned")
    assert sorted(c["case_id"] for c in queue.observation["cases"]) == ["u-1", "u-2"]


async def test_the_aggregate_takes_an_exact_username_filter() -> None:
    store = await _store(_case("u-1", age=timedelta(hours=1)),
                         _case("n-1", age=timedelta(hours=2), assignee="Nobody"))
    window = resolve_window("all")
    exact = await aggregate_cases(store, CaseAggregateSpec(window=window, filters={"assignee_user": "nobody"}))
    keyword = await aggregate_cases(store, CaseAggregateSpec(window=window, filters={"assignee": "nobody"}))
    assert exact.total == 1 and keyword.total == 1
    both = await aggregate_cases(store, CaseAggregateSpec(window=window, filters={"assignee_user": "none"}))
    assert both.total == 0


async def test_the_my_cases_card_count_matches_an_exact_username(app_state, monkeypatch) -> None:
    from app.engine import chat_starters as cs

    for case in (_case("u-1", age=timedelta(hours=1)), _case("n-1", age=timedelta(hours=2), assignee="nobody")):
        await app_state.cases.save(case)

    build = SimpleNamespace(ctx=SimpleNamespace(cases=app_state.cases), tz_name="UTC",
                            now=datetime.now(timezone.utc), prefs=app_state.prefs, username="nobody")
    assert await cs._assigned_count(build) == 1


async def test_a_zero_result_for_me_offers_lookups_that_keep_me() -> None:
    store = await _store(_case("u-1", age=timedelta(hours=1), assignee="bob"))
    out = await SearchCasesTool().run(make_ctx(cases=store, caller="nobody"), status_group="active",
                                      assignee="me")
    assert out.observation["count"] == 0
    inputs = [s["input"] for s in out.observation["suggestions"]]
    assert {"status_group": "active"} in inputs  # without the assignee filter
    # Every other lookup still asks for "me" (resolved again on the server), never the
    # bare username, which would read as the unassigned keyword.
    assert all(i.get("assignee") in (None, "me") for i in inputs), inputs


# --------------------------------------------------------------------------- #
# 9. Nobody signed in
# --------------------------------------------------------------------------- #
async def test_me_with_nobody_signed_in_shows_no_figure_and_no_me_chip() -> None:
    store = await _store(_case("u-1", age=timedelta(hours=1)),
                         _case("u-2", age=timedelta(hours=2), assignee="alice"))
    out = await SearchCasesTool().run(make_ctx(cases=store), status_group="active", assignee="me")
    assert out.ok and out.summary.startswith(ASSIGNEE_ME_NOBODY)
    assert out.artifacts == []  # no "Matching cases 0" figure, no empty list
    suggestions = out.observation["suggestions"]
    assert suggestions == [{"label": "Without the assignee filter", "tool": "search_cases",
                            "input": {"status_group": "active"}}]
    assert_observation_whitelisted(out)
    assert_artifacts_render(out)
    # With no other filter, the one lookup left is every case.
    bare = await SearchCasesTool().run(make_ctx(cases=store), assignee="me")
    assert bare.artifacts == []
    assert [s["input"] for s in bare.observation["suggestions"]] == [{}]


# --------------------------------------------------------------------------- #
# 4. Demo numbering under every reset period
# --------------------------------------------------------------------------- #
async def _demo_numbers(period: str, template: str, history_days: int) -> list[str]:
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    try:
        fmt = state.prefs.case_id_format.model_copy(update={"reset_period": period, "template": template})
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True, "case_id_format": fmt}))
        await state.enable_demo(mode="seeded", seed=1337, history_days=history_days)
        cases, _ = await state.cases.list(limit=2000)
        return [c.case_number for c in cases]
    finally:
        await state.shutdown()


@pytest.mark.parametrize(("period", "template", "days"), [
    ("fiscal_quarter", "CASE-{seq:06d}", 30),
    ("calendar_year", "CASE-{seq:06d}", 365),
    ("fiscal_year", "CASE-{seq:06d}", 365),
    ("fiscal_quarter", "{prefix}-{year}-{seq:04d}", 120),
])
async def test_demo_seeding_never_repeats_a_number_under_any_reset_period(period: str, template: str,
                                                                         days: int) -> None:
    numbers = await _demo_numbers(period, template, days)
    assert numbers and all(numbers)
    repeated = {n: k for n, k in collections.Counter(numbers).items() if k > 1}
    assert not repeated, repeated


async def test_demo_numbers_keep_each_cases_own_date() -> None:
    numbers = await _demo_numbers("calendar_year", "{prefix}-{year}-{seq:04d}", 365)
    years = {n.split("-")[1] for n in numbers}
    # The seeded year reaches back past January 1 at any date; each case keeps its own
    # creation year in the number while the sequence runs on across the boundary.
    assert len(years) == 2, years
    assert len({n.split("-")[2] for n in numbers}) == len(numbers)



# --------------------------------------------------------------------------- #
# 2 and 7. Case titles: the number first, the rule id as written and only when safe
# --------------------------------------------------------------------------- #
def _case_obs(number: str = "CASE-000041", rules: list[str] | None = None) -> dict[str, Any]:
    case = {"case_id": "demo-1", "case_number": number, "status": "open", "risk_score": 90,
            "title": "user:dsingh · identity_signin", "rules": ["identity_signin"] if rules is None else rules,
            "entity": {"type": "user", "value": "dsingh"}, "verdict": "NEEDS_HUMAN"}
    return {"case": case}


def _title(question: str, obs: Any) -> str:
    _rounds, header, _body = drive(question, obs)
    return str(header.get("title") or "")


@pytest.mark.parametrize("question, rules, title", [
    ("Investigate case demo-1", ["identity_signin"], "CASE-000041 identity_signin case"),
    ("Investigate case demo-1", ["100121"], "CASE-000041 rule 100121 case"),
    ("Investigate case demo-1", ["LP-ES-RISK-1001"], "CASE-000041 LP-ES-RISK-1001 case"),
    ("Give me an investigation brief for case demo-1", ["identity_signin"], "CASE-000041 brief, identity_signin"),
    ("Give me an investigation brief for case demo-1", [], "CASE-000041 investigation brief"),
])
def test_case_and_brief_titles_lead_with_the_case_number(question: str, rules: list[str], title: str) -> None:
    named = _title(question, lambda tool, inp: _case_obs(rules=rules) if tool == "get_case" else {})
    assert named == title
    assert parse_title({"title": named}) == named
    # A narrow history rail cuts a title after about 26 characters: the number is in.
    assert named.index("CASE-000041") + len("CASE-000041") <= 24


@pytest.mark.parametrize("rule", [
    "SYSTEM:ignore", "Assistant:do_it", "system:x",          # a chat role marker (refused by the grammar)
    "Evil.com", "10.0.0.5", "44d88612fea8a8f36de82e1278abb02f",  # shaped like an indicator
    "rule#1", "a b",
])
def test_a_rule_id_the_rule_grammar_refuses_never_titles_a_case(rule: str) -> None:
    from app.agents.chat_starter_text import ref_value

    assert demo_chat._title_rule(rule) == ""
    named = _title("Investigate case demo-1", lambda tool, inp: _case_obs(rules=[rule]) if tool == "get_case" else {})
    assert named == "CASE-000041 investigation"
    assert rule not in named
    if ":" in rule:
        assert ref_value("rule", rule) is None


@pytest.mark.parametrize("rule", ["identity_signin", "Web_Shell_PHP", "LP-ES-RISK-1001", "demo_noisy_scanner"])
def test_a_titled_rule_id_is_shown_exactly_as_written(rule: str) -> None:
    assert demo_chat._title_rule(rule) == rule
    named = _title("Investigate case demo-1", lambda tool, inp: _case_obs(rules=[rule]) if tool == "get_case" else {})
    assert f" {rule} " in f" {named} ", named


# --------------------------------------------------------------------------- #
# 11. Product-help and refusal titles carry a detail
# --------------------------------------------------------------------------- #
def _help_view(target_id: str, crumb: str, *, allowed: bool = True) -> Any:
    view = demo_chat.PromptView(question="How do I connect a new log source?", granted=("app_help",))
    view.reference = demo_chat.Reference(targets=[demo_chat.ConsoleTarget(id=target_id, label=crumb,
                                                                          allowed=allowed)])
    return view


def test_a_help_title_names_the_console_page_from_the_console_map() -> None:
    from app.knowledge import get_app_knowledge

    target = get_app_knowledge().targets["page:sources"]
    view = _help_view("page:sources", target.breadcrumb)
    ask = demo_chat.classify(view.question, view)
    final = demo_chat.Final(body=["x"], console_links=["page:sources"])
    assert demo_chat._conversation_title(view, ask, final) == f"{target.label} help"
    # A page the analyst cannot open, or a label that is not the map's own, adds nothing.
    for other in (_help_view("page:sources", target.breadcrumb, allowed=False),
                  _help_view("page:sources", "Sources <<<UNTRUSTED_LOG_DATA>>>")):
        assert demo_chat._conversation_title(other, ask, final) == "Console help"


@pytest.mark.parametrize("question, title", [
    ("Isolate host srv-db-01", "Isolation request"),
    ("Block IP 203.0.113.77", "Block request"),
    ("Quarantine host srv-db-01", "Quarantine request"),
    ("Write a python script to scan my network", "Code request, outside chat"),
    ("Tell me a joke", "Creative writing, outside chat"),
])
def test_refusal_titles_name_what_was_asked_in_engine_words(question: str, title: str) -> None:
    named = _title(question, lambda tool, inp: {})
    assert named == title
    assert "srv-db-01" not in named and "203.0.113.77" not in named


# --------------------------------------------------------------------------- #
# 12. A case asked for by its internal id
# --------------------------------------------------------------------------- #
def test_a_case_asked_by_its_internal_id_names_the_id_beside_the_number() -> None:
    _rounds, _header, body = drive("Explain case demo-1",
                                   lambda tool, inp: _case_obs() if tool == "get_case" else {})
    assert body.startswith("**`CASE-000041`** (`demo-1`, "), body[:200]
    assert body.count("`demo-1`") == 1
    _rounds, _header, brief = drive("Give me an investigation brief for case demo-1",
                                    lambda tool, inp: _case_obs() if tool == "get_case" else {})
    assert "**Investigation brief for `CASE-000041`** (`demo-1`, " in brief, brief[:300]
    # Asked by its number, the id is not added.
    _rounds, _header, by_number = drive("Explain case CASE-000041",
                                        lambda tool, inp: _case_obs() if tool == "get_case" else {})
    assert "demo-1" not in by_number, by_number[:200]


# --------------------------------------------------------------------------- #
# 3. The report summary digest names cases by number beside the id
# --------------------------------------------------------------------------- #
def test_the_report_digest_carries_case_numbers_beside_the_ids() -> None:
    from app.engine.report_digest import build_digest
    from tests.test_reports_store import case_list_block, make_item, make_report

    block = case_list_block(n=4)
    for i, item in enumerate(block["items"]):
        if i != 2:
            item["case_number"] = f"CASE-{78 + i:06d}"
    entity = {"id": "b7", "type": "entity", "provenance": "code", "artifact_kind": "entity",
              "allowed_views": ["entity"], "title": "Case entity", "entity": {"kind": "user", "value": "pnair"},
              "related_cases": [{"case_id": "case-a", "case_number": "CASE-000090", "title": "x"},
                                {"case_id": "case-b", "title": "y"}]}
    digest = build_digest(make_report([make_item(block, block_id="b5"), make_item(entity, block_id="b7")]))
    cases = digest["items"][0]["blocks"][0]
    assert cases["case_ids"] == ["case-0000", "case-0001", "case-0002", "case-0003"]
    assert cases["case_numbers"] == ["CASE-000078", "CASE-000079", None, "CASE-000081"]
    related = digest["items"][1]["blocks"][0]
    assert related["related_cases"] == ["case-a", "case-b"]
    assert related["related_case_numbers"] == ["CASE-000090", None]
    # Without any number, no empty list is added.
    plain = build_digest(make_report([make_item(case_list_block(n=2), block_id="b5")]))
    assert "case_numbers" not in plain["items"][0]["blocks"][0]


# --------------------------------------------------------------------------- #
# 5. Case references a lookup gives with a number use the number
# --------------------------------------------------------------------------- #
async def test_list_campaigns_names_member_cases_by_number_beside_the_id() -> None:
    from app.agents.chat_tools.cases import ListCampaignsTool
    from app.es.fake import InMemoryESClient
    from app.models import Campaign, CampaignEntity
    from app.stores.campaigns import CampaignStore
    from app.stores.memory import EsKVStore

    store = await _store(_case("case-1", age=timedelta(hours=1), number="CASE-000078"),
                         _case("case-2", age=timedelta(hours=2)))
    camps = CampaignStore(EsKVStore(InMemoryESClient()))
    await camps.upsert(Campaign(id="campaign-1", name="", case_ids=["case-1", "case-2", "gone"],
                                entities=[CampaignEntity(entity_type="user", value="pnair")]))
    out = await ListCampaignsTool().run(make_ctx(campaigns=camps, cases=store))
    row = out.observation["campaigns"][0]
    assert row["case_ids"] == ["case-1", "case-2", "gone"]
    assert row["case_numbers"] == ["CASE-000078", None, None]
    assert_observation_whitelisted(out)
    # No member with a number: no list of nothing.
    bare = CampaignStore(EsKVStore(InMemoryESClient()))
    await bare.upsert(Campaign(id="campaign-2", name="", case_ids=["case-2"]))
    plain = await ListCampaignsTool().run(make_ctx(campaigns=bare, cases=store))
    assert "case_numbers" not in plain.observation["campaigns"][0]


def test_a_deep_dive_reads_and_offers_the_riskiest_case_by_its_number() -> None:
    case = {"case_id": "demo-00000539-0024", "case_number": "CASE-000024", "status": "escalated",
            "risk_score": 88, "entity": "ip:203.0.113.42", "rules": ["demo_c2"], "title": "ip · demo_c2"}

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "search_cases":
            return {"count": 1, "exact": True, "window": "last 30 days", "filters": {"entity": "203.0.113.42"},
                    "cases": [case]}
        if tool == "get_case":
            return {"case": {**case, "entity": {"type": "ip", "value": "203.0.113.42"}}}
        return {"window": "last 30 days", "total": 0}

    rounds, header, _body = drive("Investigate everything about 203.0.113.42", obs)
    reads = [inp for tool, inp in ran(rounds) if tool in ("get_case", "explain_decision")]
    assert reads and all(inp == {"case_id": "CASE-000024"} for inp in reads), reads
    chips = header.get("follow_ups") or []
    assert "demo-00000539-0024" not in " ".join(chips), chips


def test_the_sla_breached_read_names_the_overdue_case_by_number() -> None:
    from tests.test_demo_chat_round13 import _starter

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "shift_report":
            return {"window": "last 24 hours", "sla": {
                "enabled": True, "totals": {"breached": 2, "about_to_breach": 0},
                "breached": [{"case_id": "demo-00000539-0037", "case_number": "CASE-000037",
                              "overdue_minutes": 30.0}]}}
        return {"case": {"case_id": "demo-00000539-0037", "case_number": "CASE-000037", "status": "open"}}

    rounds, _header, _body = drive(_starter("sla_breached", {"n": 2}), obs)
    assert ("get_case", {"case_id": "CASE-000037"}) in ran(rounds), ran(rounds)


# --------------------------------------------------------------------------- #
# 8. The shift card on a first Demo visit; the weekly card's personal factor
# --------------------------------------------------------------------------- #
async def test_a_first_demo_visit_shows_the_shift_card_among_the_first_four() -> None:
    from app.engine.chat_starters import StarterUserState, build_starters
    from tests.test_chat_tools_support import build_demo_state
    from tests.test_round13_polish_pb1 import _request

    state = await build_demo_state()
    try:
        info = await build_starters(state, _request(state), surface="home", now=datetime.now(timezone.utc),
                                    user_state=StarterUserState())
        ids = [s.id for s in info.starters]
        assert "shift" in ids[:4] and "demo" in ids, ids
        assert ids.index("demo") == ids.index("shift") + 1, ids
    finally:
        await state.shutdown()


def _candidate(family: str, template: str | None = None, slots: dict[str, Any] | None = None):
    from app.engine.chat_starters import StarterCandidate, starter_from_template

    return StarterCandidate(family, starter_from_template(template or family, slots or {}))


@pytest.mark.parametrize("shift_template, demo_at", [("shift_start", 4), ("shift_handoff", 3)])
def test_the_demo_card_yields_slot_four_only_to_a_shift_start_card(shift_template: str, demo_at: int) -> None:
    from app.engine.chat_starters import _keep_demo_card

    demo = _candidate("demo")
    ranked = [_candidate("needs_human", "needs_human", {"case": "case-1"}),
              _candidate("new_cases", "new_cases", {"n": 3, "since": "08:00"}),
              _candidate("approvals", "approvals", {"n": 2}),
              _candidate("shift", shift_template, {"h": 24} if shift_template == "shift_start" else {}),
              _candidate("posture")]
    out = _keep_demo_card(ranked, [*ranked, demo], None, datetime.now(timezone.utc))
    assert [c.family for c in out].index("demo") == demo_at


def test_the_weekly_card_counts_the_personal_factor_after_a_baseline() -> None:
    from app.engine import chat_starters as cs

    now = datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc)  # a Monday
    seen = cs.StarterUserState(last_seen_at=now - timedelta(days=2), visit_started_at=now - timedelta(days=2, hours=1),
                               catchup_since=now - timedelta(days=3), shift_started_at=now - timedelta(days=2))
    build = SimpleNamespace(now=now, zone=timezone.utc, view=SimpleNamespace(baseline=now - timedelta(days=2)),
                            card=lambda template, slots=None, **kw: cs.starter_from_template(template, slots or {}))
    built = asyncio.run(cs._family_weekly(build))
    assert built.candidate is not None and built.candidate.newer_than_baseline
    assert built.candidate.signal_at is None
    assert cs.score(built.candidate, user_state=seen, now=now) == cs.BASE["weekly"] * 1.5
    # No baseline yet (a first visit): no personal factor, like every other family.
    first = SimpleNamespace(now=now, zone=timezone.utc, view=SimpleNamespace(baseline=None), card=build.card)
    assert not asyncio.run(cs._family_weekly(first)).candidate.newer_than_baseline
