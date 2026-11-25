/**
 * Single sign-on is for a stored Super admin only (Round 16, WP15A B15 server rule; the
 * Console side is a WP15E part 2 addition). Saving an SSO change as anyone else answers
 * `403 "Only a Super admin can change single sign-on."`, so for such a viewer the SSO
 * controls are read-only and say that sentence instead of letting them edit a draft the
 * server will refuse.
 *
 * With role-based access on, the session role is the stored role. With it off, every
 * account is treated as Super admin in the Console, so the stored role is read from
 * `GET /api/rbac` (`caller_role`).
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';

const { authState, rbacStatusMock, setSecretMock } = vi.hoisted(() => ({
  authState: { authEnabled: true, rbacEnabled: true, role: 'soc_manager' as string },
  rbacStatusMock: vi.fn(),
  setSecretMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      auth: { ...actual.api.auth, sso: { setSecret: setSecretMock } },
      setup: { status: vi.fn().mockResolvedValue({}) },
    },
  };
});
vi.mock('@/lib/api-rbac', () => ({ rbacApi: { status: () => rbacStatusMock() } }));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ ...authState, hasPermission: () => true }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { SecuritySsoInner } from '@/soc/pages/Security';

const SENTENCE = 'Only a Super admin can change single sign-on.';
const SSO = {
  enabled: true,
  providers: [
    { id: 'generic-a', type: 'generic', enabled: true, display_name: 'Acme IdP', client_id: 'cid', allowed_domains: [], allowed_tenants: [], group_role_map: {} },
  ],
};

function renderSso() {
  const update = vi.fn();
  render(
    <TooltipProvider>
      <SecuritySsoInner prefs={{ sso: SSO } as unknown as Preferences} update={update} configured={{}} />
    </TooltipProvider>,
  );
  return update;
}

beforeEach(() => {
  authState.authEnabled = true;
  authState.rbacEnabled = true;
  authState.role = 'soc_manager';
  rbacStatusMock.mockReset();
});

describe('SSO controls for a viewer who is not a stored Super admin', () => {
  it('are read-only and say why (role-based access on)', () => {
    renderSso();
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable single sign-on' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Add Google|Add Microsoft|Add a generic/i })).toBeNull();
    const provider = screen.getByRole('group', { name: 'Acme IdP' });
    expect(within(provider).getByLabelText('Client ID')).toBeDisabled();
    expect(within(provider).getByRole('switch', { name: 'Provider enabled' })).toBeDisabled();
    expect(within(provider).queryByRole('button', { name: /Remove provider/ })).toBeNull();
    expect(within(provider).getByRole('button', { name: 'Save secret' })).toBeDisabled();
  });

  it('reads the stored role when role-based access is off', async () => {
    authState.rbacEnabled = false;
    authState.role = 'super_admin'; // the Console view while role-based access is off
    rbacStatusMock.mockResolvedValue({ caller_role: 'analyst_tier2' });
    renderSso();
    expect(await screen.findByText(SENTENCE)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable single sign-on' })).toBeDisabled();
  });

  it('stay editable for a stored Super admin', async () => {
    authState.rbacEnabled = false;
    authState.role = 'super_admin';
    rbacStatusMock.mockResolvedValue({ caller_role: 'super_admin' });
    renderSso();
    // Let the stored-role read settle inside act (a Super admin changes nothing visible).
    await act(async () => {
      await Promise.resolve();
    });
    expect(rbacStatusMock).toHaveBeenCalled();
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Enable single sign-on' })).toBeEnabled();
    const provider = screen.getByRole('group', { name: 'Acme IdP' });
    expect(within(provider).getByLabelText('Client ID')).toBeEnabled();
  });

  it('stay editable with sign-in off (the server does not check a role then)', () => {
    authState.authEnabled = false;
    renderSso();
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Enable single sign-on' })).toBeEnabled();
    expect(rbacStatusMock).not.toHaveBeenCalled();
  });
});
