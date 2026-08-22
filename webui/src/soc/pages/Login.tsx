/**
 * Login — branded sign-in surface for the SOC console, with Wave-1/2 identity flows.
 *
 * Modes, decided from GET /api/setup/status (public) + the login response:
 *   1. FIRST-RUN ("create your admin account") — `needs_user` true (auth on, no
 *      users yet): POST /api/setup/init-admin, then sign in.            (`setup`)
 *   2. NORMAL sign-in — POST /api/auth/login.                           (`signin`)
 *   3. TWO-FACTOR — when the password is correct but MFA is required, exchange the
 *      pending token at /api/auth/mfa/verify.                           (`mfa`)
 *   4. SET-A-NEW-PASSWORD — when `must_change_password`.                (`change`)
 *   5. MANDATED MFA ENROLLMENT — when the login returns
 *      `mfa_enrollment_required` (the account MUST use MFA but has not enrolled):
 *      complete enrollment inside the login via the pending-token-gated
 *      /api/auth/mfa/enroll-setup + /enroll-confirm (confirm mints the session).
 *      There is NO skip — the only exits are finishing enrollment or going back
 *      to sign-in.                                        (`mfa-enroll-required`)
 *
 * The page deliberately stays minimal: one quiet, vertically-centred identity slab in
 * every stored layout, with no marketing hero or decorative command-center chrome.
 * The authentication state machine remains presentation-independent; the visual
 * layer adds stable credential controls, segmented OTP, original SSO marks, and a
 * compact System / Light / Dark chooser without introducing another theme path.
 *
 * When `seeded_default` is true, a subtle hint surfaces the demo Admin / Admin@123
 * credentials. When auth is disabled this component is never mounted, so the
 * no-auth experience is untouched. All branding text is operator-set → rendered as
 * PLAIN text (#9).
 *
 * a11y — WCAG 2.2 §3.3.8 Accessible Authentication (Round-5 W0-E): every credential
 * field carries the correct `autocomplete` for password-manager autofill —
 * `username`, `current-password`, `new-password`, and `one-time-code` for the MFA /
 * recovery-code inputs — and NONE of them block paste (no `onPaste` interception),
 * so a manager can paste secrets and no cognitive-function test is imposed.
 */
import * as React from 'react';
import {
  Shield,
  User,
  AlertCircle,
  ExternalLink,
  Loader2,
  UserPlus,
  KeyRound,
  ShieldCheck,
  IdCard,
  ArrowLeft,
  Monitor,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { LoginResult, SetupStatus, SsoProviderPublic } from '@/lib/types';
import { useTheme } from '@/soc/theme';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@/ui/card';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import {
  asLoginLayout,
  LoginTextInput,
  OtpInput,
  PasswordInput,
  PasswordStrengthMeter,
  SsoBrandIcon,
} from '@/soc/components/auth/loginParts';
import { setupAccount, type LoginBranding } from '@/soc/components/auth/login.api';
import { MfaSetupCard } from '@/soc/components/MfaSetupCard';
import { LoginAuthBackdrop } from '@/soc/components/auth/LoginAuthBackdrop';
import { LoadingState } from '@/design-system';

export interface LoginProps {
  /** Called after a fully-successful login so the app can re-fetch the session. */
  onAuthenticated: () => void;
}

// `setup` is the OOBE create-first-admin flow; `mfa-enroll` is the optional
// prompted MFA step shown AFTER the admin account is created (never forced);
// `mfa-enroll-required` is the MANDATED enrollment step DURING login (no session
// yet — gated by the pending token; cannot be skipped into the console).
type Mode = 'signin' | 'setup' | 'change' | 'mfa' | 'mfa-enroll' | 'mfa-enroll-required';
type LoginThemeMode = 'system' | 'light' | 'dark';
type SigninStep = 'identity' | 'password';

const LOGIN_THEME_OPTIONS: ReadonlyArray<{
  id: LoginThemeMode;
  label: string;
  icon: LucideIcon;
}> = [
  { id: 'system', label: 'Use system theme', icon: Monitor },
  { id: 'light', label: 'Use light theme', icon: Sun },
  { id: 'dark', label: 'Use dark theme', icon: Moon },
];

