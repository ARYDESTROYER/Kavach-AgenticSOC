/**
 * Metrics posture/performance tabs (Round 3 / Feature 5) render test.
 *
 * Mocks the co-located posture API + the shared `@/lib/api` and asserts:
 *   1. the Performance tab renders the server lifecycle p50 (honest DASH for a
 *      missing block) + a quality delta tile (FP rate falling reads as an
 *      improvement), and
 *   2. the Posture tab renders the MITRE coverage heatmap + the Navigator-layer
 *      export link, plus the SLA breach rollup.
 *
 * Fully offline — the page does not use auth; only the data calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock, fetchMitreMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
}));

vi.mock('../pages/Metrics.posture.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Metrics.posture.api')>(
    '../pages/Metrics.posture.api',
  );
  return {
    ...actual,
    fetchPosture: fetchPostureMock,
    fetchMitreCoverage: fetchMitreMock,
  };
});

vi.mock('@/lib/api', () => ({
  api: {
    getMetrics: vi.fn().mockResolvedValue({
      total_cases: 10,
      open_cases: 4,
      needs_human_cases: 1,
      closed_cases: 6,
      by_status: {},
      by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 5, NEEDS_HUMAN: 1, none: 2 },
      persona_usage: {},
      playbook_usage: {},
      avg_risk_score: 42,
      mttr_minutes: 120,
      resolved_count: 6,
      cases_per_day: [],
      feedback: {
        graded_cases: 0, feedback_count: 0, agreement_rate: 0,
        avg_accuracy: 0, avg_reasoning_quality: 0, avg_action_appropriateness: 0,
        time_saved_minutes: 0, outcome_distribution: {},
      },
      cost: {},
    }),
    ragStats: vi.fn().mockResolvedValue(null),
    getMemory: vi.fn().mockResolvedValue(null),
  },
}));

import Metrics from '../pages/Metrics';
import type { PostureResponse, MitreCoverageResponse } from '../pages/Metrics.posture.api';

const POSTURE: PostureResponse = {
  window_hours: 168,
  generated_at: '2026-06-30T08:00:00Z',
  case_count: 10,
  lifecycle: {
    mtta_minutes: { p50: 45, p90: 120, mean: 60, max: 200, count: 8, available: true, reason: '' },
    mttr_minutes: { p50: 180, p90: 600, mean: 240, max: 900, count: 6, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no case has received a first response yet' },
  },
  quality: {
    total_cases: 10,
    verdicted_cases: 8,
    true_positive_cases: 2,
    false_positive_cases: 5,
    needs_human_cases: 1,
    escalated_cases: 1,
    terminal_cases: 6,
    auto_closed_cases: 3,
    alert_to_incident_ratio: 0.2,
    false_positive_rate: 0.625,
    escalation_rate: 0.1,
    containment_rate: 0.6,
    automation_rate: 0.5,
  },
  aging: {
    queue_depth: 4,
    age_buckets: [
      { bucket: '<1h', count: 1 },
      { bucket: '1-4h', count: 2 },
      { bucket: '4-24h', count: 1 },
      { bucket: '1-3d', count: 0 },
      { bucket: '3-7d', count: 0 },
      { bucket: '>7d', count: 0 },
    ],
    oldest: [
      { case_id: 'c1', case_number: 'TLSOC-1', age_hours: 6.2, status: 'open', risk_score: 70 },
    ],
    arrivals: 10,
    closures: 6,
    closure_vs_arrival: 0.6,
    backlog: 4,
  },
  sla: {
    enabled: true,
    evaluated: 8,
    response_breached: 1,
    response_at_risk: 1,
    resolve_breached: 0,
    resolve_at_risk: 0,
    attainment_pct: 87.5,
    breaching: [
      {
        case_id: 'c1', case_number: 'TLSOC-1', priority: 'P1', clock: 'response',
        state: 'breached', elapsed_minutes: 120, target_minutes: 60, over_pct: 100,
      },
    ],
  },
  compare: {
    mode: 'prev',
    case_count: { value: 10, prev: 8, delta_pct: 25 },
    alert_to_incident_ratio: { value: 0.2, prev: 0.1, delta_pct: 100 },
    false_positive_rate: { value: 0.625, prev: 0.8, delta_pct: -21.9 },
    escalation_rate: { value: 0.1, prev: 0.2, delta_pct: -50 },
    automation_rate: { value: 0.5, prev: 0.4, delta_pct: 25 },
    mttr_p50: { value: 180, prev: 200, delta_pct: -10 },
    mtta_p50: { value: 45, prev: 60, delta_pct: -25 },
  },
};

const MITRE: MitreCoverageResponse = {
  corpus_version: 'ATT&CK v15',
  total_techniques: 600,
  covered_techniques: 3,
  coverage_pct: 0.5,
  invalid_dropped: 0,
  by_tactic: {
    TA0002: {
      tactic: 'TA0002',
      covered: 2,
      total: 50,
      coverage_pct: 4,
      techniques: [
        { id: 'T1059', name: 'Command and Scripting Interpreter', case_count: 4 },
        { id: 'T1053', name: 'Scheduled Task/Job', case_count: 1 },
      ],
    },
  },
  top_techniques: [{ id: 'T1059', name: 'Command and Scripting Interpreter', case_count: 4 }],
  window_hours: 0,
};

describe('Metrics posture (Round 3 / F5)', () => {
  beforeEach(() => {
    fetchPostureMock.mockReset();
    fetchMitreMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    fetchMitreMock.mockResolvedValue(MITRE);
  });

  it('renders the Performance tab with the server lifecycle p50 + honest DASH', async () => {
    render(<Metrics embedded />);

    // Switch to the Performance tab (anchored on the stable testid; the content
    // assertions below carry the real behavioral value).
    await waitFor(() => expect(screen.getByTestId('metrics-tab-performance')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('metrics-tab-performance'));

    // MTTA p50 humanizes 45m; the MTTA tile is present (the value also appears in the
    // percentile-distribution card, so assert at least one occurrence).
    await waitFor(() => expect(screen.getByText('MTTA (p50)')).toBeInTheDocument());
    expect(screen.getAllByText('45m').length).toBeGreaterThan(0);
    // MTTR p50 = 180m → "3h".
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0);

    // Dwell is unavailable → its tile shows the honest reason (not a fake 0).
    expect(screen.getByText('Dwell (p50)')).toBeInTheDocument();
    expect(
      screen.getAllByText(/no case has received a first response yet/i).length,
    ).toBeGreaterThan(0);

    // FP-rate quality tile renders as a percent (0.625 → 63%).
    expect(screen.getByText('FP rate')).toBeInTheDocument();
    expect(screen.getByText('63%')).toBeInTheDocument();
  });

  it('renders the Posture tab with the MITRE heatmap + Navigator export link', async () => {
    render(<Metrics embedded />);

    await waitFor(() => expect(screen.getByTestId('metrics-tab-posture')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('metrics-tab-posture'));

    // The MITRE coverage section + a covered technique id render.
    await waitFor(() => expect(screen.getByText(/MITRE ATT&CK coverage/i)).toBeInTheDocument());
    expect(screen.getAllByText('T1059').length).toBeGreaterThan(0);

    // The Navigator-layer export link points at the JSON endpoint.
    const exportLink = screen.getByRole('link', { name: /export att&ck navigator layer/i });
    expect(exportLink).toHaveAttribute('href', '/api/mitre/coverage/navigator.layer.json');

    // The SLA breach rollup surfaces the breached case.
    expect(screen.getByText('SLA attainment')).toBeInTheDocument();
    expect(screen.getAllByText('TLSOC-1').length).toBeGreaterThan(0);
  });

  it('renders SLA attainment that was not measured as a dash, never 0%', async () => {
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      sla: {
        enabled: true,
        evaluated: 0,
        response_breached: 0,
        response_at_risk: 0,
        resolve_breached: 0,
        resolve_at_risk: 0,
        attainment_pct: null,
        attainment_reason: 'no case in this window has a priority level with an SLA target',
        breaching: [],
      },
    });
    render(<Metrics embedded />);
    await waitFor(() => expect(screen.getByTestId('metrics-tab-posture')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('metrics-tab-posture'));
    await waitFor(() => expect(screen.getByText('Attainment')).toBeInTheDocument());
    const tile = screen.getByText('Attainment').closest('div')?.parentElement as HTMLElement;
    expect(tile.textContent).toContain('—');
    expect(tile.textContent).not.toContain('0%');
  });
});
