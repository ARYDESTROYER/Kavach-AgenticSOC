/**
 * The recorded facts behind a report's items (chat revamp SPEC §9.3): for the
 * "Methodology & limitations" section a report needs the source turns' steps and usage,
 * which live on the persisted conversation, not on the snapshot. This module reads the
 * (few) source conversations, best effort:
 *
 *   - a conversation that answers 404 is UNAVAILABLE (deleted, or evicted by the
 *     50-conversation limit): the item's link back reads "Conversation no longer
 *     available" and the methodology says so;
 *   - any other failure leaves the facts absent and is reported as "could not be loaded";
 *   - conversations beyond the first {@link MAX_SOURCE_CONVERSATIONS} are not read, and
 *     the methodology says that instead of claiming the facts were never recorded.
 *
 * Reads are cached per conversation for a minute and shared by the panel and the library.
 * A cached conversation that lacks a message an item names (the item was added from a
 * newer turn) is read again once, and a report change for a conversation drops its entry,
 * so an export never reports a fresh item as "not recorded".
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { ChatConversation, Report } from '@/lib/types';

import { getConversation } from '../chat-api';
import { MAX_SOURCE_CONVERSATIONS, sourceTurnsFromConversation, type ConversationReadStatus, type SourceTurnFacts } from './model';
import { onReportChanged } from './report-sync';

export { MAX_SOURCE_CONVERSATIONS };

const TTL_MS = 60_000;

type Entry = { at: number; promise: Promise<ChatConversation | 'gone' | null> };
const cache = new Map<string, Entry>();

/** Drop cached conversations (tests; a conversation known to have changed). */
export function clearSourceTurnCache(conversationId?: string): void {
  if (conversationId) cache.delete(conversationId);
  else cache.clear();
}

// An add to (or edit of) a report means its conversation has a newer turn: forget it.
let watching = false;
function watchReportChanges(): void {
  if (watching) return;
  watching = true;
  onReportChanged((detail) => {
    if (detail.conversationId) cache.delete(detail.conversationId);
  });
}

function load(conversationId: string): Promise<ChatConversation | 'gone' | null> {
  watchReportChanges();
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
  /** Per source conversation: read, gone, failed or skipped (over the read limit). */
  status: Map<string, ConversationReadStatus>;
  loading: boolean;
}

const EMPTY: SourceTurnsState = { turns: null, titles: new Map(), unavailable: new Set(), status: new Map(), loading: false };

/** Every distinct source conversation id a report names, report's own first (unbounded). */
function allConversationIds(report: Report | null): string[] {
  if (!report) return [];
  const out: string[] = [];
  for (const id of [report.conversation_id, ...report.items.map((i) => i.source.conversation_id)]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The distinct source conversation ids a report names (bounded to the read limit). */
export function sourceConversationIds(report: Report | null): string[] {
  return allConversationIds(report).slice(0, MAX_SOURCE_CONVERSATIONS);
}

/**
 * Read the given source conversations (cached) into turn facts, titles and statuses.
 * `wanted` names, per conversation, the message ids the caller needs: a cached copy that
 * lacks one is read again once (the conversation gained a turn since it was cached).
 */
export async function loadSourceContext(
  ids: readonly string[],
  wanted?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<SourceTurnsState> {
  const readOne = async (id: string) => {
    const first = await load(id);
    const need = wanted?.get(id);
    if (first && first !== 'gone' && need?.size) {
      const have = new Set(first.messages.map((m) => m.id));
      if (Array.from(need).some((m) => !have.has(m))) {
        clearSourceTurnCache(id);
        return load(id);
      }
    }
    return first;
  };
  const results = await Promise.all(ids.map(readOne));
  const turns = new Map<string, SourceTurnFacts>();
  const titles = new Map<string, string>();
  const unavailable = new Set<string>();
  const status = new Map<string, ConversationReadStatus>();
  results.forEach((result, i) => {
    if (result === 'gone') {
      unavailable.add(ids[i]);
      status.set(ids[i], 'gone');
    } else if (result) {
      status.set(ids[i], 'read');
      if (result.title) titles.set(result.id, result.title);
      for (const [messageId, facts] of sourceTurnsFromConversation(result)) turns.set(messageId, facts);
    } else {
      status.set(ids[i], 'failed');
    }
  });
  return { turns, titles, unavailable, status, loading: false };
}

/**
 * The source context of a whole report: the first {@link MAX_SOURCE_CONVERSATIONS}
 * conversations read (a stale cached copy refreshed when an item's message is missing),
 * the rest marked `skipped`.
 */
export async function loadReportSourceContext(report: Report): Promise<SourceTurnsState> {
  const all = allConversationIds(report);
  const wanted = new Map<string, Set<string>>();
  for (const item of report.items) {
    const { conversation_id: cid, message_id: mid } = item.source;
    if (!cid || !mid) continue;
    const set = wanted.get(cid) ?? new Set<string>();
    set.add(mid);
    wanted.set(cid, set);
  }
  const state = await loadSourceContext(all.slice(0, MAX_SOURCE_CONVERSATIONS), wanted);
  for (const id of all.slice(MAX_SOURCE_CONVERSATIONS)) state.status.set(id, 'skipped');
  return state;
}

/** The source conversations of `report` (by the ids and messages its items name). */
export function useSourceTurns(report: Report | null, enabled = true): SourceTurnsState {
  const key = React.useMemo(
    () => (report ? `${report.conversation_id ?? ''}|${report.items.map((i) => `${i.source.conversation_id}:${i.source.message_id}`).join('|')}` : ''),
    [report],
  );
  const reportRef = React.useRef(report);
  reportRef.current = report;
  const [state, setState] = React.useState<SourceTurnsState>(EMPTY);

  React.useEffect(() => {
    const current = reportRef.current;
    if (!enabled || !current || !allConversationIds(current).length) {
      setState(EMPTY);
      return undefined;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    void loadReportSourceContext(current).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [key, enabled]);

  return state;
}
