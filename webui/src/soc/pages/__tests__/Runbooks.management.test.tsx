/**
 * The Runbooks library (Round 14, SPEC §4.10.12): one table of the built-ins and the team's
 * runbooks with search, State and Origin filters; "No runbooks match these filters." with
 * Clear filters; New runbook and Import only with `runbooks:manage` (and never in Demo
 * Mode); the key-figure strip, "Rules with no runbook" and "Recent runs" from the
 * case-derived metrics, which say "You do not have access to cases." without the grant and
 * "Hidden while row-level scope is on." under row-level scope; the one-time migration
 * intro; a row opens the editor at `#/runbooks?id=<id>` through a real link. A figure is never
 * shown before it is known, a capped ledger reads as a floor, and the library is read again on
 * each return from the editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  demo: false,
  listRunbookLibrary: vi.fn(),
  getRunbookMetrics: vi.fn(),
  importRunbook: vi.fn(),
  exportRunbookMarkdown: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', () => ({
  listRunbookLibrary: mocks.listRunbookLibrary,
  getRunbookMetrics: mocks.getRunbookMetrics,
  importRunbook: mocks.importRunbook,
  exportRunbookMarkdown: mocks.exportRunbookMarkdown,
}));

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: (resource: string, action: string) => mocks.grants.has(`${resource}:${action}`) };
});

vi.mock('@/soc/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/demo')>();
  return { ...actual, useDemo: () => ({ status: 'off', active: mocks.demo, loading: false, confirmed: true, refresh: async () => 'off' }) };
});

vi.mock('@/soc/runbooks/editor/RunbookEditor', () => ({
  default: (props: {
    runbookId: string;
    seedRule?: string | null;
    initialDetail?: { revision: number } | null;
    initialEdits?: { definition: { summary: string } } | null;
    onOpenRunbook: (id: string, detail?: unknown, edits?: unknown) => void;
  }) => (
    <div
      data-testid="editor-stub"
      data-initial={props.initialDetail ? String(props.initialDetail.revision) : ''}
      data-edits={props.initialEdits ? props.initialEdits.definition.summary : ''}
    >
      {`editor ${props.runbookId}${props.seedRule ? ` for ${props.seedRule}` : ''}`}
      <button type="button" onClick={() => props.onOpenRunbook('created-one', CREATED)}>
        stub create
      </button>
      <button
        type="button"
        onClick={() =>
          props.onOpenRunbook('created-one', CREATED, {
            definition: { summary: 'Typed while creating' },
            source: null,
            selected: 'details',
          })
        }
      >
        stub create with edits
      </button>
    </div>
  ),
}));

import { ApiError } from '@/lib/api';
import type { RunbookMetrics } from '@/lib/types-runbooks';
import { RouterProvider } from '@/soc/router';
import { TooltipProvider } from '@/ui/tooltip';

import Runbooks, { PAGE_HELP, attachedBy, migrationText, nameLine, recentRunLine, stateText, stepsText } from '../Runbooks';
import { makeSummary } from '@/soc/runbooks/editor/__tests__/fixtures';

const LIBRARY = [
  makeSummary({ id: 'brute-force-password-spray', title: 'Brute force and password spray', origin: 'builtin', state: 'published', draft_version: null, live_version: 1 }),
  makeSummary({ id: 'phishing-triage', title: 'Phishing triage', origin: 'operator', state: 'draft', live_version: null, draft_version: 1, applies_to: { rule_ids: ['mail_reported_phish'], mitre: ['T1566'], more: 2 } }),
  makeSummary({ id: 'old-proc', title: 'Old procedure', origin: 'imported', state: 'in_review', in_review_version: 1, live_version: null, draft_version: null, review_due_at: '2026-01-01T00:00:00Z' }),
];

/** The detail a create returns (revision 1), handed to the editor of the new id. */
const CREATED = { summary: makeSummary({ id: 'created-one', title: 'Created one' }), live: null, draft: null, in_review: null, versions: [], open_runs_by_version: {}, revision: 1 };

const METRICS: RunbookMetrics = {
  window_label: 'Last 30 days',
  partial: false,
  per_runbook: [{ id: 'brute-force-password-spray', title: 'Brute force and password spray', started: 10, completed: 7, abandoned: 1, median_minutes_to_complete: 46 }],
  per_phase: [],
  per_step: [],
  coverage: { cases_with_run: 52, human_handled_cases: 73 },
  rules_without_runbook: [{ rule: 'vpn_auth_failed', cases: 4 }],
  cohorts: { with_completed_run: { cases: 7, mttr_p50_minutes: 30 }, without: { cases: 5, mttr_p50_minutes: 60 }, note: 'comparison, not cause' },
  recent_runs: [
    {
      run_id: 'run-1',
      case_id: 'c-214',
      case_number: 'CASE-000214',
      runbook_id: 'brute-force-password-spray',
      title: 'Brute force and password spray',
      version: 1,
      status: 'completed',
      attached_actor: 'agentic_soc',
      started_at: '2026-10-28T10:00:00Z',
      completed_at: '2026-10-28T10:46:00Z',
      duration_minutes: 46,
    },
  ],
};

