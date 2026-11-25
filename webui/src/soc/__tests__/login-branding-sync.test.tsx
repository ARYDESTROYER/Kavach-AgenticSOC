/**
 * Ask #6 — Login must reflect a same-session branding save (branding-not-reflected).
 *
 * Root cause: `ThemeProvider` fetched GET /api/branding exactly ONCE at app boot and
 * never refetched, so a saved `login_*` edit never reached the long-lived branding
 * context that `Login` reads from — the login screen kept rendering the boot snapshot
 * until a hard page reload. The fix adds a shared `refreshBranding()` on the theme
 * context that the BrandingEditor calls after Save and that Login calls on mount.
 *
 * Test A (the regression): an in-memory branding "backend" shared by the api mock —
 * the BrandingEditor writes through api.put('branding'), theme.tsx reads through
 * api.getBranding(); both observe the SAME store, exactly like the real
 * `state.prefs.branding` singleton. Editing the headline + Save then navigating to
 * Login must show the new headline WITHOUT a reload.
 *
 * Test B (Finding A / FOUC): the branding probe is folded into Login's first-paint
 * gate, so the form is held until branding settles — never painted stale-then-snapped
 * to the operator's real layout/copy. Mirrors the SSO-probe gate test in
 * `login-jank-reserve.test.tsx`.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';

const { getBrandingMock, getMock, putMock, setupStatusMock, ssoMock, loginMock, postMock } =
  vi.hoisted(() => ({
    getBrandingMock: vi.fn(),
    getMock: vi.fn(),
    putMock: vi.fn(),
    setupStatusMock: vi.fn(),
    ssoMock: vi.fn(),
    loginMock: vi.fn(),
    postMock: vi.fn(),
  }));

vi.mock('@/lib/api', () => {
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
      getBranding: () => getBrandingMock(),
      get: (path: string) => getMock(path),
      put: (path: string, body: unknown) => putMock(path, body),
      post: (path: string, body?: unknown) => postMock(path, body),
      del: vi.fn().mockResolvedValue({}),
      setup: { status: () => setupStatusMock() },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: vi.fn().mockResolvedValue({ ok: true }),
        mfa: {
          setup: vi.fn().mockResolvedValue({}),
          confirm: vi.fn().mockResolvedValue({}),
          verify: vi.fn().mockResolvedValue({ user: {} }),
          disable: vi.fn().mockResolvedValue({}),
        },
        sso: {
          providers: () => ssoMock(),
          authorize: vi.fn().mockResolvedValue({ auth_url: 'https://idp/' }),
        },
      },
    },
  };
});

// BrandingEditor imports `toast` from sonner; stub to no-ops (ThemeProvider's Toaster
// wrapper resolves the mocked null Toaster the same way the other login/branding specs do).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';
import { BrandingEditor } from '../components/BrandingEditor';

const BASE_BRANDING = {
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
  material: 'quiet',
  default_theme: 'system',
  theme_tokens: {},
  presets: [],
  login_headline: '',
  login_body: '',
  login_chips: [] as string[],
  login_layout: 'split',
  login_illustration: '',
};

function renderLogin() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={vi.fn()} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('Login reflects a same-session branding save (regression #6)', () => {
  // A tiny in-memory branding singleton — the api mock's getBranding()/get('branding')
  // read it, put('branding') merges into it. Exactly the real backend contract where
  // GET /api/branding after a PUT returns the just-saved doc synchronously.
  const store: { current: Record<string, unknown> } = { current: { ...BASE_BRANDING } };

  beforeEach(() => {
    store.current = { ...BASE_BRANDING };
    getBrandingMock.mockReset().mockImplementation(() => Promise.resolve(store.current));
    getMock
      .mockReset()
      .mockImplementation((path: string) =>
        Promise.resolve(path === 'branding' ? store.current : {}),
      );
    putMock.mockReset().mockImplementation((path: string, body: unknown) => {
      if (path === 'branding') store.current = { ...store.current, ...(body as object) };
      return Promise.resolve(store.current);
    });
    setupStatusMock.mockReset().mockResolvedValue({ setup_complete: true, seeded_default: false });
    ssoMock.mockReset().mockResolvedValue({ providers: [] });
    postMock.mockReset().mockResolvedValue({ ok: true });
    loginMock.mockReset();
  });

  function Harness() {
    const [onLogin, setOnLogin] = React.useState(false);
    return (
      <ThemeProvider>
        <TooltipProvider>
          {onLogin ? (
            <Login onAuthenticated={vi.fn()} />
          ) : (
            <>
              <BrandingEditor />
              <button type="button" onClick={() => setOnLogin(true)}>
                go to login
              </button>
            </>
          )}
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  it('reflects a saved login_headline on the Login screen without a page reload', async () => {
    render(<Harness />);

    // Edit the login headline in the BrandingEditor and Save it.
    const headline = (await screen.findByLabelText('Short welcome line')) as HTMLInputElement;
    fireEvent.change(headline, { target: { value: 'New HQ Copy' } });
    const saveBtn = screen.getByRole('button', { name: /save branding/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(store.current.login_headline).toBe('New HQ Copy'));

    // Navigate to the login screen in the SAME session (no reload). It must render the
    // just-saved headline — before the fix it showed the stale boot snapshot.
    fireEvent.click(screen.getByRole('button', { name: 'go to login' }));
    expect(await screen.findByText('New HQ Copy')).toBeInTheDocument();
  });
});

describe('Login — branding probe folded into the first-paint gate (FOUC fix, finding A)', () => {
  beforeEach(() => {
    getBrandingMock.mockReset();
    getMock.mockReset().mockResolvedValue({});
    putMock.mockReset().mockResolvedValue({});
    setupStatusMock.mockReset().mockResolvedValue({ setup_complete: true, seeded_default: false });
    ssoMock.mockReset().mockResolvedValue({ providers: [] });
    postMock.mockReset().mockResolvedValue({ ok: true });
    loginMock.mockReset();
  });

  it('holds the login form until the branding probe settles, then paints', async () => {
    let resolveBranding: (v: unknown) => void = () => {};
    getBrandingMock.mockReturnValue(
      new Promise((r) => {
        resolveBranding = r;
      }),
    );

    renderLogin();

    // Setup-status + SSO have settled, but the branding probe has NOT — so nothing
    // paints yet (the login can't flash defaults then snap to the real layout/copy).
    await waitFor(() => expect(setupStatusMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    await act(async () => {
      resolveBranding({ ...BASE_BRANDING, login_headline: 'Late Co' });
    });

    // Now the form paints AND the operator's headline is present in the same frame.
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.getByText('Late Co')).toBeInTheDocument();
  });
});
