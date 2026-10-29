/**
 * Over-time widgets (Round 14, SPEC §4.4.3, §4.4.4):
 *
 * - `chart.case_trend`, `series`:
 *   - `flow` "Arrivals and closures": new cases and the cases closed by the AI agent
 *     (blue) and by a person (orange) per bucket, from `GET /api/metrics/trends`;
 *   - `alerts` "Alerts and cases over time": two labelled charts on one time axis, raw
 *     alerts ingested and cases created, from the same read;
 *   - `outcomes` "Outcomes over time": one metric family only, named in the caption
 *     ("AI verdicts" or "Analyst outcome", option `family`), from the exact breakdown
 *     engine, with one line accounting for what the bars leave out.
 * - `chart.severity_trend` "Cases by severity over time": case counts stacked by
 *   severity level, from the breakdown engine, hourly within a day (as Outcomes over time
 *   is) and daily otherwise, unless the operator chose daily or weekly.
 *
 * Buckets are case ARRIVAL buckets: a case counts in the bucket it was created in. The
 * newest bucket is still filling and is marked so. Everything is an aggregate count
 * (#7); labels are plain text (#9).
 */
import { fmtNumber } from '@/lib/format';
import type { MetricsTrends } from '@/lib/types';
import type { MetricsBreakdown, MetricsBreakdownGroup } from '@/lib/types-dashboards';

import { useDashboardData, useDashboardRequest } from '../DashboardDataProvider';
import type { DashboardRequest } from './requests';
import {
  BOARD_CHART_HEIGHT,
  BoardChart,
  bucketDisplayLabel,
  bucketWords,
  buildChartBlock,
  trendsBucket,
} from './chart';
import { WidgetShell, countOf, optionChoice, requestState, resolveTitle, staleOf, type WidgetProps, type WidgetState } from './common';
import { CASE_TREND_SERIES, caseTrendTitle, outcomeBucket, severityTrendRequest } from './widget-requests';
import { finiteOrNull, trendsGap, trendsSplitReported } from './trends-data';

// --------------------------------------------------------------------------- //
// Trends (flow, alerts)
// --------------------------------------------------------------------------- //

