"""Round 4 / Wave 3 — LLM economics: cache-rate pricing, cache-token extraction,
BatchProvider SPI + resume-safe BatchJobStore (exactly-once ledger, #6).

All offline (fake ES + injected fake HTTP clients). No network.

Coverage:
  * cost_for non-cache/non-batch math is BYTE-IDENTICAL to the historical two-term
    formula (hardcoded expected values).
  * cache-read 0.1×, 5-min cache-write 1.25×, 1-h cache-write 2×, batch 0.5× math.
  * providers parse cache tokens into CompletionResult; the gateway writes them onto
    ONE UsageDoc per call (#6) and prices the cache/batch dimension.
  * OpenAI service_tier='flex' injected into the realtime request when configured.
  * BatchProvider submit/poll/results via a fake client, results keyed by custom_id
    (unordered).
  * BatchJobStore idempotency (2 results -> 2 UsageDocs; re-process -> 0 new) and
    resume-safe reload of open jobs after a simulated restart.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.config import ModelConfig
from app.constants import USAGE_READ_PATTERN, USAGE_WRITE_ALIAS, BatchJobState, Role, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm import pricing
from app.llm.batch import (
    BATCH_PROVIDER_REGISTRY,
    AnthropicBatchProvider,
    BatchResult,
    OpenAIBatchProvider,
    batch_manifest,
    make_batch_provider,
)
from app.llm.gateway import LLMGateway
from app.llm.pricing import cache_rates, cost_for, resolve_price
from app.llm.providers import AnthropicProvider, CompletionResult, OpenAIProvider
from app.models import BatchJob
from app.state import _BatchJobService
from app.stores.batch_jobs import BatchJobStore
from app.stores.memory import EsKVStore
from app.stores.usage import UsageStore


# --------------------------------------------------------------------------- #
# Shared fakes
# --------------------------------------------------------------------------- #
class _FakeSecrets:
    anthropic_api_key = "sk-ant"
    openai_api_key = "sk-oai"
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


async def _usage_docs(es: InMemoryESClient):
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


def _kv() -> EsKVStore:
    return EsKVStore(InMemoryESClient())


class _Resp:
    """A minimal httpx-Response-shaped stub (json + text + raise_for_status)."""

    def __init__(self, payload=None, *, text: str = "", status: int = 200) -> None:
        self._payload = payload
        self.text = text
        self._status = status

    def raise_for_status(self) -> None:
        if self._status >= 400:  # pragma: no cover - not exercised here
            raise RuntimeError(f"HTTP {self._status}")

    def json(self):
        return self._payload


# --------------------------------------------------------------------------- #
# 1) cost_for — non-cache byte-identical + cache/batch math
# --------------------------------------------------------------------------- #
def test_cost_for_non_cache_byte_identical():
    # claude-opus-4-8 == (5.0, 25.0). 1M in + 1M out = 5.0 + 25.0 = 30.0.
    assert cost_for("claude-opus-4-8", 1_000_000, 1_000_000) == pytest.approx(30.0)
    # A partial-token case that exercises the round(...,8) — must equal the raw formula.
    expected = round((1234 / 1e6) * 5.0 + (567 / 1e6) * 25.0, 8)
    assert cost_for("claude-opus-4-8", 1234, 567) == expected
    # Unknown model -> default (1.0, 3.0): 1M+1M = 4.0.
    assert cost_for("zzz-unknown", 1_000_000, 1_000_000) == pytest.approx(4.0)
    # Zero cache tokens + batch=False must be the exact two-term result.
    assert cost_for("gpt-4o", 2_000_000, 500_000,
                    cache_read_tokens=0, cache_write_tokens=0, batch=False) == \
        cost_for("gpt-4o", 2_000_000, 500_000)


def test_cache_rates_default_and_registry():
    # opus-4-8 input rate is 5.0; registry declares read=0.5, write=6.25.
    read, w5m, w1h = cache_rates("claude-opus-4-8", 5.0)
    assert read == pytest.approx(0.5)      # 0.1x
    assert w5m == pytest.approx(6.25)      # 1.25x
    assert w1h == pytest.approx(10.0)      # 2.0x derived from input
    # A registry-unknown model falls back to multiples of the passed input rate.
    read2, w5m2, w1h2 = cache_rates("totally-unknown-xyz", 4.0)
    assert (read2, w5m2, w1h2) == pytest.approx((0.4, 5.0, 8.0))


def test_cost_for_cache_read_is_0_1x():
    # 1M cache-read tokens at opus (input 5.0) -> 0.1 * 5.0 = 0.5 USD, on top of base.
    base = cost_for("claude-opus-4-8", 1_000_000, 0)  # 5.0
    with_read = cost_for("claude-opus-4-8", 1_000_000, 0, cache_read_tokens=1_000_000)
    assert with_read - base == pytest.approx(0.5)
    assert with_read == pytest.approx(5.5)


def test_cost_for_cache_write_5m_and_1h():
    base = cost_for("claude-opus-4-8", 0, 0)  # 0.0
    w5m = cost_for("claude-opus-4-8", 0, 0, cache_write_tokens=1_000_000, cache_write_ttl="5m")
    w1h = cost_for("claude-opus-4-8", 0, 0, cache_write_tokens=1_000_000, cache_write_ttl="1h")
    assert w5m - base == pytest.approx(6.25)   # 1.25x of 5.0
    assert w1h - base == pytest.approx(10.0)   # 2.0x of 5.0


def test_cost_for_batch_halves_everything():
    full = cost_for("claude-opus-4-8", 1_000_000, 1_000_000)  # 30.0
    batched = cost_for("claude-opus-4-8", 1_000_000, 1_000_000, batch=True)
    assert batched == pytest.approx(full * 0.5)
    assert batched == pytest.approx(15.0)
    # Batch also halves the cache dimension.
    b = cost_for("claude-opus-4-8", 1_000_000, 0, cache_read_tokens=1_000_000, batch=True)
    assert b == pytest.approx((5.0 + 0.5) * 0.5)


def test_cost_for_rounds_once_at_end():
    # A value where per-term rounding would drift from a single final round.
    got = cost_for("claude-opus-4-8", 333_333, 111_111,
                   cache_read_tokens=77_777, cache_write_tokens=55_555)
    read, w5m, _ = cache_rates("claude-opus-4-8", 5.0)
    expected = round(
        (333_333 / 1e6) * 5.0 + (111_111 / 1e6) * 25.0
        + (77_777 / 1e6) * read + (55_555 / 1e6) * w5m,
        8,
    )
    assert got == expected


def test_mock_model_is_free_regardless_of_cache():
    assert cost_for("mock", 1_000_000, 1_000_000, cache_read_tokens=1_000_000, batch=False) == 0.0


# --------------------------------------------------------------------------- #
# 2) provider extraction of cache tokens into CompletionResult
# --------------------------------------------------------------------------- #
async def test_anthropic_provider_parses_cache_tokens():
    provider = AnthropicProvider(api_key="sk-ant")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "content": [{"type": "text", "text": "hi"}],
                "usage": {"input_tokens": 100, "output_tokens": 20,
                          "cache_read_input_tokens": 40, "cache_creation_input_tokens": 15},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "claude-opus-4-8", temperature=0.1, max_tokens=8)
    assert res.cache_read_tokens == 40
    assert res.cache_write_tokens == 15
    assert res.prompt_tokens == 100 and res.completion_tokens == 20


async def test_openai_provider_parses_cached_tokens():
    provider = OpenAIProvider(api_key="sk-oai")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "choices": [{"message": {"content": "hi"}}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 30,
                          "prompt_tokens_details": {"cached_tokens": 128}},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "gpt-4o", temperature=0.1, max_tokens=8)
    assert res.cache_read_tokens == 128
    assert res.cache_write_tokens == 0  # OpenAI caching is read-only
    # OpenAI's ``prompt_tokens`` INCLUDES the cached slice; the provider hands the
    # ledger the UNCACHED remainder (200 - 128 = 72) so ``cost_for`` does not double-
    # bill the cached tokens (full-rate prompt_tokens PLUS the additive 0.1× term).
    assert res.prompt_tokens == 72
    assert res.completion_tokens == 30


async def test_openai_cache_not_double_billed_end_to_end():
    """OpenAI: prompt_tokens=1000 incl. cached=800 must cost the UNCACHED remainder at
    full rate + the cached slice at 0.1× — NOT the full 1000 at full rate + 0.1× on top.

    Guards the H3 fix: without it, the cached 800 tokens would be billed ~1.1× input
    (1× in prompt_tokens + 0.1× additive) instead of 0.1×.
    """
    provider = OpenAIProvider(api_key="sk-oai")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "choices": [{"message": {"content": "hi"}}],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 50,
                          "prompt_tokens_details": {"cached_tokens": 800}},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "gpt-4o", temperature=0.1, max_tokens=8)
    # Provider surfaces the uncached remainder as full-rate input + cached separately.
    assert res.prompt_tokens == 200  # 1000 - 800
    assert res.cache_read_tokens == 800

    in_price, out_price = resolve_price("gpt-4o", None)
    read_rate, _w5, _w1 = cache_rates("gpt-4o", in_price)
    priced = cost_for("gpt-4o", res.prompt_tokens, res.completion_tokens,
                      cache_read_tokens=res.cache_read_tokens)
    expected = round(
        (200 / 1_000_000.0) * in_price
        + (50 / 1_000_000.0) * out_price
        + (800 / 1_000_000.0) * read_rate,
        8,
    )
    assert priced == expected
    # The buggy formula (full 1000 at input rate + 800 additive read) would over-charge.
    buggy = round(
        (1000 / 1_000_000.0) * in_price
        + (50 / 1_000_000.0) * out_price
        + (800 / 1_000_000.0) * read_rate,
        8,
    )
    assert priced < buggy


async def test_anthropic_cache_billing_unchanged():
    """Anthropic's ``input_tokens`` already EXCLUDES the cached slice, so its billing
    (200 uncached at full rate + 800 cache-read at 0.1×) is the correct baseline and
    the H3 fix must NOT touch it."""
    provider = AnthropicProvider(api_key="sk-ant")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "content": [{"type": "text", "text": "hi"}],
                "usage": {"input_tokens": 200, "output_tokens": 50,
                          "cache_read_input_tokens": 800},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "claude-opus-4-8", temperature=0.1, max_tokens=8)
    assert res.prompt_tokens == 200  # unchanged — Anthropic already excludes cache
    assert res.cache_read_tokens == 800

    in_price, out_price = resolve_price("claude-opus-4-8", None)
    read_rate, _w5, _w1 = cache_rates("claude-opus-4-8", in_price)
    priced = cost_for("claude-opus-4-8", res.prompt_tokens, res.completion_tokens,
                      cache_read_tokens=res.cache_read_tokens)
    expected = round(
        (200 / 1_000_000.0) * in_price
        + (50 / 1_000_000.0) * out_price
        + (800 / 1_000_000.0) * read_rate,
        8,
    )
    assert priced == expected


async def test_openai_no_cache_path_byte_identical():
    """Non-cache OpenAI responses keep prompt_tokens verbatim (cached=0 → uncached ==
    prompt_tokens) — the fix is a no-op on the historical path."""
    provider = OpenAIProvider(api_key="sk-oai")

    class _Client:
        async def post(self, *_a, **_k):
            return _Resp({
                "choices": [{"message": {"content": "hi"}}],
                "usage": {"prompt_tokens": 321, "completion_tokens": 44},
            })

        async def aclose(self):
            return None

    provider._client = _Client()  # type: ignore[assignment]
    res = await provider.complete("router", [{"role": "user", "content": "x"}],
                                  "gpt-4o", temperature=0.1, max_tokens=8)
    assert res.prompt_tokens == 321
    assert res.cache_read_tokens == 0


async def test_openai_service_tier_flex_injected_when_set():
    captured: dict = {}

    class _Client:
        async def post(self, url, *, json=None, **_k):  # noqa: A002
            captured["json"] = json
            return _Resp({"choices": [{"message": {"content": "ok"}}],
                          "usage": {"prompt_tokens": 1, "completion_tokens": 1}})

        async def aclose(self):
            return None

    flex = OpenAIProvider(api_key="sk-oai", service_tier="flex")
    flex._client = _Client()  # type: ignore[assignment]
    await flex.complete("router", [{"role": "user", "content": "x"}], "gpt-4o",
                        temperature=0.1, max_tokens=8)
    assert captured["json"].get("service_tier") == "flex"

    # Default (no service_tier) keeps the request shape byte-identical (no key).
    captured.clear()
    plain = OpenAIProvider(api_key="sk-oai")
    plain._client = _Client()  # type: ignore[assignment]
    await plain.complete("router", [{"role": "user", "content": "x"}], "gpt-4o",
                         temperature=0.1, max_tokens=8)
    assert "service_tier" not in captured["json"]


# --------------------------------------------------------------------------- #
# 3) gateway writes cache/batch onto ONE UsageDoc (#6) + prices them
# --------------------------------------------------------------------------- #
class _CacheProvider:
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        return CompletionResult(text="ok", prompt_tokens=1_000_000, completion_tokens=0,
                                model=model, cache_read_tokens=1_000_000)

    async def embed(self, *_a, **_k):  # pragma: no cover
        raise NotImplementedError

    async def aclose(self):
        return None


async def test_gateway_records_cache_tokens_one_write():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"anthropic": _CacheProvider()})
    cfg = ModelConfig(provider="anthropic", model="claude-opus-4-8")
    res = await gw.complete(Role.ROUTER, [{"role": "user", "content": "hi"}], cfg, surface="router")
    docs = await _usage_docs(es)
    assert len(docs) == 1  # #6: exactly one row
    d = docs[0]
    assert d["cache_read_tokens"] == 1_000_000
    assert d["cache_write_tokens"] == 0
    assert d["batch"] is False
    # cost = 5.0 (input) + 0.5 (0.1x cache read) = 5.5
    assert d["cost"] == pytest.approx(5.5)
    assert res.cost == pytest.approx(5.5)


# --------------------------------------------------------------------------- #
# 4) BatchProvider SPI — submit / poll / results via a fake client (unordered)
# --------------------------------------------------------------------------- #
def test_batch_manifest_and_registry():
    ids = {m["id"] for m in batch_manifest()}
    assert ids == {"anthropic", "openai"}
    assert set(BATCH_PROVIDER_REGISTRY) == {"anthropic", "openai"}
    assert isinstance(make_batch_provider("anthropic", client=object()), AnthropicBatchProvider)
    assert isinstance(make_batch_provider("openai", client=object()), OpenAIBatchProvider)


class _AnthropicBatchClient:
    """A fake Anthropic batch client: submit -> in_progress, poll -> ended,
    results -> JSONL keyed by custom_id (returned UNORDERED)."""

    def __init__(self) -> None:
        self.polls = 0

    async def post(self, url, *, headers=None, json=None, **_k):  # noqa: A002
        assert url == "/v1/messages/batches"
        return _Resp({"id": "msgbatch_1", "processing_status": "in_progress"})

    async def get(self, url, *, headers=None, **_k):
        if url.endswith("/results"):
            # Two results, returned in the OPPOSITE order to submission.
            lines = [
                json.dumps({"custom_id": "cid-B", "result": {"type": "succeeded", "message": {
                    "model": "claude-opus-4-8", "content": [{"type": "text", "text": "B"}],
                    "usage": {"input_tokens": 200, "output_tokens": 20}}}}),
                json.dumps({"custom_id": "cid-A", "result": {"type": "succeeded", "message": {
                    "model": "claude-opus-4-8", "content": [{"type": "text", "text": "A"}],
                    "usage": {"input_tokens": 100, "output_tokens": 10}}}}),
            ]
            return _Resp(text="\n".join(lines))
        self.polls += 1
        return _Resp({"id": "msgbatch_1", "processing_status": "ended"})

    async def aclose(self):
        return None


async def test_anthropic_batch_submit_poll_results_keyed_by_custom_id():
    client = _AnthropicBatchClient()
    provider = AnthropicBatchProvider(api_key="sk-ant", client=client)
    requests = [
        {"custom_id": "cid-A", "params": {"messages": [{"role": "user", "content": "a"}]}},
        {"custom_id": "cid-B", "params": {"messages": [{"role": "user", "content": "b"}]}},
    ]
    job = await provider.submit("claude-opus-4-8", requests)
    assert job.provider_batch_id == "msgbatch_1"
    assert job.state == BatchJobState.POLLING
    assert set(k for k in job.custom_ids if k != "__meta__") == {"cid-A", "cid-B"}

    job = await provider.poll(job)
    assert job.state == BatchJobState.RETRIEVING  # 'ended' -> ready to retrieve

    results = {r.custom_id: r for r in await provider.results(job)}
    assert set(results) == {"cid-A", "cid-B"}
    assert results["cid-A"].text == "A" and results["cid-A"].prompt_tokens == 100
    assert results["cid-B"].text == "B" and results["cid-B"].completion_tokens == 20
    assert all(r.ok for r in results.values())


class _OpenAIBatchClient:
    def __init__(self) -> None:
        self.status = "validating"
        self.uploaded_jsonl = ""

    async def post(self, url, *, headers=None, json=None, files=None, data=None, **_k):  # noqa: A002
        if url == "/v1/files":
            self.uploaded_jsonl = files["file"][1]
            return _Resp({"id": "file_in"})
        assert url == "/v1/batches"
        return _Resp({"id": "batch_1", "status": "validating"})

    async def get(self, url, *, headers=None, **_k):
        if url.endswith("/content"):
            lines = [
                json.dumps({"custom_id": "cid-2", "response": {"status_code": 200, "body": {
                    "model": "gpt-4o", "choices": [{"message": {"content": "two"}}],
                    "usage": {"prompt_tokens": 50, "completion_tokens": 5}}}}),
                json.dumps({"custom_id": "cid-1", "response": {"status_code": 200, "body": {
                    "model": "gpt-4o", "choices": [{"message": {"content": "one"}}],
                    "usage": {"prompt_tokens": 40, "completion_tokens": 4}}}}),
            ]
            return _Resp(text="\n".join(lines))
        # batch status poll -> completed + output file id
        return _Resp({"id": "batch_1", "status": "completed", "output_file_id": "file_out"})

    async def aclose(self):
        return None


def test_openai_batch_result_subtracts_cached_from_prompt_tokens():
    # audit #19: OpenAI's usage.prompt_tokens INCLUDES the cached slice; cost_for bills
    # cache_read_tokens additively, so the batch parser must pass the UNCACHED remainder
    # (mirroring the sync path) or the cached tokens are billed twice.
    from app.llm.batch import _parse_openai_result

    row = {"custom_id": "c1", "response": {"status_code": 200, "body": {
        "model": "gpt-4o", "choices": [{"message": {"content": "hi"}}],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 10,
                  "prompt_tokens_details": {"cached_tokens": 800}}}}}
    res = _parse_openai_result(row, "gpt-4o")
    assert res.prompt_tokens == 200  # 1000 - 800 cached
    assert res.cache_read_tokens == 800
    assert res.completion_tokens == 10


async def test_openai_batch_submit_poll_results():
    client = _OpenAIBatchClient()
    provider = OpenAIBatchProvider(api_key="sk-oai", client=client)
    requests = [
        {"custom_id": "cid-1", "params": {"messages": [{"role": "user", "content": "1"}]}},
        {"custom_id": "cid-2", "params": {"messages": [{"role": "user", "content": "2"}]}},
    ]
    job = await provider.submit("gpt-4o", requests)
    assert job.provider_batch_id == "batch_1"
    job = await provider.poll(job)
    assert job.state == BatchJobState.RETRIEVING
    results = {r.custom_id: r for r in await provider.results(job)}
    assert set(results) == {"cid-1", "cid-2"}
    assert results["cid-1"].text == "one" and results["cid-2"].prompt_tokens == 50
    classic_body = json.loads(client.uploaded_jsonl.splitlines()[0])["body"]
    assert classic_body["model"] == "gpt-4o"
    assert "reasoning_effort" not in classic_body


async def test_openai_batch_translates_luna_request_shape():
    client = _OpenAIBatchClient()
    provider = OpenAIBatchProvider(api_key="sk-oai", client=client)
    requests = [{
        "custom_id": "luna-1",
        "params": {
            "system": "Classify this aggregate.",
            "messages": [{"role": "user", "content": "aggregate"}],
            "temperature": 0.2,
            "max_tokens": 400,
        },
    }]

    await provider.submit("gpt-5.6-luna", requests)

    body = json.loads(client.uploaded_jsonl)["body"]
    assert body["model"] == "gpt-5.6-luna"
    assert body["messages"] == [
        {"role": "system", "content": "Classify this aggregate."},
        {"role": "user", "content": "aggregate"},
    ]
    assert body["max_completion_tokens"] == 400
    assert body["reasoning_effort"] == "none"
    assert "system" not in body
    assert "max_tokens" not in body
    assert "temperature" not in body


# --------------------------------------------------------------------------- #
# 5) BatchJobStore — persistence, exactly-once ledger, resume-safe
# --------------------------------------------------------------------------- #
def _job() -> BatchJob:
    return BatchJob(
        id="batch-x", provider="anthropic", provider_batch_id="msgbatch_1",
        model="claude-opus-4-8", state=BatchJobState.RETRIEVING,
        custom_ids={"cid-A": {"retrieved": False, "result_state": None},
                    "cid-B": {"retrieved": False, "result_state": None}},
    )


def _results():
    return [
        BatchResult(custom_id="cid-A", text="A", prompt_tokens=100, completion_tokens=10,
                    model="claude-opus-4-8"),
        BatchResult(custom_id="cid-B", text="B", prompt_tokens=200, completion_tokens=20,
                    model="claude-opus-4-8"),
    ]


async def test_batch_store_save_get_list():
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)
    got = await store.get("batch-x")
    assert got is not None and got.provider_batch_id == "msgbatch_1"
    assert len(await store.list()) == 1


async def test_process_results_writes_one_usagedoc_each_at_batch_rate():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    recorded = await store.process_results(job, _results(), gw)
    assert len(recorded) == 2

    docs = await _usage_docs(es)
    assert len(docs) == 2  # exactly one UsageDoc per result (#6)
    for d in docs:
        assert d["batch"] is True
        assert d["outcome"] == UsageOutcome.OK.value
    # cid-A: 100 in + 10 out at opus (5.0/25.0), halved by batch.
    by_case = {d["prompt_tokens"]: d for d in docs}
    a = by_case[100]
    expected_a = round(((100 / 1e6) * 5.0 + (10 / 1e6) * 25.0) * 0.5, 8)
    assert a["cost"] == pytest.approx(expected_a)

    # Both custom_ids flagged retrieved; job flips to RETRIEVED.
    reloaded = await store.get("batch-x")
    assert reloaded.state == BatchJobState.RETRIEVED
    assert reloaded.terminal_compacted is True
    assert reloaded.custom_ids == {}
    assert reloaded.summary_total == 2
    assert reloaded.summary_retrieved == 2


async def test_process_results_idempotent_no_double_write():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    await store.process_results(job, _results(), gw)
    assert len(await _usage_docs(es)) == 2

    # Re-process the SAME results (a re-poll / restart) -> zero new ledger rows.
    reloaded = await store.get("batch-x")
    newly = await store.process_results(reloaded, _results(), gw)
    assert newly == []
    assert len(await _usage_docs(es)) == 2  # still exactly two (#6 exactly-once)


async def test_concurrent_process_results_bill_each_custom_id_once():
    """FINDING #3 / #6 — two OVERLAPPING process_results calls over the SAME results must
    bill each custom_id EXACTLY once. The dedup is a CAS CLAIM (flip-to-retrieved INSIDE
    one kv_mutate) BEFORE billing, so a read-check-then-act double-write can't happen even
    when the two calls interleave."""
    import asyncio

    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    # Fire both folds concurrently over the identical result set.
    r1, r2 = await asyncio.gather(
        store.process_results(await store.get("batch-x"), _results(), gw),
        store.process_results(await store.get("batch-x"), _results(), gw),
    )
    # Across BOTH calls, each custom_id was recorded exactly once (union has 2, no dup).
    recorded_ids = [r.custom_id for r in r1] + [r.custom_id for r in r2]
    assert sorted(recorded_ids) == ["cid-A", "cid-B"]
    # And the ledger holds exactly two rows — no double-write under concurrency (#6).
    assert len(await _usage_docs(es)) == 2
    done = await store.get("batch-x")
    assert done.state == BatchJobState.RETRIEVED
    assert done.terminal_compacted is True
    assert done.custom_ids == {}
    assert done.summary_total == 2
    assert done.summary_retrieved == 2


async def test_process_results_partial_then_remainder():
    """Only cid-A comes back first (partial retrieval); cid-B later. Each is billed
    exactly once and only the newly-seen result writes a row."""
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    first = [BatchResult(custom_id="cid-A", text="A", prompt_tokens=100, completion_tokens=10,
                         model="claude-opus-4-8")]
    await store.process_results(await store.get("batch-x"), first, gw)
    assert len(await _usage_docs(es)) == 1
    mid = await store.get("batch-x")
    assert mid.custom_ids["cid-A"]["retrieved"] is True
    assert mid.custom_ids["cid-B"]["retrieved"] is False
    assert mid.state == BatchJobState.RETRIEVING  # not all retrieved yet

    # Now the FULL set arrives; only cid-B is new.
    newly = await store.process_results(await store.get("batch-x"), _results(), gw)
    assert {r.custom_id for r in newly} == {"cid-B"}
    assert len(await _usage_docs(es)) == 2
    done = await store.get("batch-x")
    assert done.state == BatchJobState.RETRIEVED


async def test_error_result_records_error_row_and_marks_retrieved():
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    await store.save(job)

    results = [
        BatchResult(custom_id="cid-A", text="A", prompt_tokens=100, completion_tokens=10,
                    model="claude-opus-4-8"),
        BatchResult(custom_id="cid-B", result_type="errored", error="boom",
                    model="claude-opus-4-8"),
    ]
    recorded = await store.process_results(job, results, gw)
    assert {r.custom_id for r in recorded} == {"cid-A"}  # only the OK one is returned
    docs = await _usage_docs(es)
    assert len(docs) == 2  # one OK + one ERROR row, still one per result (#6)
    outcomes = sorted(d["outcome"] for d in docs)
    assert outcomes == sorted([UsageOutcome.OK.value, UsageOutcome.ERROR.value])
    # The errored custom_id is still marked retrieved so it is not retried.
    reloaded = await store.get("batch-x")
    assert reloaded.terminal_compacted is True
    assert reloaded.custom_ids == {}
    assert reloaded.summary_total == 2
    assert reloaded.summary_retrieved == 2
    assert reloaded.summary_failed == 1


async def test_load_open_jobs_resume_after_restart():
    kv = _kv()
    store = BatchJobStore(kv)
    # A still-polling job + a fully-retrieved job + an errored job.
    await store.save(BatchJob(id="batch-open", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.POLLING,
                              custom_ids={"c1": {"retrieved": False}}))
    await store.save(BatchJob(id="batch-done", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.RETRIEVED,
                              custom_ids={"c2": {"retrieved": True}}))
    await store.save(BatchJob(id="batch-err", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.ERRORED,
                              custom_ids={"c3": {"retrieved": False}}))

    # Simulate a restart: a fresh store over the SAME KV backend.
    resumed = BatchJobStore(kv)
    open_ids = {j.id for j in await resumed.load_open_jobs()}
    assert open_ids == {"batch-open"}  # done + errored are closed


async def test_retrieved_but_incomplete_job_is_still_open():
    """A job stamped RETRIEVED but with a custom_id still un-retrieved (e.g. a partial
    provider result) is still returned by load_open_jobs so the remainder gets folded."""
    kv = _kv()
    store = BatchJobStore(kv)
    await store.save(BatchJob(id="batch-partial", provider="anthropic",
                              model="claude-opus-4-8", state=BatchJobState.RETRIEVED,
                              custom_ids={"c1": {"retrieved": True},
                                          "c2": {"retrieved": False}}))
    open_ids = {j.id for j in await BatchJobStore(kv).load_open_jobs()}
    assert open_ids == {"batch-partial"}


class _FlakySubmitProvider:
    def __init__(self) -> None:
        self.attempts = 0

    async def submit(self, model, requests):
        self.attempts += 1
        if self.attempts == 1:
            raise RuntimeError("provider temporarily unavailable")
        return BatchJob(
            provider="anthropic",
            provider_batch_id="remote-accepted",
            model=model,
            state=BatchJobState.POLLING,
            custom_ids={
                str(req["custom_id"]): {"retrieved": False, "result_state": None}
                for req in requests
            },
        )

    async def aclose(self):
        return None


async def test_batch_service_persists_local_outbox_before_remote_and_retries():
    store = BatchJobStore(_kv())
    provider = _FlakySubmitProvider()
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )
    requests = [{"custom_id": "stable-cid", "params": {"messages": []}}]

    queued = await service.submit("anthropic", "claude-haiku-4-5-20251001", requests)
    assert queued.provider_batch_id is None
    assert queued.requests == requests
    assert queued.submit_attempts == 1
    assert "temporarily unavailable" in (queued.last_error or "")
    assert await store.get(queued.id) is not None  # durable before remote acceptance

    accepted = await service.poll(queued)
    assert accepted.id == queued.id  # deterministic local identity survives provider id
    assert accepted.provider_batch_id == "remote-accepted"
    assert accepted.submit_attempts == 2
    assert accepted.last_error is None

    # Replaying the same accepted intent returns the existing outbox job and performs
    # no third remote submit.
    duplicate = await service.submit(
        "anthropic", "claude-haiku-4-5-20251001", requests
    )
    assert duplicate.id == accepted.id
    assert provider.attempts == 2


async def test_concurrent_identical_submits_call_remote_provider_once():
    store = BatchJobStore(_kv())
    provider = _FlakySubmitProvider()
    # Let the first remote call succeed so both callers race only at local creation.
    provider.attempts = 1
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )
    requests = [{"custom_id": "same-cid", "params": {"messages": []}}]

    first, second = await asyncio.gather(
        service.submit("anthropic", "claude-haiku-4-5-20251001", requests),
        service.submit("anthropic", "claude-haiku-4-5-20251001", requests),
    )

    assert first.id == second.id
    assert provider.attempts == 2  # one seeded count + exactly one remote call
    assert len(await store.list_strict()) == 1


class _BlockingSubmitProvider:
    def __init__(self) -> None:
        self.calls = 0
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def submit(self, model, requests):
        self.calls += 1
        self.entered.set()
        await self.release.wait()
        return BatchJob(
            provider="anthropic",
            provider_batch_id="remote-once",
            model=model,
            state=BatchJobState.POLLING,
            custom_ids={
                str(req["custom_id"]): {"retrieved": False, "result_state": None}
                for req in requests
            },
        )

    async def aclose(self):
        return None


async def test_submit_and_scheduler_poll_share_one_provider_submission_lease():
    """Force the creator to pause in provider.submit while the scheduler sees the row."""
    store = BatchJobStore(_kv())
    provider = _BlockingSubmitProvider()
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )
    requests = [{"custom_id": "raced-cid", "params": {"messages": []}}]

    immediate = asyncio.create_task(
        service.submit("anthropic", "claude-haiku-4-5-20251001", requests)
    )
    await provider.entered.wait()
    visible = (await store.list_strict())[0]
    assert visible.provider_batch_id is None
    assert visible.submission_lease_token

    scheduler_result = await service.poll(visible)
    assert scheduler_result.provider_batch_id is None
    assert provider.calls == 1

    provider.release.set()
    accepted = await immediate
    assert accepted.provider_batch_id == "remote-once"
    assert accepted.submission_lease_token is None
    assert accepted.submit_attempts == 1
    assert provider.calls == 1


async def test_scheduler_reclaims_stale_provider_submission_lease():
    store = BatchJobStore(_kv())
    provider = _FlakySubmitProvider()
    provider.attempts = 1  # next provider call succeeds
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )
    requests = [{"custom_id": "stale-cid", "params": {"messages": []}}]
    local = BatchJob(
        id=service._outbox_id("anthropic", "claude-haiku-4-5-20251001", requests),
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        requests=requests,
        custom_ids={"stale-cid": {"retrieved": False, "result_state": None}},
    )
    await store.save(local)
    claimed, token = await store.claim_submission(local.id)
    assert claimed is not None and token

    # A live lease prevents a provider call.
    blocked = await service.poll(claimed)
    assert blocked.provider_batch_id is None
    assert provider.attempts == 1

    # Model a process crash by expiring the persisted lease, then let the scheduler
    # reclaim it. This does not claim to close the post-acceptance/pre-save window.
    def _expire(jobs):
        jobs[local.id].submission_lease_at_millis = 0
        return True

    await store._mutate(_expire)
    recovered = await service.poll(await store.get_strict(local.id))
    assert recovered.provider_batch_id == "remote-accepted"
    assert recovered.submission_lease_token is None
    assert recovered.submit_attempts == 2
    assert provider.attempts == 2


async def test_stale_submission_owner_cannot_overwrite_reclaimed_lease():
    store = BatchJobStore(_kv())
    local = BatchJob(
        id="lease-fence",
        provider="anthropic",
        model="claude-haiku-4-5-20251001",
        requests=[{"custom_id": "fenced", "params": {"messages": []}}],
    )
    await store.save(local)
    _first, old_token = await store.claim_submission(local.id)
    assert old_token

    def _expire(jobs):
        jobs[local.id].submission_lease_at_millis = 0
        return True

    await store._mutate(_expire)
    newer, new_token = await store.claim_submission(local.id)
    assert newer is not None and new_token and new_token != old_token
    remote = BatchJob(
        provider="anthropic",
        provider_batch_id="stale-remote",
        model=local.model,
        state=BatchJobState.POLLING,
    )

    with pytest.raises(RuntimeError, match="lease ownership changed"):
        await store.complete_submission(local.id, old_token, remote)
    with pytest.raises(RuntimeError, match="lease ownership changed"):
        await store.fail_submission(local.id, old_token, "late stale failure")
    durable = await store.get_strict(local.id)
    assert durable is not None
    assert durable.provider_batch_id is None
    assert durable.submission_lease_token == new_token
    assert durable.last_error is None


class _BlockingCloseProvider:
    def __init__(self) -> None:
        self.submit_calls = 0
        self.close_entered = asyncio.Event()
        self.release_close = asyncio.Event()

    async def submit(self, model, requests):
        self.submit_calls += 1
        return BatchJob(
            provider="anthropic",
            provider_batch_id="remote-before-close",
            model=model,
            state=BatchJobState.POLLING,
            custom_ids={
                str(req["custom_id"]): {"retrieved": False, "result_state": None}
                for req in requests
            },
        )

    async def aclose(self):
        self.close_entered.set()
        await self.release_close.wait()


async def test_provider_acceptance_is_durable_before_client_close_finishes():
    store = BatchJobStore(_kv())
    provider = _BlockingCloseProvider()
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )
    requests = [{"custom_id": "close-cid", "params": {"messages": []}}]

    immediate = asyncio.create_task(
        service.submit("anthropic", "claude-haiku-4-5-20251001", requests)
    )
    await provider.close_entered.wait()
    durable = (await store.list_strict())[0]
    assert durable.provider_batch_id == "remote-before-close"
    assert durable.submission_lease_token is None

    # Even a stale no-id snapshot cannot POST again: claim_submission re-reads the
    # accepted durable row before deciding whether to call the provider.
    stale = durable.model_copy(update={"provider_batch_id": None})
    scheduler_result = await service.poll(stale)
    assert scheduler_result.provider_batch_id == "remote-before-close"
    assert provider.submit_calls == 1

    provider.release_close.set()
    accepted = await immediate
    assert accepted.provider_batch_id == "remote-before-close"


async def test_acceptance_persistence_failure_keeps_lease_and_prevents_fast_resubmit(
    monkeypatch,
):
    store = BatchJobStore(_kv())
    provider = _FlakySubmitProvider()
    provider.attempts = 1  # the one provider call below succeeds
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )
    requests = [{"custom_id": "persist-cid", "params": {"messages": []}}]

    async def _unconfirmed_acceptance(*_args, **_kwargs):
        raise RuntimeError("state backend unavailable after remote acceptance")

    monkeypatch.setattr(store, "complete_submission", _unconfirmed_acceptance)
    with pytest.raises(RuntimeError, match="state backend unavailable"):
        await service.submit(
            "anthropic", "claude-haiku-4-5-20251001", requests
        )

    durable = (await store.list_strict())[0]
    assert durable.provider_batch_id is None
    assert durable.submission_lease_token
    assert durable.submit_attempts == 1
    assert provider.attempts == 2  # seeded count + one accepted remote call

    # The ambiguous accepted-but-unpersisted row remains leased. It is only eligible
    # for the documented bounded stale recovery, not an immediate duplicate POST.
    still_leased = await service.poll(durable)
    assert still_leased.provider_batch_id is None
    assert provider.attempts == 2


async def test_batch_service_never_submits_when_local_outbox_save_is_unconfirmed(
    monkeypatch,
):
    store = BatchJobStore(_kv())
    provider = _FlakySubmitProvider()
    service = _BatchJobService(
        store=store,
        gateway=object(),
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
    )

    async def _broken_put_if(*_args, **_kwargs):
        raise RuntimeError("state backend unavailable")

    monkeypatch.setattr(store._kv, "put_if_strict", _broken_put_if)
    with pytest.raises(RuntimeError, match="state backend unavailable"):
        await service.submit(
            "anthropic",
            "claude-haiku-4-5-20251001",
            [{"custom_id": "never-remote", "params": {"messages": []}}],
        )
    assert provider.attempts == 0
    assert await store.get("missing") is None


class _FailOnceUsageES(InMemoryESClient):
    def __init__(self) -> None:
        super().__init__()
        self.fail_usage = True

    async def index_doc(self, index, doc, doc_id=None, refresh=False):
        if index == USAGE_WRITE_ALIAS and self.fail_usage:
            self.fail_usage = False
            raise RuntimeError("ledger unavailable")
        return await super().index_doc(index, doc, doc_id=doc_id, refresh=refresh)


async def test_batch_usage_failure_leaves_result_unretrieved_then_retries():
    es = _FailOnceUsageES()
    gateway = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    await store.save(_job())
    one = [_results()[0]]

    first = await store.process_results(await store.get("batch-x"), one, gateway)
    assert first == []
    failed = await store.get("batch-x")
    assert failed.custom_ids["cid-A"]["retrieved"] is False
    assert not failed.custom_ids["cid-A"].get("recording_token")
    assert await _usage_docs(es) == []

    second = await store.process_results(failed, one, gateway)
    assert [result.custom_id for result in second] == ["cid-A"]
    recovered = await store.get("batch-x")
    assert recovered.custom_ids["cid-A"]["retrieved"] is True
    assert recovered.last_error is None
    docs = await _usage_docs(es)
    assert len(docs) == 1
    assert docs[0]["idempotency_key"] == "batch:batch-x:cid-A"


async def test_crash_after_ledger_write_retries_without_duplicate_row(monkeypatch):
    es = InMemoryESClient()
    gateway = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    await store.save(_job())
    original_finalize = store._finalize_lease

    async def _simulate_crash(*_args, **_kwargs):
        return False

    monkeypatch.setattr(store, "_finalize_lease", _simulate_crash)
    assert await store.process_results(
        await store.get("batch-x"), [_results()[0]], gateway
    ) == []
    assert len(await _usage_docs(es)) == 1
    mid = await store.get("batch-x")
    assert mid.custom_ids["cid-A"]["retrieved"] is False

    # Simulate lease expiry after restart, restore normal finalisation, and replay.
    def _expire(jobs):
        entry = jobs["batch-x"].custom_ids["cid-A"]
        entry["recording_at_millis"] = 0
        return True

    await store._mutate(_expire)
    monkeypatch.setattr(store, "_finalize_lease", original_finalize)
    replayed = await store.process_results(
        await store.get("batch-x"), [_results()[0]], gateway
    )
    assert [result.custom_id for result in replayed] == ["cid-A"]
    assert (await store.get("batch-x")).custom_ids["cid-A"]["retrieved"] is True
    # ES strict persistence used the same deterministic document id, so the replay
    # overwrote the authoritative logical row instead of appending another charge.
    assert len(await _usage_docs(es)) == 1


async def test_finalize_cas_failure_never_returns_reentry_ready_result(monkeypatch):
    es = InMemoryESClient()
    gateway = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    await store.save(_job())
    original_put_if = store._kv.put_if_strict
    calls = 0

    async def _fail_finalize(namespace, key, value, expected_rev):
        nonlocal calls
        calls += 1
        if calls == 2:  # lease is durable; ledger succeeds; finalise persistence fails
            raise RuntimeError("finalize CAS unavailable")
        return await original_put_if(namespace, key, value, expected_rev)

    monkeypatch.setattr(store._kv, "put_if_strict", _fail_finalize)
    with pytest.raises(RuntimeError, match="finalize CAS unavailable"):
        await store.process_results(
            await store.get("batch-x"), [_results()[0]], gateway
        )
    assert len(await _usage_docs(es)) == 1
    mid = await store.get("batch-x")
    assert mid.custom_ids["cid-A"]["retrieved"] is False

    # Restore persistence, expire the abandoned lease, and replay. The deterministic
    # ledger id overwrites the same logical row; only the durably finalised attempt is
    # returned to the caller.
    monkeypatch.setattr(store._kv, "put_if_strict", original_put_if)

    def _expire(jobs):
        jobs["batch-x"].custom_ids["cid-A"]["recording_at_millis"] = 0
        return True

    await store._mutate(_expire)
    replayed = await store.process_results(
        await store.get("batch-x"), [_results()[0]], gateway
    )
    assert [result.custom_id for result in replayed] == ["cid-A"]
    assert len(await _usage_docs(es)) == 1


class _StaticResultsProvider:
    def __init__(self, results):
        self._results = results

    async def results(self, _job):
        return list(self._results)

    async def aclose(self):
        return None


async def test_detection_reentry_failure_retries_without_duplicate_ledger_row():
    es = InMemoryESClient()
    gateway = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    store = BatchJobStore(_kv())
    job = _job()
    job.custom_ids = {"cid-A": {"retrieved": False, "result_state": None}}
    job.candidates = {"cid-A": {"summary": {}}}
    await store.save(job)
    result = _results()[0]
    provider = _StaticResultsProvider([result])
    attempts = 0

    async def _reenter(_job, results):
        nonlocal attempts
        attempts += 1
        assert [item.custom_id for item in results] == ["cid-A"]
        if attempts == 1:
            raise RuntimeError("case pipeline temporarily unavailable")
        return 1

    service = _BatchJobService(
        store=store,
        gateway=gateway,
        make_provider=lambda _name: provider,
        get_prefs=lambda: object(),
        reenter=_reenter,
    )

    assert await service.process(await store.get("batch-x")) == []
    failed = await store.get("batch-x")
    assert failed.custom_ids["cid-A"]["retrieved"] is True
    assert failed.custom_ids["cid-A"]["reentry_state"] == "pending"
    assert "temporarily unavailable" in (failed.last_error or "")
    assert len(await _usage_docs(es)) == 1

    completed = await service.process(await store.get("batch-x"))
    assert [item.custom_id for item in completed] == ["cid-A"]
    done = await store.get("batch-x")
    assert done.state == BatchJobState.RETRIEVED
    assert done.terminal_compacted is True
    assert done.custom_ids == {}
    assert done.summary_total == 1
    assert done.summary_retrieved == 1
    assert done.state == BatchJobState.RETRIEVED
    assert len(await _usage_docs(es)) == 1
