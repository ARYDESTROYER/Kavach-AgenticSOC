/**
 * Start runbook (Round 14, SPEC §4.10.11): the best match is pre-selected with its
 * explanation, then Other matches, Fallback and All published runbooks; a preview of the
 * selected runbook's phases; "Suggest a runbook" adds an entry a person must select; the
 * note goes with the attach. A runbook never closes a case. Also its states (loading,
 * nothing to start, a failed read), the keyboard (one radio group, arrow keys) and the
 * phone structure (the selected entry carries its phases when there is no preview).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  getRunbookCandidates: vi.fn(),
  getRunbookDetail: vi.fn(),
  attachRunbook: vi.fn(),
  suggestRunbook: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-runbooks')>();
  return { ...actual, ...api };
});

import type { RunbookCandidate } from '@/lib/types-runbooks';
import { StartRunbookDialog } from '../StartRunbookDialog';
import { DEFINITION, makeRun } from './fixtures';

function candidate(partial: Partial<RunbookCandidate> & Pick<RunbookCandidate, 'id' | 'title' | 'group'>): RunbookCandidate {
  return {
    summary: '',
    version: 1,
    origin: 'builtin',
    phases: ['triage', 'investigate'],
    explanation: null,
    reason: null,
    ...partial,
  };
}

const CANDIDATES: RunbookCandidate[] = [
  candidate({
    id: 'brute-force',
    title: 'Brute force and password spray',
    group: 'best',
    version: 4,
    explanation: { tier: 3, matched: [{ criterion: 'rule_ids', value: ['auth-failures'] }], missed: [], tie: false },
  }),
  candidate({ id: 'account-takeover', title: 'Account takeover', group: 'other' }),
  candidate({ id: 'generic', title: 'Generic incident', group: 'fallback' }),
  candidate({ id: 'phishing', title: 'Phishing', group: 'all' }),
];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRunbookCandidates.mockResolvedValue({ candidates: CANDIDATES });
  api.getRunbookDetail.mockResolvedValue({ live: { definition: DEFINITION } });
  api.suggestRunbook.mockResolvedValue({ candidate: null, estimate: null });
});

function renderDialog(over: Partial<React.ComponentProps<typeof StartRunbookDialog>> = {}) {
  const onStarted = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <StartRunbookDialog
      open
      onOpenChange={onOpenChange}
      caseId="case-1"
      caseLine="CASE-000214 · Password spray"
      aiSuggest
      attachedIds={[]}
      onStarted={onStarted}
      {...over}
    />,
  );
  return { onStarted, onOpenChange };
}

describe('StartRunbookDialog', () => {
  it('groups the runbooks and pre-selects the best match with its preview', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    for (const group of ['Best match', 'Other matches', 'Fallback', 'All published runbooks']) {
      expect(await within(dialog).findByText(group)).toBeInTheDocument();
    }
    const best = within(dialog).getByRole('radio', { name: /Brute force and password spray, Best match/ });
    expect(best).toBeChecked();
    // The preview lists the selected runbook's phases with their step counts.
    const phases = await within(dialog).findByRole('list', { name: 'Phases' });
    expect(phases).toHaveTextContent('Triage');
    expect(phases).toHaveTextContent('Contain');
    expect(dialog).toHaveTextContent('A runbook never closes a case.');
    expect(dialog.textContent).not.toMatch(/—|playbook/i);
  });

  it('starts the selected runbook with the note and hands the run back', async () => {
    const user = userEvent.setup();
    const run = makeRun({ runbook_id: 'account-takeover', title: 'Account takeover', attached_by: 'person', attached_actor: 'ben' });
    api.attachRunbook.mockResolvedValue({ already_attached: false, run, progress: null, revision: 4 });
    const { onStarted, onOpenChange } = renderDialog();
    await user.click(await screen.findByRole('radio', { name: /Account takeover, Other matches/ }));
    await user.type(screen.getByLabelText('Note for the team (optional)'), 'The VPN owner asked for it.');
    await user.click(screen.getByRole('button', { name: 'Start runbook' }));
    expect(api.attachRunbook).toHaveBeenCalledWith('case-1', { runbook_id: 'account-takeover', note: 'The VPN owner asked for it.' });
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ run })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('adds the AI suggestion as an entry a person must select', async () => {
    const user = userEvent.setup();
    api.suggestRunbook.mockImplementation((_case: string, opts?: { dryRun?: boolean }) =>
      Promise.resolve(
        opts?.dryRun
          ? { candidate: null, estimate: null }
          : { candidate: candidate({ id: 'phishing', title: 'Phishing', group: 'suggested', reason: 'The sign-ins began after a lure email.' }), estimate: null },
      ),
    );
    renderDialog();
    await screen.findByText('Best match');
    await user.click(screen.getByRole('button', { name: 'Suggest a runbook' }));
    expect(await screen.findByText('Suggested by the AI')).toBeInTheDocument();
    expect(screen.getByText('The AI suggested Phishing. Select it to start it.')).toBeInTheDocument();
    // Never selected for the person, and listed once.
    expect(screen.getByRole('radio', { name: /Brute force and password spray/ })).toBeChecked();
    expect(screen.getAllByRole('radio', { name: /^Phishing/ })).toHaveLength(1);
  });

  it('shows the refusal when the start fails and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api');
    api.attachRunbook.mockRejectedValue(
      new ApiError(409, 'Runbooks are turned off.', { detail: { code: 'runbook_state', message: 'Runbooks are turned off.' } }),
    );
    const { onOpenChange } = renderDialog();
    await screen.findByText('Best match');
    await user.click(screen.getByRole('button', { name: 'Start runbook' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Runbooks are turned off.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('says it is loading until the runbooks are listed', async () => {
    let answer: (value: { candidates: RunbookCandidate[] }) => void = () => undefined;
    api.getRunbookCandidates.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Loading runbooks')).toHaveAttribute('aria-busy', 'true');
    // Nothing is selected yet, so Start runbook says it cannot start.
    expect(within(dialog).getByRole('button', { name: 'Start runbook' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => answer({ candidates: CANDIDATES }));
    expect(within(dialog).queryByText('Loading runbooks')).toBeNull();
  });

  it('says so when no published runbook can start on the case', async () => {
    api.getRunbookCandidates.mockResolvedValue({ candidates: [] });
    renderDialog();
    expect(await screen.findByText('No published runbook can be started on this case.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start runbook' })).toHaveAttribute('aria-disabled', 'true');
  });

  it("shows the server's sentence when the runbooks cannot be listed", async () => {
    const { ApiError } = await import('@/lib/api');
    api.getRunbookCandidates.mockRejectedValue(
      new ApiError(503, 'The runbook library is unavailable.', {
        detail: { code: 'runbook_unavailable', message: 'The runbook library is unavailable.' },
      }),
    );
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('The runbook library is unavailable.');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('moves the choice with the arrow keys inside one radio group', async () => {
    const user = userEvent.setup();
    renderDialog();
    const best = await screen.findByRole('radio', { name: /Brute force and password spray, Best match/ });
    expect(best).toBeChecked();
    act(() => best.focus());
    // Held down as a person presses it (Radix moves focus a tick after keydown and checks
    // the radio it lands on while the arrow key is still down).
    await user.keyboard('{ArrowDown>}');
    const next = screen.getByRole('radio', { name: /Account takeover, Other matches/ });
    await waitFor(() => expect(next).toBeChecked());
    await user.keyboard('{/ArrowDown}');
    expect(document.activeElement).toBe(next);
    // One tab stop for the whole list (roving focus).
    const stops = screen.getAllByRole('radio').filter((r) => r.getAttribute('tabindex') !== '-1');
    expect(stops).toHaveLength(1);
  });

  it('lists the selected runbook phases under its own entry for a narrow dialog with no preview', async () => {
    renderDialog();
    await screen.findByText('Best match');
    // jsdom has no container queries: both are in the DOM, the entry line hidden by CSS from 44rem.
    const line = document.querySelector('[data-start-phases]');
    expect(line).toHaveTextContent('Triage, Investigate');
    expect(line?.className).toContain('@[44rem]/pick:hidden');
    // Only the selected entry carries it.
    expect(document.querySelectorAll('[data-start-phases]')).toHaveLength(1);
    // The dialog takes the full height on a phone and the footer reads before its buttons there.
    const dialog = screen.getByTestId('start-runbook-dialog');
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog.textContent).not.toMatch(/—|playbook/i);
  });
});
