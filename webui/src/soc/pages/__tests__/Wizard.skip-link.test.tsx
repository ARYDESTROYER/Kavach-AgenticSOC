/**
 * The setup wizard's skip link (Round 16 bug hunt B71, WP15F).
 *
 * "Skip to setup content" used to be a plain `href="#setup-main"` fragment link. The Console
 * routes by the URL hash, so the fragment reached the hash router (the shell that mounts after
 * setup read it as an unknown page). It now moves focus to the setup content in code and leaves
 * the hash alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      setupStatus: ok({ setup_complete: false, configured: {} }),
      listConnectors: ok({ connectors: [] }),
      listSources: ok({ sources: [] }),
      getSettings: ok({ prefs: {} }),
      putSettings: ok({ ok: true }),
      completeSetup: ok({ ok: true }),
      auth: { me: ok({ auth_enabled: false, authenticated: true, user: null }), logout: ok({ ok: true }) },
      account: {
        permissions: ok({ authenticated: true, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {} }),
      },
      demo: {
        status: ok({ mode: 'off', active: false }),
        enable: ok({ mode: 'seeded', active: true }),
        disable: ok({ mode: 'off', active: false }),
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

describe('Wizard skip link (B71)', () => {
  beforeEach(() => {
    window.location.hash = '#/overview';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('focuses the setup content without writing the fragment into the hash', async () => {
    render(
      <TooltipProvider>
        <AuthProvider>
          <DemoProvider>
            <Wizard onComplete={vi.fn()} />
          </DemoProvider>
        </AuthProvider>
      </TooltipProvider>,
    );
    const skip = await screen.findByRole('link', { name: 'Skip to setup content' });
    expect(skip).toHaveAttribute('href', '#setup-main');
    fireEvent.click(skip);

    expect(window.location.hash).toBe('#/overview');
    expect(document.activeElement).toBe(document.getElementById('setup-main'));
  });
});
