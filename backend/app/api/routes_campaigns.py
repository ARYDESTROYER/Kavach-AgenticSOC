"""Cross-case CAMPAIGN routes (Round 4, Wave 4).

READ-ONLY surfaces over the campaign list the deterministic clustering pass
(:mod:`app.engine.campaigns`) produces, plus a manual re-correlate trigger:

* ``GET  /api/campaigns``               — the running campaign list (newest first),
                                          each with its member case ids / entities /
                                          MITRE / severity rollup.
* ``GET  /api/campaigns/{id}``          — one campaign (404 when absent), with the
                                          display number of each member case
                                          (``case_numbers``) for the detail sheet.
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

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..audit.context import audit_context
from ..audit.settings_write import ExecutionStack, audited_settings_write, demo_mode_changed
from ..audit.write import audited_write
from ..config import CampaignConfig
from ..constants import ActionType

# ``_safe`` and ``_campaign_json`` moved to ``engine/views.py`` (chat revamp SPEC §5.3)
# so the chat ``list_campaigns`` tool serialises campaigns the same way; re-exported
# here under their historical names.
from ..engine.views import campaign_json as _campaign_json
from ..engine.views import safe_text as _safe
from ..models import AuditTarget, Campaign
from ..state import AppState
from .deps import current_username, get_state, require_admin, require_permission

logger = logging.getLogger("tlsoc.api.campaigns")

#: The target of every campaign row (the settings and each rebuild), so the audit log's
#: target filter finds them together.
CAMPAIGN_TARGET = AuditTarget(type="setting", id="campaign", label="Campaigns")

_RECORRELATE_DEMO_MESSAGE = (
    "Demo Mode was turned on or off while the campaigns were rebuilt, so nothing was "
    "saved. Try again."
)

router = APIRouter(prefix="/api")


def _actor(request: Request) -> str:
    """The authenticated username, or ``""`` when no principal resolves (sign-in off,
    or a caller without one): the row is then written anonymously, never refused."""
    try:
        return current_username(request) or ""
    except Exception:  # noqa: BLE001 (no resolvable principal; audit anonymously)
        return ""


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
    change is an operator action, matching the recorrelate route).

    Audited before it is saved (#2, Round 14 SPEC §3.6): a ``settings.updated`` row
    naming every changed field is appended first, and a failed append answers ``503
    audit_unavailable`` with nothing saved. The campaign policy follows the active
    execution stack, so in Demo Mode the edit stays in the Demo sandbox and its row goes
    to the Demo audit (SPEC §3.5)."""
    saved: dict[str, CampaignConfig] = {}

    def _apply(current):
        cfg_now = (getattr(current, "campaign", None) or CampaignConfig()).model_dump(mode="json")
        merged = _deep_update(cfg_now, body or {})
        try:
            cfg = CampaignConfig.model_validate(merged)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=f"Invalid campaign config: {exc}") from exc
        saved["cfg"] = cfg
        return current.model_copy(update={"campaign": cfg})

    def _summary(_changes, _total) -> str:
        cfg = saved["cfg"]
        return f"campaign_config_update: enabled={cfg.enabled} cadence={cfg.cadence}"[:500]

    await audited_settings_write(
        state, transform=_apply, scope="execution", actor=_actor(request),
        context=audit_context(request), summary=_summary,
        action_type=ActionType.USER_MGMT, surface="campaigns",
        target=CAMPAIGN_TARGET,
    )
    return {"ok": True, "config": saved["cfg"].model_dump(mode="json")}


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
    MITRE union and severity rollup. 404 when absent. Read-only advisory (#3/#4).

    ``case_numbers`` (Round 13 polish, additive) maps a member case id to its display
    number ("CASE-000045"), so the Campaigns detail sheet names members the way the rest
    of the console does. Bounded (:data:`_MEMBER_NUMBER_READS` reads); a member without
    a number, past the bound or whose read fails is simply absent and keeps its id."""
    try:
        campaign = await state.campaign_store.get(campaign_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("campaign get failed (%s)", exc)
        campaign = None
    if campaign is None:
        raise HTTPException(status_code=404, detail="campaign not found")
    return {
        "campaign": _campaign_json(campaign),
        "case_numbers": await _member_numbers(state, campaign.case_ids),
    }


#: The most member cases one campaign read resolves display numbers for.
_MEMBER_NUMBER_READS = 200
#: Member reads in flight at once.
_MEMBER_NUMBER_CONCURRENCY = 8


async def _member_numbers(state: AppState, case_ids: list[str]) -> dict[str, str]:
    """``{case_id: display number}`` for up to :data:`_MEMBER_NUMBER_READS` distinct
    members. Read-only (one bounded ``get`` each); a failed read or a case without a
    number is left out. NEVER raises."""
    cases = getattr(state, "cases", None)
    if cases is None:
        return {}
    ids = list(dict.fromkeys(str(c) for c in case_ids if c))[:_MEMBER_NUMBER_READS]
    gate = asyncio.Semaphore(_MEMBER_NUMBER_CONCURRENCY)

    async def one(cid: str) -> tuple[str, str | None]:
        async with gate:
            try:
                case = await cases.get(cid)
            except Exception as exc:  # noqa: BLE001 — the id alone still names it
                logger.info("campaign member read failed (%s)", exc)
                return cid, None
        number = _safe(getattr(case, "case_number", "") or "") if case is not None else ""
        return cid, (number or None)

    pairs = await asyncio.gather(*(one(cid) for cid in ids))
    return {_safe(cid): number for cid, number in pairs if number and number != cid}


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
    untouched. Admin-gated (a tenant-wide manual re-correlate is an operator action).

    Audited before the new set is stored (#2, Round 14 SPEC §3.6): the pass is a read,
    then a ``campaign.recorrelated`` row is appended, then the set replaces the stored
    one. A failed append answers ``503 audit_unavailable`` and the stored set is
    unchanged; a failed store write appends ``campaign.recorrelate_failed`` and answers
    ``503``. The campaign store follows the active execution stack, so in Demo Mode the
    row goes to the Demo audit (SPEC §3.5).

    The pass, its row and the store it replaces belong to one execution stack, bound
    before the pass reads anything: campaigns built from Demo cases never replace the
    real set, nor real campaigns the sandbox's. When Demo Mode is turned on or off while
    the pass runs, nothing is recorded or stored; when it moves after the row, the store
    write is refused and paired with its failure row. Either way the request answers
    ``409 demo_mode_changed``."""
    # One synchronous step: the generation, the audit log, the case store the pass
    # reads, the settings it reads and the campaign store it replaces.
    stack = ExecutionStack(state)
    correlate = state.campaign_correlator
    prefs = state.execution_prefs
    store = state.campaign_store
    try:
        campaigns = list(await correlate(None, prefs) or [])
    except Exception as exc:  # noqa: BLE001 — return truthful failure, never false success
        logger.warning("campaign recorrelate failed (%s)", exc)
        if stack.moved():
            raise demo_mode_changed(_RECORRELATE_DEMO_MESSAGE) from exc
        raise HTTPException(
            status_code=503,
            detail="campaign reconciliation could not be completed or persisted",
        ) from exc
    links = sum(len(c.case_ids) for c in campaigns)

    async def _store() -> list[Campaign]:
        stack.check(_RECORRELATE_DEMO_MESSAGE)
        # A full pass is authoritative. Persist the exact set even when it is empty,
        # otherwise stale campaigns survive forever after their graph disappears.
        return await store.replace_all(campaigns)

    try:
        stored: list[Campaign] = await audited_write(
            state, sink=stack.audit, action="campaign.recorrelated",
            failure="campaign.recorrelate_failed", target=CAMPAIGN_TARGET,
            expected_revision=None, changes=None, write=_store,
            action_type=ActionType.USER_MGMT, actor=_actor(request),
            surface="campaigns", context=audit_context(request),
            result_summary=(
                f"campaigns_recorrelate: built {len(campaigns)} campaign(s) "
                f"over {links} case-links"
            )[:500],
            tool_input={"campaigns": len(campaigns), "case_links": links},
            # Built from another stack's cases: nothing attempted, so no row.
            precheck=lambda: stack.check(_RECORRELATE_DEMO_MESSAGE),
        )
    except HTTPException:
        # 503 audit_unavailable (nothing changed) or 409 demo_mode_changed.
        raise
    except Exception as exc:  # noqa: BLE001 (the failure row is written; never false success)
        logger.warning("campaign recorrelate store failed (%s)", exc)
        raise HTTPException(
            status_code=503,
            detail="campaign reconciliation could not be completed or persisted",
        ) from exc
    return {"ok": True, "count": len(stored), "campaigns": [_campaign_json(c) for c in stored]}
