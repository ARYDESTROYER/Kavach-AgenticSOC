/**
 * Composer display helpers (SPEC §8, §10.4): the compact token grammar, time presets,
 * source labels, the budget meter value and its spoken text, the block reason and the
 * projected cost range.
 */
import { describe, expect, it } from 'vitest';
import type { SourceInstance } from '@/lib/types';
import {
  budgetMeterValue,
  budgetValueText,
  calibratedNextRequest,
  calibrationFactor,
  formatFactor,
  formatMoney,
  formatTokenCount,
  formatTurnCost,
  isAllTimeRange,
  isQueryableSource,
  presetForRange,
  projectedCostRange,
  sourceChipLabel,
  withClientHistory,
  TIME_PRESETS,
  timeRangeHint,
  timeRangeLongLabel,
  timeRangeShortLabel,
} from '../format';
import { compactTokens, formatCost } from '../../message/format';
import { makeContext } from './fixtures';

const src = (over: Partial<SourceInstance>): SourceInstance => ({ id: 's1', source_type: 'wazuh', ...over });

describe('formatTokenCount', () => {
  it('uses the SPEC §8 grammar: 820, 1.2k, 12.4k, 184k, 1.3M', () => {
    expect(formatTokenCount(820)).toBe('820');
    expect(formatTokenCount(1_000)).toBe('1k');
    expect(formatTokenCount(1_234)).toBe('1.2k');
    expect(formatTokenCount(12_400)).toBe('12.4k');
    expect(formatTokenCount(184_000)).toBe('184k');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
  });
  it('is the transcript formatter, so the meter and the toolbar agree', () => {
    for (const n of [0, 999, 12_400, 99_999, 184_321, 2_000_000]) expect(formatTokenCount(n)).toBe(compactTokens(n));
  });
  it('never prints NaN or a negative', () => {
    expect(formatTokenCount(Number.NaN)).toBe('—');
    expect(formatTokenCount(-5)).toBe('—');
    expect(formatTokenCount(null)).toBe('—');
  });
});

describe('money', () => {
  it('formats per-turn amounts like the run log: $0.03, $0.002', () => {
    expect(formatTurnCost(0.03)).toBe('$0.03');
    expect(formatTurnCost(0.002)).toBe('$0.002');
    for (const v of [0, 0.0004, 0.0042, 0.03, 1.2]) expect(formatTurnCost(v)).toBe(formatCost(v));
  });
  it('formats budget amounts with two decimals, never a non-zero spend as $0.00', () => {
    expect(formatMoney(4.2)).toBe('$4.20');
    expect(formatMoney(0.42)).toBe('$0.42');
    expect(formatMoney(10)).toBe('$10.00');
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(0.004)).toBe('$0.004');
    expect(formatMoney(null)).toBe('—');
  });
});

describe('calibratedNextRequest', () => {
  it('multiplies system, history and draft by the calibration', () => {
    const ctx = makeContext({ static_prompt_tokens: 3_000, history_tokens: 2_000, calibration: 1.5 });
    const est = calibratedNextRequest(ctx, '');
    expect(est).toEqual({ system: 4_500, history: 3_000, draft: 0, total: 7_500, factor: 1.5 });
    expect(calibratedNextRequest(ctx, 'x'.repeat(40)).draft).toBe(15);
  });
  it('clamps to the server bounds and ignores junk', () => {
    expect(calibrationFactor(10)).toBe(4);
    expect(calibrationFactor(0.1)).toBe(0.25);
    expect(calibrationFactor(null)).toBe(1);
    expect(calibrationFactor(Number.NaN)).toBe(1);
    expect(calibrationFactor(-2)).toBe(1);
    const est = calibratedNextRequest(makeContext({ static_prompt_tokens: Number.NaN, chars_per_token: 0 }), 'abcd');
    expect(est.system).toBe(0);
    expect(est.draft).toBe(1);
  });
  it('labels the factor', () => {
    expect(formatFactor(1.5)).toBe('×1.5');
    expect(formatFactor(2)).toBe('×2');
    expect(formatFactor(1.25)).toBe('×1.25');
  });
});

