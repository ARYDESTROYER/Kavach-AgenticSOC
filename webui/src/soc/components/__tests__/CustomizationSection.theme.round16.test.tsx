/**
 * B45 (Round 16 SPEC §4.5 WP15E): Branding `default_theme` is the only organization theme
 * default. Appearance no longer offers a second "Organization default theme" control that
 * stored a different value; it shows the Branding value read-only and, for an
 * administrator, links to Branding to change it.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = {
  effective: vi.fn(),
  getOrg: vi.fn(),
  putOrg: vi.fn().mockResolvedValue({}),
  getBranding: vi.fn(),
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
        putUser: vi.fn().mockResolvedValue({}),
        getOrg: () => mocks.getOrg(),
        putOrg: (o: unknown) => mocks.putOrg(o),
        tables: { put: vi.fn() },
      },
      views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), clone: vi.fn() },
      terminology: { get: vi.fn(), put: vi.fn().mockResolvedValue({}) },
      getBranding: () => mocks.getBranding(),
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
  org: { terminology: {}, default_theme: 'light', default_saved_views: [], default_pinned_view_ids: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ...EMPTY_EFFECTIVE });
  // The legacy value disagrees with Branding, as in the bug report.
  mocks.getOrg.mockResolvedValue({ terminology: {}, default_theme: 'light' });
  mocks.getBranding.mockResolvedValue({ default_theme: 'dark' });
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

describe('B45: one organization theme default', () => {
  it('shows the Branding default read-only, with a link to Branding, and no second control', async () => {
    renderSection();
    expect(await screen.findByText(/Organization default: Dark\./)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Change it in Branding' });
    expect(link).toHaveAttribute('href', '#/settings?s=appearance');
    // The contradictory second control and its save are gone.
    expect(screen.queryByRole('combobox', { name: /Organization default theme/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save default/ })).toBeNull();
    expect(screen.queryByText(/Organization default: Light/)).toBeNull();
    expect(mocks.putOrg).not.toHaveBeenCalled();
  });

  it('follows Branding when it says System', async () => {
    mocks.getBranding.mockResolvedValue({ default_theme: 'system' });
    renderSection();
    expect(await screen.findByText(/Organization default: System\./)).toBeInTheDocument();
  });
});
