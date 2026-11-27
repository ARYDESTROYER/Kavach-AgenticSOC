"""The usage/cost ledger is written for EVERY call (Non-negotiable #6)."""

from __future__ import annotations

import pytest

from app import __version__
from app.config import ModelConfig
from app.constants import USAGE_READ_PATTERN, Role, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm.gateway import GatewayError, LLMGateway
from app.llm.providers import BaseProvider, CompletionResult, MockProvider
from app.stores.usage import UsageStore


async def _usage_docs(es: InMemoryESClient):
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


async def test_every_completion_writes_one_usage_doc(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TLSOC_BUILD_SHA", "gateway-success-build")
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": MockProvider()})
    cfg = ModelConfig(provider="mock", model="mock")
    await gw.complete(Role.ROUTER, [{"role": "user", "content": "hi"}], cfg, surface="router", case_id="c1")

    docs = await _usage_docs(es)
    assert len(docs) == 1
    d = docs[0]
    assert d["role"] == "router"
    assert d["case_id"] == "c1"
    assert d["outcome"] == UsageOutcome.OK.value
    assert d["total_tokens"] == d["prompt_tokens"] + d["completion_tokens"]
    assert d["app_version"] == __version__
    assert d["build_sha"] == "gateway-success-build"


async def test_cost_is_recorded_for_priced_model():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": _PricedProvider()})
    cfg = ModelConfig(provider="mock", model="claude-sonnet-4-6")
    res = await gw.complete(Role.INVESTIGATOR, [{"role": "user", "content": "x"}], cfg, surface="investigate")
    assert res.cost > 0
    docs = await _usage_docs(es)
    assert docs[0]["cost"] > 0


async def test_error_records_usage_and_raises(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TLSOC_BUILD_SHA", "gateway-error-build")
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"mock": _RaisingProvider()})
    cfg = ModelConfig(provider="mock", model="mock")
    with pytest.raises(GatewayError):
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], cfg, surface="router")
    docs = await _usage_docs(es)
    assert len(docs) == 1
    assert docs[0]["outcome"] == UsageOutcome.ERROR.value
    assert docs[0]["app_version"] == __version__
    assert docs[0]["build_sha"] == "gateway-error-build"


class _FakeSecrets:
    anthropic_api_key = None
    openai_api_key = None
    embedding_api_key = None

    def embedding_key(self):
        return None


class _PricedProvider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", prompt_tokens=1000, completion_tokens=500, model=model)


class _RaisingProvider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        raise RuntimeError("provider boom")
