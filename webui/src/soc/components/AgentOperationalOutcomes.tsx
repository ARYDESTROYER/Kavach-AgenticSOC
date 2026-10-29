/**
 * Optional operational-outcome evidence for Agent effectiveness.
 *
 * Older backends omit `outcomes` and `period_comparisons`; the established report
 * remains fully usable in that case. Every rendered value comes from the typed
 * additive contract. Case-level truth and alert-level counters stay separate, and
 * tuning is presented only as co-occurring context rather than causal attribution.
 *
 * Round 14 (SPEC §4.9, audit finding AN9): the module is one panel on the Overview's
 * grammar. Its title row carries the period switch ("Week over week", "Rolling 28 days");
 * the four headline comparisons are a KPI strip on the panel (rules only between tiles,
 * no framed cells); the supporting rows ("What supports these movements", "Evidence by
 * system layer" and the trend check) are sentence-case sections the page can fold into
 * its Show details disclosure (`detailsHidden`) while the headline is still collecting
 * evidence. Figures are Inter with tabular numerals; nothing here is an identifier, so
 * nothing is monospaced.
 */
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleMinus,
  CircleSlash2,
  Database,
  type LucideIcon,
} from 'lucide-react';

import type {
  AgentEvidenceStatus,
  AgentImprovementEvidence,
  AgentOperationalOutcomes as AgentOperationalOutcomesContract,
  AgentOutcomeDirection,
  AgentPeriodComparison,
  AgentPeriodComparisonMetric,
  AgentSourceGuidanceItem,
} from '@/lib/types';
import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';
import { Badge } from '@/ui/badge';
import { Panel, PANEL_PADDING_X } from '@/design-system/panel';
import { MetricDefinition, type MetricDefinitionDetails } from './ComparisonMetric';
import { KpiStripContext, KpiTile, KpiTileGrid, type KpiDelta, type KpiGoodDirection } from './KpiTile';
import { SegmentedControl } from './SegmentedControl';

/** The two equal-length comparisons the period switch picks between. */
export type OutcomePeriod = 'week_over_week' | 'month_over_month';

/** Kept as an exported alias for focused consumers/tests of the additive contract. */
export type AgentImprovementEvidenceWithOutcomes = AgentImprovementEvidence;

/**
 * A server reason as a sentence of its own: trimmed, with a capital first letter and a
 * closing full stop. The evidence contract sends short lowercase fragments ("requires at
 * least 10 human-owned and 10 agent closures"), and spliced into prose they ran on into
 * the next sentence. Empty in, empty out.
 */
export function asSentence(text: string | null | undefined): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** Sentences joined with one space, skipping the empty ones. */
function sentences(...parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}

/** The operational outcomes of one period, or the fixed-cohort outcomes of an older backend. */
export function outcomesForPeriod(
  evidence: AgentImprovementEvidenceWithOutcomes,
  period: OutcomePeriod,
): AgentOperationalOutcomesContract | undefined {
  return evidence.period_comparisons?.[period]?.outcomes ?? evidence.outcomes ?? undefined;
}

/**
 * Whether any of the four headline comparisons is still collecting its minimum sample
 * (`insufficient_evidence`). An unavailable or not applicable comparison is not
 * collecting: waiting longer will not give it a value.
 */
export function outcomesCollecting(outcomes: AgentOperationalOutcomesContract): boolean {
  return [
    outcomes.confirmed_positive_case_rate,
    outcomes.observed_time_saved,
    outcomes.alert_volume,
    outcomes.recorded_case_cost,
  ].some((comparison) => comparison.status === 'insufficient_evidence');
}

function formatRatio(value: number | null, digits = 1): string {
  return value === null ? DASH : `${(value * 100).toFixed(digits)}%`;
}

function formatCount(value: number | null, suffix = ''): string {
  if (value === null) return DASH;
  return `${Math.round(value).toLocaleString()}${suffix}`;
}

function formatCurrency(value: number | null): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function formatMinutes(value: number | null): string {
  if (value === null) return DASH;
  const absolute = Math.abs(value);
  if (absolute < 60) return `${Math.round(absolute)} min`;
  const hours = Math.floor(absolute / 60);
  const remaining = Math.round(absolute % 60);
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function formatElapsedDifference(value: number | null): string {
  if (value === null) return DASH;
  if (Math.abs(value) < 0.05) return 'No difference';
  return value > 0
    ? `${formatMinutes(value)} faster / case`
    : `${formatMinutes(value)} slower / case`;
}

function formatAggregateElapsedDifference(value: number | null): string {
  if (value === null) return DASH;
  if (Math.abs(value) < 0.05) return 'No aggregate difference';
  return value > 0
    ? `${formatMinutes(value)} estimated avoided`
    : `${formatMinutes(value)} slower aggregate`;
}

function relativeDelta(value: number | null): KpiDelta | undefined {
  if (value === null) return undefined;
  const percent = Math.round(value * 1000) / 10;
  return { value: percent, label: `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%` };
}

function pointsDelta(value: number | null): KpiDelta | undefined {
  if (value === null) return undefined;
  const rounded = Math.round(value * 10) / 10;
  return { value: rounded, label: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} pp` };
}

function minutesDelta(value: number | null): KpiDelta | undefined {
  if (value === null) return undefined;
  const rounded = Math.round(value * 10) / 10;
  // A change that rounds to nothing is said in words: the figure read "0.0 min / case"
  // and was announced "unchanged min / case".
  if (rounded === 0) return { value: 0, label: 'No change' };
  return {
    value: rounded,
    label: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} min / case`,
  };
}

