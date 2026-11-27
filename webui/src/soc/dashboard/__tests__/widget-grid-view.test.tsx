/**
 * F3 (Round 14, SPEC §4.4.5): in view mode a board's widgets are flow-packed on the 12
 * columns and sized to their content. No fixed 56 px rows, no clipped bodies, every body
 * on its own panel with no card around it; one column in reading order below `xl`.
 * Edit mode keeps fixed RGL cells, so there a tall body scrolls inside its panel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const rgl = vi.hoisted(() => ({ evaluated: 0 }));
vi.mock('react-grid-layout', () => {
  rgl.evaluated += 1;
  const ReactMod = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) => ReactMod.createElement('div', { 'data-testid': 'rgl-mock' }, children),
    useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('react-resizable/css/styles.css', () => ({}));

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

import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid, viewGridPlacement, type WidgetEditActions } from '@/soc/dashboard/WidgetGrid';
import type { DashboardWidget } from '@/lib/types';

import { COVERAGE, USAGE, fixtureBreakdown, fixtureGet, noise, posture, trends } from './dashboard-fixtures';

function w(i: string, type: string, x: number, y: number, width: number, h: number, options: Record<string, unknown> = {}): DashboardWidget {
  return { i, type, x, y, w: width, h, options } as unknown as DashboardWidget;
}

const actions: WidgetEditActions = {
  onConfigure: vi.fn(),
  onDuplicate: vi.fn(),
  onRemove: vi.fn(),
  onMove: vi.fn(),
  onResize: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  rgl.evaluated = 0;
  apiMocks.getMetrics.mockResolvedValue({ active_risk_index: 46, active_risk_case_count: 3 });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
  apiMocks.metricsTrends.mockResolvedValue(trends(24));
  apiMocks.noiseReduction.mockResolvedValue(noise());
  apiMocks.usageSummary.mockResolvedValue(USAGE);
  apiMocks.getAgentImprovement.mockResolvedValue({ metrics: {}, windows: {} });
  breakdownMock.mockImplementation((q: { by: string }) => fixtureBreakdown(q));
  fetchPostureMock.mockResolvedValue(posture());
  fetchMitreMock.mockResolvedValue(COVERAGE);
});

describe('viewGridPlacement (pure)', () => {
  it('turns each distinct top and bottom edge into an auto row track', () => {
    // A tall chart on the left beside two stacked tables on the right.
    const p = viewGridPlacement([
      w('chart', 'chart.case_trend', 0, 0, 8, 6),
      w('top', 'table.top_rules', 8, 0, 4, 3),
      w('bottom', 'table.workload', 8, 3, 4, 3),
      w('strip', 'kpi.strip', 0, 6, 12, 2),
    ]);
    expect(p.rows).toBe(3);
    const by = Object.fromEntries(p.items.map((it) => [String((it.widget as unknown as { i: string }).i), it]));
    expect(by.chart).toMatchObject({ colStart: 1, colSpan: 8, rowStart: 1, rowEnd: 3 });
    expect(by.top).toMatchObject({ colStart: 9, colSpan: 4, rowStart: 1, rowEnd: 2 });
    expect(by.bottom).toMatchObject({ colStart: 9, colSpan: 4, rowStart: 2, rowEnd: 3 });
    expect(by.strip).toMatchObject({ colStart: 1, colSpan: 12, rowStart: 3, rowEnd: 4 });
  });

  it('lists widgets in reading order (top to bottom, then left to right)', () => {
    const p = viewGridPlacement([
      w('c', 'table.workload', 6, 4, 6, 3),
      w('b', 'table.top_rules', 6, 0, 6, 4),
      w('a', 'kpi.strip', 0, 0, 6, 4),
      w('d', 'table.campaigns', 0, 4, 6, 3),
    ]);
    expect(p.items.map((it) => (it.widget as unknown as { i: string }).i)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('drops a band no widget covers, so a saved gap never leaves an empty row', () => {
    const p = viewGridPlacement([w('a', 'kpi.strip', 0, 0, 12, 2), w('b', 'table.workload', 0, 10, 12, 3)]);
    expect(p.rows).toBe(2);
    expect(p.items[1]).toMatchObject({ rowStart: 2, rowEnd: 3 });
  });

  it('flow-packs an unplaced default like edit mode does', () => {
    const p = viewGridPlacement([w('a', 'kpi.needs_human', 0, 0, 3, 3), w('b', 'kpi.cost_budget', 0, 0, 3, 3)]);
    expect(p.items[0].colStart).toBe(1);
    expect(p.items[1].colStart).toBe(4);
    expect(p.items[1].rowStart).toBe(1);
  });
});

describe('view mode (F3)', () => {
  const BOARD = [
    w('strip', 'kpi.strip', 0, 0, 12, 2, { preset: 'operations' }),
    w('queue', 'table.attention_queue', 0, 2, 8, 6),
    w('load', 'table.workload', 8, 2, 4, 6),
  ];

  it('has no fixed row height and sizes every row to its content', () => {
    render(
      <DashboardDataProvider objectScoped={false} widgets={BOARD}>
        <WidgetGrid widgets={BOARD} />
      </DashboardDataProvider>,
    );
    const grid = screen.getByTestId('widget-grid-view');
    expect(grid.style.gridAutoRows).toBe('');
    expect(grid.style.getPropertyValue('--wg-rows')).toBe('repeat(2, auto)');
    expect(grid.style.getPropertyValue('--wg-cols')).toBe('repeat(12, minmax(0, 1fr))');
    // One column below xl; the placement only applies from xl.
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('xl:[grid-template-rows:var(--wg-rows)]');
    const cells = Array.from(grid.children) as HTMLElement[];
    expect(cells.map((c) => c.style.getPropertyValue('--wg-col'))).toEqual(['1 / span 12', '1 / span 8', '9 / span 4']);
    expect(cells.map((c) => c.style.getPropertyValue('--wg-row'))).toEqual(['1 / 2', '2 / 3', '2 / 3']);
    // No inline placement a narrow screen could not undo.
    for (const c of cells) expect(c.style.gridColumn).toBe('');
  });

  it('never clips a body: no overflow-hidden and no inner scroll in view mode', async () => {
    render(
      <DashboardDataProvider objectScoped={false} widgets={BOARD}>
        <WidgetGrid widgets={BOARD} />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('Needs attention now').length).toBeGreaterThan(0));
    const grid = screen.getByTestId('widget-grid-view');
    // No frame around a body clips or scrolls it: not the grid cell, not the widget frame,
    // not the panel, not the panel's body. (A bar track or the KPI tile grid's hairline
    // frame clips its own drawing, inside the body; that is not a clipped widget.)
    const clipping = Array.from(grid.querySelectorAll<HTMLElement>('.overflow-hidden, .overflow-auto'));
    for (const el of clipping) {
      const where = el.outerHTML.slice(0, 120);
      expect(el.querySelector('[data-widget-body], .surface-panel'), where).toBeNull();
      expect(el.classList.contains('surface-panel'), where).toBe(false);
      expect(el.hasAttribute('data-widget-type') || el.hasAttribute('data-grid-cell'), where).toBe(false);
    }
    expect(rgl.evaluated).toBe(0);
  });

  it('puts each body straight on its panel, with no card around it', async () => {
    render(
      <DashboardDataProvider objectScoped={false} widgets={BOARD}>
        <WidgetGrid widgets={BOARD} />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('Analyst workload').length).toBeGreaterThan(0));
    for (const cell of Array.from(document.querySelectorAll('[data-widget-type]'))) {
      // The widget frame is not itself a surface; the body's panel is the only one.
      expect(cell.className).not.toMatch(/\b(border|shadow|rounded|bg-card)\b/);
      expect(cell.querySelectorAll('.surface-panel').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('edit mode', () => {
  it('keeps fixed cells: the body is clipped to its cell and scrolls inside its panel', async () => {
    const widgets = [w('rules', 'table.top_rules', 0, 0, 6, 4)];
    render(
      <DashboardDataProvider objectScoped={false} widgets={widgets}>
        <WidgetGrid widgets={widgets} editing onLayoutChange={vi.fn()} editActions={actions} />
      </DashboardDataProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('demo_noisy_scanner').length).toBeGreaterThan(0));
    const cell = document.querySelector('[data-widget-type="table.top_rules"]')!;
    expect(cell.querySelector('.overflow-hidden')).not.toBeNull();
    expect(cell.querySelector('.overflow-auto')).not.toBeNull();
    expect(rgl.evaluated).toBeGreaterThan(0);
  });
});
