/**
 * DashboardBuilder chrome tests (Round 6 shell-chrome batch; Round 14 Edit mode controlled
 * by the board page): the reset, rename, delete and debounce-cancel fixes.
 *
 *   - View mode draws no control band (the board page header owns the name and "Edit");
 *     Edit mode's band holds the name, "Add widget" and a labelled More menu.
 *   - The never-persisted role default offers no reset in the edit band (Discard already
 *     puts the role's layout back, as the header's More menu); the shared confirm flow
 *     still reverts such a board locally (no DELETE, no 404 error toast).
 *   - A reset from the edit band drops a changed draft (Edit again shows the role's
 *     layout, clean), and its confirm gives the focus back to its opener, or to the host's
 *     Edit button once Edit mode has closed.
 *   - A server 404 on delete is tolerated as success (the copy is already gone).
 *   - A user-created board shows "Delete dashboard" (permanent), not "Reset".
 *   - The board's name is editable in Edit mode and persists on Save.
 *   - A trailing geometry settle is cancelled on Discard so it cannot re-dirty the draft.
 *   - A layout report that restates the geometry (with `minW`/`minH` keys unset) is no
 *     edit, for widgets that carry no minimum size (a built-in copy).
 *   - Pressing Edit hands the focus to the name; a blocked Save says why.
 *
 * WidgetGrid, the data provider, the gallery and the config sheet are mocked so the builder
 * renders synchronously with zero grid JS and zero network.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

const gridHolder = vi.hoisted(() => ({ onLayoutChange: null as ((l: unknown[]) => void) | null }));

vi.mock('@/soc/dashboard/WidgetGrid', () => {
  const React = require('react');
  return {
    WidgetGrid: (props: { onLayoutChange?: (l: unknown[]) => void }) => {
      gridHolder.onLayoutChange = props.onLayoutChange ?? null;
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
  // Mirror the real client's `ApiError` (carries the HTTP status).
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { DashboardBuilder, useBoardRemoval, type DashboardBuilderProps } from '@/soc/dashboard/DashboardBuilder';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

/** The board page's part: Edit mode is controlled by the host and turned on by "Edit". */
function Harness(props: Partial<DashboardBuilderProps> & { dashboard: DashboardLayout }) {
  const [editing, setEditing] = React.useState(false);
  const editRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <>
      {editing ? null : (
        <button ref={editRef} type="button" data-testid="dashboard-edit-btn" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
      <DashboardBuilder
        returnFocusTarget={() => editRef.current}
        {...props}
        editing={editing}
        onEditingChange={setEditing}
      />
    </>
  );
}

/** The visible save bar shows `text` (the bar also mirrors it into a polite live region). */
function expectBar(text: string) {
  const bar = screen.getByRole('region', { name: 'Unsaved changes' });
  expect(within(bar).getByText(text)).toBeInTheDocument();
}

function w(partial: Record<string, unknown>): DashboardWidget {
  return partial as unknown as DashboardWidget;
}

const BOARD: DashboardLayout = {
  id: 'overview',
  name: 'Overview',
  schema_version: 1,
  columns: 12,
  widgets: [w({ i: 'a', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} })],
};

beforeEach(() => {
  vi.clearAllMocks();
  gridHolder.onLayoutChange = null;
  apiMocks.dashboards.update.mockResolvedValue({ ...BOARD });
  apiMocks.dashboards.remove.mockResolvedValue({ ok: true, id: 'overview' });
});

async function enterEdit() {
  fireEvent.click(await screen.findByTestId('dashboard-edit-btn'));
  await screen.findByText('Save dashboard');
}

