import * as React from 'react';
import { cn } from '@/lib/cn';
import {
  ArrowDownRight,
  ArrowUpRight,
  SquareArrowOutUpRight,
  type LucideIcon,
} from 'lucide-react';
import { CountUp } from './CountUp';
import { AskAboutThis } from './AskAboutThis';
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

/**
 * One row of a labelled numeral partition (a `dt`/`dd` pair). Plain text on both halves
 * (#9) — the caller formats the number.
 *
 * Consumed in the product by `KpiDrilldownSpec.partition` (KpiDrilldownPanel); also
 * accepted by `KpiTileProps.breakdown` below, which currently has no caller. Do not
 * delete this type with that prop.
 */
export interface KpiBreakdownRow {
  /** Short band label (plain text). */
  label: string;
  /** Pre-formatted value (plain text). */
  value: string;
  /** Optional full meaning for the truncated short label (native tooltip). */
  title?: string;
}

export interface KpiDelta {
  /** Signed delta value; the SIGN drives the arrow (true direction of change). */
  value: number;
  /** Optional pre-formatted label (e.g. "+12%"); falls back to |value|. */
  label?: string;
}

/**
 * The hero ladder's two cut points, in CHARACTERS of the final formatted string.
 *
 * Derived from the tightest supported layout, not from taste. MEASURED in a browser: a
 * six-cell strip on a 1280px viewport with the rail pinned gives each cell 143px of
 * content. Inter's tabular figures at 600 weight run ~0.647 em, so at 30px that is
 * ~19.4px a character (this half is a type-metric estimate, not a measurement): six
 * characters plus the bound mark come to ~136px and fit, seven do not. The 24px step
 * buys back roughly two more characters. Past that no step is legible at a glance, so
 * the value abbreviates instead of shrinking further.
 */
const HERO_SHRINK_AT = 6;
const HERO_ABBREVIATE_AT = 8;

/**
 * The FLOOR mark. `≥` and not a dagger: `†` (U+2020) is absent from the self-hosted
 * `inter-latin-wght-normal.woff2` subset and would render from a fallback face at a
 * different weight. This is the same mark the noise funnel already puts on a bounded
 * open-cases count, so the console has one bound vocabulary rather than two.
 */
const BOUND_MARK = '≥';

/** `format ?? String`, matching CountUp's historical default. */
const rollFormatOf = (format: ((n: number) => string) | undefined, n: number): string =>
  format ? format(n) : String(n);

/**
 * The numeral size scale (`KpiTileProps.size`).
 *  - `'default'` — the fixed type-scale steps (30 → 24 → 20px on the hero ladder).
 *  - `'fluid'`   — the hero numeral grows with ITS OWN TILE, not the viewport: the numeral
 *                  row is a size container and the rungs are `cqi` clamps (theme.css
 *                  `.kpi-numeral-fluid*`), 25 / 20 / 15% of the row's width between a
 *                  24 / 20 / 18px floor and a 44 / 35 / 29px cap. Measured Inter tabular
 *                  figures run 0.626em a digit and 0.248em a comma, so each rung holds its
 *                  ladder band (≤6, 7–8, 9+ characters including a `≥`) in the width it is
 *                  sized from — at any viewport, with the nav pinned or not. Use it in a
 *                  sized parent (a `KpiTileGrid` cell): a size container takes no width
 *                  from its content.
 */
export type KpiNumeralScale = 'default' | 'fluid';

/** The fluid ladder's three rungs (theme.css). Literal strings so Tailwind keeps them. */
const FLUID_RUNGS = ['kpi-numeral-fluid', 'kpi-numeral-fluid-md', 'kpi-numeral-fluid-sm'] as const;
/** The fixed hero ladder (30 → 24 → 20px), plus one fit-only step below it (18px). */
const HERO_STEPS = ['text-4xl', 'text-3xl', 'text-2xl', 'text-xl'] as const;

/** Which rung of the hero ladder a final display string (mark included) starts on. */
function ladderRung(text: string): number {
  return text.length <= HERO_SHRINK_AT ? 0 : text.length <= HERO_ABBREVIATE_AT ? 1 : 2;
}

/**
 * The hero numeral's size class for a given final formatted string. Pure and exported
 * so the ladder's cut points are unit-testable without rendering a tile. The cut points
 * are the same on both scales; only the sizes differ. Pass the string AS DISPLAYED — a
 * floor numeral is measured with its `≥` (the tile does this itself).
 */
export function numeralSize(text: string, scale: KpiNumeralScale = 'default'): string {
  const rung = ladderRung(text);
  return scale === 'fluid' ? FLUID_RUNGS[rung] : HERO_STEPS[rung];
}

/**
 * Does the numeral not fit its row? Either its content is wider than its box (a grouped
 * integer has no break opportunity, so it overflows rather than wraps) or it has wrapped
 * onto a second line at a space. Both read 0 in jsdom, so tests see the ladder's choice.
 */
function numeralOverflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  const size = Number.parseFloat(window.getComputedStyle(el).fontSize);
  return Number.isFinite(size) && size > 0 && el.offsetHeight > size * 1.6;
}

/**
 * The FIT guard behind the ladder: how many steps below its starting size a numeral must
 * go to fit the row it is actually in.
 *
 * The ladder picks a size from the string's length; that is an estimate, and a tile can be
 * narrower than the one it was calibrated on (a pinned nav, a corner overlay, a chat
 * column). So the numeral is MEASURED after layout and stepped down — never cut, never
 * broken inside its digits — until it fits or the steps run out. It re-measures when the
 * row resizes (a wider row starts again from the largest size) and when the numeral's
 * text changes underneath React (the count-up writes digits frame by frame).
 */
