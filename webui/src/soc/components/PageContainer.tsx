/**
 * PageContainer — the ONE width authority for routed page bodies (DESIGN_STANDARD
 * §4.1, §4.5). The AppShell no longer hard-caps content at 1400px; instead each
 * page opts into a width by wrapping its body in this component with a `variant`
 * chosen per archetype:
 *
 *   - `fixed`  — focused single-column (forms/settings body). DEFAULT, so pages
 *                that have not yet opted in look exactly as before (~1200px cap).
 *   - `wide`   — operational surfaces (Cases, Overview, Metrics, Standup,
 *                Campaigns, Baseline, Batch, Logs): widen by COLUMN COUNT on
 *                ultrawide, not by stretching rows.
 *   - `fluid`  — full-bleed grids / the custom-dashboard canvas (still gutter-
 *                framed, never edge-to-edge tables).
 *   - `prose`  — narrative (CaseDetail "Why"/rationale, chat threads, long-form
 *                settings) capped at a readable ~72ch measure.
 *
 * PageContainer owns ONLY width + centering (`@container mx-auto w-full min-w-0` +
 * the per-variant `max-w`). The page GUTTER and vertical rhythm (`px-4 sm:px-6 py-6`
 * — flat from 640px up since the Round-12 width reclaim, which reversed the widening
 * ladder that made content NARROW as the viewport grew) are applied EXACTLY ONCE by
 * the AppShell content wrapper
 * for every routed page — PageContainer must NOT re-declare them or the ~26 pages
 * that have not (yet) adopted PageContainer would either double-pad (if kept here)
 * or lose their gutter entirely. Keeping the gutter on the shell keeps a single
 * consistent inset across BOTH page groups while PageContainer still caps + centers
 * the content column per archetype (this is the pragmatic reading of DESIGN_STANDARD
 * §4.1 given the migration is partial). It also establishes a container-query context
 * (`@container`) so wrapped widgets can reflow by their SLOT width rather than the
 * viewport (via `@tailwindcss/container-queries`, shipped by W0-A's tailwind.config).
 *
 * `min-w-0` is set so flex/grid children inside can shrink and truncate correctly.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export type ContainerVariant = 'fixed' | 'wide' | 'fluid' | 'prose';

/** The max-width per archetype (DESIGN_STANDARD §4.1). */
const WIDTHS: Record<ContainerVariant, string> = {
  fixed: 'max-w-[1200px]',
  wide: 'max-w-[1760px] 2xl:max-w-[1920px]',
  fluid: 'max-w-none',
  prose: 'max-w-[75ch]',
};

export interface PageContainerProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Width archetype for the page body. Default `fixed` (nothing changes until a page opts in). */
  variant?: ContainerVariant;
  /**
   * Render into a different element (e.g. `'main'`, `'section'`). Defaults to a
   * plain `div`. Kept intentionally minimal (no `asChild`) — this is a layout box.
   */
  as?: React.ElementType;
  children: React.ReactNode;
}

/**
 * The one width authority. Centers + gutters the page body per archetype and opens
 * a container-query context for its children.
 */
export function PageContainer({
  variant = 'fixed',
  as: Comp = 'div',
  className,
  children,
  ...rest
}: PageContainerProps) {
  return (
    <Comp
      className={cn(
        // Width + centering + container-query ONLY — the gutter/vertical rhythm is
        // owned once by the AppShell content wrapper (see the module docstring).
        '@container mx-auto w-full min-w-0',
        WIDTHS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export default PageContainer;
