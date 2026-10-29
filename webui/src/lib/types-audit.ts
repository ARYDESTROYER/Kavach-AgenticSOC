/**
 * Round 14 audit log contracts (SPEC §4.5). Type-only: zero runtime bytes.
 *
 * Mirrors `backend/app/models.py` (`AuditClient`, `AuditTarget`, `AuditChange`,
 * `AuditRecord`, `AuditPage`, `AuditCount`) and the audit export job params of
 * `backend/app/api/routes_jobs.py`. The generated `api-types.gen.ts` is the authority
 * for every model the OpenAPI schema describes, and a contract test pins these mirrors
 * to it. `types.ts` re-exports every name here (the pre-Round 14 `AuditRecord`,
 * `AuditResponse` and `AuditQuery` and the old `api.audit.list` are gone; the reads
 * live in `api-audit.ts`).
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
 * The filters every audit read shares (`GET /api/audit`, `/count` and
 * `/records/{record_id}`). Absent `scope` keeps the legacy behaviour (every row).
 * `from` and `to` take the page's window (`now-7d`, `now-1d/d`) or absolute ISO 8601
 * instants; a bad value answers `422 audit_invalid_time`, any other bad filter
 * `422 audit_invalid_filter`.
 */
export interface AuditFilterQuery extends AuditFilters {
  scope?: AuditScope;
  q?: string;
  from?: string;
  to?: string;
}

/**
 * Query of `GET /api/audit` (Round 14 shape). Without `scope` the server reads 100
 * rows a page; the page always sends it (default 50). `limit` is clamped to 1 to 200
 * by the server, never rejected.
 */
export interface AuditPageQuery extends AuditFilterQuery {
  order?: 'desc' | 'asc';
  limit?: number;
  cursor?: string;
}

/** Query of `GET /api/audit/count` (the same filters plus a cap of at most 100,001). */
export interface AuditCountQuery extends AuditFilterQuery {
  cap?: number;
}

/**
 * Query of `GET /api/audit/records/{record_id}`. The filters never narrow the answer:
 * the page sends its current ones so opening a row it lists joins the list read's one
 * `audit_view` row (D8); an open without them is recorded by the record's id.
 */
export type AuditRecordQuery = AuditFilterQuery;

/** Export file formats (D7): one plain file, never a ZIP. */
export type AuditExportFormat = 'csv' | 'jsonl';

/**
 * Params of the `audit_export` job (`POST /api/jobs`, gate `audit:export`, fresh
 * sign-in; mirrors `AuditExportParams` in `backend/app/api/routes_jobs.py`, a strict
 * model: an unknown key answers `422`). `from` and `to` are the absolute ISO 8601
 * instants, with a zone, that the export dialog showed and counted; the job re-checks
 * the count and refuses more than 100,000 rows. Exports are always oldest first, so
 * `order` accepts only `asc` (the default); never forward the list's own order.
 */
export interface AuditExportJobParams {
  format: AuditExportFormat;
  filters: AuditFilters;
  /** At most the search box's length; blank is absent. */
  q?: string;
  order?: 'asc';
  scope: AuditScope;
  from: string;
  to: string;
}

/** Error codes the audit read and export API answers (`{"detail": {"code", "message"}}`). */
export type AuditErrorCode =
  /** 404: not in the current store (also an id that does not parse, or a Demo row with Demo Mode off). */
  | 'audit_record_not_found'
  /** 409: "Load more" on a read that was closed; reload from the top. */
  | 'audit_cursor_expired'
  /** 400: a cursor this server did not issue. */
  | 'audit_cursor_invalid'
  /** 422: a filter value the API refuses (also `order: 'desc'` on an export). */
  | 'audit_invalid_filter'
  /** 422: `from` or `to` is not a time the API understands. */
  | 'audit_invalid_time'
  /** 503: the audit log could not be read, counted or written. */
  | 'audit_unavailable'
  /** 422: more than 100,000 events match; nothing was exported. */
  | 'audit_export_too_large'
  /** 422: the store cannot count the matching events exactly; nothing was exported. */
  | 'audit_export_unverifiable'
  /** 409: exports are not available in Demo Mode. */
  | 'audit_export_demo_mode'
  /** 429: this person already has an audit export queued or running. */
  | 'job_busy';

/**
 * Codes a failed `audit_export` job reports as the start of its failure reason
 * (`"<code>: <message>"`); the message after the colon is plain copy to show.
 */
export type AuditExportFailureCode =
  | 'audit_export_failed'
  | 'audit_export_too_large'
  | 'audit_export_unverifiable'
  | 'audit_export_incomplete'
  | 'audit_export_expired'
  | 'audit_export_no_space'
  | 'audit_export_denied'
  | 'audit_unavailable';
