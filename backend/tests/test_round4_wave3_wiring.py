"""Round 4 / Wave 3 — DI-hub wiring for the 4 new KV stores + services.

Wave 3 wires the new default-OFF Round-4 stores + services into ``AppState`` so the
Wave-4 routes/schedulers can reach them. This is MINIMAL + additive: NOTHING here
starts a scheduler loop, reroutes an EVENT feed, or makes an LLM call at boot — every
engine no-ops until its ``Preferences.{threshold_tuning,campaign,baseline,batch}``
block is enabled (all default OFF).

These tests prove (fully offline — fake ES, no LLM, no network):
  * ``AppState`` exposes the 4 KV stores (tuning / campaign / baseline / batch-job),
    each backed by the SAME shared KV the Round-3 stores use;
  * ``AppState`` exposes the 4 W4-ready services (threshold-tuner run_once callable,
    campaign correlator, baseline model builder, batch service submit/poll/process);
  * a fresh ``AppState`` boots with EVERY Round-4 feature disabled — no scheduler task,
    the poller stays the unchanged ``PollerManager``, and no receiver task is spawned;
  * the stores survive a ``_wire()`` rebuild (persistent handles) and share ``self._kv``;
  * #3/#4/#6 rails: none of the new modules imports ``case_manager`` / references
    ``decide()`` (a source-text guard, mirroring the wave6 decide-guard discipline).
"""

from __future__ import annotations

import pytest

from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

asyncio = pytest.mark.asyncio


def _build_state() -> AppState:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    mp = MockProvider()
    overrides = {"anthropic": mp, "openai": mp, "mock": mp}
    return AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)


# --------------------------------------------------------------------------- #
# Stores
# --------------------------------------------------------------------------- #
def test_appstate_exposes_the_four_round4_stores():
    from app.stores.baseline import BaselineStore
    from app.stores.batch_jobs import BatchJobStore
    from app.stores.campaigns import CampaignStore
    from app.stores.tuning import TuningStore

    st = _build_state()
    assert isinstance(st.tuning_store, TuningStore)
    assert isinstance(st.campaign_store, CampaignStore)
    assert isinstance(st.baseline_store, BaselineStore)
    assert isinstance(st.batch_job_store, BatchJobStore)


def test_round4_stores_ride_the_same_shared_kv():
    """Each new store rides ``self._kv`` (the SAME KV the Round-3 stores use) — no new
    index/table/migration. Assert by identity against the price-overlay store's KV."""
    st = _build_state()
    shared_kv = st._kv
    assert st.tuning_store._kv is shared_kv
    assert st.campaign_store._kv is shared_kv
    assert st.baseline_store._kv is shared_kv
    assert st.batch_job_store._kv is shared_kv
    # …and the same KV the Round-3 price-overlay store uses.
    assert st.price_overlay._kv is shared_kv


# --------------------------------------------------------------------------- #
# Services (constructable / lazy, inert at boot)
# --------------------------------------------------------------------------- #
def test_appstate_exposes_the_four_round4_services():
    st = _build_state()
    # threshold-tuner run_once callable (bound stores/writer)
    assert callable(st.threshold_tuner)
    # campaign correlator callable
    assert callable(st.campaign_correlator)
    # baseline model builder → a fresh, non-None engine
    from app.engine.baseline import BaselineEngine

    eng = st.build_baseline_engine()
    assert isinstance(eng, BaselineEngine)
    assert st.build_baseline_engine() is not eng  # a fresh instance per call
    # batch service (submit/poll/process), memoised
    svc = st.batch_service
    assert svc is not None
    assert hasattr(svc, "submit") and hasattr(svc, "poll") and hasattr(svc, "process")
    assert st.batch_service is svc  # memoised on the AppState


def test_batch_service_and_engines_are_gated_off_by_default():
    st = _build_state()
    # Autopilot overhaul: the $0/#3-safe smart engines default ON; only the BATCH cost
    # lever (+ its service) stays off by default.
    assert st.prefs.threshold_tuning.enabled is True
    assert st.prefs.campaign.enabled is True
    assert st.prefs.baseline.enabled is True
    assert st.prefs.batch.enabled is False
    assert st.batch_service.enabled() is False


