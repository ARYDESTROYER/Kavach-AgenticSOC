"""The auto-close review (Round 15 SPEC D6.6, D6.9, D6.12).

A small random sample of the cases the AI agent closed automatically waits for a person
to classify (``engine.auto_close_review`` picks them; ``stores.auto_close_review`` keeps
the ledger). This router serves:

* ``POST /api/cases/{case_id}/review`` (``cases:write``): record a person's review of a
  case the agent closed automatically. The case must be terminal and its FIRST decision
  record an agent close, else ``409 review_not_agent_closed``; a sampled case whose
  review is already recorded answers ``409 review_already_recorded``. An agent-closed
  case that was not sampled may be reviewed too: that review is an ordinary grade.
  Order: the ``case.review_recorded`` audit row first (``503 audit_unavailable`` when
  it cannot be written, and nothing changes), then the case is read again and saved with
  ONE appended ``FeedbackEntry`` (and, only for a sampled case, its ``origin``,
  ``review_id`` and one ``auto_close_review`` history event), then the ledger entry is
  completed with strict compare-and-set (retried once; a later read repairs it from the
  history event). The review never sets the case's ``status``, ``decision_by`` or
  ``disposition`` (#3); its note is indexed as fenced, untrusted precedent text exactly
  as a grading comment is (#9). A disagreeing reviewer who cannot close cases sends one
  Inbox item to the people who can (at most 200, category ``assignment``).
* ``GET /api/cases/{case_id}/review`` (``cases:read``): one case's place in the
  sample (``none``, ``pending``, ``completed`` or ``expired``) and whether a review
  can be recorded now; the case workspace reads it for the pending band, Start review
  and "Review this auto-close" (Round 15 WP7, D8.2).
* ``GET /api/auto-close-review/summary`` (``cases:read``): the queue badge.
* ``GET /api/metrics/auto-close-review?window=`` (``metrics:view``): the Agent
  effectiveness module. Agreement describes the sampled cases only, unweighted; it is
  not an estimate of auto-close precision, and the response says so.

The Case Manager's Review scope reads ``GET /api/cases?review=`` (``routes.py``), which
gets its case ids from :func:`review_queue_cases` here. Nothing here imports
``engine.case_manager`` or makes a model call (#3, #6). In Demo Mode every read and
write uses the Demo case store, ledger, audit and Inbox.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..constants import (
    AUTO_CLOSE_REVIEW_EVENT,
    AUTO_CLOSE_REVIEW_ORIGIN,
    TERMINAL_CASE_STATUSES,
    ActionType,
    NotificationCategory,
)
from ..engine.auto_close_review import (
    AGREEMENT_STATEMENT,
    CLASSIFICATION_OUTCOME,
    RECORD_FAILED_ACTION,
    RECORDED_ACTION,
    classification_agrees,
    days_between,
    eligible_closes_by_day,
    first_decision_is_agent_close,
    history_review,
    operator_day,
    operator_zone,
    publish_review_frame,
    review_metrics,
    review_summary,
)
from ..engine.time_windows import resolve_window
from ..models import AuditChange, Case, FeedbackEntry, InAppNotification
from ..state import AppState
from ..stores.auto_close_review import (
    STATE_COMPLETED,
    STATE_EXPIRED,
    STATE_PENDING,
    ReviewEntry,
    ReviewLedger,
    ReviewLedgerUnavailable,
)
from ..utils import iso_now, now_utc
from .deps import _enforce, get_state, require_permission, resolve_access

logger = logging.getLogger("tlsoc.api.auto_close_review")

router = APIRouter(prefix="/api")

#: The ``review=`` values of ``GET /api/cases`` (D6.12).
REVIEW_QUEUE_STATES: tuple[str, ...] = ("pending", "completed", "disagreed", "expired")
#: At most this many people get the disagreement Inbox item (D6.9).
MAX_DISAGREEMENT_AUDIENCE = 200
#: The summary checks at most this many of the newest disagreeing reviews for an open
#: (still closed) case.
SUMMARY_DISAGREED_SCAN = 200
#: The metrics window when none is given.
DEFAULT_METRICS_WINDOW = "now-30d"
#: The all-time case population the eligible count reads (the metrics pages' limit).
_ELIGIBLE_FETCH_LIMIT = 20000

_CLASSIFICATION_WORDS = {
    "true_positive": "true positive",
    "false_positive": "false positive",
    "benign": "benign",
    "unsure": "unsure",
}
_VERDICT_WORDS = {
    "TRUE_POSITIVE": "true positive",
    "FALSE_POSITIVE": "false positive",
    "NEEDS_HUMAN": "needs human review",
}


# --------------------------------------------------------------------------- #
# Contracts (feature response models live here, not in models.py)
# --------------------------------------------------------------------------- #
class ReviewBody(BaseModel):
    """A person's review of an automatic close. ``classification`` is their own
    answer, asked before the AI verdict is compared. The optional ratings are stars
    (above 0, at most 1). ``elapsed_ms`` is the time from opening the review card to
    submitting it, measured by the Console."""

    model_config = ConfigDict(extra="forbid")

    classification: Literal["true_positive", "false_positive", "benign", "unsure"]
    note: str = Field(default="", max_length=1000)
    accuracy: float | None = Field(default=None, gt=0, le=1)
    reasoning_quality: float | None = Field(default=None, gt=0, le=1)
    action_appropriateness: float | None = Field(default=None, gt=0, le=1)
    elapsed_ms: int | None = Field(default=None, ge=0, le=86_400_000)

    @field_validator("note", mode="before")
    @classmethod
    def _clean_note(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.replace("\x00", "").strip()
        return value


class ReviewResult(BaseModel):
    """The recorded review: ``agrees`` (None for unsure), whether the caller may
    reopen the case (``cases:close``), and the ledger id when the case was sampled."""

    agrees: bool | None = None
    can_reopen: bool = False
    sampled: bool = False
    review_id: str | None = None


class AutoCloseReviewSummary(BaseModel):
    """The Review scope badge: pending reviews, disagreeing reviews whose case is still
    closed, today's sample against the daily cap."""

    enabled: bool
    pending: int
    disagreed_open: int
    sampled_today: int
    daily_cap: int


