"""Authenticated durable operator Jobs API.

Submission validates one explicit registered kind, stores an actor-scoped raw-key
hash plus request fingerprint, and returns immediately. Execution is wholly owned by
the server runner; list/detail/cancel/artifact remain self-scoped.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..constants import CaseStatus, JobKind, ResetScope
from ..engine.jobs import account_generation
from ..engine.replay.params import ReplayExperimentParams
from ..models import (
    Job,
    JobListResponse,
    JobPermission,
    JobProgress,
    JobPublic,
    JobTransition,
    RelatedBatchJobPublic,
    RelatedJobsPublic,
    SchedulerHealthPublic,
)
from ..state import AppState
from ..stores.jobs import JobCapacityError, JobConflict, idempotency_hash, public_job
from ..utils import iso_now
from .deps import (
    _enforce,
    current_username,
    get_state,
    has_permission,
    require_permission,
)

router = APIRouter(prefix="/api", tags=["jobs"])

_SENSITIVE_KEYS = {
    "password", "password_hash", "secret", "token", "authorization", "cookie",
    "api_key", "access_key", "private_key", "credential", "credentials",
}
_FRESH_KINDS = {
    JobKind.DATA_EXPORT_ARCHIVE,
    JobKind.DATA_EXPORT_SEGMENT,
    JobKind.TIERED_RESET,
    JobKind.STORAGE_LIFECYCLE_APPLY,
}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _CaseIds(_Strict):
    case_ids: list[str] = Field(min_length=1, max_length=5000)

    @field_validator("case_ids")
    @classmethod
    def _canonical_case_ids(cls, value: list[str]) -> list[str]:
        normalized = [str(item).strip() for item in value]
        if any(not item or len(item) > 200 for item in normalized):
            raise ValueError("case_ids must contain non-empty identifiers up to 200 characters")
        # The logical intent is a set. Canonical ordering/dedup makes reordered or
        # repeated client retries bind the same fingerprint, progress, and item map.
        return sorted(set(normalized))


class CaseReinvestigateParams(_CaseIds):
    model: str | None = Field(default=None, max_length=200)


class CaseLifecycleParams(_CaseIds):
    action: Literal[
        "close", "reopen", "escalate", "confirm_fp", "acknowledge", "hold",
        "resume", "resolve", "set_disposition", "deescalate", "set_status",
    ]
    note: str = Field(default="", max_length=4000)
    reason: str = Field(default="", max_length=1000)
    resolution: str | None = Field(default=None, max_length=4000)
    disposition: str | None = Field(default=None, max_length=80)
    status: CaseStatus | None = None

    @model_validator(mode="after")
    def _targets(self) -> "CaseLifecycleParams":
        if self.action == "set_status" and self.status is None:
            raise ValueError("set_status requires status")
        if self.action == "set_disposition" and not self.disposition:
            raise ValueError("set_disposition requires disposition")
        return self


class CaseAssignParams(_CaseIds):
    assignee: str = Field(max_length=80)

    @field_validator("assignee")
    @classmethod
    def _assignee(cls, value: str) -> str:
        clean = value.strip()
        if not clean or any(ord(char) < 32 for char in clean):
            raise ValueError("assignee must be non-empty plain text")
        return clean


class CaseTagParams(_CaseIds):
    tag: str = Field(min_length=1, max_length=40)

    @field_validator("tag")
    @classmethod
    def _tag(cls, value: str) -> str:
        clean = value.strip()
        if not clean or any(ord(char) < 32 for char in clean):
            raise ValueError("tag must be non-empty plain text")
        return clean


class ExportArchiveParams(_Strict):
    scopes: list[Literal[
        "all", "cases", "audit", "usage", "configuration", "automation", "knowledge"
    ]] = Field(default_factory=lambda: ["all"], min_length=1, max_length=7)


class ExportSegmentParams(ExportArchiveParams):
    page_size: int = Field(default=1000, ge=1, le=5000)


class PrecedentParams(_Strict):
    acknowledgement: str
    limit: int = Field(default=200, ge=1, le=1000)
    batch_id: str = Field(default="", max_length=64)
    dry_run: bool = False


class RunbookParams(_Strict):
    runbook_id: str | None = Field(default=None, max_length=160)


class RagDocument(_Strict):
    title: str = Field(min_length=1, max_length=512)
    text: str = Field(min_length=1, max_length=1_000_000)
    source: str = Field(default="imported", max_length=160)
    tags: list[str] = Field(default_factory=list, max_length=25)

    @field_validator("title", "source")
    @classmethod
    def _plain_metadata(cls, value: str) -> str:
        clean = value.strip()
        if not clean or any(ord(char) < 32 for char in clean):
            raise ValueError("document metadata must be non-empty plain text")
        return clean

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str]) -> list[str]:
        tags = [str(tag).strip() for tag in value]
        if any(not tag or len(tag) > 80 or any(ord(char) < 32 for char in tag) for tag in tags):
            raise ValueError("tags must be non-empty plain text up to 80 characters")
        return sorted(set(tags))


class RagImportParams(_Strict):
    documents: list[RagDocument] = Field(min_length=1, max_length=20)


class RagRebuildParams(_Strict):
    """No parameters: the rebuild always reconciles the WHOLE enabled projection.

    Deliberately empty rather than offering a per-source selector. The failure this
    action exists to recover from is "the corpus is gone / partial and nothing will
    bring it back"; asking an operator to first work out WHICH sources are missing
    would reintroduce the diagnosis step that took three days.
    """


class ResetParams(_Strict):
    scope: ResetScope
    confirm: str


class StoragePolicy(_Strict):
    enabled: bool = True
    hot_days: int = Field(ge=1, le=3650)
    warm_days: int = Field(ge=1, le=3650)
    archive_target: Literal["aws_glacier"] = "aws_glacier"
    glacier_storage_class: Literal["GLACIER", "DEEP_ARCHIVE"] = "GLACIER"
    delete_after_archive: Literal[False] = False


class StorageParams(_Strict):
    acknowledge: Literal[True]
    policy: StoragePolicy


_PARAM_MODELS: dict[JobKind, type[BaseModel]] = {
    JobKind.CASE_REINVESTIGATE: CaseReinvestigateParams,
    JobKind.CASE_LIFECYCLE: CaseLifecycleParams,
    JobKind.CASE_ASSIGN: CaseAssignParams,
    JobKind.CASE_TAG: CaseTagParams,
    JobKind.DATA_EXPORT_ARCHIVE: ExportArchiveParams,
    JobKind.DATA_EXPORT_SEGMENT: ExportSegmentParams,
    JobKind.PRECEDENT_BOOTSTRAP: PrecedentParams,
    JobKind.RUNBOOK_REINDEX: RunbookParams,
    JobKind.RAG_IMPORT: RagImportParams,
    JobKind.RAG_REBUILD: RagRebuildParams,
    JobKind.TIERED_RESET: ResetParams,
    JobKind.STORAGE_LIFECYCLE_APPLY: StorageParams,
    JobKind.REPLAY_EXPERIMENT: ReplayExperimentParams,
}


class JobSubmit(_Strict):
    kind: JobKind
    idempotency_key: str = Field(min_length=8, max_length=200)
    params: dict[str, Any]


def _contains_sensitive(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            if normalized in _SENSITIVE_KEYS or normalized.endswith(
                ("_secret", "_token", "_password", "_api_key")
            ):
                return True
            if _contains_sensitive(item):
                return True
    elif isinstance(value, list):
        return any(_contains_sensitive(item) for item in value)
    return False


def _fingerprint(kind: JobKind, params: dict[str, Any]) -> str:
    raw = json.dumps(
        {"kind": kind.value, "params": params},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _items(kind: JobKind, params: dict[str, Any]) -> tuple[dict[str, str], str]:
    if "case_ids" in params:
        return {case_id: "pending" for case_id in params["case_ids"]}, "cases"
    if kind == JobKind.RAG_IMPORT:
        return {str(i): "pending" for i in range(len(params["documents"]))}, "documents"
    if kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        from .routes_export import _select_scopes

        scopes = _select_scopes(list(params.get("scopes") or ["all"]))
        params["scopes"] = scopes
        return {scope: "pending" for scope in scopes}, "scopes"
    if kind == JobKind.PRECEDENT_BOOTSTRAP:
        return ({"bootstrap": "pending"} if params.get("dry_run") else {}), "cases"
    if kind == JobKind.RAG_REBUILD:
        return {"rebuild": "pending"}, "items"
    if kind == JobKind.REPLAY_EXPERIMENT:
        return (
            {fixture_id: "pending" for fixture_id in params["fixture_ids"]},
            "replay fixtures",
        )
    key = "reindex" if kind == JobKind.RUNBOOK_REINDEX else (
        "reset" if kind == JobKind.TIERED_RESET else "apply"
    )
    return {key: "pending"}, "items"


def _grants(kind: JobKind, params: dict[str, Any]) -> list[tuple[str, str]]:
    if kind == JobKind.CASE_REINVESTIGATE:
        return [("cases", "reinvestigate")]
    if kind == JobKind.CASE_ASSIGN:
        return [("cases", "assign")]
    if kind == JobKind.CASE_TAG:
        return [("cases", "write")]
    if kind == JobKind.CASE_LIFECYCLE:
        from .routes import CaseAction, _grant_for_body

        action = CaseAction.model_validate(
            {key: value for key, value in params.items() if key != "case_ids"}
        )
        return [("cases", _grant_for_body(action))]
    if kind in {JobKind.DATA_EXPORT_ARCHIVE, JobKind.DATA_EXPORT_SEGMENT}:
        return [("data_export", "export")]
    if kind == JobKind.PRECEDENT_BOOTSTRAP:
        return [("rag", "manage"), ("cases", "write")]
    if kind == JobKind.RUNBOOK_REINDEX:
        return [("runbooks", "manage")]
    if kind in {JobKind.RAG_IMPORT, JobKind.RAG_REBUILD}:
        return [("rag", "manage")]
    if kind == JobKind.TIERED_RESET:
        return [("users", "manage")]
    if kind == JobKind.REPLAY_EXPERIMENT:
        # Overriding per-role model configuration and spending real provider money IS
        # the models grant; the fixtures are case-derived alert evidence and the report
        # enumerates per-case outcomes, hence cases:read alongside it.
        return [("models", "manage"), ("cases", "read")]
    return [("settings", "manage")]


async def _fresh_fields(
    request: Request, state: AppState, kind: JobKind
) -> tuple[int, str | None, int | None]:
    if kind not in _FRESH_KINDS or not state.auth.is_enabled:
        return 0, None, None
    authorization = request.headers.get("authorization", "")
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    token = request.cookies.get("tlsoc_token") or bearer
    claims = state.auth.claims_of(token) if token else None
    sid = str((claims or {}).get("sid", "") or "")
    try:
        tv = int((claims or {}).get("tv", -1))
    except (TypeError, ValueError):
        tv = -1
    if not sid or tv < 0:
        raise HTTPException(401, detail={"code": "reauth_required"})
    policy = state.prefs.session_policy
    try:
        expires_at = await state.sessions.strict_deferred_authority_expires_at(
            sid=sid,
            username=current_username(request),
            token_version=tv,
            idle_timeout=int(policy.idle_timeout or 0),
            absolute_lifetime=int(policy.absolute_lifetime or 0),
            sudo_window=int(policy.sudo_reauth_window or 600),
        )
    except Exception as exc:
        raise HTTPException(503, detail="session authority registry unavailable") from exc
    if expires_at is None:
        raise HTTPException(
            401,
            detail={
                "code": "reauth_required",
                "reason": "stale_or_revoked_authority",
                "window": int(policy.sudo_reauth_window or 600),
            },
        )
    return expires_at, sid, tv


@router.post("/jobs", status_code=202, response_model=JobPublic)
async def submit_job(
    body: JobSubmit,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobPublic:
    if state.demo_active:
        raise HTTPException(409, detail="durable jobs are unavailable in Demo Mode")
    if _contains_sensitive(body.params):
        raise HTTPException(422, detail="job parameters contain a secret-like key")
    try:
        model = _PARAM_MODELS[body.kind].model_validate(body.params)
    except Exception as exc:
        raise HTTPException(422, detail=f"invalid {body.kind.value} parameters: {exc}") from exc
    params = model.model_dump(mode="json", exclude_none=True)
    canonical_size = len(
        json.dumps(
            params,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    if canonical_size > 8 * 1024 * 1024:
        raise HTTPException(413, detail="job parameters exceed the 8 MiB active payload limit")
    if body.kind == JobKind.PRECEDENT_BOOTSTRAP:
        from ..tools.rag import PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT

        if params["acknowledgement"] != PRECEDENT_RATIFICATION_ACKNOWLEDGEMENT:
            raise HTTPException(400, detail="explicit precedent acknowledgement is required")
    if body.kind == JobKind.TIERED_RESET:
        expected = {
            "cases": "RESET CASES", "sources": "RESET SOURCES", "factory": "FACTORY RESET"
        }[params["scope"]]
        if params["confirm"] != expected:
            raise HTTPException(400, detail=f"confirmation phrase must be exactly '{expected}'")
    if body.kind == JobKind.STORAGE_LIFECYCLE_APPLY:
        saved = state.prefs.storage_lifecycle.model_dump(mode="json")
        if params["policy"] != saved:
            raise HTTPException(409, detail="policy must match the currently saved lifecycle policy")
    grants = _grants(body.kind, params)
    for resource, action in grants:
        await _enforce(request, resource, action)
    actor = current_username(request)
    generation = await _request_generation(request, state)
    fresh_until, fresh_sid, fresh_tv = await _fresh_fields(request, state, body.kind)
    items, unit = _items(body.kind, params)
    created = iso_now()
    job = Job(
        kind=body.kind,
        actor=actor,
        actor_generation=generation,
        created_at=created,
        progress=JobProgress(done=0, total=len(items), unit=unit),
        request_fingerprint=_fingerprint(body.kind, params),
        idempotency_key_hash=idempotency_hash(
            actor, body.idempotency_key, generation
        ),
        params=params,
        required_permissions=[
            JobPermission(resource=resource, action=action) for resource, action in grants
        ],
        fresh_authorized_until_millis=fresh_until,
        fresh_session_id=fresh_sid,
        fresh_token_version=fresh_tv,
        item_states=items,
        transitions=[JobTransition(seq=1, name="submitted", summary="validated and queued")],
        transition_seq=1,
    )
    try:
        stored, _is_new, pruned = await state.jobs.create(job)
    except JobConflict as exc:
        raise HTTPException(409, detail=str(exc)) from exc
    except JobCapacityError as exc:
        raise HTTPException(503, detail=str(exc)) from exc
    await state.job_runner.delete_artifacts(pruned)
    if not await state.job_runner.reconcile_audits():
        raise HTTPException(
            503,
            detail="job is durable but its transition audit is unavailable",
        )
    if (
        body.kind == JobKind.TIERED_RESET
        and params.get("scope") == "factory"
        and state.mutation_gate.degraded
    ):
        # A restart during a failed privacy boundary intentionally starts no tenant
        # writer. The only exception is this freshly authorized durable recovery
        # intent, after JobStore atomically transferred the persistent fence to it.
        await state.job_runner.start()
    # Reconciliation updates the durable row, not the stale local transition copy.
    stored = await state.jobs.get(stored.job_id) or stored
    await state.job_runner.publish(stored, force=True)
    state.job_runner.notify()
    return public_job(stored)


@router.get("/jobs", response_model=JobListResponse)
async def list_jobs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobListResponse:
    generation = await _request_generation(request, state)
    rows = await state.jobs.list_for_actor(current_username(request), generation)
    system_receipts: list[Job] = []
    if await has_permission(request, "users", "manage"):
        system_receipts = [
            row
            for row in await state.jobs.list_for_actor("")
            if row.kind == JobKind.TIERED_RESET and row.params == {"scope": "factory"}
        ]
    rows.extend(system_receipts)
    rows.sort(key=lambda row: (row.created_at, row.job_id), reverse=True)
    rows.sort(key=lambda row: 0 if row.status.value not in {
        "succeeded", "partial", "failed", "cancelled"
    } else 1)
    total = len(rows)
    selected = rows[offset : offset + limit]
    related: RelatedJobsPublic | None = None
    if await has_permission(request, "models", "read"):
        batches = await state.real_batch_job_store.list_strict()
        batches.sort(key=lambda row: (row.submitted_at or "", row.id), reverse=True)
        safe_batches: list[RelatedBatchJobPublic] = []
        for row in batches[:100]:
            tracked = {
                key: value
                for key, value in (row.custom_ids or {}).items()
                if key != "__meta__"
            }
            live_retrieved = sum(
                1
                for value in tracked.values()
                if isinstance(value, dict) and value.get("retrieved")
            )
            request_count = max(int(row.summary_total or 0), len(tracked))
            safe_batches.append(
                RelatedBatchJobPublic(
                    id=str(row.id)[:2000],
                    provider=str(row.provider)[:2000],
                    state=str(getattr(row.state, "value", row.state))[:80],
                    model=str(row.model)[:2000],
                    discount=float(row.discount),
                    # Terminal compaction intentionally clears per-request state.
                    # Preserve truthful unified-list totals from its bounded summary,
                    # while still accepting a larger live map during active work.
                    requests=request_count,
                    retrieved=min(
                        max(int(row.summary_retrieved or 0), live_retrieved),
                        request_count,
                    ),
                    submitted_at=row.submitted_at,
                    polled_at=row.polled_at,
                )
            )
        related = RelatedJobsPublic(
            llm_batches=safe_batches,
            total=len(batches),
            truncated=len(batches) > len(safe_batches),
        )
    system_workers: SchedulerHealthPublic | None = None
    if await has_permission(request, "automation", "read"):
        system_workers = SchedulerHealthPublic.model_validate(
            await state.scheduler_health()
        )
    return JobListResponse(
        jobs=[public_job(row) for row in selected],
        total=total,
        limit=limit,
        offset=offset,
        related=related,
        system_workers=system_workers,
    )


async def _owned(job_id: str, request: Request, state: AppState) -> Job:
    job = await state.jobs.get(job_id)
    if (
        job is not None
        and not job.actor
        and job.kind == JobKind.TIERED_RESET
        and job.params == {"scope": "factory"}
        and await has_permission(request, "users", "manage")
    ):
        return job
    generation = await _request_generation(request, state)
    if (
        job is None
        or job.actor.strip().lower() != current_username(request).strip().lower()
        or job.actor_generation != generation
    ):
        raise HTTPException(404, detail="job not found")
    return job


async def _request_generation(request: Request, state: AppState) -> str:
    actor = current_username(request)
    if not state.auth.is_enabled:
        return ""
    from ..constants import USERS_KEY, USERS_NS
    from ..models import User

    getter = getattr(state.kv, "get_strict", None) or state.kv.get
    try:
        doc = await getter(USERS_NS, USERS_KEY)
        if doc is not None and not isinstance(doc, dict):
            raise ValueError("invalid user registry")
        raw = (doc or {}).get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("invalid user registry")
        users = [User.model_validate(row) for row in raw]
    except Exception as exc:
        raise HTTPException(503, detail="durable actor registry unavailable") from exc
    persisted = next(
        (user for user in users if user.username.strip().lower() == actor.lower()),
        None,
    )
    if persisted is not None and persisted.active:
        return account_generation(persisted.username, persisted.created_at)
    if actor.lower() == state.secrets.auth_admin_username.lower():
        return "env-admin"
    raise HTTPException(403, detail="active account identity is unavailable")


@router.get("/jobs/{job_id}", response_model=JobPublic)
async def get_job(
    job_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobPublic:
    return public_job(await _owned(job_id, request, state))


@router.post("/jobs/{job_id}/cancel", status_code=202, response_model=JobPublic)
async def cancel_job(
    job_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
) -> JobPublic:
    job = await state.jobs.request_cancel(
        job_id,
        current_username(request),
        await _request_generation(request, state),
    )
    if job is None:
        raise HTTPException(404, detail="job not found")
    if not await state.job_runner.reconcile_audits():
        raise HTTPException(
            503,
            detail="cancellation is durable but its transition audit is unavailable",
        )
    job = await state.jobs.get(job.job_id) or job
    await state.job_runner.publish(job, force=True)
    state.job_runner.notify()
    return public_job(job)


@router.get(
    "/jobs/{job_id}/artifact",
    responses={
        200: {
            "description": "Verified ZIP artifact",
            "content": {"application/zip": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def job_artifact(
    job_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("inapp", "read")),
):
    job = await _owned(job_id, request, state)
    if job.artifact is None:
        raise HTTPException(404, detail="job artifact not found")
    if not await state.job_runner.permission_alive(job):
        raise HTTPException(403, detail="job artifact permission is no longer active")
    try:
        path = await state.job_runner.verify_artifact(job.artifact)
    except (FileNotFoundError, ValueError):
        await state.jobs.expire_artifact(job.job_id, job.artifact.artifact_id)
        raise HTTPException(410, detail="job artifact expired or failed integrity verification") from None
    return FileResponse(
        path,
        media_type=job.artifact.content_type,
        filename=job.artifact.filename,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Length": str(job.artifact.size),
        },
    )
