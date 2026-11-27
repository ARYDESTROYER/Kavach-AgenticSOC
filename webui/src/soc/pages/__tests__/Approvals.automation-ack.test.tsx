import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { approveMock, getCaseMock, listProposalsMock, toastSuccessMock } = vi.hoisted(() => ({
  approveMock: vi.fn(),
  getCaseMock: vi.fn(),
  listProposalsMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProposals: listProposalsMock,
      approveProposal: approveMock,
      // The source case is named by its case number (Round 14), read once per id.
      getCase: getCaseMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import type { Proposal } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import Approvals from '../Approvals';

const ACK_PROPOSAL = {
  id: 'proposal-automation-ack-1',
  kind: 'automation_ack',
  status: 'pending',
  created_at: '2026-08-03T10:00:00Z',
  rationale: 'A lead must review this case before the workflow continues.',
  source_case_ids: ['case-ack-1'],
  payload: { rule_id: 'lead-review', requested_kind: 'escalate' },
} as unknown as Proposal;

function renderPage() {
  return render(
    <TooltipProvider>
      <Approvals onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Approvals automation acknowledgements', () => {
  beforeEach(() => {
    approveMock.mockReset();
    listProposalsMock.mockReset();
    toastSuccessMock.mockReset();
    getCaseMock.mockReset();
    getCaseMock.mockResolvedValue({ case_id: 'case-ack-1', case_number: 'CASE-000101' });
    listProposalsMock.mockResolvedValue({ proposals: [ACK_PROPOSAL] });
  });

  it('labels and groups the checkpoint without presenting it as trusted Memory', async () => {
    renderPage();

    expect(await screen.findByText('Automation review')).toBeInTheDocument();
    expect(screen.getByText('Operator acknowledgement')).toBeInTheDocument();
    expect(screen.getByText('lead-review')).toBeInTheDocument();
    expect(screen.getByText(/does not change a setting, create Memory/i)).toBeInTheDocument();
    // The source case reads as its case number, never the internal id.
    expect(await screen.findByRole('button', { name: 'Open case CASE-000101' })).toBeInTheDocument();
    expect(screen.queryByText('case-ack-1')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Group by source or rule' }));
    expect(screen.getByText('Automation · lead-review')).toBeInTheDocument();
  });

  it('acknowledges with an explicit no-materialisation confirmation', async () => {
    approveMock.mockResolvedValue({ ...ACK_PROPOSAL, status: 'approved' });
    renderPage();
    await screen.findByText('lead-review');

    fireEvent.click(screen.getByRole('button', { name: /^acknowledge$/i }));

    await waitFor(() => expect(approveMock).toHaveBeenCalledWith(ACK_PROPOSAL.id));
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Automation review acknowledged; no setting, Memory, suppression, or case state changed.',
    );
    expect(screen.getByText('No pending proposals')).toBeInTheDocument();
  });

  it('surfaces a failed strict approval so the operator can retry', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [{ ...ACK_PROPOSAL, approval_error: 'State backend unavailable' }],
    });
    renderPage();

    expect(await screen.findByText('Previous approval attempt did not complete')).toBeInTheDocument();
    expect(screen.getByText(/State backend unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^acknowledge$/i })).toBeEnabled();
  });

  it('keeps an in-flight approval visible with an explicit recovery action', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [{ ...ACK_PROPOSAL, status: 'applying', applying_at: '2026-08-03T10:00:00Z' }],
    });
    renderPage();

    expect(await screen.findByText('Applying')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume approval' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });
});
