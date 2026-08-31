"""Independent analyst-outcome classification shared by tuning and RAG.

Terminal state, model verdict, disposition alone, or a generic analyst lifecycle
action are not ground truth.  Only graded feedback or an explicit classification
action may label an outcome for continuous-improvement consumers.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..constants import DecisionBy
from ..models import Case

_FP_FEEDBACK_OUTCOMES = frozenset({"false_positive", "true_negative"})
_TP_FEEDBACK_OUTCOMES = frozenset({"true_positive", "false_negative"})
_FP_ANALYST_DISPOSITIONS = frozenset({"false_positive", "benign"})
_TP_ANALYST_DISPOSITIONS = frozenset({"true_positive"})
#: The analyst actions that turn a model-derived disposition into ground truth. Public
#: because the precedent projection needs the SAME vocabulary to find the entry that
#: did the confirming; a second private copy would drift.
CLASSIFICATION_ACTIONS = frozenset({"set_disposition", "confirm_fp"})
_CLASSIFICATION_ACTIONS = CLASSIFICATION_ACTIONS  # historical private spelling


def _value(item: Any, key: str) -> Any:
    return item.get(key) if isinstance(item, dict) else getattr(item, key, None)


def _parse_iso(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)


def analyst_confirmed_outcome(case: Case) -> tuple[str | None, str | None]:
    """Return canonical binary ground truth plus its independent evidence source.

    The latest valid feedback label wins.  Without feedback, the disposition counts
    only when an analyst performed ``set_disposition`` or ``confirm_fp``.  Actions
    such as acknowledge, close, resolve, hold, assignment, or status changes never
    turn a model-derived disposition into analyst-confirmed evidence.
    """
    latest: tuple[datetime, int, str] | None = None
    for index, item in enumerate(case.feedback or []):
        raw = str(_value(item, "actual_outcome") or "").strip().lower()
        if raw not in _FP_FEEDBACK_OUTCOMES | _TP_FEEDBACK_OUTCOMES:
            continue
        candidate = (_parse_iso(_value(item, "ts")), index, raw)
        if latest is None or candidate[:2] > latest[:2]:
            latest = candidate
    if latest is not None:
        return (
            "false_positive" if latest[2] in _FP_FEEDBACK_OUTCOMES else "true_positive",
            "analyst_feedback",
        )

    decided_by = getattr(case.decision_by, "value", case.decision_by)
    if decided_by != DecisionBy.ANALYST.value:
        return None, None
    explicitly_classified = any(
        isinstance(entry, dict)
        and entry.get("event") == "analyst_action"
        and str(entry.get("action") or "") in _CLASSIFICATION_ACTIONS
        for entry in reversed(case.history or [])
    )
    if not explicitly_classified:
        return None, None
    disposition = str(getattr(case.disposition, "value", case.disposition) or "")
    if disposition in _FP_ANALYST_DISPOSITIONS:
        return "false_positive", "explicit_analyst_disposition"
    if disposition in _TP_ANALYST_DISPOSITIONS:
        return "true_positive", "explicit_analyst_disposition"
    return None, None