class CaseReviewState(BaseModel):
    """One case's place in the auto-close review (Round 15, D6.12, D8.2): what the case
    workspace needs to show the pending band, choose its primary action and offer
    "Review this auto-close". ``state`` is the case's sample entry (``pending``,
    ``completed`` or ``expired``, computed on read) or ``none`` when it was never
    sampled. ``agent_closed`` is the review endpoint's own rule (terminal, first
    decision record an agent close), and ``can_record`` says whether that endpoint
    would accept a review now, the caller's grants aside: a sampled case whose review
    is recorded answers 409, and so does a case that is not (or no longer) closed by
    the agent."""

    case_id: str
    agent_closed: bool
    state: Literal["none", "pending", "completed", "expired"]
    can_record: bool
    review_id: str | None = None
    sampled_at: str | None = None
    expires_at: str | None = None


class ReviewMetricsWindow(BaseModel):
    token: str
    label: str
    tz: str
    start: str | None = None
    end: str


class ReviewAgreement(BaseModel):
    status: Literal["ok", "insufficient"]
    agreed: int
    disagreed: int
    reviews: int
    minimum: int
    rate: float | None = None
    interval: dict[str, float] | None = None
    statement: str


class ReviewMissedThreat(BaseModel):
    case_id: str
    case_number: str = ""
    rule: str = ""
    completed_at: str = ""


class ReviewMissedThreats(BaseModel):
    count: int
    cases: list[ReviewMissedThreat] = Field(default_factory=list)


class ReviewRuleRow(BaseModel):
    rule: str
    sampled: int
    reviewed: int
    agreed: int
    disagreed: int


class ReviewDuration(BaseModel):
    median: float | None = None
    reviews: int = 0


class ReviewDayRow(BaseModel):
    day: str
    eligible: int
    sampled: int


class ReviewEligible(BaseModel):
    count: int
    complete: bool


class AutoCloseReviewMetrics(BaseModel):
    """The Agent effectiveness "Auto-close review" module (D6.12) over the cases sampled
    in ``window``. Never a composite score."""

    window: ReviewMetricsWindow
    enabled: bool
    sample_rate: float
    daily_cap: int
    per_rule_daily_cap: int
    expiry_days: int
    sampled: int
    reviewed: int
    pending: int
    expired: int
    unsure: int
    agreement: ReviewAgreement
    missed_threats: ReviewMissedThreats
    by_rule: list[ReviewRuleRow]
    time_spent_ms: ReviewDuration
    time_to_review_ms: ReviewDuration
    by_day: list[ReviewDayRow]
    eligible: ReviewEligible
    ledger_complete: bool
    statement: str
    generated_at: str


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _store(state: AppState) -> Any:
    return state.auto_close_review


