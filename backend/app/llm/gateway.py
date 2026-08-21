"""The single LLM gateway (Non-negotiable #6).

100% of model calls go through ``complete``/``embed``. The usage/cost ledger is
written here and ONLY here, so no call can escape the ledger. Errors are recorded
(outcome=error) and surfaced as ``GatewayError`` so callers can fail-to-human
rather than silently dropping an alert.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

from ..build_identity import current_record_provenance
from ..config import ModelConfig, Provider, Secrets
from ..constants import Role, UsageOutcome
from ..models import UsageDoc
from ..stores.usage import UsageStore
from .pricing import base_url_for, cost_for, pricing_source, resolve_price
from .providers import (
    PROVIDER_REGISTRY,
    BaseProvider,
    CompletionResult,
    MockProvider,
    ProviderError,
    ensure_providers_discovered,
)

logger = logging.getLogger("tlsoc.gateway")


class GatewayError(RuntimeError):
    """Raised when a model call cannot be completed. Triggers fail-to-human.

    ``failure_class`` carries one :data:`PROVIDER_FAILURE_CLASSES` literal when the
    gateway could classify the underlying provider fault, so a caller can report the
    REAL cause (an expired key) instead of whatever downstream symptom it observed (a
    time cap). It is always one of our own closed-vocabulary strings — never provider
    response text (#9) — and defaults to ``""`` so every existing raiser is unchanged.
    """

    failure_class: str = ""


# --------------------------------------------------------------------------- #
# Provider-failure classification — a CLOSED vocabulary of our own literals.
# --------------------------------------------------------------------------- #
# A provider outage is not a per-call accident: 401 on every call is a SYSTEM
# state, and the product must be able to say so. These codes are the only values
# that ever travel with a failure, because the alternative — ``str(exc)`` — splices
# up to 300 bytes of the provider's response body (providers.classify_http_error)
# into a value that later reaches metadata, health surfaces and operator UI. That
# text is attacker-influenceable UNTRUSTED DATA (#9) and must never become a label.
#
# ``not_configured`` is deliberately distinct from every failure code: a deployment
# with no embedding key is running the supported offline/Demo profile, where local
# hash embeddings are the INTENDED behaviour (Gate 2), not a degradation.
FAILURE_NOT_CONFIGURED = "not_configured"
FAILURE_UNAUTHENTICATED = "unauthenticated"
FAILURE_QUOTA = "quota"
FAILURE_UNSUPPORTED = "unsupported"
FAILURE_UNAVAILABLE = "unavailable"

#: Every code a provider failure may be reported as. Anything unrecognised
#: degrades to ``unavailable`` rather than leaking provider text.
PROVIDER_FAILURE_CLASSES = frozenset(
    {
        FAILURE_NOT_CONFIGURED,
        FAILURE_UNAUTHENTICATED,
        FAILURE_QUOTA,
        FAILURE_UNSUPPORTED,
        FAILURE_UNAVAILABLE,
    }
)


def classify_provider_failure(exc: BaseException) -> str:
    """Map a provider exception onto one :data:`PROVIDER_FAILURE_CLASSES` literal.

    Pure and total: every input yields exactly one closed-vocabulary code, and no
    provider-supplied text is ever returned. ``ProviderError.status`` is populated by
    ``providers.classify_http_error``, so an HTTP 401/403 is distinguishable from a
    429 quota exhaustion and from a transport failure — which is the whole point:
    the incident's operator chased latency for days because a 401 was indistinguishable
    from a timeout.
    """
    status = getattr(exc, "status", None)
    if not isinstance(status, int):
        # Not every provider routes through ``with_retry``/``ProviderError``: Azure,
        # Bedrock and Vertex call ``raise_for_status()`` directly, so a RAW
        # ``httpx.HTTPStatusError`` reaches us with its code on ``response``. Without
        # this, a 401 from those providers degraded to "unavailable" and the operator
        # was told the model was slow rather than that the key was rejected — the
        # exact confusion this classification exists to end.
        response = getattr(exc, "response", None)
        code = getattr(response, "status_code", None)
        if isinstance(code, int):
            status = code
    if isinstance(status, int):
        if status in (401, 403):
            return FAILURE_UNAUTHENTICATED
        if status == 429:
            return FAILURE_QUOTA
    if isinstance(exc, NotImplementedError):
        # e.g. Anthropic/Bedrock/Vertex expose no embedding endpoint at all.
        return FAILURE_UNSUPPORTED
    # A missing key is raised as GatewayError("<Provider> API key not configured")
    # BEFORE any request is made, so it is a configuration state, not an outage.
    if isinstance(exc, GatewayError) and "not configured" in str(exc):
        return FAILURE_NOT_CONFIGURED
    return FAILURE_UNAVAILABLE


@dataclass(frozen=True)
class EmbeddingBatch:
    """Embedding vectors plus the provider/model that actually produced them.

    The configured model is not necessarily the actual model: the gateway can
    intentionally degrade to deterministic local hash embeddings. RAG persists
    this provenance so the stored space is never mislabeled as the failed remote
    model.
    """

    vectors: list[list[float]]
    provider: str
    model: str
    fallback: bool = False
    #: Why the fallback engaged, as one :data:`PROVIDER_FAILURE_CLASSES` literal
    #: (``""`` when the configured provider actually answered). ``not_configured``
    #: is the supported keyless profile; every other value is an OUTAGE, and RAG
    #: refuses to persist chunks embedded under one.
    fallback_reason: str = ""


# A plausible per-token blended rate for the Demo Mode cost page (Sonnet-ish).
# It is purely cosmetic — pricing_source is stamped 'zero' so the UI marks it
# "simulated" — and is DETERMINISTIC for a given token count ($0 real spend).
_DEMO_IN_RATE = 3.0 / 1_000_000.0      # $/input token
_DEMO_OUT_RATE = 15.0 / 1_000_000.0    # $/output token

# OpenAI Flex support is intentionally capability-gated. These are the families
# listed for Flex pricing by OpenAI as of 2026-07. A newly named/unsupported model
# therefore stays standard instead of receiving an invalid service_tier request.
_OPENAI_FLEX_MODEL_PREFIXES: tuple[str, ...] = ("gpt-5", "o3", "o4-mini")


def _demo_synthetic_cost(prompt_tokens: int, completion_tokens: int) -> float:
    return round(prompt_tokens * _DEMO_IN_RATE + completion_tokens * _DEMO_OUT_RATE, 8)


class LLMGateway:
    def __init__(
        self,
        secrets: Secrets,
        usage_store: UsageStore,
        provider_overrides: dict[str, BaseProvider] | None = None,
        *,
        demo: bool = False,
        price_overlay: Any = None,
        budget_gate: Any = None,
        custom_models: Any = None,
        discounted_policy: Callable[[], Any] | None = None,
        provider_health: Any = None,
    ) -> None:
        self._secrets = secrets
        self._usage = usage_store
        self._providers: dict[str, BaseProvider] = dict(provider_overrides or {})
        self._mock_fallback = MockProvider()
        # Demo Mode (Wave 5): when set, EVERY usage row is tagged pricing_source='zero'
        # (it is a $0 mock run) but carries a small PLAUSIBLE synthetic cost so the cost
        # page has believable numbers. The provider itself is the deterministic
        # DemoMockProvider, injected via provider_overrides by the demo state stack.
        self._demo = bool(demo)
        # Feature 9 (optional, defaulted None so the 3-arg constructor is unchanged):
        # an operator PriceOverlayStore (per-model negotiated rates layered on top of
        # the built-in table) and a BudgetGate (pure pre-flight ceiling check that
        # RAISES GatewayError on block → caller fails to NEEDS_HUMAN, never closes #3).
        self._overlay = price_overlay
        self._budget = budget_gate
        # Operator-added self-hosted / LiteLLM (OpenAI-compatible) models registered at
        # runtime (a CustomModelStore, optional/defaulted None so the historical ctor is
        # unchanged). It lets the gateway (1) resolve a bare custom model id's endpoint
        # when the per-role ModelConfig carried no base_url, and (2) treat a registered
        # local model as FREE ($0) even if its PriceOverlay write was lost — belt-and-
        # suspenders so a local model NEVER bills at the conservative default rate. It is
        # advisory to routing + the ledger only; it NEVER touches decide() (#3).
        self._custom_models = custom_models
        # Live getter for Preferences.batch. Keeping this optional preserves every
        # historical direct/test constructor; AppState supplies it so a settings
        # change takes effect without reconstructing callers.
        self._discounted_policy = discounted_policy
        # Aggregate provider health (see llm/provider_health.py). Owned by AppState so
        # a consecutive-failure run SURVIVES the gateway rebuilds that follow a
        # credential change; optional/defaulted so every historical constructor and
        # every direct test construction is unchanged. Advisory only — never read by
        # case_manager.decide() (#3), and it adds no ledger row (#6).
        self._provider_health = provider_health

    # ------------------------------------------------------------------ #
    # Provider-health bookkeeping. Fail-open by construction: observability
    # must never be able to break a model call.
    # ------------------------------------------------------------------ #
    def _note_provider_success(
        self, model_cfg: ModelConfig, channel: str = "completion"
    ) -> None:
        tracker = self._provider_health
        if tracker is None:
            return
        try:
            tracker.record_success(
                str(model_cfg.provider), str(model_cfg.model), channel
            )
        except Exception:  # noqa: BLE001 — never let telemetry surface an error
            logger.debug("provider-health success note failed", exc_info=True)

    def _note_provider_failure(
        self, model_cfg: ModelConfig, failure_class: str, channel: str = "completion"
    ) -> None:
        tracker = self._provider_health
        if tracker is None:
            return
        try:
            tracker.record_failure(
                str(model_cfg.provider), str(failure_class), str(model_cfg.model), channel
            )
        except Exception:  # noqa: BLE001
            logger.debug("provider-health failure note failed", exc_info=True)

    def provider_health_state(self) -> str:
        """The worst active provider-health state, or ``"ok"``.

        Public so a caller that observed a DOWNSTREAM symptom (most importantly the
        pipeline's investigation time cap) can name the real upstream cause instead.
        During the incident this exists for, cases whose actual failure was HTTP 401
        displayed "Investigation exceeded the 120s time cap", and the operator chased
        latency and evidence quality for days. Returns one closed-vocabulary state and
        never raises.
        """
        tracker = self._provider_health
        if tracker is None:
            return "ok"
        try:
            return str(tracker.snapshot().get("state") or "ok")
        except Exception:  # noqa: BLE001
            return "ok"

    async def recorded_case_pipeline_cost(self, case_id: str) -> float | None:
        """Read authoritative all-time investigation-pipeline spend for one case.

        Case presentation stores a six-decimal cumulative total. Re-reading the
        router/investigator/formatter ledger rows prevents repeated investigations
        from accumulating per-run rounding error while keeping the gateway as the sole
        ledger owner (#6). Case-scoped Chat and overview usage remain separate.
        """
        return await self._usage.total_pipeline_cost_for_case(case_id)

    # ----- provider resolution -----
    def _provider(
        self, name: Provider | str, *, for_embedding: bool = False, model: str = "",
        endpoint: ModelConfig | None = None, service_tier: str | None = None,
        fallback_to_standard: bool = True,
    ) -> BaseProvider:
        # An explicit override (tests / demo) keyed by provider NAME wins, byte-identical
        # to the historical behaviour (mock/anthropic/openai injected by the test/demo
        # stack). The model-keyed cache below only applies to gateway-constructed clients.
        if name in self._providers:
            return self._providers[name]
        # A per-role ModelConfig.base_url (Wave 2b) pins this role's endpoint and wins
        # over the bundled registry's base_url_for(model); the registry remains the
        # fallback so an existing config with no per-role override is byte-identical.
        cfg_base = (endpoint.base_url or "").strip() if endpoint is not None else ""
        base_url = cfg_base or (base_url_for(model) if model else None) or None
        api_version = (endpoint.api_version or None) if endpoint is not None else None
        region = (endpoint.region or None) if endpoint is not None else None
        # Per-(provider, base_url, api_version, region) cache key so a registry/cfg
        # base_url (vLLM/Ollama/Azure/...) for a specific model gets its own client
        # without colliding with the default.
        cache_key = str(name)
        if base_url or api_version or region or service_tier:
            # The fallback policy is constructor state on OpenAIProvider, so it is
            # part of the client identity whenever a live service tier is selected.
            # Without this bit, changing only `fallback_to_standard` in live prefs
            # could silently reuse the previously-cached provider until restart.
            fallback_key = int(bool(fallback_to_standard)) if service_tier else 1
            cache_key = (
                f"{name}@{base_url}|{api_version}|{region}|"
                f"{service_tier or 'standard'}|fallback={fallback_key}"
            )
        cached = self._providers.get(cache_key)
        if cached is not None:
            return cached
        factory = PROVIDER_REGISTRY.get(str(name))
        if factory is None:
            # A miss may be a third-party provider registered via the
            # ``tlsoc.llm_providers`` entry-point group — discover once (isolated +
            # warned) and retry before failing. Built-in names never reach this branch.
            ensure_providers_discovered()
            factory = PROVIDER_REGISTRY.get(str(name))
        if factory is None:
            raise GatewayError(f"Unknown provider: {name}")
        kwargs = self._provider_kwargs(
            str(name), for_embedding=for_embedding, base_url=base_url,
            api_version=api_version, region=region, service_tier=service_tier,
            fallback_to_standard=fallback_to_standard,
        )
        provider = factory(**kwargs)
        self._providers[cache_key] = provider
        return provider

    def _provider_kwargs(self, name: str, *, for_embedding: bool, base_url: str | None,
                         api_version: str | None = None, region: str | None = None,
                         service_tier: str | None = None,
                         fallback_to_standard: bool = True) -> dict[str, Any]:
        """Resolve the credential/endpoint kwargs a provider factory needs from
        ``Secrets`` (the anthropic/openai/mock paths are byte-identical to before;
        the new providers read best-effort secret attrs that may be unset → the
        factory still constructs, and the call fails cleanly on a missing key)."""
        if name == "mock":
            return {}
        if name == "anthropic":
            if not self._secrets.anthropic_api_key:
                raise GatewayError("Anthropic API key not configured")
            return {"api_key": self._secrets.anthropic_api_key, "base_url": base_url}
        if name in ("openai", "openai_compatible"):
            if name == "openai_compatible" and not for_embedding:
                # A dedicated self-hosted / LiteLLM key slot; fall back to the OpenAI key
                # so an existing openai_compatible config with only openai_api_key set is
                # byte-identical.
                key = getattr(self._secrets, "litellm_api_key", None) or self._secrets.openai_api_key
            else:
                key = self._secrets.embedding_key() if for_embedding else self._secrets.openai_api_key
            # An OpenAI-compatible self-hosted endpoint (base_url set) may need no key.
            if not key and not base_url:
                raise GatewayError("OpenAI API key not configured")
            # A no-auth self-hosted / LiteLLM server (base_url set, no key) still needs a
            # WELL-FORMED ``Authorization: Bearer <key>`` header — default to a non-empty
            # placeholder (an empty string is rejected by strict OpenAI-compatible clients).
            if not key and base_url and name == "openai_compatible":
                key = "sk-no-key"
            out = {"api_key": key or "", "base_url": base_url}
            # ``service_tier`` is an OpenAI cloud capability, not part of the generic
            # OpenAI-compatible contract. Never send it to self-hosted/LiteLLM paths.
            if name == "openai" and service_tier:
                out["service_tier"] = service_tier
                out["fallback_to_standard"] = bool(fallback_to_standard)
            return out
        if name == "azure":
            key = getattr(self._secrets, "azure_openai_api_key", None) or self._secrets.openai_api_key
            kwargs: dict[str, Any] = {
                "api_key": key or "",
                "base_url": base_url or getattr(self._secrets, "azure_openai_endpoint", "") or "",
            }
            # Pass the api-version through to the Azure factory: the per-role
            # ModelConfig.api_version wins, then the operator-configured secret, else the
            # factory's stable default applies.
            eff_api_version = api_version or getattr(self._secrets, "azure_openai_api_version", None)
            if eff_api_version:
                kwargs["api_version"] = eff_api_version
            return kwargs
        if name == "bedrock":
            return {
                "access_key_id": getattr(self._secrets, "aws_access_key_id", "") or "",
                "secret_access_key": getattr(self._secrets, "aws_secret_access_key", "") or "",
                # Per-role ModelConfig.region wins over the secret default.
                "region": region or getattr(self._secrets, "aws_region", "") or "us-east-1",
                "session_token": getattr(self._secrets, "aws_session_token", None),
                "base_url": base_url,
            }
        if name == "vertex":
            return {
                # The Vertex credential is a short-lived OAuth access token (Bearer),
                # supplied by the operator as ``vertex_api_key``.
                "access_token": getattr(self._secrets, "vertex_api_key", "") or "",
                "project": getattr(self._secrets, "vertex_project", "") or "",
                "location": getattr(self._secrets, "vertex_location", "") or "us-central1",
                "base_url": base_url,
            }
        # Unknown-but-registered name: pass base_url only (OpenAI-flavoured fallback).
        return {"api_key": self._secrets.openai_api_key or "", "base_url": base_url}

    # ----- completions -----
    async def complete(
        self,
        role: Role | str,
        messages: list[dict[str, str]],
        model_cfg: ModelConfig,
        *,
        surface: str = "",
        case_id: str | None = None,
    ) -> CompletionResult:
        role_str = role.value if isinstance(role, Role) else role
        # Budget pre-flight (Feature 9, Track B): a PURE ceiling check that RAISES on
        # block BEFORE the provider call + BEFORE any ledger write, so a blocked call
        # fails to NEEDS_HUMAN and NEVER closes a case (#3). Demo/mock ($0) bypasses.
        await self._budget_preflight(role_str, messages, model_cfg)
        # Fill in a runtime-added custom model's endpoint (base_url) when the per-role
        # config carried none, so a role bound to a self-hosted / LiteLLM model routes
        # to the right server. No-op for every model with an explicit / registry base_url.
        model_cfg = await self._resolve_endpoint(model_cfg)
        service_tier, fallback_to_standard = self._alert_processing_preference(
            model_cfg, surface
        )
        started = time.perf_counter()
        try:
            provider = self._provider(
                model_cfg.provider, model=model_cfg.model, endpoint=model_cfg,
                service_tier=service_tier,
                fallback_to_standard=fallback_to_standard,
            )
            result = await provider.complete(
                role_str, messages, model_cfg.model, model_cfg.temperature, model_cfg.max_tokens
            )
        except Exception as exc:  # noqa: BLE001
            latency = int((time.perf_counter() - started) * 1000)
            failure_class = classify_provider_failure(exc)
            self._note_provider_failure(model_cfg, failure_class)
            await self._record(role_str, surface, case_id, model_cfg.model, 0, 0, latency,
                               UsageOutcome.ERROR)
            logger.warning("LLM call failed (role=%s model=%s class=%s): %s",
                           role_str, model_cfg.model, failure_class, exc)
            # Carry the CLOSED-VOCABULARY class on the exception so the pipeline can
            # name the real cause instead of reporting a downstream time cap. The
            # message itself is unchanged (callers and tests match on it), and the
            # provider's own text is never promoted into a label (#9).
            error = GatewayError(str(exc))
            error.failure_class = failure_class
            raise error from exc

        self._note_provider_success(model_cfg)
        latency = int((time.perf_counter() - started) * 1000)
        model_used = result.model or model_cfg.model
        cache_read = int(getattr(result, "cache_read_tokens", 0) or 0)
        cache_write = int(getattr(result, "cache_write_tokens", 0) or 0)
        is_batch = bool(getattr(result, "batch", False))
        processing_tier = str(getattr(result, "processing_tier", "standard") or "standard")
        if self._demo:
            # $0 mock run, but stamp a small PLAUSIBLE synthetic cost for the cost page.
            cost = _demo_synthetic_cost(result.prompt_tokens, result.completion_tokens)
        else:
            cost = cost_for(model_used, result.prompt_tokens, result.completion_tokens,
                            await self._effective_price_tuple(model_used),
                            cache_read_tokens=cache_read, cache_write_tokens=cache_write,
                            batch=is_batch)
        result.cost = cost  # let callers roll up per-case cost (Case.token_cost)
        await self._record(
            role_str, surface, case_id, model_used,
            result.prompt_tokens, result.completion_tokens, latency, UsageOutcome.OK, cost,
            cache_read_tokens=cache_read, cache_write_tokens=cache_write, batch=is_batch,
            processing_tier=processing_tier,
        )
        return result

    def _alert_processing_preference(
        self, model_cfg: ModelConfig, surface: str,
    ) -> tuple[str | None, bool]:
        """Return the safe live service-tier preference for one completion.

        Only case/alert surfaces are cost-routed. Chat, standup, overview, embeddings
        and operator model tests remain interactive/standard. Only official OpenAI
        endpoints and currently-supported model families receive ``flex``; every
        unsupported combination falls back BEFORE a provider call and is therefore
        truthfully billed as standard.
        """
        if surface not in {"automated_scan", "investigate"}:
            return None, True
        if self._discounted_policy is None:
            return None, True
        try:
            policy = self._discounted_policy()
        except Exception as exc:  # noqa: BLE001 — cost preference must not drop alerts
            logger.warning("discounted-inference policy read failed (%s); using standard", exc)
            return None, True
        fallback = bool(getattr(policy, "fallback_to_standard", True))
        if not bool(getattr(policy, "prefer_discounted_alerts", False)):
            return None, fallback
        # ``batch.providers`` is the allow-list for the separate ASYNC Batch queue.
        # Live Flex eligibility is intentionally independent: disabling OpenAI Batch
        # must not silently disable the operator's live-Flex preference.
        if str(model_cfg.provider) != "openai":
            return None, fallback
        # A base_url means Azure/self-hosted/compatible routing even if the provider
        # label is "openai". Flex must never leak onto that non-OpenAI contract.
        if (model_cfg.base_url or "").strip() or base_url_for(model_cfg.model):
            return None, fallback
        model = (model_cfg.model or "").strip().lower()
        if not any(model.startswith(prefix) for prefix in _OPENAI_FLEX_MODEL_PREFIXES):
            return None, fallback
        return "flex", fallback

    # ----- embeddings (degrade gracefully to local hashing) -----
    async def embed(
        self,
        texts: list[str],
        model_cfg: ModelConfig,
        *,
        surface: str = "rag",
        case_id: str | None = None,
    ) -> list[list[float]]:
        """Back-compatible vector-only embedding API."""
        batch = await self.embed_with_provenance(
            texts, model_cfg, surface=surface, case_id=case_id
        )
        return batch.vectors

    async def embed_with_provenance(
        self,
        texts: list[str],
        model_cfg: ModelConfig,
        *,
        surface: str = "rag",
        case_id: str | None = None,
    ) -> EmbeddingBatch:
        """Embed ``texts`` through the provider (then the ledger, #6).

        NOTE: embeddings are METERED but deliberately NOT pre-flight-gated by the
        BudgetGate. The gate's ``check`` is completion-shaped (it prices a prompt +
        ``max_tokens`` of OUTPUT) and embeddings have no output-token dimension and
        are 1-2 orders of magnitude cheaper per call; gating them would add no
        meaningful spend control while risking a hard-fail of a RAG import on a
        ceiling that the completion path is already enforcing. The cost still lands
        in the ledger, so the BudgetGate's rolling-spend read accounts for it on the
        NEXT completion pre-flight. (If an operator ever needs to cap embedding spend
        specifically, add an embed-shaped pre-flight here mirroring _budget_preflight.)
        """
        model_cfg = await self._resolve_endpoint(model_cfg)
        started = time.perf_counter()
        provider_used = str(model_cfg.provider)
        fallback = False
        fallback_reason = ""
        try:
            provider = self._provider(model_cfg.provider, for_embedding=True,
                                       model=model_cfg.model, endpoint=model_cfg)
            result = await provider.embed(texts, model_cfg.model)
            model_used = model_cfg.model
            self._note_provider_success(model_cfg)
        except Exception as exc:  # noqa: BLE001
            fallback_reason = classify_provider_failure(exc)
            if fallback_reason == FAILURE_NOT_CONFIGURED:
                # The supported keyless profile: local hashing is the intended
                # behaviour here, so this stays an INFO-level note.
                logger.info(
                    "No embedding provider configured; using local hash embeddings"
                )
            else:
                # An OUTAGE. This used to log at INFO and was indistinguishable from
                # the keyless profile, so 47+ occurrences of a total auth failure left
                # no operator-visible trace. Retrieval still degrades gracefully, but
                # the condition is now named and loud.
                logger.error(
                    "Embedding provider FAILED (%s) for model=%s; retrieval is degraded "
                    "to local hash embeddings and NO chunk will be persisted in that "
                    "space: %s",
                    fallback_reason, model_cfg.model, exc,
                )
            self._note_provider_failure(model_cfg, fallback_reason, "embedding")
            # Record the provider failure so the ledger shows the outage, then fall
            # back to local hashing so RAG keeps working (graceful degradation).
            await self._record(Role.EMBEDDING.value, surface, case_id,
                               model_cfg.model, 0, 0,
                               int((time.perf_counter() - started) * 1000),
                               UsageOutcome.ERROR, 0.0)
            result = await self._mock_fallback.embed(texts, "mock-embed")
            provider_used = "mock"
            model_used = "mock-embed"
            fallback = True
        latency = int((time.perf_counter() - started) * 1000)
        if self._demo:
            # $0 mock run — embeddings are input-only, so the synthetic cost mirrors
            # complete()'s demo branch (and _record's demo fallback) so a demo embed
            # row's cost matches its pricing_source='zero' "simulated" badge instead
            # of carrying the real $0.02/1M table rate.
            cost = _demo_synthetic_cost(result.tokens, 0)
        else:
            cost = cost_for(model_used, result.tokens, 0,
                            await self._effective_price_tuple(model_used))
        await self._record(Role.EMBEDDING.value, surface, case_id, model_used,
                           result.tokens, 0, latency, UsageOutcome.OK, cost)
        return EmbeddingBatch(
            vectors=result.vectors,
            provider=provider_used,
            model=model_used,
            fallback=fallback,
            fallback_reason=fallback_reason,
        )

    # ----- endpoint (base_url) resolution for a runtime-added custom model -----
    async def _resolve_endpoint(self, model_cfg: ModelConfig) -> ModelConfig:
        """Fill in a runtime-added custom model's ``base_url`` when the per-role
        ModelConfig didn't carry one, so a role assigned a self-hosted / LiteLLM model
        (or a model_test against it) routes to the right endpoint.

        Precedence is preserved: an explicit ``ModelConfig.base_url`` wins, then the
        bundled registry's ``base_url_for(model)``, THEN the operator's CustomModelStore,
        else the provider default. Returns ``model_cfg`` unchanged unless the custom
        store supplies the endpoint (a copy is returned so the caller's config is not
        mutated). Best-effort: a store glitch degrades to the unchanged config."""
        if (model_cfg.base_url or "").strip() or self._custom_models is None:
            return model_cfg
        # The bundled registry already addresses this model → let _provider use it.
        if model_cfg.model and base_url_for(model_cfg.model):
            return model_cfg
        try:
            cbu = await self._custom_models.base_url_for(model_cfg.model)
        except Exception as exc:  # noqa: BLE001 — custom-model store is advisory to routing
            logger.warning("custom-model base_url lookup failed (%s)", exc)
            return model_cfg
        if not cbu:
            return model_cfg
        return model_cfg.model_copy(update={"base_url": cbu})

    # ----- pricing overlay + budget pre-flight helpers (Feature 9) -----
    async def _overlay_tuple(self, model: str) -> tuple[float, float] | None:
        """The operator PriceOverlayStore override for ``model`` as a price tuple, or
        None (→ cost_for falls back to the built-in table / registry). Best-effort:
        a store glitch degrades to None so the ledger never loses a price source."""
        if self._overlay is None:
            return None
        try:
            return await self._overlay.as_price_tuple(model)
        except Exception as exc:  # noqa: BLE001 — overlay is advisory to the ledger
            logger.warning("price overlay lookup failed (%s); using built-in rate", exc)
            return None

    async def _effective_price_tuple(self, model: str) -> tuple[float, float] | None:
        """The price tuple to bill ``model`` at: the operator PriceOverlay override if
        set, ELSE ``(0.0, 0.0)`` when ``model`` is a registered self-hosted / LiteLLM
        model (a local model is FREE by contract), ELSE None (→ cost_for falls back to
        the built-in table). This is the belt-and-suspenders that guarantees a custom
        model meters a real $0 even if its overlay row was lost — and it never changes a
        non-custom model's price (an unregistered model returns exactly what
        ``_overlay_tuple`` returned). Best-effort: a store glitch degrades to None."""
        tup = await self._overlay_tuple(model)
        if tup is not None:
            return tup
        if self._custom_models is None:
            return None
        try:
            if await self._custom_models.get_model(model):
                return (0.0, 0.0)
        except Exception as exc:  # noqa: BLE001 — custom-model store is advisory to the ledger
            logger.warning("custom-model price lookup failed (%s); using built-in rate", exc)
        return None

    async def _budget_preflight(self, role: str, messages: list[dict[str, str]],
                                model_cfg: ModelConfig) -> None:
        """Run the optional BudgetGate BEFORE a billable call. On a ``block`` decision
        it RAISES GatewayError (caller fails to NEEDS_HUMAN — never closes #3). Demo/
        mock / $0 models bypass the gate. Best-effort: a gate evaluation glitch never
        hard-blocks a call (logged) — the budget is governance, not a safety stop."""
        if self._budget is None or self._demo:
            return
        if str(model_cfg.provider) == "mock" or model_cfg.model.startswith("mock"):
            return
        try:
            prompt_chars = sum(len(str(m.get("content", ""))) for m in messages)
            decision = await self._budget.check(
                prompt_chars=prompt_chars, max_tokens=model_cfg.max_tokens, model=model_cfg.model,
                overlay=await self._effective_price_tuple(model_cfg.model),
            )
        except GatewayError:
            raise
        except Exception as exc:  # noqa: BLE001 — a gate glitch must not drop the alert
            logger.warning("budget pre-flight soft-failed (%s); allowing the call", exc)
            return
        if decision is not None and decision.get("action") == "block":
            reason = str(decision.get("reason", "budget ceiling exceeded"))
            logger.warning("budget BLOCK (role=%s model=%s): %s", role, model_cfg.model, reason)
            raise GatewayError(f"budget ceiling exceeded: {reason}")

    # ----- ledger write (the ONE place) -----
    async def _record(
        self,
        role: str,
        surface: str,
        case_id: str | None,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        latency_ms: int,
        outcome: UsageOutcome,
        cost: float | None = None,
        *,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        batch: bool = False,
        processing_tier: str | None = None,
        idempotency_key: str | None = None,
        require_persistence: bool = False,
    ) -> None:
        total = prompt_tokens + completion_tokens
        # Demo Mode: a $0 mock run — pricing_source is ALWAYS 'zero' (the cost is
        # synthetic, not a verified rate), so the cost page can badge it "simulated".
        # When an operator price overlay sets a rate, the provenance is 'exact' (a
        # verified, operator-supplied contract price) — it overrides the table source.
        if self._demo:
            price_src = "zero"
        elif await self._effective_price_tuple(model) is not None:
            # An operator overlay OR a registered self-hosted / LiteLLM model — either
            # is a verified, operator-supplied rate (a local model's real $0).
            price_src = "exact"
        else:
            price_src = pricing_source(model)
        if cost is None:
            cost = (
                _demo_synthetic_cost(prompt_tokens, completion_tokens)
                if self._demo
                else cost_for(model, prompt_tokens, completion_tokens,
                              await self._effective_price_tuple(model),
                              cache_read_tokens=cache_read_tokens,
                              cache_write_tokens=cache_write_tokens, batch=batch)
            )
        doc = UsageDoc(
            **current_record_provenance(),
            surface=surface,
            case_id=case_id,
            role=role,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total,
            cost=cost,
            latency_ms=latency_ms,
            outcome=outcome,
            pricing_source=price_src,
            cache_read_tokens=int(cache_read_tokens or 0),
            cache_write_tokens=int(cache_write_tokens or 0),
            batch=bool(batch),
            processing_tier=(processing_tier or ("batch" if batch else "standard")),
            idempotency_key=idempotency_key,
        )
        if require_persistence:
            await self._usage.write_strict(doc)
        else:
            await self._usage.write(doc)

    def reset_providers(self) -> None:
        """Drop cached provider clients so new secret values take effect.
        (Used after the wizard updates keys at runtime.)"""
        self._providers = {}

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()
