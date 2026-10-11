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
 *    deep link to an older message) is on screen, in pages of the server maximum.
 *
 * Case chat has no saved conversation and never pages (`conversation` is null).
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { ChatConversation, ChatConversationMessage } from '@/lib/types';
import { EARLIER_PAGE_SIZE, MAX_MESSAGE_PAGE, getConversationMessages } from './chat-api';
import type { ChatEngine } from './useChatEngine';

/** The control's error copy (a Retry follows it). */
export const EARLIER_LOAD_ERROR = 'Earlier messages could not be loaded.';

export interface EarlierMessages {
  /** Older messages not on screen yet (0 = the conversation is shown from its start). */
  remaining: number;
  loading: boolean;
  error: string | null;
  /** At least one older page was loaded into this conversation. */
  loadedAny: boolean;
  /** Load the previous page (a no-op while loading or when none remain). */
  load: () => void;
  /**
   * Read back until message `messageId` is on screen or the start is reached. Resolves
   * `true` when the message was found.
   */
  loadUntil: (messageId: string) => Promise<boolean>;
}

interface Cursor {
  conversationId: string;
  /** The oldest message on screen: the next page ends just before it. */
  before: string;
  remaining: number;
}

function cursorFor(conversation: ChatConversation | null | undefined): Cursor | null {
  if (!conversation) return null;
  const remaining = conversation.earlier_message_count ?? 0;
  const before = conversation.messages[0]?.id;
  return remaining > 0 && before ? { conversationId: conversation.id, before, remaining } : null;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'Earlier messages could not be found. Reopen the conversation to try again.';
  }
  return EARLIER_LOAD_ERROR;
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
  const [error, setError] = React.useState<string | null>(null);
  const [loadedAny, setLoadedAny] = React.useState(false);
  const cursorRef = React.useRef(cursor);
  const generationRef = React.useRef(0);
  const loadingRef = React.useRef(false);
  const engineRef = React.useRef(engine);
  engineRef.current = engine;
  const onLoadedRef = React.useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // Another saved conversation (or a fresh read of this one): start over from its window.
  React.useEffect(() => {
    generationRef.current += 1;
    const next = cursorFor(conversation);
    cursorRef.current = next;
    loadingRef.current = false;
    // Same values, same state object: a host that hands over an equal copy re-renders once.
    setCursor((current) =>
      current && next && current.conversationId === next.conversationId && current.before === next.before && current.remaining === next.remaining
        ? current
        : next,
    );
    setLoading(false);
    setError(null);
    setLoadedAny(false);
  }, [conversation]);

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

  const load = React.useCallback(() => {
    const at = cursorRef.current;
    if (!at || loadingRef.current) return;
    const generation = generationRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    void readPage(at, pageSize)
      .then(({ messages, remaining }) => {
        if (generation !== generationRef.current) return;
        apply(at, messages, remaining);
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) setError(errorText(err));
      })
      .finally(() => {
        if (generation !== generationRef.current) return;
        loadingRef.current = false;
        setLoading(false);
      });
  }, [apply, pageSize, readPage]);

  const loadUntil = React.useCallback(
    async (messageId: string): Promise<boolean> => {
      const start = cursorRef.current;
      if (!start || loadingRef.current) return false;
      const generation = generationRef.current;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      let at: Cursor = start;
      const read: ChatConversationMessage[] = [];
      let remaining = start.remaining;
      let found = false;
      try {
        while (remaining > 0) {
          const page = await readPage(at, MAX_MESSAGE_PAGE);
          if (generation !== generationRef.current) return false;
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
        return found;
      } catch (err) {
        if (generation !== generationRef.current) return false;
        // Keep what was read so far.
        if (read.length) apply(start, read, remaining);
        setError(errorText(err));
        return false;
      } finally {
        if (generation === generationRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [apply, readPage],
  );

  return {
    remaining: cursor?.remaining ?? 0,
    loading,
    error,
    loadedAny,
    load,
    loadUntil,
  };
}
