/**
 * Daily Agent Effectiveness evidence embedded in Auto-tuning.
 *
 * The period comparisons above this module are source × severity adjusted. These
 * lanes deliberately plot the raw eligible daily cohorts returned by the reporting
 * endpoint, preserve nulls as gaps, and describe tuning events as context only.
 */
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  History,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';

import type {
  AgentComparisonMetric,
  AgentEvidenceStatus,
  AgentImprovementDailyPoint,
  AgentImprovementEvidence,
} from '@/lib/types';
import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { MultiSeriesTrend } from '@/soc/components/charts-soc';
import { token } from '@/soc/components/palette';
import { SegmentedControl } from '@/soc/components/SegmentedControl';

export interface AgentOutcomeChange {
  id: string;
  at?: string | null;
  label: string;
  detail: string;
  state?: 'active' | 'rolled_back';
}

type LaneKey =
  | 'analyst_reported_agreement'
  | 'correction_rate'
  | 'review_turnaround_p50_minutes';

interface LaneConfig {
  key: LaneKey;
  label: string;
  shortLabel: string;
  unit: 'ratio' | 'minutes';
  goodDirection: 'up' | 'down';
  colorToken: 'success' | 'warning' | 'primary';
  sampleKey: 'quality_sample_count' | 'turnaround_sample_count';
  metric: AgentComparisonMetric;
}

