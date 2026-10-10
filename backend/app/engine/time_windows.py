"""Time windows and calendar buckets for exact aggregates (Round 12 SPEC §3.5, D7).

INTERFACE STUB written by the orchestrator so WP-AGG (owner) and WP-TOOLS can build in
parallel. WP-AGG replaces the ``NotImplementedError`` bodies; the names, parameters and
dataclass fields are the binding contract (docs/research/2026-10-round12/SPEC.md §3.5).

Accepted window specs (``resolve_window``):

* ``None`` / ``"all"`` / ``"lifetime"`` / ``"all_time"`` — all time (``start=None``);
* ``"now-N[h|d|w|M|y]"`` — relative to ``now``;
* calendar tokens: ``today``, ``yesterday``, ``this_week``, ``last_week``, ``this_month``,
  ``last_month``, ``this_quarter``, ``last_quarter``, ``ytd``, ``this_year``, ``last_year``,
  resolved in ``tz`` (ISO weeks start on Monday);
* ``{"from": ..., "to": ...}`` with ISO timestamps or the forms above for each bound.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

BucketUnit = Literal["hour", "day", "week", "month", "quarter", "year"]
BUCKET_UNITS: tuple[str, ...] = ("hour", "day", "week", "month", "quarter", "year")
MAX_POINTS = 200


@dataclass(frozen=True)
class ResolvedWindow:
    start: datetime | None  # None = all time
    end: datetime  # timezone-aware UTC
    label: str  # "all time (since 3 Nov 2025)", "Q3 2026", "last 90 days"
    tz: str  # IANA name used for calendar math
    token: str  # the normalised input ("all", "now-90d", "last_month", "2026-03-01..2026-10-10")


@dataclass(frozen=True)
class CalendarBucket:
    start: datetime  # aware, UTC
    end: datetime  # aware, UTC, exclusive
    label: str  # "Mar 2026", "W14 2026", "Q3 2026", "2026", "10 Oct 2026", "10 Oct 14:00"
    in_progress: bool  # the current, unfinished period


def resolve_window(
    spec: str | dict[str, Any] | None,
    *,
    tz: str = "UTC",
    now: datetime | None = None,
    default: str = "all",
) -> ResolvedWindow:
    raise NotImplementedError("WP-AGG implements resolve_window")


def calendar_buckets(window: ResolvedWindow, unit: BucketUnit, *, earliest: datetime | None = None) -> list[CalendarBucket]:
    """Zero-filled buckets covering ``window`` (for an all-time window, from ``earliest``)."""
    raise NotImplementedError("WP-AGG implements calendar_buckets")


def auto_bucket(window: ResolvedWindow, *, earliest: datetime | None = None, max_points: int = MAX_POINTS) -> BucketUnit:
    """The smallest calendar unit that keeps the window at or under ``max_points`` buckets."""
    raise NotImplementedError("WP-AGG implements auto_bucket")
