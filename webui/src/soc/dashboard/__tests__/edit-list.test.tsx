/**
 * Edit mode on a narrow board, the compact toolbar and the toast clearance (Round 14
 * closing fixes qa1-01 and qa1-10, and their review; SPEC §4.4.5 Phone, §4.4.6).
 *
 *   - Under 640 px the board edits as one column: react-grid-layout is never loaded,
 *     every widget is a full-width list item in reading order with 44 px Move up, Move
 *     down (named for the widget) and options controls in a toolbar above its body (no
 *     grip, no width or height controls), and the grid's layout callback is never called.
 *     The board crossing 640 px while Edit mode is open switches between list and grid,
 *     and back to the grid only from 664 px: a width that changes with the arrangement (a
 *     classic scrollbar) settles after one switch instead of flipping on every frame.
 *   - In the builder, Move up and Move down reorder the board in 12-column geometry (the
 *     pair trades places and sizes where keeping them would leave a gap), keep the pressed
 *     button where it was on the screen (clear of the Save and Discard bar) with the focus
 *     on it, say where the widget went, and save that. Add widget and Duplicate put the
 *     new widget last; Add hands it the focus with its toolbar under the top bar, and the
 *     gallery says where a new widget goes in the list.
 *   - Remove hands the focus to the next widget (the previous at the end, Add widget on an
 *     empty board) in the list and in the grid, and what is saved is the compacted board
 *     the list showed. Every change is announced, the same words twice as two messages.
 *   - Configure, opened from a widget's menu, gives the focus back to that widget's options
 *     button when its sheet closes (Esc or Apply), in the list and in the grid.
 *   - A grid cell too narrow for the whole toolbar keeps every control reachable: the
 *     moves are in its menu.
 *   - While the Save and Discard bar shows, the root carries the toast clearance and
 *     follows the bar on scroll, resize and growing content; it is removed with Edit
 *     mode. The toaster is lifted by a transform that glides (theme.css). The bar's
 *     message takes its own line on a narrow bar.
 *
 * jsdom has no layout, so the board's width, the bar and the list controls are given
 * rects here, and ResizeObserver and requestAnimationFrame are stubbed where a test drives
 * them; the live geometry is measured in the browser.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const rglEvaluated = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-grid-layout', () => {
  rglEvaluated.count += 1;
  const ReactMod = require('react');
  return {
    GridLayout: ({ children }: { children: React.ReactNode }) =>
      ReactMod.createElement('div', { 'data-testid': 'rgl-mock' }, children),
    useContainerWidth: () => ({ width: 700, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});
vi.mock('react-grid-layout/css/styles.css', () => ({}));
vi.mock('react-resizable/css/styles.css', () => ({}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

const apiMocks = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  listCases: vi.fn(),
  standup: vi.fn(),
  get: vi.fn(),
  auth: { me: vi.fn() },
  roles: { get: vi.fn() },
  dashboards: { update: vi.fn(), remove: vi.fn(), create: vi.fn(), list: vi.fn(), clone: vi.fn() },
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

import { AuthProvider } from '@/soc/auth';
import type { DashboardLayout, DashboardWidget } from '@/lib/types';
import { DashboardBuilder } from '@/soc/dashboard/DashboardBuilder';
import { DashboardDataProvider } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetGrid, viewGridPlacement, type WidgetEditActions } from '@/soc/dashboard/WidgetGrid';
import { editGeometry, widgetToItem } from '@/soc/dashboard/layout-utils';
import { TOAST_CLEARANCE_VAR } from '@/soc/hooks/useToastClearance';

import { OPEN_BY_VERDICT } from './dashboard-fixtures';

/** A widget named by its title override, so the list order reads in words. */
function wg(i: string, title: string, x: number, y: number, w: number, h: number): DashboardWidget {
  return { i, type: 'kpi.needs_human', x, y, w, h, options: { title } } as unknown as DashboardWidget;
}

/** SOC operations' first three bands, in the shape a copy of it is stored in. */
const WIDGETS: DashboardWidget[] = [
  wg('strip', 'Headline', 0, 0, 12, 3),
  wg('arrivals', 'Arrivals and closures', 0, 3, 8, 6),
  wg('hva', 'Human vs AI', 8, 3, 4, 6),
  wg('attention', 'Needs attention now', 0, 9, 8, 6),
  wg('workload', 'Analyst workload', 8, 9, 4, 6),
];

