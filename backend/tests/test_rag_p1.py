"""P1 RAG upgrade tests — all offline (mock embeddings + fake ES).

Covers: resolved-case memory, the embedding-space guard (dim mismatch -> reseed,
NOT truncation), the min-cosine threshold, the richer rag_query, the ESVectorStore
over the fake ES, and chat grounding with/without RAG.
"""

from __future__ import annotations

import pytest

from app.agents.common import rag_query
from app.config import Preferences, Secrets
from app.constants import CaseStatus, DecisionBy, Disposition, EntityType, Verdict
from app.es.fake import InMemoryESClient
from app.llm.gateway import GatewayError, LLMGateway
from app.llm.providers import EmbeddingResult, MockProvider, ProviderError
from app.models import Case, Cluster, Entity, EvidenceItem, RawEvent
from app.stores.cases import CaseStore
from app.stores.usage import UsageStore
from app.tools.rag import RagService
from app.tools.vectorstore import (
    EmbeddingSpaceMismatch,
    ESVectorStore,
    InMemoryVectorStore,
    StoredChunk,
)
from app.utils import iso_now


def _gateway() -> LLMGateway:
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]
    usage = UsageStore(InMemoryESClient())
    mock = MockProvider()
    return LLMGateway(secrets, usage, provider_overrides={"openai": mock, "mock": mock})


class _DimProvider(MockProvider):
    """A mock embedding provider whose vector dimensionality is configurable, so a
    test can change the embedding space mid-flight."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        self.dim = dim

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        vectors = []
        for t in texts:
            v = [0.0] * self.dim
            for i, token in enumerate(t.lower().split()):
                v[(hash(token) + i) % self.dim] += 1.0
            vectors.append(v)
        return EmbeddingResult(vectors=vectors, tokens=sum(len(t) for t in texts))


class _ShortBatchProvider(MockProvider):
    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        return EmbeddingResult(vectors=[[1.0, 0.0] for _ in texts[:-1]], tokens=1)


class _FailEmbeddingProvider(MockProvider):
    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise RuntimeError("embedding endpoint unavailable")


class _AuthFailEmbeddingProvider(MockProvider):
    """The incident's provider: HTTP 401 on every embedding call."""

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise ProviderError("HTTP 401: invalid_api_key", retryable=False, status=401)


class _NoKeyEmbeddingProvider(MockProvider):
    """The supported keyless profile: no key was ever configured."""

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise GatewayError("OpenAI API key not configured")


class _SwitchingCardinalityProvider(MockProvider):
    """Succeeds once, then returns a malformed batch for reconciliation tests."""

    def __init__(self) -> None:
        super().__init__()
        self.malformed = False

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        vectors = [[1.0, 0.0] for _ in texts]
        if self.malformed and vectors:
            vectors.pop()
        return EmbeddingResult(vectors=vectors, tokens=max(1, len(texts)))


class _DimThenMalformedProvider(_DimProvider):
    """Change query space, then fail only the replacement corpus batch."""

    def __init__(self, dim: int) -> None:
        super().__init__(dim)
        self.malformed_bulk = False

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        result = await super().embed(texts, model)
        if self.malformed_bulk and len(texts) > 1:
            result.vectors.pop()
        return result


def _gateway_with(provider: MockProvider) -> LLMGateway:
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]
    usage = UsageStore(InMemoryESClient())
    return LLMGateway(
        secrets, usage,
        provider_overrides={"openai": provider, "mock": provider, "anthropic": provider},
    )


def _closed_case(case_id: str, ip: str, verdict: Verdict) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig-{case_id}",
        source_surface="investigate",
        rule_ids=["sshd", "linux_auth"],
        entity=Entity(type=EntityType.IP, value=ip),
        verdict=verdict,
        confidence=0.9,
        evidence=[EvidenceItem(summary="Sustained SSH brute force burst across many users")],
        recommended_action="Block the source IP at the perimeter.",
        status=CaseStatus.CLOSED,
        decision_by=DecisionBy.ANALYST,
        disposition=(
            Disposition.TRUE_POSITIVE
            if verdict == Verdict.TRUE_POSITIVE
            else Disposition.FALSE_POSITIVE
        ),
        history=[{"event": "analyst_action", "action": "set_disposition"}],
        created_at=iso_now(),
        updated_at=iso_now(),
    )


