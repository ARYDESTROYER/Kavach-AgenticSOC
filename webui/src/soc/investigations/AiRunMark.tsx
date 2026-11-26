/**
 * The queue row mark (Round 16 SPEC §4.5 WP09): the turning ring and "AI working" or
 * "AI queued", in the row's status node in place of the status glyph. It never sits in
 * the case chat glyph slot, so a row can show both signals. Renders nothing without a
 * run (after the 1 s hold-off). The ring stands still under reduced motion
 * (`styles/activity.css`). Decorative for assistive technology: the row's accessible
 * name carries the run (`aiRunAccessibleText`).
 *
 * The words always show, whatever the row's width: the ring alone is the case chat
 * glyph, so only the words tell the two signals apart (C32). In a narrow queue the
 * row's status words give way instead (`RUN_MARK_WORDS` in `CaseManager.tsx`).
 */
import type * as React from 'react';

import { ActivityGlyph } from '@/soc/chat-activity/glyph';

import { useAiRun } from './useAiRun';

export interface AiRunMarkProps {
  caseId: string;
}

export const AiRunMark: React.FC<AiRunMarkProps> = ({ caseId }) => {
  const run = useAiRun(caseId);
  if (!run) return null;
  return (
    <span data-testid="ai-run-mark" data-run-state={run.state} className="inline-flex shrink-0 items-center gap-1" aria-hidden>
      <ActivityGlyph status="running" className="size-3 border-[1.5px]" />
      <span data-testid="ai-run-mark-words" className="whitespace-nowrap font-medium text-primary">
        {run.state === 'running' ? 'AI working' : 'AI queued'}
      </span>
    </span>
  );
};
