/**
 * The current navigation element names the page (Round 14, finding 20; SPEC §2.2 item 9,
 * §4.8.2, D25), rendered in the DOM with the real shell and the real Analytics pages.
 *
 * The Analytics group has its own id (`analytics`, opening Metrics), so no child shares the
 * group's id. With the group open, the one element marked `aria-current="page"` in the
 * navigation reads exactly what the page's `h1` reads, and so does the top-bar breadcrumb
 * leaf: "Metrics" on `#/metrics`, never the group name "Analytics". The pages' data reads
 * stay pending, so only their headers render; the titles are the pages' own.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  /** Any other read: a callable, indexable stand-in whose calls never settle. */
  const pending = (): unknown =>
    new Proxy(() => new Promise(() => undefined), {
      get: (_target, key) => (key === 'then' ? undefined : pending()),
    });
  const known: Record<string, unknown> = {
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
    search: ok({ query: '', cases: [], sources: [], nav: [] }),
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    request: vi.fn(() => new Promise(() => undefined)),
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
    api: new Proxy(known, {
      get: (target, key) => (typeof key === 'string' && key in target ? target[key] : pending()),
    }),
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';
import { renderRoute } from '../registry';
import { navStore } from '../nav-store';
import type { PageId } from '../nav';

function renderPage(page: PageId) {
  const page$ = renderRoute(page, { onRerunWizard: () => undefined });
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={page} onNavigate={vi.fn()}>
                  <React.Suspense fallback={null}>{page$}</React.Suspense>
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('soc.nav.collapsed', '0');
  window.localStorage.setItem('soc.nav.openGroups', JSON.stringify(['analytics']));
  navStore.beginSession();
});

afterEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});

describe('the current navigation element names the page (Analytics)', () => {
  it.each([
    ['metrics', 'Metrics'],
    ['effectiveness', 'Agent effectiveness'],
    ['cost', 'Cost'],
  ] as const)('#/%s: the current element, the breadcrumb and the h1 all read "%s"', async (page, title) => {
    window.location.hash = `#/${page}`;
    renderPage(page);
    const h1 = await screen.findByRole('heading', { level: 1 }, { timeout: 5_000 });
    expect(text(h1)).toBe(title);

    const nav = screen.getByRole('navigation', { name: 'Console destinations' });
    const current = Array.from(nav.querySelectorAll('[aria-current="page"]'));
    expect(current).toHaveLength(1);
    expect(text(current[0])).toBe(text(h1));
    // The group row names the group, never the page, and is not current while it is open.
    expect(screen.getByTestId('nav-analytics')).not.toHaveAttribute('aria-current');

    const crumb = within(screen.getByTestId('top-bar-breadcrumb')).getByText(
      (_, el) => el?.getAttribute('aria-current') === 'page',
    );
    expect(text(crumb)).toBe(text(h1));
  });
});
