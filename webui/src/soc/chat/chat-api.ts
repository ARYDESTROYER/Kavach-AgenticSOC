/**
 * Lazy chat + reports data client (chat revamp SPEC §6, §7.5, §8, §9.2, §10.10).
 *
 * Every call is built on `lib/api.ts`'s exported `request` / `requestResponse`, so a
 * lapsed session (401 → login), a step-up gate (`reauth_required` → re-auth modal and
 * ONE retry), cookies, coded-error messages and `AbortSignal` behave exactly like the
 * rest of the console. This module is imported only by the chat route chunk and the
 * reports UI, never by the entry bundle: the eager `api` object gains no methods.
 *
 * Every response is UNTRUSTED (#9): it is normalised here leniently (a drifted field
 * is coerced or dropped, never a crash) and every string a renderer will show goes
 * through `displayText()` (BLOCKS.md amendment 4). Block JSON stays raw — render it
 * only through `parseBlocks()`.
 */
import { ApiError, request, requestResponse } from '@/lib/api';
import type {
  ChatAgentConfig,
  ChatBudgetInfo,
  ChatContextBounds,
  ChatContextInfo,
  ChatConversation,
  ChatConversationMessage,
  ChatConversationSearchHit,
  ChatConversationSummary,
  ChatConversationsResponse,
  ChatConversationUpdateRequest,
  ChatRates,
  ChatPrompt,
  ChatRequest,
  ChatResponse,
  ChatScope,
  ChatStarter,
  ChatTimeRange,
  ChatToolInfo,
  ChatTopicQuestion,
  Report,
  ReportCreateRequest,
  ReportItem,
  ReportListEntry,
  ReportPatchRequest,
  ReportSummary,
  ReportSummaryEstimate,
  ReportTemplateName,
} from '@/lib/types';
import { readChatStream, type ChatStreamOutcome } from './ndjson';
import {
  CHAT_BUDGET_STATES,
  CHAT_LIMITS,
  CHAT_SCOPES,
  CHAT_STREAM_MODES,
  REPORT_ITEM_KINDS,
  REPORT_TEMPLATES,
  TEXT_STREAMING_REASONS,
  displayText,
  normaliseChatResponse,
  normaliseTurnUsage,
  type ChatStreamEvent,
} from './stream-events';

/* -------------------------------------------------------------------------- */
/* Lenient field helpers.                                                      */
/* -------------------------------------------------------------------------- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The backend's plain-id grammar (`_SAFE_ID_PATTERN`): conversation/message/report ids. */
export const SAFE_CHAT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const isSafeChatId = (v: unknown): v is string => typeof v === 'string' && SAFE_CHAT_ID_RE.test(v);
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const GRANT_RE = /^[a-z_]{1,40}:[a-z_]{1,40}$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const BLOCK_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

const safeId = (v: unknown): string | null => (isSafeChatId(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown, limit = 64): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= limit ? v : null;
const text = (v: unknown, limit: number, multiline = false): string => displayText(v, limit, { multiline });
const optText = (v: unknown, limit: number, multiline = false): string | null =>
  typeof v === 'string' ? text(v, limit, multiline) || null : null;
const count = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
const optCount = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
function enumOr<T extends string, F>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
function strings(value: unknown, limit: number, valid: (s: string) => boolean): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && valid(item) && !out.includes(item)) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** `{from, to}` with both bounds bounded plain text (the server validated the grammar). */
function timeRange(value: unknown): ChatTimeRange | null {
  if (!isObj(value)) return null;
  const from = optStr(value.from, 40);
  if (!from) return null;
  const to = optStr(value.to, 40);
  return to ? { from, to } : { from };
}

/* -------------------------------------------------------------------------- */
/* Chat turns.                                                                 */
/* -------------------------------------------------------------------------- */

/** `POST /api/chat` (blocking). The response is normalised like a `turn.done`. */
export async function postChat(body: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  const raw = await request<unknown>('POST', 'chat', { body, signal });
  const response = normaliseChatResponse(raw);
  if (!response) throw new ApiError(502, 'The assistant returned a response that could not be read.', raw);
  return response;
}

export interface StreamChatOptions {
  signal?: AbortSignal;
  /** Every parsed event in order, the terminal one included. */
  onEvent?: (event: ChatStreamEvent) => void;
}

/**
 * `POST /api/chat/stream`: same body as `/chat`. Pre-stream failures (401/403/404/409/
 * 422/429/503) throw the usual `ApiError`; once the 200 arrives, every outcome —
 * including a broken connection — is returned, never thrown.
 */
