"""``soc_metrics`` / ``cost_usage`` label every figure with the window it was
COMPUTED over (chat revamp SPEC §3.1, §4.3; G4) and report a case-store outage as
"not measured", never as zero (G3)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from app.agents.chat_tools.common import resolve_window
from app.agents.chat_tools.metrics import (
    CASE_STORE_DOWN,
    CostUsageTool,
    SocMetricsTool,
    metric_window,
)
from app.api.metrics_shared import invalidate_case_page_cache
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import Case, Entity, TimeRange
from app.stores.cases import CaseStore
from app.utils import now_utc, to_millis

from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

PAST = TimeRange(**{"from": "2020-01-01T00:00:00Z", "to": "2020-01-02T00:00:00Z"})
PAST_LABEL = "2020-01-01 00:00 → 2020-01-02 00:00 UTC"


def _case(i: int, created: datetime, *, status: CaseStatus = CaseStatus.OPEN,
          verdict: Verdict = Verdict.NEEDS_HUMAN) -> Case:
    iso = created.isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value="203.0.113.9"), status=status, verdict=verdict,
        confidence=0.8, risk_score=40.0, title=f"case {i}", created_at=iso, updated_at=iso,
    )


@pytest.fixture
async def store() -> CaseStore:
    """Two cases inside 2020-01-01 (one still open), forty created in the last day."""
    invalidate_case_page_cache()
    cases = CaseStore(InMemoryESClient())
    day = datetime(2020, 1, 1, tzinfo=timezone.utc)
    await cases.save(_case(1, day + timedelta(hours=3)))
    await cases.save(_case(2, day + timedelta(hours=9), status=CaseStatus.CLOSED, verdict=Verdict.FALSE_POSITIVE))
    await cases.save(_case(3, day + timedelta(days=3)))  # after the range: must not count
    recent = now_utc() - timedelta(hours=2)
    for i in range(10, 50):
        await cases.save(_case(i, recent - timedelta(minutes=i)))
    yield cases
    invalidate_case_page_cache()


async def test_absolute_past_chip_counts_that_range_not_the_last_hours(store: CaseStore) -> None:
    ctx = make_ctx(cases=store, time_range=PAST)
    out = await SocMetricsTool().run(ctx, kind="posture")
    assert out.ok and out.observation["window"] == PAST_LABEL
    assert out.observation["case_count"] == 2  # not the 40 recent cases
    assert out.summary.startswith(f"Posture ({PAST_LABEL}): 2 cases")
    # open now is a stock over the whole page, measured now, and says so.
    open_now = out.observation["open_now"]
    assert open_now["count"] == 42 and open_now["window_exempt"] is True
    assert all(a.window.endswith(PAST_LABEL) for a in out.artifacts)
    assert out.artifacts[0].window == f"2 cases · exact · {PAST_LABEL}"
    assert_artifacts_render(out)

    mix = await SocMetricsTool().run(ctx, kind="case_mix")
    assert mix.observation["cases"] == 2 and mix.observation["by_verdict"] == {
        "NEEDS_HUMAN": 1, "FALSE_POSITIVE": 1}
    feedback = await SocMetricsTool().run(ctx, kind="feedback")
    assert feedback.ok and feedback.observation["window"] == PAST_LABEL

    trends = await SocMetricsTool().run(ctx, kind="trends")
    assert sum(v or 0 for v in trends.observation["opened"]) == 2 and trends.observation["bucket"] == "hour"
    series = trends.artifacts[0].data
    first = datetime.fromisoformat(series["x"][0])
    assert first == datetime(2020, 1, 1, tzinfo=timezone.utc)
    assert series["last_in_progress"] is False  # a past range has no partial bucket
    assert datetime.fromisoformat(series["x"][-1]) < datetime(2020, 1, 2, tzinfo=timezone.utc)


async def test_trailing_window_still_matches_the_dashboard(store: CaseStore) -> None:
    out = await SocMetricsTool().run(make_ctx(cases=store), kind="posture")
    assert out.observation["window"] == "last 24 hours" and out.observation["case_count"] == 40
    assert "requested_window" not in out.observation and out.coverage is None


async def test_ranges_longer_than_thirty_days_are_exact_and_never_capped(store: CaseStore) -> None:
    """Round 12 (SPEC D7): a 90-day range is read whole: no 30-day cap, no relabel."""
    ctx = make_ctx(cases=store, time_range=TimeRange(**{"from": "now-90d"}))
    out = await SocMetricsTool().run(ctx, kind="case_mix")
    assert out.observation["window"] == "last 90 days" and out.observation["cases"] == 40
    assert "requested_window" not in out.observation and "window_capped" not in out.observation
    assert out.coverage is None and out.summary.startswith("Case mix (last 90 days)")
    lifetime = await SocMetricsTool().run(make_ctx(cases=store), kind="case_mix", window="all")
    assert lifetime.observation["cases"] == 43 and lifetime.observation["window"].startswith("all time (since")


def test_metric_window_narrows_to_whole_hours_never_wider() -> None:
    now = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
    ninety_minutes = metric_window(resolve_window(make_ctx(), time_from="now-90m", now=now), now)
    assert (ninety_minutes.hours, ninety_minutes.label, ninety_minutes.trailing) == (1, "last hour", True)
    day = metric_window(resolve_window(make_ctx(time_range=PAST), now=now), now)
    assert (day.hours, day.label, day.trailing, day.relabelled) == (24, PAST_LABEL, False, False)
    assert day.end == datetime(2020, 1, 2, tzinfo=timezone.utc)


async def test_noise_counters_are_read_for_the_range_end() -> None:
    class Noise:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        async def read_window(self, hours: int, now: Any = None, *, end_exclusive: bool = False):
            self.calls.append({"hours": hours, "now": now, "end_exclusive": end_exclusive})
            return {"available": True, "since": "2019-01-01T00:00:00+00:00", "incomplete": False,
                    "ingested": {"high": 7}, "clustered": {"high": 3}, "suppressed": 0, "ignored": 0}

    invalidate_case_page_cache()
    noise = Noise()
    out = await SocMetricsTool().run(make_ctx(cases=CaseStore(InMemoryESClient()), noise=noise,
                                              time_range=PAST), kind="noise_funnel")
    assert out.ok and noise.calls == [{"hours": 24, "now": datetime(2020, 1, 2, tzinfo=timezone.utc),
                                       "end_exclusive": True}]
    assert out.observation["window"] == PAST_LABEL


class _BrokenCases:
    async def list(self, **kwargs: Any):
        raise RuntimeError("store down")


async def test_case_store_outage_is_not_measured_never_zero() -> None:
    invalidate_case_page_cache()
    for kind in ("posture", "case_mix", "timing", "trends", "feedback", "mitre_coverage",
                 "auto_close_health", "agent_improvement"):
        out = await SocMetricsTool().run(make_ctx(cases=_BrokenCases()), kind=kind)
        assert not out.ok and out.error == CASE_STORE_DOWN, kind
        assert "0 cases" not in out.summary and out.observation.get("case_store_unavailable") is True
        assert not out.artifacts

    class Noise:
        async def read_window(self, hours: int, now: Any = None, *, end_exclusive: bool = False):
            return {"available": True, "since": "2019-01-01T00:00:00+00:00", "incomplete": False,
                    "ingested": {"high": 12}, "clustered": {"high": 5}, "suppressed": 0, "ignored": 0}

    funnel = await SocMetricsTool().run(make_ctx(cases=_BrokenCases(), noise=Noise()), kind="noise")
    assert funnel.ok and funnel.observation["kind"] == "noise_funnel"
    assert funnel.observation["case_store_unavailable"] is True
    stages = {s["key"]: s["total"] for s in funnel.observation["stages"]}
    assert stages["ingested"] == 12 and stages["cases"] is None and stages["needs_human"] is None
    assert funnel.observation["reduction_pct"] == {"overall": None, "before_human": None}
    kpis = next(a for a in funnel.artifacts if a.kind == "kpis")
    assert all(item["value"] is None for item in kpis.data["items"])
    assert "not measured" in funnel.summary and "0 cases" not in funnel.summary
    assert_artifacts_render(funnel)


class _Usage:
    def __init__(self) -> None:
        self.hours: list[int] = []

    async def summary(self, window_hours: int = 24, case_id: str | None = None):
        self.hours.append(window_hours)
        now = to_millis(now_utc())
        return {"total_cost": 2.0, "total_tokens": 10, "call_count": 2, "today_cost": 1.0,
                "cost_over_time": [{"ts": now - 3_600_000, "cost": 1.0}, {"ts": now, "cost": 1.0}]}


async def test_cost_usage_on_a_summary_only_ledger_reads_trailing_windows_whole() -> None:
    """A third-party ledger with only a trailing ``summary()``: a past range is refused
    (it cannot be read), a 90-day range is read whole (Round 12: no 30-day cap)."""
    usage = _Usage()
    past = await CostUsageTool().run(make_ctx(usage=usage, time_range=PAST))
    assert not past.ok and "window that ends now" in (past.error or "") and usage.hours == []
    long = await CostUsageTool().run(make_ctx(usage=usage, time_range=TimeRange(**{"from": "now-90d"})))
    assert long.ok and usage.hours == [2160]
    assert long.observation["window"] == "last 90 days" and "requested_window" not in long.observation
    assert long.summary.startswith("AI spend (last 90 days)") and long.coverage is None
    plain = await CostUsageTool().run(make_ctx(usage=usage))
    assert plain.observation["window"] == "last 24 hours" and plain.coverage is None


async def test_metric_observations_flag_a_window_the_chip_narrowed(store: CaseStore) -> None:
    """Like the log tools, a metric observation says (structurally) when the request's
    time chip narrowed the window the model asked for, so a planner or model never
    has to compare a trailing label with the hours the question named."""
    chip = TimeRange(**{"from": "now-6h"})
    narrowed = await SocMetricsTool().run(make_ctx(cases=store, time_range=chip), kind="posture", window_hours=24)
    assert narrowed.ok and narrowed.observation["window_clamped_to_request"] is True
    assert narrowed.observation["window"] == "last 6 hours"
    assert "window limited to the selected range" in (narrowed.coverage or "")
    inside = await SocMetricsTool().run(make_ctx(cases=store, time_range=chip), kind="posture", window_hours=2)
    assert inside.observation["window_clamped_to_request"] is False
    plain = await SocMetricsTool().run(make_ctx(cases=store), kind="case_mix")
    assert plain.observation["window_clamped_to_request"] is False
    usage = _Usage()
    cost = await CostUsageTool().run(make_ctx(usage=usage, time_range=chip), window_hours=48)
    assert cost.ok and cost.observation["window_clamped_to_request"] is True and usage.hours == [6]
