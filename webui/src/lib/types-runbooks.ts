/**
 * Round 14 runbook contracts (SPEC §4.10). Type-only: zero runtime bytes.
 *
 * Mirrors `backend/app/models.py` (the runbook model of §4.10.2, the runs of
 * §4.10.7, the responses of §4.10.15a and the request bodies of §4.10.15). New code
 * imports runbook types from this module only; the legacy `Runbook*` and `Playbook*`
 * declarations in `types.ts` belong to the old pages until WP-B1 retires them, so the
 * shared names (`RunbookDetail`) never collide.
 *
 * Runbook text is trusted only once Published; everything a run records (notes,
 * lookup results, AI drafts) is plain data the Console renders as text (#9). A
 * runbook never closes a case and never changes a verdict (#3).
 */
import type { CaseTask } from '@/soc/pages/CaseDetail.api';
import type { SeverityLevel } from './types-rules';

export type { SeverityLevel };

export type StepKind = 'check' | 'lookup' | 'decision' | 'action' | 'record';

/** The fixed phase vocabulary (NIST SP 800-61r3, SANS PICERL); a runbook uses an ordered subset. */
export type PhaseId = 'triage' | 'investigate' | 'contain' | 'eradicate' | 'recover' | 'close';

export type RunbookEntityType =
  | 'ip'
  | 'host'
  | 'user'
  | 'domain'
  | 'hash'
  | 'url'
  | 'email'
  | 'process'
  | 'file';

export type RunbookVerdict = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'NEEDS_HUMAN';

export type LookupTool = 'log_stats' | 'log_search' | 'enrich' | 'related_cases' | 'campaign' | 'mitre';

export type LookupRunMode = 'on_attach' | 'on_demand';

export type StepEvidenceRule = 'none' | 'note' | 'note_or_attachment';

/** "Waiting for approval" is a derived display state, never a stored status. */
export type StepStatus = 'todo' | 'in_progress' | 'done' | 'not_applicable' | 'blocked';

/** The closed set of lookup template values (§4.10.8), written `{{case.rule}}` and so on. */
export type RunbookTemplateValue =
  | 'case.rule'
  | 'case.source_id'
  | 'case.first_seen'
  | 'case.last_seen'
  | 'entity.ip'
  | 'entity.user'
  | 'entity.host'
  | 'entity.domain'
  | 'entity.hash'
  | 'entity.url'
  | 'entity.email';

// --------------------------------------------------------------------------- //
// §4.10.2 the definition
// --------------------------------------------------------------------------- //
/** Every present criterion is any-of; all present criteria must match. */
export interface AppliesWhen {
  rule_ids: string[];
  /** `T####` or `T####.###`; a parent matches its sub-techniques. */
  mitre: string[];
  entity_types: RunbookEntityType[];
  severity_at_least: SeverityLevel | null;
  /** Source ids or `type:<SourceType>`. */
  sources: string[];
  verdicts: RunbookVerdict[];
  statuses: string[];
  any_tags: string[];
  min_event_count: number | null;
  /** Only the Generic incident fallback; the lowest specificity. */
  always: boolean;
}

export interface LookupTemplate {
  tool: LookupTool;
  /** Field to a literal or one `{{template value}}`; at most 8 entries. */
  filter: Record<string, string>;
  /** `log_stats` only; at most 2 fields. */
  group_by: string[];
  /** `enrich` only: one `{{template value}}`. */
  indicator: string | null;
  /** Default `case_first_seen-1h..case_last_seen+1h`, or a Round 12 window token; at most 30 days. */
  window: string;
  /** 1 to 50; `log_search` rows are capped at 20. */
  limit: number;
  run: LookupRunMode;
}

export interface DecisionOption {
  id: string;
  /** At most 80 characters. */
  label: string;
  /** Later step ids this option skips (only steps still To do). */
  marks_not_applicable: string[];
}

