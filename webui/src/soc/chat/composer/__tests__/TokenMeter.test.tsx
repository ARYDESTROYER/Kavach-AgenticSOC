/**
 * TokenMeter (SPEC §8 item 1; Round 12 diagnosis/layout.md (f2)): the "≈" estimate, the
 * ring as CONTEXT-WINDOW use (never today's spend), the unlimited-mode note ("summarised
 * automatically near the limit … no hard cap"), the daily budget inside the card with an
 * honest D5 note, simulated pricing, the card opening on mouse hover and on click/tap
 * (never by stealing focus), and the compact case form without the ring.
 *
 * Round 13 (SPEC-chat T2, T13): the meter is invisible at rest (empty draft, under half
 * the window) and shown on typing; it reads "≈ 1.2k tokens"; the history row says
 * "none yet" for 0 and never names an exchange cap in unlimited mode. Tests that check
 * the CARD's figures open it with an empty draft, so they find the resting button
 * with `hidden: true` (the card itself is the same either way).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { METER_REST_PERCENT, TokenMeter, historyLabel, meterAtRest } from '../TokenMeter';
import { makeContext } from './fixtures';

const budget = { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' as const };
/** A short draft (2 tokens) that makes the meter visible without moving "≈ 1.2k". */
const DRAFT = 'Show me';
/** The estimate button, at rest or shown. */
const meterButton = (name: string | RegExp = /Estimated next request/) =>
  screen.getByRole('button', { name, hidden: true });

