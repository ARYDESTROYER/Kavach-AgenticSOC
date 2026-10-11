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

export type QueueScope = 'active' | 'mine' | 'all';
export type QueueSort = 'updated_desc' | 'risk_desc' | 'created_desc' | 'title_asc';

/** How many rows one queue page fetches. */
export const QUEUE_PAGE_SIZE = 50;
/** The server's page ceiling (`CASE_PAGE_LIMIT`) — the largest single request. */
export const QUEUE_MAX_PAGE = 200;
/** "Select all matching" is a server snapshot; the durable job accepts up to 5,000 ids. */
export const QUEUE_SELECT_ALL_LIMIT = 5000;

export const TERMINAL_STATUSES = new Set(['closed', 'resolved']);

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
