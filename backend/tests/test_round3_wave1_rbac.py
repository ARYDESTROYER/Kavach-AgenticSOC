"""Round-3 Wave-1 RBAC ladder tests (NIST RBAC + custom roles + deny-wins + the
opt-in object-scope hook).

The headline guarantee is a PARITY test: with NO custom config present, the six
built-in roles' :func:`app.rbac.policy.can` results are byte-identical to the prior
(pre-Wave-1) behaviour across the FULL ``RESOURCES x actions`` grid. Because the new
narrow resources are derived from each role's old ``settings`` grant, this also pins
the migration as behaviour-neutral.

Then: custom-role inheritance (incl. a cycle guard), deny-wins precedence, and
super_admin lockout-proofing; plus the object-scope hook being inert when OFF and
enforcing the whitelisted vocabulary when ON.
"""

from __future__ import annotations

import pytest

from app.config import RBACConfig
from app.constants import UserRole
from app.rbac.policy import (
    ALL,
    DEFAULT_MATRIX,
    RESOURCES,
    can,
    can_object,
    effective_matrix,
    resolve_matrix,
)

SA = UserRole.SUPER_ADMIN.value
MGR = UserRole.SOC_MANAGER.value
T2 = UserRole.ANALYST_TIER2.value
T1 = UserRole.ANALYST_TIER1.value
RESP = UserRole.RESPONDER.value
AUD = UserRole.AUDITOR.value
ALL_ROLES = [SA, MGR, T2, T1, RESP, AUD]

# The narrow resources split out of ``settings`` this wave (must be reachable + obey
# the parity rule below).
NARROW = [
    "notifications", "branding", "sessions", "demo", "terminology",
    "automation", "roles", "models", "enrichment", "inapp",
]


# --------------------------------------------------------------------------- #
# (A) PARITY — the built-in roles' can() over the FULL grid is identical to a
# matrix computed WITHOUT any custom config. This is the byte-identical guarantee.
# --------------------------------------------------------------------------- #
def _full_grid() -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for res, acts in RESOURCES.items():
        for act in acts:
            pairs.append((res, act))
        # also probe the wildcard + a never-defined action (deny path)
        pairs.append((res, "definitely_not_an_action"))
    pairs.append(("nonexistent_resource", "read"))
    return pairs


def test_no_config_can_equals_default_matrix_only() -> None:
    """For every built-in role across the full grid, can(role, …) with NO rbac_config
    matches a hand-evaluation against DEFAULT_MATRIX (the pre-Wave-1 semantics)."""
    grid = _full_grid()
    for role in ALL_ROLES:
        for res, act in grid:
            got = can(role, res, act)  # no rbac_config → pure defaults
            # Reference: super_admin always True; else look in DEFAULT_MATRIX.
            if role == SA:
                ref = True
            else:
                acts = DEFAULT_MATRIX.get(role, {}).get(res)
                ref = bool(acts) and (ALL in acts or act in acts)
            assert got is ref, f"parity break: {role} {res}:{act} got={got} ref={ref}"


def test_resolve_matrix_no_config_is_default_matrix() -> None:
    """resolve_matrix(None) is byte-identical to DEFAULT_MATRIX (no custom rows)."""
    m = resolve_matrix(None)
    assert set(m.keys()) == {r.value for r in UserRole}
    assert m == DEFAULT_MATRIX


def test_effective_matrix_empty_is_default() -> None:
    assert effective_matrix() == DEFAULT_MATRIX
    assert effective_matrix({}, []) == DEFAULT_MATRIX
    assert effective_matrix(None, None, resources=None, denies=None) == DEFAULT_MATRIX


def test_default_matrix_super_admin_covers_every_resource() -> None:
    assert set(DEFAULT_MATRIX[SA].keys()) == set(RESOURCES.keys())


