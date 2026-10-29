/**
 * Analytics pages (Round 14, SPEC §4.9 and D25: one name per page).
 *
 * The Analytics navigation group opens three pages, each titled by its navigation label
 * and each with its own header (time range and one refresh beside the title):
 *
 *   `#/metrics`       Metrics: Operational | Performance | Posture (underline tabs)
 *   `#/effectiveness` Agent effectiveness: Agent health, then observed outcomes
 *   `#/cost`          Cost: the LLM spend ledger
 *
 * The navigation is the switcher between them, so the Metrics tab strip no longer repeats
 * Effectiveness or Cost. This spec pins:
 *   1. the host dispatch (`<Analytics tab=…>`), including older deep links,
 *   2. the page grammar (one h1 per page, the range and an icon refresh in the header),
 *   3. the Operational contracts (§4.9.4): a window caption on every tile, Needs human by
 *      verdict, Resolved or closed against active from the server's status split, bar
 *      shares of the total, Runbook usage (never "playbook"), the spend pointer as a link,
 *   4. the range shared across the Analytics pages for the session.
 *
 * Fully offline: only the data calls are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchPostureMock, fetchMitreMock, listRunbookLibraryMock, breakdownMock, authState, apiMock } = vi.hoisted(() => ({
  fetchPostureMock: vi.fn(),
  fetchMitreMock: vi.fn(),
  listRunbookLibraryMock: vi.fn(),
  breakdownMock: vi.fn(),
  authState: { canReadRunbooks: true },
  apiMock: {
    getMetrics: vi.fn(),
    ragStats: vi.fn(),
    getMemory: vi.fn(),
    getAgentImprovement: vi.fn(),
    usageSummary: vi.fn(),
    diagnosticsHealth: vi.fn(),
    autoCloseHealth: vi.fn(),
  },
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

vi.mock('@/soc/components/HealthDiagnostics', () => ({
  HealthDiagnostics: ({ windowHours, refreshKey }: { windowHours?: number; refreshKey?: number }) => (
    <section data-testid="analytics-health-diagnostics">
      health:{windowHours} refresh:{refreshKey}
    </section>
  ),
}));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    authEnabled: false,
    hasPermission: (resource: string, action: string) =>
      resource === 'runbooks' && action === 'read' ? authState.canReadRunbooks : true,
  }),
}));

vi.mock('@/lib/api-runbooks', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-runbooks')>('@/lib/api-runbooks');
  return { ...actual, listRunbookLibrary: listRunbookLibraryMock };
});

vi.mock('@/lib/api-dashboards', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-dashboards')>('@/lib/api-dashboards');
  return { ...actual, getMetricsBreakdown: breakdownMock };
});

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: apiMock };
});

import Analytics from '../pages/Analytics';
import Metrics, { openNeedsHuman } from '../pages/Metrics';
import Cost from '../pages/Cost';
import { resetAnalyticsWindowForTests } from '../pages/analytics-shared';
import type { PostureResponse } from '../pages/Metrics.posture.api';

const METRICS = {
  total_cases: 8,
  open_cases: 3,
  needs_human_cases: 1,
  closed_cases: 5,
  // The status split the server counted: 5 resolved or closed, 3 still active.
  by_status: { new: 1, investigating: 2, resolved: 2, closed: 3 },
  by_verdict: { TRUE_POSITIVE: 2, FALSE_POSITIVE: 4, NEEDS_HUMAN: 1, none: 1 },
  by_disposition: {},
  persona_usage: { network: 3, identity: 1 },
  playbook_usage: {},
  runbook_usage: { 'rb-phish': 3, none: 1 },
  avg_risk_score: 40,
  mttr_minutes: 90,
  resolved_count: 5,
  cases_per_day: [],
  counts_exact: true,
  store_total: 8,
  fetched: 8,
  truncated: false,
  feedback: {
    graded_cases: 0, feedback_count: 0, agreement_rate: 0,
    avg_accuracy: 0, avg_reasoning_quality: 0, avg_action_appropriateness: 0,
    time_saved_minutes: 0, outcome_distribution: {},
  },
  retrieval_history: {
    status: 'unavailable', available: false,
    reason: '3 investigated cases have unavailable historical retrieval instrumentation.',
    loaded_cases: 8, total_cases: 8, truncated: false, eligible_cases: 7,
    history_available_cases: 4, history_unavailable_cases: 3,
    completed_attempt_cases: 2, cases_with_references: null,
    reference_coverage: null,
    formula: 'cases with references / completed retrieval attempts',
  },
  // The compact Operational spend pointer reads these; the full ledger is the Cost page.
  cost: { total_cost: 1.23, total_tokens: 45000, call_count: 12, currency: 'USD' },
};

const EVIDENCE = {
  generated_at: '2026-07-28T00:00:00Z',
  synthetic: false,
  windows: {
    as_of_exclusive: '2026-07-28',
    current: { start: '2026-07-21', end_exclusive: '2026-07-28', days: 7 },
    baseline: { start: '2026-06-23', end_exclusive: '2026-07-21', days: 28 },
    timezone: 'UTC', complete_days_only: true,
  },
  headline: {
    state: 'insufficient_evidence',
    reason: 'Complete comparable cohorts are required before declaring improvement.',
    improving_signals: 0, regressing_signals: 0, guardrails_ready: false,
    comparable_mix_coverage: 0, minimum_comparable_mix_coverage: 0.8,
    composite_score: null,
    signal_domains: {
      analyst_grade_quality: 'insufficient_evidence',
      human_review_turnaround: 'insufficient_evidence',
    },
  },
  metrics: Object.fromEntries([
    ['analyst_reported_verdict_agreement', ['Analyst-reported verdict agreement', 'ratio', 'up']],
    ['material_analyst_correction_rate', ['Material analyst correction rate', 'ratio', 'down']],
    ['human_review_turnaround', ['Human review turnaround', 'minutes', 'down']],
  ].map(([key, [label, unit, good_direction]]) => [key, {
    label, unit, good_direction,
    current: { value: null, available: false, status: 'unavailable', reason: 'No eligible observations.', sample_count: 0, minimum_sample: 20 },
    baseline: { value: null, available: false, status: 'unavailable', reason: 'No eligible observations.', sample_count: 0, minimum_sample: 20 },
    delta: {}, direction: 'insufficient_evidence',
    definition: { formula: 'aggregate formula', numerator: 'eligible outcomes', denominator: 'eligible cases', eligibility: 'complete UTC days', caveats: 'Observed outcomes only.' },
  }])),
  guardrails: {
    confirmed_false_negative_rate: {
      status: 'unavailable', minimum_sample: 20,
      current: { value: null, confirmed_positive_count: 0, missed_positive_count: 0 },
      baseline: { value: null, confirmed_positive_count: 0, missed_positive_count: 0 },
      material_increase_threshold: 0.01, breached: null,
      definition: 'Missed confirmed positives divided by confirmed positives.',
    },
    reopen_after_agent_close_rate: {
      status: 'not_applicable', minimum_sample: 20,
      current: { candidate_agent_terminal_decisions: 0, eligible_agent_terminal_decisions: 0, right_censored_decisions: 0, human_reopens: 0, rate: null, follow_up_hours: 24 },
      baseline: { candidate_agent_terminal_decisions: 0, eligible_agent_terminal_decisions: 0, right_censored_decisions: 0, human_reopens: 0, rate: null, follow_up_hours: 24 },
      material_increase_threshold: 0.02, breached: null,
      caveat: 'Only complete 24-hour follow-up windows are eligible.',
    },
  },
  case_mix: {
    dimensions: ['source', 'severity'], minimum_per_stratum: 5,
    baseline_total: 0, current_total: 0, baseline_covered: 0, current_covered: 0,
    comparable_mix_coverage: 0, baseline_mix_coverage: 0, current_mix_coverage: 0,
    comparable_strata: 0, baseline_only_strata: 0, current_only_strata: 0,
    suppressed_strata: 0, adjusted_baseline_agreement: null,
    adjusted_current_agreement: null, adjusted_baseline_correction_rate: null,
    adjusted_current_correction_rate: null,
  },
  daily_points: [], exclusions: {},
  provenance: { truncated: false, store_total: 0, fetched: 0, aggregate_only: true, case_ids_included: false, billing: 'none', decision_authority: 'reporting_only' },
};

const USAGE = {
  total_cost: 1.23,
  total_tokens: 45000,
  call_count: 12,
  today_cost: 0.5,
  currency: 'USD',
  cost_over_time: [{ cost: 0.4 }, { cost: 0.83 }],
  by_model: [{ key: 'claude-x', cost: 1.23, tokens: 45000, calls: 12 }],
  by_role: [],
  by_surface: [],
  top_cost_drivers: [],
};

const POSTURE: PostureResponse = {
  window_hours: 168,
  generated_at: '2026-07-01T08:00:00Z',
  case_count: 8,
  lifecycle: {
    mtta_minutes: { p50: 30, p90: 90, mean: 45, max: 150, count: 6, available: true, reason: '' },
    mttr_minutes: { p50: 90, p90: 300, mean: 150, max: 500, count: 5, available: true, reason: '' },
    dwell_minutes: { p50: '—', p90: '—', mean: '—', max: '—', count: 0, available: false, reason: 'no first response yet' },
  },
  quality: {
    total_cases: 8, verdicted_cases: 7, true_positive_cases: 2, false_positive_cases: 4,
    needs_human_cases: 1, escalated_cases: 1, terminal_cases: 5, auto_closed_cases: 2,
    alert_to_incident_ratio: 0.25, false_positive_rate: 0.5, escalation_rate: 0.12,
    containment_rate: 0.6, automation_rate: 0.4,
  },
  aging: {
    queue_depth: 3, age_buckets: [], oldest: [], arrivals: 8, closures: 5,
    closure_vs_arrival: 0.6, backlog: 3,
  },
  sla: { enabled: false, evaluated: 0, response_breached: 0, response_at_risk: 0, resolve_breached: 0, resolve_at_risk: 0, attainment_pct: 0, breaching: [], reason: 'off' },
  compare: undefined,
};

/** The open cases by AI verdict (`GET /api/metrics/breakdown?by=verdict&status_group=open`). */
const OPEN_BY_VERDICT = {
  kind: 'cases', by: 'verdict', then: null, bucket: null, status_group: 'open',
  window_label: 'All time', window_from: null, window_to: null,
  total: 3, exact: true, partial: false, partial_reason: null, multi_valued: false,
  groups: [
    { key: 'NEEDS_HUMAN', then_key: null, bucket: null, count: 2 },
    { key: 'TRUE_POSITIVE', then_key: null, bucket: null, count: 1 },
  ],
  buckets: [], other: null, missing_created: 0, missing_in_total: true,
};

