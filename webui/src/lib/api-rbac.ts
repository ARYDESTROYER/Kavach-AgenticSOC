/**
 * The role-based access switch (Round 15 SPEC D1.2, D1.4). A lazy data module: only the
 * Roles & permissions section imports it, so nothing here reaches first paint.
 *
 * The change goes through the exported `request` because the generic `api.put` cannot
 * carry a re-authentication purpose: `PUT /api/rbac` asks for a strict fresh sign-in,
 * and the sign-in-again dialog says what it is for.
 */
import { api, request } from '@/lib/api';
import type { RbacStatus, RbacUpdateResult } from '@/lib/types-rbac';

/** What the sign-in-again dialog says the fresh sign-in is for. */
export const RBAC_REAUTH_PURPOSE = 'Sign in again to change role-based access.';

export const rbacApi = {
  /** `GET /api/rbac` (roles:read). */
  status: () => api.get<RbacStatus>('rbac'),
  /** `PUT /api/rbac` (a verified Super admin with a fresh sign-in). */
  set: (enabled: boolean) =>
    request<RbacUpdateResult>('PUT', 'rbac', {
      body: { enabled },
      reauthPurpose: RBAC_REAUTH_PURPOSE,
    }),
};
