/**
 * Closing a case by hand while required runbook steps are open (Round 14, SPEC §4.10.11,
 * §4.10.15, D34): the close dialog lists the steps and asks why (required, optional for a
 * duplicate), the footer says what is missing, and the bulk close dialog offers one
 * shared, optional reason. The close is never blocked by the runbook.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ getRunbookProgress: vi.fn() }));
vi.mock('@/lib/api-runbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-runbooks')>();
  return { ...actual, ...api };
});

import { ConfirmActionDialog, OPEN_STEPS_REASON_MISSING } from '@/soc/pages/casedetail/ConfirmActionDialog';
import { BulkCloseDialog } from '@/soc/pages/casedetail/BulkCloseDialog';
import { ALL_ACTIONS, type ActionDef } from '@/soc/pages/casedetail/shared';
import { emptyGradingDraft } from '@/soc/pages/casedetail/grading';

import { AUTOMATIC_CLOSES_NOTE, OPEN_STEPS_REASON_LABEL } from '../OpenStepsNotice';
import { openRequiredSteps } from '../model';
import { makeData, progress } from './fixtures';

function CloseHarness({ onSubmit, error = null }: { onSubmit: () => void; error?: string | null }) {
  const [disposition, setDisposition] = React.useState('');
  const [reason, setReason] = React.useState('');
  return (
    <ConfirmActionDialog
      pending={ALL_ACTIONS.close_disposition}
      acting={false}
      onClose={vi.fn()}
      onSubmit={onSubmit}
      note=""
      onNoteChange={vi.fn()}
      resolution=""
      onResolutionChange={vi.fn()}
      priority=""
      onPriorityChange={vi.fn()}
      assignee=""
      onAssigneeChange={vi.fn()}
      tags={[]}
      onTagsChange={vi.fn()}
      tagDraft=""
      onTagDraftChange={vi.fn()}
      disposition={disposition}
      onDispositionChange={setDisposition}
      reason=""
      onReasonChange={vi.fn()}
      verdict="NEEDS_HUMAN"
      confidence={0.6}
      grading={emptyGradingDraft()}
      onGradingChange={vi.fn()}
      openSteps={openRequiredSteps(makeData())}
      openStepsReason={reason}
      onOpenStepsReasonChange={setReason}
      openStepsError={error}
    />
  );
}

describe('close dialog with required steps open', () => {
  it('lists the open required steps with their status and asks why', () => {
    render(<CloseHarness onSubmit={vi.fn()} />);
    const notice = screen.getByRole('region', { name: 'Open runbook steps' });
    expect(within(notice).getByText('3 required runbook steps are still open')).toBeInTheDocument();
    expect(within(notice).getByText('Brute force and password spray, version 4')).toBeInTheDocument();
    expect(within(notice).getByText('Did any sign-in succeed after the failures?')).toBeInTheDocument();
    expect(within(notice).getByText('Decision waiting')).toBeInTheDocument();
    expect(screen.getByLabelText(OPEN_STEPS_REASON_LABEL)).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText(new RegExp(AUTOMATIC_CLOSES_NOTE))).toBeInTheDocument();
    // The footer says what is missing first: the disposition.
    expect(screen.getByTestId('confirm-action-status')).toHaveTextContent('Pick a disposition.');
    expect(document.body.textContent).not.toMatch(/—|playbook/i);
  });

  it('stops a close with no reason, points at the field, then submits once a reason is given', async () => {
    const onSubmit = vi.fn();
    render(<CloseHarness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    expect(screen.getByTestId('confirm-action-status')).toHaveTextContent(OPEN_STEPS_REASON_MISSING);

    const footer = screen.getByTestId('confirm-action-footer');
    fireEvent.click(within(footer).getByRole('button', { name: 'Close case' }));
    expect(onSubmit).not.toHaveBeenCalled();
    const field = screen.getByLabelText(OPEN_STEPS_REASON_LABEL);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByRole('alert')).toHaveTextContent(OPEN_STEPS_REASON_MISSING);
    expect(field).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(field, { target: { value: 'Contained by the network team under CHG-4821.' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(within(footer).getByRole('button', { name: 'Close case' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('needs no reason to mark a duplicate', () => {
    const onSubmit = vi.fn();
    render(<CloseHarness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /duplicate/i }));
    expect(screen.getByLabelText(/Why are you closing with required steps open\?/)).not.toHaveAttribute('aria-required');
    expect(screen.getByText('(optional for a duplicate)')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: 'Close case' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("shows the server's refusal next to the field", () => {
    render(<CloseHarness onSubmit={vi.fn()} error="Required runbook steps are open. Say why you are closing the case." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Required runbook steps are open. Say why you are closing the case.');
  });
});

/** The close dialog opened from a button, whose submit the server refuses (409 runbook_steps_open). */
function RefusalHarness({ focusAfterSubmit }: { focusAfterSubmit: (opener: HTMLElement | null, andNext: boolean) => HTMLElement | null }) {
  const [pending, setPending] = React.useState<ActionDef | null>(null);
  const [acting, setActing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [disposition, setDisposition] = React.useState('');
  const [reason, setReason] = React.useState('');
  const refuse = () => {
    setActing(true);
    setTimeout(() => {
      setActing(false);
      setError('Required runbook steps are open. Say why you are closing the case.');
    }, 0);
  };
  return (
    <>
      <button type="button" onClick={() => setPending(ALL_ACTIONS.close_disposition)}>
        Open close
      </button>
      <ConfirmActionDialog
        pending={pending}
        acting={acting}
        onClose={() => setPending(null)}
        onSubmit={refuse}
        onSubmitAndNext={refuse}
        focusAfterSubmit={focusAfterSubmit}
        note=""
        onNoteChange={vi.fn()}
        resolution=""
        onResolutionChange={vi.fn()}
        priority=""
        onPriorityChange={vi.fn()}
        assignee=""
        onAssigneeChange={vi.fn()}
        tags={[]}
        onTagsChange={vi.fn()}
        tagDraft=""
        onTagDraftChange={vi.fn()}
        disposition={disposition}
        onDispositionChange={setDisposition}
        reason=""
        onReasonChange={vi.fn()}
        verdict="NEEDS_HUMAN"
        confidence={0.6}
        grading={emptyGradingDraft()}
        onGradingChange={vi.fn()}
        openSteps={openRequiredSteps(makeData())}
        openStepsReason={reason}
        onOpenStepsReasonChange={setReason}
        openStepsError={error}
      />
    </>
  );
}

describe('close dialog refused by the server', () => {
  it('returns focus to the opener on Cancel, never where a finished Close & next would go', async () => {
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    const focusAfterSubmit = vi.fn(() => elsewhere);
    render(<RefusalHarness focusAfterSubmit={focusAfterSubmit} />);
    const opener = screen.getByRole('button', { name: 'Open close' });
    act(() => opener.focus());
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /false positive/i }));
    fireEvent.change(within(dialog).getByLabelText(OPEN_STEPS_REASON_LABEL), { target: { value: 'Owned by the platform team.' } });
    fireEvent.click(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: 'Close & next' }));
    // The refusal keeps the dialog open with the server's sentence.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Required runbook steps are open.');
    fireEvent.click(within(screen.getByTestId('confirm-action-footer')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(focusAfterSubmit).not.toHaveBeenCalled();
    elsewhere.remove();
  });
});

