/**
 * CaseHoverCard never floats above a case sheet or dialog (Round 12, CM-9).
 *
 * Opening a case from its row (Scans, Cases) used to leave the row's preview card open
 * ON TOP of the modal sheet the click had just opened, where it swallowed the first
 * Escape. The card now closes when its trigger is activated, refuses to re-open for a
 * moment after, and refuses any open while a modal dialog that does not contain the
 * trigger is on screen — for every consumer, whether or not it passes `forceClosed`.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CaseHoverCard } from '../CaseHoverCard';
import type { Case } from '@/lib/types';

const CASE = { case_id: 'c1', status: 'open', title: 'Preview title' } as unknown as Case;

function renderCard() {
  return render(
    <CaseHoverCard case={CASE} openDelay={0} closeDelay={0}>
      <button type="button" data-testid="trg">
        Case c1
      </button>
    </CaseHoverCard>,
  );
}

describe('CaseHoverCard and modal surfaces (CM-9)', () => {
  it('opens on focus when nothing modal is on screen', async () => {
    renderCard();
    fireEvent.focus(screen.getByTestId('trg'));
    expect(await screen.findByText('Preview title')).toBeInTheDocument();
  });

  it('refuses to open while a modal dialog that does not contain the trigger is open', async () => {
    renderCard();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    try {
      fireEvent.focus(screen.getByTestId('trg'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByText('Preview title')).toBeNull();
    } finally {
      dialog.remove();
    }
  });

  it('closes when its trigger is activated and does not pop back over the sheet', async () => {
    renderCard();
    const trigger = screen.getByTestId('trg');
    fireEvent.focus(trigger);
    expect(await screen.findByText('Preview title')).toBeInTheDocument();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByText('Preview title')).toBeNull());
    // A leaked open timer (Radix arms one on focus) cannot reopen it right after.
    fireEvent.focus(trigger);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText('Preview title')).toBeNull();
  });
});
