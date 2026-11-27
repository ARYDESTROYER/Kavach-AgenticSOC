/**
 * DecisionLane: the Brief's Decision lane (Round 16, SPEC D8, §4.4 WP03; the Decision
 * section of the Investigation tab before it).
 *
 * What settled the case, and why, from the code or the person who did it, never the
 * model (#3): the decision line, the numbers it compared against the auto-close entry
 * for the case's verdict (B27: the entry `decide()` acts on, `policyForVerdict`), the
 * authority sentence ONCE on the case, then two disclosures: "Policy inputs" (the
 * `DecisionCard`, which keeps the decision record word for word) and "Automation applied
 * (N)" (what threshold automation did after it).
 *
 * The decision line is a sentence about who settled the case and how: the case manager's
 * `key=value` record reads "Escalated by the system." and the rationale `decide()` wrote
 * reads "Sent to an analyst by the case policy." (`decisionWords`, the History's mapping
 * too), with the recorded reason when the auto-close reading does not give it. Any other
 * text reads as a neutral sentence. On a person's close it is what the policy recorded
 * before them ("Before the analyst: …"), or nothing: the outcome, the person and the
 * time are the header's, the inspector's and the People lane's. The verdict, confidence,
 * risk, status and owner are the header's too: this lane does not repeat them (the
 * ui-standard one-home rule). The model's reading is the Assessment lane's (G17).
 *
 * SECURITY (#9): the decision line is our own words, rendered as a text node; automation
 * details are plain text. Read only: nothing here decides or changes the case.
 */
import * as React from 'react';
import { ChevronDown, Lock } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { cn } from '@/lib/cn';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';

import { isAutoClosedByAI } from '@/soc/components/badges';
import { decisionWords } from '@/soc/components/caseActivityText';
import { caseOutcome, isHumanClosed } from '@/soc/components/outcome';
import type { Navigate } from '@/soc/router';

import { AutomationApplied } from './AutomationApplied';
import { DecisionCard } from './DecisionCard';
import { DecisionExplain } from './explain/DecisionExplain';
import { aiAssessed } from './caseFacts';
import { autoCloseClass, type FpPolicy } from './shared';

/**
 * The auto-close reading of a case the code decided or has yet to decide (one line), or
 * null when a person closed the case or the case was never assessed. `policy` is the
 * auto-close entry for the case's verdict ({@link policyForVerdict}, B27). Needs human
 * never auto-closes, whatever the policy says (code-enforced). Our own copy (#9).
 */
