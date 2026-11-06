/**
 * CaseDetail offers only what the viewer's role may do, and never sends a read the role
 * cannot make (Round 14 second acceptance pass, roles-02 and roles-07):
 *
 * - Reinvestigate (the Take action item and its R shortcut) needs `cases:reinvestigate`,
 *   which tier 1, the responder and the auditor do not hold by default; without it the
 *   model list behind the Reinvestigate dialog is not read either.
 * - The owner picker and @mention suggestions read GET /api/users, which needs
 *   `users:manage`; without it that read is never sent (each refusal would write an
 *   Access denied audit row), and the owner field takes a typed name.
 * - A refused reinvestigation (the grant removed after the case opened) is worded, never
 *   the server's raw "permission denied: cases:reinvestigate".
 * - A role that may change nothing about the case (the auditor) gets no "Case actions"
 *   group label and separator with nothing under them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const CASE = {
  case_id: 'c-perm-1',
  case_number: 'CASE-2026-0039',
  title: 'Password spray against many accounts',
  status: 'open',
  verdict: 'NEEDS_HUMAN',
  risk_score: 55,
  severity_band: 'high',
  updated_at: '2026-11-01T10:00:00Z',
  created_at: '2026-11-01T09:00:00Z',
  history: [],
};

const grants = vi.hoisted(() => ({ current: new Set<string>() }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), message: vi.fn() }));

vi.mock('sonner', () => ({ toast: toasts }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
      this.name = 'ApiError';
    }
  }
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CASE)),
    getModels: vi.fn(() => Promise.resolve({ providers: { anthropic: ['claude-sonnet'] } })),
    getSettings: vi.fn(() => Promise.resolve({ prefs: {}, configured: {}, read_only: false })),
    users: { list: vi.fn(() => Promise.resolve({ users: [{ username: 'lee', role: 'analyst_tier1' }] })) },
    reinvestigateCase: vi.fn(() => Promise.resolve(CASE)),
  };
  return {
    ApiError,
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => {
  const has = (resource: string, action: string) => grants.current.has(`${resource}:${action}`);
  return {
    useAuth: () => ({
      username: 'probe',
      role: 'analyst_tier1',
      authEnabled: true,
      rbacEnabled: true,
      hasPermission: has,
      user: null,
    }),
    useOptionalAuth: () => ({ hasPermission: has }),
  };
});

import { api, ApiError } from '@/lib/api';
import { CaseDetail, reinvestigateErrorText } from '@/soc/pages/CaseDetail';

const TIER1 = ['cases:read', 'cases:write', 'cases:comment', 'cases:assign', 'runbooks:read', 'runbooks:run'];
const TIER2 = [...TIER1, 'cases:close', 'cases:reinvestigate'];

async function renderCase() {
  render(<CaseDetail caseId={CASE.case_id} presentation="embedded" onClose={() => undefined} />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Password spray/));
}

async function openTakeAction() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Take action' }));
  return { user, menu: await screen.findByRole('menu') };
}

beforeEach(() => {
  vi.mocked(api.users.list).mockClear();
  vi.mocked(api.getModels).mockClear();
  vi.mocked(api.reinvestigateCase).mockClear();
  toasts.error.mockClear();
});

describe('CaseDetail role gates', () => {
  it('offers tier 1 no Reinvestigate, ignores R, and reads neither users nor models', async () => {
    grants.current = new Set(TIER1);
    await renderCase();
    const { menu } = await openTakeAction();
    expect(within(menu).queryByRole('menuitem', { name: 'Reinvestigate' })).not.toBeInTheDocument();
    // The rest of the Investigation group stays.
    expect(within(menu).getByRole('menuitem', { name: 'Refresh case' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    fireEvent.keyDown(document.body, { key: 'r' });
    expect(screen.queryByRole('dialog', { name: 'Re-run the investigation' })).not.toBeInTheDocument();
    // GET /api/users (users:manage) and the reinvestigate model list are never asked for.
    expect(api.users.list).not.toHaveBeenCalled();
    expect(api.getModels).not.toHaveBeenCalled();
  });

  it('gives a read-only role no empty "Case actions" group', async () => {
    grants.current = new Set(['cases:read', 'runbooks:read']);
    await renderCase();
    const { menu } = await openTakeAction();
    expect(within(menu).queryByText('Case actions')).not.toBeInTheDocument();
    // The Investigation group is what the role may use, and it leads the menu: no label
    // or separator sits above it.
    expect(menu.firstElementChild).toHaveTextContent('Investigation');
    expect(menu.firstElementChild).not.toHaveAttribute('role', 'separator');
    expect(within(menu).getByRole('menuitem', { name: 'Refresh case' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Reinvestigate' })).not.toBeInTheDocument();
  });

  it('keeps the "Case actions" group for a role that may act on the case', async () => {
    grants.current = new Set(TIER1);
    await renderCase();
    const { menu } = await openTakeAction();
    expect(within(menu).getByText('Case actions')).toBeInTheDocument();
    expect(within(menu).getAllByRole('separator').length).toBeGreaterThan(0);
  });

  it('offers tier 2 Reinvestigate and its R shortcut, and still sends no users read', async () => {
    grants.current = new Set(TIER2);
    await renderCase();
    const { user, menu } = await openTakeAction();
    expect(within(menu).getByRole('menuitem', { name: 'Reinvestigate' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(await screen.findByRole('dialog', { name: 'Re-run the investigation' })).toBeInTheDocument();
    await waitFor(() => expect(api.getModels).toHaveBeenCalled());
    expect(api.users.list).not.toHaveBeenCalled();
  });

  it('reads the user list for the owner picker only with users:manage', async () => {
    grants.current = new Set([...TIER2, 'users:manage']);
    await renderCase();
    await waitFor(() => expect(api.users.list).toHaveBeenCalledTimes(1));
  });

  it('words a refused reinvestigation instead of showing the raw server text', async () => {
    grants.current = new Set(TIER2);
    vi.mocked(api.reinvestigateCase).mockRejectedValueOnce(
      new ApiError(403, 'permission denied: cases:reinvestigate'),
    );
    await renderCase();
    const { user, menu } = await openTakeAction();
    await user.click(within(menu).getByRole('menuitem', { name: 'Reinvestigate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Re-run the investigation' });
    await user.click(within(dialog).getByRole('button', { name: 'Reinvestigate' }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('You do not have permission to reinvestigate cases.'),
    );
    expect(toasts.error).not.toHaveBeenCalledWith(expect.stringContaining('permission denied'));
  });
});

describe('reinvestigateErrorText', () => {
  it('words a 403 and keeps any other failure message', () => {
    expect(reinvestigateErrorText(new ApiError(403, 'permission denied: cases:reinvestigate'))).toBe(
      'You do not have permission to reinvestigate cases.',
    );
    expect(reinvestigateErrorText(new ApiError(409, 'The case is closed.'))).toBe('The case is closed.');
    expect(reinvestigateErrorText(new Error(''))).toBe('The reinvestigation could not be started.');
    expect(reinvestigateErrorText('nope')).toBe('The reinvestigation could not be started.');
  });
});
