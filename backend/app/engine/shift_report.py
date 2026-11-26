"""Shift handoff / standup attention engine (Round 3, Wave 2 — Feature 11).

PURE, DETERMINISTIC functions that turn a snapshot of OPEN cases (+ the operator's
SLA / priority policy) into the forward-looking "what needs attention THIS shift"
payload the standup brief leads with:

* :func:`attention_queue`  — open + NEEDS_HUMAN + escalated cases, ranked by an
  urgency score derived from ``risk_score`` / severity band / age / SLA target.
* :func:`sla_aging`        — breached + about-to-breach rollup vs the per-priority
  response/resolution targets.
* :func:`analyst_workload` — per-analyst open-case counts (unassigned bucketed).
* :func:`period_deltas`    — period-over-period change for a small set of headline
  counts (the caller aggregates the prior equal window the same way).

⚠ NON-NEGOTIABLE #3: every value here is ADVISORY — read-time presentation /
ranking ONLY. NONE of it feeds ``engine.case_manager.decide()``; the close/escalate
truth table stays a pure fn of ``(verdict, confidence, risk_score, policy)``. The
``severity_band``/``priority_level``/``urgency`` behind a row are themselves advisory
display fields — and ``severity_band`` is RESOLVED read-time through
:func:`app.engine.priority.band_of_case` (the persisted attribute is a presentation
field no production write path ever fills in), never read off the case. We NEVER mutate
a case here.

⚠ NON-NEGOTIABLE #9: case-derived strings (entity values, titles, assignees, rule
ids) are log/source-influenced. This module returns them as PLAIN data inside the
payload; the caller fences anything before it reaches a model (the standup only ever
sends the COMPACT aggregate — never these raw case bodies, #7), and the UI renders
them escaped.

Nothing here performs I/O, calls an LLM, or raises on bad input — a malformed case is
scored on its defaults, never dropped.
"""

from __future__ import annotations

from typing import Any, Iterable

from ..config import PriorityMatrix, SlaPolicy
from ..constants import CaseStatus, Verdict
from ..models import Case
from ..utils import now_utc, parse_es_timestamp
from . import metrics as _metrics
from .priority import band_of_case, severity_band_from_events
from .priority import derive_priority as _derive_priority_authority

# Lifecycle statuses that belong in the "needs you now" attention queue: any
# non-terminal case is a candidate (a closed/resolved case has been worked).
_ATTENTION_STATUSES: frozenset[str] = frozenset(
    {
        CaseStatus.NEW.value,
        CaseStatus.OPEN.value,
        CaseStatus.NEEDS_HUMAN.value,
        CaseStatus.INVESTIGATING.value,
        CaseStatus.ESCALATED.value,
        CaseStatus.ON_HOLD.value,
    }
)

# Coarse severity-band → 0..1 weight (advisory display field; #3-safe). Unknown /
# missing bands score 0 so a case ranks purely on its (real, decision-grade)
# ``risk_score`` + age, never UP-weighted by an unrecognised label.
_SEVERITY_WEIGHT: dict[str, float] = {
    "critical": 1.0,
    "high": 0.75,
    "medium": 0.5,
    "low": 0.25,
    "info": 0.1,
    "informational": 0.1,
}

# Default SLA *response* target (minutes) when a case has no priority or the SLA
# policy is disabled: only used to derive a smooth age-urgency curve, never to gate
# and never to count a breach (``sla_aging`` skips a case with no target).
_DEFAULT_RESPONSE_MINUTES = 120


def _status_value(case: Case) -> str:
    return getattr(getattr(case, "status", None), "value", "") or ""


def _is_attention(case: Case) -> bool:
    return _status_value(case) in _ATTENTION_STATUSES


