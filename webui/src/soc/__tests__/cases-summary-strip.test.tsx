/**
 * Cases: the summary strip (Round 14, SPEC §4.9.2 KpiStrip on a panel, C7 option 1).
 *
 * One KPI strip under the header: three lifecycle-status tiles (Active / Resolved or
 * closed / Needs human), then, after the strong rule, the four severity-band tiles
 * (Critical / High / Medium / Low). Each tile counts over the LOADED set and, when
 * clicked, TOGGLES the matching facet filter (severity band or status), narrowing the
 * list. `aria-pressed` on the tile's button reflects the active state so a second click
 * clears it; the tile's cell carries the hover title that states the count's basis.
 *
 * The `__terminal__` facet is covered here end to end: chip, narrowing, and (the part
 * that fails SILENTLY when it is missed) survival of the `healFilters` self-heal pass
 * that runs after every load. A sentinel absent from that allow-list is reset to ANY on
 * arrival, so the operator sees EVERY case under a chip that still reads "Terminal".
 *
 * Fully mocked (offline); the narrowing is client-side over the loaded rows and never
 * touches #3 runtime behaviour.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

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

// Reduced motion for the tiles' numerals (see `preferReducedMotion` below).
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => true,
}));

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
import { REDUCED_MOTION_QUERY } from '../hooks/usePrefersReducedMotion';

// scoreBand (palette.ts): 74-100 critical · 48-73 high · 22-47 medium · 0-21 low.
const CASES = [
  { case_id: 'c-crit', case_number: 'T-1', title: 'CritCase', status: 'open', risk_score: 90, updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'c-high', case_number: 'T-2', title: 'HighCase', status: 'investigating', risk_score: 60, updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'c-med', case_number: 'T-3', title: 'MedCase', status: 'investigating', verdict: 'NEEDS_HUMAN', risk_score: 30, updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
  { case_id: 'c-low', case_number: 'T-4', title: 'LowCase', status: 'closed', risk_score: 10, updated_at: '2026-06-29T03:00:00Z', tags: [], comments: [] },
  // TERMINAL IS TWO STATUSES. Without a `resolved` row in this fixture the whole suite
  // stayed green with `isTerminalCase` narrowed to the single literal 'closed': the
  // precise regression the `__terminal__` facet exists to prevent had no guard anywhere.
  { case_id: 'c-res', case_number: 'T-5', title: 'ResolvedCase', status: 'resolved', risk_score: 12, updated_at: '2026-06-29T04:00:00Z', tags: [], comments: [] },
];

function renderCases(props: React.ComponentProps<typeof Cases> = {}) {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Cases {...props} />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

/** The tile's cell: its text and the hover title that states the count's basis. */
const tile = (testId: string) => screen.getByTestId(testId);
/** The tile's toggle button (KpiTile's `kpi-<testId>` anchor): `aria-pressed`, clicks. */
const toggle = (testId: string) => screen.getByTestId(`kpi-${testId}`);

/**
 * The tiles' numerals roll when a count changes: the lazy motion spring (AnimatedNumber),
 * or its CountUp fallback while that chunk loads. Under reduced motion both snap to the
 * target, so these tests read the count the page settles on, never the animation's
 * timing (which depends on machine load). CountUp reads the console's own media query
 * (stubbed below); AnimatedNumber reads motion's `useReducedMotion`, mocked here because
 * the real hook also prints a development advisory when reduce is on, which the strict
 * test lane counts as output. Every other media query (the phone breakpoint among them)
 * stays unmatched: a desktop.
 */
function preferReducedMotion(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  );
}

