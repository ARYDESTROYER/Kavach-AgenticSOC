/**
 * `DashboardBuilder` tests (Round 5 / G7; Round 14, SPEC §2.2 item 8 and §4.4.5): one
 * personal board's body in view mode and in Edit mode.
 *
 * The load-bearing assertions:
 *   1. VIEW mode by default: no edit band, no save bar. The board page's "Edit" (here a
 *      small host harness, since Edit mode is controlled by the host) turns on Edit mode.
 *   2. SAVE calls `api.dashboards.update(id, layout)` with the edited widget list (a layout
 *      is advisory; it never feeds `decide()`, #3); the unsaved `board=new` draft CREATES.
 *   3. RESET to the default layout deletes the saved copy via `api.dashboards.remove`.
 *   4. A role default saved as "Overview" saves its new name "My dashboard".
 *   5. The board names its reads up front and never bills the model (#6, #7).
 *
 * Auth is off (transparent grants), the RGL edit surface is mocked, and the widget data
 * calls are mocked offline.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

// Mock the RGL edit surface so edit mode renders synchronously without a real grid.
vi.mock('@/soc/dashboard/EditableGrid', () => {
  const ReactMod = require('react');
  return {
    default: ({
      widgets,
      renderItem,
    }: {
      widgets: unknown[];
      renderItem: (w: unknown) => React.ReactNode;
    }) =>
      ReactMod.createElement(
        'div',
        { 'data-testid': 'editable-grid' },
        widgets.map((w, i) => ReactMod.createElement('div', { key: i }, renderItem(w))),
      ),
  };
});

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
  dashboards: {
    update: vi.fn(),
    remove: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    clone: vi.fn(),
  },
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
import { DashboardBuilder, type DashboardBuilderProps } from '@/soc/dashboard/DashboardBuilder';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

import { OPEN_BY_VERDICT } from '../dashboard/__tests__/dashboard-fixtures';

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

const DASHBOARD: DashboardLayout = {
  id: 'overview',
  name: 'Overview',
  schema_version: 1,
  columns: 12,
  widgets: [w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} })],
};

/** The board page's part: Edit mode is controlled by the host and turned on by "Edit". */
function Harness(props: Partial<DashboardBuilderProps> & { dashboard: DashboardLayout; startEditing?: boolean }) {
  const { startEditing = false, ...rest } = props;
  const [editing, setEditing] = React.useState(startEditing);
  return (
    <>
      <button type="button" data-testid="host-edit" onClick={() => setEditing(true)}>
        Edit
      </button>
      <span data-testid="host-mode">{editing ? 'edit' : 'view'}</span>
      <DashboardBuilder {...rest} editing={editing} onEditingChange={setEditing} />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Auth OFF: hasPermission() === true.
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
  apiMocks.getMetrics.mockResolvedValue({ needs_human_cases: 1, open_cases: 2, cost: {} });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.standup.mockResolvedValue({ enabled: false });
  apiMocks.get.mockResolvedValue({ sources: [] });
  fetchPostureMock.mockResolvedValue({ window_hours: 168, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [] });
  apiMocks.dashboards.update.mockImplementation(async (_id: string, body: DashboardLayout) => ({ ...body }));
  apiMocks.dashboards.create.mockImplementation(async (body: DashboardLayout) => ({ ...body, id: 'dash-new-1' }));
  apiMocks.dashboards.remove.mockResolvedValue({ ok: true, id: 'overview' });
  breakdownMock.mockResolvedValue(OPEN_BY_VERDICT);
});

function renderBuilder(props: Partial<DashboardBuilderProps> & { startEditing?: boolean } = {}) {
  return render(
    <AuthProvider>
      <Harness dashboard={DASHBOARD} {...props} />
    </AuthProvider>,
  );
}

describe('DashboardBuilder: view mode, then Edit mode from the host', () => {
  it('starts in view mode with no edit band or save bar, then enters Edit mode', async () => {
    renderBuilder();
    expect(await screen.findByTestId('widget-grid-view')).toBeInTheDocument();
    expect(screen.queryByText('Save dashboard')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add widget/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('host-edit'));
    expect(await screen.findByText('Save dashboard')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add widget/i })).toBeInTheDocument();
    expect(await screen.findByTestId('editable-grid')).toBeInTheDocument();
  });

  it('Discard leaves Edit mode and calls the host back', async () => {
    const onDiscard = vi.fn();
    renderBuilder({ startEditing: true, onDiscard });
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('host-mode')).toHaveTextContent('view');
  });
});