/** Every visible text node and attribute value a reader or screen reader gets. */
function readableText(root: HTMLElement): string {
  const attrs = Array.from(root.querySelectorAll('[aria-label],[title],[placeholder]'))
    .map((el) => ['aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a) ?? '').join(' '))
    .join(' ');
  return `${root.textContent ?? ''} ${attrs}`;
}

/** Pick a range in the page header's Overview pill. */
async function pickRange(label: string) {
  await userEvent.click(screen.getByRole('button', { name: /^Time range:/ }));
  const group = await screen.findByRole('group', { name: 'Relative time ranges' });
  await userEvent.click(within(group).getByRole('button', { name: new RegExp(`^${label}`) }));
}

beforeEach(() => {
  resetAnalyticsWindowForTests();
  authState.canReadRunbooks = true;
  fetchPostureMock.mockReset().mockResolvedValue(POSTURE);
  fetchMitreMock.mockReset().mockResolvedValue(null);
  listRunbookLibraryMock.mockReset().mockResolvedValue({
    runbooks: [{ id: 'rb-phish', title: 'Phishing triage' }],
  });
  apiMock.getMetrics.mockReset().mockResolvedValue(METRICS);
  apiMock.ragStats.mockReset().mockResolvedValue(null);
  apiMock.getMemory.mockReset().mockResolvedValue(null);
  apiMock.getAgentImprovement.mockReset().mockResolvedValue(EVIDENCE);
  apiMock.usageSummary.mockReset().mockResolvedValue(USAGE);
  breakdownMock.mockReset().mockResolvedValue(OPEN_BY_VERDICT);
});

afterEach(() => {
  cleanup();
  resetAnalyticsWindowForTests();
});

describe('Analytics host: one page per navigation destination', () => {
  it('opens Metrics by default, titled Metrics, with three underline tabs and no page tabs', async () => {
    render(<Analytics onNavigate={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Metrics' })).toBeInTheDocument();
    const strip = screen.getByTestId('metrics-tabs');
    expect(strip).toHaveAccessibleName('Metrics views');
    const tabs = within(strip).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Operational', 'Performance', 'Posture']);
    // The navigation is the switcher: no Effectiveness or Cost tab repeats it.
    expect(within(strip).queryByRole('tab', { name: /effectiveness/i })).toBeNull();
    expect(within(strip).queryByRole('tab', { name: /^cost$/i })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('opens Agent effectiveness for tab="effectiveness", health above the observed outcomes', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="effectiveness" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Agent effectiveness' })).toBeInTheDocument();
    expect(screen.queryByTestId('metrics-tabs')).toBeNull();
    const health = await screen.findByTestId('analytics-health-diagnostics');
    const report = await screen.findByTestId('agent-effectiveness');
    expect(health.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(health).toHaveTextContent('health:168');
  });

  it('opens Cost for tab="cost", the single spend home', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="cost" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cost' })).toBeInTheDocument();
    expect(await screen.findByText(/detailed cost ledger/i)).toBeInTheDocument();
    expect(screen.getAllByText('claude-x').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('metrics-tabs')).toBeNull();
  });

  it('honours a Metrics tab from the route and mirrors a tab change into the route', async () => {
    const navigate = vi.fn();
    render(<Analytics onNavigate={navigate} tab="performance" />);
    const strip = await screen.findByTestId('metrics-tabs');
    expect(within(strip).getByRole('tab', { name: 'Performance' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(strip).getByRole('tab', { name: 'Posture' }));
    expect(navigate).toHaveBeenCalledWith('metrics', { tab: 'posture' });
  });

  it('switches the Metrics tabs from the keyboard and keeps only the selected panel in the layout', async () => {
    const navigate = vi.fn();
    render(<Analytics onNavigate={navigate} />);
    const strip = await screen.findByTestId('metrics-tabs');
    await screen.findByTestId('analytics-kpi-strip');
    const operational = within(strip).getByRole('tab', { name: 'Operational' });
    act(() => operational.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(navigate).toHaveBeenLastCalledWith('metrics', { tab: 'performance' });
    const performance = within(strip).getByRole('tab', { name: 'Performance' });
    expect(performance).toHaveFocus();
    expect(performance).toHaveAttribute('aria-selected', 'true');
    // An inactive panel stays hidden: no display utility on the panel overrides `hidden`,
    // so its margin never pushes the selected panel down.
    for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
      expect(panel.className).not.toMatch(/(^|\s)(flex|grid|block)(\s|$)/);
    }
  });

  it('falls back to Operational for an unknown tab', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="nonsense" />);
    const strip = await screen.findByTestId('metrics-tabs');
    expect(within(strip).getByRole('tab', { name: 'Operational' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Metrics page header', () => {
  it('carries the range pill and an icon refresh, and no sort control', async () => {
    render(<Metrics />);
    await screen.findByTestId('analytics-kpi-strip');
    const header = document.querySelector('[data-page-header="page"]') as HTMLElement;
    expect(header).not.toBeNull();
    const controls = header.querySelector('[data-page-header-controls]') as HTMLElement;
    expect(within(controls).getByRole('button', { name: 'Time range: Last 7 days' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Refresh metrics' })).toBeInTheDocument();
    // Sorting belongs to the ranked module it sorts, never to the page header.
    expect(within(header).queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Sort persona usage' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Sort runbook usage' })).toBeInTheDocument();
    expect(await within(header).findByTestId('analytics-updated')).toHaveTextContent(/^Updated /);
  });

  it('reads the metrics again for a new range and on refresh', async () => {
    render(<Metrics />);
    await screen.findByTestId('analytics-kpi-strip');
    expect(apiMock.getMetrics).toHaveBeenLastCalledWith(168);
    expect(fetchPostureMock).toHaveBeenLastCalledWith(168, 'prev');
    await pickRange('Last 24 hours');
    await waitFor(() => expect(apiMock.getMetrics).toHaveBeenLastCalledWith(24));
    expect(fetchPostureMock).toHaveBeenLastCalledWith(24, 'prev');
    // MITRE coverage spans every case, whatever the range.
    expect(fetchMitreMock).toHaveBeenLastCalledWith(0);
    const calls = apiMock.getMetrics.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh metrics' }));
    await waitFor(() => expect(apiMock.getMetrics.mock.calls.length).toBe(calls + 1));
  });

  it('shows a load failure with a retry instead of an empty page', async () => {
    apiMock.getMetrics.mockRejectedValueOnce(new Error('boom'));
    render(<Metrics />);
    expect(await screen.findByText('Could not load metrics')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-kpi-strip')).toBeNull();
  });
});

describe('Metrics Operational tab (§4.9.4)', () => {
  it('captions every summary tile with its window and counts from the server split', async () => {
    render(<Metrics />);
    const strip = await screen.findByTestId('analytics-kpi-strip');
    // Needs human is the OPEN cases whose AI verdict is Needs human (the Standup and
    // dashboard figure), read from the open-by-verdict breakdown: 2, never the all-time
    // by_verdict count (1 here), which also counts cases an analyst already closed.
    const needsHuman = within(strip).getByTestId('kpi-needs_human');
    expect(needsHuman).toHaveTextContent('Needs human');
    await waitFor(() => expect(needsHuman).toHaveTextContent('2'));
    expect(needsHuman).toHaveTextContent('open now, AI verdict');
    expect(breakdownMock).toHaveBeenCalledWith({ by: 'verdict', status_group: 'open', window: 'all' });
    // Resolved or closed, then the active remainder, both from by_status.
    const closed = within(strip).getByTestId('kpi-closed');
    expect(closed).toHaveTextContent('Resolved or closed');
    expect(closed).toHaveTextContent('5');
    expect(closed).toHaveTextContent('3 active, all time');
    expect(within(strip).getByTestId('kpi-total')).toHaveTextContent('Every case in the store');
    expect(within(strip).getByTestId('kpi-mttr')).toHaveTextContent('5 closed, all time');
    expect(within(strip).getByTestId('kpi-agreement')).toHaveTextContent('all time');
    expect(within(strip).getByTestId('kpi-risk')).toHaveTextContent('0 to 100, all time');
    // Figures inform; they do not navigate (SPEC §3.3: only links navigate). The only
    // controls on the strip are the "About …" help tips.
    expect(within(strip).queryByRole('link')).toBeNull();
    const buttons = within(strip).queryAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['About Needs human', 'About MTTR']);
  });

  it('shows a dash, not a count, when the open-by-verdict read is refused', async () => {
    breakdownMock.mockRejectedValue(new Error('row-level scope'));
    render(<Metrics />);
    const strip = await screen.findByTestId('analytics-kpi-strip');
    const needsHuman = within(strip).getByTestId('kpi-needs_human');
    expect(needsHuman).toHaveTextContent('—');
    expect(needsHuman).toHaveTextContent('open now, not available');
    expect(needsHuman).not.toHaveTextContent(/^1/);
  });

  it('says "status split not reported" rather than inventing the split', async () => {
    apiMock.getMetrics.mockResolvedValue({ ...METRICS, by_status: {} });
    render(<Metrics />);
    const strip = await screen.findByTestId('analytics-kpi-strip');
    expect(within(strip).getByTestId('kpi-closed')).toHaveTextContent('status split not reported');
  });

  it('captions figures over a truncated read with the population they cover', async () => {
    apiMock.getMetrics.mockResolvedValue({ ...METRICS, truncated: true, fetched: 5000, store_total: 12000 });
    render(<Metrics />);
    const strip = await screen.findByTestId('analytics-kpi-strip');
    expect(within(strip).getByTestId('kpi-mttr')).toHaveTextContent('newest 5,000 of 12,000 cases');
  });

  it('shows each bar as a share of the total, never of the largest bar', async () => {
    render(<Metrics />);
    await screen.findByTestId('analytics-kpi-strip');
    // network 3 and identity 1 of 4 routed cases.
    expect(screen.getAllByText('75% of 4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('25% of 4').length).toBeGreaterThan(0);
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('names runbooks by their library title, with "No runbook" for none, and never says playbook', async () => {
    const { container } = render(<Metrics />);
    expect(await screen.findByText('Runbook usage')).toBeInTheDocument();
    expect(await screen.findByText('Phishing triage')).toBeInTheDocument();
    expect(screen.getByText('No runbook')).toBeInTheDocument();
    expect(listRunbookLibraryMock).toHaveBeenCalledWith({ show_replaced: true }, expect.any(AbortSignal));
    expect(readableText(container)).not.toMatch(/playbook/i);
  });

  it('keeps runbook ids when the viewer cannot read the runbook library', async () => {
    authState.canReadRunbooks = false;
    render(<Metrics />);
    expect(await screen.findByText('rb-phish')).toBeInTheDocument();
    expect(listRunbookLibraryMock).not.toHaveBeenCalled();
  });

  it('says so when the server does not report runbook usage', async () => {
    const { runbook_usage: _drop, ...older } = METRICS;
    apiMock.getMetrics.mockResolvedValue(older);
    render(<Metrics />);
    expect(await screen.findByText('This server does not report runbook usage.')).toBeInTheDocument();
  });

  it('sorts one ranked module A to Z without touching the others', async () => {
    render(<Metrics />);
    const sort = await screen.findByRole('radiogroup', { name: 'Sort persona usage' });
    await userEvent.click(within(sort).getByRole('radio', { name: 'A to Z' }));
    const persona = screen.getByText('Persona usage').closest('section') as HTMLElement;
    const labels = within(persona).getAllByText(/^(Identity|Network)$/).map((n) => n.textContent);
    expect(labels).toEqual(['Identity', 'Network']);
    const runbookSort = screen.getByRole('radiogroup', { name: 'Sort runbook usage' });
    expect(within(runbookSort).getByRole('radio', { name: 'Count' })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows unavailable retrieval history without fabricating zero coverage', async () => {
    render(<Metrics />);
    expect(await screen.findByText('Knowledge reference coverage')).toBeInTheDocument();
    expect(
      screen.getByText(/3 investigated cases have unavailable historical retrieval instrumentation/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/4 of 7 investigated cases/i)).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText(/retrieval quality/i)).toBeNull();
  });

  it('keeps a compact spend pointer that is a link to the Cost page', async () => {
    const navigate = vi.fn();
    render(<Metrics onNavigate={navigate} />);
    const spend = await screen.findByTestId('analytics-spend');
    expect(spend).toHaveTextContent('$1.23');
    const link = screen.getByRole('link', { name: 'Open Cost' });
    expect(link).toHaveAttribute('href', '#/cost');
    // The full ledger lives only on the Cost page.
    expect(screen.queryByText(/detailed cost ledger/i)).toBeNull();
    await userEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('cost', undefined);
  });

  it('shows the knowledge base and memory as a titled strip module, keeping one KPI strip on the page', async () => {
    apiMock.ragStats.mockResolvedValue({
      document_count: 12, total_chunks: 340, dim: 1536, embedding_model: 'text-embedding-3-small',
      by_source: { runbook: 9, mitre: 3 },
    });
    apiMock.getMemory.mockResolvedValue({ count: 4, entries: [
      { id: 'm1', source: 'human', active: true },
      { id: 'm2', source: 'agent', active: false },
    ] });
    const { container } = render(<Metrics />);
    const strip = await screen.findByTestId('analytics-knowledge-strip');
    // A module of its own: a labelled region named by its h2, with the strip on the panel.
    expect(strip).toHaveAccessibleName('Knowledge base and memory');
    expect(within(strip).getByRole('heading', { level: 2, name: 'Knowledge base and memory' })).toBeInTheDocument();
    expect(strip.querySelector('[data-strip-panel]')).not.toBeNull();
    // One KPI strip per page (§4.9.1): the Operational summary is the only one.
    expect(container.querySelectorAll('[data-kpi-strip]')).toHaveLength(1);
    expect(within(screen.getByTestId('analytics-kpi-strip')).queryByText('Embedding dimensions')).toBeNull();
    const model = within(strip).getByTestId('kpi-embedding-model');
    expect(model).toHaveTextContent('1,536');
    expect(model).toHaveTextContent('text-embedding-3-small');
    expect(strip).toHaveTextContent('Active memory');
    // The two breakdowns are modules beside it, at the same outline level.
    expect(screen.getByRole('heading', { level: 2, name: /Corpus by source/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Memory by author/ })).toBeInTheDocument();
    // Known corpus sources keep their proper names ("MITRE", never "Mitre").
    expect(screen.getByText('MITRE ATT&CK')).toBeInTheDocument();
    expect(screen.queryByText('Mitre')).toBeNull();
  });

  it('shows an empty state, not zeros, before any case exists', async () => {
    apiMock.getMetrics.mockResolvedValue({ ...METRICS, total_cases: 0 });
    render(<Metrics />);
    expect(await screen.findByText('No cases yet')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-kpi-strip')).toBeNull();
  });
});

describe('openNeedsHuman', () => {
  const answer = (over: Record<string, unknown> = {}) => ({ ...OPEN_BY_VERDICT, ...over }) as never;

  it('reads the Needs human group of the open-by-verdict answer', () => {
    expect(openNeedsHuman(answer())).toEqual({ value: 2, partial: false });
  });

  it('is zero when an uncut answer has no Needs human group, unknown when top cut it', () => {
    const groups = [{ key: 'TRUE_POSITIVE', then_key: null, bucket: null, count: 1 }];
    expect(openNeedsHuman(answer({ groups }))).toEqual({ value: 0, partial: false });
    expect(openNeedsHuman(answer({ groups, other: { count: 4, groups: 1, calls: null, cost_usd: null } }))).toEqual({
      value: null,
      partial: false,
    });
  });

  it('marks a partial answer and reads nothing from a missing one', () => {
    expect(openNeedsHuman(answer({ exact: false, partial: true }))).toEqual({ value: 2, partial: true });
    expect(openNeedsHuman(null)).toEqual({ value: null, partial: false });
  });
});

describe('captions name the range of the figures on screen', () => {
  it('keeps the previous range under its own captions when a new range cannot be read', async () => {
    render(<Metrics />);
    await screen.findByTestId('analytics-spend');
    apiMock.getMetrics.mockRejectedValueOnce(new Error('boom'));
    await pickRange('Last 24 hours');
    expect(
      await screen.findByText('Could not load the last 24 hours; showing the last 7 days'),
    ).toBeInTheDocument();
    // The pill says what was picked; the figures still say what they are.
    expect(screen.getByRole('button', { name: 'Time range: Last 24 hours' })).toBeInTheDocument();
    const spend = screen.getByRole('region', { name: 'LLM spend' });
    expect(spend).toHaveTextContent('last 7 days');
    expect(spend).not.toHaveTextContent('last 24 hours');
  });

  it('captions Performance with the range its figures were read for', async () => {
    render(<Metrics tab="performance" />);
    const quality = await screen.findByTestId('performance-quality');
    expect(quality).toHaveTextContent('last 7 days');
    apiMock.getMetrics.mockRejectedValueOnce(new Error('boom'));
    await pickRange('Last 30 days');
    await screen.findByText('Could not load the last 30 days; showing the last 7 days');
    expect(screen.getByTestId('performance-quality')).toHaveTextContent('last 7 days');
    expect(screen.getByTestId('performance-quality')).not.toHaveTextContent('last 30 days');
  });

  it('keeps Cost captions on the range of the summary on screen when the new read fails', async () => {
    render(<Cost />);
    const strip = await screen.findByTestId('cost-kpi-strip');
    expect(within(strip).getByTestId('kpi-cost-total')).toHaveTextContent('$1.23');
    apiMock.usageSummary.mockRejectedValueOnce(new Error('503'));
    await pickRange('Last 30 days');
    expect(
      await screen.findByText('Could not load the last 30 days; showing the last 7 days'),
    ).toBeInTheDocument();
    const total = within(screen.getByTestId('cost-kpi-strip')).getByTestId('kpi-cost-total');
    expect(total).toHaveTextContent('last 7 days');
    expect(screen.getByTestId('cost-ledger')).toHaveTextContent('last 7 days');
    expect(screen.getByTestId('cost-ledger')).not.toHaveTextContent('last 30 days');
  });
});

describe('Agent effectiveness page', () => {
  it('keeps weak evidence explicit and never invents an agent score', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="effectiveness" />);
    expect(await screen.findByText(/not enough evidence to assess change/i)).toBeInTheDocument();
    expect(screen.getByText(/not a model-learning score/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent score/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-effectiveness-footer')).toHaveTextContent(/^Reporting only/);
  });

  it('collapses the still-collecting details behind a disclosure', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="effectiveness" />);
    const toggle = await screen.findByRole('button', { name: 'Show details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The disclosure names an element that exists in both states, hidden while folded.
    const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute('hidden');
    // No display utility while folded: a `flex` class would override `hidden` and show it.
    expect(details!.className).not.toMatch(/(^|\s)(flex|grid|block)(\s|$)/);
    expect(screen.queryByRole('region', { name: 'Outcome comparisons' })).toBeNull();
    // Neither guardrail is evaluable in this fixture, so the guardrails fold too.
    expect(screen.queryByRole('region', { name: 'Safety guardrails' })).toBeNull();
    expect(screen.getByTestId('agent-effectiveness-details-toggle')).toHaveTextContent(/safety guardrails/);
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    expect(details).not.toHaveAttribute('hidden');
    expect(screen.getByRole('region', { name: 'Outcome comparisons' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Safety guardrails' })).toBeInTheDocument();
  });

  it('never folds a guardrail the server could evaluate, even under a still-collecting headline', async () => {
    apiMock.getAgentImprovement.mockResolvedValue({
      ...EVIDENCE,
      guardrails: {
        ...EVIDENCE.guardrails,
        confirmed_false_negative_rate: {
          ...EVIDENCE.guardrails.confirmed_false_negative_rate,
          status: 'enough_data',
          breached: true,
          current: { value: 0.06, confirmed_positive_count: 50, missed_positive_count: 3 },
          baseline: { value: 0.02, confirmed_positive_count: 50, missed_positive_count: 1 },
        },
      },
    });
    render(<Analytics onNavigate={vi.fn()} tab="effectiveness" />);
    // Without pressing Show details: the breached guardrail is on the page.
    const guardrails = await screen.findByRole('region', { name: 'Safety guardrails' });
    expect(within(guardrails).getByText('Guardrail breached')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-expanded', 'false');
    // The fold no longer claims the guardrails are still collecting.
    expect(screen.getByTestId('agent-effectiveness-details-toggle')).not.toHaveTextContent(/safety guardrails/);
    // It appears once, outside the fold.
    expect(screen.getAllByTestId('agent-guardrails')).toHaveLength(1);
    expect(screen.getByTestId('agent-effectiveness-details')).not.toContainElement(guardrails);
  });

  it('labels each module by its own h2, so the outline does not nest them under another', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="effectiveness" />);
    await screen.findByRole('button', { name: 'Show details' });
    expect(screen.getByRole('region', { name: 'Evidence coverage' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Evidence coverage' })).toBeInTheDocument();
  });

  it('moves Agent health with the header range and refreshes both reads at once', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="effectiveness" />);
    expect(await screen.findByTestId('analytics-health-diagnostics')).toHaveTextContent('health:168 refresh:0');
    await pickRange('Last 24 hours');
    expect(await screen.findByTestId('analytics-health-diagnostics')).toHaveTextContent('health:24');
    const reads = apiMock.getAgentImprovement.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh agent effectiveness' }));
    await waitFor(() => expect(apiMock.getAgentImprovement.mock.calls.length).toBe(reads + 1));
    expect(screen.getByTestId('analytics-health-diagnostics')).toHaveTextContent('refresh:1');
  });
});

describe('Cost page', () => {
  it('captions the spend strip with its window and ranks one breakdown module', async () => {
    apiMock.usageSummary.mockResolvedValue({
      ...USAGE,
      by_model: [
        { key: 'claude-x', cost: 0.9, tokens: 30000, calls: 8 },
        { key: 'gpt-y', cost: 0.33, tokens: 15000, calls: 4 },
      ],
      by_role: [{ key: 'investigator', cost: 1.23, tokens: 45000, calls: 12 }],
    });
    render(<Cost />);
    const strip = await screen.findByTestId('cost-kpi-strip');
    expect(within(strip).getByTestId('kpi-cost-total')).toHaveTextContent('last 7 days');
    expect(within(strip).getByTestId('kpi-cost-calls')).toHaveTextContent('12');
    // Every tile measured over the range names it (§4.9.4); "Today" is today.
    for (const id of ['cost-tokens', 'cost-calls', 'cost-per-call', 'cost-per-1k', 'cost-tokens-per-call']) {
      expect(within(strip).getByTestId(`kpi-${id}`)).toHaveTextContent('last 7 days');
    }
    expect(within(strip).getByTestId('kpi-cost-today')).not.toHaveTextContent('last 7 days');
    expect(screen.getByRole('region', { name: 'Cost composition' })).toHaveTextContent('last 7 days, by model');
    const breakdown = screen.getByTestId('cost-breakdown');
    expect(within(breakdown).getByRole('heading', { name: 'By model' })).toBeInTheDocument();
    expect(within(breakdown).getByRole('heading', { name: 'By role' })).toBeInTheDocument();
    expect(within(breakdown).getByRole('heading', { name: 'By surface' })).toBeInTheDocument();
    // One sort for the whole module, beside its title.
    expect(within(breakdown).getByRole('radiogroup', { name: 'Rank breakdowns by' })).toBeInTheDocument();
    expect(screen.getByTestId('cost-ledger')).toHaveTextContent('Detailed cost ledger');
  });

  it('names roles and surfaces with their acronyms and shows model ids as plain identifiers', async () => {
    apiMock.usageSummary.mockResolvedValue({
      ...USAGE,
      call_count: 1,
      by_surface: [{ key: 'rag', cost: 1.23, tokens: 45000, calls: 1 }],
      top_cost_drivers: [{ key: 'claude-x', cost: 1.23, tokens: 45000, calls: 1 }],
    });
    render(<Cost />);
    const breakdown = await screen.findByTestId('cost-breakdown');
    expect(within(breakdown).getByText('RAG')).toBeInTheDocument();
    expect(within(breakdown).queryByText('Rag')).toBeNull();
    // One call reads in the singular, in the strip and in the drivers list.
    expect(within(screen.getByTestId('cost-kpi-strip')).getByTestId('kpi-cost-tokens')).toHaveTextContent('across 1 call');
    const drivers = screen.getByRole('list', { name: 'Top cost drivers' });
    expect(drivers).toHaveTextContent('1 call');
    expect(drivers).not.toHaveTextContent('1 calls');
    // Identifiers are plain monospace text with the full value in the tooltip, not a chip.
    const id = within(drivers).getByTitle('claude-x');
    expect(id.tagName).toBe('SPAN');
    expect(id.className).toContain('font-mono');
    expect(id.className).not.toContain('border');
  });

  it('shows the empty state, not zero tiles, before any spend', async () => {
    apiMock.usageSummary.mockResolvedValue({ total_cost: 0, total_tokens: 0, call_count: 0, currency: 'USD' });
    render(<Cost />);
    expect(await screen.findByText('No LLM spend recorded yet')).toBeInTheDocument();
    expect(screen.queryByTestId('cost-kpi-strip')).toBeNull();
  });

  it('keeps one page heading and the icon refresh in the header', async () => {
    render(<Analytics onNavigate={vi.fn()} tab="cost" />);
    await screen.findByTestId('cost-kpi-strip');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const header = document.querySelector('[data-page-header="page"]') as HTMLElement;
    const controls = header.querySelector('[data-page-header-controls]') as HTMLElement;
    expect(within(controls).getByRole('button', { name: 'Refresh usage' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Time range: Last 7 days' })).toBeInTheDocument();
  });
});

describe('the Analytics range is shared for the session', () => {
  it('carries a range picked on Metrics to the Cost page', async () => {
    const first = render(<Metrics />);
    await screen.findByTestId('analytics-kpi-strip');
    await pickRange('Last 30 days');
    await waitFor(() => expect(apiMock.getMetrics).toHaveBeenLastCalledWith(720));
    first.unmount();

    render(<Cost />);
    await waitFor(() => expect(apiMock.usageSummary).toHaveBeenCalled());
    expect(apiMock.usageSummary).toHaveBeenLastCalledWith(720);
    expect(screen.getByRole('button', { name: 'Time range: Last 30 days' })).toBeInTheDocument();
  });

  it('starts a fresh session on the last 7 days', async () => {
    render(<Cost />);
    await waitFor(() => expect(apiMock.usageSummary).toHaveBeenCalledWith(168));
    expect(screen.getByRole('button', { name: 'Time range: Last 7 days' })).toBeInTheDocument();
  });
});
