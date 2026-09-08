/**
 * MitreHeatmap accessibility coverage (a11y re-audit, WCAG 1.3.1).
 *
 * The visible grid is decorative (role="presentation"); the visually-hidden
 * `<table>` is the screen-reader source of truth. The grid is JAGGED — each tactic
 * column has its own technique list of a different length — so the sr-table must NOT
 * be a single positional matrix (the prior layout used the first column's technique
 * as a row header but filled the cells with OTHER tactics' values at the same row
 * index, MISATTRIBUTING every count). The corrected table is ROW-PER-TACTIC, and each
 * cell carries its OWN `technique: value` pair, so no value is ever bound to the wrong
 * technique/tactic.
 */
import { describe, it, expect } from 'vitest';
import { render, within } from '@testing-library/react';
import { MitreHeatmap, MultiSeriesTrend, type MitreTacticColumn } from '../charts-soc';

/** A deliberately jagged fixture: Execution has 2 techniques, Persistence has 1. */
const COLUMNS: MitreTacticColumn[] = [
  {
    tactic: 'TA0002',
    label: 'Execution',
    cells: [
      { technique: 'T1059', name: 'Command and Scripting', value: 7 },
      { technique: 'T1203', name: 'Exploitation', value: 3 },
    ],
  },
  {
    tactic: 'TA0003',
    label: 'Persistence',
    cells: [{ technique: 'T1543', name: 'Create or Modify System Process', value: 5 }],
  },
];

describe('MitreHeatmap — sr-only data table alignment (#2)', () => {
  it('renders one row per tactic with each cell bound to its OWN technique + value', () => {
    const { container } = render(<MitreHeatmap columns={COLUMNS} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    const rows = within(table as HTMLTableElement).getAllByRole('row');
    // 1 header row + 1 row per tactic.
    expect(rows).toHaveLength(1 + COLUMNS.length);

    // Header row: a "Tactic" column header + one slot header per technique position.
    const headerCells = within(rows[0]).getAllByRole('columnheader');
    expect(headerCells[0]).toHaveTextContent('Tactic');
    // The tallest column has 2 techniques → two technique slot headers.
    expect(headerCells).toHaveLength(1 + 2);

    // Row 1 = Execution: its row header is the tactic label; the two cells are the
    // Execution techniques' OWN values (T1059:7, T1203:3) — never Persistence's.
    const execRow = rows[1];
    expect(within(execRow).getByRole('rowheader')).toHaveTextContent('Execution');
    const execCells = within(execRow).getAllByRole('cell');
    expect(execCells[0]).toHaveTextContent('T1059');
    expect(execCells[0]).toHaveTextContent('7');
    expect(execCells[1]).toHaveTextContent('T1203');
    expect(execCells[1]).toHaveTextContent('3');

    // Row 2 = Persistence: only one technique → the second slot cell is EMPTY (the
    // jagged tail), and the value present is Persistence's own (T1543:5), proving the
    // misattribution is gone (no Execution value leaks into the Persistence row).
    const persistRow = rows[2];
    expect(within(persistRow).getByRole('rowheader')).toHaveTextContent('Persistence');
    const persistCells = within(persistRow).getAllByRole('cell');
    expect(persistCells[0]).toHaveTextContent('T1543');
    expect(persistCells[0]).toHaveTextContent('5');
    expect(persistCells[1]).toHaveTextContent(''); // no spilled value from another tactic
    // The Execution-only value 7 must NOT appear anywhere in the Persistence row.
    expect(persistRow).not.toHaveTextContent('7');
  });

  it('still renders an accessible empty state with no columns', () => {
    const { getByRole } = render(<MitreHeatmap columns={[]} />);
    expect(getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('no data'));
  });
});

describe('MitreHeatmap — viridis magnitude ramp, never a severity hue (round-6 #2/#6)', () => {
  it('fills populated cells with the viridis sequential() rgb() ramp, not the --critical token', () => {
    const { container } = render(<MitreHeatmap columns={COLUMNS} />);
    const bgs = Array.from(container.querySelectorAll('div[style*="background"]'))
      .map((el) => (el as HTMLElement).style.backgroundColor)
      .filter(Boolean);
    expect(bgs.length).toBeGreaterThan(0);
    // At least one populated cell renders a concrete viridis rgb() color.
    expect(bgs.some((b) => b.startsWith('rgb('))).toBe(true);
    // A COUNT is a magnitude, not a severity — never recycle the --critical token as the ramp.
    expect(bgs.every((b) => !b.includes('--critical'))).toBe(true);
  });

  it('ignores the deprecated colorToken override (magnitude stays viridis)', () => {
    const { container } = render(<MitreHeatmap columns={COLUMNS} colorToken="critical" />);
    const bgs = Array.from(container.querySelectorAll('div[style*="background"]')).map(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    expect(bgs.some((b) => b.startsWith('rgb('))).toBe(true);
    expect(bgs.every((b) => !b.includes('--critical'))).toBe(true);
  });
});

/**
 * `MultiSeriesTrend fill` — the escape from a pinned pixel height.
 *
 * `height` renders as an inline style, and the `<ResponsiveContainer height="100%">`
 * inside it can only ever be 100% of that constant — so a chart in a stretched flex cell
 * leaves every spare pixel as dead space below itself. `fill` makes the chart
 * `absolute inset-0` with NO inline height, so it takes the size of the box it is given.
 *
 * jsdom performs no layout, so the resulting height is unassertable here by construction.
 * What IS assertable, and what actually regresses, is the contract: which classes are
 * emitted, that no inline height survives, that BOTH render arms honour it (a caller that
 * stops passing `height` must not get the 240px default back on the no-data box), and
 * that the default stays byte-identical for the existing callers.
 */
describe('MultiSeriesTrend — fill vs a pinned height', () => {
  const SERIES = [{ key: 'a', label: 'A' }];
  const ROWS = [
    { x: '1', a: 1 },
    { x: '2', a: 2 },
  ];

  it('pins an inline height by default, for every existing caller', () => {
    const { container } = render(
      <MultiSeriesTrend data={ROWS} series={SERIES} height={132} ariaLabel="Trend" />,
    );
    const box = container.querySelector('[role="img"]') as HTMLElement;
    expect(box.style.height).toBe('132px');
    expect(box.className).not.toMatch(/absolute/);
  });

  it('fills its positioned ancestor instead, with no inline height, when fill is set', () => {
    const { container } = render(
      <MultiSeriesTrend data={ROWS} series={SERIES} fill ariaLabel="Trend" />,
    );
    const box = container.querySelector('[role="img"]') as HTMLElement;
    expect(box).toHaveClass('absolute', 'inset-0');
    expect(box.style.height).toBe('');
  });

  it('honours fill on the NO-DATA arm too, so an empty series cannot fall back to 240px', () => {
    const { container } = render(
      <MultiSeriesTrend data={[]} series={SERIES} fill ariaLabel="Trend" />,
    );
    const box = container.querySelector('[role="img"]') as HTMLElement;
    expect(box).toHaveTextContent('No data');
    expect(box).toHaveClass('absolute', 'inset-0');
    expect(box.style.height).toBe('');
  });

  it('merges the caller className rather than replacing it', () => {
    const { container } = render(
      <MultiSeriesTrend data={ROWS} series={SERIES} fill className="rounded-md" ariaLabel="T" />,
    );
    const box = container.querySelector('[role="img"]') as HTMLElement;
    expect(box).toHaveClass('absolute', 'inset-0', 'rounded-md');
  });
});
