"""The single LLM gateway (Non-negotiable #6).

100% of model calls go through ``complete``/``embed``. The usage/cost ledger is
written here and ONLY here, so no call can escape the ledger. Errors are recorded
(outcome=error) and surfaced as ``GatewayError`` so callers can fail-to-human
rather than silently dropping an alert.
"""

from __future__ import annotations

import asyncio
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
    last_attempt_count,
    reset_attempt_count,
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


class BreakerOpen(GatewayError):
    """Raised INSTEAD of attempting a call whose provider circuit breaker is open.

    It MUST subclass :class:`GatewayError`. Six call sites already catch
    ``GatewayError`` and turn it into a NEEDS_HUMAN verdict or a preserved draft; a
    sibling exception type would escape every one of them and surface as an uncaught
    exception on the ingest path — turning a graceful degradation into a dropped alert.
    Being a ``GatewayError`` means an open breaker routes to a human exactly like any
    other provider failure, and can never close or escalate a case (#3).

    No ledger row is written for a refused call: nothing was spent, so nothing is
    metered (#6). ``failure_class`` carries the class that tripped the breaker so the
    operator-visible reason still names the real cause.
    """

    #: The breaker key that refused, e.g. ``openai:completion:router:gpt-x``. Built
    #: entirely from operator configuration and our own closed vocabularies.
    breaker_key: str = ""
    #: Why it is open, as one closed-vocabulary reason code.
    breaker_reason: str = ""


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

#: The caller stopped waiting for a request that HAD been issued.
#:
#: Deliberately NOT a member of :data:`PROVIDER_FAILURE_CLASSES`: abandoning a call is
#: our own decision (a case time budget, a hard pipeline timeout), not evidence about the
#: provider, so it must never feed the health tracker or the circuit breaker — counting
#: it would let our own deadlines open a key on a provider that was answering fine.
#: It exists so the LEDGER still sees the call: #6 says 100% of LLM calls reach the
#: ledger, and a request that reached the provider costs money whether or not we waited
#: for the answer.
FAILURE_ABANDONED = "abandoned"

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
        # Not every failure arrives as a ``ProviderError``: an out-of-tree provider, or
        # any ``raise_for_status()`` outside the shared retry helper, delivers a RAW
        # ``httpx.HTTPStatusError`` whose code lives on ``response``. Without this, a
        # 401 from such a provider degraded to "unavailable" and the operator was told
        # the model was slow rather than that the key was rejected — the exact confusion
        # this classification exists to end.
        response = getattr(exc, "response", None)
        code = getattr(response, "status_code", None)
        if isinstance(code, int):
            status = code
    if isinstance(status, int):
        if status in (401, 403):
            return FAILURE_UNAUTHENTICATED
        if status == 429:
            # A 429 is a rate-limit signal, not by itself an exhausted quota. It is
            # reported as ``quota`` — an IMMEDIATE-TRIP class for the circuit breaker —
            # only when the bounded retry budget was actually spent on it (or the
            # provider's own Retry-After declared a window longer than we will wait).
            # ``retry_spent`` is stamped by ``providers.with_retry``; its ABSENCE means
            # no retry budget was involved (a raw httpx error, or an error constructed
            # outside the retry loop), and those keep the historical classification.
            spent = getattr(exc, "retry_spent", None)
            if spent is None or bool(spent):
                return FAILURE_QUOTA
            return FAILURE_UNAVAILABLE
    if isinstance(exc, NotImplementedError):
        # e.g. Anthropic/Bedrock/Vertex expose no embedding endpoint at all.
        return FAILURE_UNSUPPORTED
    # A missing key is raised as GatewayError("<Provider> API key not configured")
    # BEFORE any request is made, so it is a configuration state, not an outage.
    if isinstance(exc, GatewayError) and "not configured" in str(exc):
        return FAILURE_NOT_CONFIGURED
    return FAILURE_UNAVAILABLE


