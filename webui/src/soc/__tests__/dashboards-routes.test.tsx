/**
 * Dashboards routes and boards (Round 14, SPEC §2.2 items 4 to 8, §4.4.4 to §4.4.6).
 *
 * Pins, through the real router and the real board page (`BoardView`):
 *   - the route table: the library, each built-in board, a personal board, the unsaved
 *     role default, a `u:` alias, the `new` draft, the landing board normalised to
 *     `#/overview`, and an unknown or deleted board (toast, address replaced);
 *   - the board page header (back link, title, badge, help tip, time range, refresh,
 *     actions) and the top-bar breadcrumb trail;
 *   - Back returns to the library (opening a board is a history entry);
 *   - the leave guard on a changed board, through the back link, a router move that stays
 *     on `#/dashboards` (the navigation's Dashboards item and the breadcrumb) and another
 *     page;
 *   - Duplicate (a copy without the panels the role cannot read, opened in Edit mode; the
 *     24-board limit), Hide with Undo, Rename, Delete, Reset (from the header and from the
 *     Edit band, which drops a changed draft), and the new draft's Save (its new address
 *     taken only once the list holds it) and Discard; a new draft, and My dashboard before
 *     its first Save, at the limit (no Save, no Rename; a stored My dashboard still saves);
 *   - a personal board keeps the panels the role cannot read ("No access", saved back);
 *   - a create while the list failed reads the list again instead of inventing one;
 *   - focus: each dialog returns it to its opener, and an in-page move that removes the
 *     pressed control hands it to the main landmark, the board's card or "Edit";
 *   - the board window reaches every windowed read; view mode never loads
 *     react-grid-layout; no widget calls the billing standup; a Demo switch reads again;
 *     row-level scope; permission denied; and no em dash in the board copy.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  fn.success = vi.fn();
  fn.error = vi.fn();
  return fn;
});
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

const rglEvaluated = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-grid-layout', () => {
  rglEvaluated.count += 1;
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
  roles: { get: vi.fn() },
  prefs: { effective: vi.fn(), putUser: vi.fn() },
  dashboards: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
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
const demo = vi.hoisted(() => ({ identity: 'off' }));
vi.mock('@/soc/chat/demo-identity', () => ({ useChatDemoIdentity: () => demo.identity }));

import { AuthProvider } from '@/soc/auth';
import { PrefsProvider } from '@/soc/prefs';
import { ThemeProvider } from '@/soc/theme';
import { RouterProvider, useRoute } from '@/soc/router';
import { navStore } from '@/soc/nav-store';
import { Dashboards } from '@/soc/pages/Dashboards';
import { boardAlias } from '@/soc/dashboard/builtins';
import { canUseWidget, getWidgetDef } from '@/soc/dashboard/registry';
import { BUILTIN_BOARDS } from '@/soc/dashboard/builtins';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';

import {
  AGENT_IMPROVEMENT,
  COVERAGE,
  USAGE,
  fixtureBreakdown,
  fixtureGet,
  noise,
  posture,
  trends,
} from '../dashboard/__tests__/dashboard-fixtures';

// --------------------------------------------------------------------------- //
// Harness
// --------------------------------------------------------------------------- //

const routeRef: { current: ReturnType<typeof useRoute> | null } = { current: null };

function RouteProbe() {
  const route = useRoute();
  routeRef.current = route;
  return <span data-testid="route">{`${route.page}|${route.opts?.board ?? ''}`}</span>;
}

/** The page shown for the current route (only the Dashboards page is real here). */
function Page() {
  const { page } = useRoute();
  return page === 'dashboards' ? <Dashboards /> : <p data-testid="other-page">{page}</p>;
}

/** The providers, the route probe and the routed main landmark the shell gives a page. */
function Tree() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>
          <RouterProvider>
            <RouteProbe />
            <main id="socMain" tabIndex={-1}>
              <Page />
            </main>
          </RouterProvider>
        </PrefsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

function renderAt(hash: string) {
  window.history.replaceState(null, '', hash);
  return render(<Tree />);
}

function stored(id: string, name: string, extra: Partial<DashboardLayout> = {}): DashboardLayout {
  return {
    id,
    name,
    schema_version: 1,
    columns: 12,
    widgets: [{ i: `${id}-a`, type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} } as DashboardWidget],
    updated_at: '2026-10-28T10:00:00Z',
    ...extra,
  };
}

const route = () => screen.getByTestId('route').textContent;

