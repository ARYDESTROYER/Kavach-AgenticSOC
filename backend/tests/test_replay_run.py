"""End-to-end replay runs: pinned inputs, frozen evidence, and a bound that cancels."""

from __future__ import annotations

import asyncio
import fnmatch
import json
from datetime import timedelta

import pytest

from app.connectors.base import StructuredQuery
from app.constants import USAGE_INDEX
from app.engine.replay.fixtures import LoadedFixture, build_fixture
from app.engine.replay.stack import ReplayLogSource, ReplaySpendLimiter
from app.stores.usage import UsageStore
from app.es.fake import InMemoryESClient
from app.utils import now_utc, to_millis

from tests.replay_support import (
    capture,
    capture_candidate,
    cells_of,
    make_cluster,
    quiet,
    replay_params,
    report_of,
    run_replay,
    seed_corpus,
)


async def _expire_lease(state, job_id: str) -> None:
    """Age the worker lease so the product's own recovery path re-claims the job."""
    def change(jobs, _keys):
        jobs[job_id].lease_expires_at_millis = 1
        return None

    await state.jobs._mutate(change)


def _usage_count(es: InMemoryESClient) -> int:
    return sum(
        len(docs)
        for index, docs in es.docs.items()
        if fnmatch.fnmatch(index, f"{USAGE_INDEX}*")
    )


@pytest.mark.asyncio
async def test_same_fixture_replayed_twice_yields_identical_retrieval_inputs(
    app_state, tmp_path
):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.50")

    job = await run_replay(
        app_state,
        replay_params([fixture_id], arms=[{"arm_id": "a"}], repeats=2),
    )
    cells = cells_of(app_state, job)
    assert len(cells) == 2
    # Non-vacuity guard: a run that retrieved nothing would otherwise pass trivially.
    assert all(cell["retrieval_observation_status"] == "measured" for cell in cells)
    assert all(cell["knowledge_refs"] for cell in cells)
    assert len({cell["retrieval_input_fingerprint"] for cell in cells}) == 1
    assert cells[0]["knowledge_refs"] == cells[1]["knowledge_refs"]
    report = report_of(app_state, job)
    assert report["corpus"]["chunk_count"] == 3
    assert report["noise_floor"]["per_arm"][0]["retrieval_disagreement_rate"] == 0.0
    assert report["retrieval"] == {
        "measured_cells": 2,
        "unmeasured_cells": 0,
        "identical_within_arm_repeat": 1,
        "differing_within_arm_repeat": 0,
    }
    # The in-run status is a cross-check, not the authority: it may legitimately
    # differ only where apply() maps an escalation onto its own status.
    for cell in cells:
        if not cell["decide"]["escalate"]:
            assert cell["in_run_status"] == cell["decide"]["status"]


