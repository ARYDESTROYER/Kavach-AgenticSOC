/**
 * Auth + RBAC React context for the SOC console (Wave 1).
 *
 * Loads GET /api/auth/me (session + role) and GET /api/roles (the permission
 * matrix) once on mount, and exposes a `hasPermission(resource, action)` helper the
 * whole app uses to gate nav, routes and actions.
 *
 * Back-compat is preserved end-to-end:
 *   - auth DISABLED                → `authEnabled=false`, hasPermission() === true.
 *   - auth ON but RBAC disabled    → backend reports the role as `super_admin`, so
 *                                    the matrix grants everything (and we also short-
 *                                    circuit `rbacEnabled=false` → allow).
 *   - auth ON + RBAC ON            → hasPermission consults the matrix for the role.
 *
 * The provider also owns the login/logout transitions so App.tsx can stay thin.
 */
import * as React from 'react';
import { api, setUnauthorizedHandler } from '@/lib/api';
import type { AuthMe, RolesResponse, SessionEndReason, UserRole } from '@/lib/types';

// Remember-me device helpers live in a lazy chunk (this provider is first-paint code).
const loadRememberDevice = () => import('@/soc/components/auth/rememberMe');

/**
 * Why the previous session ended, as reported by the registry-aware
 * GET /api/auth/me (Round 12). The sign-in page turns it into a calm notice.
 */
export interface SessionEnded {
  reason: SessionEndReason;
  /** The limit that ended it, in seconds, when known. */
  lifetimeSeconds?: number;
  /** Whether the ended session had been remembered. */
  remembered?: boolean;
}

export interface AuthContextValue {
  /** Whether the backend has auth enforcement turned on. */
  authEnabled: boolean;
  /** Whether RBAC is enforced (false → every authenticated user is super_admin). */
  rbacEnabled: boolean;
  /** True when allowed to use the console (auth off, or a valid session). */
  isAuthenticated: boolean;
  /** The signed-in username (or null when auth is off / unauthenticated). */
  username: string | null;
  /** The signed-in user's role (or null). */
  role: UserRole | string | null;
  /** Whether the current user must change their password before continuing. */
  mustChangePassword: boolean;
  /** The role → resource → [actions] matrix from GET /api/roles (when available). */
  matrix: Record<string, Record<string, string[]>>;
  /** Whether the initial auth/roles load is still in flight. */
  loading: boolean;
  /**
   * True when the LAST GET /api/auth/me call FAILED (network / 5xx), as opposed to a
   * clean "auth disabled" 200. Distinguishes "could not reach the backend" from
   * "auth is off" so the shell doesn't fail OPEN into a broken console. Cleared on a
   * successful `refresh()`.
   */
  loadError: boolean;
  /**
   * Set when the server reported that the last session ended (revoked, idle,
   * absolute, signed out everywhere). Null while signed in or after a deliberate
   * sign-out. Optional so older test doubles of this context stay valid.
   */
  sessionEnded?: SessionEnded | null;
  /** Re-fetch /api/auth/me (+ /api/roles); call after login / password change. */
  refresh: () => Promise<AuthMe | null>;
  /** Log out (best-effort) and reset the session to unauthenticated. */
  logout: () => Promise<void>;
  /**
   * Whether the current principal may perform `action` on `resource`.
   * Returns true when auth is off OR rbac is genuinely off (back-compat). When rbac
   * is on it consults the loaded matrix for the user's role (deny-by-default if
   * unknown). If GET /api/roles FAILED to load for an authenticated principal it is
   * deny-by-default (super_admin excepted) — never allow-all — so a transient fetch
   * failure can't surface admin controls to a low-privilege user.
   */
  hasPermission: (resource: string, action: string) => boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

const EMPTY_MATRIX: Record<string, Record<string, string[]>> = {};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [me, setMe] = React.useState<AuthMe | null>(null);
  const [matrix, setMatrix] = React.useState<Record<string, Record<string, string[]>>>(EMPTY_MATRIX);
  const [rbacEnabled, setRbacEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  // GET /api/auth/me could not be reached (network / 5xx) — NOT the clean auth-off 200.
  const [loadError, setLoadError] = React.useState(false);
  // GET /api/roles failed for an authenticated principal — force deny-by-default in
  // hasPermission (rather than the allow-all that `rbacEnabled=false` means when RBAC
  // is genuinely off).
  const [rolesError, setRolesError] = React.useState(false);

  const refresh = React.useCallback(async (): Promise<AuthMe | null> => {
    let next: AuthMe | null = null;
    let meFailed = false;
    try {
      next = await api.auth.me();
    } catch {
      next = null;
      meFailed = true;
    }
    // The server reports why a session ended ONCE (it clears the cookie at the same
    // time), and other 401s can trigger more /auth/me calls right after. Keep that
    // reason until someone signs in again or signs out on purpose.
    setMe((prev) =>
      next && !next.authenticated && !next.reason && prev?.reason && !prev.authenticated
        ? { ...next, reason: prev.reason, lifetime_seconds: prev.lifetime_seconds, remembered: prev.remembered }
        : next,
    );
    setLoadError(meFailed);
    // Only fetch the matrix when there is an authenticated principal (the /roles
    // route requires a session). When auth is off, allow-all makes it unnecessary.
    if (next && next.authenticated && next.auth_enabled) {
      try {
        const roles: RolesResponse = await api.roles.get();
        setMatrix(roles.matrix ?? EMPTY_MATRIX);
        setRbacEnabled(Boolean(roles.rbac_enabled));
        setRolesError(false);
      } catch {
        setMatrix(EMPTY_MATRIX);
        setRbacEnabled(false);
        setRolesError(true);
      }
    } else {
      setMatrix(EMPTY_MATRIX);
      setRbacEnabled(false);
      setRolesError(false);
    }
    return next;
  }, []);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      await refresh();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // A single sign-on round trip lands back on the console; when the server could
  // not remember that sign-in it says why in a closed-vocabulary query parameter.
  // Explain it once, then remove it from the address bar.
  React.useEffect(() => {
    if (window.location.search.includes('remember_refused=')) {
      void loadRememberDevice().then((m) => m.explainRememberRefusedParam(), () => undefined);
    }
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* drop to unauthenticated regardless */
    }
    // A deliberate sign-out is not an expiry: the sign-in page must not later say
    // "you were signed out after 24 hours".
    void loadRememberDevice().then((m) => m.clearRememberedSessionEnd(), () => undefined);
    setMe((prev) => (prev ? { auth_enabled: prev.auth_enabled, authenticated: false, user: null } : prev));
    setMatrix(EMPTY_MATRIX);
    setRbacEnabled(false);
    setRolesError(false);
  }, []);

