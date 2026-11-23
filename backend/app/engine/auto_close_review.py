"""The auto-close review sample (Round 15 SPEC D6.1 to D6.5, D6.8, D6.12).

A deterministic, seeded, capped sample of the cases the AI agent closed automatically
is queued for a person to classify. Their answer is recorded as an independent
``FeedbackEntry`` (ground truth for the threshold tuner, the precedent corpus and
``ground_truth_supply``), while the case's status, decider and disposition stay as the
deterministic decision left them unless the person reopens it.

Selection (pure, :func:`select_for_review`): a case's score is the first 8 bytes of
``sha256("auto-close-review:v1:" + case_id)`` over 2**64. ``case_id`` is minted by the
server, so a crafted alert cannot steer the sample. A case is picked when its score is
below ``sample_rate``, fewer than ``daily_cap`` cases were picked on its operator day
(``SlaPolicy.timezone``) and fewer than ``per_rule_daily_cap`` of its rule identity
(``precedent.case_rule_identity``). Once per case while its ledger entry is kept: after
the ring evicts an entry, a case closed again may be picked again. Nothing is
backfilled: sampling starts with the first decision after an upgrade.

:class:`ReviewSampler` is the pipeline's post-decision hook (``pipeline.review_sampler``):
it runs strictly AFTER ``CaseManager.apply()``, the save and every earlier
post-decision hook, only for a terminal case the agent decided, and it never writes to
the case. An analyst-policy close returns before the hooks and is never sampled; the
replay stack has no sampler. Every failure is logged and swallowed (fail-soft).

This module never imports ``engine.case_manager`` and nothing here is an input to
``decide()`` (#3). It makes no model call (#6). The import ban in
``tests/test_round15_wp5_auto_close_review.py`` keeps it out of model-facing code.
"""

from __future__ import annotations

import hashlib
import logging
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping

from ..constants import (
    AUTO_CLOSE_REVIEW_EVENT,
    TERMINAL_CASE_STATUSES,
    ActionType,
    CaseStatus,
    DecisionBy,
    FeedbackOutcome,
)
from ..models import AuditChange, AuditTarget
from ..stores.auto_close_review import (
    LEDGER_MAX_ENTRIES,
    STATE_COMPLETED,
    STATE_EXPIRED,
    STATE_PENDING,
    ReviewEntry,
    ReviewLedger,
)
from ..utils import new_id
from .metrics import decision_record
from .precedent import case_rule_identity, is_policy_closed
from .time_windows import zone_for

logger = logging.getLogger("tlsoc.engine.auto_close_review")

#: The salt of the sample score. A new version string starts a different sample.
SCORE_SALT = "auto-close-review:v1:"
#: The reviewer's answers (D6.6). ``unsure`` is recorded but labels nothing.
REVIEW_CLASSIFICATIONS: tuple[str, ...] = ("true_positive", "false_positive", "benign", "unsure")
#: ``FeedbackEntry.actual_outcome`` for each answer (D6.6).
CLASSIFICATION_OUTCOME: dict[str, str] = {
    "true_positive": FeedbackOutcome.TRUE_POSITIVE.value,
    "false_positive": FeedbackOutcome.FALSE_POSITIVE.value,
    "benign": FeedbackOutcome.FALSE_POSITIVE.value,
    "unsure": FeedbackOutcome.UNKNOWN.value,
}
#: The AI verdicts each answer agrees with.
_AGREES_WITH: dict[str, str] = {
    "true_positive": "TRUE_POSITIVE",
    "false_positive": "FALSE_POSITIVE",
    "benign": "FALSE_POSITIVE",
}
#: An agreement rate (and its interval) is shown only from this many reviews (D6.12).
MIN_AGREEMENT_REVIEWS = 30
#: The structured audit actions this feature writes (exact catalog entries, D7.5).
REQUESTED_ACTION = "case.review_requested"
REQUEST_FAILED_ACTION = "case.review_request_failed"
RECORDED_ACTION = "case.review_recorded"
RECORD_FAILED_ACTION = "case.review_record_failed"
#: The live frame published on ``cases:{id}`` and ``cases`` when a case is sampled or
#: reviewed (a nudge: ids and codes only; the Console re-reads).
REVIEW_EVENT = "case.review"
#: The statement the Agent effectiveness module shows beside every agreement figure.
AGREEMENT_STATEMENT = (
    "Agreement describes the sampled cases only, unweighted. "
    "It is not an estimate of auto-close precision."
)

