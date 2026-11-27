/**
 * Round 14 FX7e: the step-up gate learns what a fresh sign-in is for (roles-12), and
 * the Console reads the signed-in person's effective grants from one server read
 * (roles-01).
 *
 *   - A request's `reauthPurpose` reaches the registered gate when the server answers
 *     `401 reauth_required`; a request without one passes nothing, so the dialog says
 *     it confirms a change.
 *   - A background-job submit passes its caller's purpose (an export says it exports;
 *     a reset passes none, so it reads as a change); the job body is unchanged.
 *   - A cancelled step-up surfaces the plain "Sign in again to continue." sentence.
 *   - A wrong password at the fresh sign-in (`reason:'bad_password'`, no message) says
 *     the password is not correct, never the step-up label "Sign in again to continue."
 *     (FX7e fix).
 *   - A `tv_mismatch` (every session ended, as after "Sign out everywhere") is not a
 *     step-up: no fresh sign-in can revive it, so the dialog never opens and the
 *     lapsed-session bounce to the sign-in page runs instead (FX7e fix).
 *   - `api.account.permissions()` reads `GET /api/account/permissions`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, request, setReauthHandler, setUnauthorizedHandler } from '../api';

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

const stepUp = () => jsonResponse(401, { detail: { code: 'reauth_required', reason: 'stale_authn' } });

afterEach(() => {
  setReauthHandler(null);
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('the step-up gate receives what the sign-in is for', () => {
  it('passes a request purpose to the gate, then retries once', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    setReauthHandler(gate);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stepUp())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      request('POST', 'jobs', { body: { kind: 'audit_export' }, reauthPurpose: 'Sign in again to export audit events.' }),
    ).resolves.toEqual({ ok: true });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith('Sign in again to export audit events.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes no purpose for a request that names none (a change)', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    setReauthHandler(gate);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(stepUp())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })));

    await api.put('roles', { name: 'r' });
    expect(gate).toHaveBeenCalledWith(undefined);
  });

  it.each([
    ['data_export_archive', 'Sign in again to start this export.'],
    ['tiered_reset', undefined],
  ] as const)('a %s job submit passes its purpose (%s) to the gate', async (kind, purpose) => {
    const gate = vi.fn().mockResolvedValue(true);
    setReauthHandler(gate);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stepUp())
      .mockResolvedValueOnce(jsonResponse(200, { job_id: 'j1', kind }));
    vi.stubGlobal('fetch', fetchMock);

    await api.jobs.submit({ kind, idempotency_key: 'k', params: {} } as never, purpose);
    expect(gate).toHaveBeenCalledWith(purpose);
    // The purpose is client-side only: the body the server sees is unchanged.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ kind, idempotency_key: 'k', params: {} });
  });

  it('a cancelled step-up surfaces a plain sentence', async () => {
    setReauthHandler(vi.fn().mockResolvedValue(false));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stepUp()));
    const error = await request('POST', 'jobs', { body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('Sign in again to continue.');
  });
});

describe('a wrong password at the fresh sign-in', () => {
  it('says the password is not correct, and neither re-opens the gate nor bounces', async () => {
    const gate = vi.fn().mockResolvedValue(true);
    const unauthorized = vi.fn();
    setReauthHandler(gate);
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(401, { detail: { code: 'reauth_required', reason: 'bad_password' } }),
    ));

    const error = await api.auth.reauth('wrong-password').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('That password is not correct. Try again.');
    expect(gate).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a server message still wins over the worded reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(401, { detail: { code: 'reauth_required', reason: 'bad_password', message: 'Locked for a minute.' } }),
    ));
    const error = await api.auth.reauth('x').catch((e: unknown) => e);
    expect((error as ApiError).message).toBe('Locked for a minute.');
  });
});

describe('an ended session is not a step-up', () => {
  const allEnded = () => jsonResponse(401, { detail: { code: 'reauth_required', reason: 'tv_mismatch' } });

  it.each([
    ['GET', 'cases'],
    ['POST', 'jobs'],
  ] as const)('a %s %s answered tv_mismatch bounces to sign-in without the dialog', async (method, path) => {
    const gate = vi.fn().mockResolvedValue(true);
    const unauthorized = vi.fn();
    setReauthHandler(gate);
    setUnauthorizedHandler(unauthorized);
    const fetchMock = vi.fn().mockResolvedValue(allEnded());
    vi.stubGlobal('fetch', fetchMock);

    const error = await request(method, path, { reauthPurpose: 'Sign in again to export audit events.' })
      .catch((e: unknown) => e);
    expect(gate).not.toHaveBeenCalled();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    // No retry: the one request went out once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a step-up with any other reason still opens the dialog and does not bounce', async () => {
    const gate = vi.fn().mockResolvedValue(false);
    const unauthorized = vi.fn();
    setReauthHandler(gate);
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stepUp()));

    await request('POST', 'jobs', { body: {} }).catch(() => undefined);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });
});

describe('the effective grants read', () => {
  it('api.account.permissions reads GET /api/account/permissions', async () => {
    const body = {
      authenticated: true,
      role: 'analyst_tier1',
      custom_roles: ['cr_publish'],
      rbac_enabled: true,
      permissions: { runbooks: ['read', 'manage', 'publish'] },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, body));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.account.permissions()).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/permissions');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});
