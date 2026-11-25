/**
 * Round 16 WP11: the case facts behind the explainers.
 *
 * * B32: an SLA "due in" line rounds the time left DOWN, so it never claims more time than
 *   remains (94 minutes left on a P3 reads "1h", not "2h").
 * * R6 client: the SLA reading counts the same human responses as the server's SLA metrics
 *   (a person moving the case into Investigating, Escalated or On hold), at risk from 80%
 *   of the target; the server's reading formats with the same floor.
 * * The "First event" and "Time to detect" clocks from `first_seen_millis`.
 * * B13 Console: the factor sentences read the inputs recorded at scoring and never pair the
 *   case's current member count with the Volume factor.
 * * The one rounding rule: the risk meter shows and bands the integer rounded half up.
 * * B80 hunk: the "Untrusted source data" marker wraps as one unit.
 */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Case, RiskInputs, SlaPolicy } from '@/lib/types';
import {
  caseClocks,
  firstHumanResponse,
  serverSlaReading,
  shortDuration,
  slaReading,
  timeLeft,
} from '../caseFacts';
import { SignalProfile, caseRiskFactors } from '../SignalProfile';
import { StageTimeline } from '../StageTimeline';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const POLICY = {
  enabled: true,
  business_hours_only: false,
  targets: {
    P3: { response_minutes: 120, resolve_minutes: 1440 },
    P4: { response_minutes: 480, resolve_minutes: 2880 },
  },
} as unknown as SlaPolicy;

describe('B32: the SLA countdown never overstates the time left', () => {
  it('94 minutes left on a P3 reads "Response due in 1h" (it read "2h")', () => {
    const c = { case_id: 'c', priority_level: 'P3', status: 'open', created_at: minutesAgo(26) } as unknown as Case;
    expect(slaReading(c, POLICY, NOW)?.text).toBe('Response due in 1h');
  });

  it('7h 31m left on a P4 reads "7h" (it read "8h")', () => {
    const c = { case_id: 'c', priority_level: 'P4', status: 'open', created_at: minutesAgo(29) } as unknown as Case;
    expect(slaReading(c, POLICY, NOW)?.text).toBe('Response due in 7h');
  });

  it('shortDuration takes the rounding; timeLeft floors', () => {
    expect(shortDuration(94 * 60_000)).toBe('2h');
    expect(shortDuration(94 * 60_000, Math.floor)).toBe('1h');
    expect(timeLeft(94 * 60_000)).toBe('1h');
    expect(timeLeft(2.9 * 86_400_000)).toBe('2d');
  });

  it("formats the server's reading with the same floor", () => {
    const reading = {
      clock: 'response',
      start_at: minutesAgo(26),
      anchor: 'created',
      responded_at: null,
      target_minutes: 120,
      due_at: new Date(NOW + 94 * 60_000).toISOString(),
      elapsed_minutes: 26,
      state: 'ok',
      priority: 'P3',
      priority_source: 'priority_level',
    };
    expect(serverSlaReading(reading, NOW)).toMatchObject({ text: 'Response due in 1h', state: 'running', priority: 'P3' });
    expect(serverSlaReading({ ...reading, state: 'met' }, NOW)?.text).toBe('SLA met');
  });
});

describe('the SLA reading counts the same human responses as the server', () => {
  it('a person moving the case into Escalated stops the response clock', () => {
    const c = {
      case_id: 'c',
      priority_level: 'P3',
      status: 'escalated',
      created_at: minutesAgo(200),
      status_history: [{ from_status: 'open', to_status: 'escalated', by: 'analyst1', at: minutesAgo(30) }],
    } as unknown as Case;
    // Before: "Response overdue by 1h" while the server counted the response as met.
    expect(slaReading(c, POLICY, NOW)?.text).toBe('Resolution due in 20h');
  });

  it('an automatic escalation is not a response', () => {
    const c = {
      case_id: 'c',
      status_history: [{ from_status: 'open', to_status: 'escalated', by: 'system', at: minutesAgo(30) }],
    } as unknown as Case;
    expect(firstHumanResponse(c)).toBeNull();
  });

  it('is at risk from 80% of the target, the metrics rule', () => {
    const at = (m: number) =>
      slaReading({ case_id: 'c', priority_level: 'P3', status: 'open', created_at: minutesAgo(m) } as unknown as Case, POLICY, NOW)?.state;
    expect(at(95)).toBe('running');
    expect(at(96)).toBe('due_soon');
    expect(at(121)).toBe('breached');
  });
});

describe('the First event and Time to detect clocks', () => {
  it('reads first_seen_millis and the per-case time to detect', () => {
    const c = {
      case_id: 'c',
      created_at: '2026-11-24T10:04:00Z',
      first_seen_millis: Date.parse('2026-11-24T10:00:00Z'),
    } as unknown as Case;
    const clocks = caseClocks(c);
    expect(clocks.map((k) => k.label)).toEqual(['First event', 'Opened', 'Time to detect']);
    expect(clocks.find((k) => k.label === 'Time to detect')?.relative).toBe('4m');
    expect(clocks[0].at).toBe('2026-11-24T10:00:00.000Z');
  });

  it('leaves both out without a first-event instant', () => {
    const clocks = caseClocks({ case_id: 'c', created_at: '2026-11-24T10:04:00Z' } as unknown as Case);
    expect(clocks.map((k) => k.label)).toEqual(['Opened']);
  });
});

