/**
 * CloseAttributionChart — the Human vs AI card's per-bucket stacked columns.
 *
 * One column per case-ARRIVAL bucket, stacked by who closed that cohort: the AI agent on
 * the baseline (the featured closer, so it is the one segment that compares exactly
 * across buckets), Human above it, and the System residual as a neutral cap. Each closed
 * case has exactly one last decider, so the stack height is a true total.
 *
 * Hand-built SVG rather than recharts, on purpose:
 *   - a recharts stack coerces `null` to 0 (`+getValueByDataKey(d, key, 0)`), which would
 *     draw an unmeasured bucket as a confident zero. Here a bucket with any band missing
 *     is drawn as a hatched "not measured" band and says so in its tooltip.
 *   - the marks need exact geometry: ⅔-slot bars capped at 20px, a 1px surface gap
 *     BETWEEN stacked segments (an inset — the upper segment gives up the pixel — never a
 *     stroke), a 2px radius on the top corners of the topmost non-zero segment only, and a
 *     2px floor so a single human close stays visible.
 *   - the whole slot is the hit target, the tooltip is anchored to the column rather than
 *     the cursor, and the plot is ONE tab stop with ←/→/Home/End/Esc — none of which a
 *     recharts tooltip offers.
 *
 * Honesty contract (shared with HumanVsAiCard):
 *   - `null` is never 0. Unmeasured buckets are hatched; whole-window zero is said in
 *     words; the newest (still filling) bucket is drawn at reduced opacity and its tooltip
 *     says "In progress".
 *   - The tooltip never derives `new_cases − closed`: policy-closed cases are counted in
 *     arrivals but excluded from `closed`, so the difference is not "still open".
 *   - Alerts ingested is a DIFFERENT population (an ingest tally) and is labelled so.
 *   - While `stale` (the card's totals belong to the previous window) every numeral is
 *     withheld: no axis numbers, no tooltip, no data table — the marks stay, dimmed, so
 *     the frame does not jump.
 *
 * Security (#9): every label is a local constant or a formatted number, rendered as
 * plain SVG/DOM text, never HTML.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';
import { DASH, fmtNumber } from '@/lib/format';
import { token } from './palette';
import type { HumanVsAiPoint } from './HumanVsAiCard';

/** One stacked band: key into the point, plain-text name, and its mark colour. */
export interface CloseAttributionBand {
  key: 'ai' | 'human' | 'system';
  label: string;
  color: string;
}

/**
 * Split `parts` into whole percentages of `total` that sum to EXACTLY 100 (largest
 * remainder), or `null` when the split cannot be trusted.
 *
 * Returns null unless every part is a finite non-negative number, `total` is a
 * positive finite number, AND the parts sum to `total` — i.e. the partition actually
 * reconciles. A set of shares that does not reconcile must render as em dashes, not
 * as three numbers massaged up to 100%.
 */
