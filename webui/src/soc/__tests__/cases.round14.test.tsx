/**
 * Cases in the Overview's grammar (Round 14, SPEC §4.9.4, operator choices C7 1 and C8 1).
 *
 * Pins the page's structure: the header is the title, a help tip, ONE count and Refresh
 * (no breadcrumb, no icon chip, no description line); one KPI strip splits the loaded
 * cases by state and then, after the strong rule, by severity; the "Case queue" panel
 * holds one filter bar (search, three primary filters, More filters, removable chips)
 * and the table; a truncated list says so in a warning callout; the Demo note is said
 * once beside the panel title, never on every row; below 768px the table becomes Case
 * Manager's list rows with a "Filters" sheet; and the page's own copy carries no em dash
 * and never the word "playbook".
 *
 * Fully mocked (offline); nothing here touches #3 runtime behaviour.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listCasesMock, demoState, progressMock, caseActionMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  demoState: { active: false },
  progressMock: vi.fn(),
  caseActionMock: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', () => ({ getRunbookProgress: progressMock }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({
        org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '',
        accent_color: '', accent_color2: '', theme: '', login_subtitle: '',
      }),
      prefs: {
        effective: ok({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: {}, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        }),
        putUser: ok({}),
      },
      views: { list: ok({ views: [], count: 0 }) },
      demo: {
        status: vi.fn(async () =>
          demoState.active
            ? { mode: 'live', active: true, run_id: 'run-1' }
            : { mode: 'off', active: false, run_id: null },
        ),
      },
      listCases: listCasesMock,
      caseActionExec: caseActionMock,
      cases: { bulk: vi.fn().mockResolvedValue({ results: [] }) },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases from '../pages/Cases';

const CASES = [
  { case_id: 'c-1', case_number: 'CASE-000001', title: 'Brute force on vpn', status: 'investigating', risk_score: 90, assignee: 'dsingh', updated_at: '2026-06-29T03:00:00Z', tags: [], comments: [] },
  { case_id: 'c-2', case_number: 'CASE-000002', title: 'Phishing link clicked', status: 'open', risk_score: 60, updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
  { case_id: 'c-3', case_number: 'CASE-000003', title: 'Noisy scanner', status: 'closed', risk_score: 10, decision_by: 'agent', verdict: 'FALSE_POSITIVE', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
];

const PHONE = '(max-width: 767.98px)';

function mockViewport(phone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: phone && query === PHONE,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderCases() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Cases />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

/** Console-authored copy rules (SPEC §3.1): no em dash, no en dash as punctuation, no "playbook". */
function expectPlainCopy(text: string) {
  expect(text).not.toMatch(/\u2014/);
  expect(text).not.toMatch(/\s–\s/);
  expect(text).not.toMatch(/playbook/i);
}

beforeEach(() => {
  listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
  progressMock.mockReset().mockResolvedValue({});
  caseActionMock.mockReset().mockResolvedValue({});
  demoState.active = false;
  window.localStorage.clear();
  window.location.hash = '#/cases';
  mockViewport(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cases: the page header (C8 1)', () => {
  it('is the title, a help tip, one count and Refresh, with nothing above or below the title', async () => {
    renderCases();
    await screen.findByText('Brute force on vpn');
    const h1 = screen.getByRole('heading', { level: 1, name: 'Cases' });
    const header = h1.closest('[data-page-header]') as HTMLElement;
    expect(header).toHaveAttribute('data-page-header', 'page');
    // The explanation is the help tip beside the title, not a line under it.
    expect(within(header).getByRole('button', { name: 'About Cases' })).toBeInTheDocument();
    expect(header.querySelector('p')).toBeNull();
    // No breadcrumb, overline or back link.
    expect(within(header).queryByRole('navigation')).toBeNull();
    expect(header.querySelector('[data-page-header-back]')).toBeNull();
    // The controls slot: the one count of the page, and the header Refresh.
    const controls = header.querySelector('[data-page-header-controls]') as HTMLElement;
    expect(within(controls).getByTestId('cases-count-total')).toHaveTextContent('3 cases · all time');
    expect(within(controls).getByRole('button', { name: 'Refresh cases' })).toHaveAttribute('data-refresh-display', 'icon');
  });

  it('refreshes from the header', async () => {
    const user = userEvent.setup();
    renderCases();
    await screen.findByText('Brute force on vpn');
    listCasesMock.mockClear();
    await user.click(screen.getByRole('button', { name: 'Refresh cases' }));
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith({ limit: 200 }));
  });
});

