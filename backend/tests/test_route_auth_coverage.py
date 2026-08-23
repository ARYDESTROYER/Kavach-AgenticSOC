"""CI guard: deny-by-default auth coverage.

Walks the REAL application (``app.main.app``, which mounts the auth gate on the
whole /api router) and asserts that every ``/api`` route is covered by the
``require_auth`` dependency, OR is one of the small explicitly-public paths. Adding
a new unauthenticated /api route fails this test — auth can't be silently skipped.

It ALSO asserts authoriZation coverage (not just authN): every STATE-CHANGING
(non-GET) ``/api`` route must declare an AUTHZ gate — a ``require_permission`` /
``require_role`` / ``require_admin`` / ``require_fresh_auth`` dependency, OR an
in-body ``_enforce(...)`` call — UNLESS it is on a tiny, explicit, documented
allowlist of self-service / auth-flow / ingest routes (see ``_AUTHZ_EXEMPT``). This
closes the gap that let ``set_status→RESOLVED`` reach a terminal status without
``cases:close``: a NEW ungated state-changer now FAILS CI by default.
"""

from __future__ import annotations

import inspect

from fastapi.routing import APIRoute
from starlette.routing import Mount, WebSocketRoute

from app.api.deps import (
    _PUBLIC_INGEST_RE,
    PUBLIC_API_PATHS,
    PUBLIC_GET_PATHS,
    require_admin,
    require_auth,
)
from app.api.routes import router
from app.main import app


def _dependant_calls(dependant) -> set:
    calls = set()
    for dep in dependant.dependencies:
        if dep.call is not None:
            calls.add(dep.call)
        calls |= _dependant_calls(dep)
    return calls


# Qualnames (module ``app.api.deps``) that prove a route declares an AUTHZ gate as a
# FastAPI dependency. The factories (``require_permission``/``require_role``/
# ``require_fresh_auth``) return an inner closure named ``_dep``; ``require_admin`` is
# a named coroutine. ``require_auth`` is authN-only and deliberately NOT here.
_AUTHZ_DEP_QUALNAMES = frozenset({
    "require_permission.<locals>._dep",
    "require_role.<locals>._dep",
    "require_fresh_auth.<locals>._dep",
    "require_admin",
})


def _has_authz_dependency(route: APIRoute) -> bool:
    for call in _dependant_calls(route.dependant):
        if (
            getattr(call, "__module__", "") == "app.api.deps"
            and getattr(call, "__qualname__", "") in _AUTHZ_DEP_QUALNAMES
        ):
            return True
    return False


def _enforces_in_body(route: APIRoute) -> bool:
    """True when the endpoint enforces RBAC INLINE via ``_enforce(...)`` rather than a
    dependency (the case_action / bulk / comment / tags / assign pattern, which must
    resolve the principal + grant from the request body, e.g. a target-aware grant)."""
    try:
        src = inspect.getsource(route.endpoint)
    except (OSError, TypeError):  # pragma: no cover - source always available offline
        return False
    return "_enforce(" in src


def test_every_api_route_is_auth_covered() -> None:
    api_routes = [
        r for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api")
    ]
    assert api_routes, "expected /api routes to be registered"
    uncovered: list[str] = []
    for route in api_routes:
        if require_auth in _dependant_calls(route.dependant):
            continue
        if route.path in PUBLIC_API_PATHS:
            continue
        uncovered.append(f"{sorted(route.methods)} {route.path}")
    assert not uncovered, (
        "these /api routes are neither auth-covered nor in PUBLIC_API_PATHS: "
        + ", ".join(uncovered)
    )


