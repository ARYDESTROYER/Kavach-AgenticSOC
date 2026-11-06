"""Rules-customization API — Round 5 / G6 (RB task).

A SEPARATE feature router (the integrator mounts it with the same ``require_auth``
mount the monolith uses). It exposes the RICH rule config the engine already reads —
detection rules (:class:`app.config.RuleDefinition`, the ``rule_catalog``),
correlation/threshold rules (:class:`app.config.CorrelationRule`, the
``correlation_rules`` map), and case-automation rules
(:class:`app.config.CaseAutomationRule`, the ``threshold_automation.rules`` list) — as
first-class CRUD, plus an immutable per-rule VERSION ledger with one-click rollback and
a READ-ONLY rule-scoped PREVIEW over recent data.

⚠ HARD INVARIANTS (the reason this router exists as config-writers, not a parallel
engine):

  * **#3 — the editors are CONFIG WRITERS.** Every mutation deep-MERGEs the changed
    rule into ``Preferences`` via ``update_prefs`` (never a full-doc replace, never a
    sibling-block wipe). NOTHING here imports or calls ``case_manager.decide()``, sets a
    case ``status``/``disposition``/``verdict``, or recomputes a ``cluster_signature``.
    A case-automation rule is HITL-safe by construction (it can only tag/recommend/
    notify/run_playbook/request_approval — the engine enforces it never sets status).
    Since Round 14 ``run_playbook`` keeps its stored name and ATTACHES a runbook to the
    case (the Rule editor shows it as "Attach a runbook"); the target is resolved at
    fire time and a run never changes the verdict, the status or ``decide()``.
  * **#6 — the PREVIEW never bills the LLM.** It reads recent events through the scoped
    read-only key (hard-capped, exactly the ``GET /api/logs`` scatter-gather path),
    evaluates the pure ``RuleMatch.matches()`` predicate in-process, and returns match
    counts / a histogram. ZERO gateway calls → ZERO ``UsageDoc`` writes. It NEVER calls
    ``decide()``, NEVER creates a case, NEVER escalates.
  * **#2 — every lifecycle event is audited + versioned.** create / update / enable /
    disable / delete / rollback each write an append-only ``ActionType.STATUS`` audit
    row AND an immutable :class:`app.stores.rule_versions.RuleVersion` snapshot of the
    WHOLE rule config, so history + attribution + rollback are verifiable. Round 14
    (SPEC §3.6): the audit row (``rule.created``, ``rule.updated``, ``rule.enabled``,
    ``rule.disabled``, ``rule.deleted``, ``rule.rolled_back``, with the changed fields)
    is appended BEFORE the rule is saved; a failed append answers ``503
    audit_unavailable`` and nothing changes.
  * **#9 — every rule id / name / field / value returned is PLAIN, length-bounded,
    attacker-influenceable data.** The UI renders it escaped; it is never fed back into a
    prompt or interpolated into ES DSL by string concat.
  * **#10 — secrets are booleans.** Rule configs carry NO secrets; nothing here echoes a
    key. (Model overrides on a detection rule carry only routing config, no key.)

  * **Bug #6 fix.** A case-automation rule's ``conditions["verdict"]`` may ONLY be a real
    :class:`app.constants.Verdict` (``FALSE_POSITIVE`` / ``TRUE_POSITIVE`` /
    ``NEEDS_HUMAN``). ``suspicious`` / ``benign`` are DISPOSITIONS, not verdicts — a rule
    that stored one could never fire. On write we REJECT an impossible verdict; on read
    we surface the offending value so the UI can migrate it.

RBAC: the whole surface is gated by the unified ``rules`` grant (G6 R9) — ``rules:read``
for the reads, ``rules:manage`` for every mutation. The preview reads events, so it
additionally is bounded by ``sources:read`` scoping upstream.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from ..audit.context import audit_context
from ..audit.settings_write import audited_settings_write
from ..config import (
    CaseAutomationRule,
    CorrelationRule,
    Preferences,
    RuleDefinition,
)
from ..constants import ActionType, SourceType, Verdict
from ..models import AuditTarget
from ..state import AppState
from ..stores.rule_versions import RuleKind
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.rules")

router = APIRouter(prefix="/api")

# The real Verdict values a case-automation ``conditions.verdict`` may take (bug #6).
# ``suspicious``/``benign`` are Dispositions, NOT verdicts — a rule storing one can
# never match a case, so we reject it on write and flag it on read.
#
# CASE-INSENSITIVE membership (bug #6 fix). The engine matcher
# (``threshold_automation._rule_matches``) ``.upper()``s BOTH sides, so a rule stored as
# ``false_positive`` (what both editors emit — ``constants.ts:132``, ``automation.tsx``)
# fires exactly like ``FALSE_POSITIVE``. Both are therefore VALID. We keep the canonical
# (uppercase enum) values for display + the migration flag, and compare case-folded so
# the router's own CRUD path accepts the lowercase verdicts the UI actually sends.
_VALID_VERDICTS: frozenset[str] = frozenset(v.value for v in Verdict)
_VALID_VERDICTS_UPPER: frozenset[str] = frozenset(v.value.upper() for v in Verdict)


def _is_valid_verdict(verdict: Any) -> bool:
    """True iff ``verdict`` names a real :class:`Verdict`, CASE-INSENSITIVELY (mirrors
    the engine matcher, which ``.upper()``s both sides). ``suspicious``/``benign`` are
    Dispositions → never a Verdict → False regardless of case."""
    return str(verdict).upper() in _VALID_VERDICTS_UPPER


class _EnabledIn(BaseModel):
    """Enable/disable a rule (a lifecycle toggle body)."""

    enabled: bool


def _safe(value: Any) -> str:
    """Plain, length-bounded string for the client (#9): the UI renders it escaped and
    it is never fed back into a prompt. Bounds a runaway error body / rule name."""
    return str(value)[:2000]


# --------------------------------------------------------------------------- #
# Helpers — the deep-MERGE config-writer discipline (#3 / deep-merge PUT).
# --------------------------------------------------------------------------- #
async def _write_rule(
    state: AppState,
    request: Request,
    transform: Callable[[Preferences], Preferences],
    *,
    action: str | Callable[[], str],
    kind: str,
    rule_id: str,
    label: str = "",
    summary: Callable[[], str],
    failure: str | None = None,
) -> Preferences:
    """Atomically layer one rule mutation onto the freshest Preferences document,
    audited BEFORE it is saved (#2, Round 14 SPEC §3.6).

    The ``rule.*`` row (``ActionType.STATUS``, surface ``rules``, the rule as target and
    every changed field of the rule as ``changes``) is appended to the real audit log
    first; a failed append answers ``503 audit_unavailable`` and nothing is saved. The
    save then holds the application-wide preferences write lock across read, transform
    and save (``AppState.mutate_prefs``), as a compare-and-swap on the recorded change
    set, so concurrent rule, settings, source or tuner edits can neither clobber a
    sibling block nor make the row untrue. ``transform`` is synchronous and pure; an
    ``HTTPException`` it raises (an unknown rule) writes no row. ``action`` and
    ``summary`` are read after the edit ran, so they can use what it found (a rule that
    did or did not exist). Rules are real tenant state, so the row always goes to the
    real audit log (SPEC §3.5)."""
    _before, after = await audited_settings_write(
        state, transform=transform, action=action,
        actor=current_username(request) or "", context=audit_context(request),
        summary=lambda _changes, _total: summary()[:500],
        action_type=ActionType.STATUS, surface="rules",
        # Built after the edit ran, so a blank or unknown rule is refused (404) first.
        target=lambda _changes: AuditTarget(type="rule", id=rule_id, label=label or rule_id),
        tool_input={"kind": kind},
        failure=failure,
    )
    return after


async def _version(
    state: AppState,
    request: Request,
    *,
    kind: RuleKind,
    rule_id: str,
    config: dict[str, Any],
    action: str,
    summary: str = "",
    rolled_back_to: str | None = None,
) -> None:
    """Append an immutable version snapshot of the WHOLE rule config (#2 / G6 R5).
    Best-effort; a versioning glitch never breaks the edit itself."""
    store = getattr(state, "rule_versions", None)
    if store is None:
        return
    try:
        await store.record(
            kind=kind, rule_id=rule_id, config=config, action=action,
            actor=current_username(request) or "", summary=summary,
            rolled_back_to=rolled_back_to,
        )
    except Exception:  # noqa: BLE001
        pass


def _automation_label(rule: CaseAutomationRule) -> str:
    """A case-automation rule's display name for its audit target (its name when it has
    one, else its id)."""
    return str(getattr(rule, "name", "") or rule.id or "")


def _validate_automation_verdict(rule: CaseAutomationRule) -> None:
    """Bug #6: reject a case-automation rule whose ``conditions.verdict`` is not a real
    :class:`Verdict`. ``suspicious``/``benign`` are Dispositions and could never fire —
    fail loudly (400) rather than silently persisting a dead rule."""
    verdict = (rule.conditions or {}).get("verdict")
    if verdict is None:
        return
    if not _is_valid_verdict(verdict):  # case-insensitive (mirrors the engine matcher)
        raise HTTPException(
            status_code=400,
            detail=(
                f"invalid automation verdict {_safe(verdict)!r}: must be one of "
                f"{sorted(_VALID_VERDICTS)} (suspicious/benign are dispositions, "
                "not verdicts, and could never match a case)"
            ),
        )


# --------------------------------------------------------------------------- #
# GET /api/rules — the rules-management home (all three families, plus a bug-#6
# migration flag on any impossible-verdict case-automation rule).
# --------------------------------------------------------------------------- #
@router.get("/rules")
async def list_rules(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "read")),
) -> dict[str, Any]:
    """Every rule across the three families the engine reads, as PLAIN JSON (#9).

    * ``detection``    — ``Preferences.rule_catalog`` (:class:`RuleDefinition`).
    * ``correlation``  — ``Preferences.correlation_rules`` (:class:`CorrelationRule`),
                         keyed by rule name; plus the ``default_correlation``.
    * ``case_automation`` — ``Preferences.threshold_automation.rules``
                         (:class:`CaseAutomationRule`), each flagged with
                         ``invalid_verdict`` when it carries an impossible verdict
                         (bug #6 migration signal for the UI)."""
    prefs = state.prefs
    detection = [rd.model_dump(mode="json") for rd in (prefs.rule_catalog or [])]
    correlation = {
        name: rule.model_dump(mode="json")
        for name, rule in (prefs.correlation_rules or {}).items()
    }
    automation_cfg = getattr(prefs, "threshold_automation", None)
    automation_rules = list(getattr(automation_cfg, "rules", []) or [])
    case_automation: list[dict[str, Any]] = []
    for r in automation_rules:
        row = r.model_dump(mode="json")
        verdict = (r.conditions or {}).get("verdict")
        # Case-insensitive (bug #6): a lowercase ``false_positive`` (what the UI emits)
        # is a REAL verdict, not "invalid" — only a true Disposition trips this flag.
        row["invalid_verdict"] = verdict is not None and not _is_valid_verdict(verdict)
        case_automation.append(row)
    return {
        "detection": detection,
        "correlation": correlation,
        "default_correlation": prefs.default_correlation.model_dump(mode="json"),
        "case_automation": case_automation,
        "automation_enabled": bool(getattr(automation_cfg, "enabled", False)),
        # Canonical (enum-case) verdicts for display. Verdict matching is CASE-INSENSITIVE
        # (bug #6) — a rule may store either case and fire identically. ``valid_verdicts``
        # keeps the historical uppercase form; ``valid_verdicts_lower`` is the same set in
        # the case the editors emit (``true_positive``/``false_positive``/``needs_human``,
        # ``constants.ts:132``) so the UI need not case-fold.
        "valid_verdicts": sorted(_VALID_VERDICTS),
        "valid_verdicts_lower": sorted(v.lower() for v in _VALID_VERDICTS),
    }


# --------------------------------------------------------------------------- #
# Detection rules (rule_catalog / RuleDefinition) — CRUD (deep-merge, #3).
# --------------------------------------------------------------------------- #
@router.put("/rules/detection/{rule_name}")
async def upsert_detection_rule(
    rule_name: str,
    body: RuleDefinition,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Create or update ONE detection rule by name (deep-MERGE: only this rule's slot in
    ``rule_catalog`` changes; every OTHER rule + every sibling ``Preferences`` block is
    preserved). Validated by the ``RuleDefinition`` model. Config-writer only — never
    calls ``decide()`` (#3). Audited + versioned (#2)."""
    name = (rule_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="rule_name is required")
    # Force the URL name to be authoritative (the body name is advisory).
    incoming = body.model_copy(update={"name": name})
    existed = False

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal existed
        # Decided afresh on every run: the audited write runs this edit again on the
        # stored document when another save moved it, and the action, the summary and
        # the response must describe the document this run edited (a rule deleted in
        # between is created again, as rule.created).
        existed = False
        catalog = list(prefs.rule_catalog or [])
        for idx, rd in enumerate(catalog):
            if rd.name == name:
                catalog[idx] = incoming
                existed = True
                break
        if not existed:
            catalog.append(incoming)
        return prefs.model_copy(update={"rule_catalog": catalog})

    await _write_rule(
        state, request, _apply, kind="detection", rule_id=name,
        action=lambda: "rule.updated" if existed else "rule.created",
        summary=lambda: (
            f"detection_{'update' if existed else 'create'}: "
            f"name={name} enabled={incoming.enabled} priority={incoming.priority}"
        ),
    )
    action = "update" if existed else "create"
    await _version(state, request, kind="detection", rule_id=name,
                   config=incoming.model_dump(mode="json"), action=action,
                   summary=f"{action} detection rule {name}")
    return {"ok": True, "created": not existed, "rule": incoming.model_dump(mode="json")}


@router.post("/rules/detection/{rule_name}/enabled")
async def set_detection_enabled(
    rule_name: str,
    body: _EnabledIn,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Enable/disable ONE detection rule (a lifecycle toggle, deep-merge). 404 for an
    unknown rule. Audited + versioned (#2). Config-writer only (#3)."""
    name = (rule_name or "").strip()
    updated: RuleDefinition | None = None

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal updated
        catalog = list(prefs.rule_catalog or [])
        for idx, rd in enumerate(catalog):
            if rd.name == name:
                updated = rd.model_copy(update={"enabled": bool(body.enabled)})
                catalog[idx] = updated
                return prefs.model_copy(update={"rule_catalog": catalog})
        raise HTTPException(status_code=404, detail=f"detection rule {_safe(name)} not found")

    action = "enable" if body.enabled else "disable"
    await _write_rule(
        state, request, _apply, kind="detection", rule_id=name,
        action="rule.enabled" if body.enabled else "rule.disabled",
        summary=lambda: f"detection_{action}: name={name}",
    )
    assert updated is not None
    await _version(state, request, kind="detection", rule_id=name,
                   config=updated.model_dump(mode="json"), action=action,
                   summary=f"{action} detection rule {name}")
    return {"ok": True, "rule": updated.model_dump(mode="json")}


@router.delete("/rules/detection/{rule_name}")
async def delete_detection_rule(
    rule_name: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Delete ONE detection rule (deep-merge: only its slot is removed). 404 for an
    unknown rule. Audited + versioned with the pre-delete snapshot (#2)."""
    name = (rule_name or "").strip()
    removed: RuleDefinition | None = None

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal removed
        catalog = list(prefs.rule_catalog or [])
        for idx, rd in enumerate(catalog):
            if rd.name == name:
                removed = catalog.pop(idx)
                return prefs.model_copy(update={"rule_catalog": catalog})
        raise HTTPException(status_code=404, detail=f"detection rule {_safe(name)} not found")

    await _write_rule(
        state, request, _apply, kind="detection", rule_id=name, action="rule.deleted",
        summary=lambda: f"detection_delete: name={name}",
    )
    assert removed is not None
    await _version(state, request, kind="detection", rule_id=name,
                   config=removed.model_dump(mode="json"), action="delete",
                   summary=f"delete detection rule {name}")
    return {"ok": True, "deleted": name}


# --------------------------------------------------------------------------- #
# Correlation / threshold rules (correlation_rules) — CRUD (deep-merge, #3).
# --------------------------------------------------------------------------- #
@router.put("/rules/correlation/{rule_key}")
async def upsert_correlation_rule(
    rule_key: str,
    body: CorrelationRule,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Create or update ONE correlation/threshold rule keyed by rule name (deep-MERGE:
    only this key in the ``correlation_rules`` map changes; every OTHER key + sibling
    block is preserved). Validated by ``CorrelationRule`` (``n>=1``, ``window>=1``).
    Editing ``n``/``window``/``group_by`` changes case FORMATION going forward — it does
    NOT retroactively re-key open cases (#4). Config-writer only (#3). Audited +
    versioned (#2)."""
    key = (rule_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="rule_key is required")
    existed = False

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal existed
        rules = dict(prefs.correlation_rules or {})
        existed = key in rules
        rules[key] = body
        return prefs.model_copy(update={"correlation_rules": rules})

    await _write_rule(
        state, request, _apply, kind="correlation", rule_id=key,
        action=lambda: "rule.updated" if existed else "rule.created",
        summary=lambda: (
            f"correlation_{'update' if existed else 'create'}: "
            f"key={key} n={body.n} window={body.window_seconds} "
            f"group_by={body.group_by.value} mode={body.mode.value}"
        ),
    )
    action = "update" if existed else "create"
    await _version(state, request, kind="correlation", rule_id=key,
                   config=body.model_dump(mode="json"), action=action,
                   summary=f"{action} correlation rule {key}")
    return {"ok": True, "created": not existed, "rule": body.model_dump(mode="json")}


@router.delete("/rules/correlation/{rule_key}")
async def delete_correlation_rule(
    rule_key: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Delete ONE correlation rule (the rule falls back to ``default_correlation``
    thereafter). 404 for an unknown key. Audited + versioned (#2)."""
    key = (rule_key or "").strip()
    removed: CorrelationRule | None = None

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal removed
        rules = dict(prefs.correlation_rules or {})
        if key not in rules:
            raise HTTPException(status_code=404, detail=f"correlation rule {_safe(key)} not found")
        removed = rules.pop(key)
        return prefs.model_copy(update={"correlation_rules": rules})

    await _write_rule(
        state, request, _apply, kind="correlation", rule_id=key, action="rule.deleted",
        summary=lambda: f"correlation_delete: key={key}",
    )
    assert removed is not None
    await _version(state, request, kind="correlation", rule_id=key,
                   config=removed.model_dump(mode="json"), action="delete",
                   summary=f"delete correlation rule {key}")
    return {"ok": True, "deleted": key}


# --------------------------------------------------------------------------- #
# Case-automation rules (threshold_automation.rules) — CRUD (HITL-safe, #3, bug #6).
# --------------------------------------------------------------------------- #
@router.put("/rules/case-automation/{rule_id}")
async def upsert_case_automation_rule(
    rule_id: str,
    body: CaseAutomationRule,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Create or update ONE case-automation rule by id (deep-MERGE: only this rule's
    slot in ``threshold_automation.rules`` changes; the ``enabled`` flag + every OTHER
    rule are preserved).

    HITL-SAFE by construction (#3): a case-automation rule can only
    ``tag``/``recommend``/``notify``/``run_playbook``/``request_approval`` — the engine
    enforces it NEVER sets a case ``status``/``disposition``. ``run_playbook`` attaches
    the runbook named by ``payload.runbook_id`` (or a legacy ``payload.playbook_id``,
    resolved at fire time; Round 14). Bug #6: a
    ``conditions.verdict`` that is not a real :class:`Verdict` is REJECTED here (400).
    Config-writer only. Audited + versioned (#2)."""
    rid = (rule_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="rule_id is required")
    incoming = body.model_copy(update={"id": rid})
    _validate_automation_verdict(incoming)  # bug #6
    existed = False

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal existed
        existed = False  # decided afresh on every run (see the detection upsert)
        cfg = getattr(prefs, "threshold_automation", None)
        if cfg is None:
            from ..config import ThresholdAutomationConfig
            cfg = ThresholdAutomationConfig()
        rules = list(cfg.rules or [])
        for idx, rule in enumerate(rules):
            if rule.id == rid:
                rules[idx] = incoming
                existed = True
                break
        if not existed:
            rules.append(incoming)
        return prefs.model_copy(update={
            "threshold_automation": cfg.model_copy(update={"rules": rules}),
        })

    await _write_rule(
        state, request, _apply, kind="case_automation", rule_id=rid,
        label=_automation_label(incoming),
        action=lambda: "rule.updated" if existed else "rule.created",
        summary=lambda: (
            f"case_automation_{'update' if existed else 'create'}: "
            f"id={rid} action={incoming.action} enabled={incoming.enabled}"
        ),
    )
    action = "update" if existed else "create"
    await _version(state, request, kind="case_automation", rule_id=rid,
                   config=incoming.model_dump(mode="json"), action=action,
                   summary=f"{action} case-automation rule {rid}")
    return {"ok": True, "created": not existed, "rule": incoming.model_dump(mode="json")}


@router.post("/rules/case-automation/{rule_id}/enabled")
async def set_case_automation_enabled(
    rule_id: str,
    body: _EnabledIn,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Enable/disable ONE case-automation rule (lifecycle toggle, deep-merge). 404 for
    an unknown id. Audited + versioned (#2). Config-writer only (#3)."""
    rid = (rule_id or "").strip()
    updated: CaseAutomationRule | None = None

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal updated
        cfg = getattr(prefs, "threshold_automation", None)
        rules = list(getattr(cfg, "rules", []) or [])
        for idx, rule in enumerate(rules):
            if rule.id == rid:
                updated = rule.model_copy(update={"enabled": bool(body.enabled)})
                rules[idx] = updated
                return prefs.model_copy(update={
                    "threshold_automation": cfg.model_copy(update={"rules": rules}),
                })
        raise HTTPException(status_code=404, detail=f"case-automation rule {_safe(rid)} not found")

    action = "enable" if body.enabled else "disable"
    await _write_rule(
        state, request, _apply, kind="case_automation", rule_id=rid,
        action="rule.enabled" if body.enabled else "rule.disabled",
        summary=lambda: f"case_automation_{action}: id={rid}",
    )
    assert updated is not None
    await _version(state, request, kind="case_automation", rule_id=rid,
                   config=updated.model_dump(mode="json"), action=action,
                   summary=f"{action} case-automation rule {rid}")
    return {"ok": True, "rule": updated.model_dump(mode="json")}


@router.delete("/rules/case-automation/{rule_id}")
async def delete_case_automation_rule(
    rule_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Delete ONE case-automation rule (deep-merge). 404 for an unknown id. Audited +
    versioned with the pre-delete snapshot (#2)."""
    rid = (rule_id or "").strip()
    removed: CaseAutomationRule | None = None

    def _apply(prefs: Preferences) -> Preferences:
        nonlocal removed
        cfg = getattr(prefs, "threshold_automation", None)
        rules = list(getattr(cfg, "rules", []) or [])
        for idx, rule in enumerate(rules):
            if rule.id == rid:
                removed = rules.pop(idx)
                return prefs.model_copy(update={
                    "threshold_automation": cfg.model_copy(update={"rules": rules}),
                })
        raise HTTPException(status_code=404, detail=f"case-automation rule {_safe(rid)} not found")

    await _write_rule(
        state, request, _apply, kind="case_automation", rule_id=rid, action="rule.deleted",
        summary=lambda: f"case_automation_delete: id={rid}",
    )
    assert removed is not None
    await _version(state, request, kind="case_automation", rule_id=rid,
                   config=removed.model_dump(mode="json"), action="delete",
                   summary=f"delete case-automation rule {rid}")
    return {"ok": True, "deleted": rid}


# --------------------------------------------------------------------------- #
# Version ledger — list + one-click rollback (G6 R5, #2 append-only).
# --------------------------------------------------------------------------- #
@router.get("/rules/{kind}/{rule_id}/versions")
async def list_rule_versions(
    kind: str,
    rule_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "read")),
) -> dict[str, Any]:
    """The immutable version history for ONE rule, NEWEST first (the History drawer).
    ``kind`` is ``detection`` | ``correlation`` | ``case_automation``. Each version is a
    full plain-JSON snapshot of the rule config at that point + who/when/why (#9)."""
    store = getattr(state, "rule_versions", None)
    if store is None:
        return {"versions": [], "kind": _safe(kind), "rule_id": _safe(rule_id)}
    versions = await store.list(kind=kind, rule_id=rule_id)
    return {
        "kind": _safe(kind),
        "rule_id": _safe(rule_id),
        "versions": [v.to_json() for v in versions],
    }


@router.post("/rules/{kind}/{rule_id}/rollback/{version_id}")
async def rollback_rule(
    kind: str,
    rule_id: str,
    version_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "manage")),
) -> dict[str, Any]:
    """Restore a rule to a prior version's WHOLE config (one-click rollback, G6 R5).

    Restoring re-materialises the snapshot's config into the live rule collection via
    the SAME deep-merge config-writer path a normal edit uses (never a full-doc replace),
    then APPENDS a new ``rollback`` version to the ledger pointing at the restored id —
    history is append-only, never mutated (#2). 404 for an unknown / mismatched version.
    Config-writer only — never calls ``decide()`` (#3)."""
    store = getattr(state, "rule_versions", None)
    if store is None:
        raise HTTPException(status_code=503, detail="version ledger unavailable")
    version = await store.get(version_id)
    if version is None or version.kind != kind or version.rule_id != rule_id:
        raise HTTPException(
            status_code=404,
            detail=f"no version {_safe(version_id)} for {_safe(kind)} rule {_safe(rule_id)}",
        )
    config = version.config or {}
    try:
        if kind == "detection":
            restored = RuleDefinition.model_validate({**config, "name": rule_id})

            def _apply_detection(prefs: Preferences) -> Preferences:
                catalog = [rd for rd in (prefs.rule_catalog or []) if rd.name != rule_id]
                catalog.append(restored)
                return prefs.model_copy(update={"rule_catalog": catalog})

            await _write_rule(
                state, request, _apply_detection, kind=kind, rule_id=rule_id,
                action="rule.rolled_back", failure="rule.rollback_failed",
                summary=lambda: f"rollback: kind={kind} rule={rule_id} to_version={version_id}",
            )
            restored_json = restored.model_dump(mode="json")
        elif kind == "correlation":
            restored_c = CorrelationRule.model_validate(config)

            def _apply_correlation(prefs: Preferences) -> Preferences:
                rules = dict(prefs.correlation_rules or {})
                rules[rule_id] = restored_c
                return prefs.model_copy(update={"correlation_rules": rules})

            await _write_rule(
                state, request, _apply_correlation, kind=kind, rule_id=rule_id,
                action="rule.rolled_back", failure="rule.rollback_failed",
                summary=lambda: f"rollback: kind={kind} rule={rule_id} to_version={version_id}",
            )
            restored_json = restored_c.model_dump(mode="json")
        elif kind == "case_automation":
            restored_a = CaseAutomationRule.model_validate({**config, "id": rule_id})
            _validate_automation_verdict(restored_a)  # never restore an impossible verdict

            def _apply_automation(prefs: Preferences) -> Preferences:
                cfg = getattr(prefs, "threshold_automation", None)
                if cfg is None:
                    from ..config import ThresholdAutomationConfig
                    cfg = ThresholdAutomationConfig()
                arules = [r for r in (cfg.rules or []) if r.id != rule_id]
                arules.append(restored_a)
                return prefs.model_copy(update={
                    "threshold_automation": cfg.model_copy(update={"rules": arules}),
                })

            await _write_rule(
                state, request, _apply_automation, kind=kind, rule_id=rule_id,
                label=_automation_label(restored_a), action="rule.rolled_back",
                failure="rule.rollback_failed",
                summary=lambda: f"rollback: kind={kind} rule={rule_id} to_version={version_id}",
            )
            restored_json = restored_a.model_dump(mode="json")
        else:
            raise HTTPException(status_code=400, detail=f"unknown rule kind {_safe(kind)}")
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"stored version is invalid: {_safe(exc)}") from exc

    await _version(
        state, request, kind=kind, rule_id=rule_id, config=restored_json,
        action="rollback", rolled_back_to=version_id,
        summary=f"rollback {kind} rule {rule_id} to {version_id}",
    )
    return {"ok": True, "kind": _safe(kind), "rule_id": _safe(rule_id),
            "restored_from": _safe(version_id), "rule": restored_json}


# --------------------------------------------------------------------------- #
# Rule-scoped PREVIEW — read-only match-count / histogram over recent data.
# NEVER calls decide() (#3), NEVER bills the LLM (#6, zero UsageDoc), hard-capped.
# --------------------------------------------------------------------------- #
class _PreviewIn(BaseModel):
    """What-if inputs for a read-only detection-rule preview.

    ``match`` is the same flat predicate list a detection rule carries
    (:class:`app.config.RuleMatch`); the preview reads recent events through the scoped
    RO key and counts how many WOULD have matched — it NEVER creates a case, NEVER
    escalates, NEVER calls ``decide()``, NEVER bills the LLM (#6). The window + result
    count are hard-capped exactly like ``GET /api/logs``."""

    match: list[dict[str, Any]] = Field(default_factory=list)
    source_id: str | None = None       # scope to one source; None = all browse-capable
    # P1: hard-capped at the SAME 200-row ceiling ``GET /api/logs`` uses
    # (``min(limit or 100, 200)``) so the preview is a byte-for-byte-parity read-only
    # scatter-gather, never a larger read than the audited logs surface (#1/#6).
    limit: int = Field(default=200, ge=1, le=200)
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    bucket_minutes: int = Field(default=60, ge=1, le=1440)  # histogram bucket width

    model_config = {"populate_by_name": True}


@router.post("/rules/preview")
async def preview_rule(
    body: _PreviewIn,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rules", "read")),
) -> dict[str, Any]:
    """Read-only rule-scoped preview: how many recent events WOULD this predicate match?

    Reads recent events through the SAME scoped, read-only, hard-capped scatter-gather
    the ``GET /api/logs`` path uses (#1), evaluates the pure ``RuleMatch.matches()``
    predicate in-process, and returns a total match count + a time-bucketed histogram +
    a small sample of matched rows (plain log data, #9).

    ⛔ Read-only + side-effect-free (#3/#6/#2):
      * NEVER bills the LLM — no gateway call, so ZERO ``UsageDoc`` writes.
      * NEVER calls / re-implements ``decide()``; NEVER creates a case; NEVER escalates.
      * NEVER writes config or any store.

    A malformed predicate row is skipped leniently. An empty ``match`` matches nothing
    (returns count 0) rather than everything — a preview must never imply a rule fires on
    all traffic. RBAC: ``rules:read``.

    ⚠ MULTI-ROW PARITY (M3). The save adapter (``adapter.ts detectionMatchToWire``) keeps
    ONLY the FIRST predicate row — ``RuleDefinition.match`` is a single ``RuleMatch``, and
    nested AND/OR is the gated Phase-3 wave. So the preview MUST evaluate the SAME first
    row the deployed rule fires on; ANDing every row here would under-count vs. reality
    and mis-calibrate the operator. We therefore evaluate ``predicates[0]`` only, and
    return ``predicates`` (the total supplied) + ``predicates_evaluated`` (always ≤ 1) so
    the UI can label a multi-row preview "only the first condition is saved / previewed"."""
    from ..config import RuleMatch

    # Build the predicate list defensively (skip malformed rows; #9 values stay plain).
    predicates: list[RuleMatch] = []
    for raw in (body.match or []):
        try:
            predicates.append(RuleMatch.model_validate(raw))
        except ValidationError:
            continue  # skip a malformed row rather than 400 the whole preview

    # M3: match ONLY the first predicate row — exactly what the adapter deploys. (Nested
    # AND/OR is deferred; ANDing every row here would diverge from the saved rule.)
    active = predicates[0] if predicates else None

    rows = await _read_recent_events(state, body)
    scanned = len(rows)

    matched: list[dict[str, Any]] = []
    if active is not None:  # no predicate → matches nothing (never "all traffic")
        for row in rows:
            src = row.get("_raw") if isinstance(row.get("_raw"), dict) else row
            if active.matches(src):
                matched.append(row)

    histogram = _bucket_histogram(matched, body.bucket_minutes)
    return {
        "scanned": scanned,
        "matched": len(matched),
        "match_rate": round(len(matched) / scanned, 4) if scanned else 0.0,
        "histogram": histogram,
        # A small plain-data sample for the UI (never the full set; log data only, #9).
        "sample": [_preview_row(r) for r in matched[:25]],
        "predicates": len(predicates),
        # How many rows the preview ACTUALLY evaluated (≤1 until nested AND/OR ships) — so
        # the UI can note that additional rows are neither saved nor previewed (M3).
        "predicates_evaluated": 1 if active is not None else 0,
        "hard_capped": scanned >= body.limit,
    }


async def _read_recent_events(state: AppState, body: _PreviewIn) -> list[dict[str, Any]]:
    """Scatter-gather recent events across enabled, browse-capable sources through the
    SCOPED READ-ONLY key (#1), hard-capped. Mirrors the ``GET /api/logs`` read path but
    returns the raw ``_log_row`` shape (so ``_raw`` is available for predicate eval).
    Resilient: one slow/failing source degrades to nothing, never blocks the rest. NEVER
    calls the LLM / ``decide()``."""
    import asyncio

    from ..connectors.base import StructuredQuery
    from ..connectors.elastic import ElasticConnector
    from ..connectors.opensearch import OpenSearchConnector
    from ..connectors.registry import get_registry
    from ..connectors.wazuh import WazuhConnector
    from .routes import _log_row, _source_can_browse

    limit = int(body.limit)
    reg = get_registry()

    async def _read_pull(src) -> list[dict[str, Any]]:
        es_client, owned = state.es_client_for_source(src)
        try:
            if src.source_type == SourceType.OPENSEARCH:
                conn = OpenSearchConnector(es_client, config=src.config, connector_id=src.id)
            elif src.source_type == SourceType.WAZUH:
                conn = WazuhConnector(es_client, config=src.config, connector_id=src.id)
            else:
                conn = ElasticConnector(es_client, config=src.config, connector_id=src.id)
            sq = StructuredQuery(time_from=body.from_, time_to=body.to, size=limit, sort_desc=True)
            result = await conn.search(state.prefs, sq)
            return [_log_row(ev) for ev in result.events]
        finally:
            if owned:
                try:
                    await es_client.close()
                except Exception:  # noqa: BLE001
                    pass

    async def _read_push(src) -> list[dict[str, Any]]:
        return [_log_row(ev)
                for ev in state.ingest_service.recent_events_for_source(src.id, limit)]

    targets: list[Any] = []
    for src in state.prefs.sources:
        if not src.enabled or not _source_can_browse(reg, src):
            continue
        if body.source_id and src.id != body.source_id:
            continue
        cls = reg.get(src.source_type)
        if cls is None:
            continue
        if reg.is_receiver(src.source_type):
            targets.append(_read_push(src))
        elif reg.is_pull(src.source_type):
            targets.append(_read_pull(src))

    if not targets:
        return []

    async def _guarded(coro):
        return await asyncio.wait_for(coro, timeout=8.0)

    results = await asyncio.gather(*[_guarded(c) for c in targets], return_exceptions=True)
    merged: list[dict[str, Any]] = []
    for outcome in results:
        if isinstance(outcome, Exception):
            continue  # a slow/failing source contributes nothing (partial success)
        merged.extend(outcome or [])
    merged.sort(key=lambda r: (r.get("ts") or ""), reverse=True)
    return merged[:limit]


def _bucket_histogram(rows: list[dict[str, Any]], bucket_minutes: int) -> list[dict[str, Any]]:
    """A time-bucketed count of matched rows (oldest-first), for the recharts preview
    histogram. Pure + defensive: a row with no/unparseable ts is skipped. Buckets are
    UTC-aligned to ``bucket_minutes``; returns ``[{bucket_start_iso, count}]``."""
    import datetime as _dt

    width = max(1, int(bucket_minutes)) * 60
    counts: dict[int, int] = {}
    for r in rows:
        ts = str(r.get("ts") or "")
        if not ts:
            continue
        try:
            dt = _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        epoch = int(dt.timestamp())
        bucket = (epoch // width) * width
        counts[bucket] = counts.get(bucket, 0) + 1
    out: list[dict[str, Any]] = []
    for bucket in sorted(counts):
        iso = _dt.datetime.fromtimestamp(bucket, tz=_dt.timezone.utc).isoformat()
        out.append({"bucket": iso, "count": counts[bucket]})
    return out


def _preview_row(row: dict[str, Any]) -> dict[str, Any]:
    """A trimmed, plain, render-safe projection of one matched log row (#9). Drops the
    heavy ``_raw`` doc from the sample — the UI shows the summary columns; never a secret
    (rows are log data only)."""
    return {
        "id": _safe(row.get("id")),
        "ts": _safe(row.get("ts")),
        "source_ip": _safe(row.get("source_ip")) if row.get("source_ip") is not None else None,
        "user": _safe(row.get("user")) if row.get("user") is not None else None,
        "host": _safe(row.get("host")) if row.get("host") is not None else None,
        "rule": _safe(row.get("rule")) if row.get("rule") is not None else None,
        "severity": row.get("severity"),
        "message": _safe(row.get("message")),
    }
