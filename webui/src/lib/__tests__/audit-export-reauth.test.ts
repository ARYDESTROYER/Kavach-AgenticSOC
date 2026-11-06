/**
 * Round 14 FX7e, finding roles-12: an audit export is a read, so the fresh sign-in it
 * asks for says what it is for ("Sign in again to export audit events."), never that it
 * confirms a change. The purpose rides the request to the shared step-up gate; the job
 * body the server sees is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setReauthHandler } from '../api';
import { AUDIT_EXPORT_REAUTH_PURPOSE, submitAuditExport } from '../api-audit';
import type { AuditExportJobParams } from '../types-audit';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  setReauthHandler(null);
  vi.unstubAllGlobals();
});

describe('the audit export asks to sign in again for the export', () => {
  it('passes its purpose to the step-up gate and retries once', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    setReauthHandler(gate);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: { code: 'reauth_required', reason: 'stale_or_revoked_authority' } }))
      .mockResolvedValueOnce(jsonResponse(200, { job_id: 'j1', kind: 'audit_export' }));
    vi.stubGlobal('fetch', fetchMock);
    const params = { format: 'csv', order: 'asc', scope: 'all', from: 'a', to: 'b', filters: {} } as unknown as AuditExportJobParams;

    await submitAuditExport(params, 'key-1');

    expect(AUDIT_EXPORT_REAUTH_PURPOSE).toBe('Sign in again to export audit events.');
    expect(gate).toHaveBeenCalledWith('Sign in again to export audit events.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      kind: 'audit_export',
      idempotency_key: 'key-1',
      params,
    });
  });
});
