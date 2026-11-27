/**
 * The x axis of every column, stack and line chart in the kit: chat answers, the board
 * widgets, the rule sheet and the image export all lay their ticks out here, so they
 * read the same (Round 14, SPEC §4.4.4 "the chart kit's one day label format", §4.6.4
 * "dated ticks").
 *
 * One time-axis rule:
 *
 *   - the first tick, and every tick that starts a new day, names its day: "Nov 2 12:00",
 *     or "Nov 2" for a bucket that starts at midnight; a later tick on the same day shows
 *     its time only ("18:00"), so a reader always knows which day a bar belongs to;
 *   - a daily bucket shows its day ("Nov 2"); a weekly bucket shows the day its week
 *     starts ("Oct 27"), never an ISO week code; months, quarters and years read as the
 *     server names them ("Mar 2026");
 *   - the newest bucket, while it is still filling, carries its own tick with
 *     "(in progress)" under it, and no other tick sits above that note, so the note can
 *     only be read as that bucket's (it is left out only where the axis has no room);
 *   - ticks never overlap: a set of ticks is used only when every label fits beside its
 *     neighbours; regular clock times win (00:00, 06:00, 12:00, 18:00 on an hourly axis,
 *     midnights on a 12-hour one), the densest set of them that fits, so two charts over
 *     the same buckets tick at the same positions; evenly stepped positions are the
 *     fallback where no regular set fits;
 *   - ticks a week or more apart follow the calendar, not the epoch: weekly ticks fall on
 *     Mondays (the day an ISO week starts, so a daily chart and a weekly chart over the
 *     same window name the same days), fortnightly ticks on every other Monday, and the
 *     widest step on the first of each month ("Sep 1", "Oct 1"), as a calendar reads.
 *
 * Days and times are read in the axis's zone (a calendar axis's `tz`, else UTC), and so
 * are the regular clock times: a breakdown written as wall-clock instants, the rule sheet
 * (UTC, with labels) and a trends chart all tick on the same hours. A position whose
 * instant cannot be placed (an unknown zone, an unparseable value) falls back to its own
 * label (`xTickLabel`). Category axes keep their evenly stepped labels.
 *
 * Pure: unit-tested without a layout engine.
 */
import type { TimeBucket } from '../schema';
import {
  IN_PROGRESS_SUFFIX,
  axisZone,
  bucketMs,
  hasCalendarLabels,
  instantOf,
  utcDay,
  xTickLabel,
  type AxisLike,
} from '../format';
import { CHAR_W, LABEL_INTERVALS_MIN, X_LABEL_GAP, pickXLabels, placeXLabels } from './geometry';
import { localParts } from './rebin';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Tick steps (minutes) that follow the calendar instead of the epoch (see `onTickStep`). */
const WEEK_MIN = 7 * 1440;
const FORTNIGHT_MIN = 14 * 1440;
/** The widest step of `LABEL_INTERVALS_MIN` (30 days): read as "the first of each month". */
const MONTH_MIN = 30 * 1440;
/** Buckets whose ticks read as the server names them (a month is not a day). */
const NAMED_BUCKETS: ReadonlySet<TimeBucket> = new Set<TimeBucket>(['1M', '1q', '1y']);
/** The most regular ticks an axis draws (the newest bucket's own tick comes on top). */
export const MAX_X_TICKS = 5;
/** The in-progress note under the newest bucket. */
export const IN_PROGRESS_NOTE = IN_PROGRESS_SUFFIX.trim();

