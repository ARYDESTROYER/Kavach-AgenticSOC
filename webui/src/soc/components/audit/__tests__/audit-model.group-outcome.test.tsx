/**
 * An investigation group's outcome follows how the run ended (Round 14 SPEC §4.5.1).
 *
 * The rows are the ones the pipeline writes for one investigation run (`run_id`), each with
 * the outcome `RunStampedAudit` stamps or the writer names: a tool call that returned an
 * error is a failure row, a budget refusal of the investigator's model call is a denied
 * error row, and the case manager's decision row ends the run. A run that reached its
 * decision is never read as Failed because one step failed on the way; a run that ended in
 * a pipeline error is. With the ending row not loaded, the group keeps the step precedence.
 * A group shown in part (fewer rows loaded than the run's `run_totals` count) never reads
 * Success: a step still to load can have failed. Its row then reads "Not known", never
 * "Not recorded", unless a row shown already proves the outcome.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AuditRecord } from '@/lib/types-audit';
import { TooltipProvider } from '@/ui/tooltip';

import { AuditTable } from '../AuditTable';
import {
  GROUP_OUTCOME_LABEL,
  OUTCOME_LABEL,
  buildListItems,
  groupOutcome,
  groupOutcomeKey,
  groupTitle,
  investigationEndRow,
  type GroupItem,
} from '../audit-model';

import { rec } from './audit-fixtures';

let clock = 0;

/** One step of run `inv-1` on case-214, one second after the previous one. */
function step(over: Partial<AuditRecord>): AuditRecord {
  clock += 1;
  return rec({
    record_id: `mem:${clock}`,
    ts: new Date(Date.UTC(2026, 9, 25, 15, 0, clock)).toISOString(),
    run_id: 'inv-1',
    case_id: 'case-214',
    category: 'agent',
    actor_type: 'agent',
    outcome: 'success',
    ...over,
  });
}

const router = () =>
  step({ action_type: 'decision', actor: 'router', event_label: 'Triage decision', result_summary: 'bucket=needs_strong_model confidence=0.0 reason=demo' });
const prompt = () => step({ action_type: 'prompt', actor: 'investigator', event_label: 'Prompt' });
const query = (outcome: AuditRecord['outcome'] = 'success') =>
  step({ action_type: 'es_query', actor: 'investigator', event_label: 'Log query', tool_name: 'es_query', outcome });
const tool = (outcome: AuditRecord['outcome'] = 'success') =>
  step({ action_type: 'tool_call', actor: 'investigator', event_label: 'Tool call', tool_name: 'enrich', outcome });
const verdict = (summary = 'verdict=FALSE_POSITIVE confidence=0.97', outcome: AuditRecord['outcome'] = 'success') =>
  step({ action_type: 'verdict', actor: 'investigator', event_label: 'Verdict', result_summary: summary, outcome });
const decision = (summary = 'verdict=FALSE_POSITIVE status=closed decision_by=agent', actor = 'case_manager') =>
  step({ action_type: 'decision', actor, actor_type: 'system', event_label: 'Close or escalate decision', result_summary: summary });
const error = (actor: string, summary: string, outcome: AuditRecord['outcome'] = 'failure') =>
  step({ action_type: 'error', actor, actor_type: actor === 'pipeline' ? 'system' : 'agent', event_label: 'Error', result_summary: summary, outcome });

/** The list's order: newest first. */
const newestFirst = (rows: AuditRecord[]) => [...rows].reverse();

/** The run's group row, as the Agent activity list builds it. */
function groupOf(rows: AuditRecord[], total = rows.length): GroupItem {
  const items = buildListItems(newestFirst(rows), 'agent', { 'inv-1': total }, new Set());
  expect(items).toHaveLength(1);
  return items[0] as GroupItem;
}

/**
 * The group row after the first page of a newest-first read: the run's newest `loaded`
 * rows, with the run's full step count from `run_totals`.
 */
function firstPageOf(rows: AuditRecord[], loaded: number): GroupItem {
  const items = buildListItems(newestFirst(rows).slice(0, loaded), 'agent', { 'inv-1': rows.length }, new Set());
  expect(items).toHaveLength(1);
  return items[0] as GroupItem;
}