@pytest.mark.asyncio
async def test_pinned_corpus_survives_a_live_corpus_change_mid_run(app_state, tmp_path):
    """Proves PINNING, not merely determinism: the live store moves under the run."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state, count=3)
    fixture_id = await capture(app_state, ip="203.0.113.51")

    from app.engine.replay import job as replay_job

    original = replay_job._run_cell
    mutated = {"done": False}

    async def mutating_cell(run, fixture, arm, repeat):
        record = await original(run, fixture, arm, repeat)
        if not mutated["done"]:
            mutated["done"] = True
            await seed_corpus(app_state, count=9)
        return record

    replay_job._run_cell = mutating_cell
    try:
        job = await run_replay(
            app_state, replay_params([fixture_id], arms=[{"arm_id": "a"}], repeats=2)
        )
    finally:
        replay_job._run_cell = original

    cells = cells_of(app_state, job)
    assert len({cell["retrieval_input_fingerprint"] for cell in cells}) == 1
    report = report_of(app_state, job)
    assert report["corpus"]["chunk_count"] == 3
    assert await app_state.rag.store.count() == 9


@pytest.mark.asyncio
async def test_frozen_log_source_answers_a_relative_window_on_an_old_fixture(app_state):
    """Without capture-instant anchoring every model query on an aged fixture is empty."""
    old_millis = to_millis(now_utc() - timedelta(days=30))
    cluster = make_cluster(ip="203.0.113.52", events=3, ts_millis=old_millis)
    body = build_fixture(capture_candidate(cluster, app_state.prefs))
    body["captured_at_millis"] = old_millis
    source = ReplayLogSource(LoadedFixture(body))
    try:
        result = await source.search(
            app_state.prefs,
            StructuredQuery(ip="203.0.113.52", time_from="now-24h", time_to="now"),
        )
        assert len(result.events) == 3
        fetched = await source.fetch_by_ids(app_state.prefs, ["rev0"], 10)
        assert len(fetched.events) == 1
    finally:
        await source.close()


@pytest.mark.asyncio
async def test_spend_bound_cancels_before_a_single_call_can_exceed_it(app_state, tmp_path):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.53")
    before = _usage_count(app_state.es)

    job = await run_replay(
        app_state,
        replay_params(
            [fixture_id], arms=[{"arm_id": "a"}], repeats=1, spend_bound_usd=1e-9
        ),
    )
    report = report_of(app_state, job)
    assert job.status.value == "cancelled"
    assert report["spend"]["tripped"] is True
    assert report["spend"]["tripped_reason"] == "replay_bound"
    assert report["spend"]["accrued_usd"] <= report["spend"]["bound_usd"]
    # The call that would have crossed the line was never dispatched.
    assert _usage_count(app_state.es) == before
    assert report["excluded"]["spend_bound"] >= 1
    assert report["cells"]["scored"] == 0
    assert report["arm_comparison"]["verdict"] == "insufficient_evidence"
    for cell in cells_of(app_state, job):
        assert cell["excluded"] is True
        assert cell["exclusion_reason"] == "spend_bound"


@pytest.mark.asyncio
async def test_spend_bound_stops_a_multi_fixture_run_at_the_ceiling(app_state, tmp_path):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    first = await capture(app_state, ip="203.0.113.54")

    probe = await run_replay(
        app_state,
        replay_params([first], arms=[{"arm_id": "a"}], repeats=1, spend_bound_usd=5.0),
    )
    one_fixture_cost = report_of(app_state, probe)["spend"]["accrued_usd"]
    assert one_fixture_cost > 0

    second = await capture(app_state, ip="203.0.113.55")
    before = _usage_count(app_state.es)
    job = await run_replay(
        app_state,
        replay_params(
            [first, second], arms=[{"arm_id": "a"}], repeats=1,
            spend_bound_usd=one_fixture_cost,
        ),
    )
    report = report_of(app_state, job)
    assert job.status.value == "cancelled"
    assert report["spend"]["tripped"] is True
    # The residual guarantee, not "accrued <= bound": the pre-flight estimate is
    # worst-case in the OUTPUT dimension only, so realised spend can exceed the bound
    # by at most the estimation error of ONE call. It can never exceed it by a WHOLE
    # call, because the accrued actual is re-read before every call.
    assert report["spend"]["accrued_usd"] < report["spend"]["bound_usd"] * 2
    assert _usage_count(app_state.es) - before <= report["spend"]["cells_run"] * 8


@pytest.mark.asyncio
async def test_embedding_spend_is_bounded_too(app_state, tmp_path):
    """Embeddings are metered but not budget-gated upstream, so the run gates them."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.56")

    from app.engine.replay.stack import ReplayGateway

    calls: list[str] = []
    original = ReplayGateway.embed_with_provenance

    async def spy(self, texts, model_cfg, *, surface="rag", case_id=None):
        calls.append("attempt")
        return await original(self, texts, model_cfg, surface=surface, case_id=case_id)

    ReplayGateway.embed_with_provenance = spy  # type: ignore[assignment]
    try:
        job = await run_replay(
            app_state,
            replay_params(
                [fixture_id], arms=[{"arm_id": "a"}], repeats=1, spend_bound_usd=1e-9
            ),
        )
    finally:
        ReplayGateway.embed_with_provenance = original  # type: ignore[assignment]
    report = report_of(app_state, job)
    assert job.status.value == "cancelled"
    assert report["spend"]["accrued_usd"] == 0.0


