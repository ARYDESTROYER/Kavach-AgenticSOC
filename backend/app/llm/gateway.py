"""The single LLM gateway (Non-negotiable #6).

100% of model calls go through ``complete``/``embed``. The usage/cost ledger is
written here and ONLY here, so no call can escape the ledger. Errors are recorded
(outcome=error) and surfaced as ``GatewayError`` so callers can fail-to-human
rather than silently dropping an alert.

Live text (chat revamp SPEC §6.3) is NOT a second entry point: ``complete`` takes an
optional ``on_text`` callback and, when it is given, asks the provider to stream.
Budget pre-flight, breaker admission, failure classification and the single
``_record`` stay in ``complete`` either way, so a streamed call is metered by the
same code as a blocking one — exactly one UsageDoc per call on success, failure and
cancellation (#6).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

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
    StreamInterrupted,
    StreamProgress,
    begin_stream_progress,
    end_stream_progress,
    ensure_providers_discovered,
    last_attempt_count,
    note_stream_input_usage,
    provider_streams_text,
    reset_attempt_count,
)

logger = logging.getLogger("tlsoc.gateway")

#: ``UsageDoc.usage_estimated`` is an additive ledger column that may not exist yet in
#: the model layer; the gateway writes it only when the contract carries it, so the
#: estimate flag lands the moment the field does and nothing breaks before then.
_USAGE_DOC_HAS_ESTIMATED = "usage_estimated" in UsageDoc.model_fields


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


class BudgetBlocked(GatewayError):
    """Raised by the budget pre-flight INSTEAD of a call that would breach the
    operator's AI budget (chat revamp SPEC §4.5).

    A ``GatewayError`` subclass for the same reason as :class:`BreakerOpen`: every
    existing ``except GatewayError`` handler keeps routing it to NEEDS_HUMAN (#3), and
    the message is unchanged (``budget ceiling exceeded: …``). The distinct type lets
    the chat engine say "daily budget reached" instead of "model unavailable".

    It is NOT a provider failure: ``failure_class`` stays ``""``, nothing is recorded
    against provider health or the circuit breaker, and no ledger row is written —
    the call never happened, so nothing was spent (#6).
    """

    #: The BudgetGate's own reason text (our wording, never provider text).
    reason: str = ""
    #: Which ceiling blocked: ``daily`` or ``monthly`` ("" when the gate did not say).
    window: str = ""


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

#: A streamed completion failed AFTER its first text delta (SPEC §6.3). It IS a
#: provider failure (the stream broke on the provider's side of the socket) so it is a
#: member of :data:`PROVIDER_FAILURE_CLASSES` and feeds the health tracker. It is an
#: ORDINARY window failure there — not in ``provider_health.IMMEDIATE_TRIP_CLASSES`` —
#: and the tracker reports any class it has no explicit mapping for as
#: ``unavailable``, so no existing class's trip semantics change. It is never retried:
#: part of the answer was already shown.
FAILURE_STREAM_INTERRUPTED = "stream_interrupted"

#: Every code a provider failure may be reported as. Anything unrecognised
#: degrades to ``unavailable`` rather than leaking provider text.
PROVIDER_FAILURE_CLASSES = frozenset(
    {
        FAILURE_NOT_CONFIGURED,
        FAILURE_UNAUTHENTICATED,
        FAILURE_QUOTA,
        FAILURE_UNSUPPORTED,
        FAILURE_UNAVAILABLE,
        FAILURE_STREAM_INTERRUPTED,
    }
)


def estimate_message_tokens(messages: list[dict[str, str]]) -> int:
    """chars/4 of the message contents — the same arithmetic as the budget pre-flight.

    Used for the billed input of a call the provider never reported usage for (a
    cancelled or interrupted call), so the ledger never shows 0 input for a request
    that was actually sent. Public so the chat engine can label the same estimate."""
    chars = 0
    for message in messages or ():
        chars += len(str(message.get("content", ""))) if isinstance(message, dict) else 0
    return max(1, chars // 4)


def estimate_text_tokens(text_or_chars: str | int) -> int:
    """chars/4 of received text (0 for none; at least 1 once anything arrived)."""
    chars = text_or_chars if isinstance(text_or_chars, int) else len(text_or_chars or "")
    return max(1, chars // 4) if chars > 0 else 0


def _partial_usage(
    messages: list[dict[str, str]], progress: StreamProgress | None
) -> tuple[int, int, int, int]:
    """``(prompt, completion, cache_read, cache_write)`` for a call that ended without
    a result: the provider-reported input when the stream already reported it, else
    chars/4 of the messages; output is chars/4 of the text received so far."""
    if progress is not None and progress.prompt_tokens is not None:
        prompt = progress.prompt_tokens
        cache_read, cache_write = progress.cache_read_tokens, progress.cache_write_tokens
    else:
        prompt, cache_read, cache_write = estimate_message_tokens(messages), 0, 0
    completion = estimate_text_tokens(progress.received_chars if progress is not None else 0)
    return prompt, completion, cache_read, cache_write


def classify_provider_failure(exc: BaseException) -> str:
    """Map a provider exception onto one :data:`PROVIDER_FAILURE_CLASSES` literal.

    Pure and total: every input yields exactly one closed-vocabulary code, and no
    provider-supplied text is ever returned. ``ProviderError.status`` is populated by
    ``providers.classify_http_error``, so an HTTP 401/403 is distinguishable from a
    429 quota exhaustion and from a transport failure — which is the whole point:
    the incident's operator chased latency for days because a 401 was indistinguishable
    from a timeout.
    """
    if isinstance(exc, StreamInterrupted):
        # Checked first: the phase (after the first delta) is the diagnosis, whatever
        # status the underlying cause carried.
        return FAILURE_STREAM_INTERRUPTED
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


@dataclass
class UsageReceipt:
    """What the gateway ledgered for ONE ``complete``/``embed`` call, handed back
    through an object the CALLER owns (``usage_receipt=``).

    Why it exists: a caller that stops waiting (``asyncio.wait_for``, a chat step
    timeout) gets ``TimeoutError``/``CancelledError`` instead of a result, yet the
    gateway still writes an ``abandoned`` row carrying a real estimated cost (SPEC
    §6.3). Without this the caller can never learn that cost, so its own roll-up
    (``Case.token_cost``, a chat turn's ``TurnUsage``) silently sits below the ledger.
    The object is passed by reference, so it is shared with the gateway coroutine even
    when ``wait_for`` runs that coroutine in a task with a copied context.

    It is filled inside the ONE ledger write from the exact values of the row being
    written (never re-derived), immediately BEFORE the store write: the figures are
    final then, and a second cancellation that interrupts the write itself can only
    leave the caller's roll-up at or above the ledger, never below it. ``recorded``
    flips once the row was handed to the store. ``complete`` resets it on entry, so a
    call refused before any provider request (budget block, open breaker) leaves it
    empty — exactly like the ledger, which has no row for such a call.

    Token and cost fields SUM over the rows of the call: a completion writes exactly
    one row (#6); an embedding that fell back to local hashing writes an ERROR row and
    then the fallback's OK row. The descriptive fields (outcome, failure class, model,
    pricing source) are the LAST row's. Field names mirror ``UsageDoc``;
    :meth:`step_usage_fields` maps them onto the chat ``StepUsage`` contract."""

    #: Ledger rows built for this call (0 = refused before any provider request).
    rows: int = 0
    #: True once every built row was handed to the usage store.
    recorded: bool = False
    outcome: str = ""
    failure_class: str = ""
    model: str = ""
    #: The uncached, full-rate input (UsageDoc semantics: cache slices are separate).
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost: float = 0.0
    #: Gateway-measured wall time of the call (the longest row: every row of one call
    #: is timed from the same start, so summing would double count).
    latency_ms: int = 0
    pricing_source: str = ""
    #: Any count was a chars/4 estimate (provider omitted usage, or the call was
    #: cancelled/interrupted mid-answer). Carried here even while ``UsageDoc`` lacks
    #: the column, so a caller's meter can label the figure "≈" today.
    usage_estimated: bool = False
    #: HTTP requests the call made, including retries and fallback stages (the
    #: ledger's ``attempts`` column).
    attempts: int = 0
    #: Demo Mode: the cost is synthetic (pricing_source is ``zero``).
    simulated: bool = False

    def reset(self) -> None:
        """Return every field to its default (the gateway does this on entry)."""
        for name, default in _RECEIPT_DEFAULTS.items():
            setattr(self, name, default)

    def step_usage_fields(self) -> dict[str, Any]:
        """The ``StepUsage`` (SPEC §3.4) fields of a model call, so a meter built from
        the receipt matches the ledger row exactly. Kept as a plain mapping rather
        than a model instance so this low-level module never imports the chat
        contracts."""
        return {
            "input_tokens": self.prompt_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "output_tokens": self.completion_tokens,
            "cost": self.cost,
            "latency_ms": self.latency_ms,
            "estimated": self.usage_estimated,
        }

    def _absorb(self, doc: UsageDoc, *, usage_estimated: bool, simulated: bool) -> None:
        """Fold one ledger row (about to be written) into the receipt."""
        self.rows += 1
        self.recorded = False
        self.outcome = str(getattr(doc.outcome, "value", doc.outcome) or "")
        self.failure_class = doc.failure_class
        self.model = doc.model
        self.prompt_tokens += int(doc.prompt_tokens or 0)
        self.completion_tokens += int(doc.completion_tokens or 0)
        self.cache_read_tokens += int(doc.cache_read_tokens or 0)
        self.cache_write_tokens += int(doc.cache_write_tokens or 0)
        # Unrounded: a one-row receipt must equal the ledger row's cost bit for bit.
        self.cost += float(doc.cost or 0.0)
        self.latency_ms = max(self.latency_ms, int(doc.latency_ms or 0))
        self.pricing_source = doc.pricing_source
        self.usage_estimated = self.usage_estimated or bool(usage_estimated)
        # Max, not sum: an embedding's fallback row re-stamps the same request count
        # as the ERROR row before it, so adding them would double the requests made.
        self.attempts = max(self.attempts, int(doc.attempts or 0))
        self.simulated = self.simulated or bool(simulated)


_RECEIPT_DEFAULTS: dict[str, Any] = {
    name: field.default for name, field in UsageReceipt.__dataclass_fields__.items()
}


class _TextSink:
    """The ``on_text`` the gateway hands a provider: counts every delta for
    cancellation accounting, then relays it to the caller's callback.

    A failing caller callback is logged and further deltas are no longer relayed, but
    it never propagates into the provider: there it would be reported as a broken
    stream (``stream_interrupted``) and charged to the provider's health and breaker
    for a fault that is ours. The call still completes and returns its whole text.
    Cancellation (a ``BaseException``) is not caught and stops the call as usual."""

    def __init__(self, on_text: Callable[[str], Awaitable[None]],
                 progress: StreamProgress) -> None:
        self._on_text = on_text
        self._progress = progress
        self._relay = True

    async def __call__(self, delta: str) -> None:
        if not delta:
            return
        self._progress.received_chars += len(delta)
        if not self._relay:
            return
        try:
            await self._on_text(delta)
        except Exception:  # noqa: BLE001 — a consumer bug must not fail the model call
            self._relay = False
            logger.warning(
                "on_text callback failed; live text disabled for the rest of this call",
                exc_info=True,
            )


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
        on_text: Callable[[str], Awaitable[None]] | None = None,
        usage_receipt: UsageReceipt | None = None,
    ) -> CompletionResult:
        """Run one completion and ledger it (#6).

        ``on_text`` (chat Live text, SPEC §6.3) asks the provider to stream: each text
        delta is awaited through it as it arrives, and the return value is still the
        whole :class:`CompletionResult`. A provider that cannot stream delivers the
        whole text through it once. ``on_text=None`` is the historical blocking call,
        unchanged. Either way the same pre-flight, breaker, classification and single
        ledger write apply.

        ``usage_receipt`` (optional, caller-owned) is reset here and then filled with
        exactly what the ledger row records — on success, on a provider failure and on
        cancellation alike. It is how a caller that abandons the call through
        ``asyncio.wait_for`` still learns the cost the gateway ledgered for it."""
        if usage_receipt is not None:
            usage_receipt.reset()
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
        # Armed only for a streamed call; a blocking call keeps the historical path.
        progress: StreamProgress | None = None
        sink: _TextSink | None = None
        if on_text is not None:
            progress = begin_stream_progress()
            sink = _TextSink(on_text, progress)
        try:
            provider = self._provider(
                model_cfg.provider, model=model_cfg.model, endpoint=model_cfg,
                service_tier=service_tier,
                fallback_to_standard=fallback_to_standard,
            )
            if sink is None:
                result = await provider.complete(
                    role_str, messages, model_cfg.model, model_cfg.temperature,
                    model_cfg.max_tokens,
                )
            else:
                result = await self._complete_streamed(
                    provider, role_str, messages, model_cfg, sink
                )
        except asyncio.CancelledError:
            # The CALLER stopped waiting (its slice of the case time budget, the
            # pipeline's hard timeout, a chat step timeout or a factory reset) for a
            # request that was already in flight. The provider may well bill it, so #6
            # requires a row: without one the spend is invisible to the ledger, the cost
            # page and every budget rollup.
            #
            # The row carries the input the provider bills for an issued request — its
            # own count when a stream already reported it, else chars/4 of the messages
            # — and chars/4 of any text received, flagged estimated (SPEC §6.3). It used
            # to record 0/0, under-reporting spend for every abandoned call.
            #
            # ``CancelledError`` is a BaseException, so the ``except Exception`` below
            # never saw it. No provider failure is noted and no breaker key is touched:
            # our own deadline says nothing about the provider's health.
            latency = int((time.perf_counter() - started) * 1000)
            prompt_est, completion_est, cache_read_est, cache_write_est = _partial_usage(
                messages, progress
            )
            try:
                await self._record(
                    role_str, surface, case_id, model_cfg.model, prompt_est,
                    completion_est, latency, UsageOutcome.ERROR,
                    failure_class=FAILURE_ABANDONED, attempts=last_attempt_count(),
                    cache_read_tokens=cache_read_est, cache_write_tokens=cache_write_est,
                    usage_estimated=True, receipt=usage_receipt,
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
            # A stream that broke after its first delta was ANSWERING: the provider
            # bills its input and the output it sent, so that row carries the same
            # estimate as a cancelled call. Every other failure keeps the historical
            # 0/0 row (the request was refused or never completed a response).
            prompt_err = completion_err = cache_read_err = cache_write_err = 0
            interrupted = failure_class == FAILURE_STREAM_INTERRUPTED
            if interrupted:
                prompt_err, completion_err, cache_read_err, cache_write_err = _partial_usage(
                    messages, progress
                )
            await self._record(role_str, surface, case_id, model_cfg.model,
                               prompt_err, completion_err, latency,
                               UsageOutcome.ERROR, failure_class=failure_class,
                               attempts=attempts, cache_read_tokens=cache_read_err,
                               cache_write_tokens=cache_write_err,
                               usage_estimated=interrupted, receipt=usage_receipt)
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
        finally:
            if progress is not None:
                # Restores whatever tracker was armed before this call (by token), so
                # a streamed call nested inside another's ``on_text`` cannot disarm
                # the outer call's tracker.
                end_stream_progress(progress)

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
        price_src = await self._record(
            role_str, surface, case_id, model_used,
            result.prompt_tokens, result.completion_tokens, latency, UsageOutcome.OK, cost,
            cache_read_tokens=cache_read, cache_write_tokens=cache_write, batch=is_batch,
            processing_tier=processing_tier, attempts=attempts,
            usage_estimated=bool(getattr(result, "usage_estimated", False)),
            receipt=usage_receipt,
        )
        # Per-step usage for callers (the chat meter) without re-deriving either value:
        # the price provenance the ledger row was stamped with, and the latency it holds.
        result.pricing_source = price_src
        result.latency_ms = latency
        return result

    async def _complete_streamed(
        self, provider: BaseProvider, role: str, messages: list[dict[str, str]],
        model_cfg: ModelConfig, sink: _TextSink,
    ) -> CompletionResult:
        """Ask ``provider`` to stream into ``sink``. A duck-typed provider (an
        out-of-tree entry point that does not subclass ``BaseProvider``) without
        ``complete_stream`` gets the same one-shot behaviour as the default."""
        stream = getattr(provider, "complete_stream", None)
        if callable(stream):
            return await stream(
                role, messages, model_cfg.model, model_cfg.temperature,
                model_cfg.max_tokens, sink,
            )
        result = await provider.complete(
            role, messages, model_cfg.model, model_cfg.temperature, model_cfg.max_tokens
        )
        # Mirror ``BaseProvider.complete_stream``: report the finished call's own usage
        # before relaying, so a cancel during the relay ledgers the provider's exact
        # counts instead of a chars/4 estimate.
        note_stream_input_usage(
            getattr(result, "prompt_tokens", None),
            getattr(result, "cache_read_tokens", 0),
            getattr(result, "cache_write_tokens", 0),
        )
        if result.text:
            await sink(result.text)
        return result

    def text_streaming_supported(self, provider: Provider | str) -> bool:
        """Whether a completion on ``provider`` streams text incrementally (SPEC §6.3;
        ``/api/chat/context.text_streaming``).

        An injected or cached provider instance answers for itself (``streams_text``):
        that is what makes Demo Mode — every name mapped to the simulated-streaming
        DemoMockProvider — report Live text as available, and a test's MockProvider
        report it unavailable. Otherwise the name decides (openai, openai_compatible,
        anthropic). Never constructs a client, so it cannot fail on a missing key."""
        name = str(provider or "")
        instance = self._providers.get(name)
        if instance is not None:
            return bool(getattr(instance, "streams_text", False))
        return provider_streams_text(name)

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
        usage_receipt: UsageReceipt | None = None,
    ) -> list[list[float]]:
        """Back-compatible vector-only embedding API."""
        batch = await self.embed_with_provenance(
            texts, model_cfg, surface=surface, case_id=case_id,
            usage_receipt=usage_receipt,
        )
        return batch.vectors

    async def embed_with_provenance(
        self,
        texts: list[str],
        model_cfg: ModelConfig,
        *,
        surface: str = "rag",
        case_id: str | None = None,
        usage_receipt: UsageReceipt | None = None,
    ) -> EmbeddingBatch:
        """Embed ``texts`` through the provider (then the ledger, #6).

        ``usage_receipt`` works as on :meth:`complete` (reset, then filled from the
        ledger rows). An outage that falls back to local hashing writes two rows — the
        provider's ERROR row and the fallback's OK row — and the receipt sums them.

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
        if usage_receipt is not None:
            usage_receipt.reset()
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
                               failure_class=fallback_reason, receipt=usage_receipt)
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
                               attempts=last_attempt_count(), receipt=usage_receipt)
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
                           attempts=last_attempt_count(), receipt=usage_receipt)
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
        it RAISES :class:`BudgetBlocked` (a GatewayError: caller fails to NEEDS_HUMAN —
        never closes #3). Demo/mock / $0 models bypass the gate. Best-effort: a gate
        evaluation glitch never hard-blocks a call (logged) — the budget is
        governance, not a safety stop."""
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
            blocked = BudgetBlocked(f"budget ceiling exceeded: {reason}")
            blocked.reason = reason
            window = str(decision.get("window") or "")
            blocked.window = window if window in ("daily", "monthly") else ""
            raise blocked

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
        usage_estimated: bool = False,
        receipt: UsageReceipt | None = None,
    ) -> str:
        """Write the ONE UsageDoc for a call and return its ``pricing_source``.

        ``usage_estimated`` marks token counts the gateway or provider estimated
        (chars/4) rather than read from provider usage; it is persisted once the
        ledger contract carries the column (see :data:`_USAGE_DOC_HAS_ESTIMATED`).
        ``receipt`` (the caller's :class:`UsageReceipt`) absorbs the finished row just
        before the store write, so the caller's figures are the ledger's figures."""
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
        optional: dict[str, Any] = {}
        if _USAGE_DOC_HAS_ESTIMATED:
            optional["usage_estimated"] = bool(usage_estimated)
        doc = UsageDoc(
            **current_record_provenance(),
            **optional,
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
        if receipt is not None:
            # No await between building the row and this: the receipt can never miss a
            # row that reaches the store (see UsageReceipt on why it precedes the write).
            receipt._absorb(doc, usage_estimated=usage_estimated, simulated=self._demo)
        if require_persistence:
            await self._usage.write_strict(doc)
        else:
            await self._usage.write(doc)
        if receipt is not None:
            receipt.recorded = True
        return price_src

    def reset_providers(self) -> None:
        """Drop cached provider clients so new secret values take effect.
        (Used after the wizard updates keys at runtime.)"""
        self._providers = {}

    async def aclose(self) -> None:
        for provider in self._providers.values():
            await provider.aclose()
