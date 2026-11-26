/**
 * Every printed expression in the risk explanation evaluates to its printed result with
 * its printed operands (Round 16 numbers review: risk-velocity-step-not-reproducible and
 * risk-total-step-false).
 *
 * The fixture holds the risk score and breakdown (with the inputs recorded at scoring)
 * of every case the seeded Demo shows (seed 1337: the history, the recent trio and the
 * capability cases, 77 cases), as `GET /api/cases` returned them from
 * `DEMO_MODE=seeded ./scripts/run-demo.sh`, with the rule names left out because no
 * arithmetic reads them.
 *
 * The test reads only the panel's own strings: it parses each step's calculation, works
 * it out, and checks the printed result to the precision it is printed with.
 */
import { describe, expect, it } from 'vitest';

import { explainRiskScore } from '../risk';
import type { Explanation } from '../types';
import type { RiskBreakdown } from '@/lib/types';

import seeded from './fixtures/seeded-demo-risk.json';

// --------------------------------------------------------------------------- //
// A tiny evaluator for the calculation grammar the panel prints:
// numbers, + - x * /, parentheses, min(a, b), clamp(v, lo, hi), ln(v), floor(v).
// --------------------------------------------------------------------------- //
type Token = { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ') {
      i += 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(text.slice(i));
    if (num) {
      tokens.push({ kind: 'num', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[a-z]+/.exec(text.slice(i));
    if (id) {
      tokens.push(id[0] === 'x' ? { kind: 'op', value: '*' } : { kind: 'id', value: id[0] });
      i += id[0].length;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`cannot read ${JSON.stringify(text.slice(i))} in ${JSON.stringify(text)}`);
  }
  return tokens;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  min: (a, b) => Math.min(a, b),
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  ln: (v) => Math.log(v),
  floor: (v) => Math.floor(v),
};

/** Evaluate a printed calculation. Throws on anything outside the grammar. */
function evaluate(text: string): number {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (value?: string) => {
    const t = tokens[pos];
    if (!t || (value !== undefined && t.value !== value)) throw new Error(`expected ${value} in ${text}`);
    pos += 1;
    return t;
  };
  const primary = (): number => {
    const t = take();
    if (t.kind === 'num') return t.value;
    if (t.kind === 'op' && t.value === '(') {
      const v = sum();
      take(')');
      return v;
    }
    if (t.kind === 'op' && t.value === '-') return -primary();
    if (t.kind === 'id') {
      const fn = FUNCTIONS[t.value];
      if (!fn) throw new Error(`unknown function ${t.value} in ${text}`);
      take('(');
      const args = [sum()];
      while (peek()?.value === ',') {
        take(',');
        args.push(sum());
      }
      take(')');
      return fn(...args);
    }
    throw new Error(`unexpected ${t.value} in ${text}`);
  };
  const product = (): number => {
    let v = primary();
    while (peek()?.value === '*' || peek()?.value === '/') {
      const op = take().value;
      const r = primary();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek()?.value === '+' || peek()?.value === '-') {
      const op = take().value;
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const value = sum();
  if (pos !== tokens.length) throw new Error(`trailing tokens in ${text}`);
  return value;
}

/** A printed number and the half unit of its last printed decimal. */
function printed(text: string): { value: number; half: number } {
  const clean = text.replace(/,/g, '').trim();
  expect(clean).toMatch(/^-?\d+(\.\d+)?$/);
  const decimals = clean.includes('.') ? clean.split('.')[1].length : 0;
  return { value: Number(clean), half: 0.5 * 10 ** -decimals };
}

/** The printed expression gives the printed result, to the precision it is printed with. */
function expectReproduces(expression: string, result: string, where: string): void {
  const got = evaluate(expression);
  const { value, half } = printed(result);
  expect(Math.abs(got - value), `${where}: ${expression} = ${got}, printed ${result}`).toBeLessThanOrEqual(half + 1e-9);
}

interface SeededCase {
  id: string;
  risk_score: number;
  risk_breakdown: RiskBreakdown;
}

const CASES = seeded as unknown as SeededCase[];

function explain(c: SeededCase): Explanation {
  const exp = explainRiskScore({ score: c.risk_score, breakdown: c.risk_breakdown });
  if (!exp) throw new Error(`no explanation for ${c.id}`);
  return exp;
}

/** Check every step and the hover line of one explanation from its own strings. */
function checkExplanation(exp: Explanation, where: string): void {
  const denominator = /\) \/ (\d+\.\d+)[. ]/.exec(exp.summary)?.[1] ?? '1.00';
  for (const step of exp.steps) {
    const at = `${where} ${step.label}`;
    if (step.label === 'Velocity' && step.expression.startsWith('0, because')) {
      expect(step.result, at).toBe('0');
      continue;
    }
    if (step.label === 'Total' && step.expression.startsWith('Recorded at scoring')) {
      // No division is printed: the sentence names what the stored factors give, and
      // that must be the weighted sum over the printed weights.
      const weighted = exp.steps.find((s) => s.label === 'Weighted sum');
      const given = /The stored factors give (\S+)\.$/.exec(step.expression)?.[1];
      expect(weighted && given, at).toBeTruthy();
      expectReproduces(weighted!.expression, given!, at);
      // And the division it replaced would have been false.
      const division = `${weighted!.result} / ${denominator}`;
      expect(Math.abs(evaluate(division) - printed(step.result).value), at).toBeGreaterThan(printed(step.result).half);
      continue;
    }
    const capped = /^(\S+) \(capped from (\S+)\)$/.exec(step.result);
    if (capped) {
      expectReproduces(step.expression, capped[1], at);
      const inner = /^min\(100, (.*)\)$/.exec(step.expression)?.[1];
      expect(inner, at).toBeTruthy();
      expectReproduces(inner!, capped[2], `${at} raw`);
      continue;
    }
    expectReproduces(step.expression, step.result, at);
  }
  const rate = exp.inputs.find((i) => i.key === 'rate_per_minute');
  if (rate && !rate.value.startsWith('Not used')) {
    const [left, right] = rate.value.split(' = ');
    expectReproduces(left.replace(/ s /g, ' ').replace(/,/g, ''), right, `${where} events per minute`);
  }
  const hover = /^Risk (\S+) = \((.*)\) \/ (\S+)\. Click for inputs\.$/.exec(exp.summary);
  const stored = /^Risk (\S+), from the unrounded factors\. The stored factors give \((.*)\) \/ (\S+) = (\S+)\. Click for inputs\.$/.exec(
    exp.summary,
  );
  expect(hover || stored, `${where} hover line: ${exp.summary}`).toBeTruthy();
  if (hover) expectReproduces(`(${hover[2]}) / ${hover[3]}`, hover[1], `${where} hover line`);
  if (stored) {
    expectReproduces(`(${stored[2]}) / ${stored[3]}`, stored[4], `${where} hover line`);
    expect(stored[4]).not.toBe(stored[1]);
  }
}

describe('the risk explanation reproduces its own arithmetic', () => {
  it('reads every seeded Demo case, each with recorded inputs', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(CASES.every((c) => c.risk_breakdown?.inputs)).toBe(true);
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s: every step, the rate row and the hover line', (id, c) => {
    const exp = explain(c);
    expect(exp.provenance).toBe('recorded');
    checkExplanation(exp, id);
    const shown = exp.steps.find((s) => s.label === 'Shown');
    expect(shown?.result).toBe(String(Math.floor(c.risk_score + 0.5)));
    expect(exp.steps.find((s) => s.label === 'Total')?.result).toBe(printedScore(c.risk_score));
  });

  it('prints a velocity that reproduces for a rate that is not round (8 events over 434.875 s)', () => {
    const c = CASES.find((row) => row.risk_breakdown.inputs?.effective_window_seconds === 434.875);
    expect(c).toBeTruthy();
    const exp = explain(c!);
    const velocity = exp.steps.find((s) => s.label === 'Velocity');
    expect(velocity?.expression).toBe('min(100, 100 x 8 / (434.875 / 60) / 10)');
    expect(velocity?.result).toBe('11.04');
    expect(exp.inputs.find((i) => i.key === 'rate_per_minute')?.value).toBe('8 / (434.875 s / 60) = 1.1038');
    expect(exp.inputs.find((i) => i.key === 'span_seconds')?.value).toBe('434.875 s');
  });

  it('never prints a Total division that does not give the score (factors 35.26, 45, 0, 20, 0; total 20.81)', () => {
    const breakdown = {
      volume: 35.26, velocity: 45, reputation: 0, diversity: 20, asset_criticality: 0, total: 20.81,
      inputs: {
        event_count: 3, span_seconds: 40, effective_window_seconds: 40, rate_per_minute: 4.5, velocity_rule: 'rate',
        rule_type_count: 1, reputation_input: 0, reputation_source: 'not_ip_entity', asset_value: 0, asset_match: 'none',
        weights: { volume: 0.25, velocity: 0.2, reputation: 0.3, diversity: 0.15, asset_criticality: 0.1 },
        total_weight: 1, zero_weight_fallback: false, refs: { volume: 50, velocity: 10, diversity: 5 },
        scored_at: '2026-11-24T10:00:00+00:00', inputs_version: 1,
      },
    } as unknown as RiskBreakdown;
    const exp = explainRiskScore({ score: 20.81, breakdown });
    const total = exp?.steps.find((s) => s.label === 'Total');
    expect(total?.expression).not.toContain('20.82 / 1.00');
    expect(total?.expression).toContain('unrounded factors');
    expect(total?.result).toBe('20.81');
    expect(exp?.steps.find((s) => s.label === 'Weighted sum')?.result).toBe('20.82');
    expect(exp?.summary).toBe(
      'Risk 20.81, from the unrounded factors. The stored factors give (0.25 x 35.26 + 0.20 x 45 + 0.30 x 0 + 0.15 x 20 + 0.10 x 0) / 1.00 = 20.82. Click for inputs.',
    );
    checkExplanation(exp!, 'twenty-point-81');
  });

  it('keeps the worked example as a division (81.11 / 1.00)', () => {
    const breakdown = {
      volume: 94.45, velocity: 100, reputation: 75, diversity: 60, asset_criticality: 60, total: 81.11,
      inputs: {
        event_count: 40, span_seconds: 120, effective_window_seconds: 120, rate_per_minute: 20, velocity_rule: 'rate',
        rule_type_count: 3, reputation_input: 75, reputation_source: 'enrichment', asset_value: 60, asset_match: 'exact',
        weights: { volume: 0.25, velocity: 0.2, reputation: 0.3, diversity: 0.15, asset_criticality: 0.1 },
        total_weight: 1, zero_weight_fallback: false, refs: { volume: 50, velocity: 10, diversity: 5 },
        scored_at: '2026-11-24T10:00:00+00:00', inputs_version: 1,
      },
    } as unknown as RiskBreakdown;
    const exp = explainRiskScore({ score: 81.11, breakdown });
    const total = exp?.steps.find((s) => s.label === 'Total');
    expect(total?.expression).toBe('81.11 / 1.00');
    expect(total?.result).toBe('81.11');
    checkExplanation(exp!, 'worked example');
  });

  it('the evaluator reads the grammar it checks', () => {
    expect(evaluate('min(100, 100 x 8 / (434.875 / 60) / 10)')).toBeCloseTo(11.0377, 4);
    expect(evaluate('floor(20.81 + 0.5)')).toBe(21);
    expect(evaluate('clamp(120, 0, 100)')).toBe(100);
    expect(evaluate('min(100, 100 x ln(1 + 40) / ln(1 + 50))')).toBeCloseTo(94.45, 2);
  });
});

function printedScore(score: number): string {
  return (Math.round(score * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
