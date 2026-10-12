/**
 * Overview → Cases through the real RouterProvider (Round 12 final review).
 *
 * The Overview's "View resolved cases" / "View open cases" drill-throughs navigate to
 * Cases with the `__terminal__` / `__active__` virtual status facets. The router writes
 * them to the hash, and the hash echo of that navigate used to wipe them (the strict
 * deep-link parser refuses both). The Cases chunk mounts after the echo, so the list
 * opened on "All statuses" with active cases under a card that counts only terminal
 * ones. This mounts the real lazy Cases route only after the real jsdom `hashchange`
 * has fired, exactly as a chunk fetch does in the browser.
 *
 * Fully offline (mocked API).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listCasesMock, fetchPostureMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  fetchPostureMock: vi.fn(),
}));

vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

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
      getMetrics: ok({
        total_cases: 3, open_cases: 1, needs_human_cases: 1, closed_cases: 1,
        by_status: { open: 1, needs_human: 1, resolved: 1 }, by_verdict: {},
        persona_usage: {}, playbook_usage: {}, avg_risk_score: 40, mttr_minutes: 60,
        resolved_count: 1, cases_per_day: [], burndown: [], timing_trend: [], cost: {},
      }),
      usageSummary: ok({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' }),
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
import { RouterProvider, useRoute } from '../router';
import { renderRoute } from '../registry';
import { TooltipProvider } from '@/ui/tooltip';
import Overview from '../pages/Overview';

const CASES = [
  { case_id: 'c-open', case_number: 'T-1', title: 'OpenCase', status: 'open', risk_score: 90, created_at: new Date().toISOString(), updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'c-closed', case_number: 'T-2', title: 'ClosedCase', status: 'closed', risk_score: 10, created_at: new Date().toISOString(), updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'c-res', case_number: 'T-3', title: 'ResolvedCase', status: 'resolved', risk_score: 12, created_at: new Date().toISOString(), updated_at: '2026-06-29T02:00:00Z', tags: [], comments: [] },
];

/** Releases the Cases route, standing in for its chunk fetch finishing. */
let releaseChunk: (() => void) | null = null;

function ChunkGate({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    releaseChunk = () => setLoaded(true);
  }, []);
  return loaded ? <>{children}</> : <p>Loading Cases</p>;
}

function Shell() {
  const { page, opts } = useRoute();
  if (page === 'overview') return <Overview />;
  return (
    <ChunkGate key={page}>
      <React.Suspense fallback={<p>Loading page</p>}>
        {renderRoute(page, { opts, onRerunWizard: () => undefined })}
      </React.Suspense>
    </ChunkGate>
  );
}

function renderApp() {
  window.location.hash = '#/overview';
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <AuthProvider>
          <PrefsProvider>
            <DemoProvider>
              <RouterProvider>
                <Shell />
              </RouterProvider>
            </DemoProvider>
          </PrefsProvider>
        </AuthProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

/** Let jsdom fire the real `hashchange` queued by the navigate's hash write. */
async function settleHashEcho() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function drillThrough(cta: string, expectedHash: string): Promise<HTMLElement> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(await screen.findByRole('button', { name: cta }));
  await settleHashEcho();
  expect(window.location.hash).toBe(expectedHash);
  act(() => releaseChunk?.());
  return screen.findByLabelText('Filter by status', undefined, { timeout: 5000 });
}

describe('Overview → Cases through the real router', () => {
  beforeEach(() => {
    releaseChunk = null;
    window.localStorage.clear();
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    fetchPostureMock.mockReset().mockRejectedValue(new Error('posture offline'));
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('"View resolved cases" opens the terminal facet, not all statuses', async () => {
    renderApp();
    const status = await drillThrough('View resolved cases', '#/cases?status=__terminal__');
    await waitFor(() => expect(screen.getByText('ResolvedCase')).toBeInTheDocument());
    expect(status.textContent).toBe('Terminal (resolved or closed)');
    expect(screen.getByText('ClosedCase')).toBeInTheDocument();
    expect(screen.queryByText('OpenCase')).toBeNull();
  });

  it('"View open cases" opens the active facet', async () => {
    renderApp();
    const status = await drillThrough('View open cases', '#/cases?status=__active__');
    await waitFor(() => expect(screen.getByText('OpenCase')).toBeInTheDocument());
    expect(status.textContent).toBe('Active cases');
    expect(screen.queryByText('ClosedCase')).toBeNull();
    expect(screen.queryByText('ResolvedCase')).toBeNull();
  });
});
