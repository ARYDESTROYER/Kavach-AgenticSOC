/**
 * CaseDetail: closing a case whose runbook still has required steps open (Round 14,
 * SPEC §4.10.11 and §4.10.15, D34), through the real orchestrator over a mocked client.
 *
 *   - the close dialog lists the open steps from the loaded runs and asks why; the action
 *     carries `require_open_steps_reason: true` and the reason;
 *   - when the runs changed since they were read, the server's `409 runbook_steps_open`
 *     keeps the dialog open with the steps it named, and a second submit with a reason
 *     goes through;
 *   - the close itself is the existing analyst verb (#3): nothing here reaches `decide()`;
 *   - a request to land in the Runbook tab (Take action's Start runbook, Collaboration's
 *     "Open the Runbook tab") is handled once: leaving the tab and coming back never
 *     replays it, and Other tasks takes focus.
 */
import type * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { caseActionExec, caseFeedback, getCase, getCaseRunbooks, toastMock } = vi.hoisted(() => ({
  caseActionExec: vi.fn(),
  caseFeedback: vi.fn(),
  getCase: vi.fn(),
  getCaseRunbooks: vi.fn(),
  toastMock: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

const OPEN_CASE = {
  case_id: 'case-1',
  case_number: 'CASE-000214',
  title: 'Password spray against the VPN',
  status: 'open',
  disposition: null as string | null,
  verdict: null,
  confidence: 0.6,
  risk_score: 62,
  created_at: '2026-10-28T12:50:00Z',
  updated_at: '2026-10-28T13:00:00Z',
  escalation_level: 0,
  evidence: [],
  assets: {},
  iocs: [],
  tags: [],
  comments: [],
};

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ...actual,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase,
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      caseActionExec,
      caseFeedback,
      cases: { threatContext: ok(null), notify: ok({ sent: [] }) },
    },
  };
});

vi.mock('@/lib/api-runbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-runbooks')>();
  return {
    ...actual,
    getCaseRunbooks,
    getRunbookProgress: vi.fn().mockResolvedValue({}),
    getRunbookCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
  };
});

vi.mock('@/lib/useEventStream', () => ({ useEventStream: vi.fn(() => ({ live: false })) }));

import { ApiError } from '@/lib/api';
import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';
import { makeData } from '@/soc/runbooks/run/__tests__/fixtures';

function renderCase(presentation?: 'embedded') {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>
          <CaseDetail caseId="case-1" onClose={vi.fn()} presentation={presentation} />
        </TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

async function openClose(): Promise<HTMLElement> {
  await screen.findByText('Password spray against the VPN', undefined, { timeout: 5000 });
  fireEvent.click(screen.getByRole('button', { name: /^close case/i }));
  const dialog = await screen.findByRole('dialog', { name: /close/i });
  fireEvent.click(within(dialog).getByRole('radio', { name: /false positive/i }));
  return dialog;
}

const REASON_LABEL = /Why are you closing with required steps open\?/;

describe('CaseDetail: close with required runbook steps open', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
    caseFeedback.mockReset();
    getCase.mockReset().mockResolvedValue(OPEN_CASE);
    getCaseRunbooks.mockReset();
    toastMock.error.mockReset();
  });

  it('lists the open steps, asks why, and sends the reason with require_open_steps_reason', async () => {
    getCaseRunbooks.mockResolvedValue(makeData());
    caseActionExec.mockResolvedValue({ ...OPEN_CASE, status: 'closed', disposition: 'false_positive' });
    renderCase();
    const dialog = await openClose();
    expect(await within(dialog).findByText('3 required runbook steps are still open')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(REASON_LABEL), { target: { value: 'Contained under CHG-4821.' } });
    fireEvent.click(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: /^close case/i }));

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    expect(caseActionExec.mock.calls[0][1]).toMatchObject({
      action: 'close',
      disposition: 'false_positive',
      require_open_steps_reason: true,
      open_steps_reason: 'Contained under CHG-4821.',
    });
  });

  it("keeps the dialog open on the server's refusal and lists the steps it named", async () => {
    getCaseRunbooks.mockResolvedValue(makeData([]));
    caseActionExec
      .mockRejectedValueOnce(
        new ApiError(409, 'Required runbook steps are open.', {
          detail: {
            code: 'runbook_steps_open',
            message: 'Required runbook steps are open.',
            required_open: 1,
            steps: [{ run_id: 'run-9', step_id: 'reset', title: 'Reset the affected accounts', status: 'in_progress' }],
          },
        }),
      )
      .mockResolvedValueOnce({ ...OPEN_CASE, status: 'closed', disposition: 'false_positive' });
    renderCase();
    await openClose();
    fireEvent.click(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: /^close case/i }));

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    expect(caseActionExec.mock.calls[0][1]).toMatchObject({ action: 'close', require_open_steps_reason: true });
    expect(caseActionExec.mock.calls[0][1]).not.toHaveProperty('open_steps_reason');

    const dialog = await screen.findByRole('dialog', { name: /close/i });
    expect(await within(dialog).findByText('Reset the affected accounts')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Required runbook steps are open. Say why you are closing the case.');

    fireEvent.change(within(dialog).getByLabelText(REASON_LABEL), { target: { value: 'The platform team owns the reset.' } });
    fireEvent.click(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: /^close case/i }));
    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(2));
    expect(caseActionExec.mock.calls[1][1]).toMatchObject({
      require_open_steps_reason: true,
      open_steps_reason: 'The platform team owns the reset.',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /close/i })).toBeNull());
  });
});

describe('CaseDetail: requests to land in the Runbook tab', () => {
  beforeEach(() => {
    getCase.mockReset().mockResolvedValue(OPEN_CASE);
    getCaseRunbooks.mockReset();
  });

  it('opens Start runbook once from Take action; leaving the tab and coming back never reopens it', async () => {
    const user = userEvent.setup();
    getCaseRunbooks.mockResolvedValue(makeData([]));
    renderCase('embedded');
    await screen.findByText('Password spray against the VPN', undefined, { timeout: 5000 });
    const takeAction = screen.getByRole('button', { name: /take action/i });
    act(() => takeAction.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Start runbook' }));
    expect(await screen.findByTestId('start-runbook-dialog', undefined, { timeout: 5000 })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('start-runbook-dialog')).toBeNull());

    await user.click(screen.getByRole('tab', { name: /^Overview/ }));
    await user.click(screen.getByRole('tab', { name: /^Runbook/ }));
    // The tab's own empty state (the facts rail says the same sentence beside it).
    expect(await screen.findByRole('button', { name: 'Start runbook' })).toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.queryByTestId('start-runbook-dialog')).toBeNull();
  });

  it('lands on Other tasks from Collaboration', async () => {
    const user = userEvent.setup();
    getCaseRunbooks.mockResolvedValue(makeData());
    renderCase('embedded');
    await screen.findByText('Password spray against the VPN', undefined, { timeout: 5000 });
    await user.click(screen.getByRole('tab', { name: /^Collaboration/ }));
    await user.click(await screen.findByRole('button', { name: 'Open the Runbook tab' }));
    const heading = await screen.findByRole('heading', { level: 3, name: 'Other tasks' }, { timeout: 5000 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
