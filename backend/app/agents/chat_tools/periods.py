"""Period comparisons for the aggregate chat tools (Round 12 SPEC D7, §3.4, P0-6).

A ``compare`` input on ``case_stats``, ``log_stats``, ``soc_metrics`` and
``cost_usage`` names the periods to set against the call's own window:

* ``"previous_period"`` — the period just before (the previous calendar month,
  quarter, year, week or day for a complete calendar window; for a calendar period
  still in progress — ``this_month``, ``this_quarter``, ``this_year``, ``ytd``,
  ``this_week``, ``today`` — the SAME elapsed part of the previous one, so October
  1–10 is compared with September 1–10, never with all of September; for a relative
  window broken down by a calendar unit (aligned to N whole periods, the last in
  progress) the N periods before it cut at the same point, so "the last 6 months by
  month" (May to 10 Oct) is compared with November to 10 April; the same length
  before it for any other relative or custom window);
* ``"same_period_last_year"`` — the same window one calendar year earlier (whole ISO
  weeks step back to the same ISO week of the previous year, so a Monday-to-Sunday
  week is compared with a Monday-to-Sunday week);
* ``{"from": ..., "to": ...}`` — one explicit window (any form ``window`` accepts);
* ``{"periods": [...]}`` or a list — up to :data:`MAX_COMPARE_PERIODS` windows.

The tool measures each period with the SAME code as its own window, and
:func:`comparison_data` turns the figures into a ``comparison`` artifact: periods in
chronological order (the latest is the subject, the one before it the baseline) and
rows whose deltas are computed here, in code (``blocks.compare_values``: a zero
baseline is "new", never infinity). The model only narrates them. Calendar maths
runs in the operator timezone (``SlaPolicy.timezone``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Literal
from zoneinfo import ZoneInfo

from ..blocks import SMALL_SAMPLE_N, compare_values, finite_number
from .common import ALL_TIME_START, Window, resolve_window, window_input

#: At most this many periods besides the call's own window (SPEC §3.1: ``periods[≤4]``).
MAX_COMPARE_PERIODS = 4
COMPARE_KEYWORDS = ("previous_period", "same_period_last_year")
COMPARE_HELP = (
    "compare is previous_period, same_period_last_year, a window {from, to}, or up to "
    f"{MAX_COMPARE_PERIODS} periods"
)
INVALID_COMPARE = f"Invalid input: {COMPARE_HELP}"
_KEYWORD_ALIASES = {
    "previous": "previous_period", "prev": "previous_period", "previous_window": "previous_period",
    "prior_period": "previous_period", "last_period": "previous_period", "mom": "previous_period",
    "month_over_month": "previous_period", "wow": "previous_period", "qoq": "previous_period",
    "same_period_last_year": "same_period_last_year", "last_year_same_period": "same_period_last_year",
    "yoy": "same_period_last_year", "year_over_year": "same_period_last_year",
}
# Calendar step of a window token (months for month-like units, days otherwise).
_TOKEN_STEP: dict[str, tuple[str, int]] = {
    "today": ("day", 1), "yesterday": ("day", 1),
    "this_week": ("day", 7), "last_week": ("day", 7),
    "this_month": ("month", 1), "last_month": ("month", 1),
    "this_quarter": ("month", 3), "last_quarter": ("month", 3),
    "ytd": ("month", 12), "this_year": ("month", 12), "last_year": ("month", 12),
}
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# Calendar periods that end NOW (still in progress) and the unit that names them.
_IN_PROGRESS_UNIT: dict[str, str] = {
    "today": "day", "this_week": "week", "this_month": "month", "this_quarter": "quarter",
    "this_year": "year", "ytd": "year",
}


def normalise_compare(value: Any) -> Any:
    """The ``compare`` input as a model may send it, normalised for validation:
    a keyword, a ``{from, to}`` window, or a list of windows (``{"periods": [...]}``
    too). Raises ``ValueError`` (named ``compare`` by the input model) otherwise."""
    if value is None or value is False or (isinstance(value, str) and not value.strip()):
        return None
    if value is True:
        return "previous_period"
    if isinstance(value, str):
        key = value.strip().lower().replace("-", "_").replace(" ", "_")
        key = _KEYWORD_ALIASES.get(key, key)
        if key in COMPARE_KEYWORDS:
            return key
        return [window_input(value)]
    if isinstance(value, dict):
        if "periods" in value:
            return normalise_compare(value.get("periods"))
        return [window_input(value)]
    if isinstance(value, (list, tuple)):
        if not value or len(value) > MAX_COMPARE_PERIODS:
            raise ValueError(COMPARE_HELP)
        out = []
        for item in value:
            if isinstance(item, str) and _KEYWORD_ALIASES.get(item.strip().lower(), item.strip().lower()) in COMPARE_KEYWORDS:
                raise ValueError(COMPARE_HELP)
            out.append(window_input(item))
        return out
    raise ValueError(COMPARE_HELP)


@dataclass(frozen=True)
class Period:
    """One compared window: its ``label`` (in the operator timezone) and whether it is
    still in progress (it ends now)."""

    window: Window
    label: str
    in_progress: bool


def _zone(name: str) -> Any:
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 — a bad zone was already folded to UTC upstream
        return timezone.utc


def _shift_months(moment: datetime, months: int, tz: str) -> datetime:
    """``moment`` moved by whole calendar months in ``tz`` (the day clamped to the
    target month's length), returned in UTC."""
    local = moment.astimezone(_zone(tz))
    index = local.year * 12 + (local.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    last_day = (datetime(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    shifted = local.replace(year=year, month=month, day=min(local.day, last_day))
    return shifted.astimezone(timezone.utc)


def _day_label(moment: datetime, tz: str) -> str:
    local = moment.astimezone(_zone(tz))
    return f"{local.day} {_MONTHS[local.month - 1]} {local.year}"


def range_label(start: datetime, end: datetime, tz: str) -> str:
    """A calendar label for a window in the operator timezone: "Sep 2026" for a
    whole month, "Q3 2026", "2026", "W41 2026", "8 Oct 2026" for a whole day, else
    "12 Jul – 9 Oct 2026"."""
    zone = _zone(tz)
    a, b = start.astimezone(zone), end.astimezone(zone)
    midnight = a.time() == b.time() == datetime.min.time()
    if midnight and a.day == 1 and b.day == 1:
        months = (b.year - a.year) * 12 + (b.month - a.month)
        if months == 1:
            return f"{_MONTHS[a.month - 1]} {a.year}"
        if months == 3 and (a.month - 1) % 3 == 0:
            return f"Q{(a.month - 1) // 3 + 1} {a.year}"
        if months == 12 and a.month == 1:
            return str(a.year)
    if midnight and (b - a) == timedelta(days=1):
        return _day_label(start, tz)
    if midnight and (b - a) == timedelta(days=7) and a.weekday() == 0:
        iso = a.isocalendar()
        return f"W{iso[1]:02d} {iso[0]}"
    last = end - timedelta(seconds=1)
    if midnight:
        if a.year == last.astimezone(zone).year:
            first = f"{a.day} {_MONTHS[a.month - 1]}"
            return f"{first} – {_day_label(last, tz)}"
        return f"{_day_label(start, tz)} – {_day_label(last, tz)}"
    if a.time() == datetime.min.time():
        # A calendar period still in progress a year earlier ("this month" last year):
        # whole days from its start, the end to the minute.
        if a.date() == b.date():
            return f"{_day_label(start, tz)} to {b:%H:%M}"
        head = f"{a.day} {_MONTHS[a.month - 1]}" + ("" if a.year == b.year else f" {a.year}")
        return f"{head} – {_day_label(end, tz)} {b:%H:%M}"
    # Any other window to the minute, in the same words as the window it is compared
    # with ("26 Jul 20:45 – 3 Sep 2026 05:30"). Like every other period name it never
    # names the zone: a comparison names it once (:func:`comparison_caption`).
    if a.date() == b.date():
        return f"{_day_label(start, tz)} {a:%H:%M} – {b:%H:%M}"
    head = f"{a.day} {_MONTHS[a.month - 1]}" + ("" if a.year == b.year else f" {a.year}")
    return f"{head} {a:%H:%M} – {_day_label(end, tz)} {b:%H:%M}"


def _window_from(start: datetime, end: datetime, base: Window, label: str) -> Window:
    return Window(
        time_from=start.isoformat(), time_to=end.isoformat(), start=start, end=end,
        hours=max(1, int((end - start).total_seconds() // 3600)), label=label, source="tool",
        clamped=False, all_time=False, tz=base.tz, token=f"{start.isoformat()}..{end.isoformat()}",
    )


def _calendar_step(window: Window) -> tuple[str, int] | None:
    """The calendar step of a window: its token's ("last_month" → one month), or, for a
    window that runs from a local month start to a later one ("2026-09", "2026-Q3",
    {"from": "2026-03-01", "to": "2026-06-01"}), that many whole months. ``None`` for
    anything else (a trailing or a partial window steps back by its own length)."""
    step = _TOKEN_STEP.get(window.token)
    if step is not None or window.trailing:
        return step
    zone = _zone(window.tz)
    a, b = window.start.astimezone(zone), window.end.astimezone(zone)
    if a.time() == b.time() == datetime.min.time() and a.day == 1 and b.day == 1:
        months = (b.year - a.year) * 12 + (b.month - a.month)
        if months > 0:
            return ("month", months)
    return None


def _shift_days(moment: datetime, days: int, tz: str) -> datetime:
    """``moment`` moved by whole local days in ``tz`` (the wall-clock time kept)."""
    local = moment.astimezone(_zone(tz))
    shifted = (local.replace(tzinfo=None) + timedelta(days=days)).replace(tzinfo=_zone(tz))
    return shifted.astimezone(timezone.utc)


def _in_progress_unit(window: Window) -> str | None:
    """The calendar unit of a window that is a calendar period still in progress
    (``this_month`` and friends, unclamped, ending now), else ``None``."""
    if window.all_time or window.clamped or not window.trailing:
        return None
    return _IN_PROGRESS_UNIT.get(window.token)


def period_name(start: datetime, unit: str, tz: str) -> str:
    """The short calendar name of the ``unit`` period starting at ``start``: "Oct 2026",
    "Q4 2026", "2026", "W41 2026", "10 Oct 2026"."""
    local = start.astimezone(_zone(tz))
    if unit == "month":
        return f"{_MONTHS[local.month - 1]} {local.year}"
    if unit == "quarter":
        return f"Q{(local.month - 1) // 3 + 1} {local.year}"
    if unit == "year":
        return str(local.year)
    if unit == "week":
        iso = local.isocalendar()
        return f"W{iso[1]:02d} {iso[0]}"
    return _day_label(start, tz)


def in_progress_label(start: datetime, end: datetime, unit: str, tz: str) -> str:
    """A period cut at the same point as one in progress: "Oct 2026 to date",
    "Sep 2026 to date" (its first days, up to the same date), "10 Oct 2026 to 12:00"."""
    if unit == "day":
        local_end = end.astimezone(_zone(tz))
        return f"{period_name(start, unit, tz)} to {local_end:%H:%M}"
    return f"{period_name(start, unit, tz)} to date"


def _aligned_unit(window: Window) -> str | None:
    """The calendar unit of a relative window counted in whole periods
    (``common.whole_periods``: whole days or whole months), still running, else ``None``."""
    if window.all_time or window.clamped or not window.trailing:
        return None
    return window.aligned_to


def _shift_periods(moment: datetime, unit: str, periods: int, tz: str) -> datetime:
    """``moment`` moved back by ``periods`` calendar ``unit`` periods in ``tz`` (the
    wall-clock time kept; whole hours for an hour)."""
    if unit in ("month", "quarter", "year"):
        return _shift_months(moment, -periods * {"month": 1, "quarter": 3, "year": 12}[unit], tz)
    if unit in ("week", "day"):
        return _shift_days(moment, -periods * (7 if unit == "week" else 1), tz)
    return moment - timedelta(hours=periods)


def _period_count(window: Window, unit: str) -> int:
    """How many ``unit`` periods an aligned window spans (the last in progress)."""
    from ...engine.time_windows import bucket_count

    try:
        return int(bucket_count(window.as_resolved(), unit))  # type: ignore[arg-type]
    except NotImplementedError:
        raise
    except Exception:  # noqa: BLE001 — not countable: the caller steps back by length
        return 0


def _iso_week_shift(window: Window) -> int | None:
    """Days to step a whole-ISO-week window back to the same ISO week of the previous
    ISO year (W41 2026 → W41 2025, Monday to Monday), or ``None`` when the window is
    not whole ISO weeks. A week 53 with no counterpart steps back 52 weeks."""
    if window.all_time or window.clamped:
        return None
    zone = _zone(window.tz)
    a = window.start.astimezone(zone)
    weekly = window.token in ("this_week", "last_week") or _aligned_unit(window) == "week"
    if not weekly:
        b = window.end.astimezone(zone)
        midnight = a.time() == b.time() == datetime.min.time()
        days = (b.date() - a.date()).days
        weekly = midnight and a.weekday() == 0 and days > 0 and days % 7 == 0
    if not weekly or a.weekday() != 0:
        return None
    from datetime import date as _date

    iso = a.isocalendar()
    try:
        target = _date.fromisocalendar(iso[0] - 1, iso[1], 1)
    except ValueError:
        target = a.date() - timedelta(days=364)
    return (target - a.date()).days


def previous_period(window: Window) -> Window | None:
    """The period just before ``window``: the previous calendar period for a complete
    calendar window, the same elapsed part of the previous period for one still in
    progress ("this month" so far against the same days of last month) or for a
    relative window aligned to N whole periods (the N periods before it, cut at the
    same point), else the same length immediately before. ``None`` for all time."""
    if window.all_time:
        return None
    aligned = _aligned_unit(window)
    if aligned is not None:
        count = _period_count(window, aligned)
        if count > 0:
            start = _shift_periods(window.start, aligned, count, window.tz)
            end = _shift_periods(window.end, aligned, count, window.tz)
            if start < end <= window.start:
                return _window_from(start, end, window, range_label(start, end, window.tz))
    unit = _in_progress_unit(window)
    if unit is not None:
        if unit in ("month", "quarter", "year"):
            months = {"month": 1, "quarter": 3, "year": 12}[unit]
            start = _shift_months(window.start, -months, window.tz)
            end = _shift_months(window.end, -months, window.tz)
        else:
            days = 7 if unit == "week" else 1
            start = _shift_days(window.start, -days, window.tz)
            end = _shift_days(window.end, -days, window.tz)
        return _window_from(start, end, window, in_progress_label(start, end, unit, window.tz))
    step = _calendar_step(window)
    if step is not None:
        unit, amount = step
        if unit == "month":
            start = _shift_months(window.start, -amount, window.tz)
        else:
            start = window.start - timedelta(days=amount)
        end = window.start
    else:
        span = window.end - window.start
        start, end = window.start - span, window.start
        if window.trailing and window.label.startswith("last ") and aligned is None:
            # "last 90 days" → "previous 90 days" (the same length just before it).
            return _window_from(start, end, window, "previous " + window.label[len("last "):])
    return _window_from(start, end, window, range_label(start, end, window.tz))


def same_period_last_year(window: Window) -> Window | None:
    """``window`` one calendar year earlier (both bounds). Whole ISO weeks step back to
    the same ISO week of the previous ISO year (Monday stays Monday, so weekend volume
    is compared with weekend volume). ``None`` for all time."""
    if window.all_time:
        return None
    unit = _in_progress_unit(window)
    weeks = _iso_week_shift(window)
    if weeks is not None:
        start = _shift_days(window.start, weeks, window.tz)
        end = _shift_days(window.end, weeks, window.tz)
        if unit == "week":
            return _window_from(start, end, window, in_progress_label(start, end, "week", window.tz))
        return _window_from(start, end, window, range_label(start, end, window.tz))
    start = _shift_months(window.start, -12, window.tz)
    end = _shift_months(window.end, -12, window.tz)
    if unit in ("day", "month", "quarter", "year"):
        # A year earlier the period starts on the same calendar boundary.
        return _window_from(start, end, window, in_progress_label(start, end, unit, window.tz))
    if _aligned_unit(window) is not None:
        # "last 6 months (since May 2026)" a year earlier is a dated range, never a
        # relabelled "since May 2026".
        return _window_from(start, end, window, range_label(start, end, window.tz))
    if window.trailing and window.label.startswith("last "):
        return _window_from(start, end, window, f"same {window.label[len('last '):]} a year earlier")
    return _window_from(start, end, window, range_label(start, end, window.tz))


def subject_label(window: Window) -> str:
    """The call's own window as a period label, in the same short form as the period
    it is compared with: a past window that is one whole calendar period reads as it
    ("Sep 2026", "Q3 2026", "W40 2026"); a calendar period in progress reads "Oct 2026
    to date" / "W41 2026 to date" / "10 Oct 2026 to 12:00"; anything else keeps its
    window label ("last 90 days")."""
    unit = _in_progress_unit(window)
    if unit is not None:
        return in_progress_label(window.start, window.end, unit, window.tz)
    if "→" in window.label and not window.all_time:
        # A raw UTC minute range (a window narrowed to the selected range) reads in the
        # same local words as the period it is compared with.
        return range_label(window.start, window.end, window.tz)
    if window.all_time or window.trailing:
        return _zone_free(window.label, window.tz)
    calendar = range_label(window.start, window.end, window.tz)
    return calendar if "–" not in calendar else _zone_free(window.label, window.tz)


def _zone_free(label: str, tz: str) -> str:
    """``label`` without the operator zone the window resolver appended to it ("…
    (Asia/Kolkata)", "last 6 months (since May 2026, Asia/Kolkata)"): a period name
    never carries the zone, the comparison names it once (:func:`comparison_caption`)."""
    if not tz or tz == "UTC":
        return label
    return label.removesuffix(f" ({tz})").replace(f", {tz})", ")")


# Period names that do not depend on the operator zone: a trailing span ("last 90
# days", "past month") and the same span before it ("previous 90 days", "same 90 days
# a year earlier"). Any other name (a calendar period, a dated range) was cut in it.
_ZONE_FREE_NAME = re.compile(
    r"^(?:(?:last|previous|same) (?:[\d,]+ (?:minute|hour|day|week|month|year)s?|minute|hour)"
    r"(?: a year earlier)?|past (?:month|year))$"
)


def comparison_caption(periods: list[Period]) -> str:
    """The scope caption of a ``comparison`` artifact: its periods, latest first
    ("Oct 2026 to date vs Sep 2026 to date"), then the operator zone ONCE when any of
    them was cut in it ("… (Asia/Kolkata)")."""
    text = " vs ".join(p.label for p in reversed(periods))
    tz = periods[-1].window.tz if periods else "UTC"
    if tz and tz != "UTC" and any(not _ZONE_FREE_NAME.match(p.label) for p in periods):
        text += f" ({tz})"
    return text


def _running(window: Window) -> bool:
    """Is the window still in progress (it ends now, or later: "to" today's date)?"""
    return window.trailing or (window.ref is not None and window.end > window.ref)


def resolve_periods(
    ctx: Any, window: Window, compare: Any, *, now: datetime | None = None, minutes_ok: bool = True,
) -> list[Period] | str:
    """The compared periods in chronological order, the call's own window among them
    (the latest period is the subject of the deltas), or an engine-template error.
    ``minutes_ok`` is passed to :func:`resolve_window` for explicit compare windows."""
    if compare is None:
        return [Period(window, subject_label(window), _running(window))]
    if window.all_time and compare in COMPARE_KEYWORDS:
        return "Invalid input: compare needs a bounded window (all time has no previous period)"
    others: list[Window] = []
    if compare == "previous_period":
        prev = previous_period(window)
        if prev is not None:
            others.append(prev)
    elif compare == "same_period_last_year":
        prev = same_period_last_year(window)
        if prev is not None:
            others.append(prev)
    else:
        specs = compare if isinstance(compare, list) else [compare]
        if len(specs) > MAX_COMPARE_PERIODS:
            return f"Invalid input: {COMPARE_HELP}"
        for spec in specs:
            other = resolve_window(ctx, window=spec, now=now, minutes_ok=minutes_ok)
            if isinstance(other, str):
                return other
            if other.clamped:
                return "Invalid input: a compared period lies outside the selected range"
            others.append(other)
    periods = [Period(window, subject_label(window), _running(window))]
    for other in others:
        # Every period is named the same way as the subject ("Jul 2026", "Q3 2026"; a
        # raw ISO range reads as its calendar label, :func:`subject_label`).
        periods.append(Period(other, subject_label(other), _running(other)))
    # Chronological: the latest is the subject of the deltas; equal labels are made unique.
    periods.sort(key=lambda p: (p.window.start if not p.window.all_time else ALL_TIME_START, p.window.end))
    seen: dict[str, int] = {}
    unique: list[Period] = []
    for period in periods:
        n = seen.get(period.label, 0) + 1
        seen[period.label] = n
        unique.append(period if n == 1 else Period(period.window, f"{period.label} ({n})", period.in_progress))
    return unique


def comparison_row(
    key: str, label: str, values: Iterable[Any], *, unit: str = "count", good: Literal["up", "down", "none"] = "none",
    samples: Iterable[Any] | None = None,
) -> dict[str, Any]:
    """One ``comparison`` row: the value per period, the change of the latest period
    against the one before it (in the row's unit; a zero baseline is ``new``), and the
    small-sample flag (fewer than 20 observations behind either compared value: the
    count itself for counts, the denominator for rates)."""
    values = [finite_number(v) for v in values]
    change = compare_values(values[-1], values[-2]) if len(values) >= 2 else {
        "delta": None, "delta_pct": None, "new": False}
    sizes = [finite_number(n) for n in samples] if samples is not None else (
        values if unit in ("count", "tokens") else [])
    compared = sizes[-2:] if len(sizes) >= 2 else sizes
    small = any(n is not None and n < SMALL_SAMPLE_N for n in compared)
    return {"key": key, "label": label, "unit": unit, "values": values, "good_direction": good,
            "small_sample": small, **change}


def comparison_data(periods: list[Period], rows: list[dict[str, Any]], *, dimension: str | None = None,
                    unit: str | None = None) -> dict[str, Any]:
    """The ``comparison`` artifact payload (``base.ARTIFACT_DATA_SHAPES``)."""
    data: dict[str, Any] = {
        "periods": [{"label": p.label, "in_progress": p.in_progress} for p in periods],
        "rows": rows,
    }
    if dimension:
        data["dimension"] = dimension
    if unit:
        data["unit"] = unit
    return data


def _span(period: Period) -> float | None:
    """The ELAPSED span of a period: up to now for one that ends later."""
    window = period.window
    if window.all_time:
        return None
    end = min(window.end, window.ref) if window.ref is not None else window.end
    return (end - window.start).total_seconds()


def in_progress_note(periods: list[Period]) -> str | None:
    """What the model must say about a period still in progress (engine text)."""
    if len(periods) < 2 or not periods[-1].in_progress:
        return None
    latest, baseline = _span(periods[-1]), _span(periods[-2])
    if latest is not None and baseline is not None and latest < baseline * 0.99:
        return ("The latest period is still in progress and shorter than the one it is compared "
                "with, so the change compares a partial period; say so.")
    return ("The latest period is still in progress; each compared period covers the same elapsed "
            "time, so the change is like for like.")


def comparison_observation(periods: list[Period], rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The comparison as the model sees it: period labels, which are still in
    progress, each row's values and the code-computed change (``change`` in the row's
    unit, ``change_pct`` of the baseline, ``new`` for a zero baseline,
    ``small_sample`` when n < 20)."""
    out: dict[str, Any] = {
        "periods": [p.label for p in periods],
        "in_progress": [bool(p.in_progress) for p in periods],
        "subject": periods[-1].label if periods else None,
        "baseline": periods[-2].label if len(periods) >= 2 else None,
    }
    note = in_progress_note(periods)
    if note:
        out["note"] = note
    out["rows"] = [
            {"label": r["label"], "unit": r["unit"], "values": r["values"], "change": r.get("delta"),
             "change_pct": r.get("delta_pct"), "new": r.get("new", False),
             "small_sample": r.get("small_sample", False)}
            for r in rows
        ]
    return out


__all__ = [
    "COMPARE_HELP",
    "INVALID_COMPARE",
    "MAX_COMPARE_PERIODS",
    "Period",
    "comparison_caption",
    "comparison_data",
    "comparison_observation",
    "comparison_row",
    "in_progress_label",
    "in_progress_note",
    "normalise_compare",
    "period_name",
    "previous_period",
    "range_label",
    "resolve_periods",
    "same_period_last_year",
    "subject_label",
]
