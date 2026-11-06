/**
 * The editor's working copy of a runbook (Round 14, SPEC §4.10.2, §4.10.12): pure edits on
 * a `RunbookDefinition` (add, remove, move and re-kind steps, add phases, edit options),
 * new ids, and the rules for which validation issues are shown (F17: a brand-new runbook
 * starts with no issues shown; an issue appears once its field was left or a save was
 * tried).
 *
 * Every function returns a new definition and never mutates its input, so React state
 * and the undo of a failed save stay simple. Steps are kept grouped by phase in the
 * phase order, which is the order the server exports them in. Pure, no React.
 */
import type {
  DecisionOption,
  LookupTemplate,
  PhaseId,
  RunbookDefinition,
  RunbookIssue,
  RunbookStep,
  StepKind,
} from '@/lib/types-runbooks';

import { PHASE_ORDER, RUNBOOK_LIMITS, isValidRunbookId } from '../shared/labels';
import { blankStep, defaultLookup, emptyAppliesWhen } from './markdown';

/** A lower-case slug of `text` (a-z, 0-9, -), at most `max` characters; `fallback` when empty. */
export function slugify(text: string, max = 64, fallback = 'step'): string {
  const ascii = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** `slugify(text)` made unique against `taken` with `-2`, `-3` (fitted to `max`). */
export function uniqueSlug(text: string, taken: Iterable<string>, max = 64, fallback = 'step'): string {
  const used = new Set(taken);
  const base = slugify(text, max, fallback);
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
    n += 1;
  }
  return candidate;
}

/** A runbook id from a title, valid and not reserved, unique against `taken`. */
export function runbookIdFromTitle(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let id = uniqueSlug(title, used, 64, 'runbook');
  while (!isValidRunbookId(id)) id = uniqueSlug(`${id}-runbook`, used, 64, 'runbook');
  return id;
}

/** The starting point of "New runbook": one Triage phase holding one empty Check step. */
export function blankDefinition(reviewEveryDays: number = RUNBOOK_LIMITS.reviewDefault): RunbookDefinition {
  return {
    id: '',
    title: '',
    summary: '',
    use_when: '',
    prerequisites: '',
    applies_when: emptyAppliesWhen(),
    priority: 50,
    mitre: [],
    phases: ['triage'],
    steps: [blankStep('first-check', 'triage', 'check')],
    retrieval_queries: [],
    owner: null,
    review_every_days: reviewEveryDays,
    references: [],
  };
}

const phaseRank = (phase: PhaseId) => PHASE_ORDER.indexOf(phase);

/** Steps grouped by phase in phase order, keeping their order inside a phase. */
function regroup(steps: RunbookStep[]): RunbookStep[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => phaseRank(a.step.phase) - phaseRank(b.step.phase) || a.index - b.index)
    .map((entry) => entry.step);
}

/** The phases the steps use, in phase order (each phase holds at least one step). */
function phasesOf(steps: RunbookStep[]): PhaseId[] {
  return PHASE_ORDER.filter((phase) => steps.some((s) => s.phase === phase));
}

/** Steps of one phase, in order. */
export function stepsInPhase(defn: RunbookDefinition, phase: PhaseId): RunbookStep[] {
  return defn.steps.filter((s) => s.phase === phase);
}

/** 1-based number of a step in the whole runbook ("Step 2"). */
export function stepNumber(defn: RunbookDefinition, stepId: string): number {
  return defn.steps.findIndex((s) => s.id === stepId) + 1;
}

function withSteps(defn: RunbookDefinition, steps: RunbookStep[]): RunbookDefinition {
  const grouped = regroup(steps);
  return { ...defn, steps: grouped, phases: phasesOf(grouped) };
}

/** Add a step of `kind` at the end of `phase` (the phase is added when new). */
export function addStep(defn: RunbookDefinition, phase: PhaseId, kind: StepKind): { defn: RunbookDefinition; id: string } {
  const id = uniqueSlug(`${kind}`, defn.steps.map((s) => s.id));
  const step = kindDefaults(blankStep(id, phase, kind), kind);
  return { defn: withSteps(defn, [...defn.steps, step]), id };
}

