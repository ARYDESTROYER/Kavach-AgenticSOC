/**
 * Board charts (Round 14, SPEC §4.4.3, §4.4.4): every chart on a board is the Console's
 * own chart kit (the chat answer charts), so a board reads the same as an answer: the
 * one day label format ("Oct 1"), 2 to 4 lines named at their ends with no duplicate
 * legend, keyboard reading of every point, a data table for assistive technology, and
 * the newest bucket marked "in progress".
 *
 * A board chart lends the kit a card's controls with no "Group by", so a line chart
 * whose ends name every series draws no second legend.
 *
 * Helpers here are pure: they turn a server payload into a validated chart block (the
 * same parser answers go through, so a malformed block is refused, never drawn).
 */
import { CartesianChart, type CartesianKind } from '@/soc/chat/blocks/charts/CartesianChart';
import { ChartControlsContext, type ChartControls } from '@/soc/chat/blocks/charts/export-context';
import { parseBlocks, type ChartBlock, type ChartSeries, type TimeBucket } from '@/soc/chat/blocks/schema';

export type BoardChartBlock = ChartBlock & { kind: CartesianKind };

/** A card's controls with nothing to add: the line ends name the series. */
const BOARD_CONTROLS: ChartControls = { groupBy: null, publishSeries: () => undefined };

export function BoardChart({ block, title, height }: { block: BoardChartBlock; title: string; height: number }) {
  return (
    <div className="min-w-0" data-board-chart={block.kind}>
      <ChartControlsContext.Provider value={BOARD_CONTROLS}>
        <CartesianChart block={block} title={title} height={height} />
      </ChartControlsContext.Provider>
    </div>
  );
}

export interface ChartBlockInput {
  id: string;
  title: string;
  kind: CartesianKind;
  unit?: 'count' | 'usd' | 'percent' | 'minutes';
  x: { kind: 'time' | 'category'; values: string[]; bucket?: TimeBucket; tz?: string; labels?: string[] };
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

const MONTHS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/**
 * A breakdown bucket label in the chart kit's day format: a day ("21 Oct 2026") reads
 * "Oct 21", an hour ("27 Oct 21:00") reads "Oct 27 21:00", a week ("W40 2026") stays as
 * the server names it. Anything else is shown as it came.
 */
export function bucketDisplayLabel(label: string): string {
  const day = /^(\d{1,2}) ([A-Z][a-z]{2}) \d{4}$/.exec(label);
  if (day && MONTHS.has(day[2])) return `${day[2]} ${Number(day[1])}`;
  const hour = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{2}:\d{2})$/.exec(label);
  if (hour && MONTHS.has(hour[2])) return `${hour[2]} ${Number(hour[1])} ${hour[3]}`;
  return label;
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
