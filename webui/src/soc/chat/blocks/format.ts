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

/** "top 10 of 1,240" style disclosure for a truncated block (G4). */
/**
 * The block's own caption already states the shown-of-total figure ("Top 5 of 20"), so
 * the footer's "Showing top 5 of 20" would only repeat it.
 */
export function captionStatesCount(caption: string | null | undefined, shown: number, total: number | null): boolean {
  if (!caption || total === null) return false;
  return caption.replace(/,/g, '').toLowerCase().includes(`${shown} of ${total}`);
}

export function truncationNote(shown: number, total: number | null): string {
  if (total !== null && total > shown) return `Showing top ${num(shown, 0)} of ${num(total, 0)}`;
  return `Showing the first ${num(shown, 0)}; more exist`;
}
