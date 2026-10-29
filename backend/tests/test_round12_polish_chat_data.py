"""Round 12 final polish, chat data presentation (the live screenshot tour).

* Severity, verdict, status and priority breakdowns keep their canonical order
  (Critical, High, Medium, Low, Info) in every chart, legend, table and report, and a
  severity or verdict series carries its palette key, so Critical is never drawn in a
  categorical green (SPEC §7.2 decision 27).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from app.agents.blocks import MaterialiseOptions, revise_view, to_blocks
from app.agents.chat_tools.stats import CaseStatsTool, canonical_rows
from app.api.metrics_shared import invalidate_case_page_cache, invalidate_case_population_cache
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.es.fake import InMemoryESClient
from app.models import Case, Entity
from app.stores.cases import CaseStore

from tests.test_chat_tools_support import assert_artifacts_render, make_ctx

NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _fresh_caches() -> Any:
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    yield
    invalidate_case_page_cache()
    invalidate_case_population_cache()


def _case(i: int, severity: str, *, verdict: Verdict | None = Verdict.NEEDS_HUMAN,
          status: CaseStatus = CaseStatus.OPEN, days_ago: float = 1.0, rule: str = "r") -> Case:
    stamp = (NOW - timedelta(days=days_ago)).isoformat()
    return Case(
        case_id=f"case-{i:04d}", cluster_signature=f"sig-{i}", source_surface=SourceSurface.INVESTIGATE,
        entity=Entity(type=EntityType.IP, value=f"198.51.100.{i % 250}"), status=status, verdict=verdict,
        confidence=0.8, risk_score=10.0 + i % 50, title=f"Case {i}", rule_ids=[rule],
        severity_band=severity, created_at=stamp, updated_at=stamp,
    )


async def _store(cases: list[Case]) -> CaseStore:
    store = CaseStore(InMemoryESClient())
    for case in cases:
        await store.save(case)
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    return store


def _volume_skewed() -> list[Case]:
    """Most cases Low, then High, then Critical, then Medium: a volume ranking would
    read Low, High, Critical, Medium (the screenshot tour's legend)."""
    spec = [("low", 9), ("high", 5), ("critical", 3), ("medium", 2)]
    cases: list[Case] = []
    for severity, n in spec:
        for _ in range(n):
            cases.append(_case(len(cases), severity, days_ago=1 + len(cases) % 3))
    return cases


def _block(artifact: Any, view: str | None = None) -> dict[str, Any]:
    (block,) = to_blocks(artifact, MaterialiseOptions(block_id="b1", view=view))
    return block


async def test_severity_by_day_series_read_critical_first_in_severity_colours() -> None:
    store = await _store(_volume_skewed())
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="severity", bucket="day", window="now-7d")
    assert out.ok, out.error
    assert_artifacts_render(out)
    series = next(a for a in out.artifacts if a.kind == "series")
    assert [s["label"] for s in series.data["series"]] == ["Critical", "High", "Medium", "Low"]
    assert [s["semantic"] for s in series.data["series"]] == ["critical", "high", "medium", "low"]
    assert series.data["ordered"] is True
    for view in ("stacked_bar", "line", "table"):
        block = _block(series, view)
        if block["type"] == "chart":
            assert [s["label"] for s in block["series"]] == ["Critical", "High", "Medium", "Low"]
            assert [s.get("semantic") for s in block["series"]] == ["critical", "high", "medium", "low"]
        else:
            assert [c["label"] for c in block["columns"][1:]] == ["Critical", "High", "Medium", "Low"]


async def test_severity_categories_and_breakdown_table_read_in_canonical_order() -> None:
    store = await _store(_volume_skewed())
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="severity", metrics="count,mean_risk")
    assert out.ok, out.error
    cats = next(a for a in out.artifacts if a.kind == "categories")
    # Round 14 (SPEC §4.7.2): a severity breakdown always names all five levels in the
    # canonical order, a level with no case included (Info 0 here).
    assert cats.data["kind"] == "severity"
    assert cats.data["labels"] == ["Critical", "High", "Medium", "Low", "Info"]
    assert cats.data["values"] == [3, 5, 2, 9, 0]
    for view in ("donut", "hbar", "table"):
        block = _block(cats, view)
        labels = (block["x"]["values"] if block["type"] == "chart" else [r[0] for r in block["rows"]])
        assert labels == ["Critical", "High", "Medium", "Low", "Info"], view
    table = next(a for a in out.artifacts if a.kind == "table")
    assert [r[0] for r in table.data["rows"]] == ["Critical", "High", "Medium", "Low"]
    # The observation lists the groups the same way, so the answer names them in order.
    assert [g["key"]["severity"] for g in out.observation["groups"]] == ["Critical", "High", "Medium", "Low"]


