/**
 * Standup shift-handoff (Round 3 / Feature 11; Round 14 page grammar) render test.
 *
 * Mocks the co-located report API + the shared `@/lib/api` (for the prose `standup`
 * + `getSettings` calls) and asserts the Standup page:
 *   1. the page header: the title, the handoff range (24 hours or 7 days) and one icon
 *      refresh beside it, the shift and freshness stamp with Copy summary on the right,
 *   2. one KPI strip of the shift's headline counts against the previous window,
 *   3. the urgency-ranked ATTENTION QUEUE whose case numbers are links to the case, the
 *      first eight rows with the rest behind "Show all",
 *   4. SLA pressure with each breach's overage in plain words, and the honest empty states.
 *
 * Fully offline: no network, no real providers beyond the mocked auth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchReportMock } = vi.hoisted(() => ({ fetchReportMock: vi.fn() }));

// Co-located report API — the page imports these named exports.
vi.mock('../pages/Standup.report.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Standup.report.api')>(
    '../pages/Standup.report.api',
  );
  return {
    ...actual,
    fetchStandupReport: fetchReportMock,
    createActionItem: vi.fn().mockResolvedValue({ item: {} }),
    updateActionItem: vi.fn().mockResolvedValue({ item: {} }),
    deleteActionItem: vi.fn().mockResolvedValue({ ok: true }),
    acknowledgeHandoff: vi.fn().mockResolvedValue({ ack: {} }),
  };
});

// Shared client — only `standup` (prose) + `getSettings` (window seed) are used here.
const { standupMock, getSettingsMock } = vi.hoisted(() => ({
  standupMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: {
    standup: standupMock,
    getSettings: getSettingsMock,
  },
}));

// Auth — render with the case-write grant + a known username so RBAC-gated controls show.
const { authState } = vi.hoisted(() => ({ authState: { canViewMetrics: true } }));
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    hasPermission: (resource: string, action: string) =>
      resource === 'metrics' && action === 'view' ? authState.canViewMetrics : true,
    authEnabled: false,
  }),
}));

import * as reportApi from '../pages/Standup.report.api';

import Standup, { GeneratedStamp, rangeWords, shiftName, workloadName } from '../pages/Standup';
import type { StandupReport } from '../pages/Standup.report.api';

const REPORT: StandupReport = {
  enabled: true,
  window_hours: 24,
  window: '2026-06-30/swing',
  generated_at: '2026-06-30T08:00:00Z',
  shift: {},
  attention_queue: [
    {
      case_id: 'case-aaa',
      case_number: 'TLSOC-501',
      display_id: 'TLSOC-501',
      title: 'Suspicious PowerShell on host-12',
      status: 'needs_human',
      verdict: 'needs_human',
      risk_score: 88,
      severity_band: 'critical',
      priority_level: 'P1',
      assignee: 'alice',
      entity: '10.0.0.12',
      age_minutes: 240,
      urgency: 0.91,
    },
    {
      case_id: 'case-bbb',
      case_number: 'TLSOC-502',
      display_id: 'TLSOC-502',
      title: 'Brute force against vpn',
      status: 'escalated',
      verdict: '',
      risk_score: 64,
      severity_band: 'high',
      priority_level: 'P2',
      assignee: '',
      entity: 'vpn-gw',
      age_minutes: 30,
      urgency: 0.6,
    },
  ],
  sla_aging: {
    enabled: true,
    warn_fraction: 0.75,
    by_priority: {},
    totals: { open: 5, breached: 1, about_to_breach: 2 },
    breached: [
      {
        case_id: 'case-aaa',
        display_id: 'TLSOC-501',
        priority_level: 'P1',
        age_minutes: 240,
        target_minutes: 60,
        overdue_minutes: 180,
      },
    ],
    about_to_breach: [],
  },
  workload: [
    { analyst: 'alice', open: 3, escalated: 1, needs_human: 1 },
    { analyst: '(unassigned)', open: 2, escalated: 0, needs_human: 0 },
  ],
  deltas: {
    open: { current: 5, prior: 8, delta: -3 },
    needs_human: { current: 2, prior: 1, delta: 1 },
    needs_human_verdict: { current: 4, prior: 1, delta: 3 },
    escalated: { current: 1, prior: 1, delta: 0 },
    unassigned: { current: 2, prior: 4, delta: -2 },
    sla_breached: { current: 1, prior: 0, delta: 1 },
  },
  action_items: [
    { id: 'ai-1', title: 'Chase the firewall team', owner: 'bob', status: 'open', created_at: '2026-06-30T07:00:00Z', note: '' },
  ],
  acknowledgements: [],
  degraded: false,
};

/** An attention row for the "Show all" case: rank `n`, a safe case id, a title. */
function queueRow(n: number) {
  return {
    ...REPORT.attention_queue[1],
    case_id: `case-${n}`,
    case_number: `TLSOC-${600 + n}`,
    display_id: `TLSOC-${600 + n}`,
    title: `Queued case ${n}`,
  };
}