function renderPage() {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <Runbooks />
      </RouterProvider>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '#/runbooks';
  mocks.grants = new Set(['runbooks:read', 'runbooks:manage', 'cases:read']);
  mocks.demo = false;
  mocks.listRunbookLibrary.mockReset().mockResolvedValue({ runbooks: LIBRARY, migration: null });
  mocks.getRunbookMetrics.mockReset().mockResolvedValue(METRICS);
  mocks.importRunbook.mockReset();
  mocks.exportRunbookMarkdown.mockReset();
});

afterEach(() => {
  window.location.hash = '';
});

describe('Runbooks library', () => {
  it('lists every runbook with its state, steps and review date under the page title', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Runbooks' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Runbooks' });
    expect(within(table).getByText('Brute force and password spray')).toBeInTheDocument();
    expect(within(table).getByText('Published v1')).toBeInTheDocument();
    expect(within(table).getByText('Draft v1')).toBeInTheDocument();
    expect(within(table).getByText('In review')).toBeInTheDocument();
    // Phases then steps on one line, as the SPEC words it.
    expect(within(table).getAllByText('2 phases · 3 steps').length).toBe(3);
    expect(within(table).getByText('+2')).toBeInTheDocument();
    // A long rule id is cut to the chip width, so the chip carries the whole id as its title.
    expect(within(table).getByText('mail_reported_phish')).toHaveAttribute('title', 'mail_reported_phish');
  });

  it('filters by search and state, and clears back to the full list', async () => {
    renderPage();
    await screen.findByText('Phishing triage');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runbooks' }), { target: { value: 'no such runbook' } });
    expect(await screen.findByText('No runbooks match these filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Phishing triage')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runbooks' }), { target: { value: 'T1566' } });
    const table = screen.getByRole('table', { name: 'Runbooks' });
    await waitFor(() => expect(within(table).queryByText('Brute force and password spray')).toBeNull());
    expect(within(table).getByText('Phishing triage')).toBeInTheDocument();
  });

  it('shows the key figures and the two case panels', async () => {
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Runbook figures' });
    await waitFor(() => expect(within(strip).getByText('71%')).toBeInTheDocument());
    expect(within(strip).getByText('52 of 73 human-handled cases')).toBeInTheDocument();
    expect(within(strip).getByText('1 review due · 1 in review')).toBeInTheDocument();
    const rules = screen.getByTestId('rules-without-runbook');
    expect(within(rules).getByText('vpn_auth_failed')).toBeInTheDocument();
    expect(within(rules).getByText('4 cases')).toBeInTheDocument();
    const runs = screen.getByTestId('recent-runs');
    expect(within(runs).getByText('CASE-000214')).toBeInTheDocument();
    expect(within(runs).getByText('Completed · Agentic SOC · 46m')).toBeInTheDocument();
  });

  it('says so when the caller cannot read cases, and the rest of the page works', async () => {
    mocks.grants = new Set(['runbooks:read']);
    renderPage();
    expect(await screen.findByText('Phishing triage')).toBeInTheDocument();
    expect(mocks.getRunbookMetrics).not.toHaveBeenCalled();
    expect(screen.getAllByText('You do not have access to cases.').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: 'New runbook' })).toBeNull();
  });

  it('hides the case figures under row-level scope', async () => {
    mocks.getRunbookMetrics.mockRejectedValue(
      new ApiError(409, 'Hidden while row-level scope is on.', { detail: { code: 'runbook_scope_unsupported', message: 'x' } }),
    );
    renderPage();
    expect((await screen.findAllByText('Hidden while row-level scope is on.')).length).toBeGreaterThanOrEqual(2);
  });

  it('offers New runbook and Import only with runbooks:manage and never in Demo Mode', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'New runbook' })).toBeInTheDocument();
    mocks.demo = true;
    const again = renderPage();
    await within(again.container).findByText('Runbooks cannot be edited in Demo Mode. The cases show Demo runs.');
    expect(within(again.container).queryByRole('button', { name: 'New runbook' })).toBeNull();
  });

  it('opens a runbook in the editor from its row, and New runbook for a rule from the panel', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('Phishing triage'));
    expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor phishing-triage');
    expect(window.location.hash).toBe('#/runbooks?id=phishing-triage');
  });

  it('names each runbook with a real link to its editor (a new tab works), with no separate open button', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Runbooks' });
    const link = within(table).getByRole('link', { name: 'Phishing triage' });
    expect(link).toHaveAttribute('href', '#/runbooks?id=phishing-triage');
    expect(within(table).queryByRole('button', { name: /^Open / })).toBeNull();
    // The muted line under the name: the origin and the summary, in plain words, no chip.
    expect(within(table).getByText('Built-in · Many failed sign-ins.')).toBeInTheDocument();
    fireEvent.click(link);
    expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor phishing-triage');
  });

  it('reads the library again on the way back from the editor, and never reopens a stale hand-over', async () => {
    renderPage();
    await screen.findByText('Phishing triage');
    expect(mocks.listRunbookLibrary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'New runbook' }));
    fireEvent.click(await screen.findByRole('button', { name: 'stub create' }));
    await waitFor(() => expect(window.location.hash).toBe('#/runbooks?id=created-one'));
    expect(screen.getByTestId('editor-stub')).toHaveAttribute('data-initial', '1');
    mocks.listRunbookLibrary.mockResolvedValue({ runbooks: [...LIBRARY, makeSummary({ id: 'created-one', title: 'Created one' })], migration: null });
    await act(async () => {
      window.location.hash = '#/runbooks';
    });
    expect(await screen.findByText('Created one')).toBeInTheDocument();
    expect(mocks.listRunbookLibrary).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.location.hash = '#/runbooks?id=created-one';
    });
    const stub = await screen.findByTestId('editor-stub');
    expect(stub).toHaveTextContent('editor created-one');
    expect(stub).toHaveAttribute('data-initial', '');
  });

  it('hands edits typed while a create ran to the new runbook once, and never on a later visit', async () => {
    renderPage();
    await screen.findByText('Phishing triage');
    fireEvent.click(screen.getByRole('button', { name: 'New runbook' }));
    expect(await screen.findByTestId('editor-stub')).toHaveAttribute('data-edits', '');
    fireEvent.click(screen.getByRole('button', { name: 'stub create with edits' }));
    await waitFor(() => expect(window.location.hash).toBe('#/runbooks?id=created-one'));
    const handed = screen.getByTestId('editor-stub');
    expect(handed).toHaveAttribute('data-initial', '1');
    expect(handed).toHaveAttribute('data-edits', 'Typed while creating');
    await act(async () => {
      window.location.hash = '#/runbooks';
    });
    await screen.findByText('Phishing triage');
    await act(async () => {
      window.location.hash = '#/runbooks?id=created-one';
    });
    expect(await screen.findByTestId('editor-stub')).toHaveAttribute('data-edits', '');
  });

  it('shows a loading tile, never a made-up figure, while the reads run', async () => {
    mocks.listRunbookLibrary.mockReturnValue(new Promise(() => undefined));
    mocks.getRunbookMetrics.mockReturnValue(new Promise(() => undefined));
    renderPage();
    const strip = screen.getByRole('group', { name: 'Runbook figures' });
    expect(within(strip).getAllByText('Loading')).toHaveLength(5);
    expect(within(strip).queryByText('0')).toBeNull();
    expect(within(strip).queryByText('Hidden')).toBeNull();
  });

  it('says a figure is unavailable when its read fails', async () => {
    mocks.listRunbookLibrary.mockRejectedValue(new ApiError(500, 'The runbook store is unavailable.'));
    mocks.getRunbookMetrics.mockRejectedValue(new ApiError(500, 'Could not read the run figures.'));
    renderPage();
    const strip = screen.getByRole('group', { name: 'Runbook figures' });
    await waitFor(() => expect(within(strip).getAllByText('Unavailable')).toHaveLength(5));
    expect(within(strip).getAllByText('The library could not be read.')).toHaveLength(2);
    expect(within(strip).queryByText('0')).toBeNull();
  });

  it('reads capped run counts as floors and says why', async () => {
    mocks.getRunbookMetrics.mockResolvedValue({ ...METRICS, partial: true });
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Runbook figures' });
    await waitFor(() => expect(within(strip).getAllByText('At least this many: some runs in this window are not counted.').length).toBeGreaterThan(0));
    expect(within(strip).getByText('at least 71%')).toBeInTheDocument();
    expect(screen.getByText('Run counts are lower bounds: some runs in this window are not counted.')).toBeInTheDocument();
  });

  it('never lets the Show replaced built-ins switch change the Published figure', async () => {
    const replaced = makeSummary({ id: 'old-builtin', title: 'Old built-in', origin: 'builtin', state: 'published', live_version: 1, draft_version: null, replaced_by: 'phishing-triage' });
    mocks.listRunbookLibrary.mockImplementation(async (query: { show_replaced?: boolean }) => ({
      runbooks: query?.show_replaced ? [...LIBRARY, replaced] : LIBRARY,
      migration: null,
    }));
    renderPage();
    const strip = await screen.findByRole('group', { name: 'Runbook figures' });
    await waitFor(() => expect(within(strip).getByText('1 built-in · 0 yours')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('switch', { name: 'Show replaced built-ins' }));
    expect(await screen.findByText('Old built-in')).toBeInTheDocument();
    expect(within(strip).getByText('1 built-in · 0 yours')).toBeInTheDocument();
    expect(screen.getByText(/Built-in · Replaced by your copy/)).toBeInTheDocument();
  });

  it('pins the definition as the page help, and lets the shared page rhythm space the page', async () => {
    expect(PAGE_HELP).toBe(
      "Runbooks are your team's step-by-step response procedures. The matching runbook is attached to each case that needs a person. Analysts work through it as a checklist; the AI runs the read-only lookups and can draft notes. A runbook never closes a case; your case policy does that.",
    );
    renderPage();
    await screen.findByText('Phishing triage');
    expect(screen.getByTestId('runbooks-library').className).not.toMatch(/space-y-/);
  });

  it('creates a runbook for a rule with no runbook', async () => {
    renderPage();
    const rules = await screen.findByTestId('rules-without-runbook');
    fireEvent.click(await within(rules).findByRole('button', { name: 'Create a runbook' }));
    expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor new for vpn_auth_failed');
  });

  it('introduces the converted procedures once, built from the migration counts', async () => {
    mocks.listRunbookLibrary.mockResolvedValue({
      runbooks: LIBRARY,
      migration: { completed_at: '2026-10-28T00:00:00Z', published: 9, draft: 1, skipped: 0 },
    });
    renderPage();
    expect(
      await screen.findByText(
        'Your 10 procedures from the previous version are now runbooks. 9 are published and due for review; 1 is a draft with problems to fix. The AI now reads each step’s title and focus line, so check each imported runbook.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show imported' }));
    await waitFor(() => expect(screen.queryByText('Phishing triage')).toBeNull());
    expect(screen.getByText('Old procedure')).toBeInTheDocument();
  });

  it('imports Markdown as a draft and opens it', async () => {
    mocks.importRunbook.mockResolvedValue({ summary: makeSummary({ id: 'imported-one' }), live: null, draft: null, in_review: null, versions: [], open_runs_by_version: {}, revision: 1 });
    renderPage();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Import Markdown' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Markdown'), { target: { value: '---\nid: imported-one\n---' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import as draft' }));
    await waitFor(() => expect(mocks.importRunbook).toHaveBeenCalledWith('---\nid: imported-one\n---'));
    expect(await screen.findByTestId('editor-stub')).toHaveTextContent('editor imported-one');
  });

  it('shows a load failure with Retry', async () => {
    mocks.listRunbookLibrary.mockRejectedValueOnce(new ApiError(503, 'The runbook store is unavailable.'));
    renderPage();
    expect(await screen.findByText('Could not load the runbooks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Phishing triage')).toBeInTheDocument();
  });

  it('uses no em dash and never the retired word', async () => {
    const { container } = renderPage();
    await screen.findByText('Phishing triage');
    expect(container.textContent).not.toMatch(/—/);
    expect(container.textContent).not.toMatch(/playbook/i);
  });
});

