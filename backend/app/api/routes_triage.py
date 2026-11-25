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
never fed to ``case_manager.decide()``. The timeline's terminal decision step reports
the RECORDED decision (Round 16 B63: the case's ``history`` decision entry and the gate
recorded on its ``case_manager`` DECISION audit row); it calls ``decide()`` only to say
whether today's policy would decide differently, or, for a case with no recorded
decision, to re-derive one labelled as such. It mutates nothing.

Round 16 (SPEC §4.5 WP10) adds the read-time facts behind every case number: the risk
arithmetic from the inputs recorded at scoring (B13), the per-case SLA reading, the
auto-close entry for the case's verdict, the matched internal network range for a
``settings:read`` holder, and a bounded ``detail`` per trace span with each call's own
cost and latency where the ledger can name it.

⛔ NON-NEGOTIABLE #9: the projection separates TRUSTED agent prose (router/
investigator/formatter/decision summaries) from UNTRUSTED tool/log payloads
(es_query / tool output, which carry source-influenceable data). Each span carries a
``trusted`` flag; the returned values are plain DATA the UI render-escapes — nothing
here is interpolated into a prompt.
"""

from __future__ import annotations

import ipaddress
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from ..audit.events import derive_actor_type
from ..config import AutoClosePolicy
from ..constants import ActionType, CaseStatus, DecisionBy, Verdict
from ..engine.case_manager import decide
from ..engine.case_rationale import LEGACY_SELECTOR_ACTOR, is_selection_row
from ..engine.priority import advisory_bands, band_of_case, derive_triage
from ..engine.runbook_model import builtin_runbook, resolve_legacy_runbook_id
from ..engine.sla_reading import case_sla_reading
from ..models import (
    TRACE_DETAIL_TEXT_CHARS,
    TRACE_DETAIL_TOOL_INPUT_BYTES,
    StageRiskCalculation,
    StageRiskFactor,
    StageState,
    StageStep,
    TimelineStage,
    TimelineStagesResponse,
    TraceSpan,
    TraceSpanDetail,
)
from ..utils import round_half_up
from .deps import get_state, has_permission, require_permission

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
    request: Request = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """The FOUR honestly-distinct advisory chips for a case.

    ``risk`` (the existing deterministic 0-100 score + breakdown), ``severity``
    (SOURCE-asserted, NOT risk), ``impact`` (asset criticality), and ``priority``
    (ITIL Impact×Urgency). Each carries an ``inputs`` bag for a UI HelpTip. NEVER
    404s: an unknown case returns an empty-but-renderable shell. Pure derivation
    (#3: advisory only, never feeds the decision).

    Round 16 (SPEC §4.5 WP10) read-time additions, built here and never stored on the
    case: ``auto_close_policy`` (the auto-close entry for the case's verdict class, so
    Case detail can state the policy without ``GET /api/settings``), ``sla`` (the
    per-case SLA reading, ``engine/sla_reading.py``, or ``null``) and, for a
    ``settings:read`` holder only, ``asset_cidr`` (the internal network range of
    today's configuration that holds the entity, labelled so). Everything reads the
    active execution preferences, so Demo Mode reads its sandbox."""
    prefs = state.execution_prefs
    case = await state.cases.get(case_id)
    if case is None:
        return {
            "case_id": case_id, "found": False, "chips": _empty_chips(),
            "auto_close_policy": None, "sla": None,
        }
    chips = derive_triage(case, prefs)
    out: dict[str, Any] = {
        "case_id": case_id,
        "found": True,
        "chips": chips,
        "auto_close_policy": _auto_close_entry(case.verdict, prefs.auto_close),
        "sla": case_sla_reading(case, prefs),
    }
    # The matched range is configuration, shown only to a person who may read the
    # settings (SPEC Appendix C, C5); everyone else, and a call without a request,
    # gets no ``asset_cidr`` key at all.
    if request is not None and await has_permission(request, "settings", "read"):
        out["asset_cidr"] = _asset_cidr(case, prefs)
    return out


def _auto_close_entry(verdict: Any, policy: Any) -> dict[str, Any]:
    """The auto-close entry for a verdict class (the B27 ``policyForVerdict`` rule): the
    false-positive entry for a false positive, the true-positive entry for a true
    positive, and a fixed "never" for needs human or no verdict, which code never
    auto-closes whatever the stored policy says. Read-only display of config."""
    if verdict == Verdict.FALSE_POSITIVE:
        cls, entry = "false_positive", policy.false_positive
    elif verdict == Verdict.TRUE_POSITIVE:
        cls, entry = "true_positive", policy.true_positive
    else:
        return {
            "verdict_class": "needs_human",
            "enabled": False,
            "auto_closable": False,
            "note": "A needs-human verdict never closes automatically. Code enforces this.",
        }
    return {
        "verdict_class": cls,
        "enabled": bool(entry.enabled),
        "min_confidence": entry.min_confidence,
        "max_risk_score": entry.max_risk_score,
        "objection_window_minutes": entry.objection_window_minutes,
        "auto_closable": bool(entry.enabled),
    }


def _asset_cidr(case: Any, prefs: Any) -> dict[str, Any] | None:
    """The internal network range of TODAY's ``prefs.asset_networks`` that holds the
    case's entity IP, or ``None`` (not an IP, no range holds it, or the recorded score
    matched an exact asset entry). When several ranges hold it, the one whose
    criticality is the recorded asset value wins (the score used the highest), then the
    highest. Labelled ``current configuration``: the range in force at scoring is never
    stored (SPEC Appendix C, C5), so ``matches_recorded`` says whether today's range
    gives the criticality the score recorded."""
    try:
        addr = ipaddress.ip_address(str(case.entity.value if case.entity else ""))
    except ValueError:
        return None
    inputs = getattr(case.risk_breakdown, "inputs", None)
    if inputs is not None and inputs.asset_match != "network":
        return None
    holding: list[tuple[str, float]] = []
    for net in getattr(prefs, "asset_networks", None) or []:
        try:
            if addr in ipaddress.ip_network(net.cidr, strict=False):
                holding.append((str(net.cidr), float(net.criticality)))
        except ValueError:
            continue
    if not holding:
        return None
    recorded = float(inputs.asset_value) if inputs is not None else None
    exact = [item for item in holding if recorded is not None and item[1] == recorded]
    cidr, criticality = exact[0] if exact else max(holding, key=lambda item: item[1])
    return {
        "cidr": cidr,
        "criticality": criticality,
        "label": "current configuration",
        "matches_recorded": (criticality == recorded) if recorded is not None else None,
    }


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
    request: Request,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """A TYPED ReAct span timeline for a case (the ``TraceSpan`` shape).

    Assembled from the already-recorded ``tlsoc-agent-audit`` rows (oldest-first) +
    the per-case usage/cost ledger. Each audit row becomes ONE span classified by
    ``kind`` (invoke_agent | chat | execute_tool | decision) with ``step_index`` /
    ``latency`` / ``cost`` / ``tokens`` / ``trusted``. The ``case_manager`` DECISION
    is rendered as a distinct TERMINAL ``decision`` span reporting the decision as it was
    RECORDED (its time, result, decider, rationale and the gate the run recorded, Round
    16 B63), with today's policy beside it; it mutates nothing (#3 made visible).

    TRUSTED agent prose (router/investigator/formatter/decision) vs UNTRUSTED tool/log
    payloads (es_query / tool output) are separated by the per-span ``trusted`` flag
    (#9). NEVER 404s: an unknown or not-yet-investigated case returns empty spans.
    ``prompt_excerpt`` text is dropped from a span summary when
    ``prefs.trace.include_prompts`` is false (the untrusted-prompt toggle).

    The cost and tokens come from the usage ledger, which ``cost:view`` governs (the
    grant ``GET /api/usage/summary?case_id=`` needs): for a caller without it the
    ledger is not read, every span's ``cost`` and ``tokens`` are ``null`` and so are
    ``totals.cost`` and ``totals.tokens``.

    Round 16 (SPEC §4.5 WP10, [dv] R4 and R14): a span's ``kind`` says who acted
    (``person`` for a person's row, ``chat`` for case chat, ``system`` for a
    deterministic actor, else the agent kinds); ``detail`` carries the bounded audit
    record behind it; ``cost_basis`` is ``exact`` when the span carries its own call's
    cost and latency from the ledger and ``split`` when a role's total is shared evenly
    across its steps. ``rows_total`` and ``truncated`` say when the trace shows only
    the newest records of a long-lived case."""
    rows = await state.audit.records_for_case(case_id)
    rows_total, rows_relation = await _audit_row_total(state, case_id)
    truncated = _trace_truncated(len(rows), rows_total)
    include_prompts = getattr(state.prefs.trace, "include_prompts", True)

    # Per-role cost/token attribution from the usage ledger (aggregate → per-span).
    # Round 14 roles-11: one rule for AI spend, so only a cost:view holder reads it.
    show_usage = await has_permission(request, "cost", "view")
    usage = await _usage_attribution(state, case_id) if show_usage else _UsageAttribution()

    # Count the audit LLM rows (PROMPT + VERDICT) per role from the SAME rows the spans
    # are built from. The role's ledger TOTAL is split across exactly the spans that
    # receive a slice — NOT the ledger call count — so the per-role span sum reconciles
    # with the ledger for any N (a single-call normal run AND a multi-step ReAct loop).
    # See routes_triage tests test_timeline_totals_reconcile_*.
    audit_llm_rows_by_role = _count_llm_rows_by_role(rows)
    exact_calls = usage.exact_calls(
        audit_llm_rows_by_role, audit_complete=not truncated,
        row_times_by_role=_llm_row_times_by_role(rows),
    )

    spans: list[TraceSpan] = []
    step = 0
    seen_by_role: dict[str, int] = {}
    for row in rows:
        # The case_manager DECISION row is rendered as a distinct terminal span below,
        # from the recorded decision; skip the raw audit projection for it here.
        actor = str(_get(row, "actor", ""))
        at = str(_get(row, "action_type", "") or "")
        if actor == "case_manager" and at == ActionType.DECISION.value:
            continue
        call = None
        if at in _LLM_ROW_ACTIONS and actor in exact_calls:
            index = seen_by_role.get(actor, 0)
            seen_by_role[actor] = index + 1
            call = exact_calls[actor][index]
        span = _row_to_span(case_id, row, step, include_prompts,
                            usage.cost_by_role, usage.tokens_by_role, audit_llm_rows_by_role,
                            call=call)
        spans.append(span)
        step += 1

    # --- the distinct TERMINAL decision span (the recorded decision, B63) ---------------
    case = await state.cases.get(case_id)
    decision_span = _decision_span(case_id, case, state, step, rows)
    if decision_span is not None:
        spans.append(decision_span)

    return {
        "case_id": case_id,
        "spans": [s.model_dump(mode="json") for s in spans],
        "total": len(spans),
        "totals": {
            "cost": round(sum(s.cost or 0.0 for s in spans), 6) if show_usage else None,
            "tokens": sum(s.tokens or 0 for s in spans) if show_usage else None,
        },
        "returned": len(rows),
        "rows_total": rows_total,
        "rows_total_relation": rows_relation,
        "truncated": truncated,
    }


# --------------------------------------------------------------------------- #
# Helpers — pure projection (defensive; never raise)
# --------------------------------------------------------------------------- #
def _get(row: Any, key: str, default: Any = None) -> Any:
    """Read a field from an audit row that may be a dict OR a pydantic AuditDoc."""
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


#: ``records_for_case`` returns at most this many audit rows (the newest ones).
TRACE_ROW_CAP = 500
#: A case's audit rows are counted exactly up to this many.
TRACE_COUNT_CAP = 100_000


async def _audit_row_total(state: Any, case_id: str) -> tuple[int | None, str | None]:
    """``(rows_total, relation)`` of a case's audit rows ([dv] R14): exact up to
    :data:`TRACE_COUNT_CAP` (``eq``), else ``gte``; ``(None, None)`` when the store
    cannot count, so the total reads unknown and is never a guess."""
    try:
        total, relation = await state.audit.count_for_case(case_id, cap=TRACE_COUNT_CAP)
    except Exception:  # noqa: BLE001 (the trace never fails on a count)
        return None, None
    return int(total), str(relation)


def _trace_truncated(returned: int, rows_total: int | None) -> bool:
    """Whether the trace shows only the newest records: more rows exist than were
    returned, or (when the total is unknown) the read hit its cap."""
    if rows_total is None:
        return returned >= TRACE_ROW_CAP
    return rows_total > returned


def _row_dict(row: Any) -> dict[str, Any]:
    if isinstance(row, dict):
        return row
    dump = getattr(row, "model_dump", None)
    return dump(mode="json") if callable(dump) else {}


def _parse_ts(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


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


def _llm_row_times_by_role(rows: Any) -> dict[str, list[datetime | None]]:
    """The times of the LLM-producing audit rows per actor role, in row order (the
    same rows :func:`_count_llm_rows_by_role` counts), so an exact cost pairing can
    check that no other row of the role sits between a call and its own row."""
    by_role: dict[str, list[datetime | None]] = {}
    for row in rows:
        actor = str(_get(row, "actor", "") or "")
        at = str(_get(row, "action_type", "") or "")
        if actor == "case_manager" and at == ActionType.DECISION.value:
            continue
        if at in _LLM_ROW_ACTIONS:
            by_role.setdefault(actor, []).append(_parse_ts(_get(row, "ts")))
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


#: The structured action of a person reading a case's raw events (WP13): a person's
#: span, never a step of the investigation.
EVENTS_VIEWED_ACTION = "case.events_viewed"


def _span_kind(row: Any) -> tuple[str, str | None]:
    """``(kind, actor_type)`` of an audit row ([dv] R4): who acted first, then what.

    A person's row (``actor_type`` ``human``, recorded or derived for a legacy row from
    the one actor table, ``audit/event_categories.json``) is ``person``, so the trace
    never credits a person's work to the AI; a case-chat row (actor ``chat`` or surface
    ``chat``) is ``chat``; a tool or query row is ``execute_tool``; another row of a
    deterministic actor (``system`` or ``service``) is ``system``; everything else is
    ``invoke_agent``. The case_manager decision is the separate ``decision`` span."""
    doc = _row_dict(row)
    try:
        actor_type, _derived = derive_actor_type(doc)
    except Exception:  # noqa: BLE001 (classification never fails the trace)
        actor_type = None
    actor = str(doc.get("actor") or "")
    at = str(doc.get("action_type") or "")
    if actor_type == "human":
        return "person", actor_type
    if actor == "chat" or str(doc.get("surface") or "") == "chat":
        return "chat", actor_type
    kind = _KIND_BY_ACTION.get(at, "invoke_agent")
    if kind == "invoke_agent" and actor_type in ("system", "service"):
        return "system", actor_type
    return kind, actor_type


def _bounded_text(value: Any, limit: int = TRACE_DETAIL_TEXT_CHARS) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    text = str(value)
    if len(text) <= limit:
        return text, False
    return text[:limit], True


def _bounded_json(value: Any, limit: int = TRACE_DETAIL_TOOL_INPUT_BYTES) -> tuple[Any, bool]:
    """The recorded tool input as JSON of at most ``limit`` bytes: the value itself when
    it fits, else the first ``limit`` bytes of its JSON text (a string) and ``True``."""
    if value is None:
        return None, False
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        text = json.dumps(str(value), ensure_ascii=False)
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return json.loads(text), False
    return raw[:limit].decode("utf-8", errors="ignore"), True


def _span_detail(row: Any, include_prompts: bool) -> TraceSpanDetail:
    """The bounded audit record behind one span (SPEC §4.5 WP10 "Trace"). The query,
    the tool output and the prompt excerpt can carry fenced UNTRUSTED log data: the
    Console renders them as code or text (#9). The prompt excerpt is present only when
    ``prefs.trace.include_prompts`` is on."""
    tool_input, cut_input = _bounded_json(_get(row, "tool_input"))
    query, cut_query = _bounded_text(_get(row, "query_text"))
    output, cut_output = _bounded_text(_get(row, "tool_output_summary"))
    prompt, cut_prompt = (
        _bounded_text(_get(row, "prompt_excerpt")) if include_prompts else (None, False)
    )
    result, cut_result = _bounded_text(_get(row, "result_summary"))

    def _plain(key: str) -> str | None:
        value = _get(row, key)
        return str(value) if value not in (None, "") else None

    return TraceSpanDetail(
        tool_input=tool_input,
        query_text=query,
        tool_output_summary=output,
        prompt_excerpt=prompt,
        result_summary=result,
        outcome=_plain("outcome"),
        run_id=_plain("run_id"),
        app_version=_plain("app_version"),
        build_sha=_plain("build_sha"),
        truncated=any((cut_input, cut_query, cut_output, cut_prompt, cut_result)),
    )


def _row_to_span(
    case_id: str,
    row: Any,
    step: int,
    include_prompts: bool,
    cost_by_role: dict[str, float],
    tokens_by_role: dict[str, int],
    llm_rows_by_role: dict[str, int],
    *,
    call: dict[str, Any] | None = None,
) -> TraceSpan:
    """Project one audit row into a typed TraceSpan.

    Classifies the span ``kind``, marks tool/log payloads UNTRUSTED (#9), and
    attributes a per-role cost/token slice from the usage ledger to the LLM-producing
    rows (PROMPT/VERDICT). The slice divisor is the per-role COUNT of those same audit
    rows (``llm_rows_by_role``) — NOT the ledger call count — so the per-role span sum
    reconciles with the ledger for both a single-call run and a multi-step ReAct loop.
    ``call`` is this row's own ledger row when the role has exactly one call per row
    (``cost_basis: exact``, with the call's latency); otherwise the row takes its even
    slice (``cost_basis: split``). The ``summary`` carries SHORT prose only; the
    bounded record behind it is the span's ``detail``."""
    actor = str(_get(row, "actor", "") or "")
    at = str(_get(row, "action_type", "") or "")
    kind, actor_type = _span_kind(row)
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
    elif str(_get(row, "action") or "") == EVENTS_VIEWED_ACTION:
        # A person reading the raw events of the case (WP13): our own wording.
        summary = "A person viewed the case events."
    else:
        # TRUSTED agent prose. Drop the untrusted prompt excerpt unless allowed.
        summary = result_summary
        if not summary and at == ActionType.PROMPT.value and include_prompts:
            summary = str(_get(row, "prompt_excerpt") or "")
        if not summary:
            summary = f"{actor or kind} step"

    # Cost / token attribution: only LLM-producing rows (a PROMPT or VERDICT by an LLM
    # role) take a slice of that role's ledger total (split evenly across that role's
    # LLM AUDIT ROWS so per-case totals reconcile with the ledger, see #6), or their
    # own call's cost when the ledger names it (``call``).
    cost = None
    tokens = None
    latency_ms = None
    cost_basis = None
    model = _get(row, "model")
    is_llm_row = at in _LLM_ROW_ACTIONS
    if is_llm_row and call is not None:
        cost = round(float(call.get("cost") or 0.0), 6)
        tokens = int(call.get("total_tokens") or 0)
        latency = call.get("latency_ms")
        latency_ms = int(latency) if isinstance(latency, (int, float)) else None
        cost_basis = "exact"
    elif is_llm_row and actor in cost_by_role:
        n = max(1, llm_rows_by_role.get(actor, 1))
        cost = round(cost_by_role.get(actor, 0.0) / n, 6)
        tokens = int(tokens_by_role.get(actor, 0) / n)
        cost_basis = "split"

    return TraceSpan(
        case_id=case_id,
        step_index=step,
        kind=kind,
        name=(actor or at or kind),
        ts=str(_get(row, "ts", "") or ""),
        latency_ms=latency_ms,
        cost=cost,
        tokens=tokens,
        trusted=not untrusted,
        summary=summary[:2000],
        payload_ref={
            "action_type": at,
            "actor": actor,
            "actor_type": actor_type,
            "action": (str(_get(row, "action")) if _get(row, "action") else None),
            "model": model,
            "tool_name": tool_name or None,
        },
        detail=_span_detail(row, include_prompts),
        cost_basis=cost_basis,
    )


#: Where a decision span's facts come from: the decision recorded at the time, or a
#: read-time re-derivation with today's policy for a case that recorded none.
DECISION_RECORDED = "recorded"
DECISION_REDERIVED = "rederived_current_policy"
#: The keys of the gate the pipeline records on the case_manager DECISION row.
GATE_KEYS = (
    "verdict", "confidence", "risk_score", "class_enabled", "min_confidence",
    "max_risk_score", "objection_window_minutes", "escalation_confidence",
    "critical_severity", "outcome", "demo",
)
#: The summary of a decision span for a run that failed after the last decision.
_FAILED_RUN_SUMMARY = "The investigation failed, so code routed the case to a person."


def _last_decision_entry(case: Any) -> dict[str, Any] | None:
    """The newest ``{"event": "decision"}`` entry ``case_manager.apply()`` appended to
    the case's history (a re-investigation appends a new one), or ``None``."""
    for entry in reversed(list(getattr(case, "history", None) or [])):
        if isinstance(entry, dict) and entry.get("event") == "decision":
            return entry
    return None


def _gate_row(rows: Any, run_id: Any) -> Any:
    """The ``case_manager`` DECISION row of the run ``run_id`` (Appendix C, C18), or
    ``None``. One run writes several DECISION rows (the reinvestigate request, the
    no-change row, the attach-only row, the runbook selection); only the case_manager
    row carries the gate, and only the run id pairs it with the history entry."""
    if not isinstance(run_id, str) or not run_id:
        return None
    for row in reversed(list(rows or [])):
        if (
            str(_get(row, "actor", "") or "") == "case_manager"
            and str(_get(row, "action_type", "") or "") == ActionType.DECISION.value
            and _get(row, "run_id") == run_id
        ):
            return row
    return None


def _recorded_gate(row: Any) -> dict[str, Any] | None:
    tool_input = _get(row, "tool_input") if row is not None else None
    gate = tool_input.get("gate") if isinstance(tool_input, dict) else None
    if not isinstance(gate, dict):
        return None
    return {key: gate.get(key) for key in GATE_KEYS}


def _failed_after(rows: Any, case: Any, since: Any) -> str | None:
    """The time of a failed investigation run after ``since`` (the recorded decision;
    ``None`` when the case recorded none, so any failure counts), or ``None``. A failed
    run routes the case to a person without a decision entry
    (``pipeline._fail_to_human_case``), so the recorded decision would otherwise speak
    for a later run that never decided anything, and a case whose first run failed
    would read as a decision re-derived with today's policy."""
    if getattr(case, "verdict", None) != Verdict.NEEDS_HUMAN:
        return None
    floor = _parse_ts(since)
    newest: tuple[datetime, str] | None = None
    for row in rows or []:
        if str(_get(row, "actor", "") or "") != "pipeline":
            continue
        if str(_get(row, "action_type", "") or "") != ActionType.ERROR.value:
            continue
        if not str(_get(row, "result_summary", "") or "").startswith("pipeline error"):
            continue
        at = _parse_ts(_get(row, "ts"))
        if at is None or (floor is not None and at <= floor):
            continue
        if newest is None or at > newest[0]:
            newest = (at, str(_get(row, "ts")))
    return newest[1] if newest is not None else None


def _decision_span(
    case_id: str, case: Any, state: Any, step: int, rows: Any = None,
) -> TraceSpan | None:
    """The distinct TERMINAL ``decision`` span: the decision RECORDED for the case
    (Round 16 B63, research explainability D1).

    The span reads the newest ``decision`` entry of ``case.history`` (its ``ts``,
    ``rationale``, ``status``, ``decision_by`` and ``escalate``) and the case's stored
    ``objection_window_expires_at``, marked ``source: recorded``. The thresholds come
    from the gate recorded on the ``case_manager`` DECISION row of the same run
    (``gate_source: recorded``), or, for a decision made before the gate was recorded,
    from today's policy (``gate_source: rederived_current_policy``). ``current_policy``
    is today's clause with what today's policy decides for the same inputs, and
    ``policy_changed`` says whether that differs from the recorded decision. A case
    whose newest run failed after the decision, or whose first run failed before any
    decision, reports that routing (``run_failed``). ``decide()`` runs as the decision
    only when the case recorded neither, marked ``source: rederived_current_policy``
    with no time.

    Returns None for a case with neither a recorded decision nor a verdict. Always
    ``trusted`` (our own deterministic prose). MUTATES NOTHING (``decide()`` is pure)."""
    if case is None:
        return None
    prefs = getattr(state, "execution_prefs", None) or state.prefs
    entry = _last_decision_entry(case)
    if entry is None and case.verdict is None:
        return None
    clause = _policy_clause(case.verdict, prefs)
    gate_row = _gate_row(rows, entry.get("run_id")) if entry is not None else None
    gate = _recorded_gate(gate_row)
    detail = None
    if gate_row is not None:
        detail = _span_detail(gate_row, include_prompts=False).model_copy(
            update={"result_summary": None}
        )

    def _today(verdict: Any, confidence: Any, risk: Any) -> Any:
        return decide(
            verdict, float(confidence or 0.0), float(risk or 0.0), prefs.auto_close,
            escalation_confidence=prefs.escalation_confidence,
            critical_severity=prefs.critical_severity,
        )

    payload: dict[str, Any] = {
        "deterministic": True,
        "verdict": case.verdict.value if case.verdict else None,
        "confidence": round(float(case.confidence), 4),
        "risk_score": round(float(case.risk_score), 2),
        "objection_window_expires_at": case.objection_window_expires_at,
        "policy_clause": clause,
        "policy_clause_basis": "current_policy",
        "gate": gate,
        "gate_source": DECISION_RECORDED if gate is not None else DECISION_REDERIVED,
        "run_id": entry.get("run_id") if entry is not None else None,
        "run_failed": False,
    }
    # A failure after the recorded decision, or any failure of a case that recorded no
    # decision (its first run failed): the run that failed is what routed it.
    failed_at = _failed_after(rows, case, entry.get("ts") if entry is not None else None)
    if failed_at is not None:
        payload.update({
            "source": DECISION_RECORDED,
            "decision_status": CaseStatus.NEEDS_HUMAN.value,
            "decision_by": DecisionBy.SYSTEM.value,
            "escalate": False,
            "ts": failed_at,
            "gate": None,
            "gate_source": None,
            "run_failed": True,
            "current_policy": None,
            "policy_changed": None,
        })
        summary, ts, detail = _FAILED_RUN_SUMMARY, failed_at, None
    elif entry is not None:
        recorded_status = str(entry.get("status") or "")
        recorded_by = str(entry.get("decision_by") or "")
        if gate is not None and gate.get("verdict") is not None:
            try:
                verdict_in = Verdict(gate["verdict"])
            except ValueError:
                verdict_in = case.verdict
            today = _today(verdict_in, gate.get("confidence"), gate.get("risk_score"))
        else:
            today = _today(case.verdict, case.confidence, case.risk_score)
        payload.update({
            "source": DECISION_RECORDED,
            "decision_status": recorded_status,
            "decision_by": recorded_by,
            "escalate": bool(entry.get("escalate")),
            "ts": entry.get("ts"),
            "current_policy": {
                **clause,
                "decision_status": today.status.value,
                "decision_by": today.decision_by.value,
            },
            "policy_changed": (
                today.status.value != recorded_status or today.decision_by.value != recorded_by
            ),
        })
        summary, ts = str(entry.get("rationale") or ""), str(entry.get("ts") or "")
    else:
        # A case that recorded no decision (written before decision entries existed):
        # re-derived with today's policy, said so, and never given a time.
        decision = _today(case.verdict, case.confidence, case.risk_score)
        payload.update({
            "source": DECISION_REDERIVED,
            "decision_status": decision.status.value,
            "decision_by": decision.decision_by.value,
            "escalate": decision.escalate,
            "ts": None,
            "current_policy": {
                **clause,
                "decision_status": decision.status.value,
                "decision_by": decision.decision_by.value,
            },
            "policy_changed": None,
        })
        summary, ts = decision.rationale, ""
    return TraceSpan(
        case_id=case_id,
        step_index=step,
        kind="decision",
        name="case_manager",
        ts=ts,
        latency_ms=None,
        cost=0.0,         # the deterministic decision costs nothing (no LLM call)
        tokens=0,
        trusted=True,     # our own deterministic rationale — never untrusted log data
        summary=summary,
        payload_ref=payload,
        detail=detail,
        cost_basis="exact",
    )


def _policy_clause(verdict: Any, prefs: Any) -> dict[str, Any]:
    """Today's AutoClosePolicy clause for this verdict class (the thresholds the
    deterministic truth table compares against). Read-only display of config, labelled
    "current policy" by the caller; the clause a decision used is its recorded gate."""
    entry = None
    if verdict == Verdict.FALSE_POSITIVE:
        entry = prefs.auto_close.false_positive
    elif verdict == Verdict.TRUE_POSITIVE:
        entry = prefs.auto_close.true_positive
    if entry is None:
        # NEEDS_HUMAN / unknown verdict: code-enforced, never auto-closable.
        return {
            "verdict_class": (verdict.value if verdict else None),
            "auto_closable": False,
            "note": "A needs-human verdict never closes automatically. Code enforces this.",
        }
    return {
        "verdict_class": verdict.value,
        "enabled": entry.enabled,
        "min_confidence": entry.min_confidence,
        "max_risk_score": entry.max_risk_score,
        "objection_window_minutes": entry.objection_window_minutes,
        "auto_closable": bool(entry.enabled),
    }


#: The ledger window that covers a case's whole life ([dv] R14): 50 years, so the
#: window start stays after 1970 on every store, where the old one-year window dropped
#: the spend of a case older than a year.
LIFETIME_USAGE_WINDOW_HOURS = 24 * 365 * 50
#: ``records_for_case`` on the usage ledger returns at most this many calls.
USAGE_ROW_CAP = 500


class _UsageAttribution:
    """A case's ledger spend for the trace: per-role totals (the even split) and, when
    the ledger read was complete, each role's calls oldest first (the exact match)."""

    __slots__ = ("cost_by_role", "tokens_by_role", "calls_by_role", "calls_complete")

    def __init__(self) -> None:
        self.cost_by_role: dict[str, float] = {}
        self.tokens_by_role: dict[str, int] = {}
        self.calls_by_role: dict[str, list[dict[str, Any]]] = {}
        self.calls_complete = False

    def exact_calls(
        self, llm_rows_by_role: dict[str, int], *, audit_complete: bool,
        row_times_by_role: dict[str, list[datetime | None]] | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """The roles whose LLM audit rows can each be paired with their own call: both
        reads complete, exactly one call per row, and no other row of the role between a
        call and the row it is paired with (a router prompt is written just before its
        call, a formatter prompt just after it). Equal counts alone prove nothing: a
        three-call run and a one-call run give four calls for four rows, and pairing
        them by position would give a later run's prompt an earlier run's call. Every
        other role keeps the even split."""
        if not (audit_complete and self.calls_complete):
            return {}
        times = row_times_by_role or {}
        return {
            role: calls for role, calls in self.calls_by_role.items()
            if role in self.cost_by_role
            and len(calls) == llm_rows_by_role.get(role, 0) > 0
            and _calls_pair_with_their_rows(times.get(role) or [], calls)
        }


def _calls_pair_with_their_rows(row_times: list[datetime | None], calls: list[dict[str, Any]]) -> bool:
    """Whether the i-th call of a role (oldest first) sits between the role's LLM audit
    rows i-1 and i+1, for every i: no other row of the role separates a call from the
    row it is paired with, whether the row is written before its call or after it. A
    row or call without a readable time fails."""
    if len(row_times) != len(calls) or any(at is None for at in row_times):
        return False
    for index, call in enumerate(calls):
        call_at = _parse_ts(call.get("ts"))
        if call_at is None:
            return False
        before = row_times[index - 1] if index > 0 else None
        after = row_times[index + 1] if index + 1 < len(row_times) else None
        if (before is not None and call_at < before) or (after is not None and call_at > after):
            return False
    return True


async def _usage_attribution(state: Any, case_id: str) -> _UsageAttribution:
    """Per-role cost/token TOTALS for a case from the usage ledger (#6 source of truth),
    over the case's whole life, and its calls.

    The per-span divisor of the even split is the count of LLM AUDIT rows (see
    :func:`_count_llm_rows_by_role`), NOT the ledger call count; that is what makes the
    per-role span sum reconcile with the ledger for a multi-step ReAct run (N gateway
    calls metered, but only the PROMPT + VERDICT audit rows carry a slice). Defensive: a
    ledger miss degrades to empty maps (no cost shown), never raises. Reads only
    (``summary`` and ``records_for_case``); the gateway stays the single writer (#6)."""
    usage = _UsageAttribution()
    try:
        summary = await state.usage_store.summary(
            window_hours=LIFETIME_USAGE_WINDOW_HOURS, case_id=case_id,
        )
    except Exception:  # noqa: BLE001 — the timeline must never 500 on a ledger miss
        return usage
    for entry in (summary.get("by_role") or []):
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key", ""))
        if not key:
            continue
        usage.cost_by_role[key] = float(entry.get("cost", 0.0) or 0.0)
        usage.tokens_by_role[key] = int(entry.get("tokens", 0) or 0)
    try:
        calls = await state.usage_store.records_for_case(case_id, limit=USAGE_ROW_CAP)
    except Exception:  # noqa: BLE001 (a store without per-case reads keeps the split)
        return usage
    calls = [dict(c) for c in calls or [] if isinstance(c, dict)]
    usage.calls_complete = len(calls) < USAGE_ROW_CAP
    calls.sort(key=lambda c: (_parse_ts(c.get("ts")) or datetime.min.replace(tzinfo=timezone.utc)))
    for call in calls:
        usage.calls_by_role.setdefault(str(call.get("role") or ""), []).append(call)
    return usage


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


#: How far the weighted sum of the stored 2-decimal factors may sit from the stored
#: 2-decimal total when the weights are the recorded ones: each factor and the total
#: are rounded once (``compute_risk``), so the two agree within 0.01.
_RECORDED_ROUNDING_TOLERANCE = 0.01 + 1e-9


def _risk_calculation(case: Any, prefs: Any) -> StageRiskCalculation:
    """Expose the stored factor scores and the exact weighted arithmetic.

    This deliberately mirrors only the final weighted blend in ``compute_risk()``;
    it does not rescore, mutate, or feed a decision. Factor values come from the
    persisted ``Case.risk_breakdown``. Coefficients are the weights RECORDED when the
    case was scored (``risk_breakdown.inputs``, Round 16 B13; ``weight_basis:
    recorded_at_scoring``); a case scored before they were recorded uses the current
    Preferences (``current_preferences``), so a changed configuration can honestly
    produce a different recomputed value, called out through
    ``matches_displayed_score`` instead of concealed. With recorded weights the stored
    factors reproduce the stored score within the 0.01 of their own rounding, which
    counts as a match. The shown integer rounds half up (``utils.round_half_up``).
    """
    rb = case.risk_breakdown
    inputs = getattr(rb, "inputs", None)
    recorded_weights = inputs is not None
    weights = inputs.weights if recorded_weights else prefs.risk_weights
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
    displayed = round_half_up(recorded)
    matches = round_half_up(calculated) == displayed or (
        recorded_weights and abs(calculated - recorded) <= _RECORDED_ROUNDING_TOLERANCE
    )
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
        matches_displayed_score=matches,
        weight_basis="recorded_at_scoring" if recorded_weights else "current_preferences",
    )


def _runbook_steps(case: Any, selection_row: Any) -> list[StageStep]:
    """The Triage stage's runbook notes (Round 14 SPEC §4.10.9): which Published
    runbook guided the investigation (``Case.runbook_id``/``runbook_version``) and why
    the matcher chose it. A case investigated before Round 14 shows its stored
    ``playbook_id`` verbatim with the built-in that now covers it, if any. The title
    and version are our own reviewed text (trusted); the reason quotes matched rule
    values, which are log-derived, so it is untrusted plain text (#9)."""
    steps: list[StageStep] = []
    selection: dict[str, Any] = {}
    reason = ""
    legacy_row = selection_row is not None and _get(selection_row, "actor") == LEGACY_SELECTOR_ACTOR
    if selection_row is not None and not legacy_row:
        ti = _get(selection_row, "tool_input") or {}
        if isinstance(ti, dict):
            raw = ti.get("runbook_selection")
            selection = raw if isinstance(raw, dict) else {}
            reason = str(selection.get("reason") or ti.get("runbook_reason") or "")
    runbook_id = str(getattr(case, "runbook_id", None) or "")
    if runbook_id:
        version = getattr(case, "runbook_version", None)
        title = ""
        if str(selection.get("id") or "") == runbook_id:
            title = str(selection.get("title") or "")
        if not title:
            builtin = builtin_runbook(runbook_id)
            title = builtin.title if builtin is not None else runbook_id
        steps.append(StageStep(
            kind="note", label="runbook",
            body=f"{title} (version {version})" if version else title,
            trusted=True))
        if reason and str(selection.get("id") or "") == runbook_id:
            steps.append(StageStep(kind="note", label="why this runbook", body=reason, trusted=False))
        return steps
    legacy_id = str(getattr(case, "playbook_id", "") or "")
    if legacy_id:
        successor = resolve_legacy_runbook_id(legacy_id)
        builtin = builtin_runbook(successor) if successor else None
        body = legacy_id + (f". Now covered by the {builtin.title} runbook." if builtin else "")
        steps.append(StageStep(kind="note", label="runbook (before Round 14)", body=body, trusted=False))
        if legacy_row:
            legacy_reason = str(_get(selection_row, "result_summary", "") or "")
            if legacy_reason:
                steps.append(StageStep(kind="note", label="why this runbook", body=legacy_reason,
                                       trusted=False))
    return steps


def _build_stages(case_id: str, case: Any, rows: Any, state: Any) -> list[TimelineStage]:
    """Project a case + its audit rows into the six ordered narrative stages. Pure /
    read-time / mutates nothing (#3); untrusted source/log text is fenced in steps (#9)."""
    n = len(case.member_event_keys or case.member_event_ids) or len(case.evidence)
    plural = "s" if n != 1 else ""
    src = case.source_name or "the configured source"

    # The severity chip on the "Alert received" stage. ``Case.severity_band`` /
    # ``severity_source`` are READ-TIME presentation fields no production write path
    # persists, so reading them directly rendered an empty chip on every real case.
    # Resolve them from the same authority ``GET /api/cases`` uses, against the ACTIVE
    # execution prefs (so a demo sandbox bands identically here and in the case detail).
    # Advisory only — nothing here feeds ``decide()`` (#3); fail-open by construction.
    stage_prefs = getattr(state, "execution_prefs", None)
    sev_band = band_of_case(case, stage_prefs)
    sev_source = case.severity_source or advisory_bands(case, stage_prefs).get("severity_source")

    # 1 — input (the raw alert as the SIEM sent it)
    input_steps: list[StageStep] = []
    if case.evidence and getattr(case.evidence[0], "summary", ""):
        input_steps.append(StageStep(kind="note", label="evidence",
                                     body=str(case.evidence[0].summary), trusted=False))
    input_stage = TimelineStage(
        id="input", kind="input", label="Alert received", status="done", deterministic=False,
        ts=case.created_at or None,
        headline=(f"{n} alert{plural} from {src}" if n else f"Alert from {src}"),
        state=StageState(severity_band=sev_band, severity_source=sev_source),
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
        headline=f"Risk {round_half_up(float(case.risk_score))}/100",
        state=StageState(
            risk_score=round(float(case.risk_score), 2),
            # The active execution prefs (Round 16 R16): Demo Mode reads its sandbox.
            risk_calculation=_risk_calculation(case, stage_prefs or state.prefs),
        ),
        steps=([StageStep(kind="note", label="risk factors", body=" · ".join(nz), trusted=True)] if nz else []),
    )

    # Extract the "why" pieces from the SAME audit rows the rationale endpoint reads:
    # CONTEXT.tool_input → knowledge/memory/enrichment (the basis given); TOOL_CALL/
    # ES_QUERY → commands run; VERDICT "reasoning=" → the reasoning excerpt; the
    # latest selection DECISION → why that runbook (``runbook_selector``; the
    # ``playbook_selector`` row of an investigation before Round 14). Self-contained;
    # pure/defensive.
    knowledge: list[dict[str, str]] = []
    memory_facts: list[str] = []
    enrichment: dict[str, Any] | None = None
    tool_rows: list[Any] = []
    reasoning = ""
    selection_row: Any = None
    context_seen = False
    for row in rows:
        at = str(_get(row, "action_type", "") or "")
        if is_selection_row(row):
            selection_row = row
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

    # 4: triage (specialist routing and the basis given: runbook and operator memory)
    persona = case.agent_persona or ""
    triage_steps = _runbook_steps(case, selection_row)
    triage_steps.extend(StageStep(kind="memory", label="memory", body=m, trusted=True)
                        for m in memory_facts)
    triage_done = bool(persona or triage_steps)
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
            f"Verdict: {_humanize(case.verdict.value).lower()} · conf "
            f"{round_half_up(float(case.confidence) * 100)}%")
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

    # 6: decide (the RECORDED decision, Round 16 B63; #3 made visible)
    dspan = _decision_span(case_id, case, state, 0, rows)
    if dspan is not None:
        pr = dspan.payload_ref
        decide_steps: list[StageStep] = []
        if dspan.summary:
            decide_steps.append(StageStep(kind="note", label="decision rationale",
                                          body=dspan.summary, trusted=True))
        if pr.get("source") == DECISION_REDERIVED:
            decide_steps.append(StageStep(
                kind="note", label="decision source", trusted=True,
                body="No decision was recorded for this case. This is re-derived with today's policy."))
        elif pr.get("policy_changed"):
            decide_steps.append(StageStep(
                kind="note", label="policy changed", trusted=True,
                body="Today's policy would decide differently for the same inputs."))
        decide_stage = TimelineStage(
            id="decide", kind="decide", label="Decision", status="done", deterministic=True,
            ts=dspan.ts or None, headline=_decide_headline(pr),
            state=StageState(verdict=pr.get("verdict"), confidence=pr.get("confidence"),
                             risk_score=pr.get("risk_score")),
            steps=decide_steps,
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
    → investigate → decide``. Advisory/observability ONLY: the Decision stage reports
    the recorded decision (Round 16 B63) and mutates nothing (#3); untrusted source/log
    text is fenced in steps (#9). NEVER 404s: an unknown case returns the six-stage
    skeleton. ``rows_total`` and ``truncated`` say when only the newest audit records
    were read."""
    case = await state.cases.get(case_id)
    if case is None:
        skeleton = [TimelineStage(id=k, kind=k, label=lbl, status="skipped", deterministic=det)
                    for k, lbl, det in _CANON_STAGES]
        return TimelineStagesResponse(case_id=case_id, stages=skeleton,
                                      total=len(skeleton)).model_dump(mode="json")
    rows = await state.audit.records_for_case(case_id)
    rows_total, rows_relation = await _audit_row_total(state, case_id)
    stages = _build_stages(case_id, case, rows, state)
    out = TimelineStagesResponse(case_id=case_id, stages=stages,
                                 total=len(stages)).model_dump(mode="json")
    # Round 16 ([dv] R14): whether the stages read only the newest audit records.
    out.update({
        "returned": len(rows),
        "rows_total": rows_total,
        "rows_total_relation": rows_relation,
        "truncated": _trace_truncated(len(rows), rows_total),
    })
    return out
