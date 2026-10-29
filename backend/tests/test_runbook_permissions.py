"""Round 14 runbook permissions and the retired-vocabulary aliases (SPEC §3.7, E8).

Pins, layer by layer, that a grant or deny stored in the retired procedure vocabulary
keeps its meaning as the runbook vocabulary: the default matrix, ``Preferences.rbac``
(``roles`` REPLACE layer, ``resources`` additive layer, ``denies``, embedded custom
roles), the custom-role KV store, and every body ``routes_roles`` accepts. The new
``runbooks:publish`` is granted once (and stamped) to every stored layer that could
manage runbooks before Round 14, so no role silently loses the ability to make runbook
text trusted, and denied the same way, so none silently gains it.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from app.config import Preferences, RBACConfig
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.models import CustomRole
from app.rbac.policy import (
    ALL,
    DEFAULT_MATRIX,
    RBAC_GRANTS_VERSION,
    RESOURCES,
    can,
    grants_version_is_legacy,
    normalise_custom_role,
    normalise_denies,
    normalise_grants,
    normalise_role_grant_map,
    resolve_matrix,
)
from app.stores.base import KVStore
from app.stores.custom_roles import (
    GRANTS_VERSION_FIELD,
    CustomRoleExists,
    CustomRoleMissing,
    CustomRoleStore,
)
from app.stores.memory import EsKVStore

SA = UserRole.SUPER_ADMIN.value
MGR = UserRole.SOC_MANAGER.value
T2 = UserRole.ANALYST_TIER2.value
T1 = UserRole.ANALYST_TIER1.value
RESP = UserRole.RESPONDER.value
AUD = UserRole.AUDITOR.value
ROLES = (SA, MGR, T2, T1, RESP, AUD)


def _persisted_rbac(**layers: Any) -> dict[str, Any]:
    """An ``RBACConfig`` block as a build before Round 14 stored it: every key of the
    dump, and no ``rbac_grants_version``."""
    block: dict[str, Any] = {
        "enabled": True, "default_role": T1, "roles": {}, "custom_roles": [],
        "resources": {}, "denies": {},
    }
    block.update(layers)
    return block


def _allowed(cfg: Any, role: str, resource: str, action: str) -> bool:
    return can(role, resource, action, cfg)


# --------------------------------------------------------------------------- #
# The default matrix (§3.7 step 1 holders; E8).
# --------------------------------------------------------------------------- #
def test_runbook_actions_and_default_holders() -> None:
    assert RESOURCES["runbooks"] == ["read", "run", "manage", "publish"]
    assert RESOURCES["audit"] == ["view", "export"]
    for role in ROLES:
        assert can(role, "runbooks", "read") is True, role
    # runbooks:run for every role except the auditor (E8).
    assert {r for r in ROLES if can(r, "runbooks", "run")} == {SA, MGR, T2, T1, RESP}
    # manage and publish for the two managing roles only.
    assert {r for r in ROLES if can(r, "runbooks", "manage")} == {SA, MGR}
    assert {r for r in ROLES if can(r, "runbooks", "publish")} == {SA, MGR}
    # audit:export for super admin, SOC manager and auditor (D5).
    assert {r for r in ROLES if can(r, "audit", "export")} == {SA, MGR, AUD}


def test_the_default_matrix_is_a_fixed_point_of_the_aliases() -> None:
    """Normalising the shipped matrix changes nothing: every default role's runbook
    grant already covers what its retired procedure grant meant."""
    for role, row in DEFAULT_MATRIX.items():
        assert normalise_grants(row) == row, role
        assert normalise_grants(row, legacy=True) == row, role


# --------------------------------------------------------------------------- #
# The pure mapping.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "stored,expected",
    [
        ({"playbooks": ["read"]}, ["read"]),
        ({"playbooks": ["run"]}, ["run"]),
        ({"playbooks": ["manage"]}, ["manage", "publish"]),
        ({"playbooks": ["read", "run", "manage"]}, ["read", "run", "manage", "publish"]),
        ({"playbooks": [ALL]}, [ALL]),
    ],
)
def test_grant_alias_mapping(stored: dict[str, list[str]], expected: list[str]) -> None:
    out = normalise_grants(stored)
    assert out["runbooks"] == expected
    assert out["playbooks"] == stored["playbooks"]  # kept until §3.7 step 3


def test_a_legacy_map_unions_the_alias_into_an_existing_runbook_entry() -> None:
    """Before Round 14 the two were separate resources: a stored map holding both
    keeps what each meant, and the alias never replaces the ``runbooks`` entry."""
    out = normalise_grants({"runbooks": ["read"], "playbooks": ["run"]}, legacy=True)
    assert out["runbooks"] == ["read", "run"]
    out = normalise_grants({"runbooks": [ALL], "playbooks": ["read"]}, legacy=True)
    assert out["runbooks"] == [ALL]
    out = normalise_denies({"runbooks": ["read"], "playbooks": ["run"]}, legacy=True)
    assert out["runbooks"] == ["read", "run"]


def test_in_the_current_vocabulary_a_present_runbook_entry_is_authoritative() -> None:
    """A stamped map, a constructed one and a request body are current vocabulary:
    the ``playbooks`` key a legacy load kept beside ``runbooks`` (its meaning already
    unioned in) never widens a later narrowing of ``runbooks`` again, and never keeps
    a lifted ``runbooks`` deny alive. The alias still maps when ``runbooks`` is
    absent, and the ``playbooks`` key itself is left as it was."""
    stale = {"playbooks": ["read", "run", "manage"], "runbooks": ["read"]}
    out = normalise_grants(stale)
    assert out == stale
    assert normalise_grants({"playbooks": ["run"], "runbooks": []})["runbooks"] == []
    assert normalise_denies({"playbooks": ["run"], "runbooks": []})["runbooks"] == []
    assert normalise_denies({"playbooks": [ALL], "runbooks": ["manage"]})["runbooks"] == ["manage"]
    # Absent (or null) ``runbooks``: the alias maps as always.
    assert normalise_grants({"playbooks": ["run"]})["runbooks"] == ["run"]
    assert normalise_grants({"playbooks": ["run"], "runbooks": None})["runbooks"] == ["run"]
    assert normalise_denies({"playbooks": ["manage"]})["runbooks"] == ["manage", "publish"]


def test_the_once_only_publish_rule_applies_to_legacy_maps_only() -> None:
    assert normalise_grants({"runbooks": ["read", "manage"]})["runbooks"] == ["read", "manage"]
    assert normalise_grants({"runbooks": ["read", "manage"]}, legacy=True)["runbooks"] == [
        "read", "manage", "publish",
    ]
    assert normalise_denies({"runbooks": ["manage"]})["runbooks"] == ["manage"]
    assert normalise_denies({"runbooks": ["manage"]}, legacy=True)["runbooks"] == ["manage", "publish"]


@pytest.mark.parametrize(
    "stored,expected",
    [
        ({"playbooks": ["read"]}, ["read"]),
        ({"playbooks": ["run"]}, ["run"]),
        ({"playbooks": ["manage"]}, ["manage", "publish"]),
        ({"playbooks": [ALL]}, [ALL]),
    ],
)
def test_deny_alias_mapping(stored: dict[str, list[str]], expected: list[str]) -> None:
    assert normalise_denies(stored)["runbooks"] == expected


def test_the_mapping_is_pure_and_idempotent() -> None:
    stored = {"playbooks": ["read", "manage"], "cases": ["read"]}
    snapshot = copy.deepcopy(stored)
    once = normalise_grants(stored, legacy=True)
    assert stored == snapshot
    assert normalise_grants(once, legacy=True) == once
    assert normalise_denies(normalise_denies(stored, legacy=True), legacy=True) == normalise_denies(
        stored, legacy=True
    )
    # Malformed values pass through untouched for the lenient resolvers.
    assert normalise_grants(None) is None
    assert normalise_grants({"runbooks": "manage", "playbooks": ["run"]})["runbooks"] == "manage"
    assert normalise_role_grant_map(["x"]) == ["x"]
    assert normalise_custom_role("x") == "x"


def test_grants_version_stamp() -> None:
    assert RBAC_GRANTS_VERSION == 2
    for value in (None, 0, 1, "2", True):
        assert grants_version_is_legacy(value) is True
    assert grants_version_is_legacy(2) is False
    assert grants_version_is_legacy(3) is False


# --------------------------------------------------------------------------- #
# Every grant layer of Preferences.rbac (§3.7 tests).
# --------------------------------------------------------------------------- #
def test_a_stored_deny_of_the_retired_run_leaves_the_role_without_runbooks_run() -> None:
    cfg = RBACConfig.model_validate(_persisted_rbac(denies={T2: {"playbooks": ["run"]}}))
    assert _allowed(cfg, T2, "runbooks", "run") is False
    assert _allowed(cfg, T2, "runbooks", "read") is True
    # The same deny written today (not a stored legacy block) means the same.
    cfg = RBACConfig(enabled=True, denies={T2: {"playbooks": ["run"]}})
    assert _allowed(cfg, T2, "runbooks", "run") is False


def test_a_roles_override_holding_both_vocabularies_unions_them() -> None:
    cfg = RBACConfig.model_validate(_persisted_rbac(
        roles={T1: {"playbooks": ["run"], "runbooks": ["read"]}},
    ))
    assert cfg.roles[T1]["runbooks"] == ["read", "run"]
    assert _allowed(cfg, T1, "runbooks", "read") is True
    assert _allowed(cfg, T1, "runbooks", "run") is True
    assert _allowed(cfg, T1, "runbooks", "manage") is False


@pytest.mark.parametrize(
    ("override", "role", "expected"),
    [
        # Took procedure management away from managers; their runbook management
        # (default ``*``) was untouched before Round 14 and stays so.
        ({MGR: {"playbooks": ["read", "run"]}}, MGR, {"read", "run", "manage", "publish"}),
        ({MGR: {"playbooks": ["read"]}}, MGR, {"read", "run", "manage", "publish"}),
        # Gave tier 2 runbook management; it still ran procedures by default.
        ({T2: {"runbooks": ["read", "manage"]}}, T2, {"read", "run", "manage", "publish"}),
        # Narrowed the procedure grant: the narrowing is kept, nothing is gained.
        ({T2: {"playbooks": ["read"]}}, T2, {"read"}),
        ({RESP: {"playbooks": ["read"]}}, RESP, {"read"}),
        ({AUD: {"runbooks": ["read"]}}, AUD, {"read"}),
    ],
)
def test_a_stored_roles_override_naming_one_procedure_resource_keeps_the_other(
    override: dict[str, Any], role: str, expected: set[str],
) -> None:
    """The ``roles`` layer REPLACES per resource. Before Round 14 an override naming
    only one of the two procedure resources left the other at its default; folding
    the alias into ``runbooks`` alone would narrow the role (E8)."""
    cfg = RBACConfig.model_validate(_persisted_rbac(roles=override))
    matrix = resolve_matrix(cfg)
    granted = set(matrix[role]["runbooks"])
    if ALL in granted:
        granted = set(RESOURCES["runbooks"])
    assert granted == expected
    for action in RESOURCES["runbooks"]:
        assert _allowed(cfg, role, "runbooks", action) is (action in expected), action


def test_a_custom_role_inheriting_an_overridden_role_keeps_every_capability() -> None:
    cfg = RBACConfig.model_validate(_persisted_rbac(
        roles={MGR: {"playbooks": ["read", "run"]}},
        custom_roles=[{"name": "lead", "inherits": [MGR], "grants": {}, "denies": {}}],
    ))
    for action in ("read", "run", "manage", "publish"):
        assert _allowed(cfg, "lead", "runbooks", action) is True, action


def test_a_current_roles_override_is_read_as_the_alias_and_a_narrowing_sticks() -> None:
    """A stamped block is in the current vocabulary: ``playbooks`` is only an alias,
    nothing is filled in, so a narrowing written today stays a narrowing."""
    stamped = _persisted_rbac(roles={MGR: {"runbooks": ["read"]}})
    stamped["rbac_grants_version"] = RBAC_GRANTS_VERSION
    cfg = RBACConfig.model_validate(stamped)
    assert cfg.roles[MGR] == {"runbooks": ["read"]}
    assert _allowed(cfg, MGR, "runbooks", "manage") is False
    # The first load of a legacy block fills the other resource once; the stamped
    # result loads unchanged.
    legacy = RBACConfig.model_validate(_persisted_rbac(roles={MGR: {"playbooks": ["read"]}}))
    assert legacy.roles[MGR] == {"playbooks": ["read"], "runbooks": [ALL]}
    assert RBACConfig.model_validate(legacy.model_dump(mode="json")).roles == legacy.roles


def test_a_narrowing_of_runbooks_sticks_beside_the_playbooks_key_a_legacy_load_kept() -> None:
    """Every later validation of a loaded legacy block is current vocabulary, so a
    narrowing written as ``runbooks`` (the settings PUT deep-merges ``rbac.roles``, so
    the stale ``playbooks`` key always survives it) is not undone by the alias."""
    legacy = RBACConfig.model_validate(_persisted_rbac(
        roles={T2: {"playbooks": ["read", "run"]}},
        denies={T1: {"playbooks": ["run"]}},
        custom_roles=[{"name": "owner", "inherits": [], "denies": {},
                       "grants": {"playbooks": ["read", "run", "manage"]}}],
    ))
    assert legacy.roles[T2] == {"playbooks": ["read", "run"], "runbooks": ["read", "run"]}
    assert _allowed(legacy, T2, "runbooks", "run") is True
    assert _allowed(legacy, T1, "runbooks", "run") is False
    assert _allowed(legacy, "owner", "runbooks", "publish") is True
    dumped = legacy.model_dump(mode="json")
    dumped["roles"][T2]["runbooks"] = ["read"]
    dumped["denies"][T1]["runbooks"] = []
    dumped["custom_roles"][0]["grants"]["runbooks"] = ["read"]
    narrowed = RBACConfig.model_validate(dumped)
    assert narrowed.roles[T2] == {"playbooks": ["read", "run"], "runbooks": ["read"]}
    assert _allowed(narrowed, T2, "runbooks", "run") is False
    assert _allowed(narrowed, T2, "runbooks", "read") is True
    # A lifted deny is lifted.
    assert _allowed(narrowed, T1, "runbooks", "run") is True
    assert _allowed(narrowed, "owner", "runbooks", "publish") is False
    assert _allowed(narrowed, "owner", "runbooks", "read") is True
    # Stable through a further save and load.
    again = RBACConfig.model_validate(narrowed.model_dump(mode="json"))
    assert resolve_matrix(again) == resolve_matrix(narrowed)


def test_a_narrowing_through_the_settings_put_sticks_after_a_legacy_load(client) -> None:
    """The reviewer's path end to end: a stored pre-Round 14 override loads (both
    keys kept), an administrator narrows ``runbooks`` with a partial
    ``PUT /api/settings`` (deep-merged over the stored document), and the effective
    grant follows the narrowing."""
    state = client.app.state.tlsoc
    data = state.prefs.model_dump(mode="json")
    data["rbac"] = _persisted_rbac(roles={T2: {"playbooks": ["read", "run"]}})
    loaded = Preferences.model_validate(data)
    assert loaded.rbac.roles[T2]["runbooks"] == ["read", "run"]
    client.portal.call(state.update_prefs, loaded)
    assert can(T2, "runbooks", "run", state.prefs.rbac) is True
    r = client.put("/api/settings", json={"rbac": {"roles": {T2: {"runbooks": ["read"]}}}})
    assert r.status_code == 200, r.text
    roles = r.json()["prefs"]["rbac"]["roles"]
    assert roles[T2] == {"playbooks": ["read", "run"], "runbooks": ["read"]}
    assert can(T2, "runbooks", "run", state.prefs.rbac) is False
    assert can(T2, "runbooks", "read", state.prefs.rbac) is True


def test_a_resources_layer_grant_of_the_retired_manage_yields_publish() -> None:
    cfg = RBACConfig.model_validate(_persisted_rbac(resources={T2: {"playbooks": ["manage"]}}))
    assert _allowed(cfg, T2, "runbooks", "manage") is True
    assert _allowed(cfg, T2, "runbooks", "publish") is True
    # Also when the layer is written today: the alias is permanent.
    cfg = RBACConfig(enabled=True, resources={T2: {"playbooks": ["manage"]}})
    assert _allowed(cfg, T2, "runbooks", "publish") is True


def test_a_deny_of_the_retired_manage_also_denies_publish() -> None:
    cfg = RBACConfig.model_validate(_persisted_rbac(denies={MGR: {"playbooks": ["manage"]}}))
    assert _allowed(cfg, MGR, "runbooks", "manage") is False
    assert _allowed(cfg, MGR, "runbooks", "publish") is False
    assert _allowed(cfg, MGR, "runbooks", "read") is True


def test_a_stored_runbooks_manage_grant_gains_publish_once_and_a_later_removal_sticks() -> None:
    # Before Round 14 ``runbooks`` held only read and manage (no run, no publish).
    stored = _persisted_rbac(roles={T2: {"runbooks": ["read", "manage"]}})
    cfg = RBACConfig.model_validate(stored)
    assert cfg.rbac_grants_version == RBAC_GRANTS_VERSION
    assert _allowed(cfg, T2, "runbooks", "publish") is True
    # (``run`` comes from the procedure default the override left in place.)
    assert cfg.roles[T2]["runbooks"] == ["read", "manage", "run", "publish"]
    # The administrator removes publish; the stamped block keeps that choice through a
    # save and a load.
    dumped = cfg.model_dump(mode="json")
    dumped["roles"][T2]["runbooks"] = ["read", "run", "manage"]
    again = RBACConfig.model_validate(dumped)
    assert again.roles[T2]["runbooks"] == ["read", "run", "manage"]
    assert _allowed(again, T2, "runbooks", "publish") is False
    # A stored legacy deny of runbooks:manage also denies publish (no silent gain).
    cfg = RBACConfig.model_validate(_persisted_rbac(denies={MGR: {"runbooks": ["manage"]}}))
    assert _allowed(cfg, MGR, "runbooks", "publish") is False


@pytest.mark.parametrize("layer, value", [
    ("roles", {T2: {"runbooks": ["read", "run"]}}),
    ("roles", {AUD: {"audit": ["view", "export"]}}),
    ("resources", {AUD: {"runbooks": ["publish"]}}),
    ("denies", {T2: {"runbooks": ["run"]}}),
    ("custom_roles", [{"name": "author", "inherits": [], "grants": {"runbooks": ["read", "run"]},
                       "denies": {}}]),
    ("custom_roles", [{"name": "no_export", "inherits": [AUD], "grants": {},
                       "denies": {"audit": ["export"]}}]),
])
def test_a_round14_block_without_its_stamp_is_still_read_in_the_current_vocabulary(
    layer: str, value: Any,
) -> None:
    """A build from before Round 14 drops the unknown stamp on its next save but keeps
    every grant and deny map. A block that names an action only Round 14 has (in any
    layer) was written in the current vocabulary, so a downgrade, a save and a
    re-upgrade never re-run the once-only rules over it: the manager narrowed to
    ``read`` keeps exactly that."""
    narrowed = _persisted_rbac(roles={MGR: {"runbooks": ["read"]}})
    if layer == "roles":
        narrowed["roles"].update(value)
    else:
        narrowed[layer] = value
    narrowed["rbac_grants_version"] = RBAC_GRANTS_VERSION
    current = RBACConfig.model_validate(narrowed)
    assert resolve_matrix(current)[MGR]["runbooks"] == ["read"]
    dumped = current.model_dump(mode="json")
    del dumped["rbac_grants_version"]  # what the older build's save writes
    again = RBACConfig.model_validate(dumped)
    assert (again.roles, again.resources, again.denies, again.custom_roles) == (
        current.roles, current.resources, current.denies, current.custom_roles,
    )
    assert resolve_matrix(again) == resolve_matrix(current)
    assert _allowed(again, MGR, "runbooks", "publish") is False
    assert _allowed(again, MGR, "runbooks", "manage") is False


def test_a_stampless_block_in_only_the_old_words_is_read_as_written_before_round14() -> None:
    """The known limit of the guard: a block that names only actions every version had
    (``read``, ``manage``) cannot be told apart from one written before Round 14 once
    the stamp is gone, so the once-only rules apply to it (the documented downgrade
    limit)."""
    stampless = _persisted_rbac(roles={MGR: {"runbooks": ["read"]}})
    cfg = RBACConfig.model_validate(stampless)
    assert _allowed(cfg, MGR, "runbooks", "manage") is True  # the frozen default restored


def test_a_round14_narrowing_survives_a_downgrade_save_through_preferences() -> None:
    """The reviewer's round trip end to end: Round 14 narrows the manager to read and
    run, an older build saves without the stamp, Round 14 loads it again."""
    prefs = Preferences.model_validate({})
    data = prefs.model_dump(mode="json")
    data["rbac"]["enabled"] = True
    data["rbac"]["roles"] = {MGR: {"runbooks": ["read", "run"]}}
    stored = Preferences.model_validate(data).model_dump(mode="json")
    del stored["rbac"]["rbac_grants_version"]
    again = Preferences.model_validate(stored)
    assert again.rbac.roles[MGR] == {"runbooks": ["read", "run"]}
    assert _allowed(again.rbac, MGR, "runbooks", "publish") is False
    assert _allowed(again.rbac, MGR, "runbooks", "manage") is False


def test_a_constructed_block_is_read_in_the_current_vocabulary() -> None:
    """Code and tests build a block with a subset of keys: no once-only rule, so a
    ``runbooks:manage`` grant made today does not imply ``publish``."""
    cfg = RBACConfig(enabled=True, roles={T2: {"runbooks": ["read", "manage"]}})
    assert _allowed(cfg, T2, "runbooks", "manage") is True
    assert _allowed(cfg, T2, "runbooks", "publish") is False


def test_embedded_custom_roles_keep_every_capability() -> None:
    cfg = RBACConfig.model_validate(_persisted_rbac(custom_roles=[
        {"name": "procedure_owner", "inherits": [AUD],
         "grants": {"playbooks": ["read", "run", "manage"]}, "denies": {}},
        {"name": "no_runner", "inherits": [T2], "grants": {}, "denies": {"playbooks": ["run"]}},
    ]))
    for action in ("read", "run", "manage", "publish"):
        assert _allowed(cfg, "procedure_owner", "runbooks", action) is True, action
    assert _allowed(cfg, "no_runner", "runbooks", "run") is False
    assert _allowed(cfg, "no_runner", "runbooks", "read") is True


def test_preferences_load_maps_the_rbac_block_and_stamps_it() -> None:
    prefs = Preferences.model_validate({"rbac": _persisted_rbac(
        roles={T1: {"playbooks": ["read", "run"]}},
    )})
    assert prefs.rbac.rbac_grants_version == RBAC_GRANTS_VERSION
    assert prefs.rbac.roles[T1]["runbooks"] == ["read", "run"]
    assert Preferences.model_validate(prefs.model_dump(mode="json")).rbac == prefs.rbac


def test_effective_matrix_aliases_a_raw_mapping_config_too() -> None:
    """A config handed to the resolver as a plain mapping (never validated) still
    resolves the retired vocabulary: the alias runs inside the resolver as well."""
    raw = {"roles": {T1: {"playbooks": ["read", "run"]}}, "denies": {T2: {"playbooks": ["run"]}}}
    matrix = resolve_matrix(raw)
    assert "run" in matrix[T1]["runbooks"]
    assert "run" not in matrix[T2]["runbooks"]


def test_every_effective_grant_is_unchanged_when_the_retired_resource_is_ignored() -> None:
    """The A8c invariant, checked now: with the retired resource's own rows set aside,
    every role's effective runbook grants already carry what it meant."""
    cfg = RBACConfig.model_validate(_persisted_rbac(
        roles={T1: {"playbooks": ["read", "run"]}},
        resources={AUD: {"playbooks": ["manage"]}},
        denies={T2: {"playbooks": ["run"]}},
        custom_roles=[{"name": "c", "inherits": [], "grants": {"playbooks": ["read"]}, "denies": {}}],
    ))
    matrix = resolve_matrix(cfg)
    assert "run" in matrix[T1]["runbooks"]
    assert {"manage", "publish"} <= set(matrix[AUD]["runbooks"])
    assert "run" not in matrix[T2]["runbooks"]
    assert matrix["c"]["runbooks"] == ["read"]