export interface RunbookStep {
  /** A slug unique in the runbook, stable across versions. */
  id: string;
  phase: PhaseId;
  kind: StepKind;
  /** At most 160 characters; Checks are written as questions. */
  title: string;
  /** Restricted Markdown for people (never part of the investigator prompt). */
  instructions: string;
  /** "Which fields to look at"; read by the investigator. */
  focus: string | null;
  escalate_if: string | null;
  benign_if: string | null;
  required: boolean;
  evidence: StepEvidenceRule;
  owner_role: string | null;
  /** Action and Record steps; honoured only when step approvals are on. */
  approval_role: string | null;
  /** Shown, never enforced (1 to 10,080). */
  target_minutes: number | null;
  /** Lookup steps only (required there). */
  lookup: LookupTemplate | null;
  /** Decision steps only, 2 to 6 options. */
  options: DecisionOption[];
  /** RE&CT id, for example RA3101. */
  react: string | null;
  /** D3FEND technique id, for example D3-AL. */
  d3fend: string | null;
}

/** The canonical definition. It has no version: a version is document metadata. */
export interface RunbookDefinition {
  id: string;
  title: string;
  summary: string;
  use_when: string;
  prerequisites: string;
  applies_when: AppliesWhen;
  /** 0 to 100, default 50. */
  priority: number;
  mitre: string[];
  phases: PhaseId[];
  steps: RunbookStep[];
  retrieval_queries: string[];
  owner: string | null;
  /** 30 to 730, default 180. */
  review_every_days: number;
  /**
   * https links only, at most 10. Only a published version is guaranteed to pass
   * `validate_runbook`; a draft may hold any text here, so every rendered reference goes
   * through the one https-only link helper and a non-https value renders as plain text.
   */
  references: string[];
}

// --------------------------------------------------------------------------- //
// §4.10.4 the match explanation
// --------------------------------------------------------------------------- //
export type MatchCriterion =
  | 'rule_ids'
  | 'mitre'
  | 'entity_types'
  | 'severity_at_least'
  | 'sources'
  | 'verdicts'
  | 'statuses'
  | 'any_tags'
  | 'min_event_count'
  | 'always';

export type MatchValue = string | number | string[] | null;

export interface MatchedCriterion {
  criterion: MatchCriterion;
  value: MatchValue;
}

export interface MissedCriterion {
  criterion: MatchCriterion;
  expected: MatchValue;
  actual: MatchValue;
}

/**
 * Why a runbook was chosen: tier 3 (rule matched), 2 (technique matched, no rules
 * named), 1 (other criteria only), 0 (the fallback). `tie` says a tie survived to
 * the id rule ("2 runbooks matched equally; the first by name was chosen").
 */
export interface MatchExplanation {
  tier: 0 | 1 | 2 | 3;
  matched: MatchedCriterion[];
  missed: MissedCriterion[];
  tie: boolean;
}

// --------------------------------------------------------------------------- //
// §4.10.7 runs
// --------------------------------------------------------------------------- //
export type LookupResultStatus = 'ok' | 'empty' | 'partial' | 'error' | 'not_applicable';

/** `{columns <= 6, rows <= 20, cells <= 200 chars}`. */
export interface LookupTable {
  columns: string[];
  rows: string[][];
  [key: string]: unknown;
}

/**
 * A stored lookup result. Every value is untrusted plain text. A `rows` table holds
 * raw log rows shown to people only; a viewer without the tool's grant sees the step
 * and its status, never the evidence.
 */
export interface LookupResult {
  tool: LookupTool | string;
  params: Record<string, string>;
  window_from: string;
  window_to: string;
  ran_at: string;
  /** `agentic_soc` for a background run, or the person who pressed Run. */
  ran_by: string;
  status: LookupResultStatus;
  /** For example "This case has no source IP". */
  reason: string | null;
  count: number | null;
  count_relation: 'eq' | 'gte';
  /** At most 8 label and value pairs. */
  facts: Array<Record<string, string>>;
  table: LookupTable | null;
  table_kind: 'aggregate' | 'rows' | null;
  /** `window_to` was cut to `ran_at` ("Searched up to collection, 14:31 UTC"). */
  window_clamped: boolean;
}

