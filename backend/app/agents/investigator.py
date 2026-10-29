"""Investigator role — the ReAct loop (Section 6.4).

One strong generalist gathers evidence via read-only tools, reasons, and produces
a draft verdict, which the formatter then shapes. Per-case caps (tool calls,
tokens, kill switch) bound the loop so a malformed alert cannot cause runaway
spend (Section 6.3 #4). ANY failure returns NEEDS_HUMAN — never a dropped alert
(Section 6.7).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace
from typing import Any, Iterable, Mapping

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..constants import ActionType, Role, ToolTier, Verdict
from ..engine.cost_gate import CaseBudget
from ..engine.precedent import PrecedentSignal
from ..engine.runbook_match import (
    MatchableRunbook,
    case_facts_from_cluster,
    describe_explanation,
    match,
)
from ..engine.runbook_model import MAX_RUNBOOK_PROMPT_CHARS, render_runbook_prompt
from ..llm.gateway import GatewayError, LLMGateway, UsageReceipt
from ..models import (
    Cluster,
    EnrichmentResult,
    MatchExplanation,
    MemoryEntry,
    RagChunk,
    VerdictResult,
)
from ..tools.base import ToolRegistry
from ..utils import extract_json, truncate
from .common import coerce_verdict, entity_kql
from .formatter import Formatter
from .personas import AgentPersona
from .prompts import (
    build_investigator_system,
    fence_block,
    render_cluster,
    tool_defs_text,
)

logger = logging.getLogger("tlsoc.agents.investigator")


# --------------------------------------------------------------------------- #
# Runbook guidance (Round 14 SPEC §4.10.4, §4.10.9)
#
# Before each investigation the deterministic matcher (``engine.runbook_match``,
# $0, no model call, #6) chooses the runbook whose investigator rendering enters the
# TRUSTED ``<<<RUNBOOK>>>`` block. Only matchable versions are ever offered: the
# built-ins, and the live (Published) version of each operator runbook; never a
# draft, a version in review, a retired runbook or AI text (D39, #9). The guidance
# can only inform the investigator: the close or escalate decision stays with
# ``case_manager.decide()`` (#3), which never reads it.
# --------------------------------------------------------------------------- #
#: A runbook matched on its criteria (tier 1 to 3).
GUIDANCE_MATCHED = "matched"
#: Nothing else matched, so the Generic incident fallback was chosen (tier 0, D33).
GUIDANCE_FALLBACK = "fallback"
#: No runbook matched (and the fallback is off or absent).
GUIDANCE_NO_MATCH = "no_match"
#: ``runbooks.investigator_guidance`` is off.
GUIDANCE_OFF = "guidance_off"
#: ``runbooks.enabled`` is off.
GUIDANCE_RUNBOOKS_OFF = "runbooks_off"
#: The operator library could not be read, so no runbook was offered (fail closed: a
#: built-in an operator copy replaces must never stand in for that copy).
GUIDANCE_LIBRARY_UNAVAILABLE = "library_unavailable"
#: The library was read, but choosing among its runbooks failed (a matcher or
#: rendering error), so no runbook was offered. Kept apart from
#: :data:`GUIDANCE_LIBRARY_UNAVAILABLE` so the audit trail says what happened (#2).
GUIDANCE_SELECTION_FAILED = "selection_failed"
#: The winner's rendering is over :data:`MAX_RUNBOOK_PROMPT_CHARS`. Publishing refuses
#: such a version, so this is a defence only; the prompt never truncates (§4.10.9).
GUIDANCE_OVER_BUDGET = "over_budget"

_GUIDANCE_SENTENCES: dict[str, str] = {
    GUIDANCE_NO_MATCH: "No runbook matched this case.",
    GUIDANCE_OFF: "Investigator guidance from runbooks is turned off in Settings.",
    GUIDANCE_RUNBOOKS_OFF: "Runbooks are turned off in Settings.",
    GUIDANCE_LIBRARY_UNAVAILABLE: (
        "The runbook library could not be read, so no runbook guided this investigation."
    ),
    GUIDANCE_SELECTION_FAILED: (
        "Runbook matching failed, so no runbook guided this investigation."
    ),
    GUIDANCE_OVER_BUDGET: (
        f"The matching runbook's investigator guidance is over the "
        f"{MAX_RUNBOOK_PROMPT_CHARS:,} character budget, so it was not used."
    ),
}


@dataclass(frozen=True)
class RunbookGuidance:
    """The runbook the investigator is given for one cluster, and why.

    ``text`` is the investigator rendering (``runbook_model.render_runbook_prompt``)
    of the chosen version, within the budget, or ``None`` when no runbook guides this
    investigation (``status`` says why). ``runbook_id`` and ``version`` are set
    whenever a runbook was matched, also when it was not used (``over_budget``), so
    the audit trail names it."""

    status: str
    runbook_id: str | None = None
    version: int | None = None
    title: str = ""
    origin: str = ""
    text: str | None = None
    explanation: MatchExplanation | None = None
    tied: int = 0
    retrieval_queries: tuple[str, ...] = ()
    prompt_chars: int = 0

    @classmethod
    def none(cls, status: str) -> "RunbookGuidance":
        return cls(status=status)

    @property
    def selected(self) -> bool:
        """True when a runbook's guidance goes into the investigator prompt."""
        return bool(self.runbook_id) and self.text is not None

    @property
    def label(self) -> str:
        """``<id> v<n>``, or ``none``."""
        if not self.runbook_id:
            return "none"
        return f"{self.runbook_id} v{self.version}" if self.version else self.runbook_id

    @property
    def reason(self) -> str:
        """One plain sentence: why this runbook (or none) guides the investigation."""
        if self.status in (GUIDANCE_MATCHED, GUIDANCE_FALLBACK):
            return describe_explanation(self.explanation, tied=self.tied)
        return _GUIDANCE_SENTENCES.get(self.status, _GUIDANCE_SENTENCES[GUIDANCE_NO_MATCH])

    def selection_payload(self) -> dict[str, Any] | None:
        """The ``runbook_selection`` object of the ``runbook.selected`` audit row (the
        case rationale and the timeline read it), or ``None`` when nothing matched."""
        if not self.runbook_id:
            return None
        return {
            "id": self.runbook_id,
            "version": self.version,
            "title": self.title,
            "origin": self.origin,
            "status": self.status,
            "used": self.selected,
            "reason": self.reason,
            "tier": self.explanation.tier if self.explanation is not None else None,
            "explanation": (
                self.explanation.model_dump(mode="json") if self.explanation is not None else None
            ),
            "tied": self.tied,
            "prompt_chars": self.prompt_chars,
        }


