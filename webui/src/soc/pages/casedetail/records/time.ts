/**
 * The case records' one time format (Round 16 SPEC §4.5 WP14): to the second, in UTC, so
 * an event, a ledger call and a trace step line up when read side by side.
 */

/** "2026-11-20 10:00:05 UTC"; the recorded text when it is not a time. */
export function eventTime(ts: string | null | undefined): string {
  const ms = ts ? Date.parse(ts) : Number.NaN;
  if (!Number.isFinite(ms)) return ts || 'Time not recorded';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
