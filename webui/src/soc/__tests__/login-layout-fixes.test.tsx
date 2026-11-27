/**
 * Round-6 auth-login compatibility for the minimal Login shell.
 *
 *  - finding 5  (glitch): every stored legacy layout uses the same quiet,
 *    theme-native identity column (Round 16 WP04: on the Console's own canvas).
 *  - finding 17 (ux): the first paint is held until the setup-status probe settles,
 *    so a first-run install doesn't flash the 'signin' form before 'setup'.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

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
      post: ok({}),
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
  support_url: 'https://example.com/help',
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
  brandingMock.mockReset();
  setupStatusMock.mockReset();
  ssoMock.mockReset();
  loginMock.mockReset();
  ssoMock.mockResolvedValue({ providers: [] });
});

describe('Login — legacy full layout converges on the minimal identity shell (finding 5)', () => {
  it('renders one minimal pane with ordinary theme tokens and no hero treatment', async () => {
    brandingMock.mockResolvedValue({ ...BASE_BRANDING, login_layout: 'full' });
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    const { container } = renderLogin();

    await screen.findByLabelText('Username');
    expect(container.querySelector('[data-login-layout="full"]')).toHaveClass(
      'login-canvas',
      'bg-canvas',
      'relative',
      'overflow-x-hidden',
    );
    expect(container.querySelector('[data-login-layout="full"]')).toHaveAttribute(
      'data-login-shell',
      'minimal',
    );
    expect(container.querySelector('[data-login-identity-pane]')).not.toBeNull();
    // No card, slab or hero: the column sits straight on the canvas.
    expect(container.querySelector('[data-login-panel], [data-login-slab]')).toBeNull();

    const support = screen.getByRole('link', { name: /help/i });
    expect(support).toHaveClass('text-muted-foreground');
    expect(support).not.toHaveClass('text-white/70');
  });
});

describe('Login — setup-status gate avoids the signin→setup flash (finding 17)', () => {
  it('shows a loading gate until setup status settles, then the form', async () => {
    brandingMock.mockResolvedValue({ ...BASE_BRANDING, login_layout: 'split' });
    let resolveStatus: (v: unknown) => void = () => {};
    setupStatusMock.mockReturnValue(
      new Promise((r) => {
        resolveStatus = r;
      }),
    );
    renderLogin();

    // Before status settles the sign-in form is NOT painted (no flash), but the final
    // shell is already there: the canvas, the appearance control and a small glyph that
    // reveals only after 300ms. No page-shaped skeleton.
    expect(screen.getByText('Loading sign-in')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
    const gate = document.querySelector('[data-login-loading]');
    expect(gate).toHaveClass('login-canvas', 'bg-canvas');
    expect(screen.getByTestId('console-loading-glyph')).toHaveClass('login-delayed-reveal');
    expect(document.querySelector('[data-loading-shape]')).toBeNull();

    await act(async () => {
      resolveStatus({ setup_complete: true, seeded_default: false });
    });
    // Once settled, the resolved form paints.
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByText('Loading sign-in')).toBeNull();
  });
});
