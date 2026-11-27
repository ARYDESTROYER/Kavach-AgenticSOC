/**
 * The role-based access switch (Round 15 SPEC D1.2): `GET` and `PUT /api/rbac`.
 * Type-only, so it adds nothing to any bundle. Mirrors `RbacStatus` and
 * `RbacUpdateResult` in `backend/app/api/routes_rbac.py`.
 */

/** Why the caller may not change role-based access now (a closed vocabulary). */
export type RbacBlocker = 'auth_off' | 'not_super_admin' | 'read_only_settings';

export interface RbacStatus {
  /** Whether role-based access is on (`rbac.enabled`). */
  enabled: boolean;
  /** Whether sign-in is on. Without it roles have no effect. */
  auth_enabled: boolean;
  /** Whether the caller may turn it on or off now (no blockers). */
  can_change: boolean;
  blockers: RbacBlocker[];
  /** The caller's stored role, even while role-based access is off ('' with sign-in off). */
  caller_role: string;
  /** Active Super admin accounts, the environment administrator included. */
  super_admin_count: number;
  /** Active accounts per stored role, for a caller holding users:manage; else null. */
  role_counts: Record<string, number> | null;
}

export interface RbacUpdateResult extends RbacStatus {
  /** False when role-based access was already in the requested state. */
  changed: boolean;
}
