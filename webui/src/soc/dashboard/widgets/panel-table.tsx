/**
 * A compact table inside a widget panel (Round 14, SPEC §4.9.1): it bleeds to the panel's
 * edges, so its first column lines up with the panel title, and it has no frame of its
 * own (the panel is the frame; no nested cards). Where the PANEL is too narrow for the
 * table's columns (a phone, a half-width panel on a laptop, a narrow cell a person placed
 * on their board) the widget shows the same rows as a two-line list instead
 * (`PanelList`), so a table never squeezes its first column to nothing or scrolls
 * sideways. The switch is a container query on the widget body (`@container/widget`, set
 * by `WidgetShell`), sized from the table's own columns ({@link panelFit}).
 *
 * Every cell value is plain text (#9).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { fmtNumber } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { pageHash } from '@/soc/router';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';

export interface PanelColumn {
  label: string;
  /** A CSS width for the column (`table-layout: fixed`). */
  width?: string;
  align?: 'right';
  /** Visually hidden header (a column whose cells name themselves). */
  srOnly?: boolean;
}

/**
 * The widths at which a table replaces its two-line list, measured on the widget body.
 * Literal class names (the build only keeps classes it can read in the source).
 */
const FITS = [
  { rem: 28, table: 'hidden @[28rem]/widget:block', list: '@[28rem]/widget:hidden' },
  { rem: 32, table: 'hidden @[32rem]/widget:block', list: '@[32rem]/widget:hidden' },
  { rem: 36, table: 'hidden @[36rem]/widget:block', list: '@[36rem]/widget:hidden' },
  { rem: 40, table: 'hidden @[40rem]/widget:block', list: '@[40rem]/widget:hidden' },
  { rem: 44, table: 'hidden @[44rem]/widget:block', list: '@[44rem]/widget:hidden' },
] as const;

export type PanelFit = (typeof FITS)[number]['rem'];

/** The room a column without a fixed width needs (a rule name, a case title). */
const FLEX_COLUMN_REM = 10;

/**
 * The narrowest widget body (in rem) that holds a table's columns: its fixed widths plus
 * room for each flexible column, rounded up to the next step of {@link FITS}.
 */
export function panelFit(columns: readonly PanelColumn[]): PanelFit {
  const need = columns.reduce((sum, c) => {
    const rem = c.width && /^\d+(\.\d+)?rem$/.test(c.width) ? Number.parseFloat(c.width) : FLEX_COLUMN_REM;
    return sum + rem;
  }, 0);
  return (FITS.find((f) => f.rem >= need) ?? FITS[FITS.length - 1]).rem;
}

function fitClasses(fit: PanelFit) {
  return FITS.find((f) => f.rem === fit) ?? FITS[0];
}

const BLEED = '-mx-4 xl:-mx-5 3xl:-mx-6';
const FIRST = 'pl-4 xl:pl-5 3xl:pl-6';
const LAST = 'pr-4 xl:pr-5 3xl:pr-6';

