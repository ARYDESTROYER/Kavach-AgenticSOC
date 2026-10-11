/**
 * Answer feedback state (Round 12 SYNTHESIS-chat P1-4): the viewer's thumbs up/down,
 * reason and comment per Workspace answer.
 *
 * One small module-level store keyed by conversation: the first answer of a thread
 * that renders loads the viewer's stored ratings of that thread ONCE
 * (`GET /api/chat/feedback?conversation_id=`), so a reopened conversation shows the
 * thumbs it was given; every other answer of the thread reads the same snapshot
 * (`useSyncExternalStore`). A rating is written with `POST /api/chat/feedback` and only
 * reflected once the server accepted it (never claimed before it is saved).
 *
 * Feedback is stored per user and audited; it is never used to train a model and never
 * feeds a case decision (#3).
 */
import * as React from 'react';

import type { ChatFeedbackRating, ChatFeedbackReason } from '@/lib/types';
import { listChatFeedback, postChatFeedback, type ChatFeedbackEntry } from '../chat-api';

export interface AnswerFeedback {
  rating: ChatFeedbackRating;
  reason: ChatFeedbackReason | null;
  comment: string;
}

interface ThreadFeedback {
  status: 'loading' | 'ready' | 'error';
  ratings: ReadonlyMap<string, AnswerFeedback>;
}

const EMPTY: ThreadFeedback = { status: 'ready', ratings: new Map() };
const threads = new Map<string, ThreadFeedback>();
const listeners = new Map<string, Set<() => void>>();

function emit(conversationId: string): void {
  listeners.get(conversationId)?.forEach((listener) => listener());
}

function setThread(conversationId: string, next: ThreadFeedback): void {
  threads.set(conversationId, next);
  emit(conversationId);
}

function fromEntries(entries: readonly ChatFeedbackEntry[]): Map<string, AnswerFeedback> {
  const out = new Map<string, AnswerFeedback>();
  for (const entry of entries) {
    // Newest first from the server: keep the first rating seen per answer.
    if (!out.has(entry.message_id)) out.set(entry.message_id, { rating: entry.rating, reason: entry.reason, comment: entry.comment });
  }
  return out;
}

/** Load a thread's stored ratings once (a failed read can be retried by the next mount). */
function ensureLoaded(conversationId: string): void {
  const current = threads.get(conversationId);
  if (current && current.status !== 'error') return;
  threads.set(conversationId, { status: 'loading', ratings: current?.ratings ?? new Map() });
  void listChatFeedback(conversationId)
    .then((entries) => {
      const latest = threads.get(conversationId);
      // Ratings given while the read was in flight win over the stored ones.
      const merged = fromEntries(entries);
      latest?.ratings.forEach((value, key) => merged.set(key, value));
      setThread(conversationId, { status: 'ready', ratings: merged });
    })
    .catch(() => {
      const latest = threads.get(conversationId);
      setThread(conversationId, { status: 'error', ratings: latest?.ratings ?? new Map() });
    });
}

function subscribe(conversationId: string, listener: () => void): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/**
 * Save a rating (replaces an earlier one for the same answer) and, once the server
 * accepted it, reflect it in every view of the thread.
 */
export async function saveAnswerFeedback(
  conversationId: string,
  messageId: string,
  feedback: AnswerFeedback,
): Promise<void> {
  await postChatFeedback({
    conversation_id: conversationId,
    message_id: messageId,
    rating: feedback.rating,
    reason: feedback.reason,
    comment: feedback.comment,
  });
  const current = threads.get(conversationId) ?? EMPTY;
  const ratings = new Map(current.ratings);
  ratings.set(messageId, { ...feedback, comment: feedback.comment.trim() });
  setThread(conversationId, { status: current.status === 'loading' ? 'loading' : 'ready', ratings });
}

/** The viewer's stored feedback for one answer (`null` = not rated or not loaded yet). */
export function useAnswerFeedback(conversationId: string | null, messageId: string | null): AnswerFeedback | null {
  const subscribeThread = React.useCallback(
    (listener: () => void) => (conversationId ? subscribe(conversationId, listener) : () => undefined),
    [conversationId],
  );
  const snapshot = React.useCallback(
    () => (conversationId ? (threads.get(conversationId) ?? EMPTY) : EMPTY),
    [conversationId],
  );
  React.useEffect(() => {
    if (conversationId) ensureLoaded(conversationId);
  }, [conversationId]);
  const thread = React.useSyncExternalStore(subscribeThread, snapshot, snapshot);
  return messageId ? (thread.ratings.get(messageId) ?? null) : null;
}

/** Tests only: forget every loaded thread. */
export function resetAnswerFeedbackForTests(): void {
  threads.clear();
  listeners.clear();
}
