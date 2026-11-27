"""Deprecated synchronous reset discovery route.

All mutations moved to ``POST /api/jobs`` kind ``tiered_reset``. Keeping a 410 route
gives old clients an actionable response without preserving a factory-fence bypass.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..state import AppState
from .deps import get_state, require_admin, require_fresh_auth

router = APIRouter(prefix="/api")

class ResetBody(BaseModel):
    scope: str
    confirm: str = ""


@router.post(
    "/admin/reset",
    deprecated=True,
    status_code=410,
    responses={
        410: {
            "description": "Mutation retired; submit a tiered_reset durable Job.",
        }
    },
)
async def admin_reset(
    body: ResetBody,
    request: Request,
    state: AppState = Depends(get_state),
    _admin=Depends(require_admin),                 # privileged grant (users:manage)
    _fresh=Depends(require_fresh_auth()),          # step-up / sudo re-auth
) -> dict:
    del body, request, state, _admin, _fresh
    raise HTTPException(
        status_code=410,
        detail={
            "code": "durable_job_required",
            "message": "submit tiered_reset through POST /api/jobs",
        },
    )
