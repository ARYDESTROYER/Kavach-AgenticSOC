/**
 * Round 16 (SPEC §4.5 WP14): the case records client. Lazy-only: imported by the case
 * records kit (`soc/pages/casedetail/records/`) and the trace, never by an entry module,
 * so none of it ships at first paint (§3.1). Every call goes through the shared request
 * helpers, so the 401, step-up and error contract is the same as everywhere else.
 *
 * * `GET /api/cases/{id}/events` (`cases:read` and `sources:read`): the raw records
 *   behind a case, read again from its source, a page at a time.
 * * `GET /api/cases/{id}/usage` (`cases:read` and `cost:view`): the case's ledger rows.
 * * `GET /api/cases/{id}/forwarding` (`cases:read`): why a case did or did not go to an
 *   investigation.
 * * `GET /api/cases/{id}/export?format=json` (`cases:read`): the stored case, its spend
 *   withheld without `cost:view`.
 *
 * Every value these return can carry source- or person-controlled text: callers render
 * it as text nodes, `InlineCode`, `CodeBlock` or `JsonTree` only (#9).
 */
import { request } from './api';
import type { CaseEventsPage, CaseUsagePage } from './types';

const base = (caseId: string) => `cases/${encodeURIComponent(caseId)}`;

/** The largest events page the server serves (`CASE_EVENTS_MAX_LIMIT`). */
export const CASE_EVENTS_MAX_LIMIT = 200;
/** The events page size the case reads by default. */
export const CASE_EVENTS_PAGE = 50;

/** `GET /api/cases/{id}/events`: one page of the case's member events. */
export function getCaseEvents(
  caseId: string,
  opts: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {},
): Promise<CaseEventsPage> {
  const limit = Math.max(1, Math.min(CASE_EVENTS_MAX_LIMIT, Math.floor(opts.limit ?? CASE_EVENTS_PAGE)));
  const query: Record<string, unknown> = { limit };
  if (opts.cursor) query.cursor = opts.cursor;
  return request<CaseEventsPage>('GET', `${base(caseId)}/events`, { query, signal: opts.signal });
}

/** `GET /api/cases/{id}/usage`: the case's ledger rows, newest first (at most 500). */
export function getCaseUsage(caseId: string, signal?: AbortSignal): Promise<CaseUsagePage> {
  return request<CaseUsagePage>('GET', `${base(caseId)}/usage`, { signal });
}

/**
 * `GET /api/cases/{id}/forwarding`: which deterministic gate sent the case to an
 * investigation or kept it waiting. `routing_total`, `risk_floor` and
 * `routing_gate_applied` are additive (absent on an older server).
 */
export interface CaseForwarding {
  case_id: string;
  /** `ignored`, `suppressed`, `background_scan`, `severity_floor`, `auto_correlate`,
   * `risk_floor`, `forwarded`, or `unknown` when the events are no longer readable. */
  gate: string;
  forwarded: boolean;
  dropped: boolean;
  /** The server's own sentence over configuration and flags (no log text). */
  sentence: string;
  source_id?: string | null;
  is_alert?: boolean;
  notes?: string[];
  routing_total?: number | null;
  risk_floor?: number | null;
  routing_gate_applied?: boolean;
}

export function getCaseForwarding(caseId: string, signal?: AbortSignal): Promise<CaseForwarding> {
  return request<CaseForwarding>('GET', `${base(caseId)}/forwarding`, { signal });
}

/** `GET /api/cases/{id}/export?format=json`: the stored case as a JSON document. */
export interface CaseRecordExport {
  filename: string;
  content_type: string;
  /** The exact JSON text the server wrote (Copy and Download take it unchanged). */
  content: string;
}

export function getCaseRecord(caseId: string, signal?: AbortSignal): Promise<CaseRecordExport> {
  return request<CaseRecordExport>('GET', `${base(caseId)}/export`, { query: { format: 'json' }, signal });
}
