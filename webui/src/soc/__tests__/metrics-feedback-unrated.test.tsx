/**
 * Metrics, Performance tab: a quality score no grade rated reads "Not rated", never 0%
 * (Round 15 SPEC D4.5).
 *
 * The backend averages each quality score over the grades that rated it and reports `0.0`
 * with a `*_rated` count of 0 when none did. A server that sends no count keeps its average
 * as before. Fully offline: the module renders from a plain feedback object.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { FeedbackQuality, feedbackSubScores } from '../pages/Metrics';
import type { FeedbackStats } from '@/lib/types';

const FEEDBACK: FeedbackStats = {
  graded_cases: 3,
  feedback_count: 3,
  agreement_rate: 1,
  agreement_signals: 3,
  avg_accuracy: 0.8,
  avg_reasoning_quality: 0,
  avg_action_appropriateness: 0,
  accuracy_rated: 2,
  reasoning_quality_rated: 0,
  action_appropriateness_rated: 0,
  time_saved_minutes: 0,
  outcome_distribution: {},
};

afterEach(cleanup);

describe('feedbackSubScores', () => {
  it('reads a count of 0 as not rated and keeps the rated averages', () => {
    expect(feedbackSubScores(FEEDBACK)).toEqual([
      { label: 'Accuracy', value: 80 },
      { label: 'Reasoning quality', value: null },
      { label: 'Action appropriateness', value: null },
    ]);
  });

  it('keeps the average as before when the server sends no count', () => {
    const legacy: FeedbackStats = {
      ...FEEDBACK,
      accuracy_rated: undefined,
      reasoning_quality_rated: undefined,
      action_appropriateness_rated: undefined,
    };
    expect(feedbackSubScores(legacy).map((s) => s.value)).toEqual([80, 0, 0]);
  });
});

describe('FeedbackQuality', () => {
  it('shows "Not rated" for a score nobody rated, never a 0% bar', () => {
    render(<FeedbackQuality feedback={FEEDBACK} />);
    expect(screen.getByRole('progressbar', { name: 'Accuracy' })).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Reasoning quality' })).toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Action appropriateness' })).toBeNull();
    expect(screen.getByText('Not rated: Reasoning quality, Action appropriateness.')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('shows only the line when no grade rated any score', () => {
    render(<FeedbackQuality feedback={{ ...FEEDBACK, avg_accuracy: 0, accuracy_rated: 0 }} />);
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    expect(
      screen.getByText('Not rated: Accuracy, Reasoning quality, Action appropriateness.'),
    ).toBeInTheDocument();
  });
});
