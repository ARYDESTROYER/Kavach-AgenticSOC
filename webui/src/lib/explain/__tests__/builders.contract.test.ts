/**
 * The Explain builders print the numbers `explain.contract.json` pins for the server
 * (Round 16 SPEC §4.5 WP11; research explainability §5.4). The backend's
 * `test_explain_contract.py` reads the same file, so if either side changes a number one
 * suite fails.
 */
import { describe, expect, it } from 'vitest';

import contract from '../explain.contract.json';
import { displayBand, displayScore, roundHalfUp } from '../rounding';
import {
  explainCost,
  explainDecision,
  explainPercentile,
  explainPriority,
  explainRisk,
  explainSeverity,
  explainShare,
  explainSla,
  explainWilson,
  explanationText,
  percentile,
  recomputeCost,
  riskHoverLine,
  slaClockState,
  wilsonInterval,
} from '../builders';
import type { Case, CaseUsageRow, RiskBreakdown, RiskInputs } from '@/lib/types';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';

const FACTORS = ['volume', 'velocity', 'reputation', 'diversity', 'asset_criticality'] as const;

function caseFromVector(v: (typeof contract.risk.vectors)[number], extra: Partial<Case> = {}): Case {
  const breakdown: RiskBreakdown = {
    ...v.expected.breakdown,
    inputs: v.expected.inputs as unknown as RiskInputs,
  };
  return {
    case_id: `case-${v.name}`,
    risk_score: v.expected.breakdown.total,
    risk_breakdown: breakdown,
    ...extra,
  } as unknown as Case;
}

describe('rounding and banding (one rule for every shown score)', () => {
  it.each(contract.rounding.vectors)('$value shows as $display, band $band', ({ value, display, band }) => {
    expect(roundHalfUp(value)).toBe(display);
    expect(displayScore(value)).toBe(display);
    expect(displayBand(value)).toBe(band);
  });
});

describe('the risk explanation', () => {
  it('prints the worked example hover line exactly', () => {
    const v = contract.risk.vectors[0];
    const exp = explainRisk(caseFromVector(v));
    expect(exp?.summary).toBe(v.expected.hover_line);
    expect(riskHoverLine(v.expected.breakdown.total, caseFromVector(v).risk_breakdown as RiskBreakdown)).toBe(
      v.expected.hover_line,
    );
    expect(exp?.display).toBe('Risk 81');
    expect(exp?.provenance).toBe('recorded');
  });

  it.each(contract.risk.vectors)('$name: display and band of the shown integer', (v) => {
    const exp = explainRisk(caseFromVector(v));
    expect(exp?.display).toBe(`Risk ${v.expected.display}`);
    expect(displayBand(v.expected.breakdown.total)).toBe(v.expected.band);
  });

  it.each(contract.risk.vectors)('$name: the recorded-weight sum of the stored factors equals the score within 0.01', (v) => {
    const weights = v.expected.inputs.weights as Record<string, number>;
    const factors = v.expected.breakdown as Record<string, number>;
    const numerator = FACTORS.reduce((sum, key) => sum + weights[key] * factors[key], 0);
    const denominator = v.expected.inputs.zero_weight_fallback ? 1 : v.expected.inputs.total_weight;
    expect(Math.abs(numerator / denominator - v.expected.breakdown.total)).toBeLessThanOrEqual(
      contract.risk.tolerance_stored_factors,
    );
    // The explanation's own weighted-sum step prints the same total.
    const exp = explainRisk(caseFromVector(v));
    const total = exp?.steps.find((s) => s.label === 'Total');
    expect(Number(total?.result)).toBeCloseTo(v.expected.breakdown.total, 2);
  });

  it('shows each factor formula from the recorded inputs', () => {
    const exp = explainRisk(caseFromVector(contract.risk.vectors[0]));
    const byLabel = Object.fromEntries((exp?.steps ?? []).map((s) => [s.label, s]));
    expect(byLabel.Volume.expression).toBe('min(100, 100 x ln(1 + 40) / ln(1 + 50))');
    expect(byLabel.Volume.result).toBe('94.45');
    expect(byLabel.Velocity.expression).toBe('min(100, 100 x 40 / (120 / 60) / 10)');
    expect(byLabel.Velocity.result).toBe('100 (capped from 200)');
    expect(byLabel.Diversity.expression).toBe('min(100, 100 x 3 / 5)');
    expect(exp?.inputs.find((i) => i.key === 'asset_value')?.value).toBe('60, exact entry for this entity');
  });

  it('says velocity is 0 below 3 events, and names the 1 s window floor', () => {
    const two = explainRisk(caseFromVector(contract.risk.vectors[1]));
    expect(two?.steps.find((s) => s.label === 'Velocity')?.expression).toContain('velocity needs at least 3');
    const zero = explainRisk(caseFromVector(contract.risk.vectors[2]));
    expect(zero?.inputs.find((i) => i.key === 'span_seconds')?.value).toBe('0 s, counted as 1 s (the floor is 1 s)');
  });

  it('notes the zero-weight fallback', () => {
    const exp = explainRisk(caseFromVector(contract.risk.vectors[3]));
    expect(exp?.caveats.join(' ')).toContain('Every weight was 0');
  });

  it('never pairs the current member count with the scoring count (B13)', () => {
    const v = contract.risk.vectors[0];
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const exp = explainRisk(caseFromVector(v, { member_event_keys: keys } as Partial<Case>));
    expect(exp?.caveats).toContain(
      'The case now holds 50 events; the score was computed from the 40 events in its scoring run.',
    );
    expect(exp?.inputs.find((i) => i.key === 'event_count')?.value).toBe('40');
  });

  it('a legacy case without inputs says the inputs were not recorded', () => {
    const exp = explainRisk({
      case_id: 'legacy',
      risk_score: 61,
      risk_breakdown: { volume: 61, velocity: 0, reputation: 80, diversity: 40, asset_criticality: 0, total: 61 },
      member_event_keys: ['a', 'b', 'c'],
    } as unknown as Case);
    expect(exp?.provenance).toBe('not_recorded');
    expect(exp?.summary).toContain('the inputs were not recorded');
    expect(exp?.caveats.join(' ')).toContain('The case now holds 3 events; the score was computed from the events in its scoring run.');
  });

  it('a case with no breakdown still explains the shown integer', () => {
    const exp = explainRisk({ case_id: 'bare', risk_score: 73.5 } as unknown as Case);
    expect(exp?.display).toBe('Risk 74');
    expect(exp?.summary).toBe('Risk 73.5: no factor breakdown was recorded for this case.');
  });
});

