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
 *  - a generation counter drops anything that lands after New chat / a thread switch;
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
 *  - a stream that ends without `turn.done` / `turn.error` is "Connection lost —
 *    checking whether the answer was saved": a persisted turn is replayed ONCE with the
 *    same key (a 409 `chat_request_in_progress` is waited out for as long as the turn's
 *    own limits allow, see {@link recoveryWindowMs});
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

import { api, ApiError } from '@/lib/api';
import type {
  ChatContextBounds,
  ChatConversation,
  ChatOrigin,
  ChatRequest,
  ChatResponse,
  ChatScope,
  ChatStep,
  ChatStepStatus,
  ChatStreamMode,
  ChatTimeRange,
  ChatTurn,
  TurnNotice,
  TurnUsage,
} from '@/lib/types';
import {
  DEFAULT_CHAT_BOUNDS,
  apiErrorCode,
  apiRetryAfterSeconds,
  cancelChatTurn,
  isStreamUnsupportedError,
  postChat,
  streamChat,
} from './chat-api';
import type { ChatStreamOutcome } from './ndjson';
import {
  CHAT_SCOPES,
  CHAT_STREAM_MODES,
  displayText,
  type ChatStreamEvent,
  type StepStartInfo,
  type TurnErrorEvent,
} from './stream-events';
import { REQUEST_TOPIC_RE } from './topic';

/* -------------------------------------------------------------------------- */
/* Constants.                                                                  */
/* -------------------------------------------------------------------------- */

/** Client history sent with a request: the last 12 exchanges (SPEC §4.3). */
export const CHAT_HISTORY_EXCHANGES = 12;
/** The message a Continue chip sends (`origin: continue`, `continue_of`). */
export const CONTINUE_PROMPT = 'Continue where the previous answer stopped.';
/** localStorage mirror of the viewer's live mode (first paint only). */
export const STREAM_MODE_STORAGE_KEY = 'soc.chat.streamMode';
/** Notice kinds that mean "the first model call never ran" (D1, SPEC §4.5). */
const UNSAVED_NOTICE_KINDS = new Set(['budget', 'breaker', 'provider']);
/** Re-check cadence while a lost turn still runs server-side (409 in progress). */
const RECOVERY_BACKOFF_MS = [1500, 3000, 5000, 8000];
/** Bounds on one re-check delay, whatever the server hints. */
const RECOVERY_MIN_DELAY_MS = 250;
const RECOVERY_MAX_DELAY_MS = 15_000;
/** Slack past the turn's own limits before recovery gives up (the save, clock skew). */
const RECOVERY_SLACK_MS = 5_000;

/** The turn limits recovery waits out (`/chat/context.bounds`). */
export type ChatTurnBounds = Pick<ChatContextBounds, 'turn_timeout_s' | 'model_step_timeout_s'>;

const positiveSeconds = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * How long after a turn started its saved answer may still appear: the turn timeout
 * plus one model call already in flight when it fired (SPEC §4.2), plus slack. A lost
 * stream is checked for its saved answer until then, never for a fixed retry count.
 */
export function recoveryWindowMs(bounds?: Partial<ChatTurnBounds> | null): number {
  const turn = positiveSeconds(bounds?.turn_timeout_s, DEFAULT_CHAT_BOUNDS.turn_timeout_s);
  const step = positiveSeconds(bounds?.model_step_timeout_s, DEFAULT_CHAT_BOUNDS.model_step_timeout_s);
  return (turn + step) * 1000 + RECOVERY_SLACK_MS;
}

/**
 * The delay before re-check `attempt` (0-based): the server's hint when it sent one,
 * else a backoff that settles at its last step; always within 0.25–15 s.
 */
export function recoveryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  const ms =
    retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : RECOVERY_BACKOFF_MS[Math.min(Math.max(0, attempt), RECOVERY_BACKOFF_MS.length - 1)];
  return Math.min(RECOVERY_MAX_DELAY_MS, Math.max(RECOVERY_MIN_DELAY_MS, ms));
}

/* -------------------------------------------------------------------------- */
/* Transcript model.                                                           */
/* -------------------------------------------------------------------------- */

