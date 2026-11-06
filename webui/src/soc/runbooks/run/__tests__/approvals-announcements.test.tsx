/**
 * The run inside a case, second acceptance pass (Round 14, SPEC §3.3, §4.10.11; wrb-06,
 * wrb-07, wrb-09, wrb-10): an approval names its role by the label a person knows it by
 * ("a SOC manager", never "a soc manager"), from the server's `role_labels` with the
 * Console's own labels for an older server; Approve, which goes with the decision, leaves
 * focus on the step's new state and says so once; a version switch and a stale save are
 * each announced once; a reason dialog opened from a menu opens without an error, keeps
 * focus in its field, and says "Give a reason." only after an empty submit; Start a runbook
 * opened from the narrow strip's menu keeps focus in its search field and gives it back to
 * the menu button. A role the answer has no label for reads as the server words it.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import type { Case } from '@/lib/types';
import type { CaseRunbooks, RunbookRun, RunbookRunUpdate } from '@/lib/types-runbooks';
import { TooltipProvider } from '@/ui/tooltip';
import { RunbookPanel, switchedSentence, type RunbookPanelProps } from '@/soc/pages/casedetail/RunbookPanel';

import { CONFLICT_NOTE } from '../context';
import { EMPTY_REASON_ERROR, ReasonDialog } from '../ReasonDialog';
import { holdsApprovalRole, roleKey } from '../model';
import { indefiniteArticle, roleLabelsFrom, roleWords, runRoleLabel } from '../roles';
import { ActionRecordForm, ActionRecordView } from '../StepParts';
import { mergeRun, type CaseRunbooksState } from '../useCaseRunbooks';
import { DEFINITION, STEPS, makeData, makeRun, state } from './fixtures';

const CASE = { case_id: 'case-1', case_number: 'CASE-000214', title: 'Password spray', rule_ids: ['auth-failures'] } as unknown as Case;
const USERS = [
  { username: 'asha', display_name: 'Asha Rao' },
  { username: 'ben', display_name: 'Ben Ito' },
];

/** The fixture runbook with its Action step approved by a SOC manager. */
const SOC_STEPS = STEPS.map((s) => (s.id === 'reset' ? { ...s, approval_role: 'soc_manager' } : s));
const SOC_DEFINITION = { ...DEFINITION, steps: SOC_STEPS };

const PENDING = {
  status: 'in_progress' as const,
  action_record: { performed_by: 'asha', performed_at: '2026-10-28T14:31:00Z', where: 'IdP', outcome: 'Reset 3 accounts' },
  approval: { required_role: 'soc_manager', status: 'pending' as const, by: null, at: null, reason: null },
};

/** A run whose Action step (step 5) waits for a SOC manager's approval. */
function pendingRun(overrides: Partial<RunbookRun> = {}): RunbookRun {
  return makeRun({ snapshot: SOC_DEFINITION, ...overrides }, { reset: PENDING });
}

/** The same run once Ben approved the action (the step is done). */
function approvedRun(): RunbookRun {
  return makeRun({ snapshot: SOC_DEFINITION, revision: 8 }, {
    reset: {
      ...PENDING,
      status: 'done',
      approval: { required_role: 'soc_manager', status: 'approved', by: 'ben', at: '2026-10-28T14:52:00Z', reason: null },
      completed_by: 'ben',
      completed_at: '2026-10-28T14:52:00Z',
      revision: 2,
    },
  });
}

function update(run: RunbookRun, required_open: number, extra: Record<string, unknown> = {}): RunbookRunUpdate {
  return {
    run,
    progress: { done: 3, not_applicable: 0, total: 6, required_open, blocked: 0, waiting: 0 },
    revision: run.revision,
    ...extra,
  } as RunbookRunUpdate;
}

/** `role_labels` as the server sends them. */
function withLabels(data: CaseRunbooks, labels: Record<string, string>): CaseRunbooks {
  return { ...data, role_labels: labels };
}

type HarnessProps = Partial<Omit<RunbookPanelProps, 'runbooks' | 'c'>> & { initial: CaseRunbooks | null };

