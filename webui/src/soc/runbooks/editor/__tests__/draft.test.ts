/**
 * The editor's pure model (Round 14, SPEC §4.10.12, F17): adding, moving and removing steps,
 * placing the server's issues on their steps, holding issues back on a new runbook, the
 * step-level version comparison and the field ids the issues summary focuses.
 */
import { describe, expect, it } from 'vitest';

import type { RunbookDefinition } from '@/lib/types-runbooks';

import {
  addPhase,
  addStep,
  blankDefinition,
  changeKind,
  currentIssues,
  fieldKey,
  mergeIssues,
  moveStep,
  moveStepBefore,
  placeIssues,
  removeStep,
  runbookIdFromTitle,
  sameDefinition,
  setOptions,
  switchStepKind,
  updateStep,
  visibleIssues,
} from '../draft';
import { diffDefinitions, stepChangeLine } from '../diff';
import { fieldCandidates, fieldDomId, focusField } from '../fieldIds';

function threeSteps(): RunbookDefinition {
  let d = blankDefinition();
  d = { ...d, title: 'Brute force' };
  d = addStep(d, 'triage', 'lookup').defn;
  d = addStep(d, 'investigate', 'decision').defn;
  return d;
}

describe('editing the outline', () => {
  it('starts a new runbook with one Triage check', () => {
    const d = blankDefinition();
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0]).toMatchObject({ id: 'first-check', phase: 'triage', kind: 'check' });
    expect(d.phases).toEqual(['triage']);
  });

  it('adds steps with unique ids and keeps phases in the fixed order', () => {
    const d = threeSteps();
    expect(d.steps.map((s) => s.phase)).toEqual(['triage', 'triage', 'investigate']);
    expect(new Set(d.steps.map((s) => s.id)).size).toBe(3);
    const withClose = addPhase(d, 'close').defn;
    expect(withClose.phases).toEqual(['triage', 'investigate', 'close']);
  });

  it('gives a decision two options and a lookup its default query', () => {
    const d = threeSteps();
    expect(d.steps[1].lookup?.tool).toBeTruthy();
    expect(d.steps[2].options).toHaveLength(2);
    const asCheck = changeKind(d, d.steps[2].id, 'check');
    expect(asCheck.steps[2].options).toEqual([]);
  });

  it('moves a step one place, crossing into the next phase at an edge', () => {
    const d = threeSteps();
    const lookupId = d.steps[1].id;
    const down = moveStep(d, lookupId, 1);
    const moved = down.steps.find((s) => s.id === lookupId);
    expect(moved?.phase).toBe('investigate');
    expect(moveStep(d, d.steps[0].id, -1)).toBe(d);
  });

  it('drops a step before another, taking that step’s phase', () => {
    const d = threeSteps();
    const first = d.steps[0].id;
    const next = moveStepBefore(d, first, null, 'investigate');
    expect(next.steps[next.steps.length - 1].id).toBe(first);
    expect(next.phases).toEqual(['triage', 'investigate']);
  });

  it('removing a step clears decision options that skipped it and drops an empty phase', () => {
    let d = threeSteps();
    d = addStep(d, 'contain', 'action').defn;
    const decision = d.steps.find((s) => s.kind === 'decision')!;
    const action = d.steps.find((s) => s.kind === 'action')!;
    d = setOptions(d, decision.id, decision.options.map((o, i) => (i === 0 ? { ...o, marks_not_applicable: [action.id] } : o)));
    const next = removeStep(d, action.id);
    expect(next.phases).not.toContain('contain');
    expect(next.steps.find((s) => s.id === decision.id)?.options[0].marks_not_applicable).toEqual([]);
  });

  it('derives a new runbook id from its title, away from taken and reserved ids', () => {
    expect(runbookIdFromTitle('Brute force & password spray', [])).toBe('brute-force-password-spray');
    expect(runbookIdFromTitle('Brute force', ['brute-force'])).toBe('brute-force-2');
    expect(runbookIdFromTitle('New', [])).not.toBe('new');
  });

  it('compares definitions by content', () => {
    const d = threeSteps();
    expect(sameDefinition(d, JSON.parse(JSON.stringify(d)))).toBe(true);
    expect(sameDefinition(d, { ...d, title: 'Other' })).toBe(false);
  });
});

