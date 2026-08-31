"""Round 4 / Wave 4 — runtime wiring: gated schedulers + EVENT-feed routing (offline).

Wave 4 turns the Wave-3 engines/stores from inert plumbing into DRIVEN runtime, WITHOUT
changing default behaviour. Two seams are wired into ``AppState`` + the ``Poller``:

  1. GATED SCHEDULERS — three background asyncio tasks modelled on the poller lifecycle
     (a nightly threshold-tuner pass, a daily campaign-correlation pass, a batch-jobs
     poller loop). All default-OFF: each loop is a NO-OP until its
     ``Preferences.{threshold_tuning,campaign,batch}`` block is enabled. Started under the
     same ``start_poller`` guard the poller uses; cancelled cleanly on shutdown. Demo mode
     keeps ALL real schedulers OFF.

  2. EVENT-FEED ROUTING — when a feed's ``role == 'events'`` AND batch + event-detection
     (baseline) are BOTH enabled, that feed's events route to the detection funnel
     (aggregate→rules→anomaly→batched detection) INSTEAD OF the realtime correlation-window
     read. ALERTS feeds are unchanged. When disabled → the EXISTING realtime path is
     byte-identical (the critical safety property: default OFF = no change).

The invariants under test:
  * with all toggles OFF, startup/shutdown + a poll tick are byte-identical to today (no
    scheduler runs; EVENT feeds still go the realtime path; the poller_manager is
    unaffected);
  * with tuner/campaign/batch enabled the schedulers start and are cancelled cleanly on
    shutdown;
  * with batch + detection enabled an ``events``-role feed routes to the funnel (the
    funnel hook is invoked and the realtime read is SKIPPED for that feed), while an
    ``alerts``-role feed stays on the realtime path;
  * demo mode keeps all real schedulers OFF (the shared gate).

Network-free (the autouse conftest guard blocks non-loopback egress); the funnel hook +
batch submit are patched so nothing touches the network / an LLM.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import (
    BaselineConfig,
    BatchConfig,
    CampaignConfig,
    CorrelationRule,
    Secrets,
    SourceInstance,
    ThresholdTuningConfig,
)
from app.constants import CorrelationMode, EntityType, SourceType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import BatchJob
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio_mark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _make_state() -> AppState:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    mp = MockProvider()
    overrides = {"anthropic": mp, "openai": mp, "mock": mp}
    return AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)


async def _set_threshold(state: AppState, n: int = 3) -> None:
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=3600, group_by=EntityType.IP
    )
    await state.update_prefs(p)


def _fed_source(
    sid: str,
    feeds: list[dict],
    *,
    primary: bool = False,
    severity_scale_max: float | None = None,
) -> SourceInstance:
    """A PULL Elasticsearch source with explicit per-feed ``index_patterns`` (roles).

    ``severity_scale_max`` DECLARES this source's native severity-ladder ceiling. It
    matters for any test that exercises a ``severity_floor``: the floor compares an OCSF
    ``severity_id``, which is derived by projecting the raw severity through the declared
    ceiling. Left ``None`` (undeclared) the projection is the identity on 0-100."""
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=sid,
        enabled=True, is_primary=primary,
        severity_scale_max=severity_scale_max,
        config={"index_patterns": feeds},
    )


async def _configure(state: AppState, sources: list[SourceInstance], **prefs_over) -> None:
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = sources
    for k, v in prefs_over.items():
        setattr(prefs, k, v)
    await state.update_prefs(prefs)
    state.rebuild_log_source()


def _seed(
    state: AppState, index: str, ip: str, n: int = 4, *, severity: float = 7.0
) -> None:
    base = to_millis(now_utc()) - 60_000
    for i in range(n):
        state.es.add_log(index, make_log_event(
            ip=ip, ts_millis=base + i * 1000, severity=severity
        ),
                         doc_id=f"{index}-{ip}-{i}")


# --------------------------------------------------------------------------- #
# 1. ALL TOGGLES OFF — byte-identical boot + poll tick + clean shutdown.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_all_toggles_off_boot_is_byte_identical():
    """A fresh boot with every Round-4 feature OFF spawns the schedulers (they start,
    they immediately sleep) but the poller stays the unchanged PollerManager, the funnel
    hook is wired-but-idle, and shutdown cancels everything cleanly."""
    state = _make_state()
    await state.startup(start_poller=True)
    try:
        # The schedulers were started under start_poller...
        assert state._scheduler_running is True
        assert len(state._scheduler_tasks) == 3
        assert all(not t.done() for t in state._scheduler_tasks)
        # Autopilot overhaul: the smart engines default ON, but setup is incomplete
        # (fresh tenant) so every scheduler tick is gated OFF and NO-OPs; batch stays off.
        assert state._schedulers_gated_off() is True
        assert state.prefs.threshold_tuning.enabled is True
        assert state.prefs.campaign.enabled is True
        assert state.prefs.batch.enabled is False
        # The poller is the unchanged PollerManager; the funnel hook is wired (idle).
        from app.engine.poller_manager import PollerManager
        assert isinstance(state.poller, PollerManager)
        assert state.poller._primary._event_funnel is not None
    finally:
        await state.shutdown()
    # Shutdown cancelled + drained the scheduler tasks (clean).
    assert state._scheduler_running is False
    assert state._scheduler_tasks == []


@asyncio_mark
async def test_events_feed_takes_realtime_path_when_detection_off(app_state: AppState):
    """With batch/detection OFF (the default), a ``role=events`` feed's events flow the
    EXISTING realtime correlate path — the funnel is NEVER invoked (byte-identical)."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "ev-logs", "10.9.0.1", n=4)
    await _configure(app_state, [
        _fed_source("s1", [{"pattern": "ev-logs*", "role": "events"}], primary=True),
    ])

    called: list = []

    async def _spy(events, prefs):
        called.append(len(events))

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Realtime path handled the events → a case formed; the funnel was NOT called.
    assert stats["new"] == 4
    assert stats["clusters"] == 1
    assert stats.get("funnel_routed", 0) == 0
    assert called == []
    _cases, total = await app_state.cases.list()
    assert total == 1


