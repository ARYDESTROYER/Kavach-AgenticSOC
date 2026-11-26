/**
 * Login: the sign-in page for the SOC console, with every identity flow.
 *
 * Modes, decided from GET /api/setup/status (public) + the login response:
 *   1. FIRST-RUN ("create your admin account"): `needs_user` true (auth on, no
 *      users yet): POST /api/setup/account, then sign in.            (`setup`)
 *   2. NORMAL sign-in: POST /api/auth/login.                          (`signin`)
 *   3. TWO-FACTOR: when the password is correct but MFA is required, exchange the
 *      pending token at /api/auth/mfa/verify.                           (`mfa`)
 *   4. SET-A-NEW-PASSWORD: when `must_change_password`.                (`change`)
 *   5. MANDATED MFA ENROLLMENT: when the login returns
 *      `mfa_enrollment_required` (the account MUST use MFA but has not enrolled):
 *      complete enrollment inside the login via the pending-token-gated
 *      /api/auth/mfa/enroll-setup + /enroll-confirm (confirm mints the session).
 *      There is NO skip: the only exits are finishing enrollment or going back
 *      to sign-in.                                        (`mfa-enroll-required`)
 *
 * Presentation (Round 16 WP04, ui-standard "Identity surfaces"): one quiet column on
 * the Console's own tokens (`bg-canvas`, `--input`, `--primary`), a static brand wash
 * that follows the organization accent, the ordinary primary Button, and one short CSS
 * entrance plus a step transition (theme.css, `transform` and `opacity` only, reduced
 * motion safe). Nothing moves after the page settles: no timers, no ambient motion.
 * The authentication state machine is unchanged and presentation independent.
 *
 * When `seeded_default` is true, a subtle hint surfaces the demo Admin / Admin@123
 * credentials. When auth is disabled this component is never mounted, so the
 * no-auth experience is untouched. All branding text is operator-set and rendered as
 * PLAIN text (#9). Nothing from the query string is ever rendered: a single sign-on
 * callback error is a code mapped to a fixed sentence (`ssoErrors.ts`, B25). A refused
 * request shows a fixed sentence too (`failText`), never the server's own text.
 *
 * a11y: WCAG 2.2 §3.3.8 Accessible Authentication (Round-5 W0-E): every credential
 * field carries the correct `autocomplete` for password-manager autofill
 * (`username`, `current-password`, `new-password`, and `one-time-code` for the MFA /
 * recovery-code inputs) and NONE of them block paste (no `onPaste` interception),
 * so a manager can paste secrets and no cognitive-function test is imposed.
 *
 * Remember me (Round 12, SPEC D14; Round 16 D6): a checkbox row in the password step
 * (and in the identity step when single sign-on is offered) asks the server for a
 * persistent, server-bounded session. The row says only "Remember me"; the warning
 * dialog the first check opens states the limits. After a successful remembered
 * sign-in this device keeps the USERNAME (never the password: that is the browser
 * password manager's job, helped by a hidden `autocomplete="username"` field in the
 * password form and, in Chromium, `PasswordCredential`). A session that ended on its
 * own is explained with a calm notice. The controls live in a LAZY chunk
 * (`RememberMeControls`) loaded in parallel with the startup probes, so this
 * first-paint page stays lean. The two-factor setup card is a lazy chunk as well,
 * loaded only when a sign-in or the first admin reaches an enrollment step.
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
import { effectiveBrandingTheme, type BrandingLike } from '@/soc/theme-tokens';
import { useOptionalAuth } from '@/soc/auth';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Alert, AlertDescription } from '@/ui/alert';
import {
  asLoginLayout,
  FieldError,
  LOGIN_ERROR_ID as ERROR_ID,
  LoginTextInput,
  OtpInput,
  PasswordInput,
  PasswordStrengthMeter,
  SsoBrandIcon,
} from '@/soc/components/auth/loginParts';
import { setupAccount, type LoginBranding } from '@/soc/components/auth/login.api';
import { LoadingGlyph } from '@/design-system/loading';
import { retryingLoader } from '@/soc/lazy-retry';

// Remember me (Round 12): one lazy chunk for the controls and the device helpers.
const loadRememberControls = () => import('@/soc/components/auth/RememberMeControls');
const loadRememberDevice = () => import('@/soc/components/auth/rememberMe');
// The single sign-on error sentences (B25): a small lazy chunk, loaded only for a
// callback error. The fallback is `SSO_ERROR_FALLBACK` in that module, repeated here
// for a chunk that fails to load (login.sso-errors.test.tsx keeps the two equal). It is
// also the sentence for a provider button whose start request failed.
const loadSsoErrors = () => import('@/soc/components/auth/ssoErrors');
const SSO_ERROR_FALLBACK = 'Single sign-on failed. Try again.';
type RememberUi = Awaited<ReturnType<typeof loadRememberControls>>;
// Two-factor setup: its own chunk, since nearly every sign-in never enrolls. A step that
// enrolls loads it while its button shows busy, so the card never pops in; a chunk that
// cannot load leaves a reload line in its place.
const loadMfaSetup = retryingLoader(() => import('@/soc/components/MfaSetupCard'));
type MfaSetupUi = Awaited<ReturnType<typeof loadMfaSetup>>;
/**
 * The quiet text-link buttons under a form ("Back to sign in", recovery codes), 44px tall
 * on phones like every other target on the page.
 */
const LINK_BUTTON =
  'h-auto min-h-11 p-0 text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:min-h-0';
/** The primary and single sign-on actions: full width and 44px, like the fields. */
const ACTION_BUTTON = 'h-11 w-full';
/** Why the code step went back to the password: its pending token is spent or lapsed. */
export const MFA_PENDING_SPENT_TEXT = 'Too many wrong codes, or the sign-in step timed out. Sign in again.';
/**
 * The sentence for a refused request. This page never shows the server's own text (a
 * proxy answers with an HTML page, a failed fetch with the browser's words). A step that
 * sets a password (the first admin, a forced change) passes `rule`, which turns the
 * server's 400 into the sentence to show (the first-admin step keeps the server's policy
 * reason; the forced change maps its length rule to a fixed sentence and anything else to
 * '', which shows `wrong`), and shows any other refusal as `wrong`; a sign-in step shows
 * `wrong` for a 401 and one fixed sentence for anything else.
 */
