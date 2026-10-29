/**
 * RuleEditor (Round-5 G6 · R2/R3): the four-section rule editor shell:
 * Define → About → Schedule → Actions (Radix `Tabs`), with the **Define** tab
 * POLYMORPHIC on the `RuleForm` discriminated union over three tiers.
 *
 * Adopts Elastic's four-section pattern (RESEARCH_RULES_UX §3): logic (Define) is
 * separated from metadata (About) from ops (Schedule/Actions). Every field is
 * `Field`/`Label`-wrapped for a11y; every numeric knob uses the W0 `NumberField` /
 * `LabeledSlider` (stepper + clamp + readout); tags/allowlists use `TagInput`.
 *
 * ⛔ CONFIG WRITER ONLY (#3): this component edits a `RuleForm` in memory and hands
 * it back via `onChange`; it NEVER calls `decide()` and NEVER sets a case status. The
 * host maps the form ⇄ wire via `./adapter` and saves through the deep-merge
 * `PUT /api/settings`. The normal editor exposes only controls the runtime persists
 * and executes. Compatibility-only metadata is round-tripped by `./adapter`, but is
 * deliberately hidden until it has an operator-visible runtime contract.
 *
 * #9: `name`/`description`/predicate `field`/`value`/tags are operator-authored →
 * rendered as plain-text inputs. #10: no secret is shown; model overrides carry a
 * selection, never a key.
 */
import * as React from 'react';
import { Lock, Wrench } from 'lucide-react';

import { listRunbookLibrary } from '@/lib/api-runbooks';
import type { RunbookSummary } from '@/lib/types-runbooks';
import { CASE_TAG_MAX_CHARS } from '@/lib/tags';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { TagInput } from '@/soc/components/TagInput';
import { HelpTip } from '@/soc/components/HelpTip';
import { StatusDot } from '@/design-system/status-dot';
import { isAttachable, resolveAutomationRunbook } from '@/soc/runbooks/shared/legacy';

import { ConditionBuilder } from './ConditionBuilder';
import type { RuleForm, RuleTier } from './types';
import {
  AUTOMATION_ACTIONS,
  BOUNDS,
  ENTITY_OPTIONS,
  RULE_TIERS,
  RULE_TIER_BY_ID,
  SEASONALITY_OPTIONS,
  STATUS_CONDITION_OPTIONS,
  VERDICT_CONDITION_LABELS,
  VERDICT_CONDITION_VALUES,
  hasImpossibleVerdict,
  normalizedVerdictCondition,
} from './constants';

const ANY = '__any__';

export interface RuleEditorProps {
  /** The rule form being edited (controlled). */
  value: RuleForm;
  onChange: (next: RuleForm) => void;
  /** Read-only preview (RBAC without `automation:manage`); disables every control. */
  readOnly?: boolean;
  /** Allow switching the rule TIER (only for a brand-new rule; editing keeps the tier). */
  allowTierChange?: boolean;
  onTierChange?: (tier: RuleTier) => void;
}

/* ------------------------------------------------------------- About tab --- */

