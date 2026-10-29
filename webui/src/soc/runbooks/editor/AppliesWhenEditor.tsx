/**
 * "Applies when" as chips under the editor header, with a picker per criterion (Round 14,
 * SPEC §4.10.4, §4.10.12): rules (from the rule catalogue and recent case rules),
 * techniques (ATT&CK ids), severity, entity types, sources, verdicts, statuses, tags and a
 * minimum event count. Read only for a built-in or a viewer without `runbooks:manage`.
 *
 * Values typed here are operator text and rule values seen in cases are untrusted: every
 * chip renders its value as a plain text node (#9).
 */
import * as React from 'react';
import { Plus, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { AppliesWhen, MatchCriterion, RunbookEntityType, RunbookVerdict } from '@/lib/types-runbooks';
import type { SeverityLevel } from '@/lib/types-rules';
import { HelpTip } from '@/soc/components/HelpTip';
import { NumberField } from '@/soc/components/NumberField';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Switch } from '@/ui/switch';

import {
  CASE_STATUSES,
  CASE_STATUS_WORD,
  CRITERIA_ORDER,
  CRITERION_LABEL,
  ENTITY_TYPES,
  ENTITY_TYPE_LABEL,
  RUNBOOK_LIMITS,
  SEVERITY_LEVELS,
  SEVERITY_WORD,
  VERDICTS,
  VERDICT_WORD,
} from '../shared/labels';

/** Where the pickers' suggestions come from (all optional; free text always works). */
export interface CriteriaSuggestions {
  rules: string[];
  techniques: string[];
  sources: Array<{ value: string; label: string }>;
}

export interface AppliesWhenEditorProps {
  value: AppliesWhen;
  onChange?: (next: AppliesWhen) => void;
  readOnly: boolean;
  suggestions: CriteriaSuggestions;
  /** Issues for `applies_when.*`, shown under the chips. */
  issues?: string[];
}

const TECHNIQUE_RE = /^T\d{4}(?:\.\d{3})?$/;

export const MATCHING_HELP =
  'Each condition matches any of its values, and a runbook needs every condition it lists. A rule match is the most specific, then a technique, then the other conditions; the fallback comes last. Ties go to the higher priority, then the most conditions matched, then the newest published. Before the investigation a case has no verdict, status, tags or techniques yet: a runbook that names its rules still guides the investigator, and the rest is checked again when the case needs a person. Tags carried over from an earlier version of a runbook are conditions too: the case must carry the tag.';

function hasCriterion(value: AppliesWhen, criterion: MatchCriterion): boolean {
  const v = value[criterion];
  if (Array.isArray(v)) return v.length > 0;
  if (criterion === 'always') return value.always;
  return v !== null && v !== undefined;
}

interface ChipProps {
  label: string;
  children: React.ReactNode;
  removeLabel?: string;
  onRemove?: () => void;
  onOpen?: () => void;
}

