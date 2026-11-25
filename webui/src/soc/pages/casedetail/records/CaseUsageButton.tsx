/**
 * The case's investigation cost (Round 16 SPEC §4.3 WP01 stub; WP14 makes it a button
 * that opens the per-call ledger rows from `GET /api/cases/{id}/usage`, each with the
 * cost formula in its own numbers). The stub shows the cost as text, as the facts rail
 * does today, so mounting it changes nothing. The caller shows it only to a holder of
 * `cost:view`.
 */
import type * as React from 'react';
import { fmtMoney } from '@/lib/format';

export interface CaseUsageButtonProps {
  caseId: string;
  totalCost: number | null | undefined;
}

export const CaseUsageButton: React.FC<CaseUsageButtonProps> = ({ totalCost }) =>
  totalCost == null ? null : <>{fmtMoney(totalCost)}</>;
