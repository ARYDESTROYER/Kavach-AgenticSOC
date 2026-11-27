/**
 * Round 14 dashboards client (SPEC §4.4.2). Lazy-only: imported by dashboard boards
 * and widgets, never by an entry module (§3.4). Personal board create and update keep
 * using `api.dashboards.*` (their bodies gained the optional `derived_from` and
 * `default_window` fields in `types.ts`).
 */
import { request } from './api';
import type { MetricsBreakdown, MetricsBreakdownQuery } from './types-dashboards';

/** The server's defaults for the optional breakdown parameters (SPEC §4.4.2). */
export const BREAKDOWN_QUERY_DEFAULTS = { kind: 'cases', window: 'now-7d', top: 10 } as const;

/**
 * The query in its canonical order, with the server's defaults filled in and empty
 * values dropped, so semantically equal queries share one key and one fetch (SPEC
 * §4.4.3): `{by: 'severity'}` and `{kind: 'cases', by: 'severity', window: 'now-7d',
 * top: 10}` are the same read.
 */
export function breakdownQueryKey(query: MetricsBreakdownQuery): string {
  const ordered: Array<[string, unknown]> = [
    ['kind', query.kind ?? BREAKDOWN_QUERY_DEFAULTS.kind],
    ['by', query.by],
    ['then', query.then],
    ['window', query.window || BREAKDOWN_QUERY_DEFAULTS.window],
    ['bucket', query.bucket],
    ['top', query.top ?? BREAKDOWN_QUERY_DEFAULTS.top],
    ['filter_rule', query.filter_rule],
    ['status_group', query.status_group],
  ];
  return ordered
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/**
 * `GET /api/metrics/breakdown` (gate `metrics:view`, `cost:view` for `kind=usage`).
 * No model call and no raw rows. With row-level data scope on, case breakdowns answer
 * `409 breakdown_scope_unsupported`.
 */
export function getMetricsBreakdown(
  query: MetricsBreakdownQuery,
  signal?: AbortSignal,
): Promise<MetricsBreakdown> {
  return request<MetricsBreakdown>('GET', 'metrics/breakdown', {
    query: query as unknown as Record<string, unknown>,
    signal,
  });
}
