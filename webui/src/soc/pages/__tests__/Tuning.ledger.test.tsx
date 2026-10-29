/**
 * Tuning ledger state — BUG #12 regression (G6 R5).
 *
 * BUG: `TuningLedgerRow` used to read a non-existent `row.active` field, so EVERY
 * applied-changes row rendered the same state. The backend serializes `rolled_back` /
 * `rolled_back_at` (via `TuningRecord.to_json()`), NOT `active`. This spec pins the
 * real per-row derivation (`isLedgerRowActive`) AND the rendered ledger so the two
 * distinct states show correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { isLedgerRowActive, type TuningLedgerRow } from '../Tuning.api';

describe('isLedgerRowActive (bug #12)', () => {
  it('treats a freshly-applied row (no rolled_back flag) as ACTIVE', () => {
    const row: TuningLedgerRow = { id: 'a', rule_id: 'r1', target: 'correlation_n', before: 3, after: 4 };
    expect(isLedgerRowActive(row)).toBe(true);
  });

  it('treats a rolled_back row as INACTIVE (authoritative field)', () => {
    const row: TuningLedgerRow = {
      id: 'b', rule_id: 'r2', target: 'correlation_n', before: 3, after: 4, rolled_back: true,
    };
    expect(isLedgerRowActive(row)).toBe(false);
  });

  it('treats a row with a rolled_back_at timestamp as INACTIVE', () => {
    const row: TuningLedgerRow = {
      id: 'c', rule_id: 'r3', target: 'severity_floor', before: 2, after: 3,
      rolled_back_at: '2026-07-01T00:00:00Z',
    };
    expect(isLedgerRowActive(row)).toBe(false);
  });

  it('honours an explicit active flag when a producer sets one', () => {
    const row: TuningLedgerRow = {
      id: 'd', rule_id: 'r4', target: 'correlation_n', before: 3, after: 4, active: false,
    };
    expect(isLedgerRowActive(row)).toBe(false);
  });
});

/* ── The rendered ledger shows the two states distinctly ───────────────── */

const {
  recsMock,
  getConfigMock,
  putConfigMock,
  applyMock,
  rollbackMock,
} = vi.hoisted(() => ({
  recsMock: vi.fn(),
  getConfigMock: vi.fn(),
  putConfigMock: vi.fn(),
  applyMock: vi.fn(),
  rollbackMock: vi.fn(),
}));

vi.mock('@/soc/pages/Tuning.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Tuning.api')>();
  return {
    ...actual,
    tuningApi: {
      recommendations: recsMock,
      getConfig: getConfigMock,
      putConfig: putConfigMock,
      apply: applyMock,
      rollback: rollbackMock,
    },
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', hasPermission: () => true, authEnabled: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Tuning from '../Tuning';
import type { TuningRecommendationsResponse } from '../Tuning.api';

// Two ledger rows in the backend's REAL shape (rolled_back, NOT active).
const RECS: TuningRecommendationsResponse = {
  enabled: false,
  cadence: 'nightly',
  fp_rate_target: 0.3,
  min_samples: 25,
  window_cases: 10,
  rule_noise: [],
  recommendations: [],
  applied: [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: 'led-active', rule_id: 'rule-live', target: 'correlation_n', before: 3, after: 4, rolled_back: false, applied_at: '2026-07-01T10:00:00Z' } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { id: 'led-reverted', rule_id: 'rule-reverted', target: 'severity_floor', before: 2, after: 3, rolled_back: true, rolled_back_at: '2026-07-01T12:00:00Z', applied_at: '2026-07-01T09:00:00Z' } as any,
  ],
};

describe('Tuning ledger render (bug #12)', () => {
  beforeEach(() => {
    recsMock.mockReset();
    getConfigMock.mockReset();
    recsMock.mockResolvedValue(RECS);
    getConfigMock.mockResolvedValue({
      config: {
        enabled: false, min_samples: 25, max_n_step: 1, fp_rate_target: 0.3,
        wilson_z: 1.96, ewma_alpha: 0.2, cadence: 'nightly', shadow_eval: true,
      },
    });
  });

  it('renders one Active row and one Rolled back row (not all the same)', async () => {
    render(
      <TooltipProvider>
        <Tuning />
      </TooltipProvider>,
    );
    await waitFor(() => expect(recsMock).toHaveBeenCalled());
    // The tabs appear once the page's first reads settle, which can be after the read
    // started: wait for the tab itself, never a synchronous lookup after the waitFor.
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'Policy & history' }), {
      key: 'Enter',
    });
    await screen.findByText('rule-live');

    // BUG #12 would have rendered BOTH the same. We now show the real states.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Rolled back')).toBeInTheDocument();
    // Only the ACTIVE row offers a Rollback action.
    expect(screen.getAllByRole('button', { name: /rollback/i })).toHaveLength(1);
  });
});
