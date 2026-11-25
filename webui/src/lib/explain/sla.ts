/**
 * The SLA explanation (Round 16 SPEC §4.5 WP11; research explainability R6 and D2).
 *
 * The server's per-case SLA reading (`GET /api/cases/{id}/triage`, field `sla`) uses the
 * clock rules of the SLA metrics: the response clock stops at the first human response
 * (an acknowledgement, or a person moving the case into Investigating, Escalated or On
 * hold), and a clock is breached once its elapsed time is over the target, at risk from
 * 80% of the target while it still runs. This module states that arithmetic; it never
 * re-derives a reading of its own.
 *
 * Pure: plain data only. Advisory: never feeds `decide()` (#3).
 */
import { trimmed } from './rounding';
import type { Explanation, ExplanationInput } from './types';

/** The server's per-case SLA reading (`GET /api/cases/{id}/triage`, field `sla`). */
export interface SlaReadingWire {
  clock: 'response' | 'resolution' | string;
  start_at: string | null;
  anchor: 'created' | 'acknowledged' | 'status_history' | string;
  responded_at: string | null;
  target_minutes: number | null;
  due_at: string | null;
  elapsed_minutes: number | null;
  state: string;
  priority: string | null;
  priority_source: string | null;
}

/** The share of a target after which a running clock is at risk (contract `sla`). */
export const SLA_AT_RISK_FRACTION = 0.8;

export type SlaClockState = 'ok' | 'at_risk' | 'breached';

/**
 * One clock's state, as the server's SLA metrics read it: breached when the elapsed time
 * is over the target; at risk when the clock still runs and at least 80% of the target
 * has passed; otherwise ok.
 */
export function slaClockState(targetMinutes: number, elapsedMinutes: number, stopped: boolean): SlaClockState {
  if (elapsedMinutes > targetMinutes) return 'breached';
  if (!stopped && elapsedMinutes >= targetMinutes * SLA_AT_RISK_FRACTION) return 'at_risk';
  return 'ok';
}

const STATE_WORDS: Record<string, string> = {
  ok: 'on track',
  running: 'on track',
  at_risk: 'at risk',
  due_soon: 'at risk',
  breached: 'breached',
  met: 'met',
};

const ANCHOR_WORDS: Record<string, string> = {
  created: 'when the case was detected or opened',
  acknowledged: 'the acknowledgement',
  status_history: 'a person moving the case into Investigating, Escalated or On hold',
};

/** Minutes as "1h 34m" or "26m". */
function minutesWords(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** The SLA clock of a case, from the server's reading. */
export function explainSla(reading: SlaReadingWire | null | undefined): Explanation | null {
  if (!reading || typeof reading.state !== 'string') return null;
  const target = typeof reading.target_minutes === 'number' ? reading.target_minutes : null;
  const elapsed = typeof reading.elapsed_minutes === 'number' ? reading.elapsed_minutes : null;
  if (target === null || elapsed === null) return null;
  const kind = String(reading.clock).toLowerCase() === 'resolution' ? 'Resolution' : 'Response';
  const priority = (reading.priority || '').trim().toUpperCase() || 'No priority';
  const state = String(reading.state).toLowerCase();
  // A clock that stopped (a person answered, or the case closed; the server reads it
  // "met") is met, not "on track": it no longer runs, so it can no longer be at risk.
  const stopped = state === 'met' || (Boolean(reading.responded_at) && kind === 'Response');
  const words = stopped && (state === 'ok' || state === 'met') ? 'met' : STATE_WORDS[state] ?? state;
  const stoppedBy = kind === 'Response' ? 'answered' : 'resolved';
  const atRiskFrom = target * SLA_AT_RISK_FRACTION;
  const left = target - elapsed;

  const inputs: ExplanationInput[] = [
    {
      key: 'priority',
      label: 'Priority',
      value: priority,
      source: reading.priority_source ? `From ${reading.priority_source.replace(/_/g, ' ')}` : 'The case',
    },
    { key: 'target', label: `${kind} target`, value: `${trimmed(target)} minutes`, source: 'SLA policy' },
  ];
  if (reading.start_at) {
    inputs.push({ key: 'start_at', label: 'Clock started', value: reading.start_at, source: 'Detected or opened' });
  }
  if (kind === 'Response') {
    inputs.push({
      key: 'responded_at',
      label: 'First human response',
      value: reading.responded_at ?? 'None yet',
      source: reading.responded_at ? `From ${ANCHOR_WORDS[reading.anchor] ?? reading.anchor}` : 'No person has responded',
    });
  }
  if (reading.due_at) inputs.push({ key: 'due_at', label: 'Due', value: reading.due_at, source: 'Start plus target' });

  const summary =
    state === 'breached'
      ? `${kind} SLA ${priority}: ${minutesWords(elapsed)} elapsed against a ${minutesWords(target)} target, so it is breached by ${minutesWords(-left)}.`
      : stopped
        ? `${kind} SLA ${priority}: ${stoppedBy} after ${minutesWords(elapsed)} against a ${minutesWords(target)} target, ${words}.`
        : `${kind} SLA ${priority}: ${minutesWords(elapsed)} of ${minutesWords(target)} elapsed, ${words}. At risk from ${minutesWords(atRiskFrom)}.`;

  return {
    metric: 'sla',
    title: `${kind} SLA`,
    value: state,
    display: `${priority} ${kind.toLowerCase()} ${words}`,
    summary,
    formula: 'breached when elapsed > target; at risk when the clock runs and elapsed >= 0.8 x target; otherwise on track',
    inputs,
    steps: [
      { label: 'Elapsed', expression: stopped ? (kind === 'Response' ? 'Start to the first human response' : 'Start to the close') : 'Start to now', result: `${trimmed(elapsed)} minutes` },
      { label: 'At risk from', expression: `0.8 x ${trimmed(target)}`, result: `${trimmed(atRiskFrom)} minutes` },
      { label: 'State', expression: `${trimmed(elapsed)} against ${trimmed(target)}`, result: words },
    ],
    rounding: 'Time left is rounded down, so the due line never claims more time than remains.',
    provenance: 'server_computed',
    caveats: ['Advisory only: the SLA never closes or escalates a case.'],
  };
}
