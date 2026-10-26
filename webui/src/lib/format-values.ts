/**
 * Page value formatting (Round 14, SPEC §4.9.5): durations, overages and case labels.
 *
 * Reach these through `@/lib/format` (it re-exports them). They live in their own module
 * on purpose: `format.ts` is an ENTRY module (the shell imports `humanizeToken` from it),
 * and Rollup puts a function defined in an entry module into the entry chunk as soon as
 * any lazy page imports it. A module that `format.ts` only re-exports stays in the lazy
 * chunks that use it (measured with this repository's Rollup 4), so these helpers cost
 * the first paint nothing (SPEC §3.4).
 *
 * Pure and defensive, like everything in `format.ts`: a missing or unusable value comes
 * back as the shared placeholder rather than a throw or a raw number.
 */

/** The neutral placeholder for a missing value (the same mark as `format.ts` `DASH`). */
const MISSING = '—';

/**
 * A duration in minutes as days, hours and minutes, largest two units only:
 * `45` is "45m", `135` is "2h 15m", `9900` is "6d 21h" (never "165h"). Under a minute is
 * "<1m"; a negative, non-finite or non-numeric value is the placeholder.
 */
export function fmtDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return MISSING;
  if (minutes < 1) return '<1m';
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const restMinutes = total % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * How far past a target something is, in plain words: `18613` minutes is "12d 22h over"
 * (never "+18613m"), `8124` is "5d 15h over". Zero or less is not an overage and reads
 * "Within target"; a non-finite or non-numeric value is the placeholder.
 */
export function fmtOverage(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return MISSING;
  if (minutes <= 0) return 'Within target';
  return `${fmtDuration(minutes)} over`;
}

/** The identifying fields a case label can be built from (a Case, a list row, a ref). */
export interface CaseLabelSource {
  case_id?: string | null;
  case_number?: string | null;
  display_id?: string | null;
}

/**
 * How a case is named on screen: always its case number ("CASE-000045"), then the
 * display id a list row carries, and only as the last resort the internal id. Never an
 * empty string while any of the three is present; the placeholder when none is.
 */
export function caseLabel(source: CaseLabelSource | null | undefined): string {
  if (!source) return MISSING;
  for (const value of [source.case_number, source.display_id, source.case_id]) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) return text;
  }
  return MISSING;
}