const INPUTS: RiskInputs = {
  event_count: 3,
  span_seconds: 120,
  effective_window_seconds: 120,
  rate_per_minute: 1.5,
  velocity_rule: 'rate',
  rule_values: ['r1'],
  rule_type_count: 1,
  reputation_input: 0,
  reputation_source: 'enrichment',
  asset_value: 0,
  asset_match: 'none',
  weights: { volume: 0.25, velocity: 0.2, reputation: 0.3, diversity: 0.15, asset_criticality: 0.1 },
  total_weight: 1,
  zero_weight_fallback: false,
  refs: { volume: 50, velocity: 10, diversity: 5 },
  scored_at: '2026-11-24T10:00:00+00:00',
  inputs_version: 1,
};

describe('B13 Console: the factor sentences read the recorded inputs', () => {
  const scored = {
    case_id: 'b13',
    risk_score: 15.82,
    member_event_keys: Array.from({ length: 50 }, (_, i) => `k${i}`),
    risk_breakdown: { volume: 35.26, velocity: 15, reputation: 0, diversity: 20, asset_criticality: 0, total: 15.82, inputs: INPUTS },
  } as unknown as Case;

  it('a case scored on 3 events that attached 47 more still says 3, and says the member count apart', () => {
    const volume = caseRiskFactors(scored, null).find((f) => f.key === 'volume');
    // Before the fix: "The case records 50 correlated events; its stored Volume factor is 35/100."
    expect(volume?.caseReason).not.toContain('50 correlated events');
    expect(volume?.caseReason).toBe(
      'The scoring run counted 3 events; Volume is 35/100. The case now holds 50 events; the score was computed from the 3 events in its scoring run.',
    );
    const velocity = caseRiskFactors(scored, null).find((f) => f.key === 'velocity');
    expect(velocity?.caseReason).toBe('3 events over 120 s is 1.5 per minute; Velocity is 15/100.');
  });

  it('without recorded inputs the member count is never the Volume input', () => {
    const legacy = { ...scored, risk_breakdown: { ...scored.risk_breakdown, inputs: undefined } } as unknown as Case;
    const volume = caseRiskFactors(legacy, null).find((f) => f.key === 'volume');
    expect(volume?.caseReason).toBe(
      'The deterministic breakdown stores Volume at 35/100; the event count used at scoring was not recorded. The case now holds 50 events; the score was computed from the events in its scoring run.',
    );
  });
});

describe('the risk meter shows and bands the integer rounded half up', () => {
  it('73.6 shows 74 and is painted critical, with its explainer', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SignalProfile c={{ case_id: 'r', risk_score: 73.6, risk_breakdown: null } as unknown as Case} triage={null} />,
    );
    expect(screen.getByRole('progressbar', { name: 'Risk score: 74/100' })).toBeInTheDocument();
    expect(container.querySelector('.bg-critical')).not.toBeNull();
    await user.hover(screen.getByRole('button', { name: /74\/100/ }));
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent('Risk 73.6: no factor breakdown was recorded for this case.');
  });
});

describe('B80 hunk: the untrusted marker wraps as one unit', () => {
  it('the caption may wrap; the marker never splits', () => {
    const { container } = render(
      <StageTimeline
        data={{
          case_id: 'c',
          total: 1,
          stages: [
            {
              id: 'in',
              kind: 'input',
              label: 'Alert received',
              status: 'done',
              deterministic: false,
              headline: '3 alerts',
              state: {},
              steps: [{ kind: 'evidence', label: 'evidence', body: 'raw', trusted: false }],
            },
          ],
        }}
      />,
    );
    const caption = container.querySelector('[data-untrusted-caption]') as HTMLElement;
    expect(caption).toHaveClass('flex-wrap', 'whitespace-normal', 'min-w-0');
    expect(caption).not.toHaveClass('truncate');
    const marker = within(caption).getByText('Untrusted source data');
    expect(marker).toHaveAttribute('data-untrusted-marker');
    expect(marker).toHaveClass('whitespace-nowrap');
    fireEvent.click(document.body);
  });
});

describe('B32 (WP11 review): under a minute left never reads "1m"', () => {
  it('timeLeft says "under 1m" below a minute', () => {
    expect(timeLeft(30_000)).toBe('under 1m');
    expect(timeLeft(60_000)).toBe('1m');
  });

  it('a P3 with 20 seconds left reads "Response due in under 1m"', () => {
    const c = {
      case_id: 'c',
      priority_level: 'P3',
      status: 'open',
      created_at: new Date(NOW - (120 * 60_000 - 20_000)).toISOString(),
    } as unknown as Case;
    expect(slaReading(c, POLICY, NOW)?.text).toBe('Response due in under 1m');
  });
});

void React;
