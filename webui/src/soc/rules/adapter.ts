/**
 * Rules-FE adapter (Round-5 G6 · R2/R3) — the THIN DETERMINISTIC mapping between the
 * UI `RuleForm` discriminated union and the EXISTING backend wire keys.
 *
 * ┌─ THE INVARIANT THIS FILE PROTECTS (#3) ─────────────────────────────────────┐
 * │ The editor is a CONFIG WRITER. It never calls `decide()` and never sets a    │
 * │ case status. It writes `Preferences.rule_catalog` (a `RuleDefinition[]`) and │
 * │ `Preferences.threshold_automation.rules` (a `CaseAutomationRule[]`) via a     │
 * │ deep-merge `PUT /api/settings`. This adapter is the ONLY place that reshapes  │
 * │ the form into those wire shapes, so `case_manager.decide()` stays             │
 * │ BYTE-IDENTICAL. Round-trip (`wire → form → wire`) is deterministic + lossless │
 * │ for every field the wire carries (asserted in the adapter spec).             │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Wire realities the mapping honours:
 *  - `RuleDefinition.match` is a SINGLE `RuleMatch`, not a list. The normal editor
 *    authors exactly one predicate and the FIRST row is authoritative defensively.
 *  - `mitre`/`schedule`/`suppression` are compatibility metadata. The normal editor
 *    does not expose inactive authoring controls, but existing values MUST survive an
 *    unrelated edit instead of being erased.
 *  - `CorrelationRule.mode` is derived from `n` on save (`n === 1 → 'every'`, else
 *    `'threshold'`) unless the operator explicitly chose `'never'`.
 *  - anomaly maps onto the shared `Preferences.baseline` (`BaselineConfig`) block; a
 *    per-rule anomaly form edits that ONE org block (there is no per-rule baseline in
 *    the wire yet), so `anomalyToBaseline`/`baselineToAnomaly` are separate helpers.
 */
import type {
  BaselineConfig,
  CorrelationMode,
  CorrelationRule,
  RuleDefinition,
  RuleForm,
  RuleMatch,
} from './types';
import { newPredicateRow } from './constants';

/* -------------------------------------------------- detection_match <-> wire */

/** Derive the wire correlation mode from the threshold `n` (preserve explicit 'never'). */
export function modeForN(n: number, explicit?: CorrelationMode): CorrelationMode {
  if (explicit === 'never') return 'never';
  return n <= 1 ? 'every' : 'threshold';
}

/**
 * Map a `detection_match` form → the wire `RuleDefinition`. The first predicate row
 * backs `match`; the threshold backs `correlation`. Returns `null` when the form is
 * unnamed or has no usable predicate (the caller keeps it in the draft, never saves a
 * malformed rule).
 */
export function detectionMatchToWire(form: Extract<RuleForm, { tier: 'detection_match' }>): RuleDefinition | null {
  const name = form.about.name.trim();
  const first = form.predicates[0];
  if (!name || !first || !first.field.trim()) return null;

  const op = first.op;
  const match: RuleMatch = {
    field: first.field.trim(),
    op,
    // `exists` carries no value; other ops keep the (possibly empty) operator string.
    value: op === 'exists' ? null : (first.value ?? '').toString(),
  };

  const correlation: CorrelationRule = {
    mode: modeForN(form.threshold.n, form.threshold.mode),
    n: form.threshold.n,
    window_seconds: form.threshold.windowSeconds,
    // `group_by` is the wider EntityType superset the backend validates; the narrower
    // `CorrelationRule.group_by` UI type is a subset, so the string round-trips.
    group_by: form.threshold.groupBy as CorrelationRule['group_by'],
  };

  const def: RuleDefinition = {
    name,
    enabled: form.about.enabled,
    description: form.about.description ?? '',
    match,
    correlation,
    priority: form.about.priority,
  };
  if (form.about.modelOverride && Object.keys(form.about.modelOverride).length > 0) {
    def.model_override = form.about.modelOverride;
  }
  if (form.about.mitre !== undefined) {
    def.mitre = [...form.about.mitre];
  }
  if (form.schedule !== undefined) {
    def.schedule = {
      interval_seconds: form.schedule.intervalSeconds ?? null,
      lookback_seconds: form.schedule.lookbackSeconds ?? null,
    };
  }
  if (form.suppression !== undefined) {
    def.suppression = {
      by: [...form.suppression.by],
      scope: form.suppression.scope,
      window_seconds: form.suppression.windowSeconds ?? null,
      missing_field: form.suppression.missingField,
    };
  }
  return def;
}

