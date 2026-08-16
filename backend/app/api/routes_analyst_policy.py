"""Analyst rule policies — the operator's own rule-level statement about their estate.

The product tells an operator that analyst-confirmed outcomes are how the agent learns,
and the threshold tuner actively asks for more of them. For a detection whose alerts
carry no per-case evidence that loop has no exit: the investigation cannot verify that
THIS instance is benign, so it correctly returns ``NEEDS_HUMAN`` however many confirmed
benign outcomes stand behind the rule, and confirming more cannot change an
evidence-sufficiency judgement. This router is the exit — a way to assert a RULE-LEVEL
fact once, explicitly and under audit, instead of arguing with a model per case.

A live declaration closes matching clusters deterministically, with **no LLM call at
all**, as ``disposition=false_positive`` / ``decision_by=analyst_policy``
(``engine.precedent.match_analyst_rule_policy`` →
``agents.pipeline.InvestigationPipeline._close_by_analyst_policy``).

⚠ HARD INVARIANTS:

  * **#3 — this is a CONFIG WRITER.** Nothing here imports or calls
    ``case_manager.decide()``, and the declaration is evaluated BEFORE any verdict
    exists, so it is not a new authority layered onto the auto-close policy. It is the
    operator's decision, applied where the operator's decision belongs.
  * **Never silently drops.** Unlike ``Preferences.suppression_rules`` (a field==value
    event drop), a declared cluster still becomes a VISIBLE, audited, reopenable case.
    The volume stays countable and the declaration stays reviewable.
  * **Never launders into ground truth.** The close writes an ``analyst_policy`` history
    event, deliberately NOT the ``analyst_action`` shape
    ``engine.analyst_outcomes.analyst_confirmed_outcome`` reads — so the automation can
    never train on its own output — and it is excluded from every agent-performance
    statistic so it can never flatter the agent.
  * **#2 — every mutation is audited.** Create / update / enable / disable / delete each
    append an ``ActionType.STATUS`` row with the acting operator.
  * **#9 — rule ids and reasons are PLAIN, length-bounded, operator-supplied strings.**
    They are rendered escaped by the Console. The one that reaches a prompt (the rule
    identity in the precedent block) is UNTRUSTED-fenced at the prompt seam.

Scope: forward-only. A new declaration closes MATCHING CLUSTERS FROM NOW ON; it does not
retro-close cases that are already open (bulk-close those from the Case Manager). Revoke
by disabling, letting ``expires_at`` lapse, or deleting — the next match stops
immediately, and already-closed cases stay closed and reopenable as usual.

RBAC: ``rules:read`` for the read, ``rules:manage`` for every mutation — the same
unified rules-customization grant the detection/correlation/case-automation editors use.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from ..config import AnalystRulePolicy, Preferences
from ..constants import ActionType
from ..engine.precedent import normalize_rule_id
from ..state import AppState
from ..utils import new_id
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.analyst_policy")

router = APIRouter(prefix="/api")

# Bound the operator-authored free text that becomes a durable, operator-visible record.
_MAX_REASON_CHARS = 500
# A deployment with thousands of per-rule declarations is a configuration smell, and the
# whole list is evaluated per cluster. Bound it so that stays cheap and reviewable.
_MAX_POLICIES = 500


def _safe(value: Any) -> str:
    """Plain, length-bounded string for the client (#9) — rendered escaped, never a prompt."""
    return str(value)[:2000]


class _EnabledIn(BaseModel):
    """Enable/disable a declaration.

    Typed on purpose: a raw ``dict`` + ``bool(body.get("enabled"))`` coerces the JSON
    STRING ``"false"`` to True, so a client that sends ``{"enabled": "false"}`` would be
    told the declaration was revoked while it kept closing cases. A missing field would
    silently disable instead of failing.
    """

    enabled: bool


class _PolicyIn(BaseModel):
    """The writable shape. ``id`` comes from the path; provenance is set server-side.

    Every optional field here defaults to the WIDEST blast radius (enabled, unscoped,
    never expiring). Writing those defaults over a prior record would mean a partial edit
    silently re-enables a revoked declaration, clears its expiry, and widens it from one
    source to all of them. So :func:`upsert_analyst_policy` carries prior values forward
    for any field the client did not actually send (``model_fields_set``) — the same
    reason :class:`_EnabledIn` makes ``enabled`` required.
    """

    rule_id: str = Field(min_length=1, max_length=500)
    reason: str = Field(default="", max_length=_MAX_REASON_CHARS)
    source_id: str | None = Field(default=None, max_length=200)
    enabled: bool = True
    max_risk_score: float | None = Field(default=None, ge=0.0, le=100.0)
    expires_at: str | None = None


def _public(policy: AnalystRulePolicy) -> dict[str, Any]:
    """One declaration, as the Console reads it. No secrets exist on this model."""
    return {
        "id": policy.id,
        "rule_id": policy.rule_id,
        "reason": policy.reason,
        "source_id": policy.source_id,
        "enabled": policy.enabled,
        "max_risk_score": policy.max_risk_score,
        "created_by": policy.created_by,
        "created_at": policy.created_at,
        "expires_at": policy.expires_at.isoformat() if policy.expires_at else None,
        # Derived, so a lapsed declaration is visibly inert rather than looking active.
        "live": policy.is_live(),
    }


#: The declaration fields whose change widens or narrows real authority. An audit row
#: that records only the NEW state cannot answer "who widened this, and from what?" —
#: which is exactly the question a re-enabled or scope-widened rule raises.
_AUDITED_FIELDS: tuple[str, ...] = (
    "rule_id", "enabled", "source_id", "max_risk_score", "expires_at", "reason",
)


def _audit_value(policy: AnalystRulePolicy | None, name: str) -> str:
    if policy is None:
        return "-"
    value = getattr(policy, name, None)
    if name == "expires_at":
        return value.isoformat() if value else "never"
    if name == "source_id":
        return str(value or "all_sources")
    if name == "max_risk_score":
        return "unbounded" if value is None else str(value)
    return str(value)


def _describe_change(prior: AnalystRulePolicy | None, current: AnalystRulePolicy) -> str:
    """``field: before -> after`` for every field that actually moved.

    On a create it records the full initial state; on an edit it records only the delta,
    so a widened scope or a re-enabled rule is traceable to the actor and the exact
    change rather than just its end state.
    """
    if prior is None:
        return "created " + " ".join(
            f"{name}={_audit_value(current, name)}" for name in _AUDITED_FIELDS
        )
    moved = [
        f"{name}: {_audit_value(prior, name)} -> {_audit_value(current, name)}"
        for name in _AUDITED_FIELDS
        if _audit_value(prior, name) != _audit_value(current, name)
    ]
    return "changed " + ("; ".join(moved) if moved else "nothing")


async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only operator-lifecycle audit (#2). Best-effort; never breaks the edit."""
    audit = getattr(state, "_real_audit", None) or getattr(state, "audit", None)
    if audit is None:
        return
    try:
        await audit.record(
            action_type=ActionType.STATUS,
            surface="analyst_policy",
            actor=current_username(request) or "",
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass


def _replace(prefs: Preferences, policies: list[AnalystRulePolicy]) -> Preferences:
    return prefs.model_copy(update={"analyst_rule_policies": policies})


@router.get("/rules/analyst-policies")
async def list_analyst_policies(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "read")),
) -> dict[str, Any]:
    """Every operator declaration, with a derived ``live`` flag per row."""
    policies = list(getattr(state.prefs, "analyst_rule_policies", []) or [])
    return {
        "policies": [_public(p) for p in policies],
        "total": len(policies),
        "live": sum(1 for p in policies if p.is_live()),
        "max_policies": _MAX_POLICIES,
    }


@router.put("/rules/analyst-policies/{policy_id}")
async def upsert_analyst_policy(
    policy_id: str,
    body: _PolicyIn,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Create or replace ONE declaration.

    ``policy_id`` of ``new`` mints a server-side id, so a client never has to invent
    one. The rule id is normalised with the SAME function the tuner and precedent
    matcher use, so "the same rule" means one thing everywhere.
    """
    rule_id = normalize_rule_id(body.rule_id)
    if not rule_id:
        raise HTTPException(status_code=400, detail="rule_id must not be blank")

    target_id = policy_id if policy_id and policy_id != "new" else new_id("arp-")
    actor = current_username(request) or ""
    # Read the CURRENT list inside the transform, under the preferences write lock.
    # Reading it beforehand and returning a precomputed replacement discards the fresh
    # `prefs` the lock hands us, so two concurrent edits clobber each other — and the
    # loser can be a REVOCATION, silently resurrecting a declaration an operator
    # believed they had switched off.
    outcome: dict[str, Any] = {}

    def _apply(prefs: Preferences) -> Preferences:
        current = list(getattr(prefs, "analyst_rule_policies", []) or [])
        prior = next((p for p in current if p.id == target_id), None)
        if prior is None and len(current) >= _MAX_POLICIES:
            raise HTTPException(
                status_code=400,
                detail=f"at most {_MAX_POLICIES} analyst rule policies are supported",
            )
        sent = body.model_fields_set

        def _field(name: str, supplied: Any, prior_value: Any) -> Any:
            """The client's value when it SENT one, else the stored value.

            A PUT that omits a field is an edit to the fields it did send, not a request
            to reset everything else to the permissive default.
            """
            if prior is None or name in sent:
                return supplied
            return prior_value

        # Provenance is server-side: a client can never claim another operator authored
        # a declaration, and the original author/creation instant survive an edit.
        fields: dict[str, Any] = {
            "id": target_id,
            "rule_id": rule_id,
            "reason": _field("reason", body.reason, prior.reason if prior else ""),
            "source_id": _field(
                "source_id", (body.source_id or None), prior.source_id if prior else None
            ),
            "enabled": bool(
                _field("enabled", body.enabled, prior.enabled if prior else True)
            ),
            "max_risk_score": _field(
                "max_risk_score",
                body.max_risk_score,
                prior.max_risk_score if prior else None,
            ),
            "created_by": (prior.created_by if prior else actor),
            "expires_at": _field(
                "expires_at", body.expires_at, prior.expires_at if prior else None
            ),
        }
        if prior is not None and prior.created_at:
            fields["created_at"] = prior.created_at
        try:
            policy = AnalystRulePolicy(**fields)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=_safe(exc.errors())) from exc
        outcome["policy"] = policy
        outcome["prior"] = prior
        outcome["created"] = prior is None
        return _replace(prefs, [p for p in current if p.id != target_id] + [policy])

    await state.mutate_prefs(_apply)
    policy = outcome["policy"]
    await _audit(
        state, request,
        "analyst_policy.upsert" if outcome["created"] else "analyst_policy.update",
        f"id={target_id} " + _describe_change(outcome.get("prior"), policy),
    )
    return {"policy": _public(policy), "created": outcome["created"]}


@router.post("/rules/analyst-policies/{policy_id}/enabled")
async def set_analyst_policy_enabled(
    policy_id: str,
    body: _EnabledIn,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Revoke (or restore) a declaration without losing it or its provenance."""
    enabled = body.enabled
    outcome: dict[str, Any] = {}

    def _apply(prefs: Preferences) -> Preferences:
        current = list(getattr(prefs, "analyst_rule_policies", []) or [])
        target = next((p for p in current if p.id == policy_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="analyst rule policy not found")
        updated = [
            (p.model_copy(update={"enabled": enabled}) if p.id == policy_id else p)
            for p in current
        ]
        outcome["policy"] = next(p for p in updated if p.id == policy_id)
        outcome["rule_id"] = target.rule_id
        outcome["was_enabled"] = target.enabled
        return _replace(prefs, updated)

    await state.mutate_prefs(_apply)
    await _audit(
        state, request, "analyst_policy.enabled",
        f"id={policy_id} rule={outcome['rule_id']} "
        f"enabled: {outcome['was_enabled']} -> {enabled}",
    )
    return {"policy": _public(outcome["policy"])}


@router.delete("/rules/analyst-policies/{policy_id}")
async def delete_analyst_policy(
    policy_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Delete a declaration. Cases it already closed stay closed (and reopenable)."""
    outcome: dict[str, Any] = {}

    def _apply(prefs: Preferences) -> Preferences:
        current = list(getattr(prefs, "analyst_rule_policies", []) or [])
        target = next((p for p in current if p.id == policy_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="analyst rule policy not found")
        outcome["rule_id"] = target.rule_id
        outcome["deleted_state"] = " ".join(
            f"{name}={_audit_value(target, name)}" for name in _AUDITED_FIELDS
        )
        return _replace(prefs, [p for p in current if p.id != policy_id])

    await state.mutate_prefs(_apply)
    await _audit(
        state, request, "analyst_policy.delete",
        f"id={policy_id} deleted {outcome['deleted_state']}",
    )
    return {"deleted": 1, "id": policy_id}