export interface StepEvidence {
  kind: 'lookup_result' | 'link' | 'ticket';
  lookup: LookupResult | null;
  /**
   * An absolute https link (at most 500 characters) or `null`: the server refuses any
   * other scheme and reads a stored non-https value as `null`. Still render it only
   * through the one https-only link helper, as for runbook `references`.
   */
  url: string | null;
  label: string | null;
}

export interface StepDecisionRecord {
  option_id: string;
  label: string;
  by: string;
  at: string;
}

export interface StepActionRecord {
  performed_by: string;
  performed_at: string;
  /** System or ticket reference, at most 200 characters. */
  where: string;
  /** At most 500 characters. */
  outcome: string;
}

export interface StepApproval {
  required_role: string;
  status: 'pending' | 'approved' | 'rejected';
  by: string | null;
  at: string | null;
  reason: string | null;
}

/** "AI draft · not part of the case until you confirm it". */
export interface StepAiDraft {
  /** At most 2,000 characters, plain text, never HTML. */
  text: string;
  created_at: string;
  model: string;
  usage_id: string;
  confirmed: boolean;
}

export interface StepState {
  status: StepStatus;
  assignee: string | null;
  started_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  /** Plain text, at most 4,000 characters. */
  note: string;
  /** Required for Not applicable and Blocked (1 to 500). */
  reason: string | null;
  evidence: StepEvidence[];
  decision: StepDecisionRecord | null;
  action_record: StepActionRecord | null;
  approval: StepApproval | null;
  ai_draft: StepAiDraft | null;
  revision: number;
}

export type RunAttachedBy = 'rule' | 'fallback' | 'person' | 'suggestion';

export type RunStatus = 'active' | 'completed' | 'abandoned';

/** `attached_reason` for a run a person attached by hand. */
export interface RunAttachedByPerson {
  by: string;
  note?: string | null;
}

/** One run on one case. It pins its version; `snapshot` renders it without the catalog. */
export interface RunbookRun {
  /** `run-<uuid>` */
  run_id: string;
  case_id: string;
  runbook_id: string;
  version: number;
  title: string;
  snapshot: RunbookDefinition;
  attached_by: RunAttachedBy;
  /** The match explanation, or `{by, note}` for a person. */
  attached_reason: MatchExplanation | RunAttachedByPerson | Record<string, unknown>;
  attached_at: string;
  attached_actor: string;
  status: RunStatus;
  completed_at: string | null;
  abandoned_reason: string | null;
  steps: Record<string, StepState>;
  revision: number;
}

/**
 * Derived on read. Chip text "4/11" (done over total), "5/9 · 1 blocked",
 * "4/11 · 1 waiting". Not applicable is counted on its own, never as done.
 */
export interface RunbookProgress {
  done: number;
  not_applicable: number;
  total: number;
  required_open: number;
  blocked: number;
  waiting: number;
}

// --------------------------------------------------------------------------- //
// §4.10.15a responses
// --------------------------------------------------------------------------- //
export type RunbookOrigin = 'builtin' | 'operator' | 'imported';

/** The most advanced visible state of a library row. */
export type RunbookState = 'draft' | 'in_review' | 'published' | 'retired';

export type RunbookVersionState = 'draft' | 'in_review' | 'published' | 'superseded' | 'retired';

export interface RunbookRef {
  id: string;
  version: number;
}

export interface RunbookAppliesTo {
  rule_ids: string[];
  mitre: string[];
  /** How many more criteria values the row folds into "+3". */
  more: number;
}

export interface RunbookMigratedFrom {
  namespace: string;
  id: string;
  revision: number | null;
}

