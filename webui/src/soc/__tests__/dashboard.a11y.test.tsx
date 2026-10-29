/**
 * Custom dashboard (WidgetGrid, VIEW mode): jest-axe accessibility smoke (Round-5 G9 ·
 * DESIGN_STANDARD §6 / G7).
 *
 * The user-composed dashboard canvas (`soc/dashboard`): a grid of widget cards, each a
 * titled region with a body chart/KPI. VIEW mode ships zero react-grid-layout JS (the
 * RGL module factory is spied and asserted never-evaluated elsewhere) so this smoke
 * audits the plain-CSS-grid render: heading/region labelling, chart-text semantics,
 * KPI tiles. We render <WidgetGrid editing={false}/> inside DashboardDataProvider with
 * offline data mocks, wait for a widget body, and assert no axe violations.
 *
 * It also holds the OTHER half of the KPI drill-down's ARIA contract. The landing strip's
 * tile is a DIALOG TRIGGER: it opts into `aria-haspopup="dialog"` (`KpiTile`'s
 * `ariaHasPopup`) and deliberately carries neither `aria-expanded` nor `aria-controls`:
 * those are DISCLOSURE semantics, wrong on a dialog trigger, and a portalled panel that
 * does not exist while it is closed can never be a valid `aria-controls` target.
 *
 * Every OTHER consumer, the custom-dashboard widgets here among them, must emit NONE of
 * the three. A tile that navigates or merely reports would be lying to assistive tech if
 * it promised a dialog it can never open, exactly as it used to be lying if it announced a
 * collapsed state it can never expand.
 *
 * Offline: no network, no #3 / runtime behaviour touched.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

// Spy on react-grid-layout to keep VIEW mode honest (it must not be imported); the
// factory throwing/rendering nothing is fine: view mode never reaches it.
const rglEvaluated = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-grid-layout', () => {
  rglEvaluated.count += 1;
  const ReactMod = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) =>
      ReactMod.createElement('div', { 'data-testid': 'rgl-mock' }, children),
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
  usageSummary: vi.fn(),
}));
// The real module keeps `ApiError` and `request` (a load error renders through them).
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: apiMocks }));
// "Awaiting a decision" counts open cases by AI verdict through the breakdown endpoint (F4).
const { breakdownMock } = vi.hoisted(() => ({ breakdownMock: vi.fn() }));
vi.mock('@/lib/api-dashboards', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-dashboards')>()),
  getMetricsBreakdown: breakdownMock,
}));

import { WidgetGrid } from '@/soc/dashboard/WidgetGrid';
import { DashboardDataProvider, useDashboardData } from '@/soc/dashboard/DashboardDataProvider';
import type { DashboardWidget } from '@/lib/types';

import { OPEN_BY_VERDICT, USAGE } from '../dashboard/__tests__/dashboard-fixtures';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

/**
 * Whether every read the board started has landed (hidden, so axe never sees it). The
 * checks run only once the board is settled: an answer that landed during the axe pass
 * would re-render the board outside `act`.
 */
function ReadsProbe() {
  const { loading } = useDashboardData();
  return <span hidden data-testid="reads" data-settled={loading ? 'no' : 'yes'} />;
}

async function settled() {
  await waitFor(() => expect(screen.getByTestId('reads')).toHaveAttribute('data-settled', 'yes'), { timeout: 5000 });
}

const WIDGETS: DashboardWidget[] = [
  w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} }),
  w({ i: 'b', type: 'kpi.cost_budget', x: 3, y: 0, w: 3, h: 3, options: {} }),
  // Round 14: the figure widgets draw a plain figure; the timing module draws KPI tiles.
  w({ i: 'c', type: 'kpi.lifecycle_timing', x: 0, y: 3, w: 12, h: 2, options: {} }),
];

beforeEach(() => {
  vi.clearAllMocks();
  rglEvaluated.count = 0;
  apiMocks.getMetrics.mockResolvedValue({
    total_cases: 5, open_cases: 2, needs_human_cases: 1,
    cost: { total_cost: 1.23, currency: 'USD', call_count: 7 },
  });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  apiMocks.usageSummary.mockResolvedValue(USAGE);
  breakdownMock.mockResolvedValue(OPEN_BY_VERDICT);
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [], covered_techniques: 0, total_techniques: 0 });
});

describe('Custom dashboard (WidgetGrid view): a11y smoke (jest-axe)', () => {
  it('has no axe violations on the view-mode widget grid', async () => {
    const { container } = render(
      <DashboardDataProvider>
        <WidgetGrid widgets={WIDGETS} editing={false} />
        <ReadsProbe />
      </DashboardDataProvider>,
    );
    // The plain-CSS grid renders (no RGL) and the widget bodies resolve their titles.
    expect(screen.getByTestId('widget-grid-view')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Awaiting a decision')).toBeInTheDocument(), {
      timeout: 5000,
    });
    await settled();
    expect(await axe(container)).toHaveNoViolations();
    // View mode shipped zero grid JS.
    expect(rglEvaluated.count).toBe(0);
  });

  it('leaves widget KPI tiles free of the dialog-trigger ARIA the landing strip opts into', async () => {
    const { container } = render(
      <DashboardDataProvider>
        <WidgetGrid widgets={WIDGETS} editing={false} />
        <ReadsProbe />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getByText('Awaiting a decision')).toBeInTheDocument(), {
      timeout: 5000,
    });

    // The timing module's tiles land with the posture answer.
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="kpi-"]').length).toBeGreaterThan(0));
    await settled();
    const tiles = container.querySelectorAll('[data-testid^="kpi-"]');
    for (const tile of Array.from(tiles)) {
      // `aria-haspopup` is the LIVE half: it is the one prop `KpiTile` still exposes for
      // the landing strip, so it is the one a copy-paste could actually spread onto a
      // widget. Absent, not "false": it defaults to `undefined` and is then not rendered
      // at all, so a widget tile makes no popup claim it cannot honour.
      expect(tile).not.toHaveAttribute('aria-haspopup');
      // The two retired disclosure attributes, kept as regression guards: `KpiTile` no
      // longer accepts them from ANY consumer, and a tile that re-grew either would be
      // announcing a state it cannot enter and a target that does not exist.
      expect(tile).not.toHaveAttribute('aria-expanded');
      expect(tile).not.toHaveAttribute('aria-controls');
    }
    // And no drill-down panel exists to be opened from here. `document`, NOT the render
    // container: the panel is a Radix Dialog portalled to `document.body`, so a
    // container-scoped query could not see one even if a widget tile grew a drill-down,
    // which is exactly the regression this line is here to catch.
    expect(document.querySelector('[data-testid="kpi-drilldown"]')).toBeNull();
  });
});