describe('an investigation group reads how the run ended', () => {
  it('reads Success when every step succeeded and the run reached its decision', () => {
    const group = groupOf([router(), prompt(), query(), tool(), verdict(), decision()]);
    expect(groupOutcome(group.records)).toBe('success');
    expect(groupTitle(group).detail).toBe('6 steps · closed as false positive');
  });

  it('reads Partial, not Failed, when a tool call failed and the run went on to close the case', () => {
    const rows = [router(), prompt(), query('failure'), tool(), verdict(), decision()];
    const group = groupOf(rows);
    expect(investigationEndRow(group.records)?.actor).toBe('case_manager');
    expect(groupOutcome(group.records)).toBe('partial');
    expect(groupTitle(group).detail).toBe('6 steps · closed as false positive');
  });

  it('reads Partial when the AI budget refused a step and the case went to a person', () => {
    const rows = [
      router(),
      prompt(),
      error('investigator', 'investigator model error: budget exceeded; routed to a person', 'denied'),
      decision('verdict=NEEDS_HUMAN status=needs_human decision_by=system'),
    ];
    const group = groupOf(rows);
    expect(groupOutcome(group.records)).toBe('partial');
    expect(groupTitle(group).detail).toBe('4 steps · sent to a person');
  });

  it('reads Partial when the verdict was capped short of a conclusion', () => {
    const rows = [prompt(), tool(), verdict('verdict=NEEDS_HUMAN confidence=0.0', 'partial'), decision('verdict=NEEDS_HUMAN status=needs_human decision_by=system')];
    expect(groupOutcome(groupOf(rows).records)).toBe('partial');
  });

  it('reads Partial when the run timed out and the case manager still decided', () => {
    const rows = [
      prompt(),
      query(),
      error('pipeline', 'investigation timed out after 180s; capped to NEEDS_HUMAN (partial cost=0.01)'),
      decision('verdict=NEEDS_HUMAN status=needs_human decision_by=system'),
    ];
    expect(groupOutcome(groupOf(rows).records)).toBe('partial');
  });

  it('reads Success for a close by an analyst policy', () => {
    const rows = [decision('closed by analyst rule policy rules=r1 policies=p1 risk=12', 'analyst_policy')];
    expect(investigationEndRow(rows)?.actor).toBe('analyst_policy');
    expect(groupOutcome(rows)).toBe('success');
  });

  it('reads Success from the verdict when the run has no decision row loaded yet', () => {
    expect(groupOutcome([prompt(), tool(), verdict()])).toBe('success');
    expect(groupOutcome([prompt(), tool('failure'), verdict()])).toBe('partial');
  });

  it('reads Failed when the run ended in a pipeline error', () => {
    const rows = [router(), prompt(), query(), error('pipeline', 'pipeline error: store unavailable')];
    const group = groupOf(rows);
    expect(investigationEndRow(group.records)?.action_type).toBe('error');
    expect(groupOutcome(group.records)).toBe('failure');
  });

  it('reads Failed when the pipeline failed after the verdict and before a decision', () => {
    const rows = [prompt(), tool(), verdict(), error('pipeline', 'pipeline error: store unavailable')];
    expect(investigationEndRow(rows)?.action_type).toBe('error');
    expect(groupOutcome(groupOf(rows).records)).toBe('failure');
    // A verdict recorded after an investigator error is the ending (the error came first).
    const recovered = [prompt(), error('investigator', 'investigator crash: boom'), verdict()];
    expect(investigationEndRow(recovered)?.action_type).toBe('verdict');
    expect(groupOutcome(recovered)).toBe('partial');
  });

  it('reads Denied when the run ended because a limit refused it', () => {
    const rows = [prompt(), error('investigator', 'investigator model error: budget exceeded; routed to a person', 'denied')];
    expect(groupOutcome(rows)).toBe('denied');
  });

  it('reads an error row by its derived outcome', () => {
    // A row with no recorded outcome reads Failed for `error` (marked derived).
    const rows = [prompt(), error('pipeline', 'pipeline error: boom', 'failure')];
    rows[1] = { ...rows[1], outcome_derived: true };
    expect(groupOutcome(rows)).toBe('failure');
  });

  it('claims nothing when the run reached its decision but a step outcome was not recorded', () => {
    // A recorded `unknown` reads Not recorded.
    expect(groupOutcome([prompt(), tool('unknown'), decision()])).toBeUndefined();
  });

  it('never takes the triage decision or a refused tool for the ending', () => {
    // Router and investigator decision rows are steps, not the run's decision.
    const blocked = step({ action_type: 'decision', actor: 'investigator', event_label: 'Tool blocked', outcome: 'denied' });
    expect(investigationEndRow([router(), blocked])).toBeNull();
    expect(groupOutcome([router(), blocked])).toBe('denied');
  });
});

