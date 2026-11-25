/**
 * Metric explanations client (Round 16 SPEC §4.5 WP12). Lazy-only: imported by the
 * dashboard explainers, never by an entry module. Every call goes through the shared
 * request helper, which keeps the 401, step-up and error contract of every other call.
 */
import { request } from './api';
import type { ExplainedMetric, MetricExplainResponse } from './types-metrics-explain';

/**
 * `GET /api/metrics/explain`: the cases behind one dashboard figure. `windowHours` 0 is
 * all time; the Active Risk Index is always all time.
 */
export function getMetricExplain(
  metric: ExplainedMetric,
  windowHours: number,
  signal?: AbortSignal,
): Promise<MetricExplainResponse> {
  return request<MetricExplainResponse>('GET', 'metrics/explain', {
    query: { metric, window_hours: Math.max(0, Math.floor(windowHours)) },
    signal,
  });
}
