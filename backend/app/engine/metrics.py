"""Deterministic metrics/analytics over the suite's own cases (SOC dashboards).

Pure aggregation functions over a list of ``Case`` objects (plus the existing
usage/cost ledger summary, merged by the route). No new storage, no LLM — these
power the analytics UI: verdict mix, status breakdown, persona/playbook usage,
average risk, a coarse MTTR, a per-day case trend, and the AI-decision feedback
quality roll-up. Everything is defensive: malformed timestamps are skipped, never
raised, so a dashboard query can't fail a request.

It also carries the two OBSERVABILITY signals that exist so a silent triage outage
cannot stay silent: :func:`auto_close_health` (a rolling auto-close rate with enough
context to tell "auto-close collapsed" from "nobody sent us any work") and
:func:`precedent_ground_truth` (how much analyst-confirmed ground truth the case
history actually holds). Both are read-time derivations and are NEVER read by
``case_manager.decide()`` (#3).
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from ..constants import CaseStatus, DecisionBy, TERMINAL_CASE_STATUSES, Verdict
from ..models import Case
from .analyst_outcomes import analyst_confirmed_outcome
from .precedent import is_policy_closed

# A labelled placeholder for a metric that could not be computed because the
# underlying transition / event never occurred (rather than a misleading 0). The UI
# renders the dash; the ``reason`` field says WHY. Reused everywhere honesty matters.
DASH = "—"


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        s = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _as_dt(value: Any) -> datetime | None:
    """Coerce either a datetime (the Wave-0 lifecycle anchors) or an ISO string
    (created_at/updated_at/history timestamps) to an aware UTC datetime, or None."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        return _parse_iso(value)
    return None


def percentile(values: list[float], pct: float) -> float | None:
    """Linear-interpolated percentile over ``values`` (stdlib only, no numpy).

    ``pct`` is in [0, 100]. Returns None for an empty list (the caller renders DASH).
    Deterministic; matches the common "linear interpolation between closest ranks"
    method so p50 of an even count is the mean of the two middle values."""
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    if n == 1:
        return float(ordered[0])
    rank = (max(0.0, min(100.0, pct)) / 100.0) * (n - 1)
    lo = int(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * frac)


def _stat_block(samples: list[float], *, missing_reason: str) -> dict[str, Any]:
    """A p50/p90/mean/count summary block. When ``samples`` is empty the numeric
    fields are the labelled DASH and ``reason`` explains why (honest, never a fake 0)."""
    if not samples:
        return {
            "p50": DASH, "p90": DASH, "mean": DASH, "max": DASH, "count": 0,
            "available": False, "reason": missing_reason,
        }
    return {
        "p50": round(percentile(samples, 50) or 0.0, 1),
        "p90": round(percentile(samples, 90) or 0.0, 1),
        "mean": round(sum(samples) / len(samples), 1),
        "max": round(max(samples), 1),
        "count": len(samples),
        "available": True,
        "reason": "",
    }


def feedback_stats(cases: list[Case]) -> dict:
    """Aggregate analyst feedback across cases (the eval/quality loop).

    Excludes cases closed by an operator's analyst RULE POLICY: no model produced a
    verdict on them, so an analyst disagreeing (or agreeing) with a judgement that was
    never made says nothing about the agent's quality. The grade itself is still real
    ground truth and is counted as such by the tuner and the precedent projection — it
    is only this AGREEMENT-WITH-THE-AGENT view it must stay out of.
    """
    cases = [c for c in cases if not is_policy_closed(c)]
    entries = [fb for c in cases for fb in (c.feedback or [])]
    graded_cases = sum(1 for c in cases if c.feedback)
    if not entries:
        return {
            "graded_cases": 0, "feedback_count": 0, "agreement_rate": 0.0,
            "avg_accuracy": 0.0, "avg_reasoning_quality": 0.0,
            "avg_action_appropriateness": 0.0, "time_saved_minutes": 0,
            "outcome_distribution": {},
        }
    n = len(entries)
    agree = sum(1 for e in entries if e.assessment == "agree")
    partial = sum(0.5 for e in entries if e.assessment == "partial")
    return {
        "graded_cases": graded_cases,
        "feedback_count": n,
        "agreement_rate": round((agree + partial) / n, 4),
        "avg_accuracy": round(sum(e.accuracy for e in entries) / n, 4),
        "avg_reasoning_quality": round(sum(e.reasoning_quality for e in entries) / n, 4),
        "avg_action_appropriateness": round(sum(e.action_appropriateness for e in entries) / n, 4),
        "time_saved_minutes": int(sum(e.time_saved_minutes for e in entries)),
        "outcome_distribution": dict(Counter(e.actual_outcome for e in entries if e.actual_outcome)),
    }


def retrieval_history(
    cases: list[Case], *, total_cases: int | None = None
) -> dict[str, Any]:
    """Honest case-level knowledge-reference coverage.

    This is *not* retrieval quality and it is not a per-run hit rate.  The Case field
    is cumulative, de-duplicated, and bounded, so the only supportable question is:
    among fully instrumented investigated cases with a completed retrieval attempt,
    how many ever recorded at least one reference?

    Any historically unavailable case or truncated store read makes the headline
    value unavailable.  A missing observation is never folded into the denominator;
    only the explicit observation marker proves a completed attempt.  The knowledge
    list intentionally retains its backwards-compatible array shape, so list presence
    by itself carries no measurement meaning.
    """

    loaded_cases = len(cases)
    truncated = total_cases is not None and total_cases > loaded_cases
    eligible = [case for case in cases if case.verdict is not None]
    history_available = [
        case for case in eligible if case.retrieval_history_status == "available"
    ]
    history_unavailable = len(eligible) - len(history_available)
    completed = [
        case
        for case in history_available
        if case.retrieval_observation_status == "measured"
    ]

    base: dict[str, Any] = {
        "status": "unavailable",
        "available": False,
        "reason": "",
        "loaded_cases": loaded_cases,
        "total_cases": total_cases if total_cases is not None else loaded_cases,
        "truncated": truncated,
        "eligible_cases": len(eligible),
        "history_available_cases": len(history_available),
        "history_unavailable_cases": history_unavailable,
        "completed_attempt_cases": len(completed),
        "cases_with_references": None,
        "reference_coverage": None,
        "formula": (
            "cases with at least one recorded reference / cases with at least one "
            "completed retrieval attempt"
        ),
    }
    if truncated:
        base["reason"] = (
            f"Only {loaded_cases} of {total_cases} cases were loaded; retrieval "
            "coverage is unavailable for a truncated cohort."
        )
        return base
    if not eligible:
        base.update({
            "status": "insufficient_evidence",
            "reason": "No investigated cases are available for retrieval coverage.",
        })
        return base
    if history_unavailable:
        base["reason"] = (
            f"{history_unavailable} investigated case(s) have unavailable historical "
            "retrieval instrumentation; missing history is excluded, never counted as zero."
        )
        return base
    if not completed:
        base.update({
            "status": "insufficient_evidence",
            "reason": "No fully instrumented case has a completed retrieval attempt.",
        })
        return base

    with_references = sum(1 for case in completed if case.knowledge_used)
    base.update({
        "status": "available",
        "available": True,
        "reason": "",
        "cases_with_references": with_references,
        "reference_coverage": round(with_references / len(completed), 4),
    })
    return base


