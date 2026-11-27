"""Demo Mode (Wave 5) — determinism, isolation, lifecycle, $0, decide() guard.

The non-negotiable spine of this feature:
  * SEEDED DETERMINISM — same seed → identical synthetic events + identical
    historical case spread.
  * ISOLATION — demo never writes the real stores; the write-guard rejects a
    mismatched row; the real durable poll cursor is untouched.
  * REVERSIBLE LIFECYCLE — enable → reset → disable purges demo and the real state
    returns intact.
  * $0 COST — every demo usage row is pricing_source='zero'.
  * #3 BYTE-IDENTICAL — case_manager.decide()/apply() are unedited (a sandboxed
    policy copy is the only isolation lever).
"""

from __future__ import annotations

import asyncio
import inspect
import random

import pytest
import pytest_asyncio

from app import __version__
from app.config import ModelConfig, Secrets
from app.constants import CaseStatus, SourceSurface, Verdict
from app.engine import case_manager, demo_generator as gen
from app.engine.demo_runtime import DemoStack
from app.es.fake import InMemoryESClient
from app.llm.providers import DemoMockProvider, MockProvider
from app.state import AppState
from app.utils import now_utc, to_millis


@pytest_asyncio.fixture
async def demo_state():
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    es = InMemoryESClient()
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    yield state
    await state.shutdown()


# --------------------------------------------------------------------------- #
# Seeded determinism
# --------------------------------------------------------------------------- #
def test_seeded_org_is_deterministic() -> None:
    a = gen.build_org(1337)
    b = gen.build_org(1337)
    assert [h.name for h in a.hosts] == [h.name for h in b.hosts]
    assert [h.ip for h in a.hosts] == [h.ip for h in b.hosts]
    # The fixture has a DC, a VIP laptop, servers + a corp /16.
    kinds = {h.kind for h in a.hosts}
    assert {"dc", "vip_laptop", "server", "workstation"} <= kinds
    assert a.cidr.endswith("/16")
    assert len(a.employees) >= 12 and len(a.hosts) >= 40


def test_seeded_benign_events_are_identical() -> None:
    org = gen.build_org(1337)
    r1, r2 = random.Random(7), random.Random(7)
    a = gen.generate_benign_batch(r1, org, 1_700_000_000_000, 20)
    b = gen.generate_benign_batch(r2, org, 1_700_000_000_000, 20)
    assert a == b
    # A different seed yields a different stream.
    c = gen.generate_benign_batch(random.Random(8), org, 1_700_000_000_000, 20)
    assert a != c


def test_seeded_historical_spread_is_identical() -> None:
    org = gen.build_org(1337)
    now = 1_700_000_000_000
    a = gen.generate_historical_cases(1337, org, history_days=14, run_id="run-A", now_millis=now)
    b = gen.generate_historical_cases(1337, org, history_days=14, run_id="run-A", now_millis=now)
    # Same seed + run_id → byte-identical spread.
    assert [c.case_id for c in a] == [c.case_id for c in b]
    assert [c.model_dump(mode="json") for c in a] == [c.model_dump(mode="json") for c in b]
    # Every status / disposition / verdict appears; a couple stay OPEN for HITL.
    statuses = {c.status.value for c in a}
    dispositions = {c.disposition.value for c in a if c.disposition}
    verdicts = {c.verdict.value for c in a if c.verdict}
    assert {"resolved", "closed", "escalated", "on_hold"} <= statuses
    assert {"true_positive", "false_positive", "benign", "duplicate"} <= dispositions
    assert Verdict.NEEDS_HUMAN.value in verdicts  # an open HITL case exists
    # Some cases carry the richer feature data.
    assert any(c.notifications_sent for c in a)
    assert any(c.automation_actions for c in a)
    assert any(c.comments for c in a)
    escalated = [c for c in a if c.status == CaseStatus.ESCALATED]
    assert escalated
    assert all(c.recommended_action == "Escalate." for c in escalated)
    assert all("tier" not in c.recommended_action.lower() for c in a)


def test_seeded_case_risk_factors_reconcile_with_default_weights() -> None:
    """The demo's risk drill-down must explain the score it displays."""
    org = gen.build_org(1337)
    now = 1_700_000_000_000
    recent_cases, _recent_events = gen.generate_recent_preseed(
        1337, org, run_id="run-A", now_millis=now,
    )
    hitl_cases, tuner_cases = gen.generate_capability_seed_cases(
        1337, org, run_id="run-A", now_millis=now,
    )
    cases = [
        *gen.generate_historical_cases(1337, org, history_days=14, run_id="run-A", now_millis=now),
        *recent_cases,
        *hitl_cases,
        *tuner_cases,
    ]
    for case in cases:
        factors = case.risk_breakdown
        calculated = (
            0.25 * factors.volume
            + 0.20 * factors.velocity
            + 0.30 * factors.reputation
            + 0.15 * factors.diversity
            + 0.10 * factors.asset_criticality
        )
        assert calculated == pytest.approx(case.risk_score, abs=0.01), case.case_id


def test_all_seed_fixtures_ignore_random_run_ids_at_a_fixed_clock() -> None:
    org = gen.build_org(9001)
    now = 1_783_785_600_000
    hist_a = gen.generate_historical_cases(
        9001, org, history_days=14, run_id="demorun-random-a", now_millis=now,
    )
    hist_b = gen.generate_historical_cases(
        9001, org, history_days=14, run_id="demorun-random-b", now_millis=now,
    )
    recent_a = gen.generate_recent_preseed(
        9001, org, run_id="demorun-random-a", now_millis=now,
    )
    recent_b = gen.generate_recent_preseed(
        9001, org, run_id="demorun-random-b", now_millis=now,
    )
    cap_a = gen.generate_capability_seed_cases(
        9001, org, run_id="demorun-random-a", now_millis=now,
    )
    cap_b = gen.generate_capability_seed_cases(
        9001, org, run_id="demorun-random-b", now_millis=now,
    )

    def dump_cases(items):
        return [item.model_dump(mode="json") for item in items]

    assert dump_cases(hist_a) == dump_cases(hist_b)
    assert dump_cases(recent_a[0]) == dump_cases(recent_b[0])
    assert recent_a[1] == recent_b[1]
    assert [dump_cases(group) for group in cap_a] == [dump_cases(group) for group in cap_b]


