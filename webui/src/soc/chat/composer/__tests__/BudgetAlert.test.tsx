/**
 * BudgetAlert (SPEC §8, §10.3, §10.9; Round 12 SPEC D5): at most one notice above the
 * composer for approaching / reached, window-neutral copy per `on_exceed` that says what
 * happens to AUTOMATIC INVESTIGATIONS and that chat keeps answering (the daily AI budget
 * never limits chat), today's numbers only when the context carries them and they explain
 * the state, always a dismissible warning, never a live region, and one announcement per
 * threshold crossing through the shell announcer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { budgetAlertCopy, BudgetAlert, CHAT_KEEPS_ANSWERING } from '../BudgetAlert';
import { makeContext } from './fixtures';

expect.extend(toHaveNoViolations);

const announce = vi.fn();
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

afterEach(() => announce.mockReset());

const budget = { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' as const };

describe('budgetAlertCopy', () => {
  it('is null when the budget is fine or unknown', () => {
    expect(budgetAlertCopy(null)).toBeNull();
    expect(budgetAlertCopy(makeContext({ budget_state: 'ok' }))).toBeNull();
    expect(budgetAlertCopy(makeContext({ budget_state: null }))).toBeNull();
  });

  it('words each state honestly: the budget limits investigations, never chat (SPEC D5)', () => {
    const approaching = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 8.5 }));
    expect(approaching).toMatchObject({ tone: 'warning', dismissible: true, title: 'The AI budget is nearly used.' });
    // The figures are today's (the meter's); the title never names the window.
    expect(approaching?.body).toBe(`Today: $8.50 of $10.00 used. It limits automatic investigations, not chat. ${CHAT_KEEPS_ANSWERING}`);

    // Blocking: investigations pause (an over-budget investigation routes to a human);
    // chat is not paused, so the notice is a dismissible warning, not a stop sign.
    const blocked = budgetAlertCopy(makeContext({ budget_state: 'reached', budget }));
    expect(blocked).toMatchObject({ tone: 'warning', dismissible: true, title: 'The AI budget is used up.' });
    expect(blocked?.body).toBe(
      'Automatic investigations are paused until it resets, so new cases wait for an analyst. Chat keeps answering; its spend is still recorded.',
    );
    const blockedToday = budgetAlertCopy(makeContext({ budget_state: 'reached', budget, spent_today: 10.25 }));
    expect(blockedToday?.body).toBe(
      'Today: $10.25 of $10.00 used. Automatic investigations are paused until it resets, so new cases wait for an analyst. Chat keeps answering; its spend is still recorded.',
    );

    const warnOnly = budgetAlertCopy(makeContext({ budget_state: 'reached', budget: { ...budget, on_exceed: 'warn' } }));
    expect(warnOnly).toMatchObject({ tone: 'warning', dismissible: true });
    expect(warnOnly?.body).toBe(`Automatic investigations still run because the budget is set to warn only. ${CHAT_KEEPS_ANSWERING}`);

    // Without models:read the policy is unknown: no numbers, "may".
    const unknown = budgetAlertCopy(makeContext({ budget_state: 'reached', budget: null }));
    expect(unknown).toMatchObject({ tone: 'warning', dismissible: true });
    expect(unknown?.body).toBe(`Automatic investigations may be paused until it resets. ${CHAT_KEEPS_ANSWERING}`);
  });

  it('never says chat or AI answers are paused, and never claims chat shares the budget', () => {
    const states = [
      makeContext({ budget_state: 'approaching', budget, spent_today: 8.5 }),
      makeContext({ budget_state: 'reached', budget, spent_today: 10 }),
      makeContext({ budget_state: 'reached', budget: { ...budget, on_exceed: 'warn' } }),
      makeContext({ budget_state: 'reached', budget: null }),
    ];
    for (const context of states) {
      const copy = budgetAlertCopy(context);
      const text = `${copy?.title} ${copy?.body}`;
      expect(text).not.toMatch(/AI answers (are|may be) paused|chat (is|may be) paused|shares this budget|Help Center/i);
      expect(text).toContain(CHAT_KEEPS_ANSWERING);
      expect(copy?.tone).toBe('warning');
      expect(copy?.dismissible).toBe(true);
    }
  });

  it('shows today\'s figures only when they explain the state (the monthly limit may be the one hit)', () => {
    // Reached on the monthly window while today's spend is low: no contradictory figures.
    const monthlyReached = budgetAlertCopy(makeContext({ budget_state: 'reached', budget, spent_today: 2 }));
    expect(monthlyReached?.title).toBe('The AI budget is used up.');
    expect(monthlyReached?.body).not.toContain('Today:');
    expect(monthlyReached?.body).not.toContain('$2.00');
    const monthlyWarnOnly = budgetAlertCopy(
      makeContext({ budget_state: 'reached', budget: { ...budget, on_exceed: 'warn' }, spent_today: 2 }),
    );
    expect(monthlyWarnOnly?.body).toBe(`Automatic investigations still run because the budget is set to warn only. ${CHAT_KEEPS_ANSWERING}`);
    // Approaching on the monthly window: today at 30% does not explain it.
    const monthlyApproaching = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 3 }));
    expect(monthlyApproaching?.body).toBe(`It limits automatic investigations, not chat. ${CHAT_KEEPS_ANSWERING}`);
    // At the soft-warn share exactly, today's figures do explain it.
    const dailyApproaching = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 8 }));
    expect(dailyApproaching?.body).toBe(`Today: $8.00 of $10.00 used. It limits automatic investigations, not chat. ${CHAT_KEEPS_ANSWERING}`);
  });

  it('never names a daily or monthly window in its wording', () => {
    const states = [
      makeContext({ budget_state: 'approaching', budget, spent_today: 8.5 }),
      makeContext({ budget_state: 'reached', budget, spent_today: 10 }),
      makeContext({ budget_state: 'reached', budget: { ...budget, on_exceed: 'warn' } }),
      makeContext({ budget_state: 'reached', budget: null }),
    ];
    for (const context of states) {
      const copy = budgetAlertCopy(context);
      expect(copy?.title).not.toMatch(/today|daily|month/i);
      expect(copy?.body.replace(/Today: \$[\d.]+ of \$[\d.]+ used\./, '')).not.toMatch(/today|daily|month/i);
    }
  });

  it('marks simulated (Demo) spend', () => {
    const copy = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 9, simulated: true }));
    expect(copy?.body).toContain('(simulated)');
  });
});

describe('BudgetAlert', () => {
  it('renders nothing when there is no alert', () => {
    const { container } = render(<BudgetAlert context={makeContext()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is not a live region and announces each threshold once', async () => {
    const { rerender, container } = render(
      <BudgetAlert context={makeContext({ budget_state: 'approaching', budget, spent_today: 8 })} />,
    );
    expect(screen.getByText('The AI budget is nearly used.')).toBeInTheDocument();
    expect(container.querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull();
    expect(announce).toHaveBeenCalledTimes(1);
    rerender(<BudgetAlert context={makeContext({ budget_state: 'approaching', budget, spent_today: 8.2 })} />);
    expect(announce).toHaveBeenCalledTimes(1);
    rerender(<BudgetAlert context={makeContext({ budget_state: 'reached', budget, spent_today: 10 })} />);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce.mock.calls[1][0]).toContain('The AI budget is used up.');
    rerender(<BudgetAlert context={makeContext({ budget_state: 'ok', budget, spent_today: 0 })} />);
    rerender(<BudgetAlert context={makeContext({ budget_state: 'approaching', budget, spent_today: 8 })} />);
    expect(announce).toHaveBeenCalledTimes(3);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('dismisses each notice, and a new state brings it back (chat is never blocked, so nothing is pinned)', async () => {
    const user = userEvent.setup();
    const { rerender, container } = render(<BudgetAlert context={makeContext({ budget_state: 'approaching', budget })} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss budget notice' }));
    expect(screen.queryByText(/nearly used/)).toBeNull();
    rerender(<BudgetAlert context={makeContext({ budget_state: 'reached', budget })} />);
    expect(screen.getByText('The AI budget is used up.')).toBeInTheDocument();
    // A warning, not a critical stop sign.
    expect(container.firstElementChild).toHaveClass('text-warning-text');
    expect(container.firstElementChild?.className).not.toContain('critical');
    await user.click(screen.getByRole('button', { name: 'Dismiss budget notice' }));
    expect(screen.queryByText('The AI budget is used up.')).toBeNull();
  });
});
