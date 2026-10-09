"""Round 3 — Wave 5: isolation + ledger-reconciliation regressions.

Two surgical invariants locked here (both ADDITIVE, both proven by a pre-fix failure):

* **Demo Mode event isolation** — a demo investigation run publishes its live
  ``agent.step`` frames onto the demo stack's OWN throwaway :class:`EventBus`, NEVER
  onto the process-wide singleton (``get_event_bus()``). A demo run must leave the
  global realtime bus's replay history with ZERO ``cases:{id}`` demo topics, both
  while engaged and after ``disable_demo``. This restores the demo isolation boundary
  (the demo stores are separate; the bus must be too) without touching #3 (the
  sandboxed-policy ``decide()`` is byte-identical).

* **Investigation-timeout cost accounting** — when an investigation exceeds
  ``caps.timeout_seconds`` and is cancelled, the partial spend that already hit the
  usage ledger (#6 — one ledger write per call) must still be accounted onto
  ``Case.token_cost`` (via a mutable ``cost_sink``), instead of being silently
  dropped. The case verdict is still capped to NEEDS_HUMAN; only the cost bookkeeping
  is reconciled with the ledger.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.config import Secrets
from app.constants import EntityType, SourceSurface, Verdict
from app.engine.correlation import cluster_from_events
from app.es.fake import InMemoryESClient
from app.llm.providers import CompletionResult, MockProvider
from app.models import UsageDoc
from app.realtime import get_event_bus, reset_event_bus
from app.state import AppState
from tests.conftest import make_raw_event


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _cluster(ip: str = "1.2.3.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def _demo_topics_in_global_bus() -> list[str]:
    """Every ``cases:*`` topic currently retained in the GLOBAL bus's replay ring."""
    bus = get_event_bus()
    history = getattr(bus, "_history", {})
    return [t for t in history.keys() if t.startswith("cases:")]


# --------------------------------------------------------------------------- #
# (1) Demo Mode never leaks agent.step frames onto the shared global EventBus.
# --------------------------------------------------------------------------- #
@pytest.fixture
def secrets() -> Secrets:
    return Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                   anthropic_api_key=None, openai_api_key=None)


@pytest.mark.asyncio
async def test_demo_run_publishes_nothing_to_the_shared_bus(secrets: Secrets) -> None:
    # Start from a pristine global bus so we measure ONLY what the demo run does.
    reset_event_bus()
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    try:
        await state.enable_demo(mode="live", seed=1337, history_days=3)

        # The demo pipeline is bound to an ISOLATED bus, not the global singleton.
        assert state._demo is not None
        assert state._demo.pipeline.event_bus is not None
        assert state._demo.pipeline.event_bus is not get_event_bus()
        assert state._demo.pipeline.event_bus is state._demo.event_bus

        # Drive many ticks (benign batches + ignited storylines) through the demo
        # pipeline — each strong investigation emits agent.step frames internally.
        for _ in range(30):
            await state.demo_tick()

        # The GLOBAL bus must carry ZERO demo case rooms: no agent.step frame leaked.
        assert _demo_topics_in_global_bus() == []

        # The demo's OWN bus has history disabled, so even its publishes are no-ops
        # (nothing retained / replayable) — true isolation, not just a separate ring.
        demo_bus = state._demo.event_bus
        assert getattr(demo_bus, "_history", {}) == {}

        # Disable: the global bus stays clean (purge leaves no demo topics behind).
        await state.disable_demo()
        assert _demo_topics_in_global_bus() == []
    finally:
        await state.shutdown()
        reset_event_bus()


