/**
 * Round-6 regression: CustomizationSection must NOT wipe the other org customization
 * fields. (Round 16 B45 removed its "Save default" theme control, so nothing here writes
 * the org object any more; Branding holds the one organization default theme.)
 *
 * `PUT /api/prefs/org` REPLACES the whole customization object (no server-side merge), so
 * sending a partial `{ default_theme }` used to silently blank the org terminology, shared
 * saved views, pinned view ids, and per-role default dashboards. The fix spreads the FULL
 * loaded org into the patch, overriding only the theme (+ the latest terminology draft).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const FULL_ORG = {
  terminology: { case: 'incident' },
  default_theme: 'system',
  default_saved_views: [{ id: 'v-org', name: 'Org triage', scope: 'cases', shared: true }],
  default_pinned_view_ids: ['v-org'],
  default_dashboards: { analyst_tier1: { widgets: [{ id: 'w1', kind: 'kpi', x: 0, y: 0, w: 2, h: 1 }] } },
};

const mocks = {
  effective: vi.fn(),
  getOrg: vi.fn(),
  putOrg: vi.fn().mockResolvedValue(FULL_ORG),
  putUser: vi.fn().mockResolvedValue({}),
  terminologyPut: vi.fn().mockResolvedValue({}),
  authMe: vi.fn().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null }),
};

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      prefs: {
        effective: () => mocks.effective(),
        getUser: vi.fn(),
        putUser: (p: unknown) => mocks.putUser(p),
        getOrg: () => mocks.getOrg(),
        putOrg: (o: unknown) => mocks.putOrg(o),
        tables: { put: vi.fn() },
      },
      views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), clone: vi.fn() },
      terminology: { get: vi.fn(), put: (t: unknown) => mocks.terminologyPut(t) },
      getBranding: vi.fn().mockResolvedValue({}),
      auth: { me: () => mocks.authMe() },
      roles: { get: vi.fn().mockResolvedValue({ matrix: {}, rbac_enabled: false }) },
    },
  };
});

import { ThemeProvider } from '../../theme';
import { AuthProvider } from '../../auth';
import { PrefsProvider } from '../../prefs';
import { CustomizationSection } from '../CustomizationSection';
import type { EffectivePrefs } from '@/lib/types';

const EMPTY_EFFECTIVE: EffectivePrefs = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: {},
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ...EMPTY_EFFECTIVE });
  mocks.getOrg.mockResolvedValue({ ...FULL_ORG });
  mocks.putOrg.mockResolvedValue({ ...FULL_ORG });
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

function renderSection() {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>
          <CustomizationSection />
        </PrefsProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}

describe('CustomizationSection — org defaults save (Round-6 clobber fix)', () => {
  it('uses the shared section heading and flat saved-view boundary', async () => {
    mocks.effective.mockResolvedValue({
      ...EMPTY_EFFECTIVE,
      saved_views: [{ id: 'mine', name: 'My queue', scope: 'cases', shared: false }],
    });
    renderSection();

    expect(
      await screen.findByRole('heading', { name: 'Appearance', level: 2 }),
    ).toBeInTheDocument();
    // The cascade is read once GET /api/auth/me has answered (no read without a session),
    // so the saved views land a moment after the section's heading.
    const list = await screen.findByTestId('saved-views-list');
    expect(list).toHaveClass('border-y', 'divide-y');
    expect(list.className).not.toMatch(/rounded|shadow|bg-card/);
  });

  it('offers a compact, labelled System / Light / Dark control and persists every choice', async () => {
    renderSection();

    const group = await screen.findByRole('radiogroup', { name: 'Personal colour mode' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(within(group).getByRole('radio', { name: 'Light' }));
    await waitFor(() =>
      expect(mocks.putUser).toHaveBeenLastCalledWith({ theme_mode: 'light' }),
    );
    expect(window.localStorage.getItem('soc.theme')).toBe('light');

    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    await waitFor(() => {
      expect(mocks.putUser).toHaveBeenLastCalledWith({ theme_mode: 'dark' });
      expect(document.documentElement).toHaveClass('dark');
    });
    expect(window.localStorage.getItem('soc.theme')).toBe('dark');

    fireEvent.click(within(group).getByRole('radio', { name: 'System' }));
    await waitFor(() =>
      expect(mocks.putUser).toHaveBeenLastCalledWith({ theme_mode: 'system' }),
    );
    expect(window.localStorage.getItem('soc.theme')).toBe('system');
  });

  it('never writes the org customization object (Round 16 B45: no second theme control)', async () => {
    renderSection();
    await waitFor(() => expect(mocks.getOrg).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /save default/i })).toBeNull();
    // Saving terminology goes through its own route and carries only the labels, so the
    // org saved views, pinned ids and dashboards can never be wiped from here.
    fireEvent.click(await screen.findByRole('button', { name: /save terminology/i }));
    await waitFor(() => expect(mocks.terminologyPut).toHaveBeenCalledTimes(1));
    expect(mocks.terminologyPut).toHaveBeenCalledWith(FULL_ORG.terminology);
    expect(mocks.putOrg).not.toHaveBeenCalled();
  });
});
