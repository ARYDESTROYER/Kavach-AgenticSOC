"""Is a feedback entry an auto-close review grade? (Round 15 SPEC D6.7, D6.8)

A person's review of a randomly sampled automatic close is recorded as an ordinary
``FeedbackEntry`` (it is independent ground truth, read by
``engine.analyst_outcomes``, the threshold tuner and the precedent corpus), but it must
stay out of the views that measure agreement with the AI agent: the sample is drawn only
from automatic closes, so counting it there would shift the population those views
describe (``engine.metrics.feedback_stats``, the ``engine.agent_improvement``
comparisons).

The marker is rollback-safe. The review writer sets ``FeedbackEntry.origin`` to
:data:`~app.constants.AUTO_CLOSE_REVIEW_ORIGIN` and ``review_id`` to its ledger entry,
and appends one case history event ``{"event": "auto_close_review", "review_id",
"feedback_ts", "analyst", "ts", "agrees"}``. A previous build drops the two unknown
``FeedbackEntry`` fields on its next full save but keeps the ``history`` dicts, so the
entry is still recognised from the history event that names its time and analyst.

The history event is written ONLY when the case is in the review ledger, and the history
branch below requires its ``review_id`` to be non-empty, so an ordinary grade on an
unsampled agent-closed case is never mistaken for a review grade.

Pure: no I/O, and no import of ``engine.case_manager`` (a review never decides, #3).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..constants import AUTO_CLOSE_REVIEW_EVENT, AUTO_CLOSE_REVIEW_ORIGIN

__all__ = ["is_review_grade", "review_events"]


def _field(obj: Any, name: str) -> Any:
    """``obj.name`` for a model, ``obj[name]`` for a mapping (a raw projection)."""
    if isinstance(obj, Mapping):
        return obj.get(name)
    return getattr(obj, name, None)


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def review_events(case: Any) -> list[Mapping[str, Any]]:
    """The case's ``auto_close_review`` history events that name a review (a non-empty
    ``review_id``), oldest first. Malformed entries are skipped."""
    out: list[Mapping[str, Any]] = []
    for entry in _field(case, "history") or []:
        if not isinstance(entry, Mapping):
            continue
        if entry.get("event") != AUTO_CLOSE_REVIEW_EVENT:
            continue
        if not _text(entry.get("review_id")):
            continue
        out.append(entry)
    return out


def is_review_grade(case: Any, entry: Any) -> bool:
    """True when ``entry`` (a ``FeedbackEntry`` of ``case``) is an auto-close review
    grade: its ``origin`` is ``"auto_close_review"``, or the case carries an
    ``auto_close_review`` history event with a non-empty ``review_id`` whose
    ``feedback_ts`` and ``analyst`` equal the entry's ``ts`` and ``analyst``.

    Accepts models or plain mappings for both arguments; never raises."""
    if entry is None:
        return False
    if _text(_field(entry, "origin")) == AUTO_CLOSE_REVIEW_ORIGIN:
        return True
    ts = _text(_field(entry, "ts"))
    if not ts:
        return False
    analyst = _text(_field(entry, "analyst"))
    for event in review_events(case):
        if _text(event.get("feedback_ts")) == ts and _text(event.get("analyst")) == analyst:
            return True
    return False
