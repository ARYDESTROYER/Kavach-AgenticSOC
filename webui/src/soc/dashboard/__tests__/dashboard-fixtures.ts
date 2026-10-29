/**
 * Offline fixtures for the dashboard widget tests (Round 14, SPEC §4.4.3). Shapes follow
 * the Demo answers of the real endpoints (trimmed), so a widget test reads what a board
 * reads. Plain data; no mocking here.
 */
import type { MetricsBreakdown, MetricsBreakdownGroup } from '@/lib/types-dashboards';
import type { NoiseReduction } from '@/lib/types';

/** One breakdown row with every metric present (case kind). */
export function group(key: string | null, count: number, extra: Partial<MetricsBreakdownGroup> = {}): MetricsBreakdownGroup {
  return {
    key,
    then_key: null,
    bucket: null,
    count,
    open_now: count,
    verdicted: count,
    verdict_tp: 0,
    verdict_fp: 0,
    verdict_needs_human: 0,
    analyst_tp: 0,
    analyst_fp: 0,
    analyst_ungraded: count,
    calls: null,
    cost_usd: null,
    ...extra,
  };
}

/** A breakdown answer; `groups` and the window fields are the ones a test cares about. */
export function breakdown(extra: Partial<MetricsBreakdown> = {}): MetricsBreakdown {
  const groups = extra.groups ?? [];
  return {
    kind: 'cases',
    by: 'verdict',
    then: null,
    bucket: null,
    status_group: null,
    window_label: 'Last 24 hours',
    window_from: '2026-10-27T21:00:00Z',
    window_to: '2026-10-28T21:00:00Z',
    total: groups.reduce((a, g) => a + g.count, 0),
    exact: true,
    partial: false,
    partial_reason: null,
    multi_valued: false,
    buckets: [],
    other: null,
    missing_created: 0,
    missing_in_total: false,
    ...extra,
    groups,
  } as MetricsBreakdown;
}

/** Open cases by AI verdict, over every open case (the F4 read). */
export const OPEN_BY_VERDICT: MetricsBreakdown = breakdown({
  by: 'verdict',
  status_group: 'open',
  window_label: 'All time (since 15 Oct 2026)',
  window_from: null,
  window_to: null,
  groups: [
    group('NEEDS_HUMAN', 13, { verdict_needs_human: 13 }),
    group('FALSE_POSITIVE', 1, { verdict_fp: 1 }),
    group('TRUE_POSITIVE', 1, { verdict_tp: 1 }),
  ],
});

/** The noise-reduction answer of a Demo week (counters complete). */
export function noise(extra: Partial<NoiseReduction> & Record<string, unknown> = {}): NoiseReduction {
  const stage = (key: string, label: string, total: number, source = 'cases') => ({
    key,
    label,
    source,
    deterministic: true,
    total,
    by_severity: { critical: 0, high: 0, medium: 0, low: total, info: 0 },
  });
  return {
    window_hours: 168,
    generated_at: '2026-10-28T21:10:25Z',
    bands: ['critical', 'high', 'medium', 'low', 'info'],
    stages: [
      stage('ingested', 'Alerts ingested', 1670, 'counters'),
      stage('clustered', 'After clustering', 380, 'counters'),
      stage('cases', 'Cases opened', 56),
      stage('auto_cleared', 'Auto-cleared by AI', 38),
      stage('escalated', 'Escalated', 18),
      stage('needs_human', 'Needs a human', 9),
      stage('closed', 'Closed by human', 8),
      stage('policy_closed', 'Closed by analyst policy', 0),
    ],
    drops: { suppressed: 0, ignored: 0 },
    reduction: { overall_pct: 94.6, human_reduction_pct: 83.9 },
    counters: { available: true, since: '2026-10-20T00:00:00Z', coverage_start: '2026-10-20T00:00:00Z', incomplete: false },
    cases_meta: { truncated: false, store_total: 56, fetched: 56 },
    events_per_min: 0.17,
    events_per_min_since: '2026-10-21T21:00:00Z',
    events_per_min_reason: null,
    ...extra,
  } as unknown as NoiseReduction;
}