describe('Wilson, percentile and share', () => {
  it.each(contract.wilson.vectors)('Wilson $successes of $total', ({ successes, total, low, high }) => {
    expect(wilsonInterval(successes, total, contract.wilson.z)).toEqual({ low, high });
    const exp = explainWilson(successes, total);
    expect(exp?.steps.find((s) => s.label === 'Low')?.result).toBe(String(low));
    expect(exp?.steps.find((s) => s.label === 'High')?.result).toBe(String(high));
  });

  it('percentile by linear interpolation', () => {
    const [v] = contract.percentile.vectors;
    expect(percentile(v.values, 0.5)).toBeCloseTo(v.p50, 10);
    expect(percentile(v.values, 0.9)).toBeCloseTo(v.p90, 10);
    const exp = explainPercentile({ p50: v.p50, p90: v.p90, mean: 26.5, max: 62, count: 4, available: true, reason: '' }, v.values);
    expect(exp?.steps.map((s) => s.result)).toEqual(['20 minutes', '52.7 minutes']);
    expect(exp?.summary).toBe('Median (p50) 20 minutes over 4 samples; p90 52.7 minutes, mean 26.5 minutes.');
  });

  it('a share prints the counts and the percent', () => {
    expect(explainShare(312, 1204, { label: 'cases' })?.summary).toBe('312 of 1,204 cases = 25.9%.');
    expect(explainShare(1, 0)?.display).toBe('Not measured');
  });
});

function chips(asset: number, risk: number, level: string, impact: string, urgency: string): TriageChips {
  return {
    risk: { value: risk, band: urgency, breakdown: {}, inputs: {} },
    severity: { band: 'high', value: 80, raw: 8, source: 'source_asserted', inputs: {}, scale_max: 10 } as TriageChips['severity'],
    impact: { band: impact, value: asset, criticality: asset, entity: '10.0.4.12', inputs: {} },
    priority: {
      level,
      impact,
      matched: true,
      default: 'P3',
      urgency: { band: urgency, value: risk, escalated: false },
      inputs: { matrix_enabled: true },
    },
  };
}

