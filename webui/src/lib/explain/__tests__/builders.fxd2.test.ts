/**
 * Round 16 FXD2: the explain builders print arithmetic a reader can redo by hand.
 *
 * * A percentile step prints operands whose expression, worked by hand and rounded half
 *   up, gives the printed result (1.05 and 3.0167 never print as "3.02 ... = 2.03").
 * * The time to detect reads "1 minute", never "1 minutes".
 * * A running SLA clock has a Time left step that gives the "due in" figure, rounded
 *   down; a breached one has an Over by step.
 * * The AI confidence names its source: the AI's own estimate, with the run when the
 *   decision gate is recorded.
 */
import { describe, expect, it } from 'vitest';

import type { Case, StatBlock } from '@/lib/types';
import { CONFIDENCE_SOURCE, explainDecision, explainPolicyToday } from '../decision';
import { dueInWords, explainSla, overdueWords, type SlaReadingWire } from '../sla';
import { explainPercentile, interpolationOperands } from '../stats';
import { explainTimeToDetect, minutesText } from '../times';

/** Work "lo + f x (hi - lo)" from its printed text, rounded half up to 2 decimals. */
function workStep(expression: string): number {
  const tail = expression.split('; ')[1];
  const match = /^([\d.,]+) \+ ([\d.]+) x \(([\d.,]+) - ([\d.,]+)\)$/.exec(tail);
  expect(match, expression).not.toBeNull();
  const [lo, f, hi, lo2] = (match as RegExpExecArray).slice(1).map((v) => Number(v.replace(/,/g, '')));
  expect(lo2).toBe(lo);
  const worked = Math.round((lo + f * (hi - lo)) * 1e9) / 1e9;
  return Math.floor(worked * 100 + 0.5 + 1e-9) / 100;
}

const BLOCK = { available: true, count: 2, p50: 2.03, p90: 2.82, mean: 2.03, max: 3.02 } as unknown as StatBlock;

describe('a percentile step reproduces its printed result', () => {
  it('prints the operand precision the step needs (the MTTD panel case)', () => {
    const explanation = explainPercentile(BLOCK, [1.05, 3.0167]);
    const p50 = explanation?.steps.find((s) => s.label === 'p50');
    expect(p50?.result).toBe('2.03 minutes');
    expect(p50?.expression).not.toContain('3.02 - 1.05');
    expect(workStep(p50?.expression ?? '')).toBe(2.03);
    const p90 = explanation?.steps.find((s) => s.label === 'p90');
    expect(workStep(p90?.expression ?? '')).toBe(Number(p90?.result.replace(' minutes', '')));
  });

  it('keeps two decimals when they already work out', () => {
    expect(interpolationOperands(4, 9, 0.5, 6.5)).toEqual({ lo: '4', hi: '9', fraction: '0.5' });
  });

  it('holds for many random samples', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 300; i += 1) {
      const n = 2 + Math.floor(random() * 9);
      const samples = Array.from({ length: n }, () => Math.round(random() * 1e6) / 1e4);
      const explanation = explainPercentile(BLOCK, samples);
      for (const step of explanation?.steps ?? []) {
        if (!step.expression.includes('; ')) continue;
        expect(workStep(step.expression), `${samples.join(', ')}: ${step.expression}`).toBe(
          Number(step.result.replace(' minutes', '').replace(/,/g, '')),
        );
      }
    }
  });
});

describe('minute counts agree with their noun', () => {
  it('reads "1 minute" for one minute to detect', () => {
    const explanation = explainTimeToDetect('2026-11-26T10:00:00Z', '2026-11-26T10:01:00Z', '1m');
    expect(explanation?.steps[0].result).toBe('1 minute');
  });

  it('keeps the plural otherwise', () => {
    expect(minutesText(0.5)).toBe('0.5 minutes');
    expect(minutesText(2)).toBe('2 minutes');
    expect(minutesText(18197.93)).toBe('18,197.93 minutes');
  });
});

const running = (extra: Partial<SlaReadingWire> = {}): SlaReadingWire => ({
  clock: 'response',
  start_at: '2026-11-26T10:00:00+00:00',
  anchor: 'created',
  responded_at: null,
  target_minutes: 480,
  due_at: '2026-11-26T18:00:00+00:00',
  elapsed_minutes: 10.63,
  state: 'ok',
  priority: 'P4',
  priority_source: null,
  running: true,
  ...extra,
});

describe('the SLA explanation turns its numbers into the shown line', () => {
  it('a running clock has the time left, rounded down as the due line shows it', () => {
    const steps = explainSla(running())?.steps ?? [];
    expect(steps.find((s) => s.label === 'Time left')).toEqual({
      label: 'Time left',
      expression: '480 - 10.63',
      result: '469.37 minutes, shown as 7h (rounded down)',
    });
  });

  it('a stopped or never-due clock has no time left', () => {
    expect(explainSla(running({ running: false, state: 'met', responded_at: '2026-11-26T10:05:00+00:00' }))?.steps.map((s) => s.label)).not.toContain('Time left');
    expect(explainSla(running({ due_at: null }))?.steps.map((s) => s.label)).not.toContain('Time left');
  });

  it('a breached clock states how far past the target it is', () => {
    const steps = explainSla(running({ state: 'breached', elapsed_minutes: 18677.93 }))?.steps ?? [];
    expect(steps.find((s) => s.label === 'Over by')).toEqual({
      label: 'Over by',
      expression: '18,677.93 - 480',
      result: '18,197.93 minutes',
    });
    expect(steps.find((s) => s.label === 'Shown')?.result).toBe('overdue by 13d');
  });

  it('rounds the way the case page lines do', () => {
    expect(dueInWords(94)).toBe('1h');
    expect(dueInWords(0.4)).toBe('under 1m');
    expect(dueInWords(59.9)).toBe('59m');
    expect(dueInWords(2880)).toBe('2d');
    expect(overdueWords(0.2)).toBe('1m');
    expect(overdueWords(95)).toBe('2h');
  });
});

describe('the AI confidence names its source', () => {
  const fp = { case_id: 'd', verdict: 'FALSE_POSITIVE', confidence: 0.71, risk_score: 20, status: 'open', decision_by: 'system' } as unknown as Case;

  it('without a recorded gate: the AI reported it with its verdict', () => {
    const input = explainDecision(fp, null)?.inputs.find((i) => i.key === 'confidence');
    expect(input?.source).toBe(CONFIDENCE_SOURCE);
    expect(CONFIDENCE_SOURCE).toBe('Reported by the AI with its verdict');
    const today = explainPolicyToday('FALSE_POSITIVE', 0.71, 20, { enabled: true, min_confidence: 0.85, max_risk_score: 30 });
    expect(today?.inputs.find((i) => i.key === 'confidence')?.source).toBe(CONFIDENCE_SOURCE);
  });

  it('with a recorded gate: names the run whose verdict the decision compared', () => {
    const payload = {
      source: 'recorded',
      gate_source: 'recorded',
      run_id: 'run-3f2a',
      gate: { verdict: 'FALSE_POSITIVE', confidence: 0.71, risk_score: 20, class_enabled: true, min_confidence: 0.85, max_risk_score: 30 },
    } as never;
    const input = explainDecision(fp, payload)?.inputs.find((i) => i.key === 'confidence');
    expect(input?.source).toBe('Reported by the AI with its verdict in run run-3f2a; recorded at decision');
  });
});