export async function streamChat(body: ChatRequest, options: StreamChatOptions = {}): Promise<ChatStreamOutcome> {
  const response = await requestResponse('POST', 'chat/stream', {
    body,
    signal: options.signal,
    cache: 'no-store',
  });
  return readChatStream(response, { onEvent: options.onEvent, signal: options.signal });
}

/**
 * True when the backend has no streaming route (an older server behind this UI): the
 * engine then falls back to blocking `/chat`. A FastAPI unknown route answers 404
 * `{"detail": "Not Found"}` (a missing CONVERSATION is a different, lower-case detail)
 * or 405 for a method mismatch.
 */
export function isStreamUnsupportedError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 405 || error.status === 501) return true;
  return error.status === 404 && isObj(error.body) && error.body.detail === 'Not Found';
}

/** The coded `detail.code` of an `ApiError` (`chat_busy`, `chat_pin_limit`, …), if any. */
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !isObj(error.body)) return null;
  const detail = error.body.detail;
  if (isObj(detail) && typeof detail.code === 'string') return detail.code;
  return typeof error.body.code === 'string' ? error.body.code : null;
}

/**
 * The server's re-check hint in seconds (`detail.retry_after` or `retry_after` in a 409
 * `chat_request_in_progress` body), when it sent a usable one. `ApiError` carries the
 * body, not the headers, so a `Retry-After` header alone is not visible here and the
 * caller falls back to its own backoff.
 */
export function apiRetryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof ApiError) || !isObj(error.body)) return null;
  const detail = error.body.detail;
  const raw = isObj(detail) && 'retry_after' in detail ? detail.retry_after : error.body.retry_after;
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `POST /api/chat/turns/{turn_id}/cancel` (Stop, SPEC §6.4). Server-authoritative: the
 * caller keeps reading the stream, which ends with `turn.done {notice: cancelled}`.
 * Resolves `true` when the server accepted the request; never throws for a refusal
 * (the turn may already have finished), only for an abort.
 */
export async function cancelChatTurn(turnId: string, signal?: AbortSignal): Promise<boolean> {
  if (!isSafeChatId(turnId)) return false;
  try {
    await request<unknown>('POST', `chat/turns/${encodeURIComponent(turnId)}/cancel`, { signal });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Meter + catalogue: GET /api/chat/context.                                   */
/* -------------------------------------------------------------------------- */

/** SPEC §4.2 defaults, used until (or when) `/chat/context` is unavailable. */
export const DEFAULT_CHAT_BOUNDS: ChatContextBounds = {
  max_model_calls: 5,
  max_tool_calls: 10,
  max_parallel: 4,
  tool_timeout_s: 15,
  model_step_timeout_s: 30,
  turn_timeout_s: 90,
  turn_token_ceiling: 60_000,
  final_reserve_tokens: 12_000,
  observation_chars: 6_000,
  final_max_tokens: 4_000,
  max_indicator_lookups: 3,
  default_stream_mode: 'steps',
  allow_text_streaming: true,
};

function normaliseTool(raw: unknown): ChatToolInfo | null {
  if (!isObj(raw) || typeof raw.name !== 'string' || !TOOL_NAME_RE.test(raw.name)) return null;
  const scope = enumOr<ChatScope, null>(raw.scope, CHAT_SCOPES, null);
  if (!scope) return null;
  const kindRequires: Record<string, string> = {};
  if (isObj(raw.kind_requires)) {
    for (const [kind, grant] of Object.entries(raw.kind_requires)) {
      if (KIND_RE.test(kind) && typeof grant === 'string' && GRANT_RE.test(grant)) kindRequires[kind] = grant;
    }
  }
  return {
    name: raw.name,
    label: text(raw.label, 80) || raw.name,
    scope,
    data_source: text(raw.data_source, 120),
    requires: strings(raw.requires, 8, (g) => GRANT_RE.test(g)),
    // Fail closed: only an explicit `true` unlocks a tool in the UI.
    allowed: raw.allowed === true,
    missing: strings(raw.missing, 8, (g) => GRANT_RE.test(g)),
    kind_requires: kindRequires,
    kinds_allowed: strings(raw.kinds_allowed, 20, (k) => KIND_RE.test(k)),
  };
}

function normaliseBounds(raw: unknown): ChatContextBounds {
  const src = isObj(raw) ? raw : {};
  const out: ChatContextBounds = { ...DEFAULT_CHAT_BOUNDS };
  for (const key of Object.keys(DEFAULT_CHAT_BOUNDS) as Array<keyof ChatContextBounds>) {
    const value = src[key];
    if (key === 'default_stream_mode') out.default_stream_mode = enumOr(value, CHAT_STREAM_MODES, 'steps');
    else if (key === 'allow_text_streaming') out.allow_text_streaming = value !== false;
    else if (typeof value === 'number' && Number.isInteger(value) && value > 0) out[key] = value;
  }
  return out;
}

function normaliseRates(raw: unknown): ChatRates | null {
  if (!isObj(raw)) return null;
  const input = amount(raw.input_per_million);
  const output = amount(raw.output_per_million);
  if (input === null || output === null) return null;
  return { input_per_million: input, output_per_million: output, cache_read_per_million: amount(raw.cache_read_per_million) };
}

function normaliseBudget(raw: unknown): ChatBudgetInfo | null {
  if (!isObj(raw)) return null;
  const pct = amount(raw.soft_warn_pct);
  return {
    enabled: raw.enabled === true,
    daily_limit: amount(raw.daily_limit),
    soft_warn_pct: pct !== null && pct <= 1 ? pct : 0.8,
    on_exceed: raw.on_exceed === 'warn' ? 'warn' : 'block',
  };
}

/** The backend `ChatStarter.id` grammar (`^[a-z0-9_]+$`, ≤ 40). */
const STARTER_ID_RE = /^[a-z0-9_]{1,40}$/;
/** Bounds mirrored from backend `models.ChatStarter` (SPEC §10.5). */
export const CHAT_STARTER_LIMITS = { starters: 12, label_chars: 40, description_chars: 120, prompt_chars: 400, tools: 8 } as const;

/**
 * One empty-state starter (SPEC §10.5), or `null` when unusable. The prompt is SENT
 * as the user's message (origin `starter`), so it is never clamped with an ellipsis:
 * an over-long prompt drops the card instead of sending a mangled question. Starter
 * prompts are server-built from live context (a case id, a source name), so they are
 * still display-sanitised like every other server string (#9).
 */
function normaliseStarter(raw: unknown): ChatStarter | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !STARTER_ID_RE.test(raw.id)) return null;
  const label = text(raw.label, CHAT_STARTER_LIMITS.label_chars);
  const prompt = typeof raw.prompt === 'string' ? displayText(raw.prompt, 0, { multiline: true }).trim() : '';
  if (!label || !prompt || Array.from(prompt).length > CHAT_STARTER_LIMITS.prompt_chars) return null;
  return {
    id: raw.id,
    label,
    description: text(raw.description, CHAT_STARTER_LIMITS.description_chars),
    prompt,
    tools: strings(raw.tools, CHAT_STARTER_LIMITS.tools, (name) => TOOL_NAME_RE.test(name)),
  };
}

