/**
 * Round 16 package FXF: the fix-package leftovers on the case page and the explanations.
 *
 *  - The Brief People row says when an AI run replaced a person's close, never a close
 *    under an open status.
 *  - A waiting case's routing score is stored and shown with two decimals.
 *  - A rank line over a listed run prints operands that give its result.
 *  - A panel that shows a whole percent ends on that figure ("68%", not "67.9%").
 *  - A rate's change chip prints the counts behind both windows.
 *  - The Agent effectiveness comparison figures, a person's median time to acknowledge
 *    and the Standup action item and sign-off counts each explain themselves.
 *  - The noisiest rules' FP rate names the z the tuner used.
 */
import { describe, expect, it } from 'vitest';

import type { AgentComparisonMetric, Case, PersonActivity } from '@/lib/types';
import { lastHumanAction } from '../casedetail/OverviewPanel';
import { awaitingWords } from '../casedetail/records/AwaitingReason';
import { rankLineOverRun } from '@/soc/components/metrics-explain/builders';
import { autoCloseRateExplanation, noisyRuleExplanation } from '@/soc/dashboard/widgets/detection';
import { compareChipExplanation } from '../Metrics';
import {
  agreementComparisonExplanation,
  correctionComparisonExplanation,
  turnaroundComparisonExplanation,
} from '../effectiveness/comparisonExplain';
import { explainPersonMedian } from '../team/team-explain';
import { explainActionItems, explainHandoffAcks } from '../Standup.explain';

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function caseWith(status: string, history: unknown[]): Case {
  return { case_id: 'case-1', status, history } as unknown as Case;
}

describe('Brief People row after an AI run replaced a close', () => {
  const close = { ts: iso(3), event: 'analyst_action', action: 'close', analyst: 'Admin', classified_disposition: 'benign' };
  const decision = { ts: iso(1), event: 'decision', status: 'needs_human', decision_by: 'system' };

  it('says the AI investigation replaced the close when the case is open again', () => {
    const line = lastHumanAction(caseWith('needs_human', [close, decision]));
    expect(line).toMatch(/^Closed as benign by Admin, .+\. The AI investigation then replaced the close\.$/);
  });

  it('keeps the plain line while the close stands, or when no run decided after it', () => {
    expect(lastHumanAction(caseWith('closed', [close, decision]))).toMatch(/^Closed as benign by Admin, [^.]+$/);
    expect(lastHumanAction(caseWith('needs_human', [decision, close]))).toMatch(/^Closed as benign by Admin, [^.]+$/);
    const reopen = { ts: iso(0), event: 'analyst_action', action: 'reopen', analyst: 'lee' };
    expect(lastHumanAction(caseWith('open', [close, decision, reopen]))).toMatch(/^Reopened by lee, [^.]+$/);
  });

  it('skips events that arrived between the close and the decision', () => {
    const attach = { ts: iso(2), event: 'attach', added_events: 3 };
    expect(lastHumanAction(caseWith('open', [close, attach, decision]))).toMatch(/then replaced the close\.$/);
  });
});

describe('Routing score with two decimals', () => {
  it('parses and shows a decimal score and keeps an older whole number', () => {
    expect(awaitingWords('available-signal routing score 69.5 is below the auto-investigate floor 70')).toBe(
      'Its routing score, 69.5, is below the floor of 70 for an automatic investigation.',
    );
    expect(awaitingWords('available-signal routing score 32.63 is below the auto-investigate floor 70')).toBe(
      'Its routing score, 32.63, is below the floor of 70 for an automatic investigation.',
    );
    expect(awaitingWords('available-signal routing score 45 is below the auto-investigate floor 70')).toBe(
      'Its routing score, 45, is below the floor of 70 for an automatic investigation.',
    );
  });
});

