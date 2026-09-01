/**
 * Cases — the summary strip (the Cortex-XSIAM / Prisma "incident count band").
 *
 * A compact band of at-a-glance triage tiles under the header: three lifecycle-status
 * tiles (Active / Terminal / Needs human) + the four severity-band tiles (Critical /
 * High / Medium / Low). Each tile counts over the LOADED set and, when clicked, TOGGLES
 * the matching facet filter (severity band or status), narrowing the list.
 * `aria-pressed` reflects the active state so a second click clears it.
 *
 * The `__terminal__` facet is covered here end to end — chip, narrowing, and (the part
 * that fails SILENTLY when it is missed) survival of the `healFilters` self-heal pass
 * that runs after every load. A sentinel absent from that allow-list is reset to ANY on
 * arrival, so the operator sees EVERY case under a chip that still reads "Terminal".
 *
 * Fully mocked (offline); the narrowing is client-side over the loaded rows and never
 * touches #3 runtime behaviour.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// scoreBand (palette.ts): 74-100 critical · 48-73 high · 22-47 medium · 0-21 low.
const CASES = [
  { case_id: 'c-crit', case_number: 'T-1', title: 'CritCase', status: 'open', risk_score: 90, updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'c-high', case_number: 'T-2', title: 'HighCase', status: 'investigating', risk_score: 60, updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'c-med', case_number: 'T-3', title: 'MedCase', status: 'investigating', verdict: 'NEEDS_HUMAN', risk_score: 30, updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
  { case_id: 'c-low', case_number: 'T-4', title: 'LowCase', status: 'closed', risk_score: 10, updated_at: '2026-06-29T03:00:00Z', tags: [], comments: [] },
  // TERMINAL IS TWO STATUSES. Without a `resolved` row in this fixture the whole suite
  // stayed green with `isTerminalCase` narrowed to the single literal 'closed' — the
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

const tile = (testId: string) => screen.getByTestId(testId);

describe('Cases — summary strip', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
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
    // Tiles are toggle buttons — none pressed on first load.
    expect(tile('cases-summary-critical')).toHaveAttribute('aria-pressed', 'false');
  });

  it('a severity tile toggles the severity filter, narrowing then restoring the list', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    // Click Critical → only the critical (risk 90) case remains.
    fireEvent.click(tile('cases-summary-critical'));
    await waitFor(() =>
      expect(tile('cases-summary-critical')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('CritCase')).toBeInTheDocument();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('MedCase')).toBeNull();
    expect(screen.queryByText('LowCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();

    // Click again → the filter clears and every case comes back.
    fireEvent.click(tile('cases-summary-critical'));
    await waitFor(() =>
      expect(tile('cases-summary-critical')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByText('HighCase')).toBeInTheDocument();
    expect(screen.getByText('LowCase')).toBeInTheDocument();
  });

  it('the Active status tile narrows to every non-terminal lifecycle state', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    fireEvent.click(tile('cases-summary-open'));
    await waitFor(() =>
      expect(tile('cases-summary-open')).toHaveAttribute('aria-pressed', 'true'),
    );
    // Open, investigating, and needs_human survive; BOTH terminal statuses drop.
    expect(screen.getByText('CritCase')).toBeInTheDocument();
    expect(screen.getByText('HighCase')).toBeInTheDocument();
    expect(screen.getByText('MedCase')).toBeInTheDocument();
    expect(screen.queryByText('LowCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();
  });

  it('the Terminal tile narrows to BOTH terminal statuses, not one of them', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('CritCase')).toBeInTheDocument());

    fireEvent.click(tile('cases-summary-terminal'));
    await waitFor(() =>
      expect(tile('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'true'),
    );
    // BOTH terminal rows survive. This is the assertion that kills the mutant: the
    // tile COUNT is derived from `!isActiveCase`, so narrowing `isTerminalCase` to the
    // single literal 'closed' leaves the tile still reading 2 while the list drops the
    // resolved row — a count and a list that disagree, under one chip.
    expect(screen.getByText('LowCase')).toBeInTheDocument();
    expect(screen.getByText('ResolvedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('MedCase')).toBeNull();
    // …and the status control NAMES the facet that is applied. A missing
    // <SelectItem value="__terminal__"> renders an EMPTY trigger (Radix shows no
    // placeholder for a non-empty unmatched value) while the list stays narrowed.
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Terminal');
  });

  it('the __terminal__ facet survives healFilters on arrival AND across a reload', async () => {
    // Arrive from the Resolved / Closed drill-through. `healFilters` runs after every
    // completed load and drops any status value the loaded rows do not carry — and
    // `__terminal__` is a VIRTUAL facet that will never be in that list. Without the
    // sentinel allow-list this silently resets to ANY and shows all four cases under a
    // chip that still reads pressed.
    renderCases({ initialStatus: '__terminal__' });
    await waitFor(() => expect(screen.getByText('LowCase')).toBeInTheDocument());
    await waitFor(() =>
      expect(tile('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('ResolvedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    // The Select must offer the virtual facet as an OPTION too, or the trigger renders
    // blank while the filter is still applied.
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Terminal');

    // A second completed load re-runs the heal. The facet must still be standing.
    listCasesMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(listCasesMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('LowCase')).toBeInTheDocument());
    expect(tile('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('ResolvedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Terminal');

    // Clearing returns the control to its ANY label — the other half of the contract.
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    await waitFor(() =>
      expect(tile('cases-summary-terminal')).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByLabelText('Filter by status').textContent).toBe('All statuses');
  });

  it('the Needs human tile follows the verdict on modern lifecycle states', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('MedCase')).toBeInTheDocument());

    fireEvent.click(tile('cases-summary-needs-human'));
    await waitFor(() =>
      expect(tile('cases-summary-needs-human')).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByText('MedCase')).toBeInTheDocument();
    expect(screen.queryByText('CritCase')).toBeNull();
    expect(screen.queryByText('HighCase')).toBeNull();
    expect(screen.queryByText('LowCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();
  });
});
