/**
 * RuleVersionLedger spec (Round-5 G6, R5): the immutable version list, red/green
 * inline diff + one-click rollback.
 *
 * Proves:
 *  - the ledger renders every version newest-first with its REAL per-row state
 *    (the newest = "Current", older = "Superseded", a rollback = "Rollback"), NOT a
 *    hardcoded "Active" on every row (bug #12),
 *  - selecting a version shows the dep-free field diff vs the current config,
 *  - "Restore this version" calls the RB rollback endpoint with the right args and
 *    refetches: a CONFIG operation, never a close;
 *  - the restore confirmation hands focus back to the row's Restore button (SPEC §3.3);
 *  - the confirmation is an async confirm (ConfirmDialog `busy`, Round 14): it stays open
 *    while the restore runs, its Restore keeps focus and a second press does nothing, it
 *    closes as soon as the restore is written (the ledger reloads outside it, so a slow
 *    read never holds it open), and a failure stays in the dialog to retry;
 *  - a restore is announced, and a ledger read that fails after it says so with a Retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';
import { AnnouncerProvider } from '@/soc/components/announcer';

// `vi.hoisted` lets these spies be referenced inside the hoisted `vi.mock` factory.
const { versionsSpy, rollbackSpy, caseActionSpy, chatSpy } = vi.hoisted(() => ({
  versionsSpy: vi.fn(),
  rollbackSpy: vi.fn(async () => ({
    ok: true,
    kind: 'detection',
    rule_id: 'ssh',
    restored_from: 'rv-1',
    rule: {},
  })),
  // negative-assert the mutating/LLM paths never fire from the ledger.
  caseActionSpy: vi.fn(),
  chatSpy: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  // `LoadError` reads a failure through `errorMessage`, which checks for this class.
  ApiError: class ApiError extends Error {},
  api: {
    rules: { versions: versionsSpy, rollback: rollbackSpy, preview: vi.fn() },
    caseAction: caseActionSpy,
    chat: chatSpy,
  },
}));

import { ApiError } from '@/lib/api';
import { RuleVersionLedger } from '../RuleVersionLedger';

const V_CURRENT = {
  id: 'rv-2',
  kind: 'detection',
  rule_id: 'ssh',
  config: { name: 'ssh', enabled: true, correlation: { n: 10 } },
  action: 'update',
  actor: 'alice',
  summary: 'raised n to 10',
  created_at: '2026-07-02T10:00:00Z',
  rolled_back_to: null,
};
const V_OLD = {
  id: 'rv-1',
  kind: 'detection',
  rule_id: 'ssh',
  config: { name: 'ssh', enabled: true, correlation: { n: 5 } },
  action: 'create',
  actor: 'bob',
  summary: 'initial',
  created_at: '2026-07-01T09:00:00Z',
  rolled_back_to: null,
};

function renderLedger(canManage = true) {
  return render(
    <TooltipProvider>
      <RuleVersionLedger kind="detection" ruleId="ssh" canManage={canManage} />
    </TooltipProvider>,
  );
}

describe('RuleVersionLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // newest-first, exactly as the backend returns it
    versionsSpy.mockResolvedValue({ kind: 'detection', rule_id: 'ssh', versions: [V_CURRENT, V_OLD] });
  });

  it('renders versions newest-first with their REAL per-row state (bug #12)', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-2')).toBeInTheDocument());

    // the newest version is the live baseline ("Current"); the older one is "Superseded"
    // — NOT a hardcoded "Active" on every row.
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();

    // author + summary render plainly
    expect(screen.getByText(/by alice/)).toBeInTheDocument();
    expect(screen.getByText(/by bob/)).toBeInTheDocument();
    expect(screen.getByText('initial')).toBeInTheDocument();
  });

  it('shows a red/green field diff of the selected version vs current', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());

    // open the diff for the OLD version (n=5) vs current (n=10)
    const oldRow = screen.getByTestId('rule-version-rv-1');
    fireEvent.click(oldRow.querySelector('button[aria-expanded="false"]')!);

    await waitFor(() => expect(screen.getByTestId('rule-diff')).toBeInTheDocument());
    // the changed nested field surfaces with both values
    expect(screen.getByText('correlation.n')).toBeInTheDocument();
  });

  it('one-click rollback calls the RB rollback endpoint (config write, never a close)', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());

    // restore the older (non-current) version → opens the confirm gate
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    // confirm
    fireEvent.click(screen.getByRole('button', { name: /^restore$/i }));

    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledTimes(1));
    expect(rollbackSpy).toHaveBeenCalledWith('detection', 'ssh', 'rv-1');
    // it refetches the ledger after a rollback
    expect(versionsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // ⛔ never a case-mutating / LLM path
    expect(caseActionSpy).not.toHaveBeenCalled();
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("returns focus to the row's Restore button when the confirmation closes (SPEC §3.3)", async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    const restore = within(screen.getByTestId('rule-version-rv-1')).getByRole('button', {
      name: /restore this version/i,
    });

    // Cancel.
    restore.focus();
    fireEvent.click(restore);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(restore));

    // Confirmed: the dialog stays open while the restore runs; it closes once it is done.
    let finish!: () => void;
    rollbackSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ ok: true, kind: 'detection', rule_id: 'ssh', restored_from: 'rv-1', rule: {} });
        }),
    );
    fireEvent.click(restore);
    await screen.findByRole('alertdialog');
    expect(restore).not.toHaveAttribute('aria-disabled');
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: /^restore$/i });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    finish();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(restore));
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmation open and busy while the restore runs: focus stays, a second press does nothing', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    let finish!: () => void;
    rollbackSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ ok: true, kind: 'detection', rule_id: 'ssh', restored_from: 'rv-1', rule: {} });
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /^restore$/i });
    confirm.focus();
    fireEvent.click(confirm);

    // Busy, not disabled: the same button keeps focus and names its state.
    const busy = await within(dialog).findByRole('button', { name: /^restoring$/i });
    expect(busy).toBe(confirm);
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).not.toBeDisabled();
    expect(document.activeElement).toBe(busy);
    // A second press, Cancel and Escape do nothing while the restore runs.
    fireEvent.click(busy);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(rollbackSpy).toHaveBeenCalledTimes(1);

    const reads = versionsSpy.mock.calls.length;
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The ledger is read again once after the restore.
    expect(versionsSpy.mock.calls.length).toBe(reads + 1);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('closes as soon as the restore is written, while the ledger read is still out, and announces it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <TooltipProvider>
          <AnnouncerProvider>
            <RuleVersionLedger kind="detection" ruleId="ssh" canManage />
          </AnnouncerProvider>
        </TooltipProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
      const restore = within(screen.getByTestId('rule-version-rv-1')).getByRole('button', {
        name: /restore this version/i,
      });
      let readBack!: () => void;
      versionsSpy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            readBack = () =>
              resolve({
                kind: 'detection',
                rule_id: 'ssh',
                versions: [
                  { ...V_OLD, id: 'rv-3', action: 'rollback', rolled_back_to: 'rv-1', created_at: '2026-07-03T08:00:00Z' },
                  V_CURRENT,
                  V_OLD,
                ],
              });
          }),
      );
      restore.focus();
      fireEvent.click(restore);
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^restore$/i }));

      // Written: the dialog has closed and focus is back on the row's Restore, though the
      // ledger has not been read back yet.
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(restore));
      expect(screen.queryByTestId('rule-version-rv-3')).toBeNull();
      // A screen reader hears that it worked, not only the button's name.
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(screen.getByTestId('live-announcer')).toHaveTextContent(
        'Version restored. It is now the live rule config.',
      );

      await act(async () => readBack());
      expect(await screen.findByTestId('rule-version-rv-3')).toBeInTheDocument();
      expect(document.activeElement).toBe(restore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when the ledger could not be read back after a restore, and retries the read', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    versionsSpy.mockRejectedValueOnce(new Error('Gateway timeout'));
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^restore$/i }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText("Couldn't refresh version history")).toBeInTheDocument();
    expect(screen.getByText('Gateway timeout')).toBeInTheDocument();
    // The versions it had stay on screen.
    expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText("Couldn't refresh version history")).toBeNull());
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('says the live config was not changed when a failed restore carries no reason', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    rollbackSpy.mockRejectedValueOnce(new ApiError(''));
    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }));

    expect(await within(dialog).findByText("Couldn't restore this version")).toBeInTheDocument();
    expect(within(dialog).getByText('The live rule config was not changed.')).toBeInTheDocument();
  });

  it('shows a failed restore in the confirmation, which retries on Restore and clears on Cancel', async () => {
    const onRolledBack = vi.fn();
    render(
      <TooltipProvider>
        <RuleVersionLedger kind="detection" ruleId="ssh" canManage onRolledBack={onRolledBack} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    const restore = within(screen.getByTestId('rule-version-rv-1')).getByRole('button', {
      name: /restore this version/i,
    });
    rollbackSpy.mockRejectedValueOnce(new Error('The rule store is read-only.'));
    fireEvent.click(restore);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }));

    // The failure stays where the operator started the restore.
    expect(await within(dialog).findByText("Couldn't restore this version")).toBeInTheDocument();
    expect(within(dialog).getByText('The rule store is read-only.')).toBeInTheDocument();
    expect(onRolledBack).not.toHaveBeenCalled();
    const retry = within(dialog).getByRole('button', { name: /^restore$/i });
    expect(retry).not.toHaveAttribute('aria-disabled');

    // Restore tries again; this time it succeeds and the dialog closes.
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(rollbackSpy).toHaveBeenCalledTimes(2);
    expect(onRolledBack).toHaveBeenCalledWith('rv-1');
    expect(screen.queryByText("Couldn't restore this version")).toBeNull();

    // A failure then Cancel: the error leaves with the dialog and focus returns to the row.
    rollbackSpy.mockRejectedValueOnce(new Error('Still read-only.'));
    fireEvent.click(restore);
    const again = await screen.findByRole('alertdialog');
    fireEvent.click(within(again).getByRole('button', { name: /^restore$/i }));
    await within(again).findByText('Still read-only.');
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByText('Still read-only.')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(restore));
  });

  it('read-only viewers see history but no restore action', async () => {
    renderLedger(false);
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /restore this version/i })).not.toBeInTheDocument();
  });
  it('lists versions as hairline rows with quiet state dots, not bordered cards (Round 14)', async () => {
    renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    const list = screen.getByTestId('rule-version-ledger');
    expect(list.className).toContain('divide-y');
    for (const id of ['rule-version-rv-1', 'rule-version-rv-2']) {
      expect(screen.getByTestId(id).className).not.toMatch(/(^|\s)border(\s|$)|bg-card/);
    }
    expect(screen.getByText('Current').closest('[data-status-tone]')).toHaveAttribute('data-status-tone', 'success');
    expect(screen.getByText('Superseded').closest('[data-status-tone]')).toHaveAttribute('data-status-tone', 'neutral');
  });

  it('names the compare action and its heading in sentence case, without em dashes', async () => {
    const { container } = renderLedger();
    await waitFor(() => expect(screen.getByTestId('rule-version-rv-1')).toBeInTheDocument());
    const oldRow = screen.getByTestId('rule-version-rv-1');
    fireEvent.click(within(oldRow).getByRole('button', { name: 'Compare with current' }));
    expect(within(oldRow).getByText('What restoring this version changes')).toBeInTheDocument();
    expect(within(oldRow).getByRole('button', { name: 'Hide changes' })).toHaveAttribute('aria-expanded', 'true');
    expect(container.innerHTML).not.toMatch(/uppercase|tracking-wider/);
    expect(container.textContent ?? '').not.toContain('\u2014');
    // The row's own words carry no arrow (the diff below may show one between values).
    expect(within(oldRow).getByText(/by bob/).textContent ?? '').not.toContain('\u2192');
  });
});
