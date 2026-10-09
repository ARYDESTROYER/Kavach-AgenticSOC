/**
 * Shared chart geometry for the answer-block charts (BLOCKS.md §6) — pure functions,
 * unit-tested, generalised from the Overview's `CloseAttributionChart`.
 *
 * Honesty rules baked in here so every chart kind inherits them:
 *   - `null` is never 0 (G3): a stack with a missing segment is not stacked at all (the
 *     caller hatches it), a line breaks at `null` instead of interpolating, and shares
 *     are only computed when the parts reconcile.
 *   - Ticks are "clean" steps from zero, so a bar's length is always read against a
 *     zero baseline.
 *
 * Deliberately a COPY of `reconcilingShares` rather than an import from
 * `CloseAttributionChart.tsx`: importing that component module would pull it into the
 * lazy blocks chunk for one 20-line function.
 */

/* -------------------------------------------------------------------------- */
/* Scales.                                                                     */
/* -------------------------------------------------------------------------- */
const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];

/** The smallest clean step (1·2·2.5·5 × 10^k) that covers `span` in at most `count` steps. */
export function niceStep(span: number, count = 2): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of STEP_MULTIPLIERS) {
    const s = m * pow;
    if (s >= raw - 1e-12) return s;
  }
  return 10 * pow;
}

export interface NiceScale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/** Round a float tick to the step's precision so 0.1 + 0.2 never prints 0.30000000000000004. */
function roundTo(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(value.toFixed(Math.min(10, decimals)));
}

/**
 * A zero-anchored domain with clean ticks. The domain always includes 0 (bars measure
 * from the baseline); an all-zero or empty domain still gets [0, 1] so geometry never
 * divides by nothing. `integer` keeps steps whole for counts.
 */
export function niceScale(lo: number, hi: number, maxTicks = 4, integer = false): NiceScale {
  let min = Math.min(0, Number.isFinite(lo) ? lo : 0);
  let max = Math.max(0, Number.isFinite(hi) ? hi : 0);
  if (min === 0 && max === 0) max = 1;
  let step = niceStep(max - min, Math.max(1, maxTicks - 1));
  if (integer && step < 1) step = 1;
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = min, guard = 0; v <= max + step / 2 && guard < 50; v += step, guard += 1) {
    ticks.push(roundTo(v, step));
  }
  return { min: roundTo(min, step), max: roundTo(max, step), step, ticks };
}

/** Data extent over every finite value (nulls ignored); `[0, 0]` when there is none. */
export function extent(series: ReadonlyArray<ReadonlyArray<number | null>>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const values of series) {
    for (const v of values) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}

/** Per-slot stacked totals; a slot with any missing (`null`) part has no total. */
export function stackTotals(series: ReadonlyArray<ReadonlyArray<number | null>>, n: number): Array<number | null> {
  return Array.from({ length: n }, (_, i) => {
    let sum = 0;
    for (const values of series) {
      const v = values[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      sum += Math.max(0, v);
    }
    return sum;
  });
}

/* -------------------------------------------------------------------------- */
/* X labels.                                                                   */
/* -------------------------------------------------------------------------- */
/** Approximate advance of one 11px tabular glyph. */
export const CHAR_W = 6.6;
const MINUTE_MS = 60_000;
/**
 * Candidate label intervals in minutes, smallest first: sub-hour steps for "last hour"
 * lookups at 1m/5m/15m buckets, then the hour/day/week ladder.
 */
const LABEL_INTERVALS_MIN = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 4320, 10080, 20160, 43200];

/**
 * Indices of the x slots that get a label: at most five, on regular UTC intervals when
 * the axis is time (a 24h window reads 00 · 06 · 12 · 18; an hour at 5-minute buckets
 * reads :00 · :15 · :30 · :45), else evenly stepped. An aligned interval is used only
 * when it yields at least two labels — one lone tick says nothing about the scale — and
 * the smallest such interval wins, so the axis gets as many labels as fit.
 */
export function pickXLabels(
  labels: readonly string[],
  plotWidth: number,
  instants?: ReadonlyArray<number | null>,
): number[] {
  const n = labels.length;
  if (!n) return [];
  const longest = Math.max(1, ...labels.map((l) => l.length));
  const labelWidth = longest * CHAR_W + 14;
  const maxLabels = Math.max(1, Math.min(5, Math.floor(plotWidth / labelWidth)));
  if (n <= maxLabels) return labels.map((_, i) => i);
  if (instants && n > 1 && maxLabels >= 2 && instants.every((s) => s !== null)) {
    const ms = instants as number[];
    let bucket = Infinity;
    for (let i = 1; i < ms.length; i += 1) {
      const d = ms[i] - ms[i - 1];
      if (d > 0) bucket = Math.min(bucket, d);
    }
    if (Number.isFinite(bucket)) {
      for (const m of LABEL_INTERVALS_MIN) {
        const iv = m * MINUTE_MS;
        if (iv < bucket || iv % bucket !== 0) continue;
        const idx = ms.flatMap((s, i) => (s % iv === 0 ? [i] : []));
        if (idx.length >= 2 && idx.length <= maxLabels) return idx;
      }
    }
  }
  const step = Math.ceil(n / maxLabels);
  return Array.from({ length: Math.ceil(n / step) }, (_, k) => k * step);
}