def compute_metrics(
    cases: list[Case], *, trend_days: int = 14, total_cases: int | None = None
) -> dict:
    """Case analytics for the dashboard. Pure; deterministic given the inputs."""
    total = len(cases)
    by_status = Counter((c.status.value if c.status else "unknown") for c in cases)
    by_verdict = Counter((c.verdict.value if c.verdict else "none") for c in cases)
    by_disposition = Counter(
        (c.disposition.value if getattr(c, "disposition", None) else "undetermined") for c in cases
    )
    by_persona = Counter((c.agent_persona or "generalist") for c in cases)
    by_playbook = Counter((c.playbook_id or "none") for c in cases)

    risks = [c.risk_score for c in cases if isinstance(c.risk_score, (int, float))]
    avg_risk = round(sum(risks) / len(risks), 1) if risks else 0.0

    # Active Risk Index: the mean deterministic risk_score over LIVE (non-terminal)
    # cases only — the single "how hot is the board right now?" instrument (the UI's
    # ActiveRiskIndex gauge reads this). Terminal (resolved/closed) cases are excluded
    # so a pile of cleared low-risk cases can't drag the headline down. 0.0 when the
    # board is empty (honest zero, not a divide-by-zero).
    active_risks = [
        c.risk_score
        for c in cases
        if isinstance(c.risk_score, (int, float))
        and (c.status.value if c.status else "") not in TERMINAL_CASE_STATUSES
    ]
    active_risk_index = round(sum(active_risks) / len(active_risks), 1) if active_risks else 0.0
    active_risk_case_count = len(active_risks)

    # Coarse MTTR: resolution latency of CLOSED cases (updated_at - created_at).
    resolution_minutes: list[float] = []
    for c in cases:
        if c.status == CaseStatus.CLOSED:
            start, end = _parse_iso(c.created_at), _parse_iso(c.updated_at)
            if start and end and end >= start:
                resolution_minutes.append((end - start).total_seconds() / 60.0)
    mttr = round(sum(resolution_minutes) / len(resolution_minutes), 1) if resolution_minutes else 0.0

    # Per-day created trend (UTC date buckets) for the last ``trend_days`` days.
    day_counts: Counter[str] = Counter()
    resolved_by_day: Counter[str] = Counter()
    for c in cases:
        dt = _parse_iso(c.created_at)
        if dt:
            day_counts[dt.date().isoformat()] += 1
        rdt = _resolved_dt(c)
        if rdt:
            resolved_by_day[rdt.date().isoformat()] += 1
    trend = sorted(day_counts.items())[-trend_days:]

    # Burndown: opened-vs-resolved per UTC day (the union of days with either kind of
    # activity, most-recent ``trend_days``). Powers the open-vs-resolved BurnDownChart.
    burndown_days = sorted(set(day_counts) | set(resolved_by_day))[-trend_days:]
    burndown = [
        {"date": d, "opened": day_counts.get(d, 0), "resolved": resolved_by_day.get(d, 0)}
        for d in burndown_days
    ]

    return {
        "total_cases": total,
        "open_cases": by_status.get(CaseStatus.OPEN.value, 0),
        "needs_human_cases": by_status.get(CaseStatus.NEEDS_HUMAN.value, 0),
        "closed_cases": by_status.get(CaseStatus.CLOSED.value, 0),
        "by_status": dict(by_status),
        "by_disposition": dict(by_disposition),
        "by_verdict": {
            "TRUE_POSITIVE": by_verdict.get(Verdict.TRUE_POSITIVE.value, 0),
            "FALSE_POSITIVE": by_verdict.get(Verdict.FALSE_POSITIVE.value, 0),
            "NEEDS_HUMAN": by_verdict.get(Verdict.NEEDS_HUMAN.value, 0),
            "none": by_verdict.get("none", 0),
        },
        "persona_usage": dict(by_persona),
        "playbook_usage": dict(by_playbook),
        "avg_risk_score": avg_risk,
        "active_risk_index": active_risk_index,
        "active_risk_case_count": active_risk_case_count,
        "mttr_minutes": mttr,
        "resolved_count": len(resolution_minutes),
        "cases_per_day": [{"date": d, "count": n} for d, n in trend],
        "burndown": burndown,
        "timing_trend": timing_trend(cases, trend_days=trend_days),
        "feedback": feedback_stats(cases),
        "retrieval_history": retrieval_history(cases, total_cases=total_cases),
    }


# --------------------------------------------------------------------------- #
# Richer security-posture metrics (Round 3 / Feature 5). All PURE + deterministic
# over a (time-bounded) list of Cases. None of these is ever read by
# ``case_manager.decide()`` (#3) — they are read-time reporting derived from the
# verdict / status_history / lifecycle timestamps the deterministic decision already
# produced. ⚠ Advisory severity/impact/priority bands are display/aggregation only;
# we NEVER feed them back into a decision.
# --------------------------------------------------------------------------- #

# Lifecycle statuses that mark a case as ACKNOWLEDGED (a human has it) and as having
# received a FIRST RESPONSE (active work / a decision). Derived from status_history
# transitions, not from the advisory bands.
_ACK_STATUSES = frozenset(
    {CaseStatus.INVESTIGATING.value, CaseStatus.ESCALATED.value, CaseStatus.ON_HOLD.value}
)
_RESPONSE_STATUSES = frozenset(
    {
        CaseStatus.INVESTIGATING.value, CaseStatus.ESCALATED.value, CaseStatus.ON_HOLD.value,
        CaseStatus.RESOLVED.value, CaseStatus.CLOSED.value,
    }
)
_TERMINAL = frozenset(TERMINAL_CASE_STATUSES)


