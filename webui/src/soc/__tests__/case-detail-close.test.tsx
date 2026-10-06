/**
 * Regression test for BUG-3 — duplicate close (X) control in the case-detail Sheet.
 *
 * shadcn `SheetContent` ALWAYS renders its own built-in close X (accessible name
 * "Close", at right-4 top-4). CaseDetail previously ALSO hand-rolled a second
 * "Close" X in its header icon row, so two identical panel-dismiss controls
 * stacked in the top-right.
 *
 * The labeled "Close case" lifecycle action in the footer is a SEPARATE, correct
 * control (it changes case state — it does not dismiss the panel).
 *
 * This test renders CaseDetail with a mocked open case (and stubs for the other
 * load-time api calls) and asserts there is EXACTLY ONE panel-dismiss control
 * (a button whose accessible name is exactly "Close") plus the labeled
 * "Close case" lifecycle action. Before the fix this found TWO "Close" buttons.
 */
import type * as React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const clipboardMocks = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/clipboard', () => ({ copyText: clipboardMocks.copyText }));

// Mock the typed api client BEFORE importing the component (which pulls it in).
vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  // A minimal OPEN case — an open-ish status yields a footer "Close case" action.
  const openCase = {
    case_id: 'case-001',
    case_number: 'TLSOC-001',
    title: 'Suspicious login burst',
    status: 'open',
    disposition: null,
    verdict: 'needs_human',
    confidence: 0.5,
    risk_score: 60,
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
      // load-time calls fired when the sheet opens
      getCase: ok(openCase),
      getPlaybooks: ok({ enabled: false, playbooks: [] }),
      getModels: ok({ providers: {} }),
      getSettings: ok({ prefs: {}, configured: {}, read_only: false }),
      // namespaced calls referenced by the module (only fired on tab change)
      cases: {
        threatContext: ok(null),
        runPlaybook: ok(openCase),
        notify: ok({ sent: [] }),
      },
    },
  };
});

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import { CaseDetail } from '../pages/CaseDetail';

function renderWithProviders(node: React.ReactNode) {
  return render(
    <AuthProvider>
      <RouterProvider>
        <TooltipProvider>{node}</TooltipProvider>
      </RouterProvider>
    </AuthProvider>,
  );
}

describe('CaseDetail — single panel-dismiss control (BUG-3)', () => {
  beforeEach(() => {
    clipboardMocks.copyText.mockClear();
  });

  it('renders exactly ONE "Close" dismiss button plus the separate "Close case" action', async () => {
    renderWithProviders(<CaseDetail caseId="case-001" onClose={vi.fn()} />);

    // Wait for the case to load (the title is unique to the loaded state).
    await waitFor(() => expect(screen.getByText('Suspicious login burst')).toBeInTheDocument(), {
      timeout: 5000,
    });

    // Exactly one panel-dismiss control: the built-in SheetContent close X, whose
    // accessible name is exactly "Close". The removed header X had the same name —
    // before the fix this matched TWO buttons.
    const dismiss = screen.getAllByRole('button', { name: /^close$/i });
    expect(dismiss).toHaveLength(1);

    // The labeled lifecycle "Close case" footer action is separate and present.
    expect(screen.getByRole('button', { name: /^close case/i })).toBeInTheDocument();
  });

  it('renders the same complete workflow inline without a Sheet overlay', async () => {
    const onCaseChange = vi.fn();
    renderWithProviders(
      <CaseDetail
        caseId="case-001"
        presentation="embedded"
        onClose={vi.fn()}
        onCaseChange={onCaseChange}
      />,
    );

    await waitFor(() => expect(screen.getByText('Suspicious login burst')).toBeInTheDocument(), {
      timeout: 5000,
    });

    expect(screen.getByRole('region', { name: 'Case detail' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Case detail' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
    for (const label of [
      'Overview',
      'Timeline',
      'Investigation',
      'Threat context',
      'Collaboration',
      'Chat',
    ]) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take Action' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to case queue' })).toBeInTheDocument();
    expect(screen.getByText('High severity')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Close case/i })).not.toBeInTheDocument();
    expect(onCaseChange).toHaveBeenCalledWith(expect.objectContaining({ case_id: 'case-001' }));
  });

  it('keeps actionable embedded controls in Take Action without repeating visible tabs', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CaseDetail caseId="case-001" presentation="embedded" onClose={vi.fn()} />,
    );

    await screen.findByText('Suspicious login burst');
    await user.click(screen.getByRole('button', { name: 'Take Action' }));

    const menu = await screen.findByRole('menu');
    for (const label of [
      'Escalate',
      'Close case',
      'Acknowledge & investigate',
      'Mark resolved',
      'Put on hold',
      'Reinvestigate',
      'Run a playbook',
      'Refresh case',
      'Ask about this case',
      'Open in new tab',
      'Export JSON',
      'Export Markdown report',
      'Notify',
    ]) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    expect(within(menu).queryByRole('menuitem', { name: 'Timeline' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Investigation' })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Reinvestigate' }));
    expect(
      await screen.findByRole('dialog', { name: 'Re-run the investigation' }),
    ).toBeInTheDocument();
  });

  it('leads the embedded header with the human title and a quiet, copyable case id', async () => {
    renderWithProviders(
      <CaseDetail caseId="case-001" presentation="embedded" onClose={vi.fn()} />,
    );

    // The human title is the heading, in the foreground (no longer a muted subtitle).
    const title = await screen.findByRole('heading', { level: 2, name: 'Suspicious login burst' });
    expect(title).toHaveClass('text-xl', 'font-semibold', 'text-foreground');
    expect(title).not.toHaveClass('text-muted-foreground');

    // The machine id is a secondary mono line AFTER the title: muted, small, untruncated.
    const id = screen.getByTestId('case-detail-id');
    expect(id).toHaveTextContent(/^TLSOC-001$/);
    expect(id).toHaveClass('font-mono', 'text-xs', 'text-muted-foreground', 'break-all');
    expect(id).not.toHaveClass('truncate');
    expect(id).not.toHaveClass('uppercase');
    expect(title.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Severity sits on that meta line in sentence case.
    const meta = screen.getByTestId('case-detail-meta');
    expect(within(meta).getByText('High severity')).not.toHaveClass('uppercase');

    // The copy control has an accessible name and copies exactly the display id.
    fireEvent.click(within(meta).getByRole('button', { name: 'Copy case ID' }));
    await waitFor(() => expect(clipboardMocks.copyText).toHaveBeenCalledWith('TLSOC-001'));
    expect(await within(meta).findByRole('button', { name: 'Case ID copied' })).toBeInTheDocument();
  });

  it('shares the canonical Case Manager deep link from the separate top-right control', async () => {
    renderWithProviders(
      <CaseDetail caseId="case-001" presentation="embedded" onClose={vi.fn()} />,
    );

    await screen.findByText('Suspicious login burst');
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(clipboardMocks.copyText).toHaveBeenCalledWith(
        expect.stringContaining('#/case_manager?caseId=case-001'),
      );
    });
  });
});