/**
 * Lay out chosen x labels centred on their slots, clamped inside the figure and
 * DROPPED (never overlapped) when a clamp pushes one into its neighbour.
 */
export function placeXLabels(
  picks: readonly number[],
  texts: readonly string[],
  centre: (i: number) => number,
  width: number,
): Array<{ index: number; x: number; text: string }> {
  const out: Array<{ index: number; x: number; text: string }> = [];
  let lastRight = -Infinity;
  for (const index of picks) {
    const text = texts[index] ?? '';
    const w = text.length * CHAR_W;
    const c = Math.min(Math.max(centre(index), w / 2), width - w / 2);
    if (c - w / 2 < lastRight + 6) continue;
    out.push({ index, x: Math.round(c), text });
    lastRight = c + w / 2;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Bars and stacks.                                                            */
/* -------------------------------------------------------------------------- */
export const BAR_MAX = 22;
export const SEGMENT_MIN = 2;
export const SEGMENT_GAP = 1;
export const TOP_RADIUS = 2;

export interface StackSegment {
  /** Series index (stack order, baseline first). */
  series: number;
  value: number;
  y: number;
  h: number;
  /** The topmost non-zero segment (gets the rounded corners). */
  top: boolean;
}

/**
 * Stack one slot's measured values from the baseline (CloseAttributionChart rules): each
 * segment's TOP edge is placed from the cumulative total so the stack height stays true,
 * the 1px gap is an inset taken from the upper segment, and a non-zero segment never
 * paints under 2px. Returns `null` when any part is unmeasured — the caller hatches the
 * slot instead of drawing a partial stack that would read as a smaller total.
 */
export function stackSegments(
  values: ReadonlyArray<number | null>,
  baseline: number,
  scale: number,
  visible?: ReadonlyArray<boolean>,
): StackSegment[] | null {
  if (values.some((v, k) => (visible ? visible[k] : true) && (typeof v !== 'number' || !Number.isFinite(v)))) {
    return null;
  }
  const out: StackSegment[] = [];
  let cum = 0;
  let cursor = baseline;
  values.forEach((raw, k) => {
    if (visible && !visible[k]) return;
    const v = Math.max(0, raw as number);
    if (v <= 0) return;
    cum += v;
    const bottom = out.length ? cursor - SEGMENT_GAP : cursor;
    const top = Math.min(Math.round(baseline - cum * scale), bottom - SEGMENT_MIN);
    out.push({ series: k, value: v, y: top, h: bottom - top, top: false });
    cursor = top;
  });
  if (out.length) out[out.length - 1].top = true;
  return out;
}

/** A vertical bar's path: square at the baseline, `r` on its two top corners. */
export function roundedTopPath(x: number, y: number, w: number, h: number, r = TOP_RADIUS): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return (
    `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}` +
    `H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`
  );
}

/** A horizontal bar's path: square at the baseline (left), `r` on its two right corners. */
export function roundedRightPath(x: number, y: number, w: number, h: number, r = TOP_RADIUS): string {
  const rr = Math.max(0, Math.min(r, h / 2, w));
  return (
    `M${x},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}` +
    `V${y + h - rr}A${rr},${rr} 0 0 1 ${x + w - rr},${y + h}H${x}Z`
  );
}

/** Column width for one slot: ⅔ of it, capped (house rule), at least 1px. */
export function barWidth(slot: number, cap = BAR_MAX): number {
  return Math.max(1, Math.min(cap, Math.round((slot * 2) / 3)));
}

/* -------------------------------------------------------------------------- */
/* Shares.                                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Whole percentages of `total` that sum to EXACTLY 100 (largest remainder), or `null`
 * when the split cannot be trusted: a part is missing/negative, the total is not
 * positive, or the parts do not sum to the total.
 */
export function reconcilingShares(parts: ReadonlyArray<number | null>, total: number): number[] | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!parts.length) return null;
  if (parts.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0)) return null;
  const nums = parts as number[];
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - total) > 1e-9 * Math.max(1, total)) return null;
  const exact = nums.map((p) => (p / total) * 100);
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

/* -------------------------------------------------------------------------- */
/* Donut.                                                                      */
/* -------------------------------------------------------------------------- */
export interface DonutArc {
  index: number;
  value: number;
  start: number;
  end: number;
  path: string;
}