@pytest.mark.asyncio
async def test_enable_is_deterministic_across_states() -> None:
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)

    async def _spread():
        st = AppState.create(
            secrets=secrets, es=InMemoryESClient(),
            provider_overrides={"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()},
        )
        await st.startup(start_poller=False)
        await st.update_prefs(st.prefs.model_copy(update={"setup_complete": True}))
        await st.enable_demo(mode="seeded", seed=4242, history_days=10)
        cases, _ = await st.cases.list(limit=300, sort_field="created_at")
        ids = sorted(c.case_id for c in cases)
        await st.shutdown()
        return ids

    a = await _spread()
    b = await _spread()
    assert a == b and len(a) > 0


@pytest.mark.asyncio
async def test_demo_gateway_mocks_every_configured_provider(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=0)
    stack = demo_state._demo
    provider_names = (
        "anthropic", "openai", "mock", "azure", "bedrock", "vertex",
        "openai_compatible",
    )
    assert all(stack.gateway._providers[name] is stack._provider for name in provider_names)

    for name in provider_names:
        cfg = ModelConfig(provider=name, model=f"offline-demo-{name}")
        completion = await stack.gateway.complete(
            "chat", [{"role": "user", "content": "synthetic demo"}], cfg,
            surface="provider-isolation-test",
        )
        vectors = await stack.gateway.embed(
            ["synthetic demo"], cfg, surface="provider-isolation-test",
        )
        assert completion.text and vectors and vectors[0]


@pytest.mark.asyncio
async def test_demo_enable_lifecycle_is_serialized_without_ticker_leaks(
    demo_state: AppState, monkeypatch,
) -> None:
    original = demo_state._enable_demo_unlocked
    active_calls = 0
    max_active = 0
    simulators = []

    async def observed(**kwargs):
        nonlocal active_calls, max_active
        active_calls += 1
        max_active = max(max_active, active_calls)
        try:
            await asyncio.sleep(0.01)
            result = await original(**kwargs)
            simulators.append(demo_state._demo_sim)
            return result
        finally:
            active_calls -= 1

    monkeypatch.setattr(demo_state, "_enable_demo_unlocked", observed)
    await asyncio.gather(
        demo_state.enable_demo(
            mode="live", seed=1, history_days=0, event_rate_per_second=0,
        ),
        demo_state.enable_demo(
            mode="live", seed=2, history_days=0, event_rate_per_second=0,
        ),
    )
    assert max_active == 1
    assert len(simulators) == 2 and simulators[0] is not simulators[1]
    assert simulators[0]._task is None
    assert simulators[1]._task is not None and not simulators[1]._task.done()
    await demo_state.disable_demo()
    assert simulators[1]._task is None and demo_state._demo_sim is None


@pytest.mark.asyncio
async def test_demo_enable_is_atomically_published_and_sources_use_requested_seed(
    demo_state: AppState, monkeypatch,
) -> None:
    from app.engine import demo_sources

    entered = asyncio.Event()
    release = asyncio.Event()
    captured: dict[str, int | str] = {}
    original_build = demo_sources.build_native_demo_sources

    def capture_build(seed, prefs, **kwargs):
        captured["seed"] = int(seed)
        captured["prefs_seed"] = int(prefs.demo.seed)
        captured["mode"] = str(prefs.demo.mode)
        return original_build(seed, prefs, **kwargs)

    async def pause_before_publish(_stack):
        entered.set()
        await release.wait()

    monkeypatch.setattr(demo_sources, "build_native_demo_sources", capture_build)
    monkeypatch.setattr(DemoStack, "run_capability_pass", pause_before_publish)
    task = asyncio.create_task(
        demo_state.enable_demo(mode="seeded", seed=9001, history_days=0)
    )
    await asyncio.wait_for(entered.wait(), timeout=5)
    assert demo_state._demo is None
    assert demo_state.demo_active is False
    assert demo_state.prefs.demo.mode == "off"
    release.set()
    status = await task
    assert status["active"] is True
    assert captured == {"seed": 9001, "prefs_seed": 9001, "mode": "seeded"}


# --------------------------------------------------------------------------- #
# Isolation + write-guard
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_demo_never_writes_the_real_store(demo_state: AppState) -> None:
    # Real store empty before.
    _rc, rt0 = await demo_state._real_cases.list(limit=10)
    assert rt0 == 0

    await demo_state.enable_demo(mode="live", seed=1337, history_days=7)
    # The active store now serves DEMO cases (real hidden).
    cases, total = await demo_state.cases.list(limit=10)
    assert total > 0 and all("demo" in c.tags for c in cases)

    # Drive several ticks (benign + storylines) through the demo pipeline.
    for _ in range(8):
        await demo_state.demo_tick()

    # The REAL store is STILL empty — nothing leaked.
    _rc, rt1 = await demo_state._real_cases.list(limit=50)
    assert rt1 == 0
    # Real usage ledger is untouched (every LLM call went to the demo gateway).
    real_usage = await demo_state._real_usage_store.summary(window_hours=48)
    assert real_usage["call_count"] == 0


@pytest.mark.asyncio
async def test_demo_batch_jobs_are_isolated_from_the_durable_ledger(
    demo_state: AppState,
) -> None:
    from app.models import BatchJob

    await demo_state.real_batch_job_store.save(BatchJob(id="batch-real-hidden"))
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=0)

    assert demo_state.batch_job_store is demo_state._demo.batch_job_store
    assert await demo_state.batch_job_store.list() == []
    assert [job.id for job in await demo_state.real_batch_job_store.list()] == [
        "batch-real-hidden"
    ]

    await demo_state.disable_demo()
    assert [job.id for job in await demo_state.batch_job_store.list()] == [
        "batch-real-hidden"
    ]


def test_write_guard_rejects_mismatched_rows() -> None:
    from app.models import Case, Entity
    from app.constants import EntityType

    real = Case(case_id="case-real-1", cluster_signature="s",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="1.2.3.4"))
    demo = Case(case_id="demo-x-0001", cluster_signature="s2",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value="5.6.7.8"), tags=["demo"])
    # A demo write must carry a demo row; a real write must NOT.
    AppState._write_guard(demo, demo=True)        # ok
    AppState._write_guard(real, demo=False)       # ok
    with pytest.raises(AssertionError):
        AppState._write_guard(real, demo=True)
    with pytest.raises(AssertionError):
        AppState._write_guard(demo, demo=False)