export interface RunbookSummary {
  id: string;
  title: string;
  summary: string;
  origin: RunbookOrigin;
  state: RunbookState;
  live_version: number | null;
  draft_version: number | null;
  in_review_version: number | null;
  retired: boolean;
  replaces: string | null;
  replaced_by: string | null;
  derived_from: RunbookRef | null;
  owner: string | null;
  phases: PhaseId[];
  step_count: number;
  applies_to: RunbookAppliesTo;
  /** `null` without `cases:read`. */
  runs_30d: number | null;
  review_due_at: string | null;
  last_reviewed_at: string | null;
  last_reviewed_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
  migrated_from: RunbookMigratedFrom | null;
}

export interface RunbookReviewNote {
  by: string;
  at: string;
  text: string;
}

export interface RunbookVersionDoc {
  version: number;
  state: RunbookVersionState;
  definition: RunbookDefinition;
  /** Markdown source (§4.10.13). */
  source: string;
  /** SHA-256 of the canonical definition. */
  content_hash: string;
  author: string;
  created_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  published_by: string | null;
  published_at: string | null;
  superseded_at: string | null;
  retired_by: string | null;
  retired_at: string | null;
  review_notes: RunbookReviewNote[];
  import_notes: string[];
  /** Investigator guidance length; the budget is 3,000 characters. */
  prompt_chars: number;
}

export interface RunbookVersionListItem {
  version: number;
  state: RunbookVersionState;
  published_by: string | null;
  published_at: string | null;
}

/**
 * `GET /api/runbooks/{id}`. `draft` and `in_review` are present only to a holder of
 * `runbooks:manage` or `runbooks:publish`. `revision` is sent back as
 * `expected_revision`. JSON object keys are strings, so `open_runs_by_version` is
 * keyed by the version number written as text.
 */
export interface RunbookDetail {
  summary: RunbookSummary;
  live: RunbookVersionDoc | null;
  draft: RunbookVersionDoc | null;
  in_review: RunbookVersionDoc | null;
  versions: RunbookVersionListItem[];
  open_runs_by_version: Record<string, number>;
  revision: number;
}

/** The one-shot migration's counts, for the Runbooks page's dismissible intro. */
export interface RunbookMigrationNotice {
  completed_at: string | null;
  published: number;
  draft: number;
  skipped: number;
}

/** `GET /api/runbooks` (the new shape; `?shape=v1` answers the legacy shape for one release). */
export interface RunbookLibrary {
  runbooks: RunbookSummary[];
  /** `null` when nothing was migrated. */
  migration: RunbookMigrationNotice | null;
}

/** Query of `GET /api/runbooks`. */
export interface RunbookLibraryQuery {
  q?: string;
  state?: RunbookState;
  origin?: RunbookOrigin;
  show_replaced?: boolean;
}

export interface RunbookIssue {
  /** Where, for example `steps[3].lookup.filter`. */
  path: string;
  code: string;
  /** A plain sentence naming the fix. */
  message: string;
}

/** `POST /api/runbooks/validate`. Nothing is written. */
export interface RunbookValidation {
  issues: RunbookIssue[];
  prompt_chars: number;
  prompt_budget: number;
}

export interface MatchPreviewCase {
  case_id: string;
  case_number: string;
  title: string;
  explanation: MatchExplanation | null;
}

export interface MatchPreviewOther {
  case_id: string;
  case_number: string;
  title: string;
  winner_id: string;
  winner_title: string;
}

export interface MatchPreviewNearMiss {
  case_id: string;
  case_number: string;
  title: string;
  failed: MissedCriterion[];
}

export interface MatchPreviewCounts {
  gets_it: number;
  another_wins: number;
  near_misses: number;
}

/**
 * `POST /api/runbooks/match-preview` over the last 500 cases of 30 days: "Nothing is
 * attached and no metric changes." Lists hold at most 50; `counts` are exact.
 */
export interface MatchPreview {
  considered: number;
  window_label: string;
  gets_it: MatchPreviewCase[];
  another_wins: MatchPreviewOther[];
  near_misses: MatchPreviewNearMiss[];
  counts: MatchPreviewCounts;
  truncated: boolean;
}

