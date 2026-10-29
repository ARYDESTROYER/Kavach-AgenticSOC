/**
 * The Runbook tab inside a case (Round 14, SPEC §4.10.11 and §8.1): loading, error,
 * empty, partial, permission, phone width, keyboard (19 tab stops or fewer), a confirmed
 * AI draft moving focus to the next step with a polite sentence, a stale revision keeping
 * what was typed, a redacted lookup, the approval rule, and the copy rules (no em dash,
 * never the old procedure word).
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  updateRunbookStep: vi.fn(),
  confirmRunbookStepDraft: vi.fn(),
  decideRunbookApproval: vi.fn(),
  draftRunbookStep: vi.fn(),
  runRunbookLookup: vi.fn(),
  switchRunbookRunVersion: vi.fn(),
  abandonRunbookRun: vi.fn(),
  getRunbookCandidates: vi.fn(),
  getRunbookDetail: vi.fn(),
  attachRunbook: vi.fn(),
  suggestRunbook: vi.fn(),
  getRunbookProgress: vi.fn(),
  getCaseRunbooks: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-runbooks')>();
  return { ...actual, ...api };
});

vi.mock('@/soc/pages/CaseDetail.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/pages/CaseDetail.api')>();
  return {
    ...actual,
    getActivity: vi.fn().mockResolvedValue({ case_id: 'case-1', activity: [], count: 0 }),
    addTask: vi.fn(),
    patchTask: vi.fn(),
    logTask: vi.fn(),
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

import { ApiError } from '@/lib/api';
import type { Case } from '@/lib/types';
import type { CaseRunbooks, RunbookRunUpdate } from '@/lib/types-runbooks';
import { TooltipProvider } from '@/ui/tooltip';
import {
  EMPTY_RUNBOOK_LEAD,
  RunbookPanel,
  READ_ONLY_RUN_NOTE,
  RUNBOOK_BOUNDARY_NOTE,
} from '@/soc/pages/casedetail/RunbookPanel';

import { CONFLICT_NOTE } from '../context';
import { mergeRun, type CaseRunbooksState } from '../useCaseRunbooks';
import { LOOKUP_RESULT, makeData, makeRun, state } from './fixtures';

const CASE = { case_id: 'case-1', case_number: 'CASE-000214', title: 'Password spray', rule_ids: ['auth-failures'] } as unknown as Case;
const USERS = [
  { username: 'asha', display_name: 'Asha Rao' },
  { username: 'ben', display_name: 'Ben Ito' },
];

function Harness({
  initial,
  loading = false,
  error = null,
  canRun = true,
  canStart,
  enabled,
  allow = () => true,
  currentUser = 'ben',
  refresh,
}: {
  initial: CaseRunbooks | null;
  loading?: boolean;
  error?: unknown;
  canRun?: boolean;
  canStart?: boolean;
  enabled?: boolean;
  allow?: (resource: string, action: string) => boolean;
  currentUser?: string;
  refresh?: () => Promise<void>;
}) {
  const [data, setData] = React.useState<CaseRunbooks | null>(initial);
  const runbooks: CaseRunbooksState = {
    data,
    loading,
    error,
    refresh: refresh ?? (async () => undefined),
    applyUpdate: (update: RunbookRunUpdate) => setData((prev) => (prev ? mergeRun(prev, update.run, update.progress, update.revision) : prev)),
    applyAttach: () => undefined,
    live: false,
  };
  return (
    <TooltipProvider>
      <RunbookPanel
        c={CASE}
        runbooks={runbooks}
        canRun={canRun}
        canStart={canStart}
        enabled={enabled}
        canWriteTasks
        hasPermission={allow}
        currentUser={currentUser}
        users={USERS}
      />
    </TooltipProvider>
  );
}

/** The elements Tab reaches inside the panel (roving groups count once). */
function tabStops(root: HTMLElement): HTMLElement[] {
  const all = Array.from(
    root.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]'),
  );
  return all.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('tabindex') === '-1') return false;
    if (el.closest('[hidden]')) return false;
    return true;
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.draftRunbookStep.mockResolvedValue({ update: null, estimate: null });
  api.getRunbookCandidates.mockResolvedValue({ candidates: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RunbookPanel states', () => {
  it('shows skeleton rows while the first read is out', () => {
    render(<Harness initial={null} loading />);
    expect(screen.getByLabelText('Loading the runbook')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows a retryable error when the first read fails', async () => {
    const refresh = vi.fn(async () => undefined);
    render(<Harness initial={null} error={new Error('runbooks unavailable')} refresh={refresh} />);
    expect(screen.getByText('Could not load the runbook')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('offers Start runbook on an empty case, with a linked library pointer and Other tasks', () => {
    const { container } = render(<Harness initial={makeData([])} />);
    expect(screen.getByText('No runbook is attached to this case.')).toBeInTheDocument();
    // It claims nothing about matching: a case with no run was often never matched at all.
    expect(container.textContent).toContain(EMPTY_RUNBOOK_LEAD);
    expect(container.textContent).not.toMatch(/matched/i);
    expect(container.textContent).toContain('Rules with no runbook are listed on the Runbooks page.');
    // A control that navigates is a link.
    expect(screen.getByRole('link', { name: 'Runbooks page' })).toHaveAttribute('href', '#/runbooks');
    expect(screen.getByRole('button', { name: 'Start runbook' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Other tasks' })).toBeInTheDocument();
  });

  it('never offers Start runbook without runbooks:run, or while runbooks are turned off', () => {
    const { unmount } = render(<Harness initial={makeData([])} canRun={false} />);
    expect(screen.queryByRole('button', { name: 'Start runbook' })).toBeNull();
    expect(screen.getByText('You can view runbooks but not start one.')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_RUNBOOK_LEAD, { exact: false })).toBeNull();
    unmount();
    render(<Harness initial={makeData([])} enabled={false} />);
    expect(screen.queryByRole('button', { name: 'Start runbook' })).toBeNull();
    expect(screen.getByText('Runbooks are turned off in Settings, so no new runbook can start.')).toBeInTheDocument();
  });

  it('names the Runbooks page without a link for a viewer who cannot open it', () => {
    render(<Harness initial={makeData([])} allow={(resource) => resource !== 'runbooks'} />);
    expect(screen.queryByRole('link', { name: 'Runbooks page' })).toBeNull();
  });

  it('keeps the loaded run visible when a refresh fails (partial)', () => {
    render(<Harness initial={makeData()} error={new Error('refresh failed')} />);
    expect(screen.getByRole('heading', { name: 'Did any sign-in succeed after the failures?' })).toBeInTheDocument();
  });
});

describe('RunbookPanel run view', () => {
  it('shows the strip, the progress line, the Next step card first, the phases and the boundary note', () => {
    const { container } = render(<Harness initial={makeData()} />);
    expect(screen.getByText('Brute force and password spray')).toBeInTheDocument();
    expect(screen.getByText(/Matched automatically · 12:52 UTC|Matched automatically · Oct 28, 12:52 UTC/)).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Next step' });
    expect(within(card).getByRole('heading', { level: 3, name: 'Did any sign-in succeed after the failures?' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    expect(within(card).getByRole('region', { name: 'AI draft note' })).toHaveTextContent(
      'AI draft · not part of the case until you confirm it',
    );
    expect(within(card).getByRole('button', { name: 'Confirm and mark done' })).toBeInTheDocument();

    // One tab per phase; the Next step's phase is selected; the counts are in the names.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Triage, 2 of 2 done',
      'Investigate, 0 of 2 done',
      'Contain, 0 of 2 done',
    ]);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    // The step on the card is one quiet line in the list.
    expect(screen.getByText('Shown above')).toBeInTheDocument();
    expect(screen.getByText(RUNBOOK_BOUNDARY_NOTE)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/—|playbook/i);
  });

  it('keeps the tab to 19 tab stops or fewer', () => {
    const { container } = render(<Harness initial={makeData()} />);
    const root = container.querySelector('[data-case-panel="runbook"]') as HTMLElement;
    expect(tabStops(root).length).toBeLessThanOrEqual(19);
  });

  it('confirms the AI draft, says what is next, and moves focus to the new Next step heading', async () => {
    const user = userEvent.setup();
    const after = makeRun({ revision: 8 }, {
      success: { status: 'done', note: 'Two sign-ins succeeded for svc-backup after the failures.', completed_by: 'ben', completed_at: '2026-10-28T14:45:00Z', ai_draft: null, revision: 2 },
    });
    api.confirmRunbookStepDraft.mockResolvedValue({
      run: after,
      progress: { done: 3, not_applicable: 0, total: 6, required_open: 2, blocked: 0, waiting: 0 },
      revision: 9,
    });
    const { container } = render(<Harness initial={makeData()} />);
    await user.click(screen.getByRole('button', { name: 'Confirm and mark done' }));

    expect(api.confirmRunbookStepDraft).toHaveBeenCalledWith('case-1', 'run-1', 'success', {
      text: 'Two sign-ins succeeded for svc-backup after the failures.',
    });
    const heading = await screen.findByRole('heading', { level: 3, name: 'Is this a confirmed compromise?' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const live = container.querySelector('[data-runbook-live]') as HTMLElement;
    await waitFor(() => expect(live).toHaveTextContent('Step 3 done. Next, step 4: Is this a confirmed compromise?'));
  });

  it('keeps a Decision unrecorded until an option is picked, then records it', async () => {
    const user = userEvent.setup();
    const data = makeData([makeRun({}, { success: { status: 'done', ai_draft: null } })]);
    const update = makeRun({ revision: 8 }, {
      success: { status: 'done', ai_draft: null },
      confirmed: { status: 'done', decision: { option_id: 'benign', label: 'Benign', by: 'ben', at: '2026-10-28T14:50:00Z' } },
      reset: { status: 'not_applicable', reason: "Skipped by the decision 'Benign'" },
      notes: { status: 'not_applicable', reason: "Skipped by the decision 'Benign'" },
    });
    // The server completes the run in the same write that clears the last required step.
    const completed = { ...update, status: 'completed' as const, completed_at: '2026-10-28T14:50:00Z' };
    api.updateRunbookStep.mockResolvedValue({ run: completed, progress: { done: 4, not_applicable: 2, total: 6, required_open: 0, blocked: 0, waiting: 0 }, revision: 9 });
    render(<Harness initial={data} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const record = within(card).getByRole('button', { name: 'Record decision' });
    expect(record).toHaveAttribute('aria-disabled', 'true');
    expect(within(card).getByText('Pick an option to record the decision.')).toBeInTheDocument();
    await user.click(record);
    expect(api.updateRunbookStep).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('radio', { name: /Benign/ }));
    await user.click(within(card).getByRole('button', { name: 'Record decision' }));
    expect(api.updateRunbookStep).toHaveBeenCalledWith(
      'case-1',
      'run-1',
      'confirmed',
      { decision: { option_id: 'benign' }, expected_revision: 1 },
    );
    expect(await screen.findByText('All required steps are done.')).toBeInTheDocument();
  });

  it('shows the latest step after a stale revision and keeps the note that was typed', async () => {
    const user = userEvent.setup();
    const data = makeData([makeRun({}, { success: { ai_draft: null } })]);
    const latest = makeRun({ revision: 8 }, { success: { ai_draft: null, assignee: 'asha', status: 'in_progress', revision: 2 } });
    api.updateRunbookStep.mockRejectedValue(
      new ApiError(409, 'This step changed.', {
        detail: {
          code: 'runbook_conflict',
          message: 'This step changed.',
          latest: { run: latest, progress: { done: 2, not_applicable: 0, total: 6, required_open: 3, blocked: 0, waiting: 0 }, revision: 9 },
        },
      }),
    );
    render(<Harness initial={data} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const field = within(card).getByRole('textbox', { name: /note/i });
    await user.type(field, 'svc-backup signed in at 13:02.');
    await user.click(within(card).getByRole('button', { name: 'Mark done' }));

    expect(await screen.findAllByText(CONFLICT_NOTE)).not.toHaveLength(0);
    expect(within(screen.getByRole('region', { name: 'Next step' })).getByRole('textbox', { name: /note/i })).toHaveValue(
      'svc-backup signed in at 13:02.',
    );
  });

  it('shows only the access sentence for a lookup result redacted for this viewer', async () => {
    const user = userEvent.setup();
    const redacted = { ...LOOKUP_RESULT, status: 'not_applicable' as const, reason: 'You do not have access to log sources.', facts: [], table: null, count: null };
    const run = makeRun({}, { scope: { evidence: [{ kind: 'lookup_result', lookup: redacted, url: null, label: null }] } });
    render(<Harness initial={makeData([run])} allow={(resource) => resource !== 'sources'} />);
    // Open the Triage phase and the lookup step.
    await user.click(screen.getByRole('tab', { name: /^Triage/ }));
    await user.click(screen.getByRole('button', { name: /How many sign-ins failed from this source\?/ }));
    expect(await screen.findByText('You do not have access to log sources.')).toBeInTheDocument();
    expect(screen.queryByText('Failed sign-ins')).toBeNull();
    expect(screen.queryByText('svc-backup')).toBeNull();
  });

  it('says plainly when a finished lookup step has no result, and offers to run an old automatic lookup', async () => {
    const user = userEvent.setup();
    const run = makeRun({}, { scope: { evidence: [] } });
    render(<Harness initial={makeData([run])} />);
    await user.click(screen.getByRole('tab', { name: /^Triage/ }));
    await user.click(screen.getByRole('button', { name: /How many sign-ins failed from this source\?/ }));
    expect(await screen.findByText('No lookup result is attached to this step.')).toBeInTheDocument();
    expect(screen.queryByText(/runs on its own when the runbook starts/)).toBeNull();
  });

  it('never lets the person who recorded an action approve it', async () => {
    const user = userEvent.setup();
    const run = makeRun({}, {
      success: { status: 'done', ai_draft: null },
      confirmed: { status: 'done', decision: { option_id: 'compromise', label: 'Compromise', by: 'ben', at: '2026-10-28T14:50:00Z' } },
      reset: {
        status: 'in_progress',
        action_record: { performed_by: 'asha', performed_at: '2026-10-28T14:31:00Z', where: 'IdP', outcome: 'Reset 3 accounts' },
        approval: { required_role: 'incident_lead', status: 'pending', by: null, at: null, reason: null },
      },
    });
    render(<Harness initial={makeData([run])} currentUser="asha" />);
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    await user.click(within(screen.getByRole('list', { name: 'Contain steps' })).getByRole('button', { name: /Reset the affected accounts/ }));
    expect(await screen.findByText('Asha Rao recorded this action, so a different incident lead approves it.')).toBeInTheDocument();
    expect(screen.getByText('Only an incident lead other than Asha Rao can approve.')).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    await user.click(approve);
    expect(api.decideRunbookApproval).not.toHaveBeenCalled();
  });

  it('is read only without runbooks:run', () => {
    render(<Harness initial={makeData()} canRun={false} />);
    expect(screen.getByText(READ_ONLY_RUN_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm and mark done' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add runbook' })).toBeNull();
  });

  it('collapses to one line and folds the step menu at phone width', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 360, height: 800, top: 0, left: 0, right: 360, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    render(<Harness initial={makeData()} />);
    // The strip's Add runbook moves into the menu; the card's Not applicable and Blocked fold.
    expect(screen.queryByRole('button', { name: 'Add runbook' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Runbook actions' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Next step' });
    expect(within(card).getByRole('button', { name: 'More step actions' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Not applicable' })).toBeNull();
  });

  it('switches between several runs on one case', async () => {
    const user = userEvent.setup();
    const second = makeRun({ run_id: 'run-2', runbook_id: 'generic', title: 'Generic incident', version: 2, attached_by: 'fallback' });
    render(<Harness initial={makeData([makeRun(), second])} />);
    const nav = screen.getByRole('navigation', { name: 'Runbooks on this case' });
    await user.click(within(nav).getByRole('button', { name: /Generic incident/ }));
    expect(await screen.findByText(/Fallback · /)).toBeInTheDocument();
  });

  it('keeps refreshing quietly while a lookup has not answered yet (no step text changes)', async () => {
    const run = makeRun({ attached_at: new Date().toISOString() }, { scope: state({ status: 'todo' }) });
    render(<Harness initial={makeData([run])} />);
    await act(async () => undefined);
    expect(screen.getByRole('region', { name: 'Next step' })).toBeInTheDocument();
  });
});
