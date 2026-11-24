/**
 * Team activity: the page's pure helpers (Round 15 SPEC D3.8, D3.11). No DOM, no I/O.
 *
 * * The range control's presets and custom range, mapped to the server's window tokens
 *   by the page itself (`today`, `yesterday`, `now-7d`, `now-30d`, `YYYY-MM-DD..YYYY-MM-DD`),
 *   never through `resolveRange`, which speaks Elasticsearch date math.
 * * The words for each counted kind, each kind of person and each review figure.
 * * The people table's CSV, through the shared formula-defusing encoder (`lib/csv.ts`):
 *   display names are text people typed.
 *
 * Counts are shown with their context and nothing else: no rank, no score (SPEC D3.5).
 */
import { csvDocument, type CsvCell } from '@/lib/csv';
import { fmtNumber } from '@/lib/format';
import { fmtDuration } from '@/lib/format-values';
import type {
  PersonActivity,
  TeamActivity,
  TeamChartKind,
  TeamCloseGroup,
  TeamKind,
  TeamPersonKind,
  TeamReviews,
} from '@/lib/types-team';
import { roleLabel } from '@/soc/pages/Roles.api';

/** The longest custom range, in calendar days (the server refuses longer). */
export const TEAM_MAX_DAYS = 92;

export interface TeamPreset {
  id: 'today' | 'yesterday' | '7d' | '30d';
  label: string;
  /** The server's window token. */
  window: string;
}

/** The range presets, in menu order. Last 7 and 30 days are whole calendar days. */
export const TEAM_PRESETS: readonly TeamPreset[] = [
  { id: 'today', label: 'Today', window: 'today' },
  { id: 'yesterday', label: 'Yesterday', window: 'yesterday' },
  { id: '7d', label: 'Last 7 days', window: 'now-7d' },
  { id: '30d', label: 'Last 30 days', window: 'now-30d' },
];

/** What the range control holds: a preset, or a custom range of whole days. */
export type TeamRange =
  | { kind: 'preset'; preset: TeamPreset['id'] }
  | { kind: 'custom'; from: string; to: string };

