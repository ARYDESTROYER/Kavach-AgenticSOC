"""Round 12 final review, L2: alert-counter coverage on the chat metrics.

The durable noise counters keep at most 90 days of hourly buckets and start at their
first observation (``since``). Every reader must say what they really cover:

* ``NoiseCounterStore`` reports ``coverage_start`` (``since`` bounded by the
  retention floor) and an all-time read is ``incomplete`` once retention pruned part
  of the history (it never claims "complete" just because no window start was given).
* ``build_noise_reduction`` marks the counters ``incomplete`` when a counted case was
  opened before they began, so an all-time funnel never divides all-time cases by a
  shorter span of alerts.
* ``soc_metrics noise_funnel`` withholds the overall reduction under the Noise
  Reduction dashboard's partial-coverage rule (``NoiseFunnel.tsx`` ``alertReductionOf``)
  and says why, in the KPI, the captions, the summary, the coverage note and the
  observation.
* ``soc_metrics trends`` draws a bucket before the counters' coverage as not measured
  (``None``), never as 0 alerts (the dashboard ``trend_metrics`` rule).
* Run-log summaries say "not measured" rather than "— min", keep fractional minutes,
  and never wrap a window label in a second pair of parentheses.

Offline (fake ES, in-memory KV). Advisory metrics only; nothing here reaches
``decide()`` (#3)."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import pytest

from app.agents.chat_tools.metrics import SocMetricsTool, _duration_text, _headed
from app.agents.chat_tools.stats import CaseStatsTool
from app.api.metrics_shared import invalidate_case_page_cache, invalidate_case_population_cache
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.noise_counters import build_noise_reduction
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, StatusHistoryEntry, TimeRange
from app.stores.cases import CaseStore
from app.stores.noise_counters import _RETENTION_HOURS, NoiseCounterStore

from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

NOW = datetime.now(timezone.utc)


class _MemKV:
    """The minimal KVStore surface ``NoiseCounterStore`` uses (offline)."""

    def __init__(self) -> None:
        self.docs: dict[tuple[str, str], dict] = {}

    async def get(self, ns: str, key: str):
        return self.docs.get((ns, key))

    async def put(self, ns: str, key: str, value: dict) -> None:
        self.docs[(ns, key)] = value

    async def put_if(self, ns: str, key: str, value: dict, rev=None) -> bool:
        self.docs[(ns, key)] = value
        return True

    async def delete(self, ns: str, key: str) -> None:
        self.docs.pop((ns, key), None)


def _case(i: int, created: datetime, *, status: CaseStatus = CaseStatus.OPEN,
          verdict: Verdict | None = Verdict.NEEDS_HUMAN, decision_by: DecisionBy | None = None,
          history: list[StatusHistoryEntry] | None = None) -> Case:
    stamp = created.isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=f"198.51.100.{i % 250}"), status=status, verdict=verdict,
        confidence=0.8, risk_score=40.0, title=f"Case {i}", created_at=stamp, updated_at=stamp,
        decision_by=decision_by, status_history=list(history or []),
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


async def _counters_last_days(days: int, per_hour: int) -> NoiseCounterStore:
    """Counters that began ``days`` ago: ``per_hour`` alerts ingested every 6 hours."""
    store = NoiseCounterStore(_MemKV())
    for hours_ago in range(days * 24, 0, -6):
        await store.record({"ingested": {"high": per_hour}, "clustered": {"high": 1}},
                           now=NOW - timedelta(hours=hours_ago))
    return store


def _kpi(out: Any, key: str) -> dict[str, Any]:
    kpis = next(a for a in out.artifacts if a.kind == "kpis")
    return next(item for item in kpis.data["items"] if item["key"] == key)


# --------------------------------------------------------------------------- #
# The counter store
# --------------------------------------------------------------------------- #
async def test_all_time_read_reports_coverage_and_is_complete_while_nothing_was_pruned() -> None:
    store = NoiseCounterStore(_MemKV())
    first = NOW - timedelta(days=10)
    await store.record({"ingested": {"high": 3}}, now=first)
    await store.record({"ingested": {"high": 4}}, now=NOW)
    whole = await store.read_window(0, now=NOW)
    assert whole["available"] is True and whole["incomplete"] is False
    assert whole["since"] == first.isoformat()
    assert datetime.fromisoformat(whole["coverage_start"]) == first
    hourly = await store.read_hourly_ingested(0, now=NOW)
    assert hourly["coverage_start"] == whole["coverage_start"]


async def test_all_time_read_is_incomplete_once_retention_pruned_the_oldest_hours() -> None:
    """Before: ``incomplete`` was computed only for ``hours > 0``, so an all-time read
    of a store older than its 90-day retention claimed to be complete."""
    store = NoiseCounterStore(_MemKV())
    await store.record({"ingested": {"high": 1}}, now=NOW - timedelta(days=120))
    await store.record({"ingested": {"high": 2}}, now=NOW)   # prunes the 120-day-old hour
    whole = await store.read_window(0, now=NOW)
    assert whole["available"] is True
    assert whole["incomplete"] is True
    assert whole["since"] == (NOW - timedelta(days=120)).isoformat()   # first-ever, kept
    floor_hour = int(NOW.timestamp() // 3600) - _RETENTION_HOURS
    assert datetime.fromisoformat(whole["coverage_start"]).timestamp() == floor_hour * 3600
    hourly = await store.read_hourly_ingested(0, now=NOW)
    assert hourly["coverage_start"] == whole["coverage_start"]
    # A bounded window inside retention is still complete.
    assert (await store.read_window(24, now=NOW))["incomplete"] is False


async def test_unavailable_counters_report_no_coverage() -> None:
    store = NoiseCounterStore(_MemKV())
    empty = await store.read_window(0, now=NOW)
    assert empty["available"] is False and empty["coverage_start"] is None
    assert (await store.read_hourly_ingested(24, now=NOW))["coverage_start"] is None


# --------------------------------------------------------------------------- #
# The shared rollup (dashboard and chat)
# --------------------------------------------------------------------------- #
def _counters(coverage: datetime, *, incomplete: bool = False) -> dict[str, Any]:
    return {"available": True, "since": coverage.isoformat(), "coverage_start": coverage.isoformat(),
            "incomplete": incomplete, "ingested": {"high": 100}, "clustered": {"high": 10},
            "suppressed": 0, "ignored": 0}


def test_an_all_time_rollup_with_cases_older_than_the_counters_is_partial() -> None:
    coverage = NOW - timedelta(days=3)
    cases = [_case(1, NOW - timedelta(days=200)), _case(2, NOW - timedelta(hours=2))]
    out = build_noise_reduction(cases, _counters(coverage), window_hours=0, generated_at=NOW.isoformat(), now=NOW)
    assert out["counters"]["incomplete"] is True
    assert out["counters"]["coverage_start"] == coverage.isoformat()
    covered = build_noise_reduction(cases[1:], _counters(coverage), window_hours=0,
                                    generated_at=NOW.isoformat(), now=NOW)
    assert covered["counters"]["incomplete"] is False


def test_a_case_opened_earlier_in_the_counters_first_hour_is_covered() -> None:
    """A poll tick opens its cases before it records its alerts, so a case a few
    minutes before ``since`` in the same hour is not "older than the counters"."""
    coverage = datetime(2026, 10, 1, 10, 30, tzinfo=timezone.utc)
    same_hour = [_case(1, coverage - timedelta(minutes=20))]
    hour_before = [_case(2, coverage - timedelta(minutes=45))]
    earlier = [_case(3, coverage - timedelta(minutes=95))]   # 08:55, before 09:00
    kwargs: dict[str, Any] = {"window_hours": 0, "generated_at": NOW.isoformat(), "now": NOW}
    assert build_noise_reduction(same_hour, _counters(coverage), **kwargs)["counters"]["incomplete"] is False
    # The first tick may cross an hour boundary: one full counter hour of grace.
    assert build_noise_reduction(hour_before, _counters(coverage), **kwargs)["counters"]["incomplete"] is False
    assert build_noise_reduction(earlier, _counters(coverage), **kwargs)["counters"]["incomplete"] is True


async def test_a_first_tick_that_crosses_an_hour_boundary_keeps_lifetime_funnels_complete() -> None:
    """Before: the first tick opened its cases at 21:57-21:59 (investigations run
    before the alert delta is written) and recorded its alerts at 22:02, so every
    case predated the 22:00 floor of ``since`` and every all-time funnel was flagged
    incomplete for good, with the overall reduction withheld."""
    written = (NOW - timedelta(days=2)).replace(minute=2, second=0, microsecond=0)
    opened = [written - timedelta(minutes=5 - i) for i in range(3)]          # :57, :58, :59
    population = [_case(i, at) for i, at in enumerate(opened)] + [_case(10, written + timedelta(minutes=1))]
    cases = await _store(population)
    noise = NoiseCounterStore(_MemKV())
    await noise.record({"ingested": {"high": 40}, "clustered": {"high": 4}}, now=written)
    await noise.record({"ingested": {"high": 60}, "clustered": {"high": 6}}, now=NOW - timedelta(hours=1))

    counters = await noise.read_window(0, now=NOW)
    assert counters["since"] == written.isoformat() and counters["incomplete"] is False
    rollup = build_noise_reduction(population, counters, window_hours=0,
                                   generated_at=NOW.isoformat(), now=NOW)
    assert rollup["counters"]["incomplete"] is False
    assert rollup["reduction"]["overall_pct"] == 96.0   # 1 - 4 needing a human / 100 alerts

    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window="all")
    assert out.ok and out.observation["counters"]["incomplete"] is False
    assert out.observation["reduction_pct"]["overall"] == 96.0
    assert "overall_reduction_withheld" not in out.observation
    assert "alert_stages_note" not in out.observation
    assert "different spans" not in out.summary and out.coverage is None


def test_a_reader_without_coverage_start_falls_back_to_since() -> None:
    since = NOW - timedelta(days=3)
    counters = {"available": True, "since": since.isoformat(), "incomplete": False,
                "ingested": {"high": 5}, "clustered": {"high": 1}}
    out = build_noise_reduction([_case(1, NOW - timedelta(days=30))], counters, window_hours=0,
                                generated_at=NOW.isoformat(), now=NOW)
    assert out["counters"]["incomplete"] is True and out["counters"]["coverage_start"] == since.isoformat()


# --------------------------------------------------------------------------- #
# The chat funnel (the verifier's reproduction)
# --------------------------------------------------------------------------- #
async def _old_and_recent_store() -> CaseStore:
    old = [_case(i, NOW - timedelta(days=150 + i * 3)) for i in range(1, 31)]
    recent = [_case(100 + i, NOW - timedelta(hours=2, minutes=i), status=CaseStatus.CLOSED,
                    verdict=Verdict.FALSE_POSITIVE, decision_by=DecisionBy.AGENT) for i in range(9)]
    recent.append(_case(200, NOW - timedelta(hours=3)))
    return await _store(old + recent)


async def test_an_all_time_funnel_never_mixes_all_time_cases_with_newer_alerts() -> None:
    cases = await _old_and_recent_store()
    noise = await _counters_last_days(5, per_hour=50)   # 1,000 alerts over the last 5 days
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window="all")
    assert out.ok
    stages = {s["key"]: s["total"] for s in out.observation["stages"]}
    assert stages["ingested"] == 1000 and stages["cases"] == 40 and stages["needs_human"] == 31
    # Before: overall 96.9% (1 - 31/1000) presented as exact, incomplete False.
    assert out.observation["reduction_pct"]["overall"] is None
    assert out.observation["counters"]["incomplete"] is True
    assert out.observation["counters"]["coverage_start"]
    assert out.observation["overall_reduction_withheld"].startswith("alert counters start ")
    assert "different spans" in out.observation["alert_stages_note"]
    overall = _kpi(out, "overall_reduction")
    assert overall["value"] is None and overall["context"].startswith("alert counters start ")
    # The case-only reduction (both halves from one population) is still given.
    assert _kpi(out, "human_reduction")["value"] is not None
    funnel = next(a for a in out.artifacts if a.kind == "funnel")
    assert "alerts counted from" in (funnel.window or "")
    assert "overall reduction is not given" in out.summary
    assert "alert counters cover only from" in (out.coverage or "")
    assert out.summary.startswith("Noise funnel, all time")
    assert_artifacts_render(out)


async def test_a_six_month_funnel_with_partial_counters_withholds_the_overall_kpi() -> None:
    cases = await _old_and_recent_store()
    noise = await _counters_last_days(5, per_hour=50)
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window="now-6M")
    assert out.ok and out.observation["counters"]["incomplete"] is True
    assert out.observation["reduction_pct"]["overall"] is None
    assert _kpi(out, "overall_reduction")["value"] is None
    assert "alert counters cover only from" in (out.coverage or "")


async def test_a_window_the_counters_fully_cover_keeps_its_overall_reduction() -> None:
    cases = await _old_and_recent_store()
    noise = await _counters_last_days(5, per_hour=50)
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window="now-24h")
    assert out.ok and out.observation["counters"]["incomplete"] is False
    assert out.observation["reduction_pct"]["overall"] is not None
    assert "overall_reduction_withheld" not in out.observation
    assert _kpi(out, "overall_reduction")["value"] is not None and "context" not in _kpi(out, "overall_reduction")
    assert out.coverage is None


async def test_a_partial_case_tally_withholds_the_overall_reduction(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.agents.chat_tools import metrics as metrics_module

    cases = await _store([_case(i, NOW - timedelta(hours=1, minutes=i)) for i in range(6)])
    noise = await _counters_last_days(5, per_hour=50)
    monkeypatch.setattr(metrics_module, "_POPULATION_LIMIT", 2)
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window="now-24h")
    assert out.ok and out.basis == "sample"
    assert out.observation["reduction_pct"]["overall"] is None
    assert out.observation["overall_reduction_withheld"] == "case counts are partial"
    assert "newest 2 of 6" in (out.coverage or "")


class _BrokenCases:
    async def list(self, **kwargs: Any):
        raise RuntimeError("store down")


def _assert_alert_half_not_measured(out: Any) -> None:
    """The alert stages of a funnel whose window the counters never reached: null,
    never a measured 0, with the reason named everywhere a reader looks."""
    assert out.ok
    stages = {s["key"]: s["total"] for s in out.observation["stages"]}
    assert stages["ingested"] is None and stages["clustered"] is None, stages
    funnel = next(a for a in out.artifacts if a.kind == "funnel")
    assert funnel.data["values"][:2] == [None, None], funnel.data
    assert "alerts not measured" in (funnel.window or "")
    assert out.observation["alert_stages_not_measured"] is True
    assert "not measured" in out.observation["alert_stages_note"]
    assert "count only from" not in out.observation["alert_stages_note"]
    assert out.observation["reduction_pct"]["overall"] is None
    assert "alerts not measured in this window" in out.summary
    assert "0 alerts" not in out.summary and "alert counters cover only" not in out.summary
    assert "alerts not measured in this window" in (out.coverage or "")
    assert_artifacts_render(out)


async def test_a_past_window_before_the_counters_began_reports_alerts_not_measured() -> None:
    """Before: a calendar window wholly before ``coverage_start`` (here two years back,
    the counters began an hour ago) read "0 alerts ingested" beside a non-zero case
    count, as if measured."""
    year = NOW.year - 2
    opened = datetime(year, 6, 15, 12, tzinfo=timezone.utc)
    cases = await _store([_case(i, opened + timedelta(hours=i)) for i in range(5)]
                         + [_case(50, NOW - timedelta(minutes=30))])
    noise = NoiseCounterStore(_MemKV())
    await noise.record({"ingested": {"high": 70}, "clustered": {"high": 7}}, now=NOW - timedelta(hours=1))

    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window=str(year))
    _assert_alert_half_not_measured(out)
    stages = {s["key"]: s["total"] for s in out.observation["stages"]}
    assert stages["cases"] == 5 and stages["needs_human"] == 5
    assert out.observation["reduction_pct"]["before_human"] is not None   # the case-only figure stays
    overall = _kpi(out, "overall_reduction")
    assert overall["value"] is None and overall["context"] == "alerts not measured in this window"
    assert out.observation["overall_reduction_withheld"] == "alerts not measured in this window"
    assert out.summary.startswith(f"Noise funnel, {year}: alerts not measured in this window; 5 cases"), out.summary
    assert "so the overall reduction is not given" in (out.coverage or "")

    # The case store failing too: both halves say "not measured", neither reads 0.
    down = await SocMetricsTool().run(make_ctx(cases=_BrokenCases(), noise=noise), kind="noise_funnel",
                                      window=str(year))
    assert down.ok and down.observation["case_store_unavailable"] is True
    assert {s["key"]: s["total"] for s in down.observation["stages"]}["ingested"] is None
    assert "alerts not measured in this window; case stages not measured" in down.summary

    # A window the counters reach keeps its measured alert half.
    live = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window="now-24h")
    assert {s["key"]: s["total"] for s in live.observation["stages"]}["ingested"] == 70
    assert "alert_stages_not_measured" not in live.observation


async def test_a_past_window_older_than_counter_retention_reports_alerts_not_measured() -> None:
    """The 90-day retention: a month wholly before the retention floor is not
    measured even though the counters' first observation (``since``) predates it."""
    month_day = NOW - timedelta(days=200)
    token = f"{month_day.year}-{month_day.month:02d}"
    cases = await _store([_case(i, month_day.replace(day=10, hour=9) + timedelta(hours=i)) for i in range(3)])
    noise = NoiseCounterStore(_MemKV())
    await noise.record({"ingested": {"high": 9}}, now=NOW - timedelta(days=400))
    await noise.record({"ingested": {"high": 30}, "clustered": {"high": 3}}, now=NOW)   # prunes the old hour

    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="noise_funnel", window=token)
    _assert_alert_half_not_measured(out)
    assert {s["key"]: s["total"] for s in out.observation["stages"]}["cases"] == 3