/** The panel over a local copy of the runs, merged with every write's answer as `useCaseRunbooks` does. */
function Harness({ initial, ...props }: HarnessProps) {
  const [data, setData] = React.useState<CaseRunbooks | null>(initial);
  React.useEffect(() => setData(initial), [initial]);
  const runbooks: CaseRunbooksState = {
    data,
    loading: false,
    error: null,
    refresh: async () => undefined,
    applyUpdate: (u: RunbookRunUpdate) =>
      setData((prev) => (prev ? mergeRun(prev, u.run, u.progress, u.revision, roleLabelsFrom(u)) : prev)),
    applyAttach: () => undefined,
    live: false,
  };
  return (
    <TooltipProvider>
      <RunbookPanel
        c={CASE}
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

function liveText(): string {
  return document.querySelector('[data-runbook-live]')?.textContent ?? '';
}

/** Open the Contain phase and the Action step's row; returns the row's detail. */
async function openResetRow(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('tab', { name: /^Contain/ }));
  const row = within(screen.getByRole('list', { name: 'Contain steps' })).getByRole('button', { name: /Reset the affected accounts/ });
  await user.click(row);
  return document.getElementById(row.getAttribute('aria-controls') as string) as HTMLElement;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.draftRunbookStep.mockResolvedValue({ update: null, estimate: null });
  api.getRunbookCandidates.mockResolvedValue({ candidates: [] });
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('roles by their labels (wrb-10)', () => {
  it('names a built-in role by its label, from the server or, for an older server, the Console', () => {
    expect(runRoleLabel('soc_manager', { soc_manager: 'SOC manager' })).toBe('SOC manager');
    // No `role_labels` (an older server): the Console's own label, however the step writes it.
    expect(runRoleLabel('soc_manager')).toBe('SOC manager');
    expect(runRoleLabel('SOC Manager')).toBe('SOC manager');
    expect(runRoleLabel('soc-manager')).toBe('SOC manager');
    expect(roleWords('soc_manager')).toEqual({ label: 'SOC manager', noun: 'SOC manager', withArticle: 'a SOC manager' });
    expect(roleWords('analyst_tier2').withArticle).toBe('an analyst Tier 2');
    // A custom role reads as its words; the server's label for it wins.
    expect(roleWords('incident_lead').withArticle).toBe('an incident lead');
    expect(roleWords('ir_lead', { ir_lead: 'IR lead' }).withArticle).toBe('an IR lead');
    expect(roleWords(null).withArticle).toBe('an approver');
    // Hidden characters (a bidirectional override) never reach the sentence.
    expect(runRoleLabel('incident‮_lead')).toBe('Incident lead');
  });

  it("reads a role made only of separators as the server's 'Approver', never a dash", () => {
    // `runbook_runs.role_label`: no words left after the separators is "Approver".
    for (const role of ['-', '_', '__', '- _', '‮-']) {
      expect(runRoleLabel(role), JSON.stringify(role)).toBe('Approver');
    }
    expect(roleWords('_').withArticle).toBe('an approver');
    expect(roleWords('-').noun).toBe('approver');
    // The record form of a run whose answer has no label for the role (Start runbook's):
    // "a different approver", never a dash.
    const step = { ...SOC_STEPS.find((s) => s.id === 'reset')!, approval_role: '-' };
    render(<ActionRecordForm step={step} draft={{ where: '', outcome: '', performedAt: '' }} onChange={vi.fn()} disabled={false} idBase="t" />);
    expect(screen.getByText(/After you record it, a different approver may need to approve it\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\u2013\u2014]/);
    // Inner runs of spaces collapse, as the server reads them.
    expect(runRoleLabel('incident  _ lead')).toBe('Incident lead');
  });

  it('cuts a role label at 64 characters as the server does, never inside an emoji', () => {
    const emoji = '\u{1F6E1}\u{FE0F}';
    // 62 letters, then the shield emoji (2 code points, 3 UTF-16 units): 64 code points.
    const label = `${'a'.repeat(62)}${emoji}`;
    expect(Array.from(label)).toHaveLength(64);
    expect(label.length).toBe(65);
    const served = roleLabelsFrom({ role_labels: { shield: label } }).shield;
    expect(served).toBe(label);
    expect(served).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // A longer label is cut at 64 code points: the astral character stays whole.
    const long = `${'b'.repeat(63)}\u{1F512}tail`;
    const cut = roleLabelsFrom({ role_labels: { lock: long } }).lock;
    expect(cut).toBe(`${'b'.repeat(63)}\u{1F512}`);
    expect(Array.from(cut)).toHaveLength(64);
    // The Console's own words for a custom role are cut the same way.
    const custom = runRoleLabel(`${'c'.repeat(63)}\u{1F512}_lead`);
    expect(custom).toBe(`C${'c'.repeat(62)}\u{1F512}`);
    // A lone surrogate is hidden text: it never reaches the sentence.
    expect(runRoleLabel('ir\uD83D_lead')).toBe('Ir lead');
    expect(roleLabelsFrom({ role_labels: { odd: 'IR\uDC00 lead' } })).toEqual({ odd: 'IR lead' });
  });

  it("tells an acronym by its code points, as the server's role_label does", () => {
    // `runbook_runs._humanized` counts code points: three of them with no lower case
    // letter is an acronym, kept as written, even when one is an astral character.
    expect(runRoleLabel('IR\u{1F512}')).toBe('IR\u{1F512}');
    expect(roleWords('IR\u{1F512}').withArticle).toBe('an IR\u{1F512}');
    expect(runRoleLabel('AB\u{1F6E1}')).toBe('AB\u{1F6E1}');
    expect(roleWords('AB\u{1F6E1}').withArticle).toBe('an AB\u{1F6E1}');
    // Four code points is a word again: "Abcd", whatever the UTF-16 length.
    expect(runRoleLabel('ABC\u{1F512}')).toBe('Abc\u{1F512}');
    // An astral first letter is upper cased whole (Deseret small long i).
    expect(runRoleLabel('\u{10428}_lead')).toBe('\u{10400} lead');
    // The words a person writes are unchanged.
    expect(runRoleLabel('incident_lead')).toBe('Incident lead');
    expect(runRoleLabel('IR_lead')).toBe('IR lead');
    expect(runRoleLabel('ir_lead')).toBe('Ir lead');
  });

  it("finds a built-in role by the server's case folding and whitespace", () => {
    // `role_key` folds case as Python's `str.casefold` and splits on Python's whitespace.
    expect(roleKey('ſoc_manager')).toBe('soc_manager');
    expect(roleKey('analy\u{FB06}_tier1')).toBe('analyst_tier1');
    expect(roleKey('Großteam')).toBe(roleKey('GROSSTEAM'));
    expect(roleKey('ẞ')).toBe('ss');
    expect(roleKey('ı')).toBe('ı');
    expect(roleKey('\u{AB70}')).toBe('Ꭰ');
    expect(roleKey('ΟΔΟΣ')).toBe('οδοσ');
    expect(roleKey('soc\x1cmanager')).toBe('soc_manager');
    expect(roleKey('\x85soc manager\x1f')).toBe('soc_manager');
    expect(roleKey('soc\u{FEFF}manager')).toBe('soc\u{FEFF}manager');
    expect(runRoleLabel('ſoc_manager')).toBe('SOC manager');
    expect(roleWords('reſponder').withArticle).toBe('a responder');
    expect(runRoleLabel('SOC\x1cmanager')).toBe('SOC manager');
    // One role to the server is one role to the approval hint.
    const viewer = { unrestricted: false, role: 'analyst_tier1', custom: ['GROSSTEAM'] };
    expect(holdsApprovalRole('Großteam', viewer)).toBe(true);
    expect(holdsApprovalRole('Große', viewer)).toBe(false);
  });

  it("picks the article by Python's Unicode rules, as the server's regular expressions do", () => {
    // Python's ignore-case "i" matches "İ" and "ı": a vowel letter first.
    expect(indefiniteArticle('İnceleme lideri')).toBe('an');
    expect(indefiniteArticle('ıt lead')).toBe('an');
    expect(indefiniteArticle('heİr desk')).toBe('an');
    expect(indefiniteArticle('hourı desk')).toBe('a');
    expect(indefiniteArticle('unİx admin')).toBe('a');
    // Its "s" matches "ſ" and its "k" the Kelvin sign.
    expect(indefiniteArticle('uſa desk')).toBe('a');
    expect(indefiniteArticle('uKa desk')).toBe('a');
    // Its `\b` needs a non-word character after the initialism: "UK中" is one word.
    expect(indefiniteArticle('UK lead')).toBe('a');
    expect(indefiniteArticle('UK中 lead')).toBe('an');
    expect(indefiniteArticle('UK٣ lead')).toBe('an');
    expect(indefiniteArticle('USBé admin')).toBe('an');
    // A combining mark is not a word character to Python: the word ends before it.
    expect(indefiniteArticle('UḰ lead')).toBe('a');
    expect(indefiniteArticle('oncé desk')).toBe('an');
    expect(indefiniteArticle('oncé desk')).toBe('a');
    // One letter is one code point: an astral letter is read by its name, as "a".
    expect(indefiniteArticle('\u{1D400} lead')).toBe('a');
  });

  it('keeps only string labels from an answer and cleans them', () => {
    expect(roleLabelsFrom({ role_labels: { soc_manager: 'SOC manager', bad: 7, blank: '  ', odd: 'IR‮ lead' } })).toEqual({
      soc_manager: 'SOC manager',
      odd: 'IR lead',
    });
    expect(roleLabelsFrom({})).toEqual({});
    expect(roleLabelsFrom(null)).toEqual({});
    expect(roleLabelsFrom({ role_labels: ['soc_manager'] })).toEqual({});
  });

  it("picks the article as the server's refusals do, for every role the backend pins", () => {
    // The backend's own table (`test_the_article_follows_the_sound_of_the_role`), so the
    // Console and the API never word one role two ways.
    const source = readFileSync(path.resolve(__dirname, '../../../../../../backend/tests/test_runbook_runs.py'), 'utf8');
    const block = /@pytest\.mark\.parametrize\("role, phrase", \[(.*?)\]\)\s*def test_the_article_follows_the_sound_of_the_role/s.exec(source);
    expect(block).not.toBeNull();
    const pairs = Array.from(block![1].matchAll(/\("([^"]+)", "([^"]+)"\)/g), (m) => [m[1], m[2]] as const);
    expect(pairs.length).toBeGreaterThan(20);
    for (const [role, phrase] of pairs) expect(roleWords(role).withArticle, role).toBe(phrase);
    expect(indefiniteArticle('')).toBe('a');
  });

  it('words a pending approval with the label, for the recorder and for someone without the role', () => {
    const run = pendingRun();
    const step = SOC_STEPS.find((s) => s.id === 'reset')!;
    const view = (currentUser: string, canApprove: boolean) =>
      render(
        <ActionRecordView
          step={step}
          state={run.steps.reset}
          nameOf={(u) => (u === 'asha' ? 'Asha Rao' : u)}
          currentUser={currentUser}
          canApprove={canApprove}
          busy={false}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          roleLabels={{ soc_manager: 'SOC manager' }}
        />,
      );
    const first = view('asha', true);
    expect(screen.getByText(/Waiting for approval from a SOC manager/)).toBeInTheDocument();
    expect(screen.getByText('Asha Rao recorded this action, so a different SOC manager approves it.')).toBeInTheDocument();
    expect(screen.getByText('Only a SOC manager other than Asha Rao can approve.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/soc manager|soc_manager/);
    first.unmount();
    view('tara', false);
    expect(screen.getByText('Only a SOC manager can approve this step.')).toBeInTheDocument();
  });

  it('reads the role labels the case sends, and those a write adds, in the Runbook tab', async () => {
    const user = userEvent.setup();
    const custom = SOC_STEPS.map((s) => (s.id === 'reset' ? { ...s, approval_role: 'ir_duty' } : s));
    const run = makeRun({ snapshot: { ...DEFINITION, steps: custom } }, {
      reset: { ...PENDING, approval: { ...PENDING.approval, required_role: 'ir_duty' } },
    });
    render(<Harness initial={withLabels(makeData([run]), { ir_duty: 'IR duty officer' })} />);
    const detail = await openResetRow(user);
    expect(within(detail).getByText(/Waiting for approval from an IR duty officer/)).toBeInTheDocument();
    expect(within(detail).getByText('Asha Rao recorded this action, so a different IR duty officer approves it.')).toBeInTheDocument();
  });

  it('merges the labels of a write into the case, keeping those it already had', () => {
    const data = withLabels(makeData([makeRun()]), { incident_lead: 'Incident lead' });
    const merged = mergeRun(data, makeRun({ revision: 9 }), null, 9, { soc_manager: 'SOC manager' });
    expect(roleLabelsFrom(merged)).toEqual({ incident_lead: 'Incident lead', soc_manager: 'SOC manager' });
    // No labels on either side: the shape stays as it was.
    expect('role_labels' in mergeRun(makeData([makeRun()]), makeRun(), null, 3)).toBe(false);
  });
});

describe('Approve leaves focus on the step (wrb-07)', () => {
  it('moves focus to "Approved by" and says the step was approved, once', async () => {
    const user = userEvent.setup();
    api.decideRunbookApproval.mockResolvedValue(update(approvedRun(), 2, { role_labels: { soc_manager: 'SOC manager' } }));
    render(<Harness initial={withLabels(makeData([pendingRun()]), { soc_manager: 'SOC manager' })} />);
    const detail = await openResetRow(user);
    const approve = within(detail).getByRole('button', { name: 'Approve' });
    act(() => approve.focus());
    await user.keyboard('{Enter}');

    expect(api.decideRunbookApproval).toHaveBeenCalledWith('case-1', 'run-1', 'reset', { decision: 'approve' });
    const outcome = await within(detail).findByText(/^Approved by Ben Ito at .*14:52 UTC\.$/);
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    expect(outcome).toHaveAttribute('data-approval-outcome', 'approved');
    expect(outcome).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(liveText()).toBe('Step 5 approved. Next, step 3: Did any sign-in succeed after the failures?'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('leaves focus where the person moved it while the approval was saved', async () => {
    const user = userEvent.setup();
    let answer: (value: RunbookRunUpdate) => void = () => undefined;
    api.decideRunbookApproval.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<Harness initial={makeData([pendingRun()])} />);
    const detail = await openResetRow(user);
    const approve = within(detail).getByRole('button', { name: 'Approve' });
    act(() => approve.focus());
    await user.keyboard('{Enter}');
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await act(async () => answer(update(approvedRun(), 2)));
    await within(detail).findByText(/^Approved by Ben Ito/);
    expect(document.activeElement).toBe(actions);
  });

  it('keeps Approve, and focus on it, when the approval is refused', async () => {
    const user = userEvent.setup();
    api.decideRunbookApproval.mockRejectedValue(
      new ApiError(403, 'Only a SOC manager other than Ben can approve.', {
        detail: { code: 'runbook_distinct_approver', message: 'Only a SOC manager other than Ben can approve.' },
      }),
    );
    render(<Harness initial={makeData([pendingRun()])} />);
    const detail = await openResetRow(user);
    const approve = within(detail).getByRole('button', { name: 'Approve' });
    act(() => approve.focus());
    await user.keyboard('{Enter}');
    expect(await within(detail).findByRole('alert')).toHaveTextContent('Only a SOC manager other than Ben can approve.');
    expect(document.activeElement).toBe(approve);
    expect(liveText()).toBe('');
  });
});

describe('one announcement per write (wrb-06)', () => {
  it('says a version switch in its toast only, not in the tab\'s live region too', async () => {
    const user = userEvent.setup();
    const switched = makeRun({ version: 5, revision: 8 });
    api.switchRunbookRunVersion.mockResolvedValue(update(switched, 3));
    render(<Harness initial={makeData([makeRun()], { newer_versions: { 'run-1': 5 } })} />);
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Switch to version 5' }));
    await user.click(await screen.findByRole('button', { name: 'Switch to version 5' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(switchedSentence(5)));
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(switchedSentence(5)).toBe('Switched to version 5.');
    // Give the live region's deferred write its time: it stays quiet.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(liveText()).toBe('');
  });

  it("shows a stale save's note next to the step without speaking it a second time", async () => {
    const user = userEvent.setup();
    const latest = makeRun({ revision: 8 }, { owner: { status: 'in_progress', assignee: 'asha', revision: 2 } });
    api.updateRunbookStep.mockRejectedValue(
      new ApiError(409, 'This step changed.', {
        detail: { code: 'runbook_conflict', message: 'This step changed.', latest: update(latest, 3) },
      }),
    );
    render(<Harness initial={makeData([makeRun({}, { owner: { status: 'todo', completed_at: null, completed_by: null } })])} />);
    const card = screen.getByRole('region', { name: 'Next step' });
    expect(within(card).getByRole('heading', { level: 3, name: 'Is the source a known scanner?' })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(liveText()).toBe(CONFLICT_NOTE));
    const note = await within(card).findByText(CONFLICT_NOTE, { selector: '[data-step-note]' });
    expect(note).not.toHaveAttribute('role');
    expect(note.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});

describe('reason dialogs open without an error (wrb-09)', () => {
  it('shows "Give a reason." only after an empty submit, never on open or on leaving the field', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <ReasonDialog open onOpenChange={vi.fn()} title="Abandon this runbook?" label="Why are you abandoning it?" submitLabel="Abandon run" onSubmit={onSubmit} />,
    );
    const field = screen.getByLabelText('Why are you abandoning it?');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => field.focus());
    fireEvent.blur(field);
    expect(screen.queryByText(EMPTY_REASON_ERROR)).toBeNull();
    expect(field).not.toHaveAttribute('aria-invalid');

    await user.click(screen.getByRole('button', { name: 'Abandon run' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(EMPTY_REASON_ERROR);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await user.type(field, 'Wrong runbook');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Abandon run' }));
    expect(onSubmit).toHaveBeenCalledWith('Wrong runbook');
  });

  it('opens Abandon run from the menu with no error, focus in the field, and no stale refusal on reopening', async () => {
    const user = userEvent.setup();
    api.abandonRunbookRun.mockRejectedValue(
      new ApiError(409, 'This run changed. Reload it.', { detail: { code: 'runbook_conflict', message: 'This run changed. Reload it.' } }),
    );
    render(<Harness initial={makeData([makeRun()])} />);
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Abandon run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Abandon this runbook?' });
    const field = within(dialog).getByLabelText('Why are you abandoning it?');
    await waitFor(() => expect(document.activeElement).toBe(field));
    // Let the menu finish closing: it must not take focus back, nor leave an error behind.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(field);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(dialog).not.toHaveTextContent(EMPTY_REASON_ERROR);

    await user.type(field, 'Wrong runbook');
    await user.click(within(dialog).getByRole('button', { name: 'Abandon run' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This run changed. Reload it.');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(actions));

    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Abandon run' }));
    const again = await screen.findByRole('dialog', { name: 'Abandon this runbook?' });
    expect(within(again).queryByRole('alert')).toBeNull();
  });

  it('opens Start a runbook from the narrow Runbook actions menu with focus kept in its search field, and Esc returns it to the menu button', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 356, height: 800, top: 0, left: 0, right: 356, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    render(<Harness initial={makeData([makeRun()])} />);
    const actions = screen.getByRole('button', { name: 'Runbook actions' });
    act(() => actions.focus());
    await user.keyboard('{Enter}');
    const item = await screen.findByRole('menuitem', { name: 'Add runbook' });
    await waitFor(() => expect(document.activeElement).toBe(item));
    const focused: Element[] = [];
    const onFocusIn = (event: FocusEvent) => focused.push(event.target as Element);
    document.addEventListener('focusin', onFocusIn);
    try {
      await user.keyboard('{Enter}');
      const dialog = await screen.findByRole('dialog', { name: 'Start a runbook' });
      const search = within(dialog).getByLabelText('Search runbooks');
      await waitFor(() => expect(document.activeElement).toBe(search));
      // Let the menu finish closing: it must not hand focus back to its button.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(document.activeElement).toBe(search);
      expect(focused).not.toContain(actions);
      expect(focused.filter((el) => el === search)).toHaveLength(1);
    } finally {
      document.removeEventListener('focusin', onFocusIn);
    }

    // The menu item that opened the picker is gone: Esc lands on its menu button.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(actions));
  });

  it('returns focus from Start a runbook to the Add runbook button of a wide strip', async () => {
    const user = userEvent.setup();
    render(<Harness initial={makeData([makeRun()])} />);
    const add = screen.getByRole('button', { name: 'Add runbook' });
    await user.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Start a runbook' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText('Search runbooks')));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('opens Not applicable from the More menu of a narrow card with no error and focus in the field', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: 356, height: 800, top: 0, left: 0, right: 356, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
    );
    render(<Harness initial={makeData([makeRun({}, { success: { ai_draft: null } })])} />);
    const more = within(screen.getByRole('region', { name: 'Next step' })).getByRole('button', { name: 'More step actions' });
    act(() => more.focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: 'Not applicable' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why is this step not applicable?' });
    const field = within(dialog).getByLabelText('Why does it not apply to this case?');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(field);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});

describe('the step a recorded approval belongs to', () => {
  it('keeps a rejected outcome focusable for the same hand-off', () => {
    const run = makeRun({ snapshot: SOC_DEFINITION }, {
      reset: { ...PENDING, approval: { ...PENDING.approval, status: 'rejected', by: 'ben', at: '2026-10-28T14:40:00Z', reason: 'Wrong ticket' } },
    });
    render(
      <ActionRecordView
        step={SOC_STEPS.find((s) => s.id === 'reset')!}
        state={state(run.steps.reset)}
        currentUser="asha"
        canApprove
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const line = screen.getByText(/^Rejected by ben/);
    expect(line).toHaveAttribute('data-approval-outcome', 'rejected');
    expect(line).toHaveAttribute('tabindex', '-1');
  });
});