export function reconcilingShares(parts: number[], total: number): number[] | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!parts.length) return null;
  if (parts.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0)) return null;
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum !== total) return null;
  const exact = parts.map((p) => (p / total) * 100);
  const out = exact.map((v) => Math.floor(v));
  let remainder = 100 - out.reduce((a, b) => a + b, 0);
  const byFraction = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byFraction.length && remainder > 0; k += 1) {
    out[byFraction[k].i] += 1;
    remainder -= 1;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Time labels — UTC, deterministic (no locale/ICU dependence).               */
/* ------------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function utcDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function utcHm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * The full UTC range of one bucket, e.g. "Oct 5, 14:00–15:00 UTC". A bucket that ends at
 * the following midnight reads "18:00–24:00" so it stays on its own day. Without a parseable
 * start the caller's short (UTC) axis label is the honest fallback.
 */
export function bucketRangeLabel(point: Pick<HumanVsAiPoint, 'x' | 'start' | 'end'>): string {
  const s = parseMs(point.start);
  if (s == null) return `${point.x} UTC`;
  const e = parseMs(point.end);
  if (e == null || e <= s) return `${utcDay(s)}, ${utcHm(s)} UTC`;
  if (utcDay(s) === utcDay(e - 1)) {
    const endHm = e % DAY_MS === 0 ? '24:00' : utcHm(e);
    return `${utcDay(s)}, ${utcHm(s)}–${endHm} UTC`;
  }
  return `${utcDay(s)}, ${utcHm(s)} – ${utcDay(e)}, ${utcHm(e)} UTC`;
}

/* ------------------------------------------------------------------------- */
/* Per-bucket reading — the one place a point becomes numbers.                */
/* ------------------------------------------------------------------------- */

interface BucketReading {
  /** All three bands are finite: the partition was measured for this bucket. */
  measured: boolean;
  /** Band values in BAND order (baseline → top); null where unmeasured. */
  values: Array<number | null>;
  /** Closed total: the payload's `closed` when finite, else the band sum. */
  closed: number | null;
  /** Per-band shares of `closed` (whole %, reconciling) or null. */
  shares: number[] | null;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function readBucket(point: HumanVsAiPoint, bands: readonly CloseAttributionBand[]): BucketReading {
  const values = bands.map((b) => {
    const v = point[b.key];
    return finite(v) && v >= 0 ? v : null;
  });
  const measured = values.every((v) => v != null);
  const sum = measured ? (values as number[]).reduce((a, b) => a + b, 0) : null;
  const closed = finite(point.closed) ? point.closed : sum;
  const shares =
    measured && closed != null ? reconcilingShares(values as number[], closed) : null;
  return { measured, values, closed, shares };
}

function fmtPercent(v: number): string {
  if (v > 0 && v < 1) return '<1%';
  return `${Math.round(v)}%`;
}

/* ------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * jsdom has no layout engine and reports 0×0; a real browser measures the cell. The
 * fallback is a plausible narrow-column size so tests get real geometry, and it is
 * used silently — no warning, so `npm run test:strict` stays clean.
 */
const FALLBACK_WIDTH = 480;
const FALLBACK_HEIGHT = 180;
const BAR_MAX = 20;
const SEGMENT_MIN = 2;
const SEGMENT_GAP = 1;
const TOP_RADIUS = 2;
/**
 * The still-filling bucket keeps its colours, lighter. 0.6 (not 0.5) is the lowest
 * opacity at which the agent blue still clears 3:1 against the surface in both themes.
 */
const IN_PROGRESS_OPACITY = 0.6;
const PAD_TOP = 8;
const X_AXIS_HEIGHT = 20;
/** Approximate advance of one 11px tabular figure/punctuation glyph. */
const CHAR_W = 6.6;
const Y_LABEL_GAP = 8;
const LABEL_INTERVALS_H = [1, 2, 3, 4, 6, 12, 24, 48, 72, 168, 336, 720];

/** The smallest "clean" integer step s with 2s >= raw-max (ticks 0, s, 2s). */
function niceStep(max: number): number {
  const raw = max / 2;
  if (raw <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const s = m * pow;
    if (Number.isInteger(s) && s >= raw) return s;
  }
  return 10 * pow;
}

/** Indices of the buckets that get an x label: regular UTC intervals that fit. */
function pickXLabels(points: readonly HumanVsAiPoint[], plotWidth: number): number[] {
  const n = points.length;
  if (!n) return [];
  const longest = Math.max(...points.map((p) => p.x.length));
  const labelWidth = longest * CHAR_W + 14;
  // At most five: a 24h window then reads every 6h (00, 06, 12, 18), not every 4h.
  const maxLabels = Math.max(1, Math.min(5, Math.floor(plotWidth / labelWidth)));
  const starts = points.map((p) => parseMs(p.start));
  if (n > 1 && starts.every((s) => s != null)) {
    const ms = starts as number[];
    let bucketMs = Infinity;
    for (let i = 1; i < ms.length; i += 1) {
      const d = ms[i] - ms[i - 1];
      if (d > 0) bucketMs = Math.min(bucketMs, d);
    }
    if (Number.isFinite(bucketMs)) {
      for (const h of LABEL_INTERVALS_H) {
        const iv = h * HOUR_MS;
        if (iv < bucketMs || iv % bucketMs !== 0) continue;
        const idx = ms.flatMap((s, i) => (s % iv === 0 ? [i] : []));
        if (idx.length && idx.length <= maxLabels) return idx;
      }
    }
  }
  const step = Math.ceil(n / maxLabels);
  return Array.from({ length: Math.ceil(n / step) }, (_, k) => k * step);
}

interface Segment {
  key: CloseAttributionBand['key'];
  color: string;
  value: number;
  y: number;
  h: number;
  top: boolean;
}

interface Slot {
  index: number;
  left: number;
  width: number;
  barX: number;
  barW: number;
  state: 'measured' | 'zero' | 'unmeasured';
  segments: Segment[];
}

interface Geometry {
  width: number;
  height: number;
  x0: number;
  plotTop: number;
  baseline: number;
  slot: number;
  yMax: number | null;
  ticks: Array<{ value: number; y: number }>;
  slots: Slot[];
  xLabels: Array<{ index: number; x: number; text: string }>;
  allZero: boolean;
}

/**
 * Stack one bucket's measured values from the baseline. Each value's TOP edge is placed
 * from the cumulative total, so the stack height stays true; the 1px gap is taken out of
 * the upper segment (an inset), and a non-zero segment never paints under 2px.
 */
function stack(
  values: number[],
  bands: readonly CloseAttributionBand[],
  baseline: number,
  scale: number,
): Segment[] {
  const out: Segment[] = [];
  let cum = 0;
  let cursor = baseline;
  values.forEach((v, k) => {
    if (v <= 0) return;
    cum += v;
    const bottom = out.length ? cursor - SEGMENT_GAP : cursor;
    const top = Math.min(Math.round(baseline - cum * scale), bottom - SEGMENT_MIN);
    out.push({ key: bands[k].key, color: bands[k].color, value: v, y: top, h: bottom - top, top: false });
    cursor = top;
  });
  if (out.length) out[out.length - 1].top = true;
  return out;
}

function buildGeometry(
  points: readonly HumanVsAiPoint[],
  bands: readonly CloseAttributionBand[],
  width: number,
  height: number,
): Geometry {
  const readings = points.map((p) => readBucket(p, bands));
  const totals = readings.map((r) =>
    r.measured ? (r.values as number[]).reduce((a, b) => a + b, 0) : null,
  );
  const measuredTotals = totals.filter((t): t is number => t != null);
  const maxTotal = measuredTotals.length ? Math.max(...measuredTotals) : 0;
  // "Nothing closed in this window" is a claim about EVERY bucket, so it needs every
  // bucket measured. Zeros beside a hatched unmeasured bucket are not an empty window:
  // missing evidence is never read as zero.
  const allZero = totals.length > 0 && totals.every((t) => t === 0);
  const step = maxTotal > 0 ? niceStep(maxTotal) : null;
  const yMax = step != null ? step * 2 : null;

  const tickValues = step != null ? [0, step, step * 2] : [];
  const gutterChars = tickValues.length ? String(tickValues[tickValues.length - 1]).length : 0;
  const x0 = tickValues.length ? Math.ceil(gutterChars * CHAR_W) + Y_LABEL_GAP : 0;
  const plotTop = PAD_TOP;
  const baseline = Math.max(plotTop + 24, Math.round(height - X_AXIS_HEIGHT));
  const plotHeight = baseline - plotTop;
  const plotWidth = Math.max(1, width - x0);
  const n = Math.max(1, points.length);
  const slot = plotWidth / n;
  const barW = Math.max(1, Math.min(BAR_MAX, Math.round((slot * 2) / 3)));
  const scale = yMax ? plotHeight / yMax : 0;

  const ticks = tickValues.map((value) => ({
    value,
    y: Math.round(baseline - value * scale),
  }));

  const slots: Slot[] = points.map((_, i) => {
    const left = x0 + i * slot;
    const r = readings[i];
    const total = totals[i];
    const state: Slot['state'] = !r.measured ? 'unmeasured' : total ? 'measured' : 'zero';
    return {
      index: i,
      left,
      width: slot,
      barX: Math.round(left + (slot - barW) / 2),
      barW,
      state,
      segments: state === 'measured' ? stack(r.values as number[], bands, baseline, scale) : [],
    };
  });

  // Labels centred on their slot, clamped inside the figure, and dropped (never
  // overlapped) if a clamp pushes one into its neighbour.
  const xLabels: Geometry['xLabels'] = [];
  let lastRight = -Infinity;
  for (const index of pickXLabels(points, plotWidth)) {
    const text = points[index].x;
    const w = text.length * CHAR_W;
    const centre = Math.min(Math.max(x0 + (index + 0.5) * slot, w / 2), width - w / 2);
    if (centre - w / 2 < lastRight + 6) continue;
    xLabels.push({ index, x: Math.round(centre), text });
    lastRight = centre + w / 2;
  }

  return { width, height, x0, plotTop, baseline, slot, yMax, ticks, slots, xLabels, allZero };
}

/** The top segment's path: square at the bottom, 2px radius on its two top corners. */
function roundedTopPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(TOP_RADIUS, w / 2, h);
  return (
    `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}` +
    `H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`
  );
}

/* ------------------------------------------------------------------------- */
/* Tooltip                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * One same-bucket context row: the value leads, the label follows. When the value is
 * missing, the REASON sits on its own line under the label (never wrapped mid-phrase).
 */
function contextRow(value: number | null | undefined, format: (v: number) => string, label: string, reasonWhenNull: string, testid: string) {
  const known = finite(value);
  return (
    <React.Fragment key={testid}>
      <span aria-hidden />
      <span
        className="self-start text-right font-medium tabular-nums text-foreground"
        data-testid={`${testid}-value`}
      >
        {known ? format(value) : DASH}
      </span>
      <span className="col-span-2 text-muted-foreground" data-testid={`${testid}-label`}>
        {label}
        {known ? null : (
          <span className="block" data-testid={`${testid}-reason`}>
            {value === undefined ? 'not reported' : reasonWhenNull}
          </span>
        )}
      </span>
    </React.Fragment>
  );
}

interface BucketTooltipBodyProps {
  point: HumanVsAiPoint;
  bands: readonly CloseAttributionBand[];
  truncated: boolean;
}

/**
 * Tooltip content, in reading order: the bucket's full UTC range (+ "In progress"), the
 * closed total, one row per closer TOP→BOTTOM in stack order (zero rows included so the
 * structure never jumps), a hairline, then same-bucket context. Values lead; labels follow.
 */
function BucketTooltipBody({ point, bands, truncated }: BucketTooltipBodyProps) {
  const r = readBucket(point, bands);
  const rows = bands.map((b, k) => ({ band: b, value: r.values[k], share: r.shares?.[k] })).reverse();


  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-foreground" data-testid="human-vs-ai-tooltip-range">
          {bucketRangeLabel(point)}
        </p>
        {point.inProgress ? (
          <p className="shrink-0 text-muted-foreground" data-testid="human-vs-ai-tooltip-progress">
            In progress
          </p>
        ) : null}
      </div>
      <div className="mt-1.5 grid grid-cols-[0.5rem_auto_1fr_auto] items-center gap-x-2 gap-y-1">
        <span aria-hidden />
        <span
          className="text-right font-semibold tabular-nums text-foreground"
          data-testid="human-vs-ai-tooltip-closed-value"
        >
          {r.measured && r.closed != null ? fmtNumber(r.closed) : DASH}
        </span>
        <span className="col-span-2 font-medium text-foreground" data-testid="human-vs-ai-tooltip-closed-label">
          {r.measured ? 'closed' : 'closed, not measured'}
        </span>
        {rows.map(({ band, value, share }) => (
          <React.Fragment key={band.key}>
            <span
              className="h-2 w-2 rounded-[1px]"
              style={{ backgroundColor: band.color }}
              aria-hidden
            />
            <span
              className="text-right tabular-nums text-foreground"
              data-testid={`human-vs-ai-tooltip-${band.key}-value`}
            >
              {value == null ? DASH : fmtNumber(value)}
            </span>
            <span className="text-muted-foreground">{band.label}</span>
            <span
              className="text-right tabular-nums text-muted-foreground"
              data-testid={`human-vs-ai-tooltip-${band.key}-share`}
            >
              {share == null ? '' : `${share}%`}
            </span>
          </React.Fragment>
        ))}
        <span className="col-span-4 my-1 h-px bg-border" aria-hidden />
        {contextRow(
          point.newCases,
          fmtNumber,
          'arrived, incl. policy-closed',
          'not reported',
          'human-vs-ai-tooltip-arrived',
        )}
        {contextRow(point.sentToHuman, fmtNumber, 'sent to human', 'not reported', 'human-vs-ai-tooltip-sent')}
        {contextRow(
          point.fpRate,
          fmtPercent,
          'false positive rate',
          'no verdicted case',
          'human-vs-ai-tooltip-fp',
        )}
        {contextRow(
          point.alerts,
          fmtNumber,
          'alerts ingested (not cases)',
          'not recorded',
          'human-vs-ai-tooltip-alerts',
        )}
      </div>
      {truncated ? (
        <p className="mt-2 border-t border-border pt-1.5 text-muted-foreground" data-testid="human-vs-ai-tooltip-bound">
          Counts are lower bounds: the case scan for this window was bounded.
        </p>
      ) : null}
    </>
  );
}

