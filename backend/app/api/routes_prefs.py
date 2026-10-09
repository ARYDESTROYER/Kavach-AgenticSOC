"""Preferences / branding / customization routes — Round 5 (Coupling-E extraction).

A cohesive slice carved OUT of the ``routes.py`` monolith with **byte-identical
paths, methods, auth dependencies, request/response bodies**. Nothing here is new
behaviour — the handlers were moved verbatim (imports re-homed) and the router is
mounted in ``main.py`` under the SAME ``require_auth`` gate the monolith uses, so
``test_route_auth_coverage`` stays green.

It owns three closely-related surfaces:

* ``/api/branding`` (GET public-read / PUT admin) — the org white-label.
* ``/api/prefs/*`` + ``/api/terminology`` + ``/api/views/*`` — the pervasive
  customization cascade (ORG defaults on ``Preferences.customization`` ← per-user
  ``UserPrefsStore`` overrides), personal saved views, per-table column state.

NON-NEGOTIABLES held: #9 — all terminology / view / branding text is plain DATA
rendered by the UI, never markup, never an LLM prompt input; ORG writers are
admin-gated; personal writers are self-service (each user edits only their own
bucket). #2 — org-default + terminology writes record an append-only audit row.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import BrandingConfig, CustomizationConfig
from ..constants import ActionType
from ..models import MAX_CHAT_PROMPTS, ChatPrompt, ColumnState, SavedView
from ..state import AppState
from ..stores.user_prefs import resolve_effective_prefs
from .deps import current_user, current_username, get_state, require_admin

logger = logging.getLogger("tlsoc.api.prefs")

router = APIRouter(prefix="/api")


@router.get("/branding", response_model=BrandingConfig)
async def branding_get(state: AppState = Depends(get_state)) -> BrandingConfig:
    return state.prefs.branding


@router.put("/branding")
async def branding_put(
    body: BrandingConfig,
    state: AppState = Depends(get_state),
    _admin=Depends(require_admin),  # ADMIN-ONLY: org-wide branding is an admin surface
) -> dict[str, Any]:
    def _apply(current):
        if current.read_only_settings_mode:
            raise HTTPException(status_code=403, detail="settings are read-only")
        return current.model_copy(update={"branding": body})

    prefs = await state.mutate_prefs(_apply)
    # Persist exactly as before, then ADDITIVELY annotate the response with a WCAG-AA
    # contrast advisory (Wave-4): the exact higher-contrast black/white *-foreground
    # derived for each operator accent (auto_corrected) + plain-text warnings only for
    # pairs that still cannot reach AA. This does not block — the save above already
    # succeeded. Operator hex is bounded by BrandingConfig; the helper is pure/fail-open.
    from ..engine.contrast import evaluate_branding_contrast

    saved = prefs.branding.model_dump(mode="json")
    advisory = evaluate_branding_contrast(saved)
    saved["auto_corrected"] = advisory["auto_corrected"]
    saved["contrast_warnings"] = advisory["contrast_warnings"]
    return saved


# --------------------------------------------------------------------------- #
# Pervasive customization (Wave 7) — two-store model: ORG defaults on
# Preferences.customization (admin-only PUT) + PERSONAL prefs in the per-user
# UserPrefsStore (keyed by user_id; the 'default' bucket when auth is off). The
# cascade resolver merges ORG ← USER. ALL terminology/view text is plain DATA
# rendered by the UI (#9) — never markup, never an LLM prompt input.
# --------------------------------------------------------------------------- #
def _prefs_user_id(request: Request, state: AppState) -> str | None:
    """The bucket key for the caller's personal prefs: their username when auth is
    on + a session is present, else None → the store's shared ``default`` bucket
    (so the no-auth profile still has real, persisted personal prefs)."""
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return None
    principal = current_user(request)
    return principal.username if principal else None


class UserPrefsPatchBody(BaseModel):
    """Partial update of the caller's PERSONAL prefs bucket. Every field optional —
    only provided (non-None) fields are written. ``saved_views``/``tables`` accept
    the full replacement lists/maps (use the dedicated /views + /tables routes for
    granular edits)."""

    saved_views: list[SavedView] | None = None
    tables: dict[str, ColumnState] | None = None
    theme_mode: Literal["light", "dark", "system"] | None = None
    last_list_state: dict[str, dict[str, Any]] | None = None
    pinned_view_ids: list[str] | None = None
    misc: dict[str, Any] | None = None
    # The full replacement list of the user's saved chat prompts (chat revamp SPEC
    # §10.4: <= 50 of {id, title <= 60, text <= 2000}). Plain user text; the store
    # re-validates through UserPrefs, which sanitises and bounds it again.
    chat_prompts: list[ChatPrompt] | None = Field(default=None, max_length=MAX_CHAT_PROMPTS)


class SavedViewBody(BaseModel):
    """Create/clone a personal saved view. ``id`` is server-assigned on create. All
    free-text is plain data (#9)."""

    name: str = ""
    scope: str = "cases"
    shared: bool = False
    filters: dict[str, Any] = Field(default_factory=dict)
    sort: str = ""
    columns: list[str] | None = None


class SavedViewPatchBody(BaseModel):
    """Partial edit of a personal saved view (only provided fields change)."""

    name: str | None = None
    scope: str | None = None
    shared: bool | None = None
    filters: dict[str, Any] | None = None
    sort: str | None = None
    columns: list[str] | None = None


class TerminologyBody(BaseModel):
    """The ORG terminology label-override map (admin-only). Every value is plain DATA
    rendered as text by the UI (#9). Validated/bounded by CustomizationConfig."""

    terminology: dict[str, str] = Field(default_factory=dict)


@router.get("/prefs/effective")
async def prefs_effective(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The MERGED customization cascade (ORG defaults ← USER overrides) for the
    caller. Hydrated once by the webui PrefsContext on mount. Plain data (#9)."""
    uid = _prefs_user_id(request, state)
    user_prefs = await state.user_prefs.get(uid)
    return resolve_effective_prefs(state.prefs.customization, user_prefs)


@router.get("/prefs/user")
async def prefs_user_get(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The caller's raw PERSONAL prefs bucket (an empty default when none stored)."""
    uid = _prefs_user_id(request, state)
    prefs = await state.user_prefs.get(uid)
    return prefs.model_dump(mode="json")


@router.put("/prefs/user")
async def prefs_user_put(
    body: UserPrefsPatchBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Patch the caller's PERSONAL prefs (theme, pins, last-list-state, …). Only the
    provided fields change. NOT admin-gated — every user edits only their own bucket."""
    uid = _prefs_user_id(request, state)
    updated = await state.user_prefs.patch(uid, **body.model_dump(exclude_none=True))
    return updated.model_dump(mode="json")


@router.get("/prefs/org", response_model=CustomizationConfig)
async def prefs_org_get(state: AppState = Depends(get_state)) -> CustomizationConfig:
    """The ORG customization defaults (terminology + org saved views + default
    theme). Readable by any signed-in user (the cascade needs them); writing is
    admin-only via PUT."""
    return state.prefs.customization


@router.put("/prefs/org")
async def prefs_org_put(
    body: CustomizationConfig,
    request: Request,
    state: AppState = Depends(get_state),
    _admin=Depends(require_admin),  # ADMIN-ONLY: org defaults are an admin surface
) -> dict[str, Any]:
    """Replace the ORG customization defaults (admin-only). Validated/bounded by
    CustomizationConfig. All free-text is plain data (#9)."""
    def _apply(current):
        if current.read_only_settings_mode:
            raise HTTPException(status_code=403, detail="settings are read-only")
        return current.model_copy(update={"customization": body})

    prefs = await state.mutate_prefs(_apply)
    await state.control_audit.record(
        action_type=ActionType.USER_MGMT, surface="settings",
        actor=current_username(request) or "admin",
        result_summary="updated org customization defaults",
    )
    return prefs.customization.model_dump(mode="json")


@router.get("/terminology")
async def terminology_get(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The ORG terminology label-override map. Readable by any signed-in user (the
    UI ``t(key)`` helper needs it); writing is admin-only via PUT."""
    return {"terminology": dict(state.prefs.customization.terminology)}


@router.put("/terminology")
async def terminology_put(
    body: TerminologyBody,
    request: Request,
    state: AppState = Depends(get_state),
    _admin=Depends(require_admin),  # ADMIN-ONLY: terminology is an org surface
) -> dict[str, Any]:
    """Replace the ORG terminology map (admin-only). Bounded/validated by
    CustomizationConfig. Plain data (#9)."""
    custom: CustomizationConfig | None = None

    def _apply(current):
        nonlocal custom
        if current.read_only_settings_mode:
            raise HTTPException(status_code=403, detail="settings are read-only")
        custom = current.customization.model_copy(
            update={"terminology": dict(body.terminology)}
        )
        # Round-trip through the model so the field validator bounds it.
        custom = CustomizationConfig.model_validate(custom.model_dump())
        return current.model_copy(update={"customization": custom})

    await state.mutate_prefs(_apply)
    assert custom is not None
    await state.control_audit.record(
        action_type=ActionType.USER_MGMT, surface="settings",
        actor=current_username(request) or "admin",
        result_summary="updated terminology",
    )
    return {"terminology": dict(custom.terminology)}


@router.get("/views")
async def views_list(request: Request, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """The caller's PERSONAL saved views PLUS the ORG-shared views (the cascade
    surfaces both; org views carry ``shared:true``)."""
    uid = _prefs_user_id(request, state)
    user_prefs = await state.user_prefs.get(uid)
    merged = resolve_effective_prefs(state.prefs.customization, user_prefs)
    return {"views": merged.get("saved_views", []), "count": len(merged.get("saved_views", []))}


@router.post("/views")
async def views_create(
    body: SavedViewBody, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Create a PERSONAL saved view from the current filter/sort/columns. ``owner``
    is stamped to the caller; ``id`` is server-assigned."""
    uid = _prefs_user_id(request, state)
    view = SavedView(
        name=(body.name or "").strip() or "Untitled view",
        scope=(body.scope or "cases").strip() or "cases",
        owner=uid or "",
        shared=bool(body.shared),
        filters=dict(body.filters or {}),
        sort=body.sort or "",
        columns=body.columns,
    )
    created = await state.user_prefs.add_view(uid, view)
    return created.model_dump(mode="json")


@router.put("/views/{view_id}")
async def views_update(
    view_id: str,
    body: SavedViewPatchBody,
    request: Request,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Edit a PERSONAL saved view (only provided fields change). 404 if missing."""
    uid = _prefs_user_id(request, state)
    updated = await state.user_prefs.update_view(
        uid, view_id, **body.model_dump(exclude_none=True)
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="saved view not found")
    return updated.model_dump(mode="json")


@router.delete("/views/{view_id}")
async def views_delete(
    view_id: str, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Delete a PERSONAL saved view. 404 if missing (org-shared views can't be
    deleted here — they are managed via the org defaults)."""
    uid = _prefs_user_id(request, state)
    ok = await state.user_prefs.delete_view(uid, view_id)
    if not ok:
        raise HTTPException(status_code=404, detail="saved view not found")
    return {"ok": True, "id": view_id}


@router.post("/views/{view_id}/clone")
async def views_clone(
    view_id: str, request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """Clone a view (an org-shared OR personal one) into the caller's PERSONAL set as
    a fresh, owned, non-shared copy. The new view gets a new id + a "(copy)" name."""
    uid = _prefs_user_id(request, state)
    user_prefs = await state.user_prefs.get(uid)
    merged = resolve_effective_prefs(state.prefs.customization, user_prefs)
    src = next((v for v in merged.get("saved_views", []) if v.get("id") == view_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail="saved view not found")
    clone = SavedView(
        name=f"{str(src.get('name') or 'View')} (copy)",
        scope=str(src.get("scope") or "cases"),
        owner=uid or "",
        shared=False,
        filters=dict(src.get("filters") or {}),
        sort=str(src.get("sort") or ""),
        columns=src.get("columns"),
    )
    created = await state.user_prefs.add_view(uid, clone)
    return created.model_dump(mode="json")


class TableStateBody(BaseModel):
    """One table's column state (order / hidden / widths). An empty body clears it
    (the table reverts to its built-in default columns)."""

    order: list[str] = Field(default_factory=list)
    hidden: list[str] = Field(default_factory=list)
    widths: dict[str, int] = Field(default_factory=dict)


@router.put("/prefs/user/tables/{table_id}")
async def prefs_user_table_put(
    table_id: str,
    body: TableStateBody,
    request: Request,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Persist ONE table's column state (show/hide/reorder/width) for the caller. An
    all-empty body clears the override (reverts to the table's default columns)."""
    uid = _prefs_user_id(request, state)
    has_state = bool(body.order or body.hidden or body.widths)
    cs = await state.user_prefs.set_table_state(
        uid, table_id, body.model_dump() if has_state else None
    )
    return {"table_id": table_id, "state": cs.model_dump(mode="json")}
