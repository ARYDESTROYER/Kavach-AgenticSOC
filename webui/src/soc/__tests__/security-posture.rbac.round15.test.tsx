/**
 * Round 15 (SPEC D1.1): the Security posture row for role-based access keeps its status
 * text and gains one Manage action that opens the switch on Roles & permissions
 * (`#/settings?s=roles`), the one save path. Without roles:manage there is no Manage
 * action, since that section is not offered.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const auth = vi.hoisted(() => ({ rbacEnabled: false, canManageRoles: true }));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    authEnabled: true,
    rbacEnabled: auth.rbacEnabled,
    role: 'super_admin',
    hasPermission: (resource: string, action: string) =>
      resource === 'roles' && action === 'manage' ? auth.canManageRoles : true,
  }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSettings: vi.fn().mockResolvedValue({ prefs: {}, configured: {} }),
      setup: { status: vi.fn().mockResolvedValue({}) },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { RouterProvider } from '../router';
import { OrgSecuritySection } from '@/soc/pages/settings/security';

function renderPosture() {
  const prefs = { sso: { enabled: false, providers: [] }, session_policy: {} } as unknown as Preferences;
  render(
    <TooltipProvider>
      <RouterProvider>
        <OrgSecuritySection prefs={prefs} persistedPrefs={prefs} update={vi.fn()} configured={{}} />
      </RouterProvider>
    </TooltipProvider>,
  );
  const posture = screen.getByRole('group', { name: 'Posture' });
  return within(posture).getByText('Role-based access').closest('[data-setting-row]') as HTMLElement;
}

describe('Security posture: role-based access', () => {
  beforeEach(() => {
    auth.rbacEnabled = false;
    auth.canManageRoles = true;
    window.location.hash = '#/settings?s=security';
  });

  it('keeps the status and opens the switch on Roles & permissions', async () => {
    const user = userEvent.setup();
    const row = renderPosture();
    expect(row).toHaveTextContent('Off: everyone is Super admin');
    const manage = within(row).getByRole('button', { name: 'Manage role-based access' });
    expect(manage).toHaveTextContent('Manage');
    await user.click(manage);
    await waitFor(() => expect(window.location.hash).toBe('#/settings?s=roles'));
  });

  it('says Enforced while it is on', () => {
    auth.rbacEnabled = true;
    const row = renderPosture();
    expect(row).toHaveTextContent('Enforced');
    expect(within(row).getByRole('button', { name: 'Manage role-based access' })).toBeInTheDocument();
  });

  it('offers no Manage action without roles:manage', () => {
    auth.canManageRoles = false;
    const row = renderPosture();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(row).toHaveTextContent('Off: everyone is Super admin');
  });
});
