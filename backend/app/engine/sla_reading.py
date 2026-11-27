"""The per-case SLA reading (Round 16 SPEC §4.5 WP10, research explainability R6, D2).

``GET /api/cases/{id}/triage`` serves this as ``sla``, so the case header, the inspector
and the SLA Explain read the clock the posture SLA metrics count. The clock rules (when
a clock starts, what stops the response clock, when a case is at risk or breached) live
in ONE place, ``engine/metrics.sla_case_reading`` (WP15C); this module only picks the
clock that matters now and shapes it for the Console. It re-derives no clock rule.

The reading names one current clock:

* the response clock while no person has responded to an open case;
* the resolution clock once a person has responded (an acknowledgement, or a person
  moving the case into Investigating, Escalated or On hold), so an escalated case reads
  its resolution clock;
* for a closed or resolved case, the stopped resolution clock (the stopped response
  clock when the resolution target is not set).

``state`` is the clock's ``ok``, ``at_risk`` or ``breached``, and ``met`` for a stopped
clock inside its target. ``breached`` is true when any clock of the case is breached:
exactly the rule ``metrics.sla_metrics`` counts a breach by, so the case reading and the
SLA attainment agree. A due instant past the last representable time (a huge target)
is reported as ``None``: the clock is never due.

Pure and advisory (#3): it reads the case and the SLA policy, never changes either,
imports nothing from ``engine/case_manager.py`` (the §3.6 guard) and never feeds
``decide()``. Never raises: an unreadable case reads ``None``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..models import Case
from .metrics import (
    SlaCaseReading,
    SlaClockReading,
    _CaseTimings,
    _sla_priority,
    first_human_response,
    sla_case_reading,
)

#: How the first human response was found (``anchor``): ``acknowledged`` for the
#: acknowledgement or the recorded first response, ``status_history`` for a person's
#: status move, ``created`` when no person has responded yet.
_ANCHOR_BY_SOURCE = {
    "first_response_at": "acknowledged",
    "acknowledged_at": "acknowledged",
    "status_history": "status_history",
}


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.year >= datetime.max.year:
        # The clock is never due (``metrics._sla_clock``'s overflow guard).
        return None
    return value.isoformat()


def _current_clock(reading: SlaCaseReading) -> SlaClockReading | None:
    response, resolution = reading.response, reading.resolution
    if reading.terminal:
        return resolution or response
    if response is not None and response.running:
        return response
    return resolution or response


def _clock_dict(clock: SlaClockReading | None) -> dict[str, Any] | None:
    if clock is None:
        return None
    return {
        "target_minutes": clock.target_minutes,
        "start_at": _iso(clock.start),
        "due_at": _iso(clock.due_at),
        "stopped_at": _iso(clock.stop),
        "stop_source": clock.stop_source or None,
        "elapsed_minutes": round(clock.elapsed_minutes, 2),
        "running": clock.running,
        "state": clock.state,
    }


def case_sla_reading(case: Case, prefs: Any, *, now: datetime | None = None) -> dict[str, Any] | None:
    """The case's SLA reading under ``prefs`` (its ``sla`` policy and, for a case with no
    stored priority, the ITIL projection the case list shows), or ``None`` when the
    policy is off, the case has no priority with a target, or it has no readable start.

    Keys: ``clock`` (``response`` or ``resolution``), ``start_at``, ``anchor``
    (``created``, ``acknowledged`` or ``status_history``), ``responded_at``,
    ``target_minutes``, ``due_at``, ``elapsed_minutes``, ``state``, ``priority``,
    ``priority_source`` (``case_record`` or ``priority_matrix``), plus ``running``,
    ``breached`` (any clock) and ``clocks`` (both clocks, ``None`` where not set)."""
    try:
        policy = getattr(prefs, "sla", None)
        targets = getattr(policy, "targets", None) or {}
        if policy is None or not bool(getattr(policy, "enabled", False)) or not targets:
            return None
        priority = _sla_priority(case, prefs)
        target = targets.get(priority) if priority else None
        if target is None:
            return None
        timings = _CaseTimings(case)
        reading = sla_case_reading(case, target, timings, now=now or datetime.now(timezone.utc))
        clock = _current_clock(reading)
        if reading.start is None or clock is None:
            return None
        responded, responded_source = first_human_response(timings)
        state = clock.state
        if not clock.running and state == "ok":
            state = "met"
        stored_priority = bool((case.priority_level or "").strip())
        return {
            "clock": clock.clock,
            "start_at": _iso(clock.start),
            "anchor": _ANCHOR_BY_SOURCE.get(responded_source, "created"),
            "responded_at": _iso(responded),
            "target_minutes": clock.target_minutes,
            "due_at": _iso(clock.due_at),
            "elapsed_minutes": round(clock.elapsed_minutes, 2),
            "state": state,
            "priority": priority,
            "priority_source": "case_record" if stored_priority else "priority_matrix",
            "running": clock.running,
            "breached": any(
                c is not None and c.state == "breached"
                for c in (reading.response, reading.resolution)
            ),
            "clocks": {
                "response": _clock_dict(reading.response),
                "resolution": _clock_dict(reading.resolution),
            },
        }
    except Exception:  # noqa: BLE001 (advisory: an unreadable case reads "no reading")
        return None


__all__ = ["case_sla_reading"]
