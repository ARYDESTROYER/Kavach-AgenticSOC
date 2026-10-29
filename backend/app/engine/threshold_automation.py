"""Threshold-based automation — post-decision, #3-safe (Wave 6 / F10).

After the deterministic ``case_manager.decide()`` + save, an operator-configured set
of :class:`app.config.AutomationRule` is evaluated against the case. A matching rule
fires ONE action:

* ``tag``            — add the rule's tags to the case (SAFE, applied directly + audited).
* ``recommend``      — attach a NON-BINDING recommendation comment (SAFE).
* ``notify``         — schedule a fire-and-forget notification (SAFE; existing path).
* ``run_playbook``   : ATTACH a runbook to the case ($0, Round 14 SPEC §4.10.16). The
                       stored action keeps its name (the naming contract); the target
                       is resolved at fire time from ``payload.runbook_id``, else
                       ``payload.playbook_id`` through the migration's id map and the
                       retired bundled ids (``runbook_model.
                       resolve_automation_runbook_id``). A run is human workflow: it
                       never changes the verdict, the status or ``decide()``; a target
                       that is missing, a Draft or retired is skipped with
                       ``run.attach_skipped``. Before Round 14 this queued a forced
                       re-investigation instead.
* ``request_approval`` — create a HITL :class:`app.models.Proposal` (the EXISTING
                       proposer/approve path is the only live-write route). NO live
                       write happens here.
  (The Rule editor shows ``run_playbook`` as "Attach a runbook".)

THE #3 BOUNDARY (enforced + tested here): automation runs AFTER apply()+save and may
NEVER set ``case.status`` / ``case.disposition``, never auto-close, and never act on
a NEEDS_HUMAN / escalated case for status. Every action only TAGS / RECOMMENDS /
NOTIFIES / ATTACHES a runbook / opens a Proposal. Each matched action is
appended to ``Case.automation_actions`` (an additive audit list) and audited under
``ActionType.AUTOMATION``.

FAIL-ISOLATED: ``run(...)`` never raises into the case path — any error degrades to
"no automation" so a misconfigured rule can never break case creation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping

from ..config import AutomationRule, Preferences
from ..constants import ActionType, Verdict
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

#: ``await attach(case, runbook_id, rule_id)``: attach the resolved runbook to the
#: case for a ``run_playbook`` rule and return the new run, or ``None`` when nothing
#: was attached (skipped, with its ``run.attach_skipped`` row, or already there). The
#: application binds it with :func:`bind_runbook_automation`.
RunbookAttach = Callable[[Case, "str | None", str], Awaitable[Any]]
#: ``await migrated()``: legacy procedure id to runbook id, from the runbook
#: migration's marker (empty before the migration has run).
MigratedProcedures = Callable[[], Awaitable[Mapping[str, str]]]


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
    callbacks for notification dispatch and runbook attachment (Round 14). It
    NEVER sets ``case.status``/``disposition`` and NEVER writes a live rule (writes
    route through the Proposal/approve path)."""

    def __init__(
        self,
        proposals: "ProposalStore",
        audit: "AuditLogger",
        *,
        notify: Callable[[Case, str], Any] | None = None,
        attach_runbook: RunbookAttach | None = None,
        migrated_procedures: MigratedProcedures | None = None,
    ) -> None:
        self._proposals = proposals
        self._audit = audit
        # notify(case, channel_or_trigger) — fire-and-forget; may be sync or async.
        self._notify = notify
        # Round 14: a ``run_playbook`` rule attaches a runbook (see the module docs).
        # Without ``attach_runbook`` (a stack that wires none) the rule records that
        # nothing was attached; without ``migrated_procedures`` a legacy operator id
        # resolves through the retired bundled ids only.
        self._attach_runbook = attach_runbook
        self._migrated_procedures = migrated_procedures

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
            # "Attach a runbook" (Round 14 SPEC §4.10.16): resolved at fire time, never
            # by rewriting the stored rule; an attach never touches status (#3). A
            # stored id that resolves to nothing still reaches the attacher, so its
            # ``run.attach_skipped`` row and this record name the id that failed.
            requested = _requested_runbook_id(payload)
            runbook_id = await self._resolve_runbook(payload) or requested or None
            attached = await self._maybe_attach_runbook(case, runbook_id, action.rule_id)
            detail = f"attach_runbook={runbook_id or '(none)'} attached={attached}"

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

    async def _resolve_runbook(self, payload: Mapping[str, Any]) -> str | None:
        """The runbook a ``run_playbook`` rule names, resolved now (SPEC §4.10.16):
        ``payload.runbook_id``, else ``payload.playbook_id`` through the migration's
        id map, else through the retired bundled ids. ``None`` when it names nothing
        that resolves (the attach step then records the skip). Never raises.

        The migration's map comes first for a ``playbook_id``: it holds a retired
        bundled id only when a configured procedure folder's file held it
        (``runbook_migration.migrated_procedure_ids``), and that file, not the bundled
        procedure, is what a rule naming the id ran before Round 14."""
        from .runbook_model import resolve_automation_runbook_id

        migrated: Mapping[str, str] = {}
        if self._migrated_procedures is not None:
            try:
                migrated = await self._migrated_procedures() or {}
            except Exception as exc:  # noqa: BLE001 - the bundled ids still resolve
                logger.info("automation: the runbook migration map could not be read: %s", exc)
                migrated = {}
        try:
            if not _payload_text(payload, "runbook_id"):
                playbook_id = _payload_text(payload, "playbook_id")
                target = migrated.get(playbook_id) if playbook_id and hasattr(migrated, "get") else None
                if isinstance(target, str) and target.strip():
                    return target.strip()
            return resolve_automation_runbook_id(payload, migrated)
        except Exception as exc:  # noqa: BLE001 - a malformed payload attaches nothing
            logger.debug("automation runbook resolution failed: %s", exc)
            return None

    async def _maybe_attach_runbook(self, case: Case, runbook_id: str | None, rule_id: str) -> bool:
        """Attach ``runbook_id`` through the bound attacher; True only when a new run
        was attached. The attacher records every skip (``run.attach_skipped``) and is
        idempotent per case and runbook (#4). Never raises into the case path."""
        if self._attach_runbook is None:
            return False
        try:
            run = await self._attach_runbook(case, runbook_id, rule_id)
        except Exception as exc:  # noqa: BLE001 - an attachment never breaks the case path
            logger.debug("automation runbook attach failed for %s: %s", case.case_id, exc)
            return False
        return run is not None


