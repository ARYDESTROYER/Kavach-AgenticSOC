/**
 * The auth provider's sign-out signal (Round 14): when the person signed in to this tab
 * leaves (a deliberate sign-out, a session the server reports ended, another person in
 * the same browser), the provider tells the lazy modules that remember things for that
 * person (`lib/session-events.ts`); the Analytics range is one. Nothing is signalled on
 * the first load, on a refresh that keeps the same person, or with auth turned off.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const { meMock, logoutMock } = vi.hoisted(() => ({ meMock: vi.fn(), logoutMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  setUnauthorizedHandler: vi.fn(),
  setReauthHandler: vi.fn(),
  api: {
    auth: { me: () => meMock(), logout: () => logoutMock() },
    roles: { get: vi.fn().mockResolvedValue({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
  },
}));

import { AuthProvider, useAuth, type AuthContextValue } from '../auth';
import { onSignedOut } from '@/lib/session-events';

const signedIn = (username: string) => ({
  auth_enabled: true,
  authenticated: true,
  user: { username, role: 'analyst', must_change_password: false },
});

let auth: AuthContextValue;
function Probe() {
  auth = useAuth();
  return null;
}

async function mount() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(auth.loading).toBe(false));
}

const heard = vi.fn();
let stop: () => void = () => undefined;

beforeEach(() => {
  meMock.mockReset();
  logoutMock.mockReset().mockResolvedValue({ ok: true });
  heard.mockReset();
  stop = onSignedOut(heard);
});

afterEach(() => stop());

describe('AuthProvider sign-out signal', () => {
  it('says nothing on the first load or on a refresh that keeps the same person', async () => {
    meMock.mockResolvedValue(signedIn('ana'));
    await mount();
    expect(auth.username).toBe('ana');
    await act(async () => {
      await auth.refresh();
    });
    expect(heard).not.toHaveBeenCalled();
  });

  it('signals once when the person signs out', async () => {
    meMock.mockResolvedValue(signedIn('ana'));
    await mount();
    await act(async () => {
      await auth.logout();
    });
    expect(auth.isAuthenticated).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('signals when the server reports the session ended', async () => {
    meMock.mockResolvedValueOnce(signedIn('ana'));
    await mount();
    meMock.mockResolvedValue({ auth_enabled: true, authenticated: false, user: null, reason: 'idle' });
    await act(async () => {
      await auth.refresh();
    });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('signals when another person is signed in to the same browser', async () => {
    meMock.mockResolvedValueOnce(signedIn('ana'));
    await mount();
    meMock.mockResolvedValue(signedIn('ben'));
    await act(async () => {
      await auth.refresh();
    });
    expect(auth.username).toBe('ben');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('never signals with auth turned off', async () => {
    meMock.mockResolvedValue({ auth_enabled: false, authenticated: false, user: null });
    await mount();
    await act(async () => {
      await auth.logout();
    });
    expect(heard).not.toHaveBeenCalled();
  });
});