# --------------------------------------------------------------------------- #
# (B) The settings→narrow split PRESERVES per-role behaviour.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("res", NARROW)
def test_narrow_resources_mirror_settings_manage(res: str) -> None:
    """Whoever could settings:manage today can manage each narrow resource; whoever
    only had settings:read keeps read; the auditor never gets manage."""
    for role in ALL_ROLES:
        could_manage = can(role, "settings", "manage")
        could_read = can(role, "settings", "read")
        assert can(role, res, "manage") is could_manage
        assert can(role, res, "read") is could_read


def test_only_super_admin_and_manager_manage_narrow_resources() -> None:
    for res in NARROW:
        assert can(SA, res, "manage") is True
        assert can(MGR, res, "manage") is True
        assert can(T2, res, "manage") is False
        assert can(T1, res, "manage") is False
        assert can(RESP, res, "manage") is False
        assert can(AUD, res, "manage") is False
        # read tiers keep visibility
        assert can(AUD, res, "read") is True


# --------------------------------------------------------------------------- #
# (C) Custom roles — inheritance, additive grants, own denies, cycle guard.
# --------------------------------------------------------------------------- #
def test_custom_role_inherits_base() -> None:
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[{
            "name": "tier1_plus_close",
            "inherits": [T1],
            "grants": {"cases": ["close"]},
        }],
    )
    # inherits tier1's grants…
    assert can("tier1_plus_close", "cases", "read", cfg) is True
    assert can("tier1_plus_close", "cases", "write", cfg) is True
    # …PLUS the additive grant tier1 lacks.
    assert can("tier1_plus_close", "cases", "close", cfg) is True
    # but NOT something nobody granted it.
    assert can("tier1_plus_close", "users", "manage", cfg) is False
    # the new role shows up in the resolved matrix.
    assert "tier1_plus_close" in resolve_matrix(cfg)


def test_custom_role_multi_inherit_unions() -> None:
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[{
            "name": "blend",
            "inherits": [AUD, RESP],  # auditor (read-only) ∪ responder (run/approve)
        }],
    )
    assert can("blend", "runbooks", "run", cfg) is True        # from responder
    assert can("blend", "proposals", "approve", cfg) is True   # from responder
    assert can("blend", "audit", "view", cfg) is True          # from auditor


def test_custom_role_chained_inheritance() -> None:
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[
            {"name": "mid", "inherits": [T1], "grants": {"cases": ["close"]}},
            {"name": "top", "inherits": ["mid"], "grants": {"cases": ["reinvestigate"]}},
        ],
    )
    assert can("top", "cases", "read", cfg) is True   # tier1 via mid
    assert can("top", "cases", "close", cfg) is True  # mid's grant
    assert can("top", "cases", "reinvestigate", cfg) is True


def test_custom_role_retired_procedure_grant_resolves_as_its_runbook_alias() -> None:
    """Round 14 (SPEC §3.7): a custom role stored with the retired ``playbooks``
    vocabulary keeps its meaning through inheritance: ``playbooks:run`` resolves as
    ``runbooks:run`` (never silently dropped), and grants nothing it did not mean."""
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[
            {"name": "mid", "inherits": [AUD]},
            {"name": "top", "inherits": ["mid"], "grants": {"playbooks": ["run"]}},
        ],
    )
    assert can("top", "runbooks", "run", cfg) is True
    assert can("top", "runbooks", "manage", cfg) is False
    assert can("top", "runbooks", "publish", cfg) is False


def test_custom_role_cycle_is_safe() -> None:
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[
            {"name": "a", "inherits": ["b"], "grants": {"cases": ["read"]}},
            {"name": "b", "inherits": ["a"], "grants": {"metrics": ["view"]}},
        ],
    )
    # No infinite recursion; each role at least keeps its OWN grant.
    assert can("a", "cases", "read", cfg) is True
    assert can("b", "metrics", "view", cfg) is True