# --------------------------------------------------------------------------- #
# AuthZ coverage of STATE-CHANGING routes.
# --------------------------------------------------------------------------- #
# Every non-GET /api route must EITHER declare an authZ gate (dependency or in-body
# ``_enforce``) OR appear here. The allowlist is split into reviewed buckets so its
# growth is deliberate + auditable; a NEW state-changer that is neither gated nor
# listed FAILS ``test_state_changing_routes_declare_authz`` below.
#
# Bucket 1 — AUTH-FLOW / PRE-SESSION: login/setup/MFA/SSO/refresh handshake routes,
# each guarded by a single-use token / first-run state, NOT an RBAC grant. Several
# are also in PUBLIC_API_PATHS (reachable before a session exists).
_AUTHZ_EXEMPT_AUTH_FLOW = frozenset({
    "/api/auth/login", "/api/auth/logout", "/api/auth/change-password",
    "/api/auth/refresh", "/api/auth/reauth",
    "/api/auth/mfa/setup", "/api/auth/mfa/confirm", "/api/auth/mfa/verify",
    "/api/auth/mfa/disable",
    # Mandated-MFA enrollment DURING login (required-but-not-enrolled): both are
    # gated by the short-lived single-use pending token (mfa:"pending"), NOT an RBAC
    # grant — a full session does not exist yet at that point of the login flow.
    "/api/auth/mfa/enroll-setup", "/api/auth/mfa/enroll-confirm",
    # /api/setup/complete + /api/setup/secrets now carry require_permission("settings",
    # "manage") (audit #2): a no-op when auth is off (OOBE default), a real grant when
    # auth is on — so they are gated, not exempt.
    # Round-4 Wave-4 — OOBE "create admin account" writer (routes_setup.py). Pre-auth
    # + self-locking (403 once setup complete / 409 once an admin exists), NOT an RBAC
    # grant. Also in PUBLIC_API_PATHS (reachable before a session exists).
    "/api/setup/account",
})
# Bucket 2 — SELF-SERVICE: any signed-in principal edits ONLY their OWN bucket
# (profile / avatar / personal prefs / saved views / their own sessions / their own
# personal preferences). Case feedback is intentionally NOT self-service: it becomes
# tuning ground truth and therefore requires the narrow ``cases:write`` grant.
_AUTHZ_EXEMPT_SELF_SERVICE = frozenset({
    "/api/account/me", "/api/me/avatar",
    "/api/prefs/user", "/api/prefs/user/tables/{table_id}",
    "/api/views", "/api/views/{view_id}", "/api/views/{view_id}/clone",
    "/api/sessions/{sid}/revoke", "/api/sessions/revoke-others",
})
# Bucket 3 — INGEST: the inbound receiver self-authenticates (bearer / HMAC inside
# the receiver), matched by _PUBLIC_INGEST_RE — not an RBAC grant.
_AUTHZ_EXEMPT_INGEST = frozenset({"/api/ingest/{source_id}"})
# Bucket 4 — PRE-RBAC OPERATIONAL routes that predate the RBAC rollout and are NOT
# yet resource-gated. They are explicitly acknowledged here (NOT silently passing) so
# the meta-test stays green for the current tree while still failing on any NEW
# ungated state-changer. Tightening these to a grant is tracked as follow-up work;
# listing them keeps the guard honest in the meantime.
_AUTHZ_EXEMPT_PENDING = frozenset()
# audit #45: /api/investigate now requires cases:reinvestigate; /api/overview + /api/chat
# require cases:read; /api/poll was already gated on sources:manage. /cases/{id}/
# investigate + /reinvestigate require cases:reinvestigate (audit #11). So the
# pending-exempt bucket is now empty — these are all gated, not merely allowlisted.
_AUTHZ_EXEMPT = (
    _AUTHZ_EXEMPT_AUTH_FLOW
    | _AUTHZ_EXEMPT_SELF_SERVICE
    | _AUTHZ_EXEMPT_INGEST
    | _AUTHZ_EXEMPT_PENDING
)
_NON_GET = {"POST", "PUT", "DELETE", "PATCH"}


def test_state_changing_routes_declare_authz() -> None:
    """Every non-GET /api route carries an authZ gate (dependency or in-body
    ``_enforce``) OR is on the explicit, documented ``_AUTHZ_EXEMPT`` allowlist. A
    new state-changer that is neither fails here — this is the regression guard that
    would have caught the ``set_status→RESOLVED`` RBAC bypass."""
    ungated: list[str] = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/api"):
            continue
        if not (_NON_GET & set(route.methods)):
            continue  # pure read endpoint — covered by the authN test only
        if _has_authz_dependency(route) or _enforces_in_body(route):
            continue
        if route.path in _AUTHZ_EXEMPT:
            continue
        ungated.append(f"{sorted(_NON_GET & set(route.methods))} {route.path}")
    assert not ungated, (
        "these state-changing /api routes declare NO authZ gate (no "
        "require_permission/require_role/require_admin/require_fresh_auth dependency "
        "and no in-body _enforce) and are not on the reviewed _AUTHZ_EXEMPT "
        "allowlist: " + ", ".join(sorted(ungated))
    )


