/**
 * The run inside a case, read as plain data (Round 14, SPEC §4.10.7, §4.10.11).
 *
 * Pure helpers over `CaseRunbooks` and `RunbookRun`: reading order and step numbers, the
 * display status of a step ("waiting for approval" is derived, never stored), progress per
 * run and per phase, the Next step, the open required steps a close asks about, and the
 * words of the strip and the step rows. Reading order and progress mirror the server's
 * own rules (`engine/runbook_runs.py`: `ordered_steps`, `run_progress`), so the case
 * header, the Runbook tab, the Overview card, the facts rail and the close dialog always
 * agree with each other and with the queue chip the server computes.
 *
 * The Next step is one rule shared with the server's next_step (engine/runbook_runs.py),
 * which case chat reads: the first open REQUIRED step that is not waiting for approval,
 * and none when no required step is left to act on (the card then says "All required
 * steps are done." or that the rest wait for approval).
 *
 * Only an abandoned run is read only (`runWorkable`): the server marks a run completed in
 * the same write that finishes its last required step and keeps accepting step writes on
 * it (a reopened required step makes it active again), so a completed run stays workable.
 *
 * Every value that came from a run (titles, notes, reasons, names, lookup values) is
 * returned as a plain string for the caller to render as a text node (#9). Nothing here
 * decides anything about the case (#3). No React: tests import it without a DOM.
 */
import type {
  CaseRunbooks,
  LookupResult,
  MatchExplanation,
  PhaseId,
  RunbookProgress,
  RunbookRun,
  RunbookStep,
  RunbookStepsOpen,
  StepEvidence,
  StepState,
  StepStatus,
} from '@/lib/types-runbooks';
import { PHASE_LABEL, PHASE_ORDER, type StepDisplayStatus } from '@/soc/runbooks/shared/labels';

/** Statuses that finish a step (the run's required-open count leaves them out). */
export const FINISHED_STATUSES: readonly StepStatus[] = ['done', 'not_applicable'];

/** The default state of a step nobody touched yet. */
export const EMPTY_STEP_STATE: StepState = Object.freeze({
  status: 'todo',
  assignee: null,
  started_at: null,
  completed_at: null,
  completed_by: null,
  note: '',
  reason: null,
  evidence: [],
  decision: null,
  action_record: null,
  approval: null,
  ai_draft: null,
  revision: 0,
}) as StepState;

/** The stored state of `stepId` in `run`, or the untouched default. */
export function stepStateOf(run: RunbookRun, stepId: string): StepState {
  return run.steps?.[stepId] ?? EMPTY_STEP_STATE;
}

/** True when the step carries a recorded action whose approval is pending. */
export function isWaiting(state: StepState): boolean {
  return state.approval?.status === 'pending';
}

export function isFinished(state: StepState): boolean {
  return FINISHED_STATUSES.includes(state.status);
}

/** The status a person sees: the stored one, or "waiting" while an approval is pending. */
export function displayStatus(state: StepState): StepDisplayStatus {
  if (isWaiting(state)) return 'waiting';
  return state.status;
}

/** The phases a runbook uses, in its own order (any unknown phase last, as the server does). */
export function runPhases(run: RunbookRun): PhaseId[] {
  const used = new Set(run.snapshot.steps.map((s) => s.phase));
  const declared = (run.snapshot.phases ?? []).filter((p) => used.has(p));
  const rest = PHASE_ORDER.filter((p) => used.has(p) && !declared.includes(p));
  return [...declared, ...rest];
}

/** The steps in reading order: by the runbook's phase order, then as written. */
export function orderedSteps(run: RunbookRun): RunbookStep[] {
  const phases = runPhases(run);
  const rank = new Map(phases.map((p, i) => [p, i] as const));
  return run.snapshot.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => (rank.get(a.step.phase) ?? phases.length) - (rank.get(b.step.phase) ?? phases.length) || a.index - b.index)
    .map((x) => x.step);
}

/** One step with its number in reading order (1-based) and its state. */
export interface NumberedStep {
  step: RunbookStep;
  number: number;
  state: StepState;
  display: StepDisplayStatus;
}

