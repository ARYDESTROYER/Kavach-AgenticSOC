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
 *  - the restore confirmation hands focus back to the row's Restore button, which stays
 *    focusable (busy, not disabled) while the restore runs (SPEC §3.3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

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
  api: {
    rules: { versions: versionsSpy, rollback: rollbackSpy, preview: vi.fn() },
    caseAction: caseActionSpy,
    chat: chatSpy,
  },
}));

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

    // Confirmed: the restore runs with the button busy but still focusable.
    let finish!: () => void;
    rollbackSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ ok: true, kind: 'detection', rule_id: 'ssh', restored_from: 'rv-1', rule: {} });
        }),
    );
    fireEvent.click(restore);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^restore$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(restore));
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    // A second press while the restore runs does nothing.
    fireEvent.click(restore);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => finish());
    await waitFor(() => expect(restore).not.toHaveAttribute('aria-disabled'));
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
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
