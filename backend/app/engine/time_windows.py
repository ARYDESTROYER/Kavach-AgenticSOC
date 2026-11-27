"""Time windows and calendar buckets for exact aggregates (Round 12 SPEC §3.5, D7).

The ONE place a human time-window phrase becomes two instants, and the ONE place an
instant becomes a calendar period. Everything is resolved in the OPERATOR timezone
(``SlaPolicy.timezone``, default UTC) with :mod:`zoneinfo`, so "last month", "this
week" and a monthly breakdown all mean the calendar periods an analyst in that zone
would name. Pure stdlib; no I/O; deterministic given ``now``.

Accepted window specs (``resolve_window``):

* ``None`` / ``""`` / ``{}`` — the ``default`` spec (``"all"`` unless the caller says);
* ``"all"`` / ``"lifetime"`` / ``"all_time"`` / ``"all time"`` / ``"*"`` — all time
  (``start=None``, no upper bound: a future-dated record is still counted, never
  dropped);
* ``"now-N<unit>"`` relative to ``now`` — ``m`` minutes, ``h`` hours, ``d`` days,
  ``w`` weeks (exact durations), ``M`` / ``mo`` months and ``y`` years (calendar
  arithmetic in ``tz``, so "now-6M" is exactly six calendar months). The lenient
  spellings ``"90d"``, ``"last_90_days"``, ``"last 6 months"``, ``"past 24 hours"``
  resolve to the same windows. A bare integer is a number of hours (the legacy
  ``window_hours`` alias);
* calendar tokens — ``today``, ``yesterday``, ``this_week``, ``last_week``,
  ``this_month``, ``last_month``, ``this_quarter``, ``last_quarter``, ``ytd``,
  ``this_year``, ``last_year`` (spaces/hyphens accepted). ISO weeks start on Monday.
  ``this_*``/``today``/``ytd`` end at ``now``; ``last_*``/``yesterday`` are complete
  periods;
* period literals — ``"2026"`` (a year), ``"2026-09"`` (a month), ``"2026-Q3"`` /
  ``"Q3 2026"`` (a quarter), ``"2026-W14"`` (an ISO week), ``"2026-09-14"`` (a day);
* ranges — ``{"from": A, "to": B}`` (also ``start``/``end``, ``time_from``/``time_to``,
  ``gte``/``lte``) or the strings ``"A..B"`` / ``"A/B"``. Each bound may be an ISO
  timestamp (naive means ``tz``), an ISO date (a ``to`` date is INCLUSIVE: the window
  runs to the end of that day), epoch millis, ``now``, ``now-N<unit>``, a calendar
  token or a period literal (a ``from`` takes its start, a ``to`` its end). A missing
  ``from`` means "since the beginning"; a missing ``to`` means "until now".

Anything else raises :class:`ValueError` with a message that names the accepted forms,
so a caller can reject unknown input VISIBLY instead of silently widening a window. That
includes empty windows ("now-0d", "last 0 days", a range whose start is not before its
end), negative hour counts and spans the calendar cannot represent ("now-999999y") —
never an ``OverflowError``. The integer ``0`` alone keeps its documented legacy meaning
(``window_hours=0``: no window, all time).

:func:`align_whole_periods` turns a relative window of days, weeks, months or years
into N whole periods of its own unit ("the last 12 months" is twelve months, the last in
progress, not thirteen with a partial first), whatever it is broken down by, so every
lookup of one window starts at the same instant; :func:`align_window` applies it to a
breakdown and the aggregates apply that themselves.

Semantics: a window is the half-open interval ``[start, end)`` (``start=None`` means
unbounded below; ``open_end`` means unbounded above). Labels are plain English
("all time", "last 90 days", "September 2026", "Q3 2026", "this week",
"1 Mar – 10 Oct 2026"); when the label names a date or a calendar period and the zone
is not UTC, the zone is appended ("September 2026 (Asia/Kolkata)"). Pure durations
("last 90 days") and "all time" are zone-independent and carry no suffix.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

BucketUnit = Literal["hour", "day", "week", "month", "quarter", "year"]
BUCKET_UNITS: tuple[str, ...] = ("hour", "day", "week", "month", "quarter", "year")
MAX_POINTS = 200
# A hard safety bound on how many buckets one call will materialise (ten years of
# hours is ~88k). A request beyond it is a programming error, not a silent cap.
MAX_GENERATED_BUCKETS = 200_000

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_MONTHS_LONG = (
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December",
)
_UTC_NAMES = frozenset({"UTC", "Etc/UTC", "Etc/UCT", "UCT", "GMT", "Etc/GMT", "Z", "Zulu",
                        "Etc/Zulu", "Universal", "Etc/Universal", "Etc/GMT+0", "Etc/GMT-0",
                        "Etc/GMT0", "GMT0", "GMT+0", "GMT-0", "Greenwich", "Etc/Greenwich"})

ACCEPTED_FORMS = (
    "all time ('all'), a relative window ('now-90d', 'now-6M', 'last 30 days'), a calendar "
    "period ('today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', "
    "'this_quarter', 'last_quarter', 'ytd', 'this_year', 'last_year'), a period literal "
    "('2026', '2026-09', '2026-Q3', '2026-W14', '2026-09-14') or a range "
    "({'from': '2026-03-01', 'to': '2026-10-10'})"
)


# --------------------------------------------------------------------------- #
# Data shapes
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ResolvedWindow:
    start: datetime | None  # None = all time
    end: datetime  # timezone-aware UTC (exclusive unless ``open_end``)
    label: str  # "all time (since 3 Nov 2025)", "Q3 2026", "last 90 days"
    tz: str  # IANA name used for calendar math
    token: str  # the normalised input ("all", "now-90d", "last_month", "2026-03-01..2026-10-10")
    # --- additive (WP-AGG) ---
    # The instant the window was resolved at (drives a bucket's ``in_progress`` flag).
    now: datetime | None = None
    # No upper bound: "all time" also counts a record stamped after ``now``.
    open_end: bool = False
    # all | relative | calendar | period | range
    kind: str = ""
    # The calendar unit a relative window's start was snapped to (see
    # :func:`align_window`), or None when the window is exactly as resolved.
    aligned_to: str | None = None

    def contains(self, instant: datetime | None) -> bool:
        """Is ``instant`` inside ``[start, end)``? ``None`` (an unreadable time) is
        NOT contained — callers decide never-drop handling explicitly."""
        if instant is None:
            return False
        instant = _aware_utc(instant)
        if self.start is not None and instant < self.start:
            return False
        if not self.open_end and instant >= self.end:
            return False
        return True

    @property
    def is_all_time(self) -> bool:
        return self.start is None

    def span_seconds(self) -> float | None:
        """The window length in seconds (``None`` for an unbounded start)."""
        if self.start is None:
            return None
        return max(0.0, (self.end - self.start).total_seconds())

    def iso_from(self) -> str | None:
        return self.start.isoformat() if self.start is not None else None

    def iso_to(self) -> str | None:
        return None if self.open_end else self.end.isoformat()


@dataclass(frozen=True)
class CalendarBucket:
    start: datetime  # aware, UTC
    end: datetime  # aware, UTC, exclusive
    label: str  # "Mar 2026", "W14 2026", "Q3 2026", "2026", "10 Oct 2026", "10 Oct 14:00"
    in_progress: bool  # the current, unfinished period
    # --- additive (WP-AGG) ---
    # The window covers only part of this calendar period (its first or last bucket).
    clipped: bool = False


# --------------------------------------------------------------------------- #
# Zones and small helpers
# --------------------------------------------------------------------------- #
_OFFSET_RE = re.compile(r"^([+-])(\d{2}):?(\d{2})$")


def zone_for(tz: Any) -> tuple[tzinfo, str]:
    """``(tzinfo, effective name)`` for an IANA name or a fixed ``±HH:MM`` offset.

    An empty or unknown zone falls back to UTC (and the returned name says so), so a
    mis-typed operator setting can never take an aggregate down."""
    name = str(tz or "").strip()
    if not name or name in _UTC_NAMES:
        return timezone.utc, "UTC"
    match = _OFFSET_RE.match(name)
    if match:
        sign = -1 if match.group(1) == "-" else 1
        delta = timedelta(hours=int(match.group(2)), minutes=int(match.group(3)))
        if delta == timedelta(0):
            return timezone.utc, "UTC"
        return timezone(sign * delta), name
    try:
        return ZoneInfo(name), name
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return timezone.utc, "UTC"


def _aware_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _local_midnight(day: date, zone: tzinfo) -> datetime:
    """The UTC instant of local midnight on ``day`` in ``zone``."""
    return datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(timezone.utc)


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def _shift_months(instant: datetime, months: int, zone: tzinfo) -> datetime:
    """``instant`` moved by ``months`` calendar months in local wall-clock time.

    The day is clamped to the target month's length (31 Mar − 1 month = 28/29 Feb), the
    same rule every calendar UI uses."""
    local = instant.astimezone(zone)
    year, month = _add_months(local.year, local.month, months)
    day = min(local.day, _days_in_month(year, month))
    shifted = datetime(year, month, day, local.hour, local.minute, local.second,
                       local.microsecond, tzinfo=zone)
    return shifted.astimezone(timezone.utc)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def _fmt_day(d: date, *, year: bool = True) -> str:
    return f"{d.day} {_MONTHS[d.month - 1]}" + (f" {d.year}" if year else "")


def _fmt_instant(instant: datetime, zone: tzinfo) -> str:
    local = instant.astimezone(zone)
    return f"{_fmt_day(local.date())} {local.hour:02d}:{local.minute:02d}"


def _with_zone(label: str, zone_name: str) -> str:
    return label if zone_name == "UTC" else f"{label} ({zone_name})"


# --------------------------------------------------------------------------- #
# Calendar periods
# --------------------------------------------------------------------------- #
def period_start(instant: datetime, unit: str, tz: Any = "UTC") -> datetime:
    """The UTC start of the calendar ``unit`` (hour..year) containing ``instant``,
    computed in ``tz``. ISO weeks start on Monday."""
    zone = tz if isinstance(tz, tzinfo) else zone_for(tz)[0]
    instant = _aware_utc(instant)
    local = instant.astimezone(zone)
    if unit == "hour":
        floored = local.replace(minute=0, second=0, microsecond=0)
        start = floored.astimezone(timezone.utc)
        # A DST transition that is not a whole hour (or a nonexistent local time) can
        # make the floored wall-clock land after the instant; step back one hour.
        while start > instant:
            start -= timedelta(hours=1)
        return start
    day = local.date()
    if unit == "day":
        first = day
    elif unit == "week":
        first = day - timedelta(days=day.weekday())
    elif unit == "month":
        first = day.replace(day=1)
    elif unit == "quarter":
        first = date(day.year, 3 * ((day.month - 1) // 3) + 1, 1)
    elif unit == "year":
        first = date(day.year, 1, 1)
    else:
        raise ValueError(f"Unknown bucket unit {unit!r}; use one of {', '.join(BUCKET_UNITS)}")
    start = _local_midnight(first, zone)
    if start > instant:  # nonexistent local midnight resolved past the instant
        start = _local_midnight(first - timedelta(days=1), zone)
    return start


def next_period_start(start: datetime, unit: str, tz: Any = "UTC") -> datetime:
    """The UTC start of the calendar period that follows the one starting at ``start``."""
    zone = tz if isinstance(tz, tzinfo) else zone_for(tz)[0]
    if unit == "hour":
        nxt = period_start(start + timedelta(hours=1), "hour", zone)
        return nxt if nxt > start else start + timedelta(hours=1)
    local = start.astimezone(zone).date()
    if unit == "day":
        nxt_day = local + timedelta(days=1)
    elif unit == "week":
        monday = local - timedelta(days=local.weekday())
        nxt_day = monday + timedelta(days=7)
    elif unit == "month":
        year, month = _add_months(local.year, local.month, 1)
        nxt_day = date(year, month, 1)
    elif unit == "quarter":
        q_first = 3 * ((local.month - 1) // 3) + 1
        year, month = _add_months(local.year, q_first, 3)
        nxt_day = date(year, month, 1)
    elif unit == "year":
        nxt_day = date(local.year + 1, 1, 1)
    else:
        raise ValueError(f"Unknown bucket unit {unit!r}; use one of {', '.join(BUCKET_UNITS)}")
    nxt = _local_midnight(nxt_day, zone)
    if nxt <= start:  # pathological zone data: never loop
        nxt = start + timedelta(hours=1)
    return nxt


def period_label(start: datetime, unit: str, tz: Any = "UTC") -> str:
    """The human label of the period starting at ``start`` ("Mar 2026", "W14 2026",
    "Q3 2026", "2026", "10 Oct 2026", "10 Oct 14:00")."""
    zone = tz if isinstance(tz, tzinfo) else zone_for(tz)[0]
    local = start.astimezone(zone)
    if unit == "hour":
        return f"{local.day} {_MONTHS[local.month - 1]} {local.hour:02d}:{local.minute:02d}"
    if unit == "day":
        return _fmt_day(local.date())
    if unit == "week":
        iso_year, iso_week, _ = local.date().isocalendar()
        return f"W{iso_week:02d} {iso_year}"
    if unit == "month":
        return f"{_MONTHS[local.month - 1]} {local.year}"
    if unit == "quarter":
        return f"Q{(local.month - 1) // 3 + 1} {local.year}"
    if unit == "year":
        return f"{local.year}"
    raise ValueError(f"Unknown bucket unit {unit!r}; use one of {', '.join(BUCKET_UNITS)}")


# --------------------------------------------------------------------------- #
# resolve_window
# --------------------------------------------------------------------------- #
_ALL_TOKENS = frozenset({"all", "lifetime", "all_time", "alltime", "all-time", "all time",
                         "*", "ever", "everything", "forever", "since_the_beginning"})
_UNIT_ALIASES = {
    "m": "m", "min": "m", "mins": "m", "minute": "m", "minutes": "m",
    "h": "h", "hr": "h", "hrs": "h", "hour": "h", "hours": "h",
    "d": "d", "day": "d", "days": "d",
    "w": "w", "wk": "w", "wks": "w", "week": "w", "weeks": "w",
    "mo": "M", "mon": "M", "mons": "M", "month": "M", "months": "M",
    "y": "y", "yr": "y", "yrs": "y", "year": "y", "years": "y",
}
_UNIT_WORDS = {"m": "minute", "h": "hour", "d": "day", "w": "week", "M": "month", "y": "year"}
_RELATIVE_RE = re.compile(r"^now\s*-\s*(\d{1,6})\s*([a-zA-Z]+)$")
_LOOSE_RELATIVE_RE = re.compile(
    r"^(?:(?:last|past|previous|trailing)[\s_-]*)?(\d{1,6})[\s_-]*([a-zA-Z]+)$",
    re.IGNORECASE,
)
_CALENDAR_ALIASES = {
    "today": "today", "yesterday": "yesterday",
    "this_week": "this_week", "current_week": "this_week", "week_to_date": "this_week",
    "wtd": "this_week",
    "last_week": "last_week", "previous_week": "last_week", "prior_week": "last_week",
    "this_month": "this_month", "current_month": "this_month", "month_to_date": "this_month",
    "mtd": "this_month",
    "last_month": "last_month", "previous_month": "last_month", "prior_month": "last_month",
    "this_quarter": "this_quarter", "current_quarter": "this_quarter",
    "quarter_to_date": "this_quarter", "qtd": "this_quarter",
    "last_quarter": "last_quarter", "previous_quarter": "last_quarter",
    "prior_quarter": "last_quarter",
    "ytd": "ytd", "year_to_date": "ytd",
    "this_year": "this_year", "current_year": "this_year",
    "last_year": "last_year", "previous_year": "last_year", "prior_year": "last_year",
}
_YEAR_RE = re.compile(r"^(\d{4})$")
_MONTH_RE = re.compile(r"^(\d{4})-(\d{1,2})$")
_QUARTER_RE = re.compile(r"^(?:(\d{4})[\s_-]?q([1-4])|q([1-4])[\s_-]?(\d{4}))$", re.IGNORECASE)
_WEEK_RE = re.compile(r"^(\d{4})-?w(\d{1,2})$", re.IGNORECASE)
_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_EPOCH_RE = re.compile(r"^-?\d{10,16}$")
_RANGE_KEYS = (("from", "to"), ("start", "end"), ("time_from", "time_to"), ("gte", "lte"),
               ("since", "until"))


@dataclass(frozen=True)
class _Span:
    """An intermediate resolution: ``[start, end)`` plus how to describe it."""

    start: datetime | None
    end: datetime
    label: str  # without the zone suffix
    token: str
    kind: str
    zone_dependent: bool
    open_end: bool = False
    # For range composition: was this bound a whole local day/period boundary?
    date_aligned: bool = False


def resolve_window(
    spec: str | dict[str, Any] | None,
    *,
    tz: str = "UTC",
    now: datetime | None = None,
    default: str = "all",
) -> ResolvedWindow:
    """Resolve ``spec`` (see the module docstring) into a :class:`ResolvedWindow`.

    Raises :class:`ValueError` for an unrecognised spec, an empty range (``from`` at or
    after ``to``) or a range that ends before it starts."""
    zone, zone_name = zone_for(tz)
    now_utc = _aware_utc(now) if now is not None else datetime.now(timezone.utc)
    if _is_blank(spec):
        spec = default
        if _is_blank(spec):
            spec = "all"
    try:
        span = _resolve_spec(spec, zone, now_utc)
    except (OverflowError, OSError) as exc:
        # A relative span or an epoch bound so large that the calendar cannot represent
        # it. Rejected VISIBLY (the documented contract is ValueError), never a 500.
        raise ValueError(
            f"The time window {spec!r} reaches outside the supported dates "
            f"(years 1970-9998): {exc}"
        ) from None
    label = _with_zone(span.label, zone_name) if span.zone_dependent else span.label
    return ResolvedWindow(
        start=span.start,
        end=span.end,
        label=label,
        tz=zone_name,
        token=span.token,
        now=now_utc,
        open_end=span.open_end,
        kind=span.kind,
    )


def all_time_label(earliest: datetime | None, tz: str = "UTC") -> str:
    """"all time (since 3 Nov 2025)" once the earliest record is known."""
    if earliest is None:
        return "all time"
    zone, zone_name = zone_for(tz)
    label = f"all time (since {_fmt_day(_aware_utc(earliest).astimezone(zone).date())})"
    return _with_zone(label, zone_name)


def _is_blank(spec: Any) -> bool:
    if spec is None:
        return True
    if isinstance(spec, str) and not spec.strip():
        return True
    if isinstance(spec, dict) and not any(not _is_blank(v) for v in spec.values()):
        return True
    return False


def _resolve_spec(spec: Any, zone: tzinfo, now: datetime) -> _Span:
    if isinstance(spec, bool):
        raise ValueError(f"Unrecognised time window {spec!r}; use {ACCEPTED_FORMS}")
    if isinstance(spec, (int, float)):
        if spec != spec:  # NaN
            raise ValueError(f"Unrecognised time window {spec!r}; use {ACCEPTED_FORMS}")
        if spec == 0:
            # The documented legacy ``window_hours=0`` alias: no window.
            return _all_span(now)
        if spec < 0:
            raise ValueError(
                f"A time window cannot be negative ({spec!r} hours); use a positive number "
                "of hours, or 0 for all time"
            )
        if isinstance(spec, float) and not spec.is_integer():
            minutes = int(round(spec * 60))
            if minutes < 1:
                raise ValueError(f"The time window {spec!r} hours is shorter than a minute")
            return _relative_span(minutes, "m", zone, now)
        hours = int(spec)
        if hours % 24 == 0:  # the legacy window_hours alias: 720 → "last 30 days"
            return _relative_span(hours // 24, "d", zone, now)
        return _relative_span(hours, "h", zone, now)
    if isinstance(spec, dict):
        return _range_from_dict(spec, zone, now)
    if not isinstance(spec, str):
        raise ValueError(f"Unrecognised time window {spec!r}; use {ACCEPTED_FORMS}")
    raw = spec.strip()
    low = raw.lower()
    if low in _ALL_TOKENS:
        return _all_span(now)
    for sep in ("..", "/"):
        if sep in raw:
            left, _, right = raw.partition(sep)
            return _compose_range(left.strip() or None, right.strip() or None, zone, now)
    single = _single_span(raw, zone, now)
    if single is not None:
        return single
    # A bare absolute instant means "since then".
    instant = _parse_instant(raw, zone)
    if instant is not None:
        return _compose_range(raw, None, zone, now)
    raise ValueError(f"Unrecognised time window {spec!r}; use {ACCEPTED_FORMS}")


def _all_span(now: datetime) -> _Span:
    return _Span(start=None, end=now, label="all time", token="all", kind="all",
                 zone_dependent=False, open_end=True)


def _single_span(raw: str, zone: tzinfo, now: datetime) -> _Span | None:
    """A non-range spec: relative, calendar token or period literal (else None)."""
    rel = _parse_relative(raw)
    if rel is not None:
        amount, unit = rel
        if amount <= 0:
            # "now-0d" / "last 0 days" covers no time at all. It is rejected like the
            # equivalent empty range, never silently widened to all time.
            raise ValueError(
                f"The time window {raw!r} is empty: it covers no time; use a positive "
                "amount, or 'all' for all time"
            )
        return _relative_span(amount, unit, zone, now)
    key = re.sub(r"[\s-]+", "_", raw.strip().lower())
    token = _CALENDAR_ALIASES.get(key)
    if token is not None:
        return _calendar_span(token, zone, now)
    return _period_literal(raw.strip(), zone, now)


def _parse_relative(raw: str) -> tuple[int, str] | None:
    """``(amount, unit)`` for "now-90d" and its lenient spellings, else None.

    Case matters for one letter only, exactly as in Elasticsearch date math: ``m`` is
    minutes and ``M`` months. Every word form ("months", "mins") is unambiguous."""
    text = raw.strip()
    match = _RELATIVE_RE.match(text) or _LOOSE_RELATIVE_RE.match(text)
    if match is None:
        return None
    amount, unit_raw = int(match.group(1)), match.group(2)
    if unit_raw == "M":
        return amount, "M"
    unit = _UNIT_ALIASES.get(unit_raw.lower())
    if unit is None:
        return None
    return amount, unit


def _relative_span(amount: int, unit: str, zone: tzinfo, now: datetime) -> _Span:
    """``[now - amount·unit, now)``. Minutes to weeks are exact durations; months and
    years are calendar arithmetic in ``zone`` (so "now-6M" is six calendar months).
    The label names no date, so it carries no zone suffix."""
    try:
        if unit in ("M", "y"):
            start = _shift_months(now, -amount * (12 if unit == "y" else 1), zone)
        else:
            seconds = {"m": 60, "h": 3600, "d": 86_400, "w": 604_800}[unit]
            start = now - timedelta(seconds=seconds * amount)
    except (OverflowError, OSError, ValueError):
        raise ValueError(
            f"The time window 'now-{amount}{unit}' reaches before the earliest supported "
            "date; use 'all' for all time"
        ) from None
    word = _UNIT_WORDS[unit]
    label = f"last {amount} {word}{'s' if amount != 1 else ''}"
    return _Span(start=start, end=now, label=label, token=f"now-{amount}{unit}",
                 kind="relative", zone_dependent=False)


def _calendar_span(token: str, zone: tzinfo, now: datetime) -> _Span:
    local_today = now.astimezone(zone).date()
    if token in ("today", "yesterday"):
        day = local_today if token == "today" else local_today - timedelta(days=1)
        start = _local_midnight(day, zone)
        end = now if token == "today" else _local_midnight(local_today, zone)
        return _Span(start, end, token, token, "calendar", True, date_aligned=True)
    if token in ("this_week", "last_week"):
        monday = local_today - timedelta(days=local_today.weekday())
        if token == "this_week":
            return _Span(_local_midnight(monday, zone), now, "this week", token,
                         "calendar", True, date_aligned=True)
        prev = monday - timedelta(days=7)
        return _Span(_local_midnight(prev, zone), _local_midnight(monday, zone),
                     "last week", token, "calendar", True, date_aligned=True)
    if token in ("this_month", "last_month"):
        first = local_today.replace(day=1)
        if token == "this_month":
            return _Span(_local_midnight(first, zone), now,
                         f"{_MONTHS_LONG[first.month - 1]} {first.year}", token,
                         "calendar", True, date_aligned=True)
        year, month = _add_months(first.year, first.month, -1)
        prev = date(year, month, 1)
        return _Span(_local_midnight(prev, zone), _local_midnight(first, zone),
                     f"{_MONTHS_LONG[prev.month - 1]} {prev.year}", token, "calendar", True,
                     date_aligned=True)
    if token in ("this_quarter", "last_quarter"):
        q_month = 3 * ((local_today.month - 1) // 3) + 1
        first = date(local_today.year, q_month, 1)
        if token == "this_quarter":
            return _Span(_local_midnight(first, zone), now,
                         f"Q{(q_month - 1) // 3 + 1} {first.year}", token, "calendar", True,
                         date_aligned=True)
        year, month = _add_months(first.year, first.month, -3)
        prev = date(year, month, 1)
        return _Span(_local_midnight(prev, zone), _local_midnight(first, zone),
                     f"Q{(month - 1) // 3 + 1} {year}", token, "calendar", True,
                     date_aligned=True)
    if token in ("ytd", "this_year"):
        first = date(local_today.year, 1, 1)
        label = f"{first.year} to date" if token == "ytd" else f"{first.year}"
        return _Span(_local_midnight(first, zone), now, label, token, "calendar", True,
                     date_aligned=True)
    if token == "last_year":
        first = date(local_today.year - 1, 1, 1)
        end = _local_midnight(date(local_today.year, 1, 1), zone)
        return _Span(_local_midnight(first, zone), end, f"{first.year}", token,
                     "calendar", True, date_aligned=True)
    raise ValueError(f"Unrecognised time window {token!r}; use {ACCEPTED_FORMS}")


def _period_literal(raw: str, zone: tzinfo, now: datetime) -> _Span | None:
    """``2026`` / ``2026-09`` / ``2026-Q3`` / ``2026-W14`` / ``2026-09-14`` (else None)."""
    del now
    if (m := _YEAR_RE.match(raw)) is not None:
        year = int(m.group(1))
        _check_year(year)
        start = _local_midnight(date(year, 1, 1), zone)
        end = _local_midnight(date(year + 1, 1, 1), zone)
        return _Span(start, end, f"{year}", f"{year:04d}", "period", True, date_aligned=True)
    if (m := _MONTH_RE.match(raw)) is not None:
        year, month = int(m.group(1)), int(m.group(2))
        _check_year(year)
        if not 1 <= month <= 12:
            raise ValueError(f"Unrecognised month {raw!r}; months run 01-12")
        ny, nm = _add_months(year, month, 1)
        return _Span(_local_midnight(date(year, month, 1), zone),
                     _local_midnight(date(ny, nm, 1), zone),
                     f"{_MONTHS_LONG[month - 1]} {year}", f"{year:04d}-{month:02d}",
                     "period", True, date_aligned=True)
    if (m := _QUARTER_RE.match(raw)) is not None:
        year = int(m.group(1) or m.group(4))
        quarter = int(m.group(2) or m.group(3))
        _check_year(year)
        first = date(year, 3 * (quarter - 1) + 1, 1)
        ny, nm = _add_months(year, first.month, 3)
        return _Span(_local_midnight(first, zone), _local_midnight(date(ny, nm, 1), zone),
                     f"Q{quarter} {year}", f"{year:04d}-Q{quarter}", "period", True,
                     date_aligned=True)
    if (m := _WEEK_RE.match(raw)) is not None:
        year, week = int(m.group(1)), int(m.group(2))
        _check_year(year)
        try:
            monday = date.fromisocalendar(year, week, 1)
        except ValueError as exc:
            raise ValueError(f"Unrecognised ISO week {raw!r}: {exc}") from None
        return _Span(_local_midnight(monday, zone),
                     _local_midnight(monday + timedelta(days=7), zone),
                     f"W{week:02d} {year}", f"{year:04d}-W{week:02d}", "period", True,
                     date_aligned=True)
    if (m := _DATE_RE.match(raw)) is not None:
        try:
            day = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError as exc:
            raise ValueError(f"Unrecognised date {raw!r}: {exc}") from None
        _check_year(day.year)
        return _Span(_local_midnight(day, zone),
                     _local_midnight(day + timedelta(days=1), zone),
                     _fmt_day(day), day.isoformat(), "period", True, date_aligned=True)
    return None


def _check_year(year: int) -> None:
    if not 1970 <= year <= 9998:
        raise ValueError(f"Year {year} is outside the supported range 1970-9998")


def _parse_instant(raw: str, zone: tzinfo) -> datetime | None:
    """An absolute instant: ISO timestamp (naive = ``zone``) or epoch millis/seconds."""
    text = raw.strip()
    if not text:
        return None
    if _EPOCH_RE.match(text):
        value = int(text)
        seconds = value / 1000.0 if abs(value) > 10**11 else float(value)
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    candidate = re.sub(r"[zZ]$", "+00:00", text.replace(" ", "T", 1) if "T" not in text else text)
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    return parsed.astimezone(timezone.utc)


def _bound(value: Any, side: str, zone: tzinfo, now: datetime) -> tuple[datetime | None, _Span | None, str]:
    """Resolve one range bound → ``(instant, span used, token)``.

    ``side`` is ``from`` (a period contributes its start) or ``to`` (its end). An ISO
    date ``to`` is INCLUSIVE (the window runs to the end of that day)."""
    if _is_blank(value):
        return None, None, ""
    if isinstance(value, bool):
        raise ValueError(f"Unrecognised {side} bound {value!r}; use {ACCEPTED_FORMS}")
    if isinstance(value, datetime):
        instant = value if value.tzinfo else value.replace(tzinfo=zone)
        instant = instant.astimezone(timezone.utc)
        return instant, None, instant.isoformat()
    if isinstance(value, (int, float)):
        seconds = value / 1000.0 if abs(value) > 10**11 else float(value)
        instant = datetime.fromtimestamp(seconds, tz=timezone.utc)
        return instant, None, instant.isoformat()
    text = str(value).strip()
    if text.lower() == "now":
        return now, None, "now"
    rel = _parse_relative(text)
    if rel is not None:
        span = _relative_span(rel[0], rel[1], zone, now)
        return span.start, None, span.token
    key = re.sub(r"[\s-]+", "_", text.lower())
    if key in _ALL_TOKENS:
        if side == "from":
            return None, None, "all"
        return now, None, "now"
    token = _CALENDAR_ALIASES.get(key)
    if token is not None:
        span = _calendar_span(token, zone, now)
        return (span.start if side == "from" else span.end), span, span.token
    period = _period_literal(text, zone, now)
    if period is not None:
        return (period.start if side == "from" else period.end), period, period.token
    instant = _parse_instant(text, zone)
    if instant is not None:
        return instant, None, instant.isoformat()
    raise ValueError(f"Unrecognised {side} bound {value!r}; use {ACCEPTED_FORMS}")


def _range_from_dict(spec: dict[str, Any], zone: tzinfo, now: datetime) -> _Span:
    lowered = {str(k).strip().lower(): v for k, v in spec.items()}
    for lo_key, hi_key in _RANGE_KEYS:
        if lo_key in lowered or hi_key in lowered:
            unknown = set(lowered) - {lo_key, hi_key}
            if unknown:
                raise ValueError(
                    f"Unrecognised time window keys {sorted(unknown)}; a range takes "
                    f"'{lo_key}' and '{hi_key}'"
                )
            return _compose_range(lowered.get(lo_key), lowered.get(hi_key), zone, now)
    if "window" in lowered and len(lowered) == 1:
        return _resolve_spec(lowered["window"], zone, now)
    raise ValueError(
        f"Unrecognised time window keys {sorted(lowered)}; a range takes 'from' and 'to'"
    )


def _compose_range(lo: Any, hi: Any, zone: tzinfo, now: datetime) -> _Span:
    # ``{"from": "now-7d", "to": "now"}`` (what the scope chip sends) IS "now-7d": the
    # same window, the same token and the same "last 7 days" label.
    hi_now = _is_blank(hi) or (isinstance(hi, str) and hi.strip().lower() == "now")
    if hi_now and isinstance(lo, str):
        relative = _parse_relative(lo)
        if relative is not None and relative[0] > 0:
            return _relative_span(relative[0], relative[1], zone, now)
    start, lo_span, lo_token = _bound(lo, "from", zone, now)
    end, hi_span, hi_token = _bound(hi, "to", zone, now)
    open_to_now = end is None
    if end is None:
        end = now
    if start is not None and start >= end:
        raise ValueError(
            "The time window is empty: its start is not before its end "
            f"({start.isoformat()} >= {end.isoformat()})"
        )
    token = f"{lo_token or 'all'}..{hi_token or 'now'}"
    label = _range_label(start, end, lo, hi, lo_span, hi_span, zone, now, open_to_now)
    return _Span(start=start, end=end, label=label, token=token, kind="range",
                 zone_dependent=True)


def _is_date_only(value: Any) -> bool:
    return isinstance(value, str) and _DATE_RE.match(value.strip()) is not None


def _range_label(
    start: datetime | None, end: datetime, lo: Any, hi: Any,
    lo_span: _Span | None, hi_span: _Span | None, zone: tzinfo, now: datetime,
    open_to_now: bool,
) -> str:
    """"1 Mar – 10 Oct 2026"; "since 1 Mar 2026"; "until 10 Oct 2026"."""
    hi_is_now = open_to_now or (isinstance(hi, str) and hi.strip().lower() == "now")
    start_aligned = start is not None and (
        _is_date_only(lo) or (lo_span is not None and lo_span.date_aligned)
        or _is_midnight(start, zone)
    )
    end_aligned = not hi_is_now and (
        _is_date_only(hi) or (hi_span is not None and hi_span.date_aligned)
        or _is_midnight(end, zone)
    )
    if start is None:
        if hi_is_now:
            return "all time"
        if end_aligned:
            last_day = (end.astimezone(zone) - timedelta(microseconds=1)).date()
            return f"until {_fmt_day(last_day)}"
        return f"until {_fmt_instant(end, zone)}"
    if hi_is_now:
        if start_aligned:
            return f"since {_fmt_day(start.astimezone(zone).date())}"
        return f"since {_fmt_instant(start, zone)}"
    if start_aligned and end_aligned:
        first = start.astimezone(zone).date()
        last = (end.astimezone(zone) - timedelta(microseconds=1)).date()
        if first == last:
            return _fmt_day(first)
        if first.year == last.year:
            return f"{_fmt_day(first, year=False)} – {_fmt_day(last)}"
        return f"{_fmt_day(first)} – {_fmt_day(last)}"
    return f"{_fmt_instant(start, zone)} – {_fmt_instant(end, zone)}"


def _is_midnight(instant: datetime, zone: tzinfo) -> bool:
    local = instant.astimezone(zone)
    return (local.hour, local.minute, local.second, local.microsecond) == (0, 0, 0, 0)


# --------------------------------------------------------------------------- #
# Buckets
# --------------------------------------------------------------------------- #
def _bucket_range(
    window: ResolvedWindow, earliest: datetime | None, latest: datetime | None,
) -> tuple[datetime, datetime, bool] | None:
    """``(lo, hi, hi_inclusive)`` the buckets must cover, or None when nothing does."""
    lo = window.start if window.start is not None else (
        _aware_utc(earliest) if earliest is not None else None
    )
    if lo is None:
        return None
    hi = window.end
    inclusive = False
    if window.open_end and latest is not None and _aware_utc(latest) >= hi:
        hi = _aware_utc(latest)
        inclusive = True
    if hi < lo:
        return None
    return lo, hi, inclusive


def calendar_buckets(
    window: ResolvedWindow,
    unit: BucketUnit,
    *,
    earliest: datetime | None = None,
    latest: datetime | None = None,
) -> list[CalendarBucket]:
    """Zero-filled buckets covering ``window`` (for an all-time window, from ``earliest``).

    Buckets are whole calendar periods in ``window.tz`` (ISO weeks start on Monday);
    the first and last may be only partly inside the window (``clipped``). The bucket
    holding ``window.now`` is ``in_progress``. ``latest`` extends an open-ended (all
    time) window to cover a record stamped after ``now``. Every instant inside the
    window falls in exactly one bucket, so per-bucket counts sum to the window total."""
    if unit not in BUCKET_UNITS:
        raise ValueError(f"Unknown bucket unit {unit!r}; use one of {', '.join(BUCKET_UNITS)}")
    bounds = _bucket_range(window, earliest, latest)
    if bounds is None:
        return []
    lo, hi, inclusive = bounds
    zone, _ = zone_for(window.tz)
    now = window.now
    out: list[CalendarBucket] = []
    start = period_start(lo, unit, zone)
    previous_label = ""
    while start < hi or (inclusive and start <= hi):
        end = next_period_start(start, unit, zone)
        label = period_label(start, unit, zone)
        if label == previous_label:  # a repeated wall-clock hour (DST fall-back)
            label = f"{label} {start.astimezone(zone).tzname() or ''}".rstrip()
        previous_label = label
        in_progress = bool(now is not None and start <= now < end)
        # Only a real window bound clips a bucket: an all-time window has no lower
        # bound (its first bucket merely starts before the oldest record), and a
        # bucket that runs past ``now`` is in progress, not clipped.
        clipped = (window.start is not None and start < window.start) or (
            not window.open_end and end > window.end and not in_progress
        )
        out.append(CalendarBucket(start=start, end=end, label=label,
                                  in_progress=in_progress, clipped=bool(clipped)))
        if len(out) > MAX_GENERATED_BUCKETS:
            raise ValueError(
                f"Too many {unit} buckets for {window.label}; choose a larger unit"
            )
        start = end
    return out


_UNIT_SECONDS = {"hour": 3600, "day": 86_400, "week": 604_800, "month": 2_629_746,
                 "quarter": 7_889_238, "year": 31_556_952}


def shift_period_start(start: datetime, unit: str, periods: int, tz: Any = "UTC") -> datetime:
    """The start of the calendar ``unit`` period ``periods`` periods away from the one
    starting at ``start`` (negative = earlier), in ``tz``. DST-safe: whole local days,
    weeks, months, quarters and years; hours step through :func:`next_period_start`."""
    zone = tz if isinstance(tz, tzinfo) else zone_for(tz)[0]
    current = period_start(start, unit, zone)
    if periods == 0:
        return current
    if unit == "hour":
        step = 1 if periods > 0 else -1
        for _ in range(abs(periods)):
            if step > 0:
                current = next_period_start(current, "hour", zone)
            else:
                current = period_start(current - timedelta(hours=1), "hour", zone)
        return current
    local = current.astimezone(zone).date()
    if unit == "day":
        target = local + timedelta(days=periods)
    elif unit == "week":
        target = local + timedelta(days=7 * periods)
    elif unit in ("month", "quarter", "year"):
        months = periods * {"month": 1, "quarter": 3, "year": 12}[unit]
        year, month = _add_months(local.year, local.month, months)
        target = date(year, month, 1)
    else:
        raise ValueError(f"Unknown bucket unit {unit!r}; use one of {', '.join(BUCKET_UNITS)}")
    return period_start(_local_midnight(target, zone), unit, zone)


_TOKEN_RE = re.compile(r"^now-(\d+)(m|h|d|w|M|y)$")


def whole_period_unit(window: ResolvedWindow) -> str | None:
    """The calendar unit EVERY lookup of a relative window starts on, from the window
    alone (never from how one lookup breaks it down): ``"day"`` for a span of whole
    days or weeks of two days or more ("last 90 days" counts today and the 89 days
    before it), ``"month"`` for a span of months or years of two months or more ("last
    6 months" counts this month and the five before it). ``None`` for a window of hours
    or minutes, a single day or month, and every calendar period, range and all time:
    those are counted exactly as resolved (Round 12 SPEC §7.2 decision 28)."""
    if window.kind != "relative" or window.start is None:
        return None
    match = _TOKEN_RE.match(window.token or "")
    if match is None:
        return None
    amount, wunit = int(match.group(1)), match.group(2)
    if wunit in ("d", "w"):
        return "day" if amount * (7 if wunit == "w" else 1) >= 2 else None
    if wunit in ("M", "y"):
        return "month" if amount * (12 if wunit == "y" else 1) >= 2 else None
    return None


def whole_period_count(window: ResolvedWindow) -> int | None:
    """How many whole periods of :func:`whole_period_unit` a relative window counts
    ("last 90 days" is 90 days, "last 4 weeks" 28 days, "last 2 years" 24 months), from
    the window alone; ``None`` when it is not counted in whole periods. The previous
    period of such a window is that many periods just before its start."""
    unit = whole_period_unit(window)
    match = _TOKEN_RE.match(window.token or "")
    if unit is None or match is None:
        return None
    amount, wunit = int(match.group(1)), match.group(2)
    return amount * {"d": 1, "w": 7, "M": 1, "y": 12}[wunit]


def align_whole_periods(window: ResolvedWindow) -> ResolvedWindow:
    """A relative window as N whole periods of its own unit, the last in progress
    (:func:`whole_period_unit`): "last 90 days" is "last 90 days (since 15 Jul 2026)",
    today and the 89 days before it from local midnight; "last 12 months" is "last 12
    months (since Nov 2025)", eleven whole months and the current one.

    The start depends on the window alone, so every lookup of one window in an answer
    (a headline count, a breakdown by severity, a series by day, week or month, the
    posture tiles, the noise funnel, AI cost) counts the same span and states the same
    start; a breakdown by a unit the start is not a boundary of begins with the part of
    its first period inside the window ("Jul 2026 (from 15 Jul)"). Hours, a single day
    or month, minutes, calendar periods, ranges and all time come back as they are. The
    result is idempotent (an aligned window is returned unchanged)."""
    if window.kind != "relative" or window.aligned_to or window.start is None:
        return window
    unit = whole_period_unit(window)
    periods = whole_period_count(window)
    if unit is None or periods is None:
        return window
    zone, zone_name = zone_for(window.tz)
    anchor = window.now if window.now is not None else window.end
    try:
        start = shift_period_start(anchor, unit, -(periods - 1), zone)
    except (OverflowError, OSError, ValueError):
        return window
    if start >= window.end:
        return window
    local = start.astimezone(zone)
    since = _fmt_day(local.date()) if unit == "day" else period_label(start, unit, zone)
    suffix = since if zone_name == "UTC" else f"{since}, {zone_name}"
    label = f"{window.label} (since {suffix})"
    return ResolvedWindow(
        start=start, end=window.end, label=label, tz=window.tz, token=window.token,
        now=window.now, open_end=window.open_end, kind=window.kind, aligned_to=unit,
    )


def align_window(window: ResolvedWindow, unit: str | None) -> ResolvedWindow:
    """A relative window broken down by calendar ``unit``, as whole periods.

    "Cases by month for the last 12 months" means twelve monthly bars: eleven complete
    months and the current one (in progress). The exact relative window (``now-12M`` =
    10 Oct 2025 14:23 → now) would instead start inside a month and draw THIRTEEN bars,
    the first a partial month that reads as a drop in volume. The start is the one
    :func:`align_whole_periods` gives the window whatever ``unit`` it is broken down by,
    so every breakdown of one window, and every lookup of it with none, starts at the
    same instant (Round 12 SPEC §7.2 decision 28): "last 90 days" by month is "last 90
    days (since 15 Jul 2026)" with a first bucket "Jul 2026 (from 15 Jul)", exactly the
    start its day breakdown and its severity breakdown have. ``unit=None`` (no
    breakdown) returns the window as is; callers that count an unbucketed lookup align it
    with :func:`align_whole_periods` themselves."""
    if not unit:
        return window
    return align_whole_periods(window)


def bucket_count(
    window: ResolvedWindow, unit: BucketUnit, *,
    earliest: datetime | None = None, latest: datetime | None = None,
) -> int:
    """How many ``unit`` buckets :func:`calendar_buckets` would return (computed
    without materialising an absurd list for a tiny unit over a long window)."""
    bounds = _bucket_range(window, earliest, latest)
    if bounds is None:
        return 0
    lo, hi, _inclusive = bounds
    approx = (hi - lo).total_seconds() / _UNIT_SECONDS[unit]
    if approx > MAX_GENERATED_BUCKETS / 2:
        return int(approx) + 2
    return len(calendar_buckets(window, unit, earliest=earliest, latest=latest))


def auto_bucket(
    window: ResolvedWindow,
    *,
    earliest: datetime | None = None,
    max_points: int = MAX_POINTS,
    latest: datetime | None = None,
) -> BucketUnit:
    """The smallest calendar unit that keeps the window at or under ``max_points`` buckets.

    An all-time window with no ``earliest`` hint has no known span; it gets ``month``
    (pass the oldest record's instant for an exact choice)."""
    max_points = max(1, int(max_points))
    for unit in BUCKET_UNITS:
        bounds = _bucket_range(window, earliest, latest)
        if bounds is None:
            return "month"
        approx = (bounds[1] - bounds[0]).total_seconds() / _UNIT_SECONDS[unit]
        if approx > max_points * 1.2 + 2:
            continue
        if bucket_count(window, unit, earliest=earliest, latest=latest) <= max_points:
            return unit  # type: ignore[return-value]
    return "year"


__all__ = [
    "ACCEPTED_FORMS",
    "BUCKET_UNITS",
    "BucketUnit",
    "CalendarBucket",
    "MAX_POINTS",
    "ResolvedWindow",
    "align_whole_periods",
    "align_window",
    "all_time_label",
    "auto_bucket",
    "bucket_count",
    "calendar_buckets",
    "next_period_start",
    "period_label",
    "period_start",
    "resolve_window",
    "shift_period_start",
    "whole_period_count",
    "whole_period_unit",
    "zone_for",
]
