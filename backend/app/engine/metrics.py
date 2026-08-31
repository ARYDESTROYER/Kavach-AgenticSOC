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

POPULATIONS — the headline tiles are computed over three DIFFERENT populations and
mixing them up is the easiest way to publish a confident wrong number, so each has one
named producer here: :func:`severity_band_counts` (a partition of the windowed arrival
cohort), :func:`open_case_count` (the window-EXEMPT open stock measured now), and
``quality_metrics``' three-way close partition. :func:`_window_coverage` is the honest
counterpart — whether the selected window is fully answerable from the rows a bounded
fetch actually read, which is what lets a tile publish instead of withholding forever
on a store larger than the fetch bound.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from ..constants import (
    SEVERITY_BANDS,
    CaseStatus,
    DecisionBy,
    TERMINAL_CASE_STATUSES,
    Verdict,
)
from ..models import Case
from .analyst_outcomes import analyst_confirmed_outcome
from .precedent import is_policy_closed
from .priority import band_of_case

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


def _resolved_dt(case: Case, timings: "_CaseTimings | None" = None) -> datetime | None:
    """The instant a case became TERMINAL (RESOLVED/CLOSED), else None when the case is
    currently open. A currently NON-terminal case is never counted as resolved — even if
    it was closed and later REOPENED: ``status_history`` is append-only, so a stale
    terminal transition lingers, and without the current-status guard a reopened (now-open)
    case would wrongly count as resolved and corrupt the burndown net-backlog + the resolve
    trend. Advisory/reporting only — never read by ``decide()`` (#3)."""
    if (case.status.value if case.status else "") not in _TERMINAL:
        return None
    if timings is not None:
        return timings.terminal_any if timings.terminal_any is not None else timings.updated_iso
    end = _first_transition_at(case, _TERMINAL)
    if end is not None:
        return end
    return _parse_iso(case.updated_at)  # terminal but no recorded transition


_ESCALATED_VALUE = CaseStatus.ESCALATED.value


class _CaseTimings:
    """Per-case parsed timestamps + earliest status-history transitions, computed in
    ONE pass so :func:`posture_metrics` (and :func:`trend_metrics`) do not re-parse the
    same ISO strings / re-walk the same ``status_history`` up to ~6× per case across
    their sub-computations.

    Every field reproduces EXACTLY the value the corresponding ad-hoc lookup would
    produce (:func:`_parse_iso` / :func:`_as_dt` / :func:`_created_dt` /
    :func:`_first_transition_at` are pure), so threading a timings index through the
    sub-functions is a pure micro-optimisation: outputs stay byte-identical."""

    __slots__ = (
        "created", "created_iso", "updated_iso",
        "ack_anchor", "resp_anchor",
        "ack_human", "resp_human", "terminal_any", "escalated_any",
    )

    def __init__(self, case: Case) -> None:
        # _parse_iso(case.created_at) — the MTTD clock (deliberately NOT detected_at).
        self.created_iso = _parse_iso(case.created_at)
        # _parse_iso(case.updated_at) — the terminal-without-history fallback.
        self.updated_iso = _parse_iso(case.updated_at)
        # _created_dt(case) — detection instant when populated, else creation.
        self.created = _as_dt(case.detected_at) or self.created_iso
        # The explicit lifecycle anchors.
        self.ack_anchor = _as_dt(case.acknowledged_at)
        self.resp_anchor = _as_dt(case.first_response_at)
        # One status_history walk for all four "earliest transition into ..." lookups:
        #   ack_human      == _first_transition_at(case, _ACK_STATUSES, by_human=True)
        #   resp_human     == _first_transition_at(case, _RESPONSE_STATUSES, by_human=True)
        #   terminal_any   == _first_transition_at(case, _TERMINAL)
        #   escalated_any  == _first_transition_at(case, {ESCALATED})
        ack = resp = term = esc = None
        for entry in case.status_history or []:
            to_status = entry.to_status or ""
            in_ack = to_status in _ACK_STATUSES
            in_resp = to_status in _RESPONSE_STATUSES
            in_term = to_status in _TERMINAL
            is_esc = to_status == _ESCALATED_VALUE
            if not (in_ack or in_resp or in_term or is_esc):
                continue
            dt = _parse_iso(entry.at)
            if dt is None:
                continue
            if (in_ack or in_resp) and (entry.by or "").strip().lower() not in _NONHUMAN_ACTORS:
                if in_ack and (ack is None or dt < ack):
                    ack = dt
                if in_resp and (resp is None or dt < resp):
                    resp = dt
            if in_term and (term is None or dt < term):
                term = dt
            if is_esc and (esc is None or dt < esc):
                esc = dt
        self.ack_human = ack
        self.resp_human = resp
        self.terminal_any = term
        self.escalated_any = esc


