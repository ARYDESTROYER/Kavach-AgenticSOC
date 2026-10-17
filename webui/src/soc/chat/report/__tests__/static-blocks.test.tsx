/**
 * The static (print / static export) modes of the block renderers (Round 12 SPEC WP-REP
 * R6, R7, R13, and the "every chart prints twice" finding): plain-text table headers, a
 * plain contents list in a Brief, case ids as text, no clamped or forced-single-line
 * cells, no card controls or provenance glyph, no `content-visibility`, and long
 * narrow chart data split into side-by-side column groups with every value kept.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BlockCard } from '../../blocks/BlockCard';
import {
  DataTableFallback,
  SPLIT_FROM,
  STATIC_TABLE_BUDGET,
  columnEstimates,
  maxGroups,
  splitRows,
  staticLayout,
  type FallbackRow,
} from '../../blocks/charts/DataTableFallback';
import { ChartBlockView } from '../../blocks/charts/ChartBlockView';
import { galleryBlock } from '../../blocks/__fixtures__/gallery';
import { parseBlock, type ChartBlock } from '../../blocks/schema';

describe('static table (R6)', () => {
  it('renders headers as text, case ids as text and long text unclamped', () => {
    render(<BlockCard block={galleryBlock('signins')} index={0} staticMode />);
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toContain('Attempts');
    for (const h of headers) expect(h.querySelector('button')).toBeNull();
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
    expect(within(table).getByText('case-1040')).toBeInTheDocument();
    expect(table.querySelector('.line-clamp-3')).toBeNull();
    // Every row (no "View all" in print).
    expect(within(table).getAllByRole('row')).toHaveLength(13);
  });

  it('keeps the interactive table unchanged on screen (sortable headers, case links)', () => {
    render(<BlockCard block={galleryBlock('signins')} index={0} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader')[0].querySelector('button')).not.toBeNull();
  });
});

describe('static card chrome (R7, R13)', () => {
  it('has no menu, no Add to report, no provenance glyph and no content-visibility', () => {
    const { container } = render(<BlockCard block={galleryBlock('alerts-by-source')} index={0} staticMode canAddToReport onAddToReport={() => undefined} />);
    expect(container.querySelector('figcaption button')).toBeNull();
    expect(container.querySelector('[data-testid="block-menu-trigger"]')).toBeNull();
    expect(container.querySelector('[data-testid="block-add-to-report"]')).toBeNull();
    expect(container.querySelector('[class*="content-visibility"]')).toBeNull();
    // The title wraps instead of truncating.
    expect(container.querySelector('figcaption h4')).not.toHaveClass('truncate');
  });

  it('keeps the screen card unchanged (controls and lazy paint)', () => {
    const { container } = render(<BlockCard block={galleryBlock('alerts-by-source')} index={0} />);
    expect(container.querySelector('[data-testid="block-menu-trigger"]')).not.toBeNull();
    expect(container.querySelector('[class*="content-visibility"]')).not.toBeNull();
  });
});

describe('static Brief (R6)', () => {
  it('prints the contents as a plain list with every section name', () => {
    render(<BlockCard block={galleryBlock('shift-brief')} index={0} staticMode />);
    const toc = screen.getByTestId('report-toc-static');
    const items = within(toc).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['Summary', 'Numbers', 'Watch next shift']);
    expect(within(toc).queryByRole('button')).toBeNull();
    // Every section heading and KPI value is present.
    for (const name of ['Summary', 'Numbers', 'Watch next shift']) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(screen.getByText('6,400')).toBeInTheDocument();
  });

  it('keeps the interactive contents on screen from 4 sections (Round 13, SPEC-chat T29)', () => {
    // Three sections need no contents control on screen (it only came back in print).
    const three = render(<BlockCard block={galleryBlock('shift-brief')} index={0} />);
    expect(screen.queryByRole('button', { name: /Contents \(3 sections\)/ })).toBeNull();
    three.unmount();
    const brief = galleryBlock('shift-brief');
    if (brief.type !== 'report') throw new Error('shift-brief is a report block');
    const four = { ...brief, sections: [...brief.sections, { ...brief.sections[0], id: 'extra', heading: 'Extra' }] };
    render(<BlockCard block={four} index={0} />);
    expect(screen.getByRole('button', { name: /Contents \(4 sections\)/ })).toBeInTheDocument();
  });
});

describe('static chart data', () => {
  const series = (n: number, header: (i: number) => string, cells: (i: number) => string[]): FallbackRow[] =>
    Array.from({ length: n }, (_, i) => ({ key: String(i), header: header(i), cells: cells(i) }));

  it('splits a long, narrow series into column groups and keeps every value', () => {
    const rows = series(30, (i) => `Day ${i + 1}`, (i) => [String(i * 10)]);
    expect(staticLayout('Day', ['Events'], rows).groups).toBe(3);
    expect(staticLayout('Day', ['Events'], rows.slice(0, SPLIT_FROM)).groups).toBe(1);
    expect(splitRows(rows, 3)).toHaveLength(3);
    expect(splitRows(rows, 1)).toHaveLength(1);
    render(<DataTableFallback caption="Events per day (count)" rowHeader="Day" columns={['Events']} rows={rows} visible />);
    const box = screen.getByTestId('chart-data-table');
    expect(box).toHaveAttribute('data-groups', '3');
    expect(box).toHaveTextContent('Events per day (count)');
    const tables = within(box).getAllByRole('table');
    expect(tables).toHaveLength(3);
    // Headers repeat in every group; all 30 values are there, in order.
    for (const t of tables) expect(within(t).getByRole('columnheader', { name: 'Events' })).toBeInTheDocument();
    const values = tables.flatMap((t) => within(t).getAllByRole('cell').map((c) => c.textContent));
    expect(values).toEqual(rows.map((r) => r.cells[0]));
  });

  it('never forces a row label onto one line: fixed layout, wrap anywhere, estimated widths', () => {
    const rows = series(30, (i) => `Day ${i + 1}`, (i) => [String(i)]);
    render(<DataTableFallback caption="c" rowHeader="Day" columns={['Events']} rows={rows} visible />);
    for (const table of within(screen.getByTestId('chart-data-table')).getAllByRole('table')) {
      expect(table.className).not.toMatch(/nowrap/);
      expect(table.className).toMatch(/overflow-wrap:anywhere/);
      expect(table.style.tableLayout).toBe('fixed');
      expect(table).toHaveAttribute('data-static-table');
      const cols = Array.from(table.querySelectorAll('col')).map((c) => parseFloat(c.style.width));
      expect(cols).toHaveLength(2);
      expect(cols.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
    }
  });

  it('splits by width, not by column count alone: groups only while they fit an A4 column', () => {
    // At most three groups for one value column, two for two, one for three or more.
    expect([1, 2, 3, 4].map(maxGroups)).toEqual([3, 2, 1, 1]);
    // A week of hourly buckets with three series and "(in progress)" labels: one table.
    const hourly = series(168, (i) => `Oct ${10 + Math.floor(i / 24)}, ${String(i % 24).padStart(2, '0')}:00–${String((i % 24) + 1).padStart(2, '0')}:00 UTC${i === 167 ? ' (in progress)' : ''}`, () => ['1,234', '56', '7']);
    expect(staticLayout('Time (UTC)', ['Opened', 'Closed automatically', 'Closed by an analyst'], hourly).groups).toBe(1);
    // Long untrusted category labels (Wazuh rule names): never side by side.
    const rules = series(15, (i) => `Firewall drop event repeated from the same source ${i}`, (i) => [String(1000 - i)]);
    expect(staticLayout('Rule', ['Alerts'], rules).groups).toBe(1);
    // Short labels and two value columns: two groups whose estimate fits the budget.
    const days = series(30, (i) => `Oct ${i + 1}`, () => ['1,234', '5,678']);
    const layout = staticLayout('Day', ['Alerts', 'Cases'], days);
    expect(layout.groups).toBe(2);
    const width = layout.widths.reduce((a, b) => a + b, 0);
    expect(layout.groups * width + (layout.groups - 1) * 16).toBeLessThanOrEqual(STATIC_TABLE_BUDGET);
  });

  it.each([24, 48])('prints a %i-column heatmap as consecutive tables that fit the page, every column kept', (n) => {
    const hours = Array.from({ length: n }, (_, i) => (n === 24 ? `${String(i).padStart(2, '0')}:00` : `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`));
    const rows = series(3, (i) => ['Mon', 'Tue', 'Wed'][i], (r) => hours.map((_, c) => (1000 + r * 37 + c).toLocaleString('en-US')));
    const layout = staticLayout('Day', hours, rows);
    expect(layout.chunks.length).toBeGreaterThan(1);
    // Every chunk fits the budget with the row labels repeated.
    for (const chunk of layout.chunks) {
      const w = layout.widths[0] + chunk.reduce((a, i) => a + layout.widths[i + 1], 0);
      expect(w).toBeLessThanOrEqual(STATIC_TABLE_BUDGET);
    }
    expect(layout.chunks.flat()).toEqual(hours.map((_, i) => i));
    render(<DataTableFallback caption="Failed logons per hour" rowHeader="Day" columns={hours} rows={rows} visible />);
    const box = screen.getByTestId('chart-data-table');
    expect(box).toHaveAttribute('data-chunks', String(layout.chunks.length));
    const tables = within(box).getAllByRole('table');
    expect(tables).toHaveLength(layout.chunks.length);
    // The row labels repeat in each part; the last column's header and value are present.
    for (const t of tables) expect(within(t).getByRole('rowheader', { name: 'Wed' })).toBeInTheDocument();
    expect(within(tables[tables.length - 1]).getByRole('columnheader', { name: hours[n - 1] })).toBeInTheDocument();
    expect(box).toHaveTextContent(rows[2].cells[n - 1]);
    expect(tables[tables.length - 1]).toHaveTextContent(`Columns ${layout.chunks[layout.chunks.length - 1][0] + 1}–${n} of ${n}`);
    // The same part notes as the Word export: later parts say "(continued)", the first does not.
    expect(tables[0].querySelector('caption')?.textContent).toMatch(/^Columns 1–\d+ of \d+$/);
    for (const t of tables.slice(1)) expect(t.querySelector('caption')?.textContent).toMatch(/^Columns? [\d–]+ of \d+ \(continued\)$/);
    const allCells = tables.flatMap((t) => within(t).getAllByRole('cell').map((c) => c.textContent));
    expect(allCells).toHaveLength(3 * n);
  });

  it('estimates each column from its longest label, word and value', () => {
    const w = columnEstimates('Day', ['Closed by an analyst'], [{ key: 'a', header: 'Monday', cells: ['12,345'] }]);
    // "Monday" (6) and "analyst"/"12,345" (7, 6): seven characters for the value column.
    expect(w[0]).toBeLessThan(w[1]);
  });

  it('keeps the screen-reader table whole (never split when not visible)', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ key: String(i), header: `D${i}`, cells: ['1'] }));
    render(<DataTableFallback caption="c" rowHeader="Day" columns={['v']} rows={rows} />);
    const table = screen.getByTestId('chart-data-table');
    expect(table.tagName).toBe('TABLE');
    expect(table).toHaveClass('sr-only');
  });

  it('draws a static chart with its visible data table', () => {
    const block = parseBlock(galleryBlock('mtta-trend') as object) as ChartBlock;
    render(<ChartBlockView block={block} title="MTTA" staticMode />);
    expect(screen.getByTestId('chart-data-table')).not.toHaveClass('sr-only');
  });
});