# --------------------------------------------------------------------------- #
# 2. SCHEDULERS ENABLED — start + cancel cleanly on shutdown.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_schedulers_start_and_stop_cleanly_when_enabled():
    state = _make_state()
    # Enable all three schedulers BEFORE startup so they are live from the first tick.
    await state.startup(start_poller=False)  # load prefs first
    prefs = state.prefs.model_copy(deep=True)
    prefs.setup_complete = True
    prefs.threshold_tuning = ThresholdTuningConfig(enabled=True)
    prefs.campaign = CampaignConfig(enabled=True)
    prefs.batch = BatchConfig(enabled=True)
    await state.update_prefs(prefs)
    # Start the schedulers explicitly (startup with start_poller=False skipped them).
    await state._run_schedulers()
    try:
        assert state._scheduler_running is True
        tasks = list(state._scheduler_tasks)
        assert len(tasks) == 3
        # Give the loops a moment to run at least one guarded tick (no crash).
        await asyncio.sleep(0)
        assert all(not t.done() for t in tasks)
    finally:
        await state.shutdown()
    # All three were cancelled + drained.
    assert state._scheduler_running is False
    assert all(t.cancelled() or t.done() for t in tasks)


@asyncio_mark
async def test_run_schedulers_is_idempotent():
    state = _make_state()
    await state.startup(start_poller=True)
    try:
        first = list(state._scheduler_tasks)
        await state._run_schedulers()  # second call is a no-op (already running)
        assert state._scheduler_tasks == first
        assert len(state._scheduler_tasks) == 3
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# 3. EVENT-FEED ROUTING — events→funnel, alerts→realtime, cursor still advances.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_events_feed_routes_to_funnel_when_enabled(app_state: AppState):
    """batch + baseline enabled → an ``events``-role feed routes to the funnel hook and
    the realtime correlate read is SKIPPED for that feed (no case from it)."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "ev-logs", "10.8.0.1", n=5, severity=5.0)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "ev-logs*", "role": "events"}], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    routed: list = []

    async def _spy(events, prefs):
        routed.append([e.id for e in events])

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # The funnel was invoked with the events feed's new events...
    assert len(routed) == 1
    assert len(routed[0]) == 5
    assert stats["funnel_routed"] == 5
    # ...and the realtime read was SKIPPED for that feed → NO case was correlated.
    assert stats["clusters"] == 0
    _cases, total = await app_state.cases.list()
    assert total == 0
    # #4: the feed's durable cursor STILL advanced (never re-read on the next poll).
    stats2 = await app_state.poller.poll_once(app_state.prefs)
    assert stats2["funnel_routed"] == 0  # nothing new to route


@asyncio_mark
async def test_event_funnel_failure_preserves_cursor_and_retries(app_state: AppState):
    """A rejected async handoff cannot advance the contributing feed cursor."""
    _seed(app_state, "retry-events", "10.8.0.8", n=4, severity=5.0)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "retry-events*", "role": "events"}], primary=True)],
        batch=BatchConfig(enabled=True, severity_floor=3),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )
    calls = 0

    async def _flaky(events, prefs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("outbox unavailable")
        return True

    app_state.poller._primary._event_funnel = _flaky
    first = await app_state.poller.poll_once(app_state.prefs)
    assert first["funnel_routed"] == 4
    # Cursor stayed put, so the exact same work is retried and then accepted.
    second = await app_state.poller.poll_once(app_state.prefs)
    assert second["funnel_routed"] == 4
    assert calls == 2
    third = await app_state.poller.poll_once(app_state.prefs)
    assert third["funnel_routed"] == 0


@asyncio_mark
async def test_outbox_save_failure_replays_against_unconsumed_baseline(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch
):
    """Failed durable acceptance must not mutate the live baseline before replay."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "staged-events", "10.8.0.11", n=4, severity=5.0)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "staged-events*", "role": "events"}], primary=True)],
        batch=BatchConfig(enabled=True, severity_floor=3),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )
    attempts: list[set[str]] = []

    async def _flaky_submit(provider, model, requests, *, candidates=None):
        attempts.append(set((candidates or {}).keys()))
        if len(attempts) == 1:
            raise RuntimeError("local outbox save failed")
        return BatchJob(id="accepted", provider=provider, model=model)

    monkeypatch.setattr(app_state.batch_service, "submit", _flaky_submit)
    first = await app_state.poller.poll_once(app_state.prefs)
    assert first["funnel_routed"] == 4
    second = await app_state.poller.poll_once(app_state.prefs)
    assert second["funnel_routed"] == 4
    # The candidate survived replay with its stable id because the failed attempt's
    # staged baseline was discarded rather than published.
    assert len(attempts) == 2
    assert attempts[0] and attempts[1] == attempts[0]
    third = await app_state.poller.poll_once(app_state.prefs)
    assert third["funnel_routed"] == 0


