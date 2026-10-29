/**
 * Round 14 WP-0 client contracts (SPEC §3.4, §4.4.3, §7.2).
 *
 *   1. The lazy-only client modules (`api-audit`, `api-dashboards`, `api-rules`,
 *      `api-runbooks`) call the documented method, path, query and body through the
 *      shared request helper.
 *   2. `KPI_STRIP_BINDINGS` is the spec's binding table: cells in order, sources,
 *      grants, the case-derived flags of D16, and plain copy.
 *   3. The new type mirrors are type-only (zero runtime bytes) and no entry module
 *      imports the lazy client modules, so WP-0 adds nothing to the first paint.
 *
 * The typed fixtures below double as compile-time checks of the mirrors against the
 * spec's example payloads (`tsc -p tsconfig.test.json`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDIT_COUNT_CAP, countAudit, getAuditRecord, listAuditPage, submitAuditExport } from '../api-audit';
import { BREAKDOWN_QUERY_DEFAULTS, breakdownQueryKey, getMetricsBreakdown } from '../api-dashboards';
import { getRuleSummary } from '../api-rules';
import {
  attachRunbook,
  draftRunbookStep,
  exportRunbookMarkdown,
  getCaseRunbooks,
  getRunbookCandidates,
  getRunbookDetail,
  getRunbookMetrics,
  getRunbookProgress,
  listRunbookLibrary,
  publishRunbook,
  RUNBOOK_PROGRESS_BATCH,
  saveRunbookDraft,
  suggestRunbook,
  switchRunbookRunVersion,
  updateRunbookStep,
  validateRunbook,
} from '../api-runbooks';
import {
  INVESTIGATION_USAGE_SURFACES,
  KPI_PROVIDER_ENDPOINTS,
  KPI_STRIP_BINDINGS,
  kpiStripCells,
  type KpiFieldSource,
} from '@/soc/dashboard/kpi-bindings';
import type { AuditPage } from '../types-audit';
import type { MetricsBreakdown } from '../types-dashboards';
import type { RuleSummary } from '../types-rules';
import type { RunbookDefinition, RunbookRun } from '../types-runbooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../..');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response;
}

function stubFetch(...bodies: unknown[]) {
  const queue = [...bodies];
  const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(queue.length ? queue.shift() : {}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof vi.fn>, index = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------------------- //
// Typed fixtures from the spec's example payloads (compile-time checks).
// --------------------------------------------------------------------------- //
const BREAKDOWN_EXAMPLE: MetricsBreakdown = {
  kind: 'cases',
  by: 'rule',
  then: null,
  bucket: null,
  status_group: null,
  window_label: 'Last 7 days',
  window_from: '2026-10-19T00:00:00Z',
  window_to: '2026-10-26T00:00:00Z',
  total: 1874,
  exact: true,
  partial: false,
  partial_reason: null,
  multi_valued: true,
  groups: [
    {
      key: 'ssh_auth_failed',
      then_key: null,
      bucket: null,
      count: 41,
      open_now: 3,
      verdicted: 33,
      verdict_tp: 4,
      verdict_fp: 18,
      verdict_needs_human: 11,
      analyst_tp: 3,
      analyst_fp: 14,
      analyst_ungraded: 24,
      calls: null,
      cost_usd: null,
    },
  ],
  buckets: [],
  other: { count: 210, groups: 37, calls: null, cost_usd: null },
  missing_created: 0,
  missing_in_total: true,
};

const RULE_SUMMARY_EXAMPLE: RuleSummary = {
  rule: 'Web scanner user agent detected',
  window: { label: 'Last 3 days', from: '2026-10-23T00:00:00Z', to: '2026-10-26T00:00:00Z' },
  alerts: {
    status: 'ok',
    reason: null,
    count: 381,
    count_relation: 'eq',
    first_seen: '2026-10-23T01:00:00Z',
    last_seen: '2026-10-25T14:02:00Z',
    series: {
      bucket: '12h',
      levels: ['critical', 'high', 'medium', 'low', 'info'],
      points: [{ t: '2026-10-23T00:00:00Z', critical: 0, high: 3, medium: 40, low: 2, info: 0 }],
    },
    sources: [{ id: 'src-1', name: 'Wazuh', exact: true }],
  },
  top_source_ips: { status: 'ok', reason: null, rows: [{ value: '198.51.100.23', kind: null, count: 120 }], exact: true },
  top_targets: { status: 'ok', reason: null, rows: [{ value: 'web01', kind: 'host', count: 88 }], exact: true },
  cases: {
    status: 'ok',
    reason: null,
    count: 3,
    open_now: 1,
    outcomes: { analyst_tp: 1, analyst_fp: 1, analyst_ungraded: 1 },
    latest: [{ case_id: 'case-1', case_number: 'CASE-000214', title: 'Scan', status: 'investigating', verdict: 'NEEDS_HUMAN' }],
  },
  definition: { status: 'ok', reason: null, kind: 'source', suite_rule: null },
  tuning: { status: 'forbidden', reason: null, wilson_lower_bound: null, samples: null, proposed_change: null, last_tuned: null },
  analyst_policy: { status: 'ok', reason: null, policy: null },
};

const DEFINITION: RunbookDefinition = {
  id: 'brute-force-password-spray',
  title: 'Brute force and password spray',
  summary: 'Many failed sign-ins against one or more accounts, from one or many sources.',
  use_when: '',
  prerequisites: '',
  applies_when: {
    rule_ids: ['ssh_auth_failed'],
    mitre: ['T1110'],
    entity_types: ['ip', 'user'],
    severity_at_least: null,
    sources: [],
    verdicts: [],
    statuses: [],
    any_tags: [],
    min_event_count: null,
    always: false,
  },
  priority: 60,
  mitre: ['T1110'],
  phases: ['triage'],
  steps: [
    {
      id: 'accounts-tried',
      phase: 'triage',
      kind: 'lookup',
      title: 'How many accounts were tried?',
      instructions: '',
      focus: null,
      escalate_if: null,
      benign_if: null,
      required: true,
      evidence: 'none',
      owner_role: null,
      approval_role: null,
      target_minutes: null,
      lookup: {
        tool: 'log_stats',
        filter: { 'source.ip': '{{entity.ip}}' },
        group_by: ['user.name'],
        indicator: null,
        window: 'case_first_seen-1h..case_last_seen+1h',
        limit: 20,
        run: 'on_attach',
      },
      options: [],
      react: null,
      d3fend: null,
    },
  ],
  retrieval_queries: [],
  owner: null,
  review_every_days: 180,
  references: [],
};

const RUN: RunbookRun = {
  run_id: 'run-1',
  case_id: 'case-1',
  runbook_id: DEFINITION.id,
  version: 4,
  title: DEFINITION.title,
  snapshot: DEFINITION,
  attached_by: 'rule',
  attached_reason: { tier: 3, matched: [{ criterion: 'rule_ids', value: 'ssh_auth_failed' }], missed: [], tie: false },
  attached_at: '2026-10-25T12:52:00Z',
  attached_actor: 'agentic_soc',
  status: 'active',
  completed_at: null,
  abandoned_reason: null,
  steps: {},
  revision: 0,
};

describe('typed fixtures follow the spec examples', () => {
  it('the breakdown example keeps both metric families whole', () => {
    const [group] = BREAKDOWN_EXAMPLE.groups;
    expect((group.verdict_tp ?? 0) + (group.verdict_fp ?? 0) + (group.verdict_needs_human ?? 0)).toBe(group.verdicted);
    expect((group.analyst_tp ?? 0) + (group.analyst_fp ?? 0) + (group.analyst_ungraded ?? 0)).toBe(group.count);
  });

  it('the rule summary example lists every severity level in display order', () => {
    expect(RULE_SUMMARY_EXAMPLE.alerts.series?.levels).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(RUN.snapshot.steps[0].lookup?.tool).toBe('log_stats');
  });
});

// --------------------------------------------------------------------------- //
// Client modules
// --------------------------------------------------------------------------- //
describe('api-audit', () => {
  it('reads a page with the Round 14 query, dropping empty keys', async () => {
    const page: AuditPage = {
      records: [],
      total: 0,
      next_cursor: null,
      total_relation: 'eq',
      run_totals: {},
      retention: { hot_days: 180, warm_days: 90, volatile: false },
    };
    const fetchMock = stubFetch(page);
    const result = await listAuditPage({ scope: 'people', q: 'role changed', limit: 50, cursor: undefined, actor: '' });
    expect(result).toEqual(page);
    const { url, method } = call(fetchMock);
    expect(method).toBe('GET');
    expect(url).toBe('/api/audit?scope=people&q=role%20changed&limit=50');
  });

  it('counts with the cap clamped to 100,001', async () => {
    const fetchMock = stubFetch({ count: 100_001, relation: 'gte' }, { count: 3, relation: 'eq' });
    await countAudit({ scope: 'all', cap: 5_000_000 });
    await countAudit({ scope: 'people' });
    expect(AUDIT_COUNT_CAP).toBe(100_001);
    expect(call(fetchMock, 0).url).toBe('/api/audit/count?scope=all&cap=100001');
    expect(call(fetchMock, 1).url).toBe('/api/audit/count?scope=people&cap=100001');
  });

  it('opens one record by its encoded id', async () => {
    const fetchMock = stubFetch({});
    await getAuditRecord('demo:es:tlsoc-agent-audit-000001:AbC_d-9');
    expect(call(fetchMock).url).toBe('/api/audit/records/demo%3Aes%3Atlsoc-agent-audit-000001%3AAbC_d-9');
  });

  it('submits the audit_export job with absolute instants', async () => {
    const fetchMock = stubFetch({ job_id: 'job-1' });
    await submitAuditExport(
      {
        format: 'csv',
        filters: { outcome: 'failure' },
        q: 'login',
        order: 'asc',
        scope: 'people',
        from: '2026-10-18T15:10:00Z',
        to: '2026-10-25T15:10:00Z',
      },
      'audit_export-123',
    );
    const { url, method, body } = call(fetchMock);
    expect([method, url]).toEqual(['POST', '/api/jobs']);
    expect(body).toEqual({
      kind: 'audit_export',
      idempotency_key: 'audit_export-123',
      params: {
        format: 'csv',
        filters: { outcome: 'failure' },
        q: 'login',
        order: 'asc',
        scope: 'people',
        from: '2026-10-18T15:10:00Z',
        to: '2026-10-25T15:10:00Z',
      },
    });
  });
});

describe('api-dashboards', () => {
  it('reads a breakdown with its query', async () => {
    const fetchMock = stubFetch(BREAKDOWN_EXAMPLE);
    const result = await getMetricsBreakdown({ by: 'verdict', status_group: 'open', window: 'all' });
    expect(result.groups[0].key).toBe('ssh_auth_failed');
    expect(call(fetchMock).url).toBe('/api/metrics/breakdown?by=verdict&status_group=open&window=all');
  });

  it('keys equal queries alike whatever their field order', () => {
    const a = breakdownQueryKey({ by: 'verdict', window: 'all', status_group: 'open' });
    const b = breakdownQueryKey({ status_group: 'open', by: 'verdict', window: 'all', then: undefined });
    expect(a).toBe(b);
    expect(a).toBe('kind=cases&by=verdict&window=all&top=10&status_group=open');
    expect(breakdownQueryKey({ kind: 'usage', by: 'surface', window: 'now-30d', top: 50 })).toBe(
      'kind=usage&by=surface&window=now-30d&top=50',
    );
  });

  it('keys a query and its server defaults alike, so the two widgets share one fetch', () => {
    expect(BREAKDOWN_QUERY_DEFAULTS).toEqual({ kind: 'cases', window: 'now-7d', top: 10 });
    const bare = breakdownQueryKey({ by: 'severity' });
    expect(bare).toBe(breakdownQueryKey({ kind: 'cases', by: 'severity', window: 'now-7d', top: 10 }));
    expect(bare).toBe(breakdownQueryKey({ by: 'severity', window: '', filter_rule: '' }));
    // A different value of a defaulted parameter is a different read.
    expect(bare).not.toBe(breakdownQueryKey({ by: 'severity', top: 50 }));
    expect(bare).not.toBe(breakdownQueryKey({ by: 'severity', kind: 'usage' }));
    expect(bare).not.toBe(breakdownQueryKey({ by: 'severity', window: 'now-24h' }));
  });
});

describe('api-rules', () => {
  it('reads one rule summary, the value encoded as a query parameter', async () => {
    const fetchMock = stubFetch(RULE_SUMMARY_EXAMPLE);
    const result = await getRuleSummary({ rule: 'Fehlgeschlagene Anmeldung über SSH', window: 'now-3d' });
    expect(result.alerts.count).toBe(381);
    expect(call(fetchMock).url).toBe(
      `/api/rules/summary?rule=${encodeURIComponent('Fehlgeschlagene Anmeldung über SSH')}&window=now-3d`,
    );
  });
});

describe('api-runbooks', () => {
  it('reads the library, one runbook and the metrics', async () => {
    const fetchMock = stubFetch({ runbooks: [], migration: null }, {}, {});
    await listRunbookLibrary({ state: 'published', show_replaced: true });
    await getRunbookDetail('brute_force_login');
    await getRunbookMetrics('now-30d');
    expect(call(fetchMock, 0).url).toBe('/api/runbooks?state=published&show_replaced=true');
    expect(call(fetchMock, 1).url).toBe('/api/runbooks/brute_force_login');
    expect(call(fetchMock, 2).url).toBe('/api/runbooks/metrics?window=now-30d');
  });

  it('writes drafts and governance transitions with their revisions', async () => {
    const fetchMock = stubFetch({}, {}, {});
    await saveRunbookDraft('my-runbook', { definition: DEFINITION, expected_revision: 3 });
    await publishRunbook('my-runbook', { version: 5, expected_revision: 4, content_hash: 'a'.repeat(64) });
    await validateRunbook({ source: '---\nid: x\n---' });
    expect(call(fetchMock, 0)).toEqual({
      url: '/api/runbooks/my-runbook/draft',
      method: 'PUT',
      body: { definition: DEFINITION, expected_revision: 3 },
    });
    expect(call(fetchMock, 1)).toEqual({
      url: '/api/runbooks/my-runbook/publish',
      method: 'POST',
      body: { version: 5, expected_revision: 4, content_hash: 'a'.repeat(64) },
    });
    expect(call(fetchMock, 2).url).toBe('/api/runbooks/validate');
  });

  it('works a case run through its nested paths', async () => {
    const fetchMock = stubFetch({}, {}, {}, {}, {}, {}, {});
    await getCaseRunbooks('case 1');
    await getRunbookCandidates('case-1', 'spray');
    await attachRunbook('case-1', { runbook_id: 'generic-incident', note: 'By hand.' });
    await updateRunbookStep('case-1', 'run-1', 'accounts-tried', { expected_revision: 2, status: 'done' });
    await switchRunbookRunVersion('case-1', 'run-1', 5);
    await suggestRunbook('case-1', { dryRun: true });
    await draftRunbookStep('case-1', 'run-1', 'source-scope');
    expect(call(fetchMock, 0).url).toBe('/api/cases/case%201/runbooks');
    expect(call(fetchMock, 1).url).toBe('/api/cases/case-1/runbooks/candidates?q=spray');
    expect(call(fetchMock, 2)).toEqual({
      url: '/api/cases/case-1/runbooks',
      method: 'POST',
      body: { runbook_id: 'generic-incident', note: 'By hand.' },
    });
    expect(call(fetchMock, 3)).toEqual({
      url: '/api/cases/case-1/runbooks/run-1/steps/accounts-tried',
      method: 'PATCH',
      body: { expected_revision: 2, status: 'done' },
    });
    expect(call(fetchMock, 4).body).toEqual({ version: 5 });
    expect(call(fetchMock, 5).url).toBe('/api/cases/case-1/runbooks/suggest?dry_run=true');
    expect(call(fetchMock, 6).url).toBe('/api/cases/case-1/runbooks/run-1/steps/source-scope/draft');
  });

  it('asks for progress in batches of 100 and merges the answers', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `case-${i}`);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const { case_ids } = JSON.parse(String(init.body)) as { case_ids: string[] };
      return jsonResponse(
        Object.fromEntries(
          case_ids.map((id) => [id, { done: 1, not_applicable: 0, total: 2, required_open: 1, blocked: 0, waiting: 0 }]),
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const progress = await getRunbookProgress([...ids, 'case-0']);
    expect(RUNBOOK_PROGRESS_BATCH).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).case_ids.length)).toEqual([
      100, 100, 5,
    ]);
    expect(Object.keys(progress)).toHaveLength(205);
  });

  it('downloads the Markdown export as a blob with its headers', async () => {
    const blob = new Blob(['---\nid: x\n---\n'], { type: 'text/markdown' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) =>
          ({ 'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="x.md"' })[h.toLowerCase()] ??
          null,
      },
      blob: async () => blob,
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const result = await exportRunbookMarkdown('x');
    expect(result).toEqual({ blob, contentType: 'text/markdown', contentDisposition: 'attachment; filename="x.md"' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/runbooks/x/export');
  });
});

// --------------------------------------------------------------------------- //
// KPI strip bindings (§4.4.3)
// --------------------------------------------------------------------------- //
describe('KPI_STRIP_BINDINGS', () => {
  it('lists each strip in the spec order', () => {
    expect(kpiStripCells('operations').map((b) => b.label)).toEqual([
      'Open now',
      'Awaiting a decision',
      'Unassigned',
      'SLA breached',
      'New cases',
      'Closed',
    ]);
    expect(kpiStripCells('detection').map((b) => b.label)).toEqual([
      'Sources reporting',
      'Silent sources',
      'Events per minute',
      'Alerts ingested',
      'Alert reduction',
      'Techniques seen',
    ]);
    expect(kpiStripCells('executive').map((b) => b.label)).toEqual([
      'Cases',
      'Confirmed threats',
      'MTTD p50',
      'MTTR p50',
      'Closed by the AI agent',
      'SLA attainment',
    ]);
    expect(kpiStripCells('cost_budget').map((b) => b.label)).toEqual(['Spend per case']);
  });

  it('binds Awaiting a decision to the verdict, never to status open alone', () => {
    const cell = KPI_STRIP_BINDINGS.find((b) => b.cell === 'awaiting_decision');
    expect(cell?.source).toEqual({
      type: 'breakdown_group',
      query: { by: 'verdict', status_group: 'open', window: 'all' },
      group: 'NEEDS_HUMAN',
      metric: 'count',
    });
  });

  it('reads confirmed threats only from the analyst outcome family', () => {
    const cell = KPI_STRIP_BINDINGS.find((b) => b.cell === 'confirmed_threats');
    expect(cell?.source).toMatchObject({ type: 'breakdown_sum', metric: 'analyst_tp', query: { by: 'severity' } });
  });

  it('counts spend per case over investigation surfaces only', () => {
    const cell = KPI_STRIP_BINDINGS.find((b) => b.cell === 'spend_per_case');
    expect(cell?.grant).toEqual({ resource: 'cost', action: 'view' });
    expect(INVESTIGATION_USAGE_SURFACES).not.toContain('chat');
    expect(cell?.source).toMatchObject({
      type: 'ratio',
      numerator: { query: { kind: 'usage', by: 'surface' }, metric: 'cost_usd' },
      denominator: { metric: 'verdicted' },
    });
  });

  it('marks only the source and event cells as not case-derived (D16)', () => {
    const notCaseDerived = KPI_STRIP_BINDINGS.filter((b) => !b.caseDerived).map((b) => b.cell);
    // Alert reduction divides the case tally by alerts, so row-level scope hides it.
    expect(notCaseDerived).toEqual(['sources_reporting', 'silent_sources', 'events_per_minute', 'alerts_ingested']);
  });

  it('computes alert reduction as the Overview does, never from reduction.overall_pct', () => {
    const cell = KPI_STRIP_BINDINGS.find((b) => b.cell === 'alert_reduction');
    expect(cell?.source).toEqual({
      type: 'stage_reduction',
      endpoint: 'GET /api/metrics/noise-reduction',
      numerator: 'cases',
      denominator: 'ingested',
    });
    expect(cell?.definition).toBe('Share of raw alerts that did not become a case.');
    const fields = KPI_STRIP_BINDINGS.flatMap((b) => (b.source.type === 'field' ? [b.source.field] : []));
    expect(fields.filter((f) => f.startsWith('reduction.'))).toEqual([]);
  });

  it('reads events per minute from the field the noise endpoint returns', () => {
    const cell = KPI_STRIP_BINDINGS.find((b) => b.cell === 'events_per_minute');
    expect(cell?.source).toMatchObject({ type: 'field', field: 'events_per_min', availableField: 'counters.available' });
  });

  it('marks every value a source can leave unmeasured, so none reads as 0 or a dash', () => {
    // Fields whose endpoint answers a dash string or 0 with `available: false` when it
    // has no samples, or `null` while its counters warm up.
    const unmeasurable: Array<[string, RegExp]> = [
      ['GET /api/metrics/posture', /^lifecycle\./],
      ['GET /api/metrics/auto-close-health/recorded?anchor=first', /^current\./],
      ['GET /api/metrics/noise-reduction', /^(stages\[|events_per_min)/],
      ['GET /api/standup/report', /^sla_aging\./],
    ];
    const fieldSources = KPI_STRIP_BINDINGS.flatMap((b) => (b.source.type === 'field' ? [b.source] : []));
    const covered = fieldSources.filter((src) =>
      unmeasurable.some(([endpoint, field]) => src.endpoint === endpoint && field.test(src.field)),
    );
    expect(covered.map((src) => src.field)).toEqual([
      'sla_aging.totals.breached',
      'events_per_min',
      'stages[key=ingested].total',
      'lifecycle.mttd_minutes.p50',
      'lifecycle.mttr_minutes.p50',
      'current.auto_closed',
    ]);
    for (const src of covered) expect(src.availableField, src.field).toMatch(/\.(available|enabled)$/);
    const byCell = (cell: string) => KPI_STRIP_BINDINGS.find((b) => b.cell === cell)?.source as KpiFieldSource;
    expect(byCell('mttd_p50').availableField).toBe('lifecycle.mttd_minutes.available');
    expect(byCell('mttr_p50').availableField).toBe('lifecycle.mttr_minutes.available');
    expect(byCell('closed_by_agent')).toMatchObject({ availableField: 'current.available', shareField: 'current.rate' });
  });

  it('flags partial sources so a lower bound reads "at least"', () => {
    for (const binding of KPI_STRIP_BINDINGS) {
      if (binding.source.type !== 'field') continue;
      for (const flag of binding.source.partialWhen ?? []) {
        expect(flag.field).toMatch(/^[a-z_.]+$/);
        expect(typeof flag.when).toBe('boolean');
      }
      if (binding.source.endpoint === 'GET /api/metrics/posture' && binding.window === 'board') {
        expect(binding.source.partialWhen, binding.cell).toEqual([
          { field: 'window_covered', when: false, reasonField: 'window_coverage_reason' },
        ]);
      }
    }
  });

  it('asks for enough groups that the unassigned group is never cut silently', () => {
    const cell = KPI_STRIP_BINDINGS.find((b) => b.cell === 'unassigned');
    expect(cell?.source).toMatchObject({ type: 'breakdown_group', group: null, query: { by: 'assignee', top: 50 } });
  });

  it('reads every cell from its provider key, one endpoint per key', () => {
    expect(KPI_PROVIDER_ENDPOINTS.coverage).toBe('GET /api/mitre/coverage');
    for (const binding of KPI_STRIP_BINDINGS) {
      const { source } = binding;
      if (source.type === 'breakdown_group' || source.type === 'breakdown_sum' || source.type === 'ratio') {
        expect(binding.provider, binding.cell).toBe('breakdown');
      } else {
        expect(source.endpoint, binding.cell).toBe(KPI_PROVIDER_ENDPOINTS[binding.provider]);
      }
    }
  });

  it('gives every cell a grant and plain sentence-case copy', () => {
    const cells = new Set<string>();
    for (const binding of KPI_STRIP_BINDINGS) {
      const id = `${binding.group}.${binding.cell}`;
      expect(cells.has(id)).toBe(false);
      cells.add(id);
      expect(binding.grant.resource).toMatch(/^[a-z_]+$/);
      expect(binding.grant.action).toMatch(/^[a-z_]+$/);
      for (const text of [binding.label, binding.definition]) {
        expect(text).not.toMatch(/[\u2013\u2014]/); // no en or em dash
        expect(text.toLowerCase()).not.toContain('playbook');
        expect(text.toLowerCase()).not.toContain('detection coverage');
      }
      expect(binding.definition).toMatch(/\.$/);
    }
  });
});

// --------------------------------------------------------------------------- //
// Zero first-paint bytes (§3.4)
// --------------------------------------------------------------------------- //
const TYPE_ONLY_MODULES = [
  'lib/types-audit.ts',
  'lib/types-dashboards.ts',
  'lib/types-rules.ts',
  'lib/types-runbooks.ts',
  // B1: the compile-time pins of the mirrors to the generated contract.
  'lib/types-contract-pins.ts',
];

const LAZY_ONLY_MODULES = [
  'lib/api-audit.ts',
  'lib/api-dashboards.ts',
  'lib/api-rules.ts',
  'lib/api-runbooks.ts',
  'soc/dashboard/kpi-bindings.ts',
];

/** The entry modules of §3.4: anything they import statically ships at first paint. */
const ENTRY_MODULES = [
  'soc/App.tsx',
  'soc/AppShell.tsx',
  'soc/components/NavSidebar.tsx',
  'soc/router.tsx',
  'soc/registry.tsx',
  'soc/nav.ts',
  'soc/nav-types.ts',
  'soc/auth.tsx',
  'soc/pages/Login.tsx',
  'soc/pages/Wizard.tsx',
  'ui/sheet.tsx',
  'lib/api.ts',
  'lib/types.ts',
  'lib/format.ts',
  'lib/useEventStream.ts',
  'design-system/index.ts',
  'soc/chat-activity/store.ts',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Static `import ... from` and `export ... from` statements (a clause never crosses a
// quote or a semicolon), and bare side-effect imports. `import()` is lazy and ignored.
const STATIC_FROM_RE = /^[ \t]*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"\n]+)['"]/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm;

/** A `{ type A, type B }` clause is erased by the compiler (isolatedModules, no verbatim syntax). */
function isTypeOnlyClause(clause: string): boolean {
  const named = clause.trim().match(/^\{([\s\S]*)\}$/);
  if (!named) return false;
  const parts = named[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.startsWith('type '));
}

/** The specifiers a module imports for their values (what reaches the bundle). */
function valueSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  for (const match of code.matchAll(STATIC_FROM_RE)) {
    const [, , typeKeyword, clause, specifier] = match;
    if (typeKeyword || isTypeOnlyClause(clause)) continue;
    out.push(specifier);
  }
  for (const match of code.matchAll(SIDE_EFFECT_RE)) out.push(match[1]);
  return out;
}

