/**
 * Standup shift-handoff (Round 3 / Feature 11) render test.
 *
 * Mocks the co-located report API + the shared `@/lib/api` (for the prose `standup`
 * + `getSettings` calls) and asserts the rebuilt Standup page:
 *   1. renders the urgency-ranked ATTENTION QUEUE with deep-link rows that call
 *      `onNavigate('cases', { status })` pre-seeding the Cases filter, and
 *   2. renders the period-over-period DELTA TILES with the right sign + value.
 *
 * Fully offline — no network, no real providers beyond the mocked auth.
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
vi.mock('@/lib/api', () => ({
  api: {
    standup: vi.fn().mockResolvedValue({ summary: 'Quiet shift overall.', enabled: true }),
    getSettings: vi.fn().mockResolvedValue({ prefs: { standup: { window_hours: 24 } } }),
  },
}));

// Auth — render with the case-write grant + a known username so RBAC-gated controls show.
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    hasPermission: () => true,
    authEnabled: false,
  }),
}));

import Standup from '../pages/Standup';
import type { StandupReport } from '../pages/Standup.report.api';

const REPORT: StandupReport = {
  enabled: true,
  window_hours: 24,
  window: '2026-06-30/day',
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

describe('Standup shift handoff (Round 3 / F11)', () => {
  beforeEach(() => {
    fetchReportMock.mockReset();
    fetchReportMock.mockResolvedValue(REPORT);
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
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));

    await waitFor(() => expect(fetchReportMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Suspicious PowerShell on host-12')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading shift handoff' })).toBeNull();

    await act(async () => {
      resolveRefresh(REPORT);
    });
  });

  it('renders the urgency-ranked attention queue with deep-link rows', async () => {
    const onNavigate = vi.fn();
    render(<Standup onNavigate={onNavigate} />);

    // The lead attention queue renders both case titles (plain text, #9).
    await waitFor(() =>
      expect(screen.getByText('Suspicious PowerShell on host-12')).toBeInTheDocument(),
    );
    expect(screen.getByText('Brute force against vpn')).toBeInTheDocument();

    // The top row's display id is a deep-link that pre-seeds the Cases status filter.
    const link = screen.getByRole('button', { name: /open TLSOC-501 in the cases list/i });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('cases', { status: 'needs_human' });
  });

  it('renders period-over-period delta tiles with the correct sign + value', async () => {
    render(<Standup onNavigate={vi.fn()} />);

    // Open delta tile: current 5, prior 8, delta -3 (a drop is good → success-coloured).
    const openTile = await screen.findByTestId('delta-tile-open');
    expect(within(openTile).getByText('5')).toBeInTheDocument();
    expect(within(openTile).getByText('-3')).toBeInTheDocument();
    expect(within(openTile).getByText('was 8')).toBeInTheDocument();

    // The legacy needs_human STATUS tile reads as the console's word for that status:
    // current 2, prior 1, delta +1 (a rise is bad → critical).
    const awaitingTile = screen.getByTestId('delta-tile-needs_human');
    expect(within(awaitingTile).getByText('Awaiting analyst')).toBeInTheDocument();
    expect(within(awaitingTile).getByText('2')).toBeInTheDocument();
    expect(within(awaitingTile).getByText('+1')).toBeInTheDocument();
  });

  it('shows the open cases with a Needs human verdict under Needs human, as chat does', async () => {
    render(<Standup onNavigate={vi.fn()} />);

    // Chat's shift report labels this same figure "Needs human"; one label, one figure.
    const nhTile = await screen.findByTestId('delta-tile-needs_human_verdict');
    expect(within(nhTile).getByText('Needs human')).toBeInTheDocument();
    expect(within(nhTile).getByText('4')).toBeInTheDocument();
    expect(within(nhTile).getByText('+3')).toBeInTheDocument();
    // "Needs human" names exactly one tile; the status count never carries that label.
    expect(screen.getAllByText('Needs human')).toHaveLength(1);
    // The workload badge counts the same status as the Awaiting analyst tile.
    expect(screen.getByText('1 awaiting')).toBeInTheDocument();
    expect(screen.queryByText(/\bNH\b/)).not.toBeInTheDocument();
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
    expect(
      screen.queryByRole('status', { name: 'Nothing needs you right now' }),
    ).not.toBeInTheDocument();
  });

  it('hides the Copy summary button on an insecure origin (no clipboard)', async () => {
    // jsdom has no navigator.clipboard by default → the dead button must not render.
    render(<Standup onNavigate={vi.fn()} />);
    await screen.findByText('Suspicious PowerShell on host-12');
    expect(
      screen.queryByRole('button', { name: /copy the shift summary/i }),
    ).not.toBeInTheDocument();
  });

  it('shows + wires the Copy summary button when a clipboard is available', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<Standup onNavigate={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: /copy the shift summary/i });
    await user.click(btn);
    expect(writeText).toHaveBeenCalledWith('Quiet shift overall.');
    // Clipboard completion updates the visible affordance asynchronously. Assert the
    // state the operator sees so the promise-driven update settles inside this test.
    await waitFor(() => expect(btn).toHaveTextContent('Copied'));
  });
});