/** Lenient `ChatContextInfo`: safe defaults everywhere, money fields only when sent. */
export function normaliseChatContext(raw: unknown): ChatContextInfo {
  const src = isObj(raw) ? raw : {};
  const streaming = isObj(src.text_streaming) ? src.text_streaming : {};
  const tools: ChatToolInfo[] = [];
  if (Array.isArray(src.tools)) {
    for (const item of src.tools) {
      const tool = normaliseTool(item);
      if (tool && !tools.some((t) => t.name === tool.name)) tools.push(tool);
      if (tools.length >= 40) break;
    }
  }
  const calibration = amount(src.calibration);
  const remaining = typeof src.remaining === 'number' && Number.isFinite(src.remaining) ? src.remaining : null;
  const starters: ChatStarter[] = [];
  if (Array.isArray(src.starters)) {
    for (const item of src.starters) {
      const starter = normaliseStarter(item);
      if (starter && !starters.some((s) => s.id === starter.id)) starters.push(starter);
      if (starters.length >= CHAT_STARTER_LIMITS.starters) break;
    }
  }
  return {
    model: optText(src.model, 120),
    context_window: optCount(src.context_window),
    max_output_tokens: count(src.max_output_tokens, 0),
    chars_per_token: count(src.chars_per_token, 4) || 4,
    static_prompt_tokens: count(src.static_prompt_tokens, 0),
    history_tokens: count(src.history_tokens, 0),
    history_exchanges: count(src.history_exchanges, 0),
    tools,
    text_streaming: {
      available: streaming.available === true,
      reason: enumOr(streaming.reason, TEXT_STREAMING_REASONS, null),
    },
    bounds: normaliseBounds(src.bounds),
    calibration: calibration !== null && calibration > 0 ? calibration : null,
    budget_state: enumOr(src.budget_state, CHAT_BUDGET_STATES, null),
    rates: normaliseRates(src.rates),
    simulated: typeof src.simulated === 'boolean' ? src.simulated : null,
    budget: normaliseBudget(src.budget),
    spent_today: amount(src.spent_today),
    remaining,
    starters,
  };
}