function useNumeralFit(
  ref: React.RefObject<HTMLElement | null>,
  key: string,
  maxStep: number,
): number {
  const [fit, setFit] = React.useState({ key, step: 0 });
  // A new value or a new starting size starts again from the largest step.
  const step = fit.key === key ? Math.min(fit.step, maxStep) : 0;
  const stepRef = React.useRef(step);
  stepRef.current = step;

  // After the numeral renders at a size: one more step if it still does not fit. Each
  // step is a synchronous re-render before paint, so a too-large frame is never shown.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el && step < maxStep && numeralOverflows(el)) setFit({ key, step: step + 1 });
  }, [ref, key, step, maxStep]);

  React.useEffect(() => {
    const el = ref.current;
    const row = el?.parentElement;
    if (!el || !row || maxStep === 0 || typeof window === 'undefined') return undefined;
    let width = row.clientWidth;
    let frame = 0;
    const check = () => {
      frame = 0;
      const next = row.clientWidth;
      if (next > width + 0.5) {
        width = next;
        setFit({ key, step: 0 });
        return;
      }
      width = next;
      if (stepRef.current < maxStep && numeralOverflows(el)) {
        setFit({ key, step: stepRef.current + 1 });
      }
    };
    const schedule = () => {
      if (frame) return;
      if (typeof window.requestAnimationFrame === 'function') frame = window.requestAnimationFrame(check);
      else check();
    };
    const ro = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(schedule) : null;
    ro?.observe(row);
    const mo =
      typeof window.MutationObserver === 'function' ? new window.MutationObserver(schedule) : null;
    mo?.observe(el, { characterData: true, childList: true, subtree: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
    };
  }, [ref, key, maxStep]);

  return step;
}

/**
 * Column classes for a container-query grid of `count` tiles (see `KpiTileGrid`).
 *
 * The column count FOLLOWS THE TILE COUNT, so a grid never draws an empty track: three
 * tiles make three equal columns, never three tiles in a six-track row. Below the width
 * where every tile gets ≥10rem the grid steps down to a BALANCED count (six tiles go
 * 6 → 3 → 2 → 1, five go 5 → 3 → 2 → 1, four go 4 → 2 → 1), so the rows stay as even as
 * the count allows. Literal class strings, so Tailwind's compiler sees every one; the
 * parent must be an `@container` (KpiTileGrid is).
 */
export function kpiGridColumns(count: number): string {
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  switch (n) {
    case 1:
      return 'grid-cols-1';
    case 2:
      return 'grid-cols-1 @[20rem]:grid-cols-2';
    case 3:
      return 'grid-cols-1 @[30rem]:grid-cols-3';
    case 4:
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[40rem]:grid-cols-4';
    case 5:
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[30rem]:grid-cols-3 @[50rem]:grid-cols-5';
    case 6:
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[30rem]:grid-cols-3 @[60rem]:grid-cols-6';
    case 7:
    case 8:
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[40rem]:grid-cols-4';
    case 9:
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[30rem]:grid-cols-3';
    case 10:
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[50rem]:grid-cols-5';
    default:
      // 11+: at most six columns, still never more columns than tiles.
      return 'grid-cols-1 @[20rem]:grid-cols-2 @[30rem]:grid-cols-3 @[60rem]:grid-cols-6';
  }
}

