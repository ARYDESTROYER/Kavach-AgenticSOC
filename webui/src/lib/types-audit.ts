/**
 * Round 14 audit log contracts (SPEC §4.5). Type-only: zero runtime bytes.
 *
 * Mirrors `backend/app/models.py` (`AuditClient`, `AuditTarget`, `AuditChange`,
 * `AuditRecord`, `AuditPage`, `AuditCount`). New code imports these names from this
 * module; the legacy `AuditRecord`, `AuditResponse` and `AuditQuery` in `types.ts`
 * stay for the old `api.audit.list` until WP-B1 retires them, so nothing collides.
 *
 * Every value is system-, operator- or log-derived and renders as plain text (#9);
 * `prompt_excerpt` and `tool_output_summary` carry fenced untrusted log data and
 * render only inside a code block labelled "Contains untrusted log data".
 */

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'partial' | 'unknown';

export type AuditActorType = 'human' | 'agent' | 'system' | 'service';

export type AuditTargetType =
  | 'case'
  | 'user'
  | 'role'
  | 'source'
  | 'setting'
  | 'job'
  | 'rule'
  | 'runbook'
  | 'dashboard'
  | 'export';

/** The page's scope control (D4: People and settings is the default). */
export type AuditScope = 'people' | 'agent' | 'all';

/** Category ids of `backend/app/audit/event_categories.json`. */
export type AuditCategory = 'access' | 'config' | 'case_work' | 'agent' | 'system';

export type AuditCountRelation = 'eq' | 'gte';

/**
 * Where a request-driven row came from (personal data, D9). `ip` comes from a
 * forwarded header only when the socket peer is a named trusted proxy
 * (`ip_source: 'trusted_proxy'`, the rightmost entry); otherwise it is the socket
 * peer. `ip` is always a parsed address or `null` (a Unix-socket or test peer is not
 * an address; its raw text stays in `peer`). `forwarded_for` is the raw header: shown
 * behind "Show forwarded header", labelled "Supplied by the client; not verified",
 * never used to filter.
 */
export interface AuditClient {
  ip: string | null;
  ip_source: 'peer' | 'trusted_proxy';
  peer: string;
  forwarded_for: string | null;
  user_agent: string;
}

/**
 * What a row acted on. `label` is the human name at the time. `revision` is the store
 * revision the write creates (absent for targets without one); the inspector shows it,
 * so a row whose write never landed can be told apart (the documented crash limit).
 */
export interface AuditTarget {
  type: AuditTargetType;
  id: string;
  label: string;
  revision?: number | null;
}

/**
 * One changed field. A secret shows "Changed (secret values are never recorded)";
 * a URL was reduced to scheme and host (`secret: true` when anything was removed).
 */
export interface AuditChange {
  field: string;
  before: string | null;
  after: string | null;
  secret: boolean;
}

/**
 * One audit row from the read API. The Round 14 fields are omitted on rows that did
 * not record them (show nothing, never an empty value); `outcome` and `actor_type`
 * may be derived for a legacy row, which `*_derived` says. An unknown `action_type`
 * keeps its token and is categorised as System.
 */
export interface AuditRecord {
  /**
   * E12, opaque: `es:<index>:<_id as unpadded base64url>`, `sql:<row id>` (negative for
   * keyed rows), `mem:<n>`, `demo:` first for Demo rows. Grammar (at most 947
   * characters): `^(demo:)?(es:[a-z0-9._+-]{1,255}:[A-Za-z0-9_-]{2,683}|sql:-?[1-9][0-9]{0,18}|mem:[0-9]{1,12})$`.
   * Never parse it; pass it back to `GET /api/audit/records/{record_id}` as is.
   */
  record_id: string;
  event_id: string | null;
  app_version: string | null;
  build_sha: string | null;
  ts: string;
  case_id: string | null;
  source_id: string | null;
  surface: string;
  actor: string;
  action_type: string;
  model: string | null;
  prompt_excerpt: string | null;
  query_text: string | null;
  tool_name: string | null;
  tool_input: unknown;
  tool_output_summary: string | null;
  result_summary: string | null;
  outcome?: AuditOutcome;
  actor_type?: AuditActorType;
  /** The structured event name, `<resource>.<verb>` (`auth.login`, `runbook.published`). */
  action?: string;
  actor_role?: string;
  client?: AuditClient;
  session_ref?: string;
  target?: AuditTarget;
  changes?: AuditChange[];
  request_id?: string;
  run_id?: string;
  outcome_derived: boolean;
  actor_type_derived: boolean;
  category: AuditCategory;
  /** Friendly event name from the shared fixture (Console-authored copy). */
  event_label: string;
  /** A Demo store row (labelled "Demo"). */
  demo: boolean;
  /** Text fields that hit the 1,000-character write cap ("Stored truncated at 1,000 characters"). */
  truncated_fields: string[];
}

