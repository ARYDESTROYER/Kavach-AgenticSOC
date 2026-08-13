"""Request dependencies: access to the singleton AppState + the auth gate."""

from __future__ import annotations

import posixpath
import re

from fastapi import HTTPException, Request

from ..state import AppState

# Routes reachable WITHOUT a session even when auth is enabled. Kept deliberately
# tiny (deny-by-default). Matched against the NORMALISED path (so `//`, `.`, `..`
# tricks can't smuggle a protected route past the allowlist).
PUBLIC_API_PATHS = frozenset(
    {
        "/api/health",
        "/api/health/live",
        "/api/health/ready",
        "/api/health/build-info",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/me",
        # OOBE first-run: status is needed to render the login/setup screen before a
        # session exists; ``/api/setup/account`` (Round-4 Wave-4, routes_setup.py) is
        # the SOLE OOBE writer that creates the first user, and is itself guarded (it
        # 409/403s once any user exists / setup is complete) AND policy-enforced
        # (server-side strong-password gate). The legacy weaker ``/api/setup/init-admin``
        # was REMOVED (H4 / FINDING #11) — no second, policy-bypassing bootstrap path.
        "/api/setup/status",
        "/api/setup/account",
        # Wave 2 — login-phase-2 + SSO bootstrap. Each is itself guarded by a
        # single-use token/state (NOT a full session), so they are reachable before a
        # session exists WITHOUT weakening deny-by-default:
        #   * mfa/verify   — gated by the short-lived pending_token (mfa:"pending").
        #   * sso/providers — read-only list of ENABLED providers (no secrets).
        #   * sso/authorize — builds the IdP redirect (stashes single-use state/nonce).
        #   * sso/callback  — validates state, exchanges the code server-side.
        "/api/auth/mfa/verify",
        "/api/auth/sso/providers",
        "/api/auth/sso/authorize",
        "/api/auth/sso/callback",
        # Wave 3 — refresh is self-authenticating via the refresh token (the ACCESS
        # token may already have expired), so it must be reachable WITHOUT a live
        # access session. It is itself guarded by the opaque refresh-token match +
        # reuse detection, NOT a session — so it doesn't weaken deny-by-default.
        "/api/auth/refresh",
    }
)
# Public for GET ONLY (read-only, non-sensitive) — e.g. branding so the login
# screen can render the org logo before a session exists. Writes stay protected.
PUBLIC_GET_PATHS = frozenset({"/api/branding"})
# The inbound ingest receivers self-authenticate (bearer / HMAC inside the
# receiver). Allow ONLY the exact one-segment receiver route shape — not a loose
# prefix — so a future nested route under /api/ingest can't be made public by
# accident. (Also guarded by test_route_auth_coverage.)
_PUBLIC_INGEST_RE = re.compile(r"^/api/ingest/[^/]+$")


def get_state(request: Request) -> AppState:
    state: AppState | None = getattr(request.app.state, "tlsoc", None)
    if state is None:  # pragma: no cover - only before startup
        raise RuntimeError("AppState not initialised")
    return state


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return None


async def require_auth(request: Request):
    """Auth gate applied to the whole /api router.

    A strict NO-OP when auth is disabled (the default — the "old version" without
    auth). When enabled, every /api route requires a valid JWT (cookie ``tlsoc_token``
    or ``Authorization: Bearer``) EXCEPT the small public allowlist; otherwise 401.
    Deny-by-default: a new route is protected automatically (verified by the CI
    route-coverage test).

    Wave 3: once ``verify()`` returns a principal (the JWT signature is the root of
    trust), an ADDITIONAL async session check enforces the SessionStore registry:
    revocation, per-user token_version, and idle/absolute expiry. CRITICAL
    back-compat — the check DENIES only on an explicit negative signal (the sid is
    REVOKED, the stamped ``tv`` no longer matches the user's current version, or the
    session is past idle/absolute expiry). An UNKNOWN sid on a validly-signed token
    is LAZILY REGISTERED (first-seen) and ALLOWED, so a token minted directly via
    ``authenticate()``/``mint_session`` (without a route's session-create hook) keeps
    working. ``last_active`` is best-effort touched (only when >60s stale)."""
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return None
    # Normalise before matching so `/api//health`, `/api/x/../health`, trailing
    # slashes, etc. cannot bypass (or be mistaken for) the public allowlist.
    path = posixpath.normpath(request.url.path)
    if path in PUBLIC_API_PATHS or _PUBLIC_INGEST_RE.match(path):
        return None
    if request.method == "GET" and path in PUBLIC_GET_PATHS:
        return None
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    await _session_check(request, state, auth, user, token)
    return user


