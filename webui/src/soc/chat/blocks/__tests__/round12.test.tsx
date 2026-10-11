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

  it('shows the server context line when a change could not be measured', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const b = parseBlock({ ...raw, items: [{ key: 'x', label: 'Cases', value: 12, unit: 'count', context: 'Sep 2026: — · not measured' }] });
    show([b]);
    expect(screen.getByTestId('comparison-chat-0-0')).toHaveTextContent('Sep 2026: — · not measured');
  });

  it('turns the small-sample flag into the badge on an unmeasured change too', () => {
    const raw = ROUND12_RAW[3] as { items: Array<Record<string, unknown>> };
    const b = parseBlock({ ...raw, items: [{ key: 'x', label: 'FP rate', value: 60, unit: 'percent', context: 'Sep 2026: — · n < 20' }] });
    show([b]);
    const tile = screen.getByTestId('comparison-chat-0-0');
    expect(within(tile).getByTestId('comparison-small-sample')).toHaveTextContent('n < 20');
    expect(tile.textContent).toContain('Sep 2026: —n < 20');
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
    expect(screen.getByTestId('chart-zoom-bar')).toHaveTextContent('Zoomed to Jul 2026 – Oct 2026 (4 of 12 points)');
    expect(within(screen.getByTestId('chart-data-table')).getAllByRole('rowheader')).toHaveLength(4);
    fireEvent.click(screen.getByTestId('chart-zoom-reset'));
    expect(screen.queryByTestId('chart-zoom-bar')).toBeNull();
    expect(announce).toHaveBeenLastCalledWith('Zoom reset: showing all 12 points.');
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
    expect(svg).not.toContain('Wazuh');
    expect(svg).toContain('Oct 2026');
    expect(svg).not.toContain('Nov 2025');
    expect(svg).not.toContain('var(');
    expect(announce).toHaveBeenCalledWith('SVG downloaded');
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
    for (const g of screen.getAllByTestId('infographic-grid')) expect(g).not.toHaveClass('@[44rem]:grid-cols-2');
    // Print shows the charts' data tables (WP-REP rule).
    expect(screen.getAllByTestId('chart-data-table').length).toBeGreaterThan(0);
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
