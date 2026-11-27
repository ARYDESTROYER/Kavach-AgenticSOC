/**
 * Wizard demo-toggle tests — Round-5 Coupling-A / bug #3.
 *
 * The first-run wizard's "Demo mode" switch used to write a DEAD `demo_mode` pref that
 * armed nothing. These tests lock the fix:
 *   - flipping it ON calls POST /api/demo/enable (arms the isolated demo tenant),
 *   - flipping it OFF calls POST /api/demo/disable,
 *   - it NO LONGER writes a `demo_mode` key into settings on finish,
 *   - it is visible but disabled for a non-admin so the unavailable mode is explained.
 *
 * The api is fully mocked; the Wizard is mounted under the Auth + Demo providers it now
 * reads (useAuth / useDemo) plus a TooltipProvider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  demoStatusMock,
  demoEnableMock,
  demoDisableMock,
  authMeMock,
  permissionsMock,
  putSettingsMock,
} = vi.hoisted(() => ({
  demoStatusMock: vi.fn(),
  demoEnableMock: vi.fn(),
  demoDisableMock: vi.fn(),
  authMeMock: vi.fn(),
  permissionsMock: vi.fn(),
  putSettingsMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      // Wizard boot
      setupStatus: ok({ setup_complete: false, configured: {} }),
      listConnectors: ok({ connectors: [] }),
      listSources: ok({ sources: [] }),
      getSettings: ok({ prefs: {} }),
      putSettings: putSettingsMock,
      completeSetup: ok({ ok: true }),
      // Auth provider
      auth: { me: authMeMock, logout: ok({ ok: true }) },
      account: { permissions: permissionsMock },
      // Demo provider + the toggle
      demo: {
        status: demoStatusMock,
        enable: demoEnableMock,
        disable: demoDisableMock,
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

const OFF = { mode: 'off' as const, active: false };
const SEEDED = { mode: 'seeded' as const, active: true };

function renderWizard() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <Wizard onComplete={vi.fn()} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

describe('Wizard demo toggle (bug #3)', () => {
  beforeEach(() => {
    demoStatusMock.mockReset().mockResolvedValue(OFF);
    demoEnableMock.mockReset().mockResolvedValue(SEEDED);
    demoDisableMock.mockReset().mockResolvedValue(OFF);
    putSettingsMock.mockReset().mockResolvedValue({ ok: true });
    // Auth OFF → every principal is effectively admin (canManageDemo === true).
    authMeMock.mockReset().mockResolvedValue({
      auth_enabled: false,
      authenticated: true,
      user: null,
    });
    permissionsMock
      .mockReset()
      .mockResolvedValue({ authenticated: true, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {} });
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  }

  it('arms demo mode via POST /api/demo/enable when toggled ON (admin)', async () => {
    const user = userEvent.setup();
    renderWizard();

    const toggle = await screen.findByRole('radio', { name: /Synthetic demo/i });
    expect(toggle).toBeInTheDocument();
    expect(demoEnableMock).not.toHaveBeenCalled();

    await user.click(toggle);

    await waitFor(() => expect(demoEnableMock).toHaveBeenCalledTimes(1));
    expect(demoEnableMock).toHaveBeenCalledWith({ mode: 'live' });
    // Never the dead pref path.
    expect(putSettingsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ demo_mode: expect.anything() }),
    );
  });

  it('disarms demo mode via POST /api/demo/disable when toggled OFF (admin)', async () => {
    // Start with demo already ON so the first click turns it OFF.
    demoStatusMock.mockResolvedValue(SEEDED);
    const user = userEvent.setup();
    renderWizard();

    const toggle = await screen.findByRole('radio', { name: /Synthetic demo/i });
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(screen.getByRole('radio', { name: /Live environment/i }));
    expect(demoDisableMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      /removes its isolated sample activity/i,
    );
    await user.click(screen.getByRole('button', { name: /Disable demo and switch/i }));
    await waitFor(() => expect(demoDisableMock).toHaveBeenCalledTimes(1));
  });

  it('blocks step navigation while a demo transition is pending', async () => {
    const enable = deferred<typeof SEEDED>();
    demoEnableMock.mockReturnValueOnce(enable.promise);
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('radio', { name: /Synthetic demo/i }));
    const reviewButton = screen.getByRole('button', { name: /Review & launch/i });
    fireEvent.click(reviewButton);

    expect(reviewButton).toBeDisabled();
    expect(screen.getByRole('heading', { name: /How do you want to start/i })).toBeVisible();
    expect(demoEnableMock).toHaveBeenCalledTimes(1);

    enable.resolve(SEEDED);
    await waitFor(() => expect(reviewButton).toBeEnabled());
    expect(screen.getByRole('heading', { name: /How do you want to start/i })).toBeVisible();
  });

  it('shows demo as unavailable without demo:manage', async () => {
    authMeMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'ana', role: 'analyst_tier1' },
    });
    // RBAC on, and the analyst's effective grants hold NO demo:manage.
    permissionsMock.mockResolvedValue({
      authenticated: true,
      role: 'analyst_tier1',
      custom_roles: [],
      rbac_enabled: true,
      permissions: { cases: ['read'] },
    });

    renderWizard();

    const demoChoice = await screen.findByRole('radio', { name: /Synthetic demo/i });
    expect(demoChoice).toBeDisabled();
    expect(screen.getByText(/Requires demo management permission/i)).toBeInTheDocument();
    expect(demoEnableMock).not.toHaveBeenCalled();
  });

  it('disables the Live choice when an operator cannot disable the active demo', async () => {
    demoStatusMock.mockResolvedValue(SEEDED);
    authMeMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'ana', role: 'analyst_tier1' },
    });
    permissionsMock.mockResolvedValue({
      authenticated: true,
      role: 'analyst_tier1',
      custom_roles: [],
      rbac_enabled: true,
      permissions: { cases: ['read'] },
    });

    renderWizard();

    const liveChoice = await screen.findByRole('radio', { name: /Live environment/i });
    await waitFor(() => expect(screen.getByRole('radio', { name: /Synthetic demo/i })).toBeChecked());
    expect(liveChoice).toBeDisabled();
    expect(
      screen.getByText(/Requires demo management permission to disable the active demo/i),
    ).toBeVisible();
    expect(demoDisableMock).not.toHaveBeenCalled();
  });
});
