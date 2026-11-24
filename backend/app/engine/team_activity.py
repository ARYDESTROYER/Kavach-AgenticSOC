"""Team activity: what each person did, per day, from the audit log (Round 15 SPEC D3).

The Team activity page answers "what has my team done today, this week?" for a SOC
manager (and, read only, an auditor). The source of truth is the append-only audit log
(#2): an exact fold over the rows in the window, never a counter projection that could
drift from it. This module is the pure part of that fold. It reads plain audit rows and
plain cases and returns plain data; it never touches a store, a model or ``decide()``
(#3, #6, #7), and nothing it returns is ever put in a prompt (#7, #9).

What is counted (SPEC D3.8), per person, for the window and per calendar day in the
operator time zone (``SlaPolicy.timezone``):

* ``acknowledged``: an Acknowledge action on a case;
* ``closed``: a lifecycle action that moved a case to Closed (Close, Confirm false
  positive, or Set status to Closed), split by the disposition the case was closed with
  (true positive, false positive, benign, duplicate, other);
* ``reopened`` and ``escalated``: the Reopen and Escalate actions;
* ``commented``: a comment, or a case thread post a person wrote as a person (a post
  labelled as the AI's or the system's is not counted);
* ``assigned``: an owner change made by the person (as the actor);
* ``screenshot_added``: a screenshot attached to a case;
* ``reviewed``: an auto-close review recorded (agreed, disagreed or unsure);
* ``runbook_step_done``: a runbook step marked done (a row whose ``changes`` hold
  ``steps.<id>.status`` with ``after`` ``done``, on ``step.updated``,
  ``step.decision_recorded``, ``step.action_recorded`` or ``step.approved``);
* ``signed_in``: a sign-in.

Each lifecycle and assignment count also says how many of its rows a bulk action wrote
(``run_id`` ``bulk-...``, SPEC D7.3). Rows written before Round 15 carry no structured
``action``: their verb is read from the fixed leading tokens of their ``result_summary``
(``action=<verb> status <from>→<to> disposition=<d>`` for a lifecycle row, ``comment
added`` and ``assigned to ...`` for a collaboration row, ``thread post (human)`` for a
thread post). Only those fixed, server-written tokens are read; the free text after them
(a reason) never is.

People are keyed by ``actor.strip().lower()`` (the user store's own normalisation), so
"Admin" and "admin" are one person. Rows whose actor is ``analyst``, ``default`` or empty
(written with sign-in off, or before sign-in attribution) are grouped as Not attributed.
Only rows a person made count (recorded or derived ``actor_type`` human) and only rows
that succeeded (an outcome of success, or none recorded).

Screenshots and reviews are written audit-first (``app.audit.write``, SPEC D5.10, D6.6,
D7.6): their row is appended before the store write and, when that write then fails, a
failure row (``case.file_attach_failed``, ``case.review_record_failed``) with the same
request id follows it. Such an action row was never applied, so it is not counted. The
fold reads it as the Audit log's inspector does: an action row is not applied when the
next row of the same request, actor and case (and session, when both name one) among
that writer's rows is its failure row. These two writers' rows are therefore held until
the first read, and read a little past the window's end (:data:`PAIRING_HORIZON`), where
a failure row can land a few milliseconds after the action row it follows.

Counts come with context and nothing else: there is no ranking, no score and no
"top performer" (SPEC D3.5). Every honesty flag is kept: a read that stopped at a row
limit says its counts are lower bounds, and the median time to acknowledge is omitted
rather than estimated when it would need more than :data:`ACK_CASES_LIMIT` cases.
"""

from __future__ import annotations

import json
import re
import statistics
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping

from ..audit import events as audit_events
from ..audit.query import (
    And,
    Eq,
    In,
    Predicate,
    TsRange,
    all_of,
    any_of,
    missing,
)
from ..audit.write import failure_action
from ..constants import (
    BULK_RUN_ID_PREFIX,
    CASE_ACTIONS_TAKEN,
    CASE_ACTIONS_TAKEN_LABELS,
    CASE_ASSIGNED_AUDIT_ACTION,
    CASE_COMMENTED_AUDIT_ACTION,
    CASE_LIFECYCLE_AUDIT_ACTIONS,
)
from ..utils import parse_es_timestamp
from .time_windows import ResolvedWindow, align_whole_periods, calendar_buckets, resolve_window, zone_for

# --------------------------------------------------------------------------- #
# Bounds (SPEC D3.6, D3.8)
# --------------------------------------------------------------------------- #
#: The longest window the page reads, in calendar days.
MAX_WINDOW_DAYS = 92
#: The most audit rows one answer scans; past it the counts are lower bounds.
MAX_SCANNED_ROWS = 250_000
#: The most cases read to measure the median time to acknowledge; past it the median is
#: omitted (never estimated from a part).
ACK_CASES_LIMIT = 5_000
#: Agreement is stated as a rate only from this many answered reviews (SPEC D3.8).
REVIEW_RATE_MIN = 30
#: How far before the window a review's sample row is looked for ("Time to review").
REVIEW_LOOKBACK = timedelta(days=31)
#: The longest window token accepted (every documented form is far shorter).
WINDOW_TOKEN_MAX_CHARS = 64

# --------------------------------------------------------------------------- #
# Kinds
# --------------------------------------------------------------------------- #
ACKNOWLEDGED = "acknowledged"
CLOSED = "closed"
REOPENED = "reopened"
ESCALATED = "escalated"
COMMENTED = "commented"
ASSIGNED = "assigned"
SCREENSHOT_ADDED = "screenshot_added"
REVIEWED = "reviewed"
RUNBOOK_STEP_DONE = "runbook_step_done"
SIGNED_IN = "signed_in"

