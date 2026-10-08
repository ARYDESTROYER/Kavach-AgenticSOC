"""Cross-case CAMPAIGN routes (Round 4, Wave 4).

READ-ONLY surfaces over the campaign list the deterministic clustering pass
(:mod:`app.engine.campaigns`) produces, plus a manual re-correlate trigger:

* ``GET  /api/campaigns``               — the running campaign list (newest first),
                                          each with its member case ids / entities /
                                          MITRE / severity rollup.
* ``GET  /api/campaigns/{id}``          — one campaign (404 when absent).
* ``GET  /api/cases/{id}/campaign``     — the campaign a case belongs to, or ``null``.
* ``POST /api/campaigns/recorrelate``   — trigger the deterministic pass ON DEMAND;
                                          returns the freshly-built campaigns. It is a
                                          READ-TIME AGGREGATOR — it NEVER investigates,
                                          mutates a case, closes/escalates one, or
                                          touches a ``cluster_signature``.

A SEPARATE router module (the integrator mounts it with the SAME ``require_auth``
mount the monolith uses). The GET routes gate on ``cases:read``; the non-GET
re-correlate gates on ``cases:read`` too — but see below: it is a state-changer in the
route-auth-coverage sense (non-GET), so it ALSO carries an explicit ``require_admin``
authZ dependency (a manual, tenant-wide re-correlate is an operator action).

⛔ NON-NEGOTIABLE #3: nothing here imports ``case_manager`` / calls ``decide()``. A
campaign is ADVISORY — it can never close or escalate a member case; a NEEDS_HUMAN
case that joins a campaign stays NEEDS_HUMAN.

⛔ NON-NEGOTIABLE #4: a campaign only REFERENCES ``case_ids`` and never recomputes /
mutates a case's ``cluster_signature``; re-correlating does not touch any case.

⛔ NON-NEGOTIABLE #9: every entity ``value`` / MITRE id / campaign name returned here
is source-derived PLAIN DATA — the UI render-escapes it and it is never interpolated
into a prompt. Values are returned as plain, length-bounded strings.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..config import CampaignConfig
from ..constants import ActionType

# ``_safe`` and ``_campaign_json`` moved to ``engine/views.py`` (chat revamp SPEC §5.3)
# so the chat ``list_campaigns`` tool serialises campaigns the same way; re-exported
# here under their historical names.
from ..engine.views import campaign_json as _campaign_json
from ..engine.views import safe_text as _safe
from ..models import Campaign
from ..state import AppState
from .deps import current_username, get_state, require_admin, require_permission

logger = logging.getLogger("tlsoc.api.campaigns")

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# Helpers — plain-data serialisation (#9)
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# GET /api/campaigns — the running campaign list (newest first)
# --------------------------------------------------------------------------- #
@router.get("/campaigns")
async def list_campaigns(
    status: str | None = None,
    limit: int = 0,
    offset: int = 0,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The persisted campaign list, newest first (by ``last_seen`` then created).

    ``status`` filters by :class:`app.constants.CampaignStatus` value; ``limit`` (>0) /
    ``offset`` page. NEVER raises — a store glitch degrades to an empty list. Advisory,
    read-only (#3/#4)."""
    try:
        campaigns, total = await state.campaign_store.list(
            status=status, limit=max(int(limit), 0), offset=max(int(offset), 0),
        )
    except Exception as exc:  # noqa: BLE001 — campaigns are best-effort
        logger.warning("campaign list failed (%s); returning empty", exc)
        campaigns, total = [], 0
    return {
        "campaigns": [_campaign_json(c) for c in campaigns],
        "total": total,
        "enabled": bool(getattr(getattr(state.execution_prefs, "campaign", None), "enabled", False)),
    }


