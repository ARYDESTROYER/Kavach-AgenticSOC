/**
 * BudgetCard — Round-6 ceiling-input fixes.
 *
 *   - parseCeiling: empty → null ("no limit"), finite ≥0 → the number, garbage/negative
 *     keeps the previous value.
 *   - The daily/monthly ceiling fields keep the RAW text while typing so intermediate
 *     decimal states ("10.", "10.50") survive, and commit a parsed number on blur — a
 *     plain <Input type="number"> bound to the parsed value stripped a trailing dot/zero
 *     and made decimals unenterable.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/soc/pages/Models.api', () => ({
  modelsApi: {
    getBudget: vi.fn(),
    budgetStatus: vi.fn(),
    putBudget: vi.fn(),
  },
}));

import { BudgetCard, parseCeiling, SPEND_WITHHELD } from '../BudgetCard';
import { modelsApi } from '@/soc/pages/Models.api';

describe('parseCeiling', () => {
  it('maps empty / whitespace to null (no limit)', () => {
    expect(parseCeiling('', 5)).toBeNull();
    expect(parseCeiling('   ', 5)).toBeNull();
  });

  it('parses a finite non-negative number', () => {
    expect(parseCeiling('10.5', null)).toBe(10.5);
    expect(parseCeiling('0', 5)).toBe(0);
  });

  it('keeps the previous value for garbage or negative input', () => {
    expect(parseCeiling('abc', 5)).toBe(5);
    expect(parseCeiling('-3', 5)).toBe(5);
    expect(parseCeiling('abc', null)).toBeNull();
  });
});

describe('BudgetCard ceiling input', () => {
  beforeEach(() => {
    (modelsApi.getBudget as Mock).mockResolvedValue({
      budget: {
        enabled: true,
        daily_usd: 5,
        monthly_usd: null,
        soft_warn_pct: 0.8,
        on_exceed: 'warn',
      },
    });
    // budgetStatus rejects here → BudgetCard swallows it (no live-spend section).
    (modelsApi.budgetStatus as Mock).mockRejectedValue(new Error('no status'));
  });

  it('preserves raw decimal text while typing and commits a number on blur', async () => {
    render(<BudgetCard />);
    const input = (await screen.findByLabelText('Daily ceiling (USD)')) as HTMLInputElement;

    // A trailing zero survives while typing (the old number-bound input collapsed it).
    fireEvent.change(input, { target: { value: '10.50' } });
    expect(input.value).toBe('10.50');

    // A lone trailing dot is enterable too.
    fireEvent.change(input, { target: { value: '10.' } });
    expect(input.value).toBe('10.');

    // On blur the raw text is parsed + normalised to the committed number.
    fireEvent.change(input, { target: { value: '10.50' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('10.5'));
  });
});

describe('BudgetCard live spend without cost:view (Round 14 second acceptance pass, roles-11)', () => {
  const budget = { enabled: true, daily_usd: 10, monthly_usd: 200, soft_warn_pct: 0.8, on_exceed: 'warn' };
  const status = (spent: number | null, band: string | null) => ({
    enabled: true,
    on_exceed: 'warn',
    soft_warn_pct: 0.8,
    currency: 'USD',
    daily: { spent, cap: 10, fraction: spent == null ? null : spent / 10, band },
    monthly: { spent, cap: 200, fraction: spent == null ? null : spent / 200, band },
  });

  beforeEach(() => {
    (modelsApi.getBudget as Mock).mockResolvedValue({ budget });
  });

  it('says the spend is withheld and shows no band when the server leaves it out', async () => {
    (modelsApi.budgetStatus as Mock).mockResolvedValue(status(null, null));
    render(<BudgetCard canManage={false} />);
    expect(await screen.findAllByText(SPEND_WITHHELD)).toHaveLength(2);
    expect(screen.getByText('Ceiling $10.00')).toBeInTheDocument();
    expect(screen.getByText('Ceiling $200.00')).toBeInTheDocument();
    // A withheld band never reads OK, and no gauge stands for a fraction nobody sent.
    expect(screen.queryByText('OK')).toBeNull();
    expect(screen.queryByRole('img', { name: /of ceiling/ })).toBeNull();
  });

  it('still shows the spend, band and gauge to a cost:view holder', async () => {
    (modelsApi.budgetStatus as Mock).mockResolvedValue(status(2.5, 'ok'));
    render(<BudgetCard canManage={false} />);
    expect(await screen.findAllByText('OK')).toHaveLength(2);
    expect(screen.queryByText(SPEND_WITHHELD)).toBeNull();
    expect(screen.getByRole('img', { name: 'Today 25% of ceiling' })).toBeInTheDocument();
  });
});
