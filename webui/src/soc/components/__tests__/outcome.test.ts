/**
 * caseOutcome — the ONE outcome helper (Round 12, SPEC D15). Pins the classification
 * gate to the backend ground-truth authority (`analyst_outcomes.py`): a disposition is
 * the analyst's only with `decision_by === 'analyst'` AND an explicit classification
 * history entry. The analyst's bug — a NEEDS_HUMAN case closed as a false positive still
 * reading "Needs human review — closed" — is the first row below.
 */
import { describe, expect, it } from 'vitest';

import type { Case } from '@/lib/types';
import {
  agreementWords,
  aiVerdictLine,
  caseOutcome,
  classificationEntry,
  confidencePercent,
  isHumanClosed,
  isHumanSettled,
  outcomeAgreement,
} from '../outcome';

const at = '2026-10-09T10:00:00Z';

function mk(over: Partial<Case> & { history?: unknown[] } = {}): Case {
  return {
    case_id: 'c1',
    title: 'Case',
    status: 'needs_human',
    verdict: 'NEEDS_HUMAN',
    confidence: 0.75,
    decision_by: 'agent',
    ...over,
  } as unknown as Case;
}

const closeEntry = (disposition: string, action = 'close') => ({
  event: 'analyst_action',
  action,
  analyst: 'aryan',
  ts: at,
  classified_disposition: disposition,
});

describe('caseOutcome — the analyst bug', () => {
  it('a NEEDS_HUMAN case closed as false positive reads as the analyst outcome', () => {
    const o = caseOutcome(
      mk({
        status: 'closed',
        decision_by: 'analyst',
        disposition: 'false_positive',
        history: [closeEntry('false_positive')],
      }),
    );
    expect(o.source).toBe('analyst');
    expect(o.headline).toBe('Closed as false positive');
    expect(o.aiLine).toBe('AI verdict: Needs human review (75%)');
    expect(o.disposition).toBe('false_positive');
    expect(o.by).toBe('aryan');
    expect(o.at).toBe(at);
    // Settling the hand-off is never a disagreement with the model.
    expect(o.agreement).toBe('resolved');
    expect(o.headline).not.toMatch(/needs human/i);
    expect(o.shortLabel).toBe('False positive');
  });
});

describe('caseOutcome — precedence table', () => {
  const rows: Array<[string, Case, { source: string; headline: string; shortLabel?: string }]> = [
    [
      'set_disposition on an open case',
      mk({
        status: 'on_hold',
        decision_by: 'analyst',
        disposition: 'suspicious',
        history: [{ event: 'analyst_action', action: 'set_disposition', analyst: 'a', ts: at }],
      }),
      { source: 'analyst', headline: 'Classified as suspicious — on hold' },
    ],
    [
      'confirm_fp closes as false positive',
      mk({
        status: 'closed',
        verdict: 'FALSE_POSITIVE',
        decision_by: 'analyst',
        disposition: 'false_positive',
        history: [{ event: 'analyst_action', action: 'confirm_fp', analyst: 'a', ts: at }],
      }),
      { source: 'analyst', headline: 'Closed as false positive' },
    ],
    [
      'declared resolve',
      mk({
        status: 'resolved',
        verdict: 'TRUE_POSITIVE',
        decision_by: 'analyst',
        disposition: 'true_positive',
        history: [closeEntry('true_positive', 'resolve')],
      }),
      { source: 'analyst', headline: 'Resolved as true positive' },
    ],
    [
      'undeclared close keeps the model-derived disposition out of the headline',
      mk({
        status: 'closed',
        verdict: 'TRUE_POSITIVE',
        decision_by: 'analyst',
        disposition: 'true_positive',
        history: [{ event: 'analyst_action', action: 'close', analyst: 'a', ts: at }],
      }),
      {
        source: 'analyst_unrecorded',
        headline: 'Closed by analyst: outcome not recorded',
        shortLabel: 'Outcome not recorded',
      },
    ],
    [
      'analyst policy close',
      mk({ status: 'closed', verdict: 'NONE', decision_by: 'analyst_policy' }),
      { source: 'analyst_policy', headline: 'Closed by analyst policy (declared benign)' },
    ],
    [
      'agent auto-close',
      mk({ status: 'closed', verdict: 'FALSE_POSITIVE', confidence: 0.97, decision_by: 'agent' }),
      { source: 'agent_auto', headline: 'Auto-closed as false positive', shortLabel: 'Auto-closed' },
    ],
    [
      'open NEEDS_HUMAN case keeps the AI-led headline',
      mk(),
      { source: 'pending', headline: 'Needs human review', shortLabel: 'AI: Needs human' },
    ],
    [
      'open true positive',
      mk({ status: 'escalated', verdict: 'TRUE_POSITIVE', confidence: 0.9 }),
      { source: 'pending', headline: 'Likely a true positive — escalated', shortLabel: 'AI: True positive 90%' },
    ],
  ];
  it.each(rows)('%s', (_name, c, expected) => {
    const o = caseOutcome(c);
    expect(o.source).toBe(expected.source);
    expect(o.headline).toBe(expected.headline);
    if (expected.shortLabel) expect(o.shortLabel).toBe(expected.shortLabel);
  });

  it('a disposition VALUE alone (no classification entry) is never the analyst’s', () => {
    const o = caseOutcome(mk({ status: 'needs_human', decision_by: 'analyst', disposition: 'true_positive' }));
    expect(o.source).toBe('pending');
    expect(o.disposition).toBeNull();
  });

  it('an agent-stamped history entry never qualifies', () => {
    const c = mk({
      status: 'closed',
      decision_by: 'agent',
      disposition: 'false_positive',
      history: [closeEntry('false_positive')],
    });
    expect(caseOutcome(c).source).toBe('agent_auto');
  });
});

