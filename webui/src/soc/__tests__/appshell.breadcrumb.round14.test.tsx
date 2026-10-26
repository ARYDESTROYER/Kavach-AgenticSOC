/**
 * The top-bar breadcrumb and the shell's navigation wiring (Round 14, SPEC §2.2 items 5,
 * 6 and 9, §4.8.1 "Top bar").
 *
 *   - The landing page keeps "Agentic SOC / Overview" (E2); the library reads
 *     "Agentic SOC / Dashboards".
 *   - A board adds its own segments through `setBreadcrumbTrail`: "Dashboards" becomes a
 *     link (followed through the router, so a leave guard still asks first) and the board
 *     name is the current page. Segments show only on the page that set them.
 *   - The brand link opens the Cyber Defence Center.
 *   - Ctrl+B toggles the docked rail and keeps the page where it is.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';

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
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell, setBreadcrumbTrail, useBreadcrumbTrail } from '../AppShell';
import type { PageId } from '../nav';

function renderShell(page: PageId, children: React.ReactNode = <div>routed content</div>) {
  const onNavigate = vi.fn();
  const tree = (current: PageId, body: React.ReactNode) => (
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page={current} onNavigate={onNavigate}>
                  {body}
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
  const utils = render(tree(page, children));
  return { ...utils, onNavigate, rerenderAt: (next: PageId, body: React.ReactNode = children) => utils.rerender(tree(next, body)) };
}

const breadcrumb = () => screen.getByTestId('top-bar-breadcrumb');
const current = () => within(breadcrumb()).getByText((_, el) => el?.getAttribute('aria-current') === 'page');

/** A board page: it gives the shell its segments while mounted. */
function Board({ name }: { name: string }) {
  useBreadcrumbTrail('dashboards', [{ label: 'Dashboards', page: 'dashboards' }, { label: name }]);
  return <div>board body</div>;
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
  act(() => setBreadcrumbTrail('dashboards', null));
});

describe('the top-bar breadcrumb', () => {
  it('keeps "Agentic SOC / Overview" on the landing page (E2)', async () => {
    renderShell('overview');
    expect(await screen.findByTestId('top-bar-breadcrumb')).toHaveTextContent('Agentic SOC/Overview');
    expect(current()).toHaveTextContent('Overview');
  });

  it('names the library "Dashboards"', async () => {
    renderShell('dashboards');
    await screen.findByTestId('top-bar-breadcrumb');
    expect(current()).toHaveTextContent('Dashboards');
    expect(within(breadcrumb()).queryByRole('link')).toBeNull();
  });

  it('shows a board as "Dashboards / <board>" with a working Dashboards link', async () => {
    const { onNavigate } = renderShell('dashboards', <Board name="SOC operations" />);
    await screen.findByText('board body');
    const link = within(breadcrumb()).getByRole('link', { name: 'Dashboards' });
    expect(link).toHaveAttribute('href', '#/dashboards');
    // The link folds below the 46rem bar tier; the board name never does.
    expect(link).toHaveClass('hidden', '@[46rem]/topbar:block');
    expect(current()).toHaveTextContent('SOC operations');
    expect(current()).toHaveAttribute('title', 'SOC operations');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('dashboards', undefined);
  });

  it('drops the segments when the board unmounts, and ignores another page\'s segments', async () => {
    const { rerenderAt } = renderShell('dashboards', <Board name="Executive summary" />);
    await screen.findByText('board body');
    expect(current()).toHaveTextContent('Executive summary');
    rerenderAt('dashboards', <div>library body</div>);
    expect(current()).toHaveTextContent('Dashboards');
    act(() => setBreadcrumbTrail('dashboards', [{ label: 'Dashboards', page: 'dashboards' }, { label: 'Stale board' }]));
    rerenderAt('cases', <div>cases body</div>);
    expect(current()).toHaveTextContent('Cases');
    expect(breadcrumb()).not.toHaveTextContent('Stale board');
  });
});

describe('the shell navigation', () => {
  it('the brand link opens the Cyber Defence Center', async () => {
    const { onNavigate } = renderShell('cases');
    const brand = await screen.findByRole('link', { name: 'Agentic SOC home' });
    expect(brand).toHaveAttribute('href', '#/overview');
    fireEvent.click(brand);
    expect(onNavigate).toHaveBeenCalledWith('overview');
  });

  it('Ctrl+B toggles the rail without navigating', async () => {
    const { onNavigate } = renderShell('cases');
    const frame = await screen.findByTestId('desktop-navigation-frame');
    expect(frame).toHaveClass('w-60');
    act(() => {
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    });
    expect(frame).toHaveClass('w-16');
    act(() => {
      fireEvent.keyDown(window, { key: 'B', metaKey: true });
    });
    expect(frame).toHaveClass('w-60');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('Ctrl+B over a pending flyout rest opens no flyout over the drawer', async () => {
    window.localStorage.setItem('soc.nav.collapsed', '1');
    try {
      renderShell('cases');
      const metrics = await screen.findByTestId('nav-metrics');
      vi.useFakeTimers();
      // The pointer rests on a grouped rail icon; before the 300 ms flyout rest ends the
      // shell's shortcut expands the drawer (it never goes through the toggle).
      fireEvent.pointerMove(metrics);
      act(() => vi.advanceTimersByTime(100));
      act(() => {
        fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
      });
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByTestId('desktop-navigation-frame')).toHaveClass('w-60');
      expect(document.querySelectorAll('[data-testid^="nav-flyout-"]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      window.localStorage.removeItem('soc.nav.collapsed');
    }
  });

  it('never prints text below 11 px in the shell (F13)', async () => {
    const { container } = renderShell('cases');
    await screen.findByTestId('top-bar-breadcrumb');
    expect(container.innerHTML).not.toMatch(/text-\[(9|10)px\]/);
  });
});
