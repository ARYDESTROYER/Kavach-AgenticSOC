/**
 * Round 15 auto-close review client (SPEC D6.6, D6.12). Lazy-only: imported by the
 * review card and its case hooks, the Agent effectiveness module and the Case Manager
 * Review scope, never by an entry module (§3.1).
 */
import { request } from './api';
import type { Case, CasesResponse } from './types';
import type {
  AutoCloseReviewMetrics,
  AutoCloseReviewSummary,
  CaseReviewState,
  ReviewBody,
  ReviewQueueState,
  ReviewResult,
} from './types-reviews';

/**
 * `POST /api/cases/{id}/review`: record a person's review of an automatic close
 * (`cases:write`). `409 review_not_agent_closed` for any other case,
 * `409 review_already_recorded` for a second review of a sampled case. The case's status,
 * decider and disposition never change.
 */
export function recordReview(caseId: string, body: ReviewBody, signal?: AbortSignal): Promise<ReviewResult> {
  return request<ReviewResult>('POST', `cases/${encodeURIComponent(caseId)}/review`, { body, signal });
}

/**
 * `GET /api/cases/{id}/review` (`cases:read`): the case's place in the review sample and
 * whether a review can be recorded now (Round 15 WP7, D8.2). Reads change nothing.
 */
export function getCaseReviewState(caseId: string, signal?: AbortSignal): Promise<CaseReviewState> {
  return request<CaseReviewState>('GET', `cases/${encodeURIComponent(caseId)}/review`, { signal });
}

/** `GET /api/auto-close-review/summary` (`cases:read`): the Review scope badge. */
export function getAutoCloseReviewSummary(signal?: AbortSignal): Promise<AutoCloseReviewSummary> {
  return request<AutoCloseReviewSummary>('GET', 'auto-close-review/summary', { signal });
}

/**
 * `GET /api/metrics/auto-close-review` (`metrics:view`): the Agent effectiveness module
 * over the cases sampled in `window` (a time window token such as `now-30d`).
 */
export function getAutoCloseReviewMetrics(window?: string, signal?: AbortSignal): Promise<AutoCloseReviewMetrics> {
  return request<AutoCloseReviewMetrics>('GET', 'metrics/auto-close-review', {
    query: window ? { window } : undefined,
    signal,
  });
}

/** The Review scope page of `GET /api/cases` (echoes `review_applied`). */
export interface ReviewCaseList extends CasesResponse {
  review_applied?: ReviewQueueState;
}

/**
 * `GET /api/cases?review=`: one page of the Review scope. Other queue filters apply on
 * top; the total is exact.
 */
export function listReviewCases(
  review: ReviewQueueState,
  query: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<ReviewCaseList> {
  return request<ReviewCaseList>('GET', 'cases', { query: { ...query, review }, signal });
}

/** Re-export for callers that render the queue rows. */
export type { Case };
