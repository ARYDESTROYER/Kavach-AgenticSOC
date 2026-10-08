/**
 * Transcript display helpers: compact tokens, short money, durations and the turn's
 * elapsed time (parallel groups count once), plus the honest usage qualifiers.
 */
import { describe, expect, it } from 'vitest';

import type { TurnUsage } from '@/lib/types';
import {
  compactTokens,
  formatCost,
  formatDuration,
  inputTokens,
  lookupCount,
  lookupsLabel,
  paramKeyLabel,
  paramValue,
  turnDurationMs,
  usageSummary,
} from '../format';

const USAGE: TurnUsage = {
  calls: 2,
  embedding_calls: 0,
  input_tokens: 1000,
  cache_read_tokens: 200,
  cache_write_tokens: 50,
  output_tokens: 850,
  total_tokens: 2100,
  cost: 0.0042,
  latency_ms: 1800,
  model: 'gpt-test',
  pricing_source: 'catalog',
  simulated: false,
  estimated: false,
  context_window: 128000,
  peak_prompt_tokens: 1100,
};

describe('message format helpers', () => {
  it('formats token counts compactly with a lower-case k', () => {
    expect(compactTokens(820)).toBe('820');
    expect(compactTokens(1200)).toBe('1.2k');
    expect(compactTokens(12_400)).toBe('12.4k');
    expect(compactTokens(10_000)).toBe('10k');
    expect(compactTokens(184_400)).toBe('184k');
    expect(compactTokens(1_340_000)).toBe('1.3M');
    expect(compactTokens(null)).toBe('—');
    expect(compactTokens(Number.NaN)).toBe('—');
  });

  it('formats spend in fractions of a cent without pretending precision', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0004)).toBe('<$0.001');
    expect(formatCost(0.0042)).toBe('$0.004');
    expect(formatCost(0.031)).toBe('$0.03');
    expect(formatCost(1.2)).toBe('$1.20');
    expect(formatCost(-1)).toBe('—');
  });

  it('formats durations', () => {
    expect(formatDuration(820)).toBe('820 ms');
    expect(formatDuration(6200)).toBe('6.2 s');
    expect(formatDuration(4000)).toBe('4 s');
    expect(formatDuration(124_000)).toBe('2 min 4 s');
    expect(formatDuration(120_000)).toBe('2 min');
  });

  it('counts a parallel group once (its slowest call) and falls back to model latency', () => {
    const steps = [
      { duration_ms: 1000, group: null },
      { duration_ms: 400, group: 1 },
      { duration_ms: 900, group: 1 },
      { duration_ms: 300, group: null },
    ];
    expect(turnDurationMs(steps, USAGE)).toBe(2200);
    expect(turnDurationMs([], USAGE)).toBe(1800);
    expect(turnDurationMs([], null)).toBeNull();
  });

  it('labels lookups and usage honestly', () => {
    expect(lookupCount([{ kind: 'tool' }, { kind: 'model' }, { kind: 'tool' }])).toBe(2);
    expect(lookupsLabel(1)).toBe('1 lookup');
    expect(lookupsLabel(4)).toBe('4 lookups');
    expect(usageSummary(USAGE)).toBe('2.1k tokens · $0.004');
    expect(usageSummary({ ...USAGE, estimated: true, simulated: true })).toBe('≈ 2.1k tokens · ≈ $0.004 · simulated');
    // Input tokens as users understand them: uncached + cache read + cache write.
    expect(inputTokens(USAGE)).toBe(1250);
  });

  it('humanises chip keys and values', () => {
    expect(paramKeyLabel('group_by')).toBe('Group by');
    expect(paramValue(null)).toBe('none');
    expect(paramValue(true)).toBe('yes');
    expect(paramValue(1200)).toBe((1200).toLocaleString());
    expect(paramValue('last 24h')).toBe('last 24h');
  });
});
