/**
 * Round 15 (SPEC D6.12, D8.2): the case workspace's read of one case's auto-close review
 * state (`GET /api/cases/{id}/review`), so it can show the pending band, make Start review
 * the primary action and offer "Review this auto-close" only where a review can be
 * recorded. Read only for a case the agent closed (`enabled`), again when `refreshKey`
 * changes (a recorded review, a `case.review` frame, a status change).
 *
 * A failed read leaves the last answer for the same case in place (or null, "unknown",
 * when there is none); the review endpoint stays the authority either way. Reading
 * changes nothing (#3).
 */
import * as React from 'react';

import type { CaseReviewState } from '@/lib/types-reviews';

export type CaseReviewFetcher = (caseId: string, signal?: AbortSignal) => Promise<CaseReviewState>;

/**
 * `GET /api/cases/{id}/review`. The review client is imported on use, so the case
 * workspace never lists it among the chunks its route preloads (§3.1).
 */
export const fetchCaseReviewState: CaseReviewFetcher = (caseId, signal) =>
  import('@/lib/api-reviews').then((reviews) => reviews.getCaseReviewState(caseId, signal));

export function useCaseReviewState(
  caseId: string | null,
  enabled: boolean,
  refreshKey: unknown = 0,
  fetcher: CaseReviewFetcher = fetchCaseReviewState,
): CaseReviewState | null {
  const [entry, setEntry] = React.useState<{ caseId: string; data: CaseReviewState } | null>(null);
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  React.useEffect(() => {
    if (!caseId || !enabled) return undefined;
    const controller = new AbortController();
    // Through a resolved promise, so a client that throws synchronously is a failed read
    // like any other, never an error in the render tree.
    Promise.resolve()
      .then(() => fetcherRef.current(caseId, controller.signal))
      .then((data) => {
        if (!controller.signal.aborted && data && data.case_id === caseId) setEntry({ caseId, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setEntry((current) => (current && current.caseId === caseId ? current : null));
      });
    return () => controller.abort();
  }, [caseId, enabled, refreshKey]);

  return enabled && caseId && entry && entry.caseId === caseId ? entry.data : null;
}
