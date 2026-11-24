# Round 15 map: RBAC switch, wizard wording, role ownership of "team activity"

Reader scope: (a) RBAC model, (b) settings GET/PUT path, (c) fresh re-auth + confirm
primitives, (d) Console surfaces showing RBAC state, (e) setup wizard mock-runtime copy,
(f) which roles could own "team activity". Branch `claude/round15` = `origin/Testing`
at `c4227bd`. Read only; no repository file edited.

---

## (a) The RBAC model

### a.1 Config: `RBACConfig` (`backend/app/config.py:3400-3497`)

```python
class RBACConfig(BaseModel):
    enabled: bool = False                        # :3411
    default_role: str = "analyst_tier1"          # :3412
    roles: dict[str, dict[str, list[str]]]       # :3414  per-role REPLACE override
    custom_roles: list[dict[str, Any]]           # :3423  loose CustomRole dicts
    resources: dict[str, dict[str, list[str]]]   # :3424  ADDITIVE layer
    denies: dict[str, dict[str, list[str]]]      # :3425  deny-wins layer
    rbac_grants_version: int = RBAC_GRANTS_VERSION (=2)  # :3434
```

* Docstring (`:3401-3409`): "``enabled`` defaults to ``False`` for full back-compat: when
  auth is ON but RBAC is OFF, every authenticated user is treated as ``super_admin``".
* `_normalise_grant_layers` (`:3436-3497`, `mode="before"`) rewrites the retired
  `playbooks` grants onto `runbooks` in every layer and stamps `rbac_grants_version`; a
  block is "legacy" only when it carries all of `_RBAC_PERSISTED_MARKERS`
  (`:3395-3397`: `enabled, default_role, roles, custom_roles, resources, denies`) and no
  current stamp. Any write of the whole `rbac` block from the Console therefore goes
  through this normaliser on validation. A newer stamp is kept (`:3490-3496`).
* `rbac` is a top-level `Preferences` key (real settings, never demo-swapped:
  `state.prefs` is always the real document; `execution_prefs` at
  `backend/app/state.py:737-744` is the demo-aware one, and `_rbac_enabled` reads
  `state.prefs`).

### a.2 How `rbac.enabled` is read (`backend/app/api/deps.py`)

| Function | Lines | Behaviour |
|---|---|---|
| `_rbac_enabled(state)` | 393-395 | `bool(getattr(state.prefs.rbac, "enabled", False))` |
| `_rbac_config_with_custom_roles(state)` | 398-441 | live `prefs.rbac` + `CustomRoleStore` roles unioned by lower-cased name (prefs copy wins); store glitch degrades to plain prefs |
| `_assigned_custom_roles(state, username)` | 444-475 | reads `User.prefs["custom_roles"]`; env admin / glitch -> `[]` |
| `AccessView` (dataclass) | 478-502 | `user, role, unrestricted, matrix, assigned`; `allows()` -> `can_for_roles(...)` unless `unrestricted` |
| `resolve_access(request)` | 505-525 | `require_auth` then `access_view_for`; writes no audit row |
| `access_view_for(state, user)` | 528-552 | auth off -> `AccessView(role="", unrestricted=True)`; **auth on + rbac off -> `unrestricted=True`** (`:538-540`); else resolves matrix + assigned roles |
| `resolve_grants(request, pairs)` | 555-578 | subset of pairs held, no audit (chat catalogue) |
| `_enforce(request, resource, action)` | 979-1006 | `resolve_access`; on deny `record_access_denied` then `403 "permission denied: {resource}:{action}"` |
| `require_permission(resource, action)` | 1009-1016 | dependency factory -> `_enforce` |
| `has_permission(request, ...)` | 1019-1030 | non-raising, no audit |
| `require_role(*roles)` | 1033-1059 | auth off or **rbac off -> passes for any signed-in caller** (`:1044-1047`); super_admin always passes |
| `require_admin` | 1062-1068 | `_enforce(request, "users", "manage")` |
| `require_fresh_auth(window=None)` | 1071-1108 | auth off -> no-op; no sid / unknown sid / store glitch -> treated fresh; `sessions.reauth_age_seconds(row) > window` (default `session_policy.sudo_reauth_window`, 600 s) -> `401 {"code":"reauth_required","reason":"stale_authn","window":win}` |
| `require_system_update_operator` | 1111-1259 | fail-closed: built-in `super_admin` only, never via RBAC-off or custom roles; the strictest existing gate (a model for "only the real owner may flip RBAC") |

Key subtlety: with RBAC off, `user.role` on the token still carries the **stored** role
(`AuthService.set_users`, `backend/app/auth/service.py:224-236`); only the surfaces mask it.
`_resolved_role` (`backend/app/api/routes.py:3424-3431`) reports `super_admin` whenever
RBAC is off, and it feeds `/api/auth/me`, login, refresh and the env-admin
`/api/account/me` (`routes.py:3943, 4066, 4623, 5010, 5180`). `/api/account/permissions`
also reports `role: "super_admin"` while unrestricted (`routes_roles.py:508-518`). So the
Console cannot learn a viewer's real role from `/auth/me` while RBAC is off; persisted
accounts' real roles are visible from `GET /api/users` (users:manage) and
`GET /api/account/me` (`routes.py:4605-4631`, returns `user.public()`).

### a.3 Policy: `backend/app/rbac/policy.py` (1050 lines)

Module docstring (`:1-35`) states the three modes: "auth DISABLED → everything allowed;
auth ON, rbac OFF → every authenticated user is treated as ``super_admin``; auth ON,
rbac ON → :func:`can` is consulted".

**Resources and actions vocabulary** `RESOURCES` (`:51-101`), 24 resources:

