/**
 * Cost: the LLM spend page (`#/cost`, Analytics > Cost).
 *
 * Every model call goes through the single gateway and lands in the cost ledger; this page
 * reads `GET /api/usage/summary` (`api.usageSummary`) once per range and derives everything
 * else client-side: the spend strip, the actual execution tiers, spend over time, the ranked
 * breakdowns by model, role and surface, the detailed ledger with its composition donut,
 * and the top cost drivers.
 *
 * Round 14 (SPEC §4.9, ask 8): the Overview's grammar. The page header is the title, a help
 * tip, the Analytics time range and one refresh beside it, and the freshness on the right.
 * Below it: one KPI strip (spend, then efficiency after a strong rule), then modules on the
 * tinted panel. The Cost, Tokens and Calls switch lives in the breakdown module it ranks;
 * the ledger's dimension switch lives in the ledger. Bar percentages are shares of the
 * whole, never of the largest bar.
 *
 * Security: model ids and driver keys are technical, attacker-influenceable identifiers
 * and render as plain monospace text (`Identifier`, React text, never markup). Role and
 * surface labels are humanized enum
 * text (`tokenLabel`, acronyms kept) rendered plain. No untrusted string is injected as markup.
 */
import * as React from 'react';
import { CircleDollarSign } from 'lucide-react';

import type { Navigate } from '@/soc/router';
import { api } from '@/lib/api';
import { LoadingState, Panel, PANEL_GAP } from '@/design-system';
import { useDemo } from '@/soc/demo';
import type {
  UsageProcessingTier,
  UsageSummary,
  UsageTierBreakdown,
} from '@/lib/types';
import {
  DASH,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  fmtTokens,
} from '@/lib/format';
import { cn } from '@/lib/cn';

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { KpiTile, type KpiGoodDirection } from '@/soc/components/KpiTile';
import { KpiStrip } from '@/soc/components/KpiStrip';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { ChartCard, ChartEmpty } from '@/soc/components/ChartCard';
import { DonutChart, TrendArea, type DonutSegment } from '@/soc/components/charts';
import { DataTable, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { RefreshButton } from '@/soc/components/RefreshButton';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { categorical } from '@/soc/components/palette';

import {
  AnalyticsWindowPicker,
  shareOfTotal,
  tokenLabel,
  UpdatedStamp,
  useAnalyticsWindow,
  windowCaption,
} from './analytics-shared';

// --------------------------------------------------------------------------- //
// Local types + constants
// --------------------------------------------------------------------------- //

/** The page title: the navigation label of `#/cost` (one name per page, D25). */
const PAGE_TITLE = 'Cost';

/** The header help tip (the page explains itself there, never in a line, C8). */
const PAGE_HELP =
  'LLM spend recorded by the one gateway ledger: totals, the execution tier each call ' +
  'actually ran on, and the spend by model, role and surface over the selected range.';

type UsageRow = { key: string; cost: number; tokens: number; calls: number };

/** Metric the breakdowns rank by. */
type Metric = 'cost' | 'tokens' | 'calls';

/** The dimension shown in the detailed ledger + composition donut. */
type Dimension = 'model' | 'role' | 'surface' | 'drivers';

/** A ledger row enriched with the client-side derived efficiency columns. */
interface LedgerRow extends UsageRow {
  /** Fraction 0..1 of total cost this row accounts for. */
  share: number;
  /** Mean cost per LLM call (NaN when no calls). */
  avgCost: number;
  /** Cost per 1,000 tokens (NaN when no tokens). */
  costPerKTok: number;
}

const METRICS: { id: Metric; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'calls', label: 'Calls' },
];

const DIMENSIONS: { id: Dimension; label: string; verbatim: boolean }[] = [
  { id: 'model', label: 'Model', verbatim: true },
  { id: 'role', label: 'Role', verbatim: false },
  { id: 'surface', label: 'Surface', verbatim: false },
  { id: 'drivers', label: 'Top drivers', verbatim: true },
];

/** Donuts with more than this many slices roll the tail into "Other". */
const MAX_DONUT_SLICES = 6;

/** How many rows a ranked breakdown shows. */
const BREAKDOWN_ROWS = 8;

const TIER_ORDER: UsageProcessingTier[] = ['standard', 'flex', 'batch', 'unconfirmed'];
const TIER_META: Record<
  UsageProcessingTier,
  { label: string; description: string; dot: string; bar: string }
