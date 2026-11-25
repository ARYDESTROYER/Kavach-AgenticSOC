/**
 * Round 16 WP11I review: the SLA line and its explanation on the case page.
 *
 * * An open case answered late whose resolution clock still runs keeps the resolution
 *   countdown as its line (the time left to act on), and the explanation names the late
 *   response the SLA metrics count. It never replaces the live clock with "Response
 *   overdue" for a case a person already answered.
 * * A response clock the case's close stopped (no person ever responded) never reads
 *   "answered" in its explanation.
 * * Time under a minute reads in seconds, never "0m".
 */
import { describe, expect, it } from 'vitest';

import { explainSla, type SlaReadingWire } from '@/lib/explain/sla';

import { triageSla } from '../triageReads';
import { serverSlaReading } from '../caseFacts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const at = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

describe('an open case answered late keeps its running resolution clock', () => {
  // P2: response target 2h, answered after 5h; resolution target 24h, 10h elapsed, running.
  const OPEN_LATE_RESPONSE = {
    sla: {
      clock: 'resolution',
      start_at: at(-600),
      anchor: 'acknowledged',
      responded_at: at(-300),
      target_minutes: 1440,
      due_at: at(840),
      elapsed_minutes: 600,
      state: 'ok',
      priority: 'P2',
      priority_source: 'case_record',
      running: true,
      breached: true,
      clocks: {
        response: {
          target_minutes: 120,
          start_at: at(-600),
          due_at: at(-480),
          stopped_at: at(-300),
          stop_source: 'acknowledged_at',
          elapsed_minutes: 300,
          running: false,
          state: 'breached',
        },
        resolution: {
          target_minutes: 1440,
          start_at: at(-600),
          due_at: at(840),
          stopped_at: null,
          stop_source: null,
          elapsed_minutes: 600,
          running: true,
          state: 'ok',
        },
      },
    },
  };

  it('the line is the resolution countdown, not "Response overdue"', () => {
    const reading = serverSlaReading(triageSla(OPEN_LATE_RESPONSE), NOW);
    expect(reading?.text).toBe('Resolution due in 14h');
    expect(reading?.state).toBe('running');
    expect(reading?.wire?.clock).toBe('resolution');
  });

  it('its explanation names the late response the SLA metrics count', () => {
    const reading = serverSlaReading(triageSla(OPEN_LATE_RESPONSE), NOW);
    const exp = explainSla(reading?.wire);
    expect(exp?.summary).toBe(
      'Resolution SLA P2: 10h of 24h elapsed, on track. At risk from 19h 12m. The response clock was breached: answered after 5h against a 2h target.',
    );
    expect(exp?.caveats[0]).toBe(
      'The response clock was breached: answered after 5h against a 2h target. The SLA metrics count this case as breached.',
    );
  });
});

describe('a response clock the close stopped', () => {
  // The AI closed the case after 5h; no person responded. Response target 2h.
  const CLOSED_UNANSWERED = {
    sla: {
      clock: 'resolution',
      start_at: at(-600),
      anchor: 'created',
      responded_at: null,
      target_minutes: 4320,
      due_at: at(3720),
      elapsed_minutes: 300,
      state: 'met',
      priority: 'P4',
      priority_source: 'priority_matrix',
      running: false,
      breached: true,
      clocks: {
        response: {
          target_minutes: 120,
          start_at: at(-600),
          due_at: at(-480),
          stopped_at: at(-300),
          stop_source: 'terminal',
          elapsed_minutes: 300,
          running: false,
          state: 'breached',
        },
        resolution: {
          target_minutes: 4320,
          start_at: at(-600),
          due_at: at(3720),
          stopped_at: at(-300),
          stop_source: 'status_history',
          elapsed_minutes: 300,
          running: false,
          state: 'ok',
        },
      },
    },
  };

  it('reads the late response, and its explanation never says a person answered', () => {
    const reading = serverSlaReading(triageSla(CLOSED_UNANSWERED), NOW);
    expect(reading?.text).toBe('Response overdue by 3h');
    const exp = explainSla(reading?.wire);
    expect(exp?.summary).toBe(
      'Response SLA P4: closed with no human response after 5h against a 2h target, so it was breached by 3h.',
    );
    expect(exp?.summary).not.toContain('answered');
    expect(exp?.steps[0]).toMatchObject({ label: 'Elapsed', expression: 'Start to the close' });
    expect(exp?.inputs.find((input) => input.key === 'responded_at')).toMatchObject({
      value: 'None',
      source: 'The case closed before any person responded',
    });
  });
});

describe('time under a minute', () => {
  it('reads in seconds, never "0m"', () => {
    const closedFast: SlaReadingWire = {
      clock: 'resolution',
      start_at: at(-60),
      anchor: 'created',
      responded_at: null,
      target_minutes: 4320,
      due_at: at(4260),
      elapsed_minutes: 0.4,
      state: 'met',
      priority: 'P4',
      priority_source: 'priority_matrix',
      running: false,
      breached: false,
    };
    const exp = explainSla(closedFast);
    expect(exp?.summary).toBe('Resolution SLA P4: resolved after 24s against a 72h target, met.');
    expect(exp?.summary).not.toContain(' 0m');
  });
});
