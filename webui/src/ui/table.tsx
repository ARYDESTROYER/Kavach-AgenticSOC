import * as React from 'react';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';

/**
 * `density` on TableHead/TableCell (DESIGN_STANDARD §5.2 / §7): `normal` is the
 * pre-Round-5 look (`h-11 px-4` head / `px-4 py-3` cell); `compact` tightens the
 * vertical rhythm while keeping ≥16px horizontal padding (below that columns
 * visually merge). Default is `normal`, so existing tables are byte-identical.
 *
 * `Table` gains a no-double-wrap escape hatch: it normally wraps the `<table>` in
 * an `overflow-auto` div; pass `unwrapped` (or `containerClassName={undefined}` +
 * `unwrapped`) when the table already lives inside a scroll container so you don't
 * create a second, clipping scroll context (map §3.9). `containerClassName` lets
 * callers style the wrapper without a second nested div.
 *
 * `TableHeader` gains `sticky` — pins the header row so it parks UNDER the app bar
 * (`sticky top-[var(--header-h)] z-10` + an opaque surface bg so rows don't bleed
 * through). The offset matches the AppShell top bar height so the header never hides
 * behind it (WCAG 2.4.11); a plain `top-0` would tuck it behind the app bar.
 */
type Density = 'normal' | 'compact';

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Skip the built-in `overflow-auto` wrapper (already inside a scroll area). */
  unwrapped?: boolean;
  /** Class applied to the built-in wrapper div (ignored when `unwrapped`). */
  containerClassName?: string;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, unwrapped, containerClassName, ...props }, ref) => {
    const table = (
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
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
          // Non-sticky keeps the translucent wash (byte-identical). A pinned header is
          // floating chrome over scrolled rows, so it wears the ONE material
          // (`materialBar`: ≥0.80 fill + blur, solid under reduced transparency or
          // increased contrast) — and must NOT also carry `bg-surface/50`, which would
          // win the cascade over the material's fill and let rows bleed through.
          // Small text ON a material is secondary ink, never muted (ui-standard
          // "Materials"): the 11px column labels step up from `text-muted-foreground`.
          sticky
            ? cn('sticky top-[var(--header-h)] z-10 [&_th]:text-secondary-foreground', materialBar)
            : 'bg-surface/50',
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
        'px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wide ' +
          'text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
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
}

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, density = 'normal', ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-4 align-middle text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
        density === 'compact' ? 'py-2' : 'py-3',
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