/** How long the deployment keeps the audit log, for the scope line. */
export interface AuditRetention {
  hot_days: number | null;
  warm_days: number | null;
  /** In-memory store: "This deployment keeps the audit log in memory; it is lost on restart." */
  volatile: boolean;
}

/**
 * `GET /api/audit`. `records` and `total` keep the old list keys. `total` is exact
 * when `total_relation` is `eq` and "at least" when it is `gte`. `run_totals` gives
 * each `run_id` on the page its event count under the same filters ("6 of 10 steps").
 */
export interface AuditPage {
  records: AuditRecord[];
  total: number;
  next_cursor: string | null;
  total_relation: AuditCountRelation;
  run_totals: Record<string, number>;
  retention: AuditRetention;
}

/** `GET /api/audit/count`: exact up to the requested cap, then `gte`. */
export interface AuditCount {
  count: number;
  relation: AuditCountRelation;
}

/**
 * The structured filters of the read API. `action` (legacy `action_type`) and `actor`
 * (exact) keep their old meaning; `event` is the dotted structured action or a
 * category id; `actor_contains` is the page's typed actor filter. Free-text `q`
 * qualifiers (`actor:`, `event:`, `outcome:`, `case:`, `target:`, `ip:`) are compiled
 * by the client into these fields, never sent as a query language.
 */
export interface AuditFilters {
  action?: string;
  event?: string;
  actor?: string;
  actor_contains?: string;
  actor_kind?: AuditActorType;
  outcome?: AuditOutcome;
  surface?: string;
  case_id?: string;
  source_id?: string;
  target?: string;
  ip?: string;
}

/**
 * Query of `GET /api/audit` (Round 14 shape). Absent `scope` keeps the legacy
 * behaviour (all rows, default 100); the page always sends it (default 50). `limit`
 * is clamped to 1 to 200 by the server, never rejected. `from` and `to` take the
 * page's window or absolute ISO 8601 instants.
 */
export interface AuditPageQuery extends AuditFilters {
  scope?: AuditScope;
  q?: string;
  from?: string;
  to?: string;
  order?: 'desc' | 'asc';
  limit?: number;
  cursor?: string;
}

/** Query of `GET /api/audit/count` (the same filters plus a cap of at most 100,001). */
export interface AuditCountQuery extends Omit<AuditPageQuery, 'cursor' | 'limit' | 'order'> {
  cap?: number;
}

/** Export file formats (D7): one plain file, never a ZIP. */
export type AuditExportFormat = 'csv' | 'jsonl';

/**
 * Params of the `audit_export` job (`POST /api/jobs`, gate `audit:export`, fresh
 * sign-in). `from` and `to` are the absolute UTC instants the export dialog showed;
 * the job re-checks the count and refuses more than 100,000 rows.
 */
export interface AuditExportJobParams {
  format: AuditExportFormat;
  filters: AuditFilters;
  q?: string;
  order: 'asc' | 'desc';
  scope: AuditScope;
  from: string;
  to: string;
}

/** Error codes of the audit read and export API, for the page states. */
export type AuditErrorCode =
  | 'audit_record_not_found'
  | 'audit_cursor_expired'
  | 'audit_unavailable'
  | 'audit_export_too_large';
