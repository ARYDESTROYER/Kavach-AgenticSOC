/**
 * `table` block (BLOCKS.md §5.3 `table`, SPEC §7.4): the console's ONE table primitive
 * (`DataTable`, with its `aria-sort` + announcer contract) over client-side sort and
 * paging. Inline it shows at most 10 rows; "View all N rows" opens a dialog with
 * 25/50/100 paging. All-blank columns are hidden (the old ResultTable rule).
 *
 * Cells are TYPED by the column's enum, never by sniffing the value: badges for
 * severity/verdict/status, `RiskBadge` for risk, a router link for a case id, InlineCode
 * for entities and code, a validated ATT&CK id for mitre, UTC for time, tabular numbers.
 * Untrusted text (log/source-derived, G7) renders mono and is NEVER linkified.
 *
 * `staticMode` (print / static export) shows EVERY row with no paging and no "View all"
 * button: a printed page cannot open a dialog.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { InlineCode } from '@/soc/components/CodeBlock';
import { DataTable, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { RiskBadge, SeverityBadge, StatusBadge, VerdictBadge } from '@/soc/components/badges';
import { isSafeCaseId } from '@/soc/case-result-route';

import { CaseHoverArm, CaseLink } from '../context';
import { DASH, formatUtc, formatValue } from '../format';
import type { Cell, TableBlock, TableColumn } from '../schema';
import { CASE_STATUS_KEYS, PATTERN_SOURCES, SEVERITY_KEYS, VERDICT_KEYS } from '../schema';

export const INLINE_ROWS = 10;
const TECHNIQUE_RE = new RegExp(PATTERN_SOURCES.technique);

const has = (list: readonly string[], v: string) => list.includes(v.trim().toLowerCase());

function blank(cell: Cell): boolean {
  return cell === null || cell === '';
}

/** Columns that carry at least one value (all-blank columns are hidden). */
export function visibleColumns(block: TableBlock): number[] {
  return block.columns.map((_, i) => i).filter((i) => block.rows.some((r) => !blank(r[i] ?? null)));
}

/** Stable sort: numbers numerically, text by locale, null/blank always last. */
export function sortRows(rows: readonly Cell[][], col: number, dir: 'asc' | 'desc'): number[] {
  const idx = rows.map((_, i) => i);
  const sign = dir === 'asc' ? 1 : -1;
  return idx.sort((a, b) => {
    const va = rows[a][col] ?? null;
    const vb = rows[b][col] ?? null;
    const ba = blank(va);
    const bb = blank(vb);
    if (ba || bb) return ba === bb ? a - b : ba ? 1 : -1;
    let c = 0;
    if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
    else c = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    return c * sign || a - b;
  });
}

export function TypedCell({ value, column, untrusted }: { value: Cell; column: TableColumn; untrusted: boolean }) {
  if (blank(value)) return <span className="text-muted-foreground">{DASH}</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') {
    if (column.type === 'risk') return <RiskBadge score={value} />;
    return <span className="tabular-nums">{formatValue(value, column.unit ?? 'count')}</span>;
  }
  const text = value as string;
  switch (column.type) {
    case 'severity':
      if (has(SEVERITY_KEYS, text)) return <SeverityBadge severity={text.trim().toLowerCase()} />;
      break;
    case 'verdict':
      if (has(VERDICT_KEYS, text)) return <VerdictBadge verdict={text.trim().toLowerCase()} />;
      break;
    case 'status':
      if (has(CASE_STATUS_KEYS, text)) return <StatusBadge status={text.trim().toLowerCase()} />;
      break;
    case 'case':
      if (isSafeCaseId(text)) return <CaseLink facts={{ case_id: text }} className="font-mono text-xs" />;
      return <span className="font-mono text-xs">{text}</span>;
    case 'entity':
    case 'code':
      return <InlineCode className="text-xs">{text}</InlineCode>;
    case 'mitre':
      return TECHNIQUE_RE.test(text) ? <InlineCode className="text-xs">{text}</InlineCode> : <span className="font-mono text-xs">{text}</span>;
    case 'time':
      return <span className="whitespace-nowrap tabular-nums">{formatUtc(text)}</span>;
    default:
      break;
  }
  return (
    <span className={cn('line-clamp-3 break-words', untrusted && 'font-mono text-xs')} title={text.length > 80 ? text : undefined}>
      {text}
    </span>
  );
}

