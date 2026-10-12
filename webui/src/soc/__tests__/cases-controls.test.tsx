/**
 * Cases page controls (round-6 cases-page findings #0/#6).
 *
 *  - #6: the updated-time sort control is a TRUE two-way toggle (the old button only
 *    ever set asc, so once "Oldest first" was on there was no button back to newest).
 *  - #0: the floating bulk-action bar is portaled to <body> so its `position: fixed`
 *    anchors to the viewport instead of being captured by the page's `@container`
 *    (PageContainer) ancestor.
 *
 * Fully mocked (offline); no #3 / runtime behaviour touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';

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

describe('Cases controls (round-6 #0/#6)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
    window.location.hash = '#/cases';
  });

  it('sort direction is a true two-way toggle with a way back to newest (#6)', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const toggle = () => screen.getByRole('button', { name: /sort by updated time/i });

    // Default: newest first (updated_at desc) — label reflects the current order.
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle()).toHaveTextContent(/newest first/i);

    // Click → oldest first.
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()).toHaveTextContent(/oldest first/i);

    // Click again → BACK to newest (the old control could not do this).
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle()).toHaveTextContent(/newest first/i);
  });

  it('renders a per-row Close affordance when permitted (auth off → cases:close) (#4/#5)', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    // One "Close case {id}" control per row (reversible close — not a delete).
    const closeButtons = screen.getAllByRole('button', { name: /close case/i });
    expect(closeButtons.length).toBe(CASES.length);
  });

  it('returns focus to the row Close button when its close dialog is dismissed, not <body>', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const closeButton = screen.getAllByRole('button', { name: /close case/i })[0];
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
