/**
 * Rules-FE constants (Round-5 G6 · R2/R3): the option lists + per-tier metadata +
 * factory defaults the editor + condition builder render.
 *
 * All option VALUES are wire tokens (byte-identical to the backend enums); the
 * LABELS are operator-facing. Nothing here is a secret. The predicate FIELD list is
 * a curated set of common OCSF/entity dotted paths; the operator may still type a
 * custom dotted path (the field control is a combobox, not a locked select), so this
 * is a convenience allow-suggest, not a restriction.
 */
import type {
  AnomalyForm,
  AutomationActionType,
  CaseAutomationForm,
  EntityTypeFull,
  PredicateOp,
  PredicateRow,
  RuleAbout,
  RuleForm,
  RuleTier,
  RuleTierMeta,
  ThresholdForm,
} from './types';

/* -------------------------------------------------------------- tiers ----- */

export const RULE_TIERS: RuleTierMeta[] = [
  {
    tier: 'detection_match',
    label: 'Detection · Match + Threshold',
    blurb:
      'Classify a raw event, then optionally require N of them within a window (n=1 is a simple match; n>1 is a threshold rule).',
    detection: true,
  },
  {
    tier: 'detection_anomaly',
    label: 'Detection · Anomaly / Baseline',
    blurb: 'Fire when a signature deviates from its learned hour-of-week baseline. Advisory: it never closes a case.',
    detection: true,
  },
  {
    tier: 'case_automation',
    label: 'Case-automation (post-decision)',
    blurb:
      'React after the deterministic decision: tag, recommend, notify, attach a runbook, or request approval. Never sets status.',
    detection: false,
  },
];

export const RULE_TIER_BY_ID: Record<RuleTier, RuleTierMeta> = Object.fromEntries(
  RULE_TIERS.map((t) => [t.tier, t]),
) as Record<RuleTier, RuleTierMeta>;

/* -------------------------------------------------------- predicate ops --- */

export const PREDICATE_OPS: Array<{ value: PredicateOp; label: string; hasValue: boolean }> = [
  { value: 'equals', label: 'equals', hasValue: true },
  { value: 'prefix', label: 'starts with', hasValue: true },
  { value: 'tag', label: 'has tag', hasValue: true },
  { value: 'exists', label: 'exists', hasValue: false },
];

/** True when the operator should provide a value for this op (hides the value input). */
export function opHasValue(op: string): boolean {
  return PREDICATE_OPS.find((o) => o.value === op)?.hasValue ?? true;
}

/**
 * Curated common predicate FIELDS (dotted OCSF/native paths). The field control is a
 * combobox; the operator may type any custom dotted path, so this only SUGGESTS.
 */
export const PREDICATE_FIELD_SUGGESTIONS: string[] = [
  'rule.id',
  'rule.name',
  'rule.tags',
  'severity_id',
  'severity',
  'source_ip',
  'src_ip',
  'user.name',
  'host.name',
  'process.name',
  'file.hash',
  'domain',
  'url',
  'event.category',
  'event.action',
];

/* -------------------------------------------------------- entity groups --- */

/** The correlation/anomaly group-by entities (mirrors backend `EntityType` superset). */
export const ENTITY_OPTIONS: Array<{ value: EntityTypeFull; label: string }> = [
  { value: 'ip', label: 'IP' },
  { value: 'user', label: 'User' },
  { value: 'host', label: 'Host' },
  { value: 'file_hash', label: 'File hash' },
  { value: 'domain', label: 'Domain' },
  { value: 'rule', label: 'Rule' },
];

/* ---------------------------------------------------- case-automation opts- */

/**
 * The #3-safe case-automation actions (mirrors the existing Settings › Automation
 * editor). Every one can only tag / recommend / notify / queue / propose; none sets
 * a case status.
 */
export const AUTOMATION_ACTIONS: Array<{ value: AutomationActionType; label: string; help: string }> = [
  { value: 'tag', label: 'Add a tag', help: 'Attach a non-binding tag to the matched case.' },
  { value: 'recommend', label: 'Attach a recommendation', help: 'Record a non-binding recommendation note.' },
  { value: 'notify', label: 'Send a notification', help: 'Fire a notification. Never changes the case.' },
  {
    value: 'run_playbook',
    label: 'Attach a runbook',
    help: 'Attach a published runbook to the case. It guides the people who work the case and never sets status.',
  },
  {
    value: 'request_approval',
    label: 'Request approval (HITL proposal)',
    help: 'Draft a Proposal for an approval-required action. Nothing goes live until a human approves.',
  },
];

/**
 * The case-automation `verdict` CONDITION is compared against the case's LLM
 * `Verdict`, which is ONLY ever one of these three (backend `constants.Verdict`).
 * `suspicious`/`benign` are `Disposition` values and can NEVER equal a `Verdict`, so
 * a rule conditioned on them silently never fires; the dropdown is therefore
 * populated ONLY from the real `Verdict` enum (Rules-FE bug #6).
 */
