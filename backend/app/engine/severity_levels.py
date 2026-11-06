"""Named severity levels: the one ladder and the per-source projection.

Round 14 (SPEC §4.6.1, §4.7.2). Every severity filter and every severity breakdown in
the Console speaks five named levels, in one fixed order: Critical, High, Medium, Low
and Info. A raw source severity reaches a level in two steps, never one:

1. **Per-source projection.** The raw value is projected onto the canonical 0 to 100
   magnitude through **its own source's** declared ceiling
   (``SourceInstance.severity_scale_max``, resolved by
   :func:`app.engine.priority.severity_scale_max_for_source`) with the one formula
   :func:`app.ocsf.model.project_severity_magnitude`. A Wazuh rule level on 0 to 15 and
   a QRadar magnitude on 0 to 10 therefore land in the same levels as a 0 to 100 score.
2. **The ladder.** The magnitude is cut at 74, 48, 22 and 8, exactly the advisory band
   ladder of :mod:`app.engine.priority` (``_severity_band_from_magnitude``), the queue's
   ``_queue_score_band`` and the web ``badges.severityBandFromNumber``. The cut points are
   imported from :mod:`app.engine.priority`, never restated.

Native filters cannot project, so a level is also expressed as a **raw range** for one
source: :func:`raw_range` turns "exactly High" or "High or above" into ``gte`` and ``lt``
bounds on that source's raw values (plus "a missing value counts as Info", because a
missing severity reads as ``0.0``). The bounds are computed so that, for every finite
raw value, ``raw_range(...).matches(raw)`` and :func:`level_of_raw` agree to the last
bit: the projection is monotone, so the set of raw values reaching a cut is an up-set,
and :func:`raw_floor` finds its smallest member by stepping between adjacent floats.

:class:`SeverityTally` folds counted observations (a raw value, its source's ceiling, a
rule, a source, a time bucket) into the five levels, zeros included. The rule summary's
series and the chat severity breakdown both read it, so a rule's count in one never
disagrees with the other over the same observations.

Read-only and advisory: nothing here ever feeds ``case_manager.decide()`` (#3). Raw
values, rule values and source names are untrusted data (#9) and are returned as plain
values only.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable

from ..constants import DEFAULT_SEVERITY_SCALE_MAX
from ..ocsf.model import project_severity_magnitude, resolve_severity_scale_max
from ..utils import coerce_float
from .priority import (
    _BAND_CRIT_CUT,
    _BAND_HIGH_CUT,
    _BAND_INFO_CUT,
    _BAND_MED_CUT,
    severity_scale_max_for_source,
)

__all__ = [
    "LEVELS_ASCENDING",
    "LEVELS_DESCENDING",
    "LEVEL_FLOORS",
    "LEVEL_LABELS",
    "LevelSummary",
    "RawSeverityRange",
    "SeverityTally",
    "is_level",
    "level_at_least",
    "level_ranges",
    "level_label",
    "level_of_magnitude",
    "level_of_raw",
    "normalise_level",
    "raw_floor",
    "raw_range",
    "raw_severity",
    "scale_max_for_source",
    "source_scale_max",
]

#: The fixed display order of every breakdown (all five, zeros included).
LEVELS_DESCENDING: tuple[str, ...] = ("critical", "high", "medium", "low", "info")
LEVELS_ASCENDING: tuple[str, ...] = tuple(reversed(LEVELS_DESCENDING))
#: Plain names for a Console-authored label (sentence case).
LEVEL_LABELS: dict[str, str] = {
    "critical": "Critical", "high": "High", "medium": "Medium", "low": "Low", "info": "Info",
}
#: The 0 to 100 magnitude at which each level starts (``None``: Info has no floor).
LEVEL_FLOORS: dict[str, float | None] = {
    "critical": _BAND_CRIT_CUT,
    "high": _BAND_HIGH_CUT,
    "medium": _BAND_MED_CUT,
    "low": _BAND_INFO_CUT,
    "info": None,
}
# How far :func:`raw_floor` may step between adjacent floats. Rounding moves the cut
# by a handful of ulps at most; the bound only stops a pathological input from looping.
_FLOOR_STEPS = 64
# The most distinct raw values a level keeps for its help tip (SPEC §4.7.2).
_RAW_VALUES_PER_LEVEL = 5


# --------------------------------------------------------------------------- #
# Names
# --------------------------------------------------------------------------- #
def normalise_level(value: Any) -> str | None:
    """``"High"`` → ``"high"``; anything that is not one of the five levels → ``None``."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    return text if text in LEVEL_FLOORS else None


