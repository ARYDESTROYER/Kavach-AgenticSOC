/**
 * One value formatter for every answer block (BLOCKS.md §6 `formatValue`).
 *
 * Units are an ENUM on the block, so the formatter never guesses a scale: `percent` is
 * 0..100 and `ratio` is 0..1, explicitly. That is why this module does not use
 * `lib/format.ts` `fmtPercent`, which reads any value ≤ 1 as a fraction and would print
 * a genuine "1%" as "100%".
 *
 * `null` is "not measured" (G3): it prints as an em dash and is never coerced to 0.
 * Time labels are UTC and deterministic (no locale time zone), so a restored transcript
 * reads the same on every machine.
 */
import { fmtMoney, fmtTokens } from '@/lib/format';

import type { TimeBucket, ValueUnit } from './schema';
import { parseTimestamp } from './schema';

export const DASH = '—';

const DURATION_MS: Partial<Record<ValueUnit, number>> = {
  ms: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

function num(value: number, maxFraction: number): string {
  try {
    return value.toLocaleString('en-US', { maximumFractionDigits: maxFraction });
  } catch {
    return String(value);
  }
}

/** A percentage on the 0..100 scale: "<1%" for a positive sliver, one decimal under 10. */
function pct(value: number): string {
  if (value > 0 && value < 1) return '<1%';
  return `${num(value, Math.abs(value) < 10 ? 1 : 0)}%`;
}

/** Humanise a duration given in milliseconds. */
export function formatDurationMs(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${num(ms, 0)} ms`;
  if (abs < 60_000) return `${num(ms / 1_000, 1)} s`;
  if (abs < 3_600_000) return `${num(ms / 60_000, 1)} min`;
  if (abs < 172_800_000) return `${num(ms / 3_600_000, 1)} h`;
  return `${num(ms / 86_400_000, 1)} d`;
}

const ZERO_DURATION: Record<'ms' | 'seconds' | 'minutes' | 'hours', string> = {
  ms: '0 ms',
  seconds: '0 s',
  minutes: '0 min',
  hours: '0 h',
};

/**
 * A duration in its block's unit (browser-QA D8). Zero reads in that unit ("0 min",
 * never "0 ms" for a minutes median, so it matches the prose), and a positive sliver
 * under one second of a minutes or hours value reads "< 1 min" rather than a
 * millisecond figure the measurement never had. Everything else is humanised.
 */
function formatDuration(value: number, unit: 'ms' | 'seconds' | 'minutes' | 'hours'): string {
  if (value === 0) return ZERO_DURATION[unit];
  const ms = value * (DURATION_MS[unit] ?? 1);
  if ((unit === 'minutes' || unit === 'hours') && Math.abs(ms) < 1_000) return '< 1 min';
  return formatDurationMs(ms);
}

function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = value;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${num(v, i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Format one value in its unit; `null`/non-finite → em dash (G3). */
export function formatValue(value: number | null | undefined, unit: ValueUnit): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  switch (unit) {
    case 'count':
      return num(value, 2);
    case 'percent':
      return pct(value);
    case 'ratio':
      return pct(value * 100);
    case 'score':
      return `${num(value, 0)}/100`;
    case 'ms':
    case 'seconds':
    case 'minutes':
    case 'hours':
      return formatDuration(value, unit);
    case 'usd':
      return fmtMoney(value, 'USD');
    case 'tokens':
      return fmtTokens(value);
    case 'bytes':
      return bytes(value);
    default:
      return num(value, 2);
  }
}

/**
 * The MAGNITUDE of a change in `unit` (the caller adds the sign). A change in a rate is
 * in percentage POINTS ("18% → 21%" moved 3 pp, not 3%), and a change in a 0–100 score is
 * a plain number of points ("+5", not "+5/100"); every other unit reads as itself.
 */
export function formatDelta(value: number | null | undefined, unit: ValueUnit): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  switch (unit) {
    case 'percent':
      return `${num(value, Math.abs(value) < 10 ? 1 : 0)} pp`;
    case 'ratio':
      return `${num(value * 100, Math.abs(value * 100) < 10 ? 1 : 0)} pp`;
    case 'score':
      return num(value, 0);
    default:
      return formatValue(value, unit);
  }
}

/** The minus sign (U+2212) the console's deltas use. */
export const MINUS = '−';

export interface ChangeParts {
  /** `current − baseline`, or null when either is not measured. */
  delta: number | null;
  /** The signed change in the unit's own terms ("+96", "−2.1 pp"), "0" for none, "—" unmeasured. */
  abs: string;
  /** The change in percent of the baseline ("+8.3%", "0%"), "new" for a zero baseline, "—" unmeasured. */
  pct: string;
  /** The baseline was zero and the current value is not (never ∞ or NaN, SPEC §3.4). */
  isNew: boolean;
}

/**
 * Python's `round(x, digits)`, exactly: the EXACT binary value of `x` rounded to `digits`
 * decimals, an exact tie going to the even digit (`round(1.25, 1)` is 1.2, where
 * `toFixed` and "round half up" give 1.3). The server computes every comparison figure
 * this way (`blocks.compare_values`), so the client's own figure for the same change
 * reads the same as the server's tiles and delta table.
 *
 * A tie is only possible where the scaled value is exactly representable: `x` is an odd
 * multiple of 2^-(digits+1). Every other value is correctly rounded by `toFixed`, which
 * works on the exact binary value too.
 */
export function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const scaled = x * 2 ** (digits + 1);
  if (Number.isInteger(scaled) && Math.abs(scaled) % 2 === 1) {
    const p = 10 ** digits;
    const k = Math.floor(Math.abs(x) * p);
    return (Math.sign(x) * (k % 2 === 0 ? k : k + 1)) / p;
  }
  return Number(x.toFixed(digits));
}

/**
 * The change from `baseline` to `current`, by the backend `compare_values` rule to the
 * last digit (`round(cur − base, 6)`, then `round(delta / |base| × 100, 1)`, both
 * half-even — {@link roundHalfEven}): a rate changes by percentage POINTS, the relative
 * change is one decimal of the baseline, and a zero baseline with a non-zero current
 * value is "new" — never infinity or NaN.
 */
export function changeParts(current: number | null | undefined, baseline: number | null | undefined, unit: ValueUnit): ChangeParts {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!ok(current) || !ok(baseline)) return { delta: null, abs: DASH, pct: DASH, isNew: false };
  const delta = roundHalfEven(current - baseline, 6);
  const sign = delta > 0 ? '+' : delta < 0 ? MINUS : '';
  const abs = delta === 0 ? '0' : `${sign}${formatDelta(Math.abs(delta), unit)}`;
  if (baseline === 0) {
    return current === 0 ? { delta, abs, pct: '0%', isNew: false } : { delta, abs, pct: 'new', isNew: true };
  }
  const pct = roundHalfEven((delta / Math.abs(baseline)) * 100, 1);
  return { delta, abs, pct: pct === 0 ? '0%' : `${pct > 0 ? '+' : MINUS}${Math.abs(pct).toFixed(1)}%`, isNew: false };
}

/** Compact axis-tick text (no unit noise on counts; "1.2k" past four digits). */
export function formatTick(value: number, unit: ValueUnit): string {
  if (unit === 'count' || unit === 'tokens') {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${num(value / 1_000_000, 1)}M`;
    if (abs >= 10_000) return `${num(value / 1_000, 0)}k`;
    if (abs >= 1_000) return `${num(value / 1_000, 1)}k`;
    return num(value, 2);
  }
  if (unit === 'score') return num(value, 0);
  return formatValue(value, unit);
}

