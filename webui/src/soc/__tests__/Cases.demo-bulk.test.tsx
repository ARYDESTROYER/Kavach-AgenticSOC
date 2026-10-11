/**
 * Cases — bulk changes in Demo Mode (Round 12, WP-CM).
 *
 * Bulk changes run as durable background jobs and the server refuses those in Demo
 * Mode, so the bulk bar says so up front and disables its actions (Clear still works)
 * instead of letting the analyst fill a dialog that can only fail.
 *
 * (Setup shared with the Round-7 polish spec:)
 *
 * Two behaviours:
 *  1. CASES_DEFAULT_HIDDEN: when the user has NEVER customized the table (no stored
 *     ColumnState), the curated secondary columns (disposition/alerts/playbooks/
 *     enrichments/category/urgency) open hidden while the dominant signal columns
 *     (Status/Severity/Confidence/Verdict/Risk) stay visible. Any stored state wins
 *     verbatim (the default no longer applies).
 *  2. AutoClosedBadge cell: an AI-closed case (terminal status + decision_by='agent')
 *     shows "Auto-closed by AI" in its Status cell; an analyst-closed one does not.
 *
 * Fully mocked (offline); nothing here touches #3 runtime behaviour.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { listCasesMock, prefsState } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  // Mutable so a test can seed a STORED per-table column state (proving the curated
  // default only applies when nothing is stored).
  prefsState: { tables: {} as Record<string, unknown> },
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
        effective: vi.fn().mockImplementation(async () => ({
          terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [],
          tables: prefsState.tables, last_list_state: {}, misc: {},
          org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] },
        })),
        putUser: ok({}),
        tables: { put: ok({}) },
      },
      views: { list: ok({ views: [], count: 0 }) },
      demo: { status: ok({ mode: 'live', active: true, run_id: 'run-1' }) },
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

describe('Cases bulk bar in Demo Mode', () => {
  it('explains that bulk changes are off and disables the actions, keeping Clear', async () => {
    listCasesMock.mockReset().mockResolvedValue({
      cases: [
        {
          case_id: 'case-demo-1',
          case_number: 'DEMO-1',
          title: 'Demo case one',
          status: 'open',
          verdict: 'NEEDS_HUMAN',
          risk_score: 40,
          updated_at: '2026-10-10T10:00:00Z',
        },
      ],
      total: 1,
    });
    renderCases();
    await screen.findByText('Demo case one');
    const row = screen.getByText('Demo case one').closest('tr') as HTMLElement;
    fireEvent.click(row.querySelector('button[role="checkbox"]') as HTMLElement);
    const note = await screen.findByTestId('cases-bulk-demo-note');
    expect(note).toHaveTextContent('Bulk changes are off in Demo Mode.');
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    await waitFor(() =>
      expect(bar.querySelector('button[disabled]')).not.toBeNull(),
    );
    const clear = Array.from(bar.querySelectorAll('button')).find((b) => /clear/i.test(b.textContent || ''));
    expect(clear).toBeDefined();
    expect(clear).not.toBeDisabled();
  });
});
