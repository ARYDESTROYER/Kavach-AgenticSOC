/**
 * CaseDetail: the Brief tab, id `overview` (Round 16, SPEC D8, §4.4 WP03; the Overview
 * before it).
 *
 * The four-lane answer to "what is this case", above the fold. Top to bottom:
 *
 *   1. REVIEW NOTE   one line on a pending auto-close review sample (the sentence the
 *                    header's review band used to carry; Start review is the header's
 *                    primary action).
 *   2. NEXT STEP     one 48px row for the runbook's next required step on an open case;
 *                    the full card is on the Response tab.
 *   3. THE LANES     one list, each lane tagged with its provenance and linking to its tab:
 *                    Evidence (`source`): why it fired and one line of counts and times;
 *                    Assessment (`ai`): the model's summary lead and its recommendation;
 *                    Decision (`code`, or the person who settled it): the decision line,
 *                    the auto-close reading, the authority sentence, Policy inputs and
 *                    Automation applied (`DecisionLane`);
 *                    People (`analyst`): runbook progress, discussion and files, and the
 *                    last human action (a lifecycle move or a runbook step a person did).
 *   4. HOW THIS CASE WAS BUILT  the six-stage story, folded: the one place the lanes meet.
 *
 * One home per fact: the lanes never repeat the header's verdict, confidence, risk,
 * status or owner. The Assessment lane is the model's own reasoning (G17); the decision
 * text is the code's and appears only in the Decision lane. A case the AI did not assess
 * says so.
 *
 * SECURITY (#9): every case-derived value (summary, recommendation, trigger sentence,
 * entity, source name, names) is UNTRUSTED, rendered as plain text, never as markup or a
 * CSS or href value. #3: read only; it never decides or mutates the case.
 */
import * as React from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, ClipboardCheck } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { RunbookProgress, RunbookRun } from '@/lib/types-runbooks';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { humanizeAge } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';

import { ProvenanceTag } from '@/soc/components/ProvenanceTag';
import { caseOutcome, isHumanClosed, isTerminalStatus } from '@/soc/components/outcome';
import type { Navigate } from '@/soc/router';
import type { CaseTab } from '@/soc/case-tabs';
import { nextStep } from '@/soc/runbooks/run/model';
import { PHASE_LABEL } from '@/soc/runbooks/shared/labels';

import { aiAssessed, aiAssessmentText, entityTypeLabel } from './caseFacts';
import { caseHistoryItems } from './CaseHistory';
import { DecisionLane, decisionTitle } from './DecisionLane';
import { triggerSentence } from './EvidencePanel';
import { riskFactorBarColor } from './SignalProfile';
import { REVIEW_BAND_TEXT } from './review/review-plan';
import { CASE_MANAGER_PANEL_PADDING, type FpPolicy } from './shared';

// Re-exported for existing importers: the factor bars live in the facts rail.
export { riskFactorBarColor };

/** At most this many sentences of the AI summary lead the Brief. */
const SUMMARY_SENTENCES = 3;

