/**
 * Test fixtures for the run inside a case (Round 14, SPEC §4.10.11): one Published
 * runbook snapshot with a step of every kind across three phases, and the run state the
 * tests start from. Plain data; nothing here calls the network.
 */
import type {
  CaseRunbooks,
  LookupResult,
  RunbookDefinition,
  RunbookProgress,
  RunbookRun,
  RunbookStep,
  StepState,
} from '@/lib/types-runbooks';

export const NOW = new Date('2026-10-28T15:00:00Z');

export function step(partial: Partial<RunbookStep> & Pick<RunbookStep, 'id' | 'phase' | 'kind' | 'title'>): RunbookStep {
  return {
    instructions: '',
    focus: null,
    escalate_if: null,
    benign_if: null,
    required: true,
    evidence: 'none',
    owner_role: null,
    approval_role: null,
    target_minutes: null,
    lookup: null,
    options: [],
    react: null,
    d3fend: null,
    ...partial,
  };
}

export function state(partial: Partial<StepState> = {}): StepState {
  return {
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
    revision: 1,
    ...partial,
  };
}

export const LOOKUP_RESULT: LookupResult = {
  tool: 'log_stats',
  params: { 'source.ip': '203.0.113.7' },
  window_from: '2026-10-28T11:52:00Z',
  window_to: '2026-10-28T13:52:00Z',
  ran_at: '2026-10-28T12:53:00Z',
  ran_by: 'agentic_soc',
  status: 'ok',
  reason: null,
  count: 412,
  count_relation: 'eq',
  facts: [
    { label: 'Failed sign-ins', value: '412' },
    { label: 'Accounts targeted', value: '37' },
  ],
  table: { columns: ['user.name', 'count'], rows: [['svc-backup', '120'], ['a.rao', '44']] },
  table_kind: 'aggregate',
  window_clamped: false,
};

export const STEPS: RunbookStep[] = [
  step({
    id: 'scope',
    phase: 'triage',
    kind: 'lookup',
    title: 'How many sign-ins failed from this source?',
    lookup: {
      tool: 'log_stats',
      filter: { 'source.ip': '{{entity.ip}}' },
      group_by: ['user.name'],
      indicator: null,
      window: 'case_first_seen-1h..case_last_seen+1h',
      limit: 10,
      run: 'on_attach',
    },
  }),
  step({ id: 'owner', phase: 'triage', kind: 'check', title: 'Is the source a known scanner?' }),
  step({
    id: 'success',
    phase: 'investigate',
    kind: 'check',
    title: 'Did any sign-in succeed after the failures?',
    instructions: 'Look for a **successful** sign-in from the same source.',
    focus: 'user.name, event.outcome',
    escalate_if: 'A success follows the failures.',
    benign_if: 'Every attempt failed.',
    evidence: 'note',
  }),
  step({
    id: 'confirmed',
    phase: 'investigate',
    kind: 'decision',
    title: 'Is this a confirmed compromise?',
    options: [
      { id: 'compromise', label: 'Compromise', marks_not_applicable: [] },
      { id: 'benign', label: 'Benign', marks_not_applicable: ['reset', 'notes'] },
    ],
  }),
  step({
    id: 'reset',
    phase: 'contain',
    kind: 'action',
    title: 'Reset the affected accounts',
    approval_role: 'incident_lead',
  }),
  step({ id: 'notes', phase: 'contain', kind: 'record', title: 'Record the containment', required: false }),
];

export const DEFINITION: RunbookDefinition = {
  id: 'brute-force',
  title: 'Brute force and password spray',
  summary: 'Many failed sign-ins from one source.',
  use_when: '',
  prerequisites: '',
  applies_when: {
    rule_ids: ['auth-failures'],
    mitre: [],
    entity_types: [],
    severity_at_least: null,
    sources: [],
    verdicts: [],
    statuses: [],
    any_tags: [],
    min_event_count: null,
    always: false,
  },
  priority: 50,
  mitre: ['T1110'],
  phases: ['triage', 'investigate', 'contain'],
  steps: STEPS,
  retrieval_queries: [],
  owner: null,
  review_every_days: 180,
  references: [],
};

export function makeRun(overrides: Partial<RunbookRun> = {}, steps: Record<string, Partial<StepState>> = {}): RunbookRun {
  const base: Record<string, StepState> = {
    scope: state({
      status: 'done',
      completed_at: '2026-10-28T12:53:00Z',
      completed_by: 'agentic_soc',
      evidence: [{ kind: 'lookup_result', lookup: LOOKUP_RESULT, url: null, label: null }],
    }),
    owner: state({ status: 'done', completed_at: '2026-10-28T14:26:00Z', completed_by: 'asha' }),
    success: state({
      ai_draft: {
        text: 'Two sign-ins succeeded for svc-backup after the failures.',
        created_at: '2026-10-28T14:40:00Z',
        model: 'demo',
        usage_id: 'u-1',
        confirmed: false,
      },
    }),
    confirmed: state(),
    reset: state(),
    notes: state(),
  };
  for (const [id, patch] of Object.entries(steps)) base[id] = state({ ...base[id], ...patch });
  return {
    run_id: 'run-1',
    case_id: 'case-1',
    runbook_id: 'brute-force',
    version: 4,
    title: 'Brute force and password spray',
    snapshot: DEFINITION,
    attached_by: 'rule',
    attached_reason: { tier: 3, matched: [{ criterion: 'rule_ids', value: ['auth-failures'] }], missed: [], tie: false },
    attached_at: '2026-10-28T12:52:00Z',
    attached_actor: 'runbook_selector',
    status: 'active',
    completed_at: null,
    abandoned_reason: null,
    steps: base,
    revision: 7,
    ...overrides,
  };
}

/**
 * A run as the server leaves it once its last required step finished: `completed` in the
 * same write (`_refresh_completion`), with the optional record step still to do.
 */
export function completedRun(overrides: Partial<RunbookRun> = {}, steps: Record<string, Partial<StepState>> = {}): RunbookRun {
  return makeRun(
    { status: 'completed', completed_at: '2026-10-28T14:52:00Z', revision: 9, ...overrides },
    {
      success: { status: 'done', ai_draft: null, completed_by: 'ben', completed_at: '2026-10-28T14:45:00Z', revision: 2 },
      confirmed: {
        status: 'done',
        decision: { option_id: 'compromise', label: 'Compromise', by: 'ben', at: '2026-10-28T14:50:00Z' },
        completed_by: 'ben',
        completed_at: '2026-10-28T14:50:00Z',
        revision: 2,
      },
      reset: {
        status: 'done',
        action_record: { performed_by: 'ben', performed_at: '2026-10-28T14:51:00Z', where: 'IdP', outcome: 'Reset 3 accounts' },
        approval: { required_role: 'incident_lead', status: 'approved', by: 'asha', at: '2026-10-28T14:52:00Z', reason: null },
        completed_by: 'asha',
        completed_at: '2026-10-28T14:52:00Z',
        revision: 3,
      },
      ...steps,
    },
  );
}

export function progress(partial: Partial<RunbookProgress> = {}): RunbookProgress {
  return { done: 2, not_applicable: 0, total: 6, required_open: 3, blocked: 0, waiting: 0, ...partial };
}

export function makeData(runs: RunbookRun[] = [makeRun()], extra: Partial<CaseRunbooks> = {}): CaseRunbooks {
  return {
    runs,
    progress: {},
    newer_versions: {},
    other_tasks: [],
    revision: 3,
    ...extra,
  };
}
