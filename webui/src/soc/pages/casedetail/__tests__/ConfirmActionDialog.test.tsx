/**
 * ConfirmActionDialog (Round 12, CM-3 / D15; Round 15, D4.1 to D4.6): the close dialog
 * keeps its actions in a sticky footer outside the scrolling body, offers "Close & next"
 * when the caller can advance the queue, asks the disposition ONCE, records the actions
 * taken, requires a note only when the disposition overrides the AI, keeps the AI rating
 * collapsed, hosts the screenshot drop zone and returns focus to the control that opened it.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  ConfirmActionDialog,
  DISAGREEMENT_NOTE_MISSING,
  DISAGREEMENT_NOTE_REASON,
  type ConfirmActionDialogProps,
} from '../ConfirmActionDialog';
import { ALL_ACTIONS, ACTIONS_TAKEN_MAX, DURABLE_CONTEXT_NOTE, type ActionDef, type WireActionTaken } from '../shared';
import { toggleActionTaken } from '../ActionsTakenField';
import { emptyGradingDraft } from '../grading';

function Harness(
  over: Partial<ConfirmActionDialogProps> & {
    startOpen?: boolean;
    action?: ActionDef;
    onActions?: (next: WireActionTaken[]) => void;
  },
) {
  const opener = React.useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(over.startOpen ?? false);
  const [disposition, setDisposition] = React.useState('');
  const [note, setNote] = React.useState('');
  const [actions, setActions] = React.useState<WireActionTaken[]>([]);
  const [grading, setGrading] = React.useState(emptyGradingDraft());
  return (
    <>
      <button type="button" ref={opener} onClick={() => setOpen(true)}>
        Open close dialog
      </button>
      <ConfirmActionDialog
        pending={open ? (over.action ?? ALL_ACTIONS.close_disposition) : null}
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
        note={note}
        onNoteChange={setNote}
        priority=""
        onPriorityChange={vi.fn()}
        assignee=""
        onAssigneeChange={vi.fn()}
        actionsTaken={actions}
        onActionsTakenChange={(next) => {
          setActions(next);
          over.onActions?.(next);
        }}
        disposition={disposition}
        onDispositionChange={setDisposition}
        currentDisposition="none"
        reason=""
        onReasonChange={vi.fn()}
        verdict={'verdict' in over ? over.verdict : 'NEEDS_HUMAN'}
        confidence={0.75}
        grading={grading}
        onGradingChange={setGrading}
        renderScreenshots={over.renderScreenshots}
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
    // Shown only once a disposition is chosen (D4.4: shown, never asked).
    expect(screen.queryByTestId('confirm-action-compare')).toBeNull();
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

  it('opens with focus on the required disposition (CM-3)', async () => {
    render(<Harness startOpen />);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('radio'));
    expect(within(dialog).getByRole('radiogroup').contains(document.activeElement)).toBe(true);
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

describe('Round 15 close dialog: one classification question (D4.1, D4.6)', () => {
  it('asks the disposition once: no Resolution, no "What actually happened?", no Tags', () => {
    render(<Harness startOpen verdict="TRUE_POSITIVE" />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('radiogroup')).toHaveLength(1);
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByText(/resolution/i)).toBeNull();
    expect(within(dialog).queryByText(/what actually happened/i)).toBeNull();
    expect(within(dialog).queryByLabelText(/tags/i)).toBeNull();
  });

  it('a resolve asks the same question and keeps no separate reason (the note is the reason)', () => {
    render(<Harness startOpen action={ALL_ACTIONS.resolve} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('radiogroup', { name: /disposition/i })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^reason/i)).toBeNull();
    expect(within(dialog).queryByLabelText(/tags/i)).toBeNull();
  });
});

describe('Round 15 close dialog: actions taken (D4.2)', () => {
  it('offers the fixed vocabulary as toggles and reports the choice', () => {
    const onActions = vi.fn();
    render(<Harness startOpen onActions={onActions} />);
    const group = screen.getByRole('group', { name: /actions taken/i });
    const blocked = within(group).getByRole('button', { name: 'Blocked an indicator' });
    expect(blocked).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(blocked);
    expect(onActions).toHaveBeenLastCalledWith(['blocked_indicator']);
    expect(within(group).getByRole('button', { name: 'Blocked an indicator' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: 'Isolated a host' }));
    expect(onActions).toHaveBeenLastCalledWith(['blocked_indicator', 'isolated_host']);
  });

  it('keeps "No action needed" on its own', () => {
    expect(toggleActionTaken(['blocked_indicator', 'isolated_host'], 'no_action_needed')).toEqual(['no_action_needed']);
    expect(toggleActionTaken(['no_action_needed'], 'notified_owner')).toEqual(['notified_owner']);
    expect(toggleActionTaken(['notified_owner'], 'notified_owner')).toEqual([]);
  });

  it(`never records more than ${ACTIONS_TAKEN_MAX}`, () => {
    const eight: WireActionTaken[] = [
      'blocked_indicator',
      'isolated_host',
      'disabled_account',
      'reset_credentials',
      'removed_malware',
      'patched_or_hardened',
      'notified_owner',
      'escalated_externally',
    ];
    expect(toggleActionTaken(eight, 'tuned_detection')).toEqual(eight);
  });

  it('is not offered on an action that ends nothing (escalate)', () => {
    render(<Harness startOpen action={ALL_ACTIONS.escalate} />);
    expect(screen.queryByRole('group', { name: /actions taken/i })).toBeNull();
  });
});

describe('Round 15 close dialog: the note rule (D4.3)', () => {
  it('requires a note when the disposition overrides the AI verdict, and says why', async () => {
    const onSubmit = vi.fn();
    render(<Harness startOpen verdict="TRUE_POSITIVE" onSubmit={onSubmit} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/analyst note \(optional\)/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: /^false positive/i }));
    const note = within(dialog).getByLabelText(/analyst note \(required\)/i);
    expect(within(dialog).getByText(DISAGREEMENT_NOTE_REASON)).toBeInTheDocument();
    expect(note).toHaveAccessibleDescription(`${DISAGREEMENT_NOTE_REASON} ${DURABLE_CONTEXT_NOTE}`);
    expect(screen.getByTestId('confirm-action-status')).toHaveTextContent(DISAGREEMENT_NOTE_MISSING);
    // The note keeps its own prompt: "What did the AI miss?" is the rating's question, asked
    // once, so the override does not ask it twice.
    expect(note).toHaveAttribute('placeholder', 'Add context for the next analyst…');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close case' }));
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(note).toHaveFocus());
    expect(note).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(note, { target: { value: 'The login came from the user’s own VPN.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close case' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('never requires it for a Needs human review resolution or a duplicate', () => {
    const onSubmit = vi.fn();
    const { unmount } = render(<Harness startOpen verdict="NEEDS_HUMAN" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /^true positive/i }));
    expect(screen.getByLabelText(/analyst note \(optional\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close case' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    unmount();

    render(<Harness startOpen verdict="TRUE_POSITIVE" onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /^duplicate/i }));
    expect(screen.getByLabelText(/analyst note \(optional\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close case' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('does not promise precedent where the note is not kept as precedent (a resolve)', () => {
    render(<Harness startOpen verdict="TRUE_POSITIVE" action={ALL_ACTIONS.resolve} />);
    fireEvent.click(screen.getByRole('radio', { name: /^false positive/i }));
    expect(screen.getByLabelText(/analyst note \(required\)/i)).toHaveAccessibleDescription(DISAGREEMENT_NOTE_MISSING);
    expect(screen.queryByText(DISAGREEMENT_NOTE_REASON)).toBeNull();
    expect(screen.queryByText(DURABLE_CONTEXT_NOTE)).toBeNull();
  });
});

describe('Round 15 close dialog: Rate the AI (D4.4)', () => {
  it('keeps the stars in a collapsed "Rate the AI (optional)" disclosure', () => {
    render(<Harness startOpen verdict="TRUE_POSITIVE" />);
    const trigger = screen.getByRole('button', { name: /rate the ai \(optional\)/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Accuracy: 1 of 5' })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Accuracy: 1 of 5' })).toBeInTheDocument();
    // "What did the AI miss?" appears only on an override.
    expect(screen.queryByLabelText(/what did the ai miss/i)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^false positive/i }));
    expect(screen.getByLabelText(/what did the ai miss/i)).toBeInTheDocument();
  });

  it('offers no rating on a case the AI never assessed (no grade would be posted)', () => {
    for (const verdict of [null, '', 'none']) {
      const { unmount } = render(<Harness startOpen verdict={verdict} />);
      expect(screen.getByRole('radiogroup')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /rate the ai/i })).toBeNull();
      unmount();
    }
  });

  it('shows the derived agreement as text, outside the disclosure', () => {
    render(<Harness startOpen verdict="TRUE_POSITIVE" />);
    fireEvent.click(screen.getByRole('radio', { name: /^true positive/i }));
    expect(screen.getByTestId('confirm-action-compare')).toHaveTextContent('Your classification agrees with the AI');
    fireEvent.click(screen.getByRole('radio', { name: /^benign/i }));
    expect(screen.getByTestId('confirm-action-compare')).toHaveTextContent('Your classification overrides the AI (True positive → Benign)');
  });
});

describe('Round 15 close dialog: the screenshot slot (D4.6)', () => {
  it('hosts the drop zone with the dialog as its paste scope', () => {
    let scope: React.RefObject<HTMLElement | null> | null = null;
    render(
      <Harness
        startOpen
        renderScreenshots={(pasteScope) => {
          scope = pasteScope;
          return <div>Drop zone here</div>;
        }}
      />,
    );
    const slot = screen.getByTestId('confirm-action-screenshots');
    expect(within(slot).getByText('Drop zone here')).toBeInTheDocument();
    expect(within(slot).getByText(/screenshots/i)).toBeInTheDocument();
    // The paste scope is the dialog content itself (a pasted image anywhere in it lands).
    expect((scope as React.RefObject<HTMLElement | null> | null)?.current).toBe(
      screen.getByTestId('confirm-action-dialog'),
    );
  });

  it('is not offered on an action that neither ends the case nor records its outcome', () => {
    render(<Harness startOpen action={ALL_ACTIONS.hold} renderScreenshots={() => <div>Drop zone here</div>} />);
    expect(screen.queryByText('Drop zone here')).toBeNull();
  });
});
