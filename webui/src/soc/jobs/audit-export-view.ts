/**
 * The audit log view a finished `audit_export` job holds, read from its own params, for
 * the Jobs list, whose rows carry no result URL (SPEC §4.5.8). It writes the keys the
 * server's result URL writes (`job_url` in `backend/app/engine/jobs.py`), each range bound
 * normalised the way that URL writes it (UTC to the second), and validates them exactly as
 * it validates that URL ({@link jobDestinationFromUrl}). So "Open audit log" on Jobs, in
 * the Inbox and on a toast opens the same rows, for an export the Console submitted and
 * for one submitted through the API with a fraction or another zone. Only the Jobs page
 * imports it, so it stays off first paint.
 */
import type { BackgroundJob } from '@/lib/types';

import { jobDestinationFromUrl, type JobDestination } from './jobs';

/**
 * An export's filters the audit log's hash carries, as (job params name, route key), in
 * the server's order. The route has no key for the actor kind, the surface or the source,
 * so those stay out and the view shows at least the exported events.
 */
export const AUDIT_EXPORT_ROUTE_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ['event', 'event'],
  ['actor', 'actor'],
  ['actor_contains', 'actor_contains'],
  ['outcome', 'outcome'],
  ['case_id', 'case'],
  ['target', 'target'],
  ['ip', 'ip'],
];

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The instants an export accepts (the server's `parse_instant` grammar): minutes or
 * seconds, an optional fraction of up to six digits, and a zone, `Z` or `±HH:MM`.
 */
const EXPORT_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * One end of an export's range as the server's result URL writes it
 * (`_audit_route_instant`): in UTC, to the second, a fraction cut so the view covers at
 * least the exported range. Null for anything the server would not read as an instant:
 * date math, a missing zone, a date that does not exist, or one outside years 1 to 9999.
 */
export function auditRouteInstant(value: unknown): string | null {
  const match = EXPORT_INSTANT.exec(text(value));
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (year < 1) return null;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const exists =
    local.getUTCFullYear() === year &&
    local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day &&
    local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute &&
    local.getUTCSeconds() === second;
  if (!exists) return null;
  let offsetMinutes = 0;
  if (!match[7]) {
    const [offsetHours, offsetMins] = [Number(match[9]), Number(match[10])];
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const utc = new Date(local.getTime() - offsetMinutes * 60_000);
  const utcYear = utc.getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) return null;
  return (
    `${pad(utcYear, 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}` +
    `T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}Z`
  );
}

/**
 * Where "Open audit log" goes for a job on the Jobs page: the exported view, or the
 * export's scope when that view does not validate. Null for any other job, and for an
 * export that did not finish with its file.
 */
export function auditExportView(job: BackgroundJob): JobDestination | null {
  if (job.kind !== 'audit_export' || (job.status !== 'succeeded' && job.status !== 'partial')) return null;
  const params = job.params ?? {};
  const query = new URLSearchParams();
  const scope = text(params.scope);
  if (scope) query.set('scope', scope);
  const [from, to] = [auditRouteInstant(params.from), auditRouteInstant(params.to)];
  if (from && to) {
    query.set('from', from);
    query.set('to', to);
  }
  if (text(params.q)) query.set('q', text(params.q));
  const filters =
    params.filters && typeof params.filters === 'object' && !Array.isArray(params.filters)
      ? (params.filters as Record<string, unknown>)
      : {};
  for (const [name, key] of AUDIT_EXPORT_ROUTE_FILTERS) {
    if (text(filters[name])) query.set(key, text(filters[name]));
  }
  const scopeOnly = new URLSearchParams(scope ? { scope } : {});
  return (
    jobDestinationFromUrl(`#/audit?${query}`) ?? jobDestinationFromUrl(`#/audit?${scopeOnly}`) ?? { page: 'audit' }
  );
}