/** A source file for a relative or `@/` specifier; `null` for packages and assets. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = resolve(SRC, specifier.slice(2));
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = resolve(dirname(fromFile), specifier);
  else return null;
  base = base.replace(/\?.*$/, '').replace(/\.js$/, '');
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module the entry modules reach through static value imports, with the importer. */
function entryGraph(): Map<string, string | null> {
  const importer = new Map<string, string | null>();
  const queue: string[] = [];
  for (const entry of ENTRY_MODULES) {
    const file = resolve(SRC, entry);
    importer.set(file, null);
    queue.push(file);
  }
  while (queue.length) {
    const file = queue.shift() as string;
    for (const specifier of valueSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, specifier);
      if (target && !importer.has(target)) {
        importer.set(target, file);
        queue.push(target);
      }
    }
  }
  return importer;
}

function importChain(graph: Map<string, string | null>, file: string): string {
  const chain: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.get(at)) chain.unshift(relative(SRC, at));
  return chain.join(' -> ');
}

describe('the Round 14 contracts cost the entry bundle nothing', () => {
  it.each(TYPE_ONLY_MODULES)('%s declares types only', (path) => {
    const code = stripComments(readFileSync(resolve(SRC, path), 'utf8'));
    for (const line of code.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      expect(trimmed).not.toMatch(/^export\s+(const|let|var|function|class|enum|default)\b/);
      expect(trimmed).not.toMatch(/^(const|let|var|function|class|enum)\b/);
      if (trimmed.startsWith('import ')) expect(trimmed).toMatch(/^import type /);
    }
  });

  it.each(ENTRY_MODULES)('entry module %s exists', (path) => {
    // A moved entry module must be renamed here too, or the guard below goes blind.
    expect(existsSync(resolve(SRC, path))).toBe(true);
  });

  it('classifies value and type-only imports the way the bundler does', () => {
    const sample = [
      "import type { A } from './type-only';",
      "import { type B, type C } from './inline-types';",
      "import { type D, e } from './mixed';",
      "import F from './default';",
      "import * as G from './namespace';",
      "export { h } from './reexport';",
      "export type { I } from './type-reexport';",
      "export * from './star';",
      "import './side-effect.css';",
      "const lazy = () => import('./lazy');",
      "import {\n  j,\n  k,\n} from './multi-line';",
    ].join('\n');
    expect(valueSpecifiers(sample)).toEqual([
      './mixed',
      './default',
      './namespace',
      './reexport',
      './star',
      './multi-line',
      './side-effect.css',
    ]);
  });

  it('no entry module reaches a lazy-only Round 14 module, directly or through another module', () => {
    const graph = entryGraph();
    // The walk really follows the shell past the entry modules themselves (a broken
    // parser would pass vacuously): the Button primitive is reached only transitively.
    expect(graph.size).toBeGreaterThan(50);
    expect(ENTRY_MODULES).not.toContain('ui/button.tsx');
    expect(graph.has(resolve(SRC, 'ui/button.tsx'))).toBe(true);
    for (const lazy of LAZY_ONLY_MODULES) {
      const file = resolve(SRC, lazy);
      expect(graph.has(file), graph.has(file) ? importChain(graph, file) : lazy).toBe(false);
    }
  });
});
