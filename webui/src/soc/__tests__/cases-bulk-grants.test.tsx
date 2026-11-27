/**
 * The Cases bulk bar offers each action only to a role that holds its grant (Round 14
 * second acceptance pass, roles-07). The bar's jobs are checked against these grants on
 * the server: acknowledge, tag, status and disposition need `cases:write`, Assign
 * `cases:assign`, Reinvestigate `cases:reinvestigate`, Close and Resolve `cases:close`.
 * A role with none of them (the read-only auditor) gets no row selection at all, and a
 * refused job is worded, never the server's raw "permission denied" text. A submit in
 * flight shows in the count badge every role sees and marks the bar busy, so a role
 * without Reinvestigate still sees its work in progress.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { listCasesMock, submitJobMock, grants, toastError } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  submitJobMock: vi.fn(),
  grants: { current: new Set<string>() },
  toastError: vi.fn(),
}));

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  const has = (resource: string, action: string) => grants.current.has(`${resource}:${action}`);
  return {
    ...actual,
    Can: ({
      resource,
      action,
      fallback = null,
      children,
    }: {
      resource: string;
      action: string;
      fallback?: React.ReactNode;
      children: React.ReactNode;
    }) => <>{has(resource, action) ? children : fallback}</>,
    useCan: has,
  };
});

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
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
      jobs: { submit: submitJobMock },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: toastError, message: vi.fn() },
  Toaster: () => null,
}));

import type * as React from 'react';
import { ApiError } from '@/lib/api';
import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases, { bulkJobErrorText } from '../pages/Cases';

const CASES = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', updated_at: '2026-06-29T00:00:00Z', tags: [], comments: [] },
  { case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo', status: 'open', updated_at: '2026-06-29T01:00:00Z', tags: [], comments: [] },
];

const AUDITOR = ['cases:read'];
const TIER1 = ['cases:read', 'cases:write', 'cases:comment', 'cases:assign'];
const TIER2 = [...TIER1, 'cases:close', 'cases:reinvestigate'];

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

async function selectFirstRow() {
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select TLSOC-001' }));
  return screen.findByRole('region', { name: /bulk actions/i });
}

beforeEach(() => {
  listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
  submitJobMock.mockReset();
  toastError.mockClear();
  window.localStorage.clear();
});

describe('Cases bulk bar by grant (roles-07)', () => {
  it('gives a read-only auditor no row selection and so no bulk bar', async () => {
    grants.current = new Set(AUDITOR);
    renderCases();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.queryByRole('checkbox', { name: 'Select TLSOC-001' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select all cases on this page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /bulk actions/i })).not.toBeInTheDocument();
  });

  it('offers tier 1 the write and assign actions, without Reinvestigate, Resolve or Close', async () => {
    grants.current = new Set(TIER1);
    renderCases();
    const bar = await selectFirstRow();
    for (const name of ['Acknowledge', 'Assign', 'Add tag']) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(bar).getByRole('combobox', { name: 'Set status for selected cases' })).toBeInTheDocument();
    expect(within(bar).getByRole('combobox', { name: 'Set disposition for selected cases' })).toBeInTheDocument();
    for (const name of ['Reinvestigate', 'Resolve', 'Close']) {
      expect(within(bar).queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('offers assign alone to a role that may assign but not write', async () => {
    grants.current = new Set(['cases:read', 'cases:assign']);
    renderCases();
    const bar = await selectFirstRow();
    expect(within(bar).getByRole('button', { name: 'Assign' })).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument();
    expect(within(bar).queryByRole('combobox', { name: 'Set status for selected cases' })).not.toBeInTheDocument();
  });

  it('offers tier 2 Reinvestigate, Resolve and Close as well', async () => {
    grants.current = new Set(TIER2);
    renderCases();
    const bar = await selectFirstRow();
    for (const name of ['Acknowledge', 'Assign', 'Add tag', 'Reinvestigate', 'Resolve', 'Close']) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows tier 1 a submit in flight: the bar is busy and the count badge spins', async () => {
    grants.current = new Set(TIER1);
    let settle: (value: unknown) => void = () => undefined;
    submitJobMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    renderCases();
    const bar = await selectFirstRow();
    expect(bar).not.toHaveAttribute('aria-busy');
    expect(within(bar).queryByTestId('cases-bulk-busy')).not.toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(bar).toHaveAttribute('aria-busy', 'true'));
    expect(within(within(bar).getByTestId('cases-bulk-count')).getByTestId('cases-bulk-busy')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    settle({ job_id: 'job-1', status: 'queued' });
    await waitFor(() => expect(within(bar).queryByTestId('cases-bulk-busy')).not.toBeInTheDocument());
  });

  it('keeps each select trigger icon on the label row, outside the clamped span', async () => {
    grants.current = new Set(TIER1);
    renderCases();
    const bar = await selectFirstRow();
    for (const name of ['Set status for selected cases', 'Set disposition for selected cases']) {
      const trigger = within(bar).getByRole('combobox', { name });
      // The icon is the trigger's own first child, not inside the `[&>span]:line-clamp-1`
      // span that turned it into a stacked block.
      expect(trigger.firstElementChild?.tagName.toLowerCase()).toBe('svg');
      expect(trigger.querySelector(':scope > span svg')).toBeNull();
      expect(trigger.className).toContain('justify-start');
    }
  });

  it('words a refused bulk job instead of showing the raw server text', async () => {
    grants.current = new Set(TIER1);
    submitJobMock.mockRejectedValueOnce(new ApiError(403, 'permission denied: cases:write'));
    renderCases();
    const bar = await selectFirstRow();
    fireEvent.click(within(bar).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('You do not have permission to make this change to the selected cases.'),
    );
  });
});

describe('bulkJobErrorText', () => {
  it('words a 403 and keeps any other failure message', () => {
    expect(bulkJobErrorText(new ApiError(403, 'permission denied: cases:write'))).toBe(
      'You do not have permission to make this change to the selected cases.',
    );
    expect(bulkJobErrorText(new ApiError(409, 'Another job is running.'))).toBe('Another job is running.');
    expect(bulkJobErrorText(null)).toBe('Could not start the background job.');
  });
});
