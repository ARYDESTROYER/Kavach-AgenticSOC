/**
 * `Dashboards` page smoke test (Round 5 / G7; Round 14 library, SPEC §2.2 and §4.4.5): the
 * library and a personal board land calmly (#10) and ship ZERO grid JS (react-grid-layout's
 * module factory is never evaluated outside Edit mode).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }), Toaster: () => null }));

// Prove no RGL import outside Edit mode.
const rglEvaluated = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-grid-layout', () => {
  rglEvaluated.count += 1;
  const ReactMod = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) => ReactMod.createElement('div', null, children),
    useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('react-resizable/css/styles.css', () => ({}));

const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
}));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock, fetchMitreCoverage: fetchMitreMock };
});

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  standup: vi.fn(),
  get: vi.fn(),
  auth: { me: vi.fn() },
  roles: { get: vi.fn() },
  prefs: { putUser: vi.fn() },
  dashboards: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), clone: vi.fn() },
}));
// The real module keeps `ApiError` and `request` (a load error renders through them).
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMocks }));
// "Awaiting a decision" counts open cases by AI verdict through the breakdown endpoint (F4).
const { breakdownMock } = vi.hoisted(() => ({ breakdownMock: vi.fn() }));
vi.mock('@/lib/api-dashboards', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-dashboards')>()),
  getMetricsBreakdown: breakdownMock,
}));

import { AuthProvider } from '@/soc/auth';
import { RouterProvider } from '@/soc/router';
import { Dashboards } from '@/soc/pages/Dashboards';

import { OPEN_BY_VERDICT } from '../dashboard/__tests__/dashboard-fixtures';

function renderAt(hash: string) {
  window.history.replaceState(null, '', hash);
  return render(
    <AuthProvider>
      <RouterProvider>
        <Dashboards />
      </RouterProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rglEvaluated.count = 0;
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
  // No saved boards: "My dashboard" is the read-only per-role default.
  apiMocks.dashboards.list.mockResolvedValue({ dashboards: [] });
  apiMocks.getMetrics.mockResolvedValue({ needs_human_cases: 1, open_cases: 2, cost: {} });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [] });
  breakdownMock.mockResolvedValue(OPEN_BY_VERDICT);
});

afterEach(() => {
  window.history.replaceState(null, '', '#/');
});

describe('Dashboards page', () => {
  it('the library renders its header and cards with zero grid JS', async () => {
    renderAt('#/dashboards');
    expect(await screen.findByTestId('dashboards-header')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(await screen.findByTestId('dashboard-card-overview')).toBeInTheDocument();
    expect(rglEvaluated.count).toBe(0);
    // The library reads no figures: no widget source is fetched.
    expect(breakdownMock).not.toHaveBeenCalled();
    expect(apiMocks.standup).not.toHaveBeenCalled();
  });

  it('uses the shared blocking state while a personal board waits for the list', async () => {
    apiMocks.dashboards.list.mockReturnValue(new Promise(() => {}));
    renderAt('#/dashboards?board=overview');
    expect(await screen.findByRole('status', { name: 'Loading dashboard' })).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(screen.queryByTestId('widget-grid-view')).toBeNull();
  });

  it('renders the read-only per-role default with zero grid JS', async () => {
    renderAt('#/dashboards?board=overview');
    expect(await screen.findByRole('heading', { level: 1, name: 'My dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('widget-grid-view')).toBeInTheDocument());
    // A default-role widget resolves ("Awaiting a decision" is in every default set).
    await waitFor(
      () => {
        expect(breakdownMock).toHaveBeenCalled();
        expect(screen.getByText('Awaiting a decision')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(rglEvaluated.count).toBe(0);
    expect(apiMocks.standup).not.toHaveBeenCalled();
  });
});
