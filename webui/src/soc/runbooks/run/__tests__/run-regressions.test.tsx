/**
 * The run inside a case, as the server really leaves it (Round 14, SPEC §4.10.11, §8.1):
 * a run completed in the same write that finished its last required step stays workable;
 * a note and the step change go in one write, in browsers that never focus a clicked
 * button too, and a refused press is never silent; leaving the note with the keyboard
 * keeps focus inside the step; Run again says the result was replaced, on the card too; a
 * recorded action waiting for approval moves focus on; a rejected action can be recorded again; a
 * Decision on the card can be marked Not applicable, Blocked or assigned; a stale save
 * keeps what was typed even when the card moves on; focus requests are handled once and
 * land where they say; the phone layout survives the panel moving from loading to the run;
 * runbooks turned off make the run read only; Approve is held back from a viewer without
 * the step's approval role; Demo cases render the same.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { CaseRunbooks, LookupResult, RunbookRun, RunbookRunUpdate } from '@/lib/types-runbooks';
import { TooltipProvider } from '@/ui/tooltip';
import {
  RunbookPanel,
  RUNBOOKS_OFF_RUN_NOTE,
  type RunbookFocusRequest,
  type RunbookPanelProps,
} from '@/soc/pages/casedetail/RunbookPanel';

import { BUSY_NOTE, CONFLICT_NOTE } from '../context';
import { LookupEvidence, isNumeric } from '../LookupEvidence';
import { ranAgainSentence } from '../StepRow';
import { mergeRun, type CaseRunbooksState } from '../useCaseRunbooks';
import { DEFINITION, LOOKUP_RESULT, STEPS, completedRun, makeData, makeRun } from './fixtures';

const CASE = { case_id: 'case-1', case_number: 'CASE-000214', title: 'Password spray', rule_ids: ['auth-failures'] } as unknown as Case;
const USERS = [
  { username: 'asha', display_name: 'Asha Rao' },
  { username: 'ben', display_name: 'Ben Ito' },
];

const PENDING_RESET = {
  status: 'in_progress' as const,
  action_record: { performed_by: 'asha', performed_at: '2026-10-28T14:31:00Z', where: 'IdP', outcome: 'Reset 3 accounts' },
  approval: { required_role: 'incident_lead', status: 'pending' as const, by: null, at: null, reason: null },
};

type HarnessProps = Partial<Omit<RunbookPanelProps, 'runbooks' | 'c'>> & {
  initial: CaseRunbooks | null;
  c?: Case;
  error?: unknown;
};

/** The panel over a local copy of the runs, merged with every write's answer. */
function Harness({ initial, c = CASE, error = null, ...props }: HarnessProps) {
  const [data, setData] = React.useState<CaseRunbooks | null>(initial);
  React.useEffect(() => setData(initial), [initial]);
  const runbooks: CaseRunbooksState = {
    data,
    loading: false,
    error,
    refresh: async () => undefined,
    applyUpdate: (update: RunbookRunUpdate) =>
      setData((prev) => (prev ? mergeRun(prev, update.run, update.progress, update.revision) : prev)),
    applyAttach: () => undefined,
    live: false,
  };
  return (
    <TooltipProvider>
      <RunbookPanel
        c={c}
        runbooks={runbooks}
        canRun
        canWriteTasks
        hasPermission={() => true}
        currentUser="ben"
        users={USERS}
        {...props}
      />
    </TooltipProvider>
  );
}

function update(run: RunbookRun, required_open: number): RunbookRunUpdate {
  return { run, progress: { done: 0, not_applicable: 0, total: 6, required_open, blocked: 0, waiting: 0 }, revision: run.revision };
}

/** A run whose only required step left is the Action step (step 5). */
function actionNext(steps: Parameters<typeof makeRun>[1] = {}): RunbookRun {
  return makeRun({}, {
    success: { status: 'done', ai_draft: null },
    confirmed: { status: 'done', decision: { option_id: 'compromise', label: 'Compromise', by: 'ben', at: '2026-10-28T14:50:00Z' } },
    ...steps,
  });
}