__all__ = [
    "AGREEMENT_STATEMENT",
    "CLASSIFICATION_OUTCOME",
    "MIN_AGREEMENT_REVIEWS",
    "RECORDED_ACTION",
    "RECORD_FAILED_ACTION",
    "REQUESTED_ACTION",
    "REQUEST_FAILED_ACTION",
    "REVIEW_CLASSIFICATIONS",
    "REVIEW_EVENT",
    "SCORE_SALT",
    "ReviewSampler",
    "SampleDecision",
    "classification_agrees",
    "first_decision_is_agent_close",
    "history_review",
    "new_entry",
    "operator_day",
    "operator_zone",
    "review_metrics",
    "review_score",
    "review_summary",
    "sample_eligible",
    "select_for_review",
    "wilson_interval",
]


# --------------------------------------------------------------------------- #
# Pure building blocks
# --------------------------------------------------------------------------- #
def review_score(case_id: str) -> float:
    """The case's deterministic sample score in ``[0, 1)``."""
    digest = hashlib.sha256((SCORE_SALT + str(case_id)).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64)


def operator_zone(prefs: Any) -> str:
    """The operator time zone name (``SlaPolicy.timezone``; UTC when unset or
    unknown)."""
    name = getattr(getattr(prefs, "sla", None), "timezone", None)
    return zone_for(name)[1]


def operator_day(instant: datetime, tz: str) -> str:
    """The ISO calendar day of ``instant`` in the operator zone ``tz``."""
    zone, _name = zone_for(tz)
    aware = instant if instant.tzinfo else instant.replace(tzinfo=timezone.utc)
    return aware.astimezone(zone).date().isoformat()


def _value(raw: Any) -> str:
    return str(getattr(raw, "value", raw) or "")


def first_decision_is_agent_close(case: Any) -> bool:
    """True when the case's FIRST recorded decision (``metrics.decision_record``, the
    anchor that survives a reopen and a re-investigation) closed it automatically."""
    try:
        record = decision_record(case)
    except Exception:  # noqa: BLE001 (a malformed history is never an agent close)
        return False
    return bool(
        record is not None
        and record.status == CaseStatus.CLOSED.value
        and record.decision_by == DecisionBy.AGENT.value
    )


def sample_eligible(case: Any) -> bool:
    """Whether a case may be sampled now: terminal, decided by the agent (the case and
    its first decision record), and not closed by an analyst policy."""
    if _value(getattr(case, "status", None)) not in TERMINAL_CASE_STATUSES:
        return False
    if _value(getattr(case, "decision_by", None)) != DecisionBy.AGENT.value:
        return False
    if is_policy_closed(case):
        return False
    return first_decision_is_agent_close(case)


def classification_agrees(classification: str, ai_verdict: str) -> bool | None:
    """Whether the reviewer's answer matches the AI verdict; ``None`` for ``unsure``
    (or an unknown verdict)."""
    wanted = _AGREES_WITH.get(classification)
    verdict = str(ai_verdict or "").strip().upper()
    if wanted is None or verdict not in ("TRUE_POSITIVE", "FALSE_POSITIVE", "NEEDS_HUMAN"):
        return None
    return verdict == wanted