# --------------------------------------------------------------------------- #
# Task 1: resolved-case memory
# --------------------------------------------------------------------------- #
async def test_resolved_case_memory_retrievable_after_seed() -> None:
    es = InMemoryESClient()
    cases = CaseStore(es)
    await cases.save(_closed_case("case-1", "198.51.100.7", Verdict.TRUE_POSITIVE))
    # An OPEN case must NOT be indexed (only closed memory).
    open_case = _closed_case("case-open", "203.0.113.9", Verdict.TRUE_POSITIVE)
    open_case.status = CaseStatus.OPEN
    await cases.save(open_case)

    rag = RagService(_gateway(), Preferences(), cases=cases)
    await rag.ensure_seeded()

    chunks = await rag.retrieve("brute force ip 198.51.100.7 block", top_k=5)
    blob = " ".join(c.text + " " + str(c.metadata) for c in chunks)
    assert "case-1" in blob, "closed-case memory should be retrievable"
    assert "198.51.100.7" in blob
    assert "case-open" not in blob, "open cases must not be indexed"
    # The resolved-case chunk carries citation metadata.
    rc = [c for c in chunks if c.source == "resolved_case"]
    assert rc and rc[0].metadata.get("case_id") == "case-1"


async def test_resolved_cases_disabled_when_pref_off() -> None:
    es = InMemoryESClient()
    cases = CaseStore(es)
    await cases.save(_closed_case("case-x", "198.51.100.7", Verdict.TRUE_POSITIVE))
    prefs = Preferences()
    prefs.rag.use_resolved_cases = False
    rag = RagService(_gateway(), prefs, cases=cases)
    await rag.ensure_seeded()
    chunks = await rag.retrieve("brute force ip 198.51.100.7", top_k=8)
    assert all(c.source != "resolved_case" for c in chunks)


async def test_source_toggle_reconciles_after_service_was_seeded() -> None:
    prefs = Preferences()
    prefs.rag.min_score = 0.0
    rag = RagService(_gateway(), prefs)
    await rag.ensure_seeded()
    assert (await rag.rag_stats())["by_source"].get("mitre", 0) > 0

    disabled = prefs.model_copy(update={
        "rag": prefs.rag.model_copy(update={"use_mitre": False}),
    })
    rag.set_prefs(disabled)
    await rag.ensure_seeded()
    assert (await rag.rag_stats())["by_source"].get("mitre", 0) == 0
    assert all(c.source != "mitre" for c in await rag.retrieve("T1110", top_k=50))

    rag.set_prefs(prefs)
    await rag.ensure_seeded()
    assert (await rag.rag_stats())["by_source"].get("mitre", 0) > 0


async def test_runbook_master_toggle_is_an_exact_retrieval_disable() -> None:
    prefs = Preferences()
    prefs.rag.min_score = 0.0
    prefs.runbooks.enabled = False
    prefs.rag.use_runbooks = True
    rag = RagService(_gateway(), prefs)
    await rag.ensure_seeded()
    stats = await rag.rag_stats()
    assert stats["by_source"].get("runbook", 0) == 0
    assert all(c.source != "runbook" for c in await rag.retrieve("ssh brute force", top_k=50))


async def test_threat_context_toggle_filters_existing_imports_live() -> None:
    prefs = Preferences()
    prefs.rag.min_score = 0.0
    rag = RagService(_gateway(), prefs)
    await rag.import_threat_context(
        "Rare DNS beacon",
        "indicator quasar-test.invalid uses an unusual periodic DNS beacon",
    )
    assert any(
        c.source == "threat_context"
        for c in await rag.retrieve("quasar-test.invalid", top_k=50)
    )

    disabled = prefs.model_copy(update={
        "rag": prefs.rag.model_copy(update={"use_threat_context": False}),
    })
    rag.set_prefs(disabled)
    assert all(
        c.source != "threat_context"
        for c in await rag.retrieve("quasar-test.invalid", top_k=50)
    )

    rag.set_prefs(prefs)
    assert any(
        c.source == "threat_context"
        for c in await rag.retrieve("quasar-test.invalid", top_k=50)
    )


