/**
 * A step-level comparison of two runbook versions (Round 14, SPEC §4.10.12 History): which
 * runbook fields changed, which steps were added, removed, moved or edited, and for an
 * edited step which of its fields. Steps are matched by their stable id, so a renamed step
 * reads as edited, never as removed and added. Pure; the History sheet renders it.
 */
import type { AppliesWhen, RunbookDefinition, RunbookStep } from '@/lib/types-runbooks';

import { CRITERION_LABEL, PHASE_LABEL } from '../shared/labels';

export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export type StepChangeKind = 'added' | 'removed' | 'edited' | 'moved';

export interface StepChange {
  id: string;
  title: string;
  kind: StepChangeKind;
  /** Edited fields, in words ("Title", "Focus", "Lookup"). */
  fields: string[];
  /** For a move: where it was and where it is ("Triage, step 2" to "Investigate, step 4"). */
  from?: string;
  to?: string;
}

export interface DefinitionDiff {
  header: FieldChange[];
  steps: StepChange[];
  /** True when nothing differs. */
  same: boolean;
}

const HEADER_FIELDS: ReadonlyArray<[keyof RunbookDefinition, string]> = [
  ['title', 'Title'],
  ['summary', 'Summary'],
  ['use_when', 'Use when'],
  ['prerequisites', 'Prerequisites'],
  ['priority', 'Priority'],
  ['owner', 'Owner'],
  ['review_every_days', 'Review every'],
  ['mitre', 'Covers techniques'],
  ['retrieval_queries', 'Search phrases'],
  ['references', 'References'],
];

const STEP_FIELDS: ReadonlyArray<[keyof RunbookStep, string]> = [
  ['kind', 'Kind'],
  ['title', 'Title'],
  ['instructions', 'Instructions'],
  ['focus', 'Focus'],
  ['escalate_if', 'Escalate if'],
  ['benign_if', 'Benign if'],
  ['required', 'Required'],
  ['evidence', 'Evidence'],
  ['owner_role', 'Who does it'],
  ['approval_role', 'Approved by'],
  ['target_minutes', 'Target time'],
  ['lookup', 'Lookup'],
  ['options', 'Options'],
  ['react', 'RE&CT id'],
  ['d3fend', 'D3FEND id'],
];

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join(', ') : 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function appliesWhenChanges(a: AppliesWhen, b: AppliesWhen): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of Object.keys(CRITERION_LABEL) as Array<keyof AppliesWhen>) {
    if (!same(a[key], b[key])) {
      out.push({
        field: `applies_when.${key}`,
        label: `Applies when: ${CRITERION_LABEL[key].toLowerCase()}`,
        before: text(a[key]),
        after: text(b[key]),
      });
    }
  }
  return out;
}

function place(defn: RunbookDefinition, id: string): string {
  const step = defn.steps.find((s) => s.id === id);
  if (!step) return '';
  const inPhase = defn.steps.filter((s) => s.phase === step.phase);
  return `${PHASE_LABEL[step.phase]}, step ${inPhase.indexOf(step) + 1}`;
}

/**
 * The ids, among those both versions share, that keep their order: the longest run of
 * steps whose relative order did not change. Every other shared step moved, so inserting
 * one step never reports the steps after it as moved.
 */
function stableOrder(before: RunbookDefinition, after: RunbookDefinition): Set<string> {
  const beforeIndex = new Map(before.steps.map((s, i) => [s.id, i]));
  const shared = after.steps.filter((s) => beforeIndex.has(s.id)).map((s) => s.id);
  const seq = shared.map((id) => beforeIndex.get(id) as number);
  // Longest increasing subsequence, O(n log n), keeping predecessors to rebuild it.
  const tails: number[] = [];
  const tailAt: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  seq.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = value;
    tailAt[lo] = i;
    prev[i] = lo > 0 ? tailAt[lo - 1] : -1;
  });
  const keep = new Set<string>();
  let at = tails.length ? tailAt[tails.length - 1] : -1;
  while (at >= 0) {
    keep.add(shared[at]);
    at = prev[at];
  }
  return keep;
}

/** What changed from `before` to `after`. */
export function diffDefinitions(before: RunbookDefinition, after: RunbookDefinition): DefinitionDiff {
  const header: FieldChange[] = [];
  for (const [key, label] of HEADER_FIELDS) {
    if (!same(before[key], after[key])) {
      header.push({ field: String(key), label, before: text(before[key]), after: text(after[key]) });
    }
  }
  header.push(...appliesWhenChanges(before.applies_when, after.applies_when));

  const steps: StepChange[] = [];
  const beforeIds = new Set(before.steps.map((s) => s.id));
  const afterIds = new Set(after.steps.map((s) => s.id));
  const stable = stableOrder(before, after);
  for (const step of after.steps) {
    if (!beforeIds.has(step.id)) {
      steps.push({ id: step.id, title: step.title, kind: 'added', fields: [] });
      continue;
    }
    const old = before.steps.find((s) => s.id === step.id) as RunbookStep;
    const fields = STEP_FIELDS.filter(([key]) => !same(old[key], step[key])).map(([, label]) => label);
    const from = place(before, step.id);
    const to = place(after, step.id);
    if (fields.length) steps.push({ id: step.id, title: step.title, kind: 'edited', fields });
    if (old.phase !== step.phase || !stable.has(step.id)) {
      steps.push({ id: step.id, title: step.title, kind: 'moved', fields: [], from, to });
    }
  }
  for (const step of before.steps) {
    if (!afterIds.has(step.id)) steps.push({ id: step.id, title: step.title, kind: 'removed', fields: [] });
  }
  return { header, steps, same: header.length === 0 && steps.length === 0 };
}

/** One line for a step change: "Added: Did any attempt succeed?". */
export function stepChangeLine(change: StepChange): string {
  const name = change.title || change.id;
  switch (change.kind) {
    case 'added':
      return `Added: ${name}`;
    case 'removed':
      return `Removed: ${name}`;
    case 'moved':
      return `Moved: ${name}, from ${change.from} to ${change.to}`;
    default:
      return `Edited: ${name} (${change.fields.join(', ').toLowerCase()})`;
  }
}