describe('time range presets', () => {
  it('reads null and now-24h as the default 24h', () => {
    expect(presetForRange(null)?.id).toBe('24h');
    expect(presetForRange({ from: 'now-24h', to: 'now' })?.id).toBe('24h');
    expect(timeRangeShortLabel(null)).toBe('24h');
    expect(timeRangeLongLabel(null)).toBe('Last 24 hours');
  });
  it('maps the presets and labels anything else honestly', () => {
    expect(timeRangeShortLabel({ from: 'now-7d' })).toBe('7d');
    expect(timeRangeShortLabel({ from: 'now-90d', to: 'now' })).toBe('90d');
    expect(presetForRange({ from: 'now-7d', to: 'now-1d' })).toBeNull();
    expect(timeRangeShortLabel({ from: '2026-01-01T00:00:00Z', to: 'now-1d' })).toContain('→');
  });
  it('goes from the last hour to all time, with calendar months and no span limit (Round 12, SPEC D7)', () => {
    expect(TIME_PRESETS.map((p) => [p.id, p.range?.from ?? null])).toEqual([
      ['1h', 'now-1h'],
      ['24h', null],
      ['7d', 'now-7d'],
      ['30d', 'now-30d'],
      ['90d', 'now-90d'],
      ['6mo', 'now-6M'],
      ['12mo', 'now-12M'],
      ['all', 'all'],
    ]);
    expect(timeRangeShortLabel({ from: 'now-6M' })).toBe('6mo');
    expect(timeRangeLongLabel({ from: 'now-12M', to: 'now' })).toBe('Last 12 months');
    expect(presetForRange({ from: 'now-1y' })?.id).toBe('12mo');
    expect(presetForRange({ from: 'NOW-1Y', to: 'NOW' })?.id).toBe('12mo');
    // A lower-case m is minutes, never months.
    expect(presetForRange({ from: 'now-6m' })).toBeNull();
    expect(timeRangeShortLabel({ from: 'all' })).toBe('All time');
    expect(timeRangeLongLabel({ from: 'all', to: 'now' })).toBe('All time');
    for (const spelling of ['all', 'ALL', 'all_time', 'all time', 'lifetime']) {
      expect(isAllTimeRange({ from: spelling })).toBe(true);
      expect(presetForRange({ from: spelling })?.id).toBe('all');
    }
    expect(isAllTimeRange(null)).toBe(false);
    expect(isAllTimeRange({ from: 'now-90d' })).toBe(false);
    // All time up to a fixed end is no preset, and says so.
    expect(presetForRange({ from: 'all', to: '2026-01-01T00:00:00Z' })).toBeNull();
    expect(timeRangeLongLabel({ from: 'all', to: '2026-01-01T00:00:00Z' })).toBe('All time to 2026-01-01T00:00:00Z');
  });
  it('says what the default really covers and that a chosen range is an outer limit, except all time', () => {
    // The default chip sets no outer limit: each lookup keeps its own default window.
    expect(timeRangeHint(null)).toBe(
      'No outer limit. Without a window in your question, case counts and searches cover all time, ' +
        'and log, metric, cost and audit lookups the last 24 hours.',
    );
    expect(timeRangeHint(null)).not.toMatch(/Last 24 hours, unless/);
    expect(timeRangeHint({ from: 'now-24h' })).toBe(
      'Last 24 hours. Lookups without a window in your question use this range. Questions can narrow it, not widen it.',
    );
    expect(timeRangeHint({ from: 'now-6M' })).toMatch(/^Last 6 months\. .*Questions can narrow it, not widen it\.$/);
    // All time never clamps.
    expect(timeRangeHint({ from: 'all' })).toBe(
      'All time. Lookups without a window in your question cover all time, and a question can still name a shorter window.',
    );
    expect(timeRangeHint({ from: 'all', to: '2026-01-01T00:00:00Z' })).toMatch(
      /^All time to 2026-01-01T00:00:00Z\. .*not widen it\.$/,
    );
  });
});