> = {
  standard: {
    label: 'Standard',
    description: 'Normal provider service',
    dot: 'bg-muted-foreground',
    bar: 'bg-muted-foreground',
  },
  flex: {
    label: 'Flex',
    description: 'Actual Flex execution',
    dot: 'bg-success',
    bar: 'bg-success',
  },
  batch: {
    label: 'Batch',
    description: 'Actual async Batch execution',
    dot: 'bg-info',
    bar: 'bg-info',
  },
  unconfirmed: {
    label: 'Unconfirmed',
    description: 'Legacy or unknown attribution',
    dot: 'bg-medium',
    bar: 'bg-medium',
  },
};

// --------------------------------------------------------------------------- //
// Pure helpers (mirrors the legacy CostPage logic)
// --------------------------------------------------------------------------- //
/** Coerce a possibly-missing numeric field to a finite number (0 fallback). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Descending sort of ledger rows by the chosen metric (returns a copy). */
function sortRows(rows: UsageRow[] | undefined, by: Metric): UsageRow[] {
  if (!Array.isArray(rows)) return [];
  return [...rows].sort((a, b) => num(b?.[by]) - num(a?.[by]));
}

/** One hour in milliseconds (the ledger buckets spend by the hour). */
const HOUR_MS = 3_600_000;

/** Ranges up to this many hours chart hour by hour; longer ranges chart by local day. */
const HOURLY_CHART_MAX_HOURS = 48;

/** The spend of a range on a real time axis. */
export interface SpendTimeline {
  /** The range's length in hours. The grid holds one more slot: the hour in progress. */
  hours: number;
  /** Spend per hour over the whole range, zero-filled, oldest first. */
  hourly: number[];
  /** The chart's buckets: hours for a day-long range, local days beyond it. */
  buckets: Array<{ x: string; y: number }>;
  unit: 'hour' | 'day';
}

/**
 * Place the ledger's hourly spend (`cost_over_time`, only the hours that had spend) on
 * the range's own hourly grid, ending at the hour of `nowMs`, so empty hours count as
 * zero and the chart's axis is linear in time. A point outside the grid (clock skew
 * between browser and server) is clamped to the nearest edge, never dropped, so the
 * chart still sums to the range's spend. `null` when the server sent no series.
 */
export function spendTimeline(
  points: ReadonlyArray<{ ts: number; cost: number }> | undefined | null,
  windowHours: number,
  nowMs: number,
): SpendTimeline | null {
  if (!Array.isArray(points)) return null;
  const hours = Math.max(1, Math.round(Number.isFinite(windowHours) ? windowHours : 24));
  const end = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const start = end - hours * HOUR_MS;
  const hourly = new Array<number>(hours + 1).fill(0);
  for (const point of points) {
    const ts = Number(point?.ts);
    const cost = Number(point?.cost);
    if (!Number.isFinite(ts) || !Number.isFinite(cost)) continue;
    const slot = Math.min(hours, Math.max(0, Math.floor((ts - start) / HOUR_MS)));
    hourly[slot] += cost;
  }

  const unit: SpendTimeline['unit'] = hours <= HOURLY_CHART_MAX_HOURS ? 'hour' : 'day';
  const buckets: SpendTimeline['buckets'] = [];
  if (unit === 'hour') {
    const label = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    hourly.forEach((y, i) => buckets.push({ x: label.format(new Date(start + i * HOUR_MS)), y }));
  } else {
    const label = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    let key = '';
    hourly.forEach((y, i) => {
      const day = new Date(start + i * HOUR_MS);
      const dayKey = day.toDateString();
      if (dayKey !== key) {
        key = dayKey;
        buckets.push({ x: label.format(day), y: 0 });
      }
      buckets[buckets.length - 1].y += y;
    });
  }
  return { hours, hourly, buckets, unit };
}

/**
 * The percentage change of spend in the second half of the range against the first,
 * over the zero-filled hourly grid (real halves of time). Undefined when the grid is too
 * short or the first half had no spend to compare against.
 */
export function trendDelta(hourly: readonly number[]): number | undefined {
  if (!Array.isArray(hourly) || hourly.length < 4) return undefined;
  const mid = Math.floor(hourly.length / 2);
  const prev = hourly.slice(0, mid).reduce((s, v) => s + v, 0);
  const curr = hourly.slice(mid).reduce((s, v) => s + v, 0);
  if (prev <= 0) return undefined;
  return Math.round(((curr - prev) / prev) * 100);
}

/**
 * Total, mean and peak of a spend timeline. The mean is over the range's own length in
 * the chart's unit, not over its buckets: a 7-day range touches eight local calendar days
 * and a 24-hour range 25 hourly slots, and dividing by those partial edge buckets would
 * understate the rate ("Per day" is the range total over 7 days, not over 8).
 */