# --------------------------------------------------------------------------- #
# The custom-role KV store (normalise on load, stamp, strict conditional writes).
# --------------------------------------------------------------------------- #
@pytest.fixture
def kv() -> EsKVStore:
    return EsKVStore(InMemoryESClient())


async def test_custom_role_store_reads_a_pre_round14_document_through_the_aliases(kv) -> None:
    await kv.put("custom_roles", "roles", {"roles": {"default": [
        {"name": "author", "inherits": [], "grants": {"runbooks": ["read", "manage"]}, "denies": {}},
        {"name": "runner", "inherits": [], "grants": {"playbooks": ["run"]}, "denies": {}},
    ]}})
    store = CustomRoleStore(kv)
    roles = {r.name: r for r in await store.list()}
    assert roles["author"].grants["runbooks"] == ["read", "manage", "publish"]
    assert roles["runner"].grants["runbooks"] == ["run"]


async def test_custom_role_store_never_reruns_the_publish_rule_over_a_round14_document(kv) -> None:
    """An older build rewrites the document without the stamp but keeps every role. A
    role naming an action only Round 14 has proves the document is current, so no role
    in it gains ``publish`` again."""
    await kv.put("custom_roles", "roles", {"roles": {"default": [
        {"name": "author", "inherits": [], "grants": {"runbooks": ["read", "run", "manage"]}, "denies": {}},
        {"name": "editor", "inherits": [], "grants": {"runbooks": ["read", "manage"]}, "denies": {}},
    ]}})
    roles = {r.name: r for r in await CustomRoleStore(kv).list()}
    assert roles["author"].grants["runbooks"] == ["read", "run", "manage"]
    assert roles["editor"].grants["runbooks"] == ["read", "manage"]