def test_demo_noise_answer_never_narrates_unmeasured_alerts_as_zero() -> None:
    from app.engine.demo_chat import plan_turn
    from tests.test_demo_chat_planner import NOISE_ARTS, NOISE_OBS, call, final_of, prompt

    stages = [{"key": "ingested", "total": None}, {"key": "clustered", "total": None},
              {"key": "cases", "total": 5.0}, {"key": "needs_human", "total": 2.0}]
    unmeasured = {**NOISE_OBS, "window": "2024", "stages": stages,
                  "reduction_pct": {"overall": None, "before_human": 60.0},
                  "counters": {"available": True, "incomplete": True},
                  "alert_stages_not_measured": True,
                  "overall_reduction_withheld": "alerts not measured in this window"}
    _header, body = final_of(plan_turn(prompt("Show the noise funnel",
                                              [call("soc_metrics", unmeasured, artifacts=NOISE_ARTS)])))
    assert "alerts were not measured; 5 cases opened, and **2 needed a human**" in body, body
    assert "0 alerts" not in body and "lower bound" not in body
    assert "so its alerts were not counted and no overall reduction is given" in body


# --------------------------------------------------------------------------- #
# The alert trend series
# --------------------------------------------------------------------------- #
class _HourlyNoise:
    """A counter reader whose observations began at ``since`` (161 alerts in the latest
    hour that began before ``now``).

    ``since`` is an instant, or a function of the ``now`` the tool passes (its window
    end), so the counters and the tool's buckets share one clock. A fixed
    ``NOW - 3h`` made the trend test depend on the time of day: run in the first three
    hours after UTC midnight it began in yesterday's bucket, which the series rightly
    counts as a partly measured day."""

    def __init__(self, since: datetime | Callable[[datetime], datetime], *, coverage: datetime | None = None,
                 total: int = 161) -> None:
        self.since = since
        self.coverage = coverage
        self.total = total

    async def read_hourly_ingested(self, hours: int, now: Any = None) -> dict[str, Any]:
        ref = now if isinstance(now, datetime) else NOW
        since = self.since(ref) if callable(self.since) else self.since
        first = int(since.timestamp() // 3600)
        last = math.ceil(ref.timestamp() / 3600) - 1   # the latest hour that began before now
        hours_map = {h: 0 for h in range(first, last + 1)}
        if first <= last:
            hours_map[last] = self.total
        out: dict[str, Any] = {"available": True, "since": since.isoformat(), "hours": hours_map}
        if self.coverage is not None:
            out["coverage_start"] = self.coverage.isoformat()
        return out


def _began_earlier_today(hours: int) -> Callable[[datetime], datetime]:
    """Counters that began ``hours`` before ``now``, but strictly inside ``now``'s UTC
    day (the default operator timezone), so only the latest day and month buckets are
    measured and the coverage start cuts them, at any time of day."""

    def since(now: datetime) -> datetime:
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return max(now - timedelta(hours=hours), midnight + (now - midnight) / 2)

    return since


def _began_after(now: datetime) -> datetime:
    """Counters that began after the window the tool asked about had ended."""
    return now + timedelta(hours=1)


async def _spread_store() -> CaseStore:
    return await _store([_case(i, NOW - timedelta(days=i * 20)) for i in range(11)])


async def test_trend_buckets_before_the_counters_began_are_not_measured_never_zero() -> None:
    """Before: every bucket started at 0, so months before the counters existed read
    as measured zero alerts (a fake surge)."""
    cases = await _spread_store()
    noise = _HourlyNoise(_began_earlier_today(3))
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="trends", window="all",
                                     bucket="month")
    assert out.ok
    alerts = out.observation["alerts"]
    assert alerts[-1] == 161 and all(v is None for v in alerts[:-1]), alerts
    assert out.observation["alerts_from"]
    assert "not measured" in out.observation["alerts_note"]
    assert out.observation["buckets"][-1].get("alerts_from")
    chart = next(a for a in out.artifacts if a.title == "Alerts ingested over time")
    assert chart.data["series"][0]["values"] == alerts
    assert (chart.window or "").startswith("alerts counted from ")
    assert out.summary.startswith("Trends by month, all time")
    assert_artifacts_render(out)

    week = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="trends", window="now-7d",
                                      bucket="day")
    daily = week.observation["alerts"]
    assert daily[-1] == 161 and all(v is None for v in daily[:-1]), daily