/** Open the board's More menu from the keyboard (Radix opens menus on Enter). */
function openMore() {
  const trigger = screen.getByRole('button', { name: 'More dashboard actions' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}
const boardTitle = (name: string) => screen.findByRole('heading', { level: 1, name });

function authOff() {
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
}

function authAs(role: string, grants: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  apiMocks.auth.me.mockResolvedValue({ authenticated: true, auth_enabled: true, user: { username: 'ana', role }, ...extra });
  apiMocks.roles.get.mockResolvedValue({ matrix: { [role]: grants }, rbac_enabled: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  rglEvaluated.count = 0;
  demo.identity = 'off';
  routeRef.current = null;
  authOff();
  apiMocks.prefs.effective.mockResolvedValue({ misc: {} });
  apiMocks.prefs.putUser.mockResolvedValue({});
  apiMocks.dashboards.list.mockResolvedValue({ dashboards: [] });
  apiMocks.dashboards.create.mockImplementation(async (body: DashboardLayout) => ({
    ...body,
    id: 'dash-copy-1',
    created_at: '2026-10-29T00:00:00Z',
    updated_at: '2026-10-29T00:00:00Z',
  }));
  apiMocks.dashboards.update.mockImplementation(async (id: string, body: DashboardLayout) => ({ ...body, id }));
  apiMocks.dashboards.remove.mockResolvedValue({ ok: true });
  apiMocks.getMetrics.mockResolvedValue({ active_risk_index: 46, active_risk_case_count: 3 });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.get.mockImplementation((path: string) => fixtureGet(path));
  apiMocks.metricsTrends.mockImplementation((hours: number) => Promise.resolve(trends(Math.min(hours, 24))));
  apiMocks.noiseReduction.mockResolvedValue(noise());
  apiMocks.usageSummary.mockResolvedValue(USAGE);
  apiMocks.getAgentImprovement.mockResolvedValue(AGENT_IMPROVEMENT);
  breakdownMock.mockImplementation((q: { by: string }) => fixtureBreakdown(q));
  fetchPostureMock.mockResolvedValue(posture());
  fetchMitreMock.mockResolvedValue(COVERAGE);
});

afterEach(() => {
  navStore.setTrail('dashboards', null);
  window.history.replaceState(null, '', '#/');
});

// --------------------------------------------------------------------------- //
// Route table (§2.2 item 4)
// --------------------------------------------------------------------------- //

describe('Routes', () => {
  it('#/dashboards shows the library', async () => {
    renderAt('#/dashboards');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Built-in' })).toBeInTheDocument();
  });

  it.each([
    ['builtin:soc-operations', 'SOC operations'],
    ['builtin:detection-data-health', 'Detection and data health'],
    ['builtin:executive-summary', 'Executive summary'],
  ])('board=%s shows %s', async (id, name) => {
    renderAt(`#/dashboards?board=${encodeURIComponent(id)}`);
    expect(await boardTitle(name)).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-board')).toHaveAttribute('data-board-kind', 'builtin');
  });

  it('the landing board is the landing page itself (#/overview, replaced)', async () => {
    renderAt('#/dashboards?board=builtin%3Acyber-defence-center');
    await waitFor(() => expect(route()).toBe('overview|'));
    expect(window.location.hash).toBe('#/overview');
  });

  it('a personal board opens in view mode; overview is My dashboard (the role default when unsaved)', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    expect(await boardTitle('Night shift triage')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-board')).toHaveAttribute('data-board-kind', 'personal');
    expect(screen.queryByText('Save dashboard')).toBeNull();
  });

  it('the unsaved role default opens under board=overview', async () => {
    renderAt('#/dashboards?board=overview');
    expect(await boardTitle('My dashboard')).toBeInTheDocument();
    // Nothing stored yet: no reset in the More menu.
    openMore();
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reset to default layout' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // Nor in the Edit band (Discard already puts the role layout back).
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByText('Save dashboard');
    expect(screen.queryByText('Reset to default layout')).toBeNull();
  });

  it('a board stored under a reserved id opens through its u: alias', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('new', 'Older board')] });
    renderAt(`#/dashboards?board=${encodeURIComponent(boardAlias('new'))}`);
    expect(await boardTitle('Older board')).toBeInTheDocument();
  });

  it('board=new opens the builder in Edit mode on an untitled draft', async () => {
    renderAt('#/dashboards?board=new');
    expect(await boardTitle('Untitled dashboard')).toBeInTheDocument();
    expect(await screen.findByText('Save dashboard')).toBeInTheDocument();
    expect((screen.getByTestId('dashboard-name-input') as HTMLInputElement).value).toBe('Untitled dashboard');
  });

  it.each(['dash-gone', 'builtin:no-such-board', 'u:00000000'])(
    'board=%s that names no board shows the library with a toast, address replaced',
    async (param) => {
      renderAt(`#/dashboards?board=${encodeURIComponent(param)}`);
      expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('That dashboard is not available.'));
      expect(toastMock.error).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(window.location.hash).toBe('#/dashboards'));
      expect(route()).toBe('dashboards|');
    },
  );

  it('a personal board waits for the list, and a failed list says the board could not load', async () => {
    apiMocks.dashboards.list.mockRejectedValueOnce(new Error('down'));
    renderAt('#/dashboards?board=dash-night');
    expect(await screen.findByText('This dashboard could not be loaded.')).toBeInTheDocument();
    apiMocks.dashboards.list.mockResolvedValueOnce({ dashboards: [stored('dash-night', 'Night shift triage')] });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await boardTitle('Night shift triage')).toBeInTheDocument();
  });

  it('without metrics:view a board link says the viewer has no access', async () => {
    authAs('auditor', { audit: ['view'] });
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    expect(await screen.findByText('You do not have access to dashboards.')).toBeInTheDocument();
    expect(breakdownMock).not.toHaveBeenCalled();
    expect(fetchPostureMock).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- //
// Board page header, breadcrumb, Back
// --------------------------------------------------------------------------- //

describe('Board page', () => {
  it('header: back link, title, badge, help tip, time range, refresh and the built-in actions', async () => {
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    const title = await boardTitle('SOC operations');
    const header = screen.getByTestId('dashboard-board-header');
    const back = within(header).getByRole('link', { name: 'All dashboards' });
    expect(back).toHaveAttribute('href', '#/dashboards');
    // The back link comes first, above the title.
    expect(back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(header).getByText('Built-in')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Time range: Last 24 hours' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Refresh dashboard' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Duplicate to customise' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'More dashboard actions' })).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(within(header).getByRole('button', { name: 'About SOC operations' }));
    expect(await screen.findByText('For SOC managers and shift leads. Is the team keeping up today?')).toBeInTheDocument();
  });

  it('the top bar trail reads Dashboards / <board> while a board is open, and clears in the library', async () => {
    renderAt('#/dashboards?board=builtin%3Aexecutive-summary');
    await boardTitle('Executive summary');
    await waitFor(() =>
      expect(navStore.getState().trail).toEqual({
        page: 'dashboards',
        items: [{ label: 'Dashboards', page: 'dashboards' }, { label: 'Executive summary' }],
      }),
    );
    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    await waitFor(() => expect(navStore.getState().trail).toBeNull());
  });

  it('opening a board is a history entry: Back returns to the library', async () => {
    renderAt('#/dashboards');
    const card = await screen.findByRole('link', { name: 'SOC operations' });
    fireEvent.click(card);
    expect(await boardTitle('SOC operations')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/dashboards?board=builtin%3Asoc-operations');
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(route()).toBe('dashboards|');
  });

  it('the detection board starts on 7 days, and a new window reaches every windowed read', async () => {
    renderAt('#/dashboards?board=builtin%3Adetection-data-health');
    await boardTitle('Detection and data health');
    expect(screen.getByRole('button', { name: 'Time range: Last 7 days' })).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.noiseReduction).toHaveBeenCalledWith(168));
    await waitFor(() =>
      expect(breakdownMock).toHaveBeenCalledWith(expect.objectContaining({ by: 'rule', window: 'now-168h' }), expect.anything()),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Time range: Last 7 days' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Last 30 days/ }));
    expect(screen.getByRole('button', { name: 'Time range: Last 30 days' })).toBeInTheDocument();
    await waitFor(() => expect(apiMocks.noiseReduction).toHaveBeenCalledWith(720));
    await waitFor(() =>
      expect(breakdownMock).toHaveBeenCalledWith(expect.objectContaining({ by: 'rule', window: 'now-720h' }), expect.anything()),
    );
    // Only the four whole windows are offered (no custom range).
    fireEvent.click(screen.getByRole('button', { name: 'Time range: Last 30 days' }));
    const group = await screen.findByRole('group', { name: 'Relative time ranges' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Last 24 hoursnow-24h',
      'Last 7 daysnow-7d',
      'Last 30 daysnow-30d',
      'Last 90 daysnow-90d',
    ]);
  });

  it('view mode draws no react-grid-layout surface, and no board reads the billing standup', async () => {
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    await waitFor(() => expect(fetchPostureMock).toHaveBeenCalled());
    // (The module itself is never evaluated in view mode: dashboards-page.test.tsx.)
    expect(screen.getByTestId('widget-grid-view')).toBeInTheDocument();
    expect(screen.queryByTestId('rgl-mock')).toBeNull();
    expect(apiMocks.standup).not.toHaveBeenCalled();
    expect(apiMocks.get).not.toHaveBeenCalledWith('standup', expect.anything());
    expect(apiMocks.get.mock.calls.map((c) => c[0])).not.toContain('standup');
  });

  it('the refresh reads the board again', async () => {
    renderAt('#/dashboards?board=builtin%3Aexecutive-summary');
    await boardTitle('Executive summary');
    await waitFor(() => expect(fetchPostureMock).toHaveBeenCalled());
    const before = fetchPostureMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh dashboard' }));
    await waitFor(() => expect(fetchPostureMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('a Demo switch reads the board again', async () => {
    const view = renderAt('#/dashboards?board=builtin%3Aexecutive-summary');
    await boardTitle('Executive summary');
    await waitFor(() => expect(fetchPostureMock).toHaveBeenCalled());
    const before = fetchPostureMock.mock.calls.length;
    demo.identity = 'demo:run-2';
    view.rerender(<Tree />);
    await waitFor(() => expect(fetchPostureMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('with row-level scope on, the board says how many panels are unavailable', async () => {
    authAs('soc_manager', { metrics: ['view'], cases: ['read'], cost: ['view'], sources: ['read'], automation: ['read'] }, {
      object_scoped: true,
    });
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    expect(await screen.findByTestId('dashboard-access-note')).toHaveTextContent(/panels need permissions your role does not have\./);
  });
});

// --------------------------------------------------------------------------- //
// Leave guard (W3 hand-off: useNavigationBlocker sameRoute)
// --------------------------------------------------------------------------- //

describe('Leave guard on a changed board', () => {
  async function editMyDashboard() {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('overview', 'Overview')] });
    renderAt('#/dashboards?board=overview');
    await boardTitle('My dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = await screen.findByTestId('dashboard-name-input');
    fireEvent.change(name, { target: { value: 'My changed board' } });
  }

  it('the All dashboards link asks first; Keep editing stays, Discard opens the library', async () => {
    await editMyDashboard();
    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard changes to My dashboard?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(route()).toBe('dashboards|overview');
    expect(screen.getByTestId('dashboard-name-input')).toHaveValue('My changed board');

    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(route()).toBe('dashboards|');
  });

  it('the navigation Dashboards item and the breadcrumb (a router move on #/dashboards) ask first', async () => {
    await editMyDashboard();
    act(() => routeRef.current!.navigate('dashboards'));
    expect(await screen.findByRole('alertdialog', { name: 'Discard changes to My dashboard?' })).toBeInTheDocument();
    expect(route()).toBe('dashboards|overview');
  });

  it('leaving for another page asks first', async () => {
    await editMyDashboard();
    act(() => routeRef.current!.navigate('cases'));
    expect(await screen.findByRole('alertdialog', { name: 'Discard changes to My dashboard?' })).toBeInTheDocument();
    expect(screen.queryByTestId('other-page')).toBeNull();
  });

  it('an unchanged board in Edit mode leaves without asking', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('overview', 'Overview')] });
    renderAt('#/dashboards?board=overview');
    await boardTitle('My dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByText('Save dashboard');
    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Duplicate, hide, rename, delete, reset, new (§4.4.6)
// --------------------------------------------------------------------------- //

describe('Board actions', () => {
  it('Duplicate copies the built-in without the panels the role cannot read and opens the copy in Edit mode', async () => {
    const grants = { metrics: ['view'], cases: ['read'] };
    authAs('analyst_tier1', grants);
    renderAt('#/dashboards?board=builtin%3Aexecutive-summary');
    await boardTitle('Executive summary');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate Executive summary?' });
    expect(within(dialog).getByText(/You get an editable copy in your dashboards, opened in Edit mode\./)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Executive summary (copy)');
    expect(within(dialog).getByText('Copies every panel, its position and the default window (last 30 days).')).toBeInTheDocument();
    expect(within(dialog).getByText('Panels your role cannot read are left out of the copy.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate and edit' }));

    await waitFor(() => expect(apiMocks.dashboards.create).toHaveBeenCalledTimes(1));
    const body = apiMocks.dashboards.create.mock.calls[0][0] as DashboardLayout;
    const can = (r: string, a: string) => (grants as Record<string, string[]>)[r]?.includes(a) ?? false;
    const exec = BUILTIN_BOARDS.find((b) => b.id === 'builtin:executive-summary')!;
    const readable = exec.widgets.filter((w) => canUseWidget(getWidgetDef(w.type)!, can));
    expect(readable.length).toBeLessThan(exec.widgets.length);
    expect(body).toMatchObject({
      id: '',
      name: 'Executive summary (copy)',
      default_window: 'now-30d',
      derived_from: 'builtin:executive-summary',
    });
    expect((body.widgets ?? []).map((w) => w.type)).toEqual(readable.map((w) => w.type));
    expect(toastMock.success).toHaveBeenCalledWith('Copy created. Your changes are saved to the copy only.');
    // The copy opens in Edit mode at its own address (a history entry).
    expect(await boardTitle('Executive summary (copy)')).toBeInTheDocument();
    expect(await screen.findByText('Save dashboard')).toBeInTheDocument();
    expect(route()).toBe('dashboards|dash-copy-1');
    // Its help tip says where it came from.
    fireEvent.click(screen.getByRole('button', { name: 'About Executive summary (copy)' }));
    expect(await screen.findByText(/^Copied from Executive summary\./)).toBeInTheDocument();
  });

  it('at 24 dashboards Duplicate explains the limit and cannot be pressed', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: Array.from({ length: 24 }, (_, i) => stored(`dash-${i}`, `Board ${i}`)),
    });
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    await waitFor(() => expect(apiMocks.dashboards.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate SOC operations?' });
    await waitFor(() =>
      expect(within(dialog).getByText('You have 24 dashboards, the most allowed. Delete one to add another.')).toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('button', { name: 'Duplicate and edit' })).toBeDisabled();
  });

  it('a failed copy keeps the dialog open and gives the reason', async () => {
    apiMocks.dashboards.create.mockRejectedValueOnce(new Error('dashboard limit reached (max 24)'));
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate SOC operations?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate and edit' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.error.mock.calls[0][0]).toBe('The copy could not be created.');
    expect(screen.getByRole('dialog', { name: 'Duplicate SOC operations?' })).toBeInTheDocument();
  });

  it('Hide writes the preference, returns to the library and offers Undo', async () => {
    renderAt('#/dashboards?board=builtin%3Adetection-data-health');
    await boardTitle('Detection and data health');
    openMore();
    expect(await screen.findByRole('menuitem', { name: 'Built-in boards cannot be edited' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from my list' }));

    await waitFor(() =>
      expect(apiMocks.prefs.putUser).toHaveBeenCalledWith({ misc: { dashboards_hidden: ['builtin:detection-data-health'] } }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Detection and data health' })).toBeNull();
    expect(toastMock.success).toHaveBeenCalledWith(
      'Detection and data health is hidden.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
    const undo = toastMock.success.mock.calls[0][1].action.onClick as () => void;
    await act(async () => undo());
    await waitFor(() => expect(apiMocks.prefs.putUser).toHaveBeenLastCalledWith({ misc: { dashboards_hidden: [] } }));
    expect(await screen.findByRole('link', { name: 'Detection and data health' })).toBeInTheDocument();
  });

  it('Rename writes the new name through an update', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename dashboard' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Night shift' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    expect(apiMocks.dashboards.update.mock.calls[0][0]).toBe('dash-night');
    expect(apiMocks.dashboards.update.mock.calls[0][1].name).toBe('Night shift');
    expect(await boardTitle('Night shift')).toBeInTheDocument();
  });

  it('an empty name cannot be saved', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename dashboard' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByText('Enter a name.')).toBeInTheDocument();
    expect(apiMocks.dashboards.update).not.toHaveBeenCalled();
  });

  it('Delete removes a personal board and replaces the address with the library', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete dashboard' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Night shift triage?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete dashboard' }));
    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('dash-night'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/dashboards');
    expect(screen.queryByRole('link', { name: 'Night shift triage' })).toBeNull();
    expect(toastMock.success).toHaveBeenCalledWith('Dashboard deleted');
    // No "not available" toast for a board the person just deleted.
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('Reset to default layout drops the stored My dashboard and shows the role default', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('overview', 'Overview')] });
    renderAt('#/dashboards?board=overview');
    await boardTitle('My dashboard');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset to default layout' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset My dashboard to the default layout?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    expect(route()).toBe('dashboards|overview');
    // The role default is not stored: no reset offered any more.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    openMore();
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reset to default layout' })).toBeNull();
  });

  it('Edit mode draws the react-grid-layout surface only when entered', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    expect(screen.queryByTestId('rgl-mock')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByTestId('rgl-mock')).toBeInTheDocument();
    // While editing, the header's actions give way to the edit band.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: /Add widget/ })).toBeInTheDocument();
  });

  it('the new draft saves as a new board and takes its own address (replaced)', async () => {
    renderAt('#/dashboards?board=new');
    const name = await screen.findByTestId('dashboard-name-input');
    fireEvent.change(name, { target: { value: 'Hunting' } });
    fireEvent.click(screen.getByText('Save dashboard'));
    await waitFor(() => expect(apiMocks.dashboards.create).toHaveBeenCalledTimes(1));
    expect(apiMocks.dashboards.create.mock.calls[0][0]).toMatchObject({ id: '', name: 'Hunting' });
    expect(await boardTitle('Hunting')).toBeInTheDocument();
    await waitFor(() => expect(route()).toBe('dashboards|dash-copy-1'));
    expect(window.location.hash).toBe('#/dashboards?board=dash-copy-1');
    expect(screen.queryByText('Save dashboard')).toBeNull();
  });

  it('saving the new draft never resolves the new address as a missing board', async () => {
    renderAt('#/dashboards?board=new');
    await screen.findByTestId('dashboard-name-input');
    // A browser schedules the save's continuation (no event in flight) at default
    // priority and the router's update for the replaced address (inside a hashchange) at
    // discrete priority, so the two render apart. jsdom under React's development build
    // keeps `window.event` set to the last React event, which would batch them; emulate
    // the browser: only an event dispatched on the window is current, while it runs.
    const own = Object.getOwnPropertyDescriptor(window, 'event');
    const dispatch = window.dispatchEvent.bind(window);
    let inFlight: Event | undefined;
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      const outer = inFlight;
      inFlight = event;
      try {
        return dispatch(event);
      } finally {
        inFlight = outer;
      }
    });
    Object.defineProperty(window, 'event', { configurable: true, get: () => inFlight, set: () => undefined });
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // A native click outside act(), so React schedules the work itself.
      screen.getByRole('button', { name: 'Save dashboard' }).click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = previous;
      spy.mockRestore();
      if (own) Object.defineProperty(window, 'event', own);
      else delete (window as { event?: unknown }).event;
    }
    await waitFor(() => expect(route()).toBe('dashboards|dash-copy-1'));
    expect(await boardTitle('Untitled dashboard')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/dashboards?board=dash-copy-1');
    expect(toastMock.error).not.toHaveBeenCalledWith('That dashboard is not available.');
  });

  it('Discard on the new draft returns to the library without asking', async () => {
    renderAt('#/dashboards?board=new');
    const name = await screen.findByTestId('dashboard-name-input');
    fireEvent.change(name, { target: { value: 'Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(apiMocks.dashboards.create).not.toHaveBeenCalled();
  });
});

describe('Reset from the Edit band, limits and the list (fix stage)', () => {
  it('a reset from the Edit band drops the changed draft: Edit again shows My dashboard, clean', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('overview', 'Overview')] });
    renderAt('#/dashboards?board=overview');
    await boardTitle('My dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByTestId('dashboard-name-input'), { target: { value: 'My changed board' } });
    const band = screen.getByRole('group', { name: 'Dashboard editing controls' });
    fireEvent.click(within(band).getAllByRole('button', { name: /Reset to default layout/ })[0]);
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset My dashboard to the default layout?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset layout' }));
    await waitFor(() => expect(apiMocks.dashboards.remove).toHaveBeenCalledWith('overview'));
    expect(await boardTitle('My dashboard')).toBeInTheDocument();
    expect(screen.queryByText('My changed board')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByTestId('dashboard-name-input')).toHaveValue('My dashboard');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText('Drag, resize, add or remove widgets, then save.')).toBeInTheDocument();
    expect(within(bar).queryByText('You have unsaved changes to this dashboard.')).toBeNull();
  });

  it('a new draft at 24 dashboards cannot be saved and says why', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: Array.from({ length: 24 }, (_, i) => stored(`dash-${i}`, `Board ${i}`)),
    });
    renderAt('#/dashboards?board=new');
    await screen.findByTestId('dashboard-name-input');
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await waitFor(() =>
      expect(
        within(bar).getByText('You have 24 dashboards, the most allowed. Delete one to add another.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Save dashboard' })).toBeDisabled();
    expect(apiMocks.dashboards.create).not.toHaveBeenCalled();
  });

  it('My dashboard before its first Save, at 24 other dashboards, cannot be saved or renamed and says why', async () => {
    const limitText = 'You have 24 dashboards, the most allowed. Delete one to add another.';
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: Array.from({ length: 24 }, (_, i) => stored(`dash-${i}`, `Board ${i}`)),
    });
    renderAt('#/dashboards?board=overview');
    await boardTitle('My dashboard');
    await waitFor(() => expect(apiMocks.dashboards.list).toHaveBeenCalled());

    // Edit: the save bar says why, and Save is off before any change is made.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByTestId('dashboard-name-input'), { target: { value: 'Morning board' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await waitFor(() => expect(within(bar).getByText(limitText)).toBeInTheDocument());
    const save = screen.getByRole('button', { name: 'Save dashboard' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByRole('button', { name: 'Edit' });

    // Rename says the same and cannot be confirmed.
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename dashboard' });
    expect(within(dialog).getByText(limitText)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'Rename' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);

    expect(apiMocks.dashboards.update).not.toHaveBeenCalled();
    expect(apiMocks.dashboards.create).not.toHaveBeenCalled();
  });

  it('a stored My dashboard among 24 dashboards still saves and renames (an update, not a new board)', async () => {
    apiMocks.dashboards.list.mockResolvedValue({
      dashboards: [stored('overview', 'Overview'), ...Array.from({ length: 23 }, (_, i) => stored(`dash-${i}`, `Board ${i}`))],
    });
    renderAt('#/dashboards?board=overview');
    await boardTitle('My dashboard');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByTestId('dashboard-name-input'), { target: { value: 'Morning board' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).queryByText(/the most allowed/)).toBeNull();
    const save = screen.getByRole('button', { name: 'Save dashboard' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    expect(apiMocks.dashboards.update.mock.calls[0][0]).toBe('overview');
    expect(await boardTitle('Morning board')).toBeInTheDocument();

    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename dashboard' });
    expect(within(dialog).queryByText(/the most allowed/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Day board' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(2));
    expect(apiMocks.dashboards.update.mock.calls[1][0]).toBe('overview');
    expect(apiMocks.dashboards.create).not.toHaveBeenCalled();
  });

  it('a personal board keeps the panels the role cannot read: "No access", and Save sends them back', async () => {
    authAs('analyst_tier1', { metrics: ['view'], cases: ['read'] });
    const night = stored('dash-night', 'Night shift', {
      widgets: [
        { i: 'n', type: 'kpi.needs_human', x: 0, y: 0, w: 3, h: 3, options: {} } as DashboardWidget,
        { i: 'c', type: 'kpi.cost_budget', x: 3, y: 0, w: 3, h: 3, options: {} } as DashboardWidget,
      ],
    });
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [night] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift');
    // The board agrees with its library card.
    expect(await screen.findByTestId('dashboard-access-note')).toHaveTextContent(
      '1 panel needs permissions your role does not have.',
    );
    expect(document.querySelector('[data-widget-type="kpi.cost_budget"]')).toHaveAttribute('data-widget-gate', 'denied');
    expect(apiMocks.usageSummary).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByTestId('dashboard-name-input'), { target: { value: 'Night shift triage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const body = apiMocks.dashboards.update.mock.calls[0][1] as DashboardLayout;
    expect((body.widgets ?? []).map((w) => w.type).sort()).toEqual(['kpi.cost_budget', 'kpi.needs_human']);
  });

  it('a copy made while the list failed reads the list again: the library keeps its error and Retry', async () => {
    apiMocks.dashboards.list.mockRejectedValue(new Error('down'));
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    await waitFor(() => expect(apiMocks.dashboards.list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate SOC operations?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate and edit' }));
    await waitFor(() => expect(apiMocks.dashboards.create).toHaveBeenCalledTimes(1));
    // The copy is stored; the list is read again (it fails again), never invented.
    await waitFor(() => expect(apiMocks.dashboards.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(route()).toBe('dashboards|dash-copy-1'));
    expect(await screen.findByText('This dashboard could not be loaded.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    expect(await screen.findByText('Your dashboards could not be loaded.')).toBeInTheDocument();
    const yours = screen.getByRole('region', { name: 'Yours' });
    expect(within(yours).getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(within(yours).queryByText(/your role default/)).toBeNull();
    expect(toastMock.error).not.toHaveBeenCalledWith('That dashboard is not available.');
  });

  it('a copy made while the list failed shows the stored boards and the copy once the list reads', async () => {
    apiMocks.dashboards.list
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({
        dashboards: [
          stored('overview', 'Overview'),
          stored('dash-copy-1', 'SOC operations (copy)', { derived_from: 'builtin:soc-operations' }),
        ],
      });
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    await waitFor(() => expect(apiMocks.dashboards.list).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate SOC operations?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Duplicate and edit' }));
    expect(await boardTitle('SOC operations (copy)')).toBeInTheDocument();
    expect(await screen.findByText('Save dashboard')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'All dashboards' }));
    const yours = await screen.findByRole('region', { name: 'Yours' });
    const mine = await within(yours).findByRole('link', { name: 'My dashboard' });
    // The stored My dashboard, not the role default offered in its place.
    expect(within(mine).queryByText(/your role default/)).toBeNull();
    expect(within(yours).getByRole('link', { name: 'SOC operations (copy)' })).toBeInTheDocument();
  });
});

describe('Focus', () => {
  const active = () => document.activeElement;

  it('the first view moves nothing (a fresh load of a board)', async () => {
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    expect(active()).toBe(document.body);
  });

  it('opening a card hands focus to the main landmark; All dashboards brings it back to the card', async () => {
    renderAt('#/dashboards');
    const card = await screen.findByRole('link', { name: 'SOC operations' });
    card.focus();
    fireEvent.click(card);
    await boardTitle('SOC operations');
    await waitFor(() => expect(active()).toBe(document.getElementById('socMain')));

    const back = screen.getByRole('link', { name: 'All dashboards' });
    back.focus();
    fireEvent.click(back);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    await waitFor(() => expect(active()).toBe(screen.getByRole('link', { name: 'SOC operations' })));
  });

  it('Edit hands focus to the name; Discard and Save give it to Edit', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    const edit = screen.getByRole('button', { name: 'Edit' });
    edit.focus();
    fireEvent.click(edit);
    await waitFor(() => expect(active()).toBe(screen.getByTestId('dashboard-name-input')));

    const discard = screen.getByRole('button', { name: 'Discard' });
    discard.focus();
    fireEvent.click(discard);
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Edit' })));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const save = await screen.findByRole('button', { name: 'Save dashboard' });
    save.focus();
    fireEvent.click(save);
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalled());
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'Edit' })));
  });

  it('Duplicate to customise: Escape returns focus to the button', async () => {
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    const button = screen.getByRole('button', { name: 'Duplicate to customise' });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate SOC operations?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(active()).toBe(button));
  });

  it.each([
    ['Rename', 'dialog', 'Cancel'],
    ['Duplicate', 'dialog', 'Cancel'],
    ['Delete dashboard', 'alertdialog', 'Cancel'],
  ] as const)('More > %s: closing the dialog returns focus to the More button', async (item, role, close) => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
    const dialog = await screen.findByRole(role);
    fireEvent.click(within(dialog).getByRole('button', { name: close }));
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'More dashboard actions' })));
  });

  it('a rename keeps the board: focus returns to the More button', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename dashboard' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Night shift' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await boardTitle('Night shift')).toBeInTheDocument();
    await waitFor(() => expect(active()).toBe(screen.getByRole('button', { name: 'More dashboard actions' })));
  });

  it('a delete returns to the library with focus on the main landmark (the card is gone)', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete dashboard' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Night shift triage?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete dashboard' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    await waitFor(() => expect(active()).toBe(document.getElementById('socMain')));
  });

  it('a hide returns to the library with focus on the main landmark (the card is hidden)', async () => {
    renderAt('#/dashboards?board=builtin%3Adetection-data-health');
    await boardTitle('Detection and data health');
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide from my list' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboards' })).toBeInTheDocument();
    await waitFor(() => expect(active()).toBe(document.getElementById('socMain')));
  });
});

