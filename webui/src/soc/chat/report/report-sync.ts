/**
 * Report change notifications and shared report copy (chat revamp SPEC §10.6).
 *
 * The chat page adds blocks through `chat-api.addToReport()` while the report panel shows
 * the same report; the panel edits (notes, order, removal) while the transcript shows
 * "In report ✓". Both sides announce every change they make on ONE window event, so each
 * keeps its view current without polling and without a prop channel between lazily
 * loaded chunks:
 *
 *   emitReportChanged({ reportId, conversationId, report })   // after any mutation
 *   const off = onReportChanged((detail) => …)                // returns the unsubscribe
 *
 * A detail carrying `report` is the server's latest copy (no refetch needed); one without
 * it just says "reload". `report === null` with a `reportId` means it was deleted.
 *
 * This module is tiny and dependency-light on purpose: the Workspace route chunk may
 * import it statically.
 */
import { ApiError } from '@/lib/api';
import type { Report } from '@/lib/types';

export const REPORT_CHANGED_EVENT = 'tlsoc:report-changed';

export interface ReportChangedDetail {
  reportId: string | null;
  conversationId?: string | null;
  /** The latest server copy; `null` = deleted; absent = reload it. */
  report?: Report | null;
  /** Who sent it (a panel ignores its own echo). */
  origin?: string;
}

/** Tell every listener a report changed. Safe outside a browser. */
export function emitReportChanged(detail: ReportChangedDetail): void {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<ReportChangedDetail>(REPORT_CHANGED_EVENT, { detail }));
}

/** Listen for report changes; returns the unsubscribe function. */
export function onReportChanged(listener: (detail: ReportChangedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ReportChangedDetail>).detail;
    if (detail && typeof detail === 'object') listener(detail);
  };
  window.addEventListener(REPORT_CHANGED_EVENT, handler);
  return () => window.removeEventListener(REPORT_CHANGED_EVENT, handler);
}

/** `"<message_id>:<block_id>"` (or `"<message_id>:"` for a whole answer). */
export function reportItemKey(messageId: string, blockId?: string | null): string {
  return `${messageId}:${blockId ?? ''}`;
}

/**
 * What a report already holds, keyed by {@link reportItemKey} → item id: the
 * transcript's "In report ✓" state and the item to remove on a second click.
 */
export function reportItemIndex(report: Report | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of report?.items ?? []) {
    out.set(reportItemKey(item.source.message_id, item.kind === 'section' ? null : item.source.block_id), item.id);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Limits and error copy (SPEC §10.6).                                         */
/* -------------------------------------------------------------------------- */

export const MAX_REPORT_ITEMS = 40;
export const MAX_REPORTS = 100;
export const REPORT_FULL_MESSAGE = `Report is full (${MAX_REPORT_ITEMS} items)`;
export const REPORT_LIMIT_MESSAGE = 'Delete a report in Reports to start another';
export const REPORT_CONFLICT_MESSAGE = 'This report changed elsewhere — Reload';

function codeOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object') return null;
  const body = error.body as Record<string, unknown>;
  const detail = body.detail;
  if (detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).code === 'string') {
    return (detail as Record<string, string>).code;
  }
  return typeof body.code === 'string' ? body.code : null;
}

/** The server's error code (`report_version_conflict`, `report_full`, …) or null. */
export function reportErrorCode(error: unknown): string | null {
  return codeOf(error);
}

/** True for the strict-CAS 409 (the report changed in another tab or panel). */
export function isVersionConflict(error: unknown): boolean {
  return codeOf(error) === 'report_version_conflict';
}

/** Operator-facing copy for a report API failure (never the raw server text for 5xx). */
export function reportErrorMessage(error: unknown, fallback = 'The report could not be updated. Try again.'): string {
  switch (codeOf(error)) {
    case 'report_version_conflict':
      return REPORT_CONFLICT_MESSAGE;
    case 'report_full':
      return REPORT_FULL_MESSAGE;
    case 'report_limit':
      return REPORT_LIMIT_MESSAGE;
    case 'block_unavailable':
      return 'That block expired from saved history and can no longer be added';
    case 'report_not_found':
      return 'This report no longer exists';
    case 'report_summary_in_progress':
      return 'A summary for this report is already being written';
    case 'report_summary_rate_limited':
      return 'Summary limit reached (10 per hour). Try again later';
    case 'report_empty':
      return 'Add something to the report before summarising it';
    case 'report_store_unavailable':
      return 'Reports are temporarily unavailable';
    case 'report_conversation_draft_exists':
      return 'This conversation already has a report. Open it from Reports';
    case 'report_item_unknown':
      return 'That item is no longer in the report. Reload it';
    case 'report_item_order_invalid':
      return 'The report changed while you reordered it. Reload it';
    // Summary failures (routes_reports.SUMMARY_FAILURE_MESSAGES): say what happened, and
    // offer a retry only where one can help (a used-up budget or an oversized report
    // will fail the same way again).
    case 'report_too_large_to_summarise':
      return 'This report is too large to summarise. Remove some items first';
    case 'budget_blocked':
      return 'The AI budget is used up, so no summary was written. Raise the budget or try later';
    case 'breaker_open':
      return 'The AI provider is paused after repeated errors. Try again shortly';
    case 'provider_unavailable':
      return 'The AI provider is unavailable or not configured, so no summary was written';
    case 'report_summary_timeout':
      return 'The summary took too long and was stopped. Try again';
    case 'report_summary_invalid':
      return 'The model returned no summary. Try again';
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 404) return 'This report no longer exists';
  return fallback;
}
