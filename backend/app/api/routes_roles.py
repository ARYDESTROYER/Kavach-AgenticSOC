"""RBAC custom-role CRUD + permission-UX endpoints (Round 3 / Wave 2, Feature 6).

This router OWNS the *mutating* + *helper* RBAC surface that sits beside the
read-only ``GET /api/roles`` matrix already served by the monolith
(:mod:`app.api.routes`). It is mounted by the integrator with
``app.include_router(router, dependencies=[Depends(require_auth)])`` — no new
``AppState`` wiring is needed (everything it touches — ``custom_roles`` /
``users`` / ``audit`` / ``auth`` / ``prefs`` — landed in Wave 1).

Endpoints
---------
* ``POST   /api/roles``                 — create a custom role.
* ``PUT    /api/roles``                 — update (replace by name) a custom role.
* ``DELETE /api/roles/{name}``          — delete a custom role.
* ``POST   /api/roles/preview``         — resolve a DRAFT role's effective grants +
                                          diff vs the current matrix (no persistence).
* ``GET    /api/roles/simulate``        — ``can()`` outcome for a role × resource × action.
* ``GET    /api/account/permissions``   — the CURRENT user's resolved resource×action
                                          grants (for the webui ``<Can>`` guard).
* ``PUT    /api/users/{username}/roles`` — assign a base role + a set of custom roles
                                          to a user (lockout-proofed; env-admin rejected).

Non-negotiables upheld
----------------------
* **#2**: every RBAC mutation is appended to the append-only audit log, BEFORE it
  becomes visible (Round 14 SPEC §3.6): ``role.created`` / ``role.updated`` /
  ``role.deleted`` and ``user.role_changed`` rows carry the target, what changed
  (grant by grant) and the request's client, session and request id. If the row
  cannot be appended the request answers ``503 audit_unavailable`` and nothing
  changes.
* **#3** — RBAC gates WHO may *call* a close/escalate endpoint; it never touches the
  deterministic ``case_manager.decide()`` decision. Nothing here feeds that path.
* **#9** — role names / descriptions / grant maps are operator-influenceable but are
  returned as PLAIN data (the webui renders them escaped); they are NEVER interpolated
  into an LLM prompt, so no fencing is required here.

A built-in :class:`app.constants.UserRole` name can NEVER be created / mutated / deleted
through this surface (the effective-matrix resolver also drops a shadowing custom role,
so the platform owner can't be locked out). An unknown/deleted role assigned to a user
fails safe to ``default_role`` at resolution time.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..audit.changes import diff_changes
from ..audit.context import audit_context
from ..audit.write import audited_write
from ..constants import ActionType, UserRole
from ..models import CustomRole
from ..rbac.policy import (
    DEFAULT_ROLE,
    RESOURCES,
    can,
    normalise_denies,
    normalise_grants,
    resolve_matrix,
    resolve_runbook_alias,
)
from ..state import AppState
from ..stores.custom_roles import CustomRoleExists, CustomRoleMissing
from .deps import (
    _rbac_config_with_custom_roles,
    current_user,
    current_username,
    get_state,
    require_fresh_auth,
    require_permission,
)

logger = logging.getLogger("tlsoc.api.routes_roles")

router = APIRouter(prefix="/api")

# The six built-in role names — immutable through this surface.
_BASE_ROLE_NAMES: frozenset[str] = frozenset(r.value for r in UserRole)


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #
class CustomRoleBody(BaseModel):
    """A custom-role definition submitted for create/update. Mirrors
    :class:`app.models.CustomRole`; validated + cleaned server-side."""

    name: str = ""
    description: str = ""
    inherits: list[str] = Field(default_factory=list)
    grants: dict[str, list[str]] = Field(default_factory=dict)
    denies: dict[str, list[str]] = Field(default_factory=dict)


class RolePreviewBody(BaseModel):
    """A DRAFT custom role to resolve (no persistence). Same shape as
    :class:`CustomRoleBody`."""

    name: str = ""
    description: str = ""
    inherits: list[str] = Field(default_factory=list)
    grants: dict[str, list[str]] = Field(default_factory=dict)
    denies: dict[str, list[str]] = Field(default_factory=dict)


class UserRolesBody(BaseModel):
    """Assign a base ``role`` and/or a set of ``custom_roles`` (by name) to a user.
    Either may be omitted (None = leave unchanged)."""

    role: str | None = None
    custom_roles: list[str] | None = None


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _validate_custom_role(body: CustomRoleBody | RolePreviewBody) -> CustomRole:
    """Validate a submitted role into a :class:`CustomRole`, rejecting an empty name
    or a name that collides with a built-in role (400). The store + the matrix
    resolver also clean the grant/deny maps, so an unknown resource/action is dropped
    leniently rather than erroring.

    Round 14 (SPEC §3.7): every body this router accepts (create, update, preview) is
    read through the ``playbooks`` -> ``runbooks`` alias here, BEFORE anything could
    clean the retired resource away, so a grant or deny an older client sends is never
    dropped silently: ``playbooks:manage`` becomes ``runbooks:manage`` and
    ``runbooks:publish``, a deny of it denies both. A body is current vocabulary, so a
    ``runbooks:manage`` grant here does NOT imply ``publish`` (that once-only rule is
    for maps stored before Round 14), and a ``runbooks`` entry in the body is
    authoritative: a ``playbooks`` key echoed beside it (the matrix editor still shows
    that row) never widens it back, so a narrowing sticks."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="custom role name is required")
    if name in _BASE_ROLE_NAMES:
        raise HTTPException(
            status_code=409,
            detail=f"'{name}' is a built-in role and cannot be redefined",
        )
    try:
        return CustomRole.model_validate(
            {
                "name": name,
                "description": body.description or "",
                "inherits": list(body.inherits or []),
                "grants": normalise_grants(dict(body.grants or {})),
                "denies": normalise_denies(dict(body.denies or {})),
            }
        )
    except Exception as exc:  # noqa: BLE001 — surface a clean 400 on a malformed body
        raise HTTPException(status_code=400, detail=f"invalid custom role: {exc}") from exc