export interface RunbookMetricsRunbookRow {
  id: string;
  title: string;
  started: number;
  completed: number;
  abandoned: number;
  median_minutes_to_complete: number | null;
}

export interface RunbookMetricsPhaseRow {
  runbook_id: string;
  phase: PhaseId;
  median_minutes: number | null;
}

export interface RunbookMetricsStepRow {
  runbook_id: string;
  step_id: string;
  title: string;
  median_minutes: number | null;
  skipped: number;
}

export interface RunbookMetricsCohort {
  cases: number;
  mttr_p50_minutes: number | null;
}

export interface RunbookMetricsRecentRun {
  run_id: string;
  case_id: string;
  case_number: string;
  runbook_id: string;
  title: string;
  version: number | null;
  status: RunStatus;
  attached_actor: string;
  started_at: string;
  completed_at: string | null;
  duration_minutes: number | null;
}

/**
 * `GET /api/runbooks/metrics` (needs `cases:read`). `partial` is true when a ledger
 * month reached its cap in the window. Cohorts are "comparison, not cause".
 */
export interface RunbookMetrics {
  window_label: string;
  partial: boolean;
  per_runbook: RunbookMetricsRunbookRow[];
  per_phase: RunbookMetricsPhaseRow[];
  per_step: RunbookMetricsStepRow[];
  coverage: { cases_with_run: number; human_handled_cases: number };
  /** At most 20 rules; each rule is untrusted text. */
  rules_without_runbook: Array<{ rule: string; cases: number }>;
  cohorts: {
    with_completed_run: RunbookMetricsCohort;
    without: RunbookMetricsCohort;
    note: 'comparison, not cause';
  };
  recent_runs: RunbookMetricsRecentRun[];
}

/**
 * `GET /api/cases/{case_id}/runbooks`. Evidence is redacted per viewer by the lookup
 * grants; `other_tasks` are the free-form case tasks shown as "Other tasks".
 */
export interface CaseRunbooks {
  runs: RunbookRun[];
  progress: Record<string, RunbookProgress>;
  /** Run id to the newer published version ("A newer version exists (v5)"). */
  newer_versions: Record<string, number>;
  other_tasks: CaseTask[];
  revision: number;
}

/** One entry of the Start runbook picker. */
export interface RunbookCandidate {
  id: string;
  title: string;
  summary: string;
  version: number;
  origin: RunbookOrigin;
  /** Best match, Other matches, Fallback, All published runbooks, Suggested by the AI. */
  group: 'best' | 'other' | 'fallback' | 'all' | 'suggested';
  phases: PhaseId[];
  explanation: MatchExplanation | null;
  /** The AI suggestion's reason (plain text), when `group` is `suggested`. */
  reason: string | null;
}

export interface RunbookCandidates {
  candidates: RunbookCandidate[];
}

/** `DELETE /api/runbooks/{id}/draft`; `removed` when it was never published. */
export interface RunbookDiscardResult {
  id: string;
  removed: boolean;
  detail: RunbookDetail | null;
}

/** `POST /api/cases/{case_id}/runbooks`; idempotent per case and runbook. */
export interface RunbookAttachResult {
  already_attached: boolean;
  run: RunbookRun | null;
  progress: RunbookProgress | null;
  revision: number;
}

/** The result of any write to one run (step, lookup, approval, draft, switch, abandon). */
export interface RunbookRunUpdate {
  run: RunbookRun;
  progress: RunbookProgress;
  revision: number;
}

/** The dry-run estimate of one AI call (the report summary estimate shape). */
export interface AiCallEstimate {
  prompt_tokens: number;
  max_output_tokens: number;
  total_tokens: number;
  /** Present only with `models:read`. */
  cost: number | null;
  simulated: boolean;
  model: string | null;
}

/** `POST .../runbooks/suggest`: a suggestion a person must select, or the dry-run estimate. */
export interface RunbookSuggestion {
  candidate: RunbookCandidate | null;
  estimate: AiCallEstimate | null;
}

