/**
 * Round-6 auth-login fixes for the session pages.
 *
 *  - finding 18 (Sessions): the Refresh + destructive "Sign out all other sessions"
 *    header actions are hidden when the body says there is nothing to manage
 *    (auth disabled / signed out).
 *  - finding 3 (AdminSessions): a FAILED session load renders a distinct LoadError
 *    (with retry), not the misleading "No active sessions." empty table.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { meMock, sessionsListMock, activityMock, adminListMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  sessionsListMock: vi.fn(),
  activityMock: vi.fn(),
  adminListMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status: number;
    constructor(status = 0, message = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: () => meMock(), logout: ok({ ok: true }) },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      sessions: { list: () => sessionsListMock(), revoke: vi.fn(), revokeOthers: vi.fn() },
      account_activity: () => activityMock(),
      admin: {
        sessions: { list: () => adminListMock(), revoke: vi.fn() },
        users: { revokeAll: vi.fn() },
      },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Sessions from '../pages/Sessions';
import AdminSessions from '../pages/AdminSessions';

function mount(node: React.ReactElement) {
  return render(
    <AuthProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  meMock.mockReset();
  sessionsListMock.mockReset();
  activityMock.mockReset();
  adminListMock.mockReset();
  sessionsListMock.mockResolvedValue({ sessions: [] });
  activityMock.mockResolvedValue({ activity: [] });
});

describe('Sessions — header actions guarded when signed out (finding 18)', () => {
  it('hides Refresh + "Sign out all other sessions" when auth is disabled', async () => {
    meMock.mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    mount(<Sessions onNavigate={vi.fn()} />);
    // The body explains there's nothing to manage…
    expect(await screen.findByText(/Authentication is disabled/i)).toBeInTheDocument();
    // …so the destructive action + Refresh are not shown alongside it.
    expect(screen.queryByRole('button', { name: /Sign out all other sessions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/i })).toBeNull();
  });
});

describe('AdminSessions — failed load shows LoadError (finding 3)', () => {
  it('renders a retryable LoadError, not the empty "No active sessions." table', async () => {
    meMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'root', role: 'super_admin' },
    });
    adminListMock.mockRejectedValue(new Error('sessions 500'));
    mount(<AdminSessions onNavigate={vi.fn()} />);
    expect(await screen.findByText(/Couldn't load sessions/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    // The empty-state string must NOT masquerade as a genuine empty set.
    await waitFor(() => expect(screen.queryByText('No active sessions.')).toBeNull());
  });
});