/** A posture answer for the board window (timings partly measured). */
export function posture(extra: Record<string, unknown> = {}) {
  return {
    window_hours: 24,
    generated_at: '2026-10-28T21:10:25Z',
    case_count: 38,
    severity_counts: { critical: 3, high: 3, medium: 0, low: 32, info: 0 },
    open_now: { count: 15, window_exempt: true, as_of: '2026-10-28T21:10:25Z', complete: true, reason: '' },
    lifecycle: {
      mtta_minutes: { p50: '\u2014', p90: '\u2014', mean: '\u2014', max: '\u2014', count: 0, available: false, reason: 'no case has been acknowledged yet' },
      mttr_minutes: { p50: 42, p90: 90, mean: 50, max: 120, count: 33, available: true, reason: '' },
      dwell_minutes: { p50: 60, p90: 120, mean: 70, max: 200, count: 2, available: true, reason: '' },
      mttd_minutes: { p50: 2, p90: 13.9, mean: 5.8, max: 27, count: 8, available: true, reason: '' },
    },
    quality: {
      total_cases: 38,
      verdicted_cases: 38,
      true_positive_cases: 3,
      false_positive_cases: 32,
      needs_human_cases: 3,
      terminal_cases: 33,
      auto_closed_cases: 31,
      human_closed_cases: 2,
      system_closed_cases: 0,
      policy_closed_cases: 0,
      analyst_confirmed_fp: 30,
      automation_rate: 0.9394,
    },
    aging: {
      queue_depth: 5,
      age_buckets: [
        { bucket: '<1h', count: 3 },
        { bucket: '1-4h', count: 1 },
        { bucket: '4-24h', count: 1 },
        { bucket: '1-3d', count: 0 },
        { bucket: '3-7d', count: 0 },
        { bucket: '>7d', count: 0 },
      ],
      oldest: [],
      arrivals: 38,
      closures: 33,
      backlog: 5,
    },
    sla: {
      enabled: true,
      evaluated: 38,
      response_breached: 1,
      resolve_breached: 0,
      attainment_pct: 97.4,
      attainment_reason: '',
      breaching: [],
    },
    truncated: false,
    store_total: 41,
    fetched: 41,
    window_covered: true,
    window_coverage_reason: '',
    compare: { mode: 'prev', case_count: { value: 38, prev: 30, delta_pct: 26.7 } },
    ...extra,
  };
}

export const USAGE = {
  window_hours: 24,
  total_cost: 1.25,
  total_tokens: 9060,
  today_cost: 1.25,
  call_count: 12,
  currency: 'USD',
  by_surface: [
    { key: 'investigate', cost: 1, tokens: 8000, calls: 10 },
    { key: 'chat', cost: 0.25, tokens: 1060, calls: 2 },
  ],
  by_model: [],
  by_role: [],
};

export const BUDGET = {
  enabled: true,
  on_exceed: 'block',
  soft_warn_pct: 0.8,
  currency: 'USD',
  daily: { spent: 1, cap: 10, fraction: 0.1, band: 'ok' },
  monthly: { spent: 12, cap: null, fraction: null, band: 'ok' },
  excluded_surfaces: ['chat'],
  excluded_today: 0.25,
};

export function sourcesHealth(nowMs: number) {
  return {
    sources: [
      { source_id: 's1', source_name: 'Edge firewall', source_type: 'elastic', enabled: true, is_primary: true, ingest_mode: 'pull', kind: 'pull', can_browse: true, buffer_depth: 0, last_poll_millis: nowMs - 60_000, last_event_millis: nowMs - 120_000, events_per_min: 3.2, silent: false, healthy: true },
      { source_id: 's2', source_name: 'Mail gateway', source_type: 'webhook', enabled: true, is_primary: false, ingest_mode: 'push', kind: 'push', can_browse: false, buffer_depth: 0, last_poll_millis: 0, last_event_millis: nowMs - 30 * 3_600_000, events_per_min: 0, silent: true, healthy: false },
      { source_id: 's3', source_name: 'Old sensor', source_type: 'syslog', enabled: false, is_primary: false, ingest_mode: 'push', kind: 'push', can_browse: false, buffer_depth: 0, last_poll_millis: 0, last_event_millis: 0, silent: false },
    ],
  };
}

