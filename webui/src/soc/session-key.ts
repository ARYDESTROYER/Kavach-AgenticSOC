/**
 * The session the console's own status reads belong to (Round 14, closing fix qa1-08).
 *
 * The app-wide providers that read signed-in-only endpoints on mount (the Demo status in
 * `demo.tsx`, the preference cascade in `prefs.tsx`) sit inside `AuthProvider`, so they
 * mount on the sign-in page too. A read sent there is one the server is known to refuse
 * (401), and the browser logs each one as a console error. They read only while this
 * hook returns a key, and start again from their empty value whenever the key changes.
 *
 *   - `null`: no session to read for. GET /api/auth/me has not answered yet, it failed
 *     (the console shows its retry screen), or nobody is signed in.
 *   - a string: the person the reads are for (their username; empty when auth is off).
 *     It changes when another person signs in to this tab, so the next person never sees
 *     the last one's preferences.
 *
 * Outside an `AuthProvider` (a provider rendered on its own) nothing says the tab has
 * no session, so the reads run as they always have; the same holds for any field the
 * auth context leaves unset. Entry-safe: no dependencies beyond the auth context.
 */
import { useAuth, type AuthContextValue } from './auth';

function useAuthIfMounted(): Partial<AuthContextValue> | null {
  try {
    return useAuth();
  } catch {
    // No AuthProvider above this provider: nothing says the tab has no session.
    return null;
  }
}

/** The key of the session this tab may read for, or `null` while it has none. */
export function useSessionKey(): string | null {
  const auth = useAuthIfMounted();
  if (!auth) return '';
  return auth.loading || auth.loadError || auth.isAuthenticated === false ? null : auth.username ?? '';
}
