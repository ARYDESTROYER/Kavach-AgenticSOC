/**
 * Composer display helpers (SPEC §8, §10.4): the compact token grammar, time presets,
 * source labels, the budget meter value and its spoken text, the block reason and the
 * projected cost range.
 */
import { describe, expect, it } from 'vitest';
import type { SourceInstance } from '@/lib/types';
import {
  budgetMeterValue,
  budgetSendBlockReason,
  budgetValueText,
  calibratedNextRequest,
  calibrationFactor,
  formatFactor,
  formatMoney,
  formatTokenCount,
  formatTurnCost,
  isQueryableSource,
  presetForRange,
  projectedCostRange,
  sourceChipLabel,
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

  it('blocks Send only when reached AND on_exceed is block', () => {
    expect(budgetSendBlockReason(makeContext({ budget_state: 'reached', budget }))).toBe(
      "Today's AI budget is used up.",
    );
    expect(budgetSendBlockReason(makeContext({ budget_state: 'reached', budget: { ...budget, on_exceed: 'warn' } }))).toBeNull();
    expect(budgetSendBlockReason(makeContext({ budget_state: 'reached', budget: null }))).toBeNull();
    expect(budgetSendBlockReason(makeContext({ budget_state: 'approaching', budget }))).toBeNull();
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