def select_investigator_runbook(
    cluster: Cluster,
    prefs: Preferences,
    catalog: Iterable[MatchableRunbook] | None,
    *,
    severity: str | None = None,
    source_types: Mapping[str, str] | None = None,
    tags: Iterable[Any] | None = None,
) -> RunbookGuidance:
    """Choose the runbook that guides the investigation of ``cluster`` (pure, $0).

    ``catalog`` is the matchable catalog (``RunbookCatalog.matchable``: the built-ins
    no Published operator copy replaces, plus every live operator version), or
    ``None`` when the library could not be read. ``severity`` is the cluster's
    severity band and ``source_types`` maps source ids to their types, both from the
    caller's live settings. ``tags`` are the tags of the case being investigated
    again (an empty list means it has none); ``None``, for a cluster that has no case
    yet, leaves them pending. Before an investigation the verdict and status are not
    known yet, and a cluster carries no technique, so those criteria are pending
    (``runbook_match``): a runbook that names rules is chosen on its rules, and the
    rest is checked again when the case is evaluated after the verdict (D43)."""
    cfg = getattr(prefs, "runbooks", None)
    if cfg is not None and not getattr(cfg, "enabled", True):
        return RunbookGuidance.none(GUIDANCE_RUNBOOKS_OFF)
    if cfg is not None and not getattr(cfg, "investigator_guidance", True):
        return RunbookGuidance.none(GUIDANCE_OFF)
    if catalog is None:
        return RunbookGuidance.none(GUIDANCE_LIBRARY_UNAVAILABLE)
    facts = case_facts_from_cluster(cluster, severity=severity, source_types=source_types)
    if tags is not None:
        # A case's tags (set by people and by automation rules) are known on a
        # re-investigation, so a tag condition is checked here exactly as the
        # attachment after the verdict checks it, and the two agree.
        facts = replace(facts, tags=_known_tags(tags))
    result = match(facts, catalog, fallback=bool(getattr(cfg, "fallback", True)))
    winner, explanation = result.winner, result.explanation
    if winner is None or explanation is None:
        return RunbookGuidance.none(GUIDANCE_NO_MATCH)
    status = GUIDANCE_FALLBACK if explanation.tier == 0 else GUIDANCE_MATCHED
    text = render_runbook_prompt(winner.definition, winner.version)
    base = RunbookGuidance(
        status=status,
        runbook_id=winner.id,
        version=winner.version,
        title=winner.title,
        origin=winner.origin,
        explanation=explanation,
        tied=len(result.tied),
        retrieval_queries=tuple(
            q.strip() for q in (winner.definition.retrieval_queries or []) if str(q).strip()
        ),
        prompt_chars=len(text),
    )
    if len(text) > MAX_RUNBOOK_PROMPT_CHARS:
        logger.warning(
            "Runbook %s v%s renders %d characters for the investigator (budget %d); "
            "it is not used", winner.id, winner.version, len(text), MAX_RUNBOOK_PROMPT_CHARS,
        )
        return replace(base, status=GUIDANCE_OVER_BUDGET)
    return replace(base, text=text)


