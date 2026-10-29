/**
 * ConfirmDialog — gating spec (W0-B1). The load-bearing behavior: the destructive
 * action only fires when the operator explicitly confirms, and Cancel does not
 * fire it. Also covers the imperative promise API resolving true/false.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { ConfirmDialog, ConfirmProvider, useConfirm } from '../ConfirmDialog';

describe('ConfirmDialog (controlled)', () => {
  it('can withhold an unsafe confirm action while retaining an explicit return path', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        title="Save first"
        cancelLabel="Return to work"
        hideConfirm
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Return to work' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });
  it('runs onConfirm only when Confirm is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
        onCancel={onCancel}
        title="Delete role?"
        confirmLabel="Delete"
        destructive
      />,
    );
    expect(screen.getByText('Delete role?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('runs onCancel (and not onConfirm) when Cancel is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={() => {}} onConfirm={onConfirm} onCancel={onCancel} title="Sure?" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // The destructive dismiss-guard is now delegated to AlertDialogContent's
  // `dismissible` switch (dismissible={!destructive}) — the single source of truth —
  // rather than hand-rolled onEscapeKeyDown/onPointerDownOutside handlers.
  it('does NOT dismiss a destructive gate on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} onConfirm={() => {}} title="Delete role?" destructive />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('DOES dismiss a non-destructive dialog on Escape', () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} onConfirm={() => {}} title="Sure?" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('useConfirm (imperative)', () => {
  function Harness({ onResult }: { onResult: (v: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () => {
          const ok = await confirm({ title: 'Proceed?', confirmLabel: 'Yes' });
          onResult(ok);
        }}
      >
        ask
      </button>
    );
  }

  it('resolves true when confirmed', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await screen.findByText('Proceed?');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('resolves false when cancelled', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ask' }));
    await screen.findByText('Proceed?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });
});

describe('ConfirmDialog async confirm (busy, Round 14)', () => {
  /** A caller that runs async work on confirm and closes the dialog when it ends. */
  function AsyncHost({ work, onClosed }: { work: () => Promise<void>; onClosed?: () => void }) {
    const [open, setOpen] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClosed?.();
        }}
        busy={busy}
        title="Remove this source?"
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          setBusy(true);
          void work()
            .then(() => {
              setOpen(false);
              onClosed?.();
            })
            .finally(() => setBusy(false));
        }}
      />
    );
  }

  it('stays open with the action busy until the work ends, then the caller closes it', async () => {
    let finish: () => void = () => undefined;
    const work = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onClosed = vi.fn();
    render(<AsyncHost work={work} onClosed={onClosed} />);

    const action = screen.getByRole('button', { name: 'Remove' });
    act(() => action.focus());
    fireEvent.click(action);
    expect(work).toHaveBeenCalledTimes(1);
    // Still open while the work runs: the confirm is busy and inert, Cancel waits.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(action).toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    // Busy, not disabled: a browser moves focus off a button that becomes disabled, which
    // would leave a keyboard user outside the dialog while the work runs.
    expect(action).toBeEnabled();
    expect(document.activeElement).toBe(action);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveAttribute('aria-disabled', 'true');
    expect(cancel).toBeEnabled();
    // A second click cannot start the work twice.
    fireEvent.click(action);
    expect(work).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('ignores Cancel while the work runs: neither onCancel nor onOpenChange fires', () => {
    const onCancel = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        busy
        onOpenChange={onOpenChange}
        onCancel={onCancel}
        onConfirm={vi.fn()}
        title="Restore this version?"
        confirmLabel="Restore"
      />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    act(() => cancel.focus());
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(document.activeElement).toBe(cancel);
  });

  it('marks nothing busy when the work is not running', () => {
    render(
      <ConfirmDialog
        open
        busy={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        title="Restore this version?"
        confirmLabel="Restore"
      />,
    );
    for (const name of ['Restore', 'Cancel']) {
      const button = screen.getByRole('button', { name });
      expect(button).not.toHaveAttribute('aria-disabled');
      expect(button).not.toHaveAttribute('aria-busy');
    }
  });

  it('cannot be dismissed with Escape while the work runs, even when not destructive', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        busy
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
        title="Restore this version?"
        confirmLabel="Restore"
      />,
    );
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('keeps the dialog open after confirm when busy is given, so a failure can be shown in place', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        busy={false}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        title="Restore this version?"
        confirmLabel="Restore"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  it('still closes by itself on confirm when busy is not given', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} onConfirm={vi.fn()} title="Delete role?" confirmLabel="Delete" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
