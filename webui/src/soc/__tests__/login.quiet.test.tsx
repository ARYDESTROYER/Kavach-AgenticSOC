/**
 * The quiet sign-in page (Round 16 WP04, [login] R2 to R11 and R15).
 *
 *  - Nothing moves or re-renders after the first paint: no timers, no ambient motion.
 *  - Continue is always there; an empty submit names the field and keeps the step.
 *  - Single sign-on buttons carry their name as visible text and stack full width.
 *  - A field error renders inline, under its field, announced and linked to it.
 *  - "Welcome back" greets only an account this device remembers.
 *  - The six code cells submit on their own, once.
 *  - A refused recovery code, forced change or setup returns focus to its field (the
 *    field was disabled while the request ran, so the page had taken the focus).
 *  - GET /api/branding is sent once on a cold load, and again after a sign-out or
 *    when the branding is older than 30 s.
 *  - "Forgot password?" says what to do; axe finds nothing on the page.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { brandingMock, setupStatusMock, ssoMock, loginMock, verifyMock, postMock, changeMock } =
  vi.hoisted(() => ({
    brandingMock: vi.fn(),
    setupStatusMock: vi.fn(),
    ssoMock: vi.fn(),
    loginMock: vi.fn(),
    verifyMock: vi.fn(),
    postMock: vi.fn(),
    changeMock: vi.fn(),
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
      post: (path: string, body: unknown) => postMock(path, body),
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
        },
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
      },
    },
  };
});

import { ThemeProvider, BRANDING_FRESH_MS } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';
import { ApiError as MockApiError } from '@/lib/api';

const BRANDING = { org_name: 'Acme SOC', product_name: 'Triage', login_subtitle: '' };

function renderLogin(onAuthenticated = vi.fn(), onRender?: React.ProfilerOnRenderCallback) {
  const page = <Login onAuthenticated={onAuthenticated} />;
  return render(
    <ThemeProvider>
      <TooltipProvider>
        {onRender ? (
          <React.Profiler id="login" onRender={onRender}>
            {page}
          </React.Profiler>
        ) : (
          page
        )}
      </TooltipProvider>
    </ThemeProvider>,
  );
}

async function toPasswordStep(name = 'alice') {
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return screen.findByLabelText('Password');
}

async function toMfaStep() {
  loginMock.mockResolvedValue({ requires_mfa: true, pending_token: 'pend-1' });
  const pw = await toPasswordStep();
  fireEvent.change(pw, { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('group', { name: 'Authentication code' });
  return screen.getAllByLabelText(/Authentication code digit/) as HTMLInputElement[];
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  document.documentElement.classList.remove('dark');
  brandingMock.mockReset().mockResolvedValue({ ...BRANDING });
  setupStatusMock.mockReset().mockResolvedValue({ setup_complete: true, seeded_default: false });
  ssoMock.mockReset().mockResolvedValue({ providers: [] });
  loginMock.mockReset();
  verifyMock.mockReset();
  postMock.mockReset().mockResolvedValue({});
  changeMock.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Login: nothing moves after the first paint (R2)', () => {
  it('schedules no timer and renders nothing more over 60 seconds', async () => {
    // A fake clock from before the first render, so any timer the page arms (the
    // retired ambient tiles re-armed theirs forever) is one this test controls.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let commits = 0;
    const { container } = renderLogin(vi.fn(), () => {
      commits += 1;
    });
    await screen.findByLabelText('Username');
    // Let the settled probes finish committing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const settled = commits;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(commits).toBe(settled);
    expect(vi.getTimerCount()).toBe(0);
    // No ambient layer of any kind.
    expect(container.querySelector('[data-login-ambient-grid], [data-login-ambient-tile]')).toBeNull();
  });
});

describe('Login: the identity step (R5, R8, R9)', () => {
  it('names an empty username on submit, focuses it, and stays on the step', async () => {
    renderLogin();
    const username = await screen.findByLabelText('Username');
    // Enter on the empty field submits the form.
    fireEvent.submit(username.closest('form')!);
    const message = await screen.findByText('Enter your username.');
    expect(message.closest('[role="alert"]')).toHaveAttribute('id', 'login-error');
    expect(username).toHaveFocus();
    expect(username).toHaveAttribute('aria-invalid', 'true');
    expect(username).toHaveAttribute('aria-describedby', 'login-error');
    expect(screen.queryByLabelText('Password')).toBeNull();
    // The error sits in the field's own group, under the field, not at the top.
    expect(username.closest('.space-y-2')).toContainElement(message);
    // Typing clears it.
    fireEvent.change(username, { target: { value: 'a' } });
    expect(screen.queryByText('Enter your username.')).toBeNull();
    expect(username).not.toHaveAttribute('aria-invalid');
  });

  it('renders a failed sign-in under the password field, not in a top banner', async () => {
    loginMock.mockRejectedValue(new MockApiError(401, 'Invalid username or password.'));
    renderLogin();
    const pw = await toPasswordStep();
    fireEvent.change(pw, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const message = await screen.findByText('Invalid username or password.');
    expect(pw.closest('.space-y-2')).toContainElement(message);
    expect(message.closest('[role="alert"]')).toHaveClass('login-field-error', 'text-critical-text');
    expect(document.querySelector('[data-login-page-error]')).toBeNull();
  });

  it('greets only a remembered account with "Welcome back"', async () => {
    window.localStorage.setItem('soc.login.rememberedUsername', 'alice');
    renderLogin();
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    // Forgetting the device starts over and names the organization instead.
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Acme SOC' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveValue('');
  });

  it('says what to do about a forgotten password (R15)', async () => {
    renderLogin();
    await toPasswordStep();
    const forgot = screen.getByRole('button', { name: 'Forgot password?' });
    expect(forgot).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(forgot);
    expect(forgot).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Ask an administrator to reset it. There is no self-service reset.')).toBeInTheDocument();
  });
});

describe('Login: single sign-on buttons (R6)', () => {
  it('stacks every provider full width with its name as visible text', async () => {
    ssoMock.mockResolvedValue({
      providers: [
        { id: 'g', type: 'google', display_name: 'Google' },
        { id: 'm', type: 'microsoft', display_name: '' },
        { id: 'okta', type: 'oidc', display_name: 'Contoso Okta' },
      ],
    });
    renderLogin();
    const group = await screen.findByRole('group', { name: 'Single sign-on' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Sign in with Google',
      'Sign in with Microsoft',
      'Sign in with Contoso Okta',
    ]);
    for (const button of buttons) expect(button).toHaveClass('w-full', 'h-11');
    // The divider reads "or" and sits above the providers.
    expect(screen.getByText('or')).toBeInTheDocument();
  });
});

describe('Login: the code cells submit on their own, once (R10)', () => {
  it('draws six visible cells with the Console field edge', async () => {
    renderLogin();
    const cells = await toMfaStep();
    expect(cells).toHaveLength(6);
    // Raw inputs get no border from the preflight; on the dark canvas the field fill
    // equals the canvas, so without an edge only the focused cell would show.
    for (const cell of cells) expect(cell).toHaveClass('border', 'border-input', 'h-12');
  });

  it('verifies exactly once when the sixth digit is typed', async () => {
    let finish: (value: unknown) => void = () => {};
    verifyMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const onAuthenticated = vi.fn();
    renderLogin(onAuthenticated);
    const cells = await toMfaStep();
    '123456'.split('').forEach((digit, i) => fireEvent.change(cells[i], { target: { value: digit } }));
    await waitFor(() => expect(verifyMock).toHaveBeenCalledTimes(1));
    expect(verifyMock).toHaveBeenCalledWith('pend-1', '123456');
    // The fallback button is busy, and pressing it again sends nothing.
    fireEvent.click(screen.getByRole('button', { name: /Verifying/ }));
    expect(verifyMock).toHaveBeenCalledTimes(1);
    await act(async () => finish({ user: {} }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  });

  it('verifies exactly once for a pasted code', async () => {
    verifyMock.mockReturnValue(new Promise(() => undefined));
    renderLogin();
    const cells = await toMfaStep();
    fireEvent.paste(cells[0], { clipboardData: { getData: () => '654321' } });
    await waitFor(() => expect(verifyMock).toHaveBeenCalledTimes(1));
    expect(verifyMock).toHaveBeenCalledWith('pend-1', '654321');
  });

  it('clears the cells and focuses the first one after a wrong code', async () => {
    verifyMock.mockRejectedValue(new MockApiError(401, 'Invalid code.'));
    renderLogin();
    const cells = await toMfaStep();
    '111111'.split('').forEach((digit, i) => fireEvent.change(cells[i], { target: { value: digit } }));
    expect(await screen.findByText('Invalid code.')).toBeInTheDocument();
    const fresh = screen.getAllByLabelText(/Authentication code digit/) as HTMLInputElement[];
    expect(fresh.map((c) => c.value).join('')).toBe('');
    await waitFor(() => expect(fresh[0]).toHaveFocus());
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });
});

describe('Login: a refused code or password keeps the keyboard in place', () => {
  it('returns focus to the recovery field, marked invalid and described by the error', async () => {
    let reject: (reason: unknown) => void = () => {};
    verifyMock.mockReturnValue(new Promise((_resolve, fail) => (reject = fail)));
    renderLogin();
    await toMfaStep();
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    const field = (await screen.findByLabelText('Recovery code')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'AAAA-BBBB' } });
    field.focus();
    fireEvent.submit(field.closest('form')!);
    // The field is disabled while the code is checked, and a browser then moves focus
    // off it. jsdom keeps it there, so move it away as a browser would.
    await waitFor(() => expect(field).toBeDisabled());
    screen.getByRole('button', { name: 'Use system theme' }).focus();
    expect(field).not.toHaveFocus();
    await act(async () => reject(new MockApiError(401, 'Invalid code.')));
    expect(await screen.findByText('Invalid code.')).toBeInTheDocument();
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'login-error');
    expect(verifyMock).toHaveBeenCalledWith('pend-1', 'AAAA-BBBB');
  });

  it('returns focus to the new password after a refused forced change', async () => {
    loginMock.mockResolvedValue({ user: { username: 'alice', must_change_password: true } });
    let reject: (reason: unknown) => void = () => {};
    changeMock.mockReturnValue(new Promise((_resolve, fail) => (reject = fail)));
    renderLogin();
    const pw = await toPasswordStep();
    fireEvent.change(pw, { target: { value: 'old-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const next = (await screen.findByLabelText('New password')) as HTMLInputElement;
    fireEvent.change(next, { target: { value: 'abcdefgh1' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'abcdefgh1' } });
    fireEvent.submit(next.closest('form')!);
    await waitFor(() => expect(next).toBeDisabled());
    screen.getByRole('button', { name: 'Use system theme' }).focus();
    await act(async () => reject(new MockApiError(400, 'The new password is too weak.')));
    expect(await screen.findByText('The new password is too weak.')).toBeInTheDocument();
    await waitFor(() => expect(next).toHaveFocus());
  });

  it('returns focus to the password after a refused first-admin setup', async () => {
    setupStatusMock.mockResolvedValue({ setup_complete: false, needs_user: true, seeded_default: false });
    let reject: (reason: unknown) => void = () => {};
    postMock.mockReturnValue(new Promise((_resolve, fail) => (reject = fail)));
    renderLogin();
    fireEvent.change(await screen.findByLabelText('Admin username'), { target: { value: 'chief' } });
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Long-and-unusual-42' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'Long-and-unusual-42' } });
    fireEvent.click(screen.getByRole('button', { name: /Create admin/ }));
    await waitFor(() => expect(pw).toBeDisabled());
    screen.getByRole('button', { name: 'Use system theme' }).focus();
    await act(async () => reject(new MockApiError(400, 'That password is not allowed.')));
    expect(await screen.findByText('That password is not allowed.')).toBeInTheDocument();
    await waitFor(() => expect(pw).toHaveFocus());
    expect(postMock).toHaveBeenCalledWith('setup/account', expect.objectContaining({ username: 'chief' }));
  });
});

describe('Login: one branding request on a cold load (R11)', () => {
  function SignInAndOut() {
    const [signedIn, setSignedIn] = React.useState(false);
    return (
      <ThemeProvider>
        <TooltipProvider>
          {signedIn ? (
            <button type="button" onClick={() => setSignedIn(false)}>
              Sign out
            </button>
          ) : (
            <Login onAuthenticated={() => setSignedIn(true)} />
          )}
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  it('sends GET /api/branding once on a cold load and again after a sign-out', async () => {
    loginMock.mockResolvedValue({ user: {} });
    render(<SignInAndOut />);
    const pw = await toPasswordStep();
    expect(brandingMock).toHaveBeenCalledTimes(1);
    fireEvent.change(pw, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(brandingMock).toHaveBeenCalledTimes(2);
  });

  it('fetches again when the boot fetch is older than 30 seconds', async () => {
    function Later() {
      const [show, setShow] = React.useState(false);
      return (
        <ThemeProvider>
          <TooltipProvider>
            {show ? (
              <Login onAuthenticated={vi.fn()} />
            ) : (
              <button type="button" onClick={() => setShow(true)}>
                Show sign-in
              </button>
            )}
          </TooltipProvider>
        </ThemeProvider>
      );
    }
    render(<Later />);
    await waitFor(() => expect(brandingMock).toHaveBeenCalledTimes(1));
    // Let the provider's fetch settle before the clock moves.
    await act(async () => {
      await Promise.resolve();
    });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + BRANDING_FRESH_MS + 1_000);
    fireEvent.click(screen.getByRole('button', { name: 'Show sign-in' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(brandingMock).toHaveBeenCalledTimes(2);
  });
});

describe('Login: accessibility', () => {
  it('has no axe violations on the identity and password steps', async () => {
    ssoMock.mockResolvedValue({ providers: [{ id: 'g', type: 'google', display_name: 'Google' }] });
    const { container } = renderLogin();
    await screen.findByRole('button', { name: 'Sign in with Google' });
    await act(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
    await toPasswordStep();
    await act(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