# Map a SessionStore rejection reason → the {code} surfaced on the 401 body.
_SESSION_REASON_CODE = {
    "revoked": "session_invalid",
    "tv_mismatch": "reauth_required",
    "absolute_expired": "session_expired",
    "idle_expired": "session_expired",
    "unknown": "session_invalid",
}


async def _session_check(request: Request, state: AppState, auth, user, token: str | None) -> None:
    """The Wave-3 async session-registry check (see :func:`require_auth`).

    DENIES only on an explicit negative signal; an unknown sid is lazily registered
    and allowed. Best-effort: a SessionStore I/O failure NEVER hard-denies a
    validly-signed token (the JWT remains the root of trust) — it is logged and the
    request proceeds, so a transient store glitch can't lock everyone out."""
    sessions = getattr(state, "sessions", None)
    if sessions is None:
        return
    sid = getattr(user, "sid", None)
    if not sid:
        return  # a token minted before sessions existed — never reject for it (#back-compat)
    policy = getattr(getattr(state, "prefs", None), "session_policy", None)
    idle = int(getattr(policy, "idle_timeout", 0) or 0)
    absolute = int(getattr(policy, "absolute_lifetime", 0) or 0)
    # Once the factory boundary closes, even an authenticated GET must be
    # read-only: the normal compatibility path touches known rows and lazily creates
    # unknown signed sessions. Validate one strict snapshot instead and fail closed
    # without either mutation. This also covers the narrowly allowed recovery POSTs.
    if bool(getattr(getattr(state, "mutation_gate", None), "closed", False)):
        claims = auth.claims_of(token) if token else None
        stamped_tv = int((claims or {}).get("tv", 0) or 0)
        try:
            reason = await sessions.strict_request_authority(
                sid=sid,
                username=user.username,
                token_version=stamped_tv,
                idle_timeout=idle,
                absolute_lifetime=absolute,
            )
        except Exception as exc:  # storage uncertainty cannot cross reset boundary
            raise HTTPException(
                status_code=503,
                detail={"code": "session_registry_unavailable"},
            ) from exc
        if reason is not None:
            code = _SESSION_REASON_CODE.get(reason, "session_invalid")
            raise HTTPException(
                status_code=401, detail={"code": code, "reason": reason}
            )
        return
    try:
        row = await sessions.get(sid)
        # token_version (tv) check — a revoke-all bumps the user's tv so an old token
        # is rejected even if its sid row is unknown/pruned.
        claims = auth.claims_of(token) if token else None
        stamped_tv = int((claims or {}).get("tv", 0) or 0)
        current_tv = await sessions.token_version_for(user.username)
        if stamped_tv < current_tv:
            raise HTTPException(
                status_code=401, detail={"code": "reauth_required", "reason": "tv_mismatch"}
            )
        if row is None:
            # UNKNOWN sid on a validly-signed token → lazily register (first-seen) and
            # ALLOW. This keeps direct-mint tokens (auth tests, mint_session without a
            # route hook) working. The JWT signature already vouched for it.
            await _lazy_register(request, state, sessions, user, sid, stamped_tv, idle, absolute)
            return
        reason = sessions.is_active(row, idle_timeout=idle, absolute_lifetime=absolute)
        if reason is not None:
            code = _SESSION_REASON_CODE.get(reason, "session_invalid")
            raise HTTPException(status_code=401, detail={"code": code, "reason": reason})
        # Best-effort touch (only writes when >60s stale).
        try:
            await sessions.touch(sid, idle_timeout=idle)
        except Exception:  # noqa: BLE001
            pass
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — a store glitch must not lock everyone out
        import logging

        logging.getLogger("tlsoc.api.deps").warning("session check soft-failed: %s", exc)