@asyncio_mark
async def test_high_event_feed_stays_synchronous_above_batch_floor(app_state: AppState):
    """``severity_floor`` governs eligibility; high EVENT records remain realtime.

    The source DECLARES a 0-10 native ladder, which is what makes a raw 7 genuinely high
    (7/10 -> 70 -> severity_id 4, above the floor of 3). Before the ladder was declarable
    this leaned on the ``raw <= 10 ? raw*10`` magnitude guess; an operator whose feed
    really is 0-10 now says so, and a feed that never declares one is read on 0-100 —
    see ``test_undeclared_event_feed_reads_a_raw_severity_on_the_identity_ladder``."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "high-events", "10.8.0.9", n=4, severity=7.0)
    await _configure(
        app_state,
        [_fed_source(
            "s1", [{"pattern": "high-events*", "role": "events"}],
            primary=True, severity_scale_max=10.0,
        )],
        batch=BatchConfig(enabled=True, severity_floor=3),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )
    routed: list[int] = []

    async def _spy(events, prefs):
        routed.append(len(events))

    app_state.poller._primary._event_funnel = _spy
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert routed == []
    assert stats["funnel_routed"] == 0
    assert stats["clusters"] == 1


@asyncio_mark
async def test_undeclared_event_feed_reads_a_raw_severity_on_the_identity_ladder(
    app_state: AppState,
):
    """The SAME feed with NO declared ceiling reads the raw 7 on 0-100 — and is NEVER dropped.

    This is the behaviour change the declared ladder replaces: without a declaration
    there is no evidence a raw 7 means "7 out of 10", so it projects through the identity
    (severity_id 1) and falls BELOW the batch severity floor. Non-negotiable #4 still
    holds — a below-floor event is batch-eligible, i.e. it goes to the async funnel, not
    to the bin. An operator whose feed really is 0-10 declares
    ``severity_scale_max: 10`` and gets the synchronous path back (the sibling test).
    """
    await _set_threshold(app_state, 3)
    _seed(app_state, "undeclared-events", "10.8.0.11", n=4, severity=7.0)
    await _configure(
        app_state,
        [_fed_source(
            "s1", [{"pattern": "undeclared-events*", "role": "events"}], primary=True,
        )],
        batch=BatchConfig(enabled=True, severity_floor=3),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )
    routed: list[int] = []

    async def _spy(events, prefs):
        routed.append(len(events))

    app_state.poller._primary._event_funnel = _spy
    stats = await app_state.poller.poll_once(app_state.prefs)
    # Routed to the async funnel rather than investigated synchronously — nothing lost.
    assert sum(routed) == 4
    assert stats["funnel_routed"] == 4


@asyncio_mark
async def test_no_candidate_funnel_outcome_advances_cursor(app_state: AppState):
    """A deterministic no-candidate outcome is handled, not retried forever."""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.NEVER, n=3, window_seconds=3600, group_by=EntityType.IP
    )
    await app_state.update_prefs(prefs)
    _seed(app_state, "quiet-events", "10.8.0.10", n=2, severity=5.0)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "quiet-events*", "role": "events"}], primary=True)],
        batch=BatchConfig(enabled=True, severity_floor=3),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=100),
    )
    first = await app_state.poller.poll_once(app_state.prefs)
    assert first["funnel_routed"] == 2
    second = await app_state.poller.poll_once(app_state.prefs)
    assert second["funnel_routed"] == 0


@asyncio_mark
async def test_alerts_feed_stays_on_realtime_path_when_detection_on(app_state: AppState):
    """Even with batch + detection ON, an ``alerts``-role feed is UNCHANGED — it stays on
    the realtime path (alerts auto-forward), and the funnel is NOT called for it."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "al-logs", "10.7.0.1", n=4)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "al-logs*", "role": "alerts"}], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    called: list = []

    async def _spy(events, prefs):
        called.append(len(events))

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Alerts feed → realtime path (a case forms); the funnel is untouched.
    assert stats.get("funnel_routed", 0) == 0
    assert called == []
    assert stats["clusters"] == 1


