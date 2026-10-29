/**
 * The run model (Round 14, SPEC §4.10.7 and §4.10.11): progress, the Next step, the open
 * required steps a close dialog lists, and the words the run view uses.
 */
import { describe, expect, it } from 'vitest';

import { parseProgress, parseRunbookFrame } from '../live';
import {
  actorName,
  advanceSentence,
  attachedLine,
  caseProgress,
  holdsApprovalRole,
  needsNoteBeforeDone,
  nextStep,
  openRequiredSteps,
  openStepWords,
  openStepsFromRefusal,
  phaseCounts,
  phaseTabName,
  primaryRun,
  roleKey,
  runProgress,
  runWorkable,
  statusLine,
  utcTime,
} from '../model';
import { rationaleRunbook } from '../provenance';
import { NOW, STEPS, completedRun, makeData, makeRun, state } from './fixtures';

describe('run model', () => {
  it('derives progress like the server: Not applicable is never done; waiting and blocked count apart', () => {
    const run = makeRun({}, {
      reset: { status: 'in_progress', action_record: { performed_by: 'asha', performed_at: '2026-10-28T14:31:00Z', where: 'IdP', outcome: 'Reset' }, approval: { required_role: 'incident_lead', status: 'pending', by: null, at: null, reason: null } },
      notes: { status: 'not_applicable', reason: 'Skipped' },
      confirmed: { status: 'blocked', reason: 'Waiting on the owner' },
    });
    expect(runProgress(run)).toEqual({ done: 2, not_applicable: 1, total: 6, required_open: 3, blocked: 1, waiting: 1 });
  });

  it('picks the first open required step as next, never one waiting for approval', () => {
    const run = makeRun();
    expect(nextStep(run)?.step.id).toBe('success');
    expect(nextStep(run)?.number).toBe(3);
    const waiting = makeRun({}, {
      success: { status: 'done' },
      confirmed: { status: 'done' },
      reset: { status: 'in_progress', approval: { required_role: 'incident_lead', status: 'pending', by: null, at: null, reason: null } },
    });
    // The only required step left waits for someone else's approval: nothing is next (the
    // card says the rest wait for approval and lists the optional record step).
    expect(nextStep(waiting)).toBeNull();
    // A completed run has no required step left, so nothing is next, but it stays workable.
    const done = completedRun();
    expect(nextStep(done)).toBeNull();
    expect(runWorkable(done)).toBe(true);
    // A blocked required step is still the one to act on.
    expect(nextStep(makeRun({}, { success: { status: 'blocked', reason: 'Waiting', ai_draft: null } }))?.step.id).toBe('success');
    // An abandoned run is read only: nothing is next, whatever its steps say.
    expect(runWorkable(makeRun({ status: 'abandoned' }))).toBe(false);
    expect(nextStep(makeRun({ status: 'abandoned' }))).toBeNull();
  });

  it('tells whether the viewer holds an approval role the way the server compares it', () => {
    expect(roleKey('Incident lead')).toBe('incident_lead');
    expect(roleKey('incident-lead')).toBe('incident_lead');
    expect(holdsApprovalRole(null, null)).toBe(true);
    // Unknown viewer, or custom roles not read yet: unknown, so nothing is blocked.
    expect(holdsApprovalRole('incident_lead', null)).toBeNull();
    expect(holdsApprovalRole('incident_lead', { unrestricted: false, role: 'analyst_tier1', custom: null })).toBeNull();
    expect(holdsApprovalRole('incident_lead', { unrestricted: false, role: 'analyst_tier1', custom: [] })).toBe(false);
    expect(holdsApprovalRole('incident_lead', { unrestricted: false, role: 'analyst_tier1', custom: ['Incident Lead'] })).toBe(true);
    expect(holdsApprovalRole('soc_manager', { unrestricted: false, role: 'soc_manager', custom: null })).toBe(true);
    expect(holdsApprovalRole('soc_manager', { unrestricted: false, role: 'super_admin', custom: [] })).toBe(true);
    expect(holdsApprovalRole('soc_manager', { unrestricted: true, role: null, custom: null })).toBe(true);
  });

  it('sums the case progress over every run not abandoned and opens on the active run', () => {
    const active = makeRun();
    const old = makeRun({ run_id: 'run-0', status: 'abandoned', attached_at: '2026-10-27T10:00:00Z' });
    const data = makeData([old, active]);
    expect(primaryRun(data)?.run_id).toBe('run-1');
    expect(caseProgress(data)?.total).toBe(6);
    expect(caseProgress(makeData([]))).toBeNull();
  });

  it('counts phases for the tabs and the rail, with the waiting fact in the tab name', () => {
    const run = makeRun({}, {
      reset: { status: 'in_progress', approval: { required_role: 'incident_lead', status: 'pending', by: null, at: null, reason: null } },
    });
    const counts = phaseCounts(run);
    expect(counts.map((c) => [c.phase, c.done, c.total])).toEqual([
      ['triage', 2, 2],
      ['investigate', 0, 2],
      ['contain', 0, 2],
    ]);
    expect(phaseTabName(counts[2])).toBe('Contain, 0 of 2 done, 1 waiting');
  });

  it('lists the open required steps with their run, number and status words', () => {
    const steps = openRequiredSteps(makeData());
    expect(steps.map((s) => [s.step_id, s.number])).toEqual([
      ['success', 3],
      ['confirmed', 4],
      ['reset', 5],
    ]);
    expect(steps[0].runLabel).toBe('Brute force and password spray, version 4');
    expect(openStepWords(steps[1])).toBe('Decision waiting');
    // A refusal names steps the loaded runs may not know: kept, numbered when known.
    const refused = openStepsFromRefusal(
      [
        { run_id: 'run-1', step_id: 'reset', title: 'Reset the affected accounts', status: 'in_progress' },
        { run_id: 'run-9', step_id: 'x', title: 'Unknown step', status: 'todo' },
      ],
      makeData(),
    );
    expect(refused.map((s) => [s.number, s.runLabel])).toEqual([
      [5, 'Brute force and password spray, version 4'],
      [null, ''],
    ]);
    expect(openRequiredSteps(makeData([completedRun()]))).toEqual([]);
  });

  it('words people, times and how a run attached', () => {
    expect(actorName('agentic_soc')).toBe('Agentic SOC');
    expect(actorName('threshold_automation')).toBe('an automation rule');
    expect(actorName('asha', (u) => (u === 'asha' ? 'Asha Rao' : u))).toBe('Asha Rao');
    expect(utcTime('2026-10-28T14:31:00Z', NOW)).toBe('14:31 UTC');
    expect(utcTime('2026-10-20T14:31:00Z', NOW)).toMatch(/^Oct 20, 14:31 UTC$/);
    expect(attachedLine(makeRun(), undefined, NOW)).toBe('Matched automatically · 12:52 UTC');
    expect(attachedLine(makeRun({ attached_by: 'fallback' }), undefined, NOW)).toBe('Fallback · 12:52 UTC');
    expect(attachedLine(makeRun({ attached_by: 'person', attached_actor: 'asha' }), () => 'Asha Rao', NOW)).toBe(
      'Added by Asha Rao · 12:52 UTC',
    );
    expect(attachedLine(makeRun({ attached_by: 'suggestion', attached_actor: 'asha' }), () => 'Asha Rao', NOW)).toBe(
      'Suggested by the AI, accepted by Asha Rao · 12:52 UTC',
    );
  });

  it('writes the quiet status line under each step', () => {
    const run = makeRun();
    expect(statusLine(STEPS[0], run.steps.scope, undefined, NOW)).toBe('Collected automatically at 12:53 UTC');
    expect(statusLine(STEPS[1], run.steps.owner, () => 'Asha Rao', NOW)).toBe('Done by Asha Rao at 14:26 UTC');
    expect(statusLine(STEPS[3], state(), undefined, NOW)).toBe('Waiting for your decision');
    expect(statusLine(STEPS[5], state({ status: 'not_applicable', reason: "Skipped by the decision 'Benign'" }), undefined, NOW)).toBe(
      "Not applicable · Skipped by the decision 'Benign'",
    );
    expect(
      statusLine(
        STEPS[4],
        state({
          status: 'in_progress',
          action_record: { performed_by: 'asha', performed_at: '2026-10-28T14:31:00Z', where: 'IdP', outcome: 'Reset' },
          approval: { required_role: 'incident_lead', status: 'pending', by: null, at: null, reason: null },
        }),
        () => 'Asha Rao',
        NOW,
      ),
    ).toBe('Recorded by Asha Rao at 14:31 UTC · waiting for approval');
  });

  it('asks for a note before Done only when the step needs one', () => {
    expect(needsNoteBeforeDone(STEPS[2], state())).toBe(true);
    expect(needsNoteBeforeDone(STEPS[2], state({ note: 'Two succeeded.' }))).toBe(false);
    expect(needsNoteBeforeDone(STEPS[1], state())).toBe(false);
  });

  it('says what happened and what is next in one sentence', () => {
    const run = makeRun({}, { success: { status: 'done' } });
    expect(advanceSentence({ number: 3, verb: 'done' }, nextStep(run), false)).toBe(
      'Step 3 done. Next, step 4: Is this a confirmed compromise?',
    );
    expect(advanceSentence({ number: 6, verb: 'done' }, null, true)).toBe('Step 6 done. All required steps are done.');
  });

  it('parses a case.runbook frame and refuses malformed ones', () => {
    const frame = parseRunbookFrame({
      case_id: 'case-1',
      run_id: 'run-1',
      progress: { done: 3, not_applicable: 0, total: 6, required_open: 2, blocked: 0, waiting: 0 },
      revision: 8,
    });
    expect(frame).toMatchObject({ case_id: 'case-1', run_id: 'run-1', revision: 8 });
    expect(parseRunbookFrame({ run_id: 'run-1' })).toBeNull();
    expect(parseProgress({ done: 'x' })).toBeNull();
  });

  it('reads the runbook guidance from the rationale, keeping selected and consulted apart', () => {
    expect(rationaleRunbook(null)).toBeNull();
    expect(rationaleRunbook({ case_id: 'c' } as never)).toBeNull();
    const consulted = rationaleRunbook({
      case_id: 'c',
      runbook: { id: 'brute-force', version: 4, title: 'Brute force', reason: 'Matched', consulted: true, selected_id: 'brute-force' },
    } as never);
    expect(consulted).toMatchObject({ id: 'brute-force', version: 4, consulted: true });
    const selected = rationaleRunbook({
      case_id: 'c',
      runbook: { id: '', consulted: false, selected_id: 'brute-force' },
    } as never);
    expect(selected).toMatchObject({ id: '', selectedId: 'brute-force', consulted: false });
  });
});