function shortDay(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function longDay(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function ratio(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : DASH;
}

function minutes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DASH;
  if (value < 60) return `${Math.round(value)} min`;
  const hours = Math.floor(value / 60);
  const remaining = Math.round(value % 60);
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function formatValue(value: number | null, unit: LaneConfig['unit']): string {
  return unit === 'ratio' ? ratio(value, 1) : minutes(value);
}

function chartValue(point: AgentImprovementDailyPoint, config: LaneConfig): number | null {
  const raw = point[config.key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return config.unit === 'ratio' ? raw * 100 : raw;
}

function movementSummary(points: AgentImprovementDailyPoint[], config: LaneConfig) {
  const measurable = points
    .map((point) => ({ point, value: chartValue(point, config) }))
    .filter((entry): entry is { point: AgentImprovementDailyPoint; value: number } =>
      typeof entry.value === 'number',
    );
  if (measurable.length < 2) {
    return {
      label: 'Collecting daily evidence',
      className: 'text-muted-foreground',
      measurable: measurable.length,
    };
  }
  const first = measurable[0].value;
  const latest = measurable[measurable.length - 1].value;
  const delta = latest - first;
  const improving = config.goodDirection === 'up' ? delta > 0 : delta < 0;
  const regressing = config.goodDirection === 'up' ? delta < 0 : delta > 0;
  const magnitude = Math.abs(delta);
  const deltaLabel =
    config.unit === 'ratio'
      ? `${magnitude.toFixed(1)} pp`
      : magnitude < 1
        ? '<1 min'
        : `${Math.round(magnitude)} min`;
  return {
    label:
      Math.abs(delta) < 0.0001
        ? 'No first-to-latest change'
        : `${delta > 0 ? 'Up' : 'Down'} ${deltaLabel} · first to latest`,
    className: improving
      ? 'text-success-text'
      : regressing
        ? 'text-critical-text'
        : 'text-muted-foreground',
    measurable: measurable.length,
  };
}

function DailyMetricLane({
  points,
  config,
  currentStart,
  showXAxis,
}: {
  points: AgentImprovementDailyPoint[];
  config: LaneConfig;
  currentStart: string;
  showXAxis: boolean;
}) {
  const current = points.filter((point) => point.window === 'current');
  const movement = movementSummary(current, config);
  const rows = points.map((point) => ({
    x: shortDay(point.date),
    value: chartValue(point, config),
    date: point.date,
    sample: point[config.sampleKey],
  }));
  const overallMeasurable = rows.filter((row) => row.value !== null).length;
  const currentValue = formatValue(config.metric.current.value, config.unit);
  const baselineValue = formatValue(config.metric.baseline.value, config.unit);

  return (
    <article className="grid gap-3 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center">
      <div className="min-w-0">
        <h4 className="text-xs font-semibold text-foreground">{config.label}</h4>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="font-mono text-base font-semibold tabular-nums text-foreground">
            {currentValue}
          </span>
          <span className="text-2xs text-muted-foreground">vs {baselineValue}</span>
        </div>
        <p className={cn('mt-1 text-2xs font-medium', movement.className)}>
          {movement.label}
        </p>
        <p className="mt-1 text-2xs text-muted-foreground">
          {movement.measurable} of {current.length} current days measurable
        </p>
      </div>

      {overallMeasurable ? (
        <MultiSeriesTrend
          data={rows}
          series={[
            {
              key: 'value',
              label: config.shortLabel,
              color: token(config.colorToken),
            },
          ]}
          height={showXAxis ? 176 : 132}
          format={(value) =>
            config.unit === 'ratio' ? `${value.toFixed(0)}%` : `${Math.round(value)}m`
          }
          showXAxis={showXAxis}
          showYAxis
          showLegend={false}
          yDomain={config.unit === 'ratio' ? [0, 100] : [0, 'auto']}
          referenceX={shortDay(currentStart)}
          referenceXLabel={showXAxis ? 'Current 7d' : undefined}
          ariaLabel={`${config.label} raw daily trend across ${points.length} complete UTC days; missing days are gaps`}
          className="min-w-0"
        />
      ) : (
        <div
          role="img"
          aria-label={`${config.label} daily trend; no day has enough evidence`}
          className="flex h-20 items-center justify-center border-y border-dashed border-border/70 px-4 text-center text-xs text-muted-foreground"
        >
          No day meets the minimum evidence threshold yet.
        </div>
      )}
    </article>
  );
}

function guardrailLabel(status: AgentEvidenceStatus, breached: boolean | null): string {
  if (status === 'not_applicable') return 'Not applicable';
  if (status === 'unavailable') return 'Unavailable';
  if (status !== 'enough_data') return 'Collecting evidence';
  if (breached === null) return 'Comparison unavailable';
  return breached ? 'Guardrail breached' : 'Within threshold';
}

function EvidenceGate({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: 'pass' | 'watch' | 'breach' | 'neutral';
}) {
  const Icon = state === 'pass' ? CheckCircle2 : state === 'breach' ? AlertTriangle : ShieldCheck;
  return (
    <div className="flex items-start gap-2.5 py-2">
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          state === 'pass' && 'text-success',
          state === 'breach' && 'text-critical',
          state === 'watch' && 'text-warning',
          state === 'neutral' && 'text-muted-foreground',
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{value}</p>
      </div>
    </div>
  );
}

function changeDate(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function DailyEvidenceTable({
  points,
}: {
  points: AgentImprovementDailyPoint[];
}) {
  return (
    // Keep the table available to assistive technology without letting the table
    // layout algorithm widen a narrow document. `sr-only` on a table itself still
    // allows its intrinsic columns/caption to influence the page scroll width.
    <div className="sr-only">
      <table>
        <caption>Daily agent outcome evidence; unavailable values are not zero</caption>
        <thead>
          <tr>
            <th scope="col">UTC day</th>
            <th scope="col">Window</th>
            <th scope="col">Agreement</th>
            <th scope="col">Correction</th>
            <th scope="col">Review p50</th>
            <th scope="col">Quality sample</th>
            <th scope="col">Review sample</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <th scope="row">{point.date}</th>
              <td>{point.window}</td>
              <td>{ratio(point.analyst_reported_agreement, 1)}</td>
              <td>{ratio(point.correction_rate, 1)}</td>
              <td>{minutes(point.review_turnaround_p50_minutes)}</td>
              <td>{point.quality_sample_count}</td>
              <td>{point.turnaround_sample_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentOutcomeReview({
  data,
  changes = [],
}: {
  data: AgentImprovementEvidence;
  changes?: AgentOutcomeChange[];
}) {
  const points = data.daily_points;
  const lanes: LaneConfig[] = [
    {
      key: 'analyst_reported_agreement',
      label: 'Analyst-reported agreement',
      shortLabel: 'Agreement',
      unit: 'ratio',
      goodDirection: 'up',
      colorToken: 'success',
      sampleKey: 'quality_sample_count',
      metric: data.metrics.analyst_reported_verdict_agreement,
    },
    {
      key: 'correction_rate',
      label: 'Material correction rate',
      shortLabel: 'Correction',
      unit: 'ratio',
      goodDirection: 'down',
      colorToken: 'warning',
      sampleKey: 'quality_sample_count',
      metric: data.metrics.material_analyst_correction_rate,
    },
    {
      key: 'review_turnaround_p50_minutes',
      label: 'Human review turnaround',
      shortLabel: 'Review p50',
      unit: 'minutes',
      goodDirection: 'down',
      colorToken: 'primary',
      sampleKey: 'turnaround_sample_count',
      metric: data.metrics.human_review_turnaround,
    },
  ];
  const [selectedLane, setSelectedLane] = React.useState<LaneKey>(
    'analyst_reported_agreement',
  );
  const activeLane = lanes.find((lane) => lane.key === selectedLane) ?? lanes[0];
  const falseNegative = data.guardrails.confirmed_false_negative_rate;
  const reopen = data.guardrails.reopen_after_agent_close_rate;
  const excluded = Object.values(data.exclusions).reduce((sum, count) => sum + count, 0);
  const windowStart = Date.parse(`${data.windows.baseline.start}T00:00:00Z`);
  const windowEnd = Date.parse(`${data.windows.current.end_exclusive}T00:00:00Z`);
  const contextualChanges = changes
    .filter((change) => {
      const at = changeDate(change.at);
      return at !== null && at >= windowStart && at < windowEnd;
    })
    .sort((a, b) => (changeDate(b.at) ?? 0) - (changeDate(a.at) ?? 0))
    .slice(0, 3);
  const mixCoverage = data.case_mix.comparable_mix_coverage;
  const minimumCoverage = data.headline.minimum_comparable_mix_coverage;
  const reviewDecision =
    data.headline.state === 'guardrail_breach'
      ? {
          title: 'Hold rollout and inspect the safety regression',
          detail: 'A guardrail failed. Keep the current policy until the affected cases are reviewed.',
          tone: 'border-critical/60 text-critical-text',
        }
      : data.headline.state === 'improving'
        ? {
            title: 'Candidate improvement - ready for operator review',
            detail: 'Observed outcomes moved favorably and the available guardrails remained acceptable.',
            tone: 'border-success/60 text-success-text',
          }
        : data.headline.state === 'mixed'
          ? {
              title: 'Hold and inspect the mixed outcome shift',
              detail: 'At least one outcome improved while another did not. Review the cohort evidence before acting.',
              tone: 'border-warning/60 text-warning-text',
            }
          : data.headline.state === 'stable'
            ? {
                title: 'No material outcome change detected',
                detail: 'Keep collecting comparable evidence; there is no supported rollout decision yet.',
                tone: 'border-border text-foreground',
              }
            : {
                title: 'Collect more comparable evidence',
                detail: 'The reporting window does not yet support a trustworthy improvement claim.',
                tone: 'border-warning/60 text-warning-text',
              };

  return (
    <section
      aria-labelledby="daily-outcome-review-heading"
      className="grid border-t border-border/70 xl:grid-cols-3"
      data-testid="agent-outcome-review"
    >
      <div className="min-w-0 py-4 xl:col-span-2 xl:pr-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3
              id="daily-outcome-review-heading"
              className="inline-flex items-center gap-2 text-sm font-semibold text-foreground"
            >
              <TrendingUp className="h-4 w-4 text-primary" aria-hidden />
              Daily trajectory
            </h3>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Inspect one outcome at a time across {points.length || 35} complete UTC days.
              Missing evidence stays blank; the vertical rule starts the current seven-day window.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <Badge variant="outline" className="w-fit shrink-0">
              Raw daily cohorts
            </Badge>
            <SegmentedControl
              aria-label="Outcome metric"
              size="sm"
              value={selectedLane}
              onValueChange={setSelectedLane}
              options={lanes.map((lane) => ({
                value: lane.key,
                label: lane.shortLabel,
              }))}
            />
          </div>
        </div>

        <div className="mt-3 border-y border-border/70">
          <DailyMetricLane
            key={activeLane.key}
            points={points}
            config={activeLane}
            currentStart={data.windows.current.start}
            showXAxis
          />
        </div>

        <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
          Daily points use eligible cases for each UTC day and are not source × severity adjusted.
          The period comparisons above are mix adjusted. Observed movement is descriptive, not a
          causal claim.
        </p>
        <DailyEvidenceTable points={points} />
      </div>

      <div
        className="border-t border-border/70 py-4 xl:border-l xl:border-t-0 xl:pl-5"
        role="group"
        aria-label="Outcome evidence controls"
      >
        <div className={cn('border-l-2 py-1 pl-3', reviewDecision.tone)}>
          <p className="text-xs font-semibold">{reviewDecision.title}</p>
          <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
            {reviewDecision.detail}
          </p>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">Quality control</h3>
        </div>
        <div className="mt-2 divide-y divide-border/70">
          <EvidenceGate
            label="Comparable case mix"
            value={
              typeof mixCoverage === 'number'
                ? `${ratio(mixCoverage)} coverage · ${ratio(minimumCoverage)} required`
                : 'Comparable source × severity coverage is unavailable.'
            }
            state={
              typeof mixCoverage !== 'number'
                ? 'neutral'
                : mixCoverage >= minimumCoverage
                  ? 'pass'
                  : 'watch'
            }
          />
          <EvidenceGate
            label="Confirmed false negatives"
            value={guardrailLabel(falseNegative.status, falseNegative.breached)}
            state={
              falseNegative.breached
                ? 'breach'
                : falseNegative.status === 'enough_data'
                  ? 'pass'
                  : 'watch'
            }
          />
          <EvidenceGate
            label="Reopens after agent close"
            value={guardrailLabel(reopen.status, reopen.breached)}
            state={
              reopen.breached
                ? 'breach'
                : reopen.status === 'enough_data' || reopen.status === 'not_applicable'
                  ? 'pass'
                  : 'watch'
            }
          />
          <EvidenceGate
            label="Case-history scan"
            value={
              data.provenance.truncated
                ? `${data.provenance.fetched.toLocaleString()} of ${data.provenance.store_total.toLocaleString()} cases scanned · ${excluded.toLocaleString()} excluded · ${data.case_mix.suppressed_strata.toLocaleString()} strata suppressed`
                : `Complete scan · ${excluded.toLocaleString()} excluded · ${data.case_mix.suppressed_strata.toLocaleString()} strata suppressed`
            }
            state={data.provenance.truncated ? 'watch' : 'pass'}
          />
        </div>

        <details className="group mt-4 border-t border-border/70 pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="inline-flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" aria-hidden />
              Applied changes in reporting window
            </span>
            <span className="font-mono text-2xs font-normal text-muted-foreground">
              {contextualChanges.length}
            </span>
          </summary>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            Context only. Outcome attribution is not inferred.
          </p>
          {contextualChanges.length ? (
            <ol className="mt-3 divide-y divide-border/70 border-y border-border/70">
              {contextualChanges.map((change) => (
                <li key={change.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <time className="font-mono text-2xs text-muted-foreground" dateTime={change.at ?? undefined}>
                      {change.at ? longDay(new Date(change.at).toISOString().slice(0, 10)) : 'Unknown date'}
                    </time>
                    <Badge variant={change.state === 'rolled_back' ? 'secondary' : 'info'}>
                      {change.state === 'rolled_back' ? 'Rolled back' : 'Active'}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs font-medium text-foreground" title={change.label}>
                    {change.label}
                  </p>
                  <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                    {change.detail}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <div className="mt-3 flex gap-2 border-y border-dashed border-border/70 py-3 text-xs text-muted-foreground">
              <Database className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              No applied tuning change is recorded inside these comparison windows.
            </div>
          )}
        </details>
      </div>
    </section>
  );
}
