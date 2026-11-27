/**
 * Shared `GET /api/rules/summary` and `GET /api/logs?rule=` answers for the rule sheet
 * tests (Round 14, SPEC §4.6.2 and §4.6.4). The shape is the backend's `RuleSummary`.
 */
import type { RuleSummary } from '@/lib/types-rules';
import type { UnifiedLogsResponse } from '@/soc/UnifiedLogs.api';

export const RULE = 'Web scanner user agent detected';

/** A full answer: every section ok, an exact count of 381 from one exact source. */
export function summaryFixture(overrides: Partial<RuleSummary> = {}): RuleSummary {
  return {
    rule: RULE,
    window: { label: 'Last 3 days', from: '2026-10-22T06:00:00+00:00', to: '2026-10-25T06:12:00+00:00' },
    alerts: {
      status: 'ok',
      reason: null,
      count: 381,
      count_relation: 'eq',
      first_seen: '2026-10-22T06:41:00+00:00',
      last_seen: '2026-10-25T06:12:00+00:00',
      series: {
        bucket: '12h',
        levels: ['critical', 'high', 'medium', 'low', 'info'],
        points: [
          { t: '2026-10-22T00:00:00+00:00', critical: 0, high: 3, medium: 28, low: 0, info: 0 },
          { t: '2026-10-22T12:00:00+00:00', critical: 0, high: 0, medium: 58, low: 0, info: 0 },
          { t: '2026-10-23T00:00:00+00:00', critical: 0, high: 0, medium: 49, low: 0, info: 0 },
          { t: '2026-10-23T12:00:00+00:00', critical: 0, high: 0, medium: 66, low: 0, info: 0 },
          { t: '2026-10-24T00:00:00+00:00', critical: 0, high: 0, medium: 72, low: 0, info: 0 },
          { t: '2026-10-24T12:00:00+00:00', critical: 0, high: 0, medium: 61, low: 0, info: 0 },
          { t: '2026-10-25T00:00:00+00:00', critical: 0, high: 0, medium: 44, low: 0, info: 0 },
        ],
      },
      sources: [{ id: 'src-1', name: 'Splunk Enterprise Security (HEC)', exact: true }],
    },
    top_source_ips: {
      status: 'ok',
      reason: null,
      exact: true,
      rows: [
        { value: '198.51.100.77', kind: null, count: 214 },
        { value: '203.0.113.41', kind: null, count: 121 },
      ],
    },
    top_targets: {
      status: 'ok',
      reason: null,
      exact: true,
      rows: [
        { value: 'web-portal', kind: 'host', count: 352 },
        { value: 'svc-scan', kind: 'user', count: 29 },
      ],
    },
    cases: {
      status: 'ok',
      reason: null,
      count: 3,
      open_now: 2,
      outcomes: { analyst_tp: 1, analyst_fp: 1, analyst_ungraded: 1 },
      latest: [
        { case_id: 'case-214', case_number: 'CASE-000214', title: 'Web scanner against web-portal', status: 'new', verdict: 'NEEDS_HUMAN' },
        { case_id: 'case-208', case_number: 'CASE-000208', title: 'Scanner from 203.0.113.41', status: 'escalated', verdict: 'TRUE_POSITIVE' },
        { case_id: 'case-196', case_number: 'CASE-000196', title: 'Approved vulnerability scan', status: 'closed', verdict: 'FALSE_POSITIVE' },
      ],
    },
    definition: { status: 'ok', reason: null, kind: 'source', suite_rule: null },
    tuning: {
      status: 'ok',
      reason: null,
      wilson_lower_bound: 0.12,
      samples: 2,
      proposed_change: null,
      last_tuned: null,
    },
    analyst_policy: { status: 'ok', reason: null, policy: null },
    ...overrides,
  };
}

/** The newest alerts `GET /api/logs?rule=&limit=5` returns for the fixture rule. */
export function latestFixture(count = 2): UnifiedLogsResponse {
  const logs = Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    ts: `2026-10-25T0${6 - i}:12:00Z`,
    source_id: 'src-1',
    source_name: 'Splunk Enterprise Security (HEC)',
    source_ip: i % 2 ? '203.0.113.41' : '198.51.100.77',
    user: null,
    host: 'web-portal',
    rule: RULE,
    severity: 30,
    message: i ? 'sqlmap probe against /login' : 'Nuclei user agent, 412 requests a minute',
    _raw: {},
  }));
  return {
    logs,
    count: logs.length,
    partial: false,
    limit: 5,
    truncated: false,
    sources: [{ source_id: 'src-1', source_name: 'Splunk Enterprise Security (HEC)', ok: true, count: logs.length, mode: 'search', exact: true }],
    filters: { rule: RULE, severity: null, severity_gte: null },
  };
}