def case_age_minutes(case: Case, *, now: Any = None) -> float:
    """Age of a case in minutes from its earliest known instant.

    Prefers ``detected_at`` (the real detection instant) when present, else
    ``created_at``. Never raises; an unparseable timestamp yields ``0.0`` (a brand-new
    case), so a bad value never inflates urgency."""
    ref = now or now_utc()
    raw = getattr(case, "detected_at", None) or getattr(case, "created_at", None)
    dt = parse_es_timestamp(raw)
    if dt is None:
        return 0.0
    delta = (ref - dt).total_seconds() / 60.0
    return delta if delta > 0 else 0.0


def _response_target_minutes(case: Case, sla: SlaPolicy | None, prio: str | None = None) -> int:
    """The response-SLA target (minutes) for this case's priority, or the default.

    ``prio`` is the level already resolved by the caller (:func:`sla_aging` resolves
    it with ``metrics._sla_priority``); without it the persisted level is read."""
    if prio is None:
        prio = getattr(case, "priority_level", None)
    if sla is not None and getattr(sla, "enabled", False) and prio:
        target = (getattr(sla, "targets", {}) or {}).get(prio)
        if target is not None:
            return int(getattr(target, "response_minutes", _DEFAULT_RESPONSE_MINUTES) or _DEFAULT_RESPONSE_MINUTES)
    return _DEFAULT_RESPONSE_MINUTES


def urgency_score(
    case: Case,
    *,
    sla: SlaPolicy | None = None,
    now: Any = None,
    prefs: Any = None,
) -> float:
    """A deterministic 0..1-ish urgency score for ranking the attention queue.

    Blend (all advisory, none gates #3):
      * ``risk_score`` (0..100 → 0..1) — the dominant, decision-grade signal.
      * severity band weight (0..1) — advisory display label.
      * an age pressure term that grows as the case approaches / passes its SLA
        response target (clamped) — older + closer-to-breach ranks higher.
      * a small escalation / NEEDS_HUMAN bump so a flagged case floats up.

    ``prefs`` is OPTIONAL (default ``None``, so no existing caller breaks) and is used
    ONLY to resolve the severity band through :func:`app.engine.priority.band_of_case`.
    It matters: ``Case.severity_band`` is a read-time presentation field that no
    production path persists, so reading the attribute directly scored the severity term
    at 0.0 for EVERY case — the whole queue ranked on risk + age alone. With ``None``
    the band is still derived, on the identity severity ceiling.

    Higher == more urgent. Never raises; missing fields contribute 0."""
    risk = float(getattr(case, "risk_score", 0.0) or 0.0) / 100.0
    if risk < 0:
        risk = 0.0
    if risk > 1:
        risk = 1.0

    band = str(band_of_case(case, prefs) or "").strip().lower()
    sev = _SEVERITY_WEIGHT.get(band, 0.0)

    target = _response_target_minutes(case, sla)
    age = case_age_minutes(case, now=now)
    # Age pressure: 0 at creation, ~1 at the response target, capped at 1.5 past it
    # (a long-overdue case keeps ranking above a fresh one but can't dominate risk).
    age_pressure = age / target if target > 0 else 0.0
    if age_pressure > 1.5:
        age_pressure = 1.5

    status = _status_value(case)
    bump = 0.0
    if status == CaseStatus.ESCALATED.value:
        bump += 0.25
    if status == CaseStatus.NEEDS_HUMAN.value:
        bump += 0.15
    verdict = getattr(getattr(case, "verdict", None), "value", "") or ""
    if verdict == Verdict.NEEDS_HUMAN.value:
        bump += 0.1

    # Weighted blend; risk carries the most weight, then severity, then age pressure.
    score = 0.5 * risk + 0.25 * sev + 0.2 * age_pressure + bump
    return round(score, 4)


def _display_id(case: Case) -> str:
    return getattr(case, "case_number", "") or getattr(case, "case_id", "") or ""


