"""End-to-end investigation pipeline (Gate 1).

Covers the spine acceptance behaviour: a scripted verdict flows through triage →
investigator → formatter → deterministic Case Manager; true positives never
auto-close; false positives auto-close only under policy; and any model failure
fails to a human.
"""

from __future__ import annotations

import json

from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.correlation import cluster_from_events
from app.llm.providers import BaseProvider, CompletionResult
from app.models import Case, RagChunk
from app.state import AppState
from app.tools.rag import RagRetrievalObservation
from tests.conftest import make_raw_event


def _cluster(ip: str = "1.2.3.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def test_cumulative_knowledge_merge_is_deduplicated_and_bounded() -> None:
    from app.agents.pipeline import _merge_knowledge_references

    references = [
        {
            "source": "runbook",
            "document_id": f"doc-{idx}",
            "content_hash": f"hash-{idx}",
            "snippet": f"reference {idx}",
        }
        for idx in range(105)
    ]
    merged = _merge_knowledge_references(references, [dict(references[-1])])

    assert len(merged) == 100
    assert merged[0]["document_id"] == "doc-5"
    assert merged[-1]["document_id"] == "doc-104"


def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": 'source.ip : "1.2.3.4"',
        },
    })


async def test_true_positive_not_autoclosed_by_default(app_state: AppState, mock_provider):
    # FP auto-close on, TP auto-close OFF (default) → a TP still routes to a human.
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.1
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.99))

    case = await app_state.pipeline.investigate_cluster(_cluster(), SourceSurface.INVESTIGATE, app_state.prefs)
    assert case.verdict == Verdict.TRUE_POSITIVE
    # TP is not auto-closed (default); the confident TP surfaces as ESCALATED (the
    # F8 lifecycle mapping of decide().escalate in the non-close branch) — still a
    # human/SYSTEM decision, never CLOSED.
    assert case.status == CaseStatus.ESCALATED
    assert case.status != CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.SYSTEM
    assert case.token_cost >= 0.0


async def test_benign_false_positive_autocloses_under_policy(app_state: AppState, mock_provider):
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.5
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    mock_provider.push("router", json.dumps({"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}))

    case = await app_state.pipeline.investigate_cluster(_cluster("9.9.9.9"), SourceSurface.AUTOMATED_SCAN, app_state.prefs)
    assert case.verdict == Verdict.FALSE_POSITIVE
    assert case.status == CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.AGENT
    assert case.objection_window_expires_at is not None
    # The cheap router path never attempted RAG.  That is not a measured empty
    # retrieval: new cases have complete instrumentation, but no observation.
    assert case.retrieval_history_status == "available"
    assert case.retrieval_observation_status == "not_measured"
    assert case.knowledge_used == []


async def test_completed_empty_rag_is_the_only_measured_zero(
    app_state: AppState, mock_provider
):
    async def _empty_retrieve(_query, _top_k=None):
        return RagRetrievalObservation([], True, "completed")

    app_state.rag.retrieve_observed = _empty_retrieve  # type: ignore[method-assign]
    mock_provider.push(
        "router",
        json.dumps({
            "bucket": "needs_strong_model",
            "confidence": 0.9,
            "reason": "investigate",
        }),
    )
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))

    case = await app_state.pipeline.investigate_cluster(
        _cluster("5.5.5.5"), SourceSurface.INVESTIGATE, app_state.prefs
    )

    assert case.retrieval_history_status == "available"
    assert case.retrieval_observation_status == "measured"
    assert case.knowledge_used == []


async def test_rag_disabled_is_no_attempt_not_a_measured_zero(
    app_state: AppState, mock_provider
):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.rag.enabled = False
    await app_state.update_prefs(prefs)
    mock_provider.push(
        "router",
        json.dumps({
            "bucket": "needs_strong_model",
            "confidence": 0.9,
            "reason": "investigate without retrieval",
        }),
    )
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))

    case = await app_state.pipeline.investigate_cluster(
        _cluster("6.6.6.6"), SourceSurface.INVESTIGATE, app_state.prefs
    )

    assert case.retrieval_history_status == "available"
    assert case.retrieval_observation_status == "not_measured"
    assert case.knowledge_used == []


async def test_investigate_is_idempotent_by_signature(app_state: AppState, mock_provider):
    for _ in range(2):
        mock_provider.push("router", json.dumps({"bucket": "uncertain", "confidence": 0.3, "reason": "?"}))
        mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))
    c1 = await app_state.pipeline.investigate_cluster(_cluster("3.3.3.3"), SourceSurface.INVESTIGATE, app_state.prefs)
    c2 = await app_state.pipeline.investigate_cluster(_cluster("3.3.3.3"), SourceSurface.INVESTIGATE, app_state.prefs)
    assert c1.case_id == c2.case_id  # same open case, not a duplicate


async def test_model_failure_fails_to_human(secrets, mock_provider):
    from app.es.fake import InMemoryESClient

    raising = _RaisingProvider()
    state = AppState.create(
        secrets=secrets, es=InMemoryESClient(),
        provider_overrides={"anthropic": raising, "openai": raising, "mock": raising},
    )
    await state.startup(start_poller=False)
    try:
        case = await state.pipeline.investigate_cluster(
            _cluster("2.2.2.2"), SourceSurface.AUTOMATED_SCAN, state.prefs
        )
        assert case.verdict == Verdict.NEEDS_HUMAN
        assert case.status == CaseStatus.NEEDS_HUMAN
        assert case.retrieval_history_status == "available"
    finally:
        await state.shutdown()


