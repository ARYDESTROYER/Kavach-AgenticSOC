/**
 * InvestigationPanel — the "Investigation" tab (task 5 split).
 *
 * Task 5 split the old merged "Timeline" tab: the "what happened" six-stage narrative
 * now lives alone on the sibling <TimelinePanel> ("Timeline" tab), and THIS panel is the
 * investigation proper — the model's assessment, the pinned deterministic decision, and
 * the full ReAct trace. It follows the DESIGN_DIRECTION "lane separation, never
 * interleaved":
 *
 *   1. AI ASSESSMENT  — the model's reasoning / knowledge / tools / enrichment
 *                       (<WhyPanel hideDecision hideMitre>), rendered in a persistently
 *                       AI-marked lane so model prose never blends into a fact stream.
 *   2. DECISION       — the pinned <DecisionCard>: the deterministic `decide()` output,
 *                       the single authority (#3), most-prominent and last.
 *   3. FULL TRACE     — the raw ReAct <TraceTimeline>, available as a collapsible
 *                       "Full agent trace" disclosure for the step-by-step span log.
 *
 * SECURITY (#9): this panel only composes read-only sub-panels; each renders its own
 * model/log-derived text as plain text or inside an escaped CodeBlock. Nothing here
 * decides or mutates a case.
 */
import * as React from 'react';
import { ArrowDown, Bot, ChevronDown, Gauge, Lightbulb, ListTree, ShieldCheck, UserCheck } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { cn } from '@/lib/cn';
import { DASH, fmtPercent, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';

import { WhyPanel } from './WhyPanel';
import { InvestigationInputs } from './InvestigationInputs';
import { DecisionCard } from './DecisionCard';
import { GradingHistory } from './grading';
import { TraceTimeline } from '@/soc/components/TraceTimeline';
import { ProvenanceTag } from '@/soc/components/ProvenanceTag';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { scoreBand, type ScoreBand } from '@/soc/components/palette';
import { caseOutcome, isHumanClosed, isHumanSettled } from '@/soc/components/outcome';
import { riskValue, statusWords } from './caseFacts';
import { CASE_MANAGER_PANEL_PADDING, type CasePanelPresentation } from './shared';

/* --------------------------------------------------------------- zone header -- */

/** A lane header — an icon chip + title + subtitle, optionally flagged "AI". `lead`
 *  bumps the chip + title so the lane reads as a prominent story opener. */
const ZoneHeader: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  ai?: boolean;
  lead?: boolean;
}> = ({ icon: Icon, title, subtitle, ai = false, lead = false }) => (
  <div className="flex items-center gap-2.5">
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md border',
        lead ? 'h-9 w-9' : 'h-7 w-7',
        ai ? 'border-info/40 bg-info/10 text-info' : 'border-border bg-muted text-muted-foreground',
      )}
      aria-hidden
    >
      <Icon className={cn(lead ? 'h-5 w-5' : 'h-4 w-4')} />
    </span>
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <h3
          className={cn(
            'font-semibold tracking-tight text-foreground',
            lead ? 'text-lg' : 'text-sm',
          )}
        >
          {title}
        </h3>
        {ai ? (
          <Badge variant="info" className="gap-1">
            <Bot className="size-3 shrink-0" aria-hidden />
            AI
          </Badge>
        ) : null}
      </div>
      <p className={cn('text-muted-foreground', lead ? 'text-sm' : 'text-xs')}>{subtitle}</p>
    </div>
  </div>
);

/* ------------------------------------------------- Case Manager presentation -- */

type TraceActor = 'all' | 'agent' | 'tool' | 'code';

const TRACE_ACTOR_KINDS: Record<Exclude<TraceActor, 'all'>, ReadonlySet<string>> = {
  agent: new Set(['invoke_agent', 'chat']),
  tool: new Set(['execute_tool']),
  code: new Set(['decision']),
};

const RISK_TEXT: Record<ScoreBand, string> = {
  low: 'text-low-text',
  medium: 'text-medium-text',
  high: 'text-high-text',
  critical: 'text-critical-text',
};

const DisclosureTrigger: React.FC<{
  open: boolean;
  icon: React.ComponentType<{ className?: string }>;
  showLabel: string;
  hideLabel: string;
}> = ({ open, icon: Icon, showLabel, hideLabel }) => (
  <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Icon className="h-3.5 w-3.5" aria-hidden />
    {open ? hideLabel : showLabel}
    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
  </CollapsibleTrigger>
);