function card() {
  return screen.getByRole('region', { name: 'Next step' });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.draftRunbookStep.mockResolvedValue({ update: null, estimate: null });
  api.getRunbookCandidates.mockResolvedValue({ candidates: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a completed run stays workable', () => {
  it('says all required steps are done, offers Close case, lists the optional step and keeps Reopen step', async () => {
    const user = userEvent.setup();
    const onCloseCase = vi.fn();
    api.updateRunbookStep.mockResolvedValue(update(completedRun(), 0));
    render(<Harness initial={makeData([actionNext()])} onCloseCase={onCloseCase} />);

    await user.type(within(card()).getByLabelText('Where (system or ticket)'), 'IdP');
    await user.type(within(card()).getByLabelText('Outcome'), 'Reset 3 accounts');
    await user.click(within(card()).getByRole('button', { name: 'Record action' }));

    // The server answered with the run completed: the card stays, with focus on its heading.
    const heading = await within(card()).findByRole('heading', { level: 3, name: 'All required steps are done.' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.click(within(card()).getByRole('button', { name: 'Close case' }));
    expect(onCloseCase).toHaveBeenCalledOnce();
    expect(within(card()).getByText('Optional steps left')).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: /Record the containment/ })).toBeInTheDocument();

    // A finished step can still be reopened (the server reopens the run), from its mark or its row.
    await user.click(screen.getByRole('tab', { name: /^Triage/ }));
    expect(screen.getByRole('button', { name: 'Reopen step 2' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Is the source a known scanner\?/ }));
    expect(await screen.findByRole('button', { name: 'Reopen step' })).toBeInTheDocument();
  });

  it('lets the optional step left on a completed run be worked', async () => {
    const user = userEvent.setup();
    render(<Harness initial={makeData([completedRun()])} />);
    await user.click(within(card()).getByRole('button', { name: /Record the containment/ }));
    const row = await screen.findByRole('button', { name: /Record the containment/, expanded: true });
    const detail = document.getElementById(row.getAttribute('aria-controls') as string) as HTMLElement;
    expect(within(detail).getByLabelText('Where (system or ticket)')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Record action' })).toBeInTheDocument();
  });

  it('shows no card and no step buttons on an abandoned run, and lands Open runbook on its title', async () => {
    const onHandled = vi.fn();
    const run = makeRun({ status: 'abandoned', abandoned_reason: 'Wrong runbook' });
    render(<Harness initial={makeData([run])} focusRequest={{ kind: 'card', tick: 4 }} onFocusRequestHandled={onHandled} />);
    expect(screen.queryByRole('region', { name: 'Next step' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark done|Record action|Reopen step/ })).toBeNull();
    const title = screen.getByRole('heading', { level: 2, name: 'Brute force and password spray' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(onHandled).toHaveBeenCalledWith(4);
  });
});

describe('one write for the note and the step change', () => {
  it('sends the typed note with Mark done when the note field is left for Mark done', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const box = within(card()).getByRole('textbox', { name: /note/i });
    await user.type(box, 'Destination is the sanctioned backup bucket.');
    // The press keeps focus in the note field, so no separate save starts on the way.
    await user.click(within(card()).getByRole('button', { name: 'Mark done' }));
    expect(document.activeElement).toBe(box);
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', {
      note: 'Destination is the sanctioned backup bucket.',
      status: 'done',
      expected_revision: 1,
    });
    await act(async () => answer(update(makeRun({ revision: 8 }, { success: { status: 'done', ai_draft: null, revision: 2 } }), 2)));
  });

  it('still saves the note on its own when the field is left for anything else', async () => {
    const user = userEvent.setup();
    api.updateRunbookStep.mockResolvedValue(update(makeRun({ revision: 8 }, { success: { ai_draft: null, note: 'Kept.', revision: 2 } }), 3));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    await user.type(within(card()).getByRole('textbox', { name: /note/i }), 'Kept.');
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', { note: 'Kept.', expected_revision: 1 });
  });

  it('carries a note that is still unsaved with Not applicable', async () => {
    const user = userEvent.setup();
    // The save on the way out of the field fails, so the note is still unsaved...
    api.updateRunbookStep.mockRejectedValueOnce(new ApiError(500, 'The step could not be saved.', null));
    api.updateRunbookStep.mockResolvedValue(update(makeRun({ revision: 8 }), 3));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    await user.type(within(card()).getByRole('textbox', { name: /note/i }), 'Only one account.');
    await user.click(within(card()).getByRole('button', { name: 'Not applicable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why is this step not applicable?' });
    await user.type(within(dialog).getByRole('textbox'), 'The account has no MFA.');
    await user.click(within(dialog).getByRole('button', { name: 'Mark not applicable' }));
    // ...and goes with the status change, never lost.
    await waitFor(() =>
      expect(api.updateRunbookStep).toHaveBeenLastCalledWith('case-1', 'run-1', 'success', {
        status: 'not_applicable',
        reason: 'The account has no MFA.',
        note: 'Only one account.',
        expected_revision: 1,
      }),
    );
  });
});

/**
 * A mouse press as Safari and Firefox on macOS make it: a clicked button never takes
 * focus, so unless mousedown is prevented, focus leaves the field for nothing first.
 * Returns whether mousedown was prevented.
 */
function pressWithoutFocus(button: HTMLElement): boolean {
  const proceed = fireEvent.mouseDown(button);
  const active = document.activeElement;
  if (proceed && active instanceof HTMLElement && active !== document.body) act(() => active.blur());
  fireEvent.mouseUp(button);
  fireEvent.click(button);
  return !proceed;
}

/** The opened detail of a step row, by its title. */
async function openRow(title: RegExp) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: title }));
  const row = await screen.findByRole('button', { name: title, expanded: true });
  return document.getElementById(row.getAttribute('aria-controls') as string) as HTMLElement;
}

describe('a note and the press that carries it, in browsers that never focus a clicked button', () => {
  it('sends the typed note with Mark done in one write and keeps focus in the note', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const box = within(card()).getByRole('textbox', { name: /note/i });
    await user.type(box, 'Destination is the sanctioned backup bucket.');

    expect(pressWithoutFocus(within(card()).getByRole('button', { name: 'Mark done' }))).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', {
      note: 'Destination is the sanctioned backup bucket.',
      status: 'done',
      expected_revision: 1,
    });
    expect(screen.queryByText(BUSY_NOTE)).toBeNull();

    // The answer moves focus to the new Next step heading.
    await act(async () => answer(update(makeRun({ revision: 8 }, { success: { status: 'done', ai_draft: null, revision: 2 } }), 2)));
    const heading = await within(card()).findByRole('heading', { level: 3, name: 'Is this a confirmed compromise?' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
  });

  it('sends the typed note with Record decision in one write, from a step row', async () => {
    const user = userEvent.setup();
    api.updateRunbookStep.mockReturnValue(new Promise(() => undefined));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const detail = await openRow(/Is this a confirmed compromise\?/);
    await user.click(within(detail).getByRole('radio', { name: /Compromise/ }));
    const box = within(detail).getByRole('textbox', { name: /note/i });
    await user.type(box, 'Same source as CASE-000198.');

    expect(pressWithoutFocus(within(detail).getByRole('button', { name: 'Record decision' }))).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'confirmed', {
      note: 'Same source as CASE-000198.',
      decision: { option_id: 'compromise' },
      expected_revision: 1,
    });
  });

  it('saves the note on its own when focus leaves for a press that cannot act yet', async () => {
    const user = userEvent.setup();
    api.updateRunbookStep.mockResolvedValue(update(makeRun({ revision: 8 }, { notes: { note: 'Ticket pending.', revision: 2 } }), 3));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    const detail = await openRow(/Record the containment/);
    await user.type(within(detail).getByRole('textbox', { name: /note/i }), 'Ticket pending.');
    // Record action says where and what first: it is an ordinary button until then.
    const record = within(detail).getByRole('button', { name: 'Record action' });
    expect(record).toHaveAttribute('aria-disabled', 'true');
    expect(record).not.toHaveAttribute('data-carries-note');
    await user.click(record);
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'notes', { note: 'Ticket pending.', expected_revision: 1 });
  });

  it("keeps another step's note in its field and saves it once focus leaves it", async () => {
    const user = userEvent.setup();
    let answerNote: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockResolvedValueOnce(
      update(makeRun({ revision: 8 }, { success: { status: 'done', ai_draft: null, note: 'Saved earlier.', revision: 2 } }), 2),
    );
    api.updateRunbookStep.mockReturnValueOnce(new Promise((resolve) => (answerNote = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null, note: 'Saved earlier.' } })])} />);
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    const detail = await openRow(/Record the containment/);
    await user.type(within(detail).getByRole('textbox', { name: /note/i }), 'Ticket pending.');

    // The card's Mark done (step 3) keeps focus in this note, does not carry it, and is
    // not refused by a save of it.
    await user.click(within(card()).getByRole('button', { name: 'Mark done' }));
    expect(api.updateRunbookStep).toHaveBeenNthCalledWith(1, 'case-1', 'run-1', 'success', { status: 'done', expected_revision: 1 });

    // Focus moves to the new Next step, out of the other note, which is saved then.
    const heading = await within(card()).findByRole('heading', { level: 3, name: 'Is this a confirmed compromise?' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() => expect(api.updateRunbookStep).toHaveBeenCalledTimes(2));
    expect(api.updateRunbookStep).toHaveBeenNthCalledWith(2, 'case-1', 'run-1', 'notes', { note: 'Ticket pending.', expected_revision: 1 });
    await waitFor(() => expect(document.querySelector('[data-runbook-live]')?.textContent).toMatch(/^Step 3 done\./));
    await act(async () => {
      answerNote(
        update(
          makeRun({ revision: 9 }, {
            success: { status: 'done', ai_draft: null, note: 'Saved earlier.', revision: 2 },
            notes: { note: 'Ticket pending.', revision: 2 },
          }),
          2,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(BUSY_NOTE)).toBeNull();
  });

  it('says so next to the step when a press is refused because a save is still in flight', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const box = within(card()).getByRole('textbox', { name: /note/i });
    await user.type(box, 'Only one account.');
    // Focus left the field for something that does not carry the note: it saves on its own.
    act(() => box.blur());
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', { note: 'Only one account.', expected_revision: 1 });

    // Not applicable only opens its dialog; its write is refused while the save runs.
    await user.click(within(card()).getByRole('button', { name: 'Not applicable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why is this step not applicable?' });
    await user.type(within(dialog).getByRole('textbox'), 'The account has no MFA.');
    await user.click(within(dialog).getByRole('button', { name: 'Mark not applicable' }));
    expect(await within(dialog).findByText(BUSY_NOTE)).toBeInTheDocument();
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');

    // The refusal stays next to the step after the save answers, until the next write.
    await act(async () => answer(update(makeRun({ revision: 8 }, { success: { ai_draft: null, note: 'Only one account.', revision: 2 } }), 3)));
    expect(within(card()).getByText(BUSY_NOTE)).toHaveAttribute('role', 'alert');
    api.updateRunbookStep.mockResolvedValue(update(makeRun({ revision: 9 }, { success: { status: 'done', ai_draft: null, note: 'Only one account.', revision: 3 } }), 2));
    await user.click(within(card()).getByRole('button', { name: 'Mark done' }));
    expect(api.updateRunbookStep).toHaveBeenLastCalledWith('case-1', 'run-1', 'success', { status: 'done', expected_revision: 2 });
    await waitFor(() => expect(screen.queryByText(BUSY_NOTE)).toBeNull());
  });
});

describe('a note while other writes run', () => {
  it('keeps focus in the note on Run again, and saves the note once the lookup is done', async () => {
    const user = userEvent.setup();
    let answerLookup: (value: RunbookRunUpdate) => void = () => undefined;
    const scopeTodo = { status: 'todo' as const, completed_at: null, completed_by: null };
    api.runRunbookLookup.mockReturnValue(new Promise((resolve) => (answerLookup = resolve)));
    api.updateRunbookStep.mockReturnValue(new Promise(() => undefined));
    render(<Harness initial={makeData([makeRun({}, { scope: scopeTodo, success: { ai_draft: null } })])} />);
    await user.click(screen.getByRole('tab', { name: /^Investigate/ }));
    const detail = await openRow(/Did any sign-in succeed after the failures\?/);
    const box = within(detail).getByRole('textbox', { name: /note/i });
    await user.type(box, 'Two successes for svc-backup.');

    await user.click(within(card()).getByRole('button', { name: 'Run again' }));
    expect(api.runRunbookLookup).toHaveBeenCalledWith('case-1', 'run-1', 'scope');
    // The note keeps focus and stays editable while the lookup runs.
    expect(document.activeElement).toBe(box);
    expect(box).toBeEnabled();
    await user.type(box, ' Both from 203.0.113.7.');

    // Leaving it while the lookup runs saves nothing yet, and refuses nothing.
    act(() => box.blur());
    expect(api.updateRunbookStep).not.toHaveBeenCalled();
    await act(async () => {
      answerLookup(update(makeRun({ revision: 8 }, { scope: { ...scopeTodo, revision: 2 }, success: { ai_draft: null } }), 4));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', {
      note: 'Two successes for svc-backup. Both from 203.0.113.7.',
      expected_revision: 1,
    });
    expect(screen.queryByText(BUSY_NOTE)).toBeNull();
  });

  it('keeps what was typed after a save left, unsaved, when the save answers', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const box = within(card()).getByRole('textbox', { name: /note/i });
    await user.type(box, 'Kept.');
    await user.tab();
    await user.keyboard('{Enter}');
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', { note: 'Kept.', expected_revision: 1 });
    await user.click(box);
    await user.type(box, ' And more.');
    await act(async () => answer(update(makeRun({ revision: 8 }, { success: { ai_draft: null, note: 'Kept.', revision: 2 } }), 3)));
    expect(box).toHaveValue('Kept. And more.');
    expect(within(card()).getByText('Not saved yet. It is saved when you leave the field.')).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Save note' })).toBeInTheDocument();
  });
});

describe('leaving the note with the keyboard', () => {
  it('stops on Save note without saving, and keeps focus there once Enter saved it', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    await user.type(within(card()).getByRole('textbox', { name: /note/i }), 'Kept.');
    await user.tab();
    const save = within(card()).getByRole('button', { name: 'Save note' });
    expect(document.activeElement).toBe(save);
    expect(api.updateRunbookStep).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', { note: 'Kept.', expected_revision: 1 });
    await act(async () => answer(update(makeRun({ revision: 8 }, { success: { ai_draft: null, note: 'Kept.', revision: 2 } }), 3)));
    // Saved: the button stays under focus and says so, never dropping focus to the page.
    const saved = within(card()).getByRole('button', { name: 'Saved' });
    expect(document.activeElement).toBe(saved);
    expect(saved).toHaveAttribute('aria-disabled', 'true');
    await user.tab();
    expect(within(card()).queryByRole('button', { name: /^Save/ })).toBeNull();
    expect(card().contains(document.activeElement)).toBe(true);
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
  });

  it('saves the note once when Tab goes on past Mark done, and focus stays inside the step', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.updateRunbookStep.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    await user.type(within(card()).getByRole('textbox', { name: /note/i }), 'Kept.');
    await user.tab(); // Save note
    await user.tab(); // Mark done: its own write would carry the note, so nothing saves yet
    expect(document.activeElement).toBe(within(card()).getByRole('button', { name: 'Mark done' }));
    expect(api.updateRunbookStep).not.toHaveBeenCalled();
    await user.tab(); // Draft note: the note is saved on the way
    const next = within(card()).getByRole('button', { name: 'Draft note' });
    expect(document.activeElement).toBe(next);
    expect(api.updateRunbookStep).toHaveBeenCalledTimes(1);
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'success', { note: 'Kept.', expected_revision: 1 });
    await act(async () => answer(update(makeRun({ revision: 8 }, { success: { ai_draft: null, note: 'Kept.', revision: 2 } }), 3)));
    expect(document.activeElement).toBe(next);
  });
});

describe('the Next step card, finishing work', () => {
  it('says the earlier lookup result was replaced after Run again, next to the result and aloud', async () => {
    const user = userEvent.setup();
    const fresh: LookupResult = { ...LOOKUP_RESULT, ran_at: '2026-10-28T14:31:00Z', ran_by: 'ben', count: 418 };
    const scopeTodo = { status: 'todo' as const, completed_at: null, completed_by: null };
    api.runRunbookLookup.mockResolvedValue(
      update(makeRun({ revision: 8 }, { scope: { ...scopeTodo, evidence: [{ kind: 'lookup_result', lookup: fresh, url: null, label: null }], revision: 2 } }), 4),
    );
    render(<Harness initial={makeData([makeRun({}, { scope: scopeTodo })])} />);
    expect(within(card()).getByRole('heading', { level: 3, name: 'How many sign-ins failed from this source?' })).toBeInTheDocument();
    await user.click(within(card()).getByRole('button', { name: 'Run again' }));
    expect(api.runRunbookLookup).toHaveBeenCalledWith('case-1', 'run-1', 'scope');
    expect(await within(card()).findByText(/^Ran again at .*14:31 UTC; the earlier result was replaced\.$/)).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('[data-runbook-live]')?.textContent).toMatch(/^Ran again at .*14:31 UTC; the earlier result was replaced\.$/),
    );
  });

  it('moves focus on and says so when a recorded action now waits for approval', async () => {
    const user = userEvent.setup();
    api.updateRunbookStep.mockResolvedValue(update(actionNext({ reset: { ...PENDING_RESET, action_record: { ...PENDING_RESET.action_record, performed_by: 'ben' } } }), 1));
    render(<Harness initial={makeData([actionNext()])} />);
    await user.type(within(card()).getByLabelText('Where (system or ticket)'), 'IdP');
    await user.type(within(card()).getByLabelText('Outcome'), 'Reset 3 accounts');
    await user.click(within(card()).getByRole('button', { name: 'Record action' }));
    const heading = await within(card()).findByRole('heading', { level: 3, name: 'The remaining required steps wait for approval.' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() => expect(document.querySelector('[data-runbook-live]')?.textContent).toBe('Step 5 recorded.'));
  });
});

describe('the Next step card', () => {
  it('shows a rejected action with its reason and lets it be recorded again', async () => {
    const user = userEvent.setup();
    const rejected = actionNext({
      reset: {
        status: 'in_progress',
        action_record: { performed_by: 'ben', performed_at: '2026-10-28T14:31:00Z', where: 'IdP', outcome: 'Reset' },
        approval: { required_role: 'incident_lead', status: 'rejected', by: 'asha', at: '2026-10-28T14:40:00Z', reason: 'Wrong ticket' },
      },
    });
    api.updateRunbookStep.mockResolvedValue(update(completedRun(), 0));
    render(<Harness initial={makeData([rejected])} />);
    expect(within(card()).getByRole('heading', { level: 3, name: 'Reset the affected accounts' })).toBeInTheDocument();
    expect(card()).toHaveTextContent(/Rejected by Asha Rao at .*14:40 UTC: Wrong ticket/);
    await user.type(within(card()).getByLabelText('Where (system or ticket)'), 'IdP, CHG-4830');
    await user.type(within(card()).getByLabelText('Outcome'), 'Reset 3 accounts again');
    await user.click(within(card()).getByRole('button', { name: 'Record action' }));
    expect(api.updateRunbookStep).toHaveBeenCalledWith('case-1', 'run-1', 'reset', {
      action_record: { where: 'IdP, CHG-4830', outcome: 'Reset 3 accounts again' },
      expected_revision: 1,
    });
  });

  it('offers Not applicable, Blocked and Assign for a Decision', () => {
    render(<Harness initial={makeData([makeRun({}, { success: { status: 'done', ai_draft: null } })])} />);
    expect(within(card()).getByRole('heading', { level: 3, name: 'Is this a confirmed compromise?' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Record decision' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Not applicable' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Blocked' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Assign' })).toBeInTheDocument();
  });

  it('keeps what was typed when someone else finished the step, in the step row with the note', async () => {
    const user = userEvent.setup();
    const latest = makeRun({ revision: 8 }, {
      success: { status: 'done', ai_draft: null, completed_by: 'asha', completed_at: '2026-10-28T14:44:00Z', revision: 2 },
    });
    api.updateRunbookStep.mockRejectedValue(
      new ApiError(409, 'This step changed.', {
        detail: { code: 'runbook_conflict', message: 'This step changed.', latest: update(latest, 2) },
      }),
    );
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    await user.type(within(card()).getByRole('textbox', { name: /note/i }), 'svc-backup signed in at 13:02.');
    await user.click(within(card()).getByRole('button', { name: 'Mark done' }));

    // The card moved on to the next step; the stale step's row opens with the text kept.
    expect(await within(card()).findByRole('heading', { level: 3, name: 'Is this a confirmed compromise?' })).toBeInTheDocument();
    const row = await screen.findByRole('button', { name: /Did any sign-in succeed after the failures\?/, expanded: true });
    const detail = document.getElementById(row.getAttribute('aria-controls') as string) as HTMLElement;
    expect(within(detail).getByRole('textbox', { name: /note/i })).toHaveValue('svc-backup signed in at 13:02.');
    expect(within(detail).getByText(CONFLICT_NOTE)).toBeInTheDocument();
  });

  it('folds Not applicable, Blocked and Assign into More on a phone, and Esc returns to More', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 356, height: 800, top: 0, left: 0, right: 356, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const more = within(card()).getByRole('button', { name: 'More step actions' });
    expect(within(card()).queryByRole('button', { name: 'Assign' })).toBeNull();
    act(() => more.focus());
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Assign/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Not applicable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why is this step not applicable?' });
    expect(dialog).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});

describe('focus requests', () => {
  it('opens on the phase a request names, even on the first render', async () => {
    const onHandled = vi.fn();
    render(<Harness initial={makeData()} focusRequest={{ kind: 'phase', phase: 'contain', tick: 2 }} onFocusRequestHandled={onHandled} />);
    const contain = screen.getByRole('tab', { name: /^Contain/ });
    expect(contain).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.activeElement).toBe(contain));
    expect(onHandled).toHaveBeenCalledWith(2);
  });

  it('opens Start runbook once and never again after the tab comes back', async () => {
    const user = userEvent.setup();
    function Host() {
      const [request, setRequest] = React.useState<RunbookFocusRequest | null>({ kind: 'start', tick: 1 });
      const [shown, setShown] = React.useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown((v) => !v)}>
            Toggle tab
          </button>
          {shown ? (
            <Harness
              initial={makeData([])}
              focusRequest={request}
              onFocusRequestHandled={(tick) => setRequest((r) => (r?.tick === tick ? null : r))}
            />
          ) : null}
        </>
      );
    }
    render(<Host />);
    expect(await screen.findByTestId('start-runbook-dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('start-runbook-dialog')).toBeNull());
    // Leave the tab and come back: the handled request is gone, so nothing reopens.
    await user.click(screen.getByRole('button', { name: 'Toggle tab' }));
    await user.click(screen.getByRole('button', { name: 'Toggle tab' }));
    await act(async () => undefined);
    expect(screen.queryByTestId('start-runbook-dialog')).toBeNull();
  });

  it('lands on the Other tasks heading', async () => {
    const onHandled = vi.fn();
    render(<Harness initial={makeData()} focusRequest={{ kind: 'tasks', tick: 3 }} onFocusRequestHandled={onHandled} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'Other tasks' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(onHandled).toHaveBeenCalledWith(3);
  });
});