/** The unit spelled out for screen readers ("percent", "milliseconds"); empty for counts. */
export function unitWord(unit: ValueUnit): string {
  switch (unit) {
    case 'percent':
    case 'ratio':
      return 'percent';
    case 'score':
      return 'score out of 100';
    case 'ms':
    case 'seconds':
    case 'minutes':
    case 'hours':
      return 'duration';
    case 'usd':
      return 'US dollars';
    case 'tokens':
      return 'tokens';
    case 'bytes':
      return 'bytes';
    default:
      return '';
  }
}

/** A short unit label for captions and axis titles ("count", "%", "USD"). */
export function unitLabel(unit: ValueUnit): string {
  switch (unit) {
    case 'percent':
    case 'ratio':
      return '%';
    case 'score':
      return 'score (0–100)';
    case 'usd':
      return 'USD';
    default:
      return unit;
  }
}

/* -------------------------------------------------------------------------- */
/* UTC time.                                                                   */
/* -------------------------------------------------------------------------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Epoch ms of a shared-grammar timestamp, else null. */
export function instantOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = parseTimestamp(value);
  return Number.isNaN(ms) ? null : ms;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function utcDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function utcHm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "2026-10-08 14:05 UTC"; a date-only value stays a date; unparseable text is shown as is. */
export function formatUtc(value: string | null | undefined): string {
  if (!value) return DASH;
  const ms = instantOf(value);
  if (ms === null) return value;
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (value.length <= 10) return date;
  return `${date} ${utcHm(ms)} UTC`;
}