# Non-human transition authors (DecisionBy). A transition whose ``by`` is one of these
# is a deterministic/agent action, NOT a human acknowledgment/response — the autopilot
# risk gate auto-escalates at case creation with by="system"/"agent" (audit #9).
_NONHUMAN_ACTORS = frozenset({"system", "agent", DecisionBy.ANALYST_POLICY.value})


def _first_transition_at(
    case: Case, to_statuses: frozenset[str], *, by_human: bool = False
) -> datetime | None:
    """The earliest timestamp at which this case transitioned INTO any of
    ``to_statuses`` (from its append-only ``status_history``). None if it never did.

    ``by_human`` skips transitions authored by ``system``/``agent`` (the deterministic
    routing / AI auto-actions) so an autopilot auto-escalation at creation is NOT counted
    as a human acknowledgment/response — which would fabricate a ~0-minute MTTA and false
    SLA attainment (audit #9). A genuine human ESCALATED transition still counts."""
    best: datetime | None = None
    for entry in case.status_history or []:
        if (entry.to_status or "") not in to_statuses:
            continue
        if by_human and (entry.by or "").strip().lower() in _NONHUMAN_ACTORS:
            continue
        dt = _parse_iso(entry.at)
        if dt and (best is None or dt < best):
            best = dt
    return best


def _created_dt(case: Case) -> datetime | None:
    # Prefer the explicit detection instant when populated, else creation time.
    return _as_dt(case.detected_at) or _parse_iso(case.created_at)


def _resolved_dt(case: Case) -> datetime | None:
    """The instant a case became TERMINAL (RESOLVED/CLOSED), else None when the case is
    currently open. A currently NON-terminal case is never counted as resolved — even if
    it was closed and later REOPENED: ``status_history`` is append-only, so a stale
    terminal transition lingers, and without the current-status guard a reopened (now-open)
    case would wrongly count as resolved and corrupt the burndown net-backlog + the resolve
    trend. Advisory/reporting only — never read by ``decide()`` (#3)."""
    if (case.status.value if case.status else "") not in _TERMINAL:
        return None
    end = _first_transition_at(case, _TERMINAL)
    if end is not None:
        return end
    return _parse_iso(case.updated_at)  # terminal but no recorded transition


def lifecycle_intervals(cases: list[Case]) -> dict[str, Any]:
    """MTTA / MTTR / dwell as p50+p90+mean over the case set.

    * **MTTA** (time-to-acknowledge): created → first ACK transition (or the
      ``acknowledged_at`` anchor when present).
    * **MTTR** (time-to-resolve): created → first terminal (RESOLVED/CLOSED)
      transition (or ``updated_at`` for an already-terminal case lacking history).
    * **dwell** (time-to-first-response): created → first RESPONSE transition (or
      the ``first_response_at`` anchor).

    Each is a ``_stat_block``; when NO case ever made the transition the block is a
    labelled DASH with a reason (honest — never a fake 0).

    * **MTTD** (time-to-detect / detection latency): the cluster's first member event
      (``first_seen_millis``) → case-open (``created_at``). Only counted for cases that
      carry a ``first_seen_millis > 0`` AND whose ``created_at`` is at/after it (a
      backdated event can't yield a negative latency); otherwise the case is skipped so
      an un-timed case can't fake a 0.

    The webui renders the intervals under the honest labels + formula help in
    ``webui/src/soc/pages/posture.format.ts`` (``LIFECYCLE_METRICS``). NOTE (#3): none of
    these is EVER read by ``case_manager.decide()`` — they are read-time reporting only.
    MTTD is now a real detection-latency measurement (we store the first-event instant on
    the case); dwell remains time-to-first-response (a distinct human-response metric)."""
    mtta: list[float] = []
    mttr: list[float] = []
    dwell: list[float] = []
    mttd: list[float] = []

    for case in cases:
        # MTTD is measured from ``created_at`` (case-open), independent of the
        # ack/response clocks, so a case with no ack/response still contributes a
        # detection-latency sample. Computed first, before the ``start`` guard.
        fs = getattr(case, "first_seen_millis", 0) or 0
        if isinstance(fs, (int, float)) and fs > 0:
            created = _parse_iso(case.created_at)
            if created is not None:
                created_ms = created.timestamp() * 1000.0
                if created_ms >= fs:
                    mttd.append((created_ms - fs) / 60000.0)

        start = _created_dt(case)
        if start is None:
            continue

        ack = _as_dt(case.acknowledged_at) or _first_transition_at(case, _ACK_STATUSES, by_human=True)
        if ack and ack >= start:
            mtta.append((ack - start).total_seconds() / 60.0)

        resp = _as_dt(case.first_response_at) or _first_transition_at(case, _RESPONSE_STATUSES, by_human=True)
        if resp and resp >= start:
            dwell.append((resp - start).total_seconds() / 60.0)

        end = _resolved_dt(case)  # guarded: a reopened (currently-open) case isn't resolved
        if end and end >= start:
            mttr.append((end - start).total_seconds() / 60.0)

    return {
        "mtta_minutes": _stat_block(mtta, missing_reason="no case has been acknowledged yet"),
        "mttr_minutes": _stat_block(mttr, missing_reason="no case has been resolved/closed yet"),
        "dwell_minutes": _stat_block(dwell, missing_reason="no case has received a first response yet"),
        "mttd_minutes": _stat_block(mttd, missing_reason="detection latency not available yet"),
    }


