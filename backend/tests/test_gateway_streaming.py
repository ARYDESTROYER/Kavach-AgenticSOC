"""Gateway Live-text streaming (chat revamp SPEC §6.3, §4.5) — offline.

Pins the one-entry-point contract: ``LLMGateway.complete(..., on_text=...)`` streams
through ``provider.complete_stream`` while the budget pre-flight, breaker admission,
failure classification and the single ledger write stay in ``complete`` (#6). The
HTTP-level tests drive the real OpenAI/Anthropic providers over ``httpx.MockTransport``
so the SSE parsing, retry boundary and fallbacks run exactly as in production.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

import httpx
import pytest

from app.config import BudgetConfig, ModelConfig, Secrets
from app.constants import USAGE_READ_PATTERN, Role, UsageOutcome
from app.engine.budget import BudgetGate
from app.es.fake import InMemoryESClient
from app.llm import providers as providers_mod
from app.llm.gateway import (
    FAILURE_ABANDONED,
    FAILURE_STREAM_INTERRUPTED,
    PROVIDER_FAILURE_CLASSES,
    BudgetBlocked,
    GatewayError,
    LLMGateway,
    UsageReceipt,
    classify_provider_failure,
    estimate_message_tokens,
    estimate_text_tokens,
)
from app.llm.provider_health import IMMEDIATE_TRIP_CLASSES, ProviderHealth
from app.llm.providers import (
    PROVIDER_REGISTRY,
    AnthropicProvider,
    AzureOpenAIProvider,
    BaseProvider,
    CompletionResult,
    DemoMockProvider,
    MockProvider,
    OpenAIProvider,
    ProviderError,
    StreamInterrupted,
    _demo_stream_chunks,
    _word_groups,
    normalise_finish_reason,
    provider_streams_text,
)
from app.stores.usage import UsageStore

MESSAGES = [
    {"role": "system", "content": "You are a SOC assistant. " * 20},
    {"role": "user", "content": "How many failed logins today?"},
]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class _ByteStream(httpx.AsyncByteStream):
    """An SSE body delivered chunk by chunk, optionally failing or blocking after."""

    def __init__(self, chunks: list[bytes], *, error: Exception | None = None,
                 block: asyncio.Event | None = None) -> None:
        self._chunks = chunks
        self._error = error
        self._block = block

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk
        if self._block is not None:
            await self._block.wait()
        if self._error is not None:
            raise self._error

    async def aclose(self) -> None:
        return None


def _sse(*events: Any, done: bool = False) -> list[bytes]:
    out = [f"data: {json.dumps(e)}\n\n".encode() for e in events]
    if done:
        out.append(b"data: [DONE]\n\n")
    return out


def _openai_chunk(text: str | None = None, *, finish: str | None = None,
                  usage: dict | None = None) -> dict:
    if usage is not None:
        return {"choices": [], "usage": usage}
    delta = {"content": text} if text is not None else {"role": "assistant"}
    return {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


class _Recorder:
    """A MockTransport handler serving one scripted response per request."""

    def __init__(self, responses: list[Callable[[], httpx.Response]]) -> None:
        self._responses = list(responses)
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content or b"{}"))
        return self._responses.pop(0)()


def _stream_response(chunks: list[bytes], **kwargs: Any) -> Callable[[], httpx.Response]:
    return lambda: httpx.Response(
        200, headers={"content-type": "text/event-stream"},
        stream=_ByteStream(chunks, **kwargs),
    )


def _json_response(status: int, body: dict, headers: dict | None = None):
    return lambda: httpx.Response(status, json=body, headers=headers or {})


async def _install(provider: Any, recorder: _Recorder, base_url: str) -> None:
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=base_url, transport=httpx.MockTransport(recorder)
    )


async def _openai(recorder: _Recorder, *, base_url: str = "https://api.openai.com",
                  **kwargs: Any) -> OpenAIProvider:
    provider = OpenAIProvider("sk-test", base_url=base_url, **kwargs)
    await _install(provider, recorder, base_url)
    return provider


async def _anthropic(recorder: _Recorder) -> AnthropicProvider:
    provider = AnthropicProvider("sk-ant")
    await _install(provider, recorder, "https://api.anthropic.com")
    return provider


class _Collect:
    def __init__(self) -> None:
        self.deltas: list[str] = []

    async def __call__(self, delta: str) -> None:
        self.deltas.append(delta)


async def _usage_docs(es: InMemoryESClient) -> list[dict]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [hit["_source"] for hit in resp["hits"]["hits"]]


def _gateway(provider: Any, es: InMemoryESClient, *, name: str = "openai", **kwargs: Any) -> LLMGateway:
    return LLMGateway(Secrets(_env_file=None), UsageStore(es),
                      provider_overrides={name: provider}, **kwargs)


# =========================================================================== #
# OpenAI streaming
# =========================================================================== #
async def test_openai_stream_relays_deltas_in_order_and_reads_final_usage() -> None:
    recorder = _Recorder([_stream_response(_sse(
        _openai_chunk(None),
        _openai_chunk("Fifty "),
        _openai_chunk("two "),
        _openai_chunk("failures.", finish="stop"),
        _openai_chunk(usage={"prompt_tokens": 300, "completion_tokens": 7,
                             "prompt_tokens_details": {"cached_tokens": 100}}),
        done=True,
    ))])
    provider = await _openai(recorder)
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 500, sink)

    assert sink.deltas == ["Fifty ", "two ", "failures."]
    assert result.text == "Fifty two failures."
    # Usage comes from the final (choices-empty) chunk, with OpenAI's cached slice
    # split out exactly like the blocking path (uncached remainder + cache_read).
    assert (result.prompt_tokens, result.cache_read_tokens, result.completion_tokens) == (200, 100, 7)
    assert result.usage_estimated is False
    assert result.finish_reason == "stop"
    body = recorder.requests[0]
    assert body["stream"] is True and body["stream_options"] == {"include_usage": True}
    assert body["temperature"] == 0.1 and body["max_tokens"] == 500


async def test_openai_compatible_400_retries_once_without_stream_options() -> None:
    recorder = _Recorder([
        _json_response(400, {"error": {"message": "unknown field stream_options"}}),
        _stream_response(_sse(_openai_chunk("hello"), _openai_chunk(" world", finish="length"))),
    ])
    provider = await _openai(recorder, base_url="http://vllm.local:8000")
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "local-llama", 0.1, 50, sink)

    assert "stream_options" in recorder.requests[0]
    assert "stream_options" not in recorder.requests[1] and recorder.requests[1]["stream"] is True
    assert sink.deltas == ["hello", " world"]
    # No include_usage → no usage chunk: counts are chars/4 estimates, honestly flagged.
    assert result.usage_estimated is True
    assert result.completion_tokens == max(1, len("hello world") // 4)
    assert result.finish_reason == "length"


async def test_openai_compatible_second_400_falls_back_to_a_blocking_call() -> None:
    recorder = _Recorder([
        _json_response(400, {"error": {"message": "stream_options unsupported"}}),
        _json_response(400, {"error": {"message": "streaming unsupported"}}),
        _json_response(200, {"choices": [{"message": {"content": "whole answer"},
                                          "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 40, "completion_tokens": 3}}),
    ])
    provider = await _openai(recorder, base_url="http://litellm.local")
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "local-llama", 0.1, 50, sink)

    assert "stream" not in recorder.requests[2]
    assert sink.deltas == ["whole answer"]
    assert (result.prompt_tokens, result.completion_tokens) == (40, 3)


async def test_a_compatible_server_that_ignores_stream_is_read_as_one_piece() -> None:
    recorder = _Recorder([_json_response(200, {
        "choices": [{"message": {"content": "plain body"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 2},
    })])
    provider = await _openai(recorder, base_url="http://ollama.local:11434")
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "llama3", 0.1, 50, sink)
    assert sink.deltas == ["plain body"] and len(recorder.requests) == 1
    assert (result.prompt_tokens, result.completion_tokens) == (12, 2)
    assert result.finish_reason == "stop" and result.usage_estimated is False


async def test_official_openai_400_is_a_real_error_not_a_stream_options_retry() -> None:
    recorder = _Recorder([_json_response(400, {"error": {"message": "bad request"}})])
    provider = await _openai(recorder)
    with pytest.raises(ProviderError) as raised:
        await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 50, _Collect())
    assert raised.value.status == 400
    assert len(recorder.requests) == 1


async def test_failure_before_the_first_delta_is_retried() -> None:
    recorder = _Recorder([
        _json_response(503, {"error": "busy"}, headers={"retry-after": "0"}),
        _stream_response(_sse(_openai_chunk("ok", finish="stop"), done=True)),
    ])
    provider = await _openai(recorder)
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 50, sink)
    assert len(recorder.requests) == 2
    assert sink.deltas == ["ok"] and result.text == "ok"
    assert providers_mod.last_attempt_count() == 2


async def test_failure_after_the_first_delta_is_interrupted_and_not_retried() -> None:
    recorder = _Recorder([
        _stream_response(_sse(_openai_chunk("partial ")), error=httpx.ReadError("reset")),
        _stream_response(_sse(_openai_chunk("second attempt", finish="stop"), done=True)),
    ])
    provider = await _openai(recorder)
    sink = _Collect()
    with pytest.raises(StreamInterrupted) as raised:
        await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 50, sink)
    assert raised.value.retryable is False
    assert len(recorder.requests) == 1, "a stream that already showed text is never retried"
    assert sink.deltas == ["partial "]


async def test_a_stream_cut_off_without_a_terminator_is_not_a_whole_answer() -> None:
    recorder = _Recorder([_stream_response(_sse(_openai_chunk("half an ans")))])
    provider = await _openai(recorder)
    with pytest.raises(StreamInterrupted):
        await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 50, _Collect())


async def test_blocking_openai_request_shape_is_unchanged() -> None:
    """``on_text=None`` keeps today's request byte-for-byte: no stream keys."""
    recorder = _Recorder([_json_response(200, {
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
    })])
    provider = await _openai(recorder)
    result = await provider.complete("chat", MESSAGES, "gpt-4o", 0.1, 500)
    assert recorder.requests[0] == {
        "model": "gpt-4o", "messages": MESSAGES, "temperature": 0.1, "max_tokens": 500,
    }
    assert (result.prompt_tokens, result.completion_tokens) == (10, 2)
    assert result.finish_reason == "stop" and result.usage_estimated is False


