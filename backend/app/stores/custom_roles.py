"""Custom-RBAC-ROLE store — operator-defined roles (Round 3).

A :class:`app.models.CustomRole` is an operator-defined RBAC role layered ON TOP of
the six built-in :class:`app.constants.UserRole` roles: it ``inherits`` base roles,
``grants`` additional ``resource -> [action]`` permissions, and ``denies`` some
(deny wins). This store CARRIES the role definitions out-of-band from the Preferences
doc (custom roles ALSO ride on ``Preferences.rbac.custom_roles``; this KV namespace
is the admin-managed/out-of-band set a later wave's effective-matrix resolver reads).

Org-scoped: there is one shared bucket (``'default'``) — custom roles are an org-wide
construct, not per-user. Role names are normalised + de-duplicated.

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory`): the WHOLE role set is ONE KV document
(``ns=CUSTOM_ROLES_NS``, ``key=CUSTOM_ROLES_KEY``) whose value is
``{"roles": {"<scope>": [<CustomRole json>, ...]}}`` — so it needs NO new ES index /
SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES backend uses the
thin :class:`app.stores.memory.EsKVStore` adapter.

Reads + writes are read-modify-write. The store NEVER raises: a failure degrades to
an empty role list / best-effort write and is logged. ``put`` validates a loose dict
into a real :class:`CustomRole`, raising ValueError ONLY on an empty/invalid name (a
caller error), never on a backend failure.

Round 14 (SPEC §3.7, E8):

* Every role is read through the ``playbooks`` -> ``runbooks`` grant alias
  (:func:`app.rbac.policy.normalise_grants` / ``normalise_denies``) on load and
  before every write, so a stored grant or deny in the retired vocabulary keeps its
  meaning. The document carries ``rbac_grants_version``; a document without it was
  written before Round 14: its ``playbooks`` entries are unioned into ``runbooks``,
  and its ``runbooks:manage`` grants (and denies) also cover the new
  ``runbooks:publish`` once. The first write stamps the document, so an
  administrator who later removes ``publish`` keeps that choice. In a stamped
  document a ``runbooks`` entry that is present is authoritative (the alias maps
  only where it is absent), so a narrowing sticks even when an update echoes the
  stored ``playbooks`` key.
* The audit-first role routes (``api.routes_roles``) write through
  :meth:`CustomRoleStore.create_if_absent`, :meth:`update_existing` and
  :meth:`delete_strict`: the existence check is decided INSIDE the compare-and-set,
  and a storage failure raises (``kv_mutate_strict``), so a role made, changed or
  removed by another request while the action row was appended is refused instead of
  silently replaced, and a failed save gets its failure row.
* A stored entry this version cannot validate (damaged, or written by a newer
  version) is skipped when roles are READ, but every write carries it through
  verbatim (apart from the grant aliases), so saving one role never destroys
  another. A create whose name matches such an entry is refused as a duplicate; an
  upsert (``put``) of that name replaces it.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar

from ..constants import CUSTOM_ROLES_KEY, CUSTOM_ROLES_NS
from ..models import CustomRole
from ..rbac.policy import (
    RBAC_GRANTS_VERSION,
    grants_version_is_legacy,
    normalise_custom_role,
    normalise_denies,
    normalise_grants,
    role_specs_name_round14_actions,
)
from .base import KVStore, kv_mutate, kv_mutate_strict

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.custom_roles")

# Org-scoped: one shared bucket. (Kept as a parameter so a future multi-tenant build
# could key by org id without a schema change.)
_DEFAULT_SCOPE = "default"


def _norm_name(name: str | None) -> str:
    return (name or "").strip()


#: The document field holding the grant-vocabulary stamp (SPEC §3.7).
GRANTS_VERSION_FIELD = "rbac_grants_version"


class CustomRoleExists(ValueError):
    """``create_if_absent``: a custom role with that name already exists."""


class CustomRoleMissing(LookupError):
    """``update_existing`` / ``delete_strict``: no custom role with that name."""


def normalise_role(role: CustomRole, *, legacy: bool = False) -> CustomRole:
    """``role`` with its grant and deny maps read through the Round 14 aliases
    (:func:`app.rbac.policy.normalise_grants`). ``legacy`` adds the once-only
    ``runbooks:publish`` rule for a role stored before Round 14."""
    grants = normalise_grants(dict(role.grants or {}), legacy=legacy)
    denies = normalise_denies(dict(role.denies or {}), legacy=legacy)
    if grants == role.grants and denies == role.denies:
        return role
    return role.model_copy(update={"grants": grants, "denies": denies})


@dataclass
class _Stored:
    """The decoded roles per scope and, per scope, every stored entry that could not
    be validated (kept verbatim by every write)."""

    roles: dict[str, list[CustomRole]] = field(default_factory=dict)
    undecodable: dict[str, list[Any]] = field(default_factory=dict)

    def undecodable_names(self, scope: str) -> set[str]:
        """The lower-cased names of the scope's undecodable entries that carry one."""
        out: set[str] = set()
        for item in self.undecodable.get(scope, []):
            name = item.get("name") if isinstance(item, dict) else None
            if isinstance(name, str) and name.strip():
                out.add(name.strip().lower())
        return out


