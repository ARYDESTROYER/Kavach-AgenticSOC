/**
 * ListRow and ListRows: a list of records on a panel (Round 14, SPEC §4.9.2; ui-standard
 * "Tables, filters and lists").
 *
 * The row anatomy for a record list (enrichment providers, runbooks, sessions, system
 * workers): a title, one muted line under it, an optional leading mark, and on the right
 * a status shown only for exceptions (`StatusDot`), an optional control (an on/off
 * switch), one trailing action and the rest of the actions in a row menu (`RowActions`).
 * Rows are divided by hairlines, never boxed: a list of bordered cards is not a list.
 *
 * Opening a record: give the row `href` (a link) or `onOpen` (a button that opens the
 * detail sheet). The title becomes that one control, and its hit area stretches over the
 * whole row, so a click anywhere on the row opens it while keyboard users meet one tab
 * stop with the record's name. The trailing control and actions sit above the stretched
 * area and stay separately reachable (no interactive element is nested in another). A
 * plain click on an `href` title goes through the router, so a page's unsaved-changes
 * guard is asked first; only a safe href becomes a link (`@/soc/route-link`), anything
 * else leaves the title as plain text.
 *
 * `ListRows` is the list (`ul`, hairlines between rows); place it on a
 * `Panel padding="none"` and the rows bleed to the panel edge with their text on the
 * panel inset. Plain function components with no module-level calls, so the
 * `@/design-system` index that the entry imports stays tree-shakeable (SPEC §3.4). All
 * text is plain (#9).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';

export interface ListRowsProps extends React.HTMLAttributes<HTMLUListElement> {
  /** Accessible name of the list (or name it by a heading with `aria-labelledby`). */
  'aria-label'?: string;
  children?: React.ReactNode;
}

/** The list of rows: a `ul` with hairlines between rows and none around them. */
export function ListRows({ className, children, ...rest }: ListRowsProps) {
  return (
    // `role="list"` restores list semantics that Safari drops from a `list-style: none` list.
    // eslint-disable-next-line jsx-a11y/no-redundant-roles
    <ul role="list" className={cn('divide-y divide-border/70', className)} data-list-rows="" {...rest}>
      {children}
    </ul>
  );
}

export interface ListRowProps extends Omit<React.LiHTMLAttributes<HTMLLIElement>, 'title'> {
  /** The record's name (14px medium). Plain text or a short node. */
  title: React.ReactNode;
  /** One muted 13px line under the title; it truncates rather than wrapping. */
  description?: React.ReactNode;
  /** A leading mark (a `SourceMark`, an avatar), decorative beside the title. */
  leading?: React.ReactNode;
  /** A status shown only for exceptions (a `StatusDot`); the healthy default shows nothing. */
  status?: React.ReactNode;
  /** Muted trailing text (a count, "5 of 5 enabled"). */
  meta?: React.ReactNode;
  /** A control on the row (an on/off `Switch`); give it a name that includes the title ("Okta enabled"). */
  control?: React.ReactNode;
  /** The row's actions (a `RowActions`, or one button). */
  actions?: React.ReactNode;
  /**
   * Open the record by navigating (the title is a link): a hash route, a same-origin path
   * or an http(s) URL. Any other value leaves the title as plain text (#9).
   */
  href?: string;
  /** Open the record in place, e.g. its detail sheet (the title is a button). */
  onOpen?: () => void;
  /** The open control's accessible name when the title alone is not enough ("Open Okta settings"). */
  openLabel?: string;
  /** The row is the current or selected record. */
  selected?: boolean;
}

export function ListRow({
  title,
  description,
  leading,
  status,
  meta,
  control,
  actions,
  href,
  onOpen,
  openLabel,
  selected = false,
  className,
  ...rest
}: ListRowProps) {
  const safeHref = safeRouteHref(href);
  const onLinkClick = useRouteLinkClick(safeHref);
  const openable = Boolean(safeHref || onOpen);
  // The stretched hit area: an `::after` over the whole row (the row is `relative`), so
  // the row is clickable while the title stays the one focusable open control. Its focus
  // ring draws round the whole row, inset so the panel's clip never cuts it.
  const stretched = cn(
    'text-left outline-none after:absolute after:inset-0',
    'focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring',
  );
  const titleText = (
    <span className="block min-w-0 truncate text-base font-medium text-foreground">{title}</span>
  );
  const titleNode = safeHref ? (
    <a
      href={safeHref}
      onClick={onLinkClick}
      aria-label={openLabel}
      aria-current={selected ? 'true' : undefined}
      className={stretched}
    >
      {titleText}
    </a>
  ) : onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      aria-current={selected ? 'true' : undefined}
      className={cn('min-w-0 max-w-full', stretched)}
    >
      {titleText}
    </button>
  ) : (
    titleText
  );

  return (
    <li
      className={cn(
        'relative flex min-w-0 items-center gap-3 px-4 py-3 xl:px-5 3xl:px-6',
        openable && 'transition-colors hover:bg-hover',
        selected && 'bg-accent',
        className,
      )}
      data-list-row=""
      {...rest}
    >
      {leading ? (
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {leading}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {titleNode}
        {description ? (
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
        ) : null}
        {status || meta ? (
          // On a phone the status and meta move under the description (one copy is
          // displayed at a time, so assistive technology meets it once).
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden">
            {status}
            {meta ? <span className="text-sm tabular-nums text-muted-foreground">{meta}</span> : null}
          </div>
        ) : null}
      </div>
      {status || meta ? (
        <div className="hidden shrink-0 items-center gap-3 sm:flex">
          {status}
          {meta ? <span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">{meta}</span> : null}
        </div>
      ) : null}
      {control || actions ? (
        // Above the stretched open area, so these stay separately clickable.
        <div className="relative z-[1] flex shrink-0 items-center gap-2">
          {control}
          {actions}
        </div>
      ) : null}
    </li>
  );
}
