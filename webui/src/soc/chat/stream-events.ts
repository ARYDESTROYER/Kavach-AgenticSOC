/**
 * Chat stream events (chat revamp SPEC §6.2) — the client mirror of
 * `backend/app/agents/chat_events.py`, pinned to `chat-stream-events.contract.json`
 * by `__tests__/chat-stream-events.contract.test.ts`.
 *
 * `POST /api/chat/stream` answers with NDJSON: one JSON event per line. Order:
 * `turn.start` first; then any `step.start` / `step.end` / `usage` / `text.delta` /
 * `text.reset` / `ping`; then exactly ONE of `turn.done` (its `response` is the
 * persisted `ChatResponse`, the truth the UI renders) or `turn.error`, always last.
 *
 * Every line is UNTRUSTED input (#9): {@link parseStreamEvent} never throws, drops a
 * malformed or unknown line (returns `null`), coerces a drifted enum to its fallback,
 * and display-sanitises every string a renderer will show (BLOCKS.md amendment 4).
 *
 * This module also owns {@link displayText} — the ONE display sanitiser for chat
 * strings — so the Workspace route chunk can sanitise without pulling in the lazy
 * blocks module (`blocks/schema.ts` re-exports it).
 */
import type {
  ChatAnswerKind,
  ChatBudgetState,
  ChatCitation,
  ChatCitationKind,
  ChatOrigin,
  ChatResponse,
  ChatScope,
  ChatStep,
  ChatStepBasis,
  ChatStepKind,
  ChatStepStatus,
  ChatStreamMode,
  ConsoleLink,
  MemoryProposal,
  MemoryProposalOp,
  ReportItemKind,
  ReportTemplateName,
  StepUsage,
  TextStreamingReason,
  TurnNotice,
  TurnNoticeKind,
  TurnUsage,
} from '@/lib/types';
import { isPageId } from '@/soc/nav';
import { isSafeCaseResultStatus } from '@/soc/case-result-route';

/* -------------------------------------------------------------------------- */
/* Display sanitiser (shared with blocks/schema.ts and the backend).           */
/* -------------------------------------------------------------------------- */

/**
 * Invisible / reordering code points stripped from every displayed chat string: the
 * Unicode Default_Ignorable_Code_Point set plus the controls and separators that
 * render as nothing or reorder text — C0 except TAB/LF/CR, DEL, C1, soft hyphen,
 * combining grapheme joiner, ALM, Hangul fillers, Khmer inherent vowels, Mongolian
 * variation selectors + vowel separator, zero-width space/joiners, LRM/RLM,
 * line/paragraph separators, bidi embeddings/overrides/isolates, word joiner +
 * invisible operators, variation selectors, BOM, reserved specials, interlinear
 * annotations, shorthand-format and musical format controls, and the TAG block +
 * variation-selector supplement (U+E0000–E0FFF, used for "ASCII smuggling").
 * Identical to the backend `INVISIBLE_TEXT_RANGES` (pinned by the answer-blocks
 * contract file). Three ranges are astral, hence the `\u{…}` escapes below.
 */
export const INVISIBLE_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