def _role_doc(role: CustomRole | None) -> dict[str, Any]:
    """A custom role as the audit diff compares it: description, inherited roles and
    the grant and deny maps (actions sorted, so a reorder is not a change)."""
    if role is None:
        return {}
    data = role.model_dump(mode="json")
    return {
        "description": data.get("description") or "",
        "inherits": sorted(str(x) for x in (data.get("inherits") or [])),
        "grants": {k: sorted(v) for k, v in sorted((data.get("grants") or {}).items())},
        "denies": {k: sorted(v) for k, v in sorted((data.get("denies") or {}).items())},
    }


def _role_target(name: str) -> dict[str, str]:
    return {"type": "role", "id": name, "label": name}


async def _audited_rbac_write(
    state: AppState,
    request: Request,
    *,
    action: str,
    target: dict[str, str],
    changes: list[Any],
    summary: str,
    write: Any,
    store_unavailable: dict[str, str] | None = None,
) -> Any:
    """An RBAC change, audit-first (SPEC §3.6): the row (real audit log, never the
    Demo one) is appended before ``write`` runs; a failed append is ``503
    audit_unavailable`` and nothing changes.

    ``store_unavailable`` (``{"code", "message"}``) is the answer when the store write
    itself fails with anything but a domain refusal (an ``HTTPException``): a storage
    outage or an exhausted compare-and-set is then a structured ``503`` instead of a
    bare ``500``, after the failure row has recorded the store's own error."""
    try:
        return await audited_write(
            state,
            sink="control",
            action=action,
            target=target,
            expected_revision=None,
            changes=changes,
            write=write,
            action_type=ActionType.USER_MGMT,
            actor=current_username(request) or "",
            surface="rbac",
            context=audit_context(request),
            result_summary=summary,
        )
    except HTTPException:
        raise
    except Exception as exc:
        if store_unavailable is None:
            raise
        logger.warning("RBAC write %s failed in the store: %s", action, exc)
        raise HTTPException(status_code=503, detail=dict(store_unavailable)) from exc


