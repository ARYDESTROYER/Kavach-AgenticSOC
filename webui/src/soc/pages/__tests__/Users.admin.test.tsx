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
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

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

// The path is resolved from this file, so it names the module Users imports (`../Roles.api`).
vi.mock('../Roles.api', async (importOriginal) => {
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

/** Open a row's "More actions" menu (Radix opens it on ArrowDown) and pick an item. */
function rowMenuItem(username: string, item: string): HTMLElement {
  fireEvent.keyDown(screen.getByRole('button', { name: `More actions for ${username}` }), { key: 'ArrowDown' });
  return within(screen.getByRole('menu')).getByRole('menuitem', { name: item });
}

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

    // A stable name: the switch role carries on or off, the name never contradicts it.
    fireEvent.click(screen.getByRole('switch', { name: 'Account active: alice' }));

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

    // Open the "Change roles" dialog for alice from the row menu (Round 14: the role is
    // text in the row and changes here, with the custom roles).
    fireEvent.click(rowMenuItem('alice', 'Change roles'));

    // The chip set is a labelled group (not a dangling <label>).
    const group = await screen.findByRole('group', { name: /custom roles/i });
    expect(group).toBeInTheDocument();
  });

  it('keeps the assign-role Select controlled while the dialog opens (#42)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      renderUsers();
      await screen.findByText('alice');

      fireEvent.click(rowMenuItem('alice', 'Change roles'));

      const baseRole = await screen.findByRole('combobox', { name: /base role/i });
      await waitFor(() => expect(baseRole).toHaveTextContent('Analyst Tier 1'));

      const emitted = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(emitted).not.toContain('uncontrolled to controlled');
      expect(emitted).not.toContain('controlled to uncontrolled');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('changes the base role through Change roles and sends only that change', async () => {
    assignRolesMock.mockResolvedValue({ ok: true });
    renderUsers();
    await screen.findByText('alice');
    fireEvent.click(rowMenuItem('alice', 'Change roles'));
    const baseRole = await screen.findByRole('combobox', { name: /base role/i });
    await waitFor(() => expect(baseRole).toHaveTextContent('Analyst Tier 1'));
    fireEvent.keyDown(baseRole, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: 'Responder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
    await waitFor(() =>
      expect(assignRolesMock).toHaveBeenCalledWith('alice', { role: 'responder', custom_roles: [] }),
    );
  });

  it('drops a custom role deleted since it was assigned, so a role change is not refused', async () => {
    // alice still holds "gone", which no longer exists in the resolved matrix; the server
    // answers 400 "unknown custom role" for it, so it must never be sent back.
    usersListMock.mockResolvedValue({
      users: [{ ...USERS[0], prefs: { custom_roles: ['tier1_plus', 'gone'] } }, USERS[1]],
    });
    assignRolesMock.mockResolvedValue({ ok: true });
    renderUsers();
    await screen.findByText('alice');
    // The Role cell counts only roles that still exist.
    const row = screen.getByText('alice').closest('tr') as HTMLElement;
    expect(within(row).getByText('+ 1 custom')).toBeInTheDocument();

    fireEvent.click(rowMenuItem('alice', 'Change roles'));
    const dialog = await screen.findByRole('dialog');
    // The live role starts selected; the deleted one is named, with what saving does.
    expect(within(dialog).getByRole('button', { name: 'tier1_plus' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).queryByRole('button', { name: 'gone' })).toBeNull();
    expect(within(dialog).getByTestId('assign-roles-stale')).toHaveTextContent(
      'Deleted role gone grants nothing now. Saving removes it from this account.',
    );
    const baseRole = within(dialog).getByRole('combobox', { name: /base role/i });
    fireEvent.keyDown(baseRole, { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Responder' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save roles' }));
    await waitFor(() =>
      expect(assignRolesMock).toHaveBeenCalledWith('alice', { role: 'responder', custom_roles: ['tier1_plus'] }),
    );
  });

  it('shows the role as text and keeps every row action neutral, Delete last in the menu', async () => {
    renderUsers();
    await screen.findByText('alice');
    // No inline role select in the table (ui-audit SE10).
    expect(screen.queryByRole('combobox', { name: /role for alice/i })).toBeNull();
    expect(screen.getAllByText('Analyst Tier 1').length).toBeGreaterThan(0);
    // One action in view (Edit), the rest in the row menu, Delete last after a separator.
    const edit = screen.getByRole('button', { name: 'Edit alice' });
    expect(edit.className).not.toMatch(/(^|\s)text-critical(\s|$)/);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for alice' }), { key: 'ArrowDown' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items[0]).toBe('Change roles');
    expect(items).toContain('Reset password');
    expect(items[items.length - 1]).toBe('Delete user');
  });

  it('puts the accounts table in one Accounts group, bleeding to its panel (Round 14, C9 option A)', async () => {
    renderUsers();
    await screen.findByText('alice');
    const group = screen.getByRole('group', { name: 'Accounts' });
    expect(group).toHaveAttribute('data-settings-group');
    // The caption counts the accounts once they have loaded.
    await waitFor(() => expect(group).toHaveTextContent(/\d+ accounts?\. A turned-off account cannot sign in\./));
    const table = within(group).getByRole('table', { name: 'User accounts' });
    expect(table.closest('[data-surface]')).toHaveAttribute('data-surface', 'panel');
    expect(table.closest('[data-settings-panel]')).not.toBeNull();
  });

  it('confirms Delete in a dialog before calling the API', async () => {
    usersRemoveMock.mockResolvedValue({ ok: true });
    renderUsers();
    await screen.findByText('bob');
    fireEvent.click(rowMenuItem('bob', 'Delete user'));
    expect(usersRemoveMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(usersRemoveMock).toHaveBeenCalledWith('bob'));
  });
});
