"""Round 16 WP15C: metrics, SLA and time-window fixes (SPEC §4.4 WP15C).

One regression per bug, each written to fail before its fix:

* **B26 (with B58).** The SLA response clock stops for a case the agent closed: at
  its close, so an auto-close inside the target is met and one after the target is a
  fixed-size late response that never grows. An acknowledgement stops the clock too.
  The per-case clock rules live in the pure ``metrics.sla_case_reading``.
* **B59.** Operational MTTR uses the first terminal transition over every terminal
  case, so a later comment does not move it.
* **B60.** Standup SLA aging resolves the P-level the same way posture does and stops
  the response clock at the first human response; chat starters agree with Standup.
* **B68.** The breakdown's "more rules" count leaves out rules with no case in the
  window.
* **B39.** The attention queue row and the shift-brief "Needs attention" item carry
  the case's creation time.
* **B02.** An out-of-range relative window answers 200, clamped to the representable
  range, instead of 500.
* **B03.** The chat feedback summary compares instants, not strings, and answers 422
  for a ``since`` it cannot read.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from app.config import Preferences, SlaPolicy
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface
from app.engine import metrics as M
from app.engine import shift_report
from app.models import Case, ChatFeedbackRequest, Entity, StatusHistoryEntry

UTC = timezone.utc
NOW = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)
CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "webui" / "src" / "lib" / "explain" / "explain.contract.json")
    .read_text(encoding="utf-8")
)


def _case(
    cid: str = "c1",
    *,
    created: datetime,
    status: CaseStatus = CaseStatus.OPEN,
    priority: str | None = "P4",
    history: list[tuple[str, str, datetime]] | None = None,
    acknowledged: datetime | None = None,
    updated: datetime | None = None,
    risk: float = 10.0,
    decision_by: DecisionBy | None = None,
) -> Case:
    return Case(
        case_id=cid, case_number=f"CASE-{cid}", cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="10.0.0.1"), title=f"Case {cid}",
        created_at=created.isoformat(), updated_at=(updated or created).isoformat(),
        status=status, priority_level=priority, risk_score=risk, decision_by=decision_by,
        acknowledged_at=acknowledged,
        status_history=[
            StatusHistoryEntry(from_status="new", to_status=to, by=by, at=at.isoformat())
            for to, by, at in (history or [])
        ],
    )


def _breaches(out: dict[str, Any], clock: str) -> list[dict[str, Any]]:
    return [b for b in out["breaching"] if b["clock"] == clock]


# --------------------------------------------------------------------------- #
# B26 (with B58): the response clock of a case the agent closed
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("hours_later", [9, 48, 24 * 30])
def test_an_agent_auto_close_inside_the_target_never_becomes_a_breach(hours_later: int) -> None:
    created = NOW - timedelta(hours=hours_later)
    case = _case(created=created, status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
                 history=[("closed", "agent", created + timedelta(seconds=30))])
    out = M.sla_metrics([case], SlaPolicy(), now=NOW)
    assert out["response_breached"] == 0 and out["response_at_risk"] == 0
    assert out["resolve_breached"] == 0
    assert out["attainment_pct"] == 100.0
    assert out["breaching"] == []


def test_an_auto_close_after_the_target_is_a_fixed_size_late_response() -> None:
    created = NOW - timedelta(hours=20)
    closed = created + timedelta(hours=10)  # P4 response target is 480 minutes
    case = _case(created=created, status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
                 history=[("closed", "agent", closed)])
    for now in (NOW, NOW + timedelta(days=2), NOW + timedelta(days=60)):
        out = M.sla_metrics([case], SlaPolicy(), now=now)
        assert out["response_breached"] == 1
        (row,) = _breaches(out, "response")
        assert row["state"] == "breached"
        assert row["elapsed_minutes"] == 600.0  # stops at the close, never grows
        assert out["attainment_pct"] == 0.0


def test_a_person_touching_an_auto_closed_case_later_does_not_make_it_late() -> None:
    created = NOW - timedelta(hours=30)
    case = _case(created=created, status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
                 history=[("closed", "agent", created + timedelta(seconds=30)),
                          ("closed", "alice", created + timedelta(hours=20))])
    out = M.sla_metrics([case], SlaPolicy(), now=NOW)
    assert out["response_breached"] == 0 and out["attainment_pct"] == 100.0
    reading = M.sla_case_reading(case, SlaPolicy().targets["P4"], M._CaseTimings(case), now=NOW)
    assert reading.response is not None and reading.response.stop_source == "terminal"
    assert reading.response.elapsed_minutes == 0.5


def test_an_acknowledgement_without_a_status_move_stops_the_response_clock() -> None:
    created = NOW - timedelta(hours=9)
    case = _case(created=created, status=CaseStatus.INVESTIGATING,
                 history=[("investigating", "system", created)],
                 acknowledged=created + timedelta(minutes=22))
    out = M.sla_metrics([case], SlaPolicy(), now=NOW)
    assert out["response_breached"] == 0 and out["response_at_risk"] == 0
    reading = M.sla_case_reading(case, SlaPolicy().targets["P4"], M._CaseTimings(case), now=NOW)
    assert reading.response is not None
    assert reading.response.stop_source == "acknowledged_at"
    assert reading.response.elapsed_minutes == 22.0 and not reading.response.running


def test_a_system_escalation_at_creation_is_not_a_response() -> None:
    created = NOW - timedelta(hours=9)
    case = _case(created=created, status=CaseStatus.ESCALATED, history=[("escalated", "system", created)])
    out = M.sla_metrics([case], SlaPolicy(), now=NOW)
    assert out["response_breached"] == 1
    (row,) = _breaches(out, "response")
    assert row["elapsed_minutes"] == 540.0


def test_a_reopened_case_runs_its_resolution_clock_again() -> None:
    created = NOW - timedelta(hours=80)  # P4 resolution target is 4,320 minutes (72 h)
    case = _case(created=created, status=CaseStatus.OPEN,
                 history=[("closed", "alice", created + timedelta(hours=1)),
                          ("open", "alice", created + timedelta(hours=2))])
    out = M.sla_metrics([case], SlaPolicy(), now=NOW)
    assert out["resolve_breached"] == 1
    (row,) = _breaches(out, "resolution")
    assert row["elapsed_minutes"] == 4800.0  # live, not stopped at the stale close


def test_the_first_human_response_wins_whichever_anchor_records_it() -> None:
    created = NOW - timedelta(hours=9)
    case = _case(created=created, status=CaseStatus.ESCALATED,
                 history=[("escalated", "alice", created + timedelta(minutes=10))],
                 acknowledged=created + timedelta(minutes=30))
    reading = M.sla_case_reading(case, SlaPolicy().targets["P4"], M._CaseTimings(case), now=NOW)
    assert reading.response is not None
    assert reading.response.stop_source == "status_history"
    assert reading.response.elapsed_minutes == 10.0


def test_the_case_reading_is_pure_and_names_every_clock() -> None:
    created = NOW - timedelta(minutes=12)
    case = _case(created=created, priority="P1")
    target = SlaPolicy().targets["P1"]
    before = case.model_dump(mode="json")
    reading = M.sla_case_reading(case, target, M._CaseTimings(case), now=NOW)
    assert case.model_dump(mode="json") == before
    assert reading.start == created and reading.start_source == "created_at" and not reading.terminal
    assert reading.response is not None and reading.resolution is not None
    assert reading.response.clock == "response" and reading.response.running
    assert reading.response.state == "at_risk" and reading.response.target_minutes == 15.0
    assert reading.response.due_at == created + timedelta(minutes=15)
    assert reading.resolution.clock == "resolution" and reading.resolution.state == "ok"
    assert reading.as_dict()["response"]["state"] == "at_risk"


def test_a_terminal_case_with_no_readable_instant_never_runs_a_live_clock() -> None:
    created = NOW - timedelta(hours=9)
    case = _case(created=created, status=CaseStatus.CLOSED)
    case.updated_at = "not a timestamp"
    reading = M.sla_case_reading(case, SlaPolicy().targets["P4"], M._CaseTimings(case), now=NOW)
    assert reading.terminal and reading.response is None and reading.resolution is None
    out = M.sla_metrics([case], SlaPolicy(), now=NOW)
    assert out["evaluated"] == 1 and out["breaching"] == [] and out["attainment_pct"] == 100.0


@pytest.mark.parametrize("target", [10**10, 10**13])
def test_a_target_past_the_last_representable_instant_is_never_due(target: int) -> None:
    # SlaTarget has no upper bound, so an operator can type a very large target. The
    # case reading must not raise on its due instant: posture would answer 500.
    from app.config import SlaTarget

    policy = SlaPolicy(targets={"P4": SlaTarget(response_minutes=target, resolve_minutes=target)})
    created = NOW - timedelta(hours=1)
    cases = [
        _case("open", created=created),
        _case("closed", created=created, status=CaseStatus.CLOSED,
              history=[("closed", "agent", created + timedelta(minutes=5))]),
    ]
    out = M.sla_metrics(cases, policy, now=NOW)
    assert out["evaluated"] == 2 and out["breaching"] == [] and out["attainment_pct"] == 100.0
    reading = M.sla_case_reading(cases[0], policy.targets["P4"], M._CaseTimings(cases[0]), now=NOW)
    assert reading.response is not None and reading.response.state == "ok"
    assert reading.response.due_at == datetime.max.replace(tzinfo=UTC)
    assert reading.as_dict()["response"]["due_at"] == datetime.max.replace(tzinfo=UTC).isoformat()


@pytest.mark.parametrize(
    "vector", CONTRACT["sla"]["vectors"],
    ids=lambda v: f"{v['elapsed_minutes']}m-{'responded' if v['responded'] else 'open'}",
)
def test_the_contract_sla_vectors_agree_with_the_case_reading(vector: dict[str, Any]) -> None:
    created = NOW - timedelta(minutes=vector["elapsed_minutes"])
    case = _case(created=created, priority=vector["priority"])
    if vector["responded"]:
        case.first_response_at = NOW
    target = SlaPolicy().targets[vector["priority"]]
    reading = M.sla_case_reading(case, target, M._CaseTimings(case), now=NOW)
    assert reading.response is not None and reading.response.state == vector["state"]
    assert M.SLA_AT_RISK_FRACTION == CONTRACT["sla"]["at_risk_fraction"]


def test_sla_metrics_counts_exactly_what_the_case_readings_say() -> None:
    policy = SlaPolicy()
    grid: list[Case] = []
    for i, minutes in enumerate((5, 13, 20, 100, 125, 300, 470, 500, 4000, 5000)):
        for status in (CaseStatus.OPEN, CaseStatus.CLOSED, CaseStatus.INVESTIGATING):
            created = NOW - timedelta(minutes=minutes)
            history = []
            if status is CaseStatus.CLOSED:
                history = [("closed", "agent", created + timedelta(minutes=minutes // 2))]
            if status is CaseStatus.INVESTIGATING:
                history = [("investigating", "bob", created + timedelta(minutes=minutes // 3))]
            grid.append(_case(f"g{i}-{status.value}", created=created, status=status,
                              priority=("P1", "P2", "P3", "P4")[i % 4], history=history))
    out = M.sla_metrics(grid, policy, now=NOW)
    expected = {"response": {"breached": 0, "at_risk": 0}, "resolution": {"breached": 0, "at_risk": 0}}
    breached_ids: set[str] = set()
    for case in grid:
        reading = M.sla_case_reading(case, policy.targets[case.priority_level], M._CaseTimings(case), now=NOW)
        for clock in (reading.response, reading.resolution):
            if clock is not None and clock.state in ("breached", "at_risk"):
                expected[clock.clock][clock.state] += 1
                if clock.state == "breached":
                    breached_ids.add(case.case_id)
    assert out["response_breached"] == expected["response"]["breached"]
    assert out["response_at_risk"] == expected["response"]["at_risk"]
    assert out["resolve_breached"] == expected["resolution"]["breached"]
    assert out["resolve_at_risk"] == expected["resolution"]["at_risk"]
    assert out["attainment_pct"] == round(100.0 * (len(grid) - len(breached_ids)) / len(grid), 1)


# --------------------------------------------------------------------------- #
# B59: Operational MTTR uses the first terminal transition
# --------------------------------------------------------------------------- #
def test_operational_mttr_is_not_moved_by_a_later_edit() -> None:
    created = NOW - timedelta(days=10)
    closed = _case("closed", created=created, status=CaseStatus.CLOSED,
                   history=[("closed", "alice", created + timedelta(minutes=10))],
                   updated=NOW)  # a comment days later bumped updated_at
    out = M.compute_metrics([closed])
    assert out["mttr_minutes"] == 10.0 and out["resolved_count"] == 1


def test_operational_mttr_counts_resolved_cases_and_matches_the_lifecycle_mean() -> None:
    created = NOW - timedelta(days=10)
    cases = [
        _case("closed", created=created, status=CaseStatus.CLOSED,
              history=[("closed", "alice", created + timedelta(minutes=10))], updated=NOW),
        _case("resolved", created=created, status=CaseStatus.RESOLVED,
              history=[("resolved", "bob", created + timedelta(minutes=30))], updated=NOW),
        # Closed, then reopened: not resolved now, so not in MTTR.
        _case("reopened", created=created, status=CaseStatus.OPEN,
              history=[("closed", "bob", created + timedelta(minutes=5)),
                       ("open", "bob", created + timedelta(minutes=50))]),
    ]
    out = M.compute_metrics(cases)
    assert out["resolved_count"] == 2 and out["mttr_minutes"] == 20.0
    lifecycle = M.lifecycle_intervals(cases)["mttr_minutes"]
    assert lifecycle["count"] == out["resolved_count"] and lifecycle["mean"] == out["mttr_minutes"]


# --------------------------------------------------------------------------- #
# B60: Standup SLA aging resolves the level and stops at the first response
# --------------------------------------------------------------------------- #
def test_standup_sla_aging_uses_the_projected_level() -> None:
    prefs = Preferences()
    created = NOW - timedelta(hours=3)
    case = _case(created=created, priority=None, risk=10.0)  # projects to P4 (480 minutes)
    aging = shift_report.sla_aging([case], prefs.sla, now=NOW, prefs=prefs)
    assert aging["totals"]["breached"] == 0
    assert set(aging["by_priority"]) == {"P4"}
    posture = M.sla_metrics([case], prefs.sla, now=NOW, prefs=prefs)
    assert posture["response_breached"] == aging["totals"]["breached"] == 0


def test_the_standup_brief_threads_prefs_to_its_sla_counts() -> None:
    prefs = Preferences()
    case = _case(created=NOW - timedelta(hours=3), priority=None, risk=10.0)
    report = shift_report.build_shift_report([case], sla=prefs.sla, now=NOW, prefs=prefs)
    assert report["headline_counts"]["sla_breached"] == 0
    assert report["sla_aging"]["totals"]["breached"] == 0
    assert "unprioritized" not in report["sla_aging"]["by_priority"]


def test_an_acknowledged_case_is_not_a_response_breach() -> None:
    sla = SlaPolicy()
    created = NOW - timedelta(hours=3)
    on_time = _case("on-time", created=created, status=CaseStatus.INVESTIGATING, priority="P3",
                    history=[("investigating", "system", created)],
                    acknowledged=created + timedelta(minutes=10))
    late = _case("late", created=created, status=CaseStatus.INVESTIGATING, priority="P3",
                 history=[("investigating", "alice", created + timedelta(minutes=150))])
    aging = shift_report.sla_aging([on_time, late], sla, now=NOW)
    assert aging["totals"]["breached"] == 1 and aging["totals"]["about_to_breach"] == 0
    (row,) = aging["breached"]
    assert row["case_id"] == "late" and row["overdue_minutes"] == 30.0
    # Two hours later the late response is still 30 minutes late, not more.
    later = shift_report.sla_aging([on_time, late], sla, now=NOW + timedelta(hours=2))
    assert [r["overdue_minutes"] for r in later["breached"]] == [30.0]
    posture = M.sla_metrics([on_time, late], sla, now=NOW)
    assert posture["response_breached"] == aging["totals"]["breached"]


def test_without_prefs_sla_aging_keeps_its_earlier_buckets() -> None:
    sla = SlaPolicy()
    case = _case(created=NOW - timedelta(hours=3), priority=None)
    aging = shift_report.sla_aging([case], sla, now=NOW)
    assert set(aging["by_priority"]) == {"unprioritized"}
    # No level means no target: the case is counted open, never as a breach of an
    # invented 120-minute target (Round 16 numbers review, standup-sla-rules-diverge).
    assert aging["totals"]["breached"] == 0 and aging["breached"] == []


# The chat starter "past target" counts and the Standup count, on one population.
def _request(state: Any) -> Request:
    app = FastAPI()
    app.state.tlsoc = state
    return Request({"type": "http", "method": "GET", "path": "/api/chat/starters", "headers": [],
                    "query_string": b"", "app": app, "client": ("127.0.0.1", 9)})


@pytest.fixture
def as_alice(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.engine import chat_starters as cs

    monkeypatch.setattr(cs, "_caller", lambda request: ("alice", "analyst_tier1", True))


async def test_the_starter_past_target_counts_agree_with_standup(app_state, as_alice) -> None:
    from app.agents.chat_tools.cases import ShiftReportTool
    from app.engine.chat_starters import StarterUserState, build_starters

    now = datetime.now(UTC)
    # Three hours old: past a 120-minute default, inside the projected P4 target.
    quiet = _case("quiet", created=now - timedelta(hours=3), priority=None, risk=10.0)
    quiet.assignee = "alice"
    await app_state.cases.save(quiet)
    info = await build_starters(app_state, _request(app_state), surface="home", now=now,
                                user_state=StarterUserState())
    ids = [s.id for s in info.starters]
    assert "sla" not in ids
    mine = next(s for s in info.starters if s.id == "my_cases")
    assert mine.urgency == "none"  # no case of alice's is past its target
    ctx = await app_state.build_chat_tool_context(_request(app_state), None)
    out = await ShiftReportTool().run(ctx, attention_limit=25)
    assert out.ok and out.observation["sla"]["totals"]["breached"] == 0
    # A case past its projected target is counted the same way by all three.
    late = _case("late", created=now - timedelta(hours=9), priority=None, risk=10.0)
    late.assignee = "alice"
    await app_state.cases.save(late)
    info = await build_starters(app_state, _request(app_state), surface="home", now=now,
                                user_state=StarterUserState())
    card = next(s for s in info.starters if s.id == "sla")
    assert card.template == "sla_breached_one"
    assert next(s for s in info.starters if s.id == "my_cases").urgency == "attention"
    out = await ShiftReportTool().run(ctx, attention_limit=25)
    assert out.observation["sla"]["totals"]["breached"] == 1
    posture = M.sla_metrics([quiet, late], app_state.prefs.sla, now=now, prefs=app_state.prefs)
    assert posture["response_breached"] == 1


# --------------------------------------------------------------------------- #
# B39: the attention row and the shift-brief item carry the creation time
# --------------------------------------------------------------------------- #
def test_the_attention_queue_row_carries_created_at() -> None:
    created = NOW - timedelta(hours=2)
    (row,) = shift_report.attention_queue([_case(created=created)], now=NOW)
    assert row["created_at"] == created.isoformat()


def test_the_people_facing_shift_report_carries_created_at_and_the_model_aggregate_does_not() -> None:
    created = NOW - timedelta(hours=2)
    case = _case(created=created)
    shown = shift_report.build_shift_report([case], now=NOW, needs_human_verdict=True)
    assert shown["attention_queue"][0]["created_at"] == created.isoformat()
    # The standup model's aggregate keeps its size (the fence bound): no new key.
    folded = shift_report.build_shift_report([case], now=NOW)
    assert "created_at" not in folded["attention_queue"][0]


async def test_the_standup_report_route_rows_carry_created_at(app_state) -> None:
    created = datetime.now(UTC) - timedelta(hours=2)
    await app_state.cases.save(_case("report", created=created))
    snapshot = await app_state.standup_service.shift_snapshot(
        app_state.prefs, window_hours=24, needs_human_verdict=True,
    )
    assert snapshot["attention_queue"][0]["created_at"] == created.isoformat()


async def test_the_shift_brief_needs_attention_items_carry_created_at(app_state) -> None:
    from app.agents.chat_tools.cases import ShiftReportTool

    created = datetime.now(UTC) - timedelta(hours=2)
    await app_state.cases.save(_case("brief", created=created))
    ctx = await app_state.build_chat_tool_context(_request(app_state), None)
    out = await ShiftReportTool().run(ctx, attention_limit=25)
    assert out.ok
    (listing,) = [a for a in out.artifacts if a.kind == "case_list"]
    (item,) = listing.data["items"]
    assert item["created_at"] == created.isoformat()


# --------------------------------------------------------------------------- #
# B68: the breakdown's "more rules" counts only rules with cases in the window
# --------------------------------------------------------------------------- #
async def test_more_rules_leaves_out_rules_with_no_case_in_the_window(app_state) -> None:
    from app.api.deps import require_auth
    from app.api.routes_metrics import invalidate_breakdown_cache
    from app.api.routes_metrics import router as metrics_router
    from fastapi import Depends

    invalidate_breakdown_cache()
    now = datetime.now(UTC)
    for cid, rule, hours in (("a1", "r-a", 2), ("a2", "r-a", 3), ("b1", "r-b", 4), ("c1", "r-c", 5),
                             ("old", "r-old", 40 * 24)):
        case = _case(cid, created=now - timedelta(hours=hours))
        case.rule_ids = [rule]
        await app_state.cases.save(case)
    api = FastAPI()
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    api.state.tlsoc = app_state
    async with AsyncClient(transport=ASGITransport(app=api), base_url="http://test") as client:
        response = await client.get("/api/metrics/breakdown",
                                    params={"by": "rule", "window": "now-7d", "top": 1})
    invalidate_breakdown_cache()
    assert response.status_code == 200, response.text
    body = response.json()
    assert [g["key"] for g in body["groups"]] == ["r-a"]
    # r-b and r-c hold the 2 other window cases; r-old has only an older open case.
    assert body["other"]["count"] == 2 and body["other"]["groups"] == 2


async def test_the_aggregate_reports_how_many_trimmed_groups_hold_window_cases(sql_repo) -> None:
    from app.engine.case_aggregate import CaseAggregateSpec, aggregate_cases
    from app.engine.time_windows import resolve_window
    from app.es.fake import InMemoryESClient
    from app.stores.cases import CaseStore

    now = datetime.now(UTC)
    for repo in (CaseStore(InMemoryESClient()), sql_repo):
        for cid, rule, hours in (("a1", "r-a", 2), ("a2", "r-a", 3), ("b1", "r-b", 4), ("c1", "r-c", 5),
                                 ("old", "r-old", 40 * 24)):
            case = _case(cid, created=now - timedelta(hours=hours))
            case.rule_ids = [rule]
            await repo.save(case)
        result = await aggregate_cases(repo, CaseAggregateSpec(
            window=resolve_window("now-7d"), group_by=("rule",), metrics=("count", "open_now"), top_n=1,
        ))
        # Chat's Other row still covers the open-now part (r-old's older open case).
        assert result.other is not None and result.other["groups"] == 3
        assert result.other["groups_counted"] == 2
        assert result.other["metrics"]["count"] == 2 and result.other["metrics"]["open_now"] == 3


# --------------------------------------------------------------------------- #
# B02: an out-of-range relative window is clamped, never a 500
# --------------------------------------------------------------------------- #
def test_the_iso_conversions_clamp_to_the_representable_range() -> None:
    from app.utils import millis_to_iso_utc, relative_to_iso_utc_strict

    low = datetime.min.replace(tzinfo=UTC).isoformat()
    high = datetime.max.replace(tzinfo=UTC).isoformat()
    assert millis_to_iso_utc(-10**18) == low
    assert millis_to_iso_utc(10**18) == high
    assert millis_to_iso_utc(-10**30) == low and millis_to_iso_utc(10**30) == high
    assert relative_to_iso_utc_strict("now-999999d", now=NOW) == low
    assert relative_to_iso_utc_strict("now-9999999d", now=NOW) == low
    assert relative_to_iso_utc_strict("now+99999999d", now=NOW) == high
    # In range, the spelling is unchanged.
    assert millis_to_iso_utc(0) == "1970-01-01T00:00:00+00:00"
    assert relative_to_iso_utc_strict("now-1d", now=NOW) == (NOW - timedelta(days=1)).isoformat()


def test_the_route_conversion_clamps_too() -> None:
    from app.api.routes import _millis_to_iso

    assert _millis_to_iso(-10**18) == datetime.min.replace(tzinfo=UTC).isoformat()
    assert _millis_to_iso(10**18) == datetime.max.replace(tzinfo=UTC).isoformat()
    assert _millis_to_iso(0) == "1970-01-01T00:00:00+00:00"


@pytest.mark.parametrize(
    "params, total",
    [({"from": "now-999999d"}, 1), ({"to": "now-9999999d"}, 0), ({"from": "now+99999999d"}, 0),
     ({"from": "now-999999d", "sort_field": "created_at"}, 1)],
)
def test_case_list_answers_an_out_of_range_window(client, params: dict[str, str], total: int) -> None:
    state = client.app.state.tlsoc
    client.portal.call(state.cases.save, _case("w1", created=datetime.now(UTC) - timedelta(hours=1)))
    response = client.get("/api/cases", params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == total and body["window_total_exact"] is True


def test_scan_notifications_answers_an_out_of_range_since(client) -> None:
    response = client.get("/api/scans/notifications", params={"since": "now-9999999d"})
    assert response.status_code == 200, response.text
    assert response.json()["since"] == datetime.min.replace(tzinfo=UTC).isoformat()


@pytest_asyncio.fixture
async def sql_repo():
    from app.stores.sql import SqlCaseRepository, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    yield SqlCaseRepository(engine)
    await engine.dispose()


async def test_both_stores_window_with_a_clamped_bound(sql_repo) -> None:
    from app.es.fake import InMemoryESClient
    from app.stores.cases import CaseStore

    for repo in (CaseStore(InMemoryESClient()), sql_repo):
        await repo.save(_case("w1", created=datetime.now(UTC) - timedelta(hours=1)))
        cases, total, exact = await repo.list_window(created_from="now-999999d", created_to="now+99999999d")
        assert total == 1 and exact is True and [c.case_id for c in cases] == ["w1"]
        _, none, exact = await repo.list_window(created_to="now-9999999d")
        assert none == 0 and exact is True


# --------------------------------------------------------------------------- #
# B03: the chat feedback summary compares instants
# --------------------------------------------------------------------------- #
async def _feedback_store_with(monkeypatch: pytest.MonkeyPatch, stamps: list[str]):
    from app.es.fake import InMemoryESClient
    from app.stores import chat_feedback
    from app.stores.memory import EsKVStore

    store = chat_feedback.ChatFeedbackStore(EsKVStore(InMemoryESClient()))
    for n, stamp in enumerate(stamps):
        monkeypatch.setattr(chat_feedback, "iso_now", lambda stamp=stamp: stamp)
        await store.record("lia", ChatFeedbackRequest(conversation_id="c", message_id=f"m{n}", rating="up"))
    return store


@pytest.mark.parametrize(
    "since, until, expected",
    [
        # 06:30Z: the 10:30Z rating is four hours after it.
        ("2026-11-24T12:00:00+05:30", None, 2),
        # 15:00Z: only the 15:00:00.500Z rating is at or after it.
        ("2026-11-24T10:00:00-05:00", None, 1),
        # A 'Z' instant: '.' sorts before 'Z', so text comparison dropped 10:00:00.5Z.
        ("2026-11-24T10:00:00Z", None, 2),
        ("2026-11-24T10:00:00Z", "2026-11-24T16:00:00+05:30", 1),
        ("2026-11-24", None, 2),
    ],
)
async def test_feedback_breakdown_compares_instants(
    monkeypatch: pytest.MonkeyPatch, since: str, until: str | None, expected: int,
) -> None:
    store = await _feedback_store_with(monkeypatch, [
        "2026-11-24T10:00:00.500000+00:00", "2026-11-24T15:00:00.500000+00:00",
    ])
    assert (await store.breakdown("lia", since=since, until=until))["total"] == expected


@pytest.mark.parametrize(
    "since, expected",
    [
        # Year 1 with a positive offset is before the first representable UTC instant.
        ("0001-01-01T00:00:00+05:30", 2),
        # Year 9999 with a negative offset is after the last one.
        ("9999-12-31T23:59:59-05:00", 0),
    ],
)
async def test_feedback_breakdown_clamps_an_instant_at_the_edge_of_the_range(
    monkeypatch: pytest.MonkeyPatch, since: str, expected: int,
) -> None:
    store = await _feedback_store_with(monkeypatch, [
        "2026-11-24T10:00:00.500000+00:00", "2026-11-24T15:00:00.500000+00:00",
    ])
    assert (await store.breakdown("lia", since=since))["total"] == expected
    assert (await store.breakdown("lia", until=since))["total"] == 2 - expected


async def test_feedback_summary_route_answers_200_at_the_edge_of_the_range(app_state) -> None:
    from app.api.routes_chat_library import router as library_router

    api = FastAPI()
    api.include_router(library_router)
    api.state.tlsoc = app_state
    async with AsyncClient(transport=ASGITransport(app=api), base_url="http://test") as client:
        early = await client.get("/api/chat/feedback/summary", params={"since": "0001-01-01T00:00:00+05:30"})
        late = await client.get("/api/chat/feedback/summary", params={"since": "9999-12-31T23:59:59-05:00"})
    assert early.status_code == 200, early.text
    assert late.status_code == 200, late.text


async def test_feedback_breakdown_refuses_an_unreadable_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    store = await _feedback_store_with(monkeypatch, ["2026-11-24T10:00:00+00:00"])
    with pytest.raises(ValueError):
        await store.breakdown("lia", since="2026-13-45")
    with pytest.raises(ValueError):
        await store.breakdown("lia", until="2026-11-24T99")


async def test_feedback_summary_route_answers_422_for_an_unreadable_since(app_state) -> None:
    from app.api.routes_chat_library import router as library_router

    api = FastAPI()
    api.include_router(library_router)
    api.state.tlsoc = app_state
    async with AsyncClient(transport=ASGITransport(app=api), base_url="http://test") as client:
        bad = await client.get("/api/chat/feedback/summary", params={"since": "2026-13-45T10:00"})
        good = await client.get("/api/chat/feedback/summary", params={"since": "2026-11-24T12:00:00+05:30"})
    assert bad.status_code == 422, bad.text
    assert bad.json()["detail"]["code"] == "invalid_since"
    assert good.status_code == 200 and good.json()["total"] == 0
