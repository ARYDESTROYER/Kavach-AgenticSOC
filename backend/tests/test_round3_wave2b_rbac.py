"""Round-3 Wave-2b — server-side ENFORCEMENT of per-user assigned CUSTOM roles.

Wave-2 (``routes_roles.py``) let an admin ASSIGN custom roles to a user (persisted in
``User.prefs['custom_roles']`` because the ``User`` model was frozen) and SURFACED them
via ``GET /api/account/permissions``, but the live authorization path
(``deps._enforce`` / ``require_permission``) still keyed solely off the user's BASE
role. This wave closes that gap: ``_enforce`` now folds the user's assigned custom
roles INTO the ``can_for_roles`` decision, so assigning a custom role actually grants
(or, via that role's own deny, restricts) server-side route access — consistent with
what ``/api/account/permissions`` already reports.

What this proves (end-to-end, through the REAL FastAPI dependency + stores):
  * GRANT:  a custom role granting a narrow resource a base role lacks → the gated
            route now ALLOWS the assigned user (previously 403).
  * DENY:   a custom role whose OWN deny removes the grant → the union still does NOT
            grant it → the gated route BLOCKS (deny-wins within the role).
  * PARITY: a user with NO assigned custom roles is byte-identical to the prior
            base-role-only gate (allow set + deny set unchanged).
  * LOCKOUT: ``super_admin`` can never be locked out (a deny-laden custom role
            assigned to it changes nothing).
  * FAIL-SAFE: an unknown / deleted assigned role contributes nothing (degrades to the
            base role) and never fails authz open OR hard.

Offline (fake ES + mock LLM), auth-ON + RBAC-ON, mirroring tests/test_round3_wave2_roles.py.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from app.api.deps import require_auth, require_permission
from app.api.routes import router as monolith_router
from app.api.routes_rag import router as rag_router
from app.api.routes_roles import router as roles_router
from app.config import Secrets
from app.constants import CaseStatus, EntityType, SourceSurface, UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity
from app.state import AppState
from tests._auth_helpers import ready_user

SA = UserRole.SUPER_ADMIN.value
MGR = UserRole.SOC_MANAGER.value
T1 = UserRole.ANALYST_TIER1.value
T2 = UserRole.ANALYST_TIER2.value
AUD = UserRole.AUDITOR.value
RESP = UserRole.RESPONDER.value


# --------------------------------------------------------------------------- #
# A tiny PROBE router gated by require_permission on the EXACT resource:action we
# want to exercise — so we drive the real deps._enforce path directly, regardless
# of which monolith endpoints happen to gate a given grant.
# --------------------------------------------------------------------------- #
def _make_app(rbac: bool = True):
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="wave2b-test-secret",
        auth_seed_admin=True,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        if rbac:
            prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])
    api.include_router(rag_router, dependencies=[Depends(require_auth)])

    # Probe routes — one per resource:action used in the tests. Each returns 200 only
    # if deps._enforce (require_permission) allows the caller; otherwise it 401/403s.
    from fastapi import APIRouter

    pr = APIRouter(prefix="/api")

    @pr.get("/_probe/cases/close")
    async def _probe_cases_close(
        request: Request, _=Depends(require_permission("cases", "close"))
    ) -> dict:
        return {"ok": True}

    @pr.get("/_probe/users/manage")
    async def _probe_users_manage(
        request: Request, _=Depends(require_permission("users", "manage"))
    ) -> dict:
        return {"ok": True}

    @pr.get("/_probe/cases/read")
    async def _probe_cases_read(
        request: Request, _=Depends(require_permission("cases", "read"))
    ) -> dict:
        return {"ok": True}

    api.include_router(pr, dependencies=[Depends(require_auth)])
    return api


def _login(c, username="Admin", password="Admin@123"):
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r


def _mk_user(c, username, password, role=T1):
    r = c.post("/api/users", json={"username": username, "password": password, "role": role})
    assert r.status_code == 200, r.text
    ready_user(c, username, password)
    return r


def _state(c) -> AppState:
    return c.app.state.tlsoc


async def _set_assigned_custom_roles(c, username: str, names: list[str]) -> None:
    """Persist a user's assigned custom roles directly into the store + refresh the
    auth view — the same place ``PUT /api/users/{username}/roles`` writes them."""
    state = _state(c)
    user = await state.users.get(username)
    assert user is not None
    prefs = dict(user.prefs or {})
    prefs["custom_roles"] = list(names)
    await state.users.update(username, prefs=prefs)
    await state.refresh_users()


# --------------------------------------------------------------------------- #
# GRANT — an assigned custom role unlocks a route the base role can't reach.
# --------------------------------------------------------------------------- #
def test_assigned_custom_role_grants_server_side_access() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        # A custom role that grants the privileged users:manage (tier1 lacks it).
        r = c.post("/api/roles", json={
            "name": "useradmin", "inherits": [T1], "grants": {"users": ["manage"]},
        })
        assert r.status_code == 200, r.text
        # A plain tier1 user.
        _mk_user(c, "alice", "alice-pass-1234", role=T1)

        # Before assignment: tier1 is DENIED users:manage on a REAL endpoint + the probe.
        c.cookies.clear()
        _login(c, "alice", "alice-pass-1234")
        assert c.get("/api/users").status_code == 403
        assert c.get("/api/_probe/users/manage").status_code == 403
        # …but their base grant (cases:read) still works (sanity).
        assert c.get("/api/_probe/cases/read").status_code == 200

        # Assign the custom role (admin action), then re-check as alice.
        c.cookies.clear()
        _login(c)
        a = c.put("/api/users/alice/roles", json={"custom_roles": ["useradmin"]})
        assert a.status_code == 200, a.text

        c.cookies.clear()
        _login(c, "alice", "alice-pass-1234")
        # The assigned custom role now GRANTS users:manage server-side — real route + probe.
        assert c.get("/api/users").status_code == 200
        assert c.get("/api/_probe/users/manage").status_code == 200
        # Consistency with what /api/account/permissions reports for alice.
        perms = c.get("/api/account/permissions").json()
        assert perms["custom_roles"] == ["useradmin"]
        assert "manage" in perms["permissions"]["users"]


def test_assigned_custom_role_grants_a_narrow_action() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        # tier1 cannot close cases; a custom role adds exactly that.
        c.post("/api/roles", json={
            "name": "closer", "inherits": [T1], "grants": {"cases": ["close"]},
        })
        _mk_user(c, "bob", "bob-pass-12345", role=T1)

        c.cookies.clear()
        _login(c, "bob", "bob-pass-12345")
        assert c.get("/api/_probe/cases/close").status_code == 403

        c.cookies.clear()
        _login(c)
        assert c.put("/api/users/bob/roles", json={"custom_roles": ["closer"]}).status_code == 200

        c.cookies.clear()
        _login(c, "bob", "bob-pass-12345")
        assert c.get("/api/_probe/cases/close").status_code == 200


def test_case_feedback_uses_verified_actor_and_honors_custom_write_grant() -> None:
    """Feedback is tuning ground truth, not an ungated self-service mutation."""
    with TestClient(_make_app()) as c:
        _login(c)
        assert c.post("/api/roles", json={
            "name": "case_grader",
            "grants": {"cases": ["write"]},
        }).status_code == 200
        _mk_user(c, "feedback-auditor", "feedback-auditor-pass", role=AUD)

        state = _state(c)
        case = Case(
            case_id="case-feedback-rbac",
            cluster_signature="sig-feedback-rbac",
            source_surface=SourceSurface.AUTOMATED_SCAN,
            entity=Entity(type=EntityType.IP, value="198.51.100.44"),
            status=CaseStatus.OPEN,
        )
        c.portal.call(state.cases.save, case)

        c.cookies.clear()
        _login(c, "feedback-auditor", "feedback-auditor-pass")
        body = {
            "analyst": "forged-admin",
            "assessment": "agree",
            "actual_outcome": "false_positive",
        }
        assert c.post(f"/api/cases/{case.case_id}/feedback", json=body).status_code == 403

        c.cookies.clear()
        _login(c)
        assert c.put(
            "/api/users/feedback-auditor/roles",
            json={"custom_roles": ["case_grader"]},
        ).status_code == 200

        c.cookies.clear()
        _login(c, "feedback-auditor", "feedback-auditor-pass")
        accepted = c.post(f"/api/cases/{case.case_id}/feedback", json=body)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["feedback"][-1]["analyst"] == "feedback-auditor"
        assert accepted.json()["feedback"][-1]["actual_outcome"] == "false_positive"

        invalid = c.post(
            f"/api/cases/{case.case_id}/feedback",
            json={**body, "actual_outcome": "model_agreed"},
        )
        assert invalid.status_code == 422

        records = c.portal.call(state.audit.records_for_case, case.case_id)
        feedback_rows = [
            row for row in records
            if (
                row.get("action_type") if isinstance(row, dict)
                else getattr(row, "action_type", "")
            ) == "feedback"
        ]
        assert feedback_rows
        last = feedback_rows[-1]
        assert (
            last.get("actor") if isinstance(last, dict) else getattr(last, "actor", "")
        ) == "feedback-auditor"


def test_proposal_routes_enforce_read_and_approval_permissions() -> None:
    """The real review queue is broadly readable but decisions stay role-gated.

    This exercises the actual ``/api/proposals`` routes rather than a permission
    probe, including an approval and rejection by the default Responder role.
    """
    from app.models import Proposal

    with TestClient(_make_app()) as c:
        _login(c)
        _mk_user(c, "proposal-t1", "proposal-t1-pass", role=T1)
        _mk_user(c, "proposal-auditor", "proposal-auditor-pass", role=AUD)
        _mk_user(c, "proposal-responder", "proposal-responder-pass", role=RESP)

        state = _state(c)
        approve_me = Proposal(
            kind="tuning",
            payload={
                "tuning": True,
                "action": "collect_evidence",
                "reason_code": "insufficient_analyst_evidence",
                "reason": "More independent analyst labels are required.",
                "recommended_action": "Grade more cases for this rule.",
                "rule_id": "demo_rule",
                "target": "evidence_collection",
                "before": 3,
                "after": 3,
            },
            created_by="threshold_tuner",
        )
        reject_me = approve_me.model_copy(update={"id": "prop-rbac-reject"})
        c.portal.call(state.proposals.add, approve_me)
        c.portal.call(state.proposals.add, reject_me)

        for username, password in (
            ("proposal-t1", "proposal-t1-pass"),
            ("proposal-auditor", "proposal-auditor-pass"),
        ):
            c.cookies.clear()
            _login(c, username, password)
            assert c.get("/api/proposals?status=pending").status_code == 200
            assert c.post(f"/api/proposals/{approve_me.id}/approve").status_code == 403
            assert c.post(f"/api/proposals/{reject_me.id}/reject").status_code == 403

        c.cookies.clear()
        _login(c, "proposal-responder", "proposal-responder-pass")
        assert c.get("/api/proposals?status=pending").status_code == 200
        assert c.post(f"/api/proposals/{approve_me.id}/approve").status_code == 200
        assert c.post(f"/api/proposals/{reject_me.id}/reject").status_code == 200


def test_rag_and_memory_gets_require_and_honor_custom_read_grants() -> None:
    """Every knowledge GET denies without its narrow grant and accepts it via role."""
    with TestClient(_make_app()) as c:
        _login(c)
        state = _state(c)
        roles = dict(state.prefs.rbac.roles)
        roles[T1] = {"rag": [], "memory": []}
        rbac = state.prefs.rbac.model_copy(update={"roles": roles})
        c.portal.call(
            state.update_prefs,
            state.prefs.model_copy(update={"rbac": rbac}),
        )
        assert c.post("/api/roles", json={
            "name": "knowledge_reader",
            "grants": {"rag": ["read"], "memory": ["read"]},
        }).status_code == 200
        _mk_user(c, "knowledge-user", "knowledge-user-pass", role=T1)

        paths = (
            "/api/rag/stats",
            "/api/rag/documents",
            "/api/rag/documents/missing-document",
            "/api/rag/search?q=",
            "/api/memory",
        )
        c.cookies.clear()
        _login(c, "knowledge-user", "knowledge-user-pass")
        for path in paths:
            response = c.get(path)
            assert response.status_code == 403, (path, response.text)

        c.cookies.clear()
        _login(c)
        assert c.put(
            "/api/users/knowledge-user/roles",
            json={"custom_roles": ["knowledge_reader"]},
        ).status_code == 200

        c.cookies.clear()
        _login(c, "knowledge-user", "knowledge-user-pass")
        assert c.get("/api/rag/stats").status_code == 200
        assert c.get("/api/rag/documents").status_code == 200
        assert c.get("/api/rag/documents/missing-document").status_code == 404
        assert c.get("/api/rag/search?q=").status_code == 200
        assert c.get("/api/memory").status_code == 200


# --------------------------------------------------------------------------- #
# DENY — a custom role whose OWN deny removes the grant → the union still blocks.
# --------------------------------------------------------------------------- #
def test_assigned_custom_role_deny_blocks_server_side() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        # A custom role that INHERITS soc_manager (which CAN users:manage) but DENIES it.
        # Assigned on top of a tier1 base (which also lacks users:manage), so the UNION
        # grants nothing on users:manage → the route must BLOCK (deny-wins in the role).
        r = c.post("/api/roles", json={
            "name": "mgr_no_users",
            "inherits": [MGR],
            "denies": {"users": ["manage"]},
        })
        assert r.status_code == 200, r.text
        _mk_user(c, "carol", "carol-pass-1234", role=T1)

        c.cookies.clear()
        _login(c)
        assert c.put("/api/users/carol/roles", json={"custom_roles": ["mgr_no_users"]}).status_code == 200

        c.cookies.clear()
        _login(c, "carol", "carol-pass-1234")
        # The inherited soc_manager grant on cases:close DOES flow through (proves the
        # custom role is being folded in at all)…
        assert c.get("/api/_probe/cases/close").status_code == 200
        # …but the role's OWN deny on users:manage blocks it (deny-wins within the role).
        assert c.get("/api/_probe/users/manage").status_code == 403
        assert c.get("/api/users").status_code == 403


# --------------------------------------------------------------------------- #
# PARITY — a user with NO assigned custom roles is byte-identical to before.
# --------------------------------------------------------------------------- #
def test_no_assigned_custom_roles_is_byte_identical_parity() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        _mk_user(c, "dave", "dave-pass-12345", role=T1)

        c.cookies.clear()
        _login(c, "dave", "dave-pass-12345")
        # tier1's exact allow/deny set across the probe + real endpoints.
        assert c.get("/api/_probe/cases/read").status_code == 200   # tier1 may read cases
        assert c.get("/api/_probe/cases/close").status_code == 403  # tier1 may NOT close
        assert c.get("/api/_probe/users/manage").status_code == 403  # tier1 may NOT manage users
        assert c.get("/api/users").status_code == 403

        # Even with an EMPTY custom_roles bag persisted, parity is preserved (the
        # resolver drops it → falls back to the pure base-role can()).
        import anyio

        anyio.run(_set_assigned_custom_roles, c, "dave", [])

        c.cookies.clear()
        _login(c, "dave", "dave-pass-12345")
        assert c.get("/api/_probe/cases/read").status_code == 200
        assert c.get("/api/_probe/cases/close").status_code == 403
        assert c.get("/api/_probe/users/manage").status_code == 403


def test_unknown_or_deleted_assigned_role_fails_safe_to_base() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        # Grant-then-delete: create a closer role, assign it, then DELETE the role.
        c.post("/api/roles", json={"name": "closer", "inherits": [T1], "grants": {"cases": ["close"]}})
        _mk_user(c, "erin", "erin-pass-12345", role=T1)
        assert c.put("/api/users/erin/roles", json={"custom_roles": ["closer"]}).status_code == 200

        # While the role exists, erin can close (sanity that the fold works).
        c.cookies.clear()
        _login(c, "erin", "erin-pass-12345")
        assert c.get("/api/_probe/cases/close").status_code == 200

        # Delete the custom role out from under the assignment.
        c.cookies.clear()
        _login(c)
        assert c.delete("/api/roles/closer").status_code == 200

        # erin's prefs still NAME 'closer', but it no longer resolves → fail-safe to the
        # base tier1 role → cases:close is once again DENIED (never fail-open, never error).
        c.cookies.clear()
        _login(c, "erin", "erin-pass-12345")
        assert c.get("/api/_probe/cases/close").status_code == 403
        assert c.get("/api/_probe/cases/read").status_code == 200  # base role intact

        # A garbage assigned name directly in the store is likewise inert.
        import anyio

        c.cookies.clear()
        _login(c)
        anyio.run(_set_assigned_custom_roles, c, "erin", ["does_not_exist", "also_nope"])
        c.cookies.clear()
        _login(c, "erin", "erin-pass-12345")
        assert c.get("/api/_probe/cases/close").status_code == 403
        assert c.get("/api/_probe/cases/read").status_code == 200


# --------------------------------------------------------------------------- #
# LOCKOUT — super_admin can never be locked out by an assigned deny-laden role.
# --------------------------------------------------------------------------- #
def test_super_admin_cannot_be_locked_out_via_assigned_custom_role() -> None:
    with TestClient(_make_app()) as c:
        _login(c)
        # A maximally hostile custom role: deny everything it can.
        c.post("/api/roles", json={
            "name": "deny_all",
            "denies": {"users": ["manage"], "cases": ["*"], "roles": ["*"]},
        })
        # Assign it to the seeded super_admin (directly via the store; the assign route
        # would also accept it, but we bypass its lockout guard to prove can() itself
        # is immune).
        import anyio

        anyio.run(_set_assigned_custom_roles, c, "Admin", ["deny_all"])

        c.cookies.clear()
        _login(c)  # Admin is super_admin
        # super_admin stays hard-allowed everywhere despite the assigned deny-all role.
        assert c.get("/api/users").status_code == 200
        assert c.get("/api/_probe/users/manage").status_code == 200
        assert c.get("/api/_probe/cases/close").status_code == 200
        assert c.get("/api/_probe/cases/read").status_code == 200