export interface ChatContextQuery {
  /** The selected saved conversation (its history estimate and calibration). */
  conversationId?: string | null;
  /** A per-turn model override (the effective model and its rates differ). */
  model?: string | null;
  /** Case-scoped chat (Case Manager). */
  caseId?: string | null;
}

/** `GET /api/chat/context` (cached per principal for 30 s server-side). */
export async function getChatContext(query: ChatContextQuery = {}, signal?: AbortSignal): Promise<ChatContextInfo> {
  const raw = await request<unknown>('GET', 'chat/context', {
    query: {
      conversation_id: isSafeChatId(query.conversationId) ? query.conversationId : undefined,
      model: typeof query.model === 'string' && query.model.length <= 200 ? query.model : undefined,
      case_id: typeof query.caseId === 'string' && query.caseId.length <= 128 ? query.caseId : undefined,
    },
    signal,
  });
  return normaliseChatContext(raw);
}

/** The org bounds a `Preferences.chat_agent` carries, as public context bounds. */
export function boundsFromAgentConfig(config: ChatAgentConfig | null | undefined): ChatContextBounds {
  return normaliseBounds(config ?? null);
}

/* -------------------------------------------------------------------------- */
/* "Ask about this" topics: GET /api/chat/topics/{topic_id} (SPEC §10.7, D2).  */
/* -------------------------------------------------------------------------- */

/** A `console_map` topic id (the same grammar the chat route accepts in NavOpts). */
export const CHAT_TOPIC_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const TOPIC_QUESTION_CHARS = 400;

/**
 * Resolve a topic id to its templated question. The page sends the returned question
 * (origin `starter`) and never free text from the link (SPEC §10.7). An id outside
 * the grammar is refused locally (no request); 404 for an unknown topic is the
 * server's usual `ApiError`.
 */
export async function getChatTopic(topicId: string, signal?: AbortSignal): Promise<ChatTopicQuestion> {
  if (typeof topicId !== 'string' || !CHAT_TOPIC_RE.test(topicId)) {
    throw new ApiError(400, 'This topic is not available.', null);
  }
  const raw = await request<unknown>('GET', `chat/topics/${encodeURIComponent(topicId)}`, { signal });
  const src = isObj(raw) ? raw : {};
  // The question is sent verbatim as a message, so an over-long one is refused rather
  // than clamped with an ellipsis.
  const question = typeof src.question === 'string' ? displayText(src.question, 0).trim() : '';
  if (!question || Array.from(question).length > TOPIC_QUESTION_CHARS) {
    throw new ApiError(502, 'This topic could not be read.', raw);
  }
  const topic = typeof src.topic === 'string' && CHAT_TOPIC_RE.test(src.topic) ? src.topic : topicId;
  return { topic, question };
}

/* -------------------------------------------------------------------------- */
/* Saved prompts: UserPrefs.chat_prompts over the existing prefs routes.       */
/* -------------------------------------------------------------------------- */

/** Backend `CHAT_PROMPT_ID_PATTERN`. */
export const SAVED_PROMPT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export const SAVED_PROMPT_LIMITS = {
  prompts: CHAT_LIMITS.chat_prompts,
  title_chars: CHAT_LIMITS.chat_prompt_title_chars,
  text_chars: CHAT_LIMITS.chat_prompt_text_chars,
} as const;

/**
 * One saved prompt shaped the way the backend repairs it (`_repair_chat_prompts`):
 * multiline text clamped to 2,000, a single-line title clamped to 60 (derived from
 * the text when blank), `null` when the id or text is unusable.
 */
function normaliseSavedPrompt(raw: unknown): ChatPrompt | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !SAVED_PROMPT_ID_RE.test(raw.id)) return null;
  const body = text(raw.text, SAVED_PROMPT_LIMITS.text_chars, true).trim();
  if (!body) return null;
  const title = text(raw.title, SAVED_PROMPT_LIMITS.title_chars) || text(body, SAVED_PROMPT_LIMITS.title_chars);
  return { id: raw.id, title, text: body };
}

/** The stored list, de-duplicated by id and bounded to 50 (render as text, #9). */
export function normaliseSavedPrompts(raw: unknown): ChatPrompt[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatPrompt[] = [];
  for (const item of raw) {
    const prompt = normaliseSavedPrompt(item);
    if (prompt && !out.some((p) => p.id === prompt.id)) out.push(prompt);
    if (out.length >= SAVED_PROMPT_LIMITS.prompts) break;
  }
  return out;
}

/** A fresh id inside {@link SAVED_PROMPT_ID_RE}. */
export function newSavedPromptId(): string {
  const random = Math.random().toString(36).slice(2, 10) || '0';
  return `p-${Date.now().toString(36)}-${random}`;
}

