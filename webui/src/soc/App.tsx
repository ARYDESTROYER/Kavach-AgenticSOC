/**
 * Root of the rebuilt (Tailwind + shadcn) SOC console.
 *
 * Boot mirrors the legacy flow: GET /api/auth/me (auth disabled => no-op gate),
 * then GET /api/setup/status (first-run => Wizard), else the app shell. Dark/light
 * is owned by ThemeProvider; routing by the hash RouterProvider.
 *
 * Round-5 Coupling-A — the per-page lazy table + the hand-maintained `renderPage`
 * switch that used to live HERE now live in `soc/registry.ts` as the single
 * `FEATURES[]`-derived `ROUTES` table (one place a page id maps to its lazy chunk +
 * its config-prop wiring). App only calls `renderRoute(page, ctx)`. Pages no longer
 * receive an `onNavigate` prop — they resolve navigation via `useNavigate()` /
 * `useNavigateOptional()` from the router context (no prop-drilling).
 */
import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { LoadingState } from '@/design-system/loading';
import { Button } from '@/ui/button';
import { TooltipProvider } from '@/ui/tooltip';
import { ThemeProvider } from './theme';
import { PrefsProvider } from './prefs';
import { AuthProvider, useAuth, useUnauthorizedRedirect } from './auth';
import { DemoProvider } from './demo';
import { RouterProvider, useRoute } from './router';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import { renderRoute } from './registry';
import { navLabel } from './nav';

// Login + the first-run Wizard stay EAGER — they own first paint (the login gate
// and the OOBE flow), so we don't want a chunk fetch in front of them. Neither pulls
// framer-motion (the login hero is pure CSS) — see bundle-first-paint.test.ts.
import Login from './pages/Login';
import Wizard from './pages/Wizard';
import { ReauthDialog } from './components/ReauthDialog';
import { ConfirmProvider } from './components/ConfirmDialog';
import { PageSkeleton } from './components/PageSkeleton';

// The boot and sign-in hand-off spinner. It fades in only after 300ms
// (`login-delayed-reveal`, theme.css), so a fast load goes from the sign-in page to the
// shell without a spinner flash; it sits on the same canvas as both, so no colour jumps.
const CenterSpinner: React.FC<{ label: string }> = ({ label }) => (
  <LoadingState
    label={label}
    description="Preparing your secure workspace."
    layout="page"
    className="login-delayed-reveal min-h-dvh bg-canvas"
  />
);

/**
 * Full-screen "couldn't reach the backend" gate shown when the initial GET
 * /api/auth/me FAILED (network / 5xx). Without this the shell would fail OPEN
 * (a failed load collapses to authEnabled=false → isAuthenticated=true) and strand
 * the user in a half-broken console with no way back to login. Retry re-runs refresh().
 */
const BootError: React.FC<{
  onRetry: () => void;
  title?: string;
  description?: string;
}> = ({
  onRetry,
  title = 'Can\'t reach the backend',
  description =
    'The console couldn\'t load your session. Check your connection or that the service is running, then try again.',
}) => (
  <div
    className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center"
    role="alert"
  >
    <AlertTriangle className="h-8 w-8 text-critical-text" aria-hidden />
    <div className="space-y-1">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
    <Button variant="outline" onClick={onRetry}>
      <RefreshCw aria-hidden />
      Retry
    </Button>
  </div>
);

