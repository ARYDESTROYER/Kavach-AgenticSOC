"""Truthful, read-only evidence that agent-assisted triage is improving.

This module deliberately reports *observed outcome shifts*, not model learning or
causation.  It is pure over bounded projections of persisted case, usage, noise-
counter, and tuning-ledger rows: no LLM, no writes, and no dependency on the
deterministic case decision function.

The comparison uses the last seven complete UTC days and the preceding,
non-overlapping 28-day baseline.  Missing or weak evidence is returned as ``None``
with an explicit reason; it is never converted to a reassuring zero.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from ..constants import DecisionBy, TERMINAL_CASE_STATUSES
from ..models import Case, FeedbackEntry
from .metrics import percentile, truncation_marker

_VALID_ASSESSMENTS = frozenset({"agree", "partial", "disagree"})
_EVALUABLE_OUTCOMES = frozenset(
    {"true_positive", "false_positive", "true_negative", "false_negative"}
)
_TERMINAL = frozenset(TERMINAL_CASE_STATUSES)
_NON_HUMAN_ACTORS = frozenset(
    {
        "",
        "agent",
        "system",
        "automation",
        "autopilot",
        "case_manager",
        "demo",
        "pipeline",
        "poller",
        "scheduler",
        "tuner",
        # An operator's analyst RULE POLICY close is automation output, not a human
        # working a case: counting it as human would fabricate turnaround/closure
        # samples for work nobody performed.
        DecisionBy.ANALYST_POLICY.value,
    }
)
_ACK_STATUSES = frozenset({"investigating", "escalated", "on_hold"})

_QUALITY_MIN = 30
_TURNAROUND_MIN = 20
_GUARDRAIL_MIN = 20
_DAILY_MIN = 5
_MIX_MIN_COVERAGE = 0.80
_MIX_STRATUM_MIN = 5
_REOPEN_FOLLOW_UP_HOURS = 24
_TIME_SAVED_MIN = 10
_POSITIVE_RATE_MIN = 20


@dataclass(frozen=True)
class _FeedbackSample:
    case: Case
    feedback: FeedbackEntry
    at: datetime


@dataclass(frozen=True)
class _TurnaroundSample:
    minutes: float
    at: datetime


@dataclass(frozen=True)
class _ClosureSample:
    case: Case
    minutes: float
    at: datetime
    owner: str


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _window_end(as_of: date | None, now: datetime | None) -> datetime:
    """Midnight after the most recent complete UTC day (exclusive)."""
    if as_of is not None:
        return datetime.combine(as_of, time.min, tzinfo=timezone.utc)
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return datetime.combine(current.date(), time.min, tzinfo=timezone.utc)


def _in_window(at: datetime, start: datetime, end: datetime) -> bool:
    return start <= at < end


def _is_human(actor: str | None) -> bool:
    return (actor or "").strip().lower() not in _NON_HUMAN_ACTORS


def _outcome_conflicts(feedback: FeedbackEntry) -> bool:
    outcome = (feedback.actual_outcome or "").strip().lower()
    verdict = (feedback.ai_verdict or "").strip().upper()
    if verdict == "TRUE_POSITIVE":
        return outcome in {"false_positive", "true_negative"}
    if verdict == "FALSE_POSITIVE":
        return outcome in {"true_positive", "false_negative"}
    return False


def _materially_corrected(feedback: FeedbackEntry) -> bool:
    assessment = (feedback.assessment or "").strip().lower()
    return assessment == "disagree" or _outcome_conflicts(feedback)


def _case_anchor_in_window(case: Case, start: datetime, end: datetime) -> bool:
    """Return whether the case itself belongs to the bounded reporting horizon."""
    return any(
        anchor is not None and _in_window(anchor, start, end)
        for anchor in (_parse_iso(case.created_at), _parse_iso(case.updated_at))
    )


def _select_feedback(
    cases: list[Case], *, start: datetime, end: datetime
) -> tuple[list[_FeedbackSample], dict[str, int]]:
    """Select the latest valid grade per case as of ``end``.

    Earlier valid grades are superseded.  That makes each case one unit of evidence
    and intentionally restates older daily points when a later analyst grade arrives.
    """
    selected: list[_FeedbackSample] = []
    excluded: Counter[str] = Counter()
    for case in cases:
        if _enum_value(case.decision_by) == DecisionBy.ANALYST_POLICY.value:
            # No model produced a verdict on a policy-closed case, so a grade on it can
            # neither agree nor disagree with the agent. Counting it would put an
            # operator's own declaration into the agent's measured quality — in either
            # direction, depending only on how the analyst happened to grade it.
            excluded["analyst_policy_close"] += 1
            continue
        valid: list[tuple[datetime, int, FeedbackEntry]] = []
        case_excluded: Counter[str] = Counter()
        for index, feedback in enumerate(case.feedback or []):
            at = _parse_iso(feedback.ts)
            if at is None:
                case_excluded["invalid_feedback_timestamp"] += 1
                continue
            # Evidence before the baseline does not belong to this report and must
            # not alter its sample or exclusion counters.
            if at < start:
                continue
            if at >= end:
                case_excluded["feedback_after_as_of"] += 1
                continue
            if (feedback.assessment or "").strip().lower() not in _VALID_ASSESSMENTS:
                case_excluded["invalid_feedback_assessment"] += 1
                continue
            outcome = (feedback.actual_outcome or "").strip().lower()
            if outcome and outcome != "unknown" and outcome not in _EVALUABLE_OUTCOMES:
                case_excluded["invalid_feedback_outcome"] += 1
            valid.append((at, index, feedback))
        relevant = bool(valid) or _case_anchor_in_window(case, start, end)
        if not relevant:
            continue
        excluded.update(case_excluded)
        if not valid:
            continue
        valid.sort(key=lambda item: (item[0], item[1]))
        at, _index, feedback = valid[-1]
        excluded["superseded_feedback"] += max(0, len(valid) - 1)
        selected.append(_FeedbackSample(case=case, feedback=feedback, at=at))
    return selected, dict(excluded)


def _wilson(successes: float, total: int) -> dict[str, float] | None:
    if total <= 0:
        return None
    z = 1.96
    proportion = successes / total
    denom = 1.0 + z * z / total
    centre = (proportion + z * z / (2.0 * total)) / denom
    margin = (
        z
        * ((proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)) ** 0.5)
        / denom
    )
    return {"low": round(max(0.0, centre - margin), 4), "high": round(min(1.0, centre + margin), 4)}


def _quality_summary(samples: list[_FeedbackSample]) -> dict[str, Any]:
    total = len(samples)
    counts = Counter(
        (sample.feedback.assessment or "").strip().lower() for sample in samples
    )
    weighted = counts["agree"] + 0.5 * counts["partial"]
    corrected = sum(1 for sample in samples if _materially_corrected(sample.feedback))
    evaluable = [
        sample
        for sample in samples
        if (sample.feedback.actual_outcome or "").strip().lower() in _EVALUABLE_OUTCOMES
    ]
    confirmed_positives = [
        sample
        for sample in evaluable
        if (sample.feedback.actual_outcome or "").strip().lower()
        in {"true_positive", "false_negative"}
    ]
    false_negatives = sum(
        1
        for sample in confirmed_positives
        if (sample.feedback.actual_outcome or "").strip().lower() == "false_negative"
        or (
            (sample.feedback.ai_verdict or "").strip().upper() == "FALSE_POSITIVE"
            and (sample.feedback.actual_outcome or "").strip().lower() == "true_positive"
        )
    )
    return {
        "sample_count": total,
        "agree": counts["agree"],
        "partial": counts["partial"],
        "disagree": counts["disagree"],
        "agreement": round(weighted / total, 4) if total else None,
        "material_corrections": corrected,
        "correction_rate": round(corrected / total, 4) if total else None,
        "correction_interval": _wilson(float(corrected), total),
        "outcome_evaluable": len(evaluable),
        "confirmed_positive_count": len(confirmed_positives),
        "false_negatives": false_negatives,
        "false_negative_rate": (
            round(false_negatives / len(confirmed_positives), 4)
            if confirmed_positives
            else None
        ),
    }


def _measurement(value: float | None, sample_count: int, minimum: int) -> dict[str, Any]:
    if value is None:
        return {
            "value": None,
            "available": False,
            "status": "unavailable",
            "reason": "no eligible samples",
            "sample_count": sample_count,
            "minimum_sample": minimum,
        }
    enough = sample_count >= minimum
    return {
        "value": value,
        "available": True,
        "status": "enough_data" if enough else "insufficient_evidence",
        "reason": "" if enough else f"requires at least {minimum} eligible samples",
        "sample_count": sample_count,
        "minimum_sample": minimum,
    }


def _comparison_measurement(
    value: float | None,
    sample_count: int,
    minimum: int,
    *,
    comparison_ready: bool,
) -> dict[str, Any]:
    measurement = _measurement(value, sample_count, minimum)
    if measurement["available"] and not comparison_ready:
        measurement["status"] = "insufficient_evidence"
        measurement["reason"] = (
            "requires enough cases in a source-by-severity mix shared by both windows"
        )
    return measurement


def _stratum(case: Case) -> tuple[str, str]:
    source = (case.source_id or case.source_name or "unknown").strip().lower() or "unknown"
    severity = (case.severity_band or "unknown").strip().lower() or "unknown"
    return source, severity


def _mix_adjusted(
    current: list[_FeedbackSample], baseline: list[_FeedbackSample]
) -> dict[str, Any]:
    baseline_counts = Counter(_stratum(sample.case) for sample in baseline)
    current_counts = Counter(_stratum(sample.case) for sample in current)

    base_groups: dict[tuple[str, str], list[_FeedbackSample]] = defaultdict(list)
    current_groups: dict[tuple[str, str], list[_FeedbackSample]] = defaultdict(list)
    for sample in baseline:
        base_groups[_stratum(sample.case)].append(sample)
    for sample in current:
        current_groups[_stratum(sample.case)].append(sample)

    baseline_total = len(baseline)
    current_total = len(current)
    if not baseline_total or not current_total:
        return {
            "dimensions": ["source", "severity"],
            "minimum_per_stratum": _MIX_STRATUM_MIN,
            "baseline_total": baseline_total,
            "current_total": current_total,
            "baseline_covered": 0,
            "current_covered": 0,
            "comparable_mix_coverage": 0.0 if baseline_total or current_total else None,
            "baseline_mix_coverage": 0.0 if baseline_total else None,
            "current_mix_coverage": 0.0 if current_total else None,
            "comparable_strata": 0,
            "baseline_only_strata": len(baseline_counts),
            "current_only_strata": len(current_counts),
            "suppressed_strata": len(set(baseline_counts).intersection(current_counts)),
            "adjusted_baseline_agreement": None,
            "adjusted_current_agreement": None,
            "adjusted_baseline_correction_rate": None,
            "adjusted_current_correction_rate": None,
        }

    shared_keys = set(base_groups).intersection(current_groups)
    comparable_keys = {
        key
        for key in shared_keys
        if len(base_groups[key]) >= _MIX_STRATUM_MIN
        and len(current_groups[key]) >= _MIX_STRATUM_MIN
    }
    baseline_covered = sum(len(base_groups[key]) for key in comparable_keys)
    current_covered = sum(len(current_groups[key]) for key in comparable_keys)
    baseline_coverage = baseline_covered / baseline_total
    current_coverage = current_covered / current_total
    comparable_coverage = min(baseline_coverage, current_coverage)

    reference_total = sum(
        len(base_groups[key]) + len(current_groups[key]) for key in comparable_keys
    )
    adjusted = {
        "baseline_agreement": 0.0,
        "current_agreement": 0.0,
        "baseline_correction": 0.0,
        "current_correction": 0.0,
    }
    if reference_total:
        for key in comparable_keys:
            weight = (len(base_groups[key]) + len(current_groups[key])) / reference_total
            baseline_summary = _quality_summary(base_groups[key])
            current_summary = _quality_summary(current_groups[key])
            adjusted["baseline_agreement"] += weight * float(
                baseline_summary["agreement"]
            )
            adjusted["current_agreement"] += weight * float(
                current_summary["agreement"]
            )
            adjusted["baseline_correction"] += weight * float(
                baseline_summary["correction_rate"]
            )
            adjusted["current_correction"] += weight * float(
                current_summary["correction_rate"]
            )

    return {
        "dimensions": ["source", "severity"],
        "minimum_per_stratum": _MIX_STRATUM_MIN,
        "baseline_total": baseline_total,
        "current_total": current_total,
        "baseline_covered": baseline_covered,
        "current_covered": current_covered,
        "comparable_mix_coverage": round(comparable_coverage, 4),
        "baseline_mix_coverage": round(baseline_coverage, 4),
        "current_mix_coverage": round(current_coverage, 4),
        "comparable_strata": len(comparable_keys),
        "baseline_only_strata": len(set(baseline_counts) - set(current_counts)),
        "current_only_strata": len(set(current_counts) - set(baseline_counts)),
        "suppressed_strata": len(shared_keys - comparable_keys),
        "adjusted_baseline_agreement": (
            round(adjusted["baseline_agreement"], 4) if reference_total else None
        ),
        "adjusted_current_agreement": (
            round(adjusted["current_agreement"], 4) if reference_total else None
        ),
        "adjusted_baseline_correction_rate": (
            round(adjusted["baseline_correction"], 4) if reference_total else None
        ),
        "adjusted_current_correction_rate": (
            round(adjusted["current_correction"], 4) if reference_total else None
        ),
    }


def _turnaround_samples(
    cases: list[Case], *, start: datetime, end: datetime
) -> tuple[list[_TurnaroundSample], dict[str, int]]:
    samples: list[_TurnaroundSample] = []
    excluded: Counter[str] = Counter()
    for case in cases:
        parsed: list[tuple[datetime, int, Any]] = []
        case_excluded: Counter[str] = Counter()
        for index, entry in enumerate(case.status_history or []):
            at = _parse_iso(entry.at)
            if at is None:
                case_excluded["invalid_status_timestamp"] += 1
                continue
            if at < end:
                parsed.append((at, index, entry))
        parsed.sort(key=lambda item: (item[0], item[1]))
        relevant = any(_in_window(at, start, end) for at, _index, _entry in parsed)
        relevant = relevant or _case_anchor_in_window(case, start, end)
        if not relevant:
            continue
        excluded.update(case_excluded)
        if not parsed:
            excluded["no_status_history"] += 1
            continue

        status_at_end = (parsed[-1][2].to_status or "").strip().lower()
        if status_at_end not in _TERMINAL:
            excluded["not_terminal_as_of"] += 1
            continue
        terminal = parsed[-1]
        if not _is_human(terminal[2].by):
            excluded["non_human_terminal"] += 1
            continue

        created = _parse_iso(case.created_at)
        episode_start = created
        for at, _index, entry in parsed:
            if at >= terminal[0]:
                break
            if (
                (entry.from_status or "").strip().lower() in _TERMINAL
                and (entry.to_status or "").strip().lower() not in _TERMINAL
                and _is_human(entry.by)
            ):
                episode_start = at
        if episode_start is None:
            excluded["invalid_case_created_at"] += 1
            continue

        acknowledge = next(
            (
                at
                for at, _index, entry in parsed
                if episode_start <= at <= terminal[0]
                and (entry.to_status or "").strip().lower() in _ACK_STATUSES
                and _is_human(entry.by)
            ),
            None,
        )
        if acknowledge is None:
            excluded["no_human_acknowledgement"] += 1
            continue
        if terminal[0] < acknowledge:
            excluded["negative_turnaround"] += 1
            continue
        samples.append(
            _TurnaroundSample(
                minutes=(terminal[0] - acknowledge).total_seconds() / 60.0,
                at=terminal[0],
            )
        )
    return samples, dict(excluded)


def _turnaround_summary(samples: list[_TurnaroundSample]) -> dict[str, Any]:
    values = [sample.minutes for sample in samples]
    return {
        "sample_count": len(values),
        "p50_minutes": round(percentile(values, 50), 1) if values else None,
        "p90_minutes": round(percentile(values, 90), 1) if values else None,
        "q1_minutes": round(percentile(values, 25), 1) if values else None,
        "q3_minutes": round(percentile(values, 75), 1) if values else None,
    }


def _agent_reopen_summary(
    cases: list[Case], *, start: datetime, end: datetime, observed_through: datetime
) -> dict[str, Any]:
    candidate_terminal = 0
    eligible_terminal = 0
    censored_terminal = 0
    reopened = 0
    horizon = timedelta(hours=_REOPEN_FOLLOW_UP_HOURS)
    for case in cases:
        parsed: list[tuple[datetime, int, Any]] = []
        for index, entry in enumerate(case.status_history or []):
            at = _parse_iso(entry.at)
            if at is not None and at < observed_through:
                parsed.append((at, index, entry))
        parsed.sort(key=lambda item: (item[0], item[1]))
        for position, (at, _index, entry) in enumerate(parsed):
            if not _in_window(at, start, end):
                continue
            if (
                (entry.to_status or "").strip().lower() not in _TERMINAL
                or (entry.by or "").strip().lower() != "agent"
            ):
                continue
            candidate_terminal += 1
            follow_up_end = at + horizon
            if follow_up_end > observed_through:
                censored_terminal += 1
                continue
            eligible_terminal += 1
            if any(
                later_at <= follow_up_end
                and later_at > at
                and (later.from_status or "").strip().lower() in _TERMINAL
                and (later.to_status or "").strip().lower() not in _TERMINAL
                and _is_human(later.by)
                for later_at, _later_index, later in parsed[position + 1 :]
            ):
                reopened += 1
    return {
        "candidate_agent_terminal_decisions": candidate_terminal,
        "eligible_agent_terminal_decisions": eligible_terminal,
        "right_censored_decisions": censored_terminal,
        "human_reopens": reopened,
        "rate": round(reopened / eligible_terminal, 4) if eligible_terminal else None,
        "follow_up_hours": _REOPEN_FOLLOW_UP_HOURS,
    }


def _direction(delta: float | None, *, threshold: float, good: str) -> str:
    if delta is None:
        return "insufficient_evidence"
    if abs(delta) < threshold:
        return "stable"
    improving = delta > 0 if good == "up" else delta < 0
    return "improving" if improving else "regressing"


def _daily_points(
    feedback: list[_FeedbackSample],
    turnaround: list[_TurnaroundSample],
    *,
    start: datetime,
    current_start: datetime,
    end: datetime,
) -> list[dict[str, Any]]:
    feedback_by_day: dict[str, list[_FeedbackSample]] = defaultdict(list)
    turnaround_by_day: dict[str, list[_TurnaroundSample]] = defaultdict(list)
    for sample in feedback:
        if _in_window(sample.at, start, end):
            feedback_by_day[sample.at.date().isoformat()].append(sample)
    for sample in turnaround:
        if _in_window(sample.at, start, end):
            turnaround_by_day[sample.at.date().isoformat()].append(sample)

    points: list[dict[str, Any]] = []
    cursor = start
    while cursor < end:
        day = cursor.date().isoformat()
        quality = _quality_summary(feedback_by_day.get(day, []))
        handling = _turnaround_summary(turnaround_by_day.get(day, []))
        quality_enough = quality["sample_count"] >= _DAILY_MIN
        false_negative_enough = quality["confirmed_positive_count"] >= _DAILY_MIN
        handling_enough = handling["sample_count"] >= _DAILY_MIN
        points.append(
            {
                "date": day,
                "window": "current" if cursor >= current_start else "baseline",
                "analyst_reported_agreement": (
                    quality["agreement"] if quality_enough else None
                ),
                "correction_rate": (
                    quality["correction_rate"] if quality_enough else None
                ),
                "false_negative_rate": (
                    quality["false_negative_rate"] if false_negative_enough else None
                ),
                "review_turnaround_p50_minutes": (
                    handling["p50_minutes"] if handling_enough else None
                ),
                "quality_sample_count": quality["sample_count"],
                "confirmed_positive_sample_count": quality["confirmed_positive_count"],
                "turnaround_sample_count": handling["sample_count"],
                "status": (
                    "enough_data"
                    if quality_enough or false_negative_enough or handling_enough
                    else "collecting_evidence"
                ),
            }
        )
        cursor += timedelta(days=1)
    return points


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value) or "").strip().lower()


def _neutral_direction(
    current: float | None,
    baseline: float | None,
    *,
    relative_threshold: float = 0.05,
) -> str:
    """Return a descriptive direction without declaring the movement good or bad."""
    if current is None or baseline is None:
        return "insufficient_evidence"
    if baseline == 0:
        if current == 0:
            return "stable"
        return "up"
    relative = (current - baseline) / abs(baseline)
    if abs(relative) < relative_threshold:
        return "stable"
    return "up" if relative > 0 else "down"


def _relative_delta(current: float | None, baseline: float | None) -> float | None:
    if current is None or baseline in (None, 0):
        return None
    return round((current - baseline) / baseline, 4)


def _period_status(
    current_count: int,
    baseline_count: int,
    minimum: int,
    *,
    truncated: bool,
) -> tuple[str, str]:
    if current_count == 0 and baseline_count == 0:
        return "unavailable", "no eligible samples in either period"
    if truncated:
        return "insufficient_evidence", "the bounded case read may omit eligible samples"
    if current_count < minimum or baseline_count < minimum:
        return (
            "insufficient_evidence",
            f"requires at least {minimum} eligible samples in both periods",
        )
    return "enough_data", ""


def _closure_samples(
    cases: list[Case], *, start: datetime, end: datetime
) -> list[_ClosureSample]:
    """Elapsed final-episode closure samples split by terminal transition owner.

    A human-owned close is still an agent-assisted case, not a manual-control cohort.
    ``by`` is a free-text operational actor label, so this is explicitly an observed
    ownership split rather than authenticated labor accounting.
    """
    samples: list[_ClosureSample] = []
    for case in cases:
        parsed: list[tuple[datetime, int, Any]] = []
        for index, entry in enumerate(case.status_history or []):
            at = _parse_iso(entry.at)
            if at is not None and at < end:
                parsed.append((at, index, entry))
        parsed.sort(key=lambda item: (item[0], item[1]))
        if not parsed:
            continue
        terminal_at, _terminal_index, terminal = parsed[-1]
        if not _in_window(terminal_at, start, end):
            continue
        if _enum_value(terminal.to_status) not in _TERMINAL:
            continue

        episode_start = _parse_iso(case.created_at)
        for at, _index, entry in parsed:
            if at >= terminal_at:
                break
            if (
                _enum_value(entry.from_status) in _TERMINAL
                and _enum_value(entry.to_status) not in _TERMINAL
            ):
                episode_start = at
        if episode_start is None or terminal_at < episode_start:
            continue

        actor = (terminal.by or "").strip().lower()
        decision_owner = _enum_value(case.decision_by)
        if decision_owner == DecisionBy.ANALYST_POLICY.value:
            # Neither agent nor human: the operator answered at the RULE level before
            # any case existed, so this closure is evidence about neither party's
            # effectiveness and belongs in no observed-time-saved sample.
            continue
        if actor == "agent" or decision_owner == "agent":
            owner = "agent"
        elif _is_human(actor) and decision_owner != "system":
            owner = "human_owned"
        else:
            continue
        samples.append(
            _ClosureSample(
                case=case,
                minutes=(terminal_at - episode_start).total_seconds() / 60.0,
                at=terminal_at,
                owner=owner,
            )
        )
    return samples


def _closure_period(
    samples: list[_ClosureSample], feedback: list[_FeedbackSample]
) -> dict[str, Any]:
    human = [sample.minutes for sample in samples if sample.owner == "human_owned"]
    agent = [sample.minutes for sample in samples if sample.owner == "agent"]
    human_p50 = round(percentile(human, 50), 1) if human else None
    agent_p50 = round(percentile(agent, 50), 1) if agent else None
    difference = (
        round(human_p50 - agent_p50, 1)
        if human_p50 is not None and agent_p50 is not None
        else None
    )
    reported = [
        int(sample.feedback.time_saved_minutes)
        for sample in feedback
        if int(sample.feedback.time_saved_minutes or 0) > 0
    ]
    if not human and not agent:
        status = "unavailable"
        reason = "no eligible human-owned or agent-closed cases"
    elif not human:
        status = "unavailable"
        reason = "no eligible human-owned closures for an elapsed-time comparison"
    elif not agent:
        status = "unavailable"
        reason = "no eligible agent closures for an elapsed-time comparison"
    elif len(human) < _TIME_SAVED_MIN or len(agent) < _TIME_SAVED_MIN:
        status = "insufficient_evidence"
        reason = (
            f"requires at least {_TIME_SAVED_MIN} human-owned and "
            f"{_TIME_SAVED_MIN} agent closures"
        )
    else:
        status = "enough_data"
        reason = ""
    return {
        "status": status,
        "reason": reason,
        "human_owned_closure_p50_minutes": human_p50,
        "agent_closed_p50_minutes": agent_p50,
        "observed_difference_minutes_per_case": difference,
        # Signed aggregate: positive means the agent-owned cohort was faster;
        # negative means it was slower. Keep the legacy "saved" projection only
        # when the observed difference is non-negative so a UI cannot turn slower
        # handling into a positive savings claim by formatting an absolute value.
        "observed_aggregate_elapsed_difference_minutes": (
            round(difference * len(agent), 1) if difference is not None else None
        ),
        "estimated_total_minutes_saved": (
            round(difference * len(agent), 1)
            if difference is not None and difference >= 0
            else None
        ),
        "human_owned_closure_count": len(human),
        "agent_closed_count": len(agent),
        "analyst_reported_total_minutes_saved": sum(reported) if reported else None,
        "analyst_reported_sample_count": len(reported),
        "minimum_sample_per_owner": _TIME_SAVED_MIN,
    }


def _observed_time_saved(
    cases: list[Case],
    feedback: list[_FeedbackSample],
    *,
    baseline_start: datetime,
    current_start: datetime,
    end: datetime,
    truncated: bool,
) -> dict[str, Any]:
    closure = _closure_samples(cases, start=baseline_start, end=end)
    current = _closure_period(
        [sample for sample in closure if _in_window(sample.at, current_start, end)],
        [sample for sample in feedback if _in_window(sample.at, current_start, end)],
    )
    baseline = _closure_period(
        [sample for sample in closure if _in_window(sample.at, baseline_start, current_start)],
        [sample for sample in feedback if _in_window(sample.at, baseline_start, current_start)],
    )
    if truncated:
        status = "insufficient_evidence"
        reason = "the bounded case read may omit closure samples"
    elif current["status"] == "unavailable" or baseline["status"] == "unavailable":
        status = "unavailable"
        reason = current["reason"] or baseline["reason"]
    elif current["status"] != "enough_data" or baseline["status"] != "enough_data":
        status = "insufficient_evidence"
        reason = current["reason"] or baseline["reason"]
    else:
        status = "enough_data"
        reason = ""
    delta = (
        round(
            current["observed_difference_minutes_per_case"]
            - baseline["observed_difference_minutes_per_case"],
            1,
        )
        if current["observed_difference_minutes_per_case"] is not None
        and baseline["observed_difference_minutes_per_case"] is not None
        else None
    )
    direction = (
        _direction(delta, threshold=5.0, good="up")
        if status == "enough_data"
        else "insufficient_evidence"
    )
    return {
        "label": "Observed elapsed-time difference",
        "unit": "minutes",
        "status": status,
        "reason": reason,
        "current": current,
        "baseline": baseline,
        "delta": {"minutes_per_case": delta},
        "direction": direction,
        "definition": {
            "formula": "p50 elapsed human-owned closure time − p50 elapsed agent closure time",
            "numerator": "Observed final-episode elapsed closure times, plus separately reported analyst estimates.",
            "denominator": "Eligible terminal cases in each ownership cohort.",
            "eligibility": "A valid creation/reopen anchor and terminal transition inside the reporting window.",
            "caveats": (
                "Human-owned cases were still agent-assisted, actor labels are free text, "
                "the cohorts are unmatched, elapsed time is not active labor, and the "
                "extrapolated total is not a counterfactual or overtime-cost estimate. "
                "Legacy zero time-saved values cannot be distinguished from no report."
            ),
        },
    }


def _usage_period(
    records: list[dict[str, Any]], *, start: datetime, end: datetime, days: int
) -> dict[str, Any]:
    eligible: list[dict[str, Any]] = []
    case_keys: set[str] = set()
    for row in records:
        at = _parse_iso(str(row.get("ts") or ""))
        case_key = str(row.get("case_id") or "").strip()
        if at is None or not case_key or not _in_window(at, start, end):
            continue
        eligible.append(row)
        case_keys.add(case_key)
    total_cost = 0.0
    for row in eligible:
        try:
            total_cost += max(0.0, float(row.get("cost") or 0.0))
        except (TypeError, ValueError):
            continue
    total_cost = round(total_cost, 6)
    costed_cases = len(case_keys)
    return {
        "total_cost": total_cost,
        "call_count": len(eligible),
        "costed_cases": costed_cases,
        "cost_per_costed_case": (
            round(total_cost / costed_cases, 6) if costed_cases else None
        ),
        "cost_per_day": round(total_cost / max(1, days), 6),
    }


def _recorded_case_cost(
    records: list[dict[str, Any]] | None,
    *,
    baseline_start: datetime,
    current_start: datetime,
    end: datetime,
    current_days: int,
    baseline_days: int,
    available: bool,
    truncated: bool,
) -> dict[str, Any]:
    rows = records or []
    current = _usage_period(rows, start=current_start, end=end, days=current_days)
    baseline = _usage_period(
        rows, start=baseline_start, end=current_start, days=baseline_days
    )
    if not available:
        status = "unavailable"
        reason = "the usage ledger could not be read"
    elif truncated:
        status = "insufficient_evidence"
        reason = "the bounded usage read reached its cap"
    elif current["call_count"] == 0 and baseline["call_count"] == 0:
        status = "unavailable"
        reason = "no eligible case-associated usage rows in either period"
    elif current["call_count"] == 0 or baseline["call_count"] == 0:
        status = "insufficient_evidence"
        reason = "eligible case-associated usage rows are required in both periods"
    else:
        status = "enough_data"
        reason = ""
    direction = (
        _neutral_direction(
            current["cost_per_costed_case"], baseline["cost_per_costed_case"]
        )
        if status == "enough_data"
        else "insufficient_evidence"
    )
    cost_per_day_direction = (
        _neutral_direction(current["cost_per_day"], baseline["cost_per_day"])
        if status == "enough_data"
        else "insufficient_evidence"
    )
    return {
        "label": "Recorded case-associated AI cost",
        "unit": "USD",
        "currency": "USD",
        "status": status,
        "reason": reason,
        "current": current,
        "baseline": baseline,
        "delta": {
            "cost_per_day_relative": _relative_delta(
                current["cost_per_day"], baseline["cost_per_day"]
            ),
            "cost_per_costed_case_relative": _relative_delta(
                current["cost_per_costed_case"],
                baseline["cost_per_costed_case"],
            ),
        },
        "direction": direction,
        "cost_per_day_direction": cost_per_day_direction,
        "definition": {
            "formula": "sum of recorded UsageDoc cost for calls carrying a case_id",
            "numerator": "Gateway-recorded case-associated model cost in USD.",
            "denominator": "Complete UTC days or distinct costed cases, as labelled.",
            "eligibility": "Usage rows with a valid timestamp, case association, and reporting-window membership.",
            "caveats": (
                "This is model operating cost, not analyst overtime or total SOC cost. "
                "The primary direction follows cost per costed case; cost-per-day has a "
                "separate neutral direction so neither movement is presented as inherently good."
            ),
        },
    }


def _positive_rate_period(summary: dict[str, Any]) -> dict[str, Any]:
    denominator = int(summary["outcome_evaluable"])
    numerator = int(summary["confirmed_positive_count"])
    value = round(numerator / denominator, 4) if denominator else None
    measurement = _measurement(value, denominator, _POSITIVE_RATE_MIN)
    return {
        **measurement,
        "confirmed_positive_cases": numerator,
        "outcome_evaluable_cases": denominator,
    }


def _confirmed_positive_case_rate(
    current_quality: dict[str, Any],
    baseline_quality: dict[str, Any],
    *,
    truncated: bool,
) -> dict[str, Any]:
    current = _positive_rate_period(current_quality)
    baseline = _positive_rate_period(baseline_quality)
    if truncated:
        status = "insufficient_evidence"
        reason = "the bounded case read may omit outcome-evaluable cases"
    elif current["status"] == "unavailable" and baseline["status"] == "unavailable":
        status = "unavailable"
        reason = "no outcome-evaluable analyst grades"
    elif current["status"] != "enough_data" or baseline["status"] != "enough_data":
        status = "insufficient_evidence"
        reason = f"requires at least {_POSITIVE_RATE_MIN} evaluated cases in both windows"
    else:
        status = "enough_data"
        reason = ""
    delta = (
        round(current["value"] - baseline["value"], 4)
        if current["value"] is not None and baseline["value"] is not None
        else None
    )
    return {
        "label": "Confirmed-positive share of evaluated cases",
        "unit": "ratio",
        "status": status,
        "reason": reason,
        "current": current,
        "baseline": baseline,
        "delta": {
            "percentage_points": round(delta * 100, 2) if delta is not None else None
        },
        "direction": (
            _neutral_direction(current["value"], baseline["value"], relative_threshold=0.03)
            if status == "enough_data"
            else "insufficient_evidence"
        ),
        "definition": {
            "formula": "confirmed-positive graded cases / outcome-evaluable graded cases",
            "numerator": "Latest-valid grades marked true_positive or false_negative.",
            "denominator": "Latest-valid grades with an allow-listed actual outcome.",
            "eligibility": "One latest valid analyst grade per case in the reporting window.",
            "caveats": (
                "This is a case-level observed mix, not true-positive alerts / total alerts, "
                "not detection precision or recall, and an increase is not inherently better."
            ),
        },
    }


def _counter_total(value: Any) -> int | None:
    if not isinstance(value, dict):
        return None
    total = 0
    for item in value.values():
        try:
            total += max(0, int(item or 0))
        except (TypeError, ValueError):
            continue
    return total


def _noise_period(raw: dict[str, Any] | None, *, days: int) -> dict[str, Any]:
    block = raw or {}
    ingested = _counter_total(block.get("ingested"))
    clustered = _counter_total(block.get("clustered"))
    reduction = (
        max(0, ingested - clustered)
        if ingested is not None and clustered is not None
        else None
    )
    return {
        "ingested_alerts": ingested,
        "after_clustering_alerts": clustered,
        "clustering_reduction_count": reduction,
        "clustering_reduction_rate": (
            round(reduction / ingested, 4)
            if reduction is not None and ingested > 0
            else None
        ),
        "ingested_per_day": round(ingested / max(1, days), 2) if ingested is not None else None,
        "after_clustering_per_day": (
            round(clustered / max(1, days), 2) if clustered is not None else None
        ),
    }


def _alert_volume(
    comparison: dict[str, Any] | None,
    *,
    current_days: int,
    baseline_days: int,
) -> dict[str, Any]:
    source = comparison or {}
    current = _noise_period(source.get("current"), days=current_days)
    baseline = _noise_period(source.get("baseline"), days=baseline_days)
    if not source.get("available"):
        status = "unavailable"
        reason = str(source.get("reason") or "durable alert counters are not available")
    elif source.get("incomplete"):
        status = "insufficient_evidence"
        reason = "durable counters cover only part of the requested reporting windows"
    else:
        status = "enough_data"
        reason = ""
    ingested_direction = (
        _neutral_direction(current["ingested_per_day"], baseline["ingested_per_day"])
        if status == "enough_data"
        else "insufficient_evidence"
    )
    clustered_direction = (
        _neutral_direction(
            current["after_clustering_per_day"], baseline["after_clustering_per_day"]
        )
        if status == "enough_data"
        else "insufficient_evidence"
    )
    return {
        "label": "Observed alert volume",
        "unit": "alerts",
        "status": status,
        "reason": reason,
        "window_basis": str(source.get("window_basis") or "rolling_hours"),
        "current": current,
        "baseline": baseline,
        "delta": {
            "ingested_per_day_relative": _relative_delta(
                current["ingested_per_day"], baseline["ingested_per_day"]
            ),
            "after_clustering_per_day_relative": _relative_delta(
                current["after_clustering_per_day"],
                baseline["after_clustering_per_day"],
            ),
        },
        "direction": clustered_direction,
        "ingested_direction": ingested_direction,
        "after_clustering_direction": clustered_direction,
        "definition": {
            "formula": "durable ingested and after-clustering counter totals / labelled days",
            "numerator": "Raw alerts recorded at ingest and alerts remaining after clustering.",
            "denominator": "The labelled window, normalized per day for comparison.",
            "eligibility": "The retained counter horizon must span both comparison windows.",
            "caveats": (
                "Threshold tuning can affect after-clustering volume, not upstream ingested "
                "volume. Source changes and threat activity also move these counts, so up/down "
                "is descriptive rather than automatically better/worse or causal. Counter "
                "retention does not prove uninterrupted source or connector availability; "
                "an outage can lower both totals."
            ),
        },
    }


def _true_positive_alert_yield(alert_volume: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": "True-positive alert yield",
        "unit": "ratio",
        "status": "unavailable",
        "reason": (
            "Analyst outcomes are persisted per case while durable volume is counted per "
            "alert; the current schema has no defensible alert-level outcome lineage."
        ),
        "current": {
            "value": None,
            "true_positive_alerts": None,
            "total_alerts": alert_volume["current"]["ingested_alerts"],
            "lineage_coverage": None,
        },
        "baseline": {
            "value": None,
            "true_positive_alerts": None,
            "total_alerts": alert_volume["baseline"]["ingested_alerts"],
            "lineage_coverage": None,
        },
        "delta": {"percentage_points": None},
        "direction": "insufficient_evidence",
        "supported_alternative": "confirmed_positive_case_rate",
        "definition": {
            "formula": "true-positive alerts / total alerts (not currently computable)",
            "numerator": "Requires alert-level confirmed outcomes that are not persisted today.",
            "denominator": "Durable ingested-alert count when counters are available.",
            "eligibility": "Requires complete one-to-one alert outcome lineage.",
            "caveats": "Case outcomes are not propagated to every member event or alert.",
        },
    }


def _tuning_context(
    records: list[dict[str, Any]] | None,
    *,
    baseline_start: datetime,
    current_start: datetime,
    end: datetime,
    available: bool,
    truncated: bool,
    alert_volume: dict[str, Any],
) -> dict[str, Any]:
    def counts(start: datetime, stop: datetime) -> dict[str, int]:
        applied = rolled_back = 0
        for row in records or []:
            applied_at = _parse_iso(str(row.get("applied_at") or ""))
            rolled_back_at = _parse_iso(str(row.get("rolled_back_at") or ""))
            if applied_at is not None and _in_window(applied_at, start, stop):
                applied += 1
            if rolled_back_at is not None and _in_window(rolled_back_at, start, stop):
                rolled_back += 1
        return {"applied_changes": applied, "rolled_back_changes": rolled_back}

    current = counts(current_start, end)
    baseline = counts(baseline_start, current_start)
    total_changes = sum(current.values()) + sum(baseline.values())
    if not available:
        status = "unavailable"
        reason = "the threshold-tuning ledger could not be read"
    elif truncated:
        status = "insufficient_evidence"
        reason = "the bounded tuning-ledger projection reached its cap"
    elif total_changes == 0:
        status = "not_applicable"
        reason = "no threshold changes were recorded in either reporting window"
    elif alert_volume["status"] != "enough_data":
        status = "insufficient_evidence"
        reason = "threshold changes exist, but comparable alert-volume counters do not"
    else:
        status = "enough_data"
        reason = ""
    return {
        "label": "Threshold-tuning context",
        "status": status,
        "reason": reason,
        "current": current,
        "baseline": baseline,
        "delta": {
            "applied_changes": current["applied_changes"] - baseline["applied_changes"]
        },
        "direction": alert_volume["after_clustering_direction"],
        "cooccurring_after_clustering_direction": alert_volume[
            "after_clustering_direction"
        ],
        "causal_claim": False,
        "model_fine_tuning_evidence": False,
        "definition": {
            "formula": "recorded threshold changes shown beside aggregate alert-volume movement",
            "numerator": "Applied and rolled-back correlation/severity threshold changes.",
            "denominator": "The selected reporting windows; no per-rule outcome denominator exists.",
            "eligibility": "A readable tuning ledger and complete aggregate alert counters.",
            "caveats": (
                "Co-occurrence does not establish that tuning caused the volume change. "
                "This is detection-threshold tuning, not model training or fine-tuning."
            ),
        },
    }


def _source_guidance() -> dict[str, Any]:
    return {
        "status": "not_available",
        "reason": (
            "The current product does not persist validated source-gap-to-alert "
            "recommendation evidence. Specific log-source advice would be speculative."
        ),
        "items": [],
        "long_term_objective": True,
        "required_evidence": (
            "A governed coverage model linking missing telemetry to alert-specific "
            "triage uncertainty and measured post-addition outcomes."
        ),
    }


def _operational_outcomes(
    cases: list[Case],
    feedback: list[_FeedbackSample],
    current_quality: dict[str, Any],
    baseline_quality: dict[str, Any],
    *,
    baseline_start: datetime,
    current_start: datetime,
    end: datetime,
    current_days: int,
    baseline_days: int,
    cases_truncated: bool,
    usage_records: list[dict[str, Any]] | None,
    usage_available: bool,
    usage_records_truncated: bool,
    noise_comparison: dict[str, Any] | None,
    tuning_records: list[dict[str, Any]] | None,
    tuning_available: bool,
    tuning_records_truncated: bool,
) -> dict[str, Any]:
    alert_volume = _alert_volume(
        noise_comparison,
        current_days=current_days,
        baseline_days=baseline_days,
    )
    return {
        "recorded_case_cost": _recorded_case_cost(
            usage_records,
            baseline_start=baseline_start,
            current_start=current_start,
            end=end,
            current_days=current_days,
            baseline_days=baseline_days,
            available=usage_available,
            truncated=usage_records_truncated,
        ),
        "observed_time_saved": _observed_time_saved(
            cases,
            feedback,
            baseline_start=baseline_start,
            current_start=current_start,
            end=end,
            truncated=cases_truncated,
        ),
        "confirmed_positive_case_rate": _confirmed_positive_case_rate(
            current_quality,
            baseline_quality,
            truncated=cases_truncated,
        ),
        "true_positive_alert_yield": _true_positive_alert_yield(alert_volume),
        "alert_volume": alert_volume,
        "tuning_context": _tuning_context(
            tuning_records,
            baseline_start=baseline_start,
            current_start=current_start,
            end=end,
            available=tuning_available,
            truncated=tuning_records_truncated,
            alert_volume=alert_volume,
        ),
        "source_guidance": _source_guidance(),
    }


def _compact_metric(
    *,
    current: float | None,
    baseline: float | None,
    current_count: int,
    baseline_count: int,
    minimum: int,
    truncated: bool,
    good: str | None,
    threshold: float,
    delta_scale: float = 1.0,
) -> dict[str, Any]:
    status, reason = _period_status(
        current_count, baseline_count, minimum, truncated=truncated
    )
    delta = (
        round((current - baseline) * delta_scale, 2)
        if current is not None and baseline is not None
        else None
    )
    if status != "enough_data":
        direction = "insufficient_evidence"
    elif good is None:
        direction = _neutral_direction(current, baseline, relative_threshold=threshold)
    else:
        raw_delta = current - baseline if current is not None and baseline is not None else None
        direction = _direction(raw_delta, threshold=threshold, good=good)
    return {
        "status": status,
        "reason": reason,
        "current": current,
        "baseline": baseline,
        "current_sample_count": current_count,
        "baseline_sample_count": baseline_count,
        "delta": delta,
        "direction": direction,
    }


def _period_comparison(
    cases: list[Case],
    *,
    end: datetime,
    days: int,
    label: str,
    truncated: bool,
    calendar_period: bool,
    usage_records: list[dict[str, Any]] | None,
    usage_available: bool,
    usage_records_truncated: bool,
    noise_comparison: dict[str, Any] | None,
    tuning_records: list[dict[str, Any]] | None,
    tuning_available: bool,
    tuning_records_truncated: bool,
) -> dict[str, Any]:
    current_start = end - timedelta(days=days)
    baseline_start = current_start - timedelta(days=days)
    feedback, _excluded = _select_feedback(cases, start=baseline_start, end=end)
    turnaround, _turnaround_excluded = _turnaround_samples(
        cases, start=baseline_start, end=end
    )
    current_feedback = [sample for sample in feedback if _in_window(sample.at, current_start, end)]
    baseline_feedback = [
        sample for sample in feedback if _in_window(sample.at, baseline_start, current_start)
    ]
    current_quality = _quality_summary(current_feedback)
    baseline_quality = _quality_summary(baseline_feedback)
    current_turnaround = _turnaround_summary(
        [sample for sample in turnaround if _in_window(sample.at, current_start, end)]
    )
    baseline_turnaround = _turnaround_summary(
        [sample for sample in turnaround if _in_window(sample.at, baseline_start, current_start)]
    )
    mix = _mix_adjusted(current_feedback, baseline_feedback)
    quality_truncated = truncated or (
        mix["comparable_mix_coverage"] is None
        or mix["comparable_mix_coverage"] < _MIX_MIN_COVERAGE
    )
    current_positive = _positive_rate_period(current_quality)
    baseline_positive = _positive_rate_period(baseline_quality)
    metrics = {
        "analyst_reported_verdict_agreement": _compact_metric(
            current=mix["adjusted_current_agreement"],
            baseline=mix["adjusted_baseline_agreement"],
            current_count=mix["current_covered"],
            baseline_count=mix["baseline_covered"],
            minimum=_QUALITY_MIN,
            truncated=quality_truncated,
            good="up",
            threshold=0.03,
            delta_scale=100.0,
        ),
        "material_analyst_correction_rate": _compact_metric(
            current=mix["adjusted_current_correction_rate"],
            baseline=mix["adjusted_baseline_correction_rate"],
            current_count=mix["current_covered"],
            baseline_count=mix["baseline_covered"],
            minimum=_QUALITY_MIN,
            truncated=quality_truncated,
            good="down",
            threshold=0.03,
            delta_scale=100.0,
        ),
        "human_review_turnaround": _compact_metric(
            current=current_turnaround["p50_minutes"],
            baseline=baseline_turnaround["p50_minutes"],
            current_count=current_turnaround["sample_count"],
            baseline_count=baseline_turnaround["sample_count"],
            minimum=_TURNAROUND_MIN,
            truncated=truncated,
            good="down",
            threshold=5.0,
        ),
        "confirmed_positive_case_rate": _compact_metric(
            current=current_positive["value"],
            baseline=baseline_positive["value"],
            current_count=current_positive["outcome_evaluable_cases"],
            baseline_count=baseline_positive["outcome_evaluable_cases"],
            minimum=_POSITIVE_RATE_MIN,
            truncated=truncated,
            good=None,
            threshold=0.03,
            delta_scale=100.0,
        ),
    }
    statuses = {metric["status"] for metric in metrics.values()}
    status = "enough_data" if statuses == {"enough_data"} else (
        "unavailable" if statuses == {"unavailable"} else "insufficient_evidence"
    )
    return {
        "label": label,
        "status": status,
        "reason": "" if status == "enough_data" else "one or more period metrics lack comparable evidence",
        "current": {
            "start": current_start.date().isoformat(),
            "end_exclusive": end.date().isoformat(),
            "days": days,
        },
        "baseline": {
            "start": baseline_start.date().isoformat(),
            "end_exclusive": current_start.date().isoformat(),
            "days": days,
        },
        "calendar_period": calendar_period,
        "metrics": metrics,
        "outcomes": _operational_outcomes(
            cases,
            feedback,
            current_quality,
            baseline_quality,
            baseline_start=baseline_start,
            current_start=current_start,
            end=end,
            current_days=days,
            baseline_days=days,
            cases_truncated=truncated,
            usage_records=usage_records,
            usage_available=usage_available,
            usage_records_truncated=usage_records_truncated,
            noise_comparison=noise_comparison,
            tuning_records=tuning_records,
            tuning_available=tuning_available,
            tuning_records_truncated=tuning_records_truncated,
        ),
    }


def agent_improvement_metrics(
    cases: list[Case],
    *,
    as_of: date | None = None,
    current_days: int = 7,
    baseline_days: int = 28,
    now: datetime | None = None,
    store_total: int | None = None,
    synthetic: bool = False,
    usage_records: list[dict[str, Any]] | None = None,
    usage_available: bool = False,
    usage_records_truncated: bool = False,
    noise_comparison: dict[str, Any] | None = None,
    period_noise_comparisons: dict[str, dict[str, Any]] | None = None,
    tuning_records: list[dict[str, Any]] | None = None,
    tuning_available: bool = False,
    tuning_records_truncated: bool = False,
) -> dict[str, Any]:
    """Aggregate evidence for daily agent-effectiveness reporting.

    ``as_of`` is the exclusive UTC date boundary.  For example, ``2026-07-27``
    includes complete days through July 26 and never mixes a partial current day into
    a complete historical baseline.
    """
    current_days = max(1, int(current_days))
    baseline_days = max(1, int(baseline_days))
    reference_now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    end = _window_end(as_of, reference_now)
    current_start = end - timedelta(days=current_days)
    baseline_start = current_start - timedelta(days=baseline_days)

    feedback, feedback_excluded = _select_feedback(
        cases, start=baseline_start, end=end
    )
    turnaround, turnaround_excluded = _turnaround_samples(
        cases, start=baseline_start, end=end
    )
    current_feedback = [s for s in feedback if _in_window(s.at, current_start, end)]
    baseline_feedback = [s for s in feedback if _in_window(s.at, baseline_start, current_start)]
    current_turnaround = [s for s in turnaround if _in_window(s.at, current_start, end)]
    baseline_turnaround = [s for s in turnaround if _in_window(s.at, baseline_start, current_start)]

    current_quality = _quality_summary(current_feedback)
    baseline_quality = _quality_summary(baseline_feedback)
    current_handling = _turnaround_summary(current_turnaround)
    baseline_handling = _turnaround_summary(baseline_turnaround)
    mix = _mix_adjusted(current_feedback, baseline_feedback)

    adjusted_current_agreement = mix["adjusted_current_agreement"]
    adjusted_baseline_agreement = mix["adjusted_baseline_agreement"]
    adjusted_current_correction = mix["adjusted_current_correction_rate"]
    adjusted_baseline_correction = mix["adjusted_baseline_correction_rate"]
    agreement_delta = (
        round(adjusted_current_agreement - adjusted_baseline_agreement, 4)
        if adjusted_current_agreement is not None
        and adjusted_baseline_agreement is not None
        else None
    )
    correction_delta = (
        round(adjusted_current_correction - adjusted_baseline_correction, 4)
        if adjusted_current_correction is not None
        and adjusted_baseline_correction is not None
        else None
    )
    turnaround_delta = (
        round(
            (current_handling["p50_minutes"] - baseline_handling["p50_minutes"])
            / baseline_handling["p50_minutes"],
            4,
        )
        if current_handling["p50_minutes"] is not None
        and baseline_handling["p50_minutes"] not in (None, 0)
        else None
    )

    marker = truncation_marker(len(cases), store_total)
    mix_coverage = mix["comparable_mix_coverage"]
    quality_ready = (
        mix["current_covered"] >= _QUALITY_MIN
        and mix["baseline_covered"] >= _QUALITY_MIN
        and mix_coverage is not None
        and mix_coverage >= _MIX_MIN_COVERAGE
    )
    handling_ready = (
        current_handling["sample_count"] >= _TURNAROUND_MIN
        and baseline_handling["sample_count"] >= _TURNAROUND_MIN
    )
    agreement_direction = (
        _direction(agreement_delta, threshold=0.03, good="up")
        if quality_ready and not marker["truncated"]
        else "insufficient_evidence"
    )
    correction_direction = (
        _direction(correction_delta, threshold=0.03, good="down")
        if quality_ready and not marker["truncated"]
        else "insufficient_evidence"
    )
    turnaround_direction = (
        _direction(turnaround_delta, threshold=0.10, good="down")
        if handling_ready and not marker["truncated"]
        else "insufficient_evidence"
    )

    current_reopens = _agent_reopen_summary(
        cases,
        start=current_start,
        end=end,
        observed_through=end,
    )
    baseline_reopens = _agent_reopen_summary(
        cases,
        start=baseline_start,
        end=current_start,
        observed_through=end,
    )
    false_negative_ready = (
        current_quality["confirmed_positive_count"] >= _GUARDRAIL_MIN
        and baseline_quality["confirmed_positive_count"] >= _GUARDRAIL_MIN
    )
    reopen_applicable = bool(
        current_reopens["candidate_agent_terminal_decisions"]
        or baseline_reopens["candidate_agent_terminal_decisions"]
    )
    reopen_ready = not reopen_applicable or (
        current_reopens["eligible_agent_terminal_decisions"] >= _GUARDRAIL_MIN
        and baseline_reopens["eligible_agent_terminal_decisions"] >= _GUARDRAIL_MIN
    )
    guardrails_ready = false_negative_ready and reopen_ready
    false_negative_breach = (
        current_quality["false_negative_rate"]
        > baseline_quality["false_negative_rate"] + 0.01
        if false_negative_ready
        and current_quality["false_negative_rate"] is not None
        and baseline_quality["false_negative_rate"] is not None
        else None
    )
    reopen_breach = (
        current_reopens["rate"] > baseline_reopens["rate"] + 0.02
        if reopen_applicable
        and reopen_ready
        and current_reopens["rate"] is not None
        and baseline_reopens["rate"] is not None
        else None
    )

    # Agreement and correction are two views over the same analyst-grade cohort.
    # Treat them as one independent quality domain so correlated movement cannot,
    # by itself, promote the headline to "improving".
    quality_directions = [agreement_direction, correction_direction]
    if "insufficient_evidence" in quality_directions:
        quality_domain_direction = "insufficient_evidence"
    elif "regressing" in quality_directions:
        quality_domain_direction = "regressing"
    elif "improving" in quality_directions:
        quality_domain_direction = "improving"
    else:
        quality_domain_direction = "stable"
    domain_directions = [quality_domain_direction, turnaround_direction]
    if (
        marker["truncated"]
        or not quality_ready
        or not handling_ready
        or not guardrails_ready
    ):
        headline_state = "insufficient_evidence"
        headline_reason = (
            "Complete comparable cohorts and evaluable safety guardrails are required "
            "before declaring improvement."
        )
    elif bool(false_negative_breach) or bool(reopen_breach):
        headline_state = "guardrail_breach"
        headline_reason = "A safety guardrail regressed, so favorable efficiency shifts are not promoted."
    elif domain_directions.count("improving") == 2:
        headline_state = "improving"
        headline_reason = "Both independent quality and review-turnaround domains improved."
    elif domain_directions.count("improving") == 0 and domain_directions.count("regressing") == 0:
        headline_state = "stable"
        headline_reason = "Neither independent domain moved beyond its material-change threshold."
    else:
        headline_state = "mixed"
        headline_reason = "The signals moved in different directions; review the cohorts and guardrails."

    exclusions = Counter(feedback_excluded)
    exclusions.update(turnaround_excluded)

    outcomes = _operational_outcomes(
        cases,
        feedback,
        current_quality,
        baseline_quality,
        baseline_start=baseline_start,
        current_start=current_start,
        end=end,
        current_days=current_days,
        baseline_days=baseline_days,
        cases_truncated=bool(marker["truncated"]),
        usage_records=usage_records,
        usage_available=usage_available,
        usage_records_truncated=usage_records_truncated,
        noise_comparison=noise_comparison,
        tuning_records=tuning_records,
        tuning_available=tuning_available,
        tuning_records_truncated=tuning_records_truncated,
    )

    return {
        "generated_at": reference_now.isoformat(),
        "synthetic": bool(synthetic),
        "windows": {
            "as_of_exclusive": end.date().isoformat(),
            "current": {
                "start": current_start.date().isoformat(),
                "end_exclusive": end.date().isoformat(),
                "days": current_days,
            },
            "baseline": {
                "start": baseline_start.date().isoformat(),
                "end_exclusive": current_start.date().isoformat(),
                "days": baseline_days,
            },
            "timezone": "UTC",
            "complete_days_only": True,
        },
        "headline": {
            "state": headline_state,
            "reason": headline_reason,
            "improving_signals": domain_directions.count("improving"),
            "regressing_signals": domain_directions.count("regressing"),
            "signal_domains": {
                "analyst_grade_quality": quality_domain_direction,
                "human_review_turnaround": turnaround_direction,
            },
            "guardrails_ready": guardrails_ready,
            "comparable_mix_coverage": mix_coverage,
            "minimum_comparable_mix_coverage": _MIX_MIN_COVERAGE,
            "composite_score": None,
        },
        "metrics": {
            "analyst_reported_verdict_agreement": {
                "label": "Analyst-reported verdict agreement",
                "unit": "ratio",
                "good_direction": "up",
                "current": {
                    **_comparison_measurement(
                        adjusted_current_agreement,
                        mix["current_covered"],
                        _QUALITY_MIN,
                        comparison_ready=quality_ready,
                    ),
                    "unadjusted_value": current_quality["agreement"],
                    "total_graded_cases": current_quality["sample_count"],
                    "comparable_graded_cases": mix["current_covered"],
                    "feedback_counts": {
                        "agree": current_quality["agree"],
                        "partial": current_quality["partial"],
                        "disagree": current_quality["disagree"],
                    },
                },
                "baseline": {
                    **_comparison_measurement(
                        adjusted_baseline_agreement,
                        mix["baseline_covered"],
                        _QUALITY_MIN,
                        comparison_ready=quality_ready,
                    ),
                    "unadjusted_value": baseline_quality["agreement"],
                    "total_graded_cases": baseline_quality["sample_count"],
                    "comparable_graded_cases": mix["baseline_covered"],
                    "feedback_counts": {
                        "agree": baseline_quality["agree"],
                        "partial": baseline_quality["partial"],
                        "disagree": baseline_quality["disagree"],
                    },
                },
                "delta": {
                    "percentage_points": (
                        round(agreement_delta * 100, 2)
                        if agreement_delta is not None
                        else None
                    )
                },
                "direction": agreement_direction,
                "definition": {
                    "formula": "(agree + 0.5 × partial) / unique latest-valid graded cases",
                    "numerator": "Agreed cases plus half-weighted partial agreements.",
                    "denominator": (
                        "Unique cases in source-by-severity strata represented by at "
                        "least five grades in both windows."
                    ),
                    "eligibility": (
                        "Valid timestamp and assessment; later grades supersede earlier "
                        "grades, and both windows use identical reference weights."
                    ),
                    "caveats": (
                        "Feedback is analyst-reported; this measures alignment, not "
                        "incident recall, authenticated reviewer provenance, or causation."
                    ),
                },
            },
            "material_analyst_correction_rate": {
                "label": "Material analyst correction rate",
                "unit": "ratio",
                "good_direction": "down",
                "current": {
                    **_comparison_measurement(
                        adjusted_current_correction,
                        mix["current_covered"],
                        _QUALITY_MIN,
                        comparison_ready=quality_ready,
                    ),
                    "unadjusted_value": current_quality["correction_rate"],
                    "total_graded_cases": current_quality["sample_count"],
                    "comparable_graded_cases": mix["current_covered"],
                    "material_corrections": current_quality["material_corrections"],
                },
                "baseline": {
                    **_comparison_measurement(
                        adjusted_baseline_correction,
                        mix["baseline_covered"],
                        _QUALITY_MIN,
                        comparison_ready=quality_ready,
                    ),
                    "unadjusted_value": baseline_quality["correction_rate"],
                    "total_graded_cases": baseline_quality["sample_count"],
                    "comparable_graded_cases": mix["baseline_covered"],
                    "material_corrections": baseline_quality["material_corrections"],
                },
                "delta": {
                    "percentage_points": (
                        round(correction_delta * 100, 2)
                        if correction_delta is not None
                        else None
                    )
                },
                "direction": correction_direction,
                "definition": {
                    "formula": "materially corrected cases / unique latest-valid graded cases",
                    "numerator": "Explicit disagreements or allow-listed AI-verdict/outcome conflicts.",
                    "denominator": "The same comparable, identically weighted cohort as agreement.",
                    "eligibility": "Partial feedback is reported separately and is not automatically a correction.",
                    "caveats": "NEEDS_HUMAN has no inferred outcome conflict; only explicit disagreement counts.",
                },
            },
            "human_review_turnaround": {
                "label": "Human review turnaround",
                "unit": "minutes",
                "good_direction": "down",
                "current": {
                    **_measurement(current_handling["p50_minutes"], current_handling["sample_count"], _TURNAROUND_MIN),
                    **current_handling,
                },
                "baseline": {
                    **_measurement(baseline_handling["p50_minutes"], baseline_handling["sample_count"], _TURNAROUND_MIN),
                    **baseline_handling,
                },
                "delta": {"relative": turnaround_delta},
                "direction": turnaround_direction,
                "definition": {
                    "formula": "p50(final human terminal transition − first human acknowledgement in final live episode)",
                    "numerator": "Elapsed human review intervals, attributed to the terminal UTC day.",
                    "denominator": "Terminal cases whose actor labels are not in the known automation set and that include an acknowledgement.",
                    "eligibility": "Direct closes, known automatic transitions, malformed timestamps, and incomplete episodes are excluded.",
                    "caveats": (
                        "This is elapsed turnaround, not active analyst touch time; "
                        "actor values are operational labels rather than authenticated "
                        "identity provenance, and pause/resume work sessions are not recorded."
                    ),
                },
            },
        },
        "outcomes": outcomes,
        "period_comparisons": {
            "week_over_week": _period_comparison(
                cases,
                end=end,
                days=7,
                label="Week over week",
                truncated=bool(marker["truncated"]),
                calendar_period=False,
                usage_records=usage_records,
                usage_available=usage_available,
                usage_records_truncated=usage_records_truncated,
                noise_comparison=(period_noise_comparisons or {}).get("week_over_week"),
                tuning_records=tuning_records,
                tuning_available=tuning_available,
                tuning_records_truncated=tuning_records_truncated,
            ),
            "month_over_month": _period_comparison(
                cases,
                end=end,
                days=28,
                label="Rolling 28 days over prior 28 days",
                truncated=bool(marker["truncated"]),
                calendar_period=False,
                usage_records=usage_records,
                usage_available=usage_available,
                usage_records_truncated=usage_records_truncated,
                noise_comparison=(period_noise_comparisons or {}).get("month_over_month"),
                tuning_records=tuning_records,
                tuning_available=tuning_available,
                tuning_records_truncated=tuning_records_truncated,
            ),
        },
        "guardrails": {
            "confirmed_false_negative_rate": {
                "status": (
                    "enough_data"
                    if false_negative_ready
                    else (
                        "unavailable"
                        if not current_quality["confirmed_positive_count"]
                        and not baseline_quality["confirmed_positive_count"]
                        else "insufficient_evidence"
                    )
                ),
                "minimum_sample": _GUARDRAIL_MIN,
                "current": {
                    "value": current_quality["false_negative_rate"],
                    "confirmed_positive_count": current_quality[
                        "confirmed_positive_count"
                    ],
                    "missed_positive_count": current_quality["false_negatives"],
                },
                "baseline": {
                    "value": baseline_quality["false_negative_rate"],
                    "confirmed_positive_count": baseline_quality[
                        "confirmed_positive_count"
                    ],
                    "missed_positive_count": baseline_quality["false_negatives"],
                },
                "material_increase_threshold": 0.01,
                "breached": false_negative_breach,
                "definition": (
                    "Missed confirmed positives / confirmed positives. A miss is an "
                    "explicit false_negative outcome or an AI FALSE_POSITIVE later "
                    "confirmed true positive."
                ),
            },
            "reopen_after_agent_close_rate": {
                "status": (
                    "not_applicable"
                    if not reopen_applicable
                    else "enough_data" if reopen_ready else "insufficient_evidence"
                ),
                "minimum_sample": _GUARDRAIL_MIN,
                "current": current_reopens,
                "baseline": baseline_reopens,
                "material_increase_threshold": 0.02,
                "breached": reopen_breach,
                "caveat": (
                    "Only explicit agent terminal transitions with a complete 24-hour "
                    "follow-up window are eligible; only human reopens inside that "
                    "window count."
                ),
            },
        },
        "case_mix": mix,
        "daily_points": _daily_points(
            feedback,
            turnaround,
            start=baseline_start,
            current_start=current_start,
            end=end,
        ),
        "exclusions": dict(exclusions),
        "provenance": {
            **marker,
            "aggregate_only": True,
            "case_ids_included": False,
            "billing": "none",
            "decision_authority": "reporting_only",
        },
    }