# =========================================================================== #
# Anthropic streaming
# =========================================================================== #
def _anthropic_events(*texts: str, stop: str = "end_turn", error_after: int | None = None) -> list[dict]:
    events: list[dict] = [{
        "type": "message_start",
        "message": {"usage": {"input_tokens": 420, "output_tokens": 1,
                              "cache_read_input_tokens": 64,
                              "cache_creation_input_tokens": 8}},
    }, {"type": "content_block_start", "index": 0,
        "content_block": {"type": "text", "text": ""}}]
    for i, text in enumerate(texts):
        if error_after is not None and i == error_after:
            events.append({"type": "error", "error": {"type": "overloaded_error",
                                                       "message": "<html>secret</html>"}})
            return events
        events.append({"type": "content_block_delta", "index": 0,
                       "delta": {"type": "text_delta", "text": text}})
    events += [
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 9}},
        {"type": "message_stop"},
    ]
    return events


async def test_anthropic_stream_reads_start_and_delta_usage() -> None:
    recorder = _Recorder([_stream_response(_sse(*_anthropic_events("Brute ", "force ", "seen.",
                                                                    stop="max_tokens")))])
    provider = await _anthropic(recorder)
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "claude-sonnet-4-6", 0.1, 64, sink)

    assert sink.deltas == ["Brute ", "force ", "seen."]
    assert result.text == "Brute force seen."
    assert result.prompt_tokens == 420 and result.completion_tokens == 9
    assert (result.cache_read_tokens, result.cache_write_tokens) == (64, 8)
    assert result.finish_reason == "length" and result.usage_estimated is False
    assert recorder.requests[0]["stream"] is True
    assert recorder.requests[0]["system"].startswith("You are a SOC assistant.")


