/**
 * Typed fetch client for Agentic SOC.
 *
 * Every call hits the FastAPI backend at `/api/...`. In dev, Vite proxies `/api`
 * to the backend (see vite.config.ts); in production the SPA is served from the
 * same origin as the backend (or behind a reverse proxy that forwards `/api`).
 *
 * Centralised error handling: any non-2xx response is turned into an `ApiError`
 * carrying the HTTP status and the backend's `detail` message, so every screen
 * can show a meaningful error state.
 */
import type {
  AccountProfile,
  AccountProfileBody,
  ActivityResponse,
  AgentImprovementEvidence,
  AuditQuery,
  AuditResponse,
  AuthMe,
  AutoClosePolicy,
  BaselineConfig,
  BatchConfig,
  BackgroundJob,
  BackgroundJobsResponse,
  BackgroundJobSubmit,
  Branding,
  BulkResult,
  CampaignConfig,
  Case,
  CaseActionInput,
  CaseIdPreview,
  CaseRationale,
  CasesResponse,
  CaseStatus,
  ChatConversation,
  ChatConversationsResponse,
  ChatConversationSummary,
  ChatResponse,
  ChatTurn,
  ColumnState,
  ConnectionTest,
  ConnectorManifest,
  ConnectorsResponse,
  DashboardLayout,
  DemoConfig,
  DemoIncidentResult,
  DemoStatus,
  EffectivePrefs,
  FeedbackStats,
  HealthResponse,
  BuildInfoResponse,
  LoginResult,
  MfaSetupResult,
  SsoAuthorizeResult,
  SsoProvidersResponse,
  MemoryEntry,
  MemoryResponse,
  Metrics,
  MetricsTrends,
  ModelsResponse,
  NoiseLineage,
  NoiseReduction,
  AutoCloseHealth,
  AnalystRulePolicyConfig,
  DiagnosticsHealth,
  NotificationPreview,
  NotificationProviders,
  NotificationTemplate,
  NotificationTestResult,
  NotifyCaseResult,
  OrgCustomization,
  PersonasResponse,
  PlaybookDetail,
  PlaybookDryRunInput,
  PlaybookDryRunResponse,
  PlaybookCoverageResponse,
  PlaybookMutationResponse,
  PlaybooksResponse,
  Preferences,
  AutomationRule,
  CorrelationRule,
  RuleDefinition,
  SavedView,
  Proposal,
  ProposalsResponse,
  RagDocument,
  RagDocumentsResponse,
  RagImportResult,
  RagSearchResponse,
  RagStats,
  ReauthResult,
  RolesResponse,
  Runbook,
  RunbookDeleteResponse,
  RunbookDetail,
  RunbookIndexResult,
  RunbookMutationResponse,
  RunbooksResponse,
  UpstreamReleasesResponse,
  SessionsResponse,
  ScanNotifications,
  SearchResult,
  SecretsUpdate,
  SettingsResponse,
  SettingsSchema,
  SchedulerHealthResponse,
  SetupStatus,
  SourceCoverage,
  SourceInstance,
  SourceLogsQuery,
  SourceLogsResponse,
  SourcesHealthResponse,
  SourcesResponse,
  SourceUpsert,
  StandupResponse,
  SystemUpdateJob,
  SystemUpdatePreflightResponse,
  SystemUpdateReceipt,
  SystemUpdateStatusResponse,
  Terminology,
  ThreatContextPanel,
  ThresholdTuningConfig,
  UsageSummary,
  User,
  UserCreateOptions,
  UserPrefs,
  UsersResponse,
} from './types';

/** Payload for POST /api/cases/{id}/feedback (analyst grading). */
export interface CaseFeedbackInput {
  analyst?: string;
  assessment: 'agree' | 'partial' | 'disagree';
  accuracy?: number;
  reasoning_quality?: number;
  action_appropriateness?: number;
  actual_outcome?: string;
  time_saved_minutes?: number;
  comment?: string;
}

/** Payload for POST /api/cases/{id}/comment. */
export interface CaseCommentInput {
  author?: string;
  body: string;
}

/** Result of GET /api/cases/{id}/export. */
export interface CaseExport {
  filename: string;
  content_type: string;
  content: string;
}

/**
 * Result of POST /api/sources/{id}/analyze-sample (F9). The backend sanitizes a
 * pasted sample record and returns suggested field mappings + the discovered field
 * paths. The sample is NEVER persisted. All values are UNTRUSTED (source-derived) —
 * render the suggested field paths as plain text.
 */
export interface AnalyzeSampleResult {
  suggested_mappings: Partial<{
    source_ip_field: string;
    user_field: string;
    host_field: string;
    message_field: string;
    severity_field: string;
    rule_field: string;
  }> &
    Record<string, string>;
  /**
   * Which of the default case-evidence paths this sample record actually carries —
   * the answer to "do MY alerts carry the fields that decide the case?". Every entry
   * is one of the backend's own constants matched against the sample, never a path
   * echoed back from the untrusted record.
   */
  suggested_evidence_fields?: string[];
  fields: string[];
}

/** Payload for POST /api/rag/import (index a document into the RAG corpus). */
export interface RagImportInput {
  title: string;
  text: string;
  source?: string;
  tags?: string[];
}

/** Payload for POST /api/memory (add a durable operator memory). */
export interface MemoryInput {
  text: string;
  category?: string;
  tags?: string[];
}

/** Patch for PUT /api/memory/{id} (all fields optional / partial update). */
export interface MemoryPatch {
  text?: string;
  category?: string;
  tags?: string[];
  active?: boolean;
  /** Manager review of an agent-authored suggestion. */
  review_status?: 'approved' | 'pending';
}

// --------------------------------------------------------------------------- //
// Round-5 W0-F F2 scaffolds — payload/result contracts for the new stub
// namespaces (`api.rules`, `api.dashboards`, `api.triage`, and the per-feature
// `getConfig/putConfig` clients). These mirror the backend contracts that later
// waves flesh out (Rules G6, Custom-Dash G7, F4 preview-decision, F5 typed config
// endpoints). All are additive; the nginx `/api` proxy forwards arbitrary JSON.
// --------------------------------------------------------------------------- //

/**
 * Input for POST /api/triage/preview-decision (F4). A thin, read-only what-if over
 * the pure deterministic `decide()` — it NEVER bills an LLM (#6), never writes a
 * case, and never re-implements the decision. `verdict` uses the backend `Verdict`
 * enum values (uppercase); `policy` is optional (defaults to the live auto-close
 * policy server-side).
 */
export interface PreviewDecisionInput {
  verdict: 'FALSE_POSITIVE' | 'TRUE_POSITIVE' | 'NEEDS_HUMAN' | string;
  /** Verdict confidence (0..1). */
  confidence: number;
  /** Cluster risk score (0..100). */
  risk_score: number;
  /** Optional candidate policy to preview; omitted → the live `prefs.auto_close`. */
  policy?: AutoClosePolicy;
}

/**
 * Result of POST /api/triage/preview-decision (F4). Mirrors the backend `Decision`
 * dataclass fields the endpoint projects. `decision` is the resulting lifecycle
 * status; `rationale` is the deterministic explanation string (both plain data, #9).
 */
export interface PreviewDecisionResult {
  /**
   * The deterministic decision, nested exactly as the backend returns it
   * (`routes_triage.preview_decision`). `decision.status` is the resulting lifecycle
   * {@link CaseStatus}; the escalate/decision_by/objection-window fields live UNDER
   * `decision`, not at the top level.
   */
  decision: {
    /** The resulting deterministic lifecycle status (a {@link CaseStatus} value). */
    status: CaseStatus;
    /** Who made the decision (agent auto-close vs. system fail-safe). */
    decision_by: string;
    /** Whether the case would be flagged for priority human attention. */
    escalate: boolean;
    /** When the reopen (objection) window expires, for an agent auto-close. */
    objection_window_expires_at?: string | null;
    /** Whether the decision auto-closes the case (status === CLOSED). */
    auto_closed: boolean;
  };
  /** Human-readable, deterministic rationale for the decision. */
  rationale: string;
  /** The resolved inputs the decision was computed from (echoed for the what-if strip). */
  inputs?: {
    verdict?: string | null;
    confidence?: number;
    risk_score?: number;
    escalation_confidence?: number;
    critical_severity?: number;
    policy_provided?: boolean;
  };
}

/**
 * Response of GET /api/rules (`routes_rules.list_rules`) — every rule across the three
 * families the engine reads, as plain JSON (#9). This mirrors the backend keys exactly;
 * there is NO flat `rules` array. Rides `PUT /api/settings` for writes.
 */
export interface RulesResponse {
  /** `Preferences.rule_catalog` — the detection rules. */
  detection: RuleDefinition[];
  /** `Preferences.correlation_rules`, keyed by rule name. */
  correlation: Record<string, CorrelationRule>;
  /** The fallback correlation rule applied when no per-rule override matches. */
  default_correlation: CorrelationRule;
  /** `Preferences.threshold_automation.rules`, each flagged when it carries an impossible verdict. */
  case_automation: Array<AutomationRule & { invalid_verdict: boolean }>;
  /** Whether case-automation is globally enabled. */
  automation_enabled: boolean;
  /** Canonical (enum-case) verdicts for display. */
  valid_verdicts: string[];
  /** The same verdict set in the lower-case form the editors emit. */
  valid_verdicts_lower: string[];
}

