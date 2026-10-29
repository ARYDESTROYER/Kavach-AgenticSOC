/**
 * Cases page controls.
 *
 *  - One sort (Round 14, SPEC §4.9.4, C7): the Updated column header orders the list,
 *    newest first by default, and toggles both ways; the separate "Newest first" button
 *    is gone.
 *  - The row Close affordance: named for the case number ("Close TLSOC-001"), absent on
 *    a closed or resolved case (nothing to close), and focus returns to it.
 *  - #0: the floating bulk-action bar is portaled to <body> so its `position: fixed`
 *    anchors to the viewport instead of being captured by the page's `@container`
 *    (PageContainer) ancestor.
 *
 * Fully mocked (offline); no #3 / runtime behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';

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

const CASES = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo', status: 'open', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
];

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

describe('Cases controls', () => {
  beforeEach(() => {
    vi.useRealTimers();
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
    window.location.hash = '#/cases';
  });

  it('sorts by the Updated header, newest first, both ways, with no second sort control', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const titles = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => (row.textContent?.includes('Alpha') ? 'Alpha' : row.textContent?.includes('Bravo') ? 'Bravo' : '?'));
    const updated = () => screen.getByRole('columnheader', { name: /updated/i });

    // Default: newest activity first (Bravo was updated an hour after Alpha).
    expect(updated()).toHaveAttribute('aria-sort', 'descending');
    expect(titles()).toEqual(['Bravo', 'Alpha']);
    expect(screen.queryByRole('button', { name: /sort by updated time/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /newest first|oldest first/i })).toBeNull();

    // The header flips it, and flips it back.
    fireEvent.click(within(updated()).getByRole('button'));
    expect(updated()).toHaveAttribute('aria-sort', 'ascending');
    expect(titles()).toEqual(['Alpha', 'Bravo']);
    fireEvent.click(within(updated()).getByRole('button'));
    expect(updated()).toHaveAttribute('aria-sort', 'descending');
    expect(titles()).toEqual(['Bravo', 'Alpha']);
  });

  it('offers Close on each open case, named for its number, and none on a closed one', async () => {
    listCasesMock.mockResolvedValue({
      cases: [
        ...CASES,
        { case_id: 'case-003', case_number: 'TLSOC-003', title: 'Charlie', status: 'closed', updated_at: '2026-06-28T00:00:00Z', tags: [], comments: [] },
        { case_id: 'case-004', case_number: 'TLSOC-004', title: 'Delta', status: 'resolved', updated_at: '2026-06-27T00:00:00Z', tags: [], comments: [] },
      ],
      total: 4,
    });
    renderCases();
    await waitFor(() => expect(screen.getByText('Charlie')).toBeInTheDocument());
    // One "Close <case number>" control per OPEN row (a reversible close, not a delete).
    const closeButtons = screen.getAllByRole('button', { name: /^close tlsoc-/i });
    expect(closeButtons.map((b) => b.getAttribute('aria-label'))).toEqual(['Close TLSOC-002', 'Close TLSOC-001']);
    expect(screen.queryByRole('button', { name: 'Close TLSOC-003' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close TLSOC-004' })).toBeNull();
  });

  it('returns focus to the row Close button when its close dialog is dismissed, not <body>', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const closeButton = screen.getByRole('button', { name: 'Close TLSOC-001' });
    act(() => closeButton.focus());
    fireEvent.click(closeButton);
    const dialog = await screen.findByTestId('bulk-close-dialog');
    // It opens on the required disposition (CM-3), not a control under the footer.
    await waitFor(() => expect(dialog.querySelector('[role="radiogroup"]')?.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('bulk-close-dialog')).toBeNull());
    await waitFor(() => expect(closeButton).toHaveFocus());
  });

  it('renders the bulk action bar via a portal to <body>, outside the @container (#0)', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Select all rows'));
    const bar = await screen.findByRole('region', { name: /bulk actions/i });

    // Portaled out: no `@container` (container-type: inline-size) ancestor captures the
    // fixed positioning, and the bar lives directly under <body>.
    expect(bar.closest('[class~="@container"]')).toBeNull();
    expect(document.body.contains(bar)).toBe(true);
  });

  it('announces a short handoff, then opens the exact case in Case Manager', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: 'TLSOC-001' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Taking you to Case Manager…');
    expect(status).toHaveTextContent('Opening TLSOC-001');
    expect(screen.getByRole('progressbar', { name: 'Opening selected case in Case Manager' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/cases');

    act(() => vi.advanceTimersByTime(499));
    expect(window.location.hash).toBe('#/cases');
    act(() => vi.advanceTimersByTime(1));

    expect(window.location.hash).toBe('#/case_manager?caseId=case-001');
    expect(screen.queryByTestId('case-manager-handoff')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
