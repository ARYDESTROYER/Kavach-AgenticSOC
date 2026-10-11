/**
 * The case's own chat activity (Round 12, SPEC D13) for the Case Manager queue rows and
 * the case Chat tab: the same grammar as the navigation (a turning ring while an answer
 * is being written, an accent dot for an unread one, amber for a question, red for a
 * failure), with its text for screen readers. Lives outside `glyph.tsx` so only the
 * lazy case pages carry it.
 */
import { ActivityGlyph, describeChatActivity, type ChatActivitySummary } from './glyph';
import { useChatActivity } from './store';

/** This case's chat state and its text ("Case chat: 1 answer in progress: <title>"). */
export function useCaseChatActivity(caseId: string): ChatActivitySummary {
  const { entries } = useChatActivity();
  const entry = entries.find((item) => item.scope === `case:${caseId}`);
  return entry ? describeChatActivity([entry], 'Case chat') : { status: null, text: '' };
}

/** The glyph plus its visually hidden text (for hosts named by their content). */
export function CaseChatActivityGlyph({ caseId, className }: { caseId: string; className?: string }) {
  const { status, text } = useCaseChatActivity(caseId);
  if (!status) return null;
  return (
    <>
      <ActivityGlyph status={status} className={className} />
      {text ? <span className="sr-only">{`, ${text}`}</span> : null}
    </>
  );
}
