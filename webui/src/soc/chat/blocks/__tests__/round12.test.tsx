/**
 * Round 12 (WP-BLK) rendering and interactions, all client-side and read-only:
 * grouped columns for a comparison, comparison tiles, calendar axes with the zone and
 * the in-progress period, "Group by" re-binning, brush zoom (pointer, Shift+click and
 * keyboard), legend toggles, Download PNG / SVG, "Full width", the infographic Brief,
 * the new report templates, print-hidden controls — and jest-axe on all of it.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));
const copyText = vi.fn(async (_text: string) => true);
vi.mock('@/lib/clipboard', () => ({ copyText: (t: string) => copyText(t), default: (t: string) => copyText(t) }));

import AnswerBlocks from '../AnswerBlocks';
import { BlockCard } from '../BlockCard';
import { measureBleed } from '../renderers/full-bleed';
import { galleryBlock } from '../__fixtures__/gallery';
import { ROUND12_RAW, round12Block, round12Blocks } from '../__fixtures__/round12';
import { parseBlock } from '../schema';
import type { AnswerBlock, ReportBlock } from '../schema';

expect.extend(toHaveNoViolations);

function show(blocks: AnswerBlock[]) {
  return render(<AnswerBlocks blocks={blocks} messageId="m1" />);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, index = 0) {
  await user.click(screen.getAllByTestId('block-menu-trigger')[index]);
  return screen.findByRole('menu');
}

function readBlob(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(b);
  });
}

function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  return { blobs, names };
}

beforeEach(() => {
  announce.mockClear();
  copyText.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('grouped columns (a period comparison)', () => {
  it('draws one column per period side by side, with a legend and an sr-only table', () => {
    const { container } = show([round12Block('compare-bars')]);
    const plot = screen.getByTestId('chart-grouped_bar-plot');
    expect(plot).toHaveAttribute('role', 'group');
    expect(plot.getAttribute('aria-label')).toMatch(/Grouped column chart/);
    // Two periods × four metrics, one of them zero (no column, never a stub).
    expect(container.querySelectorAll('[data-testid="chart-grouped_bar"] path[data-series]')).toHaveLength(7);
    const legend = screen.getByRole('list', { name: 'Series' });
    expect(within(legend).getAllByRole('button').map((b) => b.textContent)).toEqual(['Sep 2026', 'Oct 2026']);
    const table = screen.getByTestId('chart-data-table');
    expect(table).toHaveClass('sr-only');
    expect(within(table).getAllByRole('row')).toHaveLength(5);
  });

  it('is keyboard navigable and reads the change from the previous period ("new" from zero)', () => {
    show([round12Block('compare-bars')]);
    const plot = screen.getByTestId('chart-grouped_bar-plot');
    act(() => plot.focus());
    const tip = () => screen.getByTestId('chart-grouped_bar-tooltip');
    expect(tip()).toHaveTextContent('Closed by an analyst');
    expect(tip()).toHaveTextContent('Change vs Sep 2026: −13 (−4.2%)');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(tip()).toHaveTextContent('Escalated');
    expect(tip()).toHaveTextContent('Change vs Sep 2026: +5 (new)');
    expect(tip().textContent).not.toMatch(/Infinity|NaN|∞/);
    fireEvent.keyDown(plot, { key: 'ArrowUp' });
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/^Escalated: Sep 2026 0\./));
  });

  it('tells assistive tech the change too: in the slot announcement and the sr-only table', () => {
    show([round12Block('compare-bars')]);
    const plot = screen.getByTestId('chart-grouped_bar-plot');
    act(() => plot.focus());
    // The tooltip (and its change note) is aria-hidden: the announcement carries it.
    expect(announce).toHaveBeenLastCalledWith('Closed by an analyst: Sep 2026 311, Oct 2026 298; change vs Sep 2026 −13 (−4.2%).');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(announce).toHaveBeenLastCalledWith('Escalated: Sep 2026 0, Oct 2026 5; change vs Sep 2026 +5 (new).');
    const table = screen.getByTestId('chart-data-table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Metric', 'Sep 2026', 'Oct 2026', 'Change vs Sep 2026']);
    const escalated = within(table).getAllByRole('row')[3];
    expect(within(escalated).getAllByRole('cell').map((c) => c.textContent)).toEqual(['0', '5', '+5 (new)']);
  });

  it('switches to horizontal bars and back through Show as', async () => {
    const user = userEvent.setup();
    show([round12Block('compare-bars')]);
    const menu = await openMenu(user);
    expect(within(menu).getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Grouped columns', 'Horizontal bars']);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Horizontal bars' }));
    expect(screen.getByTestId('chart-hbar-plot')).toBeInTheDocument();
  });
});

describe('comparison tiles', () => {
  it('reads absolute and relative change, the baseline period and value, and flags small samples', () => {
    show([round12Block('compare-tiles')]);
    const tiles = screen.getByTestId('block-comparison');
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(4);
    const cases = screen.getByTestId('comparison-chat-0-0');
    expect(cases).toHaveTextContent('1,284');
    expect(cases).toHaveTextContent('+96 (+8.1%)');
    expect(cases).toHaveTextContent('vs Sep 2026: 1,188');
    const fp = screen.getByTestId('comparison-chat-0-1');
    expect(fp).toHaveTextContent('+2.1 pp (+12.9%)');
    expect(within(fp).getByTestId('comparison-small-sample')).toHaveTextContent('n < 20');
    expect(screen.getByTestId('comparison-small-sample-note')).toHaveTextContent('fewer than 20 in a compared period');
    expect(screen.getByTestId('comparison-chat-0-2')).toHaveTextContent('+5 (new)');
    expect(screen.getByTestId('comparison-chat-0-2')).toHaveTextContent('vs Sep 2026: 0');
    expect(screen.getByTestId('comparison-chat-0-3')).toHaveTextContent('−6 min (−12.5%)');
    expect(tiles.textContent).not.toMatch(/Infinity|NaN|∞/);
  });

  it('shows the server baseline line, in the same "vs" words, when a change could not be measured', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const b = parseBlock({ ...raw, items: [{ key: 'x', label: 'Cases', value: 12, unit: 'count', context: 'Sep 2026: — · not measured' }] });
    show([b]);
    expect(screen.getByTestId('comparison-chat-0-0')).toHaveTextContent('vs Sep 2026: — · not measured');
  });

  it('reads a baseline period named to the minute in the same "vs" words', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const b = parseBlock({
      ...raw,
      items: [{ key: 'x', label: 'FP rate', value: 60, unit: 'percent', context: '26 Jul 20:45 – 3 Sep 2026 05:30: —' }],
    });
    show([b]);
    expect(within(screen.getByTestId('comparison-chat-0-0')).getByTestId('comparison-baseline'))
      .toHaveTextContent(/^vs 26 Jul 20:45 – 3 Sep 2026 05:30: —$/);
  });

  it('keeps a dated baseline period and its figures whole, past the label limit', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const context = 'previous 180 days (18 Oct 2025 to 15 Apr 2026): 12 h 30 min · n < 20';
    expect(context.length).toBeGreaterThan(60);
    const b = parseBlock({ ...raw, items: [{ key: 'x', label: 'MTTR median', value: null, unit: 'minutes', context }] });
    expect(b.type === 'kpi_group' && b.items[0].context).toBe(context);
    show([b]);
    expect(within(screen.getByTestId('comparison-chat-0-0')).getByTestId('comparison-baseline'))
      .toHaveTextContent(/^vs previous 180 days \(18 Oct 2025 to 15 Apr 2026\): 12 h 30 min$/);
  });

  it('flags small samples only on a change that is shown', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const b = parseBlock({
      ...raw,
      items: [
        { key: 'x', label: 'FP rate', value: 60, unit: 'percent', context: 'Sep 2026 to date: — · n < 20' },
        { key: 'y', label: 'Cases', value: 1284, unit: 'count', delta: { value: 96, period_label: 'vs Sep 2026 to date', good_direction: 'none' }, context: 'Sep 2026 to date: 1,188 · +8.1%' },
      ],
    });
    show([b]);
    const unmeasured = screen.getByTestId('comparison-chat-0-0');
    // No change is drawn on it, so there is nothing to read with care: no badge, and the
    // baseline reads like every other tile's.
    expect(within(unmeasured).queryByTestId('comparison-small-sample')).toBeNull();
    expect(within(unmeasured).getByTestId('comparison-baseline')).toHaveTextContent(/^vs Sep 2026 to date: —$/);
    expect(screen.getByTestId('comparison-chat-0-1')).toHaveTextContent('vs Sep 2026 to date: 1,188');
    expect(screen.queryByTestId('comparison-small-sample-note')).toBeNull();
  });

  it('says once, under the row, when every change shown rests on a small sample', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const delta = (value: number) => ({ value, period_label: 'vs Sep 2026 to date', good_direction: 'none' });
    const b = parseBlock({
      ...raw,
      items: [
        { key: 'a', label: 'Cases', value: 9, unit: 'count', delta: delta(2), context: 'Sep 2026 to date: 7 · +28.6% · n < 20' },
        { key: 'b', label: 'Closed automatically', value: 4, unit: 'count', delta: delta(0), context: 'Sep 2026 to date: 4 · 0% · n < 20' },
        { key: 'c', label: 'FP rate', value: 50, unit: 'percent', context: 'Sep 2026 to date: — · n < 20' },
      ],
    });
    show([b]);
    expect(screen.queryAllByTestId('comparison-small-sample')).toHaveLength(0);
    expect(screen.getByTestId('comparison-small-sample-note')).toHaveTextContent(
      'n < 20 for every change here: fewer than 20 in a compared period, so each change can swing widely.',
    );
  });
});

describe('calendar axes', () => {
  it('ticks, tooltip and table read the period labels, name the zone and mark the current period', () => {
    show([round12Block('daily-cases')]);
    const plot = screen.getByTestId('chart-bar-plot');
    expect(plot.getAttribute('aria-label')).toMatch(/Asia\/Kolkata/);
    expect(plot.getAttribute('aria-label')).not.toMatch(/UTC/);
    const table = screen.getByTestId('chart-data-table');
    expect(within(table).getAllByRole('columnheader')[0]).toHaveTextContent('Period (Asia/Kolkata)');
    const rows = within(table).getAllByRole('rowheader');
    expect(rows[0]).toHaveTextContent('1 Aug 2026');
    expect(rows.at(-1)).toHaveTextContent('9 Oct 2026 (in progress)');
    expect(screen.getByTestId('chart-in-progress')).toHaveTextContent('(in progress)');
    expect(screen.getByTestId('chart-zone')).toHaveTextContent('Times in Asia/Kolkata');
    act(() => plot.focus());
    expect(screen.getByTestId('chart-bar-tooltip')).toHaveTextContent('9 Oct 2026 · Asia/Kolkata');
    expect(screen.getByTestId('chart-bar-tooltip')).toHaveTextContent('In progress: this period is still filling.');
  });
});

describe('Group by (client-side re-bin)', () => {
  it('re-bins a daily series to weeks and months, and the table and copy follow', async () => {
    const user = userEvent.setup();
    show([round12Block('daily-cases')]);
    const group = screen.getByRole('radiogroup', { name: 'Group Cases opened per day by' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Day', 'Week', 'Month']);
    await user.click(within(group).getByRole('radio', { name: 'Month' }));
    expect(announce).toHaveBeenCalledWith('Grouped by month');
    const rows = within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader');
    expect(rows.map((r) => r.textContent)).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026 (in progress)']);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Copy data' }));
    expect(copyText.mock.calls[0][0].split('\n').slice(0, 2)).toEqual(['Period (Asia/Kolkata)\tCases', 'Aug 2026\t809']);
    await user.click(within(group).getByRole('radio', { name: 'Week' }));
    expect(within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader')[0]).toHaveTextContent('W31 2026 (from 1 Aug)');
    await user.click(within(group).getByRole('radio', { name: 'Day' }));
    expect(within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader')).toHaveLength(70);
  });

  it('is not offered for a series the server did not allow, nor on paper', () => {
    show([galleryBlock('alerts-by-source')]);
    expect(screen.queryByTestId('chart-rebin')).toBeNull();
    render(<BlockCard block={round12Block('daily-cases')} index={0} staticMode />);
    expect(screen.queryAllByTestId('chart-rebin')).toHaveLength(0);
  });
});

describe('brush zoom (line and area)', () => {
  it('zooms with Shift+arrows and Enter, then resets to the whole series', () => {
    show([round12Block('monthly-alerts')]);
    const plot = screen.getByTestId('chart-line-plot');
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    expect(screen.getByTestId('chart-zoom-selection')).toBeInTheDocument();
    expect(announce).toHaveBeenLastCalledWith('Selected Jul 2026 to Oct 2026, 4 points. Press Enter to zoom, Escape to clear.');
    fireEvent.keyDown(plot, { key: 'Enter' });
    // A year both ends share is said once on screen; the tooltip keeps the full labels.
    const bar = screen.getByTestId('chart-zoom-bar');
    expect(bar).toHaveTextContent('Zoomed to Jul – Oct 2026 (4 of 12 points)');
    expect(bar).toHaveAttribute('title', 'Zoomed to Jul 2026 – Oct 2026 (4 of 12 points)');
    expect(within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader')).toHaveLength(4);
    fireEvent.click(screen.getByTestId('chart-zoom-reset'));
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
    expect(announce).toHaveBeenLastCalledWith('Zoom reset: showing all 12 points.');
    expect(within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader')).toHaveLength(12);
  });

  it('keeps one zoom row at a fixed height, so the plot never moves when a zoom starts or ends', () => {
    show([round12Block('monthly-alerts')]);
    const row = screen.getByTestId('chart-zoom-row');
    expect(row).toHaveClass('h-6');
    expect(row).toHaveAttribute('data-print-hide');
    expect(within(row).getByTestId('chart-zoom-hint')).toHaveTextContent('Drag across the chart to zoom');
    const plot = screen.getByTestId('chart-line-plot');
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'Enter' });
    // The same row (not a new one above the plot) now holds the range and Reset.
    expect(screen.getByTestId('chart-zoom-row')).toBe(row);
    expect(within(row).getByTestId('chart-zoom-bar')).toHaveTextContent('Zoomed to Sep – Oct 2026 (2 of 12 points)');
    expect(within(row).queryByTestId('chart-zoom-hint')).toBeNull();
  });

  it('never truncates the point count: only the range may be cut on a narrow card', () => {
    show([round12Block('monthly-alerts')]);
    const plot = screen.getByTestId('chart-line-plot');
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'Home' });
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(plot, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'Enter' });
    const row = screen.getByTestId('chart-zoom-row');
    // The row is the size container the phone-width rules below query.
    expect(row).toHaveClass('@container', 'h-6');
    const bar = within(row).getByTestId('chart-zoom-bar');
    expect(bar).toHaveTextContent('Zoomed to Nov 2025 – Feb 2026 (4 of 12 points)');
    expect(bar).not.toHaveClass('truncate');
    const range = within(bar).getByTestId('chart-zoom-range');
    const count = within(bar).getByTestId('chart-zoom-count');
    expect(range).toHaveClass('truncate');
    expect(range).not.toContainElement(count);
    expect(count.closest('.truncate')).toBeNull();
    expect(count).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(count).toHaveTextContent('(4 of 12 points)');
    // On a narrow card "Zoomed to" and "points" are read by assistive tech only.
    expect(within(range).getByText('Zoomed to')).toHaveClass('sr-only', '@[28rem]:not-sr-only');
    expect(within(count).getByText('points')).toHaveClass('sr-only', '@[28rem]:not-sr-only');
    expect(screen.getByTestId('chart-zoom-reset')).toHaveClass('shrink-0');
  });

  it('keeps the keyboard cursor on the same period through a zoom and its reset', () => {
    show([round12Block('monthly-alerts')]);
    const plot = screen.getByTestId('chart-line-plot');
    const tip = () => screen.getByTestId('chart-line-tooltip');
    act(() => plot.focus());
    // Cursor on Dec 2025 (index 1), select Dec 2025 – Feb 2026 to the RIGHT, then zoom.
    fireEvent.keyDown(plot, { key: 'Home' });
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    fireEvent.keyDown(plot, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'Enter' });
    expect(screen.getByTestId('chart-zoom-bar')).toHaveTextContent('Zoomed to Dec 2025 – Feb 2026 (3 of 12 points)');
    // The cursor ended the selection on Feb 2026: it is still there, and still drawn.
    expect(tip()).toHaveTextContent('Feb 2026');
    expect(screen.getByTestId('chart-focus-ring')).toBeInTheDocument();
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/^Zoomed to Dec 2025 – Feb 2026, 3 of 12 points\. Feb 2026: /));
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(tip()).toHaveTextContent('Jan 2026');
    fireEvent.click(screen.getByTestId('chart-zoom-reset'));
    // Back on the whole series, on the same month.
    expect(tip()).toHaveTextContent('Jan 2026');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(tip()).toHaveTextContent('Dec 2025');
  });

  it('drops a zoom when the grouping changes, and never brings it back', async () => {
    const user = userEvent.setup();
    show([round12Block('monthly-alerts')]);
    const plot = screen.getByTestId('chart-line-plot');
    act(() => plot.focus());
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'Enter' });
    expect(screen.getByTestId('chart-zoom-bar')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Quarter' }));
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Month' }));
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
    expect(within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader')).toHaveLength(12);
  });

  it('Esc drops a keyboard selection without zooming', () => {
    show([round12Block('monthly-alerts')]);
    const plot = screen.getByTestId('chart-line-plot');
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    // The first Esc closes the tooltip (the topmost layer); the next drops the selection.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(screen.queryByTestId('chart-zoom-selection')).toBeNull();
    expect(announce).toHaveBeenLastCalledWith('Selection cleared');
  });

  it('zooms by dragging across the plot, and by a click then a Shift+click', () => {
    // jsdom has no PointerEvent: a MouseEvent with a pointer id stands in for it.
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
    show([round12Block('monthly-alerts')]);
    const plot = screen.getByTestId('chart-line-plot');
    fireEvent.pointerDown(plot, { button: 0, clientX: 120, pointerId: 1 });
    fireEvent.pointerMove(plot, { clientX: 300, pointerId: 1 });
    expect(screen.getByTestId('chart-zoom-selection')).toBeInTheDocument();
    fireEvent.pointerUp(plot, { clientX: 300, pointerId: 1 });
    expect(screen.getByTestId('chart-zoom-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chart-zoom-reset'));

    // A real click is a press and a release in place (no brush), then the click.
    const clickAt = (clientX: number, shiftKey = false) => {
      fireEvent.mouseMove(plot, { clientX });
      fireEvent.pointerDown(plot, { button: 0, clientX, pointerId: 1, shiftKey });
      fireEvent.pointerUp(plot, { clientX, pointerId: 1, shiftKey });
      fireEvent.click(plot, { clientX, shiftKey });
    };
    clickAt(100);
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
    clickAt(260, true);
    expect(screen.getByTestId('chart-zoom-bar')).toBeInTheDocument();

    // An anchor belongs to the view it was picked on. A plain click, then a zoom (a drag
    // here): a lone Shift+click in the zoomed view picks a new anchor, it does not zoom
    // from the old index read in the new numbering.
    fireEvent.click(screen.getByTestId('chart-zoom-reset'));
    clickAt(140);
    fireEvent.pointerDown(plot, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(plot, { clientX: 380, pointerId: 1 });
    fireEvent.pointerUp(plot, { clientX: 380, pointerId: 1 });
    fireEvent.click(plot, { clientX: 380 });
    const zoomed = screen.getByTestId('chart-zoom-bar').textContent;
    announce.mockClear();
    clickAt(430, true);
    expect(screen.getByTestId('chart-zoom-bar').textContent).toBe(zoomed);
    expect(announce).not.toHaveBeenCalledWith(expect.stringMatching(/^Zoomed to/));
    // The same after Reset zoom: an anchor picked in the zoomed view is not reused on the whole series.
    clickAt(200);
    fireEvent.click(screen.getByTestId('chart-zoom-reset'));
    clickAt(430, true);
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
    // A keyboard zoom drops it too.
    clickAt(140);
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'End' });
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'Enter' });
    const keyed = screen.getByTestId('chart-zoom-bar').textContent;
    clickAt(60, true);
    expect(screen.getByTestId('chart-zoom-bar').textContent).toBe(keyed);
  });

  it('is not offered on columns or on paper', () => {
    show([round12Block('daily-cases')]);
    expect(screen.getByTestId('chart-bar-plot')).not.toHaveClass('cursor-crosshair');
    render(<BlockCard block={round12Block('monthly-alerts')} index={0} staticMode />);
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
  });
});

describe('Download PNG and SVG', () => {
  it('saves the chart as shown: hidden series and zoom included, never the hover chrome', async () => {
    const user = userEvent.setup();
    const { blobs, names } = captureDownloads();
    show([round12Block('monthly-alerts')]);
    // Hide Wazuh and zoom to the last four months.
    await user.click(within(screen.getByRole('list', { name: 'Series' })).getByRole('button', { name: 'Wazuh' }));
    const plot = screen.getByTestId('chart-line-plot');
    act(() => plot.focus());
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(plot, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(plot, { key: 'Enter' });
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download SVG' }));
    expect(names[0]).toMatch(/^agentic-soc-chart-alerts-by-month-\d{8}-\d{4}Z\.svg$/);
    expect(blobs[0].type).toBe('image/svg+xml;charset=utf-8');
    const svg = await readBlob(blobs[0]);
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('<title>Alerts by month</title>');
    expect(svg).toContain('Elastic');
    // The image says what the screen's legend and zoom bar said: a hidden series stays
    // named as hidden, and the slice is a zoom of a longer series.
    expect(svg).toContain('Wazuh (hidden)');
    expect(svg).toContain('Zoomed to Jul 2026 – Oct 2026 (4 of 12 points) · Showing 1 of 2 series');
    expect(svg).toContain('Last 12 months');
    expect(svg).toContain('Oct 2026');
    expect(svg).not.toContain('Nov 2025');
    expect(svg).not.toContain('var(');
    expect(announce).toHaveBeenCalledWith('SVG downloaded');
  });

  it('names a client-side grouping on the card, in the image and in the file names', async () => {
    const user = userEvent.setup();
    const { blobs, names } = captureDownloads();
    show([round12Block('daily-cases')]);
    await user.click(screen.getByRole('radio', { name: 'Month' }));
    // The server's title still says "per day": the caption says what is shown.
    expect(screen.getByTestId('block-caption')).toHaveTextContent('1 Aug – 9 Oct 2026 · Asia/Kolkata · grouped by month');
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download CSV' }));
    expect(names[0]).toMatch(/^agentic-soc-cases-opened-per-day-by-month-\d{8}-\d{4}Z\.csv$/);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download SVG' }));
    expect(names[1]).toMatch(/^agentic-soc-chart-cases-opened-per-day-by-month-\d{8}-\d{4}Z\.svg$/);
    const svg = await readBlob(blobs[1]);
    expect(svg).toContain('1 Aug – 9 Oct 2026 · Asia/Kolkata · grouped by month');
    expect(svg).toContain('Aug 2026');
    // JSON is the server's block, ungrouped: its name does not claim a grouping.
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download JSON' }));
    expect(names[2]).toMatch(/^agentic-soc-cases-opened-per-day-\d{8}-\d{4}Z\.json$/);
  });

  it('rasterises the same image to a PNG at 2×', async () => {
    const user = userEvent.setup();
    const { blobs, names } = captureDownloads();
    const drawn: Array<[number, number]> = [];
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      drawn.push([this.width, this.height]);
      return { scale: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    } as never);
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob(['png'], { type: 'image/png' }));
    };
    show([round12Block('compare-bars')]);
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: 'Download PNG' }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('PNG downloaded'));
    expect(names[0]).toMatch(/\.png$/);
    expect(blobs[0].type).toBe('image/png');
    expect(drawn[0][0]).toBe(1920);
  });

  it('says so when the image cannot be made, and offers no image for a table', async () => {
    const user = userEvent.setup();
    captureDownloads();
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    show([round12Block('compare-bars'), galleryBlock('signins')]);
    await user.click(within(await openMenu(user, 0)).getByRole('menuitem', { name: 'Download PNG' }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Could not create the image'));
    const menu = await openMenu(user, 1);
    expect(within(menu).queryByRole('menuitem', { name: /Download (PNG|SVG)/ })).toBeNull();
  });
});

describe('Full width', () => {
  it('is not offered outside a chat lane (no lane cap)', async () => {
    const user = userEvent.setup();
    show([round12Block('daily-cases')]);
    expect(within(await openMenu(user)).queryByRole('menuitemcheckbox', { name: 'Full width' })).toBeNull();
  });

  it('measures the breakout to the conversation gutters, keeping the card hang', () => {
    const root = document.createElement('div');
    const parent = document.createElement('div');
    const figure = document.createElement('figure');
    parent.appendChild(figure);
    root.appendChild(parent);
    document.body.appendChild(root);
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
      const style = real(el);
      if (el === figure) return { ...style, getPropertyValue: (n: string) => (n === '--chat-lane-max' ? '64rem' : '') } as CSSStyleDeclaration;
      if (el === root) return { ...style, overflowY: 'auto', scrollbarGutter: 'stable both-edges', getPropertyValue: () => '' } as unknown as CSSStyleDeclaration;
      return style;
    }) as typeof window.getComputedStyle);
    const rect = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 1600) as DOMRect);
    Object.defineProperty(root, 'clientWidth', { value: 1600 });
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(rect(288, 1024) as DOMRect);
    // Gutter 40px (2.5% of 1600): the card may grow 248px per side, keeping its 13px hang.
    expect(measureBleed(figure, -13)).toEqual({ marginLeft: -261, marginRight: -261 });
    // A lane that already reaches the gutters offers nothing.
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(rect(40, 1520) as DOMRect);
    expect(measureBleed(figure, -13)).toBeNull();
    root.remove();
  });
});

describe('infographic Brief and the new templates', () => {
  it('draws a hero KPI row with trend columns, the highlights and a 2-up chart grid, every leaf once', () => {
    const { container } = show([round12Block('posture-infographic')]);
    const report = screen.getByTestId('block-report');
    expect(report).toHaveAttribute('data-layout', 'infographic');
    expect(screen.getByTestId('report-template')).toHaveTextContent('Infographic');
    const hero = screen.getByTestId('infographic-hero');
    expect(within(hero).getAllByRole('listitem')).toHaveLength(4);
    expect(within(hero).getAllByTestId('trend-columns')).toHaveLength(1);
    expect(within(hero).getByText('3,642')).toBeInTheDocument();
    const highlights = screen.getByRole('list', { name: 'Highlights' });
    expect(within(highlights).getAllByRole('note')).toHaveLength(3);
    const grids = screen.getAllByTestId('infographic-grid');
    expect(grids[0]).toHaveClass('@[44rem]:grid-cols-2');
    // Volume: two charts side by side; Top rules: the table takes the row.
    const spans = grids.map((g) => Array.from(g.children).map((c) => c.getAttribute('data-span')));
    expect(spans).toEqual([['row'], ['half', 'half'], ['row']]);
    // Nothing is drawn twice: one KPI card (the hero is not a card), 2 charts, 1 table, 1 prose block.
    expect(container.querySelectorAll('[data-block-type="kpi_group"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-block-type="chart"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-block-type="table"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-block-type="markdown"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-block-type="callout"]')).toHaveLength(3);
  });

  it('prints the hero and highlights but stacks the charts one per row', () => {
    render(<BlockCard block={round12Block('posture-infographic')} index={0} staticMode />);
    expect(screen.getByTestId('infographic-hero')).toBeInTheDocument();
    for (const g of screen.getAllByTestId('infographic-grid')) {
      expect(g).not.toHaveClass('@[44rem]:grid-cols-2');
      // No leaf spans columns on paper either: a span would create an implicit second
      // track and seat two fixed-width charts side by side (jsdom has no container
      // queries, so the class itself is what is checked).
      for (const cell of Array.from(g.children)) expect(cell.className).not.toMatch(/col-span/);
    }
    // Print shows the charts' data tables (WP-REP rule).
    expect(screen.getAllByTestId('chart-data-table').length).toBeGreaterThan(0);
  });

  it('keeps the hero group’s caption, "as of", truncation and storage notes', () => {
    const base = JSON.parse(JSON.stringify(ROUND12_RAW[4])) as { sections: Array<{ blocks: Array<Record<string, unknown>> }> };
    Object.assign(base.sections[0].blocks[1], {
      caption: 'Sample · last 30 days',
      truncated: true,
      total: 7,
      as_of: '2026-10-09T08:00:00Z',
      downsampled_for_storage: true,
    });
    show([parseBlock(base)]);
    const hero = screen.getByTestId('infographic-hero');
    expect(within(hero).getByTestId('infographic-hero-caption')).toHaveTextContent('Sample · last 30 days · as of 2026-10-09 08:00 UTC');
    expect(within(hero).getByTestId('infographic-hero-note')).toHaveTextContent('Showing top 4 of 7 · Downsampled for saved history');
  });

  it('does not repeat "Showing N of M" when the hero caption already states it', () => {
    const base = JSON.parse(JSON.stringify(ROUND12_RAW[4])) as { sections: Array<{ blocks: Array<Record<string, unknown>> }> };
    Object.assign(base.sections[0].blocks[1], { caption: 'Showing 4 of 7 · Sample', truncated: true, total: 7 });
    show([parseBlock(base)]);
    expect(screen.getByTestId('infographic-hero-caption')).toHaveTextContent('Showing 4 of 7 · Sample');
    expect(screen.queryByTestId('infographic-hero-note')).toBeNull();
  });

  it('a comparison hero reads its baseline and flags a small-sample change, like the tiles', () => {
    const base = JSON.parse(JSON.stringify(ROUND12_RAW[4])) as { sections: Array<{ blocks: unknown[] }> };
    // The comparison group becomes the Brief's only KPI group (so it is the hero).
    base.sections[0].blocks[1] = JSON.parse(JSON.stringify(ROUND12_RAW[3]));
    show([parseBlock(base)]);
    const hero = screen.getByTestId('infographic-hero');
    const fp = within(hero).getAllByRole('listitem')[1];
    expect(fp).toHaveTextContent('+2.1 pp (+12.9%)');
    expect(fp).toHaveTextContent('vs Sep 2026: 16%');
    expect(within(fp).getByTestId('comparison-small-sample')).toHaveTextContent('n < 20');
    expect(within(hero).getByTestId('comparison-small-sample-note')).toHaveTextContent('fewer than 20 in a compared period');
    expect(within(hero).getAllByRole('listitem')[2]).toHaveTextContent('+5 (new)');
    expect(hero.textContent).not.toMatch(/Infinity|NaN|∞/);
  });

  it('does not say a section heading twice when its only card has the same title', () => {
    const base = JSON.parse(JSON.stringify(ROUND12_RAW[4])) as { sections: Array<{ heading: string; blocks: Array<Record<string, unknown>> }> };
    base.sections[2].heading = 'Rules that opened the MOST cases';
    show([parseBlock(base)]);
    const heading = screen.getByRole('heading', { level: 5, name: 'Rules that opened the MOST cases' });
    expect(heading).toHaveClass('sr-only');
    // The group keeps its name and the card keeps its visible title.
    expect(screen.getByRole('group', { name: 'Rules that opened the MOST cases' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Rules that opened the most cases' })).not.toHaveClass('sr-only');
    // A heading over two charts stays visible.
    expect(screen.getByRole('heading', { level: 5, name: 'Volume' })).not.toHaveClass('sr-only');
  });

  it('keeps a section heading visible over prose that carries the same title (prose draws no title)', () => {
    const base = JSON.parse(JSON.stringify(ROUND12_RAW[4])) as { sections: Array<Record<string, unknown>> };
    base.sections.push({
      id: 'next',
      heading: 'Next steps',
      blocks: [{ id: 'ns-md', type: 'markdown', provenance: 'ai', title: 'Next steps', text: '1. Tune the SSH brute force rule.\n2. Review open cases.' }],
    });
    show([parseBlock(base)]);
    const section = screen.getByRole('group', { name: 'Next steps' });
    const heading = within(section).getByRole('heading', { level: 5, name: 'Next steps' });
    expect(heading).not.toHaveClass('sr-only');
    expect(heading).not.toHaveAttribute('data-repeats-leaf');
    // The words are on screen exactly once: the heading (the prose shows only its text).
    const visible = section.cloneNode(true) as HTMLElement;
    visible.querySelectorAll('.sr-only').forEach((n) => n.remove());
    expect(visible.textContent?.match(/Next steps/g)).toHaveLength(1);
  });

  it('opens an executive or monthly Brief with its first summary as the lead', () => {
    const base = ROUND12_RAW[4] as Record<string, unknown> & { sections: Array<Record<string, unknown>> };
    const monthly = parseBlock({
      ...base,
      template: 'monthly',
      layout: undefined,
      sections: [{ ...base.sections[0], summary: 'October in one line.' }, ...base.sections.slice(1)],
    }) as ReportBlock;
    show([monthly]);
    expect(screen.getByTestId('block-report')).toHaveAttribute('data-layout', 'document');
    expect(screen.getByTestId('report-template')).toHaveTextContent('Monthly SOC report');
    expect(screen.getByTestId('report-lead')).toHaveTextContent('October in one line.');
  });

  it('names an investigation brief and an executive summary, and no template for a custom Brief', () => {
    const base = ROUND12_RAW[4] as Record<string, unknown>;
    const brief = parseBlock({ ...base, id: 'b1', template: 'investigation_brief', layout: 'document' });
    const exec = parseBlock({ ...base, id: 'b2', template: 'executive', layout: undefined });
    const custom = parseBlock({ ...base, id: 'b3', template: 'custom', layout: undefined });
    show([brief, exec, custom]);
    expect(screen.getAllByTestId('report-template').map((t) => t.textContent)).toEqual(['Investigation brief', 'Executive summary']);
  });
});

describe('print-hidden controls', () => {
  it("hides an entity's copy button on paper", () => {
    render(<BlockCard block={galleryBlock('ioc')} index={0} staticMode />);
    expect(screen.getByRole('button', { name: 'Copy value' })).toHaveAttribute('data-print-hide');
  });

  it('hides the zoom and Group by controls on paper', () => {
    show([round12Block('daily-cases')]);
    expect(screen.getByTestId('chart-rebin')).toHaveAttribute('data-print-hide');
  });
});

describe('accessibility', () => {
  // axe over a dozen charts is slow under a loaded runner: generous, explicit timeouts.
  it('every Round 12 block is axe-clean on screen', async () => {
    const { container } = render(<AnswerBlocks blocks={round12Blocks()} messageId="m1" />);
    expect(await axe(container)).toHaveNoViolations();
  }, 30_000);

  it('every Round 12 block is axe-clean on paper', async () => {
    const paper = render(
      <div>
        {round12Blocks().map((b, i) => (
          <BlockCard key={b.id} block={b} index={i} staticMode />
        ))}
      </div>,
    );
    expect(await axe(paper.container)).toHaveNoViolations();
  }, 30_000);
});