def test_case_action_paths_are_enforced_in_body() -> None:
    """The case lifecycle writers (single + bulk action, comment, tags, assign)
    enforce RBAC INLINE via ``_enforce`` (they resolve a TARGET-AWARE grant from the
    body — e.g. set_status→terminal needs cases:close). Assert that inline
    enforcement is actually present so it can't silently regress to ungated."""
    routes = {
        r.path: r for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api")
    }
    for path in (
        "/api/cases/{case_id}/action",
        "/api/cases/bulk",
        "/api/cases/{case_id}/comment",
        "/api/cases/{case_id}/tags",
        "/api/cases/{case_id}/assign",
    ):
        assert path in routes, f"missing case route {path}"
        assert _enforces_in_body(routes[path]), f"{path} lost its in-body _enforce gate"


def test_authz_exempt_allowlist_is_minimal_and_disjoint() -> None:
    """Guard the allowlist against silent growth + overlap. Each bucket is disjoint,
    and every exempt path is a REAL registered non-GET /api route (a stale entry that
    no longer matches a route is flagged so the allowlist can't rot)."""
    buckets = [
        _AUTHZ_EXEMPT_AUTH_FLOW, _AUTHZ_EXEMPT_SELF_SERVICE,
        _AUTHZ_EXEMPT_INGEST, _AUTHZ_EXEMPT_PENDING,
    ]
    seen: set[str] = set()
    for b in buckets:
        assert not (seen & b), f"overlapping allowlist entries: {seen & b}"
        seen |= b
    # Bound the total so a future PR can't quietly balloon the exemptions. Bumped to 31
    # in Round-4 Wave-4 for the one new pre-auth OOBE writer /api/setup/account (a
    # self-locking first-run account bootstrap, guarded by first-run state not RBAC).
    assert len(_AUTHZ_EXEMPT) <= 31, "authZ exemption allowlist grew unexpectedly"
    # Every exempt path must correspond to a real non-GET /api route.
    non_get_paths = {
        r.path for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api")
        and (_NON_GET & set(r.methods))
    }
    stale = sorted(_AUTHZ_EXEMPT - non_get_paths)
    assert not stale, f"stale _AUTHZ_EXEMPT entries (no matching non-GET route): {stale}"


# --------------------------------------------------------------------------- #
# FIX 1 — behavioural regression: set_status→RESOLVED requires cases:close.
# A cases:write-ONLY analyst (analyst_tier1) must NOT be able to drive a case to a
# terminal/close-axis status (RESOLVED) via the generic set_status action (single OR
# bulk), which would otherwise side-step the cases:close grant the explicit
# close/resolve actions require. The deterministic #3 close-axis is unaffected — this
# is the HUMAN analyst path; it never calls decide().
# --------------------------------------------------------------------------- #
import json
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.config import Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


@asynccontextmanager
async def _rbac_lifespan(app, overrides):
    state = AppState.create(secrets=app.state._secrets, es=InMemoryESClient(),
                            provider_overrides=overrides)
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(update={"setup_complete": True})
    prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
    await state.update_prefs(prefs)
    app.state.tlsoc = state
    yield
    await state.shutdown()


def _rbac_client():
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="authz-fix1-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    api = FastAPI(lifespan=lambda app: _rbac_lifespan(app, overrides))
    api.state._secrets = secrets
    api.include_router(router, dependencies=[Depends(require_auth)])
    c = TestClient(api)
    c._mock = mock  # type: ignore[attr-defined]
    return c