function failText(err: unknown, wrong: string, rule?: (said: string) => string): string {
  const status = err instanceof ApiError ? err.status : 0;
  if (!status || status >= 500) return 'Could not reach the server. Try again.';
  // A 429 is the rate limiter or, on the code step, a second-factor lock of 5 to 60
  // minutes (B19), so it never promises a minute.
  if (status === 429) return 'Too many attempts. Wait a few minutes, then try again.';
  if (rule) return (status === 400 && rule((err as ApiError).message)) || wrong;
  return status === 401 ? wrong : 'Sign in failed. Try again.';
}
/** The forced change's length rule, checked here and named by the server's 400 too. */
const CHANGE_MIN_TEXT = 'New password must be at least 8 characters.';
/**
 * Focus a field once the next render has committed: the step that holds it may only
 * just be mounting, or the field may still be disabled by the request that just ended.
 */
function focusSoon(ref: React.RefObject<HTMLElement | null>): void {
  window.setTimeout(() => ref.current?.focus(), 0);
}
/** The username a previous remembered sign-in left on this device (not a secret). */
function rememberedUsernameOnDevice(): string | null {
  try {
    return window.localStorage.getItem('soc.login.rememberedUsername')?.trim() || null;
  } catch {
    return null;
  }
}

export interface LoginProps {
  /** Called after a fully-successful login so the app can re-fetch the session. */
  onAuthenticated: () => void;
}

// `setup` is the OOBE create-first-admin flow; `mfa-enroll` is the optional
// prompted MFA step shown AFTER the admin account is created (never forced);
// `mfa-enroll-required` is the MANDATED enrollment step DURING login (no session
// yet: gated by the pending token; cannot be skipped into the console).
type Mode = 'signin' | 'setup' | 'change' | 'mfa' | 'mfa-enroll' | 'mfa-enroll-required';
type LoginThemeMode = 'system' | 'light' | 'dark';
type SigninStep = 'identity' | 'password';
/** Which way the form last moved, for the one step transition (null: no move yet). */
type StepMotion = 'forward' | 'back' | null;

/**
 * The three appearance buttons. `system` follows a light or dark organization default
 * before the device, as in the Console, so its button is named for that default while
 * Branding sets one (`orgDefault`).
 */
const appearance = (
  orgDefault: boolean,
): ReadonlyArray<{ mode: LoginThemeMode; label: string; Icon: LucideIcon }> => [
  {
    mode: 'system',
    label: orgDefault ? 'Use the organization default theme' : 'Use system theme',
    Icon: Monitor,
  },
  { mode: 'light', label: 'Light theme', Icon: Sun },
  { mode: 'dark', label: 'Dark theme', Icon: Moon },
];

// The OOBE password policy MIRRORS the server-side gate in routes_setup.py
// (min length + not equal to the username + not a trivially-common password) so the
// button-disable + inline hint match what the backend will accept. This is a UX
// nicety; the server remains authoritative (#9: never client-trusted).
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

