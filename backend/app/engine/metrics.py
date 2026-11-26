"""Deterministic metrics/analytics over the suite's own cases (SOC dashboards).

Pure aggregation functions over a list of ``Case`` objects (plus the existing
usage/cost ledger summary, merged by the route). No new storage, no LLM — these
power the analytics UI: verdict mix, status breakdown, persona and runbook usage,
average risk, the operational MTTR, a per-day case trend, and the AI-decision feedback
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

import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NamedTuple

from ..constants import (
    SEVERITY_BANDS,
    CaseStatus,
    DecisionBy,
    TERMINAL_CASE_STATUSES,
    Verdict,
)
from ..llm.provider_health import CHANNEL_COMPLETION
from ..models import Case
from .analyst_outcomes import analyst_confirmed_outcome
# The closable-verdict-class authority. Imported from ``case_manager`` ON PURPOSE so
# the recorded-auto-close analysis below can never drift from the code that actually
# closes cases (see ``classify_auto_close_gate``). READ-ONLY: this module is never
# imported by ``decide()`` and never feeds it (#3).
from .case_manager import _entry_for
from .precedent import is_policy_closed
from .priority import band_of_case
from .review_origin import is_review_grade

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


#: Assessments that compare the analyst's judgement with the agent's verdict. An
#: empty assessment is a grade with nothing to compare (see ``feedback_stats``).
_AGREEMENT_ASSESSMENTS = frozenset({"agree", "partial", "disagree"})


#: The 0..1 sub-scores a grade may rate (Console stars map to 0.2..1.0; 0.0 is unrated).
_FEEDBACK_SUBSCORES: tuple[str, ...] = ("accuracy", "reasoning_quality", "action_appropriateness")


def feedback_stats(cases: list[Case]) -> dict:
    """Aggregate analyst feedback across cases (the eval/quality loop).

    Excludes cases closed by an operator's analyst RULE POLICY: no model produced a
    verdict on them, so an analyst disagreeing (or agreeing) with a judgement that was
    never made says nothing about the agent's quality. The grade itself is still real
    ground truth and is counted as such by the tuner and the precedent projection — it
    is only this AGREEMENT-WITH-THE-AGENT view it must stay out of.

    Round 15 (SPEC D6.8): auto-close REVIEW grades (``engine.review_origin.
    is_review_grade``) are excluded for the same reason. The review sample is drawn only
    from automatic closes, so counting it here would shift the population this view
    describes; the review grade is still ground truth for the tuner and the precedent
    corpus. A case whose only grades are review grades is not a graded case here.

    ``agreement_rate`` is computed over AGREEMENT SIGNALS only — entries whose
    assessment is ``agree``/``partial``/``disagree``. A grade with no assessment (an
    analyst settling a NEEDS_HUMAN hand-off, a duplicate close, a case with no AI
    verdict) compares nothing, so it must neither inflate nor deflate agreement; it
    still counts toward ``feedback_count``. When there is no agreement signal at all the
    rate is ``None`` (honest, never a fake 0%) and ``agreement_signals`` says so
    explicitly.

    Round 15 (SPEC D4.5): each sub-score average (``avg_accuracy``,
    ``avg_reasoning_quality``, ``avg_action_appropriateness``) is taken over the
    entries that RATED it (a value above 0: the Console's stars map to 0.2..1.0 and an
    unrated sub-score is stored as 0.0), and ``accuracy_rated``,
    ``reasoning_quality_rated`` and ``action_appropriateness_rated`` count them. An
    average stays ``0.0`` when nothing rated it, so read it with its count: a ``0.0``
    sent by an API caller is read as "not rated". The stored grade shape is unchanged.
    """
    cases = [c for c in cases if not is_policy_closed(c)]
    entries: list[Any] = []
    graded_cases = 0
    for case in cases:
        own = [fb for fb in (case.feedback or []) if not is_review_grade(case, fb)]
        if own:
            graded_cases += 1
            entries.extend(own)
    rated_zero = {f"{name}_rated": 0 for name in _FEEDBACK_SUBSCORES}
    if not entries:
        # Round 16 (WP12, research explainability D10): nothing was graded, so there is
        # no agreement rate. ``None``, never ``0.0``: a 0% agreement would claim that
        # every graded case disagreed.
        return {
            "graded_cases": 0, "feedback_count": 0, "agreement_rate": None,
            "agreement_signals": 0,
            "agreement_agreed": 0, "agreement_partial": 0, "agreement_disagreed": 0,
            "avg_accuracy": 0.0, "avg_reasoning_quality": 0.0,
            "avg_action_appropriateness": 0.0, "time_saved_minutes": 0,
            "outcome_distribution": {},
            **rated_zero,
        }
    n = len(entries)
    assessments = [(e.assessment or "").strip().lower() for e in entries]
    signals = [a for a in assessments if a in _AGREEMENT_ASSESSMENTS]
    agree = sum(1 for a in signals if a == "agree")
    partial = sum(0.5 for a in signals if a == "partial")
    averages: dict[str, float] = {}
    rated: dict[str, int] = {}
    for name in _FEEDBACK_SUBSCORES:
        values = [_rated_value(getattr(e, name, 0.0)) for e in entries]
        given = [v for v in values if v is not None]
        rated[f"{name}_rated"] = len(given)
        averages[f"avg_{name}"] = round(sum(given) / len(given), 4) if given else 0.0
    return {
        "graded_cases": graded_cases,
        "feedback_count": n,
        "agreement_signals": len(signals),
        "agreement_rate": round((agree + partial) / len(signals), 4) if signals else None,
        # Round 16 (WP12, D10): the rate's population, so an explanation can print the
        # arithmetic: (agreed + 0.5 x partial) / agreement_signals, over grade ENTRIES
        # with an assessment (not graded cases).
        "agreement_agreed": agree,
        "agreement_partial": sum(1 for a in signals if a == "partial"),
        "agreement_disagreed": sum(1 for a in signals if a == "disagree"),
        **averages,
        "time_saved_minutes": int(sum(e.time_saved_minutes for e in entries)),
        "outcome_distribution": dict(Counter(e.actual_outcome for e in entries if e.actual_outcome)),
        **rated,
    }


def _rated_value(value: Any) -> float | None:
    """A sub-score that was rated (a finite value above 0), else ``None``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0.0:
        return None
    return number


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
    cases: list[Case],
    *,
    trend_days: int = 14,
    total_cases: int | None = None,
    counts: dict[str, Any] | None = None,
) -> dict:
    """Case analytics for the dashboard. Pure; deterministic given the inputs.

    ``counts`` (optional) carries EXACT store-wide headline counts —
    ``{"total": int, "by_status": {...}, "by_verdict": {...}, "by_disposition": {...}}``,
    any subset (``api.metrics_shared.fetch_case_breakdown``). Each part given replaces
    the tally over ``cases`` for ``total_cases`` / the status-derived counts / the
    breakdowns, so a store larger than the case list a caller could hold still reports
    exact counts. Every other figure is computed over ``cases``. Without ``counts`` the
    output is unchanged."""
    exact = counts if isinstance(counts, dict) else {}
    total = int(exact["total"]) if exact.get("total") is not None else len(cases)
    by_status = (
        Counter({str(k): int(v) for k, v in exact["by_status"].items()})
        if isinstance(exact.get("by_status"), dict)
        else Counter((c.status.value if c.status else "unknown") for c in cases)
    )
    by_verdict = (
        Counter({str(k): int(v) for k, v in exact["by_verdict"].items()})
        if isinstance(exact.get("by_verdict"), dict)
        else Counter((c.verdict.value if c.verdict else "none") for c in cases)
    )
    by_disposition = (
        Counter({str(k): int(v) for k, v in exact["by_disposition"].items()})
        if isinstance(exact.get("by_disposition"), dict)
        else Counter(
            (c.disposition.value if getattr(c, "disposition", None) else "undetermined")
            for c in cases
        )
    )
    by_persona = Counter((c.agent_persona or "generalist") for c in cases)
    # Round 14 SPEC §4.10.18: which Published runbook guided each case's investigation
    # (``Case.runbook_id``; "none" when no runbook reached the investigator). The
    # retired ``playbook_usage`` is kept for one release, read from the field earlier
    # runs wrote. Usage only: neither says a runbook caused a faster or slower case.
    by_runbook = Counter((getattr(c, "runbook_id", None) or "none") for c in cases)
    by_playbook = Counter((c.playbook_id or "none") for c in cases)

    risks = [c.risk_score for c in cases if isinstance(c.risk_score, (int, float))]
    avg_risk = round(sum(risks) / len(risks), 1) if risks else 0.0
    # How many scored cases the mean divides by (Round 16 numbers review): the Console
    # explains Average risk as "sum / N", and N was nowhere on the wire. Advisory only.
    avg_risk_case_count = len(risks)

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

    # Operational MTTR (Round 16 B59): the mean time from creation to the FIRST
    # terminal transition, over every terminal case (resolved and closed). It is the
    # same per-case clock as the lifecycle MTTR (``lifecycle_intervals``), so the two
    # agree on the same cases. A later edit (a comment, a tag, a grade) moves
    # ``updated_at`` but never this figure, and a reopened case is not resolved.
    # Round 16 (WP12, research explainability D3 and R9): the same samples also give the
    # lifecycle stat block (``mttr_lifecycle``: p50, p90, mean, max, count), the figure
    # the Analytics MTTR tile shows, and its split by decider (``mttr_by_decider``). The
    # mean ``mttr_minutes`` stays on the wire for one release.
    resolution_minutes: list[float] = []
    resolution_deciders: list[str] = []
    for c in cases:
        start, end = _created_dt(c), _resolved_dt(c)
        if start and end and end >= start:
            resolution_minutes.append((end - start).total_seconds() / 60.0)
            resolution_deciders.append(_decider_key(c))
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
        "runbook_usage": dict(by_runbook),
        "playbook_usage": dict(by_playbook),
        "avg_risk_score": avg_risk,
        "avg_risk_case_count": avg_risk_case_count,
        "active_risk_index": active_risk_index,
        "active_risk_case_count": active_risk_case_count,
        "mttr_minutes": mttr,
        "resolved_count": len(resolution_minutes),
        "mttr_lifecycle": _stat_block(resolution_minutes, missing_reason=LIFECYCLE_MISSING["mttr"]),
        "mttr_by_decider": mttr_by_decider(resolution_minutes, resolution_deciders),
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
    the case); dwell remains time-to-first-response (a distinct human-response metric).

    Round 16 (WP12): the samples come from :func:`lifecycle_samples`, the one loop the
    metric explanations (``GET /api/metrics/explain``) also read, so an explained median
    is always the median shown. ``mttr_by_decider`` (additive) splits the MTTR samples by
    the case's recorded decider (see :func:`mttr_by_decider`); its counts sum to
    ``mttr_minutes.count``."""
    samples = lifecycle_samples(cases, _timings=_timings)
    return {
        "mtta_minutes": _stat_block(samples["mtta"], missing_reason=LIFECYCLE_MISSING["mtta"]),
        "mttr_minutes": _stat_block(samples["mttr"], missing_reason=LIFECYCLE_MISSING["mttr"]),
        "dwell_minutes": _stat_block(samples["dwell"], missing_reason=LIFECYCLE_MISSING["dwell"]),
        "mttd_minutes": _stat_block(samples["mttd"], missing_reason=LIFECYCLE_MISSING["mttd"]),
        "mttr_by_decider": mttr_by_decider(samples["mttr"], samples["mttr_deciders"]),
    }


#: Why a lifecycle block is not measured, per clock (the ``_stat_block`` reasons).
LIFECYCLE_MISSING: dict[str, str] = {
    "mtta": "no case has been acknowledged yet",
    "mttr": "no case has been resolved/closed yet",
    # Dwell counts a person's response only: an automatic close is not one.
    "dwell": "no case has received a first response from a person yet",
    "mttd": "detection latency not available yet",
}

#: The deciders an MTTR sample is split by (Round 16 WP12, research explainability D3):
#: the case's recorded ``decision_by`` (agent, analyst, analyst_policy, system), and
#: ``unrecorded`` for a case that records none, so the split always sums to the total.
MTTR_DECIDERS: tuple[str, ...] = ("agent", "analyst", "analyst_policy", "system", "unrecorded")


class IntervalSample(NamedTuple):
    """One lifecycle sample with the records behind it (``detail=True``)."""

    minutes: float
    case: Case
    start: datetime | None
    end: datetime
    start_anchor: str
    end_anchor: str


def _decider_key(case: Case) -> str:
    """The case's recorded decider as an ``MTTR_DECIDERS`` key. This is the LAST
    recorded decider (see the caveat in :func:`quality_metrics`), not proof of who
    performed the close."""
    raw = getattr(case, "decision_by", None)
    value = str(getattr(raw, "value", raw) or "").strip().lower()
    return value if value in MTTR_DECIDERS[:-1] else "unrecorded"


def mttr_by_decider(minutes: list[Any], deciders: list[str]) -> dict[str, Any]:
    """The MTTR samples split by decider: one ``_stat_block`` per ``MTTR_DECIDERS`` key,
    over the samples whose case records that decider. ``minutes`` and ``deciders`` are
    parallel lists (floats or :class:`IntervalSample`); the counts sum to the total."""
    groups: dict[str, list[float]] = {key: [] for key in MTTR_DECIDERS}
    for value, decider in zip(minutes, deciders):
        number = value.minutes if isinstance(value, IntervalSample) else value
        groups[decider if decider in groups else "unrecorded"].append(float(number))
    return {
        key: _stat_block(values, missing_reason="no case in this group was resolved or closed")
        for key, values in groups.items()
    }


def _from_millis(value: float) -> datetime | None:
    try:
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def lifecycle_samples(
    cases: list[Case],
    *,
    _timings: dict[int, _CaseTimings] | None = None,
    detail: bool = False,
) -> dict[str, list[Any]]:
    """The samples behind :func:`lifecycle_intervals`, in one pass over ``cases``.

    Returns ``{"mtta", "mttr", "dwell", "mttd": [minutes, ...], "mttr_deciders":
    [decider, ...]}`` (``mttr_deciders`` is parallel to ``mttr``). With ``detail`` each
    sample is an :class:`IntervalSample` naming its case, its start and end instants
    and the record each came from, for the metric explanations; without it each sample
    is the plain float, so the posture rollup pays nothing extra. The minutes are the
    same floats either way (one computation), so an explanation's median is the
    rollup's median. Pure and advisory (#3)."""
    mtta: list[Any] = []
    mttr: list[Any] = []
    dwell: list[Any] = []
    mttd: list[Any] = []
    mttr_deciders: list[str] = []

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
                    minutes = (created_ms - fs) / 60000.0
                    mttd.append(
                        IntervalSample(minutes, case, _from_millis(fs), created,
                                       "first_seen_millis", "created_at")
                        if detail else minutes
                    )

        start = timings.created
        if start is None:
            continue
        start_anchor = ""
        if detail:
            start_anchor = "detected_at" if _as_dt(case.detected_at) is not None else "created_at"

        ack = timings.ack_anchor or timings.ack_human
        if ack and ack >= start:
            minutes = (ack - start).total_seconds() / 60.0
            mtta.append(
                IntervalSample(minutes, case, start, ack, start_anchor,
                               "acknowledged_at" if timings.ack_anchor else "status_history")
                if detail else minutes
            )

        resp = timings.resp_anchor or timings.resp_human
        if resp and resp >= start:
            minutes = (resp - start).total_seconds() / 60.0
            dwell.append(
                IntervalSample(minutes, case, start, resp, start_anchor,
                               "first_response_at" if timings.resp_anchor else "status_history")
                if detail else minutes
            )

        end = _resolved_dt(case, timings)  # guarded: a reopened (currently-open) case isn't resolved
        if end and end >= start:
            minutes = (end - start).total_seconds() / 60.0
            mttr.append(
                IntervalSample(minutes, case, start, end, start_anchor,
                               "status_history" if timings.terminal_any is not None else "updated_at")
                if detail else minutes
            )
            mttr_deciders.append(_decider_key(case))

    return {"mtta": mtta, "mttr": mttr, "dwell": dwell, "mttd": mttd, "mttr_deciders": mttr_deciders}


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