export const DEFAULT_TEAM_RANGE: TeamRange = { kind: 'preset', preset: 'today' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` as UTC midnight milliseconds, or NaN. */
function dayMs(value: string): number {
  if (!DATE_RE.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? Number.NaN : ms;
}

/** The days a custom range covers, both ends included, or NaN. */
export function customRangeDays(from: string, to: string): number {
  const a = dayMs(from);
  const b = dayMs(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Why a custom range cannot be read, or null when it can. */
export function customRangeError(from: string, to: string): string | null {
  if (!from || !to) return null;
  const days = customRangeDays(from, to);
  if (Number.isNaN(days)) return 'Enter a start and an end date.';
  if (days < 1) return 'The end must be on or after the start.';
  if (days > TEAM_MAX_DAYS) return `Choose at most ${TEAM_MAX_DAYS} days.`;
  return null;
}

/** The server window token for a range. */
export function rangeWindow(range: TeamRange): string {
  if (range.kind === 'custom') return `${range.from}..${range.to}`;
  return TEAM_PRESETS.find((p) => p.id === range.preset)?.window ?? 'today';
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "20 Nov" (or "20 Nov 2025" outside the current year) for an ISO date. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const ms = dayMs(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms);
  return date.getUTCFullYear() === now.getUTCFullYear() ? DAY_FORMAT.format(date) : DAY_YEAR_FORMAT.format(date);
}

/** The words the range control shows. */
export function rangeLabel(range: TeamRange, now: Date = new Date()): string {
  if (range.kind === 'preset') return TEAM_PRESETS.find((p) => p.id === range.preset)?.label ?? 'Today';
  if (range.from === range.to) return dayLabel(range.from, now);
  return `${dayLabel(range.from, now)} to ${dayLabel(range.to, now)}`;
}

/** The range as a module caption ("today", "last 7 days", "1 Nov to 10 Nov"). */
export function rangeCaption(range: TeamRange, now: Date = new Date()): string {
  const label = rangeLabel(range, now);
  return range.kind === 'preset' ? label.toLowerCase() : label;
}

/** The counted kinds in table and sheet order, with their words. */
export const KIND_WORDS: Readonly<Record<TeamKind, string>> = {
  acknowledged: 'Acknowledged',
  closed: 'Closed',
  reopened: 'Reopened',
  escalated: 'Escalated',
  commented: 'Commented',
  assigned: 'Assigned',
  screenshot_added: 'Screenshots added',
  reviewed: 'Reviews',
  runbook_step_done: 'Runbook steps done',
  signed_in: 'Sign-ins',
};

export const KIND_ORDER: readonly TeamKind[] = [
  'acknowledged',
  'closed',
  'reopened',
  'escalated',
  'commented',
  'assigned',
  'screenshot_added',
  'reviewed',
  'runbook_step_done',
  'signed_in',
];

/** The chart's seven stacked kinds, bottom to top, with their legend words. */
export const CHART_ORDER: readonly TeamChartKind[] = [
  'closed',
  'acknowledged',
  'commented',
  'reviewed',
  'escalated',
  'reopened',
  'other',
];

export const CHART_WORDS: Readonly<Record<TeamChartKind, string>> = {
  closed: 'Closed',
  acknowledged: 'Acknowledged',
  commented: 'Commented',
  reviewed: 'Reviewed',
  escalated: 'Escalated',
  reopened: 'Reopened',
  other: 'Other case work',
};

export const CLOSE_WORDS: Readonly<Record<TeamCloseGroup, string>> = {
  true_positive: 'True positive',
  false_positive: 'False positive',
  benign: 'Benign',
  duplicate: 'Duplicate',
  other: 'Other',
};

export const CLOSE_ORDER: readonly TeamCloseGroup[] = ['true_positive', 'false_positive', 'benign', 'duplicate', 'other'];

/** How each kind of person reads. An ordinary account has no extra words. */
export const PERSON_KIND_WORDS: Readonly<Record<TeamPersonKind, string>> = {
  account: '',
  environment: 'Environment account',
  demo: 'Demo analyst',
  deleted: 'Deleted account',
  unattributed: 'Not attributed',
};

/** Why rows are not attributed (SPEC D3.9). */
export const UNATTRIBUTED_HELP = 'Recorded before sign-in attribution, or with sign-in off.';

/** The name a person reads by: the display name, else the username. */
export function personName(person: Pick<PersonActivity, 'display_name' | 'username' | 'kind'>): string {
  if (person.kind === 'unattributed') return 'Not attributed';
  return person.display_name.trim() || person.username;
}

/** The role in words, or empty for a person with no known role. */
export function personRole(person: Pick<PersonActivity, 'role'>): string {
  return person.role ? roleLabel(person.role) : '';
}

/** "45s", "3m 20s", "2h 5m": a duration in seconds, or null when not measured. */
export function fmtSeconds(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 600) {
    const whole = Math.round(seconds);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  return fmtDuration(seconds / 60);
}

/** "3 of 4 agreed" always; the rate only from 30 answered reviews (SPEC D3.8). */
export function reviewsText(reviews: TeamReviews): string {
  if (reviews.completed === 0) return 'None';
  const parts = [`${fmtNumber(reviews.agreed)} of ${fmtNumber(reviews.answered)} agreed`];
  if (reviews.agreement_rate !== null && reviews.agreement_rate !== undefined) {
    parts.push(`${Math.round(reviews.agreement_rate * 100)}%`);
  }
  if (reviews.unsure) parts.push(`${fmtNumber(reviews.unsure)} unsure`);
  return parts.join(', ');
}

/** A case work total for a person (every kind but sign-ins). */
export function workTotal(person: Pick<PersonActivity, 'counts'>): number {
  return KIND_ORDER.filter((k) => k !== 'signed_in').reduce((sum, k) => sum + (person.counts[k] ?? 0), 0);
}

/** Whether the window holds any counted work at all. */
export function windowHasWork(data: Pick<TeamActivity, 'team'>): boolean {
  return KIND_ORDER.some((k) => k !== 'signed_in' && (data.team.counts[k] ?? 0) > 0);
}

/** The people table as CSV rows (header first), every text cell formula-defused. */
export function peopleCsvRows(data: TeamActivity): CsvCell[][] {
  const header: CsvCell[] = [
    'Person',
    'Username',
    'Kind',
    'Role',
    ...KIND_ORDER.map((k) => KIND_WORDS[k]),
    ...CLOSE_ORDER.map((g) => `Closed as ${CLOSE_WORDS[g].toLowerCase()}`),
    'Closed in bulk actions',
    'Reviews agreed',
    'Reviews answered',
    'Median time to acknowledge (minutes)',
    'Last active (UTC)',
  ];
  const rows: CsvCell[][] = [header];
  for (const person of data.people) {
    rows.push([
      personName(person),
      person.username || null,
      PERSON_KIND_WORDS[person.kind] || 'Account',
      personRole(person) || null,
      ...KIND_ORDER.map((k) => person.counts[k] ?? 0),
      ...CLOSE_ORDER.map((g) => person.closed_by[g] ?? 0),
      person.bulk.closed ?? 0,
      person.reviews.agreed,
      person.reviews.answered,
      person.median_ack_seconds === null ? null : Math.round((person.median_ack_seconds / 60) * 10) / 10,
      person.last_active,
    ]);
  }
  // A partial read: the file says so, as the page does, so a saved copy never reads as
  // exact. One trailing note row keeps the header first for a spreadsheet's import.
  if (!data.exact) rows.push([CSV_PARTIAL_NOTE]);
  return rows;
}

/** The note a CSV of a partial read ends with. */
export const CSV_PARTIAL_NOTE =
  'Partial read: the audit log was read in part, so every count is at least the figure shown and the median time to acknowledge is not measured.';

/** The people table as one CSV document. */
export function peopleCsv(data: TeamActivity): string {
  return csvDocument(peopleCsvRows(data));
}