async def test_a_new_view_of_a_stored_block_keeps_its_order() -> None:
    store = await _store(_volume_skewed())
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="severity")
    cats = next(a for a in out.artifacts if a.kind == "categories")
    stored = _block(cats, "hbar")
    for view in ("donut", "table", "bar"):
        revised = revise_view(stored, view, block_id="b2")
        assert revised is not None, view
        labels = revised["x"]["values"] if revised["type"] == "chart" else [r[0] for r in revised["rows"]]
        # The five named levels (Round 14 SPEC §4.7.2), Info included at 0.
        assert labels == ["Critical", "High", "Medium", "Low", "Info"], view


def test_a_top_n_of_an_ordered_breakdown_keeps_the_busiest_then_their_order() -> None:
    """Decision 27: when a top_n or the series bound applies, the busiest values are
    kept and then shown in the canonical order. Before, "Top 2 of 4" of Critical 5,
    High 6, Medium 2, Low 35 drew Critical and High and dropped Low, the largest."""
    from app.agents.chat_tools.base import Artifact
    from app.agents.chat_tools.common import categories

    data = categories([("Critical", 5), ("High", 6), ("Medium", 2), ("Low", 35)], dimension="Severity", ordered=True)
    cats = Artifact(id="a1", kind="categories", title="Cases by severity", title_trusted=True, data=data,
                    provenance="code", total=48)
    for view in ("hbar", "bar", "table"):
        (block,) = to_blocks(cats, MaterialiseOptions(block_id="b1", view=view, top_n=2))
        labels = block["x"]["values"] if block["type"] == "chart" else [r[0] for r in block["rows"]]
        values = block["series"][0]["values"] if block["type"] == "chart" else [r[1] for r in block["rows"]]
        assert (labels, values) == (["High", "Low"], [6, 35]), view
        assert block["caption"].startswith("Top 2 of 4") and block["total"] == 4, view
        # A later answer's new view of the stored block (``mK.bJ``) shows what was kept,
        # in the same order, still disclosed as two of four.
        revised = revise_view(block, "table" if view != "table" else "hbar", block_id="b2")
        assert revised is not None
        again = revised["x"]["values"] if revised["type"] == "chart" else [r[0] for r in revised["rows"]]
        assert again == ["High", "Low"], view
        assert revised["caption"].startswith("Top 2 of 4"), revised["caption"]
    # Unclipped, every value shows in the canonical order.
    (whole,) = to_blocks(cats, MaterialiseOptions(block_id="b1", view="hbar"))
    assert whole["x"]["values"] == ["Critical", "High", "Medium", "Low"] and not whole.get("truncated")
    # Three of four: Medium (2), the quietest, is the one left out.
    (three,) = to_blocks(cats, MaterialiseOptions(block_id="b1", view="bar", top_n=3))
    assert three["x"]["values"] == ["Critical", "High", "Low"] and three["caption"].startswith("Top 3 of 4")


