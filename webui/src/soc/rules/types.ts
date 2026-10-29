/**
 * Rules-FE shared types (Round-5 G6 · R2/R3): the UI-only form model for the
 * "Detection & rules" editor, plus the RBAC grant every mutation gates on.
 *
 * ┌─ WHY A SEPARATE FORM MODEL ─────────────────────────────────────────────────┐
 * │ The editor is POLYMORPHIC on a TS discriminated union (`RuleForm`) over three │
 * │ tiers, but every tier is backed by an EXISTING backend config shape          │
 * │ (`RuleDefinition`/`CorrelationRule`/`RuleMatch`, `BaselineConfig`,           │
 * │ `CaseAutomationRule`). The form is a friendlier, tab-organised projection;   │
 * │ a THIN DETERMINISTIC ADAPTER (`./adapter`) maps `RuleForm` ⇄ those wire keys │
 * │ so `engine/case_manager.decide()` stays BYTE-IDENTICAL (#3). No control here │
 * │ ever calls `decide()` or sets a case status.                                 │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Everything a rule carries (name, description, predicate field and value, tags) is
 * OPERATOR-authored and LOG-adjacent, so it renders PLAIN TEXT everywhere (#9).
 * Secrets never live on a rule; model overrides carry a selection, never a key (#10).
 *
 * These shapes are additive + defaulted; they mirror (and re-export) the config
 * types already in `@/lib/types` so a lifecycle/preview agent imports from ONE place.
 */
import type {
  AutomationActionType,
  AutomationConditions,
  AutomationRule,
  BaselineConfig,
  CorrelationMode,
  CorrelationRule,
  EntityTypeFull,
  ModelConfig,
  RuleDefinition,
  RuleMatch,
} from '@/lib/types';

// Re-export the backing config types so downstream (lifecycle/preview) importers use
// this module as the single rules entry-point rather than reaching into lib/types.
export type {
  AutomationActionType,
  AutomationConditions,
  AutomationRule,
  BaselineConfig,
  CorrelationMode,
  CorrelationRule,
  EntityTypeFull,
  ModelConfig,
  RuleDefinition,
  RuleMatch,
};

/* -------------------------------------------------------------- RBAC ------- */

/**
 * The ONE grant every rules MUTATION gates on (R9 unification). The backend RBAC
 * vocabulary (`rbac/policy.py RESOURCES`) exposes a unified `rules` resource with
 * `read` / `manage`, and the whole rules-customization router (`routes_rules.py`)
 * enforces `rules:read` on every read and `rules:manage` on every mutation. The FE
 * MUST gate on the SAME resource end-to-end (the nav/section gate, every in-editor
 * `<Can>`, the version-ledger Restore, and the Save), so a custom role granted the
 * advertised unified `rules:*` can actually use the editor (and a role WITHOUT it is
 * honestly blocked rather than seeing enabled buttons that then 403). Built-in roles
 * derive `rules` from `settings` (`_settings_like`), so this is behaviour-preserving
 * for them and correct for custom roles (M2 / bug-#7 class).
 */
export const RULES_PERM = { resource: 'rules', action: 'manage' } as const;
/** The read-only grant (view the catalog / open the read-only editor). */
export const RULES_READ_PERM = { resource: 'rules', action: 'read' } as const;

/* --------------------------------------------------------- tier taxonomy --- */

/**
 * The three rule tiers the editor exposes (RESEARCH_RULES_UX §2). Each is backed by
 * existing code; we deliberately do NOT copy Elastic's 7 rule types.
 *
 * - `detection_match`: a classify-an-event rule (`RuleDefinition` + one
 *                          `RuleMatch`) with an optional threshold (`CorrelationRule`:
 *                          `n === 1` ⇒ a simple match rule; `n > 1` ⇒ a threshold rule).
 * - `detection_anomaly`: fire on deviation from a learned baseline (`BaselineConfig`);
 *                          advisory input to a candidate, NEVER `decide()`.
 * - `case_automation`: a POST-decision, HITL-safe reaction (`CaseAutomationRule`);
 *                          tag/recommend/notify/attach a runbook (the stored
 *                          `run_playbook` literal, Round 14)/request_approval; NEVER
 *                          sets status or auto-closes (#3, code-enforced backend-side).
 */
