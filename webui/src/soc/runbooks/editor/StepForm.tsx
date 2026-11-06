/**
 * The selected step's form (Round 14, SPEC §4.10.2, §4.10.3, §4.10.12, C11 A): kind,
 * title, instructions, focus, escalate if and benign if, phase, required, evidence, owner
 * and approval roles, target time, RE&CT and D3FEND ids. A Lookup step adds its query
 * template (tool, filters with case values as chips, group by, limit, window, when it
 * runs), the read-only boundary line and "Test with a case"; a Decision step adds its
 * options and the steps each one skips.
 *
 * A read-only viewer (a built-in, a retired runbook, no `runbooks:manage`, Demo Mode)
 * sees the same facts as plain text. Every value is operator text or a test result from
 * the logs: all of it renders as plain text nodes, never markup (#9).
 */
import * as React from 'react';
import { Lock, Play, Plus, Trash2, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import type {
  DecisionOption,
  LookupResult,
  LookupTemplate,
  LookupTool,
  PhaseId,
  RunbookDefinition,
  RunbookStep,
  RunbookTemplateValue,
  StepKind,
} from '@/lib/types-runbooks';
import { testRunbookLookup } from '@/lib/api-runbooks';
import { Field } from '@/soc/components/Field';
import { HelpTip } from '@/soc/components/HelpTip';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { ROLE_LABELS } from '@/soc/pages/Roles.api';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';

import { KIND_ICON, KindChip, ProvenanceChip, TemplateChip } from '../shared/chips';
import { runbookFailure } from '../shared/errors';
import {
  EVIDENCE_LABEL,
  KIND_FORM_NOTE,
  KIND_LABEL,
  LOOKUP_TOOLS,
  LOOKUP_TOOL_GRANT,
  LOOKUP_TOOL_LABEL,
  PHASE_LABEL,
  PHASE_ORDER,
  RUNBOOK_LIMITS,
  RUN_MODE_LABEL,
  STEP_KINDS,
  TEMPLATE_VALUES,
  TEMPLATE_VALUE_LABEL,
  templateToken,
  templateValueOf,
  windowLabel,
} from '../shared/labels';
import {
  laterSteps,
  setOptions,
  switchStepKind,
  updateLookup,
  updateStep,
  uniqueSlug,
  type KindFields,
  type PlacedIssue,
} from './draft';
import { fieldDomId } from './fieldIds';

/** What each lookup tool reads (the server's `TOOL_RULES`). */
const TOOL_RULES: Readonly<
  Record<LookupTool, { filterKeys: readonly string[] | null; minFilters: number; groupBy: boolean; indicator: boolean; maxLimit: number; windowed: boolean }>
> = {
  log_stats: { filterKeys: null, minFilters: 1, groupBy: true, indicator: false, maxLimit: 50, windowed: true },
  log_search: { filterKeys: null, minFilters: 1, groupBy: false, indicator: false, maxLimit: 20, windowed: true },
  enrich: { filterKeys: [], minFilters: 0, groupBy: false, indicator: true, maxLimit: 50, windowed: false },
  related_cases: { filterKeys: ['entity', 'rule'], minFilters: 1, groupBy: false, indicator: false, maxLimit: 10, windowed: true },
  campaign: { filterKeys: ['entity'], minFilters: 0, groupBy: false, indicator: false, maxLimit: 20, windowed: false },
  mitre: { filterKeys: ['technique'], minFilters: 0, groupBy: false, indicator: false, maxLimit: 20, windowed: false },
};

/** The logical log fields a lookup may name (each source maps them to its own field). */
export const LOGICAL_FIELDS: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'ip', label: 'The source IP field' },
  { name: 'user', label: 'The user field' },
  { name: 'host', label: 'The host field' },
  { name: 'rule', label: 'The rule field' },
  { name: 'rule_name', label: 'The rule name field' },
  { name: 'severity', label: 'The severity field' },
  { name: 'action', label: 'event.action on every source' },
];

const INDICATOR_VALUES: readonly RunbookTemplateValue[] = ['entity.ip', 'entity.domain', 'entity.hash', 'entity.url', 'entity.email'];

/** The windows offered by name; any other window of the grammar is typed under "Another window". */
const WINDOW_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  'case_first_seen-1h..case_last_seen+1h',
  'case_first_seen-1d..case_last_seen+1h',
  'case_last_seen-7d..case_last_seen+1h',
  'case_last_seen-30d..case_last_seen',
  'now-24h',
  'now-7d',
  'now-30d',
].map((value) => ({ value, label: windowLabel(value) }));

const TARGET_PRESETS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1_440, label: '1 day' },
  { minutes: 10_080, label: '7 days' },
];

const ANY = '__any__';
const CUSTOM = '__custom__';

export interface StepFormProps {
  defn: RunbookDefinition;
  step: RunbookStep;
  number: number;
  readOnly: boolean;
  /** Issues placed on this step (already filtered to the ones to show). */
  issues: PlacedIssue[];
  onChange: (next: RunbookDefinition) => void;
  /** A field was left: its issues may show now (F17). */
  onTouch: (field: string) => void;
  onRemove?: () => void;
  /** May run "Test with a case" (`runbooks:manage`, `sources:read`, `cases:read`). */
  canTest: boolean;
  /** Cases to offer for the test (from the match preview), newest first. */
  testCases: Array<{ case_id: string; case_number: string; title: string }>;
  /**
   * The kind-specific fields each step set aside when its kind changed, by step id. The
   * editor owns it so it outlives this form (another step selected, the phone sheet closed).
   */
  kindAside?: React.MutableRefObject<Map<string, KindFields>>;
  className?: string;
}