async def test_retrieval_failure_is_not_a_measured_zero(
    app_state: AppState, mock_provider
):
    async def _failed_retrieve(_query, _top_k=None):
        return RagRetrievalObservation([], False, "retrieval_failed")

    app_state.rag.retrieve_observed = _failed_retrieve  # type: ignore[method-assign]
    mock_provider.push(
        "router",
        json.dumps({
            "bucket": "needs_strong_model",
            "confidence": 0.9,
            "reason": "investigate",
        }),
    )

    case = await app_state.pipeline.investigate_cluster(
        _cluster("8.8.8.8"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )

    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert case.retrieval_history_status == "available"
    assert case.retrieval_observation_status == "not_measured"
    assert case.knowledge_used == []


async def test_partial_unavailable_rag_context_is_not_case_measurement(
    app_state: AppState, mock_provider
):
    async def _partial_retrieve(_query, _top_k=None):
        return RagRetrievalObservation(
            [
                RagChunk(
                    text="last-known-good runbook context",
                    source="runbook",
                    score=0.9,
                    metadata={"document_id": "runbook-partial"},
                )
            ],
            False,
            "seeding_failed",
        )

    app_state.rag.retrieve_observed = _partial_retrieve  # type: ignore[method-assign]
    mock_provider.push(
        "router",
        json.dumps({
            "bucket": "needs_strong_model",
            "confidence": 0.9,
            "reason": "investigate with fail-soft context",
        }),
    )
    mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))

    case = await app_state.pipeline.investigate_cluster(
        _cluster("8.8.4.4"), SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )

    assert case.retrieval_history_status == "available"
    assert case.retrieval_observation_status == "not_measured"
    assert case.knowledge_used == []


async def test_kill_switch_skips_investigation(app_state: AppState):
    p = app_state.prefs.model_copy(deep=True)
    p.caps.kill_switch = True
    await app_state.update_prefs(p)
    case = await app_state.pipeline.investigate_cluster(_cluster("4.4.4.4"), SourceSurface.INVESTIGATE, app_state.prefs)
    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert case.retrieval_history_status == "available"
    assert case.retrieval_observation_status == "not_measured"
    assert case.knowledge_used == []


async def test_legacy_retrieval_history_remains_unavailable_after_reinvestigation(
    app_state: AppState, mock_provider
):
    cluster = _cluster("7.7.7.7")
    legacy = Case(
        case_id="case-legacy-retrieval",
        cluster_signature=cluster.signature,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=cluster.entity,
        status=CaseStatus.OPEN,
        # Historical Pydantic round-trips commonly materialised this explicit
        # empty list even though no retrieval observation existed.
        knowledge_used=[],
    )
    await app_state.cases.save(legacy)
    mock_provider.push(
        "router",
        json.dumps({"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}),
    )

    case = await app_state.pipeline.investigate_cluster(
        cluster, SourceSurface.INVESTIGATE, app_state.prefs
    )

    assert case.case_id == legacy.case_id
    assert case.retrieval_history_status == "unavailable"
    assert case.knowledge_used == []


async def test_candidate_refresh_preserves_legacy_retrieval_state(app_state: AppState):
    cluster = _cluster("7.7.7.8")
    reference = {"source": "runbook", "snippet": "historical reference"}
    legacy = Case(
        case_id="case-legacy-candidate",
        cluster_signature=cluster.signature,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=cluster.entity,
        status=CaseStatus.OPEN,
        knowledge_used=[reference],
    )
    await app_state.cases.save(legacy)

    case = await app_state.pipeline.register_candidate(
        cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )

    assert case.case_id == legacy.case_id
    assert case.retrieval_history_status == "unavailable"
    assert case.knowledge_used == [reference]


async def test_failure_reconstruction_preserves_legacy_retrieval_state(
    app_state: AppState, mock_provider
):
    cluster = _cluster("7.7.7.9")
    reference = {"source": "runbook", "snippet": "historical reference"}
    legacy = Case(
        case_id="case-legacy-failure",
        cluster_signature=cluster.signature,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=cluster.entity,
        status=CaseStatus.OPEN,
        knowledge_used=[reference],
    )
    await app_state.cases.save(legacy)

    async def _failed_retrieve(_query, _top_k=None):
        return RagRetrievalObservation(
            [
                RagChunk(
                    text="partial reference from an unavailable run",
                    source="runbook",
                    score=0.8,
                    metadata={"document_id": "runbook-unavailable"},
                )
            ],
            False,
            "retrieval_failed",
        )

    app_state.rag.retrieve_observed = _failed_retrieve  # type: ignore[method-assign]
    mock_provider.push(
        "router",
        json.dumps({
            "bucket": "needs_strong_model",
            "confidence": 0.9,
            "reason": "investigate",
        }),
    )

    case = await app_state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs
    )

    assert case.case_id == legacy.case_id
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert case.retrieval_history_status == "unavailable"
    assert case.knowledge_used == [reference]


class _RaisingProvider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        raise RuntimeError("model down")

    async def embed(self, texts, model):
        from app.llm.providers import EmbeddingResult

        return EmbeddingResult(vectors=[[0.0] for _ in texts], tokens=0)