def test_a_top_n_of_an_ordered_series_keeps_the_busiest_series_then_their_order() -> None:
    from app.agents.chat_tools.base import Artifact

    x = ["2026-10-08T00:00:00+00:00", "2026-10-09T00:00:00+00:00", "2026-10-10T00:00:00+00:00"]
    rows = [("critical", "Critical", [1, 0, 1]), ("high", "High", [2, 2, 1]), ("medium", "Medium", [0, 1, 0]),
            ("low", "Low", [10, 12, 9]), ("info", "Info", [0, 0, 1])]
    data = {"x": x, "unit": "count", "bucket": "1d", "ordered": True,
            "series": [{"key": f"s{i + 1}", "label": label, "values": values, "semantic": key}
                       for i, (key, label, values) in enumerate(rows)]}
    art = Artifact(id="a1", kind="series", title="Cases by severity per day", title_trusted=True, data=data,
                   provenance="code")
    for view in ("line", "stacked_bar", "table"):
        (block,) = to_blocks(art, MaterialiseOptions(block_id="b1", view=view, top_n=2))
        if block["type"] == "table":
            shown = [c["label"] for c in block["columns"][1:]]
        else:
            shown = [s["label"] for s in block["series"]]
            # Each kept series keeps its palette key (Low is never drawn as Critical).
            assert [s.get("semantic") for s in block["series"]] == ["high", "low"], view
        assert shown == ["High", "Low"], view
        assert block["caption"].startswith("Top 2 of 5"), view

    # Under the series bound (more series than a chart draws), "Other" stays, last.
    many = [(f"v{i}", f"Value {i}", [i, i, i]) for i in range(1, 10)]
    bound = {"x": x, "unit": "count", "bucket": "1d", "ordered": True,
             "series": [{"key": key, "label": label, "values": values} for key, label, values in many]
             + [{"key": "other", "label": "Other", "values": [1, 1, 1]}]}
    art = Artifact(id="a2", kind="series", title="By value", title_trusted=True, data=bound, provenance="code")
    (block,) = to_blocks(art, MaterialiseOptions(block_id="b1", view="line"))
    labels = [s["label"] for s in block["series"]]
    # The seven busiest named values (3 to 9) in the producer's order, then "Other".
    assert labels == [f"Value {i}" for i in range(3, 10)] + ["Other"], labels


async def test_verdict_series_wear_verdict_colours_and_status_keeps_lifecycle_order() -> None:
    cases = [
        _case(0, "low", verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED),
        _case(1, "low", verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.CLOSED),
        _case(2, "low", verdict=Verdict.FALSE_POSITIVE, status=CaseStatus.RESOLVED),
        _case(3, "high", verdict=Verdict.TRUE_POSITIVE, status=CaseStatus.ESCALATED),
        _case(4, "high", verdict=None, status=CaseStatus.NEW),
        _case(5, "high", verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.INVESTIGATING),
    ]
    store = await _store(cases)
    verdicts = await CaseStatsTool().run(make_ctx(cases=store), group_by="verdict", bucket="day", window="now-7d")
    series = next(a for a in verdicts.artifacts if a.kind == "series").data["series"]
    assert [(s["label"], s.get("semantic")) for s in series] == [
        ("True positive", "true_positive"), ("False positive", "false_positive"),
        ("Needs human", "needs_human"), ("No verdict", "undetermined")]
    statuses = await CaseStatsTool().run(make_ctx(cases=store), group_by="status", bucket="day", window="now-7d")
    series = next(a for a in statuses.artifacts if a.kind == "series").data["series"]
    # Lifecycle order; no palette key (resolved and closed share a colour on that axis).
    assert [s["label"] for s in series] == ["New", "Investigating", "Escalated", "Resolved", "Closed"]
    assert not any("semantic" in s for s in series)


async def test_a_severity_comparison_lists_severities_in_order() -> None:
    store = await _store(_volume_skewed())
    out = await CaseStatsTool().run(make_ctx(cases=store), group_by="severity", window="now-7d",
                                    compare="previous_period")
    assert out.ok, out.error
    comparison = next(a for a in out.artifacts if a.kind == "comparison")
    assert [r["label"] for r in comparison.data["rows"]] == ["Critical", "High", "Medium", "Low"]


def test_canonical_rows_group_by_the_first_field_and_keep_volume_inside() -> None:
    rows = [
        {"key": {"rule": "a", "severity": "low"}, "metrics": {"count": 9}},
        {"key": {"rule": "b", "severity": "critical"}, "metrics": {"count": 7}},
        {"key": {"rule": "a", "severity": "critical"}, "metrics": {"count": 5}},
        {"key": {"rule": "b", "severity": "high"}, "metrics": {"count": 1}},
    ]
    ordered = canonical_rows(rows, ["rule", "severity"])
    assert [(r["key"]["rule"], r["key"]["severity"]) for r in ordered] == [
        ("a", "critical"), ("a", "low"), ("b", "critical"), ("b", "high")]
    ordered = canonical_rows(rows, ["severity", "rule"])
    assert [(r["key"]["severity"], r["key"]["rule"]) for r in ordered] == [
        ("critical", "b"), ("critical", "a"), ("high", "b"), ("low", "a")]
    # A field with no canonical order keeps the rows as they came.
    assert canonical_rows(rows, ["rule"]) == rows