function AboutTab({ value, onChange, readOnly, allowTierChange }: RuleEditorProps) {
  const about = value.about;
  const setAbout = (patch: Partial<typeof about>) => onChange({ ...value, about: { ...about, ...patch } } as RuleForm);
  // A case-automation rule is keyed on the wire ONLY by `id` (there is no `name`/
  // `description` field on `CaseAutomationRule`). So instead of a required Name input
  // whose value is silently discarded and replaced by an opaque machine id (#25), a NEW
  // case-automation rule's Name becomes its identifier, and an EXISTING one shows that
  // id read-only (ids are stable and cannot be renamed).
  const isCaseAutomation = value.tier === 'case_automation';
  const isNewRule = Boolean(allowTierChange);

  return (
    <div className="space-y-4">
      {isCaseAutomation && !isNewRule ? (
        <Field
          label="Identifier"
          description="The rule's stable id, set when it was created. It cannot be renamed."
        >
          <Input value={about.name} disabled readOnly className="font-mono text-sm" />
        </Field>
      ) : (
        <Field
          label="Name"
          required={!isCaseAutomation}
          description={
            isCaseAutomation
              ? "Also becomes this rule's stable identifier, shown in the rules list. Leave blank to auto-generate one."
              : 'A human-facing rule name. Rendered as plain text everywhere.'
          }
        >
          <Input
            value={about.name}
            disabled={readOnly}
            placeholder={
              isCaseAutomation
                ? 'e.g. tag-confirmed-true-positives'
                : 'e.g. SSH brute-force from a single source'
            }
            onChange={(e) => setAbout({ name: e.target.value })}
          />
        </Field>
      )}

      {/* Description persists for detection tiers only. The case-automation wire has no
          description field, so it is hidden for case-automation to avoid a dead input (#25). */}
      {isCaseAutomation ? null : (
        <Field label="Description" description="What this rule detects and why it matters.">
          <Textarea
            value={about.description}
            disabled={readOnly}
            rows={3}
            placeholder="Optional context for the on-call analyst."
            onChange={(e) => setAbout({ description: e.target.value })}
          />
        </Field>
      )}

      <NumberField
        label="Priority"
        description="Lower runs first when several rules match."
        value={about.priority}
        min={BOUNDS.priority.min}
        max={BOUNDS.priority.max}
        step={BOUNDS.priority.step}
        defaultValue={BOUNDS.priority.default}
        disabled={readOnly}
        onChange={(v) => setAbout({ priority: v })}
      />

    </div>
  );
}

/* ---------------------------------------------------- Define: match tier -- */