#: The answer when the custom role store cannot save a change (SPEC §3.6 step 3).
_ROLE_STORE_UNAVAILABLE: dict[str, str] = {
    "code": "role_store_unavailable",
    "message": "The role could not be saved. Try again.",
}


def _draft_rbac_config(rbac: Any, draft: CustomRole):
    """Return a copy of the live RBAC config with ``draft`` UNIONed into its
    ``custom_roles`` (replacing any same-named entry), for a no-persistence preview.
    Degrades to a minimal shape if ``rbac`` is None."""
    draft_json = draft.model_dump(mode="json")
    existing: list[Any] = []
    if rbac is not None:
        existing = list(getattr(rbac, "custom_roles", []) or [])
    needle = draft.name.strip().lower()
    merged = [
        r for r in existing
        if str((r.get("name") if isinstance(r, dict) else getattr(r, "name", "")) or "")
        .strip().lower() != needle
    ]
    merged.append(draft_json)
    if rbac is not None and hasattr(rbac, "model_copy"):
        return rbac.model_copy(update={"custom_roles": merged})
    # No live config object → build a loose dict the resolver accepts.
    return {"custom_roles": merged}


def _grants_for_roles(
    matrix: dict[str, dict[str, list[str]]], role: str, custom_roles: list[str]
) -> dict[str, list[str]]:
    """Union the effective grants of a user's BASE ``role`` with every assigned
    ``custom_roles`` row, resolved against ``matrix``. An unknown/deleted role
    contributes nothing (fail-safe). ``super_admin`` short-circuits to the full
    wildcard grant."""
    if role == UserRole.SUPER_ADMIN.value:
        return {res: ["*"] for res in RESOURCES}
    out: dict[str, list[str]] = {}
    for nm in [role, *custom_roles]:
        grants = matrix.get(str(nm))
        if not grants:
            continue
        for res, acts in grants.items():
            cur = out.setdefault(res, [])
            for a in acts:
                if a not in cur:
                    cur.append(a)
    return out


def _explode_grants(grants: dict[str, list[str]]) -> dict[str, list[str]]:
    """Expand any wildcard ``"*"`` action into the concrete action list for that
    resource, so the webui ``<Can>`` guard can match a literal ``resource:action``
    without re-implementing the wildcard rule."""
    out: dict[str, list[str]] = {}
    for res, acts in grants.items():
        if "*" in acts and res in RESOURCES:
            out[res] = list(RESOURCES[res])
        else:
            out[res] = [a for a in acts if a != "*"]
    return out


