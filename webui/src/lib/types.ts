/**
 * TypeScript mirrors of the backend data contracts (subset the UI consumes).
 *
 * These mirror, but do not import from, the Python Pydantic models in
 * `backend/app/`. Keep them additive-compatible: the backend forwards arbitrary
 * JSON so unknown fields are harmless. See:
 *   - `backend/app/connectors/base.py`  (ConnectorManifest / AuthField / ConnectionTest)
 *   - `backend/app/config.py`           (Preferences / SourceInstance)
 *   - `backend/app/api/routes.py`       (endpoint shapes)
 */

// --------------------------------------------------------------------------- //
// Auth (optional; the gate is a no-op when `enabled` is false).
// --------------------------------------------------------------------------- //
/** The six SOC operator roles (Wave 1 RBAC). Mirrors backend `UserRole`. */
export type UserRole =
  | 'super_admin'
  | 'soc_manager'
  | 'analyst_tier2'
  | 'analyst_tier1'
  | 'responder'
  | 'auditor';

export interface AuthUser {
  username: string;
  role?: UserRole | string;
  must_change_password?: boolean;
  /** Wave 2 (MFA): whether this account has a second factor enrolled. */
  mfa_enabled?: boolean;
  // ---- Round-2 Wave 2: self-service profile fields (all additive, defaulted). //
  // Every value here is operator/user-entered → render as PLAIN text (#9). The
  // backend `User.public()` projection NEVER includes password_hash/mfa_secret.
  /** Friendly name shown instead of the username (or ""). */
  display_name?: string;
  /** A short handle / nickname (or ""). */
  alias?: string;
  /** A bounded `data:image/(png|webp|jpeg)` URL for the user avatar (or ""). */
  avatar?: string;
  /** A secondary contact email (or ""). */
  alt_email?: string;
  /** IANA timezone id the user prefers (e.g. "Europe/London"), or "". */
  timezone?: string;
  /** BCP-47 locale tag (e.g. "en-US"), or "". */
  locale?: string;
}

/** GET /api/auth/me — describes whether auth is on and the session state. */
export interface AuthMe {
  authenticated: boolean;
  auth_enabled: boolean;
  user: AuthUser | null;
}

// --------------------------------------------------------------------------- //
// Account / profile self-service (Round-2 Wave 2) — GET/PUT /api/account/me.
// --------------------------------------------------------------------------- //
/**
 * GET /api/account/me — the signed-in user's own profile.
 *
 * `username` + `role` are read-only identity; the rest are self-editable. Every
 * value is user-entered → render as PLAIN text (#9). Secrets are NEVER present
 * (the backend `public()` projection excludes password_hash/mfa_secret/etc).
 *
 * `env_managed:true` means the principal is the env single-admin (not a stored
 * KV user): the profile is a read-only stub and PUT is rejected server-side.
 */
export interface AccountProfile {
  username: string;
  role?: UserRole | string;
  /** True for the env-provisioned single admin (no editable stored profile). */
  env_managed?: boolean;
  /** Whether this account has a TOTP second factor enrolled. */
  mfa_enabled?: boolean;
  display_name?: string;
  alias?: string;
  /** A bounded `data:image/...` avatar URL, or "". */
  avatar?: string;
  alt_email?: string;
  timezone?: string;
  locale?: string;
  created_at?: string;
  last_login_at?: string | null;
  [key: string]: unknown;
}

/**
 * Body for PUT /api/account/me — all fields optional (partial update). Omitted
 * fields are left untouched; an empty string clears a value.
 */
export interface AccountProfileBody {
  display_name?: string;
  alias?: string;
  alt_email?: string;
  timezone?: string;
  locale?: string;
}

// --------------------------------------------------------------------------- //
// Sessions & access policy (Round-2 Wave 3) — /api/sessions, /api/admin/sessions,
// /api/auth/refresh, /api/auth/reauth, /api/account/activity, prefs.session_policy.
//
// Every session field is request-derived (User-Agent / IP / geo) and therefore
// UNTRUSTED → render `ua_*`, `ip`, `ip_city`, `ip_country`, `location` as PLAIN
// text (#9). The backend NEVER returns the JWT, the refresh token, or any hash —
// only non-secret session metadata (#10).
// --------------------------------------------------------------------------- //
/**
 * One registered session (GET /api/sessions own; GET /api/admin/sessions all).
 *
 * `current:true` marks the session the caller is using right now ("This device").
 * All UA/IP/geo values are request-derived → render PLAIN, never as markup/links.
 */
export interface Session {
  /** Opaque 128-bit session id (the `sid` JWT claim). */
  sid: string;
  /** The owning account (admin console shows it; own listing omits/echoes it). */
  username?: string;
  /** True for the session the request was made from ("This device"). */
  current?: boolean;
  /** Whether the session has been revoked (admin listings may include these). */
  revoked?: boolean;
  /** ISO timestamps for the session lifecycle (all optional / best-effort). */
  created_at?: string;
  last_active_at?: string | null;
  last_authn_at?: string | null;
  absolute_expiry_at?: string | null;
  idle_expiry_at?: string | null;
  revoked_at?: string | null;
  /** Who revoked it (admin/self/system) + why — plain text. */
  revoked_by?: string | null;
  revoke_reason?: string | null;
  /** Request-derived network + geo (UNTRUSTED — render PLAIN). */
  ip?: string | null;
  ip_city?: string | null;
  ip_country?: string | null;
  /** Pre-composed "City, Country" label when the backend supplies one. */
  location?: string | null;
  /** Parsed User-Agent fields + the raw header (UNTRUSTED — render PLAIN). */
  ua_raw?: string | null;
  ua_browser?: string | null;
  ua_os?: string | null;
  /** The client kind (e.g. "web"/"api"/"cli") + the MFA method used at sign-in. */
  client_type?: string | null;
  mfa_method?: string | null;
  [key: string]: unknown;
}

/** GET /api/sessions and GET /api/admin/sessions — the session listing. */
export interface SessionsResponse {
  sessions: Session[];
  count?: number;
  [key: string]: unknown;
}

/**
 * Preferences.session_policy — the token/session lifecycle policy (admin-editable
 * under Settings > Security). All durations are in SECONDS. Defaulted + additive:
 * an absent block uses the backend's generous defaults (so existing sessions never
 * expire mid-run). Booleans gate the optional new-device / terminate notifications.
 */
export interface SessionPolicy {
  /** Short-lived access-token lifetime (seconds). */
  access_ttl?: number;
  /** Idle window — a session is revoked after this long without activity (seconds). */
  idle_timeout?: number;
  /** Hard cap on a session's total lifetime regardless of activity (seconds). */
  absolute_lifetime?: number;
  /** Refresh-token lifetime (seconds). */
  refresh_ttl?: number;
  /** Step-up "sudo" window — sensitive actions re-prompt after this long (seconds). */
  sudo_reauth_window?: number;
  /** Email the user when a session is created from a new device/location. */
  notify_on_new_device?: boolean;
  /** Email the user when one of their sessions is terminated. */
  notify_on_terminate?: boolean;
  [key: string]: unknown;
}

/**
 * One recent audit event for the signed-in user (GET /api/account/activity).
 * Every value is system/operator-derived → render PLAIN. The shape is loose (the
 * backend forwards audit docs verbatim); the well-known fields are documented.
 */
export interface ActivityEvent {
  /** Audit doc id (react key). */
  id?: string;
  /** When it happened (ISO). */
  ts?: string;
  /** The action type (e.g. "AUTH_EVENT" / "USER_MGMT" / "SESSION") — plain text. */
  action?: string;
  /** A short human-readable summary of the event (UNTRUSTED — plain text). */
  detail?: string;
  /** The actor (usually the user themselves) — plain text. */
  actor?: string;
  /** Request-derived network context for the event (UNTRUSTED — plain text). */
  ip?: string | null;
  ua_browser?: string | null;
  ua_os?: string | null;
  location?: string | null;
  [key: string]: unknown;
}

/** GET /api/account/activity — the user's recent audit trail. */
export interface ActivityResponse {
  events: ActivityEvent[];
  count?: number;
  [key: string]: unknown;
}

/**
 * POST /api/auth/refresh / POST /api/auth/reauth — the step-up / rotation result.
 * The new session cookie is set HttpOnly server-side; the body carries only
 * non-secret confirmation (no token is returned to JS).
 */
export interface ReauthResult {
  ok: boolean;
  /** Echoed user (post-reauth identity), when present. */
  user?: AuthUser;
  [key: string]: unknown;
}

/**
 * POST /api/auth/login (200). Two shapes (Wave 2):
 *   - normal:   { token, user }
 *   - MFA step: { requires_mfa:true, pending_token } (NO session yet — phase 2 at
 *               /api/auth/mfa/verify). 401s surface as an ApiError with `detail`.
 */
export interface LoginResult {
  token?: string;
  user?: AuthUser;
  /** Present (true) when the account needs a second factor before a session. */
  requires_mfa?: boolean;
  /**
   * Present (true) when MFA is MANDATED for the account but not yet ENROLLED: no
   * code challenge is possible, so the client must complete enrollment at
   * /api/auth/mfa/enroll-setup + /enroll-confirm using the same `pending_token`
   * (confirm mints the full session). Branch on this BEFORE `requires_mfa`.
   */
  mfa_enrollment_required?: boolean;
  /** A short-lived half-auth token to exchange at /api/auth/mfa/verify. */
  pending_token?: string;
}

// --------------------------------------------------------------------------- //
// MFA (TOTP) — Wave 2 / F3.
// --------------------------------------------------------------------------- //
/** POST /api/auth/mfa/setup — the enrollment payload (shown ONCE). */
export interface MfaSetupResult {
  /** The Base32 TOTP secret (also encoded in `otpauth_uri`) — for manual entry. */
  secret: string;
  /** The `otpauth://totp/...` URI to render as a QR for authenticator apps. */
  otpauth_uri: string;
  /** 10 single-use recovery codes — show + let the operator save them now. */
  recovery_codes: string[];
}

// --------------------------------------------------------------------------- //
// SSO (OIDC) — Wave 2 / F4.
// --------------------------------------------------------------------------- //
/** One enabled SSO provider for the login screen (GET /api/auth/sso/providers). */
export interface SsoProviderPublic {
  id: string;
  type: 'google' | 'microsoft' | 'generic' | string;
  display_name: string;
}

export interface SsoProvidersResponse {
  providers: SsoProviderPublic[];
}

/** GET /api/auth/sso/authorize — the IdP redirect URL. */
export interface SsoAuthorizeResult {
  auth_url: string;
}

/** A configured SSO provider (the admin editor; mirrors backend `SSOProvider`). */
export interface SsoProviderConfig {
  id: string;
  type: 'google' | 'microsoft' | 'generic';
  display_name?: string;
  enabled?: boolean;
  client_id?: string;
  tenant?: string | null;
  discovery_url?: string | null;
  scopes?: string;
  allowed_domains?: string[];
  allowed_tenants?: string[];
  group_claim?: string | null;
  group_role_map?: Record<string, string>;
  auto_create_users?: boolean;
  default_role?: string;
}

/** Preferences.sso block (admin editor). */
export interface SsoConfig {
  enabled?: boolean;
  providers?: SsoProviderConfig[];
}

/** Preferences.mfa block (admin tuning; per-user enrollment is self-service). */
export interface MfaConfig {
  issuer?: string;
  digits?: number;
  period?: number;
  enforce_for_roles?: string[];
}

/** A managed multi-user account (GET/POST/PUT /api/users). Never carries a hash. */
export interface User {
  username: string;
  role: UserRole | string;
  active: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
  /** Whether the user has ENROLLED a TOTP factor (self-service; admin can only force-disable). */
  mfa_enabled?: boolean;
  /**
   * The admin-set MFA MANDATE (required ≠ enrolled — no secret is minted). A mandated
   * but unenrolled user is walked through enrollment at their next sign-in.
   */
  mfa_required?: boolean;
  /** Full/display name ("" when unset). Operator-entered → render as PLAIN text (#9). */
  display_name?: string;
  /** Contact email ("" when unset). Operator-entered → render as PLAIN text (#9). */
  email?: string;
  /** Contact/mobile number ("" when unset). Operator-entered → render as PLAIN text (#9). */
  phone?: string;
  /**
   * Free-form per-user bag; the custom-role assignment rides here under
   * `custom_roles` (names only — see PUT /api/users/{username}/roles).
   */
  prefs?: { custom_roles?: string[] } & Record<string, unknown>;
}

/**
 * POST /api/users — the create-user request (users:manage). Everything beyond
 * username/password/role is additive; the SERVER stays authoritative for validation
 * (password ≥ 8, base role must be a built-in, email/phone sanity checks, and
 * `custom_roles` must name EXISTING custom roles).
 */
export interface UserCreateOptions {
  username: string;
  password: string;
  /** Base role — one of the six built-ins (backend default: analyst_tier1). */
  role?: string;
  /** Full name (≤200 chars; plain text, #9). */
  display_name?: string;
  /** Contact email (≤200 chars; must contain "@", no whitespace — server-validated). */
  email?: string;
  /** Mobile number (charset "+ 0-9 space - ( )" — server-validated). */
  phone?: string;
  /** Mandate MFA: they must set up an authenticator at their next sign-in. */
  mfa_required?: boolean;
  /** EXISTING custom roles to attach at creation (persisted like the assign endpoint). */
  custom_roles?: string[];
}

export interface UsersResponse {
  users: User[];
}

/** GET /api/roles — the role → resource → [actions] permission matrix for the UI. */
export interface RolesResponse {
  roles: string[];
  default_role: string;
  rbac_enabled: boolean;
  matrix: Record<string, Record<string, string[]>>;
}

// --------------------------------------------------------------------------- //
// Agent personas + operator-managed playbooks/runbooks.
// --------------------------------------------------------------------------- //
/** One specialist persona the router can specialise the investigator into. */
export interface AgentPersona {
  id: string;
  label: string;
  specialization: string;
  focus_tools: string[];
  keywords: string[];
}

export interface PersonasResponse {
  enabled: boolean;
  personas: AgentPersona[];
}

/** The match criteria that select a playbook for a cluster. */
export interface PlaybookMatch {
  rule_ids: string[];
  entity_types: string[];
  mitre: string[];
  min_event_count: number | null;
  any_tags: string[];
}

/** One plain-text runbook/playbook (mirrors the backend loader shape). */
export interface Playbook {
  id: string;
  name: string;
  version: number;
  description: string;
  priority: number;
  match: PlaybookMatch;
  suggested_tools: string[];
  rag_queries: string[];
  escalate_if: string;
  suggested_verdict_bias: string;
  /** Packaged reference procedures are readable but immutable. */
  source_type: 'bundled' | 'operator';
  protected: boolean;
  editable: boolean;
  file_name: string;
  /** Operator catalog revision used for optimistic concurrency. */
  revision: number;
  /** Bundled package data or durable application StateStore data. */
  storage: 'package' | 'state';
  created_at?: string;
  updated_at?: string;
  created_by?: string;
  updated_by?: string;
}

/** One opened Markdown document. Render as plain text; never as raw HTML. */
export interface PlaybookDetail extends Playbook {
  content: string;
  body: string;
}

export interface PlaybooksResponse {
  enabled: boolean;
  count: number;
  playbooks: Playbook[];
}

export interface PlaybookMutationResponse {
  ok: boolean;
  playbook: Playbook;
  reload: {
    loaded: number;
    skipped: { file: string; reason: string }[];
    ids: string[];
  };
}

/** Aggregate deterministic playbook coverage over the stored case population. */
export interface PlaybookCoverageResponse {
  scanned_cases: number;
  covered_cases: number;
  uncovered_cases: number;
  coverage_percent: number | null;
  scan_limit: number;
  truncated: boolean;
  selected_playbooks: Array<{ playbook_id: string; case_count: number }>;
  unmatched_rule_families: Array<{ rule_id: string; case_count: number }>;
}

export interface PlaybookDryRunInput {
  rule_ids: string[];
  entity_type: EntityTypeFull;
  event_count: number;
}

export interface PlaybookDryRunCheck {
  criterion: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  reason: string;
}

export interface PlaybookDryRunCandidate {
  playbook_id: string;
  playbook_name: string;
  priority: number;
  version: number;
  matched: boolean;
  checks: PlaybookDryRunCheck[];
  failed_criteria: string[];
}

/** Pure, read-only explanation of the registry's exact selection predicate. */
export interface PlaybookDryRunResponse {
  selected_playbook_id: string | null;
  selection_reason: string;
  matched_count: number;
  candidate_count: number;
  candidates: PlaybookDryRunCandidate[];
}

export interface SchedulerWorkerHealth {
  enabled: boolean;
  gated: boolean;
  running: boolean;
  cadence: string;
  last_attempt_at: string;
  last_success_at: string;
  last_error: string;
  processed: number;
}

export interface SchedulerHealthResponse {
  scheduler_runtime_running: boolean;
  workers: Record<string, SchedulerWorkerHealth>;
}

/**
 * One trusted investigation-reference runbook. Runbooks are retrieval knowledge,
 * not executable procedures: a match may inform an investigation, but it never
 * changes deterministic case authority.
 */
export interface Runbook {
  id: string;
  title: string;
  summary: string;
  persona: string;
  applies_to_rules: string[];
  applies_to_techniques: string[];
  applies_to_entities: string[];
  keywords: string[];
  source_type: 'bundled' | 'operator';
  /** Packaged reference runbooks are protected; operator runbooks are editable. */
  protected: boolean;
  editable: boolean;
  /** Opaque optimistic-concurrency token supplied back on update/delete. */
  revision: string | number;
  created_at: string | null;
  updated_at: string | null;
  /** Authoritative projection state for the runbook's RAG document. */
  index_status: string;
  indexed_revision: string | number | null;
  last_indexed_at: string | null;
  index_error: string | null;
}

/** One opened Markdown document. Render as plain text; never as raw HTML. */
export interface RunbookDetail extends Runbook {
  content: string;
  body: string;
}

/** Backend-owned Runbook authoring contract exposed to Console clients. */
export interface RunbookAuthoringStandard {
  version: number;
  body_max_characters: number;
  retrieval_descriptor_max_characters: number;
  document_max_bytes: number;
  section_min_characters: number;
  reserved_ids: string[];
  character_count: string;
  metadata_limits: {
    title_max_characters: number;
    summary_max_characters: number;
    persona_max_characters: number;
    list_max_items: number;
    list_item_max_characters: number;
  };
  required_manifest_fields: string[];
  optional_manifest_fields: string[];
  required_body_labels: string[];
  optional_body_labels: string[];
  investigation_steps: string;
  allowed_metadata_format: string;
  allowed_body_format: string;
  prohibited_metadata_format: string[];
  prohibited_body_format: string[];
}

export interface RunbooksResponse {
  enabled: boolean;
  /** Whether runbook knowledge is currently eligible for RAG retrieval. */
  retrieval_enabled: boolean;
  /** Missing only while interoperating with a legacy backend during a rolling upgrade. */
  authoring_standard?: RunbookAuthoringStandard;
  count: number;
  runbooks: Runbook[];
}

/** Result of reconciling one or more runbooks into the RAG corpus. */
export interface RunbookIndexResult {
  ok: boolean;
  indexed: number;
  deleted: number;
  failed: number;
  errors: Array<string | { id?: string; error: string }>;
}

export interface RunbookMutationResponse {
  ok: boolean;
  runbook: Runbook;
  index: RunbookIndexResult;
}

export interface RunbookDeleteResponse {
  ok: boolean;
  id: string;
  index: RunbookIndexResult;
}

// --------------------------------------------------------------------------- //
// Connectors (the wizard renders forms dynamically from these).
// --------------------------------------------------------------------------- //
export type AuthFieldType =
  | 'string'
  | 'password'
  | 'number'
  | 'bool'
  | 'select'
  | 'textarea'
  | 'multiselect';

/** One input the wizard renders for a connector (mirrors `AuthField`). */
export interface AuthField {
  key: string;
  label: string;
  type: AuthFieldType;
  required?: boolean;
  secret?: boolean;
  default?: unknown;
  options?: string[] | null;
  help?: string;
  placeholder?: string;
  group?: string;
  /**
   * Contextual help (F9). All operator/author-controlled (trusted) but rendered as
   * plain text / inside a code block, never as markup. `help_link` is a "learn more"
   * URL; `help_code` is an example snippet shown in `help_code_language`.
   */
  help_link?: string;
  help_code?: string;
  help_code_language?: string;
}

export type ConnectorCategory =
  | 'siem'
  | 'edr_xdr'
  | 'transport'
  | 'queue'
  | 'object_store'
  | 'file'
  | string;

/** Self-description of a connector (mirrors `ConnectorManifest`). */
export interface ConnectorManifest {
  source_type: string;
  display_name: string;
  category: ConnectorCategory;
  version?: string;
  description?: string;
  ingest_modes?: string[];
  query_language?: string;
  capabilities?: string[];
  auth_fields?: AuthField[];
  config_fields?: AuthField[];
  docs_url?: string | null;
  requires_pip?: string[];
  /**
   * A concise "how to add this source" guide (F9), authored per connector. Markdown-
   * ish plain text (trusted) — rendered as plain text, never as live markup.
   */
  setup_help?: string;
}

export interface ConnectorsResponse {
  connectors: ConnectorManifest[];
}