#: Case work, in the order the page lists it.
WORK_KINDS: tuple[str, ...] = (
    ACKNOWLEDGED, CLOSED, REOPENED, ESCALATED, COMMENTED, ASSIGNED,
    SCREENSHOT_ADDED, REVIEWED, RUNBOOK_STEP_DONE,
)
#: Every counted kind: case work, then sign-ins.
ALL_KINDS: tuple[str, ...] = (*WORK_KINDS, SIGNED_IN)
#: The kinds whose rows a bulk action can write (SPEC D3.8 "of which in bulk jobs").
BULK_KINDS: tuple[str, ...] = (ACKNOWLEDGED, CLOSED, REOPENED, ESCALATED, ASSIGNED)
#: The seven stacked kinds of the per-day chart (SPEC D3.11); the rest of the case work
#: is "other". Sign-ins are not case work and are not charted.
CHART_KINDS: tuple[str, ...] = (CLOSED, ACKNOWLEDGED, COMMENTED, REVIEWED, ESCALATED, REOPENED, "other")
#: The dispositions a close is split by; anything else is "other".
CLOSE_GROUPS: tuple[str, ...] = ("true_positive", "false_positive", "benign", "duplicate", "other")

#: The server-worded name of each kind on a person's events (SPEC D3.10).
KIND_LABELS: Mapping[str, str] = {
    ACKNOWLEDGED: "Acknowledged a case",
    CLOSED: "Closed a case",
    REOPENED: "Reopened a case",
    ESCALATED: "Escalated a case",
    COMMENTED: "Commented on a case",
    ASSIGNED: "Assigned a case",
    SCREENSHOT_ADDED: "Added a screenshot",
    REVIEWED: "Reviewed an automatic close",
    RUNBOOK_STEP_DONE: "Completed a runbook step",
    SIGNED_IN: "Signed in",
}
#: The words a close's disposition reads as on an event.
DISPOSITION_LABELS: Mapping[str, str] = {
    "true_positive": "True positive",
    "false_positive": "False positive",
    "benign": "Benign",
    "duplicate": "Duplicate",
    "suspicious": "Suspicious",
    "undetermined": "Undetermined",
}

#: Actors that name nobody: rows written with sign-in off, or before sign-in attribution
#: (SPEC D3.9). Grouped as Not attributed.
UNATTRIBUTED_ACTORS: frozenset[str] = frozenset({"", "analyst", "default"})
#: The roster kinds (SPEC D3.9) and the Not attributed group.
KIND_ACCOUNT = "account"
KIND_ENVIRONMENT = "environment"
KIND_DEMO = "demo"
KIND_DELETED = "deleted"
KIND_UNATTRIBUTED = "unattributed"

# --------------------------------------------------------------------------- #
# The rows a fold reads
# --------------------------------------------------------------------------- #
_STEP_ACTIONS: tuple[str, ...] = ("step.updated", "step.decision_recorded", "step.action_recorded", "step.approved")
FILE_ATTACHED_ACTION = "case.file_attached"
REVIEW_RECORDED_ACTION = "case.review_recorded"
REVIEW_REQUESTED_ACTION = "case.review_requested"
SIGN_IN_ACTION = "auth.login"
_LIFECYCLE_VERB_BY_ACTION: Mapping[str, str] = {v: k for k, v in CASE_LIFECYCLE_AUDIT_ACTIONS.items()}
#: The lifecycle actions whose rows can be counted (the others are read and ignored).
_COUNTED_LIFECYCLE_ACTIONS: tuple[str, ...] = tuple(sorted(
    CASE_LIFECYCLE_AUDIT_ACTIONS[verb]
    for verb in ("acknowledge", "close", "confirm_fp", "reopen", "escalate", "set_status")
))
#: Every structured case-work action the fold counts.
WORK_ACTIONS: tuple[str, ...] = tuple(sorted({
    *_COUNTED_LIFECYCLE_ACTIONS,
    CASE_COMMENTED_AUDIT_ACTION,
    CASE_ASSIGNED_AUDIT_ACTION,
    FILE_ATTACHED_ACTION,
    REVIEW_RECORDED_ACTION,
    *_STEP_ACTIONS,
}))
#: The legacy (no ``action``) case rows whose summary the fold reads.
_LEGACY_ACTION_TYPES: tuple[str, ...] = ("collab", "status", "thread_post")
#: The counted writers that append their row before the store write (audit-first): a
#: row is counted only once the fold has seen that its failure row does not follow it.
AUDIT_FIRST_ACTIONS: tuple[str, ...] = (FILE_ATTACHED_ACTION, REVIEW_RECORDED_ACTION)
#: Each one's failure row (``case.file_attach_failed``, ``case.review_record_failed``),
#: mapped to the action row it says was not applied.
NOT_APPLIED_ACTIONS: Mapping[str, str] = {failure_action(a): a for a in AUDIT_FIRST_ACTIONS}
#: How far past the window's end these writers' rows are read, so a failure row that
#: lands just after the end still pairs with the action row it follows.
PAIRING_HORIZON = timedelta(minutes=5)

_LEGACY_LIFECYCLE_RE = re.compile(
    r"^action=([a-z_]{1,32}) status ([a-z_?]{1,32})\u2192([a-z_]{1,32}) disposition=([a-z_]{1,32})"
)
_STEP_STATUS_RE = re.compile(r"^steps\.(.{1,128})\.status$")
#: The fixed lead of a case thread post a person wrote (``thread post (human)``, then
#: optional reply and mention tokens); ``(ai)`` and ``(system)`` posts are not counted.
_HUMAN_THREAD_POST = "thread post (human)"
_OK_OUTCOMES = frozenset({None, "success"})


def window_predicate(window: ResolvedWindow) -> Predicate:
    """The window as a predicate: ``[start, end)`` (the audit range is inclusive, so its
    upper bound is the last microsecond before ``end``)."""
    upper = None if window.open_end else window.end - timedelta(microseconds=1)
    return TsRange(window.start, upper)