describe('a partly loaded investigation without its ending keeps the step precedence', () => {
  it.each([
    ['Failed when a step shown failed', ['success', 'failure', 'denied', 'partial'], 'failure'],
    ['Denied when a step shown was denied', ['success', 'denied', 'partial'], 'denied'],
    ['Partial when a step shown partly happened', ['success', 'partial'], 'partial'],
    ['nothing when every step shown succeeded, as a step still to load can have failed', ['success', 'success'], undefined],
    ['nothing when a step shown was not recorded', ['success', 'unknown'], undefined],
  ] as const)('reads %s', (_name, outcomes, expected) => {
    const rows = outcomes.map((o) => tool(o));
    const group = groupOf(rows, 10);
    expect(investigationEndRow(group.records)).toBeNull();
    expect(groupTitle(group).detail).toBe(`${rows.length} of 10 steps shown`);
    expect(groupOutcome(group.records, group.total)).toBe(expected);
  });

  it('reads Success once every step has loaded and succeeded', () => {
    const group = groupOf([tool(), tool()]);
    expect(group.total).toBe(2);
    expect(groupOutcome(group.records, group.total)).toBe('success');
  });
});

describe('a partly loaded investigation with its ending loaded', () => {
  // Newest first, a run that straddles the page boundary has its decision on the first
  // page and its earlier steps (triage, prompt, the first log queries) on the next.
  const run = (firstQuery: AuditRecord['outcome']) => [
    router(),
    prompt(),
    query(firstQuery),
    query(),
    tool(),
    tool(),
    tool(),
    tool(),
    verdict(),
    decision(),
  ];

  it('claims nothing until the rest of the run loads, though every step shown succeeded', () => {
    const rows = run('failure');
    const page = firstPageOf(rows, 5);
    expect(page.records).toHaveLength(5);
    expect(investigationEndRow(page.records)?.actor).toBe('case_manager');
    expect(groupTitle(page).detail).toBe('5 of 10 steps shown · closed as false positive');
    expect(groupOutcome(page.records, page.total)).toBeUndefined();
    // Load more brings the failed first log query: the run reached its decision with a
    // failed step, so it reads Partial.
    const whole = groupOf(rows);
    expect(groupOutcome(whole.records, whole.total)).toBe('partial');
    // The same run with every step a success reads Success once complete.
    const clean = groupOf(run('success'));
    expect(groupOutcome(clean.records, clean.total)).toBe('success');
  });

  it('reads Partial from a failed step shown beside the decision, whatever is still to load', () => {
    const rows = [router(), prompt(), query(), query(), tool(), tool(), tool(), tool('failure'), verdict(), decision()];
    const page = firstPageOf(rows, 4);
    expect(groupTitle(page).detail).toBe('4 of 10 steps shown · closed as false positive');
    expect(groupOutcome(page.records, page.total)).toBe('partial');
  });

  it('reads Failed or Denied from the error row the run ended in', () => {
    const failed = [router(), prompt(), query(), tool(), tool(), error('pipeline', 'pipeline error: store unavailable')];
    const failedPage = firstPageOf(failed, 2);
    expect(investigationEndRow(failedPage.records)?.action_type).toBe('error');
    expect(groupOutcome(failedPage.records, failedPage.total)).toBe('failure');
    const refused = [router(), prompt(), tool(), error('investigator', 'investigator model error: budget exceeded; routed to a person', 'denied')];
    const refusedPage = firstPageOf(refused, 1);
    expect(groupOutcome(refusedPage.records, refusedPage.total)).toBe('denied');
  });

  it('reads a group whose run count is unavailable from the rows shown', () => {
    // Without `run_totals` the group counts the rows shown (`buildListItems`), as its title does.
    const rows = [prompt(), tool(), verdict(), decision()];
    const items = buildListItems(newestFirst(rows), 'agent', {}, new Set());
    const group = items[0] as GroupItem;
    expect(group.total).toBe(4);
    expect(groupTitle(group).detail).toBe('4 steps · closed as false positive');
    expect(groupOutcome(group.records, group.total)).toBe('success');
  });
});

