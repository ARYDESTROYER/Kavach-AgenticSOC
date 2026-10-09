/**
 * useChatConversations — the Workspace history controller (chat revamp SPEC §7.5,
 * §10.2, §10.7, §10.8), ported from the pre-revamp `pages/Chat.tsx` with its
 * behavioural guarantees intact:
 *
 *  - the list (`GET /api/chat/conversations?limit=60`) newest-first by `updated_at`;
 *  - the selection tri-state: `undefined` = the first load has not chosen yet,
 *    `null` = a deliberate New-chat draft that survives list refreshes, a string = a
 *    selected thread (the first load selects the newest);
 *  - generation guards: a stale list or detail response never overwrites a newer
 *    choice, and rename/pin/delete invalidate in-flight list reads;
 *  - skip-hydration: the engine that just persisted a draft keeps its live transcript
 *    (no refetch flash) while that thread stays active; switching away clears it;
 *  - refresh on window focus, on `visibilitychange` → visible, and on a cross-tab
 *    `BroadcastChannel('agentic-soc-workspace-chat-history')` `{type:'history-changed'}`
 *    signal — all DEFERRED while a turn is in flight and flushed when it settles;
 *  - optimistic promotion of a first persisted turn into the rail, then a background
 *    refresh and a broadcast;
 *  - rename / pin / delete (the host confirms deletion), each broadcasting;
 *  - per-thread unsent drafts (never written to the server);
 *  - honest retention (`limit`, `history_truncated`, totals) for the rail footer and
 *    the per-thread "Showing the latest X of Y messages" note.
 *
 * Revamp additions: server-side content search (`?q=`, debounced, with snippets),
 * pinning (≤ 10; 409 `chat_pin_limit`), `report_id` on rows, and a REQUESTED selection
 * from the route (`NavOpts` `conversationId` / `messageId` / `newChat` / `topic` / the
 * palette's `ask`).
 *
 * The list is one page of 60: the server keeps the newest 50 unpinned conversations plus
 * up to 10 pin-exempt ones, so every kept thread fits (SPEC A9). A thread can still be
 * missing from the page (another tab's newer threads, a deep link to one the server
 * just evicted), so it is CHECKED (`GET …/{id}`) before it is called unavailable or the
 * selection falls back: only a 404 means it is gone.
 *
 * Case-scoped chat passes `enabled: false`: no list, no detail, no persistence.
 */
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { ChatConversation, ChatConversationSearchHit, ChatConversationSummary } from '@/lib/types';
import type { NavOpts } from '@/soc/nav-types';
import {
  UNTITLED_CONVERSATION,
  apiErrorCode,
  deleteConversation,
  getConversation,
  isSafeChatId,
  listConversations,
  updateConversation,
} from './chat-api';
import { clampAsk } from './ask';
import { displayText } from './stream-events';
import { consoleTopic } from './topic';

/** The cross-tab history signal (unchanged from the pre-revamp page). */
export const HISTORY_CHANNEL = 'agentic-soc-workspace-chat-history';
/** Draft key of the New-chat draft. */
export const NEW_DRAFT_KEY = '__new_workspace_chat__';
/** Unpinned conversations the server keeps (the retention footer's figure). */
export const DEFAULT_HISTORY_LIMIT = 50;
/** The rail shows its retention footer from this many conversations (SPEC §10.2). */
export const RETENTION_NOTE_THRESHOLD = 45;
/** Pinned conversations are exempt from eviction, up to this many (SPEC §7.5). */
export const MAX_PINNED_CONVERSATIONS = 10;
/**
 * One rail page: the kept unpinned conversations plus every pin-exempt one (the
 * server's `limit` maximum, SPEC A9), so a user with pins never loses the oldest kept
 * threads off the page.
 */
export const CONVERSATION_PAGE_LIMIT = DEFAULT_HISTORY_LIMIT + MAX_PINNED_CONVERSATIONS;
/** Server search input bound and debounce. */
export const MAX_SEARCH_CHARS = 200;
const SEARCH_DEBOUNCE_MS = 250;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) return error.message || fallback;
  return fallback;
}

/** What a direct check of one thread found. */
type ThreadProbe = { state: 'exists'; summary: ChatConversationSummary } | { state: 'missing' } | { state: 'unknown' };

/**
 * Check a thread that is not on the loaded page: a 404 means deleted or evicted; any
 * other failure is "unknown" (never treated as gone).
 */