describe('DashboardBuilder: persistence (#3: a layout is advisory, never decide())', () => {
  it('Save calls api.dashboards.update with the board id and widgets, then leaves Edit mode', async () => {
    const onSaved = vi.fn();
    renderBuilder({ onSaved, startEditing: true });

    fireEvent.click(await screen.findByText('Save dashboard'));

    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const [id, layout, opts] = apiMocks.dashboards.update.mock.calls[0];
    expect(id).toBe('overview');
    expect(layout.id).toBe('overview');
    expect(opts).toEqual({ immediate: true });
    expect(Array.isArray(layout.widgets)).toBe(true);
    expect(layout.widgets[0].type).toBe('kpi.needs_human');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.getByTestId('host-mode')).toHaveTextContent('view');
  });

  it('a role default stored as "Overview" shows "My dashboard" and saves that name', async () => {
    renderBuilder({ startEditing: true });
    const nameInput = (await screen.findByTestId('dashboard-name-input')) as HTMLInputElement;
    expect(nameInput.value).toBe('My dashboard');
    fireEvent.click(screen.getByText('Save dashboard'));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    expect(apiMocks.dashboards.update.mock.calls[0][1].name).toBe('My dashboard');
  });

  it('the unsaved new draft creates the board (no id, the server mints one)', async () => {
    const onSaved = vi.fn();
    const draft: DashboardLayout = { id: 'new', name: 'Untitled dashboard', schema_version: 1, columns: 12, widgets: [] };
    render(
      <AuthProvider>
        <Harness dashboard={draft} createOnSave persisted={false} isDefaultBoard={false} startEditing onSaved={onSaved} />
      </AuthProvider>,
    );
    const nameInput = (await screen.findByTestId('dashboard-name-input')) as HTMLInputElement;
    expect(nameInput.value).toBe('Untitled dashboard');
    fireEvent.change(nameInput, { target: { value: 'Night shift triage' } });
    // No reset or delete for a board that is not stored yet.
    expect(screen.queryByRole('button', { name: 'More dashboard actions' })).toBeNull();
    fireEvent.click(screen.getByText('Save dashboard'));

    await waitFor(() => expect(apiMocks.dashboards.create).toHaveBeenCalledTimes(1));
    const body = apiMocks.dashboards.create.mock.calls[0][0];
    expect(body.id).toBe('');
    expect(body.name).toBe('Night shift triage');
    expect(apiMocks.dashboards.update).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'dash-new-1' })));
  });

  it('Reset to default layout removes the saved copy via api.dashboards.remove', async () => {
    const onReset = vi.fn();
    renderBuilder({ onReset, startEditing: true });

    fireEvent.click(await screen.findByText('Reset to default layout'));
    expect(await screen.findByText('Reset My dashboard to the default layout?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }));

    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    await waitFor(() => expect(onReset).toHaveBeenCalled());
  });
});

describe('DashboardBuilder: #6/#7: a board bills zero model calls (H3)', () => {
  it('never calls api.standup and reads only what the placed widgets read', async () => {
    // One `kpi.needs_human` widget: it reads only the open cases by AI verdict
    // (`breakdown`, Round 14 F4), never the `metrics` status count.
    renderBuilder();
    await waitFor(() => expect(breakdownMock).toHaveBeenCalledTimes(1));
    expect(breakdownMock).toHaveBeenCalledWith(
      expect.objectContaining({ by: 'verdict', status_group: 'open', window: 'all' }),
      expect.anything(),
    );
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
    expect(apiMocks.standup).not.toHaveBeenCalled();
    expect(fetchPostureMock).not.toHaveBeenCalled();
    expect(fetchMitreMock).not.toHaveBeenCalled();
    expect(apiMocks.listCases).not.toHaveBeenCalled();
    expect(apiMocks.get).not.toHaveBeenCalledWith('sources/health');
  });

  it('an empty board reads nothing (no round trip, no usage row)', async () => {
    const empty: DashboardLayout = { ...DASHBOARD, widgets: [] };
    render(
      <AuthProvider>
        <Harness dashboard={empty} />
      </AuthProvider>,
    );
    expect(await screen.findByTestId('widget-grid-empty')).toBeInTheDocument();
    expect(apiMocks.standup).not.toHaveBeenCalled();
    expect(apiMocks.getMetrics).not.toHaveBeenCalled();
    expect(breakdownMock).not.toHaveBeenCalled();
    expect(fetchPostureMock).not.toHaveBeenCalled();
    expect(fetchMitreMock).not.toHaveBeenCalled();
    expect(apiMocks.listCases).not.toHaveBeenCalled();
    expect(apiMocks.get).not.toHaveBeenCalledWith('sources/health');
  });
});
