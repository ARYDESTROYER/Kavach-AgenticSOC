/**
 * Case Manager queue — pure helpers (Round 12, CM-1).
 *
 * The queue is SERVER-backed: scope, status, severity, search, owner and sort all go to
 * `GET /api/cases` and the server pages the whole matching population. Before this the
 * queue loaded the newest 200 cases and filtered in the browser, so an open case older
 * than the newest 200 was silently missing from "Active" and no search could find it.
 *
 * Nothing here decides anything (#3); every case-derived string stays plain data (#9).
 */
import type { Case } from '@/lib/types';
import { severityBand } from '@/soc/components/badges';

export type QueueScope = 'active' | 'mine' | 'all';
export type QueueSort = 'updated_desc' | 'risk_desc' | 'created_desc' | 'title_asc';

/** How many rows one queue page fetches. */
export const QUEUE_PAGE_SIZE = 50;
/** The server's page ceiling (`CASE_PAGE_LIMIT`) — the largest single request. */
export const QUEUE_MAX_PAGE = 200;
/** "Select all matching" is a server snapshot; the durable job accepts up to 5,000 ids. */
export const QUEUE_SELECT_ALL_LIMIT = 5000;

export const TERMINAL_STATUSES = new Set(['closed', 'resolved']);
/** The server's `active` lifecycle group (`constants.OPEN_CASE_STATUSES`), verbatim. */
export const ACTIVE_STATUSES = new Set(['new', 'open', 'needs_human', 'investigating', 'escalated', 'on_hold']);

/** The full lifecycle taxonomy, in workflow order (the Status filter lists all of it). */
export const QUEUE_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string; terminal: boolean }> = [
  { value: 'new', label: 'New', terminal: false },
  { value: 'open', label: 'Open', terminal: false },
  { value: 'needs_human', label: 'Open · awaiting analyst', terminal: false },
  { value: 'investigating', label: 'Investigating', terminal: false },
  { value: 'escalated', label: 'Escalated', terminal: false },
  { value: 'on_hold', label: 'On hold', terminal: false },
  { value: 'resolved', label: 'Resolved', terminal: true },
  { value: 'closed', label: 'Closed', terminal: true },
];

export const QUEUE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SORTS: Record<QueueSort, { sort_field: string; sort_order: 'asc' | 'desc' }> = {
  updated_desc: { sort_field: 'updated_at', sort_order: 'desc' },
  risk_desc: { sort_field: 'risk_score', sort_order: 'desc' },
  created_desc: { sort_field: 'created_at', sort_order: 'desc' },
  title_asc: { sort_field: 'title', sort_order: 'asc' },
};

export interface QueueQueryInput {
  scope: QueueScope;
  /** The signed-in analyst (Mine); ignored for the other scopes. */
  username?: string | null;
  search: string;
  severity: string | null;
  status: string | null;
  sort: QueueSort;
}

/**
 * The `GET /api/cases` parameters for a queue view (without paging). A single status
 * replaces the lifecycle group (the server refuses both at once); a terminal status in
 * an active-only scope is dropped, since that combination can only ever be empty.
 */
export function queueQuery(input: QueueQueryInput): Record<string, string> {
  const query: Record<string, string> = { ...SORTS[input.sort] };
  const activeOnly = input.scope !== 'all';
  const status = input.status && !(activeOnly && TERMINAL_STATUSES.has(input.status)) ? input.status : null;
  if (status) query.status = status;
  else if (activeOnly) query.status_group = 'active';
  if (input.scope === 'mine' && input.username) query.assignee = input.username;
  const q = input.search.trim();
  if (q) query.q = q.slice(0, 200);
  if (input.severity) query.severity = input.severity;
  return query;
}

/** Whether a case belongs in a scope (used to keep live updates honest). */
export function caseInScope(c: Case, scope: QueueScope, username?: string | null): boolean {
  const status = String(c.status || '').toLowerCase();
  if (scope === 'all') return true;
  if (TERMINAL_STATUSES.has(status)) return false;
  if (scope === 'mine') {
    return Boolean(username) && String(c.assignee || '').trim().toLowerCase() === String(username).toLowerCase();
  }
  return true;
}

