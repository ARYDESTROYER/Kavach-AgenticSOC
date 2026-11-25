/**
 * WP11 review regressions for the Explain builders (Round 16 SPEC §4.5 WP11).
 *
 * * A comparison never shows numbers that contradict its own result: 0.849 against a 0.85
 *   bar is "84.9% >= 85% (not met)", never "85% >= 85% (not met)".
 * * A changed policy does not claim a different decision: the caveat states today's reading.
 * * A response clock a person stopped inside its target reads "met", not "on track".
 * * The hover pointer to the full calculation ("Click for inputs.") is dropped from the
 *   panel summary and the copied text.
 */
import { describe, expect, it } from 'vitest';

import type { Case } from '@/lib/types';
import { explainDecision } from '../decision';
import { explainSla } from '../sla';
import { explanationText, hasClickHint, summaryWithoutHint } from '../text';

const fp = (confidence: number, risk: number) =>
  ({ case_id: 'd', verdict: 'FALSE_POSITIVE', confidence, risk_score: risk, status: 'open', decision_by: 'system' }) as unknown as Case;

const recorded = (extra: Record<string, unknown> = {}) =>
  ({
    source: 'recorded',
    gate: {
      verdict: 'FALSE_POSITIVE',
      confidence: 0.849,
      risk_score: 20,
      class_enabled: true,
      min_confidence: 0.85,
      max_risk_score: 30,
      objection_window_minutes: 30,
      escalation_confidence: 0.6,
      critical_severity: 7,
      outcome: 'routed',
      demo: false,
    },
    ...extra,
  }) as never;

describe('a comparison never contradicts its own result', () => {
  it('shows one more decimal when whole percents would read equal', () => {
    const exp = explainDecision(fp(0.849, 20), recorded());
    expect(exp?.summary).toBe('Routed to a person: confidence 84.9% >= 85% (not met); risk 20 <= 30 (met).');
    expect(exp?.inputs.find((i) => i.key === 'confidence')?.value).toBe('84.9%');
    expect(exp?.inputs.find((i) => i.key === 'min_confidence')?.value).toBe('85%');
    expect(exp?.steps.find((s) => s.label === 'Confidence')?.expression).toBe('confidence 84.9% >= 85%');
  });

  it('keeps whole percents when they already differ', () => {
    const exp = explainDecision(fp(0.97, 20), recorded({ gate: { verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: 20, class_enabled: true, min_confidence: 0.85, max_risk_score: 30 } }));
    expect(exp?.summary).toBe('Closes automatically: confidence 97% >= 85% (met) and risk 20 <= 30 (met).');
  });

  it('a risk just over the bar shows the decimals that make it over', () => {
    const exp = explainDecision(
      fp(0.97, 30.004),
      recorded({ gate: { verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: 30.004, class_enabled: true, min_confidence: 0.85, max_risk_score: 30 } }),
    );
    expect(exp?.summary).toBe('Routed to a person: confidence 97% >= 85% (met); risk 30.004 <= 30 (not met).');
  });
});

describe('a changed policy states today\'s reading', () => {
  it('never claims a different decision when today\'s policy decides the same', () => {
    const exp = explainDecision(
      fp(0.97, 20),
      recorded({
        gate: { verdict: 'FALSE_POSITIVE', confidence: 0.97, risk_score: 20, class_enabled: true, min_confidence: 0.85, max_risk_score: 30 },
        current_policy: { enabled: true, min_confidence: 0.9, max_risk_score: 30 },
        policy_changed: true,
      }),
    );
    expect(exp?.caveats).toContain(
      "The auto-close policy changed after this decision. Today's policy closes it automatically: confidence 97% >= 90% (met) and risk 20 <= 30 (met).",
    );
    expect(exp?.caveats.join(' ')).not.toContain('would decide differently');
  });
});

describe('a stopped response clock', () => {
  it('reads met, with no at-risk line, when a person answered inside the target', () => {
    const exp = explainSla({
      clock: 'response',
      start_at: '2026-11-24T10:00:00Z',
      anchor: 'acknowledged',
      responded_at: '2026-11-24T10:14:00Z',
      target_minutes: 15,
      due_at: '2026-11-24T10:15:00Z',
      elapsed_minutes: 14,
      state: 'ok',
      priority: 'P1',
      priority_source: 'priority_level',
    });
    expect(exp?.display).toBe('P1 response met');
    expect(exp?.summary).toBe('Response SLA P1: answered after 14m against a 15m target, met.');
  });
});

describe('the pointer to the full calculation', () => {
  it('is recognised and dropped from the panel summary and the copied text', () => {
    const summary = 'Risk 81.11 = (0.25 x 94.45) / 1.00. Click for inputs.';
    expect(hasClickHint(summary)).toBe(true);
    expect(summaryWithoutHint(summary)).toBe('Risk 81.11 = (0.25 x 94.45) / 1.00.');
    expect(hasClickHint('Per call = $4.12 / 318 calls = $0.0130, last 7 days.')).toBe(false);
    const text = explanationText({
      metric: 'risk_score',
      title: 'Risk score',
      value: 81.11,
      display: 'Risk 81',
      summary,
      formula: 'f',
      inputs: [],
      steps: [],
      provenance: 'recorded',
      caveats: [],
    });
    expect(text).not.toContain('Click for inputs.');
    expect(text.split('\n')[1]).toBe('Risk 81.11 = (0.25 x 94.45) / 1.00.');
  });
});