def work_predicate() -> Predicate:
    """The case-work rows a fold reads (any window). Narrower than "every People row",
    so a busy audit log of agent and system rows is never scanned for them."""
    return any_of(
        In("action", WORK_ACTIONS),
        all_of(missing("action"), Eq("surface", "case"), In("action_type", _LEGACY_ACTION_TYPES)),
    )


def sign_in_predicate() -> Predicate:
    """Sign-in rows (``auth.login``)."""
    return Eq("action", SIGN_IN_ACTION)


def pairing_predicate(window: ResolvedWindow) -> Predicate:
    """The audit-first writers' rows and their failure rows, from the window's start
    to :data:`PAIRING_HORIZON` past its end (only the rows inside the window count; the
    later ones tell whether those were applied)."""
    upper = None if window.open_end else window.end + PAIRING_HORIZON - timedelta(microseconds=1)
    return all_of(
        TsRange(window.start, upper),
        In("action", tuple(sorted({*AUDIT_FIRST_ACTIONS, *NOT_APPLIED_ACTIONS}))),
    )


def counted_predicate(window: ResolvedWindow, *, work: bool = True, sign_ins: bool = True) -> Predicate:
    """The rows one store is read for: the window and the counted kinds, and with the
    case work the rows that pair with its audit-first writers (:func:`pairing_predicate`)."""
    kinds: list[Predicate] = []
    if work:
        kinds.append(work_predicate())
    if sign_ins:
        kinds.append(sign_in_predicate())
    counted = all_of(window_predicate(window), any_of(*kinds))
    return any_of(counted, pairing_predicate(window)) if work else counted


def review_request_predicate(window: ResolvedWindow, case_ids: Iterable[str]) -> Predicate:
    """The sample rows of the reviewed cases, from :data:`REVIEW_LOOKBACK` before the
    window to its end ("Time to review" is sampled to completed, SPEC D3.8)."""
    ids = tuple(sorted({str(c) for c in case_ids if c}))
    start = window.start - REVIEW_LOOKBACK if window.start is not None else None
    upper = None if window.open_end else window.end - timedelta(microseconds=1)
    return And((Eq("action", REVIEW_REQUESTED_ACTION), In("case_id", ids), TsRange(start, upper)))


# --------------------------------------------------------------------------- #
# Windows (SPEC D3.7, D3.11)
# --------------------------------------------------------------------------- #
class TeamWindowError(ValueError):
    """A window the page cannot read: ``code`` is ``team_invalid_window`` or
    ``team_window_too_long``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def operator_zone(prefs: Any) -> str:
    """The operator time zone name (``SlaPolicy.timezone``; UTC when unset or unknown)."""
    name = getattr(getattr(prefs, "sla", None), "timezone", None)
    return zone_for(name)[1]


def resolve_team_window(token: Any, *, tz: str, now: datetime | None = None) -> ResolvedWindow:
    """``token`` (a :mod:`app.engine.time_windows` spec: ``today``, ``yesterday``,
    ``now-7d``, ``2026-11-01..2026-11-20``) as whole calendar days in ``tz``, at most
    :data:`MAX_WINDOW_DAYS` of them. A blank token is ``today``. Raises
    :class:`TeamWindowError`."""
    raw = str(token or "").strip() or "today"
    if len(raw) > WINDOW_TOKEN_MAX_CHARS or not raw.isprintable():
        raise TeamWindowError("team_invalid_window", "That time window is not one this page can read.")
    try:
        window = align_whole_periods(resolve_window(raw, tz=tz, now=now, default="today"))
    except ValueError as exc:
        raise TeamWindowError("team_invalid_window", f"That time window is not one this page can read: {exc}") from None
    if window.start is None or window.open_end:
        raise TeamWindowError(
            "team_window_too_long", f"Choose a window of at most {MAX_WINDOW_DAYS} days.",
        )
    if window.end - window.start > timedelta(days=MAX_WINDOW_DAYS + 1) or len(day_list(window)) > MAX_WINDOW_DAYS:
        raise TeamWindowError(
            "team_window_too_long", f"Choose a window of at most {MAX_WINDOW_DAYS} days.",
        )
    return window


def day_list(window: ResolvedWindow) -> list[str]:
    """The calendar days the window covers, oldest first, as ISO dates in its zone."""
    zone, _ = zone_for(window.tz)
    return [b.start.astimezone(zone).date().isoformat() for b in calendar_buckets(window, "day")]


def _day_of(instant: datetime, zone: Any) -> str:
    return instant.astimezone(zone).date().isoformat()


# --------------------------------------------------------------------------- #
# One row → its counted events
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class WorkEvent:
    """One counted thing a person did. ``person`` is the normalised key (``""`` for Not
    attributed); ``actor`` the spelling the row recorded."""

    ts: datetime
    kind: str
    person: str
    actor: str
    case_id: str | None = None
    case_number: str | None = None
    bulk: bool = False
    #: A close: the group it is counted in (:data:`CLOSE_GROUPS`).
    close_group: str | None = None
    #: A close: the disposition recorded in the row's structured ``changes`` (None for a
    #: legacy row, whose disposition is only in its summary).
    disposition: str | None = None
    actions_taken: tuple[str, ...] = ()
    #: A review: True, False or None (unsure).
    agrees: bool | None = None
    review_elapsed_ms: int | None = None


def person_key(actor: Any) -> str:
    """The normalised person a row's actor names (``""`` for Not attributed)."""
    key = str(actor or "").strip().lower()
    return "" if key in UNATTRIBUTED_ACTORS else key


def _changes(doc: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    raw = doc.get("changes")
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, Mapping) and isinstance(item.get("field"), str):
            out.setdefault(item["field"], dict(item))
    return out


