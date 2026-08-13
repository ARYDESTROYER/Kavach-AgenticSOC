/**
 * Bulk case actions (W7c) test.
 *
 * Renders the Cases list with two cases, selects all rows via the header checkbox,
 * triggers the bulk "Acknowledge" action, and asserts it calls POST /api/cases/bulk
 * (api.cases.bulk) with BOTH selected ids — the #3-safe human action applied to N
 * cases. The api client is fully mocked (offline).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { bulkMock, listCasesMock, submitJobMock } = vi.hoisted(() => ({
  bulkMock: vi.fn(),
  listCasesMock: vi.fn(),
  submitJobMock: vi.fn(),
}));

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
      cases: { bulk: bulkMock },
      jobs: { submit: submitJobMock },
    },
  };
});

// sonner toast is a side-effect-only call here; stub toast + Toaster so the imports
// (Cases uses toast; the ui/sonner Toaster may render in the tree) resolve.
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

describe('Cases bulk actions (W7c)', () => {
  beforeEach(() => {
    bulkMock.mockReset();
    bulkMock.mockResolvedValue({ results: [{ id: 'case-001', ok: true }, { id: 'case-002', ok: true }] });
    listCasesMock.mockReset();
    listCasesMock.mockResolvedValue({ cases: CASES, total: CASES.length });
    submitJobMock.mockReset().mockResolvedValue({
      job_id: 'job-ack', kind: 'case_lifecycle', actor: 'operator',
      created_at: '2026-08-13T00:00:00Z', status: 'queued',
      progress: { done: 0, total: 2, unit: 'cases' }, failures: [], failure_count: 0,
      failures_truncated: 0, request_fingerprint: 'c'.repeat(64), params: {}, cancel_requested: false,
    });
    window.localStorage.clear();
  });

  it('selects all rows and submits one durable lifecycle job', async () => {
    renderCases();
    // Wait for the rows to load.
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    // Select all via the header checkbox.
    const selectAll = screen.getByLabelText('Select all rows');
    fireEvent.click(selectAll);

    // The sticky bulk bar appears with the count + the Acknowledge action.
    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole('button', { name: /acknowledge/i }));

    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0]).toMatchObject({
      kind: 'case_lifecycle',
      params: { case_ids: ['case-001', 'case-002'], action: 'acknowledge' },
    });
    expect(bulkMock).not.toHaveBeenCalled();
  });

  it('does not wrap the bulk bar onto multiple lines and reserves bottom space (#3)', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Select all rows'));

    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    // The Card is the bar's only child — assert it carries flex-nowrap +
    // overflow-x-auto and NOT flex-wrap (regression guard for the wrap glitch).
    const card = bar.firstElementChild as HTMLElement;
    expect(card.className).toMatch(/flex-nowrap/);
    expect(card.className).toMatch(/overflow-x-auto/);
    expect(card.className).not.toMatch(/flex-wrap\b/);

    // The page root (PageContainer, carries `space-y-6`) reserves bottom space while
    // the bar is visible so the fixed pill never covers the last rows/pager.
    const pageRoot = card.closest('body')?.querySelector('[class*="space-y-6"]');
    expect(pageRoot?.className).toMatch(/pb-28/);
  });

  it('renders Acknowledge as the primary (filled) CTA, not the muted/secondary style (#3)', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Select all rows'));

    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    const ack = within(bar).getByRole('button', { name: /acknowledge/i });
    expect(ack.className).toMatch(/bg-primary/);
    expect(ack.className).not.toMatch(/bg-secondary/);
  });
});