describe('Rank line operands', () => {
  it('prints operands that give the printed result when worked by hand', () => {
    // 1.05 + 0.5 x (3.0167 - 1.05) = 2.03335, shown as 2.03. Printed as 3.02 it would work
    // out to 2.035, which a reader rounds to 2.04.
    const line = rankLineOverRun('p50', 0.5, [1.05, 3.0167], 0, 2)!;
    expect(line.result).toBe('2.03 minutes');
    expect(line.expression).toBe('rank 0.5 x (2 - 1) = 0.5; 1.05 + 0.5 x (3.017 - 1.05)');
    const [lo, f, hi] = [1.05, 0.5, 3.017];
    expect(Math.round((lo + f * (hi - lo)) * 100) / 100).toBe(2.03);
  });
});

describe('A whole percent tile ends on its figure', () => {
  it('the Auto-close panel reads 68%, the shown figure, never 67.9%', () => {
    const exp = autoCloseRateExplanation(
      { current: { auto_closed: 38, decided: 56 } } as unknown as Parameters<typeof autoCloseRateExplanation>[0],
      'last 7 days',
    )!;
    expect(exp.display).toBe('68%');
    expect(exp.summary).toContain('= 67.9%, shown as 68%');
    expect(exp.steps.at(-1)).toEqual({ label: 'Shown', expression: 'floor(67.9 + 0.5)', result: '68%' });
  });
});

describe('Change chip counts', () => {
  it('prints the counts behind both windows of a rate', () => {
    const exp = compareChipExplanation(
      {
        value: 0.6964,
        prev: 0.3333,
        delta_pct: 108.9,
        numerator: 39,
        denominator: 56,
        prev_numerator: 10,
        prev_denominator: 30,
      },
      'FP rate',
      'rate',
      168,
      'verdicted cases',
    )!;
    expect(exp.summary).toContain('69.64% (39 of 56 verdicted cases)');
    expect(exp.summary).toContain('33.33% (10 of 30 verdicted cases)');
    expect(exp.inputs.map((i) => i.value)).toEqual(['69.64% (39 of 56 verdicted cases)', '33.33% (10 of 30 verdicted cases)']);
  });

  it('an older server without counts keeps the plain values', () => {
    const exp = compareChipExplanation({ value: 0.6964, prev: 0.3333, delta_pct: 108.9 }, 'FP rate', 'rate', 168, 'verdicted cases')!;
    expect(exp.inputs.map((i) => i.value)).toEqual(['69.64%', '33.33%']);
  });
});

function metric(over: Partial<AgentComparisonMetric>): AgentComparisonMetric {
  return {
    label: 'Analyst-reported verdict agreement',
    unit: 'ratio',
    good_direction: 'up',
    current: { value: 0.82, available: true, status: 'enough_data', reason: '', sample_count: 46, minimum_sample: 30 },
    baseline: { value: 0.75, available: true, status: 'enough_data', reason: '', sample_count: 120, minimum_sample: 30 },
    delta: { percentage_points: 7 },
    direction: 'improving',
    definition: { formula: '(agree + 0.5 × partial) / graded', numerator: 'n', denominator: 'd', eligibility: 'e', caveats: 'c' },
    ...over,
  } as AgentComparisonMetric;
}

