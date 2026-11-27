/**
 * The runbook outside the Runbook tab (Round 14, SPEC §4.10.11): the Next step card (on
 * the Brief as one row since Round 16), the inspector's Record, the tab count and the
 * queue chip, the Other tasks list with its "Added by" provenance, and the labels of
 * stored data from before Round 14. The inspector has no Runbook section since Round 16:
 * the run is the Response tab's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { AutomationApplied } from '@/soc/pages/casedetail/AutomationApplied';

import { OtherTasks, OtherTasksLoader, taskAuthors } from '../OtherTasks';
import { RunbookProgressChip, RunbookTabCount } from '../ProgressChip';
import { makeRun, progress } from './fixtures';

// The inspector keeps each section's open state per viewer: start every test afresh.
afterEach(() => {
  window.localStorage.clear();
});

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

describe('the Brief Next step row', () => {
  it('sits first on the Brief, as one row, when the case has a run', () => {
    const onOpenRunbook = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <OverviewPanel c={CASE} runbookRun={makeRun()} onOpenRunbook={onOpenRunbook} />
      </TooltipProvider>,
    );
    const panel = container.querySelector('[data-case-panel="overview"]') as HTMLElement;
    const first = panel.firstElementChild as HTMLElement;
    expect(first).toHaveAttribute('data-testid', 'case-tab-first');
    expect(first.firstElementChild).toHaveAttribute('data-overview-runbook');
    fireEvent.click(within(first.firstElementChild as HTMLElement).getByRole('button', { name: 'Open' }));
    expect(onOpenRunbook).toHaveBeenCalledTimes(1);
  });
});

describe('Automation and facts rail labels', () => {
  it('names the runbook the investigator used, and labels stored data from before Round 14', () => {
    const legacy = {
      ...CASE,
      runbook_id: null,
      playbook_id: 'pb-ssh',
      automation_actions: [{ action: 'run_playbook', rule_id: 'r1', detail: 'Queued', at: '2026-10-28T13:00:00Z' }],
    } as unknown as Case;
    // Round 15 (D8.3): "Automation applied" sits under the decision on Investigation.
    render(
      <TooltipProvider>
        <AutomationApplied c={legacy} />
        <FactsRail c={legacy} outcome={caseOutcome(legacy)} triage={null} canViewCost={false} onCaseChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Older runbook automation')).toBeInTheDocument();
    // The investigator's stored runbook id is a fact of the record (Round 15, D8.4), in
    // the Record section, which starts closed (Round 16).
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByTestId('facts-record')).toHaveTextContent('Older runbookpb-ssh');
    expect(document.body.textContent).not.toMatch(/Queued playbook|Playbook pb-ssh/);
  });

  it('keeps the run out of the inspector, and names the investigator runbook in Record', () => {
    render(
      <TooltipProvider>
        <FactsRail c={CASE} outcome={caseOutcome(CASE)} triage={null} canViewCost={false} onCaseChange={vi.fn()} />
      </TooltipProvider>,
    );
    // Round 16: the run, its phases and counts are the Response tab's.
    expect(screen.queryByTestId('facts-runbook')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByTestId('facts-record')).toHaveTextContent('Investigator runbookbrute-force v4');
  });

  it('leaves the facts rail Runbook section out for a viewer who cannot read runbooks', () => {
    render(
      <TooltipProvider>
        <FactsRail c={CASE} outcome={caseOutcome(CASE)} triage={null} canViewCost={false} onCaseChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId('facts-runbook')).toBeNull();
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
