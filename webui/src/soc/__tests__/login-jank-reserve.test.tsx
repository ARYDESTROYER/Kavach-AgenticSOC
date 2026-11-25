/**
 * WS-F task 8 — Login jank (layout-stability) fixes.
 *
 * Locks the mechanical stability fixes (no flow/state-machine change):
 *  - the password-strength meter renders inside a RESERVED fixed-height slot, present
 *    BEFORE the first keystroke, so typing the first char never shoves the fields/button
 *    down (reserve-space; CLS≈0);
 *  - the "passwords don't match" line lives in a reserved min-height slot too;
 *  - the SSO-providers probe is folded into the first-paint gate, so the "or continue
 *    with" divider + provider buttons never POP IN a beat after the form paints — the
 *    form is held until BOTH the setup-status AND the SSO probe settle, and they then
 *    appear together.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

const { brandingMock, setupStatusMock, ssoMock, loginMock } = vi.hoisted(() => ({
  brandingMock: vi.fn(),
  setupStatusMock: vi.fn(),
  ssoMock: vi.fn(),
  loginMock: vi.fn(),
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
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
      setup: { status: () => setupStatusMock() },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: ok({ ok: true }),
        mfa: { setup: ok({}), confirm: ok({}), verify: ok({}), disable: ok({}) },
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
      },
    },
  };
});

const BASE_BRANDING = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '',
  accent_color2: '',
  theme: '',
  login_subtitle: 'Welcome back',
  footer_text: 'UNCLASSIFIED',
  support_url: '',
  dark_mode_default: false,
};

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';

function renderLogin() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={vi.fn()} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  brandingMock.mockReset().mockResolvedValue({ ...BASE_BRANDING });
  setupStatusMock.mockReset();
  ssoMock.mockReset();
  loginMock.mockReset();
});

describe('Login — reserved strength-meter + mismatch slots (finding 3)', () => {
  it('reserves the strength-meter slot BEFORE typing (no shove on first keystroke)', async () => {
    setupStatusMock.mockResolvedValue({ needs_user: true, setup_complete: false });
    ssoMock.mockResolvedValue({ providers: [] });
    const { container } = renderLogin();

    await screen.findByText('Create your admin account');

    // The fixed-height meter slot exists even though nothing is typed yet (meter is
    // null), so inserting the meter later cannot push the fields/button down.
    const slot = container.querySelector('.min-h-\\[1\\.75rem\\]');
    expect(slot).not.toBeNull();
    // …and the meter itself is not yet rendered (empty password).
    expect(screen.queryByText(/Too weak|Weak|Fair|Good|Strong/)).toBeNull();

    // Typing fills the SAME reserved slot rather than inserting new height.
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'C0rrectHorseBattery!' },
    });
    await waitFor(() => expect(screen.getByText('Strong')).toBeInTheDocument());
    expect(slot?.contains(screen.getByText('Strong'))).toBe(true);
  });

  it('reserves a fixed-height slot for the "passwords do not match" line', async () => {
    setupStatusMock.mockResolvedValue({ needs_user: true, setup_complete: false });
    ssoMock.mockResolvedValue({ providers: [] });
    const { container } = renderLogin();

    await screen.findByText('Create your admin account');
    // The mismatch slot is reserved (present) even when the confirm field is empty.
    expect(container.querySelector('.min-h-\\[1rem\\]')).not.toBeNull();
  });
});

describe('Login — SSO probe folded into the first-paint gate (finding 2)', () => {
  it('holds the form until the SSO probe settles, then paints form + SSO together', async () => {
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    let resolveSso: (v: unknown) => void = () => {};
    ssoMock.mockReturnValue(
      new Promise((r) => {
        resolveSso = r;
      }),
    );

    renderLogin();

    // Setup-status has resolved, but the SSO probe has NOT — so nothing paints yet
    // (the SSO block cannot pop in a beat after the form).
    await waitFor(() => expect(setupStatusMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    await act(async () => {
      resolveSso({ providers: [{ id: 'g', type: 'google', display_name: 'Google' }] });
    });

    // Now the form AND the SSO button are present in the same painted frame.
    const username = await screen.findByLabelText('Username');
    expect(screen.getByText('Sign in with Google')).toBeInTheDocument();

    // Continue is painted with the form (Round 16 WP04), so the first keystroke adds
    // nothing and the already-painted SSO row never moves.
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    fireEvent.change(username, { target: { value: 'analyst' } });
    expect(screen.getByRole('button', { name: 'Continue' })).toBe(continueButton);
    expect(screen.getByText('Sign in with Google')).toBeInTheDocument();
  });
});
