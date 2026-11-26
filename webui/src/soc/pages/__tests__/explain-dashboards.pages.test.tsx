/**
 * Page figures explain themselves (acceptance package FXD1), each with arithmetic that
 * gives the figure shown:
 *
 *   - delta-chips-unexplained: a Performance change chip names both rates and the
 *     relative change, "+108.9%" from 69.64% and 33.33%, never percentage points.
 *   - cost-totals-unexplained: Total cost, Tokens and LLM calls are the sums of the model
 *     rows; Today is today's surfaces (UTC day); the change chip is the second half of the
 *     range against the first.
 *   - overview-donut-hover: the donut's hover line adds the severity counts to the centre
 *     number and gives each legend share.
 */
import { describe, expect, it } from 'vitest';

import { compareChipExplanation } from '../Metrics';
import { costTotalExplanations, spendHalves, trendDelta } from '../Cost';
import { snapshotFormula } from '../Overview';

describe('compareChipExplanation', () => {
  it('a rate chip is relative to the earlier rate', () => {
    const exp = compareChipExplanation({ value: 0.6964, prev: 0.3333, delta_pct: 108.9 }, 'FP rate', 'rate', 168);
    expect(exp?.display).toBe('+108.9%');
    expect(exp?.summary).toBe(
      '69.64% in the last 7 days and 33.33% in the 7 days before. (69.64 - 33.33) / 33.33 x 100 = +108.9%. It is relative to the earlier figure, not a difference in percentage points.',
    );
    expect(exp?.metric).toBe('fp_rate_change');
  });

  it('a timing chip is relative to the earlier minutes', () => {
    const exp = compareChipExplanation({ value: 42, prev: 60, delta_pct: -30 }, 'Respond', 'minutes', 24);
    expect(exp?.summary).toBe('42 minutes in the last 24 hours and 60 minutes in the 24 hours before. (42 - 60) / 60 x 100 = -30%.');
  });

  it('no chip, no explanation', () => {
    expect(compareChipExplanation(undefined, 'FP rate', 'rate', 168)).toBeNull();
    expect(compareChipExplanation({ value: 0.5, prev: 0.5, delta_pct: 0 }, 'FP rate', 'rate', 168)).toBeNull();
    expect(compareChipExplanation({ value: 0.5, prev: null, delta_pct: null } as never, 'FP rate', 'rate', 168)).toBeNull();
  });
});

describe('costTotalExplanations', () => {
  const data = {
    total_cost: 0.136281,
    total_tokens: 1500,
    call_count: 3,
    today_cost: 0.05,
    by_model: [
      { key: 'model-a', cost: 0.100062, tokens: 1000, calls: 2 },
      { key: 'model-b', cost: 0.036219, tokens: 500, calls: 1 },
    ],
    today_by_surface: [{ key: 'investigate', cost: 0.05, tokens: 900, calls: 1 }],
  };
  const hourly = [1, 1, 1, 1, 2, 2, 2, 2];
  const lines = costTotalExplanations({ data, currency: 'USD', caption: 'last 7 days', hourly, shownDelta: '+100%' });

  it('the totals are the sums of the model rows', () => {
    expect(lines.total?.summary).toBe('$0.1363 = $0.100062 + $0.036219 over 2 models, last 7 days.');
    expect(lines.tokens?.summary).toBe('1.5K = 1,000 + 500 over 2 models, last 7 days.');
    expect(lines.calls?.summary).toBe('3 = 2 + 1 over 2 models, last 7 days.');
  });

  it('Today is the UTC day by surface, not the range', () => {
    expect(lines.today?.summary).toMatch(/^\$0\.0500 = \$0\.05 over 1 surface, today, from midnight UTC\.$/);
    expect(lines.today?.caveats).toContain('Today is the calendar day in UTC, not the range above.');
  });

  it('the change chip is the second half of the range against the first', () => {
    expect(spendHalves(hourly)).toEqual({ first: 4, second: 8 });
    expect(trendDelta(hourly)).toBe(100);
    expect(lines.change?.summary).toBe('$8.00 in the second half of the last 7 days and $4.00 in the first half. (8 - 4) / 4 x 100 = +100%.');
  });

  it('no data, no totals', () => {
    const none = costTotalExplanations({ data: null, caption: 'today' });
    expect(none).toEqual({ total: null, tokens: null, calls: null, today: null, change: null });
  });
});

describe('snapshotFormula', () => {
  it('adds the severity counts to the centre number and gives each legend share', () => {
    expect(snapshotFormula({ critical: 4, high: 1, medium: 0, low: 0, info: 0 }, 5, 'cases from this window still open')).toBe(
      '4 critical + 1 high = 5 cases from this window still open. 4 / 5 = 80%, 1 / 5 = 20%, as whole percents.',
    );
    expect(snapshotFormula({ critical: 0, high: 0, medium: 0, low: 0, info: 0 }, 0, 'cases')).toBeNull();
  });
});