/** Build a new prompt from free text (the title falls back to the text's first line). */
export function makeSavedPrompt(input: { title?: string | null; text: string }): ChatPrompt | null {
  return normaliseSavedPrompt({ id: newSavedPromptId(), title: input.title ?? '', text: input.text });
}

/** `GET /api/prefs/user` → the caller's saved prompts (personal bucket). */
export async function getSavedPrompts(signal?: AbortSignal): Promise<ChatPrompt[]> {
  const raw = await request<unknown>('GET', 'prefs/user', { signal });
  return normaliseSavedPrompts(isObj(raw) ? raw.chat_prompts : null);
}

/** Thrown when the server accepted the write but did not store the change. */
export const SAVED_PROMPTS_UNSUPPORTED = 'Saved prompts are not available on this server yet.';

/**
 * `PUT /api/prefs/user {chat_prompts}` with the whole list (the prefs routes are
 * replace-only for this field). Returns what the server stored.
 */
export async function putSavedPrompts(prompts: readonly ChatPrompt[]): Promise<ChatPrompt[]> {
  const body = normaliseSavedPrompts(prompts);
  const raw = await request<unknown>('PUT', 'prefs/user', { body: { chat_prompts: body } });
  return normaliseSavedPrompts(isObj(raw) ? raw.chat_prompts : null);
}

/**
 * Add one prompt. Re-reads the list right before writing so another tab's change is
 * not overwritten by a stale copy. Refuses a 51st prompt; reports an older server
 * that silently ignores `chat_prompts` instead of claiming the save worked.
 */
export async function addSavedPrompt(input: {
  title?: string | null;
  text: string;
}): Promise<{ prompt: ChatPrompt; prompts: ChatPrompt[] }> {
  const prompt = makeSavedPrompt(input);
  if (!prompt) throw new ApiError(422, 'Write the prompt text first.', null);
  const current = await getSavedPrompts();
  if (current.length >= SAVED_PROMPT_LIMITS.prompts) {
    throw new ApiError(409, `You have ${SAVED_PROMPT_LIMITS.prompts} saved prompts. Delete one to save another.`, null);
  }
  const stored = await putSavedPrompts([...current, prompt]);
  if (!stored.some((p) => p.id === prompt.id)) throw new ApiError(501, SAVED_PROMPTS_UNSUPPORTED, null);
  return { prompt, prompts: stored };
}

/** Delete one prompt by id (re-reads first, like {@link addSavedPrompt}). */
export async function deleteSavedPrompt(promptId: string): Promise<ChatPrompt[]> {
  const current = await getSavedPrompts();
  if (!current.some((p) => p.id === promptId)) return current;
  const stored = await putSavedPrompts(current.filter((p) => p.id !== promptId));
  if (stored.some((p) => p.id === promptId)) throw new ApiError(501, SAVED_PROMPTS_UNSUPPORTED, null);
  return stored;
}

/* -------------------------------------------------------------------------- */
/* Conversations.                                                              */
/* -------------------------------------------------------------------------- */

/** The rail's fallback title for a row whose stored title is unusable. */
export const UNTITLED_CONVERSATION = 'Untitled conversation';

/** A summary row (or a search hit), display-sanitised; `null` when it has no usable id. */
export function normaliseConversationSummary(raw: unknown): ChatConversationSearchHit | null {
  if (!isObj(raw)) return null;
  const id = safeId(raw.id);
  if (!id) return null;
  const created = str(raw.created_at);
  const updated = str(raw.updated_at) || created;
  const out: ChatConversationSearchHit = {
    id,
    title: text(raw.title, 80) || UNTITLED_CONVERSATION,
    preview: text(raw.preview, 160),
    created_at: created,
    updated_at: updated,
    message_count: count(raw.message_count, 0),
    total_message_count: optCount(raw.total_message_count) ?? undefined,
    model: optText(raw.model, 120),
    source_id: optStr(raw.source_id, 128),
    source_name: optText(raw.source_name, 120),
    history_truncated: raw.history_truncated === true,
    oldest_retained_at: optStr(raw.oldest_retained_at),
    pinned: raw.pinned === true,
    report_id: safeId(raw.report_id),
    time_range: timeRange(raw.time_range),
    // Legacy rows carry no totals: keep `null` so the UI shows "—", never 0.
    total_tokens: optCount(raw.total_tokens),
    total_cost: amount(raw.total_cost),
    usage_turns: optCount(raw.usage_turns),
  };
  if (isObj(raw.match)) {
    const snippet = text(raw.match.snippet, 160);
    if (snippet) out.match = { message_id: safeId(raw.match.message_id), snippet };
  }
  return out;
}