/** Result of a 'Test connection' click (mirrors `ConnectionTest`). */
export interface ConnectionTest {
  ok: boolean;
  message?: string;
  sample_count?: number | null;
  detail?: Record<string, unknown>;
  /**
   * The access tier the probe verified: `read_only` (a correctly-scoped read-only
   * key) or `full` (cluster-monitor present). Absent for connectors that don't
   * distinguish.
   */
  mode?: 'read_only' | 'full' | string | null;
  /** Whether the tested key carries the `cluster:monitor` privilege. */
  cluster_monitor?: boolean | null;
}

// --------------------------------------------------------------------------- //
// Sources (configured connector instances; mirrors `SourceInstance`).
// --------------------------------------------------------------------------- //
/**
 * One index/data-view pattern a source reads, classified by the kind of records
 * it holds. The backend uses `role` to decide whether a pattern carries raw
 * `events` or pre-triaged `alerts`. `role` is open-ended (the backend validates),
 * but the two canonical values are enumerated for editor help.
 */
export interface IndexPattern {
  pattern: string;
  /**
   * The kind of records this feed carries. `alerts` = pre-triaged detections, every
   * one auto-investigated; `events` = raw logs, correlated then allowlist-gated;
   * `ignore` (Wave 6) = the feed is dropped (skipped at ingest entirely).
   */
  role: 'events' | 'alerts' | 'ignore' | string;
  /**
   * Per-pattern (sub-source) Auto-Correlate toggle (F6, legacy). Defaults TRUE so
   * today's behaviour is byte-identical. Historically drove BOTH correlation and
   * auto-forward; Wave 6 splits it into `correlate` + `auto_investigate` but keeps
   * this key in sync so the current backend preserves identical behaviour.
   */
  auto_correlate?: boolean;

  // --- Wave 6 per-feed customization (all optional; back-compat preserved) --- //
  /**
   * Whether this feed's events are correlated into clusters. Defaults TRUE; the
   * Wave-6 split of the overloaded `auto_correlate`.
   */
  correlate?: boolean;
  /**
   * Stable feed id. Absent on legacy/bare-string entries → the backend derives
   * `slug(pattern)`. Lets two feeds share a base pattern but keep distinct cursors.
   */
  id?: string;
  /** Operator-facing label for the feed (cosmetic; falls back to the pattern). */
  label?: string;
  /** Whether the feed is polled at all. Defaults TRUE. */
  enabled?: boolean;
  /**
   * A connector-native filter (e.g. an ES query_string) applied to this feed only.
   * Operator-authored + TRUSTED — never interpolated into an LLM prompt.
   */
  query?: string | null;
  /**
   * Per-feed field-mapping override. Merged over the source-level mapping
   * (`{...source.field_mappings_extra, ...feed.field_mapping}`).
   */
  field_mapping?: FieldMappingsExtra;
  /** Per-feed message-field override; falls back to the source-level message field. */
  message_field?: string | null;
  /**
   * OCSF severity_id floor (1-6). Events below it still register as a candidate +
   * live-tail (#4 — never dropped) but do NOT auto-forward. `null`/absent = no floor.
   */
  severity_floor?: number | null;
  /**
   * Split out of the overloaded `auto_correlate`: whether clusters from this feed
   * are auto-forwarded to AI investigation. `null`/absent → the role-derived default
   * (`true` for alerts, `auto_correlate` for events).
   */
  auto_investigate?: boolean | null;
  /** Per-feed poll interval override (seconds). `null`/absent = inherit the source. */
  poll_interval_seconds?: number | null;
}

/**
 * Per-source field-mapping overrides (F9). Each is the source-native field whose
 * value maps onto the canonical entity / message / severity / rule column. Blank
 * falls back to the global `Preferences` mapping.
 */
export interface FieldMappingsExtra {
  source_ip_field?: string;
  user_field?: string;
  host_field?: string;
  message_field?: string;
  severity_field?: string;
  rule_field?: string;
}

/**
 * How a source derives the primary entity for a cluster. `auto` lets the backend
 * pick from the mapped fields; the rest pin a specific dimension. Open-ended (the
 * backend accepts arbitrary strings) but the canonical values are enumerated.
 */
export type EntityStrategy = 'auto' | 'ip' | 'host' | 'user' | 'rule';

/**
 * The additive, optional `config` fields a source may carry (mirrors the backend
 * `SourceInstance.config` additions). `SourceInstance.config` stays a loose
 * `Record<string, unknown>` so unknown keys round-trip unharmed; this type
 * documents the well-known additions and can be intersected onto a config value
 * (e.g. `cfg as SourceConfigExtras`) when a surface reads them.
 */
export interface SourceConfigExtras {
  /**
   * Per-source feeds: index/data-view patterns + their role (events / alerts /
   * ignore) and per-feed Wave-6 customization. Kept under the legacy wire key
   * `index_patterns` so old configs round-trip unchanged.
   */
  index_patterns?: IndexPattern[];
  /** How this source picks the cluster's primary entity. */
  entity_strategy?: EntityStrategy | string;
  /** The field whose value is shown as the human-readable message column. */
  message_field?: string;
  /**
   * Per-source Auto-Correlate toggle (F6). Defaults TRUE. When false, this source's
   * clusters are NOT auto-forwarded to AI investigation (manual triage only) — they
   * still correlate into clusters.
   */
  auto_correlate?: boolean;
  /** Per-source field-mapping overrides (F9); falls back to global Preferences. */
  field_mappings_extra?: FieldMappingsExtra;
  /**
   * Per-source override of the case-evidence projection (the raw-record paths the
   * agent sees and can search for). Omitted inherits the global
   * `Preferences.evidence_fields`; `[]` pins the narrow identity-only projection.
   */
  evidence_fields?: string[];
  /** Per-source override of the per-event evidence size budget, in characters. */
  evidence_max_chars_per_event?: number;
  [key: string]: unknown;
}

export interface SourceInstance {
  id: string;
  source_type: string;
  display_name?: string;
  enabled?: boolean;
  ingest_mode?: string;
  /** Read-only connector category, including active Demo Mode overlays. */
  category?: string;
  /** Source-native transport/format hints returned by compatible backends. */
  protocol?: string;
  format?: string;
  /**
   * Server-authoritative browse capability (GET /api/sources). It is the SAME
   * `_source_can_browse` predicate the browse routes gate on — never re-derive it
   * client-side from connector manifests or health. Optional only so an older
   * backend degrades to "unknown".
   */
  can_browse?: boolean;
  is_primary?: boolean;
  /**
   * Loose connector config. Unknown keys round-trip unharmed; the well-known
   * additive keys are documented by `SourceConfigExtras` (`index_patterns`,
   * `entity_strategy`, `message_field`).
   */
  config?: Record<string, unknown> & Partial<SourceConfigExtras>;
  configured_secrets?: string[];
  /**
   * The operator-DECLARED ceiling of this source's NATIVE severity ladder — one number
   * that describes any ladder (0-10, 0-16, 0-1000). Every severity surface projects a raw
   * source severity through `min(100, max(0, raw / severity_scale_max * 100))`.
   *
   * `null`/absent means UNDECLARED, which projects through the IDENTITY (ceiling 100, the
   * canonical OCSF `severity_score` scale). Declare it for any source that does NOT rate
   * severity on 0-100, or its ratings read ~10x too low on the severity chip, in the
   * Noise-Reduction funnel and against a feed's `severity_floor`.
   */
  severity_scale_max?: number | null;
  created_at?: string;
  updated_at?: string;
  /** Read-only synthetic overlay row surfaced only while Demo Mode is active. */
  demo?: boolean;
}

export interface SourcesResponse {
  sources: SourceInstance[];
}

/**
 * One row of GET /api/sources/health (Round-4). Read-only, per-source runtime
 * health for the Log Sources table — NEVER carries a secret value (#10). A PULL
 * source reports its durable poll position (`last_poll_millis`, 0 = never polled);
 * a PUSH source reports its in-memory live-tail `buffer_depth`. `kind` distinguishes
 * a pull connector from a push receiver.
 */
export interface SourceHealthRow {
  source_id: string;
  source_name: string;
  source_type: string;
  enabled: boolean;
  is_primary: boolean;
  ingest_mode: string;
  kind: 'push' | 'pull' | 'unknown' | string;
  can_browse: boolean;
  /** Source-native transport and record format (demo/compatible backends only). */
  protocol?: string;
  format?: string;
  /** PUSH live-tail buffer depth (# of recently received events). */
  buffer_depth: number;
  /** PULL durable cursor position as epoch millis (0 = never polled / N/A). */
  last_poll_millis: number;
  // --- Coverage observability (A5.2) — additive, advisory (#3), NEVER a secret (#10). //
  /**
   * Wall-clock ISO of the poller's LAST TICK ATTEMPT (independent of whether any
   * event arrived), from the poller's in-memory last-tick snapshot. `null` when never
   * polled or on a PUSH source. This is the server truth that disambiguates
   * "legitimately quiet" from "broken connector" — the old client-side 24h cursor
   * heuristic could not.
   */
  last_poll_at?: string | null;
  /**
   * Whether that last poll ATTEMPT succeeded. `null` when never polled. A `false`
   * (paired with `last_poll_error`) means the connector is broken, not merely idle.
   */
  last_poll_ok?: boolean | null;
  /**
   * The connector error string from the last FAILED poll. UNTRUSTED (source-controlled)
   * → render as PLAIN text only, never as markup (#9). `null` when healthy.
   */
  last_poll_error?: string | null;
  /**
   * Wall-clock / event watermark epoch millis of the last observed event (0 = never
   * seen). Drives `worst_last_event_seconds` and the honest "Last Event" column.
   */
  last_event_millis?: number;
  /** Smoothed recent ingest rate (events/min); 0 when idle / unknown. */
  events_per_min?: number;
  /** Lifetime counters for the bounded synthetic source runtime. */
  events_total?: number;
  alerts_total?: number;
  events_received?: number;
  alerts_emitted?: number;
  healthy?: boolean;
  state?: string;
  last_error?: string | null;
  /**
   * The server's v0 flat SILENT-source flag: an ENABLED source with no recent events
   * past the flat silence threshold (now − last_event > k × poll_interval). This is the
   * backend truth that replaces the pure-client 24h staleness guess.
   */
  silent?: boolean;
  /** `true` on the Demo-Mode overlay rows (never a real configured source). */
  demo?: boolean;
}

/** Response of GET /api/sources/health. */
export interface SourcesHealthResponse {
  sources: SourceHealthRow[];
}

/**
 * GET /api/sources/coverage — the aggregate "am I seeing everything?" rollup (A5.5;
 * the Google SecOps Health-Hub big-number model). Read-only, advisory (#3), NO secrets.
 * Every value is an aggregate count/rate over the ACTIVE tenant view: real configured
 * sources off-demo, or the four isolated synthetic overlays in Demo Mode.
 * `alerts_triaged_24h` uses the SAME 24h window the noise-reduction funnel's `cases`
 * stage uses, so the two agree.
 */
export interface SourceCoverage {
  /** True when the aggregate describes the isolated synthetic source view. */
  demo?: boolean;
  /** Total configured sources. */
  sources_total: number;
  /** Sources currently enabled (the poller/receivers actually read from). */
  sources_enabled: number;
  /** Enabled sources flagged SILENT (no recent events past the flat silence threshold). */
  sources_silent: number;
  /** Summed smoothed ingest rate across enabled sources (events/min). */
  events_per_min: number;
  /** Cases opened in the last 24h (cross-consistent with the noise funnel's `cases`). */
  alerts_triaged_24h: number;
  /** Worst (largest) seconds-since-last-event across enabled sources (0 when none seen). */
  worst_last_event_seconds: number;
}

/**
 * One normalised log row returned by GET /api/sources/{id}/logs.
 *
 * Every field is source-controlled and therefore UNTRUSTED: render `message` and
 * the entity columns as plain text, and `_raw` only inside a fenced code block —
 * never as markup.
 */
export interface SourceLogRow {
  id: string;
  ts: string;
  source_ip: string | null;
  user: string | null;
  host: string | null;
  rule: string | null;
  severity: number;
  message: string;
  _raw: Record<string, unknown>;
}

/**
 * GET /api/sources/{id}/logs — a window of recent events from a source.
 *
 * `mode:"buffer"` = a push source's PROCESS-LOCAL, VOLATILE in-memory live tail (the
 * server ignores from/to/query and nothing survives a restart); `mode:"search"` = a
 * real backing read against a pull source, where from/to/query apply.
 *
 * BOUNDED, NOT COMPLETE: the server clamps `limit` to 1..200 and there is NO
 * pagination. Rows are always "the most recent `count`" — render them as such.
 * `truncated` is true when more rows demonstrably existed; false does NOT prove
 * completeness.
 */
export interface SourceLogsResponse {
  source_id: string;
  mode: 'buffer' | 'search' | string;
  count: number;
  total?: number;
  /** Effective server-side row cap for this response (clamped to 1..200). */
  limit?: number;
  /** True when more rows existed than the cap returned. */
  truncated?: boolean;
  query?: string | null;
  logs: SourceLogRow[];
}

/** Query params for GET /api/sources/{id}/logs (all optional). */
export interface SourceLogsQuery {
  limit?: number;
  query?: string;
  from?: string;
  to?: string;
}

/** Payload for POST /api/sources (mirrors `SourceUpsert`). */
export interface SourceUpsert {
  id: string;
  source_type: string;
  display_name?: string;
  enabled?: boolean;
  ingest_mode?: string | null;
  is_primary?: boolean;
  config?: Record<string, unknown>;
  /**
   * Three-state on the wire (see `SourceInstance.severity_scale_max`):
   *   - OMITTED       -> keep whatever the stored source already declares.
   *   - a number > 0  -> declare that ceiling.
   *   - explicit null -> CLEAR the declaration (back to the 100 identity projection, or
   *                      the connector's seeded default where one exists).
   * A body that is not editing the ceiling (an Enabled toggle, a bulk action, a
   * make-primary) MUST omit the key entirely; sending `undefined` in a JSON body is the
   * same as omitting it, but never send `null` unless the operator is clearing it.
   */
  severity_scale_max?: number | null;
}

// --------------------------------------------------------------------------- //
// Setup wizard.
// --------------------------------------------------------------------------- //
/** Known secret keys the backend accepts on POST /api/setup/secrets. */
export interface SecretsUpdate {
  es_api_key?: string | null;
  es_mgmt_api_key?: string | null;
  es_url?: string | null;
  es_ca_cert?: string | null;
  openai_api_key?: string | null;
  anthropic_api_key?: string | null;
  abuseipdb_api_key?: string | null;
  virustotal_api_key?: string | null;
  embedding_api_key?: string | null;
}

export type ConfiguredStatus = Record<string, boolean>;

/**
 * The per-provider SSO client-secret configured map (Round-6 #21): `provider_id → bool`
 * (true iff THAT provider has a client secret set — never the value, #10). The backend
 * returns this ADDITIVELY inside `configured` (alongside the legacy scalar
 * `sso_client_secrets` boolean, kept for compat). `ConfiguredStatus`'s boolean index
 * signature can't express this nested map, so read it via `configuredSsoById(configured)`
 * for an accurate PER-provider badge even with 2+ providers.
 */
export type SsoClientSecretsById = Record<string, boolean>;

/** Safely read the additive per-provider SSO configured map out of `configured` (#21). */
export function configuredSsoById(configured: ConfiguredStatus): SsoClientSecretsById {
  const raw = (configured as Record<string, unknown>)['sso_client_secrets_by_id'];
  return raw && typeof raw === 'object' ? (raw as SsoClientSecretsById) : {};
}

export interface SetupStatus {
  setup_complete: boolean;
  // Wave-1 OOBE + auth fields (additive).
  needs_user?: boolean;
  auth_enabled?: boolean;
  rbac_enabled?: boolean;
  user_count?: number;
  seeded_default?: boolean;
  configured: ConfiguredStatus;
  data_view_pattern?: string;
  entity_mapping?: {
    source_ip_field?: string;
    user_field?: string;
    host_field?: string;
  };
  /** Historical Elasticsearch/log-surface probe; not the SQL owned-state probe. */
  es_connected?: boolean;
  /** Whether the configured owned-state backend itself depends on Elasticsearch. */
  es_required_for_state?: boolean;
  es_connection_role?: 'owned_state_and_log_source' | 'log_source_only';
  state_backend?: 'elasticsearch' | 'postgres' | 'sqlite' | string;
}

export interface HealthResponse {
  status: string;
  version?: string;
  /** Compatibility alias for state_store_connected. */
  es_connected?: boolean;
  state_store_connected?: boolean;
  state_backend?: 'elasticsearch' | 'postgres' | 'sqlite' | string;
  store_type?: string;
  setup_complete?: boolean;
  /**
   * A subsystem the product depends on is impaired while the state store itself is
   * reachable (e.g. an empty knowledge corpus, or a provider rejecting our
   * credentials). Additive: `status` keeps its historical state-store meaning.
   */
  degraded?: boolean;
  /**
   * Opaque, closed-vocabulary codes naming each active degradation. `/api/health` is
   * public, so it carries no counts or source names — the authenticated
   * `/api/diagnostics/health` surface owns that detail.
   */
  degraded_reasons?: string[];
}

/** Public, non-secret runtime release identity from `/api/health/build-info`. */
export interface BuildInfoResponse {
  service: string;
  version: string;
  release_channel: string;
  commit_sha: string;
  build_time: string;
  state_backend: string;
  ocsf_version: string;
  provenance_complete?: boolean;
  provenance_missing?: string[];
}

// --------------------------------------------------------------------------- //
// Read-only upstream release discovery.
// --------------------------------------------------------------------------- //
/** Operator-configurable source used only to discover branch metadata. */
export interface ReleaseUpdateConfig {
  enabled: boolean;
  repository_url: string;
  stable_branch: string;
  testing_branch: string;
  check_interval_minutes: number;
}

export type UpstreamReleaseState = 'available' | 'unavailable' | 'disabled';
export type UpstreamReleaseChannel = 'stable' | 'testing';

/** One bounded, plain-data branch observation returned by the backend. */
export interface UpstreamReleaseCandidate {
  channel: UpstreamReleaseChannel;
  branch: string;
  state: UpstreamReleaseState;
  version: string | null;
  commit_sha: string | null;
  commit_url: string | null;
  source_url: string | null;
  checked_at: string | null;
  stale: boolean;
  error_code: string | null;
  error_message: string | null;
}

/** GET/POST `/api/releases/upstream*` response. Discovery never activates code. */
export interface UpstreamReleasesResponse {
  enabled: boolean;
  repository_url: string;
  checked_at: string | null;
  cache: {
    hit: boolean;
    stale: boolean;
    max_age_seconds: number;
  };
  channels: {
    stable: UpstreamReleaseCandidate;
    testing: UpstreamReleaseCandidate;
  };
}

// --------------------------------------------------------------------------- //
// Supervised system updates (standalone Docker Compose deployment only).
// --------------------------------------------------------------------------- //
/** Durable lifecycle returned by the separately supervised updater. */
export type SystemUpdateJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'cancelled';

/** Ordered, allow-listed phases. The browser never submits a phase or command. */
export type SystemUpdateStage =
  | 'validating'
  | 'verifying_artifacts'
  | 'pulling_images'
  | 'quiescing'
  | 'backing_up'
  | 'updating_backend'
  | 'verifying_backend'
  | 'updating_webui'
  | 'verifying_webui'
  | 'observing'
  | 'rolling_back'
  | 'restoring_release'
  | 'completed';

/** Plain-data release identity selected and verified by the backend/supervisor. */
export interface SystemUpdateRelease {
  release_id: string;
  version: string;
  channel: 'stable';
  tag: string;
  commit_sha: string;
  /** Display-only provenance. It is never echoed in a mutation request. */
  repository_url: string;
}

export interface SystemUpdateCheck {
  code: string;
  label: string;
  status: 'pass' | 'fail' | 'warning';
  detail: string;
}

export interface SystemUpdateNotice {
  code: string;
  message: string;
  remediation?: string | null;
}

export interface SystemUpdateComponent {
  id: 'backend' | 'webui' | 'help_center' | string;
  label: string;
  current_version?: string | null;
  target_version?: string | null;
  scope: 'updated' | 'bundled' | 'unchanged';
  will_update: boolean;
}

export interface SystemUpdateBackupPlan {
  required: boolean;
  kind: 'postgres_custom_format' | 'none';
  state: 'planned' | 'ready' | 'not_required' | 'unavailable';
  verified: boolean;
  description: string;
}

export interface SystemUpdateRollbackPlan {
  automatic: boolean;
  supported: boolean;
  state: 'planned' | 'ready' | 'unavailable' | 'not_required';
  description: string;
}

export type SystemUpdateReleaseDiscoveryState =
  | 'not_checked'
  | 'current'
  | 'candidate_observed'
  | 'unavailable'
  | 'stale'
  | 'error';

/**
 * Read-only branch observation. It is deliberately not an installable release:
 * signed release identity and component coordinates arrive only after supervisor
 * preflight verifies the immutable Stable assets.
 */
export interface SystemUpdateObservedRelease {
  release_id: string;
  version: string;
  channel: 'stable';
  provenance: 'mutable_stable_branch_metadata';
  verification: 'signed_supervisor_preflight_required';
}