# --------------------------------------------------------------------------- #
# One window per answer (SPEC §7.2 decisions 28 and 29).
# --------------------------------------------------------------------------- #
def test_report_scope_states_each_window_once() -> None:
    from app.api.routes_reports import _join_windows, _merge_windows

    # The screenshot tour's saved lifetime report: cases, a case list and AI usage.
    merged = _merge_windows(["all time (since 28 Sep 2026)", "all time", "all time (since 12 Oct 2026)"])
    assert merged == ["all time (since 28 Sep 2026)"]
    assert _join_windows(merged) == "all time (since 28 Sep 2026)"
    # Rolling and whole-day labels of one relative window: once, with its start.
    assert _merge_windows(["last 90 days", "last 90 days (since 15 Jul 2026)", "all time"]) == [
        "last 90 days (since 15 Jul 2026)", "all time"]
    # Two starts of one relative window: the shared phrase, never a guessed start.
    assert _merge_windows(["last 90 days (since 15 Jul 2026)", "last 90 days (since 14 Jul 2026)"]) == [
        "last 90 days"]
    # A zone suffix stays with the dated label; comparisons and ranges are left alone.
    assert _merge_windows(["all time", "all time (since 3 Nov 2025) (Asia/Kolkata)"]) == [
        "all time (since 3 Nov 2025) (Asia/Kolkata)"]
    kept = ["last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 06:51",
            "3 Sep 2026 09:15 – 11 Oct 2026 17:15 (America/Argentina/Buenos_Aires)"]
    assert _merge_windows(kept) == kept
    # The saved 90-day report: a comparison of a window it also states reads inside it,
    # never "last 90 days (since 15 Jul 2026); last 90 days (since 15 Jul 2026) vs …".
    report = ["last 90 days (since 15 Jul 2026)", "last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 08:02",
              "all time"]
    assert _join_windows(_merge_windows(report)) == (
        "last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 08:02; all time")
    # A report saved before every lookup counted whole days: the rolling comparison and
    # the dated one both name their previous periods, once.
    older = ["last 90 days", "last 90 days vs previous 90 days", "last 90 days (since 15 Jul 2026)",
             "last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026 08:02"]
    assert _merge_windows(older) == [
        "last 90 days (since 15 Jul 2026), compared with the previous 90 days and 16 Apr – 14 Jul 2026 08:02"]
    # The previous period of a window counted in whole days is the whole days just
    # before it, named by its span and dates: stated as "the previous 90 days (…)", and
    # a scope that already states it merges with a raw one, each period once.
    current = ["last 90 days (since 15 Jul 2026)",
               "last 90 days (since 15 Jul 2026) vs previous 90 days (16 Apr to 14 Jul 2026)", "all time"]
    folded = "last 90 days (since 15 Jul 2026), compared with the previous 90 days (16 Apr to 14 Jul 2026)"
    assert _merge_windows(current) == [folded, "all time"]
    assert _merge_windows([folded, current[1], "last 90 days (since 15 Jul 2026)"]) == [folded]
    # Several compared periods and a zone: each period once, the zone kept.
    assert _merge_windows(["Oct 2026 to date", "Oct 2026 to date vs Sep 2026 to date vs Aug 2026 to date (Asia/Kolkata)"]) == [
        "Oct 2026 to date, compared with Sep 2026 to date and Aug 2026 to date (Asia/Kolkata)"]
    # Scopes that already read that way (the report header joins items' scopes) merge
    # the same way, at the window's first position; a zone is never split.
    assert _merge_windows(["last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 09:02", "all time",
                           "last 90 days (since 15 Jul 2026)"]) == [
        "last 90 days (since 15 Jul 2026), compared with 16 Apr – 14 Jul 2026 09:02", "all time"]
    assert _merge_windows(["last 90 days (since 15 Jul 2026, Asia/Kolkata)",
                           "last 90 days (since 15 Jul 2026, Asia/Kolkata), compared with 16 Apr – 14 Jul 2026 08:02 "
                           "(Asia/Kolkata)"]) == [
        "last 90 days (since 15 Jul 2026, Asia/Kolkata), compared with 16 Apr – 14 Jul 2026 08:02 (Asia/Kolkata)"]
    # Two different starts are two windows: the comparison is not folded into the other.
    assert _merge_windows(["last 90 days (since 14 Jul 2026)", "last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026"]) == [
        "last 90 days (since 14 Jul 2026)", "last 90 days (since 15 Jul 2026) vs 16 Apr – 14 Jul 2026"]