export function numberedSteps(run: RunbookRun): NumberedStep[] {
  return orderedSteps(run).map((step, i) => {
    const state = stepStateOf(run, step.id);
    return { step, number: i + 1, state, display: displayStatus(state) };
  });
}

/** Progress derived from a run (the server's `run_progress`). */
export function runProgress(run: RunbookRun): RunbookProgress {
  const out: RunbookProgress = { done: 0, not_applicable: 0, total: 0, required_open: 0, blocked: 0, waiting: 0 };
  for (const step of run.snapshot.steps) {
    const st = stepStateOf(run, step.id);
    out.total += 1;
    if (st.status === 'done') out.done += 1;
    else if (st.status === 'not_applicable') out.not_applicable += 1;
    if (st.status === 'blocked') out.blocked += 1;
    if (isWaiting(st)) out.waiting += 1;
    if (step.required && !isFinished(st)) out.required_open += 1;
  }
  return out;
}

/** The progress of one run: the server's figure when it sent one, else derived. */
export function progressOf(data: Pick<CaseRunbooks, 'progress'> | null | undefined, run: RunbookRun): RunbookProgress {
  return data?.progress?.[run.run_id] ?? runProgress(run);
}

/** One progress for the case (every run not abandoned, summed); null when it has none. */
export function caseProgress(data: CaseRunbooks | null | undefined): RunbookProgress | null {
  if (!data) return null;
  let total: RunbookProgress | null = null;
  for (const run of data.runs) {
    if (run.status === 'abandoned') continue;
    const p = progressOf(data, run);
    total = total
      ? {
          done: total.done + p.done,
          not_applicable: total.not_applicable + p.not_applicable,
          total: total.total + p.total,
          required_open: total.required_open + p.required_open,
          blocked: total.blocked + p.blocked,
          waiting: total.waiting + p.waiting,
        }
      : { ...p };
  }
  return total;
}

/**
 * The run the tab opens on: the first active run, else the newest finished one. Abandoned
 * runs are shown only when nothing else is on the case.
 */
export function primaryRun(data: CaseRunbooks | null | undefined): RunbookRun | null {
  const runs = data?.runs ?? [];
  if (!runs.length) return null;
  const active = runs.find((r) => r.status === 'active');
  if (active) return active;
  const byNewest = [...runs].sort((a, b) => Date.parse(b.attached_at || '') - Date.parse(a.attached_at || ''));
  return byNewest.find((r) => r.status === 'completed') ?? byNewest[0] ?? null;
}

/**
 * True while a run's steps can still change: every run that is not abandoned. A completed
 * run stays workable (its optional steps, Reopen step), as the server allows.
 */
export function runWorkable(run: Pick<RunbookRun, 'status'>): boolean {
  return run.status !== 'abandoned';
}

/**
 * The step the Next step card shows: the first REQUIRED step (reading order) that is not
 * Done or Not applicable and not waiting on someone else's approval. A step waiting for
 * approval belongs to the approver, so it is never "next"; and when no required step is
 * left to act on there is no Next step (the card lists what is left instead).
 */
export function nextStep(run: RunbookRun): NumberedStep | null {
  if (!runWorkable(run)) return null;
  return numberedSteps(run).find((s) => s.step.required && !isFinished(s.state) && s.display !== 'waiting') ?? null;
}

/** Steps still open (not Done, not Not applicable), in reading order. */
export function openSteps(run: RunbookRun): NumberedStep[] {
  return numberedSteps(run).filter((s) => !isFinished(s.state));
}

/** Per-phase counts for the phase tabs and the facts rail. */
export interface PhaseCount {
  phase: PhaseId;
  total: number;
  done: number;
  na: number;
  waiting: number;
  blocked: number;
  /** Not Done and not Not applicable (waiting and blocked included). */
  open: number;
}

export function phaseCounts(run: RunbookRun): PhaseCount[] {
  const map = new Map<PhaseId, PhaseCount>();
  for (const phase of runPhases(run)) {
    map.set(phase, { phase, total: 0, done: 0, na: 0, waiting: 0, blocked: 0, open: 0 });
  }
  for (const { step, state, display } of numberedSteps(run)) {
    const c = map.get(step.phase);
    if (!c) continue;
    c.total += 1;
    if (state.status === 'done') c.done += 1;
    else if (state.status === 'not_applicable') c.na += 1;
    else c.open += 1;
    if (display === 'waiting') c.waiting += 1;
    if (state.status === 'blocked') c.blocked += 1;
  }
  return [...map.values()];
}

