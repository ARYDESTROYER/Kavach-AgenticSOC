"""Adversarial acceptance tests for the durable server-owned Jobs contract.

This module deliberately exercises crash/restart, identity reuse, storage-outage,
lease, authorization, and factory-boundary cases that happy-path route tests do not.
It is fully offline and adds no production-only test seams.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from app.api.deps import require_auth
from app.api.routes_export import router as export_router
from app.api.routes_jobs import _fresh_fields, router as jobs_router
from app.api.routes_rag import router as rag_router
from app.api.routes_reset import router as reset_router
from app.api.routes_runbooks import router as runbooks_router
from app.api.routes_storage import router as storage_router
from app.auth.passwords import hash_password
from app.config import RBACConfig
from app.constants import (
    BATCH_JOBS_KEY,
    BATCH_JOBS_NS,
    CUSTOM_ROLES_KEY,
    CUSTOM_ROLES_NS,
    USERS_KEY,
    USERS_NS,
    BatchJobState,
    JobKind,
    JobStatus,
    UserRole,
)
from app.engine.batch_inbox import (
    filter_visible_batch_notes,
    prepare_batch_inbox_audience,
    public_inbox_item,
    reconcile_batch_inbox,
)
from app.engine.investigation_gate import InvestigationGate
from app.engine.jobs import JobCancelled, account_generation
from app.middleware.mutation_admission import MutationAdmissionMiddleware
from app.models import (
    BatchJob,
    CustomRole,
    InAppNotification,
    Job,
    JobArtifact,
    JobPermission,
    JobProgress,
    JobResult,
    JobTransition,
)
from app.realtime import EventBus, get_event_bus
from app.stores.jobs import (
    MAX_FAILURES,
    JobCapacityError,
    JobConflict,
    JobStore,
    idempotency_hash,
)


def _digest(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _job(
    *,
    kind: JobKind = JobKind.CASE_TAG,
    actor: str = "",
    generation: str = "",
    key: str = "adversarial-key",
    params: dict | None = None,
    item_states: dict[str, str] | None = None,
    permissions: list[tuple[str, str]] | None = None,
) -> Job:
    if params is None:
        params = {"case_ids": ["case-1", "case-2"], "tag": "triaged"}
    if item_states is None:
        if kind == JobKind.TIERED_RESET:
            item_states = {"reset": "pending"}
        elif kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
            item_states = {str(scope): "pending" for scope in params.get("scopes", ["cases"])}
        else:
            item_states = {
                str(case_id): "pending" for case_id in params.get("case_ids", ["item"])
            }
    return Job(
        kind=kind,
        actor=actor,
        actor_generation=generation,
        progress=JobProgress(total=len(item_states), unit="items"),
        request_fingerprint=_digest({"kind": kind.value, "params": params}),
        idempotency_key_hash=idempotency_hash(actor, key, generation),
        params=params,
        required_permissions=[
            JobPermission(resource=resource, action=action)
            for resource, action in (permissions or [])
        ],
        item_states=item_states,
        transitions=[JobTransition(seq=1, name="submitted")],
        transition_seq=1,
    )


def _batch_job(batch_id: str = "batch-adversarial") -> BatchJob:
    return BatchJob(
        id=batch_id,
        provider="openai",
        provider_batch_id="provider-private-handle",
        state=BatchJobState.POLLING,
        model="gpt-safe-display",
        submitted_at="2026-08-13T00:00:00+00:00",
        custom_ids={"raw-case-secret": {"retrieved": False}},
        requests=[
            {
                "custom_id": "raw-case-secret",
                "params": {"prompt": "private request body"},
            }
        ],
        candidates={"raw-case-secret": {"raw": "private candidate body"}},
        last_error="private provider traceback",
        inbox_audience_state="pending",
    )


async def _quiet(state) -> None:
    await state.job_runner.stop()
    state.job_runner.notify = lambda: None


async def _expire_lease(state, job_id: str) -> None:
    doc = await state.kv.get_strict("jobs", "jobs")
    assert isinstance(doc, dict)
    doc["jobs"][job_id]["lease_expires_at_millis"] = 0
    await state.kv.put_strict("jobs", "jobs", doc)


async def _enable_user(
    state,
    *,
    username: str = "alice",
    role: UserRole = UserRole.ANALYST_TIER1,
    prefs: dict | None = None,
):
    user = await state.users.create(
        username=username,
        password_hash=hash_password("Correct-horse-123!"),
        role=role.value,
    )
    if prefs is not None:
        user = await state.users.update(username, prefs=prefs)
        assert user is not None
    # The shared fixture intentionally starts auth-off. Enabling the already-wired
    # service lets these unit-level tests exercise the exact live authority path.
    state.auth._enabled = True  # noqa: SLF001 - adversarial test seam
    await state.refresh_users()
    return user


def _request(
    state, token: str, path: str = "/api/jobs", method: str = "POST"
) -> Request:
    app = SimpleNamespace(state=SimpleNamespace(tlsoc=state))
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [(b"authorization", f"Bearer {token}".encode())],
            "client": ("127.0.0.1", 1),
            "server": ("testserver", 80),
            "app": app,
        }
    )


def _client_for_state(
    state, *routers, raise_server_exceptions: bool = True
) -> TestClient:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.tlsoc = state
        yield

    api = FastAPI(lifespan=lifespan)
    for router in routers:
        api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api, raise_server_exceptions=raise_server_exceptions)


@pytest.mark.asyncio
async def test_strict_cas_single_winner_and_generation_namespaces(app_state) -> None:
    await _quiet(app_state)
    left = JobStore(app_state.kv)
    right = JobStore(app_state.kv)
    first = _job(actor="alice", generation="generation-1")
    second = _job(actor="alice", generation="generation-1")

    outcomes = await asyncio.gather(left.create(first), right.create(second))
    assert sum(1 for _job_row, created, _pruned in outcomes if created) == 1
    assert len({job_row.job_id for job_row, _created, _pruned in outcomes}) == 1

    conflicting = _job(
        actor="alice",
        generation="generation-1",
        params={"case_ids": ["case-1"], "tag": "different"},
    )
    with pytest.raises(JobConflict):
        await left.create(conflicting)

    replacement, created, _ = await right.create(
        _job(actor="alice", generation="generation-2")
    )
    assert created is True
    assert replacement.job_id != outcomes[0][0].job_id


@pytest.mark.asyncio
async def test_idempotency_key_never_releases_while_original_row_is_retained(
    app_state,
) -> None:
    """A delayed retry with the same caller key must still resume the original job.

    Deliberate repeats already mint a new client idempotency key. Releasing the same
    key on a timer permits a delayed/partitioned retry to duplicate a completed effect.
    """

    await _quiet(app_state)
    store = JobStore(app_state.kv)
    stored, _, _ = await store.create(_job())
    claimed = await store.claim_next("worker-a", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    for item_ref in list(running.item_states):
        await store.complete_item(running.job_id, token, item_ref)
    await store.finish(running.job_id, token, JobStatus.SUCCEEDED)

    replay, created, _ = await store.create(_job())
    assert created is False
    assert replay.job_id == stored.job_id


@pytest.mark.asyncio
async def test_recovery_fails_closed_for_ambiguous_effect_and_retries_safe_archive(
    app_state,
) -> None:
    await _quiet(app_state)
    store = JobStore(app_state.kv)

    unsafe, _, _ = await store.create(
        _job(key="unsafe", item_states={"case-1": "pending"})
    )
    claimed = await store.claim_next("worker-a", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await store.begin_item(running.job_id, token, "case-1")
    await _expire_lease(app_state, unsafe.job_id)
    recovered = await JobStore(app_state.kv).claim_next(
        "worker-b", lease_millis=30_000
    )
    assert recovered is not None
    resumed, resumed_token = recovered
    assert resumed.item_states == {"case-1": "failed"}
    assert resumed.failure_count == 1
    assert "not retried" in resumed.failures[0].reason
    await store.finish(resumed.job_id, resumed_token, JobStatus.FAILED)

    archive, _, _ = await store.create(
        _job(
            kind=JobKind.DATA_EXPORT_ARCHIVE,
            key="safe-archive",
            params={"scopes": ["cases"]},
            item_states={"cases": "pending"},
        )
    )
    claimed = await store.claim_next("worker-a", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await store.begin_item(running.job_id, token, "cases")
    _row, first_reservation = await store.reserve_artifact(
        running.job_id, token, suffix=".zip"
    )
    await _expire_lease(app_state, archive.job_id)
    recovered = await JobStore(app_state.kv).claim_next(
        "worker-b", lease_millis=30_000
    )
    assert recovered is not None
    resumed, resumed_token = recovered
    assert resumed.item_states == {"cases": "pending"}
    assert resumed.pending_artifact_id is None
    _row, second_reservation = await store.reserve_artifact(
        resumed.job_id, resumed_token, suffix=".zip"
    )
    assert second_reservation != first_reservation


@pytest.mark.asyncio
async def test_running_cancel_preserves_truthful_partial_counts(app_state) -> None:
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    stored, _, _ = await store.create(_job())
    claimed = await store.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await store.complete_item(running.job_id, token, "case-1")
    cancelling = await store.request_cancel(stored.job_id, "", "")
    assert cancelling is not None and cancelling.cancel_requested
    with pytest.raises(JobCancelled):
        await app_state.job_runner.checkpoint(stored.job_id, token)
    terminal = await store.finish(stored.job_id, token, JobStatus.CANCELLED)
    assert terminal.progress.done == 1
    assert terminal.progress.total == 2
    assert terminal.result is not None
    assert terminal.result.counts == {"succeeded": 1, "failed": 0, "total": 2}


@pytest.mark.asyncio
async def test_job_level_failure_does_not_inflate_failed_item_count(app_state) -> None:
    await _quiet(app_state)
    store = JobStore(app_state.kv)
    stored, _, _ = await store.create(_job())
    claimed = await store.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    for item_ref in list(running.item_states):
        await store.complete_item(running.job_id, token, item_ref)
    terminal = await store.finish(
        stored.job_id,
        token,
        JobStatus.FAILED,
        job_error="post-effect result persistence failed",
    )
    assert terminal.result is not None
    assert terminal.result.counts == {
        "succeeded": 2,
        "failed": 0,
        "total": 2,
        "job_errors": 1,
    }
    assert terminal.failure_count == 1  # the bounded job-level diagnostic still exists


@pytest.mark.asyncio
async def test_terminal_failure_compaction_retains_bounded_diagnostics_and_exact_count(
    app_state,
) -> None:
    """>MAX_FAILURES keeps an exact aggregate without retaining an unbounded list."""

    await _quiet(app_state)
    item_count = MAX_FAILURES + 3
    item_refs = [f"case-failure-{index:03d}" for index in range(item_count)]
    stored, _, _ = await app_state.jobs.create(
        _job(
            key="bounded-terminal-failures",
            params={"case_ids": item_refs, "tag": "failure-bound"},
            item_states={item_ref: "pending" for item_ref in item_refs},
        )
    )
    claimed = await app_state.jobs.claim_next(
        "bounded-failure-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    for item_ref in item_refs:
        await app_state.jobs.complete_item(
            running.job_id,
            token,
            item_ref,
            error=f"bounded failure for {item_ref}",
        )

    terminal = await app_state.jobs.finish(
        stored.job_id, token, JobStatus.FAILED
    )
    assert terminal.item_states == {}
    assert len(terminal.failures) == MAX_FAILURES
    assert terminal.failure_count == item_count
    assert terminal.failures_truncated == item_count - MAX_FAILURES
    assert [failure.item_ref for failure in terminal.failures] == item_refs[:MAX_FAILURES]
    assert terminal.result is not None
    assert terminal.result.counts == {
        "succeeded": 0,
        "failed": item_count,
        "total": item_count,
    }

    # Terminal compaction and its counters are durable, not an in-memory summary.
    reloaded = await JobStore(app_state.kv).get(stored.job_id)
    assert reloaded is not None
    assert len(reloaded.failures) == MAX_FAILURES
    assert reloaded.failure_count == item_count
    assert reloaded.failures_truncated == item_count - MAX_FAILURES


@pytest.mark.asyncio
async def test_transition_audit_and_inbox_projection_outboxes_reconcile(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    stored, _, _ = await app_state.jobs.create(_job(actor="alice"))

    audit = app_state.control_audit
    original_audit = audit.record_strict

    async def audit_outage(**_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(audit, "record_strict", audit_outage)
    assert await app_state.job_runner.reconcile_audits() is False
    pending = await app_state.jobs.get(stored.job_id)
    assert pending is not None and any(not row.audited for row in pending.transitions)
    monkeypatch.setattr(audit, "record_strict", original_audit)
    assert await app_state.job_runner.reconcile_audits() is True
    audited = await app_state.jobs.get(stored.job_id)
    assert audited is not None and all(row.audited for row in audited.transitions)

    inbox = app_state.real_inbox
    original_upsert = inbox.upsert_job_strict

    async def inbox_outage(_notification):
        raise RuntimeError("inbox unavailable")

    monkeypatch.setattr(inbox, "upsert_job_strict", inbox_outage)
    await app_state.job_runner.publish(audited, force=True)
    unsynced = await app_state.jobs.get(stored.job_id)
    assert unsynced is not None and unsynced.inbox_synced is False
    monkeypatch.setattr(inbox, "upsert_job_strict", original_upsert)
    assert await app_state.job_runner.reconcile_inbox() is True
    repaired = await app_state.jobs.get(stored.job_id)
    assert repaired is not None and repaired.inbox_synced is True
    notes, total = await inbox.list_for_user("alice")
    assert total == 1 and notes[0].job_id == stored.job_id


@pytest.mark.asyncio
async def test_auth_off_terminal_inbox_outbox_recovers_into_stable_default_bucket(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Actorless no-auth jobs still own one durable default-bucket Inbox note."""

    from app.stores.inbox import InboxStore

    await _quiet(app_state)
    assert app_state.auth.is_enabled is False
    job, _, _ = await app_state.jobs.create(
        _job(
            actor="",
            generation="",
            key="auth-off-default-inbox",
            params={"case_ids": ["case-auth-off"], "tag": "reviewed"},
            item_states={"case-auth-off": "succeeded"},
        )
    )
    claimed = await app_state.jobs.claim_next(
        "auth-off-inbox-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    terminal = await app_state.jobs.finish(
        running.job_id,
        token,
        JobStatus.SUCCEEDED,
        result=JobResult(
            kind="case_tag",
            counts={"total": 1, "succeeded": 1, "failed": 0},
        ),
    )
    assert await app_state.job_runner.reconcile_audits() is True

    original_upsert = app_state.real_inbox.upsert_job_strict
    calls = 0

    async def fail_first_upsert(note):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("injected default Inbox outage")
        return await original_upsert(note)

    monkeypatch.setattr(
        app_state.real_inbox, "upsert_job_strict", fail_first_upsert
    )
    await app_state.job_runner.publish(terminal, force=True)
    pending = await app_state.jobs.get(job.job_id)
    assert pending is not None and pending.inbox_synced is False
    notes, total = await app_state.real_inbox.list_for_user("")
    assert notes == [] and total == 0

    assert await app_state.job_runner.reconcile_inbox() is True
    synced = await app_state.jobs.get(job.job_id)
    assert synced is not None and synced.inbox_synced is True
    notes, total = await app_state.real_inbox.list_for_user("")
    assert len(notes) == total == 1
    assert notes[0].job_id == job.job_id
    assert notes[0].job_status == JobStatus.SUCCEEDED
    assert notes[0].audience_generation == "no-auth"
    stable_id = notes[0].id

    # A repeated outbox pass is a stable upsert, never a notification flood.
    await app_state.jobs.set_inbox_synced(job.job_id, False)
    assert await app_state.job_runner.reconcile_inbox() is True
    notes, total = await app_state.real_inbox.list_for_user(None)
    assert len(notes) == total == 1 and notes[0].id == stable_id

    # Reconstruct the store over the same durable KV to model application reload.
    reloaded = InboxStore(app_state.kv)
    persisted, total = await reloaded.list_for_user("")
    assert len(persisted) == total == 1
    assert persisted[0].id == stable_id
    assert persisted[0].job_id == job.job_id


