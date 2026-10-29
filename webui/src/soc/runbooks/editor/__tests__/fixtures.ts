/**
 * Test fixtures for the runbook library and editor: a small operator runbook (three steps
 * over two phases) in the response shapes of `types-runbooks.ts`.
 */
import type {
  RunbookDefinition,
  RunbookDetail,
  RunbookSummary,
  RunbookVersionDoc,
  RunbookVersionState,
} from '@/lib/types-runbooks';

import { addStep, blankDefinition, updateStep } from '../draft';

export function makeDefinition(over: Partial<RunbookDefinition> = {}): RunbookDefinition {
  let d = blankDefinition();
  d = { ...d, id: 'my-runbook', title: 'Password spray response', summary: 'Many failed sign-ins.' };
  d = updateStep(d, 'first-check', { title: 'Is the source a sanctioned scanner?', focus: 'source.ip and the asset list' });
  const look = addStep(d, 'triage', 'lookup');
  d = updateStep(look.defn, look.id, { title: 'Sign-in attempts from the source address' });
  const decide = addStep(d, 'investigate', 'decision');
  d = updateStep(decide.defn, decide.id, { title: 'Is this a confirmed compromise?' });
  d = { ...d, applies_when: { ...d.applies_when, rule_ids: ['ssh_auth_failed'] } };
  return { ...d, ...over };
}

export function makeVersion(
  version: number,
  state: RunbookVersionState,
  definition: RunbookDefinition = makeDefinition(),
  over: Partial<RunbookVersionDoc> = {},
): RunbookVersionDoc {
  return {
    version,
    state,
    definition,
    source: '',
    content_hash: `hash-v${version}`,
    author: 'asha',
    created_at: '2026-10-20T10:00:00Z',
    submitted_by: null,
    submitted_at: null,
    published_by: state === 'published' || state === 'superseded' ? 'priya' : null,
    published_at: state === 'published' || state === 'superseded' ? '2026-10-21T10:00:00Z' : null,
    superseded_at: null,
    retired_by: null,
    retired_at: null,
    review_notes: [],
    import_notes: [],
    prompt_chars: 1_234,
    ...over,
  };
}

export function makeSummary(over: Partial<RunbookSummary> = {}): RunbookSummary {
  return {
    id: 'my-runbook',
    title: 'Password spray response',
    summary: 'Many failed sign-ins.',
    origin: 'operator',
    state: 'draft',
    live_version: 1,
    draft_version: 2,
    in_review_version: null,
    retired: false,
    replaces: null,
    replaced_by: null,
    derived_from: null,
    owner: 'Detection engineering',
    phases: ['triage', 'investigate'],
    step_count: 3,
    applies_to: { rule_ids: ['ssh_auth_failed'], mitre: [], more: 0 },
    runs_30d: 4,
    review_due_at: '2026-11-02T00:00:00Z',
    last_reviewed_at: null,
    last_reviewed_by: null,
    updated_at: '2026-10-28T10:00:00Z',
    updated_by: 'asha',
    migrated_from: null,
    ...over,
  };
}

/** An operator runbook with a live v1 and a draft v2. */
export function makeDetail(over: Partial<RunbookDetail> = {}): RunbookDetail {
  const live = makeVersion(1, 'published', makeDefinition({ title: 'Password spray response' }));
  const draft = makeVersion(2, 'draft', makeDefinition({ title: 'Password spray response' }));
  return {
    summary: makeSummary(),
    live,
    draft,
    in_review: null,
    versions: [
      { version: 2, state: 'draft', published_by: null, published_at: null },
      { version: 1, state: 'published', published_by: 'priya', published_at: '2026-10-21T10:00:00Z' },
    ],
    open_runs_by_version: { '1': 3 },
    revision: 7,
    ...over,
  };
}

/** A built-in: read only, live v1, no draft. */
export function makeBuiltinDetail(): RunbookDetail {
  const defn = makeDefinition({
    id: 'brute-force-password-spray',
    title: 'Brute force and password spray',
    references: ['https://attack.mitre.org/techniques/T1110/', 'javascript:alert(1)'],
  });
  return {
    summary: makeSummary({
      id: 'brute-force-password-spray',
      title: 'Brute force and password spray',
      origin: 'builtin',
      state: 'published',
      draft_version: null,
      review_due_at: null,
      owner: null,
    }),
    live: makeVersion(1, 'published', defn, { author: 'Agentic SOC', published_by: 'Agentic SOC' }),
    draft: null,
    in_review: null,
    versions: [{ version: 1, state: 'published', published_by: 'Agentic SOC', published_at: '2026-10-01T00:00:00Z' }],
    open_runs_by_version: {},
    revision: 3,
  };
}