/** The list response with normalised rows and honest retention counters. */
export interface ChatConversationList extends ChatConversationsResponse {
  conversations: ChatConversationSearchHit[];
}

export function normaliseConversationList(raw: unknown): ChatConversationList {
  const src = isObj(raw) ? raw : {};
  const conversations: ChatConversationSearchHit[] = [];
  if (Array.isArray(src.conversations)) {
    for (const row of src.conversations) {
      const item = normaliseConversationSummary(row);
      if (item && !conversations.some((c) => c.id === item.id)) conversations.push(item);
    }
  }
  return {
    conversations,
    total: optCount(src.total) ?? undefined,
    total_conversation_count: optCount(src.total_conversation_count) ?? undefined,
    history_truncated: src.history_truncated === true,
    oldest_retained_at: optStr(src.oldest_retained_at),
    limit: optCount(src.limit) ?? undefined,
    offset: optCount(src.offset) ?? undefined,
  };
}

/**
 * One stored message; assistant responses are normalised like a `turn.done`. A user
 * message's `content` stays the EXACT stored prompt: Ask again and ↑-edit resend it,
 * and an invisible lookalike character in pasted evidence must reach the model as the
 * visible escape SPEC §7.6 makes of it, not silently vanish. It is therefore not
 * display text: render it through `displayText(…, 0, {multiline: true})`, as
 * `useChatEngine`'s `ChatUserItem.content` already is.
 */
export function normaliseConversationMessage(raw: unknown): ChatConversationMessage | null {
  if (!isObj(raw) || (raw.role !== 'user' && raw.role !== 'assistant') || typeof raw.content !== 'string') {
    return null;
  }
  const id = safeId(raw.id);
  if (!id) return null;
  let response: ChatResponse | null = null;
  if (raw.role === 'assistant') {
    // A legacy or drifted envelope still renders: the stored content is the answer.
    response =
      normaliseChatResponse(isObj(raw.response) ? { answer: raw.content, ...raw.response } : null) ??
      normaliseChatResponse({ answer: raw.content });
    if (response && !response.message_id) response.message_id = id;
  }
  return {
    id,
    role: raw.role,
    content: raw.role === 'assistant' && response ? response.answer : raw.content,
    created_at: str(raw.created_at),
    response,
    idempotency_key: optStr(raw.idempotency_key, 128),
    model: optText(raw.model, 120),
    source_id: optStr(raw.source_id, 128),
    source_name: optText(raw.source_name, 120),
  };
}

export function normaliseConversation(raw: unknown): ChatConversation | null {
  const summary = normaliseConversationSummary(raw);
  if (!summary || !isObj(raw)) return null;
  const messages: ChatConversationMessage[] = [];
  if (Array.isArray(raw.messages)) {
    for (const item of raw.messages) {
      const message = normaliseConversationMessage(item);
      if (message) messages.push(message);
    }
  }
  const { match: _match, ...rest } = summary;
  void _match;
  return { ...rest, messages };
}

export interface ListConversationsQuery {
  limit?: number;
  offset?: number;
  /** Server-side content search (≤ 200 characters); returns `match` snippets. */
  q?: string;
}

/** `GET /api/chat/conversations[?q=]`. */
export async function listConversations(
  query: ListConversationsQuery = {},
  signal?: AbortSignal,
): Promise<ChatConversationList> {
  const q = typeof query.q === 'string' ? Array.from(query.q.trim()).slice(0, 200).join('') : '';
  const raw = await request<unknown>('GET', 'chat/conversations', {
    query: { limit: query.limit ?? 50, offset: query.offset, q: q || undefined },
    signal,
  });
  return normaliseConversationList(raw);
}

/** `GET /api/chat/conversations/{id}`. */
export async function getConversation(conversationId: string, signal?: AbortSignal): Promise<ChatConversation> {
  const raw = await request<unknown>('GET', `chat/conversations/${encodeURIComponent(conversationId)}`, { signal });
  const conversation = normaliseConversation(raw);
  if (!conversation) throw new ApiError(502, 'This conversation could not be read.', raw);
  return conversation;
}

/**
 * `PATCH /api/chat/conversations/{id}` `{title?, pinned?}` (at least one). An 11th pin
 * is 409 `chat_pin_limit` (see {@link apiErrorCode}).
 */
