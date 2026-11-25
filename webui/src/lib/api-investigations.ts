/**
 * AI investigation runs: the reconcile read (Round 16 SPEC §4.5 WP08 and WP09).
 *
 * The investigation store (`soc/investigations/store.ts`, a lazy chunk the navigation
 * loads after first paint) reads it. It holds the one read and nothing else (the
 * non-blocking Reinvestigate call lives with its dialog). Ids, enums, timestamps and
 * counts only (#7); nothing here decides anything (#3).
 */
import { request } from './api';
import type { InvestigationsActive } from './types';

/**
 * `GET /api/investigations/active` (`cases:read`, memory only): the queued and running
 * runs, the runs that finished in the last two minutes, the count of runs on new events
 * that have no case yet, and the investigation slots in use. `caseId` narrows `items`
 * and `recent` to one case.
 */
export function getActiveInvestigations(caseId?: string | null, signal?: AbortSignal): Promise<InvestigationsActive> {
  return request<InvestigationsActive>('GET', 'investigations/active', {
    query: caseId ? { case_id: caseId } : undefined,
    signal,
  });
}
