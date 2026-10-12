/**
 * Users & roles admin page (Round 6 admin-misc, findings #28 / #41).
 *
 * #28: inline mutations (role/active/delete) called `load()`, which set `loading=true`
 *      and flashed the WHOLE table to skeleton rows for a single-row change. FIX: those
 *      reload in the BACKGROUND (no `loading` flip), so the rows stay on screen.
 * #41: the "Custom roles" chip group used a bare <Label> associated with nothing. FIX:
 *      a labelled `role="group"` so the toggle-chip set has an accessible name.
 * #42: the base-role Select mounted uncontrolled, then became controlled when the
 *      selected user was copied into dialog state. FIX: keep it controlled from its
 *      first render so Radix never observes a mode change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { usersListMock, usersUpdateMock, usersRemoveMock, rolesGetMock, assignRolesMock } =
  vi.hoisted(() => ({
    usersListMock: vi.fn(),
    usersUpdateMock: vi.fn(),
    usersRemoveMock: vi.fn(),
    rolesGetMock: vi.fn(),
    assignRolesMock: vi.fn(),
  }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      users: {
        list: usersListMock,
        update: usersUpdateMock,
        remove: usersRemoveMock,
        create: vi.fn(),
      },
      roles: { get: rolesGetMock },
    },
  };
});

vi.mock('./Roles.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Roles.api')>();
  return { ...actual, rolesApi: { ...actual.rolesApi, assignUserRoles: assignRolesMock } };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'admin',
    authEnabled: true,
    hasPermission: () => true,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Users from '../Users';
import type { User } from '@/lib/types';

const USERS = [
  {
    username: 'alice',
    role: 'analyst_tier1',
    active: true,
    created_at: '2026-06-01T00:00:00Z',
    last_login_at: null,
    must_change_password: false,
  },
  {
    username: 'bob',
    role: 'responder',
    active: true,
    created_at: '2026-06-01T00:00:00Z',
    last_login_at: null,
    must_change_password: false,
  },
] as unknown as User[];

function renderUsers() {
  return render(
    <TooltipProvider>
      <Users />
    </TooltipProvider>,
  );
}

describe('Users admin page', () => {
  beforeEach(() => {
    usersListMock.mockReset();
    usersUpdateMock.mockReset();
    usersRemoveMock.mockReset();
    rolesGetMock.mockReset();
    assignRolesMock.mockReset();
    usersListMock.mockResolvedValue({ users: USERS });
    // A custom role ("tier1_plus") + a built-in in the resolved matrix.
    rolesGetMock.mockResolvedValue({
      roles: ['super_admin', 'analyst_tier1', 'responder'],
      matrix: { analyst_tier1: {}, tier1_plus: {} },
    });
    usersUpdateMock.mockResolvedValue({ ok: true });
  });

  it('keeps the table populated during an inline toggle reload (#28 — no skeleton flash)', async () => {
    renderUsers();
    await screen.findByText('alice');
    expect(screen.getByText('bob')).toBeInTheDocument();

    // The background reload after the mutation never resolves → if `load` set
    // `loading=true` the rows would be torn down to skeletons. They must NOT be.
    usersListMock.mockImplementationOnce(() => new Promise(() => {}));

    fireEvent.click(screen.getByRole('switch', { name: /disable alice/i }));

    await waitFor(() =>
      expect(usersUpdateMock).toHaveBeenCalledWith('alice', { active: false }),
    );
    // Both rows are STILL on screen (background reload; no full-table skeleton).
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('gives the custom-roles chip group an accessible name (#41)', async () => {
    renderUsers();
    await screen.findByText('alice');

    // Open the "Manage roles" dialog for alice (present because a custom role exists).
    fireEvent.click(screen.getByRole('button', { name: /manage roles for alice/i }));

    // The chip set is a labelled group (not a dangling <label>).
    const group = await screen.findByRole('group', { name: /custom roles/i });
    expect(group).toBeInTheDocument();
  });

  it('keeps the assign-role Select controlled while the dialog opens (#42)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      renderUsers();
      await screen.findByText('alice');

      fireEvent.click(screen.getByRole('button', { name: /manage roles for alice/i }));

      const baseRole = await screen.findByRole('combobox', { name: /base role/i });
      await waitFor(() => expect(baseRole).toHaveTextContent('Analyst Tier 1'));

      const emitted = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(emitted).not.toContain('uncontrolled to controlled');
      expect(emitted).not.toContain('controlled to uncontrolled');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
