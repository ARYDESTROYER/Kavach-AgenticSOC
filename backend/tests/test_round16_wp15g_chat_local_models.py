"""Round 16 WP15G: chat display fixes and the local-model ``/v1`` path (SPEC §4.5).

- [oss] B1: an OpenAI-compatible base URL typed with a trailing ``/v1`` (the way
  LiteLLM, vLLM and Ollama document it) must not double the path. The client posts to
  ``/v1/chat/completions`` and ``/v1/embeddings``, so the factories strip one trailing
  ``/v1`` and slash before building the client. The stored URL stays as typed.
- B42: the ``get_case`` citation carries the case's display number, so the Sources
  chip can show ``CASE-000043`` instead of the internal id.

All offline: an ``httpx.MockTransport`` records every request path; no network.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import httpx
import pytest

from app.agents.chat_tools.cases import GetCaseTool
from app.config import ModelConfig
from app.constants import (
    USAGE_READ_PATTERN,
    CaseStatus,
    EntityType,
    Role,
    SourceSurface,
    UsageOutcome,
    Verdict,
)
from app.es.fake import InMemoryESClient
from app.llm import providers as providers_mod
from app.llm.gateway import GatewayError, LLMGateway
from app.llm.providers import PROVIDER_REGISTRY, openai_api_root
from app.models import Case, Entity
from app.stores.cases import CaseStore
from app.stores.custom_models import CustomModelStore
from app.stores.memory import EsKVStore
from app.stores.usage import UsageStore
from app.utils import now_utc
from tests.test_chat_tools_support import make_ctx

_CHAT_BODY = {
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 12, "completion_tokens": 3},
}
_EMBED_BODY = {"data": [{"embedding": [0.1, 0.2, 0.3]}], "usage": {"prompt_tokens": 4}}

#: What a real OpenAI-compatible server answers: only these paths exist.
_SERVED = {
    "/v1/chat/completions": _CHAT_BODY,
    "/v1/embeddings": _EMBED_BODY,
    "/openai/v1/chat/completions": _CHAT_BODY,
    "/openai/v1/embeddings": _EMBED_BODY,
}


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every request path the providers send, through their real ``AsyncClient``.

    The provider module builds its own client from the base URL; this wraps that
    constructor so the client keeps the URL the factory chose and only the transport
    is replaced. A path no server serves answers 404, as a real one would."""
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        body = _SERVED.get(request.url.path)
        if body is None:
            return httpx.Response(404, json={"error": {"message": "not found"}})
        return httpx.Response(200, json=body)

    real_client = httpx.AsyncClient

    def client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(providers_mod.httpx, "AsyncClient", client)
    return paths


_CASES = [
    ("http://h/v1", "/v1"),
    ("http://h/v1/", "/v1"),
    ("http://h", "/v1"),
    ("http://h/openai/v1", "/openai/v1"),
]


# --------------------------------------------------------------------------- #
# [oss] B1: the request path for each typed form, both factories, both calls
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("factory", ["openai_compatible", "openai"])
@pytest.mark.parametrize(("base_url", "prefix"), _CASES)
async def test_complete_posts_one_v1_whatever_the_typed_form(recorded: list[str], factory: str,
                                                            base_url: str, prefix: str) -> None:
    provider = PROVIDER_REGISTRY[factory](api_key="sk-local", base_url=base_url)
    try:
        result = await provider.complete("chat", [{"role": "user", "content": "hi"}], "local-x", 0.1, 50)
    finally:
        await provider.aclose()
    assert recorded == [f"{prefix}/chat/completions"]
    assert result.text == "ok"


@pytest.mark.parametrize("factory", ["openai_compatible", "openai"])
@pytest.mark.parametrize(("base_url", "prefix"), _CASES)
async def test_embed_posts_one_v1_whatever_the_typed_form(recorded: list[str], factory: str,
                                                         base_url: str, prefix: str) -> None:
    provider = PROVIDER_REGISTRY[factory](api_key="sk-local", base_url=base_url)
    try:
        result = await provider.embed(["hello"], "local-embed")
    finally:
        await provider.aclose()
    assert recorded == [f"{prefix}/embeddings"]
    assert result.vectors == [[0.1, 0.2, 0.3]]


@pytest.mark.parametrize(("base_url", "prefix"), _CASES)
async def test_streamed_chat_posts_one_v1_whatever_the_typed_form(recorded: list[str], base_url: str,
                                                                  prefix: str) -> None:
    """Workspace chat streams from an ``openai_compatible`` model, so the streaming
    call must reach the same single ``/v1`` path as ``complete``."""
    provider = PROVIDER_REGISTRY["openai_compatible"](api_key="sk-local", base_url=base_url)
    shown: list[str] = []

    async def on_text(text: str) -> None:
        shown.append(text)

    try:
        result = await provider.complete_stream(
            "chat", [{"role": "user", "content": "hi"}], "local-x", 0.1, 50, on_text,
        )
    finally:
        await provider.aclose()
    assert recorded == [f"{prefix}/chat/completions"]
    assert result.text == "ok" and shown == ["ok"]