def is_level(value: Any) -> bool:
    return normalise_level(value) is not None


def level_label(level: str) -> str:
    """The plain name of a level ("High"), or the value itself when it is not a level."""
    return LEVEL_LABELS.get(str(level), str(level))


def level_at_least(level: str, floor: str) -> bool:
    """Is ``level`` at ``floor`` or above on the ladder?"""
    return LEVELS_ASCENDING.index(level) >= LEVELS_ASCENDING.index(floor)


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #
def _scale(scale_max: Any) -> float:
    ceiling = resolve_severity_scale_max(scale_max)
    return ceiling if ceiling is not None else DEFAULT_SEVERITY_SCALE_MAX


def scale_max_for_source(source: Any) -> float:
    """The ceiling a configured source declares (the seeded default, else 100)."""
    return severity_scale_max_for_source(source)


def source_scale_max(prefs: Any, source_id: Any) -> float:
    """The ceiling of the configured source ``source_id`` under ``prefs``.

    An unknown id (a Demo Mode source, the legacy implicit source, a deleted source)
    resolves to the default ceiling, the identity on the canonical 0 to 100 score.
    Fail-open: a lookup problem never breaks a read."""
    try:
        finder = getattr(prefs, "source_by_id", None)
        inst = finder(str(source_id)) if callable(finder) and source_id else None
    except Exception:  # noqa: BLE001 (advisory display only)
        inst = None
    return severity_scale_max_for_source(inst)


def raw_severity(value: Any) -> float:
    """A raw severity as the suite reads it everywhere (``RawEvent.severity``): the
    shared tolerant coercion, a missing or unreadable value reading ``0.0``."""
    return coerce_float(value, 0.0)


def level_of_magnitude(magnitude: float) -> str:
    """A 0 to 100 magnitude → its level (the one ladder)."""
    for level in LEVELS_DESCENDING:
        floor = LEVEL_FLOORS[level]
        if floor is None or magnitude >= floor:
            return level
    return "info"  # pragma: no cover (Info has no floor; the loop always returns)


def level_of_raw(raw: Any, scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX) -> str:
    """A raw source severity → its level, projected through ``scale_max`` first."""
    return level_of_magnitude(project_severity_magnitude(raw_severity(raw), _scale(scale_max)))


def raw_floor(level: str, scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX) -> float | None:
    """The smallest raw value that reads as ``level`` or above on a source whose ceiling
    is ``scale_max`` (``None`` for Info: every value is Info or above).

    ``cut * scale_max / 100`` is the arithmetic answer; rounding in the projection can
    put the real boundary an ulp or two either side of it, so the bound is walked to the
    exact smallest float whose projection reaches the cut. A native ``gte`` on the result
    and :func:`level_of_raw` therefore never disagree about a finite value."""
    cut = LEVEL_FLOORS[str(level)]
    if cut is None:
        return None
    ceiling = _scale(scale_max)

    def reaches(value: float) -> bool:
        return project_severity_magnitude(value, ceiling) >= cut

    bound = cut * ceiling / 100.0
    for _ in range(_FLOOR_STEPS):
        lower = math.nextafter(bound, -math.inf)
        if not reaches(lower):
            break
        bound = lower
    for _ in range(_FLOOR_STEPS):
        if reaches(bound):
            break
        bound = math.nextafter(bound, math.inf)
    return bound