def _timings_for(case: Case, index: dict[int, _CaseTimings] | None) -> _CaseTimings:
    """The (possibly memoized) :class:`_CaseTimings` for ``case``. With ``index`` set
    (one dict per rollup call, keyed by object identity) each case is parsed once and
    shared across every sub-computation; with ``index=None`` behavior is a plain
    compute (the standalone-call path used directly by tests)."""
    if index is None:
        return _CaseTimings(case)
    timings = index.get(id(case))
    if timings is None:
        timings = _CaseTimings(case)
        index[id(case)] = timings
    return timings


def lifecycle_intervals(
    cases: list[Case], *, _timings: dict[int, _CaseTimings] | None = None
) -> dict[str, Any]:
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
        timings = _timings_for(case, _timings)
        # MTTD is measured from ``created_at`` (case-open), independent of the
        # ack/response clocks, so a case with no ack/response still contributes a
        # detection-latency sample. Computed first, before the ``start`` guard.
        fs = getattr(case, "first_seen_millis", 0) or 0
        if isinstance(fs, (int, float)) and fs > 0:
            created = timings.created_iso
            if created is not None:
                created_ms = created.timestamp() * 1000.0
                if created_ms >= fs:
                    mttd.append((created_ms - fs) / 60000.0)

        start = timings.created
        if start is None:
            continue

        ack = timings.ack_anchor or timings.ack_human
        if ack and ack >= start:
            mtta.append((ack - start).total_seconds() / 60.0)

        resp = timings.resp_anchor or timings.resp_human
        if resp and resp >= start:
            dwell.append((resp - start).total_seconds() / 60.0)

        end = _resolved_dt(case, timings)  # guarded: a reopened (currently-open) case isn't resolved
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