function messagesFor(issues: readonly PlacedIssue[], field: string): string[] {
  return issues
    .filter((i) => i.field === field || i.field.startsWith(`${field}.`) || i.field.startsWith(`${field}[`))
    .map((i) => i.message);
}

function ErrorList({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <>
      {messages.map((m, index) => (
        <span key={index} className="block">
          {m}
        </span>
      ))}
    </>
  );
}

function Counter({ value, max }: { value: string | null | undefined; max: number }) {
  const length = (value ?? '').length;
  return (
    <span className={cn('text-xs tabular-nums', length > max ? 'text-critical-text' : 'text-muted-foreground')}>
      {length.toLocaleString()} of {max.toLocaleString()}
    </span>
  );
}

export function StepForm({
  defn,
  step,
  number,
  readOnly,
  issues,
  onChange,
  onTouch,
  onRemove,
  canTest,
  testCases,
  kindAside,
  className,
}: StepFormProps) {
  const ownAside = React.useRef(new Map<string, KindFields>());
  const aside = kindAside ?? ownAside;
  if (readOnly) return <StepReadOnly defn={defn} step={step} number={number} className={className} />;

  const set = (patch: Partial<RunbookStep>) => onChange(updateStep(defn, step.id, patch));
  const err = (field: string) => {
    const m = messagesFor(issues, field);
    return m.length ? <ErrorList messages={m} /> : undefined;
  };
  const id = (field: string) => fieldDomId(step.id, field);
  const guidancePair = step.kind === 'check' || step.kind === 'decision';
  const approvalKinds = step.kind === 'action' || step.kind === 'record';

  // Arrow keys commit a radio choice at once, so a kind change must never lose what the author
  // wrote: the fields the new kind cannot carry are set aside and come back on a switch back.
  const switchKind = (kind: StepKind) => {
    if (kind === step.kind) return;
    const result = switchStepKind(defn, step.id, kind, aside.current.get(step.id));
    aside.current.set(step.id, result.aside);
    onChange(result.defn);
  };

  return (
    <section
      aria-labelledby={id('heading')}
      className={cn('surface-panel min-w-0 space-y-5 p-4 xl:p-5 3xl:p-6', className)}
      data-step-form={step.id}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={id('heading')} className="text-md font-semibold text-foreground">
          Step {number.toLocaleString()}
        </h2>
        <span className="text-sm text-muted-foreground">{PHASE_LABEL[step.phase]}</span>
        {/* Below 640px the five kinds take their own full-width row, three to a line, so
            none runs past a phone screen; from 640px they sit at the end of the heading row. */}
        <div className="w-full sm:ml-auto sm:w-auto" data-step-kind="">
          <SegmentedControl<StepKind>
            aria-label="Step kind"
            size="sm"
            orientation="both"
            className="grid h-auto w-full grid-cols-3 sm:inline-flex sm:h-8 sm:w-auto"
            value={step.kind}
            onValueChange={switchKind}
            options={STEP_KINDS.map((k) => {
              const Icon = KIND_ICON[k];
              return { value: k, label: KIND_LABEL[k], icon: <Icon className="size-3.5" aria-hidden /> };
            })}
          />
        </div>
      </div>
      <p className="-mt-2 text-sm text-muted-foreground" data-kind-note="">
        {KIND_FORM_NOTE[step.kind]}
      </p>

      <div className="grid gap-4">
        <Field
          label={step.kind === 'check' ? 'Question for the analyst' : 'Title'}
          description={step.kind === 'check' ? 'Write a check as the question it answers.' : undefined}
          error={err('title')}
          labelAction={<Counter value={step.title} max={RUNBOOK_LIMITS.stepTitle} />}
          required
        >
          <Input
            id={id('title')}
            value={step.title}
            onChange={(e) => set({ title: e.target.value })}
            onBlur={() => onTouch('title')}
            className="h-9"
          />
        </Field>
        <Field
          label="Focus"
          description="Which fields to look at. The investigator reads this line."
          error={err('focus')}
          labelAction={<Counter value={step.focus} max={RUNBOOK_LIMITS.guidance} />}
        >
          <Input
            id={id('focus')}
            value={step.focus ?? ''}
            onChange={(e) => set({ focus: e.target.value || null })}
            onBlur={() => onTouch('focus')}
            className="h-9"
          />
        </Field>
        {guidancePair ? (
          <div className="grid gap-4 @container md:grid-cols-2">
            <Field label="Escalate if" error={err('escalate_if')} labelAction={<Counter value={step.escalate_if} max={RUNBOOK_LIMITS.guidance} />}>
              <Textarea
                id={id('escalate_if')}
                rows={2}
                value={step.escalate_if ?? ''}
                onChange={(e) => set({ escalate_if: e.target.value || null })}
                onBlur={() => onTouch('escalate_if')}
              />
            </Field>
            <Field label="Benign if" error={err('benign_if')} labelAction={<Counter value={step.benign_if} max={RUNBOOK_LIMITS.guidance} />}>
              <Textarea
                id={id('benign_if')}
                rows={2}
                value={step.benign_if ?? ''}
                onChange={(e) => set({ benign_if: e.target.value || null })}
                onBlur={() => onTouch('benign_if')}
              />
            </Field>
          </div>
        ) : null}
        <Field
          label="Instructions"
          description="For people only, never part of the investigator prompt. Paragraphs, lists, bold, italics, inline code and https links."
          error={err('instructions')}
          labelAction={<Counter value={step.instructions} max={RUNBOOK_LIMITS.instructions} />}
        >
          <Textarea
            id={id('instructions')}
            rows={4}
            value={step.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            onBlur={() => onTouch('instructions')}
          />
        </Field>
      </div>

      {step.kind === 'lookup' && step.lookup ? (
        <LookupEditor
          defn={defn}
          step={step}
          lookup={step.lookup}
          issues={issues}
          onChange={onChange}
          onTouch={onTouch}
          canTest={canTest}
          testCases={testCases}
        />
      ) : null}
      {step.kind === 'decision' ? (
        <DecisionEditor defn={defn} step={step} issues={issues} onChange={onChange} onTouch={onTouch} />
      ) : null}

      <div className="space-y-4 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <Label htmlFor={id('required')} className="block text-sm font-medium text-foreground">
              Required
            </Label>
            <span className="block text-sm text-muted-foreground">
              A case closed by hand with this step open asks for a reason. It never blocks the close.
            </span>
          </span>
          <Switch id={id('required')} checked={step.required} onCheckedChange={(on) => set({ required: on })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phase" error={err('phase')} data-rb-field={id('phase')}>
            {({ id: fid, labelledBy }) => (
              <Select value={step.phase} onValueChange={(v) => onChange(updateStep(defn, step.id, { phase: v as PhaseId }))}>
                <SelectTrigger id={fid} aria-labelledby={labelledBy} className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHASE_ORDER.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PHASE_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Evidence before Done" error={err('evidence')} data-rb-field={id('evidence')}>
            {({ id: fid, labelledBy }) => (
              <Select value={step.evidence} onValueChange={(v) => set({ evidence: v as RunbookStep['evidence'] })}>
                <SelectTrigger id={fid} aria-labelledby={labelledBy} className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['none', 'note', 'note_or_attachment'] as const).map((e) => (
                    <SelectItem key={e} value={e}>
                      {EVIDENCE_LABEL[e]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <RoleField
            label="Who does it"
            fieldId={id('owner_role')}
            value={step.owner_role}
            anyLabel="Any analyst"
            error={err('owner_role')}
            onChange={(v) => set({ owner_role: v })}
          />
          {approvalKinds ? (
            <RoleField
              label="Approved by"
              fieldId={id('approval_role')}
              description="Honoured only when step approvals are on in Settings."
              value={step.approval_role}
              anyLabel="No approval"
              error={err('approval_role')}
              onChange={(v) => set({ approval_role: v })}
            />
          ) : null}
          <Field label="Target time" description="Shown on the step, never enforced." error={err('target_minutes')} data-rb-field={id('target_minutes')}>
            {({ id: fid, labelledBy, describedBy }) => {
              const preset = TARGET_PRESETS.find((p) => p.minutes === step.target_minutes);
              const value = step.target_minutes == null ? ANY : preset ? String(preset.minutes) : CUSTOM;
              return (
                <Select
                  value={value}
                  onValueChange={(v) => {
                    if (v === CUSTOM) return;
                    set({ target_minutes: v === ANY ? null : Number(v) });
                  }}
                >
                  <SelectTrigger id={fid} aria-labelledby={labelledBy} aria-describedby={describedBy} className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>No target</SelectItem>
                    {TARGET_PRESETS.map((p) => (
                      <SelectItem key={p.minutes} value={String(p.minutes)}>
                        {p.label}
                      </SelectItem>
                    ))}
                    {value === CUSTOM ? (
                      <SelectItem value={CUSTOM}>{`${(step.target_minutes ?? 0).toLocaleString()} minutes`}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              );
            }}
          </Field>
          <Field label="RE&CT id" description="For example RA3101." error={err('react')}>
            <Input
              id={id('react')}
              value={step.react ?? ''}
              onChange={(e) => set({ react: e.target.value || null })}
              onBlur={() => onTouch('react')}
              className="h-9 font-mono text-xs"
            />
          </Field>
          <Field label="D3FEND id" description="For example D3-NI." error={err('d3fend')}>
            <Input
              id={id('d3fend')}
              value={step.d3fend ?? ''}
              onChange={(e) => set({ d3fend: e.target.value || null })}
              onBlur={() => onTouch('d3fend')}
              className="h-9 font-mono text-xs"
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            Step id <span className="font-mono text-xs text-foreground">{step.id}</span>
            <span className="sr-only">. Runs keep their progress across versions by this id.</span>
          </span>
          {onRemove ? (
            <Button type="button" variant="ghost" size="sm" className="hover:text-critical-text" onClick={onRemove}>
              <Trash2 aria-hidden />
              Remove step
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function RoleField({
  label,
  fieldId,
  description,
  value,
  anyLabel,
  error,
  onChange,
}: {
  label: string;
  fieldId: string;
  description?: string;
  value: string | null;
  anyLabel: string;
  error?: React.ReactNode;
  onChange: (value: string | null) => void;
}) {
  const known = value == null || Object.prototype.hasOwnProperty.call(ROLE_LABELS, value);
  return (
    <Field label={label} description={description} error={error} data-rb-field={fieldId}>
      {({ id, labelledBy, describedBy }) => (
        <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? null : v)}>
          <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy} className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{anyLabel}</SelectItem>
            {Object.entries(ROLE_LABELS).map(([role, words]) => (
              <SelectItem key={role} value={role}>
                {words}
              </SelectItem>
            ))}
            {!known && value ? <SelectItem value={value}>{value}</SelectItem> : null}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}

/* ----------------------------------------------------------------- lookup -- */

function LookupEditor({
  defn,
  step,
  lookup,
  issues,
  onChange,
  onTouch,
  canTest,
  testCases,
}: {
  defn: RunbookDefinition;
  step: RunbookStep;
  lookup: LookupTemplate;
  issues: PlacedIssue[];
  onChange: (next: RunbookDefinition) => void;
  onTouch: (field: string) => void;
  canTest: boolean;
  testCases: Array<{ case_id: string; case_number: string; title: string }>;
}) {
  const rules = TOOL_RULES[lookup.tool];
  const setLookup = (patch: Partial<LookupTemplate>) => onChange(updateLookup(defn, step.id, patch));
  const err = (field: string) => {
    const m = messagesFor(issues, field);
    return m.length ? <ErrorList messages={m} /> : undefined;
  };
  const entries = Object.entries(lookup.filter);
  const filterAllowed = rules.filterKeys === null || rules.filterKeys.length > 0;
  const limitMax = rules.maxLimit;

  // A filter is a map from field to value, so two rows can never name one field: a key that
  // another row already holds is refused (the row keeps its earlier key and says why) rather
  // than letting the map collapse two rows into one.
  const setFilterAt = (index: number, key: string, value: string) => {
    if (entries.some(([k], i) => i !== index && k === key)) return;
    const next = entries.map(([k, v], i) => (i === index ? [key, value] : [k, v]));
    setLookup({ filter: Object.fromEntries(next) });
  };
  const removeFilterAt = (index: number) => setLookup({ filter: Object.fromEntries(entries.filter((_, i) => i !== index)) });
  const addFilter = () => {
    const keys = rules.filterKeys ?? LOGICAL_FIELDS.map((f) => f.name);
    let key = keys.find((k) => !(k in lookup.filter));
    for (let n = entries.length + 1; !key; n += 1) if (!(`field_${n}` in lookup.filter)) key = `field_${n}`;
    setLookup({ filter: { ...lookup.filter, [key]: '' } });
  };

  return (
    <section
      aria-labelledby={fieldDomId(step.id, 'lookup-heading')}
      className="space-y-4 border-t border-border/70 pt-4"
      data-lookup-editor=""
      data-rb-field={fieldDomId(step.id, 'lookup')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={fieldDomId(step.id, 'lookup-heading')} className="text-sm font-semibold text-foreground">
          Lookup query
        </h3>
        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          Read-only
        </span>
      </div>
      <Field
        label="Tool"
        description={LOOKUP_TOOL_GRANT[lookup.tool]}
        error={err('lookup.tool')}
        data-rb-field={fieldDomId(step.id, 'lookup.tool')}
      >
        {({ id, labelledBy, describedBy }) => (
          <Select
            value={lookup.tool}
            onValueChange={(v) => {
              const tool = v as LookupTool;
              const next = TOOL_RULES[tool];
              setLookup({
                tool,
                group_by: next.groupBy ? lookup.group_by : [],
                indicator: next.indicator ? lookup.indicator ?? templateToken('entity.ip') : null,
                filter:
                  next.filterKeys === null
                    ? lookup.filter
                    : Object.fromEntries(Object.entries(lookup.filter).filter(([k]) => next.filterKeys?.includes(k))),
                limit: Math.min(lookup.limit, next.maxLimit),
              });
            }}
          >
            <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOOKUP_TOOLS.map((t) => (
                <SelectItem key={t} value={t}>
                  {LOOKUP_TOOL_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {filterAllowed ? (
        <fieldset className="space-y-2" data-lookup-filters="" data-rb-field={fieldDomId(step.id, 'lookup.filter')}>
          <legend className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            Filters
            {rules.filterKeys === null ? (
              <HelpTip
                label="About lookup fields"
                alwaysPopover
                text="ip, user, host, rule, rule_name and severity mean each source's own mapped field, so one runbook works on every source. action is event.action on every source. Any other name is read as a log field path, such as event.outcome. ip, user, host and rule take their case value or a literal of the same kind; rule_name, severity and action take a literal."
              />
            ) : null}
          </legend>
          {entries.length ? (
            <ul className="space-y-2">
              {entries.map(([key, value], index) => (
                <FilterRow
                  key={index}
                  stepId={step.id}
                  index={index}
                  fieldKey={key}
                  value={value}
                  keyOptions={rules.filterKeys}
                  otherKeys={entries.filter((_, i) => i !== index).map(([k]) => k)}
                  issues={messagesFor(issues, `lookup.filter.${key}`)}
                  onChange={(k, v) => setFilterAt(index, k, v)}
                  onRemove={() => removeFilterAt(index)}
                  onTouch={() => onTouch('lookup')}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {rules.minFilters > 0 ? 'Add a filter, so the lookup looks at this case’s data.' : 'No filter: the lookup uses the case itself.'}
            </p>
          )}
          {messagesFor(issues, 'lookup.filter')
            .filter((m) => !entries.some(([k]) => issues.some((i) => i.field.startsWith(`lookup.filter.${k}`) && i.message === m)))
            .map((m, i) => (
              <p key={i} role="alert" className="text-sm text-critical-text">
                {m}
              </p>
            ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            disabled={entries.length >= (rules.filterKeys?.length || RUNBOOK_LIMITS.filters)}
            onClick={addFilter}
          >
            <Plus aria-hidden />
            Add filter
          </Button>
        </fieldset>
      ) : null}

      {rules.indicator ? (
        <Field label="Indicator to enrich" description="One case value, looked up through the cached enrichment path." error={err('lookup.indicator')}
          data-rb-field={fieldDomId(step.id, 'lookup.indicator')}
        >
          {({ id, labelledBy, describedBy }) => (
            <Select
              value={templateValueOf(lookup.indicator) ?? ANY}
              onValueChange={(v) => setLookup({ indicator: v === ANY ? null : templateToken(v as RunbookTemplateValue) })}
            >
              <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy} className="h-9">
                <SelectValue placeholder="Choose a case value" />
              </SelectTrigger>
              <SelectContent>
                {INDICATOR_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {TEMPLATE_VALUE_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {rules.groupBy ? (
          <GroupByField stepId={step.id} value={lookup.group_by} error={err('lookup.group_by')} onChange={(group_by) => setLookup({ group_by })} />
        ) : null}
        <Field
          label={lookup.tool === 'log_search' ? 'Rows' : 'Limit'}
          description={`1 to ${limitMax.toLocaleString()}.`}
          error={err('lookup.limit')}
          data-rb-field={fieldDomId(step.id, 'lookup.limit')}
        >
          {({ id, labelledBy, describedBy }) => (
            <Select value={String(Math.min(lookup.limit, limitMax))} onValueChange={(v) => setLookup({ limit: Number(v) })}>
              <SelectTrigger id={id} aria-labelledby={labelledBy} aria-describedby={describedBy} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[5, 10, 20, 25, 50]
                  .filter((n) => n <= limitMax)
                  .concat(lookup.limit <= limitMax && ![5, 10, 20, 25, 50].includes(lookup.limit) ? [lookup.limit] : [])
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n.toLocaleString()}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>

      {rules.windowed ? (
        <WindowField stepId={step.id} value={lookup.window} error={err('lookup.window')} onChange={(window) => setLookup({ window })} onTouch={() => onTouch('lookup')} />
      ) : null}

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-foreground">Runs</legend>
        <RadioGroup
          value={lookup.run}
          onValueChange={(v) => setLookup({ run: v as LookupTemplate['run'] })}
          className="flex flex-wrap gap-2"
          aria-label="When the lookup runs"
        >
          {(['on_attach', 'on_demand'] as const).map((mode) => (
            <label
              key={mode}
              htmlFor={fieldDomId(step.id, `run-${mode}`)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                lookup.run === mode ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-secondary-foreground',
              )}
            >
              <RadioGroupItem id={fieldDomId(step.id, `run-${mode}`)} value={mode} />
              {RUN_MODE_LABEL[mode]}
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      <p className="flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm text-secondary-foreground" data-lookup-boundary="">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        Read-only. Case values are passed as parameters; results are untrusted.
      </p>

      {canTest ? <LookupTest lookup={lookup} stepId={step.id} cases={testCases} /> : null}
    </section>
  );
}

function FilterRow({
  stepId,
  index,
  fieldKey,
  value,
  keyOptions,
  otherKeys,
  issues,
  onChange,
  onRemove,
  onTouch,
}: {
  stepId: string;
  index: number;
  fieldKey: string;
  value: string;
  keyOptions: readonly string[] | null;
  /** The fields the other rows filter on: a row cannot take one of them. */
  otherKeys: readonly string[];
  issues: string[];
  onChange: (key: string, value: string) => void;
  onRemove: () => void;
  onTouch: () => void;
}) {
  // The typed field name, while it cannot be stored yet (empty, or another row's field).
  const [draftKey, setDraftKey] = React.useState<string | null>(null);
  React.useEffect(() => setDraftKey(null), [fieldKey]);
  const keyProblem =
    draftKey === null ? null : !draftKey.trim() ? 'Name the field to filter on.' : otherKeys.includes(draftKey.trim()) ? 'This field is already filtered.' : null;
  const typeKey = (text: string) => {
    const next = text.trim();
    if (!next || otherKeys.includes(next)) {
      setDraftKey(text);
      return;
    }
    setDraftKey(null);
    onChange(next, value);
  };
  const shownIssues = keyProblem ? [keyProblem, ...issues] : issues;
  const template = templateValueOf(value);
  const keyId = fieldDomId(stepId, `filter-${index}-key`);
  const valueId = fieldDomId(stepId, `filter-${index}-value`);
  const errorId = fieldDomId(stepId, `filter-${index}-error`);
  const listId = fieldDomId(stepId, `filter-${index}-fields`);
  return (
    <li className="space-y-1" data-rb-field={fieldDomId(stepId, `lookup.filter.${fieldKey}`)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.3fr)_auto] items-center gap-2">
        {keyOptions ? (
          <Select value={fieldKey} onValueChange={(k) => onChange(k, value)}>
            <SelectTrigger id={keyId} aria-label={`Filter ${index + 1} field`} className="h-8 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {keyOptions.map((k) => (
                <SelectItem key={k} value={k} disabled={otherKeys.includes(k)}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              id={keyId}
              aria-label={`Filter ${index + 1} field`}
              list={listId}
              value={draftKey ?? fieldKey}
              aria-invalid={shownIssues.length ? true : undefined}
              aria-describedby={shownIssues.length ? errorId : undefined}
              onChange={(e) => typeKey(e.target.value)}
              onBlur={onTouch}
              className="h-8 font-mono text-xs"
            />
            <datalist id={listId}>
              {LOGICAL_FIELDS.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </datalist>
          </>
        )}
        <span className="text-sm text-muted-foreground">equals</span>
        {template ? (
          <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-input bg-card px-2" id={valueId}>
            <TemplateChip>{templateToken(template)}</TemplateChip>
            <span className="truncate text-sm text-muted-foreground">from the case</span>
            <button
              type="button"
              aria-label={`Use a literal value for filter ${index + 1} instead`}
              onClick={() => onChange(fieldKey, '')}
              className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        ) : (
          <Input
            id={valueId}
            aria-label={`Filter ${index + 1} value`}
            value={value}
            aria-invalid={issues.length ? true : undefined}
            aria-describedby={issues.length ? errorId : undefined}
            onChange={(e) => onChange(fieldKey, e.target.value)}
            onBlur={onTouch}
            className="h-8 font-mono text-xs"
          />
        )}
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove filter ${index + 1}`} onClick={onRemove}>
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      {!template ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-0.5" role="group" aria-label={`Case values for filter ${index + 1}`}>
          <span className="text-xs text-muted-foreground">Case values:</span>
          {TEMPLATE_VALUES.filter((v) => v.startsWith('entity.') || v === 'case.rule').map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onChange(fieldKey, templateToken(v))}
              title={TEMPLATE_VALUE_LABEL[v]}
              className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <TemplateChip>{templateToken(v)}</TemplateChip>
            </button>
          ))}
        </div>
      ) : null}
      {shownIssues.length ? (
        <p id={errorId} role="alert" className="text-sm text-critical-text">
          <ErrorList messages={shownIssues} />
        </p>
      ) : null}
    </li>
  );
}

function GroupByField({
  stepId,
  value,
  error,
  onChange,
}: {
  stepId: string;
  value: string[];
  error?: React.ReactNode;
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = React.useState('');
  const id = fieldDomId(stepId, 'lookup.group_by');
  const listId = `${id}-fields`;
  const add = () => {
    const name = text.trim();
    if (!name || value.includes(name) || value.length >= RUNBOOK_LIMITS.groupBy) return;
    onChange([...value, name]);
    setText('');
  };
  return (
    <Field label="Group by" description={`Up to ${RUNBOOK_LIMITS.groupBy} fields.`} error={error}>
      {({ labelledBy, describedBy }) => (
        <div className="space-y-1.5">
          {value.length ? (
            <ul className="flex flex-wrap gap-1" aria-label="Grouped by">
              {value.map((g) => (
                <li key={g} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {g}
                  <button
                    type="button"
                    aria-label={`Stop grouping by ${g}`}
                    onClick={() => onChange(value.filter((x) => x !== g))}
                    className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {value.length < RUNBOOK_LIMITS.groupBy ? (
            <div className="flex gap-2">
              <Input
                id={id}
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
                list={listId}
                value={text}
                placeholder="user, or event.outcome"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
                className="h-8 font-mono text-xs"
              />
              <datalist id={listId}>
                {LOGICAL_FIELDS.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </datalist>
              <Button type="button" variant="outline" size="sm" className="h-8" onClick={add}>
                Add
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Field>
  );
}

function WindowField({
  stepId,
  value,
  error,
  onChange,
  onTouch,
}: {
  stepId: string;
  value: string;
  error?: React.ReactNode;
  onChange: (next: string) => void;
  onTouch: () => void;
}) {
  const preset = WINDOW_PRESETS.find((p) => p.value === value);
  const [custom, setCustom] = React.useState(!preset);
  const id = fieldDomId(stepId, 'lookup.window');
  return (
    <Field
      label="Time window"
      description="Relative to the case, so the same runbook works on any case. At most 30 days; the end is cut to when the lookup runs."
      error={error}
    >
      {({ labelledBy, describedBy }) => (
        <div className="space-y-2">
          <Select
            value={custom ? CUSTOM : value}
            onValueChange={(v) => {
              if (v === CUSTOM) {
                setCustom(true);
                return;
              }
              setCustom(false);
              onChange(v);
            }}
          >
            <SelectTrigger aria-labelledby={labelledBy} aria-describedby={describedBy} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Another window</SelectItem>
            </SelectContent>
          </Select>
          {custom ? (
            <Input
              id={id}
              aria-label="Window"
              value={value}
              placeholder="case_first_seen-1h..case_last_seen+1h"
              onChange={(e) => onChange(e.target.value)}
              onBlur={onTouch}
              className="h-9 font-mono text-xs"
            />
          ) : null}
        </div>
      )}
    </Field>
  );
}

function LookupTest({
  lookup,
  stepId,
  cases,
}: {
  lookup: LookupTemplate;
  stepId: string;
  cases: Array<{ case_id: string; case_number: string; title: string }>;
}) {
  const [caseId, setCaseId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<LookupResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputId = fieldDomId(stepId, 'test-case');
  const listId = `${inputId}-list`;
  const typed = caseId.trim();
  // A listed case is found by its number or id; anything else is sent as a case id, the
  // only form the test reads, and an unknown one comes back as "not found" in plain words.
  const resolved = cases.find((c) => c.case_number === typed || c.case_id === typed);
  const run = async () => {
    const target = resolved?.case_id ?? typed;
    if (!target) {
      setError('Choose a case to test with.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await testRunbookLookup({ lookup, case_id: target }));
    } catch (e) {
      setResult(null);
      const failure = runbookFailure(e, 'The test could not run. Try again.');
      setError(
        failure.code === 'case_not_found' || failure.status === 404
          ? 'No case has that id. Choose a listed case, or paste the id from the case page.'
          : failure.message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2.5" data-lookup-test="">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1 space-y-1">
          <Label htmlFor={inputId} className="text-sm font-medium">
            Test with a case
          </Label>
          <Input
            id={inputId}
            list={listId}
            value={caseId}
            placeholder={cases.length ? 'A listed case, or a case id' : 'A case id'}
            onChange={(e) => setCaseId(e.target.value)}
            className="h-8 font-mono text-xs"
          />
          <datalist id={listId}>
            {cases.map((c) => (
              <option key={c.case_id} value={c.case_number || c.case_id}>
                {c.title}
              </option>
            ))}
          </datalist>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void run()} disabled={busy} aria-busy={busy}>
          <Play aria-hidden />
          {busy ? 'Running' : 'Run test'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Runs once against the case without saving anything. Nothing is attached to the case.</p>
      <div aria-live="polite">
        {error ? <p className="text-sm text-critical-text">{error}</p> : null}
        {result ? <LookupResultView result={result} /> : null}
      </div>
    </div>
  );
}

/** A lookup result as plain text: status, count, facts and the table (untrusted values). */
export function LookupResultView({ result }: { result: LookupResult }) {
  const count =
    result.count == null ? null : `${result.count_relation === 'gte' ? 'at least ' : ''}${result.count.toLocaleString()}`;
  return (
    <div className="space-y-2 text-sm" data-lookup-result={result.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ProvenanceChip kind="auto">Test result</ProvenanceChip>
        <span className="text-foreground">
          {result.status === 'ok'
            ? 'Found'
            : result.status === 'empty'
              ? 'Nothing found'
              : result.status === 'partial'
                ? 'Partly answered'
                : result.status === 'not_applicable'
                  ? 'Does not apply to this case'
                  : 'Could not run'}
        </span>
        {count ? <span className="tabular-nums text-foreground">{count} {result.tool === 'log_search' ? 'rows' : 'results'}</span> : null}
      </div>
      {result.reason ? <p className="text-muted-foreground">{result.reason}</p> : null}
      {Object.keys(result.params).length ? (
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
          {Object.entries(result.params).map(([k, v]) => (
            <span key={k} className="[overflow-wrap:anywhere]">
              {k} = {v}
            </span>
          ))}
        </p>
      ) : null}
      {result.facts.length ? (
        <dl className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)]">
          {result.facts.map((fact, index) => (
            <React.Fragment key={index}>
              <dt className="text-muted-foreground">{fact.label ?? Object.keys(fact)[0]}</dt>
              <dd className="text-foreground [overflow-wrap:anywhere]">{fact.value ?? Object.values(fact)[0]}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      {result.table && result.table.columns.length ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr>
                {result.table.columns.map((c, i) => (
                  <th key={i} scope="col" className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.table.rows.map((row, r) => (
                <tr key={r} className="border-b border-border/60 last:border-b-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-2 py-1 font-mono text-foreground [overflow-wrap:anywhere]">
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result.window_clamped ? <p className="text-xs text-muted-foreground">Searched up to now; later data was not collected yet.</p> : null}
    </div>
  );
}

/* --------------------------------------------------------------- decision -- */

function DecisionEditor({
  defn,
  step,
  issues,
  onChange,
  onTouch,
}: {
  defn: RunbookDefinition;
  step: RunbookStep;
  issues: PlacedIssue[];
  onChange: (next: RunbookDefinition) => void;
  onTouch: (field: string) => void;
}) {
  const later = laterSteps(defn, step.id);
  const setAll = (options: DecisionOption[]) => onChange(setOptions(defn, step.id, options));
  const setOne = (index: number, patch: Partial<DecisionOption>) =>
    setAll(step.options.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  const general = messagesFor(issues, 'options').filter(
    (m) => !issues.some((i) => /^options\[\d+\]/.test(i.field) && i.message === m),
  );
  return (
    <section
      aria-labelledby={fieldDomId(step.id, 'options-heading')}
      className="space-y-3 border-t border-border/70 pt-4"
      data-decision-editor=""
      data-rb-field={fieldDomId(step.id, 'options')}
    >
      <h3 id={fieldDomId(step.id, 'options-heading')} className="text-sm font-semibold text-foreground">
        Options
      </h3>
      <p className="text-sm text-muted-foreground">
        Two to six options. An option can mark later steps Not applicable when it is picked; it never changes the verdict.
      </p>
      <ol className="space-y-3">
        {step.options.map((option, index) => {
          const optionIssues = messagesFor(issues, `options[${index}]`);
          return (
            <li
              key={index}
              className="space-y-2 rounded-md border border-border px-3 py-2.5"
              data-decision-option={option.id}
              data-rb-field={fieldDomId(step.id, `options[${index}]`)}
            >
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                <div className="space-y-1">
                  <Label htmlFor={fieldDomId(step.id, `option-${index}-label`)} className="text-sm">
                    Option {index + 1}
                  </Label>
                  <Input
                    id={fieldDomId(step.id, `option-${index}-label`)}
                    value={option.label}
                    placeholder="For example Confirmed compromise"
                    onChange={(e) => setOne(index, { label: e.target.value })}
                    onBlur={() => onTouch('options')}
                    className="h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={fieldDomId(step.id, `option-${index}-id`)} className="text-sm">
                    Id
                  </Label>
                  <Input
                    id={fieldDomId(step.id, `option-${index}-id`)}
                    value={option.id}
                    onChange={(e) => setOne(index, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })}
                    onBlur={() => onTouch('options')}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`Remove option ${index + 1}`}
                  disabled={step.options.length <= RUNBOOK_LIMITS.optionsMin}
                  onClick={() => setAll(step.options.filter((_, i) => i !== index))}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
              {later.length ? (
                <fieldset className="space-y-1">
                  <legend className="text-sm text-muted-foreground">When picked, skip</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {later.map((s) => {
                      const cid = fieldDomId(step.id, `option-${index}-skip-${s.id}`);
                      return (
                        <label key={s.id} htmlFor={cid} className="flex items-center gap-1.5 text-sm text-foreground">
                          <Checkbox
                            id={cid}
                            checked={option.marks_not_applicable.includes(s.id)}
                            onCheckedChange={(on) =>
                              setOne(index, {
                                marks_not_applicable:
                                  on === true
                                    ? [...option.marks_not_applicable, s.id]
                                    : option.marks_not_applicable.filter((x) => x !== s.id),
                              })
                            }
                          />
                          <span className="[overflow-wrap:anywhere]">{s.title || s.id}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ) : null}
              {optionIssues.length ? (
                <p role="alert" className="text-sm text-critical-text">
                  <ErrorList messages={optionIssues} />
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {general.map((m, i) => (
        <p key={i} role="alert" className="text-sm text-critical-text">
          {m}
        </p>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 px-2"
        disabled={step.options.length >= RUNBOOK_LIMITS.optionsMax}
        onClick={() =>
          setAll([
            ...step.options,
            { id: uniqueSlug('option', step.options.map((o) => o.id)), label: '', marks_not_applicable: [] },
          ])
        }
      >
        <Plus aria-hidden />
        Add option
      </Button>
    </section>
  );
}

/* -------------------------------------------------------------- read only -- */

function ReadRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

/** A step as plain text: the same fields as the form, for a read-only runbook. */
export function StepReadOnly({
  defn,
  step,
  number,
  className,
}: {
  defn: RunbookDefinition;
  step: RunbookStep;
  number: number;
  className?: string;
}) {
  const l = step.lookup;
  return (
    <section aria-label={`Step ${number}`} className={cn('surface-panel min-w-0 space-y-4 p-4 xl:p-5 3xl:p-6', className)} data-step-read-only={step.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-semibold text-foreground">Step {number.toLocaleString()}</h2>
        <span className="text-sm text-muted-foreground">{PHASE_LABEL[step.phase]}</span>
        <KindChip kind={step.kind} />
        <span className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          Read only
        </span>
      </div>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <ReadRow label={step.kind === 'check' ? 'Question' : 'Title'}>{step.title}</ReadRow>
        {step.focus ? <ReadRow label="Focus">{step.focus}</ReadRow> : null}
        {step.escalate_if ? <ReadRow label="Escalate if">{step.escalate_if}</ReadRow> : null}
        {step.benign_if ? <ReadRow label="Benign if">{step.benign_if}</ReadRow> : null}
        {step.instructions ? (
          <ReadRow label="Instructions">
            <span className="whitespace-pre-wrap">{step.instructions}</span>
          </ReadRow>
        ) : null}
        {l ? (
          <ReadRow label="Lookup">
            <span className="block">{LOOKUP_TOOL_LABEL[l.tool]}</span>
            {Object.entries(l.filter).map(([k, v]) => {
              const t = templateValueOf(v);
              return (
                <span key={k} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-mono text-muted-foreground">{k}</span>
                  <span className="text-muted-foreground">equals</span>
                  {t ? <TemplateChip>{templateToken(t)}</TemplateChip> : <span className="font-mono">{v}</span>}
                </span>
              );
            })}
            {l.indicator ? <span className="block text-xs text-muted-foreground">Enriches {l.indicator}</span> : null}
            {l.group_by.length ? <span className="block text-xs text-muted-foreground">Group by {l.group_by.join(', ')}</span> : null}
            <span className="block text-xs text-muted-foreground">
              {windowLabel(l.window)} · at most {l.limit.toLocaleString()} · {RUN_MODE_LABEL[l.run].toLowerCase()}
            </span>
          </ReadRow>
        ) : null}
        {step.options.length ? (
          <ReadRow label="Options">
            <ul className="space-y-0.5">
              {step.options.map((o) => (
                <li key={o.id}>
                  {o.label || o.id}
                  {o.marks_not_applicable.length ? (
                    <span className="text-muted-foreground">
                      {' '}
                      skips{' '}
                      {o.marks_not_applicable
                        .map((id) => defn.steps.find((s) => s.id === id)?.title || id)
                        .join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </ReadRow>
        ) : null}
        <ReadRow label="Required">
          {step.required ? 'Yes. A case closed by hand with this step open asks for a reason.' : 'No, optional'}
        </ReadRow>
        {step.evidence !== 'none' ? <ReadRow label="Evidence before Done">{EVIDENCE_LABEL[step.evidence]}</ReadRow> : null}
        {step.owner_role ? <ReadRow label="Who does it">{ROLE_LABELS[step.owner_role] ?? step.owner_role}</ReadRow> : null}
        {step.approval_role ? <ReadRow label="Approved by">{ROLE_LABELS[step.approval_role] ?? step.approval_role}</ReadRow> : null}
        {step.target_minutes ? <ReadRow label="Target time">{`${step.target_minutes.toLocaleString()} minutes`}</ReadRow> : null}
        {step.react ? <ReadRow label="RE&CT">{step.react}</ReadRow> : null}
        {step.d3fend ? <ReadRow label="D3FEND">{step.d3fend}</ReadRow> : null}
      </dl>
    </section>
  );
}