/** One-line screen-reader summary of a bucket (the live region's text). */
function bucketSummary(point: HumanVsAiPoint, bands: readonly CloseAttributionBand[]): string {
  const r = readBucket(point, bands);
  const head = `${bucketRangeLabel(point)}${point.inProgress ? ', in progress' : ''}`;
  if (!r.measured) return `${head}: close attribution not measured.`;
  const parts = bands.map((b, k) => `${b.label} ${r.values[k]}`).join(', ');
  return `${head}: ${r.closed ?? 0} closed. ${parts}.`;
}

/* ------------------------------------------------------------------------- */
/* The chart                                                                  */
/* ------------------------------------------------------------------------- */

export interface CloseAttributionChartProps {
  points: readonly HumanVsAiPoint[];
  /** Bands in STACK order, baseline first. */
  bands: readonly CloseAttributionBand[];
  /** Accessible name of the figure. */
  ariaLabel: string;
  /** The window's case scan was bounded: every count is a lower bound. */
  truncated?: boolean;
  /** The card's totals are the previous window's: withhold every numeral. */
  stale?: boolean;
  className?: string;
}

export function CloseAttributionChart({
  points,
  bands,
  ariaLabel,
  truncated = false,
  stale = false,
  className,
}: CloseAttributionChartProps) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const tipRef = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      if (width > 0 && height > 0) {
        setSize((cur) => (cur && cur.width === width && cur.height === height ? cur : { width, height }));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const width = size?.width ?? FALLBACK_WIDTH;
  const height = size?.height ?? FALLBACK_HEIGHT;
  const interactive = !stale && points.length > 0;
  const geo = React.useMemo(
    () => buildGeometry(points, bands, width, height),
    [points, bands, width, height],
  );

  const rawId = React.useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const hatchId = `hva-hatch-${uid}`;
  const gridMaskId = `hva-grid-mask-${uid}`;
  const instructionsId = `hva-instructions-${uid}`;

  /* ---- interaction state ---- */
  const [active, setActive] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState(false);
  const [focusRing, setFocusRing] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState('');
  const [tipPos, setTipPos] = React.useState<{ left: number; top: number } | null>(null);
  const pointerDown = React.useRef(false);
  const hideTimer = React.useRef<number | null>(null);
  /** Esc dismissed the tooltip for this slot; it stays hidden until the target changes. */
  const dismissedFor = React.useRef<number | null>(null);

  const n = points.length;
  const activeIndex = active != null && active < n ? active : null;

  const cancelHide = React.useCallback(() => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);
  const scheduleHide = React.useCallback(() => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setOpen(false);
    }, 160);
  }, [cancelHide]);
  React.useEffect(() => cancelHide, [cancelHide]);

  const showAt = React.useCallback(
    (index: number, announce: boolean) => {
      cancelHide();
      setActive(index);
      setOpen(true);
      if (announce && points[index]) setAnnouncement(bucketSummary(points[index], bands));
    },
    [bands, cancelHide, points],
  );

  const slotAt = (clientX: number): number | null => {
    const el = boxRef.current;
    if (!el || !n) return null;
    const x = clientX - el.getBoundingClientRect().left;
    if (x < geo.x0) return null;
    const i = Math.floor((x - geo.x0) / geo.slot);
    return i >= 0 && i < n ? i : null;
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!interactive) return;
    const i = slotAt(e.clientX);
    if (i == null) {
      scheduleHide();
      return;
    }
    if (dismissedFor.current === i) return;
    dismissedFor.current = null;
    if (i !== activeIndex || !open) showAt(i, false);
    else cancelHide();
  };
  const onMouseLeave = () => {
    dismissedFor.current = null;
    if (!focusRing) scheduleHide();
  };

  const onFocus = () => {
    const fromPointer = pointerDown.current;
    pointerDown.current = false;
    if (!interactive || fromPointer) return; // a click: hover already owns the tooltip
    setFocusRing(true);
    showAt(activeIndex ?? n - 1, true);
  };
  const onBlur = () => {
    setFocusRing(false);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    let next: number | null = null;
    const from = activeIndex ?? n - 1;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, from + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, from - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        dismissedFor.current = from;
      }
      return;
    }
    if (next == null) return;
    e.preventDefault();
    setFocusRing(true);
    dismissedFor.current = null;
    showAt(next, true);
  };

  // Esc anywhere dismisses a HOVER tooltip too (WCAG 1.4.13), and a tap outside the
  // figure or the tooltip closes it on touch.
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      dismissedFor.current = activeIndex;
    };
    const onDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (boxRef.current?.contains(t) || tipRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, activeIndex]);

  const tooltipShown = interactive && open && activeIndex != null;

  // Anchor the tooltip BESIDE the column, its top on the plot's top edge: on the right of
  // a column in the left half of the plot, on the left of one in the right half. It used
  // to sit 8px ABOVE the plot, which on the Overview put it over the card's own title and
  // legend and across the KPI strip, so hovering one column covered the numbers it was
  // being read against. Beside the column it stays inside the card, and it starts flush
  // with the hovered slot's edge, so the pointer moves from the column straight into it
  // without crossing a neighbouring slot. Clamped to the viewport on every side.
  React.useLayoutEffect(() => {
    if (!tooltipShown || activeIndex == null) return undefined;
    const place = () => {
      const box = boxRef.current;
      const tip = tipRef.current;
      if (!box || !tip) return;
      const r = box.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const slotLeft = r.left + geo.x0 + activeIndex * geo.slot;
      const slotRight = slotLeft + geo.slot;
      const plotMid = r.left + geo.x0 + (points.length * geo.slot) / 2;
      const preferRight = slotLeft + geo.slot / 2 <= plotMid;
      const fitsRight = slotRight + tw <= vw - 8;
      const fitsLeft = slotLeft - tw >= 8;
      const onRight = preferRight ? fitsRight || !fitsLeft : !fitsLeft && fitsRight;
      const rawLeft = onRight ? slotRight : slotLeft - tw;
      const left = Math.round(Math.max(8, Math.min(rawLeft, vw - 8 - tw)));
      const top = Math.round(Math.max(8, Math.min(r.top + geo.plotTop, vh - 8 - th)));
      setTipPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [tooltipShown, activeIndex, geo, points.length]);

  const activePoint = activeIndex != null ? points[activeIndex] : null;
  const activeSlot = activeIndex != null ? geo.slots[activeIndex] : null;

  const mutedText = token('muted-foreground');
  const showRing = focusRing && interactive && activeSlot != null;
  const markOpacity = stale ? 0.35 : 1;

  /* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions --
     The figure is ONE tab stop (Chartability: never a stop per mark) that the arrow keys
     drive; its role is a labelled `group` because `img` would make the live region and
     the keyboard behaviour presentational. Its instructions are in aria-describedby and
     each move is announced through the polite live region below. */
  return (
    <>
      <div
        ref={boxRef}
        role="group"
        aria-label={ariaLabel}
        aria-describedby={interactive ? instructionsId : undefined}
        aria-busy={stale || undefined}
        tabIndex={interactive ? 0 : undefined}
        data-testid="human-vs-ai-figure"
        className={cn('absolute inset-0 select-none outline-none', className)}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onMouseDown={() => {
          pointerDown.current = true;
          setFocusRing(false);
        }}
        onMouseUp={() => {
          pointerDown.current = false;
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {interactive ? (
          <p id={instructionsId} className="sr-only">
            Use the left and right arrow keys to read each bucket; Home and End jump to the
            first and last bucket. A table of every bucket follows the chart.
          </p>
        ) : null}
        <svg
          width={geo.width}
          height={geo.height}
          className="block overflow-visible"
          aria-hidden
          data-plot-top={geo.plotTop}
          data-baseline={geo.baseline}
          data-y-max={geo.yMax ?? undefined}
        >
          <defs>
            <pattern
              id={hatchId}
              width={6}
              height={6}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1={0} y1={0} x2={0} y2={6} stroke={token('muted-foreground', 0.3)} strokeWidth={1.5} />
            </pattern>
            {/* The in-progress column is translucent, so a gridline behind it would show
                THROUGH the bar. This mask cuts the gridlines out under that bar only —
                surface-agnostic, unlike painting an opaque underlay in a guessed colour. */}
            <mask id={gridMaskId} maskUnits="userSpaceOnUse" x={0} y={0} width={geo.width} height={geo.height}>
              <rect x={0} y={0} width={geo.width} height={geo.height} fill="white" />
              {geo.slots
                .filter((s) => points[s.index]?.inProgress && s.segments.length)
                .map((s) => {
                  const top = Math.min(...s.segments.map((seg) => seg.y));
                  return (
                    <rect
                      key={s.index}
                      x={s.barX}
                      y={top}
                      width={s.barW}
                      height={geo.baseline - top}
                      fill="black"
                    />
                  );
                })}
            </mask>
          </defs>

          {/* Gridlines: 1px SOLID hairlines at the clean ticks, behind every mark. Like
              the tick numerals, withheld while stale. */}
          <g mask={`url(#${gridMaskId})`}>
            {(stale ? [] : geo.ticks)
              .filter((t) => t.value > 0)
              .map((t) => (
                <rect
                  key={t.value}
                  x={geo.x0}
                  y={t.y}
                  width={Math.max(0, geo.width - geo.x0)}
                  height={1}
                  fill={token('border')}
                  data-testid="human-vs-ai-gridline"
                />
              ))}
          </g>

          {/* Hover/focus band: the whole slot, plot height. */}
          {tooltipShown && activeSlot ? (
            <rect
              x={Math.round(activeSlot.left)}
              y={geo.plotTop - 4}
              width={Math.max(1, Math.round(activeSlot.width))}
              height={geo.baseline - geo.plotTop + 4}
              fill={token('muted-foreground', 0.1)}
              data-testid="human-vs-ai-active-band"
            />
          ) : null}

          {geo.slots.map((s) => {
            const p = points[s.index];
            return (
              <g
                key={s.index}
                data-testid="human-vs-ai-slot"
                data-index={s.index}
                data-state={s.state}
                data-in-progress={p.inProgress ? 'true' : undefined}
                opacity={p.inProgress ? markOpacity * IN_PROGRESS_OPACITY : markOpacity}
              >
                {s.state === 'unmeasured' ? (
                  <rect
                    x={Math.round(s.left) + 1}
                    y={geo.plotTop}
                    width={Math.max(1, Math.round(s.width) - 2)}
                    height={geo.baseline - geo.plotTop}
                    fill={`url(#${hatchId})`}
                    data-testid="human-vs-ai-unmeasured"
                  />
                ) : null}
                {s.segments.map((seg) =>
                  seg.top ? (
                    <path
                      key={seg.key}
                      d={roundedTopPath(s.barX, seg.y, s.barW, seg.h)}
                      fill={seg.color}
                      data-segment={seg.key}
                      data-value={seg.value}
                      data-y={seg.y}
                      data-h={seg.h}
                    />
                  ) : (
                    <rect
                      key={seg.key}
                      x={s.barX}
                      y={seg.y}
                      width={s.barW}
                      height={seg.h}
                      fill={seg.color}
                      data-segment={seg.key}
                      data-value={seg.value}
                      data-y={seg.y}
                      data-h={seg.h}
                    />
                  ),
                )}
              </g>
            );
          })}

          {/* Baseline: 1px in the default border token, on top of the slot bands. */}
          <rect
            x={geo.x0}
            y={geo.baseline}
            width={Math.max(0, geo.width - geo.x0)}
            height={1}
            fill={token('border')}
            data-testid="human-vs-ai-baseline"
          />

          {/* Focus ring around the active slot (keyboard only). */}
          {showRing && activeSlot ? (
            <rect
              x={Math.round(activeSlot.left) + 1}
              y={geo.plotTop - 3}
              width={Math.max(2, Math.round(activeSlot.width) - 2)}
              height={geo.baseline - geo.plotTop + 5}
              rx={2}
              fill="none"
              stroke={token('ring')}
              strokeWidth={2}
              data-testid="human-vs-ai-focus-ring"
            />
          ) : null}

          {/* Y ticks: right-aligned in the gutter, centred on their line. */}
          {(stale ? [] : geo.ticks).map((t) => (
            <text
              key={t.value}
              x={geo.x0 - Y_LABEL_GAP}
              y={t.y}
              dy="0.32em"
              textAnchor="end"
              className="text-2xs tabular-nums"
              style={{ fill: mutedText }}
              data-testid="human-vs-ai-y-tick"
            >
              {t.value}
            </text>
          ))}

          {/* X labels: regular UTC intervals, horizontal, centred on the slot. */}
          {geo.xLabels.map((l) => (
            <text
              key={l.index}
              x={l.x}
              y={geo.baseline + 15}
              textAnchor="middle"
              className="text-2xs tabular-nums"
              style={{ fill: mutedText }}
              data-testid="human-vs-ai-x-tick"
            >
              {l.text}
            </text>
          ))}
        </svg>

        {geo.allZero && !stale ? (
          <p
            className="pointer-events-none absolute inset-x-0 text-center text-xs text-muted-foreground"
            style={{ top: Math.round((geo.plotTop + geo.baseline) / 2) - 8 }}
            data-testid="human-vs-ai-all-zero"
          >
            No cases closed in this window.
          </p>
        ) : null}

        {interactive ? (
          <p className="sr-only" aria-live="polite" data-testid="human-vs-ai-live">
            {announcement}
          </p>
        ) : null}
      </div>
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}

      {/* Visually hidden data table — every bucket, for screen readers. Withheld while
          stale, like every other numeral on the card. */}
      {interactive ? (
        <table className="sr-only" data-testid="human-vs-ai-table">
          <caption>Cases closed per case-arrival bucket, by last recorded decider (UTC)</caption>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Closed</th>
              {[...bands].reverse().map((b) => (
                <th key={b.key} scope="col">
                  {b.label}
                </th>
              ))}
              <th scope="col">Arrived, incl. policy-closed</th>
              <th scope="col">Sent to human</th>
              <th scope="col">False positive rate</th>
              <th scope="col">Alerts ingested (not cases)</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => {
              const r = readBucket(p, bands);
              const reversed = [...r.values].reverse();
              return (
                <tr key={i}>
                  <th scope="row">
                    {bucketRangeLabel(p)}
                    {p.inProgress ? ' (in progress)' : ''}
                  </th>
                  <td>{r.measured && r.closed != null ? fmtNumber(r.closed) : 'not measured'}</td>
                  {reversed.map((v, k) => (
                    <td key={k}>{v == null ? 'not measured' : fmtNumber(v)}</td>
                  ))}
                  <td>{finite(p.newCases) ? fmtNumber(p.newCases) : 'not reported'}</td>
                  <td>{finite(p.sentToHuman) ? fmtNumber(p.sentToHuman) : 'not reported'}</td>
                  <td>
                    {finite(p.fpRate)
                      ? fmtPercent(p.fpRate)
                      : p.fpRate === null
                        ? 'no verdicted case'
                        : 'not reported'}
                  </td>
                  <td>
                    {finite(p.alerts)
                      ? fmtNumber(p.alerts)
                      : p.alerts === null
                        ? 'not recorded'
                        : 'not reported'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {tooltipShown && activePoint
        ? createPortal(
            <div
              ref={tipRef}
              aria-hidden
              data-testid="human-vs-ai-tooltip"
              className="fixed z-50 w-64 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-elev2"
              style={{
                left: tipPos?.left ?? 0,
                top: tipPos?.top ?? 0,
                visibility: tipPos ? 'visible' : 'hidden',
              }}
              onMouseEnter={cancelHide}
              onMouseLeave={scheduleHide}
            >
              <BucketTooltipBody point={activePoint} bands={bands} truncated={truncated} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default CloseAttributionChart;
