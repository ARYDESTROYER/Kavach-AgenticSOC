/**
 * Admin Sessions console — render + terminate-confirm test.
 *
 * Mocks GET /api/admin/sessions (sessions across two users), mounts
 * <AdminSessions/> under the auth provider (auth ON + super_admin so the
 * ProtectedRoute grants access), and asserts:
 *   1. the table renders the per-user sessions with the username column,
 *   2. a row "Terminate" opens the confirm dialog (with the notify checkbox).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const adminList = vi.fn();
const adminRevoke = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: {
        me: ok({
          auth_enabled: true,
          authenticated: true,
          user: { username: 'root', role: 'super_admin' },
        }),
        logout: ok({ ok: true }),
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      admin: {
        sessions: {
          list: (u?: string) => adminList(u),
          revoke: (sid: string, notify: boolean) => adminRevoke(sid, notify),
        },
        users: { revokeAll: vi.fn().mockResolvedValue({ ok: true, revoked: 0 }) },
      },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import AdminSessions from '../pages/AdminSessions';

function renderAdmin() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <AdminSessions onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

describe('Admin Sessions console', () => {
  beforeEach(() => {
    adminList.mockReset();
    adminRevoke.mockReset();
    adminList.mockResolvedValue({
      sessions: [
        {
          sid: 'sid-a',
          username: 'alice',
          ua_browser: 'Chrome',
          ua_os: 'macOS',
          ip: '203.0.113.5',
          ip_city: 'London',
          ip_country: 'UK',
          created_at: new Date(Date.now() - 3600_000).toISOString(),
          last_active_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          sid: 'sid-b',
          username: 'bob',
          ua_browser: 'Safari',
          ua_os: 'iOS',
          ip: '198.51.100.9',
          ip_city: 'Paris',
          ip_country: 'FR',
          created_at: new Date(Date.now() - 86400_000).toISOString(),
          last_active_at: new Date(Date.now() - 7200_000).toISOString(),
        },
      ],
    });
  });

  it('renders all users’ sessions with the user column', async () => {
    renderAdmin();
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
  });

  it('opens the sign-out confirm dialog from a row, with the notify choice', async () => {
    renderAdmin();
    await screen.findByText('alice');

    // Named by the session a person recognises (device, place, owner), never its id.
    const signOut = screen.getByRole('button', { name: 'Sign out Chrome on macOS, London, UK for alice' });
    expect(screen.queryByRole('button', { name: /sid-a/ })).toBeNull();
    fireEvent.click(signOut);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Sign out this session?')).toBeInTheDocument();
    // The "notify the user" checkbox is present in the confirm.
    expect(within(dialog).getByLabelText('Notify the user')).toBeInTheDocument();
  });

  it('offers "Sign out all for" one filtered user, and keeps Refresh in the section actions', async () => {
    renderAdmin();
    await screen.findByText('alice');
    expect(screen.getByRole('heading', { name: 'Active sessions', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Administration')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('data-refresh-display', 'label');
    expect(screen.queryByRole('button', { name: /Sign out all for/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter by user'), { target: { value: 'ali' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all for alice' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Sign out all sessions for alice?')).toBeInTheDocument();
  });

  it('draws the user filter and the table on one panel, the table bleeding to its edge', async () => {
    renderAdmin();
    await screen.findByText('alice');
    const panel = document.querySelector('[data-admin-sessions-panel]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.className).toContain('surface-panel');
    // The filter is the shared FilterBar (the one filter layout), not a bespoke field.
    expect(within(panel).getByRole('group', { name: 'Session filters' })).toBeInTheDocument();
    expect(within(panel).getByLabelText('Filter by user')).toBeInTheDocument();
    const table = within(panel).getByRole('table', { name: 'All active sessions' });
    expect(table.closest('[data-surface]')).toHaveAttribute('data-surface', 'panel');
  });
});
