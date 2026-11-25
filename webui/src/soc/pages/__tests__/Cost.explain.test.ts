/**
 * The Cost KPI arithmetic with the real numbers (Round 16 SPEC §4.5 WP11; research
 * explainability R13): per call, per 1K tokens and tokens per call, each the division the
 * tile shows; nothing for a tile whose denominator is 0.
 */
import { describe, expect, it } from 'vitest';

import { costKpiExplanations } from '../Cost';

describe('costKpiExplanations', () => {
  const lines = costKpiExplanations({
    totalCost: 4.12,
    totalTokens: 1_204_551,
    callCount: 318,
    currency: 'USD',
    caption: 'last 7 days',
  });

  it('per call divides the cost by the calls', () => {
    expect(lines.perCall?.summary).toBe('Per call = $4.12 / 318 calls = $0.0130, last 7 days.');
  });

  it('per 1K tokens divides the cost by the tokens', () => {
    expect(lines.perThousand?.summary).toBe('Per 1K tokens = $4.12 / 1,204,551 tokens x 1,000 = $0.0034, last 7 days.');
  });

  it('tokens per call divides the tokens by the calls', () => {
    expect(lines.tokensPerCall?.summary).toBe('Tokens per call = 1,204,551 tokens / 318 calls = 3.8K, last 7 days.');
  });

  it('says nothing for a zero denominator', () => {
    const none = costKpiExplanations({ totalCost: 0, totalTokens: 0, callCount: 0, caption: 'today' });
    expect(none).toEqual({ perCall: null, perThousand: null, tokensPerCall: null });
  });
});
