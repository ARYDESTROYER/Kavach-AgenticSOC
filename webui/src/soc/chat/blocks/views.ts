/**
 * Client-side view switching (BLOCKS.md amendment 3, SPEC §7.3).
 *
 * "Show as <view>" re-renders the SAME data in another of the block's `allowed_views`
 * with no model call: a categories artifact can be an hbar, a bar or (≤ 6 segments) a
 * donut; a series can be a line, an area, columns, stacked columns or a sparkline; and
 * every tabular block can be shown as a table. Nothing here invents a value — a view
 * that the data cannot honestly support is simply not offered:
 *
 *   - a donut or a sparkline of several series, a donut of more than six parts;
 *   - a STACK or a DONUT of values that do not add up. Both draw a total (the stack
 *     height, the donut's centre and its shares), and a total of medians, rates, scores
 *     or durations is meaningless: "Median 12 min + p90 40 min = 52 min" reads as a fact
 *     and is not one. They are offered only for additive units (count, tokens, bytes,
 *     usd), or for percentages/ratios whose parts reconcile to the whole (a 100 % stack,
 *     a share-of-total donut).
 *
 * The server's `allowed_views` (SPEC §7.3) cannot tell whether series are additive, so
 * the client is the last guard: a block whose OWN kind fails the rule is drawn in the
 * nearest honest kind ({@link honestChart}) rather than with an invented total.
 */
import { blockTabular } from './export-helpers';
import type {
  AnswerBlock,
  BlockView,
  Cell,
  ChartBlock,
  ChartKind,
  ColumnType,
  TableBlock,
  TableColumn,
  ValueUnit,
} from './schema';
import { CHART_KINDS, LIMITS } from './schema';

export const VIEW_LABEL: Readonly<Record<BlockView, string>> = {
  bar: 'Columns',
  hbar: 'Horizontal bars',
  stacked_bar: 'Stacked columns',
  line: 'Line',
  area: 'Area',
  donut: 'Donut',
  sparkline: 'Sparkline',
  funnel: 'Funnel',
  kpi_group: 'Tiles',
  table: 'Table',
  heatmap: 'Heatmap',
  case_list: 'Case list',
  timeline: 'Timeline',
  entity: 'Entity card',
  mitre: 'ATT&CK view',
  guide: 'Guide',
  query: 'Query',
};

const isChartKind = (v: string): v is ChartKind => (CHART_KINDS as readonly string[]).includes(v);

/** Types whose data can always be shown as a table (the chart ↔ table toggle). */
const TABULAR_TYPES: ReadonlyArray<AnswerBlock['type']> = ['chart', 'heatmap', 'kpi_group', 'case_list', 'timeline'];

export function canShowTable(block: AnswerBlock): boolean {
  return TABULAR_TYPES.includes(block.type);
}

/** Units whose values sum to a meaningful total (a stack height, a donut centre). */
export const ADDITIVE_UNITS: readonly ValueUnit[] = ['count', 'tokens', 'bytes', 'usd'];

/** How far a set of percentage parts may drift from 100 (rounding at the source). */
const SHARE_TOLERANCE = 0.5;

/**
 * Do the parts reconcile to the whole (100 %, or 1 for a ratio)? Only then is a stack or
 * donut of percentages a part-to-whole picture. A STACK's parts are the series in each
 * x slot; a DONUT's parts are the categories of its one series. A slot or series with a
 * missing part says nothing either way (the renderer hatches it / withholds the total),
 * but at least one must reconcile, so an all-missing block is not waved through.
 */
function partsMakeWhole(block: ChartBlock, kind: 'stacked_bar' | 'donut'): boolean {
  const whole = block.unit === 'ratio' ? 1 : 100;
  const tolerance = block.unit === 'ratio' ? SHARE_TOLERANCE / 100 : SHARE_TOLERANCE;
  const groups: Array<ReadonlyArray<number | null | undefined>> =
    kind === 'donut' ? block.series.map((s) => s.values) : block.x.values.map((_, i) => block.series.map((s) => s.values[i]));
  let checked = 0;
  for (const parts of groups) {
    if (!parts.length || parts.some((v) => typeof v !== 'number' || !Number.isFinite(v))) continue;
    const sum = (parts as number[]).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - whole) > tolerance) return false;
    checked += 1;
  }
  return checked > 0;
}

/**
 * Can the block's values be summed into a total that means something, when drawn as
 * `kind` (a stack sums series per slot, a donut sums its categories)?
 */