def _band_provenance(case: Case, prefs: Any) -> str:
    """The severity band's provenance token for one attention row.

    Mirrors :func:`app.engine.priority.severity_band_from_events`'s ``source`` field —
    ``"source_asserted"``, ``"derived"`` or ``"source_out_of_range"`` — so the Standup
    queue badges a code-derived band exactly as honestly as the Cases list does. A case
    whose band came from a PERSISTED ``severity_band`` (only the seeded demo corpus writes
    one) still reports the provenance of the underlying derivation, which is the honest
    reading: nothing about a stored presentation value makes it the source's claim.

    Fail-open: a malformed case reads ``"derived"`` (the weaker claim), never raises."""
    try:
        token = severity_band_from_events(case, prefs).get("source")
        return str(token) if token else "derived"
    except Exception:  # noqa: BLE001 — advisory provenance must never break the queue
        return "derived"


def attention_queue(
    cases: Iterable[Case],
    *,
    sla: SlaPolicy | None = None,
    now: Any = None,
    limit: int = 25,
    prefs: Any = None,
    with_created_at: bool = True,
) -> list[dict[str, Any]]:
    """Rank the open attention-worthy cases by :func:`urgency_score`, newest-pressure
    first. Returns a COMPACT row per case (ids + the ranking inputs + a deep-link
    ``case_id``) — never the full case body. Plain data (#9); the UI renders escaped.

    Each row carries the case's ``created_at`` (Round 16 B39) unless
    ``with_created_at`` is false: :func:`build_shift_report` leaves it out of the
    standup model's aggregate, which must stay inside the fence's size bound.

    Every row now carries a ``severity_band``, so it must also carry the band's
    PROVENANCE (``severity_source``). ``Case.severity_band`` is never persisted by a
    production write path, so before this the field was empty on every real case and the
    badge simply did not render; now the band falls back to a derivation from the
    deterministic risk total, and a queue that showed that number as the SOURCE's severity
    right beside the risk badge it was computed from would be claiming a second opinion it
    does not have. The token is the same three-way vocabulary the Cases list badges
    (``source_asserted`` / ``derived`` / ``source_out_of_range``).

    Ties break by ``risk_score`` then age (older first) for determinism."""
    ref = now or now_utc()
    rows: list[dict[str, Any]] = []
    for case in cases:
        if not _is_attention(case):
            continue
        score = urgency_score(case, sla=sla, now=ref, prefs=prefs)
        age = case_age_minutes(case, now=ref)
        band = band_of_case(case, prefs)
        rows.append(
            {
                "case_id": getattr(case, "case_id", "") or "",
                "case_number": getattr(case, "case_number", "") or "",
                "display_id": _display_id(case),
                "title": getattr(case, "title", "") or "",
                "status": _status_value(case),
                "verdict": getattr(getattr(case, "verdict", None), "value", "") or "",
                "risk_score": round(float(getattr(case, "risk_score", 0.0) or 0.0), 2),
                "severity_band": band,
                "severity_source": _band_provenance(case, prefs),
                "priority_level": getattr(case, "priority_level", None) or "",
                "assignee": getattr(case, "assignee", "") or "",
                "entity": _entity_value(case),
                "age_minutes": round(age, 1),
                "urgency": score,
            }
        )
        if with_created_at:
            # The case's creation time (Round 16 B39), as every other case list
            # carries it, so the shift brief and its exports can show an age.
            rows[-1]["created_at"] = getattr(case, "created_at", None) or None
    rows.sort(key=lambda r: (r["urgency"], r["risk_score"], r["age_minutes"]), reverse=True)
    if limit and limit > 0:
        rows = rows[:limit]
    return rows


def _entity_value(case: Case) -> str:
    ent = getattr(case, "entity", None)
    if ent is None:
        return ""
    return str(getattr(ent, "value", "") or "")


def _sla_level(case: Case, prefs: Any) -> str:
    """The P-level the SLA target is looked up by, resolved the way posture resolves
    it (``metrics._sla_priority``); ``""`` when there is none. Never raises."""
    try:
        return _metrics._sla_priority(case, prefs)
    except Exception:  # noqa: BLE001 - advisory; a malformed case is unprioritized
        return str(getattr(case, "priority_level", None) or "")