/** The width the board's edit wrapper reports (jsdom has no layout). */
let boardWidth = 358;
/** When set, the board's width instead (a width that depends on what the board shows). */
let boardWidthFor: (() => number) | null = null;
/** Where the Save and Discard bar sits (jsdom has no layout). */
let barRect = { top: 0, bottom: 0, height: 0 };
/** Whether the list's controls get a layout (the scroll tests): 250 px per list item. */
let layoutControls = false;
/** How far the page has scrolled (`window.scrollBy`, stubbed in those tests). */
let scrolled = 0;

/** A list control's top on the screen: 100 px for the first item, 250 px per item after. */
function controlTop(el: HTMLElement): number {
  const item = el.closest('li');
  const index = item?.parentElement ? Array.from(item.parentElement.children).indexOf(item) : 0;
  return 100 + index * 250 - scrolled;
}

/** A ResizeObserver whose callbacks a test fires (the setup's one never calls back here). */
class DrivenResizeObserver {
  static live = new Set<DrivenResizeObserver>();
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    DrivenResizeObserver.live.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    DrivenResizeObserver.live.delete(this);
  }
  fire() {
    const entries = [...this.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() }));
    this.callback(entries as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

/** Every observed element "changed size": fire each live observer, as the browser does. */
function resizeAll() {
  act(() => {
    for (const observer of [...DrivenResizeObserver.live]) observer.fire();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rglEvaluated.count = 0;
  boardWidth = 358;
  boardWidthFor = null;
  barRect = { top: 0, bottom: 0, height: 0 };
  layoutControls = false;
  scrolled = 0;
  DrivenResizeObserver.live.clear();
  const base = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-testid="widget-grid-edit"], [data-testid="widget-grid-empty"]')) {
      return DOMRect.fromRect({ width: boardWidthFor ? boardWidthFor() : boardWidth, height: 900 });
    }
    if (this.matches('[role="region"][aria-label="Unsaved changes"]')) {
      return DOMRect.fromRect({ x: 0, y: barRect.top, width: 358, height: barRect.height });
    }
    if (layoutControls && this.matches('[data-reorder], [data-widget-options]')) {
      return DOMRect.fromRect({ x: 300, y: controlTop(this), width: 44, height: 44 });
    }
    return base.call(this);
  });
  apiMocks.auth.me.mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
  apiMocks.roles.get.mockResolvedValue({ matrix: {}, rbac_enabled: false });
  apiMocks.getMetrics.mockResolvedValue({ needs_human_cases: 1, open_cases: 2, cost: {} });
  apiMocks.listCases.mockResolvedValue({ cases: [], total: 0 });
  apiMocks.get.mockResolvedValue({ sources: [] });
  apiMocks.dashboards.update.mockImplementation(async (_id: string, body: DashboardLayout) => ({ ...body }));
  fetchPostureMock.mockResolvedValue({ window_hours: 24, lifecycle: {}, quality: {}, aging: {}, sla: {} });
  fetchMitreMock.mockResolvedValue({ by_tactic: {}, top_techniques: [] });
  breakdownMock.mockResolvedValue(OPEN_BY_VERDICT);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(TOAST_CLEARANCE_VAR);
});

/** Stub `window.scrollBy` so a scroll moves the stubbed control rects. */
function stubScroll() {
  return vi.spyOn(window, 'scrollBy').mockImplementation(((options?: ScrollToOptions | number) => {
    scrolled += typeof options === 'object' ? (options.top ?? 0) : 0;
  }) as typeof window.scrollBy);
}

function actions(overrides: Partial<WidgetEditActions> = {}): WidgetEditActions {
  return {
    onConfigure: vi.fn(),
    onDuplicate: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
}

function renderGrid(props: { actions?: WidgetEditActions; onLayoutChange?: () => void; onArrangementChange?: (a: string) => void } = {}) {
  return render(
    <DashboardDataProvider window="now-24h" objectScoped={false} widgets={WIDGETS}>
      <WidgetGrid
        widgets={WIDGETS}
        editing
        onLayoutChange={props.onLayoutChange ?? vi.fn()}
        editActions={props.actions ?? actions()}
        onArrangementChange={props.onArrangementChange}
      />
    </DashboardDataProvider>,
  );
}

/** A test widget's title (its title override). */
function titleOf(w: DashboardWidget): string {
  return String((w as { options?: { title?: unknown } }).options?.title ?? '');
}

/** The list's widget titles, top to bottom. */
function listOrder(): string[] {
  const list = screen.getByRole('list', { name: 'Widgets, in reading order' });
  return within(list)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-widget-toolbar] span')?.textContent ?? '');
}

