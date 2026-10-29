/**
 * The editor's parts (Round 14, SPEC §4.10.5, §4.10.8, §4.10.12): the governance strip, the
 * Lookup and Decision step forms (with "Test with a case"), Applies when chips and the
 * analyst preview's "Fill with" a case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ testRunbookLookup: vi.fn() }));
vi.mock('@/lib/api-runbooks', () => ({ testRunbookLookup: mocks.testRunbookLookup }));

import type { RunbookDefinition } from '@/lib/types-runbooks';
import { TooltipProvider } from '@/ui/tooltip';

import { AnalystPreview } from '../AnalystPreview';
import { AppliesWhenEditor, MATCHING_HELP } from '../AppliesWhenEditor';
import { addStep, changeKind, placeIssues, updateStep } from '../draft';
import { GovernanceStrip } from '../GovernanceStrip';
import { issueLine } from '../IssuesSummary';
import { MatchResults } from '../MatchPanel';
import { DETAILS_ID, Outline } from '../Outline';
import { StepForm } from '../StepForm';
import { makeBuiltinDetail, makeDefinition, makeDetail, makeVersion } from './fixtures';

const NOW = Date.parse('2026-10-29T12:00:00Z');

function wrap(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('governance strip', () => {
  it('marks the current stage and says who wrote it, what is live and who stays on it', () => {
    const detail = makeDetail();
    wrap(<GovernanceStrip detail={detail} username="asha" isNew={false} dirty={false} now={NOW} />);
    const current = screen.getByText('Draft').closest('[aria-current]');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(within(current as HTMLElement).getByText('v2 by you')).toBeInTheDocument();
    expect(screen.getByText('v1 is live')).toBeInTheDocument();
    expect(screen.getByText('3 open cases stay on v1')).toBeInTheDocument();
    expect(screen.getByText(/Nov 2, 2026, in 4 days/)).toBeInTheDocument();
    expect(screen.getByText('Detection engineering')).toBeInTheDocument();
  });

  it('says a version in review needs a second person', () => {
    const detail = makeDetail({ draft: null, in_review: makeVersion(2, 'in_review') });
    wrap(<GovernanceStrip detail={detail} username="asha" isNew={false} dirty={false} now={NOW} />);
    expect(screen.getByText('needs a second person')).toBeInTheDocument();
  });

  it('gives a built-in its own read-only line', () => {
    wrap(<GovernanceStrip detail={makeBuiltinDetail()} username="asha" isNew={false} dirty={false} now={NOW} />);
    expect(screen.getByText(/Built-in runbooks are read only/)).toBeInTheDocument();
    expect(screen.getByText('with Agentic SOC releases')).toBeInTheDocument();
  });
});

function lookupDefinition(): { defn: RunbookDefinition; id: string } {
  const base = makeDefinition();
  return { defn: base, id: base.steps.find((s) => s.kind === 'lookup')!.id };
}

describe('the Lookup step form', () => {
  beforeEach(() => mocks.testRunbookLookup.mockReset());

  it('states the read-only boundary, offers case values as chips and shows issues on the filter', () => {
    const { defn, id } = lookupDefinition();
    const withFilter: RunbookDefinition = {
      ...defn,
      steps: defn.steps.map((s) => (s.id === id && s.lookup ? { ...s, lookup: { ...s.lookup, filter: { ip: '' } } } : s)),
    };
    const issues = placeIssues([{ path: 'steps[1].lookup.filter.ip', code: 'invalid', message: 'Use a case value or an IP address.' }], withFilter);
    const onChange = vi.fn();
    wrap(
      <StepForm
        defn={withFilter}
        step={withFilter.steps[1]}
        number={2}
        readOnly={false}
        issues={issues}
        onChange={onChange}
        onTouch={vi.fn()}
        canTest={false}
        testCases={[]}
      />,
    );
    expect(screen.getByText('Read-only. Case values are passed as parameters; results are untrusted.')).toBeInTheDocument();
    expect(screen.getByText('Use a case value or an IP address.')).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Case values for filter 1' });
    fireEvent.click(within(chips).getByText('{{entity.ip}}'));
    const next = onChange.mock.calls.at(-1)?.[0] as RunbookDefinition;
    expect(next.steps[1].lookup?.filter).toEqual({ ip: '{{entity.ip}}' });
  });

  it('tests the lookup against a case without saving, and shows the result as text', async () => {
    const { defn, id } = lookupDefinition();
    mocks.testRunbookLookup.mockResolvedValue({
      tool: 'log_stats',
      params: {},
      window_from: '2026-10-28T10:00:00Z',
      window_to: '2026-10-28T12:00:00Z',
      ran_at: '2026-10-29T12:00:00Z',
      ran_by: 'asha',
      status: 'ok',
      reason: null,
      count: 42,
      count_relation: 'eq',
      facts: [{ label: 'Distinct users', value: '<b>17</b>' }],
      table: null,
      table_kind: null,
      window_clamped: false,
    });
    wrap(
      <StepForm
        defn={defn}
        step={defn.steps.find((s) => s.id === id)!}
        number={2}
        readOnly={false}
        issues={[]}
        onChange={vi.fn()}
        onTouch={vi.fn()}
        canTest
        testCases={[{ case_id: 'c-214', case_number: 'CASE-000214', title: 'SSH spray' }]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Test with a case'), { target: { value: 'CASE-000214' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => expect(mocks.testRunbookLookup).toHaveBeenCalledWith({ lookup: defn.steps.find((s) => s.id === id)!.lookup, case_id: 'c-214' }));
    expect(await screen.findByText('<b>17</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('the Decision step form', () => {
  it('adds options up to six and lets an option skip a later step', () => {
    let defn = makeDefinition();
    defn = addStep(defn, 'contain', 'action').defn;
    const decision = defn.steps.find((s) => s.kind === 'decision')!;
    const later = defn.steps.find((s) => s.kind === 'action')!;
    const onChange = vi.fn();
    wrap(
      <StepForm defn={defn} step={decision} number={3} readOnly={false} issues={[]} onChange={onChange} onTouch={vi.fn()} canTest={false} testCases={[]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
    let next = onChange.mock.calls.at(-1)?.[0] as RunbookDefinition;
    expect(next.steps.find((s) => s.id === decision.id)?.options).toHaveLength(3);
    const skip = screen.getAllByRole('checkbox')[0];
    fireEvent.click(skip);
    next = onChange.mock.calls.at(-1)?.[0] as RunbookDefinition;
    expect(next.steps.find((s) => s.id === decision.id)?.options[0].marks_not_applicable).toEqual([later.id]);
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeDisabled();
  });
});

describe('Applies when', () => {
  it('shows each condition as a chip that can be removed', () => {
    const onChange = vi.fn();
    const value = { ...makeDefinition().applies_when, rule_ids: ['ssh_auth_failed', 'vpn_auth_failed'] };
    wrap(<AppliesWhenEditor value={value} onChange={onChange} readOnly={false} suggestions={{ rules: [], techniques: [], sources: [] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule vpn_auth_failed' }));
    expect(onChange.mock.calls.at(-1)?.[0].rule_ids).toEqual(['ssh_auth_failed']);
  });

  it('explains matching, the pending facts before the investigation and carried-over tags', () => {
    expect(MATCHING_HELP).toMatch(/a runbook that names its rules still guides the investigator/);
    expect(MATCHING_HELP).toMatch(/Tags carried over from an earlier version/);
  });
});

describe('Preview as analyst', () => {
  it('fills the lookup values from a chosen case and names the ones it has no value for', async () => {
    const { defn, id } = lookupDefinition();
    const withFilter: RunbookDefinition = {
      ...defn,
      steps: defn.steps.map((s) =>
        s.id === id && s.lookup ? { ...s, lookup: { ...s.lookup, filter: { ip: '{{entity.ip}}', user: '{{entity.user}}' } } } : s,
      ),
    };
    const loadCaseValues = vi.fn().mockResolvedValue({ 'entity.ip': '203.0.113.7' });
    wrap(
      <AnalystPreview
        defn={withFilter}
        cases={[{ case_id: 'c-214', case_number: 'CASE-000214', title: 'SSH spray' }]}
        loadCaseValues={loadCaseValues}
        guidance={{ chars: 2_140, budget: 3_000 }}
      />,
    );
    expect(screen.getByText('Investigator guidance: 2,140 of 3,000 characters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fill with CASE-000214' }));
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText(/This case has no value for \{\{entity\.user\}\}/)).toBeInTheDocument();
    expect(loadCaseValues).toHaveBeenCalledWith('c-214');
  });

  it('marks guidance over the budget', () => {
    wrap(<AnalystPreview defn={makeDefinition()} cases={[]} guidance={{ chars: 3_200, budget: 3_000 }} />);
    expect(screen.getByRole('meter', { name: 'Investigator guidance length' })).toHaveAttribute('aria-valuetext', '3,200 of 3,000 characters');
    expect(screen.getByText(/Over the budget/)).toBeInTheDocument();
  });
});

describe('review fixes: the outline', () => {
  function dragStep(from: HTMLElement, to: HTMLElement) {
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
  }

  it('drops a step before the step it lands on, once', () => {
    let defn = makeDefinition();
    defn = addStep(defn, 'triage', 'check').defn;
    const triage = defn.steps.filter((s) => s.phase === 'triage');
    expect(triage).toHaveLength(3);
    const onDrop = vi.fn();
    wrap(<Outline defn={defn} selected={DETAILS_ID} onSelect={vi.fn()} readOnly={false} problems={new Set()} onDrop={onDrop} onMove={vi.fn()} />);
    const item = (id: string) => document.querySelector(`[data-outline-step="${id}"]`) as HTMLElement;
    dragStep(item(triage[2].id), item(triage[0].id));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(triage[2].id, triage[0].id, 'triage');
  });

  it('drops a step on a phase header at the end of that phase', () => {
    const defn = makeDefinition();
    const onDrop = vi.fn();
    wrap(<Outline defn={defn} selected={DETAILS_ID} onSelect={vi.fn()} readOnly={false} problems={new Set()} onDrop={onDrop} onMove={vi.fn()} />);
    const first = defn.steps[0];
    dragStep(document.querySelector(`[data-outline-step="${first.id}"]`) as HTMLElement, document.querySelector('[data-outline-phase="investigate"]') as HTMLElement);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(first.id, null, 'investigate');
  });

  it('marks the selected item by weight and a bar as well as a tint, and rings a phase on its header row', () => {
    const defn = makeDefinition();
    wrap(<Outline defn={defn} selected={defn.steps[0].id} onSelect={vi.fn()} readOnly={false} problems={new Set()} />);
    const selected = document.querySelector(`[data-outline-step="${defn.steps[0].id}"]`) as HTMLElement;
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected.className).toContain('font-medium');
    expect(selected.className).toContain('shadow-[inset_2px_0_0_hsl(var(--primary))]');
    expect(selected.className).toContain('forced-colors:outline');
    const phase = document.querySelector('[data-outline-phase="triage"]') as HTMLElement;
    expect(phase.className).not.toMatch(/(^| )focus-visible:ring-2/);
    expect(phase.className).toContain('[&:focus-visible>div:first-child]:ring-2');
  });
});

describe('review fixes: the step form', () => {
  it('keeps Escalate if and Benign if when the kind is arrowed away and back', () => {
    let defn = makeDefinition();
    defn = updateStep(defn, 'first-check', { escalate_if: 'Many users from one client.', benign_if: 'A known password change rollout.' });
    let current = defn;
    const onChange = vi.fn((next: RunbookDefinition) => {
      current = next;
    });
    const view = wrap(
      <StepForm defn={current} step={current.steps[0]} number={1} readOnly={false} issues={[]} onChange={onChange} onTouch={vi.fn()} canTest={false} testCases={[]} />,
    );
    const rerender = () =>
      view.rerender(
        <TooltipProvider>
          <StepForm defn={current} step={current.steps[0]} number={1} readOnly={false} issues={[]} onChange={onChange} onTouch={vi.fn()} canTest={false} testCases={[]} />
        </TooltipProvider>,
      );
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    rerender();
    expect(current.steps[0]).toMatchObject({ kind: 'lookup', escalate_if: null, benign_if: null });
    fireEvent.click(screen.getByRole('radio', { name: 'Check' }));
    rerender();
    expect(current.steps[0]).toMatchObject({ kind: 'check', escalate_if: 'Many users from one client.', benign_if: 'A known password change rollout.' });
    expect((screen.getByLabelText('Escalate if') as HTMLTextAreaElement).value).toBe('Many users from one client.');
  });

  it('keeps an Escalate if the author cleared cleared, whatever kind comes next', () => {
    let current = updateStep(makeDefinition(), 'first-check', { escalate_if: 'Many users from one client.' });
    const onChange = vi.fn((next: RunbookDefinition) => {
      current = next;
    });
    const form = () => (
      <TooltipProvider>
        <StepForm defn={current} step={current.steps[0]} number={1} readOnly={false} issues={[]} onChange={onChange} onTouch={vi.fn()} canTest={false} testCases={[]} />
      </TooltipProvider>
    );
    const view = render(form());
    fireEvent.click(screen.getByRole('radio', { name: 'Lookup' }));
    view.rerender(form());
    fireEvent.click(screen.getByRole('radio', { name: 'Check' }));
    view.rerender(form());
    fireEvent.change(screen.getByLabelText('Escalate if'), { target: { value: '' } });
    view.rerender(form());
    fireEvent.click(screen.getByRole('radio', { name: 'Decision' }));
    view.rerender(form());
    expect(current.steps[0]).toMatchObject({ kind: 'decision', escalate_if: null });
    expect((screen.getByLabelText('Escalate if') as HTMLTextAreaElement).value).toBe('');
  });

  it('says each kind once (no repeated sentence) and lays the kinds out three to a row on a phone', () => {
    const defn = changeKind(makeDefinition(), 'first-check', 'action');
    wrap(<StepForm defn={defn} step={defn.steps[0]} number={1} readOnly={false} issues={[]} onChange={vi.fn()} onTouch={vi.fn()} canTest={false} testCases={[]} />);
    const note = document.querySelector('[data-kind-note]') as HTMLElement;
    expect(note.textContent).toBe('A person acts in another system. Agentic SOC does not run this action; it keeps the record.');
    expect(note.textContent?.match(/keeps the record/g)).toHaveLength(1);
    const kinds = screen.getByRole('radiogroup', { name: 'Step kind' });
    expect(kinds.className).toContain('grid-cols-3');
    expect(kinds.className).toContain('sm:inline-flex');
  });

  it('never folds two filter rows into one: a field another row holds is refused with a reason', () => {
    const { defn, id } = lookupDefinition();
    const twoFilters: RunbookDefinition = {
      ...defn,
      steps: defn.steps.map((s) => (s.id === id && s.lookup ? { ...s, lookup: { ...s.lookup, filter: { ip: '{{entity.ip}}', user: 'alice' } } } : s)),
    };
    const onChange = vi.fn();
    wrap(
      <StepForm defn={twoFilters} step={twoFilters.steps.find((s) => s.id === id)!} number={2} readOnly={false} issues={[]} onChange={onChange} onTouch={vi.fn()} canTest={false} testCases={[]} />,
    );
    const second = screen.getByLabelText('Filter 2 field') as HTMLInputElement;
    fireEvent.change(second, { target: { value: 'ip' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(second.value).toBe('ip');
    expect(screen.getByText('This field is already filtered.')).toBeInTheDocument();
    fireEvent.change(second, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Name the field to filter on.')).toBeInTheDocument();
    fireEvent.change(second, { target: { value: 'host' } });
    const next = onChange.mock.calls.at(-1)?.[0] as RunbookDefinition;
    expect(next.steps.find((s) => s.id === id)?.lookup?.filter).toEqual({ ip: '{{entity.ip}}', host: 'alice' });
  });

  it('says plainly when a typed case is not found', async () => {
    const { defn, id } = lookupDefinition();
    const { ApiError } = await import('@/lib/api');
    mocks.testRunbookLookup.mockRejectedValue(new ApiError(404, 'Case not found.', { detail: { code: 'case_not_found', message: 'Case not found.' } }));
    wrap(
      <StepForm defn={defn} step={defn.steps.find((s) => s.id === id)!} number={2} readOnly={false} issues={[]} onChange={vi.fn()} onTouch={vi.fn()} canTest testCases={[{ case_id: 'c-214', case_number: 'CASE-000214', title: 'SSH spray' }]} />,
    );
    const input = screen.getByLabelText('Test with a case');
    expect(input).toHaveAttribute('placeholder', 'A listed case, or a case id');
    fireEvent.change(input, { target: { value: 'CASE-999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(await screen.findByText('No case has that id. Choose a listed case, or paste the id from the case page.')).toBeInTheDocument();
  });
});

describe('review fixes: other parts', () => {
  it('names the case whose values are shown, not the one picked in the list since', async () => {
    const { defn, id } = lookupDefinition();
    const withFilter: RunbookDefinition = {
      ...defn,
      steps: defn.steps.map((s) => (s.id === id && s.lookup ? { ...s, lookup: { ...s.lookup, filter: { ip: '{{entity.ip}}' } } } : s)),
    };
    wrap(
      <AnalystPreview
        defn={withFilter}
        cases={[
          { case_id: 'c-214', case_number: 'CASE-000214', title: 'SSH spray' },
          { case_id: 'c-215', case_number: 'CASE-000215', title: 'VPN failures' },
        ]}
        loadCaseValues={vi.fn().mockResolvedValue({ 'entity.ip': '203.0.113.7' })}
        guidance={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fill with CASE-000214' }));
    expect(await screen.findByText('Values from CASE-000214.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Case to fill from' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'CASE-000215' }));
    expect(screen.getByText('Values from CASE-000214.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill with CASE-000215' })).toBeInTheDocument();
  });

  it('points a built-in to Duplicate only when it is offered, and words the zero case plainly', () => {
    const { unmount } = wrap(<GovernanceStrip detail={makeBuiltinDetail()} username="asha" isNew={false} dirty={false} canDuplicate now={NOW} />);
    expect(screen.getByText(/Duplicate one to customise it/)).toBeInTheDocument();
    expect(screen.getByText('No open cases use it')).toBeInTheDocument();
    unmount();
    wrap(<GovernanceStrip detail={makeBuiltinDetail()} username="asha" isNew={false} dirty={false} now={NOW} />);
    expect(screen.queryByText(/Duplicate one to customise it/)).toBeNull();
    expect(screen.getByText('Built-in runbooks are read only and are updated with Agentic SOC releases.')).toBeInTheDocument();
  });

  it('names the runbook that wins a case without claiming why', () => {
    wrap(
      <MatchResults
        state="ready"
        preview={{
          considered: 3,
          window_label: 'Last 30 days',
          gets_it: [],
          another_wins: [{ case_id: 'c1', case_number: 'CASE-1', title: 'A case', winner_id: 'other', winner_title: 'Other runbook' }],
          near_misses: [],
          counts: { gets_it: 0, another_wins: 1, near_misses: 0 },
          truncated: false,
        }}
      />,
    );
    expect(screen.getByText('Other runbook wins this case.')).toBeInTheDocument();
    expect(screen.queryByText(/more specific/)).toBeNull();
  });

  it('prefixes a problem with its step only when the message does not name the step', () => {
    const base = { path: 'steps[1].title', code: 'required', stepId: 'x', field: 'title' };
    expect(issueLine({ ...base, message: 'The title of step 2 is required.' }, 2)).toBe('The title of step 2 is required.');
    expect(issueLine({ ...base, message: 'Shorten the focus line.' }, 2)).toBe('Step 2: Shorten the focus line.');
    expect(issueLine({ ...base, message: 'Give the runbook a title.', stepId: null }, 0)).toBe('Give the runbook a title.');
  });
});