function DefineMatch({ value, onChange, readOnly }: RuleEditorProps & { value: Extract<RuleForm, { tier: 'detection_match' }> }) {
  const form = value;
  const th = form.threshold;
  const setThreshold = (patch: Partial<typeof th>) => onChange({ ...form, threshold: { ...th, ...patch } });
  const isThreshold = th.n > 1;

  return (
    <div className="space-y-5">
      {/* conditions */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          Condition
          <HelpTip text="Match one raw-event field. Detection rules currently persist and evaluate exactly one predicate." />
        </div>
        <ConditionBuilder
          value={form.predicates}
          disabled={readOnly}
          onChange={(next) => onChange({ ...form, predicates: next })}
        />
      </section>

      {/* active correlation threshold */}
      <section className="space-y-3 rounded-md border border-border bg-surface p-3">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          Threshold
          <HelpTip text="Group-by + count. n=1 is a simple match rule; n>1 fires only when ≥ N matching events share the group-by within the window." />
          <Badge variant={isThreshold ? 'high' : 'secondary'} className="ml-1">
            {isThreshold ? 'Threshold rule' : 'Match rule'}
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Group by">
            {({ id, labelledBy }) => (
              <Select
                value={th.groupBy}
                disabled={readOnly}
                onValueChange={(v) => setThreshold({ groupBy: v as typeof th.groupBy })}
              >
                <SelectTrigger id={id} aria-labelledby={labelledBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <NumberField
            label="Trigger after N"
            value={th.n}
            min={BOUNDS.n.min}
            max={BOUNDS.n.max}
            step={BOUNDS.n.step}
            defaultValue={BOUNDS.n.default}
            unit="events"
            disabled={readOnly}
            onChange={(v) => setThreshold({ n: v, mode: v <= 1 ? 'every' : 'threshold' })}
          />
          <NumberField
            label="Within window"
            value={th.windowSeconds}
            min={BOUNDS.windowSeconds.min}
            max={BOUNDS.windowSeconds.max}
            step={BOUNDS.windowSeconds.step}
            defaultValue={BOUNDS.windowSeconds.default}
            unit="sec"
            disabled={readOnly}
            onChange={(v) => setThreshold({ windowSeconds: v })}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {isThreshold
            ? `Fires when ${th.n} or more events share the same ${th.groupBy} within ${th.windowSeconds} seconds.`
            : `Fires on every matching event (no count gate).`}
        </p>
      </section>
    </div>
  );
}

/* -------------------------------------------------- Define: anomaly tier -- */

function DefineAnomaly({ value, onChange, readOnly }: RuleEditorProps & { value: Extract<RuleForm, { tier: 'detection_anomaly' }> }) {
  const form = value;
  const an = form.anomaly;
  const setAnomaly = (patch: Partial<typeof an>) => onChange({ ...form, anomaly: { ...an, ...patch } });

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Anomaly rules are advisory.</span> A deviation raises a candidate
        that goes through the usual correlation and decision. It never closes a case and never overrides the
        deterministic decision.
      </p>

      <Field label="Group by" description="The signature whose hour-of-week baseline is learned.">
        {({ id, labelledBy, describedBy }) => (
          <Select
            value={an.groupBy}
            disabled={readOnly}
            onValueChange={(v) => setAnomaly({ groupBy: v as typeof an.groupBy })}
          >
            <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <LabeledSlider
        label="Sensitivity (modified-z)"
        description="Lower = more sensitive (more anomalies). Default |M| > 3.5."
        value={an.sensitivity}
        min={BOUNDS.sensitivity.min}
        max={BOUNDS.sensitivity.max}
        step={BOUNDS.sensitivity.step}
        disabled={readOnly}
        formatValue={(v) => `|M| > ${v.toFixed(1)}`}
        ticks={[
          { value: 2, label: '2 (loose)' },
          { value: 3.5, label: '3.5' },
          { value: 6, label: '6 (strict)' },
        ]}
        onChange={(v) => setAnomaly({ sensitivity: v })}
      />

      <NumberField
        label="Warm-up multiplier"
        description="warmup × min-samples must accrue before a cold series can fire."
        value={an.warmupMultiplier}
        min={BOUNDS.warmupMultiplier.min}
        max={BOUNDS.warmupMultiplier.max}
        step={BOUNDS.warmupMultiplier.step}
        defaultValue={BOUNDS.warmupMultiplier.default}
        disabled={readOnly}
        onChange={(v) => setAnomaly({ warmupMultiplier: v })}
      />

      <Field label="Seasonality" description="How observations are bucketed for the baseline.">
        {({ id, labelledBy, describedBy }) => (
          <Select
            value={an.seasonality}
            disabled={readOnly}
            onValueChange={(v) => setAnomaly({ seasonality: v as typeof an.seasonality })}
          >
            <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEASONALITY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </div>
  );
}

/* ------------------------------------------ Define: case-automation tier -- */

function DefineCaseAutomation({
  value,
  onChange,
  readOnly,
}: RuleEditorProps & { value: Extract<RuleForm, { tier: 'case_automation' }> }) {
  const form = value;
  const cond = form.automation.conditions;
  const setCond = (patch: Partial<typeof cond>) =>
    onChange({ ...form, automation: { ...form.automation, conditions: { ...cond, ...patch } } });
  const invalidVerdict = hasImpossibleVerdict(cond.verdict);
  // Map a valid-but-uppercase wire verdict to its lowercase Select item; empty → ANY
  // sentinel; an invalid value stays raw and is surfaced via the disabled fallback (#28).
  const verdictSelectValue = normalizedVerdictCondition(cond.verdict) || ANY;

  return (
    <div className="space-y-5">
      <Alert variant="warning">
        <Lock className="h-4 w-4" aria-hidden />
        <AlertTitle>Runs after the deterministic decision and never sets status</AlertTitle>
        <AlertDescription>
          A matched rule can only tag, recommend, notify, attach a runbook, or draft an approval
          proposal. It never closes a case or changes its status.
        </AlertDescription>
      </Alert>

      <section className="space-y-3">
        <div className="text-sm font-medium text-foreground">When a case matches all of these</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Verdict"
            error={
              invalidVerdict
                ? 'This rule will never fire: a verdict is only ever true/false positive or needs-human.'
                : undefined
            }
          >
            {({ id, labelledBy, describedBy, invalid }) => (
              <Select
                value={verdictSelectValue}
                disabled={readOnly}
                onValueChange={(v) => setCond({ verdict: v === ANY ? undefined : v })}
              >
                <SelectTrigger
                  id={id}
                  aria-labelledby={labelledBy}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any verdict</SelectItem>
                  {VERDICT_CONDITION_VALUES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {VERDICT_CONDITION_LABELS[v]}
                    </SelectItem>
                  ))}
                  {invalidVerdict && typeof cond.verdict === 'string' ? (
                    <SelectItem value={cond.verdict} disabled>
                      {cond.verdict} (invalid)
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field label="Status">
            {({ id, labelledBy }) => (
              <Select
                value={cond.status || ANY}
                disabled={readOnly}
                onValueChange={(v) => setCond({ status: v === ANY ? undefined : v })}
              >
                <SelectTrigger id={id} aria-labelledby={labelledBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any status</SelectItem>
                  {STATUS_CONDITION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <NumberField
            label="Minimum risk"
            value={typeof cond.min_risk === 'number' ? cond.min_risk : 0}
            min={BOUNDS.minRisk.min}
            max={BOUNDS.minRisk.max}
            step={BOUNDS.minRisk.step}
            unit="/100"
            disabled={readOnly}
            onChange={(v) => setCond({ min_risk: v === 0 ? undefined : v })}
          />
          <NumberField
            label="Minimum severity"
            value={typeof cond.min_severity === 'number' ? cond.min_severity : 0}
            min={BOUNDS.minSeverity.min}
            max={BOUNDS.minSeverity.max}
            step={BOUNDS.minSeverity.step}
            disabled={readOnly}
            onChange={(v) => setCond({ min_severity: v === 0 ? undefined : v })}
          />

          <Field label="Source id (optional)">
            <Input
              value={cond.source_id || ''}
              disabled={readOnly}
              placeholder="Any source"
              onChange={(e) => setCond({ source_id: e.target.value || undefined })}
            />
          </Field>
          <Field label="Rule name contains (optional)">
            <Input
              value={cond.rule_name || ''}
              disabled={readOnly}
              placeholder="Any rule"
              onChange={(e) => setCond({ rule_name: e.target.value || undefined })}
            />
          </Field>
        </div>

        {invalidVerdict ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={readOnly}
            onClick={() => setCond({ verdict: undefined })}
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden />
            Clear the invalid verdict
          </Button>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ Define tab -- */

function DefineTab(props: RuleEditorProps) {
  const { value } = props;
  if (value.tier === 'detection_match') return <DefineMatch {...props} value={value} />;
  if (value.tier === 'detection_anomaly') return <DefineAnomaly {...props} value={value} />;
  return <DefineCaseAutomation {...props} value={value} />;
}

/* ---------------------------------------------------------- Schedule tab -- */

function ScheduleTab({ value }: RuleEditorProps) {
  // Case-automation reacts post-decision (no schedule of its own).
  if (value.tier === 'case_automation') {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">No schedule.</span> Case-automation rules run right after each
        case is decided; they have no run schedule of their own.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Cadence comes from the source feed.</span> Detection rules run
      whenever their source feed polls, from that feed&apos;s durable cursor. Change the polling cadence on the source
      feed; this rule has no schedule of its own.
    </p>
  );
}

/* ----------------------------------------------------------- Actions tab -- */

/**
 * "Attach a runbook" (Round 14, SPEC §4.10.16): a published runbook picked by name. The rule
 * keeps the stored `run_playbook` action (the naming contract) and writes the id as
 * `payload.runbook_id` and, for compatibility, `payload.playbook_id`. A rule whose stored
 * target is unknown, a draft only or retired shows "Needs a runbook": the server skips it at
 * fire time. A rule with nothing chosen yet shows only the field and its placeholder.
 *
 * The library is read with the built-ins a published copy replaces, because the server still
 * attaches a replaced built-in a rule names (only automatic matching skips it); the picker
 * lists those only when the rule already names one.
 */
function AttachRunbookField({
  payload,
  readOnly,
  onChange,
}: {
  payload: Record<string, unknown>;
  readOnly?: boolean;
  onChange: (runbookId: string) => void;
}) {
  const [library, setLibrary] = React.useState<RunbookSummary[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    listRunbookLibrary({ show_replaced: true })
      .then((lib) => {
        if (alive) setLibrary(lib.runbooks);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const target = resolveAutomationRunbook(payload, failed ? null : library);
  const stored =
    (typeof payload.runbook_id === 'string' && payload.runbook_id) ||
    (typeof payload.playbook_id === 'string' && payload.playbook_id) ||
    '';

  if (failed) {
    return (
      <Field label="Runbook id" description="The runbooks could not be listed, so type the id of a published runbook.">
        <Input value={stored} disabled={readOnly} onChange={(e) => onChange(e.target.value.trim())} />
      </Field>
    );
  }
  const value = target.status === 'attaches' && target.id ? target.id : '';
  const options = (library ?? [])
    .filter((r) => isAttachable(r) && (!r.replaced_by || r.id === value))
    .sort((a, b) => a.title.localeCompare(b.title));
  const replacedBy = target.status === 'attaches' && target.runbook?.replaced_by
    ? (library ?? []).find((r) => r.id === target.runbook?.replaced_by) ?? null
    : null;
  return (
    <div className="space-y-2" data-attach-runbook={stored ? target.status : 'empty'}>
      <Field label="Runbook" description="Only published runbooks are listed.">
        {({ id, labelledBy, describedBy }) => (
          <Select value={value} disabled={readOnly || library === null} onValueChange={onChange}>
            <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
              <SelectValue placeholder={library === null ? 'Loading runbooks' : 'Choose a published runbook'} />
            </SelectTrigger>
            <SelectContent>
              {options.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      {library !== null && stored && target.status === 'needs_runbook' ? (
        <div className="space-y-0.5" role="status">
          <StatusDot tone="warning">Needs a runbook</StatusDot>
          <p className="text-sm text-muted-foreground">
            {`The runbook this rule names (${stored}) is not published, so the rule is skipped until you choose one.`}
          </p>
        </div>
      ) : null}
      {target.runbook?.replaced_by ? (
        <p className="text-sm text-muted-foreground" data-attach-replaced="">
          {`Your team's copy${replacedBy ? `, ${replacedBy.title},` : ''} replaces this built-in for matching. This rule still attaches the built-in; choose your copy to attach it instead.`}
        </p>
      ) : null}
      {target.status === 'attaches' && target.via !== 'runbook_id' && stored ? (
        <p className="text-sm text-muted-foreground">{`Found from the earlier id ${stored}. It keeps working; pick the runbook again to record its id.`}</p>
      ) : null}
    </div>
  );
}

function ActionsTab({ value, onChange, readOnly }: RuleEditorProps) {
  // Only case-automation carries a bound action; detection tiers create candidate cases.
  if (value.tier !== 'case_automation') {
    return (
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Detection rules create candidate cases.</span> What a detection
        rule finds goes through the usual correlation and decision. To react to the case that results (tag, notify,
        attach a runbook, propose), add a case-automation rule.
      </p>
    );
  }
  const auto = value.automation;
  const setPayload = (patch: Record<string, unknown>) =>
    onChange({ ...value, automation: { ...auto, payload: { ...auto.payload, ...patch } } });
  const actionMeta = AUTOMATION_ACTIONS.find((a) => a.value === auto.action);

  return (
    <div className="space-y-4">
      <Field label="Action" description={actionMeta?.help}>
        {({ id, labelledBy, describedBy }) => (
          <Select
            value={String(auto.action)}
            disabled={readOnly}
            onValueChange={(v) => onChange({ ...value, automation: { ...auto, action: v, payload: {} } })}
          >
            <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTOMATION_ACTIONS.map((a) => (
                <SelectItem key={String(a.value)} value={String(a.value)}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Badge variant="warning" className="gap-1">
        <Lock className="h-3 w-3" aria-hidden />
        Never closes a case
      </Badge>

      {auto.action === 'tag' ? (
        <TagInput
          label="Tags"
          value={Array.isArray(auto.payload.tags) ? (auto.payload.tags as string[]) : []}
          disabled={readOnly}
          placeholder="e.g. auto-triaged"
          maxLength={CASE_TAG_MAX_CHARS}
          onChange={(next) => setPayload({ tags: next })}
        />
      ) : null}
      {auto.action === 'recommend' ? (
        <Field label="Recommendation text">
          <Input
            value={typeof auto.payload.text === 'string' ? auto.payload.text : ''}
            disabled={readOnly}
            placeholder="e.g. Review with the identity team"
            onChange={(e) => setPayload({ text: e.target.value })}
          />
        </Field>
      ) : null}
      {auto.action === 'notify' ? (
        <Field label="Channel id (optional)">
          <Input
            value={typeof auto.payload.channel_id === 'string' ? auto.payload.channel_id : ''}
            disabled={readOnly}
            placeholder="All enabled channels"
            onChange={(e) => setPayload({ channel_id: e.target.value })}
          />
        </Field>
      ) : null}
      {auto.action === 'run_playbook' ? (
        <AttachRunbookField
          payload={auto.payload}
          readOnly={readOnly}
          onChange={(id) => setPayload({ runbook_id: id, playbook_id: id })}
        />
      ) : null}
      {auto.action === 'request_approval' ? (
        <Field label="Proposal kind">
          <Input
            value={typeof auto.payload.kind === 'string' ? auto.payload.kind : ''}
            disabled={readOnly}
            placeholder="e.g. suppression"
            onChange={(e) => setPayload({ kind: e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- the shell -- */

export function RuleEditor(props: RuleEditorProps) {
  const { value, readOnly, allowTierChange, onTierChange } = props;
  const [tab, setTab] = React.useState('define');

  return (
    <div className="space-y-4">
      {/* enabled + tier header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={value.about.enabled}
            disabled={readOnly}
            aria-label="Rule enabled"
            onCheckedChange={(v) => props.onChange({ ...value, about: { ...value.about, enabled: v } } as RuleForm)}
          />
          <span className="text-sm text-muted-foreground">
            {value.about.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div className="min-w-[16rem]">
          {allowTierChange ? (
            <Select
              value={value.tier}
              onValueChange={(v) => onTierChange?.(v as RuleTier)}
              disabled={readOnly}
            >
              <SelectTrigger aria-label="Rule type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_TIERS.map((t) => (
                  <SelectItem key={t.tier} value={t.tier}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="secondary">{RULE_TIER_BY_ID[value.tier].label}</Badge>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Rule editor sections">
          <TabsTrigger value="define">Define</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>
        <TabsContent value="define" className="pt-4">
          <DefineTab {...props} />
        </TabsContent>
        <TabsContent value="about" className="pt-4">
          <AboutTab {...props} />
        </TabsContent>
        <TabsContent value="schedule" className="pt-4">
          <ScheduleTab {...props} />
        </TabsContent>
        <TabsContent value="actions" className="pt-4">
          <ActionsTab {...props} />
        </TabsContent>
      </Tabs>

      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          Read only: you can view this rule but not change it.
        </p>
      ) : null}
    </div>
  );
}
RuleEditor.displayName = 'RuleEditor';