describe('Cases: the KPI strip', () => {
  it('splits the loaded cases by state, then by severity after the strong rule', async () => {
    renderCases();
    await screen.findByText('Brute force on vpn');
    const strip = screen.getByRole('group', { name: 'Case summary' });
    expect(strip).toHaveAttribute('data-kpi-strip', 'comfortable');
    const toggles = within(strip).getAllByRole('button');
    expect(toggles.map((b) => b.querySelector('span')?.textContent?.trim())).toEqual([
      'Active',
      'Resolved or closed',
      'Needs human',
      'Critical',
      'High',
      'Medium',
      'Low',
    ]);
    // The severity split starts with the strong structural rule.
    expect(screen.getByTestId('kpi-cases-summary-critical')).toHaveAttribute('data-kpi-break', '');
    expect(screen.getByTestId('kpi-cases-summary-open')).not.toHaveAttribute('data-kpi-break');
    // Each tile says what share of the loaded cases it counts.
    expect(screen.getByTestId('cases-summary-open')).toHaveTextContent('67% of 3');
    expect(screen.getByTestId('cases-summary-terminal')).toHaveTextContent('33% of 3');
    expect(screen.getByTestId('cases-summary-needs-human')).toHaveTextContent('awaiting an analyst');
    expect(screen.getByTestId('cases-summary-critical')).toHaveTextContent('33% of 3');
    // No icons on the strip's tiles.
    expect(strip.querySelector('svg')).toBeNull();
  });

  it('a tile is a keyboard toggle that filters the list', async () => {
    const user = userEvent.setup();
    renderCases();
    await screen.findByText('Brute force on vpn');
    const critical = screen.getByTestId('kpi-cases-summary-critical');
    act(() => critical.focus());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(critical).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByText('Phishing link clicked')).toBeNull();
    // The panel counts what the filter shows, and the chip names it.
    expect(screen.getByRole('region', { name: 'Case queue' })).toHaveTextContent('1 of 3 shown');
    expect(screen.getByRole('button', { name: 'Remove filter: Severity: Critical' })).toBeInTheDocument();
    await user.keyboard(' ');
    await waitFor(() => expect(critical).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByText('Phishing link clicked')).toBeInTheDocument();
  });
});

