/**
 * The runbook editor (Round 14, SPEC §4.10.12, C11 A, F17): writes carry
 * `expected_revision`, Publish also the reviewed version's `content_hash`; live issues
 * disable Publish with the count and link to their field; a new runbook holds its issues
 * back until a field is left or a save is tried; a save conflict keeps the local edit in the
 * Source view; built-ins, Demo Mode and viewers without `runbooks:manage` read only; the
 * outline is a keyboard tree; the match preview says when cases cannot be shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(['runbooks:read', 'runbooks:manage', 'runbooks:publish', 'cases:read', 'sources:read']),
  demo: false,
  phone: false,
  wide: false,
  getRunbookDetail: vi.fn(),
  getRunbookVersion: vi.fn(),
  createRunbook: vi.fn(),
  saveRunbookDraft: vi.fn(),
  discardRunbookDraft: vi.fn(),
  duplicateRunbook: vi.fn(),
  submitRunbookForReview: vi.fn(),
  publishRunbook: vi.fn(),
  rejectRunbook: vi.fn(),
  retireRunbook: vi.fn(),
  restoreRunbook: vi.fn(),
  markRunbookReviewed: vi.fn(),
  restoreRunbookVersionAsDraft: vi.fn(),
  validateRunbook: vi.fn(),
  previewRunbookMatch: vi.fn(),
  exportRunbookMarkdown: vi.fn(),
  testRunbookLookup: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', () => ({
  getRunbookDetail: mocks.getRunbookDetail,
  getRunbookVersion: mocks.getRunbookVersion,
  createRunbook: mocks.createRunbook,
  saveRunbookDraft: mocks.saveRunbookDraft,
  discardRunbookDraft: mocks.discardRunbookDraft,
  duplicateRunbook: mocks.duplicateRunbook,
  submitRunbookForReview: mocks.submitRunbookForReview,
  publishRunbook: mocks.publishRunbook,
  rejectRunbook: mocks.rejectRunbook,
  retireRunbook: mocks.retireRunbook,
  restoreRunbook: mocks.restoreRunbook,
  markRunbookReviewed: mocks.markRunbookReviewed,
  restoreRunbookVersionAsDraft: mocks.restoreRunbookVersionAsDraft,
  validateRunbook: mocks.validateRunbook,
  previewRunbookMatch: mocks.previewRunbookMatch,
  exportRunbookMarkdown: mocks.exportRunbookMarkdown,
  testRunbookLookup: mocks.testRunbookLookup,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      rules: { ...actual.api.rules, list: vi.fn().mockResolvedValue({ detection: [] }) },
      listSources: vi.fn().mockResolvedValue({ sources: [] }),
      getCase: vi.fn().mockResolvedValue({ case_id: 'c1', entity: { type: 'ip', value: '203.0.113.7' }, rule_ids: ['ssh_auth_failed'] }),
    },
  };
});

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: (resource: string, action: string) => mocks.grants.has(`${resource}:${action}`) };
});

vi.mock('@/soc/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/demo')>();
  return { ...actual, useDemo: () => ({ status: mocks.demo ? 'on' : 'off', active: mocks.demo, loading: false, confirmed: true, refresh: async () => 'off' }) };
});

vi.mock('@/soc/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => (query.includes('max-width') ? mocks.phone : mocks.wide),
}));

import { ApiError } from '@/lib/api';
import type { RunbookDefinition } from '@/lib/types-runbooks';
import { RouterProvider } from '@/soc/router';
import { Toaster } from '@/ui/sonner';
import { TooltipProvider } from '@/ui/tooltip';

import { DETAILS_ID } from '../Outline';
import { RunbookEditor } from '../RunbookEditor';
import { makeBuiltinDetail, makeDefinition, makeDetail, makeSummary, makeVersion } from './fixtures';

const DEFAULT_GRANTS = ['runbooks:read', 'runbooks:manage', 'runbooks:publish', 'cases:read', 'sources:read'];

function renderEditor(props: Partial<React.ComponentProps<typeof RunbookEditor>> = {}) {
  const onOpenRunbook = vi.fn();
  const onBackToLibrary = vi.fn();
  const view = render(
    <TooltipProvider>
      <RunbookEditor
        runbookId="my-runbook"
        library={[]}
        onOpenRunbook={onOpenRunbook}
        onBackToLibrary={onBackToLibrary}
        {...props}
      />
    </TooltipProvider>,
  );
  return { ...view, onOpenRunbook, onBackToLibrary };
}

beforeEach(() => {
  mocks.grants = new Set(DEFAULT_GRANTS);
  mocks.demo = false;
  mocks.phone = false;
  mocks.wide = false;
  for (const fn of Object.values(mocks)) if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  mocks.getRunbookDetail.mockResolvedValue(makeDetail());
  mocks.validateRunbook.mockResolvedValue({ issues: [], prompt_chars: 1_234, prompt_budget: 3_000 });
  mocks.previewRunbookMatch.mockResolvedValue({
    considered: 120,
    window_label: 'Last 30 days',
    gets_it: [{ case_id: 'c1', case_number: 'CASE-000214', title: 'SSH spray', explanation: { tier: 3, matched: [{ criterion: 'rule_ids', value: 'ssh_auth_failed' }], missed: [], tie: false } }],
    another_wins: [],
    near_misses: [{ case_id: 'c2', case_number: 'CASE-000215', title: 'VPN failures', failed: [{ criterion: 'rule_ids', expected: ['ssh_auth_failed'], actual: ['vpn_auth_failed'] }] }],
    counts: { gets_it: 1, another_wins: 0, near_misses: 1 },
    truncated: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('saving and publishing', () => {
  it('saves the edited draft with the detail revision', async () => {
    mocks.saveRunbookDraft.mockResolvedValue(makeDetail({ revision: 8 }));
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Password spray response' });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Password spray and brute force' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveRunbookDraft).toHaveBeenCalledTimes(1));
    const [id, body] = mocks.saveRunbookDraft.mock.calls[0];
    expect(id).toBe('my-runbook');
    expect(body.expected_revision).toBe(7);
    expect(body.definition.title).toBe('Password spray and brute force');
  });

  it('publishes the reviewed version with its content hash and the revision', async () => {
    mocks.publishRunbook.mockResolvedValue(makeDetail({ draft: null, revision: 9 }));
    renderEditor();
    const publish = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled());
    fireEvent.click(publish);
    await waitFor(() =>
      expect(mocks.publishRunbook).toHaveBeenCalledWith('my-runbook', { version: 2, expected_revision: 7, content_hash: 'hash-v2' }),
    );
  });

  it('disables Publish with the count of problems, and each problem moves focus to its field', async () => {
    mocks.validateRunbook.mockResolvedValue({
      issues: [
        { path: 'title', code: 'required', message: 'Give the runbook a title.' },
        { path: 'steps[0].focus', code: 'too_long', message: 'Shorten the focus line.' },
      ],
      prompt_chars: 1_234,
      prompt_budget: 3_000,
    });
    renderEditor();
    const blocked = await screen.findByRole('button', { name: 'Fix 2 problems to publish' }, { timeout: 3000 });
    expect(blocked).toBeDisabled();
    const summary = screen.getByRole('region', { name: 'Fix 2 problems to publish' });
    fireEvent.click(within(summary).getByRole('button', { name: /Shorten the focus line/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('rb-step-first-check-focus'));
    fireEvent.click(within(summary).getByRole('button', { name: /Give the runbook a title/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('rb-header-title'));
  });

  it('keeps a conflicting edit in the Source view until the person reloads', async () => {
    const latest = makeDetail({ revision: 12, draft: makeVersion(3, 'draft', makeDefinition({ title: 'Changed elsewhere' })) });
    mocks.saveRunbookDraft.mockRejectedValue(
      new ApiError(409, 'Someone else changed this draft. Reload it to see their changes.', {
        detail: { code: 'runbook_conflict', message: 'Someone else changed this draft. Reload it to see their changes.', latest },
      }),
    );
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Password spray response' });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'My local edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Someone else changed this draft.')).toBeInTheDocument();
    const source = screen.getByLabelText('Markdown') as HTMLTextAreaElement;
    expect(source.value).toContain('My local edit');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByText('Someone else changed this draft.')).toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'Password spray response' })).toBeInTheDocument();
  });

  it('treats an unchanged revision after Save as success', async () => {
    mocks.saveRunbookDraft.mockResolvedValue(makeDetail());
    renderEditor();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Summary/), { target: { value: 'Different summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveRunbookDraft).toHaveBeenCalled());
    expect(screen.queryByText('Someone else changed this draft.')).toBeNull();
  });
});

describe('who may edit', () => {
  it('opens a built-in read only with Duplicate to customise, and its links stay https only', async () => {
    mocks.getRunbookDetail.mockResolvedValue(makeBuiltinDetail());
    mocks.duplicateRunbook.mockResolvedValue(makeDetail({ summary: { ...makeDetail().summary, id: 'brute-force-password-spray-custom' } }));
    const { onOpenRunbook } = renderEditor({ runbookId: 'brute-force-password-spray' });
    expect(await screen.findByText(/Built-in runbooks are read only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    const refs = Array.from(document.querySelectorAll('[data-runbook-link="https"]'));
    expect(refs.map((a) => a.getAttribute('href'))).toEqual(['https://attack.mitre.org/techniques/T1110/']);
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to customise' }));
    await waitFor(() => expect(mocks.duplicateRunbook).toHaveBeenCalledWith('brute-force-password-spray', { expected_revision: 3 }));
    await waitFor(() => expect(onOpenRunbook).toHaveBeenCalledWith('brute-force-password-spray-custom', expect.anything()));
  });

  it('reads only in Demo Mode: the write action is shown disabled with the Demo sentence', async () => {
    mocks.demo = true;
    renderEditor();
    const note = await screen.findByText('Runbooks cannot be edited in Demo Mode.');
    const save = screen.getByRole('button', { name: 'Save draft' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAccessibleDescription('Runbooks cannot be edited in Demo Mode.');
    expect(note.closest('p')).toHaveAttribute('id', save.getAttribute('aria-describedby'));
    fireEvent.click(save);
    expect(mocks.saveRunbookDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/ })).toBeNull();
  });

  it('shows a built-in in Demo Mode with Duplicate to customise disabled, and does not point to it', async () => {
    mocks.demo = true;
    mocks.getRunbookDetail.mockResolvedValue(makeBuiltinDetail());
    renderEditor({ runbookId: 'brute-force-password-spray' });
    expect(await screen.findByText('Built-in runbooks are read only and are updated with Agentic SOC releases.')).toBeInTheDocument();
    const duplicate = screen.getByRole('button', { name: 'Duplicate to customise' });
    expect(duplicate).toHaveAttribute('aria-disabled', 'true');
    expect(duplicate).toHaveAccessibleDescription('Runbooks cannot be edited in Demo Mode.');
    fireEvent.click(duplicate);
    expect(mocks.duplicateRunbook).not.toHaveBeenCalled();
    expect(screen.queryByText(/Duplicate one to customise it/)).toBeNull();
  });

  it('reads only without runbooks:manage', async () => {
    mocks.grants = new Set(['runbooks:read', 'cases:read']);
    renderEditor();
    expect(await screen.findByText('You can view this runbook but not change it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add condition' })).toBeNull();
  });
});

describe('a new runbook (F17)', () => {
  it('shows an issue only once its field was left, and creates the draft with an id from the title', async () => {
    mocks.validateRunbook.mockResolvedValue({
      issues: [{ path: 'title', code: 'required', message: 'Give the runbook a title.' }],
      prompt_chars: 120,
      prompt_budget: 3_000,
    });
    const created = makeDetail({ summary: { ...makeDetail().summary, id: 'phishing-triage' } });
    mocks.createRunbook.mockResolvedValue(created);
    const { onOpenRunbook } = renderEditor({ runbookId: 'new', initialDetail: null });
    expect(screen.getByRole('heading', { level: 1, name: 'New runbook' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled(), { timeout: 3000 });
    expect(screen.queryByText('Give the runbook a title.')).toBeNull();
    const title = screen.getByLabelText(/^Title/);
    fireEvent.blur(title);
    expect(await screen.findAllByText('Give the runbook a title.')).not.toHaveLength(0);
    fireEvent.change(title, { target: { value: 'Phishing triage' } });
    expect((screen.getByLabelText(/^Id/) as HTMLInputElement).value).toBe('phishing-triage');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.createRunbook).toHaveBeenCalledTimes(1));
    expect(mocks.createRunbook.mock.calls[0][0].definition).toMatchObject({ id: 'phishing-triage', title: 'Phishing triage' });
    await waitFor(() => expect(onOpenRunbook).toHaveBeenCalledWith('phishing-triage', created));
    // Nothing was typed while the create ran: no edits go with it to the new page.
    expect(onOpenRunbook.mock.calls[0]).toHaveLength(2);
  });

  it('carries what was typed during a pending create to the new runbook, under the id it was created with', async () => {
    let resolveCreate: () => void = () => undefined;
    mocks.createRunbook.mockImplementation(
      (body: { definition: RunbookDefinition }) =>
        new Promise((resolve) => {
          resolveCreate = () =>
            resolve(
              makeDetail({
                summary: { ...makeDetail().summary, id: 'phishing-triage', title: 'Phishing triage' },
                live: null,
                draft: makeVersion(1, 'draft', body.definition),
                revision: 1,
              }),
            );
        }),
    );
    const { onOpenRunbook } = renderEditor({ runbookId: 'new', initialDetail: null });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Phishing triage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.createRunbook).toHaveBeenCalledTimes(1));
    expect(mocks.createRunbook.mock.calls[0][0].definition).toMatchObject({ id: 'phishing-triage', summary: '' });
    // The fields stay editable while the create runs. A new title would move the id with it.
    fireEvent.change(screen.getByLabelText(/^Summary/), { target: { value: 'Typed while creating' } });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Phishing triage and reply' } });
    await act(async () => {
      resolveCreate();
    });
    await waitFor(() => expect(onOpenRunbook).toHaveBeenCalledTimes(1));
    const [id, detail, edits] = onOpenRunbook.mock.calls[0];
    expect(id).toBe('phishing-triage');
    expect(detail.summary.id).toBe('phishing-triage');
    expect(edits).toMatchObject({
      source: null,
      selected: DETAILS_ID,
      definition: { id: 'phishing-triage', title: 'Phishing triage and reply', summary: 'Typed while creating' },
    });
    expect(await screen.findByText('Draft saved. What you typed while it saved is kept as unsaved changes.')).toBeInTheDocument();
  });

  it('opens a runbook handed edits from its create with them unsaved, where they were made, and saves them', async () => {
    const created = makeDetail();
    const definition: RunbookDefinition = { ...created.draft!.definition, summary: 'Typed while creating' };
    mocks.saveRunbookDraft.mockImplementation(async (_id: string, body: { definition: RunbookDefinition }) =>
      makeDetail({ revision: 8, draft: makeVersion(2, 'draft', body.definition) }),
    );
    renderEditor({ initialDetail: created, initialEdits: { definition, source: null, selected: DETAILS_ID } });
    const summary = (await screen.findByLabelText(/^Summary/)) as HTMLTextAreaElement;
    expect(summary.value).toBe('Typed while creating');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(mocks.getRunbookDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveRunbookDraft).toHaveBeenCalledTimes(1));
    expect(mocks.saveRunbookDraft.mock.calls[0][1]).toMatchObject({ expected_revision: 7, definition: { summary: 'Typed while creating' } });
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });

  it('opens carried Markdown that does not read in the Source view, unsaved, rather than losing it', async () => {
    const created = makeDetail();
    renderEditor({
      initialDetail: created,
      initialEdits: { definition: created.draft!.definition, source: 'not a runbook', selected: DETAILS_ID },
    });
    const source = (await screen.findByLabelText('Markdown')) as HTMLTextAreaElement;
    expect(source.value).toBe('not a runbook');
    expect(screen.getByText(/the outline shows the last version that read correctly/)).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('starts with the rule it was created for', async () => {
    renderEditor({ runbookId: 'new', seedRule: 'vpn_auth_failed' });
    expect(screen.getByText('vpn_auth_failed')).toBeInTheDocument();
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled(), { timeout: 3000 });
  });
});

describe('the outline', () => {
  it('is a tree, and Alt with an arrow key moves a step and says where', async () => {
    renderEditor();
    const tree = await screen.findByRole('tree', { name: 'Phases and steps' });
    const steps = () => within(tree).getAllByRole('treeitem').filter((el) => el.getAttribute('aria-level') === '2');
    expect(steps().map((el) => el.getAttribute('aria-selected'))).toContain('true');
    const first = steps().find((el) => el.textContent?.includes('Is the source a sanctioned scanner?')) as HTMLElement;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(steps()[0].textContent).toContain('Sign-in attempts from the source address'));
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Is the source a sanctioned scanner?'));
    expect(await screen.findByText(/Moved Is the source a sanctioned scanner\? to Triage, step 2\./)).toBeInTheDocument();
  });
});

describe('views and layouts', () => {
  it('lets the Markdown and the outline edit the same runbook', async () => {
    renderEditor();
    await screen.findByRole('tree', { name: 'Phases and steps' });
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    const source = screen.getByLabelText('Markdown') as HTMLTextAreaElement;
    expect(screen.getByText(/Chips and front matter are the same fields; edit either\./)).toBeInTheDocument();
    fireEvent.change(source, { target: { value: source.value.replace('Is the source a sanctioned scanner?', 'Is it a known scanner?') } });
    const tree = screen.getByRole('tree', { name: 'Phases and steps' });
    await waitFor(() => expect(tree.textContent).toContain('Is it a known scanner?'));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.change(source, { target: { value: 'not a runbook' } });
    expect(await screen.findByText(/the outline shows the last version that read correctly/)).toBeInTheDocument();
    expect(tree.textContent).toContain('Is it a known scanner?');
  });

  it('opens the step form in a full-screen sheet on a phone', async () => {
    mocks.phone = true;
    renderEditor();
    const tree = await screen.findByRole('tree', { name: 'Phases and steps' });
    const step = within(tree)
      .getAllByRole('treeitem')
      .find((el) => el.getAttribute('aria-level') === '2' && el.textContent?.includes('Sign-in attempts')) as HTMLElement;
    fireEvent.click(step);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Step 2' })).toBeInTheDocument();
  });

  it('shows the match cases in a side column from 1680 px', async () => {
    mocks.wide = true;
    renderEditor();
    expect(await screen.findByRole('heading', { name: 'Which cases would this match?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Which cases would this match\?/ })).toBeNull();
    expect(await screen.findByText('CASE-000214', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('Which cases would this match?', () => {
  it('sums the groups on the summary line and opens the cases in a sheet', async () => {
    renderEditor();
    const summary = await screen.findByRole('button', { name: /Gets it 1 · Another wins 0 · Near misses 1/ }, { timeout: 3000 });
    fireEvent.click(summary);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('CASE-000214')).toBeInTheDocument();
    expect(within(sheet).getByText('Nothing is attached and no metric changes.')).toBeInTheDocument();
    expect(within(sheet).getByText(/Rule vpn_auth_failed is not/)).toBeInTheDocument();
  });

  it('says when cases cannot be shown, without asking the server', async () => {
    mocks.grants.delete('cases:read');
    renderEditor();
    expect(await screen.findByText('You do not have access to cases.')).toBeInTheDocument();
    expect(mocks.previewRunbookMatch).not.toHaveBeenCalled();
  });
});

/** An operator runbook with a live v2 over a replaced v1, and no draft: Restore is open. */
function publishedOnly() {
  const v1 = makeVersion(1, 'superseded', makeDefinition());
  const v2 = makeVersion(2, 'published', makeDefinition({ steps: makeDefinition().steps.map((s, i) => (i === 0 ? { ...s, title: 'Is it a scanner?' } : s)) }));
  const detail = makeDetail({
    summary: makeSummary({ state: 'published', live_version: 2, draft_version: null }),
    live: v2,
    draft: null,
    versions: [
      { version: 2, state: 'published', published_by: 'priya', published_at: '2026-10-22T10:00:00Z' },
      { version: 1, state: 'superseded', published_by: 'priya', published_at: '2026-10-21T10:00:00Z' },
    ],
  });
  return { v1, v2, detail };
}

