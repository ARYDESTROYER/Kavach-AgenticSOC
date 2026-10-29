/**
 * The Audit log's pure model (Round 14 SPEC §4.5): the view state the URL carries, the
 * read API query built from it, the search qualifiers, times, the investigation groups
 * of the Agent activity scope, the export range and file name, and the plain words the
 * page shows for outcomes, actors, fields and user agents.
 *
 * No React and no DOM here, so every rule is unit tested on its own. Every value it
 * returns is plain text (#9): callers render it as text nodes, never as markup.
 */
import type { NavOpts } from '@/lib/types';
import type {
  AuditActorType,
  AuditFilters,
  AuditOutcome,
  AuditPageQuery,
  AuditRecord,
  AuditScope,
} from '@/lib/types-audit';
import { caseLabel } from '@/lib/format';
import { parseDateMath } from '@/soc/components/TimeRangePicker';

/* ----------------------------------------------------------------- constants -- */

/** D4: the page opens on People and settings. */
export const DEFAULT_SCOPE: AuditScope = 'people';
/** The page opens on the last 7 days. */
export const DEFAULT_FROM = 'now-7d';
/** Rows per page ("Load more" fetches the next 50). */
export const PAGE_SIZE = 50;
/** D7: one export file holds at most 100,000 events. */
export const EXPORT_ROW_CAP = 100_000;
/** Exports this small are waited for on the page and downloaded automatically. */
export const SMALL_EXPORT_ROWS = 5_000;
/** The per-viewer time zone toggle (D10), remembered in this browser only. */
export const TIMEZONE_STORAGE_KEY = 'soc.audit.timezone';

export const SCOPES: readonly AuditScope[] = ['people', 'agent', 'all'];

export const SCOPE_LABEL: Readonly<Record<AuditScope, string>> = {
  people: 'People and settings',
  agent: 'Agent activity',
  all: 'All',
};

/** The time ranges the header offers (SPEC §4.5.1); 7 days is the default. */
export const AUDIT_RANGES: ReadonlyArray<{ from: string; to: string; label: string }> = [
  { from: 'now-1h', to: 'now', label: 'Last 1 hour' },
  { from: 'now-24h', to: 'now', label: 'Last 24 hours' },
  { from: 'now-7d', to: 'now', label: 'Last 7 days' },
  { from: 'now-30d', to: 'now', label: 'Last 30 days' },
  { from: 'now-90d', to: 'now', label: 'Last 90 days' },
];

export type AuditTimeZone = 'utc' | 'local';

/* ------------------------------------------------------------------ the view -- */

/** The filters the URL carries (`#/audit?...`, SPEC §4.5.1). Null means "not set". */
export interface AuditView {
  scope: AuditScope;
  /** A relative `now-7d` or an absolute ISO 8601 instant. */
  from: string;
  /** Null is "now". */
  to: string | null;
  q: string | null;
  /** A dotted action, a category id or an event family. */
  event: string | null;
  /** Exact actor (per-user links). */
  actor: string | null;
  /** Typed actor filter (contains, case-insensitive). */
  actorContains: string | null;
  outcome: AuditOutcome | null;
  caseId: string | null;
  target: string | null;
  ip: string | null;
}

/** Filters the router has no key for: kept in memory for as long as the page is open. */
export interface AuditLocalFilters {
  actorKind: AuditActorType | null;
  surface: string | null;
  sourceId: string | null;
}

export const EMPTY_LOCAL_FILTERS: AuditLocalFilters = { actorKind: null, surface: null, sourceId: null };

const OUTCOMES: readonly AuditOutcome[] = ['success', 'failure', 'denied', 'partial', 'unknown'];
const ACTOR_KINDS: readonly AuditActorType[] = ['human', 'agent', 'system', 'service'];

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** The view a route's opts name (the router has already validated every key). */
export function viewFromOpts(opts: NavOpts | undefined): AuditView {
  const o = (opts ?? {}) as Record<string, unknown>;
  const scope = str(o.scope);
  const outcome = str(o.outcome);
  return {
    scope: scope && (SCOPES as readonly string[]).includes(scope) ? (scope as AuditScope) : DEFAULT_SCOPE,
    from: str(o.from) ?? DEFAULT_FROM,
    to: str(o.to) && o.to !== 'now' ? (o.to as string) : null,
    q: str(o.q),
    event: str(o.event),
    actor: str(o.actor),
    actorContains: str(o.actor_contains),
    outcome: outcome && (OUTCOMES as readonly string[]).includes(outcome) ? (outcome as AuditOutcome) : null,
    caseId: str(o.case),
    target: str(o.target),
    ip: str(o.ip),
  };
}