async def test_anthropic_error_event_before_text_is_retried_after_text_interrupts(monkeypatch) -> None:
    async def _no_sleep(_delay: float) -> None:
        return None

    # An in-band error event carries no Retry-After, so skip the jittered backoff via
    # the retry-wait seam (never by swapping out the whole asyncio module).
    monkeypatch.setattr(providers_mod, "_retry_sleep", _no_sleep)
    recorder = _Recorder([
        _stream_response(_sse(*_anthropic_events("x", error_after=0))),
        _stream_response(_sse(*_anthropic_events("ok"))),
    ])
    provider = await _anthropic(recorder)
    result = await provider.complete_stream("chat", MESSAGES, "claude-sonnet-4-6", 0.1, 64, _Collect())
    assert result.text == "ok" and len(recorder.requests) == 2

    recorder = _Recorder([_stream_response(_sse(*_anthropic_events("a", "b", error_after=1)))])
    provider = await _anthropic(recorder)
    with pytest.raises(StreamInterrupted) as raised:
        await provider.complete_stream("chat", MESSAGES, "claude-sonnet-4-6", 0.1, 64, _Collect())
    # #9: the provider's message text never becomes our message.
    assert "secret" not in str(raised.value) and "secret" not in str(raised.value.__cause__)


# =========================================================================== #
# Gateway: one choke point, one UsageDoc
# =========================================================================== #
async def test_gateway_streams_and_writes_exactly_one_usage_doc() -> None:
    recorder = _Recorder([_stream_response(_sse(
        _openai_chunk("a"), _openai_chunk("b", finish="stop"),
        _openai_chunk(usage={"prompt_tokens": 120, "completion_tokens": 2}), done=True,
    ))])
    es = InMemoryESClient()
    gw = _gateway(await _openai(recorder), es)
    sink = _Collect()
    result = await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                               surface="chat", on_text=sink)

    assert sink.deltas == ["a", "b"] and result.text == "ab"
    rows = await _usage_docs(es)
    assert len(rows) == 1
    assert rows[0]["outcome"] == UsageOutcome.OK.value
    assert (rows[0]["prompt_tokens"], rows[0]["completion_tokens"]) == (120, 2)
    assert rows[0]["surface"] == "chat" and rows[0]["role"] == "chat"
    assert result.cost > 0 and result.pricing_source == rows[0]["pricing_source"]
    assert result.latency_ms == rows[0]["latency_ms"]


async def test_on_text_none_is_the_historical_blocking_path() -> None:
    class _NoStream(MockProvider):
        async def complete_stream(self, *args, **kwargs):  # pragma: no cover - must not run
            raise AssertionError("a blocking call must never stream")

    es = InMemoryESClient()
    provider = _NoStream()
    gw = _gateway(provider, es, name="mock")
    cfg = ModelConfig(provider="mock", model="mock")
    result = await gw.complete(Role.ROUTER, MESSAGES, cfg, surface="router", case_id="c1")

    assert len(provider.calls) == 1
    rows = await _usage_docs(es)
    assert len(rows) == 1
    row = rows[0]
    assert row["prompt_tokens"] == result.prompt_tokens == len(json.dumps(MESSAGES)) // 4
    assert row["failure_class"] == "" and row["outcome"] == UsageOutcome.OK.value
    assert row["case_id"] == "c1" and row["attempts"] == 1


async def test_a_non_streaming_provider_delivers_the_whole_text_once() -> None:
    es = InMemoryESClient()
    provider = MockProvider()
    provider.push("chat", "the whole answer")
    gw = _gateway(provider, es, name="mock")
    sink = _Collect()
    result = await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="mock", model="mock"),
                               on_text=sink)
    assert sink.deltas == ["the whole answer"] and result.text == "the whole answer"
    assert len(await _usage_docs(es)) == 1


async def test_a_duck_typed_provider_without_complete_stream_still_works() -> None:
    class _Plugin:
        async def complete(self, role, messages, model, temperature, max_tokens):
            return CompletionResult(text="plugin text", prompt_tokens=5, completion_tokens=2,
                                    model=model)

    es = InMemoryESClient()
    gw = _gateway(_Plugin(), es, name="mock")
    sink = _Collect()
    await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="mock", model="mock"), on_text=sink)
    assert sink.deltas == ["plugin text"]
    assert len(await _usage_docs(es)) == 1


async def test_a_failing_on_text_never_fails_the_call_or_blames_the_provider() -> None:
    recorder = _Recorder([_stream_response(_sse(
        _openai_chunk("one "), _openai_chunk("two", finish="stop"), done=True,
    ))])
    es = InMemoryESClient()
    tracker = ProviderHealth()
    gw = _gateway(await _openai(recorder), es, provider_health=tracker)
    calls: list[str] = []

    async def _broken(delta: str) -> None:
        calls.append(delta)
        raise RuntimeError("consumer bug")

    result = await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                               on_text=_broken)
    assert result.text == "one two"
    assert calls == ["one "], "relaying stops after the first callback failure"
    rows = await _usage_docs(es)
    assert len(rows) == 1 and rows[0]["outcome"] == UsageOutcome.OK.value
    assert tracker.snapshot()["providers"]["openai:completion"]["consecutive_failures"] == 0


async def test_gateway_stream_interrupted_is_classified_ledgered_and_not_retried() -> None:
    recorder = _Recorder([
        _stream_response(_sse(_openai_chunk("x" * 40)), error=httpx.ReadError("reset")),
    ])
    es = InMemoryESClient()
    tracker = ProviderHealth()
    gw = _gateway(await _openai(recorder), es, provider_health=tracker)
    with pytest.raises(GatewayError) as raised:
        await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                          on_text=_Collect())

    assert raised.value.failure_class == FAILURE_STREAM_INTERRUPTED
    assert str(raised.value) == "provider call failed (stream_interrupted)"
    assert len(recorder.requests) == 1
    rows = await _usage_docs(es)
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == UsageOutcome.ERROR.value
    assert row["failure_class"] == FAILURE_STREAM_INTERRUPTED
    # The stream was answering: input is billed, so never 0 (chars/4 of the messages
    # here because OpenAI reports usage only at the end), output = chars/4 received.
    assert row["prompt_tokens"] == estimate_message_tokens(MESSAGES) > 0
    assert row["completion_tokens"] == 10
    # Provider health sees it as an ordinary (non-immediate) failure of its own class.
    provider_row = tracker.snapshot()["providers"]["openai:completion"]
    assert provider_row["last_failure_class"] == FAILURE_STREAM_INTERRUPTED


