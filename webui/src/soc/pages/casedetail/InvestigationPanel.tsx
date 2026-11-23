/**
 * InvestigationPanel: the Investigation tab (Round 15, SPEC D8.3).
 *
 * The investigation proper, in flat sections divided by hairlines:
 *
 *   1. AI ASSESSMENT: the model's reading only (G17: it never falls back to the code's
 *      `decision_rationale`), the findings it recorded and the query to reproduce them,
 *      with the full assessment evidence (<WhyPanel>) one disclosure away.
 *   2. DECISION: what settled the case (the deterministic `decide()` output, or the
 *      analyst or analyst policy that closed it), its authority sentence ONCE, the
 *      auto-close reading, the policy inputs (<DecisionCard>) one disclosure away, and the
 *      automation applied after it (#3).
 *   3. THREAT CONTEXT: the section that was its own tab (the caller passes it in, loaded
 *      when this tab opens); a link to the retired Threat context tab lands here
 *      (`data-section="threat-context"`).
 *   4. INPUTS: the knowledge and procedures the investigator consulted.
 *   5. TRACE: the ReAct <TraceTimeline>, collapsed with its step and tool counts, an
 *      actor filter and "Jump to decision".
 *   6. PREVIOUS GRADINGS, when any.
 *
 * The verdict, confidence and risk are the header's and the facts rail's (D8.4): this tab
 * does not repeat them.
 *
 * SECURITY (#9): this panel only composes read-only sub-panels; each renders its own
 * model/log-derived text as plain text or inside an escaped CodeBlock. Nothing here
 * decides or mutates a case.
 */
import * as React from 'react';
import { ArrowDown, ChevronDown, Lock } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';

import { WhyPanel } from './WhyPanel';
import { InvestigationInputs } from './InvestigationInputs';
import { DecisionCard } from './DecisionCard';
import { AutomationApplied } from './AutomationApplied';
import { GradingHistory } from './grading';
import { TraceTimeline } from '@/soc/components/TraceTimeline';
import { CodeBlock, InlineCode } from '@/soc/components/CodeBlock';
import { ProvenanceTag } from '@/soc/components/ProvenanceTag';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { isAutoClosedByAI } from '@/soc/components/badges';
import { caseOutcome, isHumanClosed } from '@/soc/components/outcome';
import { aiAssessed, aiAssessmentText } from './caseFacts';
import { CASE_MANAGER_PANEL_PADDING, PanelSection, type FpPolicy } from './shared';

/* --------------------------------------------------------- the Investigation tab -- */

type TraceActor = 'all' | 'agent' | 'tool' | 'code';

const TRACE_ACTOR_KINDS: Record<Exclude<TraceActor, 'all'>, ReadonlySet<string>> = {
  agent: new Set(['invoke_agent', 'chat']),
  tool: new Set(['execute_tool']),
  code: new Set(['decision']),
};

const DisclosureTrigger: React.FC<{
  open: boolean;
  showLabel: string;
  hideLabel: string;
}> = ({ open, showLabel, hideLabel }) => (
  <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
    {open ? hideLabel : showLabel}
  </CollapsibleTrigger>
);

/** A machine decision record (`verdict=… status=… risk=…`), not a sentence. */
const DECISION_RECORD = /^[a-z_]+=\S+(\s+[a-z_]+=\S+)+/i;

/** A finding the agent recorded as clean (a ruled-out check), not a positive finding. */
const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

/** The first sentence of a longer text. */
function firstSentence(text?: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim();
}

// Re-exported for the G17 test and existing importers.
export { aiAssessmentText };

/**
 * The FP auto-close reading of an undecided or code-decided case (one line), or null when
 * no FP policy is configured or a person closed the case. Our own copy (#9).
 */