```
cases: read, write, close, assign, comment, reinvestigate
sources: read, manage          settings: read, manage
users: manage   (NO "read" action exists)
proposals: read, approve       runbooks: read, run, manage, publish
rag: read, manage              memory: read, manage
cost: view                     audit: view, export
metrics: view                  data_export: export
system_updates: read, apply, rollback
notifications|branding|sessions|demo|terminology|automation|roles|models|enrichment|inapp|rules: read, manage
```
`ALL = "*"` (`:103`). `RBAC_GRANTS_VERSION = 2` (`:131`). `LEGACY_RUNBOOK_RESOURCE =
"playbooks"` (`:139`).

**Settings split** `_SETTINGS_SPLIT` (`:408-415`) + `_settings_like()` (`:417-431`): a
role with `settings: [ALL]` gets `[ALL]` on the 11 narrow resources; `settings: ["read"]`
gets `["read"]` on each. Consequence: **every built-in role holds `sessions:read`,
`roles:read`, `demo:read` etc.** (no route gates on `sessions:read` today; admin
sessions use `require_admin` = `users:manage`, `routes.py:4408-4471`).

**Default matrix per built-in role** (`:434-520`, verified by importing it):

| Role | Grants (24 resources total) |
|---|---|
| `super_admin` (`:434`) | `{res: ["*"] for res in RESOURCES}`; hard-allowed in `can()` (`:785-786`) and `can_for_roles()` (`:840-842`); row forced to full wildcard at the end of `effective_matrix` (`:735-737`) |
| `soc_manager` (`:436-451`) | cases `*`, sources `*`, settings `*`, **users: manage**, proposals `*`, runbooks `*`, rag `*`, memory `*`, cost view, **audit: view, export**, metrics view, data_export export, system_updates read, + every narrow resource `*` (incl. roles `*`, sessions `*`) |
| `analyst_tier2` (`:453-464`) | cases read/write/close/assign/comment/reinvestigate, sources read, settings read, proposals read, runbooks read/run, rag read, memory read, cost view, metrics view, narrow read (20 resources; **no audit**) |
| `analyst_tier1` (`:466-479`) | cases read/write/comment/assign (no close, no reinvestigate), else as tier 2 (20; no audit) |
| `responder` (`:481-493`) | tier1 + proposals approve (20; no audit) |
| `auditor` (`:498-511`) | cases read, sources read, settings read, proposals read, runbooks read (no run), rag read, memory read, cost view, **audit: view, export**, metrics view, narrow read (21) |

`DEFAULT_ROLE = "analyst_tier1"` (`:522`).

**Resolution** `effective_matrix()` (`:673-738`) layers: DEFAULT_MATRIX copy -> `roles`
(REPLACE per role/resource, `_merge_grants(additive=False)`) -> `resources` (UNION) ->
custom roles (resolved against post-(2/3) matrix, cycle-guarded inherits, own denies) ->
global `denies` (deny-wins, **skips super_admin**, `:727-734`) -> super_admin row forced
to wildcard. `_clean_actions` (`:557-564`) silently drops unknown resources/actions;
`_apply_denies` (`:591-614`) expands a wildcard grant before subtracting a narrow deny.
`_custom_roles_by_name` (`:653-670`) drops a custom role whose name shadows a built-in.
`can_for_roles` (`:793-865`) = union of base role + assigned custom roles (unknown names
dropped fail-safe).

**Lockout guards**
* Policy level: super_admin hard-allow + forced wildcard row (above).
* `PUT /api/users/{username}/roles` (`routes_roles.py:572-720`, users:manage + fresh
  auth): super-admin orphan guard (`:651-660`, `_would_orphan_super_admin` ->
  `409 "cannot demote the last active super_admin"`) and last `users:manage` holder
  guard (`:662-674`, `409 "cannot remove the last user who can manage users
  (users:manage)"`).
* `PUT /api/users/{username}` / `DELETE` (`routes.py:5890-5990`): same orphan guard
  (`:5879-5887`, `409 "cannot demote or disable the last active super_admin"`); this
  route has **no** `require_fresh_auth`.
* `count_active_super_admins` (`backend/app/stores/users.py:318-324`) counts persisted
  active users only; the env single admin is `super_admin` in the auth base layer
  (`auth/service.py:170-178`) but is not counted.
* OOBE `/api/setup/account` creates the first admin as `super_admin`
  (`routes_setup.py:193, 210, 237`). SSO-provisioned accounts get
  `oidc default_role` (default `"analyst_tier1"`, `auth/oidc.py:166, 304-309`); other env
  users get `_DEFAULT_ROLE`.

**Custom roles**: CRUD in `routes_roles.py` (`POST/PUT /api/roles`, `DELETE
/api/roles/{name}`: roles:manage + `require_fresh_auth()` at `:284-405`; `POST
/api/roles/preview` and `GET /api/roles/simulate`: roles:read at `:406-478`). Every
mutation is audit-first through `_audited_rbac_write` (`:175-214`, `sink="control"`,
`ActionType.USER_MGMT`, `surface="rbac"`, 503 `audit_unavailable` on a failed append).
Actions `role.created` / `role.updated` / `role.deleted` / `user.role_changed`.

**Read surfaces**: `GET /api/roles` (`routes.py:5649-5682`, auth only) returns
`roles, default_role, rbac_enabled, matrix, custom_roles`. `GET /api/account/permissions`
(`routes_roles.py:480-532`) returns `authenticated, role, custom_roles, rbac_enabled,
permissions` (concrete actions, resource omitted when nothing held). With RBAC off it
returns every action.

### a.4 Console permission catalogue

