/**
 * Login render test — covers all FOUR modes of the redesigned login surface.
 *
 * The mode state machine is:
 *   - signin  (default, when setup is complete)
 *   - setup   (when GET /api/setup/status reports needs_user)
 *   - mfa     (when POST /api/auth/login returns requires_mfa + pending_token)
 *   - change  (when the login user is flagged must_change_password)
 *
 * We mount <Login/> inside the Theme + Tooltip providers, mock branding, the setup
 * status, and the SSO providers, and assert each mode renders WITHOUT crashing:
 *   1. signin: identity-first Username → Continue → Password / Back / Sign in,
 *      plus the SSO buttons (google/microsoft icons).
 *   2. setup:  the create-admin title + a password-strength meter once typing.
 *   3. mfa:    driving the password form (requires_mfa) reveals the 6-cell OTP.
 *   4. change: driving the password form (must_change_password) reveals the form.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ---- Mock the typed api client BEFORE importing the component ------------- //
const loginMock = vi.fn();
const setupStatusMock = vi.fn();
const ssoProvidersMock = vi.fn();
const brandingMock = vi.fn();
// The low-level api.post — the OOBE setup client (login.api.ts) posts /setup/account
// and MfaSetupCard posts /auth/mfa/*; capture the calls per-path here.
const postMock = vi.fn();
// Mandated login-phase enrollment (Round 11): the pending-token-gated endpoints.
const enrollSetupMock = vi.fn();
const enrollConfirmMock = vi.fn();

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
      post: (path: string, body?: unknown) => postMock(path, body),
      put: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
      setup: {
        status: () => setupStatusMock(),
      },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: vi.fn().mockResolvedValue({ ok: true }),
        mfa: {
          setup: vi.fn().mockResolvedValue({
            secret: 'ABC123',
            otpauth_uri: 'otpauth://totp/x',
            recovery_codes: ['aaaa-bbbb'],
          }),
          confirm: vi.fn().mockResolvedValue({ ok: true }),
          verify: vi.fn().mockResolvedValue({ user: {} }),
          disable: vi.fn().mockResolvedValue({ ok: true }),
          enrollSetup: (t: string) => enrollSetupMock(t),
          enrollConfirm: (t: string, c: string) => enrollConfirmMock(t, c),
        },
        sso: {
          providers: () => ssoProvidersMock(),
          authorize: vi.fn().mockResolvedValue({ auth_url: 'https://idp/' }),
        },
      },
    },
  };
});

const BASE_BRANDING = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '#2563eb',
  accent_color2: '#9333ea',
  theme: '',
  login_subtitle: 'Welcome back',
  footer_text: 'UNCLASSIFIED',
  support_url: 'https://example.com/help',
  dark_mode_default: false,
};

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';
// The MOCKED ApiError (status, message) — for driving 401 expired-pending paths.
import { ApiError as ApiErrorFromMock } from '@/lib/api';

function renderLogin() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={vi.fn()} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

async function advanceSigninToPassword(username = 'alice') {
  const usernameInput = await screen.findByLabelText('Username');
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();

  fireEvent.change(usernameInput, { target: { value: username } });
  const continueButton = await screen.findByRole('button', { name: 'Continue' });
  expect(continueButton).toBeEnabled();
  fireEvent.click(continueButton);

  const passwordInput = await screen.findByLabelText('Password');
  expect(passwordInput).toHaveAttribute('placeholder', 'Enter your password');
  expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  return { usernameInput, passwordInput };
}

describe('Login — four-mode render', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    brandingMock.mockReset();
    postMock.mockReset();
    brandingMock.mockResolvedValue({ ...BASE_BRANDING });
    postMock.mockResolvedValue({ ok: true });
    // Default: setup complete (→ signin) and two SSO providers enabled.
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    ssoProvidersMock.mockResolvedValue({
      providers: [
        { id: 'g', type: 'google', display_name: 'Google' },
        { id: 'm', type: 'microsoft', display_name: 'Microsoft' },
      ],
    });
  });

  it('renders identity first, then reveals the password step without losing the surrounding shell', async () => {
    const { container } = renderLogin();
    // The first frame asks only who is signing in. The password and final submit
    // stay out of the DOM until the operator commits an identity.
    const username = await screen.findByLabelText('Username');
    expect(username).toHaveAttribute('placeholder', 'Enter your username');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    // The identity surface is one quiet, centred slab with no hero, border,
    // elevation, or workspace chrome around the credential controls.
    const panel = container.querySelector('[data-login-panel]');
    const slab = container.querySelector('[data-login-slab]');
    const slabFrame = slab?.parentElement;
    const content = slab?.firstElementChild;
    const canvas = container.querySelector('[data-login-shell="minimal"]');
    const ambient = container.querySelector('[data-login-ambient-grid]');
    expect(canvas).toHaveClass('login-auth-canvas', 'overflow-x-hidden');
    // Live Mistral geometry: the normal identity state resolves to 480 × 492,
    // with 48 px top/side padding, 96 px bottom padding, and a 384 px control
    // measure. It remains a minimum—not a fixed height—so MFA/setup can grow;
    // narrow screens retain the full-viewport sheet.
    expect(slabFrame).toHaveClass('sm:w-[30rem]', 'sm:max-w-[30rem]');
    expect(slab).toHaveClass(
      'min-h-[100dvh]',
      'max-h-[100dvh]',
      'flex-col',
      'overflow-y-auto',
      'sm:min-h-[30.75rem]',
      'sm:w-[30rem]',
      'sm:px-12',
      'sm:pb-24',
      'sm:pt-12',
    );
    expect(slab).not.toHaveClass('sm:h-[30.75rem]');
    expect(content).toHaveClass('w-full', 'max-w-sm', 'my-auto', 'sm:my-0');
    expect(slab).toHaveClass('login-auth-slab');
    expect(slab).not.toHaveClass('sm:border-x', 'rounded', 'shadow-elev2');
    expect(ambient).toHaveAttribute('aria-hidden', 'true');
    expect(ambient).toHaveAttribute('data-login-ambient-cadence', 'mistral');
    expect(ambient).toHaveClass('pointer-events-none', 'hidden', 'sm:block');
    expect(
      Array.from(ambient?.querySelectorAll<HTMLElement>('[data-login-guide]') ?? []).map(
        (guide) => guide.dataset.loginGuide,
      ).sort(),
    ).toEqual(['bottom', 'left', 'right', 'top']);
    const ambientTiles = Array.from(
      ambient?.querySelectorAll<HTMLElement>('[data-login-ambient-tile]') ?? [],
    );
    expect(ambientTiles).toHaveLength(4);
    expect(ambientTiles.map((tile) => tile.dataset.loginAmbientTile).sort()).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(panel).toHaveAttribute('data-login-surface', 'minimal');
    expect(panel).toHaveClass('rounded-none', 'border-0', 'shadow-none');
    expect(panel).not.toHaveClass('shadow-elev2');
    expect(screen.queryByText('Protected operator access')).not.toBeInTheDocument();
    expect(screen.queryByText('Identity & access')).not.toBeInTheDocument();
    expect(screen.queryByText('Trust path')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(username).toHaveClass('h-12', 'px-3.5');
    expect(username).toHaveClass('text-lg', 'sm:text-base');
    expect(username).toBeRequired();
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Appearance' })).not.toHaveClass('border');
    expect(screen.getByRole('button', { name: 'Use system theme' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The appearance pill names the mode you are IN and switches to the other one.
    // jsdom's matchMedia reports no dark preference, so `system` resolves to light.
    const pill = screen.getByRole('button', { name: 'Light mode — switch to dark mode' });
    expect(pill).toHaveAttribute('data-appearance', 'light');
    fireEvent.click(pill);
    expect(window.localStorage.getItem('soc.theme')).toBe('dark');
    expect(
      screen.getByRole('button', { name: 'Dark mode — switch to light mode' }),
    ).toHaveAttribute('data-appearance', 'dark');
    // Choosing an explicit appearance releases `system`.
    expect(screen.getByRole('button', { name: 'Use system theme' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(document.querySelector('[data-login-shell]')).toHaveAttribute(
      'data-login-theme-palette-settling',
      'true',
    );
    // SSO buttons appear once the providers resolve.
    const googleSso = await screen.findByRole('button', { name: 'Sign in with Google' });
    const microsoftSso = screen.getByRole('button', { name: 'Sign in with Microsoft' });
    expect(googleSso).toHaveClass('h-10');
    expect(microsoftSso).toHaveClass('h-10');
    expect(screen.queryByText('Session activity is audited')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Help & support/ })).toHaveAttribute(
      'href',
      'https://example.com/help',
    );

    // Mistral-style staged disclosure: Continue appears only after identity input.
    fireEvent.change(username, { target: { value: 'alice' } });
    const continueButton = await screen.findByRole('button', { name: 'Continue' });
    // The identity CTA carries the shine treatment and matches the credential
    // fields' full-width h-12 geometry, like every other auth-mode primary here.
    expect(continueButton).toHaveClass('login-shine-button', 'h-12', 'w-full');
    fireEvent.click(continueButton);

    const password = await screen.findByLabelText('Password');
    expect(password).toHaveClass('h-12', 'pl-3.5', 'pr-11');
    expect(password).toHaveClass('text-lg', 'sm:text-base');
    expect(password).toBeRequired();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });

  it('returns from password to identity with the username preserved and focused', async () => {
    renderLogin();
    await advanceSigninToPassword('analyst@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    const username = await screen.findByLabelText('Username');
    expect(username).toHaveValue('analyst@example.com');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await waitFor(() => expect(username).toHaveFocus());
  });

  it('renders the SETUP (create-admin) mode and the password-strength meter', async () => {
    setupStatusMock.mockResolvedValue({ needs_user: true, setup_complete: false });
    renderLogin();
    expect(await screen.findByText('Create your admin account')).toBeInTheDocument();

    // Typing a password surfaces the strength meter label without crashing.
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Str0ng!Passw0rd#2026' } });
    await waitFor(() => expect(screen.getByText('Strong')).toBeInTheDocument());
  });

  it('omits the external support action when no support URL is configured', async () => {
    brandingMock.mockResolvedValue({ ...BASE_BRANDING, support_url: '' });
    renderLogin();
    await screen.findByLabelText('Username');
    expect(screen.queryByRole('link', { name: /Help & support/ })).not.toBeInTheDocument();
  });

  it('transitions to MFA mode and renders the segmented OTP input', async () => {
    loginMock.mockResolvedValue({ requires_mfa: true, pending_token: 'pend-123' });
    renderLogin();
    const { passwordInput } = await advanceSigninToPassword('alice');

    fireEvent.change(passwordInput, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
    // The OTP group renders 6 single-digit cells.
    const group = await screen.findByRole('group', { name: 'Authentication code' });
    expect(group).toBeInTheDocument();
    const cells = screen.getAllByLabelText(/Authentication code digit/);
    expect(cells).toHaveLength(6);
  });

  it('transitions to CHANGE-PASSWORD mode after a must_change login', async () => {
    loginMock.mockResolvedValue({ user: { must_change_password: true } });
    renderLogin();
    const { passwordInput } = await advanceSigninToPassword('bob');

    fireEvent.change(passwordInput, { target: { value: 'oldpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Set a new password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
  });

  it('shows the seeded-default credential hint when seeded_default is set', async () => {
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: true });
    const { container } = renderLogin();
    await screen.findByLabelText('Username');
    await waitFor(() => expect(screen.getByText('Demo credentials')).toBeInTheDocument());
    const hint = container.querySelector('[data-login-demo-hint]');
    expect(hint).not.toHaveClass('border-y');
    expect(hint).not.toHaveAttribute('role', 'alert');
    expect(screen.getByText('Admin')).toHaveClass('font-mono');
    expect(screen.getByText('Admin@123')).toHaveClass('font-mono');
    fireEvent.click(screen.getByRole('button', { name: 'Use demo credentials' }));
    expect(loginMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Password')).toHaveValue('Admin@123');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('keeps the username and returns focus to an announced invalid password after failure', async () => {
    loginMock.mockRejectedValue(new Error('offline'));
    renderLogin();
    const { passwordInput: password } = await advanceSigninToPassword('analyst');

    fireEvent.change(password, { target: { value: 'incorrect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Could not reach the backend. Please try again.')).toBeInTheDocument();
    await waitFor(() => {
      expect(password).toHaveValue('');
      expect(password).toHaveAttribute('aria-invalid', 'true');
      expect(password).toHaveAttribute('aria-describedby', 'login-error');
      expect(password).toHaveFocus();
    });
    expect(loginMock).toHaveBeenCalledWith('analyst', 'incorrect');
  });
});

// --------------------------------------------------------------------------- //
// Round-4 Wave-5: OOBE account-setup (POST /api/setup/account) — the force-set
// strong-password flow that replaces init-admin, with an optional MFA prompt.
// --------------------------------------------------------------------------- //
describe('Login — OOBE account-setup (setup/account)', () => {
  beforeEach(() => {
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    brandingMock.mockReset();
    postMock.mockReset();
    brandingMock.mockResolvedValue({ ...BASE_BRANDING });
    ssoProvidersMock.mockResolvedValue({ providers: [] });
    setupStatusMock.mockResolvedValue({ needs_user: true, setup_complete: false });
    loginMock.mockResolvedValue({ user: {} });
  });

  async function fillSetup(pw: string, confirmPw = pw) {
    await screen.findByText('Create your admin account');
    fireEvent.change(screen.getByLabelText('Admin username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirmPw } });
  }

  it('keeps the create button DISABLED for a weak/short password (client policy gate)', async () => {
    renderLogin();
    await fillSetup('short'); // < 12 chars
    const btn = screen.getByRole('button', { name: /Create admin & sign in/i });
    expect(btn).toBeDisabled();
    // The inline policy hint surfaces the reason.
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
  });

  it('rejects a common password even when long enough', async () => {
    renderLogin();
    await fillSetup('admin12345678'); // long but on the common blocklist
    expect(screen.getByRole('button', { name: /Create admin & sign in/i })).toBeDisabled();
    expect(screen.getByText(/too common/i)).toBeInTheDocument();
  });

  it('POSTs /setup/account (NOT init-admin), then signs in, on a strong password', async () => {
    postMock.mockResolvedValue({ ok: true, username: 'alice', role: 'super_admin', mfa_prompt: false });
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await fillSetup('C0rrectHorseBattery!');
    fireEvent.click(screen.getByRole('button', { name: /Create admin & sign in/i }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    // It hits the NEW writer, not the legacy init-admin path.
    expect(postMock).toHaveBeenCalledWith('setup/account', expect.objectContaining({ username: 'alice' }));
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('alice', 'C0rrectHorseBattery!'));
    await waitFor(() => expect(onAuth).toHaveBeenCalled());
  });

  it('offers the OPTIONAL MFA-enroll step when the server prompts, and lets you skip', async () => {
    postMock.mockResolvedValue({ ok: true, username: 'alice', role: 'super_admin', mfa_prompt: true });
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await fillSetup('C0rrectHorseBattery!');
    fireEvent.click(screen.getByRole('button', { name: /Create admin & sign in/i }));

    // The prompted-optional two-factor step appears (NOT yet authenticated).
    expect(await screen.findByText('Secure your account')).toBeInTheDocument();
    expect(onAuth).not.toHaveBeenCalled();
    // Skipping continues into the console.
    fireEvent.click(screen.getByRole('button', { name: /Skip for now/i }));
    await waitFor(() => expect(onAuth).toHaveBeenCalled());
  });
});

// --------------------------------------------------------------------------- //
// Round-4 Wave-5: login white-label — bounded plain-text copy plus legacy layout
// compatibility. Stored layout values all converge on the same minimal shell.
// --------------------------------------------------------------------------- //
describe('Login — white-label copy + layouts', () => {
  beforeEach(() => {
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    brandingMock.mockReset();
    postMock.mockReset();
    ssoProvidersMock.mockResolvedValue({ providers: [] });
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
  });

  it('renders operator-set headline / body / chips as PLAIN text', async () => {
    brandingMock.mockResolvedValue({
      ...BASE_BRANDING,
      login_headline: 'Welcome to Contoso SOC',
      login_body: 'Investigate faster.',
      login_chips: ['Fast', 'Audited'],
      login_layout: 'split',
      login_illustration: 'radar',
    });
    renderLogin();
    await screen.findByLabelText('Username');
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome to Contoso SOC' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { level: 1, name: 'Welcome back' })).not.toBeInTheDocument();
    expect(screen.getByText('Investigate faster.')).toBeInTheDocument();
    expect(screen.getByText('Fast')).toBeInTheDocument();
    expect(screen.getByText('Audited')).toBeInTheDocument();
  });

  it('does NOT inject markup — angle-bracketed copy renders as literal text', async () => {
    brandingMock.mockResolvedValue({
      ...BASE_BRANDING,
      login_headline: '<img src=x onerror=alert(1)>',
    });
    const { container } = renderLogin();
    await screen.findByLabelText('Username');
    // The string renders as a text node; no <img> element is created from the copy.
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it.each(['split', 'centered', 'full'] as const)(
    'renders the %s layout without crashing (form is reachable)',
    async (layout) => {
      brandingMock.mockResolvedValue({ ...BASE_BRANDING, login_layout: layout });
      const { container } = renderLogin();
      // The sign-in form is reachable in every layout (wait for the async branding
      // fetch to settle, then assert against this render's own container).
      const username = await screen.findByLabelText('Username');
      const shell = container.querySelector(`[data-login-layout="${layout}"]`);
      expect(shell).toHaveAttribute('data-login-shell', 'minimal');
      expect(container.querySelector('#login-username')).not.toBeNull();
      expect(container.querySelector('#login-password')).toBeNull();

      fireEvent.change(username, { target: { value: 'analyst' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    },
  );
});

// --------------------------------------------------------------------------- //
// Round 11: MANDATED MFA enrollment DURING login. When the login response carries
// `mfa_enrollment_required` (required-but-unenrolled), the user completes TOTP
// enrollment inside the login itself — pending-token-gated enroll-setup/confirm —
// and confirm success IS the completed login. There is NO skip affordance.
// --------------------------------------------------------------------------- //
describe('Login — mandated MFA enrollment during login', () => {
  beforeEach(() => {
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    brandingMock.mockReset();
    postMock.mockReset();
    enrollSetupMock.mockReset();
    enrollConfirmMock.mockReset();
    brandingMock.mockResolvedValue({ ...BASE_BRANDING });
    ssoProvidersMock.mockResolvedValue({ providers: [] });
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    loginMock.mockResolvedValue({
      requires_mfa: true,
      mfa_enrollment_required: true,
      pending_token: 'pend-enroll-1',
    });
    enrollSetupMock.mockResolvedValue({
      secret: 'ENROLLSECRET234567',
      otpauth_uri: 'otpauth://totp/Acme%20SOC:alice?secret=ENROLLSECRET234567',
      recovery_codes: ['1111-2222', '3333-4444'],
    });
    enrollConfirmMock.mockResolvedValue({
      token: 't',
      user: { username: 'alice', role: 'analyst_tier1', must_change_password: false, mfa_enabled: true },
    });
  });

  async function driveToEnroll() {
    const { passwordInput } = await advanceSigninToPassword('alice');
    fireEvent.change(passwordInput, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('Set up two-factor authentication'),
    ).toBeInTheDocument();
  }

  it('renders the auto-started setup step with recovery codes and NO skip affordance', async () => {
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await driveToEnroll();

    // The plain explanation of WHY this step is mandatory.
    expect(
      screen.getByText(/administrator requires multi-factor authentication/i),
    ).toBeInTheDocument();
    // Entering the mode unmounts the sign-in form — focus moves to the mode
    // HEADING (tabIndex=-1 + programmatic focus) so SR/keyboard users land on
    // "Set up two-factor authentication" instead of dropping to <body>, and the
    // heading's describedby hands them the requirement explanation.
    const heading = screen.getByRole('heading', {
      level: 1,
      name: 'Set up two-factor authentication',
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute('aria-describedby', 'login-mode-description');
    expect(document.getElementById('login-mode-description')?.textContent).toMatch(
      /administrator requires multi-factor authentication/i,
    );
    // The setup call was rerouted to the pending-token-gated enroll endpoint.
    await waitFor(() => expect(enrollSetupMock).toHaveBeenCalledWith('pend-enroll-1'));
    // QR-fallback secret + otpauth URI + recovery codes all render at the setup step.
    expect(await screen.findByText('ENROLLSECRET234567')).toBeInTheDocument();
    expect(screen.getByText(/otpauth:\/\/totp\/Acme%20SOC:alice/)).toBeInTheDocument();
    expect(screen.getByText('1111-2222')).toBeInTheDocument();
    expect(screen.getByText('3333-4444')).toBeInTheDocument();
    // NO way to skip into the console; the only exits are enrollment or sign-in.
    expect(screen.queryByRole('button', { name: /skip/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to sign in' })).toBeInTheDocument();
    expect(onAuth).not.toHaveBeenCalled();
  });

  it('confirm success is a COMPLETED login (session minted server-side)', async () => {
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await driveToEnroll();
    await screen.findByText('ENROLLSECRET234567');

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    // Confirm success destroys the one-time recovery codes → the explicit
    // saved-codes acknowledgment gates the submit.
    fireEvent.click(screen.getByLabelText(/saved my recovery codes/i));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    await waitFor(() =>
      expect(enrollConfirmMock).toHaveBeenCalledWith('pend-enroll-1', '123456'),
    );
    await waitFor(() => expect(onAuth).toHaveBeenCalled());
  });

  it('routes into the forced password change when the fresh session still must change it', async () => {
    enrollConfirmMock.mockResolvedValue({
      token: 't',
      user: { username: 'alice', role: 'analyst_tier1', must_change_password: true, mfa_enabled: true },
    });
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await driveToEnroll();
    await screen.findByText('ENROLLSECRET234567');

    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByLabelText(/saved my recovery codes/i));
    fireEvent.click(screen.getByRole('button', { name: 'Verify & sign in' }));

    expect(await screen.findByText('Set a new password')).toBeInTheDocument();
    expect(onAuth).not.toHaveBeenCalled();
  });

  it('returns to sign-in with a clear message when the pending token has expired', async () => {
    enrollSetupMock.mockRejectedValue(
      new ApiErrorFromMock(401, 'invalid or expired pending session'),
    );
    renderLogin();
    const { passwordInput } = await advanceSigninToPassword('alice');
    fireEvent.change(passwordInput, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // The expired pending is handled gracefully: a plain explanation + the password
    // step again (identity preserved) — never a dead-end or a silent failure.
    expect(await screen.findByText(/setup session expired/i)).toBeInTheDocument();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(enrollSetupMock).toHaveBeenCalledWith('pend-enroll-1');
  });
});
