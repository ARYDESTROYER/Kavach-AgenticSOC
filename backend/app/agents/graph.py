"""LangGraph orchestration of the investigation flow (Section 3.1: FastAPI + LangGraph).

The flow is a small state graph: triage → (benign shortcut | strong investigator)
→ verdict. When LangGraph is importable it runs as a compiled ``StateGraph``; if
LangGraph is unavailable or errors, it falls back to an identical direct
sequence. Both paths call the SAME router/investigator/RAG components, so there is
no behavioural divergence — the graph is an orchestration shell, not a second
implementation.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, TypedDict

from ..config import Preferences
from ..constants import TriageBucket, Verdict
from ..engine.cost_gate import CaseBudget
from ..models import Cluster, EnrichmentResult, EvidenceItem, VerdictResult
from ..utils import truncate
from .common import entity_kql, rag_query

logger = logging.getLogger("tlsoc.agents.graph")


async def run_investigation(
    router,
    investigator,
    rag,
    cluster: Cluster,
    enrichment: EnrichmentResult | None,
    prefs: Preferences,
    budget: CaseBudget,
    surface: str,
    case_id: str | None,
    persona=None,
    playbook=None,
    memory=None,
    cost_sink: list[float] | None = None,
    provenance_sink: dict[str, Any] | None = None,
) -> tuple[VerdictResult, float]:
    """Run triage → verdict, preferring the LangGraph state graph.

    The (deterministically pre-selected) ``persona`` specialises the investigator
    and the matched ``playbook`` is injected as TRUSTED procedure (and contributes
    its canned ``rag_queries``); the operator ``memory`` (durable trusted facts) is
    injected as a distinct block — all three no-ops on the cheap benign/triage path.

    ``cost_sink`` — an OPTIONAL mutable accumulator (a list of per-stage costs). Each
    realised stage cost (triage, benign/investigate) is appended AS SOON AS it
    completes, so a caller that cancels this coroutine on a timeout can still account
    for the spend that already hit the ledger (``sum(cost_sink)``) instead of losing
    it. On the normal path ``sum(cost_sink) == returned flow_cost`` — the sink is a
    side-channel mirror of the return value, never a substitute for it (#6: one ledger
    write per call is unchanged; this only RECONCILES the case total with the ledger)."""

    def _account(value: float) -> float:
        """Record a LEAF stage cost into the optional sink and pass it through.

        The sink mirrors, at leaf granularity, exactly the spend that hit the ledger,
        so a TIMEOUT caller can reconcile ``Case.token_cost`` with the ledger instead
        of losing the partial flow_cost. Triage (one gateway call) is accounted HERE;
        the investigate path's per-step + formatter costs are accounted DEEPER (inside
        ``investigator.investigate`` via the same ``cost_sink``), so they must NOT be
        re-accounted here. The arithmetic of the returned flow_cost is unchanged."""
        if cost_sink is not None:
            cost_sink.append(value)
        return value

    async def do_triage():
        triage = await router.triage(cluster, enrichment, prefs, surface=surface, case_id=case_id)
        _account(triage.cost)  # leaf: one router gateway call already on the ledger
        return triage

    async def do_benign(triage) -> tuple[VerdictResult, float]:
        # No gateway call → zero leaf cost; nothing to account.
        if provenance_sink is not None:
            provenance_sink.update({
                "persona_consulted": False,
                "playbook_consulted": False,
                "knowledge": [],
                "retrieval_query_groups": [],
                "retrieval_status": "not_attempted",
                "retrieval_reason": "router_benign_shortcut",
                "consultation_path": "router_benign_shortcut",
            })
        return (
            VerdictResult(
                verdict=Verdict.FALSE_POSITIVE,
                confidence=triage.confidence,
                evidence=[EvidenceItem(summary=f"Router triage: {truncate(triage.reason, 200)}")],
                recommended_action="Router classified this as benign noise.",
                reproduce_query=entity_kql(cluster, prefs),
            ),
            0.0,
        )

    async def do_investigate() -> tuple[VerdictResult, float]:
        rag_chunks = []
        if provenance_sink is not None:
            provenance_sink.update({
                "persona_consulted": persona is not None,
                "playbook_consulted": playbook is not None and prefs.playbooks.enabled,
                "consultation_path": "strong_investigator",
                "retrieval_status": "not_attempted",
                "retrieval_reason": "pending",
            })
        if prefs.rag.enabled:
            # Base retrieval query + the selected playbook's canned rag_queries.
            # Each retrieve is bounded by top_k; we merge, de-dupe by text and cap
            # the union so prompt size stays bounded (and the cost gate still binds).
            grouped_queries: list[tuple[str, str]] = [("cluster", rag_query(cluster))]
            if playbook is not None and prefs.playbooks.enabled:
                grouped_queries += [
                    (f"playbook:{idx + 1}", query)
                    for idx, query in enumerate(playbook.manifest.rag_queries)
                    if str(query).strip()
                ]
            # Retrieve per explicit query group, then interleave groups so a base
            # query cannot starve every playbook query from the bounded prompt.
            buckets: list[tuple[str, str, list[Any]]] = []
            unavailable_reasons: list[str] = []
            for group, query in grouped_queries:
                observation = await rag.retrieve_observed(query, prefs.rag.top_k)
                buckets.append((group, query, list(observation.chunks)))
                if not observation.measured:
                    unavailable_reasons.append(observation.reason)
            cap = max(prefs.rag.top_k * 2, prefs.rag.top_k)
            by_text: dict[str, Any] = {}
            groups_by_text: dict[str, set[str]] = {}
            max_depth = max((len(items) for _group, _query, items in buckets), default=0)
            for depth in range(max_depth):
                for group, _query, items in buckets:
                    if depth >= len(items):
                        continue
                    chunk = items[depth]
                    groups_by_text.setdefault(chunk.text, set()).add(group)
                    if chunk.text not in by_text and len(by_text) < cap:
                        by_text[chunk.text] = chunk
            for text, chunk in by_text.items():
                metadata = dict(chunk.metadata or {})
                metadata["retrieval_query_groups"] = sorted(groups_by_text.get(text, set()))
                # A stable content fingerprint is always available even when an
                # older/custom vector backend does not persist document metadata.
                # This lets both the per-call audit and the case provenance record
                # identify the exact consulted text without storing a second copy.
                metadata.setdefault(
                    "content_hash", hashlib.sha256(text.encode("utf-8")).hexdigest()
                )
                rag_chunks.append(chunk.model_copy(update={"metadata": metadata}))
            if provenance_sink is not None:
                # A zero is measured only when EVERY configured query completed. A
                # partial success may still ground the current prompt, but its
                # coverage observation remains unavailable rather than becoming 0.
                provenance_sink["retrieval_status"] = (
                    "unavailable" if unavailable_reasons else "measured"
                )
                provenance_sink["retrieval_reason"] = (
                    "incomplete:" + ",".join(sorted(set(unavailable_reasons)))
                    if unavailable_reasons
                    else "completed"
                )
                provenance_sink["retrieval_query_groups"] = [
                    {"group": group, "query": truncate(query, 500)}
                    for group, query in grouped_queries
                ]
                provenance_sink["knowledge"] = [
                    {
                        "source": chunk.source,
                        "score": chunk.score,
                        "document_id": str(
                            (chunk.metadata or {}).get("document_id")
                            or (chunk.metadata or {}).get("doc_id")
                            or ""
                        ),
                        "revision": (chunk.metadata or {}).get("revision"),
                        "content_hash": str(
                            (chunk.metadata or {}).get("content_hash")
                            or hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
                        ),
                        "query_groups": list(
                            (chunk.metadata or {}).get("retrieval_query_groups") or []
                        ),
                        "snippet": truncate(chunk.text, 200),
                    }
                    for chunk in rag_chunks
                ]
        elif provenance_sink is not None:
            provenance_sink.update({
                "knowledge": [],
                "retrieval_query_groups": [],
                "retrieval_status": "not_attempted",
                "retrieval_reason": "rag_disabled",
            })
        return await investigator.investigate(
            cluster, enrichment, rag_chunks, prefs, budget, surface=surface, case_id=case_id,
            persona=persona, playbook=playbook, memory=memory, cost_sink=cost_sink,
        )

    try:
        return await _run_with_langgraph(do_triage, do_benign, do_investigate)
    except Exception as exc:  # noqa: BLE001 — LangGraph optional/fragile; never break the flow
        logger.info("LangGraph unavailable/failed (%s); using direct investigation flow", exc)
        return await _run_direct(do_triage, do_benign, do_investigate)


async def _run_direct(do_triage, do_benign, do_investigate) -> tuple[VerdictResult, float]:
    # NB: leaf costs are recorded into the optional cost_sink by do_triage (the router
    # call) and inside investigator.investigate (per ReAct step + formatter), so the
    # sink is NOT re-appended here — it would double-count the returned flow_cost.
    triage = await do_triage()
    cost = triage.cost
    if triage.bucket == TriageBucket.BENIGN:
        verdict, c = await do_benign(triage)
    else:
        verdict, c = await do_investigate()
    return verdict, cost + c


async def _run_with_langgraph(do_triage, do_benign, do_investigate) -> tuple[VerdictResult, float]:
    from langgraph.graph import END, StateGraph

    class FlowState(TypedDict, total=False):
        triage: Any
        verdict: VerdictResult
        cost: float

    async def triage_node(state: FlowState) -> FlowState:
        triage = await do_triage()
        return {"triage": triage, "cost": state.get("cost", 0.0) + triage.cost}

    async def benign_node(state: FlowState) -> FlowState:
        verdict, c = await do_benign(state["triage"])
        return {"verdict": verdict, "cost": state.get("cost", 0.0) + c}

    async def investigate_node(state: FlowState) -> FlowState:
        verdict, c = await do_investigate()
        return {"verdict": verdict, "cost": state.get("cost", 0.0) + c}

    def route(state: FlowState) -> str:
        return "benign" if state["triage"].bucket == TriageBucket.BENIGN else "investigate"

    # Node names must not collide with FlowState keys (LangGraph reserves keys),
    # so the nodes are suffixed while the routing values map to those node names.
    graph = StateGraph(FlowState)
    graph.add_node("triage_step", triage_node)
    graph.add_node("benign_step", benign_node)
    graph.add_node("investigate_step", investigate_node)
    graph.set_entry_point("triage_step")
    graph.add_conditional_edges(
        "triage_step", route, {"benign": "benign_step", "investigate": "investigate_step"}
    )
    graph.add_edge("benign_step", END)
    graph.add_edge("investigate_step", END)
    app = graph.compile()

    out = await app.ainvoke({"cost": 0.0})
    return out["verdict"], out.get("cost", 0.0)