def test_stream_interrupted_is_a_provider_class_but_never_an_immediate_trip() -> None:
    assert FAILURE_STREAM_INTERRUPTED in PROVIDER_FAILURE_CLASSES
    assert FAILURE_STREAM_INTERRUPTED not in IMMEDIATE_TRIP_CLASSES
    assert FAILURE_ABANDONED not in PROVIDER_FAILURE_CLASSES
    # The phase wins over any status the cause carried.
    interrupted = StreamInterrupted()
    interrupted.status = 401
    assert classify_provider_failure(interrupted) == FAILURE_STREAM_INTERRUPTED


async def test_cancel_after_first_delta_records_one_row_with_billed_input() -> None:
    """SPEC §6.3: a cancelled stream is ledgered with the provider's input count (from
    Anthropic's ``message_start``) and chars/4 of the received text — never 0/0."""
    gate = asyncio.Event()
    events = _anthropic_events("y" * 60)[:3]  # message_start, block start, one delta
    recorder = _Recorder([_stream_response(_sse(*events), block=gate)])
    es = InMemoryESClient()
    gw = _gateway(await _anthropic(recorder), es, name="anthropic")
    got_text = asyncio.Event()

    async def _on_text(delta: str) -> None:
        got_text.set()

    task = asyncio.create_task(gw.complete(
        Role.CHAT, MESSAGES, ModelConfig(provider="anthropic", model="claude-sonnet-4-6"),
        surface="chat", on_text=_on_text,
    ))
    await asyncio.wait_for(got_text.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    rows = await _usage_docs(es)
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["outcome"] == UsageOutcome.ERROR.value
    assert row["failure_class"] == FAILURE_ABANDONED
    assert row["prompt_tokens"] == 420
    assert (row["cache_read_tokens"], row["cache_write_tokens"]) == (64, 8)
    assert row["completion_tokens"] == 15
    assert row["cost"] > 0
    if "usage_estimated" in row:
        assert row["usage_estimated"] is True


async def test_cancel_of_a_blocking_call_records_estimated_input_not_zero() -> None:
    class _Slow(MockProvider):
        async def complete(self, role, messages, model, temperature, max_tokens):
            await asyncio.sleep(30)
            raise AssertionError("unreachable")

    es = InMemoryESClient()
    gw = _gateway(_Slow(), es, name="openai")
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            gw.complete(Role.INVESTIGATOR, MESSAGES, ModelConfig(provider="openai", model="gpt-4o")),
            timeout=0.05,
        )
    rows = await _usage_docs(es)
    assert len(rows) == 1
    assert rows[0]["failure_class"] == FAILURE_ABANDONED
    assert rows[0]["prompt_tokens"] == estimate_message_tokens(MESSAGES) > 0
    assert rows[0]["completion_tokens"] == 0


async def test_cancel_while_the_fallback_delivers_text_uses_the_provider_counts() -> None:
    """The one-shot default reports the finished call's usage before handing over the
    text, so a cancel during that hand-over ledgers real input, not an estimate."""
    class _Done(MockProvider):
        async def complete(self, role, messages, model, temperature, max_tokens):
            return CompletionResult(text="z" * 80, prompt_tokens=777, completion_tokens=20,
                                    model=model)

    es = InMemoryESClient()
    gw = _gateway(_Done(), es)
    started = asyncio.Event()

    async def _slow_consumer(delta: str) -> None:
        started.set()
        await asyncio.sleep(30)

    task = asyncio.create_task(gw.complete(
        Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
        on_text=_slow_consumer,
    ))
    await asyncio.wait_for(started.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    rows = await _usage_docs(es)
    assert len(rows) == 1
    assert (rows[0]["prompt_tokens"], rows[0]["completion_tokens"]) == (777, 20)
    assert rows[0]["failure_class"] == FAILURE_ABANDONED


def test_token_estimators() -> None:
    assert estimate_message_tokens([{"role": "user", "content": "abcdefgh"}]) == 2
    assert estimate_message_tokens([]) == 1
    assert estimate_text_tokens("") == 0 and estimate_text_tokens("ab") == 1
    assert estimate_text_tokens(40) == 10


# =========================================================================== #
# BudgetBlocked
# =========================================================================== #
class _OverBudgetUsage:
    async def summary(self, window_hours: int = 24, case_id=None):
        return {"today_cost": 1000.0, "total_cost": 1000.0}


async def test_budget_block_is_typed_unledgered_and_not_a_provider_failure() -> None:
    es = InMemoryESClient()
    provider = MockProvider()
    tracker = ProviderHealth()
    gate = BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, daily_usd=0.01,
                                                      on_exceed="block"),
                      usage_store=_OverBudgetUsage())
    gw = _gateway(provider, es, budget_gate=gate, provider_health=tracker)
    sink = _Collect()
    with pytest.raises(BudgetBlocked) as raised:
        await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                          on_text=sink)

    assert isinstance(raised.value, GatewayError), "existing handlers must keep catching it"
    assert raised.value.failure_class == ""
    assert str(raised.value).startswith("budget ceiling exceeded: ")
    assert raised.value.reason and raised.value.window == "daily"
    assert provider.calls == [] and sink.deltas == []
    assert await _usage_docs(es) == []
    assert tracker.snapshot()["providers"] == {}


# =========================================================================== #
# Demo Mode
# =========================================================================== #
async def test_demo_stream_types_out_prose_and_keeps_protocol_json_whole(monkeypatch) -> None:
    monkeypatch.setattr(providers_mod, "DEMO_STREAM_DELAY_S", 0)
    provider = DemoMockProvider()
    final = ('{"action": "final", "blocks": []}\n---ANSWER---\n'
             "Posture is steady: three open cases, none critical, risk index 42.")
    provider.push("chat", final)
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 100, sink)

    assert "".join(sink.deltas) == final == result.text
    assert sink.deltas[0] == '{"action": "final", "blocks": []}\n---ANSWER---\n'
    assert sink.deltas[1] == "Posture is steady: three"
    assert len(sink.deltas) > 3

    tool_step = '{"action": "tools", "calls": [{"tool": "log_stats", "input": {}}]}'
    assert _demo_stream_chunks(tool_step) == [tool_step]


def test_word_groups_reassemble_exactly() -> None:
    for text in ("", "   ", "one", " lead and trail  ", "a\nb\tc  d e f g h i"):
        assert "".join(_word_groups(text, 4)) == text
    assert _word_groups("a b c d e", 2) == ["a b", " c d", " e"]


