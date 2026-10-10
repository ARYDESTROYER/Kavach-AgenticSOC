"""Round 12 WP-TOOLS review fixes: each test pins one reviewer finding.

* ISO ranges resolve in the operator timezone with an INCLUSIVE ``to`` date and a
  humanised label; ``window_hours`` cannot overflow; ``now-6m`` (minutes) is refused
  where a minute window is meaningless; a clamped calendar window steps back by its
  own length.
* Multi-valued groupings (rule, ATT&CK) are never drawn as a partition.
* ``open_now`` is labelled as the window-exempt stock and never compared.
* Comparison figures from partial reads are never labelled exact; a value new in a
  later period is "new", not "not measured".
* The posture automation rate matches the dashboard (analyst-policy closes excluded).
* ``search_cases`` lists real matches beyond the newest-cases page.
* An aggregator input refusal is an input error, never a store outage; a bucket too
  fine for the window is coarsened, never cut.
* Calendar comparisons of a period in progress compare like for like, with one label
  form; tile deltas belong to the window the tile shows.
* Log bucket axes are half-open; weekly series offer no calendar re-bin.
* ``audit_search`` takes any window; the noise funnel counts every case.
* The prompt routes "open cases" to ``status_group: active`` and its clarify example
  is a complete reply.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.agents.blocks import ChartBlock, artifact_views, rebin_options
from app.agents.chat_tools import cases as cases_module
from app.agents.chat_tools import metrics as metrics_module
from app.agents.chat_tools import stats as stats_module
from app.agents.chat_tools.base import Artifact, ToolOutcome, render_tool_signatures
from app.agents.chat_tools.cases import SearchCasesTool
from app.agents.chat_tools.common import AMBIGUOUS_MINUTES, resolve_window
from app.agents.chat_tools.logs import _add_log_comparison, _SourceStats, bucket_axis
from app.agents.chat_tools.metrics import CostUsageTool, SocMetricsTool
from app.agents.chat_tools.ops import AuditSearchInput, AuditSearchTool
from app.agents.chat_tools.periods import comparison_observation, previous_period, resolve_periods
from app.agents.chat_tools.registry import catalogue
from app.agents.chat_tools.stats import CaseStatsTool
from app.agents.prompts import render_chat_agent_system
from app.api.metrics_shared import invalidate_case_page_cache, invalidate_case_population_cache
from app.config import Preferences
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.metrics import quality_metrics
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, TimeRange, UsageDoc
from app.stores.cases import CaseStore
from app.stores.usage import UsageStore

from tests.test_chat_tools_support import RecordingAudit, assert_artifacts_render, make_ctx

NOW = datetime.now(timezone.utc)
FIXED = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)


def _case(i: int, created: datetime, *, status: CaseStatus = CaseStatus.OPEN, verdict: Verdict | None = None,
          rules: list[str] | None = None, decision_by: DecisionBy | None = None) -> Case:
    stamp = created.isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=f"198.51.100.{i}"), status=status, verdict=verdict,
        confidence=0.8, risk_score=10.0 + i, title=f"Case {i}", rule_ids=list(rules or ["r"]),
        created_at=stamp, updated_at=stamp, decision_by=decision_by,
    )


async def _store(cases: list[Case]) -> CaseStore:
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    store = CaseStore(InMemoryESClient())
    for case in cases:
        await store.save(case)
    return store


@pytest.fixture(autouse=True)
def _fresh_caches() -> Any:
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    yield
    invalidate_case_page_cache()
    invalidate_case_population_cache()


def _ctx(**overrides: Any) -> Any:
    return make_ctx(**overrides)


def _kolkata() -> Preferences:
    return Preferences.model_validate({"sla": {"timezone": "Asia/Kolkata"}})


def _art(out: ToolOutcome, kind: str) -> Artifact:
    return next(a for a in out.artifacts if a.kind == kind)


# --------------------------------------------------------------------------- #
# Windows
# --------------------------------------------------------------------------- #
def test_iso_ranges_are_inclusive_local_and_humanised() -> None:
    ctx = _ctx()
    for spec in ({"from": "2026-10-07", "to": "2026-10-10"}, "2026-10-07..2026-10-10"):
        window = resolve_window(ctx, window=spec, now=FIXED)
        assert window.start == datetime(2026, 10, 7, tzinfo=timezone.utc)
        assert window.end == datetime(2026, 10, 11, tzinfo=timezone.utc)      # the to date is included
        assert window.label == "7 Oct – 10 Oct 2026"
    bounds = resolve_window(ctx, time_from="2026-10-07", time_to="2026-10-10", now=FIXED)
    assert bounds.end == datetime(2026, 10, 11, tzinfo=timezone.utc)
    since = resolve_window(ctx, window={"from": "2026-03-01"}, now=FIXED)
    assert since.label == "since 1 Mar 2026" and since.trailing
    # The operator timezone cuts dates exactly like a calendar month.
    kolkata = _ctx(prefs=_kolkata())
    august = resolve_window(kolkata, window={"from": "2026-08-01", "to": "2026-08-31"}, now=FIXED)
    month = resolve_window(kolkata, window="2026-08", now=FIXED)
    assert august.start == month.start == datetime(2026, 7, 31, 18, 30, tzinfo=timezone.utc)
    assert august.end == month.end == datetime(2026, 8, 31, 18, 30, tzinfo=timezone.utc)
    assert august.label == "1 Aug – 31 Aug 2026 (Asia/Kolkata)"
    # Relative bounds keep the classic grammar and label.
    assert resolve_window(ctx, window={"from": "now-7d", "to": "now"}, now=FIXED).label == "last 7 days"
    empty = resolve_window(ctx, window={"from": "2026-10-10", "to": "2026-10-01"}, now=FIXED)
    assert empty == "Invalid time window: the start must be before the end"


async def test_case_stats_to_today_counts_todays_cases() -> None:
    midnight = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    today = midnight + (NOW - midnight) / 2
    store = await _store([_case(1, today), _case(2, NOW - timedelta(days=2))])
    window = {"from": (NOW - timedelta(days=3)).date().isoformat(), "to": NOW.date().isoformat()}
    out = await CaseStatsTool().run(_ctx(cases=store), window=window)
    assert out.ok and out.observation["total"] == 2
    assert "→" not in out.observation["window"] and "UTC" not in out.observation["window"]


def test_window_hours_overflow_is_all_time_and_minutes_are_refused_where_meaningless() -> None:
    ctx = _ctx()
    huge = resolve_window(ctx, window_hours=99_999_999, now=FIXED)
    assert huge.all_time and huge.label == "all time"
    assert resolve_window(ctx, window="now-99999d", now=FIXED).all_time
    assert resolve_window(ctx, window="now-6m", now=FIXED).label == "last 6 minutes"     # logs keep minutes
    for spec in ("now-6m", "6m", {"from": "now-6m"}, "now-1m"):
        assert resolve_window(ctx, window=spec, now=FIXED, minutes_ok=False) == AMBIGUOUS_MINUTES
    assert resolve_window(ctx, window="now-6M", now=FIXED, minutes_ok=False).label == "last 6 months"
    assert resolve_window(ctx, window="now-30min", now=FIXED, minutes_ok=False).label == "last 30 minutes"


async def test_aggregate_tools_refuse_minutes_and_survive_huge_hour_counts() -> None:
    store = await _store([_case(1, NOW - timedelta(days=1))])
    ctx = _ctx(cases=store)
    out = await CaseStatsTool().run(ctx, window="now-6m")
    assert not out.ok and "now-<n>M for months" in out.error
    search = await SearchCasesTool().run(ctx, window="now-6m")
    assert not search.ok and "now-<n>M" in search.error
    posture = await SocMetricsTool().run(ctx, kind="posture", window="now-6m")
    assert not posture.ok and "now-<n>M" in posture.error
    for tool, inp in ((CaseStatsTool(), {"window_hours": 99_999_999}),
                      (SearchCasesTool(), {"window_hours": 999_999_999}),
                      (SocMetricsTool(), {"kind": "posture", "window_hours": 99_999_999})):
        result = await tool.run(ctx, **inp)
        assert result.ok, (tool.name, result.error)
        assert str(result.observation.get("window", "")).startswith("all time")


def test_a_clamped_calendar_window_steps_back_its_own_length() -> None:
    chip = TimeRange.model_validate({"from": "now-7d"})
    ctx = _ctx(time_range=chip)
    window = resolve_window(ctx, window="this_month", now=FIXED)
    assert window.clamped and window.token != "this_month"
    periods = resolve_periods(ctx, window, "previous_period", now=FIXED)
    assert isinstance(periods, list)
    spans = {(p.window.end - p.window.start) for p in periods}
    assert spans == {timedelta(days=7)}                                  # like for like


def test_in_progress_periods_compare_the_same_elapsed_span_with_one_label_form() -> None:
    ctx = _ctx()
    expected = {
        "this_month": (["Sep 2026 to date", "Oct 2026 to date"], datetime(2026, 9, 1), datetime(2026, 9, 10, 12)),
        "this_quarter": (["Q3 2026 to date", "Q4 2026 to date"], datetime(2026, 7, 1), datetime(2026, 7, 10, 12)),
        "this_year": (["2025 to date", "2026 to date"], datetime(2025, 1, 1), datetime(2025, 10, 10, 12)),
        "this_week": (["W40 2026 to date", "W41 2026 to date"], datetime(2026, 9, 28), datetime(2026, 10, 3, 12)),
        "today": (["9 Oct 2026 to 12:00", "10 Oct 2026 to 12:00"], datetime(2026, 10, 9), datetime(2026, 10, 9, 12)),
    }
    for token, (labels, start, end) in expected.items():
        window = resolve_window(ctx, window=token, now=FIXED)
        periods = resolve_periods(ctx, window, "previous_period", now=FIXED)
        assert [p.label for p in periods] == labels, token
        baseline = periods[0].window
        assert (baseline.start, baseline.end) == (start.replace(tzinfo=timezone.utc), end.replace(tzinfo=timezone.utc))
        observation = comparison_observation(periods, [])
        assert observation["in_progress"] == [False, True]
        assert "same elapsed time" in observation["note"]
    # Complete periods keep whole calendar periods and the same short form.
    last = resolve_periods(ctx, resolve_window(ctx, window="last_week", now=FIXED), "previous_period", now=FIXED)
    assert [p.label for p in last] == ["W39 2026", "W40 2026"]
    # An explicit compare against a whole period says the latest one is partial.
    mixed = resolve_periods(ctx, resolve_window(ctx, window="this_month", now=FIXED), ["last_month"], now=FIXED)
    assert "partial period" in comparison_observation(mixed, [])["note"]
    assert previous_period(resolve_window(ctx, window="2026-09", now=FIXED)).label == "Aug 2026"
    # A range "to" today's date is still running, so its change compares a partial span.
    to_today = resolve_window(ctx, window={"from": "2026-10-07", "to": "2026-10-10"}, now=FIXED)
    running = resolve_periods(ctx, to_today, "previous_period", now=FIXED)
    observation = comparison_observation(running, [])
    assert observation["in_progress"] == [False, True] and "partial period" in observation["note"]


# --------------------------------------------------------------------------- #
# case_stats: overlaps, open_now, coarsening, edges, invalid input
# --------------------------------------------------------------------------- #
async def test_multi_valued_groups_are_never_drawn_as_a_partition() -> None:
    store = await _store([
        _case(1, NOW - timedelta(days=1), verdict=Verdict.NEEDS_HUMAN, rules=["a", "b", "c"]),
        _case(2, NOW - timedelta(days=2), verdict=Verdict.NEEDS_HUMAN, rules=["a"]),
    ])
    ctx = _ctx(cases=store)
    two = await CaseStatsTool().run(ctx, group_by=["verdict", "rule"], bucket="month")
    assert two.ok and two.observation["total"] == 2
    series = _art(two, "series")
    assert sum(sum(s["values"]) for s in series.data["series"]) == 2   # never one case per rule
    assert series.total == 2
    one = await CaseStatsTool().run(ctx, group_by=["rule"], bucket="month")
    by_rule = _art(one, "series")
    assert by_rule.data["overlapping"] is True and by_rule.total == 2
    assert "stacked_bar" not in artifact_views(by_rule)
    assert "a case can count under several rules" in (one.coverage or "")
    flat = await CaseStatsTool().run(ctx, group_by=["rule"])
    cats = _art(flat, "categories")
    assert cats.data["overlapping"] is True and "donut" not in artifact_views(cats)
    assert "never present them as shares" in flat.observation["multi_valued"]
    # A partition keeps its total views.
    verdicts = await CaseStatsTool().run(ctx, group_by=["verdict"])
    assert "donut" in artifact_views(_art(verdicts, "categories"))
    assert_artifacts_render(two)
    assert_artifacts_render(flat)


async def test_open_now_is_the_window_exempt_stock_and_is_never_compared() -> None:
    recent = [_case(i, NOW - timedelta(days=i)) for i in (1, 2)]
    older = [_case(10 + i, NOW - timedelta(days=60 + i)) for i in range(10)]
    store = await _store(recent + older)
    ctx = _ctx(cases=store)
    out = await CaseStatsTool().run(ctx, window="now-30d", metrics=["count", "open_now"])
    assert out.ok and out.observation["total"] == 2 and out.observation["totals"]["open_now"] == 12
    tile = next(i for i in out.artifacts[0].data["items"] if i["key"] == "open_now")
    assert tile["label"] == "Open now (any creation date)" and tile["context"] == "not windowed"
    assert out.observation["open_now_window_exempt"] is True
    assert "not limited to the window" in out.observation["open_now_note"]
    compared = await CaseStatsTool().run(ctx, window="now-30d", metrics=["open_now"], compare="previous_period")
    labels = [r["label"] for r in compared.observation["comparison"]["rows"]]
    assert "Still open" not in labels and "open_now" in compared.observation["comparison"]


async def test_a_bucket_too_fine_is_coarsened_and_a_refusal_is_an_input_error(monkeypatch) -> None:
    store = await _store([_case(1, NOW - timedelta(days=400)), _case(2, NOW - timedelta(days=3))])
    ctx = _ctx(cases=store)
    hourly = await CaseStatsTool().run(ctx, window="all", bucket="hour")
    assert hourly.ok, hourly.error
    assert hourly.observation["bucket"] != "hour" and "hour buckets would give" in hourly.observation["bucket_note"]
    assert len(_art(hourly, "series").data["x"]) <= 200
    daily = await CaseStatsTool().run(ctx, window="now-401d", bucket="day")
    assert daily.ok and daily.observation["bucket"] == "week"
    # "The last 401 days by day" is 401 whole days (the window is aligned to days before
    # the point budget is checked), which is too many points: weeks instead.
    assert "day buckets would give 401 points" in daily.observation["bucket_note"]
    trends = await SocMetricsTool().run(ctx, kind="trends", window="all", bucket="hour")
    assert trends.ok and "case_store_unavailable" not in trends.observation
    timing = await SocMetricsTool().run(ctx, kind="timing", window="all", bucket="hour")
    assert timing.ok and timing.observation["bucket"] != "hour"

    async def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise ValueError("9601 hour buckets is too many for all time; use week buckets")

    monkeypatch.setattr(stats_module, "run_case_aggregate", refuse)
    out = await CaseStatsTool().run(ctx, window="now-7d")
    assert not out.ok and out.error == "Invalid input: 9601 hour buckets is too many for all time; use week buckets"
    monkeypatch.setattr(metrics_module, "run_case_aggregate", refuse)
    posture = await SocMetricsTool().run(ctx, kind="posture", window="now-7d")
    assert not posture.ok and posture.error.startswith("Invalid input:")
    assert "case_store_unavailable" not in (posture.observation or {})


async def test_a_cut_first_bucket_is_labelled_partial() -> None:
    store = await _store([_case(1, NOW - timedelta(days=80)), _case(2, NOW - timedelta(days=5))])
    out = await CaseStatsTool().run(_ctx(cases=store), window="now-90d", bucket="month")
    assert out.ok
    first = out.observation["buckets"][0]
    assert first["partial"].startswith("from ")
    assert "do not compare those buckets with whole periods" in out.observation["partial_buckets"]
    labels = _art(out, "series").data["x_labels"]
    assert re.search(r"\(from \d{1,2} [A-Z][a-z]{2}\)$", labels[0]) and "(" not in labels[1]
    table_rows = next(a for a in out.artifacts if a.kind == "table").data["rows"]
    assert table_rows[0][0] == labels[0] and table_rows[-1][0].endswith("(in progress)")
    whole = await CaseStatsTool().run(_ctx(cases=store), window="last_quarter", bucket="month")
    assert "partial_buckets" not in whole.observation


async def test_user_is_not_an_alias_for_assignee() -> None:
    store = await _store([_case(1, NOW - timedelta(days=1))])
    out = await CaseStatsTool().run(_ctx(cases=store), group_by=["user"])
    assert not out.ok and "group_by takes up to two of" in out.error
    assert (await CaseStatsTool().run(_ctx(cases=store), group_by=["analyst"])).ok


# --------------------------------------------------------------------------- #
# Comparisons are never exact by accident
# --------------------------------------------------------------------------- #
async def test_case_and_metric_comparisons_carry_partial_periods(monkeypatch) -> None:
    store = await _store([_case(1, NOW - timedelta(days=3)), _case(2, NOW - timedelta(days=40))])
    ctx = _ctx(cases=store)
    real = stats_module.run_case_aggregate

    async def flaky(ctx_: Any, window: Any, **kwargs: Any) -> Any:
        result = await real(ctx_, window, **kwargs)
        if window.end < NOW - timedelta(days=20):                        # the baseline period
            result.partial, result.exact = True, False
        return result

    monkeypatch.setattr(stats_module, "run_case_aggregate", flaky)
    out = await CaseStatsTool().run(ctx, window="now-30d", compare="previous_period")
    assert out.ok and out.basis == "exact"                               # the window itself is exact
    assert _art(out, "comparison").basis == "sample"
    assert "partial" in out.observation["comparison"] and "compared period" in (out.coverage or "")
    monkeypatch.setattr(metrics_module, "run_case_aggregate", flaky)
    posture = await SocMetricsTool().run(ctx, kind="posture", window="now-30d", compare="previous_period")
    assert posture.ok and _art(posture, "comparison").basis == "sample"
    assert "partial" in posture.observation["comparison"]


def _stats(name: str, *, status: str = "ok", total: int | None = 0, exact: bool = True,
           values: dict[str, int] | None = None, other: int = 0) -> _SourceStats:
    return _SourceStats(name=name, status=status, exact=exact, total=total,
                        groups={"ip": Counter(values or {})}, other={"ip": other})


def test_log_comparison_drops_failed_periods_and_marks_new_values() -> None:
    ctx = _ctx()
    window = resolve_window(ctx, window="now-7d", now=FIXED)
    periods = resolve_periods(ctx, window, "previous_period", now=FIXED)
    # Source b failed in the baseline: that period's total is not measured.
    outcome = ToolOutcome(ok=True, summary="s", observation={}, basis="exact")
    _add_log_comparison(outcome, window, periods, [
        [_stats("a", total=5, values={"1.1.1.1": 5}), _stats("b", status="error", total=None)],
        [_stats("a", total=5, values={"1.1.1.1": 3}), _stats("b", total=100, values={"9.9.9.9": 100})],
    ], ["ip"])
    events = outcome.observation["comparison"]["events"]["rows"][0]
    assert events["values"] == [None, 105] and events["change"] is None
    assert "not measured for previous 7 days" in outcome.observation["comparison"]["incomplete_periods"]
    assert "previous 7 days" in (outcome.coverage or "")
    assert all(a.basis == "sample" for a in outcome.artifacts if a.kind == "comparison")
    # Both periods complete: a value first seen this period is "new", never "not measured".
    fresh = ToolOutcome(ok=True, summary="s", observation={}, basis="exact")
    _add_log_comparison(fresh, window, periods, [
        [_stats("a", total=5, values={"1.1.1.1": 5})],
        [_stats("a", total=7, values={"1.1.1.1": 3, "9.9.9.9": 4})],
    ], ["ip"])
    rows = {r["label"]: r for r in fresh.observation["comparison"]["top_values"]["rows"]}
    assert rows["9.9.9.9"]["values"] == [0, 4] and rows["9.9.9.9"]["new"] is True
    assert rows["1.1.1.1"]["values"] == [5, 3]
    assert all(a.basis == "exact" for a in fresh.artifacts if a.kind == "comparison")
    # A cut list (a remainder) is not a measured zero.
    cut = ToolOutcome(ok=True, summary="s", observation={}, basis="exact")
    _add_log_comparison(cut, window, periods, [
        [_stats("a", total=9, values={"1.1.1.1": 5}, other=4)],
        [_stats("a", total=7, values={"1.1.1.1": 3, "9.9.9.9": 4})],
    ], ["ip"])
    rows = {r["label"]: r for r in cut.observation["comparison"]["top_values"]["rows"]}
    assert rows["9.9.9.9"]["values"] == [None, 4] and rows["9.9.9.9"]["new"] is False


def test_log_bucket_axis_is_half_open() -> None:
    ctx = _ctx()
    quarter = resolve_window(ctx, window="last_quarter", now=FIXED)
    axis = bucket_axis(quarter, "1M")
    assert [a[:7] for a in axis] == ["2026-07", "2026-08", "2026-09"]
    assert len(bucket_axis(resolve_window(ctx, window="2026-09", now=FIXED), "1d")) == 30
    assert len(bucket_axis(resolve_window(ctx, window="last_year", now=FIXED), "1q")) == 4
    trailing = resolve_window(ctx, window="now-3d", now=FIXED)
    assert bucket_axis(trailing, "1d")[-1].startswith("2026-10-10")    # the bucket holding now stays


# --------------------------------------------------------------------------- #
# soc_metrics posture: dashboard parity and tile deltas
# --------------------------------------------------------------------------- #
async def test_posture_automation_rate_matches_the_dashboard() -> None:
    cases = [
        _case(1, NOW - timedelta(days=1), status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
              decision_by=DecisionBy.AGENT),
        _case(2, NOW - timedelta(days=1), status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST_POLICY),
        _case(3, NOW - timedelta(days=2), status=CaseStatus.CLOSED, decision_by=DecisionBy.ANALYST_POLICY),
    ]
    store = await _store(cases)
    out = await SocMetricsTool().run(_ctx(cases=store), kind="posture", window="now-7d")
    assert out.ok
    quality = out.observation["quality"]
    assert quality["automation_rate"] == quality_metrics(cases)["automation_rate"] == 1.0
    assert quality["terminal_cases"] == 1 and quality["policy_closed_cases"] == 2
    tile = next(i for i in out.artifacts[0].data["items"] if i["key"] == "automation_rate")
    assert tile["value"] == 100.0


async def test_posture_tile_deltas_belong_to_the_window_shown() -> None:
    this_month = NOW.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month = (this_month - timedelta(days=1)).replace(day=1)
    cases = [_case(i, last_month + timedelta(hours=i + 1)) for i in range(3)]
    cases += [_case(10 + i, this_month + (NOW - this_month) * (i + 1) / 9) for i in range(7)]
    store = await _store(cases)
    ctx = _ctx(cases=store)
    out = await SocMetricsTool().run(ctx, kind="posture", window="last_month", compare=["this_month"])
    assert out.ok
    tile = next(i for i in out.artifacts[0].data["items"] if i["key"] == "cases")
    assert tile["value"] == 3 and "delta" not in tile                  # September has no earlier period here
    periods = out.observation["comparison"]["periods"]
    assert periods[0] == last_month.strftime("%b %Y") and periods[1] == f"{this_month:%b %Y} to date"
    assert "subject_window_is_not_latest" in out.observation


# --------------------------------------------------------------------------- #
# cost_usage: today's spend is today's
# --------------------------------------------------------------------------- #
async def test_spend_today_ignores_the_request_range() -> None:
    usage = UsageStore(InMemoryESClient())
    midnight = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    today = midnight + (NOW - midnight) / 2
    for ts, cost in ((today, 0.5), (NOW - timedelta(days=40), 2.0)):
        await usage.write(UsageDoc(ts=ts.isoformat(), surface="chat", role="router", model="gpt-a",
                                   total_tokens=10, cost=cost))
    start = (NOW - timedelta(days=60)).date().isoformat()
    end = (NOW - timedelta(days=20)).date().isoformat()
    chip = TimeRange.model_validate({"from": start, "to": end})
    out = await CostUsageTool().run(_ctx(usage=usage, time_range=chip), window="now-90d")
    assert out.ok, out.error
    assert out.observation["total_cost_usd"] == pytest.approx(2.0)     # the chip narrows the window
    assert out.observation["today_cost_usd"] == pytest.approx(0.5)     # but never today's spend
    tile = next(i for i in out.artifacts[0].data["items"] if i["key"] == "today")
    assert tile["value"] == pytest.approx(0.5) and tile["context"] == "not windowed"


# --------------------------------------------------------------------------- #
# search_cases lists matches beyond the newest-cases page
# --------------------------------------------------------------------------- #
async def test_search_cases_lists_matches_older_than_the_page(monkeypatch) -> None:
    newest = [_case(i, NOW - timedelta(hours=i), status=CaseStatus.NEEDS_HUMAN, verdict=Verdict.NEEDS_HUMAN)
              for i in range(1, 4)]
    older = [_case(10 + i, NOW - timedelta(days=10 + i), verdict=Verdict.TRUE_POSITIVE) for i in range(5)]
    store = await _store(newest + older)
    monkeypatch.setattr(cases_module, "CASE_SCAN_LIMIT", 3)
    ctx = _ctx(cases=store)
    out = await SearchCasesTool().run(ctx, verdict="TRUE_POSITIVE", limit=3)
    assert out.ok and out.observation["count"] == 5 and out.observation["returned"] == 3
    assert [c["case_id"] for c in out.observation["cases"]] == ["case-0010", "case-0011", "case-0012"]
    assert "newest matches" in out.observation["listing"] and out.coverage is None
    risky = await SearchCasesTool().run(ctx, verdict="TRUE_POSITIVE", limit=2, sort_field="risk_score")
    assert [c["case_id"] for c in risky.observation["cases"]] == ["case-0014", "case-0013"]
    assert "highest-risk matches" in risky.observation["listing"]

    import app.engine.case_aggregate as aggregate_module

    real_scan = aggregate_module.scan_cases

    async def broken(store: Any, consume: Any, **kwargs: Any) -> Any:
        if kwargs.get("raw"):                                            # the exact count still runs
            return await real_scan(store, consume, **kwargs)
        raise RuntimeError("scan failed")                                # the listing scan fails

    monkeypatch.setattr(aggregate_module, "scan_cases", broken)
    fallback = await SearchCasesTool().run(ctx, verdict="TRUE_POSITIVE", limit=3)
    assert fallback.ok and fallback.observation["count"] == 5 and fallback.observation["returned"] == 0
    assert fallback.observation["scanned"] == 3
    assert "5 matches are older and not listed" in fallback.observation["listing"]
    assert "not listed" in (fallback.coverage or "")


# --------------------------------------------------------------------------- #
# audit_search, noise funnel
# --------------------------------------------------------------------------- #
class _Audit(RecordingAudit):
    def __init__(self) -> None:
        super().__init__()
        self.reads: list[dict[str, Any]] = []

    async def records(self, **kwargs: Any) -> list[dict[str, Any]]:
        self.reads.append(kwargs)
        return [{"ts": NOW.isoformat(), "action_type": "tool_call", "actor": "agent", "surface": "chat"}]


async def test_audit_search_takes_any_window() -> None:
    assert AuditSearchInput.model_validate({"window": "now-90d"}).window == "now-90d"
    assert AuditSearchInput.model_validate({"window_hours": 2160}).window_hours == 2160
    audit = _Audit()
    out = await AuditSearchTool().run(_ctx(audit=audit), window="last_quarter")
    assert out.ok and re.match(r"Q\d 20\d\d", out.observation["window"])
    long = await AuditSearchTool().run(_ctx(audit=audit), window_hours=2160)
    assert long.ok and long.observation["window"] == "last 90 days"
    assert "window?" in AuditSearchTool.signature


async def test_noise_funnel_counts_every_case_not_the_newest_page(monkeypatch) -> None:
    store = await _store([_case(i, NOW - timedelta(days=i * 30)) for i in range(1, 7)])
    monkeypatch.setattr(cases_module, "CASE_SCAN_LIMIT", 2)
    out = await SocMetricsTool().run(_ctx(cases=store), kind="noise_funnel", window="all")
    assert out.ok and out.basis == "exact"
    stages = {s["key"]: s["total"] for s in out.observation["stages"]}
    assert stages["cases"] == 6
    monkeypatch.setattr(metrics_module, "_POPULATION_LIMIT", 2)
    invalidate_case_population_cache()
    cut = await SocMetricsTool().run(_ctx(cases=store), kind="noise_funnel", window="all")
    assert cut.ok and cut.basis == "sample"
    assert "newest 2 of 6 cases" in cut.summary and "newest 2 of 6" in (cut.coverage or "")


# --------------------------------------------------------------------------- #
# Blocks: re-binning only into buckets a series nests in
# --------------------------------------------------------------------------- #
def test_weekly_series_offer_no_calendar_rebin() -> None:
    weeks = [(FIXED - timedelta(weeks=12 - i)).isoformat() for i in range(13)]
    assert rebin_options("1w", "count", weeks) == []
    days = [(FIXED - timedelta(days=400 - i)).isoformat() for i in range(0, 400, 2)]
    assert rebin_options("1d", "count", days) == ["1w", "1M", "1q", "1y"]
    months = [f"2025-{m:02d}-01T00:00:00+00:00" for m in range(1, 13)]
    assert rebin_options("1M", "count", months) == ["1q"]
    chart = ChartBlock.model_validate({
        "id": "b1", "type": "chart", "kind": "line", "unit": "count",
        "x": {"kind": "time", "values": weeks[:3], "bucket": "1w"},
        "series": [{"key": "s", "label": "Cases", "values": [1, 2, 3]}],
        "allowed_rebin": ["1M", "1q"],
    })
    assert chart.allowed_rebin == []
    daily = ChartBlock.model_validate({
        "id": "b2", "type": "chart", "kind": "line", "unit": "count",
        "x": {"kind": "time", "values": days[:3], "bucket": "1d"},
        "series": [{"key": "s", "label": "Cases", "values": [1, 2, 3]}],
        "allowed_rebin": ["1w", "1M"],
    })
    assert daily.allowed_rebin == ["1w", "1M"]


# --------------------------------------------------------------------------- #
# Prompt: "open cases" routing, a complete clarify example, the report recipe
# --------------------------------------------------------------------------- #
def _prompt() -> str:
    return render_chat_agent_system(render_tool_signatures(catalogue()))


def test_prompt_routes_open_cases_to_the_active_group() -> None:
    system = _prompt()
    assert '"input": {"status": "open"}' not in system
    assert system.count('"input": {"status_group": "active"}') == 2
    assert ("Open or still-open cases: status_group active (new, open, needs_human, investigating, "
            "escalated, on_hold)") in system
    assert "status is one exact lifecycle value" in system
    assert "noise_funnel takes no compare" in system
    assert "the to date is included" in system and "write now-6M for six months" in system


def _clarify_example(system: str) -> str:
    lines = system.splitlines()
    start = next(i for i, line in enumerate(lines) if '"clarify": {"question": "Trend of what?"' in line)
    return "\n".join(line.strip() for line in lines[start:start + 3])


def test_the_clarify_example_is_a_complete_reply() -> None:
    example = _clarify_example(_prompt())
    header, separator, question = example.split("\n")
    assert json.loads(header)["clarify"]["question"] == "Trend of what?"
    assert separator == "---ANSWER---" and question.endswith("?")


async def test_the_prompt_clarify_example_runs_through_the_engine() -> None:
    from tests.test_chat_engine_loop import FakeGateway
    from tests.test_chat_engine_unlimited import make_ctx as engine_ctx
    from tests.test_chat_engine_unlimited import make_engine, run, uprefs

    example = _clarify_example(_prompt())
    prefs = uprefs()
    _, resp, _ = await run(make_engine(FakeGateway([example])), "show me the trend", prefs, engine_ctx(prefs))
    assert resp.clarify is not None and resp.clarify.question == "Trend of what?"
    assert resp.answer == "Which trend do you want: alerts, cases, AI cost or false-positive rate?"
    assert "No answer could be generated" not in resp.answer


async def test_screenshot_open_cases_include_cases_waiting_for_a_human() -> None:
    """"Total cases right now that are open… month wise": status_group active counts the
    NEEDS_HUMAN cases decide() escalates; the narrow status "open" would not."""
    store = await _store([
        _case(1, NOW - timedelta(days=2)),
        _case(2, NOW - timedelta(days=35), status=CaseStatus.NEEDS_HUMAN, verdict=Verdict.NEEDS_HUMAN),
        _case(3, NOW - timedelta(days=36), status=CaseStatus.NEEDS_HUMAN, verdict=Verdict.NEEDS_HUMAN),
        _case(4, NOW - timedelta(days=70), status=CaseStatus.NEEDS_HUMAN, verdict=Verdict.NEEDS_HUMAN),
        _case(5, NOW - timedelta(days=3), status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE),
    ])
    ctx = _ctx(cases=store)
    active = await CaseStatsTool().run(ctx, status_group="active", bucket="month")
    narrow = await CaseStatsTool().run(ctx, status="open", bucket="month")
    assert active.ok and active.observation["total"] == 4
    assert narrow.ok and narrow.observation["total"] == 1
    assert sum(sum(s["values"]) for s in _art(active, "series").data["series"]) == 4
