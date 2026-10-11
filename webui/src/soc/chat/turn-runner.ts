/**
 * turn-runner — chat turns that outlive the component that started them (Round 12,
 * SPEC D13, `diagnosis/working.md` §5.2).
 *
 * A module-level registry of runs keyed by scope (`conv:<id>`, `draft:<request key>`,
 * `case:<id>`). ES modules stay cached once the lazy chat chunk has loaded, so a run
 * survives every route change: leaving the chat DETACHES its view (the NDJSON read goes
 * on), returning RE-ATTACHES it with the live run log and a working Stop. A full reload
 * re-attaches through `GET /api/chat/turns/{id}/events?after=<seq>` (the server's
 * bounded per-turn event ring, then the live tail).
 *
 * `useChatEngine` is a VIEW of its scope's run: it starts runs here, subscribes while
 * mounted, and applies a settled run's result to its transcript and model history once.
 * The runner itself writes the app-level activity store (the navigation glyph, the
 * brand ring, the tab title, the "Answer ready" toast) and tells every open history
 * rail to refresh when a saved answer lands.
 *
 * Recovery (SPEC D1: turns have no time limit any more, so recovery has no deadline):
 *  - a stream that ends without `turn.done` re-attaches to the SAME turn when its id is
 *    known (reading the ring is never a second model call; case turns included);
 *  - otherwise a persisted Workspace turn is re-sent ONCE with the same key (a
 *    completed-key replay, or 409 `chat_request_in_progress` naming the running turn,
 *    which is then re-attached; without a turn id the 409 is waited out with backoff);
 *  - a case turn is never re-sent (A4: the thread append is not idempotent), so without
 *    a turn id it ends as "Connection lost" with Retry.
 *
 * Capacity (SPEC D6): over the per-user or per-backend bound the server refuses the
 * send with 429 `chat_busy` before anything starts. The run then waits ("Waiting for
 * another answer to finish") and sends the same request again with backoff, at the
 * server's `retry_after`, for up to {@link TURN_RUNNER_TIMING}`.busyWaitLimitMs`; then it
 * fails with Retry. Stop while waiting simply ends it (nothing ran).
 *
 * Connections: a browser opens at most six HTTP/1.1 connections to the console, and the
 * shell's live updates already hold some. So only answers someone is LOOKING at keep a
 * live read. A run nobody views is PARKED shortly after its view leaves (the read is
 * closed; the server turn goes on): one cheap `GET /chat/turns/active` poll follows every
 * parked run, and a run reads the rest of its events (`after=<seq>`) when a view
 * returns or when the poll no longer lists its turn. Turns the server reports that this
 * tab did not start (a reload, another tab that closed) are tracked the same way
 * (`trackRun`), so their real outcome (answer, question, failure) comes from their
 * terminal event.
 *
 * Abort happens only on a forced Stop and on sign-out (`clearChatActivity`). Memory
 * only: transcripts and titles are never written to storage (#9).
 */
import { ApiError, request, requestResponse } from '@/lib/api';
import type {
  ChatOrigin,
  ChatRequest,
  ChatResponse,
  ChatStep,
  ChatStepStatus,
  ChatStreamMode,
  ChatTurn,
  TurnNotice,
  TurnUsage,
} from '@/lib/types';
import {
  dropChatActivity,
  onChatActivity,
  patchChatActivity,
  putChatActivity,
  rekeyChatActivity,
  settleChatActivity,
  type ChatActivityOutcome,
} from '../chat-activity/activity';
import {
  apiErrorCode,
  apiRetryAfterSeconds,
  cancelChatTurn,
  isSafeChatId,
  isStreamUnsupportedError,
  postChat,
  streamChat,
} from './chat-api';
import { NdjsonLineSplitter, type ChatStreamOutcome } from './ndjson';
import {
  displayText,
  parseStreamEvent,
  type ChatStreamEvent,
  type StepStartInfo,
  type TurnDoneEvent,
  type TurnErrorEvent,
  type TurnStartEvent,
} from './stream-events';

/* -------------------------------------------------------------------------- */
/* Transcript model (shared with useChatEngine, which re-exports it).          */
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

/** Progress of a long lookup (`step.progress`, Round 12). */
export interface ChatLiveStepProgress {
  done: number;
  total: number | null;
  unit: string;
}

