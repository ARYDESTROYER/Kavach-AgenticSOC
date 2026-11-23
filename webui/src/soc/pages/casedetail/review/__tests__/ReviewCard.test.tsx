/**
 * Round 15 (SPEC D6.6, D6.9, D6.11): the auto-close review card kit.
 *
 *   - "What was it?" has no preselected answer; Compare with the AI waits for one;
 *   - the AI verdict appears only after Compare, and the answer is then locked;
 *   - Record review posts the answer, the note, the ratings (0.2 to 1.0) and the time
 *     from opening the card to submitting (`elapsed_ms`);
 *   - a disagreement offers Reopen case and Reopen and escalate to someone who can close
 *     cases (two calls with `review_via`), and says when the second one failed;
 *   - anyone else reads that someone who can close cases has been asked to look.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Case } from '@/lib/types';
import type { ReviewResult } from '@/lib/types-reviews';
import { REVIEW_BAND_TEXT, ReviewCard, comparisonText, reviewAgrees } from '../ReviewCard';

const CASE = {
  case_id: 'case-9',
  status: 'closed',
  decision_by: 'agent',
  verdict: 'FALSE_POSITIVE',
  confidence: 0.91,
} as unknown as Case;

function setup(props: Partial<React.ComponentProps<typeof ReviewCard>> = {}, result: ReviewResult = { agrees: true }) {
  let clock = 1_000;
  const record = vi.fn(async () => result);
  const caseAction = vi.fn(async () => CASE);
  render(
    <ReviewCard
      caseData={CASE}
      record={record}
      caseAction={caseAction}
      now={() => clock}
      {...props}
    />,
  );
  return { record, caseAction, advance: (ms: number) => (clock += ms) };
}

describe('ReviewCard', () => {
  it('asks first, with no preselection, and shows the AI only after Compare', () => {
    setup({ pending: true });
    expect(screen.getByText(REVIEW_BAND_TEXT)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(radios.every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    const compare = screen.getByRole('button', { name: 'Compare with the AI' });
    expect(compare).toBeDisabled();
    expect(screen.queryByText(/AI verdict/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Benign' }));
    expect(compare).toBeEnabled();
    fireEvent.click(compare);
    expect(screen.getByText('AI verdict: False positive (91%)')).toBeInTheDocument();
    expect(screen.getByText('Your classification agrees with the AI.')).toBeInTheDocument();
    // The answer is locked once compared.
    expect(screen.getByRole('radio', { name: 'True positive' })).toBeDisabled();
  });

  it('records the answer, note, ratings and the time spent', async () => {
    const { record, advance } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'False positive' }));
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '  Weekly scanner.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rate the AI (optional)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accuracy: 4 of 5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the AI' }));
    advance(42_000);
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record).toHaveBeenCalledWith('case-9', {
      classification: 'false_positive',
      note: 'Weekly scanner.',
      accuracy: 0.8,
      reasoning_quality: undefined,
      action_appropriateness: undefined,
      elapsed_ms: 42_000,
    });
    expect(await screen.findByText('Review recorded. Your classification agrees with the AI.')).toBeInTheDocument();
  });

  it('offers Reopen and Reopen and escalate to someone who can close cases', async () => {
    const { caseAction } = setup({ canReopen: true }, { agrees: false, can_reopen: true, sampled: true });
    fireEvent.click(screen.getByRole('radio', { name: 'True positive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the AI' }));
    expect(screen.getByText('Your classification disagrees with the AI.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen and escalate' }));
    await screen.findByText('The case is reopened and escalated.');
    expect(caseAction.mock.calls).toEqual([
      ['case-9', { action: 'reopen', review_via: 'auto_close_review' }],
      ['case-9', { action: 'escalate', review_via: 'auto_close_review' }],
    ]);
  });

  it('says the case stays reopened when the escalation fails', async () => {
    const onReopened = vi.fn();
    const { caseAction } = setup({ canReopen: true, onReopened }, { agrees: false, can_reopen: true });
    caseAction.mockResolvedValueOnce(CASE).mockRejectedValueOnce(new Error('Escalation refused.'));
    fireEvent.click(screen.getByRole('radio', { name: 'True positive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen and escalate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The case is reopened, but it could not be escalated: Escalation refused. Escalate it from Take action.',
    );
    expect(onReopened).toHaveBeenCalledWith(CASE, false);
  });

  it('tells someone who cannot close cases that a person who can was asked', async () => {
    setup({ canReopen: false }, { agrees: false, can_reopen: false, sampled: true });
    fireEvent.click(screen.getByRole('radio', { name: 'True positive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    expect(await screen.findByText('Someone who can close cases has been asked to look at this.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen case' })).toBeNull();
  });

  it('keeps the review open and says why when recording fails', async () => {
    const record = vi.fn(async () => {
      throw new Error('The audit log could not record the review, so nothing changed. Try again.');
    });
    render(<ReviewCard caseData={CASE} record={record} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Unsure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare with the AI' }));
    expect(screen.getByText('Unsure is recorded without a label.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing changed');
    expect(screen.getByRole('button', { name: 'Record review' })).toBeEnabled();
  });
});

describe('review agreement mirror', () => {
  it('matches the server classification_agrees', () => {
    expect(reviewAgrees('benign', 'FALSE_POSITIVE')).toBe(true);
    expect(reviewAgrees('false_positive', 'FALSE_POSITIVE')).toBe(true);
    expect(reviewAgrees('true_positive', 'FALSE_POSITIVE')).toBe(false);
    expect(reviewAgrees('true_positive', 'TRUE_POSITIVE')).toBe(true);
    expect(reviewAgrees('unsure', 'FALSE_POSITIVE')).toBeNull();
    expect(comparisonText(null)).toBe('Unsure is recorded without a label.');
  });
});
