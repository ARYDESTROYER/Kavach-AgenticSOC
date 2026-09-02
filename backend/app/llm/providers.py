"""Provider implementations behind a uniform interface.

The gateway is the only caller. Providers never touch Elasticsearch, never write
the usage ledger, and never make policy decisions — they only turn a request into
text + token counts. This keeps the swap-in seam (LiteLLM/vLLM) trivial.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import random
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

logger = logging.getLogger("tlsoc.llm.providers")


# --------------------------------------------------------------------------- #
# Error classification + retry/backoff (Feature 9). A provider call can fail for
# reasons that are RETRYABLE (a 429 rate-limit, a 5xx, a timeout, a transient
# transport error) or PERMANENT (a 4xx auth/validation error). We classify the
# httpx error and retry only the transient class with capped exponential backoff +
# jitter, so the gateway sees a clean exception either way (it still writes the ONE
# error usage row + raises GatewayError on final failure — #6 is untouched).
# --------------------------------------------------------------------------- #
#: Hard ceiling on how long a provider-supplied ``Retry-After`` may make us wait.
#:
#: ``Retry-After`` is PROVIDER-CONTROLLED input that we would otherwise use directly as
#: a sleep duration, so it is clamped like any other untrusted value: a hostile or
#: buggy ``Retry-After: 86400`` must not be able to park an ingest worker for a day.
#: The clamp doubles as the signal that separates a burst from a wall — see
#: :func:`with_retry`. 60s is the common upper bound of per-minute rate-limit windows
#: published by the major inference APIs; anything beyond it is a longer quota window
#: than a live investigation can usefully wait out.
#:
#: It bounds the WHOLE call, not each sleep. Clamping only the individual sleep leaves
#: the total at ``(attempts - 1) x 60s``: an ordinary ``Retry-After: 60`` would then park
#: one ``gateway.complete()`` for 120s at the default 3 attempts — the entire default
#: ``caps.timeout_seconds`` — so a single rate-limited router call would consume the
#: whole case budget, and an interactive chat turn would block for two minutes.
RETRY_AFTER_MAX_SECONDS = 60.0

#: Attempts actually made by the innermost :func:`with_retry` on the current task.
#:
#: A task-local rather than a return value: threading an attempt count through every
#: provider's response plumbing would touch every call site for one ledger column.
#: ``ContextVar`` is copied per asyncio Task, so two concurrent gateway calls cannot
#: read each other's count, and a single task always reads the call it just awaited.
_ATTEMPTS: contextvars.ContextVar[int] = contextvars.ContextVar(
    "tlsoc_provider_attempts", default=1
)


def reset_attempt_count() -> None:
    """Arm the attempt counter before a provider call."""
    _ATTEMPTS.set(1)


def last_attempt_count() -> int:
    """Attempts made by the most recent provider call on this task (>= 1)."""
    try:
        return max(1, int(_ATTEMPTS.get(1)))
    except Exception:  # noqa: BLE001 — a ledger column must never break a call
        return 1


def parse_retry_after(value: Any, *, now: "datetime | None" = None) -> float | None:
    """Parse an RFC 9110 §10.2.3 ``Retry-After`` into seconds, or ``None``.

    Both forms are accepted: ``delta-seconds`` (an integer) and an HTTP-date. The
    result is a raw, UNCLAMPED hint — the caller decides what it is willing to wait
    (see :data:`RETRY_AFTER_MAX_SECONDS`). Total by construction: any unparseable or
    hostile value yields ``None`` rather than an exception or a nonsense duration.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return max(0.0, float(int(text)))
    except (TypeError, ValueError):
        pass
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    reference = now or datetime.now(timezone.utc)
    return max(0.0, (parsed - reference).total_seconds())


