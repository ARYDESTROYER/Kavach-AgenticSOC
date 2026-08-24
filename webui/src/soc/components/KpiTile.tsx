import * as React from 'react';
import { cn } from '@/lib/cn';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { CountUp } from './CountUp';
import { HelpTip } from './HelpTip';

/**
 * Round-7 W0.1 — the optional sparkline is LAZY. `<Sparkline>` lives in `charts.tsx`
 * which imports recharts (~422 kB); statically importing it here would risk dragging
 * recharts toward the first-paint graph. A `React.lazy` dynamic import keeps recharts
 * out of KpiTile's static import graph entirely — it only loads when a tile is actually
 * given a `spark` series (no consumers this round; forward-looking). Decorative +
 * aria-hidden, so a `null` Suspense fallback is correct.
 */
const LazySparkline = React.lazy(() =>
  import('./charts').then((m) => ({ default: m.Sparkline })),
);

/**
 * Round-9 motion — the KPI numeral rolls via the motion.dev spring `AnimatedNumber`
 * (which had been dead code: nothing imported it). AnimatedNumber pulls in the motion.dev
 * runtime, so — exactly like `LazySparkline` above — it is `React.lazy`-loaded to keep
 * motion.dev OFF KpiTile's static import graph and therefore off the eager first-paint
 * chunk (bundle-first-paint.test.ts). Until the lazy chunk resolves, the Suspense
 * fallback is the CSS-rAF `<CountUp>`: a fully-working count-up that shows the correct
 * number immediately and snaps under reduced motion, so the numeral only UPGRADES to the
 * spring once motion has arrived (progressive enhancement — never a blank first paint).
 */
const LazyAnimatedNumber = React.lazy(() =>
  import('./motion/AnimatedNumber').then((m) => ({ default: m.AnimatedNumber })),
);

export type KpiAccent =
  | 'primary'
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info'
  | 'success';

/**
 * Which direction of change is GOOD for this metric.
 *  - `'up'`   (default): higher-is-better (e.g. agreement rate, coverage).
 *  - `'down'`: lower-is-better (e.g. MTTA/MTTR/dwell, open alerts, FP rate).
 *  - `'none'`: neutral — color the delta muted, no judgement implied.
 */
export type KpiGoodDirection = 'up' | 'down' | 'none';

export interface KpiDelta {
  /** Signed delta value; the SIGN drives the arrow (true direction of change). */
  value: number;
  /** Optional pre-formatted label (e.g. "+12%"); falls back to |value|. */
  label?: string;
}

