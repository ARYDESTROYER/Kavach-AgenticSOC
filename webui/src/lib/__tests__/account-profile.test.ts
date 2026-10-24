/**
 * `api.account.*` unwrap the account routes' nested body once (Round 13 leftovers).
 *
 * `GET /api/account/me` answers `{authenticated, auth_enabled, env_managed, user: {...}}`
 * and `PUT /api/account/me` / `PUT /api/me/avatar` answer `{ok, user: {...}}`
 * (`routes.account_me`, `update_account_me`, `update_my_avatar`). Every caller (the
 * Account page, the shell's user chip, the chat greeting) reads the flat profile, so the
 * helpers return `user` with the route's `env_managed` on it; a flat body passes through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const STORED_USER = {
  username: 'asharma',
  role: 'analyst_tier1',
  display_name: 'Aryan Sharma',
  alias: 'nightshift',
  alt_email: 'aryan@home.test',
  timezone: 'Asia/Kolkata',
  locale: 'en-GB',
  avatar: '',
  mfa_enabled: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.account', () => {
  it('get returns the nested profile flat, with the route env_managed on it', async () => {
    const fetchMock = stubFetch({ authenticated: true, auth_enabled: true, env_managed: false, user: STORED_USER });
    const profile = await api.account.get();
    expect(profile).toEqual({ ...STORED_USER, env_managed: false });
    expect(profile.display_name).toBe('Aryan Sharma');
    expect(fetchMock).toHaveBeenCalledWith('/api/account/me', expect.objectContaining({ method: 'GET' }));
  });

  it('get keeps env_managed for the environment administrator and the auth-off stub', async () => {
    stubFetch({
      authenticated: true,
      auth_enabled: true,
      env_managed: true,
      user: { username: 'admin', role: 'super_admin', display_name: '', alias: '', avatar: '' },
    });
    const env = await api.account.get();
    expect(env).toMatchObject({ username: 'admin', role: 'super_admin', env_managed: true });
    expect(env).not.toHaveProperty('user');

    stubFetch({ authenticated: true, auth_enabled: false, env_managed: false, user: { username: '', role: 'super_admin' } });
    expect(await api.account.get()).toEqual({ username: '', role: 'super_admin', env_managed: false });
  });

  it('put and avatar unwrap {ok, user}, so a save keeps every other field', async () => {
    const saved = { ...STORED_USER, display_name: 'Priya Raman' };
    const putFetch = stubFetch({ ok: true, user: saved });
    const next = await api.account.put({ display_name: 'Priya Raman' });
    expect(next).toEqual(saved);
    expect(next.alias).toBe('nightshift');
    expect(next).not.toHaveProperty('ok');
    expect(putFetch).toHaveBeenCalledWith(
      '/api/account/me',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ display_name: 'Priya Raman' }) }),
    );

    const withPhoto = { ...STORED_USER, avatar: 'data:image/webp;base64,AAAA' };
    stubFetch({ ok: true, user: withPhoto });
    expect(await api.account.avatar('data:image/webp;base64,AAAA')).toEqual(withPhoto);
    stubFetch({ ok: true, user: { ...STORED_USER, avatar: '' } });
    expect((await api.account.avatar('')).avatar).toBe('');
  });

  it('passes a flat body through unchanged (older backends, fixtures)', async () => {
    const flat = { ...STORED_USER, env_managed: false };
    stubFetch(flat);
    expect(await api.account.get()).toEqual(flat);
    // A flat profile that happens to carry a `user` field is still flat (it has a username).
    stubFetch({ username: 'flat', display_name: 'Flat Name', user: { username: 'other' } });
    expect(await api.account.get()).toMatchObject({ username: 'flat', display_name: 'Flat Name' });
    // A `user` that is not an object is not unwrapped.
    stubFetch({ ok: true, user: 'asharma' });
    expect(await api.account.get()).toEqual({ ok: true, user: 'asharma' });
  });
});