describe('Cases: summary strip', () => {
  beforeEach(() => {
    preferReducedMotion();
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the seven triage tiles with counts derived from the loaded set', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    // Three lifecycle-status tiles: Active (3 non-terminal) · Terminal (2: one closed,
    // one resolved) · Needs human (1). Active and Terminal are exact complements over
    // the loaded set, so their counts must add up to it.
    expect(within(tile('cases-summary-open')).getByText('3')).toBeInTheDocument();
    expect(within(tile('cases-summary-terminal')).getByText('2')).toBeInTheDocument();
    expect(within(tile('cases-summary-needs-human')).getByText('1')).toBeInTheDocument();
    // Four severity-band tiles: one case each in critical/high/medium, two in low.
    for (const id of ['critical', 'high', 'medium']) {
      expect(within(tile(`cases-summary-${id}`)).getByText('1')).toBeInTheDocument();
    }
    expect(within(tile('cases-summary-low')).getByText('2')).toBeInTheDocument();
    // Tiles are toggle buttons; none is pressed on first load.
    expect(toggle('cases-summary-critical')).toHaveAttribute('aria-pressed', 'false');
  });

  it('a severity tile toggles the severity filter, narrowing then restoring the list', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    // Click Critical → only the critical (risk 90) case remains.
    fireEvent.click(toggle('cases-summary-critical'));
    await waitFor(() =>
      expect(toggle('cases-summary-critical')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('CritCase')).toBeInTheDocument();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('MedCase')).toBeNull();
    expect(screen.queryByText('LowCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();

    // Click again → the filter clears and every case comes back.
    fireEvent.click(toggle('cases-summary-critical'));
    await waitFor(() =>
      expect(toggle('cases-summary-critical')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByText('HighCase')).toBeInTheDocument();
    expect(screen.getByText('LowCase')).toBeInTheDocument();
  });

  it('the Active status tile narrows to every non-terminal lifecycle state', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    fireEvent.click(toggle('cases-summary-open'));
    await waitFor(() =>
      expect(toggle('cases-summary-open')).toHaveAttribute('aria-pressed', 'true'),
    );
    // Open, investigating, and needs_human survive; BOTH terminal statuses drop.
    expect(screen.getByText('CritCase')).toBeInTheDocument();
    expect(screen.getByText('HighCase')).toBeInTheDocument();
    expect(screen.getByText('MedCase')).toBeInTheDocument();
    expect(screen.queryByText('LowCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();
  });

  it('the Resolved or closed tile narrows to BOTH terminal statuses, not one of them', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    fireEvent.click(toggle('cases-summary-terminal'));
    await waitFor(() =>
      expect(toggle('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'true'),
    );
    // BOTH terminal rows survive. This is the assertion that kills the mutant: the
    // tile COUNT is derived from `!isActiveCase`, so narrowing `isTerminalCase` to the
    // single literal 'closed' leaves the tile still reading 2 while the list drops the
    // resolved row: a count and a list that disagree, under one chip.
    expect(screen.getByText('LowCase')).toBeInTheDocument();
    expect(screen.getByText('ResolvedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('MedCase')).toBeNull();
    // …and the status control NAMES the facet that is applied. A missing
    // <SelectItem value="__terminal__"> renders an EMPTY trigger (Radix shows no
    // placeholder for a non-empty unmatched value) while the list stays narrowed.
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Resolved or closed');
  });

  it('the __terminal__ facet survives healFilters on arrival AND across a reload', async () => {
    // Arrive from the Resolved / Closed drill-through. `healFilters` runs after every
    // completed load and drops any status value the loaded rows do not carry, and
    // `__terminal__` is a VIRTUAL facet that will never be in that list. Without the
    // sentinel allow-list this silently resets to ANY and shows all four cases under a
    // chip that still reads pressed.
    renderCases({ initialStatus: '__terminal__' });
    await waitFor(() => expect(screen.getByText('LowCase')).toBeInTheDocument());
    await waitFor(() =>
      expect(toggle('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('ResolvedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    // The Select must offer the virtual facet as an OPTION too, or the trigger renders
    // blank while the filter is still applied.
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Resolved or closed');

    // A second completed load re-runs the heal. The facet must still be standing.
    listCasesMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('LowCase')).toBeInTheDocument());
    expect(toggle('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('ResolvedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Resolved or closed');

    // Clearing returns the control to its ANY label: the other half of the contract.
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    await waitFor(() =>
      expect(toggle('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByLabelText('Filter by status').textContent).toBe('All statuses');
  });

  it('the Needs human tile follows the verdict on modern lifecycle states', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('MedCase')).toBeInTheDocument());

    fireEvent.click(toggle('cases-summary-needs-human'));
    await waitFor(() =>
      expect(toggle('cases-summary-needs-human')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('MedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('LowCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();
  });

  it('Needs human counts only OPEN cases: a closed NEEDS_HUMAN case is settled (D15)', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        ...CASES,
        // The analyst's bug: a NEEDS_HUMAN case closed as false positive still counted.
        {
          case_id: 'c-settled', case_number: 'T-6', title: 'SettledCase', status: 'closed',
          verdict: 'NEEDS_HUMAN', decision_by: 'analyst', disposition: 'false_positive',
          risk_score: 20, updated_at: '2026-06-29T05:00:00Z', tags: [], comments: [],
          history: [{ event: 'analyst_action', action: 'close', analyst: 'a', classified_disposition: 'false_positive' }],
        },
      ],
      total: CASES.length + 1,
    });
    renderCases();
    await waitFor(() => expect(screen.getByText('SettledCase')).toBeInTheDocument());
    expect(within(tile('cases-summary-needs-human')).getByText('1')).toBeInTheDocument();

    fireEvent.click(toggle('cases-summary-needs-human'));
    await waitFor(() => expect(screen.queryByText('SettledCase')).toBeNull());
    expect(screen.getByText('MedCase')).toBeInTheDocument();
  });

  it('a truncated list shows exact SERVER totals on the lifecycle tiles and labels the severity tiles as loaded-only', async () => {
    // The analyst's deployment: the newest cases are mostly closed, so the loaded slice
    // read "Active 1 · Needs human 0" while hundreds of open cases waited.
    listCasesMock.mockImplementation(async (query: Record<string, unknown> = {}) => {
      // Needs human = |status needs_human| + |active ∧ verdict NEEDS_HUMAN| − |both|
      // = 40 + 60 − 33 = 67, every half a STRUCTURED filter (never the text search).
      if (query.limit === 1 && query.status === 'needs_human' && query.verdict === 'NEEDS_HUMAN') return { cases: [], total: 33 };
      if (query.limit === 1 && query.status === 'needs_human') return { cases: [], total: 40 };
      if (query.limit === 1 && query.status_group === 'active' && query.verdict === 'NEEDS_HUMAN') return { cases: [], total: 60 };
      if (query.limit === 1 && query.status_group === 'active') return { cases: [], total: 68 };
      if (query.limit === 1 && query.status_group === 'terminal') return { cases: [], total: 252 };
      return { cases: CASES, total: 320 };
    });
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    await waitFor(() => expect(within(tile('cases-summary-open')).getByText('68')).toBeInTheDocument());
    // Each numeral moves from the loaded count to the server total once its count arrives.
    expect(await within(tile('cases-summary-terminal')).findByText('252')).toBeInTheDocument();
    expect(await within(tile('cases-summary-needs-human')).findByText('67')).toBeInTheDocument();
    // …each says how many of them the loaded list (what a click filters) can show.
    expect(tile('cases-summary-open')).toHaveTextContent('3 loaded');
    expect(tile('cases-summary-needs-human')).toHaveTextContent('1 loaded');
    // Severity tiles still count the loaded slice, and now say so on the tile itself.
    expect(tile('cases-summary-critical')).toHaveTextContent('of 5 loaded');
    expect(listCasesMock).toHaveBeenCalledWith(expect.objectContaining({ status_group: 'active', verdict: 'NEEDS_HUMAN', limit: 1 }));
    // The free-text search is never used for a count: its haystack also matches titles,
    // summaries, entity values and assignees ("needs_human_rota"), so it over-counts.
    expect(listCasesMock).not.toHaveBeenCalledWith(expect.objectContaining({ q: expect.anything() }));
    // The tooltip agrees in number with what it counts.
    expect(tile('cases-summary-needs-human')).toHaveAttribute(
      'title',
      '67 active cases awaiting an analyst in total; 1 of them is among the 5 loaded cases this list filters',
    );
  });

  it('the Needs human server total falls back to the loaded count when any structured count fails', async () => {
    listCasesMock.mockImplementation(async (query: Record<string, unknown> = {}) => {
      if (query.limit === 1 && query.verdict === 'NEEDS_HUMAN' && query.status === 'needs_human') throw new Error('down');
      if (query.limit === 1 && query.status === 'needs_human') return { cases: [], total: 40 };
      if (query.limit === 1 && query.verdict === 'NEEDS_HUMAN') return { cases: [], total: 60 };
      if (query.limit === 1 && query.status_group === 'active') return { cases: [], total: 1 };
      if (query.limit === 1 && query.status_group === 'terminal') return { cases: [], total: 252 };
      return { cases: CASES, total: 320 };
    });
    renderCases();
    await waitFor(() => expect(within(tile('cases-summary-open')).getByText('1')).toBeInTheDocument());
    // Singular noun for a total of one.
    expect(tile('cases-summary-open')).toHaveAttribute(
      'title',
      '1 active case in total; 3 of them are among the 5 loaded cases this list filters',
    );
    // No exact total is claimed: the tile shows the loaded count and says it is loaded-only.
    // The three structured counts settle on their own, so wait for them too.
    await waitFor(() => expect(tile('cases-summary-needs-human')).toHaveTextContent('of 5 loaded'));
    expect(within(tile('cases-summary-needs-human')).getByText('1')).toBeInTheDocument();
  });

  it('a complete list keeps exact loaded counts and asks the server nothing more', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());
    // No loaded-only note: the context line is the tile's share of the loaded cases.
    expect(tile('cases-summary-open')).toHaveTextContent('60% of 5');
    expect(tile('cases-summary-open')).not.toHaveTextContent('loaded');
    expect(listCasesMock).toHaveBeenCalledTimes(1);
  });
});