describe('layout and versions', () => {
  it('stays narrow after the panel moves from loading to the run', async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: ResizeObserverCallback) {}
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 356, height: 800, top: 0, left: 0, right: 356, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    const { rerender, container } = render(<Harness initial={null} />);
    expect(screen.getByLabelText('Loading the runbook')).toBeInTheDocument();
    const root = container.querySelector('[data-case-panel="runbook"]');
    rerender(<Harness initial={makeData()} />);
    // The same root element is measured through every state.
    expect(container.querySelector('[data-case-panel="runbook"]')).toBe(root);
    expect(observed.every((el) => el === root)).toBe(true);
    const strip = container.querySelector('[data-runbook-strip]');
    expect(strip).toHaveAttribute('data-narrow', 'true');
    // The short progress line under the one-line strip.
    expect(container.textContent).toContain('2 of 6 done');
  });

  it('falls back to the Next step phase when a new version drops the chosen phase', async () => {
    const user = userEvent.setup();
    const narrowed = { ...DEFINITION, phases: DEFINITION.phases.filter((p) => p !== 'contain'), steps: STEPS.filter((s) => s.phase !== 'contain') };
    const switched = makeRun({ version: 5, snapshot: narrowed, revision: 8 });
    api.switchRunbookRunVersion.mockResolvedValue(update(switched, 2));
    render(<Harness initial={makeData([makeRun()], { newer_versions: { 'run-1': 5 } })} />);
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Switch to version 5' }));
    await user.click(await screen.findByRole('button', { name: 'Switch to version 5' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: /^Contain/ })).toBeNull());
    expect(screen.getByRole('tab', { name: /^Investigate/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('list', { name: 'Investigate steps' })).toBeInTheDocument();
  });

  it('gives focus back to Runbook actions when Switch version is cancelled with Esc', async () => {
    const user = userEvent.setup();
    render(<Harness initial={makeData([makeRun()], { newer_versions: { 'run-1': 5 } })} />);
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Switch to version 5' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(actions));
  });

  it('says why Add runbook cannot add at the run limit, in text a keyboard user reaches', () => {
    const runs = [0, 1, 2, 3, 4].map((i) => makeRun({ run_id: `run-${i}`, runbook_id: `rb-${i}`, status: i === 0 ? 'active' : 'completed' }));
    render(<Harness initial={makeData(runs)} />);
    const add = screen.getByRole('button', { name: 'Add runbook' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add).toHaveAccessibleDescription('A case holds at most 5 runbooks.');
    expect(add).not.toHaveAttribute('title');
  });
});

