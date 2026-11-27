/**
 * Round 14 WP-B1: the API client against the generated contract (SPEC §7.4).
 *
 *   1. Every Round 14 client call (audit list, count, record and export job, the
 *      metrics breakdown, the rule summary, every runbook library and case runbook
 *      call, the case close fields, the Cases and Logs rule filters, the role simulation) names a
 *      real operation of the committed `openapi.json`: its path and method exist, every
 *      query parameter it sends is declared (and every required one is sent), and every
 *      body field it sends is a field of the declared request body.
 *   2. Behaviour: the URL, method and body of the calls the lazy clients make, and how
 *      the coded refusals of these routes reach the page as an `ApiError`.
 *   3. The hand mirrors: every mirror with a schema of the same name is pinned in
 *      `types-contract-pins.ts` (which `tsc --noEmit` checks), `types.ts` re-exports the
 *      Round 14 modules without a name collision, and the retired pre-Round 14 calls and
 *      declarations are gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError, api, setReauthHandler } from '../api';
import { countAudit, getAuditRecord, listAuditPage, submitAuditExport } from '../api-audit';
import { getMetricsBreakdown } from '../api-dashboards';
import { getRuleSummary } from '../api-rules';
import {
  abandonRunbookRun,
  attachRunbook,
  confirmRunbookStepDraft,
  createRunbook,
  decideRunbookApproval,
  discardRunbookDraft,
  draftRunbookStep,
  duplicateRunbook,
  exportRunbookMarkdown,
  exportRunbookVersionMarkdown,
  getCaseRunbooks,
  getRunbookCandidates,
  getRunbookDetail,
  getRunbookMetrics,
  getRunbookProgress,
  getRunbookVersion,
  importRunbook,
  listRunbookLibrary,
  markRunbookReviewed,
  previewRunbookMatch,
  publishRunbook,
  rejectRunbook,
  restoreRunbook,
  restoreRunbookVersionAsDraft,
  retireRunbook,
  runRunbookLookup,
  saveRunbookDraft,
  submitRunbookForReview,
  suggestRunbook,
  switchRunbookRunVersion,
  testRunbookLookup,
  updateRunbookStep,
  validateRunbook,
  RUNBOOK_PROGRESS_BATCH,
  RUNBOOK_PROGRESS_CASE_ID_MAX,
} from '../api-runbooks';
import { rolesApi } from '@/soc/pages/Roles.api';
import { fetchUnifiedLogs } from '@/soc/UnifiedLogs.api';
import type {
  AuditExportJobParams,
  AuditRecord as AuditRecordFromTypes,
  CaseLifecycleParams,
  CaseRationale,
  RunbookDetail as RunbookDetailFromTypes,
} from '../types';
import type { AuditRecord } from '../types-audit';
import type { LookupTemplate, RunbookDefinition, RunbookDetail } from '../types-runbooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, '..');
const SRC = resolve(LIB, '..');
const WEBUI = resolve(SRC, '..');

// --------------------------------------------------------------------------- //
// The committed contract
// --------------------------------------------------------------------------- //
interface JsonSchema {
  $ref?: string;
  anyOf?: JsonSchema[];
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
}
interface Parameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: JsonSchema;
}
interface Operation {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: JsonSchema }> };
}
interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, JsonSchema> };
}

const SPEC = JSON.parse(readFileSync(resolve(WEBUI, 'openapi.json'), 'utf8')) as OpenApi;

function deref(schema: JsonSchema): JsonSchema {
  if (schema.$ref) return SPEC.components.schemas[schema.$ref.split('/').pop() as string];
  return schema;
}

/** The object schema of a body (`T` or `T | null`), or null when the body is not an object. */
function objectSchema(schema: JsonSchema): JsonSchema | null {
  for (const member of schema.anyOf ?? [schema]) {
    const resolved = deref(member);
    if (resolved.type === 'object' || resolved.properties) return resolved;
  }
  return null;
}

/** The OpenAPI path template a concrete `/api/...` path matches (a literal path wins). */
function templateFor(path: string, method: string): string | null {
  const candidates = Object.keys(SPEC.paths)
    .filter((template) => SPEC.paths[template][method])
    .sort((a, b) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0));
  for (const template of candidates) {
    const pattern = new RegExp(
      `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`,
    );
    if (pattern.test(path)) return template;
  }
  return null;
}

interface Sent {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  contentType: string | null;
}

/** Fail with a readable list when a sent request is not one the contract declares. */
function contractProblems(sent: Sent): string[] {
  const method = sent.method.toLowerCase();
  const template = templateFor(sent.path, method);
  if (!template) return [`${sent.method} ${sent.path}: no such operation in openapi.json`];
  const op = SPEC.paths[template][method];
  const problems: string[] = [];
  const declared = new Map((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => [p.name, p]));
  for (const key of new Set(sent.query.keys())) {
    if (!declared.has(key)) problems.push(`${sent.method} ${template}: query '${key}' is not declared`);
  }
  for (const [name, param] of declared) {
    if (param.required && !sent.query.has(name)) {
      problems.push(`${sent.method} ${template}: required query '${name}' was not sent`);
    }
  }
  const json = op.requestBody?.content['application/json'];
  if (!json) {
    if (sent.body !== undefined) problems.push(`${sent.method} ${template}: sends a body the route does not read`);
    return problems;
  }
  if (sent.body === undefined) {
    if (op.requestBody?.required) problems.push(`${sent.method} ${template}: the required body was not sent`);
    return problems;
  }
  if (sent.contentType !== 'application/json') problems.push(`${sent.method} ${template}: body is not JSON`);
  const schema = objectSchema(json.schema);
  if (!schema || !schema.properties || typeof sent.body !== 'object' || sent.body === null) return problems;
  const fields = Object.keys(sent.body as Record<string, unknown>);
  for (const field of fields) {
    if (!(field in schema.properties)) problems.push(`${sent.method} ${template}: body field '${field}' is not declared`);
  }
  for (const field of schema.required ?? []) {
    if (!fields.includes(field)) problems.push(`${sent.method} ${template}: required body field '${field}' was not sent`);
  }
  return problems;
}

