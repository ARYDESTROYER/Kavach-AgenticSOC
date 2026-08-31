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
# policy is disabled — only used to derive a smooth age-urgency curve, never to gate.
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


def _response_target_minutes(case: Case, sla: SlaPolicy | None) -> int:
    """The response-SLA target (minutes) for this case's priority, or the default."""
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
) -> list[dict[str, Any]]:
    """Rank the open attention-worthy cases by :func:`urgency_score`, newest-pressure
    first. Returns a COMPACT row per case (ids + the ranking inputs + a deep-link
    ``case_id``) — never the full case body. Plain data (#9); the UI renders escaped.

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
    rows.sort(key=lambda r: (r["urgency"], r["risk_score"], r["age_minutes"]), reverse=True)
    if limit and limit > 0:
        rows = rows[:limit]
    return rows


def _entity_value(case: Case) -> str:
    ent = getattr(case, "entity", None)
    if ent is None:
        return ""
    return str(getattr(ent, "value", "") or "")


def sla_aging(
    cases: Iterable[Case],
    sla: SlaPolicy | None,
    *,
    now: Any = None,
    warn_fraction: float = 0.75,
) -> dict[str, Any]:
    """Roll OPEN cases up against their per-priority RESPONSE-SLA target.

    Returns ``{enabled, warn_fraction, by_priority: {P1: {...}}, totals, breached[],
    about_to_breach[]}``. A case is *breached* when its age exceeds the response
    target, *about_to_breach* when it is within ``warn_fraction`` of it. When the SLA
    policy is disabled (or absent) the rollup is reported with ``enabled: false`` and
    empty breach lists (we don't invent a target). Advisory only (#3). Never raises."""
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
        prio = getattr(case, "priority_level", None) or "unprioritized"
        bucket = by_priority.setdefault(prio, {"open": 0, "breached": 0, "about_to_breach": 0})
        bucket["open"] += 1
        if not enabled:
            continue
        target = _response_target_minutes(case, sla)
        if target <= 0:
            continue
        age = case_age_minutes(case, now=ref)
        row = {
            "case_id": getattr(case, "case_id", "") or "",
            "display_id": _display_id(case),
            "priority_level": getattr(case, "priority_level", None) or "",
            "age_minutes": round(age, 1),
            "target_minutes": target,
            "overdue_minutes": round(age - target, 1) if age > target else 0.0,
        }
        if age >= target:
            bucket["breached"] += 1
            breached.append(row)
        elif age >= target * warn_fraction:
            bucket["about_to_breach"] += 1
            about_to.append(row)

    breached.sort(key=lambda r: r["overdue_minutes"], reverse=True)
    about_to.sort(key=lambda r: r["age_minutes"], reverse=True)
    return {
        "enabled": enabled,
        "warn_fraction": warn_fraction,
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


def headline_counts(cases: Iterable[Case], *, now: Any = None, sla: SlaPolicy | None = None) -> dict[str, int]:
    """The small set of comparable headline counts used for period-over-period deltas.

    Deterministic + cheap: total open, escalated, needs-human, unassigned, and SLA
    breached. Computed identically for the current AND prior windows so the delta is
    apples-to-apples. Never raises."""
    ref = now or now_utc()
    snapshot = list(cases)
    aging = sla_aging(snapshot, sla, now=ref)
    open_n = escalated = needs_human = unassigned = 0
    for case in snapshot:
        if not _is_attention(case):
            continue
        open_n += 1
        status = _status_value(case)
        if status == CaseStatus.ESCALATED.value:
            escalated += 1
        if status == CaseStatus.NEEDS_HUMAN.value:
            needs_human += 1
        if not (getattr(case, "assignee", "") or "").strip():
            unassigned += 1
    return {
        "open": open_n,
        "escalated": escalated,
        "needs_human": needs_human,
        "unassigned": unassigned,
        "sla_breached": int(aging["totals"]["breached"]),
    }


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
) -> dict[str, Any]:
    """Assemble the full forward-looking shift snapshot from a case list.

    Pure + deterministic — the SINGLE place the attention_queue / sla_aging / workload /
    deltas are composed (so both the engine standup-fold AND the /report route agree).
    ``prior_cases`` is the equal prior window's snapshot (for the deltas); when None the
    deltas compare against an empty prior window (all-current).

    ``prefs`` is OPTIONAL (default ``None``, so no existing caller breaks); it is only
    threaded to the attention queue so the severity band can be RESOLVED (the field is
    never persisted on a real case) instead of read as an always-``None`` attribute.
    Never raises."""
    ref = now or now_utc()
    snapshot = list(cases)
    current_counts = headline_counts(snapshot, now=ref, sla=sla)
    prior_counts = headline_counts(list(prior_cases or []), now=ref, sla=sla)
    return {
        "attention_queue": attention_queue(
            snapshot, sla=sla, now=ref, limit=attention_limit, prefs=prefs
        ),
        "sla_aging": sla_aging(snapshot, sla, now=ref),
        "workload": analyst_workload(snapshot),
        "headline_counts": current_counts,
        "deltas": period_deltas(current_counts, prior_counts),
    }