/* --------------------------------------------------------------------------- //
 * Rule lifecycle (G6 R5) — version ledger + rollback + read-only preview.
 * Mirrors `backend/app/api/routes_rules.py` (the RB router) +
 * `backend/app/stores/rule_versions.py`. Every id/name/field is UNTRUSTED,
 * operator-authored / log-adjacent → plain text (#9). The PREVIEW never bills the
 * LLM (#6, zero UsageDoc) and never calls `decide()` (#3).
 * --------------------------------------------------------------------------- */

/** The three rule families the version ledger + rules router are config-writers over. */
export type RuleKind = 'detection' | 'correlation' | 'case_automation';

/**
 * One immutable version snapshot of a rule's WHOLE config at a point in time
 * (mirrors `RuleVersion.to_json()`). `config` is the full plain-JSON rule snapshot a
 * rollback restores verbatim. `action` is what produced the version; `rolled_back_to`
 * is set only on a `rollback` version.
 */
export interface RuleVersion {
  id: string;
  kind: RuleKind;
  rule_id: string;
  /** Full plain-JSON snapshot of the rule config at this version (#9 — render escaped). */
  config: Record<string, unknown>;
  action: 'create' | 'update' | 'enable' | 'disable' | 'delete' | 'rollback' | string;
  /** The authenticated username that made the change ("" when auth off). */
  actor: string;
  /** Short, plain, length-bounded human note. */
  summary: string;
  created_at: string;
  /** When `action === 'rollback'`, the version id this restored. */
  rolled_back_to?: string | null;
}

/** Response of GET /api/rules/{kind}/{rule_id}/versions — newest first. */
export interface RuleVersionsResponse {
  kind: string;
  rule_id: string;
  versions: RuleVersion[];
}

/** Response of POST /api/rules/{kind}/{rule_id}/rollback/{version_id}. */
export interface RuleRollbackResult {
  ok: boolean;
  kind: string;
  rule_id: string;
  restored_from: string;
  rule: Record<string, unknown>;
}

/**
 * Input for POST /api/rules/preview — a read-only, hard-capped what-if over RECENT
 * events. `match` is the flat predicate list a detection rule carries (`RuleMatch`);
 * the backend counts how many recent events WOULD match. It NEVER calls `decide()`,
 * NEVER creates a case, NEVER bills the LLM (#6). Window + count are hard-capped.
 */
export interface RulePreviewInput {
  /** The flat predicate rows (`{field, op, value}`); an empty list matches nothing. */
  match: Array<{ field: string; op: string; value?: string }>;
  /** Scope to one source; omit for all browse-capable sources. */
  source_id?: string;
  /** Hard-capped result size (1..200; default 200 — matches the backend `le=200` cap). */
  limit?: number;
  /** Relative/absolute time window bounds (ES date-math friendly). */
  from?: string;
  to?: string;
  /** Histogram bucket width in minutes (1..1440; default 60). */
  bucket_minutes?: number;
}

/** One time-bucket in the preview histogram (`{bucket_start_iso, count}`). */
export interface RulePreviewBucket {
  bucket: string;
  count: number;
}

/** A trimmed, plain, render-safe matched log row for the preview sample (#9). */
export interface RulePreviewSampleRow {
  id: string;
  ts: string;
  source_ip?: string | null;
  user?: string | null;
  host?: string | null;
  rule?: string | null;
  severity?: number | null;
  message: string;
}

/**
 * Result of POST /api/rules/preview. `matched` of `scanned` recent events would have
 * matched; `histogram` buckets those matches over time; `sample` is a small plain-data
 * projection. `hard_capped` warns the scan hit the cap (results may under-count).
 */
export interface RulePreviewResult {
  scanned: number;
  matched: number;
  match_rate: number;
  histogram: RulePreviewBucket[];
  sample: RulePreviewSampleRow[];
  /** How many predicate rows were SUPPLIED. */
  predicates: number;
  /**
   * How many predicate rows the preview ACTUALLY evaluated. The save adapter keeps only
   * the FIRST row (`RuleDefinition.match` is a single `RuleMatch`; nested AND/OR is a
   * gated Phase-3 wave), so the preview matches the deployed rule by evaluating only the
   * first row too — this is ≤ 1 until nested logic ships (M3). When
   * `predicates > predicates_evaluated` the extra rows are neither saved nor previewed.
   * Optional for back-compat with an older server that omitted it.
   */
  predicates_evaluated?: number;
  hard_capped: boolean;
}

/**
 * Response of GET /api/dashboards (G7). The caller's saved custom dashboards
 * (persisted per-user under `UserPrefs.dashboards`). Every dashboard/widget name is
 * UNTRUSTED → render as plain text / SVG `<text>` (#9).
 */
export interface DashboardsResponse {
  dashboards: DashboardLayout[];
}

// --------------------------------------------------------------------------- //
// Custom-dashboards CLIENT-side write debounce (G7 / CD5).
//
// A drag/resize settle can fire several `PUT /api/dashboards/{id}` in quick
// succession (RGL `onLayoutChange` ticks, autosave-on-edit). We COALESCE rapid
// successive updates to the SAME dashboard id into one trailing PUT ~500ms after the
// last call, so a fast interaction persists exactly once instead of thrashing the
// backend. Every caller that awaited an update during the window resolves with (or
// rejects from) that single final request — the awaitable contract the builder relies
// on (it commits the server echo) is preserved; only the network chatter is collapsed.
// Keyed per dashboard id so two different boards never share a timer.
//
// An EXPLICIT Save is a different intent than a settle stream: it must NOT eat the
// coalescing delay. `update(id, body, { immediate: true })` therefore takes a separate
// path — it fires one PUT right away and FOLDS any pending coalesced settle for that id
// into it — while the default (no opts) keeps the trailing-debounce coalescing above.
// --------------------------------------------------------------------------- //

/** Client debounce window for dashboard writes (ms). Kept small so a save feels instant. */
const DASHBOARD_UPDATE_DEBOUNCE_MS = 500;

interface PendingDashboardUpdate {
  timer: ReturnType<typeof setTimeout>;
  /** The most recent payload wins (last-write-wins for the coalesced settle). */
  body: DashboardLayout;
  /** Every awaiting caller in this window resolves/rejects together. */
  resolvers: Array<(v: DashboardLayout) => void>;
  rejecters: Array<(e: unknown) => void>;
}

const pendingDashboardUpdates = new Map<string, PendingDashboardUpdate>();

/** Flush a coalesced trailing entry: fire ONE PUT and settle every awaiting caller. */
function flushDashboardUpdate(id: string, entry: PendingDashboardUpdate): void {
  pendingDashboardUpdates.delete(id);
  const { body, resolvers, rejecters } = entry;
  request<DashboardLayout>('PUT', `dashboards/${encodeURIComponent(id)}`, { body })
    .then((res) => resolvers.forEach((r) => r(res)))
    .catch((err) => rejecters.forEach((r) => r(err)));
}

/**
 * Trailing-debounced `PUT /api/dashboards/{id}` — the DEFAULT path for a drag/resize
 * settle stream. Collapses rapid successive updates to the same id into ONE trailing
 * request ~500ms after the last call. Returns a promise that settles when the coalesced
 * request completes; callers made within the same window share that outcome.
 */
function debouncedDashboardUpdate(id: string, body: DashboardLayout): Promise<DashboardLayout> {
  return new Promise<DashboardLayout>((resolve, reject) => {
    const existing = pendingDashboardUpdates.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      existing.body = body; // last write wins
      existing.resolvers.push(resolve);
      existing.rejecters.push(reject);
      existing.timer = setTimeout(() => flushDashboardUpdate(id, existing), DASHBOARD_UPDATE_DEBOUNCE_MS);
      return;
    }
    const entry: PendingDashboardUpdate = {
      timer: null as unknown as ReturnType<typeof setTimeout>,
      body,
      resolvers: [resolve],
      rejecters: [reject],
    };
    entry.timer = setTimeout(() => flushDashboardUpdate(id, entry), DASHBOARD_UPDATE_DEBOUNCE_MS);
    pendingDashboardUpdates.set(id, entry);
  });
}

/**
 * IMMEDIATE `PUT /api/dashboards/{id}` — for an EXPLICIT Save. Fires one PUT right now so
 * the primary action never eats the ~500ms coalescing delay meant only for a drag/resize
 * settle burst. If a trailing coalesced write for this id is still pending it is CANCELLED
 * and FOLDED into this request (its awaiters settle with this same outcome), so a Save that
 * lands mid-settle persists exactly once, immediately.
 */
function immediateDashboardUpdate(id: string, body: DashboardLayout): Promise<DashboardLayout> {
  const pending = pendingDashboardUpdates.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    pendingDashboardUpdates.delete(id);
  }
  const req = request<DashboardLayout>('PUT', `dashboards/${encodeURIComponent(id)}`, { body });
  if (pending) {
    req
      .then((res) => pending.resolvers.forEach((r) => r(res)))
      .catch((err) => pending.rejecters.forEach((r) => r(err)));
  }
  return req;
}

/** Error thrown for any non-2xx backend response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A successful binary download plus the response metadata needed to name it safely. */
export interface BlobDownload {
  blob: Blob;
  contentDisposition: string | null;
  contentType: string | null;
}

/** Secret-free application-state scopes accepted by the portable archive endpoint. */
export type DataExportScope =
  | 'cases'
  | 'audit'
  | 'usage'
  | 'configuration'
  | 'automation'
  | 'knowledge';

