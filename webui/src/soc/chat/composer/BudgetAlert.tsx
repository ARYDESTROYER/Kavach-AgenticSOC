/**
 * BudgetAlert — the single composer-level budget alert (SPEC §10.3 notice placement, §8).
 *
 * INTERFACE STUB (orchestrator). WP-I2b owns and replaces the body; keep the export.
 */
import type { ChatContextInfo } from '@/lib/types';

export interface BudgetAlertProps {
  context: ChatContextInfo | null;
}

export function BudgetAlert({ context }: BudgetAlertProps) {
  if (!context?.budget_state || context.budget_state === 'ok') return null;
  return <p role="note">Daily AI budget: {context.budget_state}</p>;
}
