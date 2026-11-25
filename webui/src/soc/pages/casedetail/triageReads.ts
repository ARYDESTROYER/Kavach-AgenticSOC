/**
 * The case facts the triage read carries for a person who may not read the settings
 * (Round 16, SPEC §4.4 WP03, C60).
 *
 * Case detail calls `GET /api/settings` only for a holder of `settings:read`. Without it,
 * the auto-close entry for the case's verdict and the SLA reading come from
 * `GET /api/cases/{id}/triage` (WP10 adds `auto_close_policy` and `sla` there). Both
 * fields are read defensively: a build whose triage read does not carry them yet, or a
 * value of the wrong shape, reads as "not known" and the fact is left out.
 *
 * Pure: nothing here fetches, decides or mutates (#3). Every value is plain data for the
 * caller to render as text (#9).
 */
import type { SlaReadingWire } from '@/lib/explain/builders';
import type { Case, SlaPolicy } from '@/lib/types';

import { millis, shortDuration, slaReading, type SlaReading, type SlaState } from './caseFacts';
import type { FpPolicy } from './shared';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The triage read's auto-close entry for the case's verdict, or null when it has none. */
export function triageAutoClosePolicy(response: unknown): FpPolicy {
  const entry = record(record(response)?.auto_close_policy);
  if (!entry) return null;
  return {
    enabled: entry.enabled === true,
    min_confidence: num(entry.min_confidence),
    max_risk_score: num(entry.max_risk_score),
    objection_window_minutes: num(entry.objection_window_minutes),
  };
}

/** The triage read's SLA reading, or null when it has none. */
export function triageSla(response: unknown): SlaReadingWire | null {
  const sla = record(record(response)?.sla);
  if (!sla || typeof sla.state !== 'string') return null;
  const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
  return {
    clock: typeof sla.clock === 'string' ? sla.clock : 'response',
    start_at: str(sla.start_at),
    anchor: typeof sla.anchor === 'string' ? sla.anchor : 'created',
    responded_at: str(sla.responded_at),
    target_minutes: num(sla.target_minutes) ?? null,
    due_at: str(sla.due_at),
    elapsed_minutes: num(sla.elapsed_minutes) ?? null,
    state: sla.state,
    priority: str(sla.priority),
    priority_source: str(sla.priority_source),
  };
}

const SERVER_STATE: Record<string, SlaState> = {
  ok: 'running',
  running: 'running',
  at_risk: 'due_soon',
  due_soon: 'due_soon',
  breached: 'breached',
  met: 'met',
};

/**
 * The meta strip's SLA phrase from the server's reading ("Response due in 45m",
 * "Resolution overdue by 2h"), in the same shape as `caseFacts.slaReading`. Null when the
 * reading names no due time or priority, so nothing is claimed that was not read.
 */
export function slaFromServer(reading: SlaReadingWire | null | undefined, now: number = Date.now()): SlaReading | null {
  if (!reading) return null;
  const state = SERVER_STATE[String(reading.state).toLowerCase()];
  const priority = (reading.priority || '').trim().toUpperCase();
  const due = millis(reading.due_at);
  if (!state || !priority || due === null) return null;
  const kind = String(reading.clock).toLowerCase() === 'resolution' ? 'Resolution' : 'Response';
  if (state === 'met') return { text: 'SLA met', state, priority };
  const left = due - now;
  if (state === 'breached' || left < 0) {
    return { text: `${kind} overdue by ${shortDuration(Math.abs(left))}`, state: 'breached', priority };
  }
  return { text: `${kind} due in ${shortDuration(left)}`, state, priority };
}

/**
 * The SLA reading the meta strip and the inspector show: the server's reading from the
 * triage read when it carries one (it is computed with the clock rules of the SLA
 * metrics), else the reading from the SLA policy when the settings were read.
 */
export function caseSlaReading(
  c: Case,
  slaPolicy: SlaPolicy | null | undefined,
  serverSla: SlaReadingWire | null | undefined,
  now: number = Date.now(),
): SlaReading | null {
  return slaFromServer(serverSla, now) ?? (slaPolicy ? slaReading(c, slaPolicy, now) : null);
}
