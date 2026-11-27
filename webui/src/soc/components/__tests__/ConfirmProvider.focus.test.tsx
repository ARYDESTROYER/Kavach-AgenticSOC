/**
 * ConfirmProvider focus return (WCAG 2.4.3). An imperative confirm unmounts its dialog when
 * it settles, so focus must go back to the control that asked: for a menu item, which is
 * gone once its menu closes, the menu's trigger; when the control is gone, the routed
 * content (#socMain); never the page body.
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { ConfirmProvider, useConfirm } from '../ConfirmDialog';

/** A menu trigger and a menu holding one item that asks; the item's menu closes as it asks. */
function MenuHarness() {
  const confirm = useConfirm();
  const [menuOpen, setMenuOpen] = React.useState(true);
  return (
    <main id="socMain" tabIndex={-1}>
      <button id="actions-trigger" type="button">
        Take action
      </button>
      {menuOpen ? (
        <div role="menu" aria-labelledby="actions-trigger">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void confirm({ title: 'Close the case?' });
              setMenuOpen(false);
            }}
          >
            Close case
          </button>
        </div>
      ) : null}
    </main>
  );
}

/** A plain button that asks. */
function ButtonHarness() {
  const confirm = useConfirm();
  return (
    <main id="socMain" tabIndex={-1}>
      <button type="button" onClick={() => void confirm({ title: 'Delete the view?' })}>
        Delete view
      </button>
    </main>
  );
}

describe('ConfirmProvider returns focus when a confirm settles', () => {
  it('a confirm asked from a menu item returns focus to the menu trigger after Cancel', async () => {
    render(
      <ConfirmProvider>
        <MenuHarness />
      </ConfirmProvider>,
    );
    const item = screen.getByRole('menuitem', { name: 'Close case' });
    item.focus();
    fireEvent.click(item);
    await screen.findByText('Close the case?');
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Take action' })));
  });

  it('a confirm asked from a button returns focus to that button', async () => {
    render(
      <ConfirmProvider>
        <ButtonHarness />
      </ConfirmProvider>,
    );
    const ask = screen.getByRole('button', { name: 'Delete view' });
    ask.focus();
    fireEvent.click(ask);
    await screen.findByText('Delete the view?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(ask));
  });

  it('focus goes to the routed content when the asking control is gone', async () => {
    let removeAsker: (() => void) | null = null;
    function Remover() {
      const confirm = useConfirm();
      const [shown, setShown] = React.useState(true);
      removeAsker = () => setShown(false);
      return (
        <main id="socMain" tabIndex={-1}>
          {shown ? (
            <button type="button" onClick={() => void confirm({ title: 'Retire the rule?' })}>
              Retire rule
            </button>
          ) : null}
        </main>
      );
    }
    render(
      <ConfirmProvider>
        <Remover />
      </ConfirmProvider>,
    );
    const ask = screen.getByRole('button', { name: 'Retire rule' });
    ask.focus();
    fireEvent.click(ask);
    await screen.findByText('Retire the rule?');
    React.act(() => removeAsker?.());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('socMain')));
  });
});

