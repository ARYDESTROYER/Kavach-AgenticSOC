/**
 * HealthDiagnostics — the per-rule precedent signal.
 *
 * Two silent failures live behind a single "N analyst-confirmed precedents" number:
 *
 * 1. **Starvation by success.** The bounded projection window is filled newest-first,
 *    so one rule's bulk analyst confirmation can evict every other rule. A total tells
 *    the operator nothing about the SPREAD, so the collapse is invisible until
 *    auto-close stops.
 * 2. **Futility.** A rule can hold hundreds of confirmed benign outcomes and still route
 *    every case to a human, because its alerts carry no per-case evidence to verify.
 *    The product nonetheless keeps asking for more confirmations.
 *
 * Both must be visible, and neither may be invented: an unreadable corpus reports
 * "Unknown", never a reassuring zero.
 */
import { describe, it, expect } from 'vitest';

import { precedentSpreadDetail, precedentSpreadText } from '../HealthDiagnostics';
import type { PrecedentEffectiveness } from '@/lib/types';

function effectiveness(over: Partial<PrecedentEffectiveness> = {}): PrecedentEffectiveness {
  return {
    promotion_enabled: false,
    promotion_min_confirmed: 25,
    window_size: 200,
    window_stratified: true,
    distribution: {
      available: true,
      reason: '',
      truncated: false,
      disabled: false,
      scanned_chunks: 846,
      rule_identities: 8,
      unattributed_documents: 0,
      total_confirmed: 846,
      returned: 8,
      by_rule: [],
    },
    futility_measured: true,
    futility_reason: '',
    futile_rules: [],
    futile_rule_count: 0,
    ...over,
  };
}

describe('precedentSpreadText', () => {
  it('reports how many RULES hold precedent, not just the total', () => {
    expect(precedentSpreadText(effectiveness())).toBe('8 rules');
  });

  it('marks a truncated corpus read as a LOWER BOUND', () => {
    const truncated = effectiveness();
    truncated.distribution.truncated = true;
    expect(precedentSpreadText(truncated)).toBe('≥ 8 rules');
  });

  it('never renders an unreadable corpus as a confident zero', () => {
    const unreadable = effectiveness();
    unreadable.distribution.available = false;
    unreadable.distribution.rule_identities = 0;
    expect(precedentSpreadText(unreadable)).toBe('Unknown');
  });

  it('degrades to the dash placeholder when the block is absent entirely', () => {
    expect(precedentSpreadText(null)).toBe('—');
    expect(precedentSpreadText(undefined)).toBe('—');
  });

  it('singularises a one-rule corpus', () => {
    const one = effectiveness();
    one.distribution.rule_identities = 1;
    expect(precedentSpreadText(one)).toBe('1 rule');
  });
});

describe('precedentSpreadDetail — an unmeasured state never reads as measured', () => {
  it('reports a turned-off precedent source as configured, not as a corpus count', () => {
    const off = effectiveness();
    off.distribution.disabled = true;
    off.distribution.available = false;
    off.distribution.reason = 'the resolved-case precedent source is turned off';
    expect(precedentSpreadText(off)).toBe('Turned off');
    expect(precedentSpreadDetail(off)).toBe('the resolved-case precedent source is turned off');
  });

  it('says WHY the futility report did not run instead of implying nothing was found', () => {
    const notRun = effectiveness({
      futility_measured: false,
      futility_reason: 'the precedent corpus read was truncated',
    });
    expect(precedentSpreadDetail(notRun)).toBe('the precedent corpus read was truncated');
  });

  it('names the futile rules when the report DID run and found some', () => {
    const futile = effectiveness({ futile_rule_count: 2 });
    expect(precedentSpreadDetail(futile)).toContain('2 rules');
    expect(precedentSpreadDetail(futile)).toContain('will not change that on its own');
  });

  it('summarises the measured corpus only when everything was actually measured', () => {
    const detail = precedentSpreadDetail(effectiveness());
    expect(detail).toContain('846 analyst-confirmed');
    expect(detail).toContain('shared fairly across rules');
  });
});
