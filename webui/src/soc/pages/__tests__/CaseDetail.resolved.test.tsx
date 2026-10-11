/**
 * CaseDetail on a RESOLVED case (Round 12 final review, L3).
 *
 * Resolved means "worked to completion, pending final close". The server allows the
 * final close (resolved → closed through `close`), so the page's primary action and
 * its C shortcut must post `close`. A case resolved before resolve captured an outcome
 * reads "Resolved by analyst: outcome not recorded", so Set disposition must be on
 * offer there too, without reopening the case.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { actionPlanForStatus } from '../casedetail/shared';

const RESOLVED = {
  case_id: 'c-res-1',
  case_number: 'CASE-2026-0410',
  title: 'ip:203.0.113.7 password spray resolved by an analyst',
  status: 'resolved',
  decision_by: 'analyst',
  disposition: 'undetermined',
  verdict: 'NEEDS_HUMAN',
  risk_score: 40,
  severity_band: 'medium',
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  // A resolve with no classification entry: the outcome was never recorded.
  history: [{ ts: '2026-10-10T10:00:00Z', event: 'analyst_action', action: 'resolve', analyst: 'probe' }],
};

const { caseActionExec } = vi.hoisted(() => ({ caseActionExec: vi.fn() }));

vi.mock('@/lib/api', () => {
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(RESOLVED)),
    caseActionExec,
  };
  return {
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useCan: () => () => true,
}));

import { CaseDetail } from '@/soc/pages/CaseDetail';

async function renderResolved() {
  render(<CaseDetail caseId={RESOLVED.case_id} presentation="embedded" onClose={() => undefined} />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/password spray/));
}

describe('actionPlanForStatus — terminal states mirror the server guard', () => {
  it('resolved: Close is the primary, Set disposition and Reopen are in the overflow', () => {
    const plan = actionPlanForStatus('resolved');
    expect(plan.primary.key).toBe('close_disposition');
    expect(plan.primary.wireAction).toBe('close');
    expect(plan.close).toBeNull();
    expect(plan.overflow.map((a) => a.key)).toEqual(['set_disposition', 'reopen']);
  });

  it('closed: Reopen is the primary, no close is offered, Set disposition stays', () => {
    const plan = actionPlanForStatus('closed');
    expect(plan.primary.key).toBe('reopen');
    expect(plan.close).toBeNull();
    expect(plan.overflow.map((a) => a.key)).toEqual(['set_disposition']);
  });
});

describe('CaseDetail on a resolved case', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
  });

  it('the primary Close case (and C) posts the final close with the chosen outcome', async () => {
    caseActionExec.mockResolvedValue({ ...RESOLVED, status: 'closed', disposition: 'benign' });
    await renderResolved();

    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 'c' });
    const dialog = await screen.findByTestId('confirm-action-dialog');
    expect(within(dialog).getByText('Close with a disposition')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Benign/i }));
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    const [id, input] = caseActionExec.mock.calls[0];
    expect(id).toBe(RESOLVED.case_id);
    expect(input.action).toBe('close');
    expect(input.disposition).toBe('benign');
    expect(input.disposition_declared).toBe(true);
  });

  it('offers Set disposition beside "outcome not recorded" and records it without closing', async () => {
    caseActionExec.mockResolvedValue({ ...RESOLVED, disposition: 'false_positive' });
    await renderResolved();

    const setButtons = await screen.findAllByRole('button', { name: 'Set disposition' });
    expect(setButtons.length).toBeGreaterThan(0);
    fireEvent.click(setButtons[0]);

    const dialog = await screen.findByTestId('confirm-action-dialog');
    expect(within(dialog).getByText('Set the investigative disposition')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: /False positive/i }));
    const submit = within(dialog).getByRole('button', { name: /^Set disposition/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    const [, input] = caseActionExec.mock.calls[0];
    expect(input.action).toBe('set_disposition');
    expect(input.disposition).toBe('false_positive');
  });
});