# --------------------------------------------------------------------------- #
# Task 3: embedding-space guard — dim mismatch reseeds, never truncates
# --------------------------------------------------------------------------- #
async def test_dim_mismatch_triggers_reseed_not_truncation() -> None:
    provider = _DimProvider(dim=128)
    rag = RagService(_gateway_with(provider), Preferences())
    await rag.ensure_seeded()
    space = await rag._store.embedding_space()
    assert space is not None and space[1] == 128

    # Embedding model output dimensionality changes (e.g. model swap).
    provider.dim = 64
    chunks = await rag.retrieve("ssh brute force failed login", top_k=3)
    assert chunks, "retrieval should succeed after an automatic reseed"
    new_space = await rag._store.embedding_space()
    assert new_space is not None and new_space[1] == 64, "store reseeded into the new space"
    # No truncated/zero-padded vectors: every stored vector matches the new dim.
    for _chunk, score in await rag._store.search([0.0] * 64, 3):
        assert isinstance(score, float)


async def test_embedding_cardinality_mismatch_fails_closed_without_partial_write() -> None:
    rag = RagService(_gateway_with(_ShortBatchProvider()), Preferences())
    await rag.ensure_seeded()
    assert await rag._store.count() == 0
    assert rag._seeded is False


async def test_failed_source_reconciliation_preserves_last_known_good_corpus() -> None:
    provider = _SwitchingCardinalityProvider()
    prefs = Preferences()
    rag = RagService(_gateway_with(provider), prefs)
    await rag.ensure_seeded()
    before_count = await rag._store.count()
    before_docs = await rag._store.list_documents()
    assert before_count > 0

    # Force a source-signature reconciliation and fail while staging the complete
    # replacement. The old projection must remain intact and queryable.
    provider.malformed = True
    rag.set_prefs(
        prefs.model_copy(update={
            "rag": prefs.rag.model_copy(update={"use_mitre": False}),
        })
    )
    await rag.ensure_seeded()

    assert rag._seeded is False
    assert await rag._store.count() == before_count
    assert await rag._store.list_documents() == before_docs


async def test_embedding_space_reseed_preserves_operator_documents() -> None:
    provider = _DimProvider(dim=8)
    prefs = Preferences()
    prefs.rag.min_score = 0.0
    rag = RagService(_gateway_with(provider), prefs)
    await rag.import_document(
        "Operator DNS note",
        "approved investigation note for beacon.example.invalid",
        tags=["dns"],
    )
    before = await rag._store.count()
    assert before > 0

    provider.dim = 12
    assert await rag.retrieve("beacon.example.invalid", top_k=50)
    assert await rag._store.count() == before
    assert any(
        document["source"] == "imported"
        for document in await rag._store.list_documents()
    )
    assert await rag._store.embedding_space() == ("text-embedding-3-small", 12)


async def test_failed_embedding_space_reseed_rolls_back_prior_corpus() -> None:
    provider = _DimThenMalformedProvider(dim=8)
    prefs = Preferences()
    rag = RagService(_gateway_with(provider), prefs)
    await rag.ensure_seeded()
    before_count = await rag._store.count()
    before_docs = await rag._store.list_documents()

    provider.dim = 12
    provider.malformed_bulk = True
    assert await rag.retrieve("ssh brute force", top_k=3) == []
    assert await rag._store.count() == before_count
    assert await rag._store.list_documents() == before_docs
    assert await rag._store.embedding_space() == ("text-embedding-3-small", 8)