@pytest.mark.asyncio
async def test_real_poll_cursor_untouched_in_demo(demo_state: AppState) -> None:
    # Record the real durable cursor, enable demo, drive ticks, assert it never moved.
    before = await demo_state.cursor_store.load()
    await demo_state.enable_demo(mode="live", seed=1337, history_days=3)
    for _ in range(6):
        await demo_state.demo_tick()
    after = await demo_state.cursor_store.load()
    assert (after.timestamp_millis, tuple(after.boundary_ids)) == (
        before.timestamp_millis, tuple(before.boundary_ids)
    )


# --------------------------------------------------------------------------- #
# Lifecycle: enable → reset → disable
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_enable_reset_disable_lifecycle(
    demo_state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TLSOC_BUILD_SHA", "demo-case-build")
    s1 = await demo_state.enable_demo(mode="seeded", seed=1337, history_days=7)
    assert s1["active"] and s1["mode"] == "seeded" and s1["case_count"] > 0
    run1 = s1["run_id"]
    seeded_cases, seeded_total = await demo_state.cases.list(limit=500)
    assert seeded_total == s1["case_count"]
    assert seeded_cases
    assert {case.app_version for case in seeded_cases} == {__version__}
    assert {case.build_sha for case in seeded_cases} == {"demo-case-build"}

    # Reset re-seeds with a NEW run_id but the same deterministic spread size.
    s2 = await demo_state.reset_demo()
    assert s2["active"] and s2["run_id"] != run1
    assert s2["case_count"] == s1["case_count"]

    # Disable purges demo + flips off; the real (empty) store returns.
    s3 = await demo_state.disable_demo()
    assert s3["mode"] == "off" and not s3["active"]
    assert not demo_state.demo_active
    _cases, total = await demo_state.cases.list(limit=10)
    assert total == 0  # back to the (empty) real store
    assert demo_state.prefs.demo.mode == "off" and demo_state.prefs.demo.run_id == ""


# --------------------------------------------------------------------------- #
# $0 cost — every demo usage row is pricing_source='zero'
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_demo_cost_is_zero_priced(
    demo_state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TLSOC_BUILD_SHA", "demo-usage-build")
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    # Ignite a TRUE_POSITIVE storyline so the demo pipeline makes LLM calls.
    from app.connectors.demo import DemoPullConnector

    src = DemoPullConnector(seed=1337)
    dprefs = demo_state._demo._demo_prefs()
    raws = src.storyline_raw(
        gen._STORYLINE_BY_ID["phishing_chain"], random.Random(1), to_millis(now_utc()), dprefs,
    )
    await demo_state._demo.ingest_service.ingest(
        raws, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN, source_id=gen.DEMO_SOURCE_ID,
    )
    # Every demo usage row is pricing_source='zero' (a $0 mock run).
    demo_es = demo_state._demo.es
    usage = [d for idx in demo_es.docs for d in demo_es.docs[idx].values() if "pricing_source" in d]
    assert usage, "expected the demo pipeline to write usage rows"
    assert {d["pricing_source"] for d in usage} == {"zero"}
    assert {d["app_version"] for d in usage} == {__version__}
    assert {d["build_sha"] for d in usage} == {"demo-usage-build"}


# --------------------------------------------------------------------------- #
# Scenario-keyed verdicts (deterministic) + NEEDS_HUMAN stays open
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_storyline_verdicts_are_scenario_keyed(demo_state: AppState) -> None:
    from app.connectors.demo import DemoPullConnector

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    src = DemoPullConnector(seed=1337)
    dprefs = demo_state._demo._demo_prefs()
    now = to_millis(now_utc())

    async def _ignite(sid: str):
        before, _ = await demo_state.cases.list(limit=400)
        before_ids = {c.case_id for c in before}
        raws = src.storyline_raw(gen._STORYLINE_BY_ID[sid], random.Random(3), now + hash(sid) % 5000, dprefs)
        await demo_state._demo.ingest_service.ingest(
            raws, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN, source_id=gen.DEMO_SOURCE_ID,
        )
        after, _ = await demo_state.cases.list(limit=400)
        return [c for c in after if c.case_id not in before_ids and c.verdict is not None]

    tp = await _ignite("ransomware_beacon")
    assert tp and all(c.verdict == Verdict.TRUE_POSITIVE for c in tp)
    # TRUE_POSITIVE is NOT auto-closed (tp auto-close off in the sandboxed copy).
    assert all(c.status.value != "closed" for c in tp)

    nh = await _ignite("impossible_travel")
    assert nh and all(c.verdict == Verdict.NEEDS_HUMAN for c in nh)
    # NEEDS_HUMAN ALWAYS stays open for the HITL showcase.
    assert all(c.status.value != "closed" for c in nh)


def test_demo_mock_provider_resolves_story_from_uid() -> None:
    prov = DemoMockProvider()
    # A prompt carrying a storyline UID resolves to that story's verdict.
    story = gen._STORYLINE_BY_ID["phishing_chain"]
    msgs = [{"role": "user", "content": f"cluster rules: demo_{story.id} extra noise"}]
    story_resolved = DemoMockProvider._resolve(msgs)
    assert story_resolved is not None and story_resolved.id == story.id


def test_demo_story_identity_is_not_overwritten_by_tool_results() -> None:
    messages = [
        {"role": "user", "content": "cluster rule=WEB-EXPLOIT"},
        {"role": "assistant", "content": '{"action":"tool","tool":"es_query"}'},
        {
            "role": "user",
            "content": (
                "Tool 'es_query' result:\n"
                "UNTRUSTED related row rule=LP-ES-RISK-1001"
            ),
        },
    ]
    resolved = DemoMockProvider._resolve(messages)
    assert resolved is not None and resolved.id == "sqli_webshell"


@pytest.mark.asyncio
async def test_demo_formatter_preserves_scenario_aware_draft() -> None:
    import json

    provider = DemoMockProvider()
    draft = {
        "verdict": "TRUE_POSITIVE",
        "confidence": 0.93,
        "evidence": [{"summary": "Native incident evidence.", "event_ids": []}],
        "mitre": ["T1078"],
        "recommended_action": "Contain affected hosts and rotate credentials.",
        "reproduce_query": "source.ip:192.0.2.10",
    }
    result = await provider.complete(
        "formatter",
        [
            {"role": "system", "content": "format"},
            {"role": "user", "content": json.dumps({"draft_verdict": draft})},
        ],
        "demo-model",
        0.0,
        1000,
    )
    assert json.loads(result.text) == draft
    # The benign baseline resolves to no story (→ a confident FALSE_POSITIVE).
    assert DemoMockProvider._resolve([{"role": "user", "content": "web_auth login success"}]) is None


# --------------------------------------------------------------------------- #
# #3 byte-identical guard
# --------------------------------------------------------------------------- #
def test_decide_and_apply_are_byte_identical() -> None:
    """Demo Mode must NOT have touched the deterministic decision (#3). The sandboxed
    policy is passed as a different instance to the unchanged pure decide()."""
    src = inspect.getsource(case_manager.decide)
    assert "if entry is not None and entry.enabled:" in src
    assert "if confidence >= entry.min_confidence and risk_score <= entry.max_risk_score:" in src
    assert "status=CaseStatus.CLOSED," in src
    assert "decision_by=DecisionBy.AGENT," in src
    # decide() knows nothing about demo.
    assert "demo" not in src.lower()
    apply_src = inspect.getsource(case_manager.CaseManager.apply)
    assert "Invariant violated: attempted to auto-close a NEEDS_HUMAN case" in apply_src
    assert "demo" not in apply_src.lower()


def test_sandbox_policy_is_a_distinct_copy() -> None:
    from app.config import Preferences
    from app.engine.demo_runtime import sandbox_policy

    prefs = Preferences()
    sandboxed = sandbox_policy(prefs.auto_close)
    assert sandboxed is not prefs.auto_close                    # a different instance
    assert sandboxed.model_dump() == prefs.auto_close.model_dump()  # equal content
    # NEEDS_HUMAN never auto-closes in the sandboxed policy (code-enforced regardless).
    assert sandboxed.needs_human.enabled is False


# --------------------------------------------------------------------------- #
# Read endpoints serve the active (demo) store; real hidden
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_read_endpoints_serve_demo_store(demo_state: AppState) -> None:
    # Seed a REAL case directly so we can prove it is HIDDEN during demo.
    from app.models import Case, Entity
    from app.constants import EntityType

    real_case = Case(case_id="case-real-99", cluster_signature="real-sig",
                     source_surface=SourceSurface.AUTOMATED_SCAN,
                     entity=Entity(type=EntityType.IP, value="9.9.9.9"))
    await demo_state._real_cases.save(real_case)

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=5)
    cases, _ = await demo_state.cases.list(limit=300)
    case_ids = {c.case_id for c in cases}
    assert "case-real-99" not in case_ids        # real case hidden during demo
    assert all("demo" in c.tags for c in cases)  # only demo cases visible

    await demo_state.disable_demo()
    cases2, _ = await demo_state.cases.list(limit=300)
    ids2 = {c.case_id for c in cases2}
    assert "case-real-99" in ids2                # real case back after disable


@pytest.mark.asyncio
async def test_noise_counters_serve_demo_store_in_demo(demo_state: AppState) -> None:
    # The Noise-Reduction funnel (GET /api/metrics/noise-reduction reads ``state.noise_counters``)
    # must reflect the DEMO's ingested volume during demo — not the empty REAL counters, which
    # would degrade the funnel to the case-only "counters warming up" fallback even though the
    # demo IS recording ingest volume (the ~100-event pre-seed + live ticks land in the demo
    # store). Off demo, the real store is served (byte-identical).
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=5)
    # Read path is demo-swapped onto the demo store, which the pre-seed populated with ingest.
    assert demo_state.noise_counters is demo_state._demo.noise_counters
    demo_window = await demo_state.noise_counters.read_window(24)
    assert demo_window["available"] is True          # full funnel, NOT "counters warming up"
    # Isolation: the REAL counters were never written by the demo (still empty/unavailable).
    real_window = await demo_state._real_noise_counters.read_window(24)
    assert real_window["available"] is False

    await demo_state.disable_demo()
    # Back to the real store after disable (empty here → the honest case-only fallback).
    assert demo_state.noise_counters is demo_state._real_noise_counters
    off_window = await demo_state.noise_counters.read_window(24)
    assert off_window["available"] is False