async def _load(state: AppState, store: Any = None) -> ReviewLedger:
    try:
        return await (store if store is not None else _store(state)).load()
    except ReviewLedgerUnavailable as exc:
        raise _error(503, "review_ledger_unavailable",
                     "Auto-close reviews could not be read right now. Try again.") from exc


def _config(state: AppState) -> Any:
    return state.execution_prefs.auto_close_review


def _status(case: Any) -> str:
    raw = getattr(case, "status", None)
    return str(getattr(raw, "value", raw) or "")


def _complete_from_history(ledger: ReviewLedger, entries: dict[str, Any]) -> ReviewLedger | None:
    """Mark completed every pending entry whose case carries its review history event
    (``{review_id: event}``); None when none changed."""
    changed = False
    for entry in ledger.entries:
        event = entries.get(entry.review_id)
        if event is None or entry.state == STATE_COMPLETED:
            continue
        entry.state = STATE_COMPLETED
        entry.reviewer = str(event.get("analyst") or "")[:128]
        entry.completed_at = str(event.get("ts") or "")[:64]
        agrees = event.get("agrees")
        entry.agrees = agrees if isinstance(agrees, bool) else None
        classification = event.get("classification")
        if isinstance(classification, str) and classification in CLASSIFICATION_OUTCOME:
            entry.classification = classification
        # The time spent travels in the history event, so a repaired entry keeps the
        # measurement a normal completion stores (the request bound, 0 to 24 hours).
        elapsed = event.get("elapsed_ms")
        if isinstance(elapsed, int) and not isinstance(elapsed, bool) and 0 <= elapsed <= 86_400_000:
            entry.elapsed_ms = elapsed
        changed = True
    return ledger if changed else None


async def _repair(
    state: AppState, found: dict[str, Any], *, store: Any = None, locked: bool = False,
    ledger: ReviewLedger | None = None,
) -> None:
    """Complete the ledger entries a case's history shows as reviewed (the ledger write
    failed after the case save). Best-effort. ``locked=True`` when the caller already
    holds the store's lock. ``ledger`` is the ledger the caller already read (Round 16,
    WP06: one read per request, not two); the write itself re-reads under strict
    compare-and-set, so a ledger that moved meanwhile is still repaired correctly."""
    store = store if store is not None else _store(state)
    if ledger is None:
        try:
            ledger = await store.load()
        except ReviewLedgerUnavailable:
            return
    events: dict[str, Any] = {}
    for entry in ledger.entries:
        if entry.state == STATE_COMPLETED:
            continue
        case = found.get(entry.case_id)
        event = history_review(case, entry.review_id) if case is not None else None
        if event is not None:
            events[entry.review_id] = event
    if not events:
        return
    try:
        await store.update(lambda current: _complete_from_history(current, events), locked=locked)
    except ReviewLedgerUnavailable as exc:
        logger.warning("Auto-close review ledger repair failed: %s", exc)


def _queue_entries(ledger: ReviewLedger, review: str, *, now: datetime, expiry_days: int) -> list[ReviewEntry]:
    out: list[ReviewEntry] = []
    for entry in ledger.entries:
        state = entry.state_at(now, expiry_days)
        if review == "pending" and state == STATE_PENDING:
            out.append(entry)
        elif review == "expired" and state == STATE_EXPIRED:
            out.append(entry)
        elif review == "completed" and state == STATE_COMPLETED:
            out.append(entry)
        elif review == "disagreed" and state == STATE_COMPLETED and entry.agrees is False:
            out.append(entry)
    return out


