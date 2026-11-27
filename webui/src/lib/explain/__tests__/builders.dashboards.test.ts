/**
 * Dashboard Explain builders (acceptance package FXD1): every builder prints arithmetic
 * that reproduces the figure the tile shows, exactly.
 *
 * * A relative change chip names both values and says it is relative, not points
 *   (delta-chips-unexplained): 69.64% against 33.33% is +108.9%.
 * * A Human vs AI share uses the card's largest-remainder whole percents
 *   (human-vs-ai-shares): 45 of 62 closed cases is 72.58%, shown 73%.
 * * A spend total is the sum of its model rows (cost-totals-unexplained).
 * * A spend per case is a quotient of two sums (board-figures-unexplained).
 * * A noisy rule's FP rate is a Wilson lower bound, not a ratio (noisy-rules-wilson-unexplained):
 *   30 false positives in 30 graded cases is 88.65%, shown 89%.
 */
import { describe, expect, it } from 'vitest';

import {
  explainChange,
  explainCloseShare,
  explainQuotient,
  explainRowSum,
  explainWilsonLowerBound,
  wholePercentSplit,
} from '../builders';
import { count, plain } from '../rounding';

const rate = {
  words: (n: number) => `${plain(n * 100, 2)}%`,
  term: (n: number) => plain(n * 100, 2),
};

describe('explainChange', () => {
  it('a relative change prints both rates and the division that gives the chip', () => {
    const exp = explainChange({
      metric: 'fp_rate_change',
      title: 'FP rate',
      shown: '+108.9%',
      kind: 'relative',
      now: 0.6964,
      before: 0.3333,
      ...rate,
      window: 'in the last 7 days',
      beforeWindow: 'in the 7 days before',
      ofPercent: true,
      rounding: 'One decimal.',
      source: 'Server comparison',
      provenanceNote: 'Computed by the server.',
    });
    expect(exp?.summary).toBe(
      '69.64% in the last 7 days and 33.33% in the 7 days before. (69.64 - 33.33) / 33.33 x 100 = +108.9%. It is relative to the earlier figure, not a difference in percentage points.',
    );
    expect(exp?.steps.map((s) => s.result)).toEqual(['+36.31', '+108.94%', '+108.9%']);
    expect(exp?.inputs.map((i) => i.value)).toEqual(['69.64%', '33.33%']);
    expect(exp?.caveats[0]).toContain('not +5 points');
    // The printed arithmetic gives the chip.
    expect(((69.64 - 33.33) / 33.33) * 100).toBeCloseTo(108.94, 2);
  });

  it('a count change is a difference in its own unit', () => {
    const exp = explainChange({
      metric: 'cases_change',
      title: 'Cases',
      shown: '+35',
      kind: 'difference',
      now: 56,
      before: 21,
      words: (n) => `${count(n)} cases`,
      term: count,
      window: 'in the last 7 days',
      beforeWindow: 'in the 7 days before',
      rounding: 'Counts are whole numbers.',
      source: 'Server comparison',
      provenanceNote: 'Computed by the server.',
    });
    expect(exp?.summary).toBe('56 cases in the last 7 days and 21 cases in the 7 days before. 56 - 21 = +35.');
    expect(exp?.steps).toEqual([{ label: 'Difference', expression: '56 - 21', result: '+35' }]);
    expect(exp?.value).toBe(35);
  });

  it('a difference the chip writes as a duration names both forms (review fix)', () => {
    const exp = explainChange({
      metric: 'mttr_p50_change',
      title: 'MTTR p50',
      shown: '+1h 5m',
      kind: 'difference',
      now: 70,
      before: 5,
      words: (n) => `${plain(n, 2)} minutes`,
      term: (n) => plain(n, 2),
      unit: ' minutes',
      window: 'in the last 30 days',
      beforeWindow: 'in the 30 days before',
      rounding: 'The chip writes the difference as a duration.',
      source: 'Server comparison',
      provenanceNote: 'Computed by the server.',
    });
    expect(exp?.summary).toBe(
      '70 minutes in the last 30 days and 5 minutes in the 30 days before. 70 - 5 = +65 minutes, shown +1h 5m.',
    );
    expect(exp?.steps.at(-1)).toEqual({ label: 'Shown', expression: '+65 minutes, as the chip writes it', result: '+1h 5m' });
  });

  it('a relative change from zero says there is nothing to divide by', () => {
    const exp = explainChange({
      metric: 'cost_change',
      title: 'Total cost',
      shown: 'new',
      kind: 'relative',
      now: 2,
      before: 0,
      words: (n) => `$${n}`,
      term: String,
      window: 'in the second half',
      beforeWindow: 'in the first half',
      rounding: 'Whole percent.',
      source: 'Hourly spend',
      provenanceNote: 'Computed in the Console.',
    });
    expect(exp?.summary).toContain('There is no earlier figure to divide by');
    expect(exp?.steps).toEqual([]);
  });
});