@pytest.mark.asyncio
async def test_demo_purge_scrubs_any_stray_demo_topic_from_the_global_bus(secrets: Secrets) -> None:
    """Defense-in-depth: if a FUTURE wiring regression ever let a demo ``cases:{id}``
    frame reach the global bus, ``DemoStack.purge()`` scrubs it on teardown so a demo
    run can never leave frames replayable past disable."""
    reset_event_bus()
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    try:
        await state.enable_demo(mode="live", seed=4242, history_days=2)
        for _ in range(5):
            await state.demo_tick()
        # Learn a real demo case id, then SIMULATE a leak by publishing its room onto
        # the global bus directly (modelling a regressed wiring).
        demo_cases, _ = await state.cases.list(limit=5)
        assert demo_cases, "expected demo cases to exist"
        leaked_id = demo_cases[0].case_id
        get_event_bus().publish(f"cases:{leaked_id}", "agent.step",
                                {"case_id": leaked_id, "step": "router"})
        # An UNRELATED real topic must be left untouched by the scrub.
        get_event_bus().publish("cases:case-real-keep", "agent.step",
                                {"case_id": "case-real-keep", "step": "router"})
        assert f"cases:{leaked_id}" in _demo_topics_in_global_bus()

        await state._demo.purge()
        topics = _demo_topics_in_global_bus()
        assert f"cases:{leaked_id}" not in topics      # the demo leak was scrubbed
        assert "cases:case-real-keep" in topics        # the real topic survived
    finally:
        await state.shutdown()
        reset_event_bus()


# --------------------------------------------------------------------------- #
# (2) Investigation timeout: the partial ledger spend is accounted on the case.
# --------------------------------------------------------------------------- #
class _SlowInvestigatorProvider(MockProvider):
    """A mock provider whose FIRST investigator call returns quickly (so the gateway
    writes one real, priced ledger row) and whose SECOND investigator call sleeps far
    past the cap (so ``asyncio.wait_for`` cancels the flow mid-investigation). Every
    other role behaves like the base MockProvider."""

    def __init__(self, sleep_seconds: float) -> None:
        super().__init__()
        self._sleep_seconds = sleep_seconds
        self._investigator_calls = 0

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        if role == "investigator":
            self._investigator_calls += 1
            if self._investigator_calls == 1:
                # First step: emit a benign read-only tool call so the loop keeps going
                # (this gateway call completes → one ledger row is written + accounted).
                self.calls.append({"role": role, "messages": messages, "model": model})
                from app.llm.providers import _estimate_tokens  # noqa: PLC0415

                text = json.dumps({"action": "tool", "tool": "es_query",
                                   "input": {"ip": "1.2.3.4"}})
                return CompletionResult(
                    text=text,
                    prompt_tokens=_estimate_tokens(json.dumps(messages)),
                    completion_tokens=_estimate_tokens(text),
                    model=model,
                )
            # Second step: stall past the cap so the outer wait_for times out + cancels.
            await asyncio.sleep(self._sleep_seconds)
            return await super().complete(role, messages, model, temperature, max_tokens)
        return await super().complete(role, messages, model, temperature, max_tokens)


@pytest.mark.asyncio
async def test_investigation_timeout_accounts_partial_ledger_cost(secrets: Secrets) -> None:
    provider = _SlowInvestigatorProvider(sleep_seconds=5.0)
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    # Tight cap + route to the strong investigator so we actually time out mid-flow.
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    prefs.caps.timeout_seconds = 1
    await state.update_prefs(prefs)
    provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))

    case = await state.pipeline.investigate_cluster(
        _cluster("8.8.8.8"), SourceSurface.AUTOMATED_SCAN, state.prefs)

    # (1) The timeout cap still routes to NEEDS_HUMAN (existing behaviour, unchanged).
    assert case.verdict == Verdict.NEEDS_HUMAN

    # (2) Real spend DID happen: the ledger holds >=1 OK row for this case, cost C > 0.
    ledger = await state.usage_store.summary(window_hours=48, case_id=case.case_id)
    assert ledger["call_count"] >= 1
    ledger_cost = ledger["total_cost"]
    assert ledger_cost > 0.0, "expected the partial investigation to spend (router + 1 investigator call)"

    # (3) THE FIX: Case.token_cost reconciles with the ledger instead of being 0.0.
    # Pre-fix the timeout branch discarded flow_cost and this was 0.0 while C > 0.
    assert case.token_cost == pytest.approx(round(ledger_cost, 6))

    await state.shutdown()
    reset_event_bus()