export async function updateConversation(
  conversationId: string,
  patch: ChatConversationUpdateRequest,
): Promise<ChatConversationSummary> {
  const body: ChatConversationUpdateRequest = {};
  if (typeof patch.title === 'string') body.title = patch.title;
  if (typeof patch.pinned === 'boolean') body.pinned = patch.pinned;
  const raw = await request<unknown>('PATCH', `chat/conversations/${encodeURIComponent(conversationId)}`, { body });
  const summary = normaliseConversationSummary(raw);
  if (!summary) throw new ApiError(502, 'The updated conversation could not be read.', raw);
  const { match: _match, ...rest } = summary;
  void _match;
  return rest;
}

/** `DELETE /api/chat/conversations/{id}`. Its report (if any) stays in Reports. */
export async function deleteConversation(conversationId: string): Promise<void> {
  await request<unknown>('DELETE', `chat/conversations/${encodeURIComponent(conversationId)}`);
}

/* -------------------------------------------------------------------------- */
/* Reports (SPEC §9.2).                                                        */
/* -------------------------------------------------------------------------- */

export function normaliseReportListEntry(raw: unknown): ReportListEntry | null {
  if (!isObj(raw)) return null;
  const id = safeId(raw.id);
  if (!id) return null;
  return {
    id,
    title: text(raw.title, CHAT_LIMITS.report_title_chars) || 'Untitled report',
    template: enumOr<ReportTemplateName, ReportTemplateName>(raw.template, REPORT_TEMPLATES, 'custom'),
    conversation_id: safeId(raw.conversation_id),
    item_count: count(raw.item_count, 0),
    created_at: optStr(raw.created_at),
    updated_at: str(raw.updated_at),
    version: count(raw.version, 0),
    has_summary: raw.has_summary === true,
  };
}

function normaliseReportItem(raw: unknown): ReportItem | null {
  if (!isObj(raw)) return null;
  const id = safeId(raw.id);
  const kind = enumOr(raw.kind, REPORT_ITEM_KINDS, null);
  if (!id || !kind) return null;
  const source = isObj(raw.source) ? raw.source : {};
  const scope = isObj(raw.scope) ? raw.scope : {};
  const blockId = source.block_id;
  return {
    id,
    kind,
    // Raw on purpose: renderers re-validate it with `parseBlocks()` (G9).
    block: raw.block,
    note: optText(raw.note, CHAT_LIMITS.report_note_chars, true),
    source: {
      conversation_id: safeId(source.conversation_id) ?? '',
      message_id: safeId(source.message_id) ?? '',
      block_id: typeof blockId === 'string' && BLOCK_ID_RE.test(blockId) ? blockId : null,
    },
    scope: {
      window: optText(scope.window, 80),
      sources: strings(scope.sources, 20, () => true).map((s) => text(s, 120)).filter(Boolean),
      generated_by: optText(scope.generated_by, 120),
      app_version: optText(scope.app_version, 40),
      demo: scope.demo === true,
    },
    added_at: str(raw.added_at),
  };
}

function normaliseReportSummary(raw: unknown): ReportSummary | null {
  if (!isObj(raw)) return null;
  const summary = text(raw.executive_summary, 1200, true);
  const usage = normaliseTurnUsage(raw.usage);
  if (!summary || !usage) return null;
  const steps: string[] = [];
  if (Array.isArray(raw.next_steps)) {
    for (const step of raw.next_steps) {
      const line = text(step, 300);
      if (line) steps.push(line);
      if (steps.length >= 5) break;
    }
  }
  return {
    executive_summary: summary,
    next_steps: steps,
    model: optText(raw.model, 120),
    usage,
    generated_at: str(raw.generated_at),
    based_on_version: count(raw.based_on_version, 0),
  };
}

export function normaliseReport(raw: unknown): Report | null {
  if (!isObj(raw)) return null;
  const id = safeId(raw.id);
  if (!id) return null;
  const items: ReportItem[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      const item = normaliseReportItem(entry);
      if (item && !items.some((i) => i.id === item.id)) items.push(item);
      if (items.length >= CHAT_LIMITS.report_items) break;
    }
  }
  return {
    id,
    owner: text(raw.owner, 120),
    title: text(raw.title, CHAT_LIMITS.report_title_chars) || 'Untitled report',
    template: enumOr<ReportTemplateName, ReportTemplateName>(raw.template, REPORT_TEMPLATES, 'custom'),
    conversation_id: safeId(raw.conversation_id),
    items,
    summary: normaliseReportSummary(raw.summary),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
    version: count(raw.version, 0),
  };
}

function reportOrThrow(raw: unknown): Report {
  const report = normaliseReport(isObj(raw) && isObj(raw.report) ? raw.report : raw);
  if (!report) throw new ApiError(502, 'The report could not be read.', raw);
  return report;
}

