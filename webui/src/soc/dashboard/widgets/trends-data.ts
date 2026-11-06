/**
 * Pure readers of a `GET /api/metrics/trends` answer for the board widgets (Round 14).
 * No React, no chart code, so a widget that only needs these facts stays small.
 */
import type { MetricsTrendBucket, MetricsTrends } from '@/lib/types';

export function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Why a trends answer cannot draw the board's window, or null when it can. */
export function trendsGap(trends: MetricsTrends, windowHours: number): string | null {
  const served = finiteOrNull(trends.window_hours);
  if (served != null && served + 0.5 < windowHours) {
    return 'Trends cover at most the last 30 days. Pick a shorter window to see them.';
  }
  return null;
}

/** Whether every bucket reports the closer split (an older server omits it: not zero). */
export function trendsSplitReported(buckets: readonly MetricsTrendBucket[]): boolean {
  return (
    buckets.length > 0 &&
    buckets.every((b) => finiteOrNull(b.human_closed) != null && finiteOrNull(b.system_closed) != null)
  );
}