def _change_after(changes: Mapping[str, Mapping[str, Any]], name: str) -> str | None:
    entry = changes.get(name)
    if entry is None:
        return None
    value = entry.get("after")
    return value if isinstance(value, str) else (None if value is None else str(value))


def _change_before(changes: Mapping[str, Mapping[str, Any]], name: str) -> str | None:
    entry = changes.get(name)
    if entry is None:
        return None
    value = entry.get("before")
    return value if isinstance(value, str) else (None if value is None else str(value))


def _close_group(disposition: str | None) -> str:
    return disposition if disposition in CLOSE_GROUPS[:-1] else "other"


def _actions_taken(changes: Mapping[str, Mapping[str, Any]]) -> tuple[str, ...]:
    raw = _change_after(changes, "actions_taken")
    if not raw:
        return ()
    try:
        values = json.loads(raw)
    except (TypeError, ValueError):
        return ()
    if not isinstance(values, list):
        return ()
    return tuple(v for v in dict.fromkeys(values) if isinstance(v, str) and v in CASE_ACTIONS_TAKEN)


def _bool_or_none(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
    return None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value <= 86_400_000 else None
    if isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
        return number if number <= 86_400_000 else None
    return None


def _case_ref(doc: Mapping[str, Any]) -> tuple[str | None, str | None]:
    target = doc.get("target")
    number = None
    target_id = None
    if isinstance(target, Mapping) and target.get("type") == "case":
        label = target.get("label")
        number = label if isinstance(label, str) and label else None
        tid = target.get("id")
        target_id = tid if isinstance(tid, str) and tid else None
    case_id = doc.get("case_id")
    case_id = case_id if isinstance(case_id, str) and case_id else target_id
    if number is not None and number == case_id:
        number = None  # a label that is only the id names no case number
    return case_id, number


def _unattributed_legacy_work(doc: Mapping[str, Any]) -> bool:
    """A legacy case-work row (no structured ``action``, no recorded ``actor_type``)
    whose actor names nobody. Rows written before Round 14 with sign-in off can carry an
    empty actor, which the audit table's derivation leaves without a kind; they are a
    person's work all the same (an AI or system post names its type as the actor), so
    they are counted under Not attributed (SPEC D3.9)."""
    return (
        doc.get("actor_type") is None
        and not doc.get("action")
        and doc.get("surface") == "case"
        and doc.get("action_type") in _LEGACY_ACTION_TYPES
        and person_key(doc.get("actor")) == ""
    )


def counted_row(doc: Mapping[str, Any]) -> bool:
    """Is ``doc`` a row a person made that succeeded (the only rows counted)?"""
    outcome, _ = audit_events.derive_outcome(doc)
    if outcome not in _OK_OUTCOMES:
        return False
    actor_type, _ = audit_events.derive_actor_type(doc)
    if actor_type is None and _unattributed_legacy_work(doc):
        return True
    return actor_type == "human"


def events_of_row(doc: Mapping[str, Any]) -> list[WorkEvent]:
    """The counted events one audit row records (usually one, none for a row that is
    not counted, several for a row that completed several runbook steps)."""
    if not isinstance(doc, Mapping):
        return []
    ts = parse_es_timestamp(doc.get("ts"))
    if ts is None or not counted_row(doc):
        return []
    actor = str(doc.get("actor") or "")
    person = person_key(actor)
    case_id, case_number = _case_ref(doc)
    run_id = doc.get("run_id")
    bulk = isinstance(run_id, str) and run_id.startswith(BULK_RUN_ID_PREFIX)
    base = {"ts": ts, "person": person, "actor": actor, "case_id": case_id,
            "case_number": case_number, "bulk": bulk}
    action = doc.get("action")
    if isinstance(action, str) and action:
        return _structured_events(doc, action, base)
    return _legacy_events(doc, base)


def _lifecycle_event(verb: str, from_status: str | None, to_status: str | None,
                     disposition: str | None, structured_disposition: str | None,
                     actions_taken: tuple[str, ...], base: dict[str, Any]) -> list[WorkEvent]:
    if to_status == "closed" and from_status != "closed":
        return [WorkEvent(kind=CLOSED, close_group=_close_group(disposition),
                          disposition=structured_disposition, actions_taken=actions_taken, **base)]
    kind = {"acknowledge": ACKNOWLEDGED, "reopen": REOPENED, "escalate": ESCALATED}.get(verb)
    if kind is None:
        return []
    return [WorkEvent(kind=kind, actions_taken=actions_taken, **base)]


def _structured_events(doc: Mapping[str, Any], action: str, base: dict[str, Any]) -> list[WorkEvent]:
    changes = _changes(doc)
    if action == SIGN_IN_ACTION:
        return [WorkEvent(kind=SIGNED_IN, **{**base, "case_id": None, "case_number": None, "bulk": False})]
    verb = _LIFECYCLE_VERB_BY_ACTION.get(action)
    if verb is not None:
        legacy = _LEGACY_LIFECYCLE_RE.match(str(doc.get("result_summary") or ""))
        from_status = _change_before(changes, "status")
        to_status = _change_after(changes, "status")
        if to_status is None and legacy is not None:
            from_status, to_status = legacy.group(2), legacy.group(3)
        structured = _change_after(changes, "disposition") or _change_after(changes, "classified_disposition")
        disposition = structured or (legacy.group(4) if legacy is not None else None)
        return _lifecycle_event(verb, from_status, to_status, disposition, structured,
                                _actions_taken(changes), base)
    if action == CASE_COMMENTED_AUDIT_ACTION:
        return [WorkEvent(kind=COMMENTED, **base)]
    if action == CASE_ASSIGNED_AUDIT_ACTION:
        # A row written for an assignment that changed nothing (a bulk assign over cases
        # the person already held) carries no ``assignee`` change and is not counted.
        return [WorkEvent(kind=ASSIGNED, **base)] if "assignee" in changes else []
    if action == FILE_ATTACHED_ACTION:
        return [WorkEvent(kind=SCREENSHOT_ADDED, **base)]
    if action == REVIEW_RECORDED_ACTION:
        tool_input = doc.get("tool_input") if isinstance(doc.get("tool_input"), Mapping) else {}
        if "agrees" in tool_input:
            agrees = _bool_or_none(tool_input.get("agrees"))
        else:
            agrees = _bool_or_none(_change_after(changes, "review.agrees"))
        elapsed = _int_or_none(tool_input.get("elapsed_ms")) if "elapsed_ms" in tool_input else None
        if elapsed is None:
            elapsed = _int_or_none(_change_after(changes, "review.elapsed_ms"))
        return [WorkEvent(kind=REVIEWED, agrees=agrees, review_elapsed_ms=elapsed, **base)]
    if action in _STEP_ACTIONS:
        done = [
            name for name, entry in changes.items()
            if _STEP_STATUS_RE.match(name) and entry.get("after") == "done"
            and entry.get("before") != "done"
        ]
        return [WorkEvent(kind=RUNBOOK_STEP_DONE, **base) for _ in sorted(done)]
    return []


def _legacy_events(doc: Mapping[str, Any], base: dict[str, Any]) -> list[WorkEvent]:
    if doc.get("surface") != "case":
        return []
    action_type = doc.get("action_type")
    summary = str(doc.get("result_summary") or "")
    if action_type == "status":
        match = _LEGACY_LIFECYCLE_RE.match(summary)
        if match is None:
            return []
        verb, from_status, to_status, disposition = match.groups()
        return _lifecycle_event(verb, from_status, to_status, disposition, None, (), base)
    if action_type == "collab":
        if summary == "comment added":
            return [WorkEvent(kind=COMMENTED, **base)]
        if summary.startswith("assigned to "):
            return [WorkEvent(kind=ASSIGNED, **base)]
        return []
    # Only a message a person wrote as a person: the server writes the message's author
    # type in this token, and a post labelled as the AI's or the system's is not a
    # person's comment, whoever sent it (an older row names "ai" as its actor).
    if action_type == "thread_post" and summary.startswith(_HUMAN_THREAD_POST):
        return [WorkEvent(kind=COMMENTED, **base)]
    return []


def event_detail(event: WorkEvent) -> str:
    """The plain words that follow an event's label, from its structured fields only
    (SPEC D3.10: never from a summary, a client or a session): a close's disposition and
    the actions taken, a review's answer, and whether a bulk action wrote it."""
    parts: list[str] = []
    if event.kind == CLOSED and event.disposition:
        parts.append(DISPOSITION_LABELS.get(event.disposition, "Other"))
    if event.actions_taken:
        parts.append(", ".join(CASE_ACTIONS_TAKEN_LABELS[a] for a in event.actions_taken))
    if event.kind == REVIEWED:
        parts.append(
            "Agreed with the AI" if event.agrees is True
            else "Disagreed with the AI" if event.agrees is False
            else "Unsure"
        )
    if event.bulk:
        parts.append("In a bulk action")
    return " · ".join(parts)


def event_view(event: WorkEvent) -> dict[str, Any]:
    """One event as the person sheet lists it (``{ts, kind, label, case_id,
    case_number, detail}``)."""
    return {
        "ts": event.ts.astimezone(timezone.utc).isoformat(),
        "kind": event.kind,
        "label": KIND_LABELS[event.kind],
        "case_id": event.case_id,
        "case_number": event.case_number,
        "detail": event_detail(event),
    }


# --------------------------------------------------------------------------- #
# Audit-first writers: was the action row applied? (SPEC D5.10, D6.6, D7.6)
# --------------------------------------------------------------------------- #
#: The rows of one request that pair up: (action row's action, request id, actor, case).
_AttemptKey = tuple[str, str, str, str | None]


@dataclass(frozen=True)
class _Attempt:
    """One row of an audit-first writer, held until the fold knows whether the action
    row's write was applied: the action row with the events it counts, or its failure
    row. ``arrival`` orders rows stored at the same instant as they were read."""

    instant: datetime
    failed: bool
    arrival: int
    session: str
    events: tuple[WorkEvent, ...] = ()


def _attempt_of(doc: Mapping[str, Any], arrival: int,
                events: Iterable[WorkEvent]) -> tuple[_AttemptKey, _Attempt] | None:
    """``doc`` as an attempt of an audit-first writer, or ``None`` when it is not one of
    their rows or carries no request id (an action row without one is counted as is:
    nothing can say it was not applied, the inspector's rule too)."""
    action = doc.get("action") if isinstance(doc, Mapping) else None
    if not isinstance(action, str):
        return None
    if action in AUDIT_FIRST_ACTIONS:
        written, failed = action, False
    elif action in NOT_APPLIED_ACTIONS:
        written, failed = NOT_APPLIED_ACTIONS[action], True
    else:
        return None
    request_id = doc.get("request_id")
    instant = parse_es_timestamp(doc.get("ts"))
    if not isinstance(request_id, str) or not request_id or instant is None:
        return None
    target = doc.get("target")
    target_id = target.get("id") if isinstance(target, Mapping) else None
    session = doc.get("session_ref")
    key: _AttemptKey = (written, request_id, str(doc.get("actor") or ""),
                        target_id if isinstance(target_id, str) else None)
    return key, _Attempt(instant=instant, failed=failed, arrival=arrival,
                         session=session if isinstance(session, str) else "",
                         events=() if failed else tuple(events))


def _applied_events(attempts: Mapping[_AttemptKey, list[_Attempt]]) -> list[WorkEvent]:
    """The events of the action rows that were applied. An action row was not applied
    when the next row after it of the same request, actor and case (and session, when
    both rows name one) is its failure row, the Audit log inspector's rule. Rows stored at
    the same instant keep their read order, a failure row after its action row."""
    out: list[WorkEvent] = []
    for rows in attempts.values():
        ordered = sorted(rows, key=lambda a: (a.instant, a.failed, a.arrival))
        for index, attempt in enumerate(ordered):
            if attempt.failed or not attempt.events:
                continue
            follower = None
            for later in range(index + 1, len(ordered)):
                other = ordered[later]
                if not attempt.session or not other.session or attempt.session == other.session:
                    follower = other
                    break
            if follower is not None and follower.failed:
                continue
            out.extend(attempt.events)
    return out


# --------------------------------------------------------------------------- #
# The time to acknowledge (SPEC D3.8, the metrics MTTA rule)
# --------------------------------------------------------------------------- #
def first_human_acknowledgement(case: Any) -> tuple[datetime | None, str]:
    """``(instant, person key)`` of a case's first human acknowledgement, by the rule
    the metrics MTTA uses: the ``acknowledged_at`` anchor (the first Acknowledge
    action), else the first human move into Investigating, Escalated or On hold. The
    person is whoever made it: the analyst of the earliest Acknowledge history entry,
    else the author of that status move. ``(None, "")`` when nobody has."""
    from .metrics import _ACK_STATUSES, _NONHUMAN_ACTORS, _as_dt, _parse_iso

    human_move: tuple[datetime, str] | None = None
    for entry in getattr(case, "status_history", None) or []:
        to_status = getattr(entry, "to_status", "") or ""
        by = str(getattr(entry, "by", "") or "")
        if to_status not in _ACK_STATUSES or by.strip().lower() in _NONHUMAN_ACTORS:
            continue
        at = _parse_iso(getattr(entry, "at", None))
        if at is not None and (human_move is None or at < human_move[0]):
            human_move = (at, by)
    anchor = _as_dt(getattr(case, "acknowledged_at", None))
    if anchor is None:
        if human_move is None:
            return None, ""
        return human_move[0], person_key(human_move[1])
    acknowledger: tuple[datetime, str] | None = None
    for entry in getattr(case, "history", None) or []:
        if not isinstance(entry, Mapping) or entry.get("event") != "analyst_action":
            continue
        if entry.get("action") != "acknowledge":
            continue
        at = _parse_iso(entry.get("ts")) if isinstance(entry.get("ts"), str) else None
        if at is not None and (acknowledger is None or at < acknowledger[0]):
            acknowledger = (at, str(entry.get("analyst") or ""))
    if acknowledger is not None:
        return anchor, person_key(acknowledger[1])
    if human_move is not None:
        return anchor, person_key(human_move[1])
    return anchor, ""


def acknowledgement_seconds(case: Any, window: ResolvedWindow) -> tuple[str, float] | None:
    """``(person key, seconds)`` when the case's first human acknowledgement fell inside
    ``window``: its time minus the case's detection or creation time
    (``metrics._created_dt``). ``None`` otherwise, or when nobody is named."""
    from .metrics import _created_dt

    at, person = first_human_acknowledgement(case)
    if at is None or not window.contains(at):
        return None
    start = _created_dt(case)
    if start is None or at < start:
        return None
    return person, (at - start).total_seconds()


# --------------------------------------------------------------------------- #
# The roster (SPEC D3.9)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RosterEntry:
    """One person the page lists. ``key`` is the normalised username."""

    key: str
    username: str
    display_name: str = ""
    role: str = ""
    active: bool = True
    kind: str = KIND_ACCOUNT


def build_roster(
    accounts: Iterable[Any],
    environment: Iterable[tuple[str, str]] = (),
    demo: Iterable[str] = (),
) -> list[RosterEntry]:
    """The people the page lists before any row is read: persisted accounts, then the
    environment accounts with no persisted record (``(username, role)``), then the Demo
    analysts (while Demo Mode is on). A later source never replaces an earlier one."""
    out: dict[str, RosterEntry] = {}
    for user in accounts:
        name = str(getattr(user, "username", "") or "").strip()
        key = name.lower()
        if not key or key in out:
            continue
        role = getattr(user, "role", "")
        out[key] = RosterEntry(
            key=key, username=name,
            display_name=str(getattr(user, "display_name", "") or "").strip(),
            role=str(getattr(role, "value", role) or ""),
            active=bool(getattr(user, "active", True)),
            kind=KIND_ACCOUNT,
        )
    for name, role in environment:
        key = str(name or "").strip().lower()
        if not key or key in out:
            continue
        out[key] = RosterEntry(key=key, username=str(name).strip(), role=str(role or ""),
                               active=True, kind=KIND_ENVIRONMENT)
    for name in demo:
        key = str(name or "").strip().lower()
        if not key or key in out:
            continue
        out[key] = RosterEntry(key=key, username=str(name).strip(), role="", active=True, kind=KIND_DEMO)
    return list(out.values())


def roster_view(entry: RosterEntry) -> dict[str, Any]:
    return {
        "username": entry.username,
        "display_name": entry.display_name,
        "role": entry.role,
        "active": entry.active,
        "kind": entry.kind,
    }


# --------------------------------------------------------------------------- #
# The fold
# --------------------------------------------------------------------------- #
def _median(values: list[float]) -> float | None:
    return float(statistics.median(values)) if values else None


@dataclass
class _Tally:
    counts: Counter = field(default_factory=Counter)
    closed_by: Counter = field(default_factory=Counter)
    bulk: Counter = field(default_factory=Counter)
    daily: dict[str, Counter] = field(default_factory=dict)
    last_active: datetime | None = None
    spellings: Counter = field(default_factory=Counter)
    agreed: int = 0
    disagreed: int = 0
    unsure: int = 0
    review_elapsed_ms: list[int] = field(default_factory=list)
    review_turnaround_s: list[float] = field(default_factory=list)
    ack_seconds: list[float] = field(default_factory=list)

    def add(self, event: WorkEvent, day: str) -> None:
        self.counts[event.kind] += 1
        self.daily.setdefault(day, Counter())[event.kind] += 1
        if event.kind == CLOSED:
            self.closed_by[event.close_group or "other"] += 1
        if event.bulk and event.kind in BULK_KINDS:
            self.bulk[event.kind] += 1
        if event.kind == REVIEWED:
            if event.agrees is True:
                self.agreed += 1
            elif event.agrees is False:
                self.disagreed += 1
            else:
                self.unsure += 1
            if event.review_elapsed_ms is not None:
                self.review_elapsed_ms.append(event.review_elapsed_ms)
        if self.last_active is None or event.ts > self.last_active:
            self.last_active = event.ts
        self.spellings[event.actor] += 1


def _counts_view(counter: Counter, kinds: Iterable[str]) -> dict[str, int]:
    return {kind: int(counter.get(kind, 0)) for kind in kinds}


def _reviews_view(tally: _Tally) -> dict[str, Any]:
    answered = tally.agreed + tally.disagreed
    return {
        "completed": tally.agreed + tally.disagreed + tally.unsure,
        "agreed": tally.agreed,
        "disagreed": tally.disagreed,
        "unsure": tally.unsure,
        "answered": answered,
        # A rate only from REVIEW_RATE_MIN answered reviews; the counts always.
        "agreement_rate": (round(tally.agreed / answered, 4) if answered >= REVIEW_RATE_MIN else None),
        "time_spent_median_ms": _median([float(v) for v in tally.review_elapsed_ms]),
        "time_to_review_median_seconds": _median(tally.review_turnaround_s),
    }


class TeamActivityFold:
    """The exact fold over one window's audit rows (SPEC D3.6).

    Feed it rows with :meth:`add_row` (any order); then, optionally, the reviewed cases'
    sample rows (:meth:`add_review_requests`) and the acknowledged cases
    (:meth:`add_acknowledged_cases`); then read :meth:`result`. A row outside the window
    is ignored; a row a person did not make, or that failed, counts nothing; an
    audit-first writer's row whose failure row follows it was not applied and counts
    nothing either. Those writers' rows are counted at the first read, so every row is
    fed before anything is read."""

    def __init__(self, window: ResolvedWindow) -> None:
        self.window = window
        self.zone, self.zone_name = zone_for(window.tz)
        self.days = day_list(window)
        self.scanned = 0
        self._tallies: dict[str, _Tally] = {}
        self._team = _Tally()
        self._team_daily_chart: dict[str, Counter] = {}
        # case id -> (earliest in-window acknowledgement time, person) for the MTTA read.
        self._acknowledged: dict[str, tuple[datetime, str]] = {}
        # case id -> [(review time, person)] for "Time to review".
        self._reviews: dict[str, list[tuple[datetime, str]]] = {}
        # The audit-first writers' rows, held until the first read (see _applied_events).
        self._attempts: dict[_AttemptKey, list[_Attempt]] = {}

    # -- feeding ------------------------------------------------------------
    def add_row(self, doc: Mapping[str, Any]) -> list[WorkEvent]:
        """Count one stored row; returns the events it counted now inside the window (an
        audit-first writer's row is held, and counted at the first read when its failure
        row does not follow it)."""
        self.scanned += 1
        kept = [event for event in events_of_row(doc) if self.window.contains(event.ts)]
        attempt = _attempt_of(doc, self.scanned, kept)
        if attempt is not None:
            key, held = attempt
            self._attempts.setdefault(key, []).append(held)
            return []
        for event in kept:
            self._count(event)
        return kept

    def _settle(self) -> None:
        """Count the held rows of the audit-first writers that were applied."""
        if not self._attempts:
            return
        held, self._attempts = self._attempts, {}
        for event in _applied_events(held):
            self._count(event)

    def _count(self, event: WorkEvent) -> None:
        day = _day_of(event.ts, self.zone)
        self._tallies.setdefault(event.person, _Tally()).add(event, day)
        self._team.add(event, day)
        if event.kind != SIGNED_IN:
            chart = event.kind if event.kind in CHART_KINDS else "other"
            self._team_daily_chart.setdefault(day, Counter())[chart] += 1
        if event.kind == ACKNOWLEDGED and event.case_id:
            seen = self._acknowledged.get(event.case_id)
            if seen is None or event.ts < seen[0]:
                self._acknowledged[event.case_id] = (event.ts, event.person)
        if event.kind == REVIEWED and event.case_id:
            self._reviews.setdefault(event.case_id, []).append((event.ts, event.person))

    def acknowledged_case_ids(self) -> list[str]:
        """The cases acknowledged in the window (the MTTA candidates), oldest first."""
        self._settle()
        return [cid for cid, _ in sorted(self._acknowledged.items(), key=lambda kv: (kv[1][0], kv[0]))]

    def reviewed_case_ids(self) -> list[str]:
        self._settle()
        return sorted(self._reviews)

    def add_review_requests(self, docs: Iterable[Mapping[str, Any]]) -> None:
        """The ``case.review_requested`` rows of the reviewed cases: each review's time
        to review is its time minus the latest sample of its case before it."""
        self._settle()
        sampled: dict[str, list[datetime]] = {}
        for doc in docs:
            if not isinstance(doc, Mapping) or doc.get("action") != REVIEW_REQUESTED_ACTION:
                continue
            case_id = doc.get("case_id")
            at = parse_es_timestamp(doc.get("ts"))
            if isinstance(case_id, str) and at is not None:
                sampled.setdefault(case_id, []).append(at)
        for case_id, reviews in self._reviews.items():
            times = sorted(sampled.get(case_id, []))
            for reviewed_at, person in reviews:
                before = [t for t in times if t <= reviewed_at]
                if not before:
                    continue
                seconds = (reviewed_at - before[-1]).total_seconds()
                self._tallies.setdefault(person, _Tally()).review_turnaround_s.append(seconds)
                self._team.review_turnaround_s.append(seconds)

    def add_acknowledged_cases(self, cases: Mapping[str, Any]) -> None:
        """Measure the time to acknowledge from the acknowledged cases (by id). A case
        whose first human acknowledgement names nobody is credited to whoever made its
        earliest Acknowledge row in the window."""
        self._settle()
        for case_id in self._acknowledged:
            case = cases.get(case_id)
            if case is None:
                continue
            measured = acknowledgement_seconds(case, self.window)
            if measured is None:
                continue
            person, seconds = measured
            if not person:
                person = self._acknowledged[case_id][1]
            self._tallies.setdefault(person, _Tally()).ack_seconds.append(seconds)
            self._team.ack_seconds.append(seconds)

    # -- reading ------------------------------------------------------------
    def people_keys(self) -> set[str]:
        self._settle()
        return set(self._tallies)

    def spellings(self, key: str) -> list[str]:
        """Every spelling of ``key``'s actor the window's rows recorded, most used first."""
        self._settle()
        tally = self._tallies.get(key)
        if tally is None:
            return []
        return [name for name, _ in sorted(tally.spellings.items(), key=lambda kv: (-kv[1], kv[0]))]

    def _person_view(self, key: str, entry: RosterEntry | None, ack_measured: bool) -> dict[str, Any]:
        tally = self._tallies.get(key) or _Tally()
        if key == "":
            username, display, role, active, kind = "", "Not attributed", "", True, KIND_UNATTRIBUTED
        elif entry is not None:
            username, display, role, active, kind = (
                entry.username, entry.display_name, entry.role, entry.active, entry.kind,
            )
        else:
            spelled = self.spellings(key)
            username = spelled[0].strip() if spelled else key
            display, role, active, kind = "", "", False, KIND_DELETED
        daily = [
            {"date": day, "counts": _counts_view(tally.daily[day], ALL_KINDS)}
            for day in self.days if day in tally.daily
        ]
        return {
            "key": key,
            "username": username,
            "display_name": display,
            "role": role,
            "active": active,
            "kind": kind,
            "counts": _counts_view(tally.counts, ALL_KINDS),
            "closed_by": _counts_view(tally.closed_by, CLOSE_GROUPS),
            "bulk": _counts_view(tally.bulk, BULK_KINDS),
            "daily": daily,
            "last_active": tally.last_active.astimezone(timezone.utc).isoformat() if tally.last_active else None,
            "median_ack_seconds": _median(tally.ack_seconds) if ack_measured else None,
            "ack_samples": len(tally.ack_seconds) if ack_measured else 0,
            "reviews": _reviews_view(tally),
        }

    def result(
        self,
        roster: Iterable[RosterEntry],
        *,
        partial_reason: str | None = None,
        ack_status: str = "measured",
    ) -> dict[str, Any]:
        """The answer (``TeamActivity`` without its request flags). Every roster person
        is listed, with zeros when they did nothing in the window; anyone else the rows
        name is a deleted account; Not attributed comes last when it has rows. Ordered by
        name, never by a count (SPEC D3.5)."""
        self._settle()
        by_key = {e.key: e for e in roster}
        keys = {k for k, e in by_key.items() if e.active} | {k for k in self._tallies}
        ack_measured = ack_status == "measured"
        people = [self._person_view(k, by_key.get(k), ack_measured) for k in keys if k != ""]
        people.sort(key=lambda p: ((p["display_name"] or p["username"]).lower(), p["username"].lower()))
        if "" in self._tallies:
            people.append(self._person_view("", None, ack_measured))
        active = sum(
            1 for p in people
            if p["kind"] != KIND_UNATTRIBUTED and any(p["counts"].values())
        )
        team = {
            "people_active": active,
            "counts": _counts_view(self._team.counts, ALL_KINDS),
            "closed_by": _counts_view(self._team.closed_by, CLOSE_GROUPS),
            "bulk": _counts_view(self._team.bulk, BULK_KINDS),
            "daily": [
                {"date": day, "counts": _counts_view(self._team_daily_chart.get(day, Counter()), CHART_KINDS)}
                for day in self.days
            ],
            "median_ack_seconds": _median(self._team.ack_seconds) if ack_measured else None,
            "ack_samples": len(self._team.ack_seconds) if ack_measured else 0,
            "ack_status": ack_status,
            "reviews": _reviews_view(self._team),
        }
        return {
            "window": {
                "token": self.window.token,
                "label": self.window.label,
                "start": self.window.start.astimezone(timezone.utc).isoformat() if self.window.start else None,
                "end": self.window.end.astimezone(timezone.utc).isoformat(),
            },
            "timezone": self.zone_name,
            "days": list(self.days),
            "people": people,
            "team": team,
            "exact": partial_reason is None,
            "partial_reason": partial_reason,
            "scanned_rows": self.scanned,
        }


def person_events(rows: Iterable[Mapping[str, Any]], window: ResolvedWindow, key: str) -> list[dict[str, Any]]:
    """One person's counted events in the window, newest first (SPEC D3.10). An
    audit-first writer's row whose failure row follows it was not applied and is left
    out, exactly as the counts leave it out."""
    found: list[WorkEvent] = []
    attempts: dict[_AttemptKey, list[_Attempt]] = {}
    for arrival, doc in enumerate(rows):
        events = [e for e in events_of_row(doc) if e.person == key and window.contains(e.ts)]
        attempt = _attempt_of(doc, arrival, events)
        if attempt is not None:
            attempts.setdefault(attempt[0], []).append(attempt[1])
            continue
        found.extend(events)
    found.extend(_applied_events(attempts))
    found.sort(key=lambda e: (e.ts, e.kind), reverse=True)
    return [event_view(e) for e in found]