async def test_demo_gateway_stream_is_metered_once_as_simulated(monkeypatch) -> None:
    monkeypatch.setattr(providers_mod, "DEMO_STREAM_DELAY_S", 0)
    es = InMemoryESClient()
    demo = DemoMockProvider()
    gw = LLMGateway(Secrets(_env_file=None), UsageStore(es),
                    provider_overrides={"openai": demo, "mock": demo}, demo=True)
    sink = _Collect()
    result = await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                               surface="chat", on_text=sink)
    assert "".join(sink.deltas) == result.text
    rows = await _usage_docs(es)
    assert len(rows) == 1 and rows[0]["pricing_source"] == "zero"
    assert result.pricing_source == "zero"
    assert gw.text_streaming_supported("openai") is True


async def test_demo_delegation_hooks_route_only_marked_system_prompts() -> None:
    from app.agents.chat_events import (
        CHAT_AGENT_SYSTEM_MARKER,
        REPORT_SUMMARY_SYSTEM_MARKER,
        split_on_answer_separator,
    )

    provider = DemoMockProvider()
    agent = await provider.complete(
        "chat", [{"role": "system", "content": f"{CHAT_AGENT_SYSTEM_MARKER}\nrules"},
                 {"role": "user", "content": "hi"}], "m", 0.1, 10)
    header, body = split_on_answer_separator(agent.text)
    assert json.loads(header)["action"] == "final" and body

    summary = await provider.complete(
        "chat", [{"role": "system", "content": f"{REPORT_SUMMARY_SYSTEM_MARKER}\nsummarise"},
                 {"role": "user", "content": "digest"}], "m", 0.1, 10)
    assert summary.text.startswith("Demo report summary")

    # The legacy chat prompt (no marker) keeps today's constant answer.
    legacy = await provider.complete(
        "chat", [{"role": "system", "content": "You are a SOC assistant."},
                 {"role": "user", "content": "hi"}], "m", 0.1, 10)
    assert json.loads(legacy.text)["answer"] == "Demo chat response (synthetic)."
    # A marker in a USER message never routes (only the system prompt is trusted).
    spoofed = await provider.complete(
        "chat", [{"role": "user", "content": CHAT_AGENT_SYSTEM_MARKER}], "m", 0.1, 10)
    assert json.loads(spoofed.text)["answer"] == "Demo chat response (synthetic)."


# =========================================================================== #
# Capability reporting and normalisation
# =========================================================================== #
def test_text_streaming_capability(monkeypatch) -> None:
    assert provider_streams_text("openai") and provider_streams_text("openai_compatible")
    assert provider_streams_text("anthropic")
    for name in ("azure", "bedrock", "vertex", "mock", "plugin-x", ""):
        assert not provider_streams_text(name)
    # A built-in name shadowed by an entry-point plugin cannot be vouched for.
    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", lambda **_k: MockProvider())
    assert not provider_streams_text("openai")


def test_gateway_streaming_capability_honours_injected_instances() -> None:
    es = InMemoryESClient()
    assert _gateway(MockProvider(), es).text_streaming_supported("openai") is False
    assert _gateway(DemoMockProvider(), es).text_streaming_supported("openai") is True
    plain = LLMGateway(Secrets(_env_file=None), UsageStore(es))
    assert plain.text_streaming_supported("anthropic") is True
    assert plain.text_streaming_supported("bedrock") is False


def test_azure_keeps_the_one_shot_default() -> None:
    assert AzureOpenAIProvider.complete_stream is BaseProvider.complete_stream
    assert AzureOpenAIProvider.streams_text is False
    assert OpenAIProvider.streams_text is True


@pytest.mark.parametrize("raw,expected", [
    ("stop", "stop"), ("end_turn", "stop"), ("STOP", "stop"), ("stop_sequence", "stop"),
    ("length", "length"), ("max_tokens", "length"), ("MAX_TOKENS", "length"),
    ("tool_calls", "tool"), ("tool_use", "tool"), ("content_filter", "other"),
    ("SAFETY", "other"), ("<script>", "other"), (None, None), ("", None),
])
def test_finish_reason_is_normalised_to_a_closed_vocabulary(raw, expected) -> None:
    assert normalise_finish_reason(raw) == expected


def test_completion_result_additions_default_to_historical_behaviour() -> None:
    result = CompletionResult(text="x")
    assert result.finish_reason is None and result.usage_estimated is False
    assert result.pricing_source == "" and result.latency_ms == 0


# =========================================================================== #
# Usage receipts: the caller learns exactly what the ledger recorded
# =========================================================================== #
class _SlowBlocking(MockProvider):
    """A provider whose completion outlives any caller deadline."""

    async def complete(self, role, messages, model, temperature, max_tokens):
        await asyncio.sleep(30)
        raise AssertionError("unreachable")


async def test_usage_receipt_mirrors_the_ok_row_exactly() -> None:
    from app.models import StepUsage

    recorder = _Recorder([_stream_response(_sse(
        _openai_chunk("a"), _openai_chunk("b", finish="stop"),
        _openai_chunk(usage={"prompt_tokens": 120, "completion_tokens": 2,
                             "prompt_tokens_details": {"cached_tokens": 20}}),
        done=True,
    ))])
    es = InMemoryESClient()
    gw = _gateway(await _openai(recorder), es)
    receipt = UsageReceipt()
    result = await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                               surface="chat", on_text=_Collect(), usage_receipt=receipt)

    (row,) = await _usage_docs(es)
    assert receipt.rows == 1 and receipt.recorded is True
    assert receipt.outcome == UsageOutcome.OK.value and receipt.failure_class == ""
    assert (receipt.prompt_tokens, receipt.cache_read_tokens, receipt.completion_tokens) == (
        row["prompt_tokens"], row["cache_read_tokens"], row["completion_tokens"]) == (100, 20, 2)
    assert receipt.cost == row["cost"] == result.cost > 0
    assert receipt.pricing_source == row["pricing_source"] == result.pricing_source
    assert receipt.latency_ms == row["latency_ms"] == result.latency_ms
    assert receipt.attempts == row["attempts"] == 1
    assert receipt.model == row["model"] == "gpt-4o"
    assert receipt.usage_estimated is False and receipt.simulated is False
    # The chat meter's StepUsage is built from the receipt, so it IS the ledger row.
    step = StepUsage(**receipt.step_usage_fields())
    assert (step.input_tokens, step.cache_read_tokens, step.output_tokens) == (100, 20, 2)
    assert step.cost == row["cost"] and step.estimated is False