def timing_trend(cases: list[Case], *, trend_days: int = 14) -> list[dict[str, Any]]:
    """Per-UTC-day mean detection / response / resolution latency (minutes) for the
    "Mean time to detect / respond" trend chart. Pure + deterministic; advisory (#3).

    Each sample is attributed to the day its interval COMPLETED:

    * ``mttd``  — detection latency (first event → case-open), on the OPEN day.
    * ``respond`` — time to the first HUMAN response (created → first acknowledge /
      start-investigating / escalate — the ACK clock, which EXCLUDES an AI auto-close), on
      the response day. NOT the ``dwell`` metric (that counts RESOLVED/CLOSED as a response).
    * ``resolve`` — time-to-resolution (created → terminal), on the RESOLUTION day.

    A day with NO sample for a given series emits ``null`` for that series (never a
    fabricated 0). Only the most-recent ``trend_days`` populated day buckets are kept."""
    mttd_by_day: dict[str, list[float]] = {}
    resp_by_day: dict[str, list[float]] = {}
    res_by_day: dict[str, list[float]] = {}

    def _push(bucket: dict[str, list[float]], day: str, value: float) -> None:
        bucket.setdefault(day, []).append(value)

    for case in cases:
        created = _parse_iso(case.created_at)
        fs = getattr(case, "first_seen_millis", 0) or 0
        if created is not None and isinstance(fs, (int, float)) and fs > 0:
            created_ms = created.timestamp() * 1000.0
            if created_ms >= fs:
                _push(mttd_by_day, created.date().isoformat(), (created_ms - fs) / 60000.0)

        start = _created_dt(case)
        if start is None:
            continue

        # `respond` = the first HUMAN response, so use the ACK clock (human-only). Using
        # dwell/_RESPONSE_STATUSES here would count an AI auto-close as a "response" and
        # fabricate a human-response time — the dashboard's "Mean time to respond" must be honest.
        ack = _as_dt(case.acknowledged_at) or _first_transition_at(case, _ACK_STATUSES, by_human=True)
        if ack and ack >= start:
            _push(resp_by_day, ack.date().isoformat(), (ack - start).total_seconds() / 60.0)

        end = _resolved_dt(case)
        if end and end >= start:
            _push(res_by_day, end.date().isoformat(), (end - start).total_seconds() / 60.0)

    def _mean(vals: list[float]) -> float | None:
        return round(sum(vals) / len(vals), 1) if vals else None

    days = sorted(set(mttd_by_day) | set(resp_by_day) | set(res_by_day))[-max(0, trend_days):]
    return [
        {
            "date": d,
            "mttd": _mean(mttd_by_day.get(d, [])),
            "respond": _mean(resp_by_day.get(d, [])),
            "resolve": _mean(res_by_day.get(d, [])),
        }
        for d in days
    ]


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def quality_metrics(cases: list[Case]) -> dict[str, Any]:
    """Triage-quality rates COUNTED from observed verdict / status_history /
    decision_by — never *decided* here. All are pure tallies (#3 untouched).

    * ``alert_to_incident_ratio`` — TRUE_POSITIVE cases / total (incident yield).
    * ``false_positive_rate`` — FALSE_POSITIVE cases / verdicted cases.
    * ``escalation_rate`` — cases that ever entered ESCALATED / total.
    * ``containment_rate`` — terminal cases / total (worked to completion).
    * ``automation_rate`` — cases whose terminal decision was made by the AGENT
      (``decision_by == agent``) / terminal cases (deterministic auto-close share).
    * ``policy_closed_cases`` — cases closed by an operator's analyst RULE POLICY.
      Reported separately and EXCLUDED from every rate above: no model ran on them, so
      they are neither agent success nor agent failure.
    """
    # A case closed by an operator's analyst RULE POLICY never reached the agent: no
    # model ran, no verdict exists, and no investigation was attempted. Counting it
    # would distort every rate below in both directions (it would deflate
    # ``automation_rate`` by joining its denominator, and inflate ``containment_rate``
    # by looking like worked-to-completion volume), so it is excluded from the agent's
    # measured performance entirely and reported as its own explicit count instead.
    policy_closed = [c for c in cases if is_policy_closed(c)]
    cases = [c for c in cases if not is_policy_closed(c)]
    total = len(cases)
    verdicted = sum(1 for c in cases if c.verdict is not None)
    tp = sum(1 for c in cases if c.verdict == Verdict.TRUE_POSITIVE)
    fp = sum(1 for c in cases if c.verdict == Verdict.FALSE_POSITIVE)
    nh = sum(1 for c in cases if c.verdict == Verdict.NEEDS_HUMAN)

    escalated = sum(
        1
        for c in cases
        if (c.status == CaseStatus.ESCALATED)
        or (c.escalation_level or 0) > 0
        or _first_transition_at(c, frozenset({CaseStatus.ESCALATED.value})) is not None
    )
    terminal = [c for c in cases if (c.status.value if c.status else "") in _TERMINAL]
    auto_closed = sum(1 for c in terminal if c.decision_by == DecisionBy.AGENT)

    return {
        "total_cases": total,
        "verdicted_cases": verdicted,
        "true_positive_cases": tp,
        "false_positive_cases": fp,
        "needs_human_cases": nh,
        "escalated_cases": escalated,
        "terminal_cases": len(terminal),
        "auto_closed_cases": auto_closed,
        # Excluded from every rate above; surfaced so the volume stays visible.
        "policy_closed_cases": len(policy_closed),
        "alert_to_incident_ratio": _ratio(tp, total),
        "false_positive_rate": _ratio(fp, verdicted),
        "escalation_rate": _ratio(escalated, total),
        "containment_rate": _ratio(len(terminal), total),
        "automation_rate": _ratio(auto_closed, len(terminal)),
    }


# Age buckets (hours) for the open-case queue, in ascending order.
_AGE_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("<1h", 0.0, 1.0),
    ("1-4h", 1.0, 4.0),
    ("4-24h", 4.0, 24.0),
    ("1-3d", 24.0, 72.0),
    ("3-7d", 72.0, 168.0),
    (">7d", 168.0, float("inf")),
)


