/**
 * SOC operations "Closed" counts one population in its figure, its context line and its
 * definition (Round 14 closing fix integ-04; SPEC §11.1 "KPI binding refinements":
 * "Closed" leaves analyst-policy closes out).
 *
 * The figure is posture `quality.terminal_cases`, which leaves analyst-policy closes out.
 * Its "of N" used to be `case_count` (New cases), which includes them, so with policy
 * closes in the window "Closed X of N" compared two populations and overstated how many
 * cases were still open. Now N is `quality.total_cases` (the same population), the policy
 * closes are named beside it, and the help tip says they are not counted.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, within } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  standup: vi.fn(),
  get: vi.fn(),
  metricsTrends: vi.fn(),
  noiseReduction: vi.fn(),
  usageSummary: vi.fn(),
  getAgentImprovement: vi.fn(),
  auth: { me: vi.fn() },
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMocks }));
const { breakdownMock } = vi.hoisted(() => ({ breakdownMock: vi.fn() }));
vi.mock('@/lib/api-dashboards', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-dashboards')>()),
  getMetricsBreakdown: breakdownMock,
}));
const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn(), fetchMitreMock: vi.fn() }));
vi.mock('@/soc/pages/Metrics.posture.api', async (orig) => ({
  ...(await orig<typeof import('@/soc/pages/Metrics.posture.api')>()),
  fetchPosture: fetchPostureMock,
  fetchMitreCoverage: fetchMitreMock,
}));

import type { DashboardWidget } from '@/lib/types';
import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { KPI_STRIP_BINDINGS } from '@/soc/dashboard/kpi-bindings';
import { closedContext } from '@/soc/dashboard/widgets/strip';

import { COVERAGE, fixtureBreakdown, fixtureGet, noise, posture, trends } from './dashboard-fixtures';

const STRIP = [{ i: 'strip', type: 'kpi.strip', x: 0, y: 0, w: 12, h: 3, options: { preset: 'operations' } }] as unknown as DashboardWidget[];

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
  apiMocks.metricsTrends.mockImplementation((hours: number) => Promise.resolve(trends(Math.min(hours, 24))));
  apiMocks.noiseReduction.mockResolvedValue(noise());
  breakdownMock.mockImplementation((q: { by: string }) => fixtureBreakdown(q));
  fetchMitreMock.mockResolvedValue(COVERAGE);
});

function renderStrip() {
  return render(
    <DashboardDataProvider window="now-24h" objectScoped={false} widgets={STRIP}>
      <WidgetGrid widgets={STRIP} />
    </DashboardDataProvider>,
  );
}

describe('closedContext', () => {
  it('names the window cases the figure counts', () => {
    expect(closedContext(posture(), 'last 24 hours')).toBe('of 38 created in the window');
  });

  it('with analyst-policy closes, counts the cases without them and names them beside it', () => {
    const p = posture();
    const withPolicy = { ...p, case_count: 38, quality: { ...p.quality, total_cases: 36, terminal_cases: 31, policy_closed_cases: 2 } };
    expect(closedContext(withPolicy, 'last 24 hours')).toBe('of 36 created, plus 2 closed by analyst policy');
  });

  it('falls back to the window phrase without the population, never to case_count', () => {
    expect(closedContext({ case_count: 38, quality: {} }, 'last 24 hours')).toBe('last 24 hours');
    expect(closedContext(undefined, 'last 24 hours')).toBe('last 24 hours');
  });
});

describe('the Closed cell', () => {
  it("states in its definition that analyst-policy closes are not counted", () => {
    const closed = KPI_STRIP_BINDINGS.find((b) => b.group === 'operations' && b.cell === 'closed');
    expect(closed?.definition).toBe(
      'Cases created in the window that are now closed or resolved, not counting closes by an analyst policy.',
    );
    expect(closed?.source).toMatchObject({ field: 'quality.terminal_cases' });
  });

  it('reads one population on the board when the window holds analyst-policy closes', async () => {
    const p = posture();
    fetchPostureMock.mockResolvedValue({
      ...p,
      case_count: 38,
      quality: { ...p.quality, total_cases: 36, terminal_cases: 31, policy_closed_cases: 2 },
    });
    const { container } = renderStrip();
    const strip = container.querySelector('[data-widget-type="kpi.strip"]') as HTMLElement;
    await waitFor(() => expect(within(strip).getByTestId('kpi-strip-closed').textContent).toContain('31'));
    const closed = within(strip).getByTestId('kpi-strip-closed');
    expect(closed.textContent).toContain('of 36 created, plus 2 closed by analyst policy');
    // New cases still counts every case created in the window.
    expect(within(strip).getByTestId('kpi-strip-new_cases').textContent).toContain('38');
  });
});