describe('Agent effectiveness comparison figures', () => {
  it('agreement works the plain ratio from the counts and ends on the adjusted figure', () => {
    const m = metric({
      current: {
        value: 0.82, available: true, status: 'enough_data', reason: '', sample_count: 46, minimum_sample: 30,
        total_graded_cases: 46, comparable_graded_cases: 46, feedback_counts: { agree: 30, partial: 6, disagree: 10 },
      },
    });
    const exp = agreementComparisonExplanation(m, '82.0%')!;
    expect(exp.display).toBe('82.0%');
    expect(exp.summary).toContain('(30 agreed + 0.5 x 6 partial) / 46 graded = 71.7%');
    expect(exp.steps.map((s) => s.result)).toEqual(['33', '71.7%', '82.0%']);
  });

  it('correction divides the corrected cases by the graded ones', () => {
    const m = metric({
      label: 'Material analyst correction rate',
      current: {
        value: 0.1, available: true, status: 'enough_data', reason: '', sample_count: 46, minimum_sample: 30,
        total_graded_cases: 46, comparable_graded_cases: 40, material_corrections: 5,
      },
    });
    const exp = correctionComparisonExplanation(m, '10.0%')!;
    expect(exp.summary).toContain('5 corrected / 46 graded = 10.9%');
    expect(exp.steps.at(-1)?.result).toBe('10.0%');
  });

  it('turnaround names the median, the quartiles and the count', () => {
    const m = metric({
      label: 'Human review turnaround',
      unit: 'minutes',
      current: {
        value: 42, available: true, status: 'enough_data', reason: '', sample_count: 12, minimum_sample: 10,
        q1_minutes: 20, q3_minutes: 70, p90_minutes: 130,
      },
    });
    const exp = turnaroundComparisonExplanation(m, '42m')!;
    expect(exp.summary).toMatch(/^Median 42m over 12 human-reviewed cases/);
    expect(exp.steps.at(-1)?.result).toBe('42m');
  });

  it('a figure with no counts has no explanation, never an invented one', () => {
    expect(agreementComparisonExplanation(metric({}), '82.0%')).toBeNull();
    const none = metric({ current: { value: null, available: false, status: 'unavailable', reason: '', sample_count: 0, minimum_sample: 10 } });
    expect(turnaroundComparisonExplanation(none, '')).toBeNull();
  });
});

describe('A person median, the Standup counts and the tuner z', () => {
  it("names the person's cases behind their median", () => {
    const person = { username: 'lee', display_name: 'Lee', kind: 'account', median_ack_seconds: 260, ack_samples: 12 } as unknown as PersonActivity;
    const exp = explainPersonMedian(person, '4m 20s', 'last 7 days')!;
    expect(exp.summary).toBe('Median 4m 20s over 12 cases Lee was the first person to acknowledge, last 7 days.');
    expect(exp.display).toBe('4m 20s');
  });

  it('splits the action items by status and counts the sign-offs', () => {
    const items = [
      { id: '1', title: 'a', owner: null, status: 'open', created_at: '', note: '' },
      { id: '2', title: 'b', owner: null, status: 'in_progress', created_at: '', note: '' },
      { id: '3', title: 'c', owner: null, status: 'done', created_at: '', note: '' },
    ];
    // The shift report sends the items not marked done: the count is open + in progress,
    // with no "+ 0 done" and no claim that a done item stays in the list.
    const listed = explainActionItems(items.slice(0, 2));
    expect(listed.display).toBe('2');
    expect(listed.summary).toBe('2 action items across shifts: 1 open + 1 in progress.');
    expect(listed.steps[0]).toEqual({ label: 'Action items', expression: '1 + 1', result: '2' });
    expect(listed.caveats).toEqual(['An item marked done leaves the list and the count.']);
    // An item marked done that is still on screen before the reload is counted as done.
    const exp = explainActionItems(items);
    expect(exp.display).toBe('3');
    expect(exp.summary).toBe('3 action items across shifts: 1 open + 1 in progress + 1 done.');
    expect(exp.steps[0]).toEqual({ label: 'Action items', expression: '1 + 1 + 1', result: '3' });
    const acks = explainHandoffAcks(
      [
        { user: 'lee', window: 'w', at: '', note: '' },
        { user: 'asha', window: 'w', at: '', note: '' },
      ] as Parameters<typeof explainHandoffAcks>[0],
      '2026-11-26/day',
    );
    expect(acks.summary).toBe("2 acknowledgements of this shift's handoff, by 2 people.");
  });

  it('the noisiest rules name the z the tuner used', () => {
    const noise = { rule_id: 'r', total: 30, analyst_samples: 30, fp: 30, fp_rate: 0.8865 } as unknown as Parameters<typeof noisyRuleExplanation>[0];
    expect(noisyRuleExplanation(noise)?.summary).toContain('95% range');
    const z = noisyRuleExplanation(noise, 2.576)!;
    expect(z.summary).toContain('range at z = 2.58');
    expect(z.inputs.find((i) => i.key === 'z')?.value).toBe('2.58');
  });
});