export const CAMPAIGNS = {
  campaigns: [
    {
      id: 'campaign-1e57287ac9b19e21b96010721158e58e',
      name: '',
      status: 'open',
      case_ids: ['c1', 'c2'],
      case_count: 2,
      entities: [{ entity_type: 'user', value: 'pnair' }],
      mitre: ['T1078'],
      severity_rollup: 'high',
      first_seen: '2026-10-28T21:08:09Z',
      last_seen: '2026-10-28T21:08:09Z',
      created_at: '2026-10-28T21:10:09Z',
    },
  ],
  total: 1,
  enabled: true,
};

/** The telemetry answer of this build: capture itself is not available yet (the server's constant). */
export const TELEMETRY_NONE = {
  status: 'not_available',
  recommendations: [],
  scanned_cases: 77,
  truncated: false,
  evidence_schema: 'telemetry_gap.v1',
  capture_status: 'not_available',
  capture_not_available_reason:
    'Automatic telemetry-gap capture is not available because query tools do not yet emit controlled field-level failure evidence.',
  not_available_reason: 'No query-backed telemetry gap has been recorded. Missing connector configuration alone is not evidence.',
};

/** The deterministic shift report (`GET /api/standup/report`), trimmed. */
export const SHIFT_REPORT = {
  enabled: true,
  window_hours: 0,
  attention_queue: [
    { case_id: 'c-5', case_number: 'CASE-000005', display_id: 'CASE-000005', title: 'user:dsingh · identity_signin', status: 'escalated', verdict: 'NEEDS_HUMAN', risk_score: 64, severity_band: 'high', assignee: 'sgupta', entity: 'dsingh', age_minutes: 1754, urgency: 1.15 },
    { case_id: 'c-14', case_number: 'CASE-000014', display_id: 'CASE-000014', title: 'user:svc_bureau · identity_signin', status: 'investigating', verdict: 'NEEDS_HUMAN', risk_score: 40, severity_band: 'medium', assignee: '', entity: 'svc_bureau', age_minutes: 136, urgency: 0.9 },
  ],
  workload: [
    { analyst: '(unassigned)', open: 4, escalated: 0, needs_human: 0 },
    { analyst: 'sgupta', open: 3, escalated: 2, needs_human: 1 },
  ],
  sla_aging: {
    enabled: true,
    warn_fraction: 0.75,
    totals: { open: 15, breached: 1, about_to_breach: 0 },
    breached: [{ case_id: 'c-5', display_id: 'CASE-000005', priority_level: '', age_minutes: 1754, target_minutes: 120, overdue_minutes: 1634, assignee: 'sgupta' }],
    about_to_breach: [],
  },
  deltas: {},
  action_items: [],
  degraded: [],
};

export const TUNING = {
  enabled: true,
  fp_rate_target: 0.1,
  min_samples: 30,
  rule_noise: [
    { rule_id: 'demo_noisy_scanner', observed: 30, total: 30, analyst_samples: 30, unconfirmed: 0, fp: 30, tp: 0, fp_rate: 0.8865, volume_ewma: 30, over_target: true },
    { rule_id: 'edr_heartbeat', observed: 5, total: 0, analyst_samples: 0, unconfirmed: 5, fp: 0, tp: 0, fp_rate: 0, volume_ewma: 1, over_target: false },
  ],
  recommendations: [],
  applied: [],
};

export const AUTO_CLOSE = {
  window_hours: 24,
  current: { decided: 38, auto_closed: 31, routed_to_human: 7, rate: 0.8158, available: true, reason: '' },
  baseline: { decided: 30, auto_closed: 24, routed_to_human: 6, rate: 0.8, available: true, reason: '' },
  policy: { available: true, any_enabled: true, false_positive_enabled: true, true_positive_enabled: false, reason: '' },
  status: 'steady',
};

export const AGENT_IMPROVEMENT = {
  windows: { current: { days: 7 }, baseline: { days: 28 } },
  metrics: {
    analyst_reported_verdict_agreement: {
      current: { available: false, value: null, sample_count: 4, minimum_sample: 30 },
      baseline: { available: false, value: null, sample_count: 12, minimum_sample: 30 },
    },
    material_analyst_correction_rate: {
      current: { available: false, value: null, sample_count: 4, minimum_sample: 30 },
      baseline: { available: false, value: null, sample_count: 12, minimum_sample: 30 },
    },
  },
};