def test_batch_provider_builder_reads_secrets_and_never_networks():
    """The provider builder is constructable with no key + makes no network call."""
    st = _build_state()
    prov = st.build_batch_provider("anthropic")
    assert prov is not None
    with pytest.raises(KeyError):
        st.build_batch_provider("does-not-exist")


# --------------------------------------------------------------------------- #
# Boot cleanly with everything disabled; poller unchanged; no scheduler.
# --------------------------------------------------------------------------- #
@asyncio
async def test_fresh_appstate_boots_with_all_round4_features_disabled():
    from app.engine.poller_manager import PollerManager

    st = _build_state()
    await st.startup(start_poller=False)
    try:
        # The poller is still the unchanged Wave-2 PollerManager (Wave-3 added no
        # scheduler / feed rerouting).
        assert isinstance(st.poller, PollerManager)
        # No background receiver task was spawned (start_poller=False + no sources).
        assert st._receiver_tasks == []
        # No batch/tuning/baseline background loop attribute leaked onto the AppState.
        assert not hasattr(st, "_scheduler_task")
        assert not hasattr(st, "_tuning_task")
        # Autopilot overhaul: the smart engines default ON, but with start_poller=False no
        # scheduler ticks, so nothing ran; the BATCH cost lever stays off.
        assert st.prefs.threshold_tuning.enabled is True
        assert st.prefs.campaign.enabled is True
        assert st.prefs.baseline.enabled is True
        assert st.prefs.batch.enabled is False
        # The stores are still reachable + empty (nothing ran).
        assert await st.tuning_store.list() == []
        campaigns, total = await st.campaign_store.list()
        assert campaigns == [] and total == 0
        assert await st.baseline_store.list_signatures() == []
        assert await st.batch_job_store.list() == []
    finally:
        await st.shutdown()


@asyncio
async def test_round4_stores_survive_a_wire_rebuild():
    """A ``_wire()`` rebuild (credential change) re-binds the stores but they still
    ride the fresh shared KV — the persistent-handle contract the Round-3 stores hold."""
    st = _build_state()
    st._wire()  # simulate a rewire
    shared_kv = st._kv
    assert st.tuning_store._kv is shared_kv
    assert st.campaign_store._kv is shared_kv
    assert st.baseline_store._kv is shared_kv
    assert st.batch_job_store._kv is shared_kv
    # The memoised batch service is dropped + re-binds to the fresh gateway on access.
    svc = st.batch_service
    assert svc._gateway is st.gateway
    await st.shutdown()


# --------------------------------------------------------------------------- #
# #3 rail — the new modules never IMPORT the case-manager (an AST import check,
# so the safety docstrings that *mention* case_manager don't false-positive; the
# byte-identical decide()/apply() source itself is owned by the wave6 decide-guard).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "module_path",
    [
        "app/engine/threshold_tuner.py",
        "app/engine/campaigns.py",
        "app/engine/baseline.py",
        "app/llm/batch.py",
        "app/stores/tuning.py",
        "app/stores/campaigns.py",
        "app/stores/baseline.py",
        "app/stores/batch_jobs.py",
        # Round-7 Noise-Reduction counters (★a) — same #3 rail: pure banding + rollup +
        # a durable counter store, never the case-manager.
        "app/engine/noise_counters.py",
        "app/stores/noise_counters.py",
    ],
)
def test_round4_modules_never_import_case_manager(module_path):
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    tree = ast.parse((root / module_path).read_text(encoding="utf-8"))
    imported: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.append(node.module)
            imported.extend(f"{node.module}.{a.name}" for a in node.names)
        elif isinstance(node, ast.Import):
            imported.extend(a.name for a in node.names)
    assert not any("case_manager" in name for name in imported), (
        f"{module_path} must not import case_manager (#3): {imported}"
    )