/** The UTC calendar day of a timestamp ("2026-10-08"), for timeline day dividers. */
export function utcDateKey(value: string): string {
  const ms = instantOf(value);
  if (ms === null) return value;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const BUCKET_MS: Record<TimeBucket, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
  // Calendar buckets (Round 12): nominal widths only; their real boundaries and labels
  // come from the block's `x.labels` / `x.tz` (calendar months, quarters and years).
  '1M': 2_592_000_000,
  '1q': 7_776_000_000,
  '1y': 31_536_000_000,
};

export function bucketMs(bucket: TimeBucket | undefined): number | null {
  return bucket ? BUCKET_MS[bucket] : null;
}

/** A short axis label for a time bucket: the clock under a day, the day otherwise. */
export function shortTimeLabel(value: string, bucket: TimeBucket | undefined): string {
  const ms = instantOf(value);
  if (ms === null) return value;
  const size = bucketMs(bucket);
  if (value.length <= 10 || (size !== null && size >= 86_400_000)) return utcDay(ms);
  return utcHm(ms);
}

/**
 * The full UTC range of one bucket, e.g. "Oct 5, 14:00–15:00 UTC" (the same grammar as
 * the Overview's close-attribution chart). Without a bucket size it is the instant.
 */
export function bucketRangeLabel(value: string, bucket: TimeBucket | undefined): string {
  const s = instantOf(value);
  if (s === null) return value;
  if (value.length <= 10 && (bucket === undefined || bucket === '1d')) return utcDay(s);
  const size = bucketMs(bucket);
  if (size === null) return `${utcDay(s)}, ${utcHm(s)} UTC`;
  const e = s + size;
  if (size >= 86_400_000) {
    return size === 86_400_000 ? utcDay(s) : `${utcDay(s)} – ${utcDay(e - 1)}`;
  }
  if (utcDay(s) === utcDay(e - 1)) {
    const endHm = e % 86_400_000 === 0 ? '24:00' : utcHm(e);
    return `${utcDay(s)}, ${utcHm(s)}–${endHm} UTC`;
  }
  return `${utcDay(s)}, ${utcHm(s)} – ${utcDay(e)}, ${utcHm(e)} UTC`;
}

/** The human label of an x position: a bucket range on a time axis, the category otherwise. */
export function xLabelFull(value: string, kind: 'category' | 'time', bucket: TimeBucket | undefined): string {
  return kind === 'time' ? bucketRangeLabel(value, bucket) : value;
}

/* -------------------------------------------------------------------------- */
/* Calendar axes (Round 12 P0-5): server labels in the operator time zone.     */
/* -------------------------------------------------------------------------- */
/** The x axis fields the label helpers read (a `ChartBlock['x']`). */
export interface AxisLike {
  kind: 'category' | 'time';
  values: readonly string[];
  bucket?: TimeBucket;
  labels?: readonly string[];
  tz?: string;
}

/** The time zone a time axis is read in: its calendar zone, else UTC. */
export function axisZone(x: Pick<AxisLike, 'kind' | 'tz'>): string {
  return x.kind === 'time' && x.tz ? x.tz : 'UTC';
}

/** Does this axis carry calendar labels (a time axis cut in calendar periods)? */
export function hasCalendarLabels(x: AxisLike): boolean {
  return x.kind === 'time' && Array.isArray(x.labels) && x.labels.some(Boolean);
}

/**
 * The full label of x position `i`: the server's calendar label ("Mar 2026", "W14
 * 2026", "Jul 2026 (from 12 Jul)") when it sent one, else the UTC bucket range on a
 * time axis, else the category. Never the in-progress marker (callers add it).
 */
export function xPositionLabel(x: AxisLike, i: number): string {
  const label = x.kind === 'time' ? x.labels?.[i] : undefined;
  if (label) return label;
  return xLabelFull(x.values[i] ?? '', x.kind, x.bucket);
}

const YEAR_SPLIT = /^(.*\S)\s(\d{4})$/;

/**
 * The span from x position `a` to `b` in words, short enough for a narrow row: on a
 * time axis a year both ends share is said once ("23 Sep – 7 Oct 2026", "Jul – Oct
 * 2026", "W14 – W17 2026"); different years, clock times, cut-edge notes and labels
 * that are ranges themselves read in full ("Dec 2025 – Feb 2026"). Categories always
 * read in full: a trailing number there is a name, not a year.
 */
