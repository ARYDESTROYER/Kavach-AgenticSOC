"""RBAC permission policy (Wave 1 / F2; Round-3 Wave-1 NIST ladder).

Permissions are MODELLED as data (a ``role -> resource -> [actions]`` matrix) and
ENFORCED in code (:func:`can`). The default matrix lives here; an operator can
override it via ``Preferences.rbac.roles`` (a deep, additive override — an absent
role/resource falls back to this default), ADD custom roles via
``Preferences.rbac.custom_roles`` (name/inherits/grants/denies), and REMOVE
permissions via ``Preferences.rbac.denies`` (deny-wins).

Semantics (the three back-compat modes are decided by the caller in ``deps.py``,
not here):

* auth DISABLED        → everything allowed (the no-auth "old version" default).
* auth ON, rbac OFF    → every authenticated user is treated as ``super_admin``.
* auth ON, rbac ON     → :func:`can` is consulted for every gated action.

A wildcard ``"*"`` action grants ALL actions on a resource (used for super_admin).
``super_admin`` is additionally hard-allowed in :func:`can` so a malformed
override (or an over-broad DENY) can never lock the platform's owner out.

Round-3 Wave-1 additions (ALL additive + defaulted → :func:`can` is byte-identical
to the prior matrix when no custom role / deny / resource override is configured):

* The thin ``settings`` vocabulary is SPLIT so each newer feature is its own
  narrow resource (``notifications``/``branding``/``sessions``/``demo``/
  ``terminology``/``automation``/``roles``/``models``/``enrichment``/``inapp``).
  The DEFAULT grants preserve current per-role behaviour: whoever can
  ``settings:manage`` today keeps equivalent ``manage`` access on the narrow
  resources, so migrating the route decorators changes nothing behaviourally.
* :func:`effective_matrix` folds CUSTOM roles (``name``/``inherits``/``grants``/
  ``denies``) with cycle-guarded inheritance, then applies explicit DENY with
  DENY-WINS precedence (evaluated AFTER allows).
* :func:`can_object` is an OPT-IN row/object scope hook with a WHITELISTED
  condition vocabulary (no ``eval``). It is OFF by default (defers to :func:`can`).
"""

from __future__ import annotations

from typing import Any, Callable

from ..constants import UserRole