function columnUntrusted(col: TableColumn, block: TableBlock): boolean {
  return col.untrusted || (block.untrusted && (col.type === 'text' || col.type === 'entity' || col.type === 'code'));
}

export interface TableViewProps {
  block: TableBlock;
  title: string;
  /** Show every row with 25/50/100 paging (the dialog / expand sheet). */
  paged?: boolean;
  compact?: boolean;
  /** Print / static export: every row, no paging, no "View all" button. */
  staticMode?: boolean;
}

export function TableView({ block, title, paged: pagedProp = false, staticMode = false }: TableViewProps) {
  const paged = pagedProp && !staticMode;
  const cols = React.useMemo(() => visibleColumns(block), [block]);
  const initialSort = React.useMemo<SortState | null>(() => {
    if (!block.sort) return null;
    const i = block.columns.findIndex((c) => c.key === block.sort?.key);
    return i >= 0 ? { id: `col-${i}`, dir: block.sort.dir } : null;
  }, [block]);
  const [sort, setSort] = React.useState<SortState | null>(initialSort);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(25);
  const [viewAll, setViewAll] = React.useState(false);

  const order = React.useMemo(() => {
    if (!sort) return block.rows.map((_, i) => i);
    const col = Number(sort.id.slice(4));
    return sortRows(block.rows, col, sort.dir);
  }, [block.rows, sort]);

  const shown = staticMode ? order : paged ? order.slice((page - 1) * pageSize, page * pageSize) : order.slice(0, INLINE_ROWS);
  const hasCase = cols.some((i) => block.columns[i].type === 'case');

  const columns: Array<DataTableColumn<number>> = cols.map((i) => {
    const col = block.columns[i];
    const numeric = col.type === 'number' || col.type === 'risk';
    return {
      id: `col-${i}`,
      header: col.label,
      menuLabel: col.label,
      sortable: true,
      align: col.align ?? (numeric ? 'right' : 'left'),
      className: 'align-top text-sm',
      cell: (row: number) => (
        <TypedCell value={block.rows[row][i] ?? null} column={col} untrusted={columnUntrusted(col, block)} />
      ),
    };
  });

  if (cols.length === 0) {
    return <p className="text-sm text-muted-foreground">No values to show.</p>;
  }

  const table = (
    <DataTable<number>
      columns={columns}
      rows={shown}
      getRowId={(row) => `r${row}`}
      sort={sort}
      onSortChange={(s) => {
        setSort(s);
        setPage(1);
      }}
      density="compact"
      ariaLabel={title}
      empty="No rows"
      {...(paged
        ? {
            page,
            pageSize,
            total: order.length,
            onPageChange: setPage,
            onPageSizeChange: (s: number) => {
              setPageSize(s);
              setPage(1);
            },
            pageSizeOptions: [25, 50, 100],
          }
        : {})}
    />
  );

  return (
    <div className="min-w-0" data-testid="block-table">
      {hasCase ? <CaseHoverArm>{table}</CaseHoverArm> : table}
      {!paged && !staticMode && order.length > INLINE_ROWS ? (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Showing {INLINE_ROWS} of {order.length} rows
          </span>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setViewAll(true)}>
            View all {order.length} rows
          </Button>
        </div>
      ) : null}
      {viewAll ? (
        <Dialog open onOpenChange={(o) => setViewAll(o)}>
          <DialogContent className="max-h-[90dvh] w-[min(96vw,72rem)] max-w-none overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {order.length} rows{block.truncated ? ' (the source returned more; this is the bounded set)' : ''}.
              </DialogDescription>
            </DialogHeader>
            <TableView block={block} title={title} paged />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
