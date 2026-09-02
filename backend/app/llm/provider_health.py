"""Aggregate LLM/embedding provider health — the outage the ledger could not name.

A single failed model call is an ordinary per-case event: the pipeline fails that
case to a human and the ledger records one ``UsageOutcome.ERROR`` row. That is
correct behaviour and non-negotiable #3 is untouched by it.

What the product could not previously say is the AGGREGATE fact: *every* call is
failing, and has been for days. During the incident this module exists for, an
expired key produced 401 on every completion and every embedding call. Each one was
handled correctly in isolation, so no single surface was wrong — and the deployment
reported itself healthy while auto-close sat at 0% for three days.

This tracker is deliberately minimal:

* **In-process and advisory.** It is owned by ``AppState`` (so it survives the
  ``_wire()`` rebuilds that replace the gateway) and is NEVER read by
  ``case_manager.decide()`` (#3). It is observability, not control flow.
* **Closed vocabulary only.** It stores the failure CLASS
  (``gateway.PROVIDER_FAILURE_CLASSES``), never provider response text, never a key,
  never a prompt. Provider error bodies are attacker-influenceable UNTRUSTED DATA (#9).
* **Consecutive, not cumulative.** One transient 500 in a healthy week is not an
  outage; ``consecutive_failures`` resets on the first success, so only a SUSTAINED
  condition crosses the threshold.
* **Free.** Recording is pure in-memory bookkeeping on a call that already happened.
  It adds no ledger row (#6 — the row count per call is unchanged) and no probe.

Since the circuit-breaker work this module ALSO decides, per key, whether the next
call should be attempted at all (see :class:`ProviderHealth.allows`). That decision
ships in ADVISORY mode: the state machine runs and every transition is recorded, but
``ResilienceConfig.enforce`` defaults to ``False`` so nothing is refused until an
operator has read real transitions from their own deployment. Refusal, once enabled,
can only ever route a case to NEEDS_HUMAN — it never closes, escalates or discards one
(#3/#4), and it never writes a ledger row of its own (#6).
"""

from __future__ import annotations

import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from ..utils import iso_now

logger = logging.getLogger("tlsoc.llm.provider_health")

#: How long a failure run stays evidence of a CURRENT outage.
#:
#: The tracker asserts a live condition, not a permanent verdict. Without a bound, a
#: provider that crossed the threshold and was then decommissioned (or simply never
#: called again) would pin the deployment to "degraded" until the process restarted,
#: with no operator action able to clear it. Aging the evidence out makes the signal
#: self-clearing and keeps it honest: old failures are not proof of a present fault.
STALE_AFTER_SECONDS = 3600

#: Consecutive failures of ONE class before that provider is reported unhealthy.
#: A small integer on purpose: the failure modes worth surfacing (an expired key, a
#: revoked key, an exhausted quota) are total and immediate, so waiting longer only
#: extends the blind window the incident was made of.
DEFAULT_FAILURE_THRESHOLD = 3

#: Health states, most severe first. ``ok`` is the absence of a crossed threshold.
STATE_OK = "ok"
STATE_UNAUTHENTICATED = "unauthenticated"
STATE_QUOTA_EXHAUSTED = "quota_exhausted"
STATE_UNAVAILABLE = "unavailable"
STATE_UNSUPPORTED = "unsupported"

# Failure class (from the gateway's closed vocabulary) -> reported health state.
# ``not_configured`` is absent by design: a deployment with no key is running the
# supported keyless profile, not an outage, and must never read as degraded.
_CLASS_TO_STATE = {
    "unauthenticated": STATE_UNAUTHENTICATED,
    "quota": STATE_QUOTA_EXHAUSTED,
    "unsupported": STATE_UNSUPPORTED,
    "unavailable": STATE_UNAVAILABLE,
}

# Providers whose failures are structurally uninteresting: the deterministic mock
# backs the offline test profile and Demo Mode, where "the provider is down" is not
# a meaningful statement. Mirrors the budget pre-flight's existing exclusion.
_IGNORED_PROVIDERS = frozenset({"mock", "demo"})


# The two independently-credentialed call channels. ``Secrets.embedding_api_key`` may
# differ from the completion key for the SAME provider, so a revoked embedding key
# while completions still succeed is a real and reachable state — and is precisely the
# shape of the incident this module exists for. Tracking one counter per provider let
# successful completions cancel out the embedding outage, so the condition could never
# cross its threshold. They are counted separately.
CHANNEL_COMPLETION = "completion"
CHANNEL_EMBEDDING = "embedding"


