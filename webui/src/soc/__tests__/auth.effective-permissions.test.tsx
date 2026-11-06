/**
 * Round 14 FX7e, finding roles-01: the Console's permission checks read the signed-in
 * person's EFFECTIVE grants, the one map `GET /api/account/permissions` answers with the
 * server's own resolver (the base role together with every assigned custom role, each
 * with its denies applied). The role matrix is never consulted, so:
 *
 *   - an analyst_tier1 whose custom role grants `audit:view` sees the Audit log;
 *   - an auditor whose custom role grants `cases:write` sees Acknowledge;
 *   - a custom role that grants `runbooks:publish` shows Publish;
 *   - a deny the server applied (no `runbooks:run` in the map) hides the control even
 *     though the base role's own row would grant it;
 *   - a failed read denies (super_admin excepted), RBAC genuinely off allows all, auth
 *     off reads nothing and allows all;
 *   - `refresh()` reads the grants again (a role change takes effect without a reload),
 *     and signing out forgets them;
 *   - the session is published together with its grants, never before them: no render
 *     shows a signed-in analyst while the grants are still in flight (the empty
 *     signed-out map would read as "RBAC off" and allow every action), and a refresh
 *     keeps the person's current grants until the new ones are back (FX7e fix).
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const { meMock, permissionsMock, rolesMock, logoutMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  permissionsMock: vi.fn(),
  rolesMock: vi.fn(),
  logoutMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  setUnauthorizedHandler: vi.fn(),
  setReauthHandler: vi.fn(),
  api: {
    auth: { me: () => meMock(), logout: () => logoutMock() },
    account: { permissions: () => permissionsMock() },
    // The role matrix: the provider must never read it to decide access.
    roles: { get: () => rolesMock() },
  },
}));

import { AuthProvider, useAuth, type AuthContextValue } from '../auth';
import { Can, ProtectedRoute } from '../components/Can';

const signedIn = (role: string, username = 'noaudit') => ({
  auth_enabled: true,
  authenticated: true,
  user: { username, role, must_change_password: false },
});

const access = (permissions: Record<string, string[]>, role = 'analyst_tier1', customRoles = ['cr_custom']) => ({
  authenticated: true,
  role,
  custom_roles: customRoles,
  rbac_enabled: true,
  permissions,
});

let auth: AuthContextValue;
// Every committed render's view: signed in, and whether user administration is allowed.
let renders: Array<{ signedIn: boolean; usersManage: boolean }> = [];
function Probe() {
  auth = useAuth();
  React.useEffect(() => {
    renders.push({ signedIn: auth.isAuthenticated, usersManage: auth.hasPermission('users', 'manage') });
  });
  return null;
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Console() {
  return (
    <>
      <Probe />
      <Can resource="audit" action="view">
        <a href="#/audit">Audit log</a>
      </Can>
      <Can resource="cases" action="write">
        <button type="button">Acknowledge</button>
      </Can>
      <Can resource="runbooks" action="publish">
        <button type="button">Publish</button>
      </Can>
      <Can resource="runbooks" action="run">
        <button type="button">Start runbook</button>
      </Can>
      <Can resource="users" action="manage" fallback={<p>No user administration</p>}>
        <a href="#/users">Users</a>
      </Can>
      <ProtectedRoute resource="settings" action="manage">
        <p>Settings editor</p>
      </ProtectedRoute>
    </>
  );
}

async function mount() {
  render(
    <AuthProvider>
      <Console />
    </AuthProvider>,
  );
  await waitFor(() => expect(auth.loading).toBe(false));
}

beforeEach(() => {
  renders = [];
  meMock.mockReset();
  permissionsMock.mockReset();
  rolesMock.mockReset().mockResolvedValue({
    roles: [],
    default_role: 'analyst_tier1',
    rbac_enabled: true,
    // If the provider read the matrix, analyst_tier1's own row would grant these.
    matrix: { analyst_tier1: { runbooks: ['read', 'run'], cases: ['read'] } },
  });
  logoutMock.mockReset().mockResolvedValue({ ok: true });
});

describe('AuthProvider reads the effective grants, not the role matrix', () => {
  it('shows what a custom role grants on top of the base role (the acceptance cases)', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockResolvedValue(
      access({
        audit: ['view', 'export'],
        cases: ['read', 'write', 'close', 'assign', 'comment', 'reinvestigate'],
        runbooks: ['read', 'run', 'manage', 'publish'],
        users: ['manage'],
        settings: ['read', 'manage'],
      }),
    );
    await mount();
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByText('Settings editor')).toBeInTheDocument();
    expect(auth.rbacEnabled).toBe(true);
    expect(permissionsMock).toHaveBeenCalledTimes(1);
    expect(rolesMock).not.toHaveBeenCalled();
  });

  it('an auditor whose custom role grants case writes sees Acknowledge', async () => {
    meMock.mockResolvedValue(signedIn('auditor', 'norun'));
    permissionsMock.mockResolvedValue(
      access({ cases: ['read', 'write', 'close'], runbooks: ['read'], audit: ['view'] }, 'auditor', ['cr_no_run']),
    );
    await mount();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    // The custom role's deny: the server left runbooks:run out, so the control hides.
    expect(screen.queryByRole('button', { name: 'Start runbook' })).toBeNull();
  });

  it('hides what the server denied even when the base role row would grant it', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockResolvedValue(access({ cases: ['read'], runbooks: ['read'] }));
    await mount();
    expect(screen.queryByRole('button', { name: 'Start runbook' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
    expect(screen.getByText('No user administration')).toBeInTheDocument();
    expect(screen.queryByText('Settings editor')).toBeNull();
    expect(screen.getByText('Access restricted')).toBeInTheDocument();
    expect(auth.hasPermission('runbooks', 'read')).toBe(true);
    expect(auth.hasPermission('runbooks', 'run')).toBe(false);
    // An action the vocabulary never lists, and a wildcard, are never matched.
    expect(auth.hasPermission('runbooks', '*')).toBe(false);
    expect(auth.hasPermission('unknown', 'read')).toBe(false);
  });

  it('denies everything when the grants cannot be read, except for super_admin', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockRejectedValue(new Error('permissions 500'));
    await mount();
    expect(auth.hasPermission('cases', 'read')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();

    meMock.mockResolvedValue(signedIn('super_admin', 'root'));
    await act(async () => {
      await auth.refresh();
    });
    expect(auth.hasPermission('users', 'manage')).toBe(true);
  });

  it('allows every action when RBAC is genuinely off', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockResolvedValue({
      authenticated: true,
      role: 'super_admin',
      custom_roles: [],
      rbac_enabled: false,
      permissions: { cases: ['read'] },
    });
    await mount();
    expect(auth.rbacEnabled).toBe(false);
    expect(auth.hasPermission('users', 'manage')).toBe(true);
  });

  it('with auth off reads nothing and allows every action', async () => {
    meMock.mockResolvedValue({ auth_enabled: false, authenticated: false, user: null });
    await mount();
    expect(permissionsMock).not.toHaveBeenCalled();
    expect(auth.hasPermission('users', 'manage')).toBe(true);
  });

  it('refresh() reads the grants again, so a role change takes effect without a reload', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockResolvedValueOnce(access({ cases: ['read'] }));
    await mount();
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();

    permissionsMock.mockResolvedValueOnce(access({ cases: ['read'], audit: ['view'] }));
    await act(async () => {
      await auth.refresh();
    });
    expect(permissionsMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('signing out forgets the grants: the next person sees only their own', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockResolvedValue(access({ audit: ['view'] }));
    await mount();
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
    await act(async () => {
      await auth.logout();
    });
    expect(auth.isAuthenticated).toBe(false);

    meMock.mockResolvedValue(signedIn('analyst_tier1', 'next'));
    permissionsMock.mockResolvedValue(access({ cases: ['read'] }, 'analyst_tier1', []));
    await act(async () => {
      await auth.refresh();
    });
    expect(auth.username).toBe('next');
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
    expect(auth.hasPermission('cases', 'read')).toBe(true);
  });

  it('a sign-in is published only with its grants: no render allows everything in between', async () => {
    meMock.mockResolvedValue({ auth_enabled: true, authenticated: false, user: null });
    await mount();
    expect(auth.isAuthenticated).toBe(false);

    // The person signs in; /auth/me answers at once but the grants read is slow.
    const pending = deferred<ReturnType<typeof access>>();
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockReturnValueOnce(pending.promise);
    renders = [];
    let done!: Promise<unknown>;
    await act(async () => {
      done = auth.refresh();
    });
    await waitFor(() => expect(permissionsMock).toHaveBeenCalledTimes(1));
    // Still signed out while the grants are in flight (the shell shows the sign-in
    // page, never the Console), and the username is not published yet either.
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.username).toBeNull();

    await act(async () => {
      pending.resolve(access({ cases: ['read'] }));
      await done;
    });
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.hasPermission('users', 'manage')).toBe(false);
    expect(screen.getByText('No user administration')).toBeInTheDocument();
    // Not one committed render was signed in with user administration allowed.
    expect(renders.some((r) => r.signedIn && r.usersManage)).toBe(false);
  });

  it('a refresh keeps the current grants until the new ones are back', async () => {
    meMock.mockResolvedValue(signedIn('analyst_tier1'));
    permissionsMock.mockResolvedValueOnce(access({ audit: ['view'] }));
    await mount();
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();

    const pending = deferred<ReturnType<typeof access>>();
    permissionsMock.mockReturnValueOnce(pending.promise);
    let done!: Promise<unknown>;
    await act(async () => {
      done = auth.refresh();
    });
    await waitFor(() => expect(permissionsMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('link', { name: 'Audit log' })).toBeInTheDocument();
    expect(auth.isAuthenticated).toBe(true);

    await act(async () => {
      pending.resolve(access({ cases: ['read'] }));
      await done;
    });
    expect(screen.queryByRole('link', { name: 'Audit log' })).toBeNull();
  });
});