/** The client mirror of the server strong-password policy: reason string or null. */
function oobePasswordPolicyError(password: string, username: string): string | null {
  const pw = password || '';
  if (pw.length < OOBE_MIN_PASSWORD_LEN) {
    return `Password must be at least ${OOBE_MIN_PASSWORD_LEN} characters.`;
  }
  if (pw.trim().toLowerCase() === (username || '').trim().toLowerCase()) {
    return 'Password must not be the same as the username.';
  }
  if (OOBE_COMMON_PASSWORDS.has(pw.trim().toLowerCase())) {
    return 'That password is too common. Choose a less predictable one.';
  }
  return null;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const {
    branding: brandingBase,
    refreshBranding,
    brandingFresh,
    markBrandingUsed,
    ready: themeReady,
    theme,
    setTheme,
  } = useTheme();
  // Read the additive Round-4 login white-label fields structurally (they are not in
  // the shared `Branding` interface yet; see login.api.ts). All are operator-set and
  // rendered as PLAIN text or mapped to CODE-defined layouts (#6/#9).
  const branding = brandingBase as LoginBranding;

  const wordmark = branding.org_name?.trim() || 'Agentic SOC';
  const logoUrl = branding.logo_data_url?.trim() || '';
  const loginSubtitle = branding.login_subtitle?.trim() || '';
  const footerText = branding.footer_text?.trim() || '';
  const rawSupport = branding.support_url?.trim() || '';
  const supportUrl = /^https?:\/\//i.test(rawSupport) ? rawSupport : '';

  // Login white-label (bounded plain-text copy + a legacy layout key).
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
  // Remember me: a username remembered on THIS device opens the password step with
  // the box pre-checked ("Use a different account" forgets it). The box is checked for
  // ONE account (lower-cased): the one this device remembers, or the name the warning
  // was accepted (or skipped) for. Any other name reads unchecked, also after Back, so
  // its owner sees the warning too (a shared device).
  const [rememberedUser, setRememberedUser] = React.useState(rememberedUsernameOnDevice);
  const [signinStep, setSigninStep] = React.useState<SigninStep>(() =>
    rememberedUser ? 'password' : 'identity',
  );
  const [stepMotion, setStepMotion] = React.useState<StepMotion>(null);
  const [username, setUsername] = React.useState(() => rememberedUser ?? '');
  const [rememberFor, setRememberFor] = React.useState(() => rememberedUser?.toLowerCase());
  // The sign-out notice is showing: the focused field is described by it.
  const [noticeShown, setNoticeShown] = React.useState(false);
  // Whether THIS attempt asked to be remembered / the minted session was remembered.
  const rememberRequestedRef = React.useRef(false);
  // The lazy Remember-me chunk: undefined while loading, null if it failed to load.
  const [rememberUi, setRememberUi] = React.useState<RememberUi | null>();
  // The two-factor setup chunk, loaded before an enrollment step shows (null: it failed).
  const [mfaUi, setMfaUi] = React.useState<MfaSetupUi | null>();
  const loadMfaUi = async () => setMfaUi(await loadMfaSetup().catch(() => null));
  const endedSession = useOptionalAuth()?.sessionEnded ?? null;
  const [displayName, setDisplayName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const signinIdentityRef = React.useRef<HTMLInputElement>(null);
  const signinPasswordRef = React.useRef<HTMLInputElement>(null);
  // The setup and forced-change password fields: a refused request returns focus to
  // them, because the fields were disabled while it ran and the page took the focus.
  const setupPasswordRef = React.useRef<HTMLInputElement>(null);
  const changePasswordRef = React.useRef<HTMLInputElement>(null);
  // Mandated-MFA enrollment focus target: entering 'mfa-enroll-required' unmounts
  // the sign-in form (focus would drop to <body> and the requirement would go
  // unannounced), so the mode HEADING takes programmatic focus instead: SR +
  // keyboard users land on "Set up two-factor authentication", whose
  // aria-describedby reads the requirement explanation.
  const modeHeadingRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (mode !== 'mfa-enroll-required') return;
    // Same deferred pattern the sign-in steps use for their input focus.
    const t = window.setTimeout(() => modeHeadingRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [mode]);
  const [confirm, setConfirm] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  // The error of the active field (sign-in and two-factor steps render it inline
  // under that field; the other modes keep it at the top of the form).
  const [error, setError] = React.useState<string | null>(null);
  // A secondary, quieter line under the main error (e.g. the honest client-side
  // failed-attempt count). Kept separate from `error` so the primary line stays the
  // backend/validation message and the count is visually subordinate.
  const [errorDetail, setErrorDetail] = React.useState<string | null>(null);
  // A page-level message that belongs to no field: a single sign-on callback failure
  // or an expired enrollment. Shown at the top of the form.
  const [pageError, setPageError] = React.useState<string | null>(null);
  /** Typing into the field clears only its own error. */
  const clearFieldError = () => {
    setError(null);
    setErrorDetail(null);
  };
  const clearError = () => {
    clearFieldError();
    setPageError(null);
  };
  const [busy, setBusy] = React.useState(false);
  // How many times sign-in has failed IN THIS BROWSER SESSION. This is an honest
  // client-side tally (the backend rate-limiter is per-IP and returns no count), used
  // only to surface "You've tried N times." Never trusted for any security decision.
  const signinAttemptsRef = React.useRef(0);

  // MFA phase 2 (Wave 2): the half-auth pending token + the entered code.
  const [pendingToken, setPendingToken] = React.useState('');
  const [mfaCode, setMfaCode] = React.useState('');
  const [useRecovery, setUseRecovery] = React.useState(false);
  // Disclosure toggle for the "Where can I find my recovery codes?" help text.
  const [showRecoveryHelp, setShowRecoveryHelp] = React.useState(false);
  // A failed code remounts the cells empty with the first one focused.
  const [otpAttempt, setOtpAttempt] = React.useState(0);
  // The six cells submit on their own; this keeps it to one request per code.
  const mfaInFlightRef = React.useRef(false);
  // The recovery-code field: a wrong code returns focus to it (it was disabled while
  // the check ran, which drops focus to the page).
  const mfaRecoveryRef = React.useRef<HTMLInputElement>(null);
  // Disclosure toggle for "Forgot password?" on the password step.
  const [showForgotHelp, setShowForgotHelp] = React.useState(false);

  // SSO providers (Wave 2): the enabled "Sign in with ..." buttons.
  const [ssoProviders, setSsoProviders] = React.useState<SsoProviderPublic[]>([]);
  // Whether the SSO-providers probe has settled. Folded into the first-paint gate so
  // the provider buttons never POP IN about 1 RTT after the form paints. Fails safe:
  // set on both ok + error.
  const [ssoResolved, setSsoResolved] = React.useState(false);
  const [ssoBusy, setSsoBusy] = React.useState<string | null>(null);

  // Whether the branding is settled for this page. Folded into the first-paint gate so
  // the login never paints with stale/default branding then SNAPS to the operator's
  // real copy (a FOUC). Fails safe: set on both ok + error.
  const [brandingResolved, setBrandingResolved] = React.useState(false);
  // Whether a single sign-on callback error has its sentence (true when there is none).
  const [ssoErrorResolved, setSsoErrorResolved] = React.useState(
    () => !new URLSearchParams(window.location.search).has('sso_error'),
  );

  // Load the Remember-me chunk in parallel with the probes below; first paint waits
  // for it (fail-safe) so the row and notice never pop in.
  React.useEffect(() => {
    let alive = true;
    // Fail-safe: when the chunk cannot load, the page simply works without it.
    loadRememberControls().then(
      (ui) => alive && setRememberUi(ui),
      () => alive && setRememberUi(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  // Detect the first-run OOBE state once on mount.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await api.setup.status();
        if (!alive) return;
        setStatus(s);
        if (s.needs_user) {
          setMode('setup');
          setUsername(''); // never prefill the first-admin form with a remembered name
        }
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
  // first paint, so painting waits for the slower of the two: no extra serial latency,
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

  // Branding without a second request on a cold load (Round 16 WP04): ThemeProvider
  // fetches GET /api/branding once at boot, so while that first fetch is in flight the
  // page waits for it (`ready`), and a fresh result is used as it is. The page fetches
  // again when the branding is stale: older than about 30 s, or used by a sign-in since
  // (the page shown after a sign-out), so a change saved elsewhere still shows. A
  // BrandingEditor save refreshes the shared context itself. Fails safe: the flag
  // flips in `finally`, so an unreachable backend resolves to the branding in effect.
  React.useEffect(() => {
    if (!themeReady) return undefined;
    if (brandingFresh()) {
      setBrandingResolved(true);
      return undefined;
    }
    let alive = true;
    void refreshBranding().finally(() => {
      if (alive) setBrandingResolved(true);
    });
    return () => {
      alive = false;
    };
  }, [themeReady, brandingFresh, refreshBranding]);

  // Surface an SSO callback error (the backend redirects to /login?sso_error=<code>).
  // Only the fixed sentence for the code is shown, never the query value (B25). The
  // sentences load only when there is an error to show, and the first paint waits for
  // them (in parallel with the probes) so the message never pops in. No `alive` guard:
  // the URL is cleaned on the first run, so a StrictMode re-run finds nothing to load.
  React.useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('sso_error');
    if (code === null) return;
    // Clean the URL so a refresh doesn't keep showing the error.
    const url = new URL(window.location.href);
    url.searchParams.delete('sso_error');
    window.history.replaceState({}, '', url.toString());
    loadSsoErrors()
      .then(
        (m) => setPageError(m.ssoErrorMessage(code)),
        () => setPageError(SSO_ERROR_FALLBACK),
      )
      .finally(() => setSsoErrorResolved(true));
  }, []);

  // Hand off into the Console. The branding this page painted counts as used, so the
  // sign-in page shown after a sign-out fetches it again.
  const handOff = () => {
    markBrandingUsed();
    onAuthenticated();
  };

  // Remember me availability (public /setup/status): shown only when advertised;
  // the control itself explains why it is unavailable.
  const rememberStatus = status?.auth_enabled === false ? undefined : status?.remember_me;
  const userKey = username.trim().toLowerCase();
  const rememberChecked = Boolean(
    rememberStatus?.enabled && !rememberStatus.insecure_blocked && rememberFor === userKey,
  );
  // The account this device remembers is the one being signed in (not a name typed
  // after going back), so its chip offers to forget the device.
  const rememberedChip = rememberedUser?.toLowerCase() === userKey;
  const RememberMeControl = rememberUi?.RememberMeControl;
  const MfaSetupCard = mfaUi?.MfaSetupCard;
  const mfaUnavailable = (
    <p role="alert" className="text-sm text-muted-foreground">
      Two-factor setup could not load. Reload the page to try again.
    </p>
  );
  const SessionEndNotice = rememberUi?.SessionEndNotice;
  // The focused sign-in field is described by the sign-out notice while it shows.
  const noticeId = noticeShown ? rememberUi?.SESSION_END_NOTICE_ID : undefined;
  const rememberRow =
    rememberStatus && RememberMeControl ? (
      <RememberMeControl
        status={rememberStatus}
        checked={rememberChecked}
        onCheckedChange={(on) => setRememberFor(on ? userKey : undefined)}
        busy={busy}
        username={username}
        wordmark={wordmark}
      />
    ) : null;

  // A SUCCESSFUL sign-in (password, MFA, or mandated enrollment), never a failed
  // one, so a typo or a probed name is never remembered.
  const recordSuccessfulSignin = (res: LoginResult) => {
    const opts = { username, requested: rememberRequestedRef.current, password };
    void loadRememberDevice().then((m) => m.afterSignIn(res, opts), () => undefined);
  };

  // "Back to sign in" from the second factor or a mandated enrollment: the identity step
  // again (the Remember me box is checked only for the account it was confirmed for).
  const backToSignIn = () => {
    setMode('signin');
    setSigninStep('identity');
    setStepMotion('back');
    setPendingToken('');
    setPassword('');
    clearError();
  };

  // "Use a different account": drop what this device keeps and start over.
  const forgetThisDevice = () => {
    void loadRememberDevice().then((m) => m.forgetDevice(), () => undefined);
    setRememberedUser(null);
    setRememberFor(undefined);
    setUsername('');
    setPassword('');
    clearError();
    setSigninStep('identity');
    setStepMotion('back');
    focusSoon(signinIdentityRef);
  };

  const startSso = async (providerId: string) => {
    if (ssoBusy) return;
    setSsoBusy(providerId);
    clearError();
    try {
      const res = await api.auth.sso.authorize(
        providerId,
        rememberChecked ? { remember: true } : undefined,
      );
      window.location.assign(res.auth_url);
    } catch {
      setPageError(SSO_ERROR_FALLBACK);
      setSsoBusy(null);
    }
  };

  const firstPaintReady =
    statusResolved &&
    ssoResolved &&
    brandingResolved &&
    ssoErrorResolved &&
    rememberUi !== undefined;

  const seededHint = Boolean(status?.seeded_default) && mode === 'signin';

  const continueSignin = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    // Continue is always there; an empty submit names the field and keeps focus on it.
    if (username.trim().length === 0) {
      setError('Enter your username.');
      setErrorDetail(null);
      signinIdentityRef.current?.focus();
      return;
    }
    clearError();
    setSigninStep('password');
    setStepMotion('forward');
    setShowForgotHelp(false);
    focusSoon(signinPasswordRef);
  };

  // --- Mode 1: first-run create admin (OOBE account-setup) ------------------ //
  // Round-4 Wave-5: the OOBE step calls POST /api/setup/account (the force-set,
  // strong-password writer that REPLACES init-admin) with a client-mirrored policy
  // gate, then signs the new admin in and, when the server prompts, offers an
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
      // The account writer does NOT mint a session: sign the new admin in now.
      await api.auth.login(uname, password);
      if (res.mfa_prompt) {
        // Offer (prompted-optional) two-factor enrollment before entering the console.
        await loadMfaUi();
        setMode('mfa-enroll');
        setStepMotion('forward');
        setBusy(false);
        return;
      }
      handOff();
    } catch (err) {
      // The first-admin step keeps the server's policy reason (`String` passes it on).
      setError(failText(err, 'Could not create the admin account.', String));
      setBusy(false);
      focusSoon(setupPasswordRef);
    }
  };

  // --- Mode 2: normal sign-in ----------------------------------------------- //
  const submitSignin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    // Sign in stays enabled while the password is empty (a disabled button explains
    // nothing): an empty submit names the missing field and puts focus on it.
    if (!password) {
      setError('Enter your password.');
      setErrorDetail(null);
      signinPasswordRef.current?.focus();
      return;
    }
    setBusy(true);
    clearError();
    rememberRequestedRef.current = rememberChecked;
    try {
      const res: LoginResult = await api.auth.login(
        username.trim(),
        password,
        rememberChecked ? { remember: true } : undefined,
      );
      // MANDATED-BUT-UNENROLLED (branch FIRST: the response also carries
      // requires_mfa): the account must use MFA but has no factor yet, so a code
      // challenge is impossible. Walk the user through enrollment IN the login,
      // gated by the same short-lived pending token (still no session).
      if (res.requires_mfa && res.mfa_enrollment_required && res.pending_token) {
        await loadMfaUi();
        setPendingToken(res.pending_token);
        setMfaCode('');
        setMode('mfa-enroll-required');
        setStepMotion('forward');
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
        setStepMotion('forward');
        setBusy(false);
        return;
      }
      recordSuccessfulSignin(res); // the session is minted
      if (res.user?.must_change_password) {
        // Keep the (now-validated) current password; ask for a new one.
        setNewPassword('');
        setConfirm('');
        setMode('change');
        setStepMotion('forward');
        setBusy(false);
        return;
      }
      handOff();
    } catch (err) {
      signinAttemptsRef.current += 1;
      // A fixed sentence, never the server's detail (a 429 is the per-IP rate limiter).
      setError(failText(err, 'The username or password is not correct.'));
      // Honest client-side count of failed attempts this session (see the ref note).
      setErrorDetail(
        signinAttemptsRef.current >= 2
          ? `You've tried ${signinAttemptsRef.current} times.`
          : null,
      );
      setPassword('');
      setBusy(false);
      focusSoon(signinPasswordRef);
    }
  };

  // --- Mode (MFA phase 2): exchange the TOTP / recovery code for a session ----- //
  // The six cells call this on their own when the last digit arrives (once: the ref
  // and `busy` both guard it), and "Verify and continue" stays for recovery codes and
  // as a fallback.
  const verifyMfa = async (code: string) => {
    if (busy || mfaInFlightRef.current) return;
    mfaInFlightRef.current = true;
    setBusy(true);
    clearError();
    try {
      const res: LoginResult = await api.auth.mfa.verify(pendingToken, code.trim());
      recordSuccessfulSignin(res);
      if (res.user?.must_change_password) {
        // Session minted, but the password is still flagged for change. The verify
        // route set the cookie, so we can change the password with the current one.
        setNewPassword('');
        setConfirm('');
        setMode('change');
        setStepMotion('forward');
        setBusy(false);
        return;
      }
      handOff();
    } catch (err) {
      setMfaCode('');
      // The pending token is spent (five wrong codes) or lapsed: no code can work now,
      // so go back to the password step, as an expired enrollment does (WP16).
      // (The next password step opens the code step without the recovery field.)
      if (err instanceof ApiError && err.status === 401 && /pending/i.test(err.message)) {
        setBusy(false);
        returnToPassword(MFA_PENDING_SPENT_TEXT);
        return;
      }
      setError(failText(err, 'That code is not correct. Try again.'));
      // A fresh, empty set of cells with the first one focused.
      setOtpAttempt((n) => n + 1);
      setBusy(false);
      // A recovery code is typed into one field, so focus goes back to that field.
      if (useRecovery) focusSoon(mfaRecoveryRef);
    } finally {
      mfaInFlightRef.current = false;
    }
  };
  const submitMfa = (e?: React.FormEvent) => {
    e?.preventDefault();
    // Verify stays enabled (a disabled button explains nothing): an empty submit names
    // what is missing and puts focus back on the code.
    if (!mfaCode.trim()) {
      setError(useRecovery ? 'Enter a recovery code.' : 'Enter the 6-digit code.');
      if (useRecovery) mfaRecoveryRef.current?.focus();
      else setOtpAttempt((n) => n + 1);
      return;
    }
    void verifyMfa(mfaCode);
  };

  // --- Mode (mandated MFA enrollment during login) -------------------------- //
  // The enroll-confirm endpoint minted the FULL session and returned the exact
  // /auth/mfa/verify success payload: finish exactly the way verifyMfa does
  // (incl. the forced password change, which the fresh cookie lets us perform).
  const completeEnrollLogin = (res: LoginResult) => {
    recordSuccessfulSignin(res);
    if (res.user?.must_change_password) {
      setNewPassword('');
      setConfirm('');
      setMode('change');
      setStepMotion('forward');
      return;
    }
    handOff();
  };

  // The short-lived pending token lapsed mid-enrollment (401). Return to the
  // password step (identity preserved) with a clear, non-alarming explanation:
  // signing in again simply restarts the 5-minute enrollment window.
  // The second-factor code step's way back to the password step (identity kept), with the
  // sentence that says why.
  function returnToPassword(message: string) {
    setMode('signin');
    setSigninStep('password');
    setStepMotion('back');
    setPendingToken('');
    setPassword('');
    setError(null);
    setErrorDetail(null);
    setPageError(message);
    focusSoon(signinPasswordRef);
  }
  const expireEnrollLogin = () => {
    returnToPassword('Your setup session expired. Sign in again to continue setting up two-factor authentication.');
  };

  // --- Mode 3: set a new password (forced change) --------------------------- //
  const submitChange = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    // Set password stays enabled: an empty submit says so. The server strips the value
    // before its length check, so this check does too.
    const typed = newPassword.trim();
    if (typed.length < 8 || newPassword !== confirm) {
      setError(!newPassword ? 'Enter a new password.' : typed.length < 8 ? CHANGE_MIN_TEXT : 'Passwords do not match.');
      changePasswordRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.changePassword(password, newPassword);
      handOff();
    } catch (err) {
      // A 400 is the length rule or a refusal such as a stale current password: a fixed
      // sentence either way, never the server's own lower-case text.
      setError(failText(err, 'Could not change the password.', (said) => (/at least/i.test(said) ? CHANGE_MIN_TEXT : '')));
      setBusy(false);
      focusSoon(changePasswordRef);
    }
  };

  const titleByMode: Record<Mode, string> = {
    // "Welcome back" only greets someone this device remembers; anyone else is told
    // where they are signing in.
    signin: loginHeadline || (rememberedUser ? 'Welcome back' : `Sign in to ${wordmark}`),
    setup: 'Create your admin account',
    change: 'Set a new password',
    mfa: 'Two-factor authentication',
    'mfa-enroll': 'Secure your account',
    'mfa-enroll-required': 'Set up two-factor authentication',
  };
  // A description only where it carries information: the operator's copy on the
  // identity step, and the instructions of the other modes. The password step has
  // none, because the identity row above the field already names the account.
  const descByMode: Record<Mode, string> = {
    signin: signinStep === 'identity' ? loginBody || loginSubtitle : '',
    setup:
      'No accounts exist yet. Create the first administrator to get started. Choose a strong, unique password.',
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
  const activeTitle = titleByMode[mode];
  const activeDescription = descByMode[mode];
  // Every step but the first-admin form shows a field's error under its field, so the
  // field being retyped stays where it is.
  const inlineErrors = mode !== 'setup';
  const describedBy = error ? ERROR_ID : noticeId;

  // OOBE submit guard: mirror the server policy so the button reflects acceptance.
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

  // The appearance control: three icon buttons, each pressed while its mode is the
  // stored one. `system` is the default and stays one press away. It sets the mode on
  // `ThemeProvider`; signed-in pages use the preference layer instead.
  const orgDefault = /^(light|dark)$/.test(effectiveBrandingTheme(brandingBase as BrandingLike));
  const themeControl = (
    <div className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
      <div
        data-login-theme-control
        role="group"
        aria-label="Appearance"
        className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5"
      >
        {appearance(orgDefault).map(({ mode, label, Icon }) => (
          <button
            key={mode}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={theme === mode}
            onClick={() => setTheme(mode)}
            className={cn(
              'inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors sm:h-7 sm:w-7',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card',
              // The pressed state is an inverted fill: `bg-muted` alone would be about
              // 1.1:1 on the card, a difference nobody can see (WCAG 1.4.11).
              theme === mode
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 sm:h-3.5 sm:w-3.5" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
  // One column for every mode: full width with 24px gutters on phones and 400px wide
  // from 640px up, centred across and top aligned at every width, so a step change or an
  // error grows the page downward and never moves the field being retyped.
  const mainClass =
    'login-canvas relative isolate flex min-h-dvh flex-col items-center overflow-x-hidden bg-canvas px-6 pb-16 pt-[max(4rem,12dvh)] sm:px-8 sm:pt-[max(4rem,18dvh)]';
  const columnClass = 'w-full sm:w-[25rem]';
  const markSlot = 'mb-8 flex h-10 items-center';

  // Hold the form until the setup-status probe, the SSO-providers probe, the branding
  // and the Remember me chunk settle, so a first-run install never flashes the sign-in
  // form before the create-admin form, the SSO block never pops in a beat after the
  // form, and the login never paints with stale branding then snaps to the operator's
  // copy. The probes fire on mount in parallel, so this waits for the slowest one, not
  // their sum, and each fails safe. Meanwhile the final shell is already in place: the
  // canvas, the appearance control and the column, with a small glyph that shows only
  // when the wait passes 300ms.
  if (!firstPaintReady) {
    return (
      <main data-login-shell="minimal" data-login-loading className={mainClass}>
        {themeControl}
        <div className={columnClass}>
          <div className={markSlot} aria-hidden />
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-48 items-center justify-center"
          >
            <LoadingGlyph size="sm" className="login-delayed-reveal" />
            <span className="sr-only">Loading sign-in</span>
          </div>
        </div>
      </main>
    );
  }

  const stepClass =
    stepMotion === 'forward'
      ? 'login-step-forward'
      : stepMotion === 'back'
        ? 'login-step-back'
        : undefined;
  const ssoOffered = mode === 'signin' && signinStep === 'identity' && ssoProviders.length > 0;

  // Legacy split / centered / full preferences remain readable and round-trip through
  // Branding, but intentionally converge on one surface.
  return (
    <main data-login-layout={loginLayout} data-login-shell="minimal" className={mainClass}>
      {themeControl}
      <div data-login-identity-pane className={cn('login-enter', columnClass)}>
        <div className={markSlot} aria-hidden>
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-10 w-auto max-w-48 object-contain object-left" />
          ) : (
            <Shield className="h-7 w-7 text-primary" aria-hidden />
          )}
        </div>

        {/* tabIndex={-1}: the mandated-MFA transition focuses this heading
            programmatically (see modeHeadingRef), never a tab stop. The describedby
            hands SRs the mode description (i.e. WHY enrollment is required) as the
            heading's accessible context on focus. */}
        <h1
          ref={modeHeadingRef}
          tabIndex={-1}
          aria-describedby={activeDescription ? 'login-mode-description' : undefined}
          className="break-words text-3xl text-foreground [outline:none]"
        >
          {activeTitle}
        </h1>
        {activeDescription ? (
          <p
            id="login-mode-description"
            className="mt-2 whitespace-pre-line break-words text-base text-muted-foreground"
          >
            {activeDescription}
          </p>
        ) : null}

        <div className="mt-8">
          {!error && !pageError && mode === 'signin' && SessionEndNotice ? (
            <SessionEndNotice reason={endedSession?.reason} onShownChange={setNoticeShown} />
          ) : null}
          {pageError && mode === 'signin' ? (
            <Alert variant="destructive" className="mb-4" data-login-page-error>
              <AlertCircle aria-hidden />
              <AlertDescription>{pageError}</AlertDescription>
            </Alert>
          ) : null}
          {error && !inlineErrors ? (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle aria-hidden />
              <AlertDescription>
                <span className="font-medium">{error}</span>
                {errorDetail ? (
                  <span className="mt-0.5 block text-xs opacity-80">{errorDetail}</span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Keyed by step, so the incoming form mounts fresh and plays the one step
              transition (forward or back); the outgoing form leaves at once. */}
          <div key={`${mode}:${signinStep}`} className={stepClass} data-login-step={`${mode}:${signinStep}`}>
            {/* ---- Mode: create first admin (OOBE account-setup) ----------- */}
            {mode === 'setup' ? (
              <form onSubmit={submitSetup} className="space-y-4" noValidate>
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
                    ref={setupPasswordRef}
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
                  {/* Policy hint mirrors the server gate (min 12, not the username, not common). */}
                  <p
                    id="setup-password-help"
                    className={cn(
                      'text-xs',
                      password && setupPolicyError ? 'text-critical' : 'text-muted-foreground',
                    )}
                  >
                    {password && setupPolicyError
                      ? setupPolicyError
                      : `Use at least ${OOBE_MIN_PASSWORD_LEN} characters, not your username or a common password.`}
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
                  {/* Reserved slot: the mismatch line inserts on a typing mismatch;
                      keep its height always so it never shoves the submit button. */}
                  <div className="min-h-[1rem]" aria-live="polite">
                    {confirm && password !== confirm ? (
                      <p className="text-xs text-critical">Passwords do not match.</p>
                    ) : null}
                  </div>
                </div>
                <Button type="submit" className={ACTION_BUTTON} disabled={!canSubmitSetup}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <UserPlus aria-hidden />}
                  {busy ? 'Creating…' : 'Create admin & sign in'}
                </Button>
              </form>
            ) : null}

            {/* ---- Mode: OPTIONAL MFA enrollment after account creation ---- */}
            {mode === 'mfa-enroll' ? (
              <div className="space-y-4">
                {/* frameless: the page already supplies the "Secure your account"
                    heading. Reserve the QR area's height so the second grow (when the
                    enrollment QR resolves after mount) is absorbed, not a jump. */}
                <div className="min-h-[24rem]">
                  {MfaSetupCard ? <MfaSetupCard enabled={false} frameless onChanged={handOff} /> : mfaUnavailable}
                </div>
                <Button type="button" variant="ghost" className="w-full" onClick={handOff}>
                  Skip for now &amp; continue
                </Button>
              </div>
            ) : null}

            {/* ---- Mode: MANDATED MFA enrollment during login -------------- */}
            {mode === 'mfa-enroll-required' ? (
              <div className="space-y-4">
                {/* frameless (single surface grammar) + the pending token reroutes the
                    card's setup/confirm to the PUBLIC enroll endpoints and makes a
                    successful confirm a COMPLETED login. Deliberately NO skip: there
                    is no session yet and the mandate is not optional. The only exits
                    are finishing enrollment or going back to sign-in. The min-h
                    reserve absorbs the QR growth (same as the optional step). */}
                <div className="min-h-[24rem]">
                  {MfaSetupCard ? (
                    <MfaSetupCard
                      enabled={false}
                      frameless
                      pendingToken={pendingToken}
                      onComplete={completeEnrollLogin}
                      onPendingExpired={expireEnrollLogin}
                    />
                  ) : (
                    mfaUnavailable
                  )}
                </div>
                <Button type="button" variant="link" className={LINK_BUTTON} onClick={backToSignIn}>
                  Back to sign in
                </Button>
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
                      onChange={(e) => {
                        setUsername(e.target.value);
                        if (error) clearFieldError();
                      }}
                      autoComplete="username"
                      name="username"
                      placeholder="Enter your username"
                      disabled={busy}
                      required
                      aria-describedby={describedBy}
                      aria-invalid={error ? true : undefined}
                      /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                      autoFocus
                    />
                    <FieldError message={error} detail={errorDetail} />
                  </div>
                  <Button type="submit" className={ACTION_BUTTON} disabled={busy}>
                    Continue
                  </Button>
                </form>
              ) : (
                <form onSubmit={submitSignin} className="space-y-4" noValidate>
                  {/* Password managers pair a saved password with a username field
                      in the SAME form (Chromium's two-step sign-in guidance), so the
                      password step carries a hidden, non-tabbable copy. */}
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={username.trim()}
                    onChange={() => undefined}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="sr-only"
                    data-login-hidden-username
                  />
                  <div
                    className="flex min-h-8 items-center justify-between gap-3 text-base"
                    data-login-identity-chip={rememberedChip ? 'remembered' : 'typed'}
                  >
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {username.trim()}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      // -mr-2: the text ends on the column edge, as the links below do.
                      className="-mr-2 h-11 shrink-0 px-2 text-xs text-muted-foreground sm:h-8"
                      onClick={() => {
                        if (rememberedChip) {
                          forgetThisDevice();
                          return;
                        }
                        setSigninStep('identity');
                        setStepMotion('back');
                        setPassword('');
                        clearError();
                        focusSoon(signinIdentityRef);
                      }}
                      disabled={busy}
                    >
                      {rememberedChip ? null : <ArrowLeft className="h-3.5 w-3.5" aria-hidden />}
                      {rememberedChip ? 'Use a different account' : 'Back'}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="login-password">Password</Label>
                      <Button
                        type="button"
                        variant="link"
                        className={LINK_BUTTON}
                        onClick={() => setShowForgotHelp((v) => !v)}
                        aria-expanded={showForgotHelp}
                        aria-controls={showForgotHelp ? 'login-forgot-help' : undefined}
                      >
                        Forgot password?
                      </Button>
                    </div>
                    <PasswordInput
                      ref={signinPasswordRef}
                      id="login-password"
                      value={password}
                      onChange={(value) => {
                        setPassword(value);
                        if (error) clearFieldError();
                      }}
                      autoComplete="current-password"
                      name="password"
                      placeholder="Enter your password"
                      ariaDescribedBy={describedBy}
                      ariaInvalid={Boolean(error)}
                      disabled={busy}
                      required
                      // A remembered username opens on this step: focus the field so
                      // the browser's password manager can fill it.
                      /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the only field of the remembered sign-in step */
                      autoFocus={Boolean(rememberedUser)}
                    />
                    {showForgotHelp ? (
                      <p id="login-forgot-help" className="text-xs text-muted-foreground">
                        Ask an administrator to reset it. There is no self-service reset.
                      </p>
                    ) : null}
                    <FieldError message={error} detail={errorDetail} />
                  </div>
                  {rememberRow}
                  <Button type="submit" className={ACTION_BUTTON} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {busy ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>
              )
            ) : null}

            {/* With single sign-on, Remember me also sits on the identity step, right
                under Continue (it applies to the provider buttons below). */}
            {ssoOffered && rememberRow ? <div className="mt-4">{rememberRow}</div> : null}
            {ssoOffered ? (
              <div className="mt-6">
                <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="mt-6 space-y-2" role="group" aria-label="Single sign-on">
                  {ssoProviders.map((p) => {
                    const label = ssoLabel(p);
                    return (
                      <Button
                        key={p.id}
                        type="button"
                        variant="outline"
                        // A long provider name wraps instead of being cut off.
                        className={cn(ACTION_BUTTON, 'h-auto min-h-11 whitespace-normal py-2')}
                        onClick={() => void startSso(p.id)}
                        disabled={Boolean(ssoBusy)}
                      >
                        {ssoBusy === p.id ? (
                          <Loader2 className="animate-spin" aria-hidden />
                        ) : (
                          <SsoBrandIcon type={p.type} />
                        )}
                        <span className="min-w-0 break-words">Sign in with {label}</span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {seededHint && signinStep === 'identity' ? (
              <div
                data-login-demo-hint
                className="mt-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-muted-foreground"
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
                  className="-mr-2 h-11 shrink-0 px-2 text-xs sm:h-8"
                  onClick={() => {
                    setUsername('Admin');
                    setPassword('Admin@123');
                    clearError();
                    setSigninStep('password');
                    setStepMotion('forward');
                    focusSoon(signinPasswordRef);
                  }}
                  disabled={busy}
                >
                  Use
                </Button>
              </div>
            ) : null}

            {/* ---- Mode: MFA second factor (TOTP / recovery) --------------- */}
            {mode === 'mfa' ? (
              <form onSubmit={submitMfa} className="space-y-4" noValidate>
                <div className="space-y-2">
                  {/* htmlFor only in the recovery branch (id="mfa-code" is the text
                      Input there). In the OTP branch the control is the segmented
                      OtpInput group, which carries its own aria-label; a htmlFor
                      pointing at a non-existent id would be a dead association. */}
                  <Label htmlFor={useRecovery ? 'mfa-code' : undefined}>
                    {useRecovery ? 'Recovery code' : 'Authentication code'}
                  </Label>
                  {useRecovery ? (
                    <>
                      <LoginTextInput
                        ref={mfaRecoveryRef}
                        id="mfa-code"
                        icon={ShieldCheck}
                        className="font-mono tracking-wider"
                        inputMode="text"
                        autoComplete="one-time-code"
                        placeholder="XXXX-XXXX"
                        value={mfaCode}
                        onChange={(e) => setMfaCode(e.target.value)}
                        disabled={busy}
                        aria-describedby={error ? ERROR_ID : undefined}
                        aria-invalid={error ? true : undefined}
                        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                        autoFocus
                      />
                      <div className="text-xs">
                        <Button
                          type="button"
                          variant="link"
                          className={LINK_BUTTON}
                          onClick={() => setShowRecoveryHelp((v) => !v)}
                          aria-expanded={showRecoveryHelp}
                        >
                          Where can I find my recovery codes?
                        </Button>
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
                      key={otpAttempt}
                      value={mfaCode}
                      onChange={(next) => {
                        setMfaCode(next);
                        if (error) setError(null);
                      }}
                      onComplete={(code) => void verifyMfa(code)}
                      disabled={busy}
                      /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                      autoFocus
                      aria-label="Authentication code"
                    />
                  )}
                  <FieldError message={error} />
                </div>
                <Button type="submit" className={ACTION_BUTTON} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
                  {busy ? 'Verifying…' : 'Verify and continue'}
                </Button>
                <div className="flex items-center justify-between text-xs">
                  <Button
                    type="button"
                    variant="link"
                    className={LINK_BUTTON}
                    onClick={() => {
                      setUseRecovery((v) => !v);
                      setMfaCode('');
                      clearError();
                      setShowRecoveryHelp(false);
                    }}
                    disabled={busy}
                  >
                    {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
                  </Button>
                  <Button
                    type="button"
                    variant="link"
                    className={LINK_BUTTON}
                    onClick={() => {
                      backToSignIn();
                      setMfaCode('');
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
              <form onSubmit={submitChange} className="space-y-4" noValidate>
                <div className="space-y-2">
                  <Label htmlFor="change-new">New password</Label>
                  <PasswordInput
                    ref={changePasswordRef}
                    id="change-new"
                    value={newPassword}
                    onChange={setNewPassword}
                    autoComplete="new-password"
                    placeholder="Create a new password"
                    ariaDescribedBy={describedBy}
                    ariaInvalid={Boolean(error)}
                    disabled={busy}
                    required
                    /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of the forced password-change step; behavior-preserving */
                    autoFocus
                  />
                  {/* Reserved slot: same reserve-space treatment as the setup form. */}
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
                  <FieldError message={error} />
                </div>
                <Button type="submit" className={ACTION_BUTTON} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
                  {busy ? 'Updating…' : 'Set password & continue'}
                </Button>
              </form>
            ) : null}
          </div>
        </div>

        {supportUrl || (mode === 'signin' && loginChips.length > 0) || footerText ? (
          <div className="mt-10 space-y-1.5 text-center text-xs leading-5 text-muted-foreground">
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              {supportUrl ? (
                <a
                  href={supportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'inline-flex min-h-8 items-center gap-1 rounded-sm text-muted-foreground',
                    'transition-colors focus-visible:outline-none hover:text-foreground',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
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
    </main>
  );
}