/** The first `max` sentences of a longer text (falls back to the trimmed whole). */
export function leadSentences(text: string | null | undefined, max = SUMMARY_SENTENCES): string {
  const trimmed = (text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  // A sentence ends at . ! or ? followed by a space, so "62.5" or "10.0.0.5" never split.
  return trimmed.split(/(?<=[.!?])\s+/).slice(0, max).join(' ').trim();
}

/** Compare two prose sentences ignoring case, spacing and trailing punctuation. */
function normalizeSentence(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

/** "04:21 UTC", or "2026-11-03 04:21 UTC" when `withDate`. */
function utcTime(ms: number, withDate: boolean): string {
  const iso = new Date(ms).toISOString();
  return `${withDate ? `${iso.slice(0, 10)} ` : ''}${iso.slice(11, 16)} UTC`;
}

/** An epoch-millis field of the case, or null. */
function epochField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** The Evidence lane's quiet line: events, entity, first and last seen, source. Plain data (#9). */
export function evidenceFacts(c: Case): string[] {
  const parts: string[] = [];
  const events = Array.isArray(c.member_event_keys)
    ? c.member_event_keys.length
    : Array.isArray(c.member_event_ids)
      ? c.member_event_ids.length
      : 0;
  if (events) parts.push(`${events.toLocaleString()} event${events === 1 ? '' : 's'}`);
  const value = c.entity?.value ? String(c.entity.value) : '';
  const type = c.entity?.type || c.entity_type;
  if (value) parts.push(type ? `${entityTypeLabel(String(type))} ${value}` : value);
  const first = epochField(c.first_seen_millis) ?? epochField(c.detected_at);
  const last = epochField(c.last_seen_millis);
  if (first !== null) {
    const sameDay = last === null || new Date(first).toISOString().slice(0, 10) === new Date(last).toISOString().slice(0, 10);
    parts.push(`first ${utcTime(first, !sameDay)}`);
    if (last !== null && last !== first) parts.push(`last ${utcTime(last, !sameDay)}`);
  }
  if (c.source_name) parts.push(c.source_name);
  return parts;
}

/** The newest runbook step a person finished (done or not applicable), or null. */
function lastPersonStep(
  runs: readonly RunbookRun[] | null | undefined,
): { words: string; who: string; at: string; ms: number } | null {
  let best: { words: string; who: string; at: string; ms: number } | null = null;
  for (const run of runs ?? []) {
    for (const state of Object.values(run.steps ?? {})) {
      if (!state || (state.status !== 'done' && state.status !== 'not_applicable')) continue;
      const who = typeof state.completed_by === 'string' ? state.completed_by.trim() : '';
      const at = typeof state.completed_at === 'string' ? state.completed_at : '';
      const ms = Date.parse(at);
      if (!who || Number.isNaN(ms) || (best && best.ms >= ms)) continue;
      best = { words: state.status === 'done' ? 'Runbook step done' : 'Runbook step marked not applicable', who, at, ms };
    }
  }
  return best;
}

/**
 * The People lane's last human action ("Acknowledged by lee, 12m ago"): the newest of
 * the person's lifecycle actions in the history and the runbook steps a person finished
 * ("Runbook step done by asha.iyer, 12m ago"), or null when there is neither. Names are
 * UNTRUSTED data for a text node (#9).
 */
export function lastHumanAction(c: Case, runs?: readonly RunbookRun[] | null): string | null {
  const item = caseHistoryItems(c).find((entry) => entry.actor === 'person');
  const step = lastPersonStep(runs);
  const itemMs = item?.ts ? Date.parse(item.ts) : Number.NaN;
  // A history entry without a readable time keeps its place: it cannot be compared.
  if (step && (!item || (!Number.isNaN(itemMs) && step.ms > itemMs))) {
    return `${step.words} by ${step.who}, ${humanizeAge(step.at)}`;
  }
  if (!item) return null;
  const when = item.ts ? `, ${humanizeAge(item.ts)}` : '';
  const line = `${item.title}${item.who ? ` by ${item.who}` : ''}${when}`;
  // A run that was queued or running when the person closed the case replaced that close
  // (D10): say so, in the words of the replaced-close notice, never a close under an open
  // status.
  return closeReplaced(c) ? `${line}. The AI investigation then replaced the close.` : line;
}

/** The analyst verbs that end a case (`routes._ACTION_STATUS`: closed or resolved). */
const CLOSING_ACTIONS = new Set(['close', 'confirm_fp', 'resolve']);

/** The terminal statuses a person's close moves a case into. */
const TERMINAL = new Set(['closed', 'resolved']);

/**
 * Whether a person's lifecycle action ended the case: a closing verb, or a status change
 * (`set_status`, the status menu and the bulk form) whose move on the status timeline,
 * made at the same time (`case.updated_at`), went to closed or resolved.
 */
function closedByAction(c: Case, entry: Record<string, unknown>): boolean {
  const action = String(entry.action ?? '');
  if (CLOSING_ACTIONS.has(action)) return true;
  if (action !== 'set_status') return false;
  const ts = String(entry.ts ?? '');
  const moves = Array.isArray(c.status_history) ? c.status_history : [];
  return Boolean(ts) && moves.some((m) => m?.at === ts && TERMINAL.has(String(m?.to_status ?? '').toLowerCase()));
}

/**
 * Whether the person's newest lifecycle action closed the case and a later decision of an
 * AI run left it open: walking the history back from its newest entry, events that
 * arrived (`attach`) are skipped, a `decision` is noted, and the first entry by a person
 * settles it.
 */
function closeReplaced(c: Case): boolean {
  const status = String(c.status ?? '').toLowerCase();
  if (TERMINAL.has(status)) return false;
  const history = Array.isArray(c.history) ? c.history : [];
  let decided = false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') continue;
    const event = String(entry.event ?? '');
    if (event === 'attach') continue;
    if (event === 'decision') {
      decided = true;
      continue;
    }
    return decided && event === 'analyst_action' && closedByAction(c, entry);
  }
  return false;
}

/* ------------------------------------------------------------ next step row -- */

/**
 * The runbook's next required step as one 48px row (the full card is on the Response
 * tab). Run data is text (#9). Nothing here changes the case (#3).
 */
const NextStepRow: React.FC<{
  run: RunbookRun;
  onOpen: (stepId: string | null) => void;
}> = ({ run, onOpen }) => {
  const item = nextStep(run);
  if (!item) return null;
  const total = run.snapshot.steps.length;
  return (
    <div
      className="flex min-h-12 items-center gap-3 rounded-md border border-border/70 px-3"
      data-testid="brief-next-step"
      data-overview-runbook=""
    >
      <span className="shrink-0 text-xs font-medium text-primary">Next step</span>
      {/* UNTRUSTED step title: plain text. */}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={item.step.title}>
        {item.step.title}
      </span>
      <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground @[48rem]/case:inline">
        {PHASE_LABEL[item.step.phase]} · step {item.number.toLocaleString()} of {total.toLocaleString()} ·{' '}
        {item.step.required ? 'Required' : 'Optional'}
      </span>
      <Button type="button" size="sm" variant="secondary" className="h-7 shrink-0" onClick={() => onOpen(item.step.id)}>
        Open
      </Button>
    </div>
  );
};

/* -------------------------------------------------------------------- lanes -- */

/** One lane of the Brief: its provenance tag and name, its content and its link. */
const Lane: React.FC<{
  kind: 'source' | 'ai' | 'code' | 'analyst';
  name: string;
  testId: string;
  links?: React.ReactNode;
  children: React.ReactNode;
}> = ({ kind, name, testId, links, children }) => (
  <div
    className="grid grid-cols-[minmax(0,1fr)] gap-x-5 gap-y-1.5 border-t border-border/60 py-3.5 first:border-t-0 first:pt-0 @[40rem]/case:grid-cols-[8rem_minmax(0,1fr)]"
    data-testid={testId}
    data-lane={kind}
  >
    <dt className="flex items-center gap-2 text-sm font-medium text-foreground @[40rem]/case:items-start">
      <ProvenanceTag kind={kind} />
      <span>{name}</span>
    </dt>
    <dd className="min-w-0 space-y-2">
      {children}
      {links ? <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{links}</div> : null}
    </dd>
  </div>
);

/** A lane's link to the tab that holds the whole lane. */
const LaneLink: React.FC<{ onClick?: () => void; shortcut: string; children: React.ReactNode }> = ({
  onClick,
  shortcut,
  children,
}) =>
  onClick ? (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto gap-1 p-0 text-xs"
      aria-keyshortcuts={shortcut}
      onClick={onClick}
    >
      {children}
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Button>
  ) : null;

/* --------------------------------------------------------------- component -- */

export interface OverviewPanelProps {
  c: Case;
  /** The latest run's rationale: the Assessment lane leads with the model's reasoning. */
  rationale?: CaseRationale | null;
  onNavigate?: Navigate;
  /** Open another tab of the case (a lane's link). */
  onOpenTab?: (tab: CaseTab) => void;
  /** A pending auto-close review sample: the Brief's first block says why it is here. */
  reviewPending?: boolean;
  /** The runbook run whose next step the Brief shows (an open case with a run). */
  runbookRun?: RunbookRun | null;
  /** Open the Response tab, on a step when one is named. */
  onOpenRunbook?: (stepId: string | null) => void;
  /** The runbook progress over every run, for the People lane; null when none. */
  runbookProgress?: RunbookProgress | null;
  /** Every runbook run on the case, so the People lane names the last step a person did. */
  runbookRuns?: readonly RunbookRun[] | null;
  /** The visible discussion messages and the files, when they are known. */
  messageCount?: number | null;
  filesCount?: number | null;
  /** The Decision lane's inputs. */
  timeline?: TimelineResponse | null;
  policy?: FpPolicy;
  canOpenApprovals?: boolean;
  /** The six-stage story for "How this case was built" (loaded when it opens). */
  buildStory?: React.ReactNode;
  /** Whether "How this case was built" is open (the caller loads the stages then). */
  buildStoryOpen?: boolean;
  onBuildStoryOpenChange?: (open: boolean) => void;
  /** The Decision lane's "Policy inputs" opened: the caller loads the trace it reads. */
  onNeedTimeline?: () => void;
}

export const OverviewPanel: React.FC<OverviewPanelProps> = ({
  c,
  rationale = null,
  onNavigate,
  onOpenTab,
  reviewPending = false,
  runbookRun = null,
  onOpenRunbook,
  runbookProgress = null,
  runbookRuns = null,
  messageCount = null,
  filesCount = null,
  timeline = null,
  policy,
  canOpenApprovals = false,
  buildStory = null,
  buildStoryOpen = false,
  onBuildStoryOpenChange,
  onNeedTimeline,
}) => {
  const terminal = isTerminalStatus(c.status);
  const sentence = triggerSentence(c);
  const facts = evidenceFacts(c);

  // The AI's reading, led by the model's reasoning (G17).
  const aiText = aiAssessmentText(c, rationale);
  const assessed = aiAssessed(c);
  const summary = leadSentences(aiText);
  const recommended = (c.recommended_action || '').trim();
  // The summary and the recommendation sometimes say the same thing: one paragraph.
  const recommendationIsSummary =
    Boolean(recommended) && Boolean(summary) && normalizeSentence(recommended) === normalizeSentence(summary);
  // A case the AI did not assess shows its system summary as the reason, untagged words.
  const systemSummary = !assessed ? leadSentences(c.summary) : '';

  // A person settled it: the lane is theirs; an operator's analyst policy and the code are code.
  const decisionKind = isHumanClosed(c) && caseOutcome(c).source !== 'analyst_policy' ? 'analyst' : 'code';
  const lastAction = lastHumanAction(c, runbookRuns);
  const people: string[] = [];
  if (runbookProgress && runbookProgress.total > 0) {
    const done = runbookProgress.done + runbookProgress.not_applicable;
    people.push(
      `Runbook ${done.toLocaleString()} of ${runbookProgress.total.toLocaleString()} steps${
        runbookProgress.required_open > 0 ? `, ${runbookProgress.required_open.toLocaleString()} required open` : ''
      }`,
    );
  }
  if (typeof messageCount === 'number') {
    people.push(`${messageCount.toLocaleString()} message${messageCount === 1 ? '' : 's'}`);
  }
  if (typeof filesCount === 'number') {
    people.push(`${filesCount.toLocaleString()} screenshot${filesCount === 1 ? '' : 's'}`);
  }
  // Work a person did that left no status change or named step: never "no one worked".
  const worked =
    (runbookProgress ? runbookProgress.done + runbookProgress.not_applicable > 0 : false) ||
    (messageCount ?? 0) > 0 ||
    (filesCount ?? 0) > 0;

  const open = (tab: CaseTab) => (onOpenTab ? () => onOpenTab(tab) : undefined);

  return (
    <div
      className={cn('space-y-6', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="overview"
      data-presentation="case-manager"
    >
      <div className="space-y-4" data-testid="case-tab-first">
        {/* 1. A pending auto-close sample: why the case is here (Start review is the action). */}
        {reviewPending ? (
          <p className="flex items-start gap-2 text-sm text-foreground" role="note" data-testid="brief-review-note">
            <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0">{REVIEW_BAND_TEXT}</span>
          </p>
        ) : null}

        {/* 2. The runbook's next required step on an open case. */}
        {runbookRun && !terminal && onOpenRunbook ? <NextStepRow run={runbookRun} onOpen={onOpenRunbook} /> : null}

        {c.error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Investigation error</AlertTitle>
            {/* UNTRUSTED: plain text. */}
            <AlertDescription className="whitespace-pre-wrap">{c.error}</AlertDescription>
          </Alert>
        ) : null}

        {/* 3. The four lanes. */}
        <dl aria-label="Case brief" data-testid="brief-lanes">
          <Lane
            kind="source"
            name="Evidence"
            testId="brief-lane-evidence"
            links={<LaneLink onClick={open('evidence')} shortcut="Alt+2">Open evidence</LaneLink>}
          >
            {sentence ? (
              /* UNTRUSTED: plain text. */
              <p className="max-w-[42rem] text-sm leading-relaxed text-foreground/90" data-testid="brief-trigger">
                {sentence}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">The detection recorded no reason sentence.</p>
            )}
            {facts.length ? (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="brief-evidence-facts">
                {facts.join(' · ')}
              </p>
            ) : null}
          </Lane>

          <Lane
            kind="ai"
            name="Assessment"
            testId="brief-lane-ai"
            links={<LaneLink onClick={open('investigation')} shortcut="Alt+3">Open AI investigation</LaneLink>}
          >
            {!assessed ? (
              <div className="space-y-1" data-state="unavailable">
                <p className="text-sm text-foreground/90">The AI did not assess this case.</p>
                {systemSummary ? (
                  /* UNTRUSTED system summary: plain text. */
                  <p className="max-w-[42rem] text-xs leading-relaxed text-muted-foreground">{systemSummary}</p>
                ) : null}
              </div>
            ) : recommendationIsSummary && !terminal ? (
              <p className="max-w-[42rem] text-base leading-relaxed text-foreground/90" data-testid="brief-summary">
                {/* UNTRUSTED: plain text. */}
                {recommended}
              </p>
            ) : (
              <>
                <p
                  data-testid="brief-summary"
                  className={cn(
                    'max-w-[42rem] text-base leading-relaxed',
                    summary ? 'text-foreground/90' : 'text-muted-foreground',
                  )}
                >
                  {/* UNTRUSTED summary: plain text. */}
                  {summary || 'The AI has not written a summary for this case.'}
                </p>
                {!terminal && recommended ? (
                  <p className="max-w-[42rem] text-sm leading-relaxed text-foreground/90" data-testid="brief-recommended">
                    <span className="text-muted-foreground">Recommended: </span>
                    {/* UNTRUSTED: plain text. */}
                    {recommended}
                  </p>
                ) : null}
              </>
            )}
            {/* On a case that ended, the triage-time recommendation is kept, folded, and
                never presented as the next step. */}
            {assessed && terminal && recommended ? (
              <details className="group text-sm" data-testid="brief-triage-recommendation">
                <summary className="w-fit cursor-pointer list-none rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="inline-flex items-center gap-1.5">
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
                    AI recommendation at triage
                  </span>
                </summary>
                {/* UNTRUSTED: plain text. */}
                <p className="mt-2 whitespace-pre-wrap pl-5 text-sm leading-relaxed text-muted-foreground">{recommended}</p>
              </details>
            ) : null}
          </Lane>

          <Lane kind={decisionKind} name={decisionTitle(c)} testId="brief-lane-decision">
            <DecisionLane
              c={c}
              rationale={rationale}
              timeline={timeline}
              policy={policy}
              onNavigate={onNavigate}
              canOpenApprovals={canOpenApprovals}
              onNeedTimeline={onNeedTimeline}
            />
          </Lane>

          <Lane
            kind="analyst"
            name="People"
            testId="brief-lane-people"
            links={
              <>
                <LaneLink onClick={open('runbook')} shortcut="Alt+4">Open response</LaneLink>
                <LaneLink onClick={open('collab')} shortcut="Alt+5">Open activity</LaneLink>
              </>
            }
          >
            <p className="text-sm text-foreground/90" data-testid="brief-last-action">
              {/* UNTRUSTED name: plain text. */}
              {lastAction ?? (worked ? 'No status change by a person yet.' : 'No one has worked on this case yet.')}
            </p>
            {people.length ? <p className="text-xs text-muted-foreground">{people.join(' · ')}</p> : null}
          </Lane>
        </dl>
      </div>

      {/* 4. How this case was built: the six-stage story, folded. */}
      {buildStory ? (
        <Collapsible
          open={buildStoryOpen}
          onOpenChange={(next) => onBuildStoryOpenChange?.(next)}
          className="border-t border-border/60 pt-4"
          data-testid="brief-build-story"
        >
          <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', buildStoryOpen && 'rotate-180')} aria-hidden />
            How this case was built
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">{buildStory}</CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
};

export default OverviewPanel;
