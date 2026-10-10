/**
 * The visually hidden data table behind every chart (BLOCKS.md "Accessibility"): a
 * `<caption>`, a column per series, a row per x position, and "not measured" for `null`
 * (G3). It is ALWAYS present while the chart view is shown, so a screen-reader user can
 * read every value without the arrow-key cursor.
 *
 * In the print / static path (`visible`) the same table is shown under the chart (SPEC
 * §9.3, BLOCKS.md §7.4): a printed page has no tooltip or cursor to read values from.
 * The static layout is sized against an A4 text column ({@link STATIC_TABLE_BUDGET}) from
 * an estimate of each column's width (Round 12 WP-REP), so no table runs past the page:
 *
 *   - too many columns (a 24- or 48-bucket heatmap): the value columns print as
 *     consecutive tables of the columns that fit, each repeating the row labels and
 *     saying which columns it holds;
 *   - a long, narrow series (more than {@link SPLIT_FROM} rows): side-by-side groups,
 *     each with the header repeated, but only as many as fit the width, and never for
 *     labels that would wrap (long rule names) or three or more value columns — so the
 *     data stays complete without pages of short rows under every chart ("every chart
 *     prints twice").
 *
 * Every visible table has a fixed layout with the estimated column widths and wraps long
 * text anywhere, so even a label the estimate missed wraps inside its column instead of
 * pushing the table past the page edge.
 */

import { cn } from '@/lib/cn';

export interface FallbackRow {
  key: string;
  header: string;
  cells: string[];
}

export interface DataTableFallbackProps {
  caption: string;
  rowHeader: string;
  columns: string[];
  rows: FallbackRow[];
  className?: string;
  testId?: string;
  /** Show the table visibly under the chart (print / static export) instead of sr-only. */
  visible?: boolean;
}

const VISIBLE_TABLE = cn(
  'mt-2 w-full border-collapse text-left text-xs tabular-nums',
  '[&_caption]:pb-1 [&_caption]:text-left [&_caption]:text-muted-foreground',
  '[&_th]:border-b [&_th]:border-border [&_th]:px-1.5 [&_th]:py-1 [&_th]:font-medium',
  '[&_td]:border-b [&_td]:border-border/60 [&_td]:px-1.5 [&_td]:py-1',
);

/** Long text wraps inside its column, at any character if it must (static tables only). */
const WRAP_ANYWHERE = '[&_td]:[overflow-wrap:anywhere] [&_th]:[overflow-wrap:anywhere]';

/** A visible series longer than this many rows may be split into side-by-side groups. */
export const SPLIT_FROM = 12;

/**
 * The width a static data table may take (CSS px): an A4 page's text column (186 mm,
 * about 703 px) less the report card's padding, with room to spare.
 */
export const STATIC_TABLE_BUDGET = 640;

/** Estimated width of one character at the table's size, a cell's padding, a group gap. */
const CHAR_PX = 7;
const CELL_PAD_PX = 14;
const GROUP_GAP_PX = 16;
/** A row label longer than this wraps instead of widening its column further (and is never split side by side). */
const ROW_LABEL_CAP = 28;
/** A value or header word longer than this wraps instead of widening its column further. */
const VALUE_CAP = 16;

const longestWord = (text: string): number => Math.max(0, ...text.split(/\s+/).map((w) => w.length));

/**
 * The most side-by-side groups for `columns` value columns, whatever the width: three
 * for one value column, two for two, otherwise one.
 */
export function maxGroups(columns: number): number {
  if (columns <= 1) return 3;
  return columns === 2 ? 2 : 1;
}

/** Estimated column widths (px): the row-label column first, then each value column. */
export function columnEstimates(rowHeader: string, columns: readonly string[], rows: readonly FallbackRow[]): number[] {
  const label = Math.min(ROW_LABEL_CAP, Math.max(1, longestWord(rowHeader), ...rows.map((r) => r.header.length)));
  const values = columns.map((c, i) => Math.min(VALUE_CAP, Math.max(1, longestWord(c), ...rows.map((r) => (r.cells[i] ?? '').length))));
  return [label, ...values].map((chars) => chars * CHAR_PX + CELL_PAD_PX);
}

export interface StaticTableLayout {
  /** Estimated widths (px), row-label column first. */
  widths: number[];
  /** Value-column indexes per printed table (one entry when every column fits). */
  chunks: number[][];
  /** Side-by-side row groups (1 when the table is split by columns or fits as is). */
  groups: number;
}