/** Map a wire `RuleDefinition` → a `detection_match` form (lossless for what wire carries). */
export function wireToDetectionMatch(def: RuleDefinition): Extract<RuleForm, { tier: 'detection_match' }> {
  const corr = def.correlation ?? {};
  const n = typeof corr.n === 'number' ? corr.n : 5;
  const schedule = def.schedule
    ? {
        intervalSeconds: def.schedule.interval_seconds ?? undefined,
        lookbackSeconds: def.schedule.lookback_seconds ?? undefined,
      }
    : undefined;
  const suppression = def.suppression
    ? {
        by: [...(def.suppression.by ?? [])],
        scope: def.suppression.scope === 'per_window' ? ('per_window' as const) : ('per_run' as const),
        windowSeconds: def.suppression.window_seconds ?? undefined,
        missingField: def.suppression.missing_field === 'keep' ? ('keep' as const) : ('suppress' as const),
      }
    : undefined;
  const first = def.match
    ? {
        field: def.match.field ?? '',
        op: (def.match.op as RuleMatch['op']) ?? 'equals',
        value: def.match.op === 'exists' ? '' : (def.match.value ?? '') ?? '',
      }
    : newPredicateRow();
  return {
    tier: 'detection_match',
    about: {
      name: def.name ?? '',
      description: def.description ?? '',
      enabled: def.enabled ?? true,
      priority: typeof def.priority === 'number' ? def.priority : 100,
      modelOverride: def.model_override ?? {},
      mitre: [...(def.mitre ?? [])],
    },
    predicates: [first],
    threshold: {
      groupBy: (corr.group_by as Extract<RuleForm, { tier: 'detection_match' }>['threshold']['groupBy']) ?? 'ip',
      n,
      windowSeconds: typeof corr.window_seconds === 'number' ? corr.window_seconds : 120,
      mode: (corr.mode as CorrelationMode) ?? modeForN(n),
    },
    ...(schedule ? { schedule } : {}),
    ...(suppression ? { suppression } : {}),
  };
}

/* ---------------------------------------------------- anomaly <-> baseline - */

/**
 * Map an anomaly form → the shared `BaselineConfig` block (there is no per-rule
 * baseline in the wire yet; the form edits the ONE org `Preferences.baseline`). Only
 * the fields the form owns are written; other `BaselineConfig` keys are preserved by
 * the caller's deep-merge.
 */
export function anomalyToBaseline(
  form: Extract<RuleForm, { tier: 'detection_anomaly' }>,
  prev?: BaselineConfig,
): BaselineConfig {
  return {
    ...(prev ?? {}),
    enabled: form.about.enabled,
    modified_z_threshold: form.anomaly.sensitivity,
    warmup_multiplier: form.anomaly.warmupMultiplier,
    seasonality: form.anomaly.seasonality,
  };
}

/** Seed an anomaly form from the shared `BaselineConfig` block. */
export function baselineToAnomaly(
  cfg: BaselineConfig | undefined,
  about?: Partial<Extract<RuleForm, { tier: 'detection_anomaly' }>['about']>,
): Extract<RuleForm, { tier: 'detection_anomaly' }> {
  const c = cfg ?? {};
  return {
    tier: 'detection_anomaly',
    about: {
      name: about?.name ?? '',
      description: about?.description ?? '',
      enabled: c.enabled ?? false,
      priority: about?.priority ?? 100,
    },
    anomaly: {
      groupBy: 'ip',
      sensitivity: typeof c.modified_z_threshold === 'number' ? c.modified_z_threshold : 3.5,
      warmupMultiplier: typeof c.warmup_multiplier === 'number' ? c.warmup_multiplier : 3,
      seasonality: c.seasonality ?? 'hour_of_week',
    },
  };
}

/* -------------------------------------------- case_automation <-> AutomationRule */

/**
 * Map a `case_automation` form → the wire `CaseAutomationRule` (a.k.a. `AutomationRule`).
 * `id`/`priority`/`enabled` come from the About block; conditions/action/payload from
 * the automation form. Empty conditions round-trip as `{}` (matches any).
 */
export function caseAutomationToWire(
  form: Extract<RuleForm, { tier: 'case_automation' }>,
  id: string,
): import('./types').AutomationRule {
  return {
    id,
    enabled: form.about.enabled,
    priority: form.about.priority,
    conditions: { ...form.automation.conditions },
    action: form.automation.action,
    payload: { ...form.automation.payload },
  };
}

/**
 * A `tag` rule's payload as the editor shows it. The editor edits a `tags` list; a rule
 * written for the API may carry a single `tag` (or `value`) instead, which the engine
 * applies when `tags` lists nothing (`backend/app/engine/case_tags.py`
 * `automation_tags`). That single value is shown as the list's one tag, so the Tags
 * field shows what the rule applies, and saving writes it back as `tags`.
 */
function automationPayloadForEditor(action: unknown, payload: Record<string, unknown>): Record<string, unknown> {
  if (action !== 'tag') return payload;
  const listed = Array.isArray(payload.tags) && payload.tags.some((t) => String(t ?? '').trim());
  if (listed) return payload;
  const single = [payload.tag, payload.value].find((v) => typeof v === 'string' && v.trim());
  if (typeof single !== 'string') return payload;
  const { tag: _tag, value: _value, ...rest } = payload;
  return { ...rest, tags: [single.trim()] };
}

/** Map a wire `AutomationRule` → a `case_automation` form. */
export function wireToCaseAutomation(
  rule: import('./types').AutomationRule,
): Extract<RuleForm, { tier: 'case_automation' }> {
  return {
    tier: 'case_automation',
    about: {
      name: rule.id ?? '',
      description: '',
      enabled: rule.enabled ?? true,
      priority: typeof rule.priority === 'number' ? rule.priority : 100,
    },
    automation: {
      conditions: { ...(rule.conditions ?? {}) },
      action: rule.action,
      payload: automationPayloadForEditor(rule.action, { ...(rule.payload ?? {}) }),
    },
  };
}