/**
 * The route opts for a view (and an open record). Scope and time are always written,
 * so a copied link shows the same rows; every other empty key is left out (never
 * written as `k=`).
 */
export function optsFromView(view: AuditView, record?: string | null): NavOpts {
  const out: Record<string, string> = { scope: view.scope, from: view.from };
  if (view.to) out.to = view.to;
  if (view.q) out.q = view.q;
  if (view.event) out.event = view.event;
  if (view.actor) out.actor = view.actor;
  if (view.actorContains) out.actor_contains = view.actorContains;
  if (view.outcome) out.outcome = view.outcome;
  if (view.caseId) out.case = view.caseId;
  if (view.target) out.target = view.target;
  if (view.ip) out.ip = view.ip;
  if (record) out.record = record;
  return out as NavOpts;
}

/** The structured filters (the read API's names) of a view plus the in-memory ones. */
export function apiFilters(view: AuditView, local: AuditLocalFilters): AuditFilters {
  const out: AuditFilters = {};
  if (view.event) out.event = view.event;
  if (view.actor) out.actor = view.actor;
  if (view.actorContains) out.actor_contains = view.actorContains;
  if (local.actorKind) out.actor_kind = local.actorKind;
  if (view.outcome) out.outcome = view.outcome;
  if (local.surface) out.surface = local.surface;
  if (view.caseId) out.case_id = view.caseId;
  if (local.sourceId) out.source_id = local.sourceId;
  if (view.target) out.target = view.target;
  if (view.ip) out.ip = view.ip;
  return out;
}

/** `GET /api/audit` for a view: always with `scope` (the page's 50-row shape). */
export function pageQuery(
  view: AuditView,
  local: AuditLocalFilters,
  order: 'desc' | 'asc',
  cursor?: string | null,
): AuditPageQuery {
  const query: AuditPageQuery = {
    ...apiFilters(view, local),
    scope: view.scope,
    from: view.from,
    order,
    limit: PAGE_SIZE,
  };
  if (view.to) query.to = view.to;
  if (view.q) query.q = view.q;
  if (cursor) query.cursor = cursor;
  return query;
}

/** A stable key for "the same read": a change reloads from the top. */
export function readKey(view: AuditView, local: AuditLocalFilters, order: 'desc' | 'asc'): string {
  return JSON.stringify([view, local, order]);
}

/** How many filters a person added (the chips, and "Filters (n)" on a phone). */
export function activeFilterCount(view: AuditView, local: AuditLocalFilters): number {
  return [
    view.q,
    view.event,
    view.actor,
    view.actorContains,
    view.outcome,
    view.caseId,
    view.target,
    view.ip,
    local.actorKind,
    local.surface,
    local.sourceId,
  ].filter(Boolean).length;
}

/** The view with every filter a person added removed (scope and time stay). */
export function clearedView(view: AuditView): AuditView {
  return {
    ...view,
    q: null,
    event: null,
    actor: null,
    actorContains: null,
    outcome: null,
    caseId: null,
    target: null,
    ip: null,
  };
}

/* ---------------------------------------------------------------- search box -- */

const NAV_ID = /^[\w.:-]{1,128}$/;
const EVENT_VALUE = /^[a-z_]{1,32}(\.[a-z_]{1,32})?$/;

/**
 * One IPv4 dotted quad (each octet 0 to 255) or one IPv6 address the URL parser accepts:
 * the router's `ip` key and the read API's `normalise_audit_ip` refuse anything else, so
 * a value that fails here is never applied as a filter (it would vanish from the URL and
 * the server would answer 422). A copy of the router's check: importing the router helper
 * would add bytes to the entry chunk (SPEC §3.4).
 */
export function isIpAddress(value: string): boolean {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(value)) return false;
  if (!value.includes(':')) return /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.|$)){4}$/.test(value) && !value.endsWith('.');
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}
/** Printable text only, as the router's `q` key (no control, separator or format characters). */
const PRINTABLE = /^[^\p{C}\u2028\u2029]+$/u;

