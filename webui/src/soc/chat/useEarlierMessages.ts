/**
 * useEarlierMessages — "Show earlier messages" for a long Workspace conversation
 * (Round 12: chat keeps every message; nothing is removed).
 *
 * `GET /api/chat/conversations/{id}` returns the newest window of a conversation and
 * says how many older messages it left out (`earlier_message_count`). This hook pages
 * those in, oldest page last, through `GET …/messages?before=<oldest shown id>&limit=`
 * (owner-scoped, full text restored from the exchange documents) and hands each page
 * to the engine (`prependRestored`), which puts it above the transcript. The
 * transcript keeps the reader's position (see `Transcript`'s `earlier` prop).
 *
 *  - The cursor resets whenever the host hands the engine another saved conversation
 *    (a thread opened, re-read or switched), and a response for an earlier cursor is
 *    dropped, so a slow page never lands in the wrong thread.
 *  - A page that would start with an answer whose question is still older reads that
 *    one question too, so a question and its answer always arrive together.
 *  - `loadUntil(messageId)` reads back until a requested message (a search hit or a
 *    deep link to an older message) is on screen, in pages of the server maximum. A
 *    load already running is waited for, never dropped. When a page fails, what was
 *    read stays, the error is set, `failedSeek` names the message, and the control's
 *    Retry (`load`) resumes the read-back rather than loading one page.
 *  - A 404 (the conversation was deleted elsewhere) is `errorKind: 'missing'`, and a
 *    read-back that hits one resolves `'missing'` (not `'failed'`): the same read
 *    cannot succeed, so the host offers to reopen the conversation instead of a Retry.
 *
 * Case chat has no saved conversation and never pages (`conversation` is null).
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { ChatConversation, ChatConversationMessage } from '@/lib/types';
import { EARLIER_PAGE_SIZE, MAX_MESSAGE_PAGE, getConversationMessages } from './chat-api';
import type { ChatEngine } from './useChatEngine';

/** The control's error copy for a read that may work again (a Retry follows it). */
export const EARLIER_LOAD_ERROR = 'Earlier messages could not be loaded.';
/**
 * The control's error copy when the server no longer has them (404: usually the
 * conversation was deleted in another tab). Retrying the same read cannot help; the
 * control offers to reopen the conversation instead.
 */
export const EARLIER_MISSING_ERROR = 'Earlier messages could not be found.';

/** How a {@link EarlierMessages.loadUntil} ended. */
export type EarlierSeekOutcome =
  /** The message is now on screen. */
  | 'found'
  /** Read back to the start of the conversation without finding it (a stale link). */
  | 'not_found'
  /** A page could not be read: the error is set, and Retry resumes this read. */
  | 'failed'
  /**
   * A page is gone (404: the conversation was deleted or changed elsewhere): the error
   * is set with `errorKind: 'missing'` and the request stays pending. Repeating the
   * read cannot help; the host offers to reopen the conversation, never a Retry.
   */
  | 'missing'
  /** Another conversation was opened meanwhile: nothing was applied. */
  | 'stale';

export interface EarlierMessages {
  /** Older messages not on screen yet (0 = the conversation is shown from its start). */
  remaining: number;
  loading: boolean;
  error: string | null;
  /**
   * What the error means: `failed` (a Retry may work) or `missing` (404, the messages
   * are gone; offer to reopen the conversation, never a Retry that repeats the read).
   */
  errorKind: 'failed' | 'missing' | null;
  /** At least one older page was loaded into this conversation. */
  loadedAny: boolean;
  /**
   * The message a {@link loadUntil} was reading back to when it failed (`null` when
   * none): the host keeps that request pending, and {@link load} resumes it.
   */
  failedSeek: string | null;
  /**
   * Load the previous page (a no-op while loading or when none remain). After a failed
   * {@link loadUntil}, it resumes that read instead (the control's Retry).
   */
  load: () => void;
  /**
   * Read back until message `messageId` is on screen or the start is reached. A load
   * already running is waited for first, and the read continues from where it left the
   * cursor, so a request made during a "Show earlier messages" click is never lost.
   */
  loadUntil: (messageId: string) => Promise<EarlierSeekOutcome>;
}

