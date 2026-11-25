/**
 * Round 15 (SPEC D6.12): the Agent effectiveness "Auto-close review" module.
 *
 *   - it always shows the exact statement that agreement describes the sampled cases
 *     only and is not an estimate of auto-close precision;
 *   - below 30 reviews it says "Not enough reviews yet" with the N of M count and no
 *     rate; from 30 it shows the rate with its Wilson 95% interval;
 *   - missed threats link to their cases; the eligible count is by first decision day;
 *   - the page's range maps to a window token (`now-30d`, `now-12h`);
 *   - the page loads it lazily.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AutoCloseReviewMetrics } from '@/lib/types-reviews';

const { metricsMock } = vi.hoisted(() => ({ metricsMock: vi.fn() }));
vi.mock('@/lib/api-reviews', () => ({ getAutoCloseReviewMetrics: metricsMock }));

import AutoCloseReviewModule, { AutoCloseReviewBody, durationWords, reviewWindowToken } from '../AutoCloseReviewModule';

const STATEMENT =
  'Agreement describes the sampled cases only, unweighted. It is not an estimate of auto-close precision.';

function metrics(over: Partial<AutoCloseReviewMetrics> = {}): AutoCloseReviewMetrics {
  return {
    window: { token: 'now-30d', label: 'last 30 days', tz: 'UTC', start: '2026-10-24T00:00:00Z', end: '2026-11-23T00:00:00Z' },
    enabled: true,
    sample_rate: 0.05,
    daily_cap: 10,
    per_rule_daily_cap: 3,
    expiry_days: 7,
    sampled: 12,
    reviewed: 9,
    pending: 2,
    expired: 1,
    unsure: 1,
    agreement: { status: 'insufficient', agreed: 7, disagreed: 1, reviews: 8, minimum: 30, rate: null, interval: null, statement: STATEMENT },
    missed_threats: { count: 1, cases: [{ case_id: 'case-7', case_number: 'CASE-0007', rule: 'web_access', completed_at: '' }] },
    by_rule: [{ rule: 'web_access', sampled: 5, reviewed: 4, agreed: 3, disagreed: 1 }],
    time_spent_ms: { median: 90_000, reviews: 9 },
    time_to_review_ms: { median: 7_200_000, reviews: 9 },
    by_day: [],
    eligible: { count: 1234, complete: true },
    ledger_complete: true,
    statement: STATEMENT,
    generated_at: '2026-11-23T00:00:00Z',
    ...over,
  };
}

describe('AutoCloseReviewBody', () => {
  it('says not enough reviews below thirty, with the count and the statement', () => {
    render(<AutoCloseReviewBody data={metrics()} />);
    expect(screen.getByText('Not enough reviews yet')).toBeInTheDocument();
    expect(screen.getByText(/7 of 8 agreed, 1 unsure\. An agreement rate needs at least 30 reviews\./)).toBeInTheDocument();
    expect(screen.getByTestId('review-statement')).toHaveTextContent(STATEMENT);
    expect(screen.getByRole('link', { name: 'CASE-0007' })).toHaveAttribute('href', expect.stringContaining('case-7'));
    expect(screen.getByTestId('review-eligible')).toHaveTextContent('1,234 automatic closes in this range');
    expect(screen.getByText('1m 30s')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('shows the rate and its interval from thirty reviews', () => {
    render(
      <AutoCloseReviewBody
        data={metrics({
          agreement: { status: 'ok', agreed: 27, disagreed: 3, reviews: 30, minimum: 30, rate: 0.9,
            interval: { low: 0.7435, high: 0.9654 }, statement: STATEMENT },
        })}
      />,
    );
    expect(screen.getByTestId('review-agreement')).toHaveTextContent(/Agreement 90%, 95% interval 74\.4% to 96\.5%/);
    expect(screen.queryByText('Not enough reviews yet')).toBeNull();
  });

  it('explains the interval with the Wilson arithmetic and the real counts (Round 16 WP11)', async () => {
    const user = userEvent.setup();
    render(
      <AutoCloseReviewBody
        data={metrics({
          agreement: { status: 'ok', agreed: 27, disagreed: 3, reviews: 30, minimum: 30, rate: 0.9,
            interval: { low: 0.7438, high: 0.9654 }, statement: STATEMENT },
        })}
      />,
    );
    await user.hover(screen.getByRole('button', { name: /74\.4% to 96\.5%/ }));
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent(
      'Wilson 95% interval for 27 of 30: 74.4% to 96.5%.',
    );
  });

  it('says when the review is off and when counts are lower bounds', () => {
    render(<AutoCloseReviewBody data={metrics({ enabled: false, ledger_complete: false, eligible: { count: 3, complete: false } })} />);
    expect(screen.getByTestId('review-module-off')).toHaveTextContent('Auto-close review is off.');
    expect(screen.getByTestId('review-eligible')).toHaveTextContent('at least');
  });
});

describe('AutoCloseReviewModule', () => {
  it('reads the window of the page range', async () => {
    metricsMock.mockResolvedValueOnce(metrics());
    render(<AutoCloseReviewModule hours={720} />);
    await waitFor(() => expect(screen.getByText('Not enough reviews yet')).toBeInTheDocument());
    expect(metricsMock).toHaveBeenCalledWith('now-30d', expect.anything());
  });

  it('maps hours to tokens and words durations', () => {
    expect(reviewWindowToken(24)).toBe('now-1d');
    expect(reviewWindowToken(12)).toBe('now-12h');
    expect(durationWords(45_000)).toBe('45s');
    expect(durationWords(200_000)).toBe('3m 20s');
    // Hour-scale values go through the shared duration formatter ("2d 23h", never "71 h 50 min").
    expect(durationWords((71 * 60 + 50) * 60_000)).toBe('2d 23h');
    expect(durationWords((216 * 60 + 10) * 60_000)).toBe('9d');
    expect(durationWords(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(durationWords(null)).toBe('Not measured');
  });

  it('is loaded lazily by the Agent effectiveness page', () => {
    const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'AgentEffectiveness.tsx'), 'utf8');
    expect(page).toContain("React.lazy(() => import('./effectiveness/AutoCloseReviewModule'))");
    expect(page).not.toMatch(/^import .*AutoCloseReviewModule/m);
  });
});