async function probeConversation(id: string): Promise<ThreadProbe> {
  try {
    const { messages: _messages, ...summary } = await getConversation(id);
    void _messages;
    return { state: 'exists', summary };
  } catch (error) {
    return error instanceof ApiError && error.status === 404 ? { state: 'missing' } : { state: 'unknown' };
  }
}

/** Newest first by `updated_at`; unparsable dates sink, ties keep their order. */
export function newestConversationFirst(a: ChatConversationSummary, b: ChatConversationSummary): number {
  const left = Date.parse(a.updated_at);
  const right = Date.parse(b.updated_at);
  return (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity) || 0;
}

/** A validated chat deep-link request (SPEC §10.7). */
export interface ChatNavRequest {
  conversationId: string | null;
  messageId: string | null;
  newChat: boolean;
  /** A `console_map` topic id; the page resolves it to a templated question. */
  topic: string | null;
  /** The palette's "Ask AI" text, prefilled into the new chat's composer (never sent). */
  ask: string | null;
}

/**
 * Read the chat keys of `NavOpts`, validated (an invalid id is dropped, a message id
 * without its conversation is dropped). `null` when nothing chat-related was asked.
 * A `topic` or an `ask` implies a fresh chat; a `conversationId` wins over `newChat`,
 * and a `topic` (a templated question the page sends) wins over a free-text `ask`.
 */
export function parseChatNavRequest(opts: NavOpts | null | undefined): ChatNavRequest | null {
  if (!opts) return null;
  const conversationId = isSafeChatId(opts.conversationId) ? opts.conversationId : null;
  const messageId = conversationId && isSafeChatId(opts.messageId) ? opts.messageId : null;
  const topic = consoleTopic(opts.topic);
  const ask = topic ? null : clampAsk(opts.ask);
  const newChat = !conversationId && (opts.newChat === true || topic !== null || ask !== null);
  if (!conversationId && !newChat) return null;
  return { conversationId, messageId, newChat, topic: conversationId ? null : topic, ask: conversationId ? null : ask };
}

export interface UseChatConversationsOptions {
  /** `false` for case-scoped chat: no history at all. Default true. */
  enabled?: boolean;
  /** The route's `NavOpts` (identity-keyed: each navigation is applied once). */
  requested?: NavOpts | null;
  /** Conversations to request per page (and per search). Default 60 (SPEC A9). */
  limit?: number;
  /**
   * Asked before a delete; resolve `false` to cancel. The host owns the dialog copy
   * ("Delete conversation? … Its report stays in Reports").
   */
  confirmDelete?: (item: ChatConversationSummary) => Promise<boolean>;
}

/** The highlight the page applies after a requested selection (scroll + 2 s). */
export interface ChatHighlightRequest {
  conversationId: string;
  messageId: string;
  /** Changes on every request, so the same message can be highlighted again. */
  nonce: number;
}

export interface ChatRetentionInfo {
  /** The server's unpinned-conversation retention (50), not the page size. */
  limit: number;
  /** Older conversations were evicted. */
  truncated: boolean;
  /** Conversations ever kept (`total_conversation_count`, else `total`, else rows). */
  total: number;
  /** Show the rail footer (truncated, or at least 45 conversations). */
  showNote: boolean;
}

export interface ChatThreadRetention {
  /** The server's `history_truncated`: SOMETHING was shortened (text, an answer, turns). */
  truncated: boolean;
  /**
   * Turns were REMOVED: `total_message_count > message_count` (the backend's
   * `stores.chat_conversations.turns_removed`; the lifetime count only grows).
   */
  removed: boolean;
  retained: number | null;
  total: number | null;
  /**
   * The removed-turns note above the transcript (null when nothing was removed). A
   * thread that was only shortened in place gets no thread-level line: each restored
   * answer whose snapshot was compacted carries its own quiet hint (SPEC A22), and
   * clipped text ends with its own "[truncated in saved history]" marker.
   */
  note: string | null;
}

/** The per-conversation message window (`MAX_MESSAGES_PER_CONVERSATION`, SPEC §7.5). */
export const MAX_THREAD_MESSAGES = 100;

/**
 * The thread retention copy from the stored counts. Turns were removed exactly when the
 * lifetime count exceeds the retained count; below the 100-message window that can only
 * be the storage bound, at the window it is the 100-message limit. `history_truncated`
 * alone (no turn missing) means an answer or prompt was shortened in place, which the
 * transcript shows per answer, not here.
 */
