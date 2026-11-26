/**
 * Sign-in polish (Round 16 acceptance fixes, package FXC).
 *
 *  - The column is top aligned at every width, so a step change or an error grows the
 *    page downward and never moves the field being retyped.
 *  - The mandated two-factor heading takes focus with no browser focus box.
 *  - A wide organization logo keeps its 40px height.
 *  - The forced change trims like the server and never shows the server's own text.
 *  - Verify and Set password stay enabled and explain an empty submit under the field.
 *  - Phone targets are 44px tall; the Back and Use text ends on the column edge.
 *  - One 16px rhythm between rows in every step.
 *  - An unnamed Google provider reads "Sign in with Google", and a long name wraps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { brandingMock, setupStatusMock, ssoMock, loginMock, verifyMock, changeMock, enrollSetupMock } =
  vi.hoisted(() => ({
    brandingMock: vi.fn(),
    setupStatusMock: vi.fn(),
    ssoMock: vi.fn(),
    loginMock: vi.fn(),
    verifyMock: vi.fn(),
    changeMock: vi.fn(),
    enrollSetupMock: vi.fn(),
  }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status: number;
    constructor(status = 0, message = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getBranding: () => brandingMock(),
      get: ok({}),
      post: ok({}),
      put: ok({}),
      del: ok({}),
      setup: { status: () => setupStatusMock() },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: (current: string, next: string) => changeMock(current, next),
        mfa: {
          setup: ok({}),
          confirm: ok({}),
          verify: (t: string, c: string) => verifyMock(t, c),
          disable: ok({}),
          enrollSetup: (t: string) => enrollSetupMock(t),
          enrollConfirm: ok({}),
        },
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
      },
    },
  };
});

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';
import { ApiError as MockApiError } from '@/lib/api';

const BRANDING = { org_name: 'Acme SOC', product_name: 'Triage', login_subtitle: '' };

function renderLogin() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={vi.fn()} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

async function toPasswordStep(name = 'alice') {
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return screen.findByLabelText('Password');
}

async function signIn() {
  const pw = await toPasswordStep();
  fireEvent.change(pw, { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

async function toChangeStep() {
  loginMock.mockResolvedValue({ user: { username: 'alice', must_change_password: true } });
  await signIn();
  return (await screen.findByLabelText('New password')) as HTMLInputElement;
}

async function toMfaStep() {
  loginMock.mockResolvedValue({ requires_mfa: true, pending_token: 'pend-1' });
  await signIn();
  await screen.findByRole('group', { name: 'Authentication code' });
}

const ENROLLMENT = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  otpauth_uri: 'otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Acme',
  recovery_codes: ['AAAA-1111', 'BBBB-2222'],
};

async function toEnrollStep() {
  enrollSetupMock.mockResolvedValue(ENROLLMENT);
  loginMock.mockResolvedValue({ requires_mfa: true, mfa_enrollment_required: true, pending_token: 'pend-2' });
  await signIn();
  return (await screen.findByLabelText('3. Enter the 6-digit code to finish')) as HTMLInputElement;
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  document.documentElement.classList.remove('dark');
  brandingMock.mockReset().mockResolvedValue({ ...BRANDING });
  setupStatusMock.mockReset().mockResolvedValue({ setup_complete: true, seeded_default: true });
  ssoMock.mockReset().mockResolvedValue({ providers: [] });
  loginMock.mockReset();
  verifyMock.mockReset();
  changeMock.mockReset().mockResolvedValue({ ok: true });
  enrollSetupMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Login: the column never jumps (desktop-column-jumps)', () => {
  it('top aligns the column at every width instead of centring it', async () => {
    const { container } = renderLogin();
    // The loading shell and the form share one frame.
    const shell = container.querySelector('main') as HTMLElement;
    expect(shell.className).not.toMatch(/justify-center/);
    await screen.findByLabelText('Username');
    const main = container.querySelector('main') as HTMLElement;
    expect(main.className).not.toMatch(/\bsm:justify-center\b|\bsm:py-16\b/);
    expect(main).toHaveClass('pt-[max(4rem,12dvh)]', 'sm:pt-[max(4rem,18dvh)]', 'pb-16');
  });
});

describe('Login: mandated two-factor setup (enroll-heading-focus-box, enroll-step-off-grammar)', () => {
  it('focuses the heading with no browser focus box, and never an always-on outline', async () => {
    renderLogin();
    await toEnrollStep();
    const heading = screen.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' });
    await waitFor(() => expect(heading).toHaveFocus());
    // `outline-0` only sets the width: Chromium still draws `outline: auto` at
    // :focus-visible. `outline-none` is a permanent transparent outline that forced
    // colours paints. `[outline:none]` sets the style itself, so nothing is drawn.
    expect(heading).toHaveClass('[outline:none]');
    expect(heading.className).not.toMatch(/\boutline-0\b|\boutline-none\b/);
  });

  it('uses the sign-in field and button grammar and keeps the way back left aligned', async () => {
    renderLogin();
    const field = await toEnrollStep();
    expect(field).toHaveClass('h-11', 'text-lg', 'sm:text-base');
    expect(field.className).not.toMatch(/max-w-\[160px\]/);
    const submit = screen.getByRole('button', { name: 'Verify and sign in' });
    expect(submit).toHaveClass('h-11', 'w-full');
    // The secret wraps instead of being cut off under "Enter the secret by hand".
    const secret = screen.getByText(ENROLLMENT.secret);
    expect(secret).toHaveClass('break-all');
    expect(secret).not.toHaveClass('truncate');
    // The QR code sits centred above the text, never beside it in the 400px column.
    const row = secret.closest('.flex-col') as HTMLElement;
    expect(row.className).not.toMatch(/sm:flex-row/);
    expect(row.firstElementChild).toHaveClass('self-center');
    const back = screen.getByRole('button', { name: 'Back to sign in' });
    expect(back.closest('.text-center')).toBeNull();
    expect(back).toHaveClass('min-h-11', 'sm:min-h-0');
  });
});

describe('Login: the organization logo (wide-logo-shrinks)', () => {
  it('keeps a wide wordmark at its 40px height instead of a 40px square', async () => {
    brandingMock.mockResolvedValue({ ...BRANDING, logo_data_url: 'data:image/png;base64,AAAA' });
    const { container } = renderLogin();
    await screen.findByLabelText('Username');
    const logo = container.querySelector('[data-login-identity-pane] img') as HTMLImageElement;
    expect(logo).toHaveClass('h-10', 'w-auto', 'max-w-48', 'object-contain', 'object-left');
    expect(logo).not.toHaveClass('w-10');
  });
});

describe('Login: forced password change (forced-change-raw-server-text, disabled-submit-inconsistent)', () => {
  it('counts the new password as the server does, without its spaces', async () => {
    renderLogin();
    const next = await toChangeStep();
    fireEvent.change(next, { target: { value: '        ' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: '        ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password & continue' }));
    expect(await screen.findByText('New password must be at least 8 characters.')).toBeInTheDocument();
    expect(changeMock).not.toHaveBeenCalled();
  });

  it('maps the server length rule to the fixed sentence, never its lower-case text', async () => {
    changeMock.mockRejectedValue(new MockApiError(400, 'new password must be at least 8 characters'));
    renderLogin();
    const next = await toChangeStep();
    fireEvent.change(next, { target: { value: 'abcdefgh1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'abcdefgh1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password & continue' }));
    expect(await screen.findByText('New password must be at least 8 characters.')).toBeInTheDocument();
    expect(screen.queryByText('new password must be at least 8 characters')).toBeNull();
  });

  it('shows one fixed sentence for any other 400', async () => {
    changeMock.mockRejectedValue(new MockApiError(400, 'current password is incorrect'));
    renderLogin();
    const next = await toChangeStep();
    fireEvent.change(next, { target: { value: 'abcdefgh1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'abcdefgh1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password & continue' }));
    expect(await screen.findByText('Could not change the password.')).toBeInTheDocument();
    expect(screen.queryByText(/current password is incorrect/)).toBeNull();
  });

  it('keeps Set password enabled and explains an empty submit under the field', async () => {
    renderLogin();
    const next = await toChangeStep();
    const submit = screen.getByRole('button', { name: 'Set password & continue' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    const message = await screen.findByText('Enter a new password.');
    // Under the fields, not in an alert above the form: nothing above the field moves.
    expect(message.closest('[role="alert"]')).toHaveAttribute('id', 'login-error');
    expect(next.closest('form')).toContainElement(message);
    expect(next).toHaveAttribute('aria-invalid', 'true');
    expect(next).toHaveAttribute('aria-describedby', 'login-error');
    expect(next).toHaveFocus();
    expect(changeMock).not.toHaveBeenCalled();
  });
});

describe('Login: the code step (disabled-submit-inconsistent)', () => {
  it('keeps Verify enabled and explains an empty submit under the code', async () => {
    renderLogin();
    await toMfaStep();
    const verify = screen.getByRole('button', { name: 'Verify and continue' });
    expect(verify).toBeEnabled();
    fireEvent.click(verify);
    expect(await screen.findByText('Enter the 6-digit code.')).toBeInTheDocument();
    expect(verifyMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Authentication code digit 1')).toHaveFocus());
  });

  it('names a recovery code on the recovery field', async () => {
    renderLogin();
    await toMfaStep();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    const field = await screen.findByLabelText('Recovery code');
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText('Enter a recovery code.')).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe('Login: phone targets and edges (small-phone-targets, ghost-button-edges)', () => {
  it('gives every text link and small button a 44px phone target', async () => {
    renderLogin();
    await screen.findByLabelText('Username');
    for (const name of ['Use system theme', 'Light theme', 'Dark theme']) {
      expect(screen.getByRole('button', { name })).toHaveClass('h-11', 'w-11', 'sm:h-7', 'sm:w-7');
    }
    const use = screen.getByRole('button', { name: 'Use demo credentials' });
    expect(use).toHaveClass('h-11', 'sm:h-8', '-mr-2');
    await toPasswordStep();
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveClass('h-11', 'sm:h-8', '-mr-2');
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveClass('min-h-11', 'sm:min-h-0');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveClass('h-11', 'w-11', 'sm:h-9', 'sm:w-9');
  });

  it('gives the code step links a 44px phone target', async () => {
    renderLogin();
    await toMfaStep();
    for (const name of ['Use a recovery code', 'Back to sign in']) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-11', 'sm:min-h-0');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    expect(
      await screen.findByRole('button', { name: 'Where can I find my recovery codes?' }),
    ).toHaveClass('min-h-11', 'sm:min-h-0');
  });
});

describe('Login: one rhythm (step-rhythm-off-grid)', () => {
  it('spaces the code and forced-change forms on the 16px grid', async () => {
    const { container } = renderLogin();
    await toMfaStep();
    expect(container.querySelector('form')).toHaveClass('space-y-4');
    expect(container.innerHTML).not.toMatch(/space-y-5|mb-5|mt-3\b/);
  });

  it('puts the single sign-on Remember me row 16px under Continue', async () => {
    setupStatusMock.mockResolvedValue({
      setup_complete: true,
      seeded_default: false,
      remember_me: { enabled: true, duration_seconds: 86_400, idle_seconds: 0, insecure_blocked: false },
    });
    ssoMock.mockResolvedValue({ providers: [{ id: 'g', type: 'google', display_name: '' }] });
    const { container } = renderLogin();
    const box = await screen.findByRole('checkbox', { name: 'Remember me' });
    expect(box.closest('.mt-4')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/\bmt-3\b|mb-5/);
  });
});

describe('Login: single sign-on names (sso-label-raw-id)', () => {
  it('names an unnamed provider by its type and lets a long name wrap', async () => {
    ssoMock.mockResolvedValue({
      providers: [
        { id: 'google', type: 'google', display_name: '' },
        { id: 'entra', type: 'microsoft', display_name: '' },
        { id: 'okta', type: 'generic', display_name: 'Northwind Okta Workforce Identity Cloud' },
      ],
    });
    renderLogin();
    const group = await screen.findByRole('group', { name: 'Single sign-on' });
    expect(within(group).getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument();
    const long = within(group).getByRole('button', {
      name: 'Sign in with Northwind Okta Workforce Identity Cloud',
    });
    expect(long).toHaveClass('whitespace-normal', 'min-h-11', 'h-auto');
    expect(long.querySelector('.truncate')).toBeNull();
  });
});