/** Where one x position falls in time, read in the axis's zone. */
export interface TickMoment {
  /** The day in the kit's one day format ("Nov 2"). */
  day: string;
  /** The calendar day itself, to tell when a tick starts a new day. */
  dayKey: string;
  /** The time of day ("12:00") on an axis of sub-day buckets; null for days and weeks. */
  clock: string | null;
  /**
   * The position's wall-clock time in the axis's zone, written as a UTC instant: what
   * the regular clock-time ticks are aligned on (a local midnight is a whole number of
   * days here, whatever the zone's offset).
   */
  wall: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The narrowest step between two consecutive instants, else null. */
function narrowestStep(instants: ReadonlyArray<number | null>): number | null {
  let step = Infinity;
  for (let i = 1; i < instants.length; i += 1) {
    const a = instants[i - 1];
    const b = instants[i];
    if (a !== null && b !== null && b - a > 0) step = Math.min(step, b - a);
  }
  return Number.isFinite(step) ? step : null;
}

/**
 * The moment of every x position of a time axis (null for a category axis, for a month,
 * quarter or year bucket, and for a position that cannot be placed). A bucket narrower
 * than a day carries its clock; the bucket is the axis's own, else the narrowest step
 * between its instants (the rule sheet's 12 h buckets have no schema bucket).
 */
export function tickMoments(x: AxisLike): Array<TickMoment | null> {
  const n = x.values.length;
  if (x.kind !== 'time' || (x.bucket && NAMED_BUCKETS.has(x.bucket))) return new Array<TickMoment | null>(n).fill(null);
  const instants = x.values.map((v) => instantOf(v));
  const step = bucketMs(x.bucket) ?? narrowestStep(instants);
  // A calendar axis cut in months or longer, with no bucket to say so, reads as its labels.
  if (!x.bucket && step !== null && step >= 28 * DAY_MS && hasCalendarLabels(x)) {
    return new Array<TickMoment | null>(n).fill(null);
  }
  const subDay = step !== null ? step < DAY_MS : x.values.some((v) => v.length > 10);
  const zone = axisZone(x);
  return instants.map((ms) => {
    if (ms === null) return null;
    let year: number;
    let month: number;
    let date: number;
    let hour: number;
    let minute: number;
    let wall: number;
    if (zone === 'UTC') {
      const d = new Date(ms);
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
      date = d.getUTCDate();
      hour = d.getUTCHours();
      minute = d.getUTCMinutes();
      wall = ms;
    } else {
      // A zone this browser does not know cannot be read: the server label says it.
      const p = localParts(ms, zone);
      if (!p) return null;
      ({ year, month, day: date, hour, minute } = p);
      // Zone offsets are whole minutes, so the seconds carry over unchanged.
      wall = Date.UTC(year, month - 1, date, hour, minute) + (((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
    }
    return {
      day: utcDay(Date.UTC(year, month - 1, date)),
      dayKey: `${year}-${month}-${date}`,
      clock: subDay ? `${pad(hour)}:${pad(minute)}` : null,
      wall,
    };
  });
}

/**
 * The tick texts of the shown positions `picks` (ascending), by the one time-axis rule:
 * the first tick and each tick that starts a new day carry the day, a later tick on the
 * same day its time only. Returned as a sparse array indexed by position.
 */
export function tickTexts(
  x: AxisLike,
  picks: readonly number[],
  maxChars = 12,
  moments: ReadonlyArray<TickMoment | null> = tickMoments(x),
): string[] {
  const out: string[] = [];
  let previousDay: string | null = null;
  for (const i of picks) {
    const m = moments[i];
    if (!m) {
      // A tick that cannot be placed says nothing about the day: the next one names it.
      previousDay = null;
      out[i] = xTickLabel(x, i, maxChars);
      continue;
    }
    if (m.clock === null) {
      previousDay = m.dayKey;
      out[i] = m.day;
      continue;
    }
    const newDay = m.dayKey !== previousDay;
    previousDay = m.dayKey;
    out[i] = !newDay ? m.clock : m.clock === '00:00' ? m.day : `${m.day} ${m.clock}`;
  }
  return out;
}

export interface XAxisTick {
  index: number;
  x: number;
  text: string;
}

export interface XAxisLayout {
  ticks: XAxisTick[];
  /** The centre of the "(in progress)" note under the newest bucket, else null. */
  inProgress: { x: number } | null;
}

export interface XAxisOptions {
  x: AxisLike;
  /** The centre of position `i`. */
  centre: (i: number) => number;
  /** Tick labels stay inside `[0, width]`. */
  width: number;
  /** The plot's width (how many category labels fit). */
  plotWidth: number;
  /** The newest bucket is still filling. */
  inProgress?: boolean;
  /** The advance of one tick glyph (11 px text by default). */
  charW?: number;
  /** The advance of one glyph of the note. */
  noteCharW?: number;
  /** A category tick is clipped past this many characters. */
  maxChars?: number;
}

const mod = (a: number, b: number) => ((a % b) + b) % b;

/**
 * Does a position whose wall-clock time is `wall` (see {@link TickMoment.wall}) start a
 * tick step of `minutes`? Steps under a week are whole multiples of the step on the wall
 * clock (00 · 06 · 12 · 18 for six hours). Longer steps follow the calendar: a week is a
 * Monday's midnight (the ISO week start, the day a weekly bucket reads), a fortnight every
 * other Monday, and the widest step the first day of a month. Epoch multiples would put
 * weekly ticks on Thursdays (1 January 1970 was one) and "monthly" ones on any date.
 */
export function onTickStep(wall: number, minutes: number): boolean {
  if (minutes < WEEK_MIN) return mod(wall, minutes * MINUTE_MS) === 0;
  if (mod(wall, DAY_MS) !== 0) return false;
  // Days since 1 January 1970 (a Thursday): day + 3 is a whole number of weeks on a Monday.
  const day = Math.floor(wall / DAY_MS);
  if (minutes === WEEK_MIN) return mod(day + 3, 7) === 0;
  if (minutes === FORTNIGHT_MIN) return mod(day + 3, 14) === 0;
  if (minutes === MONTH_MIN) return new Date(wall).getUTCDate() === 1;
  return mod(wall, minutes * MINUTE_MS) === 0;
}

/**
 * The candidate tick sets of a time axis, the most preferred first: every position when
 * few enough, then the regular clock times, then evenly stepped positions.
 *
 * Regular clock times (00 · 06 · 12 · 18 on an hourly axis; Mondays, then the first of
 * each month, on a long daily axis) are the positions whose wall-clock time in the axis's
 * zone starts a step (`onTickStep`), so they need every position placed in time
 * (`moments`). An axis read as its labels (months, quarters and years) has no moments and
 * keeps evenly stepped ticks.
 */
function timeCandidates(n: number, moments: ReadonlyArray<TickMoment | null>): number[][] {
  const out: number[][] = [];
  if (n <= MAX_X_TICKS) out.push(Array.from({ length: n }, (_, i) => i));
  if (n > 1 && moments.length === n && moments.every((m) => m !== null)) {
    const walls = (moments as TickMoment[]).map((m) => m.wall);
    const bucket = narrowestStep(walls);
    if (bucket !== null) {
      for (const m of LABEL_INTERVALS_MIN) {
        const iv = m * MINUTE_MS;
        // A step must hold whole buckets: a month of weekly buckets has no regular start.
        if (iv < bucket || iv % bucket !== 0) continue;
        const idx = walls.flatMap((w, i) => (onTickStep(w, m) ? [i] : []));
        if (idx.length >= 2 && idx.length <= MAX_X_TICKS) out.push(idx);
      }
    }
  }
  for (let step = Math.max(1, Math.ceil(n / MAX_X_TICKS)); step <= n; step += 1) {
    out.push(Array.from({ length: Math.ceil(n / step) }, (_, k) => k * step));
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Lay out an x axis: the ticks (positions, centres, texts) and the in-progress note. See
 * the module comment for the rule.
 */
export function layoutXAxis(o: XAxisOptions): XAxisLayout {
  const { x, centre, width } = o;
  const n = x.values.length;
  const charW = o.charW ?? CHAR_W;
  const noteCharW = o.noteCharW ?? charW;
  const maxChars = o.maxChars ?? 12;
  if (!n) return { ticks: [], inProgress: null };
  const isTime = x.kind === 'time';
  const moments = isTime ? tickMoments(x) : null;
  const categoryTexts = isTime ? null : x.values.map((_, i) => xTickLabel(x, i, maxChars));
  const textsFor = (set: readonly number[]): string[] =>
    categoryTexts ?? tickTexts(x, set, maxChars, moments ?? undefined);
  const place = (set: readonly number[]) => placeXLabels(set, textsFor(set), centre, width, charW);
  /** Drop what collides, then re-date what is left (a dropped tick can move a day). */
  const settle = (set: readonly number[]): XAxisTick[] => {
    let current = [...set];
    for (let guard = 0; guard <= n; guard += 1) {
      const placed = place(current);
      if (placed.length === current.length) return placed;
      current = placed.map((t) => t.index);
    }
    return place(current);
  };

  let ticks: XAxisTick[];
  if (isTime) {
    const chosen = timeCandidates(n, moments ?? []).find((set) => place(set).length === set.length) ?? [0];
    ticks = settle(chosen);
  } else {
    ticks = settle(pickXLabels(categoryTexts as string[], o.plotWidth));
  }
  if (!o.inProgress) return { ticks, inProgress: null };

  // The newest bucket gets its own tick with the note under it; a tick whose label would
  // sit over the note (and so read as the bucket in progress) is dropped. The note is
  // centred on that tick and only kept inside the figure: nothing else shares its row (a
  // line chart's end labels stay in the plot band, above the baseline).
  const noteW = IN_PROGRESS_NOTE.length * noteCharW;
  const last = n - 1;
  let set = [...ticks.map((t) => t.index).filter((i) => i !== last), last];
  for (let guard = 0; guard <= n; guard += 1) {
    const texts = textsFor(set);
    const lastText = texts[last] ?? '';
    const lw = lastText.length * charW;
    const lx = clamp(centre(last), lw / 2, width - lw / 2);
    const room = noteW <= width;
    const nx = clamp(lx, noteW / 2, width - noteW / 2);
    const left = room ? Math.min(lx - lw / 2, nx - noteW / 2) : lx - lw / 2;
    const others = set.filter((i) => i !== last);
    const placed = placeXLabels(others, texts, centre, width, charW);
    const kept = placed.filter((t) => t.x + (t.text.length * charW) / 2 + X_LABEL_GAP <= left);
    if (kept.length === others.length) {
      return {
        ticks: [...kept, { index: last, x: Math.round(lx), text: lastText }],
        inProgress: room ? { x: Math.round(nx) } : null,
      };
    }
    set = [...kept.map((t) => t.index), last];
  }
  return { ticks, inProgress: null };
}