def test_custom_role_cannot_shadow_base_role() -> None:
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[{"name": AUD, "grants": {"cases": ["close"]}}],
    )
    # The collision is dropped → auditor stays the built-in read-only role.
    assert can(AUD, "cases", "close", cfg) is False


def test_custom_role_own_deny_wins_over_inherited_grant() -> None:
    cfg = RBACConfig(
        enabled=True,
        custom_roles=[{
            "name": "manager_no_users",
            "inherits": [MGR],
            "denies": {"users": ["manage"]},
        }],
    )
    assert can("manager_no_users", "cases", "close", cfg) is True   # inherited
    assert can("manager_no_users", "users", "manage", cfg) is False  # own deny wins


# --------------------------------------------------------------------------- #
# (D) Deny-wins — global Preferences.rbac.denies, applied LAST.
# --------------------------------------------------------------------------- #
def test_global_deny_revokes_a_default_grant() -> None:
    cfg = RBACConfig(enabled=True, denies={T2: {"cases": ["close"]}})
    assert can(T2, "cases", "close", cfg) is False
    # other actions untouched.
    assert can(T2, "cases", "write", cfg) is True


def test_deny_wins_over_explicit_allow_override() -> None:
    # roles override GRANTS close, but a deny on the same action wins.
    cfg = RBACConfig(
        enabled=True,
        roles={T1: {"cases": ["read", "write", "close"]}},
        denies={T1: {"cases": ["close"]}},
    )
    assert can(T1, "cases", "write", cfg) is True
    assert can(T1, "cases", "close", cfg) is False  # deny-wins


def test_deny_wildcard_collapses_a_wildcard_grant() -> None:
    # soc_manager has cases:[*]; a wildcard deny on cases removes everything there.
    cfg = RBACConfig(enabled=True, denies={MGR: {"cases": [ALL]}})
    assert can(MGR, "cases", "read", cfg) is False
    assert can(MGR, "cases", "close", cfg) is False
    # a different resource is unaffected.
    assert can(MGR, "sources", "manage", cfg) is True


def test_narrow_deny_bites_a_wildcard_grant() -> None:
    # soc_manager has notifications:[*]; deny just 'manage' → keeps read, loses manage.
    cfg = RBACConfig(enabled=True, denies={MGR: {"notifications": ["manage"]}})
    assert can(MGR, "notifications", "read", cfg) is True
    assert can(MGR, "notifications", "manage", cfg) is False


# --------------------------------------------------------------------------- #
# (E) super_admin lockout-proofing — neither a deny nor an override can lock it out.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("res,act", [("cases", "close"), ("users", "manage"),
                                     ("roles", "manage"), ("settings", "manage")])
def test_super_admin_immune_to_deny(res: str, act: str) -> None:
    cfg = RBACConfig(
        enabled=True,
        denies={SA: {res: [ALL]}},
        roles={SA: {res: []}},
    )
    assert can(SA, res, act, cfg) is True
    # The resolved matrix also leaves super_admin's row intact (no self-lockout shown).
    m = resolve_matrix(cfg)
    assert m[SA].get(res)  # still a non-empty grant


def test_super_admin_immune_via_custom_deny_attempt() -> None:
    # Even a fully hostile config can't strip the owner.
    cfg = RBACConfig(
        enabled=True,
        denies={r: {res: [ALL]} for r in [SA] for res in RESOURCES},
    )
    for res, acts in RESOURCES.items():
        for act in acts:
            assert can(SA, res, act, cfg) is True


# --------------------------------------------------------------------------- #
# (F) Object-scope hook — inert when OFF, enforces the whitelist when ON.
# --------------------------------------------------------------------------- #
class _U:
    def __init__(self, username: str, role: str, **extra) -> None:
        self.username = username
        self.role = role
        for k, v in extra.items():
            setattr(self, k, v)