@pytest.mark.asyncio
async def test_tenant_budget_block_cancels_rather_than_degrading(app_state, tmp_path):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.57")
    prefs = app_state.prefs.model_copy(
        update={
            "budget": app_state.prefs.budget.model_copy(
                update={"enabled": True, "daily_usd": 1e-9, "on_exceed": "block"}
            )
        }
    )
    await app_state.update_prefs(prefs)

    job = await run_replay(
        app_state,
        replay_params([fixture_id], arms=[{"arm_id": "a"}], repeats=1),
    )
    report = report_of(app_state, job)
    assert job.status.value == "cancelled"
    assert report["spend"]["tripped_reason"] == "tenant_budget"
    assert report["cells"]["scored"] == 0


@pytest.mark.asyncio
async def test_spend_limiter_boundary_semantics():
    mirror = UsageStore(InMemoryESClient())
    limiter = ReplaySpendLimiter(1.0, mirror)
    assert await limiter.authorize(1.0) is True       # exactly at the bound is allowed
    assert await limiter.authorize(1.0000001) is False  # one cent over is refused
    assert limiter.tripped is True
    assert limiter.tripped_reason == "replay_bound"
    # Once tripped it stays tripped, so no later call can slip through.
    assert await limiter.authorize(0.0) is False


@pytest.mark.asyncio
async def test_an_interrupted_replay_is_refused_rather_than_resumed(app_state, tmp_path):
    """The bound is PER JOB, so a second attempt must not get a fresh copy of it.

    The run's accrual lives in a run-scoped ledger mirror a new worker cannot rebuild,
    so resuming would hand the remaining fixtures an untouched bound and let one
    interruption spend the operator's ceiling twice.
    """
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    first = await capture(app_state, ip="203.0.113.58")
    second = await capture(app_state, ip="203.0.113.59")

    from tests.replay_support import submit

    params = replay_params([first, second], arms=[{"arm_id": "a"}], repeats=1)
    job, token = await submit(app_state, params)
    interrupted = sorted([first, second])[0]
    await app_state.jobs.begin_item(job.job_id, token, interrupted)
    await app_state.jobs.complete_item(
        job.job_id, token, interrupted,
        error="worker interrupted after execution began; item was not retried",
    )
    before = _usage_count(app_state.es)

    await app_state.job_runner._execute(job, token)

    final = await app_state.jobs.get(job.job_id)
    assert final is not None and final.status.value == "failed"
    assert any("cannot be resumed" in failure.reason for failure in final.failures)
    # The refusal spends NOTHING: no second bound, no partial artifact.
    assert _usage_count(app_state.es) == before
    assert final.result is not None and not final.result.artifact_id


@pytest.mark.asyncio
async def test_a_recovered_replay_cannot_spend_the_bound_a_second_time(app_state, tmp_path):
    """End to end through the product's own lease recovery, not a stub."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    ids = [await capture(app_state, ip=f"203.0.113.{70 + i}") for i in range(4)]

    from app.engine.replay import job as replay_job
    from tests.replay_support import submit

    params = replay_params(ids, arms=[{"arm_id": "a"}], repeats=1, spend_bound_usd=5.0)
    job, token = await submit(app_state, params)

    original = replay_job._run_cell
    seen = {"cells": 0}

    async def interrupting_cell(run, fixture, arm, repeat):
        record = await original(run, fixture, arm, repeat)
        seen["cells"] += 1
        if seen["cells"] >= 2:
            # The process-shutdown path ``JobRunner._execute`` already handles: the
            # lease is deliberately left behind for a later worker to recover.
            raise asyncio.CancelledError()
        return record

    replay_job._run_cell = interrupting_cell
    try:
        with pytest.raises(asyncio.CancelledError):
            await app_state.job_runner._execute(job, token)
    finally:
        replay_job._run_cell = original

    spent_first = _usage_count(app_state.es)
    assert spent_first > 0, "positive control: the first attempt must have spent"

    # Age the lease and recover the job exactly as a new worker would.
    await _expire_lease(app_state, job.job_id)
    recovered = await app_state.jobs.claim_next("worker-2", lease_millis=300_000)
    assert recovered is not None
    resumed, resumed_token = recovered
    await app_state.job_runner._execute(resumed, resumed_token)

    final = await app_state.jobs.get(job.job_id)
    assert final is not None and final.status.value == "failed"
    # Not one further billable call against a bound the second attempt cannot see.
    assert _usage_count(app_state.es) == spent_first


@pytest.mark.asyncio
async def test_operator_cancel_is_observed_within_one_cell(app_state, tmp_path):
    """A fixture-only checkpoint would run every remaining cell after Cancel."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.80")

    from app.engine.replay import job as replay_job
    from tests.replay_support import submit

    params = replay_params(
        [fixture_id], arms=[{"arm_id": "a"}, {"arm_id": "b"}],
        repeats=3, spend_bound_usd=50.0,
    )
    job, token = await submit(app_state, params)

    original = replay_job._run_cell
    state = {"cells": 0, "after_cancel": 0, "at_cancel": 0}

    async def cancelling_cell(run, fixture, arm, repeat):
        record = await original(run, fixture, arm, repeat)
        state["cells"] += 1
        if state["cells"] == 1:
            await app_state.jobs.request_cancel(job.job_id, job.actor, job.actor_generation)
            state["at_cancel"] = _usage_count(app_state.es)
        return record

    replay_job._run_cell = cancelling_cell
    try:
        await app_state.job_runner._execute(job, token)
    finally:
        replay_job._run_cell = original

    final = await app_state.jobs.get(job.job_id)
    assert final is not None and final.status.value == "cancelled"
    # At most the cell already in flight; never the remaining five of six.
    assert state["cells"] <= 2
    assert _usage_count(app_state.es) == state["at_cancel"]
    # The durable failure record must not blame the spend bound for an operator stop.
    assert not any("spend bound" in failure.reason for failure in final.failures)
    assert any("cancellation requested" in failure.reason for failure in final.failures)