#: Gateway-AUTHORED failure text that passes through :func:`sanitized_failure_message`
#: verbatim.
#:
#: Sanitisation exists to strip PROVIDER-authored bytes (#9). These messages are raised
#: by ``_provider``/``_provider_kwargs`` BEFORE any request is made, so they contain no
#: response body at all — and they are the only text that names WHICH key an operator
#: has to set, which is exactly what the model-test dialog exists to tell them.
#: Flattening them to "provider call failed (not_configured)" removed the answer and
#: left nothing in its place.
#:
#: The match is on our own literals AND on ``GatewayError`` specifically: a provider
#: (in-tree or an out-of-tree ``tlsoc.llm_providers`` entry point) raises
#: ``ProviderError`` or an ``httpx`` error, never this class, so a response body that
#: happens to contain one of these phrases still cannot escape. The remaining
#: interpolation is a provider NAME from operator configuration, never log-derived —
#: length-capped anyway, because everything here can reach a Case field.
_GATEWAY_AUTHORED_PREFIXES = ("Unknown provider: ",)
_GATEWAY_AUTHORED_SUFFIXES = (" API key not configured",)
_GATEWAY_AUTHORED_MAX_CHARS = 120


def _gateway_authored_message(exc: BaseException) -> str:
    """The message verbatim when the gateway itself authored it, else ``""``."""
    if not isinstance(exc, GatewayError):
        return ""
    text = str(exc)
    if text.startswith(_GATEWAY_AUTHORED_PREFIXES) or text.endswith(
        _GATEWAY_AUTHORED_SUFFIXES
    ):
        return text[:_GATEWAY_AUTHORED_MAX_CHARS]
    return ""