describe('sources', () => {
  it('trusts can_browse and falls back to the pull/demo rule on older servers', () => {
    expect(isQueryableSource(src({ can_browse: true, ingest_mode: 'push' }))).toBe(true);
    expect(isQueryableSource(src({ can_browse: false, ingest_mode: 'pull' }))).toBe(false);
    expect(isQueryableSource(src({ ingest_mode: 'pull' }))).toBe(true);
    expect(isQueryableSource(src({ ingest_mode: 'push' }))).toBe(false);
    expect(isQueryableSource(src({ enabled: false, can_browse: true }))).toBe(false);
  });
  it('names the chip: All sources, the only source, or the selected one', () => {
    const wazuh = src({ id: 'w', display_name: 'Wazuh', can_browse: true });
    const elastic = src({ id: 'e', display_name: 'Elastic prod', can_browse: true });
    expect(sourceChipLabel(null, [wazuh, elastic])).toBe('All sources');
    expect(sourceChipLabel(null, [wazuh])).toBe('Wazuh');
    expect(sourceChipLabel('e', [wazuh, elastic])).toBe('Elastic prod');
    expect(sourceChipLabel('gone', [wazuh])).toBe('gone');
  });
  it('strips invisible characters from operator-configured names (#9)', () => {
    expect(sourceChipLabel('x', [src({ id: 'x', display_name: 'Wa​zuh‮' })])).toBe('Wazuh');
  });
});

describe('budget meter', () => {
  const budget = { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' as const };

  it('is hidden without an enabled budget or a spend figure', () => {
    expect(budgetMeterValue(makeContext())).toBeNull();
    expect(budgetMeterValue(makeContext({ budget, spent_today: null }))).toBeNull();
    expect(budgetMeterValue(makeContext({ budget: { ...budget, enabled: false }, spent_today: 1 }))).toBeNull();
    expect(budgetMeterValue(makeContext({ budget: { ...budget, daily_limit: 0 }, spent_today: 1 }))).toBeNull();
  });

  it('warns at soft_warn_pct and is critical at 100 %', () => {
    expect(budgetMeterValue(makeContext({ budget, spent_today: 4.2 }))?.level).toBe('ok');
    expect(budgetMeterValue(makeContext({ budget, spent_today: 8 }))?.level).toBe('warn');
    expect(budgetMeterValue(makeContext({ budget, spent_today: 12 }))?.level).toBe('critical');
    // The server's state wins when it is worse.
    expect(budgetMeterValue(makeContext({ budget, spent_today: 1, budget_state: 'reached' }))?.level).toBe('critical');
  });

  it('speaks the numbers', () => {
    const value = budgetMeterValue(makeContext({ budget, spent_today: 4.2 }));
    expect(value && budgetValueText(value)).toBe("42% of today's AI budget used, $4.20 of $10.00");
    const sim = budgetMeterValue(makeContext({ budget, spent_today: 4.2, simulated: true }));
    expect(sim && budgetValueText(sim)).toMatch(/\(simulated\)$/);
  });

});

describe('projectedCostRange', () => {
  it('needs rates and prices the final reserve as output', () => {
    expect(projectedCostRange(makeContext(), 1000, 5000)).toBeNull();
    const ctx = makeContext({ rates: { input_per_million: 3, output_per_million: 15 } });
    const range = projectedCostRange(ctx, 1000, 10_000);
    expect(range?.low).toBeCloseTo(0.003, 6);
    // (10 000 − 4 000) × 3e-6 + 4 000 × 15e-6
    expect(range?.high).toBeCloseTo(0.018 + 0.06, 6);
  });
});

describe('withClientHistory', () => {
  it('replaces the context history with the engine-held history (chars ÷ chars_per_token)', () => {
    const base = makeContext({ history_tokens: 0, history_exchanges: 0 });
    expect(withClientHistory(base, { exchanges: 0, chars: 0 })).toBe(base);
    expect(withClientHistory(base, { exchanges: 3, chars: 1_001 })).toMatchObject({ history_tokens: 250, history_exchanges: 3 });
    expect(withClientHistory(base, { exchanges: 1, chars: 2 })).toMatchObject({ history_tokens: 1, history_exchanges: 1 });
  });
});