export function autoCloseLine(policy: FpPolicy | undefined, c: Case): string | null {
  if (isHumanClosed(c) || !aiAssessed(c)) return null;
  const cls = autoCloseClass(c.verdict);
  if (cls === 'needs_human') return 'Needs human review verdicts never auto-close. A person decides.';
  if (!policy) return null;
  const what = cls === 'true_positive' ? 'True-positive' : 'False-positive';
  if (!policy.enabled) {
    // Never beside a recorded AI close: the policy changed after it, and the record says so.
    if (isAutoClosedByAI(c.status, c.decision_by)) return null;
    return `${what} auto-close is off, so a person decides.`;
  }
  if (typeof policy.min_confidence !== 'number') return null;
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

export interface DecisionLaneProps {
  c: Case;
  rationale: CaseRationale | null;
  /** The trace, so the policy inputs name the decision's own clause. */
  timeline: TimelineResponse | null;
  /** The auto-close entry for the case's verdict (B27); null when it is not known. */
  policy?: FpPolicy;
  onNavigate?: Navigate;
  /** Whether the viewer may read the Approvals queue (`proposals:read`). */
  canOpenApprovals?: boolean;
  /** "Policy inputs" opened: the caller loads the trace its clause is read from. */
  onNeedTimeline?: () => void;
}

/**
 * The decision lane's name. Who settled the case is its provenance tag (Code, or Analyst
 * when a person did), so the name never repeats the tag ("Analyst Analyst") and never
 * names a status ("Resolved" is one of its own): "Decision", or "Analyst policy" for an
 * operator's declared-benign close, which the Code tag alone would not say.
 */
export function decisionTitle(c: Case): string {
  return caseOutcome(c).source === 'analyst_policy' ? 'Analyst policy' : 'Decision';
}

export const DecisionLane: React.FC<DecisionLaneProps> = ({
  c,
  rationale,
  timeline,
  policy,
  onNavigate,
  canOpenApprovals = false,
  onNeedTimeline,
}) => {
  const [inputsOpen, setInputsOpen] = React.useState(false);
  const [automationOpen, setAutomationOpen] = React.useState(false);
  const outcome = caseOutcome(c);
  const humanClosed = isHumanClosed(c);
  // An operator's declared-benign policy is neither a person's case work nor the model's.
  const policyClosed = outcome.source === 'analyst_policy';
  const autoClose = autoCloseLine(policy, c);
  // The code's record in words (`decisionWords`, shared with the History): the case
  // manager's `key=value` row and the rationale templates `decide()` writes become a
  // sentence; the reason it gives follows unless the auto-close reading below already
  // says why. Any other text is never shown as it is: Policy inputs keeps it word for word.
  const words = decisionWords(rationale?.decision_rationale);
  const codeLine = words ? [words.route, autoClose ? '' : words.why].filter(Boolean).join(' ') : '';
  // Undecided: the AI has not assessed the case and nobody settled it (a candidate).
  const undecided = !humanClosed && !policyClosed && !aiAssessed(c) && !String(c.decision_by ?? '').trim();
  // A person's close: the line is what the policy recorded before them, or nothing (the
  // outcome, the person and the time have their homes in the header, the inspector and
  // the People lane).
  const personClosed = humanClosed && !policyClosed;
  const decisionLine = policyClosed
    ? `${outcome.headline}${outcome.by ? ` by ${outcome.by}` : ''}.`
    : personClosed
      ? codeLine
        ? `Before the analyst: ${codeLine}`
        : ''
      : codeLine || 'The server-side case policy recorded the outcome shown for this case.';
  const resolvedByHuman = String(c.status || '').toLowerCase() === 'resolved';
  // The authority sentence, ONCE on the case.
  const authority = policyClosed
    ? 'Closed by an operator rule that declared this detection benign. No model was asked.'
    : humanClosed
      ? `${resolvedByHuman ? 'Resolved' : 'Closed'} by an analyst (a human lifecycle action). The deterministic policy did not ${resolvedByHuman ? 'resolve' : 'close'} this case.`
      : 'Made by code against the auto-close policy, never by the model.';
  const automationCount = Array.isArray(c.automation_actions) ? c.automation_actions.length : 0;

  if (undecided) {
    return (
      <div className="space-y-1" data-testid="brief-decision" data-decided-by="none" data-state="no-data">
        <p className="text-sm text-muted-foreground">No decision yet. The code decides after the AI&apos;s verdict.</p>
      </div>
    );
  }

  return (
    <div
      className="max-w-[42rem] space-y-2"
      data-testid="brief-decision"
      data-decided-by={policyClosed ? 'analyst_policy' : humanClosed ? 'analyst' : 'code'}
    >
      {/* A sentence, never the raw record: Policy inputs keeps that word for word. The
          hover explains how the policy compared the numbers. */}
      {decisionLine ? (
        <DecisionExplain caseRecord={c}>
          <p data-testid="decision-line" className="text-base leading-relaxed text-foreground/90">
            {decisionLine}
          </p>
        </DecisionExplain>
      ) : null}
      {autoClose ? (
        <p data-testid="decision-auto-close" className="text-sm leading-relaxed text-foreground/90">
          {autoClose}
        </p>
      ) : null}
      <p data-testid="decision-authority" className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{authority}</span>
      </p>
      <div className="flex flex-col gap-2 pt-1">
        <Collapsible
          open={inputsOpen}
          onOpenChange={(next) => {
            setInputsOpen(next);
            if (next) onNeedTimeline?.();
          }}
        >
          <LaneDisclosure open={inputsOpen}>Policy inputs</LaneDisclosure>
          <CollapsibleContent className="mt-3">
            <DecisionCard c={c} rationale={rationale} timeline={timeline} />
          </CollapsibleContent>
        </Collapsible>
        {automationCount ? (
          <Collapsible open={automationOpen} onOpenChange={setAutomationOpen}>
            <LaneDisclosure open={automationOpen}>
              Automation applied ({automationCount.toLocaleString()})
            </LaneDisclosure>
            <CollapsibleContent className="mt-3">
              <AutomationApplied
                c={c}
                onOpenApprovals={canOpenApprovals && onNavigate ? () => onNavigate('approvals') : undefined}
              />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </div>
  );
};

/** A quiet disclosure trigger inside a lane. */
const LaneDisclosure: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => (
  <CollapsibleTrigger className="inline-flex w-fit items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
    {children}
  </CollapsibleTrigger>
);

export default DecisionLane;