describe('permissions and settings', () => {
  it('is read only with its own line while runbooks are turned off in Settings', () => {
    render(<Harness initial={makeData()} enabled={false} />);
    expect(screen.getByText(RUNBOOKS_OFF_RUN_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm and mark done' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark step \d+ done|Reopen step/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add runbook' })).toBeNull();
  });

  it("holds Approve back from a viewer without the step's approval role", async () => {
    const user = userEvent.setup();
    const loadCustomRoles = vi.fn().mockResolvedValue([]);
    const run = makeRun({}, { reset: PENDING_RESET });
    render(<Harness initial={makeData([run])} viewer={{ role: 'analyst_tier1', unrestricted: false }} loadCustomRoles={loadCustomRoles} />);
    await waitFor(() => expect(loadCustomRoles).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    await user.click(within(screen.getByRole('list', { name: 'Contain steps' })).getByRole('button', { name: /Reset the affected accounts/ }));
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByText('Only an incident lead can approve this step.')).toBeInTheDocument();
    await user.click(approve);
    expect(api.decideRunbookApproval).not.toHaveBeenCalled();
  });

  it('offers Approve to a viewer whose custom role is the approval role', async () => {
    const user = userEvent.setup();
    const run = makeRun({}, { reset: PENDING_RESET });
    render(
      <Harness
        initial={makeData([run])}
        viewer={{ role: 'analyst_tier1', unrestricted: false }}
        loadCustomRoles={vi.fn().mockResolvedValue(['Incident lead'])}
      />,
    );
    await user.click(screen.getByRole('tab', { name: /^Contain/ }));
    await user.click(within(screen.getByRole('list', { name: 'Contain steps' })).getByRole('button', { name: /Reset the affected accounts/ }));
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).not.toHaveAttribute('aria-disabled'));
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('reads no roles when no approval is waiting', () => {
    const loadCustomRoles = vi.fn().mockResolvedValue([]);
    render(<Harness initial={makeData()} viewer={{ role: 'analyst_tier1', unrestricted: false }} loadCustomRoles={loadCustomRoles} />);
    expect(loadCustomRoles).not.toHaveBeenCalled();
  });
});

describe('Demo Mode', () => {
  it('renders a Demo case the same, from its runs alone, with no extra reads', () => {
    const demoCase = { case_id: 'demo-00000539-0005', case_number: 'CASE-000046', title: 'Impossible travel', rule_ids: [] } as unknown as Case;
    const run = makeRun({ case_id: 'demo-00000539-0005', attached_actor: 'runbook_selector' });
    const { container } = render(<Harness c={demoCase} initial={makeData([run])} />);
    expect(screen.getByRole('region', { name: 'Next step' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/—|playbook/i);
  });
});

describe('lookup evidence', () => {
  it('right-aligns only columns of numbers and keeps addresses as identifiers', () => {
    const result: LookupResult = {
      ...LOOKUP_RESULT,
      facts: [
        { label: 'Events', value: '1,204' },
        { label: 'Not recorded', value: 'action on Splunk Enterprise Security (HEC); outcome unknown' },
      ],
      table: { columns: ['source.ip', 'count'], rows: [['203.0.113.7', '120'], ['10.0.0.12', '44']] },
    };
    render(
      <div className="@container/run">
        <LookupEvidence step={STEPS[0]} result={result} canRunLookup canSeeTool runWorkable busy={false} onRun={vi.fn()} />
      </div>,
    );
    const headers = screen.getAllByRole('columnheader');
    expect(headers[0].className).not.toContain('text-right');
    expect(headers[1].className).toContain('text-right');
    const ip = screen.getByText('203.0.113.7');
    expect(ip.className).toContain('font-mono');
    expect(ip.className).not.toContain('text-right');
    expect(screen.getByText('120').className).toContain('text-right');
    // A number reads as a figure; a sentence reads as text across the row.
    expect(screen.getByText('1,204').className).toContain('font-semibold');
    const sentence = screen.getByText('action on Splunk Enterprise Security (HEC); outcome unknown');
    expect(sentence.className).not.toContain('font-semibold');
    expect(sentence.parentElement?.className).toContain('col-span-full');
  });

  it('tells numbers from identifiers', () => {
    for (const value of ['412', '1,204', '≥ 37', '-3.5', '12%', '0.75']) expect(isNumeric(value)).toBe(true);
    for (const value of ['203.0.113.7', '1.2.3', 'v4', '', '10.0.0.0/8', 'abc']) expect(isNumeric(value)).toBe(false);
  });

  it('says when a lookup ran again', () => {
    expect(ranAgainSentence('2026-10-28T14:31:00Z', new Date('2026-10-28T15:00:00Z'))).toBe(
      'Ran again at 14:31 UTC; the earlier result was replaced.',
    );
  });

  it('collapses what a pending lookup looks up on a narrow pane', async () => {
    const user = userEvent.setup();
    render(<LookupEvidence step={STEPS[0]} result={null} canRunLookup canSeeTool runWorkable busy={false} compact onRun={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'What it looks up' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('list', { name: 'What it looks up', hidden: true })).not.toBeVisible();
    await user.click(toggle);
    expect(screen.getByRole('list', { name: 'What it looks up' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run lookup' })).toBeInTheDocument();
  });
});
