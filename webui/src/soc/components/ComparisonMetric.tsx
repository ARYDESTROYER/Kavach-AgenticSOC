import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleMinus,
  CircleSlash2,
  Info,
  type LucideIcon,
} from 'lucide-react';

import { DASH } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  KpiTile,
  type KpiAccent,
  type KpiDelta,
  type KpiGoodDirection,
} from './KpiTile';

/** Structured, plain-text definition for one reported metric. */
export interface MetricDefinitionDetails {
  /** Human-readable calculation, for example `(agreed + 0.5 × partial) / graded`. */
  formula: string;
  /** What contributes to the top of a ratio or weighted score. */
  numerator?: string;
  /** What establishes the eligible population or scale. */
  denominator?: string;
  /** Which records enter the calculation. */
  eligibility?: string;
  /** Interpretation limits that must remain visible beside the metric. */
  caveats?: string | readonly string[];
}

export interface MetricDefinitionProps extends MetricDefinitionDetails {
  /** Visible metric name used to name the trigger and Radix surface. */
  metric: string;
  /** Optional trigger copy; defaults to `Definition`. */
  triggerText?: string;
  className?: string;
  contentClassName?: string;
}

/**
 * One labelled line of a metric definition. The label is a sentence-case word in the body
 * face (Round 14, SPEC §3.1 and §4.9.1: no tracked capitals, nothing below 12 px for
 * content).
 */
function DefinitionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border/70 py-2.5 first:border-t-0 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}

/**
 * A structured metric explainer. Unlike `HelpTip`, this always uses a Radix Popover:
 * formulas and denominator/caveat detail need a persistent surface that works by
 * click, touch, and keyboard activation rather than hover alone.
 */
