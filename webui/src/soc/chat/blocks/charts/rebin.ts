/**
 * Client-side re-binning of a calendar time series into a COARSER calendar unit (Round 12
 * SPEC §3.4, SYNTHESIS-chat P0-8): daily cases shown by week or month, hourly by day.
 *
 * It is a pure projection of numbers the block already carries — never a re-query and
 * never a model call — and it is only offered where it is exactly right:
 *
 *   - the server lists the target in `allowed_rebin` (the parser re-checks the rule: a
 *     calendar time axis of ADDITIVE values, a target the axis's bucket NESTS in);
 *   - the browser knows the axis's time zone (`Intl` with that `timeZone`), so every
 *     fine bucket is assigned to the same calendar period the server would cut;
 *   - every x value is a parseable instant.
 *
 * Every fine bucket lies wholly inside one coarse period (that is what "nests" means), so
 * a coarse value is the plain sum of its fine buckets and equals a server query at the
 * coarse unit. A coarse period with any NOT-MEASURED fine bucket is not measured (G3): a
 * sum over a missing part would read as a smaller total. Labels follow the backend's
 * `period_label` grammar ("10 Oct 2026", "W41 2026", "Oct 2026", "Q4 2026", "2026"); a
 * period the series only partly covers says so ("Jul 2026 (from 12 Jul)"), like the
 * server's own cut buckets; the current, still-filling period stays flagged in progress.
 */
import type { ChartBlock, TimeBucket } from '../schema';
import { instantOf } from '../format';

/** The segmented control's word for a bucket. */
export const BUCKET_WORD: Readonly<Record<TimeBucket, string>> = {
  '1m': 'Minute',
  '5m': '5 min',
  '15m': '15 min',
  '1h': 'Hour',
  '6h': '6 hours',
  '1d': 'Day',
  '1w': 'Week',
  '1M': 'Month',
  '1q': 'Quarter',
  '1y': 'Year',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_MS = 3_600_000;
/** Fine buckets this module can place on a calendar (fixed-width sub-hour buckets cannot). */
const FINE = new Set<TimeBucket>(['1h', '1d', '1M', '1q']);
const COARSE = new Set<TimeBucket>(['1d', '1w', '1M', '1q', '1y']);

/** A wall-clock moment in the axis zone. `weekday` is ISO (Monday 1 … Sunday 7). */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
  } catch {
    // An IANA name this browser does not know: no calendar math in it (no re-bin).
    fmt = null;
  }
  formatters.set(tz, fmt);
  return fmt;
}

/** Does this browser know the zone (so a re-bin cuts the same periods as the server)? */
export function zoneSupported(tz: string): boolean {
  return formatterFor(tz) !== null;
}

/** The wall-clock parts of an instant in `tz`, else null (an unknown zone). */
export function localParts(ms: number, tz: string): LocalParts | null {
  const fmt = formatterFor(tz);
  if (!fmt || !Number.isFinite(ms)) return null;
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const out = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY[parts.weekday] ?? 0,
  };
  return Object.values(out).every((v) => Number.isFinite(v)) && out.weekday > 0 ? out : null;
}