function autoCloseLine(policy: FpPolicy | undefined, c: Case): string | null {
  if (!policy || typeof policy.min_confidence !== 'number') return null;
  if (isHumanClosed(c)) return null;
  const v = (c.verdict || '').toLowerCase();
  const isFp = v.includes('false') || v === 'fp' || v.includes('benign');
  if (!policy.enabled) {
    // Only a case assessed as false positive and still needing a person: never a true
    // positive or Needs human verdict, and never a recorded AI close.
    if (!isFp || isAutoClosedByAI(c.status, c.decision_by)) return null;
    return 'False-positive auto-close is disabled.';
  }
  if (!isFp) {
    return 'Needs human review and true-positive verdicts never auto-close. The auto-close bar applies to false positives only.';
  }
  const conf = typeof c.confidence === 'number' ? c.confidence : null;
  const risk = typeof c.risk_score === 'number' ? c.risk_score : null;
  const confOk = conf !== null && conf >= policy.min_confidence;
  const riskOk = typeof policy.max_risk_score !== 'number' || (risk !== null && risk <= policy.max_risk_score);
  const bar = policy.min_confidence.toFixed(2);
  if (confOk && riskOk) {
    return `Eligible for auto-close: confidence is at or above the ${bar} bar and risk is within the policy ceiling.`;
  }
  if (!confOk) return `Below the ${bar} auto-close confidence bar, so it is held for a human.`;
  return 'Above the confidence bar, but risk exceeds the auto-close ceiling, so it is held for a human.';
}