function n(value: number): string {
  return Math.max(0, Math.trunc(value || 0)).toLocaleString();
}

/** "Complete", "2 not applicable", "1 waiting · 1 open" for one phase. */
export function phaseWords(c: PhaseCount): string {
  if (c.open === 0) {
    if (c.na === 0) return 'Complete';
    return c.done === 0 ? `${n(c.na)} not applicable` : `Finished · ${n(c.na)} not applicable`;
  }
  const parts: string[] = [];
  if (c.waiting) parts.push(`${n(c.waiting)} waiting`);
  if (c.blocked) parts.push(`${n(c.blocked)} blocked`);
  const plain = c.open - c.waiting - c.blocked;
  if (plain > 0) parts.push(`${n(plain)} open`);
  return parts.join(' · ');
}

/** The phase tab's accessible name: "Contain, 0 of 2 done, 1 waiting". */
export function phaseTabName(c: PhaseCount): string {
  const parts = [`${PHASE_LABEL[c.phase]}, ${n(c.done)} of ${n(c.total)} done`];
  if (c.na) parts.push(`${n(c.na)} not applicable`);
  if (c.waiting) parts.push(`${n(c.waiting)} waiting`);
  if (c.blocked) parts.push(`${n(c.blocked)} blocked`);
  return parts.join(', ');
}

/** An open required step a close dialog lists, with what the dialog shows for it. */
export interface OpenRequiredStep extends RunbookStepsOpen {
  /** The step number in its run's reading order, when the run is loaded. */
  number: number | null;
  /** The status as the dialog words it ("In progress", "Decision waiting"). */
  display: StepDisplayStatus;
  kind: RunbookStep['kind'] | null;
  /** "Brute force and password spray, version 4". */
  runLabel: string;
}

/** Every required step still open on an active run of the case. */
export function openRequiredSteps(data: CaseRunbooks | null | undefined): OpenRequiredStep[] {
  const out: OpenRequiredStep[] = [];
  for (const run of data?.runs ?? []) {
    if (run.status !== 'active') continue;
    for (const s of numberedSteps(run)) {
      if (!s.step.required || isFinished(s.state)) continue;
      out.push({
        run_id: run.run_id,
        step_id: s.step.id,
        title: s.step.title,
        status: s.state.status,
        number: s.number,
        display: s.display,
        kind: s.step.kind,
        runLabel: runLabel(run),
      });
    }
  }
  return out;
}

/** The steps a `409 runbook_steps_open` named, completed from the loaded runs where possible. */
export function openStepsFromRefusal(
  steps: readonly RunbookStepsOpen[],
  data: CaseRunbooks | null | undefined,
): OpenRequiredStep[] {
  return steps.map((item) => {
    const run = data?.runs.find((r) => r.run_id === item.run_id) ?? null;
    const numbered = run ? numberedSteps(run).find((s) => s.step.id === item.step_id) ?? null : null;
    return {
      ...item,
      number: numbered?.number ?? null,
      display: numbered ? numbered.display : item.status,
      kind: numbered?.step.kind ?? null,
      runLabel: run ? runLabel(run) : '',
    };
  });
}

/** "Brute force and password spray, version 4". */
export function runLabel(run: Pick<RunbookRun, 'title' | 'version'>): string {
  return `${run.title}, version ${n(run.version)}`;
}

// --------------------------------------------------------------------------- //
// People and times
// --------------------------------------------------------------------------- //
/** Accounts that are the suite itself, shown as "Agentic SOC". */
const SYSTEM_ACTORS = new Set(['agentic_soc', 'runbook_selector', 'system', 'pipeline']);

/** How a run names a person: a display name when the caller knows one, else the user name. */
export type NameOf = (username: string) => string;

export const plainName: NameOf = (username) => username;

/** A stored actor as words: "Agentic SOC", "an automation rule", or the person's name. */
export function actorName(actor: string | null | undefined, nameOf: NameOf = plainName): string {
  const value = (actor ?? '').trim();
  if (!value) return 'someone';
  if (SYSTEM_ACTORS.has(value)) return 'Agentic SOC';
  if (value === 'threshold_automation') return 'an automation rule';
  return nameOf(value) || value;
}

