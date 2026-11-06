import * as React from 'react';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';

/**
 * The table primitives (shadcn shape) and the console's one table grammar (Round 14,
 * SPEC §4.9.2, operator choice C7 option 1).
 *
 * - Headers are 12px medium, sentence case, muted (no tracked capitals, no wash): the
 *   Overview's column labels. A sticky header wears the one material and lifts its labels
 *   to secondary ink (ui-standard "Materials").
 * - `density` on `TableHead`/`TableCell`: `normal` (44px header, 12px cell padding) or
 *   `compact` (36px header, 8px cell padding, rows about 38px). Operational tables use
 *   `compact` (`DataTable` defaults to it); the horizontal padding stays 16px, below which
 *   columns visually merge.
 * - `Table layout="fixed"` sets `table-layout: fixed`, so declared column widths hold
 *   and a long cell truncates instead of widening its column (the Audit Build column
 *   defect, F5). `DataTable` turns it on whenever a column declares a width.
 * - `TableCell numeric` holds a count, score, time or id: tabular figures (so digits line
 *   up down the column) and no wrapping. Words stay proportional: never set tabular
 *   figures on a whole table or row (ui-standard "Typography").
 * - `Table` wraps the `<table>` in an `overflow-auto` div; pass `unwrapped` when the
 *   table already lives inside a scroll container, so there is no second, clipping
 *   scroll context. `containerClassName` styles the wrapper.
 * - `TableHeader sticky` pins the header row under the app bar
 *   (`top-[var(--header-h)]`, never a bare `top-0`, WCAG 2.4.11).
 */
type Density = 'normal' | 'compact';

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Skip the built-in `overflow-auto` wrapper (already inside a scroll area). */
  unwrapped?: boolean;
  /** Class applied to the built-in wrapper div (ignored when `unwrapped`). */
  containerClassName?: string;
  /** `fixed` keeps declared column widths (`table-layout: fixed`); `auto` (default) sizes to content. */
  layout?: 'auto' | 'fixed';
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, unwrapped, containerClassName, layout = 'auto', ...props }, ref) => {
    const table = (
      <table
        ref={ref}
        className={cn('w-full caption-bottom text-sm', layout === 'fixed' && 'table-fixed', className)}
        {...props}
      />
    );
    if (unwrapped) return table;
    return <div className={cn('relative w-full overflow-auto', containerClassName)}>{table}</div>;
  },
);
Table.displayName = 'Table';

export interface TableHeaderProps extends React.HTMLAttributes<HTMLTableSectionElement> {
  /** Pin the header to the top of the scroll container. */
  sticky?: boolean;
}

const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, sticky, ...props }, ref) => {
    // The scroll-edge fade under a pinned header, shown only while rows are scrolled
    // beneath it (the same observation every sticky material bar uses).
    const edgeRef = useScrollEdgeRef(ref, Boolean(sticky));
    return (
      <thead
        ref={edgeRef}
        className={cn(
          '[&_tr]:border-b [&_tr]:border-border',
          // Round 14 (C7): no header wash. The column labels sit on the surface the table
          // sits on (a panel or the canvas), like the Overview's tables; a tinted band
          // would read as a second surface inside the panel. A pinned header is floating
          // chrome over scrolled rows, so it wears the ONE material (`materialBar`: 0.97
          // fill + blur, solid under reduced transparency or increased contrast). Small
          // text ON a material is secondary ink, never muted (ui-standard "Materials").
          sticky && cn('sticky top-[var(--header-h)] z-10 [&_th]:text-secondary-foreground', materialBar),
          className,
        )}
        {...props}
      />
    );
  },
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      'border-t border-border bg-surface/60 font-medium text-foreground [&>tr]:last:border-b-0',
      className,
    )}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border/70 transition-colors last:border-0 hover:bg-muted/40 ' +
        'data-[state=selected]:bg-accent/60',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

export interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  density?: Density;
}

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, density = 'normal', ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        // 12px medium, sentence case, muted: the Overview's column labels (Round 14, C7).
        'px-4 text-left align-middle text-xs font-medium text-muted-foreground ' +
          '[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        density === 'compact' ? 'h-9' : 'h-11',
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = 'TableHead';

export interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  density?: Density;
  /**
   * The cell holds a count, score, time or id: tabular figures and no wrapping, so the
   * column's digits line up and an id or a time never breaks across lines.
   */
  numeric?: boolean;
}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, density = 'normal', numeric = false, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-4 align-middle text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        density === 'compact' ? 'py-2' : 'py-3',
        numeric && 'whitespace-nowrap tabular-nums',
        className,
      )}
      {...props}
    />
  ),
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-4 text-sm text-muted-foreground', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