export function xRangeLabel(x: AxisLike, a: number, b: number): string {
  const first = xPositionLabel(x, a);
  const last = xPositionLabel(x, b);
  if (a === b || first === last) return first;
  if (x.kind === 'time') {
    const p = YEAR_SPLIT.exec(first);
    const q = YEAR_SPLIT.exec(last);
    // "16 Sep 2026 – 22 Sep 2026" is itself a range: its inner year stays where it is.
    const plain = (stem: string) => !stem.includes('–') && !/\d{4}/.test(stem);
    if (p && q && p[2] === q[2] && plain(p[1]) && plain(q[1])) return `${p[1]} – ${q[1]} ${p[2]}`;
  }
  return `${first} – ${last}`;
}

const CLOCK_TAIL = /(\d{2}:\d{2})$/;
const YEAR_TAIL = /\s\d{4}$/;
const NOTE_TAIL = /\s*\([^()]*\)$/;

/**
 * A calendar label short enough for an axis tick: a cut-edge note ("(from 12 Jul)") is
 * left to the tooltip and the table, a day drops its year ("10 Oct"), an hour keeps its
 * clock ("14:00"); months, weeks, quarters and years read as sent.
 */
export function shortCalendarLabel(label: string, bucket: TimeBucket | undefined): string {
  const bare = label.replace(NOTE_TAIL, '');
  if (bucket === '1m' || bucket === '5m' || bucket === '15m' || bucket === '1h' || bucket === '6h') {
    const clock = CLOCK_TAIL.exec(bare);
    return clock ? clock[1] : bare;
  }
  if (bucket === '1d') return bare.replace(YEAR_TAIL, '');
  return bare;
}

/** The short tick text of x position `i` (calendar label, else the UTC time, else the category). */
export function xTickLabel(x: AxisLike, i: number, maxChars = 12): string {
  const value = x.values[i] ?? '';
  if (x.kind !== 'time') return clipText(value, maxChars);
  const label = x.labels?.[i];
  if (label) return shortCalendarLabel(label, x.bucket);
  return shortTimeLabel(value, x.bucket);
}

/**
 * The row-header label of an x axis in a data table: the block's own axis title, else
 * "Period (<zone>)" for a calendar axis, "Time (UTC)" for a plain time axis, "Category".
 */
export function xAxisHeader(x: AxisLike & { label?: string }): string {
  if (x.label) return x.label;
  if (x.kind !== 'time') return 'Category';
  return hasCalendarLabels(x) ? `Period (${axisZone(x)})` : 'Time (UTC)';
}

/** The in-progress marker a current, still-filling period carries in text. */
export const IN_PROGRESS_SUFFIX = ' (in progress)';

/**
 * Clip display text to `max` characters with an ellipsis, counting code points so a
 * clip never splits a surrogate pair into a lone (unrenderable) half.
 */
/**
 * A Help Center link's title without any "Read:" prefix (browser-QA D1). The server
 * sends plain titles and the client adds its own verb once; answers saved before that
 * change carry "Read: <title>", so a stored prefix is removed before one is added.
 */
export function plainDocTitle(label: string): string {
  return label.replace(/^\s*read:\s*/i, '') || label;
}

export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : text;
}

/** A filename-safe slug (the KpiDrilldownPanel rule). */
export function slug(value: string, fallback = 'block'): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback
  );
}

/** `yyyymmdd-hhmm` in UTC, for export filenames. */
export function fileStamp(now: Date = new Date()): string {
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
  );
}

/**
 * The block's own caption already states the shown-of-total figure ("Top 5 of 20"), so
 * the footer's "Showing top 5 of 20" would only repeat it. The figures must stand alone:
 * "25 of 2050" does not state "5 of 20".
 */
export function captionStatesCount(caption: string | null | undefined, shown: number, total: number | null): boolean {
  if (!caption || total === null) return false;
  const figure = (n: number) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\D)${figure(shown)} of ${figure(total)}(\\D|$)`, 'i').test(caption.replace(/,/g, ''));
}

/** "top 10 of 1,240" style disclosure for a truncated block (G4). */
export function truncationNote(shown: number, total: number | null): string {
  if (total !== null && total > shown) return `Showing top ${num(shown, 0)} of ${num(total, 0)}`;
  return `Showing the first ${num(shown, 0)}; more exist`;
}

/**
 * The investigation brief's label (Round 12 SYNTHESIS-chat P1-3, #3): the brief is the
 * model's advisory assessment; the close/escalate decision is the deterministic policy's.
 * ONE string for the in-chat Brief, the Reports library, Print and every file export.
 */
export const INVESTIGATION_BRIEF_ADVISORY = 'Advisory — the case decision is made by policy (decide())';
/** The sentence that follows the label wherever it is a callout (documents, exports). */
export const INVESTIGATION_BRIEF_ADVISORY_NOTE = 'This brief is the model’s assessment. It never closes or escalates a case.';
