/**
 * Approvals, Round 16 WP15E (SPEC §4.5):
 *
 *   - B36: the confidence pill shows only where an agent scored the proposal. An
 *     automation checkpoint or a tuning review item never shows a made-up "50% confidence".
 *   - B37: a decided proposal shows a read-only footer (Approved, Acknowledged or Rejected,
 *     with the decider and time), no Retry labels and no expiry chip.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listProposalsMock, getCaseMock } = vi.hoisted(() => ({
  listProposalsMock: vi.fn(),
  getCaseMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProposals: listProposalsMock,
      approveProposal: vi.fn(),
      rejectProposal: vi.fn(),
      getCase: getCaseMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import type { Proposal } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import Approvals from '../Approvals';

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

function proposal(over: Partial<Proposal>): Proposal {
  return {
    id: 'p-1',
    kind: 'automation_ack',
    status: 'pending',
    payload: { rule_id: 'lead-review' },
    rationale: 'A lead must review this case.',
    confidence: 0.5,
    source_case_ids: ['case-1'],
    created_by: 'automation',
    created_at: '2026-11-20T10:00:00Z',
    expires_at: FUTURE,
    ...over,
  } as Proposal;
}

function renderPage() {
  return render(
    <TooltipProvider>
      <Approvals onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

async function card(label: string) {
  return (await screen.findAllByRole('article', { name: label }))[0];
}

beforeEach(() => {
  listProposalsMock.mockReset();
  getCaseMock.mockReset().mockResolvedValue({ case_id: 'case-1', case_number: 'CASE-000001' });
});

describe('B36: confidence only where an agent scored the proposal', () => {
  it('an automation checkpoint shows no confidence pill; an agent suppression proposal does', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [
        proposal({ id: 'ack', kind: 'automation_ack', confidence: 0.5, created_by: 'automation' }),
        proposal({
          id: 'sup',
          kind: 'suppression',
          confidence: 0.82,
          created_by: 'agent',
          payload: { field: 'event.module', value: 'modsec_sqli' },
        }),
      ],
    });
    renderPage();
    const ack = await card('Automation review proposal');
    expect(within(ack).queryByText(/confidence/i)).toBeNull();
    const sup = await card('Suppression proposal');
    expect(within(sup).getByText(/82% confidence/)).toBeInTheDocument();
  });

  it('a tuning review item never shows the tuner placeholder as a confidence', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [proposal({ id: 'tune', kind: 'tuning', confidence: 0.5, created_by: 'tuner', payload: { rule_id: 'r1' } })],
    });
    renderPage();
    const tune = await card('Tuning change proposal');
    expect(within(tune).queryByText(/confidence/i)).toBeNull();
  });
});

describe('B37: a decided proposal reads as decided', () => {
  // Decided items show under All.
  const all = async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: 'All' }));
  };

  it('an approved acknowledgement shows who acknowledged it, no Retry approval and no expiry', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [
        proposal({
          id: 'done',
          status: 'approved',
          decision_intent: 'approve',
          decided_by: 'farhan.qureshi',
          decided_at: new Date(Date.now() - 3 * 60_000).toISOString(),
        }),
      ],
    });
    await all();
    const done = await card('Automation review proposal');
    expect(within(done).queryByText(/Retry approval/)).toBeNull();
    expect(within(done).queryByRole('button', { name: /Reject|Acknowledge|Approve/ })).toBeNull();
    expect(within(done).queryByText(/Expires/)).toBeNull();
    expect(within(done).getByText(/Acknowledged by farhan\.qureshi/)).toBeInTheDocument();
    // The status badge says the same word as the footer, never "Approved" beside "Acknowledged".
    expect(within(done).getByText('Acknowledged')).toBeInTheDocument();
    expect(within(done).queryByText('Approved')).toBeNull();
  });

  it('a rejected suppression shows who rejected it and no Retry rejection', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [
        proposal({
          id: 'no',
          kind: 'suppression',
          created_by: 'agent',
          status: 'rejected',
          decision_intent: 'reject',
          decided_by: 'zoe',
          decided_at: new Date(Date.now() - 60 * 60_000).toISOString(),
          payload: { field: 'event.module', value: 'x' },
        }),
      ],
    });
    await all();
    const no = await card('Suppression proposal');
    expect(within(no).queryByText(/Retry rejection/)).toBeNull();
    expect(within(no).queryByText(/Expires/)).toBeNull();
    expect(within(no).getByText(/Rejected by zoe/)).toBeInTheDocument();
  });

  it('an open proposal whose earlier approval failed still offers Retry approval', async () => {
    listProposalsMock.mockResolvedValue({
      proposals: [proposal({ id: 'retry', decision_intent: 'approve', approval_error: 'Store unavailable' })],
    });
    renderPage();
    const retry = await card('Automation review proposal');
    expect(within(retry).getByRole('button', { name: /Retry approval/ })).toBeEnabled();
    expect(within(retry).getByText(/Expires/)).toBeInTheDocument();
  });
});