# --------------------------------------------------------------------------- #
# Demo overhaul — 3 segments, bounded rates, pre-seed, forced capabilities
# --------------------------------------------------------------------------- #
def _mk_closed_fp_case(cid: str, rule_id: str, now_iso: str):
    """A demo-tagged CLOSED / FALSE_POSITIVE case for a given noisy rule."""
    from app.models import Case, Entity, FeedbackEntry, StatusHistoryEntry
    from app.constants import CaseStatus, Disposition, EntityType

    return Case(
        case_id=cid, cluster_signature=f"sig-{cid}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=f"203.0.113.{abs(hash(cid)) % 250 + 2}"),
        rule_ids=[rule_id], verdict=Verdict.FALSE_POSITIVE,
        disposition=Disposition.FALSE_POSITIVE, status=CaseStatus.CLOSED,
        created_at=now_iso, updated_at=now_iso,
        status_history=[StatusHistoryEntry(from_status="new", to_status="closed",
                                           by="agent", at=now_iso, reason="demo fp")],
        feedback=[FeedbackEntry(
            ts=now_iso,
            analyst="demo.analyst",
            assessment="agree",
            accuracy=1.0,
            reasoning_quality=1.0,
            action_appropriateness=1.0,
            actual_outcome="false_positive",
            comment="Synthetic analyst-confirmed demo outcome.",
            ai_verdict=Verdict.FALSE_POSITIVE.value,
            ai_confidence=1.0,
        )],
        tags=["demo"],
    )


def test_three_segments_use_distinct_source_ids() -> None:
    from app.engine.demo_generator import SEGMENT_SOURCE_IDS

    assert set(SEGMENT_SOURCE_IDS.values()) == {
        "demo-splunk", "demo-qradar", "demo-wazuh",
    }
    assert len(set(SEGMENT_SOURCE_IDS.values())) == 3