export function threadRetentionInfo(
  retained: number | null,
  total: number | null,
  truncated: boolean,
): ChatThreadRetention {
  const removed = typeof retained === 'number' && typeof total === 'number' && total > retained;
  let note: string | null = null;
  if (removed) {
    note =
      (retained as number) >= MAX_THREAD_MESSAGES
        ? `Showing the latest ${retained} of ${total} messages. Conversations keep their newest ${MAX_THREAD_MESSAGES} messages.`
        : `Showing the latest ${retained} of ${total} messages. Older messages were removed to stay within the storage limit.`;
  }
  return { truncated, removed, retained, total, note };
}

export interface ChatConversationsController {
  enabled: boolean;
  /** Newest first. Pinned rows are flagged (`pinned`), not reordered; the rail groups. */
  conversations: ChatConversationSummary[];
  /** `undefined` until the first load chooses; `null` = New chat; else the selection. */
  activeId: string | null | undefined;
  activeSummary: ChatConversationSummary | null;
  /** The hydrated saved thread for the engine (`null` for a draft or while loading). */
  conversation: ChatConversation | null;
  listLoading: boolean;
  listError: string | null;
  threadLoading: boolean;
  threadError: string | null;
  /** The thread frame should show its restoring state (and refuse sends). */
  restoring: boolean;
  retention: ChatRetentionInfo;
  threadRetention: ChatThreadRetention;
  /** The requested conversation no longer exists (deleted or evicted). */
  requestedUnavailable: boolean;
  dismissRequestedUnavailable: () => void;
  /** A message to scroll to and highlight (after a requested selection or search hit). */
  highlight: ChatHighlightRequest | null;
  clearHighlight: () => void;
  /** The validated topic of the last `topic` request (the page asks its template). */
  topic: string | null;
  clearTopic: () => void;
  /**
   * The palette's "Ask AI" text for the fresh draft of the last request (the page
   * prefills the composer once, then clears it). Dropped by any later navigation.
   */
  ask: string | null;
  clearAsk: () => void;
  /**
   * Increments whenever the controller deliberately enters a fresh New-chat draft
   * (New chat, deleting the last thread, a `newChat` / `topic` request). Pass it to
   * `useChatEngine({ resetKey })`: the saved `conversation` may already be `null`, so
   * the engine cannot detect this transition by identity.
   */
  newDraftEpoch: number;
  /**
   * Increments on EVERY deliberate transcript change: a New-chat draft (as
   * `newDraftEpoch`) and a selection of another thread. Pass THIS to
   * `useChatEngine({ resetKey })`: a draft saved this session keeps `conversation`
   * at `null` (skip-hydration), so selecting another thread is `null` → `null` and,
   * without it, the old transcript would stay under the next thread's title (and
   * its report bindings) until that thread's detail loads.
   */
  transcriptEpoch: number;

  /** A turn is in flight: selection and refresh wait. Wire to the engine. */
  busy: boolean;
  setBusy: (busy: boolean) => void;

  /** Server-side content search. */
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /** `null` when no search is active. */
  searchResults: ChatConversationSearchHit[] | null;
  searching: boolean;
  searchError: string | null;
  /** Open a search hit: select its conversation and highlight the matching message. */
  openSearchHit: (hit: ChatConversationSearchHit) => void;

  /** Refresh the list (deferred while busy). */
  refresh: () => void;
  /** Reload the list now (the rail's Retry). */
  reload: () => Promise<void>;
  startNew: () => void;
  select: (item: ChatConversationSummary | string) => void;
  retryThread: () => void;
  /**
   * The engine persisted a turn into `id` (first or later). `title` is the server title,
   * the prompt for a brand-new thread, or '' to keep the row's title.
   */
  conversationPersisted: (id: string, title: string) => void;
  /**
   * The conversation's draft report is now `reportId` (the first Add to report created
   * it): its row learns the link at once, so "Open report" and the toolbar count
   * survive switching away and back before the next list refresh.
   */
  noteReport: (id: string, reportId: string | null) => void;
  rename: (item: ChatConversationSummary, title: string) => Promise<boolean>;
  setPinned: (item: ChatConversationSummary, pinned: boolean) => Promise<boolean>;
  remove: (item: ChatConversationSummary) => Promise<boolean>;

  /** The active thread's unsent draft (per thread; New chat has its own). */
  draft: string;
  setDraft: (value: string) => void;
  draftKey: string;
}