# --------------------------------------------------------------------------- #
# GET / PUT /api/campaigns/config — read/update Preferences.campaign
# (mirrors routes_tuning's GET/PUT /tuning/config; deep-merge PUT semantics)
#
# NB registered BEFORE the ``/campaigns/{campaign_id}`` catch-all so the literal
# ``config`` path is not swallowed as a campaign id (FastAPI matches in order).
# --------------------------------------------------------------------------- #
@router.get("/campaigns/config")
async def get_campaign_config(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Read ``Preferences.campaign`` (the cross-case clustering policy). Read-only, no
    secrets — the campaign block carries only cadence/enable knobs (#10)."""
    cfg = getattr(state.execution_prefs, "campaign", None) or CampaignConfig()
    return {"config": cfg.model_dump(mode="json")}


@router.put("/campaigns/config")
async def put_campaign_config(
    body: dict[str, Any],
    request: Request,
    state: AppState = Depends(get_state),
    _perm=Depends(require_permission("cases", "read")),
    _admin=Depends(require_admin),
) -> dict[str, Any]:
    """Update the ``campaign`` policy, DEEP-MERGING only the keys the caller sent onto
    the live config (mirrors the ``PUT /api/settings`` contract). Additive + validated
    by the Pydantic model; a campaign is ADVISORY — nothing here calls ``decide()`` (#3)
    or touches a ``cluster_signature`` (#4). Admin-gated (a tenant-wide clustering-policy
    change is an operator action, matching the recorrelate route). Audited (#2)."""
    active_prefs = state.execution_prefs
    current = (getattr(active_prefs, "campaign", None) or CampaignConfig()).model_dump(mode="json")
    merged = _deep_update(current, body or {})
    try:
        cfg = CampaignConfig.model_validate(merged)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Invalid campaign config: {exc}") from exc
    prefs = active_prefs.model_copy(update={"campaign": cfg})
    await state.update_execution_prefs(prefs)
    await _audit(
        state, request, "campaign_config_update",
        f"enabled={cfg.enabled} cadence={cfg.cadence}",
    )
    return {"ok": True, "config": cfg.model_dump(mode="json")}


# --------------------------------------------------------------------------- #
# GET /api/campaigns/{id} — one campaign + its member rollups
# --------------------------------------------------------------------------- #
@router.get("/campaigns/{campaign_id}")
async def get_campaign(
    campaign_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """One campaign by its (content-hash) id — its member case ids, shared entities,
    MITRE union and severity rollup. 404 when absent. Read-only advisory (#3/#4)."""
    try:
        campaign = await state.campaign_store.get(campaign_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("campaign get failed (%s)", exc)
        campaign = None
    if campaign is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    return {"campaign": _campaign_json(campaign)}


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/campaign — the campaign a case belongs to (or null)
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/campaign")
async def case_campaign(
    case_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The campaign this case is a member of, or ``null`` when it belongs to none.

    Scans the persisted campaign list for one whose ``case_ids`` contains this case —
    a case belongs to at most one campaign (a connected component is disjoint). NEVER
    404s: an unknown / uncampaigned case returns ``{"campaign": null}``. Read-only."""
    cid = (case_id or "").strip()
    try:
        campaigns, _total = await state.campaign_store.list()
    except Exception as exc:  # noqa: BLE001
        logger.warning("case-campaign lookup failed (%s)", exc)
        campaigns = []
    match = next((c for c in campaigns if cid and cid in c.case_ids), None)
    return {"case_id": _safe(cid), "campaign": _campaign_json(match) if match else None}


# --------------------------------------------------------------------------- #
# POST /api/campaigns/recorrelate — trigger the deterministic pass on demand
# --------------------------------------------------------------------------- #
@router.post("/campaigns/recorrelate")
async def recorrelate_campaigns(
    request: Request,
    state: AppState = Depends(get_state),
    _perm=Depends(require_permission("cases", "read")),
    _admin=Depends(require_admin),
) -> dict[str, Any]:
    """Run the deterministic cross-case CAMPAIGN pass NOW and return the campaigns.

    Pages the trailing window of already-persisted CASES, clusters them (shared
    cross-source entity OR MITRE, connected-component ≥2 with a shared entity),
    UPSERTS the result into ``campaign_store`` (idempotent — same members → same id),
    and returns them. It NEVER investigates a case, calls an LLM (#6), touches a
    ``cluster_signature`` (#4), or calls ``decide()`` (#3) — a case's status is
    untouched. Admin-gated (a tenant-wide manual re-correlate is an operator action);
    audited (#2). NEVER raises — a store glitch degrades to an empty result."""
    try:
        campaigns = await state.campaign_correlator(None, state.execution_prefs)
        # A full pass is authoritative. Persist the exact set even when it is empty,
        # otherwise stale campaigns survive forever after their graph disappears.
        stored: list[Campaign] = await state.campaign_store.replace_all(
            list(campaigns or [])
        )
    except Exception as exc:  # noqa: BLE001 — return truthful failure, never false success
        logger.warning("campaign recorrelate failed (%s)", exc)
        raise HTTPException(
            status_code=503,
            detail="campaign reconciliation could not be completed or persisted",
        ) from exc
    await _audit(
        state, request, "campaigns_recorrelate",
        f"built {len(stored)} campaign(s) over {sum(len(c.case_ids) for c in stored)} case-links",
    )
    return {"ok": True, "count": len(stored), "campaigns": [_campaign_json(c) for c in stored]}


# --------------------------------------------------------------------------- #
# Audit helper (#2 — append-only)
# --------------------------------------------------------------------------- #
async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only audit of an operator campaign action (#2). Best-effort.

    Uses ``USER_MGMT`` with ``surface="campaigns"`` — constants are frozen this wave so
    no new ActionType is introduced. The actor is the authenticated username when
    present. NEVER raises."""
    audit = getattr(state, "audit", None)
    if audit is None:
        return
    try:
        actor = current_username(request) or ""
    except Exception:  # noqa: BLE001 — no resolvable principal; audit anonymously
        actor = ""
    try:
        await audit.record(
            action_type=ActionType.USER_MGMT,
            surface="campaigns",
            actor=actor,
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass
