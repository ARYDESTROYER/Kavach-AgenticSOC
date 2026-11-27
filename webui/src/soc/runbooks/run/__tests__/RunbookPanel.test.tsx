/**
 * The Runbook tab inside a case (Round 14, SPEC §4.10.11 and §8.1): loading, error,
 * empty, partial, permission, phone width, keyboard (19 tab stops or fewer), a confirmed
 * AI draft moving focus to the next step with a polite sentence, a draft landing without
 * rebuilding the card's buttons (an open dialog or menu stays, focus stays or moves to the
 * heading), the draft's four-line preview (its toggle never leaves from under focus), a
 * stale revision keeping what was typed, a redacted lookup, the approval rule, and the
 * copy rules (no em dash, never the old procedure word).
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
  exportRunbookVersionMarkdown: vi.fn(),
}));
const download = vi.hoisted(() => ({ downloadBlob: vi.fn() }));

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

vi.mock('@/lib/download-blob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/download-blob')>();
  return { ...actual, downloadBlob: download.downloadBlob };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import type { Case } from '@/lib/types';
import type { CaseRunbooks, RunbookRunUpdate } from '@/lib/types-runbooks';
import { TooltipProvider } from '@/ui/tooltip';
import {
  EMPTY_RUNBOOK_LEAD,
  RunbookPanel,
  READ_ONLY_RUN_NOTE,
  RUNBOOK_BOUNDARY_NOTE,
  type RunbookFocusRequest,
} from '@/soc/pages/casedetail/RunbookPanel';

import { CONFLICT_NOTE, DRAFT_READY_NOTE } from '../context';
import { focusHeading } from '../NextStepCard';
import { DRAFT_SHOW_ALL, DRAFT_SHOW_LESS } from '../StepParts';
import { mergeRun, type CaseRunbooksState } from '../useCaseRunbooks';
import { LOOKUP_RESULT, completedRun, makeData, makeRun, state } from './fixtures';

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
  live,
  focusRequest,
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
  /** Receives the merge a live `case.runbook` frame goes through (a teammate's write). */
  live?: { current: ((update: RunbookRunUpdate) => void) | null };
  focusRequest?: RunbookFocusRequest | null;
}) {
  const [data, setData] = React.useState<CaseRunbooks | null>(initial);
  const applyUpdate = React.useCallback(
    (update: RunbookRunUpdate) => setData((prev) => (prev ? mergeRun(prev, update.run, update.progress, update.revision) : prev)),
    [],
  );
  React.useEffect(() => {
    if (live) live.current = applyUpdate;
  }, [live, applyUpdate]);
  const runbooks: CaseRunbooksState = {
    data,
    loading,
    error,
    refresh: refresh ?? (async () => undefined),
    applyUpdate,
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
        focusRequest={focusRequest}
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
  download.downloadBlob.mockReset().mockReturnValue(true);
  api.draftRunbookStep.mockResolvedValue({ update: null, estimate: null });
  api.getRunbookCandidates.mockResolvedValue({ candidates: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("exports the run's pinned version through the runbook client, named for that version", async () => {
    const user = userEvent.setup();
    const blob = new Blob(['# Brute force'], { type: 'text/markdown' });
    api.exportRunbookVersionMarkdown.mockResolvedValue({ blob, contentDisposition: null, contentType: 'text/markdown' });
    render(<Harness initial={makeData([makeRun({ runbook_id: 'brute-force', version: 4 })])} />);
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Export as Markdown' }));
    await waitFor(() => expect(download.downloadBlob).toHaveBeenCalledWith('brute-force-v4.md', blob));
    expect(api.exportRunbookVersionMarkdown).toHaveBeenCalledTimes(1);
    expect(api.exportRunbookVersionMarkdown).toHaveBeenCalledWith('brute-force', 4);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says why an export failed, in the refusal the server gave', async () => {
    const user = userEvent.setup();
    api.exportRunbookVersionMarkdown.mockRejectedValue(
      new ApiError(404, 'That version of the runbook is not available.', {
        detail: { code: 'runbook_version_not_found', message: 'That version of the runbook is not available.' },
      }),
    );
    render(<Harness initial={makeData([makeRun({ runbook_id: 'brute-force', version: 4 })])} />);
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Export as Markdown' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That version of the runbook is not available.'));
    expect(download.downloadBlob).not.toHaveBeenCalled();
  });

  it('keeps refreshing quietly while a lookup has not answered yet (no step text changes)', async () => {
    const run = makeRun({ attached_at: new Date().toISOString() }, { scope: state({ status: 'todo' }) });
    render(<Harness initial={makeData([run])} />);
    await act(async () => undefined);
    expect(screen.getByRole('region', { name: 'Next step' })).toBeInTheDocument();
  });
});

