/**
 * useChatEngine — the ONE client turn engine behind both chat entry points (#5):
 * Workspace Chat (persisted per-user conversations) and the case-scoped Case Manager
 * chat (no personal history). Chat revamp SPEC §6, §10.3, §10.8.
 *
 * It owns the transcript, the turn state machine and the composer settings; it renders
 * nothing. Guarantees carried over from the pre-revamp `ChatPanel` (see the must-keep
 * list in SPEC §10.8):
 *
 *  - model history holds only successful exchanges; the current message is sent
 *    separately (never duplicated) and a failed prompt stays visible but is excluded;
 *  - every request carries a client idempotency key; "Retry same request" resends the
 *    exact body with the SAME key and replaces the failed pair, "Ask again" sends the
 *    question with a NEW key (SPEC §6.4);
 *  - a view shows only the run it is attached to: New chat / a thread switch detach it;
 *  - the per-thread draft is controlled by the host when it passes one.
 *
 * Revamp behaviour:
 *
 *  - turns stream by default (`POST /api/chat/stream`, NDJSON); a backend without the
 *    route (404 Not Found / 405) falls back to blocking `/api/chat` for the session;
 *  - live run-log steps (`step.start` → `step.end`), running usage totals (`usage`),
 *    and text deltas (Live text mode) batched to one frame, with `text.reset`;
 *  - `turn.done` is the truth: the streamed state is replaced by its response;
 *  - Stop is server-authoritative (`POST /chat/turns/{id}/cancel`, then keep reading
 *    until `turn.done {notice: cancelled}`); a second Stop abandons the stream locally;
 *  - the turn itself lives in the module-level runner (`turn-runner.ts`): leaving the
 *    page or switching threads DETACHES this view and the answer keeps streaming;
 *    returning re-attaches it (live steps, Stop) and a run that settled meanwhile is
 *    applied once (Round 12, SPEC D13). `busy` is per conversation: other threads stay
 *    open while one answer is being written;
 *  - a stream that ends without `turn.done` / `turn.error` re-attaches to the same turn
 *    (`GET /chat/turns/{id}/events`), else a persisted turn is replayed ONCE with the
 *    same key; turns have no time limit, so recovery has no deadline (see the runner);
 *  - a persisted turn's conversation id is learnt from `turn.start`, so a draft whose
 *    first turn is force-stopped or loses its connection still joins its saved thread;
 *    a locally synthesised "Stopped" answer is shown but never enters model history;
 *  - the D1 rule: a turn whose first model call failed (budget / breaker / provider
 *    notice, nothing billed, nothing saved) never enters history;
 *  - the live mode is the viewer's preference (`prefs.misc.chat_stream_mode`, mirrored
 *    to localStorage for first paint), effective from the next turn.
 *
 * Every string from the server is normalised by `stream-events.ts` before it is stored
 * here (#9); hosts render them as text nodes only.
 */
import * as React from 'react';

import { api } from '@/lib/api';
import type {
  ChatContextBounds,
  ChatConversation,
  ChatConversationMessage,
  ChatOrigin,
  ChatRequest,
  ChatScope,
  ChatStreamMode,
  ChatTimeRange,
  ChatTurn,
} from '@/lib/types';
import { getChatActivity, setAnimatedBrand, showChatTurns, useChatActivity, viewChatActivity } from '../chat-activity/activity';
import { useChatDemoIdentity } from './demo-identity';
import { CHAT_SCOPES, CHAT_STREAM_MODES, displayText } from './stream-events';
import { REQUEST_TOPIC_RE } from './topic';
import {
  attachRun,
  consumeRun,
  findRun,
  isCaseRunOfAnotherDemo,
  isUnsavedTurn,
  noteCaseSessionsDemoIdentity,
  reattachRun,
  readCaseSession,
  runAssistantItem,
  runExchange,
  settledUserItem,
  startRun,
  stopRun,
  subscribeRun,
  writeCaseSession,
  type ChatAssistantItem,
  type ChatTranscriptItem,
  type ChatUserItem,
  type HistoryEntry,
  type TurnRun,
} from './turn-runner';

export { isUnsavedTurn, recoveryDelayMs } from './turn-runner';
export type {
  ChatAssistantItem,
  ChatFailureKind,
  ChatLiveStep,
  ChatLiveStepProgress,
  ChatLiveTurn,
  ChatTranscriptItem,
  ChatTurnFailure,
  ChatUserItem,
} from './turn-runner';

/* -------------------------------------------------------------------------- */
/* Constants.                                                                  */
/* -------------------------------------------------------------------------- */

/** Client history sent with a request: the last 12 exchanges (SPEC §4.3). */
export const CHAT_HISTORY_EXCHANGES = 12;
/** The message a Continue chip sends (`origin: continue`, `continue_of`). */
export const CONTINUE_PROMPT = 'Continue where the previous answer stopped.';
/** localStorage mirror of the viewer's live mode (first paint only). */
export const STREAM_MODE_STORAGE_KEY = 'soc.chat.streamMode';

/**
 * The `/chat/context.bounds` the engine still reads: `animated_brand` (the brand ring,
 * SPEC D13). The turn limits no longer bound recovery (turns have no time limit).
 */
export type ChatTurnBounds = Pick<ChatContextBounds, 'turn_timeout_s' | 'model_step_timeout_s'> & {
  animated_brand?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests and hosts).                                */
/* -------------------------------------------------------------------------- */