@pytest.mark.asyncio
async def test_repeated_timeout_keeps_token_cost_in_lockstep_with_ledger(secrets: Secrets) -> None:
    """A re-investigation that ALSO times out keeps Case.token_cost equal to the
    ledger total for the case (monotonic, no further loss / no double counting)."""
    provider = _SlowInvestigatorProvider(sleep_seconds=5.0)
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    prefs.caps.timeout_seconds = 1
    await state.update_prefs(prefs)

    cluster = _cluster("9.9.9.9")
    provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    case1 = await state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, state.prefs)
    ledger1 = await state.usage_store.summary(window_hours=48, case_id=case1.case_id)
    assert await state.gateway.recorded_case_pipeline_cost(case1.case_id) == round(
        ledger1["total_cost"], 6
    )
    assert case1.token_cost == pytest.approx(round(ledger1["total_cost"], 6))

    # A Case Manager chat can share the case_id, but its usage is a separate surface
    # and must never inflate Case.token_cost (historically pipeline spend only).
    await state.usage_store.write(UsageDoc(
        surface="chat",
        case_id=case1.case_id,
        role="chat",
        model="gpt-5.6-luna",
        cost=1.0,
        total_tokens=10,
    ))

    # Re-investigate the same (open, un-changed-but-forced) case; it times out again.
    provider._investigator_calls = 0  # reset so the 2nd run also reaches the stall
    provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    case2 = await state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, state.prefs, force=True)
    ledger2 = await state.usage_store.summary(window_hours=48, case_id=case2.case_id)
    pipeline_total = await state.gateway.recorded_case_pipeline_cost(case2.case_id)
    assert pipeline_total is not None
    # The all-role ledger includes the synthetic $1 Chat row, while the case remains
    # exactly aligned to investigation-pipeline spend and still grows monotonically.
    assert ledger2["total_cost"] == pytest.approx(pipeline_total + 1.0)
    assert case2.token_cost == pytest.approx(pipeline_total)
    assert case2.token_cost >= case1.token_cost

    await state.shutdown()
    reset_event_bus()


@pytest.mark.asyncio
async def test_stale_nrt_ledger_total_never_erases_current_run_cost(
    secrets: Secrets, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An Elasticsearch search can briefly return only the prior run's rows.

    Reconciliation must retain the newly assembled spend until the all-time ledger
    read proves that it includes the current run; forcing a refresh per LLM call is
    intentionally avoided.
    """
    provider = _SlowInvestigatorProvider(sleep_seconds=5.0)
    overrides = {"anthropic": provider, "openai": provider, "mock": provider}
    state = AppState.create(
        secrets=secrets,
        es=InMemoryESClient(),
        provider_overrides=overrides,
    )
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    prefs.caps.timeout_seconds = 1
    await state.update_prefs(prefs)

    cluster = _cluster("7.7.7.7")
    provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    case1 = await state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, state.prefs)
    stale_total = case1.token_cost

    async def _stale_total(_case_id: str) -> float:
        return stale_total

    monkeypatch.setattr(state.gateway, "recorded_case_pipeline_cost", _stale_total)
    provider._investigator_calls = 0
    provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    case2 = await state.pipeline.investigate_cluster(
        cluster, SourceSurface.AUTOMATED_SCAN, state.prefs, force=True)

    # The stale prior total was not adopted: the current run's realised cost remains
    # represented in the case even though the authoritative search has not refreshed.
    assert case2.token_cost > stale_total
    actual_ledger_total = await state.usage_store.total_pipeline_cost_for_case(
        case2.case_id
    )
    assert actual_ledger_total is not None
    # Until the NRT read catches up, fail-soft addition matches the eventual raw-ledger
    # sum to one display micro-dollar. It cannot be exact in either direction:
    # ``Case.token_cost`` adds this run's RAW cost to the prior DISPLAY-ROUNDED total,
    # and the prior's rounding lands the sum up to one micro-dollar either side (it
    # does on the pre-streaming code too, for other cluster values). What must never
    # happen is losing part of the run: an abandoned request's cost — which the
    # caller learns only from the gateway's usage receipt — would be hundreds of
    # micro-dollars, far outside this bound.
    assert abs(case2.token_cost - actual_ledger_total) <= 0.0000011

    await state.shutdown()
    reset_event_bus()
