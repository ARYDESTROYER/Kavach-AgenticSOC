/**
 * Round 14 audit log client (SPEC §4.5.5, §4.5.6). Lazy-only: imported by the Audit
 * page and its parts, never by an entry module, so none of these calls ships at first
 * paint (§3.4). Every call goes through the shared request helper, which keeps the
 * 401, step-up re-authentication and error contract of every other call.
 *
 * The legacy `api.audit.list` keeps its signature for existing callers; new code uses
 * these functions and the types in `types-audit.ts`.
 */
import { request } from './api';
import type { BackgroundJob } from './types';
import type {
  AuditCount,
  AuditCountQuery,
  AuditExportJobParams,
  AuditPage,
  AuditPageQuery,
  AuditRecord,
} from './types-audit';

/** Largest count the export dialog asks for: one past the 100,000-row export ceiling. */
export const AUDIT_COUNT_CAP = 100_001;

/**
 * `GET /api/audit` in the Round 14 shape: one page of records plus honest totals.
 * Pass the opaque `next_cursor` of the previous page as `cursor` for "Load more"; an
 * expired cursor answers `409 audit_cursor_expired` and the page reloads from the top.
 */
export function listAuditPage(query: AuditPageQuery, signal?: AbortSignal): Promise<AuditPage> {
  return request<AuditPage>('GET', 'audit', {
    query: query as unknown as Record<string, unknown>,
    signal,
  });
}

/** `GET /api/audit/count`: exact up to `cap` (default and maximum 100,001), then `gte`. */
export function countAudit(query: AuditCountQuery, signal?: AbortSignal): Promise<AuditCount> {
  const cap = Math.min(Math.max(1, Math.trunc(query.cap ?? AUDIT_COUNT_CAP)), AUDIT_COUNT_CAP);
  return request<AuditCount>('GET', 'audit/count', {
    query: { ...query, cap } as unknown as Record<string, unknown>,
    signal,
  });
}

/** `GET /api/audit/records/{record_id}`; `404 audit_record_not_found` when it is not in the store. */
export function getAuditRecord(recordId: string, signal?: AbortSignal): Promise<AuditRecord> {
  return request<AuditRecord>('GET', `audit/records/${encodeURIComponent(recordId)}`, { signal });
}

/**
 * Submit the `audit_export` job (`POST /api/jobs`). The server asks for a fresh
 * sign-in first (the shared step-up flow opens the re-authentication dialog), answers
 * `429 job_busy` when this person already has one running, and records the request
 * in the audit log. Keep one `idempotencyKey` per user intent across retries.
 */
export function submitAuditExport(
  params: AuditExportJobParams,
  idempotencyKey: string,
): Promise<BackgroundJob> {
  return request<BackgroundJob>('POST', 'jobs', {
    body: {
      kind: 'audit_export',
      idempotency_key: idempotencyKey,
      params: params as unknown as Record<string, unknown>,
    },
  });
}