/** Add a phase with one Check step (a phase must hold at least one step). */
export function addPhase(defn: RunbookDefinition, phase: PhaseId): { defn: RunbookDefinition; id: string } {
  return addStep(defn, phase, 'check');
}

/** Remove a step; decision options stop skipping it; a phase left empty goes. */
export function removeStep(defn: RunbookDefinition, stepId: string): RunbookDefinition {
  const steps = defn.steps
    .filter((s) => s.id !== stepId)
    .map((s) =>
      s.options.some((o) => o.marks_not_applicable.includes(stepId))
        ? {
            ...s,
            options: s.options.map((o) => ({
              ...o,
              marks_not_applicable: o.marks_not_applicable.filter((id) => id !== stepId),
            })),
          }
        : s,
    );
  return withSteps(defn, steps);
}

/** Patch one step. */
export function updateStep(defn: RunbookDefinition, stepId: string, patch: Partial<RunbookStep>): RunbookDefinition {
  const steps = defn.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
  return patch.phase ? withSteps(defn, steps) : { ...defn, steps };
}

/** The fields a step of `kind` carries (a lookup for Lookup, options for Decision). */
function kindDefaults(step: RunbookStep, kind: StepKind): RunbookStep {
  const next: RunbookStep = { ...step, kind };
  next.lookup = kind === 'lookup' ? step.lookup ?? defaultLookup() : null;
  next.options =
    kind === 'decision'
      ? step.options.length
        ? step.options
        : [
            { id: 'yes', label: '', marks_not_applicable: [] },
            { id: 'no', label: '', marks_not_applicable: [] },
          ]
      : [];
  if (kind !== 'check' && kind !== 'decision') {
    next.escalate_if = null;
    next.benign_if = null;
  }
  if (kind !== 'action' && kind !== 'record') next.approval_role = null;
  return next;
}

/** Change a step's kind, keeping what still applies. */
export function changeKind(defn: RunbookDefinition, stepId: string, kind: StepKind): RunbookDefinition {
  return { ...defn, steps: defn.steps.map((s) => (s.id === stepId ? kindDefaults(s, kind) : s)) };
}

/**
 * The kind-specific fields a step sets aside when its kind changes: its lookup, its
 * Escalate if and Benign if lines, its decision options and its approval role. A kind that
 * cannot carry one of them drops it from the step (so it is never saved or validated), and
 * switching back puts it back, so trying another kind never loses what the author wrote.
 */
export type KindFields = Partial<Pick<RunbookStep, 'lookup' | 'escalate_if' | 'benign_if' | 'options' | 'approval_role'>>;

/** Which kind-specific fields each kind of step carries (and its form shows). */
function carriedBy(kind: StepKind): { lookup: boolean; guidance: boolean; options: boolean; approval: boolean } {
  return {
    lookup: kind === 'lookup',
    guidance: kind === 'check' || kind === 'decision',
    options: kind === 'decision',
    approval: kind === 'action' || kind === 'record',
  };
}

/**
 * Change a step's kind through `aside`, the fields set aside for that step so far. Returns
 * the new definition and the fields now set aside (the caller keeps them per step id).
 *
 * A field the step's current kind carries is set aside as it stands, an empty value
 * included: a field the author cleared stays cleared, and an older value set aside before
 * never comes back in its place. A field the current kind does not carry (one the Markdown
 * gave it) is set aside only when it holds something.
 */
