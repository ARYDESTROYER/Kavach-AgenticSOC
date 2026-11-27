/**
 * The start screen greeting's display name after an Account page save (Round 13
 * leftovers): the page's `soc:account-profile-saved` window event replaces the greeting's
 * cached read at once, within the re-read minute and over a read that was already
 * running, and never for another user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ACCOUNT_PROFILE_SAVED_EVENT, GREETING_NAME_TTL_MS, clearGreetingNameCache, useGreetingName } from '../greeting';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** What the Account page fires after a save (`pages/Account.tsx`). */
function announceSaved(profile: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('soc:account-profile-saved', { detail: profile }));
}

/** The real `GET /api/account/me` body: the profile nested under `user`. */
function accountBody(username: string, displayName: string) {
  return { authenticated: true, auth_enabled: true, env_managed: false, user: { username, display_name: displayName } };
}

let clock = 1_000_000;

beforeEach(() => {
  clearGreetingNameCache();
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useGreetingName after an Account page save', () => {
  it('listens for the event name the Account page fires', () => {
    expect(ACCOUNT_PROFILE_SAVED_EVENT).toBe('soc:account-profile-saved');
  });

  it('uses a name saved in this tab at once, inside the re-read minute, with no request', async () => {
    const fetchMock = vi.fn(async () => json(accountBody('admin', 'Admin')));
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useGreetingName('admin'));
    await waitFor(() => expect(first.result.current).toBe('Admin'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // The Account page saves a new display name 20 seconds later.
    clock += 20_000;
    announceSaved({ username: 'admin', display_name: 'Priya Raman' });
    clock += 10_000;
    const second = renderHook(() => useGreetingName('admin'));
    // The first render already shows it (no stale frame), and nothing is re-read.
    expect(second.result.current).toBe('Priya');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    second.unmount();

    // The saved name counts as a fresh read: the next re-read comes a minute after the save.
    clock += GREETING_NAME_TTL_MS;
    renderHook(() => useGreetingName('admin'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the saved name when a read that started before the save lands after it', async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useGreetingName('admin'));
    expect(result.current).toBe('admin');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 1_000;
    announceSaved({ username: 'admin', display_name: 'Priya Raman' });
    await act(async () => {
      answer(json(accountBody('admin', 'Old Name')));
    });
    await waitFor(() => expect(result.current).toBe('Priya'));
    // The next mount reads the same name from the cache.
    expect(renderHook(() => useGreetingName('admin')).result.current).toBe('Priya');
  });

  it('ignores a profile saved for another user and an event without a username', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(accountBody('jdoe', 'Jane Doe'))));
    announceSaved({ username: 'admin', display_name: 'Priya Raman' });
    announceSaved({ display_name: 'Nobody' });
    window.dispatchEvent(new CustomEvent('soc:account-profile-saved'));
    const { result } = renderHook(() => useGreetingName('jdoe'));
    await waitFor(() => expect(result.current).toBe('Jane'));
  });
});
