/**
 * FilterBar — the operational control-bar container (DESIGN_STANDARD §4.3 / §5.2).
 * A single horizontal band that hosts the shared dashboard controls
 * ([Time range ▾] [⟳ refresh ▾] [Source ▾][Severity ▾][Owner ▾] · last refresh) and
 * wraps gracefully on narrow / half-panel widths.
 *
 * This is a LAYOUT primitive, not a filter engine — it arranges whatever controls
 * you pass (SegmentedControl / Select / saved-view menu / density toggle). The
 * shared filter STATE (TimeRange + variables context, URL serialization,
 * UserPrefs persistence) lives in the pages/context that own it (W0-F / Dashboard
 * waves); FilterBar just gives them a consistent shell.
 *
 * Slots:
 *  - `children` — the primary filter controls (left, wraps).
 *  - `end` — right-aligned controls (density toggle, saved views, refresh state).
 *  - `meta` — a muted trailing note (e.g. "last refresh 14:32", "128 results").
 *
 * a11y: rendered as a labelled toolbar (`role="toolbar"`, `aria-label`). Controls
 * keep their own labels. Sticky mode pins under the PageHeader (`--header-h`) and
 * uses a subtle bottom border, never a heavy shadow (border-first, §3.3).
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { materialBar } from '@/lib/ui-recipes';
import { useScrollEdgeRef } from '@/design-system/material';

export interface FilterBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the toolbar (e.g. "Dashboard filters"). */
  'aria-label'?: string;
  /** Right-aligned controls (density, saved views, refresh). */
  end?: React.ReactNode;
  /** Muted trailing note (last refresh, result count). */
  meta?: React.ReactNode;
  /** Pin the bar under the page header on scroll. */
  sticky?: boolean;
  /** The primary filter controls. */
  children?: React.ReactNode;
}

export const FilterBar = React.forwardRef<HTMLDivElement, FilterBarProps>(
  ({ end, meta, sticky, className, children, ...rest }, ref) => {
    // Sticky = floating chrome: the ONE Console material. Its hard rules give way to the
    // scroll-edge fade, shown only while content is scrolled under the pinned bar; a
    // real bottom rule returns under increased contrast (the material's own fallback).
    const edgeRef = useScrollEdgeRef(ref, Boolean(sticky));
    return (
      <div
        ref={edgeRef}
        role="toolbar"
        aria-label={rest['aria-label'] ?? 'Filters'}
        className={cn(
          '@container flex flex-wrap items-center gap-2 border-y border-border/80 bg-transparent py-2',
          sticky && cn('sticky top-[var(--header-h)] z-20 border-y-0', materialBar),
          className,
        )}
        {...rest}
      >
        {/* Primary controls — left cluster, wraps. */}
        <div className="flex flex-wrap items-center gap-2">{children}</div>

        {/* Spacer + right cluster. */}
        {(end || meta) && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {meta ? <span className="text-xs tabular-nums text-muted-foreground">{meta}</span> : null}
            {end}
          </div>
        )}
      </div>
    );
  },
);
FilterBar.displayName = 'FilterBar';

/**
 * FilterBarGroup — an optional labelled cluster inside the bar (e.g. group the
 * three variable dropdowns). The label is a small muted caption for scanability;
 * it is `aria-hidden` since each control already carries its own name.
 */
export function FilterBarGroup({
  label,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { label?: React.ReactNode }) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} {...rest}>
      {label ? (
        <span className="text-2xs font-medium uppercase tracking-[0.04em] text-muted-foreground" aria-hidden="true">
          {label}
        </span>
      ) : null}
      {children}
    </div>
  );
}
FilterBarGroup.displayName = 'FilterBarGroup';