/** `POST .../steps/{step_id}/draft`: the updated run, or the dry-run estimate. */
export interface RunbookStepDraftResult {
  update: RunbookRunUpdate | null;
  estimate: AiCallEstimate | null;
}

/** `POST /api/runbooks/progress`: case id to progress. */
export type RunbookProgressMap = Record<string, RunbookProgress>;

/** One required step still open, in the body of `409 runbook_steps_open`. */
export interface RunbookStepsOpen {
  run_id: string;
  step_id: string;
  title: string;
  status: StepStatus;
}

export interface RunbookStepsOpenDetail {
  required_open: number;
  steps: RunbookStepsOpen[];
}

/** SSE `case.runbook` frame: progress only, to holders of `runbooks:read` and `cases:read`. */
export interface CaseRunbookFrame {
  case_id: string;
  run_id: string;
  progress: RunbookProgress;
  revision: number;
}

// --------------------------------------------------------------------------- //
// §4.10.15 request bodies
// --------------------------------------------------------------------------- //
/** Create a draft, validate, import, or (match preview only) name an existing runbook. */
export interface RunbookSourceBody {
  definition?: RunbookDefinition;
  source?: string;
  id?: string;
  /** The old write shape's key: any value answers `410 runbooks_moved`. Never sent. */
  content?: never;
}

export interface RunbookDraftBody {
  definition?: RunbookDefinition;
  source?: string;
  expected_revision: number;
}

/** `POST /api/runbooks/{id}/submit`: the version sent for review. */
export interface RunbookVersionBody {
  version: number;
  expected_revision?: number;
}

/**
 * `POST /api/runbooks/{id}/publish`. Publishing makes the text trusted investigator
 * guidance (#9), so it is bound to what the publisher reviewed: `expected_revision`
 * (the detail's `revision`) is required, and `content_hash` (the reviewed version's
 * `content_hash`) should always be sent. A mismatch answers `409 runbook_conflict`.
 */
export interface RunbookPublishBody {
  version: number;
  expected_revision: number;
  content_hash?: string | null;
}

export interface RunbookRejectBody {
  version: number;
  /** 1 to 500 characters. */
  reason: string;
  expected_revision?: number;
}

export interface RunbookRevisionBody {
  expected_revision?: number;
}

export interface RunbookAttachBody {
  runbook_id: string;
  note?: string;
}

/**
 * `PATCH .../steps/{step_id}`. A stale `expected_revision` answers
 * `409 runbook_conflict` with the latest state. `assignee: null` clears it.
 */
export interface RunbookStepUpdate {
  expected_revision: number;
  status?: StepStatus;
  assignee?: string | null;
  note?: string;
  reason?: string;
  decision?: { option_id: string };
  action_record?: { where?: string; outcome?: string; performed_at?: string };
  evidence_link?: { kind?: 'link' | 'ticket'; url?: string; label?: string };
}

export interface StepApprovalBody {
  decision: 'approve' | 'reject';
  reason?: string;
}

export interface StepDraftConfirmBody {
  /** The draft as the person edited it (1 to 2,000 characters). */
  text: string;
}

export interface RunbookLookupTestBody {
  lookup: LookupTemplate;
  case_id: string;
}

/** Error codes of the runbook API (§4.10.15), for the page states. */
export type RunbookErrorCode =
  | 'runbook_not_found'
  | 'runbook_version_not_found'
  | 'run_not_found'
  | 'step_not_found'
  | 'runbook_conflict'
  | 'runbook_invalid'
  | 'runbook_prompt_budget'
  | 'runbook_readonly'
  | 'runbook_state'
  | 'runbook_limit'
  | 'run_limit'
  | 'step_state'
  | 'runbook_distinct_approver'
  | 'runbook_approval_role'
  | 'runbook_ai_disabled'
  | 'runbook_id_reserved'
  | 'runbook_demo_readonly'
  | 'runbook_steps_open'
  | 'runbooks_moved'
  | 'lookup_unavailable'
  | 'runbook_store_unavailable';
