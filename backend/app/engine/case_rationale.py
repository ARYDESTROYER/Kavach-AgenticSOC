"""Case explainability: the deterministic "why" projection of a case + its audit trail.

Moved unchanged from ``api/routes.py`` (chat revamp SPEC §5.3, "route-private helpers
move first") so the ``GET /api/cases/{id}/rationale`` route and the chat ``get_case``
tool share ONE projection and cannot drift. ``api.routes`` re-exports both names under
their historical underscore spellings (``_build_rationale``, ``_audit_get``) because
tests and route code import them from there.

Pure and defensive: no I/O, no model call (#6), never touches the deterministic
close/escalate decision (#3). Every audit-derived string it returns (queries, tool
summaries, reasoning, evidence) is log- or model-influenced and therefore UNTRUSTED for
any prompt (#9); fencing is the caller's job.
"""

from __future__ import annotations

from typing import Any

from ..constants import ActionType
from ..utils import parse_es_timestamp

__all__ = ["audit_get", "build_rationale"]


def audit_get(row: Any, key: str, default: Any = None) -> Any:
    """Read a field from an audit row that may be a dict OR a pydantic AuditDoc."""
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def build_rationale(case_id: str, case: Any, rows: list[Any]) -> dict[str, Any]:
    """Assemble the explainability "why" object from a case + its audit rows.

    Pure + defensive: any missing audit piece degrades to an empty value. Reads the
    CONTEXT record (knowledge/memory/enrichment), TOOL_CALL records (tools/queries),
    the VERDICT record (reasoning excerpt), the playbook_selector DECISION (playbook
    reason) and the case_manager DECISION (deterministic rationale)."""
    # Audit rows are OLDEST-first.  A case can be re-investigated many times, so
    # project only the LATEST run instead of mixing the first run's context/tools
    # with the current Case fields.  ``playbook_selector`` is the usual durable run
    # boundary (including the cheap path).  A failure can happen before selection,
    # though; in that case the terminal ``pipeline error:`` row must start a new run
    # rather than inheriting the previous run's measured retrieval or other artifacts.
    # The prefix deliberately excludes the non-terminal timeout ERROR row: timeout
    # handling continues to procedure provenance + the deterministic case-manager
    # decision in the SAME run.  Legacy audit histories without either boundary fall
    # back to their full history.
    run_start = 0
    run_boundary_reason = "historical_provenance_missing"
    last_selector = -1
    last_terminal = -1
    for idx, row in enumerate(rows):
        if audit_get(row, "actor") == "playbook_selector":
            run_start = idx
            run_boundary_reason = "historical_provenance_missing"
            last_selector = idx
        elif (
            audit_get(row, "actor") == "pipeline"
            and audit_get(row, "action_type") == ActionType.ERROR.value
            and str(audit_get(row, "result_summary") or "").startswith("pipeline error:")
        ):
            # No selector has appeared since the preceding completed run: this
            # failure itself is the latest run boundary.  If the current run DID
            # reach selection, retain that more informative boundary so any measured
            # retrieval completed before the later failure remains attributable.
            if last_selector <= last_terminal:
                run_start = idx
                run_boundary_reason = "pipeline_failed_before_provenance"
            last_terminal = idx
        elif (
            audit_get(row, "actor") == "case_manager"
            and audit_get(row, "action_type") == ActionType.DECISION.value
        ):
            last_terminal = idx

    # The fail-to-human Case is persisted before its terminal audit row. If that
    # best-effort append was lost but older audit history remains readable, an error
    # Case would otherwise inherit the preceding run. A newer Case timestamp is
    # positive evidence that the bounded audit trail has no boundary for this run;
    # fail closed to an empty/unavailable projection instead of guessing.
    case_error = str(audit_get(case, "error") or "").strip()
    case_updated_at = parse_es_timestamp(audit_get(case, "updated_at"))
    audit_times = [
        parsed
        for row in rows
        if (parsed := parse_es_timestamp(audit_get(row, "ts"))) is not None
    ]
    if case_error and case_updated_at is not None and (
        not audit_times or max(audit_times) < case_updated_at
    ):
        run_start = len(rows)
        run_boundary_reason = "pipeline_failure_provenance_missing"
    run_rows = rows[run_start:]

    selector_row = next(
        (row for row in reversed(run_rows) if audit_get(row, "actor") == "playbook_selector"),
        None,
    )
    context_row = next(
        (
            row
            for row in reversed(run_rows)
            if audit_get(row, "action_type") == ActionType.CONTEXT.value
            and audit_get(row, "actor") == "context"
        ),
        None,
    )
    procedure_row = next(
        (
            row
            for row in reversed(run_rows)
            if audit_get(row, "action_type") == ActionType.CONTEXT.value
            and audit_get(row, "actor") == "procedure_provenance"
        ),
        None,
    )

    # --- from the CONTEXT record (investigator-injected context) -------------
    knowledge: list[dict[str, Any]] = []
    memory_used: list[str] = []
    enrichment: dict[str, Any] | None = None
    playbook_id = ""
    playbook_version = ""
    playbook_consulted = False
    if context_row is not None:
        ti = audit_get(context_row, "tool_input") or {}
        if isinstance(ti, dict):
            for k in (ti.get("knowledge") or []):
                if isinstance(k, dict):
                    knowledge.append({
                        "source": str(k.get("source", "unknown")),
                        "snippet": str(k.get("snippet", "")),
                    })
            for m in (ti.get("memory") or []):
                if isinstance(m, str) and m.strip():
                    memory_used.append(m)
            enr = ti.get("enrichment")
            if isinstance(enr, dict):
                enrichment = {
                    "reputation_score": enr.get("reputation_score"),
                    "is_malicious": enr.get("is_malicious"),
                    "country": enr.get("country"),
                }
            detail = ti.get("playbook_detail")
            if isinstance(detail, dict) and str(detail.get("id") or "").strip():
                playbook_id = str(detail.get("id") or "").strip()
                playbook_version = str(detail.get("version") or "").strip()
                playbook_consulted = True
            elif ti.get("playbook"):
                # Backward compatibility for pre-structured CONTEXT rows.  The Case
                # id belongs to the latest run, and a truthy context value proves it
                # was actually injected (selection alone does not).
                playbook_id = str(getattr(case, "playbook_id", "") or "").strip()
                playbook_consulted = bool(playbook_id)

    # --- exact selected-vs-consulted procedure provenance ------------------
    # New runs write this independently of the legacy investigator CONTEXT row,
    # including cheap-router, kill-switch, and timeout paths where a persona or
    # playbook may be selected but never consulted.  Keep a stable empty shape for
    # old audit histories so consumers do not need to infer usage from Case fields.
    procedure_provenance: dict[str, Any] = {
        "persona": {"selected_id": "", "selection_reason": "", "consulted": False},
        "playbook": {"selected_id": "", "selection_reason": "", "consulted": False},
        "consultation_path": "",
        # Missing procedure telemetry is UNKNOWN, never a measured zero.
        "retrieval_status": "unavailable",
        "retrieval_reason": run_boundary_reason,
        "retrieval_query_groups": [],
        "knowledge": [],
    }
    if procedure_row is not None:
        procedure_input = audit_get(procedure_row, "tool_input") or {}
        if isinstance(procedure_input, dict):
            for key in ("persona", "playbook"):
                raw = procedure_input.get(key)
                if not isinstance(raw, dict):
                    continue
                procedure_provenance[key] = {
                    "selected_id": str(raw.get("selected_id") or ""),
                    "selection_reason": str(raw.get("selection_reason") or ""),
                    "consulted": bool(raw.get("consulted", False)),
                }
            procedure_provenance["consultation_path"] = str(
                procedure_input.get("consultation_path") or ""
            )
            raw_retrieval_status = str(
                procedure_input.get("retrieval_status") or "unavailable"
            )
            retrieval_status = (
                raw_retrieval_status
                if raw_retrieval_status
                in {"measured", "not_attempted", "unavailable"}
                else "unavailable"
            )
            procedure_provenance["retrieval_status"] = retrieval_status
            procedure_provenance["retrieval_reason"] = str(
                procedure_input.get("retrieval_reason")
                or (
                    "historical_provenance_missing"
                    if retrieval_status == "unavailable"
                    else ""
                )
            )
            for item in procedure_input.get("retrieval_query_groups") or []:
                if not isinstance(item, dict):
                    continue
                procedure_provenance["retrieval_query_groups"].append({
                    "group": str(item.get("group") or ""),
                    "query": str(item.get("query") or ""),
                })
            for item in procedure_input.get("knowledge") or []:
                if not isinstance(item, dict):
                    continue
                procedure_provenance["knowledge"].append({
                    "source": str(item.get("source") or "unknown"),
                    "score": item.get("score"),
                    "document_id": str(item.get("document_id") or ""),
                    "revision": item.get("revision"),
                    "content_hash": str(item.get("content_hash") or ""),
                    "query_groups": [
                        str(value)
                        for value in (item.get("query_groups") or [])
                        if str(value)
                    ],
                    "snippet": str(item.get("snippet") or ""),
                })

        # The explicit row is authoritative. A selected procedure on a cheap path
        # must not be resurrected as "used" from mutable Case fields or an older
        # context row. Structured knowledge also supersedes the legacy two-field list.
        playbook_provenance = procedure_provenance["playbook"]
        playbook_consulted = bool(playbook_provenance["consulted"])
        if playbook_consulted:
            playbook_id = str(playbook_provenance["selected_id"] or playbook_id)
        else:
            playbook_id = ""
            playbook_version = ""
        knowledge = list(procedure_provenance["knowledge"])

    # --- platform threshold tuning snapshot (run-boundary audit row) ---------
    platform_tuning_status = "not_recorded"
    platform_tuning: list[dict[str, Any]] = []
    if selector_row is not None:
        selector_input = audit_get(selector_row, "tool_input") or {}
        if isinstance(selector_input, dict):
            raw_tuning = selector_input.get("platform_tuning")
            if isinstance(raw_tuning, dict):
                raw_status = str(raw_tuning.get("status") or "not_recorded")
                if raw_status in {"recorded", "not_recorded", "unavailable"}:
                    platform_tuning_status = raw_status
                for item in raw_tuning.get("records") or []:
                    if not isinstance(item, dict):
                        continue
                    platform_tuning.append({
                        "record_id": str(item.get("record_id") or ""),
                        "target": str(item.get("target") or ""),
                        "rule_id": str(item.get("rule_id") or ""),
                        "before": item.get("before"),
                        "after": item.get("after"),
                        "applied_at": str(item.get("applied_at") or ""),
                        "rationale": str(item.get("rationale") or ""),
                    })

    # --- tools / queries (TOOL_CALL + ES_QUERY rows) -------------------------
    tools: list[dict[str, Any]] = []
    for row in run_rows:
        at = audit_get(row, "action_type")
        if at not in (ActionType.TOOL_CALL.value, ActionType.ES_QUERY.value):
            continue
        tools.append({
            "tool": audit_get(row, "tool_name") or (
                "es_query" if at == ActionType.ES_QUERY.value else ""
            ),
            "query": audit_get(row, "query_text") or "",
            "summary": audit_get(row, "tool_output_summary") or "",
        })

    # --- reasoning excerpt (VERDICT record, written after "reasoning=") -------
    reasoning = ""
    for row in reversed(run_rows):
        if audit_get(row, "action_type") != ActionType.VERDICT.value:
            continue
        rs = str(audit_get(row, "result_summary") or "")
        marker = "reasoning="
        if marker in rs:
            reasoning = rs.split(marker, 1)[1].strip()
        break

    # --- playbook reason (playbook_selector DECISION) ------------------------
    playbook_reason = ""
    if selector_row is not None:
        selector_input = audit_get(selector_row, "tool_input") or {}
        if isinstance(selector_input, dict):
            selection = selector_input.get("playbook_selection")
            if isinstance(selection, dict):
                playbook_reason = str(selection.get("reason") or "")
        if not playbook_reason:
            playbook_reason = str(audit_get(selector_row, "result_summary") or "")

    # --- deterministic decision rationale (case_manager DECISION, then the
    #     case.history "decision" event as a fallback) ------------------------
    decision_rationale = ""
    for row in reversed(run_rows):
        if (
            audit_get(row, "actor") == "case_manager"
            and audit_get(row, "action_type") == ActionType.DECISION.value
        ):
            decision_rationale = str(audit_get(row, "result_summary") or "")
            break

    # --- case-derived fields (defensive: case may be None) -------------------
    verdict = ""
    confidence = 0.0
    status = ""
    decision_by = None
    persona = ""
    mitre: list[str] = []
    evidence: list[dict[str, Any]] = []
    if case is not None:
        verdict = case.verdict.value if case.verdict else ""
        confidence = case.confidence
        status = case.status.value if case.status else ""
        decision_by = case.decision_by.value if case.decision_by else None
        persona = case.agent_persona or ""
        mitre = list(case.mitre or [])
        evidence = [
            {
                "summary": e.summary,
                "event_ids": list(e.event_ids or []),
                "query": e.query,
            }
            for e in (case.evidence or [])
        ]
        if not decision_rationale:
            for h in reversed(case.history or []):
                if isinstance(h, dict) and h.get("event") == "decision" and h.get("rationale"):
                    decision_rationale = str(h.get("rationale"))
                    break

    return {
        "case_id": case_id,
        "verdict": verdict,
        "confidence": confidence,
        "status": status,
        "decision_by": decision_by,
        "persona": persona,
        "procedure_provenance": procedure_provenance,
        "playbook": {
            "id": playbook_id,
            "version": playbook_version,
            "reason": playbook_reason,
            "consulted": playbook_consulted,
        },
        "memory_used": memory_used,
        "knowledge": knowledge,
        "platform_tuning_status": platform_tuning_status,
        "platform_tuning": platform_tuning,
        "enrichment": enrichment,
        "tools": tools,
        "reasoning": reasoning,
        "decision_rationale": decision_rationale,
        "mitre": mitre,
        "evidence": evidence,
    }