describe('explainCloseShare', () => {
  const totals = { ai: 45, human: 15, system: 2, closed: 62 };

  it('splits into whole percents that add up to 100, the card rule', () => {
    expect(wholePercentSplit([45, 15, 2], 62)).toEqual([73, 24, 3]);
    expect(wholePercentSplit([1, 1, 1], 3)).toEqual([34, 33, 33]);
    expect(wholePercentSplit([1, 2], 4)).toBeNull();
  });

  it('prints the count over the closed cases and the point the largest fraction took', () => {
    const exp = explainCloseShare(totals, 'ai', 'the last 7 days');
    expect(exp?.display).toBe('73%');
    expect(exp?.summary).toBe('45 closed by the AI agent of 62 closed cases = 72.6%, shown 73%, the last 7 days.');
    expect(exp?.steps.map((s) => `${s.label}: ${s.expression} = ${s.result}`)).toEqual([
      'Share: 45 / 62 x 100 = 72.58%',
      'Rounded down: floor(72.58) + floor(24.19) + floor(3.23) = 72 + 24 + 3 = 99',
      'Points left: 100 - 99, to the largest fractions (closed by the AI agent) = 1',
      'Shown: 72 + 1 = 73%',
    ]);
    expect(exp?.caveats.join(' ')).toContain('A share of decided cases');
  });

  it('a band that took no point reads its rounded-down share', () => {
    const exp = explainCloseShare(totals, 'human', 'the last 7 days');
    expect(exp?.display).toBe('24%');
    expect(exp?.steps.at(-1)).toEqual({ label: 'Shown', expression: '24', result: '24%' });
  });

  it('bands that do not add up to the closed cases have no explanation', () => {
    expect(explainCloseShare({ ...totals, closed: 70 }, 'ai', 'the last 7 days')).toBeNull();
  });
});

describe('explainRowSum', () => {
  const money = (n: number) => `$${plain(n, 6)}`;
  const base = {
    metric: 'cost_total',
    title: 'Total cost',
    rows: [
      { label: 'gpt-5.6-luna', value: 0.100062 },
      { label: 'text-embedding', value: 0.036219 },
    ],
    shown: '$0.1363',
    term: money,
    rowNoun: 'model',
    window: 'last 7 days',
    source: 'Usage summary, by model',
    rounding: 'Amounts under 1 are shown to 4 decimals.',
  };

  it('prints each row and the sum the tile rounds', () => {
    const exp = explainRowSum({ ...base, total: 0.136281 });
    expect(exp?.summary).toBe('$0.1363 = $0.100062 + $0.036219 over 2 models, last 7 days.');
    expect(exp?.steps).toEqual([
      { label: 'Sum', expression: '$0.100062 + $0.036219', result: '$0.136281' },
      { label: 'Shown', expression: '$0.136281, rounded', result: '$0.1363' },
    ]);
  });

  it('a total the rows do not reach says so instead of printing a wrong sum', () => {
    const exp = explainRowSum({ ...base, total: 0.2, shown: '$0.2000' });
    expect(exp?.steps.map((s) => s.label)).toEqual(['Shown']);
    expect(exp?.caveats[0]).toBe('The 2 models listed add up to $0.136281; the total the server returned is $0.2.');
  });

  it('a rounding residue within the tolerance keeps the sum and says why (review fix)', () => {
    const exp = explainRowSum({ ...base, total: 0.136282, tolerance: 1e-6 });
    expect(exp?.summary).toBe('$0.1363 = $0.100062 + $0.036219 over 2 models, last 7 days.');
    expect(exp?.steps).toEqual([
      { label: 'Sum', expression: '$0.100062 + $0.036219', result: '$0.136281' },
      { label: 'Server total', expression: 'the total the server returned', result: '$0.136282' },
      { label: 'Shown', expression: '$0.136282, rounded', result: '$0.1363' },
    ]);
    // Without the tolerance the same residue is a total the rows do not reach.
    expect(explainRowSum({ ...base, total: 0.136282 })?.steps.map((s) => s.label)).toEqual(['Shown']);
  });

  it('a window source and a total already in its shown form (review fix)', () => {
    const exp = explainRowSum({
      ...base,
      rows: [{ label: 'a', value: 24 }, { label: 'b', value: 1 }],
      total: 25,
      shown: '25',
      term: count,
      windowSource: 'The calendar day in UTC',
    });
    expect(exp?.inputs.at(-1)?.source).toBe('The calendar day in UTC');
    // "25, rounded" giving 25 says nothing: no Shown step.
    expect(exp?.steps).toEqual([{ label: 'Sum', expression: '24 + 1', result: '25' }]);
  });
});

