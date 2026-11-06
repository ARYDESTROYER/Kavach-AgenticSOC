/**
 * Approvals, Round 14 (SPEC §4.9.4, ui-audit AP1 to AP4): the Overview's grammar.
 *
 * Pins: the header is the title, a help tip (holding the old always-on callout and the
 * footer) and the pending count with an icon Refresh, with no breadcrumb, icon or
 * description; the queue is one panel whose rows are the proposals (no card per
 * proposal, no accent bar, no tracked capitals); a source case is named by its case
 * number; the automation's default rationale reads as plain words; no em dashes.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { approveMock, getCaseMock, listProposalsMock, toastSuccessMock, perms, viewer } = vi.hoisted(() => ({
  approveMock: vi.fn(),
  getCaseMock: vi.fn(),
  listProposalsMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  perms: { cases: true },
  viewer: { username: 'alice' },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProposals: listProposalsMock,
      approveProposal: approveMock,
      getCase: getCaseMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: viewer.username,
    hasPermission: (resource: string) => (resource === 'cases' ? perms.cases : true),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccessMock, error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import type { Proposal } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { ApiError } from '@/lib/api';
import Approvals, { plainRationale, resetCaseLabelsForTests } from '../Approvals';

const AUTOMATION_RATIONALE = (caseId: string) =>
  `Threshold automation rule 'demo-seed-approval' requested approval for case ${caseId} (verdict=NEEDS_HUMAN, risk=62.0). Review before approving.`;

function ackProposal(id: string, caseId: string): Proposal {
  return {
    id,
    kind: 'automation_ack',
    status: 'pending',
    created_at: '2026-10-28T10:00:00Z',
    created_by: 'automation',
    rationale: AUTOMATION_RATIONALE(caseId),
    source_case_ids: [caseId],
    payload: { rule_id: 'demo-seed-approval' },
  } as unknown as Proposal;
}

const SUPPRESSION = {
  id: 'prop-sup',
  kind: 'suppression',
  status: 'pending',
  created_at: '2026-10-28T09:00:00Z',
  rationale: 'Known scanner from the vulnerability team.',
  payload: { field: 'source.ip', value: '10.0.0.9', reason: 'Weekly authorised scan' },
} as unknown as Proposal;

function renderPage(onNavigate = vi.fn()) {
  render(
    <TooltipProvider>
      <Approvals onNavigate={onNavigate} />
    </TooltipProvider>,
  );
  return onNavigate;
}

describe('Approvals (Round 14 Overview grammar)', () => {
  beforeEach(() => {
    approveMock.mockReset();
    getCaseMock.mockReset();
    listProposalsMock.mockReset();
    toastSuccessMock.mockReset();
    perms.cases = true;
    viewer.username = 'alice';
    resetCaseLabelsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has the Overview header: title, help, pending count and an icon Refresh; no breadcrumb or callout', async () => {
    getCaseMock.mockResolvedValue({ case_id: 'demo-hitl-a', case_number: 'CASE-000040' });
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION, ackProposal('prop-a', 'demo-hitl-a')] });
    renderPage();

    const h1 = await screen.findByRole('heading', { level: 1, name: 'Approvals' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'About Approvals' })).toBeInTheDocument();
    expect(await within(header).findByText('2 pending')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
    expect(screen.queryByText('Automation')).toBeNull();
    // The always-on explanation callout and the footer moved into the help tip.
    expect(screen.queryByText(/every pending item requires an explicit decision/i)).toBeNull();
    expect(screen.queryByText(/rendered as plain text/i)).toBeNull();

    const refresh = within(header).getByRole('button', { name: 'Refresh approvals' });
    expect(listProposalsMock).toHaveBeenCalledTimes(1);
    fireEvent.click(refresh);
    await waitFor(() => expect(listProposalsMock).toHaveBeenCalledTimes(2));
  });

  it('puts the explanation in the help tip', async () => {
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'About Approvals' }));
    const tip = await screen.findByText(/nothing applies until someone approves it/i);
    // One or two sentences (SPEC §4.9.3).
    expect((tip.textContent ?? '').match(/[.!?](\s|$)/g)?.length).toBeLessThanOrEqual(2);
  });

  it('keeps Reject neutral at rest, red only on hover and focus, and both actions 44px on phones', async () => {
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION] });
    renderPage();
    const row = await screen.findByRole('article', { name: 'Suppression proposal' });
    const reject = within(row).getByRole('button', { name: /^reject$/i });
    const approve = within(row).getByRole('button', { name: /^approve$/i });
    expect(reject.className).toMatch(/\btext-muted-foreground\b/);
    expect(reject.className).not.toMatch(/(^|\s)text-critical(\s|$)/);
    expect(reject.className).toMatch(/hover:text-critical/);
    expect(reject.className).toMatch(/focus-visible:text-critical/);
    for (const action of [reject, approve]) expect(action.className).toMatch(/\bmax-md:min-h-11\b/);
  });

  it('lists proposals as rows of one queue panel, with sentence-case labels and no accent bar', async () => {
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION] });
    renderPage();

    const queue = await screen.findByRole('region', { name: 'Pending proposals' });
    expect(queue).toHaveClass('surface-panel');
    expect(within(queue).getByRole('group', { name: 'Approval queue controls' })).toBeInTheDocument();
    const row = within(queue).getByRole('article', { name: 'Suppression proposal' });
    expect(row.closest('li')).not.toBeNull();
    expect(within(row).getByText('Candidate suppression rule').className).not.toMatch(/uppercase|tracking-/);
    expect(within(row).getByText('Why the agent drafted this').className).not.toMatch(/uppercase|tracking-/);
    expect(queue.innerHTML).not.toMatch(/before:bg-/);
    expect(queue.querySelector('.rounded-xl.border')).toBeNull();
  });

  it('switches to All proposals from the queue panel', async () => {
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION] });
    renderPage();
    await screen.findByRole('region', { name: 'Pending proposals' });
    await userEvent.click(screen.getByRole('radio', { name: 'All' }));
    await waitFor(() => expect(listProposalsMock).toHaveBeenLastCalledWith(undefined));
    expect(await screen.findByRole('region', { name: 'All proposals' })).toBeInTheDocument();
  });

  it('names a source case by its case number and opens it by its id', async () => {
    getCaseMock.mockResolvedValue({ case_id: 'demo-hitl-00000539-0001', case_number: 'CASE-000047' });
    listProposalsMock.mockResolvedValue({ proposals: [ackProposal('prop-b', 'demo-hitl-00000539-0001')] });
    const navigate = renderPage();

    const link = await screen.findByRole('button', { name: 'Open case CASE-000047' });
    expect(link).toHaveTextContent('CASE-000047');
    expect(document.body.textContent).not.toContain('demo-hitl-00000539-0001');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('cases', { caseId: 'demo-hitl-00000539-0001' });
    expect(getCaseMock).toHaveBeenCalledWith('demo-hitl-00000539-0001');
  });

  it('reads the automation rationale in plain words', async () => {
    getCaseMock.mockResolvedValue({ case_id: 'demo-hitl-c', case_number: 'CASE-000048' });
    listProposalsMock.mockResolvedValue({ proposals: [ackProposal('prop-c', 'demo-hitl-c')] });
    renderPage();

    expect(
      await screen.findByText(
        "Automation rule demo-seed-approval asked for a review of CASE-000048: the agent's verdict is Needs human and the risk score is 62. Review it before approving.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/verdict=|risk=/)).toBeNull();
  });

  it('falls back to the internal id when the case cannot be read', async () => {
    getCaseMock.mockRejectedValue(new Error('not found'));
    listProposalsMock.mockResolvedValue({ proposals: [ackProposal('prop-d', 'demo-hitl-gone')] });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Open case demo-hitl-gone' })).toBeInTheDocument();
  });

  it('never shows a case number another identity resolved, or one resolved under a grant since removed', async () => {
    getCaseMock.mockResolvedValue({ case_id: 'demo-hitl-w', case_number: 'CASE-000051' });
    listProposalsMock.mockResolvedValue({ proposals: [ackProposal('prop-w', 'demo-hitl-w')] });
    const first = render(
      <TooltipProvider>
        <Approvals onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Open case CASE-000051' })).toBeInTheDocument();
    first.unmount();

    // The same tab, the cache warm: a viewer without cases:read sees the internal id.
    perms.cases = false;
    const second = render(
      <TooltipProvider>
        <Approvals onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByRole('article', { name: 'Automation review proposal' });
    expect(screen.getByTestId('approval-source-case')).toHaveTextContent('demo-hitl-w');
    expect(document.body.textContent).not.toContain('CASE-000051');
    second.unmount();

    // Another user, with the grant, reads the case afresh under their own grant.
    perms.cases = true;
    viewer.username = 'bob';
    getCaseMock.mockClear();
    renderPage();
    expect(await screen.findByRole('button', { name: 'Open case CASE-000051' })).toBeInTheDocument();
    expect(getCaseMock).toHaveBeenCalledWith('demo-hitl-w');
  });

  it('reads a case number that failed again on the next load, and keeps a missing case as its id', async () => {
    // The first read (demo-hitl-x) fails for a moment; demo-hitl-y no longer exists.
    getCaseMock.mockRejectedValueOnce(new ApiError(503, 'Service unavailable'));
    listProposalsMock.mockResolvedValue({
      proposals: [ackProposal('prop-x', 'demo-hitl-x'), ackProposal('prop-y', 'demo-hitl-y')],
    });
    getCaseMock.mockImplementation(async (id: string) => {
      if (id === 'demo-hitl-y') throw new ApiError(404, 'Not found');
      return { case_id: id, case_number: 'CASE-000052' };
    });
    renderPage();
    // The transient failure shows the internal id meanwhile.
    expect(await screen.findByRole('button', { name: 'Open case demo-hitl-x' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open case demo-hitl-y' })).toBeInTheDocument();
    getCaseMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh approvals' }));
    expect(await screen.findByRole('button', { name: 'Open case CASE-000052' })).toBeInTheDocument();
    // The gone case is not read again.
    expect(getCaseMock).toHaveBeenCalledTimes(1);
    expect(getCaseMock).toHaveBeenCalledWith('demo-hitl-x');
  });

  it('does not read cases, or offer to open them, without cases:read', async () => {
    perms.cases = false;
    listProposalsMock.mockResolvedValue({ proposals: [ackProposal('prop-e', 'demo-hitl-e')] });
    renderPage();
    await screen.findByRole('article', { name: 'Automation review proposal' });
    expect(getCaseMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /open case/i })).toBeNull();
    expect(screen.getByTestId('approval-source-case')).toHaveTextContent('demo-hitl-e');
  });

  it('confirms an approval without an em dash', async () => {
    approveMock.mockResolvedValue({ ...SUPPRESSION, status: 'approved' });
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith('Suppression approved. It is now live.'));
    expect(await screen.findByText('No pending proposals')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/\u2014/);
  });

  it('keeps the internal id in an operator-written rationale until the case number is known', async () => {
    let answer: (value: unknown) => void = () => {};
    getCaseMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const written = {
      ...SUPPRESSION,
      id: 'prop-written',
      rationale: 'Analyst closed demo-hitl-x as a false positive.',
      source_case_ids: ['demo-hitl-x'],
    } as unknown as Proposal;
    listProposalsMock.mockResolvedValue({ proposals: [written] });
    renderPage();

    // The lookup is pending: the sentence keeps the id, never a guessed "this case".
    expect(await screen.findByText('Analyst closed demo-hitl-x as a false positive.')).toBeInTheDocument();
    expect(screen.queryByText(/this case/)).toBeNull();
    await waitFor(() => expect(getCaseMock).toHaveBeenCalledWith('demo-hitl-x'));

    answer({ case_id: 'demo-hitl-x', case_number: 'CASE-000053' });
    expect(await screen.findByText('Analyst closed CASE-000053 as a false positive.')).toBeInTheDocument();
  });

  it('groups rows by source or rule inside the queue panel', async () => {
    getCaseMock.mockResolvedValue({ case_id: 'demo-hitl-f', case_number: 'CASE-000050' });
    listProposalsMock.mockResolvedValue({ proposals: [SUPPRESSION, ackProposal('prop-f', 'demo-hitl-f')] });
    renderPage();
    await screen.findByRole('region', { name: 'Pending proposals' });
    await userEvent.click(screen.getByRole('switch', { name: 'Group by source or rule' }));
    const queue = screen.getByRole('region', { name: 'Pending proposals' });
    expect(within(queue).getByRole('heading', { level: 3, name: 'source.ip == 10.0.0.9' })).toBeInTheDocument();
    expect(within(queue).getByRole('heading', { level: 3, name: 'Automation · demo-seed-approval' })).toBeInTheDocument();
  });
});

describe('plainRationale', () => {
  const label = (id: string) => (id === 'case-1' ? 'CASE-000001' : id);

  it('turns the default automation template into a sentence', () => {
    expect(plainRationale(AUTOMATION_RATIONALE('case-1'), label)).toBe(
      "Automation rule demo-seed-approval asked for a review of CASE-000001: the agent's verdict is Needs human and the risk score is 62. Review it before approving.",
    );
  });

  it('says when the case has no verdict, and keeps a fractional risk', () => {
    const text =
      "Threshold automation rule 'r' requested approval for case case-1 (verdict=n/a, risk=61.5). Review before approving.";
    expect(plainRationale(text, label)).toBe(
      'Automation rule r asked for a review of CASE-000001: the case has no verdict yet and the risk score is 61.5. Review it before approving.',
    );
  });

  it('keeps an operator-written rationale, naming its source cases by number', () => {
    expect(plainRationale('Escalate case-1 to the lead.', label, ['case-1'])).toBe('Escalate CASE-000001 to the lead.');
    expect(plainRationale('Nothing to rewrite here.', label, ['case-1'])).toBe('Nothing to rewrite here.');
  });

  it('says "this case" in the template, and keeps the id in written text, while a number is pending', () => {
    const pending = () => null;
    expect(plainRationale(AUTOMATION_RATIONALE('case-1'), pending)).toBe(
      "Automation rule demo-seed-approval asked for a review of this case: the agent's verdict is Needs human and the risk score is 62. Review it before approving.",
    );
    expect(plainRationale('Analyst closed case-1 and case-2 as FP.', pending, ['case-1', 'case-2'])).toBe(
      'Analyst closed case-1 and case-2 as FP.',
    );
    // One number known, the other still pending: only the known one is replaced.
    const oneKnown = (id: string) => (id === 'case-1' ? 'CASE-000001' : null);
    expect(plainRationale('Analyst closed case-1 and case-2 as FP.', oneKnown, ['case-1', 'case-2'])).toBe(
      'Analyst closed CASE-000001 and case-2 as FP.',
    );
  });

  it('never splits an id that another id is a prefix of', () => {
    const numbers: Record<string, string> = { 'case-1': 'CASE-000001', 'case-12': 'CASE-000012' };
    const resolve = (id: string) => numbers[id] ?? null;
    expect(plainRationale('Merge case-12 into case-1.', resolve, ['case-1', 'case-12'])).toBe(
      'Merge CASE-000012 into CASE-000001.',
    );
  });
});