interface Cursor {
  conversationId: string;
  /** The oldest message on screen: the next page ends just before it. */
  before: string;
  remaining: number;
}

interface LoadError {
  text: string;
  kind: 'failed' | 'missing';
}

function cursorFor(conversation: ChatConversation | null | undefined): Cursor | null {
  if (!conversation) return null;
  const remaining = conversation.earlier_message_count ?? 0;
  const before = conversation.messages[0]?.id;
  return remaining > 0 && before ? { conversationId: conversation.id, before, remaining } : null;
}

function loadError(error: unknown): LoadError {
  if (error instanceof ApiError && error.status === 404) return { text: EARLIER_MISSING_ERROR, kind: 'missing' };
  return { text: EARLIER_LOAD_ERROR, kind: 'failed' };
}

export interface UseEarlierMessagesOptions {
  /** The saved conversation the engine holds (`null`: a draft, case chat). */
  conversation: ChatConversation | null | undefined;
  engine: Pick<ChatEngine, 'prependRestored'>;
  /** Page size for "Show earlier messages" (default 50). */
  pageSize?: number;
  /** Told how many messages a load added (the host announces it). */
  onLoaded?: (added: number, remaining: number) => void;
}

export function useEarlierMessages({
  conversation,
  engine,
  pageSize = EARLIER_PAGE_SIZE,
  onLoaded,
}: UseEarlierMessagesOptions): EarlierMessages {
  const [cursor, setCursor] = React.useState<Cursor | null>(() => cursorFor(conversation));
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<LoadError | null>(null);
  const [loadedAny, setLoadedAny] = React.useState(false);
  const [failedSeek, setFailedSeekState] = React.useState<string | null>(null);
  const cursorRef = React.useRef(cursor);
  const generationRef = React.useRef(0);
  const loadingRef = React.useRef(false);
  /** The read running now (a page or a read-back), for a read-back to wait on. */
  const inflightRef = React.useRef<Promise<unknown> | null>(null);
  /** Every message this hook put on screen (a read-back stops once its target is in). */
  const loadedIdsRef = React.useRef<Set<string>>(new Set());
  const failedSeekRef = React.useRef<string | null>(null);
  const engineRef = React.useRef(engine);
  engineRef.current = engine;
  const onLoadedRef = React.useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const setFailedSeek = React.useCallback((messageId: string | null) => {
    failedSeekRef.current = messageId;
    setFailedSeekState(messageId);
  }, []);

  // Another saved conversation (or a fresh read of this one): start over from its window.
  React.useEffect(() => {
    generationRef.current += 1;
    const next = cursorFor(conversation);
    cursorRef.current = next;
    loadingRef.current = false;
    inflightRef.current = null;
    loadedIdsRef.current = new Set();
    // Same values, same state object: a host that hands over an equal copy re-renders once.
    setCursor((current) =>
      current && next && current.conversationId === next.conversationId && current.before === next.before && current.remaining === next.remaining
        ? current
        : next,
    );
    setLoading(false);
    setError(null);
    setLoadedAny(false);
    setFailedSeek(null);
  }, [conversation, setFailedSeek]);

  /** One page ending before `before`, widened by one when it would split a question from its answer. */
  const readPage = React.useCallback(
    async (at: Cursor, limit: number): Promise<{ messages: ChatConversationMessage[]; remaining: number }> => {
      const page = await getConversationMessages(at.conversationId, { before: at.before, limit });
      let messages = page.messages;
      let remaining = page.earlier_message_count;
      if (messages[0]?.role === 'assistant' && remaining > 0) {
        const question = await getConversationMessages(at.conversationId, { before: messages[0].id, limit: 1 });
        messages = [...question.messages.filter((m) => !messages.some((n) => n.id === m.id)), ...messages];
        remaining = question.earlier_message_count;
      }
      return { messages, remaining };
    },
    [],
  );

  /** Apply what was read (only while the cursor it was read for is still current). */
  const apply = React.useCallback((at: Cursor, messages: ChatConversationMessage[], remaining: number): number => {
    const added = engineRef.current.prependRestored(at.conversationId, messages);
    for (const message of messages) loadedIdsRef.current.add(message.id);
    const oldest = messages[0]?.id;
    const progressed = !!oldest && remaining < at.remaining;
    const next: Cursor | null =
      progressed && remaining > 0 ? { conversationId: at.conversationId, before: oldest, remaining } : null;
    cursorRef.current = next;
    setCursor(next);
    if (messages.length) setLoadedAny(true);
    onLoadedRef.current?.(added, next?.remaining ?? 0);
    return added;
  }, []);

  const begin = React.useCallback((): number => {
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    return generationRef.current;
  }, []);

  const finish = React.useCallback((generation: number) => {
    if (generation !== generationRef.current) return;
    loadingRef.current = false;
    inflightRef.current = null;
    setLoading(false);
  }, []);

  const loadUntil = React.useCallback(
    async (messageId: string): Promise<EarlierSeekOutcome> => {
      const generation = generationRef.current;
      // A load already running (a "Show earlier messages" click, another read-back):
      // wait for it, then continue from the cursor it leaves.
      while (loadingRef.current && inflightRef.current) {
        await inflightRef.current.catch(() => undefined);
        if (generation !== generationRef.current) return 'stale';
      }
      if (loadedIdsRef.current.has(messageId)) {
        if (failedSeekRef.current === messageId) setFailedSeek(null);
        return 'found';
      }
      const start = cursorRef.current;
      if (!start) return 'not_found';
      begin();
      let at: Cursor = start;
      const read: ChatConversationMessage[] = [];
      let remaining = start.remaining;
      let found = false;
      const run = (async (): Promise<EarlierSeekOutcome> => {
        try {
          while (remaining > 0) {
            const page = await readPage(at, MAX_MESSAGE_PAGE);
            if (generation !== generationRef.current) return 'stale';
            const fresh = page.messages.filter((m) => !read.some((n) => n.id === m.id));
            if (!fresh.length) break;
            read.unshift(...fresh);
            const progressed = page.remaining < remaining;
            remaining = page.remaining;
            if (fresh.some((m) => m.id === messageId)) {
              found = true;
              break;
            }
            if (!progressed) break;
            at = { conversationId: start.conversationId, before: fresh[0].id, remaining };
          }
          apply(start, read, remaining);
          if (failedSeekRef.current) setFailedSeek(null);
          return found ? 'found' : 'not_found';
        } catch (err) {
          if (generation !== generationRef.current) return 'stale';
          // Keep what was read so far; Retry resumes the read-back from there.
          if (read.length) apply(start, read, remaining);
          // The kind travels with the outcome: a caller reading `errorKind` from its
          // last render would still see the previous error (or none).
          const failure = loadError(err);
          setError(failure);
          setFailedSeek(messageId);
          return failure.kind === 'missing' ? 'missing' : 'failed';
        } finally {
          finish(generation);
        }
      })();
      inflightRef.current = run;
      return run;
    },
    [apply, begin, finish, readPage, setFailedSeek],
  );

  const load = React.useCallback(() => {
    if (loadingRef.current) return;
    // Retry after a failed read-back resumes it: the reader asked for that message.
    const seek = failedSeekRef.current;
    if (seek) {
      void loadUntil(seek);
      return;
    }
    const at = cursorRef.current;
    if (!at) return;
    const generation = begin();
    const run = readPage(at, pageSize)
      .then(({ messages, remaining }) => {
        if (generation !== generationRef.current) return;
        apply(at, messages, remaining);
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) setError(loadError(err));
      })
      .finally(() => finish(generation));
    inflightRef.current = run;
  }, [apply, begin, finish, loadUntil, pageSize, readPage]);

  return {
    remaining: cursor?.remaining ?? 0,
    loading,
    error: error?.text ?? null,
    errorKind: error?.kind ?? null,
    loadedAny,
    failedSeek,
    load,
    loadUntil,
  };
}