/** The time axis of a trends answer: ISO bucket starts, the kit's bucket, in UTC. */
function trendsAxis(trends: MetricsTrends) {
  const values = trends.buckets.map((b) => {
    const ms = Date.parse(String(b.t ?? ''));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : String(b.t ?? '');
  });
  const bucket = trendsBucket(finiteOrNull(trends.bucket_minutes) ?? undefined);
  return bucket
    ? ({ kind: 'time', values, bucket, tz: 'UTC' } as const)
    : ({ kind: 'category', values: values.map((v) => v.slice(5, 16).replace('T', ' ')) } as const);
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/** The bucket noun for a trends `bucket_minutes` ("hours", "days"), for a sentence. */
function bucketNoun(minutes: number | null): string {
  if (minutes === 60) return 'hours';
  if (minutes === 1440) return 'days';
  return 'buckets';
}

/**
 * The alert series of a trends answer, read honestly: the measured total, and how many
 * buckets were never measured (`null`, drawn hatched; the alert counters started later).
 * A total over a series with unmeasured buckets is a lower bound, never an exact count.
 */
export function alertSeriesFacts(trends: MetricsTrends): { total: number | null; unmeasured: number } {
  const values = trends.buckets.map((b) => finiteOrNull(b.alerts));
  const measured = values.filter((v): v is number => v != null);
  return {
    total: measured.length ? measured.reduce((a, v) => a + v, 0) : null,
    unmeasured: values.length - measured.length,
  };
}

function FlowBody({ trends, title }: { trends: MetricsTrends; title: string }) {
  const axis = trendsAxis(trends);
  const split = trendsSplitReported(trends.buckets);
  const series = [
    { key: 'ai', label: 'AI closed', values: trends.buckets.map((b) => finiteOrNull(b.auto_closed)) },
    ...(split
      ? [{ key: 'human', label: 'Human closed', values: trends.buckets.map((b) => finiteOrNull(b.human_closed)) }]
      : [{ key: 'closed', label: 'All closed', values: trends.buckets.map((b) => finiteOrNull(b.closed)) }]),
    { key: 'other', label: 'New cases', values: trends.buckets.map((b) => finiteOrNull(b.new_cases)) },
  ];
  const block = buildChartBlock({ id: 'case-flow', title, kind: 'line', x: axis, series, lastInProgress: true });
  if (!block) return null;
  return <BoardChart block={block} title={title} height={BOARD_CHART_HEIGHT} />;
}

function AlertsBody({ trends }: { trends: MetricsTrends }) {
  const axis = trendsAxis(trends);
  const alerts = trends.buckets.map((b) => finiteOrNull(b.alerts));
  const anyAlerts = alerts.some((v) => v != null);
  const alertsBlock = anyAlerts
    ? buildChartBlock({
        id: 'alerts-ingested',
        title: 'Alerts ingested',
        kind: 'bar',
        x: axis,
        series: [{ key: 'alerts', label: 'Alerts ingested', values: alerts }],
        lastInProgress: true,
      })
    : null;
  const casesBlock = buildChartBlock({
    id: 'cases-created',
    title: 'Cases created',
    kind: 'bar',
    x: axis,
    series: [{ key: 'cases', label: 'Cases created', values: trends.buckets.map((b) => finiteOrNull(b.new_cases)) }],
    lastInProgress: true,
  });
  return (
    <div className="grid gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Alerts</h3>
      {alertsBlock ? (
        <BoardChart block={alertsBlock} title="Alerts ingested" height={140} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Not measured. The alert counters have not counted this window yet.
        </p>
      )}
      <h3 className="mt-1 text-xs font-medium text-muted-foreground">Cases</h3>
      {casesBlock ? <BoardChart block={casesBlock} title="Cases created" height={120} /> : null}
    </div>
  );
}

function TrendsWidget({ title, series }: { title: string; series: 'flow' | 'alerts' }) {
  const { windowInfo, windowHours, retry } = useDashboardData();
  const req: DashboardRequest = { key: 'trends' };
  const answer = useDashboardRequest({ key: 'trends' });
  const trends = answer.data;
  const onRetry = () => retry(req);
  let state: WidgetState | null = requestState(answer, onRetry);
  const gap = !state && trends ? trendsGap(trends, windowHours) : null;
  if (gap) state = { kind: 'unavailable', title: 'Not available for this window', description: gap };
  const buckets = trends?.buckets ?? [];
  const created = sum(buckets.map((b) => finiteOrNull(b.new_cases)));
  const alerts = trends ? alertSeriesFacts(trends) : { total: null, unmeasured: 0 };
  const alertTotal = alerts.total;
  if (!state && trends && created === 0 && (series === 'flow' || alertTotal == null || alertTotal === 0)) {
    state = { kind: 'empty', title: `No cases in the ${windowInfo.phrase}` };
  }
  const minutes = finiteOrNull(trends?.bucket_minutes);
  // The bucket size is stated only once the answer names it (never a placeholder).
  const caption = trends ? `${windowInfo.label} · ${bucketWords(minutes ?? undefined)} · times in UTC` : windowInfo.label;
  const truncated = trends?.truncated === true;
  const casesWord = truncated ? `at least ${countOf(created, 'case')}` : countOf(created, 'case');
  const alertLine = (() => {
    if (series !== 'alerts' || alertTotal == null) return null;
    if (alerts.unmeasured > 0) {
      const noun = bucketNoun(minutes);
      return (
        `At least ${countOf(alertTotal, 'alert')} and ${casesWord} in the ${windowInfo.phrase}. ` +
        `Hatched ${noun} were not measured: the alert counters started later.`
      );
    }
    return `${countOf(alertTotal, 'alert')} and ${casesWord} in the ${windowInfo.phrase}.`;
  })();
  const footer = [
    series === 'flow' ? 'Each case counts in the bucket it arrived in; the newest bucket is still filling.' : null,
    alertLine,
    truncated
      ? `Counted from the newest ${fmtNumber(trends?.fetched ?? 0)} of ${countOf(trends?.store_total ?? 0, 'case')}.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <WidgetShell
      title={title}
      caption={caption}
      exit={series === 'flow' ? { label: 'View cases', page: 'cases' } : { label: 'View logs', page: 'logs' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={footer || undefined}
    >
      {trends ? series === 'flow' ? <FlowBody trends={trends} title={title} /> : <AlertsBody trends={trends} /> : null}
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Breakdown series (outcomes, severity)
// --------------------------------------------------------------------------- //

/** Per-bucket value of `pick` summed over the groups that match `keep`. */
function perBucket(
  b: MetricsBreakdown,
  keep: (g: MetricsBreakdownGroup) => boolean,
  pick: (g: MetricsBreakdownGroup) => number | null,
): Array<number | null> {
  return b.buckets.map((bucket) => {
    let total = 0;
    let measured = false;
    for (const g of b.groups) {
      if (g.bucket !== bucket.label || !keep(g)) continue;
      const v = pick(g);
      if (v == null) continue;
      total += v;
      measured = true;
    }
    return measured ? total : 0;
  });
}

function categoryAxis(b: MetricsBreakdown) {
  return { kind: 'category' as const, values: b.buckets.map((bucket) => bucketDisplayLabel(bucket.label)) };
}

function lastInProgress(b: MetricsBreakdown): boolean {
  return b.buckets.length > 0 && b.buckets[b.buckets.length - 1].in_progress === true;
}

function partialNote(b: MetricsBreakdown): string | null {
  const notes: string[] = [];
  if (b.partial) notes.push(`Part of the cases could not be read, so these are lower bounds${b.partial_reason ? `: ${b.partial_reason.replace(/\.$/, '')}` : ''}.`);
  if (b.missing_created > 0 && !b.missing_in_total) {
    notes.push(
      `${countOf(b.missing_created, 'case')} ${b.missing_created === 1 ? 'has' : 'have'} no readable creation time and ${b.missing_created === 1 ? 'is' : 'are'} not shown.`,
    );
  }
  return notes.length ? notes.join(' ') : null;
}

const BUCKET_WORDS = { hour: 'hourly', day: 'daily', week: 'weekly' } as const;

export type OutcomeFamily = 'ai' | 'analyst';

/**
 * The outcomes chart's two stacked series and the line accounting for the rest, for one
 * metric family. AI verdicts and analyst outcomes are never mixed on one chart.
 */
export function outcomeSeries(b: MetricsBreakdown, family: OutcomeFamily) {
  const all = () => true;
  if (family === 'ai') {
    const tp = perBucket(b, (g) => g.key === 'TRUE_POSITIVE', (g) => g.count);
    const nh = perBucket(b, (g) => g.key === 'NEEDS_HUMAN', (g) => g.count);
    const fp = sum(perBucket(b, (g) => g.key === 'FALSE_POSITIVE', (g) => g.count));
    const none = sum(perBucket(b, (g) => g.key == null || g.key === '' || g.key === 'none', (g) => g.count));
    return {
      series: [
        { key: 'tp', label: 'True positive', semantic: 'true_positive' as const, values: tp },
        { key: 'nh', label: 'Needs human', semantic: 'needs_human' as const, values: nh },
      ],
      shown: sum(tp) + sum(nh),
      note:
        `False positives (${fmtNumber(fp)}) are left out so the threats stay visible.` +
        (none > 0 ? ` ${countOf(none, 'case')} ${none === 1 ? 'has' : 'have'} no AI verdict yet.` : ''),
    };
  }
  const tp = perBucket(b, all, (g) => g.analyst_tp);
  const ungraded = perBucket(b, all, (g) => g.analyst_ungraded);
  const benign = sum(perBucket(b, all, (g) => g.analyst_fp));
  return {
    series: [
      { key: 'tp', label: 'Confirmed true positive', semantic: 'true_positive' as const, values: tp },
      { key: 'other', label: 'Not graded', values: ungraded },
    ],
    shown: sum(tp) + sum(ungraded),
    note: `Analyst false positives (${fmtNumber(benign)}) are left out so the threats stay visible. Closes by an analyst policy count as not graded.`,
  };
}

function OutcomesWidget({ title, family }: { title: string; family: OutcomeFamily }) {
  const { windowInfo, windowHours, retry } = useDashboardData();
  const bucket = outcomeBucket(windowHours);
  const req: DashboardRequest = { key: 'breakdown', query: { by: 'verdict', bucket } };
  const answer = useDashboardRequest({ key: 'breakdown', query: { by: 'verdict', bucket } });
  const b = answer.data;
  const onRetry = () => retry(req);
  let state = requestState(answer, onRetry);
  if (!state && b && b.total === 0) state = { kind: 'empty', title: `No cases in the ${windowInfo.phrase}` };
  const out = b ? outcomeSeries(b, family) : null;
  const block =
    b && out
      ? buildChartBlock({
          id: 'outcomes',
          title,
          kind: 'stacked_bar',
          x: categoryAxis(b),
          series: out.series,
          lastInProgress: lastInProgress(b),
        })
      : null;
  const familyWord = family === 'ai' ? 'AI verdicts' : 'Analyst outcome';
  const caption = `${windowInfo.label} · ${BUCKET_WORDS[bucket]} · ${familyWord}`;
  const footer = b && out
    ? [`${countOf(b.total, 'case')} in the ${windowInfo.phrase}, ${fmtNumber(out.shown)} shown.`, out.note, partialNote(b)]
        .filter(Boolean)
        .join(' ')
    : undefined;
  return (
    <WidgetShell
      title={title}
      caption={caption}
      exit={{ label: 'View effectiveness', page: 'metrics', opts: { tab: 'effectiveness' } }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={footer}
    >
      {block ? <BoardChart block={block} title={title} height={210} /> : null}
    </WidgetShell>
  );
}

export function CaseTrendWidget(props: WidgetProps) {
  const series = optionChoice(props.options, 'series', CASE_TREND_SERIES, 'flow');
  const title = resolveTitle(props, caseTrendTitle(props.options));
  if (series === 'outcomes') {
    const family = optionChoice<OutcomeFamily>(props.options, 'family', ['ai', 'analyst'], 'ai');
    return <OutcomesWidget title={title} family={family} />;
  }
  return <TrendsWidget title={title} series={series} />;
}

// --------------------------------------------------------------------------- //
// Severity over time
// --------------------------------------------------------------------------- //

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
const SEVERITY_LABEL: Readonly<Record<(typeof SEVERITY_ORDER)[number], string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const KNOWN_SEVERITIES: ReadonlySet<string> = new Set(SEVERITY_ORDER);

/** A group whose severity could not be read (no band, or a band outside the five). */
function unknownSeverity(g: MetricsBreakdownGroup): boolean {
  return !KNOWN_SEVERITIES.has((g.key ?? '').toLowerCase());
}

/**
 * One stacked series per severity level the answer holds, in severity order, then one
 * "Unknown" series for the cases whose severity could not be read (an unreadable case
 * document), so the stacks add up to the population the caption states. The Unknown
 * series takes the chart kit's neutral colour (key `other`).
 */
export function severitySeries(b: MetricsBreakdown) {
  const present = new Set(b.groups.map((g) => (g.key ?? '').toLowerCase()));
  const levels = SEVERITY_ORDER.filter((level) => present.has(level)).map((level) => ({
    key: level,
    label: SEVERITY_LABEL[level],
    semantic: level,
    values: perBucket(b, (g) => (g.key ?? '').toLowerCase() === level, (g) => g.count),
  }));
  const unknown = perBucket(b, unknownSeverity, (g) => g.count);
  return sum(unknown) > 0 ? [...levels, { key: 'other', label: 'Unknown', values: unknown }] : levels;
}

export function SeverityTrendWidget(props: WidgetProps) {
  const title = resolveTitle(props, 'Cases by severity over time');
  const { windowInfo, windowHours, retry } = useDashboardData();
  // The registry names the same request, so the read starts before this body loads.
  const req = severityTrendRequest(props.options, windowHours) as DashboardRequest & { key: 'breakdown' };
  const bucket = (req.query?.bucket ?? 'day') as keyof typeof BUCKET_WORDS;
  const answer = useDashboardRequest(req);
  const b = answer.data;
  const onRetry = () => retry(req);
  let state = requestState(answer, onRetry);
  if (!state && b && b.total === 0) state = { kind: 'empty', title: `No cases in the ${windowInfo.phrase}` };
  const series = b ? severitySeries(b) : [];
  const block =
    b && series.length
      ? buildChartBlock({
          id: 'severity-trend',
          title,
          kind: 'stacked_bar',
          x: categoryAxis(b),
          series,
          lastInProgress: lastInProgress(b),
        })
      : null;
  const footer = b ? partialNote(b) : null;
  return (
    <WidgetShell
      title={title}
      caption={`${windowInfo.label} · ${BUCKET_WORDS[bucket] ?? 'daily'}${b ? ` · ${b.partial ? 'at least ' : ''}${countOf(b.total, 'case')}` : ''}`}
      exit={{ label: 'View cases', page: 'cases' }}
      state={state}
      stale={staleOf(answer, onRetry)}
      footer={footer ?? undefined}
    >
      {block ? <BoardChart block={block} title={title} height={BOARD_CHART_HEIGHT} /> : null}
    </WidgetShell>
  );
}