describe('issues (F17)', () => {
  const issues = [
    { path: 'title', code: 'required', message: 'Give the runbook a title.' },
    { path: 'steps[1].lookup.filter.source.ip', code: 'invalid', message: 'Use a case value or an IP address.' },
  ];

  it('places a step issue on the step id it named when validated, even after a reorder', () => {
    const d = threeSteps();
    const placed = placeIssues(issues, d);
    expect(placed[0]).toMatchObject({ stepId: null, field: 'title' });
    expect(placed[1]).toMatchObject({ stepId: d.steps[1].id, field: 'lookup.filter.source.ip' });
  });

  it('holds a new runbook’s issues back until the field is left or a save is tried', () => {
    const placed = placeIssues(issues, threeSteps());
    expect(visibleIssues(placed, { gated: true, attempted: false, touched: new Set() })).toEqual([]);
    const titleOnly = visibleIssues(placed, { gated: true, attempted: false, touched: new Set([fieldKey(null, 'title')]) });
    expect(titleOnly.map((i) => i.field)).toEqual(['title']);
    expect(visibleIssues(placed, { gated: true, attempted: true, touched: new Set() })).toHaveLength(2);
    expect(visibleIssues(placed, { gated: false, attempted: false, touched: new Set() })).toHaveLength(2);
  });
});

describe('the version comparison', () => {
  it('reports added, removed, edited and moved steps by their stable ids', () => {
    const before = threeSteps();
    let after = { ...before, title: 'Brute force and spray' };
    after = { ...after, steps: after.steps.map((s, i) => (i === 0 ? { ...s, title: 'Is the source sanctioned?' } : s)) };
    after = addStep(after, 'close', 'record').defn;
    after = removeStep(after, before.steps[2].id);
    const diff = diffDefinitions(before, after);
    expect(diff.same).toBe(false);
    expect(diff.header.map((c) => c.label)).toContain('Title');
    const kinds = diff.steps.map((c) => c.kind).sort();
    expect(kinds).toEqual(['added', 'edited', 'removed']);
    expect(stepChangeLine(diff.steps.find((c) => c.kind === 'edited')!)).toBe('Edited: Is the source sanctioned? (title)');
  });

  it('does not call the steps after an inserted one moved', () => {
    const before = threeSteps();
    const after = addStep(before, 'triage', 'check').defn;
    const moved = diffDefinitions(before, after).steps.filter((c) => c.kind === 'moved');
    expect(moved).toEqual([]);
  });

  it('finds the same runbook the same', () => {
    const d = threeSteps();
    expect(diffDefinitions(d, d).same).toBe(true);
  });
});

describe('field ids for the issues summary', () => {
  it('builds DOM-safe ids and tries the most specific first', () => {
    expect(fieldDomId('lookup-1', 'lookup.window')).toBe('rb-step-lookup-1-lookup-window');
    expect(fieldDomId(null, 'title')).toBe('rb-header-title');
    expect(fieldCandidates('s1', 'lookup.filter.source.ip')).toEqual([
      'rb-step-s1-lookup-filter-source-ip',
      'rb-step-s1-lookup-filter-source',
      'rb-step-s1-lookup-filter',
      'rb-step-s1-lookup',
    ]);
  });

  it('focuses the control itself or the first control inside a tagged wrapper', () => {
    document.body.innerHTML = `
      <input id="rb-header-title" />
      <div data-rb-field="rb-step-s1-lookup"><button type="button">Tool</button></div>`;
    expect(focusField(null, 'title')).toBe(true);
    expect(document.activeElement?.id).toBe('rb-header-title');
    expect(focusField('s1', 'lookup.limit')).toBe(true);
    expect(document.activeElement?.textContent).toBe('Tool');
    expect(focusField('s9', 'title')).toBe(false);
    document.body.innerHTML = '';
  });
});