def _known_tags(tags: Iterable[Any]) -> tuple[str, ...]:
    """The case's tags as the matcher reads them: trimmed text, first seen first."""
    out: list[str] = []
    for tag in tags:
        if isinstance(tag, str):
            text = tag.strip()
            if text and text not in out:
                out.append(text)
    return tuple(out)


def _context_summary(
    enrichment: EnrichmentResult | None,
    rag_chunks: list[RagChunk] | None,
    memory: list[MemoryEntry] | None,
    precedent: PrecedentSignal | None = None,
    runbook: RunbookGuidance | None = None,
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

    if runbook is not None and runbook.selected:
        parts.append(f"runbook: {runbook.label}")

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
        runbook: RunbookGuidance | None = None,
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
            # The active runbook (a Published version's investigator rendering, chosen
            # by the deterministic matcher) is injected as a distinct TRUSTED block,
            # separate from the fenced UNTRUSTED evidence. It can only guide; the
            # deterministic policy decides close/escalate (#3).
            runbook_text = runbook.text if runbook is not None and runbook.selected else None
            # Operator MEMORY (durable trusted facts) is injected as a DISTINCT block
            # ABOVE the untrusted evidence and BELOW the runbook. It can only INFORM;
            # the deterministic policy still decides close/escalate.
            # The code-computed analyst-precedent summary is injected as its OWN
            # TRUSTED block (only when the operator enabled promotion AND the signal
            # qualified). It is EVIDENCE, not authority: the deterministic policy still
            # decides close/escalate (#3).
            # The per-event evidence projection is resolved from the operator's
            # config for the sources that actually contributed to THIS cluster, so a
            # deployment whose alerts carry decision-relevant fields the ECS default
            # does not name can surface them without a code change.
            context = render_cluster(
                cluster, enrichment, rag_chunks, runbook=runbook_text, memory=memory,
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
                    f"runbook={runbook.label if runbook is not None and runbook.selected else 'none'}"
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
                result_summary=_context_summary(
                    enrichment, rag_chunks, memory, precedent, runbook
                ),
                tool_input={
                    "persona": (persona.id if persona else "generalist"),
                    # The runbook whose guidance THIS prompt carried (selection alone is
                    # recorded on the ``runbook.selected`` row; this row proves use).
                    "runbook": (
                        runbook.label if runbook is not None and runbook.selected else None
                    ),
                    "runbook_detail": (
                        {
                            "id": runbook.runbook_id,
                            "version": runbook.version,
                            "title": runbook.title,
                            "origin": runbook.origin,
                        }
                        if runbook is not None and runbook.selected
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
                # Token/tool/kill-switch caps AND the case TIME budget. The time check
                # stops the loop COOPERATIVELY — before the outer ``asyncio.wait_for`` in
                # the pipeline would cancel this coroutine outright, and before the slice
                # left would be too short for a request that could actually finish.
                #
                # For a run that would have exceeded the case cap anyway the decision is
                # unchanged (the draft is still None, so it is the same NEEDS_HUMAN a
                # hard cancellation produces) and what it buys is that the accumulated
                # reasoning reaches the VERDICT audit row and the spend lands on the
                # normal return path. It is NOT a no-op in general: stopping earlier than
                # the cap ends a run that might have reached a verdict, which is why the
                # reserve is a small fraction of the case rather than a whole per-request
                # slice, and why the viability floor is measured from this case's own
                # completed calls instead of guessed.
                if budget.exceeded() or budget.time_exhausted():
                    reasoning += f"\n[capped] {budget.capped_reason}"
                    break
                # Bound THIS request by the configured per-request timeout, itself bounded
                # by the case time actually left. ``None`` == nothing configured and no
                # deadline stamped, i.e. the pre-change behaviour (the provider client's
                # own timeout is then the only bound).
                request_timeout = budget.request_timeout()
                request_started = budget.request_started()
                # Filled by the gateway with what it ledgers for THIS request — also
                # when we stop waiting for it. An abandoned request carries a real
                # estimated cost (SPEC §6.3) that ``wait_for`` never hands back, and
                # without it ``Case.token_cost`` would sit below the ledger (#6).
                receipt = UsageReceipt()
                try:
                    call = self._gateway.complete(
                        Role.INVESTIGATOR, messages, model_cfg,
                        surface=surface, case_id=case_id, usage_receipt=receipt,
                    )
                    if request_timeout is None:
                        res = await call
                    else:
                        res = await asyncio.wait_for(call, timeout=request_timeout)
                    # How long a COMPLETED request took on this deployment. It is the
                    # budget's only evidence for refusing to dispatch a later request
                    # under a slice that demonstrably cannot hold one.
                    budget.note_request(request_started)
                except asyncio.TimeoutError:
                    # One request outran its slice of the case budget. Stop the loop the
                    # same cooperative way a cap does, so the partial reasoning survives.
                    # Its abandoned ledger row is accounted like any other call.
                    cost += receipt.cost
                    _account(receipt.cost)
                    reasoning += (
                        f"\n[capped] model request exceeded its "
                        f"{round(request_timeout or 0.0, 3)}s slice of the case time budget"
                    )
                    break
                except asyncio.CancelledError:
                    # The pipeline's hard cap cancelled the whole flow mid-request. Put
                    # the abandoned row's cost in the sink before unwinding, so the
                    # pipeline's ``sum(cost_sink)`` still matches the ledger. A cancel
                    # that lands while the gateway is still writing a SUCCESSFUL call's
                    # row is covered too: the receipt is filled before that write and
                    # ``res.cost`` below was never reached, so nothing counts twice.
                    _account(receipt.cost)
                    raise
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
                    # A failed blocking call is ledgered at 0; account whatever the row
                    # holds anyway, so this stays true if a failure ever carries spend.
                    cost += receipt.cost
                    _account(receipt.cost)
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