export interface SystemUpdateReleaseDiscovery {
  state: SystemUpdateReleaseDiscoveryState;
  checked_at?: string | null;
  branch: string;
  observed_release?: SystemUpdateObservedRelease | null;
  issue?: SystemUpdateNotice | null;
}

/** Durable, redacted job projection. It contains no host path, command, URL, or image. */
export interface SystemUpdateJob {
  job_id: string;
  release_id: string;
  status: SystemUpdateJobStatus;
  stage: SystemUpdateStage;
  progress: number;
  message: string;
  started_at?: string | null;
  updated_at?: string | null;
  error?: SystemUpdateNotice | null;
  rollback?: SystemUpdateRollbackPlan | null;
  receipt?: SystemUpdateReceipt | null;
  /** Separate evidence for a later operator rollback; the success receipt remains immutable. */
  rollback_receipt?: SystemUpdateReceipt | null;
}

export interface SystemUpdateStatusResponse {
  capability: {
    supported: boolean;
    blockers: SystemUpdateNotice[];
    warnings: SystemUpdateNotice[];
    scope: {
      deployment_profile: 'standalone_compose_postgres_v1';
      state_backend: string;
      components_updated: string[];
      infrastructure_not_updated: string[];
    };
    supervisor: {
      available: boolean;
      protocol_version?: string | null;
      updater_version?: string | null;
      min_protocol_version?: string | null;
    };
    bootstrap_required: boolean;
  };
  current: {
    version: string;
    channel: 'stable' | 'testing';
    commit_sha: string;
  };
  release_discovery: SystemUpdateReleaseDiscovery;
  active_job: SystemUpdateJob | null;
  last_job: SystemUpdateJob | null;
  checked_at: string;
}

export interface SystemUpdatePreflightResponse {
  preflight_token: string;
  expires_at: string;
  release: SystemUpdateRelease;
  checks: SystemUpdateCheck[];
  blockers: SystemUpdateNotice[];
  warnings: SystemUpdateNotice[];
  components: SystemUpdateComponent[];
  backup: SystemUpdateBackupPlan;
  rollback: SystemUpdateRollbackPlan;
}

export interface SystemUpdateReceipt {
  job_id: string;
  release_id: string;
  status: SystemUpdateJobStatus;
  before: { version: string; commit_sha: string };
  after: { version: string; commit_sha: string };
  components: string[];
  backup_id?: string | null;
  rollback_performed: boolean;
  started_at: string;
  completed_at: string;
}

// --------------------------------------------------------------------------- //
// Durable background jobs (ordinary application work; NOT the supervised updater).
// --------------------------------------------------------------------------- //
export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type BackgroundJobKind =
  | 'case_reinvestigate'
  | 'case_lifecycle'
  | 'case_assign'
  | 'case_tag'
  | 'data_export_archive'
  | 'data_export_segment'
  | 'precedent_bootstrap'
  | 'runbook_reindex'
  | 'rag_import'
  | 'rag_rebuild'
  | 'tiered_reset'
  | 'storage_lifecycle_apply';

export interface BackgroundJobProgress {
  done: number;
  total: number;
  unit: string;
}

export interface BackgroundJobFailure {
  item_ref: string;
  reason: string;
}

export interface BackgroundJobResult {
  kind: string;
  artifact_id?: string | null;
  counts: Record<string, number>;
}

export interface BackgroundJob {
  job_id: string;
  kind: BackgroundJobKind;
  actor: string;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  status: BackgroundJobStatus;
  progress: BackgroundJobProgress;
  failures: BackgroundJobFailure[];
  failure_count: number;
  /** Number of failures omitted from the bounded `failures` array. */
  failures_truncated: number;
  request_fingerprint: string;
  result?: BackgroundJobResult | null;
  /** Secret-free resume scope. Render values only as plain data. */
  params: Record<string, unknown>;
  cancel_requested: boolean;
}

export interface BackgroundJobSubmit {
  kind: BackgroundJobKind;
  idempotency_key: string;
  params: Record<string, unknown>;
}

export interface RelatedLlmBatchJob {
  id: string;
  provider: string;
  state: string;
  model: string;
  discount: number;
  requests: number;
  retrieved: number;
  submitted_at: string | null;
  polled_at: string | null;
}

export interface SystemWorkerHealth {
  enabled: boolean;
  gated: boolean;
  running: boolean;
  cadence: string;
  last_attempt_at: string;
  last_success_at: string;
  last_error: string;
  processed: number;
}

export interface BackgroundJobsResponse {
  jobs: BackgroundJob[];
  total: number;
  limit: number;
  offset: number;
  /** Present only with models:read; null otherwise. */
  related?: {
    llm_batches: RelatedLlmBatchJob[];
    total: number;
    truncated: boolean;
  } | null;
  /** Present only with automation:read; never projected into the personal Inbox. */
  system_workers?: {
    scheduler_runtime_running: boolean;
    workers: Record<string, SystemWorkerHealth>;
  } | null;
}

// --------------------------------------------------------------------------- //
// Models (per-role pickers).
// --------------------------------------------------------------------------- //
export interface ModelsResponse {
  providers: Record<string, string[]>;
  configured: ConfiguredStatus;
  /**
   * model id → OpenAI-compatible `base_url` for operator-registered self-hosted /
   * LiteLLM models (task 7). Lets the per-role picker thread a custom model's endpoint
   * onto the saved `ModelConfig`; absent for a backend that predates custom models.
   */
  base_urls?: Record<string, string>;
}

/** Per-role model selection (mirrors `ModelConfig`). */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  /**
   * Optional per-role endpoint overrides (Round 3 Wave 2b + task 7). `base_url` pins an
   * OpenAI-compatible / self-hosted (vLLM/Ollama/LiteLLM) or Azure-resource endpoint so
   * a role bound to a custom model routes to the right server; `api_version`/`region`
   * carry Azure/Bedrock specifics. All optional → an unset config is byte-identical.
   */
  base_url?: string;
  api_version?: string;
  region?: string;
}