export function spendStats(timeline: SpendTimeline | null): { total: number; avg: number; peak: number } {
  if (!timeline || !timeline.buckets.length) return { total: 0, avg: 0, peak: 0 };
  let total = 0;
  let peak = -Infinity;
  timeline.buckets.forEach(({ y }) => {
    total += y;
    if (y > peak) peak = y;
  });
  const periods = timeline.unit === 'hour' ? timeline.hours : timeline.hours / 24;
  return { total, avg: periods > 0 ? total / periods : 0, peak: peak < 0 ? 0 : peak };
}

/**
 * Map ledger `by_*` rows to donut segments, valued + ordered by `by`. `verbatim`
 * keeps the raw key (model ids / drivers are technical identifiers shown
 * literally); otherwise the key is humanized for display.
 */
function metricSegments(
  rows: UsageRow[] | undefined,
  by: Metric,
  verbatim = false,
): DonutSegment[] {
  return sortRows(rows, by)
    .filter((r) => r && typeof r[by] === 'number')
    .map((r, i) => ({
      label: verbatim ? r.key : tokenLabel(r.key),
      value: num(r[by]),
      color: categorical(i),
    }));
}

/**
 * Build the cost-composition donut segments AND a raw-key → color map so the ledger
 * swatch / share-bar and the donut agree on color-as-identity. The top `MAX-1` keys by
 * cost keep a distinct categorical color; the tail folds into a single grey "Other"
 * slice. The color map is keyed by the RAW row key (not the re-sorted table position),
 * so re-sorting the ledger never recolors a key away from its donut slice.
 *
 * For the `drivers` dimension the rows are only the TOP-N cost drivers (a SUBSET of
 * spend), so a residual "Other cost" slice (= totalCost − shown) is appended and the
 * tail keys fold into it, making the ring + legend read share-of-TOTAL (matching the
 * "total cost" center) rather than share-of-drivers.
 */
export function buildComposition(
  rows: UsageRow[] | undefined,
  dimension: Dimension,
  verbatim: boolean,
  totalCost: number,
): { segments: DonutSegment[]; colorByKey: Map<string, string> } {
  const sorted = sortRows(rows, 'cost').filter((r) => r && typeof r.cost === 'number');
  const colorByKey = new Map<string, string>();
  const segments: DonutSegment[] = [];
  const otherColor = categorical(MAX_DONUT_SLICES);
  const foldAt = MAX_DONUT_SLICES - 1;
  const labelFor = (r: UsageRow) => (verbatim ? r.key : tokenLabel(r.key));

  const isDrivers = dimension === 'drivers';
  const willFold = isDrivers || sorted.length > MAX_DONUT_SLICES;
  const head = willFold ? sorted.slice(0, foldAt) : sorted;

  let shown = 0;
  head.forEach((r, i) => {
    const color = categorical(i);
    colorByKey.set(r.key, color);
    const value = num(r.cost);
    shown += value;
    segments.push({ label: labelFor(r), value, color });
  });

  if (willFold) {
    const tail = sorted.slice(foldAt);
    tail.forEach((r) => colorByKey.set(r.key, otherColor));
    if (isDrivers) {
      const residual = Math.max(0, totalCost - shown);
      if (residual > 1e-9) segments.push({ label: 'Other cost', value: residual, color: otherColor });
    } else if (tail.length) {
      const otherValue = tail.reduce((s, x) => s + Math.max(0, num(x.cost)), 0);
      segments.push({ label: `Other (${tail.length})`, value: otherValue, color: otherColor });
    }
  }
  return { segments, colorByKey };
}

/** Enrich + cost-order ledger rows with the derived efficiency columns. */
function toLedger(rows: UsageRow[], totalCost: number): LedgerRow[] {
  const denom = totalCost > 0 ? totalCost : 0;
  return sortRows(rows, 'cost').map((r) => {
    const cost = num(r.cost);
    const tokens = num(r.tokens);
    const calls = num(r.calls);
    return {
      key: r.key,
      cost,
      tokens,
      calls,
      share: denom > 0 ? cost / denom : 0,
      avgCost: calls > 0 ? cost / calls : NaN,
      costPerKTok: tokens > 0 ? (cost / tokens) * 1000 : NaN,
    };
  });
}

// --------------------------------------------------------------------------- //
// Small UI helpers
// --------------------------------------------------------------------------- //