describe('switching a step kind keeps what the author wrote', () => {
  it('sets kind-specific fields aside and brings them back on a switch back', () => {
    let d = blankDefinition();
    d = updateStep(d, 'first-check', { escalate_if: 'Many users from one client.', benign_if: 'A known rollout.' });
    let aside = undefined as Parameters<typeof switchStepKind>[3];
    let r = switchStepKind(d, 'first-check', 'lookup', aside);
    expect(r.defn.steps[0]).toMatchObject({ kind: 'lookup', escalate_if: null, benign_if: null });
    expect(r.defn.steps[0].lookup).not.toBeNull();
    aside = r.aside;
    r = switchStepKind(r.defn, 'first-check', 'check', aside);
    expect(r.defn.steps[0]).toMatchObject({ kind: 'check', escalate_if: 'Many users from one client.', benign_if: 'A known rollout.', lookup: null });
  });

  it('keeps decision options and the lookup across a round trip through other kinds', () => {
    let d = blankDefinition();
    d = changeKind(d, 'first-check', 'decision');
    d = setOptions(d, 'first-check', [
      { id: 'yes', label: 'Confirmed compromise', marks_not_applicable: [] },
      { id: 'no', label: 'Benign', marks_not_applicable: [] },
      { id: 'unsure', label: 'Not sure yet', marks_not_applicable: [] },
    ]);
    let r = switchStepKind(d, 'first-check', 'action', undefined);
    expect(r.defn.steps[0].options).toEqual([]);
    r = switchStepKind(r.defn, 'first-check', 'record', r.aside);
    r = switchStepKind(r.defn, 'first-check', 'decision', r.aside);
    expect(r.defn.steps[0].options.map((o) => o.label)).toEqual(['Confirmed compromise', 'Benign', 'Not sure yet']);
  });

  it('keeps an approval role from Action through Check and back', () => {
    let d = blankDefinition();
    d = changeKind(d, 'first-check', 'action');
    d = updateStep(d, 'first-check', { approval_role: 'soc_lead' });
    let r = switchStepKind(d, 'first-check', 'check', undefined);
    expect(r.defn.steps[0].approval_role).toBeNull();
    r = switchStepKind(r.defn, 'first-check', 'record', r.aside);
    expect(r.defn.steps[0].approval_role).toBe('soc_lead');
  });

  // A field the author cleared stays cleared: the value set aside on an earlier switch never
  // comes back in its place (review finding on the F17 fix).
  it('keeps a cleared Escalate if cleared, through a kind that carries it and one that does not', () => {
    let d = blankDefinition();
    d = updateStep(d, 'first-check', { escalate_if: 'E1' });
    let r = switchStepKind(d, 'first-check', 'lookup', undefined);
    r = switchStepKind(r.defn, 'first-check', 'check', r.aside);
    expect(r.defn.steps[0].escalate_if).toBe('E1');
    const cleared = updateStep(r.defn, 'first-check', { escalate_if: null });
    const toDecision = switchStepKind(cleared, 'first-check', 'decision', r.aside);
    expect(toDecision.defn.steps[0].escalate_if).toBeNull();
    let round = switchStepKind(cleared, 'first-check', 'lookup', r.aside);
    round = switchStepKind(round.defn, 'first-check', 'check', round.aside);
    expect(round.defn.steps[0].escalate_if).toBeNull();
  });

  it('keeps a cleared Benign if cleared', () => {
    let d = blankDefinition();
    d = updateStep(d, 'first-check', { benign_if: 'B1' });
    let r = switchStepKind(d, 'first-check', 'action', undefined);
    r = switchStepKind(r.defn, 'first-check', 'check', r.aside);
    expect(r.defn.steps[0].benign_if).toBe('B1');
    const cleared = updateStep(r.defn, 'first-check', { benign_if: null });
    const toDecision = switchStepKind(cleared, 'first-check', 'decision', r.aside);
    expect(toDecision.defn.steps[0].benign_if).toBeNull();
    let round = switchStepKind(cleared, 'first-check', 'record', r.aside);
    round = switchStepKind(round.defn, 'first-check', 'decision', round.aside);
    expect(round.defn.steps[0].benign_if).toBeNull();
  });

  it('keeps a cleared approval role cleared', () => {
    let d = blankDefinition();
    d = changeKind(d, 'first-check', 'action');
    d = updateStep(d, 'first-check', { approval_role: 'soc_lead' });
    let r = switchStepKind(d, 'first-check', 'check', undefined);
    r = switchStepKind(r.defn, 'first-check', 'action', r.aside);
    expect(r.defn.steps[0].approval_role).toBe('soc_lead');
    const cleared = updateStep(r.defn, 'first-check', { approval_role: null });
    const toRecord = switchStepKind(cleared, 'first-check', 'record', r.aside);
    expect(toRecord.defn.steps[0].approval_role).toBeNull();
    let round = switchStepKind(cleared, 'first-check', 'check', r.aside);
    round = switchStepKind(round.defn, 'first-check', 'action', round.aside);
    expect(round.defn.steps[0].approval_role).toBeNull();
  });

  it('brings back the options and the lookup as they last stood, not as first set aside', () => {
    let d = blankDefinition();
    d = changeKind(d, 'first-check', 'decision');
    d = setOptions(d, 'first-check', [
      { id: 'yes', label: 'One', marks_not_applicable: [] },
      { id: 'no', label: 'Two', marks_not_applicable: [] },
      { id: 'maybe', label: 'Three', marks_not_applicable: [] },
    ]);
    let r = switchStepKind(d, 'first-check', 'check', undefined);
    r = switchStepKind(r.defn, 'first-check', 'decision', r.aside);
    const trimmed = setOptions(r.defn, 'first-check', r.defn.steps[0].options.slice(0, 2));
    r = switchStepKind(trimmed, 'first-check', 'check', r.aside);
    r = switchStepKind(r.defn, 'first-check', 'decision', r.aside);
    expect(r.defn.steps[0].options.map((o) => o.label)).toEqual(['One', 'Two']);

    r = switchStepKind(r.defn, 'first-check', 'lookup', r.aside);
    const lookup = r.defn.steps[0].lookup;
    expect(lookup).not.toBeNull();
    r = switchStepKind(r.defn, 'first-check', 'check', r.aside);
    r = switchStepKind(r.defn, 'first-check', 'lookup', r.aside);
    const edited = updateStep(r.defn, 'first-check', { lookup: { ...lookup!, limit: 5 } });
    r = switchStepKind(edited, 'first-check', 'check', r.aside);
    r = switchStepKind(r.defn, 'first-check', 'lookup', r.aside);
    expect(r.defn.steps[0].lookup?.limit).toBe(5);
  });

  it('sets aside a value the current kind does not carry only when it holds something', () => {
    let d = blankDefinition();
    // An Action step the Markdown gave an Escalate if line: it is kept for a switch to Check.
    d = changeKind(d, 'first-check', 'action');
    d = updateStep(d, 'first-check', { escalate_if: 'From the source' });
    const r = switchStepKind(d, 'first-check', 'check', { escalate_if: 'Older' });
    expect(r.defn.steps[0].escalate_if).toBe('From the source');
    // Without one, the value set aside earlier stands.
    const plain = changeKind(blankDefinition(), 'first-check', 'action');
    const back = switchStepKind(plain, 'first-check', 'check', { escalate_if: 'Older' });
    expect(back.defn.steps[0].escalate_if).toBe('Older');
  });
});

