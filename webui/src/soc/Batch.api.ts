/**
 * Co-located API + types for the async BATCH-inference job viewer (Round 4 / Wave 4).
 *
 * Kept OUT of the shared `lib/api.ts` (parallel-build hygiene) per the co-located
 * `*.api.ts` convention. Endpoint (under `/api`, READ-ONLY, `models:read`):
 *   GET /api/batch/jobs            — list every tracked batch job, newest-submitted
 *                                    first (secret-free, bounded).
 *
 * Surfaces the durable async LLM batch-job registry so an operator can see which
 * low-urgency investigations were routed through a provider's discounted async batch
 * API and how far each has progressed (submit -> poll -> retrieve). Submit/poll/
 * retrieve is driven OUT-OF-BAND by the batch service — this UI only READS.
 *
 * SECURITY (#9): every value (job id / provider / model / state) is PLAIN, attacker-
 * influenceable data the UI renders escaped. No secret is ever returned — a job
 * carries no credential; `provider_batch_id` is the provider's opaque job handle.
 * #6: the batch service writes EXACTLY ONE UsageDoc per result at the discounted
 * rate; this viewer never records a ledger row. #3: a batch job is advisory plumbing
 * and never touches `decide()`.
 */
import { api } from '@/lib/api';

/** The lifecycle of a batch job (mirrors backend `BatchJobState`). */
export type BatchJobState =
  | 'submitted'
  | 'polling'
  | 'retrieving'
  | 'retrieved'
  | 'errored'
  | 'expired'
  | string;

/** The ordered lifecycle states — used for a progress indicator / ordering. */
export const BATCH_STATE_ORDER: readonly BatchJobState[] = [
  'submitted',
  'polling',
  'retrieving',
  'retrieved',
] as const;

/** One batch job row (the secret-free JSON shape from `_job_json`). */
export interface BatchJobRow {
  /** Our job id (bounded PLAIN, #9). */
  id: string;
  /** The provider the batch runs against (e.g. "anthropic"/"openai"). */
  provider: string;
  /** Legacy detail-route field. The unified Jobs projection intentionally omits it. */
  provider_batch_id?: string | null;
  /** A `BatchJobState` value. */
  state: BatchJobState;
  /** The model the batch runs. */
  model: string;
  /** The applied price multiplier (0.5 == 50% off). */
  discount: number;
  /** Total tracked per-request custom_ids in this job. */
  requests: number;
  /** How many of those have been retrieved. */
  retrieved: number;
  /** ISO submit time, or null. */
  submitted_at: string | null;
  /** ISO last-poll time, or null. */
  polled_at: string | null;
  /** Bounded operator-visible submission, ledger, or re-entry failure. */
  last_error?: string | null;
}

/** GET /api/batch/jobs. */
export interface BatchJobsResponse {
  jobs: BatchJobRow[];
  count: number;
}

/** GET /api/batch/jobs (newest-submitted first). */
export function fetchBatchJobs(): Promise<BatchJobsResponse> {
  // Defer through Promise.resolve so a synchronous stub failure surfaces as a
  // rejection (callers wrap this in try/catch).
  return Promise.resolve().then(() => api.get<BatchJobsResponse>('batch/jobs'));
}

export const batchApi = {
  jobs: fetchBatchJobs,
};

/** Badge variant + human label for a batch-job state (controlled tokens, plain text). */
export const BATCH_STATE_META: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'info' | 'secondary' | 'critical' }
> = {
  submitted: { label: 'Submitted', variant: 'secondary' },
  polling: { label: 'Polling', variant: 'info' },
  retrieving: { label: 'Retrieving', variant: 'info' },
  retrieved: { label: 'Retrieved', variant: 'success' },
  errored: { label: 'Errored', variant: 'critical' },
  expired: { label: 'Expired', variant: 'warning' },
};