/** A model's draft at its longest (`RUNBOOK_AI_DRAFT_MAX_CHARS`, 2,000 characters). */
const LONG_DRAFT = (
  'Draft: the lookup for "Sign-ins for this account in the last 7 days" found 17 events from 203.0.113.7; ' +
  'the lookup for "Reputation of the sign-in IP" did not apply to this case. '
)
  .repeat(20)
  .slice(0, 2_000);

function withDraft(text: string) {
  return makeRun({}, {
    success: { ai_draft: { text, created_at: '2026-10-28T14:40:00Z', model: 'demo', usage_id: 'u-1', confirmed: false } },
  });
}

/** jsdom lays nothing out: report every draft text as taller than its four-line preview. */
function draftTextOverflows() {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-ai-draft-text') ? 240 : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-ai-draft-text') ? 88 : 0;
  });
}

/** Like `draftTextOverflows`, with a switch: set `fits` and the draft text fits in four lines. */
function draftHeights(): { fits: boolean } {
  const heights = { fits: false };
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-ai-draft-text') ? (heights.fits ? 88 : 240) : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-ai-draft-text') ? 88 : 0;
  });
  return heights;
}

/** Stands in for ResizeObserver so a test can say "the pane changed size": `fire()`. */
function captureResizeObservers(): { fire: () => void } {
  const live = new Set<() => void>();
  class CapturingResizeObserver {
    private readonly notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
    }
    observe(): void {
      live.add(this.notify);
    }
    unobserve(): void {}
    disconnect(): void {
      live.delete(this.notify);
    }
  }
  vi.stubGlobal('ResizeObserver', CapturingResizeObserver);
  return { fire: () => live.forEach((notify) => notify()) };
}