def _login(c, username, password):
    c.cookies.clear()
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def _make_case(c) -> str:
    """Create a real case (logged in as Admin/super_admin) via the investigate path."""
    es = c.app.state.tlsoc.es
    ip = "198.51.100.77"
    es.add_log("all-logs-2026.06.16",
               make_log_event(ip=ip, ts_millis=to_millis(now_utc()) - 3600_000))
    mock = c._mock  # type: ignore[attr-defined]
    mock.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock.push("investigator", json.dumps({
        "action": "final", "reasoning": "scripted",
        "verdict": {
            "verdict": "NEEDS_HUMAN", "confidence": 0.2,
            "evidence": [{"summary": "e", "event_ids": []}],
            "mitre": [], "recommended_action": "review",
            "reproduce_query": 'source.ip : "x"',
        },
    }))
    r = c.post("/api/investigate",
               json={"entity": {"type": "ip", "value": ip}, "source_surface": "investigate"})
    assert r.status_code == 200, r.text
    return r.json()["case_id"]


def test_fix1_set_status_resolved_requires_cases_close() -> None:
    with _rbac_client() as c:
        _login(c, "Admin", "Admin@123")
        cid = _make_case(c)
        # Create a tier1 analyst (cases:write but NOT cases:close).
        r = c.post("/api/users", json={
            "username": "tier1", "password": "tier1-pass-1",
            "role": UserRole.ANALYST_TIER1.value,
        })
        assert r.status_code == 200, r.text

        _login(c, "tier1", "tier1-pass-1")
        # A non-terminal set_status is fine (cases:write).
        r = c.post(f"/api/cases/{cid}/action",
                   json={"action": "set_status", "status": "investigating"})
        assert r.status_code == 200, r.text
        # Driving to a TERMINAL status via set_status is a close-axis move → 403.
        r = c.post(f"/api/cases/{cid}/action",
                   json={"action": "set_status", "status": "resolved"})
        assert r.status_code == 403, r.text
        assert "cases:close" in r.json()["detail"]
        # The explicit close-class action is also denied (sanity: tier1 lacks close).
        r = c.post(f"/api/cases/{cid}/action", json={"action": "resolve"})
        assert r.status_code == 403, r.text
        # BULK set_status→resolved is denied up front too (same grant rule).
        r = c.post("/api/cases/bulk",
                   json={"ids": [cid], "action": "set_status", "status": "resolved"})
        assert r.status_code == 403, r.text


def test_fix1_cases_close_role_can_set_status_resolved() -> None:
    # A role WITH cases:close (analyst_tier2) CAN drive set_status→resolved — the
    # grant upgrade must not over-block a properly privileged analyst.
    with _rbac_client() as c:
        _login(c, "Admin", "Admin@123")
        cid = _make_case(c)
        r = c.post("/api/users", json={
            "username": "tier2", "password": "tier2-pass-1",
            "role": UserRole.ANALYST_TIER2.value,
        })
        assert r.status_code == 200, r.text
        _login(c, "tier2", "tier2-pass-1")
        r = c.post(f"/api/cases/{cid}/action",
                   json={"action": "set_status", "status": "resolved"})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "resolved"


def test_setup_secrets_requires_settings_manage() -> None:
    # audit #2: a non-admin (read-only auditor) must NOT be able to rewrite global
    # secrets / repoint the ES log source. tier1 lacks settings:manage → 403.
    with _rbac_client() as c:
        _login(c, "Admin", "Admin@123")
        r = c.post("/api/users", json={
            "username": "tier1", "password": "tier1-pass-1",
            "role": UserRole.ANALYST_TIER1.value,
        })
        assert r.status_code == 200, r.text
        _login(c, "tier1", "tier1-pass-1")
        r = c.post("/api/setup/secrets", json={"es_url": "https://evil:9200"})
        assert r.status_code == 403, r.text
        r = c.post("/api/setup/complete", json={})
        assert r.status_code == 403, r.text
        # Admin (super_admin) still can.
        _login(c, "Admin", "Admin@123")
        r = c.post("/api/setup/secrets", json={"anthropic_api_key": "sk-test"})
        assert r.status_code == 200, r.text


def test_investigate_routes_require_cases_reinvestigate() -> None:
    # audit #11: a read-only / tier1 analyst (no cases:reinvestigate) must NOT be able
    # to trigger a costly LLM (re)investigation.
    with _rbac_client() as c:
        _login(c, "Admin", "Admin@123")
        cid = _make_case(c)
        r = c.post("/api/users", json={
            "username": "tier1", "password": "tier1-pass-1",
            "role": UserRole.ANALYST_TIER1.value,
        })
        assert r.status_code == 200, r.text
        _login(c, "tier1", "tier1-pass-1")
        assert c.post(f"/api/cases/{cid}/investigate").status_code == 403
        assert c.post(f"/api/cases/{cid}/reinvestigate", json={}).status_code == 403