function CriterionChip({ label, children, removeLabel, onRemove, onOpen }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-card py-0.5 pl-2 text-sm',
        onRemove ? 'pr-0.5' : 'pr-2',
      )}
      data-criterion-chip={label}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex min-w-0 items-baseline gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]">{children}</span>
        </button>
      ) : (
        <>
          <span className="text-muted-foreground">{label}</span>
          <span className="min-w-0 font-medium text-foreground [overflow-wrap:anywhere]">{children}</span>
        </>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/** A text value with suggestions: type and press Enter, or pick a suggestion. */
function ValueAdder({
  label,
  placeholder,
  suggestions,
  taken,
  validate,
  onAdd,
  mono,
}: {
  label: string;
  placeholder: string;
  suggestions: string[];
  taken: string[];
  validate: (value: string) => string | null;
  onAdd: (value: string) => void;
  mono?: boolean;
}) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  const listId = `${id}-suggestions`;
  const query = text.trim().toLowerCase();
  const shown = suggestions
    .filter((s) => !taken.includes(s) && (!query || s.toLowerCase().includes(query)))
    .slice(0, 8);
  const add = (raw: string) => {
    const value = raw.trim();
    const problem = validate(value);
    if (problem) {
      setError(problem);
      return;
    }
    onAdd(value);
    setText('');
    setError(null);
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={text}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          aria-controls={shown.length ? listId : undefined}
          className={cn('h-9', mono && 'font-mono text-xs')}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            }
          }}
        />
        <Button type="button" size="sm" className="h-9" onClick={() => add(text)}>
          Add
        </Button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-critical-text">
          {error}
        </p>
      ) : null}
      {shown.length ? (
        <ul id={listId} aria-label="Suggestions" className="max-h-48 space-y-0.5 overflow-y-auto">
          {shown.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => add(s)}
                className="w-full rounded-sm px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CheckList<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T[];
  onChange: (next: T[]) => void;
}) {
  const id = React.useId();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">{legend}</legend>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map((o) => {
          const checked = value.includes(o.value);
          return (
            <label key={o.value} htmlFor={`${id}-${o.value}`} className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                id={`${id}-${o.value}`}
                checked={checked}
                onCheckedChange={(next) =>
                  onChange(next === true ? [...value, o.value] : value.filter((v) => v !== o.value))
                }
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function CriterionPicker({
  criterion,
  value,
  onChange,
  suggestions,
}: {
  criterion: MatchCriterion;
  value: AppliesWhen;
  onChange: (next: AppliesWhen) => void;
  suggestions: CriteriaSuggestions;
}) {
  const set = (patch: Partial<AppliesWhen>) => onChange({ ...value, ...patch });
  switch (criterion) {
    case 'rule_ids':
      return (
        <ValueAdder
          label="Add a rule"
          placeholder="Exact rule value, for example ssh_auth_failed"
          suggestions={suggestions.rules}
          taken={value.rule_ids}
          mono
          validate={(v) =>
            !v
              ? 'Type a rule value.'
              : v.length > RUNBOOK_LIMITS.ruleChars
                ? `A rule value has at most ${RUNBOOK_LIMITS.ruleChars} characters.`
                : value.rule_ids.includes(v)
                  ? 'This rule is already listed.'
                  : value.rule_ids.length >= RUNBOOK_LIMITS.rules
                    ? `A runbook lists at most ${RUNBOOK_LIMITS.rules} rules.`
                    : null
          }
          onAdd={(v) => set({ rule_ids: [...value.rule_ids, v] })}
        />
      );
    case 'mitre':
      return (
        <ValueAdder
          label="Add an ATT&CK technique"
          placeholder="T1110 or T1110.003"
          suggestions={suggestions.techniques}
          taken={value.mitre}
          mono
          validate={(raw) => {
            const v = raw.toUpperCase();
            if (!TECHNIQUE_RE.test(v)) return 'Use a technique id such as T1110 or T1110.003.';
            if (value.mitre.includes(v)) return 'This technique is already listed.';
            if (value.mitre.length >= RUNBOOK_LIMITS.mitre) return `A runbook lists at most ${RUNBOOK_LIMITS.mitre} techniques.`;
            return null;
          }}
          onAdd={(v) => set({ mitre: [...value.mitre, v.toUpperCase()] })}
        />
      );
    case 'entity_types':
      return (
        <CheckList<RunbookEntityType>
          legend="The case has an entity of one of these types"
          options={ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_TYPE_LABEL[t] }))}
          value={value.entity_types}
          onChange={(next) => set({ entity_types: ENTITY_TYPES.filter((t) => next.includes(t)) })}
        />
      );
    case 'verdicts':
      return (
        <CheckList<RunbookVerdict>
          legend="The verdict is one of"
          options={VERDICTS.map((v) => ({ value: v, label: VERDICT_WORD[v] }))}
          value={value.verdicts}
          onChange={(next) => set({ verdicts: VERDICTS.filter((v) => next.includes(v)) })}
        />
      );
    case 'statuses':
      return (
        <CheckList<string>
          legend="The case status is one of"
          options={CASE_STATUSES.map((s) => ({ value: s, label: CASE_STATUS_WORD[s] ?? s }))}
          value={value.statuses}
          onChange={(next) => set({ statuses: CASE_STATUSES.filter((s) => next.includes(s)).slice(0, RUNBOOK_LIMITS.statuses) })}
        />
      );
    case 'severity_at_least': {
      const id = 'severity-at-least';
      return (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">Severity at least</legend>
          <RadioGroup
            value={value.severity_at_least ?? ''}
            onValueChange={(v) => set({ severity_at_least: (v || null) as SeverityLevel | null })}
            className="grid gap-1.5"
          >
            {SEVERITY_LEVELS.map((level) => (
              <label key={level} htmlFor={`${id}-${level}`} className="flex items-center gap-2 text-sm">
                <RadioGroupItem id={`${id}-${level}`} value={level} />
                {SEVERITY_WORD[level]} or higher
              </label>
            ))}
          </RadioGroup>
        </fieldset>
      );
    }
    case 'sources':
      return (
        <ValueAdder
          label="Add a source"
          placeholder="A source id, or type:wazuh for every source of a type"
          suggestions={suggestions.sources.map((s) => s.value)}
          taken={value.sources}
          mono
          validate={(v) =>
            !v
              ? 'Type a source id.'
              : value.sources.includes(v)
                ? 'This source is already listed.'
                : value.sources.length >= RUNBOOK_LIMITS.sources
                  ? `A runbook lists at most ${RUNBOOK_LIMITS.sources} sources.`
                  : null
          }
          onAdd={(v) => set({ sources: [...value.sources, v] })}
        />
      );
    case 'any_tags':
      return (
        <ValueAdder
          label="Add a tag"
          placeholder="A case tag, for example vip"
          suggestions={[]}
          taken={value.any_tags}
          validate={(v) =>
            !v
              ? 'Type a tag.'
              : v.length > RUNBOOK_LIMITS.tagChars
                ? `A tag has at most ${RUNBOOK_LIMITS.tagChars} characters.`
                : value.any_tags.includes(v)
                  ? 'This tag is already listed.'
                  : value.any_tags.length >= RUNBOOK_LIMITS.tags
                    ? `A runbook lists at most ${RUNBOOK_LIMITS.tags} tags.`
                    : null
          }
          onAdd={(v) => set({ any_tags: [...value.any_tags, v] })}
        />
      );
    case 'min_event_count':
      return (
        <NumberField
          label="At least this many events"
          value={value.min_event_count ?? 1}
          min={1}
          max={1_000_000}
          step={1}
          defaultValue={1}
          unit="events"
          onChange={(v) => set({ min_event_count: v })}
        />
      );
    case 'always':
      return (
        <div className="flex items-start justify-between gap-3">
          <span className="space-y-1">
            <span className="block text-sm font-medium text-foreground">Fallback for any case</span>
            <span className="block text-sm text-muted-foreground">
              Applies when no other runbook matches. A fallback lists no other condition.
            </span>
          </span>
          <Switch
            checked={value.always}
            aria-label="Fallback for any case"
            onCheckedChange={(on) => set({ always: on })}
          />
        </div>
      );
    default:
      return null;
  }
}

