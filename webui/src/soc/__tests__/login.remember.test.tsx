/**
 * Round 12 — "Remember me" on the sign-in page (SPEC D14, research/remember-me.md §6
 * web tests 1–9 and 12, SYNTHESIS-ux §4 adjustments).
 *
 *  1. The row is shown (24 h / 6 h copy), shown DISABLED with a reason when the
 *     administrator turned it off or the console is on plain HTTP, and hidden only
 *     when the backend does not advertise it.
 *  2. Checking opens the warning dialog (warning tone, Cancel focused, the whole
 *     warning — paragraph AND list — is its accessible description, focus returns
 *     to the box when it closes). Cancel keeps it unchecked; "Keep me signed in"
 *     checks it. The warning is skipped only for the account this device already
 *     remembers (or whoever accepted it on this page): an acknowledgement is stored
 *     only after a successful remembered sign-in and removed with the username, so
 *     the next person on a shared device always sees it. Enter on the box signs in.
 *  3. The login body and the SSO authorize call carry `remember`.
 *  4. Only a SUCCESSFUL remembered sign-in keeps the username; an unchecked success
 *     or a server refusal removes it (refusal → a one-line toast); a failure never
 *     stores anything.
 *  5. A remembered username opens on the password step with "Use a different
 *     account" (the one control that forgets the device on this page).
 *  6. The password form carries a hidden, non-tabbable `autocomplete="username"`.
 *  7. PasswordCredential is stored only when remembered, and a throwing store never
 *     breaks sign-in.
 *  8. No storage write ever contains the password.
 *  9. The signed-out notice copy for every reason (server reason + local expiry),
 *     in a live region present from first paint and linked to the focused field.
 * 12. axe: the row and the dialog have no violations.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const loginMock = vi.fn();
const setupStatusMock = vi.fn();
const ssoProvidersMock = vi.fn();
const ssoAuthorizeMock = vi.fn();
const brandingMock = vi.fn();
const mfaVerifyMock = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getBranding: () => brandingMock(),
      get: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({ ok: true }),
      put: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
      setup: { status: () => setupStatusMock() },
      auth: {
        login: (u: string, p: string, o?: unknown) => loginMock(u, p, o),
        changePassword: vi.fn().mockResolvedValue({ ok: true }),
        mfa: {
          verify: (t: string, c: string) => mfaVerifyMock(t, c),
          enrollSetup: vi.fn(),
          enrollConfirm: vi.fn(),
        },
        sso: {
          providers: () => ssoProvidersMock(),
          authorize: (id: string, o?: unknown) => ssoAuthorizeMock(id, o),
        },
      },
    },
  };
});

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return {
    ...actual,
    toast: Object.assign((...args: unknown[]) => toastMock(...args), {
      success: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// The sign-in page reads the provider's "why did the last session end" signal.
const authCtx: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/soc/auth', () => ({
  useOptionalAuth: () => authCtx.current,
}));

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';
import { ApiError as MockApiError } from '@/lib/api';
import {
  insecureRememberHint,
  REMEMBER_ACK_KEY,
  REMEMBERED_UNTIL_KEY,
  REMEMBERED_USERNAME_KEY,
  rememberRefusedMessage,
} from '@/soc/components/auth/rememberMe';

const BRANDING = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '',
  accent_color2: '',
  theme: '',
  login_subtitle: '',
  footer_text: '',
  support_url: '',
  dark_mode_default: false,
};

const PASSWORD = 'S3cret-Passw0rd!';

function status(remember?: Record<string, unknown> | null) {
  return {
    setup_complete: true,
    seeded_default: false,
    auth_enabled: true,
    ...(remember === null
      ? {}
      : {
          remember_me: {
            enabled: true,
            duration_seconds: 86_400,
            // The backend default: the 12 hour idle timeout applies to remembered devices.
            idle_seconds: 43_200,
            insecure_blocked: false,
            ...(remember ?? {}),
          },
        }),
  };
}

function renderLogin(onAuthenticated = vi.fn()) {
  const view = render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={onAuthenticated} />
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { ...view, onAuthenticated };
}

async function toPasswordStep(username = 'alice') {
  const input = await screen.findByLabelText('Username');
  fireEvent.change(input, { target: { value: username } });
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  return screen.findByLabelText('Password');
}

function rememberBox() {
  return screen.getByRole('checkbox', { name: 'Remember me' });
}

async function acceptWarning() {
  fireEvent.click(rememberBox());
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep me signed in' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
}

describe('Login — Remember me', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    authCtx.current = null;
    document.documentElement.classList.remove('dark');
    for (const m of [loginMock, setupStatusMock, ssoProvidersMock, ssoAuthorizeMock,
      brandingMock, mfaVerifyMock, toastMock]) m.mockReset();
    brandingMock.mockResolvedValue({ ...BRANDING });
    setupStatusMock.mockResolvedValue(status());
    ssoProvidersMock.mockResolvedValue({ providers: [] });
    ssoAuthorizeMock.mockReturnValue(new Promise(() => undefined));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { PasswordCredential?: unknown }).PasswordCredential;
  });

  // ---- 1 ------------------------------------------------------------------ //
  it('offers the box with the policy duration and a 44px row', async () => {
    renderLogin();
    await toPasswordStep();
    const box = rememberBox();
    expect(box).toBeEnabled();
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Stay signed in on this device for up to 24 hours')).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription('Stay signed in on this device for up to 24 hours');
    const row = document.querySelector('[data-login-remember]');
    expect(row).toHaveClass('min-h-11', 'press-scale');
  });

  it('formats a 6 hour preset', async () => {
    setupStatusMock.mockResolvedValue(status({ duration_seconds: 6 * 3600 }));
    renderLogin();
    await toPasswordStep();
    expect(screen.getByText('Stay signed in on this device for up to 6 hours')).toBeInTheDocument();
  });

  it('states no inactivity limit when none is shorter than the remembered time', async () => {
    // A 6 hour preset under the 12 hour idle timeout: the server reports none (0).
    setupStatusMock.mockResolvedValue(status({ duration_seconds: 6 * 3600, idle_seconds: 0 }));
    renderLogin();
    await toPasswordStep('alice');
    fireEvent.click(rememberBox());
    const dialog = await screen.findByRole('alertdialog');
    const limits = dialog.querySelector('[data-remember-warning-limits]');
    expect(limits).toHaveTextContent(
      "You'll be asked to sign in again after 6 hours, or sooner if an administrator ends your session.",
    );
    expect(limits).not.toHaveTextContent(/without activity/);
  });

  it('states a separate remembered inactivity limit in minutes', async () => {
    setupStatusMock.mockResolvedValue(status({ idle_seconds: 30 * 60 }));
    renderLogin();
    await toPasswordStep('alice');
    fireEvent.click(rememberBox());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.querySelector('[data-remember-warning-limits]')).toHaveTextContent(
      /after 24 hours, after 30 minutes without activity, or sooner/,
    );
  });

  it('shows the box disabled with a reason when the administrator turned it off', async () => {
    setupStatusMock.mockResolvedValue(status({ enabled: false }));
    renderLogin();
    await toPasswordStep();
    expect(rememberBox()).toBeDisabled();
    expect(screen.getByText('Turned off by your administrator')).toBeInTheDocument();
    // No press feedback on a row that cannot be pressed.
    expect(document.querySelector('[data-login-remember]')).not.toHaveClass('press-scale');
    expect(document.querySelector('[data-login-remember]')).toHaveClass('cursor-not-allowed');
  });

  it('shows the box disabled with a reason on plain HTTP', async () => {
    setupStatusMock.mockResolvedValue(status({ insecure_blocked: true }));
    renderLogin();
    await toPasswordStep();
    expect(rememberBox()).toBeDisabled();
    expect(
      screen.getByText('Available when the console is served over HTTPS'),
    ).toBeInTheDocument();
  });

  it('hides the row when the backend does not advertise the feature', async () => {
    setupStatusMock.mockResolvedValue(status(null));
    renderLogin();
    await toPasswordStep();
    expect(screen.queryByRole('checkbox', { name: 'Remember me' })).not.toBeInTheDocument();
  });

  // ---- 2 ------------------------------------------------------------------ //
  it('asks before checking: warning tone, Cancel focused, Cancel keeps it unchecked', async () => {
    renderLogin();
    await toPasswordStep('alice');
    fireEvent.click(rememberBox());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Keep this device signed in?')).toBeInTheDocument();
    expect(dialog.querySelector('[data-remember-warning-title] svg.text-warning-text')).not.toBeNull();
    expect(dialog).toHaveTextContent(/For the next 24 hours, anyone who can open this browser/);
    expect(dialog).toHaveTextContent(/use Acme SOC as alice/);
    expect(dialog).toHaveTextContent(/shared, public, or kiosk computers/);
    // Every limit that signs a remembered device out, inactivity included.
    expect(dialog.querySelector('[data-remember-warning-limits]')).toHaveTextContent(
      "You'll be asked to sign in again after 24 hours, after 12 hours without activity, or sooner if an administrator ends your session.",
    );
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    // Not destructive: the confirm is the normal primary button, never red.
    expect(within(dialog).getByRole('button', { name: 'Keep me signed in' }).className)
      .not.toMatch(/destructive|critical/);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(rememberBox()).toHaveAttribute('aria-checked', 'false');
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
  });

  it('accepting checks the box without asking again on this page, and stores nothing yet', async () => {
    renderLogin();
    await toPasswordStep();
    await acceptWarning();
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
    // Nothing is kept on the device before a successful remembered sign-in.
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
    // Unchecking needs no confirmation …
    fireEvent.click(rememberBox());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(rememberBox()).toHaveAttribute('aria-checked', 'false');
    // … and re-checking for the same person on this page does not re-open it.
    fireEvent.click(rememberBox());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
  });

  it('warns the next person on a shared device even after someone accepted', async () => {
    // Person A accepts the warning, unchecks the box and signs in WITHOUT it.
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: false });
    const first = renderLogin();
    const pw = await toPasswordStep('alice');
    await acceptWarning();
    fireEvent.click(rememberBox());
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(first.onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
    first.unmount();

    // Person B on the same browser: checking the box shows the warning.
    renderLogin();
    await toPasswordStep('bob');
    fireEvent.click(rememberBox());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/as bob/);
    // (The modal hides the page from the accessibility tree while it is open.)
    expect(screen.getByRole('checkbox', { name: 'Remember me', hidden: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('a stray acknowledgement without a remembered username never skips the warning', async () => {
    window.localStorage.setItem(REMEMBER_ACK_KEY, '1');
    renderLogin();
    await toPasswordStep('bob');
    fireEvent.click(rememberBox());
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('skips the warning only for the account this device remembers', async () => {
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    window.localStorage.setItem(REMEMBER_ACK_KEY, '1');
    renderLogin();
    await screen.findByLabelText('Password');
    // alice: pre-checked; unchecking and re-checking needs no warning.
    fireEvent.click(rememberBox());
    fireEvent.click(rememberBox());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
    // Someone else on this device: the warning again.
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    await toPasswordStep('bob');
    fireEvent.click(rememberBox());
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it.each([
    ['Cancel', 'cancel'],
    ['Escape', 'escape'],
    ['Keep me signed in', 'confirm'],
  ])('returns focus to the box when the warning closes (%s)', async (_label, how) => {
    renderLogin();
    await toPasswordStep('alice');
    const box = rememberBox();
    box.focus();
    fireEvent.click(box);
    const dialog = await screen.findByRole('alertdialog');
    if (how === 'escape') {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    } else {
      fireEvent.click(
        within(dialog).getByRole('button', { name: how === 'cancel' ? 'Cancel' : 'Keep me signed in' }),
      );
    }
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(rememberBox()).toHaveFocus());
    expect(rememberBox()).toHaveAttribute('aria-checked', how === 'confirm' ? 'true' : 'false');
  });

  it('signs in when Enter is pressed on the box', async () => {
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: true });
    const { onAuthenticated } = renderLogin();
    const pw = await toPasswordStep('alice');
    fireEvent.change(pw, { target: { value: PASSWORD } });
    await acceptWarning();
    fireEvent.keyDown(rememberBox(), { key: 'Enter' });
    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith('alice', PASSWORD, { remember: true }),
    );
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
  });

  // ---- 3 ------------------------------------------------------------------ //
  it('sends remember with the sign-in and with single sign-on', async () => {
    ssoProvidersMock.mockResolvedValue({
      providers: [{ id: 'g', type: 'google', display_name: 'Google' }],
    });
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: true });
    renderLogin();
    // Identity step: SSO is offered, so the row is here too (one shared state).
    await screen.findByLabelText('Username');
    fireEvent.click(rememberBox());
    // No username yet (single sign-on): the warning speaks of "your account".
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(/with your account/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep me signed in' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(ssoAuthorizeMock).toHaveBeenCalledWith('g', { remember: true }));

    // The password step keeps the same choice and sends it.
    const pw = await toPasswordStep('alice');
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(loginMock).toHaveBeenCalledWith('alice', PASSWORD, { remember: true }),
    );
  });

  it('does not ask for remember when the box is unchecked', async () => {
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: false });
    renderLogin();
    const pw = await toPasswordStep('alice');
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('alice', PASSWORD, undefined));
  });

  // ---- 4 ------------------------------------------------------------------ //
  it('keeps the username only after a successful remembered sign-in', async () => {
    loginMock.mockResolvedValue({
      token: 't',
      user: { username: 'alice' },
      remembered: true,
      remember_reason: 'ok',
      session_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const { onAuthenticated } = renderLogin();
    const pw = await toPasswordStep('alice');
    await acceptWarning();
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBe('alice'));
    // The acknowledgement is recorded with the remembered account, after success.
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBe('1');
    expect(JSON.parse(window.localStorage.getItem(REMEMBERED_UNTIL_KEY) ?? '{}').lifetime).toBe(
      86_400,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('an unchecked success removes a previously remembered username', async () => {
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    window.localStorage.setItem(REMEMBER_ACK_KEY, '1');
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: false });
    const { onAuthenticated } = renderLogin();
    const pw = await screen.findByLabelText('Password');
    fireEvent.click(rememberBox()); // uncheck the pre-checked box
    expect(rememberBox()).toHaveAttribute('aria-checked', 'false');
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull());
    // … and its acknowledgement with it.
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
  });

  it('a failed attempt never stores the username or an acknowledgement', async () => {
    loginMock.mockRejectedValue(new MockApiError(401, 'invalid credentials'));
    renderLogin();
    const pw = await toPasswordStep('mallory');
    await acceptWarning();
    fireEvent.change(pw, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('invalid credentials');
    expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
  });

  it('explains a server refusal once and forgets the username', async () => {
    window.localStorage.setItem(REMEMBER_ACK_KEY, '1');
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    loginMock.mockResolvedValue({
      token: 't',
      user: { username: 'alice' },
      remembered: false,
      remember_reason: 'role_excluded',
    });
    const { onAuthenticated } = renderLogin();
    const pw = await screen.findByLabelText('Password');
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(
      "Remember me isn't available for your role. You'll stay signed in until you close the browser.",
    );
    expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
  });

  it('records a remembered MFA sign-in after the second factor', async () => {
    loginMock.mockResolvedValue({ requires_mfa: true, pending_token: 'pending' });
    mfaVerifyMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: true });
    const { onAuthenticated } = renderLogin();
    const pw = await toPasswordStep('alice');
    await acceptWarning();
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    // Nothing is remembered until the second factor succeeds.
    await screen.findByRole('group', { name: 'Authentication code' });
    expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    fireEvent.change(screen.getByLabelText('Recovery code'), { target: { value: 'aaaa-bbbb' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify/ }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(mfaVerifyMock).toHaveBeenCalledWith('pending', 'aaaa-bbbb');
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBe('alice'));
  });

  // ---- 5 ------------------------------------------------------------------ //
  it('opens on the password step for a remembered username', async () => {
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    window.localStorage.setItem(REMEMBER_ACK_KEY, '1');
    renderLogin();
    const pw = await screen.findByLabelText('Password');
    await waitFor(() => expect(pw).toHaveFocus());
    const chip = document.querySelector('[data-login-identity-chip="remembered"]');
    expect(chip).toHaveTextContent('alice');
    expect(rememberBox()).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    // One control forgets the device here; "Forget this device" lives in Sessions.
    expect(screen.queryByRole('button', { name: 'Forget this device' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(await screen.findByLabelText('Username')).toHaveValue('');
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull());
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
  });

  // ---- 6 ------------------------------------------------------------------ //
  it('carries a hidden, non-tabbable username field in the password form', async () => {
    renderLogin();
    const pw = await toPasswordStep('alice');
    const form = pw.closest('form');
    const hidden = form?.querySelector<HTMLInputElement>(
      'input[autocomplete="username"][name="username"]',
    );
    expect(hidden).not.toBeNull();
    expect(hidden).toHaveValue('alice');
    expect(hidden).toHaveAttribute('tabindex', '-1');
    expect(hidden).toHaveAttribute('aria-hidden', 'true');
    expect(hidden).toHaveClass('sr-only');
    expect(pw).toHaveAttribute('autocomplete', 'current-password');
  });

  // ---- 7 ------------------------------------------------------------------ //
  function stubPasswordCredential(store: ReturnType<typeof vi.fn>) {
    class FakePasswordCredential {
      id: string;
      password: string;
      constructor(data: { id: string; password: string }) {
        this.id = data.id;
        this.password = data.password;
      }
    }
    Object.defineProperty(window, 'PasswordCredential', {
      value: FakePasswordCredential,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'credentials', {
      value: { store },
      configurable: true,
    });
  }

  it('hands the credential to the browser only for a remembered sign-in', async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    stubPasswordCredential(store);
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: true });
    const { onAuthenticated } = renderLogin();
    const pw = await toPasswordStep('alice');
    await acceptWarning();
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(store).toHaveBeenCalledTimes(1));
    expect(store.mock.calls[0][0]).toMatchObject({ id: 'alice', password: PASSWORD });
  });

  it('never calls the credential store for an unchecked box', async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    stubPasswordCredential(store);
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: false });
    const { onAuthenticated } = renderLogin();
    const pw = await toPasswordStep('alice');
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(store).not.toHaveBeenCalled();
  });

  it('never offers a temporary password that must be changed right away', async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    stubPasswordCredential(store);
    loginMock.mockResolvedValue({
      token: 't',
      user: { username: 'alice', must_change_password: true },
      remembered: true,
    });
    renderLogin();
    const pw = await toPasswordStep('alice');
    await acceptWarning();
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByLabelText('New password')).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBe('alice'));
    expect(store).not.toHaveBeenCalled();
  });

  it('a throwing credential store never breaks sign-in', async () => {
    const store = vi.fn(() => {
      throw new Error('blocked');
    });
    stubPasswordCredential(store);
    loginMock.mockResolvedValue({ token: 't', user: { username: 'alice' }, remembered: true });
    const { onAuthenticated } = renderLogin();
    const pw = await toPasswordStep('alice');
    await acceptWarning();
    fireEvent.change(pw, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await waitFor(() => expect(store).toHaveBeenCalled());
  });

  // ---- 8 ------------------------------------------------------------------ //
  it('never writes the password to any app storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const idbOpen = vi.fn();
    Object.defineProperty(window, 'indexedDB', {
      value: { open: idbOpen },
      configurable: true,
    });
    const cookieWrites: string[] = [];
    const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: (v: string) => {
        cookieWrites.push(v);
      },
    });
    try {
      loginMock.mockResolvedValue({
        token: 't',
        user: { username: 'alice' },
        remembered: true,
        session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const { onAuthenticated } = renderLogin();
      const pw = await toPasswordStep('alice');
      await acceptWarning();
      fireEvent.change(pw, { target: { value: PASSWORD } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
      // the username WAS remembered …
      await waitFor(() =>
        expect(setItem.mock.calls.some(([k]) => k === REMEMBERED_USERNAME_KEY)).toBe(true),
      );
      for (const [key, value] of setItem.mock.calls) {
        expect(String(key)).not.toContain(PASSWORD);
        expect(String(value)).not.toContain(PASSWORD); // … never the password.
      }
      expect(idbOpen).not.toHaveBeenCalled();
      expect(cookieWrites.some((c) => c.includes(PASSWORD))).toBe(false);
    } finally {
      delete (window as unknown as { indexedDB?: unknown }).indexedDB;
      delete (document as unknown as { cookie?: unknown }).cookie;
      if (cookieDesc) Object.defineProperty(Document.prototype, 'cookie', cookieDesc);
    }
  });

  // ---- 9 ------------------------------------------------------------------ //
  it.each([
    ['absolute_expired', 86_400, 'For your security, you were signed out after 24 hours. Sign in to continue.'],
    ['absolute_expired', 6 * 3600, 'For your security, you were signed out after 6 hours. Sign in to continue.'],
    ['idle_expired', undefined, 'For your security, you were signed out after a period of inactivity. Sign in to continue.'],
    ['revoked', undefined, 'This session was ended from another device or by an administrator. Sign in to continue.'],
    ['tv_mismatch', undefined, 'All of your sessions were signed out. Sign in to continue.'],
  ])('explains a %s session end calmly', async (reason, lifetimeSeconds, copy) => {
    authCtx.current = { sessionEnded: { reason, lifetimeSeconds } };
    renderLogin();
    const username = await screen.findByLabelText('Username');
    // A polite live region, present (empty) from first paint and filled after it,
    // so a screen reader announces it …
    const region = document.querySelector('[data-login-notice-region]');
    expect(region).toHaveAttribute('role', 'status');
    await waitFor(() => expect(region).toHaveTextContent(copy));
    // … and the focused field is described by it.
    await waitFor(() => expect(username).toHaveAccessibleDescription(copy));
  });

  it('explains a remembered session that ran out while the browser was closed', async () => {
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    window.localStorage.setItem(
      REMEMBERED_UNTIL_KEY,
      JSON.stringify({ until: Date.now() - 60_000, lifetime: 86_400 }),
    );
    renderLogin();
    const pw = await screen.findByLabelText('Password');
    expect(document.querySelector('[data-login-notice]')).toHaveTextContent(
      'For your security, you were signed out after 24 hours.',
    );
    // The password field (focused on this step) is described by the notice.
    await waitFor(() =>
      expect(pw).toHaveAccessibleDescription(/you were signed out after 24 hours/),
    );
    // Shown once: the marker is consumed.
    expect(window.localStorage.getItem(REMEMBERED_UNTIL_KEY)).toBeNull();
  });

  it('shows no notice for a fresh visit', async () => {
    renderLogin();
    const username = await screen.findByLabelText('Username');
    expect(document.querySelector('[data-login-notice]')).toBeNull();
    expect(username).not.toHaveAttribute('aria-describedby');
  });

  // ---- 12 ----------------------------------------------------------------- //
  it('has no axe violations with the row and with the warning open', async () => {
    const { container } = renderLogin();
    await toPasswordStep('alice');
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(rememberBox());
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      expect(await axe(dialog)).toHaveNoViolations();
    });
    expect(dialog).toHaveAccessibleName('Keep this device signed in?');
    expect(dialog).toHaveAccessibleDescription(/Only choose this on a device that you alone use/);
    // The bullets are part of the description, not stray content after it.
    expect(dialog).toHaveAccessibleDescription(/shared, public, or kiosk computers/);
    expect(dialog).toHaveAccessibleDescription(/Sensitive actions still ask for your password/);
  });
});

describe('Remember me — transport copy', () => {
  it('tells plain HTTP from HTTPS without secure cookies', () => {
    expect(insecureRememberHint(false)).toBe('Available when the console is served over HTTPS');
    // On HTTPS the page is already secure: only an administrator can fix it.
    expect(insecureRememberHint(true)).toBe(
      'Not available on this connection yet. Ask your administrator.',
    );
    expect(rememberRefusedMessage('insecure_transport', false)).toMatch(/needs HTTPS/);
    expect(rememberRefusedMessage('insecure_transport', true)).not.toMatch(/HTTPS/);
    expect(rememberRefusedMessage('insecure_transport', true)).toMatch(
      /isn't available on this connection yet/,
    );
  });
});