function follows(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('Next step card with an AI draft (SPEC §4.10.11, Confirm keeps its place)', () => {
  it('puts Confirm, Edit note and the step buttons under the question, before the draft they act on', () => {
    render(<Harness initial={makeData()} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const heading = within(card).getByRole('heading', { level: 3 });
    const confirm = within(card).getByRole('button', { name: 'Confirm and mark done' });
    const edit = within(card).getByRole('button', { name: 'Edit note' });
    const draft = within(card).getByRole('region', { name: 'AI draft note' });
    expect(follows(heading, confirm)).toBe(true);
    expect(follows(confirm, draft)).toBe(true);
    expect(follows(edit, draft)).toBe(true);
    expect(follows(within(card).getByRole('button', { name: 'Not applicable' }), draft)).toBe(true);
    // Read before the draft, Confirm says what it confirms.
    expect(confirm).toHaveAccessibleDescription('AI draft · not part of the case until you confirm it');
    // A short draft shows whole: the preview is clamped, but nothing is hidden, so no toggle.
    expect(card.querySelector('[data-ai-draft-text]')).toHaveAttribute('data-clamped', 'true');
    expect(within(card).queryByRole('button', { name: DRAFT_SHOW_ALL })).toBeNull();
  });

  it('shows a 2,000-character draft as a four-line preview with Show the whole draft, Confirm still first', async () => {
    draftTextOverflows();
    const user = userEvent.setup();
    const { container } = render(<Harness initial={makeData([withDraft(LONG_DRAFT)])} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const text = card.querySelector('[data-ai-draft-text]') as HTMLElement;
    const toggle = await within(card).findByRole('button', { name: DRAFT_SHOW_ALL });

    // The whole draft stays in the page for a screen reader; only its box is four lines.
    expect(text.textContent).toBe(LONG_DRAFT);
    expect(text).toHaveClass('line-clamp-4');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', text.id);
    const confirm = within(card).getByRole('button', { name: 'Confirm and mark done' });
    expect(follows(confirm, text)).toBe(true);
    expect(follows(confirm, toggle)).toBe(true);

    // The toggle is one more tab stop, inside the tab's limit.
    const root = container.querySelector('[data-case-panel="runbook"]') as HTMLElement;
    expect(tabStops(root).length).toBeLessThanOrEqual(19);

    await user.click(toggle);
    const less = within(card).getByRole('button', { name: DRAFT_SHOW_LESS });
    expect(less).toBe(toggle);
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(text).not.toHaveClass('line-clamp-4');
    expect(text).not.toHaveAttribute('data-clamped');

    await user.click(less);
    expect(within(card).getByRole('button', { name: DRAFT_SHOW_ALL })).toHaveAttribute('aria-expanded', 'false');
    expect(text).toHaveClass('line-clamp-4');

    // Opened, it stays open across Edit note and Cancel edit (the box moves, it is not reset).
    await user.click(within(card).getByRole('button', { name: DRAFT_SHOW_ALL }));
    await user.click(within(card).getByRole('button', { name: 'Edit note' }));
    await user.click(within(card).getByRole('button', { name: 'Cancel edit' }));
    expect(within(card).getByRole('button', { name: DRAFT_SHOW_LESS })).toHaveAttribute('aria-expanded', 'true');
    expect(card.querySelector('[data-ai-draft-text]')).not.toHaveClass('line-clamp-4');
  });

  it('edits the draft as a form: the field first, Confirm note and mark done under it, focus moving with the press', async () => {
    const user = userEvent.setup();
    api.confirmRunbookStepDraft.mockResolvedValue({
      run: makeRun({ revision: 8 }, { success: { status: 'done', note: 'Two sign-ins succeeded.', ai_draft: null, revision: 2 } }),
      progress: { done: 3, not_applicable: 0, total: 6, required_open: 2, blocked: 0, waiting: 0 },
      revision: 9,
    });
    render(<Harness initial={makeData()} />);
    const card = () => screen.getByRole('region', { name: 'Next step' });

    // The field is shorter than the draft: it opens scrolled to the caret at the end.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this instanceof HTMLTextAreaElement ? 178 : 0;
    });
    await user.click(within(card()).getByRole('button', { name: 'Edit note' }));
    const field = within(card()).getByRole('textbox', { name: 'Edit the draft note' }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.scrollTop).toBe(178);
    const confirm = within(card()).getByRole('button', { name: 'Confirm note and mark done' });
    expect(follows(field, confirm)).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(confirm);

    // Cancel edit puts the buttons back above the draft and focus back on Edit note.
    await user.click(within(card()).getByRole('button', { name: 'Cancel edit' }));
    const edit = within(card()).getByRole('button', { name: 'Edit note' });
    expect(document.activeElement).toBe(edit);
    expect(follows(within(card()).getByRole('button', { name: 'Confirm and mark done' }), within(card()).getByRole('region', { name: 'AI draft note' }))).toBe(true);

    // An edited draft is what Confirm sends.
    await user.click(edit);
    const again = within(card()).getByRole('textbox', { name: 'Edit the draft note' });
    await user.clear(again);
    await user.type(again, 'Two sign-ins succeeded.');
    await user.click(within(card()).getByRole('button', { name: 'Confirm note and mark done' }));
    expect(api.confirmRunbookStepDraft).toHaveBeenCalledWith('case-1', 'run-1', 'success', { text: 'Two sign-ins succeeded.' });
  });

  it('keeps Show less and its focus when the open draft has come to fit in four lines', async () => {
    const heights = draftHeights();
    const user = userEvent.setup();
    render(<Harness initial={makeData([withDraft(LONG_DRAFT)])} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    await user.click(await within(card).findByRole('button', { name: DRAFT_SHOW_ALL }));
    // The pane widens while the draft is open (a phone turned to landscape): it now fits.
    heights.fits = true;
    const less = within(card).getByRole('button', { name: DRAFT_SHOW_LESS });
    act(() => less.focus());
    await user.keyboard('{Enter}');

    // Collapsing hid nothing, but the toggle the reader pressed stays, and so does focus.
    const toggle = within(card).getByRole('button', { name: DRAFT_SHOW_ALL });
    expect(toggle).toBe(less);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(toggle);
    expect(card.querySelector('[data-ai-draft-text]')).toHaveClass('line-clamp-4');
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: DRAFT_SHOW_LESS }));
  });

  it('keeps Show the whole draft under focus when a wider pane makes the draft fit', async () => {
    const heights = draftHeights();
    const resize = captureResizeObservers();
    render(<Harness initial={makeData([withDraft(LONG_DRAFT)])} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const toggle = await within(card).findByRole('button', { name: DRAFT_SHOW_ALL });
    act(() => toggle.focus());

    heights.fits = true;
    act(() => resize.fire());

    expect(within(card).getByRole('button', { name: DRAFT_SHOW_ALL })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it('measures a draft it has not been reached for again, and drops a toggle nothing needs', async () => {
    const heights = draftHeights();
    const resize = captureResizeObservers();
    render(<Harness initial={makeData([withDraft(LONG_DRAFT)])} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    expect(await within(card).findByRole('button', { name: DRAFT_SHOW_ALL })).toBeInTheDocument();

    heights.fits = true;
    act(() => resize.fire());

    expect(within(card).queryByRole('button', { name: DRAFT_SHOW_ALL })).toBeNull();
  });

  it("moves focus to the draft, not the page, when a teammate's shorter draft takes the toggle away", async () => {
    const heights = draftHeights();
    const live: { current: ((update: RunbookRunUpdate) => void) | null } = { current: null };
    render(<Harness initial={makeData([withDraft(LONG_DRAFT)])} live={live} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const toggle = await within(card).findByRole('button', { name: DRAFT_SHOW_ALL });
    act(() => toggle.focus());

    // The new draft fits in four lines, and the reader has not reached its toggle yet.
    heights.fits = true;
    act(() => live.current?.(draftLanded()));

    const draft = within(card).getByRole('region', { name: 'AI draft note' });
    expect(draft).toHaveTextContent('Two sign-ins succeeded for svc-backup.');
    expect(within(card).queryByRole('button', { name: DRAFT_SHOW_ALL })).toBeNull();
    expect(document.activeElement).toBe(draft);
    expect(draft).toHaveAttribute('tabindex', '-1');
  });

  it('shows the whole draft in an opened step row', async () => {
    draftTextOverflows();
    const user = userEvent.setup();
    const run = makeRun({}, {
      success: { status: 'done', ai_draft: null },
      notes: { ai_draft: { text: LONG_DRAFT, created_at: '2026-10-28T14:40:00Z', model: 'demo', usage_id: 'u-2', confirmed: false } },
    });
    render(<Harness initial={makeData([run])} />);
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    const list = screen.getByRole('list', { name: 'Contain steps' });
    await user.click(within(list).getByRole('button', { name: /Record the containment/ }));
    const draft = await within(list).findByRole('region', { name: 'AI draft note' });
    const text = draft.querySelector('[data-ai-draft-text]') as HTMLElement;
    expect(text.textContent).toBe(LONG_DRAFT);
    expect(text).not.toHaveClass('line-clamp-4');
    expect(within(draft).queryByRole('button', { name: DRAFT_SHOW_ALL })).toBeNull();
  });
});

/** The draft the AI returns for the Check step, as the run and progress the server answers with. */
function draftLanded(steps: Parameters<typeof makeRun>[1] = {}): RunbookRunUpdate {
  return {
    run: makeRun({ revision: 8 }, {
      success: {
        ai_draft: { text: 'Two sign-ins succeeded for svc-backup.', created_at: '2026-10-28T14:40:00Z', model: 'demo', usage_id: 'u-9', confirmed: false },
        revision: 2,
      },
      ...steps,
    }),
    progress: { done: 2, not_applicable: 0, total: 6, required_open: 3, blocked: 0, waiting: 0 },
    revision: 9,
  };
}

/** Draft note answers only when `land` is called; the cost estimate answers at once. */
function deferDraft(): { land: (update: RunbookRunUpdate) => Promise<void> } {
  let resolve: (value: unknown) => void = () => undefined;
  api.draftRunbookStep.mockImplementation((_c: string, _r: string, _s: string, opts?: { dryRun?: boolean }) =>
    opts?.dryRun ? Promise.resolve({ update: null, estimate: null }) : new Promise((r) => (resolve = r)),
  );
  return {
    land: async (update) => {
      await act(async () => {
        resolve({ update, estimate: null });
      });
    },
  };
}

const NO_DRAFT = () => makeData([makeRun({}, { success: { ai_draft: null } })]);

describe('Next step card while a draft lands (the buttons keep their place)', () => {
  it('keeps an open Blocked dialog, what was typed and its focus when the draft lands', async () => {
    const user = userEvent.setup();
    const draft = deferDraft();
    render(<Harness initial={NO_DRAFT()} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    await user.click(within(card).getByRole('button', { name: 'Draft note' }));
    await user.click(within(card).getByRole('button', { name: 'Blocked' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why is this step blocked?' });
    const reason = within(dialog).getByRole('textbox');
    await user.type(reason, 'waiting for the network team');

    await draft.land(draftLanded());

    // The draft is on the card (hidden from the accessibility tree behind the modal), and
    // the dialog it did not interrupt is still there.
    expect(within(card).getByRole('region', { name: 'AI draft note', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Why is this step blocked?' })).toBe(dialog);
    expect(reason).toHaveValue('waiting for the network team');
    expect(document.activeElement).toBe(reason);
  });

  it('keeps the More menu open on a phone when the draft lands', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 356, height: 800, top: 0, left: 0, right: 356, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    const draft = deferDraft();
    render(<Harness initial={NO_DRAFT()} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    await user.click(within(card).getByRole('button', { name: 'Draft note' }));
    const more = within(card).getByRole('button', { name: 'More step actions' });
    act(() => more.focus());
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');

    await draft.land(draftLanded());

    // The card behind the open menu is hidden from the accessibility tree, not gone.
    expect(within(card).getByRole('button', { name: 'Confirm and mark done', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('menu')).toBe(menu);
    expect(within(card).getByRole('button', { name: 'More step actions', hidden: true })).toBe(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
  });

  it("keeps focus on a card button when a teammate's draft arrives live", async () => {
    const live: { current: ((update: RunbookRunUpdate) => void) | null } = { current: null };
    render(<Harness initial={NO_DRAFT()} live={live} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const blocked = within(card).getByRole('button', { name: 'Blocked' });
    act(() => blocked.focus());

    act(() => live.current?.(draftLanded()));

    expect(within(card).getByRole('region', { name: 'AI draft note' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Blocked' })).toBe(blocked);
    expect(document.activeElement).toBe(blocked);
  });

  it('moves focus from Draft note to the step heading when its draft lands, and says so', async () => {
    const user = userEvent.setup();
    api.draftRunbookStep.mockImplementation((_c: string, _r: string, _s: string, opts?: { dryRun?: boolean }) =>
      Promise.resolve(opts?.dryRun ? { update: null, estimate: null } : { update: draftLanded(), estimate: null }),
    );
    const { container } = render(<Harness initial={NO_DRAFT()} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    act(() => within(card).getByRole('button', { name: 'Draft note' }).focus());
    await user.keyboard('{Enter}');

    expect(await within(card).findByRole('region', { name: 'AI draft note' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Draft note' })).toBeNull();
    // The heading, as after Confirm: Enter again cannot confirm a draft nobody has read.
    expect(document.activeElement).toBe(within(card).getByRole('heading', { level: 3 }));
    await waitFor(() => expect(container.querySelector('[data-runbook-live]')).toHaveTextContent(DRAFT_READY_NOTE));
    // Tab goes on to Confirm, the first button under the question.
    await user.tab();
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Confirm and mark done' }));
  });

  it("moves focus from Draft note to the heading when a teammate's draft lands first", async () => {
    const live: { current: ((update: RunbookRunUpdate) => void) | null } = { current: null };
    render(<Harness initial={NO_DRAFT()} live={live} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    act(() => within(card).getByRole('button', { name: 'Draft note' }).focus());

    act(() => live.current?.(draftLanded()));

    expect(document.activeElement).toBe(within(card).getByRole('heading', { level: 3 }));
  });

  it('never takes focus the reader moved away before the draft landed', async () => {
    const user = userEvent.setup();
    const draft = deferDraft();
    render(<Harness initial={NO_DRAFT()} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    await user.click(within(card).getByRole('button', { name: 'Draft note' }));
    // The reader clicks away onto the page: focus leaves the card for the body.
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);

    await draft.land(draftLanded());

    expect(within(card).getByRole('region', { name: 'AI draft note' })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus from Draft note to Edit note in an opened step row when its draft lands', async () => {
    const user = userEvent.setup();
    // The card shows the triage step; the Check step below it is opened as a row.
    const open = { owner: { status: 'todo' as const, completed_at: null, completed_by: null } };
    api.draftRunbookStep.mockImplementation((_c: string, _r: string, _s: string, opts?: { dryRun?: boolean }) =>
      Promise.resolve(opts?.dryRun ? { update: null, estimate: null } : { update: draftLanded(open), estimate: null }),
    );
    render(<Harness initial={makeData([makeRun({}, { ...open, success: { ai_draft: null } })])} />);
    await user.click(screen.getByRole('tab', { name: /^Investigate/ }));
    const list = screen.getByRole('list', { name: 'Investigate steps' });
    await user.click(within(list).getByRole('button', { name: /Did any sign-in succeed after the failures\?/ }));
    act(() => within(list).getByRole('button', { name: 'Draft note' }).focus());
    await user.keyboard('{Enter}');

    const edit = await within(list).findByRole('button', { name: 'Edit note' });
    expect(within(list).queryByRole('button', { name: 'Draft note' })).toBeNull();
    expect(document.activeElement).toBe(edit);
  });
});

describe('Landing on the Next step card with a draft (Review draft, SPEC §4.10.11)', () => {
  const original = Element.prototype.scrollIntoView;
  let scrolled: Element[] = [];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it('brings the draft into view, then the heading, so the draft is not left below the fold', async () => {
    render(<Harness initial={makeData()} focusRequest={{ kind: 'step', stepId: 'success', tick: 1 }} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    const heading = within(card).getByRole('heading', { level: 3 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const draft = within(card).getByRole('region', { name: 'AI draft note' });
    expect(scrolled).toEqual([draft, heading]);
  });

  it('scrolls only the heading when the step has no draft, and only on the card', () => {
    render(<Harness initial={NO_DRAFT()} />);
    const heading = within(screen.getByRole('region', { name: 'Next step' })).getByRole('heading', { level: 3 });
    act(() => focusHeading(heading));
    expect(document.activeElement).toBe(heading);
    expect(scrolled).toEqual([heading]);
  });
});

describe('Runbook strip on a narrow pane (SPEC §4.10.11, one line)', () => {
  const LONG_TITLE = 'Phishing or reported suspicious email from a look-alike partner domain';

  function narrowPane() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 326, height: 800, top: 0, left: 0, right: 326, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
  }

  it('truncates only the title, so the pinned version is always readable', () => {
    narrowPane();
    const { container } = render(<Harness initial={makeData([makeRun({ title: LONG_TITLE, version: 4 })])} />);
    const heading = container.querySelector('[data-runbook-title]') as HTMLElement;
    expect(heading.closest('[data-runbook-strip]')).toHaveAttribute('data-narrow', 'true');
    expect(heading).toHaveTextContent(`${LONG_TITLE} · v4`);
    expect(screen.getByRole('heading', { level: 2, name: `${LONG_TITLE} · v4` })).toBe(heading);
    expect(heading).not.toHaveClass('truncate');

    const title = heading.querySelector('[data-runbook-title-text]') as HTMLElement;
    const version = heading.querySelector('[data-runbook-version]') as HTMLElement;
    expect(title).toHaveClass('truncate', 'min-w-0');
    expect(title).toHaveAttribute('title', LONG_TITLE);
    expect(title.contains(version)).toBe(false);
    expect(version).toHaveClass('shrink-0');
    expect(version).not.toHaveClass('truncate');
    expect(version.textContent).toBe(' · v4');
  });

  it("keeps a finished run's state beside the version without the time, which stays in its hover text", () => {
    narrowPane();
    const { container } = render(<Harness initial={makeData([completedRun({ title: LONG_TITLE })])} />);
    const heading = container.querySelector('[data-runbook-title]') as HTMLElement;
    const stateWords = heading.querySelector('[data-runbook-state]') as HTMLElement;
    expect(stateWords.textContent).toBe(' · Completed');
    expect(stateWords).toHaveClass('shrink-0');
    expect(stateWords.getAttribute('title')).toMatch(/^Completed · /);
    expect(heading).toHaveTextContent(`${LONG_TITLE} · v4 · Completed`);
    expect(container.textContent).not.toMatch(/—/);
  });
});