/** Hourly trend buckets for the last day, with a few cases arriving and closing. */
export function trends(hours = 24) {
  const start = Date.parse('2026-10-27T21:00:00Z');
  const buckets = Array.from({ length: hours }, (_, i) => ({
    t: new Date(start + i * 3_600_000).toISOString(),
    new_cases: i % 6 === 0 ? 3 : 0,
    closed: i % 6 === 1 ? 2 : 0,
    auto_closed: i % 6 === 1 ? 1 : 0,
    human_closed: i % 6 === 1 ? 1 : 0,
    system_closed: 0,
    false_positives: 0,
    analyst_confirmed_fp: 0,
    needs_human: 0,
    escalated: 0,
    sent_to_human: 0,
    fp_rate: null,
    alerts: i % 3 === 0 ? 40 : 10,
  }));
  return { window_hours: hours, bucket_minutes: 60, generated_at: '2026-10-28T21:00:00Z', buckets, truncated: false };
}

export const COVERAGE = {
  corpus_version: 'ATT&CK v17 (enterprise, compact)',
  total_techniques: 697,
  covered_techniques: 6,
  coverage_pct: 0.9,
  invalid_dropped: 0,
  by_tactic: {},
  top_techniques: [
    { id: 'T1078', name: 'Valid Accounts', case_count: 7 },
    { id: 'T1190', name: 'Exploit Public-Facing Application', case_count: 5 },
  ],
  truncated: false,
  window_hours: 24,
};

/** Every `api.get` path a board reads, answered from the fixtures above. */
export function fixtureGet(path: string, nowMs: number = Date.now()): Promise<unknown> {
  switch (path) {
    case 'sources/health':
      return Promise.resolve(sourcesHealth(nowMs));
    case 'standup/report':
      return Promise.resolve(SHIFT_REPORT);
    case 'metrics/auto-close-health/recorded':
      return Promise.resolve(AUTO_CLOSE);
    case 'budget/status':
      return Promise.resolve(BUDGET);
    case 'campaigns':
      return Promise.resolve(CAMPAIGNS);
    case 'tuning/recommendations':
      return Promise.resolve(TUNING);
    case 'tuning/source-recommendations':
      return Promise.resolve(TELEMETRY_NONE);
    default:
      return Promise.reject(new Error(`unexpected GET ${path}`));
  }
}

/** A breakdown answer for any query a board makes. */
export function fixtureBreakdown(q: { kind?: string; by: string; status_group?: string; bucket?: string }): Promise<MetricsBreakdown> {
  if (q.kind === 'usage') {
    return Promise.resolve(
      breakdown({ kind: 'usage', by: 'surface' as never, groups: [group('investigate', 0, { cost_usd: 1, calls: 10 }), group('chat', 0, { cost_usd: 0.25, calls: 2 })] }),
    );
  }
  if (q.by === 'verdict' && q.status_group === 'open') return Promise.resolve(OPEN_BY_VERDICT);
  if (q.bucket) {
    const labels = ['21 Oct 2026', '22 Oct 2026', '23 Oct 2026'];
    const keys = q.by === 'severity' ? ['high', 'low'] : ['TRUE_POSITIVE', 'NEEDS_HUMAN', 'FALSE_POSITIVE'];
    return Promise.resolve(
      breakdown({
        by: q.by as never,
        bucket: q.bucket as never,
        buckets: labels.map((label, i) => ({ label, in_progress: i === labels.length - 1, other_count: null })),
        groups: labels.flatMap((label, i) => keys.map((k, j) => ({ ...group(k, i + j + 1, { verdict_tp: k === 'TRUE_POSITIVE' ? i + j + 1 : 0 }), bucket: label }))),
      }),
    );
  }
  if (q.by === 'rule') {
    return Promise.resolve(
      breakdown({
        by: 'rule',
        multi_valued: true,
        groups: [group('demo_noisy_scanner', 30, { open_now: 2, verdicted: 30, verdict_fp: 29 }), group('demo_rdp_bruteforce', 6, { open_now: 1, verdicted: 0 })],
        other: { count: 4, groups: 2, calls: null, cost_usd: null },
      }),
    );
  }
  return Promise.resolve(
    breakdown({
      by: q.by as never,
      groups: [group('high', 4, { analyst_tp: 1 }), group('low', 32, { analyst_tp: 0 })],
    }),
  );
}
