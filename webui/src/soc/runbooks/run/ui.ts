/**
 * Shared class strings of the run view (Round 14, SPEC §4.10.11).
 *
 * A control that cannot act right now stays focusable and keeps its hint
 * (`aria-disabled` with `aria-describedby`), so it must also look unavailable.
 */
export const ARIA_DISABLED_LOOK = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60';