async def test_trend_buckets_older_than_retention_are_not_measured() -> None:
    """A store older than its 90-day retention: ``since`` is a year ago, but the
    retained hours start at the retention floor, so earlier months are not measured."""
    cases = await _spread_store()
    floor = NOW - timedelta(days=90)
    noise = _HourlyNoise(NOW - timedelta(days=365), coverage=floor, total=40)
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="trends", window="now-6M",
                                     bucket="month")
    alerts = out.observation["alerts"]
    starts = [datetime.fromisoformat(x) for x in next(a for a in out.artifacts if a.kind == "series").data["x"]]
    ends = starts[1:] + [NOW]
    for value, end in zip(alerts, ends):
        if end <= floor:
            assert value is None, alerts
        else:
            assert value is not None, alerts
    assert any(v is None for v in alerts) and alerts[-1] == 40


async def test_a_window_wholly_before_the_counters_has_no_alert_chart() -> None:
    cases = await _spread_store()
    noise = _HourlyNoise(_began_after)
    out = await SocMetricsTool().run(make_ctx(cases=cases, noise=noise), kind="trends", window="last_month",
                                     bucket="day")
    assert out.ok
    assert all(v is None for v in out.observation["alerts"])
    assert not any(a.title == "Alerts ingested over time" for a in out.artifacts)