@dataclass(frozen=True)
class SampleDecision:
    """Why a case was or was not picked, with the numbers the audit row records."""

    selected: bool
    reason: str
    score: float
    sample_rate: float
    day: str
    day_count: int
    daily_cap: int
    rule: str
    rule_count: int
    per_rule_daily_cap: int


def select_for_review(
    ledger: ReviewLedger,
    case: Any,
    config: Any,
    *,
    now: datetime,
    tz: str,
    score: float | None = None,
) -> SampleDecision:
    """Decide (pure) whether ``case`` joins the sample. ``reason`` is ``selected``,
    ``disabled``, ``not_eligible``, ``already_sampled``, ``above_rate``,
    ``daily_cap`` or ``rule_cap``."""
    case_id = str(getattr(case, "case_id", "") or "")
    value = review_score(case_id) if score is None else score
    rate = float(getattr(config, "sample_rate", 0.0) or 0.0)
    cap = int(getattr(config, "daily_cap", 0) or 0)
    rule_cap = int(getattr(config, "per_rule_daily_cap", 1) or 1)
    day = operator_day(now, tz)
    rule = case_rule_identity(case)[:256]
    day_count = ledger.day_count(day)
    rule_count = ledger.rule_count(day, rule)

    def result(selected: bool, reason: str) -> SampleDecision:
        return SampleDecision(
            selected=selected, reason=reason, score=value, sample_rate=rate, day=day,
            day_count=day_count, daily_cap=cap, rule=rule, rule_count=rule_count,
            per_rule_daily_cap=rule_cap,
        )

    if not bool(getattr(config, "enabled", False)) or rate <= 0.0 or cap <= 0:
        return result(False, "disabled")
    if not case_id or not sample_eligible(case):
        return result(False, "not_eligible")
    if ledger.entry_for_case(case_id) is not None:
        return result(False, "already_sampled")
    if value >= rate:
        return result(False, "above_rate")
    if day_count >= cap:
        return result(False, "daily_cap")
    if rule_count >= rule_cap:
        return result(False, "rule_cap")
    return result(True, "selected")


def new_entry(case: Any, decision: SampleDecision, now: datetime) -> ReviewEntry:
    """The pending ledger entry of a picked case (its AI verdict snapshotted now)."""
    return ReviewEntry(
        review_id=new_id("acr-")[:36],
        case_id=str(getattr(case, "case_id", "") or ""),
        case_number=str(getattr(case, "case_number", "") or "")[:128],
        rule=decision.rule,
        sampled_at=now.astimezone(timezone.utc).isoformat(),
        day=decision.day,
        score=round(decision.score, 8),
        state=STATE_PENDING,
        ai_verdict=_value(getattr(case, "verdict", None)).upper()[:32],
    )


def history_review(case: Any, review_id: str) -> Mapping[str, Any] | None:
    """The case's ``auto_close_review`` history event that names ``review_id``, or
    None. The ledger is repaired from it when its own write failed after the case
    save (D6.6)."""
    if not review_id:
        return None
    for entry in reversed(list(getattr(case, "history", None) or [])):
        if (
            isinstance(entry, Mapping)
            and entry.get("event") == AUTO_CLOSE_REVIEW_EVENT
            and str(entry.get("review_id") or "") == review_id
        ):
            return entry
    return None


def wilson_interval(successes: int, total: int) -> dict[str, float] | None:
    """The Wilson score 95% interval of ``successes`` of ``total`` (None for 0)."""
    if total <= 0:
        return None
    z = 1.96
    p = successes / total
    denom = 1.0 + z * z / total
    centre = (p + z * z / (2.0 * total)) / denom
    margin = z * ((p * (1.0 - p) / total + z * z / (4.0 * total * total)) ** 0.5) / denom
    return {"low": round(max(0.0, centre - margin), 4), "high": round(min(1.0, centre + margin), 4)}


