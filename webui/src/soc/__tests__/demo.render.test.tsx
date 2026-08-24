/**
 * Round-2 Wave 5 — Demo Mode UX render tests.
 *
 * 1. Experimental Settings control (<DemoModeSection/>): renders the mode toggle +
 *    knobs and calls api.demo.enable when "Enable demo mode" is clicked.
 * 2. <DemoIndicator/>: the compact top-bar chip that replaced the full-width banner —
 *    shows when the demo tenant is active (status.mode !== 'off'), renders nothing when
 *    off, and keeps the isolation copy + both reversible exits inside its popover.
 *
 * Both mount under a real <DemoProvider> with a mocked api so the shared status
 * context drives them exactly as it does in the app.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Mock the typed api client BEFORE importing anything that pulls it in. The mock
// factory is hoisted, so the shared fns must be declared via vi.hoisted().
const { enableMock, incidentMock, statusMock, permissionState } = vi.hoisted(() => ({
  enableMock: vi.fn(),
  incidentMock: vi.fn(),
  statusMock: vi.fn(),
  permissionState: { canManage: true },
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      demo: {
        status: statusMock,
        enable: enableMock,
        incident: incidentMock,
        reset: ok({ mode: 'seeded', active: true, run_id: 'demo-run' }),
        disable: ok({ mode: 'off', active: false, run_id: null }),
      },
    },
  };
});

// sonner toasts are side-effects we don't assert on; stub them.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/soc/components/Can', () => ({
  useCan: () => permissionState.canManage,
}));

import { DemoProvider } from '../demo';
import { DemoModeSection } from '../components/DemoModeSection';
import { DemoIndicator } from '../components/DemoIndicator';
import { TooltipProvider } from '@/ui/tooltip';

const OFF = { mode: 'off' as const, active: false, run_id: null };
const ACTIVE = {
  mode: 'live' as const,
  active: true,
  run_id: 'demo-abc',
  seed: 1337,
  history_days: 14,
  tick_seconds: 10,
  incident_rate: 0.05,
  case_count: 42,
};

function withProvider(node: React.ReactNode) {
  // DemoModeSection now composes NumberField (whose steppers are IconButtons wrapping a
  // Radix Tooltip), so a TooltipProvider is required — the real app supplies one globally
  // (App.tsx). Wrapping here mirrors that.
  return render(
    <TooltipProvider>
      <DemoProvider>{node}</DemoProvider>
    </TooltipProvider>,
  );
}

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('max-width') ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setMobileViewport(false);
  enableMock.mockReset();
  enableMock.mockResolvedValue(ACTIVE);
  incidentMock.mockReset().mockResolvedValue({
    triggered: true,
    reason: 'coherent synthetic attack emitted',
    scenario_id: 'credential_lateral',
    scenario_name: 'Credential access and lateral movement',
    events: 7,
    native_alerts: 3,
    system_detections: 1,
    cooldown_seconds: 10,
    sources: {},
  });
  permissionState.canManage = true;
  statusMock.mockReset();
  // Default: OFF for the status poll. Individual tests override.
  statusMock.mockResolvedValue(OFF);
});

describe('Experimental › Demo Mode control', () => {
  it('renders the mode toggle + knobs and calls api.demo.enable on Enable', async () => {
    statusMock.mockResolvedValue(OFF);
    withProvider(<DemoModeSection />);

    // The standardized section heading + both mode options render once status resolves.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Experimental & Demo', level: 2 })).toBeInTheDocument(),
    );
    expect(screen.getByText('Seeded')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    // A knob label proves the arming form (not the active summary) is shown.
    expect(screen.getByText('History')).toBeInTheDocument();

    // Clicking "Enable demo mode" calls the endpoint with a DemoConfig.
    fireEvent.click(screen.getByRole('button', { name: /enable demo mode/i }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledTimes(1));
    const arg = enableMock.mock.calls[0][0];
    // Live is now the out-of-box showcase default; the seeded option remains available
    // but the primary CTA should immediately start the continuously updating story.
    expect(arg).toMatchObject({ mode: 'live' });
    expect(typeof arg.seed).toBe('number');
  });

  it('shows the active summary + Exit & clear when demo is already active', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoModeSection />);
    await waitFor(() => expect(screen.getByText('Synthetic cases')).toBeInTheDocument());
    const metrics = screen.getByTestId('demo-settings-surface').querySelectorAll('[data-settings-metric]');
    expect(metrics).toHaveLength(8);
    for (const metric of metrics) {
      expect(metric).toHaveClass('border-l');
      expect(metric.className).not.toMatch(/rounded|shadow|bg-card|bg-surface/);
    }
    expect(screen.getByRole('button', { name: /exit & clear/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
  });

  it('can emit a coherent incident from an active presentation tenant', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoModeSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate incident' }));
    await waitFor(() => expect(incidentMock).toHaveBeenCalledTimes(1));
  });
});

describe('<DemoIndicator/>', () => {
  it('renders nothing when demo mode is off', async () => {
    statusMock.mockResolvedValue(OFF);
    const { container } = withProvider(<DemoIndicator />);
    // Allow the status poll to resolve, then assert the chip stayed empty.
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/demo mode/i);
    expect(screen.queryByTestId('demo-indicator')).toBeNull();
  });

  it('shows a compact chip whose popover carries the isolation copy + both exits', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoIndicator />);

    const chip = await screen.findByTestId('demo-indicator');
    // The visible label collapses below `lg`, so the accessible name must always be full.
    expect(chip).toHaveAccessibleName('Demo mode active — synthetic data');
    // The chip itself is the only demo chrome — no full-width banner copy inline.
    expect(chip.textContent).not.toMatch(/simulated data/i);

    fireEvent.click(chip);
    expect(
      await screen.findByText(/demo mode active \(simulated data\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/fully isolated live simulation dataset/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reset$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exit & clear/i })).toBeInTheDocument();
  });

  it('stays inline in the bar at mobile widths (safety state is never folded away)', async () => {
    setMobileViewport(true);
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoIndicator announce />);

    const chip = await screen.findByTestId('demo-indicator');
    expect(chip).toHaveAttribute('aria-live', 'polite');
    fireEvent.click(chip);
    expect(await screen.findByRole('button', { name: /^reset$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exit & clear/i })).toBeInTheDocument();
  });

  it('keeps the safety chip + copy but hides mutations without demo:manage', async () => {
    permissionState.canManage = false;
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoIndicator />);

    fireEvent.click(await screen.findByTestId('demo-indicator'));
    expect(await screen.findByText(/demo mode active \(simulated data\)/i)).toBeInTheDocument();
    expect(screen.getByText(/fully isolated live simulation dataset/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /exit & clear/i })).toBeNull();
    expect(screen.getByText(/needs the demo management permission/i)).toBeInTheDocument();
  });

  it('deep-links into the demo settings section and closes the popover', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    const onNavigate = vi.fn();
    withProvider(<DemoIndicator onNavigate={onNavigate} />);

    fireEvent.click(await screen.findByTestId('demo-indicator'));
    fireEvent.click(await screen.findByRole('button', { name: /manage demo mode/i }));
    expect(onNavigate).toHaveBeenCalledWith('settings', { section: 'demo' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /exit & clear/i })).toBeNull(),
    );
  });
});