class CustomRoleStore:
    """CRUD over operator-defined custom RBAC roles, persisted as one KV document.

    The KV value is ``{"roles": {"default": [<CustomRole json>, ...]}}``. Methods are
    read-modify-write; none raises on a backend failure. ``put`` validates a loose
    dict into :class:`CustomRole` and upserts by (case-insensitive) name."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _read(doc: dict | None) -> _Stored:
        """Every stored role, read through the Round 14 grant aliases (SPEC §3.7), and
        every entry that cannot be validated, kept aside verbatim. A document without
        a current ``rbac_grants_version`` predates the runbook vocabulary, so its
        roles (and the kept entries' grant maps) also get the once-only ``publish``
        rule, unless one of its roles names an action only Round 14 has: a build from
        before Round 14 rewrites the document without the stamp but keeps every
        role's grants and denies, so such a document was written in the current
        vocabulary and a downgrade, a save and a re-upgrade never re-run the rule
        over a Round 14 choice."""
        raw = doc.get("roles", {}) if isinstance(doc, dict) else {}
        legacy = (
            isinstance(doc, dict)
            and grants_version_is_legacy(doc.get(GRANTS_VERSION_FIELD))
            and not any(
                role_specs_name_round14_actions(items)
                for items in (raw.values() if isinstance(raw, dict) else ())
            )
        )
        out = _Stored()
        for scope, items in (raw if isinstance(raw, dict) else {}).items():
            roles: list[CustomRole] = []
            kept: list[Any] = []
            for item in items if isinstance(items, list) else []:
                try:
                    roles.append(normalise_role(CustomRole.model_validate(item), legacy=legacy))
                except Exception:  # noqa: BLE001 (never readable here, never destroyed)
                    kept.append(normalise_custom_role(item, legacy=legacy))
            out.roles[str(scope)] = roles
            if kept:
                out.undecodable[str(scope)] = kept
        return out

    @classmethod
    def _decode(cls, doc: dict | None) -> dict[str, list[CustomRole]]:
        """The readable roles per scope (an undecodable entry is skipped)."""
        return cls._read(doc).roles

    @staticmethod
    def _encode(stored: _Stored) -> dict:
        scopes = list(dict.fromkeys([*stored.roles, *stored.undecodable]))
        return {
            "roles": {
                scope: [r.model_dump(mode="json") for r in stored.roles.get(scope, [])]
                + list(stored.undecodable.get(scope, []))
                for scope in scopes
            },
            GRANTS_VERSION_FIELD: RBAC_GRANTS_VERSION,
        }

    async def _load_all(self) -> dict[str, list[CustomRole]]:
        try:
            doc = await self._kv.get(CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY)
        except Exception as exc:  # noqa: BLE001 — roles are best-effort to LOAD
            logger.warning("Loading custom roles failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[_Stored], _T]) -> _T:
        """Atomic read-modify-write over the shared roles doc (lost-update safe).
        ``change`` edits ``stored.roles``; undecodable entries are written back as
        they were."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            stored = self._read(current)
            box["r"] = change(stored)
            return self._encode(stored)

        await kv_mutate(self._kv, CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    async def _mutate_strict(self, change: Callable[[_Stored], _T]) -> _T:
        """:meth:`_mutate` for the audit-first routes: ``change`` decides inside the
        compare-and-set (it may raise to refuse, and nothing is written), and a
        storage failure or an exhausted retry RAISES instead of degrading, so the
        caller's failure row is written (SPEC §3.6). Undecodable entries are written
        back as they were."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            stored = self._read(current)
            box["r"] = change(stored)
            return self._encode(stored)

        await kv_mutate_strict(
            self._kv, CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY, _mutator, lock=self._lock
        )
        return box["r"]

    @staticmethod
    def _validated(role: CustomRole | dict[str, Any]) -> CustomRole:
        validated = role if isinstance(role, CustomRole) else CustomRole.model_validate(role)
        name = _norm_name(validated.name)
        if not name:
            raise ValueError("custom role name is required")
        return normalise_role(validated.model_copy(update={"name": name}))

    async def list(self, scope: str = _DEFAULT_SCOPE) -> list[CustomRole]:
        """Every custom role in the (org) scope, in stored order."""
        return list((await self._load_all()).get(scope, []))

    async def get(self, name: str, scope: str = _DEFAULT_SCOPE) -> CustomRole | None:
        needle = _norm_name(name).lower()
        for r in await self.list(scope):
            if r.name.strip().lower() == needle:
                return r
        return None

    async def put(self, role: CustomRole | dict[str, Any],
                  scope: str = _DEFAULT_SCOPE) -> CustomRole:
        """Upsert a custom role by name (case-insensitive). Accepts a loose dict
        (validated into :class:`CustomRole`) or a model. Raises ValueError on an
        empty name (a caller error). Returns the stored role."""
        validated = self._validated(role)
        name = validated.name

        def _change(stored: _Stored) -> CustomRole:
            needle = name.lower()
            roles = [r for r in stored.roles.get(scope, []) if r.name.strip().lower() != needle]
            roles.append(validated)
            stored.roles[scope] = roles
            if needle in stored.undecodable_names(scope):
                # An upsert of this name replaces the unreadable entry it names.
                stored.undecodable[scope] = [
                    item for item in stored.undecodable.get(scope, [])
                    if not (isinstance(item, dict) and isinstance(item.get("name"), str)
                            and item["name"].strip().lower() == needle)
                ]
            return validated

        return await self._mutate(_change)

    async def create_if_absent(
        self, role: CustomRole | dict[str, Any], scope: str = _DEFAULT_SCOPE
    ) -> CustomRole:
        """Add a NEW custom role (case-insensitive name). Raises
        :class:`CustomRoleExists` when one with that name is already stored (decided
        inside the compare-and-set, so two concurrent creates never both succeed) and
        propagates a storage failure. Grants are read through the Round 14 aliases."""
        validated = self._validated(role)
        needle = validated.name.lower()

        def _change(stored: _Stored) -> CustomRole:
            roles = list(stored.roles.get(scope, []))
            if any(r.name.strip().lower() == needle for r in roles) or (
                needle in stored.undecodable_names(scope)
            ):
                raise CustomRoleExists(validated.name)
            roles.append(validated)
            stored.roles[scope] = roles
            return validated

        return await self._mutate_strict(_change)

    async def update_existing(
        self, role: CustomRole | dict[str, Any], scope: str = _DEFAULT_SCOPE
    ) -> CustomRole:
        """Replace an EXISTING custom role (case-insensitive name), keeping its place
        in the list. Raises :class:`CustomRoleMissing` when it is gone (decided inside
        the compare-and-set, so a concurrent delete is never undone) and propagates a
        storage failure."""
        validated = self._validated(role)
        needle = validated.name.lower()

        def _change(stored: _Stored) -> CustomRole:
            roles = list(stored.roles.get(scope, []))
            for index, existing in enumerate(roles):
                if existing.name.strip().lower() == needle:
                    roles[index] = validated
                    stored.roles[scope] = roles
                    return validated
            raise CustomRoleMissing(validated.name)

        return await self._mutate_strict(_change)

    async def delete_strict(self, name: str, scope: str = _DEFAULT_SCOPE) -> CustomRole:
        """Delete a custom role by name (case-insensitive) and return it. Raises
        :class:`CustomRoleMissing` when it is already gone and propagates a storage
        failure (the audit-first delete route needs both)."""
        needle = _norm_name(name).lower()

        def _change(stored: _Stored) -> CustomRole:
            roles = list(stored.roles.get(scope, []))
            for index, existing in enumerate(roles):
                if existing.name.strip().lower() == needle:
                    del roles[index]
                    stored.roles[scope] = roles
                    return existing
            raise CustomRoleMissing(_norm_name(name))

        return await self._mutate_strict(_change)

    async def delete(self, name: str, scope: str = _DEFAULT_SCOPE) -> bool:
        """Delete a custom role by name (case-insensitive). Returns True if it
        existed."""
        needle = _norm_name(name).lower()

        def _change(stored: _Stored) -> bool:
            roles = stored.roles.get(scope, [])
            remaining = [r for r in roles if r.name.strip().lower() != needle]
            if len(remaining) == len(roles):
                return False
            stored.roles[scope] = remaining
            return True

        return await self._mutate(_change)