def _sla_target(sla: SlaPolicy | None, level: str) -> Any:
    """The ``SlaTarget`` configured for ``level``, or ``None`` when the level is empty or
    has no target (the posture rule of ``metrics.sla_metrics``: such a case is not
    SLA-scored). Never raises."""
    if not level:
        return None
    try:
        return (getattr(sla, "targets", None) or {}).get(level)
    except Exception:  # noqa: BLE001 - advisory; an unreadable policy scores nothing
        return None


def _response_clock(case: Case, target: Any, now: Any) -> Any:
    """The case's response clock from the ONE shared rule,
    ``metrics.sla_case_reading(...).response``: breached when the elapsed time is over
    the target, at risk when it still runs and at least ``metrics.SLA_AT_RISK_FRACTION``
    of the target has passed. ``None`` when there is no clock (a response target of 0
    or less, or no readable start). Never raises."""
    try:
        return _metrics.sla_case_reading(case, target, None, now=now).response
    except Exception:  # noqa: BLE001 - advisory; an unreadable case is not classified
        return None


def sla_aging(
    cases: Iterable[Case],
    sla: SlaPolicy | None,
    *,
    now: Any = None,
    warn_fraction: float = _metrics.SLA_AT_RISK_FRACTION,
    prefs: Any = None,
) -> dict[str, Any]:
    """Roll OPEN cases up against their per-priority RESPONSE-SLA target.

    Returns ``{enabled, warn_fraction, by_priority: {P1: {...}}, totals, breached[],
    about_to_breach[]}``. When the SLA policy is disabled (or absent) the rollup is
    reported with ``enabled: false`` and empty breach lists. Advisory only (#3). Never
    raises.

    Every open case is counted in its priority bucket's ``open``. It is classified only
    when its priority has a response target, by the SAME rule posture
    (``metrics.sla_metrics``) and the case page (``engine.sla_reading``) use,
    ``metrics.sla_case_reading``:

    * the P-level is resolved by ``metrics._sla_priority``: the persisted
      ``priority_level``, else, with ``prefs``, the read-time projection the case list
      shows. Without ``prefs`` only the persisted level is read;
    * a case whose level has no target (the matrix is off, the target is removed, or
      it is 0) is not classified. No default target is invented;
    * *breached* when the elapsed time is over the target; a response stops the clock,
      so a late response is breached by a fixed amount that never grows;
    * *about_to_breach* when the clock still runs and at least
      ``metrics.SLA_AT_RISK_FRACTION`` (0.8) of the target has passed, the posture
      "at risk" rule.

    ``warn_fraction`` is kept as a parameter and a payload key for older readers. The
    payload always reports the shared fraction the rule used; a value passed in no
    longer changes the rule, so it is not echoed."""
    enabled = bool(sla is not None and getattr(sla, "enabled", False))
    ref = now or now_utc()
    by_priority: dict[str, dict[str, int]] = {}
    breached: list[dict[str, Any]] = []
    about_to: list[dict[str, Any]] = []
    total_open = 0

    for case in cases:
        if not _is_attention(case):
            continue
        total_open += 1
        level = _sla_level(case, prefs)
        prio = level or "unprioritized"
        bucket = by_priority.setdefault(prio, {"open": 0, "breached": 0, "about_to_breach": 0})
        bucket["open"] += 1
        if not enabled:
            continue
        target = _sla_target(sla, level)
        if target is None:
            continue
        clock = _response_clock(case, target, ref)
        if clock is None or clock.state not in ("breached", "at_risk"):
            continue
        overdue = (
            round(clock.elapsed_minutes - clock.target_minutes, 1)
            if clock.state == "breached" else 0.0
        )
        row = {
            "case_id": getattr(case, "case_id", "") or "",
            "display_id": _display_id(case),
            "priority_level": level,
            "age_minutes": round(case_age_minutes(case, now=ref), 1),
            "target_minutes": int(clock.target_minutes),
            "overdue_minutes": overdue,
            # Who has it (Round 13 polish): the "close to their target" question asks.
            "assignee": str(getattr(case, "assignee", "") or ""),
        }
        if clock.state == "breached":
            bucket["breached"] += 1
            breached.append(row)
        else:
            bucket["about_to_breach"] += 1
            about_to.append(row)

    breached.sort(key=lambda r: r["overdue_minutes"], reverse=True)
    about_to.sort(key=lambda r: r["age_minutes"], reverse=True)
    return {
        "enabled": enabled,
        # The fraction the rule used, never a caller's value it ignored.
        "warn_fraction": _metrics.SLA_AT_RISK_FRACTION,
        "by_priority": by_priority,
        "totals": {
            "open": total_open,
            "breached": len(breached),
            "about_to_breach": len(about_to),
        },
        "breached": breached,
        "about_to_breach": about_to,
    }