describe('history', () => {
  it('compares two versions step by step and restores one as a draft', async () => {
    const { v1, v2, detail } = publishedOnly();
    mocks.getRunbookDetail.mockResolvedValue(detail);
    mocks.getRunbookVersion.mockImplementation(async (_id: string, n: number) => (n === 1 ? v1 : v2));
    mocks.restoreRunbookVersionAsDraft.mockResolvedValue(makeDetail({ revision: 10 }));
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Edited: Is it a scanner? (title)')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore v1 as draft' }));
    await waitFor(() => expect(mocks.restoreRunbookVersionAsDraft).toHaveBeenCalledWith('my-runbook', 1, { expected_revision: 7 }));
  });

  it('offers Restore disabled, with the reason, while a draft exists (the server would refuse it)', async () => {
    mocks.getRunbookVersion.mockResolvedValue(makeVersion(1, 'published'));
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    const sheet = await screen.findByRole('dialog');
    const restore = within(sheet).getByRole('button', { name: 'Restore v1 as draft' });
    expect(restore).toBeDisabled();
    expect(within(sheet).getByText('Version 2 is still a draft. Discard or publish it first.')).toBeInTheDocument();
    expect(mocks.restoreRunbookVersionAsDraft).not.toHaveBeenCalled();
  });

  it('holds Restore back while the editor has unsaved changes', async () => {
    const { v1, v2, detail } = publishedOnly();
    mocks.getRunbookDetail.mockResolvedValue(detail);
    mocks.getRunbookVersion.mockImplementation(async (_id: string, n: number) => (n === 1 ? v1 : v2));
    renderEditor();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'An unsaved title' } });
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Restore v1 as draft' })).toBeDisabled();
    expect(within(sheet).getByText(/Save or discard your changes first/)).toBeInTheDocument();
  });

  it('reads a draft again after a save, so a comparison never shows its earlier text', async () => {
    const live = makeVersion(1, 'published', makeDefinition());
    let draftTitle = 'First draft title';
    mocks.getRunbookVersion.mockImplementation(async (_id: string, n: number) =>
      n === 1 ? live : makeVersion(2, 'draft', makeDefinition({ steps: makeDefinition().steps.map((s, i) => (i === 0 ? { ...s, title: draftTitle } : s)) })),
    );
    mocks.saveRunbookDraft.mockResolvedValue(makeDetail({ revision: 8 }));
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    let sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Edited: First draft title (title)')).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    draftTitle = 'Second draft title';
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Summary/), { target: { value: 'Changed summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveRunbookDraft).toHaveBeenCalled());
    await screen.findByText('Draft saved.', {}, { timeout: 3000 }).catch(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Edited: Second draft title (title)')).toBeInTheDocument();
  });
});