export type RuleTier = 'detection_match' | 'detection_anomaly' | 'case_automation';

/** Static metadata per tier (label / blurb / whether it is a config-writer only). */
export interface RuleTierMeta {
  tier: RuleTier;
  label: string;
  /** One-line description (plain text). */
  blurb: string;
  /** True for a detection tier (writes `rule_catalog`); false for case-automation. */
  detection: boolean;
}

/* --------------------------------------------------------- condition rows -- */

/**
 * One flat predicate row (R3). This IS the backend `RuleMatch` shape
 * (`{field, op, value}`). The wire and normal editor support exactly one row;
 * nested AND/OR and multi-predicate authoring stay unavailable until the runtime can
 * persist and execute them. `field`/`value` are operator-authored → plain text (#9).
 * When `op === 'exists'` the value is unused.
 */
export interface PredicateRow {
  field: string;
  op: RuleMatch['op'];
  value?: string;
}

/** The predicate operators the backend `RuleMatch` evaluates. */
export type PredicateOp = 'equals' | 'prefix' | 'tag' | 'exists';

/* --------------------------------------------------------- threshold ------ */

/**
 * The threshold + grouping knobs (mirrors `CorrelationRule`). `n === 1` renders the
 * editor as a MATCH rule (no count gate); `n > 1` renders it as a THRESHOLD rule
 * ("fire when ≥ N events share the group-by within the window"). `mode` mirrors the
 * wire enum; the UI derives it from `n` on save (`n === 1 → 'every'`, else
 * `'threshold'`) but preserves an explicit `'never'`.
 */
export interface ThresholdForm {
  /** Group-by entity (the correlation key). */
  groupBy: EntityTypeFull;
  /** Trigger-after count (≥1). 1 ⇒ match rule; >1 ⇒ threshold rule. */
  n: number;
  /** Window (seconds ≥1) over which the N events must occur. */
  windowSeconds: number;
  /** Explicit correlation mode; preserved on round-trip (usually derived from `n`). */
  mode?: CorrelationMode;
}

/**
 * Compatibility projection for advisory suppression metadata already present on the
 * wire. The normal editor does not expose this storage-only block because the runtime
 * does not execute it. The adapter keeps it hidden and round-trips it non-destructively
 * so an unrelated edit never erases externally stored intent (#3/#4).
 */
export interface SuppressionForm {
  /** Up-to-3 fields to collapse a storm by (plain text). */
  by: string[];
  /** Per-run vs. per-time-window suppression. */
  scope: 'per_run' | 'per_window';
  /** Window (seconds) for `per_window` scope. */
  windowSeconds?: number;
  /** Behaviour when a group-by field is missing on an event. */
  missingField: 'suppress' | 'keep';
}

/* --------------------------------------------------------- anomaly -------- */

/**
 * The anomaly/baseline knobs (mirrors `BaselineConfig`). Fires when a signature
 * deviates from its learned baseline; advisory only (never feeds `decide()`).
 */
export interface AnomalyForm {
  /** Group-by entity for the per-signature baseline. */
  groupBy: EntityTypeFull;
  /** Modified-z deviation bar (default |M| > 3.5). */
  sensitivity: number;
  /** `warmup_multiplier` × min_samples guards a cold series. */
  warmupMultiplier: number;
  /** Seasonality bucketing (mirrors `BaselineConfig.seasonality`). */
  seasonality: NonNullable<BaselineConfig['seasonality']>;
}

/* --------------------------------------------------------- case-automation- */

/**
 * The case-automation form (mirrors `CaseAutomationRule` / `AutomationRule`). A
 * matched rule reacts AFTER the deterministic decision and can only tag / recommend /
 * notify / attach a runbook / request approval; it NEVER sets status (#3). Attach a
 * runbook keeps the stored `run_playbook` action and writes `payload.runbook_id` and
 * `payload.playbook_id` with the same id (SPEC §4.10.16). This mirrors
 * the existing `Settings › Automation` editor so the two stay wire-compatible.
 */
