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
 * hover (focus events bubble, so a focusable CHILD reaching focus opens it too), the
 * content itself is hoverable, and the sparkline carries a text summary via its
 * `role="img"` label. Colors come from the token palette only.
 *
 * Touch access: hover cannot open the card on touch-only devices (Radix ignores
 * touch pointers and suppresses trigger focus), so `toggleOnClick` (default: the
 * `focusable` value) makes a press on the wrapper toggle the card. Wrappers whose
 * CHILD is itself clickable keep the default OFF so navigation presses never fight
 * the card; Escape and press-outside dismissal keep working via Radix. A press landing
 * on an interactive descendant is ALWAYS ignored, so a wrapper around a clickable child
 * has no touch path to the card at all — which is why the card's content is exported as
 * `MetricTrendBody` for the surface that press opens to restate.
 *
 * Coexisting with a docked panel: `forceClosed` holds the card shut and refuses every
 * open transition. A disclosure opened FROM the wrapped child needs it — the card opens
 * on focus (so the panel's focus return would otherwise pop it straight back), it renders
 * over the panel, and its dismissable layer would swallow the panel's Escape.
 *
 * That suppression deliberately OUTLASTS the transition. Radix opens on a timer: focus
 * arms a `setTimeout(openDelay)` and the resulting `onOpenChange(true)` lands whenever it
 * lands — by which time a prop read at callback time says `forceClosed` is already false.
 * A purely synchronous guard therefore let the focus return that ACCOMPANIES a dismissal
 * re-open the card ~`openDelay` later, so an explicit Escape was answered by a new overlay
 * and needed a second Escape. When `forceClosed` falls, opens stay refused for a further
 * `openDelay` grace period, which is exactly long enough to swallow the transition's own
 * in-flight timer without blocking a fresh, deliberate hover or press.
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

/**
 * The card BODY, exported so a second surface can state the very same trend without
 * re-deriving its honesty rules.
 *
 * The KPI drill-down panel renders this directly. That is not a nicety: every strip
 * tile is now a disclosure TRIGGER, and `MetricHoverTrend` receives
 * `focusable={false}` for a clickable child — which also defaults `toggleOnClick` off,
 * so a touch-only device can reach the hover card on no tile at all. Rather than
 * fighting the tile's own press (an interactive descendant is deliberately never a
 * card toggle), the panel the press opens carries the identical trend content, so the
 * series stays reachable by pointer, keyboard AND touch. One implementation, so the
 * two surfaces can never disagree about what is measured.
 */
export function MetricTrendBody({
  metric,
  points,
  windowLabel,
  caption,
  format,
  colorToken = 'primary',
}: MetricTrendSeries) {
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
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-2xs font-semibold uppercase tracking-widest text-foreground">
          {metric}
        </span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground">{windowLabel}</span>
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
    </>
  );
}

