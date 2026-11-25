/**
 * CaseDetail: the two Round 16 case-page bugs (SPEC §4.4 WP03) and the settings gate.
 *
 * - B27. The page read the deprecated `prefs.fp_auto_close` (default off, bar 95%) while
 *   `decide()` acts on `prefs.auto_close` (false positives on at 85%). The facts said
 *   "Auto-close bar 95% · auto-close off" and the decision said "False-positive
 *   auto-close is disabled." under a record that had just auto-closed at 85%. The page
 *   now reads `prefs.auto_close` and takes the entry for the case's verdict
 *   (`policyForVerdict`).
 * - B28. Take action, then "Change owner" or "Edit tags", opened the editor and closed it
 *   at once: the menu gave focus back to its trigger as it closed, and the non-modal
 *   editor dismissed itself on that focus move. The editor now opens after the menu has
 *   closed, and the menu does not take focus back.
 * - Settings reads (C60). A person who may read cases but not settings never sends
 *   `GET /api/settings` (each refusal writes an Access denied row); the auto-close policy
 *   for the case's verdict comes from the triage read instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const CASE = {
  case_id: 'c-b27',
  case_number: 'CASE-000034',
  title: 'Benign scanner from a known vendor',
  status: 'open',
  verdict: 'FALSE_POSITIVE',
  confidence: 0.87,
  risk_score: 12,
  severity_band: 'low',
  updated_at: '2026-11-01T10:00:00Z',
  created_at: '2026-11-01T09:00:00Z',
  history: [],
  tags: ['scanner'],
};

const SETTINGS = {
  prefs: {
    // The deprecated field: off, at 95%. Nothing reads it to decide.
    fp_auto_close: { enabled: false, min_confidence: 0.95 },
    // The policy decide() acts on: false positives close at 85% up to risk 30.
    auto_close: {
      false_positive: { enabled: true, min_confidence: 0.85, max_risk_score: 30 },
      true_positive: { enabled: false, min_confidence: 0.99, max_risk_score: 20 },
    },
  },
  configured: {},
  read_only: false,
};

const grants = vi.hoisted(() => ({ current: null as Set<string> | null }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CASE)),
    getSettings: vi.fn(() => Promise.resolve(SETTINGS)),
    get: vi.fn((path: string) => {
      if (path.endsWith('/triage')) {
        return Promise.resolve({
          case_id: CASE.case_id,
          found: true,
          chips: null,
          // The triage read's entry for the case's verdict class (WP10).
          auto_close_policy: { enabled: true, min_confidence: 0.85, max_risk_score: 30 },
        });
      }
      return Promise.resolve({ case_id: CASE.case_id, stages: [], spans: [], total: 0, messages: [] });
    }),
  };
  return {
    ApiError,
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => {
  const has = (resource: string, action: string) =>
    grants.current === null ? true : grants.current.has(`${resource}:${action}`);
  return {
    useAuth: () => ({
      username: 'probe',
      role: 'analyst_tier2',
      authEnabled: grants.current !== null,
      rbacEnabled: grants.current !== null,
      hasPermission: has,
      user: null,
    }),
    useOptionalAuth: () => ({ hasPermission: has }),
    useCan: () => () => true,
  };
});

import { api } from '@/lib/api';
import { CaseDetail } from '@/soc/pages/CaseDetail';

async function renderCase() {
  render(<CaseDetail caseId={CASE.case_id} presentation="embedded" onClose={() => undefined} />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/Benign scanner/));
}

beforeEach(() => {
  grants.current = null;
  vi.mocked(api.getSettings).mockClear();
});

describe('B27: the case page states the auto-close policy decide() acts on', () => {
  it('reads prefs.auto_close for the verdict, never the deprecated prefs.fp_auto_close', async () => {
    const user = userEvent.setup();
    await renderCase();
    // The facts: the 85% bar of the false-positive entry, on, with both conditions (D8).
    const bar = await screen.findByTestId('facts-auto-close-bar');
    expect(bar).toHaveTextContent(
      "Today's policy closes it automatically: confidence 87% >= 85% (met) and risk 12 <= 30 (met).",
    );
    expect(bar).not.toHaveTextContent('95%');
    expect(bar).not.toHaveTextContent('auto-close off');
    // No tab that states the decision says false-positive auto-close is off (the Brief
    // holds it now; the Investigation tab did before).
    expect(screen.queryByText(/auto-close is (disabled|off)/i)).toBeNull();
    for (const tab of screen.getAllByRole('tab').filter((t) => /brief|overview|evidence|investigation/i.test(t.textContent ?? ''))) {
      await user.click(tab);
      expect(screen.queryByText(/auto-close is (disabled|off)/i)).toBeNull();
    }
  });

  it('states the reading against the false-positive entry on the decision', async () => {
    await renderCase();
    expect(await screen.findByText(/Eligible for auto-close: confidence is at or above the 0\.85 bar/)).toBeInTheDocument();
  });
});

describe('B28: Change owner and Edit tags from Take action stay open', () => {
  /** Let the menu's close, its focus handling and any dismissal settle. */
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
  };

  it('Change owner opens the owner editor and keeps it open', async () => {
    const user = userEvent.setup();
    await renderCase();
    await user.click(screen.getByRole('button', { name: 'Take action' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /Change owner/ }));
    await screen.findByRole('dialog', { name: 'Owner' });
    await settle();
    expect(screen.getByRole('dialog', { name: 'Owner' })).toBeInTheDocument();
    // Focus is not back on Take action: the editor kept it.
    expect(screen.getByRole('button', { name: 'Take action' })).not.toHaveFocus();
  });

  it('Edit tags opens the tag editor and keeps it open', async () => {
    const user = userEvent.setup();
    await renderCase();
    await user.click(screen.getByRole('button', { name: 'Take action' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /Edit tags/ }));
    await screen.findByRole('dialog', { name: 'Tags' });
    await settle();
    expect(screen.getByRole('dialog', { name: 'Tags' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New tag' })).toHaveFocus();
  });
});

describe('settings:read gates the settings read (C60)', () => {
  it('a cases:read holder without settings:read sends no GET /api/settings and still sees the policy', async () => {
    grants.current = new Set(['cases:read', 'cases:write', 'cases:comment', 'cases:assign']);
    await renderCase();
    // The policy line comes from the triage read's entry for the verdict.
    expect(await screen.findByText(/Eligible for auto-close: confidence is at or above the 0\.85 bar/)).toBeInTheDocument();
    expect(await screen.findByTestId('facts-auto-close-bar')).toHaveTextContent('confidence 87% >= 85% (met)');
    expect(api.getSettings).not.toHaveBeenCalled();
  });

  it('a settings:read holder reads the settings', async () => {
    grants.current = new Set(['cases:read', 'settings:read']);
    await renderCase();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  });
});

