/**
 * The audit log view a finished audit export holds, for the Jobs list (SPEC §4.5.8): read
 * from the job's own params, written with the server's keys and instants and validated as
 * the server's result URL is, so Jobs, the Inbox and a toast open the same rows.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { BackgroundJob } from '@/lib/types';

import { AUDIT_EXPORT_ROUTE_FILTERS, auditExportView, auditRouteInstant } from '../audit-export-view';

const BACKEND_JOBS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../backend/app/engine/jobs.py');

function exportJob(params: Record<string, unknown>, overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    job_id: 'job-audit-1',
    kind: 'audit_export',
    actor: 'auditor',
    created_at: '2026-10-29T17:58:16Z',
    status: 'succeeded',
    progress: { done: 12, total: 12, unit: 'events' },
    failures: [],
    failure_count: 0,
    failures_truncated: 0,
    request_fingerprint: 'fp',
    result: { kind: 'audit_export', artifact_id: 'a1', counts: { events: 12 } },
    params,
    cancel_requested: false,
    ...overrides,
  };
}

const EXPORTED = {
  format: 'csv',
  order: 'asc',
  scope: 'people',
  from: '2026-09-29T17:58:15Z',
  to: '2026-10-29T17:58:15Z',
  q: ' Admin ',
  filters: { outcome: 'denied', case_id: 'case-1', actor_kind: 'human', surface: 'api', source_id: 's1', actor: '' },
};

describe('the audit log view of a listed audit export', () => {
  it('opens the exported range, search and filters the route carries', () => {
    expect(auditExportView(exportJob(EXPORTED))).toEqual({
      page: 'audit',
      opts: {
        scope: 'people',
        from: '2026-09-29T17:58:15Z',
        to: '2026-10-29T17:58:15Z',
        q: 'Admin',
        outcome: 'denied',
        case: 'case-1',
      },
    });
    expect(auditExportView(exportJob(EXPORTED, { status: 'partial' }))).not.toBeNull();
  });

  it("writes each bound as the server's result URL does: UTC, to the second", () => {
    // The same instants as the server's test_an_audit_export_links_to_the_view_it_holds.
    expect(auditRouteInstant('2026-10-18T20:40:00.750+05:30')).toBe('2026-10-18T15:10:00Z');
    expect(auditRouteInstant('2026-10-25T15:10:00.250Z')).toBe('2026-10-25T15:10:00Z');
    expect(auditRouteInstant('0999-01-01T00:00:00Z')).toBe('0999-01-01T00:00:00Z');
    expect(auditRouteInstant(' 2026-10-25t15:10z ')).toBeNull();
    expect(auditRouteInstant(' 2026-10-25T15:10z ')).toBe('2026-10-25T15:10:00Z');
    expect(auditRouteInstant('2026-12-31T22:30:59.999999-01:45')).toBe('2027-01-01T00:15:59Z');
    // Anything the server would not read as an instant is left out.
    for (const value of [
      'now-7d',
      '2026-10-25',
      '2026-10-25T15:10:00',
      '2026-02-30T00:00:00Z',
      '2026-10-25T24:00:00Z',
      '2026-10-25T15:10:60Z',
      '2026-10-25T15:10:00+24:00',
      '2026-10-25T15:10:00.1234567Z',
      '0000-06-01T00:00:00Z',
      '0001-01-01T00:00:00+00:01',
      '9999-12-31T23:59:59-00:01',
      42,
      null,
    ]) {
      expect(auditRouteInstant(value), String(value)).toBeNull();
    }
  });

  it('opens the full view of an export submitted with another zone or a fraction', () => {
    expect(
      auditExportView(exportJob({ ...EXPORTED, from: '2026-09-29T23:28:15.500+05:30', to: '2026-10-29T17:58:15.250Z' })),
    ).toEqual({
      page: 'audit',
      opts: {
        scope: 'people',
        from: '2026-09-29T17:58:15Z',
        to: '2026-10-29T17:58:15Z',
        q: 'Admin',
        outcome: 'denied',
        case: 'case-1',
      },
    });
  });

  it('keeps the scope when the view does not validate, and links nothing else', () => {
    // A range the server would not link (date math) leaves both bounds out, as it does.
    expect(auditExportView(exportJob({ ...EXPORTED, from: 'now-30d' }))).toEqual({
      page: 'audit',
      opts: { scope: 'people', q: 'Admin', outcome: 'denied', case: 'case-1' },
    });
    expect(auditExportView(exportJob({ scope: 'people', q: 'role\u0007' }))).toEqual({ page: 'audit', opts: { scope: 'people' } });
    expect(auditExportView(exportJob({ scope: 'admin' }))).toEqual({ page: 'audit' });
    expect(auditExportView(exportJob({ filters: ['not', 'a', 'map'] }))).toEqual({ page: 'audit' });
    for (const status of ['queued', 'running', 'failed', 'cancelled'] as const) {
      expect(auditExportView(exportJob(EXPORTED, { status })), status).toBeNull();
    }
    expect(auditExportView(exportJob(EXPORTED, { kind: 'data_export_archive' }))).toBeNull();
  });

  it("maps the filters exactly as the server's result URL does (engine/jobs.py)", () => {
    const source = readFileSync(BACKEND_JOBS, 'utf8');
    const body = /^_AUDIT_ROUTE_FILTERS[^=]*= \(([\s\S]*?)^\)/m.exec(source)?.[1] ?? '';
    const server = [...body.matchAll(/\("([a-z_]+)", "([a-z_]+)"\)/g)].map((m) => [m[1], m[2]]);
    expect(server).toEqual(AUDIT_EXPORT_ROUTE_FILTERS.map(([name, key]) => [name, key]));
  });
});