export function isAdditive(block: ChartBlock, kind: 'stacked_bar' | 'donut' = 'stacked_bar'): boolean {
  if (ADDITIVE_UNITS.includes(block.unit)) return true;
  if (block.unit === 'percent' || block.unit === 'ratio') return partsMakeWhole(block, kind);
  // score and the duration units never add up (a sum of medians is not a total).
  return false;
}

/** Can this chart's data honestly be drawn as `kind`? */
export function chartKindFits(block: ChartBlock, kind: ChartKind): boolean {
  const single = block.series.length === 1;
  switch (kind) {
    case 'donut':
      return single && block.x.values.length <= LIMITS.donut_segments && block.x.kind === 'category' && isAdditive(block, 'donut');
    case 'stacked_bar':
      return isAdditive(block, 'stacked_bar');
    case 'sparkline':
    case 'funnel':
      return single;
    default:
      return true;
  }
}

/**
 * The block drawn in an honest kind: itself when its kind fits the data, otherwise the
 * nearest kind that cannot invent a total — grouped columns for a stack, horizontal
 * bars for a donut (both are in the same SPEC §7.3 artifact row), columns otherwise.
 */
export function honestChart(block: ChartBlock): ChartBlock {
  if (chartKindFits(block, block.kind)) return block;
  const fallback: ChartKind = block.kind === 'donut' ? 'hbar' : 'bar';
  return { ...block, kind: fallback };
}

/** {@link honestChart} for any block (identity for non-charts). */
export function honestBlock(block: AnswerBlock): AnswerBlock {
  return block.type === 'chart' ? honestChart(block) : block;
}

/**
 * The views the "Show as" menu offers for a block: its `allowed_views` minus `table`
 * (the table has its own toggle) and minus any view the data cannot support. The view
 * actually drawn is always offered (first when the parser put it first), even when it
 * is the honest stand-in for a kind the data could not support.
 */
export function switchableViews(block: AnswerBlock): BlockView[] {
  if (block.type !== 'chart') return [];
  const views = block.allowed_views.filter((v): v is ChartKind => v !== 'table' && isChartKind(v) && chartKindFits(block, v));
  const drawn = honestChart(block).kind;
  return views.includes(drawn) ? views : [drawn, ...views];
}

/** The block re-drawn as another allowed chart kind (its honest self for anything else). */
export function viewAs(block: AnswerBlock, view: BlockView): AnswerBlock {
  if (block.type === 'chart' && isChartKind(view) && view !== block.kind && chartKindFits(block, view)) {
    return { ...block, kind: view };
  }
  return honestBlock(block);
}

const COLUMN_FOR_TYPE: Partial<Record<AnswerBlock['type'], ColumnType[]>> = {
  // Times arrive already formatted in UTC by blockTabular, so they are text here.
  case_list: ['case', 'text', 'severity', 'verdict', 'status', 'risk', 'text'],
  timeline: ['text', 'text', 'text', 'text'],
  kpi_group: ['text', 'number', 'text', 'text'],
};

/**
 * The block's data as a `table` block (the "Show table" view and the Expand sheet's
 * table). Labels keep the source block's trust flag: a log-derived category is still
 * untrusted in the table (mono, never linkified, G7).
 */
export function tableBlockOf(block: AnswerBlock): TableBlock | null {
  if (block.type === 'table') return block;
  const tab = blockTabular(block);
  if (!tab) return null;
  const types = COLUMN_FOR_TYPE[block.type];
  const columns: TableColumn[] = tab.columns.map((c, i) => {
    const type: ColumnType = types?.[i] ?? (c.numeric ? 'number' : 'text');
    const col: TableColumn = { key: `c${i + 1}`, label: c.label, type, untrusted: false };
    if (c.numeric) {
      col.align = 'right';
      if (block.type === 'chart' || block.type === 'heatmap') col.unit = block.unit;
    }
    // The first column of a chart/heatmap carries the category labels; a kpi value
    // column carries mixed units, so it shows the raw number and its unit column.
    if (i === 0 && (block.type === 'chart' || block.type === 'heatmap')) col.untrusted = block.untrusted;
    if (block.type === 'timeline' && (i === 1 || i === 3)) col.untrusted = block.untrusted;
    if (block.type === 'case_list' && i === 1) col.untrusted = block.untrusted;
    return col;
  });
  const rows: Cell[][] = tab.rows.map((r) => r.map((c) => c));
  return {
    id: block.id,
    type: 'table',
    title: block.title,
    caption: block.caption,
    provenance: block.provenance,
    artifact_kind: 'table',
    allowed_views: ['table'],
    untrusted: block.untrusted,
    truncated: block.truncated,
    total: block.total,
    downsampled_for_storage: block.downsampled_for_storage,
    columns,
    rows,
  };
}
