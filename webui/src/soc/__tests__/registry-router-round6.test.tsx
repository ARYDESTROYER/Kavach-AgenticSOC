/**
 * Round-6 registry + router consistency fixes.
 *
 * Locks the load-bearing contracts of the batch's fixes WITHOUT a browser:
 *   - host-tab disclosure children route THROUGH their host with a forced tab (no
 *     bare, strip-less duplicate rendering at a second URL),
 *   - the RouterProvider mount effect preserves a `#/settings?s=<section>` query on
 *     initial load (bookmark/refresh deep-link survives),
 *   - the Metrics nav child gates on `metrics:view` (matches its backend route),
 *   - the command palette flattens disclosure children into jump targets and marks
 *     nav rows with the `group` class the selected-arrow affordance needs.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

import { ROUTES, renderRoute, FEATURES, type FeatureChild } from '../registry';
import { optsFromHash, pageHash, RouterProvider, useRoute } from '../router';
import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { TooltipProvider } from '@/ui/tooltip';
import { CommandPalette } from '../components/CommandPalette';

// vitest hoists vi.mock above the imports above, so the palette's `@/lib/api` resolves
// to this stub (auth off → hasPermission grants everything, so all children show).
vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
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
      search: vi.fn().mockResolvedValue({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

/* -------------------------------------------------------------------------- */
/* Host-tab children route THROUGH their host with a forced tab (index 0/4).   */
/* -------------------------------------------------------------------------- */

