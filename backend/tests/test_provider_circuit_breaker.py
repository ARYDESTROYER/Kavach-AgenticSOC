"""The provider circuit breaker — SHIPPED IN ADVISORY MODE.

``llm/provider_health.py`` could already SEE a total provider outage; it could never
ACT on one. This module pins the action it now takes, and — more importantly — pins
everything it must NOT do:

* it never reaches ``case_manager.decide()`` (#3);
* a refused completion writes ZERO ledger rows, because nothing was spent (#6);
* a refused EMBEDDING never raises, because refusing embeddings would hash every
  QUERY while the persisted corpus stayed in the real space, turning retrieval from
  "empty" into "noise";
* the mock/demo providers and the keyless profile can never trip it, so the offline
  test profile and Demo Mode are untouched;
* it refuses NOTHING until an operator explicitly enables enforcement.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import math
import pathlib
import time

import httpx
import pytest

from app.config import ModelConfig, Preferences, ResilienceConfig
from app.constants import CaseStatus, SourceSurface, USAGE_READ_PATTERN, Role, UsageOutcome, Verdict
from app.engine import case_manager as case_manager_mod
from app.engine.correlation import correlate
from app.engine.ingest import handle_clusters
from app.es.fake import InMemoryESClient
from app.llm import provider_health as ph
from app.llm.gateway import (
    BreakerOpen,
    GatewayError,
    LLMGateway,
    classify_provider_failure,
)
from app.llm.providers import (
    RETRY_AFTER_MAX_SECONDS,
    BaseProvider,
    CompletionResult,
    EmbeddingResult,
    MockProvider,
    ProviderError,
    last_attempt_count,
    parse_retry_after,
    with_retry,
)
from app.stores.usage import UsageStore


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class _FakeSecrets:
    anthropic_api_key = None
    openai_api_key = None
    embedding_api_key = None

    def embedding_key(self):
        return None


class _RaisingProvider(BaseProvider):
    """Fails every completion AND every embedding with one closed HTTP status."""

    def __init__(self, status: int = 500) -> None:
        self.status = status
        self.completions = 0
        self.embeds = 0

    def _error(self) -> ProviderError:
        error = ProviderError(
            f"HTTP {self.status}: <html>secret body</html>",
            retryable=self.status >= 500,
            status=self.status,
        )
        # Provenance as ``with_retry`` would stamp it after spending the budget.
        error.attempts = 3
        error.retry_spent = True
        return error

    async def complete(self, role, messages, model, temperature, max_tokens):
        self.completions += 1
        raise self._error()

    async def embed(self, texts, model):
        self.embeds += 1
        raise self._error()


def _gateway(provider: BaseProvider, es: InMemoryESClient, policy: ResilienceConfig,
             *, provider_name: str = "anthropic") -> tuple[LLMGateway, ph.ProviderHealth]:
    tracker = ph.ProviderHealth(policy=policy)
    gw = LLMGateway(
        secrets=_FakeSecrets(),
        usage_store=UsageStore(es),
        provider_overrides={provider_name: provider},
        provider_health=tracker,
        resilience_policy=lambda: policy,
    )
    return gw, tracker


def _cfg(provider: str = "anthropic", model: str = "claude-sonnet-4-6") -> ModelConfig:
    return ModelConfig(provider=provider, model=model)


async def _usage_docs(es: InMemoryESClient) -> list[dict]:
    resp = await es.search(USAGE_READ_PATTERN, {"size": 200, "query": {"match_all": {}}})
    return [hit["_source"] for hit in resp["hits"]["hits"]]


def _fast(**overrides) -> ResilienceConfig:
    """An enforcing policy small enough for a unit test to fill in a few calls."""
    base = dict(enforce=True, window_size=6, minimum_calls=3, wait_seconds=1.0,
                max_wait_seconds=4.0, half_open_successes=2)
    base.update(overrides)
    return ResilienceConfig(**base)


# =========================================================================== #
# #3 — the decision core is untouched, and cannot reach the breaker
# =========================================================================== #
def test_case_manager_is_byte_identical_and_cannot_see_the_breaker() -> None:
    """The breaker is control flow for whether a call RUNS, never for what it decides."""
    source = pathlib.Path(case_manager_mod.__file__).read_bytes()
    assert hashlib.md5(source).hexdigest() == "212873cd13d822a7b64752635285ff1f"

    tree = ast.parse(source.decode("utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            imported.add(base)
            imported.update(f"{base}.{alias.name}" for alias in node.names)
    for forbidden in ("provider_health", "gateway", "resilience", "ProviderHealth"):
        assert not any(forbidden in name for name in imported), imported
    assert "breaker" not in source.decode("utf-8").lower()


def test_decide_takes_no_new_parameter() -> None:
    """A new argument here would be the first step to the breaker deciding a case."""
    params = list(inspect.signature(case_manager_mod.decide).parameters)
    assert params == [
        "verdict", "confidence", "risk_score", "policy",
        "escalation_confidence", "critical_severity",
    ]


# =========================================================================== #
# The exception hierarchy — a sibling class would escape every handler
# =========================================================================== #
def test_breaker_open_is_a_gateway_error() -> None:
    error = BreakerOpen("open")
    assert isinstance(error, GatewayError)
    assert isinstance(error, RuntimeError)


def test_every_gateway_error_handler_also_catches_breaker_open() -> None:
    """Six agents catch ``GatewayError``; none of them may be bypassed by this one.

    A ``BreakerOpen`` that escaped an ``except GatewayError`` would surface as an
    uncaught exception on the ingest path — a dropped alert, not a graceful failure.
    """
    from app.agents import chat, formatter, investigator, overview, router, standup

    handlers = 0
    for module in (router, investigator, formatter, standup, chat, overview):
        for node in ast.walk(ast.parse(inspect.getsource(module))):
            if not isinstance(node, ast.ExceptHandler) or node.type is None:
                continue
            names = [node.type] if not isinstance(node.type, ast.Tuple) else node.type.elts
            for name in names:
                caught = name.id if isinstance(name, ast.Name) else getattr(name, "attr", "")
                if caught == "GatewayError":
                    handlers += 1
    assert handlers >= 6, "the GatewayError handlers moved; re-check BreakerOpen's base"


@pytest.mark.asyncio
async def test_an_open_breaker_routes_to_needs_human_and_never_closes(app_state) -> None:
    """End to end: an open breaker fails the case to a human, exactly like any outage.

    Not closed, not escalated, not dropped — and the operator-visible explanation
    carries no provider response text.
    """
    from app.constants import EntityType
    from app.engine.correlation import cluster_from_events
    from tests.conftest import make_raw_event

    prefs = app_state.prefs.model_copy(deep=True)
    prefs.enrichment.enabled = False
    router_cfg = prefs.model_for("router")

    policy = _fast()
    app_state._provider_health.set_policy(policy)
    app_state.gateway._resilience_policy = lambda: policy
    # Trip the ACTUAL key this deployment's router routes to, the way an expired
    # credential would: one unauthenticated failure is an immediate-trip class.
    app_state._provider_health.record_failure(
        str(router_cfg.provider), "unauthenticated", str(router_cfg.model),
        "completion", role="router",
    )
    assert app_state._provider_health.allows(
        str(router_cfg.provider), "completion", "router", str(router_cfg.model)
    )[0] is False

    # Prove the refusal is what fails the call: the provider itself still works.
    with pytest.raises(BreakerOpen):
        await app_state.gateway.complete(
            "router", [{"role": "user", "content": "x"}], router_cfg,
        )

    events = [
        make_raw_event(id=f"cb{i}", ip="198.51.100.9",
                       ts_millis=1_700_000_000_000 + i * 1000)
        for i in range(3)
    ]
    cluster = cluster_from_events(EntityType.IP, "198.51.100.9", events)
    case = await app_state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, prefs
    )

    assert case is not None, "the alert was never dropped (#4)"
    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.status != CaseStatus.CLOSED
    assert case.status != CaseStatus.RESOLVED
    # The operator-visible text names the credential class, never a provider body.
    text = f"{case.recommended_action or ''} {case.error or ''}"
    assert "<html>" not in text and "secret body" not in text


# =========================================================================== #
# A refused completion is free: zero ledger rows, one transition record
# =========================================================================== #
@pytest.mark.asyncio
async def test_open_completion_key_writes_zero_usage_rows_and_one_transition() -> None:
    es = InMemoryESClient()
    policy = _fast()
    provider = _RaisingProvider(status=401)
    gw, tracker = _gateway(provider, es, policy)

    # ONE real 401 — an immediate-trip class, so the coarse key opens on it.
    with pytest.raises(GatewayError):
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())

    rows_before = len(await _usage_docs(es))
    assert rows_before == 1, "the ATTEMPTED call wrote exactly one row (#6)"
    transitions_before = len(tracker.transitions())
    assert transitions_before == 1, "exactly one transition record for the trip"
    completions_before = provider.completions
    assert completions_before == 1

    for _ in range(3):
        with pytest.raises(BreakerOpen) as raised:
            await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())

    assert raised.value.failure_class == "unauthenticated"
    assert provider.completions == completions_before, "no provider call was made"
    assert len(await _usage_docs(es)) == rows_before, "a refused call bills nothing (#6)"
    # The refusal records no NEW transition (the trip already recorded one) and, in
    # particular, records no failure that could keep the breaker open by itself.
    assert len(tracker.transitions()) == transitions_before
    opened = [t for t in tracker.transitions() if t["to"] == ph.BREAKER_OPEN]
    assert len(opened) >= 1
    assert opened[0]["reason"] == ph.REASON_IMMEDIATE
    assert opened[0]["failure_class"] == "unauthenticated"
    assert "html" not in str(opened[0]).lower(), "no provider body reaches the record"


@pytest.mark.asyncio
async def test_advisory_mode_refuses_nothing() -> None:
    """The shipped default: observe, transition, report — and let every call through."""
    es = InMemoryESClient()
    policy = ResilienceConfig(window_size=6, minimum_calls=3)  # enforce defaults False
    provider = _RaisingProvider(status=401)
    gw, tracker = _gateway(provider, es, policy)

    for _ in range(6):
        with pytest.raises(GatewayError):
            await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())

    assert provider.completions == 6, "advisory mode never refused a call"
    assert len(await _usage_docs(es)) == 6
    assert tracker.breaker_state("anthropic", "completion", "router",
                                 "claude-sonnet-4-6") != ph.BREAKER_CLOSED, (
        "the state machine still ran"
    )
    assert tracker.breaker_snapshot()["enforced"] is False
    assert tracker.transitions(), "the operator can read what it WOULD have refused"


def test_an_absent_policy_block_is_a_no_op() -> None:
    """No stored ``resilience`` block, and no wiring, must refuse nothing."""
    assert Preferences().resilience.enforce is False
    tracker = ph.ProviderHealth()  # exactly how AppState constructs it
    assert tracker.enforcing is False
    for _ in range(50):
        tracker.record_failure("anthropic", "unauthenticated", "m", "completion", role="router")
    assert tracker.allows("anthropic", "completion", "router", "m")[0] is True


# =========================================================================== #
# Embeddings NEVER raise
# =========================================================================== #
@pytest.mark.asyncio
async def test_open_embedding_key_returns_fallback_vectors_and_never_raises() -> None:
    es = InMemoryESClient()
    policy = _fast()
    provider = _RaisingProvider(status=401)
    gw, tracker = _gateway(provider, es, policy)
    cfg = _cfg(model="text-embedding-3-small")

    for _ in range(3):
        batch = await gw.embed_with_provenance(["a", "b"], cfg)
        assert batch.fallback is True

    embeds_before = provider.embeds
    rows_before = len(await _usage_docs(es))

    batch = await gw.embed_with_provenance(["a", "b"], cfg)  # must NOT raise

    assert provider.embeds == embeds_before, "the open key short-circuited the call"
    assert len(batch.vectors) == 2
    assert all(isinstance(v, list) and v for v in batch.vectors)
    assert batch.fallback is True
    # The reason is the TRIPPING class, never ``not_configured`` — which is what makes
    # the existing RAG guard refuse to persist these hash-space vectors.
    assert batch.fallback_reason == "unauthenticated"
    assert batch.provider == "mock" and batch.model == "mock-embed"
    rows = await _usage_docs(es)
    assert len(rows) == rows_before + 1, "only the mock fallback's own row"
    assert rows[-1]["outcome"] == UsageOutcome.OK.value
    assert tracker.breaker_state("anthropic", "embedding", Role.EMBEDDING.value,
                                 "text-embedding-3-small") == ph.BREAKER_OPEN


@pytest.mark.asyncio
async def test_the_vector_only_embed_api_also_never_raises_on_an_open_key() -> None:
    es = InMemoryESClient()
    gw, _ = _gateway(_RaisingProvider(status=401), es, _fast())
    cfg = _cfg(model="text-embedding-3-small")
    for _ in range(4):
        vectors = await gw.embed(["query"], cfg)
        assert len(vectors) == 1


# =========================================================================== #
# What must NEVER trip
# =========================================================================== #
@pytest.mark.parametrize("provider,model", [
    ("mock", "mock"), ("mock", "claude-sonnet-4-6"), ("demo", "demo-model"),
    ("anthropic", "mock-embed"),
])
def test_mock_and_demo_providers_never_trip(provider: str, model: str) -> None:
    """Tripping these would break the offline test profile and Demo Mode."""
    tracker = ph.ProviderHealth(policy=_fast())
    for _ in range(50):
        tracker.record_failure(provider, "unauthenticated", model, "completion", role="router")
    assert tracker.allows(provider, "completion", "router", model)[0] is True
    assert tracker.breaker_state(provider, "completion", "router", model) == ph.BREAKER_CLOSED
    assert tracker.transitions() == []


def test_not_configured_never_trips() -> None:
    """A deployment with no key runs the supported keyless profile, not an outage."""
    tracker = ph.ProviderHealth(policy=_fast())
    for _ in range(50):
        tracker.record_failure("openai", "not_configured", "text-embedding-3-small",
                               "embedding", role=Role.EMBEDDING.value)
    assert tracker.allows("openai", "embedding", Role.EMBEDDING.value,
                          "text-embedding-3-small")[0] is True
    assert tracker.transitions() == []


def test_unsupported_never_trips_immediately() -> None:
    """An operator typo must keep producing the ledger rows that evidence it.

    ``unsupported`` in this system's history has meant a chat model pasted into the
    embedding slot. Immediate-tripping it would refuse the call, and a refused call
    writes no row — erasing the only durable evidence the misconfiguration happened.
    """
    tracker = ph.ProviderHealth(policy=_fast(minimum_calls=5, window_size=8))
    assert "unsupported" not in ph.IMMEDIATE_TRIP_CLASSES
    for _ in range(4):  # below the window quorum
        tracker.record_failure("anthropic", "unsupported", "claude-sonnet-4-6",
                               "embedding", role=Role.EMBEDDING.value)
    assert tracker.allows("anthropic", "embedding", Role.EMBEDDING.value,
                          "claude-sonnet-4-6")[0] is True


# =========================================================================== #
# Keying: (provider, channel, ROLE, model)
# =========================================================================== #
def test_a_partial_per_role_failure_regime_opens_only_the_failing_role() -> None:
    """The whole reason ROLE is in the key.

    A failing router and a healthy investigator share provider, channel and model. A
    pooled key sees a 50% rate and either hides the outage under any sane threshold or,
    once it crosses, refuses the role that was working perfectly.
    """
    tracker = ph.ProviderHealth(policy=_fast(window_size=10, minimum_calls=4))
    for _ in range(8):
        tracker.record_failure("openai", "unavailable", "gpt-5.6-luna", "completion",
                               role="router")
        tracker.record_success("openai", "gpt-5.6-luna", "completion", role="investigator")

    assert tracker.allows("openai", "completion", "router", "gpt-5.6-luna")[0] is False
    assert tracker.allows("openai", "completion", "investigator", "gpt-5.6-luna")[0] is True
    assert tracker.breaker_snapshot()["open_keys"] == ["openai:completion:router:gpt-5.6-luna"]


def test_an_operator_defined_role_keys_like_any_other() -> None:
    """Roles are free strings on the wire, so a custom role must key unchanged."""
    tracker = ph.ProviderHealth(policy=_fast())
    for _ in range(4):
        tracker.record_failure("openai", "unavailable", "m", "completion",
                               role="tier2_reviewer")
    assert tracker.allows("openai", "completion", "tier2_reviewer", "m")[0] is False
    assert tracker.allows("openai", "completion", "router", "m")[0] is True


def test_the_completion_and_embedding_channels_are_independent() -> None:
    tracker = ph.ProviderHealth(policy=_fast())
    for _ in range(4):
        tracker.record_failure("openai", "unavailable", "m", "embedding",
                               role=Role.EMBEDDING.value)
    assert tracker.allows("openai", "embedding", Role.EMBEDDING.value, "m")[0] is False
    assert tracker.allows("openai", "completion", "router", "m")[0] is True


def test_an_immediate_trip_class_opens_the_coarse_key_across_every_role() -> None:
    """A rejected credential is not role-specific, so the coarse key exists."""
    tracker = ph.ProviderHealth(policy=_fast())
    tracker.record_failure("openai", "unauthenticated", "gpt-5.6-luna", "completion",
                           role="router")
    assert tracker.allows("openai", "completion", "router", "gpt-5.6-luna")[0] is False
    # A role and model that have never been called are refused too — the credential is.
    assert tracker.allows("openai", "completion", "investigator", "other-model")[0] is False
    assert tracker.allows("anthropic", "completion", "router", "gpt-5.6-luna")[0] is True


# =========================================================================== #
# COUNT window, not time window — the reachability defect
# =========================================================================== #
def test_a_total_failure_at_low_volume_opens_the_key() -> None:
    """The defect a TIME window would have: a busy role at ~34 calls/hour puts about
    ONE call inside a 120s window, so a minimum-calls floor is unreachable and the
    breaker never evaluates. A COUNT window reaches its quorum at any volume."""
    policy = ResilienceConfig(enforce=True)  # the SHIPPED sizes, not test-shrunk ones
    tracker = ph.ProviderHealth(policy=policy)
    calls = 0
    while tracker.allows("openai", "completion", "router", "gpt-5.6-luna")[0]:
        tracker.record_failure("openai", "unavailable", "gpt-5.6-luna", "completion",
                               role="router")
        calls += 1
        assert calls <= 50, "the count window never reached its quorum"
    assert calls == policy.minimum_calls
    # …and the elapsed time was irrelevant: the whole replay happened in microseconds.


def test_a_below_threshold_failure_rate_never_opens() -> None:
    """Below 0.50 the breaker would refuse more work than it protects."""
    tracker = ph.ProviderHealth(policy=_fast(window_size=12, minimum_calls=4))
    for _ in range(10):  # a steady 25% failure rate at every evaluation point
        for _ in range(3):
            tracker.record_success("openai", "m", "completion", role="router")
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
    assert tracker.allows("openai", "completion", "router", "m")[0] is True
    assert tracker.transitions() == []


def test_the_failure_rate_threshold_can_never_be_configured_below_one_half() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ResilienceConfig(failure_rate_threshold=0.25)
    # And the runtime reader floors it too, for a duck-typed policy object.
    class _Loose:
        failure_rate_threshold = 0.05
    assert ph.ProviderHealth(policy=_Loose())._failure_rate_threshold() == 0.5


def test_an_aged_out_window_lets_a_decommissioned_key_self_clear() -> None:
    tracker = ph.ProviderHealth(policy=_fast(outcome_max_age_seconds=60.0))
    for _ in range(3):
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
    key = "openai:completion:router:m"
    assert tracker._breakers[key]["state"] == ph.BREAKER_OPEN
    # Pretend an hour of silence passed, then close and record one more outcome.
    tracker._breakers[key]["state"] = ph.BREAKER_CLOSED
    tracker._breakers[key]["window"] = [
        (time.monotonic() - 3600.0, False) for _ in range(3)
    ]
    tracker.record_success("openai", "m", "completion", role="router")
    assert len(tracker._breakers[key]["window"]) == 1, "stale outcomes aged out"


# =========================================================================== #
# Resilience4j state machine: OPEN -> HALF_OPEN -> CLOSED / OPEN
# =========================================================================== #
def test_half_open_closes_on_two_consecutive_probe_successes() -> None:
    tracker = ph.ProviderHealth(policy=_fast(wait_seconds=1.0))
    for _ in range(3):
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
    key = "openai:completion:router:m"
    tracker._breakers[key]["open_until"] = 0.0          # the jittered wait elapsed
    tracker._breakers["openai:completion:*:*"]["open_until"] = 0.0
    assert tracker.allows("openai", "completion", "router", "m")[0] is True
    assert tracker._breakers[key]["state"] == ph.BREAKER_HALF_OPEN

    tracker.record_success("openai", "m", "completion", role="router")
    assert tracker._breakers[key]["state"] == ph.BREAKER_HALF_OPEN, "one probe is not proof"
    tracker.record_success("openai", "m", "completion", role="router")
    assert tracker._breakers[key]["state"] == ph.BREAKER_CLOSED
    assert [t["reason"] for t in tracker.transitions()][-1] == ph.REASON_PROBE_SUCCEEDED


def test_a_failed_probe_reopens_with_the_wait_doubled_and_capped() -> None:
    tracker = ph.ProviderHealth(policy=_fast(wait_seconds=2.0, max_wait_seconds=5.0))
    for _ in range(3):
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
    key = "openai:completion:router:m"
    waits = []
    for _ in range(4):
        tracker._breakers[key]["open_until"] = 0.0
        tracker._breakers["openai:completion:*:*"]["open_until"] = 0.0
        tracker.allows("openai", "completion", "router", "m")
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
        waits.append(tracker._breakers[key]["wait_seconds"])
    assert waits == [4.0, 5.0, 5.0, 5.0], waits


def test_the_open_deadline_uses_full_jitter() -> None:
    """AWS "Exponential Backoff And Jitter": uniform over [0, wait), not wait itself,
    so independently tripped keys do not resynchronise into a probe herd."""
    deadlines = set()
    for _ in range(25):
        tracker = ph.ProviderHealth(policy=_fast(wait_seconds=60.0))
        now = time.monotonic()
        for _ in range(3):
            tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
        row = tracker._breakers["openai:completion:router:m"]
        offset = row["open_until"] - now
        assert 0.0 <= offset <= 60.0 + 1.0
        deadlines.add(round(offset, 4))
    assert len(deadlines) > 1, "the wait is not jittered"


# =========================================================================== #
# The model-test surface must bypass the breaker
# =========================================================================== #
@pytest.mark.asyncio
async def test_a_model_test_bypasses_the_breaker_so_a_fixed_key_is_verifiable() -> None:
    """Refusing this surface would make the fix unverifiable and the breaker unclearable
    by the one operator action that should clear it."""
    es = InMemoryESClient()
    policy = _fast()
    provider = _RaisingProvider(status=401)
    gw, tracker = _gateway(provider, es, policy)

    for _ in range(3):
        with pytest.raises(GatewayError):
            await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())
    assert tracker.allows("anthropic", "completion", "router", "claude-sonnet-4-6")[0] is False

    # The operator fixes the credential and re-tests. The call goes through.
    gw._providers["anthropic"] = MockProvider()
    result = await gw.complete("chat", [{"role": "user", "content": "ok?"}],
                               _cfg(), surface="model_test")
    assert result.text

    # …and its outcome is a real probe: a second passing test closes the key.
    await gw.complete("chat", [{"role": "user", "content": "ok?"}],
                      _cfg(), surface="model_test")
    assert tracker.breaker_state("anthropic", "completion", "chat",
                                 "claude-sonnet-4-6") == ph.BREAKER_CLOSED


# =========================================================================== #
# Retry classifier — 429, Retry-After, and the providers that bypassed it
# =========================================================================== #
def test_a_429_is_quota_only_once_the_retry_budget_was_spent() -> None:
    spent = ProviderError("HTTP 429", retryable=True, status=429)
    spent.attempts, spent.retry_spent = 3, True
    assert classify_provider_failure(spent) == "quota"

    burst = ProviderError("HTTP 429", retryable=True, status=429)
    burst.attempts, burst.retry_spent = 1, False
    assert classify_provider_failure(burst) == "unavailable"

    # No retry provenance at all keeps the historical classification: absence of
    # evidence about the budget is not evidence that it was untouched.
    assert classify_provider_failure(
        ProviderError("HTTP 429", retryable=True, status=429)
    ) == "quota"


@pytest.mark.parametrize("value,expected", [
    ("30", 30.0), (" 7 ", 7.0), ("0", 0.0),
    ("not-a-number", None), ("", None), (None, None), ("-5", 0.0),
])
def test_retry_after_delta_seconds(value, expected) -> None:
    got = parse_retry_after(value)
    assert got == expected or (expected is not None and math.isclose(got, expected))


def test_retry_after_http_date() -> None:
    from datetime import datetime, timezone

    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert parse_retry_after("Thu, 01 Jan 2026 00:00:45 GMT", now=now) == 45.0
    # A date already in the past is 0, never negative.
    assert parse_retry_after("Wed, 01 Jan 2020 00:00:00 GMT", now=now) == 0.0


@pytest.mark.asyncio
async def test_retry_after_is_a_clamped_hint_never_a_verdict(monkeypatch) -> None:
    """It is provider-controlled input used as a SLEEP DURATION, so it is clamped."""
    slept: list[float] = []

    async def _record(delay):
        slept.append(delay)

    monkeypatch.setattr("app.llm.providers.asyncio.sleep", _record)
    attempts = {"n": 0}

    async def _call():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise ProviderError("HTTP 429", retryable=True, status=429, retry_after=45.0)
        return "ok"

    assert await with_retry(_call, attempts=3) == "ok"
    assert slept == [45.0], "the provider's own hint was honoured, not our backoff"

    slept.clear()
    attempts["n"] = 0

    async def _huge():
        attempts["n"] += 1
        raise ProviderError("HTTP 429", retryable=True, status=429, retry_after=86_400.0)

    with pytest.raises(ProviderError) as raised:
        await with_retry(_huge, attempts=3)
    assert attempts["n"] == 1, "a wall is not retried into"
    assert slept == [], "and we never slept for a day"
    assert raised.value.retry_spent is True
    assert classify_provider_failure(raised.value) == "quota"
    assert RETRY_AFTER_MAX_SECONDS <= 60.0


@pytest.mark.asyncio
async def test_the_attempt_count_reaches_the_usage_ledger() -> None:
    es = InMemoryESClient()
    gw, _ = _gateway(_RetryingProvider(), es, ResilienceConfig())
    with pytest.raises(GatewayError):
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())
    rows = await _usage_docs(es)
    assert rows[0]["attempts"] == 3
    assert rows[0]["failure_class"] == "quota"
    assert rows[0]["outcome"] == UsageOutcome.ERROR.value


@pytest.mark.asyncio
async def test_a_successful_call_records_its_own_provenance() -> None:
    es = InMemoryESClient()
    gw, _ = _gateway(MockProvider(), es, ResilienceConfig())
    await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())
    rows = await _usage_docs(es)
    assert rows[0]["failure_class"] == ""
    assert rows[0]["attempts"] >= 1


@pytest.mark.parametrize("provider_cls,kwargs", [
    ("AzureOpenAIProvider", {"api_key": "k", "base_url": "https://x.openai.azure.com"}),
    ("BedrockProvider", {"access_key_id": "a", "secret_access_key": "s"}),
    ("VertexProvider", {"access_token": "t", "project": "p"}),
])
def test_every_cloud_provider_now_shares_the_retry_budget(provider_cls, kwargs) -> None:
    """Azure/Bedrock/Vertex used to call ``raise_for_status()`` with no retry at all, so
    a single 429 a two-second wait would have cleared was reported as an exhausted
    quota — an IMMEDIATE-TRIP class once a breaker exists."""
    import app.llm.providers as providers_mod

    source = inspect.getsource(getattr(providers_mod, provider_cls).complete)
    assert "with_retry(" in source, f"{provider_cls}.complete bypasses the retry budget"


# =========================================================================== #
# #9 — the provider's response body must not reach a prompt
# =========================================================================== #
@pytest.mark.asyncio
async def test_the_provider_response_body_never_leaves_the_gateway() -> None:
    """The error text is interpolated into ``TriageResult.reason`` and
    ``VerdictResult.recommended_action`` — a Case field the resolved-case RAG
    projection renders back into a prompt, UNFENCED."""
    es = InMemoryESClient()
    gw, _ = _gateway(_RaisingProvider(status=500), es, ResilienceConfig())
    with pytest.raises(GatewayError) as raised:
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}], _cfg())
    message = str(raised.value)
    assert "<html>" not in message and "secret body" not in message
    assert raised.value.failure_class in {"unavailable", "quota", "unauthenticated"}
    # A three-digit HTTP status is protocol metadata from a closed numeric range, not
    # authored text — it is the diagnosis an operator needs with none of a body's
    # injection surface.
    assert message == f"provider call failed ({raised.value.failure_class}, HTTP 500)"
    # The full exception is still available for diagnosis, just not for a prompt.
    assert "secret body" in str(raised.value.__cause__)


# =========================================================================== #
# Config / default coherence
# =========================================================================== #
def test_the_mirrored_defaults_match_the_config_block() -> None:
    """``provider_health`` mirrors ``ResilienceConfig`` so it needs no config import.
    A change to one that forgets the other must fail here, not in production."""
    cfg = ResilienceConfig()
    assert ph.BREAKER_WINDOW_SIZE == cfg.window_size
    assert ph.BREAKER_MINIMUM_CALLS == cfg.minimum_calls
    assert ph.BREAKER_FAILURE_RATE_THRESHOLD == cfg.failure_rate_threshold
    assert ph.BREAKER_WAIT_SECONDS == cfg.wait_seconds
    assert ph.BREAKER_MAX_WAIT_SECONDS == cfg.max_wait_seconds
    assert ph.BREAKER_HALF_OPEN_SUCCESSES == cfg.half_open_successes
    assert ph.BREAKER_OUTCOME_MAX_AGE_SECONDS == cfg.outcome_max_age_seconds


def test_the_immediate_trip_classes_are_real_gateway_literals() -> None:
    """A typo here would silently disable immediate tripping and nothing else."""
    from app.llm import gateway as gateway_mod

    assert ph.IMMEDIATE_TRIP_CLASSES == {
        gateway_mod.FAILURE_UNAUTHENTICATED, gateway_mod.FAILURE_QUOTA,
    }
    assert ph.IMMEDIATE_TRIP_CLASSES <= gateway_mod.PROVIDER_FAILURE_CLASSES
    assert gateway_mod.FAILURE_NOT_CONFIGURED not in ph.IMMEDIATE_TRIP_CLASSES
    assert gateway_mod.FAILURE_UNSUPPORTED not in ph.IMMEDIATE_TRIP_CLASSES
    # Every reason code the transition log can emit is one of ours, not provider text.
    reasons = {
        ph.REASON_IMMEDIATE, ph.REASON_FAILURE_RATE, ph.REASON_PROBE_FAILED,
        ph.REASON_PROBE_SUCCEEDED, ph.REASON_WAIT_ELAPSED, ph.REASON_OBSERVED_SUCCESS,
    }
    assert all(reason.replace("_", "").isalpha() for reason in reasons)


def test_the_health_snapshot_keeps_its_historical_shape() -> None:
    tracker = ph.ProviderHealth()
    tracker.record_failure("openai", "unauthenticated", "m", "completion", role="router")
    snap = tracker.snapshot()
    for key in ("state", "degraded", "threshold", "providers"):
        assert key in snap
    assert set(snap["providers"]) == {"openai:completion"}, "the coarse rows are unchanged"
    assert "breaker" in snap, "additive, so the diagnostics route surfaces it for free"
    assert snap["breaker"]["enforced"] is False


def test_the_key_registry_is_bounded_but_never_evicts_a_live_key() -> None:
    """The model-test surface accepts an arbitrary operator-typed model id, so the key
    space is not bounded by configuration alone."""
    tracker = ph.ProviderHealth(policy=_fast())
    for _ in range(4):
        tracker.record_failure("openai", "unavailable", "critical", "completion",
                               role="router")
    assert tracker.allows("openai", "completion", "router", "critical")[0] is False

    for i in range(ph.MAX_BREAKER_KEYS + 300):
        tracker.record_success("openai", f"typo-{i}", "completion", role="chat")

    assert len(tracker._breakers) <= ph.MAX_BREAKER_KEYS
    # Eviction never re-admits a provider the breaker just refused.
    assert tracker.allows("openai", "completion", "router", "critical")[0] is False


def test_reset_clears_the_breaker_too() -> None:
    tracker = ph.ProviderHealth(policy=_fast())
    for _ in range(3):
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
    tracker.reset()
    assert tracker.breaker_snapshot()["keys"] == {}
    assert tracker.transitions() == []
    assert tracker.allows("openai", "completion", "router", "m")[0] is True


def test_the_transition_log_is_append_only_within_its_bound() -> None:
    tracker = ph.ProviderHealth(policy=_fast(wait_seconds=1.0))
    first = None
    for i in range(ph.MAX_TRANSITIONS + 20):
        for _ in range(3):
            tracker.record_failure("openai", "unavailable", f"m{i}", "completion",
                                   role="router")
        if first is None:
            first = tracker.transitions()[0]
    log = tracker.transitions()
    assert len(log) == ph.MAX_TRANSITIONS, "bounded"
    assert first not in log, "the OLDEST entry is dropped, never rewritten"
    # Ordering is stable and oldest-first.
    assert [entry["at"] for entry in log] == sorted(entry["at"] for entry in log)


class _RetryingProvider(BaseProvider):
    """Raises a 429 that ``with_retry`` really does retry, so ``attempts`` is real."""

    async def complete(self, role, messages, model, temperature, max_tokens):
        async def _call():
            raise ProviderError("HTTP 429: slow down", retryable=True, status=429)

        return await with_retry(_call, attempts=3, base_delay=0.0, max_delay=0.0)


# =========================================================================== #
# The window is the RING the snapshot reports — evidence and decision agree
# =========================================================================== #
def _clock(monkeypatch, start: float = 1_000.0) -> list[float]:
    """A monotonic clock the test drives, so an idle gap costs no wall time."""
    now = [start]
    monkeypatch.setattr(ph.time, "monotonic", lambda: now[0])
    return now


def test_a_failure_after_an_idle_gap_never_opens_on_discarded_evidence(monkeypatch) -> None:
    """The fold evaluated a PRE-TRIM alias of the ring: the samples it scored had just
    been discarded as too old. One failure after a five-hour gap opened a key whose
    quorum is 10, and the transition it logged said ``samples=1``."""
    now = _clock(monkeypatch)
    tracker = ph.ProviderHealth(policy=ResilienceConfig(enforce=True))
    for _ in range(9):  # a short burst, below the quorum of 10
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
        now[0] += 1.0
    assert tracker.breaker_state("openai", "completion", "router", "m") == ph.BREAKER_CLOSED

    now[0] += 5 * 3600.0  # five hours of silence: that burst is no longer evidence
    tracker.record_failure("openai", "unavailable", "m", "completion", role="router")

    assert tracker.breaker_state("openai", "completion", "router", "m") == ph.BREAKER_CLOSED
    assert tracker.allows("openai", "completion", "router", "m")[0] is True
    snap = tracker.breaker_snapshot()["keys"]["openai:completion:router:m"]
    assert snap["samples"] == 1, "the ring holds one sample; the decision must use one"


def test_the_trip_decision_scores_exactly_the_ring_the_snapshot_reports(monkeypatch) -> None:
    """The count bound was off by one for the same reason: the 21st sample was scored
    over 21 entries rather than the 20 the ring keeps, so a window that sits ON the trip
    threshold by its own reported numbers failed to open."""
    now = _clock(monkeypatch)
    tracker = ph.ProviderHealth(policy=ResilienceConfig(enforce=True))
    # 11 successes then 10 failures = 21 samples. NO prefix of the full 21 ever reaches
    # 0.50 (the whole list is 10/21 = 0.476), but the ring the store actually keeps —
    # the last 20 — is exactly 10/20 = 0.50, the trip threshold.
    for _ in range(11):
        tracker.record_success("openai", "m", "completion", role="router")
        now[0] += 1.0
    for i in range(10):
        assert tracker.breaker_state("openai", "completion", "router", "m") == (
            ph.BREAKER_CLOSED
        ), f"opened early at failure {i}"
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
        now[0] += 1.0
    snap = tracker.breaker_snapshot()["keys"]["openai:completion:router:m"]
    assert snap["samples"] == 20
    assert snap["failure_rate"] == pytest.approx(0.5)
    assert snap["state"] == ph.BREAKER_OPEN, "the reported ring is at the threshold"


@pytest.mark.parametrize("calls_per_day", [40, 100, 200, 816])
def test_the_failure_rate_arm_is_reachable_at_every_deployment_size(
    monkeypatch, calls_per_day: int
) -> None:
    """``ResilienceConfig`` promises a window "portable across a 40-alert-a-day site and
    a 40-a-minute one". A PER-SAMPLE age expiry broke that promise: it drained the ring
    faster than a modest deployment filled it, so below ~240 calls a day per key the
    quorum was unreachable and the whole 5xx/timeout regime was dead code. The age bound
    is an IDLE GAP, so the ring stays a count window at any volume."""
    now = _clock(monkeypatch)
    tracker = ph.ProviderHealth(policy=ResilienceConfig(enforce=True))
    interval = 86_400.0 / calls_per_day
    opened_after = None
    for i in range(400):
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
        if not tracker.allows("openai", "completion", "router", "m")[0]:
            opened_after = i + 1
            break
        now[0] += interval
    assert opened_after == ResilienceConfig().minimum_calls


# =========================================================================== #
# A key nobody calls any more drains — on READ, not only on write
# =========================================================================== #
def test_a_decommissioned_key_drains_on_read_and_stops_asserting_an_outage(
    monkeypatch,
) -> None:
    """``_trim`` ran only when a NEW outcome arrived, and a decommissioned key by
    definition receives none — so ``open_keys`` named a retired model forever, at
    ``failure_rate: 1.0``, clearable only by a process restart."""
    now = _clock(monkeypatch)
    tracker = ph.ProviderHealth(policy=ResilienceConfig(enforce=True))
    key = "openai:completion:router:retired-model"
    for _ in range(12):
        tracker.record_failure("openai", "unavailable", "retired-model", "completion",
                               role="router")
    assert key in tracker.breaker_snapshot()["open_keys"]

    now[0] += 30 * 86_400.0  # the operator retired the model a month ago
    snap = tracker.breaker_snapshot()
    assert snap["open_keys"] == [], snap["open_keys"]
    assert snap["keys"][key]["state"] == ph.BREAKER_CLOSED
    assert snap["keys"][key]["samples"] == 0
    assert snap["keys"][key]["failure_rate"] is None
    assert tracker.allows("openai", "completion", "router", "retired-model")[0] is True
    assert [t["reason"] for t in tracker.transitions()][-1] == ph.REASON_EVIDENCE_AGED_OUT


def test_silence_can_never_shorten_the_open_wait(monkeypatch) -> None:
    """``outcome_max_age_seconds`` may be configured BELOW ``wait_seconds``. Draining
    must not then flip an OPEN key closed before its jittered back-off has elapsed."""
    now = _clock(monkeypatch)
    tracker = ph.ProviderHealth(
        policy=_fast(wait_seconds=3600.0, max_wait_seconds=3600.0,
                     outcome_max_age_seconds=60.0)
    )
    for _ in range(3):
        tracker.record_failure("openai", "unavailable", "m", "completion", role="router")
    assert tracker.breaker_state("openai", "completion", "router", "m") == ph.BREAKER_OPEN
    now[0] += 120.0  # past the evidence age, nowhere near the wait
    assert tracker.breaker_state("openai", "completion", "router", "m") == ph.BREAKER_OPEN


# =========================================================================== #
# The operator's policy actually reaches the tracker
# =========================================================================== #
@pytest.mark.asyncio
async def test_the_operator_policy_reaches_the_breaker_through_the_settings_api(
    client,
) -> None:
    """``Preferences.resilience`` is persisted, schema-exposed and rendered by the
    generic Advanced settings page. Without the one wiring argument in ``AppState`` it
    was read by NOTHING: ``enforce`` did not enforce, every size was ignored, and
    ``/api/diagnostics/health`` reported a policy the operator never configured."""
    state = client.app.state.tlsoc
    resp = client.put(
        "/api/settings",
        json={"resilience": {"enforce": True, "window_size": 4, "minimum_calls": 2}},
    )
    assert resp.status_code == 200
    # The getter is read per call, exactly like the discount policy.
    state.gateway._sync_resilience_policy()
    tracker = state._provider_health
    assert tracker.enforcing is True
    assert tracker.breaker_snapshot()["policy"]["window_size"] == 4
    assert tracker.breaker_snapshot()["policy"]["minimum_calls"] == 2


def test_a_default_resilience_block_is_byte_for_byte_the_mirrored_defaults() -> None:
    """#5: wiring the policy must change nothing for a deployment that never edits it."""
    wired = ph.ProviderHealth(policy=Preferences().resilience).breaker_snapshot()["policy"]
    unwired = ph.ProviderHealth().breaker_snapshot()["policy"]
    assert wired == unwired
    assert ph.ProviderHealth(policy=Preferences().resilience).enforcing is False


