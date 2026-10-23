/**
 * `table` block (BLOCKS.md §5.3 `table`, SPEC §7.4): the console's ONE table primitive
 * (`DataTable`, with its `aria-sort` + announcer contract) over client-side sort and
 * paging. Inline it shows at most 10 rows; "View all N rows" opens a dialog with
 * 25/50/100 paging. All-blank columns are hidden (the old ResultTable rule).
 *
 * Cells are TYPED by the column's enum, never by sniffing the value: badges for
 * severity/verdict/status, `RiskBadge` for risk, a router link for a case id, InlineCode
 * for entities and code, a validated ATT&CK id for mitre, UTC for time, tabular numbers.
 * Untrusted text (log/source-derived, G7) renders mono and is NEVER linkified. A short
 * reference in a cell ("T1078", "CASE-000089", "LP-ES-RISK-1001") never breaks inside,
 * not even in a mono cell set `break-all` (PW4-1: "T107" / "8"); a longer value still may,
 * and a table wider than its frame scrolls inside it, with a fade on the side that has
 * more (PW4-2). Sans text cells are prose: proportional numerals (figures stay tabular).
 * A list of ATT&CK ids in a code or mitre cell ("T1021, T1048, T1078", perhaps "and 2
 * more") is one chip per technique: the chips wrap whole, so a chip's background is never
 * cut at a line end (closing pass: one inline code run over three lines read "T1021," /
 * "T1048," / "T1078" with its fill cut at each end).
 *
 * A blank cell draws nothing (closing pass: no em dash on screen); assistive tech reads
 * "None", or "Not measured" for a figure (a `null` number is not measured, G3).
 *
 * A case list shown as a table ("Show table", Expand) passes its items as `caseRefs`: the
 * Case column then names each case as the list view does, by its number with the internal
 * id in the tooltip (a case without a number shows its id, middle-ellipsised, in full for
 * assistive tech and in print), and links by the id.
 *
 * `staticMode` (print / static export) shows EVERY row with no paging and no "View all"
 * button: a printed page cannot open a dialog. Its headers are plain text (a sortable
 * header is a button, and a printed sort control means nothing), a case id is plain
 * mono text instead of a link, and long text is never clamped (Round 12 WP-REP R6).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { InlineCode } from '@/soc/components/CodeBlock';
import { DataTable, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { RiskBadge, SeverityBadge, StatusBadge, VerdictBadge } from '@/soc/components/badges';
import { isSafeCaseId } from '@/soc/case-result-route';

import { softBreakLongTokens as keepShortTokens } from '../../starters/soft-breaks';
import { CaseHoverArm, CaseLink, shortCaseId, type CaseLinkFacts } from '../context';
import { formatUtc, formatValue } from '../format';
import type { Cell, TableBlock, TableColumn } from '../schema';
import { TABLE_SCROLL_FADE, useTableScrollEdges } from '../scroll-edges';
import { CASE_STATUS_KEYS, PATTERN_SOURCES, SEVERITY_KEYS, VERDICT_KEYS } from '../schema';

export const INLINE_ROWS = 10;
const TECHNIQUE_RE = new RegExp(PATTERN_SOURCES.technique);

const has = (list: readonly string[], v: string) => list.includes(v.trim().toLowerCase());

function blank(cell: Cell): boolean {
  return cell === null || cell === '';
}

/** What a blank cell says to assistive tech: nothing is drawn (no em dash on screen). */
export function blankCellText(type: TableColumn['type']): string {
  return type === 'number' || type === 'risk' ? 'Not measured' : 'None';
}

/** "T1021, T1048 and 2 more": the ATT&CK ids, and the server's count of the rest. */
const MORE_RE = /^(.*\S)\s+and\s+(\d+)\s+more$/;

/**
 * A code or mitre cell that lists ATT&CK ids ("T1021, T1048, T1078", perhaps followed by
 * "and 2 more"), split into the ids and that tail; `null` when it is anything else.
 */
export function techniqueList(text: string): { ids: string[]; more: string | null } | null {
  const trimmed = text.trim();
  const tail = MORE_RE.exec(trimmed);
  const head = tail ? tail[1] : trimmed;
  const ids = head.split(/\s*,\s*/);
  if (ids.length < (tail ? 1 : 2) || !ids.every((id) => TECHNIQUE_RE.test(id))) return null;
  return { ids, more: tail ? `and ${tail[2]} more` : null };
}