async def _lazy_register(request: Request, state: AppState, sessions, user, sid: str,
                         tv: int, idle: int, absolute: int) -> None:
    """First-seen registration of an unknown-but-validly-signed sid. Records the
    session with best-effort request metadata + audits the create (#2). Never raises
    into the caller."""
    meta: dict[str, str] = session_metadata(request)
    try:
        await sessions.create(
            sid=sid, username=user.username, token_version=int(tv),
            idle_timeout=idle, absolute_lifetime=absolute,
            **meta,
        )
        await _audit_session(state, "session_register", user.username, sid,
                             "lazy first-seen session registration")
    except Exception:  # noqa: BLE001
        pass


def session_metadata(request: Request) -> dict[str, str]:
    """Extract PLAIN per-session metadata (ip + best-effort geo + parsed UA) from a
    request (#9 — rendered as text, never an LLM prompt input). Used by both the
    lazy-register path here and the explicit session-create hooks in routes. Never
    raises — degrades to empty strings."""
    try:
        from ..state import client_ip_from, geo_for_ip, parse_user_agent

        ip = client_ip_from(request)
        ua_raw = (request.headers.get("user-agent") or "")[:512]
        ua = parse_user_agent(ua_raw)
        geo = geo_for_ip(ip)
        return {
            "ip": ip, "ua_raw": ua_raw,
            "ua_browser": ua.get("ua_browser", ""), "ua_os": ua.get("ua_os", ""),
            "client_type": ua.get("client_type", ""),
            "ip_city": geo.get("ip_city", ""), "ip_country": geo.get("ip_country", ""),
        }
    except Exception:  # noqa: BLE001
        return {}


async def _audit_session(state: AppState, event: str, actor: str, sid: str, detail: str) -> None:
    """Append-only audit of a session lifecycle event (#2). Best-effort."""
    audit = getattr(state, "control_audit", None)
    if audit is None:
        return
    try:
        from ..constants import ActionType

        await audit.record(
            action_type=ActionType.AUTH_EVENT, surface="session", actor=actor or "",
            result_summary=f"{event} sid={_sid_tag(sid)} {detail}".strip(),
        )
    except Exception:  # noqa: BLE001
        pass


def _sid_tag(sid: str) -> str:
    """A short, non-reversible tag for a sid in audit text (avoid logging the full
    session id verbatim while keeping it correlatable)."""
    s = str(sid or "")
    return (s[:8] + "…") if len(s) > 8 else s


def current_user(request: Request):
    """The authenticated :class:`app.auth.service.AuthUser` for this request, or
    ``None`` when auth is disabled OR no valid session is presented. Best-effort:
    never raises (use :func:`require_auth` / :func:`require_permission` to ENFORCE).
    Carries ``role`` + ``must_change_password`` for callers that want to branch on
    the principal without gating."""
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return None
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    return auth.verify(token) if token else None


def current_username(request: Request) -> str:
    """Best-effort username of the requester (``""`` when auth is disabled — the
    default no-auth profile). Used to attribute proposal approve/reject decisions."""
    user = current_user(request)
    return user.username if user else ""


def _rbac_enabled(state: AppState) -> bool:
    rbac = getattr(state.prefs, "rbac", None)
    return bool(getattr(rbac, "enabled", False))


async def _rbac_config_with_custom_roles(state: AppState):
    """Build the RBAC config handed to ``rbac.policy.can()`` for THIS request, folding
    the admin-managed out-of-band custom roles from the :class:`CustomRoleStore`
    (Round-3 Wave-1) INTO the live ``Preferences.rbac`` so a stored custom role is
    actually resolved into the effective matrix.

    The store-held roles are UNIONed with any ``Preferences.rbac.custom_roles`` already
    on the config, de-duplicated by (lowercased) name with the PREFS copy winning a
    collision. ``effective_matrix`` itself drops any custom role whose name shadows a
    built-in role, so the merge stays lockout-proof. Best-effort: a store glitch (or a
    missing store) degrades to the plain ``Preferences.rbac`` — RBAC keeps working off
    the built-in matrix + prefs overrides, never hard-failing the request."""
    rbac = getattr(state.prefs, "rbac", None)
    store = getattr(state, "custom_roles", None)
    if rbac is None or store is None:
        return rbac
    try:
        stored = await store.list()
    except Exception as exc:  # noqa: BLE001 — a store glitch must not break authz
        import logging

        logging.getLogger("tlsoc.api.deps").warning("custom-role load soft-failed: %s", exc)
        return rbac
    if not stored:
        return rbac
    try:
        existing = list(getattr(rbac, "custom_roles", []) or [])
        seen = {
            str((r.get("name") if isinstance(r, dict) else getattr(r, "name", "")) or "").strip().lower()
            for r in existing
        }
        merged = list(existing)
        for cr in stored:
            row = cr.model_dump(mode="json") if hasattr(cr, "model_dump") else dict(cr)
            name_key = str(row.get("name", "") or "").strip().lower()
            if name_key and name_key not in seen:
                merged.append(row)
                seen.add(name_key)
        return rbac.model_copy(update={"custom_roles": merged})
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger("tlsoc.api.deps").warning("custom-role merge soft-failed: %s", exc)
        return rbac


