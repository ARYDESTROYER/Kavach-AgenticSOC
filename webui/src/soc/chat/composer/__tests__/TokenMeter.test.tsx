/**
 * TokenMeter (SPEC §8 item 1): the "≈" estimate, the context-window share shown from
 * 50 %, simulated pricing, the card opening on mouse hover and on click/tap (never by
 * stealing focus), and the compact case form without the ring.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TokenMeter } from '../TokenMeter';
import { makeContext } from './fixtures';

const budget = { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' as const };

describe('TokenMeter', () => {
  it('opens on mouse hover without taking focus, and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<TokenMeter context={makeContext()} draft="" />);
    const button = screen.getByRole('button', { name: 'Estimated next request: ≈ 1.2k tokens' });
    await user.hover(button);
    expect(await screen.findByRole('dialog', { name: 'Token estimate' })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(screen.getByRole('dialog'));
    await user.unhover(button);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens on a tap or click and toggles closed on the next one', async () => {
    render(<TokenMeter context={makeContext()} draft="" />);
    const button = screen.getByRole('button', { name: /Estimated next request/ });
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Token estimate' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('applies the calibration to system, history and draft, and says so (SPEC §8)', () => {
    // The server's calibration is actual ÷ estimate of the WHOLE first prompt, and its
    // system/history figures are plain chars ÷ 4: × 2 → 2,000 + 400 + ceil(40 ÷ 4 × 2)
    // = 2,420 (the draft-only reading would have shown 1,220).
    render(<TokenMeter context={makeContext({ calibration: 2, context_window: 4_000 })} draft={'y'.repeat(40)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Estimated next request: ≈ 2.4k tokens' }));
    expect(screen.getByText('≈ 2,420')).toBeInTheDocument();
    expect(screen.getByText('2,000')).toBeInTheDocument();
    expect(screen.getByText('400')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('Calibrated to this conversation')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
    // N / W is shown from 50 %: 2,420 / 4,000 → 61 %.
    expect(screen.getByText('61% of 4k')).toBeInTheDocument();
  });

  it('clamps the calibration to 0.25–4 and hides the row when uncalibrated', () => {
    const { unmount } = render(<TokenMeter context={makeContext({ calibration: 10 })} draft="" />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    // 1,000 + 200 at the 4× bound.
    expect(screen.getByText('≈ 4,800')).toBeInTheDocument();
    expect(screen.getByText('×4')).toBeInTheDocument();
    unmount();
    render(<TokenMeter context={makeContext({ calibration: null })} draft="" />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(screen.getByText('≈ 1,200')).toBeInTheDocument();
    expect(screen.queryByText('Calibrated to this conversation')).toBeNull();
  });

  it('prices the turn in the transcript grammar and the budget in two decimals', () => {
    const context = makeContext({
      rates: { input_per_million: 3, output_per_million: 15 },
      budget,
      spent_today: 4.2,
      simulated: false,
    });
    render(<TokenMeter context={context} draft="" conversationTotals={{ tokens: 12_400, cost: 0.002 }} />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    // 1,200 × $3/M = $0.0036 → "$0.004"; never "$0.0036".
    expect(screen.getByText(/^≈ \$0\.004–\$\d/)).toBeInTheDocument();
    expect(screen.getByText('12.4k tokens · $0.002')).toBeInTheDocument();
    expect(screen.getByText('$4.20 of $10.00')).toBeInTheDocument();
  });

  it('marks simulated pricing and spend', () => {
    const context = makeContext({
      rates: { input_per_million: 3, output_per_million: 15 },
      simulated: true,
      budget,
      spent_today: 1,
    });
    render(<TokenMeter context={context} draft="" />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(screen.getByText('Projected cost (simulated)')).toBeInTheDocument();
    expect(screen.getByText("Today's AI spend (simulated)")).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', expect.stringContaining('(simulated)'));
  });

  it('leaves the ring out of the compact form', () => {
    render(<TokenMeter context={makeContext({ budget, spent_today: 1 })} draft="" showRing={false} />);
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('mentions the shared budget only when one is in force', () => {
    // Demo / budget disabled: budget_state is always the string 'ok', never a test.
    const { unmount } = render(
      <TokenMeter context={makeContext({ budget: { enabled: false }, budget_state: 'ok', spent_today: null })} draft="" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(screen.queryByText(/Chat shares this budget/)).toBeNull();
    unmount();
    // A viewer without models:read sees no budget object, only a non-ok state.
    const second = render(<TokenMeter context={makeContext({ budget: null, budget_state: 'approaching' })} draft="" />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(screen.getByText(/Chat shares this budget/)).toBeInTheDocument();
    second.unmount();
    render(<TokenMeter context={makeContext({ budget, budget_state: 'ok' })} draft="" />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(screen.getByText(/Chat shares this budget/)).toBeInTheDocument();
  });

  it('pluralises the history row', () => {
    render(<TokenMeter context={makeContext({ history_exchanges: 1 })} draft="" />);
    fireEvent.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(screen.getByText('History · last 1 exchange')).toBeInTheDocument();
  });
});