def test_segment_rule_and_host_pools_are_disjoint() -> None:
    org = gen.build_org(1337)
    # Each segment draws only its own hosts.
    for seg in ("siem", "xdr", "edr"):
        r = random.Random(11)
        batch = gen.generate_benign_batch(r, org, 1_700_000_000_000, 40, seg)
        hosts = {h["_source"].get("host", {}).get("name") for h in batch}
        seg_hosts = {h.name for h in org.segment_hosts(seg)}
        assert hosts <= seg_hosts, f"{seg} drew a host outside its pool: {hosts - seg_hosts}"
        modules = {h["_source"]["event"]["module"] for h in batch}
        seg_modules = {r_[0] for r_ in gen._SEGMENT_RULES[seg]}
        assert modules <= seg_modules, f"{seg} drew a rule outside its pool"
    # The 3 segment host pools are mutually disjoint.
    pools = [{h.name for h in org.segment_hosts(s)} for s in ("siem", "xdr", "edr")]
    assert pools[0].isdisjoint(pools[1]) and pools[1].isdisjoint(pools[2]) and pools[0].isdisjoint(pools[2])


def test_segment_none_is_backcompat_full_pool() -> None:
    org = gen.build_org(1337)
    r1, r2 = random.Random(5), random.Random(5)
    a = gen.generate_benign_batch(r1, org, 1_700_000_000_000, 20)          # no segment
    b = gen.generate_benign_batch(r2, org, 1_700_000_000_000, 20, None)    # explicit None
    assert a == b  # None == default, byte-identical


def test_storylines_are_tagged_with_a_segment() -> None:
    assert gen.STORYLINES, "expected demo storylines"
    for s in gen.STORYLINES:
        assert s.segment in {"siem", "xdr", "edr"}, f"{s.id} has bad segment {s.segment!r}"


def test_all_storyline_mitre_ids_are_in_the_bundled_corpus() -> None:
    import json
    from pathlib import Path

    corpus = json.loads(
        (Path(__file__).resolve().parents[1] / "app" / "threat" / "mitre_techniques.json").read_text()
    )
    ids = set(corpus.keys())
    used = {t for s in gen.STORYLINES for t in s.techniques}
    used |= {t for tmpl in gen._HIST_TEMPLATES for t in tmpl["mitre"]}
    missing = used - ids
    assert not missing, f"storyline MITRE ids missing from the bundled corpus: {missing}"


def test_org_is_rethemed_to_lumenpay() -> None:
    org = gen.build_org(1337)
    assert org.name == "LumenPay Financial" and org.domain == "lumenpay.example"
    # LumenPay employees + segment-partitioned hosts exist.
    assert "pnair" in {e.user for e in org.employees}
    assert any(h.name.startswith("LP-") for h in org.hosts)
    kinds = {h.kind for h in org.hosts}
    assert {"dc", "vip_laptop", "server", "workstation"} <= kinds


@pytest.mark.asyncio
async def test_rates_are_bounded_at_high_event_rate(demo_state: AppState) -> None:
    # 40 evt/s, tick=1s: routing many transient batches must NOT create O(N*40) cases.
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2,
                                 event_rate_per_second=40, tick_seconds=1)
    _c, before = await demo_state._demo.cases.list(limit=1)
    dprefs = demo_state._demo._demo_prefs()
    org = gen.build_org(1337)
    rng = random.Random(9)
    now = to_millis(now_utc())
    for _ in range(30):
        # ~40 events per tick, materialised transiently and dropped after the funnel.
        events = gen.hits_to_raw(gen.generate_benign_batch(rng, org, now, 40, "xdr"), dprefs)
        await demo_state._demo.route_event_batch(events, "xdr")
    _c2, after = await demo_state._demo.cases.list(limit=1)
    # 30 ticks * 40 events = 1200 logical events; the pre-aggregating funnel keeps cases
    # BOUNDED (a small multiple of tdigest_compression=100), never ~1200.
    assert (after - before) < 200, f"event routing created {after - before} cases (unbounded!)"


@pytest.mark.asyncio
async def test_pre_seed_creates_recent_non_terminal_cases(demo_state: AppState) -> None:
    from app.constants import CaseStatus

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=7,
                                 preseed_case_count=3, preseed_recent_minutes=10)
    cases, _ = await demo_state.cases.list(limit=400, sort_field="created_at")
    recent = [c for c in cases if c.case_id.startswith("demo-recent-")]
    assert len(recent) >= 3
    now_ms = to_millis(now_utc())
    for c in recent:
        first = getattr(c, "first_seen_millis", 0) or 0
        # created within the pre-seed window (allow a little slack for save latency).
        assert first == 0 or (now_ms - first) <= 20 * 60_000
    # At least one pre-seed case is still OPEN ("just arrived", not all terminal).
    non_terminal = {CaseStatus.NEW.value, CaseStatus.INVESTIGATING.value, CaseStatus.ESCALATED.value}
    assert any(c.status.value in non_terminal for c in recent)


@pytest.mark.asyncio
async def test_pre_seed_events_are_counted_as_ingested_volume(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2,
                                 preseed_event_count=100)
    # The ~100 pre-seed events are recorded as ingested volume in the DEMO noise counters.
    assert demo_state._demo.preseed_events >= 80
    window = await demo_state._demo.noise_counters.read_window(0)
    assert window.get("available") is True
    total = sum(int(v) for v in (window.get("ingested") or {}).values())
    assert total >= 80, f"noise counter reflected only {total} ingested events"
    # Real state untouched.
    _rc, rt = await demo_state._real_cases.list(limit=5)
    assert rt == 0


@pytest.mark.asyncio
async def test_seeded_noise_funnel_is_monotonic_on_first_paint(
    demo_state: AppState,
) -> None:
    from app.engine.metrics import _window_filter

    await demo_state.enable_demo(
        mode="seeded", seed=1337, history_days=14,
        preseed_event_count=100, force_capabilities=True,
    )
    cases, _ = await demo_state.cases.list(limit=500)
    current_cases = _window_filter(cases, window_hours=24)
    window = await demo_state.noise_counters.read_window(24)
    ingested = sum(int(v) for v in (window.get("ingested") or {}).values())
    clustered = sum(int(v) for v in (window.get("clustered") or {}).values())

    assert ingested >= clustered >= len(current_cases) > 0


