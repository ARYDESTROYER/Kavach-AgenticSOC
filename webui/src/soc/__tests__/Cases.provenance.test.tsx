/**
 * Cases: per-row SEVERITY provenance, said by the chip (Round 14, SPEC §4.9.4, C7).
 *
 * Severity is the one advisory field whose provenance FLIPS per row: a SIEM that
 * asserts a severity is tagged `severity_source: 'source_asserted'` (reported by the
 * source), while a case whose severity was derived from the deterministic risk score is
 * `'derived'` (code). Round 14 dropped the provenance glyph from the row: the severity
 * chip's tooltip says where the severity came from, and the same words reach assistive
 * technology as screen-reader text. Risk, verdict and confidence keep their constant
 * provenance at the column header.
 *
 * Fully mocked (offline); nothing here touches #3 runtime behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

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

// A SIEM-asserted severity (source) and a code-derived one (fell back to risk_score)
// living in the SAME loaded list, so the per-row provenance flip is observable.
const CASES = [
  {
    case_id: 'c-src', case_number: 'T-1', title: 'SourceCase', status: 'open',
    severity_band: 'high', severity_source: 'source_asserted', risk_score: 40,
    updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [],
  },
  {
    case_id: 'c-der', case_number: 'T-2', title: 'DerivedCase', status: 'open',
    // no severity_band → band derived from risk_score; graded by code.
    severity_source: 'derived', risk_score: 90,
    updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [],
  },
];

const SOURCE_WORDS = 'Severity reported by the source';
const CODE_WORDS = 'Severity derived from the risk score';

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

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('tr');
  if (!row) throw new Error(`row for ${title} not found`);
  return row;
}

/** The severity cell's chip wrapper (the element that carries the provenance). */
function severityOf(title: string): HTMLElement {
  const chip = rowFor(title).querySelector<HTMLElement>('[data-severity-source]');
  if (!chip) throw new Error(`severity chip for ${title} not found`);
  return chip;
}

describe('Cases: per-row severity provenance (Round 14)', () => {
  beforeEach(() => {
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    window.localStorage.clear();
  });

  it('says a SIEM-asserted severity came from the source', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('SourceCase')).toBeInTheDocument());
    const chip = severityOf('SourceCase');
    expect(chip).toHaveAttribute('title', SOURCE_WORDS);
    expect(chip).toHaveAttribute('data-severity-source', 'source');
    // The same words for assistive technology.
    expect(within(chip).getByText(`, ${SOURCE_WORDS.toLowerCase()}`)).toHaveClass('sr-only');
  });

  it('says a code-derived severity came from the risk score', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('DerivedCase')).toBeInTheDocument());
    const chip = severityOf('DerivedCase');
    expect(chip).toHaveAttribute('title', CODE_WORDS);
    expect(chip).toHaveAttribute('data-severity-source', 'code');
  });

  it('draws no provenance glyph in the row (the chip says it once)', async () => {
    renderCases();
    await waitFor(() => expect(screen.getByText('SourceCase')).toBeInTheDocument());
    for (const title of ['SourceCase', 'DerivedCase']) {
      expect(rowFor(title).querySelector('[data-provenance]')).toBeNull();
    }
  });
});