export interface KpiTileProps {
  /** Metric label (plain text). */
  label: string;
  /** Metric value — string or number (plain text). */
  value: React.ReactNode;
  /** Optional sub-line under the value (plain text). */
  sub?: string;
  /** Optional leading icon. */
  icon?: LucideIcon;
  /** Colored accent — a soft icon chip (default variant) or the left bar (`bar`). */
  accent?: KpiAccent;
  /** Optional trend delta shown next to the value. */
  delta?: KpiDelta;
  /**
   * Optional SCALE CONTEXT rendered beside the value — the "out of what" half of a
   * bare count (e.g. `13% of 154`, `1 of 2 verdicted`, or an em dash when the honest
   * denominator is missing or the sample is truncated).
   *
   * Deliberately NOT the `delta` slot: a delta carries `role="img"` plus a
   * judgement colour, and this is neither a comparison nor a judgement — it is the
   * denominator the numeral is a share of. Plain, muted, non-interactive text (#9),
   * so it adds no accessible-name surface and no colour-only signalling.
   */
  secondary?: React.ReactNode;
  /**
   * Which direction of change counts as an improvement. COLOR encodes the
   * judgement (improved → success, regressed → critical); the ARROW always shows
   * the true direction of change and is never flipped. Defaults to `'up'` so no
   * existing call site regresses (the call-site sweep is the Codemod wave).
   */
  goodDirection?: KpiGoodDirection;
  /**
   * `'default'` — soft tinted icon chip carrying the accent (KPI strip tiles).
   * `'bar'`     — a slim colored LEFT accent bar (absorbs the former `StatCard`,
   *               used for MTTD/MTTA/MTTR-style timing metrics).
   * `'strip'`   — borderless command-center telemetry. The parent grid supplies
   *               the hairline separators; the icon sits inline with the label.
   */
  variant?: 'default' | 'bar' | 'strip';
  /** Compact command-surface rhythm for embedded telemetry bands. */
  density?: 'default' | 'compact';
  /** When provided the tile becomes a keyboard-accessible button. */
  onClick?: () => void;
  /**
   * Stable id for the `data-testid="kpi-<id>"` anchor. When omitted it is derived
   * from the label (slugified), so every tile is test-addressable without churn.
   */
  testId?: string;
  /**
   * Round-7 W0.1 — when set (a finite number), the big value ROLLS to this integer
   * via `<CountUp>` (static on first mount; animates on change; snaps under reduced
   * motion). INTEGERS ONLY — leave unset for money / percentages and pass a formatted
   * `value` instead. When set it replaces `value` as the rendered numeral.
   */
  countTo?: number;
  /** Formatter for `countTo` (default `String`). e.g. `(n) => n.toLocaleString()`. */
  format?: (n: number) => string;
  /**
   * Round-7 W0.1 — an optional decorative trend sparkline under the value. Rendered
   * ONLY when at least 5 real points are supplied (fewer reads as noise) and always
   * `aria-hidden` (the delta chip carries the accessible trend). Lazy-loaded.
   */
  spark?: number[];
  /**
   * Override the default five-point noise floor when the series has a smaller exact
   * contract (for example a two-point previous/current server comparison).
   */
  sparkMinPoints?: number;
  /**
   * Round-7 W0.1 — optional plain-text help shown via an inline `HelpTip` (?) beside
   * the label (e.g. the exact MTTA/MTTR formula). Rendered only on the NON-clickable
   * tile (a clickable tile is itself a button — nesting the HelpTip button would be
   * invalid); clickable summary tiles drill down instead of explaining.
   */
  help?: string;
  /** Accessible label for the help trigger (default `About <label>`). */
  helpLabel?: string;
  className?: string;
}

/** Slugify a label into a stable, lowercase, dash-joined id for test anchors. */
function slugId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Soft tinted chip behind the icon — the only place accent color appears (default variant). */
const ACCENT_CHIP: Record<KpiAccent, string> = {
  primary: 'bg-primary/10 text-primary',
  critical: 'bg-critical/10 text-critical',
  high: 'bg-high/10 text-high',
  medium: 'bg-medium/10 text-medium',
  low: 'bg-low/10 text-low',
  info: 'bg-info/10 text-info',
  success: 'bg-success/10 text-success',
};

/** Slim left accent bar — used by the `bar` variant. */
const ACCENT_BAR: Record<KpiAccent, string> = {
  primary: 'bg-primary',
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
  success: 'bg-success',
};

/** Standalone AA text colors used by the borderless command-center strip. */
const ACCENT_TEXT: Record<KpiAccent, string> = {
  primary: 'text-primary',
  critical: 'text-critical-text',
  high: 'text-high-text',
  medium: 'text-medium-text',
  low: 'text-low-text',
  info: 'text-info-text',
  success: 'text-success-text',
};

/**
 * Resolve the delta into its visual + accessible facts.
 *
 * BUG #2 FIX (DESIGN_STANDARD §5.3): color = judgement (did the metric improve?),
 * arrow = true direction of change (never flipped). "Open alerts +30%" must read
 * as a REGRESSION (critical + up arrow), not green just because the sign is +.
 */