describe('the group row words a run shown in part', () => {
  // Newest first: the decision and the last steps are on the first page, the failed first
  // log query on the next one.
  const run = () => [router(), prompt(), query('failure'), query(), tool(), tool(), tool(), tool(), verdict(), decision()];

  it('reads Not known, never Not recorded, while the steps shown prove no outcome', () => {
    const rows = run();
    const page = firstPageOf(rows, 5);
    expect(groupOutcome(page.records, page.total)).toBeUndefined();
    expect(groupOutcomeKey(page.records, page.total)).toBe('not_known');
    expect(GROUP_OUTCOME_LABEL.not_known).toBe('Not known');
    // Load more completes the group, and the run reads how it went.
    const whole = groupOf(rows);
    expect(groupOutcomeKey(whole.records, whole.total)).toBe('partial');
  });

  it.each([
    ['every step shown succeeded', ['success', 'success']],
    ['a step shown was not recorded', ['success', 'unknown']],
  ] as const)('reads Not known for a run shown in part without its ending when %s', (_name, outcomes) => {
    const group = groupOf(outcomes.map((o) => tool(o)), 10);
    expect(groupOutcomeKey(group.records, group.total)).toBe('not_known');
  });

  it('keeps the outcome a row shown already proves', () => {
    const failedStep = [router(), prompt(), query(), query(), tool(), tool(), tool(), tool('failure'), verdict(), decision()];
    const failedPage = firstPageOf(failedStep, 4);
    expect(groupOutcomeKey(failedPage.records, failedPage.total)).toBe('partial');
    const ended = firstPageOf([router(), prompt(), query(), tool(), error('pipeline', 'pipeline error: store unavailable')], 2);
    expect(groupOutcomeKey(ended.records, ended.total)).toBe('failure');
    const refused = firstPageOf(
      [router(), prompt(), tool(), error('investigator', 'investigator model error: budget exceeded; routed to a person', 'denied')],
      1,
    );
    expect(groupOutcomeKey(refused.records, refused.total)).toBe('denied');
    expect(groupOutcomeKey(groupOf([tool(), tool('failure')], 10).records, 10)).toBe('failure');
  });

  it('reads Not recorded only for a whole run whose rows do not record its outcome', () => {
    const rows = [prompt(), tool('unknown'), decision()];
    expect(groupOutcomeKey(rows)).toBe('not_recorded');
    expect(groupOutcomeKey(groupOf(rows).records, 3)).toBe('not_recorded');
    // A whole run that succeeded, and one with no `total` given (the rows shown are the run).
    expect(groupOutcomeKey(groupOf([prompt(), tool(), verdict(), decision()]).records, 4)).toBe('success');
    expect(groupOutcomeKey([tool(), tool()])).toBe('success');
  });

  it('words every group outcome as a record outcome, plus Not known', () => {
    for (const key of ['success', 'failure', 'denied', 'partial', 'not_recorded'] as const) {
      expect(GROUP_OUTCOME_LABEL[key]).toBe(OUTCOME_LABEL[key]);
    }
    const EM_DASH = String.fromCharCode(0x2014);
    expect(Object.values(GROUP_OUTCOME_LABEL).some((label) => label.includes(EM_DASH))).toBe(false);
  });
});

describe('the group row shows the run outcome', () => {
  function renderGroup(rows: AuditRecord[]) {
    const items = buildListItems(newestFirst(rows), 'agent', { 'inv-1': rows.length }, new Set());
    render(
      <TooltipProvider>
        <AuditTable
          items={items}
          layout="wide"
          zone="utc"
          onZoneChange={vi.fn()}
          order="desc"
          onOrderChange={vi.fn()}
          selectedId={null}
          onOpen={vi.fn()}
          onToggleGroup={vi.fn()}
          hasMore={false}
          canLoadMore={false}
          onLoadMore={vi.fn().mockResolvedValue(false)}
          canOpenCase
          registerRow={vi.fn()}
        />
      </TooltipProvider>,
    );
    return screen.getByText('Investigation of case-214').closest('tr')!;
  }

  it('shows Partial beside "closed as false positive" after a failed log query', () => {
    const row = renderGroup([router(), prompt(), query('failure'), verdict(), decision()]);
    expect(row).toHaveTextContent('closed as false positive');
    expect(within(row).getByText('Partial')).toBeInTheDocument();
    expect(within(row).queryByText('Failed')).toBeNull();
  });

  it('shows Failed for a run that ended in a pipeline error', () => {
    const row = renderGroup([router(), prompt(), error('pipeline', 'pipeline error: store unavailable')]);
    expect(within(row).getByText('Failed')).toBeInTheDocument();
  });
});