/** One run-log row while the turn is running. */
export interface ChatLiveStep extends StepStartInfo {
  status: 'running' | ChatStepStatus;
  /** The final step from `step.end` (the truth once present). */
  result: ChatStep | null;
  /** ms epoch when the step started (client clock; display only). */
  startedAt: number;
  /** The latest `step.progress` for this step, if any. */
  progress?: ChatLiveStepProgress | null;
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
  /**
   * The server is at its chat capacity (429 `chat_busy`, SPEC D6): the question waits for
   * another answer to finish and is then sent again (nothing has run yet).
   */
  waiting?: boolean;
  startedAt: number;
  /** The answer was continued past the output limit (`text.continued` part, ≥ 2). */
  continued?: number;
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

/** One model-history turn and the request it belongs to (a same-key retry replaces it). */
export interface HistoryEntry {
  turn: ChatTurn;
  requestKey: string | null;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers.                                                               */
/* -------------------------------------------------------------------------- */

/** Notice kinds that mean "the first model call never ran" (D1, SPEC §4.5). */
const UNSAVED_NOTICE_KINDS = new Set(['budget', 'breaker', 'provider']);
/** Re-check cadence while a lost turn still runs server-side (409 in progress). */
const RECOVERY_BACKOFF_MS = [1500, 3000, 5000, 8000];
/** Bounds on one re-check delay, whatever the server hints. */
const RECOVERY_MIN_DELAY_MS = 250;
const RECOVERY_MAX_DELAY_MS = 15_000;
/** Re-attach attempts in a row that bring no new event before the turn is called lost. */
export const MAX_REATTACH_ATTEMPTS = 6;
/** Settled runs nobody has opened yet, kept for their view (oldest dropped first). */
const MAX_SETTLED_RUNS = 30;
/** Case transcripts kept for this session (memory only). */
export const MAX_CASE_SESSIONS = 20;
export const MAX_CASE_SESSION_ITEMS = 50;
/** The cross-tab history signal every open rail listens to. */
export const HISTORY_CHANNEL = 'agentic-soc-workspace-chat-history';

/**
 * Timings (mutable for tests only; `resetTurnRunnerForTests` restores them):
 *  - `parkDelayMs`: how long a run nobody views keeps its live read (a quick switch
 *    between threads, or a development double mount, never closes it);
 *  - `parkPollMs`: the `GET /chat/turns/active` cadence while any run is parked;
 *  - `busyWaitLimitMs`: how long a question waits for chat capacity (429 `chat_busy`).
 */
export const TURN_RUNNER_TIMING = { parkDelayMs: 1_500, parkPollMs: 5_000, busyWaitLimitMs: 5 * 60_000 };
const DEFAULT_TIMING = { ...TURN_RUNNER_TIMING };

/**
 * D1 (SPEC §4.5): the first model call failed, nothing was billed or saved. Such a
 * turn shows its notice but never enters history, and Retry reuses its key.
 */
export function isUnsavedTurn(response: ChatResponse): boolean {
  const notice = response.notice;
  if (!notice || !UNSAVED_NOTICE_KINDS.has(notice.kind)) return false;
  return !response.message_id && (!response.usage || response.usage.calls === 0);
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

export function failureFromError(error: unknown, fallback: string): ChatTurnFailure {
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
      // host offers Ask again (a new key) instead of Retry same request. Neither is
      // `chat_request_failed`: the turn under this key was answered but not saved.
      retryable:
        code !== 'chat_idempotency_conflict' &&
        code !== 'chat_request_failed' &&
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

const connectionLost = (message: string, code: string | null = null, status: number | null = null): ChatTurnFailure => ({
  kind: 'connection_lost',
  message,
  code,
  status,
  retryable: true,
  notice: null,
});

/**
 * What a turn looks like once Stop abandoned its stream locally. It is a local view,
 * not the server's record (which may differ, or not exist yet): no `message_id`, and
 * it never enters model history.
 */
export function stoppedResponse(live: ChatLiveTurn | null): ChatResponse {
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

type FrameHandle = { cancel: () => void };
function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    const id = window.requestAnimationFrame(callback);
    return { cancel: () => window.cancelAnimationFrame(id) };
  }
  const id = setTimeout(callback, 16);
  return { cancel: () => clearTimeout(id) };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
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

let keyCounter = 0;
/** A unique transcript item key. */
export function nextItemKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${keyCounter}`;
}

/* -------------------------------------------------------------------------- */
/* Runs.                                                                       */
/* -------------------------------------------------------------------------- */

export type TurnRunState = 'running' | 'done' | 'error' | 'stopped' | 'lost';

/** One turn, live or settled. Fields are read by the engine; only the runner writes them. */
export interface TurnRun {
  readonly id: number;
  /** Changes once: a new thread's `draft:` scope becomes `conv:<id>` at `turn.start`. */
  scope: string;
  readonly kind: 'workspace' | 'case';
  readonly caseId: string | null;
  /** The exact body (with its idempotency key); `null` for a turn re-attached after a reload. */
  readonly request: ChatRequest | null;
  readonly requestKey: string | null;
  readonly persisted: boolean;
  /** The prompt pair to show; `null` after a reload (the prompt is not known yet). */
  readonly userItem: ChatUserItem | null;
  readonly assistantKey: string;
  readonly startedAt: number;
  state: TurnRunState;
  live: ChatLiveTurn;
  response: ChatResponse | null;
  failure: ChatTurnFailure | null;
  turnId: string | null;
  conversationId: string | null;
  transport: 'stream' | 'blocking';
  /** The stream route is missing (an older backend): use `/chat` from now on. */
  streamUnsupported: boolean;
  /** An engine (or, for a detached case turn, the runner) applied the settled result. */
  consumed: boolean;
  /** Mounted views. */
  attached: number;
}

interface RunInternals extends TurnRun {
  controller: AbortController;
  stopRequested: boolean;
  cancelWhenStarted: boolean;
  forcedStop: boolean;
  listeners: Set<() => void>;
  text: string;
  frame: FrameHandle | null;
  /** The read in flight (a POST stream or the event ring), when there is one. */
  read: AbortController | null;
  /** The read was closed to park the run (not a Stop, not a sign-out). */
  parkRequested: boolean;
  /** Nobody views it and no read is open: the park poll follows the turn. */
  parked: boolean;
  /** Ends the parked wait (a view came back, or the turn ended). */
  wake: (() => void) | null;
  parkTimer: ReturnType<typeof setTimeout> | null;
}

let runCounter = 0;
const runs = new Map<string, RunInternals>();

const internals = (run: TurnRun) => run as RunInternals;

/** The run for a scope (live, or settled and not yet applied). */
export function findRun(scope: string | null | undefined): TurnRun | null {
  return (scope && runs.get(scope)) || null;
}

/** Every run (tests, the history rail's synthetic rows). */
export function listRuns(): TurnRun[] {
  return Array.from(runs.values());
}

function emit(run: RunInternals): void {
  for (const listener of Array.from(run.listeners)) listener();
}

export function subscribeRun(run: TurnRun, listener: () => void): () => void {
  const target = internals(run);
  target.listeners.add(listener);
  return () => target.listeners.delete(listener);
}

/** A view mounts on this run; returns its detach (the run goes on). */
export function attachRun(run: TurnRun): () => void {
  const target = internals(run);
  target.attached += 1;
  clearParkTimer(target);
  // Someone looks again: read the rest live (from the last event this tab saw).
  unpark(target);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    target.attached = Math.max(0, target.attached - 1);
    if (!target.attached) scheduleParkCheck(target);
  };
}

/** The settled result was applied: forget the run. */
export function consumeRun(run: TurnRun): void {
  run.consumed = true;
  if (runs.get(run.scope) === run) runs.delete(run.scope);
}

function setLive(run: RunInternals, update: (live: ChatLiveTurn) => ChatLiveTurn): void {
  const next = update(run.live);
  if (next === run.live) return;
  run.live = next;
  emit(run);
}

function cancelFrame(run: RunInternals): void {
  run.frame?.cancel();
  run.frame = null;
}

function lookupsOf(live: ChatLiveTurn): number {
  return live.steps.filter((step) => step.kind === 'tool' && step.status !== 'running').length;
}

function broadcastHistory(): void {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return;
  try {
    const channel = new window.BroadcastChannel(HISTORY_CHANNEL);
    channel.postMessage({ type: 'history-changed' });
    channel.close();
  } catch {
    /* best effort: the rails also refresh on focus */
  }
}

export interface StartRunOptions {
  scope: string;
  kind: 'workspace' | 'case';
  caseId?: string | null;
  /** The exact body, idempotency key included. */
  request: ChatRequest;
  origin: ChatOrigin;
  transport: 'stream' | 'blocking';
  streamMode: ChatStreamMode;
}

function makeRun(fields: {
  scope: string;
  kind: 'workspace' | 'case';
  caseId: string | null;
  request: ChatRequest | null;
  userItem: ChatUserItem | null;
  transport: 'stream' | 'blocking';
  streamMode: ChatStreamMode;
  conversationId: string | null;
  turnId: string | null;
  startedAt: number;
}): RunInternals {
  runCounter += 1;
  return {
    id: runCounter,
    scope: fields.scope,
    kind: fields.kind,
    caseId: fields.caseId,
    request: fields.request,
    requestKey: fields.request?.idempotency_key ?? null,
    persisted: fields.request?.persist_conversation === true,
    userItem: fields.userItem,
    assistantKey: nextItemKey('assistant'),
    startedAt: fields.startedAt,
    state: 'running',
    live: {
      transport: fields.transport,
      turnId: fields.turnId,
      model: fields.request?.model ?? null,
      streamMode: fields.streamMode,
      replayed: false,
      estimatePromptTokens: 0,
      steps: [],
      usage: null,
      text: '',
      stopping: false,
      connection: 'open',
      startedAt: fields.startedAt,
    },
    response: null,
    failure: null,
    turnId: fields.turnId,
    conversationId: fields.conversationId,
    transport: fields.transport,
    streamUnsupported: false,
    consumed: false,
    attached: 0,
    controller: new AbortController(),
    stopRequested: false,
    cancelWhenStarted: false,
    forcedStop: false,
    listeners: new Set(),
    text: '',
    frame: null,
    read: null,
    parkRequested: false,
    parked: false,
    wake: null,
    parkTimer: null,
  };
}

function register(run: RunInternals): void {
  const previous = runs.get(run.scope);
  if (previous && previous !== run) {
    // A newer turn in the same scope: the older settled one is superseded.
    previous.consumed = true;
  }
  runs.set(run.scope, run);
  // Keep at most MAX_SETTLED_RUNS settled runs nobody opened (oldest first).
  const settled = Array.from(runs.values()).filter((entry) => entry.state !== 'running');
  for (const stale of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_RUNS))) {
    stale.consumed = true;
    runs.delete(stale.scope);
  }
}

/** Start a new turn. The caller has already shown nothing; the run carries its own pair. */
export function startRun(options: StartRunOptions): TurnRun {
  const now = Date.now();
  const request = options.request;
  const userItem: ChatUserItem = {
    kind: 'user',
    key: nextItemKey('user'),
    messageId: null,
    content: displayText(request.message, 0, { multiline: true }),
    prompt: request.message,
    origin: options.origin,
    at: now,
    requestKey: request.idempotency_key ?? null,
    failed: false,
  };
  const run = makeRun({
    scope: options.scope,
    kind: options.kind,
    caseId: options.caseId ?? null,
    request,
    userItem,
    transport: options.transport,
    streamMode: options.streamMode,
    conversationId: request.conversation_id ?? null,
    turnId: null,
    startedAt: now,
  });
  register(run);
  putChatActivity({
    scope: run.scope,
    kind: run.kind,
    conversationId: run.conversationId,
    caseId: run.caseId,
    turnId: null,
    requestKey: run.requestKey,
    title: displayText(request.message, 80),
    label: null,
    lookups: 0,
    status: 'running',
    startedAt: now,
    source: 'local',
  });
  void drive(run, { ...request, stream_mode: options.streamMode }, options.transport === 'blocking');
  return run;
}

export interface ReattachOptions {
  scope: string;
  kind: 'workspace' | 'case';
  turnId: string;
  conversationId?: string | null;
  caseId?: string | null;
  /** Display text for the activity entry. */
  title?: string;
  startedAt?: number;
  /** The engine's step label the server reported (`trackRun`), display text. */
  label?: string | null;
  lookups?: number;
}

/**
 * Re-attach to a turn this tab did not start (a reload, another tab): read its event
 * ring from the start and tail it. Reading never starts a model call and never holds
 * a concurrency slot. Returns the existing run when the scope already has one.
 */
export function reattachRun(options: ReattachOptions): TurnRun | null {
  const existing = runs.get(options.scope);
  if (existing) return existing;
  if (!isSafeChatId(options.turnId)) return null;
  const run = makeRun({
    scope: options.scope,
    kind: options.kind,
    caseId: options.caseId ?? null,
    request: null,
    userItem: null,
    transport: 'stream',
    streamMode: 'steps',
    conversationId: options.conversationId ?? null,
    turnId: options.turnId,
    startedAt: options.startedAt ?? Date.now(),
  });
  register(run);
  putChatActivity({
    scope: run.scope,
    kind: run.kind,
    conversationId: run.conversationId,
    caseId: run.caseId,
    turnId: run.turnId,
    requestKey: null,
    title: options.title ?? '',
    label: null,
    lookups: 0,
    status: 'running',
    startedAt: run.startedAt,
    source: 'local',
  });
  void drive(run, null, false);
  return run;
}

/**
 * Follow a turn the server reports that this tab is not reading (a reload, another tab
 * that closed, another device) WITHOUT opening a read: it starts parked, so the park
 * poll follows it, and it reads its events when a view opens it or when it ends (so
 * its real outcome is known). Returns the scope's running run when there already is
 * one.
 */
export function trackRun(options: ReattachOptions): TurnRun | null {
  const existing = runs.get(options.scope);
  if (existing?.state === 'running') return existing;
  if (!isSafeChatId(options.turnId)) return null;
  const run = makeRun({
    scope: options.scope,
    kind: options.kind,
    caseId: options.caseId ?? null,
    request: null,
    userItem: null,
    transport: 'stream',
    streamMode: 'steps',
    conversationId: options.conversationId ?? null,
    turnId: options.turnId,
    startedAt: options.startedAt ?? Date.now(),
  });
  register(run);
  putChatActivity({
    scope: run.scope,
    kind: run.kind,
    conversationId: run.conversationId,
    caseId: run.caseId,
    turnId: run.turnId,
    requestKey: null,
    title: options.title ?? '',
    label: options.label ?? null,
    lookups: options.lookups ?? 0,
    status: 'running',
    startedAt: run.startedAt,
    source: 'local',
    parked: true,
  });
  void drive(run, null, false, true);
  return run;
}

/* -------------------------------------------------------------------- parking -- */

function clearParkTimer(run: RunInternals): void {
  if (run.parkTimer !== null) clearTimeout(run.parkTimer);
  run.parkTimer = null;
}

/** Nobody views `run`: park it after a short grace (a quick return keeps the read). */
function scheduleParkCheck(run: RunInternals): void {
  if (run.state !== 'running' || run.attached > 0 || run.parked || run.parkTimer !== null) return;
  run.parkTimer = setTimeout(() => {
    run.parkTimer = null;
    requestPark(run);
  }, TURN_RUNNER_TIMING.parkDelayMs);
}

/**
 * Close the read of a run nobody views. Only once its turn is named (a POST that has
 * not seen `turn.start` cannot be followed by id) and never a blocking `/chat` call or
 * a question still waiting for capacity (they hold no stream).
 */
function requestPark(run: RunInternals): void {
  if (run.state !== 'running' || run.attached > 0 || run.parked || run.parkRequested) return;
  if (!run.turnId || !run.read || run.transport === 'blocking' || run.live.waiting) return;
  run.parkRequested = true;
  run.read.abort();
}

/** The drive loop waits here, with no connection open, until `unpark` or an abort. */
function parkedWait(run: RunInternals): Promise<void> {
  run.parkRequested = false;
  const signal = run.controller.signal;
  if (run.attached > 0 || run.state !== 'running' || signal.aborted) return Promise.resolve();
  run.parked = true;
  patchChatActivity(run.scope, { parked: true });
  scheduleParkPoll();
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener('abort', done);
      run.wake = null;
      resolve();
    };
    run.wake = done;
    signal.addEventListener('abort', done, { once: true });
  });
}

function unpark(run: RunInternals): void {
  if (!run.parked) return;
  run.parked = false;
  if (run.state === 'running') patchChatActivity(run.scope, { parked: false });
  run.wake?.();
}

let parkPollTimer: ReturnType<typeof setTimeout> | null = null;
let parkPolling = false;

const parkedRuns = () => Array.from(runs.values()).filter((run) => run.parked && run.state === 'running');

function scheduleParkPoll(): void {
  if (parkPollTimer !== null || parkPolling || !parkedRuns().length) return;
  parkPollTimer = setTimeout(() => {
    parkPollTimer = null;
    void pollParkedRuns();
  }, TURN_RUNNER_TIMING.parkPollMs);
}

const lookupCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * Follow every parked run with one `GET /chat/turns/active`: a listed turn updates its
 * step label; a turn no longer listed has ended, so its run reads the rest of its
 * events (finished turns stay readable for five minutes) and settles with the real
 * outcome. Runs on its own cadence ({@link TURN_RUNNER_TIMING}`.parkPollMs`): no extra
 * live connection is opened just to hear about turn ends sooner.
 */
export async function pollParkedRuns(): Promise<void> {
  if (parkPolling) return;
  if (parkPollTimer !== null) {
    clearTimeout(parkPollTimer);
    parkPollTimer = null;
  }
  if (!parkedRuns().length) return;
  parkPolling = true;
  let listed: Map<string, Record<string, unknown>> | null = null;
  try {
    const response = await request<unknown>('GET', 'chat/turns/active');
    listed = new Map();
    for (const turn of Array.isArray(response) ? response : []) {
      const id = turn && typeof turn === 'object' ? (turn as { turn_id?: unknown }).turn_id : null;
      if (isSafeChatId(id)) listed.set(id, turn as Record<string, unknown>);
    }
  } catch {
    // Offline, or the server is busy: look again on the next round.
    listed = null;
  } finally {
    parkPolling = false;
  }
  if (listed) {
    for (const run of parkedRuns()) {
      const turn = run.turnId ? listed.get(run.turnId) : undefined;
      if (!turn) {
        unpark(run);
        continue;
      }
      const label = typeof turn.label === 'string' ? displayText(turn.label, 120) : '';
      patchChatActivity(run.scope, { label: label || null, lookups: lookupCount(turn.lookups) });
    }
  }
  scheduleParkPoll();
}

/** Stop (server-side cancel; a second call, or `force`, abandons the stream locally). */
export function stopRun(run: TurnRun, force = false): void {
  const target = internals(run);
  if (target.state !== 'running' || target.transport === 'blocking') return;
  // Still waiting for capacity: nothing started server-side, so Stop simply ends it.
  if (force || target.stopRequested || target.live.waiting) {
    target.forcedStop = true;
    target.controller.abort();
    return;
  }
  target.stopRequested = true;
  setLive(target, (live) => ({ ...live, stopping: true }));
  if (target.turnId) void cancelChatTurn(target.turnId);
  else target.cancelWhenStarted = true;
}

/** Sign-out: stop reading every turn (the server finishes them) and forget them. */
export function abortAllRuns(): void {
  if (parkPollTimer !== null) clearTimeout(parkPollTimer);
  parkPollTimer = null;
  for (const run of Array.from(runs.values())) {
    run.consumed = true;
    cancelFrame(run);
    clearParkTimer(run);
    run.controller.abort();
    if (run.state === 'running') {
      // Views let go of it; nothing is applied (the next sign-in starts clean).
      run.state = 'lost';
      emit(run);
    }
    run.listeners.clear();
  }
  runs.clear();
  caseSessions.clear();
}

onChatActivity('clear', abortAllRuns);

/* ------------------------------------------------------------------ settle -- */

/** A new thread's turn whose answer saved: its scope is `conv:<id>` from now on. */
function rekeyRun(run: RunInternals, conversationId: string): void {
  const to = `conv:${conversationId}`;
  if (run.scope === to || runs.get(to)?.state === 'running') return;
  const from = run.scope;
  if (runs.get(from) === run) runs.delete(from);
  run.scope = to;
  run.conversationId = conversationId;
  runs.set(to, run);
  rekeyChatActivity(from, to, { conversationId });
}

function finish(run: RunInternals, state: Exclude<TurnRunState, 'running'>, fields: Partial<TurnRun> = {}): void {
  if (run.state !== 'running') return;
  cancelFrame(run);
  clearParkTimer(run);
  run.parked = false;
  run.wake = null;
  Object.assign(run, fields);
  run.state = state;
  // `turn:` — a turn followed for the server with neither a conversation nor a case
  // (an unsaved chat): nothing could ever show it, so it leaves no mark.
  if (state === 'lost' || run.scope.startsWith('turn:')) dropChatActivity(run.scope);
  else {
    const response = state === 'done' ? run.response : null;
    const saved = !!response?.message_id;
    // A replay may never have named the new thread at `turn.start`: its saved answer
    // still lands under `conv:<id>`, where its row and its view find it.
    if (saved && run.kind === 'workspace' && run.persisted && response?.conversation_id && run.scope.startsWith('draft:')) {
      rekeyRun(run, response.conversation_id);
    }
    // A Stop the server confirmed (`turn.done` with a `cancelled` notice), or any end
    // after the analyst asked to stop, is a stop: no "Answer ready", no unread mark, and
    // no "could not be saved" for a new thread (the forced Stop is just as quiet).
    // D1: a first call that failed (budget, provider) answered nothing: not "ready".
    const stopped = state === 'stopped' || run.stopRequested || response?.notice?.kind === 'cancelled';
    const outcome: ChatActivityOutcome = stopped
      ? 'stopped'
      : response
        ? isUnsavedTurn(response)
          ? 'error'
          : response.clarify
            ? 'needs_input'
            : 'done'
        : 'error';
    // A NEW thread that saved nothing has no conversation to reopen (its temporary row
    // is gone): no mark is left, and the toast offers to ask the question again.
    const unreachable = run.kind === 'workspace' && !!run.request && !run.request.conversation_id && !saved;
    settleChatActivity(run.scope, outcome, true, {
      // A view attached to this run has it on screen, even before that view has
      // registered the run's new `conv:` scope (a fast answer on a new thread).
      attached: run.attached > 0,
      ...(unreachable ? { unreachable, prompt: run.request?.message ?? null } : {}),
    });
    if (unreachable && !run.attached) consumeRun(run);
  }
  if (run.kind === 'workspace') broadcastHistory();
  // A case turn nobody is looking at joins its session transcript now.
  if (run.kind === 'case' && run.caseId && !run.attached) {
    appendToCaseSession(run.caseId, run);
    consumeRun(run);
  }
  emit(run);
}

/**
 * The user item as it should read once its run settled. A saved answer names its
 * question's persisted id (`user_message_id`, Round 12 WP-FIX1): the live question
 * takes it, like a restored one, so a search hit or link to it is found on screen.
 */
export function settledUserItem(run: TurnRun): ChatUserItem | null {
  if (!run.userItem) return null;
  const failed = run.state === 'done' ? !!run.response && isUnsavedTurn(run.response) : true;
  const saved = run.state === 'done' && !failed ? run.response?.user_message_id ?? null : null;
  return { ...run.userItem, failed, messageId: run.userItem.messageId ?? saved };
}

/** The assistant item for a run (live while running; its truth once settled). */
export function runAssistantItem(run: TurnRun): ChatAssistantItem {
  const request = run.request;
  const base: ChatAssistantItem = {
    kind: 'assistant',
    key: run.assistantKey,
    messageId: null,
    at: run.startedAt,
    requestKey: run.requestKey,
    status: 'running',
    response: null,
    live: run.live,
    failure: null,
    restored: false,
    model: request?.model ?? null,
    source: request?.source_id ?? null,
    request,
  };
  if (run.state === 'running' || run.state === 'lost') return base;
  if (run.state === 'error') return { ...base, status: 'error', failure: run.failure, live: null };
  const response = run.state === 'stopped' ? stoppedResponse({ ...run.live, text: internals(run).text }) : (run.response as ChatResponse);
  return {
    ...base,
    status: 'done',
    response,
    live: null,
    messageId: response.message_id ?? null,
    model: response.effective_model?.trim() || request?.model || null,
    source:
      response.effective_source_name?.trim() ||
      response.effective_source_id?.trim() ||
      request?.source_id ||
      null,
  };
}

/** The model-history exchange a settled run adds (none for unsaved or stopped turns). */
export function runExchange(run: TurnRun): HistoryEntry[] {
  if (run.state !== 'done' || !run.response || isUnsavedTurn(run.response) || !run.request) return [];
  return [
    { turn: { role: 'user', content: run.request.message, origin: run.request.origin ?? 'user' }, requestKey: run.requestKey },
    { turn: { role: 'assistant', content: run.response.answer }, requestKey: run.requestKey },
  ];
}

/* -------------------------------------------------------------------- events -- */

function flushText(run: RunInternals): void {
  run.frame = null;
  if (run.state !== 'running') return;
  const text = run.text;
  setLive(run, (live) => (live.text === text ? live : { ...live, text }));
}

function noteStep(run: RunInternals, label: string | null): void {
  patchChatActivity(run.scope, { label: label ?? null, lookups: lookupsOf(run.live) });
}

function handleEvent(run: RunInternals, event: ChatStreamEvent): void {
  if (run.state !== 'running') return;
  switch (event.type) {
    case 'turn.start': {
      onTurnStart(run, event);
      return;
    }
    case 'step.start': {
      const step = event.step;
      if (run.live.steps.some((s) => s.index === step.index)) return;
      const steps = [...run.live.steps, { ...step, status: 'running' as const, result: null, startedAt: Date.now() }];
      steps.sort((a, b) => a.index - b.index);
      setLive(run, (live) => ({ ...live, steps }));
      noteStep(run, step.label);
      return;
    }
    case 'step.end': {
      const result = event.step;
      setLive(run, (live) => {
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
      noteStep(run, result.label);
      return;
    }
    case 'step.progress': {
      const progress = { done: event.done, total: event.total, unit: event.unit };
      setLive(run, (live) =>
        live.steps.some((s) => s.index === event.index)
          ? { ...live, steps: live.steps.map((s) => (s.index === event.index ? { ...s, progress } : s)) }
          : live,
      );
      return;
    }
    case 'usage':
      setLive(run, (live) => ({ ...live, usage: event.totals }));
      return;
    case 'text.delta':
      run.text += event.text;
      run.frame ??= scheduleFrame(() => flushText(run));
      return;
    case 'text.reset':
      run.text = '';
      cancelFrame(run);
      setLive(run, (live) => ({ ...live, text: '' }));
      return;
    case 'text.continued':
      setLive(run, (live) => ({ ...live, continued: event.part }));
      return;
    default:
      // `ping` keeps the connection alive; terminal events settle in `drive`.
      return;
  }
}

function onTurnStart(run: RunInternals, event: TurnStartEvent): void {
  const previousTurnId = run.turnId;
  run.turnId = event.turn_id;
  if (event.conversation_id) run.conversationId = event.conversation_id;
  // A Stop asked before the turn was named, or before a recovery replay named a
  // different turn, is sent to the turn that is actually running now.
  if (run.cancelWhenStarted || (run.stopRequested && previousTurnId !== null && previousTurnId !== event.turn_id)) {
    run.cancelWhenStarted = false;
    void cancelChatTurn(event.turn_id);
  }
  // Every stream starts its own projection: a recovery replay or a re-attach from the
  // ring's start must not keep the dropped attempt's steps, usage or text.
  run.text = '';
  cancelFrame(run);
  setLive(run, (live) => ({
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
    waiting: false,
  }));
  patchChatActivity(run.scope, { turnId: event.turn_id, conversationId: run.conversationId });
  // A new thread learnt its id: the run is `conv:<id>` from now on, so leaving and
  // reopening that thread finds it.
  if (run.kind === 'workspace' && run.persisted && event.conversation_id && run.scope.startsWith('draft:')) {
    const before = run.scope;
    rekeyRun(run, event.conversation_id);
    if (run.scope !== before) emit(run);
  }
  // Named now: a run nobody views can be parked.
  if (!run.attached) scheduleParkCheck(run);
}

/* --------------------------------------------------------------------- read -- */

/**
 * Read `GET /chat/turns/{id}/events?after=` to its terminal event. Each line carries
 * its ring `seq`; `onEvent` gets it so a later re-attach resumes exactly there.
 */
async function readTurnEvents(
  turnId: string,
  after: number,
  signal: AbortSignal,
  onEvent: (event: ChatStreamEvent, seq: number | null) => void,
): Promise<ChatStreamOutcome> {
  const response = await requestResponse('GET', `chat/turns/${encodeURIComponent(turnId)}/events`, {
    query: { after },
    signal,
    cache: 'no-store',
  });
  const splitter = new NdjsonLineSplitter();
  let start: TurnStartEvent | null = null;
  let malformed = 0;
  let terminal: TurnDoneEvent | TurnErrorEvent | null = null;
  const handle = (lines: string[]): boolean => {
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseStreamEvent(line);
      if (!event) {
        malformed += 1;
        continue;
      }
      let seq: number | null = null;
      try {
        const raw = JSON.parse(line) as { seq?: unknown };
        if (typeof raw.seq === 'number' && Number.isInteger(raw.seq) && raw.seq >= 0) seq = raw.seq;
      } catch {
        /* parsed above; never reached */
      }
      if (event.type === 'turn.start' && !start) start = event;
      onEvent(event, seq);
      if (event.type === 'turn.done' || event.type === 'turn.error') {
        terminal = event;
        return true;
      }
    }
    return false;
  };
  const end = (): ChatStreamOutcome => {
    const last = terminal as TurnDoneEvent | TurnErrorEvent | null;
    if (last?.type === 'turn.done') return { status: 'done', event: last, start, malformed };
    if (last?.type === 'turn.error') return { status: 'error', event: last, start, malformed };
    return { status: 'incomplete', reason: 'eof', start, malformed };
  };
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text().catch(() => '');
    if (signal.aborted) return { status: 'aborted', start, malformed };
    if (!handle(splitter.push(text))) handle(splitter.flush());
    return end();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal.aborted) return { status: 'aborted', start, malformed };
        return { status: 'incomplete', reason: 'network', start, malformed };
      }
      if (signal.aborted) return { status: 'aborted', start, malformed };
      if (chunk.done) {
        if (!handle(splitter.push(decoder.decode()))) handle(splitter.flush());
        return end();
      }
      const value = chunk.value;
      if (handle(splitter.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true })))) {
        reader.cancel().catch(() => undefined);
        return end();
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** The running turn a 409 `chat_request_in_progress` names, when it does. */
function holderTurnId(error: ApiError): string | null {
  const body = error.body as { detail?: { turn_id?: unknown } } | null;
  const id = body && typeof body === 'object' ? body.detail?.turn_id : null;
  return isSafeChatId(id) ? id : null;
}

/* -------------------------------------------------------------------- drive -- */

async function drive(run: RunInternals, body: ChatRequest | null, blocking: boolean, startParked = false): Promise<void> {
  const signal = run.controller.signal;
  const canResend = !!body && body.persist_conversation === true && !!body.idempotency_key && run.kind === 'workspace';
  let mode: 'post' | 'events' | 'blocking' = !body ? 'events' : blocking ? 'blocking' : 'post';
  let after = 0;
  /** Events read from the POST stream: the ring numbers them 1, 2, 3 … (pings excluded). */
  let postEvents = 0;
  let resent = false;
  let waits = 0;
  let busySince: number | null = null;
  let busyWaits = 0;
  let drops = 0;
  /** The server no longer knows the turn (404): re-attaching again is pointless. */
  let gone = false;

  const onEvent = (event: ChatStreamEvent, seq: number | null) => {
    if (seq !== null) after = Math.max(after, seq);
    if (event.type !== 'ping') {
      drops = 0;
      // Events flow again after a drop: the run log stops saying "Connection lost".
      if (run.live.connection !== 'open' && event.type !== 'turn.start') {
        setLive(run, (live) => ({ ...live, connection: 'open' }));
      }
    }
    handleEvent(run, event);
  };
  const onPostEvent = (event: ChatStreamEvent) => {
    if (event.type !== 'ping') postEvents += 1;
    onEvent(event, null);
  };
  const resend = () => {
    resent = true;
    mode = 'post';
    postEvents = 0;
    run.text = '';
    cancelFrame(run);
    setLive(run, (live) => ({ ...live, connection: 'recovering', text: '' }));
  };
  /**
   * Between reads (a backoff, a wait, a park) no read is open: a park asked for now
   * finds nothing to close and leaves no flag behind; the next read parks normally.
   */
  const between = () => {
    run.read = null;
  };
  const reattach = async () => {
    // From a POST stream the ring is read from its start (the projection is rebuilt
    // by its `turn.start`); a re-attach that dropped resumes after the last seq.
    if (mode !== 'events') after = 0;
    mode = 'events';
    drops += 1;
    between();
    setLive(run, (live) => (live.connection === 'recovering' ? live : { ...live, connection: 'recovering' }));
    if (drops > 1) await sleep(recoveryDelayMs(drops - 2, null), signal);
  };
  /**
   * The read was closed to park the run: continue from the ring later. A POST stream
   * that read every line resumes after its last event (the ring numbers the POST's
   * events 1, 2, 3 …); otherwise the ring is read from its start (`turn.start` rebuilds
   * the projection).
   */
  const park = async (malformed: number | null) => {
    if (mode === 'post') after = malformed === 0 ? postEvents : 0;
    mode = 'events';
    between();
    await parkedWait(run);
  };

  if (startParked) await parkedWait(run);

  for (;;) {
    if (signal.aborted) {
      if (run.forcedStop) finish(run, 'stopped');
      return;
    }
    if (run.state !== 'running') return;
    // One controller per read: parking closes the read, not the run. A park asked for
    // the previous read is spent: this read starts unparked and parks on its own.
    const read = new AbortController();
    const closeRead = () => read.abort();
    signal.addEventListener('abort', closeRead, { once: true });
    run.parkRequested = false;
    run.read = read;
    if (!run.attached) scheduleParkCheck(run);
    try {
      if (mode === 'blocking' && run.request) {
        run.transport = 'blocking';
        setLive(run, (live) => ({ ...live, transport: 'blocking' }));
        // The exact request: `/chat` has no live mode.
        const response = await postChat(run.request, read.signal);
        finish(run, 'done', { response });
        return;
      }
      const outcome =
        mode === 'post' && body
          ? await streamChat(body, { signal: read.signal, onEvent: onPostEvent })
          : await readTurnEvents(run.turnId as string, after, read.signal, onEvent);
      if (run.state !== 'running') return;
      if (outcome.status === 'done') {
        finish(run, 'done', { response: outcome.event.response });
        return;
      }
      if (outcome.status === 'error') {
        finish(run, 'error', { failure: failureFromTurnError(outcome.event) });
        return;
      }
      if (outcome.status === 'aborted') {
        if (signal.aborted) {
          if (run.forcedStop) finish(run, 'stopped');
          return;
        }
        if (run.parkRequested) {
          await park(outcome.malformed);
          continue;
        }
        return;
      }
      // Ended without turn.done / turn.error.
      if (run.turnId && !gone && drops < MAX_REATTACH_ATTEMPTS) {
        await reattach();
        continue;
      }
      if (canResend && !resent) {
        resend();
        continue;
      }
      finish(run, 'error', {
        failure: connectionLost(
          resent
            ? 'Connection lost and the saved answer could not be confirmed. Retry to check again.'
            : 'Connection lost before the answer arrived.',
        ),
      });
      return;
    } catch (error) {
      if (signal.aborted || run.state !== 'running') {
        if (run.forcedStop) finish(run, 'stopped');
        return;
      }
      if (run.parkRequested && read.signal.aborted) {
        await park(null);
        continue;
      }
      if (mode === 'post' && !resent && isStreamUnsupportedError(error)) {
        // An older backend without /chat/stream: use blocking /chat from now on.
        run.streamUnsupported = true;
        mode = 'blocking';
        continue;
      }
      if (error instanceof ApiError) {
        if ((mode === 'post' || mode === 'blocking') && error.status === 429 && apiErrorCode(error) === 'chat_busy') {
          // SPEC D6: at capacity, refused before anything started. Wait for another
          // answer to finish, then send the same request again (same key) — for a
          // while, not forever: then the question fails with Retry.
          busySince ??= Date.now();
          if (Date.now() - busySince >= TURN_RUNNER_TIMING.busyWaitLimitMs) {
            finish(run, 'error', { failure: failureFromError(error, 'Chat is busy with other answers. Try again in a moment.') });
            return;
          }
          if (!run.live.waiting) setLive(run, (live) => ({ ...live, waiting: true }));
          between();
          await sleep(recoveryDelayMs(busyWaits, apiRetryAfterSeconds(error)), signal);
          busyWaits += 1;
          continue;
        }
        if (mode === 'post' && canResend && error.status === 409 && apiErrorCode(error) === 'chat_request_in_progress') {
          // The turn under this key still runs server-side. A 409 that names it is
          // re-attached (a Retry of a turn whose stream was lost included); while
          // recovering, one that does not is waited out (turns have no time limit, so
          // neither does this).
          const holder = holderTurnId(error);
          if (holder) {
            run.turnId = holder;
            drops = 0;
            gone = false;
            await reattach();
            continue;
          }
          if (resent) {
            between();
            await sleep(recoveryDelayMs(waits, apiRetryAfterSeconds(error)), signal);
            waits += 1;
            continue;
          }
        }
        if (mode === 'events' && error.status === 404) {
          // The turn is gone from the server's memory (finished a while ago, or a
          // restart): a persisted Workspace turn is replayed once with its key.
          gone = true;
          if (canResend && !resent) {
            resend();
            continue;
          }
          if (!body) {
            finish(run, 'lost');
            return;
          }
          finish(run, 'error', {
            failure: connectionLost('Connection lost and the answer could not be found. Retry to ask again.', null, 404),
          });
          return;
        }
        if (mode === 'events' && error.status === 0 && drops < MAX_REATTACH_ATTEMPTS) {
          await reattach();
          continue;
        }
      }
      finish(run, 'error', { failure: failureFromError(error, 'Unexpected error contacting the assistant.') });
      return;
    } finally {
      signal.removeEventListener('abort', closeRead);
      if (run.read === read) run.read = null;
    }
  }
}

/* ------------------------------------------------------------- case sessions -- */

/** A case chat's transcript for this session (memory only; SPEC D13, G5). */
export interface CaseSession {
  items: ChatTranscriptItem[];
  history: HistoryEntry[];
}

const caseSessions = new Map<string, CaseSession>();

export function readCaseSession(caseId: string): CaseSession | null {
  const session = caseSessions.get(caseId);
  if (!session) return null;
  caseSessions.delete(caseId);
  caseSessions.set(caseId, session);
  return session;
}

export function writeCaseSession(caseId: string, session: CaseSession): void {
  caseSessions.delete(caseId);
  if (!session.items.length && !session.history.length) return;
  let items = session.items;
  if (items.length > MAX_CASE_SESSION_ITEMS) {
    items = items.slice(items.length - MAX_CASE_SESSION_ITEMS);
    // Start on a prompt so an answer never shows without its question.
    while (items.length && items[0].kind !== 'user') items = items.slice(1);
  }
  caseSessions.set(caseId, { items, history: session.history });
  for (const key of Array.from(caseSessions.keys())) {
    if (caseSessions.size <= MAX_CASE_SESSIONS) break;
    caseSessions.delete(key);
  }
}

function appendToCaseSession(caseId: string, run: RunInternals): void {
  const session = caseSessions.get(caseId) ?? { items: [], history: [] };
  const user = settledUserItem(run);
  const items = session.items.filter((item) => item.requestKey !== run.requestKey || !run.requestKey);
  writeCaseSession(caseId, {
    items: [...items, ...(user ? [user] : []), runAssistantItem(run)],
    history: [...session.history.filter((entry) => entry.requestKey !== run.requestKey), ...runExchange(run)],
  });
}

/* ------------------------------------------------------------------ server -- */

/** `POST /api/chat/conversations/{id}/read`: the answer is on screen. Best effort. */
export async function markConversationRead(conversationId: string): Promise<boolean> {
  if (!isSafeChatId(conversationId)) return false;
  try {
    await request<unknown>('POST', `chat/conversations/${encodeURIComponent(conversationId)}/read`);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget every run and session without touching the activity store. */
export function resetTurnRunnerForTests(): void {
  if (parkPollTimer !== null) clearTimeout(parkPollTimer);
  parkPollTimer = null;
  parkPolling = false;
  for (const run of Array.from(runs.values())) {
    cancelFrame(run);
    clearParkTimer(run);
    run.controller.abort();
  }
  runs.clear();
  caseSessions.clear();
  Object.assign(TURN_RUNNER_TIMING, DEFAULT_TIMING);
}
