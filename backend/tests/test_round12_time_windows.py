"""Round 12 (WP-AGG): ``engine/time_windows`` — windows, calendar buckets, labels.

Every assertion pins a calendar fact an analyst can check by hand: ISO weeks start on
Monday, a month is the operator's local month, a DST day is 23 or 25 hours long, a
leap February has 29 days, and every instant of a window falls in exactly one bucket.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import pytest

from app.engine.time_windows import (
    BUCKET_UNITS,
    MAX_POINTS,
    align_window,
    all_time_label,
    auto_bucket,
    bucket_count,
    calendar_buckets,
    next_period_start,
    period_label,
    period_start,
    resolve_window,
    zone_for,
)

UTC = timezone.utc
# A Saturday (2026-10-10 is a Saturday), mid-afternoon UTC.
NOW = datetime(2026, 10, 10, 14, 23, 5, tzinfo=UTC)


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


# --------------------------------------------------------------------------- #
# resolve_window — every accepted form
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("spec", [None, "", "all", "lifetime", "all_time", "all time", "*", {}])
def test_all_time_forms(spec) -> None:
    w = resolve_window(spec, now=NOW)
    assert w.start is None and w.open_end is True
    assert w.label == "all time" and w.token == "all" and w.kind == "all"
    assert w.end == NOW and w.now == NOW
    # An all-time window keeps a record stamped after "now" (never dropped).
    assert w.contains(NOW + timedelta(days=3))


def test_default_spec_is_used_for_blank_input() -> None:
    w = resolve_window(None, now=NOW, default="now-24h")
    assert w.token == "now-24h" and w.start == NOW - timedelta(hours=24)


@pytest.mark.parametrize(
    "spec, start, label, token",
    [
        ("now-90d", NOW - timedelta(days=90), "last 90 days", "now-90d"),
        ("now-24h", NOW - timedelta(hours=24), "last 24 hours", "now-24h"),
        ("now-2w", NOW - timedelta(weeks=2), "last 2 weeks", "now-2w"),
        ("now-30m", NOW - timedelta(minutes=30), "last 30 minutes", "now-30m"),
        ("90d", NOW - timedelta(days=90), "last 90 days", "now-90d"),
        ("last_90_days", NOW - timedelta(days=90), "last 90 days", "now-90d"),
        ("last 30 days", NOW - timedelta(days=30), "last 30 days", "now-30d"),
        ("past 24 hours", NOW - timedelta(hours=24), "last 24 hours", "now-24h"),
        ("last_24h", NOW - timedelta(hours=24), "last 24 hours", "now-24h"),
        # Calendar months/years: exactly N calendar months back, same wall-clock time.
        ("now-6M", _utc(2026, 4, 10, 14, 23, 5), "last 6 months", "now-6M"),
        ("last 6 months", _utc(2026, 4, 10, 14, 23, 5), "last 6 months", "now-6M"),
        ("6mo", _utc(2026, 4, 10, 14, 23, 5), "last 6 months", "now-6M"),
        ("now-12M", _utc(2025, 10, 10, 14, 23, 5), "last 12 months", "now-12M"),
        ("now-1y", _utc(2025, 10, 10, 14, 23, 5), "last 1 year", "now-1y"),
    ],
)
def test_relative_windows(spec, start, label, token) -> None:
    w = resolve_window(spec, now=NOW)
    assert w.start == start and w.end == NOW
    assert w.label == label and w.token == token and w.kind == "relative"
    assert not w.open_end


def test_es_date_math_case_rule_m_is_minutes_capital_m_is_months() -> None:
    assert resolve_window("now-6m", now=NOW).start == NOW - timedelta(minutes=6)
    assert resolve_window("now-6M", now=NOW).start == _utc(2026, 4, 10, 14, 23, 5)


def test_legacy_window_hours_alias() -> None:
    assert resolve_window(720, now=NOW).label == "last 30 days"
    assert resolve_window(36, now=NOW).label == "last 36 hours"
    assert resolve_window(0, now=NOW).token == "all"


def test_month_arithmetic_clamps_to_month_end_and_knows_leap_years() -> None:
    # 31 Mar minus one month is the last day of February — 29 in a leap year.
    leap = resolve_window("now-1M", now=_utc(2028, 3, 31, 9))
    assert leap.start == _utc(2028, 2, 29, 9)
    plain = resolve_window("now-1M", now=_utc(2026, 3, 31, 9))
    assert plain.start == _utc(2026, 2, 28, 9)
    # Six calendar months in a non-UTC zone keep the LOCAL wall clock.
    ny = resolve_window("now-6M", tz="America/New_York", now=_utc(2026, 10, 10, 16))
    # 12:00 EDT on 10 Oct → 12:00 EDT on 10 Apr (also EDT) = 16:00 UTC.
    assert ny.start == _utc(2026, 4, 10, 16)
    across_dst = resolve_window("now-1M", tz="America/New_York", now=_utc(2026, 11, 15, 17))
    # 12:00 EST on 15 Nov → 12:00 EDT on 15 Oct = 16:00 UTC (the offset changed).
    assert across_dst.start == _utc(2026, 10, 15, 16)


@pytest.mark.parametrize(
    "token, start, end, label",
    [
        ("today", _utc(2026, 10, 10), NOW, "today"),
        ("yesterday", _utc(2026, 10, 9), _utc(2026, 10, 10), "yesterday"),
        # 2026-10-10 is a Saturday; the ISO week starts on Monday 5 Oct.
        ("this_week", _utc(2026, 10, 5), NOW, "this week"),
        ("last_week", _utc(2026, 9, 28), _utc(2026, 10, 5), "last week"),
        ("this_month", _utc(2026, 10, 1), NOW, "October 2026"),
        ("last_month", _utc(2026, 9, 1), _utc(2026, 10, 1), "September 2026"),
        ("this_quarter", _utc(2026, 10, 1), NOW, "Q4 2026"),
        ("last_quarter", _utc(2026, 7, 1), _utc(2026, 10, 1), "Q3 2026"),
        ("ytd", _utc(2026, 1, 1), NOW, "2026 to date"),
        ("this_year", _utc(2026, 1, 1), NOW, "2026"),
        ("last_year", _utc(2025, 1, 1), _utc(2026, 1, 1), "2025"),
    ],
)
def test_calendar_tokens_utc(token, start, end, label) -> None:
    w = resolve_window(token, now=NOW)
    assert (w.start, w.end, w.label, w.token, w.kind) == (start, end, label, token, "calendar")


@pytest.mark.parametrize("spelling", ["last month", "last-month", "LAST_MONTH", "previous_month"])
def test_calendar_token_spellings(spelling) -> None:
    assert resolve_window(spelling, now=NOW).token == "last_month"


def test_calendar_tokens_resolve_in_the_operator_timezone_and_name_it() -> None:
    w = resolve_window("last_month", tz="Asia/Kolkata", now=NOW)
    # Local midnight in IST (+05:30) is 18:30 UTC the previous day.
    assert w.start == _utc(2026, 8, 31, 18, 30) and w.end == _utc(2026, 9, 30, 18, 30)
    assert w.label == "September 2026 (Asia/Kolkata)" and w.tz == "Asia/Kolkata"
    # "today" late on 10 Oct UTC is already 11 Oct in Tokyo.
    tokyo = resolve_window("today", tz="Asia/Tokyo", now=_utc(2026, 10, 10, 20))
    assert tokyo.start == _utc(2026, 10, 10, 15)  # 00:00 JST 11 Oct
    assert tokyo.label == "today (Asia/Tokyo)"
    # Zone-independent labels carry no suffix.
    assert resolve_window("now-90d", tz="Asia/Kolkata", now=NOW).label == "last 90 days"
    assert resolve_window("all", tz="Asia/Kolkata", now=NOW).label == "all time"


def test_last_week_across_new_year_uses_iso_weeks() -> None:
    # Monday 4 Jan 2027: the previous ISO week is Mon 28 Dec 2026 - Sun 3 Jan 2027.
    w = resolve_window("last_week", now=_utc(2027, 1, 4, 9))
    assert w.start == _utc(2026, 12, 28) and w.end == _utc(2027, 1, 4)
    q = resolve_window("last_quarter", now=_utc(2027, 1, 4, 9))
    assert q.start == _utc(2026, 10, 1) and q.end == _utc(2027, 1, 1) and q.label == "Q4 2026"


def test_calendar_tokens_across_a_dst_change() -> None:
    # America/New_York springs forward on Sunday 8 Mar 2026 (02:00 EST → 03:00 EDT).
    w = resolve_window("yesterday", tz="America/New_York", now=_utc(2026, 3, 9, 15))
    assert w.start == _utc(2026, 3, 8, 5)  # 00:00 EST
    assert w.end == _utc(2026, 3, 9, 4)  # 00:00 EDT
    assert (w.end - w.start) == timedelta(hours=23)
    # ...and falls back on Sunday 1 Nov 2026: that day is 25 hours long.
    fall = resolve_window("2026-11-01", tz="America/New_York", now=NOW)
    assert (fall.end - fall.start) == timedelta(hours=25)


@pytest.mark.parametrize(
    "spec, start, end, label, token",
    [
        ("2026", _utc(2026, 1, 1), _utc(2027, 1, 1), "2026", "2026"),
        ("2026-09", _utc(2026, 9, 1), _utc(2026, 10, 1), "September 2026", "2026-09"),
        ("2028-02", _utc(2028, 2, 1), _utc(2028, 3, 1), "February 2028", "2028-02"),
        ("2026-Q3", _utc(2026, 7, 1), _utc(2026, 10, 1), "Q3 2026", "2026-Q3"),
        ("Q3 2026", _utc(2026, 7, 1), _utc(2026, 10, 1), "Q3 2026", "2026-Q3"),
        ("2026-W14", _utc(2026, 3, 30), _utc(2026, 4, 6), "W14 2026", "2026-W14"),
        # ISO week 1 of 2026 starts in December 2025.
        ("2026-W01", _utc(2025, 12, 29), _utc(2026, 1, 5), "W01 2026", "2026-W01"),
        ("2026-09-14", _utc(2026, 9, 14), _utc(2026, 9, 15), "14 Sep 2026", "2026-09-14"),
    ],
)
def test_period_literals(spec, start, end, label, token) -> None:
    w = resolve_window(spec, now=NOW)
    assert (w.start, w.end, w.label, w.token, w.kind) == (start, end, label, token, "period")


def test_a_chip_range_ending_now_is_the_relative_window() -> None:
    chip = resolve_window({"from": "now-7d", "to": "now"}, now=NOW)
    assert chip == resolve_window("now-7d", now=NOW)
    assert chip.label == "last 7 days" and chip.token == "now-7d"
    assert resolve_window({"time_from": "now-90d"}, now=NOW).label == "last 90 days"


def test_ranges_with_inclusive_dates_and_labels() -> None:
    w = resolve_window({"from": "2026-03-01", "to": "2026-10-10"}, now=NOW)
    # A ``to`` DATE is inclusive: the window runs to the end of 10 Oct.
    assert w.start == _utc(2026, 3, 1) and w.end == _utc(2026, 10, 11)
    assert w.label == "1 Mar – 10 Oct 2026" and w.token == "2026-03-01..2026-10-10"
    assert resolve_window("2026-03-01..2026-10-10", now=NOW) == w
    assert resolve_window("2026-03-01/2026-10-10", now=NOW).end == w.end
    across = resolve_window({"start": "2025-12-01", "end": "2026-01-31"}, now=NOW)
    assert across.label == "1 Dec 2025 – 31 Jan 2026"
    one_day = resolve_window({"from": "2026-09-14", "to": "2026-09-14"}, now=NOW)
    assert one_day.label == "14 Sep 2026"
    since = resolve_window({"from": "last_month"}, now=NOW)
    assert since.start == _utc(2026, 9, 1) and since.end == NOW
    assert since.label == "since 1 Sep 2026"
    until = resolve_window("..2026-10-10", now=NOW)
    assert until.start is None and until.end == _utc(2026, 10, 11)
    assert until.label == "until 10 Oct 2026"
    instants = resolve_window(
        {"time_from": "2026-10-01T08:30:00Z", "time_to": "2026-10-02T09:00:00Z"}, now=NOW
    )
    assert instants.start == _utc(2026, 10, 1, 8, 30)
    assert instants.label == "1 Oct 2026 08:30 – 2 Oct 2026 09:00"
    # Naive timestamps are local to the operator zone.
    local = resolve_window({"from": "2026-10-01T09:00"}, tz="Asia/Kolkata", now=NOW)
    assert local.start == _utc(2026, 10, 1, 3, 30)
    assert local.label.endswith("(Asia/Kolkata)")
    # Period bounds: a "from" takes the period's start, a "to" its end.
    quarters = resolve_window({"from": "2026-Q1", "to": "2026-Q2"}, now=NOW)
    assert quarters.start == _utc(2026, 1, 1) and quarters.end == _utc(2026, 7, 1)
    assert quarters.label == "1 Jan – 30 Jun 2026"


@pytest.mark.parametrize(
    "bad",
    [
        "nonsense", "now-5x", "2026-13", "2026-W60", "2026-02-30", "1800",
        {"from": "2026-10-10", "to": "2026-03-01"},  # empty / inverted
        {"from": "garbage"}, {"window": "now-1d", "extra": 1}, {"bogus": "x"}, True,
        # Zero-length and negative windows never silently widen to all time.
        "now-0d", "last 0 days", "0h", "now-0M", -24, -0.5, {"from": "now-0d", "to": "now"},
        # Spans the calendar cannot represent are rejected, never an OverflowError/500.
        "now-999999d", "now-999999w", "999999 days", "now-999999y", 10**12, 10**30,
        {"from": 10**20},
    ],
)
def test_unrecognised_specs_are_rejected_visibly(bad) -> None:
    with pytest.raises(ValueError):
        resolve_window(bad, now=NOW)


def test_zero_hours_stays_the_documented_all_time_alias() -> None:
    assert resolve_window(0, now=NOW).is_all_time
    assert resolve_window(0.0, now=NOW).is_all_time
    # A fractional hour count is minutes, not a truncation to all time.
    half = resolve_window(0.5, now=NOW)
    assert half.start == NOW - timedelta(minutes=30) and half.label == "last 30 minutes"


def test_last_12_months_by_month_is_twelve_whole_months() -> None:
    """P0-5 acceptance with the literal phrase: "cases by month for the last 12 months"
    is twelve monthly buckets (eleven complete months and the current one, in progress),
    with local month boundaries in a non-UTC zone — not thirteen with a partial first."""
    now = _utc(2026, 10, 10, 14, 23)
    raw = resolve_window("last 12 months", tz="America/New_York", now=now)
    assert len(calendar_buckets(raw, "month")) == 13  # the exact relative window
    w = align_window(raw, "month")
    buckets = calendar_buckets(w, "month")
    assert len(buckets) == 12
    assert buckets[0].label == "Nov 2025" and buckets[-1].label == "Oct 2026"
    assert w.start == _utc(2025, 11, 1, 4)  # local midnight, 1 Nov 2025 (EDT)
    assert buckets[1].start == _utc(2025, 12, 1, 5)  # EST
    assert [b.in_progress for b in buckets].count(True) == 1 and buckets[-1].in_progress
    assert not any(b.clipped for b in buckets)
    assert w.end == raw.end and w.aligned_to == "month"
    assert w.label == "last 12 months (since Nov 2025, America/New_York)"
    assert align_window(w, "month") is w  # idempotent


@pytest.mark.parametrize(
    "spec, unit, count, first",
    [
        ("now-7d", "day", 7, "4 Oct 2026"),
        ("now-24h", "hour", 24, "9 Oct 15:00"),
        ("now-14d", "week", 2, "W40 2026"),
        ("now-1y", "month", 12, "Nov 2025"),
        ("now-6M", "month", 6, "May 2026"),
        ("now-12M", "quarter", 4, "Q1 2026"),
        ("now-2y", "year", 2, "2025"),
    ],
)
def test_alignment_gives_n_whole_periods(spec, unit, count, first) -> None:
    w = align_window(resolve_window(spec, now=NOW), unit)
    buckets = calendar_buckets(w, unit)
    assert len(buckets) == count and buckets[0].label == first and buckets[-1].in_progress


@pytest.mark.parametrize(
    "spec, unit",
    [
        ("now-90d", "month"),  # not a whole number of months
        ("now-1M", "month"),  # a single period: aligning would keep only this month
        ("now-30d", "week"),
        ("last_month", "day"),  # calendar periods are already whole
        ("2026-Q3", "month"),
        ("all", "month"),
        ({"from": "2026-03-01", "to": "2026-10-10"}, "month"),
    ],
)
def test_alignment_leaves_other_windows_alone(spec, unit) -> None:
    w = resolve_window(spec, now=NOW)
    assert align_window(w, unit) is w


def test_unknown_timezone_falls_back_to_utc_and_says_so() -> None:
    w = resolve_window("last_month", tz="Mars/Olympus_Mons", now=NOW)
    assert w.tz == "UTC" and w.label == "September 2026"
    assert zone_for("+05:30")[1] == "+05:30"
    fixed = resolve_window("today", tz="+05:30", now=NOW)
    assert fixed.start == _utc(2026, 10, 9, 18, 30)


def test_contains_is_half_open() -> None:
    w = resolve_window("last_month", now=NOW)
    assert w.contains(_utc(2026, 9, 1))
    assert w.contains(_utc(2026, 9, 30, 23, 59, 59))
    assert not w.contains(_utc(2026, 10, 1))
    assert not w.contains(_utc(2026, 8, 31, 23, 59, 59))
    assert not w.contains(None)


def test_all_time_label_names_the_first_record() -> None:
    assert all_time_label(_utc(2025, 11, 3, 10)) == "all time (since 3 Nov 2025)"
    assert all_time_label(_utc(2025, 11, 3, 20), "Asia/Tokyo") == (
        "all time (since 4 Nov 2025) (Asia/Tokyo)"
    )
    assert all_time_label(None) == "all time"


# --------------------------------------------------------------------------- #
# Calendar periods
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "unit, instant, start, label",
    [
        ("hour", _utc(2026, 10, 10, 14, 23), _utc(2026, 10, 10, 14), "10 Oct 14:00"),
        ("day", _utc(2026, 10, 10, 14, 23), _utc(2026, 10, 10), "10 Oct 2026"),
        ("week", _utc(2026, 4, 2, 9), _utc(2026, 3, 30), "W14 2026"),
        ("month", _utc(2026, 3, 17), _utc(2026, 3, 1), "Mar 2026"),
        ("quarter", _utc(2026, 8, 17), _utc(2026, 7, 1), "Q3 2026"),
        ("year", _utc(2026, 8, 17), _utc(2026, 1, 1), "2026"),
    ],
)
def test_period_start_and_label(unit, instant, start, label) -> None:
    assert period_start(instant, unit) == start
    assert period_label(start, unit) == label


def test_iso_week_53_and_year_boundary() -> None:
    # 2026 has 53 ISO weeks (31 Dec 2026 is a Thursday).
    start = period_start(_utc(2026, 12, 31), "week")
    assert start == _utc(2026, 12, 28) and period_label(start, "week") == "W53 2026"
    assert next_period_start(start, "week") == _utc(2027, 1, 4)
    assert period_label(_utc(2027, 1, 4), "week") == "W01 2027"


def test_half_hour_zone_hours_and_days() -> None:
    # In IST an hour starts at :30 UTC and a day at 18:30 UTC.
    assert period_start(_utc(2026, 10, 10, 14, 10), "hour", "Asia/Kolkata") == _utc(2026, 10, 10, 13, 30)
    assert period_start(_utc(2026, 10, 10, 20), "day", "Asia/Kolkata") == _utc(2026, 10, 10, 18, 30)
    assert period_label(_utc(2026, 10, 10, 18, 30), "day", "Asia/Kolkata") == "11 Oct 2026"


# --------------------------------------------------------------------------- #
# calendar_buckets
# --------------------------------------------------------------------------- #
def test_month_buckets_for_last_90_days_are_zero_filled_and_flag_the_current_month() -> None:
    w = resolve_window("now-90d", now=NOW)
    buckets = calendar_buckets(w, "month")
    assert [b.label for b in buckets] == ["Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026"]
    assert [b.in_progress for b in buckets] == [False, False, False, True]
    # The window starts mid-July: that bucket is only partly inside it.
    assert buckets[0].clipped and not buckets[1].clipped
    assert all(b.end == nxt.start for b, nxt in zip(buckets, buckets[1:]))


def test_twelve_monthly_buckets_for_an_explicit_range_in_a_non_utc_zone() -> None:
    """12 monthly buckets for an explicit 12-month range with correct month boundaries
    in a non-UTC timezone, and the current period flagged (the literal phrase "last 12
    months" is covered by ``test_last_12_months_by_month_is_twelve_whole_months``)."""
    w = resolve_window(
        {"from": "2025-11-01", "to": "2026-10-31"}, tz="America/New_York",
        now=_utc(2026, 10, 10, 16),
    )
    buckets = calendar_buckets(w, "month")
    assert len(buckets) == 12
    assert buckets[0].label == "Nov 2025" and buckets[-1].label == "Oct 2026"
    # Local midnight on the 1st: EDT (UTC-4) in summer, EST (UTC-5) in winter.
    assert buckets[0].start == _utc(2025, 11, 1, 4)  # 1 Nov 2025 is still EDT
    assert buckets[1].start == _utc(2025, 12, 1, 5)  # EST
    assert buckets[5].start == _utc(2026, 4, 1, 4)  # EDT again
    assert [b.in_progress for b in buckets].count(True) == 1 and buckets[-1].in_progress
    assert not any(b.clipped for b in buckets[:-1])


def test_week_buckets_are_iso_monday_based() -> None:
    w = resolve_window("this_quarter", now=NOW)
    buckets = calendar_buckets(w, "week")
    assert buckets[0].start == _utc(2026, 9, 28)  # the Monday on/before 1 Oct
    assert buckets[0].label == "W40 2026" and buckets[0].clipped
    assert all(b.start.weekday() == 0 for b in buckets)
    assert buckets[-1].in_progress and buckets[-1].label == "W41 2026"


def test_dst_day_buckets_are_23_and_25_hours() -> None:
    w = resolve_window({"from": "2026-03-07", "to": "2026-03-09"}, tz="America/New_York", now=NOW)
    lengths = [(b.label, b.end - b.start) for b in calendar_buckets(w, "day")]
    assert lengths == [
        ("7 Mar 2026", timedelta(hours=24)),
        ("8 Mar 2026", timedelta(hours=23)),
        ("9 Mar 2026", timedelta(hours=24)),
    ]
    fall = resolve_window("2026-11-01", tz="America/New_York", now=NOW)
    days = calendar_buckets(fall, "day")
    assert len(days) == 1 and days[0].end - days[0].start == timedelta(hours=25)


def test_fall_back_hour_buckets_disambiguate_the_repeated_hour() -> None:
    w = resolve_window("2026-11-01", tz="America/New_York", now=NOW)
    hours = calendar_buckets(w, "hour")
    assert len(hours) == 25
    labels = [b.label for b in hours]
    assert len(set(labels)) == 25  # the repeated 01:00 carries its zone abbreviation
    assert labels[1] == "1 Nov 01:00" and labels[2].startswith("1 Nov 01:00 ")


def test_spring_forward_hour_buckets_skip_the_missing_hour() -> None:
    w = resolve_window("2026-03-08", tz="America/New_York", now=NOW)
    hours = calendar_buckets(w, "hour")
    assert len(hours) == 23
    assert "8 Mar 02:00" not in [b.label for b in hours]


@pytest.mark.parametrize("tz", ["UTC", "Asia/Kolkata", "America/New_York", "Europe/London",
                                "Australia/Lord_Howe"])
@pytest.mark.parametrize("unit", BUCKET_UNITS)
def test_buckets_partition_the_window(tz, unit) -> None:
    """Every instant in the window falls in exactly one bucket, and that bucket is the
    one ``period_start`` names — so bucket sums equal the window total."""
    w = resolve_window({"from": "2025-12-20", "to": "2026-04-05"}, tz=tz, now=NOW)
    if unit == "hour":
        w = resolve_window({"from": "2026-03-27", "to": "2026-04-06"}, tz=tz, now=NOW)
    buckets = calendar_buckets(w, unit)
    assert buckets and all(a.end == b.start for a, b in zip(buckets, buckets[1:]))
    assert buckets[0].start <= w.start < buckets[0].end
    assert buckets[-1].start < w.end <= buckets[-1].end
    rng = random.Random(f"{tz}{unit}")
    span = (w.end - w.start).total_seconds()
    starts = {b.start for b in buckets}
    for _ in range(300):
        instant = w.start + timedelta(seconds=rng.uniform(0, span - 1e-3))
        holders = [b for b in buckets if b.start <= instant < b.end]
        assert len(holders) == 1
        assert period_start(instant, unit, tz) in starts
        assert period_start(instant, unit, tz) == holders[0].start


def test_past_window_has_no_in_progress_bucket_and_all_time_needs_data() -> None:
    w = resolve_window("last_quarter", now=NOW)
    assert not any(b.in_progress for b in calendar_buckets(w, "month"))
    everything = resolve_window("all", now=NOW)
    assert calendar_buckets(everything, "month") == []
    from_data = calendar_buckets(everything, "month", earliest=_utc(2026, 7, 15))
    assert [b.label for b in from_data] == ["Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026"]
    assert not from_data[0].clipped  # no lower bound: nothing was cut
    # A record stamped after "now" extends an all-time axis instead of being lost.
    later = calendar_buckets(everything, "month", earliest=_utc(2026, 9, 2),
                             latest=_utc(2026, 12, 2))
    assert [b.label for b in later] == ["Sep 2026", "Oct 2026", "Nov 2026", "Dec 2026"]


def test_unknown_unit_rejected() -> None:
    with pytest.raises(ValueError):
        calendar_buckets(resolve_window("now-1d", now=NOW), "fortnight")  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# auto_bucket
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "spec, unit",
    [
        ("now-24h", "hour"),
        ("now-7d", "hour"),  # 169 hourly buckets fit under 200
        ("now-30d", "day"),
        ("now-90d", "day"),
        ("now-6M", "day"),  # 184 days
        ("now-12M", "week"),
        ("now-5y", "month"),
    ],
)
def test_auto_bucket_picks_the_smallest_unit_under_the_point_cap(spec, unit) -> None:
    w = resolve_window(spec, now=NOW)
    chosen = auto_bucket(w)
    assert chosen == unit
    assert bucket_count(w, chosen) <= MAX_POINTS
    smaller = BUCKET_UNITS[BUCKET_UNITS.index(chosen) - 1] if chosen != "hour" else None
    if smaller:
        assert bucket_count(w, smaller) > MAX_POINTS


def test_auto_bucket_all_time_uses_the_earliest_record() -> None:
    w = resolve_window("all", now=NOW)
    assert auto_bucket(w) == "month"  # no span known yet
    assert auto_bucket(w, earliest=_utc(2026, 9, 1)) == "day"
    assert auto_bucket(w, earliest=_utc(2012, 1, 1)) == "month"  # 178 months
    assert auto_bucket(w, earliest=_utc(2010, 1, 1)) == "quarter"  # 202 months > 200
    assert auto_bucket(w, earliest=_utc(1990, 1, 1), max_points=10) == "year"