describe('recent runs wording', () => {
  it('names who attached a run in words, and formats the time it ran', () => {
    expect(attachedBy('runbook_selector')).toBe('Agentic SOC');
    expect(attachedBy('agentic_soc')).toBe('Agentic SOC');
    expect(attachedBy('threshold_automation')).toBe('A case-automation rule');
    expect(attachedBy('Admin')).toBe('Admin');
    expect(attachedBy('')).toBeNull();
    expect(recentRunLine({ status: 'in_progress', attached_actor: 'runbook_selector', duration_minutes: 130 })).toBe('In progress · Agentic SOC · 2h 10m');
    expect(recentRunLine({ status: 'abandoned', attached_actor: '', duration_minutes: null })).toBe('Closed early');
    expect(nameLine(makeSummary({ origin: 'imported', summary: 'Converted.' }))).toBe('Imported · Converted.');
  });
});

describe('library wording', () => {
  it('names states, steps and the migration counts in plain words', () => {
    expect(stateText(LIBRARY[0])).toBe('Published v1');
    expect(stepsText(makeSummary({ phases: ['triage'], step_count: 1 }))).toBe('1 phase · 1 step');
    expect(migrationText({ completed_at: null, published: 1, draft: 0, skipped: 2 })).toBe(
      'Your 1 procedure from the previous version is now a runbook. 1 is published and due for review. 2 could not be converted. The AI now reads each step’s title and focus line, so check each imported runbook.',
    );
    expect(migrationText({ completed_at: null, published: 0, draft: 0, skipped: 0 })).toBeNull();
  });
});