# --------------------------------------------------------------------------- #
# Read folds (summary, metrics)
# --------------------------------------------------------------------------- #
def review_summary(
    ledger: ReviewLedger, config: Any, *, now: datetime, tz: str,
    open_disagreements: int,
) -> dict[str, Any]:
    """``GET /api/auto-close-review/summary``: ``{enabled, pending, disagreed_open,
    sampled_today, daily_cap}``. ``open_disagreements`` is counted by the caller
    (disagreeing reviews whose case is still closed)."""
    expiry = int(getattr(config, "expiry_days", 7) or 7)
    pending = sum(1 for e in ledger.entries if e.state_at(now, expiry) == STATE_PENDING)
    return {
        "enabled": bool(getattr(config, "enabled", False)),
        "pending": pending,
        "disagreed_open": max(0, int(open_disagreements)),
        "sampled_today": ledger.day_count(operator_day(now, tz)),
        "daily_cap": int(getattr(config, "daily_cap", 0) or 0),
    }


def _median(values: Iterable[float]) -> float | None:
    items = [float(v) for v in values]
    return round(statistics.median(items), 1) if items else None


def review_metrics(
    ledger: ReviewLedger,
    config: Any,
    *,
    start: datetime | None,
    end: datetime,
    now: datetime,
    tz: str,
    eligible_days: Mapping[str, int] | None = None,
    eligible_complete: bool = True,
) -> dict[str, Any]:
    """The Agent effectiveness "Auto-close review" module over the cases SAMPLED in
    ``[start, end)``: sampled, reviewed, pending, expired; agreement with a Wilson 95%
    interval from :data:`MIN_AGREEMENT_REVIEWS` reviews; missed threats (the reviewer
    said true positive on an automatic false positive close); the top 10 rules; the
    median time spent reviewing (client-measured) and the median time to review
    (sampled to completed); and, per operator day, the eligible automatic closes (by
    first agent decision day, counted by the caller) beside the sampled ones. Never a
    composite score; the agreement statement says what the figure is not."""
    expiry = int(getattr(config, "expiry_days", 7) or 7)

    def in_window(entry: ReviewEntry) -> bool:
        at = entry.sampled_instant()
        if at is None:
            return False
        return (start is None or at >= start) and at < end

    cohort = [e for e in ledger.entries if in_window(e)]
    states = Counter(e.state_at(now, expiry) for e in cohort)
    completed = [e for e in cohort if e.state == STATE_COMPLETED]
    rated = [e for e in completed if e.agrees is not None]
    agreed = sum(1 for e in rated if e.agrees)
    enough = len(rated) >= MIN_AGREEMENT_REVIEWS
    missed = [
        e for e in completed
        if e.classification == "true_positive" and e.ai_verdict == "FALSE_POSITIVE"
    ]
    per_rule: dict[str, dict[str, int]] = defaultdict(
        lambda: {"sampled": 0, "reviewed": 0, "agreed": 0, "disagreed": 0}
    )
    for entry in cohort:
        row = per_rule[entry.rule]
        row["sampled"] += 1
        if entry.state == STATE_COMPLETED:
            row["reviewed"] += 1
            if entry.agrees is True:
                row["agreed"] += 1
            elif entry.agrees is False:
                row["disagreed"] += 1
    rules = sorted(per_rule.items(), key=lambda item: (-item[1]["sampled"], item[0]))[:10]
    spent = [e.elapsed_ms for e in completed if isinstance(e.elapsed_ms, int)]
    waits: list[float] = []
    for entry in completed:
        sampled_at, done_at = entry.sampled_instant(), entry.completed_instant()
        if sampled_at is not None and done_at is not None and done_at >= sampled_at:
            waits.append((done_at - sampled_at).total_seconds() * 1000.0)
    sampled_days = Counter(e.day for e in cohort)
    days = sorted(set(sampled_days) | set(eligible_days or {}))
    oldest = ledger.entries[0].sampled_instant() if ledger.entries else None
    # The ring keeps the newest entries: a window that starts before the oldest kept
    # one may be missing evicted samples, so its counts are lower bounds.
    ledger_complete = not (
        len(ledger.entries) >= LEDGER_MAX_ENTRIES and oldest is not None
        and (start is None or start < oldest)
    )
    return {
        "sampled": len(cohort),
        "reviewed": len(completed),
        "pending": states.get(STATE_PENDING, 0),
        "expired": states.get(STATE_EXPIRED, 0),
        "unsure": sum(1 for e in completed if e.agrees is None),
        "agreement": {
            "status": "ok" if enough else "insufficient",
            "agreed": agreed,
            "disagreed": len(rated) - agreed,
            "reviews": len(rated),
            "minimum": MIN_AGREEMENT_REVIEWS,
            "rate": round(agreed / len(rated), 4) if enough else None,
            "interval": wilson_interval(agreed, len(rated)) if enough else None,
            "statement": AGREEMENT_STATEMENT,
        },
        "missed_threats": {
            "count": len(missed),
            "cases": [
                {"case_id": e.case_id, "case_number": e.case_number, "rule": e.rule,
                 "completed_at": e.completed_at}
                for e in sorted(missed, key=lambda e: e.completed_at, reverse=True)[:20]
            ],
        },
        "by_rule": [{"rule": rule, **counts} for rule, counts in rules],
        "time_spent_ms": {"median": _median(spent), "reviews": len(spent)},
        "time_to_review_ms": {"median": _median(waits), "reviews": len(waits)},
        "by_day": [
            {"day": day, "eligible": int((eligible_days or {}).get(day, 0)),
             "sampled": int(sampled_days.get(day, 0))}
            for day in days
        ],
        "eligible": {
            "count": int(sum((eligible_days or {}).values())),
            "complete": bool(eligible_complete),
        },
        "ledger_complete": ledger_complete,
    }


