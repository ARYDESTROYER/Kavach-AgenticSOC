/**
 * StageTimeline: the six-stage narrative of how one alert became a case.
 *
 * Consumes `GET /api/cases/{id}/stages` (the `TimelineStage` shape) and renders it as
 * a vertical, chronological story: input → correlate → risk → triage → investigate →
 * decide. Each stage shows a one-line TRUSTED headline + state chips at a glance, and
 * expands to its chronological steps. Deterministic stages (correlate/risk/decide)
 * carry a "deterministic" badge: the trust signal (#3 made visible).
 *
 * SECURITY (#9): a step with `trusted === false` (raw source/log/tool payload) renders
 * its body ONLY inside an escaped <CodeBlock>; trusted prose renders as plain text.
 */
import * as React from 'react';
import { ArrowRight, ChevronDown, GitBranch, Lock } from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, formatTimestamp, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { LoadingState } from '@/design-system';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import type { ScoreBand } from '@/soc/components/palette';
import { displayBand, displayScore } from '@/lib/explain/rounding';

import type {
  StageState,
  StageStep,
  TimelineStage,
  TimelineStagesResponse,
} from '@/soc/pages/CaseDetail.api';

import { RiskDerivation } from './explain/RiskDerivation';

/* --------------------------------------------------------------- state chips -- */

const StateChips: React.FC<{ state: StageState; omitRisk?: boolean }> = ({ state, omitRisk = false }) => {
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
  // Neutral chip: a fixed amber here read as "medium" for every score (CM-6).
  if (typeof state.risk_score === 'number' && !omitRisk) {
    chips.push(<Badge key="risk" variant="outline">risk {displayScore(state.risk_score)}/100</Badge>);
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

// Colour carries VALUE, never the stage kind (CM-6): every stage marker is neutral except
// the risk stage, which takes the band of its own score: so a Risk 7 case is never red.
// No glow shadows; sentence-case titles in the foreground colour.
const BAND_DOT: Record<ScoreBand, string> = {
  low: 'bg-low',
  medium: 'bg-medium',
  high: 'bg-high',
  critical: 'bg-critical',
};
const BAND_SEGMENT: Record<ScoreBand, { on: string; last: string }> = {
  low: { on: 'bg-low/60', last: 'bg-low' },
  medium: { on: 'bg-medium/60', last: 'bg-medium' },
  high: { on: 'bg-high/60', last: 'bg-high' },
  critical: { on: 'bg-critical/70', last: 'bg-critical' },
};

function storyTone(stage: TimelineStage): { dot: string; title: string } {
  if (stage.status === 'skipped' || stage.status === 'pending') {
    return { dot: 'bg-muted-foreground/60', title: 'text-muted-foreground' };
  }
  if (stage.kind === 'risk' && typeof stage.state.risk_score === 'number') {
    return { dot: BAND_DOT[displayBand(stage.state.risk_score)], title: 'text-foreground' };
  }
  if (stage.kind === 'decide') return { dot: 'bg-primary', title: 'text-foreground' };
  return { dot: 'bg-muted-foreground', title: 'text-foreground' };
}

const RiskMicrochart: React.FC<{ score: number }> = ({ score }) => {
  // The shown integer (rounded half up) and ITS band, the one rule for every score (D4).
  const bounded = displayScore(score) ?? 0;
  const segments = 7;
  const active = Math.round((bounded / 100) * segments);
  const band = displayBand(score);
  return (
    <figure className="mt-3 w-48" data-risk-band={band}>
      <figcaption className="mb-1 flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>Risk score</span>
        <span className="tabular-nums">{bounded}/100</span>
      </figcaption>
      <div
        className="flex h-12 items-stretch gap-1 border border-border bg-surface-sunken p-1"
        role="img"
        aria-label={`Risk score ${bounded} out of 100`}
      >
        {Array.from({ length: segments }).map((_, index) => (
          <span
            key={index}
            className={cn(
              'min-w-0 flex-1',
              index < active ? BAND_SEGMENT[band].on : 'bg-muted',
              index === active - 1 && BAND_SEGMENT[band].last,
            )}
            aria-hidden
          />
        ))}
      </div>
    </figure>
  );
};

/**
 * One evidence step under a stage. Untrusted source/log material stays FENCED in a
 * CodeBlock (#9), whose own header carries the step label, the untrusted marker and the
 * copy control: one flat block, never a box inside a box with an empty header bar (CM-8).
 */
const StoryStep: React.FC<{ step: StageStep }> = ({ step }) => {
  const label = step.label || humanizeToken(step.kind) || 'Detail';
  if (step.body && !step.trusted) {
    return (
      <div className="mt-3 max-w-3xl" data-story-step="untrusted">
        <CodeBlock
          value={step.body}
          wrap
          copyable
          maxHeightClassName="max-h-36"
          caption={
            // B80: the trust marker wraps to a second line as one unit at a narrow width
            // instead of being cut mid-word.
            <span
              className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 whitespace-normal font-sans"
              data-untrusted-caption=""
            >
              <span>{label}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 whitespace-nowrap" data-untrusted-marker="">
                <Lock className="h-3 w-3" aria-hidden />
                Untrusted source data
              </span>
            </span>
          }
        />
      </div>
    );
  }
  return (
    <div className="mt-3 max-w-3xl" data-story-step="trusted">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {step.body ? (
        <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/85">
          {step.body}
        </p>
      ) : null}
    </div>
  );
};

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
        <time
          className="w-24 shrink-0 font-mono text-xs text-muted-foreground"
          dateTime={stage.ts || undefined}
          title={stage.ts ? formatTimestamp(stage.ts) : undefined}
        >
          {storyTime(stage.ts)}
        </time>
        <h3 className={cn('text-sm font-semibold', tone.title)}>
          {storyStageTitle(stage)}
        </h3>
        {/* The stage's provenance and state, kept from the full layout. */}
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {stage.deterministic ? (
            <span className="inline-flex items-center gap-1" data-testid="story-stage-deterministic">
              <GitBranch className="h-3 w-3" aria-hidden />
              Deterministic
            </span>
          ) : null}
          {stage.status === 'skipped' ? <span>Skipped</span> : null}
          {stage.status === 'pending' ? <span>Pending</span> : null}
        </span>
      </div>
      <div className="mt-1 sm:ml-28">
        {showHeadline ? (
          <p className="max-w-4xl text-sm leading-relaxed text-foreground/90">
            {stage.headline || DASH}
          </p>
        ) : null}
        {/* The risk stage shows its score ONCE, as the meter below. */}
        <StateChips
          state={stage.state}
          omitRisk={stage.kind === 'risk' && typeof stage.state.risk_score === 'number'}
        />

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
            className="mt-3 h-8 px-3 text-xs"
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
  onOpenInvestigation?: () => void;
}

export const StageTimeline: React.FC<StageTimelineProps> = ({
  data,
  loading,
  error,
  onRetry,
  onOpenInvestigation,
}) => {
  if (loading) {
    return (
      <div>
        <LoadingState
          label="Loading timeline"
          description="Preparing the case journey from ingestion through decision."
          layout="panel"
          shape="rows"
          shapeRows={4}
        />
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <LoadError error={error} title="Could not load the timeline" onRetry={onRetry} />
      </div>
    );
  }
  const stages = data?.stages ?? [];
  if (!stages.length) {
    return (
      <div>
        <EmptyState
          icon={GitBranch}
          title="No timeline yet"
          description="The stage-by-stage narrative appears once the alert has been ingested and triaged."
        />
      </div>
    );
  }
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
};

export default StageTimeline;