def analyst_workload(cases: Iterable[Case]) -> list[dict[str, Any]]:
    """Per-analyst open-case workload, busiest first.

    Unassigned open cases roll into a single ``"(unassigned)"`` bucket. Plain data
    (#9). Counts only attention-worthy (non-terminal) cases. Never raises."""
    counts: dict[str, dict[str, int]] = {}
    for case in cases:
        if not _is_attention(case):
            continue
        who = (getattr(case, "assignee", "") or "").strip() or "(unassigned)"
        b = counts.setdefault(who, {"open": 0, "escalated": 0, "needs_human": 0})
        b["open"] += 1
        status = _status_value(case)
        if status == CaseStatus.ESCALATED.value:
            b["escalated"] += 1
        if status == CaseStatus.NEEDS_HUMAN.value:
            b["needs_human"] += 1
    rows = [
        {"analyst": who, **stats}
        for who, stats in counts.items()
    ]
    rows.sort(key=lambda r: (r["open"], r["escalated"]), reverse=True)
    return rows


def headline_counts(
    cases: Iterable[Case], *, now: Any = None, sla: SlaPolicy | None = None, needs_human_verdict: bool = False,
    prefs: Any = None,
) -> dict[str, int]:
    """The small set of comparable headline counts used for period-over-period deltas.

    Deterministic + cheap: total open, escalated, needs-human, unassigned, and SLA
    breached. Computed identically for the current AND prior windows so the delta is
    apples-to-apples. ``needs_human_verdict`` adds the count of open cases whose
    VERDICT is Needs human (chat's shift headline, Round 13 close; the Standup page and
    its model aggregate keep their keys). ``prefs`` resolves each case's SLA level
    (:func:`sla_aging`). Never raises."""
    ref = now or now_utc()
    snapshot = list(cases)
    aging = sla_aging(snapshot, sla, now=ref, prefs=prefs)
    open_n = escalated = needs_human = verdict_needs_human = unassigned = 0
    for case in snapshot:
        if not _is_attention(case):
            continue
        open_n += 1
        status = _status_value(case)
        if status == CaseStatus.ESCALATED.value:
            escalated += 1
        if status == CaseStatus.NEEDS_HUMAN.value:
            needs_human += 1
        verdict = getattr(getattr(case, "verdict", None), "value", getattr(case, "verdict", None))
        if str(verdict or "").upper() == "NEEDS_HUMAN":
            verdict_needs_human += 1
        if not (getattr(case, "assignee", "") or "").strip():
            unassigned += 1
    counts = {
        "open": open_n,
        "escalated": escalated,
        # ``needs_human`` is the legacy STATUS (the Standup page's count);
        # ``needs_human_verdict`` the open cases whose VERDICT is Needs human, the
        # badge a case list beside these counts shows (Round 13 close).
        "needs_human": needs_human,
        "unassigned": unassigned,
        "sla_breached": int(aging["totals"]["breached"]),
    }
    if needs_human_verdict:
        counts["needs_human_verdict"] = verdict_needs_human
    return counts