* `webui/src/soc/pages/Roles.api.ts:133-158` `RESOURCE_ACTIONS` hand mirror of
  `RESOURCES` (24 rows, same order as listed above) + `RESOURCE_ORDER` (`:161`);
  `ROLE_LABELS` (`:197-204`: `super_admin: 'Super admin'`, `soc_manager: 'SOC manager'`,
  `analyst_tier2: 'Analyst Tier 2'`, `analyst_tier1: 'Analyst Tier 1'`, `responder:
  'Responder'`, `auditor: 'Auditor'`), `BUILTIN_ROLES`, `roleLabel()`.
* Pinned by **`backend/tests/test_round14_contracts.py:1136-1170`**
  `test_roles_matrix_mirror_never_drifts_beyond_the_pending_round14_actions`: exact
  ratchet (`_ROLES_MIRROR_PENDING = frozenset()`, `_ROLES_MIRROR_RETIRED = frozenset()`),
  so **a new backend resource/action must be added to `RESOURCE_ACTIONS` in the same
  change** or this test fails.
* Consumers: `RoleMatrixEditor.tsx`, `RolePermissionSummary.tsx` (explodes `*` against
  the mirror; unknown wildcard -> "all actions"), `Roles.tsx`, Users create dialog.
* `webui/src/soc/auth.tsx` `hasPermission` (`:201-214`): auth off -> true; `role ===
  'super_admin'` -> true; grants failed -> false; **`!rbacEnabled` -> true**; else
  `grants[resource]?.includes(action)`. `rbacEnabled` is set only from
  `/api/account/permissions` and only when `me.authenticated && me.auth_enabled`
  (`:118-137`), so with auth OFF `rbacEnabled` is always false in the Console even when
  `prefs.rbac.enabled` is stored true.
* Nav/route gating: `webui/src/soc/registry.tsx` `FEATURES[]` (`perm` per node; Audit at
  `:434-438` `{ resource: 'audit', action: 'view' }`; Settings children Users/Roles
  `:466-467`).

### a.5 Tests pinning RBAC behaviour (update if any grant changes)

* `backend/tests/test_rbac_policy.py:34-117` super-admin grid + `TRUTH_TABLE` per role
  (e.g. `(AUD, "audit", "view", True)`, `(AUD, "audit", "export", True)`, `(MGR, "users",
  "manage", True)`, `(T2, "users", "manage", False)`), `:172-193` matrix shape incl.
  `set(DEFAULT_MATRIX[SA].keys()) == set(RESOURCES.keys())`.
* `backend/tests/test_round3_wave1_rbac.py:61-92` parity of `can()` vs `DEFAULT_MATRIX`
  over the full grid; `NARROW` list `:41-44`.
* `backend/tests/test_round3_wave5_rbac.py`, `test_round3_wave2b_rbac.py`,
  `test_rbac_users.py`, `test_account_permissions_effective.py`, `test_resolve_grants.py`,
  `test_runbook_permissions.py` (`:267-308` uses `PUT /api/settings {"rbac": {"roles":
  ...}}`).
* Webui: `soc/__tests__/roles-matrix.test.tsx`,
  `soc/components/__tests__/RolePermissionSummary.test.tsx`,
  `soc/pages/__tests__/Users.create-dialog.test.tsx`,
  `soc/__tests__/roles.page.round14.test.tsx:92` ("holding 2 resource grants").
* No test pins `len(RESOURCES) == 24`.

### a.6 The CI test that requires every route to be gated

**`backend/tests/test_route_auth_coverage.py`**:
* `test_every_api_route_is_auth_covered` (`:93-110`): every `/api` APIRoute has
  `require_auth` (mounted router-wide: `backend/app/main.py:154, 163`) or is in
  `deps.PUBLIC_API_PATHS`.
* `test_state_changing_routes_declare_authz` (`:171-195`): every **non-GET** `/api`
  route has a dependency whose qualname is in `_AUTHZ_DEP_QUALNAMES` (`:48-53`:
  `require_permission.<locals>._dep`, `require_role.<locals>._dep`,
  `require_fresh_auth.<locals>._dep`, `require_admin`) or references `_enforce` in its
  bytecode (`:69-90`), else must be in `_AUTHZ_EXEMPT` (buckets `:124-168`, bounded
  `len(_AUTHZ_EXEMPT) <= 31` at `:232`; today 22 entries).
* **Gap: GET routes are only auth-checked, not authz-checked.** A new GET that returns
  team activity without `require_permission` passes CI while leaking to every signed-in
  account. Any new read must declare its gate explicitly (and ideally get a test).
* `test_public_paths_are_minimal_and_known` (`:338-363`), `test_no_unprotectable_routes_under_api`
  (`:366-374`). New `routes_*.py` modules are auto-mounted (`main.py:35-70`); a router
  module needs a top-level `router` or boot raises. `test_round5_coupling_routes.py:31-78`
  checks discovery is sorted and no duplicate (method, path).
* Note `require_fresh_auth` alone satisfies the authz meta-test (it is in the qualname
  set) even though it is not an RBAC grant; pair it with `require_permission`.

---

## (b) The settings path

### b.1 `GET /api/settings` (`backend/app/api/routes.py:1726-1732`)

```python
@router.get("/settings")
async def get_settings(state=Depends(get_state)):
    return {"prefs": state.prefs.model_dump(mode="json"),
            "configured": state.secrets.configured_status(),
            "read_only": state.prefs.read_only_settings_mode}
```
No permission dependency (auth only via the router). **It does not hide `rbac`**: the
whole block (enabled, roles, custom_roles, resources, denies, stamp) reaches every
signed-in account. `GET /api/settings/schema` (`:1735-1744`) and `GET
/api/settings/{section}` (`:2046-2061`) need `settings:read`. The schema titles `rbac` as
`"RBAC"` (`backend/app/api/settings_schema.py:66-68`).

