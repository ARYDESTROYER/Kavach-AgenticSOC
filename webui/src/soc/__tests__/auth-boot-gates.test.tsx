/**
 * Round-6 auth-login fixes for the Boot gate (App.tsx) + the RBAC provider (auth.tsx).
 *
 * Covers:
 *  - finding 0: an authenticated user still flagged must_change_password (e.g. after a
 *    reload / deep-link) is held on the Login screen and NOT dropped into the console.
 *  - finding 1: a FAILED GET /api/auth/me shows a "can't reach the backend" retry gate
 *    instead of failing OPEN into a broken console.
 *  - finding 8: a FAILED read of the effective grants (GET /api/account/permissions,
 *    the one source since Round 14 FX7e) for an authenticated principal is
 *    deny-by-default (super_admin excepted), not allow-all.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { loginMock, meMock, permissionsMock, ssoMock, setupPublicStatusMock, setupStatusMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  meMock: vi.fn(),
  permissionsMock: vi.fn(),
  ssoMock: vi.fn(),
  setupPublicStatusMock: vi.fn(),
  setupStatusMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status = 0, message = '', body: unknown = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      get: ok({}),
      post: ok({}),
      put: ok({}),
      del: ok({}),
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
        footer_text: '', support_url: '', dark_mode_default: false,
      }),
      setupStatus: () => setupStatusMock(),
      listConnectors: ok({ connectors: [] }),
      listSources: ok({ sources: [] }),
      auth: {
        login: (...args: unknown[]) => loginMock(...args),
        me: () => meMock(),
        logout: ok({ ok: true }),
        changePassword: ok({ ok: true }),
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
        mfa: { setup: ok({}), confirm: ok({}), verify: ok({}), disable: ok({}) },
      },
      account: { permissions: () => permissionsMock() },
      setup: { status: () => setupPublicStatusMock() },
    },
  };
});

import { App } from '../App';
import { AuthProvider, useAuth } from '../auth';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  loginMock.mockReset();
  meMock.mockReset();
  permissionsMock.mockReset();
  ssoMock.mockReset();
  setupPublicStatusMock.mockReset();
  setupStatusMock.mockReset();
  ssoMock.mockResolvedValue({ providers: [] });
  setupPublicStatusMock.mockResolvedValue({ setup_complete: true, needs_user: false });
  setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
  permissionsMock.mockResolvedValue({
    authenticated: true, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {},
  });
});

describe('Boot gate — must-change-password on reload (finding 0)', () => {
  it('holds an authenticated must_change_password user on Login, not the console', async () => {
    meMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'admin', role: 'super_admin', must_change_password: true },
    });
    render(<App />);
    // The Login surface renders (the forced-change flow re-resolves after re-auth)…
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    // …and the console (page hero) is NOT rendered — the rotation is not skipped.
    expect(screen.queryByTestId('page-hero')).toBeNull();
  });
});

describe('Boot gate — failed /api/auth/me (finding 1)', () => {
  it('shows a retry gate instead of failing open into the console', async () => {
    meMock.mockRejectedValue(new Error('network down'));
    render(<App />);
    expect(await screen.findByText(/can't reach the backend/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // Neither the console nor the login form leaked through.
    expect(screen.queryByTestId('page-hero')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});

describe('Boot gate — failed /api/setup/status', () => {
  it('stays fail-closed and retries instead of opening the console', async () => {
    meMock.mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    setupStatusMock.mockRejectedValueOnce(new Error('setup status unavailable'));
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText(/can’t verify setup state/i)).toBeInTheDocument();
    expect(screen.queryByTestId('page-hero')).toBeNull();

    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/can’t verify setup state/i)).toBeNull());
    expect(setupStatusMock).toHaveBeenCalledTimes(2);
  });

  it('ignores an older setup failure after a newer post-auth check succeeds', async () => {
    const stale = deferred<{ setup_complete: boolean; configured: Record<string, boolean> }>();
    const current = deferred<{ setup_complete: boolean; configured: Record<string, boolean> }>();
    setupStatusMock
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)
      // The successful result opens the first-run Wizard, which performs its own status load.
      .mockResolvedValue({ setup_complete: false, configured: {} });
    meMock
      .mockResolvedValueOnce({ auth_enabled: true, authenticated: false, user: null })
      .mockResolvedValue({
        auth_enabled: true,
        authenticated: true,
        user: { username: 'admin', role: 'super_admin', must_change_password: false },
      });
    loginMock.mockResolvedValue({
      requires_mfa: false,
      user: { username: 'admin', role: 'super_admin', must_change_password: false },
    });
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText(/username/i), 'admin');
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/^password/i), 'CorrectHorseBatteryStaple!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // onAuthenticated() and the auth-state effect both probe setup. Resolve the newest
    // result first, then reject the older request to reproduce the out-of-order race.
    await waitFor(() => expect(setupStatusMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      current.resolve({ setup_complete: false, configured: {} });
      await current.promise;
    });
    expect(
      await screen.findByRole('heading', { name: /How do you want to start/i }),
    ).toBeVisible();

    const staleSettled = stale.promise.catch(() => undefined);
    await act(async () => {
      stale.reject(new Error('older setup request failed'));
      await staleSettled;
    });

    expect(screen.queryByText(/can’t verify setup state/i)).toBeNull();
    expect(screen.getByRole('heading', { name: /How do you want to start/i })).toBeVisible();
  });
});

/** Renders the hasPermission result for a fixed grant, once the provider settles. */
const PermProbe: React.FC = () => {
  const { hasPermission, loading } = useAuth();
  if (loading) return <span>loading</span>;
  return <span data-testid="perm">{hasPermission('users', 'manage') ? 'allow' : 'deny'}</span>;
};

function renderProbe() {
  return render(
    <AuthProvider>
      <PermProbe />
    </AuthProvider>,
  );
}

describe('RBAC provider: a failed read of the effective grants (finding 8)', () => {
  it('denies-by-default for a lesser role when the grants fail to load', async () => {
    meMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'lee', role: 'analyst_tier1' },
    });
    permissionsMock.mockRejectedValue(new Error('permissions 500'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('perm')).toHaveTextContent('deny'));
  });

  it('still allows super_admin even when the grants fail to load', async () => {
    meMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'root', role: 'super_admin' },
    });
    permissionsMock.mockRejectedValue(new Error('permissions 500'));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('perm')).toHaveTextContent('allow'));
  });

  it('preserves allow-all when RBAC is GENUINELY off (a clean response)', async () => {
    meMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'lee', role: 'analyst_tier1' },
    });
    permissionsMock.mockResolvedValue({
      authenticated: true, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {},
    });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('perm')).toHaveTextContent('allow'));
  });
});
