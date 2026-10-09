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
from ..llm.gateway import GatewayError, LLMGateway
from ..models import Cluster, EnrichmentResult, MemoryEntry, RagChunk, VerdictResult
from ..tools.base import ToolRegistry
from ..utils import extract_json, truncate
from .common import coerce_verdict, entity_kql
from .formatter import Formatter
from .personas import AgentPersona
from .prompts import (
    build_investigator_system,
    fence,
    fence_block,
    focus_runbooks,
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

    return " | ".join(parts) if parts else "no injected context"


def _playbook_block(playbook: "Playbook") -> str:
    """Compose the operator-procedure text for the selected playbook: name +
    version + body, with the advisory front-matter hints (escalate_if /
    suggested_verdict_bias) appended as clearly-labelled ADVISORY lines. These are
    guidance only — the deterministic auto-close policy decides close/escalate."""
    m = playbook.manifest
    parts = [f"{m.name} (v{m.version})", playbook.body.strip()]
    advisory: list[str] = []
    if m.escalate_if:
        advisory.append(f"- escalate_if (advisory): {m.escalate_if}")
    if m.suggested_verdict_bias:
        advisory.append(f"- suggested_verdict_bias (advisory): {m.suggested_verdict_bias}")
    if advisory:
        parts.append(
            "Advisory hints (NOT binding — the deterministic policy decides the "
            "outcome):\n" + "\n".join(advisory)
        )
    return "\n\n".join(p for p in parts if p)


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
        # Give every tool this investigation's events so a tool can read a FULL event
        # field the model only sees truncated (e.g. an SDDL blob past the #9 fence) by
        # referencing the event id. Optional hook — tolerate tool-like objects (stubs,
        # future MCP transports) that don't implement it.
        for _tool in self._tools.all():
            _bind = getattr(_tool, "bind_events", None)
            if callable(_bind):
                _bind(cluster.member_events)
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
            playbook_text = _playbook_block(playbook) if playbook is not None else None
            # Operator MEMORY (durable trusted facts) is injected as a DISTINCT block
            # ABOVE the untrusted evidence and BELOW the playbook procedure — it can
            # only INFORM; the deterministic policy still decides close/escalate.
            # Focus the retrieved knowledge ONCE, here, so the prompt below and the
            # CONTEXT audit record further down describe the SAME set. Filtering it
            # inside render_cluster alone would shape the prompt while the audit
            # trail still claimed the runbooks the model never actually saw.
            rag_chunks = focus_runbooks(rag_chunks or [], cluster.rule_values)
            context = render_cluster(
                cluster, enrichment, rag_chunks, playbook=playbook_text, memory=memory,
                max_events=getattr(prefs, "investigator_max_events", 12),
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
                result_summary=_context_summary(enrichment, rag_chunks, memory),
                tool_input={
                    "persona": (persona.id if persona else "generalist"),
                    "playbook": (f"{playbook.id} v{playbook.version}" if playbook else None),
                    "memory": [truncate(m.text, 200) for m in (memory or []) if (m.text or "").strip()][:20],
                    # 200 chars cut a runbook descriptor off mid-keyword in the UI
                    # ("...credential_acc…"), hiding the rules/MITRE bindings that
                    # explain WHY this knowledge was selected. 600 shows a whole
                    # descriptor; the panel scrolls, and the chunk is a summary
                    # already, so this widens explainability without leaking bulk.
                    "knowledge": [
                        {"source": ch.source, "snippet": truncate(ch.text, 600)}
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
                    logger.warning("Investigator model error (%s); failing to human", exc)
                    return _fail_to_human(f"investigator model error: {exc}", cluster, prefs), cost

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