async def review_queue_cases(state: AppState, review: str) -> list[Case]:
    """The cases of one Review scope (``pending``, ``completed``, ``disagreed`` or
    ``expired``), newest sample first, read through ``_queue_cases_by_id`` (one batch
    read). A pending or expired entry whose case already carries its review is
    repaired in the ledger and left out. Raises 503 when the ledger cannot be read."""
    from .routes import _queue_cases_by_id

    ledger = await _load(state)
    now = now_utc()
    expiry = int(getattr(_config(state), "expiry_days", 7) or 7)
    entries = _queue_entries(ledger, review, now=now, expiry_days=expiry)
    ids = list(dict.fromkeys(e.case_id for e in reversed(entries)))
    if not ids:
        return []
    found = await _queue_cases_by_id(state.cases, ids)
    if review in ("pending", "expired"):
        settled = {
            e.case_id for e in entries
            if e.case_id in found and history_review(found[e.case_id], e.review_id) is not None
        }
        if settled:
            await _repair(state, found, ledger=ledger)
            ids = [cid for cid in ids if cid not in settled]
    return [found[cid] for cid in ids if cid in found]


def _label(case: Any) -> str:
    return str(getattr(case, "case_number", "") or "") or str(getattr(case, "case_id", "") or "")


async def _inapp_allows(state: AppState, user: str) -> bool:
    """False when ``user`` switched the Assignment category off (their category
    preference, D6.9). The category's ``channels`` list names the EXTRA channels only
    (email, Slack and the rest; the Inbox preferences never write ``in_app``, which is
    always on), so a list is never read as a mute: a person who added email to
    Assignment still gets the Inbox item. Any read failure delivers."""
    prefs_store = getattr(state, "notif_prefs", None)
    if prefs_store is None:
        return True
    try:
        pref = await prefs_store.get(user)
        entry = (getattr(pref, "categories", {}) or {}).get(NotificationCategory.ASSIGNMENT.value)
    except Exception:  # noqa: BLE001
        return True
    return not (isinstance(entry, dict) and entry.get("enabled") is False)


async def notify_disagreement(
    state: AppState, case: Any, *, reviewer: str, classification: str, ai_verdict: str,
    review_id: str,
) -> int:
    """One Inbox item per person who can close cases (``cases:close``), at most
    :data:`MAX_DISAGREEMENT_AUDIENCE`, honouring each recipient's Assignment category
    preference. Plain, server-worded text (#9; never the note). Returns the deliveries.
    Best-effort: a failure is logged and the review stands."""
    from ..engine.batch_inbox import eligible_audience

    inbox = getattr(state, "inbox", None)
    if inbox is None:
        return 0
    try:
        audience = await eligible_audience(state, "cases", "close")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Auto-close review disagreement audience unavailable: %s", exc)
        return 0
    reviewer_key = (reviewer or "").strip().lower()
    recipients: list[str] = []
    for member in audience:
        name = str(getattr(member, "username", "") or "")
        if not name or name.strip().lower() == reviewer_key:
            continue
        if await _inapp_allows(state, name):
            recipients.append(name)
        if len(recipients) >= MAX_DISAGREEMENT_AUDIENCE:
            break
    if not recipients:
        return 0
    case_id = str(getattr(case, "case_id", "") or "")
    label = _label(case)
    said = _CLASSIFICATION_WORDS.get(classification, classification)
    closed_as = _VERDICT_WORDS.get(str(ai_verdict or "").upper(), "a closed case")

    def _build(recipient: str) -> InAppNotification:
        return InAppNotification(
            recipient=recipient,
            category=NotificationCategory.ASSIGNMENT.value,
            title=f"Auto-close review disagreed on case {label}",
            body=(
                f"{reviewer or 'A reviewer'} classified it as {said}; the AI agent closed it "
                f"as {closed_as}. Reopen it if it needs work."
            ),
            case_id=case_id,
            url=f"/cases/{case_id}",
            ref={"kind": "auto_close_review", "review_id": review_id},
        )

    try:
        created = await inbox.fanout(recipients, _build)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Auto-close review disagreement fan-out failed: %s", exc)
        return 0
    for note in created:
        try:
            await state.audit.record(
                action_type=ActionType.INAPP_NOTIFY, surface="auto_close_review",
                actor=reviewer or "system", actor_type="system", outcome="success",
                case_id=case_id,
                result_summary=f"auto_close_review_disagreed -> {note.recipient}",
            )
        except Exception:  # noqa: BLE001
            pass
    bus = getattr(state, "event_bus", None)
    if bus is not None and created:
        try:
            bus.publish(
                "notifications", "inapp",
                {"category": NotificationCategory.ASSIGNMENT.value, "case_id": case_id},
                audience=[n.recipient for n in created],
            )
        except Exception:  # noqa: BLE001
            pass
    return len(created)


