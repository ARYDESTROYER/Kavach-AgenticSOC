/**
 * Round 12 — Account → Sessions shows Remember me (SPEC D14, SYNTHESIS-ux §4 item 9).
 *
 *  - A remembered session carries a compact plain-text "Remembered" badge (its end
 *    time in the tooltip), so the table keeps its actions in view.
 *  - Every live row shows when the server ends it ("Expires", one line); no claim
 *    about the browser closing (untrue for API and older sessions); a revoked row
 *    shows a dash.
 *  - "Forget this device" appears only when this browser keeps a remembered
 *    username, clears it, and does not sign anyone out; the header actions wrap so
 *    none is pushed off a phone screen.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const { sessionsList, logout, toastSuccess } = vi.hoisted(() => ({
  sessionsList: vi.fn(),
  logout: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status = 0;
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
        logout: () => logout(),
      },
      roles: { get: ok({ roles: [], rbac_enabled: false, matrix: {} }) },
      sessions: { list: () => sessionsList(), revoke: vi.fn(), revokeOthers: vi.fn() },
      account_activity: ok({ events: [] }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() }),
}));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Sessions, { sessionUntilLabel } from '../pages/Sessions';
import {
  REMEMBER_ACK_KEY,
  REMEMBERED_USERNAME_KEY,
} from '@/soc/components/auth/rememberMe';

const IN_20H = new Date(Date.now() + 20 * 3_600_000).toISOString();
const IN_11H = new Date(Date.now() + 11 * 3_600_000).toISOString();

function renderSessions() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <Sessions onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  sessionsList.mockReset();
  logout.mockReset();
  toastSuccess.mockReset();
  sessionsList.mockResolvedValue({
    sessions: [
      {
        sid: 'sid-remembered',
        current: true,
        ua_browser: 'Chrome',
        ua_os: 'macOS',
        created_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
        last_active_at: new Date().toISOString(),
        remember: true,
        remember_seconds: 86_400,
        expires_at: IN_20H,
      },
      {
        sid: 'sid-browser',
        current: false,
        ua_browser: 'Firefox',
        ua_os: 'Windows',
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
        last_active_at: new Date().toISOString(),
        remember: false,
        expires_at: IN_11H,
      },
      {
        sid: 'sid-revoked',
        current: false,
        revoked: true,
        ua_browser: 'Safari',
        ua_os: 'iOS',
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
        remember: true,
        expires_at: IN_20H,
      },
    ],
  });
});

function rowFor(device: string): HTMLElement {
  const cell = screen.getByText(device);
  const row = cell.closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('Sessions — Remember me', () => {
  it('badges remembered sessions and shows when each one expires', async () => {
    renderSessions();
    await screen.findByText('Chrome on macOS');
    expect(screen.getByRole('columnheader', { name: 'Expires' })).toBeInTheDocument();

    const remembered = rowFor('Chrome on macOS');
    const badge = remembered.querySelector('[data-session-remembered]');
    expect(badge).toHaveTextContent(/^Remembered$/);
    expect(badge).toHaveAttribute('title', `Remembered until ${sessionUntilLabel(IN_20H)}`);
    const expires = within(remembered).getByText('in 20h');
    expect(expires).toHaveClass('whitespace-nowrap');

    const browser = rowFor('Firefox on Windows');
    expect(browser.querySelector('[data-session-remembered]')).toBeNull();
    expect(within(browser).getByText('in 11h')).toBeInTheDocument();
    expect(screen.queryByText(/when the browser closes/)).toBeNull();

    // The table is a size container: in a narrow table the row action keeps only its
    // icon (named by aria-label and the tooltip), so no column is pushed out of view.
    expect(document.querySelector('[data-sessions-table]')).toHaveClass('@container/sessions');
    const action = within(browser).getByRole('button', { name: /^Sign out Firefox on Windows/ });
    expect(action).toHaveAttribute('title', 'Sign out');
    expect(action.querySelector('[data-session-action-label]')).toHaveClass(
      'hidden',
      '@[52rem]/sessions:inline',
    );

    const revoked = rowFor('Safari on iOS');
    expect(revoked.querySelector('[data-session-remembered]')).toBeNull();
    expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
  });

  it('shows a session that already ended as ended, never as a live remembered device', async () => {
    const ago1h = new Date(Date.now() - 3_600_000).toISOString();
    const in10h = new Date(Date.now() + 10 * 3_600_000).toISOString();
    sessionsList.mockResolvedValue({
      sessions: [
        {
          sid: 'sid-current',
          current: true,
          ua_browser: 'Chrome',
          ua_os: 'macOS',
          created_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
          last_active_at: new Date().toISOString(),
          remember: true,
          remember_seconds: 86_400,
          active: true,
          ended_reason: '',
          // Inactivity (12 h) ends it before the hard limit (20 h) unless it is used.
          expires_at: IN_11H,
          effective_idle_expires_at: IN_11H,
          effective_absolute_expires_at: IN_20H,
        },
        {
          // Another device, unused for 13 h: the server already signs it out. Even
          // if a listing still said remember: true, it must not read as signed in.
          sid: 'sid-idle',
          current: false,
          ua_browser: 'Edge',
          ua_os: 'Windows',
          created_at: new Date(Date.now() - 14 * 3_600_000).toISOString(),
          last_active_at: new Date(Date.now() - 13 * 3_600_000).toISOString(),
          remember: true,
          remember_seconds: 86_400,
          active: false,
          ended_reason: 'idle_expired',
          expires_at: ago1h,
          effective_idle_expires_at: ago1h,
          effective_absolute_expires_at: in10h,
        },
        {
          sid: 'sid-old',
          current: false,
          ua_browser: 'Firefox',
          ua_os: 'Linux',
          created_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
          last_active_at: new Date(Date.now() - 3_600_000).toISOString(),
          remember: false,
          active: false,
          ended_reason: 'absolute_expired',
          expires_at: ago1h,
        },
      ],
    });
    renderSessions();
    await screen.findByText('Chrome on macOS');

    const idle = rowFor('Edge on Windows');
    expect(idle.querySelector('[data-session-remembered]')).toBeNull();
    expect(idle.querySelector('[data-session-expires]')).toBeNull();
    const ended = within(idle).getByText('Ended (inactive)');
    expect(ended).toHaveAttribute('data-session-ended');
    expect(ended.getAttribute('title')).toMatch(/^Ended /);
    expect(within(idle).queryByText('in 10h')).toBeNull();
    // It can still be revoked, so a later, looser policy can never bring it back.
    expect(within(idle).getByRole('button', { name: /^Sign out Edge on Windows/ })).toBeEnabled();

    expect(within(rowFor('Firefox on Linux')).getByText('Ended (time limit)')).toBeInTheDocument();

    // The live remembered device: the earlier end time, with the latest in the tooltip.
    const current = rowFor('Chrome on macOS');
    const expires = within(current).getByText('in 11h');
    expect(expires).toHaveAttribute('data-session-expires');
    expect(expires.getAttribute('title')).toMatch(/if it isn't used again, .* at the latest$/);
    expect(current.querySelector('[data-session-remembered]')).toHaveAttribute(
      'title',
      `Remembered until ${sessionUntilLabel(IN_11H)} if it isn't used again, ${sessionUntilLabel(
        IN_20H,
      )} at the latest`,
    );
  });

  it('offers "Forget this device" only when this browser remembers a username', async () => {
    renderSessions();
    await screen.findByText('Chrome on macOS');
    expect(screen.queryByRole('button', { name: 'Forget this device' })).toBeNull();
  });

  it('forgets this device without signing anyone out', async () => {
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    window.localStorage.setItem(REMEMBER_ACK_KEY, '1');
    renderSessions();
    await screen.findByText('Chrome on macOS');
    fireEvent.click(screen.getByRole('button', { name: 'Forget this device' }));
    expect(window.localStorage.getItem(REMEMBERED_USERNAME_KEY)).toBeNull();
    expect(window.localStorage.getItem(REMEMBER_ACK_KEY)).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith("This device won't remember your username anymore.");
    expect(screen.queryByRole('button', { name: 'Forget this device' })).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it('lets the header actions wrap instead of overflowing a narrow screen', async () => {
    window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
    renderSessions();
    await screen.findByText('Chrome on macOS');
    const actions = document.querySelector('[data-sessions-actions]');
    expect(actions).toHaveClass('flex-wrap');
    expect(within(actions as HTMLElement).getByRole('button', { name: 'Forget this device' }))
      .toBeInTheDocument();
    expect(
      within(actions as HTMLElement).getByRole('button', { name: 'Sign out all other sessions' }),
    ).toBeInTheDocument();
  });
});