/** `outcome:` words a person may type, and the filter each one means. */
const OUTCOME_WORDS: Readonly<Record<string, AuditOutcome>> = {
  success: 'success',
  succeeded: 'success',
  ok: 'success',
  failed: 'failure',
  failure: 'failure',
  fail: 'failure',
  denied: 'denied',
  partial: 'partial',
  unknown: 'unknown',
  'not recorded': 'unknown',
  not_recorded: 'unknown',
};

export interface ParsedSearch {
  /** The free text left for `q` (null when nothing is left). */
  q: string | null;
  /** The structured filters the qualifiers name. */
  patch: Partial<Pick<AuditView, 'event' | 'actorContains' | 'outcome' | 'caseId' | 'target' | 'ip'>>;
}

/** Split on spaces, keeping `"quoted words"` (and `key:"quoted value"`) together. */
function tokens(text: string): string[] {
  const out: string[] = [];
  const re = /(\S*?"[^"]*"\S*|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) out.push(match[1]);
  return out;
}

const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1');

/**
 * Compile the search box (SPEC §4.5.5): the qualifiers `actor:`, `event:`, `outcome:`,
 * `case:`, `target:` and `ip:` become structured filters and are never sent as a query
 * language; everything else is the free-text `q` (at most 200 characters). A qualifier
 * whose value is not valid for its filter stays in the free text, as typed.
 */
export function parseSearch(input: string): ParsedSearch {
  const patch: ParsedSearch['patch'] = {};
  const rest: string[] = [];
  for (const token of tokens(input.trim())) {
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 ? unquote(token.slice(colon + 1)).trim() : '';
    let used = false;
    if (value && PRINTABLE.test(value)) {
      if (key === 'actor' && value.length <= 128) {
        patch.actorContains = value;
        used = true;
      } else if (key === 'event' && EVENT_VALUE.test(value.toLowerCase())) {
        patch.event = value.toLowerCase();
        used = true;
      } else if (key === 'outcome' && OUTCOME_WORDS[value.toLowerCase()]) {
        patch.outcome = OUTCOME_WORDS[value.toLowerCase()];
        used = true;
      } else if (key === 'case' && NAV_ID.test(value)) {
        patch.caseId = value;
        used = true;
      } else if (key === 'target' && NAV_ID.test(value)) {
        patch.target = value;
        used = true;
      } else if (key === 'ip' && isIpAddress(value)) {
        patch.ip = value;
        used = true;
      }
    }
    if (!used) rest.push(token);
  }
  const free = rest.join(' ').trim().slice(0, 200);
  return { q: free && PRINTABLE.test(free) ? free : null, patch };
}

/* --------------------------------------------------------------------- times -- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsOf(ms: number, zone: AuditTimeZone): Parts {
  const d = new Date(ms);
  return zone === 'utc'
    ? {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth(),
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
      }
    : {
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
      };
}

/** Epoch milliseconds of an ISO timestamp, or null. */
export function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A row's time ("25 Oct 15:09:15"), with the year when it is not the current one.
 * The column header says whether it is UTC or local time.
 */