# --------------------------------------------------------------------------- #
# Run-log summaries
# --------------------------------------------------------------------------- #
def test_duration_text_keeps_fractions_and_names_unmeasured() -> None:
    assert _duration_text(None) == "not measured"
    assert _duration_text(1.9) == "1.9 min"
    assert _duration_text(0.4) == "0.4 min"
    assert _duration_text(0) == "0 min" and _duration_text(0.02) == "under 0.1 min"
    assert _duration_text(45) == "45 min"
    assert _duration_text(150) == "2.5 h"
    assert _headed("Response times", "all time (since 28 Mar 2026)") == "Response times, all time (since 28 Mar 2026)"


async def test_timing_summary_says_not_measured_and_keeps_fractional_minutes() -> None:
    """Before: "Response times (all time (since …)): MTTA median — min, MTTR median 1 min"."""
    cases = []
    for i in range(5):
        created = NOW - timedelta(days=2, hours=i)
        closed = created + timedelta(minutes=1.9)
        cases.append(_case(i, created, status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE,
                           decision_by=DecisionBy.AGENT,
                           history=[StatusHistoryEntry(from_status="new", to_status="closed", by="agent",
                                                       at=closed.isoformat())]))
    store = await _store(cases)
    out = await SocMetricsTool().run(make_ctx(cases=store), kind="timing", window="all")
    assert out.ok
    assert out.summary.startswith("Response times, all time (since "), out.summary
    assert "((" not in out.summary and "))" not in out.summary
    assert "MTTA median not measured" in out.summary and "— min" not in out.summary
    assert "MTTR median 1.9 min" in out.summary, out.summary