@pytest.mark.asyncio
async def test_inbox_cap_never_evicts_active_job_and_stable_note_id_does_not_churn(
    app_state,
) -> None:
    """The advisory ring evicts terminal rows before its only active Job anchor."""

    await _quiet(app_state)
    inbox = app_state.real_inbox
    recipient = "capacity-operator"
    active_job_id = "job-capacity-active"
    active = await inbox.upsert_job_strict(
        InAppNotification(
            recipient=recipient,
            title="Active background job",
            body="1 of 10 complete",
            job_id=active_job_id,
            job_status=JobStatus.RUNNING,
            progress=JobProgress(done=1, total=10, unit="cases"),
            audience_generation="capacity-generation",
        )
    )
    stable_id = active.id

    # Cross the real 200-note cap in one strict shared-document mutation. The two
    # oldest terminal rows may be evicted; the older active row must survive.
    next_index = iter(range(201))

    def terminal_note(user_id: str) -> InAppNotification:
        index = next(next_index)
        return InAppNotification(
            recipient=user_id,
            title=f"Terminal background job {index}",
            body="Complete",
            job_id=f"job-capacity-terminal-{index:03d}",
            job_status=JobStatus.SUCCEEDED,
            progress=JobProgress(done=1, total=1, unit="cases"),
            result=JobResult(
                kind="case_tag", counts={"succeeded": 1, "failed": 0, "total": 1}
            ),
            audience_generation="capacity-generation",
        )

    await inbox.fanout([recipient] * 201, terminal_note)
    notes, total = await inbox.list_for_user(recipient, limit=500)
    by_job_id = {note.job_id: note for note in notes}
    assert total == 200
    assert by_job_id[active_job_id].id == stable_id
    assert "job-capacity-terminal-000" not in by_job_id
    assert "job-capacity-terminal-001" not in by_job_id
    assert "job-capacity-terminal-200" in by_job_id

    # Running progress and the terminal transition both update the same note in
    # place. Terminal rows remain eligible for later normal ring eviction.
    progressed = await inbox.upsert_job_strict(
        InAppNotification(
            recipient=recipient,
            title="Active background job",
            body="9 of 10 complete",
            job_id=active_job_id,
            job_status=JobStatus.RUNNING,
            progress=JobProgress(done=9, total=10, unit="cases"),
            audience_generation="capacity-generation",
        )
    )
    assert progressed.id == stable_id
    completed = await inbox.upsert_job_strict(
        InAppNotification(
            recipient=recipient,
            title="Active background job",
            body="10 of 10 complete",
            job_id=active_job_id,
            job_status=JobStatus.SUCCEEDED,
            progress=JobProgress(done=10, total=10, unit="cases"),
            result=JobResult(
                kind="case_tag", counts={"succeeded": 10, "failed": 0, "total": 10}
            ),
            audience_generation="capacity-generation",
        )
    )
    assert completed.id == stable_id
    notes, total = await inbox.list_for_user(recipient, limit=500)
    assert total == 200
    active_rows = [note for note in notes if note.job_id == active_job_id]
    assert len(active_rows) == 1
    assert active_rows[0].id == stable_id
    assert active_rows[0].job_status == JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_idempotent_submit_retry_cannot_skip_pending_transition_audit(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A durable first attempt must not turn an unaudited retry into visible work."""

    await _quiet(app_state)
    audit = app_state.control_audit
    original_audit = audit.record_strict

    async def audit_outage(**_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(audit, "record_strict", audit_outage)
    payload = {
        "kind": "case_tag",
        "idempotency_key": "audit-retry-key",
        "params": {"case_ids": ["case-1"], "tag": "triaged"},
    }
    with _client_for_state(
        app_state, jobs_router, raise_server_exceptions=False
    ) as client:
        first = client.post("/api/jobs", json=payload)
        assert first.status_code == 503
        retry = client.post("/api/jobs", json=payload)
        assert retry.status_code == 503

        rows = await app_state.jobs.list_for_actor("")
        assert len(rows) == 1
        assert any(not transition.audited for transition in rows[0].transitions)
        notes, total = await app_state.real_inbox.list_for_user("")
        assert notes == [] and total == 0

        monkeypatch.setattr(audit, "record_strict", original_audit)
        accepted = client.post("/api/jobs", json=payload)
        assert accepted.status_code == 202
        notes, total = await app_state.real_inbox.list_for_user("")
        assert total == 1 and notes[0].job_status == JobStatus.QUEUED


@pytest.mark.asyncio
async def test_cancel_and_terminal_projection_wait_for_transition_audit(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancellation/finish may persist, but Inbox must lag until audit confirms."""

    await _quiet(app_state)
    stored, _, _ = await app_state.jobs.create(_job(actor="alice"))
    claimed = await app_state.jobs.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    assert await app_state.job_runner.reconcile_audits() is True
    await app_state.job_runner.publish(running, force=True)
    before, total = await app_state.real_inbox.list_for_user("alice")
    assert total == 1 and before[0].job_status == JobStatus.RUNNING

    audit = app_state.control_audit
    original_audit = audit.record_strict

    async def audit_outage(**_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(audit, "record_strict", audit_outage)
    await app_state.job_runner._finish(  # noqa: SLF001 - exact worker boundary
        running, token, JobStatus.SUCCEEDED
    )
    terminal = await app_state.jobs.get(stored.job_id)
    assert terminal is not None and terminal.status == JobStatus.SUCCEEDED
    assert any(not transition.audited for transition in terminal.transitions)
    hidden, total = await app_state.real_inbox.list_for_user("alice")
    assert total == 1 and hidden[0].job_status == JobStatus.RUNNING

    monkeypatch.setattr(audit, "record_strict", original_audit)
    assert await app_state.job_runner.reconcile_audits() is True
    assert await app_state.job_runner.reconcile_inbox() is True
    visible, total = await app_state.real_inbox.list_for_user("alice")
    assert total == 1 and visible[0].job_status == JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_cancel_route_returns_503_and_withholds_projection_until_audited(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    with _client_for_state(
        app_state, jobs_router, raise_server_exceptions=False
    ) as client:
        submitted = client.post(
            "/api/jobs",
            json={
                "kind": "case_tag",
                "idempotency_key": "cancel-audit-key",
                "params": {"case_ids": ["case-1"], "tag": "triaged"},
            },
        )
        assert submitted.status_code == 202
        job_id = submitted.json()["job_id"]

        audit = app_state.control_audit
        original_audit = audit.record_strict

        async def audit_outage(**_kwargs):
            raise RuntimeError("audit unavailable")

        monkeypatch.setattr(audit, "record_strict", audit_outage)
        cancelled = client.post(f"/api/jobs/{job_id}/cancel")
        assert cancelled.status_code == 503
        notes, total = await app_state.real_inbox.list_for_user("")
        assert total == 1 and notes[0].job_status == JobStatus.QUEUED

        persisted = await app_state.jobs.get(job_id)
        assert persisted is not None and persisted.status == JobStatus.CANCELLED
        assert any(not transition.audited for transition in persisted.transitions)

        monkeypatch.setattr(audit, "record_strict", original_audit)
        accepted = client.post(f"/api/jobs/{job_id}/cancel")
        assert accepted.status_code == 202
        notes, total = await app_state.real_inbox.list_for_user("")
        assert total == 1 and notes[0].job_status == JobStatus.CANCELLED


@pytest.mark.asyncio
async def test_deleted_account_generation_cannot_receive_blocked_effect_completion(
    app_state,
) -> None:
    await _quiet(app_state)
    original = await _enable_user(app_state)
    generation = account_generation(original.username, original.created_at)
    stored, _, _ = await app_state.jobs.create(
        _job(actor="alice", generation=generation, item_states={"case-1": "pending"})
    )
    claimed = await app_state.jobs.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await app_state.job_runner.publish(running, force=True)
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert total == 1 and notes[0].job_id == stored.job_id

    artifacts, _ = await app_state.jobs.retire_actor("alice", generation)
    await app_state.job_runner.delete_artifacts(artifacts)
    await app_state.real_inbox.clear("alice")
    assert await app_state.users.delete("alice") is True
    await asyncio.sleep(0.002)
    replacement = await app_state.users.create(
        username="alice",
        password_hash=hash_password("Replacement-user-123!"),
        role=UserRole.ANALYST_TIER1.value,
    )
    assert account_generation(replacement.username, replacement.created_at) != generation
    await app_state.refresh_users()

    # Model a provider/domain effect that was already blocked in flight when delete
    # requested cancellation: its old lease can still persist a terminal receipt, but
    # that receipt must never project into the replacement account's Inbox/SSE.
    await app_state.jobs.complete_item(running.job_id, token, "case-1")
    terminal = await app_state.jobs.finish(running.job_id, token, JobStatus.SUCCEEDED)
    await app_state.job_runner.reconcile_audits()
    await app_state.job_runner.publish(terminal, force=True)
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert total == 0 and notes == []
    assert await app_state.jobs.get(stored.job_id) is None


@pytest.mark.asyncio
async def test_deleted_account_generation_cannot_race_inbox_projection_into_replacement(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The authorization check and projection write have a deliberate race window."""

    await _quiet(app_state)
    original = await _enable_user(app_state)
    generation = account_generation(original.username, original.created_at)
    stored, _, _ = await app_state.jobs.create(
        _job(actor="alice", generation=generation, item_states={"case-1": "pending"})
    )
    entered_projection = asyncio.Event()
    release_projection = asyncio.Event()
    original_upsert = app_state.real_inbox.upsert_job_strict
    replacement_stream = None

    async def stalled_upsert(note):
        entered_projection.set()
        await release_projection.wait()
        return await original_upsert(note)

    monkeypatch.setattr(app_state.real_inbox, "upsert_job_strict", stalled_upsert)
    publish = asyncio.create_task(app_state.job_runner.publish(stored, force=True))
    try:
        await asyncio.wait_for(entered_projection.wait(), timeout=1)
        artifacts, _ = await app_state.jobs.retire_actor("alice", generation)
        await app_state.job_runner.delete_artifacts(artifacts)
        assert await app_state.users.delete("alice") is True
        await app_state.real_inbox.clear("alice")
        await asyncio.sleep(0.002)
        replacement = await app_state.users.create(
            username="alice",
            password_hash=hash_password("Replacement-user-123!"),
            role=UserRole.ANALYST_TIER1.value,
        )
        assert account_generation(replacement.username, replacement.created_at) != generation
        await app_state.refresh_users()
        replacement_stream = get_event_bus().subscribe(["jobs"], "alice")
        assert await anext(replacement_stream) == b": connected\n\n"
        release_projection.set()
        await asyncio.wait_for(publish, timeout=1)
    finally:
        release_projection.set()
        if not publish.done():
            publish.cancel()
            await asyncio.gather(publish, return_exceptions=True)

    # An old-generation write that lost the check/use race may exist physically, but
    # it must be generation-bound and fail closed for the replacement account.
    try:
        notes, total = await app_state.real_inbox.list_for_user("alice")
        assert notes == [] and total == 0
        assert replacement_stream is not None
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(anext(replacement_stream), timeout=0.05)
    finally:
        if replacement_stream is not None:
            await replacement_stream.aclose()


@pytest.mark.asyncio
async def test_live_custom_role_permission_missing_doc_and_outage_fail_closed(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    user = await _enable_user(
        app_state,
        role=UserRole.AUDITOR,
        prefs={"custom_roles": ["job-writer"]},
    )
    role = CustomRole(name="job-writer", grants={"cases": ["write"]})
    await app_state.custom_roles.put(role)
    prefs = app_state.prefs.model_copy(
        update={"rbac": app_state.prefs.rbac.model_copy(update={"enabled": True})}
    )
    await app_state.update_prefs(prefs)
    await app_state.refresh_users()
    job = _job(
        actor="alice",
        generation=account_generation(user.username, user.created_at),
        permissions=[("cases", "write")],
    )
    assert await app_state.job_runner._permission_alive(job) is True  # noqa: SLF001

    await app_state.kv.put_strict(CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY, {})
    assert await app_state.job_runner._permission_alive(job) is False  # noqa: SLF001

    await app_state.kv.put_strict(
        CUSTOM_ROLES_NS,
        CUSTOM_ROLES_KEY,
        {"roles": {"default": [role.model_dump(mode="json")]}},
    )
    original_get = app_state.kv.get_strict

    async def role_registry_outage(namespace: str, key: str):
        if (namespace, key) == (CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY):
            raise RuntimeError("custom-role registry unavailable")
        return await original_get(namespace, key)

    monkeypatch.setattr(app_state.kv, "get_strict", role_registry_outage)
    assert await app_state.job_runner._permission_alive(job) is False  # noqa: SLF001


@pytest.mark.asyncio
async def test_sensitive_admission_uses_strict_exact_session_authority(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    await _enable_user(app_state)
    token = app_state.auth.authenticate("alice", "Correct-horse-123!")
    assert token
    claims = app_state.auth.claims_of(token)
    assert isinstance(claims, dict)
    sid = str(claims["sid"])
    tv = int(claims["tv"])
    await app_state.sessions.create(
        sid=sid,
        username="alice",
        token_version=tv,
        mfa_method="password",
    )
    request = _request(app_state, token)
    policy = app_state.prefs.session_policy
    expected = await app_state.sessions.strict_deferred_authority_expires_at(
        sid=sid,
        username="alice",
        token_version=tv,
        idle_timeout=int(policy.idle_timeout or 0),
        absolute_lifetime=int(policy.absolute_lifetime or 0),
        sudo_window=int(policy.sudo_reauth_window or 600),
    )
    expires_at, stored_sid, stored_tv = await _fresh_fields(
        request, app_state, JobKind.DATA_EXPORT_ARCHIVE
    )
    assert expires_at == expected
    assert (stored_sid, stored_tv) == (sid, tv)

    assert await app_state.sessions.revoke(sid, by="admin", reason="test") is True
    with pytest.raises(HTTPException) as revoked:
        await _fresh_fields(request, app_state, JobKind.DATA_EXPORT_ARCHIVE)
    assert revoked.value.status_code == 401

    async def session_registry_outage(**_kwargs):
        raise RuntimeError("session registry unavailable")

    monkeypatch.setattr(
        app_state.sessions,
        "strict_deferred_authority_expires_at",
        session_registry_outage,
    )
    with pytest.raises(HTTPException) as unavailable:
        await _fresh_fields(request, app_state, JobKind.DATA_EXPORT_ARCHIVE)
    assert unavailable.value.status_code == 503


@pytest.mark.asyncio
async def test_5000_item_progress_throttles_live_event_bus_and_forces_terminal(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both the one-second and five-percent gates bind before terminal fan-out."""

    import app.engine.jobs as jobs_module

    await _quiet(app_state)
    case_ids = [f"case-progress-{number:04d}" for number in range(5_000)]
    stored, _, _ = await app_state.jobs.create(
        _job(
            actor="",
            key="five-thousand-progress-items",
            params={"case_ids": case_ids, "tag": "progress-test"},
            # The execution effect is not under test. Pre-completed states let the
            # authoritative terminal row truthfully retain done=total after the
            # synthetic running projections below exercise the delivery policy.
            item_states={case_id: "succeeded" for case_id in case_ids},
        )
    )
    claimed = await app_state.jobs.claim_next(
        "progress-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    assert await app_state.job_runner.reconcile_audits() is True

    bus = get_event_bus()
    bus.clear()
    emitted: list[tuple[float, int, str]] = []
    original_publish = bus.publish
    clock = {"now": 0.0}

    def capture_event(topic, event_type, data, **kwargs):
        if topic == "jobs" and data.get("job_id") == stored.job_id:
            emitted.append(
                (
                    clock["now"],
                    int(data["progress"]["done"]),
                    str(data["status"]),
                )
            )
        return original_publish(topic, event_type, data, **kwargs)

    class _ClockedLoop:
        def time(self) -> float:
            return clock["now"]

    monkeypatch.setattr(bus, "publish", capture_event)
    # Replace only the jobs module's asyncio reference. Other stores retain the real
    # event loop while JobRunner.publish observes this deterministic monotonic clock.
    monkeypatch.setattr(
        jobs_module,
        "asyncio",
        SimpleNamespace(get_running_loop=lambda: _ClockedLoop()),
    )
    app_state.job_runner._last_emit.pop(stored.job_id, None)  # noqa: SLF001

    for done in range(1, 5_001):
        # First half: 5% arrives every 0.5 s, so the one-second gate binds and emits
        # at 10% steps. Second half: time advances quickly, so the 5% gate binds.
        clock["now"] = (
            done / 500
            if done <= 2_500
            else 5 + (done - 2_500) / 50
        )
        snapshot = running.model_copy(
            update={
                "progress": JobProgress(done=done, total=5_000, unit="cases")
            }
        )
        await app_state.job_runner.publish(snapshot)

    progress_events = list(emitted)
    assert [done for _, done, _ in progress_events] == [
        500,
        1_000,
        1_500,
        2_000,
        2_500,
        2_750,
        3_000,
        3_250,
        3_500,
        3_750,
        4_000,
        4_250,
        4_500,
        4_750,
        5_000,
    ]
    # 5% at item 250 is too soon; one elapsed second at item 2550 advances only
    # 1%. An OR implementation would emit at one or both of these probes.
    assert 250 not in {done for _, done, _ in progress_events}
    assert 2_550 not in {done for _, done, _ in progress_events}
    for (prior_time, prior_done, _), (now, done, _) in zip(
        progress_events, progress_events[1:]
    ):
        assert now - prior_time >= 1.0
        assert int(done * 100 / 5_000) - int(prior_done * 100 / 5_000) >= 5

    terminal = await app_state.jobs.finish(
        stored.job_id,
        token,
        JobStatus.SUCCEEDED,
        result=JobResult(
            kind="case_tagging",
            counts={"succeeded": 5_000, "failed": 0, "total": 5_000},
        ),
    )
    assert await app_state.job_runner.reconcile_audits() is True
    # No time or percentage changed after the 100% running event: terminal must
    # nevertheless be forced through the exact same EventBus.
    await app_state.job_runner.publish(terminal)
    assert len(emitted) == 16
    assert emitted[-2][1:] == (5_000, JobStatus.RUNNING.value)
    assert emitted[-1][1:] == (5_000, JobStatus.SUCCEEDED.value)


@pytest.mark.asyncio
async def test_claimed_multi_item_job_stops_after_live_permission_revocation(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One completed effect survives; no later item crosses the revoked grant."""

    import app.api.routes as case_routes
    from app.constants import ActionType, CaseStatus, EntityType, SourceSurface
    from app.models import Case, Entity

    await _quiet(app_state)
    user = await _enable_user(app_state, role=UserRole.ANALYST_TIER1)
    await app_state.update_prefs(
        app_state.prefs.model_copy(
            update={
                "rbac": app_state.prefs.rbac.model_copy(update={"enabled": True})
            }
        )
    )
    case_ids = ["case-grant-1", "case-grant-2", "case-grant-3"]
    for number, case_id in enumerate(case_ids, start=1):
        await app_state.real_cases.save(
            Case(
                case_id=case_id,
                cluster_signature=f"grant-boundary-{number}",
                source_surface=SourceSurface.AUTOMATED_SCAN,
                entity=Entity(type=EntityType.IP, value=f"203.0.113.{number}"),
                status=CaseStatus.OPEN,
            )
        )

    stored, _, _ = await app_state.jobs.create(
        _job(
            actor="alice",
            generation=account_generation(user.username, user.created_at),
            key="live-permission-revocation",
            params={"case_ids": case_ids, "tag": "permission-crossed"},
            item_states={case_id: "pending" for case_id in case_ids},
            permissions=[("cases", "write")],
        )
    )
    claimed = await app_state.jobs.claim_next(
        "permission-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    assert await app_state.job_runner.reconcile_audits() is True

    effects: list[str] = []
    original_case_tags = case_routes.case_tags

    async def revoke_after_first_effect(case_id, body, state, request=None):
        result = await original_case_tags(case_id, body, state, request=request)
        effects.append(case_id)
        if len(effects) == 1:
            updated = await state.users.update(
                "alice", role=UserRole.AUDITOR.value
            )
            assert updated is not None
        return result

    monkeypatch.setattr(case_routes, "case_tags", revoke_after_first_effect)
    await app_state.job_runner._execute(running, token)  # noqa: SLF001

    assert effects == [case_ids[0]]
    first = await app_state.real_cases.get(case_ids[0])
    second = await app_state.real_cases.get(case_ids[1])
    third = await app_state.real_cases.get(case_ids[2])
    assert first is not None and "permission-crossed" in first.tags
    assert second is not None and "permission-crossed" not in second.tags
    assert third is not None and "permission-crossed" not in third.tags

    terminal = await app_state.jobs.get(stored.job_id)
    assert terminal is not None and terminal.status == JobStatus.FAILED
    assert terminal.progress.done == 1 and terminal.progress.total == 3
    assert terminal.result is not None
    # Authority loss is one job-level failure, not invented per-item failures for
    # effects that never ran; the one completed effect remains truthful.
    assert terminal.result.counts == {
        "succeeded": 1,
        "failed": 0,
        "total": 3,
        "job_errors": 1,
    }
    assert terminal.failure_count == 1
    assert terminal.failures[0].item_ref == "job"
    assert "no longer holds" in terminal.failures[0].reason
    assert all(transition.audited for transition in terminal.transitions)
    assert [transition.name for transition in terminal.transitions] == [
        "submitted",
        "started",
        "failed",
    ]
    audit_rows = await app_state.control_audit.records(
        actor="alice", action_type=ActionType.JOB.value, surface="jobs", limit=100
    )
    summaries = "\n".join(str(row.get("result_summary") or "") for row in audit_rows)
    for transition in ("submitted", "started", "failed"):
        assert f"transition={transition}" in summaries


@pytest.mark.asyncio
async def test_independent_heartbeat_prevents_reclaim_during_blocked_effect(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    import app.engine.jobs as jobs_module

    stored, _, _ = await app_state.jobs.create(
        _job(item_states={"case-1": "pending"})
    )
    claimed = await app_state.jobs.claim_next("worker-a", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed

    entered_effect = asyncio.Event()
    release_effect = asyncio.Event()
    heartbeat_go = asyncio.Event()
    heartbeat_renewed = asyncio.Event()
    heartbeat_park = asyncio.Event()
    original_sleep = asyncio.sleep
    original_renew = app_state.jobs.renew
    renew_calls = 0

    async def controlled_sleep(_delay: float):
        task = asyncio.current_task()
        if task is not None and task.get_name().startswith("job-lease-"):
            if not heartbeat_go.is_set():
                await heartbeat_go.wait()
            else:
                await heartbeat_park.wait()
            return
        await original_sleep(0)

    async def observed_renew(*args, **kwargs):
        nonlocal renew_calls
        row = await original_renew(*args, **kwargs)
        renew_calls += 1
        if renew_calls >= 2:  # checkpoint renew, then independent heartbeat renew
            heartbeat_renewed.set()
        return row

    async def blocked_handler(_job_row: Job, _token: str) -> None:
        entered_effect.set()
        await release_effect.wait()

    monkeypatch.setattr(jobs_module.asyncio, "sleep", controlled_sleep)
    monkeypatch.setattr(app_state.jobs, "renew", observed_renew)
    monkeypatch.setattr(app_state.job_runner, "_case_tag", blocked_handler)

    owner = asyncio.create_task(
        app_state.job_runner._execute(running, token),  # noqa: SLF001
        name="blocked-effect-owner",
    )
    await asyncio.wait_for(entered_effect.wait(), timeout=1)
    await _expire_lease(app_state, stored.job_id)
    heartbeat_go.set()
    await asyncio.wait_for(heartbeat_renewed.wait(), timeout=1)
    assert await JobStore(app_state.kv).claim_next(
        "worker-b", lease_millis=30_000
    ) is None
    release_effect.set()
    await asyncio.wait_for(owner, timeout=1)


@pytest.mark.asyncio
async def test_shared_investigation_gate_reserves_ingest_and_prioritizes_at_cap_one(
    app_state,
) -> None:
    await _quiet(app_state)
    assert app_state.real_pipeline._investigation_gate is app_state.investigation_gate  # noqa: SLF001

    gate = InvestigationGate()
    release_first = asyncio.Event()
    first_started = asyncio.Event()
    order: list[str] = []

    async def first_background():
        async with gate.permit(1, "background"):
            first_started.set()
            await release_first.wait()

    async def contender(label: str, priority: str):
        async with gate.permit(1, priority):  # type: ignore[arg-type]
            order.append(label)

    first = asyncio.create_task(first_background())
    await first_started.wait()
    second = asyncio.create_task(contender("background", "background"))
    ingest = asyncio.create_task(contender("ingest", "ingest"))
    for _ in range(100):
        if gate._ingest_waiters:  # noqa: SLF001 - assert the tested scheduling state
            break
        await asyncio.sleep(0)
    assert gate._ingest_waiters == 1  # noqa: SLF001
    release_first.set()
    await asyncio.wait_for(asyncio.gather(first, ingest, second), timeout=1)
    assert order == ["ingest", "background"]
    assert gate.active == 0


@pytest.mark.asyncio
async def test_artifact_reservation_integrity_and_restart_visibility(
    app_state, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    await _quiet(app_state)
    monkeypatch.setattr(app_state.secrets, "jobs_artifact_dir", str(tmp_path))
    stored, _, _ = await app_state.jobs.create(
        _job(
            kind=JobKind.DATA_EXPORT_ARCHIVE,
            params={"scopes": ["cases"]},
            item_states={"cases": "pending"},
        )
    )
    claimed = await app_state.jobs.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    path, artifact_id = await app_state.job_runner._reserve_artifact_path(  # noqa: SLF001
        running, token, ".zip"
    )
    path.write_bytes(b"PK\x03\x04durable-test")
    artifact = await app_state.job_runner._artifact_meta(  # noqa: SLF001
        path, artifact_id, "export.zip", "application/zip"
    )
    with pytest.raises(RuntimeError):
        await app_state.jobs.attach_artifact(
            running.job_id,
            token,
            artifact.model_copy(update={"artifact_id": uuid4().hex}),
        )
    await app_state.jobs.attach_artifact(running.job_id, token, artifact)
    assert await app_state.job_runner.verify_artifact(artifact) == path
    restarted = JobStore(app_state.kv)
    visible = await restarted.get(stored.job_id)
    assert visible is not None and visible.artifact == artifact
    path.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="integrity"):
        await app_state.job_runner.verify_artifact(artifact)


@pytest.mark.asyncio
async def test_artifact_download_rechecks_original_live_permission(
    app_state, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A retained export must not bypass a grant revoked after it completed."""

    await _quiet(app_state)
    owner = await _enable_user(app_state, role=UserRole.SOC_MANAGER)
    token = app_state.auth.authenticate("alice", "Correct-horse-123!")
    assert token
    generation = account_generation(owner.username, owner.created_at)
    monkeypatch.setattr(app_state.secrets, "jobs_artifact_dir", str(tmp_path))
    stored, _, _ = await app_state.jobs.create(
        _job(
            kind=JobKind.DATA_EXPORT_ARCHIVE,
            actor="alice",
            generation=generation,
            params={"scopes": ["cases"]},
            item_states={"cases": "pending"},
            permissions=[("data_export", "export")],
        )
    )
    claimed = await app_state.jobs.claim_next("worker", lease_millis=30_000)
    assert claimed is not None
    running, lease_token = claimed
    path, artifact_id = await app_state.job_runner._reserve_artifact_path(  # noqa: SLF001
        running, lease_token, ".zip"
    )
    path.write_bytes(b"PK\x03\x04permission-revocation")
    artifact = await app_state.job_runner._artifact_meta(  # noqa: SLF001
        path, artifact_id, "export.zip", "application/zip"
    )
    await app_state.jobs.attach_artifact(running.job_id, lease_token, artifact)
    await app_state.jobs.complete_item(running.job_id, lease_token, "cases")
    await app_state.jobs.finish(
        running.job_id,
        lease_token,
        JobStatus.SUCCEEDED,
        result=JobResult(
            kind="data_export_archive",
            artifact_id=artifact_id,
            counts={"succeeded": 1, "failed": 0, "total": 1},
        ),
    )

    # Same account generation, but the role no longer grants bulk data extraction.
    updated = await app_state.users.update(
        "alice", role=UserRole.ANALYST_TIER1.value
    )
    assert updated is not None
    app_state.prefs = app_state.prefs.model_copy(
        update={"rbac": RBACConfig(enabled=True)}
    )
    await app_state.refresh_users()
    with _client_for_state(app_state, jobs_router) as client:
        response = client.get(
            f"/api/jobs/{stored.job_id}/artifact",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_artifact_retention_is_bounded_without_pruning_active_rows(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    import app.stores.jobs as jobs_store_module

    monkeypatch.setattr(jobs_store_module, "MAX_RETAINED_ARTIFACTS", 3)
    pruned_ids: set[str] = set()
    for index in range(4):
        job, _, pruned = await app_state.jobs.create(
            _job(
                key=f"artifact-{index}",
                item_states={f"case-{index}": "pending"},
                params={"case_ids": [f"case-{index}"], "tag": "triaged"},
            )
        )
        pruned_ids.update(row.artifact_id for row in pruned)
        claimed = await app_state.jobs.claim_next("worker", lease_millis=30_000)
        assert claimed is not None
        running, token = claimed
        _row, artifact_id = await app_state.jobs.reserve_artifact(
            running.job_id, token, suffix=".zip"
        )
        artifact = JobArtifact(
            artifact_id=artifact_id,
            filename=f"artifact-{index}.zip",
            content_type="application/zip",
            size=index,
            sha256=hashlib.sha256(str(index).encode()).hexdigest(),
        )
        _attached, expired = await app_state.jobs.attach_artifact(
            running.job_id, token, artifact
        )
        pruned_ids.update(row.artifact_id for row in expired)
        await app_state.jobs.complete_item(
            running.job_id, token, f"case-{index}"
        )
        await app_state.jobs.finish(running.job_id, token, JobStatus.SUCCEEDED)

    rows = await app_state.jobs.list_for_actor("")
    retained = [row.artifact for row in rows if row.artifact is not None]
    assert len(retained) == 3
    assert len(pruned_ids) == 1


@pytest.mark.asyncio
async def test_factory_fence_quiescence_and_identity_free_receipt(app_state) -> None:
    await _quiet(app_state)
    store = app_state.jobs
    factory, _, _ = await store.create(
        _job(
            kind=JobKind.TIERED_RESET,
            actor="alice",
            generation="old-generation",
            key="factory-reset",
            params={"scope": "factory", "confirm": "FACTORY RESET"},
            item_states={"reset": "pending"},
            permissions=[("users", "manage")],
        )
    )
    factory_claim = await store.claim_next("factory-worker", lease_millis=30_000)
    assert factory_claim is not None
    factory_running, factory_token = factory_claim

    other, _, _ = await store.create(
        _job(actor="bob", generation="bob-generation", key="other-job")
    )
    other_claim = await store.claim_next("other-worker", lease_millis=30_000)
    assert other_claim is not None
    other_running, other_token = other_claim
    _row, artifact_id = await store.reserve_artifact(
        other_running.job_id, other_token, suffix=".zip"
    )
    artifact = JobArtifact(
        artifact_id=artifact_id,
        filename="old-private-export.zip",
        content_type="application/zip",
        size=1,
        sha256=hashlib.sha256(b"x").hexdigest(),
    )
    await store.attach_artifact(other_running.job_id, other_token, artifact)

    _current, _ = await store.begin_factory_fence(
        factory_running.job_id, factory_token
    )
    fenced_other = await store.get(other.job_id)
    assert fenced_other is not None and fenced_other.cancel_requested
    assert await store.factory_quiescent(factory.job_id, factory_token) is False
    with pytest.raises(JobCapacityError):
        await store.create(_job(key="submission-during-factory"))
    await store.finish(other.job_id, other_token, JobStatus.CANCELLED)
    assert await store.factory_quiescent(factory.job_id, factory_token) is True

    result = JobResult(
        kind="tiered_reset",
        counts={"attempted": 3, "cleared": 3, "succeeded": 3, "failed": 0, "total": 3},
    )
    receipt, artifacts = await store.factory_compact(
        factory.job_id,
        factory_token,
        status=JobStatus.SUCCEEDED,
        result=result,
        app_version="test",
        build_sha="deadbeef",
    )
    assert artifacts == [artifact]
    assert receipt.actor == ""
    assert receipt.actor_generation == ""
    assert receipt.request_fingerprint == ""
    assert receipt.idempotency_key_hash == ""
    assert receipt.params == {"scope": "factory"}
    assert receipt.required_permissions == []
    assert receipt.item_states == {}
    assert receipt.artifact is None
    serialized = receipt.model_dump_json()
    for private_value in ("alice", "bob", "old-generation", "bob-generation"):
        assert private_value not in serialized
    assert await store.get(other.job_id) is None
    rows = await store.list_for_actor("")
    assert [row.job_id for row in rows] == [receipt.job_id]


@pytest.mark.asyncio
async def test_factory_fence_acquisition_failure_rolls_back_before_destructive_boundary(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A partial control-fence acquisition cannot strand or fail-open the tenant."""

    await _quiet(app_state)
    factory, _, _ = await app_state.jobs.create(
        _job(
            kind=JobKind.TIERED_RESET,
            key="factory-acquisition-rollback",
            params={"scope": "factory", "confirm": "FACTORY RESET"},
            item_states={"reset": "pending"},
            permissions=[("users", "manage")],
        )
    )
    claimed = await app_state.jobs.claim_next(
        "factory-acquisition-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    assert await app_state.job_runner.reconcile_audits() is True

    async def batch_fence_outage(_job_id: str) -> int:
        raise RuntimeError("injected Batch fence outage")

    monkeypatch.setattr(
        app_state.real_batch_job_store,
        "begin_factory_fence",
        batch_fence_outage,
    )
    with pytest.raises(RuntimeError, match="Batch fence outage"):
        await app_state.job_runner._tiered_reset(running, token)  # noqa: SLF001

    # Jobs fencing happened before the injected second-document failure, but the
    # pre-destructive rollback must restore every admission surface coherently.
    assert await app_state.jobs.factory_fence_owner() == ""
    batch_doc = await app_state.kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY)
    assert not isinstance(batch_doc, dict) or not batch_doc.get("factory_fence")
    assert app_state.mutation_gate.closed is False
    assert app_state.mutation_gate.degraded is False
    assert app_state.mutation_gate.active == 0

    ordinary, created, _ = await app_state.jobs.create(
        _job(key="admitted-after-clean-acquisition-rollback")
    )
    assert created is True and ordinary.job_id != factory.job_id


@pytest.mark.asyncio
async def test_factory_receipt_audit_precedes_every_release_and_failure_stays_fenced(
    app_state, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Factory visibility is sanitized and audited before any boundary reopens."""

    await _quiet(app_state)
    app_state.secrets.jobs_artifact_dir = str(tmp_path / "factory-artifacts")
    old, _, _ = await app_state.jobs.create(
        _job(
            actor="pre-reset-private-actor",
            generation="pre-reset-private-generation",
            key="pre-reset-private-job",
            params={"case_ids": ["case-pre-reset"], "tag": "private-tag"},
            item_states={"case-pre-reset": "succeeded"},
        )
    )
    claimed = await app_state.jobs.claim_next(
        "pre-reset-worker", lease_millis=30_000
    )
    assert claimed is not None
    old_running, old_token = claimed
    await app_state.jobs.finish(
        old_running.job_id,
        old_token,
        JobStatus.SUCCEEDED,
        result=JobResult(
            kind="case_tagging",
            counts={"succeeded": 1, "failed": 0, "total": 1},
        ),
    )
    assert await app_state.job_runner.reconcile_audits() is True

    order: list[str] = []
    fail_receipt_for = {"job_id": ""}
    original_record = app_state.control_audit.record_strict
    original_compact = app_state.jobs.factory_compact
    original_jobs_release = app_state.jobs.release_factory_fence
    original_batch_release = app_state.real_batch_job_store.release_factory_fence
    original_http_open = app_state.mutation_gate.open

    async def traced_record(**kwargs):
        event_id = str(kwargs.get("event_id") or "")
        order.append(f"audit:{event_id}")
        if event_id == f"job:{fail_receipt_for['job_id']}:factory-receipt":
            raise RuntimeError("injected sanitized receipt audit outage")
        return await original_record(**kwargs)

    async def traced_compact(job_id, token, **kwargs):
        order.append(f"compact:{job_id}:begin")
        value = await original_compact(job_id, token, **kwargs)
        # Compaction removes every private row but must retain its control fence
        # until both sanitized audit appends below are confirmed.
        assert await app_state.jobs.factory_fence_owner() == job_id
        order.append(f"compact:{job_id}:fenced")
        return value

    async def traced_jobs_release(job_id):
        order.append(f"release:jobs:{job_id}")
        return await original_jobs_release(job_id)

    async def traced_batch_release(job_id):
        order.append(f"release:batch:{job_id}")
        return await original_batch_release(job_id)

    async def traced_http_open(job_id):
        order.append(f"release:http:{job_id}")
        return await original_http_open(job_id)

    monkeypatch.setattr(app_state.control_audit, "record_strict", traced_record)
    monkeypatch.setattr(app_state.jobs, "factory_compact", traced_compact)
    monkeypatch.setattr(
        app_state.jobs, "release_factory_fence", traced_jobs_release
    )
    monkeypatch.setattr(
        app_state.real_batch_job_store,
        "release_factory_fence",
        traced_batch_release,
    )
    monkeypatch.setattr(app_state.mutation_gate, "open", traced_http_open)

    async def submit_and_claim(key: str, actor: str):
        factory, _, _ = await app_state.jobs.create(
            _job(
                kind=JobKind.TIERED_RESET,
                actor=actor,
                generation=f"{actor}-generation",
                key=key,
                params={"scope": "factory", "confirm": "FACTORY RESET"},
                item_states={"reset": "pending"},
                permissions=[("users", "manage")],
            )
        )
        pair = await app_state.jobs.claim_next(
            f"{key}-worker", lease_millis=30_000
        )
        assert pair is not None
        running, token = pair
        assert running.job_id == factory.job_id
        assert await app_state.job_runner.reconcile_audits() is True
        return running, token

    # First prove the complete happy-path order and sanitized post-reset surface.
    first, first_token = await submit_and_claim(
        "factory-order-success", "first-private-admin"
    )
    order.clear()
    await app_state.job_runner._tiered_reset(first, first_token)  # noqa: SLF001
    receipt = await app_state.jobs.get(first.job_id)
    assert receipt is not None and receipt.actor == ""
    assert all(transition.audited for transition in receipt.transitions)
    assert await app_state.jobs.get(old.job_id) is None
    assert await app_state.jobs.factory_fence_owner() == ""
    batch_doc = await app_state.kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY)
    assert isinstance(batch_doc, dict) and batch_doc.get("factory_fence", "") == ""
    assert app_state.mutation_gate.closed is False

    compact_at = order.index(f"compact:{first.job_id}:fenced")
    receipt_audit_at = order.index(
        f"audit:job:{first.job_id}:factory-receipt"
    )
    transition_audit_at = order.index(
        f"audit:job:{first.job_id}:transition:1"
    )
    release_positions = [
        order.index(f"release:{surface}:{first.job_id}")
        for surface in ("jobs", "batch", "http")
    ]
    assert compact_at < receipt_audit_at < transition_audit_at
    assert transition_audit_at < min(release_positions)

    audit_rows = await app_state.control_audit.records(limit=500)
    serialized_audit = json.dumps(audit_rows, sort_keys=True)
    for private_value in (
        "pre-reset-private-actor",
        "pre-reset-private-generation",
        "first-private-admin",
        old.job_id,
    ):
        assert private_value not in serialized_audit

    # Then fault the sanitized receipt append after compaction. No durable or local
    # admission fence may reopen, even though the tenant data clear itself succeeded.
    second, second_token = await submit_and_claim(
        "factory-order-audit-failure", "second-private-admin"
    )
    fail_receipt_for["job_id"] = second.job_id
    order.clear()
    try:
        await app_state.job_runner._tiered_reset(second, second_token)  # noqa: SLF001
    except RuntimeError as exc:
        assert "sanitized receipt audit outage" in str(exc)

    failed_receipt = await app_state.jobs.get(second.job_id)
    assert failed_receipt is not None and failed_receipt.actor == ""
    assert any(not transition.audited for transition in failed_receipt.transitions)
    assert await app_state.jobs.get(first.job_id) is None
    assert await app_state.jobs.factory_fence_owner() == second.job_id
    batch_doc = await app_state.kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY)
    assert isinstance(batch_doc, dict)
    assert batch_doc.get("factory_fence") == second.job_id
    assert app_state.mutation_gate.closed is True
    assert app_state.mutation_gate.degraded is True
    assert app_state.mutation_gate.owner == second.job_id
    assert not any(item.startswith("release:") for item in order)

    audit_rows = await app_state.control_audit.records(limit=500)
    serialized_audit = json.dumps(audit_rows, sort_keys=True)
    for private_value in (
        "pre-reset-private-actor",
        "first-private-admin",
        "second-private-admin",
        old.job_id,
        first.job_id,
    ):
        assert private_value not in serialized_audit


@pytest.mark.asyncio
async def test_factory_closes_existing_sse_before_waiting_for_http_drain(
    app_state, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """A pre-fence EventSource cannot pin active admission until reset timeout."""

    from starlette.responses import StreamingResponse

    await _quiet(app_state)
    app_state.secrets.jobs_artifact_dir = str(tmp_path / "sse-factory-artifacts")
    bus = get_event_bus()
    bus.clear()
    old_event_id = bus.publish(
        "cases",
        "case",
        {"case_id": "pre-reset-private-case"},
        retain=True,
    )

    api = FastAPI()
    api.state.tlsoc = app_state
    api.add_middleware(MutationAdmissionMiddleware)

    @api.get("/api/events")
    async def events():
        return StreamingResponse(
            bus.subscribe(["cases"], user=None),
            media_type="text/event-stream",
        )

    factory, _, _ = await app_state.jobs.create(
        _job(
            kind=JobKind.TIERED_RESET,
            actor="sse-reset-admin",
            generation="sse-reset-generation",
            key="factory-existing-sse",
            params={"scope": "factory", "confirm": "FACTORY RESET"},
            item_states={"reset": "pending"},
            permissions=[("users", "manage")],
        )
    )
    claimed = await app_state.jobs.claim_next(
        "sse-factory-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    assert running.job_id == factory.job_id
    assert await app_state.job_runner.reconcile_audits() is True

    original_wait_drained = app_state.mutation_gate.wait_drained
    observed_at_drain: list[tuple[int, int]] = []

    async def short_verified_drain(owner: str, *, timeout: float) -> None:
        del timeout
        observed_at_drain.append(
            (bus.subscriber_count, len(bus.replay(frozenset({"cases"}), None, "0")))
        )
        await original_wait_drained(owner, timeout=1.0)

    monkeypatch.setattr(
        app_state.mutation_gate, "wait_drained", short_verified_drain
    )
    transport = ASGITransport(app=api)
    stream_task: asyncio.Task | None = None
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            stream_task = asyncio.create_task(client.get("/api/events"))
            for _ in range(100):
                if bus.subscriber_count == 1 and app_state.mutation_gate.active == 1:
                    break
                await asyncio.sleep(0)
            assert bus.subscriber_count == 1
            assert app_state.mutation_gate.active == 1

            await asyncio.wait_for(
                app_state.job_runner._tiered_reset(running, token),  # noqa: SLF001
                timeout=3.0,
            )
            response = await asyncio.wait_for(stream_task, timeout=1.0)
            assert response.status_code == 200
            assert b": connected" in response.content
    finally:
        if stream_task is not None and not stream_task.done():
            stream_task.cancel()
            await asyncio.gather(stream_task, return_exceptions=True)

    # The runner must clear sockets/history before entering its admission drain;
    # otherwise the StreamingResponse keeps the middleware context active forever.
    assert observed_at_drain == [(0, 0)]
    assert bus.subscriber_count == 0
    assert bus.replay(frozenset({"cases"}), None, "0") == []
    assert old_event_id != ""
    assert app_state.mutation_gate.active == 0
    assert app_state.mutation_gate.closed is False
    receipt = await app_state.jobs.get(factory.job_id)
    assert receipt is not None and receipt.status == JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_degraded_factory_retry_transfers_jobs_and_batch_fences(
    app_state,
) -> None:
    """A fresh retry must be able to recover a partially cleared, fenced tenant."""

    await _quiet(app_state)
    old, _, _ = await app_state.jobs.create(
        _job(
            kind=JobKind.TIERED_RESET,
            actor="admin",
            generation="old-admin-generation",
            key="factory-failed-attempt",
            params={"scope": "factory", "confirm": "FACTORY RESET"},
            item_states={"reset": "pending"},
            permissions=[("users", "manage")],
        )
    )
    claimed = await app_state.jobs.claim_next("factory-worker", lease_millis=30_000)
    assert claimed is not None
    running, token = claimed
    await app_state.jobs.begin_factory_fence(running.job_id, token)
    old_epoch = await app_state.real_batch_job_store.begin_factory_fence(running.job_id)
    failed = await app_state.jobs.finish(
        running.job_id,
        token,
        JobStatus.FAILED,
        job_error="privacy boundary could not be confirmed",
    )
    assert failed.params == {"scope": "factory"}

    with pytest.raises(JobCapacityError):
        await app_state.jobs.create(_job(key="ordinary-work-stays-fenced"))

    retry = _job(
        kind=JobKind.TIERED_RESET,
        actor="recovery-admin",
        generation="recovery-generation",
        key="factory-recovery-attempt",
        params={"scope": "factory", "confirm": "FACTORY RESET"},
        item_states={"reset": "pending"},
        permissions=[("users", "manage")],
    )
    retry.fresh_authorized_until_millis = int(time.time() * 1000) + 60_000
    recovered, created, _ = await app_state.jobs.create(retry)
    assert created is True and recovered.job_id != old.job_id

    # The regular Jobs fence transfers in the create CAS. The Batch fence must then
    # transfer to the same recovery owner while incrementing its durable reset epoch,
    # so pre-failure Batch closures remain stale across the recovery attempt.
    new_epoch = await app_state.real_batch_job_store.begin_factory_fence(
        recovered.job_id
    )
    assert new_epoch > old_epoch
    batch_doc = await app_state.kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY)
    assert isinstance(batch_doc, dict)
    assert batch_doc["factory_fence"] == recovered.job_id
    assert batch_doc["reset_epoch"] == new_epoch


@pytest.mark.asyncio
async def test_factory_critical_kv_clear_cannot_accept_silent_best_effort_drop() -> None:
    from app.engine.reset import _clear_kv

    class SilentDropKV:
        strict_called = False

        async def get(self, _namespace, _key):
            return {"private": "still-present"}

        async def get_strict(self, _namespace, _key):
            return {"private": "still-present"}

        async def put(self, _namespace, _key, _value):
            return None  # legacy best-effort API silently loses the write

        async def put_strict(self, _namespace, _key, _value):
            self.strict_called = True
            raise RuntimeError("durability unavailable")

    kv = SilentDropKV()
    host = SimpleNamespace(kv=kv)
    assert await _clear_kv(host, "users", "entries", strict=True) is False
    assert kv.strict_called is True


@pytest.mark.asyncio
async def test_jobs_wire_shape_and_legacy_mutation_bypasses_are_gone(app_state) -> None:
    await _quiet(app_state)
    with _client_for_state(
        app_state, jobs_router, reset_router, storage_router
    ) as client:
        submitted = client.post(
            "/api/jobs",
            json={
                "kind": "case_tag",
                "idempotency_key": "wire-shape-key",
                "params": {"case_ids": ["case-2", "case-1"], "tag": "triaged"},
            },
        )
        assert submitted.status_code == 202, submitted.text
        body = submitted.json()
        assert body["job_id"].startswith("job-")
        assert body["status"] == "queued"
        assert "job" not in body and "created" not in body
        detail = client.get(f"/api/jobs/{body['job_id']}")
        assert detail.status_code == 200
        assert detail.json().keys() == body.keys()
        listing = client.get("/api/jobs")
        assert listing.status_code == 200
        assert listing.json()["jobs"][0]["job_id"] == body["job_id"]

        reset = client.post(
            "/api/admin/reset",
            json={"scope": "factory", "confirm": "FACTORY RESET"},
        )
        assert reset.status_code == 410
        assert reset.json()["detail"]["code"] == "durable_job_required"
        storage = client.post("/api/storage/lifecycle/apply")
        assert storage.status_code == 410
        assert storage.json()["detail"]["code"] == "durable_job_required"


def test_request_bound_long_compatibility_routes_are_openapi_deprecated() -> None:
    """Every user-facing workflow migrated to Jobs; legacy HTTP seams stay explicit."""

    expected = {
        ("POST", "/api/admin/export/archive"),
        ("POST", "/api/admin/export/segment"),
        ("POST", "/api/rag/import"),
        ("POST", "/api/rag/precedent/bootstrap"),
        ("POST", "/api/runbooks/reindex"),
    }
    observed: dict[tuple[str, str], bool | None] = {}
    for feature_router in (export_router, rag_router, runbooks_router):
        for route in feature_router.routes:
            for method in getattr(route, "methods", set()):
                key = (str(method), str(getattr(route, "path", "")))
                if key in expected:
                    observed[key] = getattr(route, "deprecated", None)

    assert set(observed) == expected
    assert all(observed.values())


@pytest.mark.asyncio
async def test_jobs_and_inbox_realtime_topics_are_live_and_audience_scoped() -> None:
    from app.api.routes import _REALTIME_TOPICS

    assert {"jobs", "inbox"}.issubset(_REALTIME_TOPICS)
    bus = EventBus(heartbeat_seconds=60)
    stream = bus.subscribe(["jobs", "inbox"], "alice")
    assert await anext(stream) == b": connected\n\n"
    job_event = bus.publish(
        "jobs",
        "job",
        {"job_id": "job-live"},
        audience=["alice"],
        retain=False,
    )
    bus.publish(
        "inbox",
        "inapp",
        {"id": "note-live"},
        audience=["alice"],
    )
    first = await asyncio.wait_for(anext(stream), timeout=1)
    second = await asyncio.wait_for(anext(stream), timeout=1)
    assert b"job-live" in first
    assert b"note-live" in second
    assert bus.replay(frozenset({"jobs"}), "alice", "0") == []
    assert bus.replay(frozenset({"jobs"}), "bob", "0") == []
    assert len(bus.replay(frozenset({"inbox"}), "alice", job_event)) == 1
    assert bus.replay(frozenset({"inbox"}), "bob", job_event) == []
    await stream.aclose()


@pytest.mark.asyncio
async def test_batch_audience_outage_stays_pending_then_projects_one_safe_note(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _quiet(app_state)
    await _enable_user(app_state)
    original_get = app_state.kv.get_strict

    async def authorization_registry_outage(namespace: str, key: str):
        if (namespace, key) in {
            (USERS_NS, USERS_KEY),
            (CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY),
        }:
            raise RuntimeError("authorization registry unavailable")
        return await original_get(namespace, key)

    monkeypatch.setattr(app_state.kv, "get_strict", authorization_registry_outage)
    batch = await prepare_batch_inbox_audience(
        app_state, _batch_job("batch-audience-outage")
    )
    assert batch.inbox_audience_state == "pending"
    batch, created = await app_state.real_batch_job_store.create_if_absent(batch)
    assert created is True
    await reconcile_batch_inbox(app_state, batch)
    stored = await app_state.real_batch_job_store.get_strict(batch.id)
    assert stored is not None and stored.inbox_audience_state == "pending"
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert notes == [] and total == 0

    monkeypatch.setattr(app_state.kv, "get_strict", original_get)
    await reconcile_batch_inbox(app_state, stored)
    projected = await app_state.real_batch_job_store.get_strict(batch.id)
    assert projected is not None and projected.inbox_audience_state == "ready"
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert len(notes) == total == 1
    first_id = notes[0].id
    public = json.dumps(public_inbox_item(notes[0]), sort_keys=True)
    for private_value in (
        "provider-private-handle",
        "raw-case-secret",
        "private request body",
        "private candidate body",
        "private provider traceback",
        "audience_generation",
    ):
        assert private_value not in public

    # Reconciliation is a stable upsert, not an append-only notification flood.
    await reconcile_batch_inbox(app_state, projected)
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert len(notes) == total == 1 and notes[0].id == first_id

    # A registry outage at read/SSE time hides even a previously persisted note.
    monkeypatch.setattr(app_state.kv, "get_strict", authorization_registry_outage)
    assert await filter_visible_batch_notes(app_state, "alice", notes) == []


@pytest.mark.asyncio
async def test_batch_permission_revoke_and_username_reuse_remove_projection(
    app_state,
) -> None:
    await _quiet(app_state)
    original = await _enable_user(app_state)
    batch = await prepare_batch_inbox_audience(
        app_state, _batch_job("batch-live-revocation")
    )
    batch, created = await app_state.real_batch_job_store.create_if_absent(batch)
    assert created is True
    await reconcile_batch_inbox(app_state, batch)
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert len(notes) == total == 1

    app_state.prefs = app_state.prefs.model_copy(
        update={
            "rbac": RBACConfig(
                enabled=True,
                denies={"analyst_tier1": {"models": ["read"]}},
            )
        }
    )
    current = await app_state.real_batch_job_store.get_strict(batch.id)
    assert current is not None
    await reconcile_batch_inbox(app_state, current)
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert notes == [] and total == 0

    app_state.prefs = app_state.prefs.model_copy(
        update={"rbac": RBACConfig(enabled=False)}
    )
    assert await app_state.users.delete("alice") is True
    await asyncio.sleep(0.002)
    replacement = await app_state.users.create(
        username="alice",
        password_hash=hash_password("Replacement-user-123!"),
        role=UserRole.ANALYST_TIER1.value,
    )
    assert account_generation(replacement.username, replacement.created_at) != (
        account_generation(original.username, original.created_at)
    )
    await app_state.refresh_users()
    current = await app_state.real_batch_job_store.get_strict(batch.id)
    assert current is not None
    await reconcile_batch_inbox(app_state, current)
    notes, total = await app_state.real_inbox.list_for_user("alice")
    assert notes == [] and total == 0


@pytest.mark.asyncio
async def test_unified_jobs_batch_projection_excludes_private_provider_state(
    app_state,
) -> None:
    """The shared Jobs list is an operator surface, not a provider-debug dump."""

    await _quiet(app_state)
    await app_state.real_batch_job_store.create_if_absent(
        _batch_job("batch-safe-public-projection")
    )

    with _client_for_state(app_state, jobs_router) as client:
        response = client.get("/api/jobs")

    assert response.status_code == 200, response.text
    related = response.json()["related"]
    assert related is not None
    rows = related["llm_batches"]
    assert len(rows) == 1
    assert rows[0]["id"] == "batch-safe-public-projection"
    assert "provider_batch_id" not in rows[0]
    assert "last_error" not in rows[0]
    assert "provider-private-handle" not in response.text
    assert "private provider traceback" not in response.text


@pytest.mark.asyncio
async def test_factory_http_mutation_gate_drains_and_recovery_paths_stay_bounded(
    app_state,
) -> None:
    """A factory fence must drain old writers and reject GET-shaped writers too."""

    await _quiet(app_state)
    gate = app_state.mutation_gate
    api = FastAPI()
    api.state.tlsoc = app_state
    api.add_middleware(MutationAdmissionMiddleware)
    entered = asyncio.Event()
    release = asyncio.Event()

    @api.post("/api/unsafe")
    async def unsafe_mutation():
        if not entered.is_set():
            entered.set()
            await release.wait()
        return {"ok": True}

    @api.post("/api/jobs")
    async def durable_job_submission():
        return {"ok": True}

    for path in (
        "/api/auth/login",
        "/api/auth/reauth",
        "/api/setup/account",
    ):
        api.add_api_route(path, lambda: {"ok": True}, methods=["POST"])

    # These paths are syntactically GETs but write session/OIDC/readiness state or
    # retain an identity-bearing live SSE subscriber in the real application.
    fenced_gets = (
        "/api/auth/sso/authorize",
        "/api/auth/sso/callback",
        "/api/health/ready",
        "/api/events",
    )
    for path in fenced_gets:
        api.add_api_route(path, lambda: {"ok": True}, methods=["GET"])

    admitted: asyncio.Task | None = None
    drain: asyncio.Task | None = None
    transport = ASGITransport(app=api)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            admitted = asyncio.create_task(client.post("/api/unsafe"))
            await asyncio.wait_for(entered.wait(), timeout=1)
            await gate.close("factory-owner")
            drain = asyncio.create_task(
                gate.wait_drained("factory-owner", timeout=2)
            )
            await asyncio.sleep(0)
            assert drain.done() is False

            blocked = await client.post("/api/unsafe")
            assert blocked.status_code == 503
            assert blocked.json()["detail"]["code"] == "factory_reset_in_progress"
            for path in fenced_gets:
                response = await client.get(path)
                assert response.status_code == 503, path

            # No handler executes while the active reset is still draining. The
            # durable Jobs CAS becomes the second authority only after this process
            # explicitly marks the partial boundary degraded for recovery.
            assert (await client.post("/api/jobs")).status_code == 503
            assert (await client.post("/api/auth/login")).status_code == 503
            await gate.mark_degraded("factory-owner")
            assert (await client.post("/api/jobs")).status_code == 200
            for path in (
                "/api/auth/login",
                "/api/auth/reauth",
                "/api/setup/account",
            ):
                assert (await client.post(path)).status_code == 200, path
            # Refresh is bound to a pre-reset session and must never recreate it.
            assert (await client.post("/api/auth/refresh")).status_code == 503
            for path in fenced_gets:
                assert (await client.get(path)).status_code == 503, path

            release.set()
            assert (await asyncio.wait_for(admitted, timeout=1)).status_code == 200
            await asyncio.wait_for(drain, timeout=1)
            await gate.open("factory-owner")
            assert (await client.post("/api/unsafe")).status_code == 200
    finally:
        release.set()
        for task in (admitted, drain):
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        if gate.owner:
            if gate.active:
                await asyncio.sleep(0)
            if not gate.active:
                await gate.open(gate.owner)


@pytest.mark.asyncio
async def test_factory_cancels_detached_mutation_tasks_before_clear(app_state) -> None:
    """Request-returned notification work cannot write after the tenant purge."""

    await _quiet(app_state)
    gate = app_state.mutation_gate
    started = asyncio.Event()
    never = asyncio.Event()

    async def detached_writer() -> None:
        started.set()
        await never.wait()

    task = app_state.spawn_mutation_task(
        detached_writer(), name="adversarial-detached-writer"
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    await gate.close("factory-owner")
    try:
        assert await app_state.cancel_mutation_tasks() == 1
        assert task.cancelled()
        rejected = detached_writer()
        with pytest.raises(RuntimeError, match="factory reset mutation fence"):
            app_state.spawn_mutation_task(rejected)
        assert app_state._mutation_tasks == set()  # noqa: SLF001 - boundary evidence
    finally:
        await gate.open("factory-owner")


@pytest.mark.asyncio
async def test_closed_factory_job_reads_never_touch_or_register_sessions(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The diagnostic Jobs GET allowlist cannot become a session-store writer."""

    await _quiet(app_state)
    await _enable_user(app_state)
    token = app_state.auth.authenticate("alice", "Correct-horse-123!")
    assert token
    claims = app_state.auth.claims_of(token)
    assert isinstance(claims, dict)
    await app_state.sessions.create(
        sid=str(claims["sid"]),
        username="alice",
        token_version=int(claims["tv"]),
    )
    calls = {"touch": 0, "create": 0}

    async def forbidden_touch(*_args, **_kwargs):
        calls["touch"] += 1

    original_create = app_state.sessions.create

    async def counted_create(*args, **kwargs):
        calls["create"] += 1
        return await original_create(*args, **kwargs)

    monkeypatch.setattr(app_state.sessions, "touch", forbidden_touch)
    monkeypatch.setattr(app_state.sessions, "create", counted_create)
    await app_state.mutation_gate.close("factory-owner")
    try:
        principal = await require_auth(
            _request(app_state, token, method="GET")
        )
        assert principal is not None and principal.username == "alice"
        assert calls == {"touch": 0, "create": 0}

        # A second valid JWT with an unknown sid must likewise not lazily persist a
        # session while the factory boundary is closed.
        unknown = app_state.auth.authenticate("alice", "Correct-horse-123!")
        assert unknown
        try:
            await require_auth(_request(app_state, unknown, method="GET"))
        except HTTPException:
            pass
        assert calls == {"touch": 0, "create": 0}
    finally:
        await app_state.mutation_gate.open("factory-owner")


@pytest.mark.asyncio
async def test_restart_rehydrates_degraded_gate_from_durable_factory_fence(
    app_state,
) -> None:
    """A crash during factory clear must not reboot ordinary HTTP admission open."""

    await _quiet(app_state)
    factory, _, _ = await app_state.jobs.create(
        _job(
            kind=JobKind.TIERED_RESET,
            actor="admin",
            generation="factory-generation",
            key="restart-factory-boundary",
            params={"scope": "factory", "confirm": "FACTORY RESET"},
            item_states={"reset": "pending"},
            permissions=[("users", "manage")],
        )
    )
    claimed = await app_state.jobs.claim_next(
        "factory-worker", lease_millis=30_000
    )
    assert claimed is not None
    running, token = claimed
    await app_state.jobs.begin_factory_fence(running.job_id, token)
    await app_state.jobs.finish(
        running.job_id,
        token,
        JobStatus.FAILED,
        job_error="injected partial privacy boundary",
    )

    # Model the local process state lost on crash while preserving the exact durable
    # Jobs registry, then invoke the startup recovery seam used before producers start.
    from app.engine.mutation_gate import MutationAdmissionGate

    app_state.mutation_gate = MutationAdmissionGate()
    assert app_state.mutation_gate.closed is False
    recover = getattr(app_state, "recover_factory_mutation_gate", None)
    assert callable(recover), "startup must expose durable factory-fence recovery"
    recovered = await recover()
    assert recovered == factory.job_id
    assert app_state.mutation_gate.owner == factory.job_id
    assert app_state.mutation_gate.degraded is True


@pytest.mark.asyncio
async def test_sql_factory_reset_clears_every_tenant_table_and_unknown_kv(
    tmp_path,
) -> None:
    """The SQLite factory boundary must prove every storage family is empty."""

    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.config import Secrets
    from app.constants import ResetScope
    from app.engine.reset import reset_service
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider
    from app.state import AppState
    from app.stores.sql.models import AuditRow, CaseRow, RagChunkRow, UsageRow
    from app.tools.vectorstore import StoredChunk

    database = tmp_path / "durable-jobs-factory-boundary.sqlite3"
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        state_backend="sqlite",
        state_db_url=f"sqlite+aiosqlite:///{database}",
    )
    provider = MockProvider()
    state = AppState.create(
        secrets=secrets,
        es=InMemoryESClient(),
        provider_overrides={
            "anthropic": provider,
            "openai": provider,
            "mock": provider,
        },
    )
    await state.startup(start_poller=False)
    await _quiet(state)
    try:
        factory, _, _ = await state.jobs.create(
            _job(
                kind=JobKind.TIERED_RESET,
                actor="pre-reset-admin",
                generation="pre-reset-generation",
                key="sqlite-factory-boundary",
                params={"scope": "factory", "confirm": "FACTORY RESET"},
                item_states={"reset": "pending"},
                permissions=[("users", "manage")],
            )
        )
        claimed = await state.jobs.claim_next(
            "sqlite-factory-worker", lease_millis=30_000
        )
        assert claimed is not None
        running, token = claimed
        assert running.job_id == factory.job_id
        await state.jobs.begin_factory_fence(running.job_id, token)
        await state.real_batch_job_store.begin_factory_fence(running.job_id)

        # Seed every non-KV SQL storage family directly. The rows need only be
        # structurally valid because reset must delete them without interpreting
        # historical tenant payloads.
        sessions = async_sessionmaker(state.sql_engine, expire_on_commit=False)
        async with sessions() as session:
            session.add_all(
                [
                    CaseRow(
                        case_id="case-pre-reset-private",
                        cluster_signature="private-signature",
                        status="open",
                        source_surface="alerts",
                        entity_value="private@example.test",
                        created_at="2026-08-13T00:00:00+00:00",
                        updated_at="2026-08-13T00:00:00+00:00",
                        doc={"case_id": "case-pre-reset-private"},
                    ),
                    AuditRow(
                        ts="2026-08-13T00:00:00+00:00",
                        case_id="case-pre-reset-private",
                        action_type="status",
                        doc={"actor": "pre-reset-private-actor"},
                    ),
                    UsageRow(
                        ts="2026-08-13T00:00:00+00:00",
                        case_id="case-pre-reset-private",
                        surface="chat",
                        role="investigator",
                        model="private-model",
                        cost=9.99,
                        total_tokens=123,
                        doc={"private": "usage-payload"},
                    ),
                ]
            )
            await session.commit()
        await state.rag._store.add(  # noqa: SLF001 - persistent-store boundary evidence
            [
                StoredChunk(
                    text="pre-reset private knowledge",
                    source="operator",
                    metadata={"document_id": "private-rag-document"},
                    embedding=[1.0],
                    embedding_model="test-embedding",
                    dim=1,
                    doc_id="private-rag-chunk",
                )
            ]
        )
        await state.kv.put(
            "unknown_future_store", "private-row", {"secret": "must disappear"}
        )
        await state.kv.put(
            "case_seq:private-tenant", "next", {"value": 42}
        )
        await state.kv.put(
            "oidc_state:private-browser", "nonce", {"value": "private-nonce"}
        )
        await state.kv.put(
            "usage_idempotency", "private-claim", {"value": "private-usage"}
        )
        updater = {"operation": "immutable-updater-authority"}
        await state.kv.put(
            "system_update_operations", "preserved", updater
        )

        result = await reset_service(
            state, ResetScope.FACTORY, factory_owner=running.job_id
        )
        assert result["privacy_boundary_confirmed"] is True, result
        assert result["failed"] == []

        async with state.sql_engine.connect() as connection:
            counts = {
                "cases": int(
                    await connection.scalar(select(func.count()).select_from(CaseRow))
                    or 0
                ),
                "audit": int(
                    await connection.scalar(select(func.count()).select_from(AuditRow))
                    or 0
                ),
                "usage": int(
                    await connection.scalar(select(func.count()).select_from(UsageRow))
                    or 0
                ),
                "rag": int(
                    await connection.scalar(select(func.count()).select_from(RagChunkRow))
                    or 0
                ),
            }
        assert counts == {"cases": 0, "audit": 0, "usage": 0, "rag": 0}
        for namespace, key in (
            ("unknown_future_store", "private-row"),
            ("case_seq:private-tenant", "next"),
            ("oidc_state:private-browser", "nonce"),
            ("usage_idempotency", "private-claim"),
        ):
            assert await state.kv.get(namespace, key) is None
        assert (
            await state.kv.get("system_update_operations", "preserved")
            == updater
        )
        assert await state.jobs.factory_fence_owner() == running.job_id
    finally:
        await state.shutdown()


@pytest.mark.asyncio
async def test_inflight_batch_mutation_cannot_resurrect_after_factory_clear(
    app_state, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Batch reset epoch must reject a pre-reset mutator after fence release."""

    await _quiet(app_state)
    import app.stores.batch_jobs as batch_store_module

    original_mutate = batch_store_module.kv_mutate_strict
    entered_batch_cas = asyncio.Event()
    release_batch_cas = asyncio.Event()
    stale_task: asyncio.Task | None = None

    async def stalled_mutate(kv, namespace, key, mutator, *, lock):
        if (
            asyncio.current_task() is stale_task
            and (namespace, key) == (BATCH_JOBS_NS, BATCH_JOBS_KEY)
        ):
            entered_batch_cas.set()
            await release_batch_cas.wait()
        return await original_mutate(kv, namespace, key, mutator, lock=lock)

    monkeypatch.setattr(batch_store_module, "kv_mutate_strict", stalled_mutate)
    stale_task = asyncio.create_task(
        app_state.real_batch_job_store.create_if_absent(
            _batch_job("batch-cross-document-race")
        )
    )
    task_error: RuntimeError | None = None
    resurrected = False
    try:
        await asyncio.wait_for(entered_batch_cas.wait(), timeout=1)
        epoch = await app_state.real_batch_job_store.begin_factory_fence(
            "factory-job"
        )
        assert epoch >= 1
        await app_state.real_batch_job_store.clear_all_strict(
            factory_owner="factory-job"
        )
        await app_state.real_batch_job_store.release_factory_fence("factory-job")
        # The global factory fence can now be gone: the Batch document's retained
        # epoch must still invalidate the mutator admitted before the reset.
        release_batch_cas.set()
        try:
            await asyncio.wait_for(stale_task, timeout=1)
        except RuntimeError as exc:
            task_error = exc
        persisted = await app_state.kv.get_strict(BATCH_JOBS_NS, BATCH_JOBS_KEY)
        resurrected = bool((persisted or {}).get("jobs"))
        assert int((persisted or {}).get("reset_epoch", 0)) > epoch
    finally:
        release_batch_cas.set()
        if stale_task is not None and not stale_task.done():
            stale_task.cancel()
            await asyncio.gather(stale_task, return_exceptions=True)

    assert task_error is not None and "factory reset changed" in str(task_error)
    assert resurrected is False