async def test_degraded_embedding_provider_never_persists_a_fallback_chunk() -> None:
    """A provider outage must NEVER produce a durable hash-space write.

    This previously asserted the opposite — that a failed provider still seeded the
    corpus from local hash embeddings — which is precisely the defect: those vectors
    are meaningless in the real embedding space, are indistinguishable from real ones
    once stored, and poisoned the corpus for the whole outage window. Degrading a
    READ is fine; degrading a WRITE is corruption.
    """
    rag = RagService(_gateway_with(_FailEmbeddingProvider()), Preferences())
    await rag.ensure_seeded()
    assert await rag._store.count() == 0
    # Nothing was written, so the store has no embedding space at all.
    assert await rag._store.embedding_space() is None
    # The seed did not latch: the next call retries rather than believing it is done.
    assert rag._seeded is False


async def test_degraded_provider_leaves_a_healthy_corpus_intact() -> None:
    """The corpus that existed before the outage survives it untouched."""
    provider = _DimProvider(dim=8)
    prefs = Preferences()
    gateway = _gateway_with(provider)
    rag = RagService(gateway, prefs)
    await rag.ensure_seeded()
    before_count = await rag._store.count()
    before_docs = await rag._store.list_documents()
    assert before_count > 0

    # The provider now 401s on every call, exactly as in the incident.
    gateway._providers["openai"] = _AuthFailEmbeddingProvider()
    rag._seeded = False
    rag._seed_signature = None
    await rag.ensure_seeded()

    assert await rag._store.count() == before_count
    assert await rag._store.list_documents() == before_docs
    # And every surviving chunk is still in the REAL space, never the hash space.
    for doc in before_docs:
        for chunk in await rag._store.list_chunks(doc["document_id"]):
            assert chunk.metadata.get("embedding_fallback") is not True


async def test_keyless_profile_still_seeds_with_local_embeddings() -> None:
    """The supported keyless/offline profile is NOT an outage and must keep working."""
    rag = RagService(_gateway_with(_NoKeyEmbeddingProvider()), Preferences())
    await rag.ensure_seeded()
    assert await rag._store.count() > 0
    space = await rag._store.embedding_space()
    assert space is not None and space[0] == "mock-embed"
    docs = await rag._store.list_documents()
    runbook = next(doc for doc in docs if doc["source"] == "runbook")
    chunk = (await rag._store.list_chunks(runbook["document_id"]))[0]
    assert chunk.embedding_model == "mock-embed"
    assert chunk.metadata["embedding_provider"] == "mock"
    assert chunk.metadata["embedding_fallback"] is True
    # ...and it is attributable as the intentional keyless space, not an outage.
    assert chunk.metadata["embedding_fallback_reason"] == "not_configured"


def test_inmemory_store_raises_on_dim_mismatch() -> None:
    import asyncio

    store = InMemoryVectorStore()

    async def run() -> None:
        await store.add([StoredChunk(text="t", source="s", embedding=[1.0, 2.0, 3.0], dim=3)])
        try:
            await store.search([1.0, 2.0], 1)  # wrong dim
            raise AssertionError("expected EmbeddingSpaceMismatch")
        except EmbeddingSpaceMismatch:
            pass

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# Task 4: min-cosine threshold drops weak chunks
# --------------------------------------------------------------------------- #
async def test_below_min_score_chunks_dropped() -> None:
    prefs = Preferences()
    prefs.rag.min_score = 0.999  # almost nothing can clear this
    rag = RagService(_gateway(), prefs)
    await rag.ensure_seeded()
    chunks = await rag.retrieve("completely unrelated zzz qqq xyzzy", top_k=5)
    assert chunks == [], "weakly-related chunks must be dropped below min_score"

    prefs.rag.min_score = 0.0
    rag2 = RagService(_gateway(), prefs)
    await rag2.ensure_seeded()
    assert await rag2.retrieve("ssh brute force failed login", top_k=5), "min_score=0 returns hits"


# --------------------------------------------------------------------------- #
# Task 5: richer rag_query includes the entity
# --------------------------------------------------------------------------- #
def test_rag_query_includes_entity() -> None:
    ev = RawEvent(
        id="e1", ip="203.0.113.10", user="root", host="web01", rule="sshd",
        source={"message": "Failed password for root from 203.0.113.10"},
    )
    cluster = Cluster(
        signature="sig",
        entity=Entity(type=EntityType.IP, value="203.0.113.10"),
        group_by=EntityType.IP,
        rule_values=["sshd"],
        member_events=[ev],
        count=12,
    )
    q = rag_query(cluster)
    assert "203.0.113.10" in q, "query must mention the concrete entity value"
    assert "ip" in q.lower()
    assert "sshd" in q
    # still a usable retrieval query (template tail retained)
    assert "runbook" in q