### b.2 `PUT /api/settings` (`routes.py:1938-2027`)

* Gate: `require_permission("settings", "manage")` only (`:1943`). **No
  `require_fresh_auth`**, no special handling of `rbac`.
* `_apply(current)` (`:1975-1995`): read-only lock -> `403 "Settings are in read-only
  mode"` unless the body sets `read_only_settings_mode: false` (`:1976-1980`);
  `_reject_out_of_range_caps` + `_reject_out_of_range_remember_me` (body-level 422s);
  `map_retired_runbook_writes`; `_deep_update(current.model_dump(), body)`; **only `demo`
  is protected** (`merged["demo"] = current.demo...`, `:1991`); `Preferences.model_validate`
  -> 422 `"Invalid settings: ..."`.
* Audit-before-visible via `audited_prefs_write` (`backend/app/audit/prefs_write.py:185-233`):
  action `settings.updated`, `ActionType.STATUS`, `surface="settings"`, sink
  `control_audit`; target from `settings_target()` (`:100-111`, label from
  `section_label()` -> `_humanise` -> "RBAC"); failed append -> `503 audit_unavailable`,
  nothing saved; CAS on the change set with 3 attempts then `409 settings_conflict`
  (`:55-62`). Summary `"updated settings: rbac"` (`routes.py:2000-2006`). Then
  `_record_settings_rule_versions` and poller start.
* So today **any role holding `settings:manage` (soc_manager, or a custom role) can
  rewrite `rbac.enabled`, `rbac.roles`, `rbac.denies`, `rbac.custom_roles` through this
  path without `roles:manage` and without a fresh sign-in**, whereas the dedicated role
  CRUD requires `roles:manage` + fresh auth. With RBAC ON, a soc_manager can turn RBAC
  OFF (everyone becomes Super admin) this way. A Console switch should not widen this;
  the design may want to route `rbac.enabled` through a stricter dedicated endpoint (the
  Demo precedent: `demo` is managed only by `/api/demo/*`, PUT never writes it).
* Curated settings routers use `audited_settings_write` (`backend/app/audit/settings_write.py:140`)
  in routes_baseline/tuning/enrichment/rules/analyst_policy/models/batch/campaigns.
* `read_only_settings_mode` is honoured by PUT settings (`routes.py:1977`), routes_prefs
  (`:71, 293, 322`), routes_storage (`:81`), routes_enrichment (`:275`), routes.py
  `:3315`. **The roles routes do not check it.**
* Console save: `webui/src/soc/pages/Settings.tsx:483-551` sends `changedPatch(prefs,
  savedPrefs)` (`webui/src/soc/pages/settings-dirty.ts:201-213`): **whole changed
  top-level keys**, so a draft edit of `rbac.enabled` would PUT the entire `rbac` block as
  the client last read it. `canSave = hasPermission('settings', 'manage')`
  (`Settings.tsx:335`). The Settings page does **not** call `auth.refresh()` after a save,
  so `useAuth().rbacEnabled` would stay stale until reload.
* UI standard rule (`docs/development/ui-standard.md:2010-2016`): "Never introduce a
  second section-local preference save path." An immediate, confirmed action (like Demo
  Mode or role CRUD) is the existing alternative.
* No section owns `rbac`: `security` owns `['sso','session_policy','mfa']`
  (`settings-sections-meta.ts:465`); `rbac` is in `CURATED_SECTIONS` in
  `webui/src/soc/pages/settings/advanced-schema.tsx:54-80` (`'rbac'` at `:65`), so the
  "All settings" long tail hides it too. That is why there is no switch anywhere.

### b.3 `/api/setup/status` (`routes.py:545-596`, PUBLIC)

Returns `"rbac_enabled": bool(getattr(p, "rbac", None) and p.rbac.enabled)` (`:575`) next
to `auth_enabled`, `needs_user`, `user_count`, `seeded_default`, `configured`, etc.
`webui/src/lib/types.ts:1025` declares `rbac_enabled?: boolean` on `SetupStatus`; no
Console code reads it (grep). Docs use it as the verification step.

---

## (c) Fresh re-authentication and confirmation in the Console

* **`webui/src/soc/components/ReauthDialog.tsx`** (203 lines): global gate registered
  with `setReauthHandler` only when `active` (`:68-82`); mounted once in
  `webui/src/soc/App.tsx:206` as `<ReauthDialog active={authEnabled} />`. Any API call
  that answers `401 {code:'reauth_required'}` opens it, then retries once
  (`webui/src/lib/api.ts:686-700`; `clean !== 'auth/reauth'`). Title "Confirm your
  identity"; description `purpose || 'Sign in again to confirm this change.'` (`:129`);
  fields Password + "Authentication code (if enabled)"; button "Sign in". Calls
  `api.auth.reauth(password, code)` -> `POST /api/auth/reauth` (`routes.py:4366-4388`,
  stamps `last_authn_at`, audited `auth.reauthenticated` / `auth.reauth_failed`).
  Per-request purpose: `RequestOptions.reauthPurpose` (`api.ts:645-646`), e.g.
  `api-audit.ts:81` `AUDIT_EXPORT_REAUTH_PURPOSE`.
* So a backend route with `require_fresh_auth()` needs **no Console reauth code**: the
  call just works through the global gate (pattern used by `DangerZone.tsx:13-14`,
  `Users.tsx:925`, `AdminSessions.tsx:13`, role CRUD in `Roles.tsx`).
