/**
 * The AI investigation run on a case, if one is queued or running (Round 16 SPEC §4.3
 * WP01 stub; WP09 backs it with the investigation store, the `case.investigation`
 * frames and `GET /api/investigations/active`). Until then it always answers `null`.
 */
import type { InvestigationView } from '@/lib/types';

export function useAiRun(caseId: string | null | undefined): InvestigationView | null {
  void caseId;
  return null;
}