export function formatRowTime(iso: string, zone: AuditTimeZone, nowMs: number = Date.now()): string {
  const ms = timeOf(iso);
  if (ms === null) return iso;
  const p = partsOf(ms, zone);
  const year = p.year !== partsOf(nowMs, zone).year ? ` ${p.year}` : '';
  return `${p.day} ${MONTHS[p.month]}${year} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** "18 Oct 15:10" (minutes), for ranges. */
export function formatMinute(ms: number, zone: AuditTimeZone): string {
  const p = partsOf(ms, zone);
  return `${p.day} ${MONTHS[p.month]} ${p.year !== partsOf(Date.now(), zone).year ? `${p.year} ` : ''}${pad(p.hour)}:${pad(p.minute)}`;
}

/** "15:09" in local time, for the inspector's second clock. */
export function formatLocalClock(ms: number): string {
  const p = partsOf(ms, 'local');
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** An instant to the second, ISO 8601 UTC (`2026-10-25T15:10:00Z`). */
export function isoSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** `2026-10-25T151000Z`, the export file name's stamp (the server's `_stamp`). */
export function fileStamp(ms: number): string {
  return isoSecond(ms).replace(/:/g, '');
}

export interface AbsoluteRange {
  fromMs: number;
  toMs: number;
  from: string;
  to: string;
}

/**
 * The view's range as absolute instants (SPEC §4.5.6): the export dialog resolves
 * `now-7d` once when it opens, and the count, the shown range, the file name and the job
 * all use these instants. Null when a bound cannot be read or the range is empty.
 */
export function absoluteRange(view: Pick<AuditView, 'from' | 'to'>, nowMs: number): AbsoluteRange | null {
  const toMs = view.to ? parseDateMath(view.to, nowMs) : nowMs;
  if (toMs === null) return null;
  const fromMs = parseDateMath(view.from, nowMs);
  if (fromMs === null) return null;
  const from = Math.floor(fromMs / 1000) * 1000;
  const to = Math.floor(toMs / 1000) * 1000;
  if (from >= to) return null;
  return { fromMs: from, toMs: to, from: isoSecond(from), to: isoSecond(to) };
}

/** The plain words for a view's range: "last 7 days", or "18 Oct 15:10 to 25 Oct 15:10 UTC". */
export function rangePhrase(view: Pick<AuditView, 'from' | 'to'>, nowMs: number = Date.now()): string {
  if (!view.to) {
    const preset = AUDIT_RANGES.find((r) => r.from === view.from);
    if (preset) return preset.label.toLowerCase();
  }
  const range = absoluteRange(view, nowMs);
  if (!range) return 'the chosen range';
  return `${formatMinute(range.fromMs, 'utc')} to ${formatMinute(range.toMs, 'utc')} UTC`;
}

/** The trigger label of the header's time range control. */
export function rangeLabel(view: Pick<AuditView, 'from' | 'to'>, nowMs: number = Date.now()): string {
  if (!view.to) {
    const preset = AUDIT_RANGES.find((r) => r.from === view.from);
    if (preset) return preset.label;
  }
  const phrase = rangePhrase(view, nowMs);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/* -------------------------------------------------------------------- export -- */

export type AuditExportFileFormat = 'csv' | 'jsonl';

/**
 * `agentic-soc-audit_2026-10-18T151000Z_2026-10-25T151000Z.csv` (the server's
 * `export_file_name`): CSV is `.csv`, JSON Lines is `.ndjson`.
 */
export function exportFileName(format: AuditExportFileFormat, range: Pick<AbsoluteRange, 'fromMs' | 'toMs'>): string {
  return `agentic-soc-audit_${fileStamp(range.fromMs)}_${fileStamp(range.toMs)}${format === 'csv' ? '.csv' : '.ndjson'}`;
}

/* ------------------------------------------------------------- record words -- */

export type OutcomeKey = 'success' | 'failure' | 'denied' | 'partial' | 'not_recorded';

/** A recorded `unknown` and no outcome at all both read "Not recorded" (SPEC §4.5.3). */
export function outcomeKey(record: Pick<AuditRecord, 'outcome'>): OutcomeKey {
  const o = record.outcome;
  if (o === 'success' || o === 'failure' || o === 'denied' || o === 'partial') return o;
  return 'not_recorded';
}

export const OUTCOME_LABEL: Readonly<Record<OutcomeKey, string>> = {
  success: 'Success',
  failure: 'Failed',
  denied: 'Denied',
  partial: 'Partial',
  not_recorded: 'Not recorded',
};

/** The filter words of an outcome value (a chip, the Outcome menu). */
export const OUTCOME_FILTER_LABEL: Readonly<Record<AuditOutcome, string>> = {
  success: 'Success',
  failure: 'Failed',
  denied: 'Denied',
  partial: 'Partial',
  unknown: 'Not recorded',
};

export type ActorKindKey = AuditActorType | 'unknown';

export function actorKindKey(record: Pick<AuditRecord, 'actor_type'>): ActorKindKey {
  const t = record.actor_type;
  return t && (ACTOR_KINDS as readonly string[]).includes(t) ? t : 'unknown';
}

export const ACTOR_KIND_LABEL: Readonly<Record<ActorKindKey, string>> = {
  human: 'Person',
  agent: 'AI agent',
  system: 'System',
  service: 'Service',
  unknown: 'Not recorded',
};

/** The Actor menu's kind choices (in-memory filter `actor_kind`). */
export const ACTOR_KIND_FILTER_LABEL: Readonly<Record<AuditActorType, string>> = {
  human: 'People',
  agent: 'AI agent',
  system: 'System',
  service: 'Services',
};

/**
 * A row as the read API may send it with its case resolved: `case_label` is the case
 * number ("CASE-000214") of the row's `case_id`, null when the case no longer exists.
 * It is additive: a read that does not send it leaves the field absent.
 */
export type CaseLabelledRecord = AuditRecord & { case_label?: string | null };

/**
 * A row's case as the rest of the Console names it (SPEC §4.5.1, §4.9.5): its case
 * number (`case_label`), else the name of a case target that is the same case, else
 * the internal case id, so a row never loses its case. Null when the row names none.
 */
export function recordCaseText(record: CaseLabelledRecord): string | null {
  const id = record.case_id;
  if (!id) return null;
  const target = record.target?.type === 'case' && record.target.id === id ? record.target.label : null;
  return caseLabel({ case_number: record.case_label || target, case_id: id });
}

/**
 * The case numbers the loaded rows carry, by internal case id: the "Case:" chip names a
 * case the way its rows do. A case none of the rows resolves is left out (the chip then
 * shows the id it was given).
 */
export function caseLabelsOf(records: readonly CaseLabelledRecord[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const r of records) {
    if (!r.case_id || out.has(r.case_id)) continue;
    const text = recordCaseText(r);
    if (text && text !== r.case_id) out.set(r.case_id, text);
  }
  return out;
}

/**
 * What a row acted on, for the Target column: the recorded target's name, else the
 * case (by its number) or source the row names, else nothing.
 */
export function targetText(record: CaseLabelledRecord): string | null {
  if (record.target?.label) return record.target.label;
  if (record.target?.id) return record.target.id;
  if (record.case_id) return recordCaseText(record);
  if (record.source_id) return `Source ${record.source_id}`;
  return null;
}

/** The one-line summary the list shows: the first stored summary field that has text. */
export function summaryText(record: AuditRecord): string {
  for (const value of [record.result_summary, record.tool_output_summary, record.query_text, record.prompt_excerpt]) {
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * The sentence under the inspector title. A role change reads "trao changed the role of
 * vpatel from analyst_tier1 to analyst_tier2."; any other row reads its stored summary,
 * verbatim (AU-7: the audit tool never rewrites what it reports), or its event and
 * target when nothing was stored.
 */
export function recordSentence(record: AuditRecord): string {
  if (record.action === 'user.role_changed') {
    const change = record.changes?.find((c) => /(^|[.\]])role$/.test(c.field) && !c.secret);
    if (change && record.target?.label) {
      const before = change.before ?? 'no role';
      const after = change.after ?? 'no role';
      return `${record.actor} changed the role of ${record.target.label} from ${before} to ${after}.`;
    }
  }
  const summary = summaryText(record);
  if (summary) return summary;
  const target = targetText(record);
  return target ? `${record.event_label}: ${target}.` : `${record.event_label}.`;
}

/** "Max parallel" from `chat_agent.limits.max_parallel` or `sources[wazuh].poll_interval`. */
export function fieldLabel(path: string): string {
  const last = path.split('.').filter(Boolean).pop() ?? path;
  const bare = last.replace(/\[[^\]]*\]$/, '');
  const words = bare.replace(/[_-]+/g, ' ').trim();
  if (!words) return path;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * "Chrome 141 on macOS" from a user agent string; null when it reads as nothing known
 * (the raw string is always one click away).
 */
export function parseUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const tool = /^(curl|Wget|python-requests|PostmanRuntime|Go-http-client|okhttp|axios|node-fetch)\/([\d.]+)/i.exec(ua);
  if (tool) return `${tool[1]} ${tool[2]}`;
  let browser: string | null = null;
  const pick = (re: RegExp, name: string) => {
    if (browser) return;
    const m = re.exec(ua);
    if (m) browser = `${name} ${m[1].split('.')[0]}`;
  };
  pick(/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge');
  pick(/OPR\/([\d.]+)/, 'Opera');
  pick(/Firefox\/([\d.]+)/, 'Firefox');
  pick(/FxiOS\/([\d.]+)/, 'Firefox');
  pick(/CriOS\/([\d.]+)/, 'Chrome');
  pick(/Chrome\/([\d.]+)/, 'Chrome');
  pick(/Version\/([\d.]+).*Safari\//, 'Safari');
  let os: string | null = null;
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `A browser on ${os}` : null);
}

/* -------------------------------------------------- investigation groups -- */

export interface RowItem {
  kind: 'row';
  record: AuditRecord;
  /** A step shown inside an open investigation group. */
  child: boolean;
}

export interface GroupItem {
  kind: 'group';
  runId: string;
  records: AuditRecord[];
  /** The run's event count under the same filters (`run_totals`); at least the rows shown. */
  total: number;
  caseId: string | null;
  caseLabel: string | null;
  /** "closed as false positive", "sent to a person", or null when no decision row is shown. */
  ending: string | null;
}

export type ListItem = RowItem | GroupItem;

/** "FALSE_POSITIVE" reads "false positive". */
const verdictWords = (token: string) => token.toLowerCase().replace(/_/g, ' ');

/** The end of an investigation in words, from its decision or verdict row. */
export function investigationEnding(records: readonly AuditRecord[]): string | null {
  for (const r of records) {
    if (r.action_type !== 'decision' && r.action_type !== 'verdict') continue;
    const text = r.result_summary ?? '';
    const verdict = /verdict=([A-Z_]+)/.exec(text)?.[1];
    const status = /status=([a-z_]+)/.exec(text)?.[1];
    if (verdict === 'NEEDS_HUMAN' || status === 'open' || status === 'escalated') return 'sent to a person';
    if (verdict && status === 'closed') return `closed as ${verdictWords(verdict)}`;
    if (verdict && r.action_type === 'decision') return `verdict ${verdictWords(verdict)}`;
  }
  return null;
}

/**
 * The list's rows. In Agent activity one investigation's rows fold into one group row
 * placed where its newest row is (SPEC §4.5.1); rows without a `run_id` (older rows and
 * non-pipeline rows) are never grouped. Other scopes list every row.
 */
export function buildListItems(
  records: readonly CaseLabelledRecord[],
  scope: AuditScope,
  runTotals: Readonly<Record<string, number>>,
  openRuns: ReadonlySet<string>,
): ListItem[] {
  if (scope !== 'agent') return records.map((record) => ({ kind: 'row', record, child: false }));
  const groups = new Map<string, CaseLabelledRecord[]>();
  for (const r of records) {
    if (!r.run_id) continue;
    const list = groups.get(r.run_id);
    if (list) list.push(r);
    else groups.set(r.run_id, [r]);
  }
  const out: ListItem[] = [];
  const placed = new Set<string>();
  for (const r of records) {
    if (!r.run_id) {
      out.push({ kind: 'row', record: r, child: false });
      continue;
    }
    if (placed.has(r.run_id)) continue;
    placed.add(r.run_id);
    const members = groups.get(r.run_id) ?? [r];
    // The run's case, by its number when a step carries it, else as a case target names
    // it, else by the internal id.
    const labelled = members.find((m) => m.case_id && m.case_label);
    const withCase = labelled ?? members.find((m) => m.case_id);
    const caseTarget = members.find((m) => m.target?.type === 'case');
    out.push({
      kind: 'group',
      runId: r.run_id,
      records: members,
      total: Math.max(members.length, runTotals[r.run_id] ?? 0),
      caseId: withCase?.case_id ?? caseTarget?.target?.id ?? null,
      caseLabel: (labelled ? recordCaseText(labelled) : null) ?? caseTarget?.target?.label ?? withCase?.case_id ?? null,
      ending: investigationEnding(members),
    });
    if (openRuns.has(r.run_id)) {
      for (const m of members) out.push({ kind: 'row', record: m, child: true });
    }
  }
  return out;
}

/**
 * One outcome for an investigation's group row: Failed when any step failed, Denied when
 * any was denied, Success when every step shown succeeded, otherwise not recorded.
 */
export function groupOutcome(records: readonly AuditRecord[]): AuditOutcome | undefined {
  const keys = records.map((r) => outcomeKey(r));
  if (keys.includes('failure')) return 'failure';
  if (keys.includes('denied')) return 'denied';
  if (keys.includes('partial')) return 'partial';
  if (keys.length > 0 && keys.every((k) => k === 'success')) return 'success';
  return undefined;
}

/** The group row's text: "Investigation of CASE-000214 · 10 steps · closed as false positive". */
export function groupTitle(group: GroupItem): { title: string; detail: string } {
  const title = group.caseLabel ? `Investigation of ${group.caseLabel}` : 'Investigation';
  const shown = group.records.length;
  const steps =
    shown < group.total
      ? `${shown.toLocaleString()} of ${group.total.toLocaleString()} steps shown`
      : `${group.total.toLocaleString()} ${group.total === 1 ? 'step' : 'steps'}`;
  return { title, detail: group.ending ? `${steps} · ${group.ending}` : steps };
}

/* ----------------------------------------------------- failure pairing -- */

/** `runbook.published` and `runbook.publish_failed` share the resource `runbook`. */
const resourceOf = (action: string | undefined) => (action ? action.split('.')[0] : '');

/**
 * An ISO timestamp in microseconds since the epoch, or null. Stored times carry
 * microseconds (`2026-10-28T19:58:28.440552+00:00`) and `Date.parse` keeps only the
 * milliseconds, so the digits after the third are added back: two writes of one request
 * inside one millisecond still order correctly.
 */
export function instantOf(iso: string | null | undefined): number | null {
  const ms = timeOf(iso);
  if (ms === null || !iso) return null;
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(iso)?.[1] ?? '';
  const extra = Number(fraction.slice(3, 6).padEnd(3, '0'));
  return ms * 1000 + (Number.isFinite(extra) ? extra : 0);
}

/**
 * The failure row that says this action row was not applied (SPEC §3.6), or null. An
 * audit-first write appends its action row, then a `<resource>.<verb>_failed` row with
 * the same request id when the store write fails. Rows of one request can be action,
 * failure, action (a retried save), so an action row is "not applied" only when the
 * first row after it in time of the same request, actor, resource, target (and session,
 * when both rows name one) is that failure row. Times compare to the microsecond; two
 * rows stored at the same instant are ordered by where the list placed them (`order` is
 * the list's order, newest first by default). Both rows must be loaded; otherwise
 * nothing is claimed.
 */
export function notAppliedPair(
  record: AuditRecord,
  loaded: readonly AuditRecord[],
  order: 'desc' | 'asc' = 'desc',
): AuditRecord | null {
  if (!record.request_id || !record.action || record.action.endsWith('_failed')) return null;
  if (record.outcome && record.outcome !== 'success') return null;
  const at = instantOf(record.ts);
  if (at === null) return null;
  const resource = resourceOf(record.action);
  const position = new Map(loaded.map((r, i) => [r.record_id, i]));
  const own = position.get(record.record_id);
  // Later in time, when two rows share one instant: earlier in a newest-first list.
  const laterInList = (i: number) => (own === undefined ? false : order === 'desc' ? i < own : i > own);
  const after = loaded
    .map((r) => ({ r, t: instantOf(r.ts), i: position.get(r.record_id) ?? -1 }))
    .filter(
      ({ r, t, i }) =>
        r.record_id !== record.record_id &&
        t !== null &&
        (t > at || (t === at && laterInList(i))) &&
        r.request_id === record.request_id &&
        r.actor === record.actor &&
        resourceOf(r.action) === resource &&
        (r.target?.id ?? null) === (record.target?.id ?? null) &&
        (!r.session_ref || !record.session_ref || r.session_ref === record.session_ref),
    )
    .sort((a, b) => (a.t as number) - (b.t as number) || (order === 'desc' ? b.i - a.i : a.i - b.i));
  const next = after[0]?.r;
  return next?.action?.endsWith('_failed') ? next : null;
}

/** Was this action row not applied? (`notAppliedPair` names the failure row.) */
export function isNotApplied(
  record: AuditRecord,
  loaded: readonly AuditRecord[],
  order: 'desc' | 'asc' = 'desc',
): boolean {
  return notAppliedPair(record, loaded, order) !== null;
}

/* ------------------------------------------------------------ the stored row -- */

/**
 * The row as the store holds it, for Raw record (AU-7: an audit tool never alters what
 * it reports). The read API adds read-time projections to every row (the record id, the
 * category, the friendly name, the Demo flag, the truncated fields, the two `*_derived`
 * flags and the case number it resolves, `case_label`) and, for an older row, a derived
 * outcome or actor kind it never stored. Those are left out here; the inspector shows
 * them in Who and Record, labelled.
 */
export function storedRecord(record: CaseLabelledRecord): Record<string, unknown> {
  const {
    record_id: _recordId,
    category: _category,
    event_label: _eventLabel,
    demo: _demo,
    truncated_fields: _truncated,
    outcome_derived: outcomeDerived,
    actor_type_derived: actorTypeDerived,
    ...stored
  } = record;
  const shown: Record<string, unknown> = { ...stored };
  delete shown.case_label;
  if (outcomeDerived) delete shown.outcome;
  if (actorTypeDerived) delete shown.actor_type;
  return shown;
}