@pytest.mark.asyncio
async def test_force_capabilities_true_by_default(demo_state: AppState) -> None:
    # Pin the LIVE capability config OFF so "forced ON in the sandbox only, real prefs
    # untouched" is a strong isolation proof even under the Autopilot default-ON posture.
    p = demo_state.prefs.model_copy(deep=True)
    p.threshold_tuning.enabled = False
    p.campaign.enabled = False
    p.threshold_automation.enabled = False
    await demo_state.update_prefs(p)

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    dprefs = demo_state._demo._demo_prefs()
    assert dprefs.threshold_tuning.enabled is True
    assert dprefs.baseline.enabled is True
    assert dprefs.campaign.enabled is True
    assert dprefs.threshold_automation.enabled is True
    # The REAL prefs are UNTOUCHED (still the OFF we pinned above — the sandbox is a copy).
    assert demo_state.prefs.threshold_tuning.enabled is False
    assert demo_state.prefs.campaign.enabled is False


@pytest.mark.asyncio
async def test_force_capabilities_false_preserves_legacy(demo_state: AppState) -> None:
    # Pin the live capability config OFF so we can prove force_capabilities=False INHERITS
    # it (rather than forcing ON) even under the Autopilot default-ON posture.
    p = demo_state.prefs.model_copy(deep=True)
    p.threshold_tuning.enabled = False
    p.campaign.enabled = False
    p.threshold_automation.enabled = False
    await demo_state.update_prefs(p)

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1,
                                 force_capabilities=False)
    dprefs = demo_state._demo._demo_prefs()
    # Inherit the live capability config (pinned OFF here) — no forcing.
    assert dprefs.threshold_tuning.enabled is False
    assert dprefs.campaign.enabled is False
    assert dprefs.threshold_automation.enabled is False


