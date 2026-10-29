/**
 * Sessions page — render + revoke-confirm test.
 *
 * Mocks GET /api/sessions (two sessions incl. the current one) + GET
 * /api/account/activity, mounts <Sessions/> inside the auth + tooltip providers
 * (auth ON so the page is live), and asserts:
 *   1. the session table renders both devices, with "This device" on the current one,
 *   2. clicking a row's Revoke opens the AlertDialog confirm.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const sessionsList = vi.fn();
const activity = vi.fn();
const revoke = vi.fn();
const revokeOthers = vi.fn();

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
          user: { username: 'alice', role: 'super_admin' },
        }),
        logout: ok({ ok: true }),
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      sessions: {
        list: () => sessionsList(),
        revoke: (sid: string) => revoke(sid),
        revokeOthers: () => revokeOthers(),
      },
      account_activity: () => activity(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Sessions, { sessionActionLabel } from '../pages/Sessions';

function renderSessions() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <Sessions onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

describe('Sessions page', () => {
  beforeEach(() => {
    sessionsList.mockReset();
    activity.mockReset();
    revoke.mockReset();
    revokeOthers.mockReset();
    activity.mockResolvedValue({ events: [] });
    sessionsList.mockResolvedValue({
      sessions: [
        {
          sid: 'sid-current',
          current: true,
          ua_browser: 'Chrome',
          ua_os: 'macOS',
          ip: '203.0.113.5',
          ip_city: 'London',
          ip_country: 'UK',
          created_at: new Date(Date.now() - 3600_000).toISOString(),
          last_active_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          sid: 'sid-other',
          current: false,
          ua_browser: 'Firefox',
          ua_os: 'Windows',
          ip: '198.51.100.9',
          ip_city: 'Berlin',
          ip_country: 'DE',
          created_at: new Date(Date.now() - 86400_000).toISOString(),
          last_active_at: new Date(Date.now() - 7200_000).toISOString(),
        },
      ],
    });
  });

  it('renders both sessions and badges the current device', async () => {
    renderSessions();

    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Firefox on Windows')).toBeInTheDocument();
    // The current session is badged "This device".
    expect(screen.getByText('This device')).toBeInTheDocument();
    // Locations render as plain text.
    expect(screen.getByText('London, UK')).toBeInTheDocument();
    expect(screen.getByText('Berlin, DE')).toBeInTheDocument();
  });

  it('opens the sign-out confirm dialog from a row\'s neutral Sign out action', async () => {
    renderSessions();

    await screen.findByText('Firefox on Windows');
    // Sign out the non-current session. The row action is neutral at rest (Round 14,
    // ui-audit SE9); the red button lives in the confirm dialog.
    const signOut = screen.getByRole('button', { name: /^Sign out Firefox on Windows/ });
    expect(signOut.className).toContain('text-muted-foreground');
    expect(signOut.className).not.toMatch(/(^|\s)text-critical(\s|$)/);
    fireEvent.click(signOut);

    // The AlertDialog confirm appears.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Sign out this session?')).toBeInTheDocument();

    // Confirming calls the revoke API with the right sid.
    const confirm = within(dialog).getByRole('button', { name: /^Sign out$/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('sid-other'));
  });

  it('renders as one Settings section with underline tabs and Refresh in the section actions', async () => {
    renderSessions();
    await screen.findByText('Firefox on Windows');
    expect(screen.getByRole('heading', { name: 'Sessions & activity', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Account', { selector: 'p' })).toBeNull();
    const tabs = screen.getByRole('tablist', { name: 'Sessions and activity' });
    expect(tabs).toHaveAttribute('data-variant', 'underline');
    const actions = document.querySelector('[data-sessions-actions]') as HTMLElement;
    expect(within(actions).getByRole('button', { name: 'Refresh' })).toHaveAttribute('data-refresh-display', 'label');
    // Each tab's table sits on the tinted panel and bleeds to its edge (C9 option A).
    const panel = document.querySelector('[data-sessions-panel="sessions"]') as HTMLElement;
    expect(panel.className).toContain('surface-panel');
    const table = within(panel).getByRole('table', { name: 'Your sessions' });
    expect(table.closest('[data-surface]')).toHaveAttribute('data-surface', 'panel');
  });
});

describe('sessionActionLabel', () => {
  it('names the session a person recognises, never the internal id', () => {
    const base = { ua_browser: 'Firefox', ua_os: 'Windows', ua_raw: '', current: false, username: 'alice' };
    expect(sessionActionLabel('Sign out', base)).toBe('Sign out Firefox on Windows');
    expect(sessionActionLabel('Sign out', { ...base, ip_city: 'Paris', ip_country: 'FR' })).toBe(
      'Sign out Firefox on Windows, Paris, FR',
    );
    expect(sessionActionLabel('Sign out', { ...base, current: true })).toBe('Sign out Firefox on Windows (this device)');
    // The owner only where the table shows owners (the admin console).
    expect(sessionActionLabel('Sign out', base, true)).toBe('Sign out Firefox on Windows for alice');
  });
});