def _payload_text(payload: Any, key: str) -> str:
    """``payload[key]`` as stripped text, ``""`` when absent or not text."""
    value = payload.get(key) if hasattr(payload, "get") else None
    return value.strip() if isinstance(value, str) else ""


def _requested_runbook_id(payload: Any) -> str:
    """The id a ``run_playbook`` rule stores (``runbook_id``, else ``playbook_id``),
    unresolved, bounded to the id length the audit row keeps."""
    return (_payload_text(payload, "runbook_id") or _payload_text(payload, "playbook_id"))[:64]


#: Why a real case got no runbook from its rule while Demo Mode was on.
DEMO_MODE_SKIP_REASON = "Demo Mode was on, so the rule attached nothing to this real case."


def bind_runbook_automation(state: Any) -> tuple[RunbookAttach, MigratedProcedures]:
    """The ``attach_runbook`` and ``migrated_procedures`` callables of the REAL
    automation, bound to the application ``state`` (Round 14 SPEC §4.10.16).

    ``attach_runbook`` attaches through ``runbook_runs.attach_by_automation`` (actor
    ``threshold_automation``: ``run.attached`` or ``run.attach_skipped`` with the
    reason). It acts on the real stack only: while Demo Mode is on the active run store
    and audit are the Demo ones, so the run of a REAL case would vanish with them. The
    rule then attaches nothing and its ``run.attach_skipped`` row (reason
    :data:`DEMO_MODE_SKIP_REASON`) goes to the real control audit (#2). The case's
    post-investigation attachment (the matching runbook) is still kept until Demo Mode
    ends (``AppState._attach_runbook_to_real_case``). ``migrated_procedures`` reads
    the migration marker's id map of the procedure namespaces
    (``runbook_migration.migrated_procedure_ids``); an unreadable or absent marker
    reads as an empty map, so a rule that fires before the migration falls back to the
    retired bundled ids."""
    async def attach(case: Case, runbook_id: str | None, rule_id: str) -> Any:
        if getattr(state, "demo_active", False):
            await _record_demo_mode_skip(state, case, runbook_id, rule_id)
            return None
        from .runbook_runs import attach_by_automation

        return await attach_by_automation(state, case, runbook_id, rule_id=rule_id)

    async def migrated() -> Mapping[str, str]:
        from .runbook_migration import migrated_procedure_ids

        library = getattr(state, "runbook_library", None)
        if library is None:
            return {}
        try:
            record = await library.read_marker()
        except Exception as exc:  # noqa: BLE001 - resolve through the bundled ids
            logger.info("automation: the runbook migration marker could not be read: %s", exc)
            return {}
        return migrated_procedure_ids(record.marker if record is not None else None)

    return attach, migrated