/** A role name compared the server's way: no case, spaces or hyphens ("Incident lead" is `incident_lead`). */
export function roleKey(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

/** What the Console knows about the viewer's roles, for the approval hint. */
export interface ViewerRoles {
  /** Sign-in or role checks are off: every approval role is held. */
  unrestricted: boolean;
  /** The viewer's base role. */
  role: string | null;
  /** The viewer's assigned custom roles, or null while they are not known. */
  custom: readonly string[] | null;
}

/**
 * Whether the viewer holds a step's approval role, the server's rule
 * (`routes_case_runbooks.holds_approval_role`): any role when none is named, unrestricted
 * access, the super admin, the base role or an assigned custom role. Null when it cannot be
 * told yet (the custom roles are not known), so the Console never blocks someone the
 * server would allow; the server stays the authority.
 */
export function holdsApprovalRole(required: string | null | undefined, viewer: ViewerRoles | null | undefined): boolean | null {
  if (!required || !required.trim()) return true;
  if (!viewer) return null;
  if (viewer.unrestricted) return true;
  const wanted = roleKey(required);
  const base = roleKey(viewer.role);
  if (base === 'super_admin' || base === wanted) return true;
  if (viewer.custom === null) return null;
  return viewer.custom.some((r) => roleKey(r) === wanted);
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A run time in UTC, said so: "14:31 UTC" today, "Oct 28, 14:31 UTC" on another day,
 * "Oct 28, 2025, 14:31 UTC" in another year. The stored text when it is not a date.
 */
export function utcTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return iso ?? '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const clock = `${hh}:${mm} UTC`;
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  if (sameDay) return clock;
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (d.getUTCFullYear() === now.getUTCFullYear()) return `${day}, ${clock}`;
  return `${day}, ${d.getUTCFullYear()}, ${clock}`;
}

/** "12:52 to 14:18 UTC" (or with days when the window spans them). */
export function utcRange(from: string | null | undefined, to: string | null | undefined, now: Date = new Date()): string {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return [from, to].filter(Boolean).join(' to ');
  const sameDay =
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  if (sameDay) {
    const left = utcTime(from, now).replace(/ UTC$/, '');
    return `${left} to ${utcTime(to, now).replace(/^.*, /, '')}`;
  }
  return `${utcTime(from, now).replace(/ UTC$/, '')} to ${utcTime(to, now)}`;
}

// --------------------------------------------------------------------------- //
// The strip
// --------------------------------------------------------------------------- //
/** True when `reason` is a stored match explanation (not a person's `{by, note}`). */
export function isMatchExplanation(reason: unknown): reason is MatchExplanation {
  if (!reason || typeof reason !== 'object') return false;
  const r = reason as Record<string, unknown>;
  return typeof r.tier === 'number' && Array.isArray(r.matched);
}

/** The person's note when a person attached the run. */
export function attachNote(run: RunbookRun): string | null {
  const reason = run.attached_reason as Record<string, unknown> | null;
  const note = reason && typeof reason.note === 'string' ? reason.note.trim() : '';
  return note || null;
}

/**
 * How and when the run attached: "Matched automatically · 12:52 UTC", "Fallback · 12:52
 * UTC", "Added by Asha Rao · 12:52 UTC", "Suggested by the AI, accepted by Asha Rao ·
 * 12:52 UTC", "Attached by an automation rule · 12:52 UTC".
 */
export function attachedLine(run: RunbookRun, nameOf: NameOf = plainName, now: Date = new Date()): string {
  const when = utcTime(run.attached_at, now);
  const who = actorName(run.attached_actor, nameOf);
  let what: string;
  if (run.attached_actor === 'threshold_automation') what = 'Attached by an automation rule';
  else if (run.attached_by === 'fallback') what = 'Fallback';
  else if (run.attached_by === 'person') what = `Added by ${who}`;
  else if (run.attached_by === 'suggestion') what = `Suggested by the AI, accepted by ${who}`;
  else what = 'Matched automatically';
  return when ? `${what} · ${when}` : what;
}

/** The run's state in words for the strip and the run switcher. */
export function runStatusWords(run: RunbookRun, now: Date = new Date()): string {
  if (run.status === 'completed') return run.completed_at ? `Completed · ${utcTime(run.completed_at, now)}` : 'Completed';
  if (run.status === 'abandoned') return 'Abandoned';
  return 'Active';
}

// --------------------------------------------------------------------------- //
// Step rows
// --------------------------------------------------------------------------- //
/** The newest automatic or on-demand lookup result of a step, if any. */
export function lookupResultOf(state: StepState): LookupResult | null {
  const list = state.evidence ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (item?.kind === 'lookup_result' && item.lookup) return item.lookup;
  }
  return null;
}

