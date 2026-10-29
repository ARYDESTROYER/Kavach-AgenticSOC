/**
 * Round-6 #31 / #32 — the Demo Mode config knobs adopt the shared NumberField /
 * LabeledSlider primitives (steppers + clamp-on-blur + raw-text-while-editing) instead
 * of a hand-rolled raw `<input type=number>` that snapped to 0 on clear and never clamped.
 *
 * Demo overhaul — the two new rate knobs (alert interval + event rate) render and
 * round-trip through `onEnable`'s `DemoConfig` body.
 *
 * `useDemo()` returns a safe OFF default without a provider, so the enable form (with the
 * knobs) renders standalone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the api + toast so the Enable round-trip can be asserted without a backend.
const demoEnableMock = vi.fn().mockResolvedValue({ mode: 'seeded', active: true });
vi.mock('@/lib/api', () => ({
  api: {
    demo: {
      enable: (...a: unknown[]) => demoEnableMock(...a),
      incident: vi.fn().mockResolvedValue({ triggered: true }),
      status: vi.fn().mockResolvedValue({ mode: 'off', active: false }),
      reset: vi.fn().mockResolvedValue({}),
      disable: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DemoModeSection } from '../DemoModeSection';
import { TooltipProvider } from '@/ui/tooltip';

const renderDemo = () =>
  render(
    <TooltipProvider>
      <DemoModeSection />
    </TooltipProvider>,
  );

describe('DemoModeSection knobs (Round-6 #31/#32)', () => {
  beforeEach(() => demoEnableMock.mockClear());

  it('renders NumberField steppers and clamps an over-range History value on blur', () => {
    renderDemo();
    // NumberField exposes +/- IconButtons — proof the raw number input was replaced.
    expect(screen.getAllByRole('button', { name: 'Increase' }).length).toBeGreaterThan(0);

    const history = screen.getByLabelText('History') as HTMLInputElement;
    fireEvent.focus(history);
    fireEvent.change(history, { target: { value: '999' } });
    fireEvent.blur(history);
    expect(history.value).toBe('90'); // clamped to max (was forwarded verbatim before)
  });

  it('does not collapse the History field to 0 when cleared mid-edit', () => {
    renderDemo();
    const history = screen.getByLabelText('History') as HTMLInputElement;
    fireEvent.focus(history);
    fireEvent.change(history, { target: { value: '' } });
    expect(history.value).toBe(''); // stays empty (old raw input snapped to 0)
  });

  it('renders the two new rate knobs (demo overhaul)', () => {
    renderDemo();
    expect(screen.getByLabelText('Alert interval')).toBeInTheDocument();
    expect(screen.getByLabelText('Event rate')).toBeInTheDocument();
  });

  it('round-trips the alert-interval + event-rate knobs through onEnable', async () => {
    const user = userEvent.setup();
    renderDemo();
    const alert = screen.getByLabelText('Alert interval') as HTMLInputElement;
    fireEvent.focus(alert);
    fireEvent.change(alert, { target: { value: '90' } });
    fireEvent.blur(alert);
    const rate = screen.getByLabelText('Event rate') as HTMLInputElement;
    fireEvent.focus(rate);
    fireEvent.change(rate, { target: { value: '25' } });
    fireEvent.blur(rate);

    const enable = screen.getByRole('button', { name: /enable demo mode/i });
    await user.click(enable);

    // The enable body carries the two new rate fields.
    await waitFor(() => expect(demoEnableMock).toHaveBeenCalledTimes(1));
    const body = demoEnableMock.mock.calls[0][0];
    expect(body.mode).toBe('live');
    expect(body.alert_interval_seconds).toBe(90);
    expect(body.event_rate_per_second).toBe(25);
    // onEnable completes with a status refresh and a final busy-state update. Assert
    // the restored control state so those promise-driven rerenders stay in this test.
    await waitFor(() => expect(enable).toBeEnabled());
  });
});

describe('DemoModeSection enable form copy (Round 14)', () => {
  it('reads without dashes used as punctuation and labels its mode picker in sentence case', () => {
    renderDemo();
    expect(document.body.textContent ?? '').not.toMatch(/[–—]/);
    expect(screen.getByText('Live mode only: how often a new synthetic batch arrives.')).toBeInTheDocument();
    expect(screen.getByText('Deterministic: the same seed reproduces the same data.')).toBeInTheDocument();
    expect(screen.getByText('Mode').className).not.toMatch(/\buppercase\b|\btracking-/);
  });
});
