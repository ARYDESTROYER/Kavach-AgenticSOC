"""RBAC policy unit tests (F2) — the PURE permission core (no app/fixtures).

Exercises ``app.rbac.policy.can`` as a truth table across every role × a spread of
``resource:action`` grants, the ``super_admin`` always-allow rule, the wildcard
grant, deny-by-default for unknown roles/resources, and operator overrides
(``Preferences.rbac.roles``) deep-merging over the defaults. ``resolve_matrix`` is
checked for shape + override application.
"""

from __future__ import annotations

import pytest

from app.config import RBACConfig
from app.constants import UserRole
from app.rbac.policy import DEFAULT_MATRIX, RESOURCES, can, resolve_matrix

SA = UserRole.SUPER_ADMIN.value
MGR = UserRole.SOC_MANAGER.value
T2 = UserRole.ANALYST_TIER2.value
T1 = UserRole.ANALYST_TIER1.value
RESP = UserRole.RESPONDER.value
AUD = UserRole.AUDITOR.value


# --------------------------------------------------------------------------- #
# super_admin: always allowed, even for a never-granted action
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "resource,action",
    [("cases", "close"), ("users", "manage"), ("settings", "manage"),
     ("proposals", "approve"), ("audit", "view"), ("cases", "reinvestigate")],
)
def test_super_admin_allows_everything(resource: str, action: str) -> None:
    assert can(SA, resource, action) is True
    # Even passing the UserRole enum (not its value) works.
    assert can(UserRole.SUPER_ADMIN, resource, action) is True


def test_super_admin_cannot_be_locked_out_by_override() -> None:
    # An override that strips super_admin grants is IGNORED — it stays all-allow.
    cfg = RBACConfig(enabled=True, roles={SA: {"cases": []}})
    assert can(SA, "cases", "close", cfg) is True


# --------------------------------------------------------------------------- #
# Truth table — the key per-role expectations from the spec matrix
# --------------------------------------------------------------------------- #
TRUTH_TABLE = [
    # soc_manager: full SOC incl. user management
    (MGR, "users", "manage", True),
    (MGR, "cases", "close", True),
    (MGR, "settings", "manage", True),
    (MGR, "runbooks", "manage", True),
    # Round 14 (SPEC §3.7): only the two managing roles may publish a runbook.
    (MGR, "runbooks", "publish", True),
    (MGR, "runbooks", "run", True),
    (MGR, "audit", "export", True),
    # analyst_tier2: full case lifecycle, read-only support surfaces, runbook run
    (T2, "cases", "close", True),
    (T2, "cases", "reinvestigate", True),
    (T2, "runbooks", "run", True),
    (T2, "runbooks", "read", True),
    (T2, "runbooks", "manage", False),
    (T2, "runbooks", "publish", False),
    (T2, "metrics", "view", True),
    (T2, "cost", "view", True),
    (T2, "users", "manage", False),
    (T2, "settings", "manage", False),
    (T2, "proposals", "approve", False),
    (T2, "sources", "manage", False),
    # analyst_tier1: triage but NOT close/reinvestigate; can comment + assign
    (T1, "cases", "read", True),
    (T1, "cases", "write", True),
    (T1, "cases", "comment", True),
    (T1, "cases", "assign", True),
    (T1, "cases", "close", False),
    (T1, "cases", "reinvestigate", False),
    # Round 14 (E8): working a case's runbook checklist is the analyst's core task,
    # so tier 1 runs runbooks (it never ran the retired procedures).
    (T1, "runbooks", "run", True),
    (T1, "runbooks", "read", True),
    (T1, "runbooks", "manage", False),
    (T1, "runbooks", "publish", False),
    (T1, "proposals", "approve", False),
    # responder: tier1 + runbooks:run + proposals:approve
    (RESP, "runbooks", "run", True),
    (RESP, "runbooks", "read", True),
    (RESP, "runbooks", "manage", False),
    (RESP, "runbooks", "publish", False),
    (RESP, "proposals", "approve", True),
    (RESP, "cases", "close", False),  # responders triage/act, not close
    (RESP, "users", "manage", False),
    # auditor: read/view only — no writes/manage/approve/run anywhere
    (AUD, "cases", "read", True),
    (AUD, "metrics", "view", True),
    (AUD, "audit", "view", True),
    (AUD, "cost", "view", True),
    (AUD, "cases", "write", False),
    (AUD, "cases", "close", False),
    (AUD, "settings", "manage", False),
    (AUD, "users", "manage", False),
    (AUD, "proposals", "approve", False),
    # Round 14 (E8): the auditor is the one role that does not run runbooks.
    (AUD, "runbooks", "run", False),
    (AUD, "runbooks", "read", True),
    (AUD, "runbooks", "manage", False),
    (AUD, "runbooks", "publish", False),
    (AUD, "audit", "export", True),
]