/** The fields the queue search has always matched, case-folded (the instant pre-filter). */
export function queueHaystack(c: Case): string {
  return [
    c.case_id,
    c.case_number,
    c.title,
    c.summary,
    c.status,
    c.verdict,
    c.entity?.type,
    c.entity?.value,
    c.source_name,
    c.assignee,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** True when every search term appears in the case's searchable fields. */
export function matchesSearch(c: Case, search: string): boolean {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = queueHaystack(c);
  return terms.every((term) => hay.includes(term));
}

/**
 * The band a queue row shows and the server's `severity` filter matches: the read-time
 * severity band, else the risk band, else info (`routes._queue_severity`, same chain).
 */
export function queueSeverity(c: Case): string {
  return severityBand(c.severity_band) ?? severityBand(c.risk_score) ?? 'info';
}

/**
 * Does a case belong in the current queue view? A client mirror of the server's
 * `GET /api/cases` predicate for {@link queueQuery}, so a live update or a detail
 * mutation can keep a filtered view honest without waiting for a manual refresh:
 *
 * - `in`: the server would list it.
 * - `out`: the server would not (status, owner, search or severity no longer match).
 * - `unknown`: only the server can say. A lifecycle-action response carries no
 *   read-time severity band, so with a severity filter on its membership is unknown.
 */
export type QueueMembership = 'in' | 'out' | 'unknown';

export function queueMembership(c: Case, input: QueueQueryInput): QueueMembership {
  const query = queueQuery(input);
  const status = String(c.status || '').trim().toLowerCase();
  if (query.status ? status !== query.status : query.status_group === 'active' && !ACTIVE_STATUSES.has(status)) {
    return 'out';
  }
  if (query.assignee && String(c.assignee || '').trim().toLowerCase() !== query.assignee.trim().toLowerCase()) {
    return 'out';
  }
  if (query.q && !matchesSearch(c, query.q)) return 'out';
  if (query.severity) {
    if (!c.severity_band) return 'unknown';
    if (queueSeverity(c) !== query.severity) return 'out';
  }
  return 'in';
}

function millis(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : -1;
}

/** The value the server orders a sort by (`routes._queue_sort_key`, without the tiebreak). */
export function queueSortValue(c: Case, sort: QueueSort): number | string {
  if (sort === 'risk_desc') {
    return typeof c.risk_score === 'number' && Number.isFinite(c.risk_score) ? c.risk_score : -1;
  }
  if (sort === 'title_asc') {
    const title = [c.title, c.summary, c.case_number, c.case_id].find((v) => v !== null && v !== undefined && v !== '');
    return String(title ?? '').toLowerCase();
  }
  return millis(sort === 'created_desc' ? c.created_at : c.updated_at);
}

/** < 0: `a` lists before `b`; > 0: after; 0: a tie on the sort value (the server orders ties). */
export function compareQueueOrder(a: Case, b: Case, sort: QueueSort): number {
  const va = queueSortValue(a, sort);
  const vb = queueSortValue(b, sort);
  if (va === vb) return 0;
  const ascending = sort === 'title_asc';
  return (va < vb) === ascending ? -1 : 1;
}

/**
 * Where a case the queue has NOT loaded falls against the loaded window:
 * `inside` (the server now lists it among the loaded rows, or everything is loaded),
 * `beyond` (it lists after them, so it is reached with Load more), or `edge` (it ties
 * with the last loaded row, so only the server can place it).
 */
export function windowPlacement(
  c: Case,
  loaded: readonly Case[],
  total: number,
  sort: QueueSort,
): 'inside' | 'beyond' | 'edge' {
  const others = loaded.filter((row) => row.case_id !== c.case_id);
  if (others.length === 0 || others.length >= total) return 'inside';
  // The boundary is the loaded row that lists LAST — not the last row on screen, which
  // may have been updated in place since the window was read.
  const boundary = others.reduce((last, row) => (compareQueueOrder(row, last, sort) > 0 ? row : last));
  const order = compareQueueOrder(c, boundary, sort);
  return order < 0 ? 'inside' : order > 0 ? 'beyond' : 'edge';
}

/**
 * The read-time advisory fields `GET /api/cases` adds. A lifecycle-action response is
 * the stored case without them, so a row keeps the ones it was listed with.
 */
const ADVISORY_FIELDS = ['severity_band', 'severity_source', 'impact_band', 'urgency_band', 'priority_level'] as const;

export function mergeQueueRow(previous: Case, next: Case): Case {
  const merged: Case = { ...next };
  for (const field of ADVISORY_FIELDS) {
    if ((merged as Record<string, unknown>)[field] == null && (previous as Record<string, unknown>)[field] != null) {
      (merged as Record<string, unknown>)[field] = (previous as Record<string, unknown>)[field];
    }
  }
  return merged;
}

/** The queue heading for a scope. */
export function scopeHeading(scope: QueueScope): string {
  if (scope === 'mine') return 'My cases';
  if (scope === 'all') return 'All cases';
  return 'Active cases';
}

/** "23 of 253 active · 50 loaded" — the scope line always states loaded vs total. */
export function scopeSummary(
  scope: QueueScope,
  loaded: number,
  total: number,
  position: number | null,
): string {
  const noun = scope === 'all' ? 'cases' : scope === 'mine' ? 'assigned to you' : 'active';
  const lead =
    position !== null
      ? `${position.toLocaleString()} of ${total.toLocaleString()} ${noun}`
      : `${total.toLocaleString()} ${noun}`;
  return `${lead} · ${loaded.toLocaleString()} loaded`;
}
