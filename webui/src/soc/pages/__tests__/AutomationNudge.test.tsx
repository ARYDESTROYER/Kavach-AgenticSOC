/**
 * AutomationNudge — the inverted "Autopilot is ON" Overview reassurance card.
 *   - auth off / privileged → renders the reassurance + sensitivity dial + one-click OFF,
 *   - changing the sensitivity PUTs the resolved autopilot bounds (deep-merge settings),
 *   - "Turn autopilot off" halts auto-investigation + tuning (+ campaigns for admins),
 *   - a principal WITHOUT automation:manage → self-hides (no 403 dead-end).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getMock, putMock, authMeMock, permissionsMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  authMeMock: vi.fn(),
  permissionsMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  setUnauthorizedHandler: vi.fn(),
  setReauthHandler: vi.fn(),
  ApiError: class ApiError extends Error {},
  api: {
    get: getMock,
    put: putMock,
    auth: { me: authMeMock, logout: vi.fn().mockResolvedValue({ ok: true }) },
    account: { permissions: permissionsMock },
  },
}));

import { AuthProvider } from '../../auth';
import { AutomationNudge } from '../AutomationNudge';

function renderNudge(overrides?: Partial<{ onEnabled: () => void }>) {
  const onEnabled = overrides?.onEnabled ?? vi.fn();
  render(
    <AuthProvider>
      <AutomationNudge onEnabled={onEnabled} onReview={vi.fn()} onDismiss={vi.fn()} />
    </AuthProvider>,
  );
  return { onEnabled };
}

describe('AutomationNudge — inverted autopilot reassurance card', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ config: { enabled: true, shadow_eval: true } });
    putMock.mockReset().mockResolvedValue({ ok: true });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    permissionsMock
      .mockReset()
      .mockResolvedValue({ authenticated: true, role: 'super_admin', custom_roles: [], rbac_enabled: false, permissions: {} });
  });

  it('renders the "Autopilot is on" reassurance with a sensitivity dial + one-click OFF', async () => {
    renderNudge();
    expect(await screen.findByTestId('automation-nudge')).toBeInTheDocument();
    expect(screen.getByText(/Autopilot is on/i)).toBeInTheDocument();
    // The sensitivity dial + the OFF control are present.
    expect(screen.getByRole('radio', { name: /Balanced/i })).toBeInTheDocument();
    expect(screen.getByTestId('autopilot-off')).toBeInTheDocument();
  });

  it('changing the sensitivity to aggressive PUTs the resolved autopilot bounds', async () => {
    const user = userEvent.setup();
    const { onEnabled } = renderNudge();

    const aggressive = await screen.findByRole('radio', { name: /Aggressive/i });
    await user.click(aggressive);

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith(
        'settings',
        expect.objectContaining({
          autopilot_profile: 'aggressive',
          auto_investigate_risk_floor: 40,
          caps: { max_auto_investigations_per_tick: 100 },
          budget: { daily_usd: 50 },
        }),
      ),
    );
    await waitFor(() => expect(onEnabled).toHaveBeenCalled());
  });

  it('"Turn autopilot off" halts auto-investigation + tuning (+ campaigns for admins)', async () => {
    const user = userEvent.setup();
    const { onEnabled } = renderNudge();

    const off = await screen.findByTestId('autopilot-off');
    await user.click(off);

    // Master switch off + tuning GET-then-PUT enabled:false.
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('settings', { background_scan_enabled: false }),
    );
    expect(getMock).toHaveBeenCalledWith('tuning/config');
    expect(putMock).toHaveBeenCalledWith(
      'tuning/config',
      expect.objectContaining({ enabled: false }),
    );
    // Campaigns off (auth off → admin grant holds).
    expect(putMock).toHaveBeenCalledWith('campaigns/config', { enabled: false });
    await waitFor(() => expect(onEnabled).toHaveBeenCalled());
  });

  it('self-hides for a principal without automation:manage (no 403 dead-end)', async () => {
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

    renderNudge();

    await waitFor(() => expect(screen.queryByTestId('automation-nudge')).toBeNull());
    expect(putMock).not.toHaveBeenCalled();
  });
});
