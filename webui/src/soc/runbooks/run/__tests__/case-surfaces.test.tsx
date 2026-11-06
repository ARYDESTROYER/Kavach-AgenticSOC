/**
 * The runbook outside the Runbook tab (Round 14, SPEC §4.10.11): the Next step card on
 * the Overview, the facts rail "Runbook" section, the tab count and the queue chip, the
 * Other tasks list with its "Added by" provenance, and the labels of stored data from
 * before Round 14.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const caseApi = vi.hoisted(() => ({
  getActivity: vi.fn(),
  getTasks: vi.fn(),
  addTask: vi.fn(),
  patchTask: vi.fn(),
  logTask: vi.fn(),
}));

vi.mock('@/soc/pages/CaseDetail.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/pages/CaseDetail.api')>();
  return { ...actual, ...caseApi };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

import type { Case } from '@/lib/types';
import type { CaseTask } from '@/soc/pages/CaseDetail.api';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';
import { FactsRail } from '@/soc/pages/casedetail/FactsRail';
import { OverviewPanel } from '@/soc/pages/casedetail/OverviewPanel';

import { OverviewNextStep } from '../NextStepCard';
import { OtherTasks, OtherTasksLoader, taskAuthors } from '../OtherTasks';
import { RunbookProgressChip, RunbookTabCount } from '../ProgressChip';
import { RunbookRail } from '../RunbookRail';
import { completedRun, makeData, makeRun, progress } from './fixtures';

const CASE = {
  case_id: 'case-1',
  case_number: 'CASE-000214',
  title: 'Password spray against the VPN',
  status: 'open',
  verdict: 'NEEDS_HUMAN',
  confidence: 0.6,
  risk_score: 62,
  rule_ids: ['auth-failures'],
  created_at: '2026-10-28T12:50:00Z',
  updated_at: '2026-10-28T13:00:00Z',
  evidence: [],
  runbook_id: 'brute-force',
  runbook_version: 4,
} as unknown as Case;

const TASK: CaseTask = {
  id: 'task-1',
  case_id: 'case-1',
  title: 'Tell the VPN owner',
  assignee: null,
  status: 'open',
  order: 0,
  created_at: '2026-10-28T14:29:00Z',
  logs: [],
} as unknown as CaseTask;

describe('Overview Next step card', () => {
  it('offers Review draft when an AI draft waits, and opens the Runbook tab on that step', async () => {
    const onOpen = vi.fn();
    const run = makeRun();
    render(<OverviewNextStep run={run} progress={progress()} onOpenRunbook={onOpen} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    expect(card).toHaveTextContent('Investigate · step 3 of 6');
    expect(card).toHaveTextContent('Did any sign-in succeed after the failures?');
    await userEvent.click(within(card).getByRole('button', { name: 'Review draft' }));
    expect(onOpen).toHaveBeenCalledWith('success');
  });

  it('says when every required step is done (the server has completed the run by then)', async () => {
    const onOpen = vi.fn();
    const run = completedRun();
    render(<OverviewNextStep run={run} progress={progress({ done: 5, required_open: 0 })} onOpenRunbook={onOpen} />);
    expect(screen.getByText('All required steps are done.')).toBeInTheDocument();
    // Open runbook lands on the tab's card, which a completed run keeps (it has its own heading).
    await userEvent.click(screen.getByRole('button', { name: 'Open runbook' }));
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  it('says when the rest wait for approval, and when the run was abandoned', () => {
    const waiting = makeRun({}, {
      success: { status: 'done', ai_draft: null },
      confirmed: { status: 'done' },
      reset: { status: 'in_progress', approval: { required_role: 'incident_lead', status: 'pending', by: null, at: null, reason: null } },
    });
    const { unmount } = render(
      <OverviewNextStep run={waiting} progress={progress({ done: 4, required_open: 1, waiting: 1 })} onOpenRunbook={vi.fn()} />,
    );
    expect(screen.getByText('The remaining required steps wait for approval.')).toBeInTheDocument();
    unmount();
    render(<OverviewNextStep run={makeRun({ status: 'abandoned' })} progress={progress()} onOpenRunbook={vi.fn()} />);
    expect(screen.getByText('This runbook was abandoned.')).toBeInTheDocument();
  });

  it('sits first on the Overview when the case passes one', () => {
    const { container } = render(
      <TooltipProvider>
        <OverviewPanel
          c={CASE}
          fpPolicy={null}
          triage={null}
          triageLoading={false}
          presentation="case-manager"
          runbookCard={<OverviewNextStep run={makeRun()} progress={progress()} onOpenRunbook={vi.fn()} />}
        />
      </TooltipProvider>,
    );
    const panel = container.querySelector('[data-case-panel="overview"]') as HTMLElement;
    expect(panel.firstElementChild).toHaveAttribute('data-overview-runbook');
  });
});

describe('Overview and facts rail labels', () => {
  it('names the runbook the investigator used, and labels stored data from before Round 14', () => {
    render(
      <TooltipProvider>
        <OverviewPanel
          c={{
            ...CASE,
            runbook_id: null,
            playbook_id: 'pb-ssh',
            automation_actions: [{ action: 'run_playbook', rule_id: 'r1', detail: 'Queued', at: '2026-10-28T13:00:00Z' }],
          } as unknown as Case}
          fpPolicy={null}
          triage={null}
          triageLoading={false}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Provenance & audit/ }));
    expect(screen.getByText('Runbook automation (before Round 14)')).toBeInTheDocument();
    expect(screen.getByText('Runbook (before Round 14) pb-ssh')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Queued playbook|Playbook pb-ssh/);
  });

  it('adds a Runbook section to the facts rail whose phases open the tab there', () => {
    const onOpenPhase = vi.fn();
    render(
      <TooltipProvider>
        <FactsRail
          c={CASE}
          outcome={caseOutcome(CASE)}
          triage={null}
          users={[]}
          canAssign={false}
          onCaseChange={vi.fn()}
          runbook={{ data: makeData(), loading: false, failed: false, onOpenPhase }}
        />
      </TooltipProvider>,
    );
    const section = screen.getByTestId('facts-runbook');
    expect(section).toHaveTextContent('Brute force and password spray · v4');
    expect(section).toHaveTextContent('2 of 6 done');
    fireEvent.click(within(section).getByRole('button', { name: 'Contain, 0 of 2 done. Open the Runbook tab on this phase' }));
    expect(onOpenPhase).toHaveBeenCalledWith('contain');
    expect(screen.getByTestId('facts-record')).toHaveTextContent('Investigator runbookbrute-force v4');
  });

  it('leaves the facts rail Runbook section out for a viewer with no Runbook tab', () => {
    render(
      <TooltipProvider>
        <FactsRail c={CASE} outcome={caseOutcome(CASE)} triage={null} users={[]} canAssign={false} onCaseChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('facts-runbook')).toBeNull();
  });

  it('words the rail when nothing is attached or the read failed', () => {
    const { rerender } = render(<RunbookRail data={makeData([])} />);
    expect(screen.getByText('No runbook is attached to this case.')).toBeInTheDocument();
    rerender(<RunbookRail data={null} failed />);
    expect(screen.getByText('The runbook could not be read.')).toBeInTheDocument();
    rerender(<RunbookRail data={null} loading />);
    expect(screen.getByText('Loading the runbook.')).toBeInTheDocument();
  });
});

describe('tab count and queue chip', () => {
  it('reads the progress in full for assistive technology', () => {
    const { rerender, container } = render(<RunbookProgressChip progress={progress({ waiting: 1 })} />);
    expect(screen.getByRole('img', { name: 'Runbook: 2 of 6 steps done, 1 waiting for approval' })).toHaveTextContent('2/6 · 1 waiting');
    // Inside a row whose name carries the fact, the chip is hidden from it.
    rerender(<RunbookProgressChip progress={progress()} decorative />);
    expect(container.querySelector('[data-runbook-progress]')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says None on the tab when no runbook is attached', () => {
    const { unmount } = render(<RunbookTabCount progress={null} />);
    expect(screen.getByText('None')).toBeInTheDocument();
    unmount();
    // Only abandoned runs on the case: the tab still shows them, so it never says None.
    render(<RunbookTabCount progress={null} abandoned />);
    expect(screen.getByText('Abandoned')).toBeInTheDocument();
    expect(screen.queryByText('None')).toBeNull();
  });
});

describe('Other tasks', () => {
  it('reads who added each task from the case activity', () => {
    const authors = taskAuthors([
      { kind: 'comment', actor: 'ben', ts: '2026-10-28T14:00:00Z' },
      { kind: 'task_added', actor: 'asha', ts: '2026-10-28T14:29:00Z', ref: { task_id: 'task-1' } },
    ]);
    expect(authors.get('task-1')).toEqual({ by: 'asha', at: '2026-10-28T14:29:00Z' });
  });

  it('shows "Added by" provenance, adds a task, and reads the runbooks again', async () => {
    caseApi.getActivity.mockResolvedValue({
      case_id: 'case-1',
      activity: [{ id: 'a1', case_id: 'case-1', source: 'activity', kind: 'task_added', actor: 'asha', ts: '2026-10-28T14:29:00Z', summary: '', ref: { task_id: 'task-1' } }],
      count: 1,
    });
    caseApi.addTask.mockResolvedValue({});
    const onChanged = vi.fn();
    render(<OtherTasks caseId="case-1" tasks={[TASK]} canWrite nameOf={(u) => (u === 'asha' ? 'Asha Rao' : u)} onChanged={onChanged} />);
    expect(screen.getByRole('heading', { name: 'Other tasks' })).toBeInTheDocument();
    expect(await screen.findByText(/Added by Asha Rao at .*14:29 UTC · not from the runbook/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Add task' }), 'Rotate the VPN secret');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(caseApi.addTask).toHaveBeenCalledWith('case-1', { title: 'Rotate the VPN secret' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reads the tasks itself for a viewer with no Runbook tab, with a retry when that fails', async () => {
    caseApi.getActivity.mockResolvedValue({ case_id: 'case-1', activity: [], count: 0 });
    caseApi.getTasks.mockRejectedValueOnce(new Error('tasks unavailable')).mockResolvedValue({ case_id: 'case-1', tasks: [TASK], count: 1 });
    render(<OtherTasksLoader caseId="case-1" canWrite={false} />);
    expect(await screen.findByText('Could not load tasks')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry tasks' }));
    expect(await screen.findByText('Tell the VPN owner')).toBeInTheDocument();
  });
});