describe('a narrow board edits as one column', () => {
  it('loads no grid, stacks every widget full width in reading order, and never reports a layout', async () => {
    const onLayoutChange = vi.fn();
    const onArrangementChange = vi.fn();
    renderGrid({ onLayoutChange, onArrangementChange });

    expect(screen.getByTestId('widget-grid-edit')).toHaveAttribute('data-edit-arrangement', 'list');
    expect(listOrder()).toEqual(['Headline', 'Arrivals and closures', 'Human vs AI', 'Needs attention now', 'Analyst workload']);
    expect(screen.getByText('One column on a narrow screen. Change widths and heights on a wider screen.')).toBeInTheDocument();
    for (const toolbar of document.querySelectorAll('[data-widget-toolbar]')) {
      expect(toolbar).toHaveAttribute('data-widget-toolbar', 'list');
    }
    // No drag grip and no grid moves: the list's order is the board's reading order.
    expect(document.querySelector('.card-drag-handle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move left' })).toBeNull();
    await waitFor(() => expect(onArrangementChange).toHaveBeenCalledWith('list'));
    expect(screen.queryByTestId('rgl-mock')).toBeNull();
    expect(rglEvaluated.count).toBe(0);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('offers Move up and Move down named for the widget, inert at the ends but still focusable', async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    renderGrid({ actions: actions({ onReorder }) });
    const first = within(screen.getByRole('group', { name: 'Position Headline' }));
    const last = within(screen.getByRole('group', { name: 'Position Analyst workload' }));
    expect(first.getByRole('button', { name: 'Move Headline up' })).toHaveAttribute('aria-disabled', 'true');
    expect(first.getByRole('button', { name: 'Move Headline down' })).not.toHaveAttribute('aria-disabled');
    expect(last.getByRole('button', { name: 'Move Analyst workload down' })).toHaveAttribute('aria-disabled', 'true');
    // Every list control is a tab stop (no roving grip in the list).
    expect(first.getByRole('button', { name: 'Move Headline up' })).toHaveAttribute('tabindex', '0');
    // No two buttons on the board share a name.
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);

    await user.click(first.getByRole('button', { name: 'Move Headline up' }));
    expect(onReorder).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Move Human vs AI up' }));
    expect(onReorder).toHaveBeenCalledWith(expect.objectContaining({ i: 'hva' }), 'up');
  });

  it('gives the list 44 px controls 8 px apart, in a toolbar above the body', () => {
    renderGrid();
    const toolbar = document.querySelector('[data-widget-id="hva"] [data-widget-toolbar]') as HTMLElement;
    // In the flow, not laid over the body; the body reserves no room for it.
    expect(toolbar.className).not.toContain('absolute');
    expect((toolbar.nextElementSibling as HTMLElement).className).not.toContain('pt-8');
    expect(within(toolbar).getByRole('group', { name: 'Position Human vs AI' }).className).toContain('gap-2');
    for (const name of ['Move Human vs AI up', 'Move Human vs AI down', 'Human vs AI widget options']) {
      const button = within(toolbar).getByRole('button', { name });
      for (const size of ['h-11', 'min-h-11', 'w-11', 'min-w-11']) expect(button.className, name).toContain(size);
      expect(button.querySelector('svg')?.getAttribute('class'), name).toContain('h-4 w-4');
    }
  });

  it('switches to the grid and back as the board crosses 640 px, never reporting a layout from the list', async () => {
    vi.stubGlobal('ResizeObserver', DrivenResizeObserver);
    const onLayoutChange = vi.fn();
    const onArrangementChange = vi.fn();
    renderGrid({ onLayoutChange, onArrangementChange });
    expect(screen.getByTestId('widget-grid-edit')).toHaveAttribute('data-edit-arrangement', 'list');

    boardWidth = 700;
    resizeAll();
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    expect(screen.getByTestId('widget-grid-edit')).toHaveAttribute('data-edit-arrangement', 'grid');
    expect(onArrangementChange).toHaveBeenLastCalledWith('grid');

    boardWidth = 358;
    resizeAll();
    expect(screen.getByTestId('widget-grid-edit')).toHaveAttribute('data-edit-arrangement', 'list');
    expect(screen.getByRole('list', { name: 'Widgets, in reading order' })).toBeInTheDocument();
    expect(onArrangementChange).toHaveBeenLastCalledWith('list');
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('settles after one switch when the width depends on the arrangement (a classic scrollbar)', async () => {
    vi.stubGlobal('ResizeObserver', DrivenResizeObserver);
    // The grid's fixed-height cells make the page tall enough for a 13 px scrollbar
    // (632 px); the content-sized list fits without one (645 px). A single cut at 640 px
    // flipped list, grid, list on every frame.
    const listShown = () => document.querySelector('[aria-label="Widgets, in reading order"]') !== null;
    boardWidthFor = () => (listShown() ? 645 : 632);
    const onArrangementChange = vi.fn();
    renderGrid({ onArrangementChange });
    const board = screen.getByTestId('widget-grid-edit');
    expect(board).toHaveAttribute('data-edit-arrangement', 'list');
    for (let frame = 0; frame < 6; frame += 1) {
      resizeAll();
      expect(board, `frame ${frame}`).toHaveAttribute('data-edit-arrangement', 'list');
    }
    expect(screen.queryByTestId('rgl-mock')).toBeNull();
    expect(onArrangementChange.mock.calls).toEqual([['list']]);
  });

  it('switches from the grid to the list once when the scrollbar narrows it, and stays', async () => {
    vi.stubGlobal('ResizeObserver', DrivenResizeObserver);
    boardWidth = 700;
    const onArrangementChange = vi.fn();
    renderGrid({ onArrangementChange });
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    const board = screen.getByTestId('widget-grid-edit');
    const flips: string[] = [];
    const watcher = new MutationObserver(() => flips.push(board.getAttribute('data-edit-arrangement') ?? ''));
    watcher.observe(board, { attributes: true, attributeFilter: ['data-edit-arrangement'] });

    // The window narrows: the grid measures 632 px with its scrollbar, the list 645 px.
    const listShown = () => document.querySelector('[aria-label="Widgets, in reading order"]') !== null;
    boardWidthFor = () => (listShown() ? 645 : 632);
    for (let frame = 0; frame < 6; frame += 1) resizeAll();
    flips.push(...watcher.takeRecords().map(() => board.getAttribute('data-edit-arrangement') ?? ''));
    watcher.disconnect();
    expect(board).toHaveAttribute('data-edit-arrangement', 'list');
    expect(flips).toEqual(['list']);
    expect(onArrangementChange.mock.calls).toEqual([['grid'], ['list']]);

    // Wide enough to leave the band: the grid again.
    boardWidthFor = () => 664;
    resizeAll();
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    expect(board).toHaveAttribute('data-edit-arrangement', 'grid');
  });

  it("keeps Configure, Duplicate and Remove in the menu, and leaves width and height to a wider screen", async () => {
    const user = userEvent.setup();
    const onConfigure = vi.fn();
    renderGrid({ actions: actions({ onConfigure }) });
    await user.click(screen.getByRole('button', { name: 'Human vs AI widget options' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).toEqual(['Configure', 'Duplicate', 'Remove']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Configure' }));
    expect(onConfigure).toHaveBeenCalledWith(expect.objectContaining({ i: 'hva' }));
  });

  it('is the grid again from 640 px', async () => {
    boardWidth = 640;
    const onArrangementChange = vi.fn();
    renderGrid({ onArrangementChange });
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    expect(screen.getByTestId('widget-grid-edit')).toHaveAttribute('data-edit-arrangement', 'grid');
    expect(onArrangementChange).toHaveBeenCalledWith('grid');
    expect(screen.queryByRole('list', { name: 'Widgets, in reading order' })).toBeNull();
  });
});

describe('a narrow grid cell', () => {
  it('gets the compact toolbar, whose menu holds the four moves', async () => {
    const user = userEvent.setup();
    boardWidth = 700; // a quarter-width cell is 222 px: too narrow for the whole toolbar
    const onMove = vi.fn();
    renderGrid({ actions: actions({ onMove }) });
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());

    const hva = document.querySelector('[data-widget-id="hva"] [data-widget-toolbar]') as HTMLElement;
    const arrivals = document.querySelector('[data-widget-id="arrivals"] [data-widget-toolbar]') as HTMLElement;
    expect(hva).toHaveAttribute('data-widget-toolbar', 'compact');
    expect(arrivals).toHaveAttribute('data-widget-toolbar', 'grid');
    expect(within(hva).queryByRole('button', { name: 'Move left' })).toBeNull();
    expect(within(arrivals).getByRole('button', { name: 'Move left' })).toBeInTheDocument();
    // The grip still moves it from the keyboard.
    expect(within(hva).getByRole('button', { name: /Move or resize Human vs AI/ })).toBeInTheDocument();

    await user.click(within(hva).getByRole('button', { name: 'Human vs AI widget options' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).toEqual([
      'Configure',
      'Move left',
      'Move right',
      'Move up',
      'Move down',
      'Grow width',
      'Shrink width',
      'Grow height',
      'Shrink height',
      'Duplicate',
      'Remove',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Move left' }));
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ i: 'hva' }), 'left');
  });
});

const DASHBOARD: DashboardLayout = { id: 'dash-1', name: 'SOC operations (copy)', schema_version: 1, columns: 12, widgets: WIDGETS };

function Harness() {
  const [editing, setEditing] = React.useState(true);
  return (
    <>
      <span data-testid="host-mode">{editing ? 'edit' : 'view'}</span>
      <DashboardBuilder dashboard={DASHBOARD} isDefaultBoard={false} editing={editing} onEditingChange={setEditing} />
    </>
  );
}

function renderBuilder() {
  return render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
}

describe('the builder on a narrow board', () => {
  it('reorders in 12-column geometry at every size, keeps the focus on the pressed button, says where it went, and saves it', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    // The hint names what works here.
    expect(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByText('Reorder, add or remove widgets, then save.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Move Human vs AI up' }));
    expect(listOrder()).toEqual(['Headline', 'Human vs AI', 'Arrivals and closures', 'Needs attention now', 'Analyst workload']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Human vs AI up' }));
    expect(screen.getByText('Human vs AI moved to position 2 of 5.')).toBeInTheDocument();

    // Move down twice: past Arrivals, then past Needs attention (the node moves; the focus follows it).
    const down = () => screen.getByRole('button', { name: 'Move Human vs AI down' });
    await user.click(down());
    await user.click(down());
    expect(listOrder()).toEqual(['Headline', 'Arrivals and closures', 'Needs attention now', 'Human vs AI', 'Analyst workload']);
    expect(document.activeElement).toBe(down());
    expect(screen.getByText('Human vs AI moved to position 4 of 5.')).toBeInTheDocument();
    const shown = listOrder();

    await user.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const saved = apiMocks.dashboards.update.mock.calls[0][1] as DashboardLayout;
    const geo = Object.fromEntries(saved.widgets.map((w) => [(w as { i: string }).i, widgetToItem(w)]));
    // Past Arrivals (side by side) the two swapped back at their own sizes. Past Needs
    // attention (8 x 6, below), keeping both sizes would leave the space beside Arrivals
    // empty on a wider screen, so the two traded places and sizes: the 12-column layout
    // keeps its shape and no other widget moved.
    expect(geo.strip).toMatchObject({ x: 0, y: 0, w: 12, h: 3 });
    expect(geo.arrivals).toMatchObject({ x: 0, y: 3, w: 8, h: 6 });
    expect(geo.attention).toMatchObject({ x: 8, y: 3, w: 4, h: 6 });
    expect(geo.hva).toMatchObject({ x: 0, y: 9, w: 8, h: 6 });
    expect(geo.workload).toMatchObject({ x: 8, y: 9, w: 4, h: 6 });
    // The wider screen reads the board in the order the list showed.
    expect(viewGridPlacement(saved.widgets).items.map((it) => titleOf(it.widget))).toEqual(shown);
  });

  it('keeps the pressed button where it was on the screen, so the next tap moves the same widget', async () => {
    const user = userEvent.setup();
    layoutControls = true;
    const scrollBy = stubScroll();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });

    // Human vs AI is the third item: its Move down is at 600 px. The move takes the widget
    // one item (250 px) down, and the page scrolls with it.
    const down = () => screen.getByRole('button', { name: 'Move Human vs AI down' });
    expect(down().getBoundingClientRect().top).toBe(600);
    await user.click(down());
    expect(listOrder()[3]).toBe('Human vs AI');
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 250, behavior: 'instant' });
    expect(down().getBoundingClientRect().top).toBe(600);
    expect(document.activeElement).toBe(down());
    expect(focus.mock.instances.at(-1)).toBe(down());
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    // A second tap on the same spot moves the same widget again.
    await user.click(down());
    expect(listOrder()[4]).toBe('Human vs AI');
    expect(down().getBoundingClientRect().top).toBe(600);
  });

  it('keeps a moved button clear of the Save and Discard bar', async () => {
    const user = userEvent.setup();
    layoutControls = true;
    // The bar is pinned to the bottom of the 768 px viewport, 88 px tall (two lines).
    barRect = { top: 680, bottom: 768, height: 88 };
    const scrollBy = stubScroll();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    // Scrolled so Needs attention's Move down (650 to 694 px) reaches under the bar.
    scrolled = 200;
    expect(screen.getByRole('button', { name: 'Move Needs attention now down' }).getBoundingClientRect().top).toBe(650);
    await user.click(screen.getByRole('button', { name: 'Move Needs attention now down' }));
    // Back at 650 it would still reach under the bar: it stops 8 px above it (628 + 44 = 672).
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 272, behavior: 'instant' });
    const button = screen.getByRole('button', { name: 'Move Needs attention now down' });
    expect(button.getBoundingClientRect().top).toBe(628);
    expect(document.activeElement).toBe(button);
  });

  it('adds a widget last in the list, hands it the focus, says where it landed, and saves that', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    const before = listOrder();

    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    await user.click(await screen.findByRole('button', { name: 'Add Awaiting a decision' }));
    // Every widget already on the board keeps its place; the new one is last.
    await waitFor(() => expect(listOrder()).toEqual([...before, 'Awaiting a decision']));
    expect(screen.getByText('Awaiting a decision added at position 6 of 6.')).toBeInTheDocument();
    // The gallery hands the focus to the new widget, not back to Add widget.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Awaiting a decision up' })));

    await user.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const saved = (apiMocks.dashboards.update.mock.calls[0][1] as DashboardLayout).widgets;
    const geo = saved.map((w) => widgetToItem(w));
    // The others are stored where they were; the new widget rests on the lowest row.
    expect(geo.slice(0, 5)).toEqual(WIDGETS.map((w) => widgetToItem(w)));
    expect(geo[5]).toMatchObject({ x: 0, y: 15, w: 3, h: 3 });
  });

  it('duplicates a widget to the end of the list and says where the copy went', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    const before = listOrder();

    await user.click(screen.getByRole('button', { name: 'Human vs AI widget options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(listOrder()).toEqual([...before, 'Human vs AI']);
    expect(screen.getByText('Human vs AI copied to position 6 of 6.')).toBeInTheDocument();
    // The menu gives the focus back to the original's options button.
    const original = document.querySelector('[data-widget-id="hva"]') as HTMLElement;
    await waitFor(() =>
      expect(document.activeElement).toBe(within(original).getByRole('button', { name: 'Human vs AI widget options' })),
    );
  });

  it("scrolls a new widget's toolbar up under the top bar, so its body shows above the Save and Discard bar", async () => {
    const user = userEvent.setup();
    layoutControls = true;
    const scrollBy = stubScroll();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });

    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    await user.click(await screen.findByRole('button', { name: 'Add Awaiting a decision' }));
    const up = () => screen.getByRole('button', { name: 'Move Awaiting a decision up' });
    await waitFor(() => expect(document.activeElement).toBe(up()));
    // The sixth item's Move up was at 1,350 px; it goes to 8 px under the 56 px top bar,
    // not to the bottom edge, where the bar would hide the widget's body.
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 1286, behavior: 'instant' });
    expect(up().getBoundingClientRect().top).toBe(64);
  });

  it('tells the gallery where a new widget goes: last in the list, dropped on the grid', async () => {
    const user = userEvent.setup();
    const { unmount } = renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(
      await screen.findByText('Pick a widget to add to this dashboard. It goes at the end; move it with Move up and Move down.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Pick a widget to add to this dashboard. Drag or resize it after it lands.')).toBeNull();
    unmount();

    boardWidth = 640;
    renderBuilder();
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    expect(await screen.findByText('Pick a widget to add to this dashboard. Drag or resize it after it lands.')).toBeInTheDocument();
  });

  it('saves the compacted board after Remove in the list, in the order the list showed', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    await user.click(screen.getByRole('button', { name: 'Human vs AI widget options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    // Analyst workload rises into the space beside Arrivals, as the grid compacts it.
    const shown = listOrder();
    expect(shown).toEqual(['Headline', 'Arrivals and closures', 'Analyst workload', 'Needs attention now']);

    await user.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(apiMocks.dashboards.update).toHaveBeenCalledTimes(1));
    const saved = (apiMocks.dashboards.update.mock.calls[0][1] as DashboardLayout).widgets;
    const remaining = WIDGETS.filter((w) => (w as { i: string }).i !== 'hva');
    expect(saved.map((w) => widgetToItem(w))).toEqual(editGeometry(remaining).map((w) => widgetToItem(w)));
    expect(widgetToItem(saved.find((w) => (w as { i: string }).i === 'workload')!)).toMatchObject({ x: 8, y: 3 });
    // The view grid (a wider screen, or the phone after Save) reads it in that order too.
    expect(viewGridPlacement(saved).items.map((it) => titleOf(it.widget))).toEqual(shown);
  });

  it('announces the same words twice as two messages (a copy removed, then its original)', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    const region = document.querySelector('[data-edit-status]') as HTMLElement;
    const records: MutationRecord[] = [];
    const watcher = new MutationObserver((list) => records.push(...list));
    watcher.observe(region, { childList: true, subtree: true, characterData: true });
    const removeFrom = async (card: HTMLElement) => {
      await user.click(within(card).getByRole('button', { name: 'Human vs AI widget options' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    };

    await user.click(screen.getByRole('button', { name: 'Human vs AI widget options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    const stored = new Set(WIDGETS.map((w) => (w as { i: string }).i));
    const copy = Array.from(document.querySelectorAll<HTMLElement>('[data-widget-id]')).find(
      (el) => !stored.has(el.getAttribute('data-widget-id') ?? ''),
    ) as HTMLElement;
    expect(copy).toBeTruthy();

    await removeFrom(copy);
    expect(region).toHaveTextContent('Human vs AI removed.');
    records.push(...watcher.takeRecords());
    const afterFirst = records.length;
    const firstNode = region.firstElementChild;

    await removeFrom(document.querySelector('[data-widget-id="hva"]') as HTMLElement);
    expect(region).toHaveTextContent('Human vs AI removed.');
    records.push(...watcher.takeRecords());
    watcher.disconnect();
    // The second, identical message is a new node in the live region: a change it reports.
    expect(region.firstElementChild).not.toBe(firstNode);
    expect(records.length).toBeGreaterThan(afterFirst);
    expect(records.slice(afterFirst).some((r) => r.type === 'childList' && r.addedNodes.length > 0)).toBe(true);
  });

  for (const [arrangement, width] of [['list', 358], ['grid', 1152]] as const) {
    it(`gives the focus back to the widget's options button when Configure closes, in the ${arrangement}`, async () => {
      const user = userEvent.setup();
      boardWidth = width;
      renderBuilder();
      if (arrangement === 'list') await screen.findByRole('list', { name: 'Widgets, in reading order' });
      else await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());
      const options = (title: string) => screen.getByRole('button', { name: `${title} widget options` });
      const configure = async (title: string) => {
        await user.click(options(title));
        await user.click(await screen.findByRole('menuitem', { name: 'Configure' }));
        return screen.findByRole('dialog');
      };

      // Escape.
      await configure('Human vs AI');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(options('Human vs AI')));

      // Apply, with a new title: the same widget's button, under its new name.
      const sheet = await configure('Human vs AI');
      const field = within(sheet).getByRole('textbox');
      await user.clear(field);
      await user.type(field, 'People and the agent');
      await user.click(within(sheet).getByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(options('People and the agent')));
      expect(document.activeElement).not.toBe(document.body);
    });
  }

  it('hands the focus to the widget that takes the removed one\'s place, the previous at the end, then Add widget', async () => {
    const user = userEvent.setup();
    renderBuilder();
    await screen.findByRole('list', { name: 'Widgets, in reading order' });
    const remove = async (title: string) => {
      await user.click(screen.getByRole('button', { name: `${title} widget options` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    };

    await remove('Arrivals and closures');
    // Needs attention now rises into the gap (the grid compacts the same way) and takes
    // the second place, so it takes the focus.
    expect(listOrder()).toEqual(['Headline', 'Needs attention now', 'Human vs AI', 'Analyst workload']);
    expect(screen.getByText('Arrivals and closures removed.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Needs attention now widget options' })));

    // The last widget has no next one: the focus goes to the one before it.
    await remove('Analyst workload');
    expect(screen.getByText('Analyst workload removed.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Human vs AI widget options' })));

    for (const title of ['Headline', 'Needs attention now', 'Human vs AI']) await remove(title);
    expect(screen.getByText('Human vs AI removed.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add widget' })));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('hands the focus on and announces in the grid too', async () => {
    const user = userEvent.setup();
    boardWidth = 1152;
    renderBuilder();
    await waitFor(() => expect(screen.getByTestId('rgl-mock')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Human vs AI widget options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    // One row down from the original, the copy reads fifth: after Needs attention now.
    expect(screen.getByText('Human vs AI copied to position 5 of 6.')).toBeInTheDocument();

    const original = document.querySelector('[data-widget-id="hva"]') as HTMLElement;
    await user.click(within(original).getByRole('button', { name: 'Human vs AI widget options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    expect(screen.getByText('Human vs AI removed.')).toBeInTheDocument();
    // The copy rises into the original's place (the grid compacts upwards), so it takes
    // the focus, and its controls the roving tab stop.
    expect(document.querySelector('[data-widget-id="hva"]')).toBeNull();
    const next = screen.getByRole('button', { name: 'Human vs AI widget options' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(next).toHaveAttribute('tabindex', '0');
  });

  it('follows the bar after mount: on scroll, on a window resize and as the content grows', async () => {
    vi.stubGlobal('ResizeObserver', DrivenResizeObserver);
    // Frames run when the test flushes them, as the browser runs them after the event.
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const flushFrames = () =>
      act(() => {
        for (const [id, callback] of [...frames]) {
          frames.delete(id);
          callback(0);
        }
      });
    // A short board: the bar sits above the toasts.
    barRect = { top: 200, bottom: 258, height: 58 };
    renderBuilder();
    await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');

    // Scrolled until the bar pins to the bottom edge.
    barRect = { top: window.innerHeight - 58, bottom: window.innerHeight, height: 58 };
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    // Measured in the next frame, not on every scroll event.
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
    flushFrames();
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('58px');

    // A taller window: the bar is above the toasts again.
    barRect = { top: 300, bottom: 358, height: 58 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    flushFrames();
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');

    // The widgets load and push the bar down to the edge, two lines tall.
    barRect = { top: window.innerHeight - 88, bottom: window.innerHeight, height: 88 };
    resizeAll();
    flushFrames();
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('88px');
  });

  it('lifts the toasts clear of the Save and Discard bar while it shows, and drops the lift with Edit mode', async () => {
    const user = userEvent.setup();
    // The bar stuck to the bottom of a 768 px viewport, two lines tall on a phone.
    barRect = { top: window.innerHeight - 88, bottom: window.innerHeight, height: 88 };
    renderBuilder();
    await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('88px');

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByTestId('host-mode')).toHaveTextContent('view'));
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
  });

  it('adds no lift while the bar sits above the toasts', async () => {
    barRect = { top: 200, bottom: 258, height: 58 };
    renderBuilder();
    await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(document.documentElement.style.getPropertyValue(TOAST_CLEARANCE_VAR)).toBe('');
  });

  it("puts the bar's message on its own line on a narrow bar", async () => {
    renderBuilder();
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    const message = bar.querySelector('[data-save-bar-message]') as HTMLElement;
    expect(bar.className).toContain('@container/savebar');
    expect(message.className).toContain('basis-full');
    expect(message.className).toContain('@[40rem]/savebar:basis-0');
  });
});

describe('the toaster reads the clearance', () => {
  const css = readFileSync(path.resolve(__dirname, '../../../styles/theme.css'), 'utf8');

  it('lifts the bottom toaster with a transform that glides on the standard curve', () => {
    const lift =
      /:root \[data-sonner-toaster\]\[data-y-position='bottom'\] \{\s*transform: translateY\(calc\(-1 \* var\(--soc-toast-clearance, 0px\)\)\);\s*transition: transform var\(--motion-base\) var\(--motion-ease-standard\);\s*\}/;
    expect(css).toMatch(lift);
    // Sonner's own offsets stay: no rule here moves the toaster's `bottom` any more.
    expect(css).not.toMatch(/bottom: calc\(var\(--(mobile-)?offset-bottom\) \+ var\(--soc-toast-clearance/);
  });

  it("keeps sonner's 10 px lift of an expanded stack, and none on a touch screen", () => {
    const lifted =
      /:root \[data-sonner-toaster\]\[data-y-position='bottom'\]\[data-lifted='true'\] \{\s*transform: translateY\(calc\(-10px - var\(--soc-toast-clearance, 0px\)\)\);/;
    const touch =
      /@media \(hover: none\) and \(pointer: coarse\) \{\s*:root \[data-sonner-toaster\]\[data-y-position='bottom'\]\[data-lifted='true'\] \{\s*transform: translateY\(calc\(-1 \* var\(--soc-toast-clearance, 0px\)\)\);/;
    expect(css).toMatch(lifted);
    expect(css).toMatch(touch);
    expect(css.search(touch)).toBeGreaterThan(css.search(lifted));
  });

  it('moves the toaster at once under reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root \[data-sonner-toaster\]\[data-y-position='bottom'\] \{\s*transition: none;/,
    );
  });
});
