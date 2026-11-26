/**
 * The close dialogs while the AI investigates a case (Round 16 SPEC §4.5 WP09, D10): the
 * run's result stays authoritative, so the dialog says that a close made now is replaced
 * when the run finishes. Only for an action that moves the status, never blocking the
 * submit, and the note turns into a "finished" note when the run ends while the dialog
 * is open. The bulk dialog counts the selected cases with a run.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { InvestigationsActive, InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  onEvent: null as null | ((ev: { type: string; data: unknown; lastEventId: string }) => void),
}));

vi.mock('@/lib/api-investigations', () => ({ getActiveInvestigations: h.read }));
vi.mock('@/lib/api-runbooks', () => ({ getRunbookProgress: vi.fn(async () => ({})) }));
vi.mock('@/lib/useEventStream', () => ({
  subscribeEvents: (_topics: string[], opts: { onEvent: typeof h.onEvent }) => {
    h.onEvent = opts.onEvent;
    return () => undefined;
  },
}));

import { ConfirmActionDialog } from '../ConfirmActionDialog';
import { BulkCloseDialog } from '../BulkCloseDialog';
import { ALL_ACTIONS, type ActionDef } from '../shared';
import { emptyGradingDraft } from '../grading';
import { resetInvestigationsForTests } from '@/soc/investigations/store';
import { AiRunCloseNotice } from '@/soc/investigations/AiRunCloseNotice';

const T0 = Date.parse('2026-11-25T10:00:00Z');

function view(over: Partial<InvestigationView> = {}): InvestigationView {
  return {
    run_id: 'inv-1',
    case_id: 'case-1',
    state: 'running',
    phase: 'evidence',
    trigger: 'automatic',
    queued_at: new Date(T0 - 30_000).toISOString(),
    started_at: new Date(T0 - 30_000).toISOString(),
    deadline_at: new Date(T0 + 90_000).toISOString(),
    time_cap_seconds: 120,
    finished_at: null,
    outcome: null,
    status_after: null,
    verdict_after: null,
    ...over,
  };
}

function serve(items: InvestigationView[]) {
  h.read.mockImplementation(
    async (): Promise<InvestigationsActive> => ({
      items,
      recent: [],
      new_runs: 0,
      slots: { in_use: items.length, cap: 3 },
      process_local: true,
      generated_at: new Date(Date.now()).toISOString(),
    }),
  );
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function Confirm({ action, caseIds = ['case-1'] }: { action: ActionDef; caseIds?: string[] }) {
  const opener = React.useRef<HTMLButtonElement | null>(null);
  return (
    <ConfirmActionDialog
      caseIds={caseIds}
      pending={action}
      acting={false}
      onClose={vi.fn()}
      onSubmit={vi.fn()}
      returnFocusTo={opener}
      note=""
      onNoteChange={vi.fn()}
      priority=""
      onPriorityChange={vi.fn()}
      assignee=""
      onAssigneeChange={vi.fn()}
      actionsTaken={[]}
      onActionsTakenChange={vi.fn()}
      disposition="false_positive"
      onDispositionChange={vi.fn()}
      currentDisposition="none"
      reason=""
      onReasonChange={vi.fn()}
      verdict="FALSE_POSITIVE"
      confidence={0.9}
      grading={emptyGradingDraft()}
      onGradingChange={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetInvestigationsForTests();
  h.read.mockReset();
  serve([]);
  h.onEvent = null;
});

afterEach(() => {
  resetInvestigationsForTests();
  vi.useRealTimers();
});

describe('the close dialog during an AI run', () => {
  it('says the run replaces a close made now, and keeps the submit enabled', async () => {
    serve([view()]);
    render(<Confirm action={ALL_ACTIONS.close_disposition} />);
    await settle();
    const note = screen.getByTestId('ai-run-close-notice');
    expect(within(note).getByText('An AI investigation is running on this case.')).toBeInTheDocument();
    expect(within(note).getByText('When it finishes, its result replaces a close you make now.')).toBeInTheDocument();
    // A polite status, never an alert that interrupts.
    expect(note).toHaveAttribute('role', 'status');
    const footer = screen.getByTestId('confirm-action-footer');
    expect(within(footer).getByRole('button', { name: 'Close case' })).toBeEnabled();
  });

  it('words any other status change the same way', async () => {
    serve([view()]);
    render(<Confirm action={ALL_ACTIONS.escalate} />);
    await settle();
    expect(screen.getByTestId('ai-run-close-notice')).toHaveTextContent(
      'When it finishes, its result replaces the status you set now.',
    );
  });

  it('says nothing for an action that does not move the status, or without a run', async () => {
    serve([view()]);
    const { unmount } = render(<Confirm action={ALL_ACTIONS.set_disposition} />);
    await settle();
    expect(screen.queryByTestId('ai-run-close-notice')).toBeNull();
    unmount();
    serve([view({ case_id: 'case-9' })]);
    resetInvestigationsForTests();
    render(<Confirm action={ALL_ACTIONS.close_disposition} />);
    await settle();
    expect(screen.queryByTestId('ai-run-close-notice')).toBeNull();
  });

  it('turns into a finished note when the run ends while the dialog is open', async () => {
    serve([view()]);
    render(<Confirm action={ALL_ACTIONS.close_disposition} />);
    await settle();
    expect(screen.getByTestId('ai-run-close-notice')).toBeInTheDocument();
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: {
          ...view({ state: 'finished', phase: 'decision', outcome: 'decided', status_after: 'needs_human', verdict_after: 'NEEDS_HUMAN' }),
          active: 0,
          new_runs: 0,
        },
        lastEventId: '5',
      }),
    );
    expect(screen.queryByTestId('ai-run-close-notice')).toBeNull();
    expect(screen.getByTestId('ai-run-close-finished')).toHaveTextContent(
      'The AI investigation finished. The verdict is now needs human review. Check it before you close.',
    );
    expect(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: 'Close case' })).toBeEnabled();
  });

  it('writes the new verdict in lower case mid-sentence', async () => {
    serve([view()]);
    render(<Confirm action={ALL_ACTIONS.close_disposition} />);
    await settle();
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: {
          ...view({ state: 'finished', phase: 'decision', outcome: 'decided', status_after: 'open', verdict_after: 'FALSE_POSITIVE' }),
          active: 0,
          new_runs: 0,
        },
        lastEventId: '6',
      }),
    );
    expect(screen.getByTestId('ai-run-close-finished')).toHaveTextContent(
      'The AI investigation finished. The verdict is now false positive. Check it before you close.',
    );
  });
});

describe('the bulk close dialog during AI runs', () => {
  it('counts the selected cases with a run, and never blocks the submit', async () => {
    serve([view(), view({ run_id: 'inv-2', case_id: 'case-2' }), view({ run_id: 'inv-3', case_id: 'case-9' })]);
    render(
      <BulkCloseDialog action="close" count={3} caseIds={['case-1', 'case-2', 'case-3']} onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    await settle();
    expect(screen.getByTestId('ai-run-close-notice')).toHaveTextContent(
      '2 of the selected cases have an AI investigation running. Their results replace this close when they finish.',
    );
    // The submit waits only for a disposition, as it always did; the note never blocks it.
    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    expect(screen.getByRole('button', { name: 'Close 3 cases' })).toBeEnabled();
  });

  it('words one case in the singular, then says when the runs finished', async () => {
    serve([view({ case_id: 'case-2' })]);
    render(<BulkCloseDialog action="close" count={2} caseIds={['case-1', 'case-2']} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    await settle();
    expect(screen.getByTestId('ai-run-close-notice')).toHaveTextContent(
      '1 of the selected cases has an AI investigation running. Its result replaces this close when it finishes.',
    );
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ case_id: 'case-2', state: 'finished', outcome: 'decided', status_after: 'closed' }), active: 0, new_runs: 0 },
        lastEventId: '6',
      }),
    );
    expect(screen.getByTestId('ai-run-close-finished')).toHaveTextContent(
      'The AI investigations on the selected cases finished. Check them before you close.',
    );
  });

  it('words a bulk status change (Acknowledge, Set status) as a status, never a close (WP16)', async () => {
    serve([view(), view({ run_id: 'inv-2', case_id: 'case-2' })]);
    render(<AiRunCloseNotice caseIds={['case-1', 'case-2', 'case-3']} open action="status" />);
    await settle();
    expect(screen.getByTestId('ai-run-close-notice')).toHaveTextContent(
      '2 of the selected cases have an AI investigation running. Their results replace the status you set now when they finish.',
    );
  });

  it('words one case of a bulk status change in the singular, then says when its run finished (WP16)', async () => {
    serve([view({ case_id: 'case-2' })]);
    render(<AiRunCloseNotice caseIds={['case-1', 'case-2']} open action="status" />);
    await settle();
    expect(screen.getByTestId('ai-run-close-notice')).toHaveTextContent(
      '1 of the selected cases has an AI investigation running. Its result replaces the status you set now when it finishes.',
    );
    act(() =>
      h.onEvent?.({
        type: 'case.investigation',
        data: { ...view({ case_id: 'case-2', state: 'finished', outcome: 'decided', status_after: 'closed' }), active: 0, new_runs: 0 },
        lastEventId: '7',
      }),
    );
    expect(screen.getByTestId('ai-run-close-finished')).toHaveTextContent(
      'The AI investigations on the selected cases finished. Check them before you change the status.',
    );
  });

  it('says the screenshots are added in the Activity tab', () => {
    render(<BulkCloseDialog action="close" count={1} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByTestId('bulk-close-screenshots-note')).toHaveTextContent('in its Activity tab.');
    expect(screen.queryByTestId('ai-run-close-notice')).toBeNull();
  });
});