# --------------------------------------------------------------------------- #
# Custom-role CRUD
# --------------------------------------------------------------------------- #
@router.post("/roles")
async def create_role(
    body: CustomRoleBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("roles", "manage")),
    __=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Create a custom role. 409 if a custom role with that name already exists or if
    the name shadows a built-in role. Step-up (``require_fresh_auth``) gated — a
    sensitive RBAC change."""
    role = _validate_custom_role(body)
    store = getattr(state, "custom_roles", None)
    if store is None:
        raise HTTPException(status_code=503, detail="custom-role store unavailable")
    if await store.get(role.name) is not None:
        raise HTTPException(status_code=409, detail=f"custom role '{role.name}' already exists")

    async def _create() -> CustomRole:
        # Created by another request while the row was appended: refused inside the
        # store's compare-and-set, so the failure row is written instead of a
        # creation that silently replaced it (and a storage failure raises).
        try:
            return await store.create_if_absent(role)
        except CustomRoleExists as exc:
            raise HTTPException(
                status_code=409, detail=f"custom role '{role.name}' already exists"
            ) from exc

    stored = await _audited_rbac_write(
        state, request, action="role.created", target=_role_target(role.name),
        changes=diff_changes({}, _role_doc(role)),
        summary=f"created custom role '{role.name}'",
        write=_create,
        store_unavailable=_ROLE_STORE_UNAVAILABLE,
    )
    return {"ok": True, "role": stored.model_dump(mode="json")}


@router.put("/roles")
async def update_role(
    body: CustomRoleBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("roles", "manage")),
    __=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Update (replace by name) an existing custom role. 404 if it does not exist.
    Built-in role names are rejected (409). Step-up gated."""
    role = _validate_custom_role(body)
    store = getattr(state, "custom_roles", None)
    if store is None:
        raise HTTPException(status_code=503, detail="custom-role store unavailable")
    existing = await store.get(role.name)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"custom role '{role.name}' not found")

    async def _update() -> CustomRole:
        # Deleted while the row was appended: answered 404 with its failure row. The
        # existence check is decided inside the store's compare-and-set, so a
        # concurrent delete is never undone (an upsert would bring the role back, and
        # with it the grants of every account still holding its name, under a row
        # that says it was only updated).
        try:
            return await store.update_existing(role)
        except CustomRoleMissing as exc:
            raise HTTPException(
                status_code=404, detail=f"custom role '{role.name}' not found"
            ) from exc

    stored = await _audited_rbac_write(
        state, request, action="role.updated", target=_role_target(existing.name),
        changes=diff_changes(_role_doc(existing), _role_doc(role)),
        summary=f"updated custom role '{role.name}'",
        write=_update,
        store_unavailable=_ROLE_STORE_UNAVAILABLE,
    )
    return {"ok": True, "role": stored.model_dump(mode="json")}


