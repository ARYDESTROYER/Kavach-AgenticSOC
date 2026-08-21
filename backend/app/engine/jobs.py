"""Durable, server-owned operator jobs and registered execution handlers.

The process-local runner is intentionally only an executor. Queue ownership,
leases, cancellation, progress, idempotency, per-item completion, and transition
audit reconciliation all live in the strict-CAS :class:`JobStore`, so a client
disconnect or process restart never turns the browser into the source of truth.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import re
import time
import uuid
import zipfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException

from ..constants import ActionType, JobKind, JobStatus, ResetScope
from ..models import InAppNotification, Job, JobArtifact, JobPermission, JobResult
from ..stores.jobs import TERMINAL_STATUSES, JobStore, public_job

logger = logging.getLogger("tlsoc.engine.jobs")

_LEASE_MILLIS = 5 * 60 * 1000
_IDLE_SECONDS = 0.5
_PROGRESS_MIN_SECONDS = 1.0
_PROGRESS_PERCENT_STEP = 5
_ARTIFACT_CHUNK = 1024 * 1024
_FILENAME_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
_ARTIFACT_ID = re.compile(r"^[0-9a-f]{32}$")


class JobCancelled(RuntimeError):
    """Cooperative cancellation observed at a durable handler boundary."""


class JobAuthorityLost(RuntimeError):
    """Live RBAC or bounded step-up authority no longer permits execution."""


def account_generation(username: str, created_at: str) -> str:
    return hashlib.sha256(
        f"{username.strip().lower()}\0{created_at}".encode("utf-8")
    ).hexdigest()


def job_url(job: Job) -> str:
    """Return only allow-listed Console hash routes."""
    kind = job.kind
    if kind in {
        JobKind.CASE_REINVESTIGATE,
        JobKind.CASE_LIFECYCLE,
        JobKind.CASE_ASSIGN,
        JobKind.CASE_TAG,
    }:
        if kind == JobKind.CASE_ASSIGN:
            return f"#/cases?assignee={quote(str(job.params.get('assignee') or '')[:80], safe='')}"
        if kind == JobKind.CASE_TAG:
            return f"#/cases?tag={quote(str(job.params.get('tag') or '')[:40], safe='')}"
        status = "active"
        if kind == JobKind.CASE_LIFECYCLE:
            status = {
                "close": "closed",
                "confirm_fp": "closed",
                "resolve": "resolved",
                "escalate": "escalated",
                "hold": "on_hold",
                "acknowledge": "investigating",
                "reopen": "open",
                "resume": "open",
                "deescalate": "open",
            }.get(str(job.params.get("action") or ""), "active")
        return f"#/cases?status={status}"
    if kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        return "#/settings?s=data_export"
    if kind in {JobKind.PRECEDENT_BOOTSTRAP, JobKind.RAG_IMPORT, JobKind.RAG_REBUILD}:
        return "#/knowledge"
    if kind == JobKind.RUNBOOK_REINDEX:
        return "#/runbooks"
    if kind == JobKind.TIERED_RESET:
        return "#/settings?s=danger"
    return "#/settings?s=storage"


def _summary(job: Job) -> str:
    result_counts = job.result.counts if job.result is not None else {}
    succeeded = int(
        result_counts.get(
            "succeeded",
            sum(1 for state in job.item_states.values() if state == "succeeded"),
        )
    )
    total = int(result_counts.get("total", job.progress.total) or 0)
    failed = int(result_counts.get("failed", job.failure_count) or 0)
    verb = {
        JobKind.CASE_REINVESTIGATE: "reinvestigated",
        JobKind.CASE_LIFECYCLE: "updated",
        JobKind.CASE_ASSIGN: "assigned",
        JobKind.CASE_TAG: "tagged",
    }.get(job.kind, "completed")
    if total:
        return f"{succeeded} of {total} {verb}" + (
            f" · {failed} failed" if failed else ""
        )
    return f"{job.kind.value.replace('_', ' ')} · {job.status.value}"


def _export_record_progress(
    scopes: list[str],
    scope: str,
    exported: int,
    snapshot_total: int,
    completed: dict[str, int],
) -> tuple[int, int]:
    """Cumulative real records + monotonic estimated total across lazy scopes.

    Each scope's exact snapshot total becomes known only when its first page opens.
    Weight scope completion evenly until then, while `done` always remains the exact
    cumulative record count. The explicit unit says the denominator is estimated;
    on the final scope it converges to the exact aggregate total.
    """

    index = scopes.index(scope)
    done = sum(max(0, int(completed.get(name, 0))) for name in scopes[:index])
    done += max(0, int(exported))
    total = max(0, int(snapshot_total))
    local_fraction = 1.0 if total == 0 else min(1.0, max(0.0, exported / total))
    fraction = (index + local_fraction) / max(1, len(scopes))
    estimated_total = (
        max(done, int(math.ceil(done / fraction)))
        if done and fraction > 0
        else max(1, len(scopes))
    )
    return done, estimated_total


class JobRunner:
    """Lease-owning worker. Multiple application workers may run one safely."""

    def __init__(self, state: Any, store: JobStore) -> None:
        self.state = state
        self.store = store
        self.owner = f"worker-{uuid.uuid4().hex}"
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self._wake = asyncio.Event()
        self._last_emit: dict[str, tuple[float, int]] = {}

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        await self.cleanup_orphan_artifacts()
        await self.reconcile_audits()
        self._task = asyncio.create_task(self._loop(), name="operator-job-runner")

    async def stop(self) -> None:
        self._running = False
        self._wake.set()
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    def notify(self) -> None:
        self._wake.set()

    async def _loop(self) -> None:
        # Give the request/runtime that just completed startup exclusive use of the
        # state backend until either a submission explicitly wakes us or the bounded
        # recovery poll elapses. This matters for SQLite ``:memory:`` where async
        # sessions intentionally share one physical connection: an eager idle read
        # transaction can otherwise interleave with and roll back the first readiness
        # sentinel. Persisted queued work still resumes after this one short interval.
        if not self._wake.is_set():
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=_IDLE_SECONDS)
            except TimeoutError:
                pass
        self._wake.clear()
        while self._running:
            try:
                # Transition audit and Inbox are durable projections. Reconcile them
                # even while the queue is idle so an outage at terminal publish is
                # repaired without requiring an unrelated future submission.
                if not await self.reconcile_audits():
                    # Audit is a pre-effect and pre-projection dependency. Do not
                    # claim new work or materialise a terminal Inbox row while its
                    # append-only transition remains unconfirmed.
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(
                            self._wake.wait(), timeout=_IDLE_SECONDS
                        )
                    except TimeoutError:
                        pass
                    continue
                await self.reconcile_inbox()
                claimed = await self.store.claim_next(
                    self.owner, lease_millis=_LEASE_MILLIS
                )
                if claimed is None:
                    self._wake.clear()
                    try:
                        await asyncio.wait_for(self._wake.wait(), timeout=_IDLE_SECONDS)
                    except TimeoutError:
                        pass
                    continue
                job, token = claimed
                # No handler effect may run before BOTH submitted and started are
                # confirmed in the append-only audit. Release the unexecuted claim on
                # outage; the durable transition remains pending for reconciliation.
                if not await self.reconcile_audits():
                    queued = await self.store.release_claim(job.job_id, token)
                    await self.publish(queued, force=True)
                    await asyncio.sleep(_IDLE_SECONDS)
                    continue
                await self.publish(job, force=True)
                await self._execute(job, token)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - isolate corrupt/unavailable row
                logger.exception("durable job worker pass failed: %s", exc)
                await asyncio.sleep(_IDLE_SECONDS)

    async def _execute(self, job: Job, token: str) -> None:
        lease_lost = asyncio.Event()
        owner_task = asyncio.current_task()
        heartbeat = asyncio.create_task(
            self._lease_heartbeat(job.job_id, token, owner_task, lease_lost),
            name=f"job-lease-{job.job_id}",
        )
        try:
            await self.checkpoint(job.job_id, token)
            handler = {
                JobKind.CASE_REINVESTIGATE: self._case_reinvestigate,
                JobKind.CASE_LIFECYCLE: self._case_lifecycle,
                JobKind.CASE_ASSIGN: self._case_assign,
                JobKind.CASE_TAG: self._case_tag,
                JobKind.DATA_EXPORT_ARCHIVE: self._export_archive,
                JobKind.DATA_EXPORT_SEGMENT: self._export_segment,
                JobKind.PRECEDENT_BOOTSTRAP: self._precedent_bootstrap,
                JobKind.RUNBOOK_REINDEX: self._runbook_reindex,
                JobKind.RAG_REBUILD: self._rag_rebuild,
                JobKind.RAG_IMPORT: self._rag_import,
                JobKind.TIERED_RESET: self._tiered_reset,
                JobKind.STORAGE_LIFECYCLE_APPLY: self._storage_apply,
            }[job.kind]
            await handler(job, token)
        except JobCancelled:
            current = await self.store.get(job.job_id)
            if current and current.status == JobStatus.RUNNING:
                await self._finish(current, token, JobStatus.CANCELLED)
        except JobAuthorityLost as exc:
            current = await self.store.get(job.job_id)
            if current and current.status == JobStatus.RUNNING:
                await self._discard_attached_artifact(current)
                await self._finish(
                    current, token, JobStatus.FAILED, error=self._reason(exc)
                )
        except asyncio.CancelledError:
            # Process shutdown intentionally leaves the lease behind. A new worker
            # recovers it after the bounded expiry and resumes safe remaining items.
            if lease_lost.is_set():
                logger.error("Job %s stopped because its durable lease was lost", job.job_id)
                return
            raise
        except Exception as exc:  # noqa: BLE001 - bounded public failure
            logger.warning("Job %s failed: %s", job.job_id, exc)
            current = await self.store.get(job.job_id)
            if (
                current
                and current.status == JobStatus.RUNNING
                and current.lease_token == token
            ):
                await self._discard_attached_artifact(current)
                await self._finish(
                    current, token, JobStatus.FAILED, error=self._reason(exc)
                )
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)

    async def _lease_heartbeat(
        self,
        job_id: str,
        token: str,
        owner_task: asyncio.Task[Any] | None,
        lease_lost: asyncio.Event,
    ) -> None:
        """Renew independently while a handler is blocked in a provider/domain call."""
        interval = min(60.0, max(10.0, _LEASE_MILLIS / 3000))
        while True:
            await asyncio.sleep(interval)
            try:
                await self.store.renew(job_id, token, lease_millis=_LEASE_MILLIS)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # ownership/storage uncertainty stops effects
                try:
                    current = await self.store.get(job_id)
                except Exception:
                    current = None
                if current is not None and current.status in TERMINAL_STATUSES:
                    return
                logger.error("Job %s lease heartbeat failed: %s", job_id, exc)
                lease_lost.set()
                if owner_task is not None:
                    owner_task.cancel()
                return

    async def checkpoint(
        self,
        job_id: str,
        token: str,
        *,
        done: int | None = None,
        total: int | None = None,
        unit: str = "items",
        emit: bool = False,
    ) -> Job:
        """Cancellation/auth/lease/progress boundary used between bounded pages."""
        current = await self.store.get(job_id)
        if (
            current is None
            or current.status != JobStatus.RUNNING
            or current.lease_token != token
        ):
            raise RuntimeError("job worker lease ownership changed")
        if current.cancel_requested:
            raise JobCancelled("job cancellation requested")
        if self.state.demo_active:
            raise JobAuthorityLost("durable jobs cannot execute while Demo Mode is active")
        if not await self._permission_alive(current):
            raise JobAuthorityLost(
                "actor is inactive or no longer holds the required permission"
            )
        if not await self._fresh_authority_alive(current):
            raise JobAuthorityLost("the bounded step-up authorization expired or was revoked")
        current = await self.store.renew(
            job_id, token, lease_millis=_LEASE_MILLIS
        )
        if done is not None and total is not None:
            current = await self.store.set_progress(
                job_id, token, done=done, total=total, unit=unit
            )
        if emit:
            await self.publish(current)
        return current

    async def _permission_alive(self, job: Job) -> bool:
        auth = getattr(self.state, "auth", None)
        if auth is None or not auth.is_enabled:
            return True
        principal = auth.principal(job.actor)
        if principal is None:
            return False
        rbac = getattr(getattr(self.state, "prefs", None), "rbac", None)
        from ..constants import CUSTOM_ROLES_KEY, CUSTOM_ROLES_NS, USERS_KEY, USERS_NS
        from ..models import CustomRole, User
        from ..rbac.policy import can_for_roles, resolve_matrix

        getter = getattr(self.state.kv, "get_strict", None) or self.state.kv.get
        try:
            users_doc = await getter(USERS_NS, USERS_KEY)
            roles_doc = await getter(CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY)
            if users_doc is not None and not isinstance(users_doc, dict):
                return False
            if roles_doc is not None and not isinstance(roles_doc, dict):
                return False
            raw_users = (users_doc or {}).get("entries", [])
            raw_roles = ((roles_doc or {}).get("roles", {}) or {}).get("default", [])
            if not isinstance(raw_users, list) or not isinstance(raw_roles, list):
                return False
            users = [User.model_validate(row) for row in raw_users]
            stored_roles = [CustomRole.model_validate(row) for row in raw_roles]
        except Exception:
            return False
        user = next(
            (u for u in users if u.username.strip().lower() == job.actor.lower()),
            None,
        )
        if user is None:
            # Environment-only admin principals are intentionally absent from
            # UserStore. Only that exact configured principal may use this branch.
            if job.actor.lower() != str(self.state.secrets.auth_admin_username).lower():
                return False
            if job.actor_generation != "env-admin":
                return False
            assigned: list[str] = []
            live_role = principal.role
        else:
            if not user.active or account_generation(user.username, user.created_at) != job.actor_generation:
                return False
            assigned = [
                str(value).strip()
                for value in ((user.prefs or {}).get("custom_roles") or [])
                if str(value).strip()
            ]
            live_role = user.role
        if not bool(getattr(rbac, "enabled", False)):
            return True
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
        return all(
            can_for_roles(
                # Strict persisted role, not the possibly stale AuthService cache.
                # (Enum values are accepted by the policy resolver.)
                live_role,
                assigned,
                grant.resource,
                grant.action,
                matrix=matrix,
            )
            for grant in job.required_permissions
        )

    async def permission_alive(self, job: Job) -> bool:
        """Public fail-closed live grant check for deferred read boundaries."""
        return await self._permission_alive(job)

    async def _fresh_authority_alive(self, job: Job) -> bool:
        if not job.fresh_authorized_until_millis:
            return True
        if int(time.time() * 1000) > job.fresh_authorized_until_millis:
            return False
        auth = getattr(self.state, "auth", None)
        if auth is None or not auth.is_enabled:
            return True
        if not job.fresh_session_id:
            return False
        sessions = getattr(self.state, "sessions", None)
        if sessions is None:
            return False
        try:
            if job.fresh_token_version is None:
                return False
            policy = getattr(self.state.prefs, "session_policy", None)
            return await sessions.strict_deferred_authority(
                sid=job.fresh_session_id,
                username=job.actor,
                token_version=job.fresh_token_version,
                idle_timeout=int(getattr(policy, "idle_timeout", 0) or 0),
                absolute_lifetime=int(
                    getattr(policy, "absolute_lifetime", 0) or 0
                ),
                sudo_window=int(
                    getattr(policy, "sudo_reauth_window", 600) or 600
                ),
            )
        except Exception:  # privileged deferred execution fails closed
            return False

    async def _item_loop(
        self,
        job: Job,
        token: str,
        run: Callable[[str], Awaitable[None]],
        *,
        result_kind: str,
    ) -> None:
        for item_ref, item_state in list(job.item_states.items()):
            if item_state in {"succeeded", "failed"}:
                continue
            await self.checkpoint(job.job_id, token)
            await self.store.begin_item(job.job_id, token, item_ref)
            try:
                await run(item_ref)
                current = await self.store.complete_item(
                    job.job_id, token, item_ref
                )
            except (JobCancelled, JobAuthorityLost, asyncio.CancelledError):
                raise
            except Exception as exc:  # noqa: BLE001 - isolate one item
                current = await self.store.complete_item(
                    job.job_id,
                    token,
                    item_ref,
                    error=self._reason(exc),
                )
            await self.publish(current)
        current = await self.checkpoint(job.job_id, token)
        succeeded = sum(
            1 for state in current.item_states.values() if state == "succeeded"
        )
        failed = sum(
            1 for state in current.item_states.values() if state == "failed"
        )
        counts = {
            "succeeded": succeeded,
            "failed": failed,
            "total": current.progress.total,
        }
        status = (
            JobStatus.PARTIAL
            if failed and succeeded
            else JobStatus.FAILED
            if failed
            else JobStatus.SUCCEEDED
        )
        await self._finish(
            current,
            token,
            status,
            result=JobResult(kind=result_kind, counts=counts),
        )

    async def _case_reinvestigate(self, job: Job, token: str) -> None:
        from ..api.routes import _override_models

        async def run(case_id: str) -> None:
            case = await self.state.real_cases.get(case_id)
            if case is None:
                raise HTTPException(status_code=404, detail="Case not found")
            cluster = await self.state.cluster_for_case(case)
            if cluster is None:
                raise HTTPException(
                    status_code=400,
                    detail="This case has no stored evidence to reinvestigate.",
                )
            query_source = self.state.poller.source_for_id(case.source_id)
            prefs = _override_models(
                self.state.prefs,
                job.params.get("model"),
                ("router", "investigator", "formatter"),
            )
            await self.state.control_audit.record(
                action_type=ActionType.DECISION,
                surface=case.source_surface.value,
                actor="reinvestigate",
                case_id=case_id,
                result_summary=f"durable job {job.job_id} requested by {job.actor}",
            )
            # The canonical pipeline retains the single gateway, budget gate, usage
            # ledger, provider retry, cost cap, and deterministic decision path.
            await self.state.real_pipeline.investigate_cluster(
                cluster,
                case.source_surface,
                prefs,
                force=True,
                query_source=query_source,
                investigation_priority="background",
            )

        await self._item_loop(job, token, run, result_kind="case_reinvestigation")

    async def _case_lifecycle(self, job: Job, token: str) -> None:
        from ..api.routes import CaseAction, _perform_case_action

        body = CaseAction.model_validate(
            {key: value for key, value in job.params.items() if key != "case_ids"}
        )

        async def run(case_id: str) -> None:
            await _perform_case_action(case_id, body, job.actor, self.state)

        await self._item_loop(job, token, run, result_kind="case_lifecycle")

    async def _case_assign(self, job: Job, token: str) -> None:
        from ..api.routes import AssignBody, case_assign

        body = AssignBody(assignee=job.params["assignee"], analyst=job.actor)

        async def run(case_id: str) -> None:
            await case_assign(case_id, body, self.state, request=None)

        await self._item_loop(job, token, run, result_kind="case_assignment")

    async def _case_tag(self, job: Job, token: str) -> None:
        from ..api.routes import TagsBody, case_tags

        tag = str(job.params["tag"])

        async def run(case_id: str) -> None:
            case = await self.state.cases.get(case_id)
            if case is None:
                raise HTTPException(status_code=404, detail="Case not found")
            await case_tags(
                case_id,
                TagsBody(tags=[*list(case.tags or []), tag], analyst=job.actor),
                self.state,
                request=None,
            )

        await self._item_loop(job, token, run, result_kind="case_tagging")

    async def _export_archive(self, job: Job, token: str) -> None:
        from ..api.routes_export import (
            _ARCHIVE_SLOT,
            _assemble_archive,
            _ensure_archive_capacity,
            _select_scopes,
            _verify_archive,
        )

        scopes = _select_scopes(list(job.params.get("scopes") or ["all"]))
        current = await self.checkpoint(job.job_id, token)
        if current.artifact is not None:
            await self._discard_attached_artifact(current)
        path, artifact_id = await self._reserve_artifact_path(job, token, ".zip")
        acquired = _ARCHIVE_SLOT.acquire(blocking=False)
        if not acquired:
            self._safe_unlink(path)
            raise RuntimeError("another export archive is already being assembled")
        stop: JobCancelled | JobAuthorityLost | None = None
        scope_progress: dict[str, tuple[int, int]] = {}

        async def disconnected() -> bool:
            nonlocal stop
            try:
                await self.checkpoint(job.job_id, token)
                return False
            except (JobCancelled, JobAuthorityLost) as exc:
                stop = exc
                return True

        async def progressed(scope: str, exported: int, total: int) -> None:
            current = await self.checkpoint(job.job_id, token)
            state = current.item_states.get(scope)
            if state == "pending":
                current = await self.store.begin_item(job.job_id, token, scope)
                state = current.item_states.get(scope)
            if total >= 0 and exported >= total and state not in {"succeeded", "failed"}:
                current = await self.store.complete_item(job.job_id, token, scope)
            scope_progress[scope] = (max(0, exported), max(exported, total))
            completed = {
                name: values[1]
                for name, values in scope_progress.items()
                if name != scope and values[0] >= values[1]
            }
            done_records, total_records = _export_record_progress(
                scopes, scope, exported, total, completed
            )
            current = await self.store.set_progress(
                job.job_id,
                token,
                done=done_records,
                total=total_records,
                unit="records (estimated total)",
            )
            await self.publish(current)

        try:
            await asyncio.to_thread(_ensure_archive_capacity, str(path), 0)
            try:
                manifest, filename = await _assemble_archive(
                    str(path),
                    scopes,
                    self.state,
                    job.actor,
                    disconnected=disconnected,
                    progressed=progressed,
                )
            except asyncio.CancelledError:
                if stop is not None:
                    raise stop
                raise
            await asyncio.to_thread(_verify_archive, str(path), scopes, manifest)
            await self.checkpoint(job.job_id, token)
            artifact = await self._artifact_meta(
                path, artifact_id, filename, "application/zip"
            )
            await self._audit_export(job, scopes, artifact.size)
            _attached, expired = await self.store.attach_artifact(
                job.job_id, token, artifact
            )
            await self.delete_artifacts(expired)
            counts = {
                f"scope_{scope}": int(meta.get("exported", 0))
                for scope, meta in dict(manifest.get("scopes") or {}).items()
            }
            counts.update(
                {
                    "bytes": artifact.size,
                    "succeeded": len(scopes),
                    "failed": 0,
                    "total": len(scopes),
                }
            )
            current = await self.checkpoint(job.job_id, token)
            await self._finish(
                current,
                token,
                JobStatus.SUCCEEDED,
                result=JobResult(
                    kind="data_export_archive",
                    artifact_id=artifact_id,
                    counts=counts,
                ),
            )
        except BaseException:
            self._safe_unlink(path)
            try:
                await self.store.clear_pending_artifact(job.job_id, token, artifact_id)
            except Exception:
                pass
            current = await self.store.get(job.job_id)
            if current is not None and current.artifact is not None:
                await self._discard_attached_artifact(current)
            raise
        finally:
            _ARCHIVE_SLOT.release()

    async def _export_segment(self, job: Job, token: str) -> None:
        from ..api.routes_export import (
            DataExportSegmentRequest,
            _ARCHIVE_SLOT,
            _close_archive_cursor,
            _ensure_archive_capacity,
            _run_blocking,
            _segment_envelope,
            _select_scopes,
        )

        scopes = _select_scopes(list(job.params.get("scopes") or ["all"]))
        page_size = int(job.params.get("page_size") or 1000)
        current = await self.checkpoint(job.job_id, token)
        if current.artifact is not None:
            await self._discard_attached_artifact(current)
        path, artifact_id = await self._reserve_artifact_path(job, token, ".zip")
        if not _ARCHIVE_SLOT.acquire(blocking=False):
            self._safe_unlink(path)
            raise RuntimeError("another export archive is already being assembled")
        counts: dict[str, int] = {}
        scope_records: dict[str, int] = {}
        archive: zipfile.ZipFile | None = None
        active_scope = ""
        cursor: str | None = None
        try:
            await asyncio.to_thread(_ensure_archive_capacity, str(path), 0)
            archive = await _run_blocking(
                zipfile.ZipFile,
                path,
                "w",
                zipfile.ZIP_DEFLATED,
                True,
            )
            for scope in scopes:
                active_scope = scope
                cursor = None
                segment = 1
                exported = 0
                seen: set[str] = set()
                current = await self.checkpoint(job.job_id, token)
                if current.item_states.get(scope) == "pending":
                    await self.store.begin_item(job.job_id, token, scope)
                while True:
                    await self.checkpoint(job.job_id, token, emit=True)
                    envelope, payload = await _segment_envelope(
                        DataExportSegmentRequest(
                            scope=scope,  # type: ignore[arg-type]
                            cursor=cursor,
                            page_size=page_size,
                        ),
                        self.state,
                        job.actor,
                    )
                    await _run_blocking(
                        archive.writestr,
                        f"{scope}-{segment:06d}.json",
                        payload,
                    )
                    meta = dict(envelope.get("segment") or {})
                    exported = int(meta.get("cumulative_count") or exported)
                    scope_records[scope] = exported
                    snapshot_total = int(meta.get("snapshot_total") or 0)
                    done_records, total_records = _export_record_progress(
                        scopes,
                        scope,
                        exported,
                        snapshot_total,
                        scope_records,
                    )
                    current = await self.store.set_progress(
                        job.job_id,
                        token,
                        done=done_records,
                        total=total_records,
                        unit="records (estimated total)",
                    )
                    await self.publish(current)
                    returned = meta.get("next_cursor")
                    cursor = str(returned) if returned else None
                    if bool(meta.get("complete")) and meta.get("status") == "complete":
                        cursor = None
                        break
                    if not cursor or cursor in seen:
                        raise RuntimeError(f"{scope} segment export made no progress")
                    seen.add(cursor)
                    segment += 1
                counts[f"scope_{scope}"] = exported
                current = await self.store.complete_item(
                    job.job_id, token, scope
                )
                completed_done = sum(scope_records.values())
                if scope == scopes[-1]:
                    current = await self.store.set_progress(
                        job.job_id,
                        token,
                        done=completed_done,
                        total=max(1, completed_done),
                        unit="records",
                    )
                await self.publish(current)
            await _run_blocking(archive.close)
            archive = None
            filename = f"agentic-soc-export-segments-{job.job_id}.zip"
            await self._verify_segment_archive(path, scopes)
            artifact = await self._artifact_meta(
                path, artifact_id, filename, "application/zip"
            )
            await self._audit_export(job, scopes, artifact.size)
            _attached, expired = await self.store.attach_artifact(
                job.job_id, token, artifact
            )
            await self.delete_artifacts(expired)
            counts.update(
                {
                    "bytes": artifact.size,
                    "succeeded": len(scopes),
                    "failed": 0,
                    "total": len(scopes),
                }
            )
            current = await self.checkpoint(job.job_id, token)
            await self._finish(
                current,
                token,
                JobStatus.SUCCEEDED,
                result=JobResult(
                    kind="data_export_segment",
                    artifact_id=artifact_id,
                    counts=counts,
                ),
            )
        except BaseException:
            self._safe_unlink(path)
            try:
                await self.store.clear_pending_artifact(job.job_id, token, artifact_id)
            except Exception:
                pass
            current = await self.store.get(job.job_id)
            if current is not None and current.artifact is not None:
                await self._discard_attached_artifact(current)
            raise
        finally:
            if cursor and active_scope:
                await _close_archive_cursor(
                    active_scope, cursor, self.state, job.actor
                )
            if archive is not None:
                try:
                    await _run_blocking(archive.close)
                except Exception:  # preserve primary error
                    pass
            _ARCHIVE_SLOT.release()

    async def _audit_export(self, job: Job, scopes: list[str], size: int) -> None:
        await self.state.control_audit.record_strict(
            action_type=ActionType.DATA_EXPORT,
            event_id=f"job:{job.job_id}:data-export",
            surface="settings",
            actor=job.actor,
            result_summary=(
                f"assembled durable export scopes={','.join(scopes)} bytes={size} "
                f"job={job.job_id} delivery=pending"
            ),
        )

    async def _precedent_bootstrap(self, job: Job, token: str) -> None:
        from ..api.routes_rag import (
            _PRECEDENT_BOOTSTRAP_MAX,
            PrecedentBootstrapRequest,
            _precedent_preview,
            is_precedent_projected,
            perform_precedent_candidate,
            perform_precedent_bootstrap,
        )
        from ..tools.rag import is_bulk_ratified

        await self.checkpoint(job.job_id, token)
        body = PrecedentBootstrapRequest.model_validate(
            {
                **job.params,
                "batch_id": job.params.get("batch_id") or job.job_id[:64],
            }
        )
        if body.dry_run:
            await self.store.begin_item(job.job_id, token, "bootstrap")
            result = await perform_precedent_bootstrap(body, self.state, job.actor)
            current = await self.store.complete_item(job.job_id, token, "bootstrap")
            selected = int(result.get("selected") or 0)
            await self._finish(
                current,
                token,
                JobStatus.SUCCEEDED,
                result=JobResult(
                    kind="precedent_bootstrap",
                    counts={
                        "eligible": int(result.get("eligible") or 0),
                        "selected": selected,
                        "ratified": 0,
                        "indexed": 0,
                        "already_ratified": int(
                            result.get("already_ratified") or 0
                        ),
                        "remaining": int(result.get("remaining") or 0),
                        "succeeded": selected,
                        "failed": 0,
                        "total": selected,
                    },
                ),
            )
            return

        preview = _precedent_preview(self.state)
        if not preview["tier_enabled"]:
            raise HTTPException(
                status_code=409,
                detail=(
                    "the lower-trust precedent tier is disabled; enable the "
                    "resolved and unconfirmed precedent settings first"
                ),
            )
        batch_id = body.batch_id
        # ``limit`` is the operator-authorized TOTAL mutation cap, never a page size.
        # Ratified-but-unacknowledged projections are admitted first so a later job
        # repairs an index outage without appending a second ratification marker.
        candidates = await self.state.rag.unconfirmed_precedent_candidates(
            _PRECEDENT_BOOTSTRAP_MAX * 2
        )
        current = await self.store.get(job.job_id)
        if current is None:
            return
        by_id = {case.case_id: (case, item) for case, item in candidates}
        selected_ids = [
            ref
            for ref, state in current.item_states.items()
            if state in {"pending", "processing"} and ref in by_id
        ]
        eligible = [
            case.case_id
            for case, _item in candidates
            if (not is_bulk_ratified(case) or not is_precedent_projected(case))
            and case.case_id not in selected_ids
        ]
        selected_ids = (selected_ids + eligible)[: int(body.limit)]
        current = await self.store.ensure_items(
            job.job_id, token, selected_ids, unit="cases"
        )
        for case_id in selected_ids:
            if current.item_states.get(case_id) in {"succeeded", "failed"}:
                continue
            await self.checkpoint(job.job_id, token)
            await self.store.begin_item(job.job_id, token, case_id)
            case, item = by_id[case_id]
            try:
                await perform_precedent_candidate(
                    case,
                    item,
                    self.state,
                    actor=job.actor,
                    batch_id=batch_id,
                )
                current = await self.store.complete_item(job.job_id, token, case_id)
            except Exception as exc:  # one candidate never aborts the bounded batch
                current = await self.store.complete_item(
                    job.job_id, token, case_id, error=self._reason(exc)
                )
            await self.publish(current)

        current = await self.checkpoint(job.job_id, token)
        candidates = await self.state.rag.unconfirmed_precedent_candidates(
            _PRECEDENT_BOOTSTRAP_MAX * 2
        )
        remaining = sum(
            1
            for case, _ in candidates
            if not is_bulk_ratified(case) or not is_precedent_projected(case)
        )
        ratified = sum(
            1 for state in current.item_states.values() if state == "succeeded"
        )
        failed = current.failure_count
        counts = {
            "eligible": len(candidates),
            "selected": len(current.item_states),
            "ratified": ratified,
            "indexed": ratified,
            "already_ratified": sum(
                1 for case, _ in candidates if is_bulk_ratified(case)
            ),
            "remaining": remaining,
            "succeeded": ratified,
            "failed": failed,
            "total": len(current.item_states),
        }
        status = JobStatus.PARTIAL if failed and counts["succeeded"] else (
            JobStatus.FAILED if failed else JobStatus.SUCCEEDED
        )
        await self._finish(
            current,
            token,
            status,
            result=JobResult(kind="precedent_bootstrap", counts=counts),
        )

    async def _runbook_reindex(self, job: Job, token: str) -> None:
        await self.checkpoint(job.job_id, token)
        await self.store.begin_item(job.job_id, token, "reindex")
        runbook_id = job.params.get("runbook_id")
        result = await self.state.rag.reindex_runbooks(
            {str(runbook_id)} if runbook_id else None
        )
        current = await self.store.complete_item(job.job_id, token, "reindex")
        counts = {
            "indexed": int(result.get("indexed", 0) or 0),
            "failed": int(result.get("failed", 0) or 0),
        }
        counts["total"] = counts["indexed"] + counts["failed"]
        counts["succeeded"] = counts["indexed"]
        status = JobStatus.PARTIAL if counts["failed"] and counts["indexed"] else (
            JobStatus.FAILED if counts["failed"] else JobStatus.SUCCEEDED
        )
        await self._finish(
            current,
            token,
            status,
            result=JobResult(kind="runbook_reindex", counts=counts),
        )

    async def _rag_rebuild(self, job: Job, token: str) -> None:
        """Rebuild the whole knowledge projection — the documented recovery action.

        Idempotent and safe on a healthy deployment: it reuses the staged-then-verified
        seeding path, so it either converges on the same corpus or refuses and leaves
        the existing one intact. A REFUSED rebuild is reported as FAILED rather than
        succeeded-with-zero, so "the corpus is still broken" can never read as done.
        """
        await self.checkpoint(job.job_id, token)
        await self.store.begin_item(job.job_id, token, "rebuild")
        result = await self.state.rag.rebuild_corpus()
        refused = bool(result.get("refused"))
        # Carry the REFUSAL REASON onto the job. A rebuild that failed with an empty
        # failure list tells the operator only "it did not work" — which is the exact
        # silence this whole change exists to remove. The reason is our own message
        # text, never provider or document content (#9).
        reason = str(result.get("refusal_reason") or "").strip()
        current = await self.store.complete_item(
            job.job_id,
            token,
            "rebuild",
            error=(reason or "the knowledge projection was refused") if refused else None,
        )
        counts = {
            "chunks_before": int(result.get("chunks_before", 0) or 0),
            "chunks_after": int(result.get("chunks_after", 0) or 0),
            "total": 1,
            "succeeded": 0 if refused else 1,
            "failed": 1 if refused else 0,
        }
        await self._finish(
            current,
            token,
            JobStatus.FAILED if refused else JobStatus.SUCCEEDED,
            result=JobResult(kind="rag_rebuild", counts=counts),
        )

    async def _rag_import(self, job: Job, token: str) -> None:
        documents = list(job.params.get("documents") or [])

        async def run(item_ref: str) -> None:
            document = dict(documents[int(item_ref)])
            result = await self.state.rag.import_document(
                document["title"],
                document["text"],
                source=document.get("source") or "imported",
                tags=list(document.get("tags") or []),
            )
            if not result.get("chunk_count"):
                raise ValueError("document produced no indexable chunks")

        await self._item_loop(job, token, run, result_kind="rag_import")

    async def _tiered_reset(self, job: Job, token: str) -> None:
        from ..build_identity import current_record_provenance
        from .reset import reset_service

        current = await self.checkpoint(job.job_id, token)
        if current.item_states.get("reset") == "failed":
            await self._finish(
                current,
                token,
                JobStatus.FAILED,
                result=JobResult(
                    kind="tiered_reset",
                    counts={"attempted": 1, "cleared": 0, "succeeded": 0, "failed": 1, "total": 1},
                ),
            )
            return
        scope = ResetScope(job.params["scope"])
        await self.state.control_audit.record_strict(
            action_type=ActionType.RESET,
            event_id=f"job:{job.job_id}:reset-intent",
            surface="admin",
            actor=job.actor,
            result_summary=f"reset scope={scope.value} confirm=ok job={job.job_id}",
        )
        await self.store.begin_item(job.job_id, token, "reset")
        runtime_snapshot: dict[str, bool] | None = None
        factory_destructive = False
        if scope == ResetScope.FACTORY:
            prior_artifacts: list[JobArtifact] = []
            jobs_fenced = False
            batch_fenced = False
            local_fenced = False
            try:
                # Close process-local mutation admission first so a failure while
                # acquiring either durable document can never leave HTTP writers
                # open beside a stranded cross-process fence.
                await self.state.mutation_gate.close(job.job_id)
                local_fenced = True
                _current, prior_artifacts = await self.store.begin_factory_fence(
                    job.job_id, token
                )
                jobs_fenced = True
                await self.state.real_batch_job_store.begin_factory_fence(job.job_id)
                batch_fenced = True
                # Existing SSE responses hold the HTTP admission context for their
                # lifetime. Wake/drop them before waiting for the request counter;
                # this is process-runtime quiescence, not a tenant data mutation, and
                # new subscribers are already rejected by the closed gate.
                self.state.event_bus.clear()
                # Nothing destructive happens until all already-admitted request
                # handlers and other durable Job effects have left their boundaries.
                await self.state.mutation_gate.wait_drained(job.job_id, timeout=30.0)
                runtime_snapshot = await self._pause_factory_runtime()
                deadline = asyncio.get_running_loop().time() + 30.0
                while not await self.store.factory_quiescent(job.job_id, token):
                    if asyncio.get_running_loop().time() >= deadline:
                        raise RuntimeError(
                            "factory reset aborted because another job did not quiesce"
                        )
                    await asyncio.sleep(0.1)
            except BaseException:
                # No tenant bytes have been cleared yet: release every fence and
                # restore local producers. Later failures remain degraded instead.
                cleanup_failed = False
                if batch_fenced:
                    try:
                        await self.state.real_batch_job_store.release_factory_fence(job.job_id)
                    except Exception:
                        cleanup_failed = True
                if jobs_fenced:
                    try:
                        await self.store.release_factory_fence(job.job_id)
                    except Exception:
                        cleanup_failed = True
                if local_fenced:
                    if cleanup_failed:
                        await self.state.mutation_gate.mark_degraded(job.job_id)
                    else:
                        await self.state.mutation_gate.open(job.job_id)
                if not cleanup_failed:
                    await self._resume_factory_runtime(runtime_snapshot)
                raise
            factory_destructive = True
            try:
                await self.delete_artifacts(prior_artifacts)
                await self.state.cancel_mutation_tasks()
                # Tear down the simulator before clearing the real EventBus: while
                # demo is active the public bus property points at its throwaway bus.
                await self.state.disable_demo()
                self.state.event_bus.clear()
                self.state.notifications.reset_runtime_state()
            except BaseException:
                await self.state.mutation_gate.mark_degraded(job.job_id)
                raise
        elif scope == ResetScope.SOURCES:
            # Source reset keeps environment-provided entries but drops live additions.
            boot = self.state._boot_runtime_secrets.get("connector_secrets", {})
            self.state.secrets.connector_secrets = dict(boot)
        try:
            result = await reset_service(
                self.state,
                scope,
                factory_owner=(job.job_id if scope == ResetScope.FACTORY else None),
            )
            if scope == ResetScope.FACTORY:
                restored = self.state.restore_environment_runtime_secrets()
                result["attempted"].append("runtime_secret_overlays")
                result["cleared"].append(
                    f"runtime_secret_overlays:{sum(restored.values())}"
                )
        except BaseException:
            # A post-fence reset failure may be partially destructive. Leave both
            # durable fences and local producers stopped: this is an intentional
            # fail-closed safe-stop, not a state from which old work may resume.
            if scope == ResetScope.FACTORY and factory_destructive:
                await self.state.mutation_gate.mark_degraded(job.job_id)
            raise
        # Factory reset intentionally removes the initiating user/session. Do not
        # reinterpret that expected self-revocation as a failed completed reset.
        current = await self.store.complete_item(job.job_id, token, "reset")
        attempted = len(list(result.get("attempted") or []))
        cleared = len(list(result.get("cleared") or []))
        failed = len(list(result.get("failed") or []))
        result_model = JobResult(
            kind="tiered_reset",
            counts={
                "attempted": attempted,
                "cleared": cleared,
                "succeeded": max(0, attempted - failed),
                "failed": failed,
                "total": attempted,
            },
        )
        status = (
            JobStatus.PARTIAL
            if failed and cleared
            else JobStatus.FAILED
            if failed
            else JobStatus.SUCCEEDED
        )
        if scope == ResetScope.FACTORY:
            if not bool(result.get("privacy_boundary_confirmed")):
                await self._finish(
                    current,
                    token,
                    JobStatus.FAILED,
                    result=result_model,
                    error="factory reset privacy boundary was not fully confirmed",
                )
                await self.state.mutation_gate.mark_degraded(job.job_id)
                return
            try:
                build = current_record_provenance()
                receipt, artifacts = await self.store.factory_compact(
                    job.job_id,
                    token,
                    status=status,
                    result=result_model,
                    app_version=build["app_version"],
                    build_sha=build["build_sha"],
                )
                await self.delete_artifacts(artifacts)
                # Reservations from pre-reset workers are no longer reachable;
                # quiescence makes an immediate opaque-root sweep safe.
                await self._purge_artifact_root()
                self.state.cache.set_tenant_epoch(receipt.job_id)
                self.state.notifications.reset_runtime_state()
                self.state.event_bus.clear()
                # The new audit ledger begins with exactly this sanitized action and
                # the actorless receipt transition. Never re-audit pre-reset rows.
                await self.state.control_audit.record_strict(
                    action_type=ActionType.RESET,
                    event_id=f"job:{job.job_id}:factory-receipt",
                    surface="admin",
                    actor="system",
                    result_summary=(
                        f"factory reset receipt status={status.value} "
                        f"attempted={attempted} cleared={cleared} failed={failed}"
                    ),
                )
                if not await self.reconcile_audits():
                    raise RuntimeError(
                        "factory reset receipt transition audit was not confirmed"
                    )
                # Cross-document/local admission opens only after every privacy and
                # append-only receipt proof above has succeeded.
                await self.state.real_batch_job_store.release_factory_fence(job.job_id)
                await self.store.release_factory_fence(job.job_id)
                await self.state.mutation_gate.open(job.job_id)
                if runtime_snapshot and runtime_snapshot.get("update_audit"):
                    # Updater history/control is explicitly preserved and is not a
                    # tenant producer. Restore only its reconciler after success;
                    # poller/receivers/schedulers wait for the new OOBE tenant.
                    await self.state._start_system_update_audit_reconciler()
            except BaseException:
                # This includes audit outage after compaction. The sanitized receipt
                # remains the durable owner, and a fresh factory retry may transfer it.
                await self.state.mutation_gate.mark_degraded(job.job_id)
                raise
            return
        await self._finish(current, token, status, result=result_model)

    async def _pause_factory_runtime(self) -> dict[str, bool]:
        """Quiesce every local producer that can repopulate state during factory reset."""
        poller = getattr(self.state, "poller", None)
        snapshot = {
            "poller": bool(getattr(poller, "_task", None)),
            "schedulers": bool(getattr(self.state, "_scheduler_running", False)),
            "receivers": bool(getattr(self.state, "_receivers_enabled", False)),
            "update_audit": bool(getattr(self.state, "_update_audit_running", False)),
        }
        await self.state._stop_schedulers()
        if poller is not None:
            await poller.stop()
        self.state._receivers_enabled = False
        await self.state._stop_receivers()
        await self.state._stop_system_update_audit_reconciler()
        return snapshot

    async def _resume_factory_runtime(
        self, snapshot: dict[str, bool] | None
    ) -> None:
        """Restore local producers only when a fenced reset aborts pre-boundary."""
        if not snapshot:
            return
        if snapshot.get("poller"):
            self.state.poller.start()
        if snapshot.get("receivers"):
            self.state._receivers_enabled = True
            await self.state._start_receivers()
        if snapshot.get("schedulers"):
            await self.state._run_schedulers()
        if snapshot.get("update_audit"):
            await self.state._start_system_update_audit_reconciler()

    async def _storage_apply(self, job: Job, token: str) -> None:
        from ..api.routes_storage import _backend, _status
        from .storage_lifecycle import apply_elasticsearch_lifecycle

        current = await self.checkpoint(job.job_id, token)
        if current.item_states.get("apply") == "failed":
            await self._finish(
                current,
                token,
                JobStatus.FAILED,
                result=JobResult(
                    kind="storage_lifecycle_apply",
                    counts={"applied": 0, "targets": 0, "succeeded": 0, "failed": 1, "total": 1},
                ),
            )
            return
        if self.state.prefs.read_only_settings_mode:
            raise RuntimeError("settings are read-only")
        await self.state.control_audit.record_strict(
            action_type=ActionType.STATUS,
            event_id=f"job:{job.job_id}:storage-intent",
            surface="storage",
            actor=job.actor,
            result_summary=f"requested own-state lifecycle apply job={job.job_id}",
        )
        await self.store.begin_item(job.job_id, token, "apply")
        current_policy = self.state.prefs.storage_lifecycle.model_dump(mode="json")
        if dict(job.params.get("policy") or {}) != current_policy:
            raise RuntimeError(
                "saved storage lifecycle policy changed after job submission; apply aborted"
            )
        if _backend(self.state) != "elasticsearch":
            execution = {
                "applied": False,
                "managed_targets": [],
                "state": "advisory",
            }
        else:
            from ..config import StorageLifecycleConfig

            policy = StorageLifecycleConfig.model_validate(job.params["policy"])
            execution = await apply_elasticsearch_lifecycle(
                self.state.es, policy
            )
        await _status(self.state)
        current = await self.store.complete_item(job.job_id, token, "apply")
        targets = list(execution.get("managed_targets") or [])
        await self.state.control_audit.record_strict(
            action_type=ActionType.STATUS,
            event_id=f"job:{job.job_id}:storage-result",
            surface="storage",
            actor=job.actor,
            result_summary=(
                f"own-state lifecycle apply state={execution.get('state')} "
                f"targets={','.join(targets) or 'none'} job={job.job_id}"
            )[:1000],
        )
        current = await self.checkpoint(job.job_id, token)
        await self._finish(
            current,
            token,
            JobStatus.SUCCEEDED,
            result=JobResult(
                kind="storage_lifecycle_apply",
                counts={
                    "applied": int(bool(execution.get("applied"))),
                    "targets": len(targets),
                    "succeeded": 1,
                    "failed": 0,
                    "total": 1,
                },
            ),
        )

    async def _finish(
        self,
        job: Job,
        token: str,
        status: JobStatus,
        *,
        result: JobResult | None = None,
        error: str | None = None,
    ) -> None:
        finished = await self.store.finish(
            job.job_id, token, status, result=result, job_error=error
        )
        # Terminal state is authoritative in JobStore immediately, but completion
        # is not visible in Inbox/SSE until its append-only transition is confirmed.
        # The idle loop repairs both projections after an audit outage recovers.
        if await self.reconcile_audits():
            await self.publish(finished, force=True)

    async def publish(self, job: Job, *, force: bool = False) -> None:
        if job.status in TERMINAL_STATUSES or job.cancel_requested:
            authoritative = await self.store.get(job.job_id)
            if authoritative is None or any(
                not transition.audited
                for transition in authoritative.transitions
            ):
                return
            job = authoritative
        # A username is mutable; an account generation is not. Re-resolve the exact
        # active generation and the Inbox read grant before every durable projection
        # so delete+recreate cannot inherit an in-flight predecessor's note or SSE.
        projection_job = job.model_copy(
            update={
                "required_permissions": [
                    JobPermission(resource="inapp", action="read")
                ]
            }
        )
        if not await self._permission_alive(projection_job):
            if job.retired and job.status in TERMINAL_STATUSES:
                artifacts = await self.store.purge_retired_terminal(job.job_id)
                await self.delete_artifacts(artifacts)
            else:
                try:
                    await self.state.real_inbox.remove_job_projection_strict(
                        job.actor,
                        job.job_id,
                        audience_generation=(
                            job.actor_generation
                            if getattr(self.state.auth, "is_enabled", False)
                            else "no-auth"
                        ),
                    )
                except Exception as exc:
                    logger.warning("Stale Job Inbox projection removal failed: %s", exc)
                    return
                await self.store.set_inbox_synced(job.job_id, True)
            return
        projection = public_job(job)
        now = asyncio.get_running_loop().time()
        last_at, last_pct = self._last_emit.get(job.job_id, (0.0, -1))
        pct = (
            int(job.progress.done * 100 / job.progress.total)
            if job.progress.total
            else 0
        )
        terminal = job.status in TERMINAL_STATUSES
        should_emit = force or terminal or (
            now - last_at >= _PROGRESS_MIN_SECONDS
            and (last_pct < 0 or pct - last_pct >= _PROGRESS_PERCENT_STEP)
        )
        note = InAppNotification(
            recipient=job.actor,
            category="system",
            title=f"Background job · {job.kind.value.replace('_', ' ')}",
            body=_summary(job),
            severity="error" if job.status == JobStatus.FAILED else None,
            url=job_url(job),
            ref={"job_id": job.job_id},
            job_id=job.job_id,
            job_status=job.status,
            progress=job.progress,
            result=job.result,
            audience_generation=(
                job.actor_generation
                if getattr(self.state.auth, "is_enabled", False)
                else "no-auth"
            ),
        )
        if should_emit:
            await self.store.set_inbox_synced(job.job_id, False)
            try:
                await self.state.real_inbox.upsert_job_strict(note)
            except Exception as exc:
                logger.warning("Job Inbox projection failed: %s", exc)
                return
            # Close the authorization-check/use race. A delete+same-name recreate
            # can occur while the strict Inbox CAS is blocked; re-resolve the exact
            # generation after it lands, remove only the stale-generation row, and
            # suppress live SSE before any synchronous fan-out.
            if not await self._permission_alive(projection_job):
                try:
                    await self.state.real_inbox.remove_job_projection_strict(
                        job.actor,
                        job.job_id,
                        audience_generation=note.audience_generation,
                    )
                except Exception as exc:
                    logger.warning("Stale Job Inbox projection removal failed: %s", exc)
                    return
                await self.store.set_inbox_synced(job.job_id, True)
                if job.retired and job.status in TERMINAL_STATUSES:
                    artifacts = await self.store.purge_retired_terminal(job.job_id)
                    await self.delete_artifacts(artifacts)
                return
            from ..realtime import get_event_bus

            # EventBus.publish is synchronous. Keep it immediately adjacent to the
            # final live-generation check above: an account delete/recreate cannot
            # interleave on this event loop between that check and the fan-out. The
            # durable Inbox row already carries the immutable generation as a second
            # line of defence. Marking the outbox synced happens afterwards; if that
            # write fails, a later reconciliation may repeat a harmless live event
            # rather than risk delivering predecessor data to a replacement account.
            get_event_bus().publish(
                "jobs",
                "job",
                projection.model_dump(mode="json"),
                audience=[job.actor] if job.actor else None,
                # The bus audience is a mutable username. Do not retain Jobs in its
                # replay ring or a deleted/recreated account could replay an old
                # generation's payload. Durable polling/Inbox remain authoritative.
                retain=False,
            )
            await self.store.set_inbox_synced(job.job_id, True)
            self._last_emit[job.job_id] = (now, pct)

    async def reconcile_inbox(self) -> bool:
        """Idempotently rematerialize any strict Inbox projection lost to outage."""
        ok = True
        for job in await self.store.unsynced_jobs():
            try:
                await self.publish(job, force=True)
            except Exception as exc:  # remains unsynced for the next idle pass
                logger.warning("Job Inbox reconcile failed: %s", exc)
                ok = False
                break
        return ok

    async def reconcile_audits(self) -> bool:
        """Confirm every transition append, returning False on first outage."""
        for job, transition in await self.store.unaudited_transitions():
            try:
                await self.state.control_audit.record_strict(
                    action_type=ActionType.JOB,
                    event_id=f"job:{job.job_id}:transition:{transition.seq}",
                    ts=transition.at,
                    surface="jobs",
                    actor=job.actor,
                    result_summary=(
                        f"job={job.job_id} kind={job.kind.value} "
                        f"transition={transition.name} {transition.summary}"
                    )[:1000],
                )
            except Exception as exc:  # durable transition remains pending
                logger.warning("Job transition audit reconcile failed: %s", exc)
                return False
            await self.store.mark_transition_audited(job.job_id, transition.seq)
        return True

    def _artifact_root(self) -> Path:
        configured = Path(self.state.secrets.jobs_artifact_dir).expanduser()
        root = configured.resolve()
        try:
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
        except PermissionError:
            if str(configured) != "/var/lib/agentic-soc/jobs":
                raise RuntimeError(
                    f"jobs artifact root is not writable: {configured}"
                ) from None
            # The image creates /var/lib/... for uid 10001. A source checkout does
            # not; use the repository's ignored persistent data directory instead.
            root = (Path.cwd() / "data" / "jobs").resolve()
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            logger.info("Using local durable Jobs artifact root %s", root)
        os.chmod(root, 0o700)
        return root

    async def _reserve_artifact_path(
        self, job: Job, token: str, suffix: str
    ) -> tuple[Path, str]:
        _reserved, artifact_id = await self.store.reserve_artifact(
            job.job_id, token, suffix=suffix
        )
        root = self._artifact_root()
        path = root / f"{artifact_id}{suffix}"
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        return path, artifact_id

    def artifact_path(self, artifact_id: str, filename: str) -> Path:
        if not _ARTIFACT_ID.fullmatch(artifact_id or ""):
            raise FileNotFoundError("artifact id is invalid")
        suffix = Path(filename).suffix.lower()
        if suffix not in {".zip"}:
            raise FileNotFoundError("artifact type is invalid")
        root = self._artifact_root()
        candidate = root / f"{artifact_id}{suffix}"
        if candidate.is_symlink() or candidate.resolve(strict=False).parent != root:
            raise FileNotFoundError("artifact path is invalid")
        return candidate

    async def verify_artifact(self, artifact: JobArtifact) -> Path:
        path = self.artifact_path(artifact.artifact_id, artifact.filename)

        def verify() -> None:
            if not path.is_file() or path.is_symlink():
                raise FileNotFoundError(path)
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as handle:
                while chunk := handle.read(_ARTIFACT_CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
            if size != artifact.size or digest.hexdigest() != artifact.sha256:
                raise ValueError("artifact integrity check failed")

        await asyncio.to_thread(verify)
        return path

    async def _artifact_meta(
        self,
        path: Path,
        artifact_id: str,
        filename: str,
        content_type: str,
    ) -> JobArtifact:
        def calculate() -> tuple[int, str]:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as handle:
                while chunk := handle.read(_ARTIFACT_CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
            return size, digest.hexdigest()

        size, digest = await asyncio.to_thread(calculate)
        safe = _FILENAME_SAFE.sub("-", Path(filename).name).strip(".-") or "artifact.zip"
        return JobArtifact(
            artifact_id=artifact_id,
            filename=safe,
            content_type=content_type,
            size=size,
            sha256=digest,
        )

    async def _verify_segment_archive(self, path: Path, scopes: list[str]) -> None:
        """Reject corrupt/empty/unexpected resumable-export ZIPs before delivery."""

        def verify() -> None:
            with zipfile.ZipFile(path, "r") as archive:
                corrupt = archive.testzip()
                if corrupt:
                    raise ValueError(f"corrupt archive member: {corrupt}")
                names = archive.namelist()
                if not names:
                    raise ValueError("export archive is empty")
                for name in names:
                    if Path(name).name != name or not any(
                        name.startswith(f"{scope}-") and name.endswith(".json")
                        for scope in scopes
                    ):
                        raise ValueError("export archive contains an unexpected member")
                    info = archive.getinfo(name)
                    if info.file_size <= 0:
                        raise ValueError("export archive contains an empty member")

        await asyncio.to_thread(verify)

    async def delete_artifacts(self, artifacts: list[JobArtifact]) -> None:
        for artifact in artifacts:
            try:
                path = self.artifact_path(artifact.artifact_id, artifact.filename)
                await asyncio.to_thread(self._safe_unlink, path)
            except FileNotFoundError:
                continue

    async def cleanup_orphan_artifacts(self) -> None:
        referenced = await self.store.protected_artifact_ids()
        root = self._artifact_root()

        def cleanup() -> None:
            for path in root.iterdir():
                if path.is_symlink() or not path.is_file():
                    continue
                if path.suffix != ".zip" or not _ARTIFACT_ID.fullmatch(path.stem):
                    continue
                # Durable reservations protect every in-flight replica. A genuinely
                # abandoned file is removed only after two full lease windows so a
                # just-created file cannot race a remote claim/attach commit.
                if (
                    path.stem not in referenced
                    and time.time() - path.stat().st_mtime > 2 * (_LEASE_MILLIS / 1000)
                ):
                    self._safe_unlink(path)

        await asyncio.to_thread(cleanup)

    async def _purge_artifact_root(self) -> None:
        root = self._artifact_root()

        def purge() -> None:
            for path in root.iterdir():
                if (
                    path.is_file()
                    and not path.is_symlink()
                    and path.suffix == ".zip"
                    and _ARTIFACT_ID.fullmatch(path.stem)
                ):
                    self._safe_unlink(path)

        await asyncio.to_thread(purge)

    async def _discard_attached_artifact(self, job: Job) -> None:
        if job.artifact is None:
            return
        await self.delete_artifacts([job.artifact])
        await self.store.expire_artifact(job.job_id, job.artifact.artifact_id)

    @staticmethod
    def _safe_unlink(path: Path) -> None:
        try:
            if not path.is_symlink():
                path.unlink()
        except FileNotFoundError:
            pass

    @staticmethod
    def _reason(exc: BaseException) -> str:
        if isinstance(exc, HTTPException):
            return str(exc.detail)[:500]
        if isinstance(exc, (ValueError, RuntimeError)):
            return str(exc)[:500]
        return "internal error"
