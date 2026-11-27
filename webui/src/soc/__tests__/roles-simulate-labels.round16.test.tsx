/**
 * B57 (Round 16 SPEC §4.5 WP15E): the Permission check names a resource by its display
 * name in the Resource select and in its answer ("Knowledge corpus", never "Rag" or the
 * raw `rag` token). The wire id stays the value sent to `GET /api/roles/simulate`.
 *
 * Auth is off, so the roles:manage ProtectedRoute is transparent and `useCan` allows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  matrix: { super_admin: { '*': ['*'] }, analyst_tier1: { rag: ['read'] } },
};

const RBAC = {
  enabled: true,
  auth_enabled: true,
  can_change: false,
  blockers: ['not_super_admin'],
  caller_role: 'soc_manager',
  super_admin_count: 1,
  role_counts: null,
};

const PERMISSIONS = {
  authenticated: true,
  role: 'soc_manager',
  custom_roles: [],
  rbac_enabled: true,
  permissions: { roles: ['read'] },
};

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation((path: string) => {
    if (path === 'roles') return Promise.resolve(MATRIX);
    if (path === 'rbac') return Promise.resolve(RBAC);
    if (path.startsWith('roles/simulate')) {
      return Promise.resolve({
        role: 'analyst_tier1',
        resource: 'rag',
        action: 'read',
        allowed: true,
        actions: ['read'],
        known_resource: true,
        role_exists: true,
      });
    }
    return Promise.resolve(PERMISSIONS);
  });
});

describe('B57: the Permission check names resources', () => {
  it('lists and answers with the display name, never the raw token', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AuthProvider>
          <RouterProvider>
            <Roles />
          </RouterProvider>
        </AuthProvider>
      </TooltipProvider>,
    );
    await user.click(await screen.findByRole('combobox', { name: 'Role to simulate' }));
    await user.click(await screen.findByRole('option', { name: 'Analyst Tier 1' }));

    await user.click(screen.getByRole('combobox', { name: 'Resource' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Knowledge corpus' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'In-app notifications' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /^(Rag|Inapp)$/ })).toBeNull();
    await user.click(within(listbox).getByRole('option', { name: 'Knowledge corpus' }));

    await user.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Allowed')).toBeInTheDocument();
    // The wire id is still what is checked.
    expect(apiGetMock).toHaveBeenCalledWith('roles/simulate', { role: 'analyst_tier1', resource: 'rag', action: 'read' });
    expect(screen.getByText('Analyst Tier 1 on Knowledge corpus: read')).toBeInTheDocument();
    expect(screen.queryByText(/\brag:read\b/)).toBeNull();
  });
});