/**
 * The Investigation tab (see the module note): the AI assessment, the decision, threat
 * context, the inputs, the collapsed trace and earlier gradings. Every datum of the
 * earlier layout is kept or has one home elsewhere: the reasoning, the findings, the
 * reproduce query, the decision line and record, the policy inputs, the automation, the
 * full assessment evidence, every trace step and the grading history.
 */
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
  traceRequest,
  onTraceRequestHandled,
  fpPolicy,
  threatContext,
}) => {
  const [traceOpen, setTraceOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [decisionOpen, setDecisionOpen] = React.useState(false);
  const [actor, setActor] = React.useState<TraceActor>('all');
  const traceRef = React.useRef<HTMLDivElement | null>(null);
  const traceSectionRef = React.useRef<HTMLElement | null>(null);

  const outcome = caseOutcome(c);
  const humanClosed = isHumanClosed(c);
  const assessment = aiAssessmentText(c, rationale);
  const decisionSummary = rationale?.decision_rationale?.trim() || '';
  const autoClose = autoCloseLine(fpPolicy, c);
  const findings = (c.evidence || []).filter((e) => e && (e.summary || e.query));
  const reproduce = (c.reproduce_query || '').trim();

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
  useTraceRequest(traceRequest, onTraceRequestHandled, traceOpen, setTraceOpen, handleTraceToggle, traceSectionRef);

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
  // model's: it gets its own title (checked first, it is also "human closed").
  const policyClosed = outcome.source === 'analyst_policy';
  const decisionTitle = policyClosed ? 'Analyst policy' : humanClosed ? 'Analyst resolved' : 'Decision';
  const decisionLine =
    humanClosed || policyClosed
      ? `${outcome.headline}${outcome.by ? ` by ${outcome.by}` : ''}.`
      : decisionSummary || 'The server-side case policy recorded the outcome shown for this case.';
  const resolvedByHuman = String(c.status || '').toLowerCase() === 'resolved';
  // The authority sentence, ONCE on the case (D8.3).
  const authority = policyClosed
    ? 'Closed by an operator rule that declared this detection benign. No model was asked.'
    : humanClosed
      ? `${resolvedByHuman ? 'Resolved' : 'Closed'} by an analyst (a human lifecycle action). The deterministic policy did not ${resolvedByHuman ? 'resolve' : 'close'} this case.`
      : 'The close or escalate decision is made by deterministic code against the operator policy, never by the model.';

  return (
    <div
      className={cn('@container/investigation space-y-6', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="investigation"
      data-presentation="case-manager"
    >
      {/* 1. AI ASSESSMENT: the model's reading only (G17), advisory. */}
      <PanelSection
        title="AI assessment"
        headingId="case-manager-assessment-title"
        adornment={<ProvenanceTag kind="ai" />}
        description="The model's reading of the evidence. Advisory only."
        testId="investigation-assessment"
      >
        <div className="max-w-3xl space-y-4">
          {rationaleLoading && !assessment ? (
            <div className="space-y-2" aria-label="Loading AI assessment">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : assessment ? (
            <p data-testid="investigation-assessment-text" className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {/* UNTRUSTED model text: plain text. */}
              {assessment}
            </p>
          ) : (
            <p data-testid="investigation-assessment-text" className="text-sm text-muted-foreground">
              {aiAssessed(c)
                ? 'No assessment text was recorded for this investigation.'
                : 'The AI has not assessed this case.'}
            </p>
          )}

          {findings.length ? (
            <div className="space-y-2" data-testid="investigation-findings">
              <h3 className="text-xs font-medium text-muted-foreground">Findings</h3>
              <ul className="divide-y divide-border/60">
                {findings.map((finding, index) => {
                  const clear = RULED_OUT_RE.test(finding.summary || '');
                  return (
                    <li key={`${finding.summary}-${index}`} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                      <Badge variant={clear ? 'success' : 'high'} className="mt-0.5 shrink-0">
                        {clear ? 'Clear' : 'Found'}
                      </Badge>
                      <div className="min-w-0 flex-1 space-y-1">
                        {/* UNTRUSTED summary: plain text. */}
                        <p className="text-sm text-foreground/90">
                          {finding.summary ? firstSentence(finding.summary) : `Finding ${index + 1}`}
                        </p>
                        {finding.query ? (
                          /* UNTRUSTED query: inside an InlineCode fence. */
                          <InlineCode className="block w-fit max-w-full break-all text-xs">{finding.query}</InlineCode>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {reproduce ? (
            <div className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Reproduce query</h3>
              {/* UNTRUSTED query: inside a CodeBlock fence, copyable. */}
              <CodeBlock value={reproduce} caption="read-only" copyable wrap maxHeightClassName="max-h-40" />
            </div>
          ) : null}

          <Collapsible open={evidenceOpen} onOpenChange={setEvidenceOpen}>
            <DisclosureTrigger
              open={evidenceOpen}
              showLabel="Show full assessment evidence"
              hideLabel="Hide full assessment evidence"
            />
            <CollapsibleContent className="mt-3">
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
        </div>
      </PanelSection>

      {/* 2. DECISION: what settled the case (#3: code or a person, never the model). */}
      <PanelSection
        title={decisionTitle}
        headingId="case-manager-decision-title"
        adornment={<ProvenanceTag kind={humanClosed && !policyClosed ? 'analyst' : 'code'} />}
        testId="investigation-decision"
        data-decided-by={policyClosed ? 'analyst_policy' : humanClosed ? 'analyst' : 'code'}
      >
        <div className="max-w-3xl space-y-2">
          {/* The server's decision record is a `key=value` audit line: show it as the
              record it is (mono, wrapping) rather than as a prose sentence. */}
          <p
            data-testid="investigation-decision-line"
            className={cn(
              'leading-relaxed text-foreground/90',
              DECISION_RECORD.test(decisionLine) ? 'font-mono text-xs [overflow-wrap:anywhere]' : 'text-sm',
            )}
          >
            {decisionLine}
          </p>
          {humanClosed && !policyClosed && decisionSummary ? (
            <p className="text-xs leading-relaxed text-muted-foreground">Before the analyst: {decisionSummary}</p>
          ) : null}
          <p data-testid="investigation-authority" className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{authority}</span>
          </p>
          {autoClose ? (
            <p data-testid="investigation-auto-close" className="text-xs leading-relaxed text-muted-foreground">
              {autoClose}
            </p>
          ) : null}
        </div>
        <Collapsible open={decisionOpen} onOpenChange={setDecisionOpen}>
          <DisclosureTrigger open={decisionOpen} showLabel="Show policy inputs" hideLabel="Hide policy inputs" />
          <CollapsibleContent className="mt-3 max-w-3xl">
            <DecisionCard c={c} rationale={rationale} timeline={timeline} />
          </CollapsibleContent>
        </Collapsible>
        <AutomationApplied c={c} className="max-w-3xl pt-2" />
      </PanelSection>

      {/* 3. THREAT CONTEXT: the retired Threat context tab, loaded when this tab opens. */}
      {threatContext ? (
        <PanelSection title="Threat context" section="threat-context" testId="investigation-threat-context">
          {threatContext}
        </PanelSection>
      ) : null}

      {/* 4. The inputs the latest run selected and actually consulted. */}
      <InvestigationInputs
        rationale={rationale}
        loading={rationaleLoading}
        error={rationaleError}
        onRetry={onRetryRationale}
        onReview={() => setEvidenceOpen(true)}
        showSelectionStatus
      />

      {/* 5. TRACE: collapsed by default; every step is one click away. */}
      <section
        ref={traceSectionRef}
        aria-labelledby="case-manager-trace-title"
        className="scroll-mt-4 space-y-3 border-t border-border/60 pt-6 first:border-t-0 first:pt-0"
        data-testid="investigation-trace"
      >
        <Collapsible open={traceOpen} onOpenChange={handleTraceToggle}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* Where a request to open the trace lands focus that had dropped. */}
            <h2
              id="case-manager-trace-title"
              tabIndex={-1}
              data-trace-focus=""
              className="rounded-sm text-base font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
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
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', traceOpen && 'rotate-180')} aria-hidden />
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

      {/* 6. Earlier gradings of the AI on this case. */}
      {c.feedback && c.feedback.length ? (
        <PanelSection title="Previous gradings" testId="investigation-gradings">
          <GradingHistory feedback={c.feedback} className="max-w-3xl" />
        </PanelSection>
      ) : null}
    </div>
  );
};

/* --------------------------------------------------------------- component -- */

export interface InvestigationPanelProps {
  c: Case;

  /** AI-ASSESSMENT lane: the decision rationale projection. */
  rationale: CaseRationale | null;
  rationaleLoading: boolean;
  rationaleError: unknown;
  onRetryRationale: () => void;

  /** DECISION lane + the collapsible full trace: the typed ReAct spans. */
  timeline: TimelineResponse | null;
  timelineLoading: boolean;
  timelineError: unknown;
  onRetryTimeline: () => void;

  /**
   * A request to open the full trace and bring it into view, a new number per request
   * (the audit log's "Open case trace" link names this tab). Focus that dropped lands on
   * the trace too. The panel handles each one once and reports it, so returning to the
   * tab never replays it.
   */
  traceRequest?: number | null;
  onTraceRequestHandled?: (tick: number) => void;

  /** The FP auto-close policy, for the Decision's auto-close reading (best-effort). */
  fpPolicy?: FpPolicy;
  /**
   * Round 15 (D8.3): the Threat context section's body (the retired Threat context tab),
   * which the caller loads when this tab opens. Omitted: no Threat context section.
   */
  threatContext?: React.ReactNode;
}

/**
 * Applies a {@link InvestigationPanelProps.traceRequest} once: opens the trace, reports the
 * request handled, then scrolls `target` to the top of the case's scroll lane once the open
 * trace has rendered. The open itself does not fetch: in the same commit the case detail
 * starts the trace's lazy load for the newly selected tab, and a second request would
 * race it. After a beat (which also lets the case detail reset its lane for the new tab
 * first) `openTrace` loads the trace if nothing has, a no-op while it loads or once loaded.
 * A trace closed again before that beat stays closed and is not scrolled to.
 *
 * Focus moves to the trace's `[data-trace-focus]` element only when it has dropped, as it
 * does when the link that asked left with its page (WCAG 2.4.3): keyboard and screen
 * reader users are taken to the trace they asked for. A control the analyst is using
 * keeps focus, such as the queue search typed into while the case loads.
 */
function useTraceRequest(
  traceRequest: number | null | undefined,
  onHandled: ((tick: number) => void) | undefined,
  traceOpen: boolean,
  setTraceOpen: (open: boolean) => void,
  openTrace: (open: boolean) => void,
  target: React.RefObject<HTMLElement | null>,
): void {
  const handledRef = React.useRef<number | null>(null);
  const [reveal, setReveal] = React.useState(false);
  React.useEffect(() => {
    if (traceRequest == null || handledRef.current === traceRequest) return;
    handledRef.current = traceRequest;
    setTraceOpen(true);
    setReveal(true);
    onHandled?.(traceRequest);
  }, [traceRequest, onHandled, setTraceOpen]);
  React.useEffect(() => {
    if (!reveal) return;
    if (!traceOpen) {
      // Closed by hand before it came into view: the analyst's choice stands, and a later
      // open by hand is an ordinary open.
      setReveal(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setReveal(false);
      openTrace(true);
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        target.current?.querySelector<HTMLElement>('[data-trace-focus]')?.focus({ preventScroll: true });
      }
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      target.current?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [reveal, traceOpen, openTrace, target]);
}

export default InvestigationPanel;