def bind_demo_runbook_automation(
    state: Any, is_active: Callable[[], bool],
) -> tuple[RunbookAttach, MigratedProcedures]:
    """The ``attach_runbook`` and ``migrated_procedures`` callables of a DEMO stack's
    automation (Round 14 SPEC §4.10.16, D45), so a ``run_playbook`` rule on a Demo case
    attaches as it does on a real one.

    ``attach_runbook`` attaches only while that Demo stack is the active one
    (``is_active``, for example ``lambda: state._demo is demo_stack``). The run engine
    binds the ACTIVE run store, audit and settings, which are then the Demo ones, so the
    run and its ``run.attached`` or ``run.attach_skipped`` row land in the Demo stack
    and are purged with it; the catalog is the active one too (the real library with
    the Demo overlay). A rule that fires after that stack ended (Demo Mode turned off or
    reset) attaches nothing and writes nothing anywhere. ``migrated_procedures`` reads
    the REAL library's migration marker (read only), as the real automation does."""
    _real_attach, migrated = bind_runbook_automation(state)

    async def attach(case: Case, runbook_id: str | None, rule_id: str) -> Any:
        try:
            active = bool(is_active())
        except Exception as exc:  # noqa: BLE001 - an unknown stack attaches nothing
            logger.debug("automation: the Demo stack check failed: %s", exc)
            active = False
        if not active:
            logger.info(
                "automation: rule %s attached no runbook to Demo case %s: that Demo stack "
                "is no longer active",
                str(rule_id)[:128], str(getattr(case, "case_id", "") or "")[:80],
            )
            return None
        from .runbook_runs import attach_by_automation

        return await attach_by_automation(state, case, runbook_id, rule_id=rule_id)

    return attach, migrated


async def _record_demo_mode_skip(state: Any, case: Case, runbook_id: str | None, rule_id: str) -> None:
    """The ``run.attach_skipped`` row of a real case's rule while Demo Mode is on, in
    the REAL control audit (the active audit is the Demo one), shaped as
    ``runbook_runs.attach_by_automation`` shapes its skips. Never raises."""
    from ..models import AuditTarget

    audit = getattr(state, "control_audit", None)
    case_id = str(getattr(case, "case_id", "") or "")
    logger.info(
        "automation: rule %s attached no runbook to real case %s while Demo Mode is on",
        str(rule_id)[:128], case_id[:80],
    )
    if audit is None:
        return
    try:
        await audit.record_strict(
            action_type=ActionType.RUNBOOK, surface="runbook", actor="threshold_automation",
            actor_type="system", action="run.attach_skipped", outcome="success",
            case_id=case_id,
            target=AuditTarget(type="case", id=case_id,
                               label=str(getattr(case, "case_number", "") or "") or case_id),
            result_summary=f"No runbook attached: {DEMO_MODE_SKIP_REASON}",
            tool_input={"runbook_id": (runbook_id or "")[:64], "rule_id": str(rule_id)[:128],
                        "reason": DEMO_MODE_SKIP_REASON},
        )
    except Exception as exc:  # noqa: BLE001 - automation never fails on a runbook
        logger.warning("automation: the Demo Mode skip row for case %s was not written: %s",
                       case_id[:80], exc)
