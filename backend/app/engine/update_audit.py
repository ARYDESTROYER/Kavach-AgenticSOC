"""Durable, replay-safe audit projection for updater terminal outcomes.

Round 14 (SPEC §4.5.3) keeps the terminal row exactly as earlier builds write it. The
row has a deterministic event id and every build replays the supervisor's terminal
history into it (the status page, the job read and the background reconciler), while
the ledger compares a replay's whole payload with the first append. A build that added
fields to this row would collide with the row an earlier build wrote for the same
transition after an upgrade, and the earlier build would collide with this one's after
a rollback; either way the status page and the reconciler would stop. So the row keeps
its pre-Round-14 shape: the audit log names it "System update" from its
``(system_update, *)`` type, reads ``update_supervisor`` as a system actor and states
the status in its summary. The helpers below name the release or the update job as the
target of the operator's own update rows (``app.api.routes_updates``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable

from ..constants import ActionType
from ..models import AuditTarget
from .update_supervisor import UpdateJob

if TYPE_CHECKING:
    from ..stores.base import AuditRepository


TERMINAL_JOB_STATUSES = frozenset(
    {"succeeded", "failed", "rolled_back", "cancelled"}
)


async def audit_terminal_job(audit: "AuditRepository", job: UpdateJob) -> bool:
    """Mirror one terminal supervisor state into append-only application audit.

    The supervisor preserves the immutable installation receipt when a later
    rollback transaction changes the job's current status. Reconstruct both
    transitions from those receipts before falling back to the current state so
    a fast rollback cannot erase the successful-install evidence merely because
    no browser or background poll observed it first.

    The deterministic event id makes browser polling, process restart replay, and
    the background reconciler converge on one immutable row per job transition.
    Supervisor error messages and host/runtime details are deliberately excluded.
    """
    if job.status not in TERMINAL_JOB_STATUSES:
        return False

    transitions: list[tuple[str, str]] = []
    seen: set[str] = set()
    fallback_timestamp = (
        job.updated_at or job.started_at or "1970-01-01T00:00:00Z"
    )
    for receipt in (job.receipt, job.rollback_receipt):
        if receipt is None or receipt.status not in TERMINAL_JOB_STATUSES:
            continue
        if receipt.job_id != job.job_id or receipt.release_id != job.release_id:
            raise RuntimeError(
                "system-update receipt identity does not match its durable job"
            )
        if receipt.status in seen:
            continue
        transitions.append(
            (receipt.status, receipt.completed_at or fallback_timestamp)
        )
        seen.add(receipt.status)

    if job.status not in seen:
        transitions.append((job.status, fallback_timestamp))

    for status, timestamp in transitions:
        # Byte-identical to the row earlier builds write (module doc): no Round 14
        # fields, so a replay by any build confirms the first append.
        await audit.record_strict(
            action_type=ActionType.SYSTEM_UPDATE,
            event_id=f"system-update:terminal:{job.job_id}:{status}"[:512],
            ts=timestamp,
            surface="system_updates",
            actor="update_supervisor",
            result_summary=(
                f"terminal job_id={job.job_id} release_id={job.release_id} "
                f"status={status}"
            )[:500],
        )
    return True


def update_job_target(job_id: str, release_id: str | None = None) -> AuditTarget:
    """The ``job`` target of an update row: the supervisor job, labelled with the
    release it installs when known."""
    release = str(release_id or "").strip()
    return AuditTarget(
        type="job", id=str(job_id) or "update",
        label=f"Update to {release}" if release else "System update",
    )


def release_target(release_id: str) -> AuditTarget:
    """The target of a preflight or start row: the release, as a system setting (the
    installed version is what the operator asks to change)."""
    return AuditTarget(type="setting", id=f"release:{release_id}", label=f"Release {release_id}")


async def audit_terminal_jobs(
    audit: "AuditRepository", jobs: Iterable[UpdateJob]
) -> int:
    """Replay terminal jobs oldest-first; strict persistence fails closed."""
    ordered = sorted(
        jobs,
        key=lambda job: job.updated_at or job.started_at or "",
    )
    mirrored = 0
    for job in ordered:
        if await audit_terminal_job(audit, job):
            mirrored += 1
    return mirrored
