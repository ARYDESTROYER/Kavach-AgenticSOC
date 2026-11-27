"""Focused durability and wire-contract tests for server-owned operator Jobs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from contextlib import asynccontextmanager

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes_jobs import CaseTagParams, RagImportParams, router
from app.constants import JobKind, JobStatus
from app.engine.investigation_gate import InvestigationGate
from app.engine.jobs import JobRunner, _export_record_progress
from app.models import Job, JobPermission, JobProgress, JobResult, JobTransition
from app.realtime import EventBus
from app.stores.jobs import (
    JobCapacityError,
    JobConflict,
    JobStore,
    idempotency_hash,
    public_job,
)


def _fingerprint(value: str = "request") -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _job(
    *,
    key: str = "same-key",
    generation: str = "",
    params: dict | None = None,
    ids: list[str] | None = None,
) -> Job:
    case_ids = ids or ["case-1", "case-2"]
    body = params or {"case_ids": case_ids, "tag": "triaged"}
    return Job(
        kind=JobKind.CASE_TAG,
        actor="",
        actor_generation=generation,
        progress=JobProgress(total=len(case_ids), unit="cases"),
        request_fingerprint=_fingerprint(json.dumps(body, sort_keys=True)),
        idempotency_key_hash=idempotency_hash("", key, generation),
        params=body,
        item_states={case_id: "pending" for case_id in case_ids},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )


async def _quiet(state):
    await state.job_runner.stop()
    # Prevent submit from waking a worker during exact response-shape assertions.
    state.job_runner.notify = lambda: None


def _client_for_state(state) -> TestClient:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.tlsoc = state
        yield

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


@pytest.mark.asyncio
async def test_job_store_idempotency_generation_and_terminal_compaction(app_state):
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    first = _job()
    stored, created, _ = await store.create(first)
    assert created is True
    replay, created, _ = await store.create(_job())
    assert created is False and replay.job_id == stored.job_id

    mismatch = _job(params={"case_ids": ["case-1"], "tag": "different"})
    with pytest.raises(JobConflict):
        await store.create(mismatch)

    claimed, token = await store.claim_next("worker-a", lease_millis=30_000)  # type: ignore[misc]
    await store.begin_item(claimed.job_id, token, "case-1")
    await store.complete_item(claimed.job_id, token, "case-1")
    await store.begin_item(claimed.job_id, token, "case-2")
    await store.complete_item(claimed.job_id, token, "case-2", error="not found")
    finished = await store.finish(claimed.job_id, token, JobStatus.PARTIAL)
    assert finished.item_states == {}
    assert finished.params == {"case_count": 2, "tag": "triaged"}
    assert finished.result is not None
    assert finished.result.counts == {"succeeded": 1, "failed": 1, "total": 2}
    assert public_job(finished).params["case_count"] == 2

    # An identically named replacement account is a distinct idempotency namespace.
    replacement, created, _ = await store.create(_job(generation="new-generation"))
    assert created is True and replacement.job_id != stored.job_id


@pytest.mark.asyncio
async def test_interrupted_unsafe_item_is_failed_and_not_returned_to_pending(app_state):
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    stored, _, _ = await store.create(_job(ids=["case-1"]))
    claimed = await store.claim_next("worker-a", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await store.begin_item(running.job_id, token, "case-1")
    # Force a stale lease in the durable row without laundering the processing item.
    doc = await app_state.kv.get_strict("jobs", "jobs")
    assert doc is not None
    doc["jobs"][stored.job_id]["lease_expires_at_millis"] = 0
    await app_state.kv.put_strict("jobs", "jobs", doc)
    recovered = await store.claim_next("worker-b", lease_millis=30_000)
    assert recovered is not None
    resumed, _ = recovered
    assert resumed.item_states["case-1"] == "failed"
    assert resumed.failure_count == 1


@pytest.mark.asyncio
async def test_queued_cancel_compacts_and_generation_scopes_cancellation(app_state):
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    stored, _, _ = await store.create(_job(generation="g1"))
    assert await store.request_cancel(stored.job_id, "", "wrong") is None
    cancelled = await store.request_cancel(stored.job_id, "", "g1")
    assert cancelled is not None and cancelled.status == JobStatus.CANCELLED
    assert cancelled.item_states == {}
    assert cancelled.result is not None
    assert cancelled.result.counts == {"succeeded": 0, "failed": 0, "total": 2}


@pytest.mark.asyncio
async def test_factory_fence_quiesces_and_compacts_to_one_sanitized_receipt(app_state):
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    other, _, _ = await store.create(_job(key="other-job", ids=["case-1"]))
    reset = Job(
        kind=JobKind.TIERED_RESET,
        actor="admin",
        actor_generation="generation",
        progress=JobProgress(total=1, unit="reset"),
        request_fingerprint=_fingerprint("factory-reset"),
        idempotency_key_hash=idempotency_hash("admin", "factory-reset-key", "generation"),
        params={"scope": "factory", "confirm": "FACTORY RESET"},
        item_states={"reset": "pending"},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )
    reset, _, _ = await store.create(reset)
    first_claim = await store.claim_next("worker-a", lease_millis=30_000)
    second_claim = await store.claim_next("worker-b", lease_millis=30_000)
    assert first_claim is not None and second_claim is not None
    running_other, other_token = first_claim
    running_reset, reset_token = second_claim
    assert running_other.job_id == other.job_id
    assert running_reset.job_id == reset.job_id

    await store.begin_factory_fence(reset.job_id, reset_token)
    assert await store.factory_quiescent(reset.job_id, reset_token) is False
    with pytest.raises(JobCapacityError):
        await store.create(_job(key="blocked-by-factory"))
    await store.finish(other.job_id, other_token, JobStatus.CANCELLED)
    assert await store.factory_quiescent(reset.job_id, reset_token) is True
    receipt, _ = await store.factory_compact(
        reset.job_id,
        reset_token,
        status=JobStatus.SUCCEEDED,
        result=JobResult(
            kind="tiered_reset",
            counts={"attempted": 12, "cleared": 12, "failed": 0},
        ),
        app_version="0.1.0",
        build_sha="a" * 40,
    )
    assert receipt.actor == "" and receipt.actor_generation == ""
    assert receipt.request_fingerprint == "" and receipt.idempotency_key_hash == ""
    assert receipt.params == {"scope": "factory"}
    assert receipt.required_permissions == [] and receipt.item_states == {}
    assert await store.get(other.job_id) is None
    assert [row.job_id for row in await store.list_for_actor("")] == [receipt.job_id]


@pytest.mark.asyncio
async def test_params_canonicalize_ids_and_bound_multibyte_rag():
    parsed = CaseTagParams.model_validate(
        {"case_ids": [" case-2 ", "case-1", "case-2"], "tag": "  調査  "}
    )
    assert parsed.case_ids == ["case-1", "case-2"]
    assert parsed.tag == "調査"
    with pytest.raises(Exception):
        CaseTagParams.model_validate({"case_ids": ["  "], "tag": "x"})
    # Per-document caps are character based; aggregate request admission also uses
    # canonical UTF-8 bytes so multibyte payloads cannot bypass the 8 MiB registry cap.
    model = RagImportParams.model_validate(
        {"documents": [{"title": "x", "text": "界" * 1000}]}
    )
    assert len(model.documents[0].text.encode()) == 3000


@pytest.mark.asyncio
async def test_jobs_routes_return_top_level_public_contract_and_validate_secrets(app_state):
    await _quiet(app_state)
    with _client_for_state(app_state) as client:
        response = client.post(
            "/api/jobs",
            json={
                "kind": "case_tag",
                "idempotency_key": "route-retry-key",
                "params": {"case_ids": [" case-2 ", "case-1", "case-2"], "tag": "triaged"},
            },
        )
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["job_id"].startswith("job-")
        assert body["kind"] == "case_tag"
        assert "job" not in body and "created" not in body
        detail = client.get(f"/api/jobs/{body['job_id']}")
        assert detail.status_code == 200 and detail.json()["job_id"] == body["job_id"]
        cancelled = client.post(f"/api/jobs/{body['job_id']}/cancel")
        assert cancelled.status_code == 202
        assert cancelled.json()["status"] == "cancelled"
        listing = client.get("/api/jobs")
        assert listing.status_code == 200
        assert listing.json()["jobs"][0]["job_id"] == body["job_id"]

        rejected = client.post(
            "/api/jobs",
            json={
                "kind": "case_tag",
                "idempotency_key": "secret-retry-key",
                "params": {"case_ids": ["case-1"], "tag": "x", "api_token": "no"},
            },
        )
        assert rejected.status_code == 422


@pytest.mark.asyncio
async def test_client_disconnect_navigation_does_not_own_job_lifetime(app_state):
    """A closed submitting client cannot strand or cancel server-owned work."""
    await _quiet(app_state)
    with _client_for_state(app_state) as client:
        response = client.post(
            "/api/jobs",
            json={
                "kind": "case_tag",
                "idempotency_key": "disconnect-navigation-key",
                "params": {"case_ids": ["case-1", "case-2"], "tag": "triaged"},
            },
        )
        assert response.status_code == 202, response.text
        job_id = response.json()["job_id"]
    # The TestClient/request is gone. A fresh process/store view still claims and
    # completes the same durable row without any browser callback or session object.
    restarted = JobStore(app_state.kv)
    claimed = await restarted.claim_next("restarted-worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    assert running.job_id == job_id
    for item_ref in list(running.item_states):
        await restarted.complete_item(job_id, token, item_ref)
    await restarted.finish(job_id, token, JobStatus.SUCCEEDED)
    reloaded = await JobStore(app_state.kv).get(job_id)
    assert reloaded is not None and reloaded.status == JobStatus.SUCCEEDED
    assert reloaded.result is not None
    assert reloaded.result.counts == {"succeeded": 2, "failed": 0, "total": 2}


@pytest.mark.asyncio
async def test_sqlite_job_store_create_claim_finish_and_reload():
    """The zero-migration Jobs registry is durable on the real SQL KV adapter."""
    from app.stores.sql import SqlKVStore, build_async_engine, create_all

    engine = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(engine)
    try:
        created, is_new, _ = await JobStore(SqlKVStore(engine)).create(
            _job(key="sqlite-durable-key")
        )
        assert is_new is True
        claimed = await JobStore(SqlKVStore(engine)).claim_next(
            "sqlite-worker", lease_millis=30_000
        )
        assert claimed is not None
        running, token = claimed
        for item_ref in list(running.item_states):
            await JobStore(SqlKVStore(engine)).complete_item(
                running.job_id, token, item_ref
            )
        await JobStore(SqlKVStore(engine)).finish(
            running.job_id, token, JobStatus.SUCCEEDED
        )
        reloaded = await JobStore(SqlKVStore(engine)).get(created.job_id)
        assert reloaded is not None and reloaded.status == JobStatus.SUCCEEDED
        assert reloaded.item_states == {}
        assert reloaded.result is not None
        assert reloaded.result.counts == {
            "succeeded": 2,
            "failed": 0,
            "total": 2,
        }
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_failed_factory_boundary_stays_fenced_except_fresh_factory_retry(app_state):
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    failed_reset = Job(
        kind=JobKind.TIERED_RESET,
        actor="admin",
        actor_generation="generation",
        progress=JobProgress(total=1, unit="reset"),
        request_fingerprint=_fingerprint("failed-factory"),
        idempotency_key_hash=idempotency_hash(
            "admin", "failed-factory-key", "generation"
        ),
        params={"scope": "factory", "confirm": "FACTORY RESET"},
        required_permissions=[JobPermission(resource="users", action="manage")],
        fresh_authorized_until_millis=int(time.time() * 1000) + 60_000,
        item_states={"reset": "pending"},
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )
    failed_reset, _, _ = await store.create(failed_reset)
    claimed = await store.claim_next("factory-worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await store.begin_factory_fence(running.job_id, token)
    await store.finish(
        running.job_id,
        token,
        JobStatus.FAILED,
        job_error="privacy boundary unavailable",
    )
    with pytest.raises(JobCapacityError, match="only a fresh factory reset retry"):
        await store.create(_job(key="ordinary-work-remains-blocked"))

    retry = failed_reset.model_copy(
        update={
            "job_id": "job-factory-recovery",
            "created_at": failed_reset.created_at,
            "started_at": None,
            "finished_at": None,
            "status": JobStatus.QUEUED,
            "progress": JobProgress(total=1, unit="reset"),
            "request_fingerprint": _fingerprint("factory-recovery"),
            "idempotency_key_hash": idempotency_hash(
                "admin", "factory-recovery-key", "generation"
            ),
            "params": {"scope": "factory", "confirm": "FACTORY RESET"},
            "fresh_authorized_until_millis": int(time.time() * 1000) + 60_000,
            "item_states": {"reset": "pending"},
            "failures": [],
            "failure_count": 0,
            "failures_truncated": 0,
            "result": None,
            "lease_owner": None,
            "lease_token": None,
            "lease_expires_at_millis": 0,
            "transitions": [JobTransition(seq=1, name="submitted")],
            "transition_seq": 1,
        }
    )
    recovered, is_new, _ = await store.create(retry)
    assert is_new is True
    claimed = await store.claim_next("recovery-worker", lease_millis=30_000)
    assert claimed is not None and claimed[0].job_id == recovered.job_id


@pytest.mark.asyncio
async def test_job_inbox_projection_is_stable_and_terminal_becomes_unseen(app_state):
    await _quiet(app_state)
    stored, _, _ = await app_state.jobs.create(_job(ids=["case-1"]))
    await app_state.job_runner.publish(stored, force=True)
    notes, total = await app_state.real_inbox.list_for_user(None)
    assert total == 1 and notes[0].job_id == stored.job_id
    stable_id = notes[0].id
    await app_state.real_inbox.mark_read(None, stable_id)
    claimed = await app_state.jobs.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await app_state.jobs.complete_item(running.job_id, token, "case-1")
    terminal = await app_state.jobs.finish(running.job_id, token, JobStatus.SUCCEEDED)
    # The durable terminal row is intentionally not projected before its transition
    # has been confirmed in the append-only audit.
    await app_state.job_runner.publish(terminal, force=True)
    notes, _ = await app_state.real_inbox.list_for_user(None)
    assert notes[0].state == "read" and notes[0].job_status == JobStatus.QUEUED
    assert await app_state.job_runner.reconcile_audits() is True
    terminal = await app_state.jobs.get(terminal.job_id)
    assert terminal is not None
    await app_state.job_runner.publish(terminal, force=True)
    notes, total = await app_state.real_inbox.list_for_user(None)
    assert total == 1 and notes[0].id == stable_id
    assert notes[0].state == "unseen" and notes[0].job_status == JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_investigation_gate_reserves_ingest_headroom_and_wakes_on_cancel():
    gate = InvestigationGate()
    release = asyncio.Event()
    background_started = asyncio.Event()

    async def background():
        async with gate.permit(2, "background"):
            background_started.set()
            await release.wait()

    first = asyncio.create_task(background())
    await background_started.wait()
    second = asyncio.create_task(background())
    await asyncio.sleep(0)
    assert not second.done()
    ingest_acquired = asyncio.Event()

    async def ingest():
        async with gate.permit(2, "ingest"):
            ingest_acquired.set()

    ingest_task = asyncio.create_task(ingest())
    await asyncio.wait_for(ingest_acquired.wait(), timeout=1)
    ingest_task.cancel()
    await asyncio.gather(ingest_task, return_exceptions=True)
    release.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=1)


def test_identity_sensitive_job_events_are_not_replayed():
    bus = EventBus()
    event_id = bus.publish(
        "jobs", "job", {"job_id": "old-generation"}, audience=["alice"], retain=False
    )
    assert bus.replay(frozenset({"jobs"}), "alice", "0") == []
    # Live delivery still receives the event; only Last-Event-ID history is disabled.
    assert int(event_id) > 0


def test_multi_scope_export_record_progress_is_monotonic_and_not_premature():
    scopes = ["cases", "audit"]
    points = [
        _export_record_progress(scopes, "cases", 1_000, 5_001, {}),
        _export_record_progress(scopes, "cases", 5_001, 5_001, {}),
        _export_record_progress(
            scopes, "audit", 1_000, 5_001, {"cases": 5_001}
        ),
        _export_record_progress(
            scopes, "audit", 5_001, 5_001, {"cases": 5_001}
        ),
    ]
    ratios = [done / total for done, total in points]
    assert ratios == sorted(ratios)
    assert all(value < 1.0 for value in ratios[:-1])
    assert points[-1] == (10_002, 10_002)


@pytest.mark.asyncio
async def test_factory_runtime_pause_and_pre_effect_resume_cover_all_local_producers():
    calls: list[str] = []

    class Poller:
        _task = object()

        async def stop(self):
            calls.append("poller.stop")

        def start(self):
            calls.append("poller.start")

    class State:
        poller = Poller()
        _scheduler_running = True
        _receivers_enabled = True
        _update_audit_running = True

        async def _stop_schedulers(self):
            calls.append("schedulers.stop")
            self._scheduler_running = False

        async def _stop_receivers(self):
            calls.append("receivers.stop")

        async def _stop_system_update_audit_reconciler(self):
            calls.append("update-audit.stop")
            self._update_audit_running = False

        async def _start_receivers(self):
            calls.append("receivers.start")

        async def _run_schedulers(self):
            calls.append("schedulers.start")

        async def _start_system_update_audit_reconciler(self):
            calls.append("update-audit.start")

    runner = JobRunner(State(), store=None)  # type: ignore[arg-type]
    snapshot = await runner._pause_factory_runtime()
    assert snapshot == {
        "poller": True,
        "schedulers": True,
        "receivers": True,
        "update_audit": True,
    }
    assert calls == [
        "schedulers.stop",
        "poller.stop",
        "receivers.stop",
        "update-audit.stop",
    ]
    await runner._resume_factory_runtime(snapshot)
    assert calls[-4:] == [
        "poller.start",
        "receivers.start",
        "schedulers.start",
        "update-audit.start",
    ]
