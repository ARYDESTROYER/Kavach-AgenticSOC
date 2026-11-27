/**
 * RBAC visibility helpers for the SOC console (Wave 1).
 *
 * `<Can resource action>` renders its children ONLY when the current principal has
 * the `resource:action` grant; otherwise it renders the optional `fallback`
 * (default: nothing). `ProtectedRoute` gates a whole page, rendering the
 * `<Unauthorized>` view when the grant is missing. Both ask `hasPermission`, which
 * reads the effective grants the AuthProvider loads from the server (the base role
 * together with every assigned custom role), so they show what the API allows.
 *
 * Back-compat: when auth or RBAC is disabled, `hasPermission` returns true, so these
 * are transparent (everything renders) — the no-auth experience is unchanged.
 */
import * as React from 'react';
import { ShieldX } from 'lucide-react';
import { useAuth } from '@/soc/auth';
import { EmptyState } from './EmptyState';

export interface CanProps {
  resource: string;
  action: string;
  /** Rendered when the grant is MISSING (default: nothing). */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/** Render `children` only when the current user has `resource:action`. */
export function Can({ resource, action, fallback = null, children }: CanProps) {
  const { hasPermission } = useAuth();
  return <>{hasPermission(resource, action) ? children : fallback}</>;
}

/** Imperative variant for non-JSX branching. */
export function useCan(resource: string, action: string): boolean {
  return useAuth().hasPermission(resource, action);
}

export interface UnauthorizedProps {
  /** Optional message override (plain text). */
  message?: string;
}

/** Full-page "you don't have access" fallback. */
export function Unauthorized({ message }: UnauthorizedProps) {
  return (
    <div className="py-16">
      <EmptyState
        icon={ShieldX}
        title="Access restricted"
        description={
          message ??
          'You do not have permission to view this area. Contact a SOC administrator if you believe this is a mistake.'
        }
      />
    </div>
  );
}

export interface ProtectedRouteProps {
  resource: string;
  action: string;
  children: React.ReactNode;
  /** Optional custom fallback; defaults to the <Unauthorized> view. */
  fallback?: React.ReactNode;
}

/** Page-level guard: render `children` only when the grant is held. */
export function ProtectedRoute({ resource, action, children, fallback }: ProtectedRouteProps) {
  const { hasPermission } = useAuth();
  if (hasPermission(resource, action)) return <>{children}</>;
  return <>{fallback ?? <Unauthorized />}</>;
}

export default Can;
