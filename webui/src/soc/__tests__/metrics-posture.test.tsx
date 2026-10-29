/**
 * Metrics Performance and Posture tabs (Round 3 / Feature 5; Round 14 page grammar).
 *
 * Mocks the co-located posture API + the shared `@/lib/api` and asserts:
 *   1. the Performance tab renders the server lifecycle p50 as a duration (an honest dash
 *      for a missing block), the percentile table, and the triage-quality strip with its
 *      window caption (FP rate falling reads as an improvement), and
 *   2. the Posture tab renders open-case aging with readable buckets and shares of the
 *      total, the SLA rollup (overage in plain words, case numbers as links to the case),
 *      and the MITRE ATT&CK coverage heatmap with its Navigator-layer export link.
 *
 * Fully offline: only the data calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock, fetchMitreMock, breakdownMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
  breakdownMock: vi.fn(),
}));

vi.mock('@/lib/api-dashboards', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api-dashboards')>('@/lib/api-dashboards')),
  getMetricsBreakdown: breakdownMock,
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

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: {
    getMetrics: vi.fn().mockResolvedValue({
      total_cases: 10,
      open_cases: 4,
      needs_human_cases: 1,
      closed_cases: 6,
      by_status: {},
      by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 5, NEEDS_HUMAN: 1, none: 2 },
      persona_usage: {},
      runbook_usage: {},
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

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ authEnabled: false, hasPermission: () => true }),
}));

import Metrics, { slaRowTiming } from '../pages/Metrics';
import { resetAnalyticsWindowForTests } from '../pages/analytics-shared';
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
      { case_id: 'c1', case_number: 'TLSOC-1', age_hours: 30.5, status: 'investigating', risk_score: 70 },
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
        state: 'breached', elapsed_minutes: 18673, target_minutes: 60, over_pct: 31000,
      },
      {
        case_id: 'c2', case_number: 'TLSOC-2', priority: 'P2', clock: 'resolve',
        state: 'at_risk', elapsed_minutes: 200, target_minutes: 240, over_pct: -17,
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
    resetAnalyticsWindowForTests();
    fetchPostureMock.mockReset();
    fetchMitreMock.mockReset();
    fetchPostureMock.mockResolvedValue(POSTURE);
    fetchMitreMock.mockResolvedValue(MITRE);
    breakdownMock.mockReset().mockResolvedValue(null);
  });

  it('renders the Performance tab with the server lifecycle p50 + honest dash', async () => {
    render(<Metrics tab="performance" />);

    const timing = await screen.findByTestId('performance-timing-strip');
    // MTTA p50 45 minutes; MTTR p50 180 minutes reads "3h" (never "180m").
    expect(within(timing).getByTestId('kpi-timing-mtta')).toHaveTextContent('45m');
    expect(within(timing).getByTestId('kpi-timing-mtta')).toHaveTextContent('8 samples, last 7 days');
    expect(within(timing).getByTestId('kpi-timing-mttr')).toHaveTextContent('3h');
    // Dwell is unavailable: its tile shows the honest reason, not a fake 0.
    const dwell = within(timing).getByTestId('kpi-timing-dwell');
    expect(dwell).toHaveTextContent('—');
    expect(dwell).toHaveTextContent(/no case has received a first response yet/i);

    // The percentile table: one row per interval, durations in plain units.
    const table = screen.getByRole('table', { name: 'Lifecycle timing percentiles' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((r) => r.querySelector('td,th')?.textContent)).toEqual([
      'Interval',
      'Time to acknowledge',
      'Time to resolve',
      expect.stringContaining('Time to first response'),
    ]);
    expect(within(rows[2]).getByText('10h')).toBeInTheDocument();
    expect(within(rows[2]).getByText('15h')).toBeInTheDocument();

    // FP-rate quality tile renders as a percent (0.625 is 63%) under the window caption.
    const quality = screen.getByTestId('performance-quality');
    expect(quality).toHaveTextContent('Triage quality');
    expect(quality).toHaveTextContent('last 7 days');
    expect(within(quality).getByText('FP rate')).toBeInTheDocument();
    expect(within(quality).getByText('63%')).toBeInTheDocument();
    expect(screen.getByText(/with the window just before it/)).toBeInTheDocument();
  });

  it('says the posture rollup is unavailable instead of drawing zeros', async () => {
    fetchPostureMock.mockRejectedValue(new Error('down'));
    render(<Metrics tab="performance" />);
    expect(await screen.findByText('Performance figures are not available')).toBeInTheDocument();
    expect(screen.queryByTestId('performance-timing-strip')).toBeNull();
  });

  it('renders the Posture tab with the MITRE heatmap + Navigator export link', async () => {
    render(<Metrics tab="posture" />);

    // The MITRE coverage module + a covered technique id render; the spelling is MITRE.
    const mitre = await screen.findByTestId('posture-mitre');
    expect(within(mitre).getByText('MITRE ATT&CK coverage')).toBeInTheDocument();
    expect(mitre).toHaveTextContent('all cases');
    expect(within(mitre).getAllByText('T1059').length).toBeGreaterThan(0);

    // The Navigator-layer export link points at the JSON endpoint.
    const exportLink = screen.getByRole('link', { name: /export att&ck navigator layer/i });
    expect(exportLink).toHaveAttribute('href', '/api/mitre/coverage/navigator.layer.json');
  });

  it('shows open-case aging with readable buckets, shares and durations', async () => {
    render(<Metrics tab="posture" />);
    const aging = await screen.findByTestId('posture-aging');
    expect(aging).toHaveTextContent('Open-case aging');
    // 30.5 hours is "1d 6h", named by its case number.
    expect(within(aging).getByText('1d 6h')).toBeInTheDocument();
    expect(aging).toHaveTextContent('TLSOC-1');
    expect(screen.getByText('1 to 4 hours')).toBeInTheDocument();
    expect(screen.getByText('50% of 4')).toBeInTheDocument();
    expect(screen.queryByText('1-4h')).toBeNull();
    const oldest = screen.getByRole('list', { name: 'Oldest open cases' });
    expect(within(oldest).getByRole('link', { name: 'Open TLSOC-1' })).toHaveAttribute(
      'href',
      '#/case_manager?caseId=c1',
    );
  });

  it('lists SLA rows with the overage in plain words and links to each case', async () => {
    const navigate = vi.fn();
    render(<Metrics tab="posture" onNavigate={navigate} />);
    const sla = await screen.findByTestId('posture-sla');
    expect(sla).toHaveTextContent('SLA attainment');
    expect(within(sla).getByText('88%')).toBeInTheDocument();

    const rows = within(screen.getByRole('list', { name: 'Cases breaching or at risk' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Breached');
    expect(rows[0]).toHaveTextContent('Response target, P1');
    expect(rows[0]).toHaveTextContent('12d 22h over');
    expect(rows[0].textContent).not.toMatch(/\+\d+m/);
    expect(rows[1]).toHaveTextContent('At risk');
    expect(rows[1]).toHaveTextContent('40m left');

    const link = within(rows[0]).getByRole('link', { name: 'Open TLSOC-1' });
    await userEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('case_manager', { caseId: 'c1' });
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
    render(<Metrics tab="posture" />);
    const sla = await screen.findByTestId('posture-sla');
    await waitFor(() => expect(within(sla).getByText('Attainment')).toBeInTheDocument());
    const tile = within(sla).getByText('Attainment').closest('[data-testid^="kpi-"]') as HTMLElement;
    expect(tile.textContent).toContain('—');
    expect(tile.textContent).not.toContain('0%');
    expect(tile).toHaveTextContent(/no case in this window has a priority level/);
    expect(screen.getByText('No SLA breaches')).toBeInTheDocument();
  });

  it('says SLA tracking is off when no policy is set', async () => {
    fetchPostureMock.mockResolvedValue({ ...POSTURE, sla: { ...POSTURE.sla, enabled: false, reason: '' } });
    render(<Metrics tab="posture" />);
    expect(await screen.findByText('SLA tracking is off')).toBeInTheDocument();
    expect(screen.queryByTestId('posture-sla')).toBeNull();
  });

  it('never calls a failed posture read a setting: SLA is "not available", not "off"', async () => {
    fetchPostureMock.mockRejectedValue(new Error('down'));
    render(<Metrics tab="posture" />);
    expect(await screen.findByText('SLA attainment is not available')).toBeInTheDocument();
    expect(screen.queryByText('SLA tracking is off')).toBeNull();
    expect(screen.getByText('Aging is not available')).toBeInTheDocument();
  });

  it('draws no invented closure trend: arrivals and closures are the strip figures only', async () => {
    render(<Metrics tab="posture" />);
    const aging = await screen.findByTestId('posture-aging');
    expect(aging).toHaveTextContent('cases opened in the last 7 days');
    expect(within(aging).getByText('Arrivals')).toBeInTheDocument();
    expect(within(aging).getByText('Closures')).toBeInTheDocument();
    expect(screen.queryByText('Closure against arrival')).toBeNull();
    expect(screen.queryByRole('img', { name: /open backlog/i })).toBeNull();
    // The age buckets follow the window's cases, and the caption says so.
    expect(screen.getByRole('region', { name: 'Age distribution' })).toHaveTextContent(
      'open cases opened in the last 7 days',
    );
  });

  it('caps the breaching list with Show all instead of cutting rows silently', async () => {
    const breaching = Array.from({ length: 18 }, (_, i) => ({
      case_id: `c${i + 1}`,
      case_number: `TLSOC-${i + 1}`,
      priority: 'P2',
      clock: i % 2 ? 'resolution' : 'response',
      state: 'breached',
      elapsed_minutes: 600 - i,
      target_minutes: 60,
      over_pct: 900 - i,
    }));
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      sla: { ...POSTURE.sla, response_breached: 9, resolve_breached: 9, response_at_risk: 0, resolve_at_risk: 0, breaching },
    });
    render(<Metrics tab="posture" />);
    const panel = await screen.findByTestId('posture-breaching');
    const list = within(panel).getByRole('list', { name: 'Cases breaching or at risk' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(panel).toHaveTextContent('8 more not shown.');
    const toggle = within(panel).getByRole('button', { name: 'Show all 18' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    await userEvent.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(18);
    expect(within(panel).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('says which part of a server-capped breaching list it shows', async () => {
    const breaching = Array.from({ length: 25 }, (_, i) => ({
      case_id: `c${i + 1}`, case_number: `TLSOC-${i + 1}`, priority: 'P1', clock: 'response',
      state: 'breached', elapsed_minutes: 900 - i, target_minutes: 60, over_pct: 1400 - i,
    }));
    fetchPostureMock.mockResolvedValue({
      ...POSTURE,
      sla: { ...POSTURE.sla, response_breached: 31, resolve_breached: 0, response_at_risk: 0, resolve_at_risk: 0, breaching },
    });
    render(<Metrics tab="posture" />);
    const panel = await screen.findByTestId('posture-breaching');
    // Folded, the hidden count is against all 31, never only the 25 in hand.
    expect(panel).toHaveTextContent('21 more not shown; this list holds the 25 furthest past the target.');
    expect(panel).not.toHaveTextContent('15 more not shown');
    // The server lists the 25 furthest of 31: "Show 15 more", never "Show all".
    await userEvent.click(within(panel).getByRole('button', { name: 'Show 15 more' }));
    expect(panel).toHaveTextContent('Listing 25 of 31, furthest past the target first.');
    expect(panel).not.toHaveTextContent(/more not shown/);
  });

  it('caps the oldest open cases with Show all', async () => {
    const oldest = Array.from({ length: 10 }, (_, i) => ({
      case_id: `o${i + 1}`, case_number: `TLSOC-${100 + i}`, age_hours: 200 - i, status: 'investigating', risk_score: 50,
    }));
    fetchPostureMock.mockResolvedValue({ ...POSTURE, aging: { ...POSTURE.aging, queue_depth: 10, oldest } });
    render(<Metrics tab="posture" />);
    const panel = await screen.findByTestId('posture-oldest');
    const list = within(panel).getByRole('list', { name: 'Oldest open cases' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(panel).toHaveTextContent('2 more cases not shown.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Show all 10' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  });

  it('counts the folded oldest open list against the whole queue when the server sent part of it', async () => {
    const oldest = Array.from({ length: 10 }, (_, i) => ({
      case_id: `o${i + 1}`, case_number: `TLSOC-${100 + i}`, age_hours: 200 - i, status: 'investigating', risk_score: 50,
    }));
    fetchPostureMock.mockResolvedValue({ ...POSTURE, aging: { ...POSTURE.aging, queue_depth: 31, oldest } });
    render(<Metrics tab="posture" />);
    const panel = await screen.findByTestId('posture-oldest');
    const list = within(panel).getByRole('list', { name: 'Oldest open cases' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    // 31 open, 8 listed: 23 are not shown, not the 2 the client still holds.
    expect(panel).toHaveTextContent('23 more cases not shown; this list holds the 10 oldest.');
    expect(panel).not.toHaveTextContent('2 more cases not shown');
    await userEvent.click(within(panel).getByRole('button', { name: 'Show 2 more' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(panel).toHaveTextContent('Listing the 10 oldest of 31 open cases.');
    expect(panel).not.toHaveTextContent(/more cases? not shown/);
  });
});

describe('slaRowTiming', () => {
  it('reads past a target as an overage and before it as time left', () => {
    expect(slaRowTiming({ elapsed_minutes: 18673, target_minutes: 60 })).toBe('12d 22h over');
    expect(slaRowTiming({ elapsed_minutes: 120, target_minutes: 60 })).toBe('1h over');
    expect(slaRowTiming({ elapsed_minutes: 200, target_minutes: 240 })).toBe('40m left');
    expect(slaRowTiming({ elapsed_minutes: 60, target_minutes: 60 })).toBe('<1m left');
  });

  it('is a dash when either figure is missing', () => {
    expect(slaRowTiming({ elapsed_minutes: Number.NaN, target_minutes: 60 })).toBe('—');
  });
});
