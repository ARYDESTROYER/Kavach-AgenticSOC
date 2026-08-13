"""BATCH-inference job routes — Round 4 / Wave 4 (READ-ONLY).

A SEPARATE feature router (the integrator mounts it with the same ``require_auth``
mount the monolith uses). It surfaces the durable async LLM batch-job registry
(:class:`app.stores.batch_jobs.BatchJobStore`) so an operator can see which
low-urgency investigations were routed through a provider's discounted async batch
API, and how far each has progressed (submit → poll → retrieve).

This router is READ-ONLY: it lists / gets :class:`app.models.BatchJob` rows. Submit /
poll / retrieve is driven OUT-OF-BAND by the Wave-4 batch service — not exposed here.

⚠ NON-NEGOTIABLES held here. #6: the batch service writes EXACTLY ONE ``UsageDoc`` per
result (deduped by ``custom_id`` at the 0.5× batch rate); this router only READS the
job registry — it never records a ledger row or folds a result. #3: nothing here
imports or calls ``case_manager.decide()`` — a batch job is advisory plumbing. #9:
every value returned (job id / provider / model / states) is PLAIN, attacker-
influenceable data — the UI renders it escaped; no secret is ever returned (a
``BatchJob`` carries no credential — ``provider_batch_id`` is the provider's opaque
job handle, not a key).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..config import BatchConfig
from ..constants import ActionType
from ..models import BatchJob
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.batch")

router = APIRouter(prefix="/api")


def _safe(value: Any) -> str:
    """Plain, length-bounded string for the client (#9)."""
    return str(value)[:2000]


def _deep_update(dst: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    """In-place recursive merge of ``src`` INTO ``dst`` — a PUT deep-merges only the
    keys the caller sent (mirrors ``routes.py:_deep_update`` + the ``PUT /api/settings``
    contract). Absent keys keep their current value; a nested dict is merged, not
    replaced."""
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            dst[key] = _deep_update(dst[key], value)
        else:
            dst[key] = value
    return dst


def _job_json(job: BatchJob) -> dict[str, Any]:
    """PLAIN, secret-free JSON for one batch job (#9).

    The per-request ``custom_ids`` map is summarised to COUNTS (total / retrieved)
    rather than echoed verbatim, so a large job stays a small, bounded response and no
    case-scoped custom_id text is leaked into the body."""
    tracked = {k: v for k, v in (job.custom_ids or {}).items() if k != "__meta__"}
    retrieved = sum(1 for v in tracked.values() if isinstance(v, dict) and v.get("retrieved"))
    total_count = max(int(job.summary_total or 0), len(tracked))
    retrieved_count = max(int(job.summary_retrieved or 0), retrieved)
    return {
        "id": _safe(job.id),
        "provider": _safe(job.provider),
        "provider_batch_id": _safe(job.provider_batch_id) if job.provider_batch_id else None,
        "state": _safe(getattr(job.state, "value", job.state)),
        "model": _safe(job.model),
        "discount": float(job.discount),
        "requests": total_count,
        "retrieved": min(retrieved_count, total_count),
        "submitted_at": _safe(job.submitted_at) if job.submitted_at else None,
        "polled_at": _safe(job.polled_at) if job.polled_at else None,
        "last_error": _safe(job.last_error) if job.last_error else None,
    }


# --------------------------------------------------------------------------- #
# GET /api/batch/jobs — list every tracked batch job
# --------------------------------------------------------------------------- #
@router.get("/batch/jobs")
async def list_batch_jobs(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    """List every tracked batch job (secret-free, bounded). Newest-submitted first."""
    try:
        jobs = await state.batch_job_store.list_strict()
    except Exception as exc:  # noqa: BLE001 — distinguish outage from an empty registry
        logger.warning("batch job list failed (%s)", exc)
        raise HTTPException(
            status_code=503, detail="batch job registry unavailable"
        ) from exc
    rows = [_job_json(j) for j in jobs]
    # Newest first (submitted_at is ISO; None sorts last).
    rows.sort(key=lambda r: (r["submitted_at"] or ""), reverse=True)
    return {"jobs": rows, "count": len(rows)}


# --------------------------------------------------------------------------- #
# GET /api/batch/jobs/{job_id} — one job
# --------------------------------------------------------------------------- #
@router.get("/batch/jobs/{job_id}")
async def get_batch_job(
    job_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    """One batch job by id (secret-free, bounded). 404 when unknown."""
    jid = (job_id or "").strip()
    try:
        job = await state.batch_job_store.get_strict(jid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("batch job get failed (%s)", exc)
        raise HTTPException(
            status_code=503, detail="batch job registry unavailable"
        ) from exc
    if job is None:
        raise HTTPException(status_code=404, detail="batch job not found")
    return {"job": _job_json(job)}


# --------------------------------------------------------------------------- #
# GET / PUT /api/batch/config — read/update Preferences.batch
# (mirrors routes_tuning's GET/PUT /tuning/config; deep-merge PUT semantics)
# --------------------------------------------------------------------------- #
@router.get("/batch/config")
async def get_batch_config(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    """Read ``Preferences.batch`` (the batch-inference cost policy). Read-only, no
    secrets — the batch block carries only routing knobs, never a credential (#10)."""
    cfg = getattr(state.execution_prefs, "batch", None) or BatchConfig()
    return {"config": cfg.model_dump(mode="json")}


@router.put("/batch/config")
async def put_batch_config(
    body: dict[str, Any],
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "manage")),
) -> dict[str, Any]:
    """Update the ``batch`` policy, DEEP-MERGING only the keys the caller sent onto the
    active execution config (mirrors the ``PUT /api/settings`` contract). Additive + validated by
    the Pydantic model; #6 is untouched (this only toggles routing — the batch service
    still writes exactly one UsageDoc per resolved call). Never touches ``decide()`` (#3).
    During Demo Mode the edit remains in the throwaway sandbox; off demo it persists
    normally. Audited (#2)."""
    active_prefs = state.execution_prefs
    current = (getattr(active_prefs, "batch", None) or BatchConfig()).model_dump(mode="json")
    merged = _deep_update(current, body or {})
    try:
        cfg = BatchConfig.model_validate(merged)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Invalid batch config: {exc}") from exc
    prefs = active_prefs.model_copy(update={"batch": cfg})
    await state.update_execution_prefs(prefs)
    await _audit(
        state, request, "batch_config_update",
        f"enabled={cfg.enabled} severity_floor={cfg.severity_floor} "
        f"flex={cfg.flex} prefer_discounted_alerts={cfg.prefer_discounted_alerts} "
        f"fallback_to_standard={cfg.fallback_to_standard} "
        f"providers={','.join(cfg.providers)}",
    )
    return {"ok": True, "config": cfg.model_dump(mode="json")}


# --------------------------------------------------------------------------- #
# Audit helper (#2 — append-only)
# --------------------------------------------------------------------------- #
async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only audit of an operator batch-config mutation (#2). Best-effort.

    Uses ``USER_MGMT`` with ``surface="batch"`` — constants are frozen this wave so no
    new ActionType is introduced (mirrors ``routes_campaigns._audit``). The actor is the
    authenticated username when present. NEVER raises."""
    # The batch config follows the active execution sandbox.  Keep its audit beside
    # that config: demo-only changes disappear with the demo stack; off demo this is
    # the same durable append-only logger as before.
    audit = getattr(state, "execution_audit", None)
    if audit is None:
        return
    try:
        actor = current_username(request) or ""
    except Exception:  # noqa: BLE001 — no resolvable principal; audit anonymously
        actor = ""
    try:
        await audit.record(
            action_type=ActionType.USER_MGMT,
            surface="batch",
            actor=actor,
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass
