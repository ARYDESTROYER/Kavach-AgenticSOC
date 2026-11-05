/**
 * Board charts (Round 14, SPEC §4.4.3, §4.4.4): every chart on a board is the Console's
 * own chart kit (the chat answer charts), so a board reads the same as an answer: the
 * one day label format ("Oct 1"), 2 to 4 lines named at their ends with no duplicate
 * legend, keyboard reading of every point, a data table for assistive technology, and
 * the newest bucket marked "in progress".
 *
 * A board chart lends the kit a card's controls with no "Group by", so a line chart
 * whose ends name every series draws no second legend, and it has no brush zoom (the
 * board's time range is its zoom), so it draws no zoom row and no zoom hint.
 *
 * Every board chart's y-axis gutter holds at least {@link BOARD_Y_AXIS_CHARS} tick
 * characters, so two board charts of the same width over the same buckets start their
 * plots at the same x and their ticks line up, whatever their highest tick ("4" or "40").
 *
 * A breakdown's buckets (hours, days, weeks in the operator zone) become a time axis of
 * the kit (`breakdownAxis`), so a board's breakdown charts read with the same dated ticks
 * as its trends charts: "Oct 27 21:00", "23:00", "Oct 28"; a day "Oct 21"; a week the
 * day it starts ("Oct 5"), with the ISO week kept in the tooltip and the data table.
 *
 * Helpers here are pure: they turn a server payload into a validated chart block (the
 * same parser answers go through, so a malformed block is refused, never drawn).
 */
import { CartesianChart, type CartesianKind } from '@/soc/chat/blocks/charts/CartesianChart';
import { ChartControlsContext, type ChartControls } from '@/soc/chat/blocks/charts/export-context';
import { instantOf, isoWeekStartMs, weekFullLabel, weekStartDay } from '@/soc/chat/blocks/format';
import { parseBlocks, type ChartBlock, type ChartSeries, type TimeBucket } from '@/soc/chat/blocks/schema';

export type BoardChartBlock = ChartBlock & { kind: CartesianKind };

/** A card's controls with nothing to add: the line ends name the series. */
const BOARD_CONTROLS: ChartControls = { groupBy: null, publishSeries: () => undefined };

/**
 * The narrowest y-axis gutter of a board chart, in tick characters: wide enough for
 * "200", "1.5k" and "100%", so board charts with such ticks share one plot edge.
 */
export const BOARD_Y_AXIS_CHARS = 4;

export function BoardChart({
  block,
  title,
  height,
  minAxisChars,
}: {
  block: BoardChartBlock;
  title: string;
  height: number;
  /**
   * A wider gutter than {@link BOARD_Y_AXIS_CHARS}, for charts that share an x axis and
   * whose ticks run longer (the wider of their tick texts, `yAxisOf(...).chars`).
   */
  minAxisChars?: number;
}) {
  return (
    <div className="min-w-0" data-board-chart={block.kind}>
      <ChartControlsContext.Provider value={BOARD_CONTROLS}>
        <CartesianChart
          block={block}
          title={title}
          height={height}
          minAxisChars={Math.max(BOARD_Y_AXIS_CHARS, minAxisChars ?? 0)}
          zoom={false}
        />
      </ChartControlsContext.Provider>
    </div>
  );
}

export interface ChartBlockInput {
  id: string;
  title: string;
  kind: CartesianKind;
  unit?: 'count' | 'usd' | 'percent' | 'minutes';
  x: { kind: 'time' | 'category'; values: string[]; bucket?: TimeBucket; tz?: string; labels?: string[]; label?: string };
  series: ChartSeries[];
  lastInProgress?: boolean;
}

/** A validated chart block, or `null` when the parser refuses it. */
export function buildChartBlock(input: ChartBlockInput): BoardChartBlock | null {
  const { blocks } = parseBlocks([
    {
      id: input.id,
      type: 'chart',
      kind: input.kind,
      title: input.title,
      unit: input.unit ?? 'count',
      provenance: 'code',
      artifact_kind: 'series',
      allowed_views: [input.kind, 'table'],
      x: input.x,
      series: input.series,
      last_in_progress: Boolean(input.lastInProgress),
    },
  ]);
  const block = blocks[0];
  return block && block.type === 'chart' ? (block as BoardChartBlock) : null;
}

/** The chart kit's bucket for a trends `bucket_minutes`, when it has one. */
export function trendsBucket(minutes: number | undefined): TimeBucket | null {
  switch (minutes) {
    case 60:
      return '1h';
    case 360:
      return '6h';
    case 1440:
      return '1d';
    default:
      return null;
  }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = new Set(MONTH_NAMES);
const DAY_RE = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/;
const HOUR_RE = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2}):(\d{2})$/;
const WEEK_RE = /^W(\d{1,2}) (\d{4})$/;