describe('bulk close with required steps open', () => {
  it('says how many selected cases have required steps open and sends one shared reason', async () => {
    api.getRunbookProgress.mockResolvedValue({
      'case-1': progress({ required_open: 2 }),
      'case-2': progress({ required_open: 0, done: 6 }),
      'case-3': progress({ required_open: 1 }),
    });
    const onSubmit = vi.fn();
    render(
      <BulkCloseDialog action="close" count={3} caseIds={['case-1', 'case-2', 'case-3']} onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
    expect(await screen.findByText('2 of the 3 selected cases have required runbook steps open.')).toBeInTheDocument();
    expect(api.getRunbookProgress).toHaveBeenCalledWith(['case-1', 'case-2', 'case-3'], expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    fireEvent.change(screen.getByLabelText(new RegExp(OPEN_STEPS_REASON_LABEL.replace('?', '\\?'))), {
      target: { value: '  Contained by the network team. ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close 3 cases' }));
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'close',
      disposition: 'false_positive',
      disposition_declared: true,
      open_steps_reason: 'Contained by the network team.',
    });
  });

  it('never blocks a bulk close: the reason is optional and a failed read says nothing', async () => {
    api.getRunbookProgress.mockRejectedValue(new Error('offline'));
    const onSubmit = vi.fn();
    render(<BulkCloseDialog action="close" count={2} caseIds={['case-1', 'case-2']} onCancel={vi.fn()} onSubmit={onSubmit} />);
    await waitFor(() => expect(api.getRunbookProgress).toHaveBeenCalled());
    expect(screen.queryByText(/required runbook steps open/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close 2 cases' }));
    expect(onSubmit).toHaveBeenCalledWith({ action: 'close', disposition: 'false_positive', disposition_declared: true });
  });
});