describe('outcome helpers', () => {
  it('classificationEntry picks the newest explicit classification', () => {
    const entry = classificationEntry(
      mk({
        history: [
          { event: 'analyst_action', action: 'set_disposition', analyst: 'old', ts: '2026-01-01T00:00:00Z' },
          { event: 'analyst_action', action: 'comment', analyst: 'x', ts: at },
          closeEntry('benign'),
        ],
      }),
    );
    expect(entry).toEqual({ disposition: 'benign', by: 'aryan', at, action: 'close' });
    expect(classificationEntry(mk({ history: [{ event: 'analyst_action', action: 'close' }] }))).toBeNull();
  });

  it('agreement: NEEDS_HUMAN settled is "resolved", never "overrides"', () => {
    expect(outcomeAgreement('NEEDS_HUMAN', 'false_positive')).toBe('resolved');
    expect(outcomeAgreement('NEEDS_HUMAN', 'benign')).toBe('resolved');
    expect(outcomeAgreement('NEEDS_HUMAN', 'suspicious')).toBe('agrees');
    expect(outcomeAgreement('TRUE_POSITIVE', 'false_positive')).toBe('overrides');
    expect(outcomeAgreement('FALSE_POSITIVE', 'benign')).toBe('agrees');
    expect(outcomeAgreement('TRUE_POSITIVE', 'duplicate')).toBeNull();
    expect(agreementWords('resolved')).toBe('Resolves the AI hand-off');
  });

  it('aiVerdictLine and confidencePercent accept 0..1 and 0..100', () => {
    expect(aiVerdictLine('TRUE_POSITIVE', 90)).toBe('AI verdict: True positive (90%)');
    expect(aiVerdictLine('NONE', 0.5)).toBeNull();
    expect(confidencePercent(0.754)).toBe(75);
    expect(confidencePercent('x')).toBeNull();
  });

  it('isHumanClosed / isHumanSettled', () => {
    expect(isHumanClosed(mk({ status: 'closed', decision_by: 'analyst' }))).toBe(true);
    expect(isHumanClosed(mk({ status: 'closed', decision_by: 'agent' }))).toBe(false);
    expect(isHumanClosed(mk({ status: 'needs_human', decision_by: 'analyst' }))).toBe(false);
    expect(isHumanSettled(caseOutcome(mk({ status: 'closed', decision_by: 'analyst_policy' })))).toBe(true);
    expect(isHumanSettled(caseOutcome(mk()))).toBe(false);
  });
});
