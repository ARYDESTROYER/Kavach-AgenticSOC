/**
 * grading.tsx: the DERIVED AI-decision grading module (Round-7 #10, W0.12; Round 15 D4.4).
 *
 * Covers:
 *   1. the FULL 3×6 verdict×disposition derive map (deriveAgreement) and the D4.3 note rule.
 *   2. the agreement shown as text (AgreementLine) and the rating body (GradingFields,
 *      RateTheAi: stars, and "What did the AI miss?" on an override only).
 *   3. gradingToFeedbackInput shape-parity with the existing CaseFeedbackInput, which
 *      never carries `actual_outcome` (D4.4).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CaseFeedbackInput } from '@/lib/api';
import {
  deriveAgreement,
  agreementText,
  emptyGradingDraft,
  gradingToFeedbackInput,
  isGradingDirty,
  starsToScore,
  requiresDisagreementNote,
  AgreementLine,
  GradingFields,
  GradingHistory,
  OUTCOME_OPTIONS,
  RateTheAi,
  outcomeWords,
  type GradingDraft,
} from '../grading';

/* --------------------------------------------------------- 1. derive map --- */

// Explicit oracle (NOT computed from the same map the SUT uses).
const EXPECT: Record<string, Record<string, 'match' | 'override' | 'resolved' | 'none'>> = {
  TRUE_POSITIVE: {
    true_positive: 'match',
    false_positive: 'override',
    benign: 'override',
    suspicious: 'override',
    duplicate: 'none',
    undetermined: 'override',
  },
  FALSE_POSITIVE: {
    true_positive: 'override',
    false_positive: 'match',
    benign: 'match',
    suspicious: 'override',
    duplicate: 'none',
    undetermined: 'override',
  },
  // Round 12 (D15): a concrete outcome RESOLVES the NEEDS_HUMAN hand-off; it is never
  // an override (agent-effectiveness must not count it as a disagreement).
  NEEDS_HUMAN: {
    true_positive: 'resolved',
    false_positive: 'resolved',
    benign: 'resolved',
    suspicious: 'match',
    duplicate: 'none',
    undetermined: 'match',
  },
};

describe('deriveAgreement: the full 3×6 map', () => {
  for (const verdict of Object.keys(EXPECT)) {
    for (const disposition of Object.keys(EXPECT[verdict])) {
      const want = EXPECT[verdict][disposition];
      it(`${verdict} × ${disposition} → ${want}`, () => {
        expect(deriveAgreement(verdict, disposition).kind).toBe(want);
      });
    }
  }

  it('carries the derived assessment on match/override', () => {
    expect(deriveAgreement('TRUE_POSITIVE', 'true_positive')).toMatchObject({
      kind: 'match',
      assessment: 'agree',
    });
    expect(deriveAgreement('FALSE_POSITIVE', 'true_positive')).toMatchObject({
      kind: 'override',
      assessment: 'disagree',
    });
  });

  it('settles a NEEDS_HUMAN hand-off with NO assessment: neither disagree nor an unstated agree', () => {
    const a = deriveAgreement('NEEDS_HUMAN', 'false_positive');
    expect(a).toEqual({ kind: 'resolved', toLabel: 'False positive' });
    expect(a).not.toHaveProperty('assessment');
    expect(agreementText(a)).toBe("Your classification settles the AI's hand-off (Needs human review → False positive)");
  });

  it('is none when verdict OR disposition is missing (hide badge)', () => {
    expect(deriveAgreement(undefined, 'true_positive').kind).toBe('none');
    expect(deriveAgreement('TRUE_POSITIVE', undefined).kind).toBe('none');
    expect(deriveAgreement(null, null).kind).toBe('none');
    expect(deriveAgreement('', '').kind).toBe('none');
  });

  it('is none for an unknown verdict', () => {
    expect(deriveAgreement('SOMETHING_ELSE', 'true_positive').kind).toBe('none');
  });

  it('normalises casing / separators on both axes', () => {
    expect(deriveAgreement('true-positive', 'True Positive').kind).toBe('match');
    expect(deriveAgreement('false_positive', 'BENIGN').kind).toBe('match');
  });

  it('builds the override text with humanized from → to labels', () => {
    const a = deriveAgreement('FALSE_POSITIVE', 'true_positive');
    expect(agreementText(a)).toBe('Your classification overrides the AI (False positive → True positive)');
    expect(agreementText(deriveAgreement('TRUE_POSITIVE', 'true_positive'))).toBe('Your classification agrees with the AI');
    expect(agreementText(deriveAgreement('TRUE_POSITIVE', 'duplicate'))).toBeNull();
  });
});