describe('TokenMeter', () => {
  it('opens on mouse hover without taking focus, and closes when the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<TokenMeter context={makeContext()} draft={DRAFT} />);
    const button = screen.getByRole('button', { name: 'Estimated next request: ≈ 1.2k tokens' });
    expect(button).toHaveTextContent('≈ 1.2k tokens');
    await user.hover(button);
    expect(await screen.findByRole('dialog', { name: 'Context and usage' })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(screen.getByRole('dialog'));
    await user.unhover(button);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens on a tap or click and toggles closed on the next one', async () => {
    render(<TokenMeter context={makeContext()} draft={DRAFT} />);
    const button = screen.getByRole('button', { name: /Estimated next request/ });
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Context and usage' })).toBeInTheDocument();
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
    // The ring and the card read the same estimate: 2,420 / 4,000 → 61 %.
    expect(screen.getByRole('meter', { name: 'Context window used' })).toHaveTextContent('61%');
    expect(screen.getByTestId('meter-context')).toHaveTextContent('61% used · ≈ 2.4k of 4k tokens');
  });

  it('clamps the calibration to 0.25–4 and hides the row when uncalibrated', () => {
    const { unmount } = render(<TokenMeter context={makeContext({ calibration: 10 })} draft="" />);
    fireEvent.click(meterButton());
    // 1,000 + 200 at the 4× bound.
    expect(screen.getByText('≈ 4,800')).toBeInTheDocument();
    expect(screen.getByText('×4')).toBeInTheDocument();
    unmount();
    render(<TokenMeter context={makeContext({ calibration: null })} draft="" />);
    fireEvent.click(meterButton());
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
    fireEvent.click(meterButton());
    // 1,200 × $3/M = $0.0036 → "$0.004"; never "$0.0036".
    expect(screen.getByText(/^≈ \$0\.004–\$\d/)).toBeInTheDocument();
    expect(screen.getByText('12.4k tokens · $0.002')).toBeInTheDocument();
    expect(screen.getByText('$4.20 of $10.00')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Daily AI budget' })).toHaveAttribute('aria-valuenow', '42');
  });

  it('marks simulated pricing and spend', () => {
    const context = makeContext({
      rates: { input_per_million: 3, output_per_million: 15 },
      simulated: true,
      budget,
      spent_today: 1,
    });
    render(<TokenMeter context={context} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByText('Projected cost (simulated)')).toBeInTheDocument();
    expect(screen.getByText('Spent today (simulated)')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Daily AI budget' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('(simulated)'),
    );
  });

  it('leaves the ring out of the compact form', () => {
    render(<TokenMeter context={makeContext({ budget, spent_today: 1 })} draft="" showRing={false} />);
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('rings the context window, never the budget, and never rounds a real share down to 0%', () => {
    // 1,200 of 200,000 = 0.6 %: "<1%", not the old "0%" that read as an empty context.
    render(<TokenMeter context={makeContext({ budget, spent_today: 0.004 })} draft={DRAFT} />);
    const ring = screen.getByRole('meter', { name: 'Context window used' });
    expect(ring).toHaveTextContent('<1%');
    expect(ring).toHaveAttribute('aria-valuetext', '<1% of the context window used, about 1.2k of 200k tokens.');
    expect(ring).toHaveAttribute('data-level', 'ok');
    expect(screen.queryByRole('meter', { name: /budget/i })).toBeNull();
  });

  it('turns the ring amber near a full window and hides it when the window is unknown', () => {
    const { unmount } = render(<TokenMeter context={makeContext({ context_window: 1_300 })} draft="" />);
    const ring = screen.getByRole('meter', { name: 'Context window used' });
    expect(ring).toHaveAttribute('data-level', 'high');
    expect(ring).toHaveAttribute('aria-valuetext', expect.stringContaining('Nearly full.'));
    unmount();
    render(<TokenMeter context={makeContext({ context_window: null })} draft="" />);
    expect(screen.queryByRole('meter')).toBeNull();
    fireEvent.click(meterButton());
    expect(screen.queryByTestId('meter-context')).toBeNull();
  });

  it('explains automatic summaries and drops per-question limits in unlimited mode (SPEC D1/D4)', () => {
    render(
      <TokenMeter
        context={makeContext({ limits_mode: 'unlimited', rates: { input_per_million: 3, output_per_million: 15 } })}
        draft={DRAFT}
      />,
    );
    expect(screen.getByRole('meter', { name: 'Context window used' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Older messages are summarised automatically near the limit.'),
    );
    fireEvent.click(meterButton());
    expect(screen.getByTestId('meter-context-note')).toHaveTextContent(
      'Long conversations are summarised automatically near the limit, so the chat keeps going. There is no hard cap.',
    );
    expect(screen.queryByText('Per-question limit')).toBeNull();
    expect(screen.queryByText('Whole question')).toBeNull();
    // One step's input, never a whole-turn range built from caps that do not apply.
    expect(screen.getByText('Cost of the next step')).toBeInTheDocument();
    expect(screen.queryByText('Projected cost')).toBeNull();
  });

  it('keeps the per-question ceiling and the replay note in bounded mode', () => {
    render(<TokenMeter context={makeContext({ limits_mode: 'bounded' })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByText('Per-question limit')).toBeInTheDocument();
    expect(screen.getByText('Whole question')).toBeInTheDocument();
    expect(screen.getByTestId('meter-context-note')).toHaveTextContent('Older exchanges are not sent.');
  });

  it('describes the daily budget honestly: investigations count, chat is not paused (SPEC D5)', () => {
    // Demo / budget disabled: budget_state is always the string 'ok', never a test.
    const { unmount } = render(
      <TokenMeter context={makeContext({ budget: { enabled: false }, budget_state: 'ok', spent_today: null })} draft="" />,
    );
    fireEvent.click(meterButton());
    expect(screen.queryByTestId('meter-budget')).toBeNull();
    unmount();
    // A viewer without models:read sees no budget object, only a non-ok state.
    const second = render(<TokenMeter context={makeContext({ budget: null, budget_state: 'approaching' })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByTestId('meter-budget')).toHaveTextContent(
      "Automatic investigations are near today's AI budget. Chat is not affected.",
    );
    second.unmount();
    const third = render(<TokenMeter context={makeContext({ budget: null, budget_state: 'reached' })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByTestId('meter-budget')).toHaveTextContent("have reached today's AI budget. Chat is not affected.");
    third.unmount();
    render(<TokenMeter context={makeContext({ budget, budget_state: 'ok' })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByTestId('meter-budget')).toHaveTextContent(
      'Automatic investigations count against this budget. Chat is recorded in the cost ledger but is not paused by it.',
    );
    expect(screen.queryByText(/Chat shares this budget/)).toBeNull();
  });

  it('pluralises the history row', () => {
    render(<TokenMeter context={makeContext({ history_exchanges: 1 })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByText('History: last 1 exchange')).toBeInTheDocument();
  });
});

describe('TokenMeter at rest (SPEC-chat T13)', () => {
  it('keeps its slot but is invisible and not focusable until something is typed', () => {
    const { rerender } = render(<TokenMeter context={makeContext()} draft="" />);
    const button = meterButton();
    const frame = button.closest('[data-meter-state]') as HTMLElement;
    expect(frame).toHaveAttribute('data-meter-state', 'rest');
    expect(frame).toHaveClass('invisible');
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByRole('button', { name: /Estimated next request/ })).toBeNull();
    // Whitespace is not a draft.
    rerender(<TokenMeter context={makeContext()} draft="   " />);
    expect(frame).toHaveAttribute('data-meter-state', 'rest');
    rerender(<TokenMeter context={makeContext()} draft={DRAFT} />);
    expect(frame).toHaveAttribute('data-meter-state', 'shown');
    expect(frame).not.toHaveClass('invisible');
    expect(frame).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: 'Estimated next request: ≈ 1.2k tokens' })).not.toHaveAttribute('tabindex');
  });

  it('shows at rest from half the context window, and closes its card when it goes back to rest', async () => {
    // 1,200 of 2,400 = 50 %: shown with nothing typed.
    const { rerender } = render(<TokenMeter context={makeContext({ context_window: 2_400 })} draft="" />);
    expect(meterButton().closest('[data-meter-state]')).toHaveAttribute('data-meter-state', 'shown');
    rerender(<TokenMeter context={makeContext()} draft={DRAFT} />);
    fireEvent.click(meterButton());
    expect(await screen.findByRole('dialog', { name: 'Context and usage' })).toBeInTheDocument();
    // The draft was sent (cleared): the meter rests and its card closes.
    rerender(<TokenMeter context={makeContext()} draft="" />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('decides rest from the draft and the window share alone', () => {
    expect(METER_REST_PERCENT).toBe(50);
    expect(meterAtRest('', 0)).toBe(true);
    expect(meterAtRest('', null)).toBe(true);
    expect(meterAtRest('', 49.9)).toBe(true);
    expect(meterAtRest('', 50)).toBe(false);
    expect(meterAtRest(' x ', 1)).toBe(false);
    expect(meterAtRest('', Number.NaN)).toBe(true);
  });
});

describe('TokenMeter history row (SPEC-chat T2)', () => {
  it('reads "none yet" on a new chat: 0 is a count, never the 12-exchange fallback', () => {
    render(<TokenMeter context={makeContext({ history_exchanges: 0, history_tokens: 0 })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByText('History: none yet')).toBeInTheDocument();
    expect(screen.queryByText(/12 exchanges/)).toBeNull();
  });

  it('counts 3 exchanges, and names no cap in unlimited mode', () => {
    const { unmount } = render(<TokenMeter context={makeContext({ history_exchanges: 3 })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByText('History: last 3 exchanges')).toBeInTheDocument();
    unmount();
    render(<TokenMeter context={makeContext({ history_exchanges: 3, limits_mode: 'unlimited' })} draft="" />);
    fireEvent.click(meterButton());
    expect(screen.getByText('History: 3 exchanges, summarised near the limit')).toBeInTheDocument();
    expect(screen.queryByText(/last 3/)).toBeNull();
  });

  it('names the replayed summary after /compact: 0 exchanges but history tokens above 0', () => {
    // What /chat/context returns right after /compact in unlimited mode: the running
    // summary is replayed and no exchange is replayed verbatim.
    render(
      <TokenMeter
        context={makeContext({ limits_mode: 'unlimited', history_tokens: 812, history_exchanges: 0 })}
        draft="what changed since then?"
      />,
    );
    fireEvent.click(meterButton());
    const label = screen.getByText('History: summary of earlier messages');
    expect(label.nextElementSibling?.textContent ?? '').toMatch(/812/);
    expect(screen.queryByText('History: none yet')).toBeNull();
    expect(historyLabel(0, true, 812)).toBe('History: summary of earlier messages');
    expect(historyLabel(0, true, 0)).toBe('History: none yet');
    expect(historyLabel(0, true, Number.NaN)).toBe('History: none yet');
    expect(historyLabel(3, true, 4_000)).toBe('History: 3 exchanges, summarised near the limit');
  });

  it('formats the row for 0, 1, 3 and many, in both modes', () => {
    expect(historyLabel(0, true)).toBe('History: none yet');
    expect(historyLabel(0, false)).toBe('History: none yet');
    expect(historyLabel(1, true)).toBe('History: 1 exchange, summarised near the limit');
    expect(historyLabel(3, false)).toBe('History: last 3 exchanges');
    expect(historyLabel(1_200, true)).toBe('History: 1,200 exchanges, summarised near the limit');
    expect(historyLabel(Number.NaN, false)).toBe('History: none yet');
  });
});

describe('TokenMeter compact (below 560 px)', () => {
  it('shows only the ring, inside the button that names the estimate', () => {
    render(<TokenMeter context={makeContext({ context_window: 4_000 })} draft={DRAFT} compact />);
    const button = screen.getByRole('button', { name: /^Estimated next request: ≈ 1.2k tokens\. 30% of the context window used/ });
    expect(button).not.toHaveTextContent('tokens');
    expect(button.querySelector('[data-testid="context-ring"]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('falls back to the words without a context window', () => {
    render(<TokenMeter context={makeContext({ context_window: null })} draft={DRAFT} compact />);
    expect(screen.getByRole('button', { name: 'Estimated next request: ≈ 1.2k tokens' })).toHaveTextContent('≈ 1.2k tokens');
  });
});