describe('Board copy', () => {
  it('no em dash, en dash or "playbook" in a board header, its menu or its dialogs', async () => {
    renderAt('#/dashboards?board=builtin%3Asoc-operations');
    await boardTitle('SOC operations');
    const texts: string[] = [screen.getByTestId('dashboard-board-header').textContent ?? ''];
    fireEvent.click(screen.getByRole('button', { name: 'About SOC operations' }));
    const help = await screen.findByText(/^For SOC managers/);
    texts.push(help.textContent ?? '');
    fireEvent.keyDown(help, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/^For SOC managers/)).toBeNull());
    openMore();
    texts.push((await screen.findByRole('menu')).textContent ?? '');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    texts.push((await screen.findByRole('dialog', { name: 'Duplicate SOC operations?' })).textContent ?? '');
    for (const text of texts) {
      expect(text).not.toMatch(/\u2014|\u2013/);
      expect(text.toLowerCase()).not.toContain('playbook');
    }
  });

  it('no em dash in a personal board header, its menu, rename and delete dialogs', async () => {
    apiMocks.dashboards.list.mockResolvedValue({ dashboards: [stored('dash-night', 'Night shift triage')] });
    renderAt('#/dashboards?board=dash-night');
    await boardTitle('Night shift triage');
    const texts: string[] = [screen.getByTestId('dashboard-board-header').textContent ?? ''];
    openMore();
    texts.push((await screen.findByRole('menu')).textContent ?? '');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete dashboard' }));
    texts.push((await screen.findByRole('alertdialog')).textContent ?? '');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    openMore();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    texts.push((await screen.findByRole('dialog', { name: 'Rename dashboard' })).textContent ?? '');
    for (const text of texts) {
      expect(text).not.toMatch(/\u2014|\u2013/);
      expect(text.toLowerCase()).not.toContain('playbook');
    }
  });
});
