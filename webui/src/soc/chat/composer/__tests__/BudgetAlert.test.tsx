/**
 * BudgetAlert (SPEC §8, §10.3, §10.9): at most one alert above the composer for
 * approaching / reached, window-neutral honest copy per `on_exceed`, today's numbers only
 * when the context carries them and they explain the state, dismissible only while AI
 * answers still run, never a live
 * region, and one announcement per threshold crossing through the shell announcer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import { budgetAlertCopy, BudgetAlert } from '../BudgetAlert';
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

  it('words each state honestly', () => {
    const approaching = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 8.5 }));
    expect(approaching).toMatchObject({ tone: 'warning', dismissible: true, title: 'The AI budget is nearly used.' });
    // The figures are today's (the ring's); the title never names the window.
    expect(approaching?.body).toContain('Today: $8.50 of $10.00 used.');

    // Blocking: AI answers pause, product questions still get the $0 Help Center answer.
    // Short: no administrator or investigations note (that lives in the meter's hover card).
    const blocked = budgetAlertCopy(makeContext({ budget_state: 'reached', budget }));
    expect(blocked).toMatchObject({ tone: 'critical', dismissible: false, title: 'The AI budget is used up.' });
    expect(blocked?.body).toBe(
      'AI answers are paused until the budget resets. Questions about this app are still answered from the Help Center at no cost.',
    );
    const blockedToday = budgetAlertCopy(makeContext({ budget_state: 'reached', budget, spent_today: 10.25 }));
    expect(blockedToday?.body).toBe(
      'Today: $10.25 of $10.00 used. AI answers are paused until the budget resets. Questions about this app are still answered from the Help Center at no cost.',
    );

    const warnOnly = budgetAlertCopy(makeContext({ budget_state: 'reached', budget: { ...budget, on_exceed: 'warn' } }));
    expect(warnOnly).toMatchObject({ tone: 'warning', dismissible: true });
    expect(warnOnly?.body).toContain('warn only');

    // Without models:read the policy is unknown: no numbers, "may", the same Help Center promise.
    const unknown = budgetAlertCopy(makeContext({ budget_state: 'reached', budget: null }));
    expect(unknown).toMatchObject({ tone: 'critical', dismissible: false });
    expect(unknown?.body).toBe(
      'AI answers may be paused until the budget resets. Questions about this app are still answered from the Help Center at no cost.',
    );
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
    expect(monthlyWarnOnly?.body).toBe('Questions still run because the budget is set to warn only.');
    // Approaching on the monthly window: today at 30% does not explain it.
    const monthlyApproaching = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 3 }));
    expect(monthlyApproaching?.body).toBe('Chat shares this budget with automatic investigations.');
    // At the soft-warn share exactly, today's figures do explain it.
    const dailyApproaching = budgetAlertCopy(makeContext({ budget_state: 'approaching', budget, spent_today: 8 }));
    expect(dailyApproaching?.body).toBe('Today: $8.00 of $10.00 used. Chat shares this budget with automatic investigations.');
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

  it('dismisses an approaching notice but never a blocking one', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<BudgetAlert context={makeContext({ budget_state: 'approaching', budget })} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss budget notice' }));
    expect(screen.queryByText(/nearly used/)).toBeNull();
    rerender(<BudgetAlert context={makeContext({ budget_state: 'reached', budget })} />);
    expect(screen.getByText('The AI budget is used up.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss budget notice' })).toBeNull();
  });
});