/** `GET /api/reports` (summaries; accepts a bare array or `{reports: [...]}`). */
export async function listReports(signal?: AbortSignal): Promise<ReportListEntry[]> {
  const raw = await request<unknown>('GET', 'reports', { signal });
  const rows = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.reports) ? raw.reports : [];
  const out: ReportListEntry[] = [];
  for (const row of rows) {
    const entry = normaliseReportListEntry(row);
    if (entry && !out.some((r) => r.id === entry.id)) out.push(entry);
  }
  return out;
}

/** `POST /api/reports` (at 100 reports the server refuses a new one). */
export async function createReport(body: ReportCreateRequest = {}): Promise<Report> {
  return reportOrThrow(await request<unknown>('POST', 'reports', { body }));
}

/** `GET /api/reports/{id}`. */
export async function getReport(reportId: string, signal?: AbortSignal): Promise<Report> {
  return reportOrThrow(await request<unknown>('GET', `reports/${encodeURIComponent(reportId)}`, { signal }));
}

/** `PATCH /api/reports/{id}`; 409 `report_version_conflict` when `expected_version` is stale. */
export async function patchReport(reportId: string, body: ReportPatchRequest): Promise<Report> {
  return reportOrThrow(await request<unknown>('PATCH', `reports/${encodeURIComponent(reportId)}`, { body }));
}

/** `DELETE /api/reports/{id}` with the strict-CAS `expected_version` body. */
export async function deleteReport(reportId: string, expectedVersion: number): Promise<void> {
  await request<unknown>('DELETE', `reports/${encodeURIComponent(reportId)}`, {
    body: { expected_version: expectedVersion },
  });
}

/** What `POST /api/reports/add` returns, read leniently. */
export interface ReportAddResult {
  report: Report;
  /** The new item's id when the server names it (else the last item's id). */
  itemId: string | null;
}

/**
 * `POST /api/reports/add` — BY REFERENCE only (a persisted Workspace message, plus a
 * block id for one block or none for the whole answer). Creates the conversation's
 * draft on first add when `reportId` is absent. 404 when not owned, 409
 * `block_unavailable` (trimmed/expired) or `report_full` (40 items).
 */
export async function addToReport(input: {
  conversationId: string;
  messageId: string;
  blockId?: string | null;
  reportId?: string | null;
}): Promise<ReportAddResult> {
  const body: Record<string, string> = { conversation_id: input.conversationId, message_id: input.messageId };
  if (input.blockId) body.block_id = input.blockId;
  if (input.reportId) body.report_id = input.reportId;
  const raw = await request<unknown>('POST', 'reports/add', { body });
  const report = reportOrThrow(raw);
  const named = isObj(raw) ? (safeId(raw.item_id) ?? (isObj(raw.item) ? safeId(raw.item.id) : null)) : null;
  return { report, itemId: named ?? report.items.at(-1)?.id ?? null };
}

/** `POST /api/reports/{id}/summary?dry_run=1`: the token/cost estimate, no model call. */
export async function estimateReportSummary(reportId: string, signal?: AbortSignal): Promise<ReportSummaryEstimate> {
  const raw = await request<unknown>('POST', `reports/${encodeURIComponent(reportId)}/summary`, {
    query: { dry_run: 1 },
    body: {},
    signal,
  });
  const src = isObj(raw) ? raw : {};
  return {
    prompt_tokens: count(src.prompt_tokens, 0),
    max_output_tokens: count(src.max_output_tokens, 0),
    total_tokens: count(src.total_tokens, 0),
    cost: amount(src.cost),
    simulated: src.simulated === true,
    model: optText(src.model, 120),
  };
}

/** What a summary generation returns: the updated report and/or the summary itself. */
export interface ReportSummaryResult {
  report: Report | null;
  summary: ReportSummary | null;
}

/**
 * `POST /api/reports/{id}/summary`: one model call (single-flight per report; a second
 * click is 409 or the cached result). Send the same `idempotencyKey` on a retry.
 */
export async function generateReportSummary(
  reportId: string,
  input: { idempotencyKey?: string | null; expectedVersion?: number | null } = {},
): Promise<ReportSummaryResult> {
  const body: Record<string, string | number> = {};
  if (input.idempotencyKey) body.idempotency_key = input.idempotencyKey;
  if (typeof input.expectedVersion === 'number') body.expected_version = input.expectedVersion;
  const raw = await request<unknown>('POST', `reports/${encodeURIComponent(reportId)}/summary`, { body });
  const report = normaliseReport(isObj(raw) && isObj(raw.report) ? raw.report : raw);
  const summary =
    report?.summary ?? normaliseReportSummary(isObj(raw) && isObj(raw.summary) ? raw.summary : raw);
  return { report, summary };
}
