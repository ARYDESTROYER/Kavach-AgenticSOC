import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REVOKE_DELAY_MS } from '@/lib/download-blob';
import {
  artifactFilename,
  jobDestination,
  jobDestinationFromUrl,
  retainJobSubmissionIntent,
  saveBlob,
} from '../jobs';

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