* Existing fresh-auth routes: `POST /api/admin/sessions/{sid}/revoke` and
  `POST /api/admin/users/{username}/revoke-all` (`routes.py:4428-4471`), role CRUD
  (`routes_roles.py:290, 329, 370`), `PUT /api/users/{u}/roles` (`:579`), reset
  (`routes_reset.py:37`), exports (`routes_export.py:52, 1647, 1747`), storage apply
  (`routes_storage.py:135`), jobs check freshness in body (`routes_jobs.py:515-536`).
  **No Settings switch currently requires fresh auth** (Settings rows all ride the one
  page save); the closest "switch + confirm" precedent is Demo Mode
  (`webui/src/soc/components/DemoModeSection.tsx`, its own `/api/demo/*` calls) and the
  wizard's live/demo confirmation (`Wizard.tsx:640-650`).
* **`webui/src/soc/components/ConfirmDialog.tsx`** (270 lines): the one destructive gate.
  `useConfirm()` + `<ConfirmRoot/>` imperative, or controlled `<ConfirmDialog open
  onOpenChange onConfirm title description confirmLabel destructive busy hideConfirm
  returnFocusRef richDescription>` (`:44-80`). `destructive` locks Escape/overlay
  dismissal; `busy` keeps the dialog open during async work (aria-disabled, focus kept).
  Test: `soc/components/__tests__/ConfirmDialog.test.tsx`. Roles.tsx uses it at
  `:410-423`.
* `SettingRow` variants (`webui/src/soc/pages/settings/primitives.tsx:373-630`):
  `switch` (`checked`, `onCheckedChange`, `disabled`), `status` (`status` + optional
  `action`), `action`, `link`, `select`, `field`, `control`, `block`. A posture row with
  `variant="status"` and an `action` button is within the standard
  (`ui-standard.md:1990-1997`).

---

## (d) Console surfaces showing RBAC state