def aging(cases: list[Case], *, now: datetime | None = None, oldest_n: int = 10) -> dict[str, Any]:
    """Queue depth + age distribution of OPEN (non-terminal) cases, the oldest-N,
    and an arrival-vs-closure balance. Pure; ``now`` injectable for determinism."""
    now = now or datetime.now(timezone.utc)
    open_cases = [c for c in cases if (c.status.value if c.status else "") not in _TERMINAL]

    buckets: Counter[str] = Counter()
    aged: list[tuple[float, Case]] = []
    for c in open_cases:
        start = _created_dt(c)
        if start is None:
            continue
        age_h = max(0.0, (now - start).total_seconds() / 3600.0)
        for label, lo, hi in _AGE_BUCKETS:
            if lo <= age_h < hi:
                buckets[label] += 1
                break
        aged.append((age_h, c))

    aged.sort(key=lambda t: t[0], reverse=True)
    oldest = [
        {
            "case_id": c.case_id,
            "case_number": c.case_number or c.case_id,
            "age_hours": round(age_h, 1),
            "status": c.status.value if c.status else "",
            "risk_score": c.risk_score,
        }
        for age_h, c in aged[: max(0, oldest_n)]
    ]

    terminal_count = sum(1 for c in cases if (c.status.value if c.status else "") in _TERMINAL)
    arrivals = len(cases)
    return {
        "queue_depth": len(open_cases),
        "age_buckets": [{"bucket": label, "count": buckets.get(label, 0)} for label, _, _ in _AGE_BUCKETS],
        "oldest": oldest,
        "arrivals": arrivals,
        "closures": terminal_count,
        "closure_vs_arrival": _ratio(terminal_count, arrivals),
        "backlog": len(open_cases),
    }


def sla_metrics(cases: list[Case], sla_policy: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """SLA attainment vs ``Preferences.sla`` (response + resolve targets per P-level).

    DETERMINISTIC + advisory (#3): we compare each case's elapsed response/resolution
    time against the target for its ``priority_level`` and classify it
    breached / at-risk (>=80% of target, not yet met) / ok. SLA classification NEVER
    feeds ``decide()``. Returns ``enabled:false`` (untouched today) when the policy
    is off so the existing behaviour is byte-identical."""
    now = now or datetime.now(timezone.utc)
    enabled = bool(getattr(sla_policy, "enabled", False))
    targets = getattr(sla_policy, "targets", {}) or {}
    if not enabled or not targets:
        return {"enabled": False, "evaluated": 0, "reason": "SLA policy disabled or no targets"}

    AT_RISK_FRACTION = 0.8
    response_breached = response_at_risk = 0
    resolve_breached = resolve_at_risk = 0
    evaluated = 0
    breaching: list[dict[str, Any]] = []

    for c in cases:
        prio = c.priority_level or ""
        target = targets.get(prio)
        if target is None:
            continue  # no target for this (or no) priority → not SLA-scored
        start = _created_dt(c)
        if start is None:
            # Unparseable created_at → no clock to measure. Exclude from the
            # attainment denominator (matching the guard-before-count idiom used
            # everywhere else in this file) so a corrupted doc can neither inflate
            # ``evaluated`` nor be silently scored as SLA-met.
            continue
        evaluated += 1

        # Response clock: created → first response (status_history / anchor), else now.
        resp_at = _as_dt(c.first_response_at) or _first_transition_at(c, _RESPONSE_STATUSES, by_human=True)
        resp_target = float(getattr(target, "response_minutes", 0) or 0)
        if resp_target > 0:
            elapsed = ((resp_at or now) - start).total_seconds() / 60.0
            if resp_at is None:  # still unresponded → live clock
                if elapsed > resp_target:
                    response_breached += 1
                    breaching.append(_breach_row(c, "response", elapsed, resp_target, "breached"))
                elif elapsed >= resp_target * AT_RISK_FRACTION:
                    response_at_risk += 1
                    breaching.append(_breach_row(c, "response", elapsed, resp_target, "at_risk"))
            elif elapsed > resp_target:  # responded, but late
                response_breached += 1
                breaching.append(_breach_row(c, "response", elapsed, resp_target, "breached"))

        # Resolution clock: created → terminal transition, else live to now.
        end = _first_transition_at(c, _TERMINAL)
        if end is None and (c.status.value if c.status else "") in _TERMINAL:
            end = _parse_iso(c.updated_at)
        resolve_target = float(getattr(target, "resolve_minutes", 0) or 0)
        if resolve_target > 0:
            elapsed = ((end or now) - start).total_seconds() / 60.0
            if end is None:  # still open → live clock
                if elapsed > resolve_target:
                    resolve_breached += 1
                    breaching.append(_breach_row(c, "resolution", elapsed, resolve_target, "breached"))
                elif elapsed >= resolve_target * AT_RISK_FRACTION:
                    resolve_at_risk += 1
                    breaching.append(_breach_row(c, "resolution", elapsed, resolve_target, "at_risk"))
            elif elapsed > resolve_target:  # resolved, but late
                resolve_breached += 1
                breaching.append(_breach_row(c, "resolution", elapsed, resolve_target, "breached"))

    met = evaluated - len({b["case_id"] for b in breaching if b["state"] == "breached"})
    return {
        "enabled": True,
        "evaluated": evaluated,
        "response_breached": response_breached,
        "response_at_risk": response_at_risk,
        "resolve_breached": resolve_breached,
        "resolve_at_risk": resolve_at_risk,
        "attainment_pct": round(100.0 * met / evaluated, 1) if evaluated else 0.0,
        "breaching": sorted(breaching, key=lambda b: -b["over_pct"])[:25],
    }


def _breach_row(case: Case, clock: str, elapsed: float, target: float, state: str) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "case_number": case.case_number or case.case_id,
        "priority": case.priority_level or "",
        "clock": clock,
        "state": state,
        "elapsed_minutes": round(elapsed, 1),
        "target_minutes": round(target, 1),
        "over_pct": round(100.0 * (elapsed - target) / target, 1) if target else 0.0,
    }


def _window_filter(cases: list[Case], *, window_hours: int, now: datetime | None = None) -> list[Case]:
    """Cases created within the last ``window_hours`` (0/negative → no filter).

    A case with an UNPARSEABLE created_at has no usable timestamp, so it cannot
    honestly be attributed to any time bucket: it is excluded from EVERY bounded
    window (current AND prev). This keeps the current/prev filters symmetric — the
    prev-window comprehension in ``posture_metrics`` already drops null-date cases,
    so counting them here would create a one-sided period-over-period delta. The
    ``window_hours <= 0`` escape still returns everything (the no-window path)."""
    if window_hours <= 0:
        return list(cases)
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - window_hours * 3600.0
    out: list[Case] = []
    for c in cases:
        start = _created_dt(c)
        if start is not None and start.timestamp() >= cutoff:
            out.append(c)
    return out


def _delta_pct(value: Any, prev: Any) -> Any:
    """Period-over-period delta% for two numeric metric values. DASH-safe: a DASH or
    non-numeric on either side yields a DASH (we can't compute a delta on a gap)."""
    if not isinstance(value, (int, float)) or not isinstance(prev, (int, float)):
        return DASH
    if prev == 0:
        return DASH if value == 0 else None  # None == "new / undefined growth"
    return round(100.0 * (value - prev) / prev, 1)