def analyst_confirmed_fp_count(cases: list[Case]) -> int:
    """How many ``cases`` an ANALYST independently confirmed as false positive.

    The same ground-truth authority the threshold tuner and the precedent projection
    use (:func:`app.engine.analyst_outcomes.analyst_confirmed_outcome`): graded feedback,
    or an explicit analyst classification. A model verdict, a model-derived
    disposition or a bare close is never counted. Advisory reporting only (#3)."""
    count = 0
    for case in cases:
        try:
            outcome, _source = analyst_confirmed_outcome(case)
        except Exception:  # noqa: BLE001 — a malformed case is not ground truth
            continue
        if outcome == "false_positive":
            count += 1
    return count


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

    .. deprecated:: ``automation_rate`` only — the rest of this rollup is current

       The non-erasable predicate the caveat above points at now EXISTS, in
       :func:`recorded_auto_close_health`, and reports the same quantity from the
       append-only decision trail with FIRST-decision anchoring. ``automation_rate``
       here stays byte-identical (creation-cohort bucketed, mutable ``decision_by``)
       so the shipped series does not move; the two are expected to differ and the
       difference is documented at that function. Prefer it for new surfaces.
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
    analyst_fp = analyst_confirmed_fp_count(cases)

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
        # Beside the AI-verdict FP rate: how many of the same cases an ANALYST
        # independently confirmed as false positive (graded feedback or an explicit
        # classification — ``analyst_outcomes.analyst_confirmed_outcome``, the ground
        # truth the tuner and precedent use). A count, not a rate: most cases are never
        # graded, so a rate over this population would describe grading coverage.
        "analyst_confirmed_fp": analyst_fp,
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


def _sla_priority(case: Case, prefs: Any) -> str:
    """The P-level an SLA target is looked up by: the persisted ``priority_level``, else
    — when ``prefs`` are supplied — the SAME read-time ITIL projection the case list and
    detail show (``engine.priority.advisory_bands``). No production path persists the
    level, so without the projection no real case could ever be scored."""
    level = case.priority_level or ""
    if level or prefs is None:
        return level
    try:
        from .priority import advisory_bands

        return str(advisory_bands(case, prefs).get("priority_level") or "")
    except Exception:  # noqa: BLE001 — advisory only; an unscorable case is skipped
        return ""


#: A clock that still runs is "at risk" once this share of its target has passed (the
#: explain contract's ``sla.at_risk_fraction``).
SLA_AT_RISK_FRACTION = 0.8


@dataclass(frozen=True)
class SlaClockReading:
    """One SLA clock of one case at ``now`` (see :func:`sla_case_reading`).

    ``stop`` is the instant the clock stopped, or ``None`` while it still runs; then
    ``running`` is true and ``elapsed_minutes`` runs to ``now``. ``stop_source`` names
    the record that stopped it:

    * response clock: ``first_response_at``, ``acknowledged_at`` or
      ``status_history`` (the first human status move into a response status,
      :func:`first_human_response`), or ``terminal`` (the case was closed or
      resolved before any human response, so the clock stops at that instant);
    * resolution clock: ``status_history`` (the first terminal transition) or
      ``updated_at`` (a terminal case with no recorded transition).

    ``state`` is ``breached`` (over the target, running or stopped), ``at_risk``
    (still running and at least :data:`SLA_AT_RISK_FRACTION` of the target has
    passed) or ``ok``. ``elapsed_minutes`` is unrounded; callers round for display."""

    clock: str  # "response" | "resolution"
    target_minutes: float
    start: datetime
    due_at: datetime
    stop: datetime | None
    stop_source: str
    elapsed_minutes: float
    running: bool
    state: str  # "breached" | "at_risk" | "ok"

    def as_dict(self) -> dict[str, Any]:
        return {
            "clock": self.clock,
            "target_minutes": self.target_minutes,
            "start": self.start.isoformat(),
            "due_at": self.due_at.isoformat(),
            "stop": self.stop.isoformat() if self.stop is not None else None,
            "stop_source": self.stop_source,
            "elapsed_minutes": self.elapsed_minutes,
            "running": self.running,
            "state": self.state,
        }


@dataclass(frozen=True)
class SlaCaseReading:
    """Both SLA clocks of one case (see :func:`sla_case_reading`). ``start`` is
    ``None`` when the case has no readable creation time (then both clocks are
    ``None``: it cannot be scored). A clock is ``None`` when its target is not set,
    or when the case is terminal but no terminal instant can be read: a closed case
    never runs a live clock."""

    start: datetime | None
    start_source: str  # "detected_at" | "created_at" | ""
    terminal: bool
    response: SlaClockReading | None
    resolution: SlaClockReading | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "start": self.start.isoformat() if self.start is not None else None,
            "start_source": self.start_source,
            "terminal": self.terminal,
            "response": self.response.as_dict() if self.response is not None else None,
            "resolution": self.resolution.as_dict() if self.resolution is not None else None,
        }


def first_human_response(timings: _CaseTimings) -> tuple[datetime | None, str]:
    """The first human response to a case and the record that holds it: the earliest
    of ``first_response_at``, ``acknowledged_at`` (an acknowledgement stops the clock
    even when the case was already investigating, so no status move was recorded)
    and the first status move a person made into a response status. A system or
    agent move never counts (audit #9): an auto-escalation at creation is not a
    response. ``(None, "")`` when no person has responded. Shared by
    :func:`sla_case_reading` and the Standup SLA aging, so the two cannot drift."""
    best: datetime | None = None
    source = ""
    for value, name in (
        (timings.resp_anchor, "first_response_at"),
        (timings.ack_anchor, "acknowledged_at"),
        (timings.resp_human, "status_history"),
    ):
        if value is not None and (best is None or value < best):
            best, source = value, name
    return best, source


def _sla_clock(
    clock: str, target_minutes: float, start: datetime, stop: datetime | None,
    stop_source: str, now: datetime,
) -> SlaClockReading:
    running = stop is None
    elapsed = ((stop or now) - start).total_seconds() / 60.0
    if elapsed > target_minutes:
        state = "breached"
    elif running and elapsed >= target_minutes * SLA_AT_RISK_FRACTION:
        state = "at_risk"
    else:
        state = "ok"
    try:
        due_at = start + timedelta(minutes=target_minutes)
    except (OverflowError, ValueError):
        # A target so large its due instant is past the last representable time
        # (SlaTarget has no upper bound): the clock is simply never due.
        due_at = datetime.max.replace(tzinfo=timezone.utc)
    return SlaClockReading(
        clock=clock, target_minutes=target_minutes, start=start,
        due_at=due_at, stop=stop,
        stop_source=stop_source if stop is not None else "", elapsed_minutes=elapsed,
        running=running, state=state,
    )