/**
 * The single API prefix every request is built from. EXPORTED so co-located data
 * layers that hand-build a URL for a plain `<a href>` download (e.g. the ATT&CK
 * Navigator layer export) derive it from ONE place instead of hard-coding `/api`,
 * so a deployment that serves the API under a different prefix stays consistent.
 */
export const API_BASE = '/api';

/**
 * Optional global 401 handler. When auth is enabled the app registers a callback
 * here; any non-auth API call that returns 401 invokes it so the app can bounce
 * the user back to the login screen. When auth is disabled no callback is
 * registered, so this is inert and the no-auth experience is unchanged.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * Optional step-up re-auth gate (Round-2 Wave 3). When auth is enabled the app
 * registers a callback here; any API call that returns 401 with the backend body
 * `{code:'reauth_required'}` invokes it, opening a re-auth modal. The callback
 * resolves `true` once the user has re-authenticated (so the original request is
 * retried ONCE) or `false` if they cancelled (the original 401 surfaces). When no
 * callback is registered (auth off, or before the provider mounts) the gate is
 * inert and the 401 surfaces unchanged — the no-auth path is untouched.
 */
let reauthGate: (() => Promise<boolean>) | null = null;
export function setReauthHandler(handler: (() => Promise<boolean>) | null): void {
  reauthGate = handler;
}

/** Extract a backend error `code` (e.g. "reauth_required") from a parsed body. */
function bodyCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail;
    if (detail && typeof detail === 'object' && 'code' in detail) {
      const c = (detail as { code?: unknown }).code;
      if (typeof c === 'string') return c;
    }
    if ('code' in body) {
      const c = (body as { code?: unknown }).code;
      if (typeof c === 'string') return c;
    }
  }
  return null;
}

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

/** Friendly labels for backend coded errors that carry no human `message` string. */
const ERROR_CODE_LABELS: Record<string, string> = {
  session_invalid: 'Your session is no longer valid. Please sign in again.',
  reauth_required: 'Please re-enter your password to continue.',
  chat_history_unavailable: 'Conversation history is temporarily unavailable. Try again.',
  chat_request_in_progress: 'This request is still running. Wait a moment, then retry.',
  chat_request_capacity_busy: 'Too many chat requests are still running. Wait a moment, then retry.',
  chat_idempotency_conflict: 'This retry no longer matches the original request. Send it as a new message.',
  chat_source_unavailable: 'The selected source is unavailable. Choose another source and retry.',
};

function extractMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') {
      // A coded HTTPException detail (e.g. {code:'session_invalid', reason:'refresh_reuse'})
      // carries no human string — prefer a message/detail field, then map the code to a
      // readable sentence, and only stringify as a genuine last resort (never a raw blob).
      const d = detail as Record<string, unknown>;
      if (typeof d.message === 'string' && d.message.trim()) return d.message;
      if (typeof d.detail === 'string' && d.detail.trim()) return d.detail;
      if (typeof d.code === 'string' && d.code.trim())
        return ERROR_CODE_LABELS[d.code] || `Request failed (${status})`;
      return JSON.stringify(detail);
    }
    if (detail) return JSON.stringify(detail);
  }
  if (typeof body === 'string' && body.trim()) return body;
  return `Request failed (${status})`;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, unknown>;
  _retried?: boolean;
  signal?: AbortSignal;
  cache?: RequestCache;
}

/**
 * Fetch one authenticated response and apply the shared error/session/step-up flow.
 * Keeping this below both JSON and Blob readers means binary downloads cannot bypass
 * the exactly-once re-auth retry or accidentally turn an error response into a file.
 */
async function requestResponse(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const clean = path.replace(/^\/+/, '');
  const url = `${API_BASE}/${clean}${buildQuery(opts.query)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // Send the auth cookie (HttpOnly) on every call so the optional login flow
      // works; harmless (and required for same-origin) when auth is disabled.
      credentials: 'include',
      signal: opts.signal,
      cache: opts.cache,
      headers:
        opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    // Superseded parameter-keyed reads deliberately abort; preserve that control
    // flow instead of disguising it as a backend outage.
    if (opts.signal?.aborted) throw e;
    // Network-level failure (backend down, CORS, etc.)
    throw new ApiError(0, `Cannot reach backend: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await parseBody(res);
    // A 401 with `code:'reauth_required'` is a STEP-UP gate (the session is valid
    // but the action needs fresh credentials). Open the re-auth modal; if the user
    // re-authenticates, retry the original request exactly ONCE. Never recurse on a
    // retry, and never treat the /auth/reauth call itself as a gate trigger.
    if (
      res.status === 401 &&
      reauthGate &&
      !opts._retried &&
      bodyCode(body) === 'reauth_required' &&
      clean !== 'auth/reauth'
    ) {
      const ok = await reauthGate();
      if (ok) {
        return requestResponse(method, path, { ...opts, _retried: true });
      }
      // User cancelled — surface the original 401.
      throw new ApiError(res.status, extractMessage(res.status, body), body);
    }
    // A plain 401 from a non-auth endpoint means the session lapsed (or auth was
    // just turned on); bounce to the login screen. The auth endpoints handle their
    // own 401s inline (expected on a bad password), so they are excluded.
    if (res.status === 401 && onUnauthorized && !clean.startsWith('auth/')) {
      onUnauthorized();
    }
    throw new ApiError(res.status, extractMessage(res.status, body), body);
  }
  return res;
}

async function request<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await requestResponse(method, path, opts);
  return (await parseBody(res)) as T;
}

async function requestBlob(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<BlobDownload> {
  const res = await requestResponse(method, path, opts);
  return {
    blob: await res.blob(),
    contentDisposition: res.headers.get('content-disposition'),
    contentType: res.headers.get('content-type'),
  };
}

/**
 * Runbooks gained first-class management metadata after the original read-only
 * catalog shipped. Normalise responses here so a rolling frontend/backend upgrade
 * cannot crash the Intelligence page while an older worker still returns the
 * smaller catalog shape. The defaults deliberately keep legacy documents bundled
 * and immutable; they never manufacture operator write authority.
 */
function normalizeRunbook<T extends Runbook>(value: T): T {
  const raw = value as unknown as Partial<Runbook> & Record<string, unknown>;
  const strings = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === 'string')
      : [];
  const sourceType = raw.source_type === 'operator' ? 'operator' : 'bundled';
  const protectedRunbook =
    typeof raw.protected === 'boolean' ? raw.protected : sourceType !== 'operator';

  return {
    ...value,
    title: typeof raw.title === 'string' ? raw.title : String(raw.id || ''),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    applies_to_rules: strings(raw.applies_to_rules),
    applies_to_techniques: strings(raw.applies_to_techniques),
    applies_to_entities: strings(raw.applies_to_entities),
    keywords: strings(raw.keywords),
    source_type: sourceType,
    protected: protectedRunbook,
    editable:
      typeof raw.editable === 'boolean'
        ? raw.editable && !protectedRunbook
        : sourceType === 'operator' && !protectedRunbook,
    revision: raw.revision ?? 1,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : null,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    index_status: typeof raw.index_status === 'string' ? raw.index_status : 'unknown',
    indexed_revision: raw.indexed_revision ?? null,
    last_indexed_at:
      typeof raw.last_indexed_at === 'string' ? raw.last_indexed_at : null,
    index_error: typeof raw.index_error === 'string' ? raw.index_error : null,
  } as T;
}

function normalizeRunbooksResponse(value: RunbooksResponse): RunbooksResponse {
  const raw = value as unknown as Partial<RunbooksResponse> & Record<string, unknown>;
  const runbooks = Array.isArray(raw.runbooks)
    ? raw.runbooks.map((runbook) => normalizeRunbook(runbook as Runbook))
    : [];
  const enabled = raw.enabled !== false;
  const authoringStandard =
    raw.authoring_standard && typeof raw.authoring_standard === 'object'
      ? raw.authoring_standard
      : undefined;
  return {
    enabled,
    retrieval_enabled:
      typeof raw.retrieval_enabled === 'boolean' ? raw.retrieval_enabled : enabled,
    authoring_standard: authoringStandard,
    count: typeof raw.count === 'number' ? raw.count : runbooks.length,
    runbooks,
  };
}

