/**
 * AppShell demo-mode indicator (R12).
 *
 * The full-width DemoBanner used to sit ABOVE the routed content on every page and
 * consumed ~6.5rem of content real estate. It is gone: demo mode is now a compact
 * chip in the top bar's right cluster, beside the release badge, at every width —
 * it is never folded into the compact-controls Sheet, because a safety state is not
 * a secondary utility.
 *
 * These tests pin the placement + the preserved capability:
 *   - the chip lives inside the <header>, never inside <main>, and the routed content
 *     carries no banner copy at all;
 *   - it is absent entirely when demo is off;
 *   - its popover still offers Reset + Exit & clear to a `demo:manage` holder (and
 *     actually calls the endpoints), and hides those mutations without the grant while
 *     keeping the isolation copy;
 *   - only ONE live region announces the state: below the desktop breakpoint (where the
 *     health pill is not in the bar) the chip announces; on desktop it does not.
 *
 * The api client + every provider the shell consumes are mocked so the test is offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { demoStatusMock, demoResetMock, demoDisableMock, permissionState } = vi.hoisted(() => ({
  demoStatusMock: vi.fn(),
  demoResetMock: vi.fn(),
  demoDisableMock: vi.fn(),
  permissionState: { canManage: true },
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
      demo: {
        status: demoStatusMock,
        enable: ok({}),
        reset: demoResetMock,
        disable: demoDisableMock,
      },
      health: ok({ es_connected: true, store_type: 'memory', version: 'test' }),
      account: { get: ok({}) },
      search: ok({ query: '', cases: [], sources: [], nav: [] }),
    },
  };
});

// Only DemoIndicator consumes the RBAC helper inside the shell subtree, so a mutable
// mock here flips exactly the demo:manage grant.
vi.mock('@/soc/components/Can', () => ({
  useCan: () => permissionState.canManage,
}));

// Partial mock: ThemeProvider still renders sonner's real <Toaster>, we only silence
// the toast side-effects the demo actions fire.
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { AppShell } from '../AppShell';

const OFF = { mode: 'off' as const, active: false, run_id: null };
const ACTIVE = {
  mode: 'live' as const,
  active: true,
  run_id: 'demo-abc',
  seed: 1337,
  case_count: 42,
};

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

function renderShell() {
  const onNavigate = vi.fn();
  const result = render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <AppShell page="overview" onNavigate={onNavigate}>
                  <div data-testid="routed-content">routed content</div>
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

describe('AppShell demo indicator (R12)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setMobileViewport(false);
    permissionState.canManage = true;
    demoStatusMock.mockReset().mockResolvedValue(OFF);
    demoResetMock.mockReset().mockResolvedValue(ACTIVE);
    demoDisableMock.mockReset().mockResolvedValue(OFF);
  });

  it('renders no demo chrome anywhere while demo mode is off', async () => {
    renderShell();
    await screen.findByTestId('release-badge');
    await waitFor(() => expect(demoStatusMock).toHaveBeenCalled());
    expect(screen.queryByTestId('demo-indicator')).toBeNull();
    expect(document.body.textContent).not.toMatch(/simulated data/i);
  });

  it('puts the chip in the TOP BAR, not in the routed content', async () => {
    demoStatusMock.mockResolvedValue(ACTIVE);
    renderShell();

    const chip = await screen.findByTestId('demo-indicator');
    // Inside the sticky header, adjacent to the release badge.
    const header = chip.closest('header');
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByTestId('release-badge')).toBeInTheDocument();

    // The routed content area carries the page and nothing else — no banner, no
    // demo-only spacer row above the children.
    const main = screen.getByRole('main');
    expect(within(main).queryByTestId('demo-indicator')).toBeNull();
    expect(main.textContent).toBe('routed content');
    expect(main.querySelector('.mt-4')).toBeNull();
    expect(within(main).getByTestId('routed-content')).toBeInTheDocument();
  });

  it('keeps Reset + Exit & clear reachable from the chip popover for a demo:manage holder', async () => {
    demoStatusMock.mockResolvedValue(ACTIVE);
    renderShell();

    fireEvent.click(await screen.findByTestId('demo-indicator'));
    expect(await screen.findByText(/demo mode active \(simulated data\)/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }));
    await waitFor(() => expect(demoResetMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /exit & clear/i }));
    await waitFor(() => expect(demoDisableMock).toHaveBeenCalledTimes(1));
  });

  it('hides the mutations but keeps the safety copy without demo:manage', async () => {
    permissionState.canManage = false;
    demoStatusMock.mockResolvedValue(ACTIVE);
    renderShell();

    fireEvent.click(await screen.findByTestId('demo-indicator'));
    expect(await screen.findByText(/fully isolated live simulation dataset/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /exit & clear/i })).toBeNull();
  });

  it('announces the state exactly once: the health pill on desktop, the chip on mobile', async () => {
    demoStatusMock.mockResolvedValue(ACTIVE);
    const desktop = renderShell();
    const desktopChip = await screen.findByTestId('demo-indicator');
    // Desktop: the health pill (already flipped to "Demo mode") is the live region.
    expect(desktopChip).not.toHaveAttribute('aria-live');
    expect(screen.getByLabelText('Platform health: Demo mode')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    desktop.unmount();

    setMobileViewport(true);
    renderShell();
    const mobileChip = await screen.findByTestId('demo-indicator');
    // Mobile: the health pill is not in the bar, so the chip becomes the announcer.
    expect(mobileChip).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByLabelText('Platform health: Demo mode')).toBeNull();
  });
});
