/**
 * Round 14 rule summary client (SPEC §4.6.2). Lazy-only: imported by the rule sheet,
 * never by an entry module (§3.4). The sheet's latest alerts and "Open all N in Logs"
 * use `GET /api/logs?rule=` (`fetchUnifiedLogs`), not this call.
 */
import { request } from './api';
import type { RuleSummary, RuleSummaryQuery } from './types-rules';

/**
 * `GET /api/rules/summary`: one rule's picture. Each section carries its own status
 * (`ok`, `forbidden`, `unsupported`, `unavailable`), so a missing grant degrades one
 * section, never the sheet. No model call (#6), no raw rows (#7).
 */
export function getRuleSummary(query: RuleSummaryQuery, signal?: AbortSignal): Promise<RuleSummary> {
  return request<RuleSummary>('GET', 'rules/summary', {
    query: query as unknown as Record<string, unknown>,
    signal,
  });
}