export interface KpiTileProps {
  /** Metric label (plain text). */
  label: string;
  /** Metric value — string or number (plain text). */
  value: React.ReactNode;
  /** Optional sub-line under the value (plain text). */
  sub?: string;
  /**
   * A CONDITIONAL BOUND on this numeral, as a full sentence.
   *
   * Descriptive copy may be relocated to a help surface; a bound may not. It is
   * visible exactly when it is true, so a reader who never opens the help would
   * otherwise read a floor as a fact. This prop is the non-prose carrier that
   * stays ON the numeral once the caption under it is gone, in ONE grammar with
   * two states, chosen by whether there is a number to qualify at all:
   *
   *   FLOOR    (`countTo` is a number) — a `≥` mark immediately before the value.
   *   WITHHELD (no number)             — the em dash itself becomes the mark, so a
   *                                      rate that refuses to publish is not just a
   *                                      bare dash with nothing to explain it.
   *
   * Both states carry the sentence to assistive tech as real text content in an
   * `sr-only` sibling — never as an `aria-label` on a bare span (prohibited on the
   * generic role) and never as a `title` alone (mouse-only, and banned as the sole
   * carrier of a load-bearing caveat by the UI standard).
   *
   * The mark takes NO colour of its own: it inherits the numeral's already-gated
   * accent, so it cannot become a second, ungated colour signal.
   */
  bound?: string;
  /**
   * HERO ONLY — the numeral's "compared to what?", on its own line under it.
   *
   * A short DATA line ("18% of 43 cases", "33 of 44 verdicted"), never a sentence about
   * the metric: that belongs in `help`. It used to sit BESIDE the numeral as `secondary`,
   * where flex shrank the numeral first and turned "72%" into "7…"; on its own line it can
   * never take width from the number. The same line is where a state disclosure (`sub`)
   * or a conditional bound (`bound`) is shown, in that order of precedence — exactly one
   * of the three ever renders, so the strip's rhythm never changes with the state.
   */
  context?: string;
  /** Optional leading icon. */
  icon?: LucideIcon;
  /** Colored accent — a soft icon chip (default variant) or the left bar (`bar`). */
  accent?: KpiAccent;
  /** Optional trend delta shown next to the value. */
  delta?: KpiDelta;
  /**
   * Optional SCALE CONTEXT on its own line UNDER the numeral — the "out of what" half
   * of a bare count (e.g. `13% of 154`, `1 of 2 verdicted`, or an em dash when the
   * honest denominator is missing or the sample is truncated). It used to share the
   * numeral's row, where flex shrank both and a 166px chat tile showed "≥…" and
   * "in the returned p…"; on its own line it wraps and never takes width from the number.
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
  /**
   * Rhythm of a `strip` tile.
   *  - `'compact'`     — embedded telemetry bands (`px-3 py-2`).
   *  - `'comfortable'` — a dashboard strip that heads a page: between compact and
   *                      default (`px-4 py-3` at `xl`, `px-5 py-4` at `2xl`), with 13px
   *                      hero label and context lines. Pair it with `size="fluid"`.
   *  - `'default'`     — a strip that stands alone.
   * Density changes padding and type only; never the cell count or divider rules.
   */
  density?: 'default' | 'compact' | 'comfortable';
  /**
   * The numeral size scale. `'fluid'` is the hero numeral that grows with ITS OWN TILE
   * (the numeral row is a size container; the rungs are `cqi` clamps between a 24 / 20 /
   * 18px floor and a 44 / 35 / 29px cap) instead of a fixed step; see `KpiNumeralScale`.
   * Default `'default'`.
   */
  size?: KpiNumeralScale;
  /**
   * Whether a `countTo` change ROLLS (count-up) or simply shows the new value. Default
   * `true`. Pass `false` for an automatic LIVE refresh: a dashboard's numerals roll on
   * first load or a window change, never on a background tick (no motion that implies
   * the operator did something).
   */
  roll?: boolean;
  /**
   * Numeral weight WITHIN the compact rhythm.
   *
   * `density="compact"` is a shared console rhythm passed at nine call sites across
   * six other pages, so enlarging its numeral wholesale would change all of them.
   * `'hero'` is the opt-in for a landing strip that has given its caption row back
   * to the number: it steps 24px → 30px (`text-4xl`, an existing token) and then
   * steps DOWN again for a value too long to fit, rather than truncating one.
   */
  numeral?: 'default' | 'hero';
  /** When provided the tile becomes a keyboard-accessible button. */
  onClick?: () => void;
  /**
   * For the (rare) caller whose `onClick` opens a MODAL rather than navigating — the KPI
   * drill-down on the landing strip is the only one today.
   *
   * This replaced `ariaExpanded`/`ariaControls` when that drill-down became a dialog.
   * `aria-expanded` is a DISCLOSURE semantic and is wrong on a dialog trigger, and
   * `aria-controls` could only ever dangle: the dialog is portalled and does not exist in
   * the DOM while it is closed.
   *
   * Defaults to `undefined` and is then NOT emitted at all, so the ~14 tiles that
   * navigate, filter, or do nothing keep their exact current accessible semantics: a
   * plain button with no popup claim. Announcing a popup on a tile that opens a different
   * PAGE would be a lie to assistive tech, which is why this is opt-in rather than
   * derived from `onClick`.
   */
  ariaHasPopup?: 'dialog';
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
   * ABBREVIATING formatter, used only when the fully formatted value is too long to
   * survive at any step of the hero ladder (see `numeral`). The exact value then moves
   * to the numeral's `title` and to its accessible name, so nothing is lost — the tile
   * shows `5.4k`, the reader can still get `5,423,100`.
   *
   * Deliberately a PROP rather than a hardcoded `fmtTokens` call: that helper is shared
   * with money and percentages and rounds to whole units above 10,000, which is a
   * caller's decision to make about its own metric, not this component's.
   */
  formatCompact?: (n: number) => string;
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
  /**
   * A `console_map` KPI topic (`ask-topics.ts`): the help popover then ends with "Ask
   * about this", which opens a new chat asking that topic's templated question (SPEC
   * §10.7). Shown only with `help`, and only to a caller who can use chat.
   */
  askTopic?: string;
  /**
   * Told when this tile's help popover opens or closes.
   *
   * A tile can be wrapped in a hover trend card, and the help trigger is INSIDE that
   * wrapper — so by the time the operator reaches the `?` the card is already open, and
   * clicking would leave two floating surfaces over one tile. The host owns both, so the
   * host is told and stands the card down.
   */
  onHelpOpenChange?: (open: boolean) => void;
  /**
   * Optional PARTITION of the numeral, rendered inside the tile as labelled rows —
   * the "of which" detail behind a total.
   *
   * NO CALLER PASSES THIS TODAY. Its one consumer was the landing strip's Resolved /
   * Closed tile, whose close attribution moved to `KpiDrilldownSpec.partition`: on the
   * strip face it was the only tile with a partition, so it set the height of all five
   * cells. The slot is kept for a future in-place partition on a surface where one tile
   * carrying extra rows costs nothing — if you add one, re-read the ARIA note below, and
   * note that `padX`/`padBottom`/`breakdownIsSibling` exist only to serve this path.
   *
   * Supply the WHOLE partition or none. A partition rendered minus one band silently
   * folds that band's rows into a neighbour and over-states it; the residual therefore
   * stays visible even at zero. Rendered as a real <dl>, so each row is a
   * label/value pair rather than a run-on string.
   *
   * On a CLICKABLE tile the list is a SIBLING of the trigger, never a child of it:
   * ARIA gives `role=button` "children presentational", so a <dl> inside the button is
   * stripped of its dt/dd relationships (and of each dt's `title`) and flattened into
   * the trigger's accessible name — the exact run-on string the paragraph above says
   * this avoids, and it would rename the disclosure trigger on every value change.
   */
  breakdown?: KpiBreakdownRow[];
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

  // A zero delta has no direction: no arrow, and it is never announced as "changed up
  // by 0" (the arrow shows the TRUE direction, and there is none).
  const Arrow = flat ? null : rising ? ArrowUpRight : ArrowDownRight;
  const directionWord = rising ? 'up' : 'down';
  // a11y: announce BOTH the direction and the judgement (never color-only).
  const judgement = improved === null ? '' : improved ? ', improved' : ', worse';
  const ariaLabel = flat
    ? flatDeltaLabel(delta.label)
    : `changed ${directionWord} by ${delta.label ?? Math.abs(delta.value)}${judgement}`;