async def test_default_openai_endpoint_is_unchanged(recorded: list[str]) -> None:
    provider = PROVIDER_REGISTRY["openai"](api_key="sk-test")
    try:
        assert str(provider._client.base_url).rstrip("/") == "https://api.openai.com"
        await provider.complete("chat", [{"role": "user", "content": "hi"}], "gpt-4o", 0.1, 50)
    finally:
        await provider.aclose()
    assert recorded == ["/v1/chat/completions"]


def test_openai_api_root_strips_exactly_one_trailing_v1() -> None:
    assert openai_api_root("http://h/v1") == "http://h"
    assert openai_api_root("http://h/v1/") == "http://h"
    assert openai_api_root("  http://h/V1/  ") == "http://h"
    assert openai_api_root("http://h") == "http://h"
    assert openai_api_root("http://h/") == "http://h"
    assert openai_api_root("http://h/openai/v1") == "http://h/openai"
    # Only one: a server that really serves /v1/v1 keeps its second /v1.
    assert openai_api_root("http://h/v1/v1") == "http://h/v1"
    # A path that merely ends in the letters is not a version segment.
    assert openai_api_root("http://h/apiv1") == "http://h/apiv1"


# --------------------------------------------------------------------------- #
# [oss] B1 through the gateway: one completion, one $0 UsageDoc
# --------------------------------------------------------------------------- #
class _Secrets:
    anthropic_api_key = None
    openai_api_key = None
    litellm_api_key = None
    embedding_api_key = None

    def embedding_key(self) -> None:
        return None


async def _usage_docs(es: InMemoryESClient) -> list[dict[str, Any]]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [hit["_source"] for hit in resp["hits"]["hits"]]


async def test_gateway_custom_model_with_v1_url_completes_once_at_zero_cost(recorded: list[str]) -> None:
    store = CustomModelStore(EsKVStore(InMemoryESClient()))
    await store.add("my-local-llama", base_url="http://litellm:4000/v1", label="Local")
    es = InMemoryESClient()
    gateway = LLMGateway(secrets=_Secrets(), usage_store=UsageStore(es), custom_models=store)
    cfg = ModelConfig(provider="openai_compatible", model="my-local-llama")

    result = await gateway.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")

    assert recorded == ["/v1/chat/completions"]
    assert result.text == "ok" and result.cost == 0.0
    docs = await _usage_docs(es)
    assert len(docs) == 1
    assert docs[0]["outcome"] == UsageOutcome.OK.value
    assert docs[0]["cost"] == 0.0
    # The stored URL stays as the operator typed it.
    assert await store.base_url_for("my-local-llama") == "http://litellm:4000/v1"


async def test_gateway_registry_v1_url_reaches_the_server(recorded: list[str]) -> None:
    """The bundled self-hosted example (``http://localhost:8000/v1``) is typed with
    ``/v1`` too; it reaches ``/v1/chat/completions``, never ``/v1/v1/...``."""
    es = InMemoryESClient()
    gateway = LLMGateway(secrets=_Secrets(), usage_store=UsageStore(es))
    cfg = ModelConfig(provider="openai_compatible", model="local-llama-3.1-8b")
    try:
        await gateway.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")
    except GatewayError as exc:  # pragma: no cover - the failure this test guards
        pytest.fail(f"the registry endpoint was not reached: {exc}")
    assert recorded == ["/v1/chat/completions"]


# --------------------------------------------------------------------------- #
# B42: the case citation carries the display number
# --------------------------------------------------------------------------- #
def _case(case_id: str, *, case_number: str) -> Case:
    created = (now_utc() - timedelta(hours=1)).isoformat()
    return Case(
        case_id=case_id, case_number=case_number, cluster_signature=f"sig-{case_id}",
        source_surface=SourceSurface.INVESTIGATE, entity=Entity(type=EntityType.IP, value="203.0.113.7"),
        status=CaseStatus.OPEN, verdict=Verdict.NEEDS_HUMAN, confidence=0.7, risk_score=60.0,
        title="Impossible travel authentication", rule_ids=["linux_auth"],
        created_at=created, updated_at=created,
    )


async def test_get_case_citation_carries_the_case_number() -> None:
    cases = CaseStore(InMemoryESClient())
    await cases.save(_case("demo-recent-00000539-0001", case_number="CASE-000043"))
    out = await GetCaseTool().run(make_ctx(cases=cases), case_id="demo-recent-00000539-0001")
    assert out.ok and out.citations
    citation = out.citations[0]
    assert citation.kind == "case"
    assert citation.case_number == "CASE-000043"
    # Navigation still uses the internal id.
    assert citation.case_id == "demo-recent-00000539-0001"
    assert citation.model_dump(mode="json")["case_number"] == "CASE-000043"


async def test_get_case_citation_without_a_number_stays_none() -> None:
    cases = CaseStore(InMemoryESClient())
    await cases.save(_case("case-0007", case_number=""))
    out = await GetCaseTool().run(make_ctx(cases=cases), case_id="case-0007")
    assert out.ok and out.citations
    assert out.citations[0].case_number is None
    assert out.citations[0].case_id == "case-0007"
