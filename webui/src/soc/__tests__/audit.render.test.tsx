/**
 * Audit log viewer (W7c) render test.
 *
 * Renders the Audit page (auth off → the audit:view ProtectedRoute is transparent),
 * mocks GET /api/audit, and asserts the records render as PLAIN text in the table
 * with the action + actor + a case deep-link. The api client is fully mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { auditListMock } = vi.hoisted(() => ({ auditListMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      roles: { get: ok({ roles: [], default_role: '', rbac_enabled: false, matrix: {} }) },
      audit: { list: auditListMock },
    },
  };
});

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

describe('Audit viewer (W7c)', () => {
  beforeEach(() => {
    auditListMock.mockReset();
    auditListMock.mockResolvedValue({
      records: [
        {
          ts: '2026-06-29T12:00:00Z',
          action_type: 'status',
          actor: 'analyst-jo',
          surface: 'case',
          case_id: 'case-001',
          app_version: '0.1.13',
          build_sha: 'abcdef1234567890',
          result_summary: 'action=close status open→closed',
        },
        {
          ts: '2026-06-29T11:00:00Z',
          action_type: 'verdict',
          actor: 'investigator',
          surface: 'agent',
          result_summary: 'verdict=FALSE_POSITIVE confidence=0.9',
        },
      ],
      total: 2,
    });
  });

  it('renders the audit records as plain text with action + actor + case link', async () => {
    renderAudit();
    await waitFor(() => expect(auditListMock).toHaveBeenCalled());

    // The page header + at least one record's plain-text fields render.
    expect(await screen.findByText('Audit log')).toBeInTheDocument();
    expect(screen.getByText('analyst-jo')).toBeInTheDocument();
    expect(screen.getByText('investigator')).toBeInTheDocument();
    expect(screen.getByText(/action=close status open→closed/)).toBeInTheDocument();
    expect(screen.getByText('v0.1.13 · abcdef1234')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    // The case deep-link button shows the case id.
    expect(screen.getByText('case-001')).toBeInTheDocument();
  });
});