export const MODEL_ROLES = [
  'router',
  'investigator',
  'formatter',
  'standup',
  'chat',
  'overview',
  'embedding',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

// --------------------------------------------------------------------------- //
// Preferences (the subset the UI reads/writes; mirrors `Preferences`).
// --------------------------------------------------------------------------- //
export interface RiskWeights {
  volume?: number;
  velocity?: number;
  reputation?: number;
  diversity?: number;
  asset_criticality?: number;
}

export interface CorrelationRule {
  mode?: 'every' | 'threshold' | 'never';
  n?: number;
  window_seconds?: number;
  /**
   * The entity dimension this rule groups on. Mirrors the full backend `EntityType`
   * (see {@link EntityTypeFull}: ip/user/host/file_hash/domain/rule) so the rules
   * editor's wider selection round-trips without a cast. Absent → the backend default.
   */
  group_by?: EntityTypeFull;
}

export interface CapsConfig {
  max_tool_calls?: number;
  max_tokens?: number;
  timeout_seconds?: number;
  kill_switch?: boolean;
  /**
   * Round-4 (additive): the fan-out concurrency ceiling — how many investigations
   * may run in parallel behind the pipeline semaphore. Defaults to 3; advisory to
   * throughput only (never feeds the deterministic decision, #3).
   */
  max_concurrent?: number;
}

export interface EnrichmentConfig {
  enabled?: boolean;
  use_abuseipdb?: boolean;
  use_virustotal?: boolean;
  use_geoip?: boolean;
  cache_ttl_seconds?: number;
}

/**
 * Compounding guards for the LOWER-TRUST `model_unconfirmed` precedent tier
 * (`RagConfig.unconfirmed_precedent`). Every guard is inert while
 * {@link RagConfig.use_unconfirmed_resolved_cases} is false.
 *
 * The tier indexes the agent's OWN auto-closed verdicts — prior model judgements, not
 * analyst decisions — so these bounds exist to stop one unreviewed close becoming
 * quotable precedent, and to stop a run being dominated by an echo of itself.
 */
export interface UnconfirmedPrecedentConfig {
  /** Minimum MODEL confidence (0..1) on the auto-closed case before it may be precedent. */
  min_confidence?: number;
  /** How often the same (entity-type, rule set, outcome) pattern must recur. 1 disables. */
  min_recurrence?: number;
  /** Age-out horizon in days, applied to the case's terminal timestamp. */
  max_age_days?: number;
  /** Hard cap on the FRACTION of one retrieval that may be unconfirmed precedent (0 blocks it). */
  max_context_share?: number;
  /** Multiplier (0..1) demoting an unconfirmed chunk's final ranking score. */
  rank_penalty?: number;
  /** Bound on how many unconfirmed precedents the projection may hold at all. */
  max_items?: number;
}

export interface RagConfig {
  enabled?: boolean;
  top_k?: number;
  min_score?: number;
  use_runbooks?: boolean;
  use_mitre?: boolean;
  use_resolved_cases?: boolean;
  use_suppression_rules?: boolean;
  /** Inject imported threat-intel corpus (source="threat_context") as TRUSTED fenced context (F11). */
  use_threat_context?: boolean;
  /**
   * The LOWER-TRUST precedent tier — DEFAULT FALSE. Additionally indexes the agent's own
   * auto-closed cases as a distinct `model_unconfirmed` tier: prior MODEL JUDGEMENTS, never
   * analyst decisions. Requires `use_resolved_cases`; always outranked by analyst-confirmed
   * precedent, bounded by {@link unconfirmed_precedent}, and still UNTRUSTED-fenced (#9).
   */
  use_unconfirmed_resolved_cases?: boolean;
  /** Compounding bounds on the lower-trust tier above. */
  unconfirmed_precedent?: UnconfirmedPrecedentConfig;
}

export interface StandupConfig {
  enabled?: boolean;
  window_hours?: number;
  interval_seconds?: number;
}

/**
 * Cross-source correlation (F6) — a GLOBAL, opt-in second pass that groups open
 * cases/clusters sharing an entity within a window across >= `min_sources` distinct
 * sources, surfaced as RELATED (never force-merged). Defaults disabled so the
 * 1:1 cluster→case signature is byte-identical out of the box.
 */
export interface CrossSourceCorrelationConfig {
  enabled?: boolean;
  time_window_seconds?: number;
  min_sources?: number;
  entity_keys?: string[];
}

export interface FpAutoCloseConfig {
  enabled?: boolean;
  min_confidence?: number;
  max_risk_score?: number;
  objection_window_minutes?: number;
}

// --------------------------------------------------------------------------- //
// Threshold automation (F10) — Preferences.threshold_automation.
//
// Rules match a case AFTER the deterministic CaseManager.decide()/apply() has run
// and saved. A matched rule can only TAG, attach a non-binding RECOMMENDATION,
// send a NOTIFICATION, QUEUE a playbook re-investigation (which itself re-runs
// decide() with new context), or create a HITL Proposal for an approval-required
// action. Automation NEVER sets status/disposition and NEVER auto-closes —
// NEEDS_HUMAN / escalated cases are always held for a human (code-enforced).
// --------------------------------------------------------------------------- //
/** The action a matched automation rule performs (all #3-safe). */
export type AutomationActionType =
  | 'tag'
  | 'recommend'
  | 'notify'
  | 'run_playbook'
  | 'request_approval'
  | string;

/**
 * The match criteria for an automation rule. All conditions are ANDed; an absent
 * condition is "any". `verdict`/`status`/`entity_type` are case-insensitive token
 * matches; `source_id`/`rule_name` are exact/contains matches (backend decides);
 * `min_risk`/`min_severity` are floors (0..100 / 0..n).
 */
export interface AutomationConditions {
  verdict?: string;
  min_risk?: number;
  min_severity?: number;
  status?: string;
  source_id?: string;
  rule_name?: string;
  entity_type?: string;
}

/** One operator-authored threshold-automation rule. */
export interface AutomationRule {
  id: string;
  /**
   * Optional operator-facing DISPLAY name, independent of the immutable `id`, so a rule
   * can be renamed after creation (mirrors backend `CaseAutomationRule.name`; additive,
   * defaults ""). Plain operator text → render escaped (#9); falls back to `id` when
   * blank. Never feeds the matcher or `decide()` (#3).
   */
  name?: string;
  enabled?: boolean;
  /** Lower runs first (priority order). Defaults to 100. */
  priority?: number;
  conditions?: AutomationConditions;
  action: AutomationActionType;
  /**
   * Action-specific payload (operator-authored, TRUSTED). Well-known keys:
   *   - tag:              { tags: string[] }
   *   - recommend:        { text: string }
   *   - notify:           { channel_id?: string }
   *   - run_playbook:     { playbook_id: string }
   *   - request_approval: { kind: string, ... }
   */
  payload?: Record<string, unknown>;
}

/** Preferences.threshold_automation — disabled by default (byte-identical OOTB). */
export interface ThresholdAutomationConfig {
  enabled?: boolean;
  rules?: AutomationRule[];
}

/** Preferences.threat_context — the threat-context panel + reusable-knowledge loop (F11). */
export interface ThreatContextConfig {
  enabled?: boolean;
  mitre_enabled?: boolean;
  reuse_resolved_cases?: boolean;
  /** A reputation score at/above this is treated as malicious (0..100). */
  ioc_malicious_threshold?: number;
}

/**
 * Desired lifecycle for Agentic SOC's OWN state. Connected SIEM/log indices are
 * deliberately outside this policy because the Console consumes them read-only.
 * Automatic deletion is not supported in this release and is fixed to `false`.
 */
export interface StorageLifecycleConfig {
  enabled: boolean;
  /** Days append-only ledgers remain on the Hot tier. */
  hot_days: number;
  /** Additional days append-only ledgers remain on the Warm tier. */
  warm_days: number;
  /** The desired archive provider; archive export/restore is not configured yet. */
  archive_target: 'aws_glacier';
  glacier_storage_class: 'GLACIER' | 'DEEP_ARCHIVE';
  delete_after_archive: false;
}

export interface StorageLifecycleCapability {
  supported: boolean;
  /** Control-plane and managed-index privileges are sufficient to detach policy safely. */
  can_manage?: boolean;
  privileged?: boolean;
  index_privileged?: boolean;
  hot_ready?: boolean;
  warm_ready?: boolean;
  roles?: string[];
  ilm_mode?: string;
  reason?: string;
}

export interface StorageLifecycleTier {
  id: 'hot' | 'warm' | 'archive' | string;
  label: string;
  from_day: number;
  until_day: number | null;
  enforcement: string;
  status: string;
}

export interface StorageLifecycleTarget {
  id: 'audit' | 'usage' | 'cases' | 'live_metadata' | 'source_logs' | string;
  label: string;
  enforcement: string;
  reason: string;
}

export interface StorageLifecycleAttachmentStatus {
  verified: boolean;
  template_attached: boolean;
  indices_total: number;
  indices_attached: number;
  all_existing_indices_attached: boolean;
  attached: boolean;
  reason: string;
}

/** Capability-aware projection returned by GET/POST `/api/storage/lifecycle*`. */
export interface StorageLifecycleStatus {
  state_backend: 'elasticsearch' | 'postgres' | 'sqlite' | string;
  effective_state: 'active' | 'disabled' | 'not_configured' | 'blocked' | 'advisory' | string;
  policy_name: string | null;
  capabilities: StorageLifecycleCapability;
  attachments?: Record<string, StorageLifecycleAttachmentStatus>;
  inspection_error?: string | null;
  policy: StorageLifecycleConfig & { archive_from_days: number };
  tiers: StorageLifecycleTier[];
  targets: StorageLifecycleTarget[];
  archive: {
    enforcement: string;
    status: string;
    storage_class: StorageLifecycleConfig['glacier_storage_class'];
    reason: string;
  };
  delete_enabled: false;
}

/**
 * The complete preferences object is large; we type the fields the UI touches
 * and keep an index signature so unknown fields round-trip unharmed.
 */
export interface Preferences {
  sources?: SourceInstance[];

  data_view_pattern?: string;
  time_field?: string;
  investigate_lookback?: string;

  source_ip_field?: string;
  user_field?: string;
  host_field?: string;

  rule_field?: string;
  rule_name_field?: string;
  severity_field?: string;
  severity_threshold?: number;
  in_scope_rules?: string[];
  excluded_rules?: string[];

  /**
   * The extra raw-record paths the agent sees per sample event, the `es_query`
   * tool returns per row, and free-text search is matched against — ONE list
   * driving all three (`backend/app/evidence_fields.py`). `["*"]` ships the whole
   * record bounded only by `evidence_max_chars_per_event`; `[]` is the narrow
   * identity-only projection. Overridable per source via `SourceConfigExtras`.
   */
  evidence_fields?: string[];
  /** Serialised-character budget for ONE projected event (0 disables the extras). */
  evidence_max_chars_per_event?: number;

  poll_interval_seconds?: number;
  poll_batch_size?: number;
  cold_start_lookback_minutes?: number;
  polling_enabled?: boolean;

  router_model?: ModelConfig;
  investigator_model?: ModelConfig;
  formatter_model?: ModelConfig;
  standup_model?: ModelConfig;
  chat_model?: ModelConfig;
  overview_model?: ModelConfig;
  embedding_model?: ModelConfig;

  fp_auto_close?: FpAutoCloseConfig;
  escalation_confidence?: number;
  critical_severity?: number;

  default_correlation?: CorrelationRule;
  /** Global, opt-in cross-source correlation (F6; default disabled). */
  cross_source_correlation?: CrossSourceCorrelationConfig;
  risk_weights?: RiskWeights;

  caps?: CapsConfig;

  background_scan_enabled?: boolean;
  auto_forward_allowlist?: string[];

  enrichment?: EnrichmentConfig;
  rag?: RagConfig;
  standup?: StandupConfig;

  /** Security (Wave 2): MFA tuning + SSO/OIDC providers. */
  mfa?: MfaConfig;
  sso?: SsoConfig;

  /** Token/session lifecycle policy (Round-2 Wave 3; admin-editable). */
  session_policy?: SessionPolicy;

  /** Customisable human-facing case-ID nomenclature (F7). */
  case_id_format?: CaseIdFormatConfig;

  /** Outbound alerting / notifications (F5 / Wave 4; default disabled). */
  notifications?: NotificationConfig;

  /** Threshold automation (F10; default disabled). #3-safe, never auto-closes. */
  threshold_automation?: ThresholdAutomationConfig;
  /** Threat-context panel + reusable-knowledge loop (F11). */
  threat_context?: ThreatContextConfig;

  /** Capability-aware Hot/Warm/archive intent for Agentic SOC-owned state. */
  storage_lifecycle?: StorageLifecycleConfig;

  /** Public GitHub source and refs used for read-only release discovery. */
  release_updates?: ReleaseUpdateConfig;

  setup_complete?: boolean;
  read_only_settings_mode?: boolean;

  [key: string]: unknown;
}

export interface SettingsResponse {
  prefs: Preferences;
  configured: ConfiguredStatus;
  read_only: boolean;
}

// --------------------------------------------------------------------------- //
// Settings schema reflector (GET /api/settings/schema) — Round-5 Sett-C / Rules R7.
// A best-effort, purely-descriptive JSON description of the Preferences model used by
// the generic "Advanced (all settings)" renderer. Carries NO values beyond defaults and
// NO secrets.
// --------------------------------------------------------------------------- //
/** A coarse, UI-friendly type tag for one settings field (mirrors `_type_name`). */
export type SettingsFieldType =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'enum'
  | 'array'
  | 'object'
  | 'union';

/** The element-model descriptor for a `list[Model]` / `dict[str, Model]` field. */
export interface SettingsElementSchema {
  /** `'list'` or `'dict'` container. */
  container: 'list' | 'dict';
  /** The element Pydantic model name. */
  model: string;
  /** The element model's own fields. */
  fields: SettingsSchemaField[];
}

/** One field descriptor. `element` is present only for collections OF a model. */
export interface SettingsSchemaField {
  name: string;
  type: SettingsFieldType;
  /** JSON-safe default (may be null when not representable). */
  default: unknown;
  required: boolean;
  /** Enumerated choices for an enum / Literal field, else null. */
  choices: string[] | null;
  description: string | null;
  /** Additive (Sett-C): the element-model descriptor for list/dict-of-model fields. */
  element?: SettingsElementSchema;
}

/** One section: an `object` (nested model) or the synthetic `general` scalar `group`. */
export interface SettingsSchemaSection {
  key: string;
  title: string;
  kind: 'object' | 'group';
  model: string | null;
  fields: SettingsSchemaField[];
}

export interface SettingsSchema {
  sections: SettingsSchemaSection[];
}

// --------------------------------------------------------------------------- //
// Notifications / alerting (F5 / Wave 4) — Preferences.notifications + endpoints.
// --------------------------------------------------------------------------- //
/** The kinds of delivery channel (mirrors backend `NotificationChannelConfig.type`). */
export type NotificationChannelType =
  | 'email'
  | 'resend'
  | 'ses'
  | 'slack'
  | 'teams'
  | 'webhook'
  | 'pagerduty'
  | 'telegram';

/** SMTP message security for an email channel. */
export type EmailSecurity = 'starttls' | 'ssl' | 'none';

/**
 * One configured notification channel. Channel-specific NON-secret fields live in
 * `config` (email: provider/host/port/security/username/from_addr/recipients/region;
 * slack/teams/webhook: url; telegram: chat_id; pagerduty: source_name). The SECRET
 * (SMTP password / API key / sensitive URL / token / routing key) is NEVER carried
 * here — only the configured field NAMES in `configured_secrets` (the UI shows ✓).
 */
export interface NotificationChannel {
  id: string;
  type: NotificationChannelType | string;
  enabled: boolean;
  name?: string;
  config?: Record<string, unknown>;
  /** The secret field names configured for this channel (names only, never values). */
  configured_secrets?: string[];
}

/** When notifications fire + the severity/risk floors (mirrors backend). */
export interface NotificationTriggers {
  on_case_created?: boolean;
  on_escalated?: boolean;
  on_true_positive?: boolean;
  on_needs_human?: boolean;
  on_closed?: boolean;
  /** 0..100 risk floor. */
  min_severity?: number;
  min_risk?: number;
}

/** Optional digest batching. */
export interface NotificationDigest {
  enabled?: boolean;
  interval_minutes?: number;
}

/**
 * The triggers a notification template can target (mirrors the backend renderer's
 * template set; the live PREVIEW endpoint accepts one of these keys via ?trigger=).
 */
export const NOTIFICATION_TEMPLATE_TRIGGERS = [
  'case.new',
  'case.escalation',
  'case.resolved',
  'digest.daily',
  'test',
] as const;
export type NotificationTemplateTrigger =
  (typeof NOTIFICATION_TEMPLATE_TRIGGERS)[number];

/**
 * A per-trigger template OVERRIDE. Any omitted field falls back to the built-in
 * default for that trigger. All three parts are operator-authored TRUSTED strings;
 * the SERVER-SIDE renderer (POST /api/notifications/preview) is authoritative for
 * escaping every interpolated case/log var (#9) — the UI never escapes locally.
 */
export interface NotificationTemplate {
  subject?: string;
  html?: string;
  text?: string;
}

/** Per-trigger overrides (mirrors backend `NotificationTemplates`). */
export type NotificationTemplates = Partial<
  Record<NotificationTemplateTrigger, NotificationTemplate>
>;

/** Preferences.notifications — the full alerting config (default disabled). */
export interface NotificationConfig {
  enabled?: boolean;
  channels?: NotificationChannel[];
  triggers?: NotificationTriggers;
  dedup_window_seconds?: number;
  rate_limit_per_hour?: number;
  digest?: NotificationDigest;
  default_recipients?: string[];
  base_url?: string;
  /** Operator-authored per-trigger template overrides (Wave 7). */
  templates?: NotificationTemplates;
}

/**
 * POST /api/notifications/preview?trigger= — the SERVER-rendered subject + HTML +
 * text for a sample case, with escaping already applied authoritatively. `variables`
 * (when returned) is the whitelisted variable reference list for the editor.
 */
export interface NotificationPreview {
  trigger: string;
  subject: string;
  html: string;
  text: string;
  /** The variable names available to this trigger's template (for the reference list). */
  variables?: string[];
  /** Whether an operator override is in effect (vs the built-in default). */
  is_override?: boolean;
}

/** One email provider preset (GET /api/notifications/providers). */
export interface EmailPreset {
  id: string;
  host: string;
  port: number;
  security: EmailSecurity | string;
  username_hint?: string;
  fixed_username?: string | null;
}

/** GET /api/notifications/providers — presets + the available channel types. */
export interface NotificationProviders {
  email_presets: EmailPreset[];
  channel_types: string[];
}

/** POST /api/notifications/test — a sample send to one channel. */
export interface NotificationTestResult {
  ok: boolean;
  detail?: string;
}

/** One per-channel send record (POST /api/cases/{id}/notify). */
export interface NotificationSendRecord {
  channel_id: string;
  type: string;
  ok: boolean;
  detail?: string;
  trigger?: string;
  ts?: string;
}

/** POST /api/cases/{id}/notify — the manual-notify result. */
export interface NotifyCaseResult {
  ok: boolean;
  sent: NotificationSendRecord[];
}

// --------------------------------------------------------------------------- //
// Demo mode (Round-2 Wave 5) — /api/demo/{status,enable,reset,disable}.
//
// First-class, REVERSIBLE tenant state (off | seeded | live). When the mode is not
// 'off' the backend serves cases/metrics/cost/etc. from a SEPARATE, throwaway
// in-memory store seeded with synthetic data, run through a deterministic $0 MOCK
// LLM and a SANDBOXED auto-close policy COPY — the real durable cursor, real stores
// and live policy are NEVER touched. Disabling stops the tick task and hard-deletes
// all demo data by `run_id`, returning the real state intact. Every demo case is
// tagged `['demo', …]` plus a run tag; generated case ids use the normal configured
// case-id allocator. All synthetic text is data (plain-rendered). Mutations are gated
// by the dedicated demo:manage grant.
// --------------------------------------------------------------------------- //
/** The demo tenant mode. 'seeded' = static synthetic history; 'live' = also ticks. */
export type DemoMode = 'off' | 'seeded' | 'live';

/**
 * The operator-tunable demo knobs (mirrors backend `Preferences.demo`). Shown when
 * arming demo mode; defaulted so an absent block uses the backend defaults.
 */
export interface DemoConfig {
  /** Off / seeded (static synthetic history) / live (also simulates new incidents). */
  mode?: DemoMode;
  /** Deterministic seed — the same seed reproduces the same synthetic events. */
  seed?: number;
  /** How many days of trailing "old" synthetic history to pre-generate. */
  history_days?: number;
  /** Live-sim tick cadence in seconds (live mode only). */
  tick_seconds?: number;
  /** Jitter fraction applied to the tick interval (0..1). */
  tick_jitter?: number;
  /** At each source-alert interval, probability of emitting a storyline instead (0..1). */
  incident_rate?: number;
  /** Source-native alert cadence across the Splunk, QRadar, and Wazuh demo feeds. */
  alert_interval_seconds?: number;
  /** Four-source logical throughput target (events/sec, pre-aggregated and bounded). */
  event_rate_per_second?: number;
  /** Pre-seed "just happened" window in minutes (recent cases + processed events). */
  preseed_recent_minutes?: number;
  /** How many recent cases to pre-seed on enable. */
  preseed_case_count?: number;
  /** How many already-processed events to pre-seed on enable. */
  preseed_event_count?: number;
  /** Force tuning/baseline/campaign/HITL ON in the isolated demo sandbox (default true). */
  force_capabilities?: boolean;
}

/** One non-secret runtime counter row for a synthetic native-format source. */
export interface DemoSourceActivity {
  key?: string;
  source_id: string;
  display_name?: string;
  source_type?: string;
  category?: string;
  ingest_mode?: string;
  protocol?: string;
  wire_format?: string;
  rate_share?: number;
  enabled?: boolean;
  healthy?: boolean;
  state?: string;
  buffer_depth?: number;
  events_total?: number;
  alerts_total?: number;
  system_detections_total?: number;
  last_event_millis?: number;
  events_per_min?: number;
  can_browse?: boolean;
  last_error?: string | null;
  demo?: boolean;
}

export interface DemoIncidentSourceResult {
  source_id: string;
  events: number;
  native_alerts: number;
  system_detections: number;
  investigated?: number;
}

/** Result of the cooldown-aware POST /api/demo/incident presentation control. */
export interface DemoIncidentResult {
  triggered: boolean;
  reason: string;
  scenario_id: string;
  scenario_name?: string;
  events: number;
  native_alerts: number;
  system_detections: number;
  cooldown_seconds: number;
  sources: Record<string, DemoIncidentSourceResult>;
}

/**
 * GET /api/demo/status — the live demo tenant state. `mode!=='off'` means demo data
 * is active and the READ endpoints are serving from the isolated demo store (real
 * cases are hidden). `run_id` is the opaque id every demo row is tagged with (the
 * disable path hard-deletes by it). Counts are best-effort for the banner/badges.
 */
export interface DemoStatus {
  mode: DemoMode;
  /** True when `mode !== 'off'` (convenience; the UI may derive it itself). */
  active?: boolean;
  /** The current run's opaque id (present while active); demo rows are tagged with it. */
  run_id?: string | null;
  /** The seed the current/last run used. */
  seed?: number;
  history_days?: number;
  tick_seconds?: number;
  tick_jitter?: number;
  incident_rate?: number;
  alert_interval_seconds?: number;
  event_rate_per_second?: number;
  preseed_recent_minutes?: number;
  preseed_case_count?: number;
  preseed_event_count?: number;
  force_capabilities?: boolean;
  /** When the current run was seeded (ISO). */
  started_at?: string | null;
  /** Best-effort count of synthetic cases in the demo store. */
  case_count?: number;
  /** Count of pre-seed events already batch-processed (ingested volume). */
  preseed_events?: number;
  /** Whether the live-sim tick task is running (live mode). */
  ticking?: boolean;
  /** Explicit alias for clients that do not use the legacy `ticking` name. */
  simulator_running?: boolean;
  /** ── Live capability signal (demo overhaul) — "these features are working". ── */
  /** Open HITL approval proposals awaiting review in the demo. */
  proposals_open?: number;
  /** Cross-case campaigns the demo campaign-correlator found. */
  campaigns_found?: number;
  /** Threshold-tuning observations recorded in the demo. */
  tuning_events?: number;
  /** Seeded/indexed RAG corpus chunks in the demo. */
  rag_chunks?: number;
  /** The four native demo source ids (Splunk, QRadar, Wazuh, and syslog). */
  sources?: string[];
  /** Bounded per-source activity counters; never contains secrets or real-source data. */
  source_activity?: DemoSourceActivity[];
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Pervasive customization (Round-2 Wave 7) — /api/prefs/*, /api/views/*,
// /api/terminology. Two-store model: ORG defaults on Preferences.customization
// (admin-only PUT) + PERSONAL prefs in the per-user UserPrefsStore (the 'default'
// bucket when auth is off). The cascade resolver merges ORG ← USER.
//
// EVERY terminology label / saved-view name / filter value here is user/operator-
// INFLUENCEABLE config → render as PLAIN text (#9), never markup, never an LLM
// prompt input.
// --------------------------------------------------------------------------- //
/** The user's colour-mode preference. 'system' follows the OS. */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * A named, reusable list configuration (filters + sort + optional columns) for a
 * UI surface (e.g. 'cases'). `shared:true` marks an org-shared view (a user may
 * clone one into their personal set). All free-text is plain data (#9).
 */
export interface SavedView {
  id: string;
  name: string;
  /** The UI surface this view targets (e.g. 'cases'). */
  scope: string;
  /** Who created it ("" for a system/org view). */
  owner?: string;
  /** An org-shared view (surfaced to every user). */
  shared?: boolean;
  /** Free-form filter bag the frontend interprets. */
  filters?: Record<string, unknown>;
  /** Sort token, e.g. '-updated_at' (descending) / 'title'. */
  sort?: string;
  /** Pinned visible/ordered column ids, or null/undefined → surface default. */
  columns?: string[] | null;
  created_at?: string;
  updated_at?: string;
}

/** Per-table column layout: ordered ids, hidden ids, and a px-width map. */
export interface ColumnState {
  /** Ordered column ids (visible-or-not). */
  order?: string[];
  /** Column ids the user hid. */
  hidden?: string[];
  /** column id → pixel width. */
  widths?: Record<string, number>;
}

/** Terminology label-override map (e.g. `{ case: 'incident' }`). Plain data (#9). */
export type Terminology = Record<string, string>;

/** The caller's raw PERSONAL prefs bucket (GET /api/prefs/user). */
export interface UserPrefs {
  saved_views?: SavedView[];
  tables?: Record<string, ColumnState>;
  theme_mode?: ThemeMode;
  last_list_state?: Record<string, Record<string, unknown>>;
  pinned_view_ids?: string[];
  misc?: Record<string, unknown>;
  updated_at?: string;
}

/** The ORG customization defaults (GET/PUT /api/prefs/org; PUT admin-only). */
export interface OrgCustomization {
  terminology?: Terminology;
  default_saved_views?: SavedView[];
  default_theme?: ThemeMode;
  default_pinned_view_ids?: string[];
  /**
   * Per-role immutable default custom-dashboard layouts (Round-5 / G7). Mirrors
   * backend `CustomizationConfig.default_dashboards` (`config.py:626`); the
   * `/api/prefs/org` route projects this field, so it is typed here (not only on the
   * superset {@link CustomizationConfig}). Defaulted + additive.
   */
  default_dashboards?: Record<string, DashboardLayout>;
  [key: string]: unknown;
}

/**
 * The MERGED customization cascade (GET /api/prefs/effective) hydrated once by the
 * PrefsContext on mount. `org` echoes the org defaults so the UI can offer
 * "reset to org default" affordances. All plain data (#9).
 */
export interface EffectivePrefs {
  terminology: Terminology;
  theme_mode: ThemeMode;
  saved_views: SavedView[];
  pinned_view_ids: string[];
  tables: Record<string, ColumnState>;
  last_list_state: Record<string, Record<string, unknown>>;
  misc: Record<string, unknown>;
  org: {
    terminology: Terminology;
    default_theme: ThemeMode;
    default_saved_views: SavedView[];
    default_pinned_view_ids: string[];
  };
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Cases / analytics surfaces.
// --------------------------------------------------------------------------- //
export interface Entity {
  /**
   * Correlation grouping-key type. Mirrors the backend `EntityType` enum (all SIX
   * values — see {@link EntityTypeFull}): ip/user/host plus file_hash/domain/rule,
   * where `rule` is the always-resolvable terminal fallback cluster. A case grouped
   * on a rule/domain/file_hash is therefore typed correctly (the old
   * ip|user|host union under-typed `Case.entity`). The Investigate picker only
   * OFFERS the ip/user/host subset (see `ENTITY_OPTIONS` there).
   */
  type: EntityTypeFull;
  value: string;
}

export interface Evidence {
  summary: string;
  event_ids?: string[];
  query?: string;
}

/** Analyst feedback / grading attached to a closed case (mirrors backend). */
export interface CaseFeedback {
  ts?: string;
  analyst?: string;
  /** Analyst's overall assessment of the agent verdict. */
  assessment?: 'agree' | 'partial' | 'disagree' | string;
  /** 0..1 quality scores. */
  accuracy?: number;
  reasoning_quality?: number;
  action_appropriateness?: number;
  /** The real-world outcome the analyst recorded. */
  actual_outcome?: string;
  /** Estimated analyst minutes saved by the agent. */
  time_saved_minutes?: number;
  comment?: string;
}

/** A free-form analyst comment on a case (mirrors backend). */
export interface CaseComment {
  ts?: string;
  author?: string;
  body?: string;
}

/**
 * Lifecycle status axis (F8). Keeps the original three values
 * (open/needs_human/closed) and adds the richer states. `needs_human` is a
 * retained, deprecated alias rendered "Open · awaiting analyst" in the UI. Unknown
 * values still render safely (the StatusBadge degrades gracefully).
 */
export type CaseStatus =
  | 'new'
  | 'open'
  | 'needs_human'
  | 'investigating'
  | 'escalated'
  | 'on_hold'
  | 'resolved'
  | 'closed'
  | string;

/** Investigative OUTCOME axis (F8), orthogonal to {@link CaseStatus}. */
export type Disposition =
  | 'true_positive'
  | 'false_positive'
  | 'benign'
  | 'suspicious'
  | 'duplicate'
  | 'undetermined'
  | string;

/** One append-only lifecycle transition on a case (status timeline). */
export interface StatusHistoryEntry {
  from_status?: string;
  to_status?: string;
  by?: string;
  at?: string;
  reason?: string;
}

export interface Case {
  case_id: string;
  /** Immutable producing build for a newly created case; null/absent on legacy rows. */
  app_version?: string | null;
  /** Immutable creating commit SHA; `unknown` is explicit, null/absent is historical. */
  build_sha?: string | null;
  /** Human-facing DISPLAY id (template-driven, F7). "" → fall back to case_id. */
  case_number?: string;
  cluster_signature?: string;
  created_at?: string;
  updated_at?: string;
  source_surface?: string;
  origin_surface?: string;
  rule_ids?: string[];
  entity?: Entity;
  member_event_ids?: string[];
  member_event_keys?: string[];
  risk_score?: number;
  verdict?: string;
  confidence?: number;
  evidence?: Evidence[];
  mitre?: string[];
  recommended_action?: string;
  reproduce_query?: string;
  status?: CaseStatus;
  /** Investigative outcome (F8). null/undefined → "Undetermined" in the UI. */
  disposition?: Disposition | null;
  /** Free-text reason for the current lifecycle state (why on hold / how resolved). */
  status_reason?: string;
  /** Deprecated wire-compatibility flag; operator UI renders only Escalated. */
  escalation_level?: number;
  /** Append-only lifecycle transition trail (from→to, by, when, reason). */
  status_history?: StatusHistoryEntry[];
  decision_by?: string;
  /**
   * The deterministic rule-identity precedent fact this investigation was given, and
   * why it did or did not qualify. `null`/absent means the run predates the seam or
   * never reached the investigator — never "no precedent exists".
   */
  precedent_signal?: PrecedentSignalRecord | null;
  /** The operator declaration that closed this case with no model call, when one did. */
  analyst_policy?: AnalystPolicyRecord | null;
  title?: string;
  summary?: string;
  token_cost?: number;
  error?: string;
  agent_persona?: string;
  playbook_id?: string;
  /** The source instance this case originated from (additive; mirrors backend). */
  source_id?: string | null;
  /** Human-readable display name of the originating source (additive). */
  source_name?: string | null;
  /** The kind of the case's primary entity (e.g. "ip"/"user"/"host"/"rule"). */
  entity_type?: string | null;
  /** Analyst grading entries (POST /api/cases/{id}/feedback). */
  feedback?: CaseFeedback[];
  /** Free-form analyst tags (POST /api/cases/{id}/tags). */
  tags?: string[];
  /** Analyst comments thread (POST /api/cases/{id}/comment). */
  comments?: CaseComment[];
  /** Assigned analyst (POST /api/cases/{id}/assign). */
  assignee?: string;
  /** Outbound notification send records (F5; additive, optional). */
  notifications_sent?: NotificationSendRecord[];
  /**
   * Cross-source linkage (F6). `related_case_ids` are cases grouped with this one by
   * a shared entity within the cross-source window (RELATED, never merged);
   * `cross_source_cluster_id` is the stable id of that cross-source group;
   * `source_breakdown` maps source_id → contributing event/case count. All additive.
   */
  related_case_ids?: string[];
  cross_source_cluster_id?: string;
  source_breakdown?: Record<string, number>;
  /**
   * Threshold-automation audit trail (F10; additive). Each entry records a SAFE
   * action automation applied (tag/recommend/notify/queued playbook) or a Proposal
   * it drafted for approval — NEVER a status change. Values are operator/agent text
   * → render as plain text.
   */
  automation_actions?: AutomationActionRecord[];
  /** Cumulative knowledge references (F11; UNTRUSTED text). Always an array. */
  knowledge_used?: Array<Record<string, unknown>>;
  /**
   * Whether the case's complete lifetime retrieval history is interpretable. Legacy
   * cases stay `unavailable`; this marker is authoritative over array presence.
   */
  retrieval_history_status?: 'available' | 'unavailable';
  /**
   * Whether at least one instrumented retrieval completed for this case. An empty
   * knowledge array is a measured zero only when this is `measured`.
   */
  retrieval_observation_status?: 'measured' | 'not_measured' | 'unavailable';
  /**
   * FP objection-window deadline (Round-7; additive). When the deterministic
   * auto-close policy schedules a false-positive close behind an objection window,
   * this is the ISO instant it expires (a human may object until then). `null` /
   * absent when no objection window is pending. Matches the backend flat field.
   */
  objection_window_expires_at?: string | null;
  /**
   * Advisory triage BANDS (Round-7; additive, ADVISORY — never feed `decide()`, #3).
   * The backend derives these read-time in `engine/priority.py` and populates them on
   * `GET /api/cases` + `GET /api/cases/{id}`. All are PLAIN enum-ish labels (render as
   * plain text). `severity_band` is one of the 5 severity bands
   * (critical/high/medium/low/info); `severity_source` records WHO graded severity
   * ('source_asserted' = SIEM-supplied vs 'derived' = code-derived) for the provenance tag;
   * `impact_band`/`urgency_band` are 3-band (high/medium/low); `priority_level` is the
   * ITIL P-level (e.g. "P1"). All optional — absent when the advisory pass is off.
   */
  severity_band?: string;
  severity_source?: string;
  impact_band?: string;
  urgency_band?: string;
  priority_level?: string;
  [key: string]: unknown;
}

/** One recorded threshold-automation action on a case (F10; audit). */
export interface AutomationActionRecord {
  /** The kind of action automation took. */
  action?: AutomationActionType;
  /** The rule id that matched. */
  rule_id?: string;
  /** When it ran (ISO). */
  at?: string;
  /** A human-readable note about what happened (UNTRUSTED-safe plain text). */
  detail?: string;
  /** For request_approval: the created Proposal id. */
  proposal_id?: string;
  [key: string]: unknown;
}

export interface CasesResponse {
  cases: Case[];
  total: number;
}

// --------------------------------------------------------------------------- //
// Global search (W7c) — GET /api/search?q= — powers the Cmd-K palette + top bar.
//
// Every title/label/entity value here is operator- or LOG-derived data →
// render as PLAIN text (#9), never as markup. No secrets are ever returned.
// --------------------------------------------------------------------------- //
/** One case hit from GET /api/search. */
export interface SearchCaseHit {
  type: 'case';
  id: string;
  case_number?: string;
  title?: string;
  status?: string;
  verdict?: string;
  entity?: string;
  source_name?: string;
}

/** One source hit from GET /api/search. */
export interface SearchSourceHit {
  type: 'source';
  id: string;
  label?: string;
  source_type?: string;
}

/**
 * One static nav target (a page or a Settings section) from GET /api/search.
 * `id` is a routable PageId; `type` distinguishes a top-level page from a
 * Settings sub-section (the palette routes both via the same navigate()).
 */
export interface SearchNavHit {
  type: 'page' | 'settings' | string;
  id: string;
  label: string;
}

/** GET /api/search — typed, bounded (cap 50) results for the command palette. */
export interface SearchResult {
  query: string;
  cases: SearchCaseHit[];
  sources: SearchSourceHit[];
  nav: SearchNavHit[];
}

// --------------------------------------------------------------------------- //
// Bulk case actions (W7c) — POST /api/cases/bulk.
//
// The SAME human-initiated lifecycle action as POST /api/cases/{id}/action,
// applied to N selected cases; each case is applied + AUDITED individually and is
// #3-safe (never an LLM auto-close, never decide()). RBAC-gated server-side
// (cases:close for close/resolve, cases:write otherwise). Partial-failure tolerant.
// --------------------------------------------------------------------------- //
/** One per-id outcome in a bulk action result. */
export interface BulkResultItem {
  id: string;
  ok: boolean;
  /** Present only when `ok` is false — the per-id failure reason (plain text). */
  error?: string;
}

/** POST /api/cases/bulk — the per-id outcome list. */
export interface BulkResult {
  results: BulkResultItem[];
}

// --------------------------------------------------------------------------- //
// Audit-log viewer (W7c) — GET /api/audit — read-only over the append-only audit
// (#2). Gated by audit:view server-side. EVERY field is system/operator/LOG-derived
// → render as PLAIN text (#9); `prompt_excerpt`/`tool_output_summary` carry fenced
// UNTRUSTED log data and render only inside a code block. No mutate path exists.
// --------------------------------------------------------------------------- //
/** One append-only audit record (mirrors backend `AuditDoc`). */
export interface AuditRecord {
  ts?: string;
  /** Producing application version; null/absent on historical audit rows. */
  app_version?: string | null;
  /** Producing commit SHA; `unknown` is explicit, null/absent is historical. */
  build_sha?: string | null;
  case_id?: string | null;
  surface?: string;
  actor?: string;
  action_type?: string;
  model?: string | null;
  prompt_excerpt?: string | null;
  query_text?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output_summary?: string | null;
  result_summary?: string | null;
  [key: string]: unknown;
}

/** GET /api/audit — bounded, NEWEST-first list + total. */
export interface AuditResponse {
  records: AuditRecord[];
  total: number;
}

/** Query params for GET /api/audit (all optional; filters are ANDed). */
export interface AuditQuery {
  actor?: string;
  /** The audit `action_type` value (the wire param name is `action`). */
  action?: string;
  surface?: string;
  case_id?: string;
  /** ISO lower/upper time bounds (wire param names `from`/`to`). */
  from?: string;
  to?: string;
  limit?: number;
}

/**
 * GET /api/scans/notifications — how many automated-scan cases are new since the
 * caller's last-seen timestamp. Drives the "N new" pill on the Scans surface.
 */
export interface ScanNotifications {
  new_count: number;
  since?: string | null;
  now?: string | null;
}

/**
 * Navigation options threaded through `Navigate` (router.tsx / App.tsx) so
 * deep-links / drill-throughs can pre-seed a destination page's filters/tab.
 *
 * MOVED (Round-5 W0-F F1): the canonical definition now lives next to the shell
 * router in `@/soc/nav-types` (it is a UI navigation contract, not a backend data
 * mirror). This re-export shim keeps existing `import { NavOpts } from '@/lib/types'`
 * sites working; prefer importing from `@/soc/nav-types` in new code.
 */
export type { NavOpts } from '@/soc/nav-types';

/**
 * Payload for POST /api/cases/{id}/action — a unified analyst action on a case
 * (the case-detail flyout drives this). `action` is open-ended (the backend
 * validates), but the common verbs are enumerated for editor help. The extra
 * fields are additive and only meaningful for some verbs (e.g. `resolution` on a
 * close, `assignee`/`priority` on an escalate).
 */
export interface CaseActionInput {
  action:
    | 'close'
    | 'reopen'
    | 'escalate'
    | 'deescalate'
    | 'confirm_fp'
    | 'acknowledge'
    | 'hold'
    | 'resume'
    | 'resolve'
    | 'set_disposition'
    | 'set_status'
    | string;
  note?: string;
  /** Why (status_reason + status-timeline reason). */
  reason?: string;
  /** close / confirm_fp: why the case was resolved that way. */
  resolution?: string;
  /** escalate: the analyst/team to escalate to. */
  assignee?: string;
  /** escalate: low | medium | high | critical. */
  priority?: string;
  /** Optional follow-up tags to attach as part of the action. */
  tags?: string[];
  /** set_disposition: the investigative outcome to record. */
  disposition?: Disposition;
  /** set_status: the lifecycle status to move to. */
  status?: CaseStatus;
  /** Deprecated compatibility input; the Console does not expose escalation tiers. */
  level?: number;
}

/** Response from POST /api/settings/case-id/preview (F7 live preview). */
export interface CaseIdPreview {
  samples: string[];
  valid: boolean;
  error?: string;
}

/** Preferences.case_id_format — customisable case-ID nomenclature (F7). */
export interface CaseIdFormatConfig {
  enabled: boolean;
  template: string;
  prefix: string;
  reset_period: 'none' | 'calendar_year' | 'fiscal_year' | 'fiscal_quarter';
  seq_start: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One durably stored Workspace-chat message. Assistant rows retain the original
 * response envelope so tables, provenance, cost, and memory feedback survive a
 * reload instead of degrading into plain prose. */
export interface ChatConversationMessage extends ChatTurn {
  id: string;
  created_at: string;
  response?: ChatResponse | null;
  idempotency_key?: string | null;
  model?: string | null;
  source_id?: string | null;
  source_name?: string | null;
}

/** Compact row returned for the Workspace conversation rail. */
export interface ChatConversationSummary {
  id: string;
  title: string;
  preview?: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  /** Total turns ever accepted, including turns older than the retained window. */
  total_message_count?: number;
  model?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  /** True when older turns were removed from this bounded transcript. */
  history_truncated?: boolean;
  oldest_retained_at?: string | null;
}

/** Full per-user Workspace conversation returned when a rail row is opened. */
export interface ChatConversation extends ChatConversationSummary {
  messages: ChatConversationMessage[];
}

export interface ChatConversationsResponse {
  conversations: ChatConversationSummary[];
  /** Retained row count (the backend's existing `total` contract). */
  total?: number;
  /** Total rows accepted before bounded retention evicted older conversations. */
  total_conversation_count?: number;
  history_truncated?: boolean;
  oldest_retained_at?: string | null;
  limit?: number;
  offset?: number;
}

export interface ChatTable {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated?: boolean;
}

/**
 * A memory mutation the chat engine performed on this turn (additive). The agent
 * may "remember"/"forget" facts conversationally; the UI surfaces what changed.
 */
export interface ChatMemoryAction {
  /** The operation the chat engine applied to operator memory. */
  op: 'add' | 'update' | 'delete' | 'remove' | string;
  /** The memory text added/updated (when applicable). */
  text?: string;
  /** Affected memory entry ids (when applicable). */
  ids?: string[];
}

/** A memory the chat engine suggests the operator save (additive; non-binding). */
export interface ChatMemorySuggestion {
  text: string;
  reason?: string;
}

export interface ChatResponse {
  answer: string;
  /** True only when an oversized response snapshot was compacted in saved history. */
  truncated?: boolean;
  table?: ChatTable | null;
  query?: string | null;
  discover?: Record<string, unknown> | null;
  case_id?: string | null;
  cost?: number;
  /** A memory mutation the agent performed on this turn (additive). */
  memory_action?: ChatMemoryAction | null;
  /** A memory the agent suggests the operator save (additive). */
  memory_suggestion?: ChatMemorySuggestion | null;
  /** Present only for the opt-in persisted Workspace-chat flow. */
  conversation_id?: string | null;
  /** Deterministic title derived from the first operator turn. */
  conversation_title?: string | null;
  /** Stable key echoed by persisted Workspace chat; reuse it for an explicit retry. */
  idempotency_key?: string | null;
  /** Effective execution provenance after backend defaults and overrides resolve. */
  effective_model?: string | null;
  effective_source_id?: string | null;
  effective_source_name?: string | null;
  /**
   * Optional provenance the chat engine may attach (additive; render only when
   * present). All values are UNTRUSTED — render as plain text / the `CodeBlock`
   * primitive (`soc/components/CodeBlock`), never as markup.
   */
  tools?: RationaleTool[];
  knowledge?: RationaleKnowledge[];
  reasoning?: string;
  /** Inline citations the answer references (UNTRUSTED — plain text). */
  citations?: Array<{ n: number; source: string; snippet?: string; ref?: string }>;
}

export type UsageProcessingTier = 'standard' | 'flex' | 'batch' | 'unconfirmed';

export interface UsageTierBreakdown {
  /** Actual tier recorded by the gateway; never inferred from requested policy. */
  key: UsageProcessingTier;
  cost: number;
  tokens: number;
  calls: number;
}

export interface DiscountedTierCoverage {
  /** Combined actual Flex + Batch ledger values. */
  calls: number;
  tokens: number;
  cost: number;
  /** Ratios use every ledger row as the denominator, including unconfirmed rows. */
  call_ratio: number;
  token_ratio: number;
  cost_ratio: number;
}

export interface ProcessingTierAttribution {
  confirmed_calls: number;
  /** Legacy/missing or future unknown tier values; never folded into standard. */
  unconfirmed_calls: number;
  /** Null until the ledger records requested tier and explicit fallback provenance. */
  fallback_calls: number | null;
  fallback_attribution_available: boolean;
  /** Always false: reporting must not reverse-engineer execution from policy intent. */
  requested_policy_inferred: false;
}

export interface UsageSummary {
  window_hours?: number;
  total_cost?: number;
  total_tokens?: number;
  call_count?: number;
  currency?: string;
  today_cost?: number;
  by_surface?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_model?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  by_role?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  /** Fixed standard/Flex/Batch/unconfirmed execution buckets from actual ledger rows. */
  by_processing_tier?: UsageTierBreakdown[];
  discounted_tier_coverage?: DiscountedTierCoverage;
  processing_tier_attribution?: ProcessingTierAttribution;
  cost_over_time?: Array<{ ts: number; cost: number }>;
  top_cost_drivers?: Array<{ key: string; cost: number; tokens: number; calls: number }>;
  [key: string]: unknown;
}

export interface StandupResponse {
  enabled?: boolean;
  generated_at?: string;
  window_hours?: number;
  summary?: string;
  aggregate?: Record<string, unknown>;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Branding (GET/PUT /api/branding — PUBLIC; any field may be "").
// --------------------------------------------------------------------------- //
/** Operator-configurable white-label branding. Empty strings mean "use default". */
export interface Branding {
  /** Org / customer name shown as the wordmark. */
  org_name: string;
  /** Product name (e.g. "Triage console"). */
  product_name: string;
  /** Inline data: URL for a custom logo (renders in place of the glyph). */
  logo_data_url: string;
  /** Inline data: URL for a custom browser-tab favicon, or "". */
  favicon_data_url: string;
  /** Primary accent (#rrggbb) or "". */
  accent_color: string;
  /** Secondary accent (#rrggbb) or "". */
  accent_color2: string;
  /** Default theme; "system" follows the OS preference. */
  theme: 'dark' | 'light' | 'system' | '';
  /** Welcome line shown beneath the login wordmark, or "". */
  login_subtitle: string;
  /** Footer / classification banner line, or "". */
  footer_text: string;
  /** "Docs & help" / support link target (http/https), or "". */
  support_url: string;
  /** Default colour mode for brand-new sessions (no stored user pref). */
  dark_mode_default: boolean;
  // ---- Round-4 login white-label (all bounded PLAIN text; the server validator
  // rejects any `<` #9). All optional/additive; "" == use default. ---- //
  /** Login hero headline (plain text, bounded ≤120 chars), or "". */
  login_headline?: string;
  /** Login hero body copy (plain text, bounded ≤600 chars), or "". */
  login_body?: string;
  /** A few short feature bullets shown on the login hero (plain text each). */
  login_chips?: string[];
  /** Which login arrangement to render. */
  login_layout?: 'split' | 'centered' | 'full' | string;
  /** A KEY from a small curated illustration set (validated), not a URL; "" = none. */
  login_illustration?: string;
}

// --------------------------------------------------------------------------- //
// Metrics + feedback analytics (GET /api/metrics, GET /api/feedback/stats).
// --------------------------------------------------------------------------- //
/** Aggregate analyst-feedback quality stats (also nested in Metrics.feedback). */
export interface FeedbackStats {
  graded_cases: number;
  feedback_count: number;
  /** 0..1 fraction of cases where the analyst agreed with the agent. */
  agreement_rate: number;
  /** 0..1 averages of the per-case quality scores. */
  avg_accuracy: number;
  avg_reasoning_quality: number;
  avg_action_appropriateness: number;
  /** Total analyst minutes saved across graded cases. */
  time_saved_minutes: number;
  /** Distribution of recorded actual outcomes (label → count). */
  outcome_distribution: Record<string, number>;
  [key: string]: unknown;
}

/** One day's case count for the cases-per-day trend. */
export interface CasesPerDay {
  date: string;
  count: number;
}

/**
 * One UTC-day bucket of the burndown series (GET /api/metrics → `burndown`): how many
 * cases were `opened` that day vs how many reached a terminal (resolved/closed) state.
 * Powers the open-vs-resolved BurnDownChart. Advisory / reporting only (never #3).
 */
export interface BurndownPoint {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** Cases created that day. */
  opened: number;
  /** Cases that became terminal (first terminal transition, else updated_at) that day. */
  resolved: number;
}

/**
 * One UTC-day bucket of the timing-trend series (GET /api/metrics → `timing_trend`):
 * the mean latency (minutes) for each interval that COMPLETED that day. A series is
 * `null` for a day with no sample (never a fabricated 0). Powers the "Mean time to
 * detect / respond" multi-series trend. Advisory / reporting only (never #3).
 */
export interface TimingTrendPoint {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** Mean detection latency (first event → case-open) for cases opened that day, or null. */
  mttd: number | null;
  /** Mean time-to-first-response for cases first-responded that day, or null. */
  respond: number | null;
  /** Mean time-to-resolution for cases resolved that day, or null. */
  resolve: number | null;
}

/**
 * The labelled-DASH-or-number p50/p90/mean/max block returned by the backend
 * `_stat_block` (mirrors `Metrics.posture.api.ts::StatBlock`). Numeric fields are the
 * backend DASH string `'—'` when unavailable; `reason` says why. Advisory only (#3).
 */
export interface StatBlock {
  p50: number | string;
  p90: number | string;
  mean: number | string;
  max: number | string;
  count: number;
  available: boolean;
  /** Honest reason the block is unavailable (plain text). */
  reason: string;
}

/**
 * The lifecycle-interval rollup on GET /api/metrics/posture (`posture.lifecycle`). MTTA
 * (acknowledge), MTTR (resolve), dwell (first-response) AND — additive — `mttd_minutes`
 * (real detection latency: the cluster's first event → case-open, from the case's
 * `first_seen_millis`; a labelled DASH when no case carries a first-event instant).
 */
export interface LifecycleIntervals {
  mtta_minutes: StatBlock;
  mttr_minutes: StatBlock;
  dwell_minutes: StatBlock;
  /** Mean-time-to-detect (detection latency). Additive; advisory only (never #3). */
  mttd_minutes: StatBlock;
}

/** Verdict-class breakdown returned by /api/metrics. */
export interface VerdictBreakdown {
  TRUE_POSITIVE: number;
  FALSE_POSITIVE: number;
  NEEDS_HUMAN: number;
  /** Unverdicted cases. */
  none: number;
  [key: string]: number;
}

/** Honest case-level knowledge-reference coverage from GET /api/metrics. */
export interface RetrievalHistoryMetrics {
  status: 'available' | 'unavailable' | 'insufficient_evidence';
  available: boolean;
  reason: string;
  loaded_cases: number;
  total_cases: number;
  truncated: boolean;
  eligible_cases: number;
  history_available_cases: number;
  history_unavailable_cases: number;
  completed_attempt_cases: number;
  cases_with_references: number | null;
  reference_coverage: number | null;
  formula: string;
}

/** GET /api/metrics — the analytics dashboard payload. */
export interface Metrics {
  total_cases: number;
  open_cases: number;
  needs_human_cases: number;
  closed_cases: number;
  by_status: Record<string, number>;
  /** Disposition (investigative outcome) breakdown (F8). */
  by_disposition?: Record<string, number>;
  by_verdict: VerdictBreakdown;
  persona_usage: Record<string, number>;
  playbook_usage: Record<string, number>;
  /** Mean normalised risk score (0..100). */
  avg_risk_score: number;
  /**
   * Active Risk Index (Round-7; additive) — the canonical top-right instrument on the
   * Cyber Defence Center. The mean deterministic `risk_score` over NON-TERMINAL
   * (still-open) cases only, 0..100 (0.0 when there are no open cases). Distinct from
   * `avg_risk_score` (which spans ALL cases). Advisory presentation only (never #3).
   */
  active_risk_index?: number;
  /** How many non-terminal (open) cases the `active_risk_index` mean was taken over. */
  active_risk_case_count?: number;
  /** Mean time-to-resolution in minutes. */
  mttr_minutes: number;
  resolved_count: number;
  cases_per_day: CasesPerDay[];
  /**
   * Open-vs-resolved per UTC day over the trend window (additive) — the BurnDownChart
   * series. Each point is `{date, opened, resolved}`. Advisory only (never #3).
   */
  burndown?: BurndownPoint[];
  /**
   * Per-UTC-day mean detect/respond/resolve latency (minutes; additive) — the
   * "Mean time to detect / respond" trend series. A series is `null` for a day with no
   * sample. Advisory only (never #3).
   */
  timing_trend?: TimingTrendPoint[];
  feedback: FeedbackStats;
  /**
   * Case-level reference coverage only. Missing/mixed/truncated history has a null
   * headline and is never presented as zero or as retrieval quality.
   */
  retrieval_history?: RetrievalHistoryMetrics;
  /** Compact cost summary (shares the UsageSummary shape; fields optional). */
  cost: Partial<UsageSummary> & Record<string, unknown>;
  window_hours?: number;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Bucketed metric trends (GET /api/metrics/trends?window_hours=) — the hover-
// trendline series behind the Overview (Cyber Defence Center) landing metrics.
// Buckets are zero-filled across the whole window and cohort-bucketed by case
// `created_at`; `fp_rate` mirrors the posture false-positive-rate semantics per
// bucket (null when the bucket has no verdicted denominator) and `alerts` comes
// from the durable noise counters (null when counters are absent). Aggregate
// counts only — no raw log text (#9). Advisory presentation only — never #3.
// --------------------------------------------------------------------------- //

/** One zero-filled trend bucket. `t` is the bucket-start instant (UTC ISO). */
export interface MetricsTrendBucket {
  t: string;
  /** Cases created in this bucket. */
  new_cases: number;
  /** Of this bucket's arrival cohort: now closed / auto-closed / FP-verdicted /
   *  needs-human / escalated. */
  closed: number;
  auto_closed: number;
  /**
   * The three-way LAST-WRITER `decision_by` partition of `closed`, over the same
   * policy-excluded graded cohort: `auto_closed` (agent) + `human_closed` (analyst) +
   * `system_closed` (the honest residual — deterministic SYSTEM routing plus legacy
   * records carrying no provenance) === `closed`, exactly, in every bucket. Never fold
   * `system_closed` into either side. Optional: older backends omit both, so a consumer
   * must treat their absence as "close attribution not reported", never as zero.
   *
   * HONESTY: `decision_by` records the LAST decider, not proof of who did the work — an
   * agent-closed case a human later merely acknowledges migrates into `human_closed`.
   */
  human_closed?: number;
  system_closed?: number;
  false_positives: number;
  needs_human: number;
  escalated: number;
  /** Cohort cases counted ONCE that reached a human (NEEDS_HUMAN verdict OR
   *  escalated). `needs_human` and `escalated` overlap — never sum them;
   *  chart this field instead. Optional: older backends omit it. */
  sent_to_human?: number;
  /** Percent 0-100, or null when the bucket has no verdicted denominator. */
  fp_rate: number | null;
  /** Raw alerts ingested (durable noise counters), or null when unavailable. */
  alerts: number | null;
}

/**
 * GET /api/metrics/trends — the bucketed trend payload (24-48 buckets spanning
 * the requested window). `truncated` reports a bounded case scan honestly.
 */
export interface MetricsTrends {
  window_hours: number;
  bucket_minutes: number;
  generated_at: string;
  buckets: MetricsTrendBucket[];
  /** True when the bounded case fetch could not cover the whole window. */
  truncated: boolean;
  store_total: number;
  fetched: number;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Agent-improvement evidence (GET /api/metrics/agent-improvement).
// Aggregate-only and advisory: this contract contains no source/case identifiers,
// raw evidence, model calls, or deterministic decision input.
// --------------------------------------------------------------------------- //
export type AgentEvidenceStatus =
  | 'enough_data'
  | 'insufficient_evidence'
  | 'unavailable'
  | 'not_applicable';

export interface AgentComparisonReading {
  value: number | null;
  unadjusted_value?: number | null;
  available: boolean;
  status: AgentEvidenceStatus;
  reason: string;
  sample_count: number;
  minimum_sample: number;
  total_graded_cases?: number;
  comparable_graded_cases?: number;
  [key: string]: unknown;
}

export interface AgentComparisonMetric {
  label: string;
  unit: 'ratio' | 'minutes' | string;
  good_direction: 'up' | 'down';
  current: AgentComparisonReading;
  baseline: AgentComparisonReading;
  delta: { percentage_points?: number | null; relative?: number | null };
  direction: 'improving' | 'stable' | 'regressing' | 'insufficient_evidence';
  definition: {
    formula: string;
    numerator: string;
    denominator: string;
    eligibility: string;
    caveats: string;
  };
}

export interface AgentFalseNegativeReading {
  value: number | null;
  confirmed_positive_count: number;
  missed_positive_count: number;
}

export interface AgentReopenReading {
  candidate_agent_terminal_decisions: number;
  eligible_agent_terminal_decisions: number;
  right_censored_decisions: number;
  human_reopens: number;
  rate: number | null;
  follow_up_hours: number;
}

export interface AgentImprovementGuardrails {
  confirmed_false_negative_rate: {
    status: AgentEvidenceStatus;
    minimum_sample: number;
    current: AgentFalseNegativeReading;
    baseline: AgentFalseNegativeReading;
    material_increase_threshold: number;
    breached: boolean | null;
    definition: string;
  };
  reopen_after_agent_close_rate: {
    status: AgentEvidenceStatus;
    minimum_sample: number;
    current: AgentReopenReading;
    baseline: AgentReopenReading;
    material_increase_threshold: number;
    breached: boolean | null;
    caveat: string;
  };
}

export interface AgentImprovementCaseMix {
  dimensions: string[];
  minimum_per_stratum: number;
  baseline_total: number;
  current_total: number;
  baseline_covered: number;
  current_covered: number;
  comparable_mix_coverage: number | null;
  baseline_mix_coverage: number | null;
  current_mix_coverage: number | null;
  comparable_strata: number;
  baseline_only_strata: number;
  current_only_strata: number;
  suppressed_strata: number;
  adjusted_baseline_agreement: number | null;
  adjusted_current_agreement: number | null;
  adjusted_baseline_correction_rate: number | null;
  adjusted_current_correction_rate: number | null;
}

export interface AgentImprovementDailyPoint {
  date: string;
  window: 'current' | 'baseline';
  analyst_reported_agreement: number | null;
  correction_rate: number | null;
  false_negative_rate: number | null;
  review_turnaround_p50_minutes: number | null;
  quality_sample_count: number;
  confirmed_positive_sample_count: number;
  turnaround_sample_count: number;
  status: 'enough_data' | 'collecting_evidence';
}

export type AgentOutcomeDirection =
  | 'improving'
  | 'stable'
  | 'regressing'
  | 'up'
  | 'down'
  | 'insufficient_evidence';

export interface AgentOutcomeDefinition {
  formula: string;
  numerator: string;
  denominator: string;
  eligibility: string;
  caveats: string;
}

export interface AgentRecordedCaseCostPeriod {
  total_cost: number;
  call_count: number;
  costed_cases: number;
  cost_per_costed_case: number | null;
  cost_per_day: number;
}

export interface AgentRecordedCaseCostOutcome {
  label: string;
  unit: 'USD' | string;
  currency: 'USD' | string;
  status: AgentEvidenceStatus;
  reason: string;
  current: AgentRecordedCaseCostPeriod;
  baseline: AgentRecordedCaseCostPeriod;
  delta: {
    cost_per_day_relative: number | null;
    cost_per_costed_case_relative: number | null;
  };
  direction: AgentOutcomeDirection;
  cost_per_day_direction: AgentOutcomeDirection;
  definition: AgentOutcomeDefinition;
}

export interface AgentObservedTimeSavedPeriod {
  status: AgentEvidenceStatus;
  reason: string;
  human_owned_closure_p50_minutes: number | null;
  agent_closed_p50_minutes: number | null;
  observed_difference_minutes_per_case: number | null;
  observed_aggregate_elapsed_difference_minutes: number | null;
  /** Legacy positive-only projection; null when the observed cohort difference is negative. */
  estimated_total_minutes_saved: number | null;
  human_owned_closure_count: number;
  agent_closed_count: number;
  analyst_reported_total_minutes_saved: number | null;
  analyst_reported_sample_count: number;
  minimum_sample_per_owner: number;
}

export interface AgentObservedTimeSavedOutcome {
  label: string;
  unit: 'minutes' | string;
  status: AgentEvidenceStatus;
  reason: string;
  current: AgentObservedTimeSavedPeriod;
  baseline: AgentObservedTimeSavedPeriod;
  delta: { minutes_per_case: number | null };
  direction: AgentOutcomeDirection;
  definition: AgentOutcomeDefinition;
}

export interface AgentConfirmedPositivePeriod extends AgentComparisonReading {
  confirmed_positive_cases: number;
  outcome_evaluable_cases: number;
}

export interface AgentConfirmedPositiveCaseRateOutcome {
  label: string;
  unit: 'ratio' | string;
  status: AgentEvidenceStatus;
  reason: string;
  current: AgentConfirmedPositivePeriod;
  baseline: AgentConfirmedPositivePeriod;
  delta: { percentage_points: number | null };
  direction: AgentOutcomeDirection;
  definition: AgentOutcomeDefinition;
}

export interface AgentTruePositiveAlertYieldPeriod {
  value: null;
  true_positive_alerts: null;
  total_alerts: number | null;
  lineage_coverage: null;
}

export interface AgentTruePositiveAlertYieldOutcome {
  label: string;
  unit: 'ratio' | string;
  status: 'unavailable';
  reason: string;
  current: AgentTruePositiveAlertYieldPeriod;
  baseline: AgentTruePositiveAlertYieldPeriod;
  delta: { percentage_points: null };
  direction: 'insufficient_evidence';
  supported_alternative: 'confirmed_positive_case_rate';
  definition: AgentOutcomeDefinition;
}

export interface AgentAlertVolumePeriod {
  ingested_alerts: number | null;
  after_clustering_alerts: number | null;
  clustering_reduction_count: number | null;
  clustering_reduction_rate: number | null;
  ingested_per_day: number | null;
  after_clustering_per_day: number | null;
}

export interface AgentAlertVolumeOutcome {
  label: string;
  unit: 'alerts' | string;
  status: AgentEvidenceStatus;
  reason: string;
  window_basis: string;
  current: AgentAlertVolumePeriod;
  baseline: AgentAlertVolumePeriod;
  delta: {
    ingested_per_day_relative: number | null;
    after_clustering_per_day_relative: number | null;
  };
  direction: AgentOutcomeDirection;
  ingested_direction: AgentOutcomeDirection;
  after_clustering_direction: AgentOutcomeDirection;
  definition: AgentOutcomeDefinition;
  /**
   * Whether the two compared windows' per-SEVERITY-BAND splits may be compared at all.
   * The volume totals above are band-independent and stay comparable either way; the
   * per-band comparison is withheld (with a measured reason) when the two windows
   * cannot be shown to have banded on the same declared severity ceiling — the durable
   * counters store bands, not raw severities, so a historical split can never be
   * re-projected onto a changed ladder. Optional: an older backend omits it.
   */
  severity_band_comparison?: { available: boolean; reason: string };
}

export interface AgentTuningContextPeriod {
  applied_changes: number;
  rolled_back_changes: number;
}

export interface AgentTuningContextOutcome {
  label: string;
  status: AgentEvidenceStatus;
  reason: string;
  current: AgentTuningContextPeriod;
  baseline: AgentTuningContextPeriod;
  delta: { applied_changes: number };
  direction: AgentOutcomeDirection;
  cooccurring_after_clustering_direction: AgentOutcomeDirection;
  causal_claim: false;
  model_fine_tuning_evidence: false;
  definition: AgentOutcomeDefinition;
}

export interface AgentSourceGuidanceItem {
  id?: string;
  telemetry_kind?: string;
  title?: string;
  rationale?: string;
  affected_context?: string;
  evidence_gap_count?: number;
}

export interface AgentSourceGuidanceOutcome {
  status:
    | 'ready'
    | 'collecting_evidence'
    | 'insufficient_evidence'
    | 'unavailable'
    | 'not_available';
  reason: string;
  items: AgentSourceGuidanceItem[];
  long_term_objective: boolean;
  required_evidence: string;
}

export interface AgentOperationalOutcomes {
  recorded_case_cost: AgentRecordedCaseCostOutcome;
  observed_time_saved: AgentObservedTimeSavedOutcome;
  confirmed_positive_case_rate: AgentConfirmedPositiveCaseRateOutcome;
  true_positive_alert_yield: AgentTruePositiveAlertYieldOutcome;
  alert_volume: AgentAlertVolumeOutcome;
  tuning_context: AgentTuningContextOutcome;
  source_guidance: AgentSourceGuidanceOutcome;
}

export interface AgentPeriodComparisonMetric {
  status: AgentEvidenceStatus;
  reason: string;
  current: number | null;
  baseline: number | null;
  current_sample_count: number;
  baseline_sample_count: number;
  delta: number | null;
  direction: AgentOutcomeDirection;
}

export interface AgentPeriodComparison {
  label: string;
  status: AgentEvidenceStatus;
  reason: string;
  current: { start: string; end_exclusive: string; days: number };
  baseline: { start: string; end_exclusive: string; days: number };
  calendar_period: false;
  metrics: {
    analyst_reported_verdict_agreement: AgentPeriodComparisonMetric;
    material_analyst_correction_rate: AgentPeriodComparisonMetric;
    human_review_turnaround: AgentPeriodComparisonMetric;
    confirmed_positive_case_rate: AgentPeriodComparisonMetric;
  };
  /** Operational outcomes recomputed over these exact equal-length windows. */
  outcomes: AgentOperationalOutcomes;
}

export interface AgentImprovementEvidence {
  generated_at: string;
  synthetic: boolean;
  windows: {
    as_of_exclusive: string;
    current: { start: string; end_exclusive: string; days: number };
    baseline: { start: string; end_exclusive: string; days: number };
    timezone: 'UTC';
    complete_days_only: true;
  };
  headline: {
    state: 'improving' | 'stable' | 'mixed' | 'guardrail_breach' | 'insufficient_evidence';
    reason: string;
    improving_signals: number;
    regressing_signals: number;
    signal_domains: {
      analyst_grade_quality: 'improving' | 'stable' | 'regressing' | 'insufficient_evidence';
      human_review_turnaround: 'improving' | 'stable' | 'regressing' | 'insufficient_evidence';
    };
    guardrails_ready: boolean;
    comparable_mix_coverage: number | null;
    minimum_comparable_mix_coverage: number;
    composite_score: null;
  };
  metrics: {
    analyst_reported_verdict_agreement: AgentComparisonMetric;
    material_analyst_correction_rate: AgentComparisonMetric;
    human_review_turnaround: AgentComparisonMetric;
  };
  guardrails: AgentImprovementGuardrails;
  case_mix: AgentImprovementCaseMix;
  daily_points: AgentImprovementDailyPoint[];
  /** Additive operational domains. Omitted by older compatible backends. */
  outcomes?: AgentOperationalOutcomes | null;
  /** True 7d/7d and rolling 28d/28d trend checks. Omitted by older backends. */
  period_comparisons?: {
    week_over_week: AgentPeriodComparison;
    month_over_month: AgentPeriodComparison;
  } | null;
  exclusions: Record<string, number>;
  provenance: {
    truncated: boolean;
    store_total: number;
    fetched: number;
    aggregate_only: true;
    case_ids_included: false;
    billing: 'none';
    decision_authority: 'reporting_only';
  };
}

// --------------------------------------------------------------------------- //
// Provenance (Round-7 #9) — WHO produced a field's value: the raw log/SIEM `source`,
// the `ai` agent (LLM verdict/confidence), or deterministic `code` (risk/priority
// math). The ONE shared provenance vocabulary consumed by `ProvenanceTag` + the
// `DataTableColumn.provenance` header tag + the per-cell severity provenance.
// --------------------------------------------------------------------------- //
export type Provenance = 'source' | 'ai' | 'code';

// --------------------------------------------------------------------------- //
// Noise-Reduction funnel (Round-7 ★) — GET /api/metrics/noise-reduction?window_hours=.
//
// A durable "total raw alerts by severity → what the AI reduced it to" funnel: the
// `ingested`/`clustered` stages come from durable noise counters (by severity band),
// the `cases` + outcome stages from a live tally of the case store. Powers the
// "Noise reduced by N%" headline on the Cyber Defence Center. Every value is an
// aggregate count / label (no raw log text). Advisory presentation only — never #3.
// --------------------------------------------------------------------------- //
/**
 * A per-severity-band count map for one funnel stage. Keyed by the 5 severity bands
 * (critical/high/medium/low/info); a band is omitted when its count is zero. The open
 * index signature keeps any additional/forward band round-tripping unharmed.
 */
export interface NoiseSeverityBreakdown {
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  info?: number;
  [band: string]: number | undefined;
}

/**
 * One stage of the noise-reduction funnel. `key` walks the pipeline
 * (ingested → clustered → cases → auto_cleared → escalated → needs_human → `closed`;
 * a backend may append a `true_positive` residual). The trailing `closed` stage
 * (label "Closed by human") is the count of cases a HUMAN drove to a terminal state
 * (terminal AND NOT AI-auto-cleared) — the end of the linear flow the dashboard renders
 * as ingested → clustered → cases → auto_cleared → escalated → closed. `source` records
 * whether the stage was tallied from durable `counters` or the live `cases` store;
 * `deterministic` marks the stages produced by deterministic code (vs the LLM-influenced
 * `cases` stage and the human `closed` stage). `total` is the stage's headline count and
 * `by_severity` its per-band split.
 */
export interface NoiseStage {
  key: string;
  /** Operator-facing label for the stage (plain text). */
  label: string;
  source: 'counters' | 'cases' | string;
  deterministic: boolean;
  total: number;
  by_severity: NoiseSeverityBreakdown;
}

/**
 * GET /api/metrics/noise-reduction — the full funnel contract (Round-7 §D). `reduction`
 * percentages fall back to the em-dash placeholder `'—'` when they cannot be computed
 * (e.g. counters still warming up). `counters.available:false` (with a null `ingested`
 * total) signals the durable counters are warming up so the UI degrades to a case-only
 * funnel. `cases_meta` reports store-fetch truncation for an honest partial-data note.
 */
export interface NoiseReduction {
  window_hours: number;
  /** When the aggregation was computed (ISO). */
  generated_at: string;
  /** The severity bands, highest → lowest, the `by_severity` maps are keyed by. */
  bands: string[];
  stages: NoiseStage[];
  /** Candidates removed before clustering (suppressed rules / ignored feeds). */
  drops: { suppressed: number; ignored: number };
  reduction: {
    /** Overall % of raw alerts the AI cut, or `'—'` when not computable. */
    overall_pct: number | '—';
    /** % of alerts kept away from a human (auto-cleared), or `'—'`. */
    human_reduction_pct: number | '—';
  };
  counters: {
    /** Whether durable ingest counters are populated for this window. */
    available: boolean;
    /** When the counters began accumulating (ISO), or null when unavailable. */
    since: string | null;
    /** True while counters are still warming up (partial coverage of the window). */
    incomplete: boolean;
  };
  cases_meta: {
    /** True when the case-store fetch hit its cap (funnel counts are a partial tally). */
    truncated: boolean;
    /** Best-effort total cases in the store for the window. */
    store_total: number;
    /** How many cases were actually fetched + tallied. */
    fetched: number;
  };
  [key: string]: unknown;
}

/**
 * One selected-window case lineage returned by the lazy Noise Reduction drill-down.
 * ``clustering`` is the same bounded/redacted projection used by Threat Context;
 * it never contains raw alert ids or payloads.
 */
export interface NoiseLineageRow {
  case_id: string;
  display_id: string;
  created_at: string;
  severity: string;
  clustering: {
    available?: boolean;
    cluster_id?: string;
    input_count?: number;
    input_refs?: string[];
    input_refs_truncated?: number;
    source_count?: number;
    source_breakdown?: Record<string, number>;
    correlation?: {
      mode?: string;
      threshold?: number;
      window_seconds?: number;
      group_by?: string;
      observed_count?: number;
      matched_rule?: string;
      rule_values?: string[];
      reason?: string;
    };
    opened_case?: {
      case_id?: string;
      display_id?: string;
      status?: string;
      verdict?: string;
    };
    limitations?: string;
    [key: string]: unknown;
  };
  outcome: {
    key: 'auto_cleared' | 'closed_by_human' | 'escalated' | 'awaiting_analyst' | string;
    label: string;
    /** Aggregate Noise Reduction branch that currently accounts for the row. */
    funnel_stage: 'auto_cleared' | 'escalated' | 'closed' | string;
    terminal: boolean;
    status: string;
    verdict: string;
    disposition: string;
    decision_by: string;
  };
}

/** GET /api/metrics/noise-reduction/lineage — bounded, selected-window drill-down. */
export interface NoiseLineage {
  window_hours: number;
  generated_at: string;
  rows: NoiseLineageRow[];
  meta: {
    returned: number;
    window_cases_in_fetched_page: number;
    fetched_cases: number;
    store_total: number;
    limit: number;
    truncated: boolean;
    store_truncated: boolean;
  };
  limitations: string;
}

// --------------------------------------------------------------------------- //
// Operator diagnostics — the SILENT failures, made observable.
// GET /api/diagnostics/health (settings:read) · GET /api/metrics/auto-close-health
// (metrics:view). Both are read-only, seed-free, and ADVISORY: nothing here is ever
// an input to the deterministic close/escalate decision (#3).
//
// THE CONTRACT THAT MATTERS: `alerts` are positively-detected conditions and
// `unknowns` are signals that could NOT be evaluated. They are separate lists on
// purpose — an empty `alerts` with a non-empty `unknowns` is "we could not tell",
// never "everything is fine". There is deliberately no composite health score.
// --------------------------------------------------------------------------- //

/** One diagnostics finding — an entry in either `alerts` or `unknowns`. */
export interface DiagnosticsFinding {
  id: string;
  /** `critical` | `warning` on an alert; always `unknown` on an unknown. */
  severity: string;
  title: string;
  /** Plain-text explanation (rendered escaped, never as markup). */
  detail: string;
  /** Suggested operator remediation; may be empty. */
  remediation: string;
}

/** The last RAG projection's per-source before/after outcome (in-process only). */
export interface DiagnosticsProjection {
  /** False until a projection has run IN THIS PROCESS — reported, never faked as zero. */
  available: boolean;
  /** `recorded` | `not_yet_projected`. */
  state: string;
  scope: string;
  reason: string;
  sources: Record<string, Record<string, unknown>>;
  shrank_sources: string[];
  collapsed_sources: string[];
}

/** How much analyst-confirmed ground truth the fetched case history actually holds. */
export interface PrecedentGroundTruth {
  analyst_confirmed_cases: number;
  terminal_cases: number;
  scanned_cases: number;
  by_outcome: Record<string, number>;
  by_evidence_source: Record<string, number>;
  zero_analyst_confirmed_cases: boolean;
  truncated: boolean;
  store_total: number;
  fetched: number;
}

/**
 * The per-case precedent fact. `status` is one of `qualified` | `insufficient` |
 * `conflicting` | `not_retrieved` | `unavailable` | `disabled` | `not_applicable`.
 */
export interface PrecedentSignalRecord {
  status: string;
  reason: string;
  qualifies: boolean;
  rule_identity: string;
  rule_ids: string[];
  confirmed_false_positive: number;
  confirmed_true_positive: number;
  retrieved_matching: number;
  top_score: number | null;
  min_confirmed: number;
  min_similarity: number;
  truncated: boolean;
}

/** The operator declaration(s) that closed a case deterministically, with no LLM call. */
export interface AnalystPolicyRecord {
  policy_ids: string[];
  rule_ids: string[];
  reasons: string[];
}

/** Precedent-corpus health: size, per-source counts, and the explicit starvation flag. */
export interface PrecedentCorpusHealth {
  /** The corpus itself could be read at all. */
  available: boolean;
  /** The analyst-confirmed count below is a trustworthy TOTAL (not a lower bound). */
  known: boolean;
  reason: string;
  /** `ok` | `starved` | `disabled` | `unknown`. */
  status: string;
  status_reason: string;
  rag_enabled: boolean;
  precedent_source: string;
  precedent_source_enabled: boolean;
  /** True when the lower-trust `model_unconfirmed` tier shares this corpus source. */
  unconfirmed_tier_enabled: boolean;
  precedent_documents: number;
  precedent_chunks: number;
  analyst_confirmed_precedent_documents: number;
  analyst_confirmed_count_exact: boolean;
  /** THE flag: "0 analyst-confirmed precedents available", as a diagnosable state. */
  zero_analyst_confirmed_precedents: boolean;
  /** True only when the source is ENABLED and positively known to be empty. */
  starved: boolean;
  total_chunks: number;
  total_documents: number;
  chunks_by_source: Record<string, number>;
  documents_by_source: Record<string, number>;
  projection: DiagnosticsProjection;
  ground_truth: PrecedentGroundTruth;
}

/** Analyst-confirmed precedent held for ONE rule identity (the canonical rule set). */
export interface RulePrecedentCounts {
  rule_identity: string;
  rule_ids: string[];
  false_positive: number;
  true_positive: number;
  total: number;
  unanimous_false_positive: boolean;
}

/** How analyst-confirmed precedent is spread across rule identities. */
export interface PrecedentDistribution {
  /** False ONLY when the corpus could not be read — an empty map is a real zero. */
  available: boolean;
  reason: string;
  /** The corpus read hit its bound, so every count is a LOWER bound. */
  truncated: boolean;
  /** The operator turned the precedent source OFF — configured, not unmeasurable. */
  disabled: boolean;
  scanned_chunks: number;
  rule_identities: number;
  /** Precedent projected before rule identity existed: retrievable, not rule-matchable. */
  unattributed_documents: number;
  total_confirmed: number;
  returned: number;
  by_rule: RulePrecedentCounts[];
}

/** A rule whose precedent is abundant but is NOT changing the outcome. */
export interface FutileRule {
  rule_identity: string;
  rule_ids: string[];
  rules: string;
  cases: number;
  measurable_cases: number;
  /** Cases that never reached a decision — excluded from the auto-close rate. */
  undecided: number;
  routed_to_human: number;
  auto_closed: number;
  analyst_closed: number;
  /** Cases a human had to look at: routed to one, or closed by one. */
  human_involved: number;
  policy_closed: number;
  auto_close_rate: number | null;
  analyst_confirmed_benign: number;
  analyst_confirmed_malicious: number;
  detail: string;
  remediation: string;
}

/** Is the precedent an operator has built actually changing anything? */
export interface PrecedentEffectiveness {
  promotion_enabled: boolean;
  promotion_min_confirmed: number;
  window_size: number;
  window_stratified: boolean;
  distribution: PrecedentDistribution;
  /** True only when the futility report actually RAN. An empty `futile_rules` with
   *  this false means "not measured", never "measured, nothing found". */
  futility_measured: boolean;
  /** Why it did not run, when it did not. */
  futility_reason: string;
  futile_rules: FutileRule[];
  futile_rule_count: number;
}

/** The in-place SQL schema-migration outcome. `failed` breaks strict audit writes. */
export interface SchemaMigrationHealth {
  available: boolean;
  /** `ok` | `failed` | `not_applicable`. */
  state: string;
  state_backend: string;
  detail: string;
  /** Remediation SQL, when the backend supplied one. */
  remediation: string;
  failed: boolean;
  reason: string;
}

/** One window's auto-close tally. `rate` is the DASH string when it cannot be measured. */
export interface AutoCloseWindow {
  decided: number;
  auto_closed: number;
  routed_to_human: number;
  analyst_decided: number;
  /** 0..1 — or the backend DASH string `'—'` when `available` is false. */
  rate: number | string;
  available: boolean;
  /** Honest reason the rate is unavailable (plain text). Never a fabricated 0. */
  reason: string;
}

/** A read-only mirror of the operator's auto-close policy (display only, #3). */
export interface AutoClosePolicySnapshot {
  available: boolean;
  any_enabled: boolean;
  false_positive_enabled: boolean;
  true_positive_enabled: boolean;
  reason: string;
}

/**
 * The explicit auto-close health status. NEVER a score:
 * `disabled` (configured off) · `no_volume` (nothing decided — a quiet period, not an
 * outage) · `collapsed` (rate fell to ~0 while volume held steady — THE outage signal) ·
 * `never_fired` · `degraded` · `insufficient_evidence` · `ok`.
 */
export type AutoCloseHealthStatus =
  | 'disabled'
  | 'no_volume'
  | 'collapsed'
  | 'never_fired'
  | 'degraded'
  | 'insufficient_evidence'
  | 'ok';

/** GET /api/metrics/auto-close-health — the rolling auto-close signal. */
export interface AutoCloseHealth {
  window_hours: number;
  generated_at: string;
  current: AutoCloseWindow;
  baseline: AutoCloseWindow;
  lifetime: AutoCloseWindow;
  policy: AutoClosePolicySnapshot;
  status: AutoCloseHealthStatus | string;
  reason: string;
  collapsed: boolean;
  volume_steady: boolean;
  comparable: boolean;
  needs_attention: boolean;
  thresholds: Record<string, number>;
  truncated: boolean;
  store_total: number;
  fetched: number;
}

/** GET /api/diagnostics/health — the operator diagnostics roll-up. */
export interface DiagnosticsHealth {
  generated_at: string;
  window_hours: number;
  demo_active: boolean;
  state_backend: string;
  precedent_corpus: PrecedentCorpusHealth;
  /** Per-rule precedent distribution + the "more confirmations will not help" finding. */
  precedent_effectiveness?: PrecedentEffectiveness;
  schema_migration: SchemaMigrationHealth;
  auto_close: AutoCloseHealth;
  /** POSITIVELY DETECTED conditions. */
  alerts: DiagnosticsFinding[];
  /** Signals that could NOT be evaluated. Not problems — and not a clean bill either. */
  unknowns: DiagnosticsFinding[];
  alert_count: number;
  unknown_count: number;
}

/**
 * GET /api/rag/precedent/bootstrap — preview of the bulk lower-trust ratification
 * (POST adds `ratified`/`indexed`/`remaining`). Read-only; the tier is never enabled here.
 */
export interface PrecedentBootstrapStatus {
  tier_enabled: boolean;
  use_resolved_cases: boolean;
  use_unconfirmed_resolved_cases: boolean;
  trust_class: string;
  provenance: string;
  acknowledgement_required: string;
  max_batch: number;
  guards: UnconfirmedPrecedentConfig;
  /** Explicit statements of what bootstrapping does NOT do (plain text). */
  does_not: string[];
  eligible: number;
  pending: number;
}

// --------------------------------------------------------------------------- //
// Knowledge / RAG corpus management (GET/POST/DELETE /api/rag/*).
// --------------------------------------------------------------------------- //
/** One retrieved chunk (a search hit or a document's constituent chunk). */
export interface RagChunk {
  /** The chunk text (UNTRUSTED — render fenced, never as markup). */
  text: string;
  /** The source corpus the chunk came from (e.g. "runbook", "case", "import"). */
  source: string;
  /** Relevance score (present on search hits; absent for raw document chunks). */
  score?: number;
  /** This chunk's index within its parent document (present on document chunks). */
  chunk_index?: number;
  /** Arbitrary per-chunk metadata the backend attached. */
  metadata?: Record<string, unknown>;
}

/** A document indexed into the RAG corpus (GET /api/rag/documents). */
export interface RagDocument {
  document_id: string;
  title: string;
  source: string;
  chunk_count: number;
  embedding_model?: string;
  dim?: number;
  added_at?: string;
  tags?: string[];
  /** Populated only by GET /api/rag/documents/{id} (the drill-in view). */
  chunks?: RagChunk[];
  [key: string]: unknown;
}

/** GET /api/rag/documents — the corpus listing. */
export interface RagDocumentsResponse {
  documents: RagDocument[];
  count: number;
}

/** GET /api/rag/stats — corpus health header. */
export interface RagStats {
  total_chunks: number;
  by_source: Record<string, number>;
  embedding_model?: string;
  dim?: number;
  document_count: number;
  [key: string]: unknown;
}

/** POST /api/rag/import (201/200) — the indexed document summary. */
export interface RagImportResult {
  document_id: string;
  title: string;
  source: string;
  chunk_count: number;
  [key: string]: unknown;
}

/** GET /api/rag/search — what RAG would retrieve for a query. */
export interface RagSearchResponse {
  query: string;
  count: number;
  chunks: RagChunk[];
}

// --------------------------------------------------------------------------- //
// Operator memory (durable facts the agents always know) — /api/memory/*.
// --------------------------------------------------------------------------- //
/** One durable memory entry (mirrors the backend `MemoryEntry`). */
export interface MemoryEntry {
  id: string;
  /** The fact text (UNTRUSTED when agent-authored — render as plain text). */
  text: string;
  category?: string;
  tags?: string[];
  /** Who authored the memory — a human operator, or an agent (conversationally). */
  source: 'human' | 'agent' | string;
  author?: string;
  /** Only approved entries may be injected as trusted operator context. */
  review_status?: 'approved' | 'pending';
  approved_by?: string | null;
  approved_at?: string | null;
  created_at?: string;
  updated_at?: string;
  /** Inactive entries are retained but not injected into prompts. */
  active: boolean;
  [key: string]: unknown;
}

/** GET /api/memory — the memory listing. */
export interface MemoryResponse {
  entries: MemoryEntry[];
  count: number;
}

// --------------------------------------------------------------------------- //
// Approval queue — agent-drafted proposals (GET/POST /api/proposals/*).
// --------------------------------------------------------------------------- //
/** The kinds of recommendation the agent can draft for human approval. */
export type ProposalKind = 'suppression' | 'memory' | 'tuning' | 'automation_ack' | string;

/** The lifecycle state of a drafted proposal. */
export type ProposalStatus = 'pending' | 'applying' | 'approved' | 'rejected' | string;

/**
 * One agent-drafted recommendation awaiting human approval.
 *
 * Nothing here is applied automatically: a `suppression` rule only goes live, and
 * a `memory` fact is only saved, once a human approves it. `payload` is
 * kind-specific and SOURCE-INFLUENCED (it derives from log events), so every value
 * inside it — and `rationale` — is UNTRUSTED and must render as plain text / the
 * `InlineCode` primitive (`soc/components/CodeBlock`), never as markup.
 *
 * - `kind === 'suppression'` → `payload` carries `{ field, value, reason? }` (the
 *   candidate `field == value` rule).
 * - `kind === 'memory'` → `payload` carries `{ text, category? }` (the candidate
 *   durable fact).
 * - `kind === 'tuning'` → `payload` carries a bounded threshold change or a
 *   review-only evidence/history acknowledgement. The payload explains why the
 *   proposal exists and the exact recommended operator action.
 * - `kind === 'automation_ack'` → `payload` carries the automation rule/checkpoint
 *   context. Approval records acknowledgement only and materialises nothing.
 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  /** Kind-specific, source-influenced payload — render its values as plain text. */
  payload: Record<string, unknown>;
  /** Why the agent drafted this (UNTRUSTED — render as plain text). */
  rationale: string;
  /** The agent's confidence in the recommendation (0..1). */
  confidence: number;
  /** The case(s) that motivated this proposal. */
  source_case_ids: string[];
  created_by: string;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  /** Durable first decision intent; retries cannot switch approve/reject. */
  decision_intent?: 'approve' | 'reject' | null;
  /** Stable append-only audit timestamp reused by a retry. */
  decision_audit_at?: string | null;
  applying_at?: string | null;
  /** Last failed materialisation/finalisation attempt, surfaced for a safe retry. */
  approval_error?: string | null;
  expires_at?: string | null;
  [key: string]: unknown;
}

/** GET /api/proposals — the approval queue listing. */
export interface ProposalsResponse {
  proposals: Proposal[];
  count: number;
}

/** Well-known fields on a `suppression` proposal's `payload` (all UNTRUSTED). */
export interface SuppressionPayload {
  field?: string;
  value?: unknown;
  reason?: string;
  [key: string]: unknown;
}

/** Well-known fields on a `memory` proposal's `payload` (all UNTRUSTED). */
export interface MemoryPayload {
  text?: string;
  category?: string;
  [key: string]: unknown;
}

/** Well-known fields on an acknowledgement-only automation proposal. */
export interface AutomationAcknowledgementPayload {
  rule_id?: string;
  requested_kind?: string;
  reason?: string;
  requested_action?: string;
  [key: string]: unknown;
}

/** Well-known fields on an evidence-grounded tuning proposal. */
export interface TuningProposalPayload {
  tuning?: true;
  action?: 'apply_change' | 'collect_evidence' | 'review_history' | string;
  reason_code?: string;
  reason?: string;
  recommended_action?: string;
  rule_id?: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  analyst_samples?: number;
  observed_cases?: number;
  unconfirmed_cases?: number;
  confirmed_false_positives?: number;
  confirmed_true_positives?: number;
  evidence_basis?: string;
  record_id?: string;
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Case decision rationale (GET /api/cases/{id}/rationale).
// --------------------------------------------------------------------------- //
/** A knowledge snippet the investigator retrieved through RAG. */
export interface RationaleKnowledge {
  source: string;
  snippet: string;
  /** Retrieval score recorded for this immutable investigation run, when available. */
  score?: number | null;
  /** Durable document identity and revision used by the retriever. */
  document_id?: string;
  revision?: number | string | null;
  content_hash?: string;
  /** Exact query groups that returned this reference. */
  query_groups?: string[];
}

/** A tool invocation the investigator ran during this case. */
export interface RationaleTool {
  tool: string;
  query?: string;
  summary?: string;
}

/** The playbook actually injected into the investigation + its selection context. */
export interface RationalePlaybook {
  id: string;
  version?: string;
  reason?: string;
  consulted?: boolean;
}

/** One procedure selected for the latest run, kept distinct from consultation. */
export interface RationaleProcedureSelection {
  selected_id: string;
  selection_reason: string;
  consulted: boolean;
}

/** One exact retrieval query issued by the latest investigation run. */
export interface RationaleRetrievalQueryGroup {
  group: string;
  query: string;
}

/** Append-only latest-run projection of selected and actually consulted procedures. */
export interface RationaleProcedureProvenance {
  persona: RationaleProcedureSelection;
  playbook: RationaleProcedureSelection;
  consultation_path: string;
  /** Latest-run retrieval observation; missing legacy telemetry is unavailable. */
  retrieval_status?: 'measured' | 'not_attempted' | 'unavailable';
  /** Stable machine-readable reason for a skipped or unavailable observation. */
  retrieval_reason?: string;
  retrieval_query_groups: RationaleRetrievalQueryGroup[];
  knowledge: RationaleKnowledge[];
}

/** One immutable adaptive-threshold snapshot on this case's processing path. */
export interface RationalePlatformTuning {
  record_id?: string;
  target: 'correlation_n' | 'severity_floor' | string;
  rule_id: string;
  before?: number;
  after?: number;
  applied_at?: string;
  rationale?: string;
}

/** Cached enrichment used in the decision (null when none applied). */
export interface RationaleEnrichment {
  reputation_score?: number;
  is_malicious?: boolean;
  country?: string;
  [key: string]: unknown;
}

/**
 * GET /api/cases/{id}/rationale — the explainable decision trace consumed by the
 * Cases surface (the case-detail engineer wires this; defined here as the shared
 * contract).
 */
export interface CaseRationale {
  case_id: string;
  verdict?: string;
  confidence?: number;
  status?: string;
  decision_by?: string;
  /** Selected persona retained for backward compatibility; it does not prove use. */
  persona?: string;
  /** Exact selected-vs-consulted facts from the latest procedure-provenance audit row. */
  procedure_provenance?: RationaleProcedureProvenance;
  playbook?: RationalePlaybook | null;
  /** Operator memories the investigation drew on. */
  memory_used?: string[];
  knowledge?: RationaleKnowledge[];
  /** Whether tuning provenance was recorded for this investigation run. */
  platform_tuning_status?: 'recorded' | 'not_recorded' | 'unavailable';
  /** Thresholds snapshotted at investigation time; never inferred from live config. */
  platform_tuning?: RationalePlatformTuning[];
  enrichment?: RationaleEnrichment | null;
  tools?: RationaleTool[];
  reasoning?: string;
  decision_rationale?: string;
  mitre?: string[];
  evidence?: Evidence[];
  [key: string]: unknown;
}

// --------------------------------------------------------------------------- //
// Threat-context panel (F11) — GET /api/cases/{id}/threat-context.
//
// Assembled per-case, parallel-fetched + fail-open per section: a missing /
// errored section degrades to an empty list, never errors the whole panel. EVERY
// field is intel/log-derived and UNTRUSTED — render as plain text / CodeBlock,
// never as markup, and never as live links beyond a known MITRE technique URL.
// --------------------------------------------------------------------------- //
/** One IOC's reputation lookup (AbuseIPDB / VirusTotal / GeoIP-derived). */
export interface IocReputation {
  /** The indicator value (UNTRUSTED — plain text). */
  indicator: string;
  /** The kind of indicator (ip / domain / hash / url / …). */
  type?: string;
  /** 0..100 reputation/abuse score, when available. */
  reputation_score?: number;
  /** Backend wire key used by the threat-context assembler (additive alias). */
  score?: number;
  /** Whether the score crosses the configured malicious threshold. */
  is_malicious?: boolean;
  /** Country / source label (UNTRUSTED — plain text). */
  country?: string;
  /** The enrichment source that produced this (e.g. "abuseipdb"). */
  source?: string;
  /** Backend wire map of provider id → provider result. */
  sources?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One MITRE ATT&CK technique resolved from the bundled corpus. */
export interface MitreTechnique {
  /** The technique id, e.g. "T1110" or "T1110.001". */
  id: string;
  /** The technique name (from the curated corpus — TRUSTED). */
  name?: string;
  /** Tactic phase labels (e.g. "credential-access"). */
  tactics?: string[];
  /** Applicable platforms. */
  platforms?: string[];
  /** Canonical MITRE ATT&CK URL for the technique. */
  url?: string;
  /** Short description (from the corpus — TRUSTED). */
  description?: string;
  [key: string]: unknown;
}

/** A related case surfaced by the threat-context assembly (Wave 5 / F6 linkage). */
export interface ThreatContextRelatedCase {
  case_id: string;
  case_number?: string;
  /** UNTRUSTED — plain text. */
  title?: string;
  verdict?: string;
  status?: string;
  disposition?: Disposition | null;
  risk_score?: number;
  created_at?: string;
  /** Why it relates (shared entity / cross-source / resolved-case match). */
  reason?: string;
  [key: string]: unknown;
}

/** Asset / entity context for the case's primary entity. */
export interface ThreatContextAsset {
  /** The entity value (UNTRUSTED — plain text). */
  entity?: string;
  entity_type?: string;
  /** Operator-recorded criticality, when known. */
  criticality?: string | number;
  /** Backend-projected network context (all source/operator-derived). */
  is_internal?: boolean;
  networks?: unknown[];
  /** Free-form KV context (UNTRUSTED values — plain text). */
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

/** GET /api/cases/{id}/threat-context — the assembled panel (all sections fail-open). */
export interface ThreatContextPanel {
  case_id?: string;
  /** A short threat summary banner (UNTRUSTED — plain text). */
  summary?: string;
  ioc_reputation?: IocReputation[];
  mitre_techniques?: MitreTechnique[];
  related_cases?: ThreatContextRelatedCase[];
  /** Redacted persisted alert → correlation-cluster → case explanation. */
  clustering?: Record<string, unknown>;
  asset_context?: ThreatContextAsset | null;
  evidence?: Evidence[];
  generated_at?: string;
  /** Present + true when the feature is disabled in Preferences. */
  disabled?: boolean;
  [key: string]: unknown;
}

// =========================================================================== //
// Round-5 W0-F F1 — REAL backend config-type mirrors (APPENDED SECTION).
//
// Hand-mirrored EXACTLY from `backend/app/config.py` + `backend/app/models.py`
// (the source of truth). Additive + defaulted so unknown/absent fields round-trip
// unharmed. NONE of these blocks feed the deterministic `decide()` (#3): auto-close
// is the tunable policy `decide()` reads; tuning/batch/baseline/campaign/SLA/
// priority are advisory/plumbing. Every operator-authored string here (rule name,
// rule field value, dashboard/widget name, login copy) is UNTRUSTED at render →
// plain text / SVG `<text>` / CodeBlock (#9), never markup. Secrets are NEVER
// mirrored (#10). NOTE: `CorrelationRule`, `RiskWeights`, `CapsConfig`,
// `FpAutoCloseConfig` and `Branding` are already defined above; `CapsConfig`
// (`max_concurrent`) and `Branding` (`login_*`) were extended in place.
// =========================================================================== //

// ---- Auto-close policy (the field `case_manager.decide()` reads) — config.py. -- //
/**
 * Per-verdict-class auto-close thresholds (mirrors backend `VerdictAutoClose`).
 *
 * Auto-close is a normal calibration surface. The decision is enforced
 * deterministically in `engine/case_manager.decide()` against this data; the LLM
 * verdict feeds the policy, never bypasses it (#3). `enabled` gates auto-close for
 * the verdict class; the confidence/risk bars + objection window tune when.
 */
export interface VerdictAutoClose {
  enabled?: boolean;
  /** Verdict confidence must be >= this (0..1). */
  min_confidence?: number;
  /** Cluster risk must be <= this (0..100). */
  max_risk_score?: number;
  /** Reopen (objection) window in minutes before a true close. */
  objection_window_minutes?: number;
}

/**
 * Operator-configured auto-close policy, one entry per verdict class (mirrors
 * backend `AutoClosePolicy`). Conservative defaults: FALSE_POSITIVE may auto-close
 * above a bar; TRUE_POSITIVE auto-close is OFF by default (explicit opt-in);
 * NEEDS_HUMAN NEVER auto-closes — enforced in code regardless of this value.
 * This is the field `Preferences.auto_close` that `decide()` acts on.
 */
export interface AutoClosePolicy {
  false_positive?: VerdictAutoClose;
  true_positive?: VerdictAutoClose;
  /** Code-enforced never-auto-close; the toggle is effectively locked OFF. */
  needs_human?: VerdictAutoClose;
}

// ---- Detection rule catalog + correlation (config.py). ---------------------- //
/**
 * The full set of entity types the backend correlates / groups on (mirrors backend
 * `EntityType`). The classic per-rule ladder is ip/user/host/rule; `file_hash`/
 * `domain` are extra keys the opt-in cross-source pass may group on.
 */
export type EntityTypeFull = 'ip' | 'user' | 'host' | 'file_hash' | 'domain' | 'rule';

/** Per-rule correlation mode (mirrors backend `CorrelationMode`). */
export type CorrelationMode = 'every' | 'threshold' | 'never';

/**
 * A single field predicate that classifies a raw log into a detection rule
 * (mirrors backend `RuleMatch`). `field` is a dotted path; `op` selects the test.
 * `field`/`value` are operator-authored + LOG-adjacent → render as plain text (#9).
 */
export interface RuleMatch {
  field: string;
  op: 'equals' | 'prefix' | 'tag' | 'exists' | string;
  value?: string | null;
}

/**
 * Optional per-detection-rule schedule metadata (mirrors backend `RuleSchedule`;
 * G6 R5 "Schedule" tab). ADVISORY ONLY — the poller's durable per-feed cursor owns
 * cadence today; these persist the operator's intent + round-trip losslessly. Never
 * feeds `decide()` (#3). Snake_case wire keys (the FE `ScheduleForm` uses camelCase;
 * the rules adapter maps `intervalSeconds` ⇄ `interval_seconds`).
 */
export interface RuleSchedule {
  interval_seconds?: number | null;
  lookback_seconds?: number | null;
}

/**
 * Optional per-detection-rule alert-storm suppression metadata (mirrors backend
 * `RuleSuppression`; G6 R5). ADVISORY/STORAGE ONLY — persists the operator's intent so
 * the Suppression editor round-trips; the engine does NOT silently DROP events from this
 * per-rule block (any real DROP stays a HITL Proposal via `Preferences.suppression_rules`,
 * #3/#4-safe). `by` fields are operator/log-adjacent → render as plain text (#9).
 */
export interface RuleSuppression {
  by?: string[];
  scope?: 'per_run' | 'per_window' | string;
  window_seconds?: number | null;
  missing_field?: 'suppress' | 'keep' | string;
}

/**
 * A config-driven, pre-baked-but-editable detection rule (mirrors backend
 * `RuleDefinition`). Rules classify an event via `match`, may carry a `correlation`
 * override + per-role `model_override`, and are evaluated in ascending `priority`
 * (then list order). `model_override` never echoes a key (#10); its values are
 * `ModelConfig` selections only. `name`/`description` are operator text → plain (#9).
 * `mitre`/`schedule`/`suppression` are ADDITIVE, defaulted G6-editor metadata (advisory
 * only — none feeds `decide()`, #3): `mitre` maps the rule to ATT&CK technique ids
 * (coverage heatmap), `schedule`/`suppression` persist the operator's cadence/storm
 * intent. `mitre` values are operator/log-adjacent → render as plain text (#9).
 */
export interface RuleDefinition {
  name: string;
  enabled?: boolean;
  description?: string;
  match: RuleMatch;
  correlation?: CorrelationRule | null;
  /** Per-role model overrides for this rule (role → selection). Never carries a key. */
  model_override?: Record<string, ModelConfig>;
  priority?: number;
  /** ATT&CK technique ids this rule maps to (advisory; coverage heatmap). */
  mitre?: string[];
  schedule?: RuleSchedule | null;
  suppression?: RuleSuppression | null;
}

// NOTE: `CorrelationRule` is defined earlier in this file (Preferences section).
// Its `group_by` there enumerates ip/user/host; the backend `EntityType` superset
// (`EntityTypeFull`) additionally permits file_hash/domain/rule — the backend
// validates, so wider strings round-trip. `Preferences.correlation_rules` is a
// `Record<string, CorrelationRule>` (rule name → override); `Preferences.rule_catalog`
// is a `RuleDefinition[]`; both are additive + defaulted (see the additions below).

// ---- Asset criticality (CIDR + exact-value) — config.py. -------------------- //
/**
 * An internal-asset network (mirrors backend `AssetNetwork`): every IP inside
 * `cidr` inherits `criticality` (0..100) in the deterministic risk score's
 * asset-criticality component (max wins; falls back to the exact-value map). `cidr`
 * is operator-authored → render as plain text (#9).
 */
export interface AssetNetwork {
  cidr: string;
  /** 0..100 criticality every IP in the CIDR inherits. */
  criticality?: number;
}

/**
 * The exact-value asset criticality map (mirrors backend
 * `Preferences.asset_criticality`): entity value → 0..100 criticality. Higher
 * precedence than the CIDR-derived value only where an exact match exists.
 */
export type AssetCriticalityMap = Record<string, number>;

// ---- SLA policy (Round-3; advisory) — config.py. ---------------------------- //
/**
 * One SLA tier's response + resolution targets in minutes (mirrors backend
 * `SlaTarget`). Advisory only — surfaces at-risk/breached badges + MTTR reporting,
 * never gates the deterministic decision (#3).
 */
export interface SlaTarget {
  response_minutes?: number;
  resolve_minutes?: number;
}

/**
 * Per-priority SLA response/resolution policy (mirrors backend `SlaPolicy`).
 * Default OFF so today's behaviour is unchanged; `targets` is keyed by priority
 * level (P1..P4). Advisory (#3). `timezone` is a plain IANA id.
 */
export interface SlaPolicy {
  enabled?: boolean;
  /** Priority level (e.g. "P1") → its SLA targets. */
  targets?: Record<string, SlaTarget>;
  /** When true the SLA clock runs only during business hours (default 24x7). */
  business_hours_only?: boolean;
  timezone?: string;
}

// ---- Priority matrix (Round-3 ITIL; advisory) — config.py. ------------------ //
/**
 * Impact × Urgency → Priority (P1..P4) mapping (mirrors backend `PriorityMatrix`,
 * ITIL-style). Default OFF. Advisory: a later wave derives `Case.priority_level`
 * from `impact_band` × `urgency_band` via this matrix; it NEVER changes the verdict
 * or the deterministic decision (#3). `levels` are the band labels (high → low);
 * `matrix` maps `"{impact}/{urgency}"` → a P-level.
 */
export interface PriorityMatrix {
  enabled?: boolean;
  /** Band labels high → low (drives the grid render). */
  levels?: string[];
  /** Fallback P-level for any unmapped impact/urgency pair. */
  default_priority?: string;
  /** `"{impact}/{urgency}"` → P-level. */
  matrix?: Record<string, string>;
}

// ---- Round-4 config blocks (all default OFF/safe; ADVISORY — never feed #3). - //
/**
 * Nightly threshold auto-TUNING policy (mirrors backend `ThresholdTuningConfig`,
 * all 8 fields). Default OFF. When enabled a later wave observes per-rule FP rates
 * and PROPOSES bounded threshold adjustments (never applies them silently — the
 * decision stays deterministic, #3).
 */
export interface ThresholdTuningConfig {
  enabled?: boolean;
  /** Minimum observations before a suggestion is considered. */
  min_samples?: number;
  /** Caps how far a correlation `n` may move per cadence. */
  max_n_step?: number;
  /** Target false-positive rate (0..1). */
  fp_rate_target?: number;
  /** Z-score for the Wilson confidence interval on the observed FP rate. */
  wilson_z?: number;
  /** EWMA smoothing factor for the running FP-rate estimate (0..1). */
  ewma_alpha?: number;
  /** When the tuner runs. */
  cadence?: 'hourly' | 'nightly' | 'weekly' | 'manual' | string;
  /** Evaluate a suggestion against recent data before it can apply (default ON). */
  shadow_eval?: boolean;
}

/**
 * Discounted-inference policy (mirrors backend `BatchConfig`). Compatible live
 * OpenAI alert investigations prefer Flex by default; the separate async Batch
 * queue remains opt-in for low-urgency work. The ledger records the tier actually
 * used, and deterministic case authority is unchanged.
 */
export interface BatchConfig {
  enabled?: boolean;
  /** OCSF severity_id (1-6) at/below which a candidate is batch-eligible; 3 == medium. */
  severity_floor?: number;
  /** Providers whose batch APIs may be used. */
  providers?: string[];
  /** Legacy compatibility field; ignored. Live Flex uses prefer_discounted_alerts. */
  flex?: boolean;
  /** Prefer live discounted processing for compatible case/alert inference. */
  prefer_discounted_alerts?: boolean;
  /** Retry at standard service when discounted live capacity is unavailable. */
  fallback_to_standard?: boolean;
}

/**
 * Anomaly-detection BASELINE policy (mirrors backend `BaselineConfig`). Default
 * ON. It warms per-series streaming sketches and flags
 * modified-z-score deviations as ANOMALY candidates (advisory — never feeds #3).
 */
export interface BaselineConfig {
  enabled?: boolean;
  /** EWMA decay half-life in days. */
  half_life_days?: number;
  /** `warmup_multiplier` × `min_samples` guards a cold series. */
  warmup_multiplier?: number;
  /** The modified-z deviation bar. */
  modified_z_threshold?: number;
  /** Bounds the quantile (t-digest) sketch size. */
  tdigest_compression?: number;
  /** How observations are bucketed for seasonality. */
  seasonality?: 'none' | 'hour_of_day' | 'hour_of_week' | 'day_of_week' | string;
}

/**
 * Cross-case CAMPAIGN-clustering policy (mirrors backend `CampaignConfig`). Default
 * OFF. When enabled a later wave groups related cases (shared entities / overlapping
 * MITRE) into a running `Campaign` for the UI (advisory — never force-merges cases
 * or feeds #3). `cadence` is how often the clustering pass runs.
 */
export interface CampaignConfig {
  enabled?: boolean;
  cadence?: 'hourly' | 'daily' | 'weekly' | 'manual' | string;
}

/**
 * LLM cost-budget ceiling (mirrors backend `BudgetConfig`, Round-3 cost governance).
 * Default OFF so today's behaviour is byte-identical. When enabled the rolling spend
 * (from the usage/cost ledger) is compared against the ceilings; a budget block
 * affects whether an investigation RUNS — it never alters a case that DID run (#3).
 */
export interface BudgetConfig {
  enabled?: boolean;
  daily_usd?: number | null;
  monthly_usd?: number | null;
  /** Warn at this fraction of a ceiling (0..1). */
  soft_warn_pct?: number;
  /** Whether crossing a ceiling merely warns or BLOCKS further LLM spend. */
  on_exceed?: 'warn' | 'block' | string;
}

/**
 * Preferences.customization — ORG-level pervasive-customization defaults (mirrors
 * backend `CustomizationConfig`). The ORG side of the two-store model, merged
 * ORG ← USER by the cascade resolver. Superset of {@link OrgCustomization} the
 * `/api/prefs/org` route projects; every free-text label is plain data (#9).
 */
export interface CustomizationConfig {
  terminology?: Terminology;
  default_saved_views?: SavedView[];
  default_theme?: ThemeMode;
  default_pinned_view_ids?: string[];
  /** Per-role immutable default dashboards (G7 custom dashboards). */
  default_dashboards?: Record<string, DashboardLayout>;
  [key: string]: unknown;
}

// ---- Custom dashboards (G7) — mirrors backend `UserPrefs.dashboards` +
// `DashboardLayout`/`DashboardWidget` (`models.py` / `stores/dashboards.py`). The
// `react-grid-layout` item shape `{i,x,y,w,h,minW,minH,static}` IS the persistence
// schema. `schema_version` present from day one (zero-migration KV store). Widget
// TYPE is server-allowlisted on PUT; `title`/`name` are UNTRUSTED → plain text/SVG
// (#9), never `dangerouslySetInnerHTML`. Layout is ADVISORY, never feeds #3. ------ //
/**
 * One widget placed on a custom dashboard (mirrors backend `DashboardWidget` —
 * `models.py:648`). The grid geometry `{x,y,w,h,minW,minH,static}` doubles as the
 * react-grid-layout item shape.
 *
 * WIRE CONTRACT (the source of truth is the backend): the stable id is **`i`** and the
 * declarative config bag is **`options`** — these are what every route reads/writes
 * verbatim (`routes_dashboards.py`). Serialize a widget through
 * `layout-utils.normalizeWidget()` (the mandatory serialization boundary) before it
 * crosses the wire so it always carries a concrete `i`/`options`.
 *
 * `id`/`config` are LEGACY registry-side aliases (`registry.ts` `buildDefaultWidgets` /
 * `reconcileWidgets` produce `id`); `layout-utils.widgetId()` / `widgetOptions()` read
 * EITHER, and `normalizeWidget()` upgrades the registry shape to the wire `i`/`options`.
 * Prefer `i`/`options` in NEW code — a widget written with only `id`/`config` and sent
 * WITHOUT `normalizeWidget` would be silently re-keyed by the backend (fresh `i`, dropped
 * config). `type` is a `WidgetType` from the widget registry (server-allowlisted on PUT).
 */
export interface DashboardWidget {
  /** Stable per-widget id AND the react-grid-layout `i` — the WIRE key (preferred). */
  i?: string;
  /**
   * LEGACY registry-side id alias (`registry.ts` writes this). Read via
   * `layout-utils.widgetId()`; upgraded to `i` by `normalizeWidget()`. Prefer `i`.
   */
  id?: string;
  /** Widget kind — a key from the widget registry (server-allowlisted). */
  type: string;
  /** Grid position + size (react-grid-layout units). */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Minimum grid width/height the widget may be resized to. */
  minW?: number;
  minH?: number;
  /** When true the widget is pinned (not draggable/resizable). */
  static?: boolean;
  /**
   * Declarative per-widget options bag (title, time-range, metric key, …) — the WIRE
   * key (preferred). Values are operator-authored → render plain text / SVG `<text>`
   * (#9), never markup.
   */
  options?: Record<string, unknown>;
  /**
   * LEGACY registry-side alias of `options`. Read via `layout-utils.widgetOptions()`;
   * upgraded to `options` by `normalizeWidget()`. Prefer `options`.
   */
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * One saved custom dashboard (mirrors backend `DashboardLayout`). Persisted per-user
 * in the `DashboardStore` (KV, zero-migration) and surfaced under
 * `UserPrefs.dashboards` (`Record<dashboardId, DashboardLayout>`). `name` is
 * operator-authored + allowlist-validated → render as plain text (#9). Layout is
 * advisory presentation only (never feeds the deterministic decision, #3).
 */
export interface DashboardLayout {
  /** Stable dashboard id (the map key under `UserPrefs.dashboards`). */
  id: string;
  /** Operator-facing dashboard name (UNTRUSTED — plain text, allowlist-validated). */
  name: string;
  /** Grid column count (mirrors backend `DashboardLayout.columns`, default 12). */
  columns?: number;
  /** The widgets placed on this dashboard (their geometry is the RGL layout). */
  widgets?: DashboardWidget[];
  /**
   * Optional per-breakpoint override map (RGL responsive layouts), keyed by
   * breakpoint name (lg/md/sm/xs/xxs) → widget placements. Mirrors the backend
   * `DashboardLayout.layouts` field + its sanitizer. Absent/empty → the single
   * `widgets` layout is authoritative (the current builder emits only `widgets`).
   */
  layouts?: Record<string, DashboardWidget[]>;
  /** Store schema version (present from day one for zero-migration evolution). */
  schema_version?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

// ---- Additive Preferences fields (documented; the loose index signature on
// `Preferences` already lets them round-trip). Declaration-merged onto the existing
// `Preferences` interface above so a surface reading these is typed. -------------- //
/**
 * Additive `Preferences` fields mirrored from `config.py` in Round-5 W0-F F1.
 * Declaration-merges onto the `Preferences` interface defined earlier; all optional
 * + defaulted (an absent block uses the backend default). Wire keys are byte-
 * identical to `config.py`.
 */
export interface Preferences {
  /** The auto-close policy `decide()` reads (per-verdict-class thresholds). */
  auto_close?: AutoClosePolicy;
  /** Config-driven detection rules (empty preserves single-`rule_field` behaviour). */
  rule_catalog?: RuleDefinition[];
  /** Which seed version produced the built-in rules (no-op reseed guard). */
  rule_catalog_seed_version?: number;
  /** Per-rule model selection, keyed by rule name. Never carries a secret key (#10). */
  rule_model_override?: Record<string, ModelConfig>;
  /** Per-rule correlation overrides (rule name → correlation rule). */
  correlation_rules?: Record<string, CorrelationRule>;
  /** Exact-value asset criticality map (entity value → 0..100). */
  asset_criticality?: AssetCriticalityMap;
  /** CIDR-based internal-asset criticality networks. */
  asset_networks?: AssetNetwork[];
  /** Operator field==value suppression rules (matching events are dropped). */
  suppression_rules?: SuppressionRuleConfig[];
  analyst_rule_policies?: AnalystRulePolicyConfig[];
  precedent?: PrecedentConfig;
  /** Per-priority SLA response/resolution policy (advisory, #3-safe). */
  sla?: SlaPolicy;
  /** Impact × Urgency → Priority matrix (advisory, #3-safe). */
  priority_matrix?: PriorityMatrix;
  /** LLM cost-budget ceiling (governs whether an investigation runs, #3-safe). */
  budget?: BudgetConfig;
  /** Nightly threshold auto-tuning policy (Round-4; default OFF). */
  threshold_tuning?: ThresholdTuningConfig;
  /** Batch-inference cost policy (Round-4; default OFF). */
  batch?: BatchConfig;
  /** Anomaly-detection baseline policy (Round-4; default OFF). */
  baseline?: BaselineConfig;
  /** Cross-case campaign-clustering policy (Round-4; default OFF). */
  campaign?: CampaignConfig;
  /** ORG-level pervasive-customization defaults (terminology / views / dashboards). */
  customization?: CustomizationConfig;
}

/**
 * An operator field==value suppression rule (mirrors backend `SuppressionRule`).
 * Matching events are DROPPED (not investigated). All fields beyond field/value/
 * reason are additive provenance for agent-PROPOSED rules. `field`/`value`/`reason`/
 * `rationale` are operator/agent text → render as plain text (#9).
 */
/**
 * An operator's explicit, audited, revocable declaration that a detection is benign in
 * THIS estate. Matching clusters close deterministically with no LLM call, as
 * `decision_by='analyst_policy'`. Unlike `SuppressionRuleConfig` (a field==value event
 * DROP) the case stays visible, audited and reopenable.
 */
/** `Preferences.precedent.promotion` — the analyst-precedent promotion opt-in. */
export interface PrecedentPromotionConfig {
  enabled?: boolean;
  min_confirmed?: number;
  min_similarity?: number;
  max_conflicting?: number;
  [key: string]: unknown;
}

/** `Preferences.precedent.window` — how the bounded projection window is filled. */
export interface PrecedentWindowConfig {
  size?: number;
  stratify_by_rule?: boolean;
  [key: string]: unknown;
}

/** `Preferences.precedent` — promotion, window fairness and futility reporting. */
export interface PrecedentConfig {
  promotion?: PrecedentPromotionConfig;
  window?: PrecedentWindowConfig;
  futility?: Record<string, unknown>;
  distribution_ttl_seconds?: number;
  [key: string]: unknown;
}

export interface AnalystRulePolicyConfig {
  id: string;
  rule_id: string;
  reason?: string;
  /** Optional scope: when set, the declaration applies only to that source instance. */
  source_id?: string | null;
  enabled?: boolean;
  /** Optional risk ceiling — above it the case is investigated instead of closed. */
  max_risk_score?: number | null;
  created_by?: string;
  created_at?: string;
  expires_at?: string | null;
  /** Derived server-side: enabled AND not expired. */
  live?: boolean;
  [key: string]: unknown;
}

export interface SuppressionRuleConfig {
  field: string;
  value: string;
  reason?: string;
  /** Proposer's justified confidence (0..1); 1.0 for operator-authored. */
  confidence?: number;
  /** Why the rule exists (UNTRUSTED for agent-drafted — plain text). */
  rationale?: string;
  /** The closed case(s) that motivated an agent-drafted rule. */
  source_case_ids?: string[];
  /** "agent" when proposer-drafted, else the operator. */
  created_by?: string;
  /** Auto-expiry (ISO) so an agent rule self-retires; null/absent = never. */
  expires_at?: string | null;
  /** Operator off-switch without deleting the rule. */
  enabled?: boolean;
  [key: string]: unknown;
}

// ---- Custom dashboards on the per-user prefs bucket (G7). -------------------- //
/**
 * Additive `UserPrefs` field mirrored from backend `UserPrefs.dashboards`
 * (`models.py`). Declaration-merges onto the `UserPrefs` interface defined earlier.
 * Per-user saved custom dashboards, keyed by dashboard id (mirrors `saved_views`).
 * Defaulted `{}`; zero-migration KV persistence via the `DashboardStore`.
 */
export interface UserPrefs {
  /** Per-user saved custom dashboards (dashboard id → layout). */
  dashboards?: Record<string, DashboardLayout>;
}