const Boot: React.FC = () => {
  const {
    authEnabled,
    isAuthenticated,
    mustChangePassword,
    loadError,
    username,
    loading: authLoading,
    refresh,
    logout,
  } = useAuth();
  const [setupChecked, setSetupChecked] = React.useState(false);
  const [setupComplete, setSetupComplete] = React.useState(true);
  const [setupError, setSetupError] = React.useState<unknown>(null);
  const [forceWizard, setForceWizard] = React.useState(false);
  // More than one setup probe can legitimately overlap (the post-auth callback and
  // the auth-state effect both re-check the gate). Only the newest request is allowed
  // to publish state; otherwise a slow stale failure can replace a newer successful
  // result with the fail-closed error screen.
  const setupRequestGeneration = React.useRef(0);
  const { page, opts, navigate } = useRoute();

  // Whether the gate currently shows the login screen: auth on + (no session OR a
  // forced-password-change that a mid-flow reload / deep-link must not escape). The
  // backend mints the session cookie before the change screen, so without the
  // mustChangePassword clause a reload would drop the user into the console with the
  // mandatory rotation skipped; Login re-resolves to its `change` mode after re-auth.
  const showLogin = authEnabled && (!isAuthenticated || mustChangePassword);

  const checkSetup = React.useCallback(async () => {
    const generation = ++setupRequestGeneration.current;
    setSetupChecked(false);
    setSetupError(null);
    try {
      const st = await api.setupStatus();
      if (generation !== setupRequestGeneration.current) return;
      setSetupComplete(st.setup_complete);
      setSetupError(null);
    } catch (error) {
      if (generation !== setupRequestGeneration.current) return;
      // Setup state is a boot boundary: an unknown state must never fail open into
      // the Console. Keep the shell closed and give the operator an explicit retry.
      setSetupError(error);
    } finally {
      if (generation === setupRequestGeneration.current) setSetupChecked(true);
    }
  }, []);

  // Once we have a session (or auth is off), check whether the wizard is needed.
  React.useEffect(() => {
    if (authLoading || showLogin) return;
    void checkSetup();
  }, [authLoading, showLogin, checkSetup]);

  // A 401 on any non-auth call bounces back to the login screen (auth on only).
  useUnauthorizedRedirect(
    React.useCallback(() => {
      void refresh();
    }, [refresh]),
    authEnabled,
  );

  const onAuthenticated = React.useCallback(async () => {
    setSetupChecked(false);
    await refresh();
    await checkSetup();
  }, [refresh, checkSetup]);

  const onLogout = React.useCallback(async () => {
    await logout();
    navigate('overview');
  }, [logout, navigate]);

  const onRerunWizard = React.useCallback(() => setForceWizard(true), []);

  if (authLoading) return <CenterSpinner label="Starting console…" />;
  // A failed /api/auth/me must NOT collapse to "auth disabled" and render the console;
  // offer a retry instead (auth on/off is indistinguishable from a load failure once
  // `me` is null, so we key off the explicit loadError flag).
  if (loadError) return <BootError onRetry={() => void refresh()} />;
  if (showLogin) return <Login onAuthenticated={onAuthenticated} />;
  if (!setupChecked) return <CenterSpinner label="Starting console…" />;
  if (setupError) {
    return (
      <BootError
        title="Can’t verify setup state"
        description="The console couldn’t determine whether first-run setup is complete. Retry before opening the workspace."
        onRetry={() => void checkSetup()}
      />
    );
  }

  if (!setupComplete || forceWizard) {
    return (
      <Wizard
        onComplete={() => {
          setForceWizard(false);
          setSetupComplete(true);
          navigate('overview');
        }}
        onExit={forceWizard ? () => setForceWizard(false) : undefined}
      />
    );
  }

  const showUser = Boolean(authEnabled && isAuthenticated && username);
  return (
    <>
      <AppShell
        page={page}
        onNavigate={navigate}
        username={showUser ? username : undefined}
        onLogout={showUser ? onLogout : undefined}
      >
        <ErrorBoundary resetKey={page}>
          {/* Single Suspense boundary covers every lazily-loaded page chunk; the
              fallback mirrors the page chrome so navigation never white-screens.
              Keyed by `page` so each route shows its own fresh fallback. The route
              table (soc/registry.ts) maps the id → lazy chunk + config props. */}
          <React.Suspense key={page} fallback={<PageSkeleton label={navLabel(page)} />}>
            {renderRoute(page, { opts, onRerunWizard })}
          </React.Suspense>
        </ErrorBoundary>
      </AppShell>
      {/* Step-up re-auth modal: only armed when auth is enabled (back-compat). */}
      <ReauthDialog active={authEnabled} />
    </>
  );
};

export const App: React.FC = () => (
  // Reduced-motion is honoured GLOBALLY without pulling framer-motion onto first
  // paint: the `@media (prefers-reduced-motion: reduce)` block in styles/theme.css
  // (W0-A) neutralises CSS/transition/animation motion, and the
  // usePrefersReducedMotion hook (W0-B2) lets any component opt out imperatively.
  // No eager <MotionConfig> here — that statically imported framer-motion into the
  // entry chunk (see soc/__tests__/bundle-first-paint.test.ts, the "Login eager +
  // framer-motion-free first paint" invariant). Any component that needs framer
  // motion must lazy-load it, never the entry.
  <ThemeProvider>
    <TooltipProvider delayDuration={200}>
      <ConfirmProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Boot />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </ConfirmProvider>
    </TooltipProvider>
  </ThemeProvider>
);

export default App;