/** Generic verbs, for ad-hoc/endpoints not yet wrapped in a typed method. */
export const api = {
  get: <T = unknown>(path: string, query?: Record<string, unknown>, signal?: AbortSignal) =>
    request<T>('GET', path, { query, signal }),
  post: <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  postAbortable: <T = unknown>(path: string, body: unknown, signal: AbortSignal) =>
    request<T>('POST', path, { body, signal }),
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  // Some routes are registered PATCH-only (e.g. the case-collab thread-message edit
  // + task patch in `routes_cases_collab.py`); calling them with PUT 405s. Mirrors put().
  patch: <T = unknown>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T = unknown>(path: string) => request<T>('DELETE', path),

  // ---- Secret-free application-state export --------------------------- //
  // The archive endpoint returns binary data, so it cannot use the ordinary JSON
  // reader. It still runs through requestResponse and therefore preserves cookies,
  // session-lapse handling, AbortSignal, ApiError extraction and one re-auth retry.
  dataExport: {
    archive: (scopes: DataExportScope[], signal?: AbortSignal) =>
      requestBlob('POST', 'admin/export/archive', { body: { scopes }, signal }),
  },

  // ---- Durable background jobs ---------------------------------------- //
  // Ordinary application work, distinct from the separately hardened updater.
  jobs: {
    submit: (input: BackgroundJobSubmit) =>
      request<BackgroundJob>('POST', 'jobs', { body: input }),
    list: (query?: { limit?: number; offset?: number }, signal?: AbortSignal) =>
      request<BackgroundJobsResponse>('GET', 'jobs', { query, signal }),
    get: (jobId: string, signal?: AbortSignal) =>
      request<BackgroundJob>('GET', `jobs/${encodeURIComponent(jobId)}`, { signal }),
    cancel: (jobId: string) =>
      request<BackgroundJob>('POST', `jobs/${encodeURIComponent(jobId)}/cancel`),
    artifact: (jobId: string, signal?: AbortSignal) =>
      requestBlob('GET', `jobs/${encodeURIComponent(jobId)}/artifact`, { signal }),
  },

  // ---- Auth (optional; OFF-safe) ---------------------------------------- //
  auth: {
    me: () => request<AuthMe>('GET', 'auth/me'),
    login: (username: string, password: string) =>
      request<LoginResult>('POST', 'auth/login', { body: { username, password } }),
    logout: () => request<{ ok: boolean }>('POST', 'auth/logout'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean }>('POST', 'auth/change-password', {
        body: { current_password: currentPassword, new_password: newPassword },
      }),

    // ---- MFA (TOTP) — Wave 2 / F3 ------------------------------------------ //
    mfa: {
      // Begin enrollment (self): returns secret + otpauth URI + recovery codes ONCE.
      setup: () => request<MfaSetupResult>('POST', 'auth/mfa/setup'),
      // Confirm enrollment: verify a TOTP code against the pending secret + enable.
      confirm: (code: string) =>
        request<{ ok: boolean }>('POST', 'auth/mfa/confirm', { body: { code } }),
      // Login phase 2 (PUBLIC; gated by the pending_token). Accepts a TOTP OR a
      // single-use recovery code. Returns { token, user } like a normal login.
      verify: (pendingToken: string, code: string) =>
        request<LoginResult>('POST', 'auth/mfa/verify', {
          body: { pending_token: pendingToken, code },
        }),
      // MANDATED enrollment DURING login (PUBLIC; gated by the pending_token from a
      // login that returned `mfa_enrollment_required`). Byte-same payload shape as
      // `setup` — recovery codes appear ONLY here, so display them at this step.
      // Re-calling regenerates the pending secret. 401 = invalid/expired pending.
      enrollSetup: (pendingToken: string) =>
        request<MfaSetupResult>('POST', 'auth/mfa/enroll-setup', {
          body: { pending_token: pendingToken },
        }),
      // Confirm mandated enrollment: verifies the TOTP against the pending secret,
      // persists the factor, then mints the FULL session (cookie set server-side)
      // and returns the exact /auth/mfa/verify success payload — treat success as
      // login-complete (incl. `user.must_change_password`). 401 = wrong code
      // (retry while the pending token lives) or invalid/expired pending.
      enrollConfirm: (pendingToken: string, code: string) =>
        request<LoginResult>('POST', 'auth/mfa/enroll-confirm', {
          body: { pending_token: pendingToken, code },
        }),
      // Disable MFA (self): requires a current TOTP or a recovery code.
      disable: (code: string) =>
        request<{ ok: boolean }>('POST', 'auth/mfa/disable', { body: { code } }),
    },

    // ---- SSO (OIDC) — Wave 2 / F4 ------------------------------------------ //
    sso: {
      // PUBLIC: the enabled providers for the login screen.
      providers: () => request<SsoProvidersResponse>('GET', 'auth/sso/providers'),
      // PUBLIC: the IdP authorization URL to redirect the browser to.
      authorize: (provider: string) =>
        request<SsoAuthorizeResult>('GET', 'auth/sso/authorize', { query: { provider } }),
      // Admin: set/clear a provider's OIDC client secret (write-only).
      setSecret: (providerId: string, clientSecret: string | null) =>
        request<{ ok: boolean; configured: boolean }>(
          'POST',
          `auth/sso/providers/${encodeURIComponent(providerId)}/secret`,
          { body: { client_secret: clientSecret } },
        ),
    },

    // ---- Sessions: refresh + step-up re-auth (Round-2 Wave 3) ------------- //
    // Rotate the access/refresh tokens (new HttpOnly cookie set server-side; no
    // token is returned to JS). Used to recover from an idle/expired session.
    refresh: () => request<ReauthResult>('POST', 'auth/refresh'),
    // Step-up ("sudo") re-auth — re-prove the password (and/or an MFA code) to
    // stamp `last_authn`, satisfying a `reauth_required` gate before a sensitive
    // action. The current session is NOT replaced; only freshness is bumped.
    reauth: (password: string, code?: string) =>
      request<ReauthResult>('POST', 'auth/reauth', {
        body: { password, ...(code ? { code } : {}) },
      }),
  },

  // ---- Sessions (the signed-in user's OWN sessions) --------------------- //
  // List the caller's active sessions (the current one flagged `current:true`),
  // revoke a single session, or sign out every OTHER session. All gated by
  // current_user server-side; no secret/token is ever returned (#10).
  sessions: {
    list: () => request<SessionsResponse>('GET', 'sessions'),
    revoke: (sid: string) =>
      request<{ ok: boolean; sid: string }>(
        'POST',
        `sessions/${encodeURIComponent(sid)}/revoke`,
      ),
    revokeOthers: () =>
      request<{ ok: boolean; revoked: number }>('POST', 'sessions/revoke-others'),
  },

  // ---- Account activity (the user's recent audit trail) ----------------- //
  // GET /api/account/activity — recent audit events for the signed-in user. Every
  // value is system/operator-derived; render PLAIN.
  account_activity: () => request<ActivityResponse>('GET', 'account/activity'),

  // ---- Admin session console (all users' sessions) ---------------------- //
  // users:manage server-side. List ALL sessions (optionally filtered by user),
  // force-terminate one (optionally notifying the owner), or revoke EVERY session
  // for a user (bumps their token_version so already-issued tokens stop working).
  admin: {
    sessions: {
      list: (username?: string) =>
        request<SessionsResponse>('GET', 'admin/sessions', {
          query: username ? { username } : undefined,
        }),
      revoke: (sid: string, notify = false) =>
        request<{ ok: boolean; sid: string }>(
          'POST',
          `admin/sessions/${encodeURIComponent(sid)}/revoke`,
          { body: { notify } },
        ),
    },
    users: {
      revokeAll: (username: string, notify = false) =>
        request<{ ok: boolean; revoked: number }>(
          'POST',
          `admin/users/${encodeURIComponent(username)}/revoke-all`,
          { body: { notify } },
        ),
    },
  },

  // ---- Account / profile self-service (Round-2 Wave 2) ------------------ //
  // The signed-in user's OWN profile. Gated server-side by current_user (NOT
  // users:manage). Secrets are never returned; the avatar string is a tiny
  // data: URL the browser has already cropped/resized to 256x256 WebP.
  account: {
    get: () => request<AccountProfile>('GET', 'account/me'),
    put: (patch: AccountProfileBody) =>
      request<AccountProfile>('PUT', 'account/me', { body: patch }),
    // Thin set/clear of just the avatar. `value` null/"" clears it. The backend
    // validates the data: URL (png/webp/jpeg, magic-byte sniff, bounded length).
    avatar: (value: string | null) =>
      request<AccountProfile>('PUT', 'me/avatar', { body: { avatar: value } }),
  },

  // ---- OOBE first-run setup (PUBLIC status) ---------------------------- //
  // The legacy public `POST /api/setup/init-admin` route was REMOVED in the Round-4
  // audit (the live OOBE flow is `/api/setup/account`); the dead client stub was
  // deleted here too (bug #10 — it POSTed a route that no longer exists).
  setup: {
    status: () => request<SetupStatus>('GET', 'setup/status'),
  },

  // ---- RBAC: roles matrix + multi-user administration ------------------- //
  roles: {
    get: () => request<RolesResponse>('GET', 'roles'),
  },
  users: {
    list: () => request<UsersResponse>('GET', 'users'),
    // Create a user. Additive fields beyond username/password/role: full name /
    // email / phone (plain-text contact metadata, #9), the `mfa_required` mandate
    // (required ≠ enrolled — never mints a secret), and creation-time
    // `custom_roles` (EXISTING custom roles, validated + persisted exactly like
    // PUT /users/{username}/roles). The server stays authoritative for validation.
    create: (options: UserCreateOptions) =>
      request<{ ok: boolean; user: User }>('POST', 'users', { body: options }),
    update: (
      username: string,
      patch: {
        role?: string;
        active?: boolean;
        password?: string;
        /** Only `false` is honored (admin force-disable); enabling stays self-service. */
        mfa_enabled?: boolean;
        /** Admin-editable contact metadata ("" clears; plain text, #9). */
        display_name?: string;
        email?: string;
        phone?: string;
        /** The MFA mandate — settable BOTH ways under users:manage. */
        mfa_required?: boolean;
      },
    ) =>
      request<{ ok: boolean; user: User }>('PUT', `users/${encodeURIComponent(username)}`, {
        body: patch,
      }),
    remove: (username: string) =>
      request<{ ok: boolean }>('DELETE', `users/${encodeURIComponent(username)}`),
  },

  // ---- Notifications / alerting (F5 / Wave 4) --------------------------- //
  // Config rides PUT /api/settings (notifications subtree). These cover the
  // provider catalog, per-channel secret (write-only), a test send, and a manual
  // per-case notify. Secrets are never returned (only configured booleans).
  notifications: {
    // settings:read — email presets + the available channel types.
    providers: () => request<NotificationProviders>('GET', 'notifications/providers'),
    // settings:manage — send a sample to one channel (detail never leaks a secret).
    test: (channelId: string) =>
      request<NotificationTestResult>('POST', 'notifications/test', {
        body: { channel_id: channelId },
      }),
    // settings:manage — set/clear one channel's secret field (write-only). `value`
    // null/"" clears it. Returns { ok, configured, configured_secrets }.
    channelSecret: (channelId: string, value: string | null, field = 'secret') =>
      request<{ ok: boolean; configured: boolean; configured_secrets: string[] }>(
        'POST',
        `notifications/channels/${encodeURIComponent(channelId)}/secret`,
        { body: { field, value } },
      ),
    // settings:manage — SERVER-side render a template against a sample case for the
    // trigger. The server is authoritative for #9 escaping; the optional `template`
    // body lets the editor preview an UNSAVED draft override before persisting it.
    // Returns { trigger, subject, html, text, variables?, is_override? }.
    preview: (trigger: string, template?: NotificationTemplate) =>
      request<NotificationPreview>(
        'POST',
        `notifications/preview?trigger=${encodeURIComponent(trigger)}`,
        { body: template ? { template } : {} },
      ),
  },
  cases: {
    // cases:write — manually send a case notification to one channel (or all
    // enabled when channelId is omitted). Fire-and-forget; never alters the case.
    notify: (caseId: string, channelId?: string) =>
      request<NotifyCaseResult>('POST', `cases/${encodeURIComponent(caseId)}/notify`, {
        body: channelId ? { channel_id: channelId } : {},
      }),
    // playbooks:run — CONTEXT-ONLY re-investigation with `playbookId` forced as the
    // injected (recommend-only) operator procedure. The deterministic close/escalate
    // decision is unchanged — decide() re-runs with the new context. Returns the
    // updated Case (verdict/rationale may change; status is never set by the run).
    runPlaybook: (caseId: string, playbookId: string) =>
      request<Case>('POST', `cases/${encodeURIComponent(caseId)}/run-playbook`, {
        body: { playbook_id: playbookId },
      }),
    // cases:read — the assembled threat-context panel (IOC reputation, MITRE
    // techniques, related cases, asset context, evidence). Fail-open per section.
    threatContext: (caseId: string) =>
      request<ThreatContextPanel>(
        'GET',
        `cases/${encodeURIComponent(caseId)}/threat-context`,
      ),
    // BULK case action (W7c) — apply ONE human lifecycle action (the SAME logic as
    // POST /api/cases/{id}/action) to N selected cases. #3-safe: never an LLM
    // auto-close, never decide(); each case audited individually. RBAC-gated server-
    // side (cases:close for close/resolve, cases:write otherwise). Returns per-id
    // outcomes ({results:[{id, ok, error?}]}) — a partial failure fails only that id.
    bulk: (ids: string[], input: CaseActionInput) =>
      request<BulkResult>('POST', 'cases/bulk', { body: { ...input, ids } }),
  },

  // ---- Global search (W7c) — Cmd-K palette + top-bar jump ---------------- //
  // Read-only across cases + sources + nav targets, bounded (cap 50). Every
  // returned label/title is operator-/log-derived → render as PLAIN text (#9).
  search: (q: string, limit?: number) =>
    request<SearchResult>('GET', 'search', { query: { q, limit } }),

  // ---- Audit-log viewer (W7c) — read-only over the append-only audit (#2) - //
  // Gated by audit:view server-side (admin/auditor/soc_manager). Filters are
  // ANDed; the `action`/`from`/`to` params map to the audit `action_type`/ts
  // bounds. Every field is rendered PLAIN (#9). No write/update/delete path exists.
  audit: {
    list: (params?: AuditQuery) =>
      request<AuditResponse>('GET', 'audit', {
        query: params as Record<string, unknown> | undefined,
      }),
  },

  // ---- Threat-intel knowledge import (F11) ----------------------------- //
  // rag:manage — ingest a threat-intel document into the RAG corpus as
  // source="threat_context"; it is retrieved + injected as a TRUSTED fenced block.
  threatContext: {
    import: (input: { title: string; content: string; tags?: string[] }) =>
      request<RagImportResult>('POST', 'threat-context/import', { body: input }),
  },

  // ---- Personas + playbooks --------------------------------------------- //
  getPersonas: () => request<PersonasResponse>('GET', 'personas'),
  getPlaybooks: () => request<PlaybooksResponse>('GET', 'playbooks'),
  getPlaybook: (playbookId: string) =>
    request<PlaybookDetail>('GET', `playbooks/${encodeURIComponent(playbookId)}`),
  getPlaybookCoverage: () =>
    request<PlaybookCoverageResponse>('GET', 'playbooks/coverage'),
  dryRunPlaybookSelection: (input: PlaybookDryRunInput) =>
    request<PlaybookDryRunResponse>('POST', 'playbooks/dry-run', { body: input }),
  getSchedulerHealth: () =>
    request<SchedulerHealthResponse>('GET', 'schedulers/health'),
  createPlaybook: (input: { id: string; content: string }) =>
    request<PlaybookMutationResponse>('POST', 'playbooks', { body: input }),
  updatePlaybook: (playbookId: string, content: string, expectedRevision: number) =>
    request<PlaybookMutationResponse>('PUT', `playbooks/${encodeURIComponent(playbookId)}`, {
      body: { content, expected_revision: expectedRevision },
    }),

  // ---- Runbooks ------------------------------------------------------- //
  // Trusted RAG reference knowledge. Unlike playbooks, runbooks are never
  // selected as executable procedures and never influence deterministic case
  // authority. Bundled documents remain readable but immutable.
  getRunbooks: () =>
    request<RunbooksResponse>('GET', 'runbooks').then(normalizeRunbooksResponse),
  getRunbook: (runbookId: string) =>
    request<RunbookDetail>('GET', `runbooks/${encodeURIComponent(runbookId)}`).then(
      normalizeRunbook,
    ),
  createRunbook: (input: { id: string; content: string }) =>
    request<RunbookMutationResponse>('POST', 'runbooks', { body: input }).then((result) => ({
      ...result,
      runbook: normalizeRunbook(result.runbook),
    })),
  updateRunbook: (
    runbookId: string,
    content: string,
    expectedRevision: string | number,
  ) =>
    request<RunbookMutationResponse>('PUT', `runbooks/${encodeURIComponent(runbookId)}`, {
      body: { content, expected_revision: expectedRevision },
    }).then((result) => ({
      ...result,
      runbook: normalizeRunbook(result.runbook),
    })),
  deleteRunbook: (runbookId: string, expectedRevision: string | number) =>
    request<RunbookDeleteResponse>('DELETE', `runbooks/${encodeURIComponent(runbookId)}`, {
      query: { expected_revision: expectedRevision },
    }),
  reindexRunbooks: () => request<RunbookIndexResult>('POST', 'runbooks/reindex'),
  reindexRunbook: (runbookId: string) =>
    request<RunbookIndexResult>(
      'POST',
      `runbooks/${encodeURIComponent(runbookId)}/reindex`,
    ),

  // ---- Health + setup --------------------------------------------------- //
  health: (options?: { signal?: AbortSignal; cache?: RequestCache }) =>
    request<HealthResponse>('GET', 'health', options),
  buildInfo: (options?: { signal?: AbortSignal; cache?: RequestCache }) =>
    request<BuildInfoResponse>('GET', 'health/build-info', options),
  upstreamReleases: (options?: { signal?: AbortSignal; cache?: RequestCache }) =>
    request<UpstreamReleasesResponse>('GET', 'releases/upstream', options),
  checkUpstreamReleases: () =>
    request<UpstreamReleasesResponse>('POST', 'releases/upstream/check'),
  // ---- Supervised system updates --------------------------------------- //
  // The browser can select only the opaque, server-advertised release id. It never
  // supplies a URL, path, command, Compose fragment, or image reference; the strict
  // backend + external supervisor remain the sole deployment authorities.
  systemUpdates: {
    status: (options?: { signal?: AbortSignal; cache?: RequestCache }) =>
      request<SystemUpdateStatusResponse>('GET', 'system-updates/status', options),
    preflight: (releaseId: string, idempotencyKey: string) =>
      request<SystemUpdatePreflightResponse>('POST', 'system-updates/preflight', {
        body: { release_id: releaseId, idempotency_key: idempotencyKey },
      }),
    start: (releaseId: string, preflightToken: string, idempotencyKey: string) =>
      request<SystemUpdateJob>('POST', 'system-updates/jobs', {
        body: {
          release_id: releaseId,
          preflight_token: preflightToken,
          idempotency_key: idempotencyKey,
        },
      }),
    job: (jobId: string, options?: { signal?: AbortSignal; cache?: RequestCache }) =>
      request<SystemUpdateJob>(
        'GET',
        `system-updates/jobs/${encodeURIComponent(jobId)}`,
        options,
      ),
    cancel: (jobId: string, idempotencyKey: string) =>
      request<SystemUpdateJob>(
        'POST',
        `system-updates/jobs/${encodeURIComponent(jobId)}/cancel`,
        { body: { idempotency_key: idempotencyKey } },
      ),
    rollback: (jobId: string, idempotencyKey: string) =>
      request<SystemUpdateJob>(
        'POST',
        `system-updates/jobs/${encodeURIComponent(jobId)}/rollback`,
        { body: { idempotency_key: idempotencyKey } },
      ),
    receipt: (jobId: string) =>
      request<SystemUpdateReceipt>(
        'GET',
        `system-updates/jobs/${encodeURIComponent(jobId)}/receipt`,
      ),
  },
  setupStatus: () => request<SetupStatus>('GET', 'setup/status'),
  updateSecrets: (secrets: SecretsUpdate) =>
    request<{ ok: boolean; configured: Record<string, boolean> }>('POST', 'setup/secrets', {
      body: secrets,
    }),
  completeSetup: () =>
    request<{ ok: boolean; setup_complete: boolean }>('POST', 'setup/complete'),

  // ---- Settings --------------------------------------------------------- //
  getSettings: () => request<SettingsResponse>('GET', 'settings'),
  // The best-effort settings SCHEMA reflector (Round-5 Sett-C): a descriptive
  // description of the Preferences model (types + defaults + element models), used by
  // the generic "Advanced (all settings)" renderer. No values beyond defaults, no secrets.
  getSettingsSchema: () => request<SettingsSchema>('GET', 'settings/schema'),
  putSettings: (patch: Partial<Preferences>) =>
    request<{ ok: boolean; prefs: Preferences }>('PUT', 'settings', { body: patch }),
  // Live-preview a CANDIDATE case-id template without persisting / consuming the
  // sequence (F7). Returns { samples, valid, error }.
  caseIdPreview: (body: { template: string; prefix?: string; seq_start?: number }) =>
    request<CaseIdPreview>('POST', 'settings/case-id/preview', { body }),

  // ---- Models ----------------------------------------------------------- //
  getModels: () => request<ModelsResponse>('GET', 'models'),

  // ---- Connectors + sources -------------------------------------------- //
  listConnectors: () => request<ConnectorsResponse>('GET', 'connectors'),
  getConnector: (sourceType: string) =>
    request<ConnectorManifest>('GET', `connectors/${encodeURIComponent(sourceType)}`),
  testConnector: (draft?: {
    source_id?: string | null;
    source_type?: string | null;
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  }) =>
    request<ConnectionTest>('POST', 'connectors/test', {
      body: draft ?? {},
    }),
  listSources: () => request<SourcesResponse>('GET', 'sources'),
  upsertSource: (source: SourceUpsert) =>
    request<{ ok: boolean; sources: SourceInstance[] }>('POST', 'sources', { body: source }),
  deleteSource: (sourceId: string) =>
    request<{ ok: boolean; sources: SourceInstance[] }>(
      'DELETE',
      `sources/${encodeURIComponent(sourceId)}`,
    ),
  // Set/clear a source's PER-SOURCE secret fields (a webhook token, a Kafka
  // `sasl_password`, an S3 `secret_access_key`/`session_token`, a non-primary ES
  // source's `es_api_key`, …). The source must already exist (upsert first — the
  // endpoint 404s otherwise). Values land in the in-memory secret tier and only the
  // field NAMES are recorded on the SourceInstance (#10); a `null` value clears one.
  setSourceSecrets: (sourceId: string, secrets: Record<string, string | null>) =>
    request<{ ok: boolean; configured_secrets: string[] }>(
      'POST',
      `sources/${encodeURIComponent(sourceId)}/secrets`,
      { body: secrets },
    ),
  // Browse a window of normalised events from one source. `buildQuery` drops any
  // undefined / null / empty params, so blank query/from/to are not sent.
  // BOUNDED, NOT COMPLETE: the server clamps limit to 1..200 with NO pagination, and
  // echoes `limit` + `truncated` so the UI can say "most recent N". `mode` reports a
  // volatile push live-tail ring ("buffer", from/to/query ignored) vs a real search.
  // Every field on every row is source-controlled and UNTRUSTED (#9): plain text only,
  // `_raw` inside a code block, never markup and never fed to a model.
  sourceLogs: (sourceId: string, params?: SourceLogsQuery) =>
    request<SourceLogsResponse>('GET', `sources/${encodeURIComponent(sourceId)}/logs`, {
      query: params as Record<string, unknown> | undefined,
    }),
  // Per-source runtime health for the Log Sources table (GET /api/sources/health):
  // enabled/kind/browse-capability + a PULL source's durable poll position and a
  // PUSH source's live-tail buffer depth, PLUS the additive coverage-observability
  // fields (last_poll_at/last_poll_ok/last_poll_error/events_per_min/silent).
  // Read-only; NEVER returns a secret (#10).
  sourcesHealth: () => request<SourcesHealthResponse>('GET', 'sources/health'),
  // Aggregate ingest-coverage rollup for the "am I seeing everything?" big-number tile
  // (GET /api/sources/coverage; A5.5, the Google SecOps Health-Hub model). Read-only,
  // advisory (#3), NO secrets. Every value is an aggregate count / rate over the REAL
  // configured sources (the Demo-Mode overlay is excluded so the numbers stay honest).
  // Kept typeof-guardable at the call site so a minimal test/mock surface can omit it.
  sourcesCoverage: () => request<SourceCoverage>('GET', 'sources/coverage'),
  // Source-scoped helpers (F9). `analyzeSample` posts a pasted sample record and
  // gets back suggested field mappings + discovered field paths. The sample is
  // sanitized server-side and NEVER persisted to the source config.
  sources: {
    analyzeSample: (sourceId: string, sample: unknown) =>
      request<AnalyzeSampleResult>(
        'POST',
        `sources/${encodeURIComponent(sourceId)}/analyze-sample`,
        { body: { sample } },
      ),
  },

  // ---- Branding (PUBLIC; white-label) ---------------------------------- //
  getBranding: () => request<Branding>('GET', 'branding'),
  putBranding: (branding: Branding) => request<Branding>('PUT', 'branding', { body: branding }),

  // ---- Pervasive customization (Round-2 Wave 7) ------------------------ //
  // Two-store model: ORG defaults on Preferences.customization (admin-only PUT) +
  // PERSONAL prefs in the per-user UserPrefsStore (the 'default' bucket when auth
  // is off). The cascade resolver merges ORG ← USER. The PrefsContext hydrates once
  // from `prefs.effective` on mount. Every terminology/view value is plain data (#9).
  prefs: {
    // The merged ORG←USER cascade for the caller (hydrated once by PrefsContext).
    effective: () => request<EffectivePrefs>('GET', 'prefs/effective'),
    // The caller's raw PERSONAL bucket / a partial patch of it (theme/pins/…). NOT
    // admin-gated — each user edits only their own bucket.
    getUser: () => request<UserPrefs>('GET', 'prefs/user'),
    putUser: (patch: Partial<UserPrefs>) =>
      request<UserPrefs>('PUT', 'prefs/user', { body: patch }),
    // The ORG defaults — readable by any signed-in user (the cascade needs them),
    // writable ADMIN-ONLY (server-gated; may 403).
    getOrg: () => request<OrgCustomization>('GET', 'prefs/org'),
    putOrg: (org: OrgCustomization) =>
      request<OrgCustomization>('PUT', 'prefs/org', { body: org }),
    // Persist ONE table's column state (show/hide/reorder/width). An all-empty body
    // clears the override (reverts to the table's built-in default columns).
    tables: {
      put: (tableId: string, state: ColumnState) =>
        request<{ table_id: string; state: ColumnState }>(
          'PUT',
          `prefs/user/tables/${encodeURIComponent(tableId)}`,
          { body: state },
        ),
    },
  },

  // ---- Saved views (personal + org-shared) ----------------------------- //
  // `list` returns the caller's PERSONAL views UNION the ORG-shared ones (the
  // latter carry `shared:true`). create/update/remove act on PERSONAL views only;
  // `clone` copies any view (org or personal) into the caller's personal set.
  views: {
    list: () => request<{ views: SavedView[]; count: number }>('GET', 'views'),
    create: (view: {
      name: string;
      scope?: string;
      shared?: boolean;
      filters?: Record<string, unknown>;
      sort?: string;
      columns?: string[] | null;
    }) => request<SavedView>('POST', 'views', { body: view }),
    update: (id: string, patch: Partial<Omit<SavedView, 'id'>>) =>
      request<SavedView>('PUT', `views/${encodeURIComponent(id)}`, { body: patch }),
    remove: (id: string) =>
      request<{ ok: boolean; id: string }>('DELETE', `views/${encodeURIComponent(id)}`),
    clone: (id: string) =>
      request<SavedView>('POST', `views/${encodeURIComponent(id)}/clone`),
  },

  // ---- Terminology (ORG label overrides) ------------------------------- //
  // Readable by any signed-in user (the UI `t(key)` helper needs it); PUT is
  // ADMIN-ONLY (server-gated; may 403). All labels are plain data (#9).
  terminology: {
    get: () => request<{ terminology: Terminology }>('GET', 'terminology'),
    put: (terminology: Terminology) =>
      request<{ terminology: Terminology }>('PUT', 'terminology', { body: { terminology } }),
  },

  // ---- Metrics + feedback analytics ------------------------------------ //
  getMetrics: (windowHours = 24) =>
    request<Metrics>('GET', 'metrics', { query: { window_hours: windowHours } }),
  // GET /api/metrics/trends?window_hours= — zero-filled, case-cohort-bucketed trend
  // series (plus durable alert counters) powering the Overview hover trendlines.
  // metrics:view server-side; aggregate counts only (#9); advisory only (#3). Kept
  // typeof-guardable at the call site (mirrors `noiseReduction`/`sourcesCoverage`)
  // so a minimal test/mock surface never has to stub it.
  metricsTrends: (windowHours = 24, signal?: AbortSignal) =>
    request<MetricsTrends>('GET', 'metrics/trends', {
      query: { window_hours: windowHours },
      signal,
    }),
  getFeedbackStats: () => request<FeedbackStats>('GET', 'feedback/stats'),
  getAgentImprovement: (params?: {
    asOf?: string;
    currentDays?: number;
    baselineDays?: number;
  }) =>
    request<AgentImprovementEvidence>('GET', 'metrics/agent-improvement', {
      query: {
        as_of: params?.asOf,
        current_days: params?.currentDays,
        baseline_days: params?.baselineDays,
      },
    }),

  // ---- Noise-Reduction funnel (Round-7 ★) ------------------------------ //
  // GET /api/metrics/noise-reduction?window_hours= — the durable "raw alerts by
  // severity → what the AI reduced it to" funnel (§D contract). metrics:view server-
  // side. Every value is an aggregate count / fixed stage label (no raw log text, #9);
  // the response degrades honestly (`counters.available:false`) while counters warm up.
  // Kept typeof-guardable at the call site (W1.A mounts it as a typeof-guarded fetch),
  // mirroring the AutomationNudge guard so a minimal test/mock surface never calls it.
  noiseReduction: (windowHours = 24) =>
    request<NoiseReduction>('GET', 'metrics/noise-reduction', {
      query: { window_hours: windowHours },
    }),
  // Lazy, bounded detail for the expanded flow. Requires both metrics:view and
  // cases:read because rows carry case ids; alert identities remain one-way refs.
  noiseReductionLineage: (windowHours = 24, limit = 12) =>
    request<NoiseLineage>('GET', 'metrics/noise-reduction/lineage', {
      query: { window_hours: windowHours, limit },
    }),

  // ---- Operator diagnostics (the silent failures, made observable) ----- //
  // GET /api/diagnostics/health — the precedent-corpus / schema-migration /
  // auto-close roll-up. `settings:read` server-side, and deliberately NOT on the
  // public /api/health. Read-only + seed-free: asking never triggers an embedding
  // spend or a projection. Returns SEPARATE `alerts` and `unknowns` lists, so an
  // empty `alerts` is never rendered as a clean bill of health.
  // GET /api/metrics/auto-close-health — the rolling auto-close signal with an
  // explicit `status` (`metrics:view` server-side). Both are typeof-guardable at the
  // call site so a minimal test/mock surface never has to stub them.
  diagnosticsHealth: (windowHours = 24, signal?: AbortSignal) =>
    request<DiagnosticsHealth>('GET', 'diagnostics/health', {
      query: { window_hours: windowHours },
      signal,
    }),
  autoCloseHealth: (windowHours = 24, signal?: AbortSignal) =>
    request<AutoCloseHealth>('GET', 'metrics/auto-close-health', {
      query: { window_hours: windowHours },
      signal,
    }),

  // ---- Analyst rule policies (Detection & Rules) ------------------------ //
  // An operator's explicit, audited, revocable declaration that a detection is benign
  // in THIS estate. Matching clusters close deterministically with NO model call, as
  // `decision_by='analyst_policy'` — the exit from "confirm more cases" for a rule
  // whose alerts carry no per-case evidence to confirm against. `rules:read` to list,
  // `rules:manage` to mutate. Pass `'new'` as the id to let the server mint one.
  listAnalystPolicies: () =>
    request<{
      policies: AnalystRulePolicyConfig[];
      total: number;
      live: number;
      max_policies: number;
    }>('GET', 'rules/analyst-policies'),
  upsertAnalystPolicy: (policyId: string, body: Record<string, unknown>) =>
    request<{ policy: AnalystRulePolicyConfig; created: boolean }>(
      'PUT',
      `rules/analyst-policies/${encodeURIComponent(policyId)}`,
      { body },
    ),
  setAnalystPolicyEnabled: (policyId: string, enabled: boolean) =>
    request<{ policy: AnalystRulePolicyConfig }>(
      'POST',
      `rules/analyst-policies/${encodeURIComponent(policyId)}/enabled`,
      { body: { enabled } },
    ),
  deleteAnalystPolicy: (policyId: string) =>
    request<{ deleted: number; id: string }>(
      'DELETE',
      `rules/analyst-policies/${encodeURIComponent(policyId)}`,
    ),

  // ---- Analytics surfaces ---------------------------------------------- //
  listCases: (query?: Record<string, unknown>) =>
    request<CasesResponse>('GET', 'cases', { query }),
  getCase: (caseId: string) =>
    request<Case>('GET', `cases/${encodeURIComponent(caseId)}`),

  // ---- Case actions (feedback / collaboration / export) ---------------- //
  caseFeedback: (caseId: string, body: CaseFeedbackInput) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/feedback`, { body }),
  caseComment: (caseId: string, body: CaseCommentInput) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/comment`, { body }),
  caseTags: (caseId: string, tags: string[], analyst?: string) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/tags`, {
      body: { tags, analyst },
    }),
  caseAssign: (caseId: string, assignee: string, analyst?: string) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/assign`, {
      body: { assignee, analyst },
    }),
  exportCase: (caseId: string, format: 'json' | 'md' = 'json') =>
    request<CaseExport>('GET', `cases/${encodeURIComponent(caseId)}/export`, {
      query: { format },
    }),
  // Unified analyst action on a case (close / reopen / escalate / confirm_fp /
  // acknowledge / …). Carries optional resolution/assignee/priority/tags. Returns
  // the updated Case. The proxy forwards arbitrary JSON, so this is additive.
  caseActionExec: (caseId: string, input: CaseActionInput) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/action`, { body: input }),
  // Re-run the agent investigation for a case (optionally pinning the model).
  reinvestigateCase: (caseId: string, input?: { model?: string }) =>
    request<Case>('POST', `cases/${encodeURIComponent(caseId)}/reinvestigate`, {
      body: input ?? {},
    }),
  // `model` / `case_id` / `source_id` are only sent when set, so the no-model /
  // no-case / no-source chat behaviour is byte-for-byte unchanged. Existing 1-4
  // arg callers are unaffected; `sourceId` scopes the chat to one source.
  chat: (
    message: string,
    history?: ChatTurn[],
    caseId?: string,
    model?: string,
    sourceId?: string,
    conversationId?: string,
    persistConversation = false,
    idempotencyKey?: string,
  ) =>
    request<ChatResponse>('POST', 'chat', {
      body: {
        message,
        history: history ?? [],
        ...(caseId ? { case_id: caseId } : {}),
        ...(model ? { model } : {}),
        ...(sourceId ? { source_id: sourceId } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(persistConversation ? { persist_conversation: true } : {}),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      },
    }),
  chatConversations: (limit = 50) =>
    request<ChatConversationsResponse>('GET', 'chat/conversations', {
      query: { limit },
    }),
  chatConversation: (conversationId: string) =>
    request<ChatConversation>(
      'GET',
      `chat/conversations/${encodeURIComponent(conversationId)}`,
    ),
  renameChatConversation: (conversationId: string, title: string) =>
    request<ChatConversationSummary>(
      'PATCH',
      `chat/conversations/${encodeURIComponent(conversationId)}`,
      { body: { title } },
    ),
  deleteChatConversation: (conversationId: string) =>
    request<{ ok: boolean; id: string }>(
      'DELETE',
      `chat/conversations/${encodeURIComponent(conversationId)}`,
    ),
  investigate: (body: Record<string, unknown>) =>
    request<Case>('POST', 'investigate', { body }),
  scans: (limit = 50) => request<CasesResponse>('GET', 'scans', { query: { limit } }),
  // How many automated-scan cases are new since `since` (an ISO timestamp the
  // caller persists in localStorage). `since` is only sent when set.
  scanNotifications: (since?: string) =>
    request<ScanNotifications>('GET', 'scans/notifications', {
      query: since ? { since } : undefined,
    }),
  standup: (windowHours?: number) =>
    request<StandupResponse>('GET', 'standup', { query: { window_hours: windowHours } }),
  usageSummary: (windowHours = 24) =>
    request<UsageSummary>('GET', 'usage/summary', { query: { window_hours: windowHours } }),
  pollNow: () => request<Record<string, unknown>>('POST', 'poll'),

  // ---- Knowledge / RAG corpus management ------------------------------- //
  ragStats: () => request<RagStats>('GET', 'rag/stats'),
  ragDocuments: () => request<RagDocumentsResponse>('GET', 'rag/documents'),
  ragDocument: (id: string) =>
    request<RagDocument>('GET', `rag/documents/${encodeURIComponent(id)}`),
  ragImport: (input: RagImportInput) =>
    request<RagImportResult>('POST', 'rag/import', { body: input }),
  ragDeleteDocument: (id: string, force = false) =>
    request<{ document_id: string; deleted: number | boolean }>(
      'DELETE',
      `rag/documents/${encodeURIComponent(id)}`,
      { query: force ? { force: true } : undefined },
    ),
  ragSearch: (q: string, topK?: number) =>
    request<RagSearchResponse>('GET', 'rag/search', { query: { q, top_k: topK } }),

  // ---- Operator memory (durable agent facts) --------------------------- //
  getMemory: (activeOnly?: boolean) =>
    request<MemoryResponse>('GET', 'memory', {
      query: typeof activeOnly === 'boolean' ? { active_only: activeOnly } : undefined,
    }),
  addMemory: (input: MemoryInput) => request<MemoryEntry>('POST', 'memory', { body: input }),
  updateMemory: (id: string, patch: MemoryPatch) =>
    request<MemoryEntry>('PUT', `memory/${encodeURIComponent(id)}`, { body: patch }),
  deleteMemory: (id: string) =>
    request<{ ok: boolean; id: string }>('DELETE', `memory/${encodeURIComponent(id)}`),

  // ---- Case decision rationale (consumed by the Cases surface) --------- //
  caseRationale: (id: string) =>
    request<CaseRationale>('GET', `cases/${encodeURIComponent(id)}/rationale`),

  // ---- Demo mode (Round-2 Wave 5; demo:manage mutations) --------------- //
  // First-class, REVERSIBLE tenant state. `enable` seeds the isolated in-memory
  // demo store (and starts the live-sim tick when mode==='live'); `reset` re-seeds
  // from the same seed; `disable` stops the tick + hard-deletes all demo data by
  // run_id and flips back to 'off' (the real state returns intact). Synthetic data
  // is $0 (deterministic mock LLM). Mutations require demo:manage server-side.
  demo: {
    status: () => request<DemoStatus>('GET', 'demo/status'),
    enable: (config?: DemoConfig) =>
      request<DemoStatus>('POST', 'demo/enable', { body: config ?? {} }),
    incident: (scenarioId?: string) =>
      request<DemoIncidentResult>('POST', 'demo/incident', {
        body: scenarioId ? { scenario_id: scenarioId } : {},
      }),
    reset: () => request<DemoStatus>('POST', 'demo/reset'),
    disable: () => request<DemoStatus>('POST', 'demo/disable'),
  },

  // ---- Approval queue (agent-drafted proposals) ------------------------ //
  // List proposals; `status` is only sent when set (omitting it returns the
  // backend default). The status filter scopes the queue (e.g. 'pending').
  listProposals: (status?: string) =>
    request<ProposalsResponse>('GET', 'proposals', {
      query: status ? { status } : undefined,
    }),
  // Approve a proposal — the ONLY action that materialises its reviewed change.
  // proposals:approve-gated server-side (may 403/404/409/400); normalise the
  // backend { ok, proposal } envelope so both Pending and All views receive the row.
  approveProposal: (id: string) =>
    request<{ ok: boolean; proposal: Proposal }>(
      'POST',
      `proposals/${encodeURIComponent(id)}/approve`,
    ).then((result) => result.proposal),
  // Reject (discard) a drafted proposal. Returns ok / the updated proposal.
  rejectProposal: (id: string) =>
    request<{ ok: boolean; proposal: Proposal }>(
      'POST',
      `proposals/${encodeURIComponent(id)}/reject`,
    ).then((result) => result.proposal),

  // ---- Round-5 W0-F F2 scaffolds (Rules G6 / Custom-Dash G7 / preview) --- //
  // These are typed CLIENT scaffolds the feature waves flesh out. Each hits an
  // additive backend route (the nginx `/api` proxy forwards arbitrary JSON, so no
  // proxy change is needed). Kept in their OWN namespaces so later waves append to
  // them without touching the rest of this module.

  // ---- Detection-rule catalog (G6) ------------------------------------- //
  // The rule catalog rides `Preferences.rule_catalog` (a `RuleDefinition[]`) via
  // `PUT /api/settings` today; these are the dedicated read/write scaffolds the
  // Rules wave builds on. Rule `name`/`match.field`/`match.value` are operator-
  // authored + LOG-adjacent → render as plain text (#9); `model_override` never
  // echoes a key (#10). Editors are config-writers — they NEVER touch `decide()`.
  rules: {
    list: () => request<RulesResponse>('GET', 'rules'),
    // NB: there is NO `PUT /api/rules`. The catalog is saved through the deep-merge
    // `PUT /api/settings` (see `soc/rules/api.saveRuleCatalog`) and per-family edits
    // through the `/rules/{family}/…` routes below — never a whole-list PUT.

    // ---- Lifecycle: version ledger + rollback (G6 R5) ------------------- //
    // The immutable per-rule version history + one-click rollback. Rollback rides
    // the SAME deep-merge config-writer path a normal edit uses (never a full-doc
    // replace), then APPENDS a `rollback` version — history is append-only (#2).
    // NEVER calls `decide()` (#3). `kind` is detection|correlation|case_automation.
    versions: (kind: RuleKind, ruleId: string) =>
      request<RuleVersionsResponse>(
        'GET',
        `rules/${encodeURIComponent(kind)}/${encodeURIComponent(ruleId)}/versions`,
      ),
    rollback: (kind: RuleKind, ruleId: string, versionId: string) =>
      request<RuleRollbackResult>(
        'POST',
        `rules/${encodeURIComponent(kind)}/${encodeURIComponent(ruleId)}/rollback/${encodeURIComponent(
          versionId,
        )}`,
      ),

    // ---- Lifecycle: read-only rule PREVIEW over recent data (G6 R5) ----- //
    // How many recent events WOULD this predicate match? Reads through the scoped,
    // read-only, hard-capped scatter-gather (#1) and evaluates the pure predicate
    // in-process. ZERO gateway calls → ZERO UsageDoc (#6); NEVER calls `decide()`,
    // NEVER creates a case, NEVER escalates (#3).
    preview: (input: RulePreviewInput) =>
      request<RulePreviewResult>('POST', 'rules/preview', { body: input }),
  },

  // ---- Custom dashboards (G7) ------------------------------------------ //
  // Per-user saved dashboards (persisted under `UserPrefs.dashboards`; the
  // `DashboardStore` is zero-migration KV). Every dashboard/widget name is
  // UNTRUSTED → plain text / SVG `<text>` (#9); the widget TYPE is server-
  // allowlisted on write. Layout is presentation-only (advisory, never feeds #3).
  dashboards: {
    list: () => request<DashboardsResponse>('GET', 'dashboards'),
    create: (dashboard: DashboardLayout) =>
      request<DashboardLayout>('POST', 'dashboards', { body: dashboard }),
    // Debounced ~500ms client-side (CD5): rapid successive edits to the SAME id
    // coalesce into ONE trailing PUT so a drag/resize settle persists exactly once.
    // The returned promise still resolves with the stored dashboard, so callers that
    // commit the server echo (the builder) keep working. Pass `{ immediate: true }` for
    // an EXPLICIT Save so the primary action fires now (flushing any pending settle for
    // this id) instead of eating the coalescing delay.
    update: (id: string, dashboard: DashboardLayout, opts?: { immediate?: boolean }) =>
      opts?.immediate
        ? immediateDashboardUpdate(id, dashboard)
        : debouncedDashboardUpdate(id, dashboard),
    remove: (id: string) =>
      request<{ ok: boolean; id: string }>(
        'DELETE',
        `dashboards/${encodeURIComponent(id)}`,
      ),
    // Copy a role-default (or any) dashboard into the caller's personal set for
    // customization (clone-to-customize on first edit).
    clone: (id: string) =>
      request<DashboardLayout>('POST', `dashboards/${encodeURIComponent(id)}/clone`),
  },

  // ---- Deterministic decision preview (F4) ----------------------------- //
  // A read-only what-if over the pure `decide()`. It NEVER bills an LLM (#6),
  // never writes a case, and never re-implements the decision — it just shows what
  // the deterministic policy WOULD do for a given (verdict, confidence, risk).
  triage: {
    previewDecision: (input: PreviewDecisionInput) =>
      request<PreviewDecisionResult>('POST', 'triage/preview-decision', { body: input }),
  },

  // ---- Per-feature typed config clients (F5) --------------------------- //
  // Mirror `routes_tuning`'s `GET/PUT /tuning/config` for the other Round-4 engine
  // blocks. GET returns `{config}`; PUT deep-merges the changed keys server-side
  // (audited, RBAC-gated, #2) and returns `{ok, config}`. All blocks default OFF;
  // every one is ADVISORY and NEVER feeds the deterministic decision (#3).
  tuning: {
    // `routes_tuning.py` → GET/PUT /api/tuning/config (Preferences.threshold_tuning).
    // The nightly, deterministic FP auto-tuner — a config-writer that NEVER calls
    // `decide()`/risk/signature; it only PROPOSES bounded threshold moves (#3).
    getConfig: () => request<{ config: ThresholdTuningConfig }>('GET', 'tuning/config'),
    putConfig: (config: Partial<ThresholdTuningConfig>) =>
      request<{ ok: boolean; config: ThresholdTuningConfig }>('PUT', 'tuning/config', {
        body: config,
      }),
  },
  baseline: {
    getConfig: () => request<{ config: BaselineConfig }>('GET', 'baseline/config'),
    putConfig: (config: Partial<BaselineConfig>) =>
      request<{ ok: boolean; config: BaselineConfig }>('PUT', 'baseline/config', {
        body: config,
      }),
  },
  campaign: {
    // The backend route is PLURAL (`routes_campaigns.py` → GET/PUT /api/campaigns/config).
    getConfig: () => request<{ config: CampaignConfig }>('GET', 'campaigns/config'),
    putConfig: (config: Partial<CampaignConfig>) =>
      request<{ ok: boolean; config: CampaignConfig }>('PUT', 'campaigns/config', {
        body: config,
      }),
  },
  batch: {
    getConfig: () => request<{ config: BatchConfig }>('GET', 'batch/config'),
    putConfig: (config: Partial<BatchConfig>) =>
      request<{ ok: boolean; config: BatchConfig }>('PUT', 'batch/config', {
        body: config,
      }),
  },
};

export type Api = typeof api;