export function MetricDefinition({
  metric,
  formula,
  numerator,
  denominator,
  eligibility,
  caveats,
  triggerText = 'Definition',
  className,
  contentClassName,
}: MetricDefinitionProps) {
  const caveatItems = caveats ? (Array.isArray(caveats) ? caveats : [caveats]) : [];
  const triggerLabel = `How ${metric} is measured`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          className={cn(
            'inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5',
            'text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'motion-reduce:transition-none',
            className,
          )}
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
          <span>{triggerText}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        // A 16 px gutter from the screen edge, and never taller than the room it has: a
        // long definition scrolls instead of running off a phone screen.
        collisionPadding={16}
        className={cn(
          'max-h-[var(--radix-popover-content-available-height)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-0',
          contentClassName,
        )}
        aria-label={`${metric} metric definition`}
      >
        <div className="border-b border-border/70 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">Metric definition</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{metric}</p>
        </div>
        <dl className="px-4 py-1">
          <DefinitionRow label="Formula">
            <code className="break-words font-mono text-xs text-foreground">{formula}</code>
          </DefinitionRow>
          {numerator ? <DefinitionRow label="Numerator">{numerator}</DefinitionRow> : null}
          {denominator ? <DefinitionRow label="Denominator">{denominator}</DefinitionRow> : null}
          {eligibility ? <DefinitionRow label="Eligibility">{eligibility}</DefinitionRow> : null}
          {caveatItems.length ? (
            <DefinitionRow label="Caveats">
              <ul className="space-y-1.5">
                {caveatItems.map((caveat, index) => (
                  <li key={`${index}-${caveat}`} className="flex gap-2">
                    <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
                    <span>{caveat}</span>
                  </li>
                ))}
              </ul>
            </DefinitionRow>
          ) : null}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Evidence state is deliberately separate from metric direction. In particular,
 * `collecting` means instrumentation is working but the reporting window is not
 * mature yet; `unavailable` means a required input/benchmark could not be measured;
 * and `not_applicable` means the metric has no eligible population in this window.
 */
export type ComparisonMetricStatus =
  | 'sufficient'
  | 'insufficient'
  | 'collecting'
  | 'unavailable'
  | 'not_applicable';

export interface ComparisonMetricSample {
  count: number;
  /** Noun rendered after the count; defaults to `samples`. */
  label?: string;
}

interface ComparisonMetricBaseProps {
  label: string;
  value: React.ReactNode;
  prior?: React.ReactNode;
  priorLabel?: string;
  delta?: KpiDelta;
  goodDirection?: KpiGoodDirection;
  accent?: KpiAccent;
  icon?: LucideIcon;
  sub?: string;
  /** Plain-language reason for the evidence state, kept visible even without a value. */
  statusReason?: string;
  definition?: MetricDefinitionDetails;
  definitionTriggerText?: string;
  /** `integrated` drops its own frame so a parent telemetry band owns dividers. */
  variant?: 'standalone' | 'integrated';
  testId?: string;
  className?: string;
}

type ComparisonMetricWithSample = ComparisonMetricBaseProps & {
  status: 'sufficient' | 'insufficient' | 'collecting';
  sample: number | ComparisonMetricSample;
};

type ComparisonMetricWithoutSample = ComparisonMetricBaseProps & {
  status: 'unavailable' | 'not_applicable';
  sample?: number | ComparisonMetricSample;
};

export type ComparisonMetricProps = ComparisonMetricWithSample | ComparisonMetricWithoutSample;

const STATUS_PRESENTATION: Record<
  ComparisonMetricStatus,
  { label: string; icon: LucideIcon; className: string }
> = {
  sufficient: {
    label: 'Sufficient sample',
    icon: CheckCircle2,
    className: 'text-success-text',
  },
  insufficient: {
    label: 'Insufficient sample',
    icon: AlertTriangle,
    className: 'text-warning-text',
  },
  collecting: {
    label: 'Collecting evidence',
    icon: CircleDashed,
    className: 'text-muted-foreground',
  },
  unavailable: {
    label: 'Unavailable',
    icon: CircleSlash2,
    className: 'text-muted-foreground',
  },
  not_applicable: {
    label: 'Not applicable',
    icon: CircleMinus,
    className: 'text-muted-foreground',
  },
};

function sampleText(
  sample: number | ComparisonMetricSample | undefined,
  status: ComparisonMetricStatus,
): string | null {
  if (sample === undefined) return null;
  const count = typeof sample === 'number' ? sample : sample.count;
  const label = typeof sample === 'number' ? 'samples' : (sample.label ?? 'samples');
  if (!Number.isFinite(count) || count < 0) return 'Sample unavailable';
  if (count === 0 && status !== 'sufficient') return `No eligible ${label}`;
  return `${Math.trunc(count).toLocaleString()} ${label}`;
}

/**
 * The prior figure: the body face with tabular figures (JetBrains Mono is for identifiers
 * only, SPEC §3.1), and never truncated, because a cut number reads as a plausible wrong
 * one (ui-standard "Numerals").
 */
const FIGURE = 'whitespace-nowrap font-medium tabular-nums text-foreground';

/**
 * Flat, divider-led comparison block. `KpiTile` remains the sole owner of delta
 * direction, judgement, and accessible trend text; this wrapper adds prior/sample
 * context and an explicit data-quality state without inventing another KPI grammar.
 */
export function ComparisonMetric(props: ComparisonMetricProps) {
  const {
    label,
    value,
    prior,
    priorLabel = 'Prior',
    delta,
    goodDirection = 'up',
    accent = 'primary',
    icon,
    sub,
    statusReason,
    status,
    sample,
    definition,
    definitionTriggerText,
    variant = 'standalone',
    testId,
    className,
  } = props;
  const integrated = variant === 'integrated';
  const state = STATUS_PRESENTATION[status];
  const StateIcon = state.icon;
  const renderedSample = sampleText(sample, status);
  const suppressMeasurement = status === 'unavailable' || status === 'not_applicable';
  const suppressDelta = suppressMeasurement || status === 'collecting';

  return (
    <section
      aria-label={`${label} comparison metric`}
      data-testid={testId ? `comparison-${testId}` : undefined}
      className={cn(
        integrated ? 'min-w-0 bg-background' : 'min-w-0 border-y border-border/70 bg-transparent',
        className,
      )}
    >
      {/* KpiTile defaults to `h-full` so ordinary KPI grids align. A comparison
          block also owns a footer, so this tile must size to its own content. */}
      <KpiTile
        label={label}
        value={suppressMeasurement ? DASH : value}
        sub={integrated && suppressMeasurement ? undefined : sub}
        icon={icon}
        accent={accent}
        delta={suppressDelta ? undefined : delta}
        goodDirection={goodDirection}
        variant="strip"
        density={integrated ? 'compact' : 'default'}
        testId={testId ? `${testId}-metric` : undefined}
        className={cn('h-auto min-h-0', integrated ? 'px-3 py-2.5' : 'px-4 py-4')}
      />

      {integrated ? (
        <div className="min-w-0 border-t border-border/70 px-3 py-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
              <span>{priorLabel}</span>
              <span className={FIGURE}>{prior ?? DASH}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                role="status"
                className={cn('inline-flex items-center gap-1 text-xs font-medium', state.className)}
              >
                <StateIcon className="h-3.5 w-3.5" aria-hidden />
                {state.label}
              </span>
              {definition ? (
                <MetricDefinition
                  metric={label}
                  {...definition}
                  triggerText={definitionTriggerText}
                />
              ) : null}
            </span>
          </div>
          {renderedSample ? (
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">{renderedSample}</p>
          ) : null}
          {statusReason ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{statusReason}</p>
          ) : null}
        </div>
      ) : (
        <div className="border-t border-border/70 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <span className="inline-flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
              <span>{priorLabel}</span>
              <span className={FIGURE}>{prior ?? DASH}</span>
            </span>
            {renderedSample ? (
              <span className="text-xs tabular-nums text-muted-foreground">{renderedSample}</span>
            ) : null}

            <span
              role="status"
              className={cn('ml-auto inline-flex items-center gap-1.5 text-xs font-medium', state.className)}
            >
              <StateIcon className="h-3.5 w-3.5" aria-hidden />
              {state.label}
            </span>

            {definition ? (
              <MetricDefinition
                metric={label}
                {...definition}
                triggerText={definitionTriggerText}
              />
            ) : null}
          </div>
          {statusReason ? (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {statusReason}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default ComparisonMetric;
