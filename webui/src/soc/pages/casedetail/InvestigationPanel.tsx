/**
 * InvestigationPanel: the AI investigation tab, id `investigation` (Round 16, SPEC D8,
 * §4.4 WP03; the Investigation tab before it). The AI lane, and only it.
 *
 * One muted line first: the model is advisory and the code decides (the Decision is the
 * Brief's lane). Then, in flat sections divided by hairlines:
 *
 *   1. AI ASSESSMENT: the model's reading only (G17: it never falls back to the code's
 *      `decision_rationale`), the findings it recorded (`FindingsList`, whose "Cites N
 *      events" opens the Evidence tab narrowed to those events) and the query to
 *      reproduce them, with the full assessment evidence (<WhyPanel>) one disclosure away.
 *   2. INPUTS: the knowledge and procedures the investigator consulted.
 *   3. TRACE: the ReAct <TraceTimeline>, with its step and tool counts, an actor filter
 *      and "Jump to decision"; collapsed, and open while an AI run is under way.
 *   4. PREVIOUS GRADINGS, when any.
 *
 * Moved out (Round 16): the Decision and the automation applied (the Brief's Decision
 * lane), and Threat context (the Evidence tab). Nothing on this tab is the code's or the
 * source's, so no `code` provenance tag renders here. The verdict, confidence and risk are
 * the header's.
 *
 * SECURITY (#9): this panel only composes read-only sub-panels; each renders its own
 * model/log-derived text as plain text or inside an escaped CodeBlock. Nothing here
 * decides or mutates a case.
 */
import * as React from 'react';
import { ArrowDown, ChevronDown } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';

import { WhyPanel } from './WhyPanel';
import { InvestigationInputs } from './InvestigationInputs';
import { GradingHistory } from './grading';
import { FindingsList } from './records/FindingsList';
import {
  TRACE_FILTERS,
  TraceTimeline,
  filterSpans,
  traceCountsText,
  type TraceActor as TraceSpanActor,
} from '@/soc/components/TraceTimeline';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { ProvenanceTag } from '@/soc/components/ProvenanceTag';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { aiAssessed, aiAssessmentText } from './caseFacts';
import { CASE_MANAGER_PANEL_PADDING, PanelSection } from './shared';

/* --------------------------------------------------------- the Investigation tab -- */

/**
 * Whether the rationale was built from only the newest audit records of a long-lived case
 * (`GET /cases/{id}/rationale`: `returned`, `rows_total`, `rows_total_relation` and
 * `truncated`, additive since Round 16), said the way the trace says it (`traceCutText`).
 * Null when the rationale read every record, or came from a server without the fields.
 */
export function rationaleCutText(rationale: CaseRationale | null | undefined): string | null {
  if (!rationale || rationale.truncated !== true) return null;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const returned = count(rationale.returned);
  const total = count(rationale.rows_total);
  if (returned === null || total === null) {
    return 'Built from the newest records only. Older records are not used here.';
  }
  const atLeast = rationale.rows_total_relation === 'gte' ? 'at least ' : '';
  return `Built from the newest ${returned.toLocaleString('en-US')} of ${atLeast}${total.toLocaleString('en-US')} records. The audit log has the rest.`;
}

/**
 * The trace filter: the one actor model of `TraceTimeline` (`spanActor`), so Agent never
 * counts a person's step or a chat turn, and People and Chat have their own choices.
 */
type TraceActor = TraceSpanActor | 'all';

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

// Re-exported for the G17 test and existing importers.
export { aiAssessmentText };

/** The tab's first line: the model is advisory, and the code decides. */
export const AI_ADVISORY_LINE = 'Advisory. The case route is decided by code; see the Decision on the Brief.';

/**
 * The AI investigation tab (see the module note): the AI assessment, the inputs, the
 * trace and earlier gradings. Every datum of the earlier layout is kept or has one home
 * elsewhere: the reasoning, the findings, the reproduce query, the full assessment
 * evidence, every trace step and the grading history here; the decision line and record,
 * the policy inputs and the automation on the Brief; threat context on Evidence.
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
  aiRunning = false,
  onShowEvents,
}) => {
  const [traceOpen, setTraceOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [actor, setActor] = React.useState<TraceActor>('all');
  const traceRef = React.useRef<HTMLDivElement | null>(null);
  const traceSectionRef = React.useRef<HTMLElement | null>(null);

  const assessment = aiAssessmentText(c, rationale);
  const rationaleCut = rationaleCutText(rationale);
  const findings = (c.evidence || []).filter((e) => e && (e.summary || e.query));
  const reproduce = (c.reproduce_query || '').trim();

  const spans = timeline?.spans ?? [];
  const hasDecisionStep = spans.some((span) => span.kind === 'decision');
  const filteredTimeline = React.useMemo<TimelineResponse | null>(() => {
    if (!timeline || actor === 'all') return timeline;
    return { ...timeline, spans: filterSpans(timeline.spans, actor) };
  }, [timeline, actor]);

  const handleTraceToggle = React.useCallback(
    (open: boolean) => {
      setTraceOpen(open);
      if (open && timeline === null && !timelineLoading && !timelineError) onRetryTimeline();
    },
    [timeline, timelineLoading, timelineError, onRetryTimeline],
  );
  useTraceRequest(traceRequest, onTraceRequestHandled, traceOpen, setTraceOpen, handleTraceToggle, traceSectionRef);
  // While an AI run is under way the trace opens (and loads), once per run; the analyst can
  // still fold it.
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (aiRunning && !wasRunning.current) handleTraceToggle(true);
    wasRunning.current = aiRunning;
  }, [aiRunning, handleTraceToggle]);

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

  return (
    <div
      className={cn('@container/investigation space-y-6', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="investigation"
      data-presentation="case-manager"
    >
      <p className="text-xs leading-relaxed text-muted-foreground" data-testid="case-tab-first">
        {AI_ADVISORY_LINE}
      </p>

      {/* 1. AI ASSESSMENT: the model's reading only (G17), advisory. */}
      <PanelSection
        title="AI assessment"
        headingId="case-manager-assessment-title"
        adornment={<ProvenanceTag kind="ai" />}
        testId="investigation-assessment"
        // The advisory line above introduces it: no hairline between the two.
        className="border-t-0 pt-0"
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

          {rationaleCut ? (
            <p className="text-xs text-muted-foreground" data-testid="rationale-cut">
              {rationaleCut}
            </p>
          ) : null}

          <FindingsList findings={findings} onShowEvents={onShowEvents} />

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

      {/* 2. The inputs the latest run selected and actually consulted. */}
      <InvestigationInputs
        rationale={rationale}
        loading={rationaleLoading}
        error={rationaleError}
        onRetry={onRetryRationale}
        onReview={() => setEvidenceOpen(true)}
        showSelectionStatus
      />

      {/* 3. TRACE: collapsed by default and open while an AI run is under way. */}
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
                ? traceCountsText(spans)
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
                options={[...TRACE_FILTERS]}
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

      {/* 4. Earlier gradings of the AI on this case. */}
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

  /** The collapsible full trace: the typed ReAct spans. */
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

  /**
   * An AI investigation run is queued or running on this case (`useAiRun`): the trace
   * opens, so the analyst can watch it.
   */
  aiRunning?: boolean;
  /** A finding's "Cites N events": open the Evidence tab narrowed to those events. */
  onShowEvents?: (eventIds: string[]) => void;
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
