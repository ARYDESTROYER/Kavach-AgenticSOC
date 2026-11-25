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

/** One clock of the server's reading (`sla.clocks.response` or `sla.clocks.resolution`). */
export interface SlaClockWire {
  target_minutes: number | null;
  start_at: string | null;
  /** `null` when the clock is never due (a target past the last date it can count to). */
  due_at: string | null;
  stopped_at: string | null;
  stop_source: string | null;
  elapsed_minutes: number | null;
  running: boolean | null;
  state: string | null;
}

/** The server's per-case SLA reading (`GET /api/cases/{id}/triage`, field `sla`). */
export interface SlaReadingWire {
  clock: 'response' | 'resolution' | string;
  start_at: string | null;
  anchor: 'created' | 'acknowledged' | 'status_history' | string;
  responded_at: string | null;
  target_minutes: number | null;
  /** `null` when the clock is never due (a target past the last date it can count to). */
  due_at: string | null;
  elapsed_minutes: number | null;
  state: string;
  priority: string | null;
  priority_source: string | null;
  /** Whether the shown clock still runs (absent from a build before WP10's reading). */
  running?: boolean | null;
  /** True when ANY clock of the case is breached: the rule the SLA metrics count by. */
  breached?: boolean | null;
  /** Both clocks, `null` where the policy sets no target. */
  clocks?: { response?: SlaClockWire | null; resolution?: SlaClockWire | null } | null;
  /** `console` when the Console computed the reading from the SLA policy itself. */
  computed_by?: 'server' | 'console';
  /**
   * What stopped the shown clock (the clock's `stop_source`), set when the line shows a
   * clock other than the server's current one. `terminal` on the response clock: the
   * case closed before any person responded.
   */
  stop_source?: string | null;
}

/**
 * The clock a case's SLA line shows: the server's current clock, unless it has stopped
 * while another clock of the case is breached. Then the breached clock is shown, so a
 * closed case whose response was late reads its late response, not "met", and agrees
 * with the SLA metrics, which count the case as a breach. A clock that still runs stays
 * the line: it is the time left to act on, and its explanation names the earlier breach
 * (`explainSla`). Null for no reading.
 */