export function switchStepKind(
  defn: RunbookDefinition,
  stepId: string,
  kind: StepKind,
  aside: KindFields | undefined,
): { defn: RunbookDefinition; aside: KindFields } {
  const step = defn.steps.find((s) => s.id === stepId);
  if (!step || step.kind === kind) return { defn, aside: { ...aside } };
  const kept: KindFields = { ...aside };
  const carries = carriedBy(step.kind);
  if (carries.lookup || step.lookup) kept.lookup = step.lookup ?? null;
  if (carries.guidance || step.escalate_if) kept.escalate_if = step.escalate_if || null;
  if (carries.guidance || step.benign_if) kept.benign_if = step.benign_if || null;
  if (carries.options || step.options.length) kept.options = step.options;
  if (carries.approval || step.approval_role) kept.approval_role = step.approval_role || null;
  const changed = kindDefaults({ ...step, ...(kind === 'decision' && kept.options?.length ? { options: kept.options } : {}) }, kind);
  const restored: RunbookStep = { ...changed };
  if (kind === 'lookup' && kept.lookup) restored.lookup = kept.lookup;
  if (kind === 'check' || kind === 'decision') {
    restored.escalate_if = restored.escalate_if ?? kept.escalate_if ?? null;
    restored.benign_if = restored.benign_if ?? kept.benign_if ?? null;
  }
  if (kind === 'action' || kind === 'record') restored.approval_role = restored.approval_role ?? kept.approval_role ?? null;
  return { defn: { ...defn, steps: defn.steps.map((s) => (s.id === stepId ? restored : s)) }, aside: kept };
}

/** Rename a step id everywhere it is referenced (decision options). */
export function renameStepId(defn: RunbookDefinition, from: string, to: string): RunbookDefinition {
  if (from === to) return defn;
  return {
    ...defn,
    steps: defn.steps.map((s) => ({
      ...s,
      id: s.id === from ? to : s.id,
      options: s.options.map((o) => ({
        ...o,
        marks_not_applicable: o.marks_not_applicable.map((id) => (id === from ? to : id)),
      })),
    })),
  };
}

/**
 * Move a step one place up or down. At the edge of its phase it crosses into the
 * neighbouring phase that is in use (its last or first place); it never leaves the runbook.
 */
export function moveStep(defn: RunbookDefinition, stepId: string, direction: -1 | 1): RunbookDefinition {
  const index = defn.steps.findIndex((s) => s.id === stepId);
  if (index < 0) return defn;
  const step = defn.steps[index];
  const neighbour = defn.steps[index + direction];
  if (!neighbour) return defn;
  if (neighbour.phase === step.phase) {
    const steps = [...defn.steps];
    steps[index] = neighbour;
    steps[index + direction] = step;
    return { ...defn, steps };
  }
  // Cross into the neighbouring phase: it becomes that phase's last (moving up) or first (moving down) step.
  const steps = defn.steps.filter((s) => s.id !== stepId);
  const moved = { ...step, phase: neighbour.phase };
  const at = direction === -1 ? steps.findIndex((s) => s.id === neighbour.id) + 1 : steps.findIndex((s) => s.id === neighbour.id);
  steps.splice(at, 0, moved);
  return withSteps(defn, steps);
}

/** Move a step to just before `beforeId` (drag and drop), taking that step's phase. */
export function moveStepBefore(defn: RunbookDefinition, stepId: string, beforeId: string | null, phase: PhaseId): RunbookDefinition {
  if (stepId === beforeId) return defn;
  const step = defn.steps.find((s) => s.id === stepId);
  if (!step) return defn;
  const steps = defn.steps.filter((s) => s.id !== stepId);
  const moved = { ...step, phase };
  if (beforeId === null) {
    const lastInPhase = steps.map((s) => s.phase).lastIndexOf(phase);
    steps.splice(lastInPhase < 0 ? steps.length : lastInPhase + 1, 0, moved);
  } else {
    const at = steps.findIndex((s) => s.id === beforeId);
    steps.splice(at < 0 ? steps.length : at, 0, moved);
  }
  return withSteps(defn, steps);
}

/** Patch a step's lookup (Lookup steps only). */
export function updateLookup(defn: RunbookDefinition, stepId: string, patch: Partial<LookupTemplate>): RunbookDefinition {
  return {
    ...defn,
    steps: defn.steps.map((s) => (s.id === stepId && s.lookup ? { ...s, lookup: { ...s.lookup, ...patch } } : s)),
  };
}

/** Replace a decision step's options. */
export function setOptions(defn: RunbookDefinition, stepId: string, options: DecisionOption[]): RunbookDefinition {
  return { ...defn, steps: defn.steps.map((s) => (s.id === stepId ? { ...s, options } : s)) };
}