def _compare_block(curr: Any, prev: Any) -> dict[str, Any]:
    return {"value": curr, "prev": prev, "delta_pct": _delta_pct(curr, prev)}


def truncation_marker(
    fetched_count: int, store_total: int | None = None
) -> dict[str, Any]:
    """A small, honest provenance block the rollups attach so a consumer can tell a
    PARTIAL result (the store had more rows than we fetched) from a complete one.

    ``fetched_count`` is how many cases were pulled FROM THE STORE (i.e. before any
    in-window filtering), and ``store_total`` is the store's reported total (from
    ``CaseStore.list``). ``truncated`` is True only when the store held MORE rows than
    we fetched — it is NOT set by an in-window filter dropping cases (that is expected
    narrowing, not a missing tail). When the caller omits ``store_total`` we
    conservatively assume the fetched set is the whole population (``truncated: false``)."""
    fetched = int(fetched_count)
    total = int(store_total) if store_total is not None else fetched
    return {"truncated": total > fetched, "store_total": total, "fetched": fetched}


def posture_metrics(
    cases: list[Case],
    *,
    sla_policy: Any = None,
    window_hours: int = 24,
    compare: str = "",
    now: datetime | None = None,
    store_total: int | None = None,
) -> dict[str, Any]:
    """The rich security-posture rollup: lifecycle + quality + aging + SLA + a few
    period-over-period headline comparisons. Pure + deterministic; advisory only (#3).

    ``cases`` is the FULL fetched set (up to the route's store fetch bound); this
    function time-bounds it to ``window_hours`` internally. When ``compare == 'prev'``
    it also computes the immediately-preceding equal-length window for delta% on the
    headline numbers. ``store_total`` is the store's reported total (when the fetch was
    capped) so the response can flag a truncated/partial rollup honestly rather than
    silently returning a wrong number computed over only the newest N cases."""
    now = now or datetime.now(timezone.utc)
    window_hours = max(0, int(window_hours))

    current = _window_filter(cases, window_hours=window_hours, now=now)
    lifecycle = lifecycle_intervals(current)
    quality = quality_metrics(current)
    age = aging(current, now=now)
    sla = sla_metrics(current, sla_policy, now=now)

    rollup: dict[str, Any] = {
        "window_hours": window_hours,
        "generated_at": now.isoformat(),
        "case_count": len(current),
        "lifecycle": lifecycle,
        "quality": quality,
        "aging": age,
        "sla": sla,
        # ``cases`` is the full fetched set here (window filtering is internal), so its
        # length IS the fetched count for the truncation comparison.
        **truncation_marker(len(cases), store_total),
    }

    if compare == "prev" and window_hours > 0:
        prev_end = now.timestamp() - window_hours * 3600.0
        prev_window = [
            c
            for c in cases
            if (s := _created_dt(c)) is not None
            and prev_end - window_hours * 3600.0 <= s.timestamp() < prev_end
        ]
        prev_quality = quality_metrics(prev_window)
        prev_life = lifecycle_intervals(prev_window)
        rollup["compare"] = {
            "mode": "prev",
            "case_count": _compare_block(len(current), len(prev_window)),
            "alert_to_incident_ratio": _compare_block(
                quality["alert_to_incident_ratio"], prev_quality["alert_to_incident_ratio"]
            ),
            "false_positive_rate": _compare_block(
                quality["false_positive_rate"], prev_quality["false_positive_rate"]
            ),
            "escalation_rate": _compare_block(
                quality["escalation_rate"], prev_quality["escalation_rate"]
            ),
            "automation_rate": _compare_block(
                quality["automation_rate"], prev_quality["automation_rate"]
            ),
            "mttr_p50": _compare_block(
                lifecycle["mttr_minutes"]["p50"], prev_life["mttr_minutes"]["p50"]
            ),
            "mtta_p50": _compare_block(
                lifecycle["mtta_minutes"]["p50"], prev_life["mtta_minutes"]["p50"]
            ),
        }

    return rollup


# --------------------------------------------------------------------------- #
# Auto-close health — a FIRST-CLASS observability signal.
#
# The failure this exists for: auto-close silently stopped firing (an unrelated
# configuration change starved the precedent corpus) and NOTHING surfaced it —
# no warning, no metric, no UI signal. A rolling auto-close rate that falls to ~0
# while investigation volume holds steady is the one cheap, deterministic signal
# that catches that outage the same day.
#
# Everything below is a READ-TIME DERIVATION over already-persisted case data. It is
# NEVER read by ``case_manager.decide()`` (#3) — ``decide()`` takes
# ``(verdict, confidence, risk_score, policy)`` and nothing else. Reading
# ``AutoClosePolicy`` here is display-only (exactly as ``sla_metrics`` reads
# ``Preferences.sla``): it explains an expected zero, it never influences one.
#
# Honesty contract (house style — see ``engine/agent_improvement.py``): insufficient
# evidence stays EXPLICIT. A window without enough decided cases reports ``rate:
# DASH`` + ``available: false`` + a ``reason``; it never degrades into a
# reassuring-looking number, and there is no composite "health score".
# --------------------------------------------------------------------------- #

# A window needs at least this many DECIDED cases before an auto-close RATE is
# statistically meaningful at all. Below it the window is insufficient evidence.
AUTO_CLOSE_MIN_DECIDED = 10
# "~0" — a rate at or below this counts as collapsed-to-zero.
AUTO_CLOSE_NEAR_ZERO_RATE = 0.02
# The comparison baseline must itself have been meaningfully non-zero, otherwise
# "it fell to zero" is not a statement about anything.
AUTO_CLOSE_BASELINE_MIN_RATE = 0.05
# Volume "holds steady" when the current window still carries at least this fraction
# of the preceding window's decided volume. Without this guard a quiet weekend is
# indistinguishable from an auto-close outage — which is the whole point.
AUTO_CLOSE_STEADY_VOLUME_FRACTION = 0.5
# A relative drop of at least this much (but not all the way to ~0) is a degradation.
AUTO_CLOSE_DEGRADED_DROP_FRACTION = 0.5