export interface ChatUserItem {
  kind: 'user';
  /** Stable React key (the persisted message id when restored). */
  key: string;
  /** Persisted message id, when known (restored turns). */
  messageId: string | null;
  /** The prompt as DISPLAY text (invisible, bidi and control characters stripped). */
  content: string;
  /**
   * The exact prompt as sent / stored. Ask again and ↑-edit reuse it, so a lookalike
   * character the server shows the model as a visible escape (SPEC §7.6) survives.
   * Never render it directly; render `content`.
   */
  prompt: string;
  origin: ChatOrigin;
  /** ms epoch. */
  at: number;
  /** Idempotency key linking this prompt to its answer / error. */
  requestKey: string | null;
  /** The prompt did not produce a saved exchange: shown, but excluded from history. */
  failed: boolean;
}

/** One run-log row while the turn is running. */
export interface ChatLiveStep extends StepStartInfo {
  status: 'running' | ChatStepStatus;
  /** The final step from `step.end` (the truth once present). */
  result: ChatStep | null;
  /** ms epoch when the step started (client clock; display only). */
  startedAt: number;
}

/** The running turn's live state (cleared when `turn.done` lands). */
export interface ChatLiveTurn {
  transport: 'stream' | 'blocking';
  turnId: string | null;
  model: string | null;
  streamMode: ChatStreamMode;
  /** A completed-key replay: `turn.done` follows without a model call. */
  replayed: boolean;
  /** `turn.start.estimate.prompt_tokens`. */
  estimatePromptTokens: number;
  steps: ChatLiveStep[];
  /** Running totals from the latest `usage` event. */
  usage: TurnUsage | null;
  /** Streamed answer text so far (Live text mode). */
  text: string;
  /** Stop was requested; the server is finishing the in-flight call. */
  stopping: boolean;
  /** `recovering`: the stream dropped and the engine is checking for the saved answer. */
  connection: 'open' | 'recovering';
  startedAt: number;
}

export type ChatFailureKind = 'http' | 'turn_error' | 'connection_lost' | 'network' | 'unreadable';

/** Why a turn produced no response. */
export interface ChatTurnFailure {
  kind: ChatFailureKind;
  message: string;
  /** `turn.error.code` or the HTTP `detail.code`. */
  code: string | null;
  /** HTTP status (0 = unreachable), when the failure was HTTP. */
  status: number | null;
  /** Offer "Retry same request". */
  retryable: boolean;
  notice: TurnNotice | null;
}

export interface ChatAssistantItem {
  kind: 'assistant';
  key: string;
  /** Persisted assistant message id (reports reference it). */
  messageId: string | null;
  at: number;
  requestKey: string | null;
  status: 'running' | 'done' | 'error';
  /** The truth once done: the normalised `turn.done` / `/chat` / saved response. */
  response: ChatResponse | null;
  /** Live state while running. */
  live: ChatLiveTurn | null;
  failure: ChatTurnFailure | null;
  /** Restored from saved history: render collapsed, no live state. */
  restored: boolean;
  /** Effective provenance (never inferred from the current selectors). */
  model: string | null;
  source: string | null;
  /** The exact request body (Retry same request resends it verbatim). */
  request: ChatRequest | null;
}

export type ChatTranscriptItem = ChatUserItem | ChatAssistantItem;

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported for tests and hosts).                                */
/* -------------------------------------------------------------------------- */

/** A client idempotency key (`^[A-Za-z0-9._:-]{8,128}$`). */
export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `chat-${globalThis.crypto.randomUUID()}`;
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * D1 (SPEC §4.5): the first model call failed, nothing was billed or saved. Such a
 * turn shows its notice but never enters history, and Retry reuses its key.
 */
export function isUnsavedTurn(response: ChatResponse): boolean {
  const notice = response.notice;
  if (!notice || !UNSAVED_NOTICE_KINDS.has(notice.kind)) return false;
  return !response.message_id && (!response.usage || response.usage.calls === 0);
}

/** The last {@link CHAT_HISTORY_EXCHANGES} exchanges (oldest dropped first). */
export function boundHistory(history: readonly ChatTurn[]): ChatTurn[] {
  const max = CHAT_HISTORY_EXCHANGES * 2;
  return history.length > max ? history.slice(history.length - max) : [...history];
}

