/**
 * `WidgetGrid` tests (Round 5 / G7, CD3): the two-mode grid.
 *
 * The load-bearing assertions:
 *   1. VIEW mode renders every widget and imports ZERO react-grid-layout: the RGL
 *      module factory (mocked with a spy) is NEVER evaluated in view mode. This is the
 *      "view mode + first paint ship zero grid JS" invariant, asserted at the module
 *      level (EditableGrid is the sole RGL importer and it is only reached via a
 *      dynamic import() from edit mode).
 *   2. EDIT mode lazily loads the RGL surface: the mocked RGL is evaluated + rendered.
 *   3. Keyboard MOVE: arrow keys on a widget's drag grip call `onMove` (WCAG 2.5.7).
 *   4. ALLOWLIST: an unknown widget type degrades to an "Unavailable widget" empty
 *      state, never throwing / never a rogue body.
 *
 * The widget bodies read shared data from `DashboardDataProvider`; the data calls are
 * mocked offline (mirrors `dashboard-data-provider.test.tsx`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---- Spy on react-grid-layout to prove it is NOT imported in view mode ---- //
const rglEvaluated = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-grid-layout', () => {
  // This factory runs ONLY when `react-grid-layout` is first imported: i.e. when the
  // lazy EditableGrid chunk is loaded in edit mode. If it never runs, view mode pulled
  // no grid JS.
  rglEvaluated.count += 1;
  const React = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) => (
      React.createElement('div', { 'data-testid': 'rgl-mock' }, children)
    ),
    useContainerWidth: () => ({
      width: 1200,
      mounted: true,
      containerRef: { current: null },
      measureWidth: () => {},
    }),
  };
});
// The RGL CSS the lazy chunk imports: stub so the import resolves under vitest.
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('react-resizable/css/styles.css', () => ({}));

// ---- Offline data mocks for the widget bodies (via DashboardDataProvider) --- //
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

import { WidgetGrid, type WidgetEditActions } from '@/soc/dashboard/WidgetGrid';
import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import type { DashboardWidget } from '@/lib/types';

import { OPEN_BY_VERDICT, USAGE } from '../dashboard/__tests__/dashboard-fixtures';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

const WIDGETS: DashboardWidget[] = [
  w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} }),
  w({ i: 'b', type: 'kpi.cost_budget', x: 3, y: 0, w: 3, h: 3, options: {} }),
];

const noopActions: WidgetEditActions = {
  onConfigure: vi.fn(),
  onDuplicate: vi.fn(),
  onRemove: vi.fn(),
  onMove: vi.fn(),
  onResize: vi.fn(),
};

function renderGrid(ui: React.ReactNode) {
  return render(<DashboardDataProvider>{ui}</DashboardDataProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  rglEvaluated.count = 0;
  apiMocks.getMetrics.mockResolvedValue({
    total_cases: 5,
    open_cases: 2,
    needs_human_cases: 1,
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

describe('WidgetGrid: VIEW mode (zero grid JS)', () => {
  it('renders every widget WITHOUT importing react-grid-layout', async () => {
    renderGrid(<WidgetGrid widgets={WIDGETS} editing={false} />);

    // The view container renders (plain CSS grid, not RGL).
    expect(screen.getByTestId('widget-grid-view')).toBeInTheDocument();
    expect(screen.queryByTestId('rgl-mock')).not.toBeInTheDocument();

    // Both widget bodies resolve their titles (Round 14 names).
    await waitFor(() => {
      expect(screen.getByText('Awaiting a decision')).toBeInTheDocument();
    });
    expect(screen.getByText('AI spend')).toBeInTheDocument();

    // THE lock: react-grid-layout was never evaluated in view mode.
    expect(rglEvaluated.count).toBe(0);
  });

  it('shows an empty state for a dashboard with no widgets', () => {
    renderGrid(<WidgetGrid widgets={[]} editing={false} />);
    expect(screen.getByTestId('widget-grid-empty')).toBeInTheDocument();
    expect(rglEvaluated.count).toBe(0);
  });

  it('ALLOWLIST: an unknown widget type degrades to an "Unavailable widget" state', async () => {
    renderGrid(
      <WidgetGrid
        widgets={[w({ i: 'x', type: 'evil.injected', x: 0, y: 0, w: 3, h: 3 })]}
        editing={false}
      />,
    );
    expect(await screen.findByText('Unavailable widget')).toBeInTheDocument();
    // No throw, no rogue body, still zero grid JS.
    expect(rglEvaluated.count).toBe(0);
  });
});

describe('WidgetGrid: EDIT mode (lazy RGL)', () => {
  it('lazily loads the react-grid-layout surface in edit mode', async () => {
    renderGrid(
      <WidgetGrid
        widgets={WIDGETS}
        editing
        onLayoutChange={vi.fn()}
        editActions={noopActions}
      />,
    );
    // The lazy EditableGrid resolves and mounts the (mocked) RGL grid.
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    // NOW react-grid-layout has been evaluated (exactly once).
    expect(rglEvaluated.count).toBeGreaterThan(0);
  });

  it('KEYBOARD MOVE: arrow keys on a widget grip call onMove (WCAG 2.5.7)', async () => {
    const onMove = vi.fn();
    renderGrid(
      <WidgetGrid
        widgets={[WIDGETS[0]]}
        editing
        onLayoutChange={vi.fn()}
        editActions={{ ...noopActions, onMove }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());

    // The drag grip is a focusable button; arrow keys move the widget.
    const grip = await screen.findByLabelText(/Move or resize/i);
    fireEvent.keyDown(grip, { key: 'ArrowRight' });
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ i: 'a' }), 'right');

    // Explicit non-drag "Move left" button also works.
    fireEvent.click(screen.getByLabelText('Move left'));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ i: 'a' }), 'left');
  });
});