export function PanelTable({
  label,
  columns,
  children,
  className,
}: {
  label: string;
  columns: readonly PanelColumn[];
  children: React.ReactNode;
  className?: string;
}) {
  const fit = panelFit(columns);
  return (
    <div className={cn(BLEED, 'min-w-0 overflow-x-auto', fitClasses(fit).table, className)} data-panel-table="" data-panel-fit={fit}>
      <Table aria-label={label} layout="fixed" unwrapped className="min-w-[28rem]">
        <colgroup>
          {columns.map((c, i) => (
            <col key={`${c.label}-${i}`} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((c, i) => (
              <TableHead
                key={`${c.label}-${i}`}
                density="compact"
                className={cn(
                  'px-2',
                  i === 0 && FIRST,
                  i === columns.length - 1 && LAST,
                  c.align === 'right' && 'text-right',
                )}
              >
                {c.srOnly ? <span className="sr-only">{c.label}</span> : c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** One row of a {@link PanelTable}; cells get the panel inset on the outer columns. */
export function PanelRow({ cells }: { cells: Array<{ content: React.ReactNode; align?: 'right'; numeric?: boolean; className?: string }> }) {
  return (
    <TableRow>
      {cells.map((cell, i) => (
        <TableCell
          key={i}
          density="compact"
          numeric={cell.numeric}
          className={cn(
            'min-w-0 px-2',
            i === 0 && FIRST,
            i === cells.length - 1 && LAST,
            cell.align === 'right' && 'text-right',
            cell.className,
          )}
        >
          {cell.content}
        </TableCell>
      ))}
    </TableRow>
  );
}

/**
 * The same rows as a list of two-line rows, shown where the panel is narrower than its
 * table's columns need: pass the same columns' {@link panelFit}.
 */
export function PanelList({ label, fit = 28, children }: { label: string; fit?: PanelFit; children: React.ReactNode }) {
  return (
    <ul className={cn('-my-1 divide-y divide-border/60', fitClasses(fit).list)} aria-label={label} data-panel-list="" data-panel-fit={fit}>
      {children}
    </ul>
  );
}

/** One two-line phone row: a primary line with an optional trailing value, then a muted line. */
export function PanelListItem({
  primary,
  trailing,
  secondary,
}: {
  primary: React.ReactNode;
  trailing?: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 py-2.5">
      {/* Centred, so a trailing figure lines up with a primary link that is 44 px tall on
          a phone (its text sits in the middle of that box). */}
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 break-words text-sm text-foreground">{primary}</span>
        {trailing != null ? <span className="shrink-0 text-sm tabular-nums text-foreground">{trailing}</span> : null}
      </span>
      {secondary != null ? <span className="min-w-0 break-words text-xs text-muted-foreground">{secondary}</span> : null}
    </li>
  );
}

/** A ranked row with an inline bar (the Overview's list grammar). */
export function BarRow({
  label,
  value,
  max,
  right,
  barClass = 'bg-accent-bar',
  sub,
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  right?: React.ReactNode;
  barClass?: string;
  sub?: React.ReactNode;
}) {
  const pct = max > 0 && value > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm text-foreground">{label}</span>
        <span className="flex shrink-0 items-baseline gap-2 text-sm tabular-nums">{right}</span>
      </div>
      {/* Forced colours repaint backgrounds as Canvas, so the track gets a CanvasText
          outline and the fill becomes CanvasText: the bar keeps its shape and length
          (the chart kit's MARK_FORCED rule). */}
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted forced-colors:outline forced-colors:outline-1 forced-colors:outline-[CanvasText]"
        aria-hidden
        data-bar-track=""
      >
        <div
          className={cn('h-full rounded-full forced-colors:bg-[CanvasText] forced-colors:[forced-color-adjust:none]', barClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </li>
  );
}

/** One row of {@link RankedBars}: a plain-text label (#9), its count, an optional tone and note. */
export interface RankedBarItem {
  label: string;
  value: number;
  /** A token fill class (`bg-critical`); the shared accent bar when absent. */
  color?: string;
  /** A muted note under the bar (plain text). */
  sub?: string;
}

/**
 * Ranked bars on a panel, each row a {@link BarRow}: so every bar list on a board keeps
 * its outline and its length under forced colours, where a background fill alone would
 * vanish. Bars are sized against the largest row.
 */
export function RankedBars({
  label,
  items,
  format = fmtNumber,
}: {
  label: string;
  items: readonly RankedBarItem[];
  format?: (value: number) => string;
}) {
  const max = items.reduce((m, it) => Math.max(m, Number.isFinite(it.value) ? it.value : 0), 0);
  return (
    <ul className="flex flex-col gap-3.5" aria-label={label} data-ranked-bars="">
      {items.map((it, i) => (
        <BarRow
          key={`${it.label}-${i}`}
          label={it.label}
          value={it.value}
          max={max}
          barClass={it.color}
          right={<span className="font-semibold text-foreground">{format(it.value)}</span>}
          sub={it.sub}
        />
      ))}
    </ul>
  );
}

/**
 * A count, with the strip's bound mark when it is a lower bound: a visible `≥` (the
 * Console's one floor mark) and "at least" for assistive technology, so a partial count
 * never reads as exact.
 */
export function BoundCount({ value, bound, className }: { value: number; bound: boolean; className?: string }) {
  return (
    <span className={className} data-bound={bound ? 'floor' : undefined}>
      {bound ? (
        <>
          <span aria-hidden>≥</span>
          <span className="sr-only">at least </span>
        </>
      ) : null}
      {fmtNumber(value)}
    </span>
  );
}

/**
 * The phone target for a row's primary action (SPEC §3.3: 44 px on phones): the link's
 * own box grows to 44 px tall below 640 px, so the hit box is the visible control.
 */
export const PHONE_ROW_TARGET = 'max-sm:inline-flex max-sm:min-h-11 max-sm:items-center';

/**
 * A case number that opens the case in Case Manager (a link, SPEC §3.3). It is the row's
 * primary action wherever it appears, so it is 24 px tall on a desktop and 44 px on a
 * phone.
 */
export function CaseNumberLink({ caseId, label }: { caseId: string; label: string }) {
  const href = safeRouteHref(pageHash('case_manager', { caseId }));
  const onClick = useRouteLinkClick(href);
  if (!href) return <span className="font-mono text-xs">{label}</span>;
  return (
    <a
      href={href}
      onClick={onClick}
      // `min-h-6`: a 24 px pointer target (SPEC §3.3), centred on the line; 44 px on a phone.
      className={cn(
        'inline-flex min-h-6 items-center whitespace-nowrap rounded-sm font-mono text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        PHONE_ROW_TARGET,
      )}
      data-case-link=""
    >
      {label}
    </a>
  );
}
