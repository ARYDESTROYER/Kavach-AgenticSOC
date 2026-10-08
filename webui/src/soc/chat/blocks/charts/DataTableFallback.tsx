/**
 * The visually hidden data table behind every chart (BLOCKS.md "Accessibility"): a
 * `<caption>`, a column per series, a row per x position, and "not measured" for `null`
 * (G3). It is ALWAYS present while the chart view is shown, so a screen-reader user can
 * read every value without the arrow-key cursor.
 *
 * In the print / static path (`visible`) the same table is shown under the chart (SPEC
 * §9.3, BLOCKS.md §7.4): a printed page has no tooltip or cursor to read values from.
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

export function DataTableFallback({
  caption,
  rowHeader,
  columns,
  rows,
  className,
  testId = 'chart-data-table',
  visible = false,
}: DataTableFallbackProps) {
  return (
    <table className={cn(visible ? VISIBLE_TABLE : 'sr-only', className)} data-testid={testId}>
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