def test_public_paths_are_minimal_and_known() -> None:
    # A small, deliberate allowlist — guard against accidental growth.
    assert {
        "/api/health",
        "/api/health/live",
        "/api/health/ready",
        "/api/health/build-info",
    } <= PUBLIC_API_PATHS
    assert PUBLIC_API_PATHS <= {
        "/api/health", "/api/health/live", "/api/health/ready",
        "/api/health/build-info",
        "/api/auth/login", "/api/auth/logout", "/api/auth/me",
        "/api/setup/status", "/api/setup/account",
        # Wave 2 — each guarded by a single-use token/state, not a session.
        "/api/auth/mfa/verify",
        # Mandated-MFA login-phase enrollment — guarded by the same pending token.
        "/api/auth/mfa/enroll-setup", "/api/auth/mfa/enroll-confirm",
        "/api/auth/sso/providers", "/api/auth/sso/authorize", "/api/auth/sso/callback",
        # Wave 3 — refresh is self-authenticating via the opaque refresh token (the
        # access token may have expired); guarded by the refresh-hash match + reuse
        # detection, not a session.
        "/api/auth/refresh",
    }
    # GET-only public paths (read-only, non-sensitive) — also guarded.
    assert PUBLIC_GET_PATHS <= {"/api/branding"}


def test_no_unprotectable_routes_under_api() -> None:
    # Mounts / WebSocket routes under /api would bypass the route-level auth
    # dependency entirely — assert none exist (the gate only covers APIRoutes).
    bad = [
        getattr(r, "path", "?")
        for r in app.routes
        if isinstance(r, (Mount, WebSocketRoute)) and getattr(r, "path", "").startswith("/api")
    ]
    assert not bad, f"unprotectable mounts/ws under /api: {bad}"


def test_ingest_public_path_is_tight() -> None:
    # The receiver self-auth allowance must match ONLY the one-segment receiver
    # route — not a nested route that could be made public by accident.
    assert _PUBLIC_INGEST_RE.match("/api/ingest/my-source")
    assert not _PUBLIC_INGEST_RE.match("/api/ingest/my-source/config")
    assert not _PUBLIC_INGEST_RE.match("/api/ingestion-status")
    assert not _PUBLIC_INGEST_RE.match("/api/ingest/")


def test_wave1_identity_routes_are_registered() -> None:
    # The Wave-1 OOBE / multi-user / RBAC routes exist on the real app (so the
    # coverage walk above actually guards them).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for expected in (
        # The legacy weaker /api/setup/init-admin was REMOVED (H4 / FINDING #11);
        # /api/setup/account (routes_setup.py) is now the SOLE OOBE admin writer.
        "/api/setup/account",
        "/api/auth/change-password",
        "/api/roles",
        "/api/users",
        "/api/users/{username}",
    ):
        assert expected in paths, f"missing Wave-1 identity route {expected}"
    # The removed legacy route must NOT be re-registered.
    assert "/api/setup/init-admin" not in paths


def test_wave1_public_paths_present_in_allowlist() -> None:
    # The OOBE public paths are in the allowlist (reachable pre-session).
    assert "/api/setup/status" in PUBLIC_API_PATHS
    assert "/api/setup/account" in PUBLIC_API_PATHS
    # The legacy weaker init-admin path was REMOVED (H4 / FINDING #11).
    assert "/api/setup/init-admin" not in PUBLIC_API_PATHS
    # ...and the user-management routes are NOT public (deny-by-default).
    assert "/api/users" not in PUBLIC_API_PATHS
    assert "/api/roles" not in PUBLIC_API_PATHS
    assert "/api/auth/change-password" not in PUBLIC_API_PATHS