def sanitized_failure_message(failure_class: str, exc: BaseException) -> str:
    """The operator-safe text for a provider failure. NEVER the provider's body.

    ``ProviderError``'s message embeds up to 300 bytes of the provider's response body
    (``providers.classify_http_error``), and the gateway's exception message is
    interpolated by the router into ``TriageResult.reason`` and by the investigator into
    ``VerdictResult.recommended_action`` — a Case field that the resolved-case RAG
    projection later renders straight back into a prompt, unfenced. That made an
    attacker-influenceable response body a durable corpus entry (#9).

    Everything this returns is either one of our own closed-vocabulary literals, a
    three-digit HTTP status, or one of the GATEWAY-AUTHORED messages allow-listed in
    :data:`_GATEWAY_AUTHORED_PREFIXES`/:data:`_GATEWAY_AUTHORED_SUFFIXES`. A status code
    is protocol metadata from a closed numeric range, not authored text, so it carries
    the diagnosis an operator actually needs (401 vs 429 vs 503) with none of the
    injection surface a body has.
    """
    authored = _gateway_authored_message(exc)
    if authored:
        # Our own pre-request text (an unset key, an unknown provider name). Sanitising
        # it would delete the one message that says which key to set while removing no
        # provider bytes at all — there are none in it.
        return authored
    status = getattr(exc, "status", None)
    if not isinstance(status, int):
        response = getattr(exc, "response", None)
        code = getattr(response, "status_code", None)
        status = code if isinstance(code, int) else None
    if isinstance(status, int) and 100 <= status <= 599:
        return f"provider call failed ({failure_class}, HTTP {status})"
    return f"provider call failed ({failure_class})"


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
        resilience_policy: Callable[[], Any] | None = None,
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
        # Live getter for ``Preferences.resilience`` (the circuit-breaker policy).
        # Optional and defaulted None so every historical/test constructor is unchanged;
        # when it is absent the tracker runs on its own mirrored defaults, which are
        # ADVISORY (``enforce`` off) — so an unwired deployment observes and reports but
        # refuses nothing, which is exactly the shipped posture.
        self._resilience_policy = resilience_policy

    # ------------------------------------------------------------------ #
    # Provider-health bookkeeping. Fail-open by construction: observability
    # must never be able to break a model call.
    # ------------------------------------------------------------------ #
    def _note_provider_success(
        self, model_cfg: ModelConfig, channel: str = "completion", role: str = ""
    ) -> None:
        tracker = self._sync_resilience_policy()
        if tracker is None:
            return
        try:
            tracker.record_success(
                str(model_cfg.provider), str(model_cfg.model), channel, role=str(role)
            )
        except TypeError:
            # A duck-typed tracker without the ``role`` keyword. An unexpected-keyword
            # TypeError is raised at the call boundary BEFORE the body runs, so the
            # retry cannot double-count; the coarse health signal matters more than the
            # breaker key. The retry gets its own guard: observability must never be
            # able to raise into a model call.
            try:
                tracker.record_success(
                    str(model_cfg.provider), str(model_cfg.model), channel
                )
            except Exception:  # noqa: BLE001
                logger.debug("provider-health success note failed", exc_info=True)
        except Exception:  # noqa: BLE001 — never let telemetry surface an error
            logger.debug("provider-health success note failed", exc_info=True)

    def _note_provider_failure(
        self, model_cfg: ModelConfig, failure_class: str, channel: str = "completion",
        role: str = "",
    ) -> None:
        tracker = self._sync_resilience_policy()
        if tracker is None:
            return
        try:
            tracker.record_failure(
                str(model_cfg.provider), str(failure_class), str(model_cfg.model),
                channel, role=str(role),
            )
        except TypeError:
            try:
                tracker.record_failure(
                    str(model_cfg.provider), str(failure_class), str(model_cfg.model),
                    channel,
                )
            except Exception:  # noqa: BLE001
                logger.debug("provider-health failure note failed", exc_info=True)
        except Exception:  # noqa: BLE001
            logger.debug("provider-health failure note failed", exc_info=True)

    # ------------------------------------------------------------------ #
    # Circuit breaker (item D) — SHIPPED IN ADVISORY MODE.
    # ------------------------------------------------------------------ #
    def _sync_resilience_policy(self) -> Any:
        """Point the health tracker at the live operator policy and return it.

        Read per call so a settings change takes effect without reconstructing the
        gateway, mirroring ``_discounted_policy``. Best-effort in every direction: no
        tracker, no getter, or a getter that raises all degrade to the tracker running
        on its own mirrored ADVISORY defaults.
        """
        tracker = self._provider_health
        if tracker is None:
            return None
        getter = self._resilience_policy
        if getter is None:
            return tracker
        try:
            policy = getter()
        except Exception as exc:  # noqa: BLE001 — a settings read must not drop a call
            logger.warning("resilience policy read failed (%s); using defaults", exc)
            return tracker
        try:
            tracker.set_policy(policy)
        except Exception:  # noqa: BLE001
            logger.debug("resilience policy set failed", exc_info=True)
        return tracker

    def _breaker_verdict(
        self, model_cfg: ModelConfig, role: str, channel: str, surface: str
    ) -> tuple[bool, str, str]:
        """``(allowed, reason, failure_class)`` for the next call on this key.

        A ``surface="model_test"`` call ALWAYS bypasses the breaker. That surface exists
        precisely so an operator can verify a credential they just fixed; refusing it
        while the breaker waits out its jittered timer would make the fix unverifiable
        and the breaker un-clearable by the one action that should clear it. Its outcome
        still feeds the window, so a successful test is the probe that closes the key.
        """
        tracker = self._sync_resilience_policy()
        if tracker is None or surface == "model_test":
            return True, "", ""
        # ``allows`` is called even in ADVISORY mode (where it always answers True), so
        # the OPEN → HALF_OPEN clock advances and an operator can watch a full recovery
        # cycle in the transition log rather than one permanently open key.
        try:
            return tracker.allows(
                str(model_cfg.provider), channel, str(role), str(model_cfg.model)
            )
        except Exception:  # noqa: BLE001 — an admission bug must never drop an alert
            logger.debug("breaker admission failed; allowing", exc_info=True)
            return True, "", ""

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
        # Circuit-breaker admission, immediately after the budget pre-flight and BEFORE
        # the try: like that pre-flight, a refusal happens before any provider call and
        # therefore writes NO ledger row (#6 — a call that never happened costs nothing
        # and must not appear to). It raises a GatewayError subclass, so every existing
        # handler routes it to NEEDS_HUMAN and it can never close a case (#3). No
        # provider failure is recorded either: refusing a call is not evidence about the
        # provider, and counting it would let an open breaker keep itself open.
        allowed, breaker_reason, breaker_class = self._breaker_verdict(
            model_cfg, role_str, "completion", surface
        )
        if not allowed:
            logger.warning(
                "circuit breaker OPEN (role=%s model=%s reason=%s class=%s); "
                "failing to human without a provider call",
                role_str, model_cfg.model, breaker_reason, breaker_class or "unknown",
            )
            error = BreakerOpen(
                f"provider circuit breaker open ({breaker_class or breaker_reason})"
            )
            error.failure_class = breaker_class or FAILURE_UNAVAILABLE
            error.breaker_reason = breaker_reason
            error.breaker_key = f"{model_cfg.provider}:completion:{role_str}:{model_cfg.model}"
            raise error
        service_tier, fallback_to_standard = self._alert_processing_preference(
            model_cfg, surface
        )
        started = time.perf_counter()
        reset_attempt_count()
        try:
            provider = self._provider(
                model_cfg.provider, model=model_cfg.model, endpoint=model_cfg,
                service_tier=service_tier,
                fallback_to_standard=fallback_to_standard,
            )
            result = await provider.complete(
                role_str, messages, model_cfg.model, model_cfg.temperature, model_cfg.max_tokens
            )
        except asyncio.CancelledError:
            # The CALLER stopped waiting (its slice of the case time budget, or the
            # pipeline's hard timeout) for a request that was already in flight. The
            # provider may well bill it, so #6 requires a row: without one the spend is
            # invisible to the ledger, the cost page and every budget rollup.
            #
            # ``CancelledError`` is a BaseException, so the ``except Exception`` below
            # never saw it. No provider failure is noted and no breaker key is touched:
            # our own deadline says nothing about the provider's health.
            latency = int((time.perf_counter() - started) * 1000)
            try:
                await self._record(
                    role_str, surface, case_id, model_cfg.model, 0, 0, latency,
                    UsageOutcome.ERROR, failure_class=FAILURE_ABANDONED,
                    attempts=last_attempt_count(),
                )
            except (Exception, asyncio.CancelledError):  # noqa: BLE001 — re-cancelled, or a store glitch
                logger.warning(
                    "abandoned LLM call (role=%s model=%s) could not be ledgered",
                    role_str, model_cfg.model,
                )
            raise
        except Exception as exc:  # noqa: BLE001
            latency = int((time.perf_counter() - started) * 1000)
            failure_class = classify_provider_failure(exc)
            attempts = last_attempt_count()
            self._note_provider_failure(model_cfg, failure_class, "completion", role_str)
            await self._record(role_str, surface, case_id, model_cfg.model, 0, 0, latency,
                               UsageOutcome.ERROR, failure_class=failure_class,
                               attempts=attempts)
            logger.warning("LLM call failed (role=%s model=%s class=%s attempts=%d): %s",
                           role_str, model_cfg.model, failure_class, attempts, exc)
            # Carry the CLOSED-VOCABULARY class on the exception so the pipeline can
            # name the real cause instead of reporting a downstream time cap.
            #
            # The MESSAGE is sanitised (see ``sanitized_failure_message``), NOT
            # ``str(exc)``: it is interpolated into Case fields that the precedent
            # projection renders back into a prompt (#9). Sanitising it HERE fixes every
            # downstream call site at once and cannot be bypassed by a new one. The full
            # exception is preserved on the logger call above and as this error's
            # ``__cause__``, so nothing diagnostic is lost.
            error = GatewayError(sanitized_failure_message(failure_class, exc))
            error.failure_class = failure_class
            raise error from exc

        attempts = last_attempt_count()
        self._note_provider_success(model_cfg, "completion", role_str)
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
            processing_tier=processing_tier, attempts=attempts,
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
        embed_role = Role.EMBEDDING.value
        # The embedding path NEVER raises on an open breaker. Every caller of this
        # method depends on it returning vectors, and the whole path is built to degrade
        # to local hashing instead of failing. Refusing would be actively harmful, not
        # merely unhelpful: queries would be hashed while the PERSISTED corpus stays in
        # the real embedding space, so retrieval would return NOISE rather than nothing —
        # degraded precedent, more NEEDS_HUMAN verdicts, and those verdicts render back
        # into the analyst-baseline block. The breaker would manufacture exactly the
        # poison it exists to prevent. So an open key short-circuits STRAIGHT to the
        # fallback with the tripping class as ``fallback_reason``, which is what makes
        # the existing guards refuse to persist hash-space chunks.
        allowed, breaker_reason, breaker_class = self._breaker_verdict(
            model_cfg, embed_role, "embedding", surface
        )
        if not allowed:
            fallback_reason = breaker_class or FAILURE_UNAVAILABLE
            logger.error(
                "Embedding provider circuit breaker OPEN (reason=%s class=%s) for "
                "model=%s; retrieval is degraded to local hash embeddings and NO chunk "
                "will be persisted in that space",
                breaker_reason, fallback_reason, model_cfg.model,
            )
            # No provider call happened, so no ERROR ledger row is written for one and
            # no provider failure is recorded (#6). The mock fallback's own OK row below
            # is the single row this call produces, exactly as on any fallback.
            result = await self._mock_fallback.embed(texts, "mock-embed")
            provider_used = "mock"
            model_used = "mock-embed"
            latency = int((time.perf_counter() - started) * 1000)
            cost = (
                _demo_synthetic_cost(result.tokens, 0)
                if self._demo
                else cost_for(model_used, result.tokens, 0,
                              await self._effective_price_tuple(model_used))
            )
            await self._record(embed_role, surface, case_id, model_used,
                               result.tokens, 0, latency, UsageOutcome.OK, cost,
                               failure_class=fallback_reason)
            return EmbeddingBatch(
                vectors=result.vectors,
                provider=provider_used,
                model=model_used,
                fallback=True,
                fallback_reason=fallback_reason,
            )
        reset_attempt_count()
        try:
            provider = self._provider(model_cfg.provider, for_embedding=True,
                                       model=model_cfg.model, endpoint=model_cfg)
            result = await provider.embed(texts, model_cfg.model)
            model_used = model_cfg.model
            self._note_provider_success(model_cfg, "embedding", embed_role)
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
            self._note_provider_failure(
                model_cfg, fallback_reason, "embedding", embed_role
            )
            # Record the provider failure so the ledger shows the outage, then fall
            # back to local hashing so RAG keeps working (graceful degradation).
            await self._record(embed_role, surface, case_id,
                               model_cfg.model, 0, 0,
                               int((time.perf_counter() - started) * 1000),
                               UsageOutcome.ERROR, 0.0,
                               failure_class=fallback_reason,
                               attempts=last_attempt_count())
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
        await self._record(embed_role, surface, case_id, model_used,
                           result.tokens, 0, latency, UsageOutcome.OK, cost,
                           failure_class=fallback_reason,
                           attempts=last_attempt_count())
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
        failure_class: str = "",
        attempts: int = 1,
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
            # Closed-vocabulary provenance for this row (never provider text, #9):
            # WHY it failed and how many attempts it took. Both are additive and
            # defaulted, so #6 still holds — one row per call, just a wider row.
            failure_class=str(failure_class or ""),
            attempts=max(1, int(attempts or 1)),
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