# Canonical resource -> actions vocabulary. The webui and the route deps reference
# these names; keep them in sync with the frontend ``Can`` usage.
#
# Round-3 Wave-1 SPLIT: the newer admin surfaces that historically rode on
# ``settings:manage`` now have their OWN narrow resource so an operator can grant
# (or a custom role can carry) them independently. Each exposes the granular actions
# its routes need; ``manage`` is the privileged-write action that ``settings:manage``
# used to cover.
RESOURCES: dict[str, list[str]] = {
    "cases": ["read", "write", "close", "assign", "comment", "reinvestigate"],
    "sources": ["read", "manage"],
    "settings": ["read", "manage"],
    "users": ["manage"],
    "proposals": ["read", "approve"],
    # ``playbooks`` stays for one release (SPEC Round 14 §3.7): existing routes and
    # chat tools still gate on it until the runbook feature replaces them, after which
    # it leaves this vocabulary and every stored grant maps onto ``runbooks``.
    "playbooks": ["read", "run", "manage"],
    # Round 14 (SPEC §3.7): one runbook feature. ``read`` sees the library and a
    # case's runs; ``run`` works a case's checklist (steps, decisions, lookups);
    # ``manage`` authors drafts, duplicates, imports and retires; ``publish`` makes a
    # version live, the only step that lets runbook text reach the investigator as
    # trusted guidance (#9).
    "runbooks": ["read", "run", "manage", "publish"],
    "rag": ["read", "manage"],
    "memory": ["read", "manage"],
    "cost": ["view"],
    # Round 14 (SPEC §3.7, D5): ``export`` writes a CSV or JSON Lines file of audit
    # rows. Separate from ``view`` so a role can read the log without bulk extraction.
    "audit": ["view", "export"],
    "metrics": ["view"],
    # Portable application-state export. Deliberately NOT settings-like: only the
    # two platform-owner roles receive it by default; read-only analysts/auditors do
    # not inherit bulk data extraction merely because they can view settings.
    "data_export": ["export"],
    # Supervised deployment updates are NOT settings-like.  Read visibility may be
    # delegated to a SOC manager, but install/rollback are additionally hard-gated
    # by the route layer to the built-in super_admin with a registered fresh session.
    "system_updates": ["read", "apply", "rollback"],
    # --- Round-3 Wave-1 narrow resources (split out of ``settings``) --- #
    "notifications": ["read", "manage"],   # provider catalog / preview / test-send / channel secret
    "branding": ["read", "manage"],        # org white-label (logo / accent / org name)
    "sessions": ["read", "manage"],        # admin session registry view + revoke
    "demo": ["read", "manage"],            # Demo Mode enable / reset / disable
    "terminology": ["read", "manage"],     # org terminology overrides
    "automation": ["read", "manage"],      # threshold-automation rules
    "roles": ["read", "manage"],           # RBAC role/matrix editing
    "models": ["read", "manage"],          # LLM model catalog / routing config
    "enrichment": ["read", "manage"],      # enrichment provider config
    "inapp": ["read", "manage"],           # in-app notification prefs / admin broadcast
    # --- Round-5 G6 R9 unification --- #
    # ONE coherent "rules" grant for the rules-customization surface (detection /
    # correlation-threshold / case-automation rule CRUD + version rollback + read-only
    # preview). This replaces the fragmented grants each rules-adjacent read used to
    # borrow (baseline→settings:read, campaigns→cases:read, batch→models:read,
    # tuning→automation:read). Derived like the other settings-split resources so each
    # role's ``rules`` access mirrors its ``settings`` access exactly (back-compat: the
    # legacy routers keep their original grants; the new rules API is the ONE place
    # ``rules`` is enforced).
    "rules": ["read", "manage"],
}

ALL = "*"  # wildcard action grant

# The narrow resources split out of ``settings``. Used to derive the default grants
# (so they MIRROR each role's old ``settings`` access) and to document the migration.
_SETTINGS_SPLIT: tuple[str, ...] = (
    "notifications", "branding", "sessions", "demo", "terminology",
    "automation", "roles", "models", "enrichment", "inapp",
    # Round-5 G6 R9: the unified rules-customization grant, derived to mirror each
    # role's ``settings`` access (whoever could tune settings can manage rules).
    "rules",
)


def _settings_like(settings_actions: list[str]) -> dict[str, list[str]]:
    """Derive the narrow-resource grants that MIRROR a role's ``settings`` grant, so
    splitting the vocabulary preserves behaviour exactly.

    * ``settings: [ALL]``  (super_admin / soc_manager) → every narrow resource ``[ALL]``
      → keeps ``manage`` + ``read`` on each, matching ``settings:manage`` access today.
    * ``settings: ["read"]`` (the analyst / responder / auditor tiers) → ``["read"]`` on
      each narrow resource → keeps the read-only visibility they had via ``settings:read``.
    * anything else / absent → no narrow grant (deny-by-default).
    """
    if ALL in settings_actions:
        return {res: [ALL] for res in _SETTINGS_SPLIT}
    if "read" in settings_actions:
        return {res: ["read"] for res in _SETTINGS_SPLIT}
    return {}


_SUPER_ADMIN: dict[str, list[str]] = {res: [ALL] for res in RESOURCES}

_SOC_MANAGER: dict[str, list[str]] = {
    "cases": [ALL],
    "sources": [ALL],
    "settings": [ALL],
    "users": ["manage"],
    "proposals": [ALL],
    "playbooks": [ALL],
    "runbooks": [ALL],
    "rag": [ALL],
    "memory": [ALL],
    "cost": ["view"],
    "audit": ["view", "export"],
    "metrics": ["view"],
    "data_export": ["export"],
    "system_updates": ["read"],
    **_settings_like([ALL]),
}

