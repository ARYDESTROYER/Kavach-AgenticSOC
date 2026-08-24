"""Investigator role — the ReAct loop (Section 6.4).

One strong generalist gathers evidence via read-only tools, reasons, and produces
a draft verdict, which the formatter then shapes. Per-case caps (tool calls,
tokens, kill switch) bound the loop so a malformed alert cannot cause runaway
spend (Section 6.3 #4). ANY failure returns NEEDS_HUMAN — never a dropped alert
(Section 6.7).
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..constants import ActionType, Role, ToolTier, Verdict
from ..engine.cost_gate import CaseBudget
from ..engine.precedent import PrecedentSignal
from ..llm.gateway import GatewayError, LLMGateway
from ..models import Cluster, EnrichmentResult, MemoryEntry, RagChunk, VerdictResult
from ..tools.base import ToolRegistry
from ..utils import extract_json, truncate
from .common import coerce_verdict, entity_kql
from .formatter import Formatter
from .personas import AgentPersona
from ..playbooks.manifest import render_playbook_prompt
from .prompts import (
    build_investigator_system,
    fence,
    fence_block,
    render_cluster,
    tool_defs_text,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..playbooks.manifest import Playbook

logger = logging.getLogger("tlsoc.agents.investigator")


def _context_summary(
    enrichment: EnrichmentResult | None,
    rag_chunks: list[RagChunk] | None,
    memory: list[MemoryEntry] | None,
    precedent: PrecedentSignal | None = None,
) -> str:
    """Compose a concise, human-readable summary of the context INJECTED into the
    investigation — the explainability backbone (the case-rationale "why").

    Captures, for the trace/rationale: the operator MEMORY facts consulted, the RAG
    knowledge retrieved (each chunk's ``source`` + a short snippet, e.g.
    "[runbook] internal scanner benign…"), and the IP enrichment (reputation /
    malicious / country). These are SUMMARIES — short snippets only, never raw
    attacker payloads — so the trace stays auditable without leaking unfenced data
    (#9). The whole string is bounded by the AuditLogger's truncate."""
    parts: list[str] = []

    facts = [m for m in (memory or []) if (m.text or "").strip()]
    if facts:
        sample = "; ".join(truncate(m.text, 80) for m in facts[:5])
        parts.append(f"memory({len(facts)}): {sample}")

    chunks = rag_chunks or []
    if chunks:
        knis = "; ".join(f"[{ch.source}] {truncate(ch.text, 80)}" for ch in chunks[:5])
        parts.append(f"knowledge({len(chunks)}): {knis}")

    if enrichment is not None:
        parts.append(
            f"enrichment: reputation={enrichment.reputation_score} "
            f"malicious={enrichment.is_malicious} country={enrichment.country}"
        )

    # The precedent status is recorded whether or not it qualified, so the trace can
    # show WHY promotion did not apply (insufficient / conflicting / not retrieved)
    # instead of leaving its absence unexplained.
    if precedent is not None and precedent.status not in ("disabled", "not_applicable"):
        parts.append(
            f"precedent({precedent.status}): "
            f"fp={precedent.confirmed_false_positive} tp={precedent.confirmed_true_positive} "
            f"retrieved={precedent.retrieved_matching}"
        )

    return " | ".join(parts) if parts else "no injected context"


class Investigator:
    def __init__(
        self,
        gateway: LLMGateway,
        tools: ToolRegistry,
        audit: AuditLogger,
        formatter: Formatter,
    ) -> None:
        self._gateway = gateway
        self._tools = tools
        self._audit = audit
        self._formatter = formatter

    async def investigate(
        self,
        cluster: Cluster,
        enrichment: EnrichmentResult | None,
        rag_chunks: list[RagChunk] | None,
        prefs: Preferences,
        budget: CaseBudget,
        *,
        surface: str,
        case_id: str | None = None,
        persona: AgentPersona | None = None,
        playbook: "Playbook | None" = None,
        memory: list[MemoryEntry] | None = None,
        precedent: PrecedentSignal | None = None,
        cost_sink: list[float] | None = None,
    ) -> tuple[VerdictResult, float]:
        cost = 0.0

        def _account(value: float) -> None:
            """Mirror each REALISED gateway cost into the optional ``cost_sink`` the
            moment it lands, so an outer timeout that cancels this coroutine mid-ReAct
            can still reconcile ``Case.token_cost`` with the spend already on the
            ledger. ``sum(cost_sink contributions) == cost`` on the normal path — the
            sink never substitutes for the return value, it only RECORDS partials (#6:
            one ledger write per call is untouched)."""
            if cost_sink is not None:
                cost_sink.append(value)
        # Per-rule model selection (C3-6b): resolve via the cluster's primary rule;
        # identical to ``prefs.investigator_model``/``prefs.formatter_model`` when
        # no per-rule override exists.
        primary_rule = cluster.primary_rule()
        model_cfg = prefs.model_for_rule(Role.INVESTIGATOR, primary_rule)
        try:
            # Multi-agent roster: the assigned persona specialises the system prompt
            # (focus + methodology) without relaxing any read-only / fencing rule.
            addendum = persona.system_addendum if persona else ""
            system = build_investigator_system(
                tool_defs_text(self._tools.definitions()), addendum
            )
            # Markdown playbook (operator procedure) — injected as a distinct TRUSTED
            # block, separate from the fenced UNTRUSTED evidence. It can only guide;
            # the deterministic policy decides close/escalate.
            playbook_text = render_playbook_prompt(playbook) if playbook is not None else None
            # Operator MEMORY (durable trusted facts) is injected as a DISTINCT block
            # ABOVE the untrusted evidence and BELOW the playbook procedure — it can
            # only INFORM; the deterministic policy still decides close/escalate.
            # The code-computed analyst-precedent summary is injected as its OWN
            # TRUSTED block (only when the operator enabled promotion AND the signal
            # qualified). It is EVIDENCE, not authority: the deterministic policy still
            # decides close/escalate (#3).
            # The per-event evidence projection is resolved from the operator's
            # config for the sources that actually contributed to THIS cluster, so a
            # deployment whose alerts carry decision-relevant fields the ECS default
            # does not name can surface them without a code change.
            context = render_cluster(
                cluster, enrichment, rag_chunks, playbook=playbook_text, memory=memory,
                precedent=precedent,
                evidence_fields=prefs.evidence_fields_for(cluster.contributing_source_ids()),
                evidence_max_chars=prefs.evidence_budget_for(cluster.contributing_source_ids()),
            )
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": context + "\n\nBegin the investigation. Respond with JSON only."},
            ]
            await self._audit.record(
                action_type=ActionType.PROMPT, surface=surface, actor=Role.INVESTIGATOR.value,
                case_id=case_id, model=model_cfg.model, prompt_excerpt=context,
                result_summary=(
                    f"persona={persona.id if persona else 'generalist'} "
                    f"playbook={f'{playbook.id} v{playbook.version}' if playbook else 'none'}"
                ),
            )

            # Explainability (the case-rationale "why"): one CONTEXT record capturing
            # the knowledge/memory/enrichment INJECTED into the investigation. The
            # human-readable summary goes in result_summary (visible in the trace);
            # a bounded, structured copy goes in tool_input so the rationale endpoint
            # can rebuild the panel without re-deriving from prose. Short snippets
            # only — never raw attacker payloads unfenced (#9).
            await self._audit.record(
                action_type=ActionType.CONTEXT, surface=surface, actor="context",
                case_id=case_id,
                result_summary=_context_summary(enrichment, rag_chunks, memory, precedent),
                tool_input={
                    "persona": (persona.id if persona else "generalist"),
                    "playbook": (f"{playbook.id} v{playbook.version}" if playbook else None),
                    "playbook_detail": (
                        {"id": playbook.id, "version": playbook.version}
                        if playbook is not None
                        else None
                    ),
                    "memory": [truncate(m.text, 200) for m in (memory or []) if (m.text or "").strip()][:20],
                    "precedent": (precedent.as_dict() if precedent is not None else None),
                    "knowledge": [
                        {
                            "source": ch.source,
                            "snippet": truncate(ch.text, 200),
                            "score": ch.score,
                            "document_id": str(
                                (ch.metadata or {}).get("document_id")
                                or (ch.metadata or {}).get("doc_id")
                                or ""
                            )[:200],
                            "revision": (ch.metadata or {}).get("revision"),
                            "content_hash": str(
                                (ch.metadata or {}).get("content_hash") or ""
                            )[:128],
                            "query_groups": list(
                                (ch.metadata or {}).get("retrieval_query_groups") or []
                            )[:20],
                        }
                        for ch in (rag_chunks or [])[:20]
                    ],
                    "enrichment": (
                        {
                            "reputation_score": enrichment.reputation_score,
                            "is_malicious": enrichment.is_malicious,
                            "country": enrichment.country,
                        }
                        if enrichment is not None
                        else None
                    ),
                },
            )

            draft: VerdictResult | None = None
            reasoning = ""
            max_steps = prefs.caps.max_tool_calls + 3

            for _step in range(max_steps):
                if budget.exceeded():
                    reasoning += f"\n[capped] {budget.capped_reason}"
                    break
                try:
                    res = await self._gateway.complete(
                        Role.INVESTIGATOR, messages, model_cfg,
                        surface=surface, case_id=case_id,
                    )
                except GatewayError as exc:
                    # Name the CLASS of provider fault (an expired key, an exhausted
                    # quota) rather than only the raw message, so the operator-visible
                    # reason distinguishes a credential problem from a slow model.
                    failure_class = getattr(exc, "failure_class", "") or ""
                    logger.warning(
                        "Investigator model error (class=%s): %s; failing to human",
                        failure_class or "unclassified", exc,
                    )
                    detail = f" [{failure_class}]" if failure_class else ""
                    return (
                        _fail_to_human(
                            f"investigator model error{detail}: {exc}", cluster, prefs
                        ),
                        cost,
                    )

                cost += res.cost
                _account(res.cost)  # leaf: this ReAct gateway call is now on the ledger
                budget.add_tokens(res.prompt_tokens, res.completion_tokens)
                obj = extract_json(res.text)

                if not obj or "action" not in obj:
                    messages.append({"role": "assistant", "content": res.text})
                    messages.append({"role": "user", "content": "Respond with ONLY a valid JSON action object."})
                    continue

                action = obj.get("action")
                if action == "final":
                    reasoning = str(obj.get("reasoning", ""))
                    draft = coerce_verdict(obj.get("verdict") or {})
                    break

                if action == "tool":
                    if not budget.can_call_tool():
                        reasoning += f"\n[capped] {budget.capped_reason}"
                        break
                    name = str(obj.get("tool", ""))
                    tool = self._tools.get(name)
                    budget.record_tool_call()
                    if tool is None:
                        messages.append({"role": "assistant", "content": res.text})
                        messages.append({"role": "user",
                                         "content": f"Unknown tool '{name}'. Available: {self._tools.names()}"})
                        continue
                    # Capability firewall (#3 generalised): an autonomous agent may
                    # only call SAFE/MANAGED tools. Outward/irreversible tools must be
                    # PROPOSED for human approval, never executed here; forbidden tools
                    # are hard-blocked. Every built-in tool is SAFE today, so this is
                    # defense-in-depth that activates the moment a write tool is added.
                    if tool.tier in (ToolTier.FORBIDDEN, ToolTier.REQUIRES_APPROVAL):
                        await self._audit.record(
                            action_type=ActionType.DECISION, surface=surface,
                            actor=Role.INVESTIGATOR.value, case_id=case_id, tool_name=name,
                            result_summary=f"tool '{name}' blocked by tier={tool.tier.value}",
                        )
                        messages.append({"role": "assistant", "content": res.text})
                        guidance = (
                            f"Tool '{name}' is FORBIDDEN for autonomous use; do not call it."
                            if tool.tier == ToolTier.FORBIDDEN
                            else (
                                f"Tool '{name}' requires human approval and was NOT executed. "
                                "Describe the action in 'recommended_action' for an analyst instead."
                            )
                        )
                        messages.append({"role": "user", "content": guidance})
                        continue
                    tool_input = obj.get("input") or {}
                    tr = await tool.run(**tool_input)
                    await self._audit.record(
                        action_type=ActionType.TOOL_CALL, surface=surface,
                        actor=Role.INVESTIGATOR.value, case_id=case_id,
                        tool_name=name, tool_input=tool_input,
                        tool_output_summary=tr.summary, query_text=tr.query,
                    )
                    observation = {"ok": tr.ok, "summary": tr.summary, "data": tr.data, "error": tr.error}
                    messages.append({"role": "assistant", "content": res.text})
                    messages.append({
                        "role": "user",
                        "content": (
                            f"Tool '{name}' result:\n"
                            # fence_block, NOT the per-value fence(): the observation is a
                            # multi-KB structured tool result, and fence()'s 600-char cap
                            # silently starved the strong model of the evidence it just
                            # fetched (audit #20). Per-leaf marker-scrubbed + a generous cap.
                            f"{fence_block(observation, source='tool', tool=name)}"
                        ),
                    })
                    continue

                messages.append({"role": "user", "content": "Use action 'tool' or 'final' only."})

            if draft is None:
                draft = _fail_to_human(
                    "Investigation inconclusive or capped; routing to human.", cluster, prefs
                )

            verdict, fcost = await self._formatter.format(
                draft, reasoning, prefs, surface=surface, case_id=case_id,
                model_cfg=prefs.model_for_rule(Role.FORMATTER, primary_rule),
            )
            cost += fcost
            _account(fcost)  # leaf: the formatter gateway call is now on the ledger
            if not verdict.reproduce_query:
                verdict.reproduce_query = entity_kql(cluster, prefs)

            # Carry the reasoning onto the VERDICT record (the investigator's own analysis
            # prose, not attacker-controlled log data). ``result_summary`` keeps a compact
            # 600-char excerpt for the one-line trace; the FULLER reasoning is stashed in
            # ``tool_input`` (NOT clipped by the audit layer) so the Timeline can show it
            # in full behind a "show more".
            reasoning_excerpt = truncate(reasoning, 600) if reasoning else ""
            reasoning_full = truncate(reasoning, 4000) if reasoning else ""
            await self._audit.record(
                action_type=ActionType.VERDICT, surface=surface, actor=Role.INVESTIGATOR.value,
                case_id=case_id, model=model_cfg.model,
                result_summary=(
                    f"verdict={verdict.verdict.value} confidence={verdict.confidence}"
                    + (f" reasoning={reasoning_excerpt}" if reasoning_excerpt else "")
                ),
                tool_input=({"reasoning": reasoning_full} if reasoning_full else None),
            )
            return verdict, cost
        except Exception as exc:  # noqa: BLE001 — never drop an alert
            logger.exception("Investigator crashed; failing to human")
            await self._audit.record(
                action_type=ActionType.ERROR, surface=surface, actor=Role.INVESTIGATOR.value,
                case_id=case_id, result_summary=f"investigator crash: {exc}",
            )
            return _fail_to_human(f"investigator error: {exc}", cluster, prefs), cost


def _fail_to_human(reason: str, cluster: Cluster, prefs: Preferences) -> VerdictResult:
    return VerdictResult(
        verdict=Verdict.NEEDS_HUMAN,
        confidence=0.0,
        recommended_action=truncate(reason, 400),
        reproduce_query=entity_kql(cluster, prefs),
    )
