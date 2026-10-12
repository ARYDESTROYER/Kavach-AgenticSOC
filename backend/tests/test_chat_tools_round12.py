"""Round 12 WP-TOOLS (SPEC §3.3, §3.4, P0-1..P0-8, D10): ``case_stats``, windows of
any length on every aggregate tool, calendar buckets, period comparisons, exact
``search_cases`` counts, zero-match suggestions, unknown inputs refused by name, the
comparison/report block contract and the prompt's routing guidance.

The last section proves the three screenshot questions are answerable with the
lookups the prompt routes them to:

* "Create a report of lifetime performance"
* "Last 90 days or whatever reports you can"
* "The amount of total cases right now that are open, when were they all opened?
  Segregate month wise"
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.agents.blocks import (
    MAX_REPORT_LEAVES,
    REPORT_LAYOUTS,
    REPORT_TEMPLATES,
    SMALL_SAMPLE_N,
    TIME_BUCKETS,
    MaterialiseOptions,
    TurnArtifact,
    artifact_data_from_block,
    artifact_views,
    compare_values,
    format_change_pct,
    materialise_final_blocks,
    parse_final_block_requests,
    rebin_options,
    to_blocks,
    validate_blocks,
)
from app.agents.chat_tools.base import Artifact, render_tool_signatures
from app.agents.chat_tools.common import resolve_window
from app.agents.chat_tools.logs import LogStatsTool
from app.agents.chat_tools.metrics import CostUsageTool, SocMetricsTool
from app.agents.chat_tools.periods import (
    MAX_COMPARE_PERIODS,
    normalise_compare,
    previous_period,
    range_label,
    resolve_periods,
    same_period_last_year,
)
from app.agents.chat_tools.registry import (
    TOOL_ORDER,
    _tool_budget,
    build_toolbox,
    catalogue,
    get_tool,
)
from app.agents.chat_tools.stats import AGGREGATE_TOOL_TIMEOUT_S, CaseStatsInput, CaseStatsTool
from app.agents.chat_tools.cases import SearchCasesInput, SearchCasesTool
from app.agents.prompts import render_chat_agent_system
from app.api.metrics_shared import invalidate_case_page_cache
from app.config import Preferences
from app.connectors.elastic import ElasticConnector
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, TimeRange, UsageDoc
from app.stores.cases import CaseStore
from app.stores.usage import UsageStore
from app.utils import now_utc, to_millis

from tests.conftest import make_log_event
from tests.test_chat_tools_support import (
    RecordingAudit,
    assert_artifacts_render,
    assert_observation_whitelisted,
    make_ctx,
    walk_keys,
)

NOW = datetime.now(timezone.utc)

# (days ago, status, verdict, rule, assignee) — 4 open cases across 4 months, 2 closed.
SEEDS: list[tuple[float, CaseStatus, Verdict | None, str, str]] = [
    (2 / 24, CaseStatus.OPEN, Verdict.NEEDS_HUMAN, "linux_auth", "dana"),
    (40, CaseStatus.OPEN, Verdict.TRUE_POSITIVE, "linux_auth", ""),
    (40.5, CaseStatus.CLOSED, Verdict.FALSE_POSITIVE, "sshd", "dana"),
    (75, CaseStatus.INVESTIGATING, None, "sshd", ""),
    (80, CaseStatus.CLOSED, Verdict.FALSE_POSITIVE, "web_sqli", ""),
    (400, CaseStatus.OPEN, Verdict.FALSE_POSITIVE, "web_sqli", "omar"),
]


def _created(days: float) -> datetime:
    return NOW - timedelta(days=days)


def _case(i: int, days: float, status: CaseStatus, verdict: Verdict | None, rule: str, assignee: str) -> Case:
    created = _created(days).isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=f"203.0.113.{i}"), status=status, verdict=verdict,
        confidence=0.8, risk_score=40.0 + i, title=f"Brute force against web{i}", rule_ids=[rule],
        created_at=created, updated_at=created, assignee=assignee,
        member_event_ids=[f"evt-{i}"], history=[{"secret": "never leaks"}],
    )


@pytest.fixture
async def store() -> CaseStore:
    invalidate_case_page_cache()
    cases = CaseStore(InMemoryESClient())
    for i, seed in enumerate(SEEDS):
        await cases.save(_case(i, *seed))
    yield cases
    invalidate_case_page_cache()


def _month(moment: datetime) -> str:
    return moment.strftime("%b %Y")


def _blocks(artifact: Artifact, view: str | None = None) -> list[dict[str, Any]]:
    made = to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view))
    kept, dropped = validate_blocks(made)
    assert kept and not dropped, (artifact.kind, artifact.title, [d.reason for d in dropped])
    return made


def _artifact(out: Any, kind: str, title: str | None = None) -> Artifact:
    return next(a for a in out.artifacts if a.kind == kind and (title is None or a.title == title))


# --------------------------------------------------------------------------- #
# case_stats
# --------------------------------------------------------------------------- #
async def test_case_stats_buckets_open_cases_by_calendar_month(store: CaseStore) -> None:
    progress: list[tuple[int, Any, str]] = []
    ctx = make_ctx(cases=store, progress=lambda done, total, unit: progress.append((done, total, unit)))
    out = await CaseStatsTool().run(ctx, status_group="active", bucket="month")
    assert out.ok and out.basis == "exact" and out.rows == 4
    obs = out.observation
    assert obs["total"] == 4 and obs["exact"] is True and obs["bucket"] == "month"
    assert obs["window"].startswith("all time") and obs["timezone"] == "UTC"
    assert_observation_whitelisted(out)
    assert not {"case_id", "title", "entity"} & walk_keys(obs)        # aggregates only (#7)
    assert "case-0001" not in str(obs)

    series = _artifact(out, "series")
    data = series.data
    assert data["bucket"] == "1M" and data["tz"] == "UTC" and data["last_in_progress"] is True
    assert len(data["x_labels"]) == len(data["x"]) and data["x_labels"][-1] == _month(NOW)
    by_label = dict(zip(data["x_labels"], data["series"][0]["values"]))
    expected = Counter(_month(_created(days)) for days, status, *_ in SEEDS
                       if status in (CaseStatus.OPEN, CaseStatus.INVESTIGATING))
    assert {k: v for k, v in by_label.items() if v} == dict(expected)
    assert sum(by_label.values()) == 4                                  # zero-filled, nothing lost
    assert series.window.startswith("4 cases · exact · all time")      # the honest caption
    table = _artifact(out, "table")
    assert table.data["rows"][-1][0] == f"{_month(NOW)} (in progress)"
    assert_artifacts_render(out)
    chart = _blocks(series)[0]
    assert chart["x"]["labels"] == data["x_labels"] and chart["x"]["tz"] == "UTC"
    assert chart["allowed_rebin"] == ["1q", "1y"]                      # a complete count series
    assert progress and progress[-1][2] == "cases"


async def test_case_stats_group_by_month_is_the_creation_bucket(store: CaseStore) -> None:
    """A model asking group_by ["month"] gets the bucket, not a refusal."""
    args = CaseStatsInput.model_validate({"group_by": ["verdict", "month"]})
    assert args.split_buckets() == (["verdict"], "month", [])
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by=["verdict", "month"])
    assert out.ok and out.observation["bucket"] == "month" and out.observation["group_by"] == ["verdict"]
    series = _artifact(out, "series")
    assert {s["label"] for s in series.data["series"]} == {"Needs human", "True positive", "False positive",
                                                           "No verdict"}
    assert_artifacts_render(out)


async def test_case_stats_breakdowns_rates_and_other(store: CaseStore) -> None:
    ctx = make_ctx(cases=store)
    out = await CaseStatsTool().run(ctx, group_by="rule", metrics=["fp_rate", "mean_risk"], top_n=2)
    assert out.ok and out.observation["total"] == 6
    groups = out.observation["groups"]
    assert len(groups) == 2 and out.observation["other"]["metrics"]["count"] == 2
    totals = out.observation["totals"]
    assert totals["fp_rate"] == pytest.approx(60.0)                    # 3 of 5 verdicted, in percent
    cats = _artifact(out, "categories")
    assert cats.untrusted_labels is True                                # rule names are log-derived (#9)
    assert cats.data["other"] == 2 and cats.truncated
    assert out.artifacts[0].data["items"][1]["unit"] == "percent"
    assert_artifacts_render(out)


async def test_case_stats_refuses_bad_and_unknown_inputs_by_name(store: CaseStore) -> None:
    ctx = make_ctx(cases=store)
    bad = await CaseStatsTool().run(ctx, group_by=["password"])
    assert not bad.ok and "group_by takes up to two of" in bad.error
    three = await CaseStatsTool().run(ctx, group_by=["verdict", "status", "rule"])
    assert not three.ok and "at most" in three.error
    unknown = await CaseStatsTool().run(ctx, group_by="verdict", colour="red")
    assert not unknown.ok and unknown.summary.startswith("Invalid input: unknown input names")
    assert unknown.error.startswith("Invalid input: colour is not an input of this lookup.")
    assert "Accepted inputs:" in unknown.error and "group_by" in unknown.error
    both = await CaseStatsTool().run(ctx, status="open", status_group="active")
    assert not both.ok
    window = await CaseStatsTool().run(ctx, window="the dawn of time")
    assert not window.ok and "Invalid time window" in window.error


async def test_unknown_inputs_are_refused_through_the_toolbox_and_audited(store: CaseStore) -> None:
    audit = RecordingAudit()
    ctx = make_ctx(cases=store, audit=audit)
    toolbox = build_toolbox(ctx)
    for name, inp in (("case_stats", {"bucket": "month", "since": "2025"}),
                      ("search_cases", {"status_group": "active", "source.ip": "1.2.3.4"}),
                      ("soc_metrics", {"kind": "posture", "days": 90}),
                      ("cost_usage", {"window": "all", "per": "model"}),
                      ("case_stats", {"bucket": "month", "ctx": "x"})):
        out = await toolbox.execute(name, inp, turn_id="t", step=1)
        assert out.status == "error" and "Accepted inputs:" in (out.error or ""), (name, out.error)
        assert "not an input" in out.error or "unknown input names" in out.error
    assert len(audit.calls) == 5                                         # every refusal is audited


async def test_case_stats_zero_matches_suggest_valid_calls(store: CaseStore) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store), rule="no-such-rule", window="now-7d")
    assert out.ok and out.observation["total"] == 0
    suggestions = out.observation["suggestions"]
    assert suggestions and all(s["tool"] == "case_stats" for s in suggestions)
    for suggestion in suggestions:
        CaseStatsInput.model_validate(suggestion["input"])              # a VALID call
    assert any(s["input"].get("window") == "all" for s in suggestions)
    assert any("rule" not in s["input"] for s in suggestions)


async def test_case_stats_partial_result_is_never_a_total(store: CaseStore, monkeypatch) -> None:
    from app.agents.chat_tools import stats as stats_module
    from app.engine.case_aggregate import AggregateResult

    async def partial(*_args: Any, **_kwargs: Any) -> AggregateResult:
        return AggregateResult(total=120, groups=[], buckets=[], exact=False, consistency="unknown",
                               scanned=120, missing_created=0, other=None, totals={"count": 120},
                               partial=True, error="timeout", expected_total=6438)

    monkeypatch.setattr(stats_module, "run_case_aggregate", partial)
    out = await CaseStatsTool().run(make_ctx(cases=store))
    assert out.ok and out.basis == "sample" and "partial" in (out.coverage or "")
    assert out.observation["exact"] is False and "partial" in out.observation
    assert out.artifacts[0].window.startswith("120 cases counted · partial")
    assert "partial count" in out.summary


def _whole_days(days: int) -> tuple[str, str]:
    """``(label, previous period's first day)`` of "last N days" counted as N whole days,
    today and the N-1 before it (SPEC §7.2 decision 28); its previous period is the N
    days before, cut at the same time of day ("15 Jun – 13 Aug 2026 08:48")."""
    first = (NOW - timedelta(days=days - 1)).date()
    before = first - timedelta(days=days)
    return f"last {days} days (since {first.day} {first:%b %Y})", f"{before.day} {before:%b}"


async def test_case_stats_compare_previous_period_measures_each_period_alike(store: CaseStore) -> None:
    ctx = make_ctx(cases=store)
    out = await CaseStatsTool().run(ctx, window="now-60d", metrics=["fp_rate"], compare="previous_period")
    assert out.ok
    comparison = out.observation["comparison"]
    label, before = _whole_days(60)
    previous = comparison["periods"][0]
    assert comparison["periods"] == [previous, label]
    assert previous.startswith(f"{before} ") and " – " in previous, previous
    assert comparison["subject"] == label and comparison["baseline"] == previous
    rows = {r["label"]: r for r in comparison["rows"]}
    assert rows["Cases"]["values"] == [2, 3] and rows["Cases"]["change"] == 1
    assert rows["False-positive rate"]["small_sample"] is True          # n < 20 is flagged
    # Each period equals an independent call over that window.
    alone = await CaseStatsTool().run(ctx, window="now-60d")
    assert alone.observation["total"] == rows["Cases"]["values"][-1]
    artifact = _artifact(out, "comparison")
    assert artifact.window == f"{label} vs {previous}"
    tiles = _blocks(artifact)[0]
    assert tiles["type"] == "kpi_group"                                 # metrics → tiles with deltas
    cases_tile = tiles["items"][0]
    assert cases_tile["value"] == 3 and cases_tile["delta"]["value"] == 1
    assert cases_tile["delta"]["period_label"] == f"vs {previous}"
    assert "n < 20" in tiles["items"][1]["context"]


async def test_case_stats_grouped_compare_is_grouped_bars(store: CaseStore) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store), window="now-60d", group_by="verdict",
                                    compare="previous_period")
    artifact = _artifact(out, "comparison")
    assert artifact_views(artifact)[:2] == ["grouped_bar", "hbar"]
    chart = _blocks(artifact)[0]
    assert chart["type"] == "chart" and chart["kind"] == "grouped_bar"
    label, before = _whole_days(60)
    labels = [s["label"] for s in chart["series"]]
    assert labels[1] == label and labels[0].startswith(f"{before} ") and len(labels) == 2, labels
    table = _blocks(artifact, "table")[0]
    assert [c["key"] for c in table["columns"]][:3] == ["label", "p1", "p2"]
    assert artifact_data_from_block(table)["periods"][1]["label"] == label


async def test_case_stats_all_time_with_a_keyword_compare_is_refused(store: CaseStore) -> None:
    out = await CaseStatsTool().run(make_ctx(cases=store), compare="previous_period")
    assert not out.ok and "Invalid input" in out.error


# --------------------------------------------------------------------------- #
# search_cases: exact counts, pages never presented as totals
# --------------------------------------------------------------------------- #
async def test_search_cases_still_open_counts_every_match_not_the_page(store: CaseStore) -> None:
    out = await SearchCasesTool().run(make_ctx(cases=store), status_group="active", limit=2)
    assert out.ok and out.observation["count"] == 4 and out.observation["returned"] == 2
    assert out.observation["open"] == 4 and out.observation["count_source"] == "exact aggregate"
    assert "covers every match" in out.observation["listing"]
    kpis = _artifact(out, "kpis").data["items"]
    assert {i["key"]: i["value"] for i in kpis}["open"] == 4
    assert _artifact(out, "case_list").window == "4 cases · exact · all time"
    terminal = await SearchCasesTool().run(make_ctx(cases=store), status_group="terminal")
    assert terminal.observation["open"] == 0
    mixed = await SearchCasesTool().run(make_ctx(cases=store), verdict="FALSE_POSITIVE")
    assert mixed.observation["count"] == 3 and mixed.observation["open"] == 1
    assert SearchCasesInput.model_validate({}).window is None           # all time by default


# --------------------------------------------------------------------------- #
# Windows: any length, all time, humanised labels, the chip clamp
# --------------------------------------------------------------------------- #
def test_windows_of_any_length_resolve_without_a_clamp() -> None:
    ctx = make_ctx()
    year = resolve_window(ctx, window="now-400d")
    assert year.label == "last 400 days" and not year.clamped and year.span_days == 400
    assert resolve_window(ctx, window_hours=24 * 400).label == "last 400 days"
    lifetime = resolve_window(ctx, window="lifetime")
    assert lifetime.all_time and lifetime.label == "all time"
    quarter = resolve_window(ctx, window="2026-Q3")
    assert quarter.label == "Q3 2026"
    assert resolve_window(ctx, window_hours=1).label == "last hour"
    assert isinstance(resolve_window(ctx, window="sometime"), str)


def test_the_all_time_chip_never_clamps_and_a_narrow_chip_does() -> None:
    chip_all = TimeRange.model_validate({"from": "all"})
    assert chip_all.is_all_time and chip_all.label() == "all time"
    ctx = make_ctx(time_range=chip_all)
    ninety = resolve_window(ctx, window="now-90d")
    assert ninety.label == "last 90 days" and not ninety.clamped
    assert resolve_window(ctx).all_time                                  # the chip itself
    week = make_ctx(time_range=TimeRange.model_validate({"from": "now-7d"}))
    clamped = resolve_window(week, window="all")
    assert clamped.label == "last 7 days" and clamped.clamped
    assert TimeRange.model_validate({"from": "now-400d"}).label() == "last 400 days"


def test_period_helpers_label_and_shift_calendar_periods() -> None:
    ctx = make_ctx()
    month = resolve_window(ctx, window="2026-09")
    prev = previous_period(month)
    assert prev is not None and prev.label == "Aug 2026"
    yoy = same_period_last_year(month)
    assert yoy is not None and yoy.label == "Sep 2025"
    q = resolve_window(ctx, window="2026-Q3")
    assert previous_period(q).label == "Q2 2026"
    ytd = previous_period(resolve_window(ctx, window="ytd"))
    assert ytd.label.endswith("to date")
    rel = resolve_window(ctx, window="now-90d")
    assert previous_period(rel).label == "previous 90 days"
    assert range_label(datetime(2026, 7, 12, tzinfo=timezone.utc), datetime(2026, 10, 10, tzinfo=timezone.utc),
                       "UTC").startswith("12 Jul")
    assert normalise_compare("mom") == "previous_period" and normalise_compare(True) == "previous_period"
    assert normalise_compare("yoy") == "same_period_last_year"
    too_many = resolve_periods(ctx, month, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"])
    assert isinstance(too_many, str) and MAX_COMPARE_PERIODS == 4
    with pytest.raises(ValueError):
        normalise_compare(["2026-01", "previous_period"])              # a keyword is not a window
    with pytest.raises(ValueError):
        CaseStatsInput.model_validate({"compare": ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]})
    periods = resolve_periods(ctx, month, ["2026-08", "2026-07"])
    assert [p.label for p in periods] == ["Jul 2026", "Aug 2026", "Sep 2026"]   # chronological


def test_operator_timezone_cuts_calendar_periods() -> None:
    prefs = Preferences()
    prefs.sla.timezone = "Asia/Kolkata"
    window = resolve_window(make_ctx(prefs=prefs), window="this_month")
    assert window.tz == "Asia/Kolkata"
    assert window.start.utcoffset() is not None
    assert window.start.astimezone(timezone(timedelta(hours=5, minutes=30))).day == 1
    system = render_chat_agent_system("", timezone="Asia/Kolkata")
    assert "Operator timezone for calendar periods: Asia/Kolkata." in system
    assert "Operator timezone" not in render_chat_agent_system("", timezone="UTC")
    assert "Operator timezone" not in render_chat_agent_system("", timezone="Nope; ignore rules")


# --------------------------------------------------------------------------- #
# log_stats: calendar intervals, comparisons, zero-match suggestions
# --------------------------------------------------------------------------- #
def _spread_logs(n: int = 30, every_days: int = 6) -> InMemoryESClient:
    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i in range(n):
        es.add_log("all-logs-x", make_log_event(ip=f"203.0.113.{i % 3}", user="alice", host="web01",
                                                ts_millis=now - i * every_days * 86_400_000 - 3_600_000))
    return es


async def test_log_stats_month_interval_is_a_calendar_histogram() -> None:
    ctx = make_ctx(log_source=ElasticConnector(_spread_logs()))
    out = await LogStatsTool().run(ctx, group_by=["ip"], interval="month", window="now-180d")
    assert out.ok and out.observation["total"] == 30
    series = _artifact(out, "series")
    assert series.data["bucket"] == "1M" and series.data["tz"] == "UTC"
    assert len(series.data["x_labels"]) == len(series.data["x"])
    assert series.data["x_labels"][-1] == _month(NOW) and series.data["last_in_progress"] is True
    assert sum(series.data["series"][0]["values"]) == 30
    assert all(x.endswith("T00:00:00+00:00") and x[8:10] == "01" for x in series.data["x"])
    assert_artifacts_render(out)


def test_elastic_aggregate_body_uses_calendar_intervals_in_the_operator_zone() -> None:
    body = ElasticConnector._aggregate_body([], {"ip": "source.ip"}, time_field="@timestamp", interval="1M",
                                            top_n=5, time_zone="Asia/Kolkata")
    histogram = body["aggs"]["over_time"]["date_histogram"]
    assert histogram["calendar_interval"] == "month" and histogram["time_zone"] == "Asia/Kolkata"
    assert "fixed_interval" not in histogram
    utc = ElasticConnector._aggregate_body([], {}, time_field="@timestamp", interval="1q", top_n=5,
                                           time_zone="UTC")
    assert utc["aggs"]["over_time"]["date_histogram"] == {"field": "@timestamp", "calendar_interval": "quarter",
                                                          "min_doc_count": 0}
    fixed = ElasticConnector._aggregate_body([], {}, time_field="@timestamp", interval="1h", top_n=5)
    assert fixed["aggs"]["over_time"]["date_histogram"]["fixed_interval"] == "1h"


async def test_log_stats_compare_returns_computed_changes() -> None:
    ctx = make_ctx(log_source=ElasticConnector(_spread_logs()))
    out = await LogStatsTool().run(ctx, group_by=["ip"], window="now-30d", compare="previous_period")
    # A daily series: "the last 30 days" is 30 whole days (the last in progress),
    # compared with the 30 days before it cut at the same point.
    assert out.ok and "; compared with " in out.summary
    events = out.observation["comparison"]["events"]
    assert events["periods"][1].startswith("last 30 days (since ") and "–" in events["periods"][0]
    assert events["rows"][0]["values"] == [5, 5]
    assert events["rows"][0]["change"] == 0 and events["rows"][0]["small_sample"] is True
    total = _artifact(out, "comparison", "Events compared")
    assert _blocks(total)[0]["type"] == "kpi_group"                    # a total compares as a tile
    values = _artifact(out, "comparison", "Top values compared")
    assert values.untrusted_labels is True
    assert _blocks(values)[0]["kind"] == "grouped_bar"


async def test_log_stats_zero_matches_suggest_valid_calls() -> None:
    from app.agents.chat_tools.logs import LogStatsInput

    ctx = make_ctx(log_source=ElasticConnector(_spread_logs()))
    out = await LogStatsTool().run(ctx, group_by=["ip"], ip="198.51.100.1", window="now-1d")
    assert out.ok and out.observation["total"] == 0
    suggestions = out.observation["suggestions"]
    assert suggestions and all(s["tool"] == "log_stats" for s in suggestions)
    for suggestion in suggestions:
        LogStatsInput.model_validate(suggestion["input"])


# --------------------------------------------------------------------------- #
# soc_metrics / cost_usage over any window
# --------------------------------------------------------------------------- #
async def test_soc_metrics_trends_buckets_any_window(store: CaseStore) -> None:
    ctx = make_ctx(cases=store)
    out = await SocMetricsTool().run(ctx, kind="trends", window="all", bucket="month")
    assert out.ok and out.observation["bucket"] in ("month", "1M")
    assert sum(out.observation["new_cases"]) == 6
    assert_artifacts_render(out)
    long = await SocMetricsTool().run(ctx, kind="posture", window_hours=24 * 400)
    assert long.ok and long.observation["window"] == "last 400 days"   # never clamped to 90 days


async def test_cost_usage_over_all_time_by_model_and_compare() -> None:
    es = InMemoryESClient()
    usage = UsageStore(es)
    for i, (days, model, cost) in enumerate([(1, "gpt-a", 0.5), (2, "gpt-b", 0.25), (40, "gpt-a", 1.0),
                                             (300, "gpt-a", 2.0)]):
        await usage.write(UsageDoc(ts=(NOW - timedelta(days=days)).isoformat(), surface="chat", role="router",
                                   model=model, prompt_tokens=100, completion_tokens=10, total_tokens=110,
                                   cost=cost))
    ctx = make_ctx(usage=usage)
    out = await CostUsageTool().run(ctx, window="all", group_by="model")
    assert out.ok, out.error
    assert out.observation["total_cost_usd"] == pytest.approx(3.75) and out.observation["calls"] == 4
    assert out.observation["window"].startswith("all time") and out.observation["bucket"] == "month"
    assert {r["key"]: r["calls"] for r in out.observation["by_model"]} == {"gpt-a": 3, "gpt-b": 1}
    assert_artifacts_render(out)
    compared = await CostUsageTool().run(ctx, window="now-30d", compare="previous_period")
    # By day (the auto bucket), "the last 30 days" is 30 whole days, the last in progress,
    # compared with the 30 days before it cut at the same point (a dated range).
    periods = compared.observation["comparison"]["periods"]
    assert compared.ok and periods[1].startswith("last 30 days (since ") and "–" in periods[0]
    spend = next(r for r in compared.observation["comparison"]["rows"] if r["label"] == "AI spend")
    assert spend["values"] == [1.0, 0.75] and spend["change"] == -0.25 and spend["change_pct"] == -25.0


# --------------------------------------------------------------------------- #
# Blocks: comparison, grouped bars, re-binning, calendar labels, report layout
# --------------------------------------------------------------------------- #
def test_compare_values_zero_baseline_is_new_never_infinite() -> None:
    assert compare_values(5, 0) == {"delta": 5, "delta_pct": None, "new": True}
    assert compare_values(0, 0) == {"delta": 0, "delta_pct": 0.0, "new": False}
    assert compare_values(12, 10) == {"delta": 2, "delta_pct": 20.0, "new": False}
    assert compare_values(None, 3)["delta"] is None
    assert format_change_pct(None, True) == "new" and format_change_pct(8.3, False) == "+8.3%"
    assert format_change_pct(0, False) == "0%" and format_change_pct(None, False) == "—"


def _comparison(rows: list[dict[str, Any]], *, dimension: str | None = None, unit: str | None = None) -> Artifact:
    data: dict[str, Any] = {"periods": [{"label": "Aug 2026"}, {"label": "Sep 2026"}], "rows": rows}
    if dimension:
        data["dimension"] = dimension
    if unit:
        data["unit"] = unit
    return Artifact(id="a1", kind="comparison", title="Compared", title_trusted=True, data=data,
                    provenance="code", basis="exact", window="Sep 2026 vs Aug 2026")


def test_metric_comparison_tiles_carry_deltas_new_and_small_samples() -> None:
    artifact = _comparison([
        {"key": "cases", "label": "Cases", "unit": "count", "values": [100, 120], "good_direction": "none"},
        {"key": "fp", "label": "False-positive rate", "unit": "percent", "values": [0, 12.5],
         "good_direction": "down", "small_sample": True},
        {"key": "mttr", "label": "MTTR (median)", "unit": "minutes", "values": [90, 60], "good_direction": "down"},
    ])
    assert artifact_views(artifact) == ["kpi_group", "table"]           # mixed units: no chart axis
    tiles = _blocks(artifact)[0]
    items = {i["key"]: i for i in tiles["items"]}
    assert items["cases"]["delta"] == {"value": 20, "period_label": "vs Aug 2026", "good_direction": "none"}
    assert items["fp"]["context"] == f"Aug 2026: 0.0% · new · n < {SMALL_SAMPLE_N}"
    assert items["mttr"]["delta"]["value"] == -30 and items["mttr"]["delta"]["good_direction"] == "down"
    table = _blocks(artifact, "table")[0]
    assert [c["key"] for c in table["columns"]] == ["label", "p1", "p2", "delta", "delta_pct", "unit", "note"]
    assert table["rows"][1][4] == "new" and table["rows"][0][4] == "+20.0%"


def test_category_comparison_draws_grouped_bars_and_reads_back() -> None:
    artifact = _comparison([
        {"key": "r1", "label": "True positive", "values": [4, 6]},
        {"key": "r2", "label": "False positive", "values": [10, 7]},
    ], dimension="Verdict", unit="count")
    chart = _blocks(artifact)[0]
    assert chart["kind"] == "grouped_bar" and chart["x"]["label"] == "Verdict"
    assert chart["series"] == [{"key": "p1", "label": "Aug 2026", "values": [4, 10]},
                               {"key": "p2", "label": "Sep 2026", "values": [6, 7]}]
    back = artifact_data_from_block(chart)
    assert back["rows"][1]["values"] == [10, 7] and back["dimension"] == "Verdict"


def test_grouped_bar_and_rebin_validation() -> None:
    base = {"id": "c1", "type": "chart", "title": "Cases by month", "provenance": "code", "unit": "count",
            "series": [{"key": "cases", "label": "Cases", "values": [1, 2, 3]}]}
    months = ["2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"]
    good = {**base, "kind": "line", "allowed_rebin": ["1d", "1q", "1y", "bogus"],
            "x": {"kind": "time", "bucket": "1M", "values": months, "labels": ["Jul 2026", "Aug 2026"],
                  "tz": "Europe/Berlin"}}
    kept, dropped = validate_blocks([good])
    assert kept and not dropped
    block = kept[0]
    assert block["x"]["bucket"] == "1M"                                 # a month, never the 1m minute
    assert block["allowed_rebin"] == ["1q", "1y"]                       # coarser only, enum only
    assert block["x"]["labels"] == ["Jul 2026", "Aug 2026", ""]        # realigned to x
    rates = {**good, "unit": "percent"}
    assert "allowed_rebin" not in validate_blocks([rates])[0][0]       # a sum of rates is not a rate
    grouped = {**base, "kind": "grouped_bar", "x": {"kind": "category", "values": ["a", "b", "c"]}}
    assert validate_blocks([grouped])[0]
    bad_tz = {**good, "x": {**good["x"], "tz": "Europe/Berlin; drop"}}
    assert "tz" not in validate_blocks([bad_tz])[0][0]["x"]
    assert {"1M", "1q", "1y"} <= set(TIME_BUCKETS)
    assert rebin_options("1d", "count", ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]) == ["1w", "1M"]
    assert rebin_options("1d", "percent", ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"]) == []


def test_report_templates_and_infographic_layout() -> None:
    assert {"executive", "monthly", "infographic", "investigation_brief"} <= set(REPORT_TEMPLATES)
    assert REPORT_LAYOUTS == ("document", "infographic")
    kpis = Artifact(id="a1", kind="kpis", title="Case figures", title_trusted=True,
                    data={"items": [{"key": "cases", "label": "Cases", "value": 6, "unit": "count"}]},
                    provenance="code", basis="exact", window="6 cases · exact · all time")
    artifacts = {"t1.a1": TurnArtifact(ref="t1.a1", artifact=kpis, from_step=1)}
    for template, layout, expected in (("infographic", None, "infographic"), ("executive", "infographic", "infographic"),
                                       ("monthly", None, None), ("investigation_brief", "bogus", None)):
        request = {"type": "report", "title": "Lifetime performance", "template": template,
                   "sections": [{"title": "Summary", "items": [{"ref": "t1.a1"}]}]}
        if layout:
            request["layout"] = layout
        requests, dropped = parse_final_block_requests([request])
        assert not dropped
        made = materialise_final_blocks(requests, artifacts=artifacts, window_label="all time")
        report = next(b for b in made.blocks if b["type"] == "report")
        assert report["template"] == template and report.get("layout") == expected
    assert MAX_REPORT_LEAVES == 60


# --------------------------------------------------------------------------- #
# Registry + prompt
# --------------------------------------------------------------------------- #
def test_case_stats_is_registered_with_a_long_budget() -> None:
    assert TOOL_ORDER.index("case_stats") == TOOL_ORDER.index("search_cases") + 1
    tool = get_tool("case_stats")
    assert tool is not None and tool.requires == (("cases", "read"),)
    assert tool.timeout_s == AGGREGATE_TOOL_TIMEOUT_S == 600
    ctx = make_ctx()
    assert _tool_budget(tool, ctx) == 600
    for name in ("soc_metrics", "cost_usage", "search_cases"):
        assert _tool_budget(get_tool(name), ctx) >= 600, name
    no_cases = make_ctx(grants=frozenset({("logs", "read")}))
    assert "case_stats" not in build_toolbox(no_cases).names()


def _full_prompt(time_window: str | None = None) -> str:
    return render_chat_agent_system(render_tool_signatures(catalogue()), time_window=time_window)


def test_prompt_routes_counts_windows_and_reports() -> None:
    system = _full_prompt()
    assert "- case_stats(" in system and "EXACT counts" in system
    # No false "everything defaults to the last 24 hours".
    assert "lookups default to the last 24 hours" not in system
    assert "case_stats and search_cases cover all time" in system
    # The exceptions the console's scope hint also names (Round 12 WP-FIX1): ATT&CK
    # coverage is all time without a window, agent improvement never follows one.
    assert "so does soc_metrics mitre_coverage; other soc_metrics kinds" in system
    assert "soc_metrics agent_improvement always compares its own fixed periods" in system
    assert '"lifetime", "all time", "ever", "in total", "so far" and "since we started" mean window "all"' in system
    assert "No time window was selected" in system
    # The report recipe: one parallel batch, the same window, a report block.
    assert "case_stats (bucket month, metrics count, fp_rate, mttr_p50)" in system
    assert "template executive, monthly or posture" in system and "layout infographic" in system
    assert "Never clarify a lifetime or performance report: it is all time." in system
    # Answer what can be read; unsupported only when nothing can be read.
    assert "Answer every part your lookups can read" in system
    assert "unsupported: true only when the WHOLE question" in system
    assert "retry with them" in system and "suggestions" in system
    assert '"clarify": {"question": "Trend of what?"' in system
    assert "previous_period, same_period_last_year" in system
    # Every signature fits its budget and the prompt stays compact.
    for line in render_tool_signatures(catalogue()).splitlines():
        assert len(line) <= 620, line[:80]
    assert len(system) < 16_500
    chip = _full_prompt("last 7 days")
    assert "Time window selected by the analyst: last 7 days." in chip
    assert "No time window was selected" not in chip


# --------------------------------------------------------------------------- #
# The three screenshot questions
# --------------------------------------------------------------------------- #
def _report(artifacts: list[Artifact], template: str, layout: str | None = None) -> dict[str, Any]:
    turn = {f"t1.a{i + 1}": TurnArtifact(ref=f"t1.a{i + 1}", artifact=a, from_step=1)
            for i, a in enumerate(artifacts)}
    request: dict[str, Any] = {
        "type": "report", "title": "Report", "template": template,
        "sections": [{"title": "Figures", "items": [{"ref": ref} for ref in turn]}],
    }
    if layout:
        request["layout"] = layout
    requests, dropped = parse_final_block_requests([request])
    assert not dropped
    made = materialise_final_blocks(requests, artifacts=turn, window_label="all time")
    assert not made.unresolved and not made.unshowable, (made.unresolved, made.unshowable)
    return next(b for b in made.blocks if b["type"] == "report")


async def test_screenshot_create_a_report_of_lifetime_performance(store: CaseStore) -> None:
    """Routed to case_stats + soc_metrics with window "all" (never a 24-hour default,
    never a clarify), then a report block."""
    ctx = make_ctx(cases=store)
    toolbox = build_toolbox(ctx)
    stats = await toolbox.execute("case_stats", {"window": "all", "bucket": "month",
                                                 "metrics": ["count", "fp_rate", "mttr_p50"]},
                                  turn_id="t", step=1)
    posture = await toolbox.execute("soc_metrics", {"kind": "posture", "window": "all"}, turn_id="t", step=1)
    timing = await toolbox.execute("soc_metrics", {"kind": "timing", "window": "lifetime"}, turn_id="t", step=1)
    for out in (stats, posture, timing):
        assert out.ok, out.error
        assert out.observation["window"].startswith("all time")
    assert stats.observation["total"] == 6 and posture.observation["case_count"] == 6
    report = _report([*stats.artifacts, *posture.artifacts[:2]], "executive", "infographic")
    assert report["layout"] == "infographic" and report["sections"][0]["blocks"]


async def test_screenshot_last_90_days_or_whatever_reports_you_can(store: CaseStore) -> None:
    usage = UsageStore(InMemoryESClient())
    await usage.write(UsageDoc(ts=(NOW - timedelta(days=10)).isoformat(), surface="chat", role="router",
                               model="gpt-a", total_tokens=50, cost=0.4))
    ctx = make_ctx(cases=store, usage=usage)
    toolbox = build_toolbox(ctx)
    calls = [
        ("case_stats", {"window": "now-90d", "bucket": "week", "metrics": ["count", "fp_rate"]}),
        ("soc_metrics", {"kind": "posture", "window": "now-90d", "compare": "previous_period"}),
        ("soc_metrics", {"kind": "trends", "window": "now-90d", "bucket": "week"}),
        ("cost_usage", {"window": "now-90d", "bucket": "week"}),
    ]
    outs = [await toolbox.execute(name, inp, turn_id="t", step=1) for name, inp in calls]
    # Every lookup of "last 90 days", broken down by week or not at all, covers the same
    # 90 whole days and states the same start, and the posture tiles compare with the
    # same previous period as every other comparison (SPEC §7.2 decision 28).
    label, before = _whole_days(90)
    for (name, inp), out in zip(calls, outs):
        assert out.ok, (name, out.error)
        assert out.observation["window"] == label, (name, out.observation["window"])
    assert outs[0].observation["total"] == 5                            # the 400-day-old case is outside
    assert outs[1].observation["case_count"] == 5                       # the posture tiles count the same cases
    periods = outs[1].observation["comparison"]["periods"]
    assert periods[1] == label and periods[0].startswith(f"{before} "), periods
    report = _report([a for out in outs for a in out.artifacts][:20], "monthly")
    assert sum(len(s["blocks"]) for s in report["sections"]) >= 4


async def test_screenshot_open_cases_now_segregated_month_wise(store: CaseStore) -> None:
    """"The amount of total cases right now that are open, when were they all opened?
    Segregate month wise": one exact case_stats call over every open case, by month."""
    ctx = make_ctx(cases=store)
    out = await build_toolbox(ctx).execute("case_stats", {"status_group": "active", "group_by": ["month"]},
                                           turn_id="t", step=1)
    assert out.ok and out.observation["total"] == 4 and out.observation["exact"] is True
    assert out.observation["bucket"] == "month"
    open_months = Counter(_month(_created(days)) for days, status, *_ in SEEDS
                          if status in (CaseStatus.OPEN, CaseStatus.INVESTIGATING))
    by_month = {g["bucket"]: g["metrics"]["count"] for g in out.observation["groups"] if g["metrics"]["count"]}
    assert by_month == dict(open_months)
    series = _artifact(out, "series")
    chart = _blocks(series)[0]
    assert chart["type"] == "chart" and chart["x"]["bucket"] == "1M"
    table = _blocks(_artifact(out, "table"))[0]
    assert table["columns"][0]["label"] == "Period"