def sla_case_reading(
    case: Case,
    target: Any,
    timings: _CaseTimings | None,
    *,
    now: datetime,
) -> SlaCaseReading:
    """The per-case SLA clock rules, in one pure function (Round 16 B26, with B58).
    :func:`sla_metrics` counts its readings; the case-level SLA reading
    (``engine/sla_reading.py``) reuses it, so the two can never disagree.

    ``target`` is the case's ``SlaTarget`` (``response_minutes``, ``resolve_minutes``;
    a value of 0 or less means no target for that clock). ``timings`` is the case's
    :class:`_CaseTimings` (``None`` builds it). Both clocks start at the detection
    instant when recorded, else at creation.

    * **Response.** Stops at the first human response (:func:`first_human_response`).
      A terminal case stops it at its terminal instant at the latest: a case the
      agent closed before anyone responded is no longer awaiting a response, so the
      clock stops at the close. An auto-close inside the target is met; one after
      the target is a late response of fixed size that never grows. A genuinely
      open, unresponded case keeps the live clock.
    * **Resolution.** Stops at the first terminal transition (``updated_at`` for a
      terminal case with no recorded transition), only while the case is terminal
      now: a reopened case runs its clock again (the :func:`_resolved_dt` rule).
    * **State.** Breached when the elapsed time is over the target; at risk when the
      clock still runs and at least :data:`SLA_AT_RISK_FRACTION` of the target has
      passed; otherwise ok.

    Pure and advisory (#3): it reads the case, never changes it, and never feeds
    ``decide()``. Never raises on a malformed case."""
    timings = timings if timings is not None else _CaseTimings(case)
    terminal = (case.status.value if case.status else "") in _TERMINAL
    start = timings.created
    if start is None:
        return SlaCaseReading(start=None, start_source="", terminal=terminal, response=None, resolution=None)
    start_source = "detected_at" if _as_dt(case.detected_at) is not None else "created_at"
    end = _resolved_dt(case, timings)  # None unless the case is terminal now
    end_source = "status_history" if timings.terminal_any is not None else "updated_at"

    response: SlaClockReading | None = None
    response_minutes = float(getattr(target, "response_minutes", 0) or 0)
    if response_minutes > 0:
        stop, source = first_human_response(timings)
        if terminal and end is not None and (stop is None or end < stop):
            stop, source = end, "terminal"
        if stop is not None or not terminal:
            response = _sla_clock("response", response_minutes, start, stop, source, now)

    resolution: SlaClockReading | None = None
    resolve_minutes = float(getattr(target, "resolve_minutes", 0) or 0)
    if resolve_minutes > 0 and (end is not None or not terminal):
        resolution = _sla_clock("resolution", resolve_minutes, start, end, end_source, now)

    return SlaCaseReading(
        start=start, start_source=start_source, terminal=terminal,
        response=response, resolution=resolution,
    )


def sla_metrics(
    cases: list[Case],
    sla_policy: Any,
    *,
    now: datetime | None = None,
    _timings: dict[int, _CaseTimings] | None = None,
    prefs: Any = None,
) -> dict[str, Any]:
    """SLA attainment vs ``Preferences.sla`` (response + resolve targets per P-level).

    DETERMINISTIC + advisory (#3): we compare each case's elapsed response/resolution
    time against the target for its P-level and classify it breached / at-risk (>=80%
    of target, not yet met) / ok. SLA classification NEVER feeds ``decide()``. Returns
    ``enabled:false`` (untouched today) when the policy is off so the existing
    behaviour is byte-identical. Each case is read by :func:`sla_case_reading` (the
    one home of the clock rules), so a case the agent closed stops its response clock
    at the close and never turns into a breach as time passes.

    The P-level is the persisted ``priority_level`` or, with ``prefs`` (the posture
    route passes them), the read-time ITIL projection an analyst sees on the case (see
    :func:`_sla_priority`). ``attainment_pct`` is ``None`` when no case was scored."""
    now = now or datetime.now(timezone.utc)
    enabled = bool(getattr(sla_policy, "enabled", False))
    targets = getattr(sla_policy, "targets", {}) or {}
    if not enabled or not targets:
        return {"enabled": False, "evaluated": 0, "reason": "SLA policy disabled or no targets"}

    tally = {
        ("response", "breached"): 0, ("response", "at_risk"): 0,
        ("resolution", "breached"): 0, ("resolution", "at_risk"): 0,
    }
    evaluated = 0
    no_target = no_clock = 0
    breaching: list[dict[str, Any]] = []

    for c in cases:
        prio = _sla_priority(c, prefs)
        target = targets.get(prio)
        if target is None:
            no_target += 1
            continue  # no target for this (or no) priority → not SLA-scored
        # The per-case clock rules (response anchor, terminal stop, resolution
        # fallback, at-risk) live in ``sla_case_reading`` (Round 16 B26).
        reading = sla_case_reading(c, target, _timings_for(c, _timings), now=now)
        if reading.start is None:
            # Unparseable created_at → no clock to measure. Exclude from the
            # attainment denominator (matching the guard-before-count idiom used
            # everywhere else in this file) so a corrupted doc can neither inflate
            # ``evaluated`` nor be silently scored as SLA-met.
            no_clock += 1
            continue
        evaluated += 1
        for clock in (reading.response, reading.resolution):
            if clock is None or clock.state == "ok":
                continue
            tally[(clock.clock, clock.state)] += 1
            breaching.append(
                _breach_row(c, clock.clock, clock.elapsed_minutes, clock.target_minutes, clock.state, prio)
            )
    response_breached = tally[("response", "breached")]
    response_at_risk = tally[("response", "at_risk")]
    resolve_breached = tally[("resolution", "breached")]
    resolve_at_risk = tally[("resolution", "at_risk")]

    met = evaluated - len({b["case_id"] for b in breaching if b["state"] == "breached"})
    return {
        "enabled": True,
        "evaluated": evaluated,
        "response_breached": response_breached,
        "response_at_risk": response_at_risk,
        "resolve_breached": resolve_breached,
        "resolve_at_risk": resolve_at_risk,
        # ``None`` — never 0.0 — when no case could be scored: "0% attainment" is a
        # claim that every scored case breached, and nothing was scored (a case scores
        # only when it carries a priority level with a configured target). The UI
        # renders the dash; ``attainment_reason`` says why.
        "attainment_pct": round(100.0 * met / evaluated, 1) if evaluated else None,
        "attainment_reason": (
            "" if evaluated else _sla_unmeasured_reason(len(cases), no_target, no_clock)
        ),
        "breaching": sorted(breaching, key=lambda b: -b["over_pct"])[:25],
    }


def _sla_unmeasured_reason(total: int, no_target: int, no_clock: int) -> str:
    """Why SLA attainment was not measured, from what actually happened — an empty
    window, cases without a usable creation time, or cases whose priority has no
    configured target — so the dash points the operator at the real cause."""
    if total == 0:
        return "no cases in this window, so attainment was not measured"
    parts: list[str] = []
    if no_clock:
        parts.append(
            f"{no_clock} case{'s have' if no_clock != 1 else ' has'} no readable creation time"
        )
    if no_target:
        parts.append(
            f"{no_target} case{'s have' if no_target != 1 else ' has'} no priority with an "
            "SLA target"
        )
    if not parts:  # defensive: every case was skipped for a reason counted above
        return "no case could be scored, so attainment was not measured"
    return " and ".join(parts) + ", so attainment was not measured"