async def test_custom_role_store_stamps_on_write_and_a_removal_sticks(kv) -> None:
    await kv.put("custom_roles", "roles", {"roles": {"default": [
        {"name": "author", "inherits": [], "grants": {"runbooks": ["read", "manage"]}, "denies": {}},
    ]}})
    store = CustomRoleStore(kv)
    await store.put({"name": "other", "grants": {"cases": ["read"]}})
    doc = await kv.get("custom_roles", "roles")
    assert doc[GRANTS_VERSION_FIELD] == RBAC_GRANTS_VERSION
    stored = {r["name"]: r for r in doc["roles"]["default"]}
    assert stored["author"]["grants"]["runbooks"] == ["read", "manage", "publish"]
    # The administrator removes publish: the stamped document keeps that.
    await store.update_existing(CustomRole(name="author", grants={"runbooks": ["read", "manage"]}))
    assert (await store.get("author")).grants["runbooks"] == ["read", "manage"]


async def test_custom_role_store_keeps_a_narrowing_when_an_update_echoes_the_playbooks_key(kv) -> None:
    """A legacy document loads with both keys; an update whose body echoes the stored
    grants (``playbooks`` kept, ``runbooks`` narrowed) keeps the narrowing."""
    await kv.put("custom_roles", "roles", {"roles": {"default": [
        {"name": "owner", "inherits": [], "grants": {"playbooks": ["read", "run", "manage"]},
         "denies": {}},
    ]}})
    store = CustomRoleStore(kv)
    loaded = await store.get("owner")
    assert loaded.grants["runbooks"] == ["read", "run", "manage", "publish"]
    echoed = dict(loaded.grants)
    echoed["runbooks"] = ["read"]
    updated = await store.update_existing(CustomRole(name="owner", grants=echoed))
    assert updated.grants["runbooks"] == ["read"]
    assert (await store.get("owner")).grants["runbooks"] == ["read"]
    cfg = RBACConfig(enabled=True, custom_roles=[
        r.model_dump(mode="json") for r in await store.list()
    ])
    assert _allowed(cfg, "owner", "runbooks", "run") is False
    assert _allowed(cfg, "owner", "runbooks", "read") is True


