"""Round 12 WP-TOOLS final fixes: each test pins one verified finding.

* A relative window broken down by a calendar unit is aligned to whole periods BEFORE
  anything is counted, so the headline total, the series, its labels and the compared
  periods describe ONE span (case_stats, soc_metrics trends/timing, cost_usage,
  log_stats), and "the previous period" of such a window is the N periods before it,
  cut at the same point.
* A bounded window neither counts nor lists cases with no creation date, and says so;
  only an all-time breakdown has a "No creation date" row.
* log_stats: twelve monthly buckets for the last twelve months; days in a non-UTC zone
  are local calendar days; fixed UTC hours under a non-UTC zone offer no re-bin; the
  long aggregate budget; compared periods are read at the same time.
* A partial count states the counted share ("counted 1,000 of 2,500 cases").
* The time chip keeps months and years (``now-6M`` is never six minutes).
* "Same period last year" of a week is the same ISO week a year earlier.
* The prompt says which lookups take ``window_hours``.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from app.agents.blocks import MaterialiseOptions, to_blocks
from app.agents.chat_tools.cases import SearchCasesTool
from app.agents.chat_tools.common import align_to_bucket, logs_console_view, parse_input, resolve_window
from app.agents.chat_tools.logs import LogStatsInput, LogStatsTool, SearchLogsInput
from app.agents.chat_tools.metrics import CostUsageTool, SocMetricsTool
from app.agents.chat_tools.periods import previous_period, same_period_last_year
from app.agents.chat_tools.registry import build_toolbox
from app.agents.chat_tools.stats import CaseStatsTool
from app.agents.prompts import render_chat_agent_system
from app.api.metrics_shared import invalidate_case_page_cache, invalidate_case_population_cache
from app.config import ChatAgentConfig, Preferences
from app.connectors.base import AggregateResult as LogAggregate
from app.connectors.elastic import ElasticConnector
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import time_windows
from app.engine.case_aggregate import AggregateResult
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, TimeRange, UsageDoc
from app.stores.base import CaseRepository
from app.stores.cases import CaseStore
from app.stores.usage import UsageStore
from app.utils import now_utc, to_millis

from tests.conftest import make_log_event
from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

NOW = datetime.now(timezone.utc)
FIXED = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)  # a Saturday


@pytest.fixture(autouse=True)
def _fresh_caches() -> Any:
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    yield
    invalidate_case_page_cache()
    invalidate_case_population_cache()


def _case(i: int, created: datetime | str, *, status: CaseStatus = CaseStatus.OPEN,
          verdict: Verdict | None = Verdict.NEEDS_HUMAN) -> Case:
    stamp = created if isinstance(created, str) else created.isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=f"198.51.100.{i % 250}"), status=status, verdict=verdict,
        confidence=0.8, risk_score=10.0 + i % 50, title=f"Case {i}", rule_ids=["r"],
        created_at=stamp, updated_at=stamp if not isinstance(created, str) else NOW.isoformat(),
    )


async def _store(cases: list[Case]) -> CaseStore:
    store = CaseStore(InMemoryESClient())
    for case in cases:
        await store.save(case)
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    return store


def _art(out: Any, kind: str, title: str | None = None) -> Any:
    return next(a for a in out.artifacts if a.kind == kind and (title is None or a.title == title))


def _cut_and_whole(spec: str, unit: str) -> tuple[datetime, datetime]:
    """``(the exact relative start, the aligned start)`` of ``spec`` broken down by ``unit``."""
    raw = time_windows.resolve_window(spec, now=NOW)
    return raw.start, time_windows.align_window(raw, unit).start


async def _aligned_case_store(spec: str, unit: str) -> tuple[CaseStore, int]:
    """Cases inside the aligned window, plus one in the CUT part (between the exact
    relative start and the aligned start), and one before both. Returns the store and
    how many cases the aligned window holds."""
    exact_start, aligned_start = _cut_and_whole(spec, unit)
    inside = [_case(i, NOW - (NOW - aligned_start) * f) for i, f in enumerate((0.1, 0.4, 0.7, 0.95), start=1)]
    extra: list[Case] = []
    if aligned_start - exact_start > timedelta(minutes=2):
        extra.append(_case(50, exact_start + (aligned_start - exact_start) / 2))   # cut part
    extra.append(_case(51, exact_start - timedelta(days=3)))                      # previous period
    return await _store(inside + extra), len(inside)


# --------------------------------------------------------------------------- #
# 1. One aligned window for every figure of a bucketed answer
# --------------------------------------------------------------------------- #
def test_align_to_bucket_matches_the_aggregator() -> None:
    ctx = make_ctx()
    window = resolve_window(ctx, window="now-6M", now=FIXED)
    aligned = align_to_bucket(window, "month")
    assert aligned.start == datetime(2026, 5, 1, tzinfo=timezone.utc) and aligned.end == window.end
    assert aligned.label == "last 6 months (since May 2026)" and aligned.aligned_to == "month"
    assert aligned.time_from == aligned.start.isoformat() and aligned.trailing
    assert aligned.as_resolved().aligned_to == "month"            # the aggregator does not re-align it
    assert align_to_bucket(aligned, "month") is aligned           # idempotent
    # Calendar periods, all time and spans that are not whole periods stay as they are.
    for spec, unit in (("last_month", "day"), ("all", "month"), ("now-90d", "month")):
        unchanged = resolve_window(ctx, window=spec, now=FIXED)
        assert align_to_bucket(unchanged, unit) is unchanged, spec


async def test_case_stats_by_month_with_compare_uses_one_window() -> None:
    store, inside = await _aligned_case_store("now-6M", "month")
    out = await CaseStatsTool().run(make_ctx(cases=store), window="now-6M", bucket="month",
                                    compare="previous_period")
    assert out.ok, out.error
    obs = out.observation
    assert obs["total"] == inside and obs["window"].startswith("last 6 months (since ")
    # The comparison subject IS the headline total (same window, same count).
    cases_row = next(r for r in obs["comparison"]["rows"] if r["label"] == "Cases")
    assert cases_row["values"][-1] == obs["total"]
    assert obs["comparison"]["subject"] == obs["window"]
    # Six whole months, the last in progress: no bucket is cut, nothing says so.
    assert len(obs["buckets"]) == 6 and obs["buckets"][-1]["in_progress"] is True
    assert "partial_buckets" not in obs and all("partial" not in b for b in obs["buckets"])
    series = _art(out, "series")
    assert not any("(from " in label for label in series.data["x_labels"])
    assert sum(series.data["series"][0]["values"]) == obs["total"]
    # The previous period is the six months before, cut at the same point (a dated range).
    assert "–" in obs["comparison"]["baseline"] and obs["comparison"]["note"]
    assert_artifacts_render(out)


async def test_case_stats_by_day_for_the_last_30_days() -> None:
    store, inside = await _aligned_case_store("now-30d", "day")
    out = await CaseStatsTool().run(make_ctx(cases=store), window="now-30d", bucket="day",
                                    compare="previous_period")
    assert out.ok, out.error
    obs = out.observation
    assert obs["total"] == inside and len(obs["buckets"]) == 30
    assert next(r for r in obs["comparison"]["rows"] if r["label"] == "Cases")["values"][-1] == inside
    assert not any("(from " in label for label in _art(out, "series").data["x_labels"])


def test_previous_period_of_an_aligned_window_is_like_for_like() -> None:
    ctx = make_ctx()
    window = align_to_bucket(resolve_window(ctx, window="now-6M", now=FIXED), "month")
    prev = previous_period(window)
    assert prev is not None
    assert prev.start == datetime(2025, 11, 1, tzinfo=timezone.utc)
    assert prev.end == datetime(2026, 4, 10, 12, 0, tzinfo=timezone.utc) <= window.start
    assert prev.label == "1 Nov 2025 – 10 Apr 2026 12:00"
    last_year = same_period_last_year(window)
    assert last_year is not None and last_year.start == datetime(2025, 5, 1, tzinfo=timezone.utc)
    assert "since" not in last_year.label


async def test_soc_metrics_trends_and_timing_use_the_aligned_window() -> None:
    store, inside = await _aligned_case_store("now-6M", "month")
    ctx = make_ctx(cases=store)
    trends = await SocMetricsTool().run(ctx, kind="trends", window="now-6M", bucket="month",
                                        compare="previous_period")
    assert trends.ok, trends.error
    obs = trends.observation
    assert obs["total_cases"] == inside == sum(obs["new_cases"])
    assert obs["window"].startswith("last 6 months (since ")
    comparison = obs["comparison"]
    assert comparison["rows"][0]["values"][-1] == inside
    assert comparison["subject"] == obs["window"] and "–" in comparison["baseline"]
    assert "partial_buckets" not in obs
    timing = await SocMetricsTool().run(ctx, kind="timing", window="now-6M", bucket="month")
    assert timing.ok, timing.error
    assert timing.observation["cases"] == inside            # the headline run covers the aligned window
    assert timing.observation["window"].startswith("last 6 months (since ")


async def test_cost_usage_total_equals_the_series() -> None:
    usage = UsageStore(InMemoryESClient())
    exact_start, aligned_start = _cut_and_whole("now-6M", "month")
    stamps = [NOW - timedelta(days=d) for d in (1, 20, 60)]
    if aligned_start - exact_start > timedelta(minutes=2):
        stamps.append(exact_start + (aligned_start - exact_start) / 2)    # the cut part of the first month
    for ts in stamps:
        await usage.write(UsageDoc(ts=ts.isoformat(), surface="chat", role="router", model="gpt-a",
                                   total_tokens=10, cost=1.0))
    out = await CostUsageTool().run(make_ctx(usage=usage), window="now-6M", bucket="month")
    assert out.ok, out.error
    obs = out.observation
    assert obs["total_cost_usd"] == pytest.approx(3.0) and obs["calls"] == 3
    assert sum(obs["spend_per_bucket"]["cost_usd"]) == pytest.approx(obs["total_cost_usd"])
    series = _art(out, "series")
    assert sum(series.data["series"][0]["values"]) == pytest.approx(3.0)
    assert len(series.data["x"]) == 6 and not any("(from " in x for x in series.data["x_labels"])
    assert obs["window"].startswith("last 6 months (since ")


async def test_a_months_chip_aligns_like_the_same_words() -> None:
    store, inside = await _aligned_case_store("now-6M", "month")
    chip = TimeRange.model_validate({"from": "now-6M"})
    out = await CaseStatsTool().run(make_ctx(cases=store, time_range=chip), bucket="month")
    assert out.ok, out.error
    assert out.observation["total"] == inside and len(out.observation["buckets"]) == 6


# --------------------------------------------------------------------------- #
# 2. Cases with no creation date
# --------------------------------------------------------------------------- #
async def test_case_stats_names_undated_cases_honestly() -> None:
    undated = _case(9, "not-a-date")
    store = await _store([_case(1, NOW - timedelta(hours=3)), undated])
    ctx = make_ctx(cases=store)
    bounded = await CaseStatsTool().run(ctx, window="now-7d", bucket="day")
    assert bounded.ok and bounded.observation["total"] == 1
    assert bounded.observation["missing_created"] == 1
    assert bounded.observation["missing_created_in_total"] is False
    assert "1 case has no creation date and is not counted in this window" in (bounded.coverage or "")
    assert "own row" not in (bounded.coverage or "")
    table = _art(bounded, "table")
    assert all(row[0] != "No creation date" for row in table.data["rows"])
    everything = await CaseStatsTool().run(ctx, window="all", bucket="month")
    assert everything.ok and everything.observation["total"] == 2
    assert "1 case has no creation date and sits in their own row" in (everything.coverage or "")
    assert any(row[0] == "No creation date" for row in _art(everything, "table").data["rows"])


# --------------------------------------------------------------------------- #
# 3. log_stats calendar series
# --------------------------------------------------------------------------- #
def _monthly_logs(months: int = 14) -> InMemoryESClient:
    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i in range(months * 4):
        es.add_log("all-logs-x", make_log_event(ip=f"203.0.113.{i % 3}", ts_millis=now - i * 7 * 86_400_000 - 3_600_000))
    return es


async def test_log_stats_twelve_months_by_month_is_twelve_buckets() -> None:
    ctx = make_ctx(log_source=ElasticConnector(_monthly_logs()))
    for spec in ("now-12M", "now-1y"):
        out = await LogStatsTool().run(ctx, group_by=["ip"], interval="1M", window=spec)
        assert out.ok, out.error
        series = _art(out, "series")
        assert len(series.data["x"]) == 12, spec
        assert series.data["x"][0][8:10] == "01" and series.data["last_in_progress"] is True
        assert sum(series.data["series"][0]["values"]) == out.observation["total"]
        assert out.observation["window"].endswith(")") and "(since " in out.observation["window"]


async def test_log_stats_days_in_a_non_utc_zone_are_local_days() -> None:
    prefs = Preferences.model_validate({"sla": {"timezone": "Asia/Kolkata"}})
    ctx = make_ctx(prefs=prefs, log_source=ElasticConnector(_monthly_logs(2)))
    out = await LogStatsTool().run(ctx, group_by=["ip"], interval="1d", window="now-30d")
    assert out.ok, out.error
    series = _art(out, "series")
    assert series.data["tz"] == "Asia/Kolkata" and len(series.data["x_labels"]) == len(series.data["x"]) == 30
    # Each bucket starts at local midnight (18:30 UTC the day before).
    assert all(x.endswith("T18:30:00+00:00") for x in series.data["x"])
    assert sum(series.data["series"][0]["values"]) == out.observation["total"]
    body = ElasticConnector._aggregate_body([], {}, time_field="@timestamp", interval="1d", top_n=5,
                                            time_zone="Asia/Kolkata")
    assert body["aggs"]["over_time"]["date_histogram"] == {
        "field": "@timestamp", "calendar_interval": "day", "time_zone": "Asia/Kolkata", "min_doc_count": 0}
    utc = ElasticConnector._aggregate_body([], {}, time_field="@timestamp", interval="1d", top_n=5,
                                           time_zone="UTC")
    assert utc["aggs"]["over_time"]["date_histogram"]["fixed_interval"] == "1d"


async def test_log_stats_offers_no_rebin_for_utc_hours_in_another_zone() -> None:
    def chart(out: Any) -> dict[str, Any]:
        made = to_blocks(_art(out, "series"), MaterialiseOptions(block_id="b1"))
        return next(b for b in made if b.get("type") == "chart")

    es = InMemoryESClient()
    now = to_millis(now_utc())
    for i in range(40):
        es.add_log("all-logs-x", make_log_event(ts_millis=now - i * 3_600_000))
    kolkata = make_ctx(prefs=Preferences.model_validate({"sla": {"timezone": "Asia/Kolkata"}}),
                       log_source=ElasticConnector(es))
    hourly = await LogStatsTool().run(kolkata, interval="1h", window="now-48h")
    assert hourly.ok and _art(hourly, "series").data["rebin"] is False
    assert "allowed_rebin" not in chart(hourly)
    utc = await LogStatsTool().run(make_ctx(log_source=ElasticConnector(es)), interval="1h", window="now-48h")
    assert utc.ok and "rebin" not in _art(utc, "series").data
    assert chart(utc).get("allowed_rebin") == ["1d"]
    daily = await LogStatsTool().run(kolkata, interval="1d", window="now-30d")
    assert "1w" in (chart(daily).get("allowed_rebin") or [])      # local days nest in local weeks


def test_open_in_logs_opens_the_window_log_stats_counted() -> None:
    args = SimpleNamespace(**{k: None for k in ("ip", "user", "host", "rule", "severity_gte", "contains",
                                                "time_from", "time_to", "source_id")},
                           ids=[], window="now-30d", interval="1d")
    view = logs_console_view(make_ctx(source_id="primary"), args, {"source": "Primary"}, now=FIXED)
    assert view is not None
    assert view["opts"]["from"].startswith("2026-09-11T00:00:00")   # 30 whole days, not 10 Sep 12:00


# --------------------------------------------------------------------------- #
# 4. log_stats budget and concurrent compare
# --------------------------------------------------------------------------- #
class _SlowConnector:
    """A log source whose aggregate takes ``delay`` seconds per call."""

    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.calls = 0

    async def aggregate(self, prefs: Any, query: Any, group_by: Any, interval: Any, top_n: int,
                        *, time_zone: str | None = None) -> LogAggregate:
        self.calls += 1
        await asyncio.sleep(self.delay)
        return LogAggregate(total=7, groups={}, other={}, distinct={}, over_time=[])

    async def search(self, prefs: Any, query: Any) -> Any:  # pragma: no cover - never reached
        raise AssertionError("the aggregate answered")


async def test_log_stats_runs_on_the_long_budget_and_reads_periods_together() -> None:
    assert LogStatsTool.timeout_s == 600
    conn = _SlowConnector(0.6)
    prefs = Preferences(chat_agent=ChatAgentConfig(tool_timeout_s=1))
    box = build_toolbox(make_ctx(prefs=prefs, log_source=conn))
    started = time.monotonic()
    out = await box.execute("log_stats", {
        "window": "now-30d", "group_by": ["rule"],
        "compare": {"periods": ["last_month", {"from": "now-90d", "to": "now-60d"},
                                {"from": "now-60d", "to": "now-30d"}]},
    }, turn_id="t", step=1)
    elapsed = time.monotonic() - started
    assert out.status == "ok", out.error
    assert conn.calls == 4                                   # the window and three compared periods
    assert elapsed < 2.0                                     # read together, not one after another
    assert len(out.observation["comparison"]["events"]["periods"]) == 4


# --------------------------------------------------------------------------- #
# 5. The counted share of a partial count
# --------------------------------------------------------------------------- #
class _FlakyRepo(CaseRepository):
    """A third-party case repository whose second page of every scan fails."""

    def __init__(self, cases: list[Case]) -> None:
        self.cases = {c.case_id: c for c in cases}
        self.pages = 0

    async def save(self, case: Case) -> None:
        self.cases[case.case_id] = case

    async def get(self, case_id: str) -> Case | None:
        return self.cases.get(case_id)

    async def find_open_by_signature(self, signature: str) -> Case | None:
        return None

    async def list(self, *, status=None, source_surface=None, entity_value=None, limit=50, offset=0,
                   sort_field="created_at", sort_order="desc"):
        rows = sorted(self.cases.values(), key=lambda c: (c.created_at, c.case_id), reverse=sort_order == "desc")
        return rows[offset: offset + limit], len(rows)

    async def list_scans(self, limit: int = 50):
        return [], 0

    async def count_new_scans(self, since_iso: str) -> int:
        return 0

    async def export_page(self, *, limit: int = 1000, cursor: Any = None):
        # Every scan reads its first page, then the store goes away.
        self.pages += 1
        if cursor is not None:
            raise RuntimeError("store went away")
        return await super().export_page(limit=limit, cursor=cursor)


async def test_a_partial_count_states_the_counted_share() -> None:
    cases = [_case(i, NOW - timedelta(hours=i + 1)) for i in range(2500)]
    ctx = make_ctx(cases=_FlakyRepo(cases))
    out = await CaseStatsTool().run(ctx, window="all")
    assert out.ok and out.observation["exact"] is False
    assert out.observation["counted"] == {"scanned": 1000, "expected_total": 2500}
    assert "counted 1,000 of 2,500 cases before the case store stopped answering" in (out.coverage or "")
    assert "1,000 of 2,500" in out.observation["partial"]
    ctx = make_ctx(cases=_FlakyRepo(cases))
    posture = await SocMetricsTool().run(ctx, kind="posture", window="all")
    assert posture.ok and posture.observation["counted"] == {"scanned": 1000, "expected_total": 2500}
    assert "counted 1,000 of 2,500 cases" in (posture.coverage or "")


async def test_partial_search_and_cost_state_the_counted_share(monkeypatch) -> None:
    from app.engine import case_aggregate

    def partial(**over: Any) -> AggregateResult:
        fields = dict(total=40, groups=[], buckets=[], exact=False, consistency="unverified", scanned=40,
                      partial=True, expected_total=None, window_label="all time")
        fields.update(over)
        return AggregateResult(**fields)

    async def fake_cases(store: Any, spec: Any, **kw: Any) -> AggregateResult:
        return partial()

    async def fake_usage(store: Any, spec: Any, **kw: Any) -> AggregateResult:
        return partial(totals={"cost_usd": 1.0, "calls": 40}, expected_total=90)

    monkeypatch.setattr(case_aggregate, "aggregate_cases", fake_cases)
    monkeypatch.setattr(case_aggregate, "aggregate_usage", fake_usage)
    store = await _store([_case(1, NOW - timedelta(hours=1))])

    found = await SearchCasesTool().run(make_ctx(cases=store), window="all")
    assert found.ok and found.observation["counted"] == {"scanned": 40, "expected_total": None}
    assert "counted 40 cases of an unknown total" in (found.coverage or "")
    usage = UsageStore(InMemoryESClient())
    spent = await CostUsageTool().run(make_ctx(usage=usage), window="now-30d")
    assert spent.ok and spent.observation["counted"] == {"scanned": 40, "expected_total": 90}
    assert "counted 40 of 90 ledger rows before the usage ledger stopped answering" in (spent.coverage or "")


# --------------------------------------------------------------------------- #
# 6. The time chip keeps months and years
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("raw", "canonical", "label", "start"), [
    ("now-6M", "now-6M", "last 6 months", datetime(2026, 4, 10, 12, 0, tzinfo=timezone.utc)),
    ("NOW-6M", "now-6M", "last 6 months", datetime(2026, 4, 10, 12, 0, tzinfo=timezone.utc)),
    ("now-12M", "now-12M", "last 12 months", datetime(2025, 10, 10, 12, 0, tzinfo=timezone.utc)),
    ("now-1y", "now-1y", "past year", datetime(2025, 10, 10, 12, 0, tzinfo=timezone.utc)),
    ("now-1Y", "now-1y", "past year", datetime(2025, 10, 10, 12, 0, tzinfo=timezone.utc)),
    ("now-6m", "now-6m", "last 6 minutes", datetime(2026, 10, 10, 11, 54, tzinfo=timezone.utc)),
])
def test_month_and_year_chips(raw: str, canonical: str, label: str, start: datetime) -> None:
    chip = TimeRange.model_validate({"from": raw})
    assert chip.from_ == canonical and chip.label() == label
    assert chip.resolve(FIXED) == (start, FIXED)
    assert chip.model_dump() == {"from": canonical, "to": "now"}


def test_a_months_chip_reaches_the_tools_as_months() -> None:
    chip = TimeRange.model_validate({"from": "now-6M"})
    window = resolve_window(make_ctx(time_range=chip), now=FIXED)
    assert window.source == "request" and window.label == "last 6 months"
    assert window.start == datetime(2026, 4, 10, 12, 0, tzinfo=timezone.utc)
    # A wider window the model asks for is clamped to six MONTHS, not six minutes.
    clamped = resolve_window(make_ctx(time_range=chip), window="now-1y", now=FIXED)
    assert clamped.clamped and clamped.start == window.start and clamped.label == "last 6 months"


# --------------------------------------------------------------------------- #
# 7. Same period last year of a week
# --------------------------------------------------------------------------- #
def test_same_week_last_year_is_the_same_iso_week() -> None:
    ctx = make_ctx()
    this_week = resolve_window(ctx, window="this_week", now=FIXED)
    shifted = same_period_last_year(this_week)
    assert shifted is not None
    assert shifted.start == datetime(2025, 10, 6, tzinfo=timezone.utc)          # Monday of W41 2025
    assert shifted.end == datetime(2025, 10, 11, 12, 0, tzinfo=timezone.utc)    # Saturday noon, like the subject
    assert shifted.start.weekday() == this_week.start.weekday() == 0
    assert shifted.label == "W41 2025 to date"
    last_week = resolve_window(ctx, window="last_week", now=FIXED)
    shifted = same_period_last_year(last_week)
    assert shifted is not None and shifted.label == "W40 2025"
    assert shifted.start == datetime(2025, 9, 29, tzinfo=timezone.utc)
    assert shifted.end == datetime(2025, 10, 6, tzinfo=timezone.utc)
    # A week 53 with no counterpart steps back 52 weeks (still Monday to Monday).
    w53 = resolve_window(ctx, window={"from": "2020-12-28", "to": "2021-01-03"}, now=FIXED)
    shifted = same_period_last_year(w53)
    assert shifted is not None and shifted.start == datetime(2019, 12, 30, tzinfo=timezone.utc)
    assert (shifted.end - shifted.start) == timedelta(days=7)
    # A month still shifts by twelve calendar months.
    month = same_period_last_year(resolve_window(ctx, window="this_month", now=FIXED))
    assert month is not None and month.start == datetime(2025, 10, 1, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# 8. The prompt names the lookups that take window_hours
# --------------------------------------------------------------------------- #
def test_prompt_says_log_lookups_take_window_not_window_hours() -> None:
    prompt = render_chat_agent_system("")
    assert "Any length; window_hours also works." not in prompt
    assert "search_logs and log_stats take window or time_from/time_to only" in prompt
    for model in (LogStatsInput, SearchLogsInput):
        _args, refused = parse_input(model, {"window_hours": 2160})
        assert refused is not None and "window_hours" in (refused.error or "")
