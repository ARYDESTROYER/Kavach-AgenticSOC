/**
 * The AI investigation run on a case, if one is queued or running and past the 1 s
 * hold-off (Round 16 SPEC §4.5 WP09), from the investigation store (`store.ts`): the
 * `case.investigation` frames, `GET /api/investigations/active` and a non-blocking
 * Reinvestigate's `202`. A finished run is not returned here; `useAiRunFinished` has it.
 */
import type { InvestigationView } from '@/lib/types';

import { useInvestigations, type FinishedRun } from './store';

export function useAiRun(caseId: string | null | undefined): InvestigationView | null {
  return useInvestigations((s) => (caseId ? s.byCase.get(caseId) ?? null : null), Boolean(caseId));
}

/** The last finished run on a case, for two minutes after this console saw it end. */
export function useAiRunFinished(caseId: string | null | undefined): FinishedRun | null {
  return useInvestigations((s) => (caseId ? s.finished.get(caseId) ?? null : null), Boolean(caseId));
}

/** How many of `caseIds` have a run queued or running (past the hold-off). */
export function useAiRunCount(caseIds: readonly string[] | null | undefined): number {
  return useInvestigations(
    (s) => (caseIds ? caseIds.reduce((n, id) => n + (s.byCase.has(id) ? 1 : 0), 0) : 0),
    Boolean(caseIds && caseIds.length),
  );
}