async def test_custom_role_store_conditional_writes(kv) -> None:
    store = CustomRoleStore(kv)
    created = await store.create_if_absent({"name": "Hunter", "grants": {"playbooks": ["manage"]}})
    assert created.grants["runbooks"] == ["manage", "publish"]
    with pytest.raises(CustomRoleExists):
        await store.create_if_absent({"name": "hunter"})
    with pytest.raises(CustomRoleMissing):
        await store.update_existing({"name": "ghost"})
    removed = await store.delete_strict("HUNTER")
    assert removed.name == "Hunter"
    with pytest.raises(CustomRoleMissing):
        await store.delete_strict("hunter")
    assert await store.list() == []


class _BrokenWrites(KVStore):
    """A KV whose reads work and whose writes fail (a storage outage)."""

    def __init__(self) -> None:
        self.inner = EsKVStore(InMemoryESClient())

    async def get(self, namespace: str, key: str):
        return await self.inner.get(namespace, key)

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        raise RuntimeError("store down")

    async def put_if(self, namespace: str, key: str, value: dict[str, Any], expected_rev: int) -> bool:
        raise RuntimeError("store down")


async def test_custom_role_strict_writes_raise_on_a_storage_failure() -> None:
    """The audit-first routes need the failure: the strict writes raise (so the
    failure row is written), while the legacy upsert keeps failing soft."""
    broken = _BrokenWrites()
    await CustomRoleStore(broken.inner).put({"name": "seeded", "inherits": [AUD]})
    store = CustomRoleStore(broken)
    with pytest.raises(RuntimeError):
        await store.create_if_absent({"name": "x"})
    with pytest.raises(RuntimeError):
        await store.update_existing({"name": "seeded", "inherits": [T1]})
    with pytest.raises(RuntimeError):
        await store.delete_strict("seeded")
    # The decision is still made inside the conditional write: a missing role is
    # reported as missing, not as an outage.
    with pytest.raises(CustomRoleMissing):
        await store.update_existing({"name": "never_stored"})
    await store.put({"name": "x"})  # best effort, never raises
    assert [r.name for r in await CustomRoleStore(broken.inner).list()] == ["seeded"]