@router.delete("/roles/{name}")
async def delete_role(
    name: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("roles", "manage")),
    __=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Delete a custom role by name. Built-in roles cannot be deleted (409). 404 if
    no such custom role. Step-up gated. (Users still holding the name fail safe to
    ``default_role`` at resolution time.)"""
    nm = (name or "").strip()
    if nm in _BASE_ROLE_NAMES:
        raise HTTPException(status_code=409, detail=f"'{nm}' is a built-in role and cannot be deleted")
    store = getattr(state, "custom_roles", None)
    if store is None:
        raise HTTPException(status_code=503, detail="custom-role store unavailable")
    existing = await store.get(nm)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"custom role '{nm}' not found")

    async def _delete() -> bool:
        try:
            await store.delete_strict(nm)
        except CustomRoleMissing as exc:
            # Gone between the read and the delete: the failure row says so.
            raise HTTPException(status_code=404, detail=f"custom role '{nm}' not found") from exc
        return True

    await _audited_rbac_write(
        state, request, action="role.deleted", target=_role_target(existing.name),
        changes=diff_changes(_role_doc(existing), {}),
        summary=f"deleted custom role '{nm}'",
        write=_delete,
        store_unavailable=_ROLE_STORE_UNAVAILABLE,
    )
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Preview + simulate (no persistence)
# --------------------------------------------------------------------------- #
@router.post("/roles/preview")
async def preview_role(
    body: RolePreviewBody,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("roles", "read")),
) -> dict[str, Any]:
    """Resolve a DRAFT custom role's effective ``resource -> [actions]`` grants and a
    diff vs the current matrix, WITHOUT persisting anything. The draft is folded into
    the live RBAC config (custom roles from the store + prefs included) so inheritance
    against operator-tuned built-ins resolves exactly as it would once saved."""
    draft = _validate_custom_role(body)
    rbac = await _rbac_config_with_custom_roles(state)
    current = resolve_matrix(rbac)
    drafted = resolve_matrix(_draft_rbac_config(rbac, draft))
    resolved = drafted.get(draft.name, {})
    before = current.get(draft.name, {})
    # Per-resource added/removed action diff (explode wildcards so the diff is concrete).
    bx = _explode_grants(before)
    ax = _explode_grants(resolved)
    diff: dict[str, dict[str, list[str]]] = {}
    for res in sorted(set(bx) | set(ax)):
        b = set(bx.get(res, []))
        a = set(ax.get(res, []))
        added = sorted(a - b)
        removed = sorted(b - a)
        if added or removed:
            diff[res] = {"added": added, "removed": removed}
    return {
        "name": draft.name,
        "resolved": resolved,          # role -> resource -> [actions] (this role's row)
        "effective": _explode_grants(resolved),  # wildcards exploded, for a literal Can match
        "diff": diff,                  # resource -> {added, removed}
        "is_new": draft.name not in current,
    }


@router.get("/roles/simulate")
async def simulate_permission(
    role: str,
    resource: str,
    action: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("roles", "read")),
) -> dict[str, Any]:
    """The ``can()`` outcome for a ``role`` × ``resource`` × ``action`` against the
    current effective matrix (built-ins + operator overrides + stored custom roles).
    Returns ``allowed`` plus the role's resolved actions on that resource so the UI can
    explain WHY.

    Round 14 (SPEC §3.7): the retired ``playbooks`` resource is still an accepted
    alias of ``runbooks`` in every grant layer, so a question about it is answered for
    its ``runbooks`` meaning (``alias_of`` names the resource that was evaluated), never
    a silent "denied" for a resource the server no longer lists."""
    rbac = await _rbac_config_with_custom_roles(state)
    matrix = resolve_matrix(rbac)
    evaluated_resource, evaluated_action = resolve_runbook_alias(resource, action)
    allowed = can(role, evaluated_resource, evaluated_action, matrix=matrix)
    actions = (matrix.get(str(role), {}) or {}).get(evaluated_resource, [])
    known_resource = evaluated_resource in RESOURCES
    return {
        "role": role,
        "resource": resource,
        "action": action,
        "allowed": bool(allowed),
        "actions": list(actions),
        "known_resource": known_resource,
        "alias_of": evaluated_resource if evaluated_resource != resource else None,
        "role_exists": str(role) in matrix or str(role) == UserRole.SUPER_ADMIN.value,
    }


# --------------------------------------------------------------------------- #
# The current user's resolved permissions (for the webui <Can> guard)
# --------------------------------------------------------------------------- #
@router.get("/account/permissions")
async def account_permissions(
    request: Request, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """The CURRENT caller's resolved ``resource -> [actions]`` grants — the data the
    webui ``<Can>`` guard checks against.

    Three back-compat modes mirror the server gates:
      * auth DISABLED          → super_admin (full wildcard) so every surface unlocks.
      * auth ON, rbac OFF      → super_admin (authenticated == super_admin).
      * auth ON, rbac ON       → the principal's base role UNIONed with any custom
                                 roles assigned to the user (resolved against the live
                                 matrix). An env single-admin (no persisted record)
                                 resolves to its synced role.

    Wildcards are exploded into concrete actions so the guard can match a literal
    ``resource:action`` without re-implementing the wildcard rule. Auth-gated only
    (any authenticated principal may read its OWN permissions)."""
    auth = getattr(state, "auth", None)
    rbac = getattr(state.prefs, "rbac", None)
    rbac_enabled = bool(getattr(rbac, "enabled", False))
    full = {res: ["*"] for res in RESOURCES}

    # auth off OR rbac off → super_admin everywhere.
    if auth is None or not auth.is_enabled or not rbac_enabled:
        return {
            "authenticated": auth is not None and auth.is_enabled,
            "role": UserRole.SUPER_ADMIN.value,
            "custom_roles": [],
            "rbac_enabled": rbac_enabled,
            "permissions": _explode_grants(full),
        }

    principal = current_user(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="authentication required")

    rbac_cfg = await _rbac_config_with_custom_roles(state)
    matrix = resolve_matrix(rbac_cfg)
    base_role = getattr(principal, "role", "") or DEFAULT_ROLE
    # Per-user assigned custom roles ride in the user's prefs bag (User has no
    # first-class field this wave). The env single-admin has no persisted record →
    # no custom roles → base role only.
    assigned: list[str] = []
    try:
        user = await state.users.get(principal.username)
    except Exception:  # noqa: BLE001
        user = None
    if user is not None:
        raw = (user.prefs or {}).get("custom_roles")
        if isinstance(raw, list):
            assigned = [str(x) for x in raw if str(x) in matrix and str(x) not in _BASE_ROLE_NAMES]

    grants = _grants_for_roles(matrix, str(base_role), assigned)
    return {
        "authenticated": True,
        "role": str(base_role),
        "custom_roles": assigned,
        "rbac_enabled": True,
        "permissions": _explode_grants(grants),
    }


# --------------------------------------------------------------------------- #
# Assign roles to a user (base role + custom roles)
# --------------------------------------------------------------------------- #
_VALID_BASE_ROLES = {r.value for r in UserRole}


async def _users_manage_holders(state: AppState) -> list[Any]:
    """Every ACTIVE persisted user whose EFFECTIVE grants include ``users:manage`` —
    used for the last-admin lockout guard. Resolves each user's base role (+ assigned
    custom roles) against the live matrix."""
    rbac_cfg = await _rbac_config_with_custom_roles(state)
    matrix = resolve_matrix(rbac_cfg)
    out: list[Any] = []
    try:
        users = await state.users.list()
    except Exception:  # noqa: BLE001
        return out
    for u in users:
        if not getattr(u, "active", False):
            continue
        role = u.role.value if isinstance(u.role, UserRole) else str(u.role)
        assigned = [
            str(x) for x in ((u.prefs or {}).get("custom_roles") or [])
            if isinstance((u.prefs or {}).get("custom_roles"), list)
        ]
        grants = _grants_for_roles(matrix, role, assigned)
        if can("", "users", "manage", matrix={"": grants}) or role == UserRole.SUPER_ADMIN.value:
            out.append(u)
    return out


@router.put("/users/{username}/roles")
async def assign_user_roles(
    username: str,
    body: UserRolesBody,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("users", "manage")),
    __=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Assign a base ``role`` and/or a list of ``custom_roles`` (by name) to a user.

    * The base role must be one of the six built-ins (400 otherwise).
    * Each custom role must currently EXIST in the resolved matrix (unknown names are
      rejected 400 — a deleted role would otherwise silently fail-safe to default).
    * The env single-admin (a session with no persisted ``User`` record) is rejected
      400 — it is environment-managed and cannot be edited here.
    * LOCKOUT GUARD: the change may not remove the LAST holder of ``users:manage`` —
      if this user is currently the only effective ``users:manage`` holder and the
      requested change would drop that grant, it is rejected 409.

    Persists ``role`` directly and the assigned ``custom_roles`` inside the user's
    ``prefs`` bag (User has no first-class field this wave). Audited (#2)."""
    target = await state.users.get(username)
    if target is None:
        raise HTTPException(
            status_code=400,
            detail="user not found or environment-managed (cannot assign roles here)",
        )

    rbac_cfg = await _rbac_config_with_custom_roles(state)
    matrix = resolve_matrix(rbac_cfg)

    patch: dict[str, Any] = {}
    new_role = target.role.value if isinstance(target.role, UserRole) else str(target.role)
    if body.role is not None:
        if body.role not in _VALID_BASE_ROLES:
            raise HTTPException(status_code=400, detail=f"unknown role: {body.role}")
        new_role = body.role
        patch["role"] = body.role

    existing_custom = list((target.prefs or {}).get("custom_roles") or [])
    new_custom = existing_custom
    if body.custom_roles is not None:
        cleaned: list[str] = []
        for nm in body.custom_roles:
            nm_s = str(nm).strip()
            if not nm_s:
                continue
            if nm_s in _BASE_ROLE_NAMES:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{nm_s}' is a built-in role, not a custom role",
                )
            if nm_s not in matrix:
                raise HTTPException(status_code=400, detail=f"unknown custom role: {nm_s}")
            if nm_s not in cleaned:
                cleaned.append(nm_s)
        new_custom = cleaned
        merged_prefs = dict(target.prefs or {})
        merged_prefs["custom_roles"] = cleaned
        patch["prefs"] = merged_prefs

    if not patch:
        raise HTTPException(status_code=400, detail="no changes provided")

    # SUPER-ADMIN ORPHAN GUARD — the last active super_admin can never be demoted out
    # of the super_admin role through this surface (mirrors the sibling guard on
    # ``PUT/DELETE /api/users/{u}`` in routes.py). This is ORTHOGONAL to the generic
    # users:manage last-holder guard below and protects a DIFFERENT invariant: even a
    # second users:manage holder (e.g. a soc_manager) must not be able to silently
    # strip the platform's last super_admin of its wildcard authority. (#3-irrelevant:
    # RBAC only gates WHO may call privileged endpoints; it never touches decide().)
    from .routes import _would_orphan_super_admin

    demoting_sa = body.role is not None and new_role != UserRole.SUPER_ADMIN.value
    if await _would_orphan_super_admin(state, target, demoting=demoting_sa, disabling=False):
        raise HTTPException(
            status_code=409, detail="cannot demote the last active super_admin"
        )

    # LOCKOUT GUARD — would this change drop the last effective users:manage holder?
    would_grants = _grants_for_roles(matrix, new_role, new_custom)
    still_manages = (
        new_role == UserRole.SUPER_ADMIN.value
        or can("", "users", "manage", matrix={"": would_grants})
    )
    if not still_manages:
        holders = await _users_manage_holders(state)
        holder_names = {str(getattr(h, "username", "")).strip().lower() for h in holders}
        target_key = str(target.username).strip().lower()
        if holder_names == {target_key}:
            raise HTTPException(
                status_code=409,
                detail="cannot remove the last user who can manage users (users:manage)",
            )

    async def _write() -> Any:
        # Only the store write is the audited unit: the synced view is refreshed
        # after it, so a refresh error never pairs a saved change with a
        # "not applied" row. An account deleted while the row was appended answers
        # 404, so its failure row is written instead of a success that never happened.
        fields = dict(patch)
        if "prefs" in fields:
            # Only the custom-role assignment is this route's: the rest of the
            # preference bag is read now, so a personal preference the account saved
            # while the row was appended is kept, not reverted.
            fresh = await state.users.get(username)
            if fresh is None:
                raise HTTPException(status_code=404, detail="user not found")
            fields["prefs"] = {**(fresh.prefs or {}), "custom_roles": list(new_custom)}
        updated = await state.users.update(username, **fields)
        if updated is None:
            raise HTTPException(status_code=404, detail="user not found")
        return updated

    old_role = target.role.value if isinstance(target.role, UserRole) else str(target.role)
    updated = await _audited_rbac_write(
        state, request, action="user.role_changed",
        target={"type": "user", "id": target.username,
                "label": getattr(target, "display_name", "") or target.username},
        changes=diff_changes(
            {"role": old_role, "custom_roles": list(existing_custom)},
            {"role": new_role, "custom_roles": list(new_custom)},
        ),
        summary=f"assigned roles to '{username}': role={new_role} custom={new_custom}",
        write=_write,
    )
    await state.refresh_users()
    # Round 12 final review (L1): a running chat answer that relied on a grant this
    # change removed stops now (one that only gained grants keeps running).
    from .routes_chat import recheck_chat_turns_for

    await recheck_chat_turns_for(state, username)
    return {"ok": True, "user": (updated or target).public(), "custom_roles": new_custom}
