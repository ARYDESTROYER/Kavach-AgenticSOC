/**
 * Custom dashboards — wiring contract (Round 5 / G7, CD5 "CD-wire").
 *
 * This spec pins the three things the CD5 FE-wire task added, WITHOUT touching the
 * builder/registry internals (those have their own specs):
 *
 *   1. NAV — the `dashboards` destination is registered as an Overview child, ships ON
 *      by default, is gated on `metrics:view`, and its label/route resolve.
 *   2. ROUTE — `#/dashboards` resolves to the `dashboards` PageId (a real, deep-linkable
 *      route), and every pre-existing PageId stays routable (no regression).
 *   3. API — `api.dashboards.{list,create,update,remove,clone}` hit the exact backend
 *      paths + methods of `routes_dashboards.py`, and `update` debounces (coalesces
 *      rapid successive writes to one trailing PUT).
 *
 * The API tests exercise the REAL client (only `global.fetch` is stubbed), so a path or
 * method drift from the backend router is caught here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  FEATURES,
  FEATURE_GROUPS,
  featureEnabled,
  type FeatureChild,
} from '../registry';
import { NAV_CHILDREN, PAGE_IDS, isPageId, navLabel, navParentOf } from '../nav';
import { pageFromHash } from '../router';
// The REAL api client (no method mocked): `request()` reads `global.fetch` at
// call-time, so a per-test fetch stub exercises the true path/method/debounce logic.
import { api } from '../../lib/api';

/* -------------------------------------------------------------------------- */
/* 1 + 2 — NAV registration + route resolution (pure, no DOM).                */
/* -------------------------------------------------------------------------- */

describe('CD5 — the dashboards destination is registered', () => {
  const overview = FEATURES.find((f) => f.id === 'overview')!;
  const child = (overview.children ?? []).find(
    (c: FeatureChild) => c.id === 'dashboards',
  );

  it('exists as an Overview child in the feature registry', () => {
    expect(overview).toBeTruthy();
    expect(child).toBeTruthy();
    expect(child!.label).toBe('Dashboards');
  });

  it('gates on metrics:view (the same grant the backend routes require)', () => {
    expect(child!.perm).toEqual({ resource: 'metrics', action: 'view' });
  });

  it('is ON by default — shown when RBAC is off (auth disabled → always granted)', () => {
    const ctx = { hasPermission: () => true };
    expect(featureEnabled(child!, ctx)).toBe(true);
  });

  it('is hidden from a principal WITHOUT metrics:view, shown WITH it', () => {
    const deny = { hasPermission: (r: string, a: string) => !(r === 'metrics' && a === 'view') };
    const grant = { hasPermission: (r: string, a: string) => r === 'metrics' && a === 'view' };
    expect(featureEnabled(child!, deny)).toBe(false);
    expect(featureEnabled(child!, grant)).toBe(true);
  });

  it('surfaces in the derived nav (a routable child under Overview) with a label', () => {
    expect(NAV_CHILDREN.some((c) => c.id === 'dashboards')).toBe(true);
    expect(navLabel('dashboards')).toBe('Dashboards');
    // Its active-trail parent is the Overview rail item.
    expect(navParentOf('dashboards')?.id).toBe('overview');
  });

  it('lives in the Overview group (top-of-rail), not buried elsewhere', () => {
    // The child hangs off the Overview feature, and Overview is the first rail group.
    expect(overview.group).toBe('overview');
    expect(FEATURE_GROUPS[0].id).toBe('overview');
  });
});

