/** Status-neutral tag/assign batches are distinct durable Job kinds. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { listCasesMock, submitJobMock, bulkMock, caseTagsMock, caseAssignMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(), submitJobMock: vi.fn(), bulkMock: vi.fn(), caseTagsMock: vi.fn(), caseAssignMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return { setUnauthorizedHandler: vi.fn(), setReauthHandler: vi.fn(), api: {
    auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
    roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
    getBranding: ok({ org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '', accent_color: '', accent_color2: '', theme: '', login_subtitle: '' }),
    prefs: { effective: ok({ terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [], tables: {}, last_list_state: {}, misc: {}, org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] } }), putUser: ok({}) },
    views: { list: ok({ views: [], count: 0 }) }, demo: { status: ok({ mode: 'off', active: false, run_id: null }) },
    listCases: listCasesMock, cases: { bulk: bulkMock }, caseTags: caseTagsMock, caseAssign: caseAssignMock,
    jobs: { submit: submitJobMock },
  }};
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases from '../pages/Cases';

const CASES = [
  { case_id: 'case-001', title: 'Alpha', status: 'open', assignee: 'ana', updated_at: '2026-06-29T00:00:00Z', tags: ['existing'], comments: [] },
  { case_id: 'case-002', title: 'Bravo', status: 'closed', assignee: 'bob', updated_at: '2026-06-29T01:00:00Z', tags: ['phishing'], comments: [] },
];
function renderCases(props: React.ComponentProps<typeof Cases> = {}) { return render(<ThemeProvider><TooltipProvider><AuthProvider><PrefsProvider><DemoProvider><RouterProvider><Cases {...props} /></RouterProvider></DemoProvider></PrefsProvider></AuthProvider></TooltipProvider></ThemeProvider>); }
async function selectAll() { renderCases(); await screen.findByText('Alpha'); fireEvent.click(screen.getByLabelText('Select all rows')); return screen.findByRole('region', { name: /bulk actions/i }); }

describe('Cases durable tag/assign jobs', () => {
  beforeEach(() => {
    window.localStorage.clear(); window.sessionStorage.clear();
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: 2 });
    submitJobMock.mockReset().mockImplementation(async (input) => ({ job_id: `job-${input.kind}`, kind: input.kind, actor: 'operator', created_at: '2026-08-13T00:00:00Z', status: 'queued', progress: { done: 0, total: 2, unit: 'cases' }, failures: [], failure_count: 0, failures_truncated: 0, request_fingerprint: 'b'.repeat(64), params: {}, cancel_requested: false }));
    bulkMock.mockReset(); caseTagsMock.mockReset(); caseAssignMock.mockReset();
  });

  it('submits one case_tag job without direct tag or lifecycle calls', async () => {
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: /add tag/i }));
    fireEvent.change(await screen.findByLabelText('Tag to add to selected cases'), { target: { value: 'phishing' } });
    fireEvent.click(screen.getByRole('button', { name: /^tag 2$/i }));
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0]).toMatchObject({ kind: 'case_tag', params: { case_ids: ['case-001', 'case-002'], tag: 'phishing' } });
    expect(caseTagsMock).not.toHaveBeenCalled(); expect(bulkMock).not.toHaveBeenCalled();
  });

  it('submits one case_assign job without direct assign or lifecycle calls', async () => {
    const bar = await selectAll();
    fireEvent.click(within(bar).getByRole('button', { name: /^assign$/i }));
    fireEvent.change(await screen.findByLabelText('Owner for bulk assignment'), { target: { value: 'ana' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign 2$/i }));
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0]).toMatchObject({ kind: 'case_assign', params: { case_ids: ['case-001', 'case-002'], assignee: 'ana' } });
    expect(caseAssignMock).not.toHaveBeenCalled(); expect(bulkMock).not.toHaveBeenCalled();
  });

  it('opens a completed assignment destination on the exact assignee cohort', async () => {
    renderCases({ initialAssignee: 'ana' });
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).toBeNull();
    expect(screen.getByRole('combobox', { name: /filter by assignee/i })).toHaveTextContent('ana');
  });

  it('opens a completed tag destination with the tag visible in search', async () => {
    renderCases({ initialTag: 'phishing' });
    expect(await screen.findByText('Bravo')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.getByRole('textbox', { name: /search cases/i })).toHaveValue('phishing');
  });
});