class ProviderError(RuntimeError):
    """A provider-call failure carrying whether it is retryable + an HTTP status.

    ``retry_after`` is the provider's own (unclamped) hint in seconds when it sent one.

    Retry PROVENANCE — ``attempts`` and ``retry_spent`` — is deliberately NOT set in
    ``__init__``. :func:`with_retry` stamps it on the instance it re-raises, so the
    presence of the attribute means "this error came out of a bounded retry budget"
    and its absence means "no retry budget was involved". The gateway's classifier
    relies on that distinction to decide whether an HTTP 429 is an exhausted quota or
    an un-retried burst, and a default in ``__init__`` would erase it.
    """

    def __init__(self, message: str, *, retryable: bool, status: int | None = None,
                 retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.retry_after = retry_after


def classify_http_error(exc: Exception) -> ProviderError:
    """Map an httpx exception to a :class:`ProviderError` with a retryable flag.

    Retryable: connect/read timeouts, transport errors, HTTP 408/409/429 and any 5xx.
    Permanent: every other 4xx (auth/validation) — retrying would just waste budget."""
    if isinstance(exc, httpx.TimeoutException):
        return ProviderError(f"timeout: {exc}", retryable=True)
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        retryable = status in (408, 409, 429) or status >= 500
        # Surface a SHORT body excerpt for the operator's test view (plain text;
        # the gateway/route fences it before any prompt and the UI renders escaped).
        body = ""
        try:
            body = exc.response.text[:300]
        except Exception:  # noqa: BLE001
            body = ""
        retry_after = None
        try:
            retry_after = parse_retry_after(exc.response.headers.get("retry-after"))
        except Exception:  # noqa: BLE001 — a malformed header is just no hint
            retry_after = None
        return ProviderError(f"HTTP {status}: {body}".strip(), retryable=retryable,
                             status=status, retry_after=retry_after)
    if isinstance(exc, httpx.TransportError):
        return ProviderError(f"transport error: {exc}", retryable=True)
    return ProviderError(str(exc), retryable=False)


def _stamp_retry_provenance(error: ProviderError, *, attempts: int, spent: bool) -> ProviderError:
    """Record how much of the retry budget this failure actually consumed."""
    error.attempts = max(1, int(attempts))
    error.retry_spent = bool(spent)
    return error


async def with_retry(coro_factory, *, attempts: int = 3, base_delay: float = 0.5,
                     max_delay: float = 8.0):
    """Await ``coro_factory()`` with capped exponential backoff + jitter, retrying
    ONLY the retryable error class (see :func:`classify_http_error`). Re-raises the
    last :class:`ProviderError` on exhaustion. ``coro_factory`` is a 0-arg callable
    returning a fresh coroutine each attempt (so the request can be re-issued).

    Two additions the circuit breaker depends on:

    * **``Retry-After`` is honoured as a CLAMPED DELAY HINT, never as a verdict.** When
      the provider tells us how long to wait we wait that long (bounded by
      :data:`RETRY_AFTER_MAX_SECONDS`) instead of our own much shorter backoff, which
      previously burned the whole budget inside the rate-limit window and guaranteed
      the call failed. When the hint EXCEEDS the ceiling the wait is not a burst but a
      wall, so we stop retrying immediately and report the budget as spent — retrying
      into a window we are not willing to wait out is pure waste.
    * **The retry budget is CUMULATIVE.** :data:`RETRY_AFTER_MAX_SECONDS` bounds the sum
      of every wait this call makes, not each wait in isolation, so the total blocking
      time of one logical completion is bounded however many attempts it is given and
      whatever the provider asks for. Reaching the bound is reported the same way a wall
      is: the budget is SPENT.
    * **Retry provenance is stamped on the raised error** (``attempts`` /
      ``retry_spent``) so the gateway can tell an exhausted quota from a first-attempt
      rate-limit, and so the usage ledger can record what the call actually cost in
      attempts.
    """
    last: ProviderError | None = None
    budget = max(1, attempts)
    waited = 0.0
    for attempt in range(budget):
        _ATTEMPTS.set(attempt + 1)
        try:
            return await coro_factory()
        except ProviderError as pe:
            last = pe
        except Exception as exc:  # noqa: BLE001 — normalise any httpx error
            pe = classify_http_error(exc)
            last = pe
            if not pe.retryable or attempt == budget - 1:
                raise _stamp_retry_provenance(
                    pe, attempts=attempt + 1, spent=attempt >= 1
                ) from exc
        # Reached only when a ProviderError was caught above (the success path returns).
        if not last.retryable or attempt == budget - 1:
            # ``spent`` is "we actually paid for a retry and it still failed", NOT "the
            # loop finished". A single-attempt budget never tested whether a wait would
            # have cleared the condition, so calling that an exhausted quota would be
            # exactly the over-claim this provenance exists to prevent.
            raise _stamp_retry_provenance(
                last, attempts=attempt + 1, spent=attempt >= 1
            )
        hint = getattr(last, "retry_after", None)
        if isinstance(hint, (int, float)) and hint > RETRY_AFTER_MAX_SECONDS:
            # A wall, not a burst. Report the budget as SPENT: we are declining to wait
            # it out, and the condition is exactly the sustained refusal the breaker's
            # terminal classes describe.
            logger.info(
                "provider Retry-After %.0fs exceeds the %.0fs budget; not retrying",
                float(hint), RETRY_AFTER_MAX_SECONDS,
            )
            raise _stamp_retry_provenance(last, attempts=attempt + 1, spent=True)
        if isinstance(hint, (int, float)) and hint >= 0:
            delay = min(RETRY_AFTER_MAX_SECONDS, float(hint))
        else:
            delay = min(max_delay, base_delay * (2 ** attempt)) * (0.5 + random.random())
        if waited + delay > RETRY_AFTER_MAX_SECONDS:
            # The CUMULATIVE budget, not this one sleep. Waiting again would push the
            # total blocking time of this single call past the ceiling; that is the same
            # "declining to wait it out" condition as a wall, so the budget is spent.
            logger.info(
                "provider retry budget spent after %.0fs of waiting; not retrying again",
                waited,
            )
            raise _stamp_retry_provenance(last, attempts=attempt + 1, spent=waited > 0)
        logger.info("provider call retry %d/%d in %.2fs (%s)", attempt + 1, budget, delay, last)
        waited += delay
        await asyncio.sleep(delay)
    if last is not None:  # pragma: no cover - loop always returns or raises
        raise _stamp_retry_provenance(last, attempts=budget, spent=budget > 1)
    raise ProviderError("retry exhausted", retryable=False)  # pragma: no cover


@dataclass
class CompletionResult:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    cost: float = 0.0  # populated by the gateway after metering (per-case cost rollup)
    # Prompt-cache accounting (Round 4). Anthropic returns
    # ``usage.cache_read_input_tokens`` / ``cache_creation_input_tokens``; OpenAI
    # returns ``usage.prompt_tokens_details.cached_tokens`` (read-only — it has no
    # cache-write counter). Defaulted 0 so every existing constructor is unchanged;
    # the gateway threads these onto the UsageDoc + into cost_for's cache pricing.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    # True when the result received a provider Batch/Flex discount (0.5× today).
    batch: bool = False
    # Tier ACTUALLY reported by the provider, never merely the requested tier.
    processing_tier: str = "standard"


@dataclass
class EmbeddingResult:
    vectors: list[list[float]]
    tokens: int = 0


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _is_reasoning_or_gpt5(model: str) -> bool:
    """True for OpenAI models that reject ``temperature`` and require
    ``max_completion_tokens`` instead of ``max_tokens``.

    Covers the GPT-5 family (``gpt-5``, ``gpt-5-mini``, ...) and the o-series
    reasoning models (``o1``/``o3``/``o4`` prefixes, e.g. ``o4-mini``). All other
    OpenAI chat models (gpt-4*, gpt-4o*, gpt-3.5*) keep the classic params."""
    return model.startswith("gpt-5") or model.startswith(("o1", "o3", "o4"))


def _default_reasoning_effort(model: str) -> str | None:
    """Preserve the pre-GPT-5.6 non-reasoning completion baseline for Luna.

    GPT-5.6 otherwise defaults to ``medium`` reasoning when this field is omitted.
    Agentic SOC's existing Chat Completions roles were non-reasoning, latency-bound
    workflows, so fresh Luna assignments explicitly use ``none``. Other models keep
    their historical request shape; operators can still select them normally.
    """
    return "none" if model.startswith("gpt-5.6-luna") else None


class BaseProvider:
    async def complete(
        self,
        role: str,
        messages: list[dict[str, str]],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> CompletionResult:
        raise NotImplementedError

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise NotImplementedError(f"{type(self).__name__} does not support embeddings")

    async def aclose(self) -> None:
        return None


# --------------------------------------------------------------------------- #
# Anthropic
# --------------------------------------------------------------------------- #
class AnthropicProvider(BaseProvider):
    def __init__(self, api_key: str, base_url: str = "https://api.anthropic.com") -> None:
        self._key = api_key
        self._client = httpx.AsyncClient(base_url=base_url, timeout=60.0)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        convo = [
            {"role": ("assistant" if m["role"] == "assistant" else "user"), "content": m["content"]}
            for m in messages
            if m.get("role") in ("user", "assistant")
        ]
        if not convo:
            convo = [{"role": "user", "content": "\n".join(system_parts) or ""}]
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": convo,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)

        async def _post():
            resp = await self._client.post(
                "/v1/messages",
                headers={
                    "x-api-key": self._key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=payload,
            )
            resp.raise_for_status()
            return resp

        resp = await with_retry(_post)
        data = resp.json()
        text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")
        usage = data.get("usage", {})
        return CompletionResult(
            text=text,
            prompt_tokens=int(usage.get("input_tokens", _estimate_tokens(str(messages)))),
            completion_tokens=int(usage.get("output_tokens", _estimate_tokens(text))),
            model=model,
            # Prompt-cache counters (absent → 0). Anthropic bills cache-READ tokens at
            # 0.1× input and the one-time cache-WRITE (creation) at 1.25×/2× input; the
            # gateway prices them via cost_for's cache dimension.
            cache_read_tokens=int(usage.get("cache_read_input_tokens", 0) or 0),
            cache_write_tokens=int(usage.get("cache_creation_input_tokens", 0) or 0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# --------------------------------------------------------------------------- #
# OpenAI (chat + embeddings)
# --------------------------------------------------------------------------- #
class OpenAIProvider(BaseProvider):
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com",
                 service_tier: str | None = None,
                 fallback_to_standard: bool = True) -> None:
        self._key = api_key
        # OpenAI recommends a longer client timeout for Flex because lower cost comes
        # with intentionally higher/variable latency. Injected test clients are
        # unaffected. Standard calls retain the historical 60-second timeout.
        timeout = 600.0 if (service_tier or "").strip() == "flex" else 60.0
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout)
        # Optional real-time ``service_tier`` (Round 4). ``"flex"`` opts a live
        # completion into OpenAI's cheaper best-effort tier (higher latency, discounted);
        # ``None`` keeps the request shape byte-identical for the default path.
        self._service_tier = (service_tier or "").strip() or None
        self._fallback_to_standard = bool(fallback_to_standard)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if _is_reasoning_or_gpt5(model):
            # GPT-5 family + o-series reasoning models reject ``temperature`` and
            # use ``max_completion_tokens`` rather than ``max_tokens``.
            payload["max_completion_tokens"] = max_tokens
            reasoning_effort = _default_reasoning_effort(model)
            if reasoning_effort is not None:
                payload["reasoning_effort"] = reasoning_effort
        else:
            payload["temperature"] = temperature
            payload["max_tokens"] = max_tokens
        if self._service_tier:
            payload["service_tier"] = self._service_tier

        async def _post():
            resp = await self._client.post(
                "/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._key}", "content-type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            return resp

        try:
            resp = await with_retry(_post)
        except ProviderError as exc:
            # Flex is best-effort. OpenAI can return 429 when no Flex capacity is
            # available, and an endpoint/model mismatch is surfaced as a 400. Retry
            # once through the normal service only when explicitly allowed. The
            # standard result below is NOT stamped as discounted.
            msg = str(exc).lower()
            flex_unavailable = (
                self._service_tier == "flex"
                and (
                    exc.status == 429
                    or (exc.status == 400 and ("flex" in msg or "service_tier" in msg))
                )
            )
            if not (self._fallback_to_standard and flex_unavailable):
                raise
            logger.info("OpenAI Flex unavailable for %s; retrying at standard tier", model)
            payload.pop("service_tier", None)
            resp = await with_retry(_post)
        data = resp.json()
        text = data["choices"][0]["message"]["content"] or ""
        usage = data.get("usage", {})
        # OpenAI prompt caching is READ-only (automatic, no write surcharge): the cached
        # prefix count is nested under ``prompt_tokens_details.cached_tokens``. Unlike
        # Anthropic — whose ``input_tokens`` EXCLUDES the cached slice — OpenAI's
        # ``prompt_tokens`` INCLUDES the cached tokens. ``cost_for`` bills its
        # ``cache_read_tokens`` as an ADDITIVE 0.1× term, so if we handed it the full
        # ``prompt_tokens`` the cached slice would be charged 1× (in prompt_tokens) +
        # 0.1× (the additive term) = ~1.1× instead of 0.1× (double-billed). We therefore
        # pass the UNCACHED remainder (prompt_tokens − cached) as the full-rate input and
        # surface ``cache_read_tokens=cached`` separately, so the ledger charges
        # (prompt_tokens − cached)×input + cached×0.1×input — matching Anthropic's split.
        details = usage.get("prompt_tokens_details") or {}
        cached = int(details.get("cached_tokens", 0) or 0) if isinstance(details, dict) else 0
        prompt_tokens = int(usage.get("prompt_tokens", _estimate_tokens(str(messages))))
        uncached = max(prompt_tokens - cached, 0)
        actual_tier = str(data.get("service_tier") or "standard").strip().lower()
        is_flex = actual_tier == "flex"
        return CompletionResult(
            text=text,
            prompt_tokens=uncached,
            completion_tokens=int(usage.get("completion_tokens", _estimate_tokens(text))),
            model=model,
            cache_read_tokens=cached,
            batch=is_flex,
            processing_tier="flex" if is_flex else "standard",
        )

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        async def _post():
            resp = await self._client.post(
                "/v1/embeddings",
                headers={"Authorization": f"Bearer {self._key}", "content-type": "application/json"},
                json={"model": model, "input": texts},
            )
            resp.raise_for_status()
            return resp

        resp = await with_retry(_post)
        data = resp.json()
        vectors = [item["embedding"] for item in data["data"]]
        tokens = int(data.get("usage", {}).get("prompt_tokens", sum(_estimate_tokens(t) for t in texts)))
        return EmbeddingResult(vectors=vectors, tokens=tokens)

    async def aclose(self) -> None:
        await self._client.aclose()


# --------------------------------------------------------------------------- #
# Mock — deterministic, free, no network. Powers tests and key-less demos.
# --------------------------------------------------------------------------- #
class MockProvider(BaseProvider):
    """Returns scripted or role-appropriate canned responses.

    Tests push exact responses per role via ``push``; absent a script it returns
    a safe default (router -> uncertain so the pipeline proceeds; investigator/
    formatter -> NEEDS_HUMAN so nothing is ever auto-closed by accident).
    """

    def __init__(self) -> None:
        self.scripts: dict[str, list[str]] = {}
        self.calls: list[dict[str, Any]] = []

    def push(self, role: str, text: str) -> None:
        self.scripts.setdefault(role, []).append(text)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        self.calls.append({"role": role, "messages": messages, "model": model})
        queue = self.scripts.get(role)
        text = queue.pop(0) if queue else self._default(role, messages)
        return CompletionResult(
            text=text,
            prompt_tokens=_estimate_tokens(json.dumps(messages)),
            completion_tokens=_estimate_tokens(text),
            model=model,
        )

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        # Deterministic hashing embedding so RAG works offline.
        return EmbeddingResult(vectors=[_hash_embed(t) for t in texts], tokens=sum(_estimate_tokens(t) for t in texts))

    @staticmethod
    def _default(role: str, messages: list[dict[str, str]]) -> str:
        if role == "router":
            return json.dumps({"bucket": "uncertain", "reason": "mock: routed to investigator"})
        if role == "investigator":
            return json.dumps({
                "action": "final",
                "reasoning": "Mock investigator: no live model configured.",
                "verdict": {
                    "verdict": "NEEDS_HUMAN",
                    "confidence": 0.0,
                    "evidence": [{"summary": "Mock mode — manual review required.", "event_ids": []}],
                    "mitre": [],
                    "recommended_action": "Configure an LLM provider key and re-run; routed to human.",
                    "reproduce_query": "",
                },
            })
        if role == "formatter":
            return json.dumps({
                "verdict": "NEEDS_HUMAN",
                "confidence": 0.0,
                "evidence": [{"summary": "Mock formatter — manual review required.", "event_ids": []}],
                "mitre": [],
                "recommended_action": "Configure an LLM provider key.",
                "reproduce_query": "",
            })
        if role == "standup":
            return "Mock daily standup: the deterministic aggregate is available; configure an LLM key for prose."
        if role == "chat":
            return json.dumps({
                "answer": "Mock chat response — configure an LLM provider key for live answers.",
                "needs_query": False,
                "query": None,
            })
        return "mock response"


# --------------------------------------------------------------------------- #
# Demo — deterministic, $0, scenario-keyed. Powers Demo Mode investigations.
# --------------------------------------------------------------------------- #
class DemoMockProvider(MockProvider):
    """A deterministic provider whose verdict is KEYED to the storyline a cluster
    belongs to, so the SAME synthetic storyline always yields the SAME verdict /
    confidence (Wave 5). The benign baseline resolves to a confident FALSE_POSITIVE
    (which flows through the REAL ``decide()`` against a sandboxed policy, proving
    the deterministic gate); a NEEDS_HUMAN storyline stays OPEN for the HITL
    showcase. It never makes a network call and never spends a token.

    It inspects the role + the prompt text (which carries the fenced synthetic event
    summaries) to resolve the scenario by the distinctive synthetic rule names —
    no RNG, no clock — so a run is byte-reproducible."""

    def __init__(self) -> None:
        super().__init__()
        # The demo runtime is LONG-LIVED, so recording every call's full messages in an
        # unbounded list would leak memory for the life of the demo session (audit #47).
        # Bound the ring to the most-recent N (still enough for any demo introspection).
        # The base MockProvider keeps a plain list for short-lived unit tests.
        self.calls = deque(maxlen=200)  # type: ignore[assignment]

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        self.calls.append({"role": role, "messages": messages, "model": model})
        # A pushed script (tests) still wins, mirroring MockProvider.
        queue = self.scripts.get(role)
        if queue:
            text = queue.pop(0)
        else:
            text = self._demo_default(role, messages)
        return CompletionResult(
            text=text,
            prompt_tokens=_estimate_tokens(json.dumps(messages)),
            completion_tokens=_estimate_tokens(text),
            model=model,
        )

    @staticmethod
    def _resolve(messages: list[dict[str, str]]):
        """Resolve the storyline a prompt belongs to by scanning for the distinctive
        synthetic rule UID/name in the ORIGINAL investigation context. Tool results
        may legitimately contain unrelated alerts from the same source; they enrich
        the case but must never replace the cluster's incident identity on a later
        ReAct turn. Returns the Storyline or None (benign baseline)."""
        from ..engine.demo_generator import _RULE_TO_STORY, _STORYLINE_BY_ID

        original_context: list[str] = []
        for message in messages:
            content = str(message.get("content", ""))
            if content.startswith("Tool '") and " result:" in content:
                continue
            original_context.append(content)
        blob = "\n".join(original_context)
        for marker, sid in _RULE_TO_STORY.items():
            if marker in blob:
                return _STORYLINE_BY_ID[sid]
        return None

    def _demo_default(self, role: str, messages: list[dict[str, str]]) -> str:
        if role == "formatter":
            # Formatter is presentation-only: it must never replace a scenario-aware
            # investigator draft with the benign fallback merely because its compact
            # prompt no longer carries the original native rule marker. Re-emit the
            # internal draft verdict exactly; Formatter.format() still validates and
            # merges it through the normal schema/authority boundary.
            for message in reversed(messages):
                try:
                    payload = json.loads(str(message.get("content", "")))
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                draft = payload.get("draft_verdict") if isinstance(payload, dict) else None
                if isinstance(draft, dict):
                    return json.dumps(draft)
        story = self._resolve(messages)
        if role == "router":
            # Route every demo cluster to the strong investigator so the showcase
            # exercises the full pipeline.
            return json.dumps({"bucket": "needs_strong_model", "reason": "demo: investigate"})
        if story is not None:
            verdict = story.expected_verdict.value
            confidence = story.expected_confidence
            mitre = list(story.techniques)
            action = ("Contain affected hosts and rotate credentials."
                      if verdict == "TRUE_POSITIVE"
                      else "Analyst review required (impossible to auto-close)."
                      if verdict == "NEEDS_HUMAN" else "No action required.")
            summary = f"Demo storyline '{story.name}' — {verdict}."
        else:
            # Benign baseline → a CONFIDENT false positive so it flows through the
            # REAL decide() against the sandboxed policy.
            verdict, confidence, mitre = "FALSE_POSITIVE", 0.97, []
            action = "Benign baseline activity; no action required."
            summary = "Demo benign baseline — false positive."
        payload = {
            "verdict": verdict,
            "confidence": confidence,
            "evidence": [{"summary": summary, "event_ids": []}],
            "mitre": mitre,
            "recommended_action": action,
            "reproduce_query": "",
        }
        if role == "investigator":
            # A polished demo should prove the agent can read the originating native
            # source, not merely reason over the alert envelope already in the cluster.
            # When the pipeline supplied a source-specific ``es_query`` adapter, make
            # exactly one bounded, source-neutral query before returning the verdict.
            # The following turn contains the fenced tool result and falls through to
            # ``final``.  Pipelines without that tool retain the old one-turn behavior.
            blob = "\n".join(str(m.get("content", "")) for m in messages)
            if "\n- es_query:" in blob and "Tool 'es_query' result:" not in blob:
                return json.dumps({
                    "action": "tool",
                    "tool": "es_query",
                    "input": {
                        "time_from": "now-24h",
                        "time_to": "now",
                        "size": 20,
                    },
                })
            return json.dumps({"action": "final", "reasoning": summary, "verdict": payload})
        if role == "overview":
            return json.dumps(payload)
        if role == "standup":
            return "Demo standup: synthetic activity summarised (no live model)."
        if role == "chat":
            return json.dumps({"answer": "Demo chat response (synthetic).", "needs_query": False, "query": None})
        return json.dumps(payload)


# --------------------------------------------------------------------------- #
# Azure OpenAI — same wire shape as OpenAI but a deployment-scoped URL + api-key
# header + api-version query param. Reuses OpenAIProvider's payload-shaping by
# subclassing and overriding the request seam. Best-effort: importable with no new
# dep; needs an endpoint + deployment + api-version supplied via the credential.
# --------------------------------------------------------------------------- #
class AzureOpenAIProvider(OpenAIProvider):
    """Azure OpenAI deployment. ``base_url`` is the resource endpoint
    (``https://<resource>.openai.azure.com``); the model id is the DEPLOYMENT name.
    Auth is the ``api-key`` header (not a Bearer token) + an ``api-version`` query."""

    def __init__(self, api_key: str, base_url: str,
                 api_version: str = "2024-10-21") -> None:
        if not (base_url or "").strip():
            # Fail with an actionable message rather than silently pointing at an
            # example placeholder host that would DNS-fail at call time. Azure needs
            # the resource endpoint (``azure_openai_endpoint``) to route a deployment.
            raise ValueError(
                "Azure OpenAI endpoint (azure_openai_endpoint) is not configured"
            )
        super().__init__(api_key, base_url=base_url)
        self._api_version = api_version

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        payload: dict[str, Any] = {"messages": messages}
        if _is_reasoning_or_gpt5(model):
            payload["max_completion_tokens"] = max_tokens
        else:
            payload["temperature"] = temperature
            payload["max_tokens"] = max_tokens
        async def _post():
            resp = await self._client.post(
                f"/openai/deployments/{model}/chat/completions",
                params={"api-version": self._api_version},
                headers={"api-key": self._key, "content-type": "application/json"},
                json=payload,
            )
            resp.raise_for_status()
            return resp

        # Azure used to bypass the retry budget entirely: a single 429 or 503 failed the
        # call outright, and a 429 that a two-second wait would have cleared was reported
        # as an exhausted quota — which, once a breaker exists, is an immediate-trip
        # class. Every provider now shares one bounded, Retry-After-aware budget.
        resp = await with_retry(_post)
        data = resp.json()
        text = data["choices"][0]["message"]["content"] or ""
        usage = data.get("usage", {})
        return CompletionResult(
            text=text,
            prompt_tokens=int(usage.get("prompt_tokens", _estimate_tokens(str(messages)))),
            completion_tokens=int(usage.get("completion_tokens", _estimate_tokens(text))),
            model=model,
        )


# --------------------------------------------------------------------------- #
# AWS Bedrock — SigV4-signed POST to the Anthropic-on-Bedrock messages API. The
# signing ladder is the same HMAC chain the SES SMTP-password derivation uses
# (notifications/email.py), generalised to full SigV4. Pure stdlib (hmac/hashlib);
# no boto3 dependency. Credentials: access key id + secret + region.
# --------------------------------------------------------------------------- #
def _sigv4_sign(secret_key: str, date_stamp: str, region: str, service: str) -> bytes:
    """The AWS SigV4 signing-key HMAC ladder (the same chain SES uses for SMTP):
    ``HMAC('AWS4'+secret, date) → region → service → 'aws4_request'``. Pure stdlib."""
    import hashlib
    import hmac

    def _h(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    k = _h(("AWS4" + (secret_key or "")).encode("utf-8"), date_stamp)
    k = _h(k, region)
    k = _h(k, service)
    return _h(k, "aws4_request")


class BedrockProvider(BaseProvider):
    """AWS Bedrock (Anthropic Claude on Bedrock). Signs each request with SigV4 using
    stdlib HMAC (no boto3). ``base_url`` defaults to the regional Bedrock runtime
    endpoint; the model id is the Bedrock model identifier
    (e.g. ``anthropic.claude-3-5-sonnet-20241022-v2:0``)."""

    def __init__(self, access_key_id: str, secret_access_key: str, region: str = "us-east-1",
                 base_url: str | None = None, session_token: str | None = None) -> None:
        self._akid = access_key_id
        self._secret = secret_access_key
        self._region = (region or "us-east-1").strip() or "us-east-1"
        self._token = session_token
        self._service = "bedrock"
        self._host = (base_url or f"bedrock-runtime.{self._region}.amazonaws.com").replace("https://", "").replace("http://", "").strip("/")
        self._client = httpx.AsyncClient(base_url=f"https://{self._host}", timeout=60.0)

    def _signed_headers(self, path: str, body: bytes) -> dict[str, str]:
        import datetime as _dt
        import hashlib
        import hmac

        now = _dt.datetime.now(_dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()
        canonical_headers = (
            f"content-type:application/json\nhost:{self._host}\n"
            f"x-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        )
        signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date"
        canonical_request = (
            f"POST\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        )
        scope = f"{date_stamp}/{self._region}/{self._service}/aws4_request"
        string_to_sign = (
            "AWS4-HMAC-SHA256\n"
            f"{amz_date}\n{scope}\n"
            f"{hashlib.sha256(canonical_request.encode()).hexdigest()}"
        )
        signing_key = _sigv4_sign(self._secret, date_stamp, self._region, self._service)
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        auth = (
            f"AWS4-HMAC-SHA256 Credential={self._akid}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        headers = {
            "content-type": "application/json",
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
            "authorization": auth,
        }
        if self._token:
            headers["x-amz-security-token"] = self._token
        return headers

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        convo = [
            {"role": ("assistant" if m["role"] == "assistant" else "user"), "content": m["content"]}
            for m in messages if m.get("role") in ("user", "assistant")
        ]
        if not convo:
            convo = [{"role": "user", "content": "\n".join(system_parts) or ""}]
        payload: dict[str, Any] = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": convo,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        body = json.dumps(payload).encode("utf-8")
        path = f"/model/{model}/invoke"

        async def _post():
            # Re-sign on every attempt: a SigV4 signature is bound to its x-amz-date and
            # a replayed one is rejected outside the service's clock skew window, so a
            # retry that reused the first signature would fail as an auth error and
            # misreport a transient throttle as a credential problem.
            resp = await self._client.post(
                path, headers=self._signed_headers(path, body), content=body
            )
            resp.raise_for_status()
            return resp

        resp = await with_retry(_post)
        data = resp.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        usage = data.get("usage", {})
        return CompletionResult(
            text=text,
            prompt_tokens=int(usage.get("input_tokens", _estimate_tokens(str(messages)))),
            completion_tokens=int(usage.get("output_tokens", _estimate_tokens(text))),
            model=model,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# --------------------------------------------------------------------------- #
# Google Vertex AI — Gemini generateContent. Auth is a Bearer OAuth access token
# (the caller supplies a short-lived token; we do not mint one — no google-auth
# dep). ``base_url`` + project/location come from the credential. Best-effort.
# --------------------------------------------------------------------------- #
class VertexProvider(BaseProvider):
    """Google Vertex AI (Gemini). The credential is a short-lived OAuth access token
    (Bearer); we do NOT mint one (no google-auth dep). ``base_url`` is the regional
    endpoint (``https://<location>-aiplatform.googleapis.com``) and the path carries
    the project + location + model (publisher ``google``)."""

    def __init__(self, access_token: str, project: str, location: str = "us-central1",
                 base_url: str | None = None) -> None:
        self._token = access_token
        self._project = project
        self._location = (location or "us-central1").strip() or "us-central1"
        host = base_url or f"https://{self._location}-aiplatform.googleapis.com"
        self._client = httpx.AsyncClient(base_url=host, timeout=60.0)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        contents = [
            {"role": ("model" if m["role"] == "assistant" else "user"),
             "parts": [{"text": m["content"]}]}
            for m in messages if m.get("role") in ("user", "assistant")
        ]
        if not contents:
            contents = [{"role": "user", "parts": [{"text": "\n".join(system_parts) or ""}]}]
        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
        }
        if system_parts:
            payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
        path = (
            f"/v1/projects/{self._project}/locations/{self._location}"
            f"/publishers/google/models/{model}:generateContent"
        )
        async def _post():
            resp = await self._client.post(
                path,
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "content-type": "application/json",
                },
                json=payload,
            )
            resp.raise_for_status()
            return resp

        resp = await with_retry(_post)
        data = resp.json()
        cands = data.get("candidates", [])
        text = ""
        if cands:
            text = "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []))
        meta = data.get("usageMetadata", {})
        return CompletionResult(
            text=text,
            prompt_tokens=int(meta.get("promptTokenCount", _estimate_tokens(str(messages)))),
            completion_tokens=int(meta.get("candidatesTokenCount", _estimate_tokens(text))),
            model=model,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# --------------------------------------------------------------------------- #
# Provider registry (Feature 9) — a name -> factory dispatch table replacing the
# gateway's if/elif. A factory takes the gateway-resolved kwargs (api_key/base_url/
# region/...) and returns a BaseProvider. ``openai_compatible`` is the OpenAI
# provider pointed at a custom base_url (vLLM/Ollama/OpenRouter/Together/Groq). The
# gateway keeps the anthropic/openai/mock paths byte-identical by passing the same
# kwargs they used before; the new providers are best-effort (importable, no new
# dep) and only constructed when explicitly selected.
# --------------------------------------------------------------------------- #
def _make_anthropic(*, api_key: str = "", base_url: str | None = None, **_: Any) -> BaseProvider:
    return AnthropicProvider(api_key, base_url=base_url or "https://api.anthropic.com")


def _make_openai(*, api_key: str = "", base_url: str | None = None,
                 service_tier: str | None = None,
                 fallback_to_standard: bool = True, **_: Any) -> BaseProvider:
    return OpenAIProvider(api_key, base_url=base_url or "https://api.openai.com",
                          service_tier=service_tier,
                          fallback_to_standard=fallback_to_standard)


def _make_mock(**_: Any) -> BaseProvider:
    return MockProvider()


def _make_azure(*, api_key: str = "", base_url: str | None = None,
                api_version: str = "2024-10-21", **_: Any) -> BaseProvider:
    return AzureOpenAIProvider(api_key, base_url or "", api_version=api_version)


def _make_bedrock(*, access_key_id: str = "", secret_access_key: str = "",
                  region: str = "us-east-1", base_url: str | None = None,
                  session_token: str | None = None, **_: Any) -> BaseProvider:
    return BedrockProvider(access_key_id, secret_access_key, region=region,
                           base_url=base_url, session_token=session_token)


def _make_vertex(*, access_token: str = "", project: str = "",
                 location: str = "us-central1", base_url: str | None = None, **_: Any) -> BaseProvider:
    return VertexProvider(access_token, project, location=location, base_url=base_url)


# name -> factory. ``openai_compatible`` aliases the OpenAI factory (a base_url makes
# it self-hosted/aggregator). The gateway falls back to OpenAI shaping for any
# unknown-but-OpenAI-flavoured provider name.
PROVIDER_REGISTRY: dict[str, Any] = {
    "anthropic": _make_anthropic,
    "openai": _make_openai,
    "mock": _make_mock,
    "azure": _make_azure,
    "bedrock": _make_bedrock,
    "vertex": _make_vertex,
    "openai_compatible": _make_openai,
}

# Entry-point group third-party LLM providers register under. A ``pip install
# tlsoc-llm-<x>`` declaring ``[project.entry-points."tlsoc.llm_providers"]`` whose
# object is a ``(name, factory)`` pair (or a factory with a ``provider_name``) is
# MERGED into PROVIDER_REGISTRY without a core change (Round 5 / Coupling-F). A
# discovered provider still returns raw completions to the gateway — it NEVER writes a
# UsageDoc itself, so the single-ledger-write choke point (#6) is untouched.
ENTRY_POINT_GROUP = "tlsoc.llm_providers"
_LLM_DISCOVERED = False


def _register_discovered(obj: Any) -> None:
    """Merge one discovered LLM-provider entry-point object into PROVIDER_REGISTRY.

    Accepts either a ``(name, factory)`` pair OR a factory that carries a
    ``provider_name`` attribute. A built-in name is never silently shadowed unless the
    plugin explicitly reuses it (logged "overridden by"), mirroring the connector/
    enrichment precedence contract."""
    name: str | None = None
    factory: Any = None
    if isinstance(obj, (tuple, list)) and len(obj) == 2:
        name, factory = str(obj[0]).strip().lower(), obj[1]
    elif callable(obj):
        factory = obj
        name = str(getattr(obj, "provider_name", "") or "").strip().lower() or None
    if not name or factory is None:
        logger.warning("LLM provider entry point %s has no resolvable (name, factory); skipping", obj)
        return
    if name in PROVIDER_REGISTRY and PROVIDER_REGISTRY[name] is not factory:
        logger.info("LLM provider '%s' overridden by %s", name, getattr(factory, "__name__", factory))
    PROVIDER_REGISTRY[name] = factory


def ensure_providers_discovered() -> None:
    """Discover + merge any ``tlsoc.llm_providers`` third-party factories (once).

    Fully isolated + warned end-to-end via the shared plugin discovery helper — a bad
    plugin can never break provider construction or startup. Idempotent."""
    global _LLM_DISCOVERED
    if _LLM_DISCOVERED:
        return
    _LLM_DISCOVERED = True
    try:
        from ..plugins.registry import discover_entry_points

        discover_entry_points(
            ENTRY_POINT_GROUP, _register_discovered, what="LLM provider", log=logger,
        )
    except Exception as exc:  # noqa: BLE001 — discovery must never break the gateway
        logger.warning("LLM provider discovery failed: %s", exc)


def _hash_embed(text: str, dim: int = 256) -> list[float]:
    import hashlib
    import math

    vec = [0.0] * dim
    for token in text.lower().split():
        h = int(hashlib.md5(token.encode()).hexdigest(), 16)
        vec[h % dim] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]