@pytest.mark.parametrize("role,resource,action,expected", TRUTH_TABLE)
def test_can_truth_table(role: str, resource: str, action: str, expected: bool) -> None:
    assert can(role, resource, action) is expected


# --------------------------------------------------------------------------- #
# Deny-by-default
# --------------------------------------------------------------------------- #
def test_unknown_role_denies() -> None:
    assert can("not_a_role", "cases", "read") is False
    assert can("", "cases", "read") is False


def test_unknown_resource_or_action_denies() -> None:
    assert can(T1, "spaceships", "launch") is False
    assert can(T1, "cases", "launch") is False


# --------------------------------------------------------------------------- #
# Operator override (deep-merge over defaults)
# --------------------------------------------------------------------------- #
def test_override_grants_extra_action() -> None:
    # Grant tier1 the close action it normally lacks.
    cfg = RBACConfig(
        enabled=True,
        roles={T1: {"cases": ["read", "write", "comment", "assign", "close"]}},
    )
    assert can(T1, "cases", "close", cfg) is True
    # An UNMENTIONED role keeps its default (auditor still read-only).
    assert can(AUD, "cases", "close", cfg) is False
    # An UNMENTIONED resource for tier1 keeps its default.
    assert can(T1, "metrics", "view", cfg) is True


def test_override_can_revoke_an_action() -> None:
    # Override REPLACES the resource grant: removing "write" denies it.
    cfg = RBACConfig(enabled=True, roles={T1: {"cases": ["read"]}})
    assert can(T1, "cases", "read", cfg) is True
    assert can(T1, "cases", "write", cfg) is False


def test_override_ignores_unknown_resources_and_actions_leniently() -> None:
    cfg = RBACConfig(
        enabled=True,
        roles={T1: {"cases": ["read", "fly"], "unknown_resource": ["x"]}},
    )
    # Unknown action "fly" is dropped; known "read" survives; no crash.
    assert can(T1, "cases", "read", cfg) is True
    assert can(T1, "cases", "fly", cfg) is False


def test_none_rbac_config_uses_defaults() -> None:
    assert can(T2, "cases", "close", None) is True
    assert can(AUD, "cases", "close", None) is False


# --------------------------------------------------------------------------- #
# resolve_matrix shape
# --------------------------------------------------------------------------- #
def test_resolve_matrix_default_shape() -> None:
    m = resolve_matrix(None)
    # Every known role present.
    assert set(m.keys()) == {r.value for r in UserRole}
    # super_admin shows a full grant (wildcard expands per resource in DEFAULT_MATRIX).
    assert "cases" in m[SA]
    # Actions are JSON-friendly lists.
    assert isinstance(m[T1]["cases"], list)
    assert "read" in m[T1]["cases"]


def test_resolve_matrix_applies_override() -> None:
    cfg = RBACConfig(enabled=True, roles={T1: {"cases": ["read"]}})
    m = resolve_matrix(cfg)
    assert m[T1]["cases"] == ["read"]
    # Default matrix constant is NOT mutated.
    assert "write" in DEFAULT_MATRIX[T1]["cases"]


def test_default_matrix_covers_all_resources_for_super_admin() -> None:
    # super_admin's default grant lists every known resource.
    assert set(DEFAULT_MATRIX[SA].keys()) == set(RESOURCES.keys())
