/**
 * Round 15 (SPEC D4.7; WP7): the Cases bulk bar's Set status and Set disposition leave
 * out the cases the AI agent closed (terminal, first decision record an agent close), as
 * the Case Manager's do: such a case is reviewed (the auto-close review), never
 * re-labelled in bulk. Both menus carry the help text "Cases the AI agent closed are left
 * out; review them instead." with the count of selected cases it applies to; a submit
 * says how many were left out; a selection of only such cases queues nothing. The other
 * bulk actions are unchanged, and the backend verbs are untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listCasesMock, submitJobMock, grants, toastError, toastSuccess } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  submitJobMock: vi.fn(),
  grants: { current: new Set<string>() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
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
  toast: { success: toastSuccess, warning: vi.fn(), error: toastError, message: vi.fn() },
  Toaster: () => null,
}));

import type * as React from 'react';
import { ThemeProvider } from '../theme';
import { PrefsProvider } from '../prefs';
import { AuthProvider } from '../auth';
import { DemoProvider } from '../demo';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Cases from '../pages/Cases';

const T = '2026-11-20T00:00:00Z';
const agentDecision = [{ ts: T, event: 'decision', status: 'closed', decision_by: 'agent' }];
const CASES = [
  { case_id: 'case-001', case_number: 'TLSOC-001', title: 'Alpha', status: 'open', updated_at: '2026-11-20T03:00:00Z', tags: [], comments: [] },
  {
    case_id: 'case-002', case_number: 'TLSOC-002', title: 'Bravo auto-closed', status: 'closed', decision_by: 'agent',
    verdict: 'FALSE_POSITIVE', updated_at: '2026-11-20T02:00:00Z', tags: [], comments: [], history: agentDecision,
  },
  {
    case_id: 'case-003', case_number: 'TLSOC-003', title: 'Charlie closed by a person', status: 'closed', decision_by: 'analyst',
    updated_at: '2026-11-20T01:00:00Z', tags: [], comments: [],
    history: [{ ts: T, event: 'decision', status: 'closed', decision_by: 'analyst' }],
  },
];

const TIER2 = ['cases:read', 'cases:write', 'cases:comment', 'cases:assign', 'cases:close', 'cases:reinvestigate'];

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

async function select(...numbers: string[]) {
  renderCases();
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
  for (const n of numbers) fireEvent.click(screen.getByRole('checkbox', { name: `Select ${n}` }));
  return screen.findByRole('region', { name: /bulk actions/i });
}

async function choose(bar: HTMLElement, menu: string, option: string) {
  const user = userEvent.setup();
  await user.click(within(bar).getByRole('combobox', { name: menu }));
  const list = await screen.findByRole('listbox');
  const note = within(list).getByTestId('cases-bulk-agent-closed-note');
  const noteText = note.textContent;
  await user.click(within(list).getByRole('option', { name: option }));
  return noteText;
}

beforeEach(() => {
  grants.current = new Set(TIER2);
  listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
  submitJobMock.mockReset().mockResolvedValue({ job_id: 'job-1', status: 'queued' });
  toastError.mockClear();
  toastSuccess.mockClear();
  window.localStorage.clear();
});

describe('Cases bulk relabelling leaves out the cases the AI agent closed (D4.7)', () => {
  it('sends Set status for the others only, and says how many it left out', async () => {
    const bar = await select('TLSOC-001', 'TLSOC-002', 'TLSOC-003');
    const note = await choose(bar, 'Set status for selected cases', 'Investigating');
    expect(note).toBe('Cases the AI agent closed are left out; review them instead. 1 of the selected cases is left out.');
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    const submitted = submitJobMock.mock.calls[0][0];
    expect(submitted.kind).toBe('case_lifecycle');
    expect(submitted.params).toMatchObject({ action: 'set_status', status: 'investigating' });
    // A person's close is relabelled as before; only the agent's close is left out.
    expect(submitted.params.case_ids).toEqual(['case-001', 'case-003']);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toContain('1 case the AI agent closed was left out.');
  });

  it('sends Set disposition for the others only', async () => {
    const bar = await select('TLSOC-001', 'TLSOC-002');
    await choose(bar, 'Set disposition for selected cases', 'Benign');
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0].params).toMatchObject({
      action: 'set_disposition',
      disposition: 'benign',
      case_ids: ['case-001'],
    });
  });

  it('queues nothing when the agent closed every selected case, and says so', async () => {
    const bar = await select('TLSOC-002');
    await choose(bar, 'Set disposition for selected cases', 'Benign');
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Not queued: the AI agent closed every selected case. Review those cases instead.',
      ),
    );
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('carries the help text even when no selected case is affected', async () => {
    const bar = await select('TLSOC-001');
    const note = await choose(bar, 'Set status for selected cases', 'On hold');
    expect(note).toBe('Cases the AI agent closed are left out; review them instead.');
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0].params.case_ids).toEqual(['case-001']);
  });

  it('leaves the other bulk actions as they were', async () => {
    const bar = await select('TLSOC-001', 'TLSOC-002');
    fireEvent.click(within(bar).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(submitJobMock).toHaveBeenCalledTimes(1));
    expect(submitJobMock.mock.calls[0][0].params.case_ids).toEqual(['case-001', 'case-002']);
  });
});
