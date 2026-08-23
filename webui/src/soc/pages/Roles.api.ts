/**
 * Co-located API + types for the RBAC Roles admin page (Round 3 / Feature 6).
 *
 * Kept OUT of the shared `lib/api.ts` (parallel-build hygiene): everything the
 * Roles surface needs lives here and rides the low-level `api.get/post/put/del`
 * verbs. The endpoints (all under `/api`) are:
 *   GET    /roles                  — the role → resource → [actions] matrix + roster.
 *   POST   /roles                  — create a custom role.
 *   PUT    /roles                  — update (replace by name) a custom role.
 *   DELETE /roles/{name}           — delete a custom role.
 *   POST   /roles/preview          — resolve a DRAFT role + diff vs the live matrix.
 *   GET    /roles/simulate         — can() outcome for role × resource × action.
 *   GET    /account/permissions    — the CALLER's resolved grants (drives capability).
 *   PUT    /users/{username}/roles — assign a base role + custom_roles[] to a user.
 *
 * #9: role names / descriptions / grant maps are operator-influenceable; they are
 * returned as PLAIN data and rendered escaped (plain text / CodeBlock) — never as
 * HTML and never interpolated into a prompt.
 */
import { api } from '@/lib/api';

/** A grant/deny map: resource → list of actions (may include the "*" wildcard). */
export type GrantMap = Record<string, string[]>;

/** An operator-defined custom role (mirrors backend `CustomRole`). */
export interface CustomRole {
  name: string;
  description: string;
  inherits: string[];
  grants: GrantMap;
  denies: GrantMap;
}

/** GET /api/roles — the resolved matrix + the built-in role roster. */
export interface RolesMatrixResponse {
  roles: string[];
  default_role: string;
  rbac_enabled: boolean;
  matrix: Record<string, GrantMap>;
  /**
   * The RAW operator-defined custom-role definitions (Round-6 #20): the exact
   * `name`/`description`/`inherits`/`grants`/`denies` as stored, so the editor can
   * restore a faithful draft on Edit/Clone. The `matrix` above is the RESOLVED view
   * (inheritance flattened into explicit grants, no description) — prefer these raw
   * defs when seeding a draft. Additive + optional (an older backend omits it → the
   * page falls back to `matrix`). #9: names/descriptions/grant maps are rendered
   * escaped, never fed to a prompt.
   */
  custom_roles?: CustomRole[];
}

/** The per-resource action diff a draft would produce vs the current matrix. */
export interface ResourceDiff {
  added: string[];
  removed: string[];
}

/** POST /api/roles/preview — a no-persistence resolution + diff of a draft role. */
export interface RolePreviewResponse {
  name: string;
  /** role → resource → [actions] (this role's resolved row, wildcards intact). */
  resolved: GrantMap;
  /** wildcards exploded into concrete actions (for a literal grant match). */
  effective: GrantMap;
  /** resource → {added, removed} vs the current matrix. */
  diff: Record<string, ResourceDiff>;
  is_new: boolean;
}

/** GET /api/roles/simulate — a single can() spot-check. */
export interface SimulateResponse {
  role: string;
  resource: string;
  action: string;
  allowed: boolean;
  actions: string[];
  known_resource: boolean;
  role_exists: boolean;
}

/** GET /api/account/permissions — the caller's resolved grants. */
export interface AccountPermissions {
  authenticated: boolean;
  role: string;
  custom_roles: string[];
  rbac_enabled: boolean;
  permissions: GrantMap;
}

/** A draft submitted to create/update/preview a custom role. */
export interface CustomRoleBody {
  name: string;
  description?: string;
  inherits?: string[];
  grants?: GrantMap;
  denies?: GrantMap;
}

export const rolesApi = {
  matrix: () => api.get<RolesMatrixResponse>('roles'),
  create: (body: CustomRoleBody) =>
    api.post<{ ok: boolean; role: CustomRole }>('roles', body),
  update: (body: CustomRoleBody) =>
    api.put<{ ok: boolean; role: CustomRole }>('roles', body),
  remove: (name: string) =>
    api.del<{ ok: boolean }>(`roles/${encodeURIComponent(name)}`),
  preview: (body: CustomRoleBody) =>
    api.post<RolePreviewResponse>('roles/preview', body),
  simulate: (role: string, resource: string, action: string) =>
    api.get<SimulateResponse>('roles/simulate', { role, resource, action }),
  accountPermissions: () => api.get<AccountPermissions>('account/permissions'),
  assignUserRoles: (
    username: string,
    body: { role?: string; custom_roles?: string[] },
  ) =>
    api.put<{ ok: boolean; user: unknown; custom_roles: string[] }>(
      `users/${encodeURIComponent(username)}/roles`,
      body,
    ),
};

/**
 * The canonical resource → actions vocabulary (mirrors backend
 * `rbac/policy.RESOURCES`). The matrix editor builds its grid from THIS so a column
 * appears for every action a resource supports even when no role grants it yet. The
 * server is authoritative — an unknown resource/action submitted in a draft is
 * dropped leniently — but keeping this in sync gives the editor a complete grid.
 * (Round-11 drift fix: `runbooks`, `system_updates`, and `rules` had been added to
 * the backend vocabulary but were missing from this mirror, so the editor grid and
 * the role-permission summary never showed them.)
 */
export const RESOURCE_ACTIONS: Record<string, string[]> = {
  cases: ['read', 'write', 'close', 'assign', 'comment', 'reinvestigate'],
  sources: ['read', 'manage'],
  settings: ['read', 'manage'],
  users: ['manage'],
  proposals: ['read', 'approve'],
  playbooks: ['read', 'run', 'manage'],
  runbooks: ['read', 'manage'],
  rag: ['read', 'manage'],
  memory: ['read', 'manage'],
  cost: ['view'],
  data_export: ['export'],
  system_updates: ['read', 'apply', 'rollback'],
  audit: ['view'],
  metrics: ['view'],
  notifications: ['read', 'manage'],
  branding: ['read', 'manage'],
  sessions: ['read', 'manage'],
  demo: ['read', 'manage'],
  terminology: ['read', 'manage'],
  automation: ['read', 'manage'],
  roles: ['read', 'manage'],
  models: ['read', 'manage'],
  enrichment: ['read', 'manage'],
  inapp: ['read', 'manage'],
  rules: ['read', 'manage'],
};

/** Stable, readable ordering of resources for the editor grid + matrix viewer. */
export const RESOURCE_ORDER: string[] = Object.keys(RESOURCE_ACTIONS);

/** Human-readable labels for the six built-in roles (UI copy; falls back to raw). */
export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  soc_manager: 'SOC manager',
  analyst_tier2: 'Analyst — Tier 2',
  analyst_tier1: 'Analyst — Tier 1',
  responder: 'Responder',
  auditor: 'Auditor',
};

/** The six immutable built-in role names. */
export const BUILTIN_ROLES = new Set(Object.keys(ROLE_LABELS));

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