# --------------------------------------------------------------------------- #
# Circuit breaker — count-based, per (provider, channel, role, model).
# --------------------------------------------------------------------------- #
# States follow the published Resilience4j vocabulary
# (https://resilience4j.readme.io/docs/circuitbreaker).
BREAKER_CLOSED = "closed"
BREAKER_OPEN = "open"
BREAKER_HALF_OPEN = "half_open"

#: Defaults MIRRORED from ``config.ResilienceConfig`` so this module stays importable
#: without it (it is handed a duck-typed policy object). ``tests`` pin the two sets
#: equal, so a change to one that forgets the other fails the suite rather than
#: silently giving an unwired deployment different behaviour from a wired one.
BREAKER_WINDOW_SIZE = 20
BREAKER_MINIMUM_CALLS = 10
BREAKER_FAILURE_RATE_THRESHOLD = 0.5
BREAKER_WAIT_SECONDS = 60.0
BREAKER_MAX_WAIT_SECONDS = 600.0
BREAKER_HALF_OPEN_SUCCESSES = 2
BREAKER_OUTCOME_MAX_AGE_SECONDS = 3600.0

#: The ONLY two failure classes that trip a breaker on their first observation,
#: without waiting for a window quorum.
#:
#: * ``unauthenticated`` (401/403) never self-heals: a rejected credential rejects the
#:   next call too, so spending the quorum is pure waste.
#: * ``quota`` reaches the gateway only after the bounded retry budget was actually
#:   spent (see ``providers.with_retry``), so it already represents a sustained refusal.
#:
#: ``unsupported`` is deliberately EXCLUDED even though it is equally permanent. In this
#: system's own history "unsupported" has meant an operator typo — a chat model pasted
#: into the embedding slot. Immediate-tripping it would refuse the call, and a refused
#: call writes no ledger row, erasing the per-call error rows that are the only durable
#: evidence the misconfiguration ever happened. The operator would be left with a silent
#: dead role and nothing to read. It still counts as an ordinary window failure.
#: ``not_configured`` is not a failure at all (the supported keyless profile) and is
#: rejected before it reaches this module.
IMMEDIATE_TRIP_CLASSES = frozenset({"unauthenticated", "quota"})

#: Cap on distinct breaker keys held in memory.
#:
#: Keys are normally bounded by configuration — a handful of providers x 2 channels x
#: the configured roles and models. But the model-test surface accepts an arbitrary
#: operator-typed model id, so a long-lived process could otherwise accumulate one row
#: per typo forever. Eviction only ever removes a CLOSED row (a non-CLOSED one is live
#: safety state), preferring the one with the least evidence behind it.
MAX_BREAKER_KEYS = 500

#: Bounded, append-only in-process transition log. Advisory mode's entire product value
#: is that an operator can read what the breaker WOULD have refused, so the transitions
#: are kept and exposed even while ``enforce`` is off.
MAX_TRANSITIONS = 200

#: Reason codes for a transition/refusal. Closed vocabulary — never provider text (#9).
REASON_IMMEDIATE = "immediate_trip"
REASON_FAILURE_RATE = "failure_rate"
REASON_PROBE_FAILED = "probe_failed"
REASON_PROBE_SUCCEEDED = "probe_succeeded"
REASON_WAIT_ELAPSED = "wait_elapsed"
#: The key has been SILENT for longer than ``outcome_max_age_seconds``, so the run of
#: outcomes behind its state is no longer evidence of a CURRENT condition. Reached from
#: the READ paths as well as on write, because a decommissioned key by definition
#: receives no further outcomes and would otherwise assert an outage nobody can clear.
REASON_EVIDENCE_AGED_OUT = "evidence_aged_out"
#: A SUCCESS observed on a key that is still OPEN. It can only come from a call the
#: breaker did not gate — the operator's model test, or advisory mode, where every call
#: proceeds. Treating it as a probe is what lets an open key recover at all in advisory
#: mode; without it the first trip would pin the key open for the life of the process
#: and the transition log would stop being useful after one entry.
REASON_OBSERVED_SUCCESS = "observed_success"

#: Scope of a breaker key. ``role`` is the fine key that separates a failing router from
#: a healthy investigator on the SAME model and channel; ``provider`` is the coarse key
#: an immediate-trip class uses, because a rejected credential is not role-specific.
SCOPE_ROLE = "role"
SCOPE_PROVIDER = "provider"


def _breaker_key(provider: str, channel: str, role: str, model: str) -> str:
    return f"{provider or 'unknown'}:{channel or CHANNEL_COMPLETION}:{role or '*'}:{model or '*'}"


