/**
 * The words a screen reader hears for a case's AI investigation run (Round 16 SPEC
 * §4.3 WP01 stub; WP09 fills it). The Case Manager queue row appends this text to its
 * accessible name (for example ", AI investigation running, started 40 seconds ago").
 *
 * Returns `null` when there is nothing to say: no run, or (until WP09 lands) always.
 * Entry-safe: a pure function with no imports beyond types.
 */
import type { InvestigationView } from '@/lib/types';

export function aiRunAccessibleText(view: InvestigationView | null, now: number): string | null {
  void view;
  void now;
  return null;
}
