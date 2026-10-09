/**
 * StageTimeline — the six-stage narrative of how one alert became a case.
 *
 * Consumes `GET /api/cases/{id}/stages` (the `TimelineStage` shape) and renders it as
 * a vertical, chronological story: input → correlate → risk → triage → investigate →
 * decide. Each stage shows a one-line TRUSTED headline + state chips at a glance, and
 * expands to its chronological steps. Deterministic stages (correlate/risk/decide)
 * carry a "deterministic" badge — the trust signal (#3 made visible).
 *
 * SECURITY (#9): a step with `trusted === false` (raw source/log/tool payload) renders
 * its body ONLY inside an escaped <CodeBlock>; trusted prose renders as plain text.
 */
import * as React from 'react';
import {
  ArrowRight,
  Calculator,
  ChevronDown,
  Compass,
  Gauge,
  GitBranch,
  GitMerge,
  Inbox,
  Lock,
  Search,
  ShieldCheck,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, formatTimestamp, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { Markdown } from '@/soc/components/Markdown';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';

import type {
  StageRiskFactor,
  StageState,
  StageStep,
  TimelineStage,
  TimelineStagesResponse,
} from '@/soc/pages/CaseDetail.api';
import type { CasePanelPresentation } from './shared';

/* ------------------------------------------------------------------ meta -- */

type Tone = 'info' | 'medium' | 'low' | 'high';

const TONE_TEXT: Record<Tone, string> = {
  info: 'text-info',
  medium: 'text-medium',
  low: 'text-low',
  high: 'text-high',
};
const TONE_RING: Record<Tone, string> = {
  info: 'border-info/40 bg-info/10',
  medium: 'border-medium/40 bg-medium/10',
  low: 'border-low/40 bg-low/10',
  high: 'border-high/40 bg-high/10',
};

interface StageMeta {
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
}
const STAGE_META: Record<string, StageMeta> = {
  input: { icon: Inbox, tone: 'info' },
  correlate: { icon: GitMerge, tone: 'info' },
  risk: { icon: Gauge, tone: 'medium' },
  triage: { icon: Compass, tone: 'info' },
  investigate: { icon: Search, tone: 'info' },
  decide: { icon: ShieldCheck, tone: 'low' },
};
function stageMeta(kind: string): StageMeta {
  return STAGE_META[kind] || { icon: GitBranch, tone: 'info' };
}

/* --------------------------------------------------------------- state chips -- */

const StateChips: React.FC<{ state: StageState }> = ({ state }) => {
  const chips: React.ReactNode[] = [];
  if (state.severity_band) {
    const src = state.severity_source === 'source_asserted' ? 'SIEM' : state.severity_source === 'derived' ? 'derived' : '';
    chips.push(
      <Badge key="sev" variant="outline">
        severity {humanizeToken(state.severity_band)}
        {src ? ` · ${src}` : ''}
      </Badge>,
    );
  }
  if (typeof state.risk_score === 'number') {
    chips.push(<Badge key="risk" variant="medium">risk {Math.round(state.risk_score)}/100</Badge>);
  }
  if (state.verdict) {
    chips.push(<Badge key="verdict" variant="info">{humanizeToken(state.verdict)}</Badge>);
  }
  if (typeof state.confidence === 'number') {
    chips.push(<Badge key="conf" variant="outline">conf {Math.round(state.confidence * 100)}%</Badge>);
  }
  if (!chips.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{chips}</div>;
};

/* ----------------------------------------------------------------- one step -- */

/** A trusted prose body longer than this gets clamped to a few lines + "Show more". */
const CLAMP_CHARS = 320;

/** decode_acl splits its output into a DELTA-first headline and a full-ACL detail block. */
const ACL_DETAIL_MARKER = '---DECODED-ACL-DETAIL---';

/** Untrusted tool body: if it carries the ACL detail marker, show the delta headline and
 *  tuck the full decoded ACL behind a disclosure; otherwise a plain fenced CodeBlock. */
const UntrustedBody: React.FC<{ body: string }> = ({ body }) => {
  const idx = body.indexOf(ACL_DETAIL_MARKER);
  if (idx < 0) return <CodeBlock value={body} wrap copyable maxHeightClassName="max-h-40" />;
  const head = body.slice(0, idx).trim();
  const detail = body.slice(idx + ACL_DETAIL_MARKER.length).trim();
  return (
    <div className="space-y-2">
      {/* DELTA headline (the change/abuse) — prominent; full ACL detail collapsed below. */}
      <div className="rounded-md border-l-2 border-info bg-info/5 px-2.5 py-1.5 text-xs font-medium leading-relaxed text-foreground whitespace-pre-wrap">
        {head}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer select-none text-info hover:underline">
          View full decoded ACL
        </summary>
        <div className="mt-2">
          <CodeBlock value={detail} wrap copyable maxHeightClassName="max-h-72" />
        </div>
      </details>
    </div>
  );
};

const StepItem: React.FC<{ step: StageStep }> = ({ step }) => {
  const [open, setOpen] = React.useState(false);
  const isLong = step.trusted && step.body.length > CLAMP_CHARS;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Badge variant={step.trusted ? 'info' : 'medium'} className="gap-1">
          {step.trusted ? null : <Lock className="h-3 w-3" />}
          {step.label || humanizeToken(step.kind) || 'Step'}
        </Badge>
        {step.trusted ? null : (
          <span className="text-2xs uppercase tracking-wide text-muted-foreground">untrusted</span>
        )}
      </div>
      {step.body ? (
        step.trusted ? (

          <>
            <div className={cn('text-foreground/90', isLong && !open && 'max-h-28 overflow-hidden')}>
              <Markdown text={step.body} className="space-y-1 text-sm leading-relaxed" />
            </div>
            {isLong ? (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="mt-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {open ? 'Show less' : 'Show more'}
              </button>
            ) : null}
          </>
        ) : (
          <UntrustedBody body={step.body} />
        )
      ) : null}
    </div>
  );
};

/* ---------------------------------------------------------------- one stage -- */

const StageRow: React.FC<{ stage: TimelineStage; last: boolean }> = ({ stage, last }) => {
  const meta = stageMeta(stage.kind);
  const Icon = meta.icon;
  const skipped = stage.status === 'skipped';
  const pending = stage.status === 'pending';
  const muted = skipped || pending;
  const hasSteps = stage.steps.length > 0;
  const [open, setOpen] = React.useState(false);

  return (
    <li className="relative pl-10">
      {last ? null : (
        <span
          className={cn('absolute left-[15px] top-7 bottom-0 w-px', muted ? 'bg-border/50' : 'bg-border')}
          aria-hidden
        />
      )}
      <span
        className={cn(
          'absolute left-2 top-1 flex h-6 w-6 items-center justify-center rounded-full border',
          muted
            ? 'border-dashed border-border bg-muted text-muted-foreground'
            : cn('bg-card', TONE_RING[meta.tone], TONE_TEXT[meta.tone]),
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className={cn('pb-6', muted && 'opacity-70')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{stage.label}</span>
          {stage.deterministic ? (
            <Badge variant="outline" className="gap-1">
              <GitBranch className="h-3 w-3" />
              deterministic
            </Badge>
          ) : null}
          {skipped ? <Badge variant="outline">skipped</Badge> : null}
          {pending ? <Badge variant="outline">pending</Badge> : null}
          {stage.ts ? (
            <span className="text-2xs text-muted-foreground">{formatTimestamp(stage.ts)}</span>
          ) : null}
        </div>

        {/* headline — always our TRUSTED prose */}
        <p className="mt-0.5 text-sm text-foreground/90">{stage.headline || DASH}</p>

        <StateChips state={stage.state} />

        {hasSteps ? (
          <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
              {open ? 'Hide' : 'Show'} {stage.steps.length} step{stage.steps.length === 1 ? '' : 's'}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2">
              {stage.steps.map((st, i) => (
                <StepItem key={i} step={st} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </li>
  );
};

/* -------------------------------------------- Case Manager story treatment -- */

/** Reference art uses a terse UTC clock instead of a full local date. */
function storyTime(ts?: string | null): string {
  if (!ts) return DASH;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  try {
    return `${new Date(ms).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })} UTC`;
  } catch {
    return formatTimestamp(ts);
  }
}

const STORY_TONE: Record<string, { dot: string; title: string }> = {
  input: { dot: 'bg-primary shadow-glow', title: 'text-primary' },
  correlate: { dot: 'bg-muted-foreground', title: 'text-foreground' },
  risk: { dot: 'bg-critical shadow-[0_0_12px_hsl(var(--critical)/0.45)]', title: 'text-critical-text' },
  triage: { dot: 'bg-medium', title: 'text-medium-text' },
  investigate: { dot: 'bg-info', title: 'text-info-text' },
  decide: { dot: 'bg-primary shadow-glow', title: 'text-primary' },
};

function storyTone(stage: TimelineStage): { dot: string; title: string } {
  if (stage.status === 'skipped' || stage.status === 'pending') {
    return { dot: 'bg-muted-foreground/60', title: 'text-muted-foreground' };
  }
  return STORY_TONE[stage.kind] || STORY_TONE.correlate;
}

const RiskMicrochart: React.FC<{ score: number }> = ({ score }) => {
  const bounded = Math.max(0, Math.min(100, score));
  const segments = 7;
  const active = Math.round((bounded / 100) * segments);
  return (
    <figure className="mt-3 w-48">
      <figcaption className="mb-1 flex items-center justify-between font-mono text-2xs uppercase tracking-wider text-muted-foreground">
        <span>Risk score</span>
        <span>{Math.round(bounded)}/100</span>
      </figcaption>
      <div
        className="flex h-12 items-stretch gap-1 border border-border bg-surface-sunken p-1"
        role="img"
        aria-label={`Risk score ${Math.round(bounded)} out of 100`}
      >
        {Array.from({ length: segments }).map((_, index) => (
          <span
            key={index}
            className={cn(
              'min-w-0 flex-1',
              index < active ? 'bg-critical/75' : 'bg-primary/15',
              index === active - 1 && 'bg-critical',
            )}
            aria-hidden
          />
        ))}
      </div>
    </figure>
  );
};

const RISK_FACTOR_LABELS: Record<string, string> = {
  volume: 'Volume',
  velocity: 'Velocity',
  reputation: 'Reputation',
  diversity: 'Diversity',
  asset_criticality: 'Asset criticality',
};

function preciseNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return DASH;
  return String(Number(value.toFixed(digits)));
}

/** Backward-compatible extraction for stage payloads created before risk_calculation. */
function legacyRiskFactors(steps: StageStep[]): StageRiskFactor[] {
  const found = new Map<string, StageRiskFactor>();
  const pattern = /(asset[_ ]criticality|volume|velocity|reputation|diversity)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/gi;
  for (const step of steps) {
    if (!step.trusted || !/risk\s+factors?/i.test(step.label)) continue;
    for (const match of step.body.matchAll(pattern)) {
      const factor = match[1].toLowerCase().replace(' ', '_');
      const value = Number(match[2]);
      if (!Number.isFinite(value) || found.has(factor)) continue;
      found.set(factor, {
        factor,
        label: RISK_FACTOR_LABELS[factor] || humanizeToken(factor),
        value,
        weight: Number.NaN,
        weighted_value: Number.NaN,
        contribution: Number.NaN,
      });
    }
  }
  return [...found.values()];
}

const RiskDerivation: React.FC<{ stage: TimelineStage }> = ({ stage }) => {
  const calculation = stage.state.risk_calculation;
  const factors = calculation?.factors?.length
    ? calculation.factors
    : legacyRiskFactors(stage.steps);
  const displayed = Math.round(
    calculation?.displayed_score
      ?? calculation?.recorded_score
      ?? stage.state.risk_score
      ?? 0,
  );
  const derivationTitle = calculation?.matches_displayed_score
    ? `How ${displayed}/100 was derived`
    : `Risk score details · ${displayed}/100`;

  return (
    <section
      className="mt-3 max-w-4xl border border-border bg-surface-sunken p-4"
      aria-labelledby={`risk-derivation-${stage.id || 'stage'}`}
      data-testid="risk-derivation"
    >
      <div className="flex items-center gap-2">
        <Calculator className="h-4 w-4 text-medium-text" aria-hidden />
        <h4
          id={`risk-derivation-${stage.id || 'stage'}`}
          className="text-sm font-semibold text-foreground"
        >
          {derivationTitle}
        </h4>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Each factor is a persisted 0–100 input. Contribution = value × configured
        weight ÷ the total configured weight.
      </p>

      {factors.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">Risk score factor calculation</caption>
            <thead>
              <tr className="border-b border-border font-mono uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-2 py-2 font-medium">Factor</th>
                <th scope="col" className="px-2 py-2 font-medium">Value</th>
                <th scope="col" className="px-2 py-2 font-medium">Weight</th>
                <th scope="col" className="px-2 py-2 font-medium">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((factor) => {
                const share = calculation && calculation.denominator
                  ? (factor.weight / calculation.denominator) * 100
                  : Number.NaN;
                return (
                  <tr key={factor.factor} className="border-b border-border/70 last:border-0">
                    <th scope="row" className="px-2 py-2 font-medium text-foreground">
                      {factor.label || RISK_FACTOR_LABELS[factor.factor] || humanizeToken(factor.factor)}
                    </th>
                    <td className="px-2 py-2 font-mono tabular-nums text-foreground/90">
                      {preciseNumber(factor.value, 2)}/100
                    </td>
                    <td className="px-2 py-2 font-mono tabular-nums text-foreground/90">
                      {Number.isFinite(factor.weight)
                        ? `${preciseNumber(factor.weight)} (${preciseNumber(share, 2)}%)`
                        : DASH}
                    </td>
                    <td className="px-2 py-2 font-mono tabular-nums text-foreground/90">
                      {Number.isFinite(factor.contribution)
                        ? `${preciseNumber(factor.contribution)} pts`
                        : DASH}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {calculation ? (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs leading-relaxed">
          <p className="font-mono text-foreground/90" data-testid="risk-formula">
            Σ(value × weight) = {preciseNumber(calculation.numerator)};{' '}
            {preciseNumber(calculation.numerator)} ÷ {preciseNumber(calculation.denominator)} ={' '}
            {preciseNumber(calculation.calculated_score)}/100 → displayed as{' '}
            {calculation.displayed_score}/100.
          </p>
          <p className="text-muted-foreground">
            Weights shown are the current configured weights used by this read-time
            reconstruction.
          </p>
          {!calculation.matches_displayed_score ? (
            <p className="text-warning-text" role="note">
              The current weights calculate {preciseNumber(calculation.calculated_score)}/100,
              while this case records {preciseNumber(calculation.recorded_score)}/100. This
              timeline does not contain a historical weight snapshot, so the difference cannot
              be attributed exactly; the configuration or legacy factor representation may
              differ from the one used when the case was scored. The recorded score has not
              been rewritten.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground" role="note">
          {factors.length
            ? 'This older timeline payload supplies factor values and the final score, but not the configured weights or weighted contributions. Exact arithmetic cannot be reconstructed from the available data.'
            : 'This older timeline payload supplies the final score, but no factor values, configured weights, or weighted contributions. Exact arithmetic cannot be reconstructed from the available data.'}
        </p>
      )}
    </section>
  );
};

/** Keep source/log material fenced while reproducing the prototype's recessed block. */
const StoryStep: React.FC<{ step: StageStep }> = ({ step }) => (
  <div className="mt-3 max-w-3xl border border-border bg-surface-sunken p-3">
    <div className="mb-1 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
      {step.label || humanizeToken(step.kind) || 'Detail'}
    </div>
    {step.body ? (
      step.trusted ? (
        <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/85">
          {step.body}
        </p>
      ) : (
        <UntrustedBody body={step.body} />
      )
    ) : null}
  </div>
);

function storyStageTitle(stage: TimelineStage): string {
  const supplied = stage.label.trim();
  const canonical = supplied.toLowerCase();
  if (stage.kind === 'risk' && (!supplied || canonical === 'risk')) return 'Risk assigned';
  if (stage.kind === 'decide' && (!supplied || canonical === 'decide')) return 'Decision';
  return supplied || humanizeToken(stage.kind);
}

function normalizedVerdict(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The live investigate headline repeats the exact verdict/confidence chips. */
function isDuplicateInvestigationHeadline(stage: TimelineStage): boolean {
  if (
    stage.kind !== 'investigate'
    || !stage.state.verdict
    || typeof stage.state.confidence !== 'number'
  ) {
    return false;
  }
  const match = stage.headline.trim().match(
    /^verdict:\s*(.+?)\s*[·|]\s*conf(?:idence)?\s*(\d+)%$/i,
  );
  if (!match) return false;
  return (
    normalizedVerdict(match[1]) === normalizedVerdict(stage.state.verdict)
    && Number(match[2]) === Math.round(stage.state.confidence * 100)
  );
}

const StoryStageRow: React.FC<{
  stage: TimelineStage;
  terminal: boolean;
  onOpenInvestigation?: () => void;
}> = ({ stage, terminal, onOpenInvestigation }) => {
  const tone = storyTone(stage);
  const [detailsOpen, setDetailsOpen] = React.useState(stage.kind === 'input');
  const firstStep = stage.steps[0];
  const extraSteps = stage.steps.slice(1);
  const isRisk = stage.kind === 'risk';
  const riskSupplementalSteps = stage.steps.filter(
    (step) => !step.trusted || !/risk\s+factors?/i.test(step.label),
  );
  const detailsSteps = stage.kind === 'input'
    ? extraSteps
    : isRisk
      ? riskSupplementalSteps
      : stage.steps;
  const hasRiskData = (
    typeof stage.state.risk_score === 'number'
    || Boolean(stage.state.risk_calculation)
    || stage.steps.length > 0
  );
  const hasDetails = (isRisk && hasRiskData) || detailsSteps.length > 0;
  const showHeadline = !isDuplicateInvestigationHeadline(stage);

  return (
    <li className="relative border-l border-border/70 pb-9 pl-8 last:border-l-transparent last:pb-0">
      <span
        className={cn(
          'absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full',
          tone.dot,
          terminal && 'motion-safe:animate-pulse motion-reduce:animate-none',
        )}
        data-stage-marker={stage.kind}
        data-terminal={terminal ? 'true' : 'false'}
        data-motion={terminal ? 'pulse' : 'none'}
        aria-hidden
      />
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
        <time className="w-24 shrink-0 font-mono text-xs text-muted-foreground">
          {storyTime(stage.ts)}
        </time>
        <h3 className={cn('text-sm font-semibold uppercase tracking-wider', tone.title)}>
          {storyStageTitle(stage)}
        </h3>
      </div>
      <div className="mt-1 sm:ml-28">
        {showHeadline ? (
          <p className="max-w-4xl text-sm leading-relaxed text-foreground/90">
            {stage.headline || DASH}
          </p>
        ) : null}
        <StateChips state={stage.state} />

        {stage.kind === 'risk' && typeof stage.state.risk_score === 'number' ? (
          <RiskMicrochart score={stage.state.risk_score} />
        ) : null}

        {firstStep && stage.kind === 'input' ? <StoryStep step={firstStep} /> : null}

        {hasDetails ? (
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-2">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', detailsOpen && 'rotate-180')}
                aria-hidden
              />
              {isRisk
                ? (detailsOpen ? 'Hide risk factors' : 'Risk factors')
                : `${detailsOpen ? 'Hide' : 'View'} event details`}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2">
              {isRisk ? <RiskDerivation stage={stage} /> : null}
              {detailsSteps.map((step, index) => (
                <StoryStep key={`${step.kind}-${index}`} step={step} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {stage.kind === 'decide' && onOpenInvestigation ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 h-8 rounded-full border-primary/40 bg-primary/10 px-3 text-xs text-primary hover:bg-primary/15"
            onClick={onOpenInvestigation}
          >
            View deterministic trace <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
};

/* -------------------------------------------------------------------- root -- */

export interface StageTimelineProps {
  data: TimelineStagesResponse | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  presentation?: CasePanelPresentation;
  onOpenInvestigation?: () => void;
}

export const StageTimeline: React.FC<StageTimelineProps> = ({
  data,
  loading,
  error,
  onRetry,
  presentation = 'default',
  onOpenInvestigation,
}) => {
  if (loading) {
    return (
      <div className={cn('space-y-4', presentation === 'default' && 'p-6')}>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className={cn(presentation === 'default' && 'p-6')}>
        <LoadError error={error} title="Could not load the timeline" onRetry={onRetry} />
      </div>
    );
  }
  const stages = data?.stages ?? [];
  if (!stages.length) {
    return (
      <div className={cn(presentation === 'default' && 'p-6')}>
        <EmptyState
          icon={GitBranch}
          title="No timeline yet"
          description="The stage-by-stage narrative appears once the alert has been ingested and triaged."
        />
      </div>
    );
  }
  if (presentation === 'case-manager') {
    return (
      <ol className="relative max-w-5xl py-1">
        {stages.map((stage, index) => (
          <StoryStageRow
            key={stage.id || stage.kind}
            stage={stage}
            terminal={index === stages.length - 1}
            onOpenInvestigation={onOpenInvestigation}
          />
        ))}
      </ol>
    );
  }
  return (
    <div className="p-6">
      <ol className="relative">
        {stages.map((s, i) => (
          <StageRow key={s.id || s.kind} stage={s} last={i === stages.length - 1} />
        ))}
      </ol>
    </div>
  );
};

export default StageTimeline;