function failureFromError(error: unknown, fallback: string): ChatTurnFailure {
  if (error instanceof ApiError) {
    const status = error.status;
    const code = apiErrorCode(error);
    return {
      kind: status === 0 ? 'network' : 'http',
      message: error.message || fallback,
      code,
      status,
      // Busy, in-progress, rate-limited, unavailable and unreachable are transient. An
      // idempotency conflict is not: the same key fails the same way every time, so the
      // host offers Ask again (a new key) instead of Retry same request.
      retryable:
        code !== 'chat_idempotency_conflict' &&
        (status === 0 || status === 409 || status === 429 || status === 502 || status === 503 || status === 504),
      notice: null,
    };
  }
  return {
    kind: 'network',
    message: error instanceof Error && error.message ? error.message : fallback,
    code: null,
    status: null,
    retryable: true,
    notice: null,
  };
}

function failureFromTurnError(event: TurnErrorEvent): ChatTurnFailure {
  return {
    kind: 'turn_error',
    message: event.message || event.notice?.message || 'The assistant could not answer.',
    code: event.code,
    status: null,
    retryable: event.retryable,
    notice: event.notice,
  };
}

/**
 * What a turn looks like once Stop abandoned its stream locally. It is a local view,
 * not the server's record (which may differ, or not exist yet): no `message_id`, and
 * it never enters model history.
 */
