/**
 * Round 16 FXD2: every Standup number can be explained on hover or click, and the
 * arithmetic reproduces the figure on screen.
 *
 * * Strip counts: "15 - 10 = +5" against the window before.
 * * The risk chip: the case's recorded weighted sum (RiskExplain).
 * * SLA pressure: the totals as sums per priority, and each case's "over" line as the
 *   clock's elapsed minutes minus its target (18,677.93 - 480 = 18,197.93 minutes, shown
 *   as "12d 15h over").
 * * Workload: open = escalated + awaiting analyst + other open.
 * * Age in the queue: the snapshot time minus when the case was detected or created.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchReportMock } = vi.hoisted(() => ({ fetchReportMock: vi.fn() }));

vi.mock('../pages/Standup.report.api', async () => {
  const actual = await vi.importActual<typeof import('../pages/Standup.report.api')>('../pages/Standup.report.api');
  return { ...actual, fetchStandupReport: fetchReportMock };
});

const { standupMock, getSettingsMock } = vi.hoisted(() => ({ standupMock: vi.fn(), getSettingsMock: vi.fn() }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: { standup: standupMock, getSettings: getSettingsMock, get: vi.fn() },
}));

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'tester', hasPermission: () => true, authEnabled: false }),
}));

import Standup from '../pages/Standup';
import {
  explainQueueAge,
  explainSlaOverage,
  explainSlaTotal,
  explainStripCount,
  explainWorkload,
  slaRowOverMinutes,
} from '../pages/Standup.explain';
import type { SlaAgingRow, StandupReport } from '../pages/Standup.report.api';

const BREACH: SlaAgingRow = {
  case_id: 'demo-0037',
  display_id: 'CASE-000004',
  priority_level: 'P4',
  age_minutes: 18677.9,
  target_minutes: 480,
  overdue_minutes: 18197.9,
  elapsed_minutes: 18677.93,
  running: true,
  start_at: '2026-11-13T12:00:00+00:00',
  due_at: '2026-11-13T20:00:00+00:00',
  stopped_at: null,
  stop_source: null,
};

const BREAKDOWN = {
  volume: 52.89,
  velocity: 50.52,
  reputation: 0,
  diversity: 20,
  asset_criticality: 0,
  total: 26.33,
  inputs: {
    event_count: 7, span_seconds: 83.142, effective_window_seconds: 83.142, rate_per_minute: 5.05159847008732,
    velocity_rule: 'rate', rule_values: ['LP QRadar: impossible travel authentication'], rule_type_count: 1,
    reputation_input: 0, reputation_source: 'not_ip_entity', asset_value: 0, asset_match: 'none',
    weights: { volume: 0.25, velocity: 0.2, reputation: 0.3, diversity: 0.15, asset_criticality: 0.1 },
    total_weight: 1, zero_weight_fallback: false, refs: { volume: 50, velocity: 10, diversity: 5 },
    scored_at: '2026-11-14T08:43:17.712000+00:00', inputs_version: 1,
  },
};

const REPORT: StandupReport = {
  enabled: true,
  window_hours: 24,
  window: '2026-11-26/day',
  generated_at: '2026-11-26T13:00:00+00:00',
  shift: {},
  attention_queue: [
    {
      case_id: 'demo-0036',
      case_number: 'CASE-000005',
      display_id: 'CASE-000005',
      title: 'user:dsingh impossible travel',
      status: 'escalated',
      verdict: 'NEEDS_HUMAN',
      risk_score: 26.33,
      severity_band: 'critical',
      priority_level: '',
      assignee: 'farhan.qureshi',
      entity: 'dsingh',
      age_minutes: 17546.1,
      urgency: 1.03,
      risk_breakdown: BREAKDOWN as never,
      age_from: 'created_at',
      age_from_at: '2026-11-14T08:33:54+00:00',
    },
  ],
  sla_aging: {
    enabled: true,
    warn_fraction: 0.8,
    by_priority: { P4: { open: 9, breached: 5, about_to_breach: 0 }, P3: { open: 6, breached: 5, about_to_breach: 0 } },
    totals: { open: 15, breached: 10, about_to_breach: 0 },
    breached: [BREACH],
    about_to_breach: [],
  },
  workload: [{ analyst: 'farhan.qureshi', open: 3, escalated: 2, needs_human: 0 }],
  deltas: { open: { current: 15, prior: 10, delta: 5 } },
  action_items: [],
  acknowledgements: [],
  degraded: false,
};

describe('Standup explanations: the builders', () => {
  it('a strip count states the change from its two counts', () => {
    const e = explainStripCount('open', 'Open', { current: 15, prior: 10, delta: 5 }, 'last 24 hours');
    expect(e.summary).toBe('Open: 15 now; 10 of them were created before the last 24 hours; 15 - 10 = +5.');
    expect(e.steps).toEqual([{ label: 'Change', expression: '15 - 10', result: '+5' }]);
  });

  it('never calls the "was" figure a count taken when the window began (review)', () => {
    // The server counts today's open cases that were created before the window; a case
    // open then and closed since is not in it, so "at the start of the window" would be
    // a claim the figure cannot back.
    const e = explainStripCount('sla_breached', 'SLA breached', { current: 10, prior: 10, delta: 0 }, 'last 24 hours');
    const text = JSON.stringify(e);
    expect(text).not.toMatch(/start of the (window|last)/);
    expect(e.inputs.find((i) => i.key === 'before')?.label).toBe('Created before the window');
    expect(e.caveats[0]).toMatch(/^The "was" figure is not a count taken when the window began\./);
  });

  it('the SLA totals add up per priority', () => {
    expect(explainSlaTotal('breached', REPORT.sla_aging)?.steps[0]).toEqual({ label: 'Sum', expression: 'P3 5 + P4 5', result: '10' });
    expect(explainSlaTotal('open', REPORT.sla_aging)?.steps[0].expression).toBe('P3 6 + P4 9');
  });

  it('an "over" line is the elapsed minutes minus the target, rounded as the line shows it', () => {
    expect(slaRowOverMinutes(BREACH)).toBe(18197.93);
    const e = explainSlaOverage(BREACH, 'CASE-000004');
    expect(e?.display).toBe('12d 15h over');
    const steps = e?.steps ?? [];
    expect(steps.find((s) => s.label === 'Over by')).toMatchObject({ expression: '18,677.93 - 480', result: '18,197.93 minutes' });
    expect(steps.find((s) => s.label === 'Shown')).toMatchObject({
      expression: '18,197.93 minutes rounds to 18,198 whole minutes: 12 days, 15 hours and 18 minutes',
      result: '12d 15h over (the two largest units)',
    });
    // An older backend without the clock's elapsed time keeps the line and has no panel.
    expect(explainSlaOverage({ ...BREACH, elapsed_minutes: undefined }, 'CASE-000004')).toBeNull();
    expect(slaRowOverMinutes({ ...BREACH, elapsed_minutes: undefined })).toBe(18197.9);
  });

  it('an analyst\'s open work is the sum of its parts', () => {
    const e = explainWorkload({ analyst: 'farhan.qureshi', open: 3, escalated: 2, needs_human: 0 });
    expect(e.steps[0]).toEqual({ label: 'Open', expression: '2 + 0 + 1', result: '3' });
    expect(explainWorkload({ analyst: '(unassigned)', open: 4, escalated: 0, needs_human: 0 }).summary).toMatch(/^Open cases with no assignee/);
  });

  it('a queue age is the snapshot time minus the case\'s start', () => {
    const e = explainQueueAge(REPORT.attention_queue[0], REPORT.generated_at);
    expect(e?.display).toBe('12d 4h');
    expect(e?.steps[0]).toEqual({
      label: 'Difference',
      expression: '2026-11-26T13:00:00+00:00 - 2026-11-14T08:33:54+00:00',
      result: '17,546.1 minutes',
    });
    expect(explainQueueAge({ ...REPORT.attention_queue[0], age_from_at: null }, REPORT.generated_at)).toBeNull();
  });

  it('a queue age works its "12d 4h" from the whole minutes and their parts (review)', () => {
    const e = explainQueueAge(REPORT.attention_queue[0], REPORT.generated_at);
    // 17,546.1 minutes rounds to 17,546: 12 days (17,280), 4 hours (240) and 26 minutes.
    expect(e?.steps[1]).toEqual({
      label: 'Shown',
      expression: '17,546.1 minutes rounds to 17,546 whole minutes: 12 days, 4 hours and 26 minutes',
      result: '12d 4h (the two largest units)',
    });
    // Under a minute the row prints "<1m", and the step says so instead of "0 minutes".
    const fresh = explainQueueAge(
      { ...REPORT.attention_queue[0], age_minutes: 0.5, age_from_at: '2026-11-26T12:59:30+00:00' },
      REPORT.generated_at,
    );
    expect(fresh?.steps[1]).toEqual({ label: 'Shown', expression: '0.5 minutes is under a minute', result: '<1m' });
  });
});

describe('Standup explanations: the page', () => {
  beforeEach(() => {
    fetchReportMock.mockReset().mockResolvedValue(REPORT);
    standupMock.mockReset().mockResolvedValue({ summary: '', enabled: true });
    getSettingsMock.mockReset().mockResolvedValue({ prefs: { standup: { window_hours: 24 } } });
  });

  it('puts an explain trigger on every number', async () => {
    const { container } = render(<Standup onNavigate={vi.fn()} />);
    await screen.findByText('user:dsingh impossible travel');
    const metrics = Array.from(container.querySelectorAll('[data-explain-trigger]')).map((n) => n.getAttribute('data-explain-metric'));
    expect(metrics).toEqual(
      expect.arrayContaining([
        'standup_open',
        'risk_score',
        'standup_age',
        'standup_sla_open',
        'standup_sla_breached',
        'standup_sla_about_to_breach',
        'standup_sla_overage',
        'standup_workload',
      ]),
    );
  });

  it('hovering the risk chip shows the recorded weighted sum', async () => {
    const user = userEvent.setup();
    const { container } = render(<Standup onNavigate={vi.fn()} />);
    await screen.findByText('user:dsingh impossible travel');
    const chip = container.querySelector('[data-explain-metric="risk_score"]') as HTMLElement;
    await user.hover(chip);
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent(
      'Risk 26.33 = (0.25 x 52.89 + 0.20 x 50.52 + 0.30 x 0 + 0.15 x 20 + 0.10 x 0) / 1.00.',
    );
  });
});