// `\u{…}` (with the `u` flag) addresses ANY code point. A four-digit `\uXXXX` would
// silently turn U+E0000 into "U+E000 followed by 0".
const codePointEscape = (n: number): string => `\\u{${n.toString(16)}}`;
/** The ranges as a regex character-class body (exported for the contract tests). */
export const INVISIBLE_TEXT_CLASS = INVISIBLE_TEXT_RANGES.map(([lo, hi]) =>
  lo === hi ? codePointEscape(lo) : `${codePointEscape(lo)}-${codePointEscape(hi)}`,
).join('');
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_TEXT_CLASS}]`, 'gu');
// With the `u` flag this class matches only UNPAIRED surrogate halves (a valid
// astral character is one code point), mirroring the backend.
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/gu;
const LINE_BREAKS_RE = /[\t\r\n]+/g;
export const ELLIPSIS = '…';

export interface DisplayTextOptions {
  /** Keep line breaks (normalised to `\n`) instead of folding them to one space. */
  multiline?: boolean;
}

/**
 * Make a value safe to DISPLAY: strip invisible/bidi/control characters, fold line
 * breaks unless `multiline`, trim a single-line value, and clamp to `limit` code
 * points with a trailing ellipsis. Never linkifies, never throws. Non-text values
 * (objects, functions, symbols) become `''`; finite numbers and booleans are
 * stringified.
 */
export function displayText(value: unknown, limit = 60, options: DisplayTextOptions = {}): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') text = String(value);
  else return '';
  text = text.replace(INVISIBLE_RE, '').replace(LONE_SURROGATE_RE, '');
  if (options.multiline) {
    text = text.replace(/\r\n?/g, '\n');
  } else {
    text = text.replace(LINE_BREAKS_RE, ' ').trim();
  }
  if (limit > 0) {
    const chars = Array.from(text);
    if (chars.length > limit) {
      text = chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd() + ELLIPSIS;
    }
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* Protocol constants and enums (pinned by the contract file).                 */
/* -------------------------------------------------------------------------- */
export const CHAT_STREAM_PROTOCOL_VERSION = 1;
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
export const PING_INTERVAL_S = 10;
export const MAX_TEXT_DELTA_CHARS = 4000;

export const CHAT_STREAM_EVENT_TYPES = [
  'turn.start',
  'step.start',
  'step.end',
  'usage',
  'text.delta',
  'text.reset',
  'turn.done',
  'turn.error',
  'ping',
] as const;
export type ChatStreamEventType = (typeof CHAT_STREAM_EVENT_TYPES)[number];
export const TERMINAL_EVENT_TYPES = ['turn.done', 'turn.error'] as const;

export const TURN_ERROR_CODES = [
  'provider_unavailable',
  'budget_blocked',
  'breaker_open',
  'history_unavailable',
  'internal',
] as const;
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];

export const CHAT_STREAM_MODES = ['steps', 'text'] as const satisfies readonly ChatStreamMode[];
export const CHAT_SCOPES = [
  'logs',
  'cases',
  'metrics',
  'intel',
  'docs',
  'platform',
] as const satisfies readonly ChatScope[];
export const CHAT_ORIGINS = [
  'user',
  'follow_up',
  'starter',
  'command',
  'continue',
] as const satisfies readonly ChatOrigin[];
export const CHAT_STEP_KINDS = ['tool', 'model'] as const satisfies readonly ChatStepKind[];
export const CHAT_STEP_STATUSES = [
  'ok',
  'error',
  'denied',
  'timeout',
  'skipped',
  'cancelled',
] as const satisfies readonly ChatStepStatus[];
export const CHAT_STEP_BASES = ['exact', 'newest_n', 'sample', 'cached'] as const satisfies readonly ChatStepBasis[];
export const CHAT_ANSWER_KINDS = [
  'data',
  'product_help',
  'mixed',
  'conversation',
] as const satisfies readonly ChatAnswerKind[];
export const TURN_NOTICE_KINDS = [
  'partial',
  'cap',
  'budget',
  'provider',
  'breaker',
  'denied',
  'timeout',
  'cancelled',
  'unsupported',
  'not_saved',
] as const satisfies readonly TurnNoticeKind[];
export const CHAT_CITATION_KINDS = [
  'doc',
  'case',
  'knowledge',
  'mitre',
  'query',
] as const satisfies readonly ChatCitationKind[];
export const MEMORY_PROPOSAL_OPS = ['add', 'remove'] as const satisfies readonly MemoryProposalOp[];
export const CHAT_BUDGET_STATES = ['ok', 'approaching', 'reached'] as const satisfies readonly ChatBudgetState[];
export const TEXT_STREAMING_REASONS = [
  'disabled_by_admin',
  'model_does_not_stream',
] as const satisfies readonly TextStreamingReason[];
export const REPORT_TEMPLATES = [
  'investigation',
  'hunt',
  'ioc',
  'shift',
  'posture',
  'custom',
] as const satisfies readonly ReportTemplateName[];
export const REPORT_ITEM_KINDS = ['block', 'section'] as const satisfies readonly ReportItemKind[];
/**
 * The severity axis (palette `SEVERITY_COLOR`). Defined here, not in the lazy blocks
 * schema (which re-exports it), so console-link options can be checked against the
 * enum in the route chunk; pinned by the answer-blocks contract file.
 */
export const SEVERITY_KEYS = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type SeverityKey = (typeof SEVERITY_KEYS)[number];

/** What a drifted value becomes (identical on the backend). */
export const STREAM_FALLBACKS = {
  step_kind: 'tool',
  step_status: 'error',
  answer_kind: 'conversation',
  notice_kind: 'partial',
  turn_error_code: 'internal',
} as const;

/** Display bounds shared with the backend models. */
export const CHAT_LIMITS = {
  follow_ups: 3,
  follow_up_chars: 140,
  notice_message_chars: 400,
  step_label_chars: 120,
  step_summary_chars: 600,
  step_query_chars: 4096,
  step_params: 12,
  memory_proposal_chars: 500,
  chat_prompts: 50,
  chat_prompt_title_chars: 60,
  chat_prompt_text_chars: 2000,
  time_range_max_days: 90,
  report_items: 40,
  report_note_chars: 500,
  report_title_chars: 120,
} as const;

/* -------------------------------------------------------------------------- */
/* Event types.                                                                */
/* -------------------------------------------------------------------------- */
/** What a step announces before it runs; its final shape arrives in `step.end`. */
export interface StepStartInfo {
  index: number;
  ordinal: number | null;
  kind: ChatStepKind;
  tool: string | null;
  label: string;
  params: Record<string, string | number | boolean | null>;
  group: number | null;
}

export interface TurnStartEvent {
  type: 'turn.start';
  turn_id: string;
  conversation_id: string | null;
  model: string | null;
  stream_mode: ChatStreamMode;
  /** A completed-key replay: `turn.done` follows with no model call. */
  replayed: boolean;
  estimate: { prompt_tokens: number };
}
export interface StepStartEvent {
  type: 'step.start';
  step: StepStartInfo;
}
export interface StepEndEvent {
  type: 'step.end';
  step: ChatStep;
}
export interface UsageEvent {
  type: 'usage';
  /** Running totals for the turn so far. */
  totals: TurnUsage;
}
export interface TextDeltaEvent {
  type: 'text.delta';
  text: string;
}
export interface TextResetEvent {
  type: 'text.reset';
}
export interface TurnDoneEvent {
  type: 'turn.done';
  /** The persisted response; render this, not the streamed state. */
  response: ChatResponse;
}
export interface TurnErrorEvent {
  type: 'turn.error';
  code: TurnErrorCode;
  message: string;
  retryable: boolean;
  notice: TurnNotice | null;
}
export interface PingEvent {
  type: 'ping';
}

export type ChatStreamEvent =
  | TurnStartEvent
  | StepStartEvent
  | StepEndEvent
  | UsageEvent
  | TextDeltaEvent
  | TextResetEvent
  | TurnDoneEvent
  | TurnErrorEvent
  | PingEvent;

/* Type guards. */
export const isTurnStart = (e: ChatStreamEvent): e is TurnStartEvent => e.type === 'turn.start';
export const isStepStart = (e: ChatStreamEvent): e is StepStartEvent => e.type === 'step.start';
export const isStepEnd = (e: ChatStreamEvent): e is StepEndEvent => e.type === 'step.end';
export const isUsage = (e: ChatStreamEvent): e is UsageEvent => e.type === 'usage';
export const isTextDelta = (e: ChatStreamEvent): e is TextDeltaEvent => e.type === 'text.delta';
export const isTextReset = (e: ChatStreamEvent): e is TextResetEvent => e.type === 'text.reset';
export const isTurnDone = (e: ChatStreamEvent): e is TurnDoneEvent => e.type === 'turn.done';
export const isTurnError = (e: ChatStreamEvent): e is TurnErrorEvent => e.type === 'turn.error';
export const isPing = (e: ChatStreamEvent): e is PingEvent => e.type === 'ping';
/** `turn.done` or `turn.error`: the stream's last line. */
export const isTerminalEvent = (e: ChatStreamEvent): e is TurnDoneEvent | TurnErrorEvent =>
  e.type === 'turn.done' || e.type === 'turn.error';

/* -------------------------------------------------------------------------- */
/* Lenient field helpers.                                                      */
/* -------------------------------------------------------------------------- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function enumOr<T extends string, F>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if ((allowed as readonly string[]).includes(v)) return v as T;
  }
  return fallback;
}

/** A finite non-negative integer, else `fallback`. */
function count(value: unknown, fallback: number): number;
function count(value: unknown, fallback: null): number | null;
function count(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** A finite non-negative number, else `fallback`. */
function amount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optText(value: unknown, limit: number, multiline = false): string | null {
  if (typeof value !== 'string') return null;
  return displayText(value, limit, { multiline }) || null;
}

function optId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

const PARAM_KEY_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CITATION_ID_RE = /^[A-Z][0-9]{1,3}$/;
const CONSOLE_LINK_ID_RE = /^[a-z0-9_]{1,40}:[a-z0-9_.-]{1,80}$/;
const GRANT_RE = /^[a-z_]{1,40}:[a-z_]{1,40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DOC_REF_RE = /^\/docs\/\d+\.\d+\/[a-z0-9/_-]+\/?(#[a-z0-9_-]+)?$/;
const TECHNIQUE_RE = /^T\d{4}(\.\d{3})?$/;
const CASE_ID_RE = /^[A-Za-z0-9_.:@ /-]{1,128}$/;
const ROUTE_TOKEN_RE = /^[A-Za-z0-9_.:@ -]{1,128}$/;
const NAV_OPT_TOKEN_KEYS = ['tab', 'section', 'anchor'] as const;

/** Run-log chips: safe keys, scalar values, sanitised text, ≤ 12 entries. */
export function displayParams(
  value: unknown,
  { chars = 120, stringsOnly = false }: { chars?: number; stringsOnly?: boolean } = {},
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!isObj(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= CHAT_LIMITS.step_params) break;
    if (!PARAM_KEY_RE.test(key)) continue;
    if (typeof raw === 'string') out[key] = displayText(raw, chars);
    else if (stringsOnly) {
      if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = displayText(String(raw), chars);
    } else if (raw === null || typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function stringList(value: unknown, limit: number, chars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = displayText(item, chars);
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Lenient normalisers (also used for history replay of persisted answers).    */
/* -------------------------------------------------------------------------- */
export function normaliseStepUsage(raw: unknown): StepUsage | null {
  if (!isObj(raw)) return null;
  return {
    input_tokens: count(raw.input_tokens, 0),
    cache_read_tokens: count(raw.cache_read_tokens, 0),
    cache_write_tokens: count(raw.cache_write_tokens, 0),
    output_tokens: count(raw.output_tokens, 0),
    cost: amount(raw.cost, 0),
    latency_ms: count(raw.latency_ms, 0),
    estimated: raw.estimated === true,
    embedding_calls: count(raw.embedding_calls, 0),
    embedding_tokens: count(raw.embedding_tokens, 0),
    embedding_cost: amount(raw.embedding_cost, 0),
  };
}

export function normaliseTurnUsage(raw: unknown): TurnUsage | null {
  if (!isObj(raw)) return null;
  return {
    calls: count(raw.calls, 0),
    embedding_calls: count(raw.embedding_calls, 0),
    input_tokens: count(raw.input_tokens, 0),
    cache_read_tokens: count(raw.cache_read_tokens, 0),
    cache_write_tokens: count(raw.cache_write_tokens, 0),
    output_tokens: count(raw.output_tokens, 0),
    total_tokens: count(raw.total_tokens, 0),
    cost: amount(raw.cost, 0),
    latency_ms: count(raw.latency_ms, 0),
    model: optText(raw.model, 120),
    pricing_source: optText(raw.pricing_source, 60),
    simulated: raw.simulated === true,
    estimated: raw.estimated === true,
    context_window: count(raw.context_window, null),
    peak_prompt_tokens: count(raw.peak_prompt_tokens, 0),
  };
}

/** A run-log step, or `null` when it has no usable index (dropped). */
export function normaliseChatStep(raw: unknown): ChatStep | null {
  if (!isObj(raw)) return null;
  const index = count(raw.index, null);
  if (index === null) return null;
  const ordinal = count(raw.ordinal, null);
  return {
    index,
    ordinal: ordinal !== null && ordinal >= 1 ? ordinal : null,
    kind: enumOr(raw.kind, CHAT_STEP_KINDS, STREAM_FALLBACKS.step_kind),
    tool: typeof raw.tool === 'string' && TOOL_NAME_RE.test(raw.tool) ? raw.tool : null,
    label: displayText(raw.label, CHAT_LIMITS.step_label_chars),
    params: displayParams(raw.params),
    // An unknown stored status reads as a failure, never as a silent success.
    status: enumOr(raw.status, CHAT_STEP_STATUSES, STREAM_FALLBACKS.step_status),
    duration_ms: count(typeof raw.duration_ms === 'number' ? Math.trunc(raw.duration_ms) : raw.duration_ms, 0),
    summary: displayText(raw.summary, CHAT_LIMITS.step_summary_chars),
    untrusted_params: displayParams(raw.untrusted_params, { chars: 200, stringsOnly: true }) as Record<
      string,
      string
    >,
    query: optText(raw.query, CHAT_LIMITS.step_query_chars, true),
    rows: count(raw.rows, null),
    basis: enumOr(raw.basis, CHAT_STEP_BASES, null),
    coverage: optText(raw.coverage, 200),
    sources: stringList(raw.sources, 20, 120),
    usage: normaliseStepUsage(raw.usage),
    group: count(raw.group, null),
  };
}

export function normaliseNotice(raw: unknown): TurnNotice | null {
  if (!isObj(raw)) return null;
  return {
    kind: enumOr(raw.kind, TURN_NOTICE_KINDS, STREAM_FALLBACKS.notice_kind),
    message: displayText(raw.message, CHAT_LIMITS.notice_message_chars),
    retryable: raw.retryable === true,
  };
}

/** A citation, or `null` when its id/kind/target is invalid (dropped). */
export function normaliseCitation(raw: unknown): ChatCitation | null {
  if (!isObj(raw)) return null;
  const id = raw.id;
  const kind = enumOr(raw.kind, CHAT_CITATION_KINDS, null);
  const title = displayText(raw.title, 200);
  if (typeof id !== 'string' || !CITATION_ID_RE.test(id) || kind === null || !title) return null;
  const doc = typeof raw.doc === 'string' && DOC_REF_RE.test(raw.doc) ? raw.doc : null;
  const caseId = typeof raw.case_id === 'string' && CASE_ID_RE.test(raw.case_id) ? raw.case_id : null;
  const technique =
    typeof raw.technique === 'string' && TECHNIQUE_RE.test(raw.technique.trim().toUpperCase())
      ? raw.technique.trim().toUpperCase()
      : null;
  // Mirrors the backend: a citation is only useful with the target its kind names.
  if ((kind === 'doc' && !doc) || (kind === 'case' && !caseId) || (kind === 'mitre' && !technique)) return null;
  return {
    id,
    kind,
    title,
    untrusted: raw.untrusted !== false,
    doc,
    case_id: caseId,
    technique,
    snippet: optText(raw.snippet, 280, true),
  };
}

/**
 * A console link, or `null` when malformed. Fails closed: only `allowed === true`
 * navigates. Re-validated with the SAME guards as a block's in-app ref (the router's
 * `isPageId` / `isSafeCaseResultStatus`, the severity enum), so the client is never
 * weaker than the server: an unknown page drops the link, an invalid option is
 * dropped on its own.
 */
export function normaliseConsoleLink(raw: unknown): ConsoleLink | null {
  if (!isObj(raw)) return null;
  const label = displayText(raw.label, 80);
  if (typeof raw.id !== 'string' || !CONSOLE_LINK_ID_RE.test(raw.id)) return null;
  if (typeof raw.page !== 'string' || !isPageId(raw.page) || !label) return null;
  const opts: Record<string, string | number> = {};
  if (isObj(raw.opts)) {
    for (const key of NAV_OPT_TOKEN_KEYS) {
      const v = raw.opts[key];
      if (typeof v === 'string' && ROUTE_TOKEN_RE.test(v)) opts[key] = v;
    }
    const status = raw.opts.status;
    if (typeof status === 'string' && isSafeCaseResultStatus(status)) opts.status = status;
    const severity = raw.opts.severity;
    if (typeof severity === 'string' && (SEVERITY_KEYS as readonly string[]).includes(severity)) {
      opts.severity = severity;
    }
    const caseId = raw.opts.caseId;
    if (typeof caseId === 'string' && CASE_ID_RE.test(caseId)) opts.caseId = caseId;
    const window = raw.opts.window;
    if (typeof window === 'number' && Number.isInteger(window) && window >= 1 && window <= 720) opts.window = window;
  }
  return {
    id: raw.id,
    label,
    page: raw.page,
    opts,
    allowed: raw.allowed === true,
    requires: typeof raw.requires === 'string' && GRANT_RE.test(raw.requires) ? raw.requires : null,
  };
}

export function normaliseMemoryProposal(raw: unknown): MemoryProposal | null {
  if (!isObj(raw)) return null;
  const op = enumOr(raw.op, MEMORY_PROPOSAL_OPS, null);
  if (op === null) return null;
  const text = optText(raw.text, CHAT_LIMITS.memory_proposal_chars);
  const ids = Array.isArray(raw.ids)
    ? raw.ids.filter((i): i is string => typeof i === 'string' && SAFE_ID_RE.test(i)).slice(0, 20)
    : [];
  if (op === 'add' && !text) return null;
  if (op === 'remove' && ids.length === 0) return null;
  return { op, text, ids };
}

function list<T>(value: unknown, fn: (raw: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const parsed = fn(item);
    if (parsed !== null) out.push(parsed);
    if (out.length >= limit) break;
  }
  return out;
}

/** The legacy memory echo / suggestion objects, display-sanitised (or `null`). */
function normaliseMemoryAction(raw: unknown): ChatResponse['memory_action'] {
  if (!isObj(raw) || typeof raw.op !== 'string') return null;
  const op = displayText(raw.op, 20);
  if (!op) return null;
  const out: NonNullable<ChatResponse['memory_action']> = { op };
  const text = optText(raw.text, CHAT_LIMITS.memory_proposal_chars);
  if (text) out.text = text;
  if (Array.isArray(raw.ids)) {
    out.ids = raw.ids.filter((i): i is string => typeof i === 'string' && SAFE_ID_RE.test(i)).slice(0, 20);
  }
  return out;
}

function normaliseMemorySuggestion(raw: unknown): ChatResponse['memory_suggestion'] {
  if (!isObj(raw)) return null;
  const text = optText(raw.text, CHAT_LIMITS.memory_proposal_chars);
  if (!text) return null;
  const reason = optText(raw.reason, CHAT_LIMITS.memory_proposal_chars);
  return reason ? { text, reason } : { text };
}

/**
 * Lenient client-side normalisation of a `ChatResponse` (a `turn.done` payload or
 * a persisted message's `response`). `null` only when there is no string `answer`.
 * Revamp fields are coerced exactly like the backend's lenient replay, and EVERY
 * displayed string — the answer prose and the pre-revamp scalars (title, model and
 * source names, query, memory echoes) included — goes through {@link displayText}
 * (BLOCKS.md amendment 4), so the final answer reads exactly like the `text.delta`
 * stream it replaces. `blocks` and the legacy `table` stay raw — run `parseBlocks()`
 * / `legacyTableBlock()` on them.
 */
export function normaliseChatResponse(raw: unknown): ChatResponse | null {
  if (!isObj(raw) || typeof raw.answer !== 'string') return null;
  const out: ChatResponse = { ...(raw as unknown as ChatResponse) };
  // Prose keeps its line breaks and its length (the server bounds it); only the
  // invisible/bidi/control characters go, exactly as on the live text.delta path.
  out.answer = displayText(raw.answer, 0, { multiline: true });
  if ('conversation_title' in raw) out.conversation_title = optText(raw.conversation_title, 120);
  if ('effective_model' in raw) out.effective_model = optText(raw.effective_model, 120);
  if ('effective_source_id' in raw) out.effective_source_id = optText(raw.effective_source_id, 128);
  if ('effective_source_name' in raw) out.effective_source_name = optText(raw.effective_source_name, 120);
  if ('query' in raw) out.query = optText(raw.query, CHAT_LIMITS.step_query_chars, true);
  if ('case_id' in raw) {
    out.case_id = typeof raw.case_id === 'string' && CASE_ID_RE.test(raw.case_id) ? raw.case_id : null;
  }
  if ('idempotency_key' in raw) out.idempotency_key = optId(raw.idempotency_key);
  if ('conversation_id' in raw) out.conversation_id = optId(raw.conversation_id);
  if ('memory_action' in raw) out.memory_action = normaliseMemoryAction(raw.memory_action);
  if ('memory_suggestion' in raw) out.memory_suggestion = normaliseMemorySuggestion(raw.memory_suggestion);
  out.blocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, 12) : [];
  out.blocks_version = count(raw.blocks_version, 1) || 1;
  out.steps = list(raw.steps, normaliseChatStep, 64);
  out.usage = normaliseTurnUsage(raw.usage);
  out.citations = list(raw.citations, normaliseCitation, 40);
  out.console_links = list(raw.console_links, normaliseConsoleLink, 12);
  out.follow_ups = stringList(raw.follow_ups, CHAT_LIMITS.follow_ups, CHAT_LIMITS.follow_up_chars);
  out.answer_kind = enumOr(raw.answer_kind, CHAT_ANSWER_KINDS, STREAM_FALLBACKS.answer_kind);
  out.notice = normaliseNotice(raw.notice);
  out.stream_mode = enumOr(raw.stream_mode, CHAT_STREAM_MODES, null);
  out.turn_id = optId(raw.turn_id);
  out.message_id = optId(raw.message_id);
  out.memory_proposal = normaliseMemoryProposal(raw.memory_proposal);
  out.cost = out.usage ? out.usage.cost : amount(raw.cost, 0);
  return out;
}

function normaliseStepStart(raw: unknown): StepStartInfo | null {
  if (!isObj(raw)) return null;
  const index = count(raw.index, null);
  if (index === null) return null;
  const ordinal = count(raw.ordinal, null);
  return {
    index,
    ordinal: ordinal !== null && ordinal >= 1 ? ordinal : null,
    kind: enumOr(raw.kind, CHAT_STEP_KINDS, STREAM_FALLBACKS.step_kind),
    tool: typeof raw.tool === 'string' && TOOL_NAME_RE.test(raw.tool) ? raw.tool : null,
    label: displayText(raw.label, CHAT_LIMITS.step_label_chars),
    params: displayParams(raw.params),
    group: count(raw.group, null),
  };
}

/* -------------------------------------------------------------------------- */
/* The tolerant line parser.                                                   */
/* -------------------------------------------------------------------------- */
function toEvent(payload: Obj): ChatStreamEvent | null {
  switch (payload.type) {
    case 'turn.start': {
      const turnId = optId(payload.turn_id);
      if (!turnId) return null;
      const estimate = isObj(payload.estimate) ? count(payload.estimate.prompt_tokens, 0) : 0;
      return {
        type: 'turn.start',
        turn_id: turnId,
        conversation_id: optId(payload.conversation_id),
        model: optText(payload.model, 120),
        stream_mode: enumOr(payload.stream_mode, CHAT_STREAM_MODES, 'steps'),
        replayed: payload.replayed === true,
        estimate: { prompt_tokens: estimate },
      };
    }
    case 'step.start': {
      const step = normaliseStepStart(payload.step);
      return step ? { type: 'step.start', step } : null;
    }
    case 'step.end': {
      const step = normaliseChatStep(payload.step);
      return step ? { type: 'step.end', step } : null;
    }
    case 'usage': {
      const totals = normaliseTurnUsage(payload.totals);
      return totals ? { type: 'usage', totals } : null;
    }
    case 'text.delta':
      // Prose is rendered by the Markdown subset renderer, which applies its own
      // rules; here only invisible characters are stripped (line breaks are kept).
      return typeof payload.text === 'string'
        ? { type: 'text.delta', text: displayText(payload.text, 0, { multiline: true }) }
        : null;
    case 'text.reset':
      return { type: 'text.reset' };
    case 'turn.done': {
      const response = normaliseChatResponse(payload.response);
      return response ? { type: 'turn.done', response } : null;
    }
    case 'turn.error':
      return {
        type: 'turn.error',
        code: enumOr(payload.code, TURN_ERROR_CODES, STREAM_FALLBACKS.turn_error_code),
        message: displayText(payload.message, 400),
        retryable: payload.retryable === true,
        notice: normaliseNotice(payload.notice),
      };
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

/**
 * Parse ONE NDJSON line into a typed event. Returns `null` for a blank, malformed,
 * oversized-garbage or unknown line. Never throws.
 */
export function parseStreamEvent(line: unknown): ChatStreamEvent | null {
  try {
    if (typeof line !== 'string') return null;
    const text = line.trim();
    if (!text) return null;
    const payload: unknown = JSON.parse(text);
    return isObj(payload) ? toEvent(payload) : null;
  } catch {
    return null;
  }
}