async def test_case_stats_summary_never_nests_the_window_label() -> None:
    store = await _store([_case(i, NOW - timedelta(days=i)) for i in range(1, 4)])
    out = await CaseStatsTool().run(make_ctx(cases=store), window="all", group_by=["verdict"])
    assert out.ok and "((" not in out.summary and "))" not in out.summary
    assert out.summary.startswith("3 cases, all time (since "), out.summary
    assert out.summary.endswith(", exact, grouped by verdict"), out.summary
    past = await CaseStatsTool().run(make_ctx(cases=store, time_range=TimeRange(**{"from": "now-90d"})))
    assert past.summary.startswith("3 cases, last 90 days, exact"), past.summary


# --------------------------------------------------------------------------- #
# Demo Mode narrates a withheld reduction without a "not measured" headline
# --------------------------------------------------------------------------- #
def test_demo_noise_answer_leads_with_the_stages_when_the_reduction_is_withheld() -> None:
    from app.engine.demo_chat import plan_turn
    from tests.test_demo_chat_planner import NOISE_ARTS, NOISE_OBS, call, final_of, prompt

    partial = {**NOISE_OBS, "window": "all time",
               "reduction_pct": {"overall": None, "before_human": 91.0},
               "counters": {"available": True, "incomplete": True},
               "overall_reduction_withheld": "alert counters start 11 Oct 2026 09:14"}
    _header, body = final_of(plan_turn(prompt("Show the noise funnel",
                                              [call("soc_metrics", partial, artifacts=NOISE_ARTS)])))
    assert body.startswith("**Noise reduction** over all time: 500 alerts ingested"), body
    assert "not measured noise reduction" not in body
    assert "no overall reduction is given (alerts and cases cover different spans)" in body

    sampled = {**NOISE_OBS, "reduction_pct": {"overall": None, "before_human": 91.0},
               "overall_reduction_withheld": "case counts are partial"}
    _header, body = final_of(plan_turn(prompt("Show the noise funnel",
                                              [call("soc_metrics", sampled, artifacts=NOISE_ARTS)])))
    assert "No overall reduction is given: the case counts for this window are partial." in body


