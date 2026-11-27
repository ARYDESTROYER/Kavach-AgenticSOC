/**
 * Round 15 (SPEC D1.1, D1.4, D1.5): the role-based access switch on Roles & permissions.
 *
 *  - The "Role-based access" group comes first: the state ("On" or "Off: every signed-in
 *    account is treated as Super admin"), the active accounts per role when the server
 *    reports them, and one button.
 *  - A blocker disables the button and says why as visible text.
 *  - Turning on asks in a plain confirmation that names the effects; turning off asks in a
 *    destructive one. The change is `request('PUT', 'rbac', {body, reauthPurpose})`, then
 *    the session is re-read, the roles reload and a toast says what changed.
 *  - A refusal is a toast with the server's message, and the state is read again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiGetMock, requestMock, authMeMock, toastSuccess, toastError } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  requestMock: vi.fn(),
  authMeMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status?: number;
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    request: requestMock,
    api: {
      auth: { me: authMeMock },
      get: apiGetMock,
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, info: vi.fn(), warning: vi.fn() },
}));

import { ApiError } from '@/lib/api';
import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Roles from '../pages/Roles';
import { roleCountsCaption } from '../pages/RbacSwitchPanel';

const MATRIX = {
  roles: ['super_admin', 'analyst_tier1'],
  default_role: 'analyst_tier1',
  matrix: { super_admin: { '*': ['*'] }, analyst_tier1: { cases: ['read'] } },
};

const PERMISSIONS = {
  authenticated: true,
  role: 'super_admin',
  custom_roles: [],
  rbac_enabled: false,
  permissions: { roles: ['read', 'manage'] },
};

type Status = {
  enabled: boolean;
  auth_enabled: boolean;
  can_change: boolean;
  blockers: string[];
  caller_role: string;
  super_admin_count: number;
  role_counts: Record<string, number> | null;
};

function status(overrides: Partial<Status> = {}): Status {
  return {
    enabled: false,
    auth_enabled: true,
    can_change: true,
    blockers: [],
    caller_role: 'super_admin',
    super_admin_count: 1,
    role_counts: { super_admin: 1, analyst_tier1: 1234, soc_manager: 2 },
    ...overrides,
  };
}

let current: Status = status();

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

async function panel() {
  const group = await screen.findByRole('group', { name: 'Role-based access' });
  await waitFor(() => expect(within(group).queryByText('Checking')).toBeNull());
  return group;
}

describe('Role-based access switch (Round 15)', () => {
  beforeEach(() => {
    current = status();
    apiGetMock.mockReset().mockImplementation((path: string) =>
      Promise.resolve(path === 'roles' ? MATRIX : path === 'rbac' ? current : PERMISSIONS),
    );
    requestMock.mockReset();
    authMeMock.mockReset().mockResolvedValue({ authenticated: false, auth_enabled: false, user: null });
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('opens the section with the state, the accounts per role and one button', async () => {
    renderRoles();
    const group = await panel();
    const state = within(group).getByText('Off: every signed-in account is treated as Super admin');
    expect(state).toBeInTheDocument();
    // The security state is never cut short: on a phone it wraps (no hover shows the rest).
    expect(state).not.toHaveClass('truncate');
    expect(state).toHaveClass('whitespace-normal');
    expect(
      within(group).getByText('Active accounts: Super admin (1), SOC manager (2), Analyst Tier 1 (1,234).'),
    ).toBeInTheDocument();
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Turn on role-based access');
    expect(buttons[0]).toBeEnabled();
    expect(within(group).getByText('Each role sees and does only what its permissions allow.')).toBeInTheDocument();
  });

  it('shows "On" and offers to turn it off when it is on', async () => {
    current = status({ enabled: true });
    renderRoles();
    const group = await panel();
    expect(within(group).getByText('On')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Turn off role-based access' })).toBeEnabled();
  });

  it.each([
    ['auth_off', 'Turn on sign-in first. Role-based access has no effect while sign-in is off.'],
    ['not_super_admin', 'Only a Super admin can turn role-based access on or off.'],
    ['read_only_settings', 'Settings are in read-only mode.'],
  ])('disables the button with the reason as visible text (%s)', async (blocker, reason) => {
    current = status({ can_change: false, blockers: [blocker], role_counts: null });
    renderRoles();
    const group = await panel();
    expect(within(group).getByRole('button', { name: 'Turn on role-based access' })).toBeDisabled();
    expect(within(group).getByText(reason)).toBeVisible();
    // No counts without users:manage.
    expect(within(group).queryByText(/Active accounts/)).toBeNull();
  });

  it('asks before turning it on, names the effects, then refreshes the session and the roles', async () => {
    const user = userEvent.setup();
    requestMock.mockResolvedValue({ ...status({ enabled: true }), changed: true });
    renderRoles();
    const group = await panel();
    await user.click(within(group).getByRole('button', { name: 'Turn on role-based access' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Turn on role-based access?' });
    // The effects alone: no lead sentence repeating the first one.
    expect(within(dialog).queryByText('Each account gets the permissions of its role.')).toBeNull();
    for (const effect of [
      'Every account gets its role’s permissions on its next request.',
      'A background job started by an account that loses a permission stops at its next item.',
      'An open live stream keeps its topics until it reconnects.',
      'Whether an account can use Remember me follows its role.',
      'You stay Super admin.',
    ]) {
      expect(within(dialog).getByText(effect)).toBeInTheDocument();
    }
    // Not the destructive gate: its confirm is the default button.
    expect(within(dialog).getByRole('button', { name: 'Turn on' }).className).not.toMatch(/destructive/);

    const meCalls = authMeMock.mock.calls.length;
    const rolesReads = apiGetMock.mock.calls.filter(([p]) => p === 'roles').length;
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith('PUT', 'rbac', {
        body: { enabled: true },
        reauthPurpose: 'Sign in again to change role-based access.',
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Role-based access is on.'));
    expect(authMeMock.mock.calls.length).toBeGreaterThan(meCalls);
    await waitFor(() =>
      expect(apiGetMock.mock.calls.filter(([p]) => p === 'roles').length).toBeGreaterThan(rolesReads),
    );
    expect(within(group).getByText('On')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks in a destructive confirmation before turning it off', async () => {
    const user = userEvent.setup();
    current = status({ enabled: true });
    requestMock.mockResolvedValue({ ...status({ enabled: false }), changed: true });
    renderRoles();
    const group = await panel();
    await user.click(within(group).getByRole('button', { name: 'Turn off role-based access' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Turn off role-based access?' });
    expect(
      within(dialog).getByText('Every signed-in account will be treated as Super admin, whatever its role.'),
    ).toBeInTheDocument();
    // Destructive: Escape does not dismiss it.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Turn off role-based access?' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith('PUT', 'rbac', {
        body: { enabled: false },
        reauthPurpose: 'Sign in again to change role-based access.',
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Role-based access is off.'));
    expect(within(group).getByText('Off: every signed-in account is treated as Super admin')).toBeInTheDocument();
  });

  it('cancelling changes nothing', async () => {
    const user = userEvent.setup();
    renderRoles();
    const group = await panel();
    const button = within(group).getByRole('button', { name: 'Turn on role-based access' });
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn on role-based access?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(requestMock).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('shows a refusal as a toast and reads the state again', async () => {
    const user = userEvent.setup();
    requestMock.mockRejectedValue(new ApiError('Only a Super admin can turn role-based access on or off.'));
    renderRoles();
    const group = await panel();
    const reads = apiGetMock.mock.calls.filter(([p]) => p === 'rbac').length;
    await user.click(within(group).getByRole('button', { name: 'Turn on role-based access' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn on' }),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Only a Super admin can turn role-based access on or off.'),
    );
    await waitFor(() =>
      expect(apiGetMock.mock.calls.filter(([p]) => p === 'rbac').length).toBeGreaterThan(reads),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('offers to read the state again when it cannot be read', async () => {
    const user = userEvent.setup();
    apiGetMock.mockImplementation((path: string) =>
      path === 'rbac' ? Promise.reject(new Error('down')) : Promise.resolve(path === 'roles' ? MATRIX : PERMISSIONS),
    );
    renderRoles();
    const group = await screen.findByRole('group', { name: 'Role-based access' });
    expect(await within(group).findByText('Couldn’t read the current state.')).toBeInTheDocument();
    apiGetMock.mockImplementation((path: string) =>
      Promise.resolve(path === 'roles' ? MATRIX : path === 'rbac' ? current : PERMISSIONS),
    );
    await user.click(within(group).getByRole('button', { name: 'Try again' }));
    expect(
      await within(group).findByText('Off: every signed-in account is treated as Super admin'),
    ).toBeInTheDocument();
  });
});

describe('roleCountsCaption', () => {
  it('lists active accounts in role order with thousands separators', () => {
    expect(roleCountsCaption({ auditor: 1, custom_x: 3, super_admin: 2, analyst_tier2: 0 })).toBe(
      'Active accounts: Super admin (2), Auditor (1), custom_x (3).',
    );
    expect(roleCountsCaption({ analyst_tier1: 12000 })).toBe('Active accounts: Analyst Tier 1 (12,000).');
  });

  it('says nothing when the counts are not available', () => {
    expect(roleCountsCaption(null)).toBeNull();
    expect(roleCountsCaption({})).toBeNull();
  });
});
