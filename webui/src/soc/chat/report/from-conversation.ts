/**
 * "Save conversation as report" (Round 12 SPEC D11, SYNTHESIS-chat P0-7): the thread
 * menu's call to `POST /api/reports/from-conversation`.
 *
 * The server resolves every item from the persisted, caller-owned conversation (each
 * answer becomes one section, in order, up to the report's item limit); the client sends
 * only the conversation id and an idempotency key, never content. The key belongs to
 * ONE save action: a retry of that action (after a network error or a 503) reuses it and
 * gets the same report back instead of a duplicate, while a later deliberate save makes a
 * new key and so a new report (the server keeps a deleted report deleted for its key).
 *
 * Everything the response carries is untrusted and re-validated by `normaliseReport`.
 */
import { ApiError, request } from '@/lib/api';
import type { Report } from '@/lib/types';

import { isSafeChatId, normaliseReport } from '../chat-api';
import { reportErrorCode, reportErrorMessage } from './report-sync';

/** What a save returns: the report, how many items it holds and how many answers did not fit. */
export interface ConversationReportResult {
  report: Report;
  items: number;
  /** Answers that did not fit in the report (its item limit). */
  skipped: number;
  /** False when the same save was already done (an idempotent replay). */
  created: boolean;
}

/** Backend `ReportFromConversationRequest.idempotency_key` grammar (8–128). */
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** A fresh idempotency key for one save action. */
export function newConversationReportKey(): string {
  let random = '';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') random = crypto.randomUUID();
  } catch {
    random = '';
  }
  if (!random) random = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `conv-report:${random}`.slice(0, 128);
}

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;

/**
 * `POST /api/reports/from-conversation`. Throws the API error unchanged (read it with
 * {@link conversationReportErrorMessage}); throws a 502 when the reply holds no report.
 */
export async function saveConversationAsReport(input: {
  conversationId: string;
  idempotencyKey?: string | null;
  title?: string | null;
  template?: string | null;
}): Promise<ConversationReportResult> {
  if (!isSafeChatId(input.conversationId)) throw new ApiError(422, 'That conversation is not available.', null);
  const body: Record<string, string> = { conversation_id: input.conversationId };
  if (input.idempotencyKey && KEY_RE.test(input.idempotencyKey)) body.idempotency_key = input.idempotencyKey;
  if (input.title) body.title = input.title;
  if (input.template) body.template = input.template;
  const raw = await request<unknown>('POST', 'reports/from-conversation', { body });
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const report = normaliseReport(src.report ?? raw);
  if (!report) throw new ApiError(502, 'The report could not be read.', raw);
  return {
    report,
    items: count(src.items, report.items.length),
    skipped: count(src.skipped, 0),
    created: src.created !== false,
  };
}

/** Whether trying the same save again could help (a network error, a 5xx, a timeout). */
export function conversationReportRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/** Plain copy for a failed save. */
export function conversationReportErrorMessage(error: unknown): string {
  switch (reportErrorCode(error)) {
    case 'report_empty':
      return 'This conversation has no answers to save yet.';
    case 'conversation_not_found':
      return 'This conversation is no longer available.';
    case 'chat_history_unavailable':
      return 'Chat history is temporarily unavailable. Try again in a moment.';
    case 'report_not_found':
      return 'That report was deleted. Save the conversation again to make a new one.';
    default:
      return reportErrorMessage(error, 'The conversation could not be saved as a report. Try again.');
  }
}

/** "4 sections" / "1 section" plus the answers that did not fit, for the toast. */
export function conversationReportSummary(result: Pick<ConversationReportResult, 'items' | 'skipped'>): string {
  const parts = [`${result.items} ${result.items === 1 ? 'section' : 'sections'}`];
  if (result.skipped > 0) {
    parts.push(`${result.skipped} ${result.skipped === 1 ? 'answer' : 'answers'} did not fit`);
  }
  return parts.join(' · ');
}