@pytest.mark.asyncio
async def test_a_fixture_that_fails_mid_run_leaves_both_arms_denominators(app_state, tmp_path):
    """A half-run fixture must not leave the first arm's cell scored."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    good = await capture(app_state, ip="203.0.113.85")
    doomed = await capture(app_state, ip="203.0.113.86")

    from app.engine.replay import job as replay_job

    original = replay_job._run_cell

    async def failing_cell(run, fixture, arm, repeat):
        if fixture.fixture_id == doomed and arm.arm_id == "b":
            raise RuntimeError("simulated second-arm failure")
        return await original(run, fixture, arm, repeat)

    replay_job._run_cell = failing_cell
    try:
        job = await run_replay(app_state, replay_params([good, doomed], repeats=1))
    finally:
        replay_job._run_cell = original

    report = report_of(app_state, job)
    assert report["excluded"]["fixture_aborted"] >= 1
    for cell in cells_of(app_state, job):
        if cell["fixture_id"] == doomed:
            assert cell["excluded"] is True
            assert cell["exclusion_reason"] == "fixture_aborted"
    # Both arms therefore report the same paired population.
    for arm in report["arms"]:
        assert arm["n_primary_paired"] == report["arm_comparison"]["n_pairs"]


@pytest.mark.asyncio
async def test_a_partial_run_still_reports_its_symmetric_pairs(app_state, tmp_path):
    """An unavailable fixture leaves BOTH arms, so the surviving pairs remain valid."""
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    good = await capture(app_state, ip="203.0.113.61")
    missing = "fx-" + "e" * 32

    job = await run_replay(app_state, replay_params([good, missing], repeats=2))
    report = report_of(app_state, job)
    assert job.status.value == "partial"
    assert report["fixtures"]["unavailable"] == 1
    assert report["excluded"]["fixture_unavailable"] == 1
    assert report["arm_comparison"]["n_pairs"] == 1
    assert report["arm_comparison"]["reason"] != "run_incomplete"
    assert report["arm_comparison"]["verdict"] in {
        "no_discordant_pairs", "indistinguishable_from_noise",
        "difference_exceeds_noise_floor",
    }


@pytest.mark.asyncio
async def test_an_empty_corpus_is_refused_before_anything_is_spent(app_state, tmp_path):
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    fixture_id = await capture(app_state, ip="203.0.113.60")
    before = _usage_count(app_state.es)
    job = await run_replay(
        app_state, replay_params([fixture_id], arms=[{"arm_id": "a"}], repeats=1)
    )
    assert job.status.value == "failed"
    assert any("corpus is empty" in failure.reason for failure in job.failures)
    assert _usage_count(app_state.es) == before


@pytest.mark.asyncio
async def test_memory_enabled_is_an_arm_knob_that_actually_varies_the_prompt(
    app_state, mock_provider, tmp_path
):
    """A declared arm knob that changes nothing makes the whole comparison void.

    Asserted on the PROMPTS the provider received, not on the verdicts: with a mock
    provider the verdicts are identical either way, which is exactly how a dead knob
    survives review.
    """
    app_state.secrets.jobs_artifact_dir = str(tmp_path)
    await quiet(app_state)
    await seed_corpus(app_state)
    canary = "OPERATOR-FACT-CANARY-REPLAY"
    await app_state.real_memory.add(text=f"{canary}: this host is a scanner", author="op")
    fixture_id = await capture(app_state, ip="203.0.113.90")
    mock_provider.calls.clear()

    job = await run_replay(
        app_state,
        replay_params(
            [fixture_id], repeats=1,
            arms=[{"arm_id": "on", "memory_enabled": True},
                  {"arm_id": "off", "memory_enabled": False}],
        ),
    )
    assert job.status.value == "succeeded"

    seen = {"on": False, "off": False}
    order = ["on", "off"]
    investigator_calls = [c for c in mock_provider.calls if c["role"] == "investigator"]
    assert len(investigator_calls) == 2, investigator_calls
    for arm_id, call in zip(order, investigator_calls):
        seen[arm_id] = canary in json.dumps(call["messages"])
    assert seen == {"on": True, "off": False}

    # And the report NAMES the knob that distinguished the arms.
    report = report_of(app_state, job)
    knobs = {arm["arm_id"]: arm["knobs"] for arm in report["arms"]}
    assert knobs == {"on": {"memory_enabled": True}, "off": {"memory_enabled": False}}


@pytest.mark.asyncio
async def test_a_non_ecs_sources_field_mapping_survives_into_the_replay(app_state):
    """Without the captured overlay the investigator's log tool returns nothing."""
    from app.config import SourceInstance
    from app.connectors.elastic import ElasticConnector
    from app.constants import SourceType
    from app.engine.correlation import cluster_from_events
    from app.engine.replay.fixtures import (
        LoadedFixture, build_fixture, source_field_mapping,
    )
    from app.engine.replay.stack import replay_prefs
    from app.models import RawEvent
    from app.ocsf.model import OCSFEvent

    source = SourceInstance(
        id="wz", source_type=SourceType.WAZUH, is_primary=True,
        config={
            "time_field": "timestamp",
            "source_ip_field": "data.srcip",
            "user_field": "data.dstuser",
            "host_field": "agent.name",
            "rule_field": "rule.groups",
            "severity_field": "rule.level",
        },
    )
    prefs = app_state.prefs.model_copy(update={"sources": [source]})
    captured = now_utc()
    now_millis = to_millis(captured)
    # The records precede the capture instant, as any real fixture's do.
    occurred = captured - timedelta(minutes=5)
    records = [
        {
            "timestamp": occurred.isoformat(),
            "data": {"srcip": "198.51.100.7", "dstuser": "root"},
            "agent": {"name": "srv-a"},
            "rule": {"groups": "authentication_failed", "level": 9},
        }
        for _ in range(3)
    ]
    events = [
        RawEvent(
            id=f"nz{index}", index="site-alerts-01", ts_millis=to_millis(occurred),
            source=record, ip="198.51.100.7", user="root", host="srv-a",
            rule="authentication_failed", severity=9.0, source_id="wz",
            ocsf=OCSFEvent(raw_data=record),
        )
        for index, record in enumerate(records)
    ]
    from app.constants import EntityType

    cluster = cluster_from_events(EntityType.IP, "198.51.100.7", events)
    body = build_fixture({
        "cluster": cluster.model_dump(mode="json"),
        "enrichment": None,
        "evidence_fields": list(prefs.evidence_fields_for(["wz"])),
        "evidence_max_chars": int(prefs.evidence_budget_for(["wz"])),
        "field_mapping": source_field_mapping(prefs, ["wz"]),
        "origin_case_id": "case-wz",
        "source_surface": "automated_scan",
    })
    body["captured_at_millis"] = now_millis
    fixture = LoadedFixture(body)
    assert fixture.mapping_overrides["time_field"] == "timestamp"

    # PRODUCTION: the real connector over the same records, with the source overlay.
    prod_es = InMemoryESClient()
    for hit in fixture.raw_hits:
        prod_es.add_log("site-alerts-01", hit["_source"], doc_id=hit["_id"])
    production = await ElasticConnector(
        prod_es, {**source.config, "data_view_pattern": "site-alerts-*"}, "wz"
    ).search(prefs, StructuredQuery(size=10))
    assert len(production.events) == 3
    assert production.events[0].ip == "198.51.100.7"

    # REPLAY: the frozen source under the replay's own prefs must match it.
    replayed = ReplayLogSource(fixture)
    try:
        effective = replay_prefs(prefs, fixture, type("Arm", (), {"arm_id": "a"})())
        assert effective.time_field == "timestamp"
        result = await replayed.search(effective, StructuredQuery(size=10))
    finally:
        await replayed.close()
    assert len(result.events) == 3
    assert result.events[0].ip == "198.51.100.7"
    assert result.events[0].host == "srv-a"
    assert result.events[0].rule == "authentication_failed"
    assert result.events[0].severity == 9.0