# NOTE: the object-scope flags (``object_scoping_enabled`` / ``object_scope``) are NOT
# yet fields on ``RBACConfig`` (config.py is frozen this wave; the integrator adds
# them). ``can_object`` reads its config leniently via attr-or-dict, so these tests
# pass a plain DICT carrier — which is exactly what the integrator's RBACConfig will
# look like once the fields land, and proves the hook works against either shape.
def test_can_object_defers_to_can_when_disabled() -> None:
    # Default config: object_scoping_enabled is OFF → can_object == can.
    cfg = RBACConfig(enabled=True)
    u = _U("alice", T2)
    case = {"owner": "bob"}  # NOT alice's — but scoping is off, so it doesn't matter.
    assert can_object(u, "cases", "close", case, {}, cfg) is True
    # And a coarse-denied action is still denied.
    assert can_object(u, "users", "manage", case, {}, cfg) is False
    # A dict carrier WITHOUT the flag also defers (flag defaults OFF).
    assert can_object(u, "cases", "close", case, {}, {"enabled": True}) is True


def test_can_object_owner_condition_when_enabled() -> None:
    cfg = {
        "enabled": True,
        "object_scoping_enabled": True,
        "object_scope": {T2: {"cases": ["owner"]}},
    }
    u = _U("alice", T2)
    own = {"owner": "alice"}
    other = {"owner": "bob"}
    assert can_object(u, "cases", "close", own, {}, cfg) is True
    assert can_object(u, "cases", "close", other, {}, cfg) is False
    # A RESOURCE-level binding applies to EVERY action on that resource — so read is
    # scoped too (still requires the coarse allow first).
    assert can_object(u, "cases", "read", own, {}, cfg) is True
    assert can_object(u, "cases", "read", other, {}, cfg) is False
    # A resource WITHOUT any binding is unrestricted.
    assert can_object(u, "cases", "comment", own, {}, cfg) is True
    assert can_object(u, "metrics", "view", other, {}, cfg) is True


def test_can_object_assignee_action_specific_binding() -> None:
    cfg = {
        "enabled": True,
        "object_scoping_enabled": True,
        "object_scope": {T2: {"cases:close": ["assignee"]}},
    }
    u = _U("alice", T2)
    assert can_object(u, "cases", "close", {"assignee": "alice"}, {}, cfg) is True
    assert can_object(u, "cases", "close", {"assignee": "bob"}, {}, cfg) is False
    # write has no action-specific or generic binding → unrestricted.
    assert can_object(u, "cases", "write", {"assignee": "bob"}, {}, cfg) is True


def test_can_object_unknown_condition_fails_closed() -> None:
    cfg = {
        "enabled": True,
        "object_scoping_enabled": True,
        "object_scope": {T2: {"cases": ["not_a_real_condition"]}},
    }
    u = _U("alice", T2)
    assert can_object(u, "cases", "close", {"owner": "alice"}, {}, cfg) is False


def test_can_object_super_admin_unconditional() -> None:
    cfg = {
        "enabled": True,
        "object_scoping_enabled": True,
        "object_scope": {SA: {"cases": ["owner"]}},
    }
    u = _U("root", SA)
    assert can_object(u, "cases", "close", {"owner": "someone_else"}, {}, cfg) is True


def test_can_object_source_scope_and_severity() -> None:
    cfg = {
        "enabled": True,
        "object_scoping_enabled": True,
        "object_scope": {T2: {"cases": ["source_scope", "severity_at_most"]}},
    }
    u = _U("alice", T2, source_scope=["src-a", "src-b"])
    in_scope_low = {"source_id": "src-a", "severity": 3}
    in_scope_high = {"source_id": "src-a", "severity": 9}
    out_scope = {"source_id": "src-z", "severity": 1}
    assert can_object(u, "cases", "close", in_scope_low, {"max_severity": 5}, cfg) is True
    assert can_object(u, "cases", "close", in_scope_high, {"max_severity": 5}, cfg) is False
    assert can_object(u, "cases", "close", out_scope, {"max_severity": 5}, cfg) is False