def period_deltas(current: dict[str, int], prior: dict[str, int]) -> dict[str, dict[str, int]]:
    """Period-over-period delta for each headline metric.

    ``{metric: {current, prior, delta}}`` where ``delta = current - prior``. Keys are
    the union of both inputs (a missing side counts as 0). Deterministic; never raises."""
    out: dict[str, dict[str, int]] = {}
    for key in set(current) | set(prior):
        cur = int(current.get(key, 0) or 0)
        pri = int(prior.get(key, 0) or 0)
        out[key] = {"current": cur, "prior": pri, "delta": cur - pri}
    return out


def derive_priority(
    impact_band: str | None,
    urgency_band: str | None,
    matrix: PriorityMatrix | None,
) -> str | None:
    """Map an ``impact × urgency`` band pair → a P-level via the PriorityMatrix.

    Read-time derivation ONLY (advisory display — #3-safe; it never feeds decide()).
    Returns None when the matrix is disabled/absent or both bands are empty.

    Round 5 (bug #14): this now DELEGATES to the ONE authority
    :func:`app.engine.priority.derive_priority` so the shift report and the triage chip
    can never disagree on ``matrix.enabled`` again — it simply unwraps that function's
    ``level`` (which is ``None`` exactly when the matrix is disabled). The empty-both-
    bands short-circuit is kept (the shift report specifically shows nothing for a case
    with no bands). Never raises."""
    if matrix is None:
        return None
    imp = str(impact_band or "").strip().lower()
    urg = str(urgency_band or "").strip().lower()
    if not imp and not urg:
        return None
    return _derive_priority_authority(imp, urg, matrix).get("level")


def build_shift_report(
    cases: Iterable[Case],
    prior_cases: Iterable[Case] | None = None,
    *,
    sla: SlaPolicy | None = None,
    now: Any = None,
    attention_limit: int = 25,
    prefs: Any = None,
    needs_human_verdict: bool = False,
) -> dict[str, Any]:
    """Assemble the full forward-looking shift snapshot from a case list.

    Pure + deterministic — the SINGLE place the attention_queue / sla_aging / workload /
    deltas are composed (so both the engine standup-fold AND the /report route agree).
    ``prior_cases`` is the equal prior window's snapshot (for the deltas); when None the
    deltas compare against an empty prior window (all-current).

    ``prefs`` is OPTIONAL (default ``None``, so no existing caller breaks); it is
    threaded to the attention queue so the severity band can be RESOLVED (the field is
    never persisted on a real case) instead of read as an always-``None`` attribute,
    and to the SLA aging so each case's P-level is resolved the way posture resolves
    it (Round 16 B60).

    The attention rows carry ``created_at`` (Round 16 B39) for the callers that show
    them to people: ``GET /api/standup/report`` and chat's shift report, the two
    callers that ask for ``needs_human_verdict``. The standup model's aggregate
    (``StandupService.generate``, which does not ask for it) leaves them out, so that
    aggregate does not grow past the 16,000-character fence bound. Never raises."""
    ref = now or now_utc()
    snapshot = list(cases)
    current_counts = headline_counts(snapshot, now=ref, sla=sla, needs_human_verdict=needs_human_verdict,
                                     prefs=prefs)
    prior_counts = headline_counts(list(prior_cases or []), now=ref, sla=sla,
                                   needs_human_verdict=needs_human_verdict, prefs=prefs)
    return {
        "attention_queue": attention_queue(
            snapshot, sla=sla, now=ref, limit=attention_limit, prefs=prefs,
            with_created_at=needs_human_verdict,
        ),
        "sla_aging": sla_aging(snapshot, sla, now=ref, prefs=prefs),
        "workload": analyst_workload(snapshot),
        "headline_counts": current_counts,
        "deltas": period_deltas(current_counts, prior_counts),
    }
