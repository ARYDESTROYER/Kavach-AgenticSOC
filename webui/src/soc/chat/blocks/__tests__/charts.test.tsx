/**
 * Chart renderers (BLOCKS.md chart table + §6): every kind renders, keeps an sr-only data
 * table, draws `null` as hatched / broken (never 0), is ONE tab stop with the arrow-key
 * cursor, shows a hoverable tooltip on focus that Esc dismisses, announces through the
 * shell announcer, toggles legend series (never the last one) and drills through.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

import AnswerBlocks from '../AnswerBlocks';
import { BlockBody } from '../BlockCard';
import { ChartBlockView } from '../charts/ChartBlockView';
import { placeTooltip } from '../charts/ChartTooltipPortal';
import { galleryBlock } from '../__fixtures__/gallery';
import { parseBlock, parseBlocks } from '../schema';
import type { AnswerBlock, ChartBlock, InternalRef } from '../schema';

function show(block: AnswerBlock, onNavigate?: (ref: InternalRef) => void) {
  return render(<AnswerBlocks blocks={[block]} messageId="m1" onNavigate={onNavigate} />);
}

function focusPlot(testId: string): HTMLElement {
  const plot = screen.getByTestId(`${testId}-plot`);
  act(() => plot.focus());
  return plot;
}

const tooltip = (testId: string) => screen.queryByTestId(`${testId}-tooltip`);

beforeEach(() => announce.mockClear());
afterEach(() => vi.clearAllTimers());

describe('columns (bar)', () => {
  it('renders a labelled one-tab-stop group with an sr-only data table', () => {
    show(galleryBlock('severity-mix'));
    const plot = screen.getByTestId('chart-bar-plot');
    expect(plot).toHaveAttribute('role', 'group');
    expect(plot).toHaveAttribute('tabindex', '0');
    expect(plot.getAttribute('aria-label')).toMatch(/Open cases by severity\. Column chart/);
    const table = screen.getByTestId('chart-data-table');
    expect(table).toHaveClass('sr-only');
    expect(within(table).getAllByRole('row')).toHaveLength(6);
  });

  it('colours single-series semantic categories by their axis (enum lookup only)', () => {
    const { container } = show(galleryBlock('severity-mix'));
    const fills = Array.from(container.querySelectorAll('path[data-series="0"]')).map((p) => p.getAttribute('fill'));
    expect(fills[0]).toBe('hsl(var(--critical))');
    expect(fills[1]).toBe('hsl(var(--high))');
  });

  it('moves the cursor with the arrow keys, Home/End, and Esc dismisses the tooltip', () => {
    show(galleryBlock('severity-mix'));
    const plot = focusPlot('chart-bar');
    // Focus lands on the newest (last) position.
    expect(tooltip('chart-bar')).toHaveTextContent('info');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(tooltip('chart-bar')).toHaveTextContent('low');
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(tooltip('chart-bar')).toHaveTextContent('critical');
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/^critical: Cases 3\./));
    fireEvent.keyDown(plot, { key: 'End' });
    expect(tooltip('chart-bar')).toHaveTextContent('info');
    expect(screen.getByTestId('chart-focus-ring')).toBeInTheDocument();
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(tooltip('chart-bar')).toBeNull();
  });

  it('drills through on Enter and says so in the tooltip', () => {
    const nav = vi.fn();
    show(galleryBlock('severity-mix'), nav);
    const plot = focusPlot('chart-bar');
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(tooltip('chart-bar')).toHaveTextContent('Open in Cases ›');
    fireEvent.keyDown(plot, { key: 'Enter' });
    expect(nav).toHaveBeenCalledWith({ page: 'cases', opts: { severity: 'critical' } });
  });

  it('opens the tooltip on hover over a slot', () => {
    show(galleryBlock('severity-mix'));
    const plot = screen.getByTestId('chart-bar-plot');
    fireEvent.mouseMove(plot, { clientX: 400, clientY: 50 });
    expect(tooltip('chart-bar')).not.toBeNull();
  });
});

describe('stacked columns', () => {
  it('hatches a slot with a missing part instead of drawing a smaller total', () => {
    const { container } = show(galleryBlock('alerts-by-source'));
    const hatched = container.querySelectorAll('rect[data-state="unmeasured"]');
    expect(hatched).toHaveLength(1);
    expect(hatched[0].getAttribute('data-index')).toBe('6');
    expect(container.querySelectorAll('[data-index="6"][data-series]')).toHaveLength(0);
    const table = screen.getByTestId('chart-data-table');
    expect(within(table).getAllByRole('row')[7]).toHaveTextContent('not measured');
  });

  it('reads the total first, then segments top-to-bottom; ↑ picks a segment', () => {
    show(galleryBlock('alerts-by-source'));
    const plot = focusPlot('chart-stacked_bar');
    const tip = tooltip('chart-stacked_bar')!;
    expect(tip).toHaveTextContent('In progress');
    const labels = Array.from(tip.querySelectorAll('.grid > span:nth-child(3n)')).map((s) => s.textContent);
    expect(labels[0]).toBe('total');
    expect(labels.slice(1)).toEqual(['Other', 'Elastic', 'Wazuh']);
    fireEvent.keyDown(plot, { key: 'ArrowUp' });
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/: Wazuh 140\.$/));
  });

  it('says "not measured" for the hatched bucket', () => {
    show(galleryBlock('alerts-by-source'));
    const plot = focusPlot('chart-stacked_bar');
    for (let k = 0; k < 5; k += 1) fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(tooltip('chart-stacked_bar')).toHaveTextContent('total, not measured');
  });

  it('gives each segment a reconciling share, in the tooltip and the data table', () => {
    show(galleryBlock('alerts-by-source'));
    focusPlot('chart-stacked_bar');
    // Last slot: Wazuh 140 + Elastic 80 + Other 12 = 232 → 60.3 / 34.5 / 5.2, rounded by
    // largest remainder to 60 / 35 / 5 so the shares sum to exactly 100.
    const tip = tooltip('chart-stacked_bar')!;
    expect(tip).toHaveTextContent('140 · 60%');
    expect(tip).toHaveTextContent('80 · 35%');
    expect(tip).toHaveTextContent('12 · 5%');
    const rows = within(screen.getByTestId('chart-data-table')).getAllByRole('row');
    expect(rows[12]).toHaveTextContent('232');
    expect(rows[12]).toHaveTextContent('140 (60%)');
    // A slot with a missing part has no total and no shares.
    expect(rows[7]).not.toHaveTextContent('%');
  });

  it('after a legend toggle, qualifies the drawn total and keeps the table Total over every series', () => {
    show(galleryBlock('alerts-by-source'));
    fireEvent.click(screen.getAllByRole('button', { pressed: true })[2]); // hide "Other"
    focusPlot('chart-stacked_bar');
    const tip = tooltip('chart-stacked_bar')!;
    expect(tip).toHaveTextContent('total of shown series');
    expect(tip).toHaveTextContent('220');
    expect(announce).toHaveBeenLastCalledWith(expect.stringMatching(/: total of shown series 220, /));
    // The sr-only row still lists all three series, so its Total covers all three.
    const rows = within(screen.getByTestId('chart-data-table')).getAllByRole('row');
    expect(rows[12]).toHaveTextContent('232');
  });

  it('toggles legend series but always keeps one visible', () => {
    const { container } = show(galleryBlock('alerts-by-source'));
    const buttons = screen.getAllByRole('button', { pressed: true });
    expect(buttons.map((b) => b.textContent)).toEqual(['Wazuh', 'Elastic', 'Other']);
    fireEvent.click(buttons[0]);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelectorAll('[data-series="0"]')).toHaveLength(0);
    expect(announce).toHaveBeenLastCalledWith('Showing 2 of 3 series');
    // The once-missing Wazuh bucket no longer hatches its slot.
    expect(container.querySelectorAll('rect[data-state="unmeasured"]')).toHaveLength(0);
    fireEvent.click(buttons[1]);
    fireEvent.click(buttons[2]);
    expect(buttons[2]).toHaveAttribute('aria-pressed', 'true');
    expect(announce).toHaveBeenLastCalledWith('At least one series must stay visible');
  });
});

describe('line / area', () => {
  it('breaks the line at null and never interpolates', () => {
    const { container } = show(galleryBlock('mtta-trend'));
    const median = container.querySelectorAll('path[data-series="0"]');
    // Median has two unbroken runs (before and after the two missing buckets).
    expect(median).toHaveLength(2);
    expect(container.querySelector('[data-testid="chart-reference"]')).toHaveTextContent('SLA 30 min');
  });

  it('draws end dots with a surface ring and selective end labels for ≤ 4 series', () => {
    const { container } = show(galleryBlock('mtta-trend'));
    expect(container.querySelectorAll('circle[data-end-dot]')).toHaveLength(2);
    const svgText = Array.from(container.querySelectorAll('svg text')).map((t) => t.textContent);
    // End labels are clipped to 14 characters; the full label is in the legend and table.
    expect(svgText).toEqual(expect.arrayContaining(['Median', '90th percenti…']));
  });

  it('shows a crosshair and every series at x in one tooltip', () => {
    show(galleryBlock('mtta-trend'));
    const plot = focusPlot('chart-line');
    expect(screen.getByTestId('chart-crosshair')).toBeInTheDocument();
    fireEvent.keyDown(plot, { key: 'Home' });
    const tip = tooltip('chart-line')!;
    expect(tip).toHaveTextContent('Oct 7, 00:00–01:00 UTC');
    expect(tip).toHaveTextContent('Median');
    expect(tip).toHaveTextContent('90th percentile');
    // A not-measured bucket is said in words.
    for (let k = 0; k < 3; k += 1) fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(tooltip('chart-line')).toHaveTextContent('Median, not measured');
  });

  it('draws the y axis title when the block carries one', () => {
    const block = parseBlock({ ...(galleryBlock('mtta-trend') as object), y_label: 'Minutes to acknowledge' });
    show(block);
    expect(screen.getByTestId('chart-y-label')).toHaveTextContent('Minutes to acknowledge');
  });

  it('renders an area wash at low opacity', () => {
    const { container } = show(galleryBlock('tokens-area'));
    expect(container.querySelector('path[opacity="0.12"]')).not.toBeNull();
  });

  it('dashes the in-progress final segment', () => {
    const block = parseBlock({ ...(galleryBlock('alerts-by-source') as object), kind: 'line' });
    const { container } = show(block);
    expect(container.querySelectorAll('path[data-in-progress="true"]').length).toBeGreaterThan(0);
  });
});

describe('horizontal bars', () => {
  it('uses the BarList for a simple single series of ≤ 10 rows', () => {
    show(galleryBlock('top-hosts'));
    expect(screen.getByTestId('chart-hbar-list')).toBeInTheDocument();
    expect(screen.getAllByText('web-01.corp.example').length).toBeGreaterThan(0);
    expect(screen.getByTestId('chart-data-table')).toBeInTheDocument();
  });

  it('draws SVG rows with a hatched null row and ↑/↓ navigation otherwise', () => {
    const block = parseBlock({
      id: 'h',
      type: 'chart',
      kind: 'hbar',
      title: 'Rules',
      provenance: 'source',
      artifact_kind: 'categories',
      allowed_views: ['hbar', 'bar', 'table'],
      untrusted: true,
      unit: 'count',
      x: { kind: 'category', values: Array.from({ length: 12 }, (_, i) => `rule-${i}`) },
      series: [{ key: 's', label: 'Hits', values: [50, 40, null, 30, 20, 10, 9, 8, 7, 6, 5, 4] }],
    });
    const { container } = show(block);
    expect(container.querySelectorAll('rect[data-state="unmeasured"]')).toHaveLength(1);
    const plot = focusPlot('chart-hbar');
    expect(tooltip('chart-hbar')).toHaveTextContent('rule-0');
    fireEvent.keyDown(plot, { key: 'ArrowDown' });
    fireEvent.keyDown(plot, { key: 'ArrowDown' });
    expect(tooltip('chart-hbar')).toHaveTextContent('Hits, not measured');
    // Untrusted labels render mono and never as links.
    expect(container.querySelector('svg text.font-mono')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('reference labels', () => {
  it('labels an hbar reference line in a strip above the rows', () => {
    const block = parseBlock({
      ...(galleryBlock('top-hosts') as object),
      reference: { axis: 'y', value: 1000, label: 'Alert threshold' },
    });
    show(block);
    expect(screen.getByTestId('chart-reference-label')).toHaveTextContent('Alert threshold');
  });
});

describe('static / print path', () => {
  it('draws charts at the fixed width with their data table VISIBLE and no tab stop', () => {
    render(<ChartBlockView block={galleryBlock('severity-mix') as ChartBlock} title="Open cases by severity" staticMode />);
    const table = screen.getByTestId('chart-data-table');
    expect(table).not.toHaveClass('sr-only');
    expect(screen.getByTestId('chart-bar-plot')).not.toHaveAttribute('tabindex');
  });

  it('shows every table row with no View-all button, and no card controls', () => {
    render(<BlockBody block={galleryBlock('signins')} title="Recent sign-in failures" index={0} staticMode />);
    expect(screen.getAllByRole('row')).toHaveLength(13);
    expect(screen.queryByRole('button', { name: /View all/ })).toBeNull();
  });

  it('draws a dishonest stack as grouped columns even on the static path', () => {
    const stacked = parseBlock({ ...(galleryBlock('mtta-trend') as object), kind: 'stacked_bar' }) as ChartBlock;
    render(<ChartBlockView block={stacked} title="Time to acknowledge" staticMode />);
    expect(screen.getByTestId('chart-bar')).toBeInTheDocument();
    expect(screen.queryByText(/^Total$/)).toBeNull();
  });
});

describe('donut', () => {
  it('labels every part with value and a reconciling share', () => {
    show(galleryBlock('verdicts'));
    const legend = screen.getByRole('list', { name: 'Parts' });
    expect(legend).toHaveTextContent('14 · 13%');
    expect(legend).toHaveTextContent('61 · 59%');
    expect(legend).toHaveTextContent('7 · 7%');
    expect(screen.getByTestId('chart-donut-plot')).toHaveTextContent('104');
  });

  it('walks segments with ←/→', () => {
    show(galleryBlock('verdicts'));
    const plot = focusPlot('chart-donut');
    expect(tooltip('chart-donut')).toHaveTextContent('true_positive');
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(tooltip('chart-donut')).toHaveTextContent('false_positive');
    expect(tooltip('chart-donut')).toHaveTextContent('59%');
  });

  it('withholds the total and shares when a part is not measured', () => {
    const block = parseBlock({ ...(galleryBlock('verdicts') as object), series: [{ key: 'c', label: 'Cases', values: [1, null, 2, 3] }] });
    show(block);
    expect(screen.getByTestId('chart-donut-plot')).toHaveTextContent('not all measured');
    expect(screen.getByRole('list', { name: 'Parts' })).toHaveTextContent('— · —');
  });
});

describe('sparkline and funnel', () => {
  it('renders decorative columns with first/peak/latest in text', () => {
    const { container } = show(galleryBlock('ingest-spark'));
    const spark = screen.getByTestId('chart-sparkline');
    expect(container.querySelector('[data-testid="trend-columns"]')).toHaveAttribute('aria-hidden', 'true');
    expect(spark).toHaveTextContent('first 5,100');
    expect(spark).toHaveTextContent('peak 7,000');
    expect(spark).toHaveTextContent('11 of 12 buckets measured.');
    expect(container.querySelector('rect[data-state="unmeasured"]')).not.toBeNull();
    expect(container.querySelector('rect[data-state="zero"]')).not.toBeNull();
  });

  it('shows the step-down between funnel stages', () => {
    show(galleryBlock('triage-funnel'));
    const steps = screen.getAllByTestId('funnel-step').map((s) => s.textContent);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toBe('↓ 11% kept · −89%');
    const plot = focusPlot('chart-funnel');
    fireEvent.keyDown(plot, { key: 'End' });
    expect(tooltip('chart-funnel')).toHaveTextContent('of the first stage');
  });
});

describe('heatmap', () => {
  it('hatches null cells apart from measured zeros, with 2-D arrow navigation', () => {
    const { container } = show(galleryBlock('logon-heatmap'));
    expect(container.querySelectorAll('[data-state="unmeasured"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-state="zero"]').length).toBeGreaterThan(0);
    const plot = focusPlot('chart-heatmap');
    expect(tooltip('chart-heatmap')).toHaveTextContent('Mon · 00');
    fireEvent.keyDown(plot, { key: 'ArrowDown' });
    fireEvent.keyDown(plot, { key: 'ArrowRight' });
    expect(tooltip('chart-heatmap')).toHaveTextContent('Tue · 02');
    const table = screen.getByTestId('chart-data-table');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(table).toHaveTextContent('not measured');
  });
});

describe('tooltip placement (WCAG 1.4.13: beside the mark, inside the viewport)', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 256, height: 120 };
  const plot = { left: 100, right: 700, top: 100, bottom: 300 };

  it('prefers the side away from the plot centre', () => {
    expect(placeTooltip({ left: 120, right: 140, top: 110, bottom: 290 }, plot, size, viewport).left).toBe(146);
    expect(placeTooltip({ left: 600, right: 620, top: 110, bottom: 290 }, plot, size, viewport).left).toBe(600 - 6 - 256);
  });

  it('falls below a full-width row and clamps 8px inside the viewport', () => {
    const p = placeTooltip({ left: 0, right: 1000, top: 760, bottom: 790 }, plot, size, viewport);
    expect(p.top).toBeLessThanOrEqual(800 - 8 - 120);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});

describe('empty chart', () => {
  it('is never materialised from untrusted input (D3: no empty shell)', () => {
    const raw = { ...(galleryBlock('mtta-trend') as object), x: { kind: 'time', values: [] }, series: [{ key: 'a', label: 'A', values: [] }] };
    const { blocks, dropped } = parseBlocks([raw]);
    expect(blocks).toEqual([]);
    expect(dropped).toEqual([{ path: '1', type: 'chart', reason: 'empty' }]);
    const { container } = render(<AnswerBlocks blocks={blocks} messageId="m1" />);
    expect(screen.queryByTestId('chart-empty')).toBeNull();
    expect(container.querySelector('[data-block-type]')).toBeNull();
  });

  it('the renderer still says there is nothing to draw if handed one directly (defence in depth)', () => {
    const base = parseBlock(galleryBlock('mtta-trend')) as ChartBlock;
    const block: ChartBlock = { ...base, x: { ...base.x, values: [] }, series: base.series.map((s) => ({ ...s, values: [] })) };
    render(<ChartBlockView block={block} />);
    expect(screen.getByTestId('chart-empty')).toHaveTextContent('No data points in this window.');
  });
});
