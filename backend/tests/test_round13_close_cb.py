"""Round 13 close (CB): chat answers whose figures agree with their blocks.

1. A campaign's techniques (and shared entities) are never cut without a word: the
   ``list_campaigns`` observation lists them with their count, a table cell names them
   all or the first ones and "and K more", and the prose does the same.
2. A case lookup with an in-memory filter ("my cases") whose shared case page predates
   its exact count (a case was assigned a moment ago) reads the page again, so the
   count and the rows describe the same cases; when they still differ, the figures
   come from the page, the same read as the rows.
3. The shift headline's "Needs human" counts the open cases whose verdict is Needs
   human (the badge beside it), and every rate and score is stated as the console's
   tiles show it ("78%", never "77.5%"; "7/100", never "7.4").
4. A widening chip widens: "last 30 days" counted in whole days is never offered "Last
   30 days" again.
5. ``list_campaigns(entity=…)`` lists only the campaigns that involve the entity, and
   the in-depth investigation's table shows those, titled for the entity.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.agents.chat_tools import cases as case_tools
from app.agents.chat_tools.cases import ListCampaignsTool, SearchCasesTool, with_more
from app.agents.chat_tools.common import align_to_bucket, resolve_window
from app.agents.chat_tools.logs import LogStatsInput, _Plan, covered_days, zero_log_suggestions
from app.api.metrics_shared import invalidate_case_page_cache
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import demo_chat
from app.engine.shift_report import headline_counts
from app.es.fake import InMemoryESClient
from app.models import Campaign, CampaignEntity, Case, Entity
from app.stores.campaigns import CampaignStore
from app.stores.cases import CaseStore
from app.stores.memory import EsKVStore
from tests.test_chat_tools_support import assert_artifacts_render, assert_observation_whitelisted, make_ctx
from tests.test_demo_chat_round12 import drive


def _case(i: int, *, assignee: str = "", entity: str = "203.0.113.7", verdict: Verdict = Verdict.NEEDS_HUMAN,
          status: CaseStatus = CaseStatus.OPEN, risk: float = 50.0) -> Case:
    created = (datetime.now(UTC) - timedelta(hours=1 + i)).isoformat()
    kind = EntityType.USER if not entity[0].isdigit() else EntityType.IP
    return Case(
        case_id=f"case-{i:04d}", case_number=f"CASE-{i:06d}", cluster_signature=f"sig-{i}",
        source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=kind, value=entity),
        status=status, verdict=verdict, confidence=0.6, risk_score=risk, title=f"Case {i}",
        rule_ids=["demo_rule"], created_at=created, updated_at=created, assignee=assignee,
    )


@pytest.fixture(autouse=True)
def _fresh_page_cache():
    invalidate_case_page_cache()
    yield
    invalidate_case_page_cache()


# --------------------------------------------------------------------------- #
# 1. Every technique, or the first ones and "and K more".
# --------------------------------------------------------------------------- #
def test_with_more_names_every_item_or_says_how_many_more() -> None:
    assert with_more(["T1021", "T1048", "T1078", "T1566"], 4) == "T1021, T1048, T1078, T1566"
    assert with_more(["T1", "T2", "T3", "T4", "T5", "T6", "T7"], 4) == "T1, T2, T3 and 4 more"
    assert with_more([], 4) == ""


async def test_a_campaign_with_four_techniques_shows_all_four_in_the_observation_and_the_table() -> None:
    camps = CampaignStore(EsKVStore(InMemoryESClient()))
    await camps.upsert(Campaign(id="campaign-4", case_ids=["case-1", "case-2"],
                                entities=[CampaignEntity(entity_type="ip", value="203.0.113.77")],
                                mitre=["T1021", "T1048", "T1078", "T1566"]))
    await camps.upsert(Campaign(id="campaign-9", case_ids=["case-3", "case-4"],
                                entities=[CampaignEntity(entity_type="user", value=f"u{i}") for i in range(6)],
                                mitre=[f"T10{i:02d}" for i in range(15)],
                                last_seen=(datetime.now(UTC) - timedelta(days=1)).isoformat()))
    out = await ListCampaignsTool().run(make_ctx(campaigns=camps))
    assert out.ok
    assert_observation_whitelisted(out)
    assert_artifacts_render(out)
    rows = {r["id"]: r for r in out.observation["campaigns"]}
    assert rows["campaign-4"]["mitre"] == ["T1021", "T1048", "T1078", "T1566"]
    assert rows["campaign-4"]["mitre_count"] == 4 and rows["campaign-4"]["entity_count"] == 1
    # A bounded list says how many there are, so nothing is cut without a word.
    assert len(rows["campaign-9"]["mitre"]) == 12 and rows["campaign-9"]["mitre_count"] == 15
    assert len(rows["campaign-9"]["entities"]) == 5 and rows["campaign-9"]["entity_count"] == 6
    table = next(a for a in out.artifacts if a.kind == "table")
    cells = {row[0]: row for row in table.data["rows"]}
    assert cells["campaign-4"][-1] == "T1021, T1048, T1078, T1566"
    assert cells["campaign-9"][-1] == "T1000, T1001, T1002 and 12 more"
    assert cells["campaign-9"][-2] == "user:u0, user:u1, user:u2 and 3 more"


def test_the_prose_names_every_technique_or_says_how_many_more() -> None:
    four = {"case_count": 5, "case_ids": ["demo-1"], "entities": ["ip:203.0.113.77"],
            "mitre": ["T1021", "T1048", "T1078", "T1566"], "mitre_count": 4, "severity": "high"}
    many = {"case_count": 2, "case_ids": ["demo-2"], "entities": ["user:pnair", "ip:198.51.100.23", "host:web01"],
            "entity_count": 3, "mitre": ["T1001", "T1002", "T1003", "T1004", "T1005"], "mitre_count": 9}
    result = demo_chat.Result(ordinal=1, tool="list_campaigns", status="ok", summary="2 campaigns",
                              observation={"total": 2, "returned": 2, "campaigns": [four, many]})
    text = demo_chat._say_campaigns(result)
    assert "ATT&CK T1021, T1048, T1078, T1566)" in text, text
    assert "ATT&CK T1001, T1002, T1003 and 6 more" in text, text
    assert "sharing user `pnair` and 2 more" in text, text


def test_the_campaign_answer_links_every_technique() -> None:
    camp = {"id": "campaign-1e57", "status": "open", "case_count": 5, "case_ids": ["demo-1", "demo-2"],
            "entities": ["ip:203.0.113.77"], "mitre": ["T1021", "T1048", "T1078", "T1566"], "mitre_count": 4}

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any]:
        if tool == "list_campaigns":
            return {"case_filter": {"found": True, "case_id": "demo-2", "case_number": "CASE-000002"},
                    "total": 1, "returned": 1, "campaigns": [camp]}
        return {"count": 0, "cases": []}

    from tests.test_demo_chat_round13 import _starter

    _rounds, _header, body = drive(_starter("campaign", {"n": 5, "case": "CASE-000002"}), obs)
    assert "ATT&CK T1021, T1048, T1078, T1566" in body.split("\n\n")[0], body


# --------------------------------------------------------------------------- #
# 2. The rows and the count of one lookup describe the same cases.
# --------------------------------------------------------------------------- #
async def _store(*cases: Case) -> CaseStore:
    store = CaseStore(InMemoryESClient())
    for case in cases:
        await store.save(case)
    return store


async def test_my_cases_right_after_an_assignment_lists_every_case_it_counts() -> None:
    store = await _store(*[_case(i, risk=40 + i) for i in range(1, 7)])
    ctx = make_ctx(cases=store)
    before = await SearchCasesTool().run(ctx, assignee="alice", status_group="active")
    assert before.ok and before.observation["count"] == 0
    # Within the shared page's few seconds, three cases are assigned to alice.
    for cid in ("case-0001", "case-0003", "case-0005"):
        case = await store.get(cid)
        await store.save(case.model_copy(update={"assignee": "alice"}))
    after = await SearchCasesTool().run(ctx, assignee="alice", status_group="active", sort_field="risk_score")
    assert after.ok and after.observation["count"] == 3, after.observation
    assert [c["case_id"] for c in after.observation["cases"]] == ["case-0005", "case-0003", "case-0001"]
    listed = next(a for a in after.artifacts if a.kind == "case_list")
    assert len(listed.data["items"]) == 3


async def test_a_page_that_agrees_with_the_count_is_read_once(monkeypatch: pytest.MonkeyPatch) -> None:
    store = await _store(*[_case(i, assignee="alice" if i % 2 else "") for i in range(1, 7)])
    reads: list[int] = []
    real = store.list

    async def counting(*args: Any, **kwargs: Any):
        if kwargs.get("limit") == case_tools.CASE_SCAN_LIMIT:
            reads.append(1)
        return await real(*args, **kwargs)

    monkeypatch.setattr(store, "list", counting)
    ctx = make_ctx(cases=store)
    for _ in range(2):
        out = await SearchCasesTool().run(ctx, assignee="alice", status_group="active")
        assert out.ok and out.observation["count"] == 3 == len(out.observation["cases"])
    assert len(reads) == 1, reads


async def test_figures_come_from_the_page_when_a_fresh_page_still_differs(monkeypatch: pytest.MonkeyPatch) -> None:
    """A case changed between the count and the fresh page read: the stated count, the
    breakdown and the average risk come from the page, the same read as the rows."""
    store = await _store(_case(1, assignee="alice", risk=30), _case(2, assignee="alice", risk=50),
                         _case(3, risk=90))
    from app.engine.case_aggregate import AggregateResult

    async def stale_count(self, ctx, args, window):
        return AggregateResult(total=5, groups=[{"key": {"verdict": "NEEDS_HUMAN", "status": "open"},
                                                 "bucket": None, "metrics": {"count": 5}}],
                               buckets=[], exact=True, consistency="point_in_time", scanned=5,
                               totals={"count": 5, "mean_risk": 70.0})

    monkeypatch.setattr(SearchCasesTool, "_exact_counts", stale_count)
    out = await SearchCasesTool().run(make_ctx(cases=store), assignee="alice")
    assert out.ok
    assert out.observation["count"] == 2 == len(out.observation["cases"])
    assert out.observation["by_verdict"] == {"NEEDS_HUMAN": 2}
    assert out.observation["average_risk"] == 40.0
    figures = {i["key"]: i["value"] for i in next(a for a in out.artifacts if a.kind == "kpis").data["items"]}
    assert figures["matched"] == 2 and figures["avg_risk"] == 40.0


def test_page_agreement_compares_the_total_and_the_breakdown() -> None:
    from app.engine.case_aggregate import AggregateResult

    rows = [_case(1), _case(2, verdict=Verdict.TRUE_POSITIVE)]
    listing = case_tools._Listing(rows, 2, True, 2, rows)

    def agg(groups: dict[tuple[str, str], int]) -> AggregateResult:
        return AggregateResult(total=sum(groups.values()), groups=[
            {"key": {"verdict": v, "status": s}, "metrics": {"count": n}} for (v, s), n in groups.items()],
            buckets=[], exact=True, consistency="point_in_time", scanned=2)

    assert case_tools._page_agrees(listing, agg({("NEEDS_HUMAN", "open"): 1, ("TRUE_POSITIVE", "open"): 1}))
    assert not case_tools._page_agrees(listing, agg({("NEEDS_HUMAN", "open"): 2}))
    assert not case_tools._page_agrees(listing, agg({("NEEDS_HUMAN", "open"): 1}))
    assert case_tools._page_agrees(listing, None)
    # A page of the newest cases only disagrees when it holds more matches than exist.
    partial = case_tools._Listing(rows, 2, False, 2, rows)
    assert case_tools._page_agrees(partial, agg({("NEEDS_HUMAN", "open"): 9}))
    assert not case_tools._page_agrees(partial, agg({("NEEDS_HUMAN", "open"): 1}))


# --------------------------------------------------------------------------- #
# 3. One figure, one form.
# --------------------------------------------------------------------------- #
def test_the_shift_headline_counts_open_cases_with_a_needs_human_verdict() -> None:
    cases = [_case(1), _case(2), _case(3, verdict=Verdict.TRUE_POSITIVE, status=CaseStatus.ESCALATED),
             _case(4, status=CaseStatus.CLOSED)]
    counts = headline_counts(cases, needs_human_verdict=True)
    assert counts["needs_human_verdict"] == 2 and counts["needs_human"] == 0 and counts["open"] == 3
    # The Standup page and its model aggregate keep their keys.
    assert "needs_human_verdict" not in headline_counts(cases)


async def test_the_chat_shift_report_asks_the_snapshot_for_the_verdict_count() -> None:
    from app.agents.chat_tools.cases import ShiftReportTool

    class Standup:
        def __init__(self) -> None:
            self.asked: list[bool] = []

        async def shift_snapshot(self, prefs, *, window_hours=None, now=None, needs_human_verdict=False):
            self.asked.append(needs_human_verdict)
            return {"headline_counts": headline_counts([_case(1), _case(2)], needs_human_verdict=needs_human_verdict),
                    "deltas": {}, "attention_queue": [], "sla_aging": {}, "workload": []}

    standup = Standup()
    out = await ShiftReportTool().run(make_ctx(standup=standup))
    assert out.ok and standup.asked == [True]
    items = {i["label"]: i["value"] for i in out.artifacts[0].data["items"]}
    assert items["Needs human"] == 2, items


@pytest.mark.parametrize("value, ratio, shown", [
    (0.775, True, "78%"), (77.5, False, "78%"), (0.145, True, "15%"), (14.5, False, "15%"),
    (7.45, False, "7.5%"), (7.0, False, "7%"), (0.004, True, "<1%"), (0, False, "0%"), (100, False, "100%"),
    (1234.5, False, "1,235%"),
])
def test_a_rate_reads_as_the_console_tile_shows_it(value: float, ratio: bool, shown: str) -> None:
    assert demo_chat._pct(value, ratio=ratio) == shown


def test_a_score_and_a_change_in_points_read_as_the_console_shows_them() -> None:
    assert demo_chat._value_text(7.4, "score") == "7/100"
    assert demo_chat._value_text(62.5, "score") == "63/100"
    assert demo_chat._change_text({"change": 35.6, "unit": "percent"}) == "+36 points"
    assert demo_chat._change_text({"change": -3.45, "unit": "percent"}) == "−3.5 points"


def test_a_rule_breakdown_states_its_average_risk_as_the_table_does() -> None:
    obs = {"metrics": ["count", "mean_risk"], "totals": {"count": 12, "mean_risk": 7.4},
           "units": {"mean_risk": "score"}}
    assert demo_chat._say_stats_totals(obs) == "Average risk 7/100."


def test_the_shift_next_steps_state_the_rate_as_the_posture_tile() -> None:
    shift = demo_chat.Result(ordinal=1, tool="shift_report", status="ok", summary="", observation={
        "window": "last 24 hours", "headline": {"open": 20, "escalated": 0, "needs_human_verdict": 10,
                                                "unassigned": 0, "sla_breached": 0}})
    post = demo_chat.Result(ordinal=2, tool="soc_metrics", status="ok", summary="", observation={
        "quality": {"false_positive_rate": 0.775}})
    camps = demo_chat.Result(ordinal=3, tool="list_campaigns", status="ok", summary="",
                             observation={"total": 1, "campaigns": []})
    steps = demo_chat._shift_steps(shift, post, camps)
    assert "Give a verdict on the 10 open cases marked Needs human." in steps
    assert "Track the 1 open campaign that links related cases." in steps
    assert any("false-positive rate is 78%:" in s for s in steps), steps
    assert not any("77.5" in s or "Needs human status" in s for s in steps), steps


# --------------------------------------------------------------------------- #
# 4. A widening chip widens.
# --------------------------------------------------------------------------- #
def _log_window(spec: str, *, aligned: bool):
    window = resolve_window(make_ctx(), window=spec)
    assert not isinstance(window, str)
    return align_to_bucket(window, "day") if aligned else window


def _labels(spec: str, *, aligned: bool) -> list[str]:
    args = LogStatsInput(user="pnair", window=spec)
    plan = _Plan(mode="fanout", name="all sources")
    return [s["label"] for s in zero_log_suggestions("log_stats", args, _log_window(spec, aligned=aligned), plan)]


def test_a_30_day_window_counted_in_whole_days_is_never_offered_the_last_30_days() -> None:
    aligned = _log_window("now-30d", aligned=True)
    assert aligned.span_days < 30 and covered_days(aligned) == 30
    assert "Last 30 days" not in _labels("now-30d", aligned=True)
    assert "Last 30 days" not in _labels("now-30d", aligned=False)


@pytest.mark.parametrize("spec, aligned, widened", [
    ("now-3d", True, "Last 7 days"), ("now-3d", False, "Last 7 days"),
    ("now-7d", True, "Last 30 days"), ("now-14d", False, "Last 30 days"),
])
def test_a_shorter_window_is_offered_a_wider_one(spec: str, aligned: bool, widened: str) -> None:
    labels = _labels(spec, aligned=aligned)
    assert labels[0] == widened, labels


# --------------------------------------------------------------------------- #
# 5. The campaigns that involve the entity.
# --------------------------------------------------------------------------- #
async def test_list_campaigns_by_entity_lists_only_the_campaigns_that_involve_it() -> None:
    store = await _store(_case(1, entity="pnair"), _case(2, entity="198.51.100.23"), _case(3, entity="dsingh"))
    camps = CampaignStore(EsKVStore(InMemoryESClient()))
    now = datetime.now(UTC)
    await camps.upsert_many([
        Campaign(id="camp-shared", case_ids=["case-0003", "case-0002"],
                 entities=[CampaignEntity(entity_type="user", value="PNAIR")], last_seen=now.isoformat()),
        Campaign(id="camp-member", case_ids=["case-0001", "case-0002"],
                 entities=[CampaignEntity(entity_type="ip", value="198.51.100.23")],
                 last_seen=(now - timedelta(hours=1)).isoformat()),
        Campaign(id="camp-other", case_ids=["case-0002", "case-0003"],
                 entities=[CampaignEntity(entity_type="ip", value="203.0.113.77")],
                 last_seen=(now - timedelta(hours=2)).isoformat()),
    ])
    out = await ListCampaignsTool().run(make_ctx(cases=store, campaigns=camps), entity="pnair")
    assert out.ok and out.observation["total"] == 2, out.observation
    assert [(c["id"], c["match"]) for c in out.observation["campaigns"]] == [
        ("camp-shared", "shared_entity"), ("camp-member", "member_case")]
    assert out.observation["entity_filter"] == {"cases_about_entity": 1, "cases_checked": 1}
    assert out.untrusted_params == {"entity": "pnair"}
    assert "pnair" not in str(out.observation["entity_filter"])
    table = next(a for a in out.artifacts if a.kind == "table")
    assert [row[0] for row in table.data["rows"]] == ["camp-shared", "camp-member"]
    assert out.summary.startswith("2 campaigns involving the entity")
    none = await ListCampaignsTool().run(make_ctx(cases=store, campaigns=camps), entity="nobody-here")
    assert none.ok and none.observation["total"] == 0 and none.observation["campaigns"] == []


def test_the_in_depth_investigation_shows_only_the_entitys_campaigns() -> None:
    involved = [{"id": "campaign-1e57", "status": "open", "case_count": 2, "case_ids": ["demo-1", "demo-2"],
                 "entities": ["user:pnair"], "mitre": ["T1078"], "mitre_count": 1, "match": "shared_entity"},
                {"id": "campaign-77aa", "status": "open", "case_count": 2, "case_ids": ["demo-8", "demo-9"],
                 "entities": ["ip:198.51.100.23"], "mitre": [], "mitre_count": 0, "match": "member_case"}]
    asked: list[dict[str, Any]] = []

    def obs(tool: str, inp: dict[str, Any]) -> dict[str, Any] | None:
        if tool == "list_campaigns":
            asked.append(dict(inp))
            return {"total": 2, "returned": 2, "entity_filter": {"cases_about_entity": 3, "cases_checked": 3},
                    "campaigns": involved}
        from tests.test_demo_chat_round12 import _generic_obs

        return _generic_obs(tool, inp)

    from app.agents.chat_protocol import parse_reply
    from app.engine.demo_chat import plan_turn
    from tests.test_demo_chat_planner import art, call, final_of, prompt, tools_of

    question = "Investigate the activity of user pnair in the last 3 days"
    rounds: list[list[dict[str, Any]]] = []
    for _ in range(8):
        reply = plan_turn(prompt(question, *rounds))
        if parse_reply(reply).kind == "final":
            header, body = final_of(reply)
            break
        made = []
        for tool, inp in tools_of(reply):
            # The campaign lookup's table, so the answer can show it.
            arts = ([art("a1", "table", {"columns": [], "rows": []}, "Campaigns")] if tool == "list_campaigns"
                    else [])
            made.append(call(tool, obs(tool, inp), artifacts=arts, inp=inp))
        rounds.append(made)
    else:
        raise AssertionError("no final")
    assert asked == [{"entity": "pnair", "limit": 10}], asked
    assert "Campaigns involving it: **2 campaigns**" in body, body[-600:]
    titles = [b.get("title") for b in header["blocks"]]
    assert "Campaigns involving this user" in titles and "All campaigns" not in titles, titles