# --------------------------------------------------------------------------- #
# POST /api/cases/{case_id}/review
# --------------------------------------------------------------------------- #
@router.post("/cases/{case_id}/review", response_model=ReviewResult)
async def record_auto_close_review(
    case_id: str,
    body: ReviewBody,
    request: Request,
    state: AppState = Depends(get_state),
) -> ReviewResult:
    """Record a person's review of a case the AI agent closed automatically (D6.6)."""
    from .routes import _case_work_actor

    user = await _enforce(request, "cases", "write")
    actor = _case_work_actor(user, None)
    can_reopen = (await resolve_access(request)).allows("cases", "close")
    store = _store(state)
    # One review at a time per ledger in this process: the store's lock, which the
    # sampler and every ledger write also take, is held from the checks through the
    # ledger completion. The second of two concurrent submissions for one sampled case
    # then reads the first one's completed entry (or its history event) and answers
    # 409, and neither case save can overwrite the other's grade. The precedent index,
    # the Inbox and the live frame follow outside the lock.
    async with store.lock:
        recorded = await _record_review_locked(state, store, case_id, body, request, actor=actor)
    fresh, agrees, ai_verdict, review_id, disagreed_before = recorded

    # 4. The note becomes fenced untrusted precedent text like any grading comment (#9).
    if _status(fresh) in TERMINAL_CASE_STATUSES:
        try:
            await state.rag_service.index_resolved_case(fresh, note=body.note)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Auto-close review RAG refresh failed for %s: %s", case_id[:80], exc)

    # 5. A disagreement from someone who cannot reopen reaches someone who can, once per
    # reviewer and case: a case that was not sampled may be reviewed again, and a repeat
    # disagreement by the same person sends nothing more (the closers already have it).
    if agrees is False and not can_reopen and not disagreed_before:
        await notify_disagreement(
            state, fresh, reviewer=actor, classification=body.classification,
            ai_verdict=ai_verdict, review_id=review_id,
        )
    publish_review_frame(getattr(state, "event_bus", None), case_id, review_id, STATE_COMPLETED)
    return ReviewResult(agrees=agrees, can_reopen=can_reopen, sampled=bool(review_id),
                        review_id=review_id or None)