async def test_custom_role_writes_keep_an_entry_this_version_cannot_read(kv) -> None:
    """A damaged or newer-version role is skipped on read but never destroyed by a
    write: strict and best-effort writes carry it through as it was."""
    future = {"name": "future", "grants": {"cases": ["read"]}, "inherits": "not-a-list"}
    await kv.put("custom_roles", "roles", {"roles": {"default": [
        {"name": "keeper", "grants": {"cases": ["read"]}}, future,
    ]}})
    store = CustomRoleStore(kv)
    assert [r.name for r in await store.list()] == ["keeper"]
    await store.create_if_absent({"name": "new-role", "grants": {"cases": ["read"]}})
    await store.update_existing({"name": "keeper", "grants": {"alerts": ["read"]}})
    await store.delete_strict("new-role")
    await store.put({"name": "other"})
    await store.delete("other")
    raw = await kv.get("custom_roles", "roles")
    entries = raw["roles"]["default"]
    assert [e["name"] for e in entries] == ["keeper", "future"]
    assert entries[1] == future
    # A create may not shadow it; an upsert of its name replaces it.
    with pytest.raises(CustomRoleExists):
        await store.create_if_absent({"name": "Future"})
    await store.put({"name": "future", "grants": {"cases": ["read"]}})
    assert [r.name for r in await store.list()] == ["keeper", "future"]
    assert len((await kv.get("custom_roles", "roles"))["roles"]["default"]) == 2