# --------------------------------------------------------------------------- #
# Task 2: ESVectorStore over the fake ES (kNN not required for this smoke test)
# --------------------------------------------------------------------------- #
async def test_es_vector_store_persists_and_counts() -> None:
    es = InMemoryESClient()
    store = ESVectorStore(es)
    await store.add([
        StoredChunk(text="alpha", source="runbook", embedding=[1.0, 0.0], dim=2, embedding_model="m"),
        StoredChunk(text="beta", source="mitre", embedding=[0.0, 1.0], dim=2, embedding_model="m"),
    ])
    assert await store.count() == 2
    assert await store.embedding_space() == ("m", 2)
    await store.clear()
    assert await store.count() == 0


async def test_es_vector_management_read_propagates_storage_failure(monkeypatch) -> None:
    es = InMemoryESClient()
    store = ESVectorStore(es)
    await store.add([
        StoredChunk(
            text="alpha",
            source="runbook",
            embedding=[1.0, 0.0],
            dim=2,
            embedding_model="m",
        ),
    ])

    async def fail_search(*_args, **_kwargs):
        raise RuntimeError("vector backend unavailable")

    monkeypatch.setattr(es, "search", fail_search)
    with pytest.raises(RuntimeError, match="vector backend unavailable"):
        await store.list_documents()
    rag = RagService(_gateway(), Preferences(), store=store)
    with pytest.raises(RuntimeError, match="vector backend unavailable"):
        await rag.snapshot_documents_strict()


# --------------------------------------------------------------------------- #
# Task 6: chat works with AND without RAG grounding
# --------------------------------------------------------------------------- #
async def test_chat_grounds_in_rag_when_available() -> None:
    import json

    from app.agents.chat import ChatEngine
    from app.audit.audit_log import AuditLogger

    es = InMemoryESClient()
    provider = MockProvider()
    provider.push("chat", json.dumps({"answer": "Looks like SSH brute force.", "needs_query": False}))
    gateway = _gateway_with(provider)
    cases = CaseStore(es)
    rag = RagService(gateway, Preferences(), cases=cases)
    engine = ChatEngine(es, gateway, AuditLogger(es), cases, rag=rag)

    resp = await engine.chat("How do I handle an ssh brute force from one IP?", Preferences())
    assert resp.answer
    # The chat call should have received a TRUSTED knowledge block (not fenced).
    chat_calls = [c for c in provider.calls if c["role"] == "chat"]
    assert chat_calls, "chat provider was called"
    msgs = chat_calls[-1]["messages"]
    kb = [m["content"] for m in msgs if "SOC knowledge base context" in m["content"]]
    assert kb, "a knowledge-base context message was added"
    assert "TRUSTED" in kb[0]
    # Our own corpus is NOT wrapped in the UNTRUSTED fence markers.
    assert "<<<UNTRUSTED_LOG_DATA>>>" not in kb[0]


async def test_chat_works_without_rag() -> None:
    import json

    from app.agents.chat import ChatEngine
    from app.audit.audit_log import AuditLogger

    es = InMemoryESClient()
    provider = MockProvider()
    provider.push("chat", json.dumps({"answer": "Plain answer.", "needs_query": False}))
    gateway = _gateway_with(provider)
    cases = CaseStore(es)
    engine = ChatEngine(es, gateway, AuditLogger(es), cases, rag=None)

    resp = await engine.chat("hello", Preferences())
    assert resp.answer == "Plain answer."
    chat_calls = [c for c in provider.calls if c["role"] == "chat"]
    blob = json.dumps(chat_calls[-1]["messages"])
    assert "SOC knowledge base context" not in blob, "no RAG -> conversation unchanged"
