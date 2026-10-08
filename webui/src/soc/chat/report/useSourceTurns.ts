/**
 * The recorded facts behind a report's items (chat revamp SPEC §9.3): for the
 * "Methodology & limitations" section a report needs the source turns' steps and usage,
 * which live on the persisted conversation, not on the snapshot. This hook reads the
 * (few) source conversations once, best effort:
 *
 *   - a conversation that answers 404 is UNAVAILABLE (deleted, or evicted by the
 *     50-conversation limit): the item's link back reads "Conversation no longer
 *     available" and the methodology says its lookup details are not recorded;
 *   - any other failure leaves the facts absent; the document still renders and says so.
 *
 * Reads are cached per conversation for a minute and shared by the panel and the library.
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { ChatConversation, Report } from '@/lib/types';

import { getConversation } from '../chat-api';
import { sourceTurnsFromConversation, type SourceTurnFacts } from './model';

/** At most this many source conversations are read for one report. */
export const MAX_SOURCE_CONVERSATIONS = 10;
const TTL_MS = 60_000;

type Entry = { at: number; promise: Promise<ChatConversation | 'gone' | null> };
const cache = new Map<string, Entry>();

/** Drop cached conversations (tests; a conversation known to have changed). */
export function clearSourceTurnCache(conversationId?: string): void {
  if (conversationId) cache.delete(conversationId);
  else cache.clear();
}

function load(conversationId: string): Promise<ChatConversation | 'gone' | null> {
  const hit = cache.get(conversationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = getConversation(conversationId)
    .then((c) => c as ChatConversation | 'gone' | null)
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return 'gone' as const;
      cache.delete(conversationId);
      return null;
    });
  cache.set(conversationId, { at: Date.now(), promise });
  return promise;
}

export interface SourceTurnsState {
  /** Facts keyed by assistant message id; `null` until the reads settle. */
  turns: Map<string, SourceTurnFacts> | null;
  titles: Map<string, string>;
  unavailable: Set<string>;
  loading: boolean;
}

const EMPTY: SourceTurnsState = { turns: null, titles: new Map(), unavailable: new Set(), loading: false };

/** The distinct source conversation ids a report names (bounded). */
export function sourceConversationIds(report: Report | null): string[] {
  if (!report) return [];
  const out: string[] = [];
  for (const id of [report.conversation_id, ...report.items.map((i) => i.source.conversation_id)]) {
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= MAX_SOURCE_CONVERSATIONS) break;
  }
  return out;
}

/** Read the given source conversations (cached) into turn facts, titles and gone ids. */
export async function loadSourceContext(ids: readonly string[]): Promise<SourceTurnsState> {
  const results = await Promise.all(ids.map((id) => load(id)));
  const turns = new Map<string, SourceTurnFacts>();
  const titles = new Map<string, string>();
  const unavailable = new Set<string>();
  results.forEach((result, i) => {
    if (result === 'gone') unavailable.add(ids[i]);
    else if (result) {
      if (result.title) titles.set(result.id, result.title);
      for (const [messageId, facts] of sourceTurnsFromConversation(result)) turns.set(messageId, facts);
    }
  });
  return { turns, titles, unavailable, loading: false };
}

/** The source conversations of `report` (by the ids its items name). */
export function useSourceTurns(report: Report | null, enabled = true): SourceTurnsState {
  const key = React.useMemo(() => sourceConversationIds(report).join('|'), [report]);
  const [state, setState] = React.useState<SourceTurnsState>(EMPTY);

  React.useEffect(() => {
    if (!enabled || !key) {
      setState(EMPTY);
      return undefined;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    void loadSourceContext(key.split('|')).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [key, enabled]);

  return state;
}