async def test_usage_receipt_reports_the_abandoned_cost_a_wait_for_caller_never_sees() -> None:
    """The review's failure: ``wait_for`` turns the cancel into ``TimeoutError`` and the
    caller never saw the abandoned row's (estimated, non-zero) cost. The receipt is
    shared by reference across the task ``wait_for`` creates, so it carries it."""
    es = InMemoryESClient()
    gw = _gateway(_SlowBlocking(), es)
    receipt = UsageReceipt()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            gw.complete(Role.INVESTIGATOR, MESSAGES,
                        ModelConfig(provider="openai", model="gpt-4o"),
                        surface="automated_scan", case_id="c1", usage_receipt=receipt),
            timeout=0.05,
        )

    (row,) = await _usage_docs(es)
    assert row["failure_class"] == FAILURE_ABANDONED and row["cost"] > 0
    assert receipt.rows == 1 and receipt.recorded is True
    assert receipt.outcome == UsageOutcome.ERROR.value
    assert receipt.failure_class == FAILURE_ABANDONED
    assert receipt.cost == row["cost"]
    assert receipt.prompt_tokens == row["prompt_tokens"] == estimate_message_tokens(MESSAGES)
    assert receipt.completion_tokens == row["completion_tokens"] == 0
    assert receipt.usage_estimated is True
    assert receipt.step_usage_fields()["estimated"] is True


async def test_a_caller_rolling_up_results_and_receipts_never_sits_below_the_ledger() -> None:
    """The invariant the pipeline needs (``Case.token_cost`` never below the ledger,
    even while the ledger read is stale): sum ``result.cost`` for completed calls and
    ``receipt.cost`` for abandoned ones, and the total IS the ledger total."""

    class _SecondCallHangs(MockProvider):
        def __init__(self) -> None:
            super().__init__()
            self.n = 0

        async def complete(self, role, messages, model, temperature, max_tokens):
            self.n += 1
            if self.n == 2:
                await asyncio.sleep(30)
            return CompletionResult(text='{"action": "tool"}', prompt_tokens=300,
                                    completion_tokens=12, model=model)

    es = InMemoryESClient()
    gw = _gateway(_SecondCallHangs(), es)
    cfg = ModelConfig(provider="openai", model="gpt-4o")
    rolled_up = 0.0
    for _ in range(2):
        receipt = UsageReceipt()
        try:
            res = await asyncio.wait_for(
                gw.complete(Role.INVESTIGATOR, MESSAGES, cfg, case_id="c9",
                            usage_receipt=receipt),
                timeout=0.05,
            )
            rolled_up += res.cost
            assert receipt.cost == res.cost
        except asyncio.TimeoutError:
            rolled_up += receipt.cost

    rows = await _usage_docs(es)
    assert [r["failure_class"] for r in rows] == ["", FAILURE_ABANDONED]
    assert rolled_up == pytest.approx(sum(r["cost"] for r in rows), abs=1e-12)
    assert rows[1]["cost"] > 0, "the abandoned row is the part a caller used to miss"


async def test_usage_receipt_on_a_provider_failure_matches_its_zero_row() -> None:
    class _Rejected(MockProvider):
        async def complete(self, role, messages, model, temperature, max_tokens):
            raise ProviderError("HTTP 401: nope", retryable=False, status=401)

    es = InMemoryESClient()
    gw = _gateway(_Rejected(), es)
    receipt = UsageReceipt()
    with pytest.raises(GatewayError):
        await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                          usage_receipt=receipt)
    (row,) = await _usage_docs(es)
    assert receipt.rows == 1 and receipt.recorded is True
    assert receipt.outcome == UsageOutcome.ERROR.value
    assert receipt.failure_class == row["failure_class"] == "unauthenticated"
    assert receipt.cost == row["cost"] == 0.0
    assert receipt.usage_estimated is False


async def test_usage_receipt_on_an_interrupted_stream_carries_the_estimate() -> None:
    recorder = _Recorder([
        _stream_response(_sse(_openai_chunk("x" * 40)), error=httpx.ReadError("reset")),
    ])
    es = InMemoryESClient()
    gw = _gateway(await _openai(recorder), es)
    receipt = UsageReceipt()
    with pytest.raises(GatewayError):
        await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                          on_text=_Collect(), usage_receipt=receipt)
    (row,) = await _usage_docs(es)
    assert receipt.failure_class == FAILURE_STREAM_INTERRUPTED
    assert receipt.cost == row["cost"] > 0
    assert (receipt.prompt_tokens, receipt.completion_tokens) == (
        row["prompt_tokens"], row["completion_tokens"])
    assert receipt.usage_estimated is True


async def test_a_refused_call_resets_a_reused_receipt_to_empty() -> None:
    """No ledger row, no receipt figures: a reused receipt never reports the previous
    call's spend for a call the budget refused before any provider request."""
    receipt = UsageReceipt()
    provider = MockProvider()
    provider.push("chat", "fine")
    await _gateway(provider, InMemoryESClient()).complete(
        Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
        usage_receipt=receipt,
    )
    assert receipt.rows == 1 and receipt.cost > 0

    gate = BudgetGate(get_budget=lambda: BudgetConfig(enabled=True, daily_usd=0.01,
                                                      on_exceed="block"),
                      usage_store=_OverBudgetUsage())
    es = InMemoryESClient()
    blocked = _gateway(MockProvider(), es, budget_gate=gate)
    with pytest.raises(BudgetBlocked):
        await blocked.complete(Role.CHAT, MESSAGES,
                               ModelConfig(provider="openai", model="gpt-4o"),
                               usage_receipt=receipt)
    assert await _usage_docs(es) == []
    assert receipt == UsageReceipt()


