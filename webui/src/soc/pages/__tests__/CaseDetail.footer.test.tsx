/**
 * CaseDetail — Wave-5 footer redesign (cleaner case view, #9 request).
 *
 * The old footer showed a row of ~7 equally-weighted lifecycle buttons (close /
 * confirm-FP / set-disposition / escalate / resolve / hold / acknowledge) which
 * analysts found confusing. The redesign collapses this to:
 *
 *   1. ONE clear, context-dependent PRIMARY CTA (Acknowledge when new, Escalate
 *      when working, Resume when held, Reopen when terminal, Close when resolved).
 *   2. ONE secondary "Close case" — the UNIFIED Close-with-disposition flow that
 *      merges the old close / confirm-FP / set-disposition into a single dialog
 *      (a disposition selector + optional resolution/tags/note). On submit it POSTs
 *      the EXISTING `close` verb + the chosen `disposition` (backend still runs the
 *      real decide()/apply() — #3), NOT a new verb.
 *   3. An overflow "More" menu for the remaining actions.
 *
 * We mix a live mount (for the DOM structure + the merged close dialog wire) with
 * a source assertion (for the never-invent-a-verb #3 guarantee).
 */
import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

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
// `close` wire mapping) now lives in `casedetail/shared.tsx`; the `runAction` POST
// (which posts `pending.wireAction ?? pending.key`) stays in the orchestrator
// `CaseDetail.tsx`. Read both so the never-invent-a-verb #3 guarantee is pinned.
const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');
const sharedSrc = readFileSync(
  path.resolve(__dirname, '..', 'casedetail', 'shared.tsx'),
  'utf8',
);

describe('CaseDetail footer — single CTA + unified Close-with-disposition', () => {
  beforeEach(() => {
    caseActionExec.mockReset();
  });

  it('shows exactly ONE primary CTA and a single "Close case" secondary (not a wall of buttons)', async () => {
    renderWithProviders(<CaseDetail caseId="case-77" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Beacon to known C2')).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Working-state primary CTA is Escalate (context-dependent, filled).
    expect(screen.getByRole('button', { name: /Escalate/i })).toBeInTheDocument();

    // Exactly one unified "Close case" secondary control.
    const closes = screen.getAllByRole('button', { name: /^close case/i });
    expect(closes).toHaveLength(1);

    // Round 12: the header's "Take action" menu holds every other action (with shortcut
    // hints) instead of separate footer buttons.
    expect(screen.getByRole('button', { name: /^Take action/i })).toBeInTheDocument();

    // The confusing standalone "Confirm false positive" / "Set disposition" footer
    // buttons are gone (they live inside the merged close dialog now).
    expect(screen.queryByRole('button', { name: /Confirm false positive/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Set disposition/i })).toBeNull();

    // Panel-dismiss invariant preserved: only the SheetContent X is named "Close".
    expect(screen.getAllByRole('button', { name: /^close$/i })).toHaveLength(1);
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

    // Open the unified close dialog from the footer secondary button.
    fireEvent.click(screen.getByRole('button', { name: /^close case/i }));
    const dialog = await screen.findByRole('dialog');

    // The submit button is disabled until a disposition is chosen (mandatory).
    const submit = within(dialog).getByRole('button', { name: /^close case/i });
    expect(submit).toBeDisabled();

    // Pick a disposition (Round 12: a radio-card picker with definitions), then submit.
    fireEvent.click(within(dialog).getByRole('radio', { name: /False positive/i }));
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(caseActionExec).toHaveBeenCalledTimes(1));
    const [, input] = caseActionExec.mock.calls[0];
    // EXISTING verb (never a new one) + the chosen disposition — #3: the backend
    // close still runs decide()/apply().
    expect(input.action).toBe('close');
    expect(input.disposition).toBe('false_positive');
  });

  it('never invents a new action verb — close_disposition maps to the wire `close`', () => {
    // The UI-only unified kind carries wireAction: 'close' (in the shared action
    // model), and runAction (in the orchestrator) posts `pending.wireAction ??
    // pending.key`.
    expect(sharedSrc).toMatch(/close_disposition:\s*\{[\s\S]*?wireAction:\s*'close'/);
    expect(src).toMatch(/action:\s*pending\.wireAction\s*\?\?\s*pending\.key/);
  });
});
