/**
 * Account page over the REAL `/api/account/me` body (Round 13 leftovers).
 *
 * `account.render.test.tsx` mocks `api.account.*` with flat profiles; this file keeps
 * the real `api` client and stubs `fetch` with the bodies the routes actually send
 * (`{authenticated, auth_enabled, env_managed, user}` for GET, `{ok, user}` for PUT), so
 * the page hydrates the display name and the other fields, a save keeps every field the
 * analyst did not touch, and the saved name reaches the chat greeting at once.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Account from '../pages/Account';
import { ACCOUNT_PROFILE_SAVED_EVENT, clearGreetingNameCache, useGreetingName } from '../chat/starters/greeting';

type Body = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let stored: Body;
let envManaged: boolean;
let calls: { method: string; path: string; body?: Body }[];

function stubServer() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).split('?')[0];
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    calls.push({ method, path, body });
    if (path === '/api/auth/me') {
      return json({ auth_enabled: true, authenticated: true, user: { username: stored.username, role: stored.role } });
    }
    if (path === '/api/roles') return json({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
    if (path === '/api/account/me' && method === 'GET') {
      return json({ authenticated: true, auth_enabled: true, env_managed: envManaged, user: stored });
    }
    if (path === '/api/account/me' && method === 'PUT') {
      stored = { ...stored, ...body };
      return json({ ok: true, user: stored });
    }
    return json({ detail: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const profileReads = () => calls.filter((c) => c.path === '/api/account/me' && c.method === 'GET').length;

function renderAccount() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <Account onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  stored = {
    username: 'asharma',
    role: 'analyst_tier1',
    display_name: 'Aryan Sharma',
    alias: 'nightshift',
    alt_email: 'aryan@home.test',
    timezone: '',
    locale: '',
    avatar: '',
    mfa_enabled: false,
  };
  envManaged = false;
  calls = [];
  clearGreetingNameCache();
  stubServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Account page over the nested account body', () => {
  it('hydrates the display name and the other fields from `user`', async () => {
    renderAccount();
    const display = (await screen.findByLabelText('Display name', undefined, { timeout: 5000 })) as HTMLInputElement;
    expect(display.value).toBe('Aryan Sharma');
    expect((screen.getByLabelText('Alias / handle') as HTMLInputElement).value).toBe('nightshift');
    expect(screen.getByText('@asharma')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled();
  });

  it('saves a new display name, keeps the other fields and hands the name to the chat greeting', async () => {
    const announced: unknown[] = [];
    const onSaved = (event: Event) => announced.push((event as CustomEvent).detail);
    window.addEventListener(ACCOUNT_PROFILE_SAVED_EVENT, onSaved);
    renderAccount();
    const display = (await screen.findByLabelText('Display name', undefined, { timeout: 5000 })) as HTMLInputElement;
    fireEvent.change(display, { target: { value: 'Priya Raman' } });
    const save = screen.getByRole('button', { name: /Save changes/i });
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(save);

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true), { timeout: 5000 });
    const put = calls.find((c) => c.method === 'PUT');
    // The patch carries the loaded values of the untouched fields, not blanks.
    expect(put?.body).toMatchObject({ display_name: 'Priya Raman', alias: 'nightshift', alt_email: 'aryan@home.test' });
    // After the `{ok, user}` answer the form still shows every field and is clean again.
    await waitFor(() => expect(save).toBeDisabled(), { timeout: 5000 });
    expect(display.value).toBe('Priya Raman');
    expect((screen.getByLabelText('Alias / handle') as HTMLInputElement).value).toBe('nightshift');
    expect(stored.alias).toBe('nightshift');

    // The page announces the saved flat profile once; the greeting on the next new chat
    // uses it with no wait and no re-read.
    window.removeEventListener(ACCOUNT_PROFILE_SAVED_EVENT, onSaved);
    expect(announced).toEqual([expect.objectContaining({ username: 'asharma', display_name: 'Priya Raman', alias: 'nightshift' })]);
    const readsBefore = profileReads();
    const { result } = renderHook(() => useGreetingName('asharma'));
    expect(result.current).toBe('Priya');
    expect(profileReads()).toBe(readsBefore);
  });

  it('shows the environment administrator read-only from the route env_managed', async () => {
    stored = { username: 'admin', role: 'super_admin', display_name: '', alias: '', avatar: '' };
    envManaged = true;
    renderAccount();
    expect(await screen.findByText(/environment-provisioned administrator/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save changes/i })).toBeNull();
  });
});

void React;