def quality_metrics(
    cases: list[Case], *, _timings: dict[int, _CaseTimings] | None = None
) -> dict[str, Any]:
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
    * ``auto_closed_cases`` / ``human_closed_cases`` / ``system_closed_cases`` — the
      three-way ``decision_by`` partition of ``terminal_cases``, all over the SAME
      policy-excluded population: ``decision_by == AGENT``, ``decision_by ==
      ANALYST``, and the honest RESIDUAL (``SYSTEM`` deterministic routing plus
      legacy records carrying no provenance at all). They sum EXACTLY to
      ``terminal_cases``, so a "human vs AI" share always adds up to 100% with the
      unattributed remainder VISIBLE — never silently folded into either side.
      ``human_closed_cases`` deliberately does NOT mean ``terminal_cases -
      auto_closed_cases``: that difference over-states human work by absorbing
      SYSTEM and legacy-null closes.

    HONESTY CAVEAT — ``decision_by`` is LAST-WRITER, not an immutable close author.
    Every analyst lifecycle action in ``api/routes.py`` (close, confirm_fp, reopen,
    escalate, deescalate, hold, resume, resolve, **acknowledge**, set_disposition,
    set_status) stamps ``decision_by = ANALYST`` unconditionally, and a same-status
    move is permitted. So an AGENT-auto-closed case that a human merely ACKNOWLEDGES
    or re-tags afterwards migrates from ``auto_closed_cases`` into
    ``human_closed_cases``. These counts report the LAST recorded decider, not proof
    of who performed the close, and any surface attributing work to "the AI" vs "a
    human" from them MUST disclose that. This is deliberately not "fixed" here:
    the append-only ``status_history`` / ``{"event": "decision"}`` entries hold the
    durable record if a non-erasable predicate is ever wanted, but switching the
    predicate would silently move the shipped ``automation_rate`` series.
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
        or _timings_for(c, _timings).escalated_any is not None
    )
    terminal = [c for c in cases if (c.status.value if c.status else "") in _TERMINAL]
    auto_closed = sum(1 for c in terminal if c.decision_by == DecisionBy.AGENT)
    human_closed = sum(1 for c in terminal if c.decision_by == DecisionBy.ANALYST)
    # The honest residual: SYSTEM routing + legacy records with no recorded
    # provenance. Neither agent nor human work, so it is reported on its own instead
    # of inflating either side. auto + human + system == len(terminal), always.
    system_closed = len(terminal) - auto_closed - human_closed

    return {
        "total_cases": total,
        "verdicted_cases": verdicted,
        "true_positive_cases": tp,
        "false_positive_cases": fp,
        "needs_human_cases": nh,
        "escalated_cases": escalated,
        "terminal_cases": len(terminal),
        "auto_closed_cases": auto_closed,
        # Partition of terminal_cases by LAST-WRITER decision_by (see the caveat in
        # the docstring): AGENT / ANALYST / residual. Sums to terminal_cases.
        "human_closed_cases": human_closed,
        "system_closed_cases": system_closed,
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


def aging(
    cases: list[Case],
    *,
    now: datetime | None = None,
    oldest_n: int = 10,
    _timings: dict[int, _CaseTimings] | None = None,
) -> dict[str, Any]:
    """Queue depth + age distribution of OPEN (non-terminal) cases, the oldest-N,
    and an arrival-vs-closure balance. Pure; ``now`` injectable for determinism."""
    now = now or datetime.now(timezone.utc)
    open_cases = [c for c in cases if (c.status.value if c.status else "") not in _TERMINAL]

    buckets: Counter[str] = Counter()
    aged: list[tuple[float, Case]] = []
    for c in open_cases:
        start = _timings_for(c, _timings).created if _timings is not None else _created_dt(c)
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


def sla_metrics(
    cases: list[Case],
    sla_policy: Any,
    *,
    now: datetime | None = None,
    _timings: dict[int, _CaseTimings] | None = None,
) -> dict[str, Any]:
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
        timings = _timings_for(c, _timings)
        start = timings.created
        if start is None:
            # Unparseable created_at → no clock to measure. Exclude from the
            # attainment denominator (matching the guard-before-count idiom used
            # everywhere else in this file) so a corrupted doc can neither inflate
            # ``evaluated`` nor be silently scored as SLA-met.
            continue
        evaluated += 1

        # Response clock: created → first response (status_history / anchor), else now.
        resp_at = timings.resp_anchor or timings.resp_human
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
        end = timings.terminal_any
        if end is None and (c.status.value if c.status else "") in _TERMINAL:
            end = timings.updated_iso
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


def _window_filter(
    cases: list[Case],
    *,
    window_hours: int,
    now: datetime | None = None,
    _timings: dict[int, _CaseTimings] | None = None,
) -> list[Case]:
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
        start = _timings_for(c, _timings).created if _timings is not None else _created_dt(c)
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


# What a rollup says when the case fetch FAILED. An empty result set then means "we
# could not read the store", not "the store is empty", and every completeness claim
# built on it (``open_now.complete``, ``window_covered``) has to say so — otherwise a
# transient outage publishes "0 open cases" as a proven-complete measurement.
_LOAD_FAILED_REASON = (
    "the case store could not be read, so this population was not measured; the "
    "figures shown are not a count of anything"
)


def severity_band_counts(
    cases: list[Case], *, prefs: Any = None
) -> dict[str, int]:
    """Per-band tally of ``cases`` over the advisory severity ladder.

    The ONE server-side answer to "how many CRITICAL cases are in this population".
    Without it a client can only count the band over whatever bounded page it happens
    to hold, which silently reports a sample as a total.

    Bands come from the public :func:`engine.priority.band_of_case`, which is the
    single fallback chain (persisted band → source-asserted severity projected onto
    the source's DECLARED ceiling → the deterministic risk total → ``info``). That
    projection is READ-TIME and is never persisted, so ``prefs`` must be threaded in
    for the declared ceiling to be resolvable; with ``prefs=None`` the derivation
    still runs, on the identity ceiling (see ``band_of_case``).

    Every band in ``constants.SEVERITY_BANDS`` is always present (zero-filled) and in
    that order, so a consumer never has to distinguish "band absent" from "band zero",
    and the values sum EXACTLY to ``len(cases)`` — the tally is a partition of the
    population it was given, never a filtered subset. Advisory only (#3): nothing here
    is read by ``case_manager.decide()``, and nothing is written back onto a case."""
    counts: dict[str, int] = {band: 0 for band in SEVERITY_BANDS}
    for case in cases:
        band = band_of_case(case, prefs)
        # band_of_case is total and only ever returns a SEVERITY_BANDS member, but the
        # tally must remain a partition even if that ever changed: an unknown label is
        # folded into the honest floor rather than dropped (which would break the sum).
        counts[band if band in counts else SEVERITY_BANDS[-1]] += 1
    return counts


def open_case_count(cases: list[Case]) -> int:
    """How many of ``cases`` are STILL OPEN — i.e. whose status is not one of
    ``constants.TERMINAL_CASE_STATUSES`` (the single source of truth both case stores
    use for #4 dedupe, so "open" here means exactly what "open" means to the store).

    Deliberately a STOCK, not a cohort: it answers "what is on the queue right now",
    which is why every caller measures it over the WHOLE fetched set rather than a
    time-bounded arrival window. ``aging()['queue_depth']`` is the cohort-scoped
    counterpart (open cases that ARRIVED in the window) and is a different number;
    neither substitutes for the other."""
    return sum(1 for c in cases if (c.status.value if c.status else "") not in _TERMINAL)


def _window_coverage(
    cases: list[Case],
    *,
    window_hours: int,
    now: datetime,
    truncated: bool,
    load_ok: bool = True,
    _timings: dict[int, _CaseTimings] | None = None,
) -> tuple[bool, str, str | None]:
    """Can the SELECTED WINDOW be answered completely from the rows actually fetched?

    ``truncated`` (from :func:`truncation_marker`) says the store held more rows than
    were read — a permanent condition for any deployment with more cases than the
    route's fetch bound. On its own it forces every posture-fed number to be presented
    as a lower bound forever, even when the operator asked for the last 24 hours and
    the fetched rows reach back a month. That is technically true and practically
    useless, so this derives the narrower, more informative claim.

    Cases are fetched NEWEST-FIRST by ``created_at``, so a truncated fetch can only
    have dropped rows OLDER than the oldest row we did read. Let
    ``floor = min(created_at)`` over the fetched set; then::

        window_covered = (not truncated) or (window_hours > 0 and cutoff >= floor)

    i.e. if the window's cutoff is at or after the oldest fetched case, every case
    that could satisfy the window was read, and the window's numbers are COMPLETE even
    though the overall fetch was not.

    Returns ``(covered, reason, oldest_fetched_at)``. ``reason`` is empty when covered
    and otherwise names the specific obstacle; ``oldest_fetched_at`` is the ISO floor
    (None when no fetched case carries a parseable ``created_at``).

    Deliberately conservative in three places: the unbounded (``window_hours <= 0``)
    window can never be proven covered by a partial fetch; an unparseable
    ``created_at`` contributes no floor evidence; and the floor is measured on
    ``created_at`` — the field the store ORDERS by, and therefore the field that
    decides what got cut — not on the detection-instant clock the window filter
    prefers, which for a dropped row can only be earlier.

    ``load_ok=False`` says the caller's fetch FAILED rather than returned nothing, and
    short-circuits every branch below to "not covered". Without it an outage is
    indistinguishable from an empty store: the soft-failed fetch hands back zero rows
    AND ``store_total=0``, so ``truncated`` is False and this function would certify a
    window it never read a single row for.

    This is emitted ALONGSIDE the truncation marker and never modifies it: four
    rollups share ``truncation_marker`` and its exact three-key shape is pinned."""
    floor: datetime | None = None
    for case in cases:
        created = (
            _timings_for(case, _timings).created_iso
            if _timings is not None
            else _parse_iso(case.created_at)
        )
        if created is None:
            continue
        if floor is None or created < floor:
            floor = created
    floor_iso = floor.isoformat() if floor is not None else None

    if not load_ok:
        return False, _LOAD_FAILED_REASON, floor_iso
    if not truncated:
        return True, "", floor_iso
    if window_hours <= 0:
        return (
            False,
            "the fetch was truncated and the selected window is unbounded (all time), "
            "so the unread older rows can never be excluded",
            floor_iso,
        )
    if floor is None:
        return (
            False,
            "the fetch was truncated and no fetched case carries a parseable creation "
            "time, so there is no evidence of how far back the fetched rows reach",
            floor_iso,
        )
    cutoff = now.timestamp() - window_hours * 3600.0
    if cutoff >= floor.timestamp():
        return True, "", floor_iso
    return (
        False,
        "the fetch was truncated and the selected window starts before the oldest "
        "fetched case, so cases inside the window were not read",
        floor_iso,
    )


def posture_metrics(
    cases: list[Case],
    *,
    sla_policy: Any = None,
    window_hours: int = 24,
    compare: str = "",
    now: datetime | None = None,
    store_total: int | None = None,
    prefs: Any = None,
    load_ok: bool = True,
) -> dict[str, Any]:
    """The rich security-posture rollup: lifecycle + quality + aging + SLA + a few
    period-over-period headline comparisons. Pure + deterministic; advisory only (#3).

    ``cases`` is the FULL fetched set (up to the route's store fetch bound); this
    function time-bounds it to ``window_hours`` internally. When ``compare == 'prev'``
    it also computes the immediately-preceding equal-length window for delta% on the
    headline numbers. ``store_total`` is the store's reported total (when the fetch was
    capped) so the response can flag a truncated/partial rollup honestly rather than
    silently returning a wrong number computed over only the newest N cases.

    ``prefs`` (optional, ``Preferences``) is threaded ONLY into the read-time severity
    projection behind ``severity_counts``; omitting it leaves every other number
    byte-identical and bands on the identity ceiling (see :func:`severity_band_counts`).

    ``load_ok=False`` says the caller's case fetch FAILED (the route soft-fails to an
    empty list so a dashboard never 500s). Every count below is then computed over zero
    rows, which is a number but not a measurement — so the two completeness assertions,
    ``open_now.complete`` and ``window_covered``, are forced False with a reason naming
    the failure. They are the flags that license a tile to publish, and an outage is
    exactly when they must not.

    Populations, and which of them the window bounds — the distinction the headline
    tiles are built on and the one that is easiest to get silently wrong:

    * ``case_count`` + ``severity_counts`` — the ARRIVAL COHORT: cases created inside
      ``window_hours``, policy-closed included. ``severity_counts`` partitions exactly
      that population, so its values sum to ``case_count``.
    * ``open_now`` — a STOCK measured at ``generated_at`` over the WHOLE fetched set.
      Deliberately window-EXEMPT (a case that arrived last month and is still open is
      on the queue today), which is why it is a nested block carrying
      ``window_exempt: true``: it must never be presented as summing or reconciling
      with the cohort tiles. ``aging.queue_depth`` is the cohort-scoped counterpart
      and is a DIFFERENT number.
    * ``quality.terminal_cases`` and its three-way ``auto_closed_cases`` /
      ``human_closed_cases`` / ``system_closed_cases`` partition — cohort-scoped, and
      the residual stays visible even at zero (see :func:`quality_metrics`).
    * ``window_covered`` / ``window_coverage_reason`` / ``oldest_fetched_at`` — whether
      the numbers above are COMPLETE for the selected window despite a truncated fetch
      (see :func:`_window_coverage`). Emitted alongside, never inside, the truncation
      marker. ``window_covered`` does NOT rescue ``open_now``, whose population is the
      whole fetch: that block carries its own ``complete`` flag."""
    now = now or datetime.now(timezone.utc)
    window_hours = max(0, int(window_hours))

    # ONE shared per-case timings index for the whole rollup: every sub-computation
    # (current AND prev window) reuses the same parsed timestamps / status_history
    # transitions instead of re-deriving them per metric. Pure memoization of pure
    # lookups — outputs are byte-identical to the un-threaded path.
    timings: dict[int, _CaseTimings] = {}
    current = _window_filter(cases, window_hours=window_hours, now=now, _timings=timings)
    lifecycle = lifecycle_intervals(current, _timings=timings)
    quality = quality_metrics(current, _timings=timings)
    age = aging(current, now=now, _timings=timings)
    sla = sla_metrics(current, sla_policy, now=now, _timings=timings)

    # ``cases`` is the full fetched set here (window filtering is internal), so its
    # length IS the fetched count for the truncation comparison.
    marker = truncation_marker(len(cases), store_total)
    covered, coverage_reason, oldest_fetched_at = _window_coverage(
        cases,
        window_hours=window_hours,
        now=now,
        truncated=bool(marker["truncated"]),
        load_ok=load_ok,
        _timings=timings,
    )
    # A failed fetch is NOT a truncated one — ``truncation_marker`` is a pure function
    # of (fetched, store_total) shared by four rollups and stays untouched (#pinned).
    # The completeness flags carry the outage instead.
    if not load_ok:
        open_now_complete, open_now_reason = False, _LOAD_FAILED_REASON
    elif marker["truncated"]:
        open_now_complete, open_now_reason = False, (
            "the store held more cases than were fetched, so open cases older than "
            "the fetched rows are not counted; this is a lower bound"
        )
    else:
        open_now_complete, open_now_reason = True, ""

    rollup: dict[str, Any] = {
        "window_hours": window_hours,
        "generated_at": now.isoformat(),
        "case_count": len(current),
        # Partition of ``case_count`` by advisory severity band (sums to it exactly).
        "severity_counts": severity_band_counts(current, prefs=prefs),
        # A STOCK, not a cohort: measured over the whole fetched set at
        # ``generated_at``. ``window_exempt`` is on the wire so a consumer cannot
        # render it as a fifth summand of the windowed tiles.
        "open_now": {
            "count": open_case_count(cases),
            "window_exempt": True,
            "as_of": now.isoformat(),
            # A truncated fetch makes this a LOWER BOUND, and ``window_covered``
            # cannot rescue it: its population is the fetch, not the window. A FAILED
            # fetch makes it not a measurement at all.
            "complete": open_now_complete,
            "reason": open_now_reason,
        },
        "lifecycle": lifecycle,
        "quality": quality,
        "aging": age,
        "sla": sla,
        **marker,
        # Alongside the marker, never inside it: whether the SELECTED WINDOW is fully
        # answerable from the fetched rows even when the overall fetch was truncated.
        "window_covered": covered,
        "window_coverage_reason": coverage_reason,
        "oldest_fetched_at": oldest_fetched_at,
    }

    if compare == "prev" and window_hours > 0:
        prev_end = now.timestamp() - window_hours * 3600.0
        prev_window = [
            c
            for c in cases
            if (s := _timings_for(c, timings).created) is not None
            and prev_end - window_hours * 3600.0 <= s.timestamp() < prev_end
        ]
        prev_quality = quality_metrics(prev_window, _timings=timings)
        prev_life = lifecycle_intervals(prev_window, _timings=timings)
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
# Bucketed trends (the Overview hover-trendline feed).
# --------------------------------------------------------------------------- #

# The FROZEN bucket-width ladder for GET /api/metrics/trends: chosen so the bucket
# count for the canonical Console windows (24h/72h/168h/720h) lands in the 24-48
# range. Frozen contract — the Overview trendline is built against exactly this.
def _trend_bucket_minutes(window_hours: int) -> int:
    if window_hours <= 24:
        return 60
    if window_hours <= 72:
        return 180
    if window_hours <= 168:
        return 360
    return 1440


def trend_metrics(
    cases: list[Case],
    *,
    window_hours: int = 24,
    now: datetime | None = None,
    store_total: int | None = None,
    alert_counters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bucketed case-cohort trends over the trailing ``window_hours`` — the pure
    computation behind ``GET /api/metrics/trends`` (the Overview hover-trendline).

    ``window_hours`` is clamped to [1, 720]. Buckets are UTC, aligned to whole
    multiples of the bucket width (:func:`_trend_bucket_minutes` — 60/180/360/1440
    minutes, all whole-hour multiples), and zero-filled so they cover the entire
    window; the newest bucket is the current PARTIAL one.

    Cohort view: each case is attributed to the bucket its creation instant falls in
    (the same :func:`_created_dt` clock every posture window filter uses), and the
    per-bucket counts reuse EXACTLY the :func:`quality_metrics` semantics so the
    trendline reconciles with the posture tiles:

    * ``new_cases`` — every case created in the bucket (raw arrival volume,
      policy-closed included — matching posture's ``case_count``).
    * ``closed`` / ``auto_closed`` / ``false_positives`` / ``needs_human`` /
      ``escalated`` — the quality tallies over the bucket cohort (operator
      analyst-rule-policy closes excluded, exactly as ``quality_metrics`` excludes
      them: ``closed`` == its ``terminal_cases``, ``auto_closed`` == its
      ``decision_by==AGENT`` terminal tally, ``escalated`` == its escalated
      condition).
    * ``auto_closed`` / ``human_closed`` / ``system_closed`` — the three-way
      ``decision_by`` partition of ``closed``, over the SAME graded (policy-excluded)
      cohort: ``AGENT``, ``ANALYST``, and the honest RESIDUAL (``SYSTEM``
      deterministic routing plus legacy records with no recorded provenance).
      ``auto_closed + human_closed + system_closed == closed`` EXACTLY in every
      bucket and in total, so a Human-vs-AI card is a real partition; render
      ``system_closed`` as its own "system / unattributed" band and never fold it
      into either side (``closed - auto_closed`` is NOT human work). Cohort
      semantics are unchanged: a case is attributed to the bucket it was CREATED
      in, so this series answers "of the cases that arrived in this bucket, how many
      are NOW closed by a human vs by the agent" — never "how many closes happened
      this hour". A bucket whose cohort has no terminal case reports three real
      zeros, not nulls.

    HONESTY CAVEAT — ``decision_by`` is LAST-WRITER, not an immutable close author.
    Every analyst lifecycle action in ``api/routes.py`` (close, confirm_fp, reopen,
    escalate, deescalate, hold, resume, resolve, **acknowledge**, set_disposition,
    set_status) stamps ``decision_by = ANALYST`` unconditionally, and a same-status
    move is permitted — so an AGENT-auto-closed case a human later merely
    ACKNOWLEDGES or re-tags moves from ``auto_closed`` into ``human_closed``. These
    are LAST-recorded-decider tallies, not proof of who performed the close, and the
    UI must disclose that rather than claiming "the AI closed X%". See
    :func:`quality_metrics` for the full note; the predicate is deliberately left
    as-is so the shipped ``auto_closed`` series does not silently move.
    * ``sent_to_human`` — cohort cases counted ONCE that reached a human either
      way: verdict ``NEEDS_HUMAN`` or the escalated condition. ``needs_human``
      (a verdict tally) and ``escalated`` (a status/history tally) OVERLAP — an
      escalated NEEDS_HUMAN case is in both — so consumers must never sum them;
      this field is the honest single-count series for "sent to human".
    * ``fp_rate`` — ``false_positives / verdicted`` WITHIN the bucket (the same
      numerator/denominator as posture's ``false_positive_rate``), expressed 0-100;
      ``null`` when the bucket has no verdicted case.
    * ``alerts`` — raw ingested-alert volume from the durable noise counters'
      per-hour tallies summed into the bucket; ``null`` for every bucket when the
      counters are unavailable/warming up, and ``null`` for buckets that predate the
      counters' first observation (honest gap, never a fake 0).

    ``alert_counters`` is the (fail-open) result of
    ``NoiseCounterStore.read_hourly_ingested`` — ``{"available", "since",
    "hours": {epoch_hour: int}}`` — or None when the read failed.

    Pure + deterministic given ``cases``/``now``; advisory only — nothing here is
    ever read by ``case_manager.decide()`` (#3). Carries the same
    ``truncated``/``store_total``/``fetched`` honesty marker as the other rollups.
    """
    now = now or datetime.now(timezone.utc)
    window_hours = max(1, min(720, int(window_hours)))
    bucket_minutes = _trend_bucket_minutes(window_hours)
    bucket_secs = bucket_minutes * 60

    now_ts = now.timestamp()
    last_start = int(now_ts // bucket_secs) * bucket_secs
    first_start = int((now_ts - window_hours * 3600.0) // bucket_secs) * bucket_secs
    starts = list(range(first_start, last_start + 1, bucket_secs))

    # Attribute each case to its creation bucket (one timings parse per case).
    timings: dict[int, _CaseTimings] = {}
    cohorts: dict[int, list[Case]] = {s: [] for s in starts}
    for case in cases:
        created = _timings_for(case, timings).created
        if created is None:
            continue  # no usable timestamp → cannot honestly land in any bucket
        bucket = int(created.timestamp() // bucket_secs) * bucket_secs
        members = cohorts.get(bucket)
        if members is not None:
            members.append(case)

    # Per-hour ingested-alert tallies (already fail-open at the route).
    alerts_available = bool(alert_counters and alert_counters.get("available"))
    alert_hours: dict[int, int] = {}
    coverage_start_ts: float | None = None
    if alerts_available:
        for key, value in (alert_counters.get("hours") or {}).items():
            try:
                alert_hours[int(key)] = max(0, int(value))
            except (TypeError, ValueError):
                continue
        since_dt = _parse_iso(alert_counters.get("since"))
        coverage_start_ts = since_dt.timestamp() if since_dt is not None else None

    rows: list[dict[str, Any]] = []
    for start in starts:
        cohort = cohorts[start]
        # EXACTLY the quality_metrics population rule: analyst-rule-policy closes are
        # excluded from every tallied outcome (no model ran on them).
        graded = [c for c in cohort if not is_policy_closed(c)]
        verdicted = sum(1 for c in graded if c.verdict is not None)
        fp = sum(1 for c in graded if c.verdict == Verdict.FALSE_POSITIVE)
        nh = sum(1 for c in graded if c.verdict == Verdict.NEEDS_HUMAN)
        terminal = [c for c in graded if (c.status.value if c.status else "") in _TERMINAL]
        auto_closed = sum(1 for c in terminal if c.decision_by == DecisionBy.AGENT)
        human_closed = sum(1 for c in terminal if c.decision_by == DecisionBy.ANALYST)
        # Residual, so the partition can never over-attribute: SYSTEM routing and
        # legacy/absent provenance are neither agent nor human work.
        system_closed = len(terminal) - auto_closed - human_closed
        escalated = sum(
            1
            for c in graded
            if (c.status == CaseStatus.ESCALATED)
            or (c.escalation_level or 0) > 0
            or _timings_for(c, timings).escalated_any is not None
        )
        # Once-counted union: `needs_human` (verdict) and `escalated` (status/
        # history) overlap on an escalated NEEDS_HUMAN case — never sum them.
        sent_to_human = sum(
            1
            for c in graded
            if c.verdict == Verdict.NEEDS_HUMAN
            or (c.status == CaseStatus.ESCALATED)
            or (c.escalation_level or 0) > 0
            or _timings_for(c, timings).escalated_any is not None
        )

        alerts: int | None = None
        if alerts_available:
            end = start + bucket_secs
            # Buckets that end before the counters' first observation are an honest
            # null (the store was not recording yet), never a fabricated 0.
            if coverage_start_ts is None or end > coverage_start_ts:
                alerts = sum(
                    alert_hours.get(hour, 0)
                    for hour in range(start // 3600, end // 3600)
                )

        rows.append({
            "t": datetime.fromtimestamp(start, tz=timezone.utc).isoformat(),
            "new_cases": len(cohort),
            "closed": len(terminal),
            "auto_closed": auto_closed,
            "human_closed": human_closed,
            "system_closed": system_closed,
            "false_positives": fp,
            "needs_human": nh,
            "escalated": escalated,
            "sent_to_human": sent_to_human,
            "fp_rate": round(100.0 * fp / verdicted, 1) if verdicted else None,
            "alerts": alerts,
        })

    return {
        "window_hours": window_hours,
        "bucket_minutes": bucket_minutes,
        "generated_at": now.isoformat(),
        "buckets": rows,
        **truncation_marker(len(cases), store_total),
    }


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