@pytest.mark.asyncio
async def test_seed_automation_rule_injected_when_none(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    ta = demo_state._demo._demo_prefs().threshold_automation
    assert any(r.action == "request_approval" for r in ta.rules)


@pytest.mark.asyncio
async def test_seed_automation_rule_not_injected_when_operator_has_rules(demo_state: AppState) -> None:
    from app.config import CaseAutomationRule, ThresholdAutomationConfig

    prefs = demo_state.prefs.model_copy(update={
        "threshold_automation": ThresholdAutomationConfig(
            enabled=False, rules=[CaseAutomationRule(id="op-rule", action="tag")],
        ),
    })
    await demo_state.update_prefs(prefs)
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    ta = demo_state._demo._demo_prefs().threshold_automation
    ids = {r.id for r in ta.rules}
    assert "op-rule" in ids and "demo-seed-approval" not in ids
    assert ta.enabled is True  # forced on, but the operator's own rule is preserved


@pytest.mark.asyncio
async def test_hitl_proposal_created_during_live_demo(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    # Ignite a NEEDS_HUMAN storyline through the EDR source → the seeded request_approval
    # rule opens a demo HITL proposal.
    src = demo_state._demo.sources["edr"]
    dprefs = demo_state._demo._demo_prefs()
    raws = src.storyline_raw(gen._STORYLINE_BY_ID["impossible_travel"], random.Random(3),
                             to_millis(now_utc()), dprefs)
    await demo_state._demo.ingest_service.ingest(
        raws, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN,
        source_id=gen.SEGMENT_SOURCE_IDS["edr"],
    )
    demo_props = await demo_state._demo.proposals.list()
    assert demo_props, "expected a demo HITL proposal from the NEEDS_HUMAN storyline"
    # The REAL proposal queue is untouched.
    real_props = await demo_state.real_proposals.list()
    assert real_props == []


@pytest.mark.asyncio
async def test_threshold_tuning_writes_demo_store_not_real(demo_state: AppState) -> None:
    # Automatic writes are an explicit policy and retain the mandatory shadow guard.
    # A clean analyst-confirmed FP-only window passes that replay deterministically.
    prefs = demo_state.prefs.model_copy(deep=True)
    prefs.threshold_tuning = prefs.threshold_tuning.model_copy(update={
        "shadow_eval": True,
        "auto_apply_confirmed": True,
    })
    await demo_state.update_prefs(prefs)

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    now_iso = __import__("app.utils", fromlist=["iso_now"]).iso_now()
    for i in range(40):
        await demo_state._demo.cases.save(_mk_closed_fp_case(f"demo-noisy-{i:03d}", "noisy_rule", now_iso))

    await demo_state._demo.run_capability_pass()

    demo_tuning = await demo_state._demo.tuning_store.list()
    real_tuning = await demo_state.real_tuning_store.list()
    assert demo_tuning, "expected a demo tuning observation from the noisy rule"
    assert real_tuning == [], "the REAL tuning store must be untouched (isolation)"
    # The tuned correlation-n bump is stashed on the demo stack (never real prefs).
    assert "noisy_rule" in demo_state._demo._tuned_correlation_rules
    assert demo_state.prefs.correlation_rules.get("noisy_rule") is None


@pytest.mark.asyncio
async def test_correlation_n_tuning_dedups_across_passes(demo_state: AppState) -> None:
    prefs = demo_state.prefs.model_copy(deep=True)
    prefs.threshold_tuning = prefs.threshold_tuning.model_copy(update={
        "shadow_eval": True,
        "auto_apply_confirmed": True,
    })
    await demo_state.update_prefs(prefs)

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    now_iso = __import__("app.utils", fromlist=["iso_now"]).iso_now()
    for i in range(40):
        await demo_state._demo.cases.save(_mk_closed_fp_case(f"demo-noisy-{i:03d}", "noisy_rule", now_iso))

    await demo_state._demo.run_capability_pass()
    first = len(await demo_state._demo.tuning_store.list(rule_id="noisy_rule"))
    await demo_state._demo.run_capability_pass()
    second = len(await demo_state._demo.tuning_store.list(rule_id="noisy_rule"))
    # The same unchanging trailing window must NOT re-bump the same rule (already_tuned).
    assert first == 1, "the explicit automatic policy should tune the noisy demo rule once"
    assert second == first, "correlation-n tuning re-bumped the same rule (no dedup)"


@pytest.mark.asyncio
async def test_campaigns_populate_demo_store_not_real(demo_state: AppState) -> None:
    from app.models import Case, Entity
    from app.constants import EntityType, CaseStatus

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    now_iso = __import__("app.utils", fromlist=["iso_now"]).iso_now()
    # Two related cases sharing an entity + MITRE within the campaign window.
    for i in range(2):
        c = Case(
            case_id=f"demo-camp-{i}", cluster_signature=f"camp-sig-{i}",
            source_surface=SourceSurface.AUTOMATED_SCAN,
            entity=Entity(type=EntityType.USER, value="pnair"),
            rule_ids=["demo_phishing_chain"], mitre=["T1566"],
            status=CaseStatus.ESCALATED, verdict=Verdict.TRUE_POSITIVE,
            created_at=now_iso, updated_at=now_iso, tags=["demo"],
        )
        await demo_state._demo.cases.save(c)

    await demo_state._demo.run_capability_pass()

    demo_campaigns, demo_total = await demo_state._demo.campaign_store.list()
    _real_page, real_total = await demo_state.real_campaign_store.list()
    assert demo_total >= 1 and demo_campaigns, "expected a demo campaign from the two shared-entity cases"
    assert real_total == 0, "the REAL campaign store must be untouched (isolation)"


@pytest.mark.asyncio
async def test_baseline_warms_across_ticks(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    dprefs = demo_state._demo._demo_prefs()
    org = gen.build_org(1337)
    now = to_millis(now_utc())
    # A FIXED event list (same signatures/buckets) routed twice → the baseline sketch's
    # observation count for those signatures must GROW.
    events = gen.hits_to_raw(gen.generate_benign_batch(random.Random(2), org, now, 30, "xdr"), dprefs)

    await demo_state._demo.route_event_batch(list(events), "xdr")
    snap1 = await demo_state._demo.baseline_store.snapshot()
    n1 = sum(st.n for buckets in snap1.values() for st in buckets.values())
    assert n1 > 0, "baseline did not warm on the first batch"

    await demo_state._demo.route_event_batch(list(events), "xdr")
    snap2 = await demo_state._demo.baseline_store.snapshot()
    n2 = sum(st.n for buckets in snap2.values() for st in buckets.values())
    assert n2 > n1, "baseline did not keep learning across ticks"
    # Real baseline store untouched.
    assert await demo_state.real_baseline_store.snapshot() == {}
    assert await demo_state.real_batch_job_store.list() == []


@pytest.mark.asyncio
async def test_rag_shares_one_vectorstore(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    stack = demo_state._demo
    # The pipeline RAG and the chat RAG share ONE store (the duplicate-store bug fix).
    assert stack.pipeline._rag._store is stack.chat_engine._rag._store
    assert stack.pipeline._rag._store is stack.vectorstore


@pytest.mark.asyncio
async def test_rag_seeded_immediately_on_enable(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    stats = await demo_state._demo.vectorstore.stats()
    assert int(stats.get("total_chunks", 0)) > 0, "RAG corpus was not eager-seeded on enable"


@pytest.mark.asyncio
async def test_demo_never_touches_real_stores_capstone(demo_state: AppState) -> None:
    # Drive a full live-ish session: ticks (SIEM alert + XDR/EDR funnel) + a capability pass.
    await demo_state.enable_demo(mode="live", seed=1337, history_days=3)
    for _ in range(6):
        await demo_state.demo_tick()
    await demo_state._demo.run_capability_pass()

    # EVERY real store is empty/untouched — the capstone isolation guard.
    _rc, rt = await demo_state._real_cases.list(limit=50)
    assert rt == 0
    assert await demo_state.real_tuning_store.list() == []
    _real_campaigns, real_total = await demo_state.real_campaign_store.list()
    assert real_total == 0
    assert await demo_state.real_baseline_store.snapshot() == {}
    assert await demo_state.real_proposals.list() == []
    assert await demo_state.real_batch_job_store.list() == []
    real_usage = await demo_state._real_usage_store.summary(window_hours=48)
    assert real_usage["call_count"] == 0


@pytest.mark.asyncio
async def test_disable_mid_capability_pass_does_not_raise(demo_state: AppState) -> None:
    await demo_state.enable_demo(mode="live", seed=1337, history_days=2)
    # Kick a capability pass and a disable "concurrently" — disable tears the stack down;
    # neither must raise into the caller.
    stack = demo_state._demo
    task = asyncio.create_task(stack.run_capability_pass())
    await demo_state.disable_demo()
    try:
        await task
    except Exception as exc:  # noqa: BLE001
        pytest.fail(f"capability pass raised after disable: {exc}")
    status = await demo_state.demo_status()
    assert status["active"] is False


@pytest.mark.asyncio
async def test_reset_demo_preserves_new_config_fields(demo_state: AppState) -> None:
    s1 = await demo_state.enable_demo(
        mode="seeded", seed=1337, history_days=3,
        alert_interval_seconds=90.0, event_rate_per_second=25.0,
        preseed_case_count=4, preseed_event_count=60,
    )
    assert s1["alert_interval_seconds"] == 90.0
    s2 = await demo_state.reset_demo()
    # The overhaul fields survive the disable→enable round-trip (not reset to defaults).
    assert s2["alert_interval_seconds"] == 90.0
    assert s2["event_rate_per_second"] == 25.0
    assert s2["preseed_case_count"] == 4
    assert s2["preseed_event_count"] == 60


@pytest.mark.asyncio
async def test_demo_status_reports_capability_signal(demo_state: AppState) -> None:
    st = await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    for key in ("proposals_open", "campaigns_found", "tuning_events", "rag_chunks", "sources"):
        assert key in st
    assert st["sources"] == [
        "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog", "demo-entra-id",
    ]
    # ALL capabilities must show live signal on a fresh enable — not just RAG. This is the
    # core "everything is on and working" showcase (the guard that was previously too weak,
    # only asserting rag_chunks > 0 while the others silently stayed 0).
    assert int(st["rag_chunks"]) > 0, "RAG corpus not seeded"
    assert int(st["proposals_open"]) > 0, "no demo HITL proposal opened on enable"
    assert int(st["campaigns_found"]) > 0, "no demo campaign formed on enable"
    assert int(st["tuning_events"]) > 0, "no demo tuning observation recorded on enable"
    # The signal is DEMO-scoped — the real capability ledgers stay untouched.
    assert await demo_state.real_proposals.list() == []
    assert await demo_state.real_tuning_store.list() == []
    _real_campaigns, real_camp_total = await demo_state.real_campaign_store.list()
    assert real_camp_total == 0


@pytest.mark.asyncio
async def test_capability_signal_is_purged_on_disable(demo_state: AppState) -> None:
    # The seeded HITL / campaign / tuning signal lives only in the throwaway demo stack:
    # disabling demo tears it down entirely (nothing survives into the real state).
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=2)
    st = await demo_state.demo_status()
    assert int(st["proposals_open"]) > 0 and int(st["campaigns_found"]) > 0
    await demo_state.disable_demo()
    off = await demo_state.demo_status()
    assert off["mode"] == "off" and not off["active"]
    assert int(off["proposals_open"]) == 0 and int(off["campaigns_found"]) == 0
    assert int(off["tuning_events"]) == 0


@pytest.mark.asyncio
async def test_source_logs_demo_segment_returns_rows() -> None:
    # The 5 native demo sources advertise can_browse=true; browsing each must serve a
    # bounded standards-faithful page, not 404 through the real prefs.sources lookup.
    from contextlib import asynccontextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import router as core_router
    from app.api.routes_rag import router as rag_router

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    overrides = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        st = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await st.startup(start_poller=False)
        await st.update_prefs(st.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = st
        yield
        await st.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(core_router)
    api.include_router(rag_router)
    with TestClient(api) as c:
        # Before demo: an unknown source id 404s (the segment id is NOT in prefs.sources).
        assert c.get("/api/sources/demo-splunk/logs").status_code == 404
        assert c.post("/api/demo/enable", json={"mode": "seeded", "seed": 1337}).status_code == 200
        for sid in (
            "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog", "demo-entra-id",
        ):
            r = c.get(f"/api/sources/{sid}/logs?limit=25")
            assert r.status_code == 200, (sid, r.text)
            data = r.json()
            assert data["mode"] in {"search", "buffer"}
            assert data["count"] <= 25
            assert data["logs"] and data["logs"][0]["id"]  # real rows (contract shape)
        # --- Defect (4) via the route: an import during demo lands in the DEMO corpus and
        # is listed there; disabling demo purges it (the real corpus never sees it).
        imp = c.post("/api/rag/import", json={"title": "Demo-only note",
                                              "text": "isolated demo knowledge blob " * 20})
        assert imp.status_code == 200, imp.text
        docs = c.get("/api/rag/documents").json()["documents"]
        assert any(d.get("title") == "Demo-only note" for d in docs)
        assert c.post("/api/demo/disable").status_code == 200
        docs_after = c.get("/api/rag/documents").json()["documents"]
        assert not any(d.get("title") == "Demo-only note" for d in docs_after)


@pytest.mark.asyncio
async def test_demo_rag_routes_isolated_from_real_corpus(demo_state: AppState) -> None:
    # Defect (4) at the seam the routes use: state.rag_service is demo-aware.
    # Off demo it IS the real RagService (production unaffected).
    assert demo_state.rag_service is demo_state.rag

    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1)
    # During demo, rag_service is the demo's shared store — NOT the real corpus.
    assert demo_state.rag_service is demo_state._demo.rag_service
    assert demo_state.rag_service is not demo_state.rag
    res = await demo_state.rag_service.import_document(
        "Demo isolated doc", "demo body text " * 30, source="imported", tags=[],
    )
    assert res.get("chunk_count", 0) > 0
    demo_docs = await demo_state.rag_service.list_documents()
    assert any(d.get("title") == "Demo isolated doc" for d in demo_docs)
    # The REAL corpus never saw the demo import.
    real_docs = await demo_state.rag.list_documents()
    assert not any(d.get("title") == "Demo isolated doc" for d in real_docs)

    await demo_state.disable_demo()
    # Back on the real corpus; the demo import is gone.
    assert demo_state.rag_service is demo_state.rag
    real_docs2 = await demo_state.rag_service.list_documents()
    assert not any(d.get("title") == "Demo isolated doc" for d in real_docs2)


@pytest.mark.asyncio
async def test_demo_baseline_store_stays_bounded_across_many_ticks(demo_state: AppState) -> None:
    # Defect (3): the demo baseline store must NOT grow one signature per unique random IP
    # (~thousands). The EVENT funnel groups by the bounded HOST pool, so the signature
    # cardinality saturates at a small set no matter how many ticks run.
    await demo_state.enable_demo(mode="seeded", seed=1337, history_days=1,
                                 event_rate_per_second=40, tick_seconds=1)
    stack = demo_state._demo
    dprefs = stack._demo_prefs()
    org = gen.build_org(1337)
    rng = random.Random(9)
    now = to_millis(now_utc())
    for _ in range(40):
        # Each tick materialises ~40 benign xdr events with fresh random IPs (as the live
        # simulator does) and routes them through the funnel, then drops the raw list.
        events = gen.hits_to_raw(gen.generate_benign_batch(rng, org, now, 40, "xdr"), dprefs)
        await stack.route_event_batch(events, "xdr")
    snap = await stack.baseline_store.snapshot()
    n_signatures = len(snap)
    # Host-grouped: bounded by the ~10 xdr hosts (× a couple of hour-of-week buckets),
    # never ~1600 unique IPs across 40 ticks.
    assert n_signatures <= 60, f"demo baseline store grew to {n_signatures} signatures (unbounded per-IP!)"
    # It still WARMED (the whole point of flushing observed buckets).
    total_obs = sum(st.n for buckets in snap.values() for st in buckets.values())
    assert total_obs > 0
    # Real baseline store untouched.
    assert await demo_state.real_baseline_store.snapshot() == {}


def test_no_new_real_store_writers_in_demo_runtime() -> None:
    # #0 regression: the demo runtime must NEVER reach a real pipeline/case/audit store.
    import inspect
    from app.engine import demo_runtime

    src = inspect.getsource(demo_runtime)
    for marker in ("_real_pipeline", "_real_cases", "_real_audit"):
        assert marker not in src, f"demo_runtime must not reference {marker} ($0/isolation break)"


def test_demo_mock_provider_calls_ring_is_bounded():
    # audit #47: the long-lived demo provider must not retain every LLM call forever.
    import asyncio

    from app.llm.providers import DemoMockProvider

    prov = DemoMockProvider()
    assert prov.calls.maxlen == 200

    async def drive():
        for i in range(1000):
            await prov.complete("chat", [{"role": "user", "content": f"m{i}"}], "demo", 0.0, 100)

    asyncio.new_event_loop().run_until_complete(drive())
    assert len(prov.calls) == 200, "demo provider call ring must be bounded"