# =========================================================================== #
# The retry budget bounds the CALL, not each sleep
# =========================================================================== #
@pytest.mark.asyncio
@pytest.mark.parametrize("hint,attempts", [(60.0, 3), (60.0, 5), (59.9, 6), (30.0, 4)])
async def test_the_retry_budget_is_cumulative_not_per_sleep(
    monkeypatch, hint: float, attempts: int
) -> None:
    """Clamping each sleep left the TOTAL at ``(attempts - 1) x 60s``. An ordinary
    ``Retry-After: 60`` then parked one ``gateway.complete()`` for 120s — the whole
    default ``caps.timeout_seconds`` — so one rate-limited router call consumed the
    entire case budget and an interactive chat turn blocked for two minutes."""
    slept: list[float] = []

    async def _record(delay):
        slept.append(delay)

    monkeypatch.setattr("app.llm.providers.asyncio.sleep", _record)

    async def _always_429():
        raise ProviderError("HTTP 429", retryable=True, status=429, retry_after=hint)

    with pytest.raises(ProviderError) as raised:
        await with_retry(_always_429, attempts=attempts)
    assert sum(slept) <= RETRY_AFTER_MAX_SECONDS, slept
    assert raised.value.retry_spent is True


# =========================================================================== #
# Sanitisation strips PROVIDER text, not our own answer
# =========================================================================== #
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider,expected",
    [("openai", "OpenAI API key not configured"),
     ("anthropic", "Anthropic API key not configured")],
)
async def test_an_unset_key_still_tells_the_operator_which_key_to_set(
    provider: str, expected: str
) -> None:
    """The model-test dialog's whole job is to say what is wrong. These messages are
    raised BEFORE any request, so they contain no provider bytes to sanitise — replacing
    them with ``provider call failed (not_configured)`` deleted the answer."""
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es))
    with pytest.raises(GatewayError) as raised:
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}],
                          ModelConfig(provider=provider, model="some-model"),
                          surface="model_test")
    assert str(raised.value) == expected
    assert raised.value.failure_class == "not_configured"


@pytest.mark.asyncio
async def test_a_provider_response_body_is_still_never_passed_through() -> None:
    """The allowlist is our own literals AND ``GatewayError``; a provider raises
    ``ProviderError``/httpx errors, so a body echoing one of those phrases cannot escape."""
    es = InMemoryESClient()
    hostile = "OpenAI API key not configured"

    class _Hostile(BaseProvider):
        async def complete(self, role, messages, model, temperature, max_tokens):
            raise ProviderError(f"HTTP 500: {hostile}", retryable=False, status=500)

        async def embed(self, texts, model):  # pragma: no cover - unused
            raise NotImplementedError

    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"anthropic": _Hostile()})
    with pytest.raises(GatewayError) as raised:
        await gw.complete(Role.ROUTER, [{"role": "user", "content": "x"}],
                          _cfg(), surface="investigate")
    assert hostile not in str(raised.value)
    assert str(raised.value) == "provider call failed (unavailable, HTTP 500)"
