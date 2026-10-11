/**
 * The chat activity glyph (Round 12, SPEC D13): a small ring that turns while an
 * answer is being written, an accent dot for an unread answer, amber when a question
 * waits on the analyst and red when an answer failed. Entry-safe (React + the store).
 *
 * The glyph itself is decorative (`aria-hidden`); hosts carry the meaning in text
 * through `aria-describedby` ({@link describeChatActivity}). Titles in that text are
 * prompt- or model-derived and are only ever rendered as text nodes (#9).
 */
import * as React from 'react';

import '@/styles/activity.css';
import { cn } from '@/lib/cn';
import { useChatActivity, type ChatActivity, type ChatActivityStatus } from './store';

/**
 * One small mark (`.chat-activity` in `styles/activity.css`): a turning quarter arc
 * while an answer is being written (still under reduced motion), an accent dot for an
 * unread answer, amber when a question waits on the analyst, red when one failed.
 */
export function ActivityGlyph({ status, className }: { status: ChatActivityStatus | null; className?: string }) {
  return status ? <span aria-hidden="true" data-activity={status} className={cn('chat-activity', className)} /> : null;
}

/** Most important first: [state, one, several]. */
const PHRASES: Array<[ChatActivityStatus, string, string]> = [
  ['running', 'answer in progress', 'answers in progress'],
  ['needs_input', 'question needs your input', 'questions need your input'],
  ['failed', 'answer failed', 'answers failed'],
  ['unread', 'new answer', 'new answers'],
];

export interface ChatActivitySummary {
  /** The most important state, for the glyph. */
  status: ChatActivityStatus | null;
  /** "Chat: 1 answer in progress: <title>" (empty when idle). */
  text: string;
}

/**
 * The glyph state and its text for a set of entries. A question the analyst has
 * already looked at keeps its dot but is not repeated in the text.
 */
export function describeChatActivity(entries: readonly ChatActivity[], label = 'Chat'): ChatActivitySummary {
  const parts: string[] = [];
  let status: ChatActivityStatus | null = null;
  for (const [kind, one, several] of PHRASES) {
    const group = entries.filter((entry) => entry.status === kind);
    if (!group.length) continue;
    status ??= kind;
    const fresh = group.filter((entry) => !entry.seen);
    if (fresh.length === 1) parts.push(`1 ${one}${fresh[0].title ? `: ${fresh[0].title}` : ''}`);
    else if (fresh.length) parts.push(`${fresh.length} ${several}`);
  }
  return { status, text: parts.length ? `${label}: ${parts.join('; ')}` : '' };
}

/** The navigation summary for Workspace chat, case chat, or both (`all`). */
export function useChatActivitySummary(kind: ChatActivity['kind'] | 'all'): ChatActivitySummary {
  const { entries } = useChatActivity();
  return React.useMemo(
    () =>
      describeChatActivity(
        kind === 'all' ? entries : entries.filter((entry) => entry.kind === kind),
        kind === 'case' ? 'Case chat' : 'Chat',
      ),
    [entries, kind],
  );
}

/**
 * The thin ring that turns around the brand tile while any answer is being written
 * (`ChatAgentConfig.animated_brand`). Only the ring moves: an operator's logo is never
 * animated. Decorative; the navigation glyph carries the accessible state.
 */
export function BrandActivityRing() {
  const { entries, animatedBrand } = useChatActivity();
  return animatedBrand && entries.some((entry) => entry.status === 'running') ? (
    <span aria-hidden="true" className="chat-brand-ring" />
  ) : null;
}
