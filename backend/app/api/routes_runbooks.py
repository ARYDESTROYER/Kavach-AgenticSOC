"""Operator-managed Runbooks under the Intelligence surface.

Runbooks are trusted, retrievable investigation reference knowledge. They are not
Playbooks, cannot execute tools, and never participate in the deterministic case
close/escalate decision. Bundled Markdown is protected; operator Markdown is
durable state and its vector projection is independently repairable.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from ..constants import ActionType
from ..engine.runbooks import (
    MAX_RUNBOOK_BYTES,
    MAX_RUNBOOK_BODY_CHARS,
    MAX_RETRIEVAL_DESCRIPTOR_CHARS,
    RunbookConflictError,
    RunbookManagementError,
    RunbookNotFoundError,
    RunbookProtectedError,
    RunbookRevisionConflictError,
    RunbookValidationError,
    runbook_authoring_standard,
)
from ..state import AppState
from .deps import current_username, get_state, require_permission

router = APIRouter(prefix="/api")


class RunbookCreateRequest(BaseModel):
    # Defaults let the domain validator return the same actionable issue envelope
    # for blank form submissions instead of an opaque Pydantic length error.
    id: str = ""
    content: str = ""


class RunbookUpdateRequest(BaseModel):
    content: str = ""
    expected_revision: int = Field(ge=1)


def _raise_management_http(exc: Exception) -> None:
    if isinstance(exc, RunbookNotFoundError):
        raise HTTPException(status_code=404, detail="runbook not found") from exc
    if isinstance(exc, (RunbookConflictError, RunbookRevisionConflictError)):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, RunbookProtectedError):
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if isinstance(exc, RunbookValidationError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "runbook_validation_failed",
                "message": "Runbook rejected. Fix the issues below and submit again.",
                "issues": [issue.payload() for issue in exc.issues],
                "limits": {
                    "body_max_characters": MAX_RUNBOOK_BODY_CHARS,
                    "retrieval_descriptor_max_characters": MAX_RETRIEVAL_DESCRIPTOR_CHARS,
                    "document_max_bytes": MAX_RUNBOOK_BYTES,
                },
                "body_characters": exc.body_characters,
            },
        ) from exc
    if isinstance(exc, RunbookManagementError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "runbook_validation_failed",
                "message": "Runbook rejected. Fix the issue below and submit again.",
                "issues": [
                    {
                        "code": "runbook.invalid",
                        "field": "content",
                        "problem": str(exc),
                        "reason": "The submitted runbook does not satisfy the catalog contract.",
                        "fix": "Correct the reported value and submit the runbook again.",
                    }
                ],
                "limits": {
                    "body_max_characters": MAX_RUNBOOK_BODY_CHARS,
                    "retrieval_descriptor_max_characters": MAX_RETRIEVAL_DESCRIPTOR_CHARS,
                    "document_max_bytes": MAX_RUNBOOK_BYTES,
                },
                "body_characters": 0,
            },
        ) from exc
    # Strict state-store operations intentionally surface a bounded availability
    # error rather than claiming a write succeeded when persistence is uncertain.
    raise HTTPException(status_code=503, detail="runbook state is temporarily unavailable") from exc


def _retrieval_enabled(state: AppState) -> bool:
    return bool(
        state.prefs.runbooks.enabled
        and state.prefs.rag.enabled
        and state.prefs.rag.use_runbooks
    )


async def _projection_revisions(state: AppState) -> dict[str, int]:
    if not _retrieval_enabled(state):
        return {}
    await state.rag.ensure_seeded()
    return await state.rag.runbook_projection_revisions()


def _payload(record, *, projection: dict[str, int], enabled: bool, detail: bool = False):
    payload = record.payload(include_content=detail)
    if not enabled:
        payload["index_status"] = "disabled"
        payload["index_error"] = ""
        return payload
    projected = int(projection.get(record.runbook.id, 0) or 0)
    if projected == record.revision:
        payload["index_status"] = "ready"
        payload["indexed_revision"] = projected
    elif record.index_status == "failed":
        payload["index_status"] = "failed"
    elif projected:
        payload["index_status"] = "stale"
        payload["indexed_revision"] = projected
    else:
        payload["index_status"] = "pending"
    return payload


@router.get("/runbooks")
async def list_runbooks(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> dict[str, Any]:
    records = await state.runbooks.list()
    enabled = _retrieval_enabled(state)
    projection = await _projection_revisions(state)
    return {
        "enabled": state.prefs.runbooks.enabled,
        "retrieval_enabled": enabled,
        "authoring_standard": runbook_authoring_standard(),
        "count": len(records),
        "runbooks": [
            _payload(record, projection=projection, enabled=enabled) for record in records
        ],
    }


@router.get("/runbooks/{runbook_id}")
async def get_runbook(
    runbook_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "read")),
) -> dict[str, Any]:
    try:
        record = await state.runbooks.get(runbook_id)
    except Exception as exc:
        _raise_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    enabled = _retrieval_enabled(state)
    return _payload(
        record,
        projection=await _projection_revisions(state),
        enabled=enabled,
        detail=True,
    )


async def _audit(state: AppState, request: Request, summary: str) -> None:
    await state.control_audit.record(
        action_type=ActionType.RUNBOOK,
        surface="runbooks",
        actor=current_username(request) or "operator",
        result_summary=summary,
    )


async def _mutation_response(state: AppState, runbook_id: str) -> dict[str, Any]:
    index = await state.rag.reindex_runbooks({runbook_id})
    record = await state.runbooks.get(runbook_id)
    projection = await state.rag.runbook_projection_revisions()
    return {
        "ok": True,
        "runbook": _payload(
            record,
            projection=projection,
            enabled=_retrieval_enabled(state),
        ),
        "index": index,
    }


@router.post("/runbooks", status_code=status.HTTP_201_CREATED)
async def create_runbook(
    body: RunbookCreateRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    actor = current_username(request) or "operator"
    try:
        record = await state.runbooks.create(body.id, body.content, actor=actor)
    except Exception as exc:
        _raise_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    await _audit(state, request, f"created operator runbook {record.runbook.id} revision 1")
    return await _mutation_response(state, record.runbook.id)


@router.put("/runbooks/{runbook_id}")
async def update_runbook(
    runbook_id: str,
    body: RunbookUpdateRequest,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    actor = current_username(request) or "operator"
    try:
        record = await state.runbooks.update(
            runbook_id,
            body.content,
            actor=actor,
            expected_revision=body.expected_revision,
        )
    except Exception as exc:
        _raise_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    await _audit(
        state,
        request,
        f"updated operator runbook {record.runbook.id} revision {record.revision}",
    )
    return await _mutation_response(state, record.runbook.id)


@router.delete("/runbooks/{runbook_id}")
async def delete_runbook(
    runbook_id: str,
    request: Request,
    expected_revision: int = Query(..., ge=1),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    try:
        await state.runbooks.delete(runbook_id, expected_revision=expected_revision)
    except Exception as exc:
        _raise_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    index = await state.rag.reindex_runbooks({runbook_id})
    await _audit(state, request, f"deleted operator runbook {runbook_id}")
    return {"ok": True, "id": runbook_id, "index": index}


@router.post("/runbooks/reindex", deprecated=True)
async def reindex_runbooks(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    """Deprecated request-bound full reconciliation compatibility route.

    New operator workflows submit ``runbook_reindex`` through ``POST /api/jobs`` so
    the full reconciliation survives navigation and has a durable result.
    """
    result = await state.rag.reindex_runbooks()
    await _audit(
        state,
        request,
        f"reindexed runbooks indexed={result.get('indexed', 0)} failed={result.get('failed', 0)}",
    )
    return result


@router.post("/runbooks/{runbook_id}/reindex")
async def reindex_runbook(
    runbook_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("runbooks", "manage")),
) -> dict[str, Any]:
    try:
        await state.runbooks.get(runbook_id)
    except Exception as exc:
        _raise_management_http(exc)
        raise AssertionError("unreachable")  # pragma: no cover
    result = await state.rag.reindex_runbooks({runbook_id})
    await _audit(
        state,
        request,
        (
            f"reindexed runbook {runbook_id} indexed={result.get('indexed', 0)} "
            f"failed={result.get('failed', 0)}"
        ),
    )
    return result