export interface CaseAutomationForm {
  /** ANDed conditions; an absent condition means "any". */
  conditions: AutomationConditions;
  /** The single #3-safe action. */
  action: AutomationActionType;
  /** Action-specific payload (operator-authored, TRUSTED-but-plain). */
  payload: Record<string, unknown>;
}

/* --------------------------------------------------------- the union ------ */

/**
 * The "About" metadata shared by every tier (name / description / enabled /
 * priority / per-role model overrides / compatibility MITRE metadata).
 * `name`/`description` are plain (#9); `modelOverride` carries a ModelConfig
 * selection, never a secret key (#10).
 */
export interface RuleAbout {
  name: string;
  description: string;
  enabled: boolean;
  /** Lower runs first. */
  priority: number;
  /** Per-role model overrides (role → selection). Detection tiers only. */
  modelOverride?: Record<string, ModelConfig>;
  /** Hidden compatibility metadata; preserved on edit, not authored in the normal UI. */
  mitre?: string[];
}

/**
 * The lifecycle state a rule sits in (RESEARCH_RULES_UX §6a). `shadow` evaluates
 * against live data but creates no real cases (degrades to advisory). This is a
 * UI-forward concept the lifecycle wave persists; the editor carries it so the shell
 * can render it. Detection tiers use `enabled`⇄`disabled`; `shadow` is opt-in.
 */
export type RuleLifecycleState = 'enabled' | 'disabled' | 'shadow';

/**
 * The DISCRIMINATED UNION the editor's Define tab is polymorphic on. Each variant is
 * a self-contained, tier-specific form. `about` + `schedule` are common. A thin
 * deterministic adapter (`./adapter`) maps this ⇄ the existing wire keys.
 */
export type RuleForm =
  | {
      tier: 'detection_match';
      about: RuleAbout;
      /** Array-shaped for compatibility; exactly one row backs the wire `match`. */
      predicates: PredicateRow[];
      threshold: ThresholdForm;
      suppression?: SuppressionForm;
      schedule?: ScheduleForm;
    }
  | {
      tier: 'detection_anomaly';
      about: RuleAbout;
      anomaly: AnomalyForm;
      schedule?: ScheduleForm;
    }
  | {
      tier: 'case_automation';
      about: RuleAbout;
      automation: CaseAutomationForm;
    };

/**
 * Hidden compatibility projection for advisory per-rule schedule metadata. The
 * poller's per-feed schedule + `{source.id}:{feed.id}` cursor owns actual cadence,
 * so the normal UI explains inherited cadence without offering inactive inputs.
 */
export interface ScheduleForm {
  /** Stored cadence intent (seconds); not executed by the current runtime. */
  intervalSeconds?: number;
  /** Stored look-back intent (seconds); not executed by the current runtime. */
  lookbackSeconds?: number;
}

/* --------------------------------------------------------- catalog item --- */

/**
 * A row in the "Detection & rules" home. Detection rules come from
 * `Preferences.rule_catalog` (a `RuleDefinition[]`); case-automation rules from
 * `Preferences.threshold_automation.rules`. The home merges both into one table
 * keyed by a stable local `key` (name for detection, id for automation).
 */
export interface RuleCatalogItem {
  /** Stable local key for React lists: the source-array INDEX, so rules with a
   * DUPLICATE display name never collide (detection rules are keyed by free-text name
   * on the wire; two same-named rules must still edit/delete independently, #24). */
  key: string;
  tier: RuleTier;
  /** The index of this rule in its source wire array (`rule_catalog` for detection,
   * `threshold_automation.rules` for automation): the authoritative identity used to
   * edit/delete/toggle exactly this row, never a name/id match (#24). */
  sourceIndex: number;
  /** Display name (plain text). */
  name: string;
  enabled: boolean;
  /** Ascending run order. */
  priority: number;
  /** The lifecycle state chip (defaults from `enabled`). */
  lifecycle: RuleLifecycleState;
}
