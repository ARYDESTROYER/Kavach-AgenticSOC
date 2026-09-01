/**
 * Overview — the Total Critical tile reads the product's OWN top severity band.
 *
 * `severity_counts` is keyed by the backend's closed `SEVERITY_BANDS` vocabulary, and
 * the tile's population sentence, drill-down predicate and Cases deep link all derive
 * `TOP_SEVERITY_BAND` from `SEVERITY_BAND_ORDER` (badges.tsx, the ONE band authority).
 * The numeral, its share and its sub used to index that payload with the client-side
 * literal `critical` instead — directly under a comment claiming they never did — so a
 * renamed top band would have left the tile reading an em dash and captioned "Critical
 * band" while the panel it opens listed the renamed band's cases correctly.
 *
 * This file mocks ONLY `SEVERITY_BAND_ORDER`, moving the ladder's top entry to an
 * existing real band, and asserts the numeral and the panel still name ONE band.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/components/badges', async () => {
  const actual = await vi.importActual<typeof import('@/soc/components/badges')>(
    '@/soc/components/badges',
  );
  // The ladder now tops out at `high`. Every other export stays real.
  return { ...actual, SEVERITY_BAND_ORDER: ['info', 'low', 'medium', 'high'] as const };
});

const { fetchPostureMock } = vi.hoisted(() => ({ fetchPostureMock: vi.fn() }));
vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return { ...actual, fetchPosture: fetchPostureMock };
});

const { listCasesMock, getMetricsMock, usageMock } = vi.hoisted(() => ({
  listCasesMock: vi.fn(),
  getMetricsMock: vi.fn(),
  usageMock: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: { listCases: listCasesMock, getMetrics: getMetricsMock, usageSummary: usageMock },
}));

import Overview from '../pages/Overview';
import type { PostureResponse } from '../pages/Metrics.posture.api';
import type { Case, Metrics } from '@/lib/types';

const CASES: Case[] = [
  { case_id: 'c-high', case_number: 'T-1', title: 'HighCase', status: 'open', risk_score: 60 },
  { case_id: 'c-crit', case_number: 'T-2', title: 'CritCase', status: 'open', risk_score: 95 },
] as unknown as Case[];

const POSTURE: PostureResponse = {
  window_hours: 24,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 11,
  // Two in the RETIRED top band, nine in the ladder's current top band.
  severity_counts: { critical: 2, high: 9, medium: 0, low: 0, info: 0 },
  open_now: { count: 2, window_exempt: true, complete: true, reason: '' },
  window_covered: true,
  window_coverage_reason: '',
  truncated: false,
  lifecycle: {
    mtta_minutes: { p50: 1, p90: 1, mean: 1, max: 1, count: 1, available: true, reason: '' },
    mttr_minutes: { p50: 1, p90: 1, mean: 1, max: 1, count: 1, available: true, reason: '' },
    dwell_minutes: { p50: 1, p90: 1, mean: 1, max: 1, count: 1, available: true, reason: '' },
  },
  quality: {
    total_cases: 11, verdicted_cases: 2, true_positive_cases: 1, false_positive_cases: 1,
    needs_human_cases: 0, escalated_cases: 0, terminal_cases: 0, auto_closed_cases: 0,
    alert_to_incident_ratio: 0.1, false_positive_rate: 0.5, escalation_rate: 0,
    containment_rate: 0, automation_rate: 0,
  },
  aging: { queue_depth: 2, age_buckets: [], oldest: [], arrivals: 2, closures: 0, closure_vs_arrival: 0, backlog: 2 },
  sla: { enabled: false },
} as unknown as PostureResponse;

describe('Overview — Total Critical follows the ladder, not a literal', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset().mockResolvedValue(POSTURE);
    listCasesMock.mockReset().mockResolvedValue({ cases: CASES, total: CASES.length });
    getMetricsMock.mockReset().mockResolvedValue({ by_verdict: {}, burndown: [], timing_trend: [] } as unknown as Metrics);
    usageMock.mockReset().mockResolvedValue({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' });
  });

  it('numeral, sub, panel population and deep link all name ONE band', async () => {
    const onNavigate = vi.fn();
    render(<Overview onNavigate={onNavigate} />);
    await screen.findByTestId('page-hero');
    const tile = await screen.findByTestId('kpi-total-critical');

    // 9, the ladder's own top band — not the 2 the retired `critical` literal held.
    await waitFor(() => expect(within(tile).getByText('9')).toBeInTheDocument());
    expect(within(tile).queryByText('2')).toBeNull();
    expect(within(tile).getByText('82% of 11')).toBeInTheDocument();
    expect(within(tile).getByText('High band · counted server-side')).toBeInTheDocument();
    expect(within(tile).queryByText(/Critical band/)).toBeNull();

    // The panel the tile discloses, and the list it deep-links to, agree with it.
    await userEvent.click(tile);
    const panel = await screen.findByTestId('kpi-drilldown');
    expect(panel).toHaveTextContent(/Cases in the High band of this window/i);
    await userEvent.click(within(panel).getByTestId('kpi-drilldown-drillthrough'));
    expect(onNavigate).toHaveBeenLastCalledWith(
      'cases',
      expect.objectContaining({ severity: 'high' }),
    );
  });
});
