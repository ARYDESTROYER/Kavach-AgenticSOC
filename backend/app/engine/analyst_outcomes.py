"""Independent analyst-outcome classification shared by tuning and RAG.

Terminal state, model verdict, disposition alone, or a generic analyst lifecycle
action are not ground truth.  Only graded feedback or an explicit classification
action may label an outcome for continuous-improvement consumers.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..constants import CaseStatus, DecisionBy
from ..models import Case
from ..utils import iso_now, now_utc

_FP_FEEDBACK_OUTCOMES = frozenset({"false_positive", "true_negative"})
_TP_FEEDBACK_OUTCOMES = frozenset({"true_positive", "false_negative"})
#: The feedback ``actual_outcome`` values that carry a binary label at all.  Anything
#: else — most importantly the ``unknown`` default the HTTP contract fills in — is
#: recorded feedback that supplies NO ground truth.
GROUND_TRUTH_FEEDBACK_OUTCOMES = _FP_FEEDBACK_OUTCOMES | _TP_FEEDBACK_OUTCOMES
_FP_ANALYST_DISPOSITIONS = frozenset({"false_positive", "benign"})
_TP_ANALYST_DISPOSITIONS = frozenset({"true_positive"})
#: The analyst actions that turn a model-derived disposition into ground truth. Public
#: because the precedent projection needs the SAME vocabulary to find the entry that
#: did the confirming; a second private copy would drift.
CLASSIFICATION_ACTIONS = frozenset({"set_disposition", "confirm_fp"})
_CLASSIFICATION_ACTIONS = CLASSIFICATION_ACTIONS  # historical private spelling

#: History-entry key carrying the disposition an analyst DECLARED while performing an
#: action whose own verb is not a classification verb.
#:
#: The Console's PRIMARY close is "Close with a disposition", which posts
#: ``action="close"`` plus the chosen disposition.  ``close`` is not — and must not
#: become — a classification verb: most closes carry no disposition at all, and the one
#: they do carry may be the value ``case_manager.apply()`` derived from the model's own
#: verdict, read off the case and posted straight back.  A disposition on the wire is
#: therefore evidence of nothing on its own.
#:
#: So the writer stamps this key only on an AFFIRMATIVE declaration — the dedicated
#: ``set_disposition`` verb, or ``CaseAction.disposition_declared`` set by a caller
#: asserting a human chose the value in that interaction (``api/routes``,
#: ``_SELF_DECLARING_ACTIONS`` / the apply-vs-classify split).  That is what
#: distinguishes "the analyst chose false-positive and then closed" from "the analyst
#: closed a case whose disposition the model had already filled in", and the
#: distinction lives in the WIRE, not in the value.  Public for the same reason as
#: :data:`CLASSIFICATION_ACTIONS`: the precedent projection reads the same vocabulary to
#: find the entry that did the confirming.
CLASSIFIED_DISPOSITION_KEY = "classified_disposition"

#: Statuses the resolved-case precedent projection actually scans.  Analyst feedback on
#: an escalated or in-flight case is ordinary and real, but it is not yet SUPPLY for the
#: corpus, so the supply measurement below counts the same population the projection does.
_PROJECTABLE_STATUSES = frozenset({CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value})


def _value(item: Any, key: str) -> Any:
    return item.get(key) if isinstance(item, dict) else getattr(item, key, None)


def _parse_iso_opt(value: Any) -> datetime | None:
    """Parse an ISO instant, or ``None`` when it is absent/unparseable.

    Kept separate from :func:`_parse_iso` because the two callers need opposite
    behaviour: ordering wants a total order (an unparseable value sorts first), while a
    MEASUREMENT must be able to say "not measurable" rather than invent an instant.
    """
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_iso(value: Any) -> datetime:
    parsed = _parse_iso_opt(value)
    return parsed if parsed is not None else datetime.min.replace(tzinfo=timezone.utc)


def is_classification_entry(entry: Any) -> bool:
    """True when a case-history entry is an EXPLICIT analyst classification.

    Two shapes qualify, and only these two:

    * a dedicated classification verb (:data:`CLASSIFICATION_ACTIONS`), and
    * any analyst action that stamped :data:`CLASSIFIED_DISPOSITION_KEY`, which the
      writer sets only on an affirmative declaration that a human chose the value.

    A bare lifecycle move — acknowledge, close, resolve, hold, assign, status change —
    never qualifies, so a model-derived disposition can still never be promoted to
    ground truth by the passage of a case through the queue.  Nor does a close that
    merely CARRIES a disposition: without the declaration the writer leaves this key
    off, precisely so an echoed model value cannot masquerade as a label.
    """
    if not isinstance(entry, dict) or entry.get("event") != "analyst_action":
        return False
    if str(entry.get("action") or "") in CLASSIFICATION_ACTIONS:
        return True
    return bool(str(entry.get(CLASSIFIED_DISPOSITION_KEY) or "").strip())


def _confirmation(case: Case) -> tuple[str | None, str | None, str | None]:
    """``(outcome, evidence_source, confirmed_at)`` — the single classification core.

    :func:`analyst_confirmed_outcome` and :func:`analyst_confirmation_time` are both
    thin projections of this, so the label and the instant that produced it can never
    disagree about which piece of evidence won.
    """
    latest: tuple[datetime, int, str, str] | None = None
    for index, item in enumerate(case.feedback or []):
        raw = str(_value(item, "actual_outcome") or "").strip().lower()
        if raw not in GROUND_TRUTH_FEEDBACK_OUTCOMES:
            continue
        ts = str(_value(item, "ts") or "")
        candidate = (_parse_iso(ts), index, raw, ts)
        if latest is None or candidate[:2] > latest[:2]:
            latest = candidate
    if latest is not None:
        return (
            "false_positive" if latest[2] in _FP_FEEDBACK_OUTCOMES else "true_positive",
            "analyst_feedback",
            latest[3] or None,
        )

    decided_by = getattr(case.decision_by, "value", case.decision_by)
    if decided_by != DecisionBy.ANALYST.value:
        return None, None, None
    classified_at: str | None = None
    explicitly_classified = False
    for entry in reversed(case.history or []):
        if is_classification_entry(entry):
            explicitly_classified = True
            classified_at = str(entry.get("ts") or "") or None
            break
    if not explicitly_classified:
        return None, None, None
    disposition = str(getattr(case.disposition, "value", case.disposition) or "")
    if disposition in _FP_ANALYST_DISPOSITIONS:
        return "false_positive", "explicit_analyst_disposition", classified_at
    if disposition in _TP_ANALYST_DISPOSITIONS:
        return "true_positive", "explicit_analyst_disposition", classified_at
    return None, None, None


def analyst_confirmed_outcome(case: Case) -> tuple[str | None, str | None]:
    """Return canonical binary ground truth plus its independent evidence source.

    The latest valid feedback label wins.  Without feedback, the disposition counts
    only when the analyst EXPLICITLY classified the case — either through a dedicated
    classification verb (``set_disposition`` / ``confirm_fp``) or by DECLARING the
    disposition as part of another action, which stamps
    :data:`CLASSIFIED_DISPOSITION_KEY` on that history entry.  Actions such as
    acknowledge, resolve, hold, assignment, or status changes never turn a
    model-derived disposition into analyst-confirmed evidence — and neither does a
    close, whether it carries a disposition or not, unless that disposition was
    declared.
    """
    outcome, source, _ = _confirmation(case)
    return outcome, source


def analyst_confirmation_time(case: Case) -> str | None:
    """When the independent evidence that labels ``case`` was recorded (ISO), or None.

    ``None`` means either "no label" or "the labelling evidence carried no timestamp" —
    both of which a supply measurement must report as unmeasured rather than guess at.
    """
    return _confirmation(case)[2]


def ground_truth_supply(
    cases: list[Case],
    *,
    now: datetime | None = None,
    store_total: int | None = None,
) -> dict[str, Any]:
    """MEASURED supply of new analyst ground truth.  No threshold, no verdict.

    Rendering and selecting the precedent corpus better does not create SUPPLY: if
    nothing new is ever labelled, a perfectly rendered corpus is a frozen one.  This is
    the evidence for whether supply exists at all, reported as plain numbers:

    * ``days_since_last_qualifying_precedent`` — how long since a case the projection
      can actually draw from (analyst-confirmed AND terminal) was confirmed.
    * ``feedback_without_ground_truth_share`` — the fraction of recorded feedback
      entries carrying no binary ``actual_outcome``.  This is the intake gap: feedback
      is being collected but no label comes with it.

    Deliberately threshold-free and verdict-free.  It publishes no ``status``, no
    ``starved``, no ``ok`` — an operator reads the numbers, and a number that could not
    be measured is ``None`` rather than zero (no feedback at all is NOT a 0% gap).  It
    never infers a label from ``assessment``: an analyst disagreeing with the model is
    not a statement about what actually happened.

    Pure + read-only; advisory only; never read by ``case_manager.decide()`` (#3).
    """
    # Imported lazily: ``engine.metrics`` imports this module, so a top-level import
    # would be circular.  By call time both modules are fully initialised.
    from .metrics import truncation_marker

    reference = now or now_utc()
    qualifying = 0
    latest_at: str | None = None
    latest_dt: datetime | None = None
    feedback_total = 0
    feedback_with_label = 0
    cases_with_feedback = 0

    for case in cases:
        entries = list(getattr(case, "feedback", None) or [])
        if entries:
            cases_with_feedback += 1
        for item in entries:
            feedback_total += 1
            raw = str(_value(item, "actual_outcome") or "").strip().lower()
            if raw in GROUND_TRUTH_FEEDBACK_OUTCOMES:
                feedback_with_label += 1
        outcome, _, confirmed_at = _confirmation(case)
        if outcome is None:
            continue
        status = str(getattr(getattr(case, "status", None), "value", "") or "")
        if status not in _PROJECTABLE_STATUSES:
            continue
        qualifying += 1
        parsed = _parse_iso_opt(confirmed_at)
        if parsed is not None and (latest_dt is None or parsed > latest_dt):
            latest_dt = parsed
            latest_at = confirmed_at

    days: float | None = None
    if latest_dt is not None:
        # Clamped at zero: a clock-skewed future stamp is still "as recent as it gets",
        # and a negative age would read as a defect in the measurement rather than in
        # the clock.
        days = round(max(0.0, (reference - latest_dt).total_seconds() / 86400.0), 3)

    share: float | None = None
    if feedback_total:
        share = round((feedback_total - feedback_with_label) / feedback_total, 4)

    return {
        # Supply the projection can actually draw from: analyst-confirmed AND terminal.
        "qualifying_precedents": qualifying,
        "last_qualifying_precedent_at": latest_at,
        # None = no qualifying precedent in the fetched set, or none of them carried a
        # readable confirming timestamp. Never 0.0, which would read as "just now".
        "days_since_last_qualifying_precedent": days,
        "feedback_entries": feedback_total,
        "feedback_entries_with_ground_truth": feedback_with_label,
        "feedback_entries_without_ground_truth": feedback_total - feedback_with_label,
        # None when no feedback exists at all — an unmeasured share, not a 0% gap.
        "feedback_without_ground_truth_share": share,
        "cases_with_feedback": cases_with_feedback,
        "scanned_cases": len(cases),
        "measured_at": iso_now(),
        **truncation_marker(len(cases), store_total),
    }
