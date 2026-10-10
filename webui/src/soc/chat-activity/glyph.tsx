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

const DOT: Record<Exclude<ChatActivityStatus, 'running'>, string> = {
  unread: 'bg-primary',
  needs_input: 'bg-warning',
  failed: 'bg-critical',
};

export function ActivityGlyph({
  status,
  motion = true,
  className,
}: {
  status: ChatActivityStatus | null;
  /** `false` keeps the ring still (reduced motion is also honoured in CSS). */
  motion?: boolean;
  className?: string;
}) {
  if (!status) return null;
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        data-activity="running"
        data-motion={motion ? 'on' : 'off'}
        className={cn('chat-activity-ring size-3.5 shrink-0', className)}
      >
        <circle cx="8" cy="8" r="6" strokeWidth="2" className="stroke-border" data-track="" />
        <circle cx="8" cy="8" r="6" strokeWidth="2" pathLength="100" strokeDasharray="32 68" strokeLinecap="round" className="stroke-primary" />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-activity={status}
      className={cn('chat-activity-dot inline-block size-2 shrink-0 rounded-full', DOT[status], className)}
    />
  );
}

const ORDER: ChatActivityStatus[] = ['running', 'needs_input', 'failed', 'unread'];
const PHRASE: Record<ChatActivityStatus, [string, string]> = {
  running: ['answer in progress', 'answers in progress'],
  needs_input: ['question needs your input', 'questions need your input'],
  failed: ['answer failed', 'answers failed'],
  unread: ['new answer', 'new answers'],
};

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
  for (const kind of ORDER) {
    const group = entries.filter((entry) => entry.status === kind);
    if (!group.length) continue;
    status ??= kind;
    const fresh = group.filter((entry) => !entry.seen);
    if (!fresh.length) continue;
    const one = fresh.length === 1;
    parts.push(`${fresh.length} ${PHRASE[kind][one ? 0 : 1]}${one && fresh[0].title ? `: ${fresh[0].title}` : ''}`);
  }
  return { status, text: parts.length ? `${label}: ${parts.join('; ')}` : '' };
}

/** The navigation summary for Workspace chat (`workspace`) or case chat (`case`). */
export function useChatActivitySummary(kind: ChatActivity['kind']): ChatActivitySummary {
  const { entries } = useChatActivity();
  return React.useMemo(
    () => describeChatActivity(entries.filter((entry) => entry.kind === kind), kind === 'case' ? 'Case chat' : 'Chat'),
    [entries, kind],
  );
}

/** The case's own glyph (Case Manager queue rows, the case Chat tab). */
export function CaseChatActivityGlyph({ caseId, className }: { caseId: string; className?: string }) {
  const { entries } = useChatActivity();
  const entry = entries.find((item) => item.scope === `case:${caseId}`);
  const summary = entry ? describeChatActivity([entry], 'Case chat') : null;
  if (!entry || !summary?.text) return entry ? <ActivityGlyph status={entry.status} className={className} /> : null;
  return (
    <>
      <ActivityGlyph status={entry.status} className={className} />
      <span className="sr-only">{summary.text}</span>
    </>
  );
}

/**
 * The thin ring that turns around the brand tile while any answer is being written
 * (`ChatAgentConfig.animated_brand`). Only the ring moves: an operator's logo is never
 * animated. Decorative; the navigation glyph carries the accessible state.
 */
export function BrandActivityRing() {
  const { entries, animatedBrand } = useChatActivity();
  if (!animatedBrand || !entries.some((entry) => entry.status === 'running')) return null;
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      data-motion="on"
      data-testid="brand-activity-ring"
      className="chat-brand-ring pointer-events-none absolute -inset-1.5 size-12"
    >
      <circle cx="24" cy="24" r="22.5" strokeWidth="1.5" pathLength="100" strokeDasharray="28 72" strokeLinecap="round" className="stroke-primary" />
    </svg>
  );
}