/** How the agent-closed cohort's closure time compared with the human-owned one. */
function closureDifferenceSentence(value: number | null): string {
  if (value === null) {
    return 'The closure-time difference between agent-closed and human-owned cases is not available.';
  }
  if (Math.abs(value) < 0.05) {
    return 'Agent-closed and human-owned cases showed no observed closure-time difference.';
  }
  return `Agent-closed cases closed ${formatMinutes(value)} ${value > 0 ? 'faster' : 'slower'} per case than human-owned cases.`;
}

/** How after-clustering volume moved against the prior window, as one sentence. */
function afterClusteringSentence(direction: AgentOutcomeDirection): string {
  switch (direction) {
    case 'up':
      return 'After-clustering volume rose against the prior window.';
    case 'down':
      return 'After-clustering volume fell against the prior window.';
    case 'stable':
      return 'After-clustering volume showed no material change against the prior window.';
    case 'improving':
      return 'After-clustering volume improved against the prior window.';
    case 'regressing':
      return 'After-clustering volume worsened against the prior window.';
    default:
      return 'After-clustering volume could not be compared.';
  }
}

/** "threshold change" for one, "threshold changes" otherwise. */
function thresholdChanges(count: number): string {
  return count === 1 ? 'threshold change' : 'threshold changes';
}

