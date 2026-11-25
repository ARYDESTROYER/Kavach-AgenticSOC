/**
 * One rounding rule for every shown score (Round 16 SPEC §4.5 WP11, research
 * explainability D4 and R7).
 *
 * A score is shown as an integer rounded half up (`floor(x + 0.5)`), the same rule as the
 * server's `app/utils.round_half_up`, and its band is the band of that shown integer, so a
 * 73.6 case reads "74" and is painted critical everywhere. `explain.contract.json` pins
 * the vectors on both ends. Presentation only: `decide()` compares the unrounded score.
 *
 * Reached through `@/lib/format` (a re-export) and the explain builders. Its own module, so
 * the entry chunk never carries it.
 */
import { scoreBand, type ScoreBand } from '@/soc/components/palette';

/** Round half up to an integer: 80.5 is 81, 73.5 is 74, 47.5 is 48. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** A 0 to 100 score as the integer the Console shows, or null for a missing value. */
export function displayScore(score: unknown): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, roundHalfUp(score)));
}

/** The band of the shown integer (critical from 74, high from 48, medium from 22). */
export function displayBand(score: number): ScoreBand {
  return scoreBand(displayScore(score) ?? 0);
}

/**
 * A number with at most `digits` decimals and no trailing zeros: 94.45 is "94.45", 100 is
 * "100", 75.5 is "75.5". Thousands are grouped.
 */
export function trimmed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return 'not a number';
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** A number with exactly `digits` decimals: 1 is "1.00", 0.2 is "0.20". */
export function fixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return 'not a number';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** A 0..1 fraction as a percentage with at most one decimal: 0.9654 is "96.5%". */
export function percentOf(fraction: number, digits = 1): string {
  return `${trimmed(fraction * 100, digits)}%`;
}

/** An integer count with thousands separators: 48210 is "48,210". */
export function count(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'not a number';
}
