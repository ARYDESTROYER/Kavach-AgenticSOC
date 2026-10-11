/**
 * ConfirmActionDialog (Round 12, CM-3 / D15): the close dialog keeps its actions in a
 * sticky footer outside the scrolling body, offers "Close & next" when the caller can
 * advance the queue, compares the AI verdict with the analyst's pick, and returns focus
 * to the control that opened it.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { ConfirmActionDialog, type ConfirmActionDialogProps } from '../ConfirmActionDialog';
import { ALL_ACTIONS } from '../shared';
import { emptyGradingDraft } from '../grading';

function Harness(over: Partial<ConfirmActionDialogProps> & { startOpen?: boolean }) {
  const opener = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(over.startOpen ?? false);
  const [disposition, setDisposition] = React.useState('');
  const [grading, setGrading] = React.useState(emptyGradingDraft());
  return (
    <>
      <button type="button" ref={opener} onClick={() => setOpen(true)}>
        Open close dialog
      </button>
      <ConfirmActionDialog
        pending={open ? ALL_ACTIONS.close_disposition : null}
        acting={false}
        onClose={() => setOpen(false)}
        onSubmit={over.onSubmit ?? (() => setOpen(false))}
        onSubmitAndNext={
          over.onSubmitAndNext
            ? () => {
                over.onSubmitAndNext?.();
                setOpen(false);
              }
            : undefined
        }
        returnFocusTo={opener}
        focusAfterSubmit={over.focusAfterSubmit}
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
        currentDisposition="none"
        reason=""
        onReasonChange={vi.fn()}
        verdict={over.verdict ?? 'NEEDS_HUMAN'}
        confidence={0.75}
        grading={grading}
        onGradingChange={setGrading}
      />
    </>
  );
}

describe('ConfirmActionDialog', () => {
  it('keeps Cancel / Close / Close & next in a sticky footer outside the scrolling body', () => {
    const onSubmitAndNext = vi.fn();
    render(<Harness startOpen onSubmitAndNext={onSubmitAndNext} />);
    const body = screen.getByTestId('confirm-action-body');
    const footer = screen.getByTestId('confirm-action-footer');
    expect(body.contains(footer)).toBe(false);
    for (const name of ['Cancel', 'Close case', 'Close & next']) {
      expect(within(footer).getByRole('button', { name })).toBeInTheDocument();
    }
    // A disposition is required before either submit is enabled (G1: nothing preselected).
    expect(within(footer).getByRole('button', { name: 'Close & next' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    expect(within(footer).getByRole('button', { name: 'Close & next' })).toBeEnabled();
    fireEvent.click(within(footer).getByRole('button', { name: 'Close & next' }));
    expect(onSubmitAndNext).toHaveBeenCalledTimes(1);
  });

  it('offers only plain Close when the caller cannot advance', () => {
    render(<Harness startOpen />);
    expect(screen.queryByRole('button', { name: 'Close & next' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close case' })).toBeInTheDocument();
  });

  it('compares the AI verdict with the pick: settling a NEEDS_HUMAN hand-off is not a disagreement', () => {
    render(<Harness startOpen />);
    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    const compare = screen.getByTestId('confirm-action-compare');
    expect(compare).toHaveTextContent(/needs human review/i);
    expect(compare).toHaveTextContent(/false positive/i);
    expect(compare).not.toHaveTextContent(/disagree|overrid/i);
  });

  it('returns focus to the control that opened it', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open close dialog' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('opens with focus on the required disposition, not the Resolution select after it (CM-3)', async () => {
    render(<Harness startOpen />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('radio'));
    expect(within(dialog).getByRole('radiogroup').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(within(dialog).getByRole('combobox', { name: 'Resolution (optional)' }));
  });

  it('after "Close & next" focus goes where the caller says (the next queue row), not the departed opener', async () => {
    const nextRow = document.createElement('button');
    nextRow.textContent = 'Next case row';
    document.body.appendChild(nextRow);
    const focusAfterSubmit = vi.fn(() => nextRow);
    render(<Harness onSubmitAndNext={vi.fn()} focusAfterSubmit={focusAfterSubmit} />);
    const opener = screen.getByRole('button', { name: 'Open close dialog' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /false positive/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close & next' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(nextRow).toHaveFocus());
    expect(focusAfterSubmit).toHaveBeenCalledWith(opener, true);
    nextRow.remove();
  });

  it('a cancel never consults the submit focus target: focus returns to the opener', async () => {
    const focusAfterSubmit = vi.fn(() => null);
    render(<Harness onSubmitAndNext={vi.fn()} focusAfterSubmit={focusAfterSubmit} />);
    const opener = screen.getByRole('button', { name: 'Open close dialog' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(focusAfterSubmit).not.toHaveBeenCalled();
  });
});