async def test_every_breakdown_of_last_90_days_states_one_start() -> None:
    """The 90-day report read "Jul 2026 (from 14 Jul)" in its rate tables and "since 15
    Jul 2026" in Response times and AI cost: a month breakdown and a day breakdown of
    the same window now cover the same 90 whole days."""
    from app.agents.chat_tools.metrics import SocMetricsTool

    store = await _store(_volume_skewed())
    ctx = make_ctx(cases=store)
    # The lookups read the clock when they run; ``NOW`` was read when the module was
    # collected, minutes earlier in a full run, so the expected start comes from a clock
    # read just before the lookups (a run that crossed midnight since collection
    # otherwise expected the day before).
    ran_at = datetime.now(timezone.utc)
    by_month = await CaseStatsTool().run(ctx, window="now-90d", bucket="month", metrics="count,fp_rate")
    by_day = await CaseStatsTool().run(ctx, window="now-90d", bucket="day")
    timing = await SocMetricsTool().run(ctx, kind="timing", window="now-90d")
    for out in (by_month, by_day, timing):
        assert out.ok, out.error
    first = ran_at - timedelta(days=89)
    since = f"last 90 days (since {first.day} {first:%b %Y})"
    assert by_month.observation["window"] == by_day.observation["window"] == timing.observation["window"] == since
    assert by_month.observation["total"] == by_day.observation["total"]
    series = next(a for a in by_month.artifacts if a.kind == "series")
    # The first month is cut at the same day the window states (whole when it is the 1st).
    cut = f" (from {first.day} {first:%b})" if first.day != 1 else ""
    assert series.data["x_labels"][0] == f"{first:%b %Y}{cut}"


def _noon_zone() -> str:
    """A fixed-offset operator zone in which it is about noon now, so the part of the
    rolling 90 days before the first whole day is about twelve hours long whenever the
    test runs (never a sliver that closes while the lookups run). ``Etc/GMT-5`` is
    five hours AHEAD of UTC (the IANA sign is inverted)."""
    offset = 12 - NOW.hour
    if offset == 0:
        return "UTC"
    return f"Etc/GMT-{offset}" if offset > 0 else f"Etc/GMT+{-offset}"


def _gap_store_cases(zone: str) -> tuple[list[Case], datetime]:
    """Cases inside "last 90 days" counted as whole days, plus ONE in the gap: inside
    the rolling 90 days but before the first whole day (the screenshot tour's sliver
    case). Returns the cases and the whole-day start."""
    local = NOW.astimezone(ZoneInfo(zone))
    first_day = (local - timedelta(days=89)).date()
    start = datetime(first_day.year, first_day.month, first_day.day, tzinfo=ZoneInfo(zone)).astimezone(timezone.utc)
    rolling = NOW - timedelta(days=90)
    gap_moment = start - (start - rolling) / 2
    assert rolling < gap_moment < start  # inside the rolling window, before the first whole day
    cases = [_case(i, sev, days_ago=d, rule=rule) for i, (sev, d, rule) in enumerate(
        [("critical", 1, "r1"), ("high", 2, "r1"), ("high", 10, "r2"), ("medium", 40, "r2"),
         ("low", 60, "r3"), ("low", 85, "r3")])]
    gap = _case(90, "low", days_ago=(NOW - gap_moment).total_seconds() / 86400, rule="r3")
    return [*cases, gap], start