/** How a visible data table is laid out on an A4 page (pure; exported for tests). */
export function staticLayout(
  rowHeader: string,
  columns: readonly string[],
  rows: readonly FallbackRow[],
  budget = STATIC_TABLE_BUDGET,
): StaticTableLayout {
  const widths = columnEstimates(rowHeader, columns, rows);
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > budget && columns.length > 1) {
    const chunks: number[][] = [];
    let chunk: number[] = [];
    let used = widths[0];
    columns.forEach((_, i) => {
      const w = widths[i + 1];
      if (chunk.length && used + w > budget) {
        chunks.push(chunk);
        chunk = [];
        used = widths[0];
      }
      chunk.push(i);
      used += w;
    });
    if (chunk.length) chunks.push(chunk);
    return { widths, chunks, groups: 1 };
  }
  const all = columns.map((_, i) => i);
  if (rows.length <= SPLIT_FROM) return { widths, chunks: [all], groups: 1 };
  // A label that would wrap (a long rule name) reads badly squeezed side by side.
  if (rows.some((r) => r.header.length > ROW_LABEL_CAP)) return { widths, chunks: [all], groups: 1 };
  const fit = Math.floor((budget + GROUP_GAP_PX) / (total + GROUP_GAP_PX));
  const groups = Math.max(1, Math.min(maxGroups(columns.length), fit, Math.ceil(rows.length / SPLIT_FROM)));
  return { widths, chunks: [all], groups };
}

/** Split `rows` into `groups` contiguous groups of (nearly) equal length. */
export function splitRows<T>(rows: readonly T[], groups: number): T[][] {
  if (groups < 2 || rows.length < 2) return [rows.slice()];
  const per = Math.ceil(rows.length / groups);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}

interface StaticTableProps {
  rowHeader: string;
  columns: readonly string[];
  /** The value columns this table shows (indexes into `columns` and each row's cells). */
  shown: readonly number[];
  rows: readonly FallbackRow[];
  widths: readonly number[];
  caption?: string;
  className?: string;
  testId?: string;
}

/** One visible table: fixed layout, the estimated widths as percentages, text that wraps. */
function StaticTable({ rowHeader, columns, shown, rows, widths, caption, className, testId }: StaticTableProps) {
  const own = [widths[0], ...shown.map((i) => widths[i + 1])];
  const total = own.reduce((a, b) => a + b, 0) || 1;
  return (
    <table
      className={cn(VISIBLE_TABLE, WRAP_ANYWHERE, className)}
      style={{ tableLayout: 'fixed' }}
      data-static-table=""
      data-testid={testId}
    >
      {caption ? <caption>{caption}</caption> : null}
      <colgroup>
        {own.map((w, i) => (
          <col key={i} style={{ width: `${((w / total) * 100).toFixed(2)}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th scope="col">{rowHeader}</th>
          {shown.map((i) => (
            <th key={i} scope="col">
              {columns[i]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.header}</th>
            {shown.map((i) => (
              <td key={i}>{r.cells[i]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DataTableFallback({
  caption,
  rowHeader,
  columns,
  rows,
  className,
  testId = 'chart-data-table',
  visible = false,
}: DataTableFallbackProps) {
  if (visible) {
    const layout = staticLayout(rowHeader, columns, rows);
    if (layout.chunks.length > 1) {
      // Too many columns for the page: consecutive tables, the row labels repeated.
      return (
        <div className={cn('mt-2 space-y-2', className)} data-testid={testId} data-chunks={layout.chunks.length}>
          <p className="pb-1 text-left text-xs text-muted-foreground">{caption}</p>
          {layout.chunks.map((chunk) => (
            <StaticTable
              key={chunk[0]}
              rowHeader={rowHeader}
              columns={columns}
              shown={chunk}
              rows={rows}
              widths={layout.widths}
              caption={`Columns ${chunk[0] + 1}–${chunk[chunk.length - 1] + 1} of ${columns.length}`}
              className="mt-0"
            />
          ))}
        </div>
      );
    }
    const all = layout.chunks[0];
    if (layout.groups > 1) {
      const groups = splitRows(rows, layout.groups);
      return (
        <div className={cn('mt-2', className)} data-testid={testId} data-groups={groups.length}>
          <p className="pb-1 text-left text-xs text-muted-foreground">{caption}</p>
          <div className="grid gap-x-4" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}>
            {groups.map((group, g) => (
              <StaticTable
                key={g}
                rowHeader={rowHeader}
                columns={columns}
                shown={all}
                rows={group}
                widths={layout.widths}
                className="mt-0 self-start text-2xs [&_td]:py-0.5 [&_th]:py-0.5"
              />
            ))}
          </div>
        </div>
      );
    }
    return <StaticTable rowHeader={rowHeader} columns={columns} shown={all} rows={rows} widths={layout.widths} caption={caption} className={className} testId={testId} />;
  }
  return (
    <table className={cn('sr-only', className)} data-testid={testId}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{rowHeader}</th>
          {columns.map((c, i) => (
            <th key={i} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.header}</th>
            {r.cells.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "not measured" for a missing value, else the formatted value. */
export function srValue(text: string, value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? text : 'not measured';
}