async def test_a_time_of_day_range_reads_in_the_operator_zone_never_the_raw_utc_form() -> None:
    """A past range whose span is not whole hours (09:00 to 17:30) is narrowed to whole
    hours for the hour-based engines. The narrowed range used to be relabelled in the
    raw UTC arrow form ("2026-09-03 04:00 → 2026-10-11 12:00 UTC") beside posture's
    operator-zone words, mixing two zones in one sentence and reaching report scopes."""
    from app.config import Preferences
    from zoneinfo import ZoneInfo

    prefs = Preferences()
    prefs.sla.timezone = "Asia/Kolkata"
    zone = ZoneInfo("Asia/Kolkata")
    start = (NOW - timedelta(days=40)).astimezone(zone).replace(hour=9, minute=0, second=0, microsecond=0)
    end = (NOW - timedelta(days=1)).astimezone(zone).replace(hour=17, minute=30, second=0, microsecond=0)
    window = {"from": start.isoformat(), "to": end.isoformat()}
    cases = await _store([_case(i, start.astimezone(timezone.utc) + timedelta(days=i)) for i in range(4)])
    noise = await _counters_last_days(3, 10)
    ctx = make_ctx(cases=cases, noise=noise, prefs=prefs)
    for kind in ("noise_funnel", "mitre_coverage"):
        out = await SocMetricsTool().run(ctx, kind=kind, window=window)
        assert out.ok, out.error
        texts = [out.summary, str(out.observation.get("window") or "")] + [a.window or "" for a in out.artifacts]
        for text in texts:
            assert "→" not in text and "UTC" not in text, (kind, text)
        assert out.observation["window"].endswith("(Asia/Kolkata)"), out.observation["window"]
        assert "narrowed to whole hours" in (out.coverage or ""), out.coverage
    posture = await SocMetricsTool().run(ctx, kind="posture", window=window)
    assert posture.observation["window"].endswith("(Asia/Kolkata)") and "→" not in posture.observation["window"]