export const VERDICT_CONDITION_VALUES = ['true_positive', 'false_positive', 'needs_human'] as const;

export const VERDICT_CONDITION_LABELS: Record<string, string> = {
  true_positive: 'True positive',
  false_positive: 'False positive',
  needs_human: 'Needs human',
};

const VALID_VERDICT_SET = new Set<string>(VERDICT_CONDITION_VALUES);

/**
 * True when a rule's `verdict` condition can NEVER match a real `Verdict` (a non-empty
 * value outside the enum, for example a legacy `suspicious`/`benign` `Disposition`). Such a
 * rule is inert; the editor surfaces an "inactive: invalid condition" affordance.
 * Case-insensitive to mirror the backend matcher.
 */
export function hasImpossibleVerdict(verdict: string | undefined): boolean {
  if (typeof verdict !== 'string' || verdict === '') return false;
  return !VALID_VERDICT_SET.has(verdict.toLowerCase());
}

/**
 * Map a STORED verdict-condition value to the `<Select>` item value that should render.
 * The wire token can arrive UPPERCASE (config.py documents FALSE_POSITIVE|TRUE_POSITIVE|
 * NEEDS_HUMAN and the backend matcher is case-insensitive), while the Select items are
 * lowercase, so a valid uppercase verdict must map to its lowercase item or Radix shows
 * a BLANK field for a real, active condition (#28). Returns:
 *   - `''` for an empty/absent condition (caller maps to its "any" sentinel),
 *   - the lowercase wire token for a valid verdict in ANY case,
 *   - the raw value otherwise (surfaced via the disabled "(invalid)" fallback item).
 */
export function normalizedVerdictCondition(verdict: string | undefined): string {
  if (typeof verdict !== 'string' || verdict === '') return '';
  const lower = verdict.toLowerCase();
  return VALID_VERDICT_SET.has(lower) ? lower : verdict;
}

export const STATUS_CONDITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

export const SEASONALITY_OPTIONS: Array<{ value: NonNullable<AnomalyForm['seasonality']>; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'hour_of_day', label: 'Hour of day' },
  { value: 'hour_of_week', label: 'Hour of week' },
  { value: 'day_of_week', label: 'Day of week' },
];

/* -------------------------------------------------------------- defaults -- */

/** The default "About" block for a fresh rule. */
function defaultAbout(detection: boolean): RuleAbout {
  return {
    name: '',
    description: '',
    enabled: true,
    priority: 100,
    ...(detection ? { modelOverride: {}, mitre: [] } : {}),
  };
}

/** A fresh single predicate row. */
export function newPredicateRow(): PredicateRow {
  return { field: '', op: 'equals', value: '' };
}

const DEFAULT_THRESHOLD: ThresholdForm = { groupBy: 'ip', n: 5, windowSeconds: 120, mode: 'threshold' };
const DEFAULT_ANOMALY: AnomalyForm = {
  groupBy: 'ip',
  sensitivity: 3.5,
  warmupMultiplier: 3,
  seasonality: 'hour_of_week',
};
const DEFAULT_AUTOMATION: CaseAutomationForm = { conditions: {}, action: 'tag', payload: { tags: [] } };

/**
 * A factory for a fresh, valid `RuleForm` per tier; the editor seeds a new rule with
 * this and the operator fills in the About name. Bounds match `config.py` defaults.
 */
export function newRuleForm(tier: RuleTier): RuleForm {
  const detection = RULE_TIER_BY_ID[tier].detection;
  if (tier === 'detection_match') {
    return {
      tier,
      about: defaultAbout(detection),
      predicates: [newPredicateRow()],
      threshold: { ...DEFAULT_THRESHOLD },
    };
  }
  if (tier === 'detection_anomaly') {
    return { tier, about: defaultAbout(detection), anomaly: { ...DEFAULT_ANOMALY } };
  }
  return { tier, about: defaultAbout(false), automation: { ...DEFAULT_AUTOMATION, payload: { tags: [] } } };
}

/* --------------------------------------------------- numeric field bounds - */

/** Load-bearing numeric bounds surfaced on the NumberField/LabeledSlider controls. */
export const BOUNDS = {
  n: { min: 1, max: 1000, step: 1, default: 5 },
  windowSeconds: { min: 1, max: 86400, step: 1, default: 120 },
  priority: { min: 0, max: 1000, step: 1, default: 100 },
  sensitivity: { min: 1, max: 10, step: 0.1, default: 3.5 },
  warmupMultiplier: { min: 1, max: 10, step: 1, default: 3 },
  minRisk: { min: 0, max: 100, step: 1 },
  minSeverity: { min: 0, max: 6, step: 1 },
} as const;