// --------------------------------------------------------------------------- //
// A recording fetch
// --------------------------------------------------------------------------- //
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const json = typeof body !== 'string' && !(body instanceof Blob);
  if (json && !lower['content-type']) lower['content-type'] = 'application/json';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    blob: async () => (body instanceof Blob ? body : new Blob([JSON.stringify(body)])),
  } as unknown as Response;
}

function recordFetch(...answers: Response[]) {
  const queue = [...answers];
  const fetchMock = vi.fn().mockImplementation(async () => queue.shift() ?? response(200, {}));
  vi.stubGlobal('fetch', fetchMock);
  const sent = (index = 0): Sent => {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    const parsed = new URL(url, 'http://console.test');
    const headers = (init.headers ?? {}) as Record<string, string>;
    return {
      method: String(init.method),
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      contentType: headers['Content-Type'] ?? null,
    };
  };
  return { fetchMock, sent };
}

afterEach(() => {
  setReauthHandler(null);
  vi.unstubAllGlobals();
});

const DEFINITION: RunbookDefinition = {
  id: 'phishing-triage',
  title: 'Phishing triage',
  summary: 'Work a reported phishing email.',
  use_when: 'A user reports a suspicious email.',
  prerequisites: '',
  applies_when: {
    rule_ids: ['phish_report'],
    mitre: [],
    entity_types: [],
    severity_at_least: null,
    sources: [],
    verdicts: [],
    statuses: [],
    any_tags: [],
    min_event_count: null,
    always: false,
  },
  priority: 50,
  mitre: ['T1566'],
  phases: ['triage'],
  steps: [],
  retrieval_queries: [],
  owner: null,
  review_every_days: 180,
  references: [],
};

const LOOKUP: LookupTemplate = {
  tool: 'log_stats',
  filter: { rule: '{{case.rule}}' },
  group_by: ['source.ip'],
  indicator: null,
  window: 'case_first_seen-1h..case_last_seen+1h',
  limit: 10,
  run: 'on_demand',
};