async def _assigned_custom_roles(state: AppState, username: str) -> list[str]:
    """The CUSTOM roles assigned to ``username`` (from ``User.prefs['custom_roles']``,
    where ``routes_roles.assign_user_roles`` persists them because the ``User`` model
    is frozen this wave). Best-effort + fail-safe: a missing store, an env single-admin
    with no persisted record, or any store glitch yields ``[]`` (→ the live decision
    degrades to the user's BASE role, never fail-open and never hard-failing authz).
    Built-in role names are filtered out here too (a custom assignment may never carry
    a base-role name); the policy resolver additionally drops unknown/deleted names."""
    if not username:
        return []
    users = getattr(state, "users", None)
    if users is None:
        return []
    try:
        user = await users.get(username)
    except Exception as exc:  # noqa: BLE001 — a store glitch must not break authz
        import logging

        logging.getLogger("tlsoc.api.deps").warning("assigned-role load soft-failed: %s", exc)
        return []
    if user is None:
        return []
    raw = (getattr(user, "prefs", None) or {}).get("custom_roles")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for x in raw:
        nm = str(x).strip()
        if nm and nm not in out:
            out.append(nm)
    return out


async def _enforce(request: Request, resource: str, action: str):
    """Shared RBAC enforcement core. Three modes (see rbac/policy.py):

    * auth DISABLED        → allow (no-op; the no-auth "old version" default).
    * auth ON, rbac OFF    → authenticated users are treated as super_admin → allow.
    * auth ON, rbac ON     → consult ``rbac.policy.can_for_roles(base_role,
                              assigned_custom_roles, resource, action)``; deny (403)
                              when neither the base role NOR any assigned custom role
                              grants it.

    The user's ASSIGNED custom roles (persisted in ``User.prefs['custom_roles']`` by
    ``PUT /api/users/{username}/roles``) are folded INTO the live decision, so
    assigning a custom role actually grants — or, via that role's own deny, restricts —
    server-side route access, consistent with what ``GET /api/account/permissions``
    already reports. ``super_admin`` stays hard-allowed (lockout-proof); an
    unknown/deleted assigned role fails safe to the base role; and a user with NO
    assigned custom roles is byte-identical to the prior ``can(base_role, …)`` gate.

    Always runs the auth gate first (401s an unauthenticated caller when auth is on)."""
    user = await require_auth(request)
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return user  # auth off → everything allowed
    if not _rbac_enabled(state):
        return user  # rbac off → authenticated == super_admin
    from ..rbac.policy import can_for_roles, resolve_matrix

    role = getattr(user, "role", "") or ""
    rbac_config = await _rbac_config_with_custom_roles(state)
    # Resolve the effective matrix ONCE (folds operator overrides + stored custom-role
    # definitions), then decide against the base role UNIONed with the user's assigned
    # custom roles. Resolving the matrix here also lets the assigned-name fail-safe
    # (drop unknown/deleted roles) key off the SAME matrix the grant union consults.
    matrix = resolve_matrix(rbac_config)
    assigned = await _assigned_custom_roles(state, getattr(user, "username", "") or "")
    if can_for_roles(role, assigned, resource, action, matrix=matrix):
        return user
    # Append-only audit of the denial (#2) — best-effort, never blocks the 403.
    try:
        from ..constants import ActionType

        await state.control_audit.record(
            action_type=ActionType.ACCESS_DENIED,
            surface="rbac",
            actor=getattr(user, "username", "") or "",
            result_summary=f"denied {resource}:{action} for role {role or '?'}",
        )
    except Exception:  # noqa: BLE001
        pass
    raise HTTPException(status_code=403, detail=f"permission denied: {resource}:{action}")


