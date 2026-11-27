/**
 * Round 12 — Settings → Security hands the RBAC state to the Session policy editor,
 * so "Never remember these roles" can warn that, while role-based access is off,
 * every account counts as Super admin (excluding it turns Remember me off for all).
 *
 * Round 15 (SPEC D1.4): the state is the live session's (`useAuth().rbacEnabled`, which
 * `auth.refresh()` updates after the switch on Roles & permissions), never the Settings
 * draft, so the note is right as soon as the switch changes. The note's text is unchanged.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const auth = vi.hoisted(() => ({ rbacEnabled: false }));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ authEnabled: true, rbacEnabled: auth.rbacEnabled, role: 'super_admin', hasPermission: () => true }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSettings: vi.fn().mockResolvedValue({ prefs: {}, configured: {} }),
      putSettings: vi.fn().mockResolvedValue({}),
      setup: { status: vi.fn().mockRejectedValue(new Error('offline')) },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences } from '@/lib/types';
import { SecuritySsoInner } from '../Security';

function renderWith(prefs: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <SecuritySsoInner
        prefs={{ sso: { enabled: false, providers: [] }, session_policy: {}, ...prefs } as Preferences}
        update={vi.fn()}
        configured={{}}
        embedded
      />
    </TooltipProvider>,
  );
}

describe('Security — Remember me and role-based access', () => {
  beforeEach(() => {
    auth.rbacEnabled = false;
  });

  it('warns about excluding Super admin while role-based access is off', () => {
    renderWith({ rbac: { enabled: false } });
    expect(document.querySelector('[data-remember-rbac-note]')).toHaveTextContent(
      'Role-based access is off, so every account counts as Super admin.',
    );
  });

  it('says nothing while role-based access is on', () => {
    auth.rbacEnabled = true;
    renderWith({ rbac: { enabled: true } });
    expect(document.querySelector('[data-session-policy-remember]')).not.toBeNull();
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
  });

  it('follows the live session, not a stale Settings draft', () => {
    // The switch turned role-based access on; the draft still says off.
    auth.rbacEnabled = true;
    renderWith({ rbac: { enabled: false } });
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
  });

  it('warns after the switch turned it off, whatever the draft says', () => {
    renderWith({ rbac: { enabled: true } });
    expect(document.querySelector('[data-remember-rbac-note]')).toHaveTextContent(
      'Role-based access is off, so every account counts as Super admin.',
    );
  });
});
