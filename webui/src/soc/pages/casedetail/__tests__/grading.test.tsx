/**
 * grading.tsx — the DERIVED AI-decision grading module (Round-7 #10, W0.12).
 *
 * Covers:
 *   1. the FULL 3×6 verdict×disposition derive map (deriveAgreement).
 *   2. the rendered agree/override badge text (GradingFields, from props).
 *   3. gradingToFeedbackInput shape-parity with the existing CaseFeedbackInput.
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
  GradingFields,
  GradingHistory,
  OUTCOME_OPTIONS,
  OUTCOME_UNSET,
  OutcomeField,
  type GradingDraft,
} from '../grading';

/* --------------------------------------------------------- 1. derive map --- */

// Explicit oracle (NOT computed from the same map the SUT uses).
const EXPECT: Record<string, Record<string, 'match' | 'override' | 'none'>> = {
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
  NEEDS_HUMAN: {
    true_positive: 'override',
    false_positive: 'override',
    benign: 'override',
    suspicious: 'match',
    duplicate: 'none',
    undetermined: 'match',
  },
};

describe('deriveAgreement — the full 3×6 map', () => {
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
    expect(agreementText(a)).toBe('Overrides AI verdict (False positive → True positive)');
    expect(agreementText(deriveAgreement('TRUE_POSITIVE', 'true_positive'))).toBe('Matches AI verdict');
    expect(agreementText(deriveAgreement('TRUE_POSITIVE', 'duplicate'))).toBeNull();
  });
});

/* ----------------------------------------------------- 2. badge from props --- */

describe('GradingFields — derived badge from read-only props', () => {
  it('renders "Overrides AI verdict (X → Y)" on a mismatch + reveals the miss line', () => {
    render(
      <GradingFields
        verdict="FALSE_POSITIVE"
        disposition="true_positive"
        draft={emptyGradingDraft()}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByText('Overrides AI verdict (False positive → True positive)'),
    ).toBeInTheDocument();
    // The "What did the AI miss?" line is revealed only on a mismatch.
    expect(screen.getByLabelText(/what did the ai miss/i)).toBeInTheDocument();
  });

  it('renders "Matches AI verdict" on a match + hides the miss line', () => {
    render(
      <GradingFields
        verdict="TRUE_POSITIVE"
        disposition="true_positive"
        draft={emptyGradingDraft()}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Matches AI verdict')).toBeInTheDocument();
    expect(screen.queryByLabelText(/what did the ai miss/i)).not.toBeInTheDocument();
  });

  it('hides the derived badge when there is no disposition', () => {
    render(<GradingFields verdict="TRUE_POSITIVE" draft={emptyGradingDraft()} onChange={() => {}} />);
    expect(screen.queryByText(/matches ai verdict/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/overrides ai verdict/i)).not.toBeInTheDocument();
  });

  it('keeps the 3 quality stars behind the "Rate in detail" disclosure', () => {
    render(
      <GradingFields
        verdict="TRUE_POSITIVE"
        disposition="true_positive"
        draft={emptyGradingDraft()}
        onChange={() => {}}
      />,
    );
    // Collapsed by default — the disclosure trigger is present, the star rows are not.
    expect(screen.getByRole('button', { name: /rate in detail/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/accuracy: 1 of 5/i)).not.toBeInTheDocument();
  });
});

/* --------------------------------------------------- 3. shape-parity + libs --- */

describe('gradingToFeedbackInput — shape-parity with CaseFeedbackInput', () => {
  it('maps stars→0..1, keeps only-present fields, passes analyst through', () => {
    const draft: GradingDraft = {
      assessment: 'disagree',
      accuracy: 5,
      reasoning_quality: 4,
      action_appropriateness: 3,
      actual_outcome: 'true_positive',
      time_saved_minutes: 30,
      comment: '  missed lateral movement  ',
    };
    const body: CaseFeedbackInput = gradingToFeedbackInput(draft, '  jdoe  ');
    expect(body).toEqual({
      assessment: 'disagree',
      accuracy: 1,
      reasoning_quality: 0.8,
      action_appropriateness: 0.6,
      actual_outcome: 'true_positive',
      time_saved_minutes: 30,
      comment: 'missed lateral movement',
      analyst: 'jdoe',
    });
  });

  it('defaults assessment to "agree" and omits unset fields on an empty draft', () => {
    const body = gradingToFeedbackInput(emptyGradingDraft());
    expect(body).toEqual({ assessment: 'agree' });
    expect(Object.keys(body)).toEqual(['assessment']);
  });

  it('drops zero-star / zero-time / whitespace-only / absent-analyst fields', () => {
    const body = gradingToFeedbackInput({
      accuracy: 0,
      reasoning_quality: 0,
      action_appropriateness: 0,
      time_saved_minutes: 0,
      comment: '   ',
    });
    expect(body).toEqual({ assessment: 'agree' });
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

describe('the confirmed-outcome control (G1 — Channel A)', () => {
  it('offers EXACTLY the vocabulary the backend enum declares', () => {
    // The compile-time guard (`FeedbackOutcomeCoverage`) proves coverage against the
    // GENERATED type. This proves the option list matches the committed SPEC, so a
    // hand-written list can never quietly drift from `constants.FeedbackOutcome`.
    const spec = JSON.parse(readFileSync(OPENAPI, 'utf8'));
    const declared: string[] = spec.components.schemas.FeedbackOutcome.enum;
    expect(OUTCOME_OPTIONS.map((o) => o.value).slice().sort()).toEqual(
      [...declared].sort(),
    );
    expect(declared).toContain(OUTCOME_UNSET);
  });

  it('is rendered by GradingFields — the field is settable, not just typed', () => {
    // The whole G1 defect: `actual_outcome` was typed, read for a dirty check and
    // forwarded on send, but NOTHING in the UI could ever set it.
    render(
      <GradingFields
        verdict="TRUE_POSITIVE"
        disposition="true_positive"
        draft={emptyGradingDraft()}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/what actually happened/i)).toBeInTheDocument();
  });

  it('is offered on an AGREED close too, not only on an override', () => {
    render(
      <GradingFields
        verdict="TRUE_POSITIVE"
        disposition="true_positive"
        draft={emptyGradingDraft()}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText('Matches AI verdict')).toBeInTheDocument();
    // The "what did the AI miss" line stays override-only; ground truth does not.
    expect(screen.queryByLabelText(/what did the ai miss/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/what actually happened/i)).toBeInTheDocument();
  });

  it('writes the chosen member into the draft', () => {
    const onChange = vi.fn();
    render(<OutcomeField onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/what actually happened/i));
    fireEvent.click(screen.getByRole('option', { name: /false positive/i }));
    expect(onChange).toHaveBeenCalledWith('false_positive');
  });

  it('clears the draft on "Not stated" rather than persisting the unknown member', () => {
    const onChange = vi.fn();
    render(<OutcomeField value="false_positive" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/what actually happened/i));
    fireEvent.click(screen.getByRole('option', { name: /not stated/i }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('reaches the wire body once chosen', () => {
    expect(gradingToFeedbackInput({ actual_outcome: 'false_negative' })).toEqual({
      assessment: 'agree',
      actual_outcome: 'false_negative',
    });
    // …and an unstated outcome still posts nothing, so the backend default applies.
    expect(gradingToFeedbackInput({})).toEqual({ assessment: 'agree' });
  });

  it('says out loud that the grade itself is not a label', () => {
    render(<OutcomeField onChange={() => {}} />);
    expect(
      screen.getByText(/only part of a grade that becomes\s+analyst-confirmed ground truth/i),
    ).toBeInTheDocument();
  });
});