1. **`webui/src/soc/pages/settings/security.tsx`** (`OrgSecuritySection`, 71 lines):
   `const { authEnabled, rbacEnabled, role } = useAuth();` (`:33`). Group "Posture",
   caption ``What the backend enforces now. You are signed in as ${roleLabel(role)}.``
   (`:41-42`; with RBAC off this always says "Super admin"). Rows:
   * `label="Authentication"` help "Every request needs a signed-in account." status
     `Enforced` / `Off` (`:44-49`).
   * `label="Role-based access"` help "Each role sees and does only what its permissions
     allow." status `rbacEnabled ? 'Enforced' : 'Off: everyone is Super admin'`, tone
     `warning` when off (`:50-55`).
   * `label="Single sign-on"` reads `persistedPrefs` (`:56-64`).
   Section meta `id: 'security'`, title "Single sign-on & policy", `perm: SETTINGS_MANAGE`,
   ownedKeys `['sso','session_policy','mfa']` (`settings-sections-meta.ts:456-466`).
   Test: `webui/src/soc/__tests__/security-sso.providers.test.tsx` (mocks `useAuth` as
   `{ authEnabled: true, rbacEnabled: true, role: 'super_admin' }` at `:34`; asserts the
   Posture group's single sign-on row at `:113-119`). No test asserts the RBAC row text.
2. **`webui/src/soc/pages/Roles.tsx`** (`RolesInner`, gated `ProtectedRoute
   resource="roles" action="manage"`, `:150`): callout when `perms && !perms.rbac_enabled`
   (`:348-355`):
   > `<Callout intent="warning" title="Role-based access is off">` Every signed-in account
   > counts as Super admin, so these roles are not enforced yet. Turning it on is a change
   > to the stored settings (`<code>rbac.enabled</code>`) through the settings API; there is
   > no switch for it on this page.

   The "Roles" group caption shows `data-testid="roles-capability"` only when
   `rbac_enabled` (`:367-389`), else "Built-in roles are fixed. Clone one to start a
   custom role." Section meta `id: 'roles'`, "Roles & permissions", `perm: { resource:
   'roles', action: 'manage' }`, keywords include `'rbac'` (`settings-sections-meta.ts:445-455`).
   **Test that must change:** `webui/src/soc/__tests__/roles.page.round14.test.tsx:121-142`
   asserts the callout has 'Role-based access is off', 'Every signed-in account counts as
   Super admin', **'there is no switch for it on this page'**, not "Turn on RBAC in
   Security settings", and the caption fallback.
3. **Session policy / Remember me** (`webui/src/soc/components/SessionPolicyEditor.tsx`):
   `rbacEnabledOf(prefs)` (`:138-142`) reads the settings draft; `rbacOffNote`
   (`:238-244`): "Role-based access is off, so every account counts as Super admin.
   Excluding Super admin turns Remember me off for everyone." / "... While Super admin
   is excluded, Remember me is off for everyone." Embedded via `Security.tsx:713-719`
   (`rbacEnabled: rbacEnabledOf(prefs)`). Tests:
   `soc/components/__tests__/SessionPolicyEditor.remember.test.tsx:318-386` and
   `soc/pages/__tests__/Security.remember.test.tsx:44-55`. Backend mirror:
   `effective_roles` in `app/auth/session_limits.py` used by `routes.py:3627-3629`.
   Turning RBAC on changes which accounts Remember me excludes.
4. `webui/src/soc/pages/PageAccess.tsx:42-45` `grantsUnknown` relies on "RBAC reported
   off together with a denial is exactly the failed read"; `CaseDetail.tsx:505,579`
   (`unrestricted: !authEnabled || !rbacEnabled`); `AppShell.tsx:304,1038-1046` (system
   updates need `role === 'super_admin'`).
5. Settings registry: `SECTION_GROUP_ORDER` (`settings-sections-meta.ts:92-98`: Account,
   General, Integrations, **Security & access**, Organization); Security & access order
   pinned by `webui/src/soc/pages/settings/__tests__/settings-sections.test.ts:133-141`
   (`admin_users, roles, security, admin_sessions, keys`); `EXPECTED_IDS` `:30-61`;
   `SECTION_KEYS` derived from `ownedKeys` and pinned `:180-200`; form-width list
   `:258-286`; copy rules `:294-300` (help required, no em dash, no "playbook").
   `SETTING_ANCHORS` (`:606-640`) has **no** security/roles anchors today; adding one
   changes `backend/app/knowledge/console_map.json` (contract test
   `webui/src/soc/__tests__/console-map.contract.test.ts`, regenerate with
   `npm run gen:console-map` then `python scripts/build_app_knowledge.py`).
6. Palette: `backend/app/api/routes_search.py:77` `{"type":"settings","id":"users","label":
   "Users & roles","keywords":"settings rbac members"}`.

**After a toggle**: the actor's Console must call `useAuth().refresh()` (`auth.tsx:105-140`)
to re-read `/auth/me` (role unmasked) and `/account/permissions`; other people's
Consoles keep stale grants until their next refresh; the server is authoritative (403s;
`PageAccess.isPermissionRefusal`). Running chat turns re-check grants at each run start
(`routes_chat.py:1440-1456`, `turn_authority_lost` at `:1372`), and
`recheck_chat_turns_for(state, username)` (`:1480`) exists per user.

**Docs that state "no switch" (all must change with the switch):**
* `docs/administration/users-rbac.md:11-45` ("## Turn on role-based access", "The 0.1.13
  Console has no switch for it", curl recipe).
* `docs/administration/settings.md:162-164`.
* `docs/getting-started/first-run.md:49-56` (note "Role-based access is off by default").
* `docs/getting-started/install.md:203-209`, `docs/getting-started/quickstart.md:166`.
* `DEPLOY.md:1022-1038` ("**Turn RBAC on.** The 0.1.13 Console has no switch for it (a
  known gap)").
* `INSTALL.md:694-720, 1285`; `README.md:437-442`.
* Generated: `backend/app/knowledge/app_docs.json` (4 hits of "no switch"; rebuild with
  `scripts/build_app_knowledge.py`, gate `build_app_knowledge --check`).

---

## (e) The setup wizard (`webui/src/soc/pages/Wizard.tsx`, 1542 lines)

**Eager, on the first-paint entry chunk** (`webui/src/soc/App.tsx:31-35`: "Login + the
first-run Wizard stay EAGER"; `Wizard.tsx` was +958 B in the Round 14 entry
measurement). Entry budget: `webui/src/soc/__tests__/bundle-first-paint.test.ts:158-159`
`PRE_REVAMP_ENTRY_BYTES = 336_216`, `REVAMP_ENTRY_BUDGET_BYTES = 1_024`; the existing
`webui/dist` entry `index-BU2lQpgf.js` is **337,163 B = 77 B of headroom**. Any wording
change in Wizard.tsx must be byte-neutral or shorter (or the baseline re-recorded with a
justification in the test comment).

### e.1 Every mock-runtime / provider / readiness string (line numbers)

| Line | Location | Current string | Branch | Correct? |
|---|---|---|---|---|
| 117 | `STEPS[2].title` | `'Connect an AI runtime'` | both | fine |
| 119 | `STEPS[2].description` (rail) | `'Add a provider credential for live investigations, or use the mock runtime.'` | both | **wrong for live** (no live mock) |
| 772-773 | Workspace heading/description | "How do you want to start?" / "Use realistic synthetic activity ... Demo data stays isolated and can be removed at any time." | both | fine |
| 787-788 | Live choice | "Live environment" / "Connect your security data and an AI provider. The Console starts processing once setup is launched." | live | fine |
| 802-808 | Demo choice | "Synthetic demo" / "Seed sample cases, metrics, and activity without touching a real SIEM or incurring model cost." detail `'Isolated · reversible · $0 inference'` | demo | fine |
| 816 | workspace note | `'Demo is active. The next two steps are optional; sample activity and the mock AI runtime are already available.'` | demo | fine |
| 817 | workspace note | `'Live mode is selected. Add at least one source and provider key for full triage capability.'` | live | fine |
| 1281 | `KEY_FIELDS` OpenAI | `'Default runtime for GPT-5.6 Luna completion roles and vector embeddings.'` | both | fine |
| 1286 | Anthropic | `'Optional alternate runtime for Claude models.'` | both | fine (but see e.3) |
| 1291 | Embedding | `'Optional. Leave blank to reuse the OpenAI key for knowledge retrieval.'` | both | fine |
| 1318-1319 | Keys heading | "Connect the models that investigate cases" / "Add at least one provider for live reasoning. Model selection, budgets, and routing stay configurable in Settings after launch." | both | fine |
| 1322 | Alert variant | `demoMode ? 'info' : anyConfigured ? 'success' : 'warning'` | | |
| 1332 | AlertTitle | `'Mock runtime available'` | demo | fine |
| 1334 | AlertTitle | `'Live provider configured'` | live + key | see e.3 |
| 1335 | AlertTitle | `'A live provider is recommended'` | live, no key | weak ("recommended" understates: nothing can be investigated) |
| 1339 | AlertDescription | `'Demo investigations run against the deterministic mock runtime at no inference cost. A live key is optional.'` | demo | fine |
| 1341 | AlertDescription | `'New credentials replace only the provider you update; existing secret values are never shown.'` | live + key | fine |
| 1342 | AlertDescription | **`'You can continue without a key, but live investigations will use the limited mock runtime until a provider is added.'`** | live, no key | **the reported bug** |
| 1351 | field description suffix | `` `${field.description} Stored write-only; the Console reports only whether it is configured.` `` | | fine |
| 1362 | footnote | "Typed keys save automatically whenever you leave this step." | | fine |
| 1404 | Review heading | `'Demo workspace is ready'` | demo | fine |
| 1406 | Review heading | `'Ready for live triage'` | live, source + key | see e.3 |
| 1407 | Review heading | `'Ready with limited capabilities'` | live, missing | fine |
| 1409 | Review description | `'Sample cases and the mock runtime are available as soon as you launch.'` | demo | fine |
| 1411 | Review description | `'Your source and AI runtime are connected. Polling and triage can begin after launch.'` | live full | fine |
| 1412 | Review description | `'You can launch now, but the Console will remain partially configured until the warnings below are resolved.'` | live partial | fine |
| 1453-1466 | `ReadinessRow` "AI runtime" | key: `` `Configured: ${Anthropic, OpenAI}` ``; demo: `'Deterministic mock runtime · no inference cost'` (`:1464`); live no key: **`'No provider configured · mock runtime only'`** (`:1465`) | | **wrong for live** |
| 1475-1479 | "Automation posture" | "Enabled by default. Tunes investigation routing and groups related cases. Close and escalation decisions remain deterministic. Setup does not change an existing automation policy." badge "On by default" | | fine |
| 1516 | `ReadinessRow` status | `'Ready'` / `'Needs attention'` / `'Optional'` | | |

Readiness states: AI runtime `state={hasProvider ? 'ready' : demoMode ? 'optional' :
'warning'}` (`:1454`); Data sources `:1432`; Workspace always ready (`:1426`). Stepper
`stepStates` (`:397-402`); Continue label "Skip for now" when step 2 has no provider and
no typed key (`:403-408`).

### e.2 What the backend really does without a key

* Completion: `LLMGateway._provider_kwargs` raises `GatewayError("OpenAI API key not
  configured")` / `"Anthropic API key not configured"` before any request
  (`backend/app/llm/gateway.py:752-773`); classified `FAILURE_NOT_CONFIGURED`
  (`:264-267`); the investigation routes to NEEDS_HUMAN (Conventions: "Never let an
  LLM/ES/tool error drop an alert -> route to NEEDS_HUMAN"). The gateway's
  `_mock_fallback = MockProvider()` (`:525`) is used **only for embeddings**
  (`:1162-1166`, `:1221-1223`: hash embeddings, never persisted), not completions.
* Demo Mode injects the `DemoMockProvider` via provider overrides (`:527-530`).
* The docs already describe the truth and call the wizard copy a known issue:
  `docs/getting-started/first-run.md:303-313` ("Without a key the Console still runs, but no
  investigation can call a model: each cluster sent to investigation becomes a **Needs
  human** case whose recommended action names the missing key, and nothing is closed
  automatically. The `$0` mock model is used only by Demo Mode." + `!!! warning "Known
  issue in 0.1.13: the mock runtime wording"`), `:345-351` (review row), `INSTALL.md:606-622,
  641`, `README.md:462` ("Its "mock runtime only" wording is wrong in 0.1.13").
  `docs/USAGE.md:192-197` is correct. All these known-issue notes must be removed or
  rewritten when the copy is fixed, then `app_docs.json` rebuilt (3 "mock runtime" hits).
* Screenshot assets with the old copy: `docs/assets/screenshots/install-05-setup-ai-runtime.webp`
  (callout) and `install-06-setup-review.webp` ("mock runtime only"), referenced from
  `first-run.md:289, 342`, `INSTALL.md:604`, README figures. They become stale.

### e.3 Adjacent inaccuracies worth fixing at the same time (decide in SPEC)

* `hasProvider` / `anyConfigured` (`:275-276`, `:1312-1313`, `:1397-1398`) count only
  `openai_api_key` / `anthropic_api_key`. Fresh roles default to OpenAI `gpt-5.6-luna`
  (docs `first-run.md:315-318`: "An Anthropic key alone is therefore not enough"), so an
  Anthropic-only workspace shows "Live provider configured" / "Ready for live triage"
  while every investigation fails as Needs human. Azure / Bedrock / Vertex / LiteLLM
  credentials (`Secrets.configured_status`, `backend/app/config.py:405-427`) are ignored.
* Line 1335 "A live provider is recommended" understates; without a key nothing is
  investigated by a model.

### e.4 Tests that assert wizard strings

* `webui/src/soc/pages/__tests__/Wizard.onboarding.test.tsx`: `:129` "Preparing workspace
  choices and deployment readiness"; `:164` "Connect the systems you already use"; `:211,
  263, 291` heading `/Ready with limited capabilities/i`; **`:265`
  `getAllByText(/Needs attention/i)).toHaveLength(2)` and `:294` `toHaveLength(1)`**
  (new copy must not contain "Needs attention"); `:225` "Couldn’t switch workspace mode";
  `:235` "On by default"; `:317` "Couldn’t complete setup". Default fixture `configured:
  {}` (`:89`).
* `webui/src/soc/pages/__tests__/Wizard.demo.test.tsx`: `:136-138` alertdialog
  `/removes its isolated sample activity/i`; `:139` button "Disable demo and switch";
  `:181` "Requires demo management permission"; `:206` "...to disable the active demo";
  radios "Synthetic demo"/"Live environment".
* `webui/src/soc/pages/__tests__/Wizard.round14.test.tsx`: `:138` "Get operational"; `:158`
  `/Optional in Demo mode/` (not in an alert, no em dash).
* **No test asserts** "limited mock runtime", "mock runtime only", "or use the mock
  runtime", "Mock runtime available" or "A live provider is recommended" (grep of
  `webui/src`), so the fix needs new assertions rather than edits.
* Other files importing Wizard (route/boot tests): `soc/__tests__/auth-boot-gates.test.tsx`,
  `bundle-first-paint.test.ts`, `nav-current-title.dom.test.tsx`, `overview-cases-route.test.tsx`,
  `registry-router-round6.test.tsx`, `reports-route.test.tsx`, `route-registry.test.tsx`,
  `settings.render.test.tsx`.

---

## (f) Which roles could own "team activity"

Current relevant grants (from `DEFAULT_MATRIX`, verified):

| Role | `audit:view` | `audit:export` | `users:manage` | `metrics:view` | `cost:view` | `sessions:*` | `cases` |
|---|---|---|---|---|---|---|---|
| super_admin | yes (hard-allow) | yes | yes | yes | yes | `*` | `*` |
| soc_manager | yes | yes | yes | yes | yes | `*` | `*` |
| analyst_tier2 | no | no | no | yes | yes | read | read/write/close/assign/comment/reinvestigate |
| analyst_tier1 | no | no | no | yes | yes | read | read/write/comment/assign |
| responder | no | no | no | yes | yes | read | read/write/comment/assign |
| auditor | yes | yes | no | yes | yes | read | read |

* There is **no `users:read`** (users has only `manage`), so `GET /api/users`
  (`routes.py:5784-5790`) is soc_manager/super_admin only; an auditor cannot list
  accounts. A team-activity surface for auditors must derive people from audit rows (or
  a new grant) rather than `/api/users`.
* `sessions:read` is held by **every** role via `_settings_like(["read"])` and is not
  used by any route; reusing it for team activity would expose the page to analysts.
  `metrics:view` is likewise held by every role.
* `audit:view` is already exactly {super_admin, soc_manager, auditor}: the Audit page
  (`registry.tsx:434-438`), `GET /api/audit`, `/api/audit/count`,
  `/api/audit/records/{id}` (`routes_audit.py:1248` `_AUDIT_VIEW`), chat ops tool
  (`backend/app/agents/chat_tools/ops.py:590`). It has a `people` scope
  (`routes_audit.py:528-533`).
* Self-service already exists: `GET /api/account/activity` (`routes.py:4391-4402`, the
  caller's own rows via `audit.records_for_actor`, `routes.py:4517-4535`;
  `audit/audit_log.py:185`, `stores/base.py:865`, `stores/sql/repositories.py:1445`).
* Options for the "i hope we have a role for that" ask:
  1. Reuse `audit:view` (no vocabulary change; same audience as the audit log).
  2. Add a narrow resource, e.g. `team: ["view"]` (or `activity: ["view"]`), granted to
     soc_manager and auditor (super_admin automatically via
     `_SUPER_ADMIN = {res: [ALL] for res in RESOURCES}`). Cost: `RESOURCES`,
     `_SOC_MANAGER`, `_AUDITOR`, `Roles.api.ts RESOURCE_ACTIONS` (contract test above),
     truth-table rows, docs table `docs/administration/users-rbac.md:47-56`, and
     `api-types.gen.ts`/`openapi.json` regen if the enum appears in schemas. Stored
     `rbac.roles` REPLACE overrides only touch resources they name, so a new resource
     keeps its default for upgraded installs; custom roles get nothing unless they
     inherit a base role.
  3. A dedicated "Team lead" built-in role is NOT cheap: `UserRole` (`constants.py:584-595`)
     is the six-value enum used by `_VALID_ROLES`, `_BASE_ROLE_NAMES`, OIDC group maps,
     `ROLE_LABELS`, Remember-me excluded roles, the users-rbac doc table and many tests.
* Whatever is chosen, the new GET routes must carry `require_permission(...)` explicitly
  (CI does not enforce authz on GETs, see a.6).

---

## Constraints and risks for the RBAC switch (summary)

1. **Authority**: with RBAC off every signed-in caller passes `require_permission` and
   `require_role`; only the real stored role distinguishes owners. A switch route should
   check the caller's **stored** role (super_admin) or the post-enable grant
   (`can_for_roles(real_role, assigned, "roles", "manage", matrix)`) to prevent
   self-lockout, plus at least one active super_admin (persisted
   `count_active_super_admins` or the env admin) before enabling.
2. **Turning it off** is a privilege escalation of every account (all become Super
   admin): should be stricter (super_admin only + fresh auth + destructive confirm), and
   PUT `/api/settings` currently lets any `settings:manage` holder do it silently.
3. **Auth off**: `prefs.rbac.enabled` has no effect while `TLSOC_AUTH_ENABLED` is false,
   and the Console's `rbacEnabled` is always false then. The switch must be disabled or
   explain that sign-in must be on first (cf. `require_system_update_operator` 409
   `update_auth_required` wording).
4. **Fresh auth**: add `require_fresh_auth()`; the global `ReauthDialog` handles the
   401 transparently (pass a `reauthPurpose` sentence).
5. **Audit**: reuse `audited_prefs_write` (action `settings.updated`, target "RBAC",
   change `rbac.enabled: false -> true`) or a new action, which then needs
   `backend/app/audit/event_categories.json` + `webui/src/soc/components/audit/events.ts`
   (contract `webui/src/soc/components/audit/__tests__/events.contract.test.ts`).
6. **Console refresh**: call `auth.refresh()` after success; update Posture row,
   Roles callout, Remember-me note; consider showing how many accounts hold each role
   (from `GET /api/users`) and the actor's own future role in the confirm dialog.
7. **Generated artefacts**: a new endpoint changes `webui/openapi.json` +
   `webui/src/lib/api-types.gen.ts` (`npm run check:types`); a new Settings anchor
   changes `console_map.json` + knowledge manifest; doc edits change `app_docs.json`.
8. **Entry budget**: Wizard.tsx and `registry.tsx` are first-paint; 77 B headroom.
9. **MutationAdmissionMiddleware** wraps every mutation (see
   `backend/tests/test_postgres_rollback_compat.py:112-120`); a new write route inherits it.
