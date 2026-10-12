"""Threshold-based automation — post-decision, #3-safe (Wave 6 / F10).

After the deterministic ``case_manager.decide()`` + save, an operator-configured set
of :class:`app.config.AutomationRule` is evaluated against the case. A matching rule
fires ONE action:

* ``tag``            — add the rule's tags to the case (SAFE, applied directly + audited).
* ``recommend``      — attach a NON-BINDING recommendation comment (SAFE).
* ``notify``         — schedule a fire-and-forget notification (SAFE; existing path).
* ``run_playbook``   — QUEUE a re-investigation with a playbook forced as context
                       (SAFE; the re-investigation itself calls ``decide()`` AGAIN
                       with the new context — it never bypasses the decision).
* ``request_approval`` — create a HITL :class:`app.models.Proposal` (the EXISTING
                       proposer/approve path is the only live-write route). NO live
                       write happens here.

THE #3 BOUNDARY (enforced + tested here): automation runs AFTER apply()+save and may
NEVER set ``case.status`` / ``case.disposition``, never auto-close, and never act on
a NEEDS_HUMAN / escalated case for status. Every action only TAGS / RECOMMENDS /
NOTIFIES / QUEUES a fresh ``decide()`` run / opens a Proposal. Each matched action is
appended to ``Case.automation_actions`` (an additive audit list) and audited under
``ActionType.AUTOMATION``.

FAIL-ISOLATED: ``run(...)`` never raises into the case path — any error degrades to
"no automation" so a misconfigured rule can never break case creation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Callable

from ..config import AutomationRule, Preferences
from ..constants import ActionType, CaseStatus, Verdict
from ..models import Case, Proposal
from ..utils import iso_now, now_utc
from .case_tags import CASE_TAG_MAX_CHARS, CASE_TAG_MAX_COUNT, automation_tags, tag_too_long

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..audit.audit_log import AuditLogger
    from ..stores.proposals import ProposalStore

logger = logging.getLogger("tlsoc.engine.threshold_automation")

# Statuses that must NEVER be acted on automatically beyond a passive tag/record:
# a NEEDS_HUMAN / ESCALATED case is awaiting a human — automation can still tag /
# recommend / notify, but the #3 invariant (never auto-close, never set status) is
# enforced structurally because NO action here ever writes status anyway.
_VALID_VERDICTS = {v.value for v in Verdict}

# How long an automation-drafted approval proposal self-retires after.
_PROPOSAL_EXPIRY_DAYS = 30


@dataclass(frozen=True)
class AutomationAction:
    """One matched rule resolved to its action (priority-ordered). Pure data — the
    caller (``execute``) performs the side effect."""

    rule_id: str
    action: str
    payload: dict[str, Any] = field(default_factory=dict)
    priority: int = 100


def _verdict_value(case: Case) -> str:
    return case.verdict.value if case.verdict else ""


def _resolve_proposal_kind(payload: dict[str, Any]) -> str:
    """Resolve the HITL Proposal ``kind`` for a ``request_approval`` action so it ALWAYS
    round-trips through the existing approve path (bug #11).

    * ``suppression`` ONLY when the payload is a complete suppression (both ``field``
      AND ``value`` present) — otherwise the approve path's ``SuppressionRule``
      validation 400s. A partial suppression becomes an acknowledgement checkpoint.
    * ``memory`` ONLY when explicitly requested. Generic review work must never become
      trusted durable context merely because it passed through the Approvals queue.
    * everything else uses ``automation_ack``. Approval records the operator review and
      materialises no configuration, Memory, suppression, or case-state change.

    Every emitted kind has an explicit approve-path branch, so no review item can
    dead-end at approval time or silently acquire a stronger meaning."""
    requested = str(payload.get("kind") or "").strip().lower()
    has_suppression_shape = bool(
        str(payload.get("field") or "").strip() and str(payload.get("value") or "").strip()
    )
    if requested == "suppression" and has_suppression_shape:
        return "suppression"
    if requested == "memory":
        return "memory"
    # A complete suppression payload with no explicit kind still round-trips as one.
    if not requested and has_suppression_shape:
        return "suppression"
    # Generic approval gate (or a partial/unknown shape) → review-only acknowledgement.
    return "automation_ack"


def _coerce_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rule_matches(rule: AutomationRule, case: Case) -> bool:
    """True iff ALL present (non-empty) conditions hold for the case. Pure +
    side-effect-free. An absent/empty condition key never constrains."""
    cond = rule.conditions or {}

    want_verdict = cond.get("verdict")
    if want_verdict:
        if str(want_verdict).upper() != _verdict_value(case).upper():
            return False

    min_risk = _coerce_float(cond.get("min_risk"))
    if min_risk is not None and float(case.risk_score) < min_risk:
        return False

    # ``min_severity`` is matched against the case risk_score (the 0..100 severity
    # surface the engine carries) per the Wave-6 contract.
    min_sev = _coerce_float(cond.get("min_severity"))
    if min_sev is not None and float(case.risk_score) < min_sev:
        return False

    want_status = cond.get("status")
    if want_status:
        current = case.status.value if case.status else ""
        if str(want_status) != current:
            return False

    want_source = cond.get("source_id")
    if want_source:
        if str(want_source) != str(case.source_id or ""):
            return False

    want_rule = cond.get("rule_name")
    if want_rule:
        if str(want_rule) not in [str(r) for r in (case.rule_ids or [])]:
            return False

    want_entity = cond.get("entity_type")
    if want_entity:
        if str(want_entity) != (case.entity.type.value if case.entity else ""):
            return False

    return True


def evaluate(case: Case, prefs: Preferences) -> list[AutomationAction]:
    """Return the matched automation actions for ``case`` in PRIORITY order
    (lower ``priority`` first; ties by rule id). Pure + deterministic.

    Returns ``[]`` when automation is disabled (the default) or no rule matches —
    so today's behaviour is byte-identical out of the box."""
    cfg = getattr(prefs, "threshold_automation", None)
    if cfg is None or not cfg.enabled:
        return []
    matched: list[AutomationAction] = []
    for rule in cfg.rules:
        try:
            if not rule.enabled:
                continue
            if _rule_matches(rule, case):
                matched.append(
                    AutomationAction(
                        rule_id=rule.id,
                        action=rule.action,
                        payload=dict(rule.payload or {}),
                        priority=rule.priority,
                    )
                )
        except Exception as exc:  # noqa: BLE001 — a bad rule never breaks evaluation
            logger.warning("automation rule %s evaluation failed: %s", getattr(rule, "id", "?"), exc)
            continue
    matched.sort(key=lambda a: (a.priority, a.rule_id))
    return matched


class ThresholdAutomation:
    """Executes matched automation actions for a saved case — #3-safe.

    Wired with the deterministic stores it needs (proposals, audit) + optional
    callbacks for notification dispatch and a queued playbook re-investigation. It
    NEVER sets ``case.status``/``disposition`` and NEVER writes a live rule (writes
    route through the Proposal/approve path)."""

    def __init__(
        self,
        proposals: "ProposalStore",
        audit: "AuditLogger",
        *,
        notify: Callable[[Case, str], Any] | None = None,
        queue_playbook_run: Callable[[Case, str], Any] | None = None,
    ) -> None:
        self._proposals = proposals
        self._audit = audit
        # notify(case, channel_or_trigger) — fire-and-forget; may be sync or async.
        self._notify = notify
        # queue_playbook_run(case, playbook_id) — re-investigate with the playbook
        # forced as context. The re-investigation itself calls decide() AGAIN.
        self._queue_playbook_run = queue_playbook_run

    async def run(self, case: Case, prefs: Preferences, *, save: Callable[[Case], Any]) -> Case:
        """Evaluate + execute automation for ``case`` AFTER apply()+save. Records each
        action on ``Case.automation_actions`` + audits it. Persists the case via
        ``save`` when any SAFE action mutated it. NEVER raises — any failure degrades
        to no automation. NEVER touches status/disposition (#3)."""
        try:
            actions = evaluate(case, prefs)
            if not actions:
                return case
        except Exception as exc:  # noqa: BLE001 — evaluation must never break the case path
            logger.warning("automation evaluate failed for %s: %s", case.case_id, exc)
            return case

        status_before = case.status
        disposition_before = case.disposition
        dirty = False

        for action in actions:
            try:
                changed = await self._execute_one(case, action, prefs)
                dirty = dirty or changed
            except Exception as exc:  # noqa: BLE001 — one bad action never breaks the rest
                logger.warning(
                    "automation action %s (%s) failed for %s: %s",
                    action.rule_id, action.action, case.case_id, exc,
                )

        # DEFENCE IN DEPTH (#3): automation may NEVER move the lifecycle status or
        # the disposition. Assert it did not (a bug here is a guardrail breach).
        if case.status != status_before or case.disposition != disposition_before:
            raise AssertionError(
                "Invariant violated: threshold automation changed case status/disposition"
            )

        if dirty:
            try:
                result = save(case)
                if hasattr(result, "__await__"):
                    await result
            except Exception as exc:  # noqa: BLE001 — a save failure never breaks the case path
                logger.warning("automation save failed for %s: %s", case.case_id, exc)
        return case

    async def _execute_one(self, case: Case, action: AutomationAction, prefs: Preferences) -> bool:
        """Perform a single action. Returns True when it mutated the case in a way
        that needs persisting. Records the action on ``automation_actions`` + audits."""
        payload = action.payload or {}
        detail = ""
        proposal_id: str | None = None
        mutated = False

        if action.action == "tag":
            # The Rule editor saves ``tags`` (a list); an API-written rule may carry one
            # ``tag``/``value``. Each tag is added whole or not at all: one over the
            # length bound, or one that would take the case past the count bound, is
            # left off and the record says so (``engine/case_tags.py``), never cut.
            wanted = automation_tags(payload)
            not_added: list[str] = []
            for tag in wanted:
                if tag in case.tags:
                    continue
                if tag_too_long(tag):
                    not_added.append(f'"{tag}" is longer than {CASE_TAG_MAX_CHARS} characters')
                elif len(case.tags) >= CASE_TAG_MAX_COUNT:
                    not_added.append(f'"{tag}", the case already has {CASE_TAG_MAX_COUNT} tags')
                else:
                    case.tags = [*case.tags, tag]
                    mutated = True
            detail = f"tag={', '.join(wanted) or '(empty)'}"
            if not_added:
                detail += f". Not added: {'; '.join(not_added)}."

        elif action.action == "recommend":
            text = str(payload.get("text") or payload.get("recommendation") or "").strip()[:1000]
            if text:
                from ..models import CaseComment

                case.comments = [
                    *case.comments,
                    CaseComment(author="automation", body=f"[automation recommendation] {text}"),
                ]
                mutated = True
            detail = f"recommend={text[:80]}"

        elif action.action == "notify":
            trigger = str(payload.get("trigger") or payload.get("channel") or "automation")
            await self._maybe_notify(case, trigger)
            detail = f"notify={trigger}"

        elif action.action == "run_playbook":
            playbook_id = str(payload.get("playbook_id") or "").strip()
            queued = await self._maybe_queue_playbook(case, playbook_id)
            detail = f"run_playbook={playbook_id or '(none)'} queued={queued}"

        elif action.action == "request_approval":
            proposal = await self._create_proposal(case, action)
            if proposal is not None:
                proposal_id = proposal.id
                detail = f"proposal={proposal.id} kind={proposal.kind}"
            else:
                detail = "proposal=none"

        else:  # pragma: no cover — Literal-constrained, defensive
            detail = f"unknown_action={action.action}"

        # Append-only, non-binding audit record on the case.
        record: dict[str, Any] = {
            "ts": iso_now(),
            "rule_id": action.rule_id,
            "action": action.action,
            "detail": detail,
        }
        if proposal_id:
            record["proposal_id"] = proposal_id
        case.automation_actions = [*case.automation_actions, record]
        mutated = True  # the automation_actions append always needs persisting

        try:
            await self._audit.record(
                action_type=ActionType.AUTOMATION, surface="automation", actor="automation",
                case_id=case.case_id,
                result_summary=f"rule={action.rule_id} action={action.action} {detail}",
            )
        except Exception as exc:  # noqa: BLE001 — audit is best-effort
            logger.debug("automation audit failed for %s: %s", case.case_id, exc)
        return mutated

    async def _create_proposal(self, case: Case, action: AutomationAction) -> Proposal | None:
        """Materialise a PENDING HITL Proposal for a ``request_approval`` action — the
        ONLY thing automation does for an approval-required action (NO live write).

        THE #11 FIX (round-trip, not a dead end): the proposal ``kind`` must be one the
        existing ``/proposals/{id}/approve`` path can process, or approving it 400s.
        Previously this ALWAYS forced ``kind="suppression"`` — but a generic
        ``request_approval`` rule carries no ``field``/``value``, so the approve path's
        ``SuppressionRule.model_validate`` rejected it (400: "invalid suppression
        payload"). We now resolve the kind to a shape that ALWAYS round-trips:

        * a fully-formed suppression payload (has both ``field`` AND ``value``) stays
          ``kind="suppression"`` → approving it adds a live suppression rule, as before;
        * an explicit ``kind="memory"`` stays ``memory`` → approving it files a note;
        * ANYTHING ELSE (the common generic gate, a partial suppression, or an unknown
          requested kind) becomes ``kind="automation_ack"`` — approval records only that
          the operator reviewed the checkpoint. It never creates trusted Memory.

        Every path is #3-safe: the existing approve write-path may materialise an explicit
        suppression or Memory proposal, while an automation acknowledgement changes only
        proposal status. It NEVER closes or transitions the case."""
        payload = dict(action.payload or {})
        kind = _resolve_proposal_kind(payload)
        rationale = str(
            payload.get("rationale")
            or f"Threshold automation rule '{action.rule_id}' requested approval for "
            f"case {case.case_id} (verdict={_verdict_value(case) or 'n/a'}, "
            f"risk={round(case.risk_score, 1)}). Review before approving."
        )
        # An explicitly requested memory still needs durable text. Generic gates never
        # enter this branch: they are acknowledgement-only and cannot become Memory.
        if kind == "memory" and not str(payload.get("text") or "").strip():
            payload["text"] = rationale
        if kind == "automation_ack":
            payload.setdefault("rule_id", action.rule_id)
            requested_kind = str(payload.get("kind") or "").strip()
            if requested_kind and requested_kind != "automation_ack":
                payload.setdefault("requested_kind", requested_kind)
        expires = (now_utc() + timedelta(days=_PROPOSAL_EXPIRY_DAYS)).isoformat()
        prop = Proposal(
            kind=kind,  # type: ignore[arg-type]
            payload=payload,
            rationale=rationale,
            confidence=float(payload.get("confidence", 0.5) or 0.5),
            source_case_ids=[case.case_id],
            created_by="automation",
            expires_at=expires,
        )
        await self._proposals.add(prop)
        try:
            await self._audit.record(
                action_type=ActionType.PROPOSAL, surface="automation", actor="automation",
                case_id=case.case_id,
                result_summary=f"automation drafted {kind} proposal {prop.id} (rule={action.rule_id})",
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("automation proposal audit failed for %s: %s", case.case_id, exc)
        return prop

    async def _maybe_notify(self, case: Case, trigger: str) -> None:
        if self._notify is None:
            return
        try:
            result = self._notify(case, trigger)
            if hasattr(result, "__await__"):
                await result
        except Exception as exc:  # noqa: BLE001 — notifications never affect the case
            logger.debug("automation notify failed for %s: %s", case.case_id, exc)

    async def _maybe_queue_playbook(self, case: Case, playbook_id: str) -> bool:
        if self._queue_playbook_run is None or not playbook_id:
            return False
        try:
            result = self._queue_playbook_run(case, playbook_id)
            if hasattr(result, "__await__"):
                await result
            return True
        except Exception as exc:  # noqa: BLE001 — a queued re-investigation never breaks the case path
            logger.debug("automation queue_playbook_run failed for %s: %s", case.case_id, exc)
            return False
