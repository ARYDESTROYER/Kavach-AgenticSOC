"""The role-based access switch (Round 15 SPEC D1.2).

``rbac.enabled`` decides whether roles mean anything: while it is off, every signed-in
account is treated as Super admin (``deps.access_view_for``). Before Round 15 the only
way to change it was a raw ``PUT /api/settings``, which any ``settings:manage`` holder
could send without a fresh sign-in. This router is now its one home, used by the
"Role-based access" panel on Roles & permissions:

* ``GET /api/rbac`` (``roles:read``): the state, whether the caller may change it and
  why not (``blockers``), the caller's stored role, the count of active Super admins
  and, for a caller holding ``users:manage``, the active accounts per role.
* ``PUT /api/rbac`` ``{"enabled": bool}``: the rules below, checked in this order:

  1. sign-in off: ``409 rbac_auth_required`` (role-based access has no effect then);
  2. a strict fresh sign-in (:func:`require_strict_fresh_sign_in`): a registered
     session with a known recent sign-in or re-authentication; a missing or unknown
     session id, or a session-store failure, answers ``401 reauth_required``;
  3. the verified principal's stored role is ``super_admin`` (whatever ``rbac.enabled``
     says, so RBAC-off mode never elevates here), else ``403 rbac_super_admin_only``
     with an Access denied row;
  4. read-only settings mode: ``403 "Settings are in read-only mode"``, exactly as
     ``PUT /api/settings`` answers (there is no unlock body here);
  5. turning on needs at least one active Super admin account: a persisted one, or the
     environment administrator (configured, with no persisted user of that name);
  6. no change: ``200`` with ``changed: false`` and no audit row;
  7. otherwise ``audited_prefs_write`` (action ``settings.updated``, target "RBAC",
     ``changes`` ``rbac.enabled`` before and after): audit before visible, ``409
     settings_conflict`` after its retries, ``503 audit_unavailable``.

Demo Mode does not change any of this: the switch writes the real ``Preferences`` and
the control audit (settings are never Demo-swapped). Nothing here makes a model call
(#6) or touches ``decide()`` (#3); RBAC only decides who may call an endpoint.

``PUT /api/settings`` refuses a changed ``rbac.enabled`` with ``409 rbac_switch_moved``
and asks ``roles:manage`` plus a fresh sign-in for any other ``rbac.*`` change (SPEC
D1.3, ``routes._guard_rbac_settings_change``), so this route is the only way to flip it.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from ..audit.context import audit_context
from ..audit.prefs_write import audited_prefs_write
from ..constants import UserRole
from ..state import AppState
from ..utils import parse_es_timestamp
from .deps import (
    _bearer,
    current_user,
    get_state,
    has_permission,
    record_access_denied,
    require_fresh_auth,
    require_permission,
)

logger = logging.getLogger("tlsoc.api.rbac")
router = APIRouter(prefix="/api", tags=["rbac"])

#: The refusal reasons ``GET /api/rbac`` reports in ``blockers`` (a closed vocabulary;
#: the Console words each one).
BLOCKER_AUTH_OFF = "auth_off"
BLOCKER_NOT_SUPER_ADMIN = "not_super_admin"
BLOCKER_READ_ONLY = "read_only_settings"

AUTH_REQUIRED_MESSAGE = (
    "Turn on sign-in first. Role-based access has no effect while sign-in is off."
)
SUPER_ADMIN_ONLY_MESSAGE = "Only a Super admin can turn role-based access on or off."
NO_SUPER_ADMIN_MESSAGE = (
    "Role-based access needs at least one active Super admin account before it can be "
    "turned on."
)
READ_ONLY_DETAIL = "Settings are in read-only mode"


class RbacStatus(BaseModel):
    """The state of role-based access, as ``GET /api/rbac`` reports it."""

    enabled: bool = Field(description="Whether role-based access is on (``rbac.enabled``).")
    auth_enabled: bool = Field(description="Whether sign-in is on. Without it roles have no effect.")
    can_change: bool = Field(description="Whether the caller may turn it on or off now (no blockers).")
    blockers: list[str] = Field(
        default_factory=list,
        description="Why the caller may not change it: auth_off, not_super_admin, read_only_settings.",
    )
    caller_role: str = Field(
        default="",
        description="The caller's stored role, even while role-based access is off (empty with sign-in off).",
    )
    super_admin_count: int = Field(
        default=0,
        description=(
            "Active Super admin accounts: persisted ones, plus the environment administrator "
            "when it is configured and no persisted user has its name."
        ),
    )
    role_counts: dict[str, int] | None = Field(
        default=None,
        description=(
            "Active accounts per stored role (environment accounts included). Only for a "
            "caller holding users:manage; null otherwise."
        ),
    )


class RbacUpdateResult(RbacStatus):
    """The answer to ``PUT /api/rbac``: the new state and whether it changed."""

    changed: bool = Field(description="False when role-based access was already in the requested state.")


class RbacUpdate(BaseModel):
    """``PUT /api/rbac``: the requested state. A JSON boolean only."""

    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool


class _Unchanged(Exception):
    """The stored state already is the requested one (rule 6, seen under the lock)."""


def _role_value(role: Any) -> str:
    return str(getattr(role, "value", role) or "")


def _norm(name: Any) -> str:
    return str(name or "").strip().lower()


def _reauth(reason: str, window: int) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"code": "reauth_required", "reason": reason, "window": window},
    )


def _signed_in_without_authentication(row: dict[str, Any]) -> bool:
    """A session row the ordinary auth gate registered on first sight of a validly
    signed token (``deps._lazy_register``): no sign-in route created it (no
    ``mfa_method``) and nobody has re-authenticated on it since (``last_authn_at`` is
    still its registration time). Its "authentication time" is when the server first
    saw the token, not when a person proved who they are, so it is not fresh here."""
    if str(row.get("mfa_method", "") or "").strip():
        return False
    created = parse_es_timestamp(row.get("created_at"))
    authn = parse_es_timestamp(row.get("last_authn_at"))
    if authn is None:
        return True
    return created is not None and authn <= created


async def require_strict_fresh_sign_in(request: Request, state: AppState) -> None:
    """Rule 2: a registered session with a known recent (re-)authentication.

    Stricter than :func:`deps.require_fresh_auth`, which treats a missing or unknown
    session id and a session-store failure as fresh for compatibility: here each of
    them answers ``401 reauth_required``, so the Console's sign-in-again dialog opens
    and a successful re-authentication (``POST /api/auth/reauth``) unlocks the retry.
    The session must belong to the caller, carry the current token version, be active
    under the live idle and absolute limits, and have been signed in or re-authenticated
    within ``session_policy.sudo_reauth_window`` (the same registry read the durable
    jobs use, ``SessionStore.strict_deferred_authority_expires_at``). A no-op with
    sign-in off (the callers answer that case first)."""
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return
    policy = getattr(state.prefs, "session_policy", None)
    window = int(getattr(policy, "sudo_reauth_window", 600) or 600)
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    claims = auth.claims_of(token) or {}
    sid = str(claims.get("sid", "") or "")
    raw_tv = claims.get("tv", -1)
    try:
        tv = -1 if isinstance(raw_tv, bool) else int(raw_tv)
    except (TypeError, ValueError):
        tv = -1
    sessions = getattr(state, "sessions", None)
    if not sid or tv < 0 or sessions is None:
        raise _reauth("registered_session_required", window)
    from ..auth.session_limits import limits_for_username

    try:
        expires_at = await sessions.strict_deferred_authority_expires_at(
            sid=sid,
            username=user.username,
            token_version=tv,
            sudo_window=window,
            **limits_for_username(state, user.username).kwargs(),
        )
        row = await sessions.get(sid)
    except Exception as exc:
        logger.warning("Session registry unavailable for a fresh sign-in check: %s", exc)
        raise _reauth("session_store_unavailable", window) from exc
    if expires_at is None:
        raise _reauth("stale_authn", window)
    if not isinstance(row, dict) or _signed_in_without_authentication(row):
        raise _reauth("authn_time_unknown", window)


def _environment_accounts(state: AppState) -> dict[str, str]:
    """The environment accounts (``auth_users`` and the single environment
    administrator) by lower-cased name, with the role the auth service gives each:
    Super admin for the administrator, the default role for the others. Read from the
    configured names, never by hashing a password."""
    secrets = state.secrets
    admin = _norm(getattr(secrets, "auth_admin_username", ""))
    out: dict[str, str] = {}
    for name in (getattr(secrets, "auth_users", None) or {}):
        key = _norm(name)
        if key:
            out[key] = UserRole.SUPER_ADMIN.value if key == admin else UserRole.ANALYST_TIER1.value
    if admin and getattr(secrets, "auth_admin_password", None):
        out.setdefault(admin, UserRole.SUPER_ADMIN.value)
    return out


async def _account_roles(state: AppState) -> list[str]:
    """The stored role of every active account: persisted users, then the environment
    accounts no persisted user overrides. A store read that fails yields the persisted
    part as empty (``UserStore`` reads are fail-soft)."""
    users = getattr(state, "users", None)
    persisted = list(await users.list()) if users is not None else []
    names = {_norm(u.username) for u in persisted}
    roles = [_role_value(u.role) for u in persisted if getattr(u, "active", False)]
    roles += [role for name, role in _environment_accounts(state).items() if name not in names]
    return roles


async def _status(request: Request, state: AppState) -> RbacStatus:
    auth = getattr(state, "auth", None)
    auth_enabled = bool(auth is not None and auth.is_enabled)
    # The router-wide auth gate already checked the session; this reads its principal.
    user = current_user(request) if auth_enabled else None
    caller_role = _role_value(getattr(user, "role", "")) if user is not None else ""
    blockers: list[str] = []
    if not auth_enabled:
        blockers.append(BLOCKER_AUTH_OFF)
    elif caller_role != UserRole.SUPER_ADMIN.value:
        blockers.append(BLOCKER_NOT_SUPER_ADMIN)
    if state.prefs.read_only_settings_mode:
        blockers.append(BLOCKER_READ_ONLY)
    roles = await _account_roles(state)
    counts: dict[str, int] | None = None
    if await has_permission(request, "users", "manage"):
        counts = {}
        for role in roles:
            counts[role] = counts.get(role, 0) + 1
    return RbacStatus(
        enabled=bool(state.prefs.rbac.enabled),
        auth_enabled=auth_enabled,
        can_change=not blockers,
        blockers=blockers,
        caller_role=caller_role,
        super_admin_count=sum(1 for role in roles if role == UserRole.SUPER_ADMIN.value),
        role_counts=counts,
    )


@router.get("/rbac", response_model=RbacStatus)
async def get_rbac(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("roles", "read")),
) -> RbacStatus:
    """Whether role-based access is on and whether the caller may change it."""
    return await _status(request, state)


@router.put("/rbac", response_model=RbacUpdateResult)
async def put_rbac(
    body: RbacUpdate,
    request: Request,
    state: AppState = Depends(get_state),
    # The declared gate. A no-op with sign-in off (rule 1 answers that case below), and a
    # stale session answers the same 401 rule 2 gives; the body adds the strict check.
    _fresh=Depends(require_fresh_auth()),
) -> RbacUpdateResult:
    """Turn role-based access on or off (module doc, rules 1 to 7)."""
    auth = getattr(state, "auth", None)
    # Rule 1.
    if auth is None or not auth.is_enabled:
        raise HTTPException(
            status_code=409,
            detail={"code": "rbac_auth_required", "message": AUTH_REQUIRED_MESSAGE},
        )
    # Rule 2.
    await require_strict_fresh_sign_in(request, state)
    user = current_user(request)
    if user is None:  # pragma: no cover - the auth gate and rule 2 both ran
        raise HTTPException(status_code=401, detail="authentication required")
    # Rule 3: the stored role from the verified token (``AuthService.verify``), never
    # the RBAC-off "everyone is Super admin" view.
    role = _role_value(getattr(user, "role", ""))
    if role != UserRole.SUPER_ADMIN.value:
        await record_access_denied(request, "role:super_admin")
        raise HTTPException(
            status_code=403,
            detail={"code": "rbac_super_admin_only", "message": SUPER_ADMIN_ONLY_MESSAGE},
        )
    # Rule 4.
    if state.prefs.read_only_settings_mode:
        raise HTTPException(status_code=403, detail=READ_ONLY_DETAIL)
    want = bool(body.enabled)
    # Rule 5.
    if want and not bool(state.prefs.rbac.enabled):
        roles = await _account_roles(state)
        if UserRole.SUPER_ADMIN.value not in roles:
            raise HTTPException(
                status_code=409,
                detail={"code": "rbac_no_super_admin", "message": NO_SUPER_ADMIN_MESSAGE},
            )
    # Rule 6, before the audited write (which appends a row even when nothing changes).
    if bool(state.prefs.rbac.enabled) == want:
        status = await _status(request, state)
        return RbacUpdateResult(**status.model_dump(), changed=False)

    def _transform(current: Any) -> Any:
        # Re-checked on the document the settings lock hands the write.
        if current.read_only_settings_mode:
            raise HTTPException(status_code=403, detail=READ_ONLY_DETAIL)
        if bool(current.rbac.enabled) == want:
            raise _Unchanged()
        return current.model_copy(
            update={"rbac": current.rbac.model_copy(update={"enabled": want})}
        )

    # Rule 7.
    changed = True
    try:
        await audited_prefs_write(
            state,
            transform=_transform,
            actor=str(user.username),
            context=audit_context(request),
            summary=f"role-based access turned {'on' if want else 'off'}",
            surface="rbac",
        )
    except _Unchanged:
        # Another save made the same change between the check and the lock.
        changed = False
    status = await _status(request, state)
    return RbacUpdateResult(**status.model_dump(), changed=changed)


__all__ = [
    "BLOCKER_AUTH_OFF",
    "BLOCKER_NOT_SUPER_ADMIN",
    "BLOCKER_READ_ONLY",
    "RbacStatus",
    "RbacUpdate",
    "RbacUpdateResult",
    "require_strict_fresh_sign_in",
    "router",
]