describe('which problems still hold', () => {
  it('drops a problem whose field changed since it was validated, and keeps the others', () => {
    const validated = threeSteps();
    const issues = placeIssues(
      [
        { path: 'summary', code: 'required', message: 'Give the runbook a summary.' },
        { path: 'steps[1].title', code: 'required', message: 'The title of step 2 is required.' },
        { path: 'title', code: 'too_long', message: 'Shorten the title.' },
      ],
      validated,
    );
    const working = updateStep({ ...validated, summary: 'Now filled in' }, validated.steps[1].id, { focus: 'unrelated field' });
    const left = currentIssues(issues, validated, working);
    expect(left.map((i) => i.path)).toEqual(['steps[1].title', 'title']);
    const titled = updateStep(working, validated.steps[1].id, { title: 'Now named' });
    expect(currentIssues(issues, validated, titled).map((i) => i.path)).toEqual(['title']);
    // A step that is gone takes its problems with it.
    expect(currentIssues(issues, validated, removeStep(working, validated.steps[1].id)).map((i) => i.path)).toEqual(['title']);
  });

  it('merges two lists, each problem once', () => {
    const a = [{ path: 'id', code: 'required', message: 'Give the runbook an id.' }];
    const b = [...a, { path: 'title', code: 'required', message: 'Give the runbook a title.' }];
    expect(mergeIssues(a, b)).toEqual(b);
  });
});