function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

/**
 * Arc paths for the measured, positive values (clockwise from 12 o'clock). Segment gaps
 * come from `padAngle` GEOMETRY (each arc gives up half the pad on both ends), never
 * from a `stroke` in a guessed surface colour. A lone segment is drawn as a full ring.
 */
export function donutArcs(
  values: ReadonlyArray<number | null>,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  padAngle = 0.03,
): DonutArc[] {
  const items = values
    .map((v, index) => ({ index, value: typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0 }))
    .filter((it) => it.value > 0);
  const total = items.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return [];
  const pad = items.length > 1 ? padAngle : 0;
  const out: DonutArc[] = [];
  let angle = 0;
  for (const it of items) {
    const sweep = (it.value / total) * Math.PI * 2;
    const start = angle + pad / 2;
    const end = Math.max(start + 0.0001, angle + sweep - pad / 2);
    angle += sweep;
    if (items.length === 1) {
      // A full ring as two half arcs (an SVG arc cannot start and end on one point).
      const [ox, oy] = polar(cx, cy, outer, 0);
      const [ox2, oy2] = polar(cx, cy, outer, Math.PI);
      const [ix, iy] = polar(cx, cy, inner, 0);
      const [ix2, iy2] = polar(cx, cy, inner, Math.PI);
      const path =
        `M${ox},${oy}A${outer},${outer} 0 1 1 ${ox2},${oy2}A${outer},${outer} 0 1 1 ${ox},${oy}Z` +
        `M${ix},${iy}A${inner},${inner} 0 1 0 ${ix2},${iy2}A${inner},${inner} 0 1 0 ${ix},${iy}Z`;
      out.push({ index: it.index, value: it.value, start: 0, end: Math.PI * 2, path });
      continue;
    }
    const large = end - start > Math.PI ? 1 : 0;
    const [x1, y1] = polar(cx, cy, outer, start);
    const [x2, y2] = polar(cx, cy, outer, end);
    const [x3, y3] = polar(cx, cy, inner, end);
    const [x4, y4] = polar(cx, cy, inner, start);
    const path =
      `M${x1},${y1}A${outer},${outer} 0 ${large} 1 ${x2},${y2}` +
      `L${x3},${y3}A${inner},${inner} 0 ${large} 0 ${x4},${y4}Z`;
    out.push({ index: it.index, value: it.value, start, end, path });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Lines.                                                                      */
/* -------------------------------------------------------------------------- */
export interface LineRun {
  /** Slot indices in this unbroken run. */
  indices: number[];
  /** `M…L…` path through the run's points. */
  path: string;
}

/**
 * Split a series into unbroken runs at `null` — a line is NEVER interpolated across a
 * missing bucket (G3). Each run is a path; a run of one point is returned too (the caller
 * draws a dot so an isolated measurement stays visible).
 */
export function lineRuns(
  values: ReadonlyArray<number | null>,
  xOf: (i: number) => number,
  yOf: (v: number) => number,
): LineRun[] {
  const runs: LineRun[] = [];
  let current: number[] = [];
  const flush = () => {
    if (!current.length) return;
    const path = current.map((i, k) => `${k === 0 ? 'M' : 'L'}${round2(xOf(i))},${round2(yOf(values[i] as number))}`).join('');
    runs.push({ indices: current, path });
    current = [];
  };
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) current.push(i);
    else flush();
  });
  flush();
  return runs;
}

/** The closed area under one run, down to `baseline`. */
export function areaPath(
  run: LineRun,
  values: ReadonlyArray<number | null>,
  xOf: (i: number) => number,
  yOf: (v: number) => number,
  baseline: number,
): string {
  const first = run.indices[0];
  const last = run.indices[run.indices.length - 1];
  const top = run.indices.map((i, k) => `${k === 0 ? 'M' : 'L'}${round2(xOf(i))},${round2(yOf(values[i] as number))}`).join('');
  return `${top}L${round2(xOf(last))},${round2(baseline)}L${round2(xOf(first))},${round2(baseline)}Z`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Index of the last finite value, else -1. */
export function lastMeasured(values: ReadonlyArray<number | null>): number {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) return i;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Sequential (heatmap) steps.                                                 */
/* -------------------------------------------------------------------------- */
/**
 * Quantise a magnitude into one of five visible steps on the viridis ramp (0.18 → 1.0),
 * the MitreHeatmap rule, so a low count is still legible and a zero reads as empty.
 * Returns 0 for a non-positive value.
 */
export function intensityStep(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  const r = Math.min(1, value / max);
  return 0.18 + Math.round(r * 4) * (0.82 / 4);
}

/** The five legend steps of {@link intensityStep}. */
export const INTENSITY_STEPS = [0.18, 0.385, 0.59, 0.795, 1] as const;
