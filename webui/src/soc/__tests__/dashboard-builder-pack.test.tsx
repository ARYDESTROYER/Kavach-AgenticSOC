/**
 * `DashboardBuilder` view↔edit packing parity (Round-6 dashboards integration).
 *
 * VIEW mode flow-packs an all-at-origin per-role default (WidgetGrid → packWidgets) into
 * a coherent grid. Before this fix, the FIRST edit-mode entry handed RGL the raw
 * all-(0,0) widgets and RGL vertical-compacted them into a single column, a visible
 * "jump". `toDraft` now packs the widgets up front so the draft RGL receives the SAME
 * geometry the view shows, and the freshly-seeded draft reads CLEAN (not dirty).
 *
 * WidgetGrid / provider / gallery / config are mocked so the builder renders
 * synchronously; the mock captures the `widgets` it is handed so we can assert geometry.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

const gridHolder = vi.hoisted(() => ({ widgets: null as Array<Record<string, number>> | null }));

vi.mock('@/soc/dashboard/WidgetGrid', () => {
  const React = require('react');
  return {
    WidgetGrid: (props: { widgets: Array<Record<string, number>> }) => {
      gridHolder.widgets = props.widgets;
      return React.createElement('div', { 'data-testid': 'widget-grid-mock' });
    },
  };
});
vi.mock('@/soc/dashboard/DashboardDataProvider', () => ({
  DashboardDataProvider: ({ children }: { children: React.ReactNode }) => children,
  DASHBOARD_AUTO_REFRESH_MS: 60_000,
  useOptionalDashboardData: () => null,
}));
vi.mock('@/soc/dashboard/WidgetGallery', () => ({ WidgetGallery: () => null }));
vi.mock('@/soc/dashboard/WidgetConfigSheet', () => ({ WidgetConfigSheet: () => null }));
vi.mock('@/soc/components/Can', () => ({ Can: ({ children }: { children: React.ReactNode }) => children }));

const apiMocks = vi.hoisted(() => ({
  dashboards: { update: vi.fn(), remove: vi.fn(), create: vi.fn(), list: vi.fn(), clone: vi.fn() },
}));
vi.mock('@/lib/api', () => ({
  api: apiMocks,
  ApiError: class ApiError extends Error {},
}));

import { DashboardBuilder, compactVertically } from '@/soc/dashboard/DashboardBuilder';
import { BUILTIN_BOARDS } from '@/soc/dashboard/builtins';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

/** The board page's part: Edit mode is controlled by the host and turned on by "Edit". */
function Harness({ dashboard }: { dashboard: DashboardLayout }) {
  const [editing, setEditing] = React.useState(false);
  return (
    <>
      <button type="button" data-testid="dashboard-edit-btn" onClick={() => setEditing(true)}>
        Edit
      </button>
      <DashboardBuilder dashboard={dashboard} editing={editing} onEditingChange={setEditing} />
    </>
  );
}

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

/** True if any two rectangles overlap (touching edges do NOT count). */
function anyOverlap(ws: Array<Record<string, number>>): boolean {
  for (let i = 0; i < ws.length; i += 1) {
    for (let j = i + 1; j < ws.length; j += 1) {
      const a = ws[i];
      const b = ws[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return true;
    }
  }
  return false;
}

// A per-role DEFAULT: every widget seeded at the origin (RGL is expected to pack them).
const ORIGIN_DEFAULT: DashboardLayout = {
  id: 'overview',
  name: 'Overview',
  schema_version: 1,
  columns: 12,
  widgets: [
    w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} }),
    w({ i: 'b', type: 'gauge.active_risk', x: 0, y: 0, w: 3, h: 4, options: {} }),
    w({ i: 'c', type: 'chart.verdict_mix', x: 0, y: 0, w: 4, h: 4, options: {} }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  gridHolder.widgets = null;
  apiMocks.dashboards.update.mockResolvedValue({ ...ORIGIN_DEFAULT });
});

describe('DashboardBuilder: first edit entry seeds packed (non-overlapping) geometry', () => {
  it('flow-packs an all-at-origin default so the edit draft never overlaps', () => {
    render(<Harness dashboard={ORIGIN_DEFAULT} />);
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));

    const ws = gridHolder.widgets!;
    expect(ws).toHaveLength(3);
    // No two widgets share the top-left pile: packed into a coherent grid.
    expect(anyOverlap(ws)).toBe(false);
    // At least one widget moved OFF (0,0): the pile was actually spread out.
    expect(ws.some((g) => g.x !== 0 || g.y !== 0)).toBe(true);
  });

  it('entering edit on the packed default is CLEAN, not dirty', () => {
    render(<Harness dashboard={ORIGIN_DEFAULT} />);
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));
    // The sticky bar shows the calm "Editing …" hint, not an unsaved-changes warning:
    // view-pack and draft-pack are byte-identical, so seeding the draft can't dirty it.
    // Scope to the VISIBLE bar (the StickySaveBar mirrors its message into a sr-only
    // aria-live region too, so an unscoped getByText would match twice).
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(
      within(bar).getByText('Drag, resize, add or remove widgets, then save.'),
    ).toBeInTheDocument();
    expect(
      within(bar).queryByText('You have unsaved changes to this dashboard.'),
    ).not.toBeInTheDocument();
  });
});

describe('DashboardBuilder: the seeded draft is compacted the way the Edit grid compacts', () => {
  // The super admin role default: a 4-wide and a 6-wide widget, then a 3-wide one that
  // wraps, then a full-width one. react-grid-layout pulls the 3-wide widget up under the
  // shorter neighbour when Edit mode mounts; the draft must already hold that geometry,
  // or opening Edit reads as an unsaved change and asks "Discard changes?" on the way out.
  const ADMIN_DEFAULT: DashboardLayout = {
    id: 'overview',
    name: 'My dashboard',
    schema_version: 1,
    columns: 12,
    widgets: [
      w({ i: 'cost', type: 'kpi.cost_budget', x: 0, y: 0, w: 4, h: 4, options: {} }),
      w({ i: 'conn', type: 'table.connector_health', x: 0, y: 0, w: 6, h: 5, options: {} }),
      w({ i: 'need', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} }),
      w({ i: 'time', type: 'kpi.lifecycle_timing', x: 0, y: 0, w: 12, h: 3, options: {} }),
    ],
  };

  it('pulls a wrapped widget up under its shorter neighbour, as the grid does', () => {
    render(<Harness dashboard={ADMIN_DEFAULT} />);
    const byId = Object.fromEntries((gridHolder.widgets ?? []).map((g) => [(g as unknown as { i: string }).i, g]));
    expect(byId.cost).toMatchObject({ x: 0, y: 0 });
    expect(byId.conn).toMatchObject({ x: 4, y: 0 });
    expect(byId.need).toMatchObject({ x: 0, y: 4 });
    expect(byId.time).toMatchObject({ x: 0, y: 7 });
    expect(anyOverlap(gridHolder.widgets!)).toBe(false);
  });

  it('leaves an already compact layout (every built-in board) unchanged', () => {
    for (const board of BUILTIN_BOARDS) {
      const once = compactVertically(board.widgets);
      expect(once.map((g) => [g.x, g.y, g.w, g.h])).toEqual(board.widgets.map((g) => [g.x, g.y, g.w, g.h]));
      expect(compactVertically(once)).toEqual(once);
    }
  });
});