/** The links and tickets a person attached to a step. */
export function evidenceLinks(state: StepState): StepEvidence[] {
  return (state.evidence ?? []).filter((e) => e.kind === 'link' || e.kind === 'ticket');
}

/**
 * The quiet line under a step title: "Done by Asha Rao at 14:26 UTC", "Waiting for your
 * decision", "Recorded by Asha Rao at 14:31 UTC · waiting for approval", "Not applicable ·
 * Skipped by the decision 'Benign'", "Ready to run".
 */
export function statusLine(step: RunbookStep, state: StepState, nameOf: NameOf = plainName, now: Date = new Date()): string {
  const display = displayStatus(state);
  const by = (who: string | null | undefined) => actorName(who, nameOf);
  switch (display) {
    case 'done': {
      if (state.decision) return `Decided "${state.decision.label}" · ${by(state.decision.by)} at ${utcTime(state.decision.at, now)}`;
      const lookup = lookupResultOf(state);
      if (step.kind === 'lookup' && lookup && (state.completed_by === 'agentic_soc' || !state.completed_by)) {
        return `Collected automatically at ${utcTime(lookup.ran_at, now)}`;
      }
      return state.completed_at ? `Done by ${by(state.completed_by)} at ${utcTime(state.completed_at, now)}` : 'Done';
    }
    case 'waiting': {
      const rec = state.action_record;
      return rec
        ? `Recorded by ${by(rec.performed_by)} at ${utcTime(rec.performed_at, now)} · waiting for approval`
        : 'Waiting for approval';
    }
    case 'in_progress':
      return state.assignee ? `In progress · ${by(state.assignee)}` : 'In progress';
    case 'not_applicable':
      return state.reason ? `Not applicable · ${state.reason}` : 'Not applicable';
    case 'blocked':
      return state.reason ? `Blocked · ${state.reason}` : 'Blocked';
    default: {
      if (step.kind === 'decision') return 'Waiting for your decision';
      if (step.kind === 'lookup') {
        const lookup = lookupResultOf(state);
        if (!lookup) return step.lookup?.run === 'on_demand' ? 'Ready to run' : 'Waiting for the lookup';
        return 'Lookup result attached';
      }
      return state.assignee ? `To do · ${by(state.assignee)}` : 'To do';
    }
  }
}

/** The words a step's own status is spoken with in the close dialog ("Decision waiting"). */
export function openStepWords(item: Pick<OpenRequiredStep, 'display' | 'kind' | 'status'>): string {
  if (item.display === 'waiting') return 'Waiting for approval';
  if (item.kind === 'decision' && item.status === 'todo') return 'Decision waiting';
  switch (item.status) {
    case 'in_progress':
      return 'In progress';
    case 'blocked':
      return 'Blocked';
    default:
      return 'To do';
  }
}

/** True when the step needs a note (or a link) before it can be marked Done. */
export function needsNoteBeforeDone(step: RunbookStep, state: StepState): boolean {
  if (step.evidence === 'note') return !state.note.trim();
  if (step.evidence === 'note_or_attachment') return !state.note.trim() && evidenceLinks(state).length === 0;
  return false;
}

/** The live-region sentence after a step finishes: "Step 5 done. Next, step 6: <title>." */
export function advanceSentence(
  finished: { number: number; verb: 'done' | 'not applicable' | 'recorded' },
  next: NumberedStep | null,
  requiredClear: boolean,
): string {
  const first = `Step ${finished.number} ${finished.verb}.`;
  if (next) return `${first} Next, step ${next.number}: ${next.step.title}`;
  if (requiredClear) return `${first} All required steps are done.`;
  return first;
}