@pytest.mark.asyncio
async def test_the_bound_can_never_be_exceeded_by_a_whole_call(app_state):
    """The estimate is not an upper bound, so pin the guarantee the code DOES give.

    A provider whose real input tokenisation is denser than the four-chars-per-token
    approximation AND whose completion saturates ``max_tokens`` records more than it
    estimated, so realised spend CAN cross the bound. The invariant is that the overrun
    is a fraction of ONE call and cannot accumulate, because the realised actual is
    re-read before every call.
    """
    from app.engine.replay.stack import (
        DualUsageStore, ReplayBudgetGate, ReplayGateway, ReplaySpendLimiter, _estimate,
    )
    from app.llm.providers import CompletionResult

    class _DenseProvider:
        async def complete(self, role, messages, model, temperature, max_tokens):
            chars = len(str(messages))
            return CompletionResult(
                text="x",
                prompt_tokens=int(chars / 2),      # twice as dense as chars/4
                completion_tokens=int(max_tokens),  # saturates the declared cap
                model=model,
            )

        async def aclose(self) -> None:
            return None

    overrides = {name: _DenseProvider() for name in ("anthropic", "openai", "mock")}
    model_cfg = app_state.prefs.model_for("investigator")
    message = [{"role": "user", "content": "a" * 4000}]

    def _build(bound: float):
        mirror = UsageStore(InMemoryESClient())
        limiter = ReplaySpendLimiter(bound, mirror)
        gateway = ReplayGateway(
            app_state.secrets,
            DualUsageStore(UsageStore(InMemoryESClient()), mirror, "job-dense"),
            overrides,
            limiter=limiter,
            budget_gate=ReplayBudgetGate(None, limiter),
        )
        return limiter, gateway

    # Probe one call's REALISED cost, and compute the pre-flight ESTIMATE for it.
    probe_limiter, probe_gateway = _build(1_000.0)
    await probe_gateway.complete("investigator", message, model_cfg, surface="investigate")
    actual = await probe_limiter.accrued_usd()
    estimate = _estimate(
        len(str(message)), int(model_cfg.max_tokens), model_cfg.model, None
    )
    assert 0 < estimate < actual, (estimate, actual)

    # A bound of exactly ``actual + estimate`` admits a second call on the estimate and
    # is then crossed by its realised cost — the residual this test exists to bound.
    limiter, gateway = _build(actual + estimate)
    for _ in range(5):
        try:
            await gateway.complete("investigator", message, model_cfg, surface="investigate")
        except Exception:  # noqa: BLE001 — the refusal is the expected terminal state
            break
    accrued = await limiter.accrued_usd()
    assert limiter.tripped is True
    assert accrued > limiter.bound_usd, "the residual is real, not hypothetical"
    # But never by a WHOLE call: the overrun is strictly less than one call's cost.
    assert accrued - limiter.bound_usd < actual