def require_permission(resource: str, action: str):
    """FastAPI dependency factory: gate a route on a single ``resource:action``
    grant. Usage: ``_=Depends(require_permission("sources", "manage"))``."""

    async def _dep(request: Request):
        return await _enforce(request, resource, action)

    return _dep


async def has_permission(request: Request, resource: str, action: str) -> bool:
    """Non-raising boolean form of :func:`require_permission` — for INLINE, in-body
    authorization decisions (e.g. "author OR a moderator grant"). Returns True when the
    caller holds ``resource:action`` (always True when auth is off / rbac off /
    super_admin), False on a denial. Never raises for a denial (a 401 for an
    unauthenticated caller still propagates when auth is on)."""
    try:
        await _enforce(request, resource, action)
        return True
    except HTTPException as exc:
        if exc.status_code == 403:
            return False
        raise


def require_role(*roles: str):
    """FastAPI dependency factory: gate a route on the caller holding one of
    ``roles`` (by value). ``super_admin`` always passes. A strict no-op when auth is
    off; when auth is on but RBAC is off, an authenticated caller (treated as
    super_admin) passes."""
    wanted = {str(getattr(r, "value", r)) for r in roles}

    async def _dep(request: Request):
        user = await require_auth(request)
        state = get_state(request)
        auth = getattr(state, "auth", None)
        if auth is None or not auth.is_enabled:
            return user
        if not _rbac_enabled(state):
            return user
        from ..constants import UserRole

        role = getattr(user, "role", "") or ""
        if role == UserRole.SUPER_ADMIN.value or role in wanted:
            return user
        raise HTTPException(status_code=403, detail="permission denied: role")

    return _dep


# ``require_admin`` is retained for back-compat (the proposal approve/reject routes
# depend on it) but now ENFORCES the ``users:manage`` permission — the privileged
# administrative grant — instead of defaulting to allow. Same three-mode semantics
# as the other gates (no-op when auth off; super_admin when rbac off).
async def require_admin(request: Request):
    """Privileged-action gate — now backed by the ``users:manage`` permission.

    Historically a default-allow seam; with roles landed it enforces the
    administrative grant. Every approve/reject route still depends on THIS function,
    so privileged actions are gated in exactly one place."""
    return await _enforce(request, "users", "manage")


def require_fresh_auth(window: int | None = None):
    """FastAPI dependency factory: a STEP-UP (sudo) gate (Wave 3).

    Composed onto a sensitive route, it 401s ``reauth_required`` when the session
    last (re-)authenticated longer ago than ``window`` seconds (the operator-tunable
    ``session_policy.sudo_reauth_window`` when ``window`` is None). A strict NO-OP
    when auth is disabled. It runs the normal auth gate FIRST (so an unauthenticated
    caller still 401s), then enforces freshness. A token without a registered session
    (no sid / unknown sid) is treated as fresh (the lazy-register just stamped it) —
    never spuriously blocked, mirroring the require_auth back-compat rule."""

    async def _dep(request: Request):
        user = await require_auth(request)
        state = get_state(request)
        auth = getattr(state, "auth", None)
        if auth is None or not auth.is_enabled:
            return user  # auth off → no step-up needed
        sessions = getattr(state, "sessions", None)
        sid = getattr(user, "sid", None)
        if sessions is None or not sid:
            return user  # no registry / pre-session token → don't block (back-compat)
        policy = getattr(getattr(state, "prefs", None), "session_policy", None)
        win = int(window if window is not None else getattr(policy, "sudo_reauth_window", 600) or 600)
        try:
            row = await sessions.get(sid)
        except Exception:  # noqa: BLE001
            return user  # store glitch → don't block a step-up
        if row is None:
            return user  # just lazily-registered → treat as fresh
        age = sessions.reauth_age_seconds(row)
        if age is not None and age > win:
            raise HTTPException(
                status_code=401,
                detail={"code": "reauth_required", "reason": "stale_authn", "window": win},
            )
        return user

    return _dep