_ANALYST_TIER2: dict[str, list[str]] = {
    "cases": ["read", "write", "close", "assign", "comment", "reinvestigate"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read"],
    "playbooks": ["read", "run"],
    "runbooks": ["read", "run"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "metrics": ["view"],
    **_settings_like(["read"]),
}

_ANALYST_TIER1: dict[str, list[str]] = {
    "cases": ["read", "write", "comment", "assign"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read"],
    "playbooks": ["read"],
    # Round 14 (SPEC E8): working a case's runbook checklist is the analyst's core
    # task, so every role except the auditor may run it.
    "runbooks": ["read", "run"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "metrics": ["view"],
    **_settings_like(["read"]),
}

_RESPONDER: dict[str, list[str]] = {
    # analyst_tier1 + playbooks:run + proposals:approve
    "cases": ["read", "write", "comment", "assign"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read", "approve"],
    "playbooks": ["read", "run"],
    "runbooks": ["read", "run"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "metrics": ["view"],
    **_settings_like(["read"]),
}

# Auditor: read/view only across the board — never any write/manage/close/approve.
# The one extraction it holds is ``audit:export`` (Round 14 D5): a file of the audit
# rows it can already read, which changes nothing.
_AUDITOR: dict[str, list[str]] = {
    "cases": ["read"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read"],
    "playbooks": ["read"],
    "runbooks": ["read"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    # Round 14 (SPEC D5): the auditor exports what it can read.
    "audit": ["view", "export"],
    "metrics": ["view"],
    **_settings_like(["read"]),
}

DEFAULT_MATRIX: dict[str, dict[str, list[str]]] = {
    UserRole.SUPER_ADMIN.value: _SUPER_ADMIN,
    UserRole.SOC_MANAGER.value: _SOC_MANAGER,
    UserRole.ANALYST_TIER2.value: _ANALYST_TIER2,
    UserRole.ANALYST_TIER1.value: _ANALYST_TIER1,
    UserRole.RESPONDER.value: _RESPONDER,
    UserRole.AUDITOR.value: _AUDITOR,
}

DEFAULT_ROLE = UserRole.ANALYST_TIER1.value

# A role name is a "base" (built-in) role iff it is one of the six UserRole values.
_BASE_ROLE_NAMES: frozenset[str] = frozenset(r.value for r in UserRole)


def _role_str(role: Any) -> str:
    """Normalise a role (``UserRole`` or its string value) to its string form."""
    return str(getattr(role, "value", role))


def _overrides_from_config(rbac_config: Any) -> dict[str, Any]:
    """Pull the per-role ``roles`` override mapping out of an ``RBACConfig`` / dict /
    None.

    Lenient: returns ``{}`` when there is no usable override (→ pure defaults)."""
    if rbac_config is None:
        return {}
    roles = getattr(rbac_config, "roles", None)
    if roles is None and isinstance(rbac_config, dict):
        roles = rbac_config.get("roles")
    return roles if isinstance(roles, dict) else {}


def _attr_from_config(rbac_config: Any, name: str) -> Any:
    """Pull ``name`` off an ``RBACConfig`` or dict (None-safe). Returns ``None`` when
    absent — callers normalise the shape themselves."""
    if rbac_config is None:
        return None
    val = getattr(rbac_config, name, None)
    if val is None and isinstance(rbac_config, dict):
        val = rbac_config.get(name)
    return val


def _clean_actions(res: str, acts: Any) -> list[str] | None:
    """Validate an action list for ``res`` against the known vocabulary. Returns the
    filtered list (possibly empty) or ``None`` when ``res`` is unknown / ``acts`` is
    not a list (caller skips it leniently)."""
    if res not in RESOURCES or not isinstance(acts, list):
        return None
    valid = set(RESOURCES[res]) | {ALL}
    return [str(a) for a in acts if str(a) in valid]


def _merge_grants(bucket: dict[str, list[str]], grants: Any, *, additive: bool) -> None:
    """Merge a ``resource -> [action]`` ``grants`` map into ``bucket`` in place.

    ``additive=True``  → UNION the actions onto whatever is already granted (used for
    custom-role inheritance + the ``resources`` override layer).
    ``additive=False`` → REPLACE the resource's action list (the historical ``roles``
    override semantics — an override fully defines that role/resource grant)."""
    if not isinstance(grants, dict):
        return
    for res, acts in grants.items():
        cleaned = _clean_actions(res, acts)
        if cleaned is None:
            continue  # unknown resource / bad shape → ignore leniently
        if additive:
            existing = bucket.get(res, [])
            merged = list(existing)
            for a in cleaned:
                if a not in merged:
                    merged.append(a)
            bucket[res] = merged
        else:
            bucket[res] = cleaned


def _apply_denies(bucket: dict[str, list[str]], denies: Any) -> None:
    """Apply a ``resource -> [action]`` DENY map to ``bucket`` in place (deny-wins).

    A denied action is removed from the resource's grant. The wildcard ``"*"`` in a
    deny list removes EVERY action on that resource (collapses the grant). A wildcard
    grant (``"*"``) hit by a NARROW deny is first EXPANDED to the concrete action set
    so the deny actually bites (otherwise ``"*"`` would silently re-allow the denied
    action). Unknown resources/actions are ignored leniently."""
    if not isinstance(denies, dict):
        return
    for res, acts in denies.items():
        if res not in RESOURCES or not isinstance(acts, list):
            continue
        deny_set = {str(a) for a in acts}
        current = bucket.get(res)
        if current is None:
            continue
        if ALL in deny_set:
            bucket[res] = []  # deny-all on the resource
            continue
        # Expand a wildcard grant to concrete actions so a narrow deny can subtract.
        if ALL in current:
            current = list(RESOURCES[res])
        bucket[res] = [a for a in current if a not in deny_set]


def _resolve_custom_role(
    name: str,
    by_name: dict[str, dict[str, Any]],
    base_matrix: dict[str, dict[str, list[str]]],
    *,
    _stack: tuple[str, ...] = (),
) -> dict[str, list[str]]:
    """Resolve ONE custom role to a concrete ``resource -> [action]`` grant.

    Folds ``inherits`` (base roles AND other custom roles) with a cycle guard, UNIONs
    the role's own ``grants``, then applies its ``denies`` (deny-wins within the
    role). ``_stack`` carries the in-progress chain to break inheritance cycles
    (a cycle simply stops contributing further — fail-safe, never raises)."""
    if name in _stack:
        return {}  # cycle → stop (the partial chain already contributed)
    spec = by_name.get(name, {})
    bucket: dict[str, list[str]] = {}
    for parent in _as_str_list(spec.get("inherits")):
        if parent in base_matrix:
            parent_grant = base_matrix[parent]
        elif parent in by_name:
            parent_grant = _resolve_custom_role(
                parent, by_name, base_matrix, _stack=_stack + (name,)
            )
        else:
            continue  # unknown parent → ignore leniently
        _merge_grants(bucket, parent_grant, additive=True)
    _merge_grants(bucket, spec.get("grants"), additive=True)
    _apply_denies(bucket, spec.get("denies"))
    return bucket


def _as_str_list(val: Any) -> list[str]:
    return [str(x) for x in val] if isinstance(val, list) else []


def _custom_roles_by_name(custom_roles: Any) -> dict[str, dict[str, Any]]:
    """Index a list of CustomRole-shaped dicts (or models) by name, skipping blanks
    and anything that collides with a built-in role name (a custom role may NOT
    shadow / redefine a base role)."""
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(custom_roles, (list, tuple)):
        return out
    for cr in custom_roles:
        spec = cr if isinstance(cr, dict) else getattr(cr, "model_dump", lambda **_: {})(mode="json")
        if not isinstance(spec, dict):
            continue
        nm = str(spec.get("name") or "").strip()
        if not nm or nm in _BASE_ROLE_NAMES:
            continue
        out[nm] = spec
    return out


def effective_matrix(
    overrides: dict[str, Any] | None = None,
    custom_roles: Any = None,
    *,
    resources: dict[str, Any] | None = None,
    denies: dict[str, Any] | None = None,
) -> dict[str, dict[str, list[str]]]:
    """Build the full effective ``role -> resource -> [actions]`` matrix.

    Layering order (later layers win where they apply):

    1. The built-in :data:`DEFAULT_MATRIX` (deep-copied — never mutated).
    2. ``overrides`` (``Preferences.rbac.roles``): REPLACES the action list for a
       given ``role/resource`` (historical semantics; back-compat byte-identical).
    3. ``resources`` (``Preferences.rbac.resources``): an ADDITIVE per-role layer
       (UNION) used by the custom-role resolution path.
    4. ``custom_roles``: each resolves (cycle-guarded ``inherits`` + ``grants`` +
       its own ``denies``) into a NEW role row (a custom role may not shadow a base
       role; collisions are dropped).
    5. ``denies`` (``Preferences.rbac.denies``): a GLOBAL per-role DENY applied LAST
       with DENY-WINS precedence.

    With no override / custom role / resource layer / deny configured, the result is
    byte-identical to :data:`DEFAULT_MATRIX` (so :func:`can` is unchanged)."""
    merged: dict[str, dict[str, list[str]]] = {
        role: {res: list(acts) for res, acts in res_map.items()}
        for role, res_map in DEFAULT_MATRIX.items()
    }
    # (2) roles overrides — REPLACE semantics (historical).
    for role, res_map in (overrides or {}).items():
        bucket = merged.setdefault(str(role), {})
        _merge_grants(bucket, res_map, additive=False)
    # (3) resources additive layer — UNION onto each role.
    for role, res_map in (resources or {}).items():
        bucket = merged.setdefault(str(role), {})
        _merge_grants(bucket, res_map, additive=True)
    # (4) custom roles — resolved against the POST-(2/3) base matrix so a custom role
    # can inherit operator-tuned built-ins.
    by_name = _custom_roles_by_name(custom_roles)
    base_for_custom = {role: dict(res_map) for role, res_map in merged.items()}
    for nm in by_name:
        merged[nm] = _resolve_custom_role(nm, by_name, base_for_custom)
    # (5) global per-role DENY — applied last (deny-wins). super_admin is left intact
    # (it is hard-allowed in can() regardless, but we also keep its row whole so the
    # GET /api/roles surface never shows the owner self-locked-out).
    for role, deny_map in (denies or {}).items():
        role_s = str(role)
        if role_s == UserRole.SUPER_ADMIN.value:
            continue
        bucket = merged.get(role_s)
        if bucket is not None:
            _apply_denies(bucket, deny_map)
    # LOCKOUT-PROOFING: super_admin's row is ALWAYS the full wildcard grant, no matter
    # what an operator override / deny tried — mirrors the hard-allow in can() so the
    # GET /api/roles surface can never depict the platform owner self-locked-out.
    merged[UserRole.SUPER_ADMIN.value] = {res: [ALL] for res in RESOURCES}
    return merged


def resolve_matrix(rbac_config: Any = None) -> dict[str, dict[str, list[str]]]:
    """The full effective matrix as ``role -> resource -> [actions]`` for the
    ``GET /api/roles`` response, honoring every operator layer in ``rbac_config``
    (``roles`` overrides, ``resources`` additive layer, ``custom_roles``, ``denies``).
    Pure + JSON-friendly. Every built-in role plus every valid custom role is present."""
    return effective_matrix(
        _overrides_from_config(rbac_config),
        _attr_from_config(rbac_config, "custom_roles"),
        resources=_normalise_role_map(_attr_from_config(rbac_config, "resources")),
        denies=_normalise_role_map(_attr_from_config(rbac_config, "denies")),
    )


def _normalise_role_map(val: Any) -> dict[str, Any] | None:
    """Coerce a config attribute to a ``role -> resource -> [actions]`` dict or None."""
    return val if isinstance(val, dict) else None


def can(
    role: Any,
    resource: str,
    action: str,
    rbac_config: Any = None,
    *,
    matrix: dict[str, dict[str, list[str]]] | None = None,
) -> bool:
    """Return whether ``role`` may perform ``action`` on ``resource``.

    ``super_admin`` is ALWAYS allowed (it cannot be locked out by a bad override or
    DENY). A wildcard ``"*"`` action in a role's resource grant allows every action.
    An unknown role / resource denies (deny-by-default).

    The matrix consulted is the DEFAULT merged with every operator layer in
    ``rbac_config`` (an ``RBACConfig`` or dict): ``roles`` overrides, the additive
    ``resources`` layer, ``custom_roles``, and the global ``denies`` (deny-wins).
    Callers with a pre-resolved matrix may pass ``matrix=`` directly (it takes
    precedence over ``rbac_config``).

    Back-compat: with no custom config the result is byte-identical to the prior
    DEFAULT_MATRIX-only behaviour."""
    role_str = _role_str(role)
    if role_str == UserRole.SUPER_ADMIN.value:
        return True
    table = matrix if matrix is not None else resolve_matrix(rbac_config)
    grants = table.get(role_str)
    if not grants:
        return False
    actions = grants.get(resource)
    if not actions:
        return False
    return ALL in actions or action in actions


def can_for_roles(
    base_role: Any,
    custom_roles: Any,
    resource: str,
    action: str,
    rbac_config: Any = None,
    *,
    matrix: dict[str, dict[str, list[str]]] | None = None,
) -> bool:
    """Authorise a user holding a BASE role PLUS a set of assigned CUSTOM roles.

    Standard RBAC: a principal gets the UNION of the grants of every role it holds.
    Each role's row in the effective matrix already has that role's own ``denies``
    baked in (see :func:`effective_matrix` / :func:`_resolve_custom_role`), so unioning
    the rows is the correct additive combination — and is byte-for-byte the same
    resolution :func:`app.api.routes_roles._grants_for_roles` reports through
    ``GET /api/account/permissions``, keeping the server gate consistent with the UI.

    Resolution + fail-safety rules:

    * ``super_admin`` (as the base role) short-circuits to ALLOW — lockout-proof,
      mirroring :func:`can`.
    * An assigned custom-role name that is NOT present in the resolved matrix, or that
      collides with a built-in role name, contributes NOTHING (fail-safe to the base
      role — an unknown/deleted role never grants and never errors).
    * With NO assigned custom roles (``custom_roles`` empty/None), the result is
      byte-identical to ``can(base_role, resource, action, …)`` — parity preserved.

    The deny-wins precedence within each role is already resolved in the matrix; a
    custom role can therefore RESTRICT what it grants (via its own ``denies``) but the
    union across roles is additive (a second role can re-grant what another denied,
    exactly as RBAC role-union semantics and the permissions endpoint behave)."""
    base_str = _role_str(base_role)
    if base_str == UserRole.SUPER_ADMIN.value:
        return True
    table = matrix if matrix is not None else resolve_matrix(rbac_config)
    # Fast path + strict parity: no assigned custom roles → exactly can().
    names: list[str] = []
    if isinstance(custom_roles, (list, tuple, set)):
        for nm in custom_roles:
            nm_s = str(nm).strip()
            # Drop blanks, built-in collisions, and unknown/deleted roles (fail-safe).
            if not nm_s or nm_s in _BASE_ROLE_NAMES or nm_s not in table:
                continue
            if nm_s not in names:
                names.append(nm_s)
    if not names:
        return can(base_str, resource, action, matrix=table)
    # Union the actions granted on ``resource`` across the base + every valid custom role.
    for role_name in [base_str, *names]:
        actions = (table.get(role_name) or {}).get(resource)
        if actions and (ALL in actions or action in actions):
            return True
    return False


# --------------------------------------------------------------------------- #
# OPT-IN object / row-level scope hook (Round-3 Wave-1; ships OFF).
#
# can_object() refines a COARSE can() allow with an object-level predicate drawn from
# a WHITELISTED condition vocabulary (no eval, no operator-supplied code). It is gated
# by ``object_scoping_enabled`` on the RBAC config and DEFAULTS OFF — with it off,
# can_object() is exactly can() (so Wave 1 ships the hook present but inert).
#
# A condition is a pure ``(user, obj, ctx) -> bool`` function registered in
# ``_OBJECT_CONDITIONS``. The per-role / per-resource binding ("which conditions apply")
# is read from the RBAC config's ``object_scope`` map when present; absent → no
# conditions → allow (defer to can()). Conditions are ANDed; an unknown condition name
# is treated as DENY (fail-closed for the row scope, since the operator asked to scope).
# --------------------------------------------------------------------------- #

ObjectCondition = Callable[[Any, Any, dict[str, Any]], bool]


def _obj_get(obj: Any, key: str) -> Any:
    """Read ``key`` off an object that may be a dict or a model. None-safe."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _user_get(user: Any, key: str) -> Any:
    if user is None:
        return None
    if isinstance(user, dict):
        return user.get(key)
    return getattr(user, key, None)


def _cond_owner(user: Any, obj: Any, ctx: dict[str, Any]) -> bool:
    """The object was created by / belongs to the requesting user."""
    uname = _user_get(user, "username")
    if not uname:
        return False
    owner = _obj_get(obj, "owner") or _obj_get(obj, "created_by") or _obj_get(obj, "author")
    return bool(owner) and str(owner) == str(uname)


def _cond_assignee(user: Any, obj: Any, ctx: dict[str, Any]) -> bool:
    """The object is assigned to the requesting user."""
    uname = _user_get(user, "username")
    if not uname:
        return False
    assignee = _obj_get(obj, "assignee") or _obj_get(obj, "assigned_to")
    return bool(assignee) and str(assignee) == str(uname)


def _cond_source_scope(user: Any, obj: Any, ctx: dict[str, Any]) -> bool:
    """The object's source/tenant is within the user's allowed scope.

    The user's scope is taken from ``user.source_scope`` / ``user.sources`` (a list of
    source ids) OR ``ctx['source_scope']``. An EMPTY/absent scope means UNRESTRICTED
    (allow) — scoping only restricts when an explicit allow-list is present."""
    scope = _user_get(user, "source_scope") or _user_get(user, "sources") or ctx.get("source_scope")
    if not scope:
        return True  # no explicit scope → unrestricted
    obj_src = _obj_get(obj, "source_id") or _obj_get(obj, "source") or _obj_get(obj, "tenant")
    return obj_src is not None and str(obj_src) in {str(s) for s in scope}


def _cond_tenant_scope(user: Any, obj: Any, ctx: dict[str, Any]) -> bool:
    """The object's tenant matches the user's tenant. Absent user tenant → allow."""
    user_tenant = _user_get(user, "tenant") or ctx.get("tenant")
    if not user_tenant:
        return True
    obj_tenant = _obj_get(obj, "tenant") or _obj_get(obj, "tenant_id")
    return obj_tenant is not None and str(obj_tenant) == str(user_tenant)


def _cond_severity_at_most(user: Any, obj: Any, ctx: dict[str, Any]) -> bool:
    """The object's severity is at or below the ceiling in ``ctx['max_severity']``
    (numeric). No ceiling configured → allow. A non-numeric object severity → allow
    (fail-open on a missing signal, the coarse can() already gated the action)."""
    ceiling = ctx.get("max_severity")
    if ceiling is None:
        return True
    sev = _obj_get(obj, "severity")
    try:
        return float(sev) <= float(ceiling)
    except (TypeError, ValueError):
        return True


def _cond_time_window(user: Any, obj: Any, ctx: dict[str, Any]) -> bool:
    """The object's timestamp falls within ``[ctx['after'], ctx['before']]`` (ISO
    strings; either bound optional). No bounds → allow. An unparseable/absent object
    timestamp → allow (fail-open on a missing signal)."""
    after = ctx.get("after")
    before = ctx.get("before")
    if not after and not before:
        return True
    ts = _obj_get(obj, "created_at") or _obj_get(obj, "ts") or _obj_get(obj, "timestamp")
    if not ts:
        return True
    ts_s = str(ts)
    if after and ts_s < str(after):
        return False
    if before and ts_s > str(before):
        return False
    return True


# The ONLY conditions an operator may bind — a closed, code-defined vocabulary.
_OBJECT_CONDITIONS: dict[str, ObjectCondition] = {
    "owner": _cond_owner,
    "assignee": _cond_assignee,
    "source_scope": _cond_source_scope,
    "tenant_scope": _cond_tenant_scope,
    "severity_at_most": _cond_severity_at_most,
    "time_window": _cond_time_window,
}


def object_scoping_enabled(rbac_config: Any) -> bool:
    """Whether the OPT-IN object/row scope hook is engaged. Defaults OFF (so
    :func:`can_object` is exactly :func:`can`). Reads ``object_scoping_enabled`` off
    the RBAC config / dict."""
    val = _attr_from_config(rbac_config, "object_scoping_enabled")
    return bool(val)


def _object_scope_conditions(rbac_config: Any, role: str, resource: str, action: str) -> list[str]:
    """Resolve the list of WHITELISTED condition names bound to ``role`` for
    ``resource[:action]`` from the config's ``object_scope`` map. Shape (all optional,
    each level falls back leniently)::

        object_scope:
          <role>:
            <resource>: ["owner", ...]            # applies to every action
            <resource>:<action>: ["assignee"]     # action-specific (wins if present)

    Returns ``[]`` when nothing is bound (→ no row restriction → allow)."""
    scope_map = _attr_from_config(rbac_config, "object_scope")
    if not isinstance(scope_map, dict):
        return []
    role_map = scope_map.get(role)
    if not isinstance(role_map, dict):
        return []
    specific = role_map.get(f"{resource}:{action}")
    if isinstance(specific, list):
        return [str(c) for c in specific]
    generic = role_map.get(resource)
    if isinstance(generic, list):
        return [str(c) for c in generic]
    return []


def can_object(
    user: Any,
    resource: str,
    action: str,
    obj: Any,
    ctx: dict[str, Any] | None = None,
    rbac_config: Any = None,
    *,
    matrix: dict[str, dict[str, list[str]]] | None = None,
) -> bool:
    """Object/row-level authorisation (OPT-IN). Refines a coarse :func:`can` allow
    with an object-level predicate.

    Evaluation:
      1. The coarse grant MUST allow ``resource:action`` for ``user.role`` (else deny).
      2. ``super_admin`` is unconditionally allowed (parity with :func:`can`).
      3. If object scoping is DISABLED (the default) → return the coarse result
         unchanged (this hook is inert in Wave 1).
      4. Otherwise resolve the WHITELISTED conditions bound to the role for
         ``resource[:action]`` and AND them. No bound conditions → allow. An unknown
         condition name → DENY (fail-closed: the operator asked to scope but named a
         predicate we don't implement).

    Pure (no I/O); ``ctx`` carries request-scoped values (e.g. ``source_scope``,
    ``max_severity``, ``after``/``before``). ``obj`` may be a dict or a Pydantic model.
    """
    ctx = ctx or {}
    role = getattr(user, "role", None)
    if role is None and isinstance(user, dict):
        role = user.get("role")
    role_str = _role_str(role or "")
    coarse = can(role_str, resource, action, rbac_config, matrix=matrix)
    if not coarse:
        return False
    if role_str == UserRole.SUPER_ADMIN.value:
        return True
    if not object_scoping_enabled(rbac_config):
        return coarse  # hook OFF → behave exactly like can()
    conditions = _object_scope_conditions(rbac_config, role_str, resource, action)
    if not conditions:
        return True  # nothing bound for this role/resource → no row restriction
    for name in conditions:
        fn = _OBJECT_CONDITIONS.get(name)
        if fn is None:
            return False  # unknown predicate → fail-closed
        if not fn(user, obj, ctx):
            return False
    return True