/** A tiny inline "% of total" bar used inside the ledger table cell. */
function ShareBar({ share, color }: { share: number; color: string }) {
  const pct = Math.max(0, Math.min(100, share * 100));
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full opacity-80"
          style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%`, background: color }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {fmtPercent(share)}
      </span>
    </div>
  );
}

/**
 * A technical identifier (a model id, a cost driver key) on the panel: monospace, one
 * line, truncated with the full value in the tooltip. Plain React text, never markup.
 */
function Identifier({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('min-w-0 truncate font-mono text-sm text-foreground', className)} title={value}>
      {value}
    </span>
  );
}

/** One ranked list inside the breakdown module: a small heading over its bars. */
function BreakdownColumn({
  title,
  items,
  format,
  empty,
}: {
  title: string;
  items: BarListItem[];
  format: (n: number) => string;
  empty: string;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0 py-4 first:pt-0 last:pb-0 lg:py-0 lg:px-5 lg:first:pl-0 lg:last:pr-0">
      <h3 id={headingId} className="mb-3 text-sm font-semibold text-foreground">
        {title}
      </h3>
      {items.length ? <BarList items={items} format={format} /> : <ChartEmpty>{empty}</ChartEmpty>}
    </section>
  );
}

/** One committed read: the summary, the range it was read for and when. */
interface CostSnapshot {
  hours: number;
  data: UsageSummary;
  /** When the read was committed (ms), the end of the spend chart's time axis. */
  at: number;
  updatedAt: string;
}

interface CostProps {
  /** Drill-through navigation (kept for host parity; the page links nowhere today). */
  onNavigate?: Navigate;
}

// --------------------------------------------------------------------------- //
// Page
// --------------------------------------------------------------------------- //
export default function Cost(_props: CostProps = {}) {
  // While Demo Mode is on, the ledger is fed by the deterministic $0 mock model with
  // plausible synthetic figures; the money tiles say "simulated" so a viewer never reads
  // demo spend as real spend.
  const { active: demoActive } = useDemo();
  const [hours, setHours] = useAnalyticsWindow();
  const [metric, setMetric] = React.useState<Metric>('cost');
  const [dimension, setDimension] = React.useState<Dimension>('model');
  const [ledgerSort, setLedgerSort] = React.useState<SortState>({ id: 'cost', dir: 'desc' });

  // One committed read: the summary AND the range it was read for, so every caption names
  // the window of the figures on screen, never the range picked since (a failed or
  // in-flight read keeps the previous summary under its own captions).
  const [snapshot, setSnapshot] = React.useState<CostSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const data = snapshot?.data ?? null;
  const shownHours = snapshot?.hours ?? hours;
  const stale = snapshot !== null && snapshot.hours !== hours;
  const caption = windowCaption(shownHours);

  // Guard against a window-switch fetch race: each load takes a monotonic ticket and only
  // the LATEST-issued request may commit, so a slow earlier window can never clobber the
  // current one (nor apply after unmount).
  const reqRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const summary = await api.usageSummary(hours);
      if (reqId === reqRef.current) {
        const at = Date.now();
        setSnapshot({ hours, data: summary, at, updatedAt: new Date(at).toISOString() });
      }
    } catch (e) {
      if (reqId === reqRef.current) setError(e instanceof Error ? e.message : 'Failed to load usage.');
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [hours]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const currency = data?.currency;
  const totalCost = num(data?.total_cost);
  const totalTokens = num(data?.total_tokens);
  const callCount = num(data?.call_count);
  const hasTierAttribution = Array.isArray(data?.by_processing_tier);
  const tierRows = React.useMemo<UsageTierBreakdown[]>(
    () =>
      hasTierAttribution
        ? TIER_ORDER.map(
            (tier) =>
              data?.by_processing_tier?.find((row) => row.key === tier) ?? {
                key: tier,
                cost: 0,
                tokens: 0,
                calls: 0,
              },
          )
        : [],
    [data, hasTierAttribution],
  );
  const discountedCoverage = data?.discounted_tier_coverage;
  const tierAttribution = data?.processing_tier_attribution;

  // Spend over time on the range's own hourly grid (empty hours are zero).
  const timeline = React.useMemo(
    () => (snapshot ? spendTimeline(snapshot.data.cost_over_time, snapshot.hours, snapshot.at) : null),
    [snapshot],
  );
  const spendDelta = React.useMemo(() => (timeline ? trendDelta(timeline.hourly) : undefined), [timeline]);
  const spend = React.useMemo(() => spendStats(timeline), [timeline]);
  const hasTrend = Boolean(timeline?.hourly.some((v) => v > 0));

  // Ranked breakdowns, each row with its share of the whole the metric measures.
  const metricTotal = metric === 'cost' ? totalCost : metric === 'tokens' ? totalTokens : callCount;
  const fmtMetric = React.useCallback(
    (n: number): string =>
      metric === 'cost' ? fmtMoney(n, currency) : metric === 'tokens' ? fmtTokens(n) : fmtNumber(n),
    [metric, currency],
  );

  const barItems = React.useCallback(
    (rows: UsageRow[] | undefined, verbatim: boolean): BarListItem[] => {
      const segments = metricSegments(rows, metric, verbatim);
      const whole = metricTotal > 0 ? metricTotal : segments.reduce((s, x) => s + x.value, 0);
      // Bars use the shared accent gradient; categorical colour is the donut's job.
      return segments.slice(0, BREAKDOWN_ROWS).map((s) => ({
        label: s.label,
        value: s.value,
        sub: shareOfTotal(s.value, whole, fmtMetric),
      }));
    },
    [metric, metricTotal, fmtMetric],
  );

  const byModel = React.useMemo(() => barItems(data?.by_model as UsageRow[], true), [barItems, data]);
  const byRole = React.useMemo(() => barItems(data?.by_role as UsageRow[], false), [barItems, data]);
  const bySurface = React.useMemo(() => barItems(data?.by_surface as UsageRow[], false), [barItems, data]);

  // Top cost drivers: always ranked by cost (the module is about cost).
  const topDrivers = React.useMemo(
    () => sortRows(data?.top_cost_drivers as UsageRow[], 'cost').slice(0, 10),
    [data],
  );

  // ----- Active-dimension data (ledger + composition donut) -------------- //
  const dimMeta = React.useMemo(
    () => DIMENSIONS.find((d) => d.id === dimension) ?? DIMENSIONS[0],
    [dimension],
  );

  const dimensionRows = React.useMemo<UsageRow[]>(() => {
    const pick = (v: unknown): UsageRow[] => (Array.isArray(v) ? (v as UsageRow[]) : []);
    switch (dimension) {
      case 'role':
        return pick(data?.by_role);
      case 'surface':
        return pick(data?.by_surface);
      case 'drivers':
        return pick(data?.top_cost_drivers);
      case 'model':
      default:
        return pick(data?.by_model);
    }
  }, [data, dimension]);

  /** Enriched ledger rows, re-sorted by the table's own sort state. */
  const ledger = React.useMemo<LedgerRow[]>(() => {
    const rows = toLedger(dimensionRows, totalCost);
    const dir = ledgerSort.dir === 'asc' ? 1 : -1;
    const f = ledgerSort.id as keyof LedgerRow;
    return [...rows].sort((a, b) => {
      if (f === 'key') {
        return tokenLabel(a.key).localeCompare(tokenLabel(b.key)) * dir;
      }
      // NaN efficiency values sort to the bottom regardless of direction.
      const av = a[f] as number;
      const bv = b[f] as number;
      const an = Number.isFinite(av) ? av : -Infinity;
      const bn = Number.isFinite(bv) ? bv : -Infinity;
      return (an - bn) * dir;
    });
  }, [dimensionRows, totalCost, ledgerSort]);

  /** Composition donut segments + a stable raw-key → color map (shared with the ledger). */
  const composition = React.useMemo(
    () => buildComposition(dimensionRows, dimension, dimMeta.verbatim, totalCost),
    [dimensionRows, dimension, dimMeta.verbatim, totalCost],
  );
  const compositionSegments = composition.segments;
  /** The donut color for a ledger key (color-as-identity), falling back to its position. */
  const rowColor = React.useCallback(
    (key: string, fallbackIndex: number) => composition.colorByKey.get(key) ?? categorical(fallbackIndex),
    [composition],
  );

  // ----- Efficiency aggregates ------------------------------------------- //
  const overallAvgCost = callCount > 0 ? totalCost / callCount : NaN;
  const overallCostPerKTok = totalTokens > 0 ? (totalCost / totalTokens) * 1000 : NaN;
  const overallTokensPerCall = callCount > 0 ? totalTokens / callCount : NaN;

  // ----- Ledger columns -------------------------------------------------- //
  const columns = React.useMemo<DataTableColumn<LedgerRow>[]>(
    () => [
      {
        id: 'key',
        header: dimMeta.label,
        sortable: true,
        minWidth: '12rem',
        text: (r) => (dimMeta.verbatim ? r.key : tokenLabel(r.key)),
        cell: (r) => (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ background: rowColor(r.key, ledger.indexOf(r)) }}
              aria-hidden
            />
            {dimMeta.verbatim ? (
              <Identifier value={r.key} />
            ) : (
              <span className="truncate text-sm text-foreground">{tokenLabel(r.key)}</span>
            )}
          </div>
        ),
      },
      {
        id: 'cost',
        header: 'Cost',
        sortable: true,
        align: 'right',
        kind: 'number',
        width: '7rem',
        cell: (r) => <span className="font-semibold text-foreground">{fmtMoney(r.cost, currency)}</span>,
      },
      {
        id: 'share',
        header: 'Share of cost',
        sortable: true,
        width: '10rem',
        text: (r) => fmtPercent(r.share),
        cell: (r) => <ShareBar share={r.share} color={rowColor(r.key, ledger.indexOf(r))} />,
      },
      {
        id: 'tokens',
        header: 'Tokens',
        sortable: true,
        align: 'right',
        kind: 'number',
        width: '6rem',
        cell: (r) => <span className="text-muted-foreground">{fmtTokens(r.tokens)}</span>,
      },
      {
        id: 'calls',
        header: 'Calls',
        sortable: true,
        align: 'right',
        kind: 'number',
        width: '5.5rem',
        cell: (r) => <span className="text-muted-foreground">{fmtNumber(r.calls)}</span>,
      },
      {
        id: 'avgCost',
        header: 'Per call',
        sortable: true,
        align: 'right',
        kind: 'number',
        width: '7rem',
        cell: (r) =>
          Number.isFinite(r.avgCost) ? (
            <span className="text-foreground">{fmtMoney(r.avgCost, currency)}</span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
      {
        id: 'costPerKTok',
        header: 'Per 1K tokens',
        sortable: true,
        align: 'right',
        kind: 'number',
        width: '7.5rem',
        cell: (r) =>
          Number.isFinite(r.costPerKTok) ? (
            <span className="text-foreground">{fmtMoney(r.costPerKTok, currency)}</span>
          ) : (
            <span className="text-muted-foreground">{DASH}</span>
          ),
      },
    ],
    [currency, dimMeta.label, dimMeta.verbatim, ledger, rowColor],
  );

  const hasAny = callCount > 0 || totalCost > 0 || byModel.length > 0 || hasTrend;

  // ----- KPI strip: spend, then efficiency after a strong rule ----------- //
  const goodDown: KpiGoodDirection = 'down';
  const strip = (
    <KpiStrip label="Spend summary" data-testid="cost-kpi-strip">
      <KpiTile
        label="Total cost"
        value={fmtMoney(totalCost, currency)}
        context={`${caption}${demoActive ? ', simulated' : ''}`}
        // Spend is lower-is-better: the arrow tracks the true change (up = rose) and the
        // colour reads red on a rise and green on a fall. Never pre-negate the value.
        delta={
          typeof spendDelta === 'number' && spendDelta !== 0
            ? {
                value: spendDelta,
                label: `${spendDelta > 0 ? '+' : ''}${spendDelta}%`,
                period: 'second half of the range against the first',
              }
            : undefined
        }
        goodDirection={goodDown}
        testId="cost-total"
      />
      <KpiTile
        label="Tokens"
        value={fmtTokens(totalTokens)}
        context={`across ${fmtNumber(callCount)} ${callCount === 1 ? 'call' : 'calls'}, ${caption}`}
        testId="cost-tokens"
      />
      <KpiTile
        label="LLM calls"
        value={fmtNumber(callCount)}
        context={caption}
        testId="cost-calls"
      />
      <KpiTile
        label="Today"
        value={fmtMoney(num(data?.today_cost), currency)}
        context={demoActive ? 'simulated spend' : 'spend so far today'}
        testId="cost-today"
      />
      <KpiTile
        label="Per call"
        value={Number.isFinite(overallAvgCost) ? fmtMoney(overallAvgCost, currency) : DASH}
        context={`average, ${caption}`}
        breakBefore
        testId="cost-per-call"
      />
      <KpiTile
        label="Per 1K tokens"
        value={Number.isFinite(overallCostPerKTok) ? fmtMoney(overallCostPerKTok, currency) : DASH}
        context={`average, ${caption}`}
        testId="cost-per-1k"
      />
      <KpiTile
        label="Tokens per call"
        value={Number.isFinite(overallTokensPerCall) ? fmtTokens(overallTokensPerCall) : DASH}
        context={`prompt and completion, ${caption}`}
        testId="cost-tokens-per-call"
      />
    </KpiStrip>
  );

  const header = (
    <PageHeader
      title={PAGE_TITLE}
      help={PAGE_HELP}
      controls={
        <>
          <AnalyticsWindowPicker hours={hours} onChange={setHours} />
          <RefreshButton
            display="icon"
            label="Refresh usage"
            refreshing={loading && data !== null}
            disabled={loading}
            onClick={() => void load()}
          />
        </>
      }
      actions={<UpdatedStamp at={snapshot?.updatedAt} />}
    />
  );

  // ----- States ---------------------------------------------------------- //
  if (loading && !data) {
    return (
      <PageContainer variant="wide">
        {header}
        <LoadingState
          label="Loading cost data"
          description="Preparing spend, token usage, and model efficiency."
          layout="page"
          shape="page"
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer variant="wide">
      {header}

      {error ? (
        <LoadError
          error={error}
          title={
            stale
              ? `Could not load the ${windowCaption(hours)}; showing the ${windowCaption(shownHours)}`
              : 'Could not load usage'
          }
          onRetry={() => void load()}
        />
      ) : null}

      {error && !hasAny ? null : !hasAny ? (
        <Panel title="LLM spend" caption={caption}>
          <EmptyState
            compact
            state="no-data"
            icon={CircleDollarSign}
            title="No LLM spend recorded yet"
            description={`Nothing went through the gateway in the ${caption}. As the agent triages cases, cost and token usage appear here.`}
          />
        </Panel>
      ) : (
        <>
          {strip}

          {/* Actual execution tier: fixed ledger buckets, never policy inference. */}
          <Panel
            title="Execution tiers"
            caption={caption}
            aside={
              hasTierAttribution ? (
                <span className="tabular-nums" data-testid="cost-discounted-coverage">
                  Discounted call coverage{' '}
                  <span className="font-semibold text-foreground">{fmtPercent(num(discountedCoverage?.call_ratio))}</span>
                </span>
              ) : undefined
            }
          >
            <p className="text-sm text-muted-foreground">
              The service tier the gateway recorded for each call, not the requested pricing policy.
              {hasTierAttribution ? (
                <>
                  {' '}
                  <span className="tabular-nums">
                    {fmtPercent(num(discountedCoverage?.token_ratio))} of tokens ·{' '}
                    {fmtPercent(num(discountedCoverage?.cost_ratio))} of recorded spend
                  </span>{' '}
                  ran discounted.
                </>
              ) : null}
            </p>

            {hasTierAttribution ? (
              <>
                <div className="mt-3 grid divide-y divide-border/70 border-t border-border/70 sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4 xl:divide-x">
                  {tierRows.map((row) => {
                    const meta = TIER_META[row.key];
                    const share = callCount > 0 ? Math.max(0, Math.min(1, row.calls / callCount)) : 0;
                    return (
                      <div
                        key={row.key}
                        className="py-3 sm:pr-4 xl:px-4 xl:first:pl-0"
                        data-testid={`processing-tier-${row.key}`}
                      >
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span className={cn('size-2 rounded-full', meta.dot)} aria-hidden />
                          {meta.label}
                        </div>
                        <div className="mt-2 flex items-baseline gap-2">
                          <span className="text-xl font-semibold tabular-nums text-foreground">{fmtNumber(row.calls)}</span>
                          <span className="text-sm text-muted-foreground">{row.calls === 1 ? 'call' : 'calls'}</span>
                        </div>
                        <div className="mt-1 text-sm tabular-nums text-muted-foreground">
                          {fmtTokens(row.tokens)} tokens · {fmtMoney(row.cost, currency)}
                        </div>
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" title={`${fmtPercent(share)} of calls`} aria-hidden>
                          <div className={cn('h-full rounded-full', meta.bar)} style={{ width: `${share * 100}%` }} />
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">{meta.description}</p>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1 border-t border-border/70 pt-3 text-sm text-muted-foreground">
                  {tierAttribution?.fallback_attribution_available ? (
                    <span>{fmtNumber(num(tierAttribution.fallback_calls))} confirmed standard-tier fallbacks.</span>
                  ) : (
                    <span>
                      Standard execution is confirmed, but the current ledger cannot distinguish an intentional
                      standard request from a Flex fallback.
                    </span>
                  )}
                  {num(tierAttribution?.unconfirmed_calls) > 0 ? (
                    <span className="ml-1 text-medium-text">
                      {fmtNumber(num(tierAttribution?.unconfirmed_calls))}{' '}
                      {num(tierAttribution?.unconfirmed_calls) === 1 ? 'call has' : 'calls have'} legacy or unknown
                      tier attribution.
                    </span>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="mt-3 border-t border-border/70 pt-3 text-sm text-muted-foreground">
                Processing-tier attribution is unavailable from this backend response.
              </p>
            )}
          </Panel>

          {/* Spend over time, on the range's own time axis. */}
          <ChartCard
            title="Spend over time"
            caption={timeline ? `${caption}, ${timeline.unit === 'hour' ? 'hourly' : 'by day'}` : caption}
          >
            {timeline && hasTrend ? (
              <div className="space-y-4">
                <TrendArea
                  data={timeline.buckets}
                  height={200}
                  colorToken="primary"
                  format={(n) => fmtMoney(n, currency)}
                  ariaLabel={`Spend ${timeline.unit === 'hour' ? 'per hour' : 'per day'} over the ${caption}`}
                />
                <dl className="grid grid-cols-3 gap-4 border-t border-border/70 pt-4">
                  {[
                    { k: 'Range total', v: fmtMoney(spend.total, currency) },
                    { k: timeline.unit === 'hour' ? 'Per hour' : 'Per day', v: fmtMoney(spend.avg, currency) },
                    { k: timeline.unit === 'hour' ? 'Peak hour' : 'Peak day', v: fmtMoney(spend.peak, currency) },
                  ].map((s) => (
                    <div key={s.k}>
                      <dt className="text-sm text-muted-foreground">{s.k}</dt>
                      <dd className="mt-1 text-sm font-semibold tabular-nums text-foreground">{s.v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <ChartEmpty>
                {timeline
                  ? 'No spend over this range to chart.'
                  : 'This server does not report spend over time.'}
              </ChartEmpty>
            )}
          </ChartCard>

          {/* Ranked breakdowns: one module, one ranking switch. */}
          <Panel
            title="Spend breakdown"
            caption={caption}
            actions={
              <SegmentedControl<Metric>
                size="sm"
                value={metric}
                options={METRICS.map((m) => ({ value: m.id, label: m.label }))}
                onValueChange={setMetric}
                aria-label="Rank breakdowns by"
              />
            }
            data-testid="cost-breakdown"
          >
            <div className="grid divide-y divide-border/70 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
              <BreakdownColumn title="By model" items={byModel} format={fmtMetric} empty="No model spend." />
              <BreakdownColumn title="By role" items={byRole} format={fmtMetric} empty="No role spend." />
              <BreakdownColumn title="By surface" items={bySurface} format={fmtMetric} empty="No surface spend." />
            </div>
          </Panel>

          {/* Detailed ledger: the table bleeds to the panel edge. */}
          <Panel
            title="Detailed cost ledger"
            caption={caption}
            padding="none"
            actions={
              <SegmentedControl<Dimension>
                size="sm"
                value={dimension}
                options={DIMENSIONS.map((d) => ({ value: d.id, label: d.label }))}
                onValueChange={setDimension}
                aria-label="Breakdown dimension"
              />
            }
            data-testid="cost-ledger"
          >
            <DataTable<LedgerRow>
              columns={columns}
              rows={ledger}
              getRowId={(r, i) => `${r.key}-${i}`}
              sort={ledgerSort}
              onSortChange={setLedgerSort}
              density="compact"
              surface="panel"
              stickyFirstColumn
              ariaLabel={`Detailed cost ledger by ${dimMeta.label.toLowerCase()}`}
              emptyState={
                <EmptyState
                  compact
                  state="no-data"
                  title="Nothing to break down"
                  description={`No ${dimMeta.label.toLowerCase()} spend recorded in the ${caption}.`}
                />
              }
            />
          </Panel>

          <div className={cn('grid grid-cols-1 items-stretch lg:grid-cols-3', PANEL_GAP)}>
            <ChartCard title="Cost composition" caption={`${caption}, by ${dimMeta.label.toLowerCase()}`}>
              {compositionSegments.length ? (
                <>
                  <DonutChart
                    segments={compositionSegments}
                    height={200}
                    format={(n) => fmtMoney(n, currency)}
                    ariaLabel={`Cost composition by ${dimMeta.label.toLowerCase()}`}
                    center={
                      <div>
                        <div className="text-lg font-semibold tabular-nums text-foreground">{fmtMoney(totalCost, currency)}</div>
                        <div className="text-xs text-muted-foreground">total cost</div>
                      </div>
                    }
                  />
                  <ul className="mt-4 space-y-2 border-t border-border/70 pt-4">
                    {compositionSegments.map((s, i) => (
                      <li key={`${s.label}-${i}`} className="flex items-center gap-2 text-sm">
                        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color ?? categorical(i) }} aria-hidden />
                        {dimMeta.verbatim && !s.label.startsWith('Other (') && s.label !== 'Other cost' ? (
                          <Identifier value={s.label} />
                        ) : (
                          <span className="truncate text-foreground">{s.label}</span>
                        )}
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                          {totalCost > 0 ? fmtPercent(s.value / totalCost) : fmtMoney(s.value, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <ChartEmpty>No cost for this dimension.</ChartEmpty>
              )}
            </ChartCard>

            <ChartCard title="Top cost drivers" caption={`by cost, ${caption}`} className="lg:col-span-2">
              {topDrivers.length ? (
                <ul className="flex flex-col divide-y divide-border/70" aria-label="Top cost drivers">
                  {topDrivers.map((d, i) => (
                    <li key={`${d.key}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                      <span className="size-2 shrink-0 rounded-sm" style={{ background: categorical(i) }} aria-hidden />
                      <Identifier value={d.key} className="flex-1" />
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{fmtTokens(d.tokens)} tokens</span>
                      <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                        {fmtNumber(d.calls)} {d.calls === 1 ? 'call' : 'calls'}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{fmtMoney(d.cost, currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ChartEmpty>No individual cost drivers recorded in this range.</ChartEmpty>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </PageContainer>
  );
}
