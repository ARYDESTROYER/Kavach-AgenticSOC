import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REVOKE_DELAY_MS } from '@/lib/download-blob';
import {
  JOB_ACCEPTED_EVENT,
  JOB_TOAST_RELEASED_EVENT,
  announceJobAccepted,
  artifactFilename,
  destinationActionLabel,
  jobActionLabel,
  jobDestination,
  jobDestinationForKind,
  jobDestinationFromUrl,
  releaseJobToast,
  retainJobSubmissionIntent,
  saveBlob,
} from '../jobs';

const BACKEND_JOBS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../backend/app/engine/jobs.py');

describe('durable Jobs client invariants', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('retains a key only for one ambiguous intent, then rotates for a later identical action', () => {
    const first = retainJobSubmissionIntent(null, 'case_reinvestigate', {
      case_ids: ['case-1', 'case-2'],
      nested: { model: 'gpt', enabled: true },
    });
    const retry = retainJobSubmissionIntent(first, 'case_reinvestigate', {
      nested: { enabled: true, model: 'gpt' },
      case_ids: ['case-1', 'case-2'],
    });
    const changed = retainJobSubmissionIntent(first, 'case_reinvestigate', {
      case_ids: ['case-1', 'case-3'],
      nested: { model: 'gpt', enabled: true },
    });
    const laterIdentical = retainJobSubmissionIntent(null, 'case_reinvestigate', {
      nested: { enabled: true, model: 'gpt' },
      case_ids: ['case-1', 'case-2'],
    });

    expect(retry).toBe(first);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(laterIdentical.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(first.idempotencyKey.length).toBeLessThanOrEqual(120);
    expect(first.idempotencyKey).not.toContain('case-1');
  });

  it('keeps case-job fallback actions on the active filtered Cases surface', () => {
    expect(
      jobDestination({ kind: 'case_reinvestigate' } as Parameters<typeof jobDestination>[0]),
    ).toEqual({ page: 'cases', opts: { status: 'active' } });
  });

  it('accepts only known same-app destinations and fails closed on unknown or duplicate query keys', () => {
    expect(jobDestinationFromUrl('#/cases?status=investigating')).toEqual({
      page: 'cases',
      opts: {
        caseId: undefined,
        status: 'investigating',
        assignee: undefined,
        tag: undefined,
      },
    });
    expect(jobDestinationFromUrl('#/cases?assignee=tier-2%40example.com')).toEqual({
      page: 'cases',
      opts: {
        caseId: undefined,
        status: undefined,
        assignee: 'tier-2@example.com',
        tag: undefined,
      },
    });
    expect(jobDestinationFromUrl('#/cases?tag=needs-review')).toEqual({
      page: 'cases',
      opts: {
        caseId: undefined,
        status: undefined,
        assignee: undefined,
        tag: 'needs-review',
      },
    });
    expect(
      jobDestinationFromUrl(
        '#/cases?assignee=%E3%82%A2%E3%83%8A%E3%83%AA%E3%82%B9%E3%83%88',
      ),
    ).toEqual({
      page: 'cases',
      opts: {
        caseId: undefined,
        status: undefined,
        assignee: 'アナリスト',
        tag: undefined,
      },
    });
    expect(jobDestinationFromUrl('#/cases?tag=%E8%A6%81%E7%A2%BA%E8%AA%8D')).toEqual({
      page: 'cases',
      opts: {
        caseId: undefined,
        status: undefined,
        assignee: undefined,
        tag: '要確認',
      },
    });
    expect(jobDestinationFromUrl('#/settings/data-export')).toEqual({
      page: 'settings',
      opts: { section: 'data_export' },
    });
    expect(jobDestinationFromUrl('#/analytics?tab=jobs')).toEqual({ page: 'batchjobs' });
    expect(jobDestinationFromUrl('#/cases?status=open&next=https://attacker.example')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?status=open&status=closed')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?tag=ok%26next%3Djavascript%3Aalert%281%29')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?tag=review%2Furgent')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?assignee=analyst%E2%80%AEexe')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?assignee=analyst%0Aadmin')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?assignee=analyst%ZZ')).toBeNull();
    expect(jobDestinationFromUrl(`#/cases?assignee=${'a'.repeat(81)}`)).toBeNull();
    expect(jobDestinationFromUrl(`#/cases?tag=${'a'.repeat(41)}`)).toBeNull();
    expect(jobDestinationFromUrl('#/cases?status=admin')).toBeNull();
    expect(jobDestinationFromUrl('#/cases?assignee=ok&next=%2Fsettings')).toBeNull();
    expect(jobDestinationFromUrl('#/inbox?status=active')).toBeNull();
    expect(jobDestinationFromUrl('#/batchjobs?caseId=case-1')).toBeNull();
    expect(jobDestinationFromUrl('#/settings?s=data_export&section=data_export')).toBeNull();
    expect(jobDestinationFromUrl('https://attacker.example/#/cases')).toBeNull();
    expect(jobDestinationFromUrl('javascript:alert(1)')).toBeNull();
  });

  it('sends a finished audit export to the audit log, in the scope the server names (SPEC §4.5.8)', () => {
    expect(jobDestinationFromUrl('#/audit?scope=people')).toEqual({ page: 'audit', opts: { scope: 'people' } });
    expect(jobDestinationFromUrl('#/audit?scope=agent')).toEqual({ page: 'audit', opts: { scope: 'agent' } });
    expect(jobDestinationFromUrl('#/audit')).toEqual({ page: 'audit' });
    expect(jobDestinationFromUrl('#/audit?scope=admin')).toBeNull();
    expect(jobDestinationFromUrl('#/audit?scope=people&scope=all')).toBeNull();
    expect(jobDestinationFromUrl('#/audit?scope=')).toBeNull();
    // Never an open record: an export is a view, not one event.
    expect(jobDestinationFromUrl('#/audit?scope=people&record=sql:12')).toBeNull();
    // Without a server url the kind still leads to the audit log, never to Settings,
    // Data export (which an auditor cannot use).
    expect(jobDestinationForKind('audit_export')).toEqual({ page: 'audit' });
    const job = { kind: 'audit_export' } as Parameters<typeof jobDestination>[0];
    expect(jobDestination(job)).toEqual({ page: 'audit' });
    expect(jobActionLabel(job)).toBe('Open audit log');
    expect(jobDestinationForKind('data_export_archive')).toEqual({ page: 'settings', opts: { section: 'data_export' } });
  });

  it('opens an audit export in the exported view: its range, search and filters', () => {
    const url =
      '#/audit?scope=people&from=2026-09-29T17%3A58%3A15Z&to=2026-10-29T17%3A58%3A15Z&q=Admin%20role' +
      '&event=user.role_changed&actor=admin&actor_contains=adm&outcome=denied&case=case-1&target=user-7&ip=10.0.0.5';
    expect(jobDestinationFromUrl(url)).toEqual({
      page: 'audit',
      opts: {
        scope: 'people',
        from: '2026-09-29T17:58:15Z',
        to: '2026-10-29T17:58:15Z',
        q: 'Admin role',
        event: 'user.role_changed',
        actor: 'admin',
        actor_contains: 'adm',
        outcome: 'denied',
        case: 'case-1',
        target: 'user-7',
        ip: '10.0.0.5',
      },
    });
    // The page receives what a typed link could carry: the router's own grammar decides.
    const base = '#/audit?scope=all&from=2026-09-29T17%3A58%3A15Z&to=2026-10-29T17%3A58%3A15Z';
    expect(jobDestinationFromUrl(`${base}&q=role`)).toMatchObject({ opts: { q: 'role' } });
    expect(jobDestinationFromUrl(`${base}&q=${'a'.repeat(201)}`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&q=role%0Aadmin`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&q=role%E2%80%AEexe`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&event=Not%20an%20action`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&outcome=granted`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&ip=999.1.1.1`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&case=case%2F1`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&q=role&q=admin`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&next=https://attacker.example`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&constructor=x`)).toBeNull();
    expect(jobDestinationFromUrl(`${base}&actor=`)).toBeNull();
    // Both bounds, absolute to the second: a relative window would move with the clock.
    expect(jobDestinationFromUrl('#/audit?scope=all&from=now-30d&to=now')).toBeNull();
    expect(jobDestinationFromUrl('#/audit?scope=all&from=2026-09-29T17%3A58%3A15Z')).toBeNull();
    expect(jobDestinationFromUrl('#/audit?scope=all&from=2026-09-29T17%3A58%3A15.250Z&to=2026-10-29T17%3A58%3A15Z')).toBeNull();
    expect(jobDestinationFromUrl('#/audit?scope=all&from=2026-09-29T17%3A58%3A15%2B05%3A00&to=2026-10-29T17%3A58%3A15Z')).toBeNull();
    // The search alone, without a range, is still the export's view in its scope.
    expect(jobDestinationFromUrl('#/audit?scope=people&q=role')).toEqual({ page: 'audit', opts: { scope: 'people', q: 'role' } });
  });

  it('names a result link by where it goes', () => {
    expect(destinationActionLabel({ page: 'audit', opts: { scope: 'people' } })).toBe('Open audit log');
    expect(destinationActionLabel({ page: 'cases', opts: { status: 'active' } })).toBe('View matching cases');
    expect(destinationActionLabel({ page: 'settings', opts: { section: 'data_export' } })).toBe('Open Data export');
    expect(destinationActionLabel({ page: 'knowledge' })).toBe('Open Knowledge');
    expect(destinationActionLabel({ page: 'batchjobs' })).toBe('View result');
  });

  it('accepts every destination the server writes for a job (engine/jobs.py job_url)', () => {
    const source = readFileSync(BACKEND_JOBS, 'utf8');
    const start = source.indexOf('def job_url(');
    const body = source.slice(start, source.indexOf('\ndef ', start + 1));
    const fixed = [...body.matchAll(/return "(#\/[^"]+)"/g)].map((m) => m[1]);
    // The f-string routes, with every value the server can put in them.
    const statuses = [...body.matchAll(/"[a-z_]+": "([a-z_]+)"/g)].map((m) => m[1]);
    const scopes = [...(/scope in \{([^}]*)\}/.exec(body)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(fixed.length).toBeGreaterThanOrEqual(6);
    expect(statuses).toEqual(expect.arrayContaining(['closed', 'resolved', 'escalated', 'on_hold', 'investigating', 'open']));
    expect(scopes.sort()).toEqual(['agent', 'all', 'people']);
    const urls = [
      ...fixed,
      ...[...statuses, 'active'].map((status) => `#/cases?status=${status}`),
      ...scopes.map((scope) => `#/audit?scope=${scope}`),
      // The exported view, once the server writes it (SPEC §4.5.8).
      '#/audit?scope=people&from=2026-09-29T17%3A58%3A15Z&to=2026-10-29T17%3A58%3A15Z&q=Admin&outcome=success',
      '#/cases?assignee=tier-2',
      '#/cases?tag=needs-review',
    ];
    expect(urls.filter((url) => jobDestinationFromUrl(url) === null)).toEqual([]);
  });

  it('tells the shell which accepted jobs their surface reports itself, and when it stops', () => {
    const seen: Array<{ type: string; detail: unknown }> = [];
    const listen = (event: Event) => seen.push({ type: event.type, detail: (event as CustomEvent).detail });
    window.addEventListener(JOB_ACCEPTED_EVENT, listen);
    window.addEventListener(JOB_TOAST_RELEASED_EVENT, listen);
    try {
      const accepted = { job_id: 'job-9', status: 'queued' } as Parameters<typeof announceJobAccepted>[0];
      announceJobAccepted(accepted);
      announceJobAccepted(accepted, { quiet: true });
      releaseJobToast('job-9');
      releaseJobToast('job-9', { reported: true });
      releaseJobToast('');
    } finally {
      window.removeEventListener(JOB_ACCEPTED_EVENT, listen);
      window.removeEventListener(JOB_TOAST_RELEASED_EVENT, listen);
    }
    expect(seen).toEqual([
      { type: JOB_ACCEPTED_EVENT, detail: { job_id: 'job-9', status: 'queued', quiet: false } },
      { type: JOB_ACCEPTED_EVENT, detail: { job_id: 'job-9', status: 'queued', quiet: true } },
      { type: JOB_TOAST_RELEASED_EVENT, detail: { job_id: 'job-9', reported: false } },
      { type: JOB_TOAST_RELEASED_EVENT, detail: { job_id: 'job-9', reported: true } },
    ]);
  });

  it('sanitizes an artifact filename and falls back when disposition is unsafe', () => {
    expect(
      artifactFilename("attachment; filename*=UTF-8''..%2Fportable%20export.zip", 'fallback.zip'),
    ).toBe('portable-export.zip');
    expect(artifactFilename('attachment; filename="../../"', 'fallback.zip')).toBe('fallback.zip');
  });
});

describe('saving a job artifact', () => {
  const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.assign(URL, original);
  });

  it('keeps the object URL alive after the click and revokes it only after the shared delay', () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:artifact'), revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const name = saveBlob(
      { blob: new Blob(['zip']), contentDisposition: 'attachment; filename="export.zip"', contentType: null },
      'fallback.zip',
    );
    expect(name).toBe('export.zip');
    expect(click).toHaveBeenCalledTimes(1);
    // Revoking at once (or after 0 ms) can cancel the download in Safari and older Firefox.
    vi.advanceTimersByTime(100);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledWith('blob:artifact');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('refuses an empty artifact and says when the browser cannot download', () => {
    expect(() => saveBlob({ blob: new Blob([]), contentDisposition: null, contentType: null }, 'x.zip')).toThrow(
      'The server returned an empty artifact. No file was saved.',
    );
    Object.assign(URL, { createObjectURL: undefined });
    expect(() => saveBlob({ blob: new Blob(['zip']), contentDisposition: null, contentType: null }, 'x.zip')).toThrow(
      'This browser could not start the download. No file was saved.',
    );
  });
});
