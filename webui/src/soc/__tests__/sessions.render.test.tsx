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
import Sessions, { activityRows, activitySentence, sessionActionLabel } from '../pages/Sessions';

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
    activity.mockResolvedValue({ activity: [] });
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

describe('Sessions activity rows', () => {
  const record = {
    id: 'a-1',
    ts: new Date(Date.now() - 120_000).toISOString(),
    action: 'auth.login',
    action_type: 'AUTH_EVENT',
    result_summary: 'Signed in with a password',
    client: { ip: '203.0.113.5', user_agent: 'Mozilla/5.0' },
  };

  it('maps the audit records the server sends under activity', () => {
    const [row] = activityRows({ activity: [record] });
    expect(row.action).toBe('auth.login');
    expect(row.detail).toBe('Signed in with a password');
    expect(row.ip).toBe('203.0.113.5');
    // The event name falls back to the action type; nothing at all is an empty list.
    expect(activityRows({ activity: [{ action_type: 'AUTH_EVENT' }] })[0].action).toBe('AUTH_EVENT');
    expect(activityRows({})).toEqual([]);
    expect(activityRows(null)).toEqual([]);
  });

  it('shows the signed-in person\'s activity on the Activity tab', async () => {
    activity.mockResolvedValue({ activity: [record] });
    sessionsList.mockResolvedValue({ sessions: [] });
    renderSessions();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('You signed in.')).toBeInTheDocument();
    expect(screen.queryByText('No recent activity.')).not.toBeInTheDocument();
  });

  it('shows a plain sentence per known event and never the raw audit detail', async () => {
    // The audit rows' own summaries are internal records: an event this list knows reads
    // as a sentence, and one it does not know shows its name alone.
    activity.mockResolvedValue({
      activity: [
        { ...record, id: 'a-1', event_label: 'Signed in', result_summary: 'login ok' },
        {
          ...record,
          id: 'a-2',
          action: 'session.created',
          event_label: 'Session started',
          result_summary: 'session_create sid=3970e7b9… new session (unknown /)',
        },
        { ...record, id: 'a-3', action: 'session.refreshed', event_label: 'Session renewed', result_summary: 'refresh_rotate sid=1a2b3c4d… rotated from 5e6f7a8b' },
        { ...record, id: 'a-4', action: 'case.closed', event_label: 'Case closed', result_summary: 'closed demo-0001 as fp' },
      ],
    });
    sessionsList.mockResolvedValue({ sessions: [] });
    renderSessions();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    const table = await screen.findByRole('table', { name: 'Recent account activity' });
    expect(within(table).getByText('You signed in.')).toBeInTheDocument();
    expect(within(table).getByText('A new session started.')).toBeInTheDocument();
    expect(within(table).getByText('A session was renewed.')).toBeInTheDocument();
    expect(within(table).getByText('Case closed')).toBeInTheDocument();
    const text = table.textContent ?? '';
    for (const raw of ['login ok', 'session_create', 'sid=', 'refresh_rotate', 'closed demo-0001 as fp']) {
      expect(text).not.toContain(raw);
    }
    expect(activitySentence('session.revoked')).toBe('A session was signed out.');
    expect(activitySentence('case.closed')).toBeNull();
    expect(activitySentence('toString')).toBeNull();
    expect(activitySentence(undefined)).toBeNull();
  });

  it('fits a phone panel without scrolling sideways, so it needs no focusable scroller', async () => {
    // At 390 by 844 the Settings panel gives the table 358 px. The list holds nothing a
    // keyboard can focus, so a table wider than that is a scroll region no keyboard can
    // reach (axe scrollable-region-focusable, serious) and it cuts off the When column.
    // A fixed layout truncates or wraps text instead of widening the table, and its
    // planned minimum width stays inside the panel.
    activity.mockResolvedValue({
      activity: [
        { ...record, id: 'a-1', action: 'user.preferences_updated', event_label: 'Personal preferences changed' },
        { ...record, id: 'a-2', ts: new Date(Date.now() - 300 * 86_400_000).toISOString() },
      ],
    });
    sessionsList.mockResolvedValue({ sessions: [] });
    renderSessions();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    const table = await screen.findByRole('table', { name: 'Recent account activity' });
    expect(table).toHaveClass('table-fixed');
    const min = table.style.minWidth;
    const rem = /^calc\((.+)\)$/.exec(min)?.[1] ?? min;
    // Each term is `<n>rem` or `<k> * <n>rem` (DataTable's planned minimum).
    const px = rem.split('+').reduce((sum, term) => {
      const m = /^\s*(?:(\d+)\s*\*\s*)?([\d.]+)rem\s*$/.exec(term);
      if (!m) throw new Error(`Unexpected minimum width term "${term}" in "${min}".`);
      return sum + Number(m[1] ?? 1) * Number(m[2]) * 16;
    }, 0);
    expect(px).toBeGreaterThan(0);
    expect(px).toBeLessThanOrEqual(358);
    // The sentence wraps on a narrow screen instead of being cut short.
    const sentence = within(table).getByText('Your personal preferences changed.');
    expect(sentence).not.toHaveClass('truncate');
    expect(within(table).getByText('10mo ago')).toBeInTheDocument();
  });

  it('names each event the way the Audit log does, never the raw event id', async () => {
    activity.mockResolvedValue({ activity: [{ ...record, event_label: 'Signed in' }] });
    sessionsList.mockResolvedValue({ sessions: [] });
    renderSessions();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByText('Auth.login')).not.toBeInTheDocument();
    expect(activityRows({ activity: [{ ...record, event_label: 'Signed in' }] })[0].event_label).toBe(
      'Signed in',
    );
  });

  it('says the activity could not be loaded when the read fails, never "No recent activity."', async () => {
    // The server answers 503 audit_unavailable instead of an empty list, so an empty
    // table here would claim something the server never said.
    activity.mockRejectedValue(new Error('The audit log cannot be read right now.'));
    sessionsList.mockResolvedValue({ sessions: [] });
    renderSessions();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('Activity could not be loaded. Use Refresh to try again.')).toBeInTheDocument();
    expect(screen.queryByText('No recent activity.')).not.toBeInTheDocument();
  });
});