describe('copy', () => {
  it('uses no em dash and never the retired word', async () => {
    const { container } = renderEditor();
    await screen.findByRole('heading', { level: 1 });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Preview as analyst' }));
    });
    await waitFor(() => expect(container.textContent).toMatch(/Investigator guidance: 1,234 of 3,000 characters/), {
      timeout: 3000,
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/playbook/i);
  });
});

describe('edits made while a write runs', () => {
  it('keeps a field typed during a pending save, and the page stays unsaved', async () => {
    let resolveSave: (d: unknown) => void = () => undefined;
    mocks.saveRunbookDraft.mockImplementation(
      (_id: string, body: { definition: ReturnType<typeof makeDefinition> }) =>
        new Promise((resolve) => {
          resolveSave = () =>
            resolve(makeDetail({ revision: 8, draft: makeVersion(2, 'draft', body.definition) }));
        }),
    );
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Password spray response' });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Password spray and brute force' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveRunbookDraft).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/^Summary/), { target: { value: 'Typed while saving' } });
    await act(async () => {
      resolveSave(null);
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save draft' })).not.toHaveAttribute('aria-disabled'));
    expect((screen.getByLabelText(/^Summary/) as HTMLTextAreaElement).value).toBe('Typed while saving');
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Password spray and brute force');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('adopts the saved version when nothing was typed meanwhile', async () => {
    mocks.saveRunbookDraft.mockImplementation(async (_id: string, body: { definition: ReturnType<typeof makeDefinition> }) =>
      makeDetail({ revision: 8, draft: makeVersion(2, 'draft', body.definition) }),
    );
    renderEditor();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Password spray and brute force' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });

  it('holds Mark reviewed, Retire and Send back while there are unsaved changes, and says why', async () => {
    mocks.getRunbookDetail.mockResolvedValue(publishedOnly().detail);
    renderEditor();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'An unsaved title' } });
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.keyDown(more, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Save or discard your changes to use these.')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Mark reviewed' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Retire' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: /Export as Markdown/ })).not.toHaveAttribute('aria-disabled');
  });
});

