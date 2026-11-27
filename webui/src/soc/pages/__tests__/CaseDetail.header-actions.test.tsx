/**
 * CaseDetail: the header's actions (Round 15, SPEC D8.2; formerly the Wave-5 "footer"
 * test, renamed with D8.7 since the actions moved into the sticky header in Round 12).
 *
 * The header offers:
 *
 *   1. ONE primary contextual action per status (the D8.2 table in `actionPlanForStatus`:
 *      Acknowledge when new, Close case while open, investigating or needs_human, Resume
 *      when held, Mark resolved when escalated, Close case when resolved, Reopen when
 *      closed).
 *   2. NO secondary "Close case" button: C still opens the close dialog, and Close case is
 *      in Take action whenever the status allows it.
 *   3. Take action holding every other verb, and More options holding the case link.
 *
 * The unified Close-with-disposition flow POSTs the EXISTING `close` verb with the chosen
 * `disposition` (the backend still runs the real decide()/apply(), #3), never a new verb.
 * We mix a live mount (the DOM structure and the close dialog wire) with a source
 * assertion (the never-invent-a-verb #3 guarantee) and the pure plan table.
 */
import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { caseActionExec } = vi.hoisted(() => ({ caseActionExec: vi.fn() }));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  const openCase = {
    case_id: 'case-77',
    case_number: 'TLSOC-077',
    title: 'Beacon to known C2',
    status: 'open',
    disposition: null,
    verdict: 'needs_human',
    confidence: 0.5,
    risk_score: 72,
    created_at: '2026-06-29T00:00:00Z',
    updated_at: '2026-06-29T01:00:00Z',
    escalation_level: 0,
    evidence: [],
    assets: {},
    iocs: [],
    tags: [],
    comments: [],
  };
  return {
    setUnauthorizedHandler: vi.fn(),
    api: {
      getCase: ok(openCase),
      get: ok({ case_id: 'case-77', stages: [], total: 0 }),
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      caseActionExec,
      cases: {
        threatContext: ok(null),
        notify: ok({ sent: [] }),
      },
    },
  };
});

import { AuthProvider } from '../../auth';
import { RouterProvider } from '../../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../CaseDetail';
import { actionPlanForStatus, planCloseAction } from '../casedetail/shared';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

// COUPLING-D: the action model (`ALL_ACTIONS`, incl. the `close_disposition` →
// `close` wire mapping) lives in `casedetail/shared.tsx`; the `runAction` POST
// (which posts `pending.wireAction ?? pending.key`) stays in the orchestrator
// `CaseDetail.tsx`. Read both so the never-invent-a-verb #3 guarantee is pinned.
const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');
const sharedSrc = readFileSync(path.resolve(__dirname, '..', 'casedetail', 'shared.tsx'), 'utf8');

