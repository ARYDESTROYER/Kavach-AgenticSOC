/**
 * The case facts the triage read carries for a person who may not read the settings
 * (Round 16, SPEC §4.4 WP03, C60).
 *
 * Case detail calls `GET /api/settings` only for a holder of `settings:read`. Without it,
 * the auto-close entry for the case's verdict and the SLA reading come from
 * `GET /api/cases/{id}/triage` (WP10 adds `auto_close_policy` and `sla` there). Every
 * field is read defensively: a build whose triage read does not carry it yet, or a value
 * of the wrong shape, reads as "not known" and the fact is left out.
 *
 * Pure: nothing here fetches, decides or mutates (#3). Every value is plain data for the
 * caller to render as text (#9).
 */
import type { AssetRangeReading, SlaClockWire, SlaReadingWire } from '@/lib/explain/builders';
import type { Case, SlaPolicy } from '@/lib/types';

import { serverSlaReading, slaReading, type SlaReading } from './caseFacts';
import type { FpPolicy } from './shared';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

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

/** One clock of the triage read's SLA reading, or null when it is not a clock. */
function slaClock(value: unknown): SlaClockWire | null {
  const clock = record(value);
  if (!clock) return null;
  return {
    target_minutes: num(clock.target_minutes) ?? null,
    start_at: str(clock.start_at),
    due_at: str(clock.due_at),
    stopped_at: str(clock.stopped_at),
    stop_source: str(clock.stop_source),
    elapsed_minutes: num(clock.elapsed_minutes) ?? null,
    running: bool(clock.running),
    state: str(clock.state),
  };
}

/** The triage read's SLA reading, or null when it has none. */
export function triageSla(response: unknown): SlaReadingWire | null {
  const sla = record(record(response)?.sla);
  if (!sla || typeof sla.state !== 'string') return null;
  const clocks = record(sla.clocks);
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
    running: bool(sla.running),
    breached: bool(sla.breached),
    clocks: clocks ? { response: slaClock(clocks.response), resolution: slaClock(clocks.resolution) } : null,
    computed_by: 'server',
  };
}

/**
 * The triage read's `asset_cidr` (WP10): the internal network range of today's settings
 * that holds the case's entity. The server sends the key only to a `settings:read`
 * holder; it is today's configuration, never the range in force at scoring. Null when it
 * is absent or not of that shape.
 */
export function triageAssetCidr(response: unknown): AssetRangeReading | null {
  const entry = record(record(response)?.asset_cidr);
  const cidr = str(entry?.cidr);
  if (!entry || !cidr) return null;
  return { cidr: cidr.trim(), criticality: num(entry.criticality) ?? null, matchesRecorded: bool(entry.matches_recorded) };
}

/**
 * The meta strip's SLA phrase from the server's reading ("Response due in 45m",
 * "Resolution overdue by 2h"): `caseFacts.serverSlaReading`, the one formatter, which
 * reads `breached` and `running`, floors the time left (B32) and reads a clock that is
 * never due as "not due".
 */
export function slaFromServer(reading: SlaReadingWire | null | undefined, now: number = Date.now()): SlaReading | null {
  return serverSlaReading(reading, now);
}

/**
 * The SLA reading the meta strip and the inspector show: the server's reading from the
 * triage read when it carries one (it is computed with the clock rules of the SLA
 * metrics), else the reading from the SLA policy when the settings were read. For an
 * ended case (`terminal`) only the server's reading counts: it is the one that knows
 * whether a stopped clock was late, and the Console's own reading of a closed case says
 * nothing ("SLA closed").
 */
export function caseSlaReading(
  c: Case,
  slaPolicy: SlaPolicy | null | undefined,
  serverSla: SlaReadingWire | null | undefined,
  now: number = Date.now(),
  terminal = false,
): SlaReading | null {
  const server = slaFromServer(serverSla, now);
  if (server || terminal) return server;
  return slaPolicy ? slaReading(c, slaPolicy, now) : null;
}
