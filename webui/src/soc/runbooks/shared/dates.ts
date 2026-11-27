/**
 * Dates on runbook surfaces (Round 14, SPEC §4.10.5, §4.10.12): "Oct 29, 2026", the review
 * due words ("in 4 days", "Due today", "Overdue") and a short published stamp. Times are
 * shown in the viewer's display zone. Pure helpers with an injectable clock for tests.
 *
 * Review dates are compared by calendar day in the viewer's zone, so a review due at
 * 00:30 tomorrow reads "in 1 day" at 23:00 today, never "Due today".
 */

const DAY_MS = 86_400_000;

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Local midnight of the day holding `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Whole calendar days from `now` to `ms` in the viewer's zone: 0 the same day, 1 tomorrow,
 * -1 yesterday. Rounded, so a day that is 23 or 25 hours long (a clock change) still counts
 * as one.
 */
export function calendarDaysFrom(ms: number, now: number): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
}

/** "Oct 29, 2026"; the stored text when it is not a date; "" when absent. */
export function formatDay(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return iso ?? '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso ?? '';
  }
}

export type ReviewDue = 'overdue' | 'today' | 'soon' | 'later';

/** Where a review date stands against `now` by calendar day: overdue, today, within 14 days, or later. */
export function reviewDueState(iso: string | null | undefined, now: number = Date.now()): ReviewDue | null {
  const ms = parse(iso);
  if (ms === null) return null;
  const days = calendarDaysFrom(ms, now);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 14) return 'soon';
  return 'later';
}

/** "Overdue", "Due today", "in 4 days", "in 1 day"; "" when there is no date. */
export function reviewDueWords(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = parse(iso);
  if (ms === null) return '';
  const days = calendarDaysFrom(ms, now);
  if (days < 0) return 'Overdue';
  if (days === 0) return 'Due today';
  return `in ${days.toLocaleString()} ${days === 1 ? 'day' : 'days'}`;
}

/** True when a review is due now or overdue (the library's Needs attention count). */
export function isReviewDue(iso: string | null | undefined, now: number = Date.now()): boolean {
  const state = reviewDueState(iso, now);
  return state === 'overdue' || state === 'today';
}