export function AppliesWhenEditor({ value, onChange, readOnly, suggestions, issues = [] }: AppliesWhenEditorProps) {
  const [open, setOpen] = React.useState<MatchCriterion | null>(null);
  const addRef = React.useRef<HTMLButtonElement>(null);
  const editable = !readOnly && !!onChange;
  const change = (next: AppliesWhen) => onChange?.(next);
  const chips: React.ReactNode[] = [];
  const openPicker = editable ? (criterion: MatchCriterion) => () => setOpen(criterion) : () => undefined;

  value.rule_ids.forEach((rule) =>
    chips.push(
      <CriterionChip
        key={`r:${rule}`}
        label="Rule"
        removeLabel={`Remove rule ${rule}`}
        onRemove={editable ? () => change({ ...value, rule_ids: value.rule_ids.filter((r) => r !== rule) }) : undefined}
      >
        <span className="font-mono text-xs">{rule}</span>
      </CriterionChip>,
    ),
  );
  value.mitre.forEach((t) =>
    chips.push(
      <CriterionChip
        key={`m:${t}`}
        label="Technique"
        removeLabel={`Remove technique ${t}`}
        onRemove={editable ? () => change({ ...value, mitre: value.mitre.filter((x) => x !== t) }) : undefined}
      >
        <span className="font-mono text-xs">{t}</span>
      </CriterionChip>,
    ),
  );
  if (value.entity_types.length) {
    chips.push(
      <CriterionChip
        key="entity"
        label="Entity"
        removeLabel="Remove the entity condition"
        onOpen={editable ? openPicker('entity_types') : undefined}
        onRemove={editable ? () => change({ ...value, entity_types: [] }) : undefined}
      >
        {value.entity_types.map((t) => ENTITY_TYPE_LABEL[t]).join(', ')}
      </CriterionChip>,
    );
  }
  if (value.severity_at_least) {
    chips.push(
      <CriterionChip
        key="severity"
        label="Severity"
        removeLabel="Remove the severity condition"
        onOpen={editable ? openPicker('severity_at_least') : undefined}
        onRemove={editable ? () => change({ ...value, severity_at_least: null }) : undefined}
      >
        {SEVERITY_WORD[value.severity_at_least]} or higher
      </CriterionChip>,
    );
  }
  value.sources.forEach((s) =>
    chips.push(
      <CriterionChip
        key={`s:${s}`}
        label="Source"
        removeLabel={`Remove source ${s}`}
        onRemove={editable ? () => change({ ...value, sources: value.sources.filter((x) => x !== s) }) : undefined}
      >
        <span className="font-mono text-xs">{s}</span>
      </CriterionChip>,
    ),
  );
  if (value.verdicts.length) {
    chips.push(
      <CriterionChip
        key="verdicts"
        label="Verdict"
        removeLabel="Remove the verdict condition"
        onOpen={editable ? openPicker('verdicts') : undefined}
        onRemove={editable ? () => change({ ...value, verdicts: [] }) : undefined}
      >
        {value.verdicts.map((v) => VERDICT_WORD[v]).join(', ')}
      </CriterionChip>,
    );
  }
  if (value.statuses.length) {
    chips.push(
      <CriterionChip
        key="statuses"
        label="Status"
        removeLabel="Remove the status condition"
        onOpen={editable ? openPicker('statuses') : undefined}
        onRemove={editable ? () => change({ ...value, statuses: [] }) : undefined}
      >
        {value.statuses.map((s) => CASE_STATUS_WORD[s] ?? s).join(', ')}
      </CriterionChip>,
    );
  }
  value.any_tags.forEach((tag) =>
    chips.push(
      <CriterionChip
        key={`t:${tag}`}
        label="Tag"
        removeLabel={`Remove tag ${tag}`}
        onRemove={editable ? () => change({ ...value, any_tags: value.any_tags.filter((x) => x !== tag) }) : undefined}
      >
        {tag}
      </CriterionChip>,
    ),
  );
  if (value.min_event_count != null) {
    chips.push(
      <CriterionChip
        key="events"
        label="Events"
        removeLabel="Remove the event count condition"
        onOpen={editable ? openPicker('min_event_count') : undefined}
        onRemove={editable ? () => change({ ...value, min_event_count: null }) : undefined}
      >
        {value.min_event_count.toLocaleString()} or more
      </CriterionChip>,
    );
  }
  if (value.always) {
    chips.push(
      <CriterionChip
        key="always"
        label="Fallback"
        removeLabel="Remove the fallback condition"
        onRemove={editable ? () => change({ ...value, always: false }) : undefined}
      >
        any case
      </CriterionChip>,
    );
  }

  const addable = CRITERIA_ORDER.filter(
    (c) =>
      c === 'rule_ids' || c === 'mitre' || c === 'sources' || c === 'any_tags' || !hasCriterion(value, c),
  );

  return (
    <section aria-labelledby="applies-when-title" className="space-y-1.5" data-applies-when="" data-rb-field="rb-header-applies_when">
      <div className="flex flex-wrap items-center gap-1.5">
        <h2 id="applies-when-title" className="mr-1 text-sm font-medium text-foreground">
          Applies when
        </h2>
        {chips.length ? chips : <span className="text-sm text-muted-foreground">No condition yet.</span>}
        {editable ? (
          <Popover open={open !== null} onOpenChange={(next) => (next ? undefined : setOpen(null))}>
            <DropdownMenu>
              <PopoverAnchor asChild>
                <DropdownMenuTrigger asChild>
                  <Button ref={addRef} type="button" variant="ghost" size="sm" className="h-8">
                    <Plus aria-hidden />
                    Add condition
                  </Button>
                </DropdownMenuTrigger>
              </PopoverAnchor>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Condition</DropdownMenuLabel>
                {addable.map((c) => (
                  <DropdownMenuItem key={c} onSelect={() => setOpen(c)}>
                    {c === 'always' ? 'Fallback for any case' : c === 'min_event_count' ? 'Minimum events' : CRITERION_LABEL[c]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <PopoverContent
              align="start"
              className="w-80 space-y-3"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                addRef.current?.focus();
              }}
            >
              {open ? (
                <CriterionPicker criterion={open} value={value} onChange={change} suggestions={suggestions} />
              ) : null}
              <div className="flex justify-end">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(null)}>
                  Done
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        Each condition matches any of its values; a runbook needs every condition it lists. The most specific runbook wins.
        <HelpTip text={MATCHING_HELP} label="How matching works" alwaysPopover />
      </p>
      {issues.length ? (
        <ul className="space-y-0.5" aria-label="Problems with Applies when">
          {issues.map((message, index) => (
            <li key={index} className="text-sm text-critical-text">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