async def test_usage_receipt_marks_demo_cost_as_simulated(monkeypatch) -> None:
    monkeypatch.setattr(providers_mod, "DEMO_STREAM_DELAY_S", 0)
    es = InMemoryESClient()
    demo = DemoMockProvider()
    gw = LLMGateway(Secrets(_env_file=None), UsageStore(es),
                    provider_overrides={"openai": demo, "mock": demo}, demo=True)
    receipt = UsageReceipt()
    await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
                      on_text=_Collect(), usage_receipt=receipt)
    (row,) = await _usage_docs(es)
    assert receipt.simulated is True and receipt.pricing_source == "zero"
    assert receipt.cost == row["cost"]


async def test_embedding_receipt_sums_the_error_row_and_the_fallback_row() -> None:
    class _EmbedDown(MockProvider):
        async def embed(self, texts, model):
            raise ProviderError("HTTP 503: down", retryable=False, status=503)

    es = InMemoryESClient()
    gw = _gateway(_EmbedDown(), es)
    receipt = UsageReceipt()
    batch = await gw.embed_with_provenance(
        ["failed logins from 10.0.0.5"],
        ModelConfig(provider="openai", model="text-embedding-3-small"),
        surface="chat", usage_receipt=receipt,
    )
    assert batch.fallback is True
    rows = await _usage_docs(es)
    assert len(rows) == 2
    assert receipt.rows == 2 and receipt.recorded is True
    assert receipt.prompt_tokens == sum(r["prompt_tokens"] for r in rows)
    assert receipt.cost == pytest.approx(sum(r["cost"] for r in rows), abs=1e-15)
    # The descriptive fields are the LAST row's (the fallback that answered).
    assert receipt.outcome == UsageOutcome.OK.value and receipt.model == "mock-embed"
    # Both rows stamp the same single request; the receipt does not double it.
    assert receipt.attempts == 1

    # The vector-only wrapper passes the receipt through unchanged.
    again = UsageReceipt()
    await gw.embed(["x"], ModelConfig(provider="openai", model="text-embedding-3-small"),
                   usage_receipt=again)
    assert again.rows == 2 and again.recorded is True


# =========================================================================== #
# Stream tracker nesting, the duck-typed relay and the attempts total
# =========================================================================== #
def test_stream_progress_trackers_nest_by_token() -> None:
    outer = providers_mod.begin_stream_progress()
    inner = providers_mod.begin_stream_progress()
    assert providers_mod.current_stream_progress() is inner
    providers_mod.end_stream_progress(inner)
    assert providers_mod.current_stream_progress() is outer
    providers_mod.note_stream_input_usage(321)
    assert outer.prompt_tokens == 321 and inner.prompt_tokens is None
    providers_mod.end_stream_progress(outer)
    assert providers_mod.current_stream_progress() is None
    # Ending twice (or without a tracker) is harmless and leaves nothing armed.
    providers_mod.end_stream_progress(outer)
    providers_mod.end_stream_progress()
    assert providers_mod.current_stream_progress() is None


