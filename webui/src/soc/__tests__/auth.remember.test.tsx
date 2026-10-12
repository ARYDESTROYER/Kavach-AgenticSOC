/**
 * Round 12 — the auth provider's half of "Remember me" (research/remember-me.md §6
 * web test 10 and SYNTHESIS-ux §4 adjustment 2).
 *
 *  - A lapsed session no longer leaves the console stuck: when GET /api/auth/me
 *    reports `authenticated:false` with a `reason`, the provider drops to the
 *    sign-in page and the page explains why (App → Login, real wiring).
 *  - `sessionEnded` is derived from the server reason and cleared by a deliberate
 *    sign-out, which also drops the device's "remembered until" marker.
 *  - A single sign-on landing that carries `remember_refused` explains it once with
 *    a toast and removes the parameter from the address bar.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const { meMock, rolesMock, toastMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  rolesMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status: number;
    constructor(status = 0, message = '') {
      super(message);
      this.status = status;
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
      setupStatus: ok({ setup_complete: true }),
      auth: {
        me: () => meMock(),
        login: ok({}),
        logout: ok({ ok: true }),
        changePassword: ok({ ok: true }),
        sso: { providers: ok({ providers: [] }), authorize: ok({ auth_url: 'https://idp/' }) },
        mfa: { setup: ok({}), confirm: ok({}), verify: ok({}), disable: ok({}) },
      },
      roles: { get: () => rolesMock() },
      setup: {
        status: ok({
          setup_complete: true,
          auth_enabled: true,
          remember_me: { enabled: true, duration_seconds: 86_400, insecure_blocked: false },
        }),
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

import { App } from '../App';
import { AuthProvider, useAuth } from '../auth';
import { REMEMBERED_UNTIL_KEY } from '@/soc/components/auth/rememberMe';

const SIGNED_IN = {
  auth_enabled: true,
  authenticated: true,
  user: { username: 'alice', role: 'super_admin', must_change_password: false },
  session: { remember: true, expires_at: '2026-10-11T10:00:00+00:00' },
};

let probe: ReturnType<typeof useAuth> | null = null;
const Probe: React.FC = () => {
  probe = useAuth();
  return (
    <span data-testid="state">
      {probe.loading
        ? 'loading'
        : `${probe.isAuthenticated ? 'in' : 'out'}:${probe.sessionEnded?.reason ?? '-'}`}
    </span>
  );
};

beforeEach(() => {
  meMock.mockReset();
  rolesMock.mockReset();
  toastMock.mockReset();
  window.localStorage.clear();
  probe = null;
  rolesMock.mockResolvedValue({ roles: [], rbac_enabled: false, matrix: {} });
  window.history.replaceState(null, '', '/');
});

describe('AuthProvider — registry-aware /auth/me', () => {
  it('drops to signed-out with the reason when the session ended (no stuck console)', async () => {
    meMock.mockResolvedValueOnce(SIGNED_IN).mockResolvedValueOnce({
      auth_enabled: true,
      authenticated: false,
      user: null,
      reason: 'revoked',
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('in:-'));
    // A protected call 401s → the app's handler refreshes /auth/me.
    await act(async () => {
      await probe?.refresh();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('out:revoked');
    expect(probe?.sessionEnded).toEqual({ reason: 'revoked' });
  });

  it('keeps the reason when a later /auth/me (after the cookie was cleared) has none', async () => {
    meMock
      .mockResolvedValueOnce({
        auth_enabled: true,
        authenticated: false,
        user: null,
        reason: 'absolute_expired',
        lifetime_seconds: 86_400,
        remembered: true,
      })
      .mockResolvedValue({ auth_enabled: true, authenticated: false, user: null });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('out:absolute_expired'));
    await act(async () => {
      await probe?.refresh();
    });
    expect(probe?.sessionEnded).toEqual({
      reason: 'absolute_expired',
      lifetimeSeconds: 86_400,
      remembered: true,
    });
    // Signing in again clears it.
    meMock.mockResolvedValue(SIGNED_IN);
    await act(async () => {
      await probe?.refresh();
    });
    expect(probe?.sessionEnded).toBeNull();
  });

  it('a deliberate sign-out shows no reason and drops the remembered-until marker', async () => {
    window.localStorage.setItem(
      REMEMBERED_UNTIL_KEY,
      JSON.stringify({ until: Date.now() + 3_600_000, lifetime: 86_400 }),
    );
    meMock.mockResolvedValue(SIGNED_IN);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('in:-'));
    await act(async () => {
      await probe?.logout();
    });
    expect(screen.getByTestId('state')).toHaveTextContent('out:-');
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_UNTIL_KEY)).toBeNull());
  });

  it('explains a refused single sign-on remember once and cleans the address bar', async () => {
    window.history.replaceState(null, '', '/?remember_refused=role_excluded&x=1');
    meMock.mockResolvedValue(SIGNED_IN);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(
      "Remember me isn't available for your role. You'll stay signed in until you close the browser.",
    );
    expect(window.location.search).toBe('?x=1');
  });
});

describe('App — a lapsed session lands on sign-in with a calm notice', () => {
  it('shows the idle sign-out notice', async () => {
    meMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: false,
      user: null,
      reason: 'idle_expired',
    });
    render(<App />);
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'For your security, you were signed out after a period of inactivity. Sign in to continue.',
      ),
    ).toBeInTheDocument();
  });
});