  return { colorClass, chipClass, Arrow, ariaLabel };
}

/**
 * The accessible name of a zero delta: a word label is spoken as is ("new"), a zero
 * figure as "unchanged" ("0 vs previous window" → "unchanged vs previous window").
 */
function flatDeltaLabel(label: string | undefined): string {
  const text = (label ?? '').trim();
  if (!text) return 'unchanged';
  const zero = /^[+\-\u2212\u00b1]?0+(?:[.,]0+)?\s*(?:%|pp)?(?=\s|$)/.exec(text);
  if (!zero) return text;
  const rest = text.slice(zero[0].length).trim();
  return rest ? `unchanged ${rest}` : 'unchanged';
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
      bound,
      context,
      icon: Icon,
      accent = 'primary',
      delta,
      secondary,
      goodDirection = 'up',
      variant = 'default',
      density = 'default',
      size = 'default',
      roll = true,
      numeral = 'default',
      onClick,
      ariaHasPopup,
      testId,
      countTo,
      format,
      formatCompact,
      spark,
      sparkMinPoints = 5,
      help,
      helpLabel,
      askTopic,
      onHelpOpenChange,
      breakdown,
      className,
    },
    ref,
  ) => {
    const clickable = typeof onClick === 'function';
    const kpiTestId = `kpi-${testId ?? slugId(label)}`;
    const bar = variant === 'bar';
    const strip = variant === 'strip';
    const compact = density === 'compact';
    const comfortable = density === 'comfortable';
    const hero = numeral === 'hero';
    const fluid = size === 'fluid';

    const deltaFacts = delta ? resolveDelta(delta, goodDirection) : null;

    /*
     * HERO LADDER — pick the numeral size from the FINAL formatted string, then fall
     * back to abbreviating rather than shrinking past legibility.
     *
     * A grouped integer offers no min-content break (UAX #14), so at 30px a long value
     * is not wrapped, it is CLIPPED by the tile's `overflow-hidden` — and a clipped
     * "543,210" reads as "543,21", a plausible WRONG number rather than an obvious
     * failure. The ladder keeps the common case big and the rare case honest. It keys on
     * string LENGTH, never on the metric's meaning, so it stays portable across deployments.
     */
    const heroText =
      typeof countTo === 'number' && Number.isFinite(countTo)
        ? rollFormatOf(format, countTo)
        : typeof value === 'string'
          ? value
          : typeof value === 'number'
            ? String(value)
            : '';
    /*
     * Which of the bound grammar's two states applies. A bound qualifies a NUMBER, so
     * the floor mark only appears where a number was actually published; where the value
     * is withheld (an em dash) the dash carries the mark instead. Callers therefore never
     * have to choose the state — the presence of a numeral decides it, and the two can
     * never disagree with what is on screen.
     */
    const boundIsFloor =
      Boolean(bound) && typeof countTo === 'number' && Number.isFinite(countTo);
    // The FLOOR mark is part of what is drawn, so the ladder counts it: "≥77,777" is seven
    // characters wide, not six.
    const markText = boundIsFloor ? BOUND_MARK : '';

    // The ladder applies to hero numerals and to the fluid scale.
    const laddered = hero || fluid;
    const canCompact =
      laddered &&
      typeof formatCompact === 'function' &&
      typeof countTo === 'number' &&
      Number.isFinite(countTo);

    /*
     * The numeral's SIZE STEPS, largest first, and where the ladder starts on them. The fit
     * guard (`useNumeralFit`) then walks further down from the start whenever the numeral
     * does not fit the row it is actually in, and — once the sizes run out — abbreviates
     * through `formatCompact` when one is offered, and KEEPS WALKING with the short form.
     *
     * One walk, two phases, each step measured:
     *   phase 1 — the full value, from `ladderStart` to the smallest size;
     *   phase 2 — the abbreviated value, from the rung its OWN length earns
     *             (`compactStart`) to the smallest size.
     * Phase 2 restarts at the short form's rung rather than staying at the smallest size,
     * so a short form that fits large is shown large; and because every step is measured,
     * one that does not fit there steps down again instead of being clipped (before, the
     * short form jumped back to its rung with no steps left to take).
     */
    const sizeSteps: readonly string[] = fluid
      ? FLUID_RUNGS
      : strip
        ? compact && !hero
          ? ['text-2xl', 'text-xl', 'text-lg']
          : HERO_STEPS
        : ['text-3xl', 'text-2xl', 'text-xl'];
    const lengthCompact = canCompact && markText.length + heroText.length > HERO_ABBREVIATE_AT;
    const compactStart = canCompact ? ladderRung(markText + formatCompact!(countTo as number)) : 0;
    const ladderStart = laddered ? (lengthCompact ? compactStart : ladderRung(markText + heroText)) : 0;
    // Sizes the full value walks through, then (only when it may still abbreviate) the
    // sizes the short form walks through.
    const fullSteps = sizeSteps.length - ladderStart;
    const compactSteps = canCompact && !lengthCompact ? sizeSteps.length - compactStart : 0;
    const maxFitStep = fullSteps - 1 + compactSteps;
    const numeralRef = React.useRef<HTMLSpanElement | null>(null);
    const fitStep = useNumeralFit(
      numeralRef,
      `${sizeSteps[0]}|${markText}${heroText}|${ladderStart}`,
      maxFitStep,
    );
    // Abbreviating is the LAST resort: by length (the ladder's own rule), or because even
    // the smallest size did not fit this row (phase 2 of the walk above).
    const fitCompact = compactSteps > 0 && fitStep >= fullSteps;
    const heroCompact = lengthCompact || fitCompact;
    const sizeClass = fitCompact
      ? sizeSteps[compactStart + fitStep - fullSteps]
      : sizeSteps[Math.min(ladderStart + fitStep, sizeSteps.length - 1)];

    // The rendered numeral: roll to `countTo` when it's a finite integer, else the
    // caller-supplied `value` (string or node) unchanged. The roll is the lazy motion.dev
    // spring (`AnimatedNumber`); its Suspense fallback is the CSS-rAF `<CountUp>` (see
    // LazyAnimatedNumber above). Both are handed the SAME formatter (`format ?? String`,
    // matching CountUp's historical `String` default) so the fallback→spring upgrade never
    // changes the displayed text. Both honour reduced motion by snapping to the target.
    // When the hero ladder has decided to abbreviate, BOTH the spring and its fallback
    // are handed the abbreviating formatter, so the upgrade still never changes the text.
    const rollFormat = heroCompact
      ? (formatCompact as (n: number) => string)
      : (format ?? ((n: number) => String(n)));
    // `roll={false}` (a LIVE refresh) shows the new value as plain text: data on an
    // automatic refresh never animates.
    const valueNode =
      typeof countTo === 'number' && Number.isFinite(countTo) ? (
        roll ? (
          <React.Suspense fallback={<CountUp value={countTo} format={rollFormat} as="span" />}>
            <LazyAnimatedNumber value={countTo} format={rollFormat} />
          </React.Suspense>
        ) : (
          rollFormat(countTo)
        )
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

    /**
     * Inline help (?).
     *
     * On a NON-clickable tile it sits inside the tile, beside the label. On a CLICKABLE
     * tile it cannot: a `<button>` inside a `<button>` is invalid DOM (React logs a
     * `validateDOMNesting` warning, which `npm run test:strict` treats as a failure), and
     * ARIA would swallow it into the trigger's name anyway. So it renders as a SIBLING of
     * the trigger in the same cell — the same arrangement the (currently callerless)
     * `breakdown` slot is built for.
     *
     * `alwaysPopover` because this is where always-visible disclosure copy was RELOCATED
     * to: a tooltip never opens on touch, and a disclosure a tablet operator cannot reach
     * has been deleted, not tidied.
     */
    const helpNode = help ? (
      <HelpTip
        text={help}
        label={helpLabel ?? `About ${label}`}
        alwaysPopover
        onOpenChange={onHelpOpenChange}
        footer={askTopic ? <AskAboutThis topic={askTopic} subject={label} className="pt-1" /> : undefined}
        className={clickable ? 'text-muted-foreground/70' : '-my-1 text-muted-foreground/70'}
      />
    ) : null;
    const helpIsSibling = clickable && helpNode !== null;

    /**
     * The always-visible "this opens something" mark.
     *
     * It replaces a strip-level sentence that told the operator, once, in prose, that the
     * tiles were selectable. A sentence under a five-tile row is read once and then becomes
     * furniture; a mark ON the control is read every time, and — unlike the hover card that
     * used to carry the same promise — it reaches touch and keyboard users, who never see a
     * hover card at all.
     *
     * Decorative only (`aria-hidden`): the ACCESSIBLE claim is `aria-haspopup` on the
     * button, so the two can never disagree, and it is deliberately tied to that same prop
     * rather than to `onClick` — a tile that navigates elsewhere must not wear a mark that
     * promises a panel.
     */
    const affordanceNode =
      ariaHasPopup === 'dialog' ? (
        <SquareArrowOutUpRight
          data-testid={`${kpiTestId}-affordance`}
          className="size-3 shrink-0 text-muted-foreground/60"
          aria-hidden
        />
      ) : null;
    /** The label row's reserve for the corner cluster: its width less the cell padding. */
    const overlayReserve =
      helpIsSibling && clickable && affordanceNode
        ? 'pr-10'
        : helpIsSibling
          ? 'pr-6'
          : clickable && affordanceNode
            ? 'pr-4'
            : null;
    /** Anything that must sit ON the cell but OUTSIDE the trigger button. */
    const cellOverlay =
      helpIsSibling || (clickable && affordanceNode) ? (
        // `pointer-events-none` on the cluster so the decorative mark never steals a click
        // from the trigger underneath it; the help button re-enables them for itself.
        <div
          className={cn(
            'pointer-events-none absolute right-2 z-10 flex items-center gap-0.5',
            /*
             * The cluster sits in the LABEL row's corner on every tile, centred on the
             * label's first line, and the label row reserves its width (below). It used to
             * sit on a hero tile's NUMERAL row, where nothing reserved space for it: on
             * hover, focus, and permanently on touch screens it covered the last digits of
             * a long value ("≥77,777"). A label that wraps under the reserve is harmless —
             * hero numerals bottom-align, so the row of numbers stays level — while a
             * covered digit is a wrong number.
             */
            hero ? (compact ? 'top-1' : comfortable ? 'top-2 2xl:top-3' : 'top-4') : 'top-2',
            /*
             * HERO tiles keep their chrome out of sight until it is wanted. A (?) and a ↗ on
             * every tile at rest is the most recognisable "generated dashboard" pattern — six
             * identical icon pairs competing with six numbers. Here they appear when the cell
             * is hovered or anything inside it has focus, so a keyboard user still lands on a
             * VISIBLE help button; they stay visible while that help popover is open (Radix
             * marks its trigger `data-state="open"`, and the popover itself is portalled out of
             * the cell); and on devices with no hover at all they never hide, so touch users
             * keep both marks.
             */
            hero &&
              'opacity-0 transition-opacity duration-fast group-hover/kpi:opacity-100 group-focus-within/kpi:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none',
          )}
        >
          {helpIsSibling ? <span className="pointer-events-auto">{helpNode}</span> : null}
          {affordanceNode}
        </div>
      ) : null;

    /*
     * HERO context line: one line under the numeral, with a fixed precedence so exactly one
     * thing ever occupies it — a STATE disclosure (`sub`: loading, unavailable, not
     * measured) beats a conditional BOUND, which beats the plain scale CONTEXT. A bound
     * shown here is visible text, so it no longer needs its `sr-only` twin below.
     */
    const heroLine = hero ? (sub ?? bound ?? context ?? null) : null;
    const boundShownInLine = hero && !sub && Boolean(bound);

    // Scale context ("N of M" / "P% of N" / an em dash). Muted, tabular, plain text —
    // no role, no accessible name, no judgement colour: it explains the numeral's
    // denominator, it does not compare periods.
    //
    // It sits on its OWN LINE under the numeral and WRAPS (Round 12). Sharing the
    // numeral's row made flex shrink both, so a chat tile read "≥…" over "in the
    // returned p…". Here it can never take width from the number, and nothing is cut:
    // a long context simply takes a second line. 12px — content text, not a badge.
    const secondaryNode =
      secondary === undefined || secondary === null || secondary === '' ? null : (
        <span
          className="mt-1 block min-w-0 break-words text-xs tabular-nums text-muted-foreground"
          data-kpi-secondary=""
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
          // `max-w-full` + a wrapping label: on a narrow tile the chip drops to its own
          // line under the numeral (the row wraps), and a long label ("+3 vs last
          // week") wraps inside the chip rather than pushing the numeral off the tile.
          'mb-0.5 inline-flex max-w-full items-center gap-0.5 text-left text-xs font-semibold tabular-nums',
          deltaFacts.colorClass,
          strip && `rounded-sm border px-1.5 py-0.5 ${deltaFacts.chipClass}`,
        )}
        aria-label={deltaFacts.ariaLabel}
      >
        {deltaFacts.Arrow ? <deltaFacts.Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        <span aria-hidden className="min-w-0 break-words">
          {delta!.label ?? Math.abs(delta!.value)}
        </span>
      </span>
    ) : null;

    // The in-place partition ("of which"): a real definition list so each band is a
    // label/value pair. Plain, muted text with no judgement colour — it explains what
    // the numeral is made of, it does not compare periods.
    const breakdownNode =
      breakdown && breakdown.length > 0 ? (
        // 12px: a stat's partition is content text, not a badge (ui-standard
        // "Typography"); its values are numbers, so tabular sans rather than mono.
        <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-xs">
          {breakdown.map((row) => (
            <React.Fragment key={row.label}>
              <dt className="min-w-0 truncate text-muted-foreground" title={row.title}>
                {row.label}
              </dt>
              <dd className="font-medium tabular-nums text-foreground">{row.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null;

    const inner = (
      <>
        {/* The corner overlay sits at the TOP-RIGHT, so only this row reserves space for
            it — exactly its width: (?) 24px + ↗ 12px, or one of them. Reserving it on the
            whole trigger instead cost every sub-line ~40px and ellipsized load-bearing
            captions such as the degraded open-stock line; reserving it on the numeral row
            cost the number its size. */}
        <div className={cn('flex items-start justify-between gap-3', overlayReserve)}>
          <span
            className={cn(
              'inline-flex items-center gap-1',
              hero
                ? // A quiet label ABOVE the number, in the case it was written: tracked
                  // capitals at 11px read as decoration and outweighed the data they named.
                  // 13px on a comfortable (page-heading) strip, 12px on a compact one.
                  cn(comfortable ? 'text-sm' : 'text-xs', 'font-medium text-muted-foreground')
                : cn(
                    'font-semibold uppercase tracking-wide',
                    strip ? 'text-2xs text-muted-foreground' : 'text-xs text-muted-foreground',
                  ),
            )}
          >
            {/* No icon on a hero tile: six coloured glyphs carried no information the label
                did not, and they were the loudest marks in the row after the numbers. */}
            {Icon && strip && !hero ? (
              <Icon className={cn('h-3.5 w-3.5 shrink-0', ACCENT_TEXT[accent])} aria-hidden />
            ) : null}
            {label}
            {helpIsSibling ? null : helpNode}
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
        {/* NO corner gutter here, deliberately: the numeral row keeps its whole width, and
            the corner cluster lives in the label row's corner, which reserves it.

            On a HERO tile the cluster is centred on the label's first line and ends above
            this row at every density (compact y 4→28, the row starts at ≥28), so a long
            value can never run under it. On a non-hero tile it spans y 8→32; the scale
            context sits on its own line below this row, and a `delta` chip wraps under the
            numeral when the row is short of width. The chat `kpi_group` passes deltas on
            compact tiles but never `help`, so it has no overlay. Re-measure before
            combining the two. */}
        <div
          className={cn(
            // `flex-wrap`: the numeral takes the whole first line when it needs it, and a
            // delta chip drops UNDER it instead of squeezing it.
            'flex min-w-0 flex-wrap items-end gap-x-2 gap-y-1',
            // The fluid rungs are `cqi` clamps: the ROW is their size container, so the
            // numeral is sized from exactly the width it has to fit.
            fluid && '@container',
            strip ? (compact ? 'mt-1' : 'mt-2') : 'mt-3',
            // …and the layout half: with the trigger a full-height flex column, `mt-auto`
            // drops this row to the bottom of every cell, so the numerals share a baseline
            // no matter how far the label above them wrapped.
            hero && 'mt-auto',
          )}
        >
          <span
            ref={numeralRef}
            className={cn(
              // Tracking comes from the size step (Inter's curve), so no `tracking-*` here.
              'font-semibold leading-none tabular-nums',
              // A numeral NEVER truncates and is NEVER broken inside its digits (Round 12).
              // An ellipsis turned "19" into "1…", and an `overflow-wrap: break-word`
              // split "≥77,777" into "≥77,77" over "7": both plausible wrong numbers.
              // `break-normal` (also overriding any inherited `break-words`) leaves a
              // grouped integer unbreakable (UAX #14), so a value that does not fit
              // OVERFLOWS — and the fit guard measures exactly that and steps the size
              // down (then abbreviates) until it fits. Only a value with a real space
              // ("2h 14m") may still take a second line, and only after the smallest step.
              'min-w-0 max-w-full break-normal',
              sizeClass,
              hero
                ? // HERO numerals are ink, and colour is a FLAG: only a critical tile that
                  // actually counts something turns red. A green "resolved" or a red zero
                  // would be colour saying nothing the number does not.
                  accent === 'critical' && typeof countTo === 'number' && countTo > 0
                  ? ACCENT_TEXT.critical
                  : 'text-foreground'
                : strip && (accent === 'critical' || accent === 'success')
                  ? ACCENT_TEXT[accent]
                  : 'text-foreground',
            )}
            // WITHHELD arm of the bound grammar: there is no numeral to prefix, so the
            // em dash itself is the mark. The exact sentence is still announced by the
            // `sr-only` sibling below — `title` is the mouse affordance, never the only one.
            data-bound={bound ? (boundIsFloor ? 'floor' : 'withheld') : undefined}
            title={bound && !boundIsFloor ? bound : heroCompact ? heroText : undefined}
          >
            {boundIsFloor ? (
              <span aria-hidden className="mr-0.5" data-testid={`${kpiTestId}-bound`}>
                {BOUND_MARK}
              </span>
            ) : null}
            {/* An abbreviated numeral is hidden from assistive tech and replaced by the
                EXACT value below, so "5.4k" is a display decision and never a loss of
                precision for a screen-reader user. */}
            {heroCompact ? <span aria-hidden>{valueNode}</span> : valueNode}
          </span>
          {heroCompact ? <span className="sr-only">{heroText}</span> : null}
          {bound && !boundShownInLine ? <span className="sr-only">{bound}</span> : null}
          {deltaNode}
        </div>
        {secondaryNode}
        {sparkNode}
        {hero ? (
          heroLine ? (
            <span
              // One line, ellipsized, with the full text reachable: as the trigger's text
              // content it is part of the button's accessible name, and `title` serves the
              // mouse. `tabular-nums` so "18% of 43 cases" does not jitter on a live tick.
              className={cn(
                'mt-1.5 block min-w-0 truncate tabular-nums text-muted-foreground',
                comfortable ? 'text-sm' : 'text-xs',
              )}
              title={heroLine}
              // A data attribute, not a `kpi-*` test id: the strip's specs count every
              // `kpi-*` id inside it to pin the cell count at exactly six.
              data-kpi-line={sub ? 'state' : boundShownInLine ? 'bound' : 'context'}
            >
              {heroLine}
            </span>
          ) : null
        ) : sub ? (
          <span
            className={cn(
              'block text-muted-foreground',
              strip
                ? compact
                  ? // TWO lines on the compact strip. MEASURED: the strip's captions carry a
                    // qualifier as well as a subject ("Window arrivals · policy-closed
                    // included"), and at one line that clamped on every desktop below
                    // 1920px — the widths this console is actually used at. The tile has
                    // the room: the space under the caption was empty. Two lines is the
                    // ceiling, so a caption still cannot push the strip's rhythm around.
                    //
                    // 12px sans, like every caption (ui-standard "Typography": 11px is for
                    // badges, axis ticks and timestamps only; mono only for identifiers,
                    // and these are words — "exact rates", "awaiting analyst review").
                    'mt-1 line-clamp-2 text-xs'
                  : 'mt-1 truncate text-xs'
                : 'mt-2 text-xs',
              // The 4rem gutter exists ONLY to clear the absolutely-positioned strip
              // spark (bottom-4 right-4, w-14). Reserving it unconditionally cost every
              // strip caption ~10 characters of permanently empty space on the tiles
              // that pass no series, so it is tied to the spark actually rendering.
              strip && !compact && sparkNode ? 'pr-16' : null,
            )}
          >
            {sub}
          </span>
        ) : null}
      </>
    );

    /**
     * The partition is rendered OUTSIDE the trigger on a clickable tile (see the
     * `breakdown` prop doc): ARIA discards list semantics inside a button. When that
     * happens the tile becomes wrapper > (button + dl), so the wrapper owns the cell
     * height and the button drops its own bottom padding onto the sibling.
     */
    const breakdownIsSibling = clickable && breakdownNode !== null;
    /**
     * Does this tile need a CELL ROOT — a wrapper that is the grid cell, with the trigger
     * inside it? Yes whenever something must render beside the trigger rather than within
     * it: the partition (ARIA discards list semantics inside a button) or the corner
     * overlay (a button inside a button is invalid DOM). The cell root then owns the cell's
     * height and card chrome, so a wrapped tile never draws two borders or stacks the
     * partition's height on top of the tile floor.
     */
    const needsCellRoot = breakdownIsSibling || cellOverlay !== null;
    // `padX`/`padBottom` are read ONLY by the breakdown sibling below, so they are inert
    // until something passes `breakdown` again. The compact strip's live density is the
    // `px-3 py-2` on `base` plus the value row's `mt-1`; these two are kept in step with
    // it so the partition path does not come back with a mismatched rhythm.
    const padX = strip ? (compact ? 'px-3' : comfortable ? 'px-3 xl:px-4 2xl:px-5' : 'px-4') : 'px-4';
    const padBottom = strip ? (compact ? 'pb-2' : comfortable ? 'pb-3 2xl:pb-4' : 'pb-5') : 'pb-4';
    // The cell's minimum height belongs to whichever element IS the cell root, so a
    // wrapped tile does not add the partition's height on top of the tile floor.
    const minH = strip ? (compact || comfortable ? 'min-h-0' : 'min-h-28') : null;
    /** Card chrome (default variant only). It follows the CELL ROOT, so a wrapped tile
     *  keeps its border/background around the partition instead of leaving it outside. */
    const chrome = strip ? null : 'rounded-lg border border-border bg-card';
    const base = cn(
      'relative min-w-0 overflow-hidden text-left',
      needsCellRoot ? null : 'h-full',
      needsCellRoot ? null : minH,
      needsCellRoot ? null : chrome,
      breakdownIsSibling && !strip && 'rounded-t-lg',
      strip
        ? compact
          ? 'bg-transparent px-3 py-2'
          : comfortable
            ? // Between compact and default: ~120px with a fluid numeral. Dense inside,
              // generous between — the strip's neighbours supply the gutters.
              'bg-transparent px-3 py-3 xl:px-4 2xl:px-5 2xl:py-4'
            : 'bg-transparent px-4 py-5'
        : 'p-4',
      // The sibling below carries the tile's bottom padding instead.
      breakdownIsSibling && 'pb-0',
      bar && !strip && 'pl-5',
    );

    const barEdge = bar ? (
      <span className={cn('absolute inset-y-0 left-0 w-0.5', ACCENT_BAR[accent])} aria-hidden />
    ) : null;

    if (clickable) {
      const trigger = (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={onClick}
          aria-haspopup={ariaHasPopup}
          data-testid={kpiTestId}
          className={cn(
            base,
            'block w-full transition-colors hover:bg-accent/30',
            /*
             * HERO tiles BOTTOM-ALIGN their numeral, and this is the structural half of it.
             *
             * MEASURED in a browser at a 1280px viewport, six cells: the labels wrap to one,
             * two and even three lines ("False Positive Rate"), which put the six numerals at
             * y = 26 / 40 / 26 / 54 / 40 / 26 — a 28px stagger across a row the eye reads as
             * one instrument. Reserving a fixed label height would have to reserve the WORST
             * case on every tile and would still break on a longer label or another locale.
             * Growing the labels upward from a common numeral baseline is length-independent,
             * and it is what the row wanted anyway: the number is the thing being compared.
             */
            hero && 'flex h-full flex-col',
            !strip && !breakdownIsSibling && 'hover:border-primary/40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            needsCellRoot ? null : className,
          )}
        >
          {barEdge}
          {inner}
        </button>
      );
      if (!needsCellRoot) return trigger;
      // The <dl> sits BESIDE the trigger, inside the same cell: still visually part of
      // the tile, but a real definition list to assistive tech, and out of the
      // trigger's accessible name. The testid stays on the button — it IS the tile's
      // interactive identity — and the partition gets its own suffixed anchor.
      return (
        <div
          className={cn(
            'relative flex h-full min-w-0 flex-col overflow-hidden',
            // The named group the hero overlay reveals itself on (hover or focus anywhere
            // in the cell, including the help button that sits beside the trigger).
            hero && 'group/kpi',
            minH,
            chrome,
            className,
          )}
        >
          {trigger}
          {cellOverlay}
          {breakdownIsSibling ? (
            <div
              data-testid={`${kpiTestId}-breakdown`}
              className={cn('min-w-0', padX, padBottom, strip ? 'bg-transparent' : null)}
            >
              {breakdownNode}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div ref={ref as React.Ref<HTMLDivElement>} data-testid={kpiTestId} className={cn(base, className)}>
        {barEdge}
        {inner}
        {breakdownNode}
      </div>
    );
  },
);
KpiTile.displayName = 'KpiTile';

export interface KpiTileGridProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many tiles the grid holds — it decides the column count (`kpiGridColumns`). */
  count: number;
  /**
   * `true` (default) draws the closed outer frame; `false` keeps only the inner
   * hairlines, for a grid that already sits inside a framed card (no double frame).
   */
  framed?: boolean;
  /** Classes for the outer `@container` wrapper (the `className` lands on the grid). */
  containerClassName?: string;
}

/**
 * A container-query grid of KPI tiles that never leaves an empty track.
 *
 * - Columns follow the tile COUNT (`kpiGridColumns`), balanced as the container narrows.
 * - One hairline grammar at every column count: each cell draws its own bottom and
 *   right rule, the grid overhangs its clip by 1px on those two sides, so the outermost
 *   rules disappear under the frame and a ragged last row still reads as one closed box.
 * - Rows stretch, so tiles in a row share one height (KpiTile fills its cell).
 *
 * Pass `role="list"` (and give each child `role="listitem"`) when the tiles are a list.
 */
export const KpiTileGrid = React.forwardRef<HTMLDivElement, KpiTileGridProps>(
  function KpiTileGrid({ count, framed = true, containerClassName, className, children, ...rest }, ref) {
    return (
      <div className={cn('@container min-w-0', containerClassName)} data-kpi-grid-count={count}>
        <div
          className={cn('overflow-hidden', framed && 'rounded-md border border-border/70')}
          // A data attribute, NOT a `kpi-*` test id: strip specs count every `kpi-*` id
          // inside a strip to pin its cell count.
          data-kpi-grid-frame={framed ? 'framed' : 'bare'}
        >
          <div
            ref={ref}
            className={cn(
              '-mb-px -mr-px grid items-stretch',
              kpiGridColumns(count),
              '[&>*]:border-b [&>*]:border-r [&>*]:border-border/70',
              className,
            )}
            {...rest}
          >
            {children}
          </div>
        </div>
      </div>
    );
  },
);

export default KpiTile;