function stoppedResponse(live: ChatLiveTurn | null): ChatResponse {
  const usage = live?.usage ?? null;
  return {
    answer: live?.text ?? '',
    cost: usage?.cost ?? 0,
    blocks: [],
    steps: (live?.steps ?? []).flatMap((step) => (step.result ? [step.result] : [])),
    usage,
    citations: [],
    console_links: [],
    follow_ups: [],
    answer_kind: 'conversation',
    notice: { kind: 'cancelled', message: 'Stopped before the answer finished.', retryable: false },
    stream_mode: live?.streamMode ?? null,
    turn_id: live?.turnId ?? null,
    message_id: null,
  };
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
  const items: ChatTranscriptItem[] = [];
  for (const message of conversation.messages ?? []) {
    if (message.role === 'user') {
      items.push({
        kind: 'user',
        key: message.id,
        messageId: message.id,
        content: displayText(message.content, 0, { multiline: true }),
        prompt: message.content,
        origin: 'user',
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
   * `reset()` does. Wire `useChatConversations().newDraftEpoch` here.
   */
  resetKey?: string | number | null;
  /** `/chat/context.text_streaming.available`; `false` forces Live steps. */
  textStreamingAvailable?: boolean;
  /** `/chat/context.bounds.default_stream_mode` (the org default). */
  orgDefaultStreamMode?: ChatStreamMode | null;
  /**
   * `/chat/context.bounds` (or just its turn limits): how long recovery waits for a
   * lost turn's saved answer (see {@link recoveryWindowMs}). SPEC §4.2 defaults when
   * omitted.
   */
  turnBounds?: Partial<ChatTurnBounds> | null;
  /** `blocking` always uses `/api/chat` (no live steps, no Stop). Default `stream`. */
  transport?: 'stream' | 'blocking';
  /**
   * A persisted turn landed in conversation `id` (first or later turn). `title` is the
   * server's, the prompt for a new thread, or '' when unknown for an existing one.
   */
  onConversationPersisted?: (id: string, title: string) => void;
  /** A turn started or settled (the history rail defers refreshes while busy). */
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
  const notice = item.response.notice;
  return notice?.kind === 'not_saved' && notice.retryable === true;
}

export interface ChatEngine {
  items: ChatTranscriptItem[];
  /** The in-flight assistant item, if any. */
  running: ChatAssistantItem | null;
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
}

/** Book-keeping for the one in-flight turn. */
interface RunState {
  key: string;
  requestKey: string;
  generation: number;
  controller: AbortController;
  transport: 'stream' | 'blocking';
  turnId: string | null;
  stopRequested: boolean;
  cancelWhenStarted: boolean;
  forcedStop: boolean;
  /** The request asked for Workspace persistence. */
  persisted: boolean;
  /** The exact prompt (the rail's title fallback). */
  prompt: string;
  /** `turn.start.conversation_id`: where the server is saving this turn. */
  conversationId: string | null;
  /** ms epoch when the turn was sent (recovery's deadline is measured from here). */
  startedAt: number;
}

let itemCounter = 0;
const nextItemKey = (prefix: string) => {
  itemCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${itemCounter}`;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

type FrameHandle = { cancel: () => void };
function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(callback);
    return { cancel: () => window.cancelAnimationFrame(id) };
  }
  const id = setTimeout(callback, 16);
  return { cancel: () => clearTimeout(id) };
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

  const [items, setItems] = React.useState<ChatTranscriptItem[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [conversationId, setConversationId] = React.useState<string | null>(conversation?.id ?? null);
  const [localDraft, setLocalDraft] = React.useState('');
  const [model, setModel] = React.useState<string | null>(null);
  const [sourceId, setSourceId] = React.useState<string | null>(null);
  const [scopes, setScopesState] = React.useState<ChatScope[]>([]);
  const [timeRange, setTimeRange] = React.useState<ChatTimeRange | null>(null);
  const streamPref = useChatStreamMode(orgDefaultStreamMode);
  const effectiveStreamMode: ChatStreamMode =
    streamPref.mode === 'text' && textStreamingAvailable ? 'text' : 'steps';

  // Refs mirror state so callbacks stay stable and never act on a stale render.
  const generationRef = React.useRef(0);
  const historyRef = React.useRef<ChatTurn[]>([]);
  const itemsRef = React.useRef<ChatTranscriptItem[]>([]);
  const runRef = React.useRef<RunState | null>(null);
  const busyRef = React.useRef(false);
  const conversationIdRef = React.useRef<string | null>(conversation?.id ?? null);
  const streamSupportedRef = React.useRef(transport === 'stream');
  const liveTextRef = React.useRef('');
  const frameRef = React.useRef<FrameHandle | null>(null);
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

  // The ref is the authoritative transcript: updates are computed synchronously from
  // it (never inside a lazy state updater, which StrictMode may run twice) and React
  // state mirrors it for rendering.
  const commitItems = React.useCallback((update: (prev: ChatTranscriptItem[]) => ChatTranscriptItem[]) => {
    const next = update(itemsRef.current);
    if (next === itemsRef.current) return;
    itemsRef.current = next;
    setItems(next);
  }, []);

  const updateAssistant = React.useCallback(
    (key: string, update: (item: ChatAssistantItem) => ChatAssistantItem) => {
      commitItems((prev) => prev.map((item) => (item.kind === 'assistant' && item.key === key ? update(item) : item)));
    },
    [commitItems],
  );

  const updateLive = React.useCallback(
    (key: string, update: (live: ChatLiveTurn) => ChatLiveTurn) => {
      updateAssistant(key, (item) => (item.live ? { ...item, live: update(item.live) } : item));
    },
    [updateAssistant],
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

  const cancelFrame = React.useCallback(() => {
    frameRef.current?.cancel();
    frameRef.current = null;
  }, []);

  /** Drop the in-flight turn locally (reset / unmount / thread switch). */
  const abandonRun = React.useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    cancelFrame();
    run?.controller.abort();
  }, [cancelFrame]);

  /** Drop the transcript and any in-flight turn (New chat, another case). */
  const resetTranscript = React.useCallback(() => {
    generationRef.current += 1;
    abandonRun();
    historyRef.current = [];
    conversationIdRef.current = null;
    setConversationId(null);
    commitItems(() => []);
    setBusyState(false);
  }, [abandonRun, commitItems, setBusyState]);

  // A deliberate New-chat transition from the host (see `resetKey`).
  const resetKeyRef = React.useRef(options.resetKey);
  React.useEffect(() => {
    if (Object.is(resetKeyRef.current, options.resetKey)) return;
    resetKeyRef.current = options.resetKey;
    resetTranscript();
  }, [options.resetKey, resetTranscript]);

  // Another case in a reused host (a CaseDetail sheet that is not keyed per case):
  // case A's transcript and history must never be sent with case B's id, and a turn
  // still running for A must not settle into B's view.
  const caseIdRef = React.useRef(caseId);
  React.useEffect(() => {
    if (caseIdRef.current === caseId) return;
    caseIdRef.current = caseId;
    resetTranscript();
  }, [caseId, resetTranscript]);

  // Hydrate from the host's saved conversation. Identity-keyed: the host keeps the
  // same object while a just-persisted thread stays live, so no re-hydration flash.
  React.useEffect(() => {
    if (conversation === undefined) return;
    generationRef.current += 1;
    abandonRun();
    setBusyState(false);
    if (conversation === null) {
      historyRef.current = [];
      conversationIdRef.current = null;
      setConversationId(null);
      commitItems(() => []);
      setModel(null);
      setSourceId(null);
      setScopesState([]);
      setTimeRange(null);
      return;
    }
    const restored = itemsFromConversation(conversation);
    historyRef.current = (conversation.messages ?? []).map(({ role, content }) => ({ role, content }));
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
  }, [conversation, abandonRun, commitItems, setBusyState]);

  React.useEffect(() => {
    callbacksRef.current.onBusyChange?.(busy);
  }, [busy]);

  React.useEffect(
    () => () => {
      // Unmount: stop reading (a disconnect is not a Stop; the server turn completes
      // and persists) and release the host's busy guard.
      generationRef.current += 1;
      abandonRun();
      callbacksRef.current.onBusyChange?.(false);
    },
    [abandonRun],
  );

  /* ---------------------------------------------------------------- settle -- */

  const finishRun = React.useCallback(
    (run: RunState) => {
      if (runRef.current === run) runRef.current = null;
      cancelFrame();
      if (generationRef.current === run.generation) setBusyState(false);
    },
    [cancelFrame, setBusyState],
  );

  const settleDone = React.useCallback(
    (run: RunState, response: ChatResponse) => {
      if (generationRef.current !== run.generation) return;
      const unsaved = isUnsavedTurn(response);
      const current = findItem(itemsRef.current, run.key);
      const userContent = current?.request?.message ?? '';
      const settled: ChatAssistantItem | null = current
        ? {
            ...current,
            status: 'done',
            response,
            live: null,
            failure: null,
            messageId: response.message_id ?? null,
            model: response.effective_model?.trim() || current.request?.model || null,
            source:
              response.effective_source_name?.trim() ||
              response.effective_source_id?.trim() ||
              current.request?.source_id ||
              null,
          }
        : null;
      commitItems((prev) =>
        prev.map((item) => {
          if (item.kind === 'user' && item.requestKey === run.requestKey) return { ...item, failed: unsaved };
          return settled && item.key === run.key ? settled : item;
        }),
      );
      if (!unsaved) {
        historyRef.current = [
          ...historyRef.current,
          { role: 'user', content: userContent },
          { role: 'assistant', content: response.answer },
        ];
        // An answer delivered with a `not_saved` notice and no message id was never
        // stored: `turn.start` may have named a conversation that was never created (a
        // new thread), and adopting it would make the next turn 404. Nothing is promoted.
        const neverSaved = response.notice?.kind === 'not_saved' && !response.message_id;
        const savedId = settingsRef.current.persist && !neverSaved
          ? response.conversation_id || (run.persisted ? run.conversationId : null)
          : null;
        if (savedId) {
          // Without a server title, only a NEW thread is titled from its prompt.
          const fallbackTitle = conversationIdRef.current === savedId ? '' : userContent;
          conversationIdRef.current = savedId;
          setConversationId(savedId);
          callbacksRef.current.onConversationPersisted?.(savedId, response.conversation_title?.trim() || fallbackTitle);
        }
      }
      finishRun(run);
      if (settled) callbacksRef.current.onTurnSettled?.(settled);
    },
    [commitItems, finishRun],
  );

  /**
   * The turn settled without the server's `turn.done`, but `turn.start` named the
   * conversation the server is saving it into (a draft's first turn creates it). Join
   * that thread, so the next message continues it instead of starting a second one and
   * the rail shows the saved turn on its refresh.
   */
  const adoptStartedConversation = React.useCallback((run: RunState) => {
    const id = run.conversationId;
    if (!id || !run.persisted || !settingsRef.current.persist) return;
    // The server title is unknown here: a new thread is titled from its first prompt
    // (as the server does); an existing one keeps its title ('').
    const title = conversationIdRef.current === id ? '' : run.prompt;
    conversationIdRef.current = id;
    setConversationId(id);
    callbacksRef.current.onConversationPersisted?.(id, title);
  }, []);

  const settleError = React.useCallback(
    (run: RunState, failure: ChatTurnFailure) => {
      if (generationRef.current !== run.generation) return;
      const current = findItem(itemsRef.current, run.key);
      const settled: ChatAssistantItem | null = current
        ? { ...current, status: 'error', failure, live: null, response: null }
        : null;
      commitItems((prev) =>
        prev.map((item) => {
          if (item.kind === 'user' && item.requestKey === run.requestKey) return { ...item, failed: true };
          return settled && item.key === run.key ? settled : item;
        }),
      );
      // Neither the failed prompt nor the transport error enters model history. A
      // `turn.error` saved nothing; any other failure after `turn.start` (a lost
      // connection, an unconfirmed replay) may have been saved server-side.
      if (failure.kind !== 'turn_error') adoptStartedConversation(run);
      finishRun(run);
      if (settled) callbacksRef.current.onTurnSettled?.(settled);
    },
    [adoptStartedConversation, commitItems, finishRun],
  );

  /**
   * Stop abandoned the stream: keep what arrived, labelled Stopped. It is a local view,
   * not the server's record, so it stays OUT of model history (the prompt is marked
   * excluded); the server's stored version is the truth on the next hydration.
   */
  const settleStopped = React.useCallback(
    (run: RunState) => {
      if (generationRef.current !== run.generation) return;
      const current = findItem(itemsRef.current, run.key);
      const live = current?.live ?? null;
      const response = stoppedResponse(live ? { ...live, text: liveTextRef.current } : null);
      const settled: ChatAssistantItem | null = current
        ? { ...current, status: 'done', response, live: null, failure: null, messageId: null }
        : null;
      commitItems((prev) =>
        prev.map((item) => {
          if (item.kind === 'user' && item.requestKey === run.requestKey) return { ...item, failed: true };
          return settled && item.key === run.key ? settled : item;
        }),
      );
      adoptStartedConversation(run);
      finishRun(run);
      if (settled) callbacksRef.current.onTurnSettled?.(settled);
    },
    [adoptStartedConversation, commitItems, finishRun],
  );

  /* ---------------------------------------------------------------- events -- */

  const flushText = React.useCallback(
    (run: RunState) => {
      frameRef.current = null;
      if (runRef.current !== run || generationRef.current !== run.generation) return;
      const text = liveTextRef.current;
      updateLive(run.key, (live) => (live.text === text ? live : { ...live, text }));
    },
    [updateLive],
  );

  const handleEvent = React.useCallback(
    (run: RunState, event: ChatStreamEvent) => {
      if (runRef.current !== run || generationRef.current !== run.generation) return;
      switch (event.type) {
        case 'turn.start': {
          const previousTurnId = run.turnId;
          run.turnId = event.turn_id;
          if (event.conversation_id) run.conversationId = event.conversation_id;
          // A Stop asked before the turn was named, or before a recovery replay named
          // a different turn, is sent to the turn that is actually running now.
          if (run.cancelWhenStarted || (run.stopRequested && previousTurnId !== null && previousTurnId !== event.turn_id)) {
            run.cancelWhenStarted = false;
            void cancelChatTurn(event.turn_id);
          }
          // Every stream starts its own projection: a recovery replay must not keep
          // the dropped attempt's steps, usage or text (a step with the same index would
          // otherwise be ignored as a duplicate and stay "running").
          liveTextRef.current = '';
          cancelFrame();
          updateLive(run.key, (live) => ({
            ...live,
            turnId: event.turn_id,
            model: event.model,
            streamMode: event.stream_mode,
            replayed: event.replayed,
            estimatePromptTokens: event.estimate.prompt_tokens,
            steps: [],
            usage: null,
            text: '',
            connection: 'open',
          }));
          return;
        }
        case 'step.start': {
          const step = event.step;
          updateLive(run.key, (live) => {
            const existing = live.steps.find((s) => s.index === step.index);
            if (existing) return live;
            const steps = [...live.steps, { ...step, status: 'running' as const, result: null, startedAt: Date.now() }];
            steps.sort((a, b) => a.index - b.index);
            return { ...live, steps };
          });
          return;
        }
        case 'step.end': {
          const result = event.step;
          updateLive(run.key, (live) => {
            const index = live.steps.findIndex((s) => s.index === result.index);
            const merged: ChatLiveStep = {
              index: result.index,
              ordinal: result.ordinal ?? null,
              kind: result.kind,
              tool: result.tool ?? null,
              label: result.label,
              params: result.params,
              group: result.group ?? null,
              status: result.status,
              result,
              startedAt: index >= 0 ? live.steps[index].startedAt : Date.now(),
            };
            const steps = index >= 0 ? live.steps.map((s, i) => (i === index ? merged : s)) : [...live.steps, merged];
            steps.sort((a, b) => a.index - b.index);
            return { ...live, steps };
          });
          return;
        }
        case 'usage':
          updateLive(run.key, (live) => ({ ...live, usage: event.totals }));
          return;
        case 'text.delta':
          liveTextRef.current += event.text;
          if (!frameRef.current) frameRef.current = scheduleFrame(() => flushText(run));
          return;
        case 'text.reset':
          liveTextRef.current = '';
          cancelFrame();
          updateLive(run.key, (live) => ({ ...live, text: '' }));
          return;
        default:
          // `ping` keeps the connection alive; terminal events settle in runTurn.
          return;
      }
    },
    [cancelFrame, flushText, updateLive],
  );

  /* ------------------------------------------------------------------ turn -- */

  const runTurn = React.useCallback(
    async (run: RunState, request: ChatRequest) => {
      const signal = run.controller.signal;
      const stale = () => generationRef.current !== run.generation || runRef.current !== run;

      const blockingTurn = async () => {
        run.transport = 'blocking';
        updateLive(run.key, (live) => ({ ...live, transport: 'blocking' }));
        const response = await postChat(request, signal);
        if (stale()) return;
        settleDone(run, response);
      };

      try {
        if (run.transport === 'blocking') {
          await blockingTurn();
          return;
        }
        const body: ChatRequest = { ...request, stream_mode: settingsRef.current.effectiveStreamMode };
        let recovering = false;
        let waits = 0;
        for (;;) {
          let outcome: ChatStreamOutcome;
          try {
            outcome = await streamChat(body, { signal, onEvent: (event) => handleEvent(run, event) });
          } catch (error) {
            // While recovering, the server may still be running the turn (up to its own
            // timeout plus one in-flight model call): wait out a 409
            // `chat_request_in_progress` until then, never for a fixed retry count.
            if (
              recovering &&
              !signal.aborted &&
              error instanceof ApiError &&
              error.status === 409 &&
              apiErrorCode(error) === 'chat_request_in_progress'
            ) {
              const deadline = run.startedAt + recoveryWindowMs(callbacksRef.current.turnBounds);
              const remaining = deadline - Date.now();
              if (remaining > 0) {
                await sleep(Math.min(remaining, recoveryDelayMs(waits, apiRetryAfterSeconds(error))), signal);
                waits += 1;
                if (stale()) return;
                continue;
              }
              settleError(run, {
                kind: 'connection_lost',
                message:
                  'Connection lost and the request is still running on the server. Retry to check for the saved answer.',
                code: 'chat_request_in_progress',
                status: 409,
                retryable: true,
                notice: null,
              });
              return;
            }
            throw error;
          }
          if (stale() && !(outcome.status === 'aborted' && run.forcedStop)) return;
          if (outcome.status === 'done') {
            settleDone(run, outcome.event.response);
            return;
          }
          if (outcome.status === 'error') {
            settleError(run, failureFromTurnError(outcome.event));
            return;
          }
          if (outcome.status === 'aborted') {
            if (run.forcedStop) settleStopped(run);
            return;
          }
          // Ended without turn.done / turn.error. A persisted turn is idempotent
          // server-side (completed-key replay), so check for the saved answer ONCE.
          if (!recovering && request.persist_conversation && request.idempotency_key) {
            recovering = true;
            liveTextRef.current = '';
            cancelFrame();
            updateLive(run.key, (live) => ({ ...live, connection: 'recovering', text: '' }));
            continue;
          }
          settleError(run, {
            kind: 'connection_lost',
            message: recovering
              ? 'Connection lost and the saved answer could not be confirmed. Retry to check again.'
              : 'Connection lost before the answer arrived.',
            code: null,
            status: null,
            retryable: true,
            notice: null,
          });
          return;
        }
      } catch (error) {
        if (signal.aborted || stale()) {
          if (run.forcedStop) settleStopped(run);
          return;
        }
        if (run.transport === 'stream' && isStreamUnsupportedError(error)) {
          // An older backend without /chat/stream: use blocking /chat from now on.
          streamSupportedRef.current = false;
          try {
            await blockingTurn();
          } catch (fallbackError) {
            if (signal.aborted || stale()) return;
            settleError(run, failureFromError(fallbackError, 'Unexpected error contacting the assistant.'));
          }
          return;
        }
        settleError(run, failureFromError(error, 'Unexpected error contacting the assistant.'));
      }
    },
    [cancelFrame, handleEvent, settleDone, settleError, settleStopped, updateLive],
  );

  /** Start one turn for `request`, optionally replacing a failed pair (same key). */
  const startTurn = React.useCallback(
    (request: ChatRequest, origin: ChatOrigin, replaceRequestKey: string | null): boolean => {
      if (busyRef.current || runRef.current) return false;
      const requestKey = request.idempotency_key ?? newIdempotencyKey();
      const now = Date.now();
      const assistantKey = nextItemKey('assistant');
      const run: RunState = {
        key: assistantKey,
        requestKey,
        generation: generationRef.current,
        controller: new AbortController(),
        transport: streamSupportedRef.current ? 'stream' : 'blocking',
        turnId: null,
        stopRequested: false,
        cancelWhenStarted: false,
        forcedStop: false,
        persisted: request.persist_conversation === true,
        prompt: request.message,
        conversationId: null,
        startedAt: now,
      };
      runRef.current = run;
      liveTextRef.current = '';
      cancelFrame();
      const userItem: ChatUserItem = {
        kind: 'user',
        key: nextItemKey('user'),
        messageId: null,
        content: displayText(request.message, 0, { multiline: true }),
        prompt: request.message,
        origin,
        at: now,
        requestKey,
        failed: false,
      };
      const assistantItem: ChatAssistantItem = {
        kind: 'assistant',
        key: assistantKey,
        messageId: null,
        at: now,
        requestKey,
        status: 'running',
        response: null,
        live: {
          transport: run.transport,
          turnId: null,
          model: request.model ?? null,
          streamMode: settingsRef.current.effectiveStreamMode,
          replayed: false,
          estimatePromptTokens: 0,
          steps: [],
          usage: null,
          text: '',
          stopping: false,
          connection: 'open',
          startedAt: now,
        },
        failure: null,
        restored: false,
        model: request.model ?? null,
        source: request.source_id ?? null,
        request: { ...request, idempotency_key: requestKey },
      };
      commitItems((prev) => [
        ...prev.filter((item) => !replaceRequestKey || item.requestKey !== replaceRequestKey),
        userItem,
        assistantItem,
      ]);
      setBusyState(true);
      void runTurn(run, { ...request, idempotency_key: requestKey });
      return true;
    },
    [cancelFrame, commitItems, runTurn, setBusyState],
  );

  const buildRequest = React.useCallback((message: string, origin: ChatOrigin, continueOf: string | null, topic: string | null): ChatRequest => {
    const s = settingsRef.current;
    const body: ChatRequest = {
      message,
      // Only earlier successful exchanges; the current message is sent separately.
      history: boundHistory(historyRef.current),
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
      if (!message || busyRef.current || runRef.current || settingsRef.current.blocked) return false;
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
      for (let i = index - 1; i >= 0; i -= 1) {
        const entry = list[i];
        // The exact prompt, not its display form (see ChatUserItem.prompt).
        if (entry.kind === 'user') return send(entry.prompt, { origin: entry.origin });
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

  const stop = React.useCallback(
    (stopOptions: { force?: boolean } = {}) => {
      const run = runRef.current;
      // A blocking `/chat` turn cannot be stopped (`canStop` is false): aborting the
      // fetch would only hide an answer the server still bills and saves.
      if (!run || run.transport === 'blocking') return;
      if (stopOptions.force || run.stopRequested) {
        // Abandon the stream locally. The server still finishes (and, after a Stop,
        // saves the stopped turn); the next history refresh shows what it kept.
        run.forcedStop = true;
        run.controller.abort();
        return;
      }
      run.stopRequested = true;
      updateLive(run.key, (live) => ({ ...live, stopping: true }));
      if (run.turnId) void cancelChatTurn(run.turnId);
      else run.cancelWhenStarted = true;
    },
    [updateLive],
  );

  const reset = resetTranscript;

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
    streamMode: streamPref.mode,
    effectiveStreamMode,
    setStreamMode: streamPref.setMode,
    lastUserPrompt,
    send,
    stop,
    retry,
    askAgain,
    continueAnswer,
    reset,
  };
}
