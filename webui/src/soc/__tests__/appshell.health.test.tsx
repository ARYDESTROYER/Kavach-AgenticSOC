/**
 * AppShell — the single Agent-health reader (Round-12).
 *
 * The dashboard's `role="alert"` degradation strip was retired. The shell now reads the two
 * health signals ONCE, at a fixed 24h window, and hands the reduced result to the bell.
 * This spec pins the three things that are the shell's, not the bell's:
 *
 *   1. ZERO REQUESTS when the api client does not expose the endpoints. The self-gate is
 *      what lets every other AppShell spec keep a trimmed api mock — if the shell ever
 *      started requesting unconditionally, those specs would begin flushing promises after
 *      render and emit `act()` warnings, which `npm run test:strict` treats as failures.
 *   2. the marker + the accessible state on the bell trigger, wired end to end.
 *   3. the announcement, spoken through the shell's ONE `aria-live` region — an
 *      `aria-label` change is not a content mutation and is never announced on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { diagnosticsMock, autoCloseMock, exposeHealth } = vi.hoisted(() => ({
  diagnosticsMock: vi.fn(),
  autoCloseMock: vi.fn(),
  exposeHealth: { value: false },
}));

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
        org_name: '',
        product_name: '',
        logo_data_url: '',
        favicon_data_url: '',
        accent_color: '',
        accent_color2: '',
        theme: '',
        login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {},
          theme_mode: 'dark',
          saved_views: [],
          pinned_view_ids: [],
          tables: {},
          last_list_state: {},
          misc: {},
          org: {
            terminology: {},
            default_theme: 'dark',
            default_saved_views: [],
            default_pinned_view_ids: [],
          },
        }),
        putUser: ok({}),
      },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }), enable: ok({}) },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
      // Presence is the guard the shell reads, so it must be toggleable per test.
      get diagnosticsHealth() {
        return exposeHealth.value ? diagnosticsMock : undefined;
      },
      get autoCloseHealth() {
        return exposeHealth.value ? autoCloseMock : undefined;
      },
    },
  };
});

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';
import type { AutoCloseHealth, DiagnosticsHealth } from '@/lib/types';
import { autoClose, health } from '../components/__tests__/health-fixtures';

function renderShell() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page="overview" onNavigate={vi.fn()}>
                  <div>routed content</div>
                </AppShell>
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

const FAILED_MIGRATION: DiagnosticsHealth = (() => {
  const base = health();
  return {
    ...base,
    schema_migration: { ...base.schema_migration, state: 'failed', failed: true },
  };
})();
const HEALTHY_AUTO_CLOSE: AutoCloseHealth = autoClose();

function setDesktopViewport() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
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

describe('AppShell — Agent health ownership', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setDesktopViewport();
    exposeHealth.value = false;
    diagnosticsMock.mockReset().mockResolvedValue(FAILED_MIGRATION);
    autoCloseMock.mockReset().mockResolvedValue(HEALTHY_AUTO_CLOSE);
  });

  it('issues ZERO health requests when neither endpoint is exposed', async () => {
    renderShell();

    // The bell's own label starts "Notifications, …"; the nav also has a Notifications
    // settings entry, so anchor the match rather than substring-matching both.
    await screen.findByRole('button', { name: /^Notifications, / });
    expect(diagnosticsMock).not.toHaveBeenCalled();
    expect(autoCloseMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('notification-bell-health-marker')).toBeNull();
  });

  it('marks the bell and announces the degradation once the signals report one', async () => {
    exposeHealth.value = true;
    renderShell();

    await waitFor(() => expect(diagnosticsMock).toHaveBeenCalled());
    // The FIXED shell window — the shell has no operator time range to inherit.
    expect(diagnosticsMock).toHaveBeenCalledWith(24, expect.anything());

    const trigger = await screen.findByRole('button', {
      name: /agent health needs attention/i,
    });
    expect(trigger).toContainElement(screen.getByTestId('notification-bell-health-marker'));

    // The shell's ONE live region, not a per-component one, carries the spoken state.
    await waitFor(() => {
      const spoken = Array.from(document.querySelectorAll('[aria-live]'))
        .map((node) => node.textContent ?? '')
        .join(' ');
      expect(spoken).toMatch(/agent health needs attention: state-schema migration failed/i);
    });
  });
});