function resolveDelta(delta: KpiDelta, goodDirection: KpiGoodDirection) {
  const rising = delta.value >= 0;
  // A zero / no-change delta (incl. the "new" badge that carries value 0) is NEUTRAL —
  // never an improvement OR a regression (DESIGN_STANDARD §5.3). Only a real move is
  // judged, so a fresh appearance of a bad metric can't render as a green "improved".
  const flat = delta.value === 0;
  const improved =
    flat || goodDirection === 'none'
      ? null
      : goodDirection === 'up'
        ? rising
        : /* 'down' */ !rising;

  // Use the AA-tuned standalone `-text` companions: the fill tokens (`text-success` /
  // `text-critical`) fail 4.5:1 as small text on the card in the light theme
  // (DESIGN_STANDARD §1.3, matching badges.tsx), so this 12px delta must use `-text`.
  const colorClass =
    improved === null
      ? 'text-muted-foreground'
      : improved
        ? 'text-success-text'
        : 'text-critical-text';
  const chipClass =
    improved === null
      ? 'border-border bg-muted/30'
      : improved
        ? 'border-success/25 bg-success/10'
        : 'border-critical/25 bg-critical/10';

  const Arrow = rising ? ArrowUpRight : ArrowDownRight;
  const directionWord = rising ? 'up' : 'down';
  // a11y: announce BOTH the direction and the judgement (never color-only).
  const judgement = improved === null ? '' : improved ? ', improved' : ', worse';
  const ariaLabel = `changed ${directionWord} by ${delta.label ?? Math.abs(delta.value)}${judgement}`;

  return { colorClass, chipClass, Arrow, ariaLabel };
}

/**
 * AdSense-clean KPI tile: muted small-caps label, a big tabular value, and a soft
 * tinted icon chip (or a left accent bar in `variant='bar'`) carrying the only
 * accent color. Border-first (hairline border, no resting shadow); a static card,
 * or — when `onClick` is set — a keyboard-accessible button with focus ring + calm
 * hover. Token-themed. All text plain (UNTRUSTED-safe, #9).
 */