# --------------------------------------------------------------------------- #
# The post-decision hook
# --------------------------------------------------------------------------- #
class ReviewSampler:
    """``pipeline.review_sampler``: picks a just-closed agent case for review.

    Every collaborator is a getter, so the real sampler follows a KV the state
    rebuilds and the Demo sampler stays bound to its own stack: ``store`` (the
    ledger), ``audit`` (the audit logger it writes ``case.review_requested`` to),
    ``bus`` (the realtime bus, or None) and ``active`` (False once the Demo stack it
    belongs to has ended; the sampler then writes nothing)."""

    def __init__(
        self,
        *,
        store: Callable[[], Any],
        audit: Callable[[], Any],
        bus: Callable[[], Any] | None = None,
        active: Callable[[], bool] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._audit = audit
        self._bus = bus
        self._active = active
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    async def __call__(self, case: Any, prefs: Any) -> bool:
        """Sample ``case`` when it qualifies. Returns True when it was picked. Never
        raises: an error logs a warning and leaves the case untouched."""
        try:
            return await self._sample(case, prefs)
        except Exception as exc:  # noqa: BLE001 (sampling never affects the case path)
            logger.warning(
                "Auto-close review sampling skipped for %s: %s",
                str(getattr(case, "case_id", ""))[:80], exc,
            )
            return False

    async def _sample(self, case: Any, prefs: Any) -> bool:
        config = getattr(prefs, "auto_close_review", None)
        if config is None or not getattr(config, "enabled", False):
            return False
        if not sample_eligible(case):
            return False
        case_id = str(getattr(case, "case_id", "") or "")
        score = review_score(case_id)
        # The cheap test first: most closes are above the rate and read nothing.
        if score >= float(getattr(config, "sample_rate", 0.0) or 0.0):
            return False
        if self._active is not None and not self._active():
            return False
        store = self._store()
        audit = self._audit()
        if store is None or audit is None:
            return False
        tz = operator_zone(prefs)
        now = self._clock()
        async with store.lock:
            ledger = await store.load()
            decision = select_for_review(ledger, case, config, now=now, tz=tz, score=score)
            if not decision.selected:
                logger.debug("Auto-close review: %s not picked (%s)", case_id[:80], decision.reason)
                return False
            entry = new_entry(case, decision, now)
            label = entry.case_number or case_id
            fields = {
                "review_id": entry.review_id,
                "score": entry.score,
                "sample_rate": decision.sample_rate,
                "day": decision.day,
                "day_count": decision.day_count,
                "daily_cap": decision.daily_cap,
                "rule": decision.rule,
                "rule_count": decision.rule_count,
                "per_rule_daily_cap": decision.per_rule_daily_cap,
            }
            # Audit first (#2): a case is in the sample only once its row is written.
            await audit.record_strict(
                action_type=ActionType.AUTOMATION, surface="auto_close_review",
                actor="system", actor_type="system", action=REQUESTED_ACTION,
                outcome="success", case_id=case_id,
                target=AuditTarget(type="case", id=case_id, label=label),
                changes=[AuditChange(field="auto_close_review.state", before=None, after=STATE_PENDING)],
                tool_input=fields,
                result_summary=(
                    f"review_requested review_id={entry.review_id} "
                    f"score={entry.score:.6f} rate={decision.sample_rate}"
                ),
            )

            def _add(current: ReviewLedger) -> ReviewLedger | None:
                if current.entry_for_case(case_id) is not None:
                    return None
                current.add(entry, now=now, expiry_days=int(getattr(config, "expiry_days", 7) or 7))
                return current

            try:
                await store.update(_add, locked=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Auto-close review ledger write failed for %s: %s", case_id[:80], exc)
                try:
                    await audit.record(
                        action_type=ActionType.AUTOMATION, surface="auto_close_review",
                        actor="system", actor_type="system", action=REQUEST_FAILED_ACTION,
                        outcome="failure", case_id=case_id,
                        target=AuditTarget(type="case", id=case_id, label=label),
                        tool_input={"review_id": entry.review_id},
                        result_summary=f"review_request_failed review_id={entry.review_id} code=ledger_unavailable",
                    )
                except Exception:  # noqa: BLE001
                    pass
                return False
        publish_review_frame(self._bus() if self._bus else None, case_id, entry.review_id, STATE_PENDING)
        return True


def publish_review_frame(bus: Any, case_id: str, review_id: str, state: str) -> None:
    """One ``case.review`` nudge on ``cases:{id}`` and on ``cases`` (ids and the state
    only, #7 and #9). Fire and forget."""
    if bus is None:
        return
    payload = {"case_id": case_id, "review_id": review_id, "state": state}
    for topic in (f"cases:{case_id}", "cases"):
        try:
            bus.publish(topic, REVIEW_EVENT, dict(payload))
        except Exception:  # noqa: BLE001 (realtime is advisory)
            pass


def eligible_closes_by_day(
    cases: Iterable[Any], *, start: datetime | None, end: datetime, tz: str,
) -> dict[str, int]:
    """How many cases the agent closed automatically per operator day, by the day of
    their FIRST decision record (``metrics.decision_record``), within ``[start, end)``."""
    out: Counter[str] = Counter()
    for case in cases:
        try:
            record = decision_record(case)
        except Exception:  # noqa: BLE001
            continue
        if (
            record is None or record.at is None
            or record.status != CaseStatus.CLOSED.value
            or record.decision_by != DecisionBy.AGENT.value
        ):
            continue
        at = record.at if record.at.tzinfo else record.at.replace(tzinfo=timezone.utc)
        if (start is not None and at < start) or at >= end:
            continue
        out[operator_day(at, tz)] += 1
    return dict(out)


def days_between(start: date, end: date) -> list[str]:
    """Every ISO day from ``start`` to ``end`` inclusive (for a zero-filled series)."""
    out: list[str] = []
    day = start
    while day <= end and len(out) < 400:
        out.append(day.isoformat())
        day += timedelta(days=1)
    return out