describe('actionPlanForStatus: the D8.2 primary-action table', () => {
  it.each([
    ['new', 'acknowledge', ['close_disposition', 'escalate', 'resolve', 'hold']],
    ['', 'acknowledge', ['close_disposition', 'escalate', 'resolve', 'hold']],
    ['open', 'close_disposition', ['escalate', 'acknowledge', 'resolve', 'hold']],
    ['investigating', 'close_disposition', ['escalate', 'acknowledge', 'resolve', 'hold']],
    ['needs_human', 'close_disposition', ['escalate', 'acknowledge', 'resolve', 'hold']],
    ['on_hold', 'resume', ['close_disposition', 'resolve', 'escalate']],
    ['escalated', 'resolve', ['close_disposition', 'deescalate', 'hold']],
    ['resolved', 'close_disposition', ['set_disposition', 'reopen']],
    ['closed', 'reopen', ['set_disposition']],
  ] as const)('%s: the primary is %s, the rest are in Take action', (status, primary, overflow) => {
    const plan = actionPlanForStatus(status);
    expect(plan.primary.key).toBe(primary);
    expect(plan.overflow.map((a) => a.key)).toEqual(overflow);
    // Every verb is offered once, and the plan has no secondary button any more.
    const keys = [plan.primary.key, ...plan.overflow.map((a) => a.key)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(plan).sort()).toEqual(['overflow', 'primary']);
  });

  it('offers the close-with-disposition action wherever the server allows a close', () => {
    for (const status of ['new', 'open', 'investigating', 'needs_human', 'on_hold', 'escalated', 'resolved']) {
      expect(planCloseAction(actionPlanForStatus(status))?.wireAction).toBe('close');
    }
    expect(planCloseAction(actionPlanForStatus('closed'))).toBeNull();
  });

  it('no longer defines the unused close and confirm_fp actions (D8.7)', () => {
    expect(sharedSrc).not.toMatch(/^\s*close:\s*\{/m);
    expect(sharedSrc).not.toMatch(/^\s*confirm_fp:\s*\{/m);
    expect(sharedSrc).not.toMatch(/HeadlinePanel/);
  });
});

describe('CaseDetail header: one primary action, Take action and More options', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
  });

  it('shows exactly ONE primary action (Close case on an open case) and no secondary Close', async () => {
    renderWithProviders(<CaseDetail caseId="case-77" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Beacon to known C2')).toBeInTheDocument(), {
      timeout: 5000,
    });

    const primary = screen.getByTestId('case-primary-action');
    expect(primary).toHaveTextContent('Close case');
    expect(primary).toHaveAttribute('aria-keyshortcuts', 'C');
    // Exactly one "Close case" control: the primary. Escalate moved to Take action.
    expect(screen.getAllByRole('button', { name: /^close case/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Escalate/i })).toBeNull();

    expect(screen.getByRole('button', { name: /^Take action/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();

    // The retired standalone "Confirm false positive" / "Set disposition" buttons stay gone.
    expect(screen.queryByRole('button', { name: /Confirm false positive/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Set disposition/i })).toBeNull();

    // Panel-dismiss invariant preserved: only the SheetContent X is named "Close".
    expect(screen.getAllByRole('button', { name: /^close$/i })).toHaveLength(1);
  });

  it('keeps Escalate one menu item away in Take action', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CaseDetail caseId="case-77" onClose={vi.fn()} />);
    await screen.findByText('Beacon to known C2');
    await user.click(screen.getByRole('button', { name: /^Take action/i }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^Escalate/ })).toHaveAttribute('aria-keyshortcuts', 'E');
    // Take action holds every OTHER verb (D8.2): the primary (Close case here) is the
    // header button and is not repeated in the menu, whose verbs follow the plan's order.
    expect(within(menu).queryByRole('menuitem', { name: /^Close case/ })).toBeNull();
    const verbs = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '')
      .filter((text) => /^(Escalate|Acknowledge|Mark resolved|Put on hold)/.test(text))
      .map((text) => text.replace(/[A-Z]$/, ''));
    expect(verbs).toEqual(['Escalate', 'Acknowledge & investigate', 'Mark resolved', 'Put on hold']);
    // "Ask about this case" names the Chat tab's shortcut (six tabs since Round 16: Alt+6).
    const ask = within(menu).getByRole('menuitem', { name: /Ask about this case/ });
    expect(ask).toHaveTextContent('Alt 6');
    expect(ask).toHaveAttribute('aria-keyshortcuts', 'Alt+6');
  });

  it('C opens the close dialog with no secondary button on screen', async () => {
    renderWithProviders(<CaseDetail caseId="case-77" presentation="embedded" onClose={vi.fn()} />);
    await screen.findByText('Beacon to known C2');
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 'c' });
    const dialog = await screen.findByTestId('confirm-action-dialog');
    expect(within(dialog).getByText('Close with a disposition')).toBeInTheDocument();
  });

  it('the unified Close dialog POSTs the existing `close` verb + the chosen disposition', async () => {
    caseActionExec.mockResolvedValue({
      case_id: 'case-77',
      status: 'closed',
      disposition: 'false_positive',
    });
    renderWithProviders(<CaseDetail caseId="case-77" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Beacon to known C2')).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Open the unified close dialog from the primary action.
    fireEvent.click(screen.getByTestId('case-primary-action'));
    const dialog = await screen.findByRole('dialog', { name: 'Close with a disposition' });

    // The submit button is disabled until a disposition is chosen (mandatory).
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    expect(submit).toBeDisabled();

    // Pick a disposition (Round 12: a radio-card picker with definitions), then submit.
    fireEvent.click(within(dialog).getByRole('radio', { name: /False positive/i }));
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    const [, input] = caseActionExec.mock.calls[0];
    // EXISTING verb (never a new one) + the chosen disposition: #3, the backend close
    // still runs decide()/apply().
    expect(input.action).toBe('close');
    expect(input.disposition).toBe('false_positive');
  });

  it('never invents a new action verb: close_disposition maps to the wire `close`', () => {
    // The UI-only unified kind carries wireAction: 'close' (in the shared action
    // model), and runAction (in the orchestrator) posts `pending.wireAction ??
    // pending.key`.
    expect(sharedSrc).toMatch(/close_disposition:\s*\{[\s\S]*?wireAction:\s*'close'/);
    expect(src).toMatch(/action:\s*pending\.wireAction\s*\?\?\s*pending\.key/);
    // No secondary close button remains, and no stale "footer" wording.
    expect(src).not.toMatch(/canCloseSecondary/);
    expect(src).not.toMatch(/toolbar\/footer|a footer with ONE/i);
  });
});