/**
 * The Case Manager Investigation tab, DECISION FIRST (CM-6): what settled the case →
 * the AI assessment (neutral; red only for a critical RISK band) → its evidence → the
 * policy inputs → the inputs consulted → the trace, collapsed with step/tool counts, an
 * actor filter and "Jump to decision". Every datum of the earlier layout is kept: the
 * summary, confidence, recommended action, risk score, inputs, every trace step, the
 * decision summary + status, the full assessment evidence, the policy inputs and the
 * grading history.
 */
const CaseManagerInvestigation: React.FC<Omit<InvestigationPanelProps, 'presentation'>> = ({
  c,
  rationale,
  rationaleLoading,
  rationaleError,
  onRetryRationale,
  timeline,
  timelineLoading,
  timelineError,
  onRetryTimeline,
}) => {
  const [traceOpen, setTraceOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [decisionOpen, setDecisionOpen] = React.useState(false);
  const [actor, setActor] = React.useState<TraceActor>('all');
  const traceRef = React.useRef<HTMLDivElement | null>(null);

  const outcome = caseOutcome(c);
  const humanClosed = isHumanClosed(c);
  const humanSettled = isHumanSettled(outcome);
  const confidence = typeof rationale?.confidence === 'number' ? rationale.confidence : c.confidence;
  const summary =
    rationale?.reasoning?.trim() || rationale?.decision_rationale?.trim() || c.summary?.trim() || '';
  const recommendation = c.recommended_action?.trim() || '';
  const decisionSummary = rationale?.decision_rationale?.trim() || '';
  const risk = riskValue(c.risk_score);
  const band = risk === null ? null : scoreBand(risk);
  const criticalRisk = band === 'critical';

  const spans = timeline?.spans ?? [];
  const toolCount = spans.filter((span) => span.kind === 'execute_tool').length;
  const hasDecisionStep = spans.some((span) => span.kind === 'decision');
  const filteredTimeline = React.useMemo<TimelineResponse | null>(() => {
    if (!timeline || actor === 'all') return timeline;
    const kinds = TRACE_ACTOR_KINDS[actor];
    return { ...timeline, spans: timeline.spans.filter((span) => kinds.has(span.kind)) };
  }, [timeline, actor]);

  const handleTraceToggle = React.useCallback(
    (open: boolean) => {
      setTraceOpen(open);
      if (open && timeline === null && !timelineLoading && !timelineError) onRetryTimeline();
    },
    [timeline, timelineLoading, timelineError, onRetryTimeline],
  );

  const jumpToDecision = React.useCallback(() => {
    setActor('all');
    setTraceOpen(true);
    // After the (possibly just opened, possibly re-filtered) trace renders.
    window.setTimeout(() => {
      const step = traceRef.current?.querySelector<HTMLElement>('[data-trace-kind="decision"]');
      if (!step) return;
      step.scrollIntoView({ block: 'center', behavior: 'smooth' });
      step.focus({ preventScroll: true });
    }, 60);
  }, []);

  // An operator's declared-benign policy is neither a person's case work nor the
  // model's: it gets its own title (checked first — it is also "human closed").
  const policyClosed = outcome.source === 'analyst_policy';
  const decisionTitle = policyClosed ? 'Analyst policy' : humanClosed ? 'Analyst resolved' : 'Decision';
  const decisionLine =
    humanClosed || policyClosed
      ? `${outcome.headline}${outcome.by ? ` by ${outcome.by}` : ''}.`
      : decisionSummary || 'The server-side case policy recorded the outcome shown for this case.';

  return (
    <div
      className={cn('space-y-6', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="investigation"
      data-presentation="case-manager"
    >
      {/* 1. DECISION — what settled the case, first (#3: code or a person, never the model). */}
      <section
        aria-labelledby="case-manager-decision-title"
        data-testid="investigation-decision"
        data-decided-by={policyClosed ? 'analyst_policy' : humanClosed ? 'analyst' : 'code'}
        className="space-y-3 border-b border-border pb-5"
      >
        <div className="flex flex-wrap items-start gap-3">
          <span
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-foreground"
            aria-hidden
          >
            {humanClosed && !policyClosed ? <UserCheck className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="case-manager-decision-title"
                className="text-base font-semibold tracking-tight text-foreground"
              >
                {decisionTitle}
              </h2>
              <ProvenanceTag kind={humanClosed && !policyClosed ? 'analyst' : 'code'} />
            </div>
            <p className="mt-1 text-sm leading-relaxed text-foreground/90">{decisionLine}</p>
            {humanClosed && !policyClosed && decisionSummary ? (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Before the analyst: {decisionSummary}
              </p>
            ) : null}
            {humanSettled && outcome.aiLine ? (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="investigation-ai-line">
                {outcome.aiLine}
              </p>
            ) : null}
          </div>
          <Badge variant="outline" className="self-start">
            {c.status ? statusWords(c.status) : 'Pending'}
          </Badge>
        </div>
        <Collapsible open={decisionOpen} onOpenChange={setDecisionOpen}>
          <DisclosureTrigger
            open={decisionOpen}
            icon={ShieldCheck}
            showLabel="Show policy inputs"
            hideLabel="Hide policy inputs"
          />
          <CollapsibleContent className="mt-3">
            <DecisionCard c={c} rationale={rationale} timeline={timeline} />
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* 2. AI ASSESSMENT — advisory. Neutral frame; only a critical RISK band is red. */}
      <section
        aria-labelledby="case-manager-assessment-title"
        data-testid="investigation-assessment"
        data-risk-band={band ?? undefined}
        className={cn(
          'relative overflow-hidden rounded-lg border bg-card p-4',
          criticalRisk ? 'border-critical/40' : 'border-border',
        )}
      >
        {criticalRisk ? <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-critical" /> : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"
              aria-hidden
            >
              <Bot className="h-4 w-4" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  id="case-manager-assessment-title"
                  className="text-base font-semibold tracking-tight text-foreground"
                >
                  AI assessment
                </h2>
                <ProvenanceTag kind="ai" />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The model&apos;s reading of the evidence. Advisory only.
              </p>
            </div>
          </div>
          {typeof confidence === 'number' ? (
            <div className="text-right">
              <div className="text-xs text-muted-foreground">
                {humanSettled ? 'AI confidence at assessment' : 'Confidence'}
              </div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
                {fmtPercent(confidence)}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-3">
          {rationaleLoading && !summary ? (
            <div className="space-y-2" aria-label="Loading AI assessment">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : summary ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{summary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No assessment summary was recorded for this investigation.
            </p>
          )}
        </div>

        <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lightbulb className="h-3.5 w-3.5" aria-hidden />
              {humanClosed ? 'AI recommendation at triage' : 'Recommended action'}
            </dt>
            <dd
              className={cn(
                'mt-1 text-sm',
                humanClosed ? 'text-muted-foreground' : 'text-foreground/90',
              )}
            >
              {recommendation || 'No recommended action was recorded.'}
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              Risk score
            </dt>
            <dd className="mt-1 flex items-baseline gap-1.5">
              <span
                className={cn('text-xl font-semibold tabular-nums', band ? RISK_TEXT[band] : 'text-foreground')}
                data-testid="investigation-risk"
              >
                {risk !== null ? `${risk}/100` : DASH}
              </span>
              {band ? <span className="text-xs text-muted-foreground">{humanizeToken(band)}</span> : null}
            </dd>
          </div>
        </dl>

        <Collapsible className="mt-3" open={evidenceOpen} onOpenChange={setEvidenceOpen}>
          <DisclosureTrigger
            open={evidenceOpen}
            icon={Bot}
            showLabel="Show full assessment evidence"
            hideLabel="Hide full assessment evidence"
          />
          <CollapsibleContent className="mt-3 overflow-hidden rounded-md border border-border">
            <WhyPanel
              c={c}
              rationale={rationale}
              loading={rationaleLoading}
              error={rationaleError}
              onRetry={onRetryRationale}
              hideDecision
              hideMitre
            />
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* 3. The inputs the latest run selected and actually consulted. */}
      <InvestigationInputs
        rationale={rationale}
        loading={rationaleLoading}
        error={rationaleError}
        onRetry={onRetryRationale}
        onReview={() => setEvidenceOpen(true)}
        showSelectionStatus
      />

      {/* 4. TRACE — collapsed by default; every step is one click away. */}
      <section aria-labelledby="case-manager-trace-title" className="space-y-3" data-testid="investigation-trace">
        <Collapsible open={traceOpen} onOpenChange={handleTraceToggle}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <ListTree className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 id="case-manager-trace-title" className="text-sm font-semibold text-foreground">
              Investigation trace
            </h2>
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="investigation-trace-counts">
              {timeline
                ? `${spans.length} step${spans.length === 1 ? '' : 's'} · ${toolCount} tool${toolCount === 1 ? '' : 's'}`
                : timelineLoading
                  ? 'Loading…'
                  : 'Loads when opened'}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {hasDecisionStep ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={jumpToDecision}>
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  Jump to decision
                </Button>
              ) : null}
              <CollapsibleTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs">
                  {traceOpen ? 'Hide trace' : 'Show trace'}
                  <ChevronDown
                    className={cn('h-3.5 w-3.5 transition-transform', traceOpen && 'rotate-180')}
                    aria-hidden
                  />
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
          <CollapsibleContent className="mt-3 space-y-3">
            {timeline && spans.length ? (
              <SegmentedControl<TraceActor>
                size="sm"
                aria-label="Show trace steps by"
                value={actor}
                onValueChange={setActor}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'agent', label: 'Agent' },
                  { value: 'tool', label: 'Tool' },
                  { value: 'code', label: 'Code' },
                ]}
              />
            ) : null}
            <div ref={traceRef}>
              {filteredTimeline && actor !== 'all' && filteredTimeline.spans.length === 0 ? (
                <p className="text-sm text-muted-foreground">No steps of this kind in the trace.</p>
              ) : (
                <TraceTimeline
                  data={filteredTimeline}
                  loading={timelineLoading}
                  error={timelineError}
                  onRetry={onRetryTimeline}
                  presentation="case-manager"
                />
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <GradingHistory feedback={c.feedback} />
    </div>
  );
};

/* --------------------------------------------------------------- component -- */

export interface InvestigationPanelProps {
  c: Case;

  /** AI-ASSESSMENT lane — the decision rationale projection. */
  rationale: CaseRationale | null;
  rationaleLoading: boolean;
  rationaleError: unknown;
  onRetryRationale: () => void;

  /** DECISION lane + the collapsible full trace — the typed ReAct spans. */
  timeline: TimelineResponse | null;
  timelineLoading: boolean;
  timelineError: unknown;
  onRetryTimeline: () => void;
  presentation?: CasePanelPresentation;
}

export const InvestigationPanel: React.FC<InvestigationPanelProps> = ({
  c,
  rationale,
  rationaleLoading,
  rationaleError,
  onRetryRationale,
  timeline,
  timelineLoading,
  timelineError,
  onRetryTimeline,
  presentation = 'default',
}) => {
  const [traceOpen, setTraceOpen] = React.useState(false);

  // Lazy-load the raw trace the first time the disclosure opens, if the parent hasn't
  // already fetched it (the DecisionCard reads its policy_clause from the same data).
  const handleTraceToggle = React.useCallback(
    (open: boolean) => {
      setTraceOpen(open);
      if (open && timeline === null && !timelineLoading && !timelineError) {
        onRetryTimeline();
      }
    },
    [timeline, timelineLoading, timelineError, onRetryTimeline],
  );

  if (presentation === 'case-manager') {
    return (
      <CaseManagerInvestigation
        c={c}
        rationale={rationale}
        rationaleLoading={rationaleLoading}
        rationaleError={rationaleError}
        onRetryRationale={onRetryRationale}
        timeline={timeline}
        timelineLoading={timelineLoading}
        timelineError={timelineError}
        onRetryTimeline={onRetryTimeline}
      />
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* ============================================== 1. AI assessment */}
      <section aria-label="AI assessment" className="space-y-1">
        <ZoneHeader
          icon={Bot}
          title="AI assessment"
          subtitle="The model's reasoning, the knowledge it retrieved, and the tools it ran."
          ai
          lead
        />
        {/* Persistent AI-marked lane: an info tint so model prose never reads as fact.
            hideDecision → the pinned DecisionCard is the sole decision authority (#3);
            hideMitre → MITRE is surfaced once in the Threat lane, not repeated here. */}
        <div className="overflow-hidden rounded-lg border border-info/30 bg-info/5">
          <WhyPanel
            c={c}
            rationale={rationale}
            loading={rationaleLoading}
            error={rationaleError}
            onRetry={onRetryRationale}
            hideDecision
            hideMitre
          />
        </div>
        {/* Prior analyst gradings of this AI decision (Round-7 #10). Read-only; renders
            nothing until a close-with-grade has recorded feedback. `pt-4` (not a margin)
            survives the section's `space-y-1` sibling-margin reset. */}
        <GradingHistory feedback={c.feedback} className="pt-4" />
      </section>

      {/* ============================================== 2. Decision (pinned) */}
      <section aria-label="Decision" className="space-y-1">
        <ZoneHeader
          icon={ShieldCheck}
          title="Decision"
          subtitle="The deterministic close / escalate authority — never raw model output."
        />
        <DecisionCard c={c} rationale={rationale} timeline={timeline} />
      </section>

      {/* ============================================== Full trace (disclosure) */}
      <Collapsible open={traceOpen} onOpenChange={handleTraceToggle}>
        <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListTree className="h-3.5 w-3.5" aria-hidden />
          {traceOpen ? 'Hide' : 'Show'} full agent trace
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', traceOpen && 'rotate-180')}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-lg border border-border bg-card">
            <TraceTimeline
              data={timeline}
              loading={timelineLoading}
              error={timelineError}
              onRetry={onRetryTimeline}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export default InvestigationPanel;