/** The number of days a half-open UTC window spans, or null when it does not parse. */
function windowDays(windowValue: { start: string; end_exclusive: string; days?: number }): number | null {
  if (typeof windowValue.days === 'number' && Number.isInteger(windowValue.days) && windowValue.days > 0) {
    return windowValue.days;
  }
  const start = utcDay(windowValue.start);
  const end = utcDay(windowValue.end_exclusive);
  if (!start || !end) return null;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

/**
 * The panel caption: the window the comparisons cover, in the Analytics grammar ("last 7
 * complete UTC days against the 7 before"). It follows the period switch.
 */
export function outcomeWindowCaption(
  current: { start: string; end_exclusive: string; days?: number },
  prior: { start: string; end_exclusive: string; days?: number },
): string {
  const currentDays = windowDays(current);
  const priorDays = windowDays(prior);
  if (currentDays === null || priorDays === null) return 'complete UTC days';
  const unit = currentDays === 1 ? 'complete UTC day' : 'complete UTC days';
  return `last ${currentDays} ${unit} against the ${priorDays} before`;
}

/** A UTC day (`2026-07-21`) as a date, or null when it does not parse. */
function utcDay(value: string): Date | null {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The inclusive span of a half-open UTC window in words ("Jul 21 to 27, 2026"), so a
 * reader never has to subtract a day from an exclusive end. Unparseable days stay as sent.
 */
export function utcDayRange(windowValue: { start: string; end_exclusive: string }): string {
  const start = utcDay(windowValue.start);
  const end = utcDay(windowValue.end_exclusive);
  if (!start || !end) return `${windowValue.start} to ${windowValue.end_exclusive}`;
  end.setUTCDate(end.getUTCDate() - 1);
  const month = (value: Date) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(value);
  if (start.getUTCFullYear() !== end.getUTCFullYear()) {
    return `${month(start)} ${start.getUTCDate()}, ${start.getUTCFullYear()} to ${month(end)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  if (start.getUTCMonth() !== end.getUTCMonth()) {
    return `${month(start)} ${start.getUTCDate()} to ${month(end)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `${month(start)} ${start.getUTCDate()} to ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
}

/**
 * "Current Jul 21 to 27, 2026; prior Jul 14 to 20, 2026; complete UTC days". The panel,
 * whose caption already says "complete UTC days", leaves the last clause off.
 */
function windowsLine(
  current: { start: string; end_exclusive: string },
  prior: { start: string; end_exclusive: string },
  { completeDays = true }: { completeDays?: boolean } = {},
): string {
  const line = `Current ${utcDayRange(current)}; prior ${utcDayRange(prior)}`;
  return completeDays ? `${line}; complete UTC days` : line;
}

/* ------------------------------------------------------------ the strip -- */

/** How one comparison's evidence reads: text and a glyph, never colour alone. */
const EVIDENCE_STATE: Record<
  AgentEvidenceStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  enough_data: { label: 'Sufficient sample', icon: CheckCircle2, className: 'text-success-text' },
  insufficient_evidence: { label: 'Insufficient sample', icon: AlertTriangle, className: 'text-warning-text' },
  unavailable: { label: 'Unavailable', icon: CircleSlash2, className: 'text-muted-foreground' },
  not_applicable: { label: 'Not applicable', icon: CircleMinus, className: 'text-muted-foreground' },
};

function sampleText(count: number, label: string, status: AgentEvidenceStatus): string {
  if (!Number.isFinite(count) || count < 0) return 'Sample unavailable';
  if (count === 0 && status !== 'enough_data') return `No eligible ${label}`;
  return `${Math.trunc(count).toLocaleString()} ${label}`;
}

interface OutcomeTileProps {
  label: string;
  value: string;
  prior: string;
  delta?: KpiDelta;
  goodDirection: KpiGoodDirection;
  /** One muted line under the numeral: what the figure is. */
  context: string;
  status: AgentEvidenceStatus;
  statusReason?: string;
  sample: number;
  sampleLabel: string;
  definition: MetricDefinitionDetails;
  testId: string;
}

/**
 * One headline comparison as a strip tile: `KpiTile` owns the label, the numeral and the
 * delta's direction and judgement (with its accessible trend text); the lines under it
 * say what the figure is compared with, how much evidence it rests on, and how it is
 * measured. An unavailable or not applicable comparison shows no value, delta or sample.
 */
function OutcomeTile(props: OutcomeTileProps) {
  const state = EVIDENCE_STATE[props.status] ?? EVIDENCE_STATE.insufficient_evidence;
  const StateIcon = state.icon;
  const measured = props.status !== 'unavailable' && props.status !== 'not_applicable';
  const reason = asSentence(props.statusReason);
  return (
    <div
      role="group"
      aria-label={`${props.label} comparison`}
      data-testid={`comparison-${props.testId}`}
      // Two rows of the strip's own grid (subgrid): every tile's figure block takes the
      // tallest one's height on its strip row, so the lines under it (evidence state,
      // prior, sample, reason) start at the same height in every tile of that row.
      className="row-span-2 grid min-w-0 grid-rows-subgrid"
    >
      <KpiTile
        label={props.label}
        value={measured ? props.value : DASH}
        delta={measured ? props.delta : undefined}
        goodDirection={props.goodDirection}
        context={props.context}
        testId={`${props.testId}-metric`}
        className="h-auto min-h-0"
      />
      {/* One row order in every tile (evidence state, prior, sample, reason), top aligned,
          so the same fact sits on the same line across the strip. */}
      <div className={cn(PANEL_PADDING_X, 'space-y-1 pb-3 text-xs')} data-outcome-tile-details="">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className={cn('inline-flex items-center gap-1 font-medium', state.className)}>
            <StateIcon className="size-3.5 shrink-0" aria-hidden />
            {state.label}
          </span>
          <MetricDefinition metric={props.label} {...props.definition} triggerText="How" />
        </div>
        <p className="text-muted-foreground">
          Comparable prior:{' '}
          <span className="font-medium tabular-nums text-foreground">{measured ? props.prior : DASH}</span>
        </p>
        {measured ? (
          <p className="tabular-nums text-muted-foreground">
            {sampleText(props.sample, props.sampleLabel, props.status)}
          </p>
        ) : null}
        {reason ? <p className="leading-relaxed text-muted-foreground">{reason}</p> : null}
      </div>
    </div>
  );
}

/** The compact strip density every tile below inherits (the Analytics strip grammar). */
const STRIP_CONTEXT = { density: 'compact' as const };

function OutcomeStrip({ outcomes }: { outcomes: AgentOperationalOutcomesContract }) {
  const positive = outcomes.confirmed_positive_case_rate;
  const timing = outcomes.observed_time_saved;
  const volume = outcomes.alert_volume;
  const cost = outcomes.recorded_case_cost;
  return (
    <KpiStripContext.Provider value={STRIP_CONTEXT}>
      {/* One tile a row while the strip is narrower than 28rem (a phone): each tile carries
          five to seven lines of evidence under its figure, too many for half a phone. */}
      <KpiTileGrid
        count={4}
        surface="panel"
        className="grid-cols-1 @[28rem]:grid-cols-2"
        data-testid="operational-outcomes-strip"
      >
        <OutcomeTile
          label="Confirmed-positive case share"
          value={formatRatio(positive.current.value)}
          prior={formatRatio(positive.baseline.value)}
          delta={pointsDelta(positive.delta.percentage_points)}
          goodDirection="none"
          context="Case-level observed outcome mix"
          status={positive.status}
          statusReason={positive.reason || undefined}
          sample={positive.current.outcome_evaluable_cases}
          sampleLabel="evaluable cases"
          definition={positive.definition}
          testId="outcome-confirmed_positive_case_rate"
        />
        <OutcomeTile
          label="Observed elapsed-time difference"
          value={formatElapsedDifference(timing.current.observed_difference_minutes_per_case)}
          prior={formatElapsedDifference(timing.baseline.observed_difference_minutes_per_case)}
          delta={minutesDelta(timing.delta.minutes_per_case)}
          goodDirection="up"
          context="Unmatched closure cohorts; not labor time"
          status={timing.status}
          statusReason={timing.reason || undefined}
          sample={timing.current.human_owned_closure_count + timing.current.agent_closed_count}
          sampleLabel="eligible closures"
          definition={timing.definition}
          testId="outcome-observed_time_saved"
        />
        <OutcomeTile
          label="Alerts after clustering / day"
          value={formatCount(volume.current.after_clustering_per_day, ' / day')}
          prior={formatCount(volume.baseline.after_clustering_per_day, ' / day')}
          delta={relativeDelta(volume.delta.after_clustering_per_day_relative)}
          goodDirection="none"
          context="Downstream clustering only"
          status={volume.status}
          statusReason={volume.reason || undefined}
          sample={volume.current.ingested_alerts ?? 0}
          sampleLabel="ingested alerts"
          definition={volume.definition}
          testId="outcome-alert_volume"
        />
        <OutcomeTile
          label="AI processing cost / case"
          value={formatCurrency(cost.current.cost_per_costed_case)}
          prior={formatCurrency(cost.baseline.cost_per_costed_case)}
          delta={relativeDelta(cost.delta.cost_per_costed_case_relative)}
          goodDirection="none"
          context="Recorded case-associated model spend"
          status={cost.status}
          statusReason={cost.reason || undefined}
          sample={cost.current.costed_cases}
          sampleLabel="costed cases"
          definition={cost.definition}
          testId="outcome-recorded_case_cost"
        />
      </KpiTileGrid>
    </KpiStripContext.Provider>
  );
}

/* ------------------------------------------------------ supporting rows -- */

/** One supporting section inside the panel: a sentence-case `h3` and its caption. */
function DetailSection({
  id,
  title,
  caption,
  children,
}: {
  id: string;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cn(PANEL_PADDING_X, 'border-t border-border/70 py-4')}>
      <h3 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h3>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{caption}</p>
      {children}
    </section>
  );
}

function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <dl className="mt-2 divide-y divide-border/70">{children}</dl>
    </div>
  );
}

function DetailValue({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{value}</dd>
      {detail ? (
        <dd className="col-span-2 mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</dd>
      ) : null}
    </div>
  );
}

function directionPresentation(direction: AgentOutcomeDirection): {
  label: string;
  variant: 'success' | 'critical' | 'warning' | 'secondary' | 'info';
} {
  switch (direction) {
    case 'improving':
      return { label: 'Better', variant: 'success' };
    case 'regressing':
      return { label: 'Worse', variant: 'critical' };
    case 'stable':
      return { label: 'No material change', variant: 'secondary' };
    case 'up':
      return { label: 'Up · descriptive', variant: 'info' };
    case 'down':
      return { label: 'Down · descriptive', variant: 'info' };
    default:
      return { label: 'Insufficient evidence', variant: 'warning' };
  }
}

function evidencePresentation(status: AgentEvidenceStatus): {
  label: string;
  variant: 'success' | 'warning' | 'secondary';
} {
  switch (status) {
    case 'enough_data':
      return { label: 'Sufficient evidence', variant: 'success' };
    case 'not_applicable':
      return { label: 'Not applicable', variant: 'secondary' };
    case 'unavailable':
      return { label: 'Unavailable', variant: 'secondary' };
    default:
      return { label: 'Insufficient evidence', variant: 'warning' };
  }
}

function qualityDirection(metrics: AgentPeriodComparison['metrics']): AgentOutcomeDirection {
  const directions = [
    metrics.analyst_reported_verdict_agreement.direction,
    metrics.material_analyst_correction_rate.direction,
  ];
  if (directions.includes('insufficient_evidence')) return 'insufficient_evidence';
  if (directions.includes('regressing')) return 'regressing';
  if (directions.includes('improving')) return 'improving';
  return 'stable';
}

function AttributionLane({
  title,
  state,
  detail,
}: {
  title: string;
  state: ReturnType<typeof directionPresentation>;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function WhereSystemHelps({
  metrics,
  outcomes,
}: {
  metrics: AgentPeriodComparison['metrics'];
  outcomes: AgentOperationalOutcomesContract;
}) {
  const id = React.useId();
  const quality = directionPresentation(qualityDirection(metrics));
  const speed = directionPresentation(metrics.human_review_turnaround.direction);
  const handling = directionPresentation(outcomes.alert_volume.after_clustering_direction);
  const timing = outcomes.observed_time_saved;
  const tuning = outcomes.tuning_context;
  const volume = outcomes.alert_volume;
  const timingReason = asSentence(timing.reason);
  const speedDetail =
    timing.status === 'unavailable'
      ? sentences(
          'The agent-closed against human-owned closure comparison is unavailable.',
          timingReason || 'No eligible matched reporting cohorts.',
          'Human-review turnaround remains a separate elapsed-time measure; elapsed time is not labor effort.',
        )
      : sentences(
          'Covers human-review turnaround and the observed closure time of agent-closed against human-owned cases.',
          closureDifferenceSentence(timing.current.observed_difference_minutes_per_case),
          timing.status === 'insufficient_evidence' ? timingReason : '',
          'Closure cohorts are unmatched; elapsed time is not labor effort.',
        );
  const tuningReason = asSentence(tuning.reason);
  const applied = tuning.current.applied_changes;
  const handlingDetail =
    tuning.status === 'unavailable'
      ? sentences(
          'Threshold-tuning context is unavailable.',
          tuningReason || 'The tuning ledger could not be read.',
          'After-clustering volume remains descriptive and cannot be attributed to tuning.',
        )
      : sentences(
          // "No threshold changes were recorded" (the reason) already says a zero count.
          applied === 0 && tuning.status === 'insufficient_evidence' && tuningReason
            ? ''
            : `The current window recorded ${applied === 0 ? 'no' : formatCount(applied)} applied ${thresholdChanges(applied)}.`,
          afterClusteringSentence(volume.after_clustering_direction),
          tuning.status === 'insufficient_evidence' ? tuningReason : '',
          'Clustering is deterministic; this is context, not model fine-tuning or causal attribution.',
        );

  return (
    <DetailSection
      id={`system-layers-${id.replace(/:/g, '')}`}
      title="Evidence by system layer"
      caption="Three independent evidence lanes, not a score. AI assessment, human workflow and deterministic alert handling stay separately attributed."
    >
      <div className="mt-3 grid gap-x-8 gap-y-4 lg:grid-cols-3">
        <AttributionLane
          title="AI verdict quality"
          state={quality}
          detail="Analyst agreement and material correction evidence. This measures feedback alignment, not model learning or recall."
        />
        <AttributionLane title="Workflow speed" state={speed} detail={speedDetail} />
        <AttributionLane
          title="Alert handling"
          state={volume.status === 'enough_data' ? handling : evidencePresentation(volume.status)}
          detail={handlingDetail}
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Not measured as improvement: upstream alert generation or true-positive / raw-alert yield. The current schema has no defensible alert-level outcome lineage.
      </p>
    </DetailSection>
  );
}

function OutcomeDetail({ outcomes }: { outcomes: AgentOperationalOutcomesContract }) {
  const id = React.useId();
  const positive = outcomes.confirmed_positive_case_rate;
  const tpAlert = outcomes.true_positive_alert_yield;
  const timing = outcomes.observed_time_saved;
  const volume = outcomes.alert_volume;
  const cost = outcomes.recorded_case_cost;
  const tuning = outcomes.tuning_context;

  return (
    <DetailSection
      id={`outcome-basis-${id.replace(/:/g, '')}`}
      title="What supports these movements"
      caption="Case truth, elapsed closure timing, alert counters and spend keep their own units and evidence limits."
    >
      <div className="mt-3 grid gap-x-8 gap-y-5 md:grid-cols-2 2xl:grid-cols-4">
        <DetailGroup title="Case outcomes">
          <DetailValue label="Confirmed-positive share" value={formatRatio(positive.current.value)} />
          <DetailValue
            label="Confirmed / evaluable cases"
            value={`${positive.current.confirmed_positive_cases.toLocaleString()} / ${positive.current.outcome_evaluable_cases.toLocaleString()}`}
          />
          <DetailValue label="TP / raw-alert yield" value={DASH} detail={asSentence(tpAlert.reason)} />
        </DetailGroup>

        <DetailGroup title="Closure timing">
          <DetailValue
            label="Human-owned closure p50"
            value={formatMinutes(timing.current.human_owned_closure_p50_minutes)}
          />
          <DetailValue label="Agent-closed p50" value={formatMinutes(timing.current.agent_closed_p50_minutes)} />
          <DetailValue
            label="Estimated aggregate elapsed difference"
            value={formatAggregateElapsedDifference(timing.current.observed_aggregate_elapsed_difference_minutes)}
            detail="Unmatched cohort estimate; elapsed time is not measured labor or overtime savings."
          />
        </DetailGroup>

        <DetailGroup title="Alert path">
          <DetailValue label="Ingested alerts / day" value={formatCount(volume.current.ingested_per_day, ' / day')} />
          <DetailValue
            label="After clustering / day"
            value={formatCount(volume.current.after_clustering_per_day, ' / day')}
          />
          <DetailValue
            label="Current counter totals"
            value={`${formatCount(volume.current.ingested_alerts)} → ${formatCount(volume.current.after_clustering_alerts)}`}
            detail="Clustering is downstream of ingest; it is not proof of promotion to investigation."
          />
          <DetailValue
            label="Reduced before case creation"
            value={`${formatCount(volume.current.clustering_reduction_count)} · ${formatRatio(volume.current.clustering_reduction_rate)}`}
            detail="Deterministic clustering-path reduction; threshold changes may co-occur but are not proven to cause it."
          />
        </DetailGroup>

        <DetailGroup title="AI processing cost">
          <DetailValue label="Recorded total" value={formatCurrency(cost.current.total_cost)} />
          <DetailValue
            label="Per costed case"
            value={formatCurrency(cost.current.cost_per_costed_case)}
            detail={`${cost.current.costed_cases.toLocaleString()} case-associated cost cohorts.`}
          />
          <DetailValue
            label="Recorded / day"
            value={formatCurrency(cost.current.cost_per_day)}
            detail={`Comparable prior: ${formatCurrency(cost.baseline.cost_per_day)}. Model spend only; no labor cost is inferred.`}
          />
        </DetailGroup>
      </div>

      <p className="mt-4 max-w-4xl text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Tuning context only.</span>{' '}
        {sentences(
          asSentence(tuning.reason) ||
            `The current window applied ${formatCount(tuning.current.applied_changes)} ${thresholdChanges(tuning.current.applied_changes)} and rolled back ${formatCount(tuning.current.rolled_back_changes)}.`,
          afterClusteringSentence(tuning.cooccurring_after_clustering_direction),
          'Threshold tuning is downstream of ingest, is not model fine-tuning, and does not prove causation.',
        )}
      </p>
    </DetailSection>
  );
}

interface TrendMetricConfig {
  key: keyof AgentPeriodComparison['metrics'];
  label: string;
  unit: 'ratio' | 'minutes';
  neutral: boolean;
}

const TREND_METRICS: readonly TrendMetricConfig[] = [
  {
    key: 'analyst_reported_verdict_agreement',
    label: 'Analyst-reported agreement',
    unit: 'ratio',
    neutral: false,
  },
  {
    key: 'material_analyst_correction_rate',
    label: 'Material correction rate',
    unit: 'ratio',
    neutral: false,
  },
  {
    key: 'human_review_turnaround',
    label: 'Human review turnaround',
    unit: 'minutes',
    neutral: false,
  },
  {
    key: 'confirmed_positive_case_rate',
    label: 'Confirmed-positive case share',
    unit: 'ratio',
    neutral: true,
  },
] as const;

function trendValue(value: number | null, unit: TrendMetricConfig['unit']): string {
  return unit === 'ratio' ? formatRatio(value) : formatMinutes(value);
}

function TrendMetricRow({
  metric,
  config,
}: {
  metric: AgentPeriodComparisonMetric;
  config: TrendMetricConfig;
}) {
  const presentation = directionPresentation(metric.direction);
  return (
    <li
      aria-label={`${config.label} period trend`}
      className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{config.label}</p>
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
          {metric.current_sample_count.toLocaleString()} current ·{' '}
          {metric.baseline_sample_count.toLocaleString()} prior samples
        </p>
        {metric.reason ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{asSentence(metric.reason)}</p>
        ) : null}
      </div>
      <p className="text-sm tabular-nums text-muted-foreground">
        <span className="font-semibold text-foreground">{trendValue(metric.current, config.unit)}</span>{' '}
        vs {trendValue(metric.baseline, config.unit)}
      </p>
      <Badge variant={presentation.variant}>
        {config.neutral && (metric.direction === 'improving' || metric.direction === 'regressing')
          ? metric.direction === 'improving'
            ? 'Up · descriptive'
            : 'Down · descriptive'
          : presentation.label}
      </Badge>
    </li>
  );
}

function PeriodTrendSummary({ selected }: { selected: AgentPeriodComparison }) {
  const id = React.useId();
  return (
    <DetailSection
      id={`trend-check-${id.replace(/:/g, '')}`}
      title="Trend check"
      caption="Equal-length complete UTC windows answer better, worse, unchanged or insufficient evidence without mixing units on one chart."
    >
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
        {windowsLine(selected.current, selected.baseline)}
      </p>
      <ul className="mt-2 grid gap-x-8 divide-y divide-border/70 xl:grid-cols-2 xl:divide-y-0 xl:[&>li:nth-child(n+3)]:border-t xl:[&>li:nth-child(n+3)]:border-border/70">
        {TREND_METRICS.map((config) => (
          <TrendMetricRow key={config.key} metric={selected.metrics[config.key]} config={config} />
        ))}
      </ul>
    </DetailSection>
  );
}

/* --------------------------------------------------------------- module -- */

export interface AgentOperationalOutcomesProps {
  evidence: AgentImprovementEvidenceWithOutcomes;
  /**
   * Fold the supporting rows ("What supports these movements", "Evidence by system
   * layer" and the trend check) out of view. Agent effectiveness folds them into its Show
   * details disclosure while its headline is still collecting evidence. They stay in the
   * DOM with `hidden`, so the disclosure's `aria-controls` can name them (`detailsId`).
   */
  detailsHidden?: boolean;
  /** Id of the supporting rows' wrapper, for the disclosure that shows them. */
  detailsId?: string;
  /**
   * The selected comparison, when the host needs it too (Agent effectiveness words its
   * disclosure from the selected period's evidence). Uncontrolled without it.
   */
  period?: OutcomePeriod;
  onPeriodChange?: (period: OutcomePeriod) => void;
}

/**
 * The operational outcomes panel: the period switch in the title row, the four headline
 * comparisons as a strip, then the supporting rows (foldable, see `detailsHidden`).
 * Renders nothing for an older backend without `outcomes`.
 */
export function AgentOperationalOutcomes({
  evidence,
  detailsHidden = false,
  detailsId,
  period: controlledPeriod,
  onPeriodChange,
}: AgentOperationalOutcomesProps) {
  const [ownPeriod, setOwnPeriod] = React.useState<OutcomePeriod>('week_over_week');
  const period = controlledPeriod ?? ownPeriod;
  const setPeriod = React.useCallback(
    (next: OutcomePeriod) => {
      setOwnPeriod(next);
      onPeriodChange?.(next);
    },
    [onPeriodChange],
  );
  const comparison = evidence.period_comparisons?.[period];
  const outcomes = outcomesForPeriod(evidence, period);
  if (!outcomes) return null;
  const currentWindow = comparison?.current ?? evidence.windows.current;
  const priorWindow = comparison?.baseline ?? evidence.windows.baseline;

  return (
    <Panel
      title="Operational outcomes"
      caption={outcomeWindowCaption(currentWindow, priorWindow)}
      padding="none"
      actions={
        evidence.period_comparisons ? (
          <SegmentedControl
            aria-label="Outcome trend period"
            size="sm"
            value={period}
            onValueChange={setPeriod}
            options={[
              { value: 'week_over_week', label: 'Week over week' },
              { value: 'month_over_month', label: 'Rolling 28 days' },
            ]}
          />
        ) : null
      }
      data-testid="agent-operational-outcomes"
    >
      <div className={cn(PANEL_PADDING_X, 'space-y-1 pb-3')}>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Quality, elapsed closure time, downstream alert flow and recorded AI spend. No composite score or causal claim.
        </p>
        <p className="text-sm tabular-nums text-muted-foreground" data-testid="operational-outcomes-windows">
          {windowsLine(currentWindow, priorWindow, { completeDays: false })}
        </p>
      </div>

      <OutcomeStrip outcomes={outcomes} />

      {/* Always in the DOM so a disclosure can name it; no display utility, so `hidden`
          keeps it out of the layout and the accessibility tree while folded. */}
      <div id={detailsId} hidden={detailsHidden} data-testid="operational-outcomes-details">
        <OutcomeDetail outcomes={outcomes} />
        {comparison ? <WhereSystemHelps metrics={comparison.metrics} outcomes={outcomes} /> : null}
        {comparison ? <PeriodTrendSummary selected={comparison} /> : null}
      </div>
    </Panel>
  );
}

/** Compact context row for Auto-tuning Outcomes; authority remains in Operations. */
export function TuningOutcomeContext({
  outcomes,
}: {
  outcomes: AgentOperationalOutcomesContract;
}) {
  const volume = outcomes.alert_volume;
  const tuning = outcomes.tuning_context;
  const volumeComparable = volume.status === 'enough_data';
  const volumeReadable = volume.status !== 'unavailable';
  const tuningComparable = tuning.status === 'enough_data';
  const tuningReadable = tuning.status !== 'unavailable';
  const movement = volumeComparable
    ? directionPresentation(volume.after_clustering_direction)
    : evidencePresentation(volume.status);
  const contextState = evidencePresentation(
    volumeComparable ? tuning.status : volume.status,
  );

  return (
    <section aria-labelledby="tuning-volume-context-heading" className="border-t border-border/70 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="tuning-volume-context-heading" className="text-xs font-semibold text-foreground">
            Downstream volume around threshold tuning
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Per-day counters make the unequal 7-day and 28-day windows comparable.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={contextState.variant}>{contextState.label}</Badge>
          <Badge variant="secondary">Context only · not causal</Badge>
        </div>
      </div>
      <dl className="mt-3 grid border-y border-border/70 sm:grid-cols-3">
        <div className="px-3 py-2.5">
          <dt className="text-xs text-muted-foreground">Ingested / day</dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-foreground">
            {volumeReadable ? formatCount(volume.current.ingested_per_day) : DASH}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              vs {volumeReadable ? formatCount(volume.baseline.ingested_per_day) : DASH}
            </span>
          </dd>
        </div>
        <div className="border-t border-border/70 px-3 py-2.5 sm:border-l sm:border-t-0">
          <dt className="text-xs text-muted-foreground">After clustering / day</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm font-semibold tabular-nums text-foreground">
            {volumeReadable ? formatCount(volume.current.after_clustering_per_day) : DASH}
            <span className="text-xs font-normal text-muted-foreground">
              vs {volumeReadable ? formatCount(volume.baseline.after_clustering_per_day) : DASH}
            </span>
            <Badge variant={movement.variant}>{movement.label}</Badge>
          </dd>
        </div>
        <div className="border-t border-border/70 px-3 py-2.5 sm:border-l sm:border-t-0">
          <dt className="text-xs text-muted-foreground">Threshold changes</dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-foreground">
            {tuningReadable ? (
              <>
                {tuning.current.applied_changes.toLocaleString()} applied ·{' '}
                {tuning.current.rolled_back_changes.toLocaleString()} rolled back
              </>
            ) : (
              DASH
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Threshold tuning can co-occur with downstream clustering changes, but it does not reduce upstream-generated alerts, is not model fine-tuning, and does not establish causation.
      </p>
      {!volumeComparable || !tuningComparable ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {sentences(
            !volumeComparable
              ? `Alert-volume evidence: ${asSentence(volume.reason) || `${evidencePresentation(volume.status).label}.`}`
              : '',
            !tuningComparable
              ? `Tuning evidence: ${asSentence(tuning.reason) || `${evidencePresentation(tuning.status).label}.`}`
              : '',
          )}
        </p>
      ) : null}
    </section>
  );
}

function GuidanceList({ items }: { items: AgentSourceGuidanceItem[] }) {
  return (
    // The panel caption says these are suggestions, not diagnosis, once for the list.
    <ul className="mt-3 divide-y divide-border/70">
      {items.slice(0, 5).map((item, index) => (
        <li key={item.id ?? `${item.telemetry_kind ?? 'guidance'}-${index}`} className="py-3 first:pt-0 last:pb-0">
          <p className="text-sm font-medium text-foreground">
            {item.title ?? item.telemetry_kind ?? 'Additional telemetry'}
          </p>
          {item.rationale ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{asSentence(item.rationale)}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
            {item.affected_context ? <span>{item.affected_context}</span> : null}
            {typeof item.evidence_gap_count === 'number' ? (
              <span>{item.evidence_gap_count.toLocaleString()} aggregate evidence gaps</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Evidence coverage: telemetry suggestions on their own panel, in the page grammar (the
 * panel title, a caption and the long-term-objective badge in its title row; no inner
 * heading repeating the title, no nested frames).
 */
export function SourceCoverageGuidance({
  evidence,
}: {
  evidence: AgentImprovementEvidenceWithOutcomes;
}) {
  const guidance = evidence.outcomes?.source_guidance;
  const ready = guidance?.status === 'ready';
  const items = ready ? guidance.items : [];

  return (
    <Panel
      title="Evidence coverage"
      caption="suggestions, not diagnosis"
      aside={
        <Badge variant="outline" className="w-fit shrink-0">
          Long-term objective
        </Badge>
      }
      data-testid="agent-coverage-guidance"
    >
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        Additional telemetry that could close recurring triage evidence gaps.
      </p>
      {ready && items.length ? (
        <GuidanceList items={items} />
      ) : ready ? (
        <p className="mt-3 flex gap-2 text-sm leading-relaxed text-muted-foreground">
          <Database className="mt-0.5 size-4 shrink-0" aria-hidden />
          Source-gap analysis completed; no evidence-backed coverage opportunity was detected.
        </p>
      ) : (
        <p className="mt-3 flex gap-2 text-sm leading-relaxed text-muted-foreground">
          <Database className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-foreground">Coverage recommendation unavailable.</span>{' '}
            {sentences(
              asSentence(guidance?.reason) || 'The current backend has not evaluated semantic telemetry gaps.',
              asSentence(guidance?.required_evidence) ||
                'Recommending a source such as outbound DNS requires a future governed evidence-gap analysis.',
            )}
          </span>
        </p>
      )}
    </Panel>
  );
}
