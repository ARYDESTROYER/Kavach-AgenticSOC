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
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..utils import iso_now

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
    """Per-provider consecutive-failure tracking. Fail-open and never raises."""

    def __init__(self, *, threshold: int = DEFAULT_FAILURE_THRESHOLD) -> None:
        self._threshold = max(1, int(threshold))
        self._providers: dict[str, dict[str, Any]] = {}

    # ----------------------------- recording ------------------------------ #
    def record_success(
        self, provider: str, model: str = "", channel: str = CHANNEL_COMPLETION
    ) -> None:
        """A provider answered on ``channel``. Clears that channel's failure run."""
        if _ignored(provider, model):
            return
        row = self._row(provider, channel)
        row["last_attempt_at"] = row["last_success_at"] = iso_now()
        row["consecutive_failures"] = 0
        row["last_failure_class"] = ""

    def record_failure(
        self,
        provider: str,
        failure_class: str,
        model: str = "",
        channel: str = CHANNEL_COMPLETION,
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
        endpoint, prompt or provider response text is ever stored.
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
        }

    def reset(self) -> None:
        """Forget all tracked state (used by tiered reset)."""
        self._providers.clear()