# --------------------------------------------------------------------------- #
# routes_roles: every accepted body is read through the aliases, never dropped.
# --------------------------------------------------------------------------- #
def _roles_client():
    """Auth ON + RBAC ON with the monolith (login) and ``routes_roles`` mounted,
    mirroring ``test_round3_wave2_roles``."""
    from contextlib import asynccontextmanager

    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.api.deps import require_auth
    from app.api.routes import router as monolith_router
    from app.api.routes_roles import router as roles_router
    from app.config import Secrets
    from app.llm.providers import MockProvider
    from app.state import AppState

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="runbook-roles-test-secret",
        auth_seed_admin=True, auth_admin_username="envadmin",
        auth_admin_password=None,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(roles_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


@pytest.fixture
def roles_client():
    with _roles_client() as c:
        r = c.post("/api/auth/login", json={"username": "Admin", "password": "Admin@123"})
        assert r.status_code == 200, r.text
        yield c


def test_role_bodies_map_the_retired_vocabulary(roles_client) -> None:
    client = roles_client
    created = client.post("/api/roles", json={
        "name": "legacy_author", "inherits": [AUD],
        "grants": {"playbooks": ["manage"]}, "denies": {"playbooks": ["run"]},
    })
    assert created.status_code == 200, created.text
    role = created.json()["role"]
    assert role["grants"]["runbooks"] == ["manage", "publish"]
    assert role["denies"]["runbooks"] == ["run"]
    preview = client.post("/api/roles/preview", json={
        "name": "draft_role", "inherits": [AUD], "grants": {"playbooks": ["run"]},
    })
    assert preview.status_code == 200, preview.text
    assert "run" in preview.json()["effective"]["runbooks"]
    updated = client.put("/api/roles", json={
        "name": "legacy_author", "inherits": [AUD], "grants": {"playbooks": ["read"]},
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()["role"]["grants"]["runbooks"] == ["read"]
    sim = client.get("/api/roles/simulate", params={
        "role": "legacy_author", "resource": "runbooks", "action": "read",
    })
    assert sim.json()["allowed"] is True


def test_a_role_update_echoing_the_playbooks_key_keeps_a_runbooks_narrowing(roles_client) -> None:
    """A role created with the legacy ``playbooks`` alias stores it as ``runbooks``
    (publish included, E8). An update body that echoes the stored grants with
    ``runbooks`` narrowed keeps the narrowing, in the stored role and in the effective
    permission: an alias never widens it back."""
    client = roles_client
    created = client.post("/api/roles", json={
        "name": "echo_role", "inherits": [], "grants": {"playbooks": ["read", "run", "manage"]},
    })
    assert created.status_code == 200, created.text
    grants = created.json()["role"]["grants"]
    assert grants["runbooks"] == ["read", "run", "manage", "publish"]
    updated = client.put("/api/roles", json={
        "name": "echo_role", "inherits": [], "grants": {**grants, "runbooks": ["read"]},
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()["role"]["grants"]["runbooks"] == ["read"]
    for action, expected in (("read", True), ("run", False), ("manage", False), ("publish", False)):
        sim = client.get("/api/roles/simulate", params={
            "role": "echo_role", "resource": "runbooks", "action": action,
        })
        assert sim.status_code == 200, sim.text
        assert sim.json()["allowed"] is expected, action


def test_role_create_refuses_a_duplicate_inside_the_store(roles_client) -> None:
    client = roles_client
    body = {"name": "dup_role", "inherits": [AUD]}
    assert client.post("/api/roles", json=body).status_code == 200
    assert client.post("/api/roles", json=body).status_code == 409
    assert client.delete("/api/roles/dup_role").status_code == 200
    assert client.delete("/api/roles/dup_role").status_code == 404
    assert client.put("/api/roles", json=body).status_code == 404


def test_role_writes_answer_a_store_outage_with_a_structured_503(roles_client) -> None:
    """A storage outage in the strict role writes is ``503 role_store_unavailable``
    (never a bare 500), after the failure row recorded the store's own error."""
    client = roles_client
    state = client.app.state.tlsoc
    assert client.post("/api/roles", json={"name": "kept_role", "inherits": [AUD]}).status_code == 200
    store = state.custom_roles
    real_kv = store._kv
    broken = _BrokenWrites()
    broken.inner = real_kv
    store._kv = broken
    try:
        created = client.post("/api/roles", json={"name": "new_role", "inherits": [AUD]})
        updated = client.put("/api/roles", json={"name": "kept_role", "inherits": [T1]})
        deleted = client.delete("/api/roles/kept_role")
    finally:
        store._kv = real_kv
    for response in (created, updated, deleted):
        assert response.status_code == 503, response.text
        assert response.json()["detail"]["code"] == "role_store_unavailable"
    rows = client.portal.call(lambda: state.control_audit.records(limit=1000))
    by_action = {r.get("action"): r for r in rows}
    for failed in ("role.create_failed", "role.update_failed", "role.delete_failed"):
        assert by_action[failed]["outcome"] == "failure"
        assert "store down" in by_action[failed]["result_summary"]
    assert [r.name for r in client.portal.call(store.list)] == ["kept_role"]