/** A client idempotency key (`^[A-Za-z0-9._:-]{8,128}$`). */
export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `chat-${globalThis.crypto.randomUUID()}`;
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** The last {@link CHAT_HISTORY_EXCHANGES} exchanges (oldest dropped first). */
export function boundHistory(history: readonly ChatTurn[]): ChatTurn[] {
  const max = CHAT_HISTORY_EXCHANGES * 2;
  return history.length > max ? history.slice(history.length - max) : [...history];
}

/** The replay character bound the server applies to client history (SPEC §4.3). */
export const CHAT_HISTORY_MAX_CHARS = 24_000;

/** What the server will replay of client-sent `history` (SPEC §4.3). */
export interface ChatHistorySize {
  /** Exchanges kept (user + answer pairs). */
  exchanges: number;
  /** Their user + answer characters (the server's chars ÷ 4 estimate input). */
  chars: number;
}

/**
 * The size of what `select_replay` keeps of `history`: the newest
 * {@link CHAT_HISTORY_EXCHANGES} exchanges whose text fits in
 * {@link CHAT_HISTORY_MAX_CHARS} (oldest dropped first). The case composer's meter
 * uses it, since `/chat/context` cannot see a case chat's client-held history.
 */
export function replayHistorySize(history: readonly ChatTurn[]): ChatHistorySize {
  const pairs: number[] = [];
  let pendingUser: number | null = null;
  for (const turn of history) {
    if (turn.role === 'user') {
      pendingUser = turn.content.length;
    } else if (pendingUser !== null) {
      pairs.push(pendingUser + turn.content.length);
      pendingUser = null;
    }
  }
  const kept = pairs.slice(-CHAT_HISTORY_EXCHANGES);
  let chars = kept.reduce((sum, size) => sum + size, 0);
  while (kept.length && chars > CHAT_HISTORY_MAX_CHARS) chars -= kept.shift() ?? 0;
  return { exchanges: kept.length, chars };
}

const EMPTY_HISTORY_SIZE: ChatHistorySize = { exchanges: 0, chars: 0 };

/**
 * The answer a restored Continue prompt at `userIndex` resumed: Continue is offered on
 * an answer and asks right after it, so it is the nearest saved answer before it.
 */
function continuedAnswerId(items: readonly ChatTranscriptItem[], userIndex: number): string | null {
  for (let i = userIndex - 1; i >= 0; i -= 1) {
    const entry = items[i];
    if (entry.kind === 'assistant') return entry.messageId ?? entry.response?.message_id ?? null;
  }
  return null;
}

/** The assistant item with `key`, if any. */
function findItem(items: readonly ChatTranscriptItem[], key: string): ChatAssistantItem | null {
  const item = items.find((entry) => entry.key === key);
  return item?.kind === 'assistant' ? item : null;
}

const parseTime = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
};

/** Transcript items for a saved conversation (restored turns render collapsed). */
export function itemsFromConversation(conversation: ChatConversation): ChatTranscriptItem[] {
  return itemsFromMessages(conversation.messages ?? []);
}

/** Transcript items for saved messages, oldest first (a conversation or an older page). */
export function itemsFromMessages(messages: readonly ChatConversationMessage[]): ChatTranscriptItem[] {
  const items: ChatTranscriptItem[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({
        kind: 'user',
        key: message.id,
        messageId: message.id,
        content: displayText(message.content, 0, { multiline: true }),
        prompt: message.content,
        // The stored origin (SPEC §4.8): a reopened follow-up / starter / command stays
        // non-user, so Ask again and ↑ recall treat it exactly as the live session did.
        origin: message.origin ?? 'user',
        at: parseTime(message.created_at),
        requestKey: message.idempotency_key ?? null,
        failed: false,
      });
      continue;
    }
    const response = message.response ?? { answer: message.content };
    items.push({
      kind: 'assistant',
      key: message.id,
      messageId: response.message_id ?? message.id,
      at: parseTime(message.created_at),
      requestKey: message.idempotency_key ?? null,
      status: 'done',
      response,
      live: null,
      failure: null,
      restored: true,
      model: message.model?.trim() || response.effective_model?.trim() || null,
      source:
        message.source_name?.trim() ||
        message.source_id?.trim() ||
        response.effective_source_name?.trim() ||
        response.effective_source_id?.trim() ||
        null,
      request: null,
    });
  }
  return items;
}

/** A case session keeps settled exchanges only: a running pair belongs to its run. */
function sessionItems(items: readonly ChatTranscriptItem[]): ChatTranscriptItem[] {
  const running = new Set(
    items.flatMap((item) => (item.kind === 'assistant' && item.status === 'running' && item.requestKey ? [item.requestKey] : [])),
  );
  return items.filter(
    (item) => !(item.kind === 'assistant' && item.status === 'running') && !(item.kind === 'user' && item.requestKey && running.has(item.requestKey)),
  );
}

/* -------------------------------------------------------------------------- */
/* Live mode preference (D2).                                                  */
/* -------------------------------------------------------------------------- */

const isStreamMode = (value: unknown): value is ChatStreamMode =>
  typeof value === 'string' && (CHAT_STREAM_MODES as readonly string[]).includes(value);