// --------------------------------------------------------------------------- //
// 1. Every call names a real operation
// --------------------------------------------------------------------------- //
const CALLS: Array<[string, () => Promise<unknown>]> = [
  // Audit log (§4.5.5, §4.5.6)
  ['audit page', () => listAuditPage({ scope: 'people', q: 'role', actor_kind: 'human', outcome: 'denied', order: 'asc', limit: 50, cursor: 'c1', from: 'now-7d', to: 'now', event: 'auth.login', actor_contains: 'ana', target: 'u-1', ip: '10.0.0.1', action: 'login', actor: 'ana', surface: 'webui', case_id: 'case-1', source_id: 'elastic' })],
  ['audit count', () => countAudit({ scope: 'all', q: 'export', cap: 10 })],
  ['audit record', () => getAuditRecord('sql:42', { scope: 'people', q: 'role' })],
  ['audit export job', () => submitAuditExport({ format: 'csv', scope: 'people', filters: {}, from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' }, 'intent-0001')],
  // Dashboards and rule summary (§4.4.2, §4.6.2)
  ['metrics breakdown', () => getMetricsBreakdown({ kind: 'cases', by: 'rule', then: 'severity', window: 'now-7d', bucket: 'day', top: 10, filter_rule: 'r1', status_group: 'open' })],
  ['rule summary', () => getRuleSummary({ rule: 'Web scanner user agent detected', window: 'now-3d', source_id: 'elastic' })],
  // Runbook library (§4.10.15)
  ['runbook library', () => listRunbookLibrary({ q: 'phish', state: 'published', origin: 'builtin', show_replaced: true })],
  ['runbook detail', () => getRunbookDetail('phishing-triage')],
  ['runbook version', () => getRunbookVersion('phishing-triage', 3)],
  ['create runbook', () => createRunbook({ definition: DEFINITION })],
  ['save draft', () => saveRunbookDraft('phishing-triage', { definition: DEFINITION, expected_revision: 4 })],
  ['discard draft', () => discardRunbookDraft('phishing-triage', 4)],
  ['duplicate', () => duplicateRunbook('brute_force_login', { expected_revision: 1 })],
  ['submit', () => submitRunbookForReview('phishing-triage', { version: 2, expected_revision: 4 })],
  ['publish', () => publishRunbook('phishing-triage', { version: 2, expected_revision: 5, content_hash: 'a'.repeat(64) })],
  ['reject', () => rejectRunbook('phishing-triage', { version: 2, reason: 'Add a containment step.', expected_revision: 5 })],
  ['retire', () => retireRunbook('phishing-triage', { expected_revision: 6 })],
  ['restore', () => restoreRunbook('phishing-triage')],
  ['reviewed', () => markRunbookReviewed('phishing-triage', { expected_revision: 6 })],
  ['restore version as draft', () => restoreRunbookVersionAsDraft('phishing-triage', 1, { expected_revision: 6 })],
  ['validate', () => validateRunbook({ source: '---\nid: x\n---' })],
  ['match preview', () => previewRunbookMatch({ id: 'phishing-triage' })],
  ['import', () => importRunbook('---\nid: x\n---')],
  ['export', () => exportRunbookMarkdown('phishing-triage')],
  ['export one version', () => exportRunbookVersionMarkdown('phishing-triage', 3)],
  ['metrics', () => getRunbookMetrics('now-30d')],
  ['lookup test', () => testRunbookLookup({ lookup: LOOKUP, case_id: 'case-1' })],
  // Case runs (§4.10.7, §4.10.15)
  ['case runbooks', () => getCaseRunbooks('case-1')],
  ['candidates', () => getRunbookCandidates('case-1', 'phish')],
  ['attach', () => attachRunbook('case-1', { runbook_id: 'phishing-triage', note: 'By hand.' })],
  ['suggest', () => suggestRunbook('case-1', { dryRun: true })],
  ['step update', () => updateRunbookStep('case-1', 'run-1', 'triage-1', { expected_revision: 2, status: 'done', note: 'Checked.' })],
  ['run lookup', () => runRunbookLookup('case-1', 'run-1', 'lookup-1')],
  ['approval', () => decideRunbookApproval('case-1', 'run-1', 'block-1', { decision: 'approve' })],
  ['ai draft', () => draftRunbookStep('case-1', 'run-1', 'record-1', { dryRun: true })],
  ['confirm draft', () => confirmRunbookStepDraft('case-1', 'run-1', 'record-1', { text: 'Edited note.' })],
  ['switch version', () => switchRunbookRunVersion('case-1', 'run-1', 5)],
  ['abandon', () => abandonRunbookRun('case-1', 'run-1', 'Wrong runbook.')],
  ['progress', () => getRunbookProgress(['case-1', 'case-2'])],
  // Existing calls with Round 14 fields (§4.6.1, §4.10.15, §3.7)
  ['cases rule filter', () => api.listCases({ rule: 'Web scanner user agent detected', closed_by: 'agent', limit: 50 })],
  ['logs rule and severity filters', () => fetchUnifiedLogs({ rule: 'Web scanner user agent detected', severity: 'high', source_id: 'elastic', limit: 50, from: 'now-3d', to: 'now', query: 'scanner', per_source_timeout: 5 })],
  ['logs severity floor', () => fetchUnifiedLogs({ severity_gte: 'medium' })],
  ['close with open steps', () => api.caseActionExec('case-1', { action: 'close', open_steps_reason: 'Contained upstream.', require_open_steps_reason: true })],
  ['bulk close job', () => api.jobs.submit({ kind: 'case_lifecycle', idempotency_key: 'intent-0002', params: { case_ids: ['case-1'], action: 'close', open_steps_reason: 'Duplicate batch.' } satisfies CaseLifecycleParams })],
  ['role simulation', () => rolesApi.simulate('soc_manager', 'playbooks', 'manage')],
  ['dashboard create', () => api.dashboards.create({ id: 'ops-copy', name: 'Ops copy', widgets: [], default_window: 'now-7d', derived_from: 'builtin:soc-operations' })],
];

describe('every Round 14 client call names a real operation', () => {
  it.each(CALLS)('%s', async (_name, run) => {
    const { fetchMock, sent } = recordFetch();
    await run();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (let index = 0; index < fetchMock.mock.calls.length; index += 1) {
      expect(contractProblems(sent(index))).toEqual([]);
    }
  });

  it('the checker itself refuses an undeclared path, parameter and body field', () => {
    const base = { url: '', contentType: 'application/json' };
    expect(contractProblems({ ...base, method: 'GET', path: '/api/runbooks/nope/elsewhere', query: new URLSearchParams(), body: undefined })).toHaveLength(1);
    expect(contractProblems({ ...base, method: 'GET', path: '/api/rules/summary', query: new URLSearchParams('rule=r&shape=v9'), body: undefined }))
      .toEqual(["GET /api/rules/summary: query 'shape' is not declared"]);
    expect(contractProblems({ ...base, method: 'GET', path: '/api/rules/summary', query: new URLSearchParams(), body: undefined }))
      .toEqual(["GET /api/rules/summary: required query 'rule' was not sent"]);
    expect(contractProblems({ ...base, method: 'POST', path: '/api/cases/c/runbooks', query: new URLSearchParams(), body: { runbook: 'x' } }))
      .toEqual([
        "POST /api/cases/{case_id}/runbooks: body field 'runbook' is not declared",
        "POST /api/cases/{case_id}/runbooks: required body field 'runbook_id' was not sent",
      ]);
    // A literal path wins over a template that would also match it.
    expect(templateFor('/api/runbooks/metrics', 'get')).toBe('/api/runbooks/metrics');
    expect(templateFor('/api/runbooks/metrics2', 'get')).toBe('/api/runbooks/{runbook_id}');
  });
});

// --------------------------------------------------------------------------- //
// 2. Behaviour: URLs, bodies and coded refusals
// --------------------------------------------------------------------------- //
describe('the audit log client', () => {
  it('opens a record with the page filters, so the open joins the list read (D8)', async () => {
    const { sent } = recordFetch(response(200, { record_id: 'sql:42' }));
    await getAuditRecord('demo:sql:42', { scope: 'people', q: 'role changed', actor: '', outcome: undefined });
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe('/api/audit/records/demo%3Asql%3A42?scope=people&q=role%20changed');
  });

  it('opens a record without filters when the page has none', async () => {
    const { sent } = recordFetch(response(200, { record_id: 'mem:3' }));
    await getAuditRecord('mem:3');
    expect(sent().url).toBe('/api/audit/records/mem%3A3');
  });

  it('surfaces an expired cursor as a coded 409 the page can reload from', async () => {
    recordFetch(
      response(409, { detail: { code: 'audit_cursor_expired', message: 'This read was closed. Reload from the top.' } }),
    );
    const error = await listAuditPage({ scope: 'people', cursor: 'stale' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('This read was closed. Reload from the top.');
    expect((error as ApiError).body).toMatchObject({ detail: { code: 'audit_cursor_expired' } });
  });

  it('asks for a fresh sign-in before an export and retries the same request once (D6)', async () => {
    const reauth = vi.fn().mockResolvedValue(true);
    setReauthHandler(reauth);
    const params: AuditExportJobParams = {
      format: 'jsonl',
      scope: 'all',
      q: 'export',
      filters: { actor_kind: 'human' },
      order: 'asc',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-08T00:00:00Z',
    };
    const { fetchMock, sent } = recordFetch(
      response(401, { detail: { code: 'reauth_required', reason: 'stale_or_revoked_authority' } }),
      response(202, { job_id: 'job-1', kind: 'audit_export' }),
    );
    const job = await submitAuditExport(params, 'intent-0003');
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(1).body).toEqual(sent(0).body);
    expect(sent(0).body).toEqual({ kind: 'audit_export', idempotency_key: 'intent-0003', params });
    expect(job).toMatchObject({ job_id: 'job-1' });
  });

  it('surfaces a running export as 429 job_busy', async () => {
    recordFetch(
      response(429, { detail: { code: 'job_busy', message: 'An audit export is already running. Wait for it to finish, then export again.' } }),
    );
    const error = await submitAuditExport(
      { format: 'csv', scope: 'people', filters: {}, from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
      'intent-0004',
    ).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).message).toMatch(/^An audit export is already running/);
  });
});

describe('the breakdown and rule summary clients', () => {
  it('sends a usage breakdown with its own fields', async () => {
    const { sent } = recordFetch(response(200, { kind: 'usage', groups: [] }));
    await getMetricsBreakdown({ kind: 'usage', by: 'model', window: 'now-30d', top: 5 });
    expect(sent().url).toBe('/api/metrics/breakdown?kind=usage&by=model&window=now-30d&top=5');
  });

  it('surfaces row-level scope as 409 breakdown_scope_unsupported (D16)', async () => {
    recordFetch(
      response(409, { detail: { code: 'breakdown_scope_unsupported', message: 'Hidden while row-level scope is on.' } }),
    );
    const error = await getMetricsBreakdown({ by: 'rule' }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('Hidden while row-level scope is on.');
  });

  it('carries a rule value exactly, whatever it holds', async () => {
    const { sent } = recordFetch(response(200, { rule: 'x' }));
    const rule = 'Brute force & spray #2: Ä ';
    await getRuleSummary({ rule });
    expect(sent().query.get('rule')).toBe(rule);
  });

  it('surfaces a refused rule value with the server sentence', async () => {
    recordFetch(response(400, { detail: 'rule must be 1 to 256 characters on one line, without control characters' }));
    const error = await getRuleSummary({ rule: 'x' }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toMatch(/^rule must be 1 to 256 characters/);
  });
});

describe('the runbook client', () => {
  it('discards a draft bound to the revision the editor read', async () => {
    const { sent } = recordFetch(response(200, { id: 'x', removed: false, detail: null }), response(200, {}));
    await discardRunbookDraft('my runbook', 7);
    await discardRunbookDraft('my runbook');
    expect(sent(0)).toMatchObject({ method: 'DELETE', url: '/api/runbooks/my%20runbook/draft?expected_revision=7' });
    expect(sent(1).url).toBe('/api/runbooks/my%20runbook/draft');
    // `0` is a real revision, never dropped as empty.
    const again = recordFetch(response(200, {}));
    await discardRunbookDraft('x', 0);
    expect(again.sent().url).toBe('/api/runbooks/x/draft?expected_revision=0');
  });

  it('exports one exact version as a Markdown file', async () => {
    const file = new Blob(['# Phishing triage'], { type: 'text/markdown' });
    const { sent } = recordFetch(
      response(200, file, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="phishing-triage-v3.md"',
      }),
    );
    const result = await exportRunbookVersionMarkdown('phishing-triage', 3);
    expect(sent()).toMatchObject({ method: 'GET', url: '/api/runbooks/phishing-triage/export?version=3' });
    expect(result).toEqual({
      blob: file,
      contentType: 'text/markdown; charset=utf-8',
      contentDisposition: 'attachment; filename="phishing-triage-v3.md"',
    });
  });

  it('never turns a refused export into a file', async () => {
    recordFetch(
      response(404, { detail: { code: 'runbook_version_not_found', message: 'Version 9 of this runbook does not exist or you cannot see it.' } }),
    );
    const error = await exportRunbookVersionMarkdown('phishing-triage', 9).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('keeps the latest state of a 409 runbook_conflict for the editor', async () => {
    const latest = { summary: { id: 'x' }, revision: 9 };
    recordFetch(
      response(409, { detail: { code: 'runbook_conflict', message: 'Someone else changed this runbook.', revision: 9, latest } }),
    );
    const error = await saveRunbookDraft('x', { source: '---', expected_revision: 8 }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).body).toMatchObject({ detail: { code: 'runbook_conflict', revision: 9, latest } });
  });

  it('reads an old-shape write refusal (410 runbooks_moved, code beside a string detail)', async () => {
    recordFetch(
      response(410, {
        detail: 'Runbooks moved: use the runbook library routes.',
        code: 'runbooks_moved',
        see: '/api/runbooks',
      }),
    );
    const error = await createRunbook({ source: '---' }).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(410);
    expect((error as ApiError).message).toBe('Runbooks moved: use the runbook library routes.');
    expect((error as ApiError).body).toMatchObject({ code: 'runbooks_moved' });
  });

  it('sends each run write to its nested path with its body', async () => {
    const { sent } = recordFetch();
    await runRunbookLookup('case 1', 'run-1', 'lookup/1');
    await decideRunbookApproval('case-1', 'run-1', 'block-1', { decision: 'reject', reason: 'Not yet.' });
    await confirmRunbookStepDraft('case-1', 'run-1', 'record-1', { text: 'Edited.' });
    await abandonRunbookRun('case-1', 'run-1', 'Wrong runbook.');
    await testRunbookLookup({ lookup: LOOKUP, case_id: 'case-1' });
    expect(sent(0)).toMatchObject({ method: 'POST', url: '/api/cases/case%201/runbooks/run-1/steps/lookup%2F1/lookup', body: undefined });
    expect(sent(1)).toMatchObject({ url: '/api/cases/case-1/runbooks/run-1/steps/block-1/approval', body: { decision: 'reject', reason: 'Not yet.' } });
    expect(sent(2)).toMatchObject({ url: '/api/cases/case-1/runbooks/run-1/steps/record-1/draft/confirm', body: { text: 'Edited.' } });
    expect(sent(3)).toMatchObject({ url: '/api/cases/case-1/runbooks/run-1/abandon', body: { reason: 'Wrong runbook.' } });
    expect(sent(4)).toMatchObject({ url: '/api/runbooks/lookup-test', body: { lookup: LOOKUP, case_id: 'case-1' } });
  });

  it('sends the governance transitions with the revision they were decided on', async () => {
    const { sent } = recordFetch();
    await submitRunbookForReview('x', { version: 2 });
    await rejectRunbook('x', { version: 2, reason: 'Needs work.' });
    await retireRunbook('x');
    await restoreRunbook('x', { expected_revision: 3 });
    await markRunbookReviewed('x');
    await restoreRunbookVersionAsDraft('x', 1);
    await duplicateRunbook('brute_force_login');
    await getRunbookVersion('x', 2);
    expect(sent(0)).toMatchObject({ method: 'POST', url: '/api/runbooks/x/submit', body: { version: 2 } });
    expect(sent(1)).toMatchObject({ url: '/api/runbooks/x/reject', body: { version: 2, reason: 'Needs work.' } });
    expect(sent(2)).toMatchObject({ url: '/api/runbooks/x/retire', body: {} });
    expect(sent(3)).toMatchObject({ url: '/api/runbooks/x/restore', body: { expected_revision: 3 } });
    expect(sent(4)).toMatchObject({ url: '/api/runbooks/x/reviewed', body: {} });
    expect(sent(5)).toMatchObject({ url: '/api/runbooks/x/versions/1/restore', body: {} });
    expect(sent(6)).toMatchObject({ url: '/api/runbooks/brute_force_login/duplicate', body: {} });
    expect(sent(7)).toMatchObject({ method: 'GET', url: '/api/runbooks/x/versions/2', body: undefined });
  });

  it('previews a match and imports Markdown without writing anything else', async () => {
    const { sent } = recordFetch();
    await previewRunbookMatch({ definition: DEFINITION });
    await importRunbook('---\nid: phishing-triage\n---');
    expect(sent(0)).toMatchObject({ method: 'POST', url: '/api/runbooks/match-preview', body: { definition: DEFINITION } });
    expect(sent(1)).toMatchObject({ method: 'POST', url: '/api/runbooks/import', body: { source: '---\nid: phishing-triage\n---' } });
  });

  it('asks for no progress when there is no case', async () => {
    const { fetchMock } = recordFetch();
    await expect(getRunbookProgress([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves out an id the progress request would refuse, so one bad id never fails the batch', async () => {
    const { fetchMock, sent } = recordFetch(response(200, { 'case-1': { done: 1 } }));
    const progress = await getRunbookProgress(['case-1', '', 'x'.repeat(129), 'case-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().body).toEqual({ case_ids: ['case-1'] });
    expect(progress).toEqual({ 'case-1': { done: 1 } });
    // Only refusable ids: nothing to ask.
    const none = recordFetch();
    await expect(getRunbookProgress(['', 'y'.repeat(200)])).resolves.toEqual({});
    expect(none.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the AI refusals with their status', async () => {
    recordFetch(
      response(429, { detail: { code: 'runbook_ai_budget', message: 'The AI budget for today is used up.' } }),
      response(504, { detail: { code: 'runbook_ai_timeout', message: 'The AI took too long to answer. Try again.' } }),
    );
    const budget = await suggestRunbook('case-1').catch((e: unknown) => e);
    const timeout = await draftRunbookStep('case-1', 'run-1', 'record-1').catch((e: unknown) => e);
    expect([(budget as ApiError).status, (budget as ApiError).message]).toEqual([429, 'The AI budget for today is used up.']);
    expect((timeout as ApiError).status).toBe(504);
  });
});

describe('the existing calls that gained Round 14 fields', () => {
  it('filters Cases by an exact rule and by who closed them', async () => {
    const { sent } = recordFetch(response(200, { cases: [], total: 0, rule_applied: 'r 1 ', closed_by_applied: 'agent' }));
    const result = await api.listCases({ rule: 'r 1 ', closed_by: 'agent' });
    expect(sent().query.get('rule')).toBe('r 1 ');
    expect(sent().query.get('closed_by')).toBe('agent');
    expect(result.rule_applied).toBe('r 1 ');
    expect(result.closed_by_applied).toBe('agent');
  });

  it('filters Logs by an exact rule and a named severity, leaving out what is not set', async () => {
    const matched = { count: 12, relation: 'gte' };
    const { sent } = recordFetch(response(200, { logs: [], count: 0, sources: [], partial: false, matched }));
    const result = await fetchUnifiedLogs({ rule: 'Brute force & spray #2 ', severity_gte: 'high', query: '', source_id: undefined });
    expect(sent().path).toBe('/api/logs');
    expect([...sent().query.keys()].sort()).toEqual(['rule', 'severity_gte']);
    expect(sent().query.get('rule')).toBe('Brute force & spray #2 ');
    expect(sent().query.get('severity_gte')).toBe('high');
    expect(result.matched).toEqual(matched);
  });

  it('closes one case with the open steps fields and surfaces 409 runbook_steps_open', async () => {
    const detail = {
      code: 'runbook_steps_open',
      message: '2 required runbook steps are open.',
      required_open: 2,
      steps: [{ run_id: 'run-1', step_id: 'contain', title: 'Block the source', status: 'todo' }],
    };
    const { sent } = recordFetch(response(409, { detail }));
    const error = await api
      .caseActionExec('case-1', { action: 'close', require_open_steps_reason: true })
      .catch((e: unknown) => e);
    expect(sent().body).toEqual({ action: 'close', require_open_steps_reason: true });
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).body).toEqual({ detail });
  });

  it('asks the role simulation about the retired playbooks resource and reads its alias', async () => {
    const { sent } = recordFetch(
      response(200, {
        role: 'soc_manager',
        resource: 'playbooks',
        action: 'manage',
        allowed: true,
        actions: ['read', 'run', 'manage', 'publish'],
        known_resource: true,
        alias_of: 'runbooks',
        role_exists: true,
      }),
    );
    const result = await rolesApi.simulate('soc_manager', 'playbooks', 'manage');
    expect(sent().url).toBe('/api/roles/simulate?role=soc_manager&resource=playbooks&action=manage');
    expect(result.alias_of).toBe('runbooks');
  });
});

// --------------------------------------------------------------------------- //
// 3. The mirrors and the retired calls
// --------------------------------------------------------------------------- //
const MIRROR_MODULES = ['types-audit.ts', 'types-dashboards.ts', 'types-rules.ts', 'types-runbooks.ts'];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function exportedNames(source: string): string[] {
  const code = stripComments(source);
  const names = [...code.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  for (const m of code.matchAll(/^export\s+type\s*\{([^}]*)\}/gm)) {
    names.push(...m[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop() as string).filter(Boolean));
  }
  return names;
}

/**
 * The wire field names of a pydantic model class in a Python source (its own annotated
 * fields, an `alias` when it has one, plus those of a parent class in the same file).
 */
function pythonFields(source: string, className: string): string[] {
  const head = new RegExp(`^class ${className}\\((\\w+)\\):\\n`, 'm').exec(source);
  if (!head) throw new Error(`class ${className} not found`);
  const body = source.slice(head.index + head[0].length).split(/\n(?=\S)/)[0];
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const field = /^    ([A-Za-z]\w*)\s*:/.exec(line);
    if (!field || field[1] === 'model_config') continue;
    const alias = /alias="([^"]+)"/.exec(line);
    fields.push(alias ? alias[1] : field[1]);
  }
  const parent = head[1];
  const inherited = new RegExp(`^class ${parent}\\(`, 'm').test(source) && !/^_Strict$/.test(parent)
    ? pythonFields(source, parent)
    : [];
  return [...inherited, ...fields].sort();
}

/** The field names of an exported TypeScript interface. */
function tsFields(source: string, name: string): string[] {
  const head = new RegExp(`^export interface ${name}(?: extends [^{]+)? \\{\\n`, 'm').exec(source);
  if (!head) throw new Error(`interface ${name} not found`);
  const body = source.slice(head.index + head[0].length).split(/\n\}/)[0];
  return [...stripComments(body).matchAll(/^\s{2}([A-Za-z_]\w*)\??:/gm)].map((m) => m[1]).sort();
}

/** The member strings of an exported TypeScript literal union (`export type X = | 'a' | 'b';`). */
function tsUnion(source: string, name: string): string[] {
  const head = new RegExp(`^export type ${name} =`, 'm').exec(source);
  if (!head) throw new Error(`type ${name} not found`);
  const body = stripComments(source.slice(head.index + head[0].length).split(';')[0]);
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
}

/**
 * The text directly inside the bracket that opens at `open` in a Python source: nested
 * brackets are left out (each kept as an empty pair), comments are dropped, and string
 * literals are kept (`keepStrings`) or blanked. A small scanner, enough for the literal
 * dicts and calls these tests read; it throws when the bracket never closes.
 */
function pythonTopLevel(source: string, open: number, keepStrings = true): string {
  let depth = 1;
  let out = '';
  for (let i = open + 1; i < source.length; ) {
    const c = source[i];
    if (c === '#') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length && !source.startsWith(quote, j)) j += source[j] === '\\' ? 2 : 1;
      if (depth === 1) out += keepStrings ? source.slice(i, j + quote.length) : '""';
      i = j + quote.length;
      continue;
    }
    if ('([{'.includes(c)) {
      depth += 1;
      if (depth === 2) out += c;
    } else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) return out;
      if (depth === 1) out += c;
    } else if (depth === 1) {
      out += c;
    }
    i += 1;
  }
  throw new Error(`unclosed bracket at ${open}`);
}

/** The keys of the dict literal that follows the first `anchor` after `from` in a Python source. */
function pythonDictKeys(source: string, anchor: string, from = 0): string[] {
  const at = source.indexOf(anchor, from);
  if (at < 0) throw new Error(`'${anchor}' not found`);
  const open = source.indexOf('{', at + anchor.length - 1);
  return [...pythonTopLevel(source, open).matchAll(/"(\w+)"\s*:/g)].map((m) => m[1]).sort();
}

/** The keyword arguments of every call in a Python source whose first arguments are `lead`. */
function pythonCallKeywords(source: string, lead: string): string[][] {
  const calls: string[][] = [];
  for (let at = source.indexOf(lead); at >= 0; at = source.indexOf(lead, at + lead.length)) {
    const open = source.lastIndexOf('(', at);
    const text = pythonTopLevel(source, open, false);
    calls.push([...text.matchAll(/(?:^|[,\s])([A-Za-z_]\w*)\s*=(?!=)/g)].map((m) => m[1]));
  }
  return calls;
}

describe('the hand mirrors', () => {
  it('pins every mirror that has a schema of the same name', () => {
    const pins = readFileSync(resolve(LIB, 'types-contract-pins.ts'), 'utf8');
    const missing: string[] = [];
    let pinned = 0;
    for (const module of MIRROR_MODULES) {
      for (const name of exportedNames(readFileSync(resolve(LIB, module), 'utf8'))) {
        if (!(name in SPEC.components.schemas)) continue;
        pinned += 1;
        if (!pins.includes(`SameFields<${name}, '${name}'>`)) missing.push(`${module}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
    expect(pinned).toBeGreaterThan(70);
  });

  it('keeps the pins module type-only and imported by nothing', () => {
    const pins = stripComments(readFileSync(resolve(LIB, 'types-contract-pins.ts'), 'utf8'));
    for (const line of pins.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith('import ')) expect(line).toMatch(/^import type /);
      expect(line).not.toMatch(/^(export\s+)?(const|let|var|function|class|enum)\b/);
    }
    // Any import form (static, side effect, dynamic, require) names the module; a comment
    // that points a reader at the pins is not an import.
    const importsPins = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"][^'"]*types-contract-pins(?:\.ts)?['"]/;
    expect(importsPins.test("import type { X } from '@/lib/types-contract-pins';")).toBe(true);
    expect(importsPins.test("import './types-contract-pins.ts';")).toBe(true);
    expect(importsPins.test("const m = await import('../lib/types-contract-pins');")).toBe(true);
    expect(importsPins.test('// `JobParamsPins` in types-contract-pins.ts keeps it.')).toBe(false);
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && importsPins.test(readFileSync(path, 'utf8'))) {
          if (!path.endsWith('types-contract-pins.ts')) importers.push(path);
        }
      }
    };
    walk(SRC);
    expect(importers).toEqual([]);
  });

  it('re-exports the Round 14 modules from types.ts without a name collision', () => {
    const types = readFileSync(resolve(LIB, 'types.ts'), 'utf8');
    for (const module of MIRROR_MODULES) {
      expect(types).toContain(`export type * from './${module.replace(/\.ts$/, '')}';`);
    }
    const own = new Set(exportedNames(types));
    const collisions = MIRROR_MODULES.flatMap((module) =>
      exportedNames(readFileSync(resolve(LIB, module), 'utf8'))
        .filter((name) => own.has(name))
        .map((name) => `${module}: ${name}`),
    );
    expect(collisions).toEqual([]);
    // The names resolve to the same declarations wherever they are imported from.
    const record: AuditRecordFromTypes = { record_id: 'mem:1' } as AuditRecord;
    const detail: RunbookDetailFromTypes = { revision: 1 } as RunbookDetail;
    expect([record.record_id, detail.revision]).toEqual(['mem:1', 1]);
  });

  it('mirrors the runbook that guided an investigation beside the legacy procedure', () => {
    // The rationale endpoint's Round 14 shape (`engine/case_rationale.py`).
    const rationale: CaseRationale = {
      case_id: 'case-1',
      runbook: {
        id: 'brute-force',
        version: 4,
        title: 'Brute force and password spray',
        reason: 'Rule ssh_auth_failed matched.',
        consulted: true,
        selected_id: 'brute-force',
        status: 'matched',
        tier: 3,
        explanation: { tier: 3, matched: [{ criterion: 'rule_ids', value: ['ssh_auth_failed'] }], missed: [], tie: false },
      },
      playbook: { id: '', version: '', reason: '', consulted: false },
      procedure_provenance: {
        persona: { selected_id: '', selection_reason: '', consulted: false },
        playbook: { selected_id: '', selection_reason: '', consulted: false },
        runbook: {
          selected_id: 'brute-force',
          version: 4,
          title: 'Brute force and password spray',
          selection_reason: 'Rule ssh_auth_failed matched.',
          consulted: true,
        },
        consultation_path: 'investigator',
        retrieval_query_groups: [],
        knowledge: [],
      },
    };
    expect(rationale.runbook?.status).toBe('matched');
    expect(rationale.procedure_provenance?.runbook?.version).toBe(4);
  });

  it('retires the Scans page calls with the page (W8b: #/scans opens the Case Manager)', () => {
    const client = api as unknown as Record<string, unknown>;
    expect(client.scans).toBeUndefined();
    expect(client.scanNotifications).toBeUndefined();
    const types = stripComments(readFileSync(resolve(LIB, 'types.ts'), 'utf8'));
    expect(types).not.toMatch(/^export\s+interface\s+ScanNotifications\b/m);
    // No test mock keeps a key for the retired calls either.
    const stale: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.test\.tsx?$/.test(entry) && path !== fileURLToPath(import.meta.url)) {
          if (/\bscanNotifications\s*:|\bscans\s*:\s*(?:ok|vi\.fn)\b/.test(readFileSync(path, 'utf8'))) {
            stale.push(path.slice(SRC.length + 1));
          }
        }
      }
    };
    walk(SRC);
    expect(stale).toEqual([]);
  });

  it('retires the pre-Round 14 audit, playbook and runbook calls', () => {
    const client = api as unknown as Record<string, unknown> & { cases: Record<string, unknown> };
    for (const retired of [
      'audit',
      'getPlaybooks',
      'getPlaybook',
      'getPlaybookCoverage',
      'dryRunPlaybookSelection',
      'createPlaybook',
      'updatePlaybook',
      'getRunbooks',
      'getRunbook',
      'createRunbook',
      'updateRunbook',
      'deleteRunbook',
      'reindexRunbooks',
      'reindexRunbook',
    ]) {
      expect(client[retired], retired).toBeUndefined();
    }
    expect(client.cases.runPlaybook).toBeUndefined();
    // No test mock still names a retired call: a spy on a method that no longer exists
    // can never be called, so a "never called" assertion on it would pass vacuously.
    const stale: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.test\.tsx?$/.test(entry) && path !== fileURLToPath(import.meta.url)) {
          const text = readFileSync(path, 'utf8');
          if (/\b(?:getPlaybooks?|runPlaybook|getRunbooks?|reindexRunbooks?|dryRunPlaybookSelection)\s*:|\baudit:\s*\{\s*list\b/.test(text)) {
            stale.push(path.slice(SRC.length + 1));
          }
        }
      }
    };
    walk(SRC);
    expect(stale).toEqual([]);
    const types = stripComments(readFileSync(resolve(LIB, 'types.ts'), 'utf8'));
    expect(types).not.toMatch(
      /^export\s+interface\s+(Playbook\w*|Runbook(?:Detail|sResponse|MutationResponse|DeleteResponse|IndexResult|AuthoringStandard)?|AuditRecord|AuditResponse|AuditQuery)\b/m,
    );
  });

  it('mirrors the strict job params the OpenAPI schema leaves as a free object', () => {
    // `JobSubmit.params` is a dict in the schema, so these two mirrors cannot be pinned
    // at compile time. The backend models are strict (an unknown key answers 422), so
    // their field names are compared with the Python source instead.
    const python = readFileSync(resolve(WEBUI, '../backend/app/api/routes_jobs.py'), 'utf8');
    const lib = (name: string) => readFileSync(resolve(LIB, name), 'utf8');
    expect(pythonFields(python, 'AuditExportParams')).toEqual(tsFields(lib('types-audit.ts'), 'AuditExportJobParams'));
    expect(pythonFields(python, 'AuditExportFilters')).toEqual(tsFields(lib('types-audit.ts'), 'AuditFilters'));
    expect(pythonFields(python, 'CaseLifecycleParams')).toEqual(tsFields(lib('types.ts'), 'CaseLifecycleParams'));
    // The parser really reads the models (an alias, an inherited field, a Round 14 field).
    expect(pythonFields(python, 'AuditExportParams')).toEqual(['filters', 'format', 'from', 'order', 'q', 'scope', 'to']);
    expect(pythonFields(python, 'CaseLifecycleParams')).toEqual(
      expect.arrayContaining(['case_ids', 'action', 'open_steps_reason']),
    );
    expect(pythonFields(python, 'CaseLifecycleParams')).not.toContain('require_open_steps_reason');
  });

  it('mirrors the 409 runbook_steps_open body, which no response schema carries', () => {
    // `RunbookStepsOpen` and its detail are error bodies, never a response model, so
    // the OpenAPI schema (and the compile-time pins) cannot see them.
    const models = readFileSync(resolve(WEBUI, '../backend/app/models.py'), 'utf8');
    const lib = readFileSync(resolve(LIB, 'types-runbooks.ts'), 'utf8');
    for (const name of ['RunbookStepsOpen', 'RunbookStepsOpenDetail']) {
      expect(SPEC.components.schemas[name], name).toBeUndefined();
      expect(pythonFields(models, name), name).toEqual(tsFields(lib, name));
    }
    expect(pythonFields(models, 'RunbookStepsOpenDetail')).toEqual(['required_open', 'steps']);
  });

  it('mirrors the case rationale, which the route answers as a free object', () => {
    // `GET /api/cases/{case_id}/rationale` has no response model: compare the dicts
    // `engine/case_rationale.py` builds with the mirrors in `types.ts`.
    const op = SPEC.paths['/api/cases/{case_id}/rationale'].get as unknown as {
      responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
    };
    expect(op.responses['200'].content['application/json'].schema.properties).toBeUndefined();
    const py = readFileSync(resolve(WEBUI, '../backend/app/engine/case_rationale.py'), 'utf8');
    const types = readFileSync(resolve(LIB, 'types.ts'), 'utf8');
    const selection = tsFields(types, 'RationaleProcedureSelection');
    const runbookProvenance = [...selection, ...tsFields(types, 'RationaleRunbookProvenance')].sort();
    const build = py.indexOf('def build_rationale(');
    const provenance = py.indexOf('procedure_provenance: dict[str, Any] = {', build);
    const answer = py.indexOf('    return {', build);
    expect(Math.min(build, provenance, answer)).toBeGreaterThanOrEqual(0);

    // The answer and its procedure provenance, field for field.
    expect(pythonDictKeys(py, '    return {', build)).toEqual(tsFields(types, 'CaseRationale'));
    expect(pythonDictKeys(py, 'procedure_provenance: dict[str, Any] = {', build))
      .toEqual(tsFields(types, 'RationaleProcedureProvenance'));
    // Persona and the legacy playbook selection: the empty shape and the audited one.
    expect(pythonDictKeys(py, '"persona": {', provenance)).toEqual(selection);
    expect(pythonDictKeys(py, 'procedure_provenance[key] = {', provenance)).toEqual(selection);
    // The Round 14 runbook selection: the empty shape and the audited one.
    expect(pythonDictKeys(py, '"runbook": {', provenance)).toEqual(runbookProvenance);
    expect(pythonDictKeys(py, 'procedure_provenance["runbook"] = {', provenance)).toEqual(runbookProvenance);
    // The legacy procedure and the runbook that guided the latest run.
    expect(pythonDictKeys(py, '"playbook": {', answer)).toEqual(tsFields(types, 'RationalePlaybook'));
    expect(pythonDictKeys(py, '"runbook": {', answer)).toEqual(tsFields(types, 'RationaleRunbook'));
    expect(pythonDictKeys(py, '"runbook": {', answer)).toEqual(
      ['consulted', 'explanation', 'id', 'reason', 'selected_id', 'status', 'tier', 'title', 'version'],
    );
  });

  it('mirrors every guidance outcome the investigator records', () => {
    const py = readFileSync(resolve(WEBUI, '../backend/app/agents/investigator.py'), 'utf8');
    const recorded = [...py.matchAll(/^GUIDANCE_[A-Z_]+ = "([a-z_]+)"$/gm)].map((m) => m[1]).sort();
    expect(recorded.length).toBeGreaterThanOrEqual(8);
    expect(tsUnion(readFileSync(resolve(LIB, 'types-runbooks.ts'), 'utf8'), 'RunbookGuidanceStatus')).toEqual(recorded);
  });

  it('keeps the progress batch inside the bounds the request schema declares', () => {
    const caseIds = (SPEC.components.schemas.RunbookProgressBody.properties as Record<string, unknown>).case_ids as {
      maxItems: number;
      items: { minLength: number; maxLength: number };
    };
    expect(RUNBOOK_PROGRESS_BATCH).toBe(caseIds.maxItems);
    expect(RUNBOOK_PROGRESS_CASE_ID_MAX).toBe(caseIds.items.maxLength);
    expect(caseIds.items.minLength).toBe(1);
  });

  it('declares every field a 409 runbook_conflict can carry', () => {
    // The library and case routes add fields beside `code` and `message` as keyword
    // arguments of the error, and the latest state on the way out.
    const backend = (path: string) => readFileSync(resolve(WEBUI, '../backend/app', path), 'utf8');
    const sources = ['api/routes_runbooks.py', 'api/routes_case_runbooks.py', 'engine/runbook_runs.py', 'engine/runbook_catalog.py'].map(backend);
    const sent = new Set<string>();
    let raises = 0;
    for (const source of sources) {
      for (const keywords of pythonCallKeywords(source, '409, "runbook_conflict"')) {
        raises += 1;
        keywords.forEach((key) => sent.add(key));
      }
      for (const m of source.matchAll(/\b(?:extra|detail)(?:\["(\w+)"\]\s*=|\.setdefault\("(\w+)")/g)) sent.add(m[1] ?? m[2]);
    }
    expect(raises).toBeGreaterThanOrEqual(10);
    const declared = tsFields(readFileSync(resolve(LIB, 'types-runbooks.ts'), 'utf8'), 'RunbookConflictDetail');
    expect([...sent].sort()).toEqual(declared.filter((field) => field !== 'code' && field !== 'message'));
    // The scanner reads real calls: the create collision and the step conflict.
    expect(pythonCallKeywords(backend('api/routes_runbooks.py'), '409, "runbook_conflict"').flat()).toContain('exists');
    expect(pythonCallKeywords(backend('engine/runbook_runs.py'), '409, "runbook_conflict"').flat()).toContain('step_revision');
  });

  it('keeps the generated contract committed beside the mirrors', () => {
    expect(existsSync(resolve(LIB, 'api-types.gen.ts'))).toBe(true);
    for (const path of ['/api/audit/records/{record_id}', '/api/metrics/breakdown', '/api/rules/summary', '/api/runbooks/progress']) {
      expect(SPEC.paths[path], path).toBeTruthy();
    }
  });
});