function LoginThemeControl({
  value,
  onChange,
}: {
  value: LoginThemeMode;
  onChange: (mode: LoginThemeMode) => void;
}) {
  return (
    <div
      data-login-theme-control
      role="group"
      aria-label="Appearance"
      className="inline-flex items-center gap-0.5"
    >
      {LOGIN_THEME_OPTIONS.map(({ id, label, icon: Icon }) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={selected}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-canvas',
              selected ? 'bg-muted text-foreground' : 'hover:bg-muted/70 hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

// The OOBE password policy MIRRORS the server-side gate in routes_setup.py
// (min length + not equal to the username + not a trivially-common password) so the
// button-disable + inline hint match what the backend will accept. This is a UX
// nicety; the server remains authoritative (#9 — never client-trusted).
const OOBE_MIN_PASSWORD_LEN = 12;
const OOBE_COMMON_PASSWORDS = new Set(
  [
    'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
    '123456', '12345678', '123456789', '1234567890', '111111', '000000',
    'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abc12345', 'a1b2c3d4',
    'letmein', 'welcome', 'welcome1', 'welcome123', 'admin', 'admin123',
    'administrator', 'root', 'toor', 'changeme', 'changeme1', 'changeme123',
    'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
    'trustno1', 'master', 'superman', 'starwars', 'whatever', 'secret',
    'default', 'temp1234', 'test1234', 'passw0rd1', 'adminadmin', 'rootroot',
    'soc12345678', 'tlsoc123456', 'admin@123', 'admin12345678',
  ].map((p) => p.toLowerCase()),
);

/** The client mirror of the server strong-password policy — reason string or null. */
function oobePasswordPolicyError(password: string, username: string): string | null {
  const pw = password || '';
  if (pw.length < OOBE_MIN_PASSWORD_LEN) {
    return `Password must be at least ${OOBE_MIN_PASSWORD_LEN} characters.`;
  }
  if (pw.trim().toLowerCase() === (username || '').trim().toLowerCase()) {
    return 'Password must not be the same as the username.';
  }
  if (OOBE_COMMON_PASSWORDS.has(pw.trim().toLowerCase())) {
    return 'That password is too common — choose a less predictable one.';
  }
  return null;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const {
    branding: brandingBase,
    refreshBranding,
    theme,
    setTheme,
  } = useTheme();
  // Read the additive Round-4 login white-label fields structurally (they are not in
  // the shared `Branding` interface yet; see login.api.ts). All are operator-set →
  // rendered as PLAIN text / mapped to CODE-defined layouts (#6/#9).
  const branding = brandingBase as LoginBranding;

  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const tagline = branding.product_name?.trim() || 'Security operations console';
  const logoUrl = branding.logo_data_url?.trim() || '';
  const loginSubtitle = branding.login_subtitle?.trim() || '';
  const footerText = branding.footer_text?.trim() || '';
  const rawSupport = branding.support_url?.trim() || '';
  const supportUrl = /^https?:\/\//i.test(rawSupport) ? rawSupport : '';

  // Login white-label (bounded plain-text copy + curated enum layout/illustration).
  const loginHeadline = branding.login_headline?.trim() || '';
  const loginBody = branding.login_body?.trim() || '';
  const loginChips = Array.isArray(branding.login_chips)
    ? branding.login_chips.map((c) => String(c)).filter((c) => c.trim().length > 0)
    : [];
  const loginLayout = asLoginLayout(branding.login_layout);

  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  // Whether the initial setup-status probe has settled (resolved OR failed). Gates
  // the first paint so a first-run install doesn't flash 'signin' before 'setup'.
  const [statusResolved, setStatusResolved] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>('signin');
  const [signinStep, setSigninStep] = React.useState<SigninStep>('identity');
  const [username, setUsername] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const signinIdentityRef = React.useRef<HTMLInputElement>(null);
  const signinPasswordRef = React.useRef<HTMLInputElement>(null);
  const [themePaletteSettling, setThemePaletteSettling] = React.useState(false);
  const themePaletteFrameRef = React.useRef<number | null>(null);
  const [confirm, setConfirm] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  // A secondary, quieter line under the main error (e.g. the honest client-side
  // failed-attempt count). Kept separate from `error` so the primary line stays the
  // backend/validation message and the count is visually subordinate.
  const [errorDetail, setErrorDetail] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // How many times sign-in has failed IN THIS BROWSER SESSION. This is an honest
  // client-side tally (the backend rate-limiter is per-IP and returns no count), used
  // only to surface "You've tried N times." — never trusted for any security decision.
  const signinAttemptsRef = React.useRef(0);

  // MFA phase 2 (Wave 2): the half-auth pending token + the entered code.
  const [pendingToken, setPendingToken] = React.useState('');
  const [mfaCode, setMfaCode] = React.useState('');
  const [useRecovery, setUseRecovery] = React.useState(false);
  // Disclosure toggle for the "Where can I find my recovery codes?" help text.
  const [showRecoveryHelp, setShowRecoveryHelp] = React.useState(false);

  // SSO providers (Wave 2): the enabled "Sign in with …" buttons.
  const [ssoProviders, setSsoProviders] = React.useState<SsoProviderPublic[]>([]);
  // Whether the SSO-providers probe has settled. Folded into the first-paint gate so
  // the "or continue with" divider + provider buttons never POP IN ~1 RTT after the
  // form paints (which grew/re-centred the card). Fails safe: set on both ok + error.
  const [ssoResolved, setSsoResolved] = React.useState(false);
  const [ssoBusy, setSsoBusy] = React.useState<string | null>(null);

  // Whether the branding probe has settled. Folded into the first-paint gate so the
  // login never paints with stale/default branding then SNAPS to the operator's real
  // login_layout/headline/illustration (a FOUC). Fails safe: set on both ok + error.
  const [brandingResolved, setBrandingResolved] = React.useState(false);

  const changeLoginTheme = React.useCallback((next: LoginThemeMode) => {
    if (themePaletteFrameRef.current !== null) {
      window.cancelAnimationFrame(themePaletteFrameRef.current);
    }
    // The reference tiles deliberately cross-fade between their two neutral shades.
    // Theme changes are different: allowing that same 1.8s transition to interpolate
    // Light white into Dark charcoal creates giant grey flashes around the slab. Keep
    // the motion running, but snap the palette itself over two paint frames.
    setThemePaletteSettling(true);
    setTheme(next);
    themePaletteFrameRef.current = window.requestAnimationFrame(() => {
      themePaletteFrameRef.current = window.requestAnimationFrame(() => {
        themePaletteFrameRef.current = null;
        setThemePaletteSettling(false);
      });
    });
  }, [setTheme]);

  React.useEffect(() => () => {
    if (themePaletteFrameRef.current !== null) {
      window.cancelAnimationFrame(themePaletteFrameRef.current);
    }
  }, []);

  // Detect the first-run OOBE state once on mount.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await api.setup.status();
        if (!alive) return;
        setStatus(s);
        if (s.needs_user) setMode('setup');
      } catch {
        /* fall back to normal sign-in */
      } finally {
        if (alive) setStatusResolved(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Load the enabled SSO providers (best-effort; empty when SSO is off). This runs in
  // PARALLEL with the setup-status probe above (both fire on mount), and both gate the
  // first paint, so painting waits for the slower of the two — no extra serial latency,
  // and the SSO block is present from the first frame instead of popping in late.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await api.auth.sso.providers();
        if (alive) setSsoProviders(res.providers ?? []);
      } catch {
        if (alive) setSsoProviders([]);
      } finally {
        if (alive) setSsoResolved(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Force a fresh GET /api/branding whenever Login mounts (e.g. immediately after a
  // logout, in the SAME SPA session): ThemeProvider (mounted once at the app root)
  // otherwise fetches branding exactly ONCE for the whole session, so a just-saved
  // BrandingEditor edit would never reach the login screen without a hard page reload.
  // Folded into the first-paint gate below (same pattern as the statusResolved /
  // ssoResolved probes) so the operator's branding is never shown stale-then-corrected.
  // Fails safe: the flag flips in `finally`, so an unreachable backend still resolves to
  // whatever branding is already in the shared context.
  React.useEffect(() => {
    let alive = true;
    void refreshBranding().finally(() => {
      if (alive) setBrandingResolved(true);
    });
    return () => {
      alive = false;
    };
  }, [refreshBranding]);

  // Surface an SSO callback error (the backend redirects to /login?sso_error=...).
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const e = params.get('sso_error');
    if (e) {
      setError(`Single sign-on failed: ${e}`);
      // Clean the URL so a refresh doesn't keep showing the error.
      const url = new URL(window.location.href);
      url.searchParams.delete('sso_error');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const startSso = async (providerId: string) => {
    if (ssoBusy) return;
    setSsoBusy(providerId);
    setError(null);
    setErrorDetail(null);
    try {
      const res = await api.auth.sso.authorize(providerId);
      window.location.assign(res.auth_url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start single sign-on.');
      setSsoBusy(null);
    }
  };

  const seededHint = Boolean(status?.seeded_default) && mode === 'signin';

  const continueSignin = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy || username.trim().length === 0) return;
    setError(null);
    setErrorDetail(null);
    setSigninStep('password');
    window.setTimeout(() => signinPasswordRef.current?.focus(), 0);
  };

  // --- Mode 1: first-run create admin (OOBE account-setup) ------------------ //
  // Round-4 Wave-5: the OOBE step now calls POST /api/setup/account (the force-set,
  // strong-password writer that REPLACES init-admin) with a client-mirrored policy
  // gate, then signs the new admin in and — when the server prompts — offers an
  // OPTIONAL (never forced) MFA-enrollment step before continuing.
  const submitSetup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const uname = username.trim();
    const policyErr = oobePasswordPolicyError(password, uname);
    if (policyErr) {
      setError(policyErr);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await setupAccount(uname, password, displayName);
      // The account writer does NOT mint a session — sign the new admin in now.
      await api.auth.login(uname, password);
      if (res.mfa_prompt) {
        // Offer (prompted-optional) two-factor enrollment before entering the console.
        setMode('mfa-enroll');
        setBusy(false);
        return;
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the admin account.');
      setBusy(false);
    }
  };

  // --- Mode 2: normal sign-in ----------------------------------------------- //
  const submitSignin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    try {
      const res: LoginResult = await api.auth.login(username.trim(), password);
      // MANDATED-BUT-UNENROLLED (branch FIRST — the response also carries
      // requires_mfa): the account must use MFA but has no factor yet, so a code
      // challenge is impossible. Walk the user through enrollment IN the login,
      // gated by the same short-lived pending token (still no session).
      if (res.requires_mfa && res.mfa_enrollment_required && res.pending_token) {
        setPendingToken(res.pending_token);
        setMfaCode('');
        setMode('mfa-enroll-required');
        setBusy(false);
        return;
      }
      // Wave 2 (MFA): the password is correct but a second factor is required. The
      // backend returns a short-lived pending token instead of a session.
      if (res.requires_mfa && res.pending_token) {
        setPendingToken(res.pending_token);
        setMfaCode('');
        setUseRecovery(false);
        setMode('mfa');
        setBusy(false);
        return;
      }
      if (res.user?.must_change_password) {
        // Keep the (now-validated) current password; ask for a new one.
        setNewPassword('');
        setConfirm('');
        setMode('change');
        setBusy(false);
        return;
      }
      onAuthenticated();
    } catch (err) {
      signinAttemptsRef.current += 1;
      if (err instanceof ApiError) {
        // A 429 is the per-IP rate limiter; surface the "slow down" message rather
        // than the raw backend detail so the copy matches the throttle behaviour.
        setError(
          err.status === 429
            ? 'Too many attempts. Please try again in a minute.'
            : err.message || `Sign in failed (${err.status}).`,
        );
      } else {
        setError('Could not reach the backend. Please try again.');
      }
      // Honest client-side count of failed attempts this session (see the ref note).
      setErrorDetail(
        signinAttemptsRef.current >= 2
          ? `You've tried ${signinAttemptsRef.current} times.`
          : null,
      );
      setPassword('');
      setBusy(false);
      window.setTimeout(() => signinPasswordRef.current?.focus(), 0);
    }
  };

  // --- Mode (MFA phase 2): exchange the TOTP / recovery code for a session ----- //
  const submitMfa = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res: LoginResult = await api.auth.mfa.verify(pendingToken, mfaCode.trim());
      if (res.user?.must_change_password) {
        // Session minted, but the password is still flagged for change. The verify
        // route set the cookie, so we can change the password with the current one.
        setNewPassword('');
        setConfirm('');
        setMode('change');
        setBusy(false);
        return;
      }
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Verification failed. Please try again.');
      setMfaCode('');
      setBusy(false);
    }
  };

  // --- Mode (mandated MFA enrollment during login) -------------------------- //
  // The enroll-confirm endpoint minted the FULL session and returned the exact
  // /auth/mfa/verify success payload — finish exactly the way submitMfa does
  // (incl. the forced password change, which the fresh cookie lets us perform).
  const completeEnrollLogin = (res: LoginResult) => {
    if (res.user?.must_change_password) {
      setNewPassword('');
      setConfirm('');
      setMode('change');
      return;
    }
    onAuthenticated();
  };

  // The short-lived pending token lapsed mid-enrollment (401). Return to the
  // password step (identity preserved) with a clear, non-alarming explanation —
  // signing in again simply restarts the 5-minute enrollment window.
  const expireEnrollLogin = () => {
    setMode('signin');
    setSigninStep('password');
    setPendingToken('');
    setPassword('');
    setError(
      'Your setup session expired. Sign in again to continue setting up two-factor authentication.',
    );
    setErrorDetail(null);
    window.setTimeout(() => signinPasswordRef.current?.focus(), 0);
  };

  // --- Mode 3: set a new password (forced change) --------------------------- //
  const submitChange = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.changePassword(password, newPassword);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
      setBusy(false);
    }
  };

  const titleByMode: Record<Mode, string> = {
    signin: 'Welcome back',
    setup: 'Create your admin account',
    change: 'Set a new password',
    mfa: 'Two-factor authentication',
    'mfa-enroll': 'Secure your account',
    'mfa-enroll-required': 'Set up two-factor authentication',
  };
  const descByMode: Record<Mode, string> = {
    signin: loginSubtitle || `Sign in to continue to ${wordmark}.`,
    setup:
      'No accounts exist yet. Create the first administrator to get started — pick a strong, unique password.',
    change: 'Your password must be changed before you can continue.',
    mfa: useRecovery
      ? 'Enter one of your single-use recovery codes.'
      : 'Enter the 6-digit code from your authenticator app.',
    'mfa-enroll':
      'Optional but recommended: add a second factor now. You can skip and set it up later.',
    'mfa-enroll-required':
      'Your administrator requires multi-factor authentication for this account. ' +
      'Set up an authenticator app now to finish signing in.',
  };
  const activeTitle =
    mode === 'signin'
      ? loginHeadline || 'Welcome back'
      : titleByMode[mode];
  const activeDescription =
    mode === 'signin' && signinStep === 'password'
      ? `Enter the password for ${username.trim()}.`
      : mode === 'signin' && loginBody
        ? loginBody
        : descByMode[mode];

  // OOBE submit guard — mirror the server policy so the button reflects acceptance.
  const setupPolicyError = React.useMemo(
    () => oobePasswordPolicyError(password, username.trim()),
    [password, username],
  );
  const canSubmitSetup =
    !busy &&
    username.trim().length > 0 &&
    password.length > 0 &&
    confirm.length > 0 &&
    setupPolicyError === null &&
    password === confirm;

  const ssoLabel = (p: SsoProviderPublic): string => {
    if (p.display_name && p.display_name.trim()) return p.display_name.trim();
    if (p.type === 'google') return 'Google';
    if (p.type === 'microsoft') return 'Microsoft';
    return p.id;
  };

  // One quiet identity slab serves every legacy stored layout. Authentication state
  // remains above this presentation boundary; the slab owns only hierarchy and the
  // current mode's controlled form.
  const formInner = (
    <div className="relative isolate my-auto w-full sm:w-[30rem] sm:max-w-[30rem]">
      <LoginAuthBackdrop />
      <div
        className="login-auth-slab relative z-30 flex max-h-[100dvh] min-h-[100dvh] w-full flex-col overflow-y-auto px-8 pb-20 pt-8 sm:min-h-[30.75rem] sm:w-[30rem] sm:px-12 sm:pb-24 sm:pt-12"
        data-login-slab
        data-login-identity-pane
      >
        <div className="relative mx-auto my-auto w-full max-w-sm sm:my-0">
        <div className="mb-5 flex h-14 min-w-0 items-center" aria-label={`${wordmark} — ${tagline}`}>
          <div className="flex h-14 w-14 shrink-0 items-center justify-start">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-14 w-14 object-contain" />
            ) : (
              <Shield className="h-12 w-12 stroke-[1.35] text-primary" aria-hidden />
            )}
          </div>
          <span className="sr-only">{wordmark}. {tagline}.</span>
        </div>

        <Card
          data-login-panel
          data-login-surface="minimal"
          elevation="none"
          className="rounded-none border-0 bg-transparent shadow-none"
        >
            <CardHeader className="space-y-0 px-0 pb-0 pt-0 text-left">
              <h1 className="break-words text-display font-medium text-foreground">
                {activeTitle}
              </h1>
              <CardDescription className="mt-3 max-w-sm break-words text-base leading-5">
                {activeDescription}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0 pt-9">
              {error ? (
                <Alert
                  id={mode === 'signin' ? 'login-error' : undefined}
                  variant="destructive"
                  className="mb-5"
                >
                  <AlertCircle aria-hidden />
                  <AlertDescription>
                    <span className="font-medium">{error}</span>
                    {errorDetail ? (
                      <span className="mt-0.5 block text-xs opacity-80">{errorDetail}</span>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}

              {/* ---- Mode: create first admin (OOBE account-setup) ----------- */}
              {mode === 'setup' ? (
                <form onSubmit={submitSetup} className="space-y-5" noValidate>
                  <div className="space-y-2">
                    <Label htmlFor="setup-username">Admin username</Label>
                    <LoginTextInput
                      id="setup-username"
                      icon={User}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      placeholder="Choose an admin username"
                      disabled={busy}
                      required
                      /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-display">
                      Display name <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <LoginTextInput
                      id="setup-display"
                      icon={IdCard}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      autoComplete="name"
                      placeholder="e.g. Alex Morgan"
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-password">Password</Label>
                    <PasswordInput
                      id="setup-password"
                      value={password}
                      onChange={setPassword}
                      autoComplete="new-password"
                      placeholder="Create a strong password"
                      ariaDescribedBy="setup-password-help"
                      disabled={busy}
                      required
                    />
                    {/* Reserve a fixed-height slot for the strength meter so the FIRST
                        keystroke (meter appears) never shoves the fields/button below
                        it downward (reserve-space; the meter is null until typing). */}
                    <div className="min-h-[1.75rem] pt-0.5">
                      <PasswordStrengthMeter password={password} />
                    </div>
                    {/* Policy hint mirrors the server gate (min 12, ≠ username, not common). */}
                    <p
                      id="setup-password-help"
                      className={cn(
                        'text-xs',
                        password && setupPolicyError ? 'text-critical' : 'text-muted-foreground',
                      )}
                    >
                      {password && setupPolicyError
                        ? setupPolicyError
                        : `Use at least ${OOBE_MIN_PASSWORD_LEN} characters — not your username or a common password.`}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-confirm">Confirm password</Label>
                    <PasswordInput
                      id="setup-confirm"
                      value={confirm}
                      onChange={setConfirm}
                      autoComplete="new-password"
                      placeholder="Repeat your password"
                      disabled={busy}
                      required
                    />
                    {/* Reserved slot: the mismatch line inserts on a typing mismatch —
                        keep its height always so it never shoves the submit button. */}
                    <div className="min-h-[1rem]" aria-live="polite">
                      {confirm && password !== confirm ? (
                        <p className="text-xs text-critical">Passwords do not match.</p>
                      ) : null}
                    </div>
                  </div>
                  <Button type="submit" className="h-12 w-full" disabled={!canSubmitSetup}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : <UserPlus aria-hidden />}
                    {busy ? 'Creating…' : 'Create admin & sign in'}
                  </Button>
                </form>
              ) : null}

              {/* ---- Mode: OPTIONAL MFA enrollment after account creation ---- */}
              {mode === 'mfa-enroll' ? (
                <div className="space-y-4">
                  {/* frameless: the outer login Card already supplies the frame +
                      the "Secure your account" heading — avoid a card-in-card.
                      Reserve the QR area's height so the second grow (when the
                      enrollment QR resolves after mount) is absorbed, not a jump. */}
                  <div className="min-h-[24rem]">
                    <MfaSetupCard enabled={false} frameless onChanged={onAuthenticated} />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={onAuthenticated}
                  >
                    Skip for now &amp; continue
                  </Button>
                </div>
              ) : null}

              {/* ---- Mode: MANDATED MFA enrollment during login -------------- */}
              {mode === 'mfa-enroll-required' ? (
                <div className="space-y-4">
                  {/* frameless (single card grammar) + the pending token reroutes the
                      card's setup/confirm to the PUBLIC enroll endpoints and makes a
                      successful confirm a COMPLETED login. Deliberately NO skip: there
                      is no session yet and the mandate is not optional — the only
                      exits are finishing enrollment or going back to sign-in. The
                      min-h reserve absorbs the QR growth (same as the optional step). */}
                  <div className="min-h-[24rem]">
                    <MfaSetupCard
                      enabled={false}
                      frameless
                      pendingToken={pendingToken}
                      onComplete={completeEnrollLogin}
                      onPendingExpired={expireEnrollLogin}
                    />
                  </div>
                  <div className="text-center">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => {
                        setMode('signin');
                        setSigninStep('identity');
                        setPendingToken('');
                        setPassword('');
                        setError(null);
                        setErrorDetail(null);
                      }}
                    >
                      Back to sign in
                    </Button>
                  </div>
                </div>
              ) : null}

              {/* ---- Mode: normal sign-in ------------------------------------ */}
              {mode === 'signin' ? (
                signinStep === 'identity' ? (
                  <form onSubmit={continueSignin} className="space-y-4" noValidate>
                    <div className="space-y-2">
                      <Label htmlFor="login-username">Username</Label>
                      <LoginTextInput
                        ref={signinIdentityRef}
                        id="login-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        name="username"
                        placeholder="Enter your username"
                        disabled={busy}
                        required
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                        autoFocus
                      />
                    </div>
                    {username.trim().length > 0 ? (
                      <Button
                        type="submit"
                        className="ml-auto flex h-10 bg-foreground px-5 text-background hover:bg-foreground/90 active:bg-foreground/85"
                        disabled={busy}
                      >
                        Continue
                      </Button>
                    ) : null}
                  </form>
                ) : (
                  <form onSubmit={submitSignin} className="space-y-4" noValidate>
                    <div className="flex min-h-8 items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-foreground">{username.trim()}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 px-2 text-xs text-muted-foreground"
                        onClick={() => {
                          setSigninStep('identity');
                          setPassword('');
                          setError(null);
                          setErrorDetail(null);
                          window.setTimeout(() => signinIdentityRef.current?.focus(), 0);
                        }}
                        disabled={busy}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                        Back
                      </Button>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="login-password">Password</Label>
                      <PasswordInput
                        ref={signinPasswordRef}
                        id="login-password"
                        value={password}
                        onChange={setPassword}
                        autoComplete="current-password"
                        name="password"
                        placeholder="Enter your password"
                        ariaDescribedBy={error ? 'login-error' : undefined}
                        ariaInvalid={Boolean(error)}
                        disabled={busy}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      className="ml-auto flex h-10 bg-foreground px-5 text-background hover:bg-foreground/90 active:bg-foreground/85"
                      disabled={busy || password.length === 0}
                    >
                      {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                  </form>
                )
              ) : null}

              {/* The reference keeps identity providers below the credential path.
                  Providers stay explicitly named for assistive technology while the
                  visual controls remain compact and icon-led. */}
              {mode === 'signin' && signinStep === 'identity' && ssoProviders.length > 0 ? (
                <div
                  className="mt-6 grid gap-2"
                  style={{ gridTemplateColumns: `repeat(${Math.min(ssoProviders.length, 3)}, minmax(0, 1fr))` }}
                  aria-label="Single sign-on"
                >
                  {ssoProviders.map((p) => {
                    const label = ssoLabel(p);
                    return (
                      <Button
                        key={p.id}
                        type="button"
                        variant="secondary"
                        className="press-scale h-10 min-w-0 px-3"
                        aria-label={`Sign in with ${label}`}
                        title={`Sign in with ${label}`}
                        onClick={() => void startSso(p.id)}
                        disabled={Boolean(ssoBusy)}
                      >
                        {ssoBusy === p.id ? (
                          <Loader2 className="animate-spin" aria-hidden />
                        ) : (
                          <SsoBrandIcon type={p.type} className="h-5 w-5" />
                        )}
                        <span className="sr-only">Sign in with {label}</span>
                      </Button>
                    );
                  })}
                </div>
              ) : null}

              {seededHint && signinStep === 'identity' ? (
                <div
                  data-login-demo-hint
                  className="mt-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-muted-foreground"
                >
                  <p className="min-w-0 break-words">
                    <span className="font-medium text-foreground">Demo credentials</span>
                    <span aria-hidden> · </span>
                    <span className="font-mono text-foreground">Admin</span>
                    <span aria-hidden> / </span>
                    <span className="font-mono text-foreground">Admin@123</span>
                    <span className="sr-only">Username Admin. Password Admin at 123.</span>
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Use demo credentials"
                    className="h-8 shrink-0 px-2 text-xs"
                    onClick={() => {
                      setUsername('Admin');
                      setPassword('Admin@123');
                      setError(null);
                      setErrorDetail(null);
                      setSigninStep('password');
                      window.setTimeout(() => signinPasswordRef.current?.focus(), 0);
                    }}
                    disabled={busy}
                  >
                    Use
                  </Button>
                </div>
              ) : null}

              {/* ---- Mode: MFA second factor (TOTP / recovery) --------------- */}
              {mode === 'mfa' ? (
                <form onSubmit={submitMfa} className="space-y-5" noValidate>
                  <div className="space-y-2">
                    {/* htmlFor only in the recovery branch (id="mfa-code" is the text
                        Input there). In the OTP branch the control is the segmented
                        OtpInput group, which carries its own aria-label — a htmlFor
                        pointing at a non-existent id would be a dead association. */}
                    <Label htmlFor={useRecovery ? 'mfa-code' : undefined}>
                      {useRecovery ? 'Recovery code' : 'Authentication code'}
                    </Label>
                    {useRecovery ? (
                      <>
                        <LoginTextInput
                          id="mfa-code"
                          icon={ShieldCheck}
                          className="font-mono tracking-wider"
                          inputMode="text"
                          autoComplete="one-time-code"
                          placeholder="XXXX-XXXX"
                          value={mfaCode}
                          onChange={(e) => setMfaCode(e.target.value)}
                          disabled={busy}
                          /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                          autoFocus
                        />
                        <div className="text-xs">
                          <button
                            type="button"
                            onClick={() => setShowRecoveryHelp((v) => !v)}
                            aria-expanded={showRecoveryHelp}
                            className="rounded-sm font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            Where can I find my recovery codes?
                          </button>
                          {showRecoveryHelp ? (
                            <p className="mt-1.5 rounded-md bg-muted/50 p-2 leading-relaxed text-muted-foreground">
                              Recovery codes were shown when you enabled two-factor authentication.
                              Each code works once. If you&apos;ve used or lost them all, ask an
                              administrator to reset your two-factor setup.
                            </p>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <OtpInput
                        value={mfaCode}
                        onChange={setMfaCode}
                        disabled={busy}
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                        autoFocus
                        aria-label="Authentication code"
                      />
                    )}
                  </div>
                  <Button type="submit" className="h-12 w-full" disabled={busy || mfaCode.trim().length === 0}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
                    {busy ? 'Verifying…' : 'Verify & continue'}
                  </Button>
                  <div className="flex items-center justify-between text-xs">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => {
                        setUseRecovery((v) => !v);
                        setMfaCode('');
                        setError(null);
                        setErrorDetail(null);
                        setShowRecoveryHelp(false);
                      }}
                      disabled={busy}
                    >
                      {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => {
                        setMode('signin');
                        setSigninStep('identity');
                        setMfaCode('');
                        setPendingToken('');
                        setPassword('');
                        setError(null);
                        setErrorDetail(null);
                        setShowRecoveryHelp(false);
                      }}
                      disabled={busy}
                    >
                      Back to sign in
                    </Button>
                  </div>
                </form>
              ) : null}

              {/* ---- Mode: forced password change ---------------------------- */}
              {mode === 'change' ? (
                <form onSubmit={submitChange} className="space-y-5" noValidate>
                  <div className="space-y-2">
                    <Label htmlFor="change-new">New password</Label>
                    <PasswordInput
                      id="change-new"
                      value={newPassword}
                      onChange={setNewPassword}
                      autoComplete="new-password"
                      placeholder="Create a new password"
                      disabled={busy}
                      required
                      /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of the forced password-change step; behavior-preserving */
                      autoFocus
                    />
                    {/* Reserved slot — same reserve-space treatment as the setup form. */}
                    <div className="min-h-[1.75rem] pt-0.5">
                      <PasswordStrengthMeter password={newPassword} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="change-confirm">Confirm new password</Label>
                    <PasswordInput
                      id="change-confirm"
                      value={confirm}
                      onChange={setConfirm}
                      autoComplete="new-password"
                      placeholder="Repeat your new password"
                      disabled={busy}
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    className="h-12 w-full"
                    disabled={busy || newPassword.length === 0 || confirm.length === 0}
                  >
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
                    {busy ? 'Updating…' : 'Set password & continue'}
                  </Button>
                </form>
              ) : null}
            </CardContent>
          </Card>

        {supportUrl || (mode === 'signin' && loginChips.length > 0) || footerText ? (
          <div className="mt-8 space-y-1.5 text-center text-xs leading-5 text-muted-foreground">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              {supportUrl ? (
                <a
                  href={supportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'inline-flex min-h-8 items-center gap-1 rounded-sm text-muted-foreground',
                    'transition-colors focus-visible:outline-none hover:text-foreground',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                  )}
                >
                  Help &amp; support
                  <span className="sr-only"> (opens in a new tab)</span>
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ) : null}
              {mode === 'signin'
                ? loginChips.map((chip, index) => (
                    <React.Fragment key={`${chip}-${index}`}>
                      {supportUrl || index > 0 ? <span aria-hidden>·</span> : null}
                      <span className="break-words">{chip}</span>
                    </React.Fragment>
                  ))
                : null}
            </div>
            {footerText ? <p className="break-words">{footerText}</p> : null}
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );

  // Hold first paint until the setup-status probe, the SSO-providers probe, AND the
  // branding probe settle, so a first-run install never flashes the sign-in form before
  // switching to the create-admin form, the SSO block never pops in a beat after the
  // form, and the login never paints with stale/default branding then snaps to the
  // operator's real login_layout/headline/illustration. All three probes fire on mount
  // in parallel, so this waits for the slowest one, not their sum. Each fails safe (its
  // flag flips on error too), so an unreachable backend still resolves to the fallback.
  if (!statusResolved || !ssoResolved || !brandingResolved) {
    return (
      <main className="login-auth-canvas min-h-[100dvh] px-5">
        <LoadingState
          label="Loading sign-in"
          layout="page"
          shape="page"
          className="min-h-[100dvh]"
        />
      </main>
    );
  }

  // Legacy split / centered / full preferences remain readable and round-trip through
  // Branding, but intentionally converge on one minimal surface. Keeping one geometry
  // avoids separate branded experiences and makes every auth mode predictable.
  return (
    <main
      data-login-layout={loginLayout}
      data-login-shell="minimal"
      data-login-theme-palette-settling={themePaletteSettling ? 'true' : 'false'}
      className="login-auth-canvas relative min-h-[100dvh] overflow-x-hidden"
    >
      <div className="absolute right-4 top-4 z-40 sm:right-6 sm:top-6">
        <LoginThemeControl value={theme} onChange={changeLoginTheme} />
      </div>
      <section className="relative flex min-h-[100dvh] items-center justify-center px-0 py-0 sm:px-8 sm:py-12">
        {formInner}
      </section>
    </main>
  );
}
