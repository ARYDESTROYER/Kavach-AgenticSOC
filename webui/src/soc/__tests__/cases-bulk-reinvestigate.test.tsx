/** Bulk reinvestigation is one durable server-owned job, never a browser loop. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { listCasesMock, submitJobMock, reinvestigateCaseMock, bulkMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  submitJobMock: vi.fn(),
  reinvestigateCaseMock: vi.fn(),
  bulkMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      getBranding: ok({ org_name: '', product_name: '', logo_data_url: '', favicon_data_url: '', accent_color: '', accent_color2: '', theme: '', login_subtitle: '' }),
      prefs: { effective: ok({ terminology: {}, theme_mode: 'dark', saved_views: [], pinned_view_ids: [], tables: {}, last_list_state: {}, misc: {}, org: { terminology: {}, default_theme: 'dark', default_saved_views: [], default_pinned_view_ids: [] } }), putUser: ok({}) },
      views: { list: ok({ views: [], count: 0 }) },
      demo: { status: ok({ mode: 'off', active: false, run_id: null }) },
      listCases: listCasesMock,
      reinvestigateCase: reinvestigateCaseMock,
      cases: { bulk: bulkMock },
      jobs: { submit: submitJobMock },
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
  { case_id: 'case-002', case_number: 'ASOC-002', title: 'Bravo', status: 'closed', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
  { case_id: 'case-001', case_number: 'ASOC-001', title: 'Alpha', status: 'open', updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
];

function renderCases() {
  return render(
    <ThemeProvider><TooltipProvider><AuthProvider><PrefsProvider><DemoProvider><RouterProvider><Cases /></RouterProvider></DemoProvider></PrefsProvider></AuthProvider></TooltipProvider></ThemeProvider>,
  );
}

describe('Cases durable bulk reinvestigation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    submitJobMock.mockReset().mockResolvedValue({
      job_id: 'job-reinvestigate', kind: 'case_reinvestigate', actor: 'operator',
      created_at: '2026-08-13T00:00:00Z', status: 'queued',
      progress: { done: 0, total: 2, unit: 'cases' }, failures: [], failure_count: 0,
      failures_truncated: 0, request_fingerprint: 'a'.repeat(64), params: {}, cancel_requested: false,
    });
    reinvestigateCaseMock.mockReset();
    bulkMock.mockReset();
  });

  it('keeps the cost confirmation, then submits one sorted immutable job snapshot', async () => {
    renderCases();
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByLabelText('Select all rows'));
    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    fireEvent.click(within(bar).getByRole('button', { name: /reinvestigate/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/spends LLM tokens per case/i);
    expect(submitJobMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /^reinvestigate$/i }));

    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0]).toMatchObject({
      kind: 'case_reinvestigate',
      params: { case_ids: ['case-001', 'case-002'] },
    });
    expect(submitJobMock.mock.calls[0][0].idempotency_key).toMatch(/^case_reinvestigate-/);
    expect(reinvestigateCaseMock).not.toHaveBeenCalled();
    expect(bulkMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('region', { name: /bulk actions/i })).toBeNull());
  });

  it('keeps the selection when submission fails so an operator can retry', async () => {
    submitJobMock.mockRejectedValueOnce(new Error('jobs unavailable'));
    renderCases();
    await screen.findByText('Alpha');
    fireEvent.click(screen.getByLabelText('Select all rows'));
    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    fireEvent.click(within(bar).getByRole('button', { name: /reinvestigate/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^reinvestigate$/i }));
    await screen.findByText('jobs unavailable');
    expect((await screen.findAllByText('2 selected')).length).toBeGreaterThan(0);
  });
});