async def test_every_lookup_of_last_90_days_counts_the_same_cases() -> None:
    """Final polish (decision 28): a case in the hours of the rolling 90 days before the
    first whole day was counted by the posture tiles, the severity and rule breakdowns
    and the noise funnel (48) but not by the monthly volume and the headline (47), while
    the report stated one start. Every case, metric and cost lookup now counts the same
    90 whole days, states the same start, and compares with the same previous period."""
    from app.agents.chat_tools.cases import SearchCasesTool
    from app.agents.chat_tools.metrics import SocMetricsTool
    from app.config import Preferences

    zone = _noon_zone()
    cases, start = _gap_store_cases(zone)
    store = await _store(cases)
    prefs = Preferences()
    prefs = prefs.model_copy(update={"sla": prefs.sla.model_copy(update={"timezone": zone})})
    ctx = make_ctx(cases=store, prefs=prefs)
    inside = len(cases) - 1

    by_month = await CaseStatsTool().run(ctx, window="now-90d", bucket="month", compare="previous_period",
                                         metrics="count,fp_rate")
    posture = await SocMetricsTool().run(ctx, kind="posture", window="now-90d", compare="previous_period")
    timing = await SocMetricsTool().run(ctx, kind="timing", window="now-90d")
    funnel = await SocMetricsTool().run(ctx, kind="noise_funnel", window="now-90d")
    mix = await SocMetricsTool().run(ctx, kind="case_mix", window="now-90d")
    by_severity = await CaseStatsTool().run(ctx, window="now-90d", group_by="severity")
    by_rule = await CaseStatsTool().run(ctx, window="now-90d", group_by="rule", top_n=10)
    listed = await SearchCasesTool().run(ctx, window="now-90d")
    outs = (by_month, posture, timing, funnel, mix, by_severity, by_rule, listed)
    for out in outs:
        assert out.ok, out.error
        assert_artifacts_render(out)

    since = f"since {start.astimezone(ZoneInfo(zone)).day} "
    windows = {out.observation["window"] for out in outs if "window" in out.observation}
    assert len(windows) == 1, windows                                  # one start, stated once
    (label,) = windows
    assert label.startswith(f"last 90 days ({since}"), label

    stages = {s["key"]: s["total"] for s in funnel.observation["stages"]}
    severity = next(a for a in by_severity.artifacts if a.kind == "categories")
    series = next(a for a in by_month.artifacts if a.kind == "series")
    totals = {
        "headline": by_month.observation["total"],
        "monthly series": sum(series.data["series"][0]["values"]),
        "posture": posture.observation["case_count"],
        "timing": timing.observation["cases"],
        "noise funnel": stages["cases"],
        "case mix": mix.observation["cases"],
        "severity": by_severity.observation["total"],
        "severity donut": sum(v or 0 for v in severity.data["values"]),
        "rules": by_rule.observation["total"],
        "listed": listed.observation["count"],
    }
    assert set(totals.values()) == {inside}, totals                    # the gap case is in none of them

    # The posture tiles compare with the same previous period as the headline.
    assert posture.observation["comparison"]["periods"] == by_month.observation["comparison"]["periods"]


