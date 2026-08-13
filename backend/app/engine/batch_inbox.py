"""Permission-scoped durable Inbox projection for existing LLM Batch work.

The provider Batch registry remains authoritative.  This module adds a bounded,
generation-bound outbox to *new* Batch rows and materialises one stable personal
Inbox note for each eligible operator.  It never broadcasts provider handles,
custom ids, case ids, candidate payloads, or raw provider errors.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ..constants import (
    CUSTOM_ROLES_KEY,
    CUSTOM_ROLES_NS,
    USERS_KEY,
    USERS_NS,
    BatchJobState,
    JobStatus,
)
from ..models import (
    BatchInboxAudience,
    BatchJob,
    CustomRole,
    InAppNotification,
    JobProgress,
    JobResult,
    User,
)
from ..rbac.policy import can_for_roles, resolve_matrix
from .jobs import account_generation

MAX_BATCH_INBOX_AUDIENCE = 200


def batch_inbox_job_id(batch_id: str) -> str:
    digest = hashlib.sha256(str(batch_id).encode("utf-8")).hexdigest()[:32]
    return f"llm-batch-{digest}"


def _custom_roles(user: User) -> list[str]:
    return [
        str(value).strip()
        for value in ((user.prefs or {}).get("custom_roles") or [])
        if str(value).strip()
    ]


async def eligible_batch_audience(state: Any) -> list[BatchInboxAudience]:
    """Strict snapshot of active, generation-bound ``models:read`` recipients.

    Store outages/malformed documents raise.  The caller persists ``pending`` and
    retries later rather than guessing recipients or blocking provider submission.
    """
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return [BatchInboxAudience(username="default", account_generation="no-auth")]

    getter = getattr(state.kv, "get_strict", None) or state.kv.get
    users_doc = await getter(USERS_NS, USERS_KEY)
    roles_doc = await getter(CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY)
    if users_doc is not None and not isinstance(users_doc, dict):
        raise ValueError("invalid user registry")
    if roles_doc is not None and not isinstance(roles_doc, dict):
        raise ValueError("invalid custom-role registry")
    raw_users = (users_doc or {}).get("entries", [])
    raw_roles = ((roles_doc or {}).get("roles", {}) or {}).get("default", [])
    if not isinstance(raw_users, list) or not isinstance(raw_roles, list):
        raise ValueError("invalid authorization registry")
    users = [User.model_validate(row) for row in raw_users]
    stored_roles = [CustomRole.model_validate(row) for row in raw_roles]

    rbac = getattr(getattr(state, "prefs", None), "rbac", None)
    existing = list(getattr(rbac, "custom_roles", []) or [])
    seen = {
        str((row.get("name") if isinstance(row, dict) else "") or "").lower()
        for row in existing
    }
    merged = list(existing)
    for role in stored_roles:
        if role.name.lower() not in seen:
            merged.append(role.model_dump(mode="json"))
    matrix = resolve_matrix(rbac.model_copy(update={"custom_roles": merged}))

    eligible: dict[str, BatchInboxAudience] = {}
    for user in users:
        if not user.active:
            continue
        allowed = not bool(getattr(rbac, "enabled", False)) or can_for_roles(
            user.role,
            _custom_roles(user),
            "models",
            "read",
            matrix=matrix,
        )
        if allowed:
            eligible[user.username.strip().lower()] = BatchInboxAudience(
                username=user.username,
                account_generation=account_generation(user.username, user.created_at),
            )

    # The environment admin is a real authenticated principal even when it has no
    # persisted User row. A persisted same-name account wins with its own generation.
    env_admin = str(getattr(state.secrets, "auth_admin_username", "") or "").strip()
    if env_admin and env_admin.lower() not in eligible and not any(
        user.username.strip().lower() == env_admin.lower() for user in users
    ):
        eligible[env_admin.lower()] = BatchInboxAudience(
            username=env_admin,
            account_generation="env-admin",
        )
    return [eligible[key] for key in sorted(eligible)]


async def prepare_batch_inbox_audience(state: Any, job: BatchJob) -> BatchJob:
    """Attach the admission snapshot without making Batch submission depend on it."""
    job.inbox_audience_state = "pending"
    try:
        audience = await eligible_batch_audience(state)
    except Exception:
        return job
    job.inbox_audience = audience[:MAX_BATCH_INBOX_AUDIENCE]
    job.inbox_audience_truncated = max(0, len(audience) - len(job.inbox_audience))
    job.inbox_audience_state = "ready"
    return job


def _counts(job: BatchJob) -> tuple[int, int, int]:
    tracked = {
        key: value for key, value in (job.custom_ids or {}).items() if key != "__meta__"
    }
    total = max(int(job.summary_total or 0), len(tracked), len(job.requests or []))
    done = max(
        int(job.summary_retrieved or 0),
        sum(1 for value in tracked.values() if isinstance(value, dict) and value.get("retrieved")),
    )
    failed = max(
        int(job.summary_failed or 0),
        sum(
            1
            for value in tracked.values()
            if isinstance(value, dict)
            and value.get("retrieved")
            and str(value.get("result_state") or "succeeded") != "succeeded"
        ),
    )
    if job.state in {BatchJobState.ERRORED, BatchJobState.EXPIRED}:
        failed = max(failed, total - done)
        done = total
    return total, min(done, total), min(failed, total)


def _status(job: BatchJob, total: int, done: int, failed: int) -> JobStatus:
    if job.state in {BatchJobState.SUBMITTED, BatchJobState.POLLING, BatchJobState.RETRIEVING}:
        return JobStatus.RUNNING
    if job.state in {BatchJobState.ERRORED, BatchJobState.EXPIRED}:
        return JobStatus.FAILED
    if failed and done - failed > 0:
        return JobStatus.PARTIAL
    if failed:
        return JobStatus.FAILED
    return JobStatus.SUCCEEDED if job.state == BatchJobState.RETRIEVED else JobStatus.RUNNING


def _safe_token(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def batch_inbox_notification(job: BatchJob, member: BatchInboxAudience) -> InAppNotification:
    total, done, failed = _counts(job)
    status = _status(job, total, done, failed)
    succeeded = max(0, done - failed)
    terminal = status not in {JobStatus.QUEUED, JobStatus.RUNNING}
    provider = _safe_token(job.provider, 60) or "provider"
    model = _safe_token(job.model, 120) or "model"
    body = (
        f"{succeeded} succeeded · {failed} failed · {total} total"
        if terminal
        else f"{done} of {total} results processed"
    )
    return InAppNotification(
        recipient=member.username,
        category="system",
        title=f"LLM Batch · {provider} · {model}",
        body=body,
        severity="error" if status == JobStatus.FAILED else None,
        url="#/analytics?tab=jobs",
        ref={"kind": "llm_batch"},
        job_id=batch_inbox_job_id(job.id),
        job_status=status,
        progress=JobProgress(done=done, total=total, unit="requests"),
        result=(
            JobResult(
                kind="llm_batch",
                counts={
                    "succeeded": succeeded,
                    "failed": failed,
                    "total": total,
                },
            )
            if terminal
            else None
        ),
        audience_generation=member.account_generation,
    )


def projection_signature(note: InAppNotification) -> str:
    payload = note.model_dump(
        mode="json",
        include={"title", "body", "severity", "url", "job_status", "progress", "result"},
    )
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


async def reconcile_batch_inbox(state: Any, job: BatchJob) -> None:
    """Materialise/revoke the stable note; all failures remain retryable in the outbox."""
    if job.inbox_audience_state == "legacy":
        return
    if job.inbox_audience_state == "pending":
        try:
            audience = await eligible_batch_audience(state)
        except Exception:
            return
        updated = await state.real_batch_job_store.set_inbox_audience(
            job.id,
            audience[:MAX_BATCH_INBOX_AUDIENCE],
            truncated=max(0, len(audience) - MAX_BATCH_INBOX_AUDIENCE),
        )
        if updated is None:
            return
        job = updated
    try:
        live = {
            member.username.strip().lower(): member
            for member in await eligible_batch_audience(state)
        }
    except Exception:
        return

    for member in list(job.inbox_audience):
        current = live.get(member.username.strip().lower())
        exact = current is not None and (
            current.account_generation == member.account_generation
        )
        if not exact:
            try:
                await state.real_inbox.remove_job_projection_strict(
                    member.username,
                    batch_inbox_job_id(job.id),
                    audience_generation=member.account_generation,
                )
                await state.real_batch_job_store.mark_inbox_projection(
                    job.id,
                    member.username,
                    member.account_generation,
                    state="revoked",
                )
            except Exception:
                return
            continue
        note = batch_inbox_notification(job, member)
        signature = projection_signature(note)
        if member.state == "projected" and member.projection_signature == signature:
            continue
        try:
            await state.real_inbox.upsert_job_strict(note)
            await state.real_batch_job_store.mark_inbox_projection(
                job.id,
                member.username,
                member.account_generation,
                state="projected",
                signature=signature,
            )
        except Exception:
            return
        try:
            state.event_bus.publish(
                "inbox",
                "inapp",
                {"kind": "llm_batch", "job_id": note.job_id},
                audience=[member.username],
                retain=False,
            )
        except Exception:
            pass


async def batch_note_visible(state: Any, username: str, note: InAppNotification) -> bool:
    """Fail-closed GET/SSE backstop for a persisted Batch Inbox note."""
    if note.ref.get("kind") != "llm_batch":
        return True
    if not note.audience_generation:
        return False
    try:
        live = {
            member.username.strip().lower(): member
            for member in await eligible_batch_audience(state)
        }
    except Exception:
        return False
    current = live.get(username.strip().lower() or "default")
    return current is not None and current.account_generation == note.audience_generation


async def _application_job_generation(state: Any, username: str) -> str | None:
    """Resolve one live ``inapp:read`` identity from strict authorization state."""
    auth = getattr(state, "auth", None)
    needle = username.strip().lower() or "default"
    if auth is None or not auth.is_enabled:
        return "no-auth" if needle == "default" else None

    getter = getattr(state.kv, "get_strict", None) or state.kv.get
    users_doc = await getter(USERS_NS, USERS_KEY)
    roles_doc = await getter(CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY)
    if users_doc is not None and not isinstance(users_doc, dict):
        raise ValueError("invalid user registry")
    if roles_doc is not None and not isinstance(roles_doc, dict):
        raise ValueError("invalid custom-role registry")
    raw_users = (users_doc or {}).get("entries", [])
    raw_roles = ((roles_doc or {}).get("roles", {}) or {}).get("default", [])
    if not isinstance(raw_users, list) or not isinstance(raw_roles, list):
        raise ValueError("invalid authorization registry")
    users = [User.model_validate(row) for row in raw_users]
    stored_roles = [CustomRole.model_validate(row) for row in raw_roles]
    user = next(
        (
            candidate
            for candidate in users
            if candidate.username.strip().lower() == needle
        ),
        None,
    )
    if user is None:
        env_admin = str(
            getattr(state.secrets, "auth_admin_username", "") or ""
        ).strip()
        return "env-admin" if env_admin.lower() == needle else None
    if not user.active:
        return None

    rbac = getattr(getattr(state, "prefs", None), "rbac", None)
    if bool(getattr(rbac, "enabled", False)):
        existing = list(getattr(rbac, "custom_roles", []) or [])
        seen = {
            str(
                (row.get("name") if isinstance(row, dict) else "") or ""
            ).lower()
            for row in existing
        }
        merged = list(existing)
        for role in stored_roles:
            if role.name.lower() not in seen:
                merged.append(role.model_dump(mode="json"))
        matrix = resolve_matrix(rbac.model_copy(update={"custom_roles": merged}))
        if not can_for_roles(
            user.role,
            _custom_roles(user),
            "inapp",
            "read",
            matrix=matrix,
        ):
            return None
    return account_generation(user.username, user.created_at)


async def filter_visible_batch_notes(
    state: Any, username: str, notes: list[InAppNotification]
) -> list[InAppNotification]:
    """Live permission/generation backstop for every durable Job projection."""
    protected = [note for note in notes if note.job_id]
    if not protected:
        return notes
    try:
        application_generation = await _application_job_generation(state, username)
    except Exception:
        application_generation = None
    try:
        live = {
            member.username.strip().lower(): member
            for member in await eligible_batch_audience(state)
        }
    except Exception:
        live = {}
    current = live.get(username.strip().lower() or "default")
    return [
        note
        for note in notes
        if not note.job_id
        or (
            note.ref.get("kind") == "llm_batch"
            and current is not None
            and bool(note.audience_generation)
            and current.account_generation == note.audience_generation
        )
        or (
            note.ref.get("kind") != "llm_batch"
            and application_generation is not None
            and note.audience_generation == application_generation
        )
    ]


def public_inbox_item(note: InAppNotification) -> dict[str, Any]:
    """Never expose the internal account-generation binding."""
    return note.model_dump(mode="json", exclude={"audience_generation"})