describe('Standup shift handoff (Round 3 / F11)', () => {
  beforeEach(() => {
    fetchReportMock.mockReset();
    fetchReportMock.mockResolvedValue(REPORT);
    standupMock.mockReset().mockResolvedValue({ summary: 'Quiet shift overall.', enabled: true });
    getSettingsMock.mockReset().mockResolvedValue({ prefs: { standup: { window_hours: 24 } } });
    authState.canViewMetrics = true;
    window.localStorage.clear();
  });

  // Round-6: the Copy control depends on navigator.clipboard; reset it after each test
  // so a case that installs a fake clipboard does not leak into the others.
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('uses one shared blocking loader, then keeps the snapshot mounted during refresh', async () => {
    let resolveInitial: (value: StandupReport) => void = () => {};
    fetchReportMock.mockReturnValueOnce(
      new Promise<StandupReport>((resolve) => {
        resolveInitial = resolve;
      }),
    );

    const { container } = render(<Standup onNavigate={vi.fn()} />);

    expect(
      await screen.findByRole('status', { name: 'Loading shift handoff' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('console-loading-glyph')).toHaveLength(1);
    expect(container.querySelector('.animate-pulse')).toBeNull();

    await act(async () => {
      resolveInitial(REPORT);
    });
    await screen.findByText('Suspicious PowerShell on host-12');

    let resolveRefresh: (value: StandupReport) => void = () => {};
    fetchReportMock.mockReturnValueOnce(
      new Promise<StandupReport>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh standup' }));

    await waitFor(() => expect(fetchReportMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Suspicious PowerShell on host-12')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading shift handoff' })).toBeNull();

    await act(async () => {
      resolveRefresh(REPORT);
    });
  });

  it('carries the title, range, icon refresh and shift stamp in the page header', async () => {
    render(<Standup onNavigate={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Standup' })).toBeInTheDocument();
    await screen.findByText('Suspicious PowerShell on host-12');
    const header = document.querySelector('[data-page-header="page"]') as HTMLElement;
    const controls = header.querySelector('[data-page-header-controls]') as HTMLElement;
    expect(within(controls).getByRole('button', { name: 'Time range: Last 24 hours' })).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: 'Refresh standup' })).toBeInTheDocument();
    const stamp = within(header).getByTestId('standup-stamp');
    expect(stamp).toHaveTextContent(/^Swing shift · Generated /);
    expect(stamp).toHaveAttribute('title', 'Swing shift, 2026-06-30, 14:00 to 22:00 UTC');
  });

  it('reads the handoff again for the 7-day range, seeded from the saved preference', async () => {
    getSettingsMock.mockResolvedValue({ prefs: { standup: { window_hours: 150 } } });
    render(<Standup onNavigate={vi.fn()} />);
    // 150 hours is closest to the 7-day preset.
    await waitFor(() => expect(fetchReportMock).toHaveBeenCalledWith(168));
    expect(standupMock).toHaveBeenCalledWith(168);
    await userEvent.click(await screen.findByRole('button', { name: 'Time range: Last 7 days' }));
    const group = await screen.findByRole('group', { name: 'Relative time ranges' });
    // The handoff offers two ranges only.
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('Last 24 hours'),
      expect.stringContaining('Last 7 days'),
    ]);
    await userEvent.click(within(group).getByRole('button', { name: /^Last 24 hours/ }));
    await waitFor(() => expect(fetchReportMock).toHaveBeenLastCalledWith(24));
  });

  it('renders the urgency-ranked attention queue with case links into Case Manager', async () => {
    const onNavigate = vi.fn();
    render(<Standup onNavigate={onNavigate} />);

    // The lead attention queue renders both case titles (plain text, #9).
    await waitFor(() =>
      expect(screen.getByText('Suspicious PowerShell on host-12')).toBeInTheDocument(),
    );
    expect(screen.getByText('Brute force against vpn')).toBeInTheDocument();
    const queue = screen.getByRole('list', { name: 'Attention queue' });
    const rows = within(queue).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // 240 minutes reads "4h", never "240m".
    expect(rows[0]).toHaveTextContent('4h');
    expect(rows[1]).toHaveTextContent('unassigned');

    // The case number is a real link (SPEC §3.3) that opens the case.
    const link = within(rows[0]).getByRole('link', { name: 'Open TLSOC-501' });
    expect(link).toHaveAttribute('href', '#/case_manager?caseId=case-aaa');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('case_manager', { caseId: 'case-aaa' });
  });

  it('shows the first eight queued cases and the rest behind Show all', async () => {
    const attention = Array.from({ length: 11 }, (_, i) => queueRow(i + 1));
    fetchReportMock.mockResolvedValue({ ...REPORT, attention_queue: attention });
    render(<Standup onNavigate={vi.fn()} />);
    const queue = await screen.findByRole('list', { name: 'Attention queue' });
    expect(within(queue).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText('3 more cases in the queue.')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show all 11' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', queue.id);
    await userEvent.click(toggle);
    expect(within(queue).getAllByRole('listitem')).toHaveLength(11);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the shift counts as one strip with the correct sign + value', async () => {
    render(<Standup onNavigate={vi.fn()} />);

    const strip = await screen.findByTestId('standup-strip');
    // Open: current 5, prior 8, delta -3 (a drop is good).
    const openTile = within(strip).getByTestId('kpi-delta-open');
    expect(openTile).toHaveTextContent('5');
    expect(openTile).toHaveTextContent('-3');
    expect(openTile).toHaveTextContent('was 8');

    // The legacy needs_human STATUS tile reads as the console's word for that status:
    // current 2, prior 1, delta +1.
    const awaitingTile = within(strip).getByTestId('kpi-delta-needs_human');
    expect(awaitingTile).toHaveTextContent('Awaiting analyst');
    expect(awaitingTile).toHaveTextContent('2');
    expect(awaitingTile).toHaveTextContent('+1');

    // No change reads "±0", never a bare 0 or an arrow.
    expect(within(strip).getByTestId('kpi-delta-escalated')).toHaveTextContent('±0');
  });

  it('shows the open cases with a Needs human verdict under Needs human, as chat does', async () => {
    render(<Standup onNavigate={vi.fn()} />);

    // Chat's shift report labels this same figure "Needs human"; one label, one figure.
    const nhTile = await screen.findByTestId('kpi-delta-needs_human_verdict');
    expect(nhTile).toHaveTextContent('Needs human');
    expect(nhTile).toHaveTextContent('4');
    expect(nhTile).toHaveTextContent('+3');
    // "Needs human" names exactly one tile; the status count never carries that label.
    expect(screen.getAllByText('Needs human')).toHaveLength(1);
    // The workload badge counts the same status as the Awaiting analyst tile.
    expect(screen.getByText('1 awaiting')).toBeInTheDocument();
    expect(screen.queryByText(/\bNH\b/)).not.toBeInTheDocument();
  });

  it('shows each SLA breach with its overage in plain words and links to Posture', async () => {
    const onNavigate = vi.fn();
    fetchReportMock.mockResolvedValue({
      ...REPORT,
      sla_aging: {
        ...REPORT.sla_aging,
        breached: [
          { ...REPORT.sla_aging.breached[0], overdue_minutes: 18613 },
          { case_id: 'case-ccc', display_id: 'TLSOC-503', age_minutes: 400, target_minutes: 240, overdue_minutes: 160 },
        ],
      },
    });
    render(<Standup onNavigate={onNavigate} />);
    const sla = await screen.findByTestId('standup-sla');
    const rows = within(within(sla).getByRole('list', { name: 'Cases past their response target' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('12d 22h over');
    expect(rows[0]).toHaveTextContent('P1');
    expect(rows[0].textContent).not.toMatch(/\+\d+m/);
    // A breach with no priority shows none, not a dash or an empty slot.
    expect(rows[1]).toHaveTextContent('2h 40m over');
    expect(rows[1].textContent).not.toContain('—');
    const posture = within(sla).getByRole('link', { name: 'Open posture' });
    // The hash carries the Metrics page; the router keeps only the tabs it can restore.
    expect(posture.getAttribute('href')).toMatch(/^#\/metrics(\?|$)/);
    fireEvent.click(posture);
    expect(onNavigate).toHaveBeenCalledWith('metrics', { tab: 'posture' });
  });

  it('distinguishes a clear queue, unavailable SLA tracking, and an empty workload', async () => {
    fetchReportMock.mockResolvedValue({
      ...REPORT,
      attention_queue: [],
      workload: [],
      sla_aging: {
        ...REPORT.sla_aging,
        enabled: false,
        totals: { open: 0, breached: 0, about_to_breach: 0 },
        breached: [],
        about_to_breach: [],
      },
    });

    render(<Standup onNavigate={vi.fn()} />);

    const clearQueue = await screen.findByRole('status', {
      name: 'Nothing needs you right now',
    });
    expect(clearQueue).toHaveAttribute('data-empty-state', 'success');
    expect(clearQueue).toHaveAccessibleDescription(/current window has no open.*refresh/i);

    const unavailable = screen.getByRole('status', { name: 'SLA tracking is off' });
    expect(unavailable).toHaveAttribute('data-empty-state', 'unavailable');
    expect(unavailable).toHaveAccessibleDescription(/enable an SLA policy/i);

    const noWorkload = screen.getByRole('group', { name: 'No open workload' });
    expect(noWorkload).toHaveAttribute('data-empty-state', 'no-data');
    expect(noWorkload).toHaveAccessibleDescription(/no assignee workload rows/i);
  });

  it('never presents a degraded empty attention queue as a successful clear shift', async () => {
    fetchReportMock.mockResolvedValue({
      ...REPORT,
      attention_queue: [],
      degraded: true,
    });

    render(<Standup onNavigate={vi.fn()} />);

    const incompleteQueue = await screen.findByRole('status', {
      name: 'Attention queue is incomplete',
    });
    expect(incompleteQueue).toHaveAttribute('data-empty-state', 'unavailable');
    expect(incompleteQueue).toHaveAccessibleDescription(
      /degraded snapshot.*empty queue cannot be verified.*before treating this shift as clear/i,
    );
    expect(screen.getByText('Limited data')).toBeInTheDocument();
    expect(screen.getByText('Generated from limited data')).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Nothing needs you right now' }),
    ).not.toBeInTheDocument();
  });

  it('says the handoff is turned off rather than drawing an empty shift', async () => {
    fetchReportMock.mockResolvedValue({ ...REPORT, enabled: false });
    render(<Standup onNavigate={vi.fn()} />);
    expect(await screen.findByText('Standup is turned off')).toBeInTheDocument();
    expect(screen.queryByTestId('standup-strip')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Attention queue' })).toBeNull();
  });

  it('shows a reachable error with a retry when the report cannot be read', async () => {
    fetchReportMock.mockRejectedValue(new Error('offline'));
    render(<Standup onNavigate={vi.fn()} />);
    expect(await screen.findByText('Could not reach the standup service')).toBeInTheDocument();
    expect(screen.queryByTestId('standup-strip')).toBeNull();
  });

  it('hides the Copy summary button on an insecure origin (no clipboard)', async () => {
    // jsdom has no navigator.clipboard by default: the dead button must not render.
    render(<Standup onNavigate={vi.fn()} />);
    await screen.findByText('Suspicious PowerShell on host-12');
    expect(screen.queryByRole('button', { name: /copy summary/i })).not.toBeInTheDocument();
  });

  it('shows + wires the Copy summary button when a clipboard is available', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<Standup onNavigate={vi.fn()} />);
    // The visible label is the accessible name (WCAG 2.5.3, label in name).
    const btn = await screen.findByRole('button', { name: 'Copy summary' });
    expect(btn).not.toHaveAttribute('aria-label');
    const status = screen.getByTestId('standup-copy-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('');
    await user.click(btn);
    expect(writeText).toHaveBeenCalledWith('Quiet shift overall.');
    // Clipboard completion updates the visible affordance asynchronously. Assert the
    // state the operator sees so the promise-driven update settles inside this test.
    await waitFor(() => expect(btn).toHaveTextContent('Copied'));
    // And a screen reader hears it.
    expect(status).toHaveTextContent('Summary copied');
    // The model-written summary renders as a plain-text module, last.
    expect(screen.getByText('Quiet shift overall.')).toBeInTheDocument();
  });
});

describe('Standup review fixes (Round 14 W8a)', () => {
  beforeEach(() => {
    fetchReportMock.mockReset();
    fetchReportMock.mockResolvedValue(REPORT);
    standupMock.mockReset().mockResolvedValue({ summary: 'Quiet shift overall.', enabled: true });
    getSettingsMock.mockReset().mockResolvedValue({ prefs: { standup: { window_hours: 24 } } });
    authState.canViewMetrics = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(reportApi.createActionItem).mockReset().mockResolvedValue({ item: {} } as never);
    vi.mocked(reportApi.acknowledgeHandoff).mockReset().mockResolvedValue({ ack: {} } as never);
  });

  it('ignores a slower earlier range that resolves last, and its summary', async () => {
    const pending = new Map<number, (r: StandupReport) => void>();
    fetchReportMock.mockImplementation(
      (hours: number) => new Promise<StandupReport>((resolve) => pending.set(hours, resolve)),
    );
    standupMock.mockImplementation(async (hours: number) => ({
      summary: hours === 24 ? 'The 24 hour summary.' : 'The 7 day summary.',
      enabled: true,
    }));
    render(<Standup onNavigate={vi.fn()} />);
    await waitFor(() => expect(pending.has(24)).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Time range: Last 24 hours' }));
    const group = await screen.findByRole('group', { name: 'Relative time ranges' });
    await userEvent.click(within(group).getByRole('button', { name: /^Last 7 days/ }));
    await waitFor(() => expect(pending.has(168)).toBe(true));

    // The 7-day read lands first, then the stale 24-hour read.
    await act(async () => pending.get(168)!({ ...REPORT, window_hours: 168, attention_queue: [queueRow(7)] }));
    await screen.findByText('Queued case 7');
    await act(async () => pending.get(24)!(REPORT));

    expect(screen.getByText('Queued case 7')).toBeInTheDocument();
    expect(screen.queryByText('Suspicious PowerShell on host-12')).toBeNull();
    expect(screen.getByText('The 7 day summary.')).toBeInTheDocument();
    expect(screen.queryByText('The 24 hour summary.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Time range: Last 7 days' })).toBeInTheDocument();
  });

  it('names both ranges when a new range fails and the previous report stays', async () => {
    render(<Standup onNavigate={vi.fn()} />);
    const strip = await screen.findByRole('group', { name: 'Shift counts, last 24 hours' });
    expect(within(strip).getByTestId('kpi-delta-open')).toHaveTextContent('was 8');
    fetchReportMock.mockRejectedValue(new Error('Network error'));
    await userEvent.click(screen.getByRole('button', { name: 'Time range: Last 24 hours' }));
    const group = await screen.findByRole('group', { name: 'Relative time ranges' });
    await userEvent.click(within(group).getByRole('button', { name: /^Last 7 days/ }));
    await waitFor(() => expect(fetchReportMock).toHaveBeenLastCalledWith(168));

    // The 24-hour figures stay, and the page says that is what they are.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the last 7 days; showing the last 24 hours');
    expect(screen.getByRole('group', { name: 'Shift counts, last 24 hours' })).toBeInTheDocument();
    expect(screen.getByText('Suspicious PowerShell on host-12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Time range: Last 7 days' })).toBeInTheDocument();
  });

  it('keeps the plain refresh error when the same range fails again', async () => {
    render(<Standup onNavigate={vi.fn()} />);
    await screen.findByText('Suspicious PowerShell on host-12');
    fetchReportMock.mockRejectedValue(new Error('Network error'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh standup' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not refresh the standup');
    expect(alert).not.toHaveTextContent('showing the');
  });

  it('caps the acknowledgements with Show all instead of cutting them silently', async () => {
    const acknowledgements = Array.from({ length: 10 }, (_, i) => ({
      user: `analyst${i + 1}`,
      window: REPORT.window,
      at: '2026-06-30T08:00:00Z',
      note: '',
    }));
    fetchReportMock.mockResolvedValue({ ...REPORT, acknowledgements });
    render(<Standup onNavigate={vi.fn()} />);
    const signoff = await screen.findByTestId('standup-signoff');
    const list = within(signoff).getByRole('list', { name: 'Acknowledgements' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(signoff).toHaveTextContent('2 more acknowledged this handoff.');
    const toggle = within(signoff).getByRole('button', { name: 'Show all 10' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    await userEvent.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText('analyst10')).toBeInTheDocument();
    expect(signoff).not.toHaveTextContent('more acknowledged');
    expect(within(signoff).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('lists a short sign-off in full, with no toggle', async () => {
    fetchReportMock.mockResolvedValue({
      ...REPORT,
      acknowledgements: [{ user: 'alice', window: REPORT.window, at: '2026-06-30T08:00:00Z', note: 'ok' }],
    });
    render(<Standup onNavigate={vi.fn()} />);
    const signoff = await screen.findByTestId('standup-signoff');
    expect(within(signoff).getAllByRole('listitem')).toHaveLength(1);
    expect(within(signoff).queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('drops the previous summary when the summary read for a new range fails', async () => {
    render(<Standup onNavigate={vi.fn()} />);
    expect(await screen.findByText('Quiet shift overall.')).toBeInTheDocument();
    standupMock.mockRejectedValue(new Error('model offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh standup' }));
    await waitFor(() => expect(screen.queryByText('Quiet shift overall.')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Shift summary' })).toBeNull();
  });

  it('keeps the generated stamp current while the page stays open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'));
    render(<GeneratedStamp shift={null} generatedAt="2026-10-29T12:00:00Z" />);
    expect(screen.getByTestId('standup-stamp')).toHaveTextContent('Generated just now');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('standup-stamp')).toHaveTextContent('Generated 1m ago');
  });

  it('caps the SLA breaches with Show all instead of cutting rows silently', async () => {
    const breached = Array.from({ length: 10 }, (_, i) => ({
      case_id: `case-s${i}`,
      display_id: `TLSOC-${700 + i}`,
      priority_level: 'P2',
      age_minutes: 600 - i,
      target_minutes: 60,
      overdue_minutes: 540 - i,
    }));
    fetchReportMock.mockResolvedValue({
      ...REPORT,
      sla_aging: { ...REPORT.sla_aging, totals: { open: 12, breached: 10, about_to_breach: 0 }, breached },
    });
    render(<Standup onNavigate={vi.fn()} />);
    const sla = await screen.findByTestId('standup-sla');
    const list = within(sla).getByRole('list', { name: 'Cases past their response target' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(sla).toHaveTextContent('4 more cases past the target.');
    const toggle = within(sla).getByRole('button', { name: 'Show all 10' });
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    await userEvent.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(sla).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers Open posture only to someone who may open Metrics', async () => {
    authState.canViewMetrics = false;
    render(<Standup onNavigate={vi.fn()} />);
    const sla = await screen.findByTestId('standup-sla');
    expect(within(sla).queryByRole('link', { name: 'Open posture' })).toBeNull();
  });

  it('says so when adding an action item or acknowledging the handoff fails', async () => {
    vi.mocked(reportApi.createActionItem).mockRejectedValueOnce(new Error('500'));
    vi.mocked(reportApi.acknowledgeHandoff).mockRejectedValueOnce(new Error('500'));
    render(<Standup onNavigate={vi.fn()} />);
    const actions = await screen.findByTestId('standup-actions');
    await userEvent.type(within(actions).getByRole('textbox', { name: 'New action item' }), 'Rotate the key');
    await userEvent.click(within(actions).getByRole('button', { name: 'Add' }));
    expect(await within(actions).findByRole('alert')).toHaveTextContent('Could not add the action item. Try again.');
    // The typed title stays for a retry.
    expect(within(actions).getByRole('textbox', { name: 'New action item' })).toHaveValue('Rotate the key');

    const signoff = screen.getByTestId('standup-signoff');
    await userEvent.click(within(signoff).getByRole('button', { name: 'Acknowledge' }));
    expect(await within(signoff).findByRole('alert')).toHaveTextContent('Could not acknowledge the handoff. Try again.');
  });

  it('names the no-owner workload row in words and keeps the bar out of the reading order', async () => {
    render(<Standup onNavigate={vi.fn()} />);
    const workload = await screen.findByTestId('standup-workload');
    expect(within(workload).getByText('Unassigned')).toBeInTheDocument();
    expect(workload).not.toHaveTextContent('(unassigned)');
    expect(within(workload).queryByRole('progressbar')).toBeNull();
    expect(workloadName('(unassigned)')).toBe('Unassigned');
    expect(workloadName('alice')).toBe('alice');
  });
});

describe('rangeWords', () => {
  it('reads a handoff range inside a sentence', () => {
    expect(rangeWords(24)).toBe('last 24 hours');
    expect(rangeWords(168)).toBe('last 7 days');
    expect(rangeWords(72)).toBe('last 3 days');
    expect(rangeWords(12)).toBe('last 12 hours');
    expect(rangeWords(1)).toBe('last 1 hour');
  });
});

describe('shiftName', () => {
  it('names the shift a window key bands, with its UTC hours', () => {
    expect(shiftName('2026-10-29/day')).toEqual({
      label: 'Day shift',
      detail: 'Day shift, 2026-10-29, 06:00 to 14:00 UTC',
    });
    expect(shiftName('2026-10-29/night')?.detail).toBe('Night shift, 2026-10-29, 22:00 to 06:00 UTC');
  });

  it('is null for a key that names no shift', () => {
    expect(shiftName('')).toBeNull();
    expect(shiftName('2026-10-29/week')).toBeNull();
    expect(shiftName('2026-10-29')).toBeNull();
  });
});
