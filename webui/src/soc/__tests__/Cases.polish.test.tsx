/**
 * Cases: default columns and the one-badge status cell.
 *
 * Two behaviours:
 *  1. CASES_DEFAULT_HIDDEN (Round 14, SPEC §4.9.4, C7): when the user has NEVER
 *     customized the table (no stored ColumnState), the list opens on the columns a
 *     triage pass reads (Case ID, Title, Severity, Status, Outcome, Assignee, Updated) and
 *     the secondary signals and counts open hidden. Any stored state wins verbatim (the
 *     default no longer applies). The retired Playbooks count column never comes back.
 *  2. One status badge per row: who closed a case is the Outcome column's job, so an
 *     AI-closed case (terminal status + decision_by='agent') reads "Auto-closed" in its
 *     Outcome cell and an analyst-closed one does not.
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
const HIDDEN_HEADERS = ['Confidence', 'Verdict', 'Risk', 'Entity', 'Category', 'Urgency', 'Alerts', 'Enrichments'];
const KEPT_HEADERS = ['Case ID', 'Title', 'Severity', 'Status', 'Outcome', 'Assignee', 'Updated'];

describe('Cases: CASES_DEFAULT_HIDDEN (Round 14)', () => {
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
    // The triage columns are visible, in reading order…
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent?.trim() ?? '');
    const visible = headers.filter((text) => KEPT_HEADERS.includes(text));
    expect(visible).toEqual(KEPT_HEADERS);
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
    // The stored state arrives with the preferences read, which may settle after the
    // rows do (a loaded machine reorders them): wait for it rather than race it.
    for (const name of HIDDEN_HEADERS) {
      expect(
        await screen.findByRole('columnheader', { name: new RegExp(`^${name}`, 'i') }),
      ).toBeInTheDocument();
    }
    // Runbooks replaced playbooks (Round 14): the old count column is gone, even for a
    // stored state that still names it.
    expect(screen.queryByRole('columnheader', { name: /^playbooks/i })).toBeNull();
  });

  it('ignores a stored column state that still names the retired Playbooks column', async () => {
    prefsState.tables = { cases: { hidden: ['playbooks'], order: ['playbooks', 'case_id', 'title'] } };
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: /^playbooks/i })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /case id/i })).toBeInTheDocument();
  });
});

describe('Cases: one status badge, the closer in Outcome (Round 14)', () => {
  beforeEach(() => {
    prefsState.tables = {};
    window.localStorage.clear();
  });

  it('says "Auto-closed" in the Outcome cell of an agent-closed case, not an analyst-closed one', async () => {
    seed([
      {
        case_id: 'c-ai', case_number: 'T-AI', title: 'AiClosed', status: 'closed',
        decision_by: 'agent', verdict: 'FALSE_POSITIVE', risk_score: 30,
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

    // The agent-closed row says so in its Outcome cell…
    const aiOutcome = within(rowFor('AiClosed')).getByTestId('case-outcome');
    expect(aiOutcome).toHaveAttribute('data-outcome-source', 'agent_auto');
    expect(aiOutcome).toHaveTextContent(/^Auto-closed/);
    // Round 14: the table cell is the short label so it fits its column; the verdict it
    // closed on is in the tooltip and read to assistive technology.
    expect(aiOutcome).toHaveAttribute('title', 'Auto-closed as false positive');
    expect(aiOutcome).toHaveTextContent('Auto-closed, auto-closed as false positive');
    // …the analyst-closed row does NOT (a human/system close is not an AI auto-close).
    expect(within(rowFor('AnalystClosed')).queryByText(/Auto-closed/i)).toBeNull();
    // The Status cell holds the status alone: no second "Auto-closed by AI" badge.
    expect(screen.queryByText(/Auto-closed by AI/i)).toBeNull();
  });

  it('fits every settled outcome in its column: a short word, the whole outcome said (closing QA qa2-01)', async () => {
    seed([
      {
        case_id: 'c-unrec', case_number: 'T-UN', title: 'ClosedUnrecorded', status: 'closed',
        decision_by: 'analyst', risk_score: 30,
        updated_at: '2026-06-29T03:00:00Z', tags: [], comments: [],
      },
      {
        case_id: 'c-class', case_number: 'T-CL', title: 'ClosedClassified', status: 'closed',
        decision_by: 'analyst', disposition: 'false_positive', risk_score: 30,
        history: [{ event: 'analyst_action', action: 'confirm_fp', analyst: 'a', ts: '2026-06-29T02:00:00Z' }],
        updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [],
      },
      {
        case_id: 'c-policy', case_number: 'T-PO', title: 'ClosedByPolicy', status: 'closed',
        decision_by: 'analyst_policy', risk_score: 10,
        updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [],
      },
    ]);
    renderCases();
    await waitFor(() => expect(screen.getByText('ClosedUnrecorded')).toBeInTheDocument());

    // "Outcome not recorded" (163px) was cut at the 9.25rem column edge: the cell says
    // "Not recorded" and keeps the whole outcome in its tooltip and its read text.
    const unrecorded = within(rowFor('ClosedUnrecorded')).getByTestId('case-outcome');
    expect(unrecorded).toHaveAttribute('data-outcome-source', 'analyst_unrecorded');
    expect(unrecorded).toHaveAttribute('title', 'Closed by analyst: outcome not recorded');
    expect(unrecorded).toHaveTextContent('Not recorded, closed by analyst: outcome not recorded');
    expect(unrecorded).not.toHaveTextContent(/^Outcome not recorded/);

    // A human outcome is ONE badge with the Analyst glyph, never the separate tag that
    // pushed it past the column; the sentence says who.
    const classified = within(rowFor('ClosedClassified')).getByTestId('case-outcome');
    expect(classified).toHaveAttribute('data-provenance', 'analyst');
    expect(classified).toHaveTextContent(/^False positive/);
    expect(classified).toHaveAttribute('title', 'Closed as false positive by an analyst');
    const policy = within(rowFor('ClosedByPolicy')).getByTestId('case-outcome');
    expect(policy).toHaveAttribute('data-provenance', 'analyst');
    expect(policy).toHaveTextContent(/^Declared benign/);
    expect(policy).toHaveAttribute('title', 'Closed by analyst policy (declared benign)');

    // Every settled badge in the column is the table badge size of the Status column.
    for (const badge of screen.getAllByTestId('case-outcome')) {
      expect(badge).toHaveClass('px-1.5', 'text-2xs');
      expect(badge.querySelector('[data-provenance]')).toBeNull();
    }
  });

  it('says in its read text that an unclassified case shows the AI-mapped disposition (D15)', async () => {
    // The open case's "False positive" is the same table badge size as an analyst's
    // classification, so the attribution is read aloud too, never only in a mouse tooltip.
    seed([
      {
        case_id: 'c-open', case_number: 'T-OP', title: 'OpenMapped', status: 'open',
        verdict: 'FALSE_POSITIVE', disposition: 'false_positive', risk_score: 20,
        updated_at: '2026-06-29T04:00:00Z', tags: [], comments: [],
      },
      {
        case_id: 'c-class', case_number: 'T-CL', title: 'ClosedClassified', status: 'closed',
        decision_by: 'analyst', disposition: 'false_positive', risk_score: 30,
        history: [{ event: 'analyst_action', action: 'confirm_fp', analyst: 'a', ts: '2026-06-29T02:00:00Z' }],
        updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [],
      },
    ]);
    renderCases();
    await waitFor(() => expect(screen.getByText('OpenMapped')).toBeInTheDocument());

    const pending = within(rowFor('OpenMapped')).getByText(
      (_, el) => el?.getAttribute('data-outcome-source') === 'pending',
    );
    expect(within(rowFor('OpenMapped')).queryByTestId('case-outcome')).toBeNull();
    expect(pending).toHaveAttribute('title', 'Mapped from the AI verdict; no analyst has classified this case yet');
    expect(pending).toHaveTextContent(
      /^False positive, mapped from the AI verdict; no analyst has classified this case yet$/,
    );
    const note = pending.querySelector('.sr-only');
    expect(note).toHaveTextContent('mapped from the AI verdict');
    // The analyst's call on the same value says who made it instead.
    const classified = within(rowFor('ClosedClassified')).getByTestId('case-outcome');
    expect(classified).toHaveTextContent(/by an analyst/);
    expect(classified).not.toHaveTextContent(/AI verdict/);
  });

  it('never says "mapped from the AI verdict" when nothing was mapped', async () => {
    // `case_manager.apply()` maps a disposition only from a verdict, and only to one value
    // per verdict: a case the AI has not assessed shows "Undetermined" and must not claim
    // an AI mapping, a legacy case with a verdict but no disposition says so, and a value
    // that is not the verdict's mapping is said to be recorded on the case.
    seed([
      {
        case_id: 'c-new', case_number: 'T-NW', title: 'OpenUnassessed', status: 'open',
        verdict: null, disposition: null, risk_score: 20,
        updated_at: '2026-06-29T05:00:00Z', tags: [], comments: [],
      },
      {
        case_id: 'c-legacy', case_number: 'T-LG', title: 'OpenLegacy', status: 'open',
        verdict: 'TRUE_POSITIVE', disposition: null, risk_score: 70,
        updated_at: '2026-06-29T04:00:00Z', tags: [], comments: [],
      },
      {
        // Triage maps NEEDS_HUMAN to undetermined, never to suspicious: this value was set
        // on the case some other way (a Demo seed, an applied unlabelled value).
        case_id: 'c-set', case_number: 'T-ST', title: 'OpenRecorded', status: 'investigating',
        verdict: 'NEEDS_HUMAN', disposition: 'suspicious', risk_score: 62,
        updated_at: '2026-06-29T03:00:00Z', tags: [], comments: [],
      },
    ]);
    renderCases();
    await waitFor(() => expect(screen.getByText('OpenUnassessed')).toBeInTheDocument());

    const pendingCell = (title: string) =>
      within(rowFor(title)).getByText((_, el) => el?.getAttribute('data-outcome-source') === 'pending');

    const unassessed = pendingCell('OpenUnassessed');
    expect(unassessed).toHaveAttribute('title', 'Not yet assessed by the AI; no analyst has classified this case yet');
    expect(unassessed).toHaveTextContent(
      /^Undetermined, not yet assessed by the AI; no analyst has classified this case yet$/,
    );
    expect(unassessed).not.toHaveTextContent(/mapped from the AI verdict/i);

    const legacy = pendingCell('OpenLegacy');
    expect(legacy).toHaveAttribute('title', 'No outcome recorded yet; no analyst has classified this case yet');
    expect(legacy).toHaveTextContent(/^Undetermined, no outcome recorded yet; no analyst has classified this case yet$/);
    expect(legacy).not.toHaveTextContent(/mapped from the AI verdict/i);

    const recorded = pendingCell('OpenRecorded');
    expect(recorded).toHaveAttribute('title', 'Recorded on the case; no analyst has classified this case yet');
    expect(recorded).toHaveTextContent(/^Suspicious, recorded on the case; no analyst has classified this case yet$/);
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
