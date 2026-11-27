/**
 * Shell keyboard focus (Round 16 bug hunt, WP15F).
 *
 * - B71: the "Skip to main content" link moves focus to `#socMain` in code. The Console
 *   routes by the URL hash, so a plain fragment link handed `#socMain` to the router, which
 *   read it as an unknown page and opened Overview (losing an open case). The hash must not
 *   change and the route must stay where it was.
 * - B73: the phone navigation sheet opens from a plain button, not a Radix trigger, so on
 *   close Radix had nothing to return focus to and it fell to the page body. Closing it now
 *   returns focus to "Open navigation"; picking a destination moves focus to `#socMain`.
 *
 * The api client and every provider the shell consumes are mocked, as in
 * appshell.search.test.tsx, so the test is fully offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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

function renderShell(page: PageId, onNavigate = vi.fn()) {
  const result = render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={page} onNavigate={onNavigate}>
                  <RouteProbe />
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { ...result, onNavigate };
}

const CASE_LINK = '#/case_manager?caseId=demo-hitl-00000539-0000';

describe('B71: the skip link moves focus without touching the hash router', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setMobileViewport(false);
    window.location.hash = CASE_LINK;
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('keeps a Case Manager deep link and focuses the main landmark', async () => {
    renderShell('case_manager');
    expect(await screen.findByTestId('route-probe')).toHaveTextContent('case_manager|demo-hitl-00000539-0000');
    // Let the shell's load-time reads settle inside act.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    // Still a real link in the tab order, pointing at the landmark it skips to.
    expect(skip).toHaveAttribute('href', '#socMain');
    skip.focus();
    fireEvent.click(skip);

    // jsdom performs fragment navigation for a link click, as a browser does: without the
    // fix the hash became `#socMain` and the router resolved it to Overview.
    expect(window.location.hash).toBe(CASE_LINK);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.location.hash).toBe(CASE_LINK);
    expect(screen.getByTestId('route-probe')).toHaveTextContent('case_manager|demo-hitl-00000539-0000');
    expect(document.activeElement).toBe(document.getElementById('socMain'));
  });
});

describe('B73: the phone navigation sheet hands focus back', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setMobileViewport(true);
  });

  it('returns focus to "Open navigation" when the sheet closes with Escape', async () => {
    renderShell('cases');
    const opener = await screen.findByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Primary navigation' });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Primary navigation' })).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('moves focus to the main landmark after picking a destination', async () => {
    const { onNavigate } = renderShell('overview');
    const opener = await screen.findByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Primary navigation' });

    fireEvent.click(within(dialog).getByTestId('nav-cases'));
    expect(onNavigate).toHaveBeenCalledWith('cases');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Primary navigation' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('socMain')));
  });
});