export function shownSlaClock(reading: SlaReadingWire | null | undefined): SlaReadingWire | null {
  if (!reading || typeof reading.state !== 'string') return null;
  const state = reading.state.toLowerCase();
  if (reading.breached !== true || state === 'breached' || reading.running === true) return reading;
  const clocks = reading.clocks ?? null;
  const current = String(reading.clock).toLowerCase() === 'resolution' ? 'resolution' : 'response';
  const order: Array<'response' | 'resolution'> =
    current === 'response' ? ['resolution', 'response'] : ['response', 'resolution'];
  for (const name of order) {
    const clock = clocks?.[name];
    if (!clock || String(clock.state || '').toLowerCase() !== 'breached') continue;
    return {
      ...reading,
      clock: name,
      start_at: clock.start_at ?? reading.start_at,
      target_minutes: typeof clock.target_minutes === 'number' ? clock.target_minutes : null,
      due_at: clock.due_at ?? null,
      elapsed_minutes: typeof clock.elapsed_minutes === 'number' ? clock.elapsed_minutes : null,
      running: typeof clock.running === 'boolean' ? clock.running : null,
      stop_source: clock.stop_source ?? null,
      state: 'breached',
    };
  }
  // The server says a clock is breached but did not say which: never read "met" then.
  return { ...reading, state: 'breached' };
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

/** Minutes as "1h 34m", "26m", or "40s" under a minute (never "0m" for time that passed). */
function minutesWords(minutes: number): string {
  const safe = Math.max(0, minutes);
  if (safe < 1) return `${Math.floor(safe * 60)}s`;
  const whole = Math.floor(safe);
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
  // "met") is met, not "on track": it no longer runs, so it can no longer be at risk. The
  // server says so in `running`; a reading without it falls back to its other fields.
  const stopped =
    typeof reading.running === 'boolean'
      ? !reading.running
      : state === 'met' || (Boolean(reading.responded_at) && kind === 'Response');
  const words = stopped && (state === 'ok' || state === 'met') ? 'met' : STATE_WORDS[state] ?? state;
  // The response clock also stops when the case closes before any person responded
  // (`stop_source: terminal`): nobody answered it then, so it never says "answered".
  const clockName = kind === 'Response' ? 'response' : 'resolution';
  const stopSource = reading.stop_source ?? reading.clocks?.[clockName]?.stop_source ?? null;
  const closedUnanswered = stopped && kind === 'Response' && stopSource === 'terminal';
  const stoppedBy = closedUnanswered ? 'closed with no human response' : kind === 'Response' ? 'answered' : 'resolved';
  const atRiskFrom = target * SLA_AT_RISK_FRACTION;
  const left = target - elapsed;
  const byConsole = reading.computed_by === 'console';
  const earlier = state === 'breached' ? null : earlierBreach(reading, clockName);

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
      value: reading.responded_at ?? (closedUnanswered ? 'None' : 'None yet'),
      source: reading.responded_at
        ? `From ${ANCHOR_WORDS[reading.anchor] ?? reading.anchor}`
        : closedUnanswered
          ? 'The case closed before any person responded'
          : 'No person has responded',
    });
  }
  if (reading.due_at) inputs.push({ key: 'due_at', label: 'Due', value: reading.due_at, source: 'Start plus target' });
  else inputs.push({ key: 'due_at', label: 'Due', value: 'Not due', source: 'The target is longer than the clock can count' });

  const summary =
    state === 'breached'
      ? stopped
        ? `${kind} SLA ${priority}: ${stoppedBy} after ${minutesWords(elapsed)} against a ${minutesWords(target)} target, so it was breached by ${minutesWords(-left)}.`
        : `${kind} SLA ${priority}: ${minutesWords(elapsed)} elapsed against a ${minutesWords(target)} target, so it is breached by ${minutesWords(-left)}.`
      : stopped
        ? `${kind} SLA ${priority}: ${stoppedBy} after ${minutesWords(elapsed)} against a ${minutesWords(target)} target, ${words}.`
        : `${kind} SLA ${priority}: ${minutesWords(elapsed)} of ${minutesWords(target)} elapsed, ${words}. At risk from ${minutesWords(atRiskFrom)}.`;
  const caveats = ['Advisory only: the SLA never closes or escalates a case.'];
  if (earlier) caveats.unshift(`${earlier} The SLA metrics count this case as breached.`);

  return {
    metric: 'sla',
    title: `${kind} SLA`,
    value: state,
    display: `${priority} ${kind.toLowerCase()} ${words}`,
    summary: earlier ? `${summary} ${earlier}` : summary,
    formula: 'breached when elapsed > target; at risk when the clock runs and elapsed >= 0.8 x target; otherwise on track',
    inputs,
    steps: [
      {
        label: 'Elapsed',
        expression: stopped
          ? kind === 'Response' && !closedUnanswered
            ? 'Start to the first human response'
            : 'Start to the close'
          : 'Start to now',
        result: `${trimmed(elapsed)} minutes`,
      },
      { label: 'At risk from', expression: `0.8 x ${trimmed(target)}`, result: `${trimmed(atRiskFrom)} minutes` },
      { label: 'State', expression: `${trimmed(elapsed)} against ${trimmed(target)}`, result: words },
    ],
    rounding: 'Time left is rounded down, so the due line never claims more time than remains.',
    provenance: byConsole ? 'reconstructed_current' : 'server_computed',
    ...(byConsole ? { provenanceNote: 'Computed in the Console from the SLA policy, because the server sent no reading.' } : {}),
    caveats,
  };
}

/**
 * The sentence for another clock of the case that is breached while the shown one is not
 * (`breached` on the reading): a case answered late whose resolution clock still runs.
 * The line shows the running clock; this sentence keeps the breach the SLA metrics count
 * one hover away. Null when no other clock is breached.
 */
function earlierBreach(reading: SlaReadingWire, shown: 'response' | 'resolution'): string | null {
  if (reading.breached !== true) return null;
  const otherName = shown === 'response' ? 'resolution' : 'response';
  const other = reading.clocks?.[otherName];
  if (!other || String(other.state || '').toLowerCase() !== 'breached') {
    return 'Another SLA clock of this case is breached.';
  }
  const target = typeof other.target_minutes === 'number' ? other.target_minutes : null;
  const elapsed = typeof other.elapsed_minutes === 'number' ? other.elapsed_minutes : null;
  const label = otherName === 'response' ? 'The response clock' : 'The resolution clock';
  if (target === null || elapsed === null) return `${label} is breached.`;
  if (other.running === false) {
    const by =
      otherName === 'response' ? (other.stop_source === 'terminal' ? 'closed with no human response' : 'answered') : 'resolved';
    return `${label} was breached: ${by} after ${minutesWords(elapsed)} against a ${minutesWords(target)} target.`;
  }
  return `${label} is breached: ${minutesWords(elapsed)} elapsed against a ${minutesWords(target)} target.`;
}