describe('explainQuotient', () => {
  it('divides the two sums and rounds to the figure shown', () => {
    const exp = explainQuotient({
      metric: 'spend_per_case',
      title: 'Spend per investigated case',
      numerator: 0.1416,
      denominator: 14,
      numeratorLabel: 'investigation spend',
      denominatorLabel: 'verdicted cases',
      numeratorTerm: (n) => `$${plain(n, 6)}`,
      resultTerm: (n) => `$${plain(n, 6)}`,
      shown: '$0.0101',
      window: 'the last 7 days',
      rounding: 'Amounts under $1 are shown to 4 decimals.',
    });
    expect(exp?.summary).toBe('$0.1416 investigation spend / 14 verdicted cases = $0.0101, the last 7 days.');
    expect(exp?.steps[0]).toEqual({ label: 'Quotient', expression: '$0.1416 / 14', result: '$0.010114' });
  });

  it('no denominator, no quotient', () => {
    const exp = explainQuotient({
      metric: 'q',
      title: 'q',
      numerator: 1,
      denominator: 0,
      numeratorLabel: 'a',
      denominatorLabel: 'b',
      numeratorTerm: String,
      resultTerm: String,
      shown: '1',
      window: 'w',
      rounding: 'r',
    });
    expect(exp).toBeNull();
  });
});

describe('explainWilsonLowerBound', () => {
  const input = {
    metric: 'noisy_rule_fp_rate',
    title: 'FP rate',
    successes: 30,
    n: 30,
    stored: 0.8865,
    shown: '89%',
    successLabel: 'false positives',
    totalLabel: 'graded cases',
  };

  it('30 of 30 is the lower end of the 95% range, 88.65%, shown 89%', () => {
    const exp = explainWilsonLowerBound(input);
    expect(exp?.summary).toBe('89% is the lower end of the 95% range for 30 false positives in 30 graded cases (88.65%).');
    expect(exp?.steps.find((s) => s.label === 'Low')?.result).toBe('0.8865');
    expect(exp?.steps.at(-1)).toEqual({ label: 'Shown', expression: '88.65%, to a whole percent', result: '89%' });
    expect(exp?.caveats[0]).toBe('It is a lower bound, not the observed ratio (30 / 30 = 100%).');
    expect(exp?.inputs.slice(0, 2).map((i) => i.label)).toEqual(['False positives', 'Graded cases']);
  });

  it('a stored bound the counts do not give says so', () => {
    const exp = explainWilsonLowerBound({ ...input, stored: 0.5, shown: '50%' });
    expect(exp?.caveats[1]).toBe('These counts give 88.65%; the stored 50% may come from an earlier evaluation or another confidence level.');
    // The hover line never calls the stored figure the 95% bound of these counts (review fix).
    expect(exp?.summary).toBe(
      '50% is the lower bound the tuner stored (50%). The 95% range for 30 false positives in 30 graded cases starts at 88.65%.',
    );
    expect(exp?.steps.slice(-2)).toEqual([
      { label: 'Stored', expression: 'the lower bound the tuner stored', result: '50%' },
      { label: 'Shown', expression: '50%, to a whole percent', result: '50%' },
    ]);
  });
});
