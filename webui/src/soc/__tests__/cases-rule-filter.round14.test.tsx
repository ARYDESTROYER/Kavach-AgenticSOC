/**
 * Cases: the Rule filter (Round 14, SPEC §4.6.6). The rule sheet's "Show the N cases"
 * opens `#/cases?rule=<value>`; the page reads it (or the `initialRule` prop), asks the
 * server for exactly that rule's cases (`GET /api/cases?rule=`), keeps only cases that
 * carry the value byte for byte, and shows it in a "Filter by rule" control that can go
 * back to "All rules". A rule with spaces and other letters round-trips through the hash.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listCasesMock } = vi.hoisted(() => ({ listCasesMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
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
      demo: { status: ok({ mode: 'off', active: false, run_id: null }) },
      listCases: listCasesMock,
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

import { pageHash } from '../router';

const RULE = 'Fehlgeschlagene Anmeldung über SSH';
const CASES = [
  { case_id: 'c-1', case_number: 'T-1', title: 'SshCase', status: 'open', risk_score: 60, rule_ids: [RULE], updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'c-2', case_number: 'T-2', title: 'NearCase', status: 'open', risk_score: 60, rule_ids: [`${RULE} 2`], updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'c-3', case_number: 'T-3', title: 'WebCase', status: 'open', risk_score: 60, rule_ids: ['web_scan'], updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
];

function renderCases(props?: { initialRule?: string; initialAssignee?: string }) {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Cases initialRule={props?.initialRule} initialAssignee={props?.initialAssignee} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('Cases: the Rule filter (Round 14)', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
    window.location.hash = '';
  });

  it('asks the server for exactly the rule and keeps only its cases', async () => {
    renderCases({ initialRule: RULE });
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith({ limit: 200, rule: RULE }));
    expect(await screen.findByText('SshCase')).toBeInTheDocument();
    // Exact: a rule that only starts with the value is another rule.
    expect(screen.queryByText('NearCase')).toBeNull();
    expect(screen.queryByText('WebCase')).toBeNull();
    const control = screen.getByRole('combobox', { name: 'Filter by rule' });
    expect(control).toHaveTextContent(RULE);
    expect(control).toHaveAttribute('title', RULE);
  });

  it('reads the rule from the hash, byte for byte', async () => {
    window.location.hash = pageHash('cases', { rule: RULE });
    renderCases();
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith({ limit: 200, rule: RULE }));
    expect(await screen.findByText('SshCase')).toBeInTheDocument();
  });

  it('goes back to every rule from the control', async () => {
    const user = userEvent.setup();
    renderCases({ initialRule: RULE });
    await screen.findByText('SshCase');
    await user.click(screen.getByRole('combobox', { name: 'Filter by rule' }));
    await user.click(await screen.findByRole('option', { name: 'All rules' }));
    await waitFor(() => expect(listCasesMock).toHaveBeenLastCalledWith({ limit: 200 }));
    expect(await screen.findByText('WebCase')).toBeInTheDocument();
    expect(screen.getByText('NearCase')).toBeInTheDocument();
  });

  it('offers the rules of the loaded cases and filters by the one chosen', async () => {
    const user = userEvent.setup();
    renderCases();
    await screen.findByText('WebCase');
    await user.click(screen.getByRole('combobox', { name: 'Filter by rule' }));
    await user.click(await screen.findByRole('option', { name: 'web_scan' }));
    await waitFor(() => expect(listCasesMock).toHaveBeenLastCalledWith({ limit: 200, rule: 'web_scan' }));
    await waitFor(() => expect(screen.queryByText('SshCase')).toBeNull());
    expect(screen.getByText('WebCase')).toBeInTheDocument();
  });

  it('never shows an earlier read\'s server totals on the tiles of a newer rule', async () => {
    // Deferred `limit: 1` count reads, keyed by the rule they were asked for.
    type Deferred = { resolve: (total: number) => void };
    const pending = new Map<string, Deferred[]>();
    listCasesMock.mockReset().mockImplementation((query: Record<string, unknown>) => {
      const rule = typeof query.rule === 'string' ? query.rule : '';
      if (query.limit === 1) {
        return new Promise((resolve) => {
          const list = pending.get(rule) ?? [];
          list.push({ resolve: (total) => resolve({ cases: [], total }) });
          pending.set(rule, list);
        });
      }
      // Both lists are truncated (more cases than the 200 loaded), so the tiles read the
      // server totals.
      return Promise.resolve(
        rule
          ? { cases: CASES.filter((c) => c.rule_ids.includes(rule)), total: 500 }
          : { cases: CASES, total: 5000 },
      );
    });
    const resolveAll = (rule: string, total: number) => {
      for (const d of pending.get(rule) ?? []) d.resolve(total);
      pending.delete(rule);
    };
    const activeCount = () =>
      screen.getByTestId('cases-summary-open').querySelector('.text-lg')?.textContent;

    const user = userEvent.setup();
    renderCases();
    await screen.findByText('WebCase');
    await waitFor(() => expect(pending.get('')?.length).toBe(5));

    // Choose a rule while every-rule totals are still being counted.
    await user.click(screen.getByRole('combobox', { name: 'Filter by rule' }));
    await user.click(await screen.findByRole('option', { name: 'web_scan' }));
    await waitFor(() => expect(screen.queryByText('SshCase')).toBeNull());
    await waitFor(() => expect(pending.get('web_scan')?.length).toBe(5));

    // The every-rule totals arrive last: they never reach the rule's tiles.
    resolveAll('', 4000);
    await new Promise((r) => setTimeout(r, 0));
    expect(activeCount()).toBe('1');
    expect(screen.queryByText('4,000')).toBeNull();

    // The rule's own totals do.
    resolveAll('web_scan', 450);
    await waitFor(() => expect(activeCount()).toBe('450'));
  });

  it('reads a rule that matches nothing as a filter with no results, not an empty console', async () => {
    listCasesMock.mockReset().mockImplementation((query: Record<string, unknown>) =>
      Promise.resolve(typeof query.rule === 'string' ? { cases: [], total: 0 } : { cases: CASES, total: CASES.length }),
    );
    const user = userEvent.setup();
    renderCases({ initialRule: 'No such rule' });
    expect(await screen.findByText('No cases from this rule')).toBeInTheDocument();
    expect(screen.queryByText('No cases yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect a source' })).toBeNull();
    // The figures say what they cover: this rule's cases, not the console's.
    expect(screen.getByTestId('cases-count-total')).toHaveTextContent('0 from this rule');
    expect(screen.getByTestId('cases-summary-open')).toHaveAttribute('title', 'Among 0 cases from the rule No such rule');
    await user.click(screen.getByRole('button', { name: 'All rules' }));
    await waitFor(() => expect(listCasesMock).toHaveBeenLastCalledWith({ limit: 200 }));
    expect(await screen.findByText('WebCase')).toBeInTheDocument();
    expect(screen.getByTestId('cases-count-total')).toHaveTextContent('3 total');
  });

  it('labels the badge and tiles with the rule a filtered list was read for', async () => {
    listCasesMock.mockReset().mockImplementation((query: Record<string, unknown>) =>
      Promise.resolve(
        typeof query.rule === 'string'
          ? { cases: CASES.filter((c) => c.rule_ids.includes(query.rule as string)), total: 1 }
          : { cases: CASES, total: CASES.length },
      ),
    );
    renderCases({ initialRule: RULE });
    await screen.findByText('SshCase');
    expect(screen.getByTestId('cases-count-total')).toHaveTextContent('1 from this rule');
    expect(screen.getByTestId('cases-count-total')).toHaveAttribute('title', `1 case from the rule ${RULE}`);
    expect(screen.getByTestId('cases-summary-critical')).toHaveAttribute('title', `Among 1 case from the rule ${RULE}`);
  });

  describe('with the other filters', () => {
    // SshCase (the rule's only case) is bob's; WebCase is alice's, closed as a false positive.
    const OWNED = [
      { ...CASES[0], assignee: 'bob' },
      { ...CASES[2], assignee: 'alice', disposition: 'false_positive' },
    ];
    const readByRule = (rows: typeof OWNED) => (query: Record<string, unknown>) => {
      const found = typeof query.rule === 'string' ? rows.filter((c) => c.rule_ids.includes(query.rule as string)) : rows;
      return Promise.resolve({ cases: found, total: found.length });
    };
    const choose = async (user: ReturnType<typeof userEvent.setup>, control: string, option: string | RegExp) => {
      await user.click(screen.getByRole('combobox', { name: control }));
      await user.click(await screen.findByRole('option', { name: option }));
    };

    it('keeps the Assignee a rule\'s cases do not have, and its cases come back with every rule', async () => {
      listCasesMock.mockReset().mockImplementation(readByRule(OWNED));
      const user = userEvent.setup();
      renderCases();
      await screen.findByText('WebCase');
      await choose(user, 'Filter by assignee', 'alice');
      await waitFor(() => expect(screen.queryByText('SshCase')).toBeNull());

      // The rule's only case is bob's: no result, and the Assignee control still says alice.
      await choose(user, 'Filter by rule', RULE);
      await waitFor(() => expect(listCasesMock).toHaveBeenLastCalledWith({ limit: 200, rule: RULE }));
      expect(await screen.findByText('No cases match your filters')).toBeInTheDocument();
      expect(screen.queryByText('SshCase')).toBeNull();
      expect(screen.getByRole('combobox', { name: 'Filter by assignee' })).toHaveTextContent('alice');
      expect(screen.getByTestId('cases-count-total')).toHaveTextContent('1 from this rule');

      // Every rule again: alice's case is back, the filter never lost.
      await choose(user, 'Filter by rule', 'All rules');
      await waitFor(() => expect(listCasesMock).toHaveBeenLastCalledWith({ limit: 200 }));
      expect(await screen.findByText('WebCase')).toBeInTheDocument();
      expect(screen.queryByText('SshCase')).toBeNull();
      expect(screen.getByRole('combobox', { name: 'Filter by assignee' })).toHaveTextContent('alice');
    });

    it('keeps an Assignee that comes with a rule (a link or a saved view)', async () => {
      listCasesMock.mockReset().mockImplementation(readByRule(OWNED));
      renderCases({ initialRule: RULE, initialAssignee: 'alice' });
      await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith({ limit: 200, rule: RULE }));
      expect(await screen.findByText('No cases match your filters')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Filter by assignee' })).toHaveTextContent('alice');
    });

    it('keeps the Disposition control and its value when a rule has no case at all', async () => {
      // web_scan's read finds nothing (its cases were deleted since the list loaded).
      listCasesMock.mockReset().mockImplementation((query: Record<string, unknown>) =>
        query.rule === 'web_scan' ? Promise.resolve({ cases: [], total: 0 }) : readByRule(OWNED)(query),
      );
      const user = userEvent.setup();
      renderCases();
      await screen.findByText('WebCase');
      await choose(user, 'Filter by disposition', 'False positive');
      await choose(user, 'Filter by assignee', 'alice');
      await choose(user, 'Filter by rule', 'web_scan');
      expect(await screen.findByText('No cases from this rule')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Filter by disposition' })).toHaveTextContent('False positive');
      expect(screen.getByRole('combobox', { name: 'Filter by assignee' })).toHaveTextContent('alice');
      // The controls still offer every value the person could pick before the rule.
      await user.click(screen.getByRole('combobox', { name: 'Filter by assignee' }));
      expect(await screen.findByRole('option', { name: 'bob' })).toBeInTheDocument();
    });
  });

  it('ignores a rule value outside the grammar (never empties the list behind it)', async () => {
    renderCases({ initialRule: 'a\u202eb' });
    await waitFor(() => expect(listCasesMock).toHaveBeenCalledWith({ limit: 200 }));
    expect(await screen.findByText('WebCase')).toBeInTheDocument();
    expect(screen.getByText('SshCase')).toBeInTheDocument();
  });
});
