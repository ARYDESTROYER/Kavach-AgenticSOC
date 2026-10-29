/**
 * Agent effectiveness: aggregate, read-only evidence about observed SOC outcomes.
 *
 * This surface intentionally has no synthetic score and never claims that the model
 * learned or caused a change. It mirrors the server's complete-day cohort, sample,
 * case-mix, and guardrail states without turning missing evidence into zero.
 *
 * Round 14 (SPEC §4.9, ask 8): `AgentEffectivenessPage` is the `#/effectiveness` page
 * (Analytics > Agent effectiveness): the page header (title, help tip, the Analytics time
 * range for Agent health, one refresh for both reports, freshness), then Agent health and
 * the observed outcomes, each module on the tinted panel. While the headline is still
 * collecting evidence, the detail modules (comparisons, guardrails, evidence quality,
 * daily evidence) fold behind one disclosure so the page does not open on a wall of
 * "collecting" rows. `AgentEffectivenessSummary` is the compact form Auto-tuning embeds.
 */
import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Scale,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import type {
  AgentComparisonMetric,
  AgentEvidenceStatus,
  AgentImprovementEvidence,
} from '@/lib/types';
import { DASH, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { LoadingState, Panel, PANEL_GAP } from '@/design-system';
import { LoadingBar } from '@/soc/components/LoadingBar';
import { ComparisonMetric, type ComparisonMetricStatus } from '@/soc/components/ComparisonMetric';
import {
  AgentOutcomeReview,
  type AgentOutcomeChange,
} from '@/soc/components/AgentOutcomeReview';
import {
  AgentOperationalOutcomes,
  SourceCoverageGuidance,
  TuningOutcomeContext,
  type AgentImprovementEvidenceWithOutcomes,
} from '@/soc/components/AgentOperationalOutcomes';
import { HealthDiagnostics } from '@/soc/components/HealthDiagnostics';
import { KpiTile } from '@/soc/components/KpiTile';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { RefreshButton } from '@/soc/components/RefreshButton';
import type { Navigate } from '@/soc/router';
import { humanizeMinutes } from './posture.format';
import { AnalyticsWindowPicker, StripPanel, UpdatedStamp, useAnalyticsWindow } from './analytics-shared';

type HeadlineState = AgentImprovementEvidence['headline']['state'];

const HEADLINE_COPY: Record<
  HeadlineState,
  { title: string; icon: LucideIcon; className: string; badge: 'success' | 'warning' | 'critical' | 'secondary' }
> = {
  improving: {
    title: 'Observed outcomes improved across both evidence domains',
    icon: TrendingUp,
    className: 'text-success-text',
    badge: 'success',
  },
  stable: {
    title: 'Observed outcomes are stable',
    icon: Scale,
    className: 'text-foreground',
    badge: 'secondary',
  },
  mixed: {
    title: 'Observed outcome shifts are mixed',
    icon: Scale,
    className: 'text-warning-text',
    badge: 'warning',
  },
  guardrail_breach: {
    title: 'A safety guardrail needs review',
    icon: AlertTriangle,
    className: 'text-critical-text',
    badge: 'critical',
  },
  insufficient_evidence: {
    title: 'Not enough evidence to assess change',
    icon: AlertTriangle,
    className: 'text-warning-text',
    badge: 'warning',
  },
};

function dayLabel(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/** Compact inclusive label for a half-open UTC reporting window. */
function dayRangeLabel(start: string, endExclusive: string): string {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${endExclusive}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${start} to ${endExclusive}`;
  }
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const month = (value: Date) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(value);
  const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();
  const sameMonth = sameYear && startDate.getUTCMonth() === endDate.getUTCMonth();
  if (sameMonth) {
    return `${month(startDate)} ${startDate.getUTCDate()} to ${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${month(startDate)} ${startDate.getUTCDate()} to ${month(endDate)} ${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
  }
  return `${month(startDate)} ${startDate.getUTCDate()}, ${startDate.getUTCFullYear()} to ${month(endDate)} ${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
}

function ratio(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : DASH;
}

function evidenceStatus(metric: AgentComparisonMetric): ComparisonMetricStatus {
  if (metric.current.status === 'enough_data' && metric.baseline.status === 'enough_data') {
    return 'sufficient';
  }
  if (metric.current.status === 'unavailable' || metric.baseline.status === 'unavailable') {
    return 'unavailable';
  }
  return 'insufficient';
}

function metricValue(metric: AgentComparisonMetric, which: 'current' | 'baseline'): string {
  const value = metric[which].value;
  return metric.unit === 'ratio' ? ratio(value) : humanizeMinutes(value);
}

function metricDelta(metric: AgentComparisonMetric) {
  if (metric.direction === 'insufficient_evidence') return undefined;
  const points = metric.delta.percentage_points;
  if (typeof points === 'number' && Number.isFinite(points)) {
    const rounded = Math.round(points * 10) / 10;
    return { value: rounded, label: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} pp` };
  }
  const relative = metric.delta.relative;
  if (typeof relative === 'number' && Number.isFinite(relative)) {
    const percent = Math.round(relative * 1000) / 10;
    return { value: percent, label: `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%` };
  }
  return undefined;
}

function domainLabel(value: string): string {
  if (value === 'insufficient_evidence') return 'Collecting evidence';
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function domainVariant(value: string): 'success' | 'warning' | 'critical' | 'secondary' {
  if (value === 'improving') return 'success';
  if (value === 'regressing') return 'critical';
  if (value === 'insufficient_evidence') return 'warning';
  return 'secondary';
}

function evidenceLabel(status: AgentEvidenceStatus, breached: boolean | null): string {
  if (status === 'enough_data') {
    if (breached === null) return 'Comparison unavailable';
    return breached ? 'Guardrail breached' : 'Within threshold';
  }
  if (status === 'not_applicable') return 'Not applicable';
  if (status === 'unavailable') return 'Unavailable';
  return 'Collecting evidence';
}

/**
 * Whether either safety guardrail could be evaluated (enough data, or a breach the server
 * already reports). An evaluable guardrail stays visible while the headline is still
 * collecting evidence; only guardrails that are still collecting fold away.
 */
export function guardrailsEvaluable(data: AgentImprovementEvidence): boolean {
  const rows = [data.guardrails?.confirmed_false_negative_rate, data.guardrails?.reopen_after_agent_close_rate];
  return rows.some((g) => Boolean(g) && (g!.status === 'enough_data' || g!.breached === true));
}

function guardrailVariant(
  status: AgentEvidenceStatus,
  breached: boolean | null,
): 'success' | 'warning' | 'critical' | 'secondary' {
  if (status !== 'enough_data') return status === 'not_applicable' ? 'secondary' : 'warning';
  if (breached === null) return 'warning';
  return breached ? 'critical' : 'success';
}

function useAgentEffectiveness(refreshKey = 0) {
  const [data, setData] = React.useState<AgentImprovementEvidence | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getAgentImprovement());
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { data, loading, error, load };
}

export interface AgentEffectivenessSummaryProps {
  /** Opens the complete cohort, daily evidence, exclusions, and guardrail analysis. */
  onOpenFull: () => void;
  /** Increment to refresh this report alongside its parent surface. */
  refreshKey?: number;
  /** Applied tuning events shown as non-causal context inside the reporting window. */
  changes?: AgentOutcomeChange[];
}

/**
 * Compact, read-only outcome evidence for Auto-tuning. It deliberately keeps the
 * report separate from tuning policy: observed association can inform an operator,
 * but it never changes a rule or the deterministic case decision path.
 */
export function AgentEffectivenessSummary({
  onOpenFull,
  refreshKey = 0,
  changes = [],
}: AgentEffectivenessSummaryProps) {
  const { data, loading, error, load } = useAgentEffectiveness(refreshKey);
  const headline = data ? HEADLINE_COPY[data.headline.state] : null;
  const HeadlineIcon = headline?.icon ?? TrendingUp;
  const metrics = data?.metrics;
  const qualitySample = metrics?.analyst_reported_verdict_agreement.current.sample_count ?? 0;
  const turnaroundSample = metrics?.human_review_turnaround.current.sample_count ?? 0;

  return (
    <section
      aria-labelledby="tuning-outcomes-heading"
      aria-busy={loading}
      className="border-y border-border/70"
      data-testid="tuning-effectiveness-summary"
    >
      <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="tuning-outcomes-heading" className="text-md font-semibold text-foreground">
            Observed outcomes
          </h2>
          {headline && data ? (
            <>
              <p className="mt-2 text-lg font-semibold text-foreground">{headline.title}</p>
              <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted-foreground">
                {data.headline.reason}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              The latest seven complete UTC days compared with the preceding 28-day baseline.
            </p>
          )}
          {data ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Current{' '}
              {dayRangeLabel(
                data.windows.current.start,
                data.windows.current.end_exclusive,
              )}{' '}
              · baseline{' '}
              {dayRangeLabel(
                data.windows.baseline.start,
                data.windows.baseline.end_exclusive,
              )}{' '}
              · complete UTC days
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {headline && data ? (
            <Badge variant={headline.badge}>
              <HeadlineIcon className="h-3.5 w-3.5" aria-hidden />
              {domainLabel(data.headline.state)}
            </Badge>
          ) : null}
          {data?.synthetic ? (
            <Badge variant="warning">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Synthetic demo evidence
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onOpenFull}>
            View full evidence
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <LoadingBar
        active={loading && Boolean(data)}
        size="sm"
        label="Refreshing observed outcome evidence"
      />

      {loading && !data ? (
        <LoadingState
          label="Loading observed outcome evidence"
          description="Comparing complete UTC cohorts and safety guardrails."
          layout="panel"
          shape="panel"
        />
      ) : null}

      {error && !data ? (
        <div className="mb-4 space-y-2">
          <LoadError
            error={error}
            title="Observed outcomes are unavailable"
            fallback="The aggregate reporting endpoint could not be reached."
            onRetry={() => void load()}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Tuning controls remain available while this reporting-only evidence recovers.
          </p>
        </div>
      ) : null}

      {data && metrics && headline ? (
        <>
          <div className="grid gap-px border-t border-border/70 bg-border/70 xl:grid-cols-3">
            <ComparisonMetric
              label={metrics.analyst_reported_verdict_agreement.label}
              value={metricValue(metrics.analyst_reported_verdict_agreement, 'current')}
              prior={metricValue(metrics.analyst_reported_verdict_agreement, 'baseline')}
              priorLabel="28-day baseline"
              delta={metricDelta(metrics.analyst_reported_verdict_agreement)}
              goodDirection="up"
              accent="success"
              icon={CheckCircle2}
              sub={
                metrics.analyst_reported_verdict_agreement.current.reason ||
                'Source × severity mix adjusted'
              }
              status={evidenceStatus(metrics.analyst_reported_verdict_agreement)}
              sample={{ count: qualitySample, label: 'comparable grades' }}
              definition={metrics.analyst_reported_verdict_agreement.definition}
              definitionTriggerText="How"
              variant="integrated"
              testId="tuning-agent-agreement"
            />
            <ComparisonMetric
              label={metrics.material_analyst_correction_rate.label}
              value={metricValue(metrics.material_analyst_correction_rate, 'current')}
              prior={metricValue(metrics.material_analyst_correction_rate, 'baseline')}
              priorLabel="28-day baseline"
              delta={metricDelta(metrics.material_analyst_correction_rate)}
              goodDirection="down"
              accent="high"
              icon={Scale}
              sub={
                metrics.material_analyst_correction_rate.current.reason ||
                'Source × severity mix adjusted'
              }
              status={evidenceStatus(metrics.material_analyst_correction_rate)}
              sample={{
                count: metrics.material_analyst_correction_rate.current.sample_count,
                label: 'comparable grades',
              }}
              definition={metrics.material_analyst_correction_rate.definition}
              definitionTriggerText="How"
              variant="integrated"
              testId="tuning-agent-correction"
            />
            <ComparisonMetric
              label={metrics.human_review_turnaround.label}
              value={metricValue(metrics.human_review_turnaround, 'current')}
              prior={metricValue(metrics.human_review_turnaround, 'baseline')}
              priorLabel="28-day baseline"
              delta={metricDelta(metrics.human_review_turnaround)}
              goodDirection="down"
              accent="primary"
              icon={Clock3}
              sub={
                metrics.human_review_turnaround.current.reason ||
                'Median elapsed review time'
              }
              status={evidenceStatus(metrics.human_review_turnaround)}
              sample={{ count: turnaroundSample, label: 'human-reviewed cases' }}
              definition={metrics.human_review_turnaround.definition}
              definitionTriggerText="How"
              variant="integrated"
              testId="tuning-agent-turnaround"
            />
          </div>

          {data.outcomes ? <TuningOutcomeContext outcomes={data.outcomes} /> : null}

          <AgentOutcomeReview data={data} changes={changes} />

          {error ? (
            <LoadError
              error={error}
              title="Outcome refresh failed"
              fallback="The previous aggregate evidence remains visible."
              onRetry={() => void load()}
              className="mb-4"
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// =========================================================================== //
// The page (`#/effectiveness`)
// =========================================================================== //

/** The page title: the navigation label of `#/effectiveness` (one name per page, D25). */
const PAGE_TITLE = 'Agent effectiveness';

/** The header help tip (the page explains itself there, never in a line, C8). */
const PAGE_HELP =
  'Agent health over the selected range, then observed outcomes: the last seven complete ' +
  'UTC days against the 28 before. Reporting only; deterministic case decisions do not change.';

/** Whether the Agent health reads exist on this client (an older proxy may lack them). */
function healthAvailable(): boolean {
  return typeof api.diagnosticsHealth === 'function' || typeof api.autoCloseHealth === 'function';
}

export interface AgentEffectivenessPageProps {
  /** Kept for host parity; the page navigates nowhere today. */
  onNavigate?: Navigate;
}

/**
 * Analytics > Agent effectiveness: the page header, then Agent health (over the selected
 * range) and the observed outcome evidence (fixed complete-day cohorts). One refresh reads
 * both again.
 */
export function AgentEffectivenessPage(_props: AgentEffectivenessPageProps = {}) {
  const [hours, setHours] = useAnalyticsWindow();
  const [healthRefresh, setHealthRefresh] = React.useState(0);
  const evidence = useAgentEffectiveness();
  const { load } = evidence;
  const refresh = React.useCallback(() => {
    setHealthRefresh((n) => n + 1);
    void load();
  }, [load]);

  return (
    <PageContainer variant="wide">
      <PageHeader
        title={PAGE_TITLE}
        help={PAGE_HELP}
        controls={
          <>
            <AnalyticsWindowPicker hours={hours} onChange={setHours} />
            <RefreshButton
              display="icon"
              label="Refresh agent effectiveness"
              refreshing={evidence.loading && evidence.data !== null}
              disabled={evidence.loading}
              onClick={refresh}
            />
          </>
        }
        actions={<UpdatedStamp at={evidence.data?.generated_at} />}
      />
      {healthAvailable() ? <HealthDiagnostics windowHours={hours} refreshKey={healthRefresh} /> : null}
      <EvidenceReport {...evidence} />
    </PageContainer>
  );
}

/**
 * The observed outcome evidence on its own (it loads itself). `refreshKey` reads it again
 * when it changes.
 */
export default function AgentEffectiveness({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const evidence = useAgentEffectiveness(refreshKey);
  return <EvidenceReport {...evidence} />;
}

type EvidenceState = ReturnType<typeof useAgentEffectiveness>;

/** The day-range line of a reporting window: "Current Jul 21 to 27, 2026; baseline ...". */
function windowsLine(data: AgentImprovementEvidence): string {
  return (
    `Current ${dayRangeLabel(data.windows.current.start, data.windows.current.end_exclusive)}; ` +
    `baseline ${dayRangeLabel(data.windows.baseline.start, data.windows.baseline.end_exclusive)}; ` +
    'complete UTC days'
  );
}

function EvidenceReport({ data, loading, error, load }: EvidenceState) {
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsId = React.useId();

  if (loading && !data) {
    return (
      <LoadingState
        label="Loading agent effectiveness evidence"
        description="Comparing complete UTC cohorts and safety guardrails."
        layout="panel"
        shape="panel"
      />
    );
  }

  if (error && !data) {
    return (
      <LoadError
        error={error}
        title="Could not load agent effectiveness evidence"
        fallback="The aggregate evidence endpoint could not be reached."
        onRetry={() => void load()}
      />
    );
  }

  if (!data) return null;

  const headline = HEADLINE_COPY[data.headline.state];
  const HeadlineIcon = headline.icon;
  const collecting = data.headline.state === 'insufficient_evidence';
  const expandedEvidence = data as AgentImprovementEvidenceWithOutcomes;
  const hasOutcomes = Boolean(
    expandedEvidence.period_comparisons?.week_over_week?.outcomes ?? expandedEvidence.outcomes,
  );
  const showDetails = !collecting || detailsOpen;
  // A guardrail the server could evaluate is never folded away: the headline can say
  // "not enough evidence" (other domains are still collecting) while the false-negative
  // guardrail is already measured, even breached. Only rows still collecting fold.
  const guardrailEvaluable = guardrailsEvaluable(data);
  const foldedNames = guardrailEvaluable
    ? 'Outcome comparisons, evidence quality and the daily evidence are'
    : 'Outcome comparisons, safety guardrails, evidence quality and the daily evidence are';

  return (
    <div className={cn('flex flex-col', PANEL_GAP)} data-testid="agent-effectiveness">
      <Panel
        title="Observed outcomes"
        caption="last 7 complete UTC days against the 28 before"
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={headline.badge}>
              <HeadlineIcon className="size-3.5" aria-hidden />
              {domainLabel(data.headline.state)}
            </Badge>
            {data.synthetic ? (
              <Badge variant="warning">
                <Sparkles className="size-3.5" aria-hidden />
                Synthetic demo evidence
              </Badge>
            ) : null}
          </span>
        }
        data-testid="agent-effectiveness-headline"
      >
        <div className="space-y-2">
          <p className={cn('text-lg font-semibold', headline.className)}>{headline.title}</p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{data.headline.reason}</p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Observed agent-assisted triage outcomes only. This is not a model-learning score and does not
            establish that the agent caused the change.
          </p>
          <p className="text-sm tabular-nums text-muted-foreground">{windowsLine(data)}</p>
        </div>
        <dl className="mt-4 grid divide-y divide-border/70 border-t border-border/70 md:grid-cols-2 md:divide-x md:divide-y-0">
          {Object.entries(data.headline.signal_domains).map(([name, direction]) => (
            <div key={name} className="flex items-center justify-between gap-3 py-3 md:px-4 md:first:pl-0">
              <dt className="text-sm font-medium text-foreground">
                {name === 'analyst_grade_quality' ? 'Analyst-graded quality' : 'Human review turnaround'}
              </dt>
              <dd>
                <Badge variant={domainVariant(direction)}>{domainLabel(direction)}</Badge>
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      {error ? (
        <LoadError
          error={error}
          title="Refresh failed"
          fallback="The previous aggregate evidence remains visible."
          onRetry={() => void load()}
        />
      ) : null}

      {hasOutcomes ? (
        <Panel title="Operational outcomes" caption="complete UTC days" data-testid="agent-operational-outcomes">
          <AgentOperationalOutcomes evidence={expandedEvidence} />
        </Panel>
      ) : null}

      {collecting && guardrailEvaluable ? <SafetyGuardrails data={data} /> : null}

      {collecting ? (
        <Panel
          title="Evidence details"
          caption="collecting evidence"
          actions={
            <Button
              variant="outline"
              size="sm"
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {detailsOpen ? 'Hide details' : 'Show details'}
            </Button>
          }
          data-testid="agent-effectiveness-details-toggle"
        >
          <p className="text-sm text-muted-foreground">
            {foldedNames} still collecting the minimum samples. Open them to see what each one is
            waiting for.
          </p>
        </Panel>
      ) : null}

      {/* Always in the DOM, so the disclosure's aria-controls names an element that exists;
          `hidden` keeps the folded modules out of the layout and the accessibility tree. No
          display utility while hidden: a `flex` class would override the attribute. */}
      <div
        id={detailsId}
        hidden={!showDetails}
        className={showDetails ? cn('flex flex-col', PANEL_GAP) : undefined}
        data-testid="agent-effectiveness-details"
      >
        <OutcomeComparisons data={data} />
        {collecting && guardrailEvaluable ? null : <SafetyGuardrails data={data} />}
        <EvidenceQuality data={data} />
        <DailyEvidence data={data} />
      </div>

      <Panel title="Evidence coverage" data-testid="agent-coverage-guidance" className="[&>section]:border-y-0 [&>section]:py-0">
        <SourceCoverageGuidance evidence={expandedEvidence} />
      </Panel>

      <p className="text-sm text-muted-foreground" data-testid="agent-effectiveness-footer">
        Reporting only: deterministic case decisions are unchanged. No model calls or billing, and no
        case or source identifiers.
      </p>
    </div>
  );
}

function OutcomeComparisons({ data }: { data: AgentImprovementEvidence }) {
  const metrics = data.metrics;
  const qualitySample = metrics.analyst_reported_verdict_agreement.current.sample_count;
  const turnaroundSample = metrics.human_review_turnaround.current.sample_count;
  return (
    <Panel
      title="Outcome comparisons"
      caption="last 7 complete days against the 28 before"
      padding="none"
      data-testid="agent-outcome-comparisons"
    >
      <div className="grid divide-y divide-border/70 border-t border-border/70 xl:grid-cols-3 xl:divide-x xl:divide-y-0 [&>section]:border-y-0">
        <ComparisonMetric
          label={metrics.analyst_reported_verdict_agreement.label}
          value={metricValue(metrics.analyst_reported_verdict_agreement, 'current')}
          prior={metricValue(metrics.analyst_reported_verdict_agreement, 'baseline')}
          priorLabel="28-day baseline"
          delta={metricDelta(metrics.analyst_reported_verdict_agreement)}
          goodDirection="up"
          accent="success"
          icon={CheckCircle2}
          sub={metrics.analyst_reported_verdict_agreement.current.reason || 'Source × severity mix adjusted'}
          status={evidenceStatus(metrics.analyst_reported_verdict_agreement)}
          sample={{ count: qualitySample, label: 'comparable grades' }}
          definition={metrics.analyst_reported_verdict_agreement.definition}
          testId="agent-agreement"
        />
        <ComparisonMetric
          label={metrics.material_analyst_correction_rate.label}
          value={metricValue(metrics.material_analyst_correction_rate, 'current')}
          prior={metricValue(metrics.material_analyst_correction_rate, 'baseline')}
          priorLabel="28-day baseline"
          delta={metricDelta(metrics.material_analyst_correction_rate)}
          goodDirection="down"
          accent="high"
          icon={Scale}
          sub={metrics.material_analyst_correction_rate.current.reason || 'Source × severity mix adjusted'}
          status={evidenceStatus(metrics.material_analyst_correction_rate)}
          sample={{ count: metrics.material_analyst_correction_rate.current.sample_count, label: 'comparable grades' }}
          definition={metrics.material_analyst_correction_rate.definition}
          testId="agent-correction"
        />
        <ComparisonMetric
          label={metrics.human_review_turnaround.label}
          value={metricValue(metrics.human_review_turnaround, 'current')}
          prior={metricValue(metrics.human_review_turnaround, 'baseline')}
          priorLabel="28-day baseline"
          delta={metricDelta(metrics.human_review_turnaround)}
          goodDirection="down"
          accent="primary"
          icon={Clock3}
          sub={metrics.human_review_turnaround.current.reason || 'Median elapsed review time'}
          status={evidenceStatus(metrics.human_review_turnaround)}
          sample={{ count: turnaroundSample, label: 'human-reviewed cases' }}
          definition={metrics.human_review_turnaround.definition}
          testId="agent-turnaround"
        />
      </div>
    </Panel>
  );
}

function SafetyGuardrails({ data }: { data: AgentImprovementEvidence }) {
  const falseNegative = data.guardrails.confirmed_false_negative_rate;
  const reopen = data.guardrails.reopen_after_agent_close_rate;
  const rows: Array<{
    key: string;
    title: string;
    detail: string;
    current: string;
    baseline: string;
    status: AgentEvidenceStatus;
    breached: boolean | null;
  }> = [
    {
      key: 'false-negative',
      title: 'Confirmed false-negative rate',
      detail: falseNegative.definition,
      current: ratio(falseNegative.current.value),
      baseline: ratio(falseNegative.baseline.value),
      status: falseNegative.status,
      breached: falseNegative.breached,
    },
    {
      key: 'reopen',
      title: 'Reopen after agent close',
      detail: reopen.caveat,
      current: ratio(reopen.current.rate),
      baseline: ratio(reopen.baseline.rate),
      status: reopen.status,
      breached: reopen.breached,
    },
  ];
  return (
    <Panel title="Safety guardrails" caption="last 7 complete days against the 28 before" data-testid="agent-guardrails">
      <p className="text-sm text-muted-foreground">
        A favourable efficiency change is never promoted while an evaluable guardrail regresses.
      </p>
      <ul className="mt-3 divide-y divide-border/70 border-t border-border/70">
        {rows.map((row) => (
          <li key={row.key} className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{row.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
            </div>
            <div className="flex gap-5 text-sm tabular-nums text-muted-foreground">
              <span>
                Current <strong className="font-semibold text-foreground">{row.current}</strong>
              </span>
              <span>
                Baseline <strong className="font-semibold text-foreground">{row.baseline}</strong>
              </span>
            </div>
            <Badge variant={guardrailVariant(row.status, row.breached)}>{evidenceLabel(row.status, row.breached)}</Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EvidenceQuality({ data }: { data: AgentImprovementEvidence }) {
  const excluded = Object.values(data.exclusions).reduce((sum, count) => sum + count, 0);
  return (
    <div className={cn('flex flex-col', PANEL_GAP)}>
      <StripPanel title="Evidence quality" caption="cohort coverage and exclusions" data-testid="agent-evidence-quality">
        <KpiTile
          label="Comparable case mix"
          value={ratio(data.case_mix.comparable_mix_coverage, 0)}
          context="of cases in shared strata"
        />
        <KpiTile label="Shared strata" value={fmtNumber(data.case_mix.comparable_strata)} context="source and severity pairs" />
        <KpiTile label="Suppressed strata" value={fmtNumber(data.case_mix.suppressed_strata)} context="below the minimum size" />
        <KpiTile label="Excluded observations" value={fmtNumber(excluded)} context="not counted" />
      </StripPanel>
      {data.provenance.truncated ? (
        <div role="status" className="flex gap-2 text-sm text-warning-text">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          The case scan was truncated ({fmtNumber(data.provenance.fetched)} of {fmtNumber(data.provenance.store_total)}{' '}
          read), so the headline stays at not enough evidence.
        </div>
      ) : null}
    </div>
  );
}

function DailyEvidence({ data }: { data: AgentImprovementEvidence }) {
  const currentDays = data.daily_points.filter((point) => point.window === 'current').slice(-7);
  return (
    <Panel
      title="Current-window daily evidence"
      caption="times in UTC"
      padding="none"
      data-testid="agent-daily-evidence"
    >
      <p className="px-4 pb-3 text-sm text-muted-foreground xl:px-5 3xl:px-6">
        A day stays blank until it meets its own minimum evidence threshold.
      </p>
      {currentDays.length === 0 ? (
        <p className="border-t border-border/70 px-4 py-6 text-center text-sm text-muted-foreground xl:px-5 3xl:px-6">
          Daily evidence is not available yet.
        </p>
      ) : (
        <Table aria-label="Current seven-day agent effectiveness evidence" className="min-w-[44rem]" containerClassName="pb-2">
          <TableHeader>
            <TableRow>
              <TableHead density="compact" className="pl-4 xl:pl-5 3xl:pl-6">UTC day</TableHead>
              <TableHead density="compact" className="text-right">Agreement</TableHead>
              <TableHead density="compact" className="text-right">Correction</TableHead>
              <TableHead density="compact" className="text-right">Review p50</TableHead>
              <TableHead density="compact" className="text-right">Quality samples</TableHead>
              <TableHead density="compact" className="text-right">Review samples</TableHead>
              <TableHead density="compact" className="pr-4 xl:pr-5 3xl:pr-6">Evidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {currentDays.map((point) => (
              <TableRow key={point.date}>
                <TableCell density="compact" numeric className="pl-4 font-medium xl:pl-5 3xl:pl-6">
                  {dayLabel(point.date)}
                </TableCell>
                <TableCell density="compact" numeric className="text-right">{ratio(point.analyst_reported_agreement)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{ratio(point.correction_rate)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{humanizeMinutes(point.review_turnaround_p50_minutes)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{fmtNumber(point.quality_sample_count)}</TableCell>
                <TableCell density="compact" numeric className="text-right">{fmtNumber(point.turnaround_sample_count)}</TableCell>
                <TableCell density="compact" className="pr-4 xl:pr-5 3xl:pr-6">
                  <Badge variant={point.status === 'enough_data' ? 'success' : 'warning'}>
                    {point.status === 'enough_data' ? 'Enough data' : 'Collecting'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
