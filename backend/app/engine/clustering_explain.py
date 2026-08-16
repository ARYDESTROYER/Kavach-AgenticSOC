"""Read-only, redacted explanation of how a case's alerts were clustered.

The correlation engine already persists every deterministic input needed to explain
its work on :class:`app.models.Case`: the cluster signature, member-event identities,
trigger rule/window, and optional cross-source links.  This module projects those
fields into a small UI contract without returning raw event ids or source payloads.

The projection is advisory only.  It never re-runs correlation and never participates
in risk scoring or the deterministic close/escalate decision (#3).  Event references
are one-way stable hashes so an analyst can count and distinguish inputs while the
underlying source identifiers remain private (#9).
"""

from __future__ import annotations

from typing import Any

from ..constants import (
    CaseStatus,
    DecisionBy,
    TERMINAL_CASE_STATUSES,
    Verdict,
)
from ..models import Case
from ..utils import stable_signature

_MAX_INPUT_REFS = 12
_MAX_RELATED = 12


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value) or "")


def _member_inputs(case: Case) -> list[str]:
    """Return the best persisted member identities, with duplicates removed."""
    values = list(case.member_event_keys or case.member_event_ids or [])
    return list(dict.fromkeys(str(value) for value in values if str(value)))


def _safe_ref(value: str) -> str:
    """Opaque but stable analyst-facing reference; never reveal the source id."""
    return f"alert-{stable_signature('cluster-input', value)[:12]}"


def build_clustering_explanation(
    case: Case,
    *,
    related_cases: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a truthful, bounded alert → cluster → case explanation.

    Old cases may lack member identities and/or ``trigger_reason``.  The response says
    exactly which details are available instead of fabricating missing nodes.  Related
    cases combine explicit cross-source links with resolved same-entity recall supplied
    by the threat-context assembler.
    """
    members = _member_inputs(case)
    trigger = case.trigger_reason
    observed = int(getattr(trigger, "observed_count", 0) or 0)
    input_count = len(members) or observed

    source_breakdown = {
        str(source): max(0, int(count or 0))
        for source, count in sorted((case.source_breakdown or {}).items())
        if str(source)
    }
    if not source_breakdown and case.source_id and input_count:
        source_breakdown = {case.source_id: input_count}

    explicit_related = [
        {
            "case_id": case_id,
            "relationship": "cross_source",
            "reason": "Same entity linked by the configured cross-source correlation window.",
        }
        for case_id in dict.fromkeys(case.related_case_ids or [])
        if case_id and case_id != case.case_id
    ]
    seen = {row["case_id"] for row in explicit_related}
    recalled: list[dict[str, Any]] = []
    for row in related_cases or []:
        case_id = str(row.get("case_id") or "")
        if not case_id or case_id == case.case_id or case_id in seen:
            continue
        seen.add(case_id)
        recalled.append({
            "case_id": case_id,
            "relationship": "same_entity_history",
            "reason": "Prior resolved case matched this case entity.",
            "verdict": str(row.get("verdict") or ""),
        })

    rule_values = list(dict.fromkeys(
        str(value)
        for value in (getattr(trigger, "rule_values", None) or case.rule_ids or [])
        if str(value)
    ))
    cluster_id = str(case.cluster_signature or "")
    return {
        "available": bool(cluster_id or input_count or trigger),
        "cluster_id": cluster_id,
        "input_count": input_count,
        "input_refs": [_safe_ref(value) for value in members[:_MAX_INPUT_REFS]],
        "input_refs_truncated": max(0, len(members) - _MAX_INPUT_REFS),
        "source_count": max(len(source_breakdown), 1 if case.source_id else 0),
        "source_breakdown": source_breakdown,
        "correlation": {
            "mode": str(getattr(trigger, "mode", "") or ""),
            "threshold": int(getattr(trigger, "n", 0) or 0),
            "window_seconds": int(getattr(trigger, "window_seconds", 0) or 0),
            "group_by": str(getattr(trigger, "group_by", "") or ""),
            "observed_count": observed,
            "window_start": int(getattr(trigger, "window_start", 0) or 0),
            "window_end": int(getattr(trigger, "window_end", 0) or 0),
            "matched_rule": str(getattr(trigger, "rule_value", "") or ""),
            "rule_values": rule_values,
            "reason": str(getattr(trigger, "sentence", "") or ""),
        },
        "opened_case": {
            "case_id": case.case_id,
            "display_id": case.case_number or case.case_id,
            "status": _enum_value(case.status),
            "verdict": _enum_value(case.verdict),
        },
        "cross_source_cluster_id": str(case.cross_source_cluster_id or ""),
        "related_cases": (explicit_related + recalled)[:_MAX_RELATED],
        "limitations": (
            "Alert references are redacted stable identifiers; raw alert payloads are not returned."
        ),
    }


def _was_escalated(case: Case) -> bool:
    """Whether the persisted lifecycle ever entered the escalated state.

    This is a read-only presentation helper.  It deliberately reads only the
    already-persisted status trail and never feeds the deterministic decision.
    """
    if _enum_value(case.status) == CaseStatus.ESCALATED.value:
        return True
    if int(case.escalation_level or 0) > 0:
        return True
    return any(
        _enum_value(getattr(row, "to_status", "")) == CaseStatus.ESCALATED.value
        for row in (case.status_history or [])
    )


def build_case_lineage(case: Case) -> dict[str, Any]:
    """Project one persisted case into an inspectable funnel-lineage row.

    The clustering portion is the exact same bounded/redacted contract used by
    Threat Context.  ``outcome`` reports the case's *current persisted state*; an
    open case is explicitly non-terminal instead of being presented as closed.
    ``funnel_stage`` explains which aggregate terminal branch currently accounts
    for the row (all non-auto-cleared cases are routed to the analyst/escalated
    branch in the aggregate Noise Reduction view).
    """
    clustering = build_clustering_explanation(case)
    status = _enum_value(case.status)
    verdict = _enum_value(case.verdict)
    decision_by = _enum_value(case.decision_by)
    disposition = _enum_value(case.disposition)
    terminal = status in TERMINAL_CASE_STATUSES

    auto_cleared = (
        terminal
        and decision_by == DecisionBy.AGENT.value
        and verdict == Verdict.FALSE_POSITIVE.value
    )
    if decision_by == DecisionBy.ANALYST_POLICY.value:
        # Closed by an operator's analyst RULE POLICY. Explicitly its own outcome:
        # the generic terminal fallback below would label it "Closed by human", which
        # credits a person for work no person did on this case.
        outcome_key = "policy_closed"
        outcome_label = "Closed by analyst policy"
        funnel_stage = "policy_closed"
    elif auto_cleared:
        outcome_key = "auto_cleared"
        outcome_label = "Auto-cleared by AI"
        funnel_stage = "auto_cleared"
    elif terminal:
        outcome_key = "closed_by_human"
        outcome_label = "Closed by human"
        funnel_stage = "closed"
    elif _was_escalated(case):
        outcome_key = "escalated"
        outcome_label = "Escalated"
        funnel_stage = "escalated"
    else:
        outcome_key = "awaiting_analyst"
        outcome_label = "Awaiting analyst"
        funnel_stage = "escalated"

    return {
        "case_id": case.case_id,
        "display_id": case.case_number or case.case_id,
        "created_at": case.created_at,
        "severity": str(case.severity_band or ""),
        "clustering": clustering,
        "outcome": {
            "key": outcome_key,
            "label": outcome_label,
            "funnel_stage": funnel_stage,
            "terminal": terminal,
            "status": status,
            "verdict": verdict,
            "disposition": disposition,
            "decision_by": decision_by,
        },
    }