async def test_the_demo_90_day_report_states_one_total(monkeypatch: pytest.MonkeyPatch) -> None:
    """The screenshot tour's question, end to end through the Demo planner: with a case
    in the rolling window's first hours, every section of "Last 90 days or whatever
    reports you can" counts the same cases under the same start."""
    import app.llm.providers as providers
    from types import SimpleNamespace

    from app.agents.chat_tools.registry import catalogue_grant_pairs
    from app.models import ChatRequest
    from tests.test_chat_tools_support import build_demo_state

    monkeypatch.setattr(providers, "DEMO_STREAM_DELAY_S", 0)
    state = await build_demo_state()
    try:
        zone = _noon_zone()
        prefs = state.prefs
        await state.update_prefs(prefs.model_copy(update={"sla": prefs.sla.model_copy(update={"timezone": zone})}))
        page = await state.cases.list()
        base = (page[0] if isinstance(page, tuple) else page)[0]
        _cases, start = _gap_store_cases(zone)
        gap_at = start - (start - (NOW - timedelta(days=90))) / 2
        iso = gap_at.isoformat()
        await state.cases.save(base.model_copy(update={
            "case_id": "case-gap", "created_at": iso, "updated_at": iso, "cluster_signature": "gap-sig",
            "first_seen_millis": int(gap_at.timestamp() * 1000)}))
        invalidate_case_page_cache()
        invalidate_case_population_cache()
        question = "Last 90 days or whatever reports you can"
        req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(tlsoc=state)), cookies={}, headers={})
        ctx = await state.build_chat_tool_context(req, ChatRequest(message=question), grants=catalogue_grant_pairs())
        answer = await state.chat_engine.chat(question, state.execution_prefs, tool_context=ctx, origin="typed")
    finally:
        await state.shutdown()

    (report,) = [b for b in answer.blocks if b.get("type") == "report"]
    counted: dict[str, float] = {}
    windows: set[str] = set()
    for section in report.get("sections") or []:
        for block in section.get("blocks") or []:
            caption = str(block.get("caption") or "")
            title = str(block.get("title") or "")
            if " cases · " in caption and "all time" not in caption:
                counted[f"{title} (caption)"] = float(caption.split(" cases · ")[0].split(" · ")[-1].replace(",", ""))
                windows.add(caption.rsplit(" · ", 1)[-1] if "a case can count" not in caption
                            else caption.split(" · ")[-2])
            if block.get("type") == "kpi_group" and title == "Security posture":
                counted["posture tile"] = next(i["value"] for i in block["items"] if i["label"] == "Cases")
            if block.get("type") == "chart" and block.get("kind") == "funnel":
                stages = block["x"]["values"] if "values" in block.get("x", {}) else block["x"].get("labels")
                counted["funnel"] = block["series"][0]["values"][stages.index("Cases opened")]
            if block.get("type") == "chart" and title in ("Cases opened per month", "Cases by severity"):
                counted[f"{title} (sum)"] = sum(v or 0 for v in block["series"][0]["values"])
    assert len(counted) >= 6, counted
    assert len(set(counted.values())) == 1, counted
    assert len(windows) == 1, windows
    assert report.get("subtitle") in windows, (report.get("subtitle"), windows)


# --------------------------------------------------------------------------- #
# Demo copy: plain punctuation and human labels (screenshot tour 3, 19, 20).
# --------------------------------------------------------------------------- #
_RAW_VERDICT = ("TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_HUMAN")


def test_demo_seed_text_names_verdicts_in_words() -> None:
    from app.engine import demo_generator as gen

    org = gen.build_org(1337)
    now = 1_700_000_000_000
    recent, _events = gen.generate_recent_preseed(1337, org, run_id="run-A", now_millis=now)
    hitl, tuner = gen.generate_capability_seed_cases(1337, org, run_id="run-A", now_millis=now)
    cases = [*gen.generate_historical_cases(1337, org, history_days=14, run_id="run-A", now_millis=now),
             *recent, *hitl, *tuner]
    texts = [c.summary or "" for c in cases] + [h.reason or "" for c in cases for h in c.status_history]
    assert texts and not [t for t in texts if any(raw in t for raw in _RAW_VERDICT)]
    assert not [t for t in texts if "—" in t]
    assert "Impossible-travel sign-in (needs human review)." in {c.summary for c in hitl}


def test_demo_mock_evidence_names_the_verdict_in_words(monkeypatch: pytest.MonkeyPatch) -> None:
    import json

    from app.engine import demo_generator as gen
    from app.llm.providers import DemoMockProvider

    provider = DemoMockProvider()
    for story in [*gen.storylines_for_segment(None), None]:
        monkeypatch.setattr(DemoMockProvider, "_resolve", staticmethod(lambda messages, s=story: s))
        payload = json.loads(provider._demo_default("overview", [{"role": "user", "content": "x"}]))
        summary = payload["evidence"][0]["summary"]
        assert "—" not in summary and not any(raw in summary for raw in _RAW_VERDICT), summary


def test_demo_case_lines_use_plain_punctuation_and_words() -> None:
    from app.engine import demo_chat

    case = {"case_id": "case-1", "title": "user:dsingh — identity_signin", "severity": "high",
            "verdict": "NEEDS_HUMAN", "risk_score": 64, "status": "escalated"}
    line = demo_chat._case_line(case)
    assert "—" not in line and "needs-human" not in line
    assert line.endswith("(high, needs human, risk 64, escalated)")
    assert demo_chat._minutes(None) == demo_chat._dec(None) == "not measured"