export const KpiTile = React.forwardRef<HTMLElement, KpiTileProps>(
  (
    {
      label,
      value,
      sub,
      icon: Icon,
      accent = 'primary',
      delta,
      secondary,
      goodDirection = 'up',
      variant = 'default',
      density = 'default',
      onClick,
      testId,
      countTo,
      format,
      spark,
      sparkMinPoints = 5,
      help,
      helpLabel,
      className,
    },
    ref,
  ) => {
    const clickable = typeof onClick === 'function';
    const kpiTestId = `kpi-${testId ?? slugId(label)}`;
    const bar = variant === 'bar';
    const strip = variant === 'strip';
    const compact = density === 'compact';

    const deltaFacts = delta ? resolveDelta(delta, goodDirection) : null;

    // The rendered numeral: roll to `countTo` when it's a finite integer, else the
    // caller-supplied `value` (string or node) unchanged. The roll is the lazy motion.dev
    // spring (`AnimatedNumber`); its Suspense fallback is the CSS-rAF `<CountUp>` (see
    // LazyAnimatedNumber above). Both are handed the SAME formatter (`format ?? String`,
    // matching CountUp's historical `String` default) so the fallback→spring upgrade never
    // changes the displayed text. Both honour reduced motion by snapping to the target.
    const rollFormat = format ?? ((n: number) => String(n));
    const valueNode =
      typeof countTo === 'number' && Number.isFinite(countTo) ? (
        <React.Suspense fallback={<CountUp value={countTo} format={format} as="span" />}>
          <LazyAnimatedNumber value={countTo} format={rollFormat} />
        </React.Suspense>
      ) : (
        value
      );

    // Sparkline gate: five real points by default, or a caller's explicit exact-series
    // floor (never below two); decorative + aria-hidden. Lazy (no recharts here).
    const requiredSparkPoints = Math.max(2, Math.floor(sparkMinPoints));
    const sparkNode =
      spark && spark.length >= requiredSparkPoints ? (
        <div
          className={cn(
            strip ? 'absolute bottom-4 right-4 h-4 w-14' : 'mt-3 -mb-1 h-7',
          )}
          aria-hidden
        >
          <React.Suspense fallback={null}>
            <LazySparkline data={spark} height={strip ? 16 : 28} colorToken={accent} fill={!strip} />
          </React.Suspense>
        </div>
      ) : null;

    // Inline help (?) — only on the non-clickable tile (see prop doc: no nested button).
    const helpNode =
      help && !clickable ? (
        <HelpTip
          text={help}
          label={helpLabel ?? `About ${label}`}
          className="-my-1 text-muted-foreground/70"
        />
      ) : null;

    // Scale context ("N of M" / "P% of N" / an em dash). Muted, tabular, plain text —
    // no role, no accessible name, no judgement colour: it explains the numeral's
    // denominator, it does not compare periods.
    const secondaryNode =
      secondary === undefined || secondary === null || secondary === '' ? null : (
        <span
          // `min-w-0` + `truncate` (not a bare `whitespace-nowrap`): at the landing
          // strip's 5-column breakpoint an unbounded context string ("12,345 of 48,901
          // verdicted") is wider than the tile, and the tile's `overflow-hidden` used to
          // clip it mid-word with no ellipsis. It now shrinks with an ellipsis, and a
          // plain-text context carries its full value in `title`.
          className={cn(
            'mb-0.5 min-w-0 truncate font-mono font-medium tabular-nums text-muted-foreground',
            strip && !compact ? 'text-xs' : 'text-2xs',
          )}
          title={typeof secondary === 'string' ? secondary : undefined}
        >
          {secondary}
        </span>
      );

    const deltaNode = deltaFacts ? (
      <span
        // `role="img"` makes `aria-label` a valid accessible name on this element (a
        // bare span maps to the generic role, where aria-label is prohibited/ignored —
        // axe `aria-prohibited-attr`). With the visible value aria-hidden, this is the
        // ONLY reliable announcement of the trend direction + judgement (Round-5 §6.1).
        role="img"
        className={cn(
          'mb-0.5 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums',
          deltaFacts.colorClass,
          strip && `rounded-sm border px-1.5 py-0.5 ${deltaFacts.chipClass}`,
        )}
        aria-label={deltaFacts.ariaLabel}
      >
        <deltaFacts.Arrow className="h-3.5 w-3.5" aria-hidden />
        <span aria-hidden>{delta!.label ?? Math.abs(delta!.value)}</span>
      </span>
    ) : null;

    const inner = (
      <>
        <div className="flex items-start justify-between gap-3">
          <span
            className={cn(
              'inline-flex items-center gap-1 font-semibold uppercase tracking-wide',
              strip ? 'text-2xs text-muted-foreground' : 'text-xs text-muted-foreground',
            )}
          >
            {Icon && strip ? (
              <Icon className={cn('h-3.5 w-3.5 shrink-0', ACCENT_TEXT[accent])} aria-hidden />
            ) : null}
            {label}
            {helpNode}
          </span>
          {Icon && !bar && !strip ? (
            <span
              className={cn(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                ACCENT_CHIP[accent],
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : Icon && bar ? (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
        </div>
        <div className={cn('flex min-w-0 items-end gap-2', strip ? 'mt-2' : 'mt-3')}>
          <span
            className={cn(
              'font-semibold leading-none tracking-tight tabular-nums',
              strip ? (compact ? 'text-2xl' : 'text-4xl') : 'text-3xl',
              strip && (accent === 'critical' || accent === 'success')
                ? ACCENT_TEXT[accent]
                : 'text-foreground',
            )}
          >
            {valueNode}
          </span>
          {secondaryNode}
          {deltaNode}
        </div>
        {sparkNode}
        {sub ? (
          <span
            className={cn(
              'block text-muted-foreground',
              strip
                ? compact
                  ? 'mt-1 line-clamp-1 font-mono text-2xs'
                  : 'mt-1 truncate pr-16 font-mono text-2xs'
                : 'mt-2 text-xs',
            )}
          >
            {sub}
          </span>
        ) : null}
      </>
    );

    const base = cn(
      'relative h-full min-w-0 overflow-hidden text-left',
      strip
        ? compact
          ? 'min-h-0 bg-transparent px-3 py-3'
          : 'min-h-28 bg-transparent px-4 py-5'
        : 'rounded-lg border border-border bg-card p-4',
      bar && !strip && 'pl-5',
    );

    const barEdge = bar ? (
      <span className={cn('absolute inset-y-0 left-0 w-0.5', ACCENT_BAR[accent])} aria-hidden />
    ) : null;

    if (clickable) {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={onClick}
          data-testid={kpiTestId}
          className={cn(
            base,
            'block w-full transition-colors hover:bg-accent/30',
            !strip && 'hover:border-primary/40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
        >
          {barEdge}
          {inner}
        </button>
      );
    }

    return (
      <div ref={ref as React.Ref<HTMLDivElement>} data-testid={kpiTestId} className={cn(base, className)}>
        {barEdge}
        {inner}
      </div>
    );
  },
);
KpiTile.displayName = 'KpiTile';

export default KpiTile;