@dataclass(frozen=True)
class RawSeverityRange:
    """One source's raw-value range for a level filter.

    ``gte`` is inclusive, ``lt`` exclusive (``None`` = unbounded) and ``include_missing``
    says a document with no severity value matches (it reads as ``0.0``, so Info)."""

    gte: float | None = None
    lt: float | None = None
    include_missing: bool = False

    @property
    def unbounded(self) -> bool:
        """True when the range keeps every event (no filter to apply)."""
        return self.gte is None and self.lt is None

    def matches(self, raw: Any) -> bool:
        """The Python form of the native filter, over a value read the suite's way.

        A non-finite value reads ``0.0``, as the projection reads it, so this and
        :func:`level_of_raw` agree on every input."""
        value = raw_severity(raw)
        if not math.isfinite(value):
            value = 0.0
        if self.gte is not None and not value >= self.gte:
            return False
        if self.lt is not None and not value < self.lt:
            return False
        return True


def raw_range(
    *, level: str | None = None, at_least: str | None = None, scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX,
) -> RawSeverityRange:
    """The raw range of "exactly ``level``" intersected with "``at_least`` or above"
    on one source. Both ``None`` (or ``at_least="info"`` alone) keeps everything.

    An empty intersection (exactly Low and at least High) yields a range that keeps
    nothing (``gte`` at or above ``lt``), never an unbounded one."""
    exact = normalise_level(level) if level is not None else None
    floor = normalise_level(at_least) if at_least is not None else None
    gte: float | None = None
    lt: float | None = None
    include_missing = True
    if exact is not None:
        gte = raw_floor(exact, scale_max)
        index = LEVELS_ASCENDING.index(exact)
        if index + 1 < len(LEVELS_ASCENDING):
            lt = raw_floor(LEVELS_ASCENDING[index + 1], scale_max)
        include_missing = exact == "info"
    if floor is not None:
        floor_gte = raw_floor(floor, scale_max)
        if floor_gte is not None:
            gte = floor_gte if gte is None else max(gte, floor_gte)
            include_missing = False
    if gte is not None and lt is not None and gte >= lt:
        # Contradictory filters: nothing can match. Keep it explicit for the caller.
        return RawSeverityRange(gte=gte, lt=lt, include_missing=False)
    return RawSeverityRange(gte=gte, lt=lt, include_missing=include_missing and gte is None)


def level_ranges(scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX) -> dict[str, tuple[float, float | None]]:
    """The raw ``[gte, lt)`` range of every level above Info on one source, Critical
    first (``lt`` ``None``: unbounded above, so a value past the ceiling is Critical).

    Info is the complement (a missing value, a value below the Low floor, a negative
    one), so a native count per range plus "everything else" is Info reads every event
    into exactly the level :func:`level_of_raw` gives it. The bounds are
    :func:`raw_range`'s, so they agree with the projection to the last bit."""
    out: dict[str, tuple[float, float | None]] = {}
    for level in LEVELS_DESCENDING:
        if LEVEL_FLOORS[level] is None:
            continue
        bounds = raw_range(level=level, scale_max=scale_max)
        if bounds.gte is not None:  # every level above Info has a floor
            out[level] = (bounds.gte, bounds.lt)
    return out


# --------------------------------------------------------------------------- #
# Tally
# --------------------------------------------------------------------------- #
@dataclass
class LevelSummary:
    """One level of a breakdown: its count and what made it up."""

    level: str
    count: int = 0
    raw_values: list[dict[str, Any]] = field(default_factory=list)
    rules: Counter = field(default_factory=Counter)
    sources: Counter = field(default_factory=Counter)
    buckets: Counter = field(default_factory=Counter)

    def top_rules(self, n: int = 3) -> list[tuple[str, int]]:
        return sorted(self.rules.items(), key=lambda kv: (-kv[1], kv[0]))[: max(0, n)]

    @property
    def rules_total(self) -> int:
        return len(self.rules)