describe('priority and severity', () => {
  it.each(contract.priority.vectors)('asset $asset, risk $risk is $impact/$urgency = $level', (v) => {
    const exp = explainPriority(chips(v.asset, v.risk, v.level, v.impact, v.urgency));
    expect(exp?.display).toBe(v.level);
    expect(exp?.summary.startsWith(`${v.level} = matrix[impact ${v.impact}, urgency ${v.urgency}]`)).toBe(true);
  });

  it('the surprising P3 says why: no asset entry', () => {
    const exp = explainPriority(chips(0, 81.11, 'P3', 'low', 'high'));
    expect(exp?.summary).toBe(
      'P3 = matrix[impact low, urgency high]. Impact low: Asset criticality 0 < 22 for 10.0.4.12 (no asset entry). Urgency high: Risk 81 (81.11 rounded half up) >= 48.',
    );
  });

  it('urgency reads the shown risk integer, never "47.74 is from 22 to 47" (urgency-band-raw-vs-shown-risk)', () => {
    const exp = explainPriority(chips(0, 47.74, 'P3', 'low', 'high'));
    expect(exp?.summary).toBe(
      'P3 = matrix[impact low, urgency high]. Impact low: Asset criticality 0 < 22 for 10.0.4.12 (no asset entry). Urgency high: Risk 48 (47.74 rounded half up) >= 48.',
    );
    expect(explanationText(exp!)).not.toContain('is from 22 to 47');
    const medium = explainPriority(chips(30, 21.5, 'P4', 'medium', 'medium'));
    expect(medium?.summary).toContain('Urgency medium: Risk 22 (21.5 rounded half up) is at least 22 and under 48.');
    expect(medium?.summary).toContain('Impact medium: Asset criticality 30 is at least 22 and under 48');
  });

  it('a non-integer criticality is never claimed to sit in "22 to 47"', () => {
    const exp = explainPriority(chips(47.6, 10, 'P3', 'medium', 'low'));
    expect(exp?.summary).toContain('Asset criticality 47.6 is at least 22 and under 48');
    const edge = explainPriority(chips(47.996, 10, 'P3', 'medium', 'low'));
    expect(edge?.summary).toContain('Asset criticality 47.996 is at least 22 and under 48');
  });

  it('a derived severity names the shown integer it bands', () => {
    const c = chips(0, 47.74, 'P3', 'low', 'high');
    c.severity = { band: 'high', value: 47.74, raw: null, source: 'derived', inputs: {} } as unknown as TriageChips['severity'];
    expect(explainSeverity(c)?.summary).toBe(
      'High severity: the source reported none, so it is derived from the risk score 48 (47.74 rounded half up), in the High (48 to 73) band.',
    );
  });

  it('a source severity that projects to a non-integer reads a half-open range', () => {
    const c = chips(0, 10, 'P4', 'low', 'low');
    c.severity = { band: 'medium', value: 47.6, raw: 47.6, source: 'source_asserted', inputs: {}, scale_max: 100 } as unknown as TriageChips['severity'];
    expect(explainSeverity(c)?.summary).toBe(
      'Medium severity: the source reported 47.6 on a 0 to 100 scale; 47.6 / 100 x 100 = 47.6, in the Medium (at least 22 and under 48) band.',
    );
  });

  it('with the matrix off there is no priority, not the default level (D9)', () => {
    const c = chips(60, 81, 'P1', 'high', 'high');
    c.priority.level = null;
    c.priority.inputs.matrix_enabled = false;
    const exp = explainPriority(c);
    expect(exp?.display).toBe('No priority');
    expect(exp?.summary).toBe('No priority: the priority matrix is off.');
  });

  it('severity projects the source value onto its ceiling', () => {
    const c = chips(0, 10, 'P4', 'low', 'low');
    c.severity.band = 'critical';
    expect(explainSeverity(c)?.summary).toBe(
      'Critical severity: the source reported 8 on a 0 to 10 scale; 8 / 10 x 100 = 80, in the Critical (74 to 100) band.',
    );
  });
});

describe('SLA', () => {
  it.each(contract.sla.vectors)('$clock $elapsed_minutes of $target_minutes (responded $responded) is $state', (v) => {
    expect(slaClockState(v.target_minutes, v.elapsed_minutes, v.responded)).toBe(v.state);
  });

  it('explains a server reading', () => {
    const exp = explainSla({
      clock: 'response',
      start_at: '2026-11-24T10:00:00Z',
      anchor: 'created',
      responded_at: null,
      target_minutes: 120,
      due_at: '2026-11-24T12:00:00Z',
      elapsed_minutes: 26,
      state: 'ok',
      priority: 'P3',
      priority_source: 'priority_level',
    });
    expect(exp?.summary).toBe('Response SLA P3: 26m of 2h elapsed, on track. At risk from 1h 36m.');
  });
});