def require_system_update_operator(window: int | None = None):
    """Fail-closed owner/session/step-up gate for deployment mutations.

    This is intentionally stricter than the general compatibility-oriented auth
    dependencies above.  A supervised update can restart the application and must
    therefore require every one of these signals at the same time:

    * authentication is enabled and the principal is the *built-in*
      ``super_admin`` (custom roles and RBAC-off mode never elevate here);
    * the signed access token carries a ``sid`` and an explicit token-version;
    * that exact session is present, belongs to the principal, is active, and was
      issued at the current token-version; and
    * the session has a known recent reauthentication timestamp.

    Missing state, an unknown session, malformed claims, and SessionStore failures
    deny the operation.  This dependency is only for update/preflight/rollback
    mutations; read-only status still uses ``system_updates:read`` so it can explain
    why a deployment is not capable of one-click updates.
    """

    async def _dep(request: Request):
        state = get_state(request)
        auth = getattr(state, "auth", None)
        if auth is None or not auth.is_enabled:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "update_auth_required",
                    "reason": "auth_disabled",
                    "message": "Enable authentication before using supervised updates.",
                },
            )

        token = request.cookies.get("tlsoc_token") or _bearer(request)
        user = auth.verify(token) if token else None
        if user is None:
            raise HTTPException(status_code=401, detail="authentication required")

        from ..constants import UserRole

        if getattr(user, "role", "") != UserRole.SUPER_ADMIN.value:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "update_owner_required",
                    "message": "Only the built-in super administrator can manage updates.",
                },
            )
        if bool(getattr(user, "must_change_password", False)):
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "password_change_required",
                    "message": "Change the temporary password before managing updates.",
                },
            )

        claims = auth.claims_of(token) if token else None
        sid = getattr(user, "sid", None)
        sessions = getattr(state, "sessions", None)
        if not isinstance(claims, dict) or not sid or sessions is None:
            raise HTTPException(
                status_code=401,
                detail={"code": "session_invalid", "reason": "registered_session_required"},
            )
        try:
            stamped_tv_raw = claims["tv"]
            if isinstance(stamped_tv_raw, bool):
                raise ValueError("boolean token version")
            stamped_tv = int(stamped_tv_raw)
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=401,
                detail={"code": "reauth_required", "reason": "token_version_missing"},
            ) from exc

        policy = getattr(getattr(state, "prefs", None), "session_policy", None)
        idle = int(getattr(policy, "idle_timeout", 0) or 0)
        absolute = int(getattr(policy, "absolute_lifetime", 0) or 0)
        win = int(
            window
            if window is not None
            else getattr(policy, "sudo_reauth_window", 600) or 600
        )
        try:
            row = await sessions.get(sid)
            current_tv = int(await sessions.token_version_for(user.username))
        except Exception as exc:  # noqa: BLE001 — privileged control plane fails closed
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "session_store_unavailable",
                    "message": "The session registry could not verify this update request.",
                },
            ) from exc

        if (
            not isinstance(row, dict)
            or str(row.get("username", "")).strip().lower()
            != str(user.username).strip().lower()
            # A compatibility token lazily registered by the ordinary auth gate
            # has no authentication method. It is sufficient for old read routes,
            # but never for deployment authority: require an explicit password,
            # MFA, or SSO login-created session row.
            or not str(row.get("mfa_method", "")).strip()
        ):
            raise HTTPException(
                status_code=401,
                detail={"code": "session_invalid", "reason": "registered_session_required"},
            )
        try:
            row_tv = int(row.get("token_version", -1))
        except (TypeError, ValueError):
            row_tv = -1
        if stamped_tv != current_tv or row_tv != current_tv:
            raise HTTPException(
                status_code=401,
                detail={"code": "reauth_required", "reason": "tv_mismatch"},
            )
        try:
            reason = sessions.is_active(
                row, idle_timeout=idle, absolute_lifetime=absolute
            )
            age = sessions.reauth_age_seconds(row)
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "session_store_unavailable",
                    "message": "The session registry could not verify this update request.",
                },
            ) from exc
        if reason is not None:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": _SESSION_REASON_CODE.get(reason, "session_invalid"),
                    "reason": reason,
                },
            )
        if age is None or age > win:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "reauth_required",
                    "reason": "stale_authn" if age is not None else "authn_time_unknown",
                    "window": win,
                },
            )
        return user

    return _dep