@asyncio_mark
async def test_mixed_feeds_split_events_to_funnel_alerts_to_realtime(app_state: AppState):
    """A source with BOTH an events feed and an alerts feed splits: events → funnel,
    alerts → realtime, in the SAME poll tick."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "mix-events", "10.6.0.1", n=4, severity=5.0)
    _seed(app_state, "mix-alerts", "10.6.0.2", n=4)
    await _configure(
        app_state,
        [_fed_source("s1", [
            {"pattern": "mix-events*", "role": "events"},
            {"pattern": "mix-alerts*", "role": "alerts"},
        ], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    routed: list = []

    async def _spy(events, prefs):
        routed.extend(e.ip for e in events)

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Only the events-feed IP was routed to the funnel...
    assert set(routed) == {"10.6.0.1"}
    assert stats["funnel_routed"] == 4
    # ...and the alerts feed produced a case on the realtime path.
    assert stats["clusters"] == 1
    cases, total = await app_state.cases.list()
    assert total == 1
    assert cases[0].entity.value == "10.6.0.2"


# --------------------------------------------------------------------------- #
# 4. DEMO MODE keeps every REAL scheduler OFF (the shared gate).
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_demo_mode_gates_all_real_schedulers_off():
    state = _make_state()
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(deep=True)
    prefs.setup_complete = True
    prefs.threshold_tuning = ThresholdTuningConfig(enabled=True)
    prefs.campaign = CampaignConfig(enabled=True)
    prefs.batch = BatchConfig(enabled=True)
    await state.update_prefs(prefs)
    try:
        # Engage demo mode: the shared scheduler gate must now return "gated off".
        await state.enable_demo(mode="seeded")
        assert state.demo_active is True
        assert state._schedulers_gated_off() is True
        # And the poller's own event routing never runs against demo (the run loop gates
        # demo before the funnel; the gate helper reflects that here).
    finally:
        await state.shutdown()


@asyncio_mark
async def test_schedulers_gated_off_when_polling_paused_or_kill_switch():
    state = _make_state()
    await state.startup(start_poller=False)
    try:
        # setup incomplete → gated off.
        assert state._schedulers_gated_off() is True
        # setup complete, polling on, no kill-switch → NOT gated.
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.polling_enabled = True
        await state.update_prefs(prefs)
        assert state._schedulers_gated_off() is False
        # kill-switch on → gated off again.
        prefs2 = state.prefs.model_copy(deep=True)
        prefs2.caps = prefs2.caps.model_copy(update={"kill_switch": True})
        await state.update_prefs(prefs2)
        assert state._schedulers_gated_off() is True
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# 5. poller_manager fan-out is unaffected — routing lives per-Poller.
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# 6. HEADLINE WIRING — a CONFIRMED batch detection RE-ENTERS the pipeline and
#    creates a Case with the SAME cluster_signature, via decide() (Wave-6 H1 #2).
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_confirmed_batch_detection_reenters_pipeline_and_creates_case(app_state: AppState):
    """The headline gap the harden wave closes: a batched EVENT-detection that the LLM
    CONFIRMS must actually create a Case — built via the NORMAL pipeline (register +
    investigate), with a ``cluster_signature`` byte-identical to
    ``cluster_signature(entity_type, value)`` for that entity, and the UNCHANGED
    deterministic ``decide()`` run once (the case carries a verdict/status)."""
    from app.constants import EntityType
    from app.engine import event_detection as evdet
    from app.engine.signatures import cluster_signature
    from app.llm.batch import BatchResult
    from app.models import BatchJob, RawEvent

    # Enable batch + baseline (the funnel/detection toggle the re-entry gates on).
    prefs = app_state.prefs.model_copy(deep=True)
    from app.config import BaselineConfig, BatchConfig
    prefs.batch = BatchConfig(enabled=True)
    prefs.baseline = BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1)
    prefs.setup_complete = True
    await app_state.update_prefs(prefs)

    # Build a surviving funnel candidate from real member events for one entity.
    ip = "203.0.113.55"
    base = to_millis(now_utc()) - 60_000
    members = [
        RawEvent(id=f"m{i}", index="ev-logs", source={"source": {"ip": ip}},
                 timestamp_millis=base + i * 1000, ip=ip, rule="linux_auth", severity=5.0)
        for i in range(4)
    ]
    summaries = evdet.pre_aggregate(members, app_state.prefs)
    assert summaries, "pre_aggregate must yield a bucket summary"
    custom_id = "evdet-test-cid"
    candidate = evdet.CandidateAlert(
        summary=summaries[0], detection_source="anomaly", modified_z=8.0, custom_id=custom_id,
    )

    # Persist the candidate onto a BatchJob exactly as _route_event_feed would at submit.
    job = BatchJob(
        id="batch-detect-1", provider="anthropic", model="claude-haiku-4-5-20251001",
        custom_ids={custom_id: {"retrieved": False, "result_state": None}},
        candidates={custom_id: evdet.candidate_to_json(candidate)},
    )

    # The LLM CONFIRMS the detection for this custom_id.
    results = [BatchResult(
        custom_id=custom_id, result_type="succeeded",
        text='{"detection": true, "confidence": 0.95, "reason": "brute force"}',
        prompt_tokens=50, completion_tokens=10, model="claude-haiku-4-5-20251001",
    )]

    reentered = await app_state._reenter_detections(job, results)
    assert reentered == 1

    # A Case now exists whose cluster_signature is byte-identical to the normal path's.
    expected_sig = cluster_signature(EntityType.IP, ip)
    cases, total = await app_state.cases.list()
    assert total == 1
    case = cases[0]
    assert case.cluster_signature == expected_sig
    assert case.entity.type == EntityType.IP and case.entity.value == ip
    # decide() ran once → the case carries a verdict + a routed status (NEEDS_HUMAN under
    # the mock investigator; the point is decide() produced a status, not a specific one).
    assert case.verdict is not None
    assert case.status is not None


@asyncio_mark
async def test_unconfirmed_batch_detection_creates_no_case(app_state: AppState):
    """Fail-closed: a batch result that does NOT confirm the detection re-enters nothing
    (no case), so a benign aggregate the model rejects never becomes a case on its own."""
    from app.engine import event_detection as evdet
    from app.llm.batch import BatchResult
    from app.models import BatchJob, RawEvent

    prefs = app_state.prefs.model_copy(deep=True)
    from app.config import BaselineConfig, BatchConfig
    prefs.batch = BatchConfig(enabled=True)
    prefs.baseline = BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1)
    await app_state.update_prefs(prefs)

    ip = "198.51.100.7"
    members = [RawEvent(id=f"m{i}", index="ev-logs", source={"source": {"ip": ip}},
                        timestamp_millis=1_700_000_000_000 + i, ip=ip, rule="linux_auth")
               for i in range(3)]
    summaries = evdet.pre_aggregate(members, app_state.prefs)
    cid = "evdet-benign"
    cand = evdet.CandidateAlert(summary=summaries[0], detection_source="anomaly",
                                modified_z=6.0, custom_id=cid)
    job = BatchJob(id="batch-benign", provider="anthropic", model="m",
                   candidates={cid: evdet.candidate_to_json(cand)})
    results = [BatchResult(custom_id=cid, result_type="succeeded",
                           text='{"detection": false, "confidence": 0.9}')]
    reentered = await app_state._reenter_detections(job, results)
    assert reentered == 0
    _cases, total = await app_state.cases.list()
    assert total == 0


@asyncio_mark
async def test_reentry_gated_off_when_detection_disabled(app_state: AppState):
    """With batch/baseline OFF (default), re-entry is a strict no-op even if a job somehow
    carries persisted candidates — the default-OFF safety property holds end to end."""
    from app.engine import event_detection as evdet
    from app.llm.batch import BatchResult
    from app.models import BatchJob, RawEvent

    ip = "203.0.113.99"
    members = [RawEvent(id="m0", index="ev-logs", source={"source": {"ip": ip}},
                        timestamp_millis=1_700_000_000_000, ip=ip, rule="linux_auth")]
    summaries = evdet.pre_aggregate(members, app_state.prefs)
    cid = "evdet-off"
    cand = evdet.CandidateAlert(summary=summaries[0], detection_source="anomaly",
                                modified_z=9.0, custom_id=cid)
    job = BatchJob(id="batch-off", provider="anthropic", model="m",
                   candidates={cid: evdet.candidate_to_json(cand)})
    results = [BatchResult(custom_id=cid, result_type="succeeded",
                           text='{"detection": true, "confidence": 0.99}')]
    # batch/baseline are OFF by default in the app_state fixture.
    assert await app_state._reenter_detections(job, results) == 0
    _cases, total = await app_state.cases.list()
    assert total == 0


@asyncio_mark
async def test_poller_manager_fanout_unaffected_by_routing_wiring(app_state: AppState):
    """The funnel hook rides the PRIMARY child (state-wired). With detection OFF the
    poller_manager fan-out across multiple sources is byte-identical — both sources still
    form their cases, unaffected by the new wiring."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "a-logs", "10.5.0.1")
    _seed(app_state, "b-logs", "10.5.0.2")
    await _configure(app_state, [
        SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH, display_name="a",
                       enabled=True, is_primary=True, config={"data_view_pattern": "a-logs*"}),
        SourceInstance(id="b", source_type=SourceType.ELASTICSEARCH, display_name="b",
                       enabled=True, config={"data_view_pattern": "b-logs*"}),
    ])
    # The primary child carries the state-wired hook; the fan-out is untouched.
    assert app_state.poller._primary._event_funnel is not None
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] >= 2
    _cases, total = await app_state.cases.list()
    assert total == 2
