/**
 * The case's own chat activity (Round 12, SPEC D13) for the Case Manager queue rows and
 * the case Chat tab: the same grammar as the navigation (a turning ring while an answer
 * is being written, an accent dot for an unread one, amber for a question, red for a
 * failure), with its text for screen readers. Lives outside `glyph.tsx` so only the
 * lazy case pages carry it.
 */
import * as React from 'react';

import { describeChatActivity, useChatActivity, type ChatActivitySummary } from './activity';
import { ActivityGlyph } from './glyph';

const IDLE: ChatActivitySummary = { status: null, text: '' };

/**
 * This case's chat state and its text ("Case chat: 1 answer in progress: <title>").
 * Selects only this case's entry, so a queue of many rows re-renders just the row whose
 * case chat changed.
 */
export function useCaseChatActivity(caseId: string): ChatActivitySummary {
  const entry = useChatActivity((snapshot) => snapshot.entries.find((item) => item.scope === `case:${caseId}`) ?? null);
  return React.useMemo(() => (entry ? describeChatActivity([entry], 'Case chat') : IDLE), [entry]);
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