describe('discarding a draft', () => {
  async function confirmDiscard() {
    await screen.findByRole('heading', { level: 1 });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
  }

  it('binds the discard to the revision on screen', async () => {
    mocks.discardRunbookDraft.mockResolvedValue({ id: 'my-runbook', removed: false, detail: makeDetail({ draft: null, revision: 8 }) });
    renderEditor();
    await confirmDiscard();
    await waitFor(() => expect(mocks.discardRunbookDraft).toHaveBeenCalledWith('my-runbook', 7));
  });

  it('discards nothing when someone else changed the draft, and shows their version', async () => {
    const message = 'Someone else changed this runbook. Reload it to see their changes.';
    const latest = makeDetail({ revision: 9 });
    mocks.discardRunbookDraft.mockRejectedValue(
      new ApiError(409, message, { detail: { code: 'runbook_conflict', message, revision: 9, latest } }),
    );
    const { onBackToLibrary } = renderEditor();
    await confirmDiscard();
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(mocks.discardRunbookDraft).toHaveBeenCalledWith('my-runbook', 7);
    expect(onBackToLibrary).not.toHaveBeenCalled();
    expect(screen.queryByText('Draft discarded.')).toBeNull();
  });
});

describe('a new runbook whose id is taken', () => {
  it('shows the server message on the Id field, keeps the form and offers no Reload', async () => {
    const message = "A runbook with the id 'phishing-triage' already exists. Choose another id.";
    mocks.createRunbook.mockRejectedValue(
      new ApiError(409, message, { detail: { code: 'runbook_conflict', message, exists: true, latest: makeDetail() } }),
    );
    mocks.validateRunbook.mockResolvedValue({ issues: [], prompt_chars: 120, prompt_budget: 3_000 });
    renderEditor({ runbookId: 'new', initialDetail: null });
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Phishing triage' } });
    fireEvent.change(screen.getByLabelText(/^Summary/), { target: { value: 'A reported email.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.createRunbook).toHaveBeenCalledTimes(1));
    const id = screen.getByLabelText(/^Id/) as HTMLInputElement;
    await waitFor(() => expect(id).toHaveAccessibleDescription(expect.stringContaining('already exists')));
    expect(id.value).toBe('phishing-triage');
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Phishing triage');
    expect(screen.queryByText('Someone else changed this draft.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(id));
    // A free id clears the problem.
    fireEvent.change(id, { target: { value: 'phishing-triage-2' } });
    await waitFor(() => expect(id).not.toHaveAccessibleDescription(expect.stringContaining('already exists')));
  });

  it('says an id a library runbook already holds is taken before any save', async () => {
    renderEditor({ runbookId: 'new', initialDetail: null, library: [makeSummary({ id: 'my-runbook' })] });
    const id = screen.getByLabelText(/^Id/) as HTMLInputElement;
    fireEvent.change(id, { target: { value: 'my-runbook' } });
    fireEvent.blur(id);
    expect(await screen.findByText("A runbook with the id 'my-runbook' already exists. Choose another id.")).toBeInTheDocument();
  });
});

describe('problems after a save and while typing', () => {
  it('lists every problem after a refused save (not only the first the server met), and focuses the list', async () => {
    const all = [
      { path: 'id', code: 'required', message: 'Give the runbook an id.' },
      { path: 'title', code: 'required', message: 'Give the runbook a title.' },
      { path: 'summary', code: 'required', message: 'Give the runbook a summary.' },
      { path: 'steps[0].title', code: 'required', message: 'The title of step 1 is required.' },
    ];
    mocks.validateRunbook.mockResolvedValue({ issues: all, prompt_chars: 0, prompt_budget: 3_000 });
    mocks.createRunbook.mockRejectedValue(
      new ApiError(422, 'Fix the problems.', { detail: { code: 'runbook_invalid', message: 'Fix the problems.', issues: [all[0]] } }),
    );
    renderEditor({ runbookId: 'new', initialDetail: null });
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled(), { timeout: 3000 });
    // A new runbook holds its list back until a save is tried.
    expect(screen.queryByRole('region', { name: /problem/ })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save draft' });
    act(() => save.focus());
    fireEvent.click(save);
    const summary = await screen.findByRole('region', { name: 'Fix 4 problems to publish' });
    for (const issue of all) expect(within(summary).getByText(new RegExp(issue.message.replace('.', '\\.')))).toBeInTheDocument();
    // The message that names its step is not prefixed a second time.
    expect(within(summary).queryByText(/Step 1: The title of step 1/)).toBeNull();
    await waitFor(() => expect(document.activeElement?.id).toBe('runbook-issues-title'));
  });

  it('marks Summary as required, and Id while the runbook is new', async () => {
    renderEditor({ runbookId: 'new', initialDetail: null });
    expect(screen.getByLabelText(/^Summary/)).toBeRequired();
    expect(screen.getByLabelText(/^Id/)).toBeRequired();
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('never shows a problem found on text that has since changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.validateRunbook.mockResolvedValue({
      issues: [{ path: 'summary', code: 'required', message: 'Give the runbook a summary.' }],
      prompt_chars: 0,
      prompt_budget: 3_000,
    });
    renderEditor({ runbookId: 'new', initialDetail: null });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled());
    const summaryField = screen.getByLabelText(/^Summary/);
    fireEvent.change(summaryField, { target: { value: 'Typed, then left at once' } });
    fireEvent.blur(summaryField);
    expect(screen.queryByText('Give the runbook a summary.')).toBeNull();
  });
});

describe('leaving the Markdown when it does not read', () => {
  it('asks first, and keeps the Markdown when the person stays', async () => {
    renderEditor();
    await screen.findByRole('tree', { name: 'Phases and steps' });
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    const source = screen.getByLabelText('Markdown') as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: 'not a runbook' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Leave the Markdown with problems?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing the Markdown' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((screen.getByLabelText('Markdown') as HTMLTextAreaElement).value).toBe('not a runbook');
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave and lose those changes' }));
    await waitFor(() => expect(screen.queryByLabelText('Markdown')).toBeNull());
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });
});

describe('focus', () => {
  it('returns focus to History when its sheet closes', async () => {
    mocks.getRunbookVersion.mockResolvedValue(makeVersion(1, 'published'));
    renderEditor();
    const history = await screen.findByRole('button', { name: 'History' });
    act(() => history.focus());
    fireEvent.click(history);
    const sheet = await screen.findByRole('dialog');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(history));
  });

  it('returns focus to the match summary when its sheet closes', async () => {
    renderEditor();
    const summary = await screen.findByRole('button', { name: /Gets it 1/ }, { timeout: 3000 });
    act(() => summary.focus());
    fireEvent.click(summary);
    const sheet = await screen.findByRole('dialog');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(summary));
  });

  it('returns focus to the outline item when the phone step sheet closes', async () => {
    mocks.phone = true;
    renderEditor();
    const tree = await screen.findByRole('tree', { name: 'Phases and steps' });
    const step = within(tree)
      .getAllByRole('treeitem')
      .find((el) => el.getAttribute('aria-level') === '2' && el.textContent?.includes('Sign-in attempts')) as HTMLElement;
    fireEvent.click(step);
    const sheet = await screen.findByRole('dialog');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(step));
  });

  it('keeps focus on Publish while it runs (soft-disabled), then lands on the heading once it is gone', async () => {
    let finish: () => void = () => undefined;
    mocks.publishRunbook.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(makeDetail({ draft: null, revision: 9, summary: makeSummary({ state: 'published', live_version: 2, draft_version: null }) }));
        }),
    );
    renderEditor();
    const publish = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(mocks.validateRunbook).toHaveBeenCalled(), { timeout: 3000 });
    act(() => publish.focus());
    fireEvent.click(publish);
    await waitFor(() => expect(publish).toHaveAttribute('aria-disabled', 'true'));
    expect(document.activeElement).toBe(publish);
    await act(async () => finish());
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H1'));
  });

  it('moves focus to Reload after a conflict', async () => {
    const latest = makeDetail({ revision: 12 });
    mocks.saveRunbookDraft.mockRejectedValue(
      new ApiError(409, 'Stale.', { detail: { code: 'runbook_conflict', message: 'Stale.', latest } }),
    );
    renderEditor();
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'My local edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const reload = await screen.findByRole('button', { name: 'Reload' });
    await waitFor(() => expect(document.activeElement).toBe(reload));
  });

  it('moves focus to the step now selected after a removal, so Enter never removes a second step', async () => {
    renderEditor();
    const tree = await screen.findByRole('tree', { name: 'Phases and steps' });
    const step = within(tree)
      .getAllByRole('treeitem')
      .find((el) => el.getAttribute('aria-level') === '2' && el.textContent?.includes('Sign-in attempts')) as HTMLElement;
    fireEvent.click(step);
    const remove = await screen.findByRole('button', { name: 'Remove step' });
    act(() => remove.focus());
    fireEvent.click(remove);
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Is this a confirmed compromise?'));
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
  });

  it('puts focus in the new step title after Add step', async () => {
    renderEditor();
    await screen.findByRole('tree', { name: 'Phases and steps' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add step' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Lookup/ }));
    await waitFor(() => expect(document.activeElement?.id).toMatch(/^rb-step-lookup.*-title$/));
  });
});

