/**
 * Round 12 — Settings → Security hands the RBAC state to the Session policy editor,
 * so "Never remember these roles" can warn that, while role-based access is off,
 * every account counts as Super admin (excluding it turns Remember me off for all).
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

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
  it('warns about excluding Super admin while role-based access is off', () => {
    renderWith({ rbac: { enabled: false } });
    expect(document.querySelector('[data-remember-rbac-note]')).toHaveTextContent(
      'Role-based access is off, so every account counts as Super admin.',
    );
  });

  it('says nothing while role-based access is on', () => {
    renderWith({ rbac: { enabled: true } });
    expect(document.querySelector('[data-session-policy-remember]')).not.toBeNull();
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
  });
});
