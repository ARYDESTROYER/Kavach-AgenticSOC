"""Round 3 — Feature 12: clearer cases + agent-work visualization.

Two READ-ONLY endpoints assembled at READ TIME from already-recorded facts (the
case + its audit rows + the usage/cost ledger) — they NEVER mutate state and NEVER
call the LLM:

* ``GET /api/cases/{id}/triage`` — the FOUR honestly-distinct advisory chips
  ``{risk, severity, impact, priority}``, each with the inputs a UI HelpTip shows.
  Pure derivation via :mod:`app.engine.priority`.
* ``GET /api/cases/{id}/timeline`` — a TYPED ReAct span timeline (the ``TraceSpan``
  shape) projected from the audit rows + the usage ledger, with the deterministic
  ``case_manager`` DECISION rendered as a distinct TERMINAL step showing its exact
  ``(verdict, confidence, risk_score, policy clause)`` so #3's determinism is VISIBLE.

⛔ NON-NEGOTIABLE #3: every advisory band here is PRESENTATION/ORDERING ONLY and is
never fed to ``case_manager.decide()``. The timeline's terminal decision step
RE-DERIVES the decision via ``decide()`` purely to DISPLAY the exact clause — it
mutates nothing.

⛔ NON-NEGOTIABLE #9: the projection separates TRUSTED agent prose (router/
investigator/formatter/decision summaries) from UNTRUSTED tool/log payloads
(es_query / tool output, which carry source-influenceable data). Each span carries a
``trusted`` flag; the returned values are plain DATA the UI render-escapes — nothing
here is interpolated into a prompt.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..config import AutoClosePolicy
from ..constants import ActionType, CaseStatus, DecisionBy, Verdict
from ..engine.case_manager import decide
from ..engine.priority import derive_triage
from ..models import (
    StageRiskCalculation,
    StageRiskFactor,
    StageState,
    StageStep,
    TimelineStage,
    TimelineStagesResponse,
    TraceSpan,
)
from .deps import get_state, require_permission

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# POST /api/triage/preview-decision — pure what-if over decide() (#3 made safe)
# --------------------------------------------------------------------------- #
class _PreviewDecisionIn(BaseModel):
    """What-if inputs for the deterministic auto-close decision.

    The three positional inputs the pure ``decide()`` takes, plus an OPTIONAL
    ``policy`` to preview a candidate ``AutoClosePolicy`` (e.g. a Settings draft the
    operator has not saved yet). When ``policy`` is omitted the LIVE
    ``prefs.auto_close`` is used, so the caller sees exactly what the running system
    would decide for these inputs. ``escalation_confidence`` / ``critical_severity``
    default to the live prefs when omitted (they only affect the advisory ``escalate``
    flag, never the close/route decision)."""

    verdict: Verdict | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    risk_score: float = Field(default=0.0, ge=0.0, le=100.0)
    policy: AutoClosePolicy | None = None
    escalation_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    critical_severity: float | None = Field(default=None, ge=0.0)


@router.post("/triage/preview-decision")
async def preview_decision(
    body: _PreviewDecisionIn,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """A pure what-if wrapper over the deterministic ``case_manager.decide()``.

    Given ``{verdict, confidence, risk_score, policy?}`` it RE-USES the SAME pure
    ``decide()`` the running pipeline calls (imported, never re-implemented) and returns
    its verbatim result ``{decision, rationale}``. It exists so the Settings/Rules UI can
    show — before saving — what the live auto-close policy (or a candidate ``policy``)
    would do for a hypothetical verdict, WITHOUT the risk of ever drifting from the real
    decision code.

    ⛔ Read-only + side-effect-free (#3/#6/#2):
      * NEVER bills the LLM — no gateway call, so ZERO ``UsageDoc`` writes.
      * NEVER writes or mutates a case, config, or any store.
      * NEVER touches / re-implements / re-derives ``decide()`` — it calls the one true
        pure function, which is byte-identical and has no side effects.

    ``policy`` defaults to the LIVE ``prefs.auto_close``; ``escalation_confidence`` /
    ``critical_severity`` default to the live prefs (they only flag the advisory
    ``escalate`` band). RBAC: ``cases:read``."""
    prefs = state.prefs
    policy = body.policy if body.policy is not None else prefs.auto_close
    esc_conf = (
        body.escalation_confidence
        if body.escalation_confidence is not None
        else prefs.escalation_confidence
    )
    crit_sev = (
        body.critical_severity
        if body.critical_severity is not None
        else prefs.critical_severity
    )
    decision = decide(
        body.verdict,
        body.confidence,
        body.risk_score,
        policy,
        escalation_confidence=esc_conf,
        critical_severity=crit_sev,
    )
    return {
        "decision": {
            "status": decision.status.value,
            "decision_by": decision.decision_by.value,
            "escalate": decision.escalate,
            "objection_window_expires_at": decision.objection_window_expires_at,
            "auto_closed": decision.status == CaseStatus.CLOSED,
        },
        "rationale": decision.rationale,
        "inputs": {
            "verdict": (body.verdict.value if body.verdict else None),
            "confidence": body.confidence,
            "risk_score": body.risk_score,
            "escalation_confidence": esc_conf,
            "critical_severity": crit_sev,
            "policy_provided": body.policy is not None,
        },
    }


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/triage — the four honest chips
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/triage")
async def case_triage(
    case_id: str,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The FOUR honestly-distinct advisory chips for a case.

    ``risk`` (the existing deterministic 0-100 score + breakdown), ``severity``
    (SOURCE-asserted, NOT risk), ``impact`` (asset criticality), and ``priority``
    (ITIL Impact×Urgency). Each carries an ``inputs`` bag for a UI HelpTip. NEVER
    404s — an unknown case returns an empty-but-renderable shell. Pure derivation
    (#3: advisory only, never feeds the decision)."""
    case = await state.cases.get(case_id)
    if case is None:
        return {"case_id": case_id, "found": False, "chips": _empty_chips()}
    chips = derive_triage(case, state.prefs)
    return {"case_id": case_id, "found": True, "chips": chips}


def _empty_chips() -> dict[str, Any]:
    """A renderable zero-state for an unknown case (never 404, never raises)."""
    low = {"band": "low", "value": 0.0}
    return {
        "risk": {**low, "breakdown": {}, "inputs": {}},
        "severity": {**low, "raw": None, "source": "derived", "inputs": {}},
        "impact": {**low, "criticality": 0.0, "entity": "", "inputs": {}},
        "priority": {
            "level": None, "impact": "low", "matched": False, "default": "P3",
            "urgency": {"band": "low", "value": 0.0, "escalated": False},
            "inputs": {},
        },
    }


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/timeline — typed ReAct span timeline
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/timeline")
async def case_timeline(
    case_id: str,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """A TYPED ReAct span timeline for a case (the ``TraceSpan`` shape).

    Assembled from the already-recorded ``tlsoc-agent-audit`` rows (oldest-first) +
    the per-case usage/cost ledger. Each audit row becomes ONE span classified by
    ``kind`` (invoke_agent | chat | execute_tool | decision) with ``step_index`` /
    ``latency`` / ``cost`` / ``tokens`` / ``trusted``. The ``case_manager`` DECISION
    is rendered as a distinct TERMINAL ``decision`` span whose summary shows the exact
    ``(verdict, confidence, risk_score, policy clause)`` the deterministic ``decide()``
    produced — re-derived at read time, mutating nothing (#3 made visible).

    TRUSTED agent prose (router/investigator/formatter/decision) vs UNTRUSTED tool/log
    payloads (es_query / tool output) are separated by the per-span ``trusted`` flag
    (#9). NEVER 404s — an unknown / not-yet-investigated case returns empty spans.
    ``prompt_excerpt`` text is dropped from a span summary when
    ``prefs.trace.include_prompts`` is false (the untrusted-prompt toggle)."""
    rows = await state.audit.records_for_case(case_id)
    include_prompts = getattr(state.prefs.trace, "include_prompts", True)

    # Per-role cost/token attribution from the usage ledger (aggregate → per-span).
    cost_by_role, tokens_by_role = await _usage_attribution(state, case_id)

    # Count the audit LLM rows (PROMPT + VERDICT) per role from the SAME rows the spans
    # are built from. The role's ledger TOTAL is split across exactly the spans that
    # receive a slice — NOT the ledger call count — so the per-role span sum reconciles
    # with the ledger for any N (a single-call normal run AND a multi-step ReAct loop).
    # See routes_triage tests test_timeline_totals_reconcile_*.
    audit_llm_rows_by_role = _count_llm_rows_by_role(rows)

    spans: list[TraceSpan] = []
    step = 0
    for row in rows:
        # The case_manager DECISION row is rendered as a distinct terminal span below,
        # re-derived from decide() — skip the raw audit projection for it here.
        actor = str(_get(row, "actor", ""))
        at = str(_get(row, "action_type", "") or "")
        if actor == "case_manager" and at == ActionType.DECISION.value:
            continue
        span = _row_to_span(case_id, row, step, include_prompts,
                            cost_by_role, tokens_by_role, audit_llm_rows_by_role)
        spans.append(span)
        step += 1

    # --- the distinct TERMINAL decision span (re-derive decide() for the EXACT clause) -
    case = await state.cases.get(case_id)
    decision_span = _decision_span(case_id, case, state, step)
    if decision_span is not None:
        spans.append(decision_span)

    return {
        "case_id": case_id,
        "spans": [s.model_dump(mode="json") for s in spans],
        "total": len(spans),
        "totals": {
            "cost": round(sum(s.cost or 0.0 for s in spans), 6),
            "tokens": sum(s.tokens or 0 for s in spans),
        },
    }


# --------------------------------------------------------------------------- #
# Helpers — pure projection (defensive; never raise)
# --------------------------------------------------------------------------- #
def _get(row: Any, key: str, default: Any = None) -> Any:
    """Read a field from an audit row that may be a dict OR a pydantic AuditDoc."""
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


# Audit action types that represent ONE LLM-producing step (a gateway completion the
# ledger metered). These are exactly the rows ``_row_to_span`` attributes a cost slice
# to (``is_llm_row``), so dividing a role's ledger total by their per-role COUNT makes
# the per-role span sum reconcile with the ledger truth (#6 source of truth).
_LLM_ROW_ACTIONS: frozenset[str] = frozenset({
    ActionType.PROMPT.value,
    ActionType.VERDICT.value,
})


def _count_llm_rows_by_role(rows: Any) -> dict[str, int]:
    """Count the LLM-producing audit rows (PROMPT/VERDICT) per actor role.

    This is the EXACT divisor for cost/token attribution: the role's ledger total is
    split across precisely the spans that receive a slice. The case_manager DECISION row
    is excluded (it is rendered as the deterministic terminal span, never an LLM step).
    Defensive: tolerates dict OR pydantic rows; never raises."""
    by_role: dict[str, int] = {}
    for row in rows:
        actor = str(_get(row, "actor", "") or "")
        at = str(_get(row, "action_type", "") or "")
        if actor == "case_manager" and at == ActionType.DECISION.value:
            continue
        if at in _LLM_ROW_ACTIONS:
            by_role[actor] = by_role.get(actor, 0) + 1
    return by_role


# audit action_type → TraceSpan.kind. Agent invocations (PROMPT/VERDICT/CONTEXT/the
# router DECISION) are ``invoke_agent``; tool + es_query rows are ``execute_tool``;
# the case_manager DECISION is ``decision`` (handled separately). Anything else
# defaults to ``invoke_agent`` (a generic pipeline step).
_KIND_BY_ACTION: dict[str, str] = {
    ActionType.PROMPT.value: "invoke_agent",
    ActionType.VERDICT.value: "invoke_agent",
    ActionType.CONTEXT.value: "invoke_agent",
    ActionType.DECISION.value: "invoke_agent",   # router triage decision (not case_manager)
    ActionType.TOOL_CALL.value: "execute_tool",
    ActionType.ES_QUERY.value: "execute_tool",
    ActionType.ERROR.value: "invoke_agent",
}

# Action types whose payload carries source/log-influenceable data → UNTRUSTED (#9).
_UNTRUSTED_ACTIONS: frozenset[str] = frozenset({
    ActionType.TOOL_CALL.value,
    ActionType.ES_QUERY.value,
})


def _row_to_span(
    case_id: str,
    row: Any,
    step: int,
    include_prompts: bool,
    cost_by_role: dict[str, float],
    tokens_by_role: dict[str, int],
    llm_rows_by_role: dict[str, int],
) -> TraceSpan:
    """Project one audit row into a typed TraceSpan.

    Classifies the span ``kind``, marks tool/log payloads UNTRUSTED (#9), and
    attributes a per-role cost/token slice from the usage ledger to the LLM-producing
    rows (PROMPT/VERDICT). The slice divisor is the per-role COUNT of those same audit
    rows (``llm_rows_by_role``) — NOT the ledger call count — so the per-role span sum
    reconciles with the ledger for both a single-call run and a multi-step ReAct loop.
    The ``summary`` carries SHORT prose only — the heavy payload is left in the audit doc
    (referenced by ``payload_ref``), never re-inlined here."""
    actor = str(_get(row, "actor", "") or "")
    at = str(_get(row, "action_type", "") or "")
    kind = _KIND_BY_ACTION.get(at, "invoke_agent")
    untrusted = at in _UNTRUSTED_ACTIONS

    # Build a short, render-safe summary (TRUSTED prose vs an UNTRUSTED payload note).
    tool_name = _get(row, "tool_name") or ""
    query_text = _get(row, "query_text") or ""
    result_summary = str(_get(row, "result_summary") or "")
    tool_out = str(_get(row, "tool_output_summary") or "")
    if untrusted:
        # UNTRUSTED: do NOT inline the log/tool output as if it were trusted prose;
        # name the tool + query and point at the audit row for the payload.
        bits = []
        if tool_name:
            bits.append(f"tool={tool_name}")
        if query_text:
            bits.append(f"query={query_text}")
        summary = " · ".join(bits) or (tool_out[:200] if tool_out else "(tool call)")
    else:
        # TRUSTED agent prose. Drop the untrusted prompt excerpt unless allowed.
        summary = result_summary
        if not summary and at == ActionType.PROMPT.value and include_prompts:
            summary = str(_get(row, "prompt_excerpt") or "")
        if not summary:
            summary = f"{actor or kind} step"

    # Cost / token attribution: only LLM-producing rows (a PROMPT or VERDICT by an LLM
    # role) take a slice of that role's ledger total (split evenly across that role's
    # LLM AUDIT ROWS so per-case totals reconcile with the ledger — see #6).
    cost = None
    tokens = None
    model = _get(row, "model")
    is_llm_row = at in _LLM_ROW_ACTIONS
    if is_llm_row and actor in cost_by_role:
        n = max(1, llm_rows_by_role.get(actor, 1))
        cost = round(cost_by_role.get(actor, 0.0) / n, 6)
        tokens = int(tokens_by_role.get(actor, 0) / n)

    return TraceSpan(
        case_id=case_id,
        step_index=step,
        kind=kind,
        name=(actor or at or kind),
        ts=str(_get(row, "ts", "") or ""),
        latency_ms=None,
        cost=cost,
        tokens=tokens,
        trusted=not untrusted,
        summary=summary[:2000],
        payload_ref={
            "action_type": at,
            "actor": actor,
            "model": model,
            "tool_name": tool_name or None,
        },
    )


def _decision_span(case_id: str, case: Any, state: Any, step: int) -> TraceSpan | None:
    """The distinct TERMINAL ``decision`` span — re-derives ``decide()`` at read time
    to surface its EXACT clause, making #3's determinism visible.

    Returns None for a case that never reached a verdict (no decision to show). The
    span is ALWAYS ``trusted`` (it is our own deterministic prose) and carries the
    decision INPUTS (verdict / confidence / risk_score / the matched policy clause)
    in ``payload_ref`` so the UI can render the exact truth-table evaluation. This
    call MUTATES NOTHING (decide() is a pure, side-effect-free function)."""
    if case is None or case.verdict is None:
        return None
    prefs = state.prefs
    decision = decide(
        case.verdict,
        case.confidence,
        case.risk_score,
        prefs.auto_close,
        escalation_confidence=prefs.escalation_confidence,
        critical_severity=prefs.critical_severity,
    )
    verdict_v = case.verdict.value if case.verdict else None
    return TraceSpan(
        case_id=case_id,
        step_index=step,
        kind="decision",
        name="case_manager",
        ts=case.updated_at or "",
        latency_ms=None,
        cost=0.0,         # the deterministic decision costs nothing (no LLM call)
        tokens=0,
        trusted=True,     # our own deterministic rationale — never untrusted log data
        summary=decision.rationale,
        payload_ref={
            "deterministic": True,
            "verdict": verdict_v,
            "confidence": round(float(case.confidence), 4),
            "risk_score": round(float(case.risk_score), 2),
            "decision_status": decision.status.value,
            "decision_by": decision.decision_by.value,
            "escalate": decision.escalate,
            "objection_window_expires_at": decision.objection_window_expires_at,
            "policy_clause": _policy_clause(case, prefs),
        },
    )


def _policy_clause(case: Any, prefs: Any) -> dict[str, Any]:
    """Surface the exact AutoClosePolicy clause that decide() evaluated for this
    verdict class (the thresholds the deterministic truth table compared against).
    Read-only display of config — never changes anything."""
    from ..constants import Verdict

    entry = None
    if case.verdict == Verdict.FALSE_POSITIVE:
        entry = prefs.auto_close.false_positive
    elif case.verdict == Verdict.TRUE_POSITIVE:
        entry = prefs.auto_close.true_positive
    if entry is None:
        # NEEDS_HUMAN / unknown verdict: code-enforced, never auto-closable.
        return {
            "verdict_class": (case.verdict.value if case.verdict else None),
            "auto_closable": False,
            "note": "NEEDS_HUMAN / unknown verdict never auto-closes (code-enforced).",
        }
    return {
        "verdict_class": case.verdict.value,
        "enabled": entry.enabled,
        "min_confidence": entry.min_confidence,
        "max_risk_score": entry.max_risk_score,
        "objection_window_minutes": entry.objection_window_minutes,
        "auto_closable": bool(entry.enabled),
    }


async def _usage_attribution(
    state: Any, case_id: str
) -> tuple[dict[str, float], dict[str, int]]:
    """Per-role cost/token TOTALS for a case from the usage ledger (#6 source of truth).

    Returns the per-role ledger totals; the per-span divisor is the count of LLM AUDIT
    rows (see :func:`_count_llm_rows_by_role`), NOT the ledger call count — that is what
    makes the per-role span sum reconcile with the ledger for a multi-step ReAct run
    (N gateway calls metered, but only the PROMPT + VERDICT audit rows carry a slice).
    Defensive: a ledger miss degrades to empty maps (no cost shown), never raises. Reads
    the aggregate ``summary(case_id=...)`` — does NOT touch the gateway write path (#6
    stays the single writer)."""
    cost_by_role: dict[str, float] = {}
    tokens_by_role: dict[str, int] = {}
    try:
        summary = await state.usage_store.summary(window_hours=24 * 365, case_id=case_id)
    except Exception:  # noqa: BLE001 — the timeline must never 500 on a ledger miss
        return cost_by_role, tokens_by_role
    for entry in (summary.get("by_role") or []):
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key", ""))
        if not key:
            continue
        cost_by_role[key] = float(entry.get("cost", 0.0) or 0.0)
        tokens_by_role[key] = int(entry.get("tokens", 0) or 0)
    return cost_by_role, tokens_by_role


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/stages — the six-stage Timeline narrative (read-time #3/#9)
# --------------------------------------------------------------------------- #
# The canonical ordered spine (kind, label, deterministic) — the skeleton returned
# for an unknown case so the UI always has six stages to render.
_CANON_STAGES: tuple[tuple[str, str, bool], ...] = (
    ("input", "Alert received", False),
    ("correlate", "Correlate", True),
    ("risk", "Risk assigned", True),
    ("triage", "Triage", False),
    ("investigate", "Investigate", False),
    ("decide", "Decision", True),
)


def _humanize(token: Any) -> str:
    """A lowercased snake/enum token → spaced words (backend-side, display only)."""
    return str(token or "").replace("_", " ").strip()


def _enrichment_line(enr: dict[str, Any]) -> str:
    """A compact TRUSTED one-liner from an enrichment result (our derived scalars)."""
    bits: list[str] = []
    if enr.get("reputation_score") is not None:
        bits.append(f"reputation {enr['reputation_score']}")
    if enr.get("is_malicious") is not None:
        bits.append("flagged malicious" if enr["is_malicious"] else "not flagged malicious")
    if enr.get("country"):
        bits.append(f"country {enr['country']}")
    return " · ".join(bits)


def _decide_headline(pr: dict[str, Any]) -> str:
    """A one-line TRUSTED headline for the deterministic decision, from its clause."""
    if pr.get("escalate"):
        return "Escalated by policy"
    status = str(pr.get("decision_status") or "")
    decided_by = str(pr.get("decision_by") or "")
    if status in (CaseStatus.RESOLVED.value, "closed", "resolved"):
        # Compare against the real ``DecisionBy`` vocabulary. The previous literal
        # "human" matched no value the enum has ever produced, so EVERY close read as
        # "Auto-closed by policy" — including an analyst's own close.
        if decided_by == DecisionBy.ANALYST_POLICY.value:
            return "Closed by analyst policy"
        if decided_by == DecisionBy.ANALYST.value:
            return "Closed by analyst"
        if decided_by == DecisionBy.AGENT.value:
            return "Auto-closed by policy"
        return "Closed"
    if status in (CaseStatus.NEEDS_HUMAN.value, "needs_human", CaseStatus.ON_HOLD.value):
        return "Held for human review"
    return _humanize(status).capitalize() or "Decision recorded"


def _risk_calculation(case: Any, prefs: Any) -> StageRiskCalculation:
    """Expose the stored factor scores and the exact CURRENT weighted arithmetic.

    This deliberately mirrors only the final weighted blend in ``compute_risk()``;
    it does not rescore, mutate, or feed a decision. Factor values come from the
    persisted ``Case.risk_breakdown``. Coefficients come from the current Preferences,
    so a changed configuration can honestly produce a different recomputed value; the
    response calls that out through ``matches_displayed_score`` instead of concealing it.
    """
    rb = case.risk_breakdown
    weights = prefs.risk_weights
    factor_defs = (
        ("volume", "Volume"),
        ("velocity", "Velocity"),
        ("reputation", "Reputation"),
        ("diversity", "Diversity"),
        ("asset_criticality", "Asset criticality"),
    )
    raw: list[tuple[str, str, float, float, float]] = []
    for key, label in factor_defs:
        value = float(getattr(rb, key, 0.0) or 0.0)
        weight = float(getattr(weights, key, 0.0) or 0.0)
        raw.append((key, label, value, weight, value * weight))

    configured_sum = sum(item[3] for item in raw)
    # Byte-for-byte scoring semantics: compute_risk() uses 1.0 when the configured
    # coefficient sum is zero, preventing a divide-by-zero.
    denominator = configured_sum or 1.0
    numerator = sum(item[4] for item in raw)
    calculated = numerator / denominator
    recorded = float(case.risk_score or 0.0)
    displayed = round(recorded)
    factors = [
        StageRiskFactor(
            factor=key,
            label=label,
            value=value,
            weight=weight,
            weighted_value=weighted,
            contribution=weighted / denominator,
        )
        for key, label, value, weight, weighted in raw
    ]
    return StageRiskCalculation(
        factors=factors,
        numerator=numerator,
        denominator=denominator,
        calculated_score=calculated,
        recorded_score=recorded,
        displayed_score=displayed,
        matches_displayed_score=round(calculated) == displayed,
    )


def _build_stages(case_id: str, case: Any, rows: Any, state: Any) -> list[TimelineStage]:
    """Project a case + its audit rows into the six ordered narrative stages. Pure /
    read-time / mutates nothing (#3); untrusted source/log text is fenced in steps (#9)."""
    n = len(case.member_event_keys or case.member_event_ids) or len(case.evidence)
    plural = "s" if n != 1 else ""
    src = case.source_name or "the configured source"

    # 1 — input (the raw alert as the SIEM sent it)
    input_steps: list[StageStep] = []
    if case.evidence and getattr(case.evidence[0], "summary", ""):
        input_steps.append(StageStep(kind="note", label="evidence",
                                     body=str(case.evidence[0].summary), trusted=False))
    input_stage = TimelineStage(
        id="input", kind="input", label="Alert received", status="done", deterministic=False,
        ts=case.created_at or None,
        headline=(f"{n} alert{plural} from {src}" if n else f"Alert from {src}"),
        state=StageState(severity_band=case.severity_band, severity_source=case.severity_source),
        steps=input_steps,
    )

    # 2 — correlate (deterministic clustering)
    corr_steps: list[StageStep] = []
    if case.cluster_signature:
        corr_steps.append(StageStep(kind="note", label="cluster signature",
                                    body=str(case.cluster_signature), trusted=False))
    correlate_stage = TimelineStage(
        id="correlate", kind="correlate", label="Correlate", status="done", deterministic=True,
        ts=case.created_at or None,
        headline=(f"{n} alerts clustered into one case" if n > 1 else "Single-alert case (no cluster)"),
        steps=corr_steps,
    )

    # 3 — risk (deterministic scoring)
    rb = case.risk_breakdown
    factors = [("volume", rb.volume), ("velocity", rb.velocity), ("reputation", rb.reputation),
               ("diversity", rb.diversity), ("asset criticality", rb.asset_criticality)]
    nz = [f"{k} {round(float(v), 1)}" for k, v in factors if v]
    risk_stage = TimelineStage(
        id="risk", kind="risk", label="Risk assigned", status="done", deterministic=True,
        ts=case.created_at or None,
        headline=f"Risk {round(float(case.risk_score))}/100",
        state=StageState(
            risk_score=round(float(case.risk_score), 2),
            risk_calculation=_risk_calculation(case, state.prefs),
        ),
        steps=([StageStep(kind="note", label="risk factors", body=" · ".join(nz), trusted=True)] if nz else []),
    )

    # Extract the "why" pieces from the SAME audit rows the rationale endpoint reads:
    # CONTEXT.tool_input → knowledge/memory/enrichment (the basis given); TOOL_CALL/
    # ES_QUERY → commands run; VERDICT "reasoning=" → the reasoning excerpt; the
    # playbook_selector DECISION → why that playbook. Self-contained; pure/defensive.
    knowledge: list[dict[str, str]] = []
    memory_facts: list[str] = []
    enrichment: dict[str, Any] | None = None
    tool_rows: list[Any] = []
    reasoning = ""
    playbook_reason = ""
    context_seen = False
    for row in rows:
        at = str(_get(row, "action_type", "") or "")
        if _get(row, "actor") == "playbook_selector" and not playbook_reason:
            playbook_reason = str(_get(row, "result_summary", "") or "")
        if at == ActionType.CONTEXT.value and not context_seen:
            context_seen = True
            ti = _get(row, "tool_input") or {}
            if isinstance(ti, dict):
                for k in (ti.get("knowledge") or []):
                    if isinstance(k, dict):
                        knowledge.append({"source": str(k.get("source", "knowledge")),
                                          "snippet": str(k.get("snippet", ""))})
                for m in (ti.get("memory") or []):
                    if isinstance(m, str) and m.strip():
                        memory_facts.append(m)
                if isinstance(ti.get("enrichment"), dict):
                    enrichment = ti["enrichment"]
        elif at in (ActionType.TOOL_CALL.value, ActionType.ES_QUERY.value):
            tool_rows.append(row)
        elif at == ActionType.VERDICT.value and not reasoning:
            ti = _get(row, "tool_input")
            if isinstance(ti, dict) and str(ti.get("reasoning") or "").strip():
                reasoning = str(ti["reasoning"]).strip()
            else:
                rs = str(_get(row, "result_summary", "") or "")
                if "reasoning=" in rs:
                    reasoning = rs.split("reasoning=", 1)[1].strip()

    # 4 — triage (specialist routing + the basis given: playbook + operator memory)
    persona = case.agent_persona or ""
    playbook_id = getattr(case, "playbook_id", "") or ""
    triage_steps: list[StageStep] = []
    if playbook_id:
        triage_steps.append(StageStep(
            kind="note", label="playbook",
            body=(f"{playbook_id} — {playbook_reason}" if playbook_reason else str(playbook_id)),
            trusted=True))
    triage_steps.extend(StageStep(kind="memory", label="memory", body=m, trusted=True)
                        for m in memory_facts)
    triage_done = bool(persona or playbook_id or memory_facts)
    triage_stage = TimelineStage(
        id="triage", kind="triage", label="Triage", status=("done" if triage_done else "skipped"),
        deterministic=False, ts=case.created_at or None,
        headline=(f"Routed to {_humanize(persona)} specialist" if persona and persona != "generalist"
                  else ("Triaged" if triage_done else "No specialist routing")),
        steps=triage_steps,
    )

    # 5 — investigate (the ReAct loop: reasoning + commands + knowledge + enrichment)
    inv_steps: list[StageStep] = []
    if reasoning:
        inv_steps.append(StageStep(kind="reasoning", label="reasoning", body=reasoning, trusted=True))
    for r in tool_rows:
        at = str(_get(r, "action_type", "") or "")
        tool = _get(r, "tool_name") or ("es_query" if at == ActionType.ES_QUERY.value else "tool")
        inv_steps.append(StageStep(kind="tool", label=str(tool),
                                   body=str(_get(r, "query_text", "") or ""), trusted=False,
                                   ts=str(_get(r, "ts", "")) or None))
    inv_steps.extend(StageStep(kind="knowledge", label=(k["source"] or "knowledge"),
                               body=k["snippet"], trusted=False) for k in knowledge)
    if enrichment and (line := _enrichment_line(enrichment)):
        inv_steps.append(StageStep(kind="note", label="enrichment", body=line, trusted=True))
    has_work = bool(reasoning or tool_rows or knowledge or enrichment)
    if case.verdict is not None:
        inv_status, inv_headline = "done", (
            f"Verdict: {_humanize(case.verdict.value).lower()} · conf {round(float(case.confidence) * 100)}%")
    elif has_work:
        inv_status, inv_headline = "done", "Investigated (no verdict recorded)"
    else:
        inv_status, inv_headline = "skipped", "No investigation ran"
    investigate_stage = TimelineStage(
        id="investigate", kind="investigate", label="Investigate", status=inv_status,
        deterministic=False,
        ts=(str(_get(tool_rows[0], "ts", "")) if tool_rows else None) or None,
        headline=inv_headline,
        state=StageState(verdict=(case.verdict.value if case.verdict else None),
                         confidence=(round(float(case.confidence), 4) if case.verdict else None)),
        steps=inv_steps,
    )

    # 6 — decide (re-derive decide() for the EXACT deterministic clause; #3 made visible)
    dspan = _decision_span(case_id, case, state, 0)
    if dspan is not None:
        pr = dspan.payload_ref
        decide_stage = TimelineStage(
            id="decide", kind="decide", label="Decision", status="done", deterministic=True,
            ts=dspan.ts or None, headline=_decide_headline(pr),
            state=StageState(verdict=pr.get("verdict"), confidence=pr.get("confidence"),
                             risk_score=pr.get("risk_score")),
            steps=([StageStep(kind="note", label="decision rationale", body=dspan.summary, trusted=True)]
                   if dspan.summary else []),
        )
    else:
        decide_stage = TimelineStage(
            id="decide", kind="decide", label="Decision", status="pending", deterministic=True,
            headline="Awaiting decision",
        )

    return [input_stage, correlate_stage, risk_stage, triage_stage, investigate_stage, decide_stage]


@router.get("/cases/{case_id}/stages")
async def case_stages(
    case_id: str,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The six-stage Timeline narrative for a case (the ``TimelineStage`` shape).

    A pure read-time projection over the Case + its audit rows (the SAME facts the
    ``/timeline`` span view reads), reframed into ``input → correlate → risk → triage
    → investigate → decide``. Advisory/observability ONLY — re-derives ``decide()`` to
    DISPLAY the clause, mutates nothing (#3); untrusted source/log text is fenced in
    steps (#9). NEVER 404s — an unknown case returns the six-stage skeleton."""
    case = await state.cases.get(case_id)
    if case is None:
        skeleton = [TimelineStage(id=k, kind=k, label=lbl, status="skipped", deterministic=det)
                    for k, lbl, det in _CANON_STAGES]
        return TimelineStagesResponse(case_id=case_id, stages=skeleton,
                                      total=len(skeleton)).model_dump(mode="json")
    rows = await state.audit.records_for_case(case_id)
    stages = _build_stages(case_id, case, rows, state)
    return TimelineStagesResponse(case_id=case_id, stages=stages,
                                  total=len(stages)).model_dump(mode="json")