def _decision_dt(case: Case) -> datetime | None:
    """The instant the deterministic decision was LAST recorded for this case.

    ``case_manager.apply()`` appends ``{"event": "decision", "ts": ...}`` to the
    append-only ``history`` every time it runs, so the newest such entry is the
    precise instant ``decide()`` produced the case's current outcome. That is the
    right anchor for a ROLLING auto-close rate: a case created days ago but decided
    today belongs to today's window. Falls back to the detection/creation instant
    when no decision entry survives (older cases, trimmed history)."""
    for entry in reversed(case.history or []):
        if not isinstance(entry, dict) or entry.get("event") != "decision":
            continue
        dt = _parse_iso(entry.get("ts"))
        if dt is not None:
            return dt
    return _created_dt(case)


def _auto_close_tally(
    cases: list[Case], *, start: datetime | None, end: datetime | None
) -> dict[str, int]:
    """Count DECIDED vs AUTO-CLOSED cases whose decision lands in ``[start, end)``.

    ``start``/``end`` of ``None`` mean "unbounded on that side". A case counts as
    *decided* once the investigation produced a verdict (``decide()`` therefore ran);
    it counts as *auto-closed* when the deterministic decision author was the AGENT
    and the case is terminal — the same ``decision_by == agent`` tally
    :func:`quality_metrics` already uses for ``automation_rate``."""
    decided = auto_closed = routed_to_human = analyst_decided = policy_closed = 0
    for case in cases:
        at = _decision_dt(case)
        if at is None:
            continue
        if start is not None and at < start:
            continue
        if end is not None and at >= end:
            continue
        # An analyst-rule-policy close never reached a verdict, so it would already
        # fall out below — but say so EXPLICITLY: silently relying on that would put
        # it in ``routed_to_human`` the moment anything else set a verdict, and enough
        # policy closes there can flip auto-close health to a false ``collapsed``.
        # Counted AFTER the window guards, so the current/baseline/lifetime blocks each
        # report their own window's policy volume rather than the whole fetched set.
        if is_policy_closed(case):
            policy_closed += 1
            continue
        if case.verdict is None:
            continue
        decided += 1
        terminal = (case.status.value if case.status else "") in _TERMINAL
        if case.decision_by == DecisionBy.AGENT and terminal:
            auto_closed += 1
        elif case.decision_by == DecisionBy.ANALYST:
            analyst_decided += 1
        else:
            routed_to_human += 1
    return {
        "decided": decided,
        "auto_closed": auto_closed,
        "routed_to_human": routed_to_human,
        "analyst_decided": analyst_decided,
        # Outside the rate entirely (numerator AND denominator); reported for context.
        "policy_closed": policy_closed,
    }


def _auto_close_block(
    tally: dict[str, int], *, label: str, min_decided: int
) -> dict[str, Any]:
    """Wrap a tally in the honest rate block. ``rate`` is the labelled DASH whenever
    the window cannot support a meaningful rate — never a fabricated 0.0 and never a
    reassuring-looking number computed from two samples. The raw counts stay
    available so a caller can be explicit about what it is doing."""
    decided = int(tally.get("decided", 0))
    if decided == 0:
        return {
            **tally, "rate": DASH, "available": False,
            "reason": f"no case reached a verdict in the {label} window",
        }
    if decided < min_decided:
        return {
            **tally, "rate": DASH, "available": False,
            "reason": (
                f"only {decided} decided case(s) in the {label} window; at least "
                f"{min_decided} are required before an auto-close rate is meaningful"
            ),
        }
    return {
        **tally,
        "rate": _ratio(int(tally.get("auto_closed", 0)), decided),
        "available": True,
        "reason": "",
    }


def _auto_close_policy_block(policy: Any) -> dict[str, Any]:
    """A read-only mirror of the operator's auto-close policy, so a zero rate that is
    simply *configured* is not mistaken for an outage. Display-only (#3)."""
    if policy is None:
        return {
            "available": False, "any_enabled": False,
            "false_positive_enabled": False, "true_positive_enabled": False,
            "reason": "the auto-close policy was not supplied to this rollup",
        }
    fp = bool(getattr(getattr(policy, "false_positive", None), "enabled", False))
    tp = bool(getattr(getattr(policy, "true_positive", None), "enabled", False))
    return {
        "available": True, "any_enabled": bool(fp or tp),
        "false_positive_enabled": fp, "true_positive_enabled": tp, "reason": "",
    }