export interface MetricHoverTrendProps extends MetricTrendSeries {
  /**
   * Put the WRAPPER in the tab order (default true). Pass `false` when the child
   * already contains a focusable element (e.g. a clickable KpiTile button) so the
   * card stays focus-reachable without adding a second tab stop.
   */
  focusable?: boolean;
  /**
   * Toggle the card on a press (tap/click) of the wrapper — the only way to reach
   * it on touch-only devices, where hover never fires and Radix suppresses trigger
   * focus. Defaults to the `focusable` value: non-clickable wrapped stats become
   * tappable, while a wrapper around a clickable child (`focusable={false}`) stays
   * inert so navigation presses never fight the card. Pass `true` explicitly for a
   * `focusable={false}` wrapper whose child is NOT clickable (e.g. a tile whose
   * only focusable element is a HelpTip). Presses on interactive descendants
   * (buttons, links, inputs) are always ignored.
   */
  toggleOnClick?: boolean;
  /**
   * Hold the card CLOSED and refuse every open transition while true.
   *
   * A docked disclosure panel opened from the wrapped tile needs this: the card opens
   * on FOCUS as well as hover, so returning focus to the tile would pop it straight
   * back over the panel, and its Radix dismissable layer would swallow the Escape the
   * panel needs to close. Forcing it closed for the duration is the only way both
   * surfaces can coexist; the panel restates the same series (see `MetricTrendBody`)
   * so nothing is lost while it is suppressed.
   */
  forceClosed?: boolean;
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
  toggleOnClick,
  forceClosed = false,
  side,
  align = 'center',
  openDelay = 160,
  closeDelay = 120,
  className,
  children,
}: MetricHoverTrendProps) {
  // Controlled open so a press can toggle the card (touch has no hover); Radix
  // still drives every hover/focus/dismiss transition through onOpenChange, so
  // desktop pointer behavior and Escape/press-outside dismissal are unchanged.
  const toggle = toggleOnClick ?? focusable;
  const [open, setOpen] = React.useState(false);
  /**
   * Wall-clock instant until which an OPEN transition is refused, set when `forceClosed`
   * falls. See the "Coexisting with a docked panel" note above: Radix's open is deferred
   * by `openDelay`, so the timer armed by the dismissal's own focus return resolves after
   * the prop has already flipped back. A ref (not state) because refusing must not
   * re-render, and because the deferred callback reads it at call time.
   */
  const suppressOpenUntilRef = React.useRef(0);
  /** Previous `forceClosed`, so only the FALLING edge arms the grace period. */
  const wasForceClosedRef = React.useRef(forceClosed);
  // `forceClosed` wins over every source of truth, including a hover/focus that is
  // ALREADY in flight: the effect drops any latched open state the moment the panel
  // takes over, and the render below refuses to pass an open card to Radix even before
  // that effect runs.
  React.useEffect(() => {
    const wasForceClosed = wasForceClosedRef.current;
    wasForceClosedRef.current = forceClosed;
    if (forceClosed) {
      setOpen(false);
      return;
    }
    // Falling edge ONLY (never mount, where an immediate hover is legitimate): hold the
    // refusal for one more `openDelay` so a timer armed by the focus return that
    // accompanies the dismissal cannot resolve into a reopen.
    if (wasForceClosed) suppressOpenUntilRef.current = Date.now() + openDelay;
  }, [forceClosed, openDelay]);
  const effectiveOpen = forceClosed ? false : open;
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (forceClosed) return;
      // Only OPENS are held off; a close is always honoured.
      if (next && Date.now() < suppressOpenUntilRef.current) return;
      setOpen(next);
    },
    [forceClosed],
  );
  // Radix dismisses an open card on pointerdown OUTSIDE the portalled content —
  // and the trigger IS outside it — so by pointerup `open` may already read false
  // again. Record the pre-press state on pointerdown and commit the toggle on
  // pointerup, so a press on the trigger of an open card closes it instead of
  // instantly re-opening it.
  const pressWasOpenRef = React.useRef<boolean | null>(null);

  /** True when the press landed on an interactive descendant (never toggle those). */
  const onInteractiveDescendant = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    const el =
      e.target instanceof Element
        ? e.target.closest('button, a, input, select, textarea, [role="button"]')
        : null;
    return !!el && e.currentTarget.contains(el);
  };

  const handlePressStart = (e: React.PointerEvent<HTMLDivElement>) => {
    pressWasOpenRef.current = onInteractiveDescendant(e) ? null : open;
  };
  const handlePressEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (onInteractiveDescendant(e)) {
      pressWasOpenRef.current = null;
      return;
    }
    const wasOpen = pressWasOpenRef.current ?? open;
    pressWasOpenRef.current = null;
    handleOpenChange(!wasOpen);
  };

  return (
    <HoverCard
      open={effectiveOpen}
      onOpenChange={handleOpenChange}
      openDelay={openDelay}
      closeDelay={closeDelay}
    >
      <HoverCardTrigger asChild>
        {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the Radix HoverCard
            trigger must be focus-reachable so the trend card opens for keyboard users
            (WCAG 1.4.13); mirrors CaseHoverCard's tabIndex=0 clone contract.
            `focusable={false}` removes the stop when the child is itself focusable. */}
        <div
          data-testid="metric-trend-trigger"
          tabIndex={focusable ? 0 : undefined}
          onPointerDown={toggle ? handlePressStart : undefined}
          onPointerUp={toggle ? handlePressEnd : undefined}
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
        <MetricTrendBody
          metric={metric}
          points={points}
          windowLabel={windowLabel}
          caption={caption}
          format={format}
          colorToken={colorToken}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

export default MetricHoverTrend;
