/**
 * MetricHoverTrend — the ONE hover/focus trendline affordance for a dashboard metric.
 *
 * Wraps any metric presentation (a KPI tile, a timing stat, a snapshot total) in a
 * Radix HoverCard whose content is the metric's honest recent trend: the metric name,
 * a compact axis-less sparkline, the measured window disclosure ("last 24 hours ·
 * 1h buckets"), and the first/latest measured values as plain text. Composes the
 * existing `ui/hover-card` primitives + the LAZY `Sparkline` from `charts.tsx`
 * (recharts stays off the static import graph exactly like `KpiTile`'s spark).
 *
 * Honesty rules:
 *   - `points` preserve nulls as NOT-MEASURED buckets. They are never drawn as zeros;
 *     the sparkline renders measured points only and, when some buckets are missing,
 *     the card discloses "N of M buckets measured".
 *   - Fewer than two measured points → the trend content is OMITTED and a quiet
 *     "No trend data yet." line renders instead (never a decorative invented trend).
 *   - Every value is a formatted number / fixed label rendered as plain text (#9).
 *
 * Accessibility (WCAG 1.4.13): the trigger participates in the tab order (either the
 * child is itself focusable — pass `focusable={false}` — or the wrapper takes
 * `tabIndex=0`, mirroring `CaseHoverCard`), Radix opens the card on focus as well as
 * hover, the content itself is hoverable, and the sparkline carries a text summary
 * via its `role="img"` label. Colors come from the token palette only.
 */
import * as React from 'react';

import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/ui/hover-card';
import { cn } from '@/lib/cn';

/** Lazy sparkline — keeps recharts out of this component's static import graph. */
const LazySparkline = React.lazy(() =>
  import('./charts').then((m) => ({ default: m.Sparkline })),
);

/** One honest trend point: a bucket label plus its measured value (null = not measured). */
export interface MetricTrendPoint {
  /** Bucket identity (plain text, e.g. the ISO bucket start). */
  label: string;
  /** Measured value, or null when the bucket has no measurable evidence. */
  value: number | null;
}

/** The series contract a metric hands to its hover-trend affordance. */
export interface MetricTrendSeries {
  /** Plain-text name of what the LINE measures (may differ from the tile label
   *  when only a related honest series exists, e.g. arrivals under "Open Cases"). */
  metric: string;
  /** The honest series; `undefined` renders the quiet no-data state. */
  points: MetricTrendPoint[] | undefined;
  /** Window/bucket disclosure (e.g. "last 24 hours · 1h buckets"). */
  windowLabel: string;
  /** Optional cohort/semantics disclosure (e.g. "by case-arrival bucket"). */
  caption?: string;
  /** Value formatter for the first/latest readouts. */
  format?: (n: number) => string;
  /** Palette token name for the sparkline stroke (default 'primary'). */
  colorToken?: string;
}

export interface MetricHoverTrendProps extends MetricTrendSeries {
  /**
   * Put the WRAPPER in the tab order (default true). Pass `false` when the child
   * already contains a focusable element (e.g. a clickable KpiTile button) so the
   * card stays focus-reachable without adding a second tab stop.
   */
  focusable?: boolean;
  side?: React.ComponentPropsWithoutRef<typeof HoverCardContent>['side'];
  align?: React.ComponentPropsWithoutRef<typeof HoverCardContent>['align'];
  openDelay?: number;
  closeDelay?: number;
  /** Classes for the trigger wrapper (layout only). */
  className?: string;
  children: React.ReactNode;
}

const defaultFormat = (n: number): string => String(n);

export function MetricHoverTrend({
  metric,
  points,
  windowLabel,
  caption,
  format,
  colorToken = 'primary',
  focusable = true,
  side,
  align = 'center',
  openDelay = 160,
  closeDelay = 120,
  className,
  children,
}: MetricHoverTrendProps) {
  const fmt = format ?? defaultFormat;
  const all = points ?? [];
  const measured = all.filter(
    (p): p is { label: string; value: number } =>
      typeof p.value === 'number' && Number.isFinite(p.value),
  );
  const hasTrend = measured.length >= 2;
  const first = measured[0]?.value;
  const latest = measured[measured.length - 1]?.value;

  return (
    <HoverCard openDelay={openDelay} closeDelay={closeDelay}>
      <HoverCardTrigger asChild>
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the Radix HoverCard
            trigger must be focus-reachable so the trend card opens for keyboard users
            (WCAG 1.4.13); mirrors CaseHoverCard's tabIndex=0 clone contract.
            `focusable={false}` removes the stop when the child is itself focusable. */}
        <div
          data-testid="metric-trend-trigger"
          tabIndex={focusable ? 0 : undefined}
          className={cn(
            'h-full min-w-0',
            // A quiet "there is more here" affordance on the non-clickable triggers;
            // clickable children keep their own pointer + focus treatment.
            focusable &&
              'cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          {children}
        </div>
        {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
      </HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        data-testid="metric-trend-card"
        className="w-72 p-3"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-2xs font-semibold uppercase tracking-widest text-foreground">
            {metric}
          </span>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
            {windowLabel}
          </span>
        </div>
        {caption ? <p className="mt-0.5 text-2xs text-muted-foreground">{caption}</p> : null}
        {hasTrend ? (
          <>
            <div className="mt-2 h-12">
              <React.Suspense fallback={<div className="h-12" aria-hidden />}>
                <LazySparkline
                  data={measured.map((p) => p.value)}
                  height={48}
                  colorToken={colorToken}
                  ariaLabel={`${metric} trend: first ${fmt(first!)}, latest ${fmt(latest!)}`}
                />
              </React.Suspense>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 font-mono text-2xs tabular-nums text-muted-foreground">
              <span>first {fmt(first!)}</span>
              <span className="text-foreground">latest {fmt(latest!)}</span>
            </div>
            {measured.length < all.length ? (
              <p className="mt-1 text-2xs text-muted-foreground">
                {measured.length} of {all.length} buckets measured.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No trend data yet.</p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

export default MetricHoverTrend;