def _breach_row(
    case: Case, clock: str, elapsed: float, target: float, state: str, priority: str = "",
) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "case_number": case.case_number or case.case_id,
        "priority": priority or case.priority_level or "",
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
    """Cases created within the last ``window_hours``: ``cutoff <= created <= now``
    (0/negative → no filter).

    A case with an UNPARSEABLE created_at has no usable timestamp, so it cannot
    honestly be attributed to any time bucket: it is excluded from EVERY bounded
    window (current AND prev). This keeps the current/prev filters symmetric — the
    prev-window comprehension in ``posture_metrics`` already drops null-date cases,
    so counting them here would create a one-sided period-over-period delta. A case
    stamped AFTER ``now`` (clock skew) is not in the trailing window either. This is
    the same membership rule as the exact aggregates chat reads
    (``engine.case_aggregate``), so chat and the dashboards count the same cases. The
    ``window_hours <= 0`` escape still returns everything (the no-window path)."""
    if window_hours <= 0:
        return list(cases)
    now = now or datetime.now(timezone.utc)
    now_ts = now.timestamp()
    cutoff = now_ts - float(window_hours) * 3600.0
    out: list[Case] = []
    for c in cases:
        start = _timings_for(c, _timings).created if _timings is not None else _created_dt(c)
        if start is not None and cutoff <= start.timestamp() <= now_ts:
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
    read_error: str | None = None,
    newest_first: bool = True,
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

    ``read_error`` names a store failure that stopped the read partway (the rows read
    are then a partial population); ``newest_first=False`` says the rows read are NOT
    the newest ones (a partial read that was not in creation order), so the floor
    argument above does not hold and a truncated read can never be proven to cover the
    window. Either way the reason names the failure.

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
    failure = (
        f"the case store stopped answering partway through the read ({read_error}), so "
        "not every case in the selected window was read"
        if read_error else ""
    )
    if not newest_first:
        return (
            False,
            failure or (
                "the cases read are not the newest ones, so the unread cases cannot be "
                "shown to fall outside the selected window"
            ),
            floor_iso,
        )
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
    cutoff = now.timestamp() - float(window_hours) * 3600.0
    if cutoff >= floor.timestamp():
        return True, "", floor_iso
    return (
        False,
        failure or (
            "the fetch was truncated and the selected window starts before the oldest "
            "fetched case, so cases inside the window were not read"
        ),
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
    open_now_count: int | None = None,
    open_now_unavailable: str | None = None,
    read_error: str | None = None,
    newest_first: bool = True,
) -> dict[str, Any]:
    """The rich security-posture rollup: lifecycle + quality + aging + SLA + a few
    period-over-period headline comparisons. Pure + deterministic; advisory only (#3).

    ``cases`` is the FULL fetched set (up to the route's store fetch bound); this
    function time-bounds it to ``window_hours`` internally. When ``compare == 'prev'``
    it also computes the immediately-preceding equal-length window for delta% on the
    headline numbers. ``store_total`` is the store's reported total (when the fetch was
    capped) so the response can flag a truncated/partial rollup honestly rather than
    silently returning a wrong number computed over only the newest N cases.

    ``prefs`` (optional, ``Preferences``) is threaded into the two read-time
    projections: the severity band behind ``severity_counts``, and the ITIL priority an
    SLA target is looked up by (``sla_metrics``; no production path persists
    ``priority_level``, so without it no real case is SLA-scored). Omitting it leaves
    every other number byte-identical and bands on the identity ceiling (see
    :func:`severity_band_counts`).

    ``load_ok=False`` says the caller's case fetch FAILED (the route soft-fails to an
    empty list so a dashboard never 500s). Every count below is then computed over zero
    rows, which is a number but not a measurement — so the two completeness assertions,
    ``open_now.complete`` and ``window_covered``, are forced False with a reason naming
    the failure. They are the flags that license a tile to publish, and an outage is
    exactly when they must not.

    ``open_now_count`` (optional) is the EXACT window-exempt open stock counted by the
    store (``engine.case_aggregate`` push-down). The route passes it because it hands
    this function only the cases its windows need, not the whole store; when given,
    ``open_now`` reports it as a complete measurement instead of re-counting the
    supplied list (which would then be a lower bound). Omitted, the legacy behaviour
    — count over ``cases``, complete only when the fetch was not truncated — stands.
    ``open_now_unavailable`` (a reason) says the stock could NOT be counted although
    ``cases`` is only a windowed population: the list count is then published as an
    incomplete lower bound with that reason.

    ``read_error`` / ``newest_first`` describe a PARTIAL read (the store failed partway,
    and whether the rows read were still the newest ones); they flow into
    ``window_covered`` so a partial read is never certified as covering the window.

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
    sla = sla_metrics(current, sla_policy, now=now, _timings=timings, prefs=prefs)

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
        read_error=read_error,
        newest_first=newest_first,
    )
    # A failed fetch is NOT a truncated one — ``truncation_marker`` is a pure function
    # of (fetched, store_total) shared by four rollups and stays untouched (#pinned).
    # The completeness flags carry the outage instead.
    open_count = open_case_count(cases)
    if not load_ok:
        open_now_complete, open_now_reason = False, _LOAD_FAILED_REASON
    elif open_now_count is not None:
        open_count = max(0, int(open_now_count))
        open_now_complete, open_now_reason = True, ""
    elif open_now_unavailable:
        open_now_complete, open_now_reason = False, str(open_now_unavailable)
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
            "count": open_count,
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
            "analyst_confirmed_fp": _compare_block(
                quality["analyst_confirmed_fp"], prev_quality["analyst_confirmed_fp"]
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
# Metric explanations (Round 16 WP12; research explainability D-API-4, R8, R9).
#
# ``GET /api/metrics/explain`` lists the cases behind one dashboard figure so a reader
# can cross-check it. Every figure here is computed by the SAME code as the figure it
# explains (the posture window filter, ``lifecycle_samples``, ``_stat_block``,
# ``sla_case_reading``), so an explained median is the median shown. Ids, enums and
# our own numbers only (#7); pure and advisory (#3).
# --------------------------------------------------------------------------- #

#: The figures the explain route answers for.
EXPLAIN_METRICS: tuple[str, ...] = (
    "mtta", "mttr", "dwell", "mttd", "active_risk_index", "fp_rate", "sla_attainment",
)
#: The timing figures and the lifecycle block each one is.
EXPLAIN_TIMINGS: dict[str, str] = {
    "mtta": "mtta_minutes", "mttr": "mttr_minutes", "dwell": "dwell_minutes", "mttd": "mttd_minutes",
}
#: The most sample rows one explanation returns.
EXPLAIN_MAX_SAMPLES = 200

_EXPLAIN_POPULATION: dict[str, str] = {
    "mtta": "Cases created in {window} that a person acknowledged, or moved to investigating, escalated or on hold.",
    "mttr": "Cases created in {window} that are resolved or closed now.",
    "dwell": (
        "Cases created in {window} that a person responded to: acknowledged, or moved to "
        "investigating, escalated, on hold, resolved or closed. Automatic and analyst rule "
        "policy closes are not counted."
    ),
    "mttd": "Cases created in {window} whose first event time is recorded.",
    "active_risk_index": "Every case that is not resolved or closed, all time.",
    "fp_rate": "Cases created in {window} with an AI verdict, without the cases an analyst rule policy closed.",
    "sla_attainment": "Cases created in {window} whose priority has an SLA target.",
}


def _window_words(window_hours: int) -> str:
    if window_hours <= 0:
        return "all time"
    if window_hours % 24 == 0 and window_hours > 48:
        return f"the last {window_hours // 24} days"
    return f"the last {window_hours} hours"


def _iso_or_none(value: datetime | None) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _case_ref(case: Case) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "case_number": case.case_number or case.case_id,
        "status": case.status.value if case.status else "",
    }


def _select_rows(rows: list[Any], *, max_samples: int, centre_rank: float | None) -> tuple[list[Any], int]:
    """At most ``max_samples`` rows and the rank of the first one. With more rows than
    that, a timing explanation keeps the run centred on the median rank (so the two
    values the median interpolates between are always listed) and the others keep the
    first rows of their order."""
    if len(rows) <= max_samples:
        return rows, 0
    if centre_rank is None:
        return rows[:max_samples], 0
    start = int(math.floor(centre_rank)) - max_samples // 2 + 1
    start = max(0, min(start, len(rows) - max_samples))
    return rows[start:start + max_samples], start


def _sample_payload(
    rows: list[Any], cases_of: Callable[[Any], Case], visible: Callable[[Case], bool] | None,
    *, max_samples: int, centre: bool,
) -> dict[str, Any]:
    shown = [r for r in rows if visible is None or visible(cases_of(r))]
    chosen, offset = _select_rows(
        shown, max_samples=max_samples, centre_rank=(0.5 * (len(shown) - 1)) if centre and shown else None,
    )
    return {
        "chosen": chosen,
        "sample_count": len(rows),
        "visible_count": len(shown),
        "hidden_by_scope": len(rows) - len(shown),
        "samples_offset": offset,
        "samples_truncated": len(chosen) < len(shown),
    }


def explain_metric(
    cases: list[Case],
    metric: str,
    *,
    window_hours: int = 24,
    now: datetime | None = None,
    sla_policy: Any = None,
    prefs: Any = None,
    visible: Callable[[Case], bool] | None = None,
    max_samples: int = EXPLAIN_MAX_SAMPLES,
) -> dict[str, Any]:
    """The explanation of one dashboard figure over ``cases`` (the route's population).

    * ``mtta``, ``mttr``, ``dwell``, ``mttd``: the posture lifecycle block for the window
      (``stat``: p50, p90, mean, max, count) and its samples sorted by minutes, each
      naming its case, start and end instants and the record each came from. With more
      than ``max_samples`` samples the run around the median rank is listed and
      ``samples_offset`` is the rank of its first row. ``mttr`` adds ``by_decider``.
    * ``active_risk_index``: the mean risk score of every case that is not resolved or
      closed (``GET /api/metrics``), with its sum and count; rows by risk, highest first.
    * ``fp_rate``: false-positive verdicts over verdicted cases (posture ``quality``),
      analyst-policy closes left out; rows are the verdicted cases, the counted ones first.
    * ``sla_attainment``: met over evaluated (posture ``sla``); rows are the evaluated
      cases, breached first.

    ``visible`` (optional) says which cases the caller may see (object scope); a hidden
    case still counts in the figure and in ``sample_count`` but is left out of the rows,
    and ``hidden_by_scope`` says how many were. Pure; never raises on a malformed case."""
    now = now or datetime.now(timezone.utc)
    wh = max(0, int(window_hours))
    if metric not in EXPLAIN_METRICS:
        raise ValueError(f"unknown metric {metric!r}")
    window = "all time" if metric == "active_risk_index" else _window_words(wh)
    base: dict[str, Any] = {
        "metric": metric,
        "window_hours": 0 if metric == "active_risk_index" else wh,
        "window": window,
        "generated_at": now.isoformat(),
        "population": _EXPLAIN_POPULATION[metric].format(window=window),
    }
    timings: dict[int, _CaseTimings] = {}
    current = cases if metric == "active_risk_index" else _window_filter(
        cases, window_hours=wh, now=now, _timings=timings,
    )
    base["population_size"] = len(current)

    if metric in EXPLAIN_TIMINGS:
        samples = lifecycle_samples(current, _timings=timings, detail=True)[metric]
        block = _stat_block([s.minutes for s in samples], missing_reason=LIFECYCLE_MISSING[metric])
        ordered = sorted(samples, key=lambda s: (s.minutes, s.case.case_id))
        picked = _sample_payload(ordered, lambda s: s.case, visible, max_samples=max_samples, centre=True)
        rows = [
            {
                **_case_ref(s.case),
                "value": round(s.minutes, 4),
                "minutes": round(s.minutes, 4),
                "start_at": _iso_or_none(s.start),
                "end_at": _iso_or_none(s.end),
                "start_anchor": s.start_anchor,
                "anchor": s.end_anchor,
                "decided_by": _decider_key(s.case),
            }
            for s in picked.pop("chosen")
        ]
        out = {
            **base, "kind": "timing", "unit": "minutes", "headline": "p50",
            "value": block["p50"], "available": block["available"], "reason": block["reason"],
            "stat": block, **picked, "samples": rows, "samples_order": "minutes_ascending",
        }
        if metric == "mttr":
            out["by_decider"] = mttr_by_decider(samples, [_decider_key(s.case) for s in samples])
        return out

    if metric == "active_risk_index":
        active = [
            c for c in current
            if isinstance(c.risk_score, (int, float))
            and (c.status.value if c.status else "") not in TERMINAL_CASE_STATUSES
        ]
        total = sum(float(c.risk_score) for c in active)
        count = len(active)
        ordered = sorted(active, key=lambda c: (-float(c.risk_score), c.case_id))
        picked = _sample_payload(ordered, lambda c: c, visible, max_samples=max_samples, centre=False)
        rows = [{**_case_ref(c), "value": round(float(c.risk_score), 2)} for c in picked.pop("chosen")]
        return {
            **base, "kind": "mean", "unit": "score", "headline": "mean",
            "value": round(total / count, 1) if count else None,
            "available": bool(count),
            "reason": "" if count else "no case is open, so there is no index",
            "numerator": round(total, 2), "denominator": count,
            **picked, "samples": rows, "samples_order": "value_descending",
        }

    if metric == "fp_rate":
        agent_worked = [c for c in current if not is_policy_closed(c)]
        verdicted = [c for c in agent_worked if c.verdict is not None]
        fp = sum(1 for c in verdicted if c.verdict == Verdict.FALSE_POSITIVE)
        ordered = sorted(
            verdicted,
            key=lambda c: (c.verdict != Verdict.FALSE_POSITIVE, -(_created_ts(c)), c.case_id),
        )
        picked = _sample_payload(ordered, lambda c: c, visible, max_samples=max_samples, centre=False)
        rows = [
            {
                **_case_ref(c),
                "value": 1 if c.verdict == Verdict.FALSE_POSITIVE else 0,
                "verdict": c.verdict.value if c.verdict else "",
                "counted": c.verdict == Verdict.FALSE_POSITIVE,
                "created_at": c.created_at,
            }
            for c in picked.pop("chosen")
        ]
        return {
            **base, "kind": "ratio", "unit": "fraction", "headline": "ratio",
            "value": _ratio(fp, len(verdicted)) if verdicted else None,
            "available": bool(verdicted),
            "reason": "" if verdicted else "no case in this window has an AI verdict",
            "numerator": fp, "denominator": len(verdicted),
            "policy_closed": len(current) - len(agent_worked),
            **picked, "samples": rows, "samples_order": "counted_first_newest_first",
        }

    # sla_attainment: the same readings ``sla_metrics`` counts.
    summary = sla_metrics(current, sla_policy, now=now, _timings=timings, prefs=prefs)
    if not summary.get("enabled"):
        return {
            **base, "kind": "ratio", "unit": "percent", "headline": "ratio", "value": None,
            "available": False, "reason": str(summary.get("reason") or "SLA policy disabled"),
            "numerator": 0, "denominator": 0, "sample_count": 0, "visible_count": 0,
            "hidden_by_scope": 0, "samples_offset": 0, "samples_truncated": False,
            "samples": [], "samples_order": "breached_first",
        }
    targets = getattr(sla_policy, "targets", {}) or {}
    scored: list[tuple[Case, str, SlaCaseReading]] = []
    for c in current:
        prio = _sla_priority(c, prefs)
        target = targets.get(prio)
        if target is None:
            continue
        reading = sla_case_reading(c, target, _timings_for(c, timings), now=now)
        if reading.start is None:
            continue
        scored.append((c, prio, reading))

    def _breached(reading: SlaCaseReading) -> bool:
        return any(
            clock is not None and clock.state == "breached"
            for clock in (reading.response, reading.resolution)
        )

    ordered_sla = sorted(scored, key=lambda t: (not _breached(t[2]), t[0].case_number or t[0].case_id))
    picked = _sample_payload(ordered_sla, lambda t: t[0], visible, max_samples=max_samples, centre=False)

    def _clock(clock: SlaClockReading | None) -> dict[str, Any] | None:
        if clock is None:
            return None
        return {
            "state": clock.state,
            "elapsed_minutes": round(clock.elapsed_minutes, 1),
            "target_minutes": round(clock.target_minutes, 1),
            "running": clock.running,
            "stop_source": clock.stop_source,
        }

    rows = [
        {
            **_case_ref(c), "priority": prio,
            "value": 0 if _breached(reading) else 1,
            "counted": not _breached(reading),
            "response": _clock(reading.response),
            "resolution": _clock(reading.resolution),
        }
        for c, prio, reading in picked.pop("chosen")
    ]
    evaluated = int(summary.get("evaluated") or 0)
    met = sum(1 for _c, _p, reading in scored if not _breached(reading))
    return {
        **base, "kind": "ratio", "unit": "percent", "headline": "ratio",
        "value": summary.get("attainment_pct"),
        "available": summary.get("attainment_pct") is not None,
        "reason": str(summary.get("attainment_reason") or ""),
        "numerator": met, "denominator": evaluated,
        **picked, "samples": rows, "samples_order": "breached_first",
    }


def _created_ts(case: Case) -> float:
    created = _parse_iso(case.created_at)
    return created.timestamp() if created is not None else 0.0


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
    ``auto_closed``/``human_closed``/``system_closed`` are therefore DEPRECATED in
    favour of :func:`recorded_auto_close_health`'s ``gate_series``, which buckets the
    append-only decision trail on the decision instant (not the creation instant) and
    reads what each decision RECORDED. Expect the two to differ; the discontinuity is
    documented at that function. Every other field here is current.
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
        # The store's retention-bounded floor when it reports one (the same rule the
        # chat trend reads), else the first observation.
        since_dt = _parse_iso(alert_counters.get("coverage_start") or alert_counters.get("since"))
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
            # Beside the AI-verdict FP tally: the analyst-confirmed FP ground truth over
            # the same graded cohort (see ``quality_metrics``).
            "analyst_confirmed_fp": analyst_confirmed_fp_count(graded),
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

    .. deprecated:: superseded by :func:`recorded_auto_close_health`

       NOT POINT-IN-TIME. This anchors each case on its LAST recorded decision and
       reads the MUTABLE ``case.decision_by``/``case.status``, which are LAST-WRITER
       fields: any analyst lifecycle action (including a bare ``acknowledge``) stamps
       ``decision_by = ANALYST``, so an agent auto-close a human merely touches leaves
       the ``auto_closed`` tally retroactively, in every past window. It also counts
       cases that failed to a human BEFORE the case manager ran — ``decide()`` never
       saw them — in its denominator, and never excludes a recorded dependency outage.

       Kept BYTE-IDENTICAL on purpose: this is a shipped, separately-computed series
       that operators track, and silently redefining its predicate would move
       historical numbers with no announcement. :func:`recorded_auto_close_health`
       measures the same thing honestly from the append-only trail, under a new name
       and a new endpoint; the two are expected to differ. Prefer it for new surfaces.

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


# --------------------------------------------------------------------------- #
# RECORDED auto-close health — the SAME signal, measured from the APPEND-ONLY trail.
#
# WHY THIS EXISTS (the defect it corrects). The suite ships THREE auto-close rates,
# on three different clocks, and none of them is point-in-time:
#
#   1. ``quality_metrics``' ``automation_rate`` buckets by case CREATION and divides
#      ``decision_by == AGENT`` terminal cases by terminal cases.
#   2. :func:`auto_close_health` buckets by the LAST recorded decision and divides
#      agent-closed cases by decided cases.
#   3. ``trend_metrics``' ``auto_closed`` buckets by case CREATION again.
#
# All three read the MUTABLE ``case.decision_by`` / ``case.status``. Those fields are
# LAST-WRITER: every analyst lifecycle action stamps ``decision_by = ANALYST``, and a
# same-status move is permitted — so merely ACKNOWLEDGING an agent auto-close migrates
# it out of "the agent closed this" and into "a human closed this", retroactively, for
# every past window. The three docstrings above already warn about exactly this; the
# functions below are the honest measurement they point at.
#
# THE DURABLE RECORD ALREADY EXISTS AND NOTHING READ IT. ``case_manager.apply()``
# appends ``{"ts", "event": "decision", "status", "decision_by", "escalate",
# "rationale"}`` to the append-only ``Case.history`` on EVERY run, and the pipeline
# writes one ``ActionType.DECISION`` audit row beside it. Neither is ever trimmed or
# rewritten. That pair is a point-in-time record of what the deterministic decision
# ACTUALLY was, immune to every later analyst re-tag.
#
# DISCONTINUITY — READ BEFORE SWITCHING A DASHBOARD OVER. This is a NEW series under a
# NEW name, shipped ALONGSIDE the three above; none of them changes by a single byte.
# The two do NOT agree, by construction, and the difference is not a bug:
#
#   * ANCHOR. The legacy rate anchors on case creation (1, 3) or the LAST decision (2).
#     This one anchors on the FIRST recorded decision by default, so a case is counted
#     once, in the window in which the agent actually decided it, and REINVESTIGATION
#     DOES NOT MOVE IT. Pass ``anchor=DECISION_ANCHOR_LAST`` for the legacy-2 clock.
#   * PREDICATE. The legacy rate reads today's mutable ``decision_by``/``status``. This
#     one reads the ``status``/``decision_by`` recorded IN the decision entry, so an
#     analyst re-tag, a reopen, or a bulk action can never move a historical number.
#   * ``analyst_decided`` IS ALWAYS ZERO HERE, and that is correct: ``decide()`` only
#     ever returns ``AGENT`` or ``SYSTEM``. Any ``analyst`` share in the legacy series
#     is a LATER overwrite of the decision record, never a decision an analyst made at
#     decision time.
#   * OUTAGE EXCLUSION. This series can exclude decisions taken while the provider
#     COMPLETION channel — the one a verdict is produced on — was demonstrably down
#     (see :func:`derive_outage_windows`). Nothing that fails SOFT ever excludes a
#     decision: a degraded embedding channel and a stale knowledge corpus are reported
#     as context, because verdicts kept being produced through both. The legacy series
#     never excludes anything.
#
# Everything here is a READ-TIME DERIVATION. Nothing below is EVER read by
# ``case_manager.decide()`` (#3): ``decide()`` takes ``(verdict, confidence,
# risk_score, policy)`` and nothing else. Reading ``AutoClosePolicy`` here — and
# reusing ``case_manager._entry_for`` — is display-only classification of a decision
# that has ALREADY been made and persisted.
# --------------------------------------------------------------------------- #

# Which decision in a case's append-only trail anchors it to a window.
DECISION_ANCHOR_FIRST = "first"   # default: stable under reinvestigation
DECISION_ANCHOR_LAST = "last"     # the legacy auto_close_health clock

# The auto-close gate vocabulary. ONE closed set, shared by the WRITER (the pipeline's
# DECISION audit row) and every READER here, so the trail cannot drift from the
# analysis. Mirrors ``case_manager.decide()``'s predicate exactly — it never re-decides
# anything, it only LABELS a decision that was already made and persisted (#3).
GATE_CLEARED = "cleared"
GATE_BLOCKED_CONFIDENCE = "blocked_confidence"
GATE_BLOCKED_RISK = "blocked_risk"
GATE_BLOCKED_CONFIDENCE_AND_RISK = "blocked_confidence_and_risk"
GATE_CLASS_DISABLED = "class_disabled"
GATE_NOT_CLOSABLE = "not_closable"
GATE_UNRECORDED = "unrecorded"

#: Every gate outcome, in report order. ``unrecorded`` is FIRST-CLASS, not a leftover:
#: a decision whose audit row predates the gate tokens cannot be explained at all, and
#: saying so is the entire point of an evidence-quality signal.
AUTO_CLOSE_GATE_OUTCOMES: tuple[str, ...] = (
    GATE_CLEARED,
    GATE_BLOCKED_CONFIDENCE,
    GATE_BLOCKED_RISK,
    GATE_BLOCKED_CONFIDENCE_AND_RISK,
    GATE_CLASS_DISABLED,
    GATE_NOT_CLOSABLE,
    GATE_UNRECORDED,
)

#: Gate outcomes that mean "this verdict class was a candidate for auto-close at all".
#: ``not_closable`` is deliberately absent: ``case_manager._entry_for`` returns None for
#: NEEDS_HUMAN and for a missing verdict UNCONDITIONALLY, so those are never candidates
#: however the policy is configured. Derived from that function, NEVER from the config
#: schema — ``AutoClosePolicy.needs_human`` is a real, settable field whose ``enabled``
#: flag ``_entry_for`` ignores outright, so reading the schema would report a closable
#: class that code can never close.
_CLOSABLE_GATE_OUTCOMES: frozenset[str] = frozenset({
    GATE_CLEARED,
    GATE_BLOCKED_CONFIDENCE,
    GATE_BLOCKED_RISK,
    GATE_BLOCKED_CONFIDENCE_AND_RISK,
    GATE_CLASS_DISABLED,
})


@dataclass(frozen=True)
class DecisionRecord:
    """ONE ``{"event": "decision"}`` entry from a case's append-only ``history``.

    A POINT-IN-TIME record: ``status`` and ``decision_by`` are the values
    ``case_manager.apply()`` wrote at that instant, not the case's current (mutable,
    last-writer) fields. ``index``/``total`` locate it in the case's decision trail so
    a caller can tell a first decision from a re-decision without re-walking history.
    """

    at: datetime | None
    status: str
    decision_by: str
    escalate: bool
    rationale: str
    index: int
    total: int

    @property
    def auto_closed(self) -> bool:
        """The recorded decision WAS a deterministic agent auto-close.

        Exactly ``decide()``'s close branch as it was persisted: the agent authored it
        and the recorded status is terminal. Note the recorded ``status`` is the raw
        ``Decision.status`` — ``apply()``'s later ESCALATED remap happens only in the
        NON-close branch, so a recorded CLOSED can never be an escalation."""
        return (
            self.decision_by == DecisionBy.AGENT.value
            and self.status in _TERMINAL
        )


def decision_records(case: Case) -> list[DecisionRecord]:
    """Every deterministic decision this case has on record, OLDEST first.

    Reads the append-only ``Case.history`` in APPEND order (which is chronological and
    is never rewritten) rather than sorting on ``ts``: a single malformed timestamp
    must not be able to reorder the trail. An entry whose ``ts`` cannot be parsed keeps
    its position with ``at=None`` so ``index``/``total`` stay truthful — a caller that
    needs an instant checks for None instead of silently inheriting a neighbour's.

    Pure and defensive: a malformed history entry is skipped, never raised on."""
    raw = [
        entry
        for entry in (case.history or [])
        if isinstance(entry, dict) and entry.get("event") == "decision"
    ]
    total = len(raw)
    out: list[DecisionRecord] = []
    for index, entry in enumerate(raw):
        out.append(DecisionRecord(
            at=_parse_iso(entry.get("ts")),
            status=str(entry.get("status") or ""),
            decision_by=str(entry.get("decision_by") or ""),
            escalate=bool(entry.get("escalate")),
            rationale=str(entry.get("rationale") or ""),
            index=index,
            total=total,
        ))
    return out


def decision_record(
    case: Case, *, anchor: str = DECISION_ANCHOR_FIRST
) -> DecisionRecord | None:
    """The case's anchoring decision, or None when it has never been decided.

    ``anchor=DECISION_ANCHOR_FIRST`` (the default) returns the FIRST recorded decision:
    the instant the deterministic decision was originally made, and the outcome it
    originally had. That is what makes a rate built on it STABLE — a reopen plus a
    re-investigation appends a second decision entry without moving, duplicating or
    re-labelling the first, so the case keeps counting exactly once, in its original
    window, with its original outcome.

    ``anchor=DECISION_ANCHOR_LAST`` returns the newest entry instead, reproducing the
    rolling clock :func:`auto_close_health` uses (a case decided again today belongs to
    today). Any other value is treated as ``first`` rather than raising — a metrics
    accessor never fails a dashboard query."""
    records = decision_records(case)
    if not records:
        return None
    return records[-1] if anchor == DECISION_ANCHOR_LAST else records[0]


def classify_auto_close_gate(
    policy: Any, verdict: Any, confidence: Any, risk_score: Any
) -> str:
    """LABEL an already-made decision with why the auto-close bar was or was not met.

    The single writer/reader definition of the gate vocabulary: the pipeline stamps
    this string into the append-only DECISION audit row, and the analysis below reads
    it back. It mirrors ``case_manager.decide()``'s predicate
    (``confidence >= min_confidence and risk_score <= max_risk_score``) so the label
    and the decision cannot disagree.

    It NEVER decides anything (#3). It runs strictly AFTER ``apply()`` has produced and
    persisted the decision, and its output is an audit token — no caller branches on it.

    The closable-class test is ``case_manager._entry_for`` itself, deliberately, rather
    than an independent reading of ``AutoClosePolicy``: ``_entry_for`` returns None for
    NEEDS_HUMAN and for a missing verdict UNCONDITIONALLY, while the config schema
    carries a real, settable ``needs_human`` entry whose ``enabled`` flag code ignores.
    Classifying from the schema would report a closable class that can never close.

    Returns one of :data:`AUTO_CLOSE_GATE_OUTCOMES`; ``unrecorded`` when no policy was
    supplied (the classification is genuinely unknown, never a guessed ``cleared``)."""
    if policy is None:
        return GATE_UNRECORDED
    try:
        entry = _entry_for(policy, verdict)
    except Exception:  # noqa: BLE001 — a labelling helper never breaks a caller
        return GATE_UNRECORDED
    if entry is None:
        return GATE_NOT_CLOSABLE
    if not bool(getattr(entry, "enabled", False)):
        return GATE_CLASS_DISABLED
    try:
        low_confidence = float(confidence) < float(entry.min_confidence)
        high_risk = float(risk_score) > float(entry.max_risk_score)
    except (TypeError, ValueError):
        return GATE_UNRECORDED
    if low_confidence and high_risk:
        return GATE_BLOCKED_CONFIDENCE_AND_RISK
    if low_confidence:
        return GATE_BLOCKED_CONFIDENCE
    if high_risk:
        return GATE_BLOCKED_RISK
    return GATE_CLEARED


@dataclass(frozen=True)
class OutageWindow:
    """An interval for which the deployment holds POSITIVE EVIDENCE that the machinery
    auto-close depends on was down.

    ``start`` is the last moment the subsystem was observed WORKING; ``None`` means no
    success was ever observed, so the window is open-ended backwards and every decision
    up to ``end`` is suspect. ``end`` is the newest observed failure.

    NOT A DATE LITERAL, and never derived from one. Both bounds come from state the
    deployment already persists about ITSELF — the ``llm/provider_health``
    last-success/last-failure instants, each of which is stamped per CALL, so the
    bracket really is "the last time this dependency was observed working". A calendar
    window compiled into shipped source would be correct in exactly the one deployment
    it was measured in and would silently mislead every other installation of this
    suite — which is the failure the portability tripwire over this module exists to
    prevent. A bound read off a record written on some UNRELATED cadence (the last
    successful knowledge PROJECTION, say) fails the same way for the same reason: the
    span it excludes is a property of that cadence, not of any outage."""

    start: datetime | None
    end: datetime
    subsystem: str
    detail: str

    @property
    def start_known(self) -> bool:
        return self.start is not None

    def contains(self, at: datetime) -> bool:
        if at > self.end:
            return False
        return self.start is None or at > self.start

    def as_dict(self) -> dict[str, Any]:
        return {
            "start": self.start.isoformat() if self.start is not None else None,
            "end": self.end.isoformat(),
            "subsystem": self.subsystem,
            "detail": self.detail,
            "start_known": self.start_known,
        }


def derive_outage_windows(
    *,
    provider_health: Any = None,
    rag_health: Any = None,
) -> list[OutageWindow]:
    """Outage intervals derived from the deployment's OWN persisted health state.

    ONE source qualifies, and only under a narrow test: a window may be derived only
    from a dependency failure that DEMONSTRABLY STOPS VERDICT PRODUCTION. Excluding a
    decision deletes it from the denominator, so anything short of that turns a healthy
    measurement into an unmeasurable dash — the exact honesty inversion this block
    exists to remove.

    * ``provider_health`` — the JSON snapshot from ``ProviderHealth.snapshot()``. A
      row whose ``state`` is not ``ok`` has CROSSED its consecutive-failure threshold
      with fresh evidence, which is precisely "every call on this channel is failing
      right now". Only the COMPLETION channel qualifies: that is the channel a verdict
      is produced on. The EMBEDDING channel fails soft by design — the gateway records
      the failure and continues on local hash embeddings, so completions, verdicts and
      ``decide()`` all still run and every decision taken then is real evidence about
      auto-close. A row carrying no ``channel`` predates the split and is read as
      completion, matching ``ProviderHealth``'s own default. The window runs from the
      row's ``last_success_at`` (the last time it demonstrably worked) to its
      ``last_failure_at``.
    * ``rag_health`` — accepted so a caller can hand both health records over
      symmetrically, and DELIBERATELY IGNORED here: no RAG record, of any shape, can
      produce a window. Keeping the parameter keeps that a stated contract (and a
      testable one) rather than an omission someone quietly reverses. A ``collapsed``
      projection refusal is raised BEFORE anything is written and leaves the previous
      corpus intact and serving, so it is positive evidence that retrieval kept
      working, not evidence that it stopped. Its old bracket was also anchored on
      ``healthy_at`` — the last successful PROJECTION, not the last observed retrieval
      — which made the excluded span a function of the deployment's projection cadence
      rather than of any outage. A stale corpus is reported as CONTEXT instead.

    Both inputs are optional and both are tolerated in any shape — a missing, empty or
    malformed record yields no windows rather than raising, so a metrics read can never
    be broken by an observability record. Deterministic given its inputs.

    Returns the windows oldest-``end`` first. An EMPTY list means "no evidence of an
    outage", never "there was no outage": absence of a health record is not proof of
    health, and the caller reports the distinction."""
    windows: list[OutageWindow] = []

    for key, row, state in _non_ok_provider_rows(provider_health):
        if _row_channel(row) != CHANNEL_COMPLETION:
            # Real, reported as context, and NOT an outage of verdict production.
            continue
        end = _parse_iso(row.get("last_failure_at"))
        if end is None:
            # A crossed threshold with no readable failure instant cannot bound a
            # window. Excluding an unbounded interval on that basis would delete
            # the metric; report nothing instead.
            continue
        windows.append(OutageWindow(
            start=_parse_iso(row.get("last_success_at")),
            end=end,
            subsystem="llm_provider",
            detail=f"{key or 'provider'} state={state}",
        ))

    windows.sort(key=lambda w: w.end)
    return windows


def _row_channel(row: dict[str, Any]) -> str:
    """A provider-health row's call channel, defaulting the way the tracker does.

    ``ProviderHealth.record_success``/``record_failure`` both default ``channel`` to
    :data:`~app.llm.provider_health.CHANNEL_COMPLETION`, so a row written before the
    channel split reads back as completion rather than as an unknown third thing."""
    return str(row.get("channel") or CHANNEL_COMPLETION)


def _non_ok_provider_rows(provider_health: Any) -> "list[tuple[str, dict[str, Any], str]]":
    """``(key, row, state)`` for every provider row reporting a non-``ok`` state.

    Shared by the window derivation and the context block so the two can never
    disagree about which rows are failing. Tolerates any shape."""
    providers = provider_health.get("providers") if isinstance(provider_health, dict) else None
    if not isinstance(providers, dict):
        return []
    out: list[tuple[str, dict[str, Any], str]] = []
    for key, row in providers.items():
        if not isinstance(row, dict):
            continue
        state = str(row.get("state") or "")
        if not state or state == "ok":
            continue
        out.append((str(key or "provider"), row, state))
    return out


def derive_dependency_context(
    *,
    provider_health: Any = None,
    rag_health: Any = None,
) -> dict[str, Any]:
    """Dependency conditions that are REAL but do NOT stop a verdict being produced.

    Published beside the outage windows so an operator sees the whole health picture
    without any of it deleting decisions from the denominator:

    * ``degraded_channels`` — non-``ok`` provider rows on a channel other than
      completion (today: embedding). The gateway falls back to local hash embeddings
      and keeps going, so retrieval quality is degraded while verdict production is
      not. Worth showing; never worth excluding a decision for.
    * ``corpus_stale_since`` — the instant a ``collapsed`` projection refusal
      preserved the existing corpus rather than replacing it. Retrieval keeps serving
      the last known-good projection from then on, so the corpus is STALE, not down.

    Deterministic, fail-soft and read-only, exactly like :func:`derive_outage_windows`.
    """
    degraded: list[dict[str, str]] = []
    for key, row, state in _non_ok_provider_rows(provider_health):
        channel = _row_channel(row)
        if channel == CHANNEL_COMPLETION:
            continue
        degraded.append({
            "key": key,
            "channel": channel,
            "state": state,
            "last_failure_at": str(row.get("last_failure_at") or ""),
            "last_success_at": str(row.get("last_success_at") or ""),
            "detail": (
                f"{key} state={state}; this channel fails soft (the gateway continues "
                "on local hash embeddings), so verdict production is unaffected and no "
                "decision is excluded for it"
            ),
        })
    degraded.sort(key=lambda entry: entry["key"])

    stale_since = ""
    stale_detail = ""
    refusal = rag_health.get("last_refusal") if isinstance(rag_health, dict) else None
    if isinstance(refusal, dict) and bool(refusal.get("collapsed")):
        at = _parse_iso(refusal.get("at"))
        if at is not None:
            stale_since = at.isoformat()
            stale_detail = (
                "a knowledge projection collapsed and was REFUSED, which preserved the "
                "existing corpus; retrieval keeps serving that last known-good "
                "projection, so the corpus is stale from this instant rather than down"
            )
    return {
        "degraded_channels": degraded,
        "corpus_stale_since": stale_since,
        "corpus_stale_detail": stale_detail,
        "note": (
            "Reported for context only. Nothing here excludes a decision: a dependency "
            "that fails soft still produced every verdict in the window."
        ),
    }


def _health_evidence_available(provider_health: Any, rag_health: Any) -> bool:
    """Whether the deployment holds ANY health OBSERVATION the exclusion could read.

    The unit of evidence is an observation, never a wrapper object.
    ``ProviderHealth.snapshot()`` always returns a dict and ``AppState`` always builds
    the tracker, so "a snapshot was handed in" is invariantly true and says nothing;
    ``providers`` is non-empty only once a real call has been recorded. A deployment
    that has made no model call and holds no RAG health document has no evidence, and
    reporting otherwise would turn "we cannot see" into "there was nothing to see"."""
    providers = provider_health.get("providers") if isinstance(provider_health, dict) else None
    if isinstance(providers, dict) and providers:
        return True
    return bool(rag_health)


def _in_outage(at: datetime | None, windows: "list[OutageWindow] | tuple[()]") -> OutageWindow | None:
    if at is None:
        return None
    for window in windows or ():
        if window.contains(at):
            return window
    return None


# The audit token names the pipeline stamps into the DECISION row's ``result_summary``.
# APPEND-ONLY: ``result_summary`` is parsed POSITIONALLY by nothing here — it is parsed
# by NAME — but the row itself is an append-only history record, so new facts are only
# ever added at the END of the string and an existing token is never renamed, reordered
# or removed. A row written before a token existed simply lacks it, and that absence is
# reported as ``unrecorded`` rather than being guessed at.
_AUDIT_TOKEN_CONFIDENCE = "confidence"
_AUDIT_TOKEN_GATE = "auto_close_gate"

#: How far apart the history entry and its own audit row may be and still be the SAME
#: decision. ``case_manager.apply()`` stamps the history entry with ``case.updated_at``
#: and the pipeline writes the audit row immediately after the case is saved, so the
#: real gap is the persistence latency of one document — sub-millisecond in process,
#: and seconds at worst on a loaded store. Two DIFFERENT decisions on one case are a
#: re-investigation apart (a human reopen, a poll cycle), which is orders of magnitude
#: larger. Generous enough to keep a genuine pair, far too tight to splice one run's
#: gate onto another run's verdict.
_DECISION_AUDIT_PAIR_TOLERANCE_SECONDS = 120.0


def parse_decision_audit_row(row: Any) -> dict[str, Any] | None:
    """Parse ONE ``case_manager`` DECISION audit row into typed decision facts.

    The row's ``result_summary`` is a whitespace-separated ``key=value`` list; none of
    the values can contain a space (they are enum values, numbers and a closed gate
    vocabulary), so the parse is unambiguous. Unknown keys are ignored, so a row from a
    LATER build that appended further tokens still parses here.

    Returns None for anything that is not a readable ``case_manager`` decision row.
    Never raises: an unreadable audit row is dropped, not escalated into a 500."""
    if isinstance(row, dict):
        get = row.get
    else:
        def get(key: str, default: Any = None) -> Any:
            return getattr(row, key, default)
    if str(get("actor") or "") != "case_manager":
        return None
    case_id = str(get("case_id") or "")
    if not case_id:
        return None
    at = _parse_iso(get("ts"))
    fields: dict[str, str] = {}
    for token in str(get("result_summary") or "").split():
        key, sep, value = token.partition("=")
        if sep:
            fields[key] = value

    def _float(key: str) -> float | None:
        try:
            return float(fields[key])
        except (KeyError, TypeError, ValueError):
            return None

    gate = fields.get(_AUDIT_TOKEN_GATE, "")
    return {
        "case_id": case_id,
        "ts": str(get("ts") or ""),
        "at": at,
        "verdict": fields.get("verdict", ""),
        "status": fields.get("status", ""),
        "decision_by": fields.get("decision_by", ""),
        "risk": _float("risk"),
        "confidence": _float(_AUDIT_TOKEN_CONFIDENCE),
        # An unknown token from a future build is NOT silently adopted as a valid gate
        # outcome; it is reported as unrecorded, which is what it is from here.
        "gate": gate if gate in AUTO_CLOSE_GATE_OUTCOMES else GATE_UNRECORDED,
    }


def anchored_decision_audit(
    rows: Any, *, anchor: str = DECISION_ANCHOR_FIRST
) -> dict[str, dict[str, Any]]:
    """The ONE anchoring DECISION audit row per case, keyed by ``case_id``.

    A case can carry MORE THAN ONE decision — a reopen plus a re-investigation appends
    another — and the VERDICT can differ between them, so every decision fact must stay
    paired with the decision that produced it. Grouping the rows and picking the
    anchored one preserves that pairing; a flat aggregate over the rows (``max(
    confidence) GROUP BY case_id``, say) would silently splice one run's confidence onto
    another run's verdict and report a gate outcome that never happened.

    Rows may arrive in any order (the store returns them newest-first); they are ordered
    by parsed timestamp, with unparseable timestamps kept LAST so they can never
    displace a readable anchor. Ties keep input order, which is stable."""
    grouped: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for position, row in enumerate(rows or ()):
        parsed = parse_decision_audit_row(row)
        if parsed is None:
            continue
        grouped.setdefault(parsed["case_id"], []).append((position, parsed))
    out: dict[str, dict[str, Any]] = {}
    for case_id, entries in grouped.items():
        entries.sort(key=lambda item: (
            item[1]["at"] is None,
            item[1]["at"] or datetime.min.replace(tzinfo=timezone.utc),
            item[0],
        ))
        chosen = entries[-1][1] if anchor == DECISION_ANCHOR_LAST else entries[0][1]
        out[case_id] = {**chosen, "decisions_observed": len(entries)}
    return out


@dataclass(frozen=True)
class _DecisionPoint:
    """One case reduced to its ANCHORED decision, ready to be windowed or bucketed."""

    at: datetime
    auto_closed: bool
    decision_by: str
    policy_closed: bool
    outage_subsystem: str
    gate: str


def _recorded_decision_points(
    cases: list[Case],
    *,
    anchor: str,
    audit_by_case: dict[str, dict[str, Any]] | None = None,
    outages: "list[OutageWindow] | tuple[()]" = (),
) -> tuple[list[_DecisionPoint], dict[str, int]]:
    """Reduce each case to its ONE anchoring decision, plus the honest skip counts.

    Built ONCE and shared by the window tallies and the bucketed series so the two can
    never disagree about which decision a case is, when it happened, or how it was
    classified.

    The gate label is joined from the append-only DECISION audit row rather than from
    ``case.confidence``/``case.risk_score``: those are overwritten by re-investigation,
    so reading them would explain the FIRST decision with the LAST run's numbers. The
    join is per case AND PER DECISION INSTANT: the case id alone is not enough, because
    the two anchors are drawn from different populations. The history anchor walks the
    case's own unbounded trail while the audit anchor is the first row of a BOUNDED
    page, so on a case whose anchoring decision predates that page the case id would
    pair the anchored decision with a LATER, different-verdict run and publish a gate
    outcome that never happened for it. Pairing on the instant (within
    :data:`_DECISION_AUDIT_PAIR_TOLERANCE_SECONDS`) makes the unmatched case read back
    as ``unrecorded``, which is the honest answer and exactly what ``gate_coverage``
    exists to expose."""
    audit_by_case = audit_by_case or {}
    points: list[_DecisionPoint] = []
    skipped = {
        "no_decision_record": 0,
        "unusable_timestamp": 0,
        "policy_closed_no_record": 0,
    }
    for case in cases:
        policy_closed = is_policy_closed(case)
        record = decision_record(case, anchor=anchor)
        if record is None:
            # Never decided, or decided before this build recorded decisions. Two very
            # different populations end up here, and pooling them would hide both.
            if policy_closed:
                # A DELIBERATE $0 close: an operator declared this rule benign, so the
                # pipeline closed the case under ANALYST_POLICY without ever calling
                # ``decide()``. It is excluded from every agent-performance statistic
                # by design; naming it keeps it out of "decide() failed to run".
                skipped["policy_closed_no_record"] += 1
            elif case.verdict is not None or (
                (case.status.value if case.status else "") in _TERMINAL
            ):
                # A case that failed to a human BEFORE the case manager ran carries a
                # NEEDS_HUMAN verdict and no decision entry: ``decide()`` never saw it,
                # so it is not evidence about auto-close. Named, not folded in.
                skipped["no_decision_record"] += 1
            continue
        if record.at is None:
            skipped["unusable_timestamp"] += 1
            continue
        outage = _in_outage(record.at, outages)
        audit = audit_by_case.get(case.case_id) or {}
        points.append(_DecisionPoint(
            at=record.at,
            auto_closed=record.auto_closed,
            decision_by=record.decision_by,
            policy_closed=policy_closed,
            outage_subsystem=(outage.subsystem if outage is not None else ""),
            gate=_paired_gate(audit, record.at),
        ))
    return points, skipped


def _paired_gate(audit: dict[str, Any], at: datetime) -> str:
    """The audit row's gate outcome, but ONLY when the row is that same decision.

    Returns :data:`GATE_UNRECORDED` for a row that cannot be proven to belong to the
    anchored decision — no readable instant, or an instant further from it than the
    persistence gap can explain. Reporting a decision as unexplained is honest;
    labelling it with another run's outcome is not.

    The instant is the predicate, not the row's ``decisions_observed`` count: a
    truncated page can hold exactly as many rows as the case has decisions and still
    be holding the WRONG ones, so a count match proves nothing on its own."""
    if not audit:
        return GATE_UNRECORDED
    row_at = audit.get("at")
    if not isinstance(row_at, datetime):
        return GATE_UNRECORDED
    if abs((row_at - at).total_seconds()) > _DECISION_AUDIT_PAIR_TOLERANCE_SECONDS:
        return GATE_UNRECORDED
    return str(audit.get("gate") or GATE_UNRECORDED)


def _recorded_auto_close_tally(
    points: list[_DecisionPoint],
    *,
    start: datetime | None,
    end: datetime | None,
    skipped: dict[str, int] | None = None,
) -> dict[str, Any]:
    """The auto-close tally over ``[start, end)``, counted from the APPEND-ONLY record.

    Differs from :func:`_auto_close_tally` in three ways, each deliberate:

    * The window instant is the ANCHORED decision entry's ``ts`` (first by default),
      not the last one, so a re-investigated case stays in its original window.
    * ``auto_closed`` reads the ``decision_by``/``status`` RECORDED IN that entry, not
      today's mutable ``case.decision_by``/``case.status``, so no later analyst action
      can move a historical number.
    * "decided" means ``decide()`` demonstrably RAN (an entry exists), so a case that
      failed to a human before the case manager was reached is reported as
      ``no_decision_record`` instead of padding the denominator.

    ``analyst_decided`` is retained for shape-compatibility with the legacy block and
    is STRUCTURALLY ZERO under this predicate: ``decide()`` only ever authors ``agent``
    or ``system``. Any analyst share in the legacy series is a later overwrite of the
    decision record, not a decision an analyst made at decision time.

    ``policy_closed`` is the deliberate $0 operator-declared-benign population, which
    is excluded from the rate entirely. Almost all of it arrives WITHOUT a decision
    record — the analyst-policy close never calls ``decide()`` — and such a case has
    no decision instant, so that part is SET-WIDE (it repeats across blocks, like
    ``no_decision_record``) rather than being attributed to a window it cannot be
    placed in. Only the windowable remainder is counted per window."""
    decided = auto_closed = routed_to_human = analyst_decided = 0
    policy_closed = excluded_outage = 0
    gates: Counter[str] = Counter()
    outage_subsystems: Counter[str] = Counter()

    for point in points:
        if start is not None and point.at < start:
            continue
        if end is not None and point.at >= end:
            continue
        # Mirrors the legacy ordering: counted AFTER the window guards, so a policy
        # close that DOES carry a decision instant lands in its own window. The
        # record-less majority is added set-wide below, where it can be named at all.
        if point.policy_closed:
            policy_closed += 1
            continue
        if point.outage_subsystem:
            excluded_outage += 1
            outage_subsystems[point.outage_subsystem] += 1
            continue
        decided += 1
        if point.auto_closed:
            auto_closed += 1
        elif point.decision_by == DecisionBy.ANALYST.value:
            analyst_decided += 1
        else:
            routed_to_human += 1
        gates[point.gate] += 1

    explained = sum(gates[name] for name in AUTO_CLOSE_GATE_OUTCOMES if name != GATE_UNRECORDED)
    skipped = skipped or {}
    return {
        "decided": decided,
        "auto_closed": auto_closed,
        "routed_to_human": routed_to_human,
        "analyst_decided": analyst_decided,
        # Outside the rate entirely (numerator AND denominator); reported for context.
        # The record-less part is SET-WIDE — an analyst-policy close never calls
        # ``decide()`` and so has no decision instant to place in a window — and is
        # therefore repeated per block rather than dropped into ``no_decision_record``
        # beside the cases ``decide()`` genuinely never reached.
        "policy_closed": policy_closed + int(skipped.get("policy_closed_no_record", 0)),
        "policy_closed_no_decision_record": int(skipped.get("policy_closed_no_record", 0)),
        # Cases the rate could not be evidence about, each named rather than folded in.
        # The two ``skipped`` counts are set-wide (a case with no readable decision
        # instant cannot be attributed to any window), so they repeat across blocks.
        "no_decision_record": int(skipped.get("no_decision_record", 0)),
        "unusable_timestamp": int(skipped.get("unusable_timestamp", 0)),
        "excluded_outage": excluded_outage,
        "excluded_outage_by_subsystem": dict(outage_subsystems),
        "gate": {name: gates[name] for name in AUTO_CLOSE_GATE_OUTCOMES},
        # Of the decisions in this window, how many the append-only trail can EXPLAIN.
        # This is an EVIDENCE-QUALITY number, not a performance number.
        "gate_explained": explained,
        "gate_coverage": _ratio(explained, decided),
        "closable_class": sum(gates[name] for name in _CLOSABLE_GATE_OUTCOMES),
    }


def _gate_series(
    points: list[_DecisionPoint],
    *,
    starts: list[int],
    bucket_secs: int,
) -> list[dict[str, Any]]:
    """The gate breakdown bucketed over ``starts`` — an EVIDENCE-QUALITY time series.

    WHAT IT IS. Per bucket: how many decisions the append-only trail can explain, and
    for the ones it can, which side of the auto-close bar they fell on and why. It
    answers "can we still say WHY auto-close did or did not fire?", which is the
    question that went unanswerable when the rate collapsed.

    WHAT IT IS NOT. It is NOT a threshold-tuning target. ``blocked_confidence`` rising
    is not a reason to lower ``min_confidence``: this series is derived from decisions
    that already happened, it carries no outcome evidence about whether closing those
    cases would have been CORRECT, and tuning against it would be a closed loop that
    optimises the metric rather than the triage. Threshold change proposals come from
    ``engine/threshold_tuner``, which learns only from INDEPENDENT analyst-confirmed
    outcomes and routes its bounded changes to human review.

    Buckets are zero-filled across the whole window; outage-excluded decisions and the
    windowable policy closes are counted per bucket but stay out of ``decided``,
    exactly as in the window blocks. The SET-WIDE skip counts (a policy close with no
    decision record, a case ``decide()`` never reached, an unreadable instant) belong
    to no bucket by construction and are reported only on the window blocks."""
    by_bucket: dict[int, list[_DecisionPoint]] = {start: [] for start in starts}
    for point in points:
        bucket = int(point.at.timestamp() // bucket_secs) * bucket_secs
        members = by_bucket.get(bucket)
        if members is not None:
            members.append(point)
    rows: list[dict[str, Any]] = []
    for start in starts:
        tally = _recorded_auto_close_tally(by_bucket[start], start=None, end=None)
        rows.append({
            "t": datetime.fromtimestamp(start, tz=timezone.utc).isoformat(),
            "decided": tally["decided"],
            "auto_closed": tally["auto_closed"],
            "policy_closed": tally["policy_closed"],
            "excluded_outage": tally["excluded_outage"],
            "closable_class": tally["closable_class"],
            "gate": tally["gate"],
            "gate_explained": tally["gate_explained"],
            "gate_coverage": tally["gate_coverage"],
        })
    return rows


def _recorded_auto_close_block(
    tally: dict[str, Any], *, label: str, min_decided: int
) -> dict[str, Any]:
    """Wrap a recorded tally in the honest rate block (same contract as the legacy
    :func:`_auto_close_block`): ``rate`` is the labelled DASH whenever the window
    cannot support a meaningful rate, never a fabricated 0.0.

    Adds one reason the legacy block cannot have: a window whose decisions were ALL
    excluded because the completion channel was demonstrably down says so, instead of
    publishing "auto-close stopped" about an outage of something else."""
    decided = int(tally.get("decided", 0))
    excluded = int(tally.get("excluded_outage", 0))
    if decided == 0 and excluded > 0:
        return {
            **tally, "rate": DASH, "available": False,
            "reason": (
                f"every decision in the {label} window ({excluded}) was taken while a "
                "dependency was demonstrably down, so none of them is evidence about "
                "auto-close"
            ),
        }
    if decided == 0:
        return {
            **tally, "rate": DASH, "available": False,
            "reason": f"no case was decided in the {label} window",
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


def recorded_auto_close_health(
    cases: list[Case],
    *,
    window_hours: int = 24,
    policy: Any = None,
    now: datetime | None = None,
    store_total: int | None = None,
    min_decided: int = AUTO_CLOSE_MIN_DECIDED,
    anchor: str = DECISION_ANCHOR_FIRST,
    decision_audit_rows: Any = None,
    decision_audit_span_hours: int | None = None,
    provider_health: Any = None,
    rag_health: Any = None,
) -> dict[str, Any]:
    """The auto-close rate measured from the APPEND-ONLY decision trail.

    The corrected counterpart to :func:`auto_close_health`, shipped BESIDE it under
    this new name. The legacy series is not touched, not redefined and not deprecated
    out from under anyone; see the section comment above for the full discontinuity
    note. The short version:

    * a case is anchored to its FIRST recorded decision (``anchor``), so reopening and
      re-investigating a case never moves, duplicates or re-labels the original count;
    * "auto-closed" is what the decision entry RECORDED, so an analyst acknowledging,
      re-tagging or reopening a case can never rewrite a past window's rate;
    * decisions taken while the provider COMPLETION channel was demonstrably down are
      excluded, with the exclusion derived from the deployment's OWN health records
      (never a date). Nothing that fails SOFT excludes anything;
    * every decision the trail cannot explain is counted as ``unrecorded`` and shown.

    Inputs beyond ``cases`` are all optional and all fail soft:

    ``decision_audit_rows``
        ``case_manager`` DECISION audit rows (any order). Supplies the gate breakdown —
        which verdict classes were closable, whether the bar was cleared, and what
        blocked it. Absent, every decision reports ``unrecorded`` and ``gate_coverage``
        is 0.0, which is an honest statement about the evidence, not a zero result.
    ``decision_audit_span_hours``
        How far back the caller actually READ those rows, published beside
        ``gate_coverage`` so a low coverage number is legible as "the trail older than
        this was not read" rather than as "the trail lost the answer". Optional; the
        rollup never derives a bound of its own from it.
    ``provider_health`` / ``rag_health``
        The health records the outage exclusion is derived from
        (:func:`derive_outage_windows`). Only a failing COMPLETION channel excludes
        anything, because only that channel gates verdict production; a degraded
        embedding channel and a stale knowledge corpus are published as context
        (:func:`derive_dependency_context`) and leave the denominator alone. Absent —
        or present but holding no observation — nothing is excluded and
        ``outage.evidence_available`` is false; absence of a health record is never
        reported as proof that there was no outage.

    ``status`` reuses the legacy vocabulary and adds one value: ``outage_excluded``,
    for a window whose decisions were all taken during a recorded dependency outage.

    Pure + deterministic given its inputs; advisory only. Nothing here is ever read by
    ``case_manager.decide()`` (#3)."""
    now = now or datetime.now(timezone.utc)
    window_hours = max(1, int(window_hours))
    anchor = DECISION_ANCHOR_LAST if anchor == DECISION_ANCHOR_LAST else DECISION_ANCHOR_FIRST
    span = timedelta(hours=window_hours)
    window_start = now - span
    baseline_start = window_start - span

    outages = derive_outage_windows(provider_health=provider_health, rag_health=rag_health)
    # An outage whose START is unknown (nothing on record ever succeeded — the provider
    # tracker is in-process, so a restart mid-outage produces exactly this) is bounded
    # BACKWARDS to the earliest instant any reported block covers, and no further.
    # Applying it unbounded would delete every historical decision on the strength of
    # evidence about the present, which is the same class of error as excluding a window
    # by calendar date: confidently wrong everywhere the evidence does not reach.
    applied_outages = [
        window if window.start_known else OutageWindow(
            start=baseline_start,
            end=window.end,
            subsystem=window.subsystem,
            detail=(
                f"{window.detail}; no success on record, so the exclusion is clamped to "
                "the reported span rather than extrapolated backwards"
            ),
        )
        for window in outages
    ]
    audit_by_case = anchored_decision_audit(decision_audit_rows or (), anchor=anchor)
    points, skipped = _recorded_decision_points(
        cases, anchor=anchor, audit_by_case=audit_by_case, outages=applied_outages,
    )

    current = _recorded_auto_close_block(
        _recorded_auto_close_tally(points, start=window_start, end=None, skipped=skipped),
        label="current", min_decided=min_decided,
    )
    baseline = _recorded_auto_close_block(
        _recorded_auto_close_tally(
            points, start=baseline_start, end=window_start, skipped=skipped
        ),
        label="preceding", min_decided=min_decided,
    )
    lifetime = _recorded_auto_close_block(
        _recorded_auto_close_tally(points, start=None, end=None, skipped=skipped),
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
    current_excluded = int(current["excluded_outage"])

    if policy_block["available"] and not policy_block["any_enabled"]:
        status = "disabled"
        reason = (
            "auto-close is turned OFF for every verdict class, so a zero auto-close "
            "rate is the configured behaviour"
        )
    elif current_decided == 0 and current_excluded > 0:
        status = "outage_excluded"
        reason = (
            f"all {current_excluded} decision(s) in the last {window_hours}h were taken "
            "while a recorded dependency outage was in progress; auto-close cannot be "
            "measured from them"
        )
    elif current_decided == 0:
        status = "no_volume"
        reason = (
            f"no case was decided in the last {window_hours}h"
            + (
                f" (the preceding {window_hours}h decided {baseline_decided}) — this is an "
                "investigation-volume gap, not an auto-close outage"
                if baseline_decided
                else " and none was in the preceding window either"
            )
        )
    elif collapsed:
        status = "collapsed"
        reason = (
            f"the recorded auto-close rate fell from {baseline_rate} to {current_rate} "
            f"while decided volume held steady ({baseline_decided} -> {current_decided} "
            "cases)"
        )
    elif never_fired:
        status = "never_fired"
        reason = (
            f"auto-close is enabled but not one of the {lifetime['decided']} decision(s) "
            "on record has ever auto-closed"
        )
    elif not comparable:
        status = "insufficient_evidence"
        reason = current["reason"] or baseline["reason"]
    elif degraded:
        status = "degraded"
        reason = (
            f"the recorded auto-close rate dropped from {baseline_rate} to "
            f"{current_rate} while decided volume held steady"
        )
    else:
        status = "ok"
        reason = ""

    bucket_minutes = _trend_bucket_minutes(min(720, window_hours))
    bucket_secs = bucket_minutes * 60
    now_ts = now.timestamp()
    last_start = int(now_ts // bucket_secs) * bucket_secs
    first_start = int((now_ts - window_hours * 3600.0) // bucket_secs) * bucket_secs
    starts = list(range(first_start, last_start + 1, bucket_secs))

    return {
        "window_hours": window_hours,
        "generated_at": now.isoformat(),
        "anchor": anchor,
        "source": "append_only_decision_trail",
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
        "outage": {
            # False means "we hold no health record", NEVER "there was no outage".
            # Keyed off the OBSERVATIONS, not off whether an object was handed in: a
            # freshly booted deployment always has a tracker and it always snapshots,
            # but a tracker that has never seen a call holds no evidence about health,
            # and reporting "evidence_available: true, windows: []" for it would be
            # exactly the "there was no outage" claim this flag forbids.
            "evidence_available": _health_evidence_available(provider_health, rag_health),
            # The DERIVED windows (what the health records say) beside the APPLIED ones
            # (what was actually excluded, after clamping an unbounded start).
            "windows": [window.as_dict() for window in outages],
            "applied_windows": [window.as_dict() for window in applied_outages],
            "excluded_current": current_excluded,
            "excluded_lifetime": int(lifetime["excluded_outage"]),
            # Real dependency conditions that do NOT stop a verdict being produced, so
            # none of them removes a decision from the denominator.
            "context": derive_dependency_context(
                provider_health=provider_health, rag_health=rag_health
            ),
        },
        "gate_series": {
            "signal": "evidence_quality",
            "tuning_target": False,
            "bucket_minutes": bucket_minutes,
            "outcomes": list(AUTO_CLOSE_GATE_OUTCOMES),
            "closable_outcomes": [
                name for name in AUTO_CLOSE_GATE_OUTCOMES if name in _CLOSABLE_GATE_OUTCOMES
            ],
            "audit_rows_seen": len(audit_by_case),
            # How far back the audit page the caller supplied actually reached. None
            # means "not stated". A decision anchored OUTSIDE this span keeps its
            # ``unrecorded`` label — the pairing is by instant, so an unread row is
            # never substituted for by a later run's.
            "audit_span_hours": (
                int(decision_audit_span_hours)
                if isinstance(decision_audit_span_hours, (int, float))
                and not isinstance(decision_audit_span_hours, bool)
                else None
            ),
            "buckets": _gate_series(points, starts=starts, bucket_secs=bucket_secs),
            "disclaimer": (
                "Evidence quality only: how much of the append-only decision trail can "
                "still explain why auto-close did or did not fire. It carries no "
                "evidence that a blocked close would have been correct, so it is never "
                "a threshold-tuning target — threshold proposals come from the tuner's "
                "independent analyst-confirmed outcomes and go to human review."
            ),
        },
        "legacy_series": {
            "name": "auto_close_health",
            "note": (
                "This series and GET /api/metrics/auto-close-health measure different "
                "things and are expected to differ. The legacy series anchors on the "
                "LAST decision and reads the mutable case.decision_by/status, so an "
                "analyst acknowledging or re-tagging a case moves its historical "
                "numbers; this one anchors on the FIRST recorded decision and reads "
                "what that decision entry recorded. The legacy series also counts "
                "cases that failed to a human before the case manager ran, and never "
                "excludes recorded dependency outages."
            ),
        },
        "thresholds": {
            "min_decided": int(min_decided),
            "near_zero_rate": AUTO_CLOSE_NEAR_ZERO_RATE,
            "baseline_min_rate": AUTO_CLOSE_BASELINE_MIN_RATE,
            "steady_volume_fraction": AUTO_CLOSE_STEADY_VOLUME_FRACTION,
            "degraded_drop_fraction": AUTO_CLOSE_DEGRADED_DROP_FRACTION,
        },
        **truncation_marker(len(cases), store_total),
    }
