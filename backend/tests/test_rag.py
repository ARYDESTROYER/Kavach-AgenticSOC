"""Tests for the RAG service / tool. Offline — embeddings use local hashing."""

from __future__ import annotations

import pytest

from app.config import Preferences, Secrets
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import MockProvider
from app.models import RagChunk
from app.stores.usage import UsageStore
from app.tools.rag import RagService, RagTool


def _gateway() -> LLMGateway:
    # Force the embedding provider to the deterministic MockProvider (local hash
    # embeddings) so no key or network is needed. The embedding model defaults to
    # provider "openai"; override that slot too.
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]  # provider forced via override
    usage = UsageStore(InMemoryESClient())
    mock = MockProvider()
    return LLMGateway(secrets, usage, provider_overrides={"openai": mock, "mock": mock})


async def test_seed_and_retrieve_brute_force() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()

    chunks = await rag.retrieve("ssh brute force failed login", top_k=3)
    assert chunks, "expected non-empty retrieval"
    assert all(isinstance(c, RagChunk) for c in chunks)
    assert len(chunks) <= 3

    top = chunks[0]
    blob = (top.text + " " + top.source + " " + str(top.metadata)).lower()
    assert any(kw in blob for kw in ("brute", "auth", "login", "ssh"))


async def test_ensure_seeded_is_idempotent() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()
    await rag.ensure_seeded()  # second call must not duplicate or raise
    chunks = await rag.retrieve("port scan reconnaissance", top_k=2)
    assert chunks


async def test_retrieve_disabled_returns_empty() -> None:
    prefs = Preferences()
    prefs.rag.enabled = False
    rag = RagService(_gateway(), prefs)
    await rag.ensure_seeded()
    assert await rag.retrieve("ssh brute force", top_k=3) == []


async def test_observed_retrieval_distinguishes_zero_from_store_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()

    async def _zero(_vector, _top_k):
        return []

    monkeypatch.setattr(rag._store, "search", _zero)
    zero = await rag.retrieve_observed("no matching reference", top_k=3)
    assert zero.measured is True
    assert zero.reason == "completed"
    assert zero.chunks == []

    async def _failed(_vector, _top_k):
        raise RuntimeError("vector store unavailable")

    monkeypatch.setattr(rag._store, "search", _failed)
    failed = await rag.retrieve_observed("backend failure", top_k=3)
    assert failed.measured is False
    assert failed.reason == "retrieval_failed"
    assert failed.chunks == []


async def test_observed_retrieval_keeps_last_good_context_unmeasured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()

    async def _failed_seed() -> None:
        rag._seeded = False
        rag._seed_signature = None

    monkeypatch.setattr(rag, "ensure_seeded", _failed_seed)
    observation = await rag.retrieve_observed("ssh brute force failed login", top_k=3)
    assert observation.measured is False
    assert observation.reason == "seeding_failed"
    assert observation.chunks, "the last known-good corpus should still ground the prompt"


async def test_rag_tool_run_returns_list_data() -> None:
    rag = RagService(_gateway(), Preferences())
    tool = RagTool(rag)
    result = await tool.run(query="malicious ip reputation block", top_k=2)
    assert result.ok is True
    assert isinstance(result.data, list)
    assert len(result.data) >= 1
    assert isinstance(result.data[0], dict)
    assert "text" in result.data[0]
