/**
 * Audit log render test (Round 14 SPEC §4.5; replaces the Round 2 W7c viewer test).
 *
 * Renders the Audit page (auth off, so the audit:view ProtectedRoute is transparent)
 * with the Round 14 read API mocked, and pins that the page reads one server page in
 * the People and settings scope and renders every value as plain text in the grid:
 * the friendly event name, the outcome in words, the actor, the target and the stored
 * summary. Build, surface and model live in the inspector only (F5).
 */
import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';

const realMatchMedia = window.matchMedia;
afterAll(() => {
  window.matchMedia = realMatchMedia;
});
import { render, screen, waitFor, within } from '@testing-library/react';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    request: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
    },
  };
});
vi.mock('@/lib/api-audit', () => ({
  AUDIT_COUNT_CAP: 100_001,
  listAuditPage: listMock,
  countAudit: vi.fn(),
  submitAuditExport: vi.fn(),
}));

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Audit from '../pages/Audit';

function renderAudit() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <RouterProvider>
          <Audit />
        </RouterProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

const base = {
  event_id: null,
  app_version: '0.1.13',
  build_sha: 'abcdef1234567890',
  source_id: null,
  model: null,
  prompt_excerpt: null,
  query_text: null,
  tool_name: null,
  tool_input: null,
  tool_output_summary: null,
  outcome_derived: false,
  actor_type_derived: false,
  demo: false,
  truncated_fields: [],
};

describe('Audit log (Round 14)', () => {
  beforeEach(() => {
    // A 1440 px desktop: every column, Target included.
    window.matchMedia = ((query: string) => ({
      matches: /min-width:\s*1280px/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.location.hash = '#/audit';
    listMock.mockReset();
    listMock.mockResolvedValue({
      records: [
        {
          ...base,
          record_id: 'mem:2',
          ts: '2026-06-29T12:00:00Z',
          action_type: 'status',
          action: 'case.closed',
          actor: 'analyst-jo',
          actor_type: 'human',
          surface: 'case',
          case_id: 'case-001',
          target: { type: 'case', id: 'case-001', label: 'CASE-000001' },
          outcome: 'success',
          category: 'case_work',
          event_label: 'Case closed',
          result_summary: 'action=close status open→closed',
        },
        {
          ...base,
          record_id: 'mem:1',
          ts: '2026-06-29T11:00:00Z',
          action_type: 'access_denied',
          actor: 'investigator',
          actor_type: 'agent',
          actor_type_derived: true,
          surface: 'agent',
          case_id: null,
          outcome: 'denied',
          outcome_derived: true,
          category: 'access',
          event_label: 'Access denied',
          result_summary: 'models:manage is required',
        },
      ],
      total: 2,
      next_cursor: null,
      total_relation: 'eq',
      run_totals: {},
      retention: { hot_days: 180, warm_days: 90, volatile: false },
    });
  });

  it('reads one server page in the People and settings scope and renders it as plain text', async () => {
    renderAudit();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0][0]).toMatchObject({ scope: 'people', from: 'now-7d', limit: 50 });

    expect(screen.getByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument();
    const grid = await screen.findByRole('grid', { name: 'Audit events' });
    expect(within(grid).getByText('Case closed')).toBeInTheDocument();
    expect(within(grid).getByText('Success')).toBeInTheDocument();
    expect(within(grid).getByText('Denied')).toBeInTheDocument();
    expect(within(grid).getByText('analyst-jo')).toBeInTheDocument();
    expect(within(grid).getByText('CASE-000001')).toBeInTheDocument();
    expect(within(grid).getByText('action=close status open→closed')).toBeInTheDocument();
    // Build, surface and model are inspector facts, never list columns (F5).
    expect(within(grid).queryByText(/abcdef1234/)).toBeNull();
  });
});
