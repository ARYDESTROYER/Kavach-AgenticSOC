/**
 * Roles and permissions, Round 14 page grammar (SPEC §4.9.4 and §4.9.6; ui-audit SE1,
 * Y2, Y9, Y10): a plain header (title and help only) with "New custom role" and Refresh in
 * its actions, a live-condition callout only when RBAC is off, the caller's access as one
 * plain line, row actions neutral at rest (one in view, the rest in a menu, Delete last),
 * the roles table in a "Roles" group on the tinted panel (C9 option A, the access line
 * as its caption), and the permission check as a Settings group. The A8c permission
 * mirror is untouched.
 *
 * Auth is off, so the roles:manage ProtectedRoute is transparent and `useCan` allows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status?: number;
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      get: apiGetMock,
    },
  };
});

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Roles from '../pages/Roles';

const MATRIX = {
  roles: ['super_admin', 'analyst_tier1'],
  default_role: 'analyst_tier1',
  matrix: {
    super_admin: { '*': ['*'] },
    analyst_tier1: { cases: ['read'] },
    tier1_plus: { cases: ['read', 'comment'], audit: ['view'] },
  },
};

function permissions(rbac_enabled: boolean) {
  return {
    authenticated: true,
    role: 'soc_manager',
    custom_roles: ['tier1_plus'],
    rbac_enabled,
    permissions: { cases: ['read'], audit: ['view'] },
  };
}

function renderRoles() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <RouterProvider>
          <Roles />
        </RouterProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

describe('Roles page (Round 14 grammar)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it('has a plain header with its actions, the access line, and neutral row actions', async () => {
    apiGetMock.mockImplementation((path: string) =>
      Promise.resolve(path === 'roles' ? MATRIX : permissions(true)),
    );
    renderRoles();
    await screen.findByText('tier1_plus');

    expect(screen.getByRole('heading', { name: 'Roles & permissions', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Administration')).toBeNull();
    expect(screen.getByRole('button', { name: 'New custom role' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute('data-refresh-display', 'label');
    // The caller's access is one plain line, not an info callout.
    expect(screen.getByTestId('roles-capability')).toHaveTextContent(
      'with 1 custom role, holding 2 resource grants. You can create, edit and delete custom roles.',
    );
    expect(document.querySelector('[data-callout]')).toBeNull();

    // The table sits in the "Roles" group, bleeding to the edge of its panel, and the
    // access line is that group's caption.
    const group = screen.getByRole('group', { name: 'Roles' });
    expect(group).toHaveAttribute('data-settings-group');
    expect(within(group).getByTestId('roles-capability')).toBeInTheDocument();
    const table = within(group).getByRole('table', { name: 'RBAC roles' });
    expect(table.closest('[data-surface]')).toHaveAttribute('data-surface', 'panel');
    expect(table.closest('[data-settings-panel]')).not.toBeNull();
    // Declared column widths: one-line cells, and a narrow screen scrolls sideways.
    expect(table).toHaveClass('table-fixed');

    // A built-in role offers Clone only; a custom role Edit in view and Delete last in
    // the menu, every action neutral at rest.
    const builtin = screen.getByText('Analyst Tier 1').closest('tr') as HTMLElement;
    expect(within(builtin).getByRole('button', { name: 'Clone analyst_tier1' })).toBeInTheDocument();
    expect(within(builtin).queryByRole('button', { name: /More actions/ })).toBeNull();
    expect(within(builtin).getByText('Built-in')).toBeInTheDocument();

    const custom = screen.getByText('tier1_plus').closest('tr') as HTMLElement;
    const edit = within(custom).getByRole('button', { name: 'Edit tier1_plus' });
    expect(edit.className.split(/\s+/)).not.toContain('text-critical');
    fireEvent.keyDown(within(custom).getByRole('button', { name: 'More actions for tier1_plus' }), { key: 'ArrowDown' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Clone tier1_plus', 'Delete tier1_plus']);
  });

  it('shows the RBAC-disabled warning as a live-condition callout', async () => {
    apiGetMock.mockImplementation((path: string) =>
      Promise.resolve(path === 'roles' ? MATRIX : permissions(false)),
    );
    renderRoles();
    await screen.findByText('tier1_plus');
    const callout = await waitFor(() => {
      const el = document.querySelector('[data-callout="warning"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // True copy: the condition, what it means, and that there is no switch on this page.
    expect(callout).toHaveTextContent('Role-based access is off');
    expect(callout).toHaveTextContent('Every signed-in account counts as Super admin');
    expect(callout).toHaveTextContent('there is no switch for it on this page');
    expect(callout).not.toHaveTextContent(/Turn on RBAC in Security settings/);
    expect(screen.queryByTestId('roles-capability')).toBeNull();
    // Without RBAC the group caption says how custom roles start instead.
    expect(within(screen.getByRole('group', { name: 'Roles' })).getByText(
      'Built-in roles are fixed. Clone one to start a custom role.',
    )).toBeInTheDocument();
  });

  it('runs the permission check from a Settings group', async () => {
    apiGetMock.mockImplementation((path: string) =>
      Promise.resolve(path === 'roles' ? MATRIX : permissions(true)),
    );
    renderRoles();
    await screen.findByText('tier1_plus');
    expect(screen.getByRole('heading', { name: 'Permission check', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role to simulate' })).toHaveTextContent('Choose a role');
    // The Check button keeps its own width beside the three selects from 640px.
    const check = screen.getByRole('button', { name: 'Check' });
    expect(check.className).toContain('sm:w-auto');
  });
});
