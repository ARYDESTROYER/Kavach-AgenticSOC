/**
 * The account menu says "Sign out" (Round 16 acceptance fixes, package FXC,
 * log-out-wording).
 *
 * The sign-in page, the Remember me warning and Sessions all say Sign in and Sign out,
 * so the account menu does too, in the desktop menu and in the phone controls sheet. It
 * uses the neutral menu colour: signing out loses nothing, so it is not destructive.
 *
 * The api client and the providers the shell consumes are mocked as in
 * a11y.shell-focus.test.tsx, so the test is fully offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {
      status: number;
      body: unknown;
      constructor(status = 0, message = '', body: unknown = null) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
      }
    },
    api: {
      get: ok({ unread: 0, items: [] }),
      post: ok({ ok: true }),
      put: ok({}),
      del: ok({}),
      auth: { me: ok({ auth_enabled: false, authenticated: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider, useRoute } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';
import type { PageId } from '../nav';

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('max-width') ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
}

/** Prints the router's current page and case id, so a test sees what the router resolved. */
function RouteProbe() {
  const route = useRoute();
  const caseId = typeof route.opts?.caseId === 'string' ? route.opts.caseId : '';
  return <p data-testid="route-probe">{`${route.page}|${caseId}`}</p>;
}

function renderShell(page: PageId, onLogout = vi.fn()) {
  const onNavigate = vi.fn();
  const result = render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={page} onNavigate={onNavigate} username="alice" onLogout={onLogout}>
                  <RouteProbe />
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { ...result, onLogout };
}

describe('log-out-wording: the account menu says Sign out', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.location.hash = '#/overview';
  });

  it('names the desktop menu item Sign out, in the neutral menu colour', async () => {
    setMobileViewport(false);
    const { onLogout } = renderShell('overview');
    const trigger = await screen.findByRole('button', { name: 'Open account menu' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const item = within(menu).getByRole('menuitem', { name: 'Sign out' });
    expect(within(menu).queryByText(/log out/i)).toBeNull();
    expect(item.className).not.toMatch(/critical/);
    fireEvent.click(item);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('names the phone controls item Sign out, in the neutral colour', async () => {
    setMobileViewport(true);
    const { onLogout } = renderShell('overview');
    fireEvent.click(await screen.findByRole('button', { name: /^Open console controls/ }));
    const account = await screen.findByRole('region', { name: 'Account' });
    const item = within(account).getByRole('button', { name: 'Sign out' });
    expect(within(account).queryByText(/log out/i)).toBeNull();
    expect(item.className).not.toMatch(/critical/);
    fireEvent.click(item);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
