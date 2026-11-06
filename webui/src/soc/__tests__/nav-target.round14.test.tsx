/**
 * The page a top-level row opens (`navTarget`, Round 14 SPEC §2.2 items 2 and 13).
 *
 * A row opens its `target` while the viewer can see the page that opens it. Otherwise it
 * opens the page of its first child the viewer can see, and its own id only when no child
 * is visible. A viewer without `metrics:view` used to get the Analytics row's own id,
 * which the router redirects to Metrics, whose GET /api/metrics then failed. The rail and
 * the command palette resolve rows through the same function, so both open Cost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

/** RBAC for the palette: grant everything unless a test narrows it. */
let grant: (resource: string, action: string) => boolean = () => true;
vi.mock('../auth', () => ({
  useAuth: () => ({ hasPermission: (resource: string, action: string) => grant(resource, action) }),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
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
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

import { NAV_ITEMS, navTarget, type NavItem, type PageId } from '../nav';
import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CommandPalette } from '../components/CommandPalette';

const withoutMetricsView = (resource: string, action: string) => !(resource === 'metrics' && action === 'view');
const row = (id: PageId): NavItem => {
  const item = NAV_ITEMS.find((i) => i.id === id);
  if (!item) throw new Error(`no nav row ${id}`);
  return item;
};

beforeEach(() => {
  grant = () => true;
  window.localStorage.clear();
});

describe('navTarget', () => {
  it('opens the target while the viewer can see it', () => {
    expect(navTarget(row('analytics'), () => true)).toBe('metrics');
    expect(navTarget(row('overview'), () => true)).toBe('dashboards');
  });

  it('opens the first visible child page when the target is hidden', () => {
    // Metrics and Agent effectiveness both need metrics:view; Cost is the first child left.
    expect(navTarget(row('analytics'), withoutMetricsView)).toBe('cost');
    // The Overview row's first child is the Cyber Defence Center, which opens `overview`.
    expect(navTarget(row('overview'), withoutMetricsView)).toBe('overview');
  });

  it("skips a hidden first child and returns the next visible child's page", () => {
    const item: NavItem = {
      ...row('analytics'),
      target: 'metrics',
      children: [
        { id: 'metrics', label: 'Metrics', perm: { resource: 'metrics', action: 'view' } },
        { id: 'baseline', label: 'Baseline', perm: { resource: 'settings', action: 'read' } },
        { id: 'cost', label: 'Cost' },
      ],
    };
    const settingsOnly = (resource: string, action: string) => resource === 'settings' && action === 'read';
    expect(navTarget(item, settingsOnly)).toBe('baseline');
    expect(navTarget(item, () => false)).toBe('cost');
  });

  it("falls back to the row's own id only when no child is visible", () => {
    const item: NavItem = {
      ...row('analytics'),
      target: 'metrics',
      children: [{ id: 'metrics', label: 'Metrics', perm: { resource: 'metrics', action: 'view' } }],
    };
    expect(navTarget(item, () => false)).toBe('analytics');
  });

  it("returns the row's own id for a row without a target", () => {
    expect(navTarget(row('cases'), () => false)).toBe('cases');
    expect(navTarget(row('chat'), withoutMetricsView)).toBe('chat');
  });
});

describe('the command palette opens what the navigation opens', () => {
  const item = (value: string) => document.querySelector(`[cmdk-item][data-value="${value}"]`) as HTMLElement | null;

  async function renderPalette() {
    const onNavigate = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <CommandPalette open onOpenChange={vi.fn()} onNavigate={onNavigate} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(item('action-search-chats')).toBeTruthy());
    return onNavigate;
  }

  it('the Analytics entry opens Cost for a viewer without metrics:view', async () => {
    grant = withoutMetricsView;
    const onNavigate = await renderPalette();
    await waitFor(() => expect(item('nav-analytics')).toBeTruthy());
    expect(item('navc-analytics-metrics')).toBeNull();
    fireEvent.click(item('nav-analytics') as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('cost');
  });

  it('the Analytics entry opens Metrics for a viewer with metrics:view', async () => {
    const onNavigate = await renderPalette();
    await waitFor(() => expect(item('nav-analytics')).toBeTruthy());
    fireEvent.click(item('nav-analytics') as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('metrics');
  });
});