/** Steps after `stepId` that a decision option there may skip. */
export function laterSteps(defn: RunbookDefinition, stepId: string): RunbookStep[] {
  const index = defn.steps.findIndex((s) => s.id === stepId);
  return index < 0 ? [] : defn.steps.slice(index + 1);
}

// --------------------------------------------------------------------------- //
// Issues: which to show, and where they belong
// --------------------------------------------------------------------------- //

/**
 * Where an issue belongs: the step id it names (resolved through the validated
 * definition's step order, so a later reorder never moves an issue to another step), the
 * field inside the step, or a header field.
 */
export interface PlacedIssue extends RunbookIssue {
  stepId: string | null;
  /** The field path inside the step ("title", "lookup.filter.source.ip"), or the header path. */
  field: string;
}

const STEP_PATH = /^steps\[(\d+)\](?:\.(.*))?$/;

export function placeIssues(issues: readonly RunbookIssue[], validated: RunbookDefinition | null): PlacedIssue[] {
  return issues.map((issue) => {
    const m = STEP_PATH.exec(issue.path);
    if (m && validated) {
      const step = validated.steps[Number(m[1])];
      return { ...issue, stepId: step ? step.id : null, field: m[2] ?? '' };
    }
    return { ...issue, stepId: null, field: issue.path };
  });
}

/** A field key for touched tracking: `header:title`, `step:<id>:title`. */
export function fieldKey(stepId: string | null, field: string): string {
  const head = field.split(/[.[]/)[0] || field;
  return stepId ? `step:${stepId}:${head}` : `header:${head}`;
}

/**
 * The issues to show now (F17). `gated` is true for a brand-new runbook: then an issue
 * shows only after its field was left (`touched`) or a save was tried (`attempted`).
 * An existing draft shows everything at once (its problems are already stored).
 */
export function visibleIssues(
  placed: readonly PlacedIssue[],
  opts: { gated: boolean; attempted: boolean; touched: ReadonlySet<string> },
): PlacedIssue[] {
  if (!opts.gated || opts.attempted) return [...placed];
  return placed.filter((issue) => opts.touched.has(fieldKey(issue.stepId, issue.field)));
}

/** The part of a definition an issue is about, as text: the step field, or the header field. */
function issueSlice(defn: RunbookDefinition, issue: PlacedIssue): string {
  const head = issue.field.split(/[.[]/)[0] || issue.field;
  if (issue.stepId) {
    const step = defn.steps.find((s) => s.id === issue.stepId);
    if (!step) return '\u0000missing';
    return JSON.stringify(head ? (step as unknown as Record<string, unknown>)[head] ?? null : step);
  }
  if (STEP_PATH.test(issue.path) || issue.path === 'steps' || issue.path.startsWith('steps[')) return JSON.stringify(defn.steps);
  return JSON.stringify(head ? (defn as unknown as Record<string, unknown>)[head] ?? null : null);
}

/**
 * The issues that still describe `working` (F17): validation runs a moment after typing
 * stops, so an issue found on an earlier text is dropped once the field it names has changed
 * (it comes back on the next validation if it still holds). An issue on a step that is gone
 * is dropped too.
 */
export function currentIssues(
  placed: readonly PlacedIssue[],
  validated: RunbookDefinition | null,
  working: RunbookDefinition | null,
): PlacedIssue[] {
  if (!validated || !working || validated === working) return [...placed];
  return placed.filter((issue) => issueSlice(validated, issue) === issueSlice(working, issue));
}

/** Two issue lists as one, each problem once (by path, code and message), `first` first. */
export function mergeIssues(first: readonly RunbookIssue[], second: readonly RunbookIssue[]): RunbookIssue[] {
  const seen = new Set<string>();
  const out: RunbookIssue[] = [];
  for (const issue of [...first, ...second]) {
    const key = `${issue.path}\u0000${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** Steps (by id) that hold at least one of `issues`. */
export function stepsWithIssues(issues: readonly PlacedIssue[]): Set<string> {
  return new Set(issues.map((i) => i.stepId).filter((id): id is string => !!id));
}

/** True when two definitions hold the same runbook (the editor's dirty check). */
export function sameDefinition(a: RunbookDefinition | null, b: RunbookDefinition | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
