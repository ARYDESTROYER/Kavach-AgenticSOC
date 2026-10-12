"""The previous period of a window counted in whole periods is adjacent to it (Round 12
polish, screenshot tour 2 shot 09; SPEC §7.2 decisions 28 and 29).

A 90-day comparison read "83 in the last 90 days (since 15 Jul 2026) vs 0 from 16 Apr to
14 Jul 2026 10:34": the current window starts at local midnight but the previous one was
the same span cut at the time of day the question was asked, so 14 Jul 10:34 to 15 Jul
00:00 belonged to neither window and only one side named a time of day. The previous
period is now the N whole days or months just before the window's start
(``[start - N periods, start)``), named at the same granularity ("previous 90 days (16
Apr to 14 Jul 2026)"), with calendar arithmetic in the operator timezone so a clock
change or a short month never moves a bound off local midnight or the first of a month.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.agents.chat_tools.common import resolve_window, whole_periods
from app.agents.chat_tools.metrics import _kpi_delta
from app.agents.chat_tools.periods import (
    aligned_span_label,
    comparison_caption,
    comparison_observation,
    comparison_row,
    previous_period,
    resolve_periods,
)
from app.agents.chat_tools.stats import CaseStatsTool
from app.api.metrics_shared import invalidate_case_page_cache, invalidate_case_population_cache
from app.config import Preferences
from app.engine import demo_chat, time_windows

from tests.test_chat_tools_round12_final import _aligned_case_store, _cut_and_whole
from tests.test_chat_tools_support import make_ctx

#: The moment of the screenshot tour's 90-day report.
TOUR = datetime(2026, 10, 12, 10, 34, tzinfo=timezone.utc)
CLOCK = re.compile(r"\d{1,2}:\d{2}")


@pytest.fixture(autouse=True)
def _fresh_caches() -> object:
    invalidate_case_page_cache()
    invalidate_case_population_cache()
    yield
    invalidate_case_page_cache()
    invalidate_case_population_cache()


def _ctx(tz: str = "UTC") -> object:
    return make_ctx(prefs=Preferences.model_validate({"sla": {"timezone": tz}}))


def _periods(spec: str, now: datetime, tz: str = "UTC") -> tuple[object, list]:
    ctx = _ctx(tz)
    window = whole_periods(resolve_window(ctx, window=spec, now=now))
    periods = resolve_periods(ctx, window, "previous_period", now=now)
    assert isinstance(periods, list) and len(periods) == 2, periods
    return window, periods


def _local(instant: datetime, tz: str) -> datetime:
    return instant.astimezone(ZoneInfo(tz))


# --------------------------------------------------------------------------- #
# The finding, exactly
# --------------------------------------------------------------------------- #
def test_the_90_day_comparison_of_the_tour_is_adjacent_and_reads_naturally() -> None:
    window, periods = _periods("now-90d", TOUR)
    before, subject = periods
    assert subject.label == "last 90 days (since 15 Jul 2026)"
    assert before.label == "previous 90 days (16 Apr to 14 Jul 2026)"
    # [start - 90 days, start): no gap (14 Jul 10:34 to 15 Jul 00:00 was in neither).
    assert before.window.start == datetime(2026, 4, 16, tzinfo=timezone.utc)
    assert before.window.end == window.start == datetime(2026, 7, 15, tzinfo=timezone.utc)
    assert not CLOCK.search(before.label)                            # no time of day on one side only
    assert comparison_caption(periods) == (
        "last 90 days (since 15 Jul 2026) vs previous 90 days (16 Apr to 14 Jul 2026)")
    # The latest period's last day is not over: the change is said to be partial.
    assert "partial period" in comparison_observation(periods, [])["note"]


def test_the_kpi_change_names_the_same_previous_period() -> None:
    _window, periods = _periods("now-90d", TOUR)
    row = comparison_row("cases", "Cases", [0, 83])
    delta = _kpi_delta(row, periods)
    assert delta is not None and delta["value"] == 83
    assert delta["period_label"] == "vs previous 90 days (16 Apr to 14 Jul 2026)"


def test_the_narration_reads_the_previous_period_in_words() -> None:
    _window, periods = _periods("now-90d", TOUR)
    rows = [comparison_row("cases", "Cases", [0, 83]),
            comparison_row("fp", "False-positive rate", [None, 56.6], unit="percent"),
            comparison_row("mttr", "MTTR median", [30, 20], unit="minutes", samples=[25, 25])]
    lines = demo_chat._say_comparison(comparison_observation(periods, rows), with_note=False)
    assert lines == [
        "Cases: **83** in the last 90 days (since 15 Jul 2026) vs 0 in the previous 90 days "
        "(16 Apr to 14 Jul 2026; new).",
        "False-positive rate: **56.6%** in the last 90 days (since 15 Jul 2026); not measured in the "
        "previous 90 days (16 Apr to 14 Jul 2026), so there is no change to show.",
        "MTTR median: **20 min** in the last 90 days (since 15 Jul 2026) vs 30 min in the previous 90 days "
        "(16 Apr to 14 Jul 2026; −10 min).",
    ]
    # A calendar baseline keeps its change in its own brackets.
    month = [comparison_row("cases", "Cases", [30, 47])]
    september = resolve_periods(_ctx(), resolve_window(_ctx(), window="this_month", now=TOUR), "previous_period",
                                now=TOUR)
    assert demo_chat._say_comparison(comparison_observation(september, month), with_note=False) == [
        "Cases: **47** in Oct 2026 to date vs 30 in Sep 2026 to date (+17, +56.7%)."]


def test_a_long_previous_period_is_narrated_whole() -> None:
    _window, periods = _periods("now-180d", TOUR)
    label = periods[0].label
    assert label == "previous 180 days (18 Oct 2025 to 15 Apr 2026)" and len(label) > 40
    line = demo_chat._say_comparison(
        comparison_observation(periods, [comparison_row("cases", "Cases", [10, 12])]), with_note=False)[0]
    assert f"in the {label[:-1]}; +2, +20%)." in line and "…" not in line


# --------------------------------------------------------------------------- #
# Calendar edges in the operator timezone
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(("now", "expected_label", "dst_shift"), [
    # Clocks went back on 1 Nov 2025 inside the previous period: 90 local days are an hour longer.
    (datetime(2026, 4, 10, 15, 0, tzinfo=timezone.utc), "previous 90 days (13 Oct 2025 to 10 Jan 2026)",
     timedelta(hours=1)),
    # Clocks went forward on 8 Mar 2026 inside it: an hour shorter.
    (datetime(2026, 7, 1, 15, 0, tzinfo=timezone.utc), "previous 90 days (3 Jan to 2 Apr 2026)",
     -timedelta(hours=1)),
])
def test_whole_days_across_a_clock_change_stay_on_local_midnight(
        now: datetime, expected_label: str, dst_shift: timedelta) -> None:
    tz = "America/New_York"
    window, (before, _subject) = _periods("now-90d", now, tz)
    start, end = _local(before.window.start, tz), _local(before.window.end, tz)
    assert (start.hour, start.minute, end.hour, end.minute) == (0, 0, 0, 0)
    assert before.window.end == window.start
    assert (end.date() - start.date()).days == 90
    assert before.window.end - before.window.start == timedelta(days=90) + dst_shift
    assert before.label == expected_label


def test_a_month_in_progress_across_a_clock_change_still_compares_like_for_like() -> None:
    # "This month" on 10 Mar 2026 in New York lost an hour on 8 Mar: the same elapsed part
    # of February is an hour longer, which is still like for like.
    ctx = _ctx("America/New_York")
    now = datetime(2026, 3, 10, 16, 0, tzinfo=timezone.utc)
    periods = resolve_periods(ctx, resolve_window(ctx, window="this_month", now=now), "previous_period", now=now)
    assert "like for like" in comparison_observation(periods, [])["note"]


@pytest.mark.parametrize(("spec", "now", "tz", "expected_label", "first", "last_exclusive"), [
    # Days that cross a month end and a leap day.
    ("now-30d", datetime(2026, 3, 31, 10, 0, tzinfo=timezone.utc), "UTC",
     "previous 30 days (31 Jan to 1 Mar 2026)", (2026, 1, 31), (2026, 3, 2)),
    ("now-30d", datetime(2028, 3, 1, 9, 0, tzinfo=timezone.utc), "UTC",
     "previous 30 days (2 to 31 Jan 2028)", (2028, 1, 2), (2028, 2, 1)),
    ("now-2d", datetime(2028, 3, 1, 9, 0, tzinfo=timezone.utc), "UTC",
     "previous 2 days (27 to 28 Feb 2028)", (2028, 2, 27), (2028, 2, 29)),
    # Months in a zone ahead of UTC: 31 Mar 20:00 UTC is already 1 Apr in Kolkata, so
    # the window is Feb to Apr and the previous one whole local months before it.
    ("now-3M", datetime(2026, 3, 31, 20, 0, tzinfo=timezone.utc), "Asia/Kolkata",
     "previous 3 months (Nov 2025 to Jan 2026)", (2025, 11, 1), (2026, 2, 1)),
    ("now-3M", datetime(2026, 5, 31, 12, 0, tzinfo=timezone.utc), "UTC",
     "previous 3 months (Dec 2025 to Feb 2026)", (2025, 12, 1), (2026, 3, 1)),
    ("now-2M", datetime(2028, 2, 29, 12, 0, tzinfo=timezone.utc), "UTC",
     "previous 2 months (Nov to Dec 2027)", (2027, 11, 1), (2028, 1, 1)),
    ("now-1y", TOUR, "UTC", "previous 1 year (Nov 2024 to Oct 2025)", (2024, 11, 1), (2025, 11, 1)),
])
def test_month_ends_and_leap_days(spec: str, now: datetime, tz: str, expected_label: str,
                                  first: tuple[int, int, int], last_exclusive: tuple[int, int, int]) -> None:
    window, (before, _subject) = _periods(spec, now, tz)
    zone = ZoneInfo(tz)
    assert before.label == expected_label
    assert before.window.start == datetime(*first, tzinfo=zone).astimezone(timezone.utc)
    assert before.window.end == window.start == datetime(*last_exclusive, tzinfo=zone).astimezone(timezone.utc)


def test_a_window_ending_on_local_midnight_still_steps_back_its_whole_count() -> None:
    # At exactly midnight today has not started: the window is 89 whole days and an empty
    # one, and the previous period is still the 90 whole days before its start.
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    window, (before, _subject) = _periods("now-90d", now)
    assert before.window.end == window.start
    assert (window.start - before.window.start) == timedelta(days=90)


def test_spans_of_hours_and_calendar_periods_keep_their_rules() -> None:
    # A span of hours is the same length just before it (it has no dates to name).
    _window, (before, _subject) = _periods("now-24h", TOUR)
    assert before.label == "previous 24 hours"
    assert before.window.end - before.window.start == timedelta(hours=24)
    # A complete calendar period steps back one period.
    ctx = _ctx()
    last_month = previous_period(resolve_window(ctx, window="last_month", now=TOUR))
    assert last_month is not None and last_month.label == "Aug 2026"


def test_whole_period_count_and_span_label() -> None:
    def count(spec: str) -> int | None:
        return time_windows.whole_period_count(time_windows.resolve_window(spec, now=TOUR))

    assert (count("now-90d"), count("now-4w"), count("now-6M"), count("now-2y")) == (90, 28, 6, 24)
    assert count("now-24h") is None and count("now-1M") is None and count("last_month") is None
    utc = timezone.utc
    assert aligned_span_label(datetime(2025, 11, 1, tzinfo=utc), datetime(2026, 5, 1, tzinfo=utc), "month",
                              "UTC") == "Nov 2025 to Apr 2026"
    assert aligned_span_label(datetime(2026, 9, 1, tzinfo=utc), datetime(2026, 10, 1, tzinfo=utc), "month",
                              "UTC") == "Sep 2026"
    assert aligned_span_label(datetime(2025, 12, 30, tzinfo=utc), datetime(2026, 1, 2, tzinfo=utc), "day",
                              "UTC") == "30 Dec 2025 to 1 Jan 2026"


# --------------------------------------------------------------------------- #
# No case falls between the two periods
# --------------------------------------------------------------------------- #
async def test_a_case_in_the_cut_part_counts_in_the_previous_period() -> None:
    store, inside = await _aligned_case_store("now-30d", "day")
    exact, aligned = _cut_and_whole("now-30d", "day")
    out = await CaseStatsTool().run(make_ctx(cases=store), window="now-30d", compare="previous_period")
    assert out.ok, out.error
    cases = next(r for r in out.observation["comparison"]["rows"] if r["label"] == "Cases")
    # The case before the exact relative start and, when the alignment cut any time off,
    # the case in that cut part: both in the previous 30 whole days, none between.
    in_cut = 1 if aligned - exact > timedelta(minutes=2) else 0
    assert cases["values"] == [1 + in_cut, inside]


# --------------------------------------------------------------------------- #
# Final polish: like for like is decided by how the baseline was built, never by a
# leap day; dated period names are never cut or doubled up in brackets.
# --------------------------------------------------------------------------- #
LIKE = "like for like"
PARTIAL = "partial period"


def _note(spec: str, compare: object, now: datetime, tz: str = "UTC") -> tuple[list, str]:
    ctx = _ctx(tz)
    window = whole_periods(resolve_window(ctx, window=spec, now=now))
    periods = resolve_periods(ctx, window, compare, now=now)
    assert isinstance(periods, list) and len(periods) == 2, periods
    return periods, comparison_observation(periods, [])["note"]


@pytest.mark.parametrize(("spec", "compare", "now", "labels"), [
    # 2025 to date against 2024 to date: the same part of each year, though 2024 holds
    # 29 Feb, late in the year and early in it.
    ("ytd", "previous_period", datetime(2025, 10, 12, 10, 0, tzinfo=timezone.utc),
     ["2024 to date", "2025 to date"]),
    ("ytd", "previous_period", datetime(2025, 3, 5, 10, 0, tzinfo=timezone.utc),
     ["2024 to date", "2025 to date"]),
    ("this_year", "same_period_last_year", datetime(2025, 10, 12, 10, 0, tzinfo=timezone.utc),
     ["2024 to date", "2025 to date"]),
    # Year over year for windows whose year-ago span holds 29 Feb.
    ("now-6M", "same_period_last_year", datetime(2029, 4, 10, 10, 0, tzinfo=timezone.utc), None),
    ("now-12M", "same_period_last_year", datetime(2025, 10, 12, 10, 0, tzinfo=timezone.utc), None),
    ("now-90d", "same_period_last_year", datetime(2025, 3, 12, 10, 34, tzinfo=timezone.utc), None),
    # The same part of a shorter previous quarter (Q4 to 15 Dec is two days longer).
    ("this_quarter", "previous_period", datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc),
     ["Q4 2025 to date", "Q1 2026 to date"]),
])
def test_the_same_elapsed_time_is_like_for_like_across_a_leap_day(
        spec: str, compare: str, now: datetime, labels: list[str] | None) -> None:
    periods, note = _note(spec, compare, now)
    if labels is not None:
        assert [p.label for p in periods] == labels
    assert periods[0].basis == "elapsed"
    assert LIKE in note and PARTIAL not in note


def test_today_on_a_clock_change_day_is_like_for_like() -> None:
    # 8 Mar 2026 in New York lost an hour at 02:00: 00:00 to 11:00 is 10 hours today and
    # 11 hours yesterday, still the same part of the day.
    _periods, note = _note("today", "previous_period", datetime(2026, 3, 8, 15, 0, tzinfo=timezone.utc),
                           "America/New_York")
    assert LIKE in note


def test_whole_periods_before_a_window_in_progress_are_a_partial_comparison() -> None:
    for spec in ("now-90d", "now-7d", "now-3M"):
        periods, note = _note(spec, "previous_period", TOUR)
        assert periods[0].basis == "whole" and PARTIAL in note, spec


def test_an_explicit_window_is_still_judged_by_length() -> None:
    ctx = _ctx()
    month = resolve_window(ctx, window="this_month", now=TOUR)
    # October to date against the whole of September: the latest is far shorter.
    periods = resolve_periods(ctx, month, {"from": "2026-09-01", "to": "2026-10-01"}, now=TOUR)
    assert isinstance(periods, list) and periods[0].basis is None
    assert PARTIAL in comparison_observation(periods, [])["note"]
    # A custom window that ends later (the rest of October) against the whole September
    # before it: its baseline is complete, so the change is partial too.
    october = resolve_window(ctx, window={"from": "2026-10-01", "to": "2026-11-01"}, now=TOUR)
    periods = resolve_periods(ctx, october, "previous_period", now=TOUR)
    assert isinstance(periods, list) and periods[-1].in_progress and periods[0].basis is None
    assert PARTIAL in comparison_observation(periods, [])["note"]


# --------------------------------------------------------------------------- #
# A comparison tile's context keeps the whole dated name (report exports, digest).
# --------------------------------------------------------------------------- #
def _tiles(spec: str, rows: list[dict]) -> list[dict]:
    from app.agents.blocks import MaterialiseOptions, to_blocks, validate_blocks
    from app.agents.chat_tools.base import Artifact
    from app.agents.chat_tools.periods import comparison_data

    _window, periods = _periods(spec, TOUR)
    artifact = Artifact(id="a1", kind="comparison", title="Change versus the previous period", title_trusted=True,
                        data=comparison_data(periods, rows), provenance="code", basis="exact",
                        window=comparison_caption(periods))
    made = to_blocks(artifact, MaterialiseOptions(block_id="b1", view="kpi_group"))
    kept, dropped = validate_blocks(made)
    assert kept and not dropped, [d.reason for d in dropped]
    return [item for block in kept for item in block["items"]]


def test_a_small_sample_rate_tile_keeps_its_dated_period_whole() -> None:
    from app.engine import report_digest

    rows = [comparison_row("mttr", "MTTR median", [45, 30], unit="minutes", good="down", samples=[11, 12]),
            comparison_row("fp", "False-positive rate", [50.6, 54.5], unit="percent", good="down",
                           samples=[11, 12])]
    mttr, fp = _tiles("now-90d", rows)
    assert mttr["context"] == "previous 90 days (16 Apr to 14 Jul 2026): 45 min · -33.3% · n < 20"
    assert fp["context"] == "previous 90 days (16 Apr to 14 Jul 2026): 50.6% · +7.7% · n < 20"
    digest = report_digest._kpis({"items": [mttr, fp]}, report_digest._LEVELS[0])
    assert [k["context"] for k in digest["kpis"]] == [mttr["context"], fp["context"]]


def test_a_180_day_count_tile_keeps_its_dated_period_whole() -> None:
    (cases,) = _tiles("now-180d", [comparison_row("cases", "Cases", [1180, 1284])])
    assert cases["context"] == "previous 180 days (18 Oct 2025 to 15 Apr 2026): 1,180 · +8.8%"
    assert "…" not in cases["context"]
    assert cases["delta"]["period_label"] == "vs previous 180 days (18 Oct 2025 to 15 Apr 2026)"


# --------------------------------------------------------------------------- #
# Never two brackets in a row: the compare headline and the comparison caption.
# --------------------------------------------------------------------------- #
def test_the_caption_puts_the_zone_inside_the_dates_it_ends_in() -> None:
    _window, periods = _periods("now-90d", TOUR, "Asia/Kolkata")
    caption = comparison_caption(periods)
    assert caption == ("last 90 days (since 15 Jul 2026) vs previous 90 days (16 Apr to 14 Jul 2026, "
                       "Asia/Kolkata)")
    assert ") (" not in caption
    # A caption that does not end in dates keeps the zone in its own brackets.
    ctx = _ctx("Asia/Kolkata")
    month = resolve_periods(ctx, resolve_window(ctx, window="2026-09", now=TOUR), "previous_period", now=TOUR)
    assert comparison_caption(month) == "Sep 2026 vs Aug 2026 (Asia/Kolkata)"


def test_a_report_scope_states_the_zone_inside_the_dates() -> None:
    from app.api.routes_reports import _merge_windows

    caption = "last 90 days (since 15 Jul 2026) vs previous 90 days (16 Apr to 14 Jul 2026, Asia/Kolkata)"
    assert _merge_windows(["last 90 days (since 15 Jul 2026)", caption]) == [
        "last 90 days (since 15 Jul 2026), compared with the previous 90 days (16 Apr to 14 Jul 2026, "
        "Asia/Kolkata)"]


def _with_comparison(spec: str, window: str, compare: dict) -> object:
    from tests.test_demo_chat_round12 import _generic_obs

    def obs(tool: str, inp: dict) -> dict:
        out = _generic_obs(tool, inp)
        if tool == "case_stats" and inp.get("window") == spec and "window" in out:
            out["window"] = window
            if inp.get("compare") and not inp.get("group_by"):
                out["comparison"] = compare
        return out
    return obs


def test_the_compare_headline_never_follows_dates_with_a_second_bracket() -> None:
    from tests.test_demo_chat_round12 import drive

    _window, periods = _periods("now-90d", TOUR)
    comp = comparison_observation(periods, [comparison_row("cases", "Cases", [70, 83])])
    _rounds, _header, body = drive("Compare cases in the last 90 days with the previous period",
                                   _with_comparison("now-90d", "last 90 days (since 15 Jul 2026)", comp))
    assert body.startswith("**Last 90 days (since 15 Jul 2026) compared with the previous 90 days (16 Apr to 14 "
                           "Jul 2026)**. Changes are computed exactly over every case:"), body[:200]
    assert ")** (" not in body


def test_a_performance_report_says_its_latest_period_is_partial() -> None:
    from tests.test_demo_chat_round12 import drive

    _window, periods = _periods("now-7d", TOUR)
    rows = [comparison_row("cases", "Cases", [22, 60]), comparison_row("fp", "False-positive rate", [40.0, 45.0],
                                                                       unit="percent", samples=[22, 60])]
    comp = comparison_observation(periods, rows)
    assert PARTIAL in comp["note"]
    _rounds, header, _body = drive("SOC performance report for the last 7 days",
                                   _with_comparison("now-7d", "last 7 days (since 6 Oct 2026)", comp))
    (envelope,) = header["blocks"]
    summary = envelope["sections"][0]["items"][0]["text"]
    assert "Cases: 60 in the last 7 days (since 6 Oct 2026) vs 22 in the previous 7 days (29 Sep to 5 Oct 2026; " \
           "+38, +172.7%)." in summary
    assert summary.endswith("The latest period is still in progress and shorter than the one it is compared "
                            "with, so the change compares a partial period."), summary