describe('the case links in the match results', () => {
  it('asks before leaving unsaved changes for a case', async () => {
    window.location.hash = '#/runbooks?id=my-runbook';
    render(
      <RouterProvider>
        <TooltipProvider>
          <RunbookEditor runbookId="my-runbook" library={[]} onOpenRunbook={vi.fn()} onBackToLibrary={vi.fn()} />
        </TooltipProvider>
      </RouterProvider>,
    );
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'An unsaved title' } });
    fireEvent.click(await screen.findByRole('button', { name: /Gets it 1/ }, { timeout: 3000 }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('link', { name: 'CASE-000214' }));
    expect(await screen.findByText('Discard your changes to this runbook?')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/runbooks?id=my-runbook');
    window.location.hash = '';
  });
});

describe('what a step sets aside when its kind changes', () => {
  async function addStepOfKind(kind: string) {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add step' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(kind) }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  }

  /** An Action step that tried Lookup with a filter, then went back to Action. */
  async function actionThatTriedLookup() {
    await addStepOfKind('Action');
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(screen.getByLabelText('Filter 1 field')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Action' }));
    expect(screen.queryByLabelText('Filter 1 field')).toBeNull();
  }

  it('goes with a removed step, so a new step that takes its id starts clean, and Undo brings it back', async () => {
    render(
      <TooltipProvider>
        <Toaster />
        <RunbookEditor runbookId="my-runbook" library={[]} onOpenRunbook={vi.fn()} onBackToLibrary={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByRole('tree', { name: 'Phases and steps' });
    await actionThatTriedLookup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove step' }));
    const undo = await screen.findByRole('button', { name: 'Undo' });

    // A new Action step takes the same id; trying Lookup gives it the default lookup only.
    await addStepOfKind('Action');
    expect(document.querySelector('[data-step-form="action"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    expect(screen.queryByLabelText('Filter 1 field')).toBeNull();

    // Undo puts the removed step back with what it had set aside.
    fireEvent.click(undo);
    const tree = screen.getByRole('tree', { name: 'Phases and steps' });
    await waitFor(() => expect(tree.querySelector('[data-outline-step="action"]')).not.toBeNull());
    fireEvent.click(tree.querySelector('[data-outline-step="action"]') as HTMLElement);
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    expect(screen.getByLabelText('Filter 1 field')).toBeInTheDocument();
  });

  it('is cleared when the person reloads after a conflict', async () => {
    const latest = makeDetail({ revision: 12, draft: makeVersion(3, 'draft', makeDefinition({ title: 'Password spray response' })) });
    mocks.saveRunbookDraft.mockRejectedValue(new ApiError(409, 'Stale.', { detail: { code: 'runbook_conflict', message: 'Stale.', latest } }));
    renderEditor();
    const tree = await screen.findByRole('tree', { name: 'Phases and steps' });
    fireEvent.click(tree.querySelector('[data-outline-step="first-check"]') as HTMLElement);
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Check' }));
    fireEvent.change(screen.getByLabelText(/^Question for the analyst/), { target: { value: 'Is it a known scanner?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
    const reloaded = await screen.findByRole('tree', { name: 'Phases and steps' });
    fireEvent.click(reloaded.querySelector('[data-outline-step="first-check"]') as HTMLElement);
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    expect(screen.queryByLabelText('Filter 1 field')).toBeNull();
  });
});