def test_wave3_session_routes_registered_and_not_public() -> None:
    # The Wave-3 session/access-policy routes exist on the real app (so the coverage
    # walk guards them). All require a live session EXCEPT /auth/refresh, which is
    # self-authenticating via the opaque refresh token (so it is in the allowlist).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    session_gated = (
        "/api/sessions",
        "/api/sessions/{sid}/revoke",
        "/api/sessions/revoke-others",
        "/api/auth/reauth",
        "/api/account/activity",
        "/api/admin/sessions",
        "/api/admin/sessions/{sid}/revoke",
        "/api/admin/users/{username}/revoke-all",
    )
    for expected in session_gated:
        assert expected in paths, f"missing Wave-3 session route {expected}"
        assert expected not in PUBLIC_API_PATHS, f"{expected} must NOT be public"
    # Refresh exists + IS public (guarded by the refresh-token match, not a session).
    assert "/api/auth/refresh" in paths
    assert "/api/auth/refresh" in PUBLIC_API_PATHS


def test_wave7_notification_routes_registered_and_not_public() -> None:
    # The Wave-7 email/template routes exist on the real app (so the coverage walk
    # guards them) and the new preview route is auth-gated (NOT public).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for expected in (
        "/api/notifications/providers",
        "/api/notifications/preview",
    ):
        assert expected in paths, f"missing Wave-7 notification route {expected}"
        assert expected not in PUBLIC_API_PATHS, f"{expected} must NOT be public"


def test_wave7_customization_routes_registered_and_not_public() -> None:
    # The Wave-7 pervasive-customization routes exist on the real app (so the coverage
    # walk guards them) and none is public (deny-by-default; auth on requires a
    # session for all of them).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for expected in (
        "/api/prefs/effective",
        "/api/prefs/user",
        "/api/prefs/org",
        "/api/prefs/user/tables/{table_id}",
        "/api/views",
        "/api/views/{view_id}",
        "/api/views/{view_id}/clone",
        "/api/terminology",
    ):
        assert expected in paths, f"missing Wave-7 customization route {expected}"
        assert expected not in PUBLIC_API_PATHS, f"{expected} must NOT be public"


def test_wave7_org_routes_are_admin_gated() -> None:
    # The ORG-default writers (PUT /api/prefs/org + PUT /api/terminology) must carry
    # the require_admin dependency — org defaults + terminology are an admin surface.
    # The PERSONAL prefs writers must NOT (any signed-in user edits their own bucket).
    routes = {
        (frozenset(r.methods), r.path): r
        for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api")
    }

    def _calls(path: str, method: str) -> set:
        for (methods, p), r in routes.items():
            if p == path and method in methods:
                return _dependant_calls(r.dependant)
        raise AssertionError(f"route {method} {path} not found")

    assert require_admin in _calls("/api/prefs/org", "PUT")
    assert require_admin in _calls("/api/terminology", "PUT")
    # Personal prefs are NOT admin-gated (each user edits only their own bucket).
    assert require_admin not in _calls("/api/prefs/user", "PUT")
    assert require_admin not in _calls("/api/views", "POST")
    assert require_admin not in _calls("/api/prefs/user/tables/{table_id}", "PUT")


def test_mandated_mfa_enroll_routes_registered_and_public() -> None:
    # The mandated-MFA login-phase enrollment routes exist on the real app AND are
    # deliberately on the public allowlist: they run BEFORE a session exists and are
    # gated by the short-lived pending token (mfa:"pending") instead — the same
    # trust model as /api/auth/mfa/verify. (A pending token is still rejected by
    # every full-session verify, covered by the mandate flow tests.)
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for expected in ("/api/auth/mfa/enroll-setup", "/api/auth/mfa/enroll-confirm"):
        assert expected in paths, f"missing mandated-MFA enroll route {expected}"
        assert expected in PUBLIC_API_PATHS, f"{expected} must be pending-token public"


def test_wave5_demo_routes_registered_and_not_public() -> None:
    # The Wave-5 Demo Mode routes exist on the real app (so the coverage walk guards
    # them) and NONE of them is public — enable/reset/disable are admin-gated and
    # status still requires a session when auth is on (deny-by-default).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for expected in (
        "/api/demo/status",
        "/api/demo/enable",
        "/api/demo/reset",
        "/api/demo/disable",
    ):
        assert expected in paths, f"missing Wave-5 demo route {expected}"
        assert expected not in PUBLIC_API_PATHS, f"{expected} must NOT be public"
