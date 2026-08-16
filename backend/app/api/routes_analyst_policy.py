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
    """The writable shape. ``id`` comes from the path; provenance is set server-side."""

    rule_id: str = Field(min_length=1, max_length=500)
    reason: str = Field(default="", max_length=_MAX_REASON_CHARS)
    source_id: str | None = Field(default=None, max_length=200)
    enabled: bool = True
    expires_at: str | None = None


def _public(policy: AnalystRulePolicy) -> dict[str, Any]:
    """One declaration, as the Console reads it. No secrets exist on this model."""
    return {
        "id": policy.id,
        "rule_id": policy.rule_id,
        "reason": policy.reason,
        "source_id": policy.source_id,
        "enabled": policy.enabled,
        "created_by": policy.created_by,
        "created_at": policy.created_at,
        "expires_at": policy.expires_at.isoformat() if policy.expires_at else None,
        # Derived, so a lapsed declaration is visibly inert rather than looking active.
        "live": policy.is_live(),
    }


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
        # Provenance is server-side: a client can never claim another operator authored
        # a declaration, and the original author/creation instant survive an edit.
        fields: dict[str, Any] = {
            "id": target_id,
            "rule_id": rule_id,
            "reason": body.reason,
            "source_id": (body.source_id or None),
            "enabled": bool(body.enabled),
            "created_by": (prior.created_by if prior else actor),
            "expires_at": body.expires_at,
        }
        if prior is not None and prior.created_at:
            fields["created_at"] = prior.created_at
        try:
            policy = AnalystRulePolicy(**fields)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=_safe(exc.errors())) from exc
        outcome["policy"] = policy
        outcome["created"] = prior is None
        return _replace(prefs, [p for p in current if p.id != target_id] + [policy])

    await state.mutate_prefs(_apply)
    policy = outcome["policy"]
    await _audit(
        state, request,
        "analyst_policy.upsert" if outcome["created"] else "analyst_policy.update",
        f"id={target_id} rule={rule_id} enabled={policy.enabled} "
        f"scope={policy.source_id or 'all_sources'}",
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
        return _replace(prefs, updated)

    await state.mutate_prefs(_apply)
    await _audit(
        state, request, "analyst_policy.enabled",
        f"id={policy_id} rule={outcome['rule_id']} enabled={enabled}",
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
        return _replace(prefs, [p for p in current if p.id != policy_id])

    await state.mutate_prefs(_apply)
    await _audit(
        state, request, "analyst_policy.delete",
        f"id={policy_id} rule={outcome['rule_id']}",
    )
    return {"deleted": 1, "id": policy_id}