def _coarse_key(provider: str, channel: str) -> str:
    return _breaker_key(provider, channel, "*", "*")


def _pget(policy: Any, name: str, default: Any) -> Any:
    """Read one duck-typed policy attribute, falling back to the mirrored default.

    The policy is whatever the gateway was handed (a ``ResilienceConfig``, or nothing
    at all when the wiring has not supplied one). Reading it defensively keeps this
    module free of a ``config`` import and keeps an unwired deployment on the exact
    advisory defaults rather than on no breaker at all.
    """
    if policy is None:
        return default
    value = getattr(policy, name, None)
    return default if value is None else value


def _ignored(provider: str, model: str) -> bool:
    return str(provider).lower() in _IGNORED_PROVIDERS or str(model).startswith("mock")


def _key(provider: str, channel: str) -> str:
    return f"{provider or 'unknown'}:{channel or CHANNEL_COMPLETION}"


def _age_seconds(stamp: str) -> float:
    """Seconds since ``stamp``, or ``inf`` when it cannot be read (treat as stale)."""
    if not stamp:
        return float("inf")
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return float("inf")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds())


class ProviderHealth:
    """Per-provider consecutive-failure tracking plus the circuit breaker.

    Fail-open and never raises: every public method swallows its own errors, because
    observability and admission control must not be able to drop an alert.
    """

    def __init__(
        self, *, threshold: int = DEFAULT_FAILURE_THRESHOLD, policy: Any = None
    ) -> None:
        self._threshold = max(1, int(threshold))
        self._providers: dict[str, dict[str, Any]] = {}
        # Circuit-breaker state, keyed independently of ``_providers`` so the historical
        # health snapshot is byte-identical whether or not a breaker ever trips.
        self._breakers: dict[str, dict[str, Any]] = {}
        self._transitions: list[dict[str, Any]] = []
        # Duck-typed ``ResilienceConfig``. ``None`` means "nothing wired it", which is
        # the shipped advisory posture: observe on the mirrored defaults, refuse nothing.
        self._policy: Any = policy

    # ------------------------------- policy ------------------------------- #
    def set_policy(self, policy: Any) -> None:
        """Point the breaker at the live operator policy. Idempotent and free."""
        self._policy = policy

    @property
    def enforcing(self) -> bool:
        """True only when an operator has explicitly enabled refusal."""
        return bool(_pget(self._policy, "enabled", True)) and bool(
            _pget(self._policy, "enforce", False)
        )

    def _observing(self) -> bool:
        return bool(_pget(self._policy, "enabled", True))

    # ----------------------------- recording ------------------------------ #
    def record_success(
        self,
        provider: str,
        model: str = "",
        channel: str = CHANNEL_COMPLETION,
        *,
        role: str = "",
    ) -> None:
        """A provider answered on ``channel``. Clears that channel's failure run."""
        if _ignored(provider, model):
            return
        row = self._row(provider, channel)
        row["last_attempt_at"] = row["last_success_at"] = iso_now()
        row["consecutive_failures"] = 0
        row["last_failure_class"] = ""
        self._record_outcome(provider, channel, role, model, ok=True, failure_class="")

    def record_failure(
        self,
        provider: str,
        failure_class: str,
        model: str = "",
        channel: str = CHANNEL_COMPLETION,
        *,
        role: str = "",
    ) -> None:
        """A call failed with one closed-vocabulary ``failure_class``.

        ``not_configured`` is recorded as a no-op: it means the operator never
        supplied a key, which is a configuration choice rather than a fault.
        """
        if _ignored(provider, model) or failure_class == "not_configured":
            return
        row = self._row(provider, channel)
        row["last_attempt_at"] = iso_now()
        # A CHANGE of failure class does not reset the run. A provider alternating
        # 401 and 429 is still totally failing, and zeroing the count on every switch
        # meant such an outage reported "ok" indefinitely. The run counts consecutive
        # FAILURES; only a success clears it. The reported class is the newest one.
        row["last_failure_class"] = str(failure_class)
        row["consecutive_failures"] = int(row.get("consecutive_failures", 0)) + 1
        row["last_failure_at"] = row["last_attempt_at"]
        self._record_outcome(
            provider, channel, role, model, ok=False, failure_class=str(failure_class)
        )

    def _row(self, provider: str, channel: str = CHANNEL_COMPLETION) -> dict[str, Any]:
        key = _key(str(provider or "unknown"), str(channel))
        row = self._providers.get(key)
        if row is None:
            row = {
                "provider": str(provider or "unknown"),
                "channel": str(channel or CHANNEL_COMPLETION),
                "consecutive_failures": 0,
                "last_failure_class": "",
                "last_attempt_at": "",
                "last_success_at": "",
                "last_failure_at": "",
            }
            self._providers[key] = row
        return row

    # ------------------------------ reading ------------------------------- #
    def state_for(self, provider: str, channel: str = CHANNEL_COMPLETION) -> str:
        """The state for one provider+channel: ``ok`` until the threshold is crossed.

        A crossed threshold whose most recent failure is older than
        :data:`STALE_AFTER_SECONDS` reports ``ok`` again: it is stale evidence, not a
        present outage, and a live provider is failing often enough to keep the signal
        fresh on its own.
        """
        row = self._providers.get(_key(str(provider or "unknown"), str(channel)))
        if not row:
            return STATE_OK
        if int(row.get("consecutive_failures", 0)) < self._threshold:
            return STATE_OK
        if _age_seconds(str(row.get("last_failure_at") or "")) > STALE_AFTER_SECONDS:
            return STATE_OK
        return _CLASS_TO_STATE.get(str(row.get("last_failure_class") or ""), STATE_UNAVAILABLE)

    def snapshot(self) -> dict[str, Any]:
        """A JSON-safe read of every tracked provider plus the worst active state.

        ``degraded`` is the single boolean a health surface needs; ``providers`` is
        the per-provider detail an RBAC-gated diagnostics surface may show. Nothing
        here is secret: provider NAMES are already public configuration, and no key,
        endpoint, prompt or provider response text is ever stored. The additive
        ``breaker`` block widens that to ROLE and MODEL names, which are likewise
        operator configuration already visible in settings and in the usage ledger.
        """
        providers: dict[str, Any] = {}
        worst = STATE_OK
        for name, row in sorted(self._providers.items()):
            state = self.state_for(row.get("provider", ""), row.get("channel", ""))
            providers[name] = {**row, "state": state, "threshold": self._threshold}
            if state != STATE_OK and worst == STATE_OK:
                worst = state
            elif state == STATE_UNAUTHENTICATED:
                # An auth failure is the most actionable condition; prefer it.
                worst = STATE_UNAUTHENTICATED
        return {
            "state": worst,
            "degraded": worst != STATE_OK,
            "threshold": self._threshold,
            "providers": providers,
            # Additive: the diagnostics surface spreads this snapshot verbatim, so the
            # breaker's state and its transition log reach an operator without any
            # route change. Every existing key above keeps its exact meaning.
            "breaker": self.breaker_snapshot(),
        }

    def reset(self) -> None:
        """Forget all tracked state (used by tiered reset)."""
        self._providers.clear()
        self._breakers.clear()
        self._transitions.clear()

    # ===================================================================== #
    # Circuit breaker
    # ===================================================================== #
    def allows(
        self,
        provider: str,
        channel: str = CHANNEL_COMPLETION,
        role: str = "",
        model: str = "",
    ) -> tuple[bool, str, str]:
        """May the next call on this key be attempted?

        Returns ``(allowed, reason, failure_class)``. ``reason`` and ``failure_class``
        are closed-vocabulary strings — never provider response text (#9).

        ADVISORY MODE IS ENFORCED HERE, not by the caller: with ``enforce`` off this
        always returns ``True``, so no future call site can accidentally start refusing
        work. The OPEN → HALF_OPEN clock still runs either way, because an advisory
        deployment must be able to observe a full recovery cycle — otherwise the first
        trip would pin the key open for the life of the process and the transition log
        an operator is meant to read would stop after one entry.

        The caller decides what to DO with a ``False``: the completion path raises
        before any provider call and before any ledger write, the embedding path
        degrades to local hashing and never raises. It never raises: a breaker bug must
        not be able to drop an alert.
        """
        try:
            if not self._observing():
                return True, "", ""
            if _ignored(provider, model):
                return True, "", ""
            enforcing = self.enforcing
            now = time.monotonic()
            refusal: tuple[str, str] | None = None
            # The coarse key is examined FIRST: a rejected credential is not specific to
            # one role, so reporting the role key would name the wrong thing. Both keys
            # are visited even after a refusal is found, so each one's clock advances.
            for key in (
                _coarse_key(str(provider), str(channel)),
                _breaker_key(str(provider), str(channel), str(role), str(model)),
            ):
                row = self._breakers.get(key)
                if row is None:
                    continue
                # Age the evidence on READ too: a key that stopped being called must
                # drain and clear itself rather than refuse work on a dead outage.
                self._settle(row, now=now)
                if row["state"] == BREAKER_CLOSED:
                    continue
                if row["state"] == BREAKER_OPEN:
                    if now >= float(row.get("open_until", 0.0)):
                        # The jittered wait elapsed: permit ONE probe class of calls.
                        self._transition(row, BREAKER_HALF_OPEN, REASON_WAIT_ELAPSED)
                        continue
                    if refusal is None:
                        refusal = (
                            str(row.get("open_reason") or REASON_FAILURE_RATE),
                            str(row.get("trip_class") or ""),
                        )
                    continue
                # HALF_OPEN: probes are permitted. A dead provider fails its first probe
                # and returns to OPEN with a doubled wait, so at most a small number of
                # probes escape per wait window. Counting in-flight probes instead would
                # need a decrement on every exit path, and a leaked counter would block
                # recovery permanently — the worse failure for an advisory feature.
            if refusal is not None and enforcing:
                return False, refusal[0], refusal[1]
            return True, "", ""
        except Exception:  # noqa: BLE001 — the breaker must never break a call
            logger.debug("breaker admission check failed; allowing", exc_info=True)
            return True, "", ""

    def breaker_state(
        self,
        provider: str,
        channel: str = CHANNEL_COMPLETION,
        role: str = "",
        model: str = "",
    ) -> str:
        """The state of the FINE key, or of the coarse key when it is the more severe."""
        now = time.monotonic()
        for key in (
            _coarse_key(str(provider), str(channel)),
            _breaker_key(str(provider), str(channel), str(role), str(model)),
        ):
            row = self._breakers.get(key)
            if row is None:
                continue
            self._settle(row, now=now)
            if row["state"] != BREAKER_CLOSED:
                return str(row["state"])
        return BREAKER_CLOSED

    def transitions(self) -> list[dict[str, Any]]:
        """The bounded append-only transition log, oldest first. JSON-safe."""
        return [dict(entry) for entry in self._transitions]

    # ---------------------------- internals ------------------------------- #
    def _record_outcome(
        self,
        provider: str,
        channel: str,
        role: str,
        model: str,
        *,
        ok: bool,
        failure_class: str,
    ) -> None:
        """Fold one TERMINAL outcome into the fine and coarse breakers. Never raises."""
        try:
            if not self._observing():
                return
            now = time.monotonic()
            fine = _breaker_key(str(provider), str(channel), str(role), str(model))
            coarse = _coarse_key(str(provider), str(channel))
            immediate = (not ok) and failure_class in IMMEDIATE_TRIP_CLASSES
            for key, scope in ((coarse, SCOPE_PROVIDER), (fine, SCOPE_ROLE)):
                row = self._breaker_row(
                    key, scope, str(provider), str(channel),
                    "*" if scope == SCOPE_PROVIDER else str(role),
                    "*" if scope == SCOPE_PROVIDER else str(model),
                )
                # The two keys answer two different questions and must not borrow each
                # other's evidence:
                #  * the COARSE key answers "is this credential/channel dead?" — a
                #    terminal class only. It deliberately does NOT evaluate a failure
                #    RATE, because a rate pooled across roles is exactly the pooling
                #    that hides a failing router behind a healthy investigator, and in
                #    reverse would refuse the healthy role once the mix crossed 50%.
                #  * the FINE key answers "is THIS (role, model) failing?" — the rate.
                self._fold(
                    row, now=now, ok=ok, failure_class=failure_class,
                    immediate=immediate and scope == SCOPE_PROVIDER,
                    evaluate_rate=(scope == SCOPE_ROLE),
                )
        except Exception:  # noqa: BLE001 — observability must never surface an error
            logger.debug("breaker outcome fold failed", exc_info=True)

    def _fold(
        self,
        row: dict[str, Any],
        *,
        now: float,
        ok: bool,
        failure_class: str,
        immediate: bool,
        evaluate_rate: bool = True,
    ) -> None:
        # Age the key's evidence BEFORE the new outcome is folded in, so a burst that
        # ended hours ago is never counted alongside the sample that just arrived.
        self._settle(row, now=now)
        if row["state"] == BREAKER_HALF_OPEN:
            # A HALF_OPEN outcome is a PROBE result, not a window sample: it decides
            # recovery, and mixing it into the ring would let two probe successes dilute
            # a window that is still full of the outage.
            if ok:
                self._probe_succeeded(row)
            else:
                # Any probe failure re-opens with the wait DOUBLED and capped, so a
                # provider that stays down is retried ever less often.
                row["wait_seconds"] = min(
                    self._max_wait_seconds(),
                    max(1.0, float(row.get("wait_seconds", self._wait_seconds()))) * 2.0,
                )
                row["trip_class"] = failure_class or str(row.get("trip_class") or "")
                self._open(row, now=now, reason=REASON_PROBE_FAILED)
            return

        window: list[tuple[float, bool]] = row["window"]
        window.append((now, bool(ok)))
        self._trim(row)
        # RE-READ the ring after trimming. The trip decision below must score the exact
        # evidence the row holds and ``breaker_snapshot()`` reports; scoring a pre-trim
        # alias instead is how a key whose quorum is 10 once opened on a window of 1.
        window = row["window"]

        if row["state"] == BREAKER_OPEN:
            # An outcome recorded while OPEN means the call happened anyway: advisory
            # mode, a surface that bypasses the breaker (the operator's model test), or
            # a probe that raced the clock. A SUCCESS in that position is exactly the
            # evidence HALF_OPEN exists to collect — treating it as one is what lets an
            # operator's own credential fix clear the breaker, and what stops an advisory
            # deployment from pinning a key open for the life of the process.
            if ok:
                row["half_open_successes"] = 0
                self._transition(row, BREAKER_HALF_OPEN, REASON_OBSERVED_SUCCESS)
                self._probe_succeeded(row)
            return

        if immediate:
            row["trip_class"] = failure_class
            self._open(row, now=now, reason=REASON_IMMEDIATE)
            return

        quorum = self._quorum()
        if not evaluate_rate or len(window) < quorum:
            return
        failures = sum(1 for _, sample_ok in window if not sample_ok)
        rate = failures / float(len(window))
        if rate >= self._failure_rate_threshold():
            row["trip_class"] = failure_class or str(row.get("trip_class") or "")
            row["failure_rate"] = round(rate, 4)
            self._open(row, now=now, reason=REASON_FAILURE_RATE)

    def _probe_succeeded(self, row: dict[str, Any]) -> None:
        """Count one probe success and CLOSE once the required run is reached.

        The window is emptied on close so the outage that opened the key cannot
        immediately re-open it on the very next sample.
        """
        row["half_open_successes"] = int(row.get("half_open_successes", 0)) + 1
        if row["half_open_successes"] < self._half_open_successes():
            return
        row["window"] = []
        row["wait_seconds"] = self._wait_seconds()
        self._transition(row, BREAKER_CLOSED, REASON_PROBE_SUCCEEDED)

    def _open(self, row: dict[str, Any], *, now: float, reason: str) -> None:
        wait = max(1.0, float(row.get("wait_seconds", self._wait_seconds())))
        # FULL JITTER (AWS Architecture Blog, "Exponential Backoff And Jitter", 2015):
        # sleep is uniform over [0, wait), not wait itself, so many independently
        # tripped keys do not resynchronise into a thundering probe herd.
        row["open_until"] = now + random.uniform(0.0, wait)
        row["open_reason"] = reason
        row["half_open_successes"] = 0
        row["opens"] = int(row.get("opens", 0)) + 1
        self._transition(row, BREAKER_OPEN, reason)

    def _transition(self, row: dict[str, Any], to_state: str, reason: str) -> None:
        previous = str(row.get("state") or BREAKER_CLOSED)
        row["state"] = to_state
        row["last_transition_at"] = iso_now()
        if to_state != BREAKER_OPEN:
            row["open_until"] = 0.0
        if to_state == BREAKER_CLOSED:
            row["open_reason"] = ""
            row["trip_class"] = ""
        if previous == to_state:
            return
        entry = {
            "at": row["last_transition_at"],
            "key": row["key"],
            "scope": row["scope"],
            "provider": row["provider"],
            "channel": row["channel"],
            "role": row["role"],
            "model": row["model"],
            "from": previous,
            "to": to_state,
            "reason": reason,
            "failure_class": str(row.get("trip_class") or ""),
            "samples": len(row["window"]),
            "failure_rate": row.get("failure_rate"),
            "wait_seconds": round(float(row.get("wait_seconds", 0.0)), 3),
            "enforced": self.enforcing,
        }
        # Append-only within a bound: the oldest entry is dropped, never rewritten.
        self._transitions.append(entry)
        if len(self._transitions) > MAX_TRANSITIONS:
            del self._transitions[: len(self._transitions) - MAX_TRANSITIONS]
        logger.warning(
            "provider circuit breaker %s: %s -> %s (reason=%s class=%s samples=%d "
            "enforced=%s)",
            entry["key"], previous, to_state, reason,
            entry["failure_class"] or "none", entry["samples"], entry["enforced"],
        )

    def _trim(self, row: dict[str, Any]) -> None:
        """Bound the ring to the last ``window_size`` outcomes. COUNT only.

        Mutates the list IN PLACE: the caller holds a reference to it, and rebinding
        ``row["window"]`` here is exactly how the trip evaluation once scored a window
        the row no longer held.
        """
        size = self._window_size()
        window: list[tuple[float, bool]] = row["window"]
        if len(window) > size:
            del window[: len(window) - size]

    def _settle(self, row: dict[str, Any], *, now: float) -> None:
        """Age a key's evidence, and let a key nobody calls any more clear itself.

        ``outcome_max_age_seconds`` bounds how long a run of outcomes stays evidence of
        a CURRENT condition. It is applied as an IDLE GAP, never as a per-sample expiry:
        while calls keep arriving the ring simply keeps the last ``window_size``
        outcomes, and the accumulated evidence is discarded WHOLESALE once the key has
        been silent for longer than the bound.

        The distinction is the whole reason the window is counted rather than timed. A
        per-sample expiry drains the ring faster than a modest deployment fills it: with
        the shipped sizes the quorum becomes unreachable below roughly
        ``minimum_calls / outcome_max_age_seconds`` calls per second — about 240 calls a
        day on ONE (provider, channel, role, model) key — so the failure-rate arm would
        be dead at exactly the deployment sizes a count window exists to serve. As an
        idle gap the arm is reachable at any volume that calls the key at all inside the
        bound, while two failures SEPARATED BY MORE than the bound still never pool into
        one verdict.

        Because this also runs on READ, a decommissioned provider/model/role key really
        does drain and stop asserting an outage nobody can clear. A drained key returns
        to CLOSED — but never before its OPEN wait has elapsed, so silence can never
        shorten the back-off (``outcome_max_age_seconds`` may be configured below
        ``wait_seconds``).
        """
        window: list[tuple[float, bool]] = row["window"]
        if window and (now - window[-1][0]) > self._outcome_max_age():
            row["window"] = []
            row["failure_rate"] = None
        if (
            not row["window"]
            and row["state"] != BREAKER_CLOSED
            and now >= float(row.get("open_until", 0.0))
        ):
            # The escalated wait is reset HERE and not on the drain itself: a key that
            # is still OPEN keeps the back-off it earned, so going quiet under an outage
            # cannot buy a shorter retry interval. Once it closes there is no evidence
            # left to back off from, so it starts over — exactly like a probe recovery.
            row["wait_seconds"] = self._wait_seconds()
            row["half_open_successes"] = 0
            self._transition(row, BREAKER_CLOSED, REASON_EVIDENCE_AGED_OUT)

    def _evict_if_needed(self) -> None:
        """Keep the key registry bounded, never at the cost of live safety state."""
        if len(self._breakers) < MAX_BREAKER_KEYS:
            return
        closed = [
            (len(row["window"]), key)
            for key, row in self._breakers.items()
            if row["state"] == BREAKER_CLOSED
        ]
        if not closed:
            # Every key is OPEN or HALF_OPEN. Dropping one would silently re-admit a
            # provider we just refused, so the bound yields to correctness here.
            logger.warning(
                "provider breaker registry at %d keys and none are closed; not evicting",
                len(self._breakers),
            )
            return
        closed.sort()
        for _, key in closed[: max(1, len(self._breakers) - MAX_BREAKER_KEYS + 1)]:
            self._breakers.pop(key, None)

    def _breaker_row(
        self, key: str, scope: str, provider: str, channel: str, role: str, model: str
    ) -> dict[str, Any]:
        row = self._breakers.get(key)
        if row is None:
            self._evict_if_needed()
            row = {
                "key": key,
                "scope": scope,
                "provider": provider or "unknown",
                "channel": channel or CHANNEL_COMPLETION,
                "role": role or "*",
                "model": model or "*",
                "state": BREAKER_CLOSED,
                "window": [],
                "open_until": 0.0,
                "open_reason": "",
                "trip_class": "",
                "wait_seconds": self._wait_seconds(),
                "half_open_successes": 0,
                "opens": 0,
                "failure_rate": None,
                "last_transition_at": "",
            }
            self._breakers[key] = row
        return row

    # ---- policy readers (duck-typed; mirrored defaults when nothing is wired) ---- #
    def _window_size(self) -> int:
        return max(2, int(_pget(self._policy, "window_size", BREAKER_WINDOW_SIZE)))

    def _quorum(self) -> int:
        """The evaluation quorum: no verdict until this many outcomes are in the ring.

        Upstream Resilience4j sets ``slidingWindowSize == minimumNumberOfCalls`` (both
        100), so "the window is filled" and "the minimum call count is met" are one
        condition there. We keep both knobs and take the BINDING one, which is what a
        smaller ring than quorum would otherwise make unreachable.
        """
        minimum = max(1, int(_pget(self._policy, "minimum_calls", BREAKER_MINIMUM_CALLS)))
        return min(minimum, self._window_size())

    def _failure_rate_threshold(self) -> float:
        value = float(
            _pget(self._policy, "failure_rate_threshold", BREAKER_FAILURE_RATE_THRESHOLD)
        )
        # Hard product floor, enforced here as well as in the config field: below 0.50 a
        # breaker refuses more work than it protects (at 25% observed failure it would
        # refuse 100% of calls that would have succeeded 75% of the time).
        return min(1.0, max(0.5, value))

    def _wait_seconds(self) -> float:
        return max(1.0, float(_pget(self._policy, "wait_seconds", BREAKER_WAIT_SECONDS)))

    def _max_wait_seconds(self) -> float:
        return max(
            self._wait_seconds(),
            float(_pget(self._policy, "max_wait_seconds", BREAKER_MAX_WAIT_SECONDS)),
        )

    def _half_open_successes(self) -> int:
        return max(
            1, int(_pget(self._policy, "half_open_successes", BREAKER_HALF_OPEN_SUCCESSES))
        )

    def _outcome_max_age(self) -> float:
        return max(
            1.0,
            float(
                _pget(
                    self._policy,
                    "outcome_max_age_seconds",
                    BREAKER_OUTCOME_MAX_AGE_SECONDS,
                )
            ),
        )

    #: How many transitions the embedded snapshot carries. ``/api/health`` reads this
    #: snapshot on every poll and only wants ``state``, so the full log is not copied
    #: there; ``transitions()`` returns all of it for a diagnostics surface.
    SNAPSHOT_TRANSITIONS = 25

    def breaker_snapshot(self, transition_limit: int | None = None) -> dict[str, Any]:
        """JSON-safe breaker state + the tail of the append-only transition log.

        ``enforced`` is the single boolean that tells an operator whether what they are
        reading actually refused anything or merely would have.
        """
        limit = self.SNAPSHOT_TRANSITIONS if transition_limit is None else transition_limit
        # Age every key's evidence first, so ``open_keys``/``samples``/``failure_rate``
        # describe the PRESENT rather than an outage that ended weeks ago. Without it a
        # decommissioned key is named here forever: ``_settle`` is otherwise only
        # reached by a new outcome, and a decommissioned key receives none.
        now = time.monotonic()
        for row in list(self._breakers.values()):
            self._settle(row, now=now)
        keys: dict[str, Any] = {}
        for key, row in sorted(self._breakers.items()):
            window = row["window"]
            failures = sum(1 for _, ok in window if not ok)
            keys[key] = {
                "scope": row["scope"],
                "provider": row["provider"],
                "channel": row["channel"],
                "role": row["role"],
                "model": row["model"],
                "state": row["state"],
                "samples": len(window),
                "failures": failures,
                "failure_rate": round(failures / len(window), 4) if window else None,
                "opens": int(row.get("opens", 0)),
                "failure_class": str(row.get("trip_class") or ""),
                "open_reason": str(row.get("open_reason") or ""),
                "wait_seconds": round(float(row.get("wait_seconds", 0.0)), 3),
                "last_transition_at": str(row.get("last_transition_at") or ""),
            }
        return {
            "enabled": self._observing(),
            "enforced": self.enforcing,
            "policy": {
                "window_size": self._window_size(),
                "minimum_calls": self._quorum(),
                "failure_rate_threshold": self._failure_rate_threshold(),
                "wait_seconds": self._wait_seconds(),
                "max_wait_seconds": self._max_wait_seconds(),
                "half_open_successes": self._half_open_successes(),
                "outcome_max_age_seconds": self._outcome_max_age(),
                "immediate_trip_classes": sorted(IMMEDIATE_TRIP_CLASSES),
            },
            "open_keys": sorted(
                key for key, row in self._breakers.items()
                if row["state"] != BREAKER_CLOSED
            ),
            "keys": keys,
            "transitions_total": len(self._transitions),
            "transitions": [dict(entry) for entry in self._transitions[-limit:]]
            if limit > 0 else [],
        }
