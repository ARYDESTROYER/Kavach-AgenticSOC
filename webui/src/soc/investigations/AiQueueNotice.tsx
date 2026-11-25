/**
 * The Case Manager control band line for AI runs on new events (Round 16 SPEC §4.5 WP09,
 * research ai-investigating R10): "AI is investigating 2 new alerts. They join the queue
 * when the investigation finishes." From the store's `newRuns` (past the 1 s hold-off);
 * nothing at 0. One quiet `text-xs` line that truncates, so the band grows by 20 px at
 * most. The change is announced politely through the app's one live region, at most
 * once every 10 s.
 */
import type * as React from 'react';

import { useInvestigations } from './store';
import { useThrottledAnnouncement } from './announce';

/** The line for `count` runs on new events ('' at 0). */
export function newRunsText(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? 'AI is investigating 1 new alert. It joins the queue when the investigation finishes.'
    : `AI is investigating ${count.toLocaleString()} new alerts. They join the queue when the investigation finishes.`;
}

export const AiQueueNotice: React.FC = () => {
  const count = useInvestigations((s) => s.newRuns);
  const text = newRunsText(count);
  useThrottledAnnouncement(text);
  if (!text) return null;
  return (
    <p data-testid="ai-queue-notice" className="truncate text-xs leading-4 text-muted-foreground" title={text}>
      {text}
    </p>
  );
};