/**
 * A breakdown bucket label in the chart kit's day format: a day ("21 Oct 2026") reads
 * "Oct 21", an hour ("27 Oct 21:00") reads "Oct 27 21:00", a week ("W41 2026") reads the
 * day it starts ("Oct 5"), never the ISO week code. Anything else is shown as it came.
 */
export function bucketDisplayLabel(label: string): string {
  const day = DAY_RE.exec(label);
  if (day && MONTHS.has(day[2])) return `${day[2]} ${Number(day[1])}`;
  const hour = HOUR_RE.exec(label);
  if (hour && MONTHS.has(hour[2])) return `${hour[2]} ${Number(hour[1])} ${hour[3]}:${hour[4]}`;
  return weekStartDay(label) ?? label;
}

/**
 * The full name of a breakdown bucket for a tooltip and the data table: a week says which
 * week it is as well ("Week of Oct 5 (W41 2026)", the kit's own `weekFullLabel`, so a board
 * and a chat answer name a week alike); a day or an hour reads as its tick.
 */
export function bucketFullLabel(label: string): string {
  return weekFullLabel(label) ?? bucketDisplayLabel(label);
}

const BREAKDOWN_BUCKET: Readonly<Record<string, TimeBucket>> = { hour: '1h', day: '1d', week: '1w' };
const BREAKDOWN_HEADER: Readonly<Record<string, string>> = { hour: 'Hour', day: 'Day', week: 'Week' };
const pad2 = (n: number) => String(n).padStart(2, '0');

/** The four-digit year an ISO timestamp names, else null. */
function yearOf(iso: string | null | undefined): number | null {
  const m = /^(\d{4})-/.exec(iso ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * A bucketed breakdown's buckets as the chart kit's time axis, so its ticks follow the
 * kit's one time-axis rule (SPEC §4.4.4). The server cuts and names the buckets in the
 * operator zone, so each position's value is that bucket's wall-clock start written as
 * an instant the kit reads in UTC: the kit then dates its ticks by the operator's own
 * days, and names no zone (the axis carries no `tz`). An hour label carries no year: it
 * is taken from the window's end and counted back over a turn of the year. The tooltip
 * and table read `bucketFullLabel`. Returns `null` for a label the server grammar does
 * not hold, so the caller keeps its category axis.
 */
export function breakdownAxis(b: {
  bucket: string | null;
  buckets: ReadonlyArray<{ label: string }>;
  window_from?: string | null;
  window_to?: string | null;
}): ChartBlockInput['x'] | null {
  const bucket = b.bucket ? BREAKDOWN_BUCKET[b.bucket] : undefined;
  if (!bucket || !b.buckets.length) return null;
  const values: string[] = [];
  let year = yearOf(b.window_to) ?? yearOf(b.window_from) ?? new Date().getUTCFullYear();
  let laterMonth: number | null = null;
  // Walk back from the newest bucket so an hour label without a year keeps the right one.
  for (let i = b.buckets.length - 1; i >= 0; i -= 1) {
    const label = b.buckets[i].label.trim();
    let iso: string | null = null;
    const day = DAY_RE.exec(label);
    const hour = HOUR_RE.exec(label);
    const week = WEEK_RE.exec(label);
    if (bucket === '1d' && day && MONTHS.has(day[2])) {
      iso = `${day[3]}-${pad2(MONTH_NAMES.indexOf(day[2]) + 1)}-${pad2(Number(day[1]))}T00:00:00Z`;
    } else if (bucket === '1h' && hour && MONTHS.has(hour[2])) {
      const month = MONTH_NAMES.indexOf(hour[2]) + 1;
      if (laterMonth !== null && month > laterMonth) year -= 1;
      laterMonth = month;
      iso = `${year}-${pad2(month)}-${pad2(Number(hour[1]))}T${hour[3]}:${hour[4]}:00Z`;
    } else if (bucket === '1w' && week) {
      const ms = isoWeekStartMs(Number(week[2]), Number(week[1]));
      if (ms !== null) iso = new Date(ms).toISOString().replace('.000Z', 'Z');
    }
    // The kit's own timestamp grammar decides (it refuses a day the month does not have).
    if (iso === null || instantOf(iso) === null) return null;
    values.unshift(iso);
  }
  return {
    kind: 'time',
    values,
    bucket,
    labels: b.buckets.map((bk) => bucketFullLabel(bk.label)),
    label: BREAKDOWN_HEADER[b.bucket ?? ''],
  };
}

/** Words for a trends bucket, for a caption ("1h buckets"). */
export function bucketWords(minutes: number | undefined): string {
  if (minutes === 60) return 'hourly';
  if (minutes === 1440) return 'daily';
  if (typeof minutes === 'number' && minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour buckets`;
  return 'buckets';
}

/** The board's chart height for a module body. */
export const BOARD_CHART_HEIGHT = 236;