describe('CD5 — #/dashboards resolves as a routable page id', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('registers `dashboards` as a known PageId', () => {
    expect(isPageId('dashboards')).toBe(true);
    expect(PAGE_IDS).toContain('dashboards');
  });

  it('resolves a `#/dashboards` deep-link to the dashboards page (not Overview)', () => {
    window.location.hash = '#/dashboards';
    expect(pageFromHash()).toBe('dashboards');
  });

  it('keeps the `dashboard` (singular) id as an alias of the landing page (Round 14, SPEC §2.2 item 3)', () => {
    // The Cyber Defence Center has one URL: `#/dashboard` resolves (and is normalised)
    // to `#/overview`, never to the library.
    expect(isPageId('dashboard')).toBe(true);
    window.location.hash = '#/dashboard';
    expect(pageFromHash()).toBe('overview');
  });

  it('keeps every previously-registered PageId routable (no deep-link regression)', () => {
    const PRIOR = [
      'overview', 'dashboard', 'cases', 'investigate', 'chat', 'intelligence', 'metrics',
      'models', 'scans', 'standup', 'catalog', 'playbooks', 'approvals', 'knowledge',
      'memory', 'sources', 'cost', 'inbox', 'account', 'sessions', 'settings', 'security',
      'roles', 'users', 'audit', 'admin_sessions', 'logs', 'campaigns', 'tuning',
      'batchjobs', 'baseline',
    ];
    for (const id of PRIOR) expect(isPageId(id)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — api.dashboards.* hit the right backend paths (REAL client, stub fetch). */
/* -------------------------------------------------------------------------- */

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

describe('CD5 — api.dashboards.* hit the routes_dashboards.py paths', () => {
  let calls: FetchCall[];
  const realFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    // Stub ONLY global.fetch (not the module registry) so no other suite is polluted.
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: (init?.method || 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ dashboards: [], id: 'd1', ok: true }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = realFetch;
  });

  const board = () => ({
    id: 'd1',
    name: 'My board',
    schema_version: 1,
    columns: 12,
    widgets: [],
  });

  it('list → GET /api/dashboards', async () => {
    await api.dashboards.list();
    expect(calls[0]).toMatchObject({ url: '/api/dashboards', method: 'GET' });
  });

  it('create → POST /api/dashboards with the layout body', async () => {
    await api.dashboards.create(board() as never);
    expect(calls[0]).toMatchObject({ url: '/api/dashboards', method: 'POST' });
    expect((calls[0].body as { id: string }).id).toBe('d1');
  });

  it('remove → DELETE /api/dashboards/{id} (id url-encoded)', async () => {
    await api.dashboards.remove('d 1');
    expect(calls[0]).toMatchObject({ url: '/api/dashboards/d%201', method: 'DELETE' });
  });

  it('clone → POST /api/dashboards/{id}/clone', async () => {
    await api.dashboards.clone('d1');
    expect(calls[0]).toMatchObject({ url: '/api/dashboards/d1/clone', method: 'POST' });
  });

  it('update → debounced PUT /api/dashboards/{id} (coalesces rapid writes to one)', async () => {
    // Fire three rapid updates to the SAME id within the debounce window.
    const p1 = api.dashboards.update('d1', { ...board(), name: 'a' } as never);
    const p2 = api.dashboards.update('d1', { ...board(), name: 'b' } as never);
    const p3 = api.dashboards.update('d1', { ...board(), name: 'c' } as never);

    // Nothing has been sent yet — the trailing debounce hasn't elapsed.
    expect(calls.length).toBe(0);

    // Advance past the ~500ms window → exactly ONE PUT, carrying the LAST payload.
    await vi.advanceTimersByTimeAsync(600);

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(1);
    expect(puts[0].url).toBe('/api/dashboards/d1');
    expect((puts[0].body as { name: string }).name).toBe('c');

    // Every awaiting caller resolves with the single coalesced result.
    await expect(Promise.all([p1, p2, p3])).resolves.toHaveLength(3);
  });

  it('update — a NEW window after the flight sends a fresh PUT', async () => {
    const first = api.dashboards.update('d1', board() as never);
    await vi.advanceTimersByTimeAsync(600);
    await first;
    const second = api.dashboards.update('d1', board() as never);
    await vi.advanceTimersByTimeAsync(600);
    await second;
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(2);
  });
});