describe('DashboardBuilder: adaptive controls', () => {
  it('draws no band in view mode; Edit mode has the name, Add widget and a More menu', async () => {
    render(<Harness dashboard={BOARD} />);

    // The board page header owns the name, the refresh and "Edit" (SPEC §2.2 item 8).
    expect(screen.queryByRole('group', { name: 'Dashboard view controls' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh dashboard data' })).toBeNull();

    await enterEdit();
    const editControls = screen.getByRole('group', { name: 'Dashboard editing controls' });
    expect(within(editControls).getByRole('button', { name: 'Add widget' })).toBeInTheDocument();
    expect(
      within(editControls).getByRole('button', { name: 'More dashboard actions' }),
    ).toHaveAttribute('aria-haspopup', 'menu');
  });
});

describe('DashboardBuilder: the never-persisted default has nothing to reset', () => {
  it('the edit band offers no reset (Discard already puts the role layout back)', async () => {
    render(<Harness dashboard={BOARD} persisted={false} />);
    await enterEdit();
    const band = screen.getByRole('group', { name: 'Dashboard editing controls' });
    expect(within(band).getByRole('button', { name: 'Add widget' })).toBeInTheDocument();
    expect(screen.queryByText('Reset to default layout')).toBeNull();
    expect(within(band).queryByRole('button', { name: 'More dashboard actions' })).toBeNull();
  });

  it('the shared confirm flow still reverts such a board locally (no DELETE, no 404 toast)', async () => {
    const onLocalRevert = vi.fn();
    const onDone = vi.fn();
    function Probe() {
      const removal = useBoardRemoval({ dashboard: BOARD, isDefaultBoard: true, persisted: false, onLocalRevert, onDone });
      return (
        <>
          <button type="button" onClick={removal.request}>
            Reset
          </button>
          {removal.dialog}
        </>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onLocalRevert).toHaveBeenCalled();
    expect(apiMocks.dashboards.remove).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Default layout restored');
  });
});

describe('DashboardBuilder: a reset from the edit band', () => {
  /** The host's part: a reset drops the stored board and shows the role's layout. */
  function ResettingHost() {
    const [board, setBoard] = React.useState<DashboardLayout>(BOARD);
    const [persisted, setPersisted] = React.useState(true);
    return (
      <Harness
        dashboard={board}
        persisted={persisted}
        onReset={() => {
          setPersisted(false);
          setBoard({ ...BOARD, name: 'My dashboard', widgets: [...(BOARD.widgets ?? [])] });
        }}
      />
    );
  }

  it('drops a changed draft: Edit again shows the role layout, clean', async () => {
    render(<ResettingHost />);
    await enterEdit();
    fireEvent.change(screen.getByTestId('dashboard-name-input'), { target: { value: 'My changed board' } });
    expectBar('You have unsaved changes to this dashboard.');

    const band = screen.getByRole('group', { name: 'Dashboard editing controls' });
    fireEvent.click(within(band).getAllByRole('button', { name: /Reset to default layout/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    await screen.findByTestId('dashboard-edit-btn');

    await enterEdit();
    expect(screen.getByTestId('dashboard-name-input')).toHaveValue('My dashboard');
    expectBar('Drag, resize, add or remove widgets, then save.');
  });

  it('Cancel gives the focus back to the control that opened the confirm', async () => {
    render(<Harness dashboard={BOARD} persisted />);
    await enterEdit();
    const band = screen.getByRole('group', { name: 'Dashboard editing controls' });
    const opener = within(band).getAllByRole('button', { name: /Reset to default layout/ })[0];
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('after the reset the focus goes to the host Edit button (the opener left with Edit mode)', async () => {
    render(<ResettingHost />);
    await enterEdit();
    const band = screen.getByRole('group', { name: 'Dashboard editing controls' });
    const opener = within(band).getAllByRole('button', { name: /Reset to default layout/ })[0];
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));
    const edit = await screen.findByTestId('dashboard-edit-btn');
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });
});

describe('DashboardBuilder: focus and a blocked Save', () => {
  it('pressing Edit hands the focus to the board name', async () => {
    render(<Harness dashboard={BOARD} />);
    await enterEdit();
    expect(document.activeElement).toBe(screen.getByTestId('dashboard-name-input'));
  });

  it('a blocked Save is disabled and the bar says why', async () => {
    const reason = 'You have 24 dashboards, the most allowed. Delete one to add another.';
    render(<Harness dashboard={BOARD} saveBlockedReason={reason} />);
    await enterEdit();
    expect(screen.getByRole('button', { name: 'Save dashboard' })).toBeDisabled();
    expectBar(reason);
  });
});

describe('DashboardBuilder: reset tolerates a server 404', () => {
  it('treats a 404 from remove() as success (copy already gone), no error toast', async () => {
    apiMocks.dashboards.remove.mockRejectedValueOnce(new ApiError(404, 'no dashboard overview'));
    const onReset = vi.fn();
    render(<Harness dashboard={BOARD} persisted onReset={onReset} />);
    await enterEdit();

    fireEvent.click(screen.getByText('Reset to default layout'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset layout' }));

    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    await waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('DashboardBuilder: user-created board deletes (accurate copy)', () => {
  it('shows "Delete dashboard" + a permanent-delete confirm, then removes', async () => {
    const board: DashboardLayout = { ...BOARD, id: 'dash-1', name: 'My board' };
    apiMocks.dashboards.remove.mockResolvedValue({ ok: true, id: 'dash-1' });
    const onReset = vi.fn();
    render(<Harness dashboard={board} isDefaultBoard={false} persisted onReset={onReset} />);
    await enterEdit();

    // The destructive control reads "Delete dashboard", not "Reset to default layout".
    expect(screen.getByText('Delete dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Reset to default layout')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete dashboard'));
    expect(await screen.findByText('Delete My board?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete dashboard' }));

    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('dash-1'));
    await waitFor(() => expect(onReset).toHaveBeenCalled());
  });
});

describe('DashboardBuilder: rename', () => {
  it('edits the dashboard name and persists it on Save', async () => {
    render(<Harness dashboard={BOARD} />);
    await enterEdit();

    // A role default stored as "Overview" reads as "My dashboard" (SPEC §4.4.1).
    const nameInput = screen.getByTestId('dashboard-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('My dashboard');
    fireEvent.change(nameInput, { target: { value: 'My Ops Board' } });

    fireEvent.click(screen.getByText('Save dashboard'));

    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const [, layout] = apiMocks.dashboards.update.mock.calls[0];
    expect(layout.name).toBe('My Ops Board');
  });
});

describe('DashboardBuilder: trailing geometry settle is cancelled on Discard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a pending layout settle does not re-dirty the draft after Discard', async () => {
    render(<Harness dashboard={BOARD} />);
    // Enter edit (fake timers → drive clicks directly).
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));
    expect(screen.getByText('Save dashboard')).toBeInTheDocument();

    // Schedule a debounced geometry settle that would move widget 'a'.
    act(() => {
      gridHolder.onLayoutChange?.([{ i: 'a', x: 6, y: 6, w: 4, h: 4 }]);
    });
    // Discard BEFORE the 200ms settle fires.
    fireEvent.click(screen.getByText('Discard'));
    // Let the (now-cancelled) timer window elapse.
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Re-enter edit: the draft must be CLEAN (the settle never re-applied post-discard).
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));
    // Scope to the VISIBLE sticky bar (role=region "Unsaved changes"): the StickySaveBar
    // also mirrors its message into a sr-only aria-live region, so an unscoped getByText
    // would match twice. The clean-draft state shows the calm hint, not "unsaved".
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(
      within(bar).getByText('Drag, resize, add or remove widgets, then save.'),
    ).toBeInTheDocument();
    expect(
      within(bar).queryByText('You have unsaved changes to this dashboard.'),
    ).not.toBeInTheDocument();
  });

  it('a layout that restates the geometry is no edit, for widgets with no minimum size', () => {
    // A built-in copy's widgets carry no minW/minH; the grid still reports both keys.
    const copy: DashboardLayout = {
      id: 'dash-copy',
      name: 'Executive summary (copy)',
      schema_version: 1,
      columns: 12,
      widgets: [
        w({ i: 'k', type: 'kpi.needs_human', x: 0, y: 0, w: 6, h: 3, options: {} }),
        w({ i: 'r', type: 'gauge.active_risk', x: 6, y: 0, w: 6, h: 4, options: {} }),
      ],
    };
    render(<Harness dashboard={copy} isDefaultBoard={false} />);
    fireEvent.click(screen.getByTestId('dashboard-edit-btn'));
    act(() => {
      gridHolder.onLayoutChange?.([
        { i: 'k', x: 0, y: 0, w: 6, h: 3, minW: undefined, minH: undefined, moved: false, static: false },
        { i: 'r', x: 6, y: 0, w: 6, h: 4, minW: undefined, minH: undefined, moved: false, static: false },
      ]);
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expectBar('Drag, resize, add or remove widgets, then save.');

    // A real move still counts.
    act(() => {
      gridHolder.onLayoutChange?.([
        { i: 'k', x: 0, y: 4, w: 6, h: 3 },
        { i: 'r', x: 6, y: 0, w: 6, h: 4 },
      ]);
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expectBar('You have unsaved changes to this dashboard.');
  });
});
