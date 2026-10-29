/**
 * Procedure management lives in the runbook editor (Round 14, SPEC §4.10.12, §4.10.16).
 * The retired combined catalog's management contract, pinned on its replacement: a bundled
 * procedure opens read only with its Markdown and "Duplicate to customise"; an operator
 * runbook saves with the revision it was opened at and shows what the server stored; a new
 * runbook takes a slug id from its title and refuses a reserved one; a create needs no
 * follow-up read; management is hidden without `runbooks:manage`; and "Which cases would
 * this match?" explains the deterministic selection and the criterion that failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  getRunbookDetail: vi.fn(),
  getRunbookVersion: vi.fn(),
  createRunbook: vi.fn(),
  saveRunbookDraft: vi.fn(),
  duplicateRunbook: vi.fn(),
  validateRunbook: vi.fn(),
  previewRunbookMatch: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', () => ({
  getRunbookDetail: mocks.getRunbookDetail,
  getRunbookVersion: mocks.getRunbookVersion,
  createRunbook: mocks.createRunbook,
  saveRunbookDraft: mocks.saveRunbookDraft,
  duplicateRunbook: mocks.duplicateRunbook,
  validateRunbook: mocks.validateRunbook,
  previewRunbookMatch: mocks.previewRunbookMatch,
  discardRunbookDraft: vi.fn(),
  submitRunbookForReview: vi.fn(),
  publishRunbook: vi.fn(),
  rejectRunbook: vi.fn(),
  retireRunbook: vi.fn(),
  restoreRunbook: vi.fn(),
  markRunbookReviewed: vi.fn(),
  restoreRunbookVersionAsDraft: vi.fn(),
  exportRunbookMarkdown: vi.fn(),
  testRunbookLookup: vi.fn(),
}));

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: (resource: string, action: string) => mocks.grants.has(`${resource}:${action}`) };
});

import { TooltipProvider } from '@/ui/tooltip';
import { RunbookEditor } from '@/soc/runbooks/editor/RunbookEditor';
import { makeBuiltinDetail, makeDefinition, makeDetail, makeVersion } from '@/soc/runbooks/editor/__tests__/fixtures';

function renderEditor(props: Partial<React.ComponentProps<typeof RunbookEditor>> = {}) {
  const onOpenRunbook = vi.fn();
  render(
    <TooltipProvider>
      <RunbookEditor runbookId="my-runbook" library={[]} onOpenRunbook={onOpenRunbook} onBackToLibrary={vi.fn()} {...props} />
    </TooltipProvider>,
  );
  return { onOpenRunbook };
}

beforeEach(() => {
  mocks.grants = new Set(['runbooks:read', 'runbooks:manage', 'runbooks:publish', 'cases:read']);
  for (const fn of [
    mocks.getRunbookDetail,
    mocks.getRunbookVersion,
    mocks.createRunbook,
    mocks.saveRunbookDraft,
    mocks.duplicateRunbook,
    mocks.validateRunbook,
    mocks.previewRunbookMatch,
  ]) {
    fn.mockReset();
  }
  mocks.getRunbookDetail.mockResolvedValue(makeDetail());
  mocks.validateRunbook.mockResolvedValue({ issues: [], prompt_chars: 900, prompt_budget: 3_000 });
  mocks.previewRunbookMatch.mockResolvedValue({
    considered: 2,
    window_label: 'Last 30 days',
    gets_it: [
      {
        case_id: 'c1',
        case_number: 'CASE-000214',
        title: 'SSH spray',
        explanation: { tier: 3, matched: [{ criterion: 'rule_ids', value: 'ssh_auth_failed' }], missed: [], tie: false },
      },
    ],
    another_wins: [],
    near_misses: [
      {
        case_id: 'c2',
        case_number: 'CASE-000215',
        title: 'Low noise',
        failed: [{ criterion: 'severity_at_least', expected: 'medium', actual: 'low' }],
      },
    ],
    counts: { gets_it: 1, another_wins: 0, near_misses: 1 },
    truncated: false,
  });
});

describe('managing procedures in the runbook editor', () => {
  it('opens a bundled runbook read only, shows its Markdown and offers Duplicate to customise', async () => {
    mocks.getRunbookDetail.mockResolvedValue(makeBuiltinDetail());
    renderEditor({ runbookId: 'brute-force-password-spray' });
    expect(await screen.findByText(/Built-in runbooks are read only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Duplicate to customise' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    const source = screen.getByLabelText('Markdown') as HTMLTextAreaElement;
    expect(source).toHaveAttribute('readonly');
    expect(source.value).toContain('id: brute-force-password-spray');
  });

  it('saves an operator runbook at the revision it was opened at and shows what the server stored', async () => {
    const stored = makeDetail({
      revision: 8,
      draft: makeVersion(3, 'draft', makeDefinition({ title: 'Stored by the server' })),
    });
    mocks.saveRunbookDraft.mockResolvedValue(stored);
    renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Password spray response' });
    fireEvent.click(screen.getByRole('treeitem', { name: /Runbook details/ }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Typed here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveRunbookDraft).toHaveBeenCalledWith('my-runbook', expect.objectContaining({ expected_revision: 7 })));
    await waitFor(() => expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Stored by the server'));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('takes a slug id from the title and refuses a reserved one', async () => {
    renderEditor({ runbookId: 'new' });
    const title = screen.getByLabelText(/^Title/);
    fireEvent.change(title, { target: { value: 'Mail: reported phishing!' } });
    expect((screen.getByLabelText(/^Id/) as HTMLInputElement).value).toBe('mail-reported-phishing');
    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: 'metrics' } });
    expect(await screen.findByText('The id metrics is reserved. Choose another.')).toBeInTheDocument();
    fireEvent.change(title, { target: { value: 'Something else' } });
    expect((screen.getByLabelText(/^Id/) as HTMLInputElement).value).toBe('metrics');
  });

  it('keeps a create authoritative without a follow-up read', async () => {
    const created = makeDetail();
    renderEditor({ runbookId: 'my-runbook', initialDetail: created });
    expect(await screen.findByRole('heading', { level: 1, name: 'Password spray response' })).toBeInTheDocument();
    expect(mocks.getRunbookDetail).not.toHaveBeenCalled();
  });

  it('hides every management control without runbooks:manage', async () => {
    mocks.grants = new Set(['runbooks:read']);
    renderEditor();
    expect(await screen.findByText('You can view this runbook but not change it.')).toBeInTheDocument();
    for (const name of ['Save draft', 'Send for review', 'Publish', 'Duplicate to customise', 'Add condition']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Add step/ })).toBeNull();
  });

  it('explains the deterministic selection and the criterion that failed', async () => {
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Which cases would this match\?/ }, { timeout: 3000 }));
    const sheet = await screen.findByRole('dialog');
    await within(sheet).findByText('CASE-000214');
    expect(within(sheet).getByText('Matched rule ssh_auth_failed.')).toBeInTheDocument();
    expect(within(sheet).getByText('Severity low is below medium.')).toBeInTheDocument();
    expect(within(sheet).getByText('Last 30 days, 2 cases checked against this version.')).toBeInTheDocument();
  });
});