class SeverityTally:
    """Counted observations folded into the five levels, zeros included.

    :meth:`add` takes one observation group: a raw value on its source's ceiling and how
    many events carried it, optionally with the rule, source and time bucket they belong
    to. The raw value is projected through ITS OWN ceiling before it is merged, so two
    sources on different scales add up level by level, never number by number."""

    def __init__(self) -> None:
        self._levels: dict[str, LevelSummary] = {lv: LevelSummary(lv) for lv in LEVELS_DESCENDING}

    def add(
        self,
        raw: Any,
        *,
        scale_max: Any = DEFAULT_SEVERITY_SCALE_MAX,
        count: int = 1,
        rule: str | None = None,
        source: str | None = None,
        bucket: str | None = None,
    ) -> str:
        """Fold ``count`` events of raw severity ``raw``; returns the level they reached."""
        level = level_of_raw(raw, scale_max)
        n = int(count)
        if n <= 0:
            return level
        summary = self._levels[level]
        summary.count += n
        ceiling = _scale(scale_max)
        value = raw_severity(raw)
        entry = {"value": value, "scale_max": ceiling}
        if entry not in summary.raw_values and len(summary.raw_values) < _RAW_VALUES_PER_LEVEL:
            summary.raw_values.append(entry)
        if rule is not None:
            summary.rules[str(rule)] += n
        if source is not None:
            summary.sources[str(source)] += n
        if bucket is not None:
            summary.buckets[str(bucket)] += n
        return level

    def add_level(
        self,
        level: str,
        *,
        count: int = 1,
        rule: str | None = None,
        source: str | None = None,
        bucket: str | None = None,
    ) -> str:
        """Fold ``count`` events already counted at ``level`` (a native count per raw
        range, :func:`level_ranges`), so no raw value is recorded for them."""
        name = normalise_level(level)
        if name is None:
            raise ValueError(f"not a severity level: {level!r}")
        n = int(count)
        if n <= 0:
            return name
        summary = self._levels[name]
        summary.count += n
        if rule is not None:
            summary.rules[str(rule)] += n
        if source is not None:
            summary.sources[str(source)] += n
        if bucket is not None:
            summary.buckets[str(bucket)] += n
        return name

    def extend(self, observations: Iterable[dict[str, Any]]) -> None:
        """:meth:`add` for every ``{raw, scale_max, count, rule, source, bucket}`` mapping."""
        for obs in observations:
            self.add(
                obs.get("raw"), scale_max=obs.get("scale_max", DEFAULT_SEVERITY_SCALE_MAX),
                count=int(obs.get("count", 1) or 0), rule=obs.get("rule"),
                source=obs.get("source"), bucket=obs.get("bucket"),
            )

    @property
    def total(self) -> int:
        return sum(s.count for s in self._levels.values())

    def level(self, level: str) -> LevelSummary:
        return self._levels[level]

    def levels(self) -> list[LevelSummary]:
        """All five levels, Critical first."""
        return [self._levels[lv] for lv in LEVELS_DESCENDING]

    def counts(self) -> dict[str, int]:
        return {lv: self._levels[lv].count for lv in LEVELS_DESCENDING}

    def shares(self) -> dict[str, float]:
        """Each level's share of the counted events, one decimal (0.0 when none)."""
        total = self.total
        if total <= 0:
            return {lv: 0.0 for lv in LEVELS_DESCENDING}
        return {lv: round(self._levels[lv].count * 100.0 / total, 1) for lv in LEVELS_DESCENDING}

    def bucket_counts(self) -> dict[str, dict[str, int]]:
        """``{bucket: {level: count}}`` over every bucket any level saw (zeros included)."""
        keys: set[str] = set()
        for summary in self._levels.values():
            keys.update(summary.buckets)
        return {
            key: {lv: int(self._levels[lv].buckets.get(key, 0)) for lv in LEVELS_DESCENDING}
            for key in sorted(keys)
        }