export function useChatConversations(options: UseChatConversationsOptions = {}): ChatConversationsController {
  const { enabled = true, requested = null, limit = CONVERSATION_PAGE_LIMIT, confirmDelete } = options;

  const [conversations, setConversations] = React.useState<ChatConversationSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null | undefined>(undefined);
  const [conversation, setConversation] = React.useState<ChatConversation | null>(null);
  const [listLoading, setListLoading] = React.useState(enabled);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);
  const [threadError, setThreadError] = React.useState<string | null>(null);
  const [threadRetryEpoch, setThreadRetryEpoch] = React.useState(0);
  const [busy, setBusyState] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [historyLimit, setHistoryLimit] = React.useState(DEFAULT_HISTORY_LIMIT);
  const [historyTruncated, setHistoryTruncated] = React.useState(false);
  const [historyTotal, setHistoryTotal] = React.useState(0);
  const [requestedUnavailable, setRequestedUnavailable] = React.useState(false);
  const [highlight, setHighlight] = React.useState<ChatHighlightRequest | null>(null);
  const [topic, setTopic] = React.useState<string | null>(null);
  const [ask, setAsk] = React.useState<string | null>(null);
  const [newDraftEpoch, setNewDraftEpoch] = React.useState(0);
  const [transcriptEpoch, setTranscriptEpoch] = React.useState(0);
  const [searchQuery, setSearchQueryState] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<ChatConversationSearchHit[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);

  const detailRequestRef = React.useRef(0);
  const listRequestRef = React.useRef(0);
  const searchRequestRef = React.useRef(0);
  const skipDetailIdRef = React.useRef<string | null>(null);
  const conversationsRef = React.useRef<ChatConversationSummary[]>([]);
  const activeIdRef = React.useRef<string | null | undefined>(undefined);
  const busyRef = React.useRef(false);
  const refreshPendingRef = React.useRef(false);
  const channelRef = React.useRef<BroadcastChannel | null>(null);
  const loadedOnceRef = React.useRef(false);
  /** A requested selection waiting for the list (or for the turn to settle). */
  const pendingRequestRef = React.useRef<ChatNavRequest | null>(null);
  /** Bumps on every deliberate selection change, so a slow thread check never overrides one. */
  const selectionEpochRef = React.useRef(0);
  const highlightNonceRef = React.useRef(0);
  const confirmRef = React.useRef(confirmDelete);
  confirmRef.current = confirmDelete;

  React.useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  React.useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /* ------------------------------------------------------------- selection -- */

  const enterSelection = React.useCallback((id: string) => {
    // Enter the pending state before React paints the new selection, so thread A's
    // transcript never shows under thread B's title while B's detail loads.
    selectionEpochRef.current += 1;
    detailRequestRef.current += 1;
    skipDetailIdRef.current = null;
    activeIdRef.current = id;
    setConversation(null);
    setThreadError(null);
    setThreadLoading(true);
    setActiveId(id);
    // `conversation` may already be null (a just-persisted draft keeps it null): the
    // engine resets on the epoch, so the old transcript never shows under B's title.
    setTranscriptEpoch((epoch) => epoch + 1);
  }, []);

  const enterNewDraft = React.useCallback(() => {
    selectionEpochRef.current += 1;
    detailRequestRef.current += 1;
    skipDetailIdRef.current = null;
    activeIdRef.current = null;
    setActiveId(null);
    setConversation(null);
    setThreadError(null);
    setThreadLoading(false);
    // `conversation` may already be null (a just-persisted draft keeps it null), so
    // the engine cannot see this transition by identity: hosts reset on the epoch.
    setNewDraftEpoch((epoch) => epoch + 1);
    setTranscriptEpoch((epoch) => epoch + 1);
  }, []);

  /** Activate a resolved request target (no re-entry when it is already active). */
  const applyTarget = React.useCallback(
    (target: string | null) => {
      if (target === null) enterNewDraft();
      else if (target !== activeIdRef.current) enterSelection(target);
    },
    [enterNewDraft, enterSelection],
  );

  const queueHighlight = React.useCallback((conversationId: string, messageId: string | null) => {
    if (!messageId) return;
    highlightNonceRef.current += 1;
    setHighlight({ conversationId, messageId, nonce: highlightNonceRef.current });
  }, []);

  /** Add (or refresh) a row the page did not include, keeping newest-first order. */
  const mergeRow = React.useCallback((row: ChatConversationSummary) => {
    setConversations((current) => {
      const next = [...current.filter((entry) => entry.id !== row.id), row].sort(newestConversationFirst);
      conversationsRef.current = next;
      return next;
    });
  }, []);

  /**
   * Apply a requested selection against the loaded rows: the requested thread, or a
   * fresh draft (asked for, or the thread no longer exists). A thread that is not on
   * the page is checked first; only a 404 makes it "no longer available".
   */
  const applyRequest = React.useCallback(
    async (request: ChatNavRequest, rows: ChatConversationSummary[], listFailed: boolean): Promise<void> => {
      // The latest navigation decides: an unconsumed ask from an earlier one never
      // prefills a draft it was not meant for.
      setAsk(request.newChat ? request.ask : null);
      if (request.newChat) {
        if (request.topic) setTopic(request.topic);
        applyTarget(null);
        return;
      }
      const id = request.conversationId as string;
      // History is helpful, not a prerequisite: when the list failed, try the detail
      // anyway (its own error state covers a missing thread).
      if (!listFailed && !rows.some((row) => row.id === id)) {
        const epoch = selectionEpochRef.current;
        const probe = await probeConversation(id);
        // The analyst (or a newer navigation) moved on while the check ran.
        if (epoch !== selectionEpochRef.current || pendingRequestRef.current) return;
        if (probe.state === 'missing') {
          setRequestedUnavailable(true);
          applyTarget(null);
          return;
        }
        if (probe.state === 'exists') mergeRow(probe.summary);
      }
      setRequestedUnavailable(false);
      queueHighlight(id, request.messageId);
      applyTarget(id);
    },
    [applyTarget, mergeRow, queueHighlight],
  );

  /**
   * The selected thread is not on a refreshed page: deleted elsewhere (fall back to the
   * newest, as before), or simply beyond the page (keep it and its row). An unreadable
   * check keeps the selection rather than throwing the analyst out of the thread.
   */
  const confirmBeyondPage = React.useCallback(
    async (id: string) => {
      const epoch = selectionEpochRef.current;
      const probe = await probeConversation(id);
      if (epoch !== selectionEpochRef.current || activeIdRef.current !== id) return;
      if (probe.state === 'exists') {
        mergeRow(probe.summary);
        return;
      }
      if (probe.state === 'unknown') return;
      const remaining = conversationsRef.current.filter((entry) => entry.id !== id);
      conversationsRef.current = remaining;
      setConversations(remaining);
      const fallback = remaining[0]?.id ?? null;
      if (fallback) enterSelection(fallback);
      else enterNewDraft();
    },
    [enterNewDraft, enterSelection, mergeRow],
  );

  /* ------------------------------------------------------------------ list -- */

  const loadConversations = React.useCallback(async () => {
    const generation = ++listRequestRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const response = await listConversations({ limit });
      if (generation !== listRequestRef.current) return;
      const rows = [...response.conversations].sort(newestConversationFirst);
      const pending = !busyRef.current ? pendingRequestRef.current : null;
      const current = activeIdRef.current;
      const selectedOffPage = !pending && typeof current === 'string' && !rows.some((item) => item.id === current);
      // Keep the selected thread's row while it is checked (no rail flicker).
      const kept = selectedOffPage ? conversationsRef.current.find((item) => item.id === current) : undefined;
      const next = kept ? [...rows, kept].sort(newestConversationFirst) : rows;
      setConversations(next);
      conversationsRef.current = next;
      // The echoed `limit` is the PAGE size (60 = 50 kept + 10 pin-exempt); the footer's
      // retention figure is the 50-conversation eviction bound, never the page.
      setHistoryLimit(
        typeof response.limit === 'number' && response.limit > 0
          ? Math.min(response.limit, DEFAULT_HISTORY_LIMIT)
          : DEFAULT_HISTORY_LIMIT,
      );
      setHistoryTruncated(response.history_truncated === true);
      setHistoryTotal(
        typeof response.total_conversation_count === 'number'
          ? response.total_conversation_count
          : typeof response.total === 'number'
            ? response.total
            : next.length,
      );
      if (pending) {
        pendingRequestRef.current = null;
        void applyRequest(pending, rows, false);
      } else if (selectedOffPage) {
        void confirmBeyondPage(current as string);
      } else {
        // The first load selects the newest; a deliberate New-chat draft stays a draft.
        setActiveId((selected) => {
          if (selected && next.some((item) => item.id === selected)) return selected;
          if (selected === null) return null;
          return next[0]?.id ?? null;
        });
      }
    } catch (error) {
      if (generation !== listRequestRef.current) return;
      setListError(errorMessage(error, 'Could not load previous conversations.'));
      const pending = !busyRef.current ? pendingRequestRef.current : null;
      if (pending) {
        pendingRequestRef.current = null;
        void applyRequest(pending, [], true);
      } else {
        // History is helpful, not a prerequisite for a fresh investigation.
        setActiveId((current) => (current === undefined ? null : current));
      }
    } finally {
      if (generation === listRequestRef.current) {
        // Even a failed load settles the first choice, so later navigations apply.
        loadedOnceRef.current = true;
        setListLoading(false);
      }
    }
  }, [applyRequest, confirmBeyondPage, limit]);

  React.useEffect(() => {
    if (!enabled) {
      listRequestRef.current += 1;
      detailRequestRef.current += 1;
      searchRequestRef.current += 1;
      setConversations([]);
      setActiveId(null);
      setConversation(null);
      setListError(null);
      setHistoryTruncated(false);
      setHistoryTotal(0);
      setThreadError(null);
      setListLoading(false);
      setThreadLoading(false);
      setSearchResults(null);
      return;
    }
    void loadConversations();
  }, [enabled, loadConversations]);

  const refresh = React.useCallback(() => {
    if (!enabled) return;
    if (busyRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    void loadConversations();
  }, [enabled, loadConversations]);

  const announce = React.useCallback(() => {
    channelRef.current?.postMessage({ type: 'history-changed' });
  }, []);

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    if (typeof window.BroadcastChannel === 'function') {
      const channel = new window.BroadcastChannel(HISTORY_CHANNEL);
      channelRef.current = channel;
      channel.onmessage = () => refresh();
    }
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      channelRef.current?.close();
      channelRef.current = null;
    };
  }, [enabled, refresh]);

  /* -------------------------------------------------------- requested route -- */

  // Identity-keyed: the router creates a new opts object per navigation, so each
  // request is applied once (a hash echo with the same ids is idempotent anyway).
  // It resolves against a FRESH list, so a thread created in another tab is found.
  React.useEffect(() => {
    if (!enabled) return;
    const request = parseChatNavRequest(requested);
    if (!request) return;
    if (request.conversationId && activeIdRef.current === request.conversationId) {
      setRequestedUnavailable(false);
      queueHighlight(request.conversationId, request.messageId);
      return;
    }
    pendingRequestRef.current = request;
    // Before the first load, or while a turn runs, the request waits for that load /
    // for the turn to settle (`setBusy(false)` reloads).
    if (busyRef.current || !loadedOnceRef.current) return;
    void loadConversations();
    // Only a new navigation (a new opts object) may apply a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, requested]);

  /* ---------------------------------------------------------------- detail -- */

  React.useEffect(() => {
    const generation = ++detailRequestRef.current;
    setThreadError(null);
    if (!activeId) {
      setConversation(null);
      setThreadLoading(false);
      return;
    }
    if (skipDetailIdRef.current === activeId) {
      // The engine already owns the just-persisted transcript. Keep the marker while
      // this same thread stays active; switching/new-chat clear it before the next
      // selection, which then hydrates normally.
      setThreadLoading(false);
      return;
    }
    setThreadLoading(true);
    void getConversation(activeId)
      .then((detail) => {
        if (generation === detailRequestRef.current) setConversation(detail);
      })
      .catch((error) => {
        if (generation !== detailRequestRef.current) return;
        setConversation(null);
        setThreadError(errorMessage(error, 'Could not load this conversation.'));
      })
      .finally(() => {
        if (generation === detailRequestRef.current) setThreadLoading(false);
      });
  }, [activeId, threadRetryEpoch]);

  /* --------------------------------------------------------------- actions -- */

  const setBusy = React.useCallback(
    (value: boolean) => {
      busyRef.current = value;
      setBusyState(value);
      if (value) return;
      if (pendingRequestRef.current && loadedOnceRef.current) {
        // A navigation that arrived mid-turn: resolve it against a fresh list.
        refreshPendingRef.current = false;
        void loadConversations();
        return;
      }
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        void loadConversations();
      }
    },
    [loadConversations],
  );

  const startNew = React.useCallback(() => {
    if (busyRef.current) return;
    enterNewDraft();
  }, [enterNewDraft]);

  const select = React.useCallback(
    (item: ChatConversationSummary | string) => {
      if (busyRef.current) return;
      const id = typeof item === 'string' ? item : item.id;
      if (!isSafeChatId(id)) return;
      if (activeIdRef.current === id) return;
      enterSelection(id);
    },
    [enterSelection],
  );

  const openSearchHit = React.useCallback(
    (hit: ChatConversationSearchHit) => {
      if (busyRef.current || !isSafeChatId(hit.id)) return;
      if (activeIdRef.current !== hit.id) enterSelection(hit.id);
      const messageId = hit.match?.message_id;
      if (messageId) queueHighlight(hit.id, messageId);
    },
    [enterSelection, queueHighlight],
  );

  const retryThread = React.useCallback(() => setThreadRetryEpoch((epoch) => epoch + 1), []);

  const conversationPersisted = React.useCallback(
    (id: string, rawTitle: string) => {
      // The engine passes the server title, the exact prompt (a new thread whose title
      // it has not seen yet) or '' (keep the row's title): display text only from here
      // on (BLOCKS.md amendment 4).
      const title = displayText(rawTitle, 80);
      // Only a draft's first persisted response needs to suppress hydration. Later
      // turns on the same thread must not leave a skip token that could be consumed
      // after the analyst switches away and returns.
      if (activeIdRef.current !== id) skipDetailIdRef.current = id;
      activeIdRef.current = id;
      setActiveId(id);
      setConversations((current) => {
        const existing = current.find((item) => item.id === id);
        const now = new Date().toISOString();
        const optimistic: ChatConversationSummary = existing ?? {
          id,
          title: title || UNTITLED_CONVERSATION,
          preview: title,
          created_at: now,
          updated_at: now,
          message_count: 2,
        };
        const next = [
          { ...optimistic, title: title || optimistic.title, updated_at: now },
          ...current.filter((item) => item.id !== id),
        ];
        conversationsRef.current = next;
        return next;
      });
      // Carry the New-chat draft over to the thread it became.
      setDrafts((current) => {
        if (!(NEW_DRAFT_KEY in current) || id in current) return current;
        const next = { ...current, [id]: current[NEW_DRAFT_KEY] };
        delete next[NEW_DRAFT_KEY];
        return next;
      });
      // The response is saved before this runs. Refresh metadata in the background
      // without re-hydrating the live transcript that owns the answer.
      refresh();
      announce();
    },
    [announce, refresh],
  );

  const replaceRow = React.useCallback((updated: ChatConversationSummary) => {
    // A list request started before this mutation must not put stale data back.
    listRequestRef.current += 1;
    setListLoading(false);
    setConversations((current) => {
      const next = current
        .map((entry) => (entry.id === updated.id ? { ...entry, ...updated } : entry))
        .sort(newestConversationFirst);
      conversationsRef.current = next;
      return next;
    });
    setSearchResults((current) =>
      current ? current.map((entry) => (entry.id === updated.id ? { ...entry, ...updated } : entry)) : current,
    );
  }, []);

  const noteReport = React.useCallback(
    (id: string, reportId: string | null) => {
      const row = conversationsRef.current.find((entry) => entry.id === id);
      if (!row || (row.report_id ?? null) === reportId) return;
      replaceRow({ ...row, report_id: reportId });
    },
    [replaceRow],
  );

  const rename = React.useCallback(
    async (item: ChatConversationSummary, title: string): Promise<boolean> => {
      try {
        replaceRow(await updateConversation(item.id, { title }));
        announce();
        return true;
      } catch (error) {
        setListError(errorMessage(error, 'Could not rename the conversation.'));
        return false;
      }
    },
    [announce, replaceRow],
  );

  const setPinned = React.useCallback(
    async (item: ChatConversationSummary, pinned: boolean): Promise<boolean> => {
      try {
        // Pinning never changes `updated_at`, so the row keeps its place.
        replaceRow(await updateConversation(item.id, { pinned }));
        announce();
        return true;
      } catch (error) {
        setListError(
          apiErrorCode(error) === 'chat_pin_limit'
            ? `You can pin up to ${MAX_PINNED_CONVERSATIONS} conversations. Unpin one first.`
            : errorMessage(error, 'Could not update the conversation.'),
        );
        return false;
      }
    },
    [announce, replaceRow],
  );

  const remove = React.useCallback(
    async (item: ChatConversationSummary): Promise<boolean> => {
      // Deleting the thread a turn is running in would switch the selection and make
      // the engine abandon the turn: refuse, as select / startNew do (checked again
      // after the dialog, since a turn may have started while it was open).
      const refuseWhileBusy = () => {
        if (!busyRef.current || activeIdRef.current !== item.id) return false;
        setListError('Wait for the current answer to finish before deleting this conversation.');
        return true;
      };
      if (refuseWhileBusy()) return false;
      const confirmFn = confirmRef.current;
      if (confirmFn && !(await confirmFn(item))) return false;
      if (refuseWhileBusy()) return false;
      try {
        await deleteConversation(item.id);
      } catch (error) {
        setListError(errorMessage(error, 'Could not delete the conversation.'));
        return false;
      }
      // Invalidate list/detail responses that still include the deleted thread.
      listRequestRef.current += 1;
      setListLoading(false);
      const deletingActive = activeIdRef.current === item.id;
      if (deletingActive) detailRequestRef.current += 1;
      const remaining = conversationsRef.current.filter((entry) => entry.id !== item.id);
      conversationsRef.current = remaining;
      setConversations(remaining);
      setSearchResults((current) => (current ? current.filter((entry) => entry.id !== item.id) : current));
      setDrafts((current) => {
        if (!(item.id in current)) return current;
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      if (deletingActive) {
        const fallback = remaining[0]?.id ?? null;
        if (fallback) enterSelection(fallback);
        else enterNewDraft();
      }
      announce();
      return true;
    },
    [announce, enterNewDraft, enterSelection],
  );

  /* ---------------------------------------------------------------- search -- */

  const setSearchQuery = React.useCallback((query: string) => {
    setSearchQueryState(Array.from(query).slice(0, MAX_SEARCH_CHARS).join(''));
  }, []);

  React.useEffect(() => {
    const generation = ++searchRequestRef.current;
    const q = searchQuery.trim();
    if (!enabled || !q) {
      setSearchResults(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void listConversations({ limit, q })
        .then((response) => {
          if (generation !== searchRequestRef.current) return;
          setSearchResults(response.conversations);
          setSearchError(null);
        })
        .catch((error) => {
          if (generation !== searchRequestRef.current) return;
          setSearchResults([]);
          setSearchError(errorMessage(error, 'Search is unavailable right now.'));
        })
        .finally(() => {
          if (generation === searchRequestRef.current) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, limit, searchQuery]);

  /* ---------------------------------------------------------------- drafts -- */

  const draftKey = activeId || NEW_DRAFT_KEY;
  const draft = drafts[draftKey] ?? '';
  const setDraft = React.useCallback(
    (value: string) => {
      setDrafts((current) => {
        if (!value) {
          if (!(draftKey in current)) return current;
          const next = { ...current };
          delete next[draftKey];
          return next;
        }
        if (current[draftKey] === value) return current;
        return { ...current, [draftKey]: value };
      });
    },
    [draftKey],
  );

  /* -------------------------------------------------------------- derived -- */

  const activeSummary = React.useMemo(
    () => conversations.find((item) => item.id === activeId) ?? null,
    [activeId, conversations],
  );

  const retention: ChatRetentionInfo = {
    limit: historyLimit,
    truncated: historyTruncated,
    total: historyTotal,
    showNote: historyTruncated || conversations.length >= RETENTION_NOTE_THRESHOLD,
  };

  const retained = conversation?.message_count ?? activeSummary?.message_count ?? null;
  const total = conversation?.total_message_count ?? activeSummary?.total_message_count ?? null;
  const threadTruncated = conversation?.history_truncated === true || activeSummary?.history_truncated === true;
  const threadRetention = threadRetentionInfo(retained, total, threadTruncated);

  const restoring =
    enabled &&
    (activeId === undefined ||
      threadLoading ||
      (!!activeId && conversation?.id !== activeId && skipDetailIdRef.current !== activeId));

  return {
    enabled,
    conversations,
    activeId,
    activeSummary,
    conversation,
    listLoading,
    listError,
    threadLoading,
    threadError,
    restoring,
    retention,
    threadRetention,
    requestedUnavailable,
    dismissRequestedUnavailable: React.useCallback(() => setRequestedUnavailable(false), []),
    highlight,
    clearHighlight: React.useCallback(() => setHighlight(null), []),
    topic,
    clearTopic: React.useCallback(() => setTopic(null), []),
    ask,
    clearAsk: React.useCallback(() => setAsk(null), []),
    newDraftEpoch,
    transcriptEpoch,
    busy,
    setBusy,
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    searchError,
    openSearchHit,
    refresh,
    reload: loadConversations,
    startNew,
    select,
    retryThread,
    conversationPersisted,
    noteReport,
    rename,
    setPinned,
    remove,
    draft,
    setDraft,
    draftKey,
  };
}
