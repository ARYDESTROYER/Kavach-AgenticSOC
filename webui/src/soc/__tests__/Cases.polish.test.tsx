/**
 * Cases — Round-7 #8 polish + #11 auto-closed cell (W1.C).
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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

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

type CaseRow = Record<string, unknown>;

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

function seed(cases: CaseRow[]) {
  listCasesMock.mockReset().mockResolvedValue({ cases, total: cases.length });
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('tr');
  if (!row) throw new Error(`row for ${title} not found`);
  return row;
}

// The curated default-hidden secondary columns + the dominant kept columns.
// Round 12 (D15): the analyst's outcome is visible by default — the old hidden
// "Disposition" column is now the shown "Outcome" column.
const HIDDEN_HEADERS = ['Alerts', 'Playbooks', 'Enrichments', 'Category', 'Urgency'];
const KEPT_HEADERS = ['Status', 'Severity', 'Confidence', 'Verdict', 'Risk', 'Outcome'];

describe('Cases — CASES_DEFAULT_HIDDEN (#8)', () => {
  beforeEach(() => {
    prefsState.tables = {};
    seed([
      { case_id: 'c-1', case_number: 'T-1', title: 'Alpha', status: 'open', risk_score: 80, updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
    ]);
    window.localStorage.clear();
  });

  it('opens with the curated secondary columns hidden when nothing is stored', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    // The dominant signal columns are visible…
    for (const name of KEPT_HEADERS) {
      expect(
        screen.getByRole('columnheader', { name: new RegExp(name, 'i') }),
      ).toBeInTheDocument();
    }
    // …and the curated secondary columns are hidden by default (reversible via Columns).
    for (const name of HIDDEN_HEADERS) {
      expect(
        screen.queryByRole('columnheader', { name: new RegExp(`^${name}`, 'i') }),
      ).toBeNull();
    }
  });

  it('respects a STORED column state verbatim (default no longer applies)', async () => {
    // The user has explicitly customized this table (empty hidden = show everything),
    // so the curated default must NOT re-hide the secondary columns.
    prefsState.tables = { cases: { hidden: [] } };
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    for (const name of HIDDEN_HEADERS) {
      expect(
        screen.getByRole('columnheader', { name: new RegExp(`^${name}`, 'i') }),
      ).toBeInTheDocument();
    }
  });
});

describe('Cases — AutoClosedBadge status cell (#11)', () => {
  beforeEach(() => {
    prefsState.tables = {};
    window.localStorage.clear();
  });

  it('shows "Auto-closed by AI" for an agent-closed case, not an analyst-closed one', async () => {
    seed([
      {
        case_id: 'c-ai', case_number: 'T-AI', title: 'AiClosed', status: 'closed',
        decision_by: 'agent', risk_score: 30,
        updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [],
      },
      {
        case_id: 'c-human', case_number: 'T-HU', title: 'AnalystClosed', status: 'closed',
        decision_by: 'analyst', risk_score: 30,
        updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [],
      },
    ]);
    renderCases();
    await waitFor(() => expect(screen.getByText('AiClosed')).toBeInTheDocument());

    // The agent-closed row carries the badge…
    expect(
      within(rowFor('AiClosed')).getByText(/Auto-closed by AI/i),
    ).toBeInTheDocument();
    // …the analyst-closed row does NOT (a human/system close is not an AI auto-close).
    expect(
      within(rowFor('AnalystClosed')).queryByText(/Auto-closed by AI/i),
    ).toBeNull();
    // Exactly one badge across the whole table.
    expect(screen.getAllByText(/Auto-closed by AI/i)).toHaveLength(1);
  });

  it('does not show the badge on a still-open agent case (non-terminal)', async () => {
    seed([
      {
        case_id: 'c-open', case_number: 'T-OP', title: 'OpenCase', status: 'open',
        decision_by: 'agent', risk_score: 30,
        updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [],
      },
    ]);
    renderCases();
    await waitFor(() => expect(screen.getByText('OpenCase')).toBeInTheDocument());
    expect(screen.queryByText(/Auto-closed by AI/i)).toBeNull();
  });
});
