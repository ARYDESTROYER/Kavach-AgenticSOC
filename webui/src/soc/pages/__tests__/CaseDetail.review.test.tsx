/**
 * Round 15 (SPEC D4.7, D6.6, D6.9, D6.12, D8.2, D8.4; WP7): the auto-close review in the
 * case workspace.
 *
 *   - A pending sample of the agent's closes shows the band under the meta row and Start
 *     review as the ONE primary action; Reopen moves to Take action.
 *   - Any other case the agent closed keeps Reopen as the primary and offers "Review this
 *     auto-close" in Take action in place of Set disposition; a recorded sample offers
 *     no second review.
 *   - A reopened sample, and a viewer without `cases:write`, get no band and no review;
 *     the latter reads "Waiting for a person" in the facts rail instead.
 *   - Start review opens the review card in a side sheet; recording it re-reads the case
 *     and its review state and tells the host; the rail then shows who reviewed it.
 *   - A case the agent did not close keeps Set disposition, and is never asked about.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Case } from '@/lib/types';
import type { CaseReviewState } from '@/lib/types-reviews';

const NOW = '2026-11-23T12:00:00Z';
const AGENT_CLOSED = {
  case_id: 'c-rev-1',
  case_number: 'CASE-0101',
  title: 'Weekly scanner sweep',
  status: 'closed',
  decision_by: 'agent',
  verdict: 'FALSE_POSITIVE',
  confidence: 0.93,
  risk_score: 12,
  severity_band: 'low',
  disposition: 'false_positive',
  created_at: NOW,
  updated_at: NOW,
  history: [{ ts: NOW, event: 'decision', status: 'closed', decision_by: 'agent', escalate: false }],
  feedback: [],
} as unknown as Case;

const env = vi.hoisted(() => ({
  grants: new Set<string>(),
  case: null as unknown,
  review: null as null | Record<string, unknown>,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), warning: vi.fn() } }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(env.case)),
    getModels: vi.fn(() => Promise.resolve({ providers: {} })),
    getSettings: vi.fn(() => Promise.resolve({ prefs: {}, configured: {}, read_only: false })),
    caseActionExec: vi.fn(() => Promise.resolve({ ...(env.case as object), status: 'open' })),
  };
  return {
    ApiError,
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/lib/api-reviews', () => ({
  getCaseReviewState: vi.fn((caseId: string) => Promise.resolve({ ...env.review, case_id: caseId })),
  recordReview: vi.fn(() => Promise.resolve({ agrees: true, can_reopen: true, sampled: true, review_id: 'acr-1' })),
}));

vi.mock('@/soc/auth', () => {
  const has = (resource: string, action: string) => env.grants.has(`${resource}:${action}`);
  return {
    useAuth: () => ({
      username: 't2',
      role: 'analyst_tier2',
      authEnabled: true,
      rbacEnabled: true,
      hasPermission: has,
      user: null,
    }),
    useOptionalAuth: () => ({ hasPermission: has }),
  };
});

import { api } from '@/lib/api';
import { getCaseReviewState, recordReview } from '@/lib/api-reviews';
import { CaseDetail } from '@/soc/pages/CaseDetail';

const READER = ['cases:read'];
const TIER2 = ['cases:read', 'cases:write', 'cases:comment', 'cases:assign', 'cases:close'];

const reviewState = (over: Partial<CaseReviewState> = {}): Record<string, unknown> => ({
  agent_closed: true,
  state: 'pending',
  can_record: true,
  review_id: 'acr-1',
  sampled_at: NOW,
  expires_at: '2026-11-30T12:00:00Z',
  ...over,
});

async function renderCase(onReviewChange = vi.fn()) {
  render(
    <CaseDetail
      caseId={(env.case as Case).case_id}
      presentation="embedded"
      onClose={() => undefined}
      onReviewChange={onReviewChange}
    />,
  );
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent((env.case as Case).title));
  return onReviewChange;
}

async function takeActionItems() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Take action' }));
  const menu = await screen.findByRole('menu');
  const names = within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent?.replace(/[A-Z]$/, '').trim());
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return names;
}

beforeAll(async () => {
  // The card's chunk, loaded up front so the sheet renders it inside the test's act().
  await import('@/soc/pages/casedetail/review/ReviewCard');
});

beforeEach(() => {
  env.case = AGENT_CLOSED;
  env.review = reviewState();
  env.grants = new Set(TIER2);
  vi.mocked(getCaseReviewState).mockClear();
  vi.mocked(recordReview).mockClear();
  vi.mocked(api.getCase).mockClear();
});

describe('a pending sample of the agent closes', () => {
  it('shows the band and Start review as the one primary action, with Reopen in Take action', async () => {
    await renderCase();
    const band = await screen.findByTestId('case-review-band');
    expect(band).toHaveTextContent(
      'Picked at random for auto-close review. Classify it yourself, then compare with the AI.',
    );
    expect(screen.getByTestId('case-primary-action')).toHaveTextContent('Start review');
    expect(screen.queryByRole('button', { name: /^Reopen/ })).toBeNull();
    const items = await takeActionItems();
    expect(items).toContain('Reopen');
    expect(items).not.toContain('Set disposition');
    expect(items).not.toContain('Review this auto-close');
    // The band is the pending fact's one home: the rail does not repeat it.
    expect(screen.queryByText('Picked at random for auto-close review. Waiting for a person.')).toBeNull();
  });

  it('opens the review card from Start review; recording it re-reads the case and tells the host', async () => {
    const onReviewChange = await renderCase();
    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    const sheet = await screen.findByRole('dialog', { name: 'Review this auto-close' });
    expect(await within(sheet).findByText('What was it?')).toBeInTheDocument();
    const reads = vi.mocked(getCaseReviewState).mock.calls.length;
    const caseReads = vi.mocked(api.getCase).mock.calls.length;

    fireEvent.click(within(sheet).getByRole('radio', { name: 'False positive' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Compare with the AI' }));
    await act(async () => {
      fireEvent.click(within(sheet).getByRole('button', { name: 'Record review' }));
    });
    await waitFor(() => expect(recordReview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(recordReview).mock.calls[0][0]).toBe('c-rev-1');
    expect(vi.mocked(recordReview).mock.calls[0][1]).toMatchObject({ classification: 'false_positive' });
    expect(await within(sheet).findByText('Review recorded. Your classification agrees with the AI.')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.getCase).mock.calls.length).toBeGreaterThan(caseReads));
    await waitFor(() => expect(vi.mocked(getCaseReviewState).mock.calls.length).toBeGreaterThan(reads));
    expect(onReviewChange).toHaveBeenCalledTimes(1);
  });
});

describe('a case the agent closed with no pending review', () => {
  it('keeps Reopen as the primary and offers Review this auto-close in place of Set disposition', async () => {
    env.review = reviewState({ state: 'none', review_id: null, sampled_at: null, expires_at: null });
    await renderCase();
    await waitFor(() => expect(getCaseReviewState).toHaveBeenCalled());
    expect(screen.queryByTestId('case-review-band')).toBeNull();
    expect(screen.getByTestId('case-primary-action')).toHaveTextContent('Reopen');
    const items = await takeActionItems();
    expect(items[0]).toBe('Review this auto-close');
    expect(items).not.toContain('Set disposition');
  });

  it('opens the same review card from Take action, without the pending sentence', async () => {
    env.review = reviewState({ state: 'none', review_id: null, sampled_at: null, expires_at: null });
    await renderCase();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Take action' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Review this auto-close' }));
    const sheet = await screen.findByRole('dialog', { name: 'Review this auto-close' });
    expect(await within(sheet).findByText('What was it?')).toBeInTheDocument();
    expect(within(sheet).queryByText(/Picked at random/)).toBeNull();
  });

  it('offers no second review of a recorded sample', async () => {
    env.review = reviewState({ state: 'completed', can_record: false, expires_at: null });
    await renderCase();
    await waitFor(() => expect(getCaseReviewState).toHaveBeenCalled());
    const items = await takeActionItems();
    expect(items).not.toContain('Review this auto-close');
    expect(items).not.toContain('Set disposition');
  });

  it('says in the rail that an expired sample went unreviewed', async () => {
    env.review = reviewState({ state: 'expired', expires_at: '2026-11-20T12:00:00Z' });
    await renderCase();
    const lines = await screen.findAllByTestId('facts-review');
    expect(lines[0]).toHaveTextContent(/^Picked at random for auto-close review\. The review expired /);
  });
});

describe('no review where none can be recorded', () => {
  it('a reopened sample: no band, no review, and its state is never asked', async () => {
    env.case = { ...(AGENT_CLOSED as object), status: 'open' };
    await renderCase();
    expect(screen.getByTestId('case-primary-action')).toHaveTextContent('Close case');
    expect(screen.queryByTestId('case-review-band')).toBeNull();
    const items = await takeActionItems();
    expect(items).not.toContain('Review this auto-close');
    expect(getCaseReviewState).not.toHaveBeenCalled();
  });

  it('a viewer without cases:write: no band and no Start review; the rail says it is waiting', async () => {
    env.grants = new Set(READER);
    await renderCase();
    await waitFor(() => expect(getCaseReviewState).toHaveBeenCalled());
    expect(screen.queryByTestId('case-review-band')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
    const lines = await screen.findAllByTestId('facts-review');
    expect(lines[0]).toHaveTextContent('Picked at random for auto-close review. Waiting for a person.');
  });

  it('a case an analyst closed keeps Set disposition and is never asked about', async () => {
    env.case = {
      ...(AGENT_CLOSED as object),
      decision_by: 'analyst',
      history: [{ ts: NOW, event: 'decision', status: 'closed', decision_by: 'analyst' }],
    };
    await renderCase();
    const items = await takeActionItems();
    expect(items).toContain('Set disposition');
    expect(items).not.toContain('Review this auto-close');
    expect(getCaseReviewState).not.toHaveBeenCalled();
  });
});

describe('the rail after a review', () => {
  it('reads the review as the outcome and names who reviewed it', async () => {
    env.review = reviewState({ state: 'completed', can_record: false, expires_at: null });
    env.case = {
      ...(AGENT_CLOSED as object),
      feedback: [{ ts: NOW, analyst: 't2', assessment: 'agree', actual_outcome: 'false_positive', origin: 'auto_close_review', review_id: 'acr-1' }],
      history: [
        ...(AGENT_CLOSED.history as unknown[]),
        { ts: NOW, event: 'auto_close_review', review_id: 'acr-1', feedback_ts: NOW, analyst: 't2', agrees: true, classification: 'benign' },
      ],
    };
    await renderCase();
    const rails = await screen.findAllByTestId('facts-outcome-headline');
    expect(rails[0]).toHaveTextContent('Reviewed: benign');
    const lines = await screen.findAllByTestId('facts-review');
    expect(lines[0]).toHaveTextContent(/^Auto-close review by t2 · /);
  });
});