/* ------------------------------------- 2. agreement text and the rating body --- */

describe('AgreementLine: the derived agreement as text (D4.4)', () => {
  it('renders "Your classification overrides the AI (X → Y)" on a mismatch', () => {
    render(<AgreementLine verdict="FALSE_POSITIVE" disposition="true_positive" />);
    expect(screen.getByText('Your classification overrides the AI (False positive → True positive)')).toBeInTheDocument();
  });

  it('renders "Your classification agrees with the AI" on a match, with the AI line beside it', () => {
    render(<AgreementLine verdict="TRUE_POSITIVE" disposition="true_positive" aiLine="AI verdict: True positive (80%)" />);
    expect(screen.getByText('Your classification agrees with the AI')).toBeInTheDocument();
    expect(screen.getByText('AI verdict: True positive (80%)')).toBeInTheDocument();
  });

  it('says nothing about agreement before a disposition is chosen', () => {
    const { container } = render(<AgreementLine verdict="TRUE_POSITIVE" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the note rule (D4.3)', () => {
  it('asks for a note on an override only', () => {
    expect(requiresDisagreementNote('TRUE_POSITIVE', 'false_positive')).toBe(true);
    expect(requiresDisagreementNote('FALSE_POSITIVE', 'suspicious')).toBe(true);
    expect(requiresDisagreementNote('TRUE_POSITIVE', 'true_positive')).toBe(false);
    // A Needs human review resolution, a duplicate and a case with no verdict never do.
    expect(requiresDisagreementNote('NEEDS_HUMAN', 'true_positive')).toBe(false);
    expect(requiresDisagreementNote('TRUE_POSITIVE', 'duplicate')).toBe(false);
    expect(requiresDisagreementNote(undefined, 'false_positive')).toBe(false);
  });
});

describe('GradingFields and RateTheAi: the rating body', () => {
  it('reveals "What did the AI miss?" on a mismatch only', () => {
    const { rerender } = render(
      <GradingFields verdict="FALSE_POSITIVE" disposition="true_positive" draft={emptyGradingDraft()} onChange={() => {}} />,
    );
    expect(screen.getByLabelText(/what did the ai miss/i)).toBeInTheDocument();
    rerender(
      <GradingFields verdict="TRUE_POSITIVE" disposition="true_positive" draft={emptyGradingDraft()} onChange={() => {}} />,
    );
    expect(screen.queryByLabelText(/what did the ai miss/i)).not.toBeInTheDocument();
  });

  it('never asks what actually happened (the disposition is the classification)', () => {
    render(<GradingFields verdict="TRUE_POSITIVE" disposition="true_positive" draft={emptyGradingDraft()} onChange={() => {}} />);
    expect(screen.queryByLabelText(/what actually happened/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('writes a star rating into the draft', () => {
    const onChange = vi.fn();
    render(<GradingFields verdict="TRUE_POSITIVE" disposition="true_positive" draft={emptyGradingDraft()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning quality: 4 of 5' }));
    expect(onChange).toHaveBeenCalledWith({ reasoning_quality: 4 });
  });

  it('keeps the 3 quality stars behind the collapsed "Rate the AI (optional)" disclosure', () => {
    render(<RateTheAi verdict="TRUE_POSITIVE" disposition="true_positive" draft={emptyGradingDraft()} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /rate the ai \(optional\)/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/accuracy: 1 of 5/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /rate the ai \(optional\)/i }));
    expect(screen.getByRole('button', { name: 'Accuracy: 1 of 5' })).toBeInTheDocument();
  });
});

/* --------------------------------------------------- 3. shape-parity + libs --- */

describe('gradingToFeedbackInput: shape-parity with CaseFeedbackInput', () => {
  it('maps stars→0..1, keeps only-present fields, passes analyst through', () => {
    const draft: GradingDraft = {
      assessment: 'disagree',
      accuracy: 5,
      reasoning_quality: 4,
      action_appropriateness: 3,
      time_saved_minutes: 30,
      comment: '  missed lateral movement  ',
    };
    const body: CaseFeedbackInput = gradingToFeedbackInput(draft, '  jdoe  ');
    expect(body).toEqual({
      assessment: 'disagree',
      accuracy: 1,
      reasoning_quality: 0.8,
      action_appropriateness: 0.6,
      time_saved_minutes: 30,
      comment: 'missed lateral movement',
      analyst: 'jdoe',
    });
    // D4.4: the Console never sets `actual_outcome` from a close.
    expect(body).not.toHaveProperty('actual_outcome');
  });

  it('never defaults assessment to "agree": an empty draft posts no fields at all', () => {
    // A defaulted "agree" made every settled Needs-human close count toward Agreement.
    const body = gradingToFeedbackInput(emptyGradingDraft());
    expect(body).toEqual({});
    expect(gradingToFeedbackInput({ assessment: 'agree' })).toEqual({ assessment: 'agree' });
    expect(gradingToFeedbackInput({ assessment: 'disagree' })).toEqual({ assessment: 'disagree' });
  });

  it('drops zero-star / zero-time / whitespace-only / absent-analyst fields', () => {
    const body = gradingToFeedbackInput({
      accuracy: 0,
      reasoning_quality: 0,
      action_appropriateness: 0,
      time_saved_minutes: 0,
      comment: '   ',
    });
    expect(body).toEqual({});
  });

  it('starsToScore maps the 1-5 ladder (0/undefined → undefined)', () => {
    expect(starsToScore(0)).toBeUndefined();
    expect(starsToScore(undefined)).toBeUndefined();
    expect(starsToScore(1)).toBeCloseTo(0.2);
    expect(starsToScore(5)).toBe(1);
  });
});

describe('grading helpers', () => {
  it('emptyGradingDraft is a fresh empty object', () => {
    expect(emptyGradingDraft()).toEqual({});
  });

  it('isGradingDirty flags any non-default signal', () => {
    expect(isGradingDirty({})).toBe(false);
    expect(isGradingDirty({ assessment: 'agree' })).toBe(false);
    expect(isGradingDirty({ assessment: 'disagree' })).toBe(true);
    expect(isGradingDirty({ accuracy: 3 })).toBe(true);
    expect(isGradingDirty({ comment: 'x' })).toBe(true);
    expect(isGradingDirty({ comment: '   ' })).toBe(false);
    expect(isGradingDirty({ time_saved_minutes: 10 })).toBe(true);
  });

  it('GradingHistory renders prior gradings newest-first, comments as plain text (#9)', () => {
    render(
      <GradingHistory
        feedback={[
          { ts: '2026-07-01T00:00:00Z', analyst: 'a1', assessment: 'agree', comment: 'looks right' },
          {
            ts: '2026-07-02T00:00:00Z',
            analyst: 'a2',
            assessment: 'disagree',
            comment: '<img src=x> not markup',
          },
        ]}
      />,
    );
    // Newest (a2 / disagree) appears; the injected tag is inert plain text.
    expect(screen.getByText('<img src=x> not markup')).toBeInTheDocument();
    expect(screen.getByText('looks right')).toBeInTheDocument();
    expect(screen.getByText('Overrode AI')).toBeInTheDocument();
  });

  it('GradingHistory renders nothing without prior feedback', () => {
    const { container } = render(<GradingHistory feedback={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});


/* ----------------------------------------------- 4. ground-truth intake (G1) --- */

const OPENAPI = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../openapi.json',
);

describe('a stored outcome is read back, never asked (D4.1, D4.4)', () => {
  it('words EXACTLY the vocabulary the backend enum declares', () => {
    // The compile-time guard (`FeedbackOutcomeCoverage`) proves coverage against the
    // GENERATED type. This proves the list matches the committed SPEC, so a hand-written
    // list can never quietly drift from `constants.FeedbackOutcome`.
    const spec = JSON.parse(readFileSync(OPENAPI, 'utf8'));
    const declared: string[] = spec.components.schemas.FeedbackOutcome.enum;
    expect(OUTCOME_OPTIONS.map((o) => o.value).slice().sort()).toEqual([...declared].sort());
  });

  it('reads a stored outcome in short words', () => {
    expect(outcomeWords('true_positive')).toBe('True positive');
    expect(outcomeWords('false_negative')).toBe('False negative');
    expect(outcomeWords('')).toBe('');
  });

  it('shows a stored outcome in the grading history, not an unstated one', () => {
    render(
      <GradingHistory
        feedback={[
          { ts: '2026-07-01T00:00:00Z', analyst: 'a1', assessment: 'agree', actual_outcome: 'false_positive' },
          { ts: '2026-07-02T00:00:00Z', analyst: 'a2', assessment: 'agree', actual_outcome: 'unknown' },
        ]}
      />,
    );
    expect(screen.getByText('False positive')).toBeInTheDocument();
    expect(screen.queryByText('Not stated')).toBeNull();
  });
});