async def test_a_nested_streamed_call_in_on_text_keeps_the_outer_tracker() -> None:
    """A streamed call made from inside another call's ``on_text`` (same task) used to
    clear the outer tracker, so the outer provider's later input report was dropped
    and its abandoned row fell back to a chars/4 estimate."""

    class _ReportsInputLate(BaseProvider):
        streams_text = True

        def __init__(self) -> None:
            self.reported = asyncio.Event()

        async def complete_stream(self, role, messages, model, temperature, max_tokens,
                                  on_text):
            await on_text("first ")
            providers_mod.note_stream_input_usage(999, 11, 0)
            self.reported.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    outer = _ReportsInputLate()
    nested = MockProvider()
    nested.push("chat", "nested answer")
    es = InMemoryESClient()
    gw = LLMGateway(Secrets(_env_file=None), UsageStore(es),
                    provider_overrides={"openai": outer, "mock": nested})

    async def _on_text(_delta: str) -> None:
        await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="mock", model="mock"),
                          on_text=_Collect())

    receipt = UsageReceipt()
    task = asyncio.create_task(gw.complete(
        Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="gpt-4o"),
        on_text=_on_text, usage_receipt=receipt,
    ))
    await asyncio.wait_for(outer.reported.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    abandoned = [r for r in await _usage_docs(es) if r["failure_class"] == FAILURE_ABANDONED]
    assert len(abandoned) == 1
    assert (abandoned[0]["prompt_tokens"], abandoned[0]["cache_read_tokens"]) == (999, 11)
    assert (receipt.prompt_tokens, receipt.cache_read_tokens) == (999, 11)


async def test_cancel_during_a_duck_typed_relay_uses_the_plugin_counts() -> None:
    class _Plugin:
        async def complete(self, role, messages, model, temperature, max_tokens):
            return CompletionResult(text="q" * 80, prompt_tokens=555, completion_tokens=20,
                                    cache_read_tokens=7, model=model)

    es = InMemoryESClient()
    gw = _gateway(_Plugin(), es, name="mock")
    started = asyncio.Event()

    async def _slow_consumer(_delta: str) -> None:
        started.set()
        await asyncio.sleep(30)

    task = asyncio.create_task(gw.complete(
        Role.CHAT, MESSAGES, ModelConfig(provider="mock", model="mock"),
        on_text=_slow_consumer,
    ))
    await asyncio.wait_for(started.wait(), timeout=5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    (row,) = await _usage_docs(es)
    assert row["failure_class"] == FAILURE_ABANDONED
    assert (row["prompt_tokens"], row["cache_read_tokens"]) == (555, 7)


async def test_ledger_attempts_count_every_stage_of_a_compatible_fallback() -> None:
    recorder = _Recorder([
        _json_response(400, {"error": {"message": "stream_options unsupported"}}),
        _json_response(400, {"error": {"message": "streaming unsupported"}}),
        _json_response(200, {"choices": [{"message": {"content": "whole answer"},
                                          "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 40, "completion_tokens": 3}}),
    ])
    es = InMemoryESClient()
    gw = _gateway(await _openai(recorder, base_url="http://litellm.local"), es)
    receipt = UsageReceipt()
    await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="local-llama"),
                      on_text=_Collect(), usage_receipt=receipt)
    assert len(recorder.requests) == 3
    (row,) = await _usage_docs(es)
    assert row["attempts"] == receipt.attempts == 3


@pytest.mark.parametrize("streamed", [True, False])
async def test_ledger_attempts_include_the_flex_stage_before_the_standard_fallback(
    streamed: bool,
) -> None:
    busy = _json_response(429, {"error": {"message": "flex capacity"}},
                          headers={"retry-after": "0"})
    if streamed:
        ok = _stream_response(_sse(_openai_chunk("ok", finish="stop"), done=True))
    else:
        ok = _json_response(200, {"choices": [{"message": {"content": "ok"},
                                               "finish_reason": "stop"}],
                                  "usage": {"prompt_tokens": 9, "completion_tokens": 1}})
    recorder = _Recorder([busy, busy, busy, ok])
    provider = await _openai(recorder, service_tier="flex")
    if streamed:
        result = await provider.complete_stream("chat", MESSAGES, "gpt-4o", 0.1, 50, _Collect())
    else:
        result = await provider.complete("chat", MESSAGES, "gpt-4o", 0.1, 50)
    assert result.text == "ok" and result.processing_tier == "standard"
    assert "service_tier" not in recorder.requests[3]
    assert len(recorder.requests) == providers_mod.last_attempt_count() == 4


async def test_a_stage_that_sends_nothing_adds_no_attempts() -> None:
    providers_mod.reset_attempt_count()

    async def _fails_before_sending() -> None:
        raise ProviderError("refused locally", retryable=False)

    with pytest.raises(ProviderError):
        await providers_mod._then_stage(2, _fails_before_sending())
    assert providers_mod.last_attempt_count() == 2


# =========================================================================== #
# OpenAI-compatible bodies: streamed and blocking calls agree
# =========================================================================== #
async def test_a_json_error_body_under_200_is_a_provider_error_not_an_empty_answer() -> None:
    recorder = _Recorder([
        _json_response(200, {"error": {"type": "server_error", "message": "<b>x</b>"}}),
        _stream_response(_sse(_openai_chunk("recovered", finish="stop"), done=True)),
    ])
    provider = await _openai(recorder, base_url="http://proxy.local")
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "llama3", 0.1, 50, sink)
    # Classified like its in-band twin (server_error → 500, retryable) and retried.
    assert len(recorder.requests) == 2
    assert result.text == "recovered" and sink.deltas == ["recovered"]

    recorder = _Recorder([_json_response(200, {"error": {"code": "invalid_api_key"}})])
    es = InMemoryESClient()
    gw = _gateway(await _openai(recorder, base_url="http://proxy.local"), es)
    with pytest.raises(GatewayError) as raised:
        await gw.complete(Role.CHAT, MESSAGES, ModelConfig(provider="openai", model="llama3"),
                          on_text=_Collect())
    assert raised.value.failure_class == "unauthenticated"
    (row,) = await _usage_docs(es)
    assert row["outcome"] == UsageOutcome.ERROR.value


@pytest.mark.parametrize("body", [
    {"object": "chat.completion"},
    {"choices": []},
    {"choices": ["not an object"]},
    {"choices": [{"finish_reason": "stop"}]},
])
async def test_a_malformed_body_fails_the_same_way_streamed_or_blocking(body: dict) -> None:
    outcomes = []
    for streamed in (True, False):
        recorder = _Recorder([_json_response(200, body)])
        es = InMemoryESClient()
        gw = _gateway(await _openai(recorder, base_url="http://proxy.local"), es)
        with pytest.raises(GatewayError) as raised:
            await gw.complete(Role.CHAT, MESSAGES,
                              ModelConfig(provider="openai", model="llama3"),
                              on_text=_Collect() if streamed else None)
        (row,) = await _usage_docs(es)
        assert row["outcome"] == UsageOutcome.ERROR.value
        assert len(recorder.requests) == 1, "a malformed body is not retried"
        outcomes.append(raised.value.failure_class)
    assert outcomes == ["unavailable", "unavailable"]

    # The streamed path rejects it deliberately (our own message, not retryable) rather
    # than by tripping over a missing key the way an unchecked parse would.
    recorder = _Recorder([_json_response(200, body)])
    provider = await _openai(recorder, base_url="http://proxy.local")
    with pytest.raises(ProviderError) as rejected:
        await provider.complete_stream("chat", MESSAGES, "llama3", 0.1, 50, _Collect())
    assert str(rejected.value) == "malformed completion body"
    assert rejected.value.retryable is False


async def test_a_null_error_field_on_ordinary_chunks_is_not_an_error() -> None:
    recorder = _Recorder([_stream_response(_sse(
        {"error": None, **_openai_chunk("all ")},
        {"error": None, **_openai_chunk("good", finish="stop")},
        done=True,
    ))])
    provider = await _openai(recorder, base_url="http://proxy.local")
    sink = _Collect()
    result = await provider.complete_stream("chat", MESSAGES, "llama3", 0.1, 50, sink)
    assert result.text == "all good" and sink.deltas == ["all ", "good"]
    assert len(recorder.requests) == 1


# =========================================================================== #
# Demo storyline resolution ignores chat tool data (SPEC §5.5)
# =========================================================================== #
def test_demo_resolve_ignores_storyline_markers_inside_chat_tool_results() -> None:
    from app.agents.chat_events import NO_ARTIFACTS, TOOL_CALL_HEADER
    from app.engine.demo_generator import _STORYLINE_BY_ID

    header = TOOL_CALL_HEADER.format(ordinal=1, tool="search_logs", status="ok",
                                     summary="3 events", artifacts=NO_ARTIFACTS)
    tool_result = {"role": "user",
                   "content": f"{header}\n<<<UNTRUSTED>>> rule demo_rdp_bruteforce <<<END>>>"}
    question = {"role": "user", "content": "anything odd overnight?"}
    assert DemoMockProvider._resolve([question, tool_result]) is None

    # The same marker in the original context still resolves the storyline.
    alert = {"role": "user", "content": "cluster rule=demo_rdp_bruteforce count=40"}
    assert DemoMockProvider._resolve([alert, tool_result]) is _STORYLINE_BY_ID["rdp_bruteforce"]
    # Only an OPENING header marks a tool result: a header-shaped line further down
    # (e.g. inside a fenced value) cannot hide the context it sits in.
    buried = {"role": "user", "content": f"cluster rule=demo_rdp_bruteforce\n{header}"}
    assert DemoMockProvider._resolve([buried]) is _STORYLINE_BY_ID["rdp_bruteforce"]