async def _record_review_locked(
    state: AppState, store: Any, case_id: str, body: ReviewBody, request: Request, *,
    actor: str,
) -> tuple[Case, bool | None, str, str, bool]:
    """Steps 1 to 3 of the review with ``store.lock`` held
    (:func:`record_auto_close_review`): the checks, the audit row, the case save and the
    ledger completion. Returns ``(saved case, agrees, AI verdict, review id, disagreed
    before)``; the review id is empty for a case that was not sampled, and ``disagreed
    before`` says the reviewer had already recorded a disagreeing grade of that case (a
    sampled case takes one review, so it is always False there)."""
    from .routes import _case_audit_fields, _request_audit_context

    case = await state.cases.get(case_id)
    if case is None:
        raise _error(404, "case_not_found", "Case not found.")
    if _status(case) not in TERMINAL_CASE_STATUSES or not first_decision_is_agent_close(case):
        raise _error(409, "review_not_agent_closed",
                     "Only a case the AI agent closed automatically can be reviewed.")
    ledger = await _load(state, store)
    entry = ledger.entry_for_case(case_id)
    if entry is not None and entry.state == STATE_COMPLETED:
        raise _error(409, "review_already_recorded", "This auto-close review is already recorded.")
    if entry is not None and history_review(case, entry.review_id) is not None:
        await _repair(state, {case_id: case}, store=store, locked=True, ledger=ledger)
        raise _error(409, "review_already_recorded", "This auto-close review is already recorded.")
    sampled = entry is not None
    review_id = entry.review_id if entry is not None else ""
    ai_verdict = (
        entry.ai_verdict if entry is not None and entry.ai_verdict
        else str(getattr(getattr(case, "verdict", None), "value", case.verdict) or "").upper()
    )
    agrees = classification_agrees(body.classification, ai_verdict)
    context = _request_audit_context(request)
    changes = [
        AuditChange(field="review.classification", before=None, after=body.classification),
        AuditChange(field="review.agrees", before=None, after=agrees),
    ]
    if body.elapsed_ms is not None:
        changes.append(AuditChange(field="review.elapsed_ms", before=None, after=body.elapsed_ms))
    if sampled:
        changes.append(AuditChange(field="review.review_id", before=None, after=review_id))
    summary_codes = (
        f"review_id={review_id or 'none'} sampled={str(sampled).lower()} "
        f"classification={body.classification} "
        f"agrees={'none' if agrees is None else str(agrees).lower()}"
    )
    tool_input = {
        "review_id": review_id, "sampled": sampled, "classification": body.classification,
        "agrees": agrees, "elapsed_ms": body.elapsed_ms, "ai_verdict": ai_verdict,
    }

    async def _failed(code: str) -> None:
        try:
            await state.audit.record(
                action_type=ActionType.FEEDBACK, surface="case", actor=actor,
                actor_type="human", action=RECORD_FAILED_ACTION, outcome="failure",
                case_id=case_id, **_case_audit_fields(case, context),
                tool_input=tool_input, result_summary=f"review_record_failed {summary_codes} code={code}",
            )
        except Exception:  # noqa: BLE001
            pass

    # 1. Audit first (#2): nothing changes unless the row is written.
    try:
        await state.audit.record_strict(
            action_type=ActionType.FEEDBACK, surface="case", actor=actor,
            actor_type="human", action=RECORDED_ACTION, outcome="success",
            case_id=case_id, **_case_audit_fields(case, context),
            changes=changes, tool_input=tool_input,
            result_summary=f"review_recorded {summary_codes}",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Auto-close review audit row failed for %s: %s", case_id[:80], exc)
        await _failed("audit_unavailable")
        raise _error(503, "audit_unavailable",
                     "The audit log could not record the review, so nothing changed. Try again.") from exc

    # 2. Read the case again and save it with one appended grade (never its status,
    # decider or disposition, #3).
    now = iso_now()
    reviewer_key = actor.strip().lower()
    try:
        fresh = await state.cases.get(case_id) or case
        # Read before this review's grade is appended (and under the store lock, so two
        # concurrent repeats cannot both read "not yet").
        disagreed_before = not sampled and any(
            fb.assessment == "disagree" and (fb.analyst or "").strip().lower() == reviewer_key
            for fb in fresh.feedback
        )
        grade = FeedbackEntry(
            ts=now,
            analyst=actor,
            assessment=("" if agrees is None else ("agree" if agrees else "disagree")),
            accuracy=float(body.accuracy or 0.0),
            reasoning_quality=float(body.reasoning_quality or 0.0),
            action_appropriateness=float(body.action_appropriateness or 0.0),
            actual_outcome=CLASSIFICATION_OUTCOME[body.classification],
            comment=body.note,
            ai_verdict=ai_verdict,
            ai_confidence=float(getattr(fresh, "confidence", 0.0) or 0.0),
            origin=AUTO_CLOSE_REVIEW_ORIGIN if sampled else "",
            review_id=review_id if sampled else "",
        )
        fresh.feedback.append(grade)
        if sampled:
            # Only for a case in the ledger (D6.6): the rollback-safe marker.
            fresh.history.append({
                "ts": now,
                "event": AUTO_CLOSE_REVIEW_EVENT,
                "review_id": review_id,
                "feedback_ts": grade.ts,
                "analyst": actor,
                "agrees": agrees,
                "classification": body.classification,
                "elapsed_ms": body.elapsed_ms,
            })
        fresh.updated_at = now
        await state.cases.save(fresh)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Auto-close review save failed for %s: %s", case_id[:80], exc)
        await _failed("case_store_unavailable")
        raise _error(503, "case_store_unavailable", "The review could not be saved. Try again.") from exc

    # 3. Complete the ledger entry (logged and retried once; the review stands, and a
    # later read repairs the ledger from the case's history event).
    if sampled:
        def _complete(current: ReviewLedger) -> ReviewLedger | None:
            target = current.entry_by_id(review_id)
            if target is None or target.state == STATE_COMPLETED:
                return None
            target.state = STATE_COMPLETED
            target.reviewer = actor[:128]
            target.completed_at = now
            target.classification = body.classification
            target.agrees = agrees
            target.elapsed_ms = body.elapsed_ms
            return current

        for attempt in range(2):
            try:
                await store.update(_complete, locked=True)
                break
            except ReviewLedgerUnavailable as exc:
                logger.warning(
                    "Auto-close review ledger completion failed for %s (attempt %d): %s",
                    case_id[:80], attempt + 1, exc,
                )
    return fresh, agrees, ai_verdict, review_id, disagreed_before


# --------------------------------------------------------------------------- #
# GET /api/cases/{case_id}/review
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/review", response_model=CaseReviewState)
async def case_review_state(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> CaseReviewState:
    """One case's auto-close review state (D6.12, D8.2), read by the case workspace.
    A pending entry whose case already carries its review reads as completed (and the
    ledger is repaired, as the summary does). Nothing here changes the case (#3)."""
    case = await state.cases.get(case_id)
    if case is None:
        raise _error(404, "case_not_found", "Case not found.")
    agent_closed = _status(case) in TERMINAL_CASE_STATUSES and first_decision_is_agent_close(case)
    ledger = await _load(state)
    entry = ledger.entry_for_case(case_id)
    if entry is None:
        return CaseReviewState(case_id=case_id, agent_closed=agent_closed, state="none",
                               can_record=agent_closed)
    expiry = int(getattr(_config(state), "expiry_days", 7) or 7)
    current = entry.state_at(now_utc(), expiry)
    if current != STATE_COMPLETED and history_review(case, entry.review_id) is not None:
        await _repair(state, {case_id: case}, ledger=ledger)
        current = STATE_COMPLETED
    sampled = entry.sampled_instant()
    expires = (
        (sampled + timedelta(days=max(1, expiry))).isoformat()
        if sampled is not None and current != STATE_COMPLETED else None
    )
    return CaseReviewState(
        case_id=case_id,
        agent_closed=agent_closed,
        state=current,
        can_record=agent_closed and current != STATE_COMPLETED,
        review_id=entry.review_id or None,
        sampled_at=entry.sampled_at or None,
        expires_at=expires,
    )


# --------------------------------------------------------------------------- #
# GET /api/auto-close-review/summary
# --------------------------------------------------------------------------- #
@router.get("/auto-close-review/summary", response_model=AutoCloseReviewSummary)
async def auto_close_review_summary(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> AutoCloseReviewSummary:
    """The Review scope badge (D6.12). Pending entries whose case already carries its
    review are repaired in the ledger and not counted."""
    from .routes import _queue_cases_by_id

    config = _config(state)
    ledger = await _load(state)
    now = now_utc()
    expiry = int(getattr(config, "expiry_days", 7) or 7)
    pending = [e for e in ledger.entries if e.state_at(now, expiry) == STATE_PENDING]
    disagreed = [e for e in ledger.entries if e.state == STATE_COMPLETED and e.agrees is False]
    disagreed = disagreed[-SUMMARY_DISAGREED_SCAN:]
    ids = list(dict.fromkeys([*(e.case_id for e in pending), *(e.case_id for e in disagreed)]))
    found: dict[str, Any] = {}
    if ids:
        try:
            found = await _queue_cases_by_id(state.cases, ids)
        except Exception as exc:  # noqa: BLE001 (the badge degrades to the ledger alone)
            logger.warning("Auto-close review summary could not read cases: %s", exc)
    settled = {
        e.review_id for e in pending
        if e.case_id in found and history_review(found[e.case_id], e.review_id) is not None
    }
    if settled:
        await _repair(state, found, ledger=ledger)
        ledger = await _load(state)
        # A repaired entry may be a disagreement: count it now, not on the next read
        # (its case was read above with the pending ones).
        disagreed = [e for e in ledger.entries if e.state == STATE_COMPLETED and e.agrees is False]
        disagreed = disagreed[-SUMMARY_DISAGREED_SCAN:]
    open_disagreements = sum(
        1 for e in disagreed
        if e.case_id in found and _status(found[e.case_id]) in TERMINAL_CASE_STATUSES
    )
    return AutoCloseReviewSummary(**review_summary(
        ledger, config, now=now, tz=operator_zone(state.execution_prefs),
        open_disagreements=open_disagreements,
    ))


# --------------------------------------------------------------------------- #
# GET /api/metrics/auto-close-review
# --------------------------------------------------------------------------- #
async def _repaired_for_window(
    state: AppState, ledger: ReviewLedger, *, start: datetime | None, end: datetime,
) -> ReviewLedger:
    """``ledger`` with every entry sampled in ``[start, end)`` whose case already carries
    its review marked completed (the ledger write failed after the case save, D6.6), so
    the module never shows a recorded review as pending or expired, or leaves it out of
    the agreement and the missed threats, until another read repairs it. Pending and
    expired entries alike: a review recorded on an expired pick is still a review. The
    repair is saved (best-effort) and applied to the ledger read here either way. A case
    read that fails leaves the ledger as it is."""
    from .routes import _queue_cases_by_id

    def in_window(entry: ReviewEntry) -> bool:
        at = entry.sampled_instant()
        return at is not None and (start is None or at >= start) and at < end

    open_entries = [e for e in ledger.entries if e.state != STATE_COMPLETED and in_window(e)]
    ids = list(dict.fromkeys(e.case_id for e in open_entries))
    if not ids:
        return ledger
    try:
        found = await _queue_cases_by_id(state.cases, ids)
    except Exception as exc:  # noqa: BLE001 (the module degrades to the ledger alone)
        logger.warning("Auto-close review metrics could not read cases: %s", exc)
        return ledger
    events: dict[str, Any] = {}
    for entry in open_entries:
        case = found.get(entry.case_id)
        event = history_review(case, entry.review_id) if case is not None else None
        if event is not None:
            events[entry.review_id] = event
    if not events:
        return ledger
    await _repair(state, found, ledger=ledger)
    try:
        ledger = await _load(state)
    except HTTPException:
        pass  # the ledger read above, completed below
    # Applied here too, so a repair whose save failed still counts on this read.
    return _complete_from_history(ledger, events) or ledger


@router.get("/metrics/auto-close-review", response_model=AutoCloseReviewMetrics)
async def auto_close_review_metrics(
    window: str | None = Query(default=None, max_length=200),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("metrics", "view")),
) -> AutoCloseReviewMetrics:
    """The Agent effectiveness module (D6.12) over the cases sampled in ``window`` (a
    ``time_windows`` token, default the last 30 days, in the operator zone)."""
    from .metrics_shared import fetch_case_population

    prefs = state.execution_prefs
    config = prefs.auto_close_review
    tz = operator_zone(prefs)
    try:
        resolved = resolve_window(window, tz=tz, default=DEFAULT_METRICS_WINDOW)
    except ValueError as exc:
        raise _error(400, "bad_window", str(exc)) from exc
    now = now_utc()
    end = (now + timedelta(seconds=1)) if resolved.open_end else resolved.end
    ledger = await _repaired_for_window(state, await _load(state), start=resolved.start, end=end)
    population = await fetch_case_population(state.cases, span_hours=None, limit=_ELIGIBLE_FETCH_LIMIT)
    eligible = eligible_closes_by_day(population.cases, start=resolved.start, end=end, tz=tz)
    data = review_metrics(
        ledger, config, start=resolved.start, end=end, now=now, tz=tz,
        eligible_days=eligible,
        eligible_complete=bool(population.load_ok and population.complete),
    )
    if resolved.start is not None and (end - resolved.start) <= timedelta(days=400):
        # Zero-fill the operator days of a bounded window.
        first = date.fromisoformat(operator_day(resolved.start, tz))
        last = date.fromisoformat(operator_day(end - timedelta(microseconds=1), tz))
        rows = {row["day"]: row for row in data["by_day"]}
        data["by_day"] = [
            rows.get(day, {"day": day, "eligible": 0, "sampled": 0})
            for day in days_between(first, last)
        ]
    return AutoCloseReviewMetrics(
        window=ReviewMetricsWindow(
            token=resolved.token, label=resolved.label, tz=resolved.tz,
            start=resolved.iso_from(), end=end.astimezone(timezone.utc).isoformat(),
        ),
        enabled=bool(config.enabled),
        sample_rate=float(config.sample_rate),
        daily_cap=int(config.daily_cap),
        per_rule_daily_cap=int(config.per_rule_daily_cap),
        expiry_days=int(config.expiry_days),
        statement=AGREEMENT_STATEMENT,
        # The eligible counts come from the shared all-time case population, which may
        # be up to a minute old (Round 16, WP06): the response is stamped with when that
        # population was read, never with "now".
        generated_at=(population.generated_at if population.load_ok else None) or iso_now(),
        **data,
    )


__all__ = [
    "REVIEW_QUEUE_STATES",
    "AutoCloseReviewMetrics",
    "AutoCloseReviewSummary",
    "ReviewBody",
    "ReviewResult",
    "notify_disagreement",
    "review_queue_cases",
    "router",
]