  const authEnabled = Boolean(me?.auth_enabled);
  const isAuthenticated = !authEnabled || Boolean(me?.authenticated);
  const endedReason = authEnabled && !me?.authenticated ? me?.reason : undefined;
  const sessionEnded = React.useMemo<SessionEnded | null>(
    () =>
      endedReason
        ? { reason: endedReason, lifetimeSeconds: me?.lifetime_seconds, remembered: me?.remembered }
        : null,
    [endedReason, me?.lifetime_seconds, me?.remembered],
  );
  const role = me?.user?.role ?? null;
  const username = me?.user?.username ?? null;
  const mustChangePassword = Boolean(me?.user?.must_change_password);

  const hasPermission = React.useCallback(
    (resource: string, action: string): boolean => {
      // Auth off → everything allowed (mirrors the backend gate).
      if (!authEnabled) return true;
      // super_admin always has every grant (it also holds everything backend-side).
      if (role === 'super_admin') return true;
      // /roles failed to load → deny-by-default (never allow-all on an error), so a
      // transient fetch failure can't surface admin controls to a lesser role.
      if (rolesError) return false;
      // rbac GENUINELY off (a clean /roles response) → allow-all (back-compat).
      if (!rbacEnabled) return true;
      if (!role) return false;
      const actions = matrix[role]?.[resource];
      if (!actions) return false;
      return actions.includes('*') || actions.includes(action);
    },
    [authEnabled, rbacEnabled, rolesError, role, matrix],
  );

  const value = React.useMemo<AuthContextValue>(
    () => ({
      authEnabled,
      rbacEnabled,
      isAuthenticated,
      username,
      role,
      mustChangePassword,
      matrix,
      loading,
      loadError,
      sessionEnded,
      refresh,
      logout,
      hasPermission,
    }),
    [
      authEnabled,
      rbacEnabled,
      isAuthenticated,
      username,
      role,
      mustChangePassword,
      matrix,
      loading,
      loadError,
      sessionEnded,
      refresh,
      logout,
      hasPermission,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/** Access the auth/RBAC context. Throws if used outside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>');
  return ctx;
}

/**
 * The auth context when one is mounted, else null. For surfaces (the sign-in page)
 * that also render standalone in tests and must not throw without a provider.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return React.useContext(AuthContext);
}

/** Register / clear the global 401 handler so a lapsed session bounces to login. */
export function useUnauthorizedRedirect(onUnauthorized: () => void, active: boolean): void {
  React.useEffect(() => {
    if (!active) {
      setUnauthorizedHandler(null);
      return undefined;
    }
    setUnauthorizedHandler(onUnauthorized);
    return () => setUnauthorizedHandler(null);
  }, [onUnauthorized, active]);
}
