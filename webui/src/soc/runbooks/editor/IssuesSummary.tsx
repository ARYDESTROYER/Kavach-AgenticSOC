/**
 * The issues summary (Round 14, SPEC §4.10.12, F17): every problem the server found, each a
 * link that moves focus to the field it belongs to (selecting its step first). The heading
 * carries the count that also disables Publish ("Fix 2 problems to publish"), and takes
 * focus after a save the server refused (the error-summary pattern), so a keyboard or screen
 * reader user lands on the list of what to fix.
 *
 * It sits under the outline rather than above the editor, so a problem that appears or goes
 * away while someone types never moves the field they are typing in.
 */
import { CircleAlert } from 'lucide-react';

import type { RunbookDefinition } from '@/lib/types-runbooks';

import type { PlacedIssue } from './draft';

export const ISSUES_HEADING_ID = 'runbook-issues-title';

export function problemsLabel(count: number): string {
  return count === 1 ? 'Fix 1 problem to publish' : `Fix ${count.toLocaleString()} problems to publish`;
}

/** A message that already names its step ("The title of step 2 is required.") needs no prefix. */
const NAMES_A_STEP = /\bstep \d+\b/i;

/** The line for one problem: "Step 3: Shorten the focus line." unless the message names the step. */
export function issueLine(issue: PlacedIssue, stepNumber: number): string {
  if (stepNumber <= 0 || NAMES_A_STEP.test(issue.message)) return issue.message;
  return `Step ${stepNumber.toLocaleString()}: ${issue.message}`;
}

export interface IssuesSummaryProps {
  issues: PlacedIssue[];
  defn: RunbookDefinition;
  /** Select the issue's step (or the details) and focus its field. */
  onGoTo: (issue: PlacedIssue) => void;
  /** The count in the heading: the problems shown (a new runbook holds some back, F17). */
  total: number;
}

export function IssuesSummary({ issues, defn, onGoTo, total }: IssuesSummaryProps) {
  if (!issues.length) return null;
  const stepNumber = (id: string | null) => (id ? defn.steps.findIndex((s) => s.id === id) + 1 : 0);
  return (
    <section
      aria-labelledby={ISSUES_HEADING_ID}
      className="rounded-lg border border-critical/30 bg-critical/5 px-4 py-3"
      data-issues-summary=""
    >
      <h2
        id={ISSUES_HEADING_ID}
        tabIndex={-1}
        className="flex items-center gap-2 rounded-sm text-sm font-semibold text-critical-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        {problemsLabel(total)}
      </h2>
      <ul className="mt-1.5 space-y-1">
        {issues.slice(0, 20).map((issue, i) => (
          <li key={`${issue.path}-${i}`} className="text-sm">
            <button
              type="button"
              onClick={() => onGoTo(issue)}
              className="text-left text-foreground underline decoration-critical-text/50 underline-offset-2 hover:decoration-critical-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
            >
              {issueLine(issue, stepNumber(issue.stepId))}
            </button>
          </li>
        ))}
        {issues.length > 20 ? (
          <li className="text-sm text-muted-foreground">{`And ${(issues.length - 20).toLocaleString()} more.`}</li>
        ) : null}
      </ul>
    </section>
  );
}
