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
 * server's `retry_after`; Stop while waiting simply ends it (nothing ran).
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
  run.attached += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run.attached = Math.max(0, run.attached - 1);
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
  for (const run of Array.from(runs.values())) {
    run.consumed = true;
    cancelFrame(run);
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

function finish(run: RunInternals, state: Exclude<TurnRunState, 'running'>, fields: Partial<TurnRun> = {}): void {
  if (run.state !== 'running') return;
  cancelFrame(run);
  Object.assign(run, fields);
  run.state = state;
  if (state === 'lost') dropChatActivity(run.scope);
  else {
    const outcome = state === 'done' ? (run.response?.clarify ? 'needs_input' : 'done') : state === 'stopped' ? 'stopped' : 'error';
    settleChatActivity(run.scope, outcome);
  }
  if (run.kind === 'workspace') broadcastHistory();
  // A case turn nobody is looking at joins its session transcript now.
  if (run.kind === 'case' && run.caseId && !run.attached) {
    appendToCaseSession(run.caseId, run);
    consumeRun(run);
  }
  emit(run);
}

/** The user item as it should read once its run settled. */
export function settledUserItem(run: TurnRun): ChatUserItem | null {
  if (!run.userItem) return null;
  const failed = run.state === 'done' ? !!run.response && isUnsavedTurn(run.response) : true;
  return { ...run.userItem, failed };
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
    const to = `conv:${event.conversation_id}`;
    if (!runs.has(to) || runs.get(to)?.state !== 'running') {
      const from = run.scope;
      runs.delete(from);
      run.scope = to;
      runs.set(to, run);
      rekeyChatActivity(from, to, { conversationId: event.conversation_id });
      emit(run);
    }
  }
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

async function drive(run: RunInternals, body: ChatRequest | null, blocking: boolean): Promise<void> {
  const signal = run.controller.signal;
  const canResend = !!body && body.persist_conversation === true && !!body.idempotency_key && run.kind === 'workspace';
  let mode: 'post' | 'events' | 'blocking' = !body ? 'events' : blocking ? 'blocking' : 'post';
  let after = 0;
  let resent = false;
  let waits = 0;
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
  const resend = () => {
    resent = true;
    mode = 'post';
    run.text = '';
    cancelFrame(run);
    setLive(run, (live) => ({ ...live, connection: 'recovering', text: '' }));
  };
  const reattach = async () => {
    // From a POST stream the ring is read from its start (the projection is rebuilt
    // by its `turn.start`); a re-attach that dropped resumes after the last seq.
    if (mode !== 'events') after = 0;
    mode = 'events';
    drops += 1;
    setLive(run, (live) => (live.connection === 'recovering' ? live : { ...live, connection: 'recovering' }));
    if (drops > 1) await sleep(recoveryDelayMs(drops - 2, null), signal);
  };

  for (;;) {
    if (signal.aborted) {
      if (run.forcedStop) finish(run, 'stopped');
      return;
    }
    if (run.state !== 'running') return;
    try {
      if (mode === 'blocking' && run.request) {
        run.transport = 'blocking';
        setLive(run, (live) => ({ ...live, transport: 'blocking' }));
        // The exact request: `/chat` has no live mode.
        const response = await postChat(run.request, signal);
        finish(run, 'done', { response });
        return;
      }
      const outcome =
        mode === 'post' && body
          ? await streamChat(body, { signal, onEvent: (event) => onEvent(event, null) })
          : await readTurnEvents(run.turnId as string, after, signal, onEvent);
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
        if (run.forcedStop) finish(run, 'stopped');
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
      if (mode === 'post' && !resent && isStreamUnsupportedError(error)) {
        // An older backend without /chat/stream: use blocking /chat from now on.
        run.streamUnsupported = true;
        mode = 'blocking';
        continue;
      }
      if (error instanceof ApiError) {
        if ((mode === 'post' || mode === 'blocking') && error.status === 429 && apiErrorCode(error) === 'chat_busy') {
          // SPEC D6: at capacity, refused before anything started. Wait for another
          // answer to finish, then send the same request again (same key).
          if (!run.live.waiting) setLive(run, (live) => ({ ...live, waiting: true }));
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
  for (const run of Array.from(runs.values())) {
    cancelFrame(run);
    run.controller.abort();
  }
  runs.clear();
  caseSessions.clear();
}