/** A calendar date (no clock), as integers. */
interface Ymd {
  year: number;
  month: number;
  day: number;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `date` shifted by whole days / months on the proleptic calendar (no zone involved). */
function addDays(d: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
function addMonths(d: Ymd, months: number): Ymd {
  const index = d.year * 12 + (d.month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
}

function isoWeekday(d: Ymd): number {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** ISO-8601 week of a date: `[isoYear, week]` (weeks start on Monday; week 1 holds 4 Jan). */
export function isoWeek(d: Ymd): [number, number] {
  const thursday = addDays(d, 4 - isoWeekday(d));
  const jan1 = Date.UTC(thursday.year, 0, 1);
  const day = Math.round((Date.UTC(thursday.year, thursday.month - 1, thursday.day) - jan1) / 86_400_000);
  return [thursday.year, Math.floor(day / 7) + 1];
}

const quarterOf = (month: number) => Math.floor((month - 1) / 3) + 1;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** The coarse period a local date falls in: a stable key and its label. */
function period(d: Ymd, target: TimeBucket): { key: string; label: string } {
  switch (target) {
    case '1d':
      return { key: `${d.year}-${d.month}-${d.day}`, label: `${d.day} ${MONTHS[d.month - 1]} ${d.year}` };
    case '1w': {
      const [y, w] = isoWeek(d);
      return { key: `${y}-W${w}`, label: `W${pad2(w)} ${y}` };
    }
    case '1M':
      return { key: `${d.year}-${d.month}`, label: `${MONTHS[d.month - 1]} ${d.year}` };
    case '1q':
      return { key: `${d.year}-Q${quarterOf(d.month)}`, label: `Q${quarterOf(d.month)} ${d.year}` };
    default:
      return { key: String(d.year), label: String(d.year) };
  }
}

/** One fine bucket placed on the calendar. */
interface Placed {
  ms: number;
  local: LocalParts;
}

/** The local date of the fine bucket next to `p` (`step` = +1 / -1), for edge checks. */
function neighbour(p: Placed, fine: TimeBucket, step: 1 | -1, tz: string): Ymd | null {
  if (fine === '1h') return localParts(p.ms + step * HOUR_MS, tz);
  if (fine === '1d') return addDays(p.local, step);
  if (fine === '1M') return addMonths(p.local, step);
  if (fine === '1q') return addMonths(p.local, 3 * step);
  return null;
}

function dayMonth(d: Ymd): string {
  return `${d.day} ${MONTHS[d.month - 1]}`;
}

/** The last calendar day a fine bucket covers (for a "to 5 Oct" edge note). */
function lastDay(p: Placed, fine: TimeBucket): Ymd {
  if (fine === '1M') return { year: p.local.year, month: p.local.month, day: daysIn(p.local.year, p.local.month) };
  if (fine === '1q') {
    const end = addMonths(p.local, 2);
    return { year: end.year, month: end.month, day: daysIn(end.year, end.month) };
  }
  return p.local;
}

/**
 * The coarser buckets a block offers in the "Group by" control: its own bucket first,
 * then each allowed target — or none at all when a re-bin cannot be exact here.
 */
export function rebinChoices(block: ChartBlock): TimeBucket[] {
  const bucket = block.x.bucket;
  if (!bucket || !FINE.has(bucket) || !block.allowed_rebin.length || block.x.kind !== 'time') return [];
  if (block.x.values.length < 2 || !zoneSupported(block.x.tz ?? 'UTC')) return [];
  if (block.x.values.some((v) => instantOf(v) === null)) return [];
  const targets = block.allowed_rebin.filter((b) => COARSE.has(b));
  return targets.length ? [bucket, ...targets] : [];
}

/**
 * The block re-binned into `target` (the block itself when that is not a valid choice).
 * Sums per coarse period, null when a part is not measured; drill-through and reference
 * lines (which name fine buckets or fine-scale thresholds) are dropped.
 */
export function rebinChart(block: ChartBlock, target: TimeBucket): ChartBlock {
  const choices = rebinChoices(block);
  const fine = block.x.bucket;
  if (!fine || target === fine || !choices.includes(target)) return block;
  const tz = block.x.tz ?? 'UTC';
  const placed: Placed[] = [];
  for (const v of block.x.values) {
    const ms = instantOf(v);
    const local = ms === null ? null : localParts(ms, tz);
    if (ms === null || !local) return block;
    placed.push({ ms, local });
  }
  type Group = { key: string; label: string; first: number; last: number };
  const groups: Group[] = [];
  placed.forEach((p, i) => {
    const { key, label } = period(p.local, target);
    const g = groups[groups.length - 1];
    if (g && g.key === key) g.last = i;
    else groups.push({ key, label, first: i, last: i });
  });
  // A coarse period the series only partly covers says which part (the server's
  // `display_bucket_labels` grammar): the first one when the bucket before it would
  // fall in the same period, the last one (unless it is the period in progress) when
  // the bucket after it would.
  const labels = groups.map((g) => g.label);
  const firstGroup = groups[0];
  const lastGroup = groups[groups.length - 1];
  const before = neighbour(placed[0], fine, -1, tz);
  if (before && period(before, target).key === firstGroup.key) {
    const p = placed[0];
    labels[0] = `${labels[0]} (from ${target === '1d' ? `${pad2(p.local.hour)}:${pad2(p.local.minute)}` : dayMonth(p.local)})`;
  }
  const endPlaced = placed[placed.length - 1];
  const after = neighbour(endPlaced, fine, 1, tz);
  if (!block.last_in_progress && after && period(after, target).key === lastGroup.key) {
    let edge: string;
    if (target === '1d') {
      const end = localParts(endPlaced.ms + HOUR_MS, tz);
      edge = end ? `${pad2(end.hour)}:${pad2(end.minute)}` : dayMonth(endPlaced.local);
    } else {
      edge = dayMonth(lastDay(endPlaced, fine));
    }
    labels[labels.length - 1] = `${labels[labels.length - 1]} (to ${edge})`;
  }
  const series = block.series.map((s) => ({
    ...s,
    values: groups.map((g) => {
      let sum = 0;
      for (let i = g.first; i <= g.last; i += 1) {
        const v = s.values[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        sum += v;
      }
      // Float sums of money keep their cents exact (0.1 + 0.2 never prints 0.30000000000000004).
      return Math.round(sum * 1e9) / 1e9;
    }),
  }));
  const out: ChartBlock = {
    ...block,
    x: {
      ...block.x,
      values: groups.map((g) => block.x.values[g.first]),
      labels,
      bucket: target,
      ...(block.x.tz ? { tz: block.x.tz } : {}),
    },
    series,
    allowed_rebin: [],
  };
  delete out.drill;
  delete out.reference;
  return out;
}