describe('ROUTES — host-tab children route through their host with a forced tab', () => {
  const ctx = { onRerunWizard: () => undefined };

  it.each([
    ['cost', 'metrics', 'cost'],
    ['effectiveness', 'metrics', 'effectiveness'],
    ['standup', 'overview', 'standup'],
    ['investigate', 'chat', 'investigate'],
    ['knowledge', 'intelligence', 'knowledge'],
    ['runbooks', 'intelligence', 'runbooks'],
    ['memory', 'intelligence', 'memory'],
    ['playbooks', 'intelligence', 'playbooks'],
    ['personas', 'intelligence', 'personas'],
    // Compatibility deep-link: the retired combined Catalog lands on Playbooks.
    ['catalog', 'intelligence', 'playbooks'],
  ] as const)(
    '#/%s renders its host element with a forced tab',
    (child, host, tab) => {
      // The child's route element is its HOST's lazy component (never a standalone one).
      expect(ROUTES[child].element).toBe(ROUTES[host].element);
      const el = renderRoute(child, ctx);
      expect(el.type).toBe(ROUTES[host].element);
      expect((el.props as { tab?: string }).tab).toBe(tab);
    },
  );

  it('leaves genuinely-standalone children (no host tab) as their own page', () => {
    // These have no host tab, so they keep a standalone route.
    for (const id of ['dashboards', 'models', 'baseline', 'batchjobs', 'inbox'] as const) {
      const el = renderRoute(id, ctx);
      expect(el.type).toBe(ROUTES[id].element);
    }
  });

  it('every route element is still a React.lazy chunk (entry stays code-split)', () => {
    const LAZY = Symbol.for('react.lazy');
    for (const [id, def] of Object.entries(ROUTES)) {
      const el = def.element as unknown as { $$typeof?: symbol };
      expect(el.$$typeof, `route "${id}" element is not React.lazy`).toBe(LAZY);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Metrics nav child gates on metrics:view (index 12).                         */
/* -------------------------------------------------------------------------- */

describe('registry — Analytics children RBAC gates match their backend routes', () => {
  const metricsHost = FEATURES.find((f) => f.id === 'metrics')!;
  const child = (id: string): FeatureChild | undefined =>
    (metricsHost.children ?? []).find((c) => c.id === id);

  it('gates the Metrics child on metrics:view (the grant GET /api/metrics requires)', () => {
    expect(child('metrics')?.perm).toEqual({ resource: 'metrics', action: 'view' });
    expect(child('effectiveness')?.perm).toEqual({ resource: 'metrics', action: 'view' });
  });

  it('leaves Cost + Models ungated (their GET endpoints are auth-only)', () => {
    expect(child('cost')?.perm).toBeUndefined();
    expect(child('models')?.perm).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* RouterProvider initial-hash normalization preserves the ?s= query (index 5).*/
/* -------------------------------------------------------------------------- */

describe('RouterProvider — initial hash normalization', () => {
  let currentPage = '';
  let currentOpts: ReturnType<typeof useRoute>['opts'];
  function Reader() {
    const route = useRoute();
    currentPage = route.page;
    currentOpts = route.opts;
    return null;
  }
  afterEach(() => {
    window.location.hash = '';
    currentPage = '';
    currentOpts = undefined;
  });

  it('preserves #/settings?s=<section> on initial load (no strip to bare #/settings)', () => {
    window.location.hash = '#/settings?s=admin_users';
    act(() => {
      render(
        <RouterProvider>
          <Reader />
        </RouterProvider>,
      );
    });
    expect(currentPage).toBe('settings');
    // The section query survives the mount effect (previously collapsed to #/settings).
    expect(window.location.hash).toBe('#/settings?s=admin_users');
  });

  it('still rewrites a retired standalone deep-link (#/roles → #/settings?s=roles)', () => {
    window.location.hash = '#/roles';
    act(() => {
      render(
        <RouterProvider>
          <Reader />
        </RouterProvider>,
      );
    });
    expect(currentPage).toBe('settings');
    expect(window.location.hash).toBe('#/settings?s=roles');
  });

  it('reflects the resolved page for a bare/unknown hash', () => {
    window.location.hash = '';
    act(() => {
      render(
        <RouterProvider>
          <Reader />
        </RouterProvider>,
      );
    });
    expect(currentPage).toBe('overview');
    expect(window.location.hash).toBe('#/overview');
  });

  it('serializes the selected Case Manager case for refresh-safe handoff', () => {
    expect(pageHash('case_manager', { caseId: 'case/alpha 01' })).toBe(
      '#/case_manager?caseId=case%2Falpha%2001',
    );
    expect(pageHash('cases')).toBe('#/cases');
    window.location.hash = '#/case_manager?caseId=case%2Falpha%2001';
    expect(optsFromHash()).toEqual({
      caseId: 'case/alpha 01',
      status: undefined,
      assignee: undefined,
      tag: undefined,
    });
  });

  it('round-trips the strict effectiveness analytics tab across refresh', () => {
    expect(pageHash('metrics', { tab: 'effectiveness' })).toBe(
      '#/metrics?tab=effectiveness',
    );
    window.location.hash = '#/metrics?tab=effectiveness';
    expect(optsFromHash()).toEqual({ tab: 'effectiveness' });
    act(() => {
      render(
        <RouterProvider>
          <Reader />
        </RouterProvider>,
      );
    });
    expect(currentPage).toBe('metrics');
    expect(currentOpts).toEqual({ tab: 'effectiveness' });

    window.location.hash = '#/metrics?tab=cost';
    expect(optsFromHash()).toBeUndefined();
    window.location.hash = '#/metrics?tab=effectiveness&next=https%3A%2F%2Fevil.example';
    expect(optsFromHash()).toBeUndefined();
  });

  it('round-trips only allowlisted filtered-case result options', () => {
    expect(
      pageHash('cases', {
        status: 'active',
        assignee: 'tier-2@example.com',
        tag: 'needs-review',
      }),
    ).toBe('#/cases?status=active&assignee=tier-2%40example.com&tag=needs-review');
    window.location.hash = '#/cases?assignee=tier-2%40example.com';
    expect(optsFromHash()).toEqual({
      caseId: undefined,
      status: undefined,
      assignee: 'tier-2@example.com',
      tag: undefined,
    });
    window.location.hash = '#/cases?tag=ok&next=javascript%3Aalert%281%29';
    expect(optsFromHash()).toBeUndefined();

    const unicodeHash = pageHash('cases', { assignee: 'アナリスト', tag: '要確認' });
    expect(unicodeHash).toBe(
      '#/cases?assignee=%E3%82%A2%E3%83%8A%E3%83%AA%E3%82%B9%E3%83%88&tag=%E8%A6%81%E7%A2%BA%E8%AA%8D',
    );
    window.location.hash = unicodeHash;
    expect(optsFromHash()).toEqual({
      caseId: undefined,
      status: undefined,
      assignee: 'アナリスト',
      tag: '要確認',
    });
    window.location.hash = '#/cases?assignee=analyst%E2%80%AEexe';
    expect(optsFromHash()).toBeUndefined();
    window.location.hash = '#/cases?tag=review%2Furgent';
    expect(optsFromHash()).toBeUndefined();
    window.location.hash = '#/cases?tag=review%ZZ';
    expect(optsFromHash()).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Command palette flattens disclosure children + marks rows `group` (1, 8/13).*/
/* -------------------------------------------------------------------------- */

function renderPalette(onNavigate = vi.fn()) {
  render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <CommandPalette open onOpenChange={vi.fn()} onNavigate={onNavigate} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return { onNavigate };
}

describe('CommandPalette — disclosure children are reachable jump targets', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('lists a children-only destination (Cost) and routes it via onNavigate', async () => {
    const { onNavigate } = renderPalette();
    const input = await screen.findByPlaceholderText(/search cases, sources, settings/i);
    fireEvent.change(input, { target: { value: 'Cost' } });
    // The Cost child (a tab of Analytics — previously unreachable from Cmd-K) is present
    // with its unique `navc-<parent>-<id>` value.
    const cost = document.querySelector('[cmdk-item][data-value="navc-metrics-cost"]');
    expect(cost).toBeTruthy();
    fireEvent.click(cost as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('cost');
  });

  it('keeps the top-level host value stable (nav-cases) and marks the row `group`', async () => {
    const { onNavigate } = renderPalette();
    await waitFor(() =>
      expect(document.querySelector('[cmdk-item][data-value="nav-cases"]')).toBeTruthy(),
    );
    const casesItem = document.querySelector('[cmdk-item][data-value="nav-cases"]') as HTMLElement;
    // The selected-arrow affordance needs the literal `group` class on the row.
    expect(casesItem.classList.contains('group')).toBe(true);
    fireEvent.click(casesItem);
    expect(onNavigate).toHaveBeenCalledWith('cases');
  });
});
