/**
 * The Explain builders (Round 16 SPEC §4.3 WP01 stubs; WP11 fills the bodies).
 *
 * One pure builder per kind of number. Each returns a typed `Explanation` (or `null`
 * when it cannot explain the value honestly) and never renders anything: the Explain
 * kit renders it. Every builder prints the numbers `./explain.contract.json` pins for
 * the server, so the two ends cannot disagree. Until WP11 lands every builder returns
 * `null` and a trigger shows its value unchanged.
 */
import type { Case, CaseUsageRow, StatBlock } from '@/lib/types';
import type { DecisionPayload, TriageChips } from '@/soc/pages/CaseDetail.api';
import type { Explanation } from './types';

/** The server's per-case SLA reading (`GET /api/cases/{id}/triage`, field `sla`). */
export interface SlaReadingWire {
  clock: 'response' | 'resolution' | string;
  start_at: string | null;
  anchor: 'created' | 'acknowledged' | 'status_history' | string;
  responded_at: string | null;
  target_minutes: number | null;
  due_at: string | null;
  elapsed_minutes: number | null;
  state: string;
  priority: string | null;
  priority_source: string | null;
}

/** The risk score of a case: its stored factors, recorded inputs and the weights. */
export function explainRisk(caseRecord: Case, chips?: TriageChips | null): Explanation | null {
  void caseRecord;
  void chips;
  return null;
}

/** How the deterministic decision compared the verdict with the auto-close policy. */
export function explainDecision(caseRecord: Case, decision?: DecisionPayload | null): Explanation | null {
  void caseRecord;
  void decision;
  return null;
}

/** The SLA clock of a case, from the server's reading. */
export function explainSla(reading: SlaReadingWire | null | undefined): Explanation | null {
  void reading;
  return null;
}

/** The ITIL priority: impact by urgency through the priority matrix. */
export function explainPriority(chips: TriageChips | null | undefined): Explanation | null {
  void chips;
  return null;
}

/** The severity chip: source-asserted or derived from the risk score. */
export function explainSeverity(chips: TriageChips | null | undefined): Explanation | null {
  void chips;
  return null;
}

/** A share: a numerator over a denominator, as a percentage. */
export function explainShare(
  numerator: number,
  denominator: number,
  options?: { metric?: string; label?: string },
): Explanation | null {
  void numerator;
  void denominator;
  void options;
  return null;
}

/** A median or other percentile of a distribution, with its samples when given. */
export function explainPercentile(block: StatBlock, samples?: readonly number[]): Explanation | null {
  void block;
  void samples;
  return null;
}

/** A Wilson score interval of `successes` out of `n` (z defaults to 1.96). */
export function explainWilson(successes: number, n: number, z?: number): Explanation | null {
  void successes;
  void n;
  void z;
  return null;
}

/** The cost of a case's AI calls, one formula line per ledger row. */
export function explainCost(rows: readonly CaseUsageRow[]): Explanation | null {
  void rows;
  return null;
}