function readStoredMode(): ChatStreamMode | null {
  try {
    const value = window.localStorage.getItem(STREAM_MODE_STORAGE_KEY);
    return isStreamMode(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: ChatStreamMode | null): void {
  try {
    if (mode) window.localStorage.setItem(STREAM_MODE_STORAGE_KEY, mode);
    else window.localStorage.removeItem(STREAM_MODE_STORAGE_KEY);
  } catch {
    /* storage blocked (private window, quota): the server preference still applies */
  }
}

export interface ChatStreamModePreference {
  /** The viewer's mode: their explicit choice, else the org default, else `steps`. */
  mode: ChatStreamMode;
  /** True once the viewer has an explicit choice (stored or just made). */
  explicit: boolean;
  /** Persist a choice (localStorage now, `prefs.misc.chat_stream_mode` best-effort). */
  setMode: (mode: ChatStreamMode) => void;
}

/**
 * The per-viewer live mode (SPEC D2). The localStorage mirror paints first; the
 * server preference (`GET /api/prefs/user`) then wins unless the viewer changed the
 * mode in the meantime. Writes go to both, best-effort.
 */
export function useChatStreamMode(orgDefault?: ChatStreamMode | null): ChatStreamModePreference {
  const [choice, setChoice] = React.useState<ChatStreamMode | null>(readStoredMode);
  const touchedRef = React.useRef(false);

  React.useEffect(() => {
    let alive = true;
    void api.prefs
      .getUser()
      .then((prefs) => {
        if (!alive || touchedRef.current) return;
        const misc = prefs && typeof prefs === 'object' ? prefs.misc : undefined;
        const stored = misc && typeof misc === 'object' ? (misc as Record<string, unknown>).chat_stream_mode : undefined;
        const next = isStreamMode(stored) ? stored : null;
        setChoice(next);
        writeStoredMode(next);
      })
      .catch(() => {
        /* offline or a legacy backend: keep the first-paint mirror */
      });
    return () => {
      alive = false;
    };
  }, []);

  const setMode = React.useCallback((mode: ChatStreamMode) => {
    if (!isStreamMode(mode)) return;
    touchedRef.current = true;
    setChoice(mode);
    writeStoredMode(mode);
    void api.prefs.putUser({ misc: { chat_stream_mode: mode } }).catch(() => {
      /* best-effort: the local choice already applies */
    });
  }, []);

  return {
    mode: choice ?? (isStreamMode(orgDefault) ? orgDefault : 'steps'),
    explicit: choice !== null,
    setMode,
  };
}

/* -------------------------------------------------------------------------- */
/* The hook.                                                                   */
/* -------------------------------------------------------------------------- */

export interface ConversationPersistedOptions {
  /** Load the saved thread again (a turn re-attached after a reload, or lost). */
  rehydrate?: boolean;
}

export interface UseChatEngineOptions {
  /** Case-scoped chat (Case Manager): `case_id` on every turn, never persisted. */
  caseId?: string | null;
  /** Persist into the viewer's Workspace history. Default: true unless `caseId`. */
  persist?: boolean;
  /**
   * The host-controlled saved conversation (Workspace). `undefined` keeps the engine
   * fully local (case mode); `null` is a fresh New-chat draft.
   */
  conversation?: ChatConversation | null;
  /** Host-controlled per-thread draft; omit for a local draft. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** Refuse sends (a saved thread is restoring or failed to restore). */
  blocked?: boolean;
  /**
   * When this value changes (after mount) the engine resets to an empty draft, as
   * `reset()` does. Wire `useChatConversations().transcriptEpoch` here.
   */
  resetKey?: string | number | null;
  /** `/chat/context.text_streaming.available`; `false` forces Live steps. */
  textStreamingAvailable?: boolean;
  /** `/chat/context.bounds.default_stream_mode` (the org default). */
  orgDefaultStreamMode?: ChatStreamMode | null;
  /** `/chat/context.bounds`: `animated_brand` drives the brand ring (SPEC D13). */
  turnBounds?: Partial<ChatTurnBounds> | null;
  /** `blocking` always uses `/api/chat` (no live steps, no Stop). Default `stream`. */
  transport?: 'stream' | 'blocking';
  /**
   * A persisted turn landed in conversation `id` (first or later turn). `title` is the
   * server's, the prompt for a new thread, or '' when unknown for an existing one.
   */
  onConversationPersisted?: (id: string, title: string, options?: ConversationPersistedOptions) => void;
  /** This conversation's turn started or settled (the history rail defers refreshes while busy). */
  onBusyChange?: (busy: boolean) => void;
  /** A turn finished (done or error): e.g. refetch `/chat/context`. */
  onTurnSettled?: (item: ChatAssistantItem) => void;
}

export interface ChatSendOptions {
  /** Who authored the text (SPEC §4.8 taint): default `user`. */
  origin?: ChatOrigin;
  /** The assistant message id a Continue turn resumes. */
  continueOf?: string | null;
  /**
   * The `console_map` topic an "Ask about this" turn was started from (SPEC A7,
   * `ChatRequest.topic`): retrieval pins that topic's glossary sections. Never prompt
   * text; a value outside the server grammar is dropped rather than sent (it would 422).
   */
  topic?: string | null;
}

/**
 * Whether Retry may resend a SETTLED turn with its same key: a D1 unsaved failure
 * (nothing billed or saved), or an answer whose save failed with a retryable
 * `not_saved` notice. The second matters for case chat: the server deduplicates the
 * case-thread append by the request key (SPEC A4), so a fresh key could append the
 * same answer twice. The model still runs again (the UI says so).
 */
export function retriesWithSameKey(item: Pick<ChatAssistantItem, 'status' | 'response' | 'request'>): boolean {
  if (!item.request) return false;
  if (item.status === 'error') return true;
  if (item.status !== 'done' || !item.response) return false;
  if (isUnsavedTurn(item.response)) return true;
  // The save outcome may travel apart from the top notice (case_save_notice, SPEC A25).
  const notice = item.response.case_save_notice?.kind === 'not_saved' ? item.response.case_save_notice : item.response.notice;
  return notice?.kind === 'not_saved' && notice.retryable === true;
}

export interface ChatEngine {
  items: ChatTranscriptItem[];
  /** The in-flight assistant item, if any. */
  running: ChatAssistantItem | null;
  /** THIS conversation (or case) has an answer being written. */
  busy: boolean;
  /** Stop is offered (a streaming turn is running). */
  canStop: boolean;
  /** The saved conversation this transcript belongs to (Workspace). */
  conversationId: string | null;
  /** Workspace persistence is on for this engine. */
  persist: boolean;

  draft: string;
  setDraft: (value: string) => void;
  /**
   * Per-turn model override chosen by the analyst; `null` = the configured default.
   * Never adopted from a saved conversation (see the hydration effect).
   */
  model: string | null;
  setModel: (model: string | null) => void;
  /**
   * Source scope chosen by the analyst; `null` = all sources (the log tools fan out).
   * Never adopted from a saved conversation (see the hydration effect).
   */
  sourceId: string | null;
  setSourceId: (sourceId: string | null) => void;
  /** Composer @-scopes (empty = everything granted). */
  scopes: ChatScope[];
  setScopes: (scopes: ChatScope[]) => void;
  /** Composer time chip; `null` = the tool default (24 h). */
  timeRange: ChatTimeRange | null;
  setTimeRange: (range: ChatTimeRange | null) => void;
  /**
   * What the server will replay of the history this engine sends with the next turn.
   * Only meaningful when the engine owns its history (case chat); a Workspace thread's
   * history is the server's stored one (`/chat/context.history_tokens`).
   */
  historySize: ChatHistorySize;

  /** The viewer's preference. */
  streamMode: ChatStreamMode;
  /** What the next turn will request (text only when the model can stream). */
  effectiveStreamMode: ChatStreamMode;
  setStreamMode: (mode: ChatStreamMode) => void;

  /** The most recent user-authored prompt, exact (↑ in an empty composer edits it). */
  lastUserPrompt: string | null;

  /** Send `text` (default: the draft). Returns false when nothing was sent. */
  send: (text?: string, options?: ChatSendOptions) => boolean;
  /**
   * Stop the running streamed turn (server-side cancel; a second call, or `force`,
   * abandons the stream locally). A no-op for a blocking `/chat` turn.
   */
  stop: (options?: { force?: boolean }) => void;
  /** Retry a failed / unsaved turn with its SAME key (else asks again). */
  retry: (itemKey: string) => boolean;
  /** Ask the question behind an answer again with a NEW key. */
  askAgain: (itemKey: string) => boolean;
  /** Continue an answer that hit its cap (`origin: continue`, `continue_of`). */
  continueAnswer: (itemKey: string) => boolean;
  /** Start a fresh local transcript (New chat). Never stops a server turn. */
  reset: () => void;
  /**
   * Older saved messages of the open Workspace conversation (Round 12 paging, "Show
   * earlier messages"): restored like the rest and placed above the transcript, oldest
   * first; messages already shown are skipped. Returns how many messages were added (0
   * when `conversationId` is not the open conversation). Model history is unchanged: a
   * saved conversation's replay is the server's stored transcript.
   */
  prependRestored: (conversationId: string, messages: readonly ChatConversationMessage[]) => number;
}

/** The view's hold on one run. */
interface Attachment {
  run: TurnRun;
  release: () => void;
  unsubscribe: () => void;
}

export function useChatEngine(options: UseChatEngineOptions = {}): ChatEngine {
  const {
    caseId = null,
    conversation,
    draft: controlledDraft,
    blocked = false,
    textStreamingAvailable = true,
    orgDefaultStreamMode = null,
    transport = 'stream',
  } = options;
  const persist = !caseId && (options.persist ?? true);
  // Case sessions belong to one Demo identity (demo case ids repeat across a reset). The
  // switch token changes only on a confirmed switch: a failed status poll keeps them.
  const demoIdentity = useChatDemoIdentity();
  noteCaseSessionsDemoIdentity(demoIdentity);

  const [items, setItems] = React.useState<ChatTranscriptItem[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [conversationId, setConversationId] = React.useState<string | null>(conversation?.id ?? null);
  const [localDraft, setLocalDraft] = React.useState('');
  const [model, setModel] = React.useState<string | null>(null);
  const [sourceId, setSourceId] = React.useState<string | null>(null);
  const [scopes, setScopesState] = React.useState<ChatScope[]>([]);
  const [timeRange, setTimeRange] = React.useState<ChatTimeRange | null>(null);
  const [historySize, setHistorySize] = React.useState<ChatHistorySize>(EMPTY_HISTORY_SIZE);
  /** The activity scope on screen (`conv:` / `draft:` / `case:`), registered as viewed. */
  const [viewScope, setViewScope] = React.useState<string | null>(null);
  const streamPref = useChatStreamMode(orgDefaultStreamMode);
  const effectiveStreamMode: ChatStreamMode =
    streamPref.mode === 'text' && textStreamingAvailable ? 'text' : 'steps';

  // Refs mirror state so callbacks stay stable and never act on a stale render.
  const historyRef = React.useRef<HistoryEntry[]>([]);
  const itemsRef = React.useRef<ChatTranscriptItem[]>([]);
  const attachedRef = React.useRef<Attachment | null>(null);
  const busyRef = React.useRef(false);
  const conversationIdRef = React.useRef<string | null>(conversation?.id ?? null);
  const streamSupportedRef = React.useRef(transport === 'stream');
  const callbacksRef = React.useRef(options);
  callbacksRef.current = options;
  const settingsRef = React.useRef({ model, sourceId, scopes, timeRange, effectiveStreamMode, persist, caseId, blocked });
  settingsRef.current = { model, sourceId, scopes, timeRange, effectiveStreamMode, persist, caseId, blocked };

  const draft = controlledDraft ?? localDraft;
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

  React.useEffect(() => {
    streamSupportedRef.current = transport === 'stream';
  }, [transport]);

  // The org's brand-ring switch, as `/chat/context` reports it (SPEC D13).
  const animatedBrand = options.turnBounds?.animated_brand;
  React.useEffect(() => {
    if (typeof animatedBrand === 'boolean') setAnimatedBrand(animatedBrand);
  }, [animatedBrand]);

  /** A case chat keeps its transcript for the session (memory only; SPEC D13, G5). */
  const saveCaseSession = React.useCallback(() => {
    const id = settingsRef.current.caseId;
    if (id) writeCaseSession(id, { items: sessionItems(itemsRef.current), history: historyRef.current });
  }, []);

  // The ref is the authoritative transcript: updates are computed synchronously from
  // it (never inside a lazy state updater, which StrictMode may run twice) and React
  // state mirrors it for rendering.
  const commitItems = React.useCallback(
    (update: (prev: ChatTranscriptItem[]) => ChatTranscriptItem[], save = true) => {
      const next = update(itemsRef.current);
      if (next === itemsRef.current) return;
      itemsRef.current = next;
      setItems(next);
      if (save) saveCaseSession();
    },
    [saveCaseSession],
  );

  /** Model history is only ever replaced through here, so its size stays in step. */
  const writeHistory = React.useCallback(
    (next: HistoryEntry[], save = true) => {
      historyRef.current = next;
      const size = replayHistorySize(next.map((entry) => entry.turn));
      setHistorySize((prev) => (prev.exchanges === size.exchanges && prev.chars === size.chars ? prev : size));
      if (save) saveCaseSession();
    },
    [saveCaseSession],
  );

  const setBusyState = React.useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  const controlledRef = React.useRef(controlledDraft !== undefined);
  controlledRef.current = controlledDraft !== undefined;
  const setDraft = React.useCallback((value: string) => {
    draftRef.current = value;
    if (!controlledRef.current) setLocalDraft(value);
    callbacksRef.current.onDraftChange?.(value);
  }, []);

  const setScopes = React.useCallback((next: ChatScope[]) => {
    const out: ChatScope[] = [];
    for (const scope of next) {
      if ((CHAT_SCOPES as readonly string[]).includes(scope) && !out.includes(scope)) out.push(scope);
    }
    setScopesState(out);
  }, []);

  /** The scope on screen: the attached run's, else this case / thread. */
  const refreshViewScope = React.useCallback(() => {
    const run = attachedRef.current?.run;
    const id = settingsRef.current.caseId;
    setViewScope(run ? run.scope : id ? `case:${id}` : conversationIdRef.current ? `conv:${conversationIdRef.current}` : null);
  }, []);

  React.useEffect(() => (viewScope ? viewChatActivity(viewScope) : undefined), [viewScope]);

  // A case chat lists every answer this tab holds for the case, not only its newest:
  // each one's turn is seen, so the analyst's other consoles drop exactly those marks
  // and never another turn's (SPEC §7.2 decision 17). Told once per turn (the observer
  // dedupes), and only while the tab is visible.
  React.useEffect(() => {
    if (!viewScope?.startsWith('case:') || typeof document === 'undefined') return undefined;
    const turnIds = items.map((item) => (item.kind === 'assistant' && item.status !== 'running' ? (item.response?.turn_id ?? null) : null));
    const tell = () => {
      if (document.visibilityState !== 'hidden') showChatTurns(turnIds);
    };
    tell();
    document.addEventListener('visibilitychange', tell);
    return () => document.removeEventListener('visibilitychange', tell);
  }, [items, viewScope]);

  /** Stop viewing the attached run. The turn goes on (a disconnect is not a Stop). */
  const detach = React.useCallback(() => {
    const current = attachedRef.current;
    attachedRef.current = null;
    if (current) {
      current.unsubscribe();
      current.release();
    }
    setBusyState(false);
  }, [setBusyState]);

  /* ---------------------------------------------------------------- settle -- */

  /**
   * A turn persisted into `id`, or started there (`turn.start` named it; a draft
   * whose first turn is force-stopped or loses its connection still joins its saved
   * thread). The server title is unknown there: a new thread is titled from its first
   * prompt (as the server does); an existing one keeps its title ('').
   */
  const adoptConversation = React.useCallback((id: string, title: string, rehydrate: boolean) => {
    conversationIdRef.current = id;
    setConversationId(id);
    const persisted = callbacksRef.current.onConversationPersisted;
    if (rehydrate) persisted?.(id, title, { rehydrate: true });
    else persisted?.(id, title);
  }, []);

  const adoptStartedConversation = React.useCallback(
    (run: TurnRun) => {
      const id = run.conversationId;
      if (!id || !run.persisted || !settingsRef.current.persist) return;
      adoptConversation(id, conversationIdRef.current === id ? '' : run.request?.message ?? '', false);
    },
    [adoptConversation],
  );

  /** Apply a settled run to this transcript, once. */
  const applySettled = React.useCallback(
    (run: TurnRun) => {
      consumeRun(run);
      if (run.streamUnsupported) streamSupportedRef.current = false;
      if (run.state === 'lost') {
        // The turn could not be followed (a reload long after it ended): show what
        // the server saved instead.
        commitItems((prev) => prev.filter((item) => item.key !== run.assistantKey));
        const id = run.conversationId;
        if (id && run.kind === 'workspace') adoptConversation(id, '', true);
        return;
      }
      const settled = runAssistantItem(run);
      const user = settledUserItem(run);
      commitItems((prev) =>
        prev.map((item) => {
          // The saved question's id (Round 12 WP-FIX1): a hit or link to it finds it here.
          if (item.kind === 'user' && user && item.requestKey === run.requestKey) {
            return { ...item, failed: user.failed, messageId: item.messageId ?? user.messageId };
          }
          return item.key === run.assistantKey ? { ...settled, at: item.at } : item;
        }),
      );
      if (run.state === 'done') {
        const response = run.response;
        if (response && !isUnsavedTurn(response)) {
          // Keyed by the request: a same-key retry ("Run again to save") replaces this
          // exchange instead of sending it to the model twice.
          writeHistory([...historyRef.current.filter((entry) => entry.requestKey !== run.requestKey), ...runExchange(run)]);
          // An answer delivered with a `not_saved` notice and no message id was never
          // stored: `turn.start` may have named a conversation that was never created
          // (a new thread), and adopting it would make the next turn 404.
          const neverSaved = response.notice?.kind === 'not_saved' && !response.message_id;
          const savedId =
            settingsRef.current.persist && !neverSaved ? response.conversation_id || (run.persisted ? run.conversationId : null) : null;
          if (savedId) {
            // Without a server title, only a NEW thread is titled from its prompt. A
            // turn followed after a reload reloads the thread for its saved prompt.
            const fallback = conversationIdRef.current === savedId ? '' : run.request?.message ?? '';
            adoptConversation(savedId, response.conversation_title?.trim() || fallback, !run.request);
          }
        }
      } else if (run.state === 'stopped' || run.failure?.kind !== 'turn_error') {
        // A stop or a lost connection after `turn.start` may have been saved
        // server-side; a `turn.error` saved nothing.
        adoptStartedConversation(run);
      }
      callbacksRef.current.onTurnSettled?.(settled);
    },
    [adoptConversation, adoptStartedConversation, commitItems, writeHistory],
  );

  const onRunChange = React.useCallback(
    (run: TurnRun) => {
      if (attachedRef.current?.run !== run) return;
      if (run.state === 'running') {
        commitItems((prev) =>
          prev.map((item) => (item.kind === 'assistant' && item.key === run.assistantKey && item.live !== run.live ? { ...item, live: run.live } : item)),
        );
        // A new thread's run became `conv:<id>`.
        refreshViewScope();
        return;
      }
      applySettled(run);
      detach();
      refreshViewScope();
    },
    [applySettled, commitItems, detach, refreshViewScope],
  );

  const attach = React.useCallback(
    (run: TurnRun) => {
      detach();
      const release = attachRun(run);
      const unsubscribe = subscribeRun(run, () => onRunChange(run));
      attachedRef.current = { run, release, unsubscribe };
      setBusyState(run.state === 'running');
      refreshViewScope();
      onRunChange(run);
    },
    [detach, onRunChange, refreshViewScope, setBusyState],
  );

  /**
   * Show `run` in this transcript: a running turn joins it live (its prompt and run
   * log, with Stop); one that settled while nobody watched is applied once, unless the
   * restored history already holds it (the saved answer is the truth).
   */
  const adopt = React.useCallback(
    (run: TurnRun) => {
      if (run.state === 'running') {
        commitItems((prev) => [
          ...prev.filter((item) => item.key !== run.assistantKey && (!run.requestKey || item.requestKey !== run.requestKey)),
          ...(run.userItem ? [run.userItem] : []),
          runAssistantItem(run),
        ]);
        attach(run);
        return;
      }
      if (run.consumed) return;
      consumeRun(run);
      const known = !!run.requestKey && itemsRef.current.some((item) => item.requestKey === run.requestKey);
      if (known || run.state === 'lost') return;
      const user = settledUserItem(run);
      commitItems((prev) => [...prev, ...(user ? [user] : []), runAssistantItem(run)]);
      const exchange = runExchange(run);
      if (exchange.length) writeHistory([...historyRef.current, ...exchange]);
    },
    [attach, commitItems, writeHistory],
  );

  /** Re-attach a turn another tab or the server reports for `scope` (after a reload). */
  const adoptReported = React.useCallback(
    (scope: string, kind: 'workspace' | 'case') => {
      const local = findRun(scope);
      // A case turn of another Demo identity (the same case id before a reset) is not
      // this case's: it is never followed here.
      if (local && isCaseRunOfAnotherDemo(local)) return;
      if (local) {
        adopt(local);
        return;
      }
      const entry = getChatActivity().entries.find((item) => item.scope === scope);
      if (!entry || entry.status !== 'running' || !entry.turnId || entry.source === 'local') return;
      const run = reattachRun({
        scope,
        kind,
        turnId: entry.turnId,
        conversationId: entry.conversationId,
        caseId: entry.caseId,
        title: entry.title,
        startedAt: entry.startedAt,
      });
      if (run) adopt(run);
    },
    [adopt],
  );

  /**
   * Drop the transcript and stop viewing any turn, and start the composer on the
   * defaults (New chat, another case). The ONE fresh-draft reset: a New chat entered
   * from a draft saved this session (the host's `conversation` stays `null`, so only
   * `resetKey` moves) must match one entered from a reopened thread (SPEC A36).
   */
  const resetTranscript = React.useCallback(() => {
    detach();
    writeHistory([], false);
    conversationIdRef.current = null;
    setConversationId(null);
    commitItems(() => [], false);
    setModel(null);
    setSourceId(null);
    setScopesState([]);
    setTimeRange(null);
    refreshViewScope();
  }, [commitItems, detach, refreshViewScope, writeHistory]);

  // A deliberate New-chat transition from the host (see `resetKey`).
  const resetKeyRef = React.useRef(options.resetKey);
  React.useEffect(() => {
    if (Object.is(resetKeyRef.current, options.resetKey)) return;
    resetKeyRef.current = options.resetKey;
    resetTranscript();
  }, [options.resetKey, resetTranscript]);

  // Case chat: restore this case's session transcript (tab switches and re-opens keep
  // it), and follow a turn still running for it. A reused host that changes case never
  // shows case A's transcript or turn under case B, nor, after entering, leaving or
  // resetting Demo, the transcript of the same case id under the previous identity
  // (PR #132 review: the switch dropped the sessions, so this starts the case clean).
  React.useEffect(() => {
    if (!caseId) return;
    const session = readCaseSession(caseId);
    resetTranscript();
    if (session) {
      writeHistory(session.history, false);
      commitItems(() => session.items, false);
    }
    adoptReported(`case:${caseId}`, 'case');
    refreshViewScope();
  }, [adoptReported, caseId, commitItems, demoIdentity, refreshViewScope, resetTranscript, writeHistory]);

  // Hydrate from the host's saved conversation. Identity-keyed: the host keeps the
  // same object while a just-persisted thread stays live, so no re-hydration flash.
  React.useEffect(() => {
    if (conversation === undefined) return;
    if (conversation === null) {
      resetTranscript();
      return;
    }
    detach();
    const restored = itemsFromConversation(conversation);
    writeHistory(
      (conversation.messages ?? []).map(({ role, content, idempotency_key, origin }) => ({
        turn: role === 'user' ? { role, content, origin: origin ?? 'user' } : { role, content },
        requestKey: idempotency_key ?? null,
      })),
    );
    conversationIdRef.current = conversation.id;
    setConversationId(conversation.id);
    commitItems(() => restored);
    // The stored `model` and `source_id` are what the server RESOLVED for the last turn
    // (the effective model, normally the default, and the primary source it searched
    // even when the analyst chose none), not the analyst's selection. Adopting them
    // would show the default as a removable "non-default" chip, pin the scope to one
    // source, and send both explicitly on the next turn (a later default change then
    // 403s a caller without models:read; a disabled source 422s). A reopened thread
    // therefore starts on the default model and "All sources"; each restored answer
    // still names the model and source it used.
    setModel(null);
    setSourceId(null);
    setScopesState([]);
    setTimeRange(conversation.time_range ?? null);
    // A turn still running in this thread (this tab's, another tab's or one the server
    // reports after a reload) joins the transcript live.
    adoptReported(`conv:${conversation.id}`, 'workspace');
    refreshViewScope();
  }, [conversation, adoptReported, commitItems, detach, refreshViewScope, resetTranscript, writeHistory]);

  // A turn another tab or the server reports for the scope on screen joins it live, also
  // when that report lands after the thread restored (a reload: `GET /chat/turns/active`
  // and the thread load race; the runner then follows it as this tab's own, parked run).
  const reportedTurn = useChatActivity((snapshot) => {
    const entry = viewScope ? snapshot.entries.find((item) => item.scope === viewScope) : undefined;
    return entry?.status === 'running' ? entry.turnId : null;
  });
  React.useEffect(() => {
    if (!reportedTurn || !viewScope || attachedRef.current) return;
    adoptReported(viewScope, viewScope.startsWith('case:') ? 'case' : 'workspace');
  }, [adoptReported, reportedTurn, viewScope]);

  React.useEffect(() => {
    callbacksRef.current.onBusyChange?.(busy);
  }, [busy]);

  React.useEffect(
    () => () => {
      // Unmount: stop viewing (a disconnect is not a Stop; the turn goes on, the
      // navigation glyph shows it, and returning re-attaches) and release the host's
      // busy guard.
      const current = attachedRef.current;
      attachedRef.current = null;
      if (current) {
        current.unsubscribe();
        current.release();
      }
      busyRef.current = false;
      callbacksRef.current.onBusyChange?.(false);
    },
    [],
  );

  /* ------------------------------------------------------------------ turn -- */

  /** Start one turn for `request`, optionally replacing a failed pair (same key). */
  const startTurn = React.useCallback(
    (request: ChatRequest, origin: ChatOrigin, replaceRequestKey: string | null): boolean => {
      if (busyRef.current) return false;
      const s = settingsRef.current;
      const requestKey = request.idempotency_key ?? newIdempotencyKey();
      const scope = s.caseId
        ? `case:${s.caseId}`
        : conversationIdRef.current
          ? `conv:${conversationIdRef.current}`
          : `draft:${requestKey}`;
      if (findRun(scope)?.state === 'running') return false;
      const run = startRun({
        scope,
        kind: s.caseId ? 'case' : 'workspace',
        caseId: s.caseId,
        request: { ...request, idempotency_key: requestKey },
        origin,
        transport: streamSupportedRef.current ? 'stream' : 'blocking',
        streamMode: s.effectiveStreamMode,
      });
      commitItems((prev) => [
        ...prev.filter((item) => !replaceRequestKey || item.requestKey !== replaceRequestKey),
        ...(run.userItem ? [run.userItem] : []),
        runAssistantItem(run),
      ]);
      // The replaced pair leaves model history with the transcript (a retried
      // `not_saved` answer had entered it); its retry settles back in as one exchange.
      if (replaceRequestKey && historyRef.current.some((entry) => entry.requestKey === replaceRequestKey)) {
        writeHistory(historyRef.current.filter((entry) => entry.requestKey !== replaceRequestKey));
      }
      attach(run);
      return true;
    },
    [attach, commitItems, writeHistory],
  );

  const buildRequest = React.useCallback((message: string, origin: ChatOrigin, continueOf: string | null, topic: string | null): ChatRequest => {
    const s = settingsRef.current;
    const body: ChatRequest = {
      message,
      // Only earlier successful exchanges; the current message is sent separately.
      history: boundHistory(historyRef.current.map((entry) => entry.turn)),
    };
    if (s.caseId) body.case_id = s.caseId;
    if (s.model) body.model = s.model;
    if (s.sourceId) body.source_id = s.sourceId;
    if (s.persist) {
      body.persist_conversation = true;
      if (conversationIdRef.current) body.conversation_id = conversationIdRef.current;
    }
    body.idempotency_key = newIdempotencyKey();
    if (s.scopes.length) body.scopes = [...s.scopes];
    if (s.timeRange) body.time_range = { ...s.timeRange };
    if (origin !== 'user') body.origin = origin;
    if (continueOf) body.continue_of = continueOf;
    if (topic && REQUEST_TOPIC_RE.test(topic)) body.topic = topic;
    return body;
  }, []);

  const send = React.useCallback(
    (text?: string, sendOptions: ChatSendOptions = {}): boolean => {
      const fromDraft = text === undefined;
      const message = (fromDraft ? draftRef.current : text).trim();
      if (!message || busyRef.current || settingsRef.current.blocked) return false;
      const origin = sendOptions.origin ?? 'user';
      const request = buildRequest(message, origin, sendOptions.continueOf ?? null, sendOptions.topic ?? null);
      const started = startTurn(request, origin, null);
      // Only the composer's own text is consumed; a chip never wipes a typed draft.
      if (started && fromDraft) setDraft('');
      return started;
    },
    [buildRequest, setDraft, startTurn],
  );

  const askAgain = React.useCallback(
    (itemKey: string): boolean => {
      if (busyRef.current || settingsRef.current.blocked) return false;
      const list = itemsRef.current;
      const index = list.findIndex((entry) => entry.key === itemKey);
      if (index < 0) return false;
      const target = list[index];
      for (let i = index - 1; i >= 0; i -= 1) {
        const entry = list[i];
        if (entry.kind !== 'user') continue;
        // The exact prompt, not its display form (see ChatUserItem.prompt), with the
        // hints that shaped the original request: an "Ask about this" topic (SPEC A28)
        // and the answer a Continue turn resumes. Only the key is new.
        const request = target.kind === 'assistant' ? target.request : null;
        let continueOf = request?.continue_of ?? null;
        if (!continueOf && entry.origin === 'continue') continueOf = continuedAnswerId(list, i);
        return send(entry.prompt, { origin: entry.origin, topic: request?.topic ?? null, continueOf });
      }
      return false;
    },
    [send],
  );

  const retry = React.useCallback(
    (itemKey: string): boolean => {
      if (busyRef.current || settingsRef.current.blocked) return false;
      const item = findItem(itemsRef.current, itemKey);
      if (!item) return false;
      if (retriesWithSameKey(item) && item.request) {
        // Retry same request: the exact body and key; the failed pair is replaced.
        const { stream_mode: _mode, ...request } = item.request;
        void _mode;
        const origin = itemsRef.current.find(
          (entry): entry is ChatUserItem => entry.kind === 'user' && entry.requestKey === item.requestKey,
        )?.origin;
        return startTurn(request, origin ?? request.origin ?? 'user', item.requestKey);
      }
      return askAgain(itemKey);
    },
    [askAgain, startTurn],
  );

  const continueAnswer = React.useCallback(
    (itemKey: string): boolean => {
      const item = findItem(itemsRef.current, itemKey);
      if (!item || item.status !== 'done' || !item.response) return false;
      const continueOf = item.messageId ?? item.response.message_id ?? null;
      return send(CONTINUE_PROMPT, { origin: 'continue', continueOf });
    },
    [send],
  );

  const stop = React.useCallback((stopOptions: { force?: boolean } = {}) => {
    // A blocking `/chat` turn cannot be stopped (`canStop` is false): aborting the
    // fetch would only hide an answer the server still bills and saves.
    const run = attachedRef.current?.run;
    if (run) stopRun(run, stopOptions.force === true);
  }, []);

  const prependRestored = React.useCallback(
    (id: string, messages: readonly ChatConversationMessage[]): number => {
      if (!id || conversationIdRef.current !== id || !messages.length) return 0;
      const known = new Set(itemsRef.current.map((item) => item.key));
      const older = itemsFromMessages(messages).filter((item) => !known.has(item.key));
      if (!older.length) return 0;
      commitItems((prev) => [...older, ...prev]);
      return older.length;
    },
    [commitItems],
  );

  const running = React.useMemo(
    () => items.find((item): item is ChatAssistantItem => item.kind === 'assistant' && item.status === 'running') ?? null,
    [items],
  );
  const lastUserPrompt = React.useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.kind === 'user' && item.origin === 'user') return item.prompt;
    }
    return null;
  }, [items]);

  return {
    items,
    running,
    busy,
    canStop: busy && running?.live?.transport === 'stream',
    conversationId,
    persist,
    draft,
    setDraft,
    model,
    setModel,
    sourceId,
    setSourceId,
    scopes,
    setScopes,
    timeRange,
    setTimeRange,
    historySize,
    streamMode: streamPref.mode,
    effectiveStreamMode,
    setStreamMode: streamPref.setMode,
    lastUserPrompt,
    send,
    stop,
    retry,
    askAgain,
    continueAnswer,
    reset: resetTranscript,
    prependRestored,
  };
}