/** One chip per technique, wrapping whole; the separators are text for assistive tech. */
function TechniqueChips({ ids, more }: { ids: string[]; more: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-technique-chips="">
      {ids.map((id, i) => (
        <React.Fragment key={`${id}-${i}`}>
          <InlineCode className="whitespace-nowrap text-xs">{id}</InlineCode>
          {i < ids.length - 1 ? <span className="sr-only">, </span> : null}
        </React.Fragment>
      ))}
      {more ? <span className="whitespace-nowrap text-xs text-muted-foreground">{more}</span> : null}
    </span>
  );
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

/**
 * A case-list row's case in the table (the list view's `CaseRefText` without the title,
 * which has its own column): the number, the internal id in its tooltip; without a
 * number, the id middle-ellipsised on screen and whole for assistive tech and in print.
 */
function TableCaseRef({ facts, staticMode }: { facts: CaseLinkFacts; staticMode: boolean }) {
  const number = facts.case_number?.trim() || null;
  const short = shortCaseId(facts.case_id);
  const label = number ? (
    <span className="whitespace-nowrap" title={facts.case_id} data-case-ref="number">
      {number}
    </span>
  ) : staticMode || short === facts.case_id ? (
    <span className="break-all" data-case-ref="id">
      {staticMode ? facts.case_id : keepShortTokens(facts.case_id, { all: true, breakLong: false })}
    </span>
  ) : (
    <span className="whitespace-nowrap" title={facts.case_id} data-case-ref="id">
      <span aria-hidden>{short}</span>
      <span className="sr-only">{facts.case_id}</span>
    </span>
  );
  if (staticMode) return <span className="font-mono text-xs">{label}</span>;
  return (
    <CaseLink facts={facts} className="font-mono text-xs">
      {label}
    </CaseLink>
  );
}

export function TypedCell({
  value,
  column,
  untrusted,
  staticMode = false,
  caseRef,
}: {
  value: Cell;
  column: TableColumn;
  untrusted: boolean;
  /** Print / static export: no link, no clamp, no forced single line. */
  staticMode?: boolean;
  /** The row's case when the table shows a case list (a `case` column only). */
  caseRef?: CaseLinkFacts;
}) {
  if (column.type === 'case' && caseRef) return <TableCaseRef facts={caseRef} staticMode={staticMode} />;
  if (blank(value)) return <span className="sr-only">{blankCellText(column.type)}</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') {
    if (column.type === 'risk') return <RiskBadge score={value} />;
    return <span className="tabular-nums">{formatValue(value, column.unit ?? 'count')}</span>;
  }
  const text = value as string;
  // Short references stay whole on screen (a long value keeps the cell's own wrapping);
  // print wraps every cell anywhere instead.
  const kept = (all: boolean) => (staticMode ? text : keepShortTokens(text, { all, breakLong: false }));
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
      if (isSafeCaseId(text) && !staticMode) return <CaseLink facts={{ case_id: text }} className="font-mono text-xs" />;
      return <span className="break-all font-mono text-xs">{kept(true)}</span>;
    case 'entity':
      return <InlineCode className="text-xs">{kept(true)}</InlineCode>;
    case 'code':
    case 'mitre': {
      const list = techniqueList(text);
      if (list) return <TechniqueChips {...list} />;
      if (column.type === 'code' || TECHNIQUE_RE.test(text)) return <InlineCode className="text-xs">{kept(true)}</InlineCode>;
      return <span className="font-mono text-xs">{kept(true)}</span>;
    }
    case 'time':
      return <span className={cn('tabular-nums', !staticMode && 'whitespace-nowrap')}>{formatUtc(text)}</span>;
    default:
      break;
  }
  return (
    <span
      className={cn(
        staticMode ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'line-clamp-3 break-words',
        untrusted ? 'font-mono text-xs' : 'proportional-nums',
      )}
      title={!staticMode && text.length > 80 ? text : undefined}
    >
      {kept(false)}
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
  /**
   * A case list shown as a table: each row's case, by row index. Its Case column then
   * names the case by number and links by the internal id ({@link TypedCell}).
   */
  caseRefs?: readonly CaseLinkFacts[];
}

export function TableView({ block, title, paged: pagedProp = false, staticMode = false, caseRefs }: TableViewProps) {
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
  // A table wider than its frame scrolls inside it, faded on the side with more (PW4-2).
  const rootRef = React.useRef<HTMLDivElement>(null);
  useTableScrollEdges(rootRef, !staticMode, block);

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
      // A printed table has no sort control: its headers are plain text.
      sortable: !staticMode,
      align: col.align ?? (numeric ? 'right' : 'left'),
      className: 'align-top text-sm',
      cell: (row: number) => (
        <TypedCell
          value={block.rows[row][i] ?? null}
          column={col}
          untrusted={columnUntrusted(col, block)}
          staticMode={staticMode}
          caseRef={caseRefs?.[row]}
        />
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
    <div ref={rootRef} className={cn('min-w-0', !staticMode && TABLE_SCROLL_FADE)} data-testid="block-table" data-static={staticMode || undefined}>
      {hasCase && !staticMode ? <CaseHoverArm>{table}</CaseHoverArm> : table}
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
            <TableView block={block} title={title} paged caseRefs={caseRefs} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
