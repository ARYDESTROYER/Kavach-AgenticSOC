/**
 * The close dialogs' note about AI runs (Round 16 SPEC §4.5 WP09, D10): the run's result
 * stays authoritative, so a close (or any status change) made while the AI investigates
 * the case is replaced when the run finishes. The note says so before you act and never
 * blocks the submit. A run seen while the dialog is open that then finishes turns the
 * note into a "finished" note. For several cases it counts how many have a run.
 * Announced politely (`role="status"`), never as an alert.
 *
 * While open it marks the cases it covers (`holdRunNotice`), so the case page shows no
 * finish toast over the dialog, and its finished note marks the run's end as said, so the
 * header chip does not say it again (FXB, `announce.ts`).
 */
import * as React from 'react';
import { Bot, CheckCircle2 } from 'lucide-react';

import type { InvestigationView } from '@/lib/types';
import { verdictWords } from '@/soc/components/outcome';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';

import { holdRunNotice, noteRunEnd } from './announce';
import { useInvestigations } from './store';

/**
 * The finished note for one case: "The AI investigation finished with the verdict Needs
 * human review. Check it before you close." The verdict keeps its own words, and the
 * sentence names it without saying it changed: it may be the verdict the case had before.
 */
export function aiRunFinishedNoteText(ended: InvestigationView, closes: boolean): string {
  const verdict = ended.verdict_after ? ` with the verdict ${verdictWords(ended.verdict_after)}` : '';
  return `The AI investigation finished${verdict}. Check it before you ${closes ? 'close' : 'change the status'}.`;
}

export const AI_RUN_CLOSE_TITLE = 'An AI investigation is running on this case.';
export const AI_RUN_CLOSE_BODY = 'When it finishes, its result replaces a close you make now.';
export const AI_RUN_STATUS_BODY = 'When it finishes, its result replaces the status you set now.';

export interface AiRunCloseNoticeProps {
  /** The cases the action covers. */
  caseIds?: readonly string[];
  /** The dialog is open and its action moves the status. */
  open: boolean;
  /** A close or resolve (`close`), or another status change (`status`). */
  action?: 'close' | 'status';
  className?: string;
}

export const AiRunCloseNotice: React.FC<AiRunCloseNoticeProps> = ({ caseIds, open, action = 'close', className }) => {
  const ids = open && caseIds ? caseIds : null;
  const single = ids && ids.length === 1 ? ids[0] : null;
  // Straight from the store (not `useAiRun.ts`), so a page that stands in for the queue
  // marks keeps this note truthful.
  const several = ids && ids.length > 1 ? ids : null;
  const run = useInvestigations((s) => (single ? s.byCase.get(single) ?? null : null), Boolean(single));
  const done = useInvestigations((s) => (single ? s.finished.get(single) ?? null : null), Boolean(single));
  const running = useInvestigations(
    (s) => (several ? several.reduce((n, id) => n + (s.byCase.has(id) ? 1 : 0), 0) : 0),
    Boolean(several),
  );
  const closes = action === 'close';

  // What this dialog saw while open, so an end turns the note into a "finished" note.
  const [watched, setWatched] = React.useState<string | null>(null);
  const [hadRuns, setHadRuns] = React.useState(false);
  const runId = run?.run_id ?? null;
  React.useEffect(() => {
    if (!open) {
      setWatched(null);
      setHadRuns(false);
    }
  }, [open]);
  React.useEffect(() => {
    if (open && runId) setWatched(runId);
  }, [open, runId]);
  React.useEffect(() => {
    if (open && running > 0) setHadRuns(true);
  }, [open, running]);

  // While open, the cases this note covers get no finish toast over the dialog.
  const covered = ids ? ids.join('\n') : '';
  React.useEffect(() => (covered ? holdRunNotice(covered.split('\n')) : undefined), [covered]);

  const ended = single && watched && done?.view.run_id === watched ? done.view : null;
  // The finished note says the end, so the header chip leaves it out.
  const endedRunId = ended?.run_id ?? null;
  React.useEffect(() => {
    if (endedRunId) noteRunEnd(endedRunId, 'said');
  }, [endedRunId]);

  if (!ids) return null;
  if (run) {
    return (
      <Alert variant="warning" role="status" data-testid="ai-run-close-notice" className={className}>
        <Bot className="h-4 w-4" aria-hidden />
        <AlertTitle>{AI_RUN_CLOSE_TITLE}</AlertTitle>
        <AlertDescription>{closes ? AI_RUN_CLOSE_BODY : AI_RUN_STATUS_BODY}</AlertDescription>
      </Alert>
    );
  }
  if (running > 0) {
    const one = running === 1;
    return (
      <Alert variant="warning" role="status" data-testid="ai-run-close-notice" className={className}>
        <Bot className="h-4 w-4" aria-hidden />
        <AlertDescription>
          {`${running.toLocaleString()} of the selected cases ${one ? 'has' : 'have'} an AI investigation running. `}
          {closes
            ? one
              ? 'Its result replaces this close when it finishes.'
              : 'Their results replace this close when they finish.'
            : one
              ? 'Its result replaces the status you set now when it finishes.'
              : 'Their results replace the status you set now when they finish.'}
        </AlertDescription>
      </Alert>
    );
  }
  if (ended || (ids.length > 1 && hadRuns)) {
    const text = ended
      ? aiRunFinishedNoteText(ended, closes)
      : `The AI investigations on the selected cases finished. Check them before you ${closes ? 'close' : 'change the status'}.`;
    return (
      <Alert variant="info" data-testid="ai-run-close-finished" className={className}>
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        <AlertDescription>{text}</AlertDescription>
      </Alert>
    );
  }
  return null;
};