def auto_close_health(
    cases: list[Case],
    *,
    window_hours: int = 24,
    policy: Any = None,
    now: datetime | None = None,
    store_total: int | None = None,
    min_decided: int = AUTO_CLOSE_MIN_DECIDED,
) -> dict[str, Any]:
    """The rolling auto-close rate as a diagnosable health signal.

    Compares the current ``window_hours`` window with the immediately preceding
    equal-length window, and adds an unbounded "lifetime" tally over the supplied
    case set so a collapse that happened days ago (both windows already at zero) is
    still visible rather than reading as a steady, healthy zero.

    ``status`` is one explicit string, never a score:

    * ``disabled``              — every verdict class has auto-close turned OFF, so a
      zero rate is the configured behaviour, not a failure.
    * ``no_volume``             — nothing was decided in the current window. A quiet
      period is NOT an auto-close outage, and is reported as such.
    * ``collapsed``             — the rate fell to ~0 while decided volume held
      steady against a previously non-zero baseline. **This is the outage signal.**
    * ``never_fired``           — auto-close is enabled and enough cases have been
      decided, but not a single one has ever auto-closed.
    * ``degraded``              — a large (>=50%) relative drop with steady volume.
    * ``insufficient_evidence`` — not enough decided cases to compare honestly.
    * ``ok``                    — measured and within tolerance.

    Pure + deterministic given ``cases``/``now``; advisory only. Nothing here is ever
    read by ``case_manager.decide()`` (#3)."""
    now = now or datetime.now(timezone.utc)
    window_hours = max(1, int(window_hours))
    span = timedelta(hours=window_hours)
    window_start = now - span
    baseline_start = window_start - span

    current = _auto_close_block(
        _auto_close_tally(cases, start=window_start, end=None),
        label="current", min_decided=min_decided,
    )
    baseline = _auto_close_block(
        _auto_close_tally(cases, start=baseline_start, end=window_start),
        label="preceding", min_decided=min_decided,
    )
    lifetime = _auto_close_block(
        _auto_close_tally(cases, start=None, end=None),
        label="fetched", min_decided=min_decided,
    )
    policy_block = _auto_close_policy_block(policy)

    baseline_decided = int(baseline["decided"])
    current_decided = int(current["decided"])
    volume_steady = bool(
        baseline_decided > 0
        and current_decided >= baseline_decided * AUTO_CLOSE_STEADY_VOLUME_FRACTION
    )
    comparable = bool(current["available"] and baseline["available"])
    current_rate = current["rate"] if current["available"] else None
    baseline_rate = baseline["rate"] if baseline["available"] else None

    collapsed = bool(
        comparable
        and volume_steady
        and baseline_rate is not None
        and current_rate is not None
        and baseline_rate >= AUTO_CLOSE_BASELINE_MIN_RATE
        and current_rate <= AUTO_CLOSE_NEAR_ZERO_RATE
    )
    degraded = bool(
        comparable
        and volume_steady
        and not collapsed
        and baseline_rate is not None
        and current_rate is not None
        and baseline_rate >= AUTO_CLOSE_BASELINE_MIN_RATE
        and current_rate <= baseline_rate * (1.0 - AUTO_CLOSE_DEGRADED_DROP_FRACTION)
    )
    never_fired = bool(
        policy_block["any_enabled"]
        and lifetime["available"]
        and int(lifetime["auto_closed"]) == 0
    )

    if policy_block["available"] and not policy_block["any_enabled"]:
        status = "disabled"
        reason = (
            "auto-close is turned OFF for every verdict class, so a zero auto-close "
            "rate is the configured behaviour"
        )
    elif current_decided == 0:
        status = "no_volume"
        reason = (
            f"no case reached a verdict in the last {window_hours}h"
            + (
                f" (the preceding {window_hours}h decided {baseline_decided}) — this is an "
                "investigation-volume gap, not an auto-close outage"
                if baseline_decided
                else " and none did in the preceding window either"
            )
        )
    elif collapsed:
        status = "collapsed"
        reason = (
            f"the auto-close rate fell from {baseline_rate} to {current_rate} while decided "
            f"volume held steady ({baseline_decided} -> {current_decided} cases)"
        )
    elif never_fired:
        status = "never_fired"
        reason = (
            f"auto-close is enabled but not one of the {lifetime['decided']} decided "
            "case(s) in the fetched history has ever auto-closed"
        )
    elif not comparable:
        status = "insufficient_evidence"
        reason = current["reason"] or baseline["reason"]
    elif degraded:
        status = "degraded"
        reason = (
            f"the auto-close rate dropped from {baseline_rate} to {current_rate} while "
            "decided volume held steady"
        )
    else:
        status = "ok"
        reason = ""

    return {
        "window_hours": window_hours,
        "generated_at": now.isoformat(),
        "current": current,
        "baseline": baseline,
        "lifetime": lifetime,
        "policy": policy_block,
        "status": status,
        "reason": reason,
        "collapsed": collapsed,
        "volume_steady": volume_steady,
        "comparable": comparable,
        "needs_attention": status in ("collapsed", "never_fired", "degraded"),
        "thresholds": {
            "min_decided": int(min_decided),
            "near_zero_rate": AUTO_CLOSE_NEAR_ZERO_RATE,
            "baseline_min_rate": AUTO_CLOSE_BASELINE_MIN_RATE,
            "steady_volume_fraction": AUTO_CLOSE_STEADY_VOLUME_FRACTION,
            "degraded_drop_fraction": AUTO_CLOSE_DEGRADED_DROP_FRACTION,
        },
        **truncation_marker(len(cases), store_total),
    }


def analyst_confirmed_case_ids(cases: list[Case]) -> set[str]:
    """The ids of cases whose outcome is INDEPENDENTLY analyst-confirmed.

    Lets an observability surface tell an analyst-confirmed precedent document apart
    from a lower-trust one when both tiers share a corpus source: the projected
    document identity is derived from the case id, so intersecting these ids with the
    corpus's precedent document ids counts the confirmed tier exactly, without reading
    (or depending on) any RAG internal. Pure + read-only."""
    return {
        case.case_id
        for case in cases
        if analyst_confirmed_outcome(case)[0] is not None and case.case_id
    }


def precedent_ground_truth(
    cases: list[Case], *, store_total: int | None = None
) -> dict[str, Any]:
    """How much ANALYST-CONFIRMED ground truth the fetched case set actually holds.

    The precedent corpus can only ever be as large as the labelled history behind it,
    so "the corpus has zero precedents" means something quite different depending on
    whether the case history holds zero analyst-confirmed outcomes (nobody has graded
    anything — a labelling gap) or hundreds (the projection is broken). Both numbers
    are reported so the operator can tell those apart instead of guessing.

    Uses the SAME independent classifier the tuner and the RAG projection use
    (:func:`engine.analyst_outcomes.analyst_confirmed_outcome`) — a terminal status,
    a model verdict, or a bare disposition is never ground truth. Pure + read-only."""
    confirmed = 0
    terminal = 0
    by_outcome: Counter[str] = Counter()
    by_evidence: Counter[str] = Counter()
    policy_closed = 0
    for case in cases:
        outcome, evidence = analyst_confirmed_outcome(case)
        # An UNGRADED policy close is terminal but was never a candidate for grading, so
        # counting it would widen the "ungraded terminal cases" gap that drives the
        # starved narrative and make a healthy corpus look like a labelling failure. A
        # policy close an analyst LATER GRADED is real independent evidence and is
        # counted exactly like any other — the same rule ``analyst_confirmed_case_ids``
        # and the RAG projection already apply, so the three cannot disagree.
        if outcome is None and is_policy_closed(case):
            policy_closed += 1
            continue
        if (case.status.value if case.status else "") in _TERMINAL:
            terminal += 1
        if outcome is None:
            continue
        confirmed += 1
        by_outcome[outcome] += 1
        by_evidence[str(evidence or "unknown")] += 1
    return {
        "analyst_confirmed_cases": confirmed,
        "terminal_cases": terminal,
        "policy_closed_cases": policy_closed,
        "scanned_cases": len(cases),
        "by_outcome": dict(by_outcome),
        "by_evidence_source": dict(by_evidence),
        "zero_analyst_confirmed_cases": confirmed == 0,
        **truncation_marker(len(cases), store_total),
    }