describe('decision', () => {
  const policy = (min: number, max: number, enabled = true) => ({
    policy_clause: { verdict_class: 'FALSE_POSITIVE', enabled, auto_closable: enabled, min_confidence: min, max_risk_score: max },
  });
  const fp = (risk: number, extra: Partial<Case> = {}) =>
    ({ case_id: 'd', verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: risk, status: 'needs_human', decision_by: 'system', ...extra }) as unknown as Case;

  const gate = (min: number, max: number, extra: Record<string, unknown> = {}) => ({
    source: 'recorded',
    gate: {
      verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: null, class_enabled: true,
      min_confidence: min, max_risk_score: max, objection_window_minutes: 30,
      escalation_confidence: 0.6, critical_severity: 7, outcome: 'routed', demo: false,
      ...extra,
    },
  });

  it('met: both conditions with the numbers', () => {
    expect(explainDecision(fp(20, { status: 'closed', decision_by: 'agent' }), gate(0.85, 30, { risk_score: 20 }) as never)?.summary).toBe(
      'Closes automatically: confidence 97% >= 85% (met) and risk 20 <= 30 (met).',
    );
  });

  it('not met: the failing condition is named', () => {
    expect(explainDecision(fp(45), gate(0.85, 30, { risk_score: 45 }) as never)?.summary).toBe(
      'Routed to a person: confidence 97% >= 85% (met); risk 45 <= 30 (not met).',
    );
  });

  it("with today's policy (no recorded gate) the sentence says so, never reading as what happened", () => {
    expect(explainDecision(fp(20, { status: 'closed', decision_by: 'agent' }), policy(0.85, 30))?.summary).toBe(
      "Today's policy closes it automatically: confidence 97% >= 85% (met) and risk 20 <= 30 (met).",
    );
    expect(explainDecision(fp(45), policy(0.85, 30))?.summary).toBe(
      "Today's policy routes it to a person: confidence 97% >= 85% (met); risk 45 <= 30 (not met).",
    );
  });

  it('NEEDS_HUMAN is fixed by code', () => {
    const exp = explainDecision({ case_id: 'n', verdict: 'NEEDS_HUMAN', confidence: 0.99, risk_score: 5 } as unknown as Case, null);
    expect(exp?.summary).toBe('Needs a person: a needs-human verdict never closes automatically. This is fixed by code, not by policy.');
  });

  it('an analyst close agrees when the policy alone would close it too', () => {
    const exp = explainDecision(fp(20, { status: 'closed', decision_by: 'analyst' }), policy(0.85, 30));
    expect(exp?.display).toBe('Closed by a person');
    expect(exp?.steps.find((s) => s.label === 'Policy check')?.result).toBe('Agrees');
  });

  it('labels today\'s policy when the gate was not recorded', () => {
    const exp = explainDecision(fp(45), policy(0.85, 30));
    expect(exp?.provenance).toBe('reconstructed_current');
  });
});

describe('cost', () => {
  const row = (extra: Partial<CaseUsageRow>): CaseUsageRow =>
    ({
      ts: '2026-11-24T10:00:00Z',
      surface: 'pipeline',
      role: 'investigator',
      model: 'model-a',
      prompt_tokens: 12345,
      completion_tokens: 2100,
      total_tokens: 14445,
      cost: 0.11422,
      currency: 'USD',
      latency_ms: 900,
      outcome: 'ok',
      pricing_source: 'exact',
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      batch: false,
      processing_tier: 'standard',
      failure_class: '',
      attempts: 1,
      usage_estimated: false,
      input_rate_per_million: 5,
      output_rate_per_million: 25,
      ...extra,
    }) as CaseUsageRow;

  it('recomputes a call from its own rates', () => {
    expect(recomputeCost(row({}))).toBe(0.114225);
    expect(recomputeCost(row({ batch: true }))).toBe(0.0571125);
    const exp = explainCost([row({}), row({ input_rate_per_million: null, output_rate_per_million: null })]);
    expect(exp?.steps[0].expression).toBe('(12,345 x $5 + 2,100 x $25) / 1,000,000');
    expect(exp?.steps[1].expression).toBe('Rates not recorded for this call');
    expect(exp?.caveats).toContain('1 of 2 calls were recorded before their rates were stored.');
  });
});

describe('copy calculation', () => {
  it('copies the whole explanation as text, values literal', () => {
    const exp = explainRisk(caseFromVector(contract.risk.vectors[0]));
    const text = explanationText(exp!);
    expect(text.split('\n')[0]).toBe('Risk score: Risk 81');
    expect(text).toContain('- Volume: min(100, 100 x ln(1 + 40) / ln(1 + 50)) = 94.45');
    expect(text).toContain('Provenance: Weights and inputs recorded when this case was scored, 2026-11-24T10:00:00+00:00.');
  });
});