describe('Cases: the Case queue panel', () => {
  it('holds one filter bar and the table, and counts nothing while no filter narrows it', async () => {
    renderCases();
    await screen.findByText('Brute force on vpn');
    const queue = screen.getByRole('region', { name: 'Case queue' });
    expect(queue).toHaveClass('surface-panel');
    expect(queue).not.toHaveTextContent(/shown/);
    const bar = within(queue).getByRole('group', { name: 'Case filters' });
    expect(within(bar).getByRole('searchbox', { name: 'Search cases' })).toHaveAttribute(
      'placeholder',
      'Search by ID, title, entity, rule or tag',
    );
    // Three primary filters in the bar, the rest behind More filters.
    for (const name of ['Filter by status', 'Filter by severity', 'Filter by assignee']) {
      expect(within(bar).getByRole('combobox', { name })).toBeInTheDocument();
    }
    expect(within(bar).queryByRole('combobox', { name: 'Filter by rule' })).toBeNull();
    expect(within(bar).getByRole('button', { name: /more filters/i })).toBeInTheDocument();
    // The table bleeds to the panel edge.
    expect(within(queue).getByRole('table', { name: 'Cases' }).closest('[data-surface]')).toHaveAttribute(
      'data-surface',
      'panel',
    );
  });

  it('shows each filter as a removable chip, and Clear all clears them', async () => {
    const user = userEvent.setup();
    renderCases();
    await screen.findByText('Brute force on vpn');
    await user.click(screen.getByRole('combobox', { name: 'Filter by assignee' }));
    await user.click(await screen.findByRole('option', { name: 'dsingh' }));
    expect(await screen.findByRole('button', { name: 'Remove filter: Assignee: dsingh' })).toBeInTheDocument();
    expect(screen.queryByText('Phishing link clicked')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(await screen.findByText('Phishing link clicked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove filter/ })).toBeNull();
  });

  it('says Demo once beside the panel title, never SAMPLE on every row', async () => {
    demoState.active = true;
    listCasesMock.mockResolvedValue({
      cases: CASES.map((c) => ({ ...c, case_id: `demo-${c.case_id}`, tags: ['demo'] })),
      total: CASES.length,
    });
    renderCases();
    await screen.findByText('Brute force on vpn');
    const queue = screen.getByRole('region', { name: 'Case queue' });
    const title = within(queue).getByRole('heading', { level: 2, name: 'Case queue' });
    const row = title.closest('[data-panel-title-row]') as HTMLElement;
    expect(within(row).getByText('Demo')).toHaveAttribute('title', expect.stringMatching(/^Demo data/));
    expect(within(queue).getAllByText('Demo')).toHaveLength(1);
    expect(screen.queryByText('SAMPLE')).toBeNull();
  });

  it('says when only the newest cases are loaded, in a warning', async () => {
    listCasesMock.mockImplementation(async (query: Record<string, unknown> = {}) =>
      query.limit === 1 ? { cases: [], total: 10 } : { cases: CASES, total: 300 },
    );
    renderCases();
    await screen.findByText('Brute force on vpn');
    expect(screen.getByTestId('cases-count-total')).toHaveTextContent('Newest 3 of 300 cases');
    // A live condition: the warning callout (a polite status), not a permanent box.
    const title = screen.getByText('Showing the newest 3 of 300 cases');
    expect(title.closest('[role="status"]')).toHaveTextContent('Filters work on the loaded cases.');
  });

  it('keeps the Ask AI chip clear of the case number, the row\'s open target', async () => {
    renderCases();
    await screen.findByText('Brute force on vpn');
    const table = screen.getByRole('table', { name: 'Cases' });
    const idButton = within(table).getByRole('button', { name: 'CASE-000001' });
    const chip = within(table).getByRole('button', { name: /Ask AI about CASE-000001/ });
    // Never inside the id button, and never drawn over it: the chip sits in the cell's
    // trailing padding, flush with its edge, and the id stops 8px short of the content box.
    expect(idButton.contains(chip)).toBe(false);
    expect(chip.className).toMatch(/(^|\s)-right-4(\s|$)/);
    expect(chip.className).not.toMatch(/(^|\s)right-0(\s|$)/);
    expect(chip.className).not.toMatch(/\bbg-panel\b/);
    expect(idButton.className).toContain('max-w-[calc(100%-0.5rem)]');
    // The cell skips the shared one-line clip, which would cut a chip in the padding.
    expect(chip.closest('[data-truncated-text]')).toBeNull();
    // The column is 120px wide (SPEC §4.9.4).
    expect(within(table).getByRole('columnheader', { name: /Case ID/ })).toHaveStyle({ width: '7.5rem' });
  });

  it('keeps an Active row compact: the Close button stays out of the row\'s flow', async () => {
    renderCases();
    await screen.findByText('Brute force on vpn');
    expect(screen.getByRole('button', { name: 'Close CASE-000001' }).className).toMatch(/(^|\s)-my-1(\s|$)/);
  });

  it('keeps its own copy plain: no em dash, no "playbook"', async () => {
    renderCases();
    await screen.findByText('Brute force on vpn');
    expectPlainCopy(document.body.textContent ?? '');
    for (const el of Array.from(document.querySelectorAll('[aria-label], [title]'))) {
      expectPlainCopy(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`);
    }
  });
});

describe('Cases: closing a case with runbook steps open (D34)', () => {
  it('the row close reads the case\'s runbook progress and sends the reason with the close', async () => {
    progressMock.mockResolvedValue({ 'c-2': { total: 5, done: 1, required_open: 2 } });
    const user = userEvent.setup();
    renderCases();
    await screen.findByText('Phishing link clicked');
    await user.click(screen.getByRole('button', { name: 'Close CASE-000002' }));
    const dialog = await screen.findByTestId('bulk-close-dialog');
    await waitFor(() => expect(progressMock).toHaveBeenCalledWith(['c-2'], expect.anything()));
    expect(await within(dialog).findByText('This case has required runbook steps open.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /false positive/i }));
    await user.type(
      within(dialog).getByLabelText(/why are you closing with required steps open/i),
      'Contained at the edge already',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Close 1 case' }));
    await waitFor(() =>
      expect(caseActionMock).toHaveBeenCalledWith(
        'c-2',
        expect.objectContaining({
          action: 'close',
          disposition: 'false_positive',
          disposition_declared: true,
          open_steps_reason: 'Contained at the edge already',
        }),
      ),
    );
  });

  it('the bulk close covers the selected cases (their progress is read once)', async () => {
    const user = userEvent.setup();
    renderCases();
    await screen.findByText('Phishing link clicked');
    await user.click(screen.getByLabelText('Select all cases on this page'));
    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    await user.click(within(bar).getByRole('button', { name: 'Close' }));
    await screen.findByTestId('bulk-close-dialog');
    await waitFor(() => expect(progressMock).toHaveBeenCalledWith(['c-1', 'c-2', 'c-3'], expect.anything()));
  });
});

describe('Cases: load states', () => {
  it('a failed load says so with Retry and no strip', async () => {
    listCasesMock.mockRejectedValue(new Error('down'));
    renderCases();
    expect(await screen.findByText('Could not load cases')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Case summary' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Case queue' })).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('an empty store offers to connect a source', async () => {
    listCasesMock.mockResolvedValue({ cases: [], total: 0 });
    renderCases();
    expect(await screen.findByText('No cases yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a source' })).toBeInTheDocument();
    expect(screen.getByTestId('cases-count-total')).toHaveTextContent('0 cases · all time');
  });
});

describe('Cases: phone width (below 768px)', () => {
  beforeEach(() => mockViewport(true));

  it('lists cases as Case Manager rows, with one Filters sheet', async () => {
    const user = userEvent.setup();
    renderCases();
    const list = await screen.findByRole('list', { name: 'Cases' });
    expect(screen.queryByRole('table')).toBeNull();
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(3);
    // Number, severity, age; the title; the status and the owner.
    expect(rows[0]).toHaveTextContent('CASE-000001');
    expect(rows[0]).toHaveTextContent('Critical');
    expect(rows[0]).toHaveTextContent('Brute force on vpn');
    expect(rows[0]).toHaveTextContent('Investigating');
    expect(rows[0]).toHaveTextContent('dsingh');
    expect(rows[1]).toHaveTextContent('Unassigned');
    // One toolbar row: the search and "Filters".
    expect(screen.getByRole('searchbox', { name: 'Search cases' })).toHaveAttribute('placeholder', 'Search cases');
    expect(screen.queryByRole('combobox', { name: 'Filter by status' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByRole('combobox', { name: 'Filter by status' })).toBeInTheDocument();
    expect(within(sheet).getByRole('group', { name: 'Saved view' })).toBeInTheDocument();
  });

  it('opens a case from its row', async () => {
    const user = userEvent.setup();
    renderCases();
    const list = await screen.findByRole('list', { name: 'Cases' });
    await user.click(within(list).getAllByRole('button')[1]);
    expect(await screen.findByTestId('case-manager-handoff')).toHaveTextContent('Opening CASE-000002');
  });

  it('shows the strip as compact tiles with no strong rule between two tiles of one row', async () => {
    renderCases();
    await screen.findByRole('list', { name: 'Cases' });
    const strip = screen.getByRole('group', { name: 'Case summary' });
    expect(strip).toHaveAttribute('data-kpi-strip', 'compact');
    expect(strip.querySelector('[data-kpi-break]')).toBeNull();
  });

  it('grows the list one page at a time', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      case_id: `c-${i}`,
      case_number: `CASE-${String(i).padStart(6, '0')}`,
      title: `Case ${i}`,
      status: 'open',
      risk_score: 30,
      updated_at: new Date(Date.UTC(2026, 5, 29, 0, i)).toISOString(),
      tags: [],
      comments: [],
    }));
    listCasesMock.mockResolvedValue({ cases: many, total: many.length });
    const user = userEvent.setup();
    renderCases();
    const list = await screen.findByRole('list', { name: 'Cases' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Show more (10 left)' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(60);
    expect(screen.queryByRole('button', { name: /^Show more/ })).toBeNull();
  });
});
